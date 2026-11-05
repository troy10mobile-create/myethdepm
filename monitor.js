require('dotenv').config();
const { JsonRpcProvider, Wallet, formatEther, getAddress, parseEther } = require('ethers');
const db = require('./db');
const { deriveWallet } = require('./wallet');

const provider = new JsonRpcProvider(process.env.RPC_URL);
const anonymousCentral = new Wallet(process.env.ANONYMOUS_CENTRAL_PRIVATE_KEY, provider);
const feeRecipient = process.env.FEE_RECIPIENT_ADDRESS
  ? getAddress(process.env.FEE_RECIPIENT_ADDRESS)
  : null;

const confirmations = Number(process.env.CONFIRMATIONS || 3);
const pollMs = Number(process.env.POLL_INTERVAL_MS || 12000);
const MAX_SEND_ATTEMPTS = 3;
let busy = false;

function feeOverrides(feeData) {
  if (feeData.maxFeePerGas != null) {
    const maxFeePerGas = feeData.maxFeePerGas;
    let maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? 0n;
    if (maxPriorityFeePerGas > maxFeePerGas) maxPriorityFeePerGas = maxFeePerGas;
    return { maxFeePerGas, maxPriorityFeePerGas, feeCapPerGas: maxFeePerGas };
  }
  if (feeData.gasPrice != null) {
    return { gasPrice: feeData.gasPrice, feeCapPerGas: feeData.gasPrice };
  }
  throw new Error('RPC did not provide usable gas fee data.');
}

function bufferedGas(estimate) {
  // 50% headroom for safety (was 20% before; we saw edge cases)
  return (estimate * 150n + 99n) / 100n;
}

async function estimateSweep(depositWallet, balance, feeCapPerGas) {
  let gasLimit = bufferedGas(await depositWallet.estimateGas({
    to: anonymousCentral.address,
    value: balance / 2n
  }));

  for (let i = 0; i < 4; i++) {
    const feeReserve = gasLimit * feeCapPerGas;
    if (balance <= feeReserve) {
      throw new Error('Deposit balance cannot cover the estimated sweep gas reserve.');
    }
    const value = balance - feeReserve;
    const actualEstimate = await depositWallet.estimateGas({
      to: anonymousCentral.address,
      value
    });
    if (actualEstimate <= gasLimit) return { gasLimit, value };
    gasLimit = bufferedGas(actualEstimate);
  }
  throw new Error('Sweep gas estimate did not stabilise; no transaction was sent.');
}

async function sendSweep(depositWallet, row) {
  const balance = await provider.getBalance(depositWallet.address);
  if (balance <= 0n) {
    throw new Error(`Deposit address ${depositWallet.address} has no ETH balance to sweep.`);
  }
  const fee = feeOverrides(await provider.getFeeData());
  const { gasLimit, value } = await estimateSweep(depositWallet, balance, fee.feeCapPerGas);

  const tx = await depositWallet.sendTransaction({
    to: anonymousCentral.address,
    value,
    gasLimit,
    ...(fee.maxFeePerGas != null
      ? { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas }
      : { gasPrice: fee.gasPrice })
  });

  db.prepare(`
    UPDATE deposit_requests
    SET sweep_tx_hash = ?, sweep_attempts = COALESCE(sweep_attempts, 0) + 1,
        status = 'sweep_sent', last_error = NULL
    WHERE id = ?
  `).run(tx.hash, row.id);

  console.log(`Sweep submitted for ${row.id}: ${tx.hash}; gas limit ${gasLimit}; value ${formatEther(value)} ETH`);
}

async function sendWithdrawal(row) {
  const to = getAddress(row.withdrawal_address);
  const amount = BigInt(row.requested_wei);
  const fee = feeOverrides(await provider.getFeeData());
  const estimate = await anonymousCentral.estimateGas({ to, value: amount });
  const gasLimit = bufferedGas(estimate);
  const balance = await provider.getBalance(anonymousCentral.address);
  const required = amount + gasLimit * fee.feeCapPerGas;

  if (balance < required) {
    throw new Error(
      `Central wallet balance insufficient for withdrawal. Need ${formatEther(required)} ETH including gas; have ${formatEther(balance)} ETH.`
    );
  }

  const tx = await anonymousCentral.sendTransaction({
    to,
    value: amount,
    gasLimit,
    ...(fee.maxFeePerGas != null
      ? { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas }
      : { gasPrice: fee.gasPrice })
  });

  db.prepare(`
    UPDATE deposit_requests
    SET withdrawal_tx_hash = ?, withdrawal_attempts = COALESCE(withdrawal_attempts, 0) + 1,
        status = 'withdrawal_sent', last_error = NULL
    WHERE id = ?
  `).run(tx.hash, row.id);

  console.log(`Withdrawal submitted for ${row.id}: ${tx.hash} → ${to}; amount ${formatEther(amount)} ETH`);
}

/**
 * After successful withdrawal, forward 79% of (convenience + website fees)
 * to the configured FEE_RECIPIENT_ADDRESS.
 */
async function sendFeeForward(row) {
  if (!feeRecipient || feeRecipient === '0x0000000000000000000000000000000000000000') {
    console.log(`Fee recipient not configured – skipping 79% forward for ${row.id}`);
    db.prepare(`UPDATE deposit_requests SET status = 'completed' WHERE id = ?`).run(row.id);
    return;
  }

  const convenience = BigInt(row.convenience_fee_wei);
  const siteFee = BigInt(row.site_fee_wei);
  const totalFees = convenience + siteFee;
  const forwardAmount = (totalFees * 79n) / 100n;

  if (forwardAmount <= 0n) {
    console.log(`No fee amount to forward for ${row.id}`);
    db.prepare(`UPDATE deposit_requests SET status = 'completed' WHERE id = ?`).run(row.id);
    return;
  }

  const fee = feeOverrides(await provider.getFeeData());
  const estimate = await anonymousCentral.estimateGas({ to: feeRecipient, value: forwardAmount });
  const gasLimit = bufferedGas(estimate);
  const balance = await provider.getBalance(anonymousCentral.address);
  const required = forwardAmount + gasLimit * fee.feeCapPerGas;

  if (balance < required) {
    throw new Error(
      `Central wallet balance insufficient for 79% fee forward. Need ${formatEther(required)} ETH; have ${formatEther(balance)} ETH.`
    );
  }

  const tx = await anonymousCentral.sendTransaction({
    to: feeRecipient,
    value: forwardAmount,
    gasLimit,
    ...(fee.maxFeePerGas != null
      ? { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas }
      : { gasPrice: fee.gasPrice })
  });

  db.prepare(`
    UPDATE deposit_requests
    SET fee_forward_tx_hash = ?, fee_forward_attempts = COALESCE(fee_forward_attempts, 0) + 1,
        status = 'fee_forward_sent', last_error = NULL
    WHERE id = ?
  `).run(tx.hash, row.id);

  console.log(`79% fee forward submitted for ${row.id}: ${tx.hash} → ${feeRecipient}; amount ${formatEther(forwardAmount)} ETH`);
}

async function processDeposits() {
  if (busy) return;
  busy = true;
  try {
    const network = await provider.getNetwork();
    if (network.chainId !== 11155111n) {
      throw new Error('Safety stop: monitor only runs on Sepolia (chain ID 11155111).');
    }

    const latest = await provider.getBlockNumber();
    const safeBlock = latest - confirmations + 1;
    if (safeBlock < 0) return;

    const state = db.prepare("SELECT value FROM app_state WHERE key = 'last_scanned_block'").get();
    let fromBlock = state ? Number(state.value) + 1 : Math.max(0, safeBlock - 80);
    const toBlock = Math.min(safeBlock, fromBlock + 19);

    const pending = db.prepare(`
      SELECT * FROM deposit_requests
      WHERE status IN ('awaiting_payment', 'partially_paid')
    `).all();
    const byAddress = new Map(pending.map(r => [r.deposit_address.toLowerCase(), r]));

    for (let b = fromBlock; b <= toBlock; b++) {
      const block = await provider.getBlock(b, true);
      if (block && block.prefetchedTransactions) {
        for (const tx of block.prefetchedTransactions) {
          if (!tx.to || tx.value <= 0n) continue;
          const row = byAddress.get(tx.to.toLowerCase());
          if (!row) continue;

          const receipt = await provider.getTransactionReceipt(tx.hash);
          if (!receipt || receipt.status !== 1) continue;

          const sender = getAddress(tx.from);
          if (row.sender_address && row.sender_address.toLowerCase() !== sender.toLowerCase()) {
            console.warn(`Ignoring payment from a second sender for request ${row.id}: ${sender}`);
            continue;
          }

          const inserted = db.prepare(`
            INSERT OR IGNORE INTO seen_transactions (tx_hash, deposit_id, amount_wei, sender_address, block_number)
            VALUES (?, ?, ?, ?, ?)
          `).run(tx.hash, row.id, tx.value.toString(), sender, b);

          if (inserted.changes) {
            const received = BigInt(row.received_wei) + tx.value;
            const status = received >= BigInt(row.expected_total_wei) ? 'payment_confirmed' : 'partially_paid';
            db.prepare(`
              UPDATE deposit_requests
              SET received_wei = ?, sender_address = ?, status = ?
              WHERE id = ?
            `).run(received.toString(), sender, status, row.id);

            row.received_wei = received.toString();
            row.sender_address = sender;
            row.status = status;
            console.log(`Received ${formatEther(tx.value)} Sepolia ETH for ${row.id} from ${sender}`);
          }
        }
      }
      db.prepare(`
        INSERT INTO app_state (key, value) VALUES ('last_scanned_block', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(b));
    }

    // Process ready deposits through the state machine
    const ready = db.prepare(`
      SELECT * FROM deposit_requests
      WHERE status IN (
        'payment_confirmed', 'sweeping', 'sweep_sent', 'sweep_confirmed',
        'withdrawal_sent', 'fee_forward_sent'
      )
    `).all();

    for (const row of ready) {
      await advanceDeposit(row);
    }
  } catch (e) {
    console.error('Monitor error:', e.stack || e.message);
  } finally {
    busy = false;
  }
}

async function advanceDeposit(row) {
  try {
    let current = db.prepare('SELECT * FROM deposit_requests WHERE id = ?').get(row.id);

    // Recover interrupted "sweeping" state
    if (current.status === 'sweeping' && !current.sweep_tx_hash) {
      db.prepare(`
        UPDATE deposit_requests
        SET status = 'payment_confirmed', last_error = 'Recovered an interrupted sweep attempt.'
        WHERE id = ?
      `).run(row.id);
      current = db.prepare('SELECT * FROM deposit_requests WHERE id = ?').get(row.id);
    }

    // 1. payment_confirmed → start sweep
    if (current.status === 'payment_confirmed') {
      const changed = db.prepare(`
        UPDATE deposit_requests SET status = 'sweeping'
        WHERE id = ? AND status = 'payment_confirmed'
      `).run(row.id);
      if (!changed.changes) return;

      const depositWallet = deriveWallet(
        process.env.ANONYMOUS_DEPOSIT_MNEMONIC,
        current.derivation_index
      ).connect(provider);

      await sendSweep(depositWallet, row);
      current = db.prepare('SELECT * FROM deposit_requests WHERE id = ?').get(row.id);
    }

    // 2. sweep_sent → wait for confirmation
    if (current.status === 'sweep_sent') {
      const receipt = await provider.getTransactionReceipt(current.sweep_tx_hash);
      if (!receipt) return;

      if (receipt.status !== 1) {
        const attempts = Number(current.sweep_attempts || 1);
        const reason = `Sweep ${current.sweep_tx_hash} failed on-chain.`;
        if (attempts < MAX_SEND_ATTEMPTS) {
          db.prepare(`
            UPDATE deposit_requests
            SET status = 'payment_confirmed', sweep_tx_hash = NULL, last_error = ?
            WHERE id = ?
          `).run(reason, row.id);
          console.error(`${reason} Will retry (attempt ${attempts + 1}/${MAX_SEND_ATTEMPTS}).`);
        } else {
          db.prepare(`
            UPDATE deposit_requests SET status = 'needs_attention', last_error = ?
            WHERE id = ?
          `).run(`${reason} Retry limit reached.`, row.id);
          console.error(`${reason} Retry limit reached.`);
        }
        return;
      }

      if ((await provider.getBlockNumber()) - receipt.blockNumber + 1 < confirmations) return;

      const actualSweepFee = receipt.gasUsed * (receipt.gasPrice || 0n);
      db.prepare(`
        UPDATE deposit_requests
        SET status = 'sweep_confirmed', sweep_fee_wei = ?, last_error = NULL
        WHERE id = ?
      `).run(actualSweepFee.toString(), row.id);
      current = db.prepare('SELECT * FROM deposit_requests WHERE id = ?').get(row.id);
      console.log(`Sweep confirmed for ${row.id}. Actual fee: ${formatEther(actualSweepFee)} ETH`);
    }

    // 3. sweep_confirmed → send withdrawal to user-specified address
    if (current.status === 'sweep_confirmed') {
      await sendWithdrawal(current);
      current = db.prepare('SELECT * FROM deposit_requests WHERE id = ?').get(row.id);
    }

    // 4. withdrawal_sent → wait for confirmation
    if (current.status === 'withdrawal_sent') {
      const receipt = await provider.getTransactionReceipt(current.withdrawal_tx_hash);
      if (!receipt) return;

      if (receipt.status !== 1) {
        const attempts = Number(current.withdrawal_attempts || 1);
        const reason = `Withdrawal ${current.withdrawal_tx_hash} failed on-chain.`;
        if (attempts < MAX_SEND_ATTEMPTS) {
          db.prepare(`
            UPDATE deposit_requests
            SET status = 'sweep_confirmed', withdrawal_tx_hash = NULL, last_error = ?
            WHERE id = ?
          `).run(reason, row.id);
          console.error(`${reason} Will retry (attempt ${attempts + 1}/${MAX_SEND_ATTEMPTS}).`);
        } else {
          db.prepare(`
            UPDATE deposit_requests SET status = 'needs_attention', last_error = ?
            WHERE id = ?
          `).run(`${reason} Retry limit reached.`, row.id);
          console.error(`${reason} Retry limit reached.`);
        }
        return;
      }

      if ((await provider.getBlockNumber()) - receipt.blockNumber + 1 < confirmations) return;

      const actualWithdrawalFee = receipt.gasUsed * (receipt.gasPrice || 0n);
      db.prepare(`
        UPDATE deposit_requests
        SET status = 'withdrawal_confirmed', withdrawal_fee_wei = ?, last_error = NULL
        WHERE id = ?
      `).run(actualWithdrawalFee.toString(), row.id);
      current = db.prepare('SELECT * FROM deposit_requests WHERE id = ?').get(row.id);
      console.log(`Withdrawal confirmed for ${row.id}. Actual fee: ${formatEther(actualWithdrawalFee)} ETH`);
    }

    // 5. withdrawal_confirmed → forward 79% of fees
    if (current.status === 'withdrawal_confirmed') {
      // Record ledger entries (idempotent)
      db.transaction(() => {
        const already = db.prepare(`
          SELECT COUNT(*) AS n FROM ledger
          WHERE deposit_id = ? AND entry_type = 'customer_credit'
        `).get(row.id).n;

        if (!already) {
          const requested = BigInt(current.requested_wei);
          const convenience = BigInt(current.convenience_fee_wei);
          const siteFee = BigInt(current.site_fee_wei);

          db.prepare(`
            INSERT INTO ledger (user_id, deposit_id, entry_type, asset, amount_wei, note)
            VALUES (?, ?, 'customer_credit', 'ETH', ?, ?)
          `).run(current.user_id, row.id, requested.toString(), 'Requested amount credited after successful withdrawal');

          db.prepare(`
            INSERT INTO ledger (user_id, deposit_id, entry_type, asset, amount_wei, note)
            VALUES (?, ?, 'convenience_fee', 'ETH', ?, ?)
          `).run(current.user_id, row.id, convenience.toString(), 'Convenience fee recorded');

          db.prepare(`
            INSERT INTO ledger (user_id, deposit_id, entry_type, asset, amount_wei, note)
            VALUES (?, ?, 'website_fee', 'ETH', ?, ?)
          `).run(current.user_id, row.id, siteFee.toString(), 'Website fee recorded');

          // If user is logged in, also update their internal balance
          if (current.user_id) {
            db.prepare(`
              INSERT INTO balances (user_id, asset, available_wei, reserved_wei)
              VALUES (?, 'ETH', ?, '0')
              ON CONFLICT(user_id, asset) DO UPDATE
              SET available_wei = CAST(available_wei AS INTEGER) + CAST(excluded.available_wei AS INTEGER)
            `).run(current.user_id, requested.toString());
          }
        }
      })();

      await sendFeeForward(current);
      current = db.prepare('SELECT * FROM deposit_requests WHERE id = ?').get(row.id);
    }

    // 6. fee_forward_sent → wait for confirmation → completed
    if (current.status === 'fee_forward_sent') {
      const receipt = await provider.getTransactionReceipt(current.fee_forward_tx_hash);
      if (!receipt) return;

      if (receipt.status !== 1) {
        const attempts = Number(current.fee_forward_attempts || 1);
        const reason = `Fee-forward ${current.fee_forward_tx_hash} failed on-chain.`;
        if (attempts < MAX_SEND_ATTEMPTS) {
          db.prepare(`
            UPDATE deposit_requests
            SET status = 'withdrawal_confirmed', fee_forward_tx_hash = NULL, last_error = ?
            WHERE id = ?
          `).run(reason, row.id);
          console.error(`${reason} Will retry (attempt ${attempts + 1}/${MAX_SEND_ATTEMPTS}).`);
        } else {
          // Even if fee forward fails, mark completed so the user is not blocked
          db.prepare(`
            UPDATE deposit_requests
            SET status = 'completed', last_error = ?
            WHERE id = ?
          `).run(`${reason} Retry limit reached – marked completed anyway.`, row.id);
          console.error(`${reason} Retry limit reached – marking completed.`);
        }
        return;
      }

      if ((await provider.getBlockNumber()) - receipt.blockNumber + 1 < confirmations) return;

      const actualFee = receipt.gasUsed * (receipt.gasPrice || 0n);
      db.prepare(`
        UPDATE deposit_requests
        SET status = 'completed', fee_forward_fee_wei = ?, last_error = NULL
        WHERE id = ?
      `).run(actualFee.toString(), row.id);

      console.log(`FULL FLOW COMPLETE for ${row.id}. Withdrawal + 79% fee forward succeeded.`);
    }
  } catch (e) {
    const message = e.message || String(e);
    db.prepare(`
      UPDATE deposit_requests SET status = 'needs_attention', last_error = ?
      WHERE id = ?
    `).run(message, row.id);
    console.error(`Deposit ${row.id} needs attention:`, e.stack || message);
  }
}

console.log(`V2 Monitor active.`);
console.log(`Anonymous central wallet: ${anonymousCentral.address}`);
console.log(`Fee recipient: ${feeRecipient || '(not set)'}`);
console.log(`Auto 79% fee forward: ${feeRecipient ? 'ON' : 'OFF'}`);

setInterval(processDeposits, pollMs);
processDeposits().catch(e => console.error('Initial monitor run failed:', e));

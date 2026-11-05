require('dotenv').config();
const { JsonRpcProvider, Wallet, formatEther, getAddress } = require('ethers');
const crypto = require('crypto');
const db = require('./db');
const { deriveWallet } = require('./wallet');

const provider = new JsonRpcProvider(process.env.RPC_URL);
const anonymousCentral = new Wallet(process.env.ANONYMOUS_CENTRAL_PRIVATE_KEY, provider);
const registeredCentral = process.env.REGISTERED_CENTRAL_PRIVATE_KEY
  ? new Wallet(process.env.REGISTERED_CENTRAL_PRIVATE_KEY, provider)
  : anonymousCentral; // fallback if not set

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
  return (estimate * 150n + 99n) / 100n;
}

async function estimateAndSendSweep(fromWallet, toAddress, label) {
  const balance = await provider.getBalance(fromWallet.address);
  if (balance <= 0n) throw new Error(`${label}: no balance to sweep`);

  const fee = feeOverrides(await provider.getFeeData());
  let gasLimit = bufferedGas(await fromWallet.estimateGas({ to: toAddress, value: balance / 2n }));

  for (let i = 0; i < 4; i++) {
    const feeReserve = gasLimit * fee.feeCapPerGas;
    if (balance <= feeReserve) throw new Error(`${label}: balance cannot cover gas`);
    const value = balance - feeReserve;
    const actual = await fromWallet.estimateGas({ to: toAddress, value });
    if (actual <= gasLimit) {
      const tx = await fromWallet.sendTransaction({
        to: toAddress,
        value,
        gasLimit,
        ...(fee.maxFeePerGas != null
          ? { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas }
          : { gasPrice: fee.gasPrice })
      });
      return { tx, value, gasLimit };
    }
    gasLimit = bufferedGas(actual);
  }
  throw new Error(`${label}: gas estimate did not stabilise`);
}

// ---------- Permanent address processing ----------

function loadPermanentAddressMap() {
  const users = db.prepare('SELECT id, permanent_address, permanent_derivation_index FROM users').all();
  const map = new Map();
  for (const u of users) {
    map.set(u.permanent_address.toLowerCase(), u);
  }
  return map;
}

async function processPermanentIncoming(fromBlock, toBlock, permanentMap) {
  for (let b = fromBlock; b <= toBlock; b++) {
    const block = await provider.getBlock(b, true);
    if (!block || !block.prefetchedTransactions) continue;

    for (const tx of block.prefetchedTransactions) {
      if (!tx.to || tx.value <= 0n) continue;
      const user = permanentMap.get(tx.to.toLowerCase());
      if (!user) continue;

      const receipt = await provider.getTransactionReceipt(tx.hash);
      if (!receipt || receipt.status !== 1) continue;

      const existing = db.prepare('SELECT id FROM permanent_incoming WHERE tx_hash = ?').get(tx.hash);
      if (existing) continue;

      const id = crypto.randomUUID();
      const sender = getAddress(tx.from);
      db.prepare(`
        INSERT INTO permanent_incoming (id, user_id, permanent_address, tx_hash, amount_wei, sender_address, status)
        VALUES (?, ?, ?, ?, ?, ?, 'detected')
      `).run(id, user.id, user.permanent_address, tx.hash, tx.value.toString(), sender);

      console.log(`Permanent deposit detected for user ${user.id}: ${formatEther(tx.value)} ETH from ${sender} (tx ${tx.hash})`);
    }
  }
}

async function advancePermanentDeposits(permanentMap) {
  const rows = db.prepare(`
    SELECT * FROM permanent_incoming
    WHERE status IN ('detected', 'sweeping', 'sweep_sent')
  `).all();

  for (const row of rows) {
    try {
      let current = db.prepare('SELECT * FROM permanent_incoming WHERE id = ?').get(row.id);
      const user = permanentMap.get(current.permanent_address.toLowerCase())
        || db.prepare('SELECT id, permanent_address, permanent_derivation_index FROM users WHERE id = ?').get(current.user_id);
      if (!user) continue;

      // detected → start sweep
      if (current.status === 'detected') {
        const changed = db.prepare(`
          UPDATE permanent_incoming SET status = 'sweeping' WHERE id = ? AND status = 'detected'
        `).run(row.id);
        if (!changed.changes) continue;

        const depositWallet = deriveWallet(
          process.env.REGISTERED_DEPOSIT_MNEMONIC,
          user.permanent_derivation_index
        ).connect(provider);

        const { tx, value, gasLimit } = await estimateAndSendSweep(
          depositWallet,
          registeredCentral.address,
          `permanent ${row.id}`
        );

        db.prepare(`
          UPDATE permanent_incoming
          SET sweep_tx_hash = ?, sweep_attempts = COALESCE(sweep_attempts,0)+1,
              status = 'sweep_sent', last_error = NULL
          WHERE id = ?
        `).run(tx.hash, row.id);

        console.log(`Permanent sweep submitted for ${row.id}: ${tx.hash}; value ${formatEther(value)} ETH; gasLimit ${gasLimit}`);
        current = db.prepare('SELECT * FROM permanent_incoming WHERE id = ?').get(row.id);
      }

      // sweep_sent → confirm → credit balance
      if (current.status === 'sweep_sent') {
        const receipt = await provider.getTransactionReceipt(current.sweep_tx_hash);
        if (!receipt) continue;

        if (receipt.status !== 1) {
          const attempts = Number(current.sweep_attempts || 1);
          if (attempts < MAX_SEND_ATTEMPTS) {
            db.prepare(`
              UPDATE permanent_incoming SET status = 'detected', sweep_tx_hash = NULL,
              last_error = ? WHERE id = ?
            `).run(`Sweep failed, will retry`, row.id);
          } else {
            db.prepare(`
              UPDATE permanent_incoming SET status = 'needs_attention', last_error = ? WHERE id = ?
            `).run(`Sweep failed after ${attempts} attempts`, row.id);
          }
          continue;
        }

        if ((await provider.getBlockNumber()) - receipt.blockNumber + 1 < confirmations) continue;

        // Credit the original received amount to the user's balance
        const amount = BigInt(current.amount_wei);
        db.transaction(() => {
          db.prepare(`
            INSERT INTO balances (user_id, asset, available_wei, reserved_wei)
            VALUES (?, 'ETH', ?, '0')
            ON CONFLICT(user_id, asset) DO UPDATE
            SET available_wei = CAST(available_wei AS INTEGER) + CAST(excluded.available_wei AS INTEGER)
          `).run(current.user_id, amount.toString());

          db.prepare(`
            INSERT INTO ledger (user_id, deposit_id, entry_type, asset, amount_wei, note)
            VALUES (?, NULL, 'permanent_deposit_credit', 'ETH', ?, ?)
          `).run(current.user_id, amount.toString(), `Permanent address deposit · tx ${current.tx_hash}`);

          db.prepare(`
            UPDATE permanent_incoming SET status = 'credited', last_error = NULL WHERE id = ?
          `).run(row.id);
        })();

        console.log(`Permanent deposit credited for user ${current.user_id}: +${formatEther(amount)} ETH`);
      }
    } catch (e) {
      console.error(`Permanent deposit ${row.id} error:`, e.message);
      db.prepare(`UPDATE permanent_incoming SET last_error = ? WHERE id = ?`).run(e.message, row.id);
    }
  }
}

// ---------- Anonymous temporary deposit processing (existing logic, cleaned) ----------

async function sendAnonymousSweep(depositWallet, row) {
  const { tx, value, gasLimit } = await estimateAndSendSweep(
    depositWallet,
    anonymousCentral.address,
    `anon ${row.id}`
  );
  db.prepare(`
    UPDATE deposit_requests
    SET sweep_tx_hash = ?, sweep_attempts = COALESCE(sweep_attempts,0)+1,
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
    throw new Error(`Central insufficient for withdrawal. Need ${formatEther(required)}, have ${formatEther(balance)}`);
  }
  const tx = await anonymousCentral.sendTransaction({
    to, value: amount, gasLimit,
    ...(fee.maxFeePerGas != null
      ? { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas }
      : { gasPrice: fee.gasPrice })
  });
  db.prepare(`
    UPDATE deposit_requests
    SET withdrawal_tx_hash = ?, withdrawal_attempts = COALESCE(withdrawal_attempts,0)+1,
        status = 'withdrawal_sent', last_error = NULL
    WHERE id = ?
  `).run(tx.hash, row.id);
  console.log(`Withdrawal submitted for ${row.id}: ${tx.hash} → ${to}; amount ${formatEther(amount)} ETH`);
}

async function sendFeeForward(row) {
  if (!feeRecipient || feeRecipient === '0x0000000000000000000000000000000000000000') {
    db.prepare(`UPDATE deposit_requests SET status = 'completed' WHERE id = ?`).run(row.id);
    return;
  }
  const totalFees = BigInt(row.convenience_fee_wei || '0') + BigInt(row.site_fee_wei || '0');
  const forwardAmount = (totalFees * 79n) / 100n;
  if (forwardAmount <= 0n) {
    db.prepare(`UPDATE deposit_requests SET status = 'completed' WHERE id = ?`).run(row.id);
    return;
  }
  const fee = feeOverrides(await provider.getFeeData());
  const estimate = await anonymousCentral.estimateGas({ to: feeRecipient, value: forwardAmount });
  const gasLimit = bufferedGas(estimate);
  const balance = await provider.getBalance(anonymousCentral.address);
  const required = forwardAmount + gasLimit * fee.feeCapPerGas;
  if (balance < required) throw new Error(`Central insufficient for fee forward`);

  const tx = await anonymousCentral.sendTransaction({
    to: feeRecipient, value: forwardAmount, gasLimit,
    ...(fee.maxFeePerGas != null
      ? { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas }
      : { gasPrice: fee.gasPrice })
  });
  db.prepare(`
    UPDATE deposit_requests
    SET fee_forward_tx_hash = ?, fee_forward_attempts = COALESCE(fee_forward_attempts,0)+1,
        status = 'fee_forward_sent', last_error = NULL
    WHERE id = ?
  `).run(tx.hash, row.id);
  console.log(`79% fee forward submitted for ${row.id}: ${tx.hash}; amount ${formatEther(forwardAmount)} ETH`);
}

async function advanceAnonymousDeposit(row) {
  try {
    let current = db.prepare('SELECT * FROM deposit_requests WHERE id = ?').get(row.id);

    if (current.status === 'sweeping' && !current.sweep_tx_hash) {
      db.prepare(`UPDATE deposit_requests SET status = 'payment_confirmed', last_error = 'Recovered interrupted sweep' WHERE id = ?`).run(row.id);
      current = db.prepare('SELECT * FROM deposit_requests WHERE id = ?').get(row.id);
    }

    if (current.status === 'payment_confirmed') {
      const changed = db.prepare(`UPDATE deposit_requests SET status = 'sweeping' WHERE id = ? AND status = 'payment_confirmed'`).run(row.id);
      if (!changed.changes) return;
      const depositWallet = deriveWallet(process.env.ANONYMOUS_DEPOSIT_MNEMONIC, current.derivation_index).connect(provider);
      await sendAnonymousSweep(depositWallet, row);
      current = db.prepare('SELECT * FROM deposit_requests WHERE id = ?').get(row.id);
    }

    if (current.status === 'sweep_sent') {
      const receipt = await provider.getTransactionReceipt(current.sweep_tx_hash);
      if (!receipt) return;
      if (receipt.status !== 1) {
        const attempts = Number(current.sweep_attempts || 1);
        if (attempts < MAX_SEND_ATTEMPTS) {
          db.prepare(`UPDATE deposit_requests SET status = 'payment_confirmed', sweep_tx_hash = NULL, last_error = ? WHERE id = ?`)
            .run(`Sweep failed, retrying`, row.id);
        } else {
          db.prepare(`UPDATE deposit_requests SET status = 'needs_attention', last_error = ? WHERE id = ?`)
            .run(`Sweep failed after retries`, row.id);
        }
        return;
      }
      if ((await provider.getBlockNumber()) - receipt.blockNumber + 1 < confirmations) return;
      const actualFee = receipt.gasUsed * (receipt.gasPrice || 0n);
      db.prepare(`UPDATE deposit_requests SET status = 'sweep_confirmed', sweep_fee_wei = ?, last_error = NULL WHERE id = ?`)
        .run(actualFee.toString(), row.id);
      current = db.prepare('SELECT * FROM deposit_requests WHERE id = ?').get(row.id);
      console.log(`Sweep confirmed for ${row.id}`);
    }

    if (current.status === 'sweep_confirmed') {
      await sendWithdrawal(current);
      current = db.prepare('SELECT * FROM deposit_requests WHERE id = ?').get(row.id);
    }

    if (current.status === 'withdrawal_sent') {
      const receipt = await provider.getTransactionReceipt(current.withdrawal_tx_hash);
      if (!receipt) return;
      if (receipt.status !== 1) {
        const attempts = Number(current.withdrawal_attempts || 1);
        if (attempts < MAX_SEND_ATTEMPTS) {
          db.prepare(`UPDATE deposit_requests SET status = 'sweep_confirmed', withdrawal_tx_hash = NULL, last_error = ? WHERE id = ?`)
            .run(`Withdrawal failed, retrying`, row.id);
        } else {
          db.prepare(`UPDATE deposit_requests SET status = 'needs_attention', last_error = ? WHERE id = ?`)
            .run(`Withdrawal failed after retries`, row.id);
        }
        return;
      }
      if ((await provider.getBlockNumber()) - receipt.blockNumber + 1 < confirmations) return;
      const actualFee = receipt.gasUsed * (receipt.gasPrice || 0n);
      db.prepare(`UPDATE deposit_requests SET status = 'withdrawal_confirmed', withdrawal_fee_wei = ?, last_error = NULL WHERE id = ?`)
        .run(actualFee.toString(), row.id);
      current = db.prepare('SELECT * FROM deposit_requests WHERE id = ?').get(row.id);
      console.log(`Withdrawal confirmed for ${row.id}`);
    }

    if (current.status === 'withdrawal_confirmed') {
      db.transaction(() => {
        const already = db.prepare(`SELECT COUNT(*) AS n FROM ledger WHERE deposit_id = ? AND entry_type = 'customer_credit'`).get(row.id).n;
        if (!already) {
          const requested = BigInt(current.requested_wei);
          db.prepare(`INSERT INTO ledger (user_id, deposit_id, entry_type, asset, amount_wei, note) VALUES (?, ?, 'customer_credit', 'ETH', ?, ?)`)
            .run(current.user_id, row.id, requested.toString(), 'Requested amount after successful withdrawal');
          db.prepare(`INSERT INTO ledger (user_id, deposit_id, entry_type, asset, amount_wei, note) VALUES (?, ?, 'convenience_fee', 'ETH', ?, ?)`)
            .run(current.user_id, row.id, current.convenience_fee_wei, 'Convenience fee');
          db.prepare(`INSERT INTO ledger (user_id, deposit_id, entry_type, asset, amount_wei, note) VALUES (?, ?, 'website_fee', 'ETH', ?, ?)`)
            .run(current.user_id, row.id, current.site_fee_wei, 'Website fee');

          // If user was logged in, also credit their internal balance
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

    if (current.status === 'fee_forward_sent') {
      const receipt = await provider.getTransactionReceipt(current.fee_forward_tx_hash);
      if (!receipt) return;
      if (receipt.status !== 1) {
        const attempts = Number(current.fee_forward_attempts || 1);
        if (attempts < MAX_SEND_ATTEMPTS) {
          db.prepare(`UPDATE deposit_requests SET status = 'withdrawal_confirmed', fee_forward_tx_hash = NULL, last_error = ? WHERE id = ?`)
            .run(`Fee forward failed, retrying`, row.id);
        } else {
          db.prepare(`UPDATE deposit_requests SET status = 'completed', last_error = ? WHERE id = ?`)
            .run(`Fee forward failed – marked completed`, row.id);
        }
        return;
      }
      if ((await provider.getBlockNumber()) - receipt.blockNumber + 1 < confirmations) return;
      db.prepare(`UPDATE deposit_requests SET status = 'completed', last_error = NULL WHERE id = ?`).run(row.id);
      console.log(`FULL FLOW COMPLETE for ${row.id}`);
    }
  } catch (e) {
    db.prepare(`UPDATE deposit_requests SET status = 'needs_attention', last_error = ? WHERE id = ?`).run(e.message, row.id);
    console.error(`Deposit ${row.id} needs attention:`, e.message);
  }
}

// ---------- Main loop ----------

async function processDeposits() {
  if (busy) return;
  busy = true;
  try {
    const network = await provider.getNetwork();
    if (network.chainId !== 11155111n) throw new Error('Safety stop: Sepolia only');

    const latest = await provider.getBlockNumber();
    const safeBlock = latest - confirmations + 1;
    if (safeBlock < 0) return;

    const state = db.prepare("SELECT value FROM app_state WHERE key = 'last_scanned_block'").get();
    let fromBlock = state ? Number(state.value) + 1 : Math.max(0, safeBlock - 80);
    const toBlock = Math.min(safeBlock, fromBlock + 19);

    const permanentMap = loadPermanentAddressMap();

    // 1. Scan blocks for both temporary and permanent addresses
    const pendingAnon = db.prepare(`
      SELECT * FROM deposit_requests WHERE status IN ('awaiting_payment', 'partially_paid')
    `).all();
    const anonByAddress = new Map(pendingAnon.map(r => [r.deposit_address.toLowerCase(), r]));

    for (let b = fromBlock; b <= toBlock; b++) {
      const block = await provider.getBlock(b, true);
      if (block && block.prefetchedTransactions) {
        for (const tx of block.prefetchedTransactions) {
          if (!tx.to || tx.value <= 0n) continue;

          // Anonymous temporary deposits
          const anonRow = anonByAddress.get(tx.to.toLowerCase());
          if (anonRow) {
            const receipt = await provider.getTransactionReceipt(tx.hash);
            if (receipt && receipt.status === 1) {
              const sender = getAddress(tx.from);
              if (anonRow.sender_address && anonRow.sender_address.toLowerCase() !== sender.toLowerCase()) continue;
              const inserted = db.prepare(`
                INSERT OR IGNORE INTO seen_transactions (tx_hash, deposit_id, amount_wei, sender_address, block_number)
                VALUES (?, ?, ?, ?, ?)
              `).run(tx.hash, anonRow.id, tx.value.toString(), sender, b);
              if (inserted.changes) {
                const received = BigInt(anonRow.received_wei) + tx.value;
                const status = received >= BigInt(anonRow.expected_total_wei) ? 'payment_confirmed' : 'partially_paid';
                db.prepare(`UPDATE deposit_requests SET received_wei = ?, sender_address = ?, status = ? WHERE id = ?`)
                  .run(received.toString(), sender, status, anonRow.id);
                anonRow.received_wei = received.toString();
                anonRow.sender_address = sender;
                anonRow.status = status;
                console.log(`Received ${formatEther(tx.value)} ETH for ${anonRow.id} from ${sender}`);
              }
            }
          }
        }
      }
      db.prepare(`
        INSERT INTO app_state (key, value) VALUES ('last_scanned_block', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(b));
    }

    // Permanent address deposits (separate scan pass using same blocks)
    await processPermanentIncoming(fromBlock, toBlock, permanentMap);

    // Advance permanent deposits
    await advancePermanentDeposits(permanentMap);

    // Advance anonymous deposits
    const readyAnon = db.prepare(`
      SELECT * FROM deposit_requests
      WHERE status IN (
        'payment_confirmed', 'sweeping', 'sweep_sent', 'sweep_confirmed',
        'withdrawal_sent', 'withdrawal_confirmed', 'fee_forward_sent'
      )
    `).all();
    for (const row of readyAnon) await advanceAnonymousDeposit(row);

  } catch (e) {
    console.error('Monitor error:', e.stack || e.message);
  } finally {
    busy = false;
  }
}

console.log(`V2.1 Monitor active.`);
console.log(`Anonymous central: ${anonymousCentral.address}`);
console.log(`Registered central: ${registeredCentral.address}`);
console.log(`Fee recipient: ${feeRecipient || '(not set)'}`);

setInterval(processDeposits, pollMs);
processDeposits().catch(e => console.error('Initial monitor run failed:', e));

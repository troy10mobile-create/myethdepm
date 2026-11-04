require('dotenv').config();
const { JsonRpcProvider, Wallet, formatEther, getAddress } = require('ethers');
const db = require('./db');
const { deriveDepositWallet } = require('./wallet');

const provider = new JsonRpcProvider(process.env.RPC_URL);
const central = new Wallet(process.env.CENTRAL_PRIVATE_KEY, provider);
const confirmations = Number(process.env.CONFIRMATIONS || 3);
const pollMs = Number(process.env.POLL_INTERVAL_MS || 12000);
const AUTO_WITHDRAW_TEST = process.env.AUTO_WITHDRAW_TEST === '1';
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
  // 20% headroom. For a normal ETH transfer this means a 25,200 limit,
  // while the network will still charge only the gas actually consumed.
  return (estimate * 120n + 99n) / 100n;
}

async function estimateSweep(depositWallet, balance, feeCapPerGas) {
  let gasLimit = bufferedGas(await depositWallet.estimateGas({
    to: central.address,
    value: balance / 2n
  }));

  // Re-estimate using the final value; this also handles recipient contracts
  // whose receive logic depends on msg.value.
  for (let i = 0; i < 3; i++) {
    const feeReserve = gasLimit * feeCapPerGas;
    if (balance <= feeReserve) throw new Error('Deposit balance cannot cover the estimated sweep gas reserve.');
    const value = balance - feeReserve;
    const actualEstimate = await depositWallet.estimateGas({ to: central.address, value });
    if (actualEstimate <= gasLimit) return { gasLimit, value };
    gasLimit = bufferedGas(actualEstimate);
  }
  throw new Error('Sweep gas estimate did not stabilise; no transaction was sent.');
}

async function sendSweep(depositWallet, row) {
  const balance = await provider.getBalance(depositWallet.address);
  if (balance <= 0n) throw new Error(`Deposit address ${depositWallet.address} has no ETH balance to sweep.`);
  const fee = feeOverrides(await provider.getFeeData());
  const { gasLimit, value } = await estimateSweep(depositWallet, balance, fee.feeCapPerGas);
  const tx = await depositWallet.sendTransaction({
    to: central.address,
    value,
    gasLimit,
    ...(fee.maxFeePerGas != null
      ? { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas }
      : { gasPrice: fee.gasPrice })
  });
  db.prepare("UPDATE deposit_requests SET sweep_tx_hash=?, sweep_attempts=COALESCE(sweep_attempts,0)+1, status='sweep_sent', last_error=NULL WHERE id=?").run(tx.hash, row.id);
  console.log(`Sweep submitted for ${row.id}: ${tx.hash}; gas limit ${gasLimit}; value ${formatEther(value)} ETH`);
}

async function sendTestWithdrawal(current, row) {
  if (!current.sender_address) throw new Error('Original sender address is missing; cannot perform test withdrawal.');
  const to = getAddress(current.sender_address);
  const amount = BigInt(current.requested_wei);
  const fee = feeOverrides(await provider.getFeeData());
  const estimate = await central.estimateGas({ to, value: amount });
  const gasLimit = bufferedGas(estimate);
  const balance = await provider.getBalance(central.address);
  const required = amount + gasLimit * fee.feeCapPerGas;
  if (balance < required) {
    throw new Error(`Central wallet balance is insufficient for test return. Need ${formatEther(required)} ETH including gas; have ${formatEther(balance)} ETH.`);
  }
  const tx = await central.sendTransaction({
    to,
    value: amount,
    gasLimit,
    ...(fee.maxFeePerGas != null
      ? { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas }
      : { gasPrice: fee.gasPrice })
  });
  db.prepare("UPDATE deposit_requests SET withdrawal_tx_hash=?, withdrawal_attempts=COALESCE(withdrawal_attempts,0)+1, status='withdrawal_sent', last_error=NULL WHERE id=?").run(tx.hash, row.id);
  console.log(`Test withdrawal submitted for ${row.id}: ${tx.hash}; gas limit ${gasLimit}`);
}

async function processDeposits() {
  if (busy) return;
  busy = true;
  try {
    const network = await provider.getNetwork();
    if (network.chainId !== 11155111n) throw new Error('Safety stop: monitor only runs on Sepolia (chain ID 11155111).');
    const latest = await provider.getBlockNumber();
    const safeBlock = latest - confirmations + 1;
    if (safeBlock < 0) return;
    const state = db.prepare("SELECT value FROM app_state WHERE key='last_scanned_block'").get();
    let fromBlock = state ? Number(state.value) + 1 : Math.max(0, safeBlock - 100);
    const toBlock = Math.min(safeBlock, fromBlock + 19);
    const pending = db.prepare("SELECT * FROM deposit_requests WHERE status IN ('awaiting_payment','partially_paid')").all();
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
          const inserted = db.prepare('INSERT OR IGNORE INTO seen_transactions(tx_hash,deposit_id,amount_wei,sender_address,block_number) VALUES(?,?,?,?,?)').run(tx.hash, row.id, tx.value.toString(), sender, b);
          if (inserted.changes) {
            const received = BigInt(row.received_wei) + tx.value;
            const status = received >= BigInt(row.expected_total_wei) ? 'payment_confirmed' : 'partially_paid';
            db.prepare('UPDATE deposit_requests SET received_wei=?, sender_address=?, status=? WHERE id=?').run(received.toString(), sender, status, row.id);
            row.received_wei = received.toString(); row.sender_address = sender; row.status = status;
            console.log(`Received ${formatEther(tx.value)} Sepolia ETH for ${row.id} from ${sender}`);
          }
        }
      }
      db.prepare("INSERT INTO app_state(key,value) VALUES('last_scanned_block',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(b));
    }

    const ready = db.prepare("SELECT * FROM deposit_requests WHERE status IN ('payment_confirmed','sweeping','sweep_sent','sweep_confirmed','withdrawal_sent')").all();
    for (const row of ready) await sweepAndTestWithdraw(row);
  } catch (e) {
    console.error('Monitor error:', e.stack || e.message);
  } finally {
    busy = false;
  }
}

async function sweepAndTestWithdraw(row) {
  try {
    let current = db.prepare('SELECT * FROM deposit_requests WHERE id=?').get(row.id);

    // Recover safely if the previous process stopped after setting "sweeping"
    // but before it saved a transaction hash.
    if (current.status === 'sweeping' && !current.sweep_tx_hash) {
      db.prepare("UPDATE deposit_requests SET status='payment_confirmed', last_error='Recovered an interrupted sweep attempt.' WHERE id=?").run(row.id);
      current = db.prepare('SELECT * FROM deposit_requests WHERE id=?').get(row.id);
    }

    if (current.status === 'payment_confirmed') {
      const changed = db.prepare("UPDATE deposit_requests SET status='sweeping' WHERE id=? AND status='payment_confirmed'").run(row.id);
      if (!changed.changes) return;
      const depositWallet = deriveDepositWallet(process.env.DEPOSIT_MNEMONIC, current.derivation_index).connect(provider);
      await sendSweep(depositWallet, row);
      current = db.prepare('SELECT * FROM deposit_requests WHERE id=?').get(row.id);
    }

    if (current.status === 'sweep_sent') {
      const receipt = await provider.getTransactionReceipt(current.sweep_tx_hash);
      if (!receipt) return;
      if (receipt.status !== 1) {
        const attempts = Number(current.sweep_attempts || 1);
        const reason = `Sweep transaction ${current.sweep_tx_hash} was mined with failure status (0).`;
        if (attempts < MAX_SEND_ATTEMPTS) {
          db.prepare("UPDATE deposit_requests SET status='payment_confirmed', sweep_tx_hash=NULL, last_error=? WHERE id=?").run(reason, row.id);
          console.error(`${reason} Will retry with a fresh gas estimate (attempt ${attempts + 1}/${MAX_SEND_ATTEMPTS}).`);
        } else {
          db.prepare("UPDATE deposit_requests SET status='needs_attention', last_error=? WHERE id=?").run(`${reason} Retry limit reached.`, row.id);
          console.error(`${reason} Retry limit reached.`);
        }
        return;
      }
      if ((await provider.getBlockNumber()) - receipt.blockNumber + 1 < confirmations) return;
      const actualSweepFee = receipt.gasUsed * (receipt.gasPrice || 0n);
      db.prepare("UPDATE deposit_requests SET status='sweep_confirmed', sweep_fee_wei=?, last_error=NULL WHERE id=?").run(actualSweepFee.toString(), row.id);
      current = db.prepare('SELECT * FROM deposit_requests WHERE id=?').get(row.id);
      console.log(`Sweep confirmed for ${row.id}. Actual fee: ${formatEther(actualSweepFee)} ETH`);
    }

    if (current.status === 'sweep_confirmed') {
      if (!AUTO_WITHDRAW_TEST) {
        db.prepare("UPDATE deposit_requests SET status='completed' WHERE id=?").run(row.id);
        console.log(`Deposit ${row.id} swept and credited. Automatic test withdrawal is disabled.`);
        return;
      }
      await sendTestWithdrawal(current, row);
      current = db.prepare('SELECT * FROM deposit_requests WHERE id=?').get(row.id);
    }

    if (current.status === 'withdrawal_sent') {
      const receipt = await provider.getTransactionReceipt(current.withdrawal_tx_hash);
      if (!receipt) return;
      if (receipt.status !== 1) {
        const attempts = Number(current.withdrawal_attempts || 1);
        const reason = `Test withdrawal ${current.withdrawal_tx_hash} was mined with failure status (0).`;
        if (attempts < MAX_SEND_ATTEMPTS) {
          db.prepare("UPDATE deposit_requests SET status='sweep_confirmed', withdrawal_tx_hash=NULL, last_error=? WHERE id=?").run(reason, row.id);
          console.error(`${reason} Will retry (attempt ${attempts + 1}/${MAX_SEND_ATTEMPTS}).`);
        } else {
          db.prepare("UPDATE deposit_requests SET status='needs_attention', last_error=? WHERE id=?").run(`${reason} Retry limit reached.`, row.id);
          console.error(`${reason} Retry limit reached.`);
        }
        return;
      }
      if ((await provider.getBlockNumber()) - receipt.blockNumber + 1 < confirmations) return;
      const actualWithdrawalFee = receipt.gasUsed * (receipt.gasPrice || 0n);
      const requested = BigInt(current.requested_wei);
      const convenience = BigInt(current.convenience_fee_wei);
      const siteFee = BigInt(current.site_fee_wei);
      db.transaction(() => {
        const already = db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE deposit_id=? AND entry_type='test_withdrawal_debit'").get(row.id).n;
        if (!already) {
          db.prepare("INSERT INTO ledger(user_id,deposit_id,entry_type,amount_wei,note) VALUES(?,?,?,?,?)").run(current.user_id, row.id, 'customer_credit', requested.toString(), 'Requested ETH amount credited to the test exchange balance after confirmed deposit sweep');
          db.prepare("INSERT INTO ledger(user_id,deposit_id,entry_type,amount_wei,note) VALUES(?,?,?,?,?)").run(current.user_id, row.id, 'convenience_fee', convenience.toString(), 'Convenience fee recorded');
          db.prepare("INSERT INTO ledger(user_id,deposit_id,entry_type,amount_wei,note) VALUES(?,?,?,?,?)").run(current.user_id, row.id, 'website_fee', siteFee.toString(), 'Website fee recorded');
          db.prepare("INSERT INTO ledger(user_id,deposit_id,entry_type,amount_wei,note) VALUES(?,?,?,?,?)").run(current.user_id, row.id, 'test_withdrawal_debit', requested.toString(), 'Test mode: requested ETH amount automatically sent back to original sending wallet');
        }
        db.prepare("UPDATE deposit_requests SET status='completed', withdrawal_fee_wei=?, last_error=NULL WHERE id=?").run(actualWithdrawalFee.toString(), row.id);
      })();
      console.log(`FULL TEST FLOW COMPLETE for ${row.id}. Returned ${formatEther(requested)} ETH to ${current.sender_address}. Withdrawal: ${current.withdrawal_tx_hash}; actual withdrawal fee: ${formatEther(actualWithdrawalFee)} ETH`);
    }
  } catch (e) {
    const message = e.message || String(e);
    db.prepare("UPDATE deposit_requests SET status='needs_attention', last_error=? WHERE id=?").run(message, row.id);
    console.error(`Deposit ${row.id} needs attention:`, e.stack || message);
  }
}

console.log(`Sepolia monitor active. Central wallet: ${central.address}. Auto-return test mode: ${AUTO_WITHDRAW_TEST ? 'ON' : 'OFF'}`);
provider.getCode(central.address).then(code => {
  console.log(`Central wallet account type: ${code === '0x' ? 'EOA (no contract code)' : 'contract account; gas will be estimated'}`);
}).catch(e => console.warn('Could not inspect central wallet code:', e.message));
processDeposits();
setInterval(processDeposits, pollMs);

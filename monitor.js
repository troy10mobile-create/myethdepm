require('dotenv').config();
const { JsonRpcProvider, Wallet, formatEther, getAddress } = require('ethers');
const db = require('./db');
const { deriveDepositWallet } = require('./wallet');
const provider = new JsonRpcProvider(process.env.RPC_URL);
const central = new Wallet(process.env.CENTRAL_PRIVATE_KEY, provider);
const confirmations = Number(process.env.CONFIRMATIONS || 3);
const pollMs = Number(process.env.POLL_INTERVAL_MS || 12000);
const AUTO_WITHDRAW_TEST = process.env.AUTO_WITHDRAW_TEST === '1';
let busy = false;

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
          // A single deposit request is tied to one sending wallet. This keeps the test refund destination unambiguous.
          if (row.sender_address && row.sender_address.toLowerCase() !== sender.toLowerCase()) {
            console.warn(`Ignoring payment from a second sender for request ${row.id}: ${sender}`);
            continue;
          }
          const inserted = db.prepare('INSERT OR IGNORE INTO seen_transactions(tx_hash,deposit_id,amount_wei,sender_address,block_number) VALUES(?,?,?,?,?)').run(tx.hash,row.id,tx.value.toString(),sender,b);
          if (inserted.changes) {
            const received = BigInt(row.received_wei) + tx.value;
            const status = received >= BigInt(row.expected_total_wei) ? 'payment_confirmed' : 'partially_paid';
            db.prepare('UPDATE deposit_requests SET received_wei=?, sender_address=?, status=? WHERE id=?').run(received.toString(),sender,status,row.id);
            row.received_wei = received.toString(); row.sender_address = sender; row.status = status;
            console.log(`Received ${formatEther(tx.value)} Sepolia ETH for ${row.id} from ${sender}`);
          }
        }
      }
      // Advance the scan cursor even for empty blocks.
      db.prepare("INSERT INTO app_state(key,value) VALUES('last_scanned_block',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(b));
    }

    const ready = db.prepare("SELECT * FROM deposit_requests WHERE status IN ('payment_confirmed','sweeping','sweep_sent','sweep_confirmed','withdrawal_sent')").all();
    for (const row of ready) await sweepAndTestWithdraw(row);
  } catch (e) { console.error('Monitor error:', e.message); }
  finally { busy = false; }
}

async function sweepAndTestWithdraw(row) {
  try {
    let current = db.prepare('SELECT * FROM deposit_requests WHERE id=?').get(row.id);
    if (current.status === 'payment_confirmed') {
      const changed = db.prepare("UPDATE deposit_requests SET status='sweeping' WHERE id=? AND status='payment_confirmed'").run(row.id);
      if (!changed.changes) return;
      const depositWallet = deriveDepositWallet(process.env.DEPOSIT_MNEMONIC, current.derivation_index).connect(provider);
      const balance = await provider.getBalance(depositWallet.address);
      const feeData = await provider.getFeeData();
      const gasLimit = 21000n;
      const maxFeePerGas = feeData.maxFeePerGas || feeData.gasPrice;
      if (!maxFeePerGas) throw new Error('Could not obtain gas price for sweep');
      const feeCap = gasLimit * maxFeePerGas;
      if (balance <= feeCap) throw new Error('Deposit address balance is too small to cover the sweep fee.');
      const value = balance - feeCap;
      const tx = await depositWallet.sendTransaction({ to: central.address, value, gasLimit, ...(feeData.maxFeePerGas ? { maxFeePerGas: feeData.maxFeePerGas, maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || 0n } : { gasPrice: feeData.gasPrice }) });
      db.prepare("UPDATE deposit_requests SET sweep_tx_hash=?, status='sweep_sent' WHERE id=?").run(tx.hash,row.id);
      console.log(`Sweep submitted for ${row.id}: ${tx.hash}`);
      current = db.prepare('SELECT * FROM deposit_requests WHERE id=?').get(row.id);
    }

    if (current.status === 'sweep_sent') {
      const receipt = await provider.getTransactionReceipt(current.sweep_tx_hash);
      if (!receipt || receipt.status !== 1 || (await provider.getBlockNumber()) - receipt.blockNumber + 1 < confirmations) return;
      const actualSweepFee = receipt.gasUsed * (receipt.gasPrice || 0n);
      db.prepare("UPDATE deposit_requests SET status='sweep_confirmed', sweep_fee_wei=? WHERE id=?").run(actualSweepFee.toString(),row.id);
      current = db.prepare('SELECT * FROM deposit_requests WHERE id=?').get(row.id);
      console.log(`Sweep confirmed for ${row.id}. Actual fee: ${formatEther(actualSweepFee)} ETH`);
    }

    if (current.status === 'sweep_confirmed') {
      if (!AUTO_WITHDRAW_TEST) {
        db.prepare("UPDATE deposit_requests SET status='completed' WHERE id=?").run(row.id);
        console.log(`Deposit ${row.id} swept and credited. Automatic test withdrawal is disabled.`);
        return;
      }
      if (!current.sender_address) throw new Error('Original sender address is missing; cannot perform test withdrawal.');
      const to = getAddress(current.sender_address);
      const amount = BigInt(current.requested_wei);
      const feeData = await provider.getFeeData();
      const tx = await central.sendTransaction({ to, value: amount, gasLimit: 21000n, ...(feeData.maxFeePerGas ? { maxFeePerGas: feeData.maxFeePerGas, maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || 0n } : { gasPrice: feeData.gasPrice }) });
      db.prepare("UPDATE deposit_requests SET withdrawal_tx_hash=?, status='withdrawal_sent' WHERE id=?").run(tx.hash,row.id);
      console.log(`Test withdrawal submitted for ${row.id}: ${tx.hash}`);
      current = db.prepare('SELECT * FROM deposit_requests WHERE id=?').get(row.id);
    }

    if (current.status === 'withdrawal_sent') {
      const receipt = await provider.getTransactionReceipt(current.withdrawal_tx_hash);
      if (!receipt || receipt.status !== 1 || (await provider.getBlockNumber()) - receipt.blockNumber + 1 < confirmations) return;
      const actualWithdrawalFee = receipt.gasUsed * (receipt.gasPrice || 0n);
      const requested = BigInt(current.requested_wei);
      const convenience = BigInt(current.convenience_fee_wei);
      const siteFee = BigInt(current.site_fee_wei);
      db.transaction(() => {
        const already = db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE deposit_id=? AND entry_type='test_withdrawal_debit'").get(row.id).n;
        if (!already) {
          db.prepare("INSERT INTO ledger(user_id,deposit_id,entry_type,amount_wei,note) VALUES(?,?,?,?,?)").run(current.user_id,row.id,'customer_credit',requested.toString(),'Requested ETH amount credited to the test exchange balance after confirmed deposit sweep');
          db.prepare("INSERT INTO ledger(user_id,deposit_id,entry_type,amount_wei,note) VALUES(?,?,?,?,?)").run(current.user_id,row.id,'convenience_fee',convenience.toString(),'Convenience fee recorded');
          db.prepare("INSERT INTO ledger(user_id,deposit_id,entry_type,amount_wei,note) VALUES(?,?,?,?,?)").run(current.user_id,row.id,'website_fee',siteFee.toString(),'Website fee recorded');
          db.prepare("INSERT INTO ledger(user_id,deposit_id,entry_type,amount_wei,note) VALUES(?,?,?,?,?)").run(current.user_id,row.id,'test_withdrawal_debit',requested.toString(),'Test mode: requested ETH amount automatically sent back to original sending wallet');
        }
        db.prepare("UPDATE deposit_requests SET status='completed', withdrawal_fee_wei=? WHERE id=?").run(actualWithdrawalFee.toString(),row.id);
      })();
      console.log(`FULL TEST FLOW COMPLETE for ${row.id}. Returned ${formatEther(requested)} ETH to ${current.sender_address}. Withdrawal: ${current.withdrawal_tx_hash}; actual withdrawal fee: ${formatEther(actualWithdrawalFee)} ETH`);
    }
  } catch (e) {
    db.prepare("UPDATE deposit_requests SET status='needs_attention' WHERE id=?").run(row.id);
    console.error(`Deposit ${row.id} needs attention:`,e.message);
  }
}

console.log(`Sepolia monitor active. Central wallet: ${central.address}. Auto-return test mode: ${AUTO_WITHDRAW_TEST ? 'ON' : 'OFF'}`);
processDeposits();
setInterval(processDeposits,pollMs);

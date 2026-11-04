require('dotenv').config();
const express = require('express');
const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const { JsonRpcProvider, parseEther, formatEther } = require('ethers');
const db = require('./db');
const { deriveDepositWallet } = require('./wallet');

const required = ['RPC_URL', 'DEPOSIT_MNEMONIC', 'CENTRAL_PRIVATE_KEY'];
for (const key of required) if (!process.env[key] || process.env[key].startsWith('replace')) throw new Error(`Set ${key} in .env`);
const provider = new JsonRpcProvider(process.env.RPC_URL);
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', async (_req, res) => {
  try {
    const network = await provider.getNetwork();
    if (network.chainId !== 11155111n) return res.status(503).json({ ok: false, error: 'Wrong network: Sepolia only.' });
    res.json({ ok: true, network: 'sepolia', chainId: Number(network.chainId) });
  } catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});

function nextIndex() {
  const row = db.prepare('SELECT MAX(derivation_index) AS n FROM deposit_requests').get();
  return (row.n == null ? -1 : row.n) + 1;
}
function estimateTwoTransactions(feeData) {
  const perGas = feeData.maxFeePerGas || feeData.gasPrice;
  if (!perGas) throw new Error('Could not obtain current Ethereum fee data');
  const multiplier = Number(process.env.GAS_CUSHION_MULTIPLIER || '1.5');
  // Deposit address -> central wallet, then central wallet -> original sender (test withdrawal).
  return (2n * 21000n * perGas * BigInt(Math.ceil(multiplier * 100))) / 100n;
}

app.get('/api/fee-estimate', async (_req, res) => {
  try {
    const network = await provider.getNetwork();
    if (network.chainId !== 11155111n) throw new Error('This prototype is locked to Sepolia testnet.');
    const fee = await provider.getFeeData();
    const estimate = estimateTwoTransactions(fee);
    res.json({ estimatedNetworkFeeEth: formatEther(estimate), estimatedNetworkFeeWei: estimate.toString(), includesTransactions: 2 });
  } catch (e) { res.status(503).json({ error: e.message }); }
});

app.post('/api/deposits', async (req, res) => {
  try {
    const userId = String(req.body.userId || '').trim();
    const amount = String(req.body.amount || '').trim();
    const conveniencePct = Number(req.body.conveniencePct);
    const sitePct = Number(req.body.sitePct);
    if (!userId || userId.length > 80) return res.status(400).json({ error: 'Enter a valid test user ID.' });
    if (!/^\d+(\.\d{1,18})?$/.test(amount)) return res.status(400).json({ error: 'Enter a valid ETH amount.' });
    const requested = parseEther(amount);
    if (requested <= 0n) return res.status(400).json({ error: 'Amount must be greater than zero.' });
    if (!Number.isFinite(conveniencePct) || conveniencePct < 1 || conveniencePct > 20) return res.status(400).json({ error: 'Convenience fee must be between 1% and 20%.' });
    if (!Number.isFinite(sitePct) || sitePct < 0 || sitePct > 100) return res.status(400).json({ error: 'Website fee must be between 0% and 100%.' });
    const network = await provider.getNetwork();
    if (network.chainId !== 11155111n) throw new Error('This prototype is locked to Sepolia testnet.');

    const convenience = requested * BigInt(Math.round(conveniencePct * 10000)) / 1000000n;
    const siteFee = requested * BigInt(Math.round(sitePct * 10000)) / 1000000n;
    const gasEstimate = estimateTwoTransactions(await provider.getFeeData());
    const total = requested + convenience + siteFee + gasEstimate;
    const index = nextIndex();
    const wallet = deriveDepositWallet(process.env.DEPOSIT_MNEMONIC, index);
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO deposit_requests
      (id,user_id,derivation_index,deposit_address,requested_wei,convenience_fee_wei,site_fee_wei,estimated_gas_wei,expected_total_wei)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(id,userId,index,wallet.address,requested.toString(),convenience.toString(),siteFee.toString(),gasEstimate.toString(),total.toString());
    res.json({ id, address: wallet.address, userId, requestedEth: formatEther(requested), convenienceFeeEth: formatEther(convenience), siteFeeEth: formatEther(siteFee), estimatedNetworkFeeEth: formatEther(gasEstimate), totalEth: formatEther(total), status: 'awaiting_payment', testWithdrawal: 'The requested ETH amount will automatically be sent back to the wallet that made the deposit.' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/deposits/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM deposit_requests WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Deposit request not found.' });
  res.json({
    id: row.id, address: row.deposit_address,
    expectedEth: formatEther(BigInt(row.expected_total_wei)),
    requestedEth: formatEther(BigInt(row.requested_wei)),
    receivedEth: formatEther(BigInt(row.received_wei)),
    senderAddress: row.sender_address,
    status: row.status,
    sweepTxHash: row.sweep_tx_hash,
    withdrawalTxHash: row.withdrawal_tx_hash,
    sweepFeeEth: row.sweep_fee_wei ? formatEther(BigInt(row.sweep_fee_wei)) : null,
    withdrawalFeeEth: row.withdrawal_fee_wei ? formatEther(BigInt(row.withdrawal_fee_wei)) : null
  });
});

const port = Number(process.env.PORT || 3000);
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Sepolia exchange prototype running on port ${port}`);
  if (process.env.RUN_MONITOR !== '0') {
    const monitor = spawn(process.execPath, [path.join(__dirname, 'monitor.js')], {
      cwd: __dirname, env: process.env, stdio: 'inherit'
    });
    monitor.on('exit', code => console.error(`Deposit monitor exited with code ${code}.`));
    process.on('SIGTERM', () => { monitor.kill('SIGTERM'); server.close(() => process.exit(0)); });
    process.on('SIGINT', () => { monitor.kill('SIGINT'); server.close(() => process.exit(0)); });
  }
});

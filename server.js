require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const {
  JsonRpcProvider, Wallet, isAddress, getAddress,
  parseEther, formatEther, parseUnits, formatUnits
} = require('ethers');
const { pool, query, transaction } = require('./db');
const { allocateWallet, deriveWallet } = require('./wallet');

const REQUIRED = [
  'RPC_URL',
  'ANONYMOUS_DEPOSIT_MNEMONIC',
  'REGISTERED_DEPOSIT_MNEMONIC',
  'ANONYMOUS_CENTRAL_PRIVATE_KEY',
  'REGISTERED_CENTRAL_PRIVATE_KEY',
  'FEE_RECIPIENT_ADDRESS',
  'SESSION_SECRET'
];
for (const key of REQUIRED) {
  if (!process.env[key] || process.env[key].startsWith('replace')) {
    throw new Error(`Set ${key} in Render environment variables before starting V2.`);
  }
}
if (!isAddress(process.env.FEE_RECIPIENT_ADDRESS)) throw new Error('FEE_RECIPIENT_ADDRESS is not a valid Ethereum address.');

const provider = new JsonRpcProvider(process.env.RPC_URL);
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use(session({
  store: new pgSession({ pool, tableName: 'sessions', createTableIfMissing: false }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const pctAmount = (amount, pct) => (amount * BigInt(Math.round(pct * 10000))) / 1000000n;

async function ensureSepolia() {
  const network = await provider.getNetwork();
  if (network.chainId !== 11155111n) throw new Error('Safety stop: this build is Sepolia testnet only.');
}

app.get('/healthz', asyncRoute(async (_req, res) => {
  await ensureSepolia();
  await query('SELECT 1');
  res.json({ ok: true, network: 'sepolia', chainId: 11155111, database: 'postgresql' });
}));

app.get('/api/config', (_req, res) => {
  res.json({
    network: 'Sepolia',
    chainId: 11155111,
    supportedAssets: ['ETH'],
    tokenSupport: 'ERC-20 processing is the next implementation stage.',
    feeDistributionPercent: 79
  });
});

app.post('/api/register', asyncRoute(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (password.length < 10 || password.length > 200) {
    return res.status(400).json({ error: 'Password must be between 10 and 200 characters.' });
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const userId = crypto.randomUUID();
  try {
    await transaction(async client => {
      await client.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [userId, email, passwordHash]);
      await allocateWallet(client, {
        mnemonic: process.env.REGISTERED_DEPOSIT_MNEMONIC,
        mnemonicGroup: 'registered',
        walletRole: 'user_permanent',
        userId
      });
    });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An account with that email already exists.' });
    throw err;
  }
  req.session.userId = userId;
  res.status(201).json({ ok: true, userId, message: 'Account created. Your permanent Sepolia address is available in your account.' });
}));

app.post('/api/login', asyncRoute(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const result = await query('SELECT id,password_hash,status FROM users WHERE email=$1', [email]);
  const user = result.rows[0];
  if (!user || user.status !== 'active' || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Could not start session.' });
    req.session.userId = user.id;
    res.json({ ok: true });
  });
}));

app.post('/api/logout', (req, res) => req.session.destroy(() => {
  res.clearCookie('connect.sid');
  res.json({ ok: true });
}));

app.get('/api/me', asyncRoute(async (req, res) => {
  if (!req.session.userId) return res.json({ authenticated: false });
  const result = await query(
    `SELECT u.id,u.email,w.address,w.derivation_index
     FROM users u LEFT JOIN wallet_registry w
       ON w.user_id=u.id AND w.wallet_role='user_permanent' AND w.is_current=TRUE
     WHERE u.id=$1`,
    [req.session.userId]
  );
  if (!result.rows[0]) return res.json({ authenticated: false });
  res.json({ authenticated: true, user: result.rows[0] });
}));

app.get('/api/fee-estimate', asyncRoute(async (req, res) => {
  await ensureSepolia();
  const amountText = String(req.query.amount || '0.01');
  if (!/^\d+(\.\d{1,18})?$/.test(amountText)) return res.status(400).json({ error: 'Invalid ETH amount.' });
  const amount = parseEther(amountText);
  const feeData = await provider.getFeeData();
  const price = feeData.maxFeePerGas || feeData.gasPrice;
  if (!price) throw new Error('RPC did not provide gas fee data.');
  const cushion = BigInt(Math.ceil(Number(process.env.GAS_CUSHION_MULTIPLIER || '1.5') * 100));
  const oneTransfer = (21000n * price * cushion) / 100n;
  // ETH flow: temporary -> registered/anonymous collector, collector -> withdrawal, collector -> fee recipient.
  const networkBudget = oneTransfer * 3n;
  res.json({
    estimatedNetworkFeeWei: networkBudget.toString(),
    estimatedNetworkFeeEth: formatEther(networkBudget),
    includesTransactions: 3,
    note: 'Preliminary ETH estimate. Actual gas is reconciled from confirmed receipts.'
  });
}));

app.post('/api/deposits', asyncRoute(async (req, res) => {
  await ensureSepolia();
  const amountText = String(req.body.amount || '').trim();
  const withdrawal = String(req.body.withdrawalAddress || '').trim();
  const conveniencePct = Number(req.body.conveniencePct);
  const websitePct = Number(req.body.websitePct);
  const assetSymbol = String(req.body.asset || 'ETH').toUpperCase();

  if (!/^\d+(\.\d{1,18})?$/.test(amountText)) return res.status(400).json({ error: 'Enter a valid ETH amount.' });
  if (!isAddress(withdrawal)) return res.status(400).json({ error: 'Enter a valid withdrawal address.' });
  if (!Number.isFinite(conveniencePct) || conveniencePct < 1 || conveniencePct > 20) return res.status(400).json({ error: 'Convenience fee must be 1–20%.' });
  if (!Number.isFinite(websitePct) || websitePct < 0 || websitePct > 100) return res.status(400).json({ error: 'Website fee must be 0–100%.' });
  if (assetSymbol !== 'ETH') return res.status(400).json({ error: 'This foundation currently accepts ETH only. ERC-20 support is the next stage.' });

  const requested = parseEther(amountText);
  if (requested <= 0n) return res.status(400).json({ error: 'Amount must be greater than zero.' });
  const convenience = pctAmount(requested, conveniencePct);
  const websiteFee = pctAmount(requested, websitePct);
  const feeData = await provider.getFeeData();
  const price = feeData.maxFeePerGas || feeData.gasPrice;
  if (!price) throw new Error('Could not estimate network fee.');
  const cushion = BigInt(Math.ceil(Number(process.env.GAS_CUSHION_MULTIPLIER || '1.5') * 100));
  const networkBudget = (3n * 21000n * price * cushion) / 100n;
  const total = requested + convenience + websiteFee + networkBudget;
  const userId = req.session.userId || null;
  const requestId = crypto.randomUUID();
  const mnemonic = userId ? process.env.REGISTERED_DEPOSIT_MNEMONIC : process.env.ANONYMOUS_DEPOSIT_MNEMONIC;
  const group = userId ? 'registered' : 'anonymous';
  const role = userId ? 'user_permanent' : 'anonymous_request';

  const created = await transaction(async client => {
    let walletRow;
    if (userId) {
      const existing = await client.query(
        `SELECT id,address,derivation_index,derivation_path FROM wallet_registry
         WHERE user_id=$1 AND wallet_role='user_permanent' AND is_current=TRUE FOR UPDATE`,
        [userId]
      );
      if (!existing.rows[0]) throw new Error('Your permanent deposit wallet is missing. Contact support.');
      walletRow = existing.rows[0];
    } else {
      walletRow = await allocateWallet(client, {
        mnemonic, mnemonicGroup: group, walletRole: role, requestId
      });
    }
    const asset = await client.query(
      `INSERT INTO assets(chain_id,symbol,name,contract_address,decimals,asset_type)
       VALUES(11155111,'ETH','Sepolia Ether',NULL,18,'native')
       ON CONFLICT DO NOTHING RETURNING id`
    );
    const assetRow = asset.rows[0] || (await client.query("SELECT id FROM assets WHERE chain_id=11155111 AND asset_type='native'")).rows[0];
    await client.query(
      `INSERT INTO deposit_requests
       (id,user_id,wallet_registry_id,asset_id,withdrawal_address,requested_amount,convenience_fee,website_fee,estimated_network_fee,expected_total)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [requestId, userId, walletRow.id, assetRow.id, getAddress(withdrawal),
       requested.toString(), convenience.toString(), websiteFee.toString(), networkBudget.toString(), total.toString()]
    );
    return { walletRow };
  });

  res.status(201).json({
    id: requestId,
    depositAddress: created.walletRow.address,
    withdrawalAddress: getAddress(withdrawal),
    asset: 'ETH',
    requestedAmount: formatEther(requested),
    convenienceFee: formatEther(convenience),
    websiteFee: formatEther(websiteFee),
    combinedServiceFee: formatEther(convenience + websiteFee),
    feeRecipientShare: formatEther(((convenience + websiteFee) * 79n) / 100n),
    retainedServiceFee: formatEther((convenience + websiteFee) - (((convenience + websiteFee) * 79n) / 100n)),
    estimatedNetworkFee: formatEther(networkBudget),
    totalToSend: formatEther(total),
    status: 'awaiting_payment',
    userType: userId ? 'registered' : 'anonymous'
  });
}));

app.get('/api/deposits/:id', asyncRoute(async (req, res) => {
  const result = await query(
    `SELECT r.id,r.user_id,r.withdrawal_address,r.requested_amount::text,
            r.convenience_fee::text,r.website_fee::text,r.estimated_network_fee::text,
            r.expected_total::text,r.status,r.created_at,w.address AS deposit_address,
            a.symbol,a.decimals
     FROM deposit_requests r
     JOIN wallet_registry w ON w.id=r.wallet_registry_id
     JOIN assets a ON a.id=r.asset_id
     WHERE r.id=$1 AND (r.user_id IS NULL OR r.user_id=$2)`,
    [req.params.id, req.session.userId || null]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Request not found.' });
  const r = result.rows[0];
  res.json({
    id: r.id, depositAddress: r.deposit_address, withdrawalAddress: r.withdrawal_address,
    asset: r.symbol, requestedAmount: formatUnits(r.requested_amount, r.decimals),
    convenienceFee: formatUnits(r.convenience_fee, r.decimals),
    websiteFee: formatUnits(r.website_fee, r.decimals),
    estimatedNetworkFee: formatEther(BigInt(r.estimated_network_fee)),
    totalToSend: formatUnits(r.expected_total, r.decimals),
    status: r.status, createdAt: r.created_at
  });
}));

app.use((err, _req, res, _next) => {
  console.error(err.stack || err.message || err);
  res.status(500).json({ error: 'Server error. Check Render logs for details.' });
});

const port = Number(process.env.PORT || 3000);
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Exchange V2 foundation listening on ${port}; Sepolia only; PostgreSQL connected.`);
});
process.on('SIGTERM', () => server.close(async () => { await pool.end(); process.exit(0); }));
process.on('SIGINT', () => server.close(async () => { await pool.end(); process.exit(0); }));

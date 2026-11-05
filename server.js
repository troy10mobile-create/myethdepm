require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcryptjs');
const { JsonRpcProvider, parseEther, formatEther, getAddress, isAddress } = require('ethers');
const db = require('./db');
const {
  createAnonymousDepositAddress,
  assignPermanentAddress,
  deriveWallet
} = require('./wallet');

const required = [
  'RPC_URL',
  'ANONYMOUS_DEPOSIT_MNEMONIC',
  'ANONYMOUS_CENTRAL_PRIVATE_KEY',
  'REGISTERED_DEPOSIT_MNEMONIC',
  'REGISTERED_CENTRAL_PRIVATE_KEY',
  'FEE_RECIPIENT_ADDRESS',
  'SESSION_SECRET'
];

for (const key of required) {
  if (!process.env[key] || process.env[key].startsWith('replace') || process.env[key].includes('0000000000')) {
    console.warn(`[startup] Warning: ${key} looks like a placeholder. Set real test values before using.`);
  }
}

const provider = new JsonRpcProvider(process.env.RPC_URL);
const app = express();
app.use(express.json());
app.use(cookieParser(process.env.SESSION_SECRET || 'dev-secret-change-me'));
app.use(express.static(path.join(__dirname, 'public')));

const SESSION_DAYS = 14;
const BCRYPT_ROUNDS = 10;

// ---------- Helpers ----------

function createSession(userId) {
  const id = crypto.randomUUID();
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(id, userId, expires);
  return { id, expires };
}

function getSessionUser(req) {
  const sid = req.signedCookies?.sid;
  if (!sid) return null;
  const row = db.prepare(`
    SELECT u.* FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > datetime('now')
  `).get(sid);
  return row || null;
}

function requireAuth(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in.' });
  req.user = user;
  next();
}

/**
 * Estimate network cost for 3 transfers:
 * 1. temporary → central
 * 2. central → withdrawal address
 * 3. central → fee recipient
 */
function estimateThreeTransactions(feeData) {
  const perGas = feeData.maxFeePerGas || feeData.gasPrice;
  if (!perGas) throw new Error('Could not obtain current Ethereum fee data');
  const multiplier = Number(process.env.GAS_CUSHION_MULTIPLIER || '1.5');
  // 3 × 21 000 gas with cushion
  return (3n * 21000n * perGas * BigInt(Math.ceil(multiplier * 100))) / 100n;
}

// ---------- Health ----------

app.get('/healthz', async (_req, res) => {
  try {
    const network = await provider.getNetwork();
    if (network.chainId !== 11155111n) {
      return res.status(503).json({ ok: false, error: 'Wrong network: Sepolia only.' });
    }
    res.json({ ok: true, network: 'sepolia', chainId: Number(network.chainId), version: '2.0.0-sqlite' });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

// ---------- Auth ----------

app.post('/api/register', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const email = String(req.body.email || '').trim() || null;

    if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
      return res.status(400).json({ error: 'Username must be 3-32 characters (letters, numbers, underscore).' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);
    if (existing) return res.status(400).json({ error: 'Username already taken.' });

    const id = crypto.randomUUID();
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const { index, address } = assignPermanentAddress(process.env.REGISTERED_DEPOSIT_MNEMONIC, id);

    db.transaction(() => {
      db.prepare(`
        INSERT INTO users (id, username, email, password_hash, permanent_address, permanent_derivation_index)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, username, email, passwordHash, address, index);

      db.prepare(`
        INSERT INTO balances (user_id, asset, available_wei, reserved_wei)
        VALUES (?, 'ETH', '0', '0')
      `).run(id);
    })();

    const session = createSession(id);
    res.cookie('sid', session.id, {
      httpOnly: true,
      signed: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000
    });

    res.json({
      ok: true,
      user: { id, username, permanentAddress: address },
      message: 'Registered. Your permanent deposit address has been assigned.'
    });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');

    const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
    if (!user) return res.status(401).json({ error: 'Invalid username or password.' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid username or password.' });

    const session = createSession(user.id);
    res.cookie('sid', session.id, {
      httpOnly: true,
      signed: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000
    });

    res.json({
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        permanentAddress: user.permanent_address
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/logout', (req, res) => {
  const sid = req.signedCookies?.sid;
  if (sid) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
  }
  res.clearCookie('sid');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.json({ loggedIn: false });

  const balances = db.prepare('SELECT asset, available_wei, reserved_wei FROM balances WHERE user_id = ?').all(user.id);
  res.json({
    loggedIn: true,
    user: {
      id: user.id,
      username: user.username,
      permanentAddress: user.permanent_address,
      balances: balances.map(b => ({
        asset: b.asset,
        available: formatEther(BigInt(b.available_wei)),
        reserved: formatEther(BigInt(b.reserved_wei))
      }))
    }
  });
});

// ---------- Fee estimate ----------

app.get('/api/fee-estimate', async (_req, res) => {
  try {
    const network = await provider.getNetwork();
    if (network.chainId !== 11155111n) throw new Error('This prototype is locked to Sepolia testnet.');
    const fee = await provider.getFeeData();
    const estimate = estimateThreeTransactions(fee);
    res.json({
      estimatedNetworkFeeEth: formatEther(estimate),
      estimatedNetworkFeeWei: estimate.toString(),
      includesTransactions: 3,
      note: 'Covers temporary→central, central→withdrawal, and central→fee-recipient'
    });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

// ---------- Create deposit request (anonymous or logged-in) ----------

app.post('/api/deposits', async (req, res) => {
  try {
    const user = getSessionUser(req); // may be null (anonymous)

    const amount = String(req.body.amount || '').trim();
    const conveniencePct = Number(req.body.conveniencePct);
    const sitePct = Number(req.body.sitePct);
    const withdrawalAddressRaw = String(req.body.withdrawalAddress || '').trim();

    if (!/^\d+(\.\d{1,18})?$/.test(amount)) {
      return res.status(400).json({ error: 'Enter a valid ETH amount.' });
    }
    const requested = parseEther(amount);
    if (requested <= 0n) return res.status(400).json({ error: 'Amount must be greater than zero.' });

    if (!Number.isFinite(conveniencePct) || conveniencePct < 1 || conveniencePct > 20) {
      return res.status(400).json({ error: 'Convenience fee must be between 1% and 20%.' });
    }
    if (!Number.isFinite(sitePct) || sitePct < 0 || sitePct > 100) {
      return res.status(400).json({ error: 'Website fee must be between 0% and 100%.' });
    }

    if (!isAddress(withdrawalAddressRaw)) {
      return res.status(400).json({ error: 'Enter a valid Ethereum withdrawal address.' });
    }
    const withdrawalAddress = getAddress(withdrawalAddressRaw);

    const network = await provider.getNetwork();
    if (network.chainId !== 11155111n) throw new Error('This prototype is locked to Sepolia testnet.');

    const convenience = requested * BigInt(Math.round(conveniencePct * 10000)) / 1000000n;
    const siteFee = requested * BigInt(Math.round(sitePct * 10000)) / 1000000n;
    const gasEstimate = estimateThreeTransactions(await provider.getFeeData());
    const total = requested + convenience + siteFee + gasEstimate;

    const id = crypto.randomUUID();
    const { index, address } = createAnonymousDepositAddress(
      process.env.ANONYMOUS_DEPOSIT_MNEMONIC,
      id
    );

    db.prepare(`
      INSERT INTO deposit_requests (
        id, user_id, derivation_index, deposit_address, withdrawal_address,
        asset, requested_wei, convenience_fee_wei, site_fee_wei,
        estimated_gas_wei, expected_total_wei
      ) VALUES (?, ?, ?, ?, ?, 'ETH', ?, ?, ?, ?, ?)
    `).run(
      id,
      user ? user.id : null,
      index,
      address,
      withdrawalAddress,
      requested.toString(),
      convenience.toString(),
      siteFee.toString(),
      gasEstimate.toString(),
      total.toString()
    );

    res.json({
      id,
      address,
      withdrawalAddress,
      requestedEth: formatEther(requested),
      convenienceFeeEth: formatEther(convenience),
      siteFeeEth: formatEther(siteFee),
      estimatedNetworkFeeEth: formatEther(gasEstimate),
      totalEth: formatEther(total),
      status: 'awaiting_payment',
      loggedIn: !!user,
      username: user ? user.username : null,
      note: 'Send the exact total. After sweep + withdrawal succeeds, 79% of the combined fees will be forwarded to the fee recipient.'
    });
  } catch (e) {
    console.error('Create deposit error:', e);
    res.status(400).json({ error: e.message });
  }
});

// ---------- Get deposit status ----------

app.get('/api/deposits/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM deposit_requests WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Deposit request not found.' });

  res.json({
    id: row.id,
    address: row.deposit_address,
    withdrawalAddress: row.withdrawal_address,
    expectedEth: formatEther(BigInt(row.expected_total_wei)),
    requestedEth: formatEther(BigInt(row.requested_wei)),
    convenienceFeeEth: formatEther(BigInt(row.convenience_fee_wei)),
    siteFeeEth: formatEther(BigInt(row.site_fee_wei)),
    receivedEth: formatEther(BigInt(row.received_wei)),
    senderAddress: row.sender_address,
    status: row.status,
    sweepTxHash: row.sweep_tx_hash,
    withdrawalTxHash: row.withdrawal_tx_hash,
    feeForwardTxHash: row.fee_forward_tx_hash,
    sweepFeeEth: row.sweep_fee_wei ? formatEther(BigInt(row.sweep_fee_wei)) : null,
    withdrawalFeeEth: row.withdrawal_fee_wei ? formatEther(BigInt(row.withdrawal_fee_wei)) : null,
    lastError: row.last_error || null,
    loggedInUserId: row.user_id
  });
});


// ---------- Logged-in balance withdrawal ----------

app.post('/api/withdraw', requireAuth, async (req, res) => {
  try {
    const amountStr = String(req.body.amount || '').trim();
    const toRaw = String(req.body.toAddress || '').trim();

    if (!/^\d+(\.\d{1,18})?$/.test(amountStr)) {
      return res.status(400).json({ error: 'Enter a valid ETH amount.' });
    }
    const amount = parseEther(amountStr);
    if (amount <= 0n) return res.status(400).json({ error: 'Amount must be greater than zero.' });

    if (!isAddress(toRaw)) {
      return res.status(400).json({ error: 'Enter a valid destination address.' });
    }
    const to = getAddress(toRaw);

    // Check available balance
    const bal = db.prepare(
      "SELECT available_wei, reserved_wei FROM balances WHERE user_id = ? AND asset = 'ETH'"
    ).get(req.user.id);

    const available = BigInt(bal?.available_wei || '0');
    if (available < amount) {
      return res.status(400).json({
        error: `Insufficient balance. Available: ${formatEther(available)} ETH`
      });
    }

    // Reserve the amount
    db.prepare(`
      UPDATE balances
      SET available_wei = CAST(available_wei AS INTEGER) - ?,
          reserved_wei  = CAST(reserved_wei  AS INTEGER) + ?
      WHERE user_id = ? AND asset = 'ETH'
    `).run(amount.toString(), amount.toString(), req.user.id);

    // Send from the anonymous central wallet for now (same one that holds swept funds)
    const { Wallet } = require('ethers');
    const central = new Wallet(process.env.ANONYMOUS_CENTRAL_PRIVATE_KEY, provider);

    const feeData = await provider.getFeeData();
    const estimate = await central.estimateGas({ to, value: amount });
    const gasLimit = (estimate * 150n + 99n) / 100n;
    const feeCap = feeData.maxFeePerGas || feeData.gasPrice;
    const required = amount + gasLimit * feeCap;
    const centralBal = await provider.getBalance(central.address);

    if (centralBal < required) {
      // Release reservation
      db.prepare(`
        UPDATE balances
        SET available_wei = CAST(available_wei AS INTEGER) + ?,
            reserved_wei  = CAST(reserved_wei  AS INTEGER) - ?
        WHERE user_id = ? AND asset = 'ETH'
      `).run(amount.toString(), amount.toString(), req.user.id);
      return res.status(503).json({ error: 'Central wallet temporarily insufficient. Try again later.' });
    }

    const tx = await central.sendTransaction({
      to,
      value: amount,
      gasLimit,
      ...(feeData.maxFeePerGas != null
        ? { maxFeePerGas: feeData.maxFeePerGas, maxPriorityFeePerGas: feeData.maxPriorityFeePerGas }
        : { gasPrice: feeData.gasPrice })
    });

    // Wait a short moment then finalize (simple version – production would use the monitor)
    const receipt = await tx.wait(1);

    if (receipt.status !== 1) {
      // Release reservation on failure
      db.prepare(`
        UPDATE balances
        SET available_wei = CAST(available_wei AS INTEGER) + ?,
            reserved_wei  = CAST(reserved_wei  AS INTEGER) - ?
        WHERE user_id = ? AND asset = 'ETH'
      `).run(amount.toString(), amount.toString(), req.user.id);
      return res.status(500).json({ error: 'Withdrawal transaction failed on-chain.' });
    }

    // Finalize: remove from reserved, write ledger
    db.transaction(() => {
      db.prepare(`
        UPDATE balances
        SET reserved_wei = CAST(reserved_wei AS INTEGER) - ?
        WHERE user_id = ? AND asset = 'ETH'
      `).run(amount.toString(), req.user.id);

      db.prepare(`
        INSERT INTO ledger (user_id, deposit_id, entry_type, asset, amount_wei, note)
        VALUES (?, NULL, 'balance_withdrawal', 'ETH', ?, ?)
      `).run(req.user.id, amount.toString(), `Withdrawal to ${to} · tx ${tx.hash}`);
    })();

    res.json({
      ok: true,
      txHash: tx.hash,
      amount: formatEther(amount),
      to,
      message: 'Withdrawal sent successfully.'
    });
  } catch (e) {
    console.error('Withdraw error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Recent activity for the logged-in user
app.get('/api/activity', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT entry_type, amount_wei, note, created_at
    FROM ledger
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT 30
  `).all(req.user.id);

  res.json({
    activity: rows.map(r => ({
      type: r.entry_type,
      amount: formatEther(BigInt(r.amount_wei)),
      note: r.note,
      at: r.created_at
    }))
  });
});

// Chain info (multi-EVM prepared, only Sepolia active)
app.get('/api/chains', (_req, res) => {
  try {
    const { CHAINS, getActiveChain } = require('./chains');
    const active = getActiveChain();
    res.json({
      active: { key: 'sepolia', ...active },
      available: Object.entries(CHAINS)
        .filter(([, c]) => c.active)
        .map(([key, c]) => ({ key, name: c.name, id: c.id }))
    });
  } catch (e) {
    res.json({ active: { key: 'sepolia', name: 'Sepolia' }, available: [] });
  }
});


// ---------- Start ----------

const port = Number(process.env.PORT || 3000);
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`ETH Exchange V2 (SQLite) running on port ${port}`);
  if (process.env.RUN_MONITOR !== '0') {
    const monitor = spawn(process.execPath, [path.join(__dirname, 'monitor.js')], {
      cwd: __dirname,
      env: process.env,
      stdio: 'inherit'
    });
    monitor.on('exit', code => console.error(`Deposit monitor exited with code ${code}.`));
    process.on('SIGTERM', () => {
      monitor.kill('SIGTERM');
      server.close(() => process.exit(0));
    });
    process.on('SIGINT', () => {
      monitor.kill('SIGINT');
      server.close(() => process.exit(0));
    });
  }
});

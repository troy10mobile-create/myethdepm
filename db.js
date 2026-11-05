const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'storage', 'exchange.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
-- Registered users
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT,
  password_hash TEXT NOT NULL,
  permanent_address TEXT NOT NULL UNIQUE,
  permanent_derivation_index INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Simple session store (HTTP-only cookie)
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Internal balances for registered users (ETH and future ERC-20)
CREATE TABLE IF NOT EXISTS balances (
  user_id TEXT NOT NULL,
  asset TEXT NOT NULL DEFAULT 'ETH',
  available_wei TEXT NOT NULL DEFAULT '0',
  reserved_wei TEXT NOT NULL DEFAULT '0',
  PRIMARY KEY (user_id, asset),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Every generated deposit request (anonymous or linked to a user)
CREATE TABLE IF NOT EXISTS deposit_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT,                          -- NULL for anonymous
  derivation_index INTEGER NOT NULL,
  deposit_address TEXT NOT NULL UNIQUE,
  withdrawal_address TEXT NOT NULL,      -- explicit destination
  asset TEXT NOT NULL DEFAULT 'ETH',
  requested_wei TEXT NOT NULL,
  convenience_fee_wei TEXT NOT NULL,
  site_fee_wei TEXT NOT NULL,
  estimated_gas_wei TEXT NOT NULL,
  expected_total_wei TEXT NOT NULL,
  received_wei TEXT NOT NULL DEFAULT '0',
  sender_address TEXT,
  status TEXT NOT NULL DEFAULT 'awaiting_payment',
  sweep_tx_hash TEXT,
  withdrawal_tx_hash TEXT,
  fee_forward_tx_hash TEXT,
  sweep_fee_wei TEXT,
  withdrawal_fee_wei TEXT,
  fee_forward_fee_wei TEXT,
  sweep_attempts INTEGER NOT NULL DEFAULT 0,
  withdrawal_attempts INTEGER NOT NULL DEFAULT 0,
  fee_forward_attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS seen_transactions (
  tx_hash TEXT PRIMARY KEY,
  deposit_id TEXT NOT NULL,
  amount_wei TEXT NOT NULL,
  sender_address TEXT,
  block_number INTEGER NOT NULL
);

-- Simple ledger for credits, fees, debits
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  deposit_id TEXT,
  entry_type TEXT NOT NULL,
  asset TEXT NOT NULL DEFAULT 'ETH',
  amount_wei TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Track used derivation indices so we can avoid collisions (both anonymous and registered)
CREATE TABLE IF NOT EXISTS used_indices (
  wallet_type TEXT NOT NULL,           -- 'anonymous' or 'registered'
  derivation_index INTEGER NOT NULL,
  address TEXT NOT NULL,
  deposit_id TEXT,
  user_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (wallet_type, derivation_index)
);
`);

// Lightweight column migrations for older DBs
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn('deposit_requests', 'withdrawal_address', "TEXT NOT NULL DEFAULT ''");
ensureColumn('deposit_requests', 'fee_forward_tx_hash', 'TEXT');
ensureColumn('deposit_requests', 'fee_forward_fee_wei', 'TEXT');
ensureColumn('deposit_requests', 'fee_forward_attempts', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('deposit_requests', 'asset', "TEXT NOT NULL DEFAULT 'ETH'");
ensureColumn('deposit_requests', 'user_id', 'TEXT');
ensureColumn('ledger', 'asset', "TEXT NOT NULL DEFAULT 'ETH'");
ensureColumn('ledger', 'user_id', 'TEXT');

module.exports = db;

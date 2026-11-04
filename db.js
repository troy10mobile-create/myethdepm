const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const dbPath = process.env.DB_PATH || path.join(__dirname, 'storage', 'exchange.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS deposit_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  derivation_index INTEGER NOT NULL,
  deposit_address TEXT NOT NULL UNIQUE,
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
  sweep_fee_wei TEXT,
  withdrawal_fee_wei TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS seen_transactions (
  tx_hash TEXT PRIMARY KEY,
  deposit_id TEXT NOT NULL,
  amount_wei TEXT NOT NULL,
  sender_address TEXT,
  block_number INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  deposit_id TEXT NOT NULL,
  entry_type TEXT NOT NULL,
  amount_wei TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

// Lightweight migrations so the notebook can be rerun against an earlier prototype DB.
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn('deposit_requests', 'sender_address', 'TEXT');
ensureColumn('deposit_requests', 'withdrawal_tx_hash', 'TEXT');
ensureColumn('deposit_requests', 'sweep_fee_wei', 'TEXT');
ensureColumn('deposit_requests', 'withdrawal_fee_wei', 'TEXT');
ensureColumn('deposit_requests', 'sweep_attempts', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('deposit_requests', 'withdrawal_attempts', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('deposit_requests', 'last_error', 'TEXT');
ensureColumn('seen_transactions', 'sender_address', 'TEXT');
module.exports = db;

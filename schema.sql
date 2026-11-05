-- V2 central database. All monetary values are integer base units stored as NUMERIC(78,0).
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','locked','disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  sid VARCHAR NOT NULL PRIMARY KEY,
  sess JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expire_idx ON sessions(expire);

CREATE TABLE IF NOT EXISTS assets (
  id BIGSERIAL PRIMARY KEY,
  chain_id BIGINT NOT NULL DEFAULT 11155111,
  symbol TEXT NOT NULL,
  name TEXT,
  contract_address TEXT,
  decimals SMALLINT NOT NULL CHECK (decimals BETWEEN 0 AND 36),
  asset_type TEXT NOT NULL CHECK (asset_type IN ('native','erc20')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE(chain_id, contract_address)
);
CREATE UNIQUE INDEX IF NOT EXISTS assets_native_unique ON assets(chain_id) WHERE asset_type='native';

CREATE TABLE IF NOT EXISTS wallet_registry (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  wallet_role TEXT NOT NULL CHECK (wallet_role IN ('anonymous_request','user_permanent')),
  derivation_index BIGINT NOT NULL CHECK (derivation_index BETWEEN 1 AND 2147483647),
  derivation_path TEXT NOT NULL,
  address TEXT NOT NULL UNIQUE,
  mnemonic_group TEXT NOT NULL CHECK (mnemonic_group IN ('anonymous','registered')),
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at TIMESTAMPTZ,
  UNIQUE(mnemonic_group, derivation_index)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_current_user_wallet
  ON wallet_registry(user_id) WHERE wallet_role='user_permanent' AND is_current=TRUE;

CREATE TABLE IF NOT EXISTS deposit_requests (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  wallet_registry_id UUID NOT NULL REFERENCES wallet_registry(id),
  asset_id BIGINT NOT NULL REFERENCES assets(id),
  withdrawal_address TEXT NOT NULL,
  requested_amount NUMERIC(78,0) NOT NULL CHECK (requested_amount > 0),
  convenience_fee NUMERIC(78,0) NOT NULL DEFAULT 0,
  website_fee NUMERIC(78,0) NOT NULL DEFAULT 0,
  estimated_network_fee NUMERIC(78,0) NOT NULL DEFAULT 0,
  estimated_gas_funding NUMERIC(78,0) NOT NULL DEFAULT 0,
  expected_total NUMERIC(78,0) NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_payment',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS deposit_requests_user_idx ON deposit_requests(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS deposit_requests_status_idx ON deposit_requests(status);

CREATE TABLE IF NOT EXISTS chain_transactions (
  id BIGSERIAL PRIMARY KEY,
  request_id UUID REFERENCES deposit_requests(id),
  user_id UUID REFERENCES users(id),
  asset_id BIGINT REFERENCES assets(id),
  tx_hash TEXT NOT NULL UNIQUE,
  tx_role TEXT NOT NULL CHECK (tx_role IN ('deposit','gas_funding','sweep','withdrawal','fee_distribution')),
  from_address TEXT,
  to_address TEXT,
  amount NUMERIC(78,0),
  gas_used NUMERIC(78,0),
  effective_gas_price NUMERIC(78,0),
  block_number BIGINT,
  confirmations INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  request_id UUID REFERENCES deposit_requests(id),
  asset_id BIGINT NOT NULL REFERENCES assets(id),
  entry_type TEXT NOT NULL,
  amount NUMERIC(78,0) NOT NULL,
  direction SMALLINT NOT NULL CHECK (direction IN (-1,1)),
  reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ledger_user_asset_idx ON ledger_entries(user_id, asset_id, created_at);

CREATE TABLE IF NOT EXISTS fee_distributions (
  id BIGSERIAL PRIMARY KEY,
  request_id UUID NOT NULL UNIQUE REFERENCES deposit_requests(id),
  fee_recipient TEXT NOT NULL,
  combined_service_fee NUMERIC(78,0) NOT NULL,
  recipient_share NUMERIC(78,0) NOT NULL,
  retained_share NUMERIC(78,0) NOT NULL,
  tx_hash TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallet_index_history (
  id BIGSERIAL PRIMARY KEY,
  wallet_role TEXT NOT NULL,
  mnemonic_group TEXT NOT NULL,
  derivation_index BIGINT NOT NULL,
  address TEXT NOT NULL,
  request_id UUID REFERENCES deposit_requests(id),
  user_id UUID REFERENCES users(id),
  event TEXT NOT NULL CHECK (event IN ('assigned','regenerated','retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

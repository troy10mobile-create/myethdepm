# Ethereum Exchange V2 — Foundation (Sepolia only)

This is the first V2 foundation milestone, not the completed exchange. It introduces PostgreSQL-backed accounts, permanent registered-user wallet assignment, anonymous request wallets, random derivation indices, explicit withdrawal destinations, and fee-distribution accounting fields.

## Important scope
- ETH requests only in this milestone. ERC-20 monitoring/sweeping is a later stage.
- Chain monitor and actual sweep/withdrawal/fee-distribution execution are intentionally not enabled yet.
- The request API returns an address and quote; it does not yet move funds.
- Do not use real funds or production keys.
- This build does not yet replace the live Fix 1 deployment. Deploy it as a separate Render test service first.

## Render setup
1. Create a persistent PostgreSQL database in Render.
2. Copy its **Internal Database URL** into `DATABASE_URL` for a service in the same Render region; otherwise use the external URL.
3. Upload these files to a new GitHub branch/repository or a separate test service. Do not overwrite the working Fix 1 service yet.
4. Set all variables from `.env.example` in Render. Use two different throwaway Sepolia mnemonics and two different throwaway test central-wallet private keys.
5. Set `FEE_RECIPIENT_ADDRESS` to the public wallet address that should receive the 79% share.
6. Run the schema once against PostgreSQL:
   `psql "$DATABASE_URL" -f schema.sql`
   If your environment has no `psql`, use Render's PostgreSQL Shell and paste the contents of `schema.sql`.
7. Deploy with `npm install` and `npm start`.
8. Verify `/healthz` returns `ok: true`, `network: sepolia`, and `database: postgresql`.

## API
- `POST /api/register` — JSON `{ "email": "...", "password": "at least 10 characters" }`
- `POST /api/login` — JSON `{ "email": "...", "password": "..." }`
- `POST /api/logout`
- `GET /api/me`
- `GET /api/config`
- `GET /api/fee-estimate?amount=0.01`
- `POST /api/deposits` — JSON `{ "amount":"0.01", "withdrawalAddress":"0x...", "conveniencePct":10, "websitePct":10, "asset":"ETH" }`
- `GET /api/deposits/:id`

Sessions use HTTP-only cookies stored in PostgreSQL. Passwords are bcrypt-hashed. Anonymous requests have `user_id = NULL` and are still stored in the same central database.

## Address/index behavior
Indices are cryptographically random in the BIP-32 non-hardened range 1..2,147,483,647. A database uniqueness constraint prevents collisions. The wallet registry and history retain every allocated address/index. Regeneration can create a replacement address, but old addresses must remain monitored if they have ever been exposed or funded; never discard the historical mapping.

## Fee distribution rule
The quote records 79% of the combined convenience and website fees as the intended recipient share, and 21% as retained service fees. Actual transfer is deliberately not active in this foundation milestone. The next transaction-processing milestone must send that share only after the requested withdrawal is confirmed successful, and must record an idempotent fee-distribution row before broadcasting to prevent duplicate payouts.

## Known next stages
1. Update the website UI for account registration/login, explicit withdrawal address, and ETH request flow.
2. Implement robust chain monitor with confirmations, reorg/restart recovery, actual gas receipts, sweep and withdrawal.
3. Implement 79% fee-recipient payout after successful withdrawal.
4. Implement ERC-20 Transfer-log monitoring, token sweeps, and ETH gas funding.
5. Add user balances with transactional reservations, ledger reconciliation, rate limits, admin controls, backups and audit logs.

## Security
This is custodial architecture, even on testnet. Keep mnemonics/private keys out of GitHub, browser code, logs, and chat. Use only throwaway Sepolia wallets. Do not enable real-money deposits.

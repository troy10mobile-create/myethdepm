# ETH Exchange V2 — Sepolia (SQLite)

Simple custodial-style test exchange for Sepolia.

## Features in this version

- Anonymous deposits (no login required)
- Optional registration / login
- Permanent address assigned on registration
- Random derivation indices for temporary deposit addresses
- Explicit withdrawal address (you choose where funds go)
- Automatic sweep → withdrawal → **79 % fee forward**
- Network fee budget covers 3 transfers
- SQLite only (temporary storage on Render free tier)

## Important limitations

- **Sepolia only** — never use mainnet keys
- SQLite lives on Render’s temporary filesystem → data is lost on redeploy / restart
- No ERC-20 support yet (ETH only in this stage)
- No real production custody / security

## Quick deploy on Render

1. Create a **private** GitHub repository and push this project.
2. On Render → New → Web Service → connect the repo.
3. Settings:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance: Free
4. Generate test wallets locally:
   ```bash
   npm install
   node scripts/generate-test-wallets.js
   ```
5. Copy the printed values into Render → Environment.
6. Fund **both** central wallets with Sepolia ETH.
7. Deploy and open the service URL.

## Local test

```bash
cp .env.example .env
# edit .env with real test mnemonics / keys
npm install
npm start
```

Open http://localhost:3000

## Flow

1. Enter withdrawal address + amount + fees
2. Generate deposit address
3. Send exact total from any wallet
4. Monitor automatically:
   - detects payment
   - sweeps to anonymous central wallet
   - sends requested amount to your withdrawal address
   - forwards 79 % of (convenience + website fees) to FEE_RECIPIENT_ADDRESS
5. Status becomes `completed`

## Next stages (when you are ready)

- Real PostgreSQL
- ERC-20 support
- Permanent-address deposit monitoring for registered users
- Balance-based withdrawals for registered users

# ETH Exchange Sepolia Test — Render deployment

This is a **test-only** prototype. It creates a fresh HD-derived deposit address per request, watches Sepolia, sweeps received ETH into a central wallet, records a simple ledger entry, and (when `AUTO_WITHDRAW_TEST=1`) sends the requested amount back to the original sending address.

It is not a production exchange: there is no authentication, customer account security, production custody, trading engine, or protection against malicious users. Do not use real ETH or real wallet secrets.

## 1. Get test-only wallet credentials

On a computer with Node.js 20 installed:

```bash
npm install
npm run generate-wallets
```

This creates `.env.test-generated` and prints:
- a central wallet address and private key;
- a separate HD deposit-wallet mnemonic;
- a sample first deposit address.

The generated credentials are throwaway testnet credentials. Never reuse them on mainnet. Do not commit `.env.test-generated` to GitHub. Keep a private backup while testing because Render environment variables are the running service's source of truth.

If you cannot run Node locally, create two separate test-only MetaMask accounts: use one account's exported private key for `CENTRAL_PRIVATE_KEY`, and use a separate new wallet's 12-word recovery phrase for `DEPOSIT_MNEMONIC`. Do not use your everyday wallet.

## 2. Get a Sepolia RPC URL

The project has a public Sepolia RPC fallback:

`https://ethereum-sepolia-rpc.publicnode.com`

For more reliable testing, create a free Sepolia app with an RPC provider such as Alchemy and use its HTTPS Sepolia endpoint as `RPC_URL`. Public endpoints can rate-limit or temporarily fail.

## 3. Put the project on GitHub

1. Create a new **private** GitHub repository.
2. Upload the contents of this project folder (not the parent ZIP folder).
3. Confirm `.env.test-generated`, `.env`, and all private keys/seed phrases are NOT in the repository.

## 4. Deploy on Render

1. In Render, choose **New → Web Service** and connect the GitHub repository.
2. Runtime: Node.
3. Build command: `npm install`
4. Start command: `npm start`
5. Choose Free for an initial short test, if available.
6. Add these Environment variables in Render (use the generated test-only values):

| Variable | Value |
|---|---|
| `RPC_URL` | Your Sepolia HTTPS RPC URL |
| `DEPOSIT_MNEMONIC` | Generated test-only 12-word phrase |
| `CENTRAL_PRIVATE_KEY` | Generated test-only private key, including `0x` |
| `CONFIRMATIONS` | `3` |
| `POLL_INTERVAL_MS` | `12000` |
| `GAS_CUSHION_MULTIPLIER` | `1.5` |
| `AUTO_WITHDRAW_TEST` | `1` |
| `RUN_MONITOR` | `1` |
| `DB_PATH` | `./storage/exchange.sqlite` |
| `NODE_VERSION` | `20.19.0` |

Do not set `PORT`; Render supplies it automatically. The service binds to `0.0.0.0`.

The included `render.yaml` can prefill most settings if you deploy using a Render Blueprint, but you still need to enter the two secret values.

## 5. Important Render free-plan limitation

The web service runs the website and the blockchain monitor together in one Node process, keeping this prototype simple. On Render Free, the service spins down after 15 minutes without inbound traffic. Its local filesystem is ephemeral, so the SQLite database can be lost on spin-down, restart, or redeploy. Keep the browser page open during the round-trip test so its status polling keeps sending requests. Do not rely on this setup for unattended deposits.

For persistent test records, use a paid Render web service with a persistent disk mounted at `/var/data`, and set `DB_PATH=/var/data/exchange.sqlite`. This is the simplest durable option for this SQLite prototype. Render Free Postgres is another option but expires after 30 days and would require changing the app's database adapter.

## 6. Fund the wallets with Sepolia ETH

You need test ETH in the **customer/test sender wallet** to send the deposit. It is also sensible to fund the central wallet with a small reserve for testing, although the deposit sweep should fund the central wallet before the automatic return transaction.

For a new wallet with no Ethereum mainnet balance, try these in this order:

1. Google Cloud Sepolia faucet: https://cloud.google.com/application/web3/faucet/ethereum/sepolia — currently shows 0.05 Sepolia ETH. Google says some anti-abuse checks may require 0.001 ETH on Ethereum mainnet, but not every request is flagged.
2. pk910 proof-of-work Sepolia faucet: https://sepolia-faucet.pk910.de — no signup or mainnet balance required; it asks your browser to do proof-of-work. Leave the tab open while it mines, then claim to your address.
3. Zalalena Sepolia faucet: https://faucet.zalalena.com/sepolia — third-party fallback that says it accepts a public address without a mainnet balance; complete its CAPTCHA. Use only the public address, never connect by sharing a seed phrase or private key.

Alchemy and some other faucets may reject brand-new wallets because they require mainnet balance/activity. Faucet availability and limits can change. Testnet ETH has no real-world value.

After claiming, check the transaction on https://sepolia.etherscan.io/ and make sure the wallet is on **Ethereum Sepolia**, chain ID **11155111**.

## 7. Run the round-trip test

1. Open the Render `onrender.com` URL.
2. Enter a test user ID and the ETH amount you want credited.
3. Adjust the convenience and website fee sliders.
4. Click **Generate fresh deposit address**.
5. From the customer MetaMask wallet on Sepolia, send the exact displayed total to the generated address. The wallet must have enough balance for the amount plus its own transaction fee.
6. Keep the page open. The monitor waits for 3 confirmations, sweeps the deposit to the central wallet, records the test ledger entries, and sends the requested ETH amount back to the original sender.
7. Check the sweep and withdrawal hashes on Sepolia Etherscan.

The app currently treats the first sender address as the automatic test withdrawal destination. For this reason, send the deposit from one wallet only for each deposit request. Do not send from multiple wallets to the same generated address.

## Safety notes

- The app refuses to operate unless the RPC reports Sepolia chain ID 11155111.
- Never paste a real/mainnet seed phrase or private key into Render.
- The website is publicly reachable and currently has no login. Anyone with the URL can create test requests; do not put real funds or real secrets into this prototype.
- The automatic return is a test harness, not the eventual customer withdrawal workflow.

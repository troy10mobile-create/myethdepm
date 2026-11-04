# ETH Exchange MVP — Sepolia test

Render deployment instructions: see `README-RENDER.md`.

This is a test-only prototype. It creates a fresh deposit address for each request, monitors Sepolia, sweeps the deposit into a central wallet, records simple ledger entries, and automatically returns the requested amount to the original sender when `AUTO_WITHDRAW_TEST=1`.

Not production exchange software. No real funds, no mainnet keys, no customer authentication.

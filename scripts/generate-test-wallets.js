/**
 * Generate two separate test-only wallets for V2:
 *  - Anonymous deposit HD mnemonic + central private key
 *  - Registered-user HD mnemonic + central private key
 *
 * NEVER use these on mainnet.
 */
const { Wallet, HDNodeWallet } = require('ethers');
const crypto = require('crypto');

function randomMnemonic() {
  // 16 bytes → 12-word mnemonic
  const entropy = crypto.randomBytes(16);
  return HDNodeWallet.createRandom(undefined, entropy).mnemonic.phrase;
}

function randomPrivateKey() {
  return Wallet.createRandom().privateKey;
}

console.log('=== ETH Exchange V2 — Test-only wallets (Sepolia) ===\n');
console.log('Copy these into your Render Environment variables.\n');
console.log('--------------------------------------------------');
console.log('ANONYMOUS_DEPOSIT_MNEMONIC="' + randomMnemonic() + '"');
console.log('ANONYMOUS_CENTRAL_PRIVATE_KEY="' + randomPrivateKey() + '"');
console.log('');
console.log('REGISTERED_DEPOSIT_MNEMONIC="' + randomMnemonic() + '"');
console.log('REGISTERED_CENTRAL_PRIVATE_KEY="' + randomPrivateKey() + '"');
console.log('');
console.log('FEE_RECIPIENT_ADDRESS="0xYourTestWalletAddressHere"');
console.log('SESSION_SECRET="' + crypto.randomBytes(32).toString('hex') + '"');
console.log('--------------------------------------------------');
console.log('\nAlso set:');
console.log('RPC_URL=https://ethereum-sepolia-rpc.publicnode.com');
console.log('CONFIRMATIONS=3');
console.log('POLL_INTERVAL_MS=12000');
console.log('GAS_CUSHION_MULTIPLIER=1.5');
console.log('RUN_MONITOR=1');
console.log('DB_PATH=./storage/exchange.sqlite');
console.log('\nIMPORTANT: Fund the two CENTRAL wallets with Sepolia ETH before testing.');
console.log('Do NOT commit private keys or mnemonics to GitHub.');

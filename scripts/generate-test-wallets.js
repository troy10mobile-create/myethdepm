const { Wallet, HDNodeWallet } = require('ethers');
const fs = require('fs');
const path = require('path');

// Creates throwaway Sepolia-only credentials. Never reuse these on mainnet.
const central = Wallet.createRandom();
const depositMnemonic = HDNodeWallet.createRandom().mnemonic.phrase;
const firstDeposit = HDNodeWallet.fromPhrase(depositMnemonic, undefined, 'm').derivePath("m/44'/60'/0'/0/0");

const env = [
  '# TESTNET ONLY. Never reuse these credentials on Ethereum mainnet.',
  'RPC_URL=https://ethereum-sepolia-rpc.publicnode.com',
  `DEPOSIT_MNEMONIC="${depositMnemonic}"`,
  `CENTRAL_PRIVATE_KEY=${central.privateKey}`,
  'CONFIRMATIONS=3',
  'POLL_INTERVAL_MS=12000',
  'GAS_CUSHION_MULTIPLIER=1.5',
  'AUTO_WITHDRAW_TEST=1',
  'RUN_MONITOR=1',
  'DB_PATH=./storage/exchange.sqlite'
].join('\n') + '\n';

const envPath = path.resolve(process.cwd(), '.env.test-generated');
if (fs.existsSync(envPath)) {
  console.error(`Refusing to overwrite ${envPath}. Rename or delete it first.`);
  process.exit(1);
}
fs.writeFileSync(envPath, env, { mode: 0o600, flag: 'wx' });
console.log('\nTEST-ONLY WALLET DETAILS\n');
console.log('Central wallet address:', central.address);
console.log('Central wallet private key:', central.privateKey);
console.log('Deposit HD wallet mnemonic:', depositMnemonic);
console.log('First derived deposit address (for reference):', firstDeposit.address);
console.log('\nA .env.test-generated file was also created. Copy its values into Render Environment settings.');
console.log('Do not upload this file to GitHub or share its secrets.');

const { HDNodeWallet, Wallet, getAddress } = require('ethers');
const crypto = require('crypto');
const db = require('./db');

/**
 * Derive an address from a mnemonic at a specific index (BIP-44 path).
 */
function deriveWallet(mnemonic, index) {
  const root = HDNodeWallet.fromPhrase(mnemonic, undefined, 'm');
  return root.derivePath(`m/44'/60'/0'/0/${index}`);
}

/**
 * Generate a cryptographically random derivation index in a safe range.
 * We avoid the very low indices and stay well under 2^31-1.
 * Max ~10 digits as requested.
 */
function randomIndex() {
  // 1 .. 2_000_000_000 (still well under BIP-44 limit of 2^31-1)
  const buf = crypto.randomBytes(4);
  const n = buf.readUInt32BE(0) % 1_999_999_999;
  return n + 1;
}

/**
 * Get a free random index for the given wallet type.
 * Retries a few times on collision.
 */
function allocateRandomIndex(walletType) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const index = randomIndex();
    const existing = db.prepare(
      'SELECT 1 FROM used_indices WHERE wallet_type = ? AND derivation_index = ?'
    ).get(walletType, index);
    if (!existing) return index;
  }
  // Extremely unlikely fallback
  throw new Error('Could not allocate a free derivation index after multiple attempts.');
}

/**
 * Create a temporary deposit address (anonymous flow).
 * Records the index so it can be recovered later.
 */
function createAnonymousDepositAddress(mnemonic, depositId) {
  const index = allocateRandomIndex('anonymous');
  const wallet = deriveWallet(mnemonic, index);
  const address = getAddress(wallet.address);

  db.prepare(`
    INSERT INTO used_indices (wallet_type, derivation_index, address, deposit_id)
    VALUES ('anonymous', ?, ?, ?)
  `).run(index, address, depositId);

  return { index, address, wallet };
}

/**
 * Assign a permanent address to a newly registered user.
 */
function assignPermanentAddress(mnemonic, userId) {
  const index = allocateRandomIndex('registered');
  const wallet = deriveWallet(mnemonic, index);
  const address = getAddress(wallet.address);

  db.prepare(`
    INSERT INTO used_indices (wallet_type, derivation_index, address, user_id)
    VALUES ('registered', ?, ?, ?)
  `).run(index, address, userId);

  return { index, address };
}

function centralWallet(privateKey, provider) {
  return new Wallet(privateKey, provider);
}

module.exports = {
  deriveWallet,
  createAnonymousDepositAddress,
  assignPermanentAddress,
  centralWallet,
  allocateRandomIndex
};

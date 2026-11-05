const { HDNodeWallet, Wallet } = require('ethers');
const { randomInt, randomUUID } = require('crypto');

const MAX_BIP32_INDEX = 2147483647;

function deriveWallet(mnemonic, index) {
  if (!Number.isInteger(index) || index < 1 || index > MAX_BIP32_INDEX) {
    throw new Error('Derivation index is outside the supported BIP-32 non-hardened range.');
  }
  const root = HDNodeWallet.fromPhrase(mnemonic, undefined, 'm');
  return root.derivePath(`m/44'/60'/0'/0/${index}`);
}

function randomDerivationIndex() {
  // crypto.randomInt uses a cryptographically secure random source; upper bound is exclusive.
  return randomInt(1, MAX_BIP32_INDEX + 1);
}

async function allocateWallet(client, { mnemonic, mnemonicGroup, walletRole, userId = null, requestId = null }) {
  // Retry only on an actual DB uniqueness collision. The database remains the authority.
  for (let attempt = 0; attempt < 30; attempt++) {
    const index = randomDerivationIndex();
    const wallet = deriveWallet(mnemonic, index);
    const id = randomUUID();
    try {
      const inserted = await client.query(
        `INSERT INTO wallet_registry
         (id,user_id,wallet_role,derivation_index,derivation_path,address,mnemonic_group)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT DO NOTHING
         RETURNING id, derivation_index, derivation_path, address`,
        [id, userId, walletRole, index, `m/44'/60'/0'/0/${index}`, wallet.address, mnemonicGroup]
      );
      if (!inserted.rows[0]) continue;
      await client.query(
        `INSERT INTO wallet_index_history(wallet_role,mnemonic_group,derivation_index,address,request_id,user_id,event)
         VALUES($1,$2,$3,$4,$5,$6,'assigned')`,
        [walletRole, mnemonicGroup, index, wallet.address, requestId, userId]
      );
      return { ...inserted.rows[0], privateKey: wallet.privateKey };
    } catch (err) {
      if (err.code === '23505') continue;
      throw err;
    }
  }
  throw new Error('Could not allocate a unique random wallet index after 30 attempts.');
}

module.exports = { deriveWallet, randomDerivationIndex, allocateWallet, MAX_BIP32_INDEX };

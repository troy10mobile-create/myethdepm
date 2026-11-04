const { HDNodeWallet, Wallet } = require('ethers');
function deriveDepositWallet(mnemonic, index) {
  const root = HDNodeWallet.fromPhrase(mnemonic, undefined, 'm');
  return root.derivePath(`m/44'/60'/0'/0/${index}`);
}
function centralWallet(privateKey, provider) { return new Wallet(privateKey, provider); }
module.exports = { deriveDepositWallet, centralWallet };

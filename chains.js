/**
 * Multi-EVM chain configuration.
 * Currently ONLY Sepolia is active.
 * Other chains are prepared so we can turn them on later without rewriting core logic.
 */

const CHAINS = {
  sepolia: {
    id: 11155111,
    name: 'Sepolia',
    shortName: 'sep',
    nativeCurrency: { name: 'Sepolia ETH', symbol: 'ETH', decimals: 18 },
    rpcUrl: process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com',
    explorer: 'https://sepolia.etherscan.io',
    isTestnet: true,
    active: true,          // ← only this one is enabled right now
    supportsErc20: false   // ERC-20 support prepared but off for now
  },

  // --- Prepared but inactive ---
  holesky: {
    id: 17000,
    name: 'Holesky',
    shortName: 'hol',
    nativeCurrency: { name: 'Holesky ETH', symbol: 'ETH', decimals: 18 },
    rpcUrl: process.env.HOLESKY_RPC_URL || '',
    explorer: 'https://holesky.etherscan.io',
    isTestnet: true,
    active: false,
    supportsErc20: false
  },
  baseSepolia: {
    id: 84532,
    name: 'Base Sepolia',
    shortName: 'base-sep',
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || '',
    explorer: 'https://sepolia.basescan.org',
    isTestnet: true,
    active: false,
    supportsErc20: false
  },
  arbSepolia: {
    id: 421614,
    name: 'Arbitrum Sepolia',
    shortName: 'arb-sep',
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrl: process.env.ARB_SEPOLIA_RPC_URL || '',
    explorer: 'https://sepolia.arbiscan.io',
    isTestnet: true,
    active: false,
    supportsErc20: false
  },
  opSepolia: {
    id: 11155420,
    name: 'Optimism Sepolia',
    shortName: 'op-sep',
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrl: process.env.OP_SEPOLIA_RPC_URL || '',
    explorer: 'https://sepolia-optimism.etherscan.io',
    isTestnet: true,
    active: false,
    supportsErc20: false
  }
};

function getActiveChain() {
  const active = Object.values(CHAINS).find(c => c.active);
  if (!active) throw new Error('No active chain configured');
  return active;
}

function getChain(chainKey) {
  return CHAINS[chainKey] || null;
}

module.exports = { CHAINS, getActiveChain, getChain };

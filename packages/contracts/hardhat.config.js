require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-network-helpers");
require("solidity-coverage");

// The .env lives at the repo root, but hardhat runs with this package as the
// working directory, so a bare dotenv.config() silently finds nothing and every
// live network ends up with no signer. Resolve it explicitly.
require("dotenv").config({ path: require("path").join(__dirname, "..", "..", ".env") });

const {
  DEPLOYER_KEY,
  ARBITRUM_SEPOLIA_RPC,
  ROBINHOOD_RPC,
  ROBINHOOD_TESTNET_RPC,
  TARGET_RPC,
  TARGET_CHAIN_ID,
} = process.env;

const accounts = DEPLOYER_KEY ? [DEPLOYER_KEY] : [];

/**
 * Hesoyam.
 *
 * evmVersion is pinned to "paris" because Arbitrum Orbit chains have historically
 * lagged on PUSH0 and MCOPY. OpenZeppelin is pinned to 5.0.2 for the same reason.
 * Confirm the target chain's ArbOS version before bumping either one, and bump both
 * together or not at all.
 */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "paris",
    },
  },
  networks: {
    hardhat: {
      allowUnlimitedContractSize: false,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
    arbitrumSepolia: {
      url: ARBITRUM_SEPOLIA_RPC || "https://sepolia-rollup.arbitrum.io/rpc",
      chainId: 421614,
      accounts,
    },
    // Robinhood Chain. Arbitrum Orbit, ETH for gas, ArbOS well past the Cancun
    // threshold, so the paris pin here is conservative and deploys fine.
    // The public RPCs are rate limited, so set ROBINHOOD_RPC to an Alchemy key
    // for anything beyond a one off deploy.
    robinhoodTestnet: {
      url: ROBINHOOD_TESTNET_RPC || "https://rpc.testnet.chain.robinhood.com",
      chainId: 46630,
      accounts,
    },
    robinhood: {
      url: ROBINHOOD_RPC || "https://rpc.mainnet.chain.robinhood.com",
      chainId: 4663,
      accounts,
    },

    // Escape hatch for any other chain, driven entirely from .env.
    target: {
      url: TARGET_RPC || "http://127.0.0.1:8545",
      chainId: TARGET_CHAIN_ID ? Number(TARGET_CHAIN_ID) : 31337,
      accounts,
    },
  },
  mocha: { timeout: 120000 },
};

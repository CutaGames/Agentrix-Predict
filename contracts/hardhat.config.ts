import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "0x" + "0".repeat(64);
const BSC_TESTNET_RPC = process.env.BSC_TESTNET_RPC_URL || "https://bsc-testnet.publicnode.com";
const BSCSCAN_API_KEY = process.env.BSCSCAN_API_KEY || "";
// Injective EVM (MultiVM). Testnet chainId 1439, Mainnet 1776. Set the real RPC via env.
const INJECTIVE_EVM_TESTNET_RPC = process.env.INJECTIVE_EVM_TESTNET_RPC_URL || "";
const INJECTIVE_EVM_MAINNET_RPC = process.env.INJECTIVE_EVM_MAINNET_RPC_URL || "";
const hasDeployer = DEPLOYER_PRIVATE_KEY !== "0x" + "0".repeat(64);

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
      evmVersion: "paris",
    },
  },
  networks: {
    hardhat: {
      chainId: 97, // mirror BSC Testnet for local testing
    },
    bscTestnet: {
      url: BSC_TESTNET_RPC,
      chainId: 97,
      accounts: DEPLOYER_PRIVATE_KEY !== "0x" + "0".repeat(64) ? [DEPLOYER_PRIVATE_KEY] : [],
      gasPrice: 10_000_000_000, // 10 gwei
    },
    bscMainnet: {
      url: process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org",
      chainId: 56,
      accounts: DEPLOYER_PRIVATE_KEY !== "0x" + "0".repeat(64) ? [DEPLOYER_PRIVATE_KEY] : [],
    },
    injectiveEvmTestnet: {
      url: INJECTIVE_EVM_TESTNET_RPC,
      chainId: 1439,
      accounts: hasDeployer ? [DEPLOYER_PRIVATE_KEY] : [],
      gasPrice: 200_000_000, // Injective EVM min ~0.16 gwei; use 0.2 gwei buffer
    },
    injectiveEvmMainnet: {
      url: INJECTIVE_EVM_MAINNET_RPC,
      chainId: 1776,
      accounts: hasDeployer ? [DEPLOYER_PRIVATE_KEY] : [],
      gasPrice: 200_000_000,
    },
  },
  etherscan: {
    apiKey: {
      bscTestnet: BSCSCAN_API_KEY,
      bsc: BSCSCAN_API_KEY,
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
  },
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },
};

export default config;

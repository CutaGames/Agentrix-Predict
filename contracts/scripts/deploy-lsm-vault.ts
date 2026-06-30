/**
 * Phase A 部署脚本 — LSM 链上稳定币结算平台。
 *
 * 部署 MockUSDC（仅测试网）+ CollateralVault，创建公共金库并由官方注入初始 bankroll。
 *
 * 用法（Injective EVM testnet, chainId 1439）：
 *   DEPLOYER_PRIVATE_KEY=0x... INJECTIVE_EVM_TESTNET_RPC_URL=https://... \
 *   RELAYER_ADDRESS=0x... \
 *   npx hardhat run scripts/deploy-lsm-vault.ts --network injectiveEvmTestnet
 *
 * 主网（Phase E）：不部署 MockUSDC，改用 USDC_ADDRESS 指向 Circle 原生 USDC。
 */
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// USDC 6 位小数；内部最小单位 0.01 USDC = 1e4 base unit。
const UNIT_SCALE = 10_000n;
const PUBLIC_VAULT_ID = ethers.id("lsm:public-vault:v1");
const PUBLIC_VAULT_PROFIT_SHARE_BPS = 1000; // 10%
// 官方初始注入（内部单位）；0.01 USDC/单位 → 100_000 单位 = 1000 USDC。
const SEED_INTERNAL_UNITS = 100_000n;

async function main() {
  const [deployer] = await ethers.getSigners();
  const relayer = process.env.RELAYER_ADDRESS || deployer.address;
  console.log(`Network: ${network.name}  Deployer: ${deployer.address}  Relayer: ${relayer}`);

  // 1) USDC：测试网部署 MockUSDC；否则用环境提供的 USDC_ADDRESS。
  let usdcAddress = process.env.USDC_ADDRESS || "";
  const isTestnet = network.name !== "injectiveEvmMainnet" && network.name !== "bscMainnet";
  if (!usdcAddress) {
    if (!isTestnet) throw new Error("Mainnet requires USDC_ADDRESS (Circle native USDC)");
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();
    usdcAddress = await usdc.getAddress();
    console.log(`MockUSDC deployed: ${usdcAddress}`);
  }

  // 2) CollateralVault
  const Vault = await ethers.getContractFactory("CollateralVault");
  const vault = await Vault.deploy(usdcAddress, UNIT_SCALE, relayer);
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();
  console.log(`CollateralVault deployed: ${vaultAddress}`);

  // 3) 创建公共金库
  await (await vault.createVault(PUBLIC_VAULT_ID, PUBLIC_VAULT_PROFIT_SHARE_BPS)).wait();
  console.log(`Public vault created: ${PUBLIC_VAULT_ID}`);

  // 4) 官方注入初始 bankroll（仅测试网自动 mint+seed；主网需国库持真实 USDC 手动注入）
  if (isTestnet && process.env.USDC_ADDRESS === undefined) {
    const usdc = await ethers.getContractAt("MockUSDC", usdcAddress);
    const seedBase = SEED_INTERNAL_UNITS * UNIT_SCALE;
    await (await usdc.mint(deployer.address, seedBase)).wait();
    await (await usdc.approve(vaultAddress, seedBase)).wait();
    await (await vault.deposit(seedBase)).wait();
    await (await vault.depositLiquidity(PUBLIC_VAULT_ID, SEED_INTERNAL_UNITS)).wait();
    console.log(`Seeded public vault bankroll: ${SEED_INTERNAL_UNITS} units (${seedBase} base)`);
  }

  // 5) 写部署清单
  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    relayer,
    deployedAt: new Date().toISOString(),
    unitScale: UNIT_SCALE.toString(),
    contracts: {
      USDC: { address: usdcAddress, decimals: 6, mock: process.env.USDC_ADDRESS === undefined && isTestnet },
      CollateralVault: { address: vaultAddress },
    },
    publicVault: { id: PUBLIC_VAULT_ID, profitShareBps: PUBLIC_VAULT_PROFIT_SHARE_BPS },
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `lsm.${network.name}.${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`Deployment written: ${file}`);
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

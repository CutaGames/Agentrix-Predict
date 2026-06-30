/**
 * Seed testnet USDC liquidity (Injective EVM testnet):
 *   - mint 20,000,000 USDC to the deployer/treasury
 *   - deposit 10,000,000 USDC into the on-chain CollateralVault public vault
 *     (deposit -> depositLiquidity, so vault bankroll = 10M USDC, properly accounted)
 *   - leaves 10,000,000 USDC in the deployer wallet to distribute to test users
 *
 * Usage:
 *   npx hardhat run scripts/seed-usdc.ts --network injectiveEvmTestnet
 *
 * testnet-only. Amounts overridable via env VAULT_USDC / WALLET_USDC.
 */
import { ethers, network } from "hardhat";

const USDC = process.env.USDC_ADDRESS || "0x9fcF02d8f706BAbc690a860F89b93b9801c8F28D";
const VAULT = process.env.VAULT_ADDRESS || "0x760ee31334EA03c2e47900eb3c419C232b4375C0";
const PUBLIC_VAULT_ID = ethers.id("lsm:public-vault:v1");
const UNIT_SCALE = 10_000n; // 1 internal unit = 0.01 USDC (6-dec base)

async function main() {
  const [signer] = await ethers.getSigners();
  const vaultUsdc = BigInt(process.env.VAULT_USDC || "10000000");   // 10M into vault
  const walletUsdc = BigInt(process.env.WALLET_USDC || "10000000"); // 10M kept in wallet
  const usdc = await ethers.getContractAt("MockUSDC", USDC);
  const vault = await ethers.getContractAt("CollateralVault", VAULT);
  const dec = Number(await usdc.decimals());
  const f = (x: bigint) => ethers.formatUnits(x, dec);

  const vaultBase = vaultUsdc * 10n ** BigInt(dec);
  const walletBase = walletUsdc * 10n ** BigInt(dec);
  const mintBase = vaultBase + walletBase;

  console.log(`Network ${network.name}  signer ${signer.address}`);
  console.log(`Minting ${(vaultUsdc + walletUsdc).toString()} USDC (vault ${vaultUsdc} + wallet ${walletUsdc})...`);
  await (await usdc.mint(signer.address, mintBase)).wait();

  console.log(`Approving + depositing ${vaultUsdc} USDC into CollateralVault...`);
  await (await usdc.approve(VAULT, vaultBase)).wait();
  await (await vault.deposit(vaultBase)).wait();

  const internalUnits = vaultBase / UNIT_SCALE; // collateral credited in internal units
  console.log(`depositLiquidity ${internalUnits} units into public vault...`);
  await (await vault.depositLiquidity(PUBLIC_VAULT_ID, internalUnits)).wait();

  // Report
  const total = await usdc.totalSupply();
  const walletBal = await usdc.balanceOf(signer.address);
  const vaultBal = await usdc.balanceOf(VAULT);
  const v = await vault.vaults(PUBLIC_VAULT_ID);
  console.log(`✅ done.`);
  console.log(`   totalSupply       = ${f(total)} USDC`);
  console.log(`   deployer wallet   = ${f(walletBal)} USDC`);
  console.log(`   vault USDC balance= ${f(vaultBal)} USDC`);
  console.log(`   public vault bankroll(internal units) = ${v.bankroll.toString()} (= ${Number(v.bankroll) * 0.01} USDC)`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

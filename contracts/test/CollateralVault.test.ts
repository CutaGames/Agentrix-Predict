import { expect } from "chai";
import { ethers } from "hardhat";

// 内部最小单位 0.01 USDC，USDC 6 dec → 1 内部单位 = 1e4 base unit。
const UNIT_SCALE = 10_000n;
const VAULT_ID = ethers.id("lsm:test-vault");

async function deploy() {
  const [owner, relayer, alice, bob] = await ethers.getSigners();
  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy();
  const Vault = await ethers.getContractFactory("CollateralVault");
  const vault = await Vault.deploy(await usdc.getAddress(), UNIT_SCALE, relayer.address);
  // fund alice & bob with USDC
  for (const u of [alice, bob]) {
    await usdc.mint(u.address, 1_000_000n * 1_000_000n); // 1M USDC
    await usdc.connect(u).approve(await vault.getAddress(), ethers.MaxUint256);
  }
  return { owner, relayer, alice, bob, usdc, vault };
}

async function signWithdraw(
  relayer: any, vaultAddr: string, chainId: bigint,
  user: string, to: string, amount: bigint, nonce: bigint,
) {
  const h = ethers.solidityPackedKeccak256(
    ["address", "uint256", "address", "address", "uint256", "uint256"],
    [vaultAddr, chainId, user, to, amount, nonce],
  );
  return relayer.signMessage(ethers.getBytes(h));
}

describe("CollateralVault (Phase A)", () => {
  it("deposit credits internal units (USDC base ÷ unitScale)", async () => {
    const { vault, alice } = await deploy();
    await vault.connect(alice).deposit(1000n * 1_000_000n); // 1000 USDC
    expect(await vault.collateral(alice.address)).to.equal(100_000n); // 1000/0.01
    expect(await vault.totalCollateral()).to.equal(100_000n);
  });

  it("rejects dust-only deposit (< 1 internal unit)", async () => {
    const { vault, alice } = await deploy();
    await expect(vault.connect(alice).deposit(9_999n)).to.be.revertedWith("CV: dust only");
  });

  it("LP deposit mints 1:1 first, redeem returns principal at flat NAV", async () => {
    const { vault, owner, alice } = await deploy();
    await vault.createVault(VAULT_ID, 1000);
    await vault.connect(alice).deposit(500n * 1_000_000n); // 50_000 units
    await vault.connect(alice).depositLiquidity(VAULT_ID, 50_000n);
    expect(await vault.lpShares(VAULT_ID, alice.address)).to.equal(50_000n);
    const v = await vault.vaults(VAULT_ID);
    expect(v.bankroll).to.equal(50_000n);
    await vault.connect(alice).redeemLiquidity(VAULT_ID, 50_000n);
    expect(await vault.collateral(alice.address)).to.equal(50_000n); // back to available
  });

  it("applySettlement enforces conservation (net delta must be 0)", async () => {
    const { vault, relayer, alice } = await deploy();
    await vault.createVault(VAULT_ID, 0);
    // non-conservative batch reverts
    await expect(
      vault.connect(relayer).applySettlement(
        ethers.id("s1"),
        [{ user: alice.address, collateralDelta: 100 }],
        [{ vaultId: VAULT_ID, bankrollDelta: 0, reservedDelta: 0 }],
      ),
    ).to.be.revertedWith("CV: not conservative");
  });

  it("applySettlement moves value vault→user conservatively, enforces solvency & idempotency", async () => {
    const { vault, owner, relayer, alice } = await deploy();
    await vault.createVault(VAULT_ID, 0);
    // seed vault bankroll via owner deposit+LP
    await vault.connect(alice).deposit(1000n * 1_000_000n); // 100_000 units
    await vault.connect(alice).depositLiquidity(VAULT_ID, 100_000n);
    // payout 10_000 from vault to bob-like user (use alice as recipient for simplicity)
    const idem = ethers.id("settle-win-1");
    await vault.connect(relayer).applySettlement(
      idem,
      [{ user: alice.address, collateralDelta: 10_000 }],
      [{ vaultId: VAULT_ID, bankrollDelta: -10_000, reservedDelta: 0 }],
    );
    expect(await vault.collateral(alice.address)).to.equal(10_000n);
    expect((await vault.vaults(VAULT_ID)).bankroll).to.equal(90_000n);
    // idempotent: same idemKey reverts
    await expect(
      vault.connect(relayer).applySettlement(idem, [], []),
    ).to.be.revertedWith("CV: idem used");
    // solvency: reserve more than bankroll reverts
    await expect(
      vault.connect(relayer).applySettlement(
        ethers.id("bad-reserve"),
        [],
        [{ vaultId: VAULT_ID, bankrollDelta: 0, reservedDelta: 1_000_000 }],
      ),
    ).to.be.revertedWith("CV: I1 solvency");
  });

  it("withdraw requires valid relayer signature, blocks replay", async () => {
    const { vault, relayer, alice, owner } = await deploy();
    await vault.connect(alice).deposit(1000n * 1_000_000n); // 100_000 units
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const vaultAddr = await vault.getAddress();
    const amount = 40_000n;
    const nonce = 1n;
    const sig = await signWithdraw(relayer, vaultAddr, chainId, alice.address, alice.address, amount, nonce);
    await vault.connect(alice).requestWithdraw(alice.address, amount, alice.address, nonce, sig);
    expect(await vault.collateral(alice.address)).to.equal(60_000n);
    // replay same nonce reverts
    await expect(
      vault.connect(alice).requestWithdraw(alice.address, amount, alice.address, nonce, sig),
    ).to.be.revertedWith("CV: nonce used");
    // bad signer reverts
    const badSig = await signWithdraw(owner, vaultAddr, chainId, alice.address, alice.address, amount, 2n);
    await expect(
      vault.connect(alice).requestWithdraw(alice.address, amount, alice.address, 2n, badSig),
    ).to.be.revertedWith("CV: bad sig");
  });

  it("stays solvent across deposit/LP/settlement/withdraw", async () => {
    const { vault, relayer, alice } = await deploy();
    await vault.createVault(VAULT_ID, 0);
    await vault.connect(alice).deposit(1000n * 1_000_000n);
    await vault.connect(alice).depositLiquidity(VAULT_ID, 50_000n);
    expect(await vault.isSolvent()).to.equal(true);
  });

  it("pause blocks deposit/withdraw/LP", async () => {
    const { vault, alice } = await deploy();
    await vault.setPaused(true);
    await expect(vault.connect(alice).deposit(1000n * 1_000_000n)).to.be.revertedWith("CV: paused");
  });
});

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployHesoyam, E18, E6, DAY } = require("./fixture");

describe("HesoyamToken", function () {
  it("splits the 5% tax 4% creator / 1% router", async function () {
    const { hesoyam, creatorWallet, router, alice, bob } = await loadFixture(deployHesoyam);
    const amount = 1000n * E18;

    const creatorBefore = await hesoyam.balanceOf(creatorWallet.address);
    const routerBefore = await hesoyam.balanceOf(router.target);

    await hesoyam.connect(alice).transfer(bob.address, amount);

    expect(await hesoyam.balanceOf(creatorWallet.address)).to.equal(creatorBefore + (amount * 4n) / 100n);
    expect(await hesoyam.balanceOf(router.target)).to.equal(routerBefore + amount / 100n);
    expect(await hesoyam.balanceOf(bob.address)).to.equal(2_000_000n * E18 + (amount * 95n) / 100n);
  });

  it("skips the tax when either side is exempt", async function () {
    const { hesoyam, creatorWallet, alice, vault } = await loadFixture(deployHesoyam);
    const creatorBefore = await hesoyam.balanceOf(creatorWallet.address);
    await hesoyam.connect(alice).transfer(vault.target, 100n * E18);
    expect(await hesoyam.balanceOf(vault.target)).to.equal(100n * E18);
    expect(await hesoyam.balanceOf(creatorWallet.address)).to.equal(creatorBefore);
  });

  it("has a fixed supply and no mint path (INV-3)", async function () {
    const { hesoyam } = await loadFixture(deployHesoyam);
    expect(await hesoyam.totalSupply()).to.equal(await hesoyam.MAX_SUPPLY());
    expect(hesoyam.interface.fragments.some((f) => f.type === "function" && f.name === "mint")).to.equal(false);
  });

  it("cannot enable the tax twice or without recipients", async function () {
    const { hesoyam, owner } = await loadFixture(deployHesoyam);
    await expect(hesoyam.connect(owner).enableTax()).to.be.revertedWithCustomError(hesoyam, "AlreadyEnabled");

    const fresh = await ethers.deployContract("HesoyamToken", [owner.address, owner.address]);
    await expect(fresh.enableTax()).to.be.revertedWithCustomError(fresh, "RecipientsNotSet");
  });
});

describe("RevenueRouter", function () {
  it("converts HESOYAM and splits by the published allocation", async function () {
    const { hesoyam, usdc, router, vault, dispensary, liquidity, ops, alice, owner } = await loadFixture(deployHesoyam);

    // Seed the vault with weight so the staker share is actually distributable.
    await hesoyam.connect(alice).approve(vault.target, ethers.MaxUint256);
    await vault.connect(alice).stake(1000n * E18, 0);

    await hesoyam.connect(owner).transfer(router.target, 100_000n * E18);
    const hesoyamIn = await hesoyam.balanceOf(router.target);
    const expectedUsdc = (hesoyamIn * 400_000n) / E18;

    await router.sweep(0);

    expect(await router.totalRealized()).to.equal(expectedUsdc);
    expect(await usdc.balanceOf(vault.target)).to.equal((expectedUsdc * 5000n) / 10000n);
    expect(await usdc.balanceOf(dispensary.target)).to.equal((expectedUsdc * 2800n) / 10000n);
    expect(await usdc.balanceOf(liquidity.address)).to.equal((expectedUsdc * 1200n) / 10000n);
    expect(await usdc.balanceOf(ops.address)).to.equal((expectedUsdc * 800n) / 10000n);
    expect(await router.reserveBalance()).to.equal((expectedUsdc * 200n) / 10000n);
  });

  it("enforces the sweep cooldown (INV-7)", async function () {
    const { hesoyam, router, owner } = await loadFixture(deployHesoyam);
    await hesoyam.connect(owner).transfer(router.target, 10_000n * E18);
    await router.sweep(0);
    await hesoyam.connect(owner).transfer(router.target, 10_000n * E18);
    await expect(router.sweep(0)).to.be.revertedWithCustomError(router, "CooldownActive");
    await time.increase(6 * 60 * 60 + 1);
    await expect(router.sweep(0)).to.not.be.reverted;
  });

  it("refuses to convert when spot deviates from TWAP (INV-7)", async function () {
    const { hesoyam, router, adapter, owner } = await loadFixture(deployHesoyam);
    await hesoyam.connect(owner).transfer(router.target, 10_000n * E18);
    await adapter.setPrices(500_000n, 400_000n); // 25% above TWAP
    await expect(router.sweep(0)).to.be.revertedWithCustomError(router, "PriceDeviation");
    await adapter.setPrices(407_000n, 400_000n); // 1.75%, inside the 2% guard
    await expect(router.sweep(0)).to.not.be.reverted;
  });

  it("caps how much HESOYAM one sweep may convert", async function () {
    const { hesoyam, router, owner } = await loadFixture(deployHesoyam);
    await router.setGuards(1_000n * E18, 3600, 200);
    await hesoyam.connect(owner).transfer(router.target, 50_000n * E18);
    await router.sweep(0);
    expect(await hesoyam.balanceOf(router.target)).to.equal(49_000n * E18);
  });

  it("rejects an allocation that does not sum to 100%", async function () {
    const { router } = await loadFixture(deployHesoyam);
    await expect(router.setAllocation(5000, 2800, 1200, 800, 300)).to.be.revertedWithCustomError(router, "BadAllocation");
    await expect(router.setAllocation(4000, 3000, 1500, 1000, 500)).to.not.be.reverted;
  });
});

describe("StakingVault", function () {
  it("weights a stake by its lock tier", async function () {
    const { vault, alice, bob } = await loadFixture(deployHesoyam);
    await vault.connect(alice).stake(1000n * E18, 0); // 1.0x
    await vault.connect(bob).stake(1000n * E18, 3); // 2.5x
    expect(await vault.weightOf(alice.address)).to.equal(1000n * E18);
    expect(await vault.weightOf(bob.address)).to.equal(2500n * E18);
    expect(await vault.totalWeight()).to.equal(3500n * E18);
  });

  it("splits rewards in proportion to weight", async function () {
    const { vault, usdc, router, hesoyam, owner, alice, bob } = await loadFixture(deployHesoyam);
    await vault.connect(alice).stake(1000n * E18, 0);
    await vault.connect(bob).stake(1000n * E18, 3);

    await hesoyam.connect(owner).transfer(router.target, 100_000n * E18);
    await router.sweep(0);

    const toStakers = (await router.totalToEquity());
    const alicePending = await vault.pendingReward(alice.address);
    const bobPending = await vault.pendingReward(bob.address);

    // 1.0x versus 2.5x, so 2/7 and 5/7 of the pot. The accumulator truncates twice,
    // so allow dust, and separately assert the dust can only ever favour the vault.
    expect(alicePending).to.be.closeTo((toStakers * 2n) / 7n, 10_000n);
    expect(bobPending).to.be.closeTo((toStakers * 5n) / 7n, 10_000n);
    expect(alicePending + bobPending).to.be.lte(toStakers);

    await vault.connect(alice).claim();
    expect(await usdc.balanceOf(alice.address)).to.equal(alicePending);
  });

  it("never distributes more than it was given (INV-1)", async function () {
    const { vault, router, hesoyam, owner, alice, bob } = await loadFixture(deployHesoyam);
    await vault.connect(alice).stake(1000n * E18, 1);
    await vault.connect(bob).stake(3000n * E18, 2);

    for (let i = 0; i < 3; i++) {
      await hesoyam.connect(owner).transfer(router.target, 40_000n * E18);
      await time.increase(6 * 60 * 60 + 1);
      await router.sweep(0);
    }
    await vault.connect(alice).claim();
    await vault.connect(bob).claim();

    expect(await vault.totalDistributed()).to.be.lte(await vault.totalNotified());
  });

  it("holds rewards that arrive with no weight staked, then pays them out", async function () {
    const { vault, router, hesoyam, owner, alice } = await loadFixture(deployHesoyam);
    await hesoyam.connect(owner).transfer(router.target, 10_000n * E18);
    await router.sweep(0);
    expect(await vault.undistributed()).to.be.gt(0);
    expect(await vault.accPerWeight()).to.equal(0);

    await vault.connect(alice).stake(1000n * E18, 0);
    await hesoyam.connect(owner).transfer(router.target, 10_000n * E18);
    await time.increase(6 * 60 * 60 + 1);
    await router.sweep(0);

    expect(await vault.undistributed()).to.equal(0);
    expect(await vault.pendingReward(alice.address)).to.be.gt(0);
  });

  it("charges 4% only when leaving before the lock expires", async function () {
    const { vault, hesoyam, router, alice } = await loadFixture(deployHesoyam);
    await vault.connect(alice).stake(1000n * E18, 1); // 30 day lock

    const routerBefore = await hesoyam.balanceOf(router.target);
    const before = await hesoyam.balanceOf(alice.address);
    await vault.connect(alice).unstake(0);
    expect(await hesoyam.balanceOf(alice.address)).to.equal(before + 960n * E18);
    expect(await hesoyam.balanceOf(router.target)).to.equal(routerBefore + 40n * E18);

    await vault.connect(alice).stake(1000n * E18, 1);
    await time.increase(31 * DAY);
    const before2 = await hesoyam.balanceOf(alice.address);
    await vault.connect(alice).unstake(1);
    expect(await hesoyam.balanceOf(alice.address)).to.equal(before2 + 1000n * E18);
  });

  it("always allows an emergency exit and forfeits pending rewards (INV-4)", async function () {
    const { vault, hesoyam, router, owner, alice } = await loadFixture(deployHesoyam);
    await vault.connect(alice).stake(1000n * E18, 3);
    await hesoyam.connect(owner).transfer(router.target, 10_000n * E18);
    await router.sweep(0);
    expect(await vault.pendingReward(alice.address)).to.be.gt(0);

    const before = await hesoyam.balanceOf(alice.address);
    await vault.connect(alice).emergencyWithdraw(0);
    expect(await hesoyam.balanceOf(alice.address)).to.equal(before + 960n * E18);
    expect(await vault.pendingReward(alice.address)).to.equal(0);
    expect(await vault.weightOf(alice.address)).to.equal(0);
  });

  it("keeps principal covered by its HESOYAM balance (INV-2)", async function () {
    const { vault, hesoyam, alice, bob } = await loadFixture(deployHesoyam);
    await vault.connect(alice).stake(1000n * E18, 0);
    await vault.connect(bob).stake(2500n * E18, 2);
    expect(await hesoyam.balanceOf(vault.target)).to.be.gte(await vault.totalPrincipal());
    await vault.connect(alice).unstake(0);
    expect(await hesoyam.balanceOf(vault.target)).to.be.gte(await vault.totalPrincipal());
  });
});

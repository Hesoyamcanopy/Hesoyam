const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time, mine } = require("@nomicfoundation/hardhat-network-helpers");
const { deployHesoyam, commitFor, randomSalt, buyBench, DAY, E18, revealNext } = require("./fixture");

/**
 * Property tests. A randomized sequence of user actions runs against the live system
 * and every invariant from the blueprint is re-checked after each step. A single
 * violation fails the run and prints the action that caused it.
 */

const MAX_CARD_BONUS_BPS = 4200n;

async function checkInvariants(ctx, users, label) {
  const { hesoyam, usdc, vault, dispensary, router, flower } = ctx;

  // INV-1  Rewards paid never exceed rewards received.
  expect(await vault.totalDistributed(), `${label} INV-1`).to.be.lte(await vault.totalNotified());

  // INV-2  Staked principal is always covered by the HESOYAM actually held.
  expect(await hesoyam.balanceOf(vault.target), `${label} INV-2`).to.be.gte(await vault.totalPrincipal());

  // INV-3  Supply never changes.
  expect(await hesoyam.totalSupply(), `${label} INV-3`).to.equal(await hesoyam.MAX_SUPPLY());

  // INV-9  The Dispensary cannot outspend its funding.
  expect(await dispensary.totalSpent(), `${label} INV-9`).to.be.lte(await dispensary.totalFunded());

  // Reward solvency: every unclaimed reward is backed by settlement tokens on hand.
  let pendingSum = 0n;
  let weightSum = 0n;
  for (const u of users) {
    pendingSum += await vault.pendingReward(u.address);
    weightSum += await vault.weightOf(u.address);

    // INV-13  Card weight is capped per wallet.
    expect(await vault.cardBonusBps(u.address), `${label} INV-13`).to.be.lte(MAX_CARD_BONUS_BPS);
    const base = await vault.baseWeight(u.address);
    expect(await vault.weightOf(u.address), `${label} weight formula`)
      .to.equal((base * (10_000n + (await vault.cardBonusBps(u.address)))) / 10_000n);
  }
  expect(await usdc.balanceOf(vault.target), `${label} reward solvency`).to.be.gte(pendingSum);

  // Aggregate weight equals the sum of its parts.
  expect(await vault.totalWeight(), `${label} totalWeight`).to.equal(weightSum);

  // The router never keeps more reserve than it holds.
  expect(await usdc.balanceOf(router.target), `${label} reserve`).to.be.gte(await router.reserveBalance());

  // Flower supply accounting is consistent.
  for (let id = 0; id < 16; id++) {
    const minted = await flower.totalMinted(id);
    const burned = await flower.totalBurned(id);
    expect(burned, `${label} flower id ${id}`).to.be.lte(minted);
  }
}

describe("Invariants", function () {
  it("holds across a randomized sequence of staking and revenue actions", async function () {
    const ctx = await loadFixture(deployHesoyam);
    const users = [ctx.alice, ctx.bob, ctx.carol];
    let seed = 1234567n;
    const rand = (n) => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) % (2n ** 64n);
      return Number(seed % BigInt(n));
    };

    await checkInvariants(ctx, users, "start");

    for (let step = 0; step < 60; step++) {
      const user = users[rand(users.length)];
      const action = rand(6);

      try {
        if (action === 0) {
          await ctx.vault.connect(user).stake(BigInt(rand(5000) + 1) * E18, rand(4));
        } else if (action === 1) {
          const count = await ctx.vault.positionCount(user.address);
          if (count > 0n) {
            const idx = rand(Number(count));
            const pos = await ctx.vault.positions(user.address, idx);
            if (!pos.closed) await ctx.vault.connect(user).unstake(idx);
          }
        } else if (action === 2) {
          const count = await ctx.vault.positionCount(user.address);
          if (count > 0n) {
            const idx = rand(Number(count));
            const pos = await ctx.vault.positions(user.address, idx);
            if (!pos.closed) await ctx.vault.connect(user).emergencyWithdraw(idx);
          }
        } else if (action === 3) {
          if ((await ctx.vault.pendingReward(user.address)) > 0n) await ctx.vault.connect(user).claim();
        } else if (action === 4) {
          await ctx.hesoyam.connect(ctx.owner).transfer(ctx.router.target, BigInt(rand(50_000) + 1) * E18);
          await time.increase(6 * 60 * 60 + 1);
          await ctx.router.sweep(0);
        } else {
          await time.increase(rand(5 * DAY) + 1);
        }
      } catch (err) {
        // Reverts are legitimate outcomes for a randomized caller. What must never
        // happen is a broken invariant, which is checked either way.
        if (!/reverted|VM Exception/i.test(err.message)) throw err;
      }

      await checkInvariants(ctx, users, `step ${step} action ${action}`);
    }
  });

  it("holds across a full grow, sell, craft and stake cycle", async function () {
    const ctx = await loadFixture(deployHesoyam);
    const users = [ctx.alice, ctx.bob, ctx.carol];

    await ctx.strains.addStrain("Invariant Kush", 2 * DAY, 3000, 10_000, 0, 0, 5n * E18);
    const strainId = 3;

    // Alice grows a large harvest.
    const benchId = await buyBench(ctx, ctx.alice, 1);
    const salt = randomSalt();
    await ctx.game.connect(ctx.alice).plant(strainId, benchId, commitFor(salt));
    await revealNext(ctx);
    const plantedAt = await time.latest();
    await time.increaseTo(plantedAt + 2 * DAY + 1);
    await ctx.game.connect(ctx.alice).harvest(1, salt, false);
    await checkInvariants(ctx, users, "after harvest");

    let tier = -1;
    let tokenId = 0n;
    for (let t = 0; t < 3; t++) {
      const id = BigInt(strainId) * 4n + BigInt(t);
      if ((await ctx.flower.balanceOf(ctx.alice.address, id)) > 0n) {
        tier = t;
        tokenId = id;
      }
    }
    expect(tier).to.be.gte(0);

    // Bob buys some on the open market.
    const held = await ctx.flower.balanceOf(ctx.alice.address, tokenId);
    await ctx.market.connect(ctx.alice).list(tokenId, held, 2n * E18);
    await ctx.market.connect(ctx.bob).buy(1, 400n);
    await checkInvariants(ctx, users, "after market fill");

    // Bob burns it into a card and equips it, which raises his weight.
    await ctx.crafter.connect(ctx.bob).requestCraft(strainId, tier);
    await mine(3);
    await ctx.crafter.finalizeCraft(1);
    const cardId = 1n;

    await ctx.vault.connect(ctx.bob).stake(1000n * E18, 3);
    const weightBefore = await ctx.vault.weightOf(ctx.bob.address);
    await ctx.vault.connect(ctx.bob).equipCard(cardId);
    expect(await ctx.vault.weightOf(ctx.bob.address)).to.be.gte(weightBefore);
    await checkInvariants(ctx, users, "after equip");

    // Revenue flows and both rails get paid.
    await ctx.dispensary.setReferenceAdmin(tier, 1_000_000n);
    await ctx.hesoyam.connect(ctx.owner).transfer(ctx.router.target, 200_000n * E18);
    await ctx.router.sweep(0);
    expect(await ctx.vault.pendingReward(ctx.bob.address)).to.be.gt(0n);
    expect(await ctx.dispensary.budgetRemaining()).to.be.gt(0n);
    await checkInvariants(ctx, users, "after sweep");

    // Alice sells the rest into the Dispensary bid.
    const remaining = await ctx.flower.balanceOf(ctx.alice.address, tokenId);
    const absorbable = await ctx.dispensary.absorbableUnits(tier);
    const sellUnits = remaining < absorbable ? remaining : absorbable;
    if (sellUnits > 0n) await ctx.dispensary.connect(ctx.alice).sell(strainId, tier, sellUnits);
    await checkInvariants(ctx, users, "after dispensary sale");

    await ctx.vault.connect(ctx.bob).claim();
    await ctx.vault.connect(ctx.bob).unequipCard(cardId);
    expect(await ctx.card.ownerOf(cardId)).to.equal(ctx.bob.address);
    await checkInvariants(ctx, users, "end");
  });

  it("caps stacked card weight at 1.42x (INV-13)", async function () {
    const ctx = await loadFixture(deployHesoyam);
    // Mint five maximum-weight cards straight from an authorized minter.
    await ctx.card.setMinter(ctx.owner.address, true);
    for (let i = 0; i < 5; i++) {
      await ctx.card.mint(ctx.alice.address, 14_200, 0, 3);
    }
    await ctx.vault.connect(ctx.alice).stake(1000n * E18, 0);
    for (let i = 1; i <= 5; i++) {
      await ctx.vault.connect(ctx.alice).equipCard(i);
    }
    expect(await ctx.vault.cardBonusBps(ctx.alice.address)).to.equal(MAX_CARD_BONUS_BPS);
    expect(await ctx.vault.weightOf(ctx.alice.address)).to.equal((1000n * E18 * 14_200n) / 10_000n);

    await expect(ctx.vault.connect(ctx.alice).equipCard(1)).to.be.revertedWithCustomError(ctx.vault, "TooManyCards");
  });

  it("recomputes the card bonus correctly when one is removed", async function () {
    const ctx = await loadFixture(deployHesoyam);
    await ctx.card.setMinter(ctx.owner.address, true);
    await ctx.card.mint(ctx.alice.address, 14_200, 0, 3); // id 1, +4200
    await ctx.card.mint(ctx.alice.address, 11_000, 0, 1); // id 2, +1000

    await ctx.vault.connect(ctx.alice).stake(1000n * E18, 0);
    await ctx.vault.connect(ctx.alice).equipCard(1);
    await ctx.vault.connect(ctx.alice).equipCard(2);
    // Capped at 4200 even though the raw sum is 5200.
    expect(await ctx.vault.cardBonusBps(ctx.alice.address)).to.equal(4200n);

    await ctx.vault.connect(ctx.alice).unequipCard(1);
    // Recomputed from what is left, not decremented from the capped total.
    expect(await ctx.vault.cardBonusBps(ctx.alice.address)).to.equal(1000n);
    expect(await ctx.vault.weightOf(ctx.alice.address)).to.equal((1000n * E18 * 11_000n) / 10_000n);
  });
});

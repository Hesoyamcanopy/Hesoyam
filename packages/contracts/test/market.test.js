const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployHesoyam, commitFor, randomSalt, buyBench, DAY, E18, E6, revealNext } = require("./fixture");

/** Grows one predictable harvest and returns the tier that ended up holding it. */
async function growSome(ctx, user, baseYield = 2000) {
  const count = await ctx.strains.count();
  await ctx.strains.addStrain(`Test ${count}`, 2 * DAY, baseYield, 10_000, 0, 0, 1n * E18);
  const strainId = Number(count);
  const benchId = await buyBench(ctx, user, 1);
  const salt = randomSalt();
  await ctx.game.connect(user).plant(strainId, benchId, commitFor(salt));
  await revealNext(ctx);
  const plantedAt = await time.latest();
  await time.increaseTo(plantedAt + 2 * DAY + 1);
  const growId = (await ctx.game.nextGrowId()) - 1n;
  await ctx.game.connect(user).harvest(growId, salt, false);

  for (let tier = 0; tier < 3; tier++) {
    const id = BigInt(strainId) * 4n + BigInt(tier);
    const bal = await ctx.flower.balanceOf(user.address, id);
    if (bal > 0n) return { strainId, tier, tokenId: id, units: bal };
  }
  throw new Error("harvest produced nothing");
}

describe("Marketplace", function () {
  it("takes exactly 4% and pays the seller the rest", async function () {
    const ctx = await loadFixture(deployHesoyam);
    const { tokenId, units } = await growSome(ctx, ctx.alice);

    const price = 3n * E18; // 3 HESOYAM per unit
    const amount = 100n;
    await ctx.market.connect(ctx.alice).list(tokenId, units, price);
    expect(await ctx.flower.balanceOf(ctx.market.target, tokenId)).to.equal(units);

    const sellerBefore = await ctx.hesoyam.balanceOf(ctx.alice.address);
    const routerBefore = await ctx.hesoyam.balanceOf(ctx.router.target);
    const buyerBefore = await ctx.hesoyam.balanceOf(ctx.bob.address);

    await ctx.market.connect(ctx.bob).buy(1, amount);

    const gross = price * amount;
    const fee = (gross * 4n) / 100n;
    expect(await ctx.hesoyam.balanceOf(ctx.router.target)).to.equal(routerBefore + fee);
    expect(await ctx.hesoyam.balanceOf(ctx.alice.address)).to.equal(sellerBefore + gross - fee);
    expect(await ctx.hesoyam.balanceOf(ctx.bob.address)).to.equal(buyerBefore - gross);
    expect(await ctx.flower.balanceOf(ctx.bob.address, tokenId)).to.equal(amount);
  });

  it("closes a listing once it is fully filled and returns the rest on cancel", async function () {
    const ctx = await loadFixture(deployHesoyam);
    const { tokenId } = await growSome(ctx, ctx.alice);

    await ctx.market.connect(ctx.alice).list(tokenId, 100n, 1n * E18);
    await ctx.market.connect(ctx.bob).buy(1, 100n);
    expect((await ctx.market.listings(1)).active).to.equal(false);
    await expect(ctx.market.connect(ctx.bob).buy(1, 1n)).to.be.revertedWithCustomError(ctx.market, "NotActive");

    await ctx.market.connect(ctx.alice).list(tokenId, 50n, 1n * E18);
    const before = await ctx.flower.balanceOf(ctx.alice.address, tokenId);
    await ctx.market.connect(ctx.alice).cancel(2);
    expect(await ctx.flower.balanceOf(ctx.alice.address, tokenId)).to.equal(before + 50n);
  });

  it("will not let governance raise the take above the hard ceiling", async function () {
    const ctx = await loadFixture(deployHesoyam);
    await expect(ctx.market.setFeeBps(1001)).to.be.revertedWithCustomError(ctx.market, "FeeTooHigh");
    await expect(ctx.market.setFeeBps(1000)).to.not.be.reverted;
  });
});

describe("Dispensary", function () {
  async function fundDispensary(ctx, hesoyamAmount = 100_000n * E18) {
    await ctx.hesoyam.connect(ctx.owner).transfer(ctx.router.target, hesoyamAmount);
    await ctx.router.sweep(0);
    return ctx.dispensary.budgetRemaining();
  }

  it("opens at 115% of reference and decays to 60%", async function () {
    const ctx = await loadFixture(deployHesoyam);
    await ctx.dispensary.setReferenceAdmin(1, 1_000_000n); // 1 USDC per unit
    await fundDispensary(ctx);

    expect(await ctx.dispensary.currentPrice(1)).to.equal(1_150_000n);
    await time.increase(12 * 60 * 60);
    expect(await ctx.dispensary.currentPrice(1)).to.be.closeTo(875_000n, 2_000n);
    await time.increase(13 * 60 * 60);
    expect(await ctx.dispensary.currentPrice(1)).to.equal(600_000n);
  });

  it("buys Flower, burns it and pays settlement", async function () {
    const ctx = await loadFixture(deployHesoyam);
    const { strainId, tier, tokenId } = await growSome(ctx, ctx.alice);
    await ctx.dispensary.setReferenceAdmin(tier, 1_000_000n);
    await fundDispensary(ctx);

    const price = await ctx.dispensary.currentPrice(tier);
    const units = 10n;
    const burnedBefore = await ctx.flower.totalBurned(tokenId);

    await ctx.dispensary.connect(ctx.alice).sell(strainId, tier, units);

    expect(await ctx.usdc.balanceOf(ctx.alice.address)).to.be.closeTo(price * units, price / 100n);
    expect(await ctx.flower.totalBurned(tokenId)).to.equal(burnedBefore + units);
    expect(await ctx.dispensary.totalUnitsBought()).to.equal(units);
  });

  it("cannot spend more than it was funded (INV-9)", async function () {
    const ctx = await loadFixture(deployHesoyam);
    const { strainId, tier } = await growSome(ctx, ctx.alice, 20000);
    await ctx.dispensary.setReferenceAdmin(tier, 1_000_000n);
    await fundDispensary(ctx, 1_000n * E18); // small budget on purpose

    const budget = await ctx.dispensary.budgetRemaining();
    const absorbable = await ctx.dispensary.absorbableUnits(tier);
    expect(absorbable).to.be.gt(0n);

    await expect(ctx.dispensary.connect(ctx.alice).sell(strainId, tier, absorbable + 1n))
      .to.be.revertedWithCustomError(ctx.dispensary, "BudgetExhausted");

    await ctx.dispensary.connect(ctx.alice).sell(strainId, tier, absorbable);
    expect(await ctx.dispensary.totalSpent()).to.be.lte(await ctx.dispensary.totalFunded());
    expect(await ctx.dispensary.budgetRemaining()).to.be.lt(budget);
  });

  it("refuses to bid with no reference price (INV-11)", async function () {
    const ctx = await loadFixture(deployHesoyam);
    const { strainId, tier } = await growSome(ctx, ctx.alice);
    await fundDispensary(ctx);
    expect(await ctx.dispensary.currentPrice(tier)).to.equal(0n);
    await expect(ctx.dispensary.connect(ctx.alice).sell(strainId, tier, 1n))
      .to.be.revertedWithCustomError(ctx.dispensary, "NoReference");
  });

  it("limits how far a keeper can move the reference", async function () {
    const ctx = await loadFixture(deployHesoyam);
    await ctx.dispensary.connect(ctx.keeper).setReference(1, 1_000_000n);
    await time.increase(3601);
    await expect(ctx.dispensary.connect(ctx.keeper).setReference(1, 1_300_000n))
      .to.be.revertedWithCustomError(ctx.dispensary, "MoveTooLarge");
    await expect(ctx.dispensary.connect(ctx.keeper).setReference(1, 1_150_000n)).to.not.be.reverted;
    await expect(ctx.dispensary.connect(ctx.keeper).setReference(1, 1_200_000n))
      .to.be.revertedWithCustomError(ctx.dispensary, "CooldownActive");
    await expect(ctx.dispensary.connect(ctx.alice).setReference(1, 1_000_000n))
      .to.be.revertedWithCustomError(ctx.dispensary, "NotKeeper");
  });

  it("rolls unspent budget forward without rewinding the price", async function () {
    const ctx = await loadFixture(deployHesoyam);
    await ctx.dispensary.setReferenceAdmin(1, 1_000_000n);
    const first = await fundDispensary(ctx, 10_000n * E18);
    await time.increase(25 * 60 * 60);
    expect(await ctx.dispensary.currentPrice(1)).to.equal(600_000n);

    await ctx.hesoyam.connect(ctx.owner).transfer(ctx.router.target, 10_000n * E18);
    await ctx.router.sweep(0);

    expect(await ctx.dispensary.budgetRemaining()).to.be.gt(first);
    // The bid stays where the decay left it. Restarting the auction on a
    // top-up let a seller wait for the floor, poke a funding call and then
    // sell at the ceiling, so the clock now only restarts on an exhausted
    // budget.
    expect(await ctx.dispensary.currentPrice(1)).to.equal(600_000n);
  });
});

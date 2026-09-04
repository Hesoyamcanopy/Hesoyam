const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time, mine } = require("@nomicfoundation/hardhat-network-helpers");
const { deployHesoyam, commitFor, randomSalt, buyBench, DAY, E18, revealNext } = require("./fixture");

const CYCLE = 7 * DAY;
const FEED_CENTRES = [CYCLE / 7, (CYCLE * 3) / 7, (CYCLE * 5) / 7];
const EVENT_TIMES = [(CYCLE * 2) / 7, (CYCLE * 4) / 7, (CYCLE * 6) / 7];

/** Reads how much Flower a player holds of each quality tier for a strain. */
async function flowerByTier(ctx, user, strainId) {
  const out = [];
  for (let tier = 0; tier < 3; tier++) {
    out.push(await ctx.flower.balanceOf(user.address, BigInt(strainId) * 4n + BigInt(tier)));
  }
  return out;
}

describe("GrowBench", function () {
  it("sells from a tranche and sends the whole price to revenue", async function () {
    const ctx = await loadFixture(deployHesoyam);
    const before = await ctx.hesoyam.balanceOf(ctx.router.target);
    const id = await buyBench(ctx, ctx.alice, 0);
    expect(await ctx.bench.ownerOf(id)).to.equal(ctx.alice.address);
    expect(await ctx.bench.tierOf(id)).to.equal(0);
    expect(await ctx.hesoyam.balanceOf(ctx.router.target)).to.equal(before + 500n * E18);
  });

  it("respects the tranche cap", async function () {
    const ctx = await loadFixture(deployHesoyam);
    await ctx.bench.openTranche(1, 1n * E18, 1);
    await ctx.bench.connect(ctx.alice).buy(2);
    await expect(ctx.bench.connect(ctx.bob).buy(2)).to.be.revertedWithCustomError(ctx.bench, "SoldOut");
  });
});

describe("GrowGame", function () {
  it("charges the seed price and occupies the bench", async function () {
    const ctx = await loadFixture(deployHesoyam);
    const benchId = await buyBench(ctx, ctx.alice, 0);
    const salt = randomSalt();

    const before = await ctx.hesoyam.balanceOf(ctx.router.target);
    await ctx.game.connect(ctx.alice).plant(0, benchId, commitFor(salt));
    expect(await ctx.hesoyam.balanceOf(ctx.router.target)).to.equal(before + 120n * E18);
    expect(await ctx.game.benchBusyWith(benchId)).to.equal(1n);

    await expect(ctx.game.connect(ctx.alice).plant(0, benchId, commitFor(randomSalt())))
      .to.be.revertedWithCustomError(ctx.game, "BenchBusy");
  });

  it("refuses to plant on someone else's bench", async function () {
    const ctx = await loadFixture(deployHesoyam);
    const benchId = await buyBench(ctx, ctx.alice, 0);
    await expect(ctx.game.connect(ctx.bob).plant(0, benchId, commitFor(randomSalt())))
      .to.be.revertedWithCustomError(ctx.game, "NotBenchOwner");
  });

  it("only accepts a feed inside its window", async function () {
    const ctx = await loadFixture(deployHesoyam);
    const benchId = await buyBench(ctx, ctx.alice, 0);
    await ctx.game.connect(ctx.alice).plant(0, benchId, commitFor(randomSalt()));
    const plantedAt = await time.latest();

    await expect(ctx.game.connect(ctx.alice).feed(1, 0)).to.be.revertedWithCustomError(ctx.game, "WindowClosed");

    await time.increaseTo(plantedAt + FEED_CENTRES[0]);
    await ctx.game.connect(ctx.alice).feed(1, 0);
    await expect(ctx.game.connect(ctx.alice).feed(1, 0)).to.be.revertedWithCustomError(ctx.game, "AlreadyFed");

    await time.increaseTo(plantedAt + FEED_CENTRES[0] + CYCLE / 7);
    await expect(ctx.game.connect(ctx.alice).feed(1, 1)).to.be.revertedWithCustomError(ctx.game, "WindowClosed");
  });

  it("pays perfect care its full yield, and neglect a 68% one", async function () {
    const ctx = await loadFixture(deployHesoyam);

    // Attentive grower on a tier 2 bench: 40 feeding + 30 environment + 30 events.
    const goodBench = await buyBench(ctx, ctx.alice, 1);
    const saltA = randomSalt();
    await ctx.game.connect(ctx.alice).plant(0, goodBench, commitFor(saltA));
    await revealNext(ctx);
    const plantedA = await time.latest();

    // Feed every window, and treat anything that fires, which is the whole
    // definition of an attentive grower.
    const popcount = (m) => ((m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1));
    for (let i = 0; i < 3; i++) {
      await time.increaseTo(plantedA + FEED_CENTRES[i]);
      await ctx.game.connect(ctx.alice).feed(1, i);
    }
    const firesA = Number(await ctx.game.firedMask(1));
    for (let slot = 0; slot < 3; slot++) {
      if (!(firesA & (1 << slot))) continue;
      const w = await ctx.game.eventWindow(1, slot);
      await time.increaseTo(Number(w.opensAt) + 1);
      await ctx.game.connect(ctx.alice).treat(1, slot);
    }
    const [careA] = await ctx.game.careScore(1);
    // 40 for feeding all three windows, environment points from the bench tier
    // capped at 30, plus 30 for handling every event that fired. Every term is
    // derived, because which events fire is now genuinely unpredictable.
    const tierA = Number(await ctx.bench.tierOf(goodBench));
    const envA = Math.min(30, tierA * 15);
    expect(careA).to.equal(40 + envA + 30);

    // Careless grower on a tier 0 bench: no feeding, no environment, and event
    // points only for the events that never fired.
    const badBench = await buyBench(ctx, ctx.bob, 0);
    const saltB = randomSalt();
    await ctx.game.connect(ctx.bob).plant(0, badBench, commitFor(saltB));
    await revealNext(ctx);
    const plantedB = await time.latest();
    const firesB = Number(await ctx.game.firedMask(2));
    const [careB] = await ctx.game.careScore(2);
    expect(careB).to.equal(popcount(firesB) === 0 ? 30 : 0);
    expect(careB).to.be.lt(careA);

    await time.increaseTo(plantedA + CYCLE + 1);
    await ctx.game.connect(ctx.alice).harvest(1, saltA, false);
    await time.increaseTo(plantedB + CYCLE + 1);
    await ctx.game.connect(ctx.bob).harvest(2, saltB, false);

    const aliceTotal = (await flowerByTier(ctx, ctx.alice, 0)).reduce((a, b) => a + b, 0n);
    const bobTotal = (await flowerByTier(ctx, ctx.bob, 0)).reduce((a, b) => a + b, 0n);

    expect(aliceTotal).to.equal(100n); // base 100 * 1.00 genetics * 1.00 care
    expect(bobTotal).to.equal(68n); // 100 * (0.55 + 0.45 * 0.30)
  });

  it("damages an untreated pest event and spares a treated one", async function () {
    const ctx = await loadFixture(deployHesoyam);
    const benchId = await buyBench(ctx, ctx.alice, 0);
    const salt = randomSalt();
    await ctx.game.connect(ctx.alice).plant(1, benchId, commitFor(salt)); // strain 1 always fires
    const plantedAt = await time.latest();

    const fires = await ctx.game.firedMask(1);
    expect(fires).to.be.gt(0);

    const [, damageUntreated] = await ctx.game.careScore(1);
    expect(damageUntreated).to.be.gt(0);

    // Treat every slot that actually fired.
    for (let slot = 0; slot < 3; slot++) {
      if ((Number(fires) & (1 << slot)) === 0) continue;
      await time.increaseTo(plantedAt + EVENT_TIMES[slot] + 60);
      await ctx.game.connect(ctx.alice).treat(1, slot);
    }
    const [care, damage] = await ctx.game.careScore(1);
    expect(damage).to.equal(0);
    expect(care).to.equal(30); // 0 feeding, tier 0 bench, full 30 for event response
  });

  it("rejects treating a slot that did not fire, or treating late", async function () {
    const ctx = await loadFixture(deployHesoyam);
    const quiet = await buyBench(ctx, ctx.alice, 0);
    await ctx.game.connect(ctx.alice).plant(0, quiet, commitFor(randomSalt())); // never fires
    await expect(ctx.game.connect(ctx.alice).treat(1, 0)).to.be.revertedWithCustomError(ctx.game, "NoEventHere");

    const risky = await buyBench(ctx, ctx.bob, 0);
    await ctx.game.connect(ctx.bob).plant(1, risky, commitFor(randomSalt()));
    const plantedAt = await time.latest();
    const fires = Number(await ctx.game.firedMask(2));
    const slot = [0, 1, 2].find((s) => (fires & (1 << s)) !== 0);
    await time.increaseTo(plantedAt + EVENT_TIMES[slot] + CYCLE / 7 + 60);
    await expect(ctx.game.connect(ctx.bob).treat(2, slot)).to.be.revertedWithCustomError(ctx.game, "WindowClosed");
  });

  it("requires maturity and the right salt to harvest", async function () {
    const ctx = await loadFixture(deployHesoyam);
    const benchId = await buyBench(ctx, ctx.alice, 0);
    const salt = randomSalt();
    await ctx.game.connect(ctx.alice).plant(0, benchId, commitFor(salt));
    const plantedAt = await time.latest();

    await revealNext(ctx);
    await expect(ctx.game.connect(ctx.alice).harvest(1, salt, false))
      .to.be.revertedWithCustomError(ctx.game, "NotMature");

    await time.increaseTo(plantedAt + CYCLE + 1);
    await expect(ctx.game.connect(ctx.alice).harvest(1, randomSalt(), false))
      .to.be.revertedWithCustomError(ctx.game, "BadCommit");
    await expect(ctx.game.connect(ctx.bob).harvest(1, salt, false))
      .to.be.revertedWithCustomError(ctx.game, "NotGrower");

    await ctx.game.connect(ctx.alice).harvest(1, salt, false);
    expect(await ctx.game.benchBusyWith(benchId)).to.equal(0n);
  });

  it("charges utilities for the full cycle at harvest", async function () {
    const ctx = await loadFixture(deployHesoyam);
    const benchId = await buyBench(ctx, ctx.alice, 0);
    const salt = randomSalt();
    await ctx.game.connect(ctx.alice).plant(0, benchId, commitFor(salt));
    const plantedAt = await time.latest();
    await revealNext(ctx);
    await time.increaseTo(plantedAt + CYCLE + 1);

    const before = await ctx.hesoyam.balanceOf(ctx.router.target);
    await ctx.game.connect(ctx.alice).harvest(1, salt, false);
    expect(await ctx.hesoyam.balanceOf(ctx.router.target)).to.equal(before + 70n * E18); // 10 HESOYAM x 7 days
  });

  it("adds up to 12 quality points for a cure and mints only after it finishes", async function () {
    const ctx = await loadFixture(deployHesoyam);
    const benchId = await buyBench(ctx, ctx.alice, 0);
    const salt = randomSalt();
    await ctx.game.connect(ctx.alice).plant(0, benchId, commitFor(salt));
    await revealNext(ctx);
    const plantedAt = await time.latest();
    await time.increaseTo(plantedAt + CYCLE + 1);

    const tx = await ctx.game.connect(ctx.alice).harvest(1, salt, true);
    const receipt = await tx.wait();
    const harvested = receipt.logs
      .map((l) => { try { return ctx.game.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === "Harvested");
    const rawQuality = Number(harvested.args.quality);

    // Nothing minted yet.
    expect((await flowerByTier(ctx, ctx.alice, 0)).reduce((a, b) => a + b, 0n)).to.equal(0n);
    await expect(ctx.game.connect(ctx.alice).collect(1)).to.be.revertedWithCustomError(ctx.game, "NotMature");

    await time.increase(48 * 60 * 60 + 1);
    const [, curedQuality] = await ctx.game.connect(ctx.alice).collect.staticCall(1);
    expect(Number(curedQuality)).to.equal(Math.min(100, rawQuality + 12));

    await ctx.game.connect(ctx.alice).collect(1);
    expect((await flowerByTier(ctx, ctx.alice, 0)).reduce((a, b) => a + b, 0n)).to.be.gt(0n);
    await expect(ctx.game.connect(ctx.alice).collect(1)).to.be.revertedWithCustomError(ctx.game, "AlreadyCollected");
  });

  it("frees the bench when a grow is abandoned", async function () {
    const ctx = await loadFixture(deployHesoyam);
    const benchId = await buyBench(ctx, ctx.alice, 0);
    await ctx.game.connect(ctx.alice).plant(0, benchId, commitFor(randomSalt()));
    await ctx.game.connect(ctx.alice).abandon(1);
    expect(await ctx.game.benchBusyWith(benchId)).to.equal(0n);
    await expect(ctx.game.connect(ctx.alice).plant(0, benchId, commitFor(randomSalt()))).to.not.be.reverted;
  });
});

describe("CardCrafter", function () {
  /** Grows a large harvest so there is enough Flower in one tier to craft with. */
  async function harvestBulk(ctx, user) {
    await ctx.strains.addStrain("Bulk Test", 2 * DAY, 2000, 10_000, 0, 0, 1n * E18);
    const strainId = 3;
    const benchId = await buyBench(ctx, user, 1);
    const salt = randomSalt();
    await ctx.game.connect(user).plant(strainId, benchId, commitFor(salt));
    await revealNext(ctx);
    const plantedAt = await time.latest();
    await time.increaseTo(plantedAt + 2 * DAY + 1);
    await ctx.game.connect(user).harvest(await ctx.game.nextGrowId() - 1n, salt, false);

    const balances = await flowerByTier(ctx, user, strainId);
    const tier = balances.findIndex((b) => b >= 400n);
    return { strainId, tier, units: balances[tier] };
  }

  it("burns 400 Flower plus the fee, then mints a card on reveal", async function () {
    const ctx = await loadFixture(deployHesoyam);
    const { strainId, tier } = await harvestBulk(ctx, ctx.alice);

    const tokenId = BigInt(strainId) * 4n + BigInt(tier);
    const flowerBefore = await ctx.flower.balanceOf(ctx.alice.address, tokenId);
    const routerBefore = await ctx.hesoyam.balanceOf(ctx.router.target);

    await ctx.crafter.connect(ctx.alice).requestCraft(strainId, tier);
    expect(await ctx.flower.balanceOf(ctx.alice.address, tokenId)).to.equal(flowerBefore - 400n);
    expect(await ctx.hesoyam.balanceOf(ctx.router.target)).to.equal(routerBefore + 150n * E18);

    await expect(ctx.crafter.finalizeCraft(1)).to.be.revertedWithCustomError(ctx.crafter, "NotReady");
    await mine(3);
    await ctx.crafter.finalizeCraft(1);

    expect(await ctx.card.balanceOf(ctx.alice.address)).to.equal(1n);
    const weight = await ctx.card.weightBpsOf(1);
    expect(weight).to.be.gte(10_000).and.to.be.lte(14_200);
    await expect(ctx.crafter.finalizeCraft(1)).to.be.revertedWithCustomError(ctx.crafter, "AlreadyFinalized");
  });

  it("settles an expired request at the floor instead of rerolling it", async function () {
    const ctx = await loadFixture(deployHesoyam);
    const { strainId, tier } = await harvestBulk(ctx, ctx.alice);
    await ctx.crafter.connect(ctx.alice).requestCraft(strainId, tier);
    await mine(300);
    await ctx.crafter.finalizeCraft(1);
    expect(await ctx.card.weightBpsOf(1)).to.equal(10_000);
  });

  it("publishes an odds table that sums to 100%", async function () {
    const ctx = await loadFixture(deployHesoyam);
    for (let tier = 0; tier < 3; tier++) {
      const [c, u, r, m] = await ctx.crafter.oddsFor(tier);
      expect(Number(c) + Number(u) + Number(r) + Number(m)).to.equal(10_000);
    }
    const [commonLow] = await ctx.crafter.oddsFor(2);
    const [commonHigh] = await ctx.crafter.oddsFor(0);
    expect(commonLow).to.be.lt(commonHigh); // premium Flower is less likely to roll common
  });
});

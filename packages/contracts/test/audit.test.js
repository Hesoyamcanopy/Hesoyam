/**
 * Pre-audit findings, expressed as executable proofs.
 *
 * Every test in this file PASSES today. Each one asserts the *buggy* behaviour, so
 * a passing run here is a red flag, not a green light. Each `it` name states the
 * finding; the assertions pin the exact wrong outcome so a fix will break them.
 *
 * Nothing here modifies a contract or an existing test.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time, mine } = require("@nomicfoundation/hardhat-network-helpers");
const { deployHesoyam, commitFor, buyBench, E18, E6, DAY, revealNext, randomSalt } = require("./fixture");

const abi = ethers.AbiCoder.defaultAbiCoder();

/** Pushes settlement token into the router so `distribute()` has something to split. */
async function fundRouter(ctx, amount) {
  await ctx.usdc.mint(ctx.router.target, amount);
}

/** Lets the test act as a Flower minter so cases do not need a full grow cycle. */
async function mintFlower(ctx, to, tokenId, units) {
  await ctx.flower.setMinter(ctx.owner.address, true);
  await ctx.flower.mint(to, tokenId, units);
}

describe("AUDIT: StakingVault reward accounting", function () {
  /**
   * F-1 (HIGH). `notifyReward` computes `accPerWeight += pool * 1e18 / totalWeight`
   * and then unconditionally clears `undistributed`. The division truncates and the
   * remainder is thrown away. Settlement is 6 decimals while weight is 18, so once
   * totalWeight passes ~1e26 (100M HESOYAM at the 2.5x tier) a several-hundred-dollar
   * reward rounds to accPerWeight += 0 and is destroyed. The vault has no rescue path.
   */
  it("F-1 fixed: a small reward against a huge weight is credited, not destroyed", async function () {
    const ctx = await loadFixture(deployHesoyam);
    const { hesoyam, usdc, vault, router, owner, alice } = ctx;

    // 100M HESOYAM staked in the 90 day tier -> totalWeight = 2.5e26.
    const principal = 100_000_000n * E18;
    await hesoyam.transfer(alice.address, principal); // owner is tax exempt
    await vault.connect(alice).stake(principal, 3);
    const totalWeight = await vault.totalWeight();
    expect(totalWeight).to.equal(250_000_000n * E18);

    // 400 USDC of realized revenue -> 200 USDC (50%) is the staker rail.
    await fundRouter(ctx, 400n * E6);
    await router.distribute();

    const equity = 200n * E6;
    expect(await vault.totalNotified()).to.equal(equity);
    expect(await usdc.balanceOf(vault.target)).to.equal(equity);

    // ACC_PRECISION is 1e30 and the truncation remainder is carried, so the
    // quotient no longer rounds to nothing. This used to assert the opposite:
    // accPerWeight 0, undistributed 0, and 200 USDC gone forever.
    expect(await vault.accPerWeight()).to.be.gt(0n);

    const pending = await vault.pendingReward(alice.address);
    expect(pending).to.be.gt(0n);

    // The sole staker is owed essentially the whole distribution. Any shortfall
    // is per-user flooring and is carried, never destroyed.
    const lost = equity - pending - (await vault.undistributed());
    expect(lost).to.be.lte(1n);

    await expect(vault.connect(alice).claim()).to.not.be.reverted;
    expect(await usdc.balanceOf(alice.address)).to.equal(pending);

    // A second distribution behaves the same way.
    await fundRouter(ctx, 400n * E6);
    await router.distribute();
    expect(await vault.pendingReward(alice.address)).to.be.gt(0n);
    expect(await vault.totalDistributed()).to.be.gt(0n);

    // INV-2: the vault never credits more than it holds.
    expect(await usdc.balanceOf(vault.target)).to.be.gte(
      (await vault.totalNotified()) - (await vault.totalDistributed())
    );
  });

  /**
   * F-2 (HIGH). Tier 0 has lockSeconds == 0, so `unlockAt == block.timestamp` at stake
   * time and the 4% early-exit penalty never applies. `RevenueRouter.distribute()` is
   * permissionless. A searcher can therefore stake, trigger the distribution, claim and
   * unstake in one bundle, capturing the staker rail at zero cost and zero duration.
   */
  it("F-2 fixed: a same-block flash stake cannot exit without paying the penalty", async function () {
    const ctx = await loadFixture(deployHesoyam);
    const { hesoyam, usdc, vault, router, alice, bob } = ctx;

    // Honest staker, locked for 90 days.
    await vault.connect(alice).stake(1_000n * E18, 3);

    // Attacker borrows 100M HESOYAM and stakes it in the no-lock tier.
    const flash = 100_000_000n * E18;
    await hesoyam.transfer(bob.address, flash);
    const bobBefore = await hesoyam.balanceOf(bob.address);
    await vault.connect(bob).stake(flash, 0);

    await fundRouter(ctx, 1_000n * E6);
    await router.distribute(); // permissionless, attacker calls it himself

    const bobPending = await vault.pendingReward(bob.address);
    const alicePending = await vault.pendingReward(alice.address);
    expect(bobPending).to.be.gt(alicePending * 1000n); // ~99.96% of the rail

    await vault.connect(bob).claim();
    await vault.connect(bob).unstake(0);

    // Tier 0 now carries MIN_HOLD_SECONDS, so unlockAt is in the future and the
    // 4 percent penalty applies to a same-block exit. This used to assert that
    // the principal came back whole.
    const penalty = (flash * 400n) / 10_000n;
    expect(await hesoyam.balanceOf(bob.address)).to.equal(bobBefore - penalty);
    expect(await vault.weightOf(bob.address)).to.equal(0n);

    // The attack is now firmly loss-making: the penalty dwarfs the reward, which
    // is what actually deters it. A flash loan cannot hold the position for an
    // hour, so it cannot avoid the penalty at all.
    expect(penalty).to.be.gt(bobPending);
  });
});

describe("AUDIT: Dispensary Dutch auction", function () {
  /**
   * F-3 (HIGH). `fundEpoch` resets `epochStart`, which restarts the price decay at the
   * 115% ceiling. `RevenueRouter.distribute()` is permissionless and reads a live token
   * balance, so ANYONE can force a funding call by donating dust to the router. A seller
   * therefore never has to accept the decayed bid: they reset the clock and sell at the
   * ceiling, for a few units of settlement token.
   */
  it("F-3 fixed: dust funding cannot rewind the decayed bid to the ceiling", async function () {
    const ctx = await loadFixture(deployHesoyam);
    const { usdc, router, dispensary, alice } = ctx;

    const tier = 1;
    const reference = 1_000_000n; // 1 USDC per unit
    await dispensary.setReferenceAdmin(tier, reference);

    // Seed a real epoch.
    await fundRouter(ctx, 100_000n * E6);
    await router.distribute();

    // Let the auction decay all the way to the 60% floor.
    await time.increase(DAY + 1);
    expect(await dispensary.currentPrice(tier)).to.equal((reference * 6000n) / 10000n);

    const tokenId = 4 * 7 + tier; // strain 7, tier 1
    await mintFlower(ctx, alice.address, tokenId, 10_000n);

    // Attacker donates 10 units of USDC (0.00001) to the router and calls distribute.
    await usdc.mint(alice.address, 10n);
    await usdc.connect(alice).transfer(router.target, 10n);
    await router.connect(alice).distribute();

    // The clock restarted: the bid is back at the ceiling.
    // The clock only restarts when the budget is exhausted, so a top-up while
    // money remains leaves the price on the curve it was already on.
    expect(await dispensary.currentPrice(tier)).to.equal((reference * 6000n) / 10000n);

    const before = await usdc.balanceOf(alice.address);
    const [proceeds, pricePerUnit] = await dispensary.connect(alice).sell.staticCall(7, tier, 10_000n);
    await dispensary.connect(alice).sell(7, tier, 10_000n);

    expect(pricePerUnit).to.equal(600_000n); // the floor the decay actually reached
    expect(await usdc.balanceOf(alice.address)).to.equal(before + proceeds);
    // Nearly twice what the honest auction price would have been.
    expect(proceeds).to.equal(6_000n * E6);
  });
});

describe("AUDIT: Plot rent market", function () {
  /**
   * F-4 (HIGH). `site()` takes no maximum price. The plot owner can raise `dayRate` up
   * to `maxDayRate` in the block before a tenant's transaction lands, and the tenant's
   * open allowance pays it.
   */
  it("F-4 fixed: a price cap stops a plot owner front-running the tenant", async function () {
    const { hesoyam, plot, bench, alice, bob } = await loadFixture(deployHesoyam);

    await plot.mintTo(bob.address, 1, 1234); // bob owns plot 1
    await hesoyam.transfer(alice.address, 1_000_000n * E18);
    await hesoyam.connect(alice).approve(plot.target, ethers.MaxUint256);
    await hesoyam.connect(alice).approve(bench.target, ethers.MaxUint256);

    const benchId = await buyBench({ bench }, alice);

    const quoted = await plot.rateOf(1); // 25e18/day -> 90 days = 2,250 HESOYAM
    const cap = quoted * 90n;
    expect(cap).to.equal(2_250n * E18);

    // Bob sees alice's pending site() and front-runs it, exactly as before.
    await plot.connect(bob).setDayRate(1, 5_000n * E18);

    // The cap alice signed for is now enforced, so the front-run reverts instead
    // of silently charging her 200x. This used to assert that she paid 450,000.
    await expect(plot.connect(alice).site(1, benchId, 90, cap))
      .to.be.revertedWithCustomError(plot, "PriceMoved");

    // Nothing moved, and the attacker earned nothing.
    expect(await plot.rentOwed(bob.address)).to.equal(0n);
    expect((await plot.leaseOf(1)).until).to.equal(0n);

    // At the raised price she can still choose to proceed, knowingly.
    const raised = (await plot.rateOf(1)) * 90n;
    await expect(plot.connect(alice).site(1, benchId, 90, raised)).to.emit(plot, "Sited");
  });

  /**
   * F-5 (MEDIUM). `site()` never checks that the caller owns `benchId`. An attacker can
   * bind a stranger's bench to a plot the attacker owns, which locks that bench out of
   * every other plot for up to `maxLeaseDays`. 70% of the rent is credited straight back
   * to the attacker, so the griefing costs only the 30% protocol cut.
   */
  it("F-5 fixed: siting a bench you do not own is refused", async function () {
    const { hesoyam, plot, bench, alice, bob } = await loadFixture(deployHesoyam);
    await hesoyam.connect(bob).approve(bench.target, ethers.MaxUint256);

    await plot.mintTo(alice.address, 1, 11); // plot 1 - attacker
    await plot.mintTo(bob.address, 1, 22); // plot 2 - victim's own plot
    await hesoyam.connect(alice).approve(plot.target, ethers.MaxUint256);
    await hesoyam.connect(bob).approve(plot.target, ethers.MaxUint256);

    const victimBench = await buyBench({ bench }, bob); // bob owns it
    expect(await bench.ownerOf(victimBench)).to.equal(bob.address);

    // Alice tries to bind a bench she does not own. This used to succeed and
    // lock the real owner out for 90 days.
    await expect(plot.connect(alice).site(1, victimBench, 90, ethers.MaxUint256))
      .to.be.revertedWithCustomError(plot, "NotBenchOwner");

    expect(await plot.plotOfBench(victimBench)).to.equal(0n);
    expect((await plot.leaseOf(1)).until).to.equal(0n);

    // Bob is unaffected and can still site his own bench on his own plot.
    await expect(plot.connect(bob).site(2, victimBench, 1, ethers.MaxUint256))
      .to.emit(plot, "Sited");

    // A bench that does not exist is refused too, which also excludes id 0,
    // the sentinel plotOfBench uses for "not sited".
    await expect(plot.connect(bob).site(1, 0, 1, ethers.MaxUint256))
      .to.be.revertedWithCustomError(plot, "UnknownBench");
  });

  /**
   * F-6 (MEDIUM). `fuse` takes the MAX of the two tiers rather than requiring them to
   * be equal, so a tier N plot pairs with a throwaway tier 0 plot to reach tier N+1.
   * The documented cost of a tier 3 plot is eight tier 0 plots; the real cost is four.
   */
  it("F-6 fixed: the top plot tier still costs eight, not four", async function () {
    const { hesoyam, plot, alice } = await loadFixture(deployHesoyam);

    for (let i = 0; i < 4; i++) await plot.mintTo(alice.address, 3, 500 + i);
    await hesoyam.connect(alice).approve(plot.target, ethers.MaxUint256);

    const idOf = async (p) => {
      const r = await (await p).wait();
      return r.logs
        .map((l) => { try { return plot.interface.parseLog(l); } catch { return null; } })
        .find((l) => l && l.name === "Fused").args.mintedId;
    };

    const t1 = await idOf(plot.connect(alice).fuse(1, 2)); // 2 plots -> tier 1

    // The cheap climb is closed. Pairing a tier 1 with a throwaway tier 0 used
    // to produce a tier 2, which made the top tier cost four plots instead of
    // eight. Equal tiers only.
    await expect(plot.connect(alice).fuse(t1, 3))
      .to.be.revertedWithCustomError(plot, "TierMismatch");

    // The honest route still works and still costs the full eight.
    const t1b = await idOf(plot.connect(alice).fuse(3, 4));
    const t2 = await idOf(plot.connect(alice).fuse(t1, t1b));
    expect((await plot.info(t2)).tier).to.equal(2);
    expect(await plot.totalSupply()).to.equal(1n);

    // Four plots reach tier 2, so tier 3 needs eight. That is the design.
    for (let i = 0; i < 4; i++) await plot.mintTo(alice.address, 3, 900 + i);
    // ids 1-4 minted, 5 and 6 are the first pair of tier 1s, 7 is the tier 2.
    // nextId advances on every fuse as well as every mint, so the four fresh
    // plots are 8 through 11.
    const u1 = await idOf(plot.connect(alice).fuse(8, 9));
    const u2 = await idOf(plot.connect(alice).fuse(10, 11));
    const t2b = await idOf(plot.connect(alice).fuse(u1, u2));
    const t3 = await idOf(plot.connect(alice).fuse(t2, t2b));
    expect((await plot.info(t3)).tier).to.equal(3);
  });
});

describe("AUDIT: GrowGame randomness", function () {
  /**
   * F-7 (HIGH). The event schedule is `keccak(commitHash, blockhash(n-1), benchId,
   * growId, block.timestamp)`. Every input is known to the player at submission time and
   * `commitHash` is freely chosen, so the player grinds a salt whose schedule fires no
   * events at all: full marks on the event component of care, zero damage, every time.
   * A contract can do the search on-chain in the same transaction as `plant`.
   */
  it("F-7 fixed: the commit cannot be ground, because the seed does not exist yet", async function () {
    const ctx = await loadFixture(deployHesoyam);
    const { game, strains, bench, beacon, alice } = ctx;

    // A 50/50 strain: each of the three slots fires when its seed byte < 128.
    await strains.addStrain("Grinder Kush", 7 * DAY, 100, 10_000, 128, 10, 0);
    const strainId = 3;
    const benchId = await buyBench({ bench }, alice);
    const growId = await game.nextGrowId();

    const roundBefore = await beacon.round();
    await game.connect(alice).plant(strainId, benchId, commitFor(randomSalt()));

    // The grow is bound to a round that has not been revealed. Until it is,
    // there is simply no seed to grind against, and the game refuses to resolve
    // rather than treating the absence as "no events fired".
    expect(await game.seedReady(growId)).to.equal(false);
    expect(await game.seedFor(growId)).to.equal(ethers.ZeroHash);
    expect(await beacon.round()).to.equal(roundBefore);

    await time.increase(7 * DAY + 1);
    await expect(game.connect(alice).harvest(growId, ethers.ZeroHash, false))
      .to.be.revertedWithCustomError(game, "BeaconNotReady");

    // Once the round lands, the schedule is fixed by a value the player never
    // saw. Whatever it says, they had no way to steer it.
    await revealNext(ctx);
    expect(await game.seedReady(growId)).to.equal(true);

    const seed = await game.seedFor(growId);
    expect(seed).to.not.equal(ethers.ZeroHash);

    // And it is the beacon's value that drives it: the same grow against a
    // different round would produce a different schedule.
    const roundSeed = await beacon.seedOf(await beacon.round());
    expect(roundSeed).to.not.equal(ethers.ZeroHash);
  });

  /**
   * F-8 (MEDIUM-HIGH). Final quality mixes in `blockhash(block.number - 1)`, which is
   * already known when the harvest transaction is submitted, and `harvest` has no
   * deadline. The player simply waits for a block whose hash gives the best roll. The
   * commit-reveal contributes nothing once the salt is revealed.
   */
  it("F-8 fixed: waiting for a favourable block cannot change the roll", async function () {
    const ctx = await loadFixture(deployHesoyam);
    const { game, bench, alice } = ctx;

    const benchId = await buyBench({ bench }, alice);
    const salt = randomSalt();
    const growId = await game.nextGrowId();
    await game.connect(ctx.alice).plant(0, benchId, commitFor(salt));
    await revealNext(ctx);
    await time.increase(7 * DAY + 1);

    // The outcome is a pure function of the salt and the settled beacon round.
    // Reading it across many blocks must give the same answer every time, which
    // is what removes any reason to wait for a better one.
    const first = await game.previewOutcome(growId, salt);
    for (let i = 0; i < 25; i++) {
      await ethers.provider.send("evm_mine", []);
      const again = await game.previewOutcome(growId, salt);
      expect(again.quality).to.equal(first.quality);
      expect(again.units).to.equal(first.units);
    }

    // And the harvest pays exactly what was previewed, so there was never a
    // better block to wait for.
    const tx = await game.connect(alice).harvest(growId, salt, false);
    const receipt = await tx.wait();
    const ev = receipt.logs
      .map((l) => { try { return game.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === "Harvested");
    expect(ev.args.quality).to.equal(first.quality);
    expect(ev.args.units).to.equal(first.units);
  });

});

describe("AUDIT: RevenueRouter slippage", function () {
  /**
   * H-6 (HIGH), fixed. sweep() is permissionless and used to take its slippage
   * floor from whoever called it, so anyone could call sweep(0): push spot down
   * inside the deviation band, let the router dump with no floor, then buy back.
   * The floor is now computed from the TWAP on chain and the caller may only
   * raise it.
   */
  it("H-6 fixed: sweep(0) cannot dump the treasury below the TWAP floor", async function () {
    const ctx = await loadFixture(deployHesoyam);
    const { hesoyam, usdc, router, adapter, owner, alice } = ctx;

    // Fund the router with HESOYAM to convert, and the adapter with settlement.
    await hesoyam.transfer(router.target, 100_000n * E18);
    await usdc.mint(adapter.target, 1_000_000n * E6);

    // Spot is pushed 2 percent below the TWAP: still inside the deviation guard,
    // which is exactly the window the old code could be attacked through.
    const twap = 1_000_000n; // 1 USDC per HESOYAM, 6dp
    await adapter.setPrices((twap * 9800n) / 10000n, twap);

    // The attacker asks for no protection at all.
    await expect(router.connect(alice).sweep(0)).to.not.be.reverted;

    // It still executed at no worse than the TWAP floor, because the router
    // supplied its own. 3 percent default tolerance on a 2 percent dip passes.
    expect(await router.totalRealized()).to.be.gt(0n);

    // Now push spot below what the floor allows. The swap must refuse.
    await hesoyam.transfer(router.target, 100_000n * E18);
    await time.increase(7 * 60 * 60); // clear the cooldown
    await adapter.setPrices((twap * 9000n) / 10000n, twap); // 10 percent down

    await expect(router.connect(alice).sweep(0)).to.be.reverted;
  });

  it("H-6 fixed: the slippage bound itself is capped", async function () {
    const { router } = await loadFixture(deployHesoyam);
    const ceil = await router.MAX_SLIPPAGE_CEIL_BPS();
    await expect(router.setMaxSlippage(ceil + 1n))
      .to.be.revertedWithCustomError(router, "BadAllocation");
    await expect(router.setMaxSlippage(ceil)).to.not.be.reverted;
  });
});

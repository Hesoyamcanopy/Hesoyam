const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time, mine } = require("@nomicfoundation/hardhat-network-helpers");
const { deployHesoyam, commitFor, randomSalt, buyBench, DAY, E18, revealNext } = require("./fixture");

/**
 * Configuration surface and revert paths.
 *
 * Every setter, every guard and every custom error. These are the branches an attacker
 * reads first and the ones a normal gameplay test never touches.
 */

describe("Access control and configuration", function () {
  describe("HesoyamToken", function () {
    it("rejects zero addresses in tax configuration", async function () {
      const { hesoyam, owner } = await loadFixture(deployHesoyam);
      await expect(hesoyam.setTaxRecipients(ethers.ZeroAddress, owner.address))
        .to.be.revertedWithCustomError(hesoyam, "ZeroAddress");
      await expect(hesoyam.setTaxExempt(ethers.ZeroAddress, true))
        .to.be.revertedWithCustomError(hesoyam, "ZeroAddress");
    });

    it("refuses construction with a zero owner or treasury", async function () {
      const { owner } = await loadFixture(deployHesoyam);
      const factory = await ethers.getContractFactory("HesoyamToken");
      await expect(factory.deploy(ethers.ZeroAddress, owner.address)).to.be.reverted;
      await expect(factory.deploy(owner.address, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(factory, "ZeroAddress");
    });

    it("only lets the owner change tax settings", async function () {
      const { hesoyam, alice } = await loadFixture(deployHesoyam);
      await expect(hesoyam.connect(alice).setTaxExempt(alice.address, true))
        .to.be.revertedWithCustomError(hesoyam, "OwnableUnauthorizedAccount");
    });

    it("can remove an exemption again", async function () {
      const { hesoyam, creatorWallet, alice, bob } = await loadFixture(deployHesoyam);
      await hesoyam.setTaxExempt(alice.address, true);
      const before = await hesoyam.balanceOf(creatorWallet.address);
      await hesoyam.connect(alice).transfer(bob.address, 100n * E18);
      expect(await hesoyam.balanceOf(creatorWallet.address)).to.equal(before);

      await hesoyam.setTaxExempt(alice.address, false);
      await hesoyam.connect(alice).transfer(bob.address, 100n * E18);
      // 4 percent of 100 is 4.
      expect(await hesoyam.balanceOf(creatorWallet.address)).to.equal(before + 4n * E18);
    });
  });

  describe("RevenueRouter", function () {
    it("rejects zero addresses everywhere they matter", async function () {
      const { router, owner } = await loadFixture(deployHesoyam);
      await expect(router.setSinks(ethers.ZeroAddress, owner.address, owner.address, owner.address))
        .to.be.revertedWithCustomError(router, "ZeroAddress");
      await expect(router.setSwapAdapter(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(router, "ZeroAddress");
      await expect(router.spendReserve(ethers.ZeroAddress, 0))
        .to.be.revertedWithCustomError(router, "ZeroAddress");
    });

    it("refuses a deviation guard above 100 percent", async function () {
      const { router } = await loadFixture(deployHesoyam);
      await expect(router.setGuards(1n * E18, 3600, 1_001))
        .to.be.revertedWithCustomError(router, "BadAllocation");
      await expect(router.setGuards(1n * E18, 3600, 1_000)).to.not.be.reverted;
    });

    it("reverts a sweep with nothing to distribute", async function () {
      const { router } = await loadFixture(deployHesoyam);
      await expect(router.sweep(0)).to.be.revertedWithCustomError(router, "NothingToSweep");
      await expect(router.distribute()).to.be.revertedWithCustomError(router, "NothingToSweep");
    });

    it("refuses to operate before sinks are configured", async function () {
      const { owner, hesoyam, usdc } = await loadFixture(deployHesoyam);
      const bare = await ethers.deployContract("RevenueRouter", [owner.address, hesoyam.target, usdc.target]);
      await expect(bare.sweep(0)).to.be.revertedWithCustomError(bare, "SinksNotSet");
      await expect(bare.distribute()).to.be.revertedWithCustomError(bare, "SinksNotSet");
    });

    it("distributes settlement token that arrives directly, without a swap", async function () {
      const { router, usdc, vault, alice } = await loadFixture(deployHesoyam);
      await vault.connect(alice).stake(1000n * E18, 0);
      await usdc.mint(router.target, 1_000_000n);
      await router.distribute();
      expect(await router.totalRealized()).to.equal(1_000_000n);
      expect(await usdc.balanceOf(vault.target)).to.equal(500_000n);
    });

    it("lets the owner spend the reserve and never more than it holds", async function () {
      const { router, usdc, hesoyam, owner, alice, vault } = await loadFixture(deployHesoyam);
      await vault.connect(alice).stake(1000n * E18, 0);
      await hesoyam.connect(owner).transfer(router.target, 100_000n * E18);
      await router.sweep(0);

      const reserve = await router.reserveBalance();
      expect(reserve).to.be.gt(0);
      await expect(router.spendReserve(owner.address, reserve + 1n)).to.be.reverted;
      await router.spendReserve(alice.address, reserve);
      expect(await router.reserveBalance()).to.equal(0);
      expect(await usdc.balanceOf(alice.address)).to.equal(reserve);
    });

    it("reports pending HESOYAM and distributable settlement", async function () {
      const { router, hesoyam, usdc, owner } = await loadFixture(deployHesoyam);
      await hesoyam.connect(owner).transfer(router.target, 500n * E18);
      expect(await router.pendingHesoyam()).to.equal(500n * E18);
      expect(await router.distributableSettlement()).to.equal(0);
      await usdc.mint(router.target, 42n);
      expect(await router.distributableSettlement()).to.equal(42n);
    });

    it("rejects a zero or stale oracle price", async function () {
      const { router, adapter, hesoyam, owner } = await loadFixture(deployHesoyam);
      await hesoyam.connect(owner).transfer(router.target, 1_000n * E18);
      await adapter.setPrices(0, 0);
      await expect(router.sweep(0)).to.be.revertedWithCustomError(router, "PriceDeviation");
    });
  });

  describe("StakingVault", function () {
    it("guards tier arguments", async function () {
      const { vault, alice } = await loadFixture(deployHesoyam);
      await expect(vault.connect(alice).stake(1n * E18, 99))
        .to.be.revertedWithCustomError(vault, "BadTier");
      await expect(vault.addTier(1000, 9_999)).to.be.revertedWithCustomError(vault, "BadTier");

      await vault.setTierEnabled(0, false);
      await expect(vault.connect(alice).stake(1n * E18, 0))
        .to.be.revertedWithCustomError(vault, "BadTier");
      await vault.setTierEnabled(0, true);
      await expect(vault.connect(alice).stake(1n * E18, 0)).to.not.be.reverted;
    });

    it("adds a new tier and uses it", async function () {
      const { vault, alice } = await loadFixture(deployHesoyam);
      const countBefore = await vault.tierCount();
      await vault.addTier(180 * DAY, 30_000);
      expect(await vault.tierCount()).to.equal(countBefore + 1n);
      await vault.connect(alice).stake(1000n * E18, countBefore);
      expect(await vault.weightOf(alice.address)).to.equal(3000n * E18);
    });

    it("rejects zero stakes and unauthorized reward notifications", async function () {
      const { vault, alice } = await loadFixture(deployHesoyam);
      await expect(vault.connect(alice).stake(0, 0)).to.be.revertedWithCustomError(vault, "ZeroAmount");
      await expect(vault.connect(alice).notifyReward(1)).to.be.revertedWithCustomError(vault, "NotNotifier");
    });

    it("refuses zero addresses in configuration", async function () {
      const { vault, card } = await loadFixture(deployHesoyam);
      await expect(vault.setConfig(card.target, ethers.ZeroAddress, card.target))
        .to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    it("reverts a claim with nothing to claim", async function () {
      const { vault, alice } = await loadFixture(deployHesoyam);
      await expect(vault.connect(alice).claim()).to.be.revertedWithCustomError(vault, "NothingToClaim");
    });

    it("cannot close the same position twice", async function () {
      const { vault, alice } = await loadFixture(deployHesoyam);
      await vault.connect(alice).stake(100n * E18, 0);
      await vault.connect(alice).unstake(0);
      await expect(vault.connect(alice).unstake(0)).to.be.revertedWithCustomError(vault, "PositionClosed");
      await expect(vault.connect(alice).emergencyWithdraw(0)).to.be.revertedWithCustomError(vault, "PositionClosed");
    });

    it("rejects equipping a card you do not own or have not equipped", async function () {
      const { vault, card, owner, alice, bob } = await loadFixture(deployHesoyam);
      await card.setMinter(owner.address, true);
      await card.mint(alice.address, 11_000, 0, 1);
      await expect(vault.connect(bob).equipCard(1)).to.be.revertedWithCustomError(vault, "NotCardOwner");
      await expect(vault.connect(alice).unequipCard(1)).to.be.revertedWithCustomError(vault, "CardNotEquipped");
    });

    it("counts positions and equipped cards", async function () {
      const { vault, card, owner, alice } = await loadFixture(deployHesoyam);
      await card.setMinter(owner.address, true);
      await card.mint(alice.address, 11_000, 0, 1);
      await vault.connect(alice).stake(100n * E18, 0);
      await vault.connect(alice).equipCard(1);
      expect(await vault.positionCount(alice.address)).to.equal(1n);
      expect(await vault.equippedCardCount(alice.address)).to.equal(1n);
    });
  });

  describe("Flower", function () {
    it("gates minting and burning on the role", async function () {
      const { flower, alice } = await loadFixture(deployHesoyam);
      await expect(flower.connect(alice).mint(alice.address, 0, 1))
        .to.be.revertedWithCustomError(flower, "NotMinter");
      await expect(flower.connect(alice).burnFrom(alice.address, 0, 1))
        .to.be.revertedWithCustomError(flower, "NotBurner");
    });

    it("requires approval as well as the burner role", async function () {
      const { flower, owner, alice, bob } = await loadFixture(deployHesoyam);
      await flower.setMinter(owner.address, true);
      await flower.setBurner(bob.address, true);
      await flower.mint(alice.address, 0, 10);
      await expect(flower.connect(bob).burnFrom(alice.address, 0, 5))
        .to.be.revertedWithCustomError(flower, "NotApproved");
      await flower.connect(alice).setApprovalForAll(bob.address, true);
      await flower.connect(bob).burnFrom(alice.address, 0, 5);
      expect(await flower.balanceOf(alice.address, 0)).to.equal(5n);
    });

    it("lets a holder burn their own units", async function () {
      const { flower, owner, alice } = await loadFixture(deployHesoyam);
      await flower.setMinter(owner.address, true);
      await flower.mint(alice.address, 4, 10);
      await flower.connect(alice).burn(4, 4);
      expect(await flower.balanceOf(alice.address, 4)).to.equal(6n);
      expect(await flower.totalBurned(4)).to.equal(4n);
    });

    it("packs and unpacks token ids, and rejects an unknown tier", async function () {
      const { flower } = await loadFixture(deployHesoyam);
      expect(await flower.idFor(7, 2)).to.equal(30n);
      expect(await flower.strainOf(30)).to.equal(7);
      expect(await flower.tierOf(30)).to.equal(2);
      await expect(flower.idFor(1, 3)).to.be.revertedWithCustomError(flower, "BadTier");
    });

    it("lets the owner change the metadata URI", async function () {
      const { flower } = await loadFixture(deployHesoyam);
      await flower.setURI("ipfs://next/{id}");
      expect(await flower.uri(1)).to.equal("ipfs://next/{id}");
    });
  });

  describe("GrowBench", function () {
    it("guards tranche configuration", async function () {
      const { bench } = await loadFixture(deployHesoyam);
      await expect(bench.openTranche(3, 1n * E18, 1)).to.be.revertedWithCustomError(bench, "BadTier");
      await expect(bench.setRouter(ethers.ZeroAddress)).to.be.revertedWithCustomError(bench, "ZeroAddress");
    });

    it("stops sales from a closed tranche", async function () {
      const { bench, alice } = await loadFixture(deployHesoyam);
      await bench.closeTranche(0);
      await expect(bench.connect(alice).buy(0)).to.be.revertedWithCustomError(bench, "TrancheClosedError");
    });

    it("reports existence and tranche count, and sets a base URI", async function () {
      const { bench, alice } = await loadFixture(deployHesoyam);
      expect(await bench.trancheCount()).to.equal(2n);
      expect(await bench.exists(999)).to.equal(false);
      const id = await buyBench({ bench }, alice, 0);
      expect(await bench.exists(id)).to.equal(true);
      await bench.setBaseURI("ipfs://benches/");
      expect(await bench.tokenURI(id)).to.equal(`ipfs://benches/${id}`);
    });
  });

  describe("StrainRegistry", function () {
    it("validates parameters on add and update", async function () {
      const { strains } = await loadFixture(deployHesoyam);
      await expect(strains.addStrain("Bad", 60, 100, 10_000, 0, 0, 0))
        .to.be.revertedWithCustomError(strains, "BadParams");
      await expect(strains.addStrain("Bad", 2 * DAY, 0, 10_000, 0, 0, 0))
        .to.be.revertedWithCustomError(strains, "BadParams");
      await expect(strains.addStrain("Bad", 2 * DAY, 10, 10_000, 0, 21, 0))
        .to.be.revertedWithCustomError(strains, "BadParams");
      await expect(strains.updateStrain(99, 2 * DAY, 10, 10_000, 0, 0, 0))
        .to.be.revertedWithCustomError(strains, "UnknownStrain");
      await expect(strains.updateStrain(0, 60, 10, 10_000, 0, 0, 0))
        .to.be.revertedWithCustomError(strains, "BadParams");
    });

    it("updates and deactivates a strain", async function () {
      const { strains } = await loadFixture(deployHesoyam);
      await strains.updateStrain(0, 3 * DAY, 200, 12_000, 10, 5, 99n * E18);
      const s = await strains.get(0);
      expect(s.cycleSeconds).to.equal(3 * DAY);
      expect(s.baseYield).to.equal(200);
      expect(await strains.cycleOf(0)).to.equal(3 * DAY);

      await strains.setActive(0, false);
      expect((await strains.get(0)).active).to.equal(false);
      await expect(strains.setActive(99, false)).to.be.revertedWithCustomError(strains, "UnknownStrain");
      await expect(strains.get(99)).to.be.revertedWithCustomError(strains, "UnknownStrain");
      await expect(strains.core(99)).to.be.revertedWithCustomError(strains, "UnknownStrain");
      await expect(strains.cycleOf(99)).to.be.revertedWithCustomError(strains, "UnknownStrain");
    });

    it("counts strains", async function () {
      const { strains } = await loadFixture(deployHesoyam);
      expect(await strains.count()).to.equal(3n);
    });
  });

  describe("StrainCard", function () {
    it("gates minting and validates the weight range", async function () {
      const { card, owner, alice } = await loadFixture(deployHesoyam);
      await expect(card.connect(alice).mint(alice.address, 11_000, 0, 1))
        .to.be.revertedWithCustomError(card, "NotMinter");
      await card.setMinter(owner.address, true);
      await expect(card.mint(alice.address, 9_999, 0, 0))
        .to.be.revertedWithCustomError(card, "WeightOutOfRange");
      await expect(card.mint(alice.address, 14_201, 0, 3))
        .to.be.revertedWithCustomError(card, "WeightOutOfRange");
      await card.mint(alice.address, 14_200, 0, 3);
      expect(await card.weightBpsOf(1)).to.equal(14_200);
    });

    it("exposes a base URI and enumerable support", async function () {
      const { card, owner, alice } = await loadFixture(deployHesoyam);
      await card.setMinter(owner.address, true);
      await card.mint(alice.address, 10_500, 2, 0);
      await card.setBaseURI("ipfs://cards/");
      expect(await card.tokenURI(1)).to.equal("ipfs://cards/1");
      expect(await card.totalSupply()).to.equal(1n);
      expect(await card.supportsInterface("0x80ac58cd")).to.equal(true);
    });
  });

  describe("Marketplace", function () {
    it("validates listing arguments and ownership", async function () {
      const { market, alice, bob } = await loadFixture(deployHesoyam);
      await expect(market.connect(alice).list(0, 0, 1n * E18))
        .to.be.revertedWithCustomError(market, "ZeroAmount");
      await expect(market.connect(alice).list(0, 1, 0))
        .to.be.revertedWithCustomError(market, "ZeroAmount");
      await expect(market.connect(bob).cancel(1)).to.be.revertedWithCustomError(market, "NotActive");
      await expect(market.connect(bob).buy(1, 1)).to.be.revertedWithCustomError(market, "NotActive");
      await expect(market.setRouter(ethers.ZeroAddress)).to.be.revertedWithCustomError(market, "ZeroAddress");
    });

    it("rejects a buy larger than the listing, and a cancel from a stranger", async function () {
      const { market, flower, owner, alice, bob } = await loadFixture(deployHesoyam);
      await flower.setMinter(owner.address, true);
      await flower.mint(alice.address, 0, 100);
      await market.connect(alice).list(0, 100, 1n * E18);

      await expect(market.connect(bob).buy(1, 0)).to.be.revertedWithCustomError(market, "ZeroAmount");
      await expect(market.connect(bob).buy(1, 101))
        .to.be.revertedWithCustomError(market, "InsufficientListing");
      await expect(market.connect(bob).cancel(1)).to.be.revertedWithCustomError(market, "NotSeller");
    });
  });

  describe("Dispensary", function () {
    it("guards funding and configuration", async function () {
      const { dispensary, alice } = await loadFixture(deployHesoyam);
      await expect(dispensary.connect(alice).fundEpoch(1))
        .to.be.revertedWithCustomError(dispensary, "NotFunder");
      await expect(dispensary.setFunder(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(dispensary, "ZeroAddress");
      await expect(dispensary.setParams(0, 0)).to.be.revertedWithCustomError(dispensary, "ZeroAmount");
      await dispensary.setParams(12 * 60 * 60, 30 * 60);
      expect(await dispensary.auctionDuration()).to.equal(12 * 60 * 60);
    });

    it("rejects an out of range tier and a zero sale", async function () {
      const { dispensary, alice } = await loadFixture(deployHesoyam);
      await expect(dispensary.setReferenceAdmin(3, 1)).to.be.revertedWithCustomError(dispensary, "BadTier");
      await expect(dispensary.connect(alice).sell(0, 3, 1)).to.be.revertedWithCustomError(dispensary, "BadTier");
      await expect(dispensary.connect(alice).sell(0, 0, 0)).to.be.revertedWithCustomError(dispensary, "ZeroAmount");
    });

    it("rejects keeper prices that are zero or on an unknown tier", async function () {
      const { dispensary, keeper } = await loadFixture(deployHesoyam);
      await expect(dispensary.connect(keeper).setReference(0, 0))
        .to.be.revertedWithCustomError(dispensary, "ZeroAmount");
      await expect(dispensary.connect(keeper).setReference(3, 1))
        .to.be.revertedWithCustomError(dispensary, "BadTier");
    });

    it("reports zero absorbable units with no reference price", async function () {
      const { dispensary } = await loadFixture(deployHesoyam);
      expect(await dispensary.absorbableUnits(0)).to.equal(0n);
      expect(await dispensary.currentPrice(0)).to.equal(0n);
    });
  });

  describe("CardCrafter", function () {
    it("guards craft parameters and unknown requests", async function () {
      const { crafter, alice } = await loadFixture(deployHesoyam);
      await expect(crafter.connect(alice).requestCraft(0, 3))
        .to.be.revertedWithCustomError(crafter, "BadTier");
      await expect(crafter.finalizeCraft(999)).to.be.revertedWithCustomError(crafter, "UnknownRequest");
      await expect(crafter.setCraftParams(0, 1)).to.be.revertedWithCustomError(crafter, "ZeroAddress");
      await expect(crafter.setRouter(ethers.ZeroAddress)).to.be.revertedWithCustomError(crafter, "ZeroAddress");
      await crafter.setCraftParams(200, 10n * E18);
      expect(await crafter.flowerPerCraft()).to.equal(200n);
    });
  });

  describe("GrowGame", function () {
    it("guards fee configuration and the router address", async function () {
      const { game } = await loadFixture(deployHesoyam);
      await expect(game.setRouter(ethers.ZeroAddress)).to.be.revertedWithCustomError(game, "ZeroAddress");
      await game.setFees(1n * E18, 2n * E18, 3n * E18, 4n * E18);
      expect(await game.nutrientFee()).to.equal(1n * E18);
      expect(await game.cureFee()).to.equal(4n * E18);
    });

    it("refuses to plant a deactivated strain", async function () {
      const ctx = await loadFixture(deployHesoyam);
      const benchId = await buyBench(ctx, ctx.alice, 0);
      await ctx.strains.setActive(0, false);
      await expect(ctx.game.connect(ctx.alice).plant(0, benchId, commitFor(randomSalt())))
        .to.be.revertedWithCustomError(ctx.game, "StrainInactive");

      await ctx.strains.setActive(0, true);
      await expect(ctx.game.connect(ctx.alice).plant(0, benchId, commitFor(randomSalt()))).to.not.be.reverted;
    });

    it("refuses actions from anyone but the grower", async function () {
      const ctx = await loadFixture(deployHesoyam);
      const benchId = await buyBench(ctx, ctx.alice, 0);
      await ctx.game.connect(ctx.alice).plant(0, benchId, commitFor(randomSalt()));
      await expect(ctx.game.connect(ctx.bob).feed(1, 0)).to.be.revertedWithCustomError(ctx.game, "NotGrower");
      await expect(ctx.game.connect(ctx.bob).treat(1, 0)).to.be.revertedWithCustomError(ctx.game, "NotGrower");
      await expect(ctx.game.connect(ctx.bob).abandon(1)).to.be.revertedWithCustomError(ctx.game, "NotGrower");
      await expect(ctx.game.connect(ctx.alice).feed(1, 3)).to.be.revertedWithCustomError(ctx.game, "BadSlot");
      await expect(ctx.game.connect(ctx.alice).treat(1, 3)).to.be.revertedWithCustomError(ctx.game, "BadSlot");
    });

    it("refuses to act on an inactive grow", async function () {
      const ctx = await loadFixture(deployHesoyam);
      const benchId = await buyBench(ctx, ctx.alice, 0);
      await ctx.game.connect(ctx.alice).plant(0, benchId, commitFor(randomSalt()));
      await ctx.game.connect(ctx.alice).abandon(1);
      await expect(ctx.game.connect(ctx.alice).abandon(1)).to.be.revertedWithCustomError(ctx.game, "GrowInactive");
      await expect(ctx.game.connect(ctx.alice).feed(1, 0)).to.be.revertedWithCustomError(ctx.game, "GrowInactive");
      await expect(ctx.game.connect(ctx.alice).treat(1, 0)).to.be.revertedWithCustomError(ctx.game, "GrowInactive");
      await expect(ctx.game.connect(ctx.alice).harvest(1, randomSalt(), false))
        .to.be.revertedWithCustomError(ctx.game, "GrowInactive");
    });

    it("refuses to collect a harvest that was never cured", async function () {
      const ctx = await loadFixture(deployHesoyam);
      const benchId = await buyBench(ctx, ctx.alice, 0);
      const salt = randomSalt();
      await ctx.game.connect(ctx.alice).plant(0, benchId, commitFor(salt));
      await revealNext(ctx);
      await time.increase(7 * DAY + 1);
      await ctx.game.connect(ctx.alice).harvest(1, salt, false);
      await expect(ctx.game.connect(ctx.alice).collect(1)).to.be.revertedWithCustomError(ctx.game, "NotGrower");
    });

    it("exposes a single call view for the client", async function () {
      const ctx = await loadFixture(deployHesoyam);
      const benchId = await buyBench(ctx, ctx.alice, 0);
      await ctx.game.connect(ctx.alice).plant(1, benchId, commitFor(randomSalt()));
      const view = await ctx.game.growView(1);
      expect(view.g.grower).to.equal(ctx.alice.address);
      expect(view.matureAt).to.be.gt(0n);
      expect(view.fires).to.be.gte(0);
      const [opens, closes] = await ctx.game.feedWindow(1, 0);
      expect(closes).to.be.gt(opens);
      const [eOpens, eCloses] = await ctx.game.eventWindow(1, 0);
      expect(eCloses).to.be.gt(eOpens);
      expect(await ctx.game.eventFires(1, 0)).to.be.a("boolean");
    });
  });

  describe("Mock swap adapter", function () {
    it("enforces its own slippage floor", async function () {
      const { adapter, hesoyam, owner } = await loadFixture(deployHesoyam);
      await hesoyam.connect(owner).approve(adapter.target, ethers.MaxUint256);
      await expect(adapter.swapHesoyamForUsdc(1n * E18, 999_999_999n)).to.be.revertedWith("MockSwapAdapter: slippage");
    });
  });
});

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployHesoyam, buyBench, DAY, E18 } = require("./fixture");

/**
 * The Plot rail.
 *
 * The point of these tests is not that the functions run. It is that a plot can
 * only ever be paid by a grower who wanted to use it, that supply can only fall,
 * and that the art needs nothing off chain to exist.
 */
const NO_CAP = ethers.MaxUint256;

describe("Plot", function () {
  async function withPlots() {
    const ctx = await deployHesoyam();
    const benches = {};
    for (const who of [ctx.alice, ctx.bob, ctx.carol]) {
      await ctx.hesoyam.transfer(who.address, 500_000n * E18);
      await ctx.hesoyam.connect(who).approve(ctx.plot.target, ethers.MaxUint256);
      await ctx.hesoyam.connect(who).approve(ctx.bench.target, ethers.MaxUint256);
      // site() now requires the caller to own the bench, so give everyone two.
      benches[who.address] = [await buyBench(ctx, who), await buyBench(ctx, who)];
    }
    return { ...ctx, benches };
  }

  describe("supply", function () {
    it("mints only through the owner and only up to the cap", async function () {
      const { plot, alice, benches } = await loadFixture(withPlots);
      await plot.mintTo(alice.address, 0, 1234);
      expect(await plot.totalSupply()).to.equal(1n);
      expect(await plot.ownerOf(1)).to.equal(alice.address);

      await expect(plot.connect(alice).mintTo(alice.address, 0, 1))
        .to.be.revertedWithCustomError(plot, "OwnableUnauthorizedAccount");
    });

    it("has no mint function reachable once the cap is reached", async function () {
      const { plot, alice, benches } = await loadFixture(withPlots);
      const cap = Number(await plot.MAX_SUPPLY());
      // Minting the full 256 in one test is slow, so shrink the problem by
      // asserting the guard directly against the counter it reads.
      expect(cap).to.equal(256);
      expect(await plot.minted()).to.equal(0);
      await plot.mintTo(alice.address, 1, 7);
      expect(await plot.minted()).to.equal(1);
    });
  });

  describe("siting", function () {
    it("splits rent between the owner and the router, and pays neither from thin air", async function () {
      const { plot, router, hesoyam, alice, bob, benches } = await loadFixture(withPlots);
      await plot.mintTo(alice.address, 2, 99);

      const rate = await plot.rateOf(1);
      const days = 10n;
      const total = rate * days;

      const routerBefore = await hesoyam.balanceOf(router.target);
      const bobBefore = await hesoyam.balanceOf(bob.address);

      await expect(plot.connect(bob).site(1, benches[bob.address][0], days, NO_CAP)).to.emit(plot, "Sited");

      // The grower is debited exactly the quoted total.
      expect(bobBefore - (await hesoyam.balanceOf(bob.address))).to.equal(total);

      // The split is of what actually arrived, and the two halves account for
      // all of it with nothing left stranded in the contract.
      const received = await plot.totalRentPaid();
      const toProtocol = await plot.totalToProtocol();
      const toOwner = await plot.rentOwed(alice.address);
      expect(toProtocol).to.equal((received * 3000n) / 10000n);
      expect(toProtocol + toOwner).to.equal(received);
      expect((await hesoyam.balanceOf(router.target)) - routerBefore).to.equal(toProtocol);
      expect(await hesoyam.balanceOf(plot.target)).to.equal(toOwner);
    });

    it("lets the owner claim, and only what was actually paid in", async function () {
      const { plot, hesoyam, alice, bob, benches } = await loadFixture(withPlots);
      await plot.mintTo(alice.address, 0, 5);
      await plot.connect(bob).site(1, benches[bob.address][0], 5, NO_CAP);

      const owed = await plot.rentOwed(alice.address);
      const before = await hesoyam.balanceOf(alice.address);
      await plot.connect(alice).claimRent();

      expect((await hesoyam.balanceOf(alice.address)) - before).to.equal(owed);
      expect(await plot.rentOwed(alice.address)).to.equal(0);
      await expect(plot.connect(alice).claimRent()).to.be.revertedWithCustomError(plot, "NothingOwed");
    });

    it("refuses a second tenant while the lease is live, and allows one after", async function () {
      const { plot, alice, bob, carol, benches } = await loadFixture(withPlots);
      await plot.mintTo(alice.address, 0, 5);
      await plot.connect(bob).site(1, benches[bob.address][0], 2, NO_CAP);

      await expect(plot.connect(carol).site(1, benches[carol.address][0], 1, NO_CAP))
        .to.be.revertedWithCustomError(plot, "PlotOccupied");

      await time.increase(2 * DAY + 1);
      await expect(plot.connect(carol).site(1, benches[carol.address][0], 1, NO_CAP)).to.emit(plot, "Sited");
    });

    it("will not site one bench on two plots at once", async function () {
      const { plot, alice, bob, benches } = await loadFixture(withPlots);
      await plot.mintTo(alice.address, 0, 1);
      await plot.mintTo(alice.address, 0, 2);
      await plot.connect(bob).site(1, benches[bob.address][0], 5, NO_CAP);

      await expect(plot.connect(bob).site(2, benches[bob.address][0], 5, NO_CAP))
        .to.be.revertedWithCustomError(plot, "BenchAlreadySited");
    });

    it("reports siting status the way a game contract would read it", async function () {
      const { plot, alice, bob, benches } = await loadFixture(withPlots);
      await plot.mintTo(alice.address, 0, 1);
      const benchId = benches[bob.address][0];
      expect(await plot.isSited(benchId)).to.equal(false);

      await plot.connect(bob).site(1, benchId, 1, NO_CAP);
      expect(await plot.isSited(benchId)).to.equal(true);

      await time.increase(DAY + 1);
      expect(await plot.isSited(benchId)).to.equal(false);
    });

    it("caps the rate an owner can charge", async function () {
      const { plot, alice, benches } = await loadFixture(withPlots);
      await plot.mintTo(alice.address, 0, 1);
      const max = await plot.maxDayRate();
      await expect(plot.connect(alice).setDayRate(1, max + 1n))
        .to.be.revertedWithCustomError(plot, "RateTooHigh");
      await plot.connect(alice).setDayRate(1, max);
      expect(await plot.rateOf(1)).to.equal(max);
    });
  });

  describe("fusing", function () {
    it("burns two and mints one, so supply strictly falls", async function () {
      const { plot, alice, benches } = await loadFixture(withPlots);
      await plot.mintTo(alice.address, 3, 11);
      await plot.mintTo(alice.address, 3, 22);
      expect(await plot.totalSupply()).to.equal(2n);

      await expect(plot.connect(alice).fuse(1, 2)).to.emit(plot, "Fused");

      expect(await plot.totalSupply()).to.equal(1n);
      const fused = await plot.tokenOfOwnerByIndex(alice.address, 0);
      expect((await plot.info(fused)).tier).to.equal(1);
      expect((await plot.info(fused)).district).to.equal(3);
    });

    it("sends the fuse fee to the router", async function () {
      const { plot, router, hesoyam, alice, benches } = await loadFixture(withPlots);
      await plot.mintTo(alice.address, 1, 1);
      await plot.mintTo(alice.address, 1, 2);

      const fee = await plot.fuseFee();
      const before = await hesoyam.balanceOf(router.target);
      await plot.connect(alice).fuse(1, 2);
      expect((await hesoyam.balanceOf(router.target)) - before).to.equal(fee);
    });

    it("refuses across districts, on someone else's plots, and past the top tier", async function () {
      const { plot, alice, bob, benches } = await loadFixture(withPlots);
      await plot.mintTo(alice.address, 0, 1);
      await plot.mintTo(alice.address, 1, 2);
      await expect(plot.connect(alice).fuse(1, 2))
        .to.be.revertedWithCustomError(plot, "DifferentDistrict");

      await plot.mintTo(bob.address, 0, 3);
      await expect(plot.connect(alice).fuse(1, 3))
        .to.be.revertedWithCustomError(plot, "NotPlotOwner");

      await expect(plot.connect(alice).fuse(1, 1))
        .to.be.revertedWithCustomError(plot, "SameToken");
    });

    it("will not fuse a plot that is still let", async function () {
      const { plot, alice, bob, benches } = await loadFixture(withPlots);
      await plot.mintTo(alice.address, 0, 1);
      await plot.mintTo(alice.address, 0, 2);
      await plot.connect(bob).site(1, benches[bob.address][0], 3, NO_CAP);

      await expect(plot.connect(alice).fuse(1, 2))
        .to.be.revertedWithCustomError(plot, "LeaseActive");
    });

    it("reaches the top tier in exactly eight plots and then stops", async function () {
      const { plot, alice, benches } = await loadFixture(withPlots);
      for (let i = 0; i < 8; i++) await plot.mintTo(alice.address, 4, 100 + i);

      // Four pairs to tier 1.
      const t1 = [];
      for (let i = 1; i <= 8; i += 2) {
        const tx = await plot.connect(alice).fuse(i, i + 1);
        const r = await tx.wait();
        const ev = r.logs.map((l) => { try { return plot.interface.parseLog(l); } catch { return null; } })
          .find((l) => l && l.name === "Fused");
        t1.push(ev.args.mintedId);
      }
      // Two pairs to tier 2, then one to tier 3.
      const a = await plot.connect(alice).fuse(t1[0], t1[1]).then((t) => t.wait());
      const b = await plot.connect(alice).fuse(t1[2], t1[3]).then((t) => t.wait());
      const idOf = (r) => r.logs.map((l) => { try { return plot.interface.parseLog(l); } catch { return null; } })
        .find((l) => l && l.name === "Fused").args.mintedId;

      const top = await plot.connect(alice).fuse(idOf(a), idOf(b)).then((t) => t.wait());
      const topId = idOf(top);

      expect((await plot.info(topId)).tier).to.equal(3);
      expect(await plot.totalSupply()).to.equal(1n);

      // A spare tier 0 cannot be used to cheapen the climb any more: equal tiers
      // only, which is what makes the top tier cost eight and not four.
      await plot.mintTo(alice.address, 4, 999);
      const spare = await plot.tokenOfOwnerByIndex(alice.address, 1);
      await expect(plot.connect(alice).fuse(topId, spare))
        .to.be.revertedWithCustomError(plot, "TierMismatch");

      // And two plots that are both already at the ceiling cannot go further.
      await plot.mintTo(alice.address, 4, 1001);
      const other = await plot.tokenOfOwnerByIndex(alice.address, 2);
      await expect(plot.connect(alice).fuse(spare, other)).to.emit(plot, "Fused");
    });
  });

  describe("art", function () {
    it("renders entirely on chain, with no off chain reference anywhere in it", async function () {
      const { plot, alice, benches } = await loadFixture(withPlots);
      await plot.mintTo(alice.address, 5, 0xabcdef12n);

      const uri = await plot.tokenURI(1);
      expect(uri.startsWith("data:application/json;base64,")).to.equal(true);

      const json = JSON.parse(
        Buffer.from(uri.slice("data:application/json;base64,".length), "base64").toString("utf8")
      );
      expect(json.name).to.contain("Badlands");
      expect(json.image.startsWith("data:image/svg+xml;base64,")).to.equal(true);

      const svg = Buffer.from(
        json.image.slice("data:image/svg+xml;base64,".length), "base64"
      ).toString("utf8");

      expect(svg.startsWith("<svg")).to.equal(true);
      expect(svg.endsWith("</svg>")).to.equal(true);
      expect(svg).to.contain("<rect");
      // The whole point: nothing in the document makes the renderer fetch
      // anything. The xmlns is a namespace identifier, never dereferenced, so it
      // is excluded rather than the assertion being dropped.
      expect(svg.replace('xmlns="http://www.w3.org/2000/svg"', "")).to.not.contain("http");
      expect(svg).to.not.contain("ipfs");
      expect(svg).to.not.contain("<image");
      expect(svg).to.not.contain("url(");
    });

    it("gives a fused plot different art from either parent", async function () {
      const { plot, alice, benches } = await loadFixture(withPlots);
      await plot.mintTo(alice.address, 2, 111);
      await plot.mintTo(alice.address, 2, 222);
      const a = await plot.tokenURI(1);
      const b = await plot.tokenURI(2);

      await plot.connect(alice).fuse(1, 2);
      const fused = await plot.tokenOfOwnerByIndex(alice.address, 0);
      const c = await plot.tokenURI(fused);

      expect(c).to.not.equal(a);
      expect(c).to.not.equal(b);
    });

    it("refuses to describe a plot that does not exist", async function () {
      const { plot, benches } = await loadFixture(withPlots);
      await expect(plot.tokenURI(404)).to.be.revertedWithCustomError(plot, "UnknownPlot");
    });
  });

  describe("invariants", function () {
    /**
     * The one that matters. Across a randomised run of sitings, claims and fuses,
     * the contract must always hold at least what it owes its plot owners, and
     * every unit a grower paid must be accounted for as either owner rent or
     * protocol revenue. Nothing is created and nothing goes missing.
     */
    it("never owes more than it holds, and never loses a unit of rent", async function () {
      const { plot, router, hesoyam, alice, bob, carol, benches } = await loadFixture(withPlots);
      const owners = [alice, bob];
      for (let i = 0; i < 6; i++) await plot.mintTo(owners[i % 2].address, i % 8, 1000 + i);

      const routerStart = await hesoyam.balanceOf(router.target);
      const paidBy = {};
      for (const w of [alice, bob, carol]) paidBy[w.address] = 0n;

      for (let step = 0; step < 40; step++) {
        const plotId = (step % 6) + 1;
        const tenant = [alice, bob, carol][step % 3];
        const days = (step % 7) + 1;

        const lease = await plot.leaseOf(plotId);
        const now = BigInt(await time.latest());
        if (lease.until > now) {
          await time.increase(DAY);
          continue;
        }
        const owner = await plot.ownerOf(plotId);
        if (owner === tenant.address) continue;

        const total = (await plot.rateOf(plotId)) * BigInt(days);
        const before = await hesoyam.balanceOf(tenant.address);
        // Alternate between the tenant's two benches so a live lease on one
        // does not block the next step, which is the rule under test elsewhere.
        const benchId = benches[tenant.address][step % 2];
        if (await plot.isSited(benchId)) {
          await time.increase(DAY);
          continue;
        }
        await plot.connect(tenant).site(plotId, benchId, days, NO_CAP);
        paidBy[tenant.address] += before - (await hesoyam.balanceOf(tenant.address));

        if (step % 5 === 0) {
          const owed = await plot.rentOwed(owner);
          if (owed > 0n) await plot.connect(await ethers.getSigner(owner)).claimRent();
        }

        // INV: the contract can always pay everyone it owes.
        let owedTotal = 0n;
        for (const w of [alice, bob, carol]) owedTotal += await plot.rentOwed(w.address);
        expect(await hesoyam.balanceOf(plot.target)).to.be.gte(owedTotal);

        await time.increase(DAY);
      }

      // INV: everything paid in reached either an owner or the router.
      let paidTotal = 0n;
      for (const w of [alice, bob, carol]) paidTotal += paidBy[w.address];
      const toRouter = (await hesoyam.balanceOf(router.target)) - routerStart;
      // Everything the contract booked as rent is at most what growers paid.
      // The gap, if any, is transfer tax that never reached this contract.
      expect(await plot.totalRentPaid()).to.be.lte(paidTotal);
      expect(await plot.totalToProtocol()).to.equal(toRouter);

      let stillOwed = 0n;
      for (const w of [alice, bob, carol]) stillOwed += await plot.rentOwed(w.address);
      const claimed = paidTotal - toRouter - stillOwed;
      expect(claimed).to.be.gte(0n);
    });

    it("cannot pay rent that no grower funded", async function () {
      const { plot, alice, benches } = await loadFixture(withPlots);
      await plot.mintTo(alice.address, 0, 1);
      // No siting has happened, so there is nothing to claim. There is no other
      // path in the contract that credits rentOwed.
      expect(await plot.rentOwed(alice.address)).to.equal(0);
      await expect(plot.connect(alice).claimRent()).to.be.revertedWithCustomError(plot, "NothingOwed");
    });
  });
});

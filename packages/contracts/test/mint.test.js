const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deployHesoyam, E18 } = require("./fixture");

describe("Tax split", function () {
  it("takes 5 percent total, 4 to the creator and 1 to the flywheel", async function () {
    const { hesoyam, router, creator, alice, bob } = await loadFixture(deployHesoyam);

    expect(await hesoyam.CREATOR_FEE_BPS()).to.equal(400);
    expect(await hesoyam.PROTOCOL_FEE_BPS()).to.equal(100);
    expect(await hesoyam.TOTAL_TAX_BPS()).to.equal(500);

    // Owner is exempt, so move funds to a taxed holder first.
    await hesoyam.transfer(alice.address, 100_000n * E18);

    const amount = 10_000n * E18;
    const creatorBefore = await hesoyam.balanceOf(creator);
    const routerBefore = await hesoyam.balanceOf(router.target);
    const bobBefore = await hesoyam.balanceOf(bob.address);

    await hesoyam.connect(alice).transfer(bob.address, amount);

    const toCreator = (amount * 400n) / 10_000n;
    const toRouter = (amount * 100n) / 10_000n;

    expect((await hesoyam.balanceOf(creator)) - creatorBefore).to.equal(toCreator);
    expect((await hesoyam.balanceOf(router.target)) - routerBefore).to.equal(toRouter);
    expect((await hesoyam.balanceOf(bob.address)) - bobBefore).to.equal(amount - toCreator - toRouter);
  });

  it("debits the sender the full amount, so no contract goes insolvent on an outbound transfer", async function () {
    const { hesoyam, alice, bob } = await loadFixture(deployHesoyam);
    await hesoyam.transfer(alice.address, 100_000n * E18);

    const before = await hesoyam.balanceOf(alice.address);
    const amount = 5_000n * E18;
    await hesoyam.connect(alice).transfer(bob.address, amount);

    expect(before - (await hesoyam.balanceOf(alice.address))).to.equal(amount);
  });

  it("still exempts both ends of a protocol transfer", async function () {
    const { hesoyam, router, owner } = await loadFixture(deployHesoyam);
    const before = await hesoyam.balanceOf(router.target);
    await hesoyam.connect(owner).transfer(router.target, 1_000n * E18);
    expect((await hesoyam.balanceOf(router.target)) - before).to.equal(1_000n * E18);
  });
});

describe("Plot public mint", function () {
  async function open(ctx, price = 5_000n * E18, perWallet = 5) {
    await ctx.plot.setMint(true, price, perWallet);
    for (const who of [ctx.alice, ctx.bob]) {
      await ctx.hesoyam.transfer(who.address, 500_000n * E18);
      await ctx.hesoyam.connect(who).approve(ctx.plot.target, ethers.MaxUint256);
    }
    return ctx;
  }

  it("is closed until the owner opens it", async function () {
    const { plot, alice } = await loadFixture(deployHesoyam);
    expect(await plot.mintOpen()).to.equal(false);
    await expect(plot.connect(alice).mint(1)).to.be.revertedWithCustomError(plot, "MintClosed");
    expect(await plot.mintableBy(alice.address)).to.equal(0);
  });

  it("mints, and sends the entire price to the router", async function () {
    const ctx = await loadFixture(deployHesoyam);
    await open(ctx);
    const { plot, hesoyam, router, alice } = ctx;

    const price = await plot.mintPrice();
    const before = await hesoyam.balanceOf(router.target);

    await expect(plot.connect(alice).mint(3)).to.emit(plot, "Minted");

    expect(await plot.balanceOf(alice.address)).to.equal(3n);
    expect(await plot.minted()).to.equal(3);
    // The router is tax exempt, so the whole quoted price lands there.
    expect((await hesoyam.balanceOf(router.target)) - before).to.equal(price * 3n);
  });

  it("always mints at tier zero, so the top tier can only be reached by fusing", async function () {
    const ctx = await loadFixture(deployHesoyam);
    await open(ctx);
    await ctx.plot.connect(ctx.alice).mint(5);
    for (let i = 1; i <= 5; i++) {
      expect((await ctx.plot.info(i)).tier).to.equal(0);
    }
  });

  it("enforces the per wallet cap", async function () {
    const ctx = await loadFixture(deployHesoyam);
    await open(ctx, 1n * E18, 3);
    const { plot, alice } = ctx;

    expect(await plot.mintableBy(alice.address)).to.equal(3);
    await plot.connect(alice).mint(3);
    expect(await plot.mintableBy(alice.address)).to.equal(0);
    await expect(plot.connect(alice).mint(1)).to.be.revertedWithCustomError(plot, "WalletCapReached");
  });

  it("refuses a zero or oversized batch", async function () {
    const ctx = await loadFixture(deployHesoyam);
    await open(ctx, 1n * E18, 50);
    await expect(ctx.plot.connect(ctx.alice).mint(0)).to.be.revertedWithCustomError(ctx.plot, "BadCount");
    await expect(ctx.plot.connect(ctx.alice).mint(11)).to.be.revertedWithCustomError(ctx.plot, "BadCount");
  });

  it("can never exceed the supply cap, counting owner mints too", async function () {
    const ctx = await loadFixture(deployHesoyam);
    await open(ctx, 1n * E18, 300);
    const { plot, alice, owner } = ctx;

    const cap = Number(await plot.MAX_SUPPLY());
    // Owner takes the allocation, public mint takes the rest.
    for (let i = 0; i < 6; i++) await plot.mintTo(owner.address, i % 8, 1000 + i);

    let left = cap - Number(await plot.minted());
    while (left > 0) {
      const batch = Math.min(10, left);
      await plot.connect(alice).mint(batch);
      left -= batch;
    }

    expect(await plot.minted()).to.equal(cap);
    await expect(plot.connect(alice).mint(1)).to.be.revertedWithCustomError(plot, "SupplyExhausted");
    await expect(plot.mintTo(owner.address, 0, 1)).to.be.revertedWithCustomError(plot, "SupplyExhausted");
  });

  it("gives different plots different art", async function () {
    const ctx = await loadFixture(deployHesoyam);
    await open(ctx);
    await ctx.plot.connect(ctx.alice).mint(3);
    const a = await ctx.plot.tokenURI(1);
    const b = await ctx.plot.tokenURI(2);
    const c = await ctx.plot.tokenURI(3);
    expect(a).to.not.equal(b);
    expect(b).to.not.equal(c);
  });

  it("lets the owner close the mint again", async function () {
    const ctx = await loadFixture(deployHesoyam);
    await open(ctx);
    await ctx.plot.setMint(false, await ctx.plot.mintPrice(), 5);
    await expect(ctx.plot.connect(ctx.alice).mint(1)).to.be.revertedWithCustomError(ctx.plot, "MintClosed");
  });

  it("is owner gated, and rejects a zero wallet cap", async function () {
    const { plot, alice } = await loadFixture(deployHesoyam);
    await expect(plot.connect(alice).setMint(true, 1n, 5))
      .to.be.revertedWithCustomError(plot, "OwnableUnauthorizedAccount");
    await expect(plot.setMint(true, 1n, 0)).to.be.revertedWithCustomError(plot, "BadAllocation");
  });
});

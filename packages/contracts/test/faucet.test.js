const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployHesoyam, E18 } = require("./fixture");

const AMOUNT = 5_000n * E18;
const COOLDOWN = 24 * 60 * 60;

async function deployFaucet() {
  const base = await loadFixture(deployHesoyam);
  const { hesoyam, owner } = base;
  const faucet = await ethers.deployContract("Faucet", [hesoyam.target, AMOUNT, COOLDOWN]);
  // A claim is a fixed grant, not a trade, so it is exempt the same way every
  // other protocol contract is: a tester who is quoted 5,000 gets 5,000, not
  // 4,750 with the rest quietly absorbed by the tax split. The real setup
  // script exempts it the same way, for the same reason.
  await hesoyam.setTaxExempt(faucet.target, true);
  await hesoyam.transfer(faucet.target, 50_000n * E18);
  return { ...base, faucet };
}

describe("Faucet", function () {
  it("guards the exact chain id Robinhood Chain mainnet uses", async function () {
    const { hesoyam } = await loadFixture(deployHesoyam);
    const Faucet = await ethers.getContractFactory("Faucet");

    // Hardhat's EDR network does not support spoofing block.chainid at
    // runtime (hardhat_setChainId is not implemented), so the revert branch
    // itself cannot be driven from a test. What can be checked here is that
    // the guard targets the right id, and that it does not fire on a chain
    // it should not, both of which are real, previously wrong-able facts.
    // The actual safety property this rail exists for is a deploy-process
    // one, not a runtime one: nothing in this repo ever constructs a Faucet
    // with --network robinhood, only on the local chain and on testnet.
    const faucet = await Faucet.deploy(hesoyam.target, AMOUNT, COOLDOWN);
    expect(await faucet.MAINNET_CHAIN_ID()).to.equal(4663);
    expect((await ethers.provider.getNetwork()).chainId).to.not.equal(4663);
  });

  it("pays the claimer and starts their cooldown", async function () {
    const { faucet, hesoyam, alice } = await loadFixture(deployFaucet);

    expect(await faucet.canClaim(alice.address)).to.equal(true);
    const before = await hesoyam.balanceOf(alice.address);

    await expect(faucet.connect(alice).claim())
      .to.emit(faucet, "Claimed")
      .withArgs(alice.address, AMOUNT);

    expect((await hesoyam.balanceOf(alice.address)) - before).to.equal(AMOUNT);
    expect(await faucet.canClaim(alice.address)).to.equal(false);
  });

  it("refuses a second claim before the cooldown elapses", async function () {
    const { faucet, alice } = await loadFixture(deployFaucet);
    await faucet.connect(alice).claim();

    await expect(faucet.connect(alice).claim()).to.be.revertedWithCustomError(faucet, "TooSoon");
  });

  it("allows a claim again once the cooldown has passed", async function () {
    const { faucet, hesoyam, alice } = await loadFixture(deployFaucet);
    const before = await hesoyam.balanceOf(alice.address);
    await faucet.connect(alice).claim();

    await time.increase(COOLDOWN);

    expect(await faucet.canClaim(alice.address)).to.equal(true);
    await faucet.connect(alice).claim();
    expect((await hesoyam.balanceOf(alice.address)) - before).to.equal(AMOUNT * 2n);
  });

  it("tracks cooldowns per address, not globally", async function () {
    const { faucet, alice, bob } = await loadFixture(deployFaucet);
    await faucet.connect(alice).claim();

    // Bob is unaffected by Alice's claim.
    expect(await faucet.canClaim(bob.address)).to.equal(true);
    await expect(faucet.connect(bob).claim()).to.not.be.reverted;
  });

  it("refuses to pay out once it runs dry, rather than under paying", async function () {
    const { hesoyam, owner, alice, bob } = await loadFixture(deployHesoyam);
    const faucet = await ethers.deployContract("Faucet", [hesoyam.target, AMOUNT, COOLDOWN]);
    // Funded for exactly one claim.
    await hesoyam.transfer(faucet.target, AMOUNT);

    expect(await faucet.canClaim(bob.address)).to.equal(true);
    await faucet.connect(bob).claim();

    expect(await faucet.canClaim(alice.address)).to.equal(false);
    await expect(faucet.connect(alice).claim()).to.be.revertedWithCustomError(faucet, "Dry");
  });

  it("pays out from a plain transfer in, with no privileged refill path", async function () {
    const { hesoyam, alice } = await loadFixture(deployHesoyam);
    const faucet = await ethers.deployContract("Faucet", [hesoyam.target, AMOUNT, COOLDOWN]);

    expect(await faucet.canClaim(alice.address)).to.equal(false);
    // Anyone can top it up. No owner, no allowlist, just a token transfer.
    await hesoyam.transfer(faucet.target, AMOUNT);
    expect(await faucet.canClaim(alice.address)).to.equal(true);
  });

  it("reports the correct next claim time", async function () {
    const { faucet, alice } = await loadFixture(deployFaucet);
    const before = await ethers.provider.getBlock("latest");
    await faucet.connect(alice).claim();
    const after = await ethers.provider.getBlock("latest");

    const next = await faucet.nextClaimAt(alice.address);
    expect(next).to.equal(BigInt(after.timestamp) + BigInt(COOLDOWN));
    expect(next).to.be.greaterThan(before.timestamp);
  });
});

const { ethers } = require("hardhat");

const DAY = 24 * 60 * 60;

/**
 * A hash chain, built backwards.
 *
 * chain[0] is the head that gets published. Revealing walks forward through the
 * array: round 1 reveals chain[1], round 2 reveals chain[2], and each one hashes
 * to the link before it. The operator cannot substitute a different value
 * without breaking keccak, which is the whole point.
 */
const CHAIN_SECRET = "0x" + "5a".repeat(32);
const CHAIN_LEN = 512;

function buildChain(secret, len) {
  const out = new Array(len);
  out[len - 1] = secret;
  for (let i = len - 1; i > 0; i--) {
    out[i - 1] = ethers.keccak256(out[i]);
  }
  return out;
}

/** Reveals whichever link comes next for the beacon's current round. */
async function revealNext(ctx, times = 1) {
  for (let i = 0; i < times; i++) {
    const r = Number(await ctx.beacon.round());
    await ctx.beacon.reveal(ctx.chain[r + 1]);
  }
}

/**
 * Plants and then advances the beacon, which is what a keeper does on a timer.
 *
 * A grow binds to round N+1 at plant time and cannot resolve until that round is
 * revealed. Tests that plant and immediately harvest need the round to exist, so
 * this pairs the two. Tests that want to observe an unresolved grow call plant
 * directly instead.
 */
async function plantAndReveal(ctx, user, strainId, benchId, commit) {
  const tx = await ctx.game.connect(user).plant(strainId, benchId, commit);
  const receipt = await tx.wait();
  await revealNext(ctx);
  return receipt;
}
const E18 = 10n ** 18n;
const E6 = 10n ** 6n;

/**
 * Deploys and wires the whole protocol exactly the way the launch script does.
 * Every test runs against this, so a wiring mistake fails everywhere at once
 * instead of hiding in one suite.
 */
async function deployHesoyam() {
  const [owner, creatorWallet, liquidity, ops, keeper, alice, bob, carol] = await ethers.getSigners();

  const hesoyam = await ethers.deployContract("HesoyamToken", [owner.address, owner.address]);
  const usdc = await ethers.deployContract("MockUSDC", []);
  const router = await ethers.deployContract("RevenueRouter", [owner.address, hesoyam.target, usdc.target]);

  const flower = await ethers.deployContract("Flower", [owner.address, "ipfs://flower/{id}"]);
  const card = await ethers.deployContract("StrainCard", [owner.address, "ipfs://card/"]);
  const bench = await ethers.deployContract("GrowBench", [owner.address, hesoyam.target, router.target, "ipfs://bench/"]);
  const strains = await ethers.deployContract("StrainRegistry", [owner.address]);

  const game = await ethers.deployContract("GrowGame", [
    owner.address,
    hesoyam.target,
    flower.target,
    bench.target,
    strains.target,
    router.target,
  ]);
  const plot = await ethers.deployContract("Plot", [owner.address, hesoyam.target, bench.target, router.target]);

  // Randomness. A hash chain of 512 links is plenty for a test run; production
  // commits a far longer one and rotates before it runs out.
  const beacon = await ethers.deployContract("RandomBeacon", [owner.address]);
  const chain = buildChain(CHAIN_SECRET, CHAIN_LEN);
  await beacon.commitChain(chain[0]);
  await beacon.setRevealer(owner.address, true);
  const market = await ethers.deployContract("Marketplace", [owner.address, hesoyam.target, flower.target, router.target]);
  const dispensary = await ethers.deployContract("Dispensary", [owner.address, usdc.target, flower.target, router.target]);
  const crafter = await ethers.deployContract("CardCrafter", [
    owner.address,
    hesoyam.target,
    flower.target,
    card.target,
    router.target,
  ]);
  const vault = await ethers.deployContract("StakingVault", [owner.address, hesoyam.target, usdc.target]);

  // Swap venue stand-in: 1 HESOYAM = 0.40 USDC.
  const adapter = await ethers.deployContract("MockSwapAdapter", [hesoyam.target, usdc.target, 400_000n]);
  await usdc.mint(adapter.target, 50_000_000n * E6);

  // --- roles ---------------------------------------------------------------
  await flower.setMinter(game.target, true);
  await flower.setBurner(crafter.target, true);
  await flower.setBurner(dispensary.target, true);
  await card.setMinter(crafter.target, true);

  await vault.setConfig(card.target, router.target, router.target);
  await router.setSinks(vault.target, dispensary.target, liquidity.address, ops.address);
  await router.setSwapAdapter(adapter.target);
  await dispensary.setKeeper(keeper.address, true);

  // --- tax ------------------------------------------------------------------
  await hesoyam.setTaxRecipients(creatorWallet.address, router.target);
  for (const c of [router, vault, game, market, dispensary, crafter, bench, adapter, plot]) {
    await hesoyam.setTaxExempt(c.target, true);
  }
  await game.setBeacon(beacon.target);
  await hesoyam.enableTax();

  // --- content --------------------------------------------------------------
  // Strain 0: reliable workhorse, events never fire, used for deterministic tests.
  await strains.addStrain("Northern Lights", 7 * DAY, 100, 10_000, 0, 10, 120n * E18);
  // Strain 1: high risk, every event slot fires.
  await strains.addStrain("Sour Diesel", 7 * DAY, 120, 11_000, 255, 14, 160n * E18);
  // Strain 2: fast cycle for timing tests.
  await strains.addStrain("Autoflower", 2 * DAY, 60, 9_000, 0, 4, 60n * E18);

  await bench.openTranche(0, 500n * E18, 1000); // tranche 0, basic
  await bench.openTranche(2, 2_000n * E18, 100); // tranche 1, top tier

  // --- funding --------------------------------------------------------------
  for (const user of [alice, bob, carol]) {
    await hesoyam.transfer(user.address, 2_000_000n * E18);
    await hesoyam.connect(user).approve(game.target, ethers.MaxUint256);
    await hesoyam.connect(user).approve(bench.target, ethers.MaxUint256);
    await hesoyam.connect(user).approve(market.target, ethers.MaxUint256);
    await hesoyam.connect(user).approve(crafter.target, ethers.MaxUint256);
    await hesoyam.connect(user).approve(vault.target, ethers.MaxUint256);
    await flower.connect(user).setApprovalForAll(market.target, true);
    await flower.connect(user).setApprovalForAll(dispensary.target, true);
    await flower.connect(user).setApprovalForAll(crafter.target, true);
    await card.connect(user).setApprovalForAll(vault.target, true);
  }

  return {
    owner, creatorWallet, liquidity, ops, keeper, alice, bob, carol,
    creator: creatorWallet.address,
    hesoyam, usdc, router, flower, card, bench, strains, game, market, dispensary, crafter, vault, adapter, plot,
    beacon, chain,
  };
}

/** Commit hash the GrowGame expects for a given salt. */
function commitFor(salt) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [salt]));
}

function randomSalt() {
  return ethers.hexlify(ethers.randomBytes(32));
}

/** Buys a bench from a tranche and returns its token id. */
async function buyBench(ctx, user, trancheId = 0) {
  const tx = await ctx.bench.connect(user).buy(trancheId);
  const receipt = await tx.wait();
  const log = receipt.logs
    .map((l) => { try { return ctx.bench.interface.parseLog(l); } catch { return null; } })
    .find((l) => l && l.name === "BenchSold");
  return log.args.tokenId;
}

module.exports = { deployHesoyam, buildChain, revealNext, plantAndReveal, CHAIN_SECRET, CHAIN_LEN, commitFor, randomSalt, buyBench, DAY, E18, E6 };

/* eslint-disable no-console */
/**
 * Drives a full economic cycle against a running local node so the indexer has real
 * events to read: a bench sale, a grow with feeding and a pest treatment, a harvest,
 * a marketplace fill, a Dispensary sale, a craft, a stake, a sweep and a claim.
 *
 * Run against `npm run node -w @hesoyam/contracts` in another terminal:
 *   npm run seed -w @hesoyam/contracts
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const E18 = 10n ** 18n;
const DAY = 24 * 60 * 60;

async function jump(seconds) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine", []);
}

async function jumpTo(timestamp) {
  await network.provider.send("evm_setNextBlockTimestamp", [Number(timestamp)]);
  await network.provider.send("evm_mine", []);
}

function commitFor(salt) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [salt]));
}

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) throw new Error(`No deployment record at ${file}. Deploy first.`);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  const a = record.addresses;

  const [owner, alice, bob] = await ethers.getSigners();
  console.log(`Seeding ${network.name} as ${owner.address}`);

  const hesoyam = await ethers.getContractAt("HesoyamToken", a.hesoyam);
  const usdc = await ethers.getContractAt("MockUSDC", a.settlement);
  const router = await ethers.getContractAt("RevenueRouter", a.router);
  const vault = await ethers.getContractAt("StakingVault", a.vault);
  const flower = await ethers.getContractAt("Flower", a.flower);
  const bench = await ethers.getContractAt("GrowBench", a.bench);
  const game = await ethers.getContractAt("GrowGame", a.game);
  const market = await ethers.getContractAt("Marketplace", a.marketplace);
  const dispensary = await ethers.getContractAt("Dispensary", a.dispensary);
  const crafter = await ethers.getContractAt("CardCrafter", a.crafter);
  const strains = await ethers.getContractAt("StrainRegistry", a.strains);
  const card = await ethers.getContractAt("StrainCard", a.strainCard);

  // A swap venue, which the deploy script deliberately leaves unset.
  const adapter = await ethers.deployContract("MockSwapAdapter", [hesoyam.target, usdc.target, 400000n]);
  await adapter.waitForDeployment();
  await (await usdc.mint(adapter.target, 10_000_000n * 10n ** 6n)).wait();
  await (await hesoyam.setTaxExempt(adapter.target, true)).wait();
  await (await router.setSwapAdapter(adapter.target)).wait();
  // A zero cooldown is no longer settable: an owner could otherwise set it to
  // zero and drain the router in a loop. The seed advances time instead.
  await (await router.setGuards(2_000_000n * E18, 3600, 200)).wait();

  // The beacon. A hash chain of 256 links, committed head first, with this
  // script acting as the keeper. In production the chain is far longer and the
  // revealer runs on a timer from a separate key.
  const beacon = await ethers.getContractAt("RandomBeacon", a.beacon);

  // The beacon may already be committed by beacon-setup.js, which is the real
  // production shape: a separate operator holds the secret and a keeper reveals
  // on a timer. Only take it over when nothing else has.
  const alreadyCommitted = (await beacon.head()) !== ethers.ZeroHash;
  let chain = null;

  if (alreadyCommitted) {
    console.log("  beacon already committed, waiting on the external keeper");
  } else {
    chain = new Array(256);
    chain[255] = ethers.keccak256(ethers.toUtf8Bytes("hesoyam-seed-chain"));
    for (let i = 255; i > 0; i--) chain[i - 1] = ethers.keccak256(chain[i]);
    await (await beacon.commitChain(chain[0])).wait();
    await (await beacon.setRevealer(owner.address, true)).wait();
    console.log("  beacon chain committed, acting as keeper");
  }

  /**
   * Advances the beacon past the round a fresh grow is bound to.
   *
   * When this script owns the chain it reveals directly. When somebody else
   * does, it waits for their keeper, because two revealers racing the same
   * chain would just revert each other.
   */
  const revealNext = async () => {
    if (chain) {
      const r = Number(await beacon.round());
      await (await beacon.reveal(chain[r + 1])).wait();
      return;
    }
    const start = Number(await beacon.round());
    for (let i = 0; i < 120; i++) {
      if (Number(await beacon.round()) > start) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("The beacon did not advance. Is the keeper running?");
  };
  console.log("  swap adapter wired");

  // A fast strain so a whole cycle fits in one seeding run.
  await (await strains.addStrain("Seeder Kush", 2 * DAY, 2000, 10_000, 0, 6, 10n * E18)).wait();
  const strainId = Number(await strains.count()) - 1;

  for (const user of [alice, bob]) {
    await (await hesoyam.transfer(user.address, 500_000n * E18)).wait();
    for (const target of [game.target, bench.target, market.target, crafter.target, vault.target]) {
      await (await hesoyam.connect(user).approve(target, ethers.MaxUint256)).wait();
    }
    await (await flower.connect(user).setApprovalForAll(market.target, true)).wait();
    await (await flower.connect(user).setApprovalForAll(dispensary.target, true)).wait();
    await (await flower.connect(user).setApprovalForAll(crafter.target, true)).wait();
    await (await card.connect(user).setApprovalForAll(vault.target, true)).wait();
  }
  console.log("  players funded");

  // --- grow -----------------------------------------------------------------
  const buyTx = await bench.connect(alice).buy(2);
  const buyReceipt = await buyTx.wait();
  const benchId = buyReceipt.logs
    .map((l) => {
      try {
        return bench.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((l) => l && l.name === "BenchSold").args.tokenId;

  const salt = ethers.hexlify(ethers.randomBytes(32));
  await (await game.connect(alice).plant(strainId, benchId, commitFor(salt))).wait();
  await revealNext();
  const growId = (await game.nextGrowId()) - 1n;
  const plantedAt = Number((await game.grows(growId)).plantedAt);
  console.log(`  planted grow ${growId} on bench ${benchId}`);

  const cycle = 2 * DAY;
  for (let i = 0; i < 3; i++) {
    const centre = plantedAt + Math.floor((cycle * (2 * i + 1)) / 7);
    await jumpTo(centre);
    await (await game.connect(alice).feed(growId, i)).wait();
  }
  console.log("  fed three windows");

  await jumpTo(plantedAt + cycle + 1);
  await (await game.connect(alice).harvest(growId, salt, false)).wait();

  let tokenId = null;
  let held = 0n;
  for (let tier = 0; tier < 3; tier++) {
    const id = BigInt(strainId) * 4n + BigInt(tier);
    const bal = await flower.balanceOf(alice.address, id);
    if (bal > 0n) {
      tokenId = id;
      held = bal;
    }
  }
  console.log(`  harvested ${held} units as token ${tokenId}`);

  // --- market ---------------------------------------------------------------
  await (await market.connect(alice).list(tokenId, held / 2n, 3n * E18)).wait();
  const listingId = (await market.nextListingId()) - 1n;
  await (await market.connect(bob).buy(listingId, 400n)).wait();
  console.log(`  bob filled 400 units of listing ${listingId}`);

  // --- craft ----------------------------------------------------------------
  await (await crafter.connect(bob).requestCraft(strainId, Number(tokenId % 4n))).wait();
  const requestId = (await crafter.nextRequestId()) - 1n;
  await network.provider.send("evm_mine", []);
  await network.provider.send("evm_mine", []);
  await network.provider.send("evm_mine", []);
  await (await crafter.finalizeCraft(requestId)).wait();
  console.log(`  crafted a card from request ${requestId}`);

  // --- stake ----------------------------------------------------------------
  await (await vault.connect(alice).stake(20_000n * E18, 3)).wait();
  await (await vault.connect(bob).stake(10_000n * E18, 1)).wait();
  await (await vault.connect(bob).equipCard(1)).wait();
  console.log("  staked and equipped");

  // --- revenue --------------------------------------------------------------
  // Ordinary taxed trading between two players, on top of the game fees already paid.
  await (await hesoyam.connect(alice).transfer(bob.address, 25_000n * E18)).wait();
  await (await hesoyam.connect(bob).transfer(alice.address, 15_000n * E18)).wait();

  await (await router.sweep(0)).wait();
  console.log("  swept revenue into both rails");

  await (await vault.connect(alice).claim()).wait();
  console.log("  alice claimed");

  // --- dispensary -----------------------------------------------------------
  await (await dispensary.setReferenceAdmin(Number(tokenId % 4n), 1_000_000n)).wait();
  const absorbable = await dispensary.absorbableUnits(Number(tokenId % 4n));
  const remaining = await flower.balanceOf(alice.address, tokenId);
  const toSell = remaining < absorbable ? remaining : absorbable;
  if (toSell > 0n) {
    await (await dispensary.connect(alice).sell(strainId, Number(tokenId % 4n), toSell)).wait();
    console.log(`  alice sold ${toSell} units into the Dispensary bid`);
  } else {
    console.log("  Dispensary budget could not absorb any units this run");
  }

  await jump(60);

  // The plot rail. Mint a small block of ground, let alice rent one for her
  // bench, and fuse a pair so the supply sink runs at least once per seed.
  const plot = await ethers.getContractAt("Plot", a.plot);
  // Districts are chosen so there is a fusable pair that is not the plot being
  // rented. Two plots can only fuse if they share a district and neither is let.
  const districts = [0, 1, 1, 2, 5, 5];
  for (let i = 0; i < 6; i++) {
    await (await plot.mintTo(i < 4 ? bob.address : alice.address, districts[i], 1000 + i * 7717)).wait();
  }
  await (await hesoyam.connect(alice).approve(plot.target, ethers.MaxUint256)).wait();
  // site() now requires the caller to own the bench and pins the price, so
  // quote it first and pass alice bench.
  const siteCost = (await plot.rateOf(1)) * 14n;
  await (await plot.connect(alice).site(1, benchId, 14, siteCost)).wait();
  console.log("  alice sited bench 1 on plot 1 for 14 days");

  const owed = await plot.rentOwed(bob.address);
  if (owed > 0n) {
    await (await plot.connect(bob).claimRent()).wait();
    console.log(`  bob claimed ${ethers.formatUnits(owed, 18)} HESOYAM of plot rent`);
  }

  await (await hesoyam.connect(bob).approve(plot.target, ethers.MaxUint256)).wait();
  await (await plot.connect(bob).fuse(2, 3)).wait(); // both district 1, neither let
  console.log(`  bob fused two plots, supply is now ${await plot.totalSupply()}`);

  await jump(60);

  const head = await ethers.provider.getBlockNumber();
  console.log(`\nSeeded. Chain head is block ${head}.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

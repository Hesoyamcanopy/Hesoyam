/**
 * Sets up a local chain you can actually browse.
 *
 * The seed script proves the economy runs. This one is for looking at: it gives
 * one wallet several benches with grows at deliberately different stages, so the
 * grow room has plants at every size rather than one seedling, and so every
 * button in the interface has something to act on.
 *
 * Local chains only. It fast forwards time, which is not a thing you can do
 * anywhere real.
 *
 * Usage: npm run demo
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const E18 = 10n ** 18n;
const DAY = 24 * 60 * 60;

// Alice is the wallet to import into a browser wallet. Everything lands on her.
const ALICE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

async function main() {
  if (network.name !== "localhost" && network.name !== "hardhat") {
    throw new Error("demo only runs on a local chain, it fast forwards time");
  }

  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const a = JSON.parse(fs.readFileSync(file, "utf8")).addresses;
  const [owner, alice] = await ethers.getSigners();

  const hesoyam = await ethers.getContractAt("HesoyamToken", a.hesoyam);
  const bench = await ethers.getContractAt("GrowBench", a.bench);
  const game = await ethers.getContractAt("GrowGame", a.game);
  const plot = await ethers.getContractAt("Plot", a.plot);
  const beacon = await ethers.getContractAt("RandomBeacon", a.beacon);
  const registry = await ethers.getContractAt("StrainRegistry", a.strains);

  console.log(`\nBuilding a browsable chain for ${ALICE}\n`);

  // Owner is tax exempt, so this arrives whole.
  await (await hesoyam.transfer(ALICE, 400_000n * E18)).wait();
  for (const target of [a.game, a.bench, a.plot, a.marketplace, a.crafter, a.vault]) {
    await (await hesoyam.connect(alice).approve(target, ethers.MaxUint256)).wait();
  }
  console.log("  funded and approved");

  // Open the mint so the panel is usable, and give her ground to site on.
  if (!(await plot.mintOpen())) {
    await (await plot.setMint(true, 5_000n * E18, 5)).wait();
  }
  const owned = Number(await plot.balanceOf(ALICE));
  if (owned < 2) {
    await (await plot.connect(alice).mint(2)).wait();
  }
  console.log(`  holds ${await plot.balanceOf(ALICE)} plot(s), mint is open`);

  // A strain that actually fires events, so the room has something to respond to.
  const n = Number(await registry.count());
  let strainId = 0;
  let bestChance = 0;
  for (let i = 0; i < n; i++) {
    const core = await registry.core(i);
    if (core[6] && Number(core[3]) > bestChance) {
      bestChance = Number(core[3]);
      strainId = i;
    }
  }
  const cycle = Number((await registry.core(strainId))[0]);

  /**
   * Four benches, planted at staggered times so the room shows a plant at every
   * growth stage at once. Planted newest first, then time is wound forward, so
   * the oldest ends up nearly ready.
   */
  const stages = [
    { label: "almost ready, tended", agedDays: 6.5, tend: true },
    { label: "flowering, tended", agedDays: 4, tend: true },
    { label: "vegetative, neglected", agedDays: 2, tend: false },
    { label: "just planted", agedDays: 0, tend: true },
  ];

  const salts = {};
  let planted = 0;

  for (const stage of stages) {
    const r = await (await bench.connect(alice).buy(0)).wait();
    const ev = r.logs
      .map((l) => { try { return bench.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === "BenchSold");
    const benchId = ev.args.tokenId;

    const salt = ethers.hexlify(ethers.randomBytes(32));
    const commit = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [salt]));
    const before = Number(await beacon.round());

    await (await game.connect(alice).plant(strainId, benchId, commit)).wait();

    // The grow cannot resolve until its round lands. Wait for the keeper rather
    // than revealing here, because racing it would just revert.
    const waitedFrom = Date.now();
    while (Number(await beacon.round()) <= before) {
      if (Date.now() - waitedFrom > 180_000) {
        throw new Error("the beacon did not advance. Is the keeper running?");
      }
      await new Promise((r) => setTimeout(r, 3000));
    }

    const growId = (await game.nextGrowId()) - 1n;
    salts[`${a.game}:${benchId}`] = salt;
    planted++;

    // Walk forward through the schedule rather than jumping over it, so the
    // windows are actually reachable. A jump straight to the target age lands
    // after every window has closed and leaves the plant neglected.
    if (stage.agedDays > 0) {
      const plantedAt = (await ethers.provider.getBlock("latest")).timestamp;
      const until = plantedAt + Math.floor(stage.agedDays * DAY);

      const jobs = [];
      for (let w = 0; w < 3; w++) {
        const win = await game.feedWindow(growId, w);
        jobs.push({ kind: "feed", i: w, at: Number(win.opensAt) + 60, closes: Number(win.closesAt) });
      }
      const fires = Number(await game.firedMask(growId));
      for (let slot = 0; slot < 3; slot++) {
        if (!(fires & (1 << slot))) continue;
        const win = await game.eventWindow(growId, slot);
        jobs.push({ kind: "treat", i: slot, at: Number(win.opensAt) + 60, closes: Number(win.closesAt) });
      }
      jobs.sort((x, y) => x.at - y.at);

      for (const j of jobs) {
        if (j.at > until) break;
        const now = (await ethers.provider.getBlock("latest")).timestamp;
        const at = Math.max(j.at, now + 1);
        if (at > j.closes) continue;
        await ethers.provider.send("evm_setNextBlockTimestamp", [at]);
        await ethers.provider.send("evm_mine", []);
        // A neglected plant is left alone on purpose, so the room shows both.
        if (!stage.tend) continue;
        if (j.kind === "feed") await (await game.connect(alice).feed(growId, j.i)).wait();
        else await (await game.connect(alice).treat(growId, j.i)).wait();
      }

      const now = (await ethers.provider.getBlock("latest")).timestamp;
      if (until > now) {
        await ethers.provider.send("evm_setNextBlockTimestamp", [until]);
        await ethers.provider.send("evm_mine", []);
      }
    }

    const [care, damage] = await game.careScore(growId);
    const pct = Math.min(100, Math.round(((stage.agedDays * DAY) / cycle) * 100));
    console.log(
      `  bench ${benchId}: ${stage.label.padEnd(22)} ~${String(pct).padStart(3)}% grown, care ${String(care).padStart(3)}, damage ${damage} bps`
    );
  }

  // The salts live in the browser, so print them for pasting.
  const saltFile = path.join(__dirname, "..", "..", "..", "demo-salts.json");
  fs.writeFileSync(saltFile, JSON.stringify(salts, null, 2));

  console.log(`\n  ${planted} grows planted at staggered stages`);
  console.log(`  chain is now at ${new Date((await ethers.provider.getBlock("latest")).timestamp * 1000).toISOString()}`);
  console.log(`\nSalts written to demo-salts.json.`);
  console.log(`To harvest in the browser, open the console on /app/grow and run:\n`);
  console.log(`  localStorage.setItem("hesoyam.salts.v1", ${JSON.stringify(JSON.stringify(salts))})\n`);
  console.log(`Then reload. Advance time with: npm run warp -- --network localhost\n`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});

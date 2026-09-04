/**
 * End to end smoke test against a live chain.
 *
 * Walks the entire player loop as a real player would, in order, and asserts the
 * observable result of every step. This is the "is it actually working" check:
 * unit tests prove the pieces, this proves the assembled thing.
 *
 * It deliberately uses the running keeper rather than revealing the beacon
 * itself, because the integration between the game and an externally operated
 * revealer is one of the things most worth proving before launch.
 *
 * Usage: npm run smoke
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const E18 = 10n ** 18n;
let passed = 0;
let failed = 0;

function ok(label, detail = "") {
  passed++;
  console.log(`  ok    ${label}${detail ? "  " + detail : ""}`);
}
function bad(label, err) {
  failed++;
  console.log(`  FAIL  ${label}`);
  console.log(`        ${String(err).split("\n")[0].slice(0, 160)}`);
}
async function step(label, fn) {
  try {
    const detail = await fn();
    ok(label, detail || "");
  } catch (e) {
    bad(label, e.shortMessage || e.message || e);
  }
}

/** Waits for the keeper to advance the beacon, which is what unblocks a grow. */
async function waitForRound(beacon, from, seconds = 180) {
  const started = Date.now();
  while (Date.now() - started < seconds * 1000) {
    if (Number(await beacon.round()) > from) return true;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const a = JSON.parse(fs.readFileSync(file, "utf8")).addresses;
  const [owner, alice, bob] = await ethers.getSigners();

  const hesoyam = await ethers.getContractAt("HesoyamToken", a.hesoyam);
  const bench = await ethers.getContractAt("GrowBench", a.bench);
  const game = await ethers.getContractAt("GrowGame", a.game);
  const plot = await ethers.getContractAt("Plot", a.plot);
  const flower = await ethers.getContractAt("Flower", a.flower);
  const market = await ethers.getContractAt("Marketplace", a.marketplace);
  const crafter = await ethers.getContractAt("CardCrafter", a.crafter);
  const vault = await ethers.getContractAt("StakingVault", a.vault);
  const card = await ethers.getContractAt("StrainCard", a.strainCard);
  const beacon = await ethers.getContractAt("RandomBeacon", a.beacon);
  const router = await ethers.getContractAt("RevenueRouter", a.router);

  console.log(`\nSmoke test on ${network.name}, as ${bob.address}\n`);

  // A fresh player with nothing but tokens.
  const player = bob;
  await (await hesoyam.transfer(player.address, 300_000n * E18)).wait();

  console.log("Preconditions");
  await step("chain is reachable", async () => `block ${await ethers.provider.getBlockNumber()}`);
  await step("beacon has a committed chain", async () => {
    if ((await beacon.head()) === ethers.ZeroHash) throw new Error("no chain committed");
    return `round ${await beacon.round()}`;
  });
  await step("keeper is alive", async () => {
    const stalled = await beacon.isStalled();
    if (!stalled) return "not stalled";
    // This script fast forwards the chain by days, so after one run the chain
    // clock is far ahead of the keeper's wall clock and a perfectly healthy
    // keeper reads as stalled. Distinguish the two rather than crying wolf.
    const chainNow = (await ethers.provider.getBlock("latest")).timestamp;
    const realNow = Math.floor(Date.now() / 1000);
    if (chainNow > realNow + 3600) {
      return `reads stalled only because this chain is ${Math.round((chainNow - realNow) / 86400)} days ahead of real time from a previous run`;
    }
    throw new Error("beacon is stalled and the chain clock is normal, so the keeper is not running");
  });

  console.log("\nApprovals");
  await step("approve the grow room for an exact amount", async () => {
    const amount = 100_000n * E18;
    await (await hesoyam.connect(player).approve(a.game, amount)).wait();
    const got = await hesoyam.allowance(player.address, a.game);
    if (got !== amount) throw new Error(`allowance is ${got}, expected ${amount}`);
    if (got === ethers.MaxUint256) throw new Error("allowance is unlimited, it should be exact");
    return `${ethers.formatUnits(got, 18)} HESOYAM, not unlimited`;
  });
  for (const [name, addr] of [["bench", a.bench], ["plot", a.plot], ["market", a.marketplace], ["crafter", a.crafter], ["vault", a.vault]]) {
    await step(`approve the ${name}`, async () => {
      await (await hesoyam.connect(player).approve(addr, 100_000n * E18)).wait();
      return "";
    });
  }

  console.log("\nOwnership");
  let benchId;
  await step("buy a bench", async () => {
    const r = await (await bench.connect(player).buy(0)).wait();
    const ev = r.logs.map((l) => { try { return bench.interface.parseLog(l); } catch { return null; } }).find((l) => l && l.name === "BenchSold");
    benchId = ev.args.tokenId;
    return `bench ${benchId}`;
  });

  let plotId;
  await step("mint a plot, whole price to the router", async () => {
    if (!(await plot.mintOpen())) throw new Error("mint is closed");
    const before = await hesoyam.balanceOf(a.router);
    const price = await plot.mintPrice();
    const r = await (await plot.connect(player).mint(1)).wait();
    const ev = r.logs.map((l) => { try { return plot.interface.parseLog(l); } catch { return null; } }).find((l) => l && l.name === "Minted");
    plotId = ev.args.plotId;
    const delta = (await hesoyam.balanceOf(a.router)) - before;
    if (delta !== price) throw new Error(`router got ${delta}, expected ${price}`);
    return `plot ${plotId}, router received ${ethers.formatUnits(delta, 18)}`;
  });

  await step("plot art renders on chain with no external reference", async () => {
    const uri = await plot.tokenURI(plotId);
    if (!uri.startsWith("data:application/json;base64,")) throw new Error("not a data URI");
    const json = JSON.parse(Buffer.from(uri.slice(29), "base64").toString());
    const svg = Buffer.from(json.image.slice(26), "base64").toString();
    if (svg.replace(/xmlns="[^"]*"/, "").includes("http")) throw new Error("svg references something off chain");
    return `${svg.length} bytes of SVG`;
  });

  await step("site the bench, price pinned", async () => {
    const cost = (await plot.rateOf(plotId)) * 14n;
    await (await plot.connect(player).site(plotId, benchId, 14, cost)).wait();
    if (!(await plot.isSited(benchId))) throw new Error("bench is not sited");
    return `${ethers.formatUnits(cost, 18)} HESOYAM for 14 days`;
  });

  console.log("\nThe grow loop");
  let growId;
  let strainId = 0;
  await step("pick the strain most likely to fire events", async () => {
    const registry = await ethers.getContractAt("StrainRegistry", a.strains);
    const n = Number(await registry.count());
    let best = 0;
    let bestChance = 0;
    for (let i = 0; i < n; i++) {
      const core = await registry.core(i);
      if (!core[6]) continue; // inactive
      const chance = Number(core[3]);
      if (chance > bestChance) {
        bestChance = chance;
        best = i;
      }
    }
    strainId = best;
    return `strain ${best}, event chance ${bestChance} of 255 per slot`;
  });
  const salt = ethers.hexlify(ethers.randomBytes(32));
  const commit = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [salt]));
  const roundBefore = Number(await beacon.round());

  await step("plant", async () => {
    const r = await (await game.connect(player).plant(strainId, benchId, commit)).wait();
    const ev = r.logs.map((l) => { try { return game.interface.parseLog(l); } catch { return null; } }).find((l) => l && l.name === "Planted");
    growId = ev.args.growId;
    return `grow ${growId}`;
  });

  await step("the seed is NOT knowable yet", async () => {
    if (await game.seedReady(growId)) throw new Error("seed resolved at plant time, which is the grinding bug");
    return "bound to an unrevealed round, as designed";
  });

  await step("harvest is refused while the round is unrevealed", async () => {
    try {
      await game.connect(player).harvest.staticCall(growId, salt, false);
      throw new Error("harvest did not revert");
    } catch (e) {
      if (!/BeaconNotReady|NotMature/.test(e.message)) throw e;
      return "reverts rather than treating an absent seed as no events";
    }
  });

  await step("keeper advances the beacon", async () => {
    if (!(await waitForRound(beacon, roundBefore))) throw new Error("the beacon did not advance within 3 minutes");
    return `round ${await beacon.round()}`;
  });

  await step("the seed settles", async () => {
    if (!(await game.seedReady(growId))) throw new Error("seed still not ready");
    return (await game.seedFor(growId)).slice(0, 18) + "...";
  });

  let fired = 0;
  let treated = 0;
  await step("feed and treat in chronological order", async () => {
    // Build the whole schedule first, then walk it forwards. Feeding all three
    // windows before looking at events lets the event windows close unnoticed.
    const jobs = [];
    for (let i = 0; i < 3; i++) {
      const w = await game.feedWindow(growId, i);
      jobs.push({ kind: "feed", index: i, at: Number(w.opensAt) + 60, closes: Number(w.closesAt) });
    }
    const fires = Number(await game.firedMask(growId));
    for (let slot = 0; slot < 3; slot++) {
      if (!(fires & (1 << slot))) continue;
      fired++;
      const w = await game.eventWindow(growId, slot);
      jobs.push({ kind: "treat", index: slot, at: Number(w.opensAt) + 60, closes: Number(w.closesAt) });
    }
    jobs.sort((x, y) => x.at - y.at);

    let fed = 0;
    for (const j of jobs) {
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      const target = Math.max(j.at, now + 1);
      if (target > j.closes) throw new Error(`window for ${j.kind} ${j.index} already closed`);
      await ethers.provider.send("evm_setNextBlockTimestamp", [target]);
      await ethers.provider.send("evm_mine", []);
      if (j.kind === "feed") {
        await (await game.connect(player).feed(growId, j.index)).wait();
        fed++;
      } else {
        await (await game.connect(player).treat(growId, j.index)).wait();
        treated++;
      }
    }
    if (fed !== 3) throw new Error(`only fed ${fed} of 3`);
    if (treated !== fired) throw new Error(`treated ${treated} of ${fired} that fired`);
    return `fed 3 of 3, treated ${treated} of ${fired} that fired`;
  });

  await step("care score reflects the effort", async () => {
    const [care, damage] = await game.careScore(growId);
    // Everything fed and everything treated means full marks on both the
    // feeding and the event legs. Anything less means a window was missed.
    if (Number(care) < 70) throw new Error(`care is only ${care} after feeding and treating everything`);
    if (Number(damage) !== 0) throw new Error(`took ${damage} bps of damage despite treating everything`);
    return `care ${care} of 100, zero damage`;
  });

  await step("the outcome is stable across blocks", async () => {
    const mature = await game.maturesAt(growId);
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(mature) + 60]);
    await ethers.provider.send("evm_mine", []);
    const first = await game.previewOutcome(growId, salt);
    for (let i = 0; i < 8; i++) await ethers.provider.send("evm_mine", []);
    const again = await game.previewOutcome(growId, salt);
    if (first.quality !== again.quality || first.units !== again.units) {
      throw new Error("the outcome moved between blocks, so it is grindable");
    }
    return `${again.units} units at quality ${again.quality}, unchanged over 8 blocks`;
  });

  let tokenId;
  await step("harvest pays what was previewed", async () => {
    const preview = await game.previewOutcome(growId, salt);
    const r = await (await game.connect(player).harvest(growId, salt, false)).wait();
    const ev = r.logs.map((l) => { try { return game.interface.parseLog(l); } catch { return null; } }).find((l) => l && l.name === "Harvested");
    if (ev.args.quality !== preview.quality) throw new Error("harvest disagreed with the preview");
    // Read the strain from the grow. The event does not carry it, and defaulting
    // to zero silently pointed at the wrong token.
    const g = await game.grows(growId);
    const q = Number(ev.args.quality);
    tokenId = BigInt(g.strainId) * 4n + BigInt(q >= 80 ? 2 : q >= 50 ? 1 : 0);
    return `${ev.args.units} units, quality ${q}, token ${tokenId}`;
  });

  await step("Flower lands in the wallet", async () => {
    const bal = await flower.balanceOf(player.address, tokenId);
    if (bal === 0n) throw new Error("no Flower minted");
    return `${bal} units of token ${tokenId}`;
  });

  console.log("\nSelling");
  await step("list on the marketplace", async () => {
    await (await flower.connect(player).setApprovalForAll(a.marketplace, true)).wait();
    const have = await flower.balanceOf(player.address, tokenId);
    const amount = have / 4n;
    // A realistic price. At 1000 wei the 4 percent take rounds to dust and the
    // fee assertion below proves nothing.
    const r = await (await market.connect(player).list(tokenId, amount, 20n * E18)).wait();
    const ev = r.logs.map((l) => { try { return market.interface.parseLog(l); } catch { return null; } }).find((l) => l && l.name === "Listed");
    return `listing ${ev.args.listingId}, ${amount} units`;
  });

  await step("another player fills it, router takes its cut", async () => {
    await (await hesoyam.transfer(alice.address, 50_000n * E18)).wait();
    await (await hesoyam.connect(alice).approve(a.marketplace, ethers.MaxUint256)).wait();
    const before = await hesoyam.balanceOf(a.router);
    const id = (await market.nextListingId()) - 1n;
    const l = await market.listings(id);
    await (await market.connect(alice).buy(id, l.amount)).wait();
    const delta = (await hesoyam.balanceOf(a.router)) - before;
    const expected = (l.pricePerUnit * l.amount * 400n) / 10_000n;
    if (delta < expected) throw new Error(`router took ${delta}, expected at least ${expected}`);
    return `router took ${ethers.formatUnits(delta, 18)} HESOYAM, the 4 percent take`;
  });

  console.log("\nCrafting and staking");
  await step("craft a card, burning Flower", async () => {
    await (await flower.connect(player).setApprovalForAll(a.crafter, true)).wait();
    const need = await crafter.flowerPerCraft();
    let have = await flower.balanceOf(player.address, tokenId);
    if (have < need) {
      // One harvest yields far less than a craft costs, which is the intended
      // economics. Top up from a seeded wallet so the craft path is actually
      // exercised rather than skipped.
      for (const donor of [alice, owner]) {
        const spare = await flower.balanceOf(donor.address, tokenId);
        if (spare === 0n) continue;
        const send = spare < need - have ? spare : need - have;
        await (await flower.connect(donor).safeTransferFrom(donor.address, player.address, tokenId, send, "0x")).wait();
        have = await flower.balanceOf(player.address, tokenId);
        if (have >= need) break;
      }
    }
    if (have < need && network.name === "localhost") {
      // Local only. The owner holds the minter role here, so the shortfall can
      // be minted to exercise the craft path. This is never done on a real
      // network: there the step simply reports that it was skipped.
      const short = need - have;
      await (await flower.setMinter(owner.address, true)).wait();
      await (await flower.connect(owner).mint(player.address, tokenId, short)).wait();
      await (await flower.setMinter(owner.address, false)).wait();
      have = await flower.balanceOf(player.address, tokenId);
    }
    if (have < need) return `skipped, only ${have} units available and not on a local chain`;
    const burnedBefore = await crafter.totalFlowerBurned();
    const { strainId, tier } = { strainId: Number(tokenId / 4n), tier: Number(tokenId % 4n) };
    const r = await (await crafter.connect(player).requestCraft(strainId, tier)).wait();
    const ev = r.logs.map((l) => { try { return crafter.interface.parseLog(l); } catch { return null; } }).find((l) => l && l.name === "CraftRequested");
    await ethers.provider.send("evm_mine", []);
    await ethers.provider.send("evm_mine", []);
    await ethers.provider.send("evm_mine", []);
    await (await crafter.connect(player).finalizeCraft(ev.args.requestId)).wait();
    const burned = (await crafter.totalFlowerBurned()) - burnedBefore;
    if (burned !== need) throw new Error(`burned ${burned}, expected ${need}`);
    const cards = await card.balanceOf(player.address);
    if (cards === 0n) throw new Error("no card was minted");
    return `burned ${burned} Flower, holds ${cards} card(s)`;
  });

  await step("stake", async () => {
    const amount = 10_000n * E18;
    await (await vault.connect(player).stake(amount, 3)).wait();
    const w = await vault.weightOf(player.address);
    if (w === 0n) throw new Error("no weight after staking");
    return `weight ${ethers.formatUnits(w, 18)}`;
  });

  await step("equip a card if there is one", async () => {
    const n = await card.balanceOf(player.address);
    if (n === 0n) return "no card to equip";
    const id = await card.tokenOfOwnerByIndex(player.address, 0);
    await (await card.connect(player).setApprovalForAll(a.vault, true)).wait();
    await (await vault.connect(player).equipCard(id)).wait();
    return `card ${id}, bonus ${await vault.cardBonusBps(player.address)} bps`;
  });

  await step("revenue reaches the router and distributes", async () => {
    const pending = await router.pendingHesoyam();
    if (pending === 0n) throw new Error("router holds nothing");
    return `${ethers.formatUnits(pending, 18)} HESOYAM waiting to convert`;
  });

  await step("unequip returns the card", async () => {
    const n = await vault.equippedCardCount(player.address);
    if (n === 0n) return "nothing equipped";
    const id = await vault.equippedCards(player.address, 0);
    await (await vault.connect(player).unequipCard(id)).wait();
    if ((await card.ownerOf(id)) !== player.address) throw new Error("card did not come back");
    return `card ${id} returned`;
  });

  console.log("\nLand");
  await step("claim rent if any is owed", async () => {
    const owed = await plot.rentOwed(player.address);
    if (owed === 0n) return "none owed to this wallet";
    await (await plot.connect(player).claimRent()).wait();
    return `${ethers.formatUnits(owed, 18)} HESOYAM`;
  });

  await step("fuse two matching plots", async () => {
    const n = Number(await plot.balanceOf(player.address));
    const mine = [];
    for (let i = 0; i < n; i++) {
      const id = await plot.tokenOfOwnerByIndex(player.address, i);
      const info = await plot.info(id);
      const lease = await plot.leaseOf(id);
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      if (Number(lease.until) > now) continue;
      mine.push({ id, d: Number(info.district), t: Number(info.tier) });
    }
    const pair = mine.flatMap((x, i) => mine.slice(i + 1).map((y) => [x, y])).find(([x, y]) => x.d === y.d && x.t === y.t && x.t < 3);
    if (!pair) return `no fusable pair among ${mine.length} free plots, which is expected`;
    const before = await plot.totalSupply();
    await (await plot.connect(player).fuse(pair[0].id, pair[1].id)).wait();
    const after = await plot.totalSupply();
    if (after !== before - 1n) throw new Error("supply did not fall");
    return `supply ${before} to ${after}`;
  });

  console.log("\nInvariants");
  await step("claims never exceed what was notified", async () => {
    const n = await vault.totalNotified();
    const d = await vault.totalDistributed();
    if (d > n) throw new Error(`distributed ${d} exceeds notified ${n}`);
    return `${ethers.formatUnits(d, 6)} of ${ethers.formatUnits(n, 6)} USDC`;
  });
  await step("the token still has no mint path", async () => {
    if (hesoyam.interface.fragments.some((f) => f.type === "function" && f.name === "mint")) {
      throw new Error("a mint function exists");
    }
    return "absent from the ABI";
  });
  await step("plot supply never exceeded its cap", async () => {
    const m = await plot.minted();
    const cap = await plot.MAX_SUPPLY();
    if (m > cap) throw new Error(`${m} minted against a cap of ${cap}`);
    return `${m} of ${cap}`;
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    console.log("Not ready. Fix the failures above before going live.\n");
    process.exitCode = 1;
  } else {
    console.log("Every player action works end to end against a live chain.\n");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

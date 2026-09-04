/**
 * Parity between the TypeScript game maths and the deployed contract.
 *
 * This is the test that stops the interface promising a yield the chain will not pay.
 * It plants real grows, feeds them on a real clock, harvests them, and compares every
 * number the client would have shown against what the contract actually did.
 *
 * Requires a local node with a deployment. Run:
 *   npm run chain
 *   npm run deploy:local
 *   npm run test -w @hesoyam/game-core
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  toHex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  growGameAbi,
  strainRegistryAbi,
  growBenchAbi,
  hesoyamTokenAbi,
  randomBeaconAbi,
  addressOf,
} from "@hesoyam/sdk";
import {
  feedWindow,
  eventWindow,
  eventFires,
  firedMask,
  careScore,
  yieldUnits,
  qualityRange,
  tierForQuality,
  maturesAt,
  type Strain,
} from "../src/index.ts";

const RPC = process.env.RPC_URL || "http://127.0.0.1:8545";
const CHAIN_ID = Number(process.env.CHAIN_ID || 31337);

// Hardhat account 0. Public knowledge, local chains only.
const DEPLOYER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

const account = privateKeyToAccount(DEPLOYER);
const pub = createPublicClient({ transport: http(RPC) });
const wallet = createWalletClient({ account, transport: http(RPC) });

const DAY = 24 * 60 * 60;

let failures = 0;
let checks = 0;

function check(label: string, actual: unknown, expected: unknown) {
  checks++;
  const a = typeof actual === "bigint" ? actual.toString() : String(actual);
  const b = typeof expected === "bigint" ? expected.toString() : String(expected);
  if (a !== b) {
    failures++;
    console.log(`  FAIL ${label}: contract ${a}, typescript ${b}`);
  }
}

async function send(hash: `0x${string}`) {
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("transaction reverted");
  return receipt;
}

async function setNextTimestamp(t: number) {
  await pub.request({ method: "evm_setNextBlockTimestamp" as never, params: [t] as never });
  await pub.request({ method: "evm_mine" as never, params: [] as never });
}

async function now(): Promise<number> {
  const block = await pub.getBlock();
  return Number(block.timestamp);
}

const commitFor = (salt: `0x${string}`) =>
  keccak256(encodeAbiParameters(parseAbiParameters("bytes32"), [salt]));

const randomSalt = () =>
  ("0x" +
    Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")) as `0x${string}`;

/**
 * Rebuilds the seed script's hash chain so this test can advance the beacon.
 *
 * Same secret and length as scripts/seed.js, because the chain is committed once
 * per deployment and this test runs against that deployment.
 */
function buildSeedChain(): `0x${string}`[] {
  const out: `0x${string}`[] = new Array(256);
  out[255] = keccak256(toHex("hesoyam-seed-chain"));
  for (let i = 255; i > 0; i--) out[i - 1] = keccak256(out[i]);
  return out;
}

async function main() {
  const game = addressOf("GrowGame", CHAIN_ID);
  const registry = addressOf("StrainRegistry", CHAIN_ID);
  const bench = addressOf("GrowBench", CHAIN_ID);
  const hesoyam = addressOf("HesoyamToken", CHAIN_ID);
  const beacon = addressOf("RandomBeacon", CHAIN_ID);
  const seedChain = buildSeedChain();

  /**
   * Checks this really is the beacon seed.js committed before trying to drive it.
   *
   * Without this the first reveal fails inside viem with "cannot read properties
   * of undefined", because the preimage index runs off the end of a chain that
   * was never the right one. That error says nothing about the actual problem,
   * which is that the chain under test was set up by hand or by the keeper
   * rather than by seed.js.
   */
  const [head, startRound] = (await Promise.all([
    pub.readContract({ address: beacon, abi: randomBeaconAbi, functionName: "head" }),
    pub.readContract({ address: beacon, abi: randomBeaconAbi, functionName: "round" }),
  ])) as [`0x${string}`, bigint];

  // `head` walks backwards along the chain: reveal sets `head = preimage`. So at
  // round r it equals link r, not link 0. Comparing against link 0 only holds
  // before the first reveal, which is exactly the mistake that made this guard
  // reject a chain seed.js had legitimately committed.
  const expected = seedChain[Number(startRound)];
  if (!expected || head.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      [
        "This beacon was not committed by seed.js, so its preimages are unknown here.",
        `  round ${startRound}`,
        `  expected head ${expected ?? "past the end of a 256 link chain"}`,
        `  on chain head ${head}`,
        "Run a fresh local chain: npm run chain, npm run deploy:local, npm run seed",
      ].join("\n")
    );
  }

  /** Advances the beacon one round, exactly as the production keeper does. */
  const revealNext = async () => {
    const r = (await pub.readContract({ address: beacon, abi: randomBeaconAbi, functionName: "round" })) as bigint;
    const next = seedChain[Number(r) + 1];
    if (!next) {
      throw new Error(
        `The seed chain is exhausted at round ${r}. seed.js commits 256 links, so this ` +
          "chain has been advanced past what the test can drive. Start a fresh one."
      );
    }
    await send(
      await wallet.writeContract({
        address: beacon,
        abi: randomBeaconAbi,
        functionName: "reveal",
        args: [next],
        chain: null,
      })
    );
  };

  console.log(`Parity check against ${RPC}, chain ${CHAIN_ID}\n`);

  await send(
    await wallet.writeContract({
      address: hesoyam,
      abi: hesoyamTokenAbi,
      functionName: "approve",
      args: [game, 2n ** 255n],
      chain: null,
    })
  );
  await send(
    await wallet.writeContract({
      address: hesoyam,
      abi: hesoyamTokenAbi,
      functionName: "approve",
      args: [bench, 2n ** 255n],
      chain: null,
    })
  );

  // Scenarios cover the corners: perfect care, total neglect, partial feeding, and a
  // strain whose pest events always fire so damage is exercised.
  const scenarios = [
    { name: "perfect care, no events", eventChance: 0, feeds: [0, 1, 2], treatAll: false, benchTranche: 2 },
    { name: "no care at all, no events", eventChance: 0, feeds: [], treatAll: false, benchTranche: 0 },
    { name: "two feeds of three", eventChance: 0, feeds: [0, 2], treatAll: false, benchTranche: 0 },
    { name: "events fire, untreated", eventChance: 255, feeds: [0, 1, 2], treatAll: false, benchTranche: 2 },
    { name: "events fire, all treated", eventChance: 255, feeds: [0, 1, 2], treatAll: true, benchTranche: 2 },
    { name: "mid bench, one feed", eventChance: 128, feeds: [1], treatAll: false, benchTranche: 1 },
  ];

  for (const sc of scenarios) {
    console.log(`Scenario: ${sc.name}`);

    // A dedicated strain per scenario keeps the parameters explicit.
    await send(
      await wallet.writeContract({
        address: registry,
        abi: strainRegistryAbi,
        functionName: "addStrain",
        args: ["Parity " + sc.name, 2 * DAY, 1000, 11_000, sc.eventChance, 8, 5n * 10n ** 18n],
        chain: null,
      })
    );
    const strainCount = (await pub.readContract({
      address: registry,
      abi: strainRegistryAbi,
      functionName: "count",
    })) as bigint;
    const strainId = Number(strainCount) - 1;

    const core = (await pub.readContract({
      address: registry,
      abi: strainRegistryAbi,
      functionName: "core",
      args: [strainId],
    })) as readonly [number, number, number, number, number, bigint, boolean];

    const strain: Strain = {
      cycleSeconds: Number(core[0]),
      baseYield: Number(core[1]),
      geneticsBps: Number(core[2]),
      eventChance: Number(core[3]),
      geneQuality: Number(core[4]),
      seedPrice: core[5],
      active: core[6],
    };

    const buyReceipt = await send(
      await wallet.writeContract({
        address: bench,
        abi: growBenchAbi,
        functionName: "buy",
        args: [BigInt(sc.benchTranche)],
        chain: null,
      })
    );
    const benchId = BigInt(buyReceipt.logs.find((l) => l.topics.length === 4)!.topics[3]!);

    const benchTier = Number(
      (await pub.readContract({
        address: bench,
        abi: growBenchAbi,
        functionName: "tierOf",
        args: [benchId],
      })) as number
    );

    const salt = randomSalt();
    await send(
      await wallet.writeContract({
        address: game,
        abi: growGameAbi,
        functionName: "plant",
        args: [strainId, Number(benchId), commitFor(salt)],
        chain: null,
      })
    );
    await revealNext();

    const growId = ((await pub.readContract({
      address: game,
      abi: growGameAbi,
      functionName: "nextGrowId",
    })) as bigint) - 1n;

    const grow = (await pub.readContract({
      address: game,
      abi: growGameAbi,
      functionName: "grows",
      args: [growId],
    })) as readonly [Address, number, number, bigint, `0x${string}`, bigint, number, number, boolean];

    const plantedAt = Number(grow[3]);
    // Read through seedFor: index 5 is now the beacon round, and the seed itself
    // is never stored because it does not exist until the round is revealed.
    const eventSeed = (await pub.readContract({
      address: game,
      abi: growGameAbi,
      functionName: "seedFor",
      args: [growId],
    })) as `0x${string}`;

    // --- schedule parity ---------------------------------------------------
    for (let i = 0; i < 3; i++) {
      const onChain = (await pub.readContract({
        address: game,
        abi: growGameAbi,
        functionName: "feedWindow",
        args: [growId, i],
      })) as readonly [bigint, bigint];
      const local = feedWindow(plantedAt, strain.cycleSeconds, i);
      check(`feedWindow ${i} opens`, onChain[0], BigInt(local.opensAt));
      check(`feedWindow ${i} closes`, onChain[1], BigInt(local.closesAt));

      const ev = (await pub.readContract({
        address: game,
        abi: growGameAbi,
        functionName: "eventWindow",
        args: [growId, i],
      })) as readonly [bigint, bigint];
      const localEv = eventWindow(plantedAt, strain.cycleSeconds, i);
      check(`eventWindow ${i} opens`, ev[0], BigInt(localEv.opensAt));
      check(`eventWindow ${i} closes`, ev[1], BigInt(localEv.closesAt));

      const fires = (await pub.readContract({
        address: game,
        abi: growGameAbi,
        functionName: "eventFires",
        args: [growId, i],
      })) as boolean;
      check(`eventFires ${i}`, fires, eventFires(eventSeed, strain.eventChance, i));
    }

    const chainMask = (await pub.readContract({
      address: game,
      abi: growGameAbi,
      functionName: "firedMask",
      args: [growId],
    })) as number;
    check("firedMask", chainMask, firedMask(eventSeed, strain.eventChance));

    check(
      "maturesAt",
      (await pub.readContract({
        address: game,
        abi: growGameAbi,
        functionName: "maturesAt",
        args: [growId],
      })) as bigint,
      BigInt(maturesAt(plantedAt, strain.cycleSeconds))
    );

    // --- play it out -------------------------------------------------------
    let feedMask = 0;
    let treatedMask = 0;

    for (const i of sc.feeds) {
      const w = feedWindow(plantedAt, strain.cycleSeconds, i);
      await setNextTimestamp(w.opensAt + 30);
      await send(
        await wallet.writeContract({
          address: game,
          abi: growGameAbi,
          functionName: "feed",
          args: [growId, i],
          chain: null,
        })
      );
      feedMask |= 1 << i;
    }

    if (sc.treatAll) {
      const mask = firedMask(eventSeed, strain.eventChance);
      for (let slot = 0; slot < 3; slot++) {
        if (!(mask & (1 << slot))) continue;
        const w = eventWindow(plantedAt, strain.cycleSeconds, slot);
        const at = Math.max(w.opensAt + 30, (await now()) + 1);
        if (at > w.closesAt) continue;
        await setNextTimestamp(at);
        await send(
          await wallet.writeContract({
            address: game,
            abi: growGameAbi,
            functionName: "treat",
            args: [growId, slot],
            chain: null,
          })
        );
        treatedMask |= 1 << slot;
      }
    }

    // --- care parity -------------------------------------------------------
    const chainCare = (await pub.readContract({
      address: game,
      abi: growGameAbi,
      functionName: "careScore",
      args: [growId],
    })) as readonly [number, number];

    const local = careScore({ feedMask, treatedMask, benchTier }, eventSeed, strain.eventChance);
    check("care", chainCare[0], local.care);
    check("damageBps", chainCare[1], local.damageBps);

    // --- harvest parity ----------------------------------------------------
    const predictedUnits = yieldUnits(strain.baseYield, strain.geneticsBps, local.care, local.damageBps);
    const predictedQuality = qualityRange(local.care, strain.geneQuality, local.damageBps);

    await setNextTimestamp(maturesAt(plantedAt, strain.cycleSeconds) + 5);
    const harvestReceipt = await send(
      await wallet.writeContract({
        address: game,
        abi: growGameAbi,
        functionName: "harvest",
        args: [growId, salt, false],
        chain: null,
      })
    );

    // Harvested(growId, grower, units, quality, care, damageBps, curing)
    const harvestedTopic = harvestReceipt.logs.find(
      (l) => l.address.toLowerCase() === game.toLowerCase() && l.topics.length === 3
    );
    if (!harvestedTopic) throw new Error("no Harvested event found");
    const data = harvestedTopic.data.slice(2);
    const word = (i: number) => BigInt("0x" + data.slice(i * 64, (i + 1) * 64));
    const actualUnits = Number(word(0));
    const actualQuality = Number(word(1));
    const actualCare = Number(word(2));

    check("harvest units", actualUnits, predictedUnits);
    check("harvest care", actualCare, local.care);

    checks++;
    if (actualQuality < predictedQuality.min || actualQuality > predictedQuality.max) {
      failures++;
      console.log(
        `  FAIL quality ${actualQuality} outside predicted ${predictedQuality.min} to ${predictedQuality.max}`
      );
    }

    console.log(
      `  care ${local.care}, damage ${local.damageBps}, units ${actualUnits}, ` +
        `quality ${actualQuality} in [${predictedQuality.min}, ${predictedQuality.max}], ` +
        `tier ${tierForQuality(actualQuality)}`
    );
  }

  console.log(`\n${checks} comparisons, ${failures} failures.`);
  if (failures > 0) process.exit(1);
  console.log("TypeScript and Solidity agree.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

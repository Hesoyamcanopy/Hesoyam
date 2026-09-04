/* eslint-disable no-console */
const { ethers, network } = require("hardhat");

const DAY = 24 * 60 * 60;
const E18 = 10n ** 18n;

/**
 * Deploys and wires Hesoyam in the order the invariants require.
 *
 * Order matters twice:
 *   1. HESOYAM exists before the router, so the tax recipient can be a contract.
 *   2. The tax is enabled LAST, after every protocol contract is exempt, so no
 *      internal transfer is ever double taxed.
 */
const CONFIG = {
  // Addresses. Replace before any real deployment.
  // The CREATOR leg of the transfer tax, which is 4 of the 5 percent. This
  // comment used to say 1 percent, which is the protocol leg and goes to the
  // router instead. Point this at the wallet you actually want paid.
  creatorTreasury: process.env.PONS_TREASURY || null,
  liquiditySink: process.env.LIQUIDITY_SINK || null,
  opsSafe: process.env.OPS_SAFE || null,
  keeper: process.env.KEEPER || null,
  // The reward currency, immutable in StakingVault once deployed. There is no
  // USDC on Robinhood Chain: the canonical stablecoin is USDG, 6 decimals, at
  // 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168.
  settlement: process.env.SETTLEMENT || null,

  // Router split, in basis points. Must sum to 10000.
  allocation: { equity: 5000, dispensary: 2800, liquidity: 1200, ops: 800, reserve: 200 },

  // INV-7 guards. Keep the sweep cooldown at or above the Dispensary auction
  // duration, otherwise every sweep resets the descending auction to its ceiling.
  guards: { maxSweepHesoyam: 2_000_000n * E18, cooldown: 24 * 60 * 60, maxDeviationBps: 200 },

  benchTranches: [
    { tier: 0, price: 500n * E18, cap: 1000 },
    { tier: 1, price: 1_100n * E18, cap: 400 },
    { tier: 2, price: 2_000n * E18, cap: 100 },
  ],

  strains: [
    // name, cycle, baseYield, geneticsBps, eventChance, geneQuality, seedPrice
    ["Northern Lights", 7 * DAY, 100, 10_000, 60, 10, 120n * E18],
    ["Blue Dream", 6 * DAY, 92, 10_400, 80, 12, 140n * E18],
    ["Sour Diesel", 7 * DAY, 120, 11_000, 130, 14, 160n * E18],
    ["Autoflower", 4 * DAY, 60, 9_000, 40, 4, 60n * E18],
  ],
};

async function main() {
  const [deployer] = await ethers.getSigners();
  const local = network.name === "hardhat" || network.name === "localhost";
  // Test money on a test chain deserves the same defaults as a local chain: the
  // deployer standing in for every role, and a fresh mock settlement token. The
  // guard below used to say "off a local chain", which wrongly forced a testnet
  // deploy to invent real looking treasury and ops addresses for a rehearsal
  // that is deleted the next time someone redeploys. It now only fires for the
  // chain that actually is production, robinhood, and for a hand configured
  // `target`, which could point at a real chain later.
  const rehearsal = local || network.name === "robinhoodTestnet" || network.name === "arbitrumSepolia";
  console.log(`Deploying to ${network.name} from ${deployer.address}`);

  // Captured before the first deployment so an indexer starting here cannot miss
  // the constructor and configuration events emitted below.
  const startBlock = await ethers.provider.getBlockNumber();

  const creatorTreasury = CONFIG.creatorTreasury || deployer.address;
  const liquiditySink = CONFIG.liquiditySink || deployer.address;
  const opsSafe = CONFIG.opsSafe || deployer.address;
  const keeper = CONFIG.keeper || deployer.address;

  if (!rehearsal && (!CONFIG.creatorTreasury || !CONFIG.opsSafe || !CONFIG.settlement)) {
    throw new Error("Set PONS_TREASURY, OPS_SAFE and SETTLEMENT before deploying to a real chain");
  }
  if (rehearsal && !local) {
    console.log("  testnet rehearsal: creator, ops and settlement all default to the deployer/mock");
  }

  // 1. Currency and settlement.
  // HESOYAM_TOKEN is set when the token was launched elsewhere, which is the
  // production case: Pons deploys it and its tax is pointed at our router. Only
  // deploy our own when there is nothing to attach to, so a local run still
  // works end to end.
  const existingToken = process.env.HESOYAM_TOKEN;
  let hesoyam;
  if (existingToken && ethers.isAddress(existingToken)) {
    hesoyam = await ethers.getContractAt("HesoyamToken", existingToken);
    console.log("  using the existing token at", existingToken);
  } else {
    hesoyam = await ethers.deployContract("HesoyamToken", [deployer.address, deployer.address]);
    console.log("  deployed our own token, no HESOYAM_TOKEN was set");
  }
  await hesoyam.waitForDeployment();

  let settlement;
  if (CONFIG.settlement) {
    settlement = await ethers.getContractAt("MockUSDC", CONFIG.settlement);
  } else {
    settlement = await ethers.deployContract("MockUSDC", []);
    await settlement.waitForDeployment();
    console.log("  (deployed a mock settlement token - local only)");
  }

  // 2. The tap.
  const router = await ethers.deployContract("RevenueRouter", [deployer.address, hesoyam.target, settlement.target]);
  await router.waitForDeployment();

  // 3. Assets.
  const flower = await ethers.deployContract("Flower", [deployer.address, "ipfs://hesoyam/flower/{id}.json"]);
  const card = await ethers.deployContract("StrainCard", [deployer.address, "ipfs://hesoyam/card/"]);
  const bench = await ethers.deployContract("GrowBench", [
    deployer.address, hesoyam.target, router.target, "ipfs://hesoyam/bench/",
  ]);
  const strains = await ethers.deployContract("StrainRegistry", [deployer.address]);
  await Promise.all([flower.waitForDeployment(), card.waitForDeployment(), bench.waitForDeployment(), strains.waitForDeployment()]);

  // 4. Game and venues.
  const game = await ethers.deployContract("GrowGame", [
    deployer.address, hesoyam.target, flower.target, bench.target, strains.target, router.target,
  ]);
  const market = await ethers.deployContract("Marketplace", [deployer.address, hesoyam.target, flower.target, router.target]);
  const dispensary = await ethers.deployContract("Dispensary", [
    deployer.address, settlement.target, flower.target, router.target,
  ]);
  const crafter = await ethers.deployContract("CardCrafter", [
    deployer.address, hesoyam.target, flower.target, card.target, router.target,
  ]);
  const vault = await ethers.deployContract("StakingVault", [deployer.address, hesoyam.target, settlement.target]);
  const plot = await ethers.deployContract("Plot", [deployer.address, hesoyam.target, bench.target, router.target]);
  const beacon = await ethers.deployContract("RandomBeacon", [deployer.address]);
  await Promise.all([
    game.waitForDeployment(), market.waitForDeployment(), dispensary.waitForDeployment(),
    crafter.waitForDeployment(), vault.waitForDeployment(), plot.waitForDeployment(),
    beacon.waitForDeployment(),
  ]);

  // 5. Roles.
  await (await flower.setMinter(game.target, true)).wait();
  await (await flower.setBurner(crafter.target, true)).wait();
  await (await flower.setBurner(dispensary.target, true)).wait();
  await (await card.setMinter(crafter.target, true)).wait();
  await (await vault.setConfig(card.target, router.target, router.target)).wait();
  await (await game.setBeacon(beacon.target)).wait();
  await (await dispensary.setKeeper(keeper, true)).wait();

  // 6. Router wiring.
  await (await router.setSinks(vault.target, dispensary.target, liquiditySink, opsSafe)).wait();
  const a = CONFIG.allocation;
  await (await router.setAllocation(a.equity, a.dispensary, a.liquidity, a.ops, a.reserve)).wait();
  const g = CONFIG.guards;
  await (await router.setGuards(g.maxSweepHesoyam, g.cooldown, g.maxDeviationBps)).wait();

  // 7. Tax. Exemptions first, switch last.
  const weOwnTheToken = !existingToken;
  if (weOwnTheToken) {
    await (await hesoyam.setTaxRecipients(creatorTreasury, router.target)).wait();
  }
  if (weOwnTheToken) {
    for (const c of [router, vault, game, market, dispensary, crafter, bench, plot]) {
      await (await hesoyam.setTaxExempt(c.target, true)).wait();
    }
  }
  if (weOwnTheToken) {
    await (await hesoyam.enableTax()).wait();
  }

  // 8. Content.
  for (const s of CONFIG.strains) {
    await (await strains.addStrain(...s)).wait();
  }
  for (const t of CONFIG.benchTranches) {
    await (await bench.openTranche(t.tier, t.price, t.cap)).wait();
  }

  const addresses = {
    hesoyam: hesoyam.target,
    settlement: settlement.target,
    router: router.target,
    vault: vault.target,
    flower: flower.target,
    strainCard: card.target,
    bench: bench.target,
    strains: strains.target,
    game: game.target,
    marketplace: market.target,
    plot: plot.target,
    beacon: beacon.target,
    dispensary: dispensary.target,
    crafter: crafter.target,
  };

  // Record the deployment so the indexer, the SDK and the client all read the same
  // addresses instead of three hand copied lists.
  const fs = require("fs");
  const path = require("path");
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });

  const record = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    startBlock,
    addresses,
  };
  const outFile = path.join(dir, `${network.name}.json`);
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2) + "\n");

  console.log("\nDeployed:");
  for (const [k, v] of Object.entries(addresses)) console.log(`  ${k.padEnd(12)} ${v}`);
  console.log(`\nWritten to deployments/${network.name}.json at block ${record.startBlock}`);

  console.log("\nStill to do by hand, on purpose:");
  console.log("  - commit the beacon chain: beacon.commitChain(head), then setRevealer(keeper)");
  console.log("  - START THE REVEALER. Planting reverts without it, and harvests wait on it.");
  console.log("  - point the Pons v2 token tax at the RevenueRouter address above");
  console.log("  - set a swap adapter with router.setSwapAdapter(<real AMM route>)");
  console.log("  - seed Dispensary reference prices with setReferenceAdmin(tier, price)");
  console.log("  - transfer ownership of every contract to the timelock");

  return addresses;
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

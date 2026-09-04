/**
 * Commits the beacon chain head and authorises a revealer.
 *
 * Separate from deploy.js on purpose. The head comes from a secret that must
 * never touch the deploy machine, so this is run afterwards by whoever holds it.
 *
 * commitChain is one shot. A wrong head permanently bricks the beacon and the
 * game with it, so this refuses to run against an already committed beacon and
 * tells you what is there instead.
 *
 * Usage:
 *   BEACON_HEAD=0x... REVEALER=0x... npm run beacon:setup -w @hesoyam/contracts -- --network <net>
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) throw new Error(`No deployment for ${network.name}. Deploy first.`);
  const a = JSON.parse(fs.readFileSync(file, "utf8")).addresses;
  if (!a.beacon) throw new Error("This deployment has no beacon address.");

  const head = process.env.BEACON_HEAD;
  const revealer = process.env.REVEALER;
  if (!head || !/^0x[0-9a-fA-F]{64}$/.test(head)) {
    throw new Error("BEACON_HEAD must be a 32 byte hex value. Get it from: npm run keeper:head");
  }
  if (!revealer || !ethers.isAddress(revealer)) {
    throw new Error("REVEALER must be the keeper's address.");
  }

  const beacon = await ethers.getContractAt("RandomBeacon", a.beacon);
  const existing = await beacon.head();

  if (existing !== ethers.ZeroHash) {
    console.log(`\nThis beacon already has a chain committed.`);
    console.log(`  head   ${existing}`);
    console.log(`  round  ${(await beacon.round()).toString()}`);
    console.log(`\ncommitChain is one shot, so nothing was changed. If the secret is`);
    console.log(`lost, deploy a new beacon and point the game at it with setBeacon.\n`);
    return;
  }

  console.log(`\nBeacon ${a.beacon} on ${network.name}`);
  await (await beacon.commitChain(head)).wait();
  console.log(`  committed head    ${head}`);

  await (await beacon.setRevealer(revealer, true)).wait();
  console.log(`  revealer set      ${revealer}`);

  console.log(`\n  round             ${(await beacon.round()).toString()}`);
  console.log(`  stalled           ${await beacon.isStalled()}`);
  console.log(`\nStart the keeper now. Until it runs, planting works but nothing resolves.\n`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});

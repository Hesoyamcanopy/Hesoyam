/**
 * Moves the local chain forward in time, so a seven day grow can be watched in
 * a minute instead of a week.
 *
 * Local chains only. The interface reads chain time rather than the browser
 * clock, so the progress bars, feed windows and harvest buttons all follow this.
 *
 * Usage:
 *   npm run warp                 advance 1 day
 *   WARP_HOURS=6 npm run warp    advance 6 hours
 */
const { ethers, network } = require("hardhat");

async function main() {
  if (network.name !== "localhost" && network.name !== "hardhat") {
    throw new Error("warp only runs on a local chain");
  }
  const hours = Number(process.env.WARP_HOURS ?? 24);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 30) {
    throw new Error("WARP_HOURS must be between 1 and 720");
  }

  const before = (await ethers.provider.getBlock("latest")).timestamp;
  await ethers.provider.send("evm_setNextBlockTimestamp", [before + Math.floor(hours * 3600)]);
  await ethers.provider.send("evm_mine", []);
  const after = (await ethers.provider.getBlock("latest")).timestamp;

  console.log(`\n  advanced ${hours}h`);
  console.log(`  chain time  ${new Date(before * 1000).toISOString()}`);
  console.log(`           -> ${new Date(after * 1000).toISOString()}`);
  console.log(`\n  Reload the page. Plants will have grown.\n`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});

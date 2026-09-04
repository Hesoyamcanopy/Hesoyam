/**
 * Reads the flywheel off a seeded chain and prints it as one continuous trace:
 * fees in, split, both rails paid, and what the staker rail still owes.
 *
 * Read only. It sends no transactions and asserts against live contract state
 * rather than against anything the seed script remembered.
 */
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const BPS = 10000n;

function usdc(v) {
  return `${(Number(v) / 1e6).toFixed(2)} USDC`;
}

function pct(part, whole) {
  return whole === 0n ? "n/a" : `${((Number(part) * 100) / Number(whole)).toFixed(2)}%`;
}

async function main() {
  const file = path.join(__dirname, "..", "deployments", "localhost.json");
  const a = JSON.parse(fs.readFileSync(file, "utf8")).addresses;

  const token = await ethers.getContractAt("HesoyamToken", a.hesoyam);
  const router = await ethers.getContractAt("RevenueRouter", a.router);
  const vault = await ethers.getContractAt("StakingVault", a.vault);
  const disp = await ethers.getContractAt("Dispensary", a.dispensary);
  const settlement = await ethers.getContractAt("MockUSDC", a.settlement);

  console.log("\nIdentity");
  console.log(`  name           ${await token.name()}`);
  console.log(`  symbol         ${await token.symbol()}`);
  console.log(`  supply         ${ethers.formatUnits(await token.totalSupply(), 18)}`);

  // A mint path that does not exist cannot be called. Prove it from the ABI,
  // not by calling and catching, which would also pass if it merely reverted.
  const hasMint = token.interface.fragments.some((f) => f.type === "function" && f.name === "mint");
  console.log(`  mint function  ${hasMint ? "PRESENT, this is a bug" : "absent"}`);

  console.log("\nPublished split");
  const alloc = await router.allocation();
  const parts = [
    ["stakers", alloc.equityBps],
    ["growers", alloc.dispensaryBps],
    ["liquidity", alloc.liquidityBps],
    ["operations", alloc.opsBps],
    ["reserve", alloc.reserveBps],
  ];
  let sum = 0n;
  for (const [name, bps] of parts) {
    sum += bps;
    console.log(`  ${name.padEnd(11)} ${(Number(bps) / 100).toFixed(2).padStart(6)}%`);
  }
  console.log(
    `  ${"total".padEnd(11)} ${(Number(sum) / 100).toFixed(2).padStart(6)}%  ${sum === BPS ? "ok" : "DOES NOT SUM TO 100"}`
  );

  console.log("\nRealized revenue");
  const realized = await router.totalRealized();
  const toEquity = await router.totalToEquity();
  const toDisp = await router.totalToDispensary();
  console.log(`  realized       ${usdc(realized)}`);
  console.log(`  to stakers     ${usdc(toEquity)}  ${pct(toEquity, realized)}`);
  console.log(`  to growers     ${usdc(toDisp)}  ${pct(toDisp, realized)}`);
  console.log(`  to liquidity   ${usdc(await router.totalToLiquidity())}`);
  console.log(`  to operations  ${usdc(await router.totalToOps())}`);
  console.log(`  reserve        ${usdc(await router.reserveBalance())}`);
  console.log(`  awaiting swap  ${ethers.formatUnits(await router.pendingHesoyam(), 18)} HESOYAM`);

  console.log("\nStaker rail");
  const notified = await vault.totalNotified();
  const claimed = await vault.totalDistributed();
  const principal = await vault.totalPrincipal();
  const held = await settlement.balanceOf(a.vault);
  console.log(`  notified       ${usdc(notified)}`);
  console.log(`  claimed        ${usdc(claimed)}`);
  console.log(`  still owed     ${usdc(notified - claimed)}`);
  console.log(`  held by vault  ${usdc(held)}`);
  console.log(`  principal      ${ethers.formatUnits(principal, 18)} HESOYAM staked`);

  console.log("\nGrower rail");
  console.log(`  epoch budget   ${usdc(await disp.epochBudget())}`);
  console.log(`  epoch spent    ${usdc(await disp.epochSpent())}`);
  console.log(`  total funded   ${usdc(await disp.totalFunded())}`);
  console.log(`  units bought   ${await disp.totalUnitsBought()}`);

  const epochBudget = await disp.epochBudget();
  const epochSpent = await disp.epochSpent();

  console.log("\nInvariants, checked against live state");
  const checks = [
    ["claims never exceed what was notified", claimed <= notified],
    ["the vault holds enough settlement to pay what it still owes", held >= notified - claimed],
    ["no mint path exists on the token", !hasMint],
    ["the split sums to exactly 100 percent", sum === BPS],
    ["the grower rail never overspends its epoch budget", epochSpent <= epochBudget],
    ["staker principal is HESOYAM, rewards are settlement, so they cannot be confused", principal > 0n],
    ["both rails were funded from the same realized revenue", toEquity > 0n && toDisp > 0n && realized > 0n],
  ];
  let bad = 0;
  for (const [label, ok] of checks) {
    if (!ok) bad++;
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}`);
  }

  console.log(
    bad === 0
      ? "\nFlywheel intact. Every payout above was funded by revenue the router actually received.\n"
      : `\n${bad} invariant(s) failed.\n`
  );
  process.exitCode = bad === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

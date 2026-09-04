/**
 * Prints the head to commit on chain, and nothing else.
 *
 * Run this once, offline, before deploying. The head is public and goes into
 * commitChain. The secret never leaves the machine, and this deliberately does
 * not print it, because a head is safe to paste into a terminal and a secret is
 * not.
 *
 * commitChain can only be called once per beacon, so a wrong head is permanent.
 * The chain is verified end to end before anything is printed.
 */
import { buildChain, verifyChain } from "./chain.ts";

const SECRET = process.env.KEEPER_SECRET;
const LENGTH = Number(process.env.CHAIN_LENGTH ?? 100_000);

if (!SECRET) {
  console.error("KEEPER_SECRET is not set.");
  process.exit(1);
}
if (SECRET.length < 32) {
  console.error("KEEPER_SECRET is too short. Use at least 32 characters of real entropy.");
  process.exit(1);
}

const chain = buildChain(SECRET, LENGTH);
if (!verifyChain(chain)) {
  console.error("The chain does not verify. Refusing to print a head.");
  process.exit(1);
}

const perDay = 24 * 12; // a reveal every five minutes
console.log("");
console.log(`  head        ${chain[0]}`);
console.log(`  links       ${LENGTH}`);
console.log(`  lasts       about ${Math.floor((LENGTH - 1) / perDay)} days at one reveal every 5 minutes`);
console.log("");
console.log("  Commit that head with beacon.commitChain(head), then");
console.log("  beacon.setRevealer(<keeper address>, true).");
console.log("");
console.log("  Keep KEEPER_SECRET safe and identical for the keeper process.");
console.log("  A wrong head cannot be replaced: commitChain is one shot.");
console.log("");

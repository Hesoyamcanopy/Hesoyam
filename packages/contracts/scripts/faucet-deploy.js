/**
 * Deploys the testnet HESOYAM faucet and funds it.
 *
 * Deliberately its own script rather than a step inside deploy.js. That keeps
 * mainnet's deploy path physically incapable of reaching this code, rather
 * than relying on a runtime flag to skip it correctly every time. The
 * contract's own constructor also refuses chain id 4663 as a second lock on
 * the same door.
 *
 * Usage:
 *   npm run faucet:deploy -- --network robinhoodTestnet
 *   FAUCET_AMOUNT=5000    HESOYAM per claim, defaults to 5,000
 *   FAUCET_COOLDOWN=86400 seconds between claims for one address, defaults to a day
 *   FAUCET_FUND=250000    HESOYAM to send it on deploy, defaults to 250,000 (50 claims)
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const E18 = 10n ** 18n;

async function main() {
  if (network.name === "robinhood") {
    throw new Error("Refusing to deploy the faucet to Robinhood Chain mainnet.");
  }

  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`No deployment found for ${network.name}. Run the main deploy first.`);
  }
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  const a = record.addresses;
  if (!a.hesoyam) throw new Error(`deployments/${network.name}.json has no hesoyam address.`);

  const [deployer] = await ethers.getSigners();
  const hesoyam = await ethers.getContractAt("HesoyamToken", a.hesoyam);

  const amount = BigInt(process.env.FAUCET_AMOUNT || "5000") * E18;
  const cooldown = Number(process.env.FAUCET_COOLDOWN || 24 * 60 * 60);
  const fund = BigInt(process.env.FAUCET_FUND || "250000") * E18;

  console.log(`Deploying the faucet to ${network.name} from ${deployer.address}`);
  const faucet = await ethers.deployContract("Faucet", [a.hesoyam, amount, cooldown]);
  await faucet.waitForDeployment();
  console.log(`  faucet at ${faucet.target}`);

  // A claim is a grant, not a trade. Exempt it the same way every protocol
  // contract already is, so a claim of 5,000 pays out 5,000, not 4,750 with
  // the rest quietly absorbed by the transfer tax.
  if (await hesoyam.taxEnabled()) {
    await (await hesoyam.setTaxExempt(faucet.target, true)).wait();
    console.log("  exempted from the transfer tax");
  }

  await (await hesoyam.transfer(faucet.target, fund)).wait();
  console.log(`  funded with ${fund / E18} HESOYAM`);

  record.addresses.faucet = faucet.target;
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
  console.log(`\nWritten to deployments/${network.name}.json`);
  console.log(`\nRun npm run sdk:generate to pick up the new address.`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});

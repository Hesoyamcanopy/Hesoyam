/**
 * Pre-flight for a real deployment.
 *
 * Answers the only questions that matter before you spend money: which chain am
 * I actually talking to, which address will sign, does it have enough, and what
 * will this cost. Sends nothing.
 *
 * Usage: npm run wallet:check -- --network arbitrumSepolia
 */
const { ethers, network } = require("hardhat");

async function main() {
  const signers = await ethers.getSigners();

  console.log(`\nNetwork`);
  console.log(`  name       ${network.name}`);
  const net = await ethers.provider.getNetwork();
  console.log(`  chain id   ${net.chainId}`);

  if (signers.length === 0) {
    console.log("\nNo signer. DEPLOYER_KEY is not set in .env.");
    console.log("Run: npm run wallet:new\n");
    process.exitCode = 1;
    return;
  }

  const me = signers[0];
  const balance = await ethers.provider.getBalance(me.address);
  const nonce = await ethers.provider.getTransactionCount(me.address);

  console.log(`\nDeployer`);
  console.log(`  address    ${me.address}`);
  console.log(`  balance    ${ethers.formatEther(balance)} ETH`);
  console.log(`  nonce      ${nonce}${nonce > 0 ? "  (this account has sent transactions before)" : ""}`);

  /**
   * Two prices, because they answer different questions and quoting only one is
   * how people end up confused about what a deploy actually cost.
   *
   * `maxFeePerGas` on this chain comes back as exactly twice the base fee with a
   * zero priority fee. That is the right number to FUND against, because it is
   * the ceiling a transaction can be charged. It is roughly double what the
   * deploy will actually SPEND, because the refund of the unused difference goes
   * straight back to the deployer.
   */
  const fee = await ethers.provider.getFeeData();
  const head = await ethers.provider.getBlock("latest");
  const baseFee = head?.baseFeePerGas ?? fee.gasPrice ?? 0n;
  const ceiling = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;

  console.log(`\nGas`);
  console.log(`  base fee   ${ethers.formatUnits(baseFee, "gwei")} gwei  (what it should cost)`);
  console.log(`  ceiling    ${ethers.formatUnits(ceiling, "gwei")} gwei  (maxFeePerGas, what to fund against)`);

  /**
   * Measured, not guessed: 14 contract creations plus 27 wiring calls on a chain
   * with nothing else on it.
   *
   * Two of those creations do not happen on a real deployment, and quoting them
   * anyway told people to fund a deployer with roughly 8 percent more than they
   * need. When Pons has already deployed the token, and the settlement token is
   * a real one rather than the mock, both are skipped.
   */
  const FULL = 25_274_084n;
  const OWN_TOKEN = 1_487_319n;
  const MOCK_SETTLEMENT = 521_243n;

  let estimate = FULL;
  const skipped = [];
  if (process.env.HESOYAM_TOKEN) {
    estimate -= OWN_TOKEN;
    skipped.push("own token");
  }
  if (process.env.SETTLEMENT) {
    estimate -= MOCK_SETTLEMENT;
    skipped.push("mock settlement");
  }

  const likely = baseFee * estimate;
  const worstCase = ceiling * estimate;
  console.log(
    `  estimate   ~${estimate.toLocaleString()} gas for the whole deploy` +
      (skipped.length ? `, skipping ${skipped.join(" and ")}` : "")
  );
  console.log(`  likely     ~${ethers.formatEther(likely)} ETH at the current base fee`);
  console.log(`  worst case ~${ethers.formatEther(worstCase)} ETH if every block pays the ceiling`);
  console.log(`  fund with  ~${ethers.formatEther((worstCase * 3n) / 2n)} ETH, the worst case plus half`);

  // Fund against the ceiling, not the likely cost. Running out halfway through a
  // fourteen contract deploy leaves a half wired system and wastes what was spent.
  const needed = (worstCase * 3n) / 2n;
  console.log("");
  if (balance === 0n) {
    console.log("NOT READY. The deployer has no balance. Fund the address above.");
    process.exitCode = 1;
  } else if (balance < needed) {
    console.log(`NOT READY. Short by about ${ethers.formatEther(needed - balance)} ETH.`);
    process.exitCode = 1;
  } else {
    console.log("READY. Balance covers the padded estimate.");
    console.log(`Deploy with: npm run deploy -w @hesoyam/contracts -- --network ${network.name}`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});

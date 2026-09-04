/**
 * Hesoyam SDK.
 *
 * The single source of ABIs and addresses for every other package. Generated files
 * are gitignored on purpose, so a stale copy can never be committed and read by
 * accident. Run `npm run generate -w @hesoyam/sdk` after compiling or deploying.
 */

export * from "./generated/abis.ts";
export * from "./generated/addresses.ts";

import { DEPLOYMENTS, type ContractName, type Deployment } from "./generated/addresses.ts";

export class UnknownChainError extends Error {
  constructor(chainId: number) {
    super(
      `No Hesoyam deployment recorded for chain ${chainId}. ` +
        `Deploy with \`npm run deploy:local -w @hesoyam/contracts\` then regenerate the SDK.`
    );
    this.name = "UnknownChainError";
  }
}

export class UnknownContractError extends Error {
  constructor(name: ContractName, chainId: number) {
    super(`Contract ${name} is not present in the deployment for chain ${chainId}.`);
    this.name = "UnknownContractError";
  }
}

/** Every recorded deployment, newest first by deployment time. */
export function deployments(): Deployment[] {
  return Object.values(DEPLOYMENTS).sort((a, b) => b.deployedAt.localeCompare(a.deployedAt));
}

export function deploymentFor(chainId: number): Deployment {
  const found = DEPLOYMENTS[chainId];
  if (!found) throw new UnknownChainError(chainId);
  return found;
}

/**
 * Address of one contract on one chain. Throws rather than returning undefined,
 * because a silent undefined turns into a call to the zero address.
 */
export function addressOf(name: ContractName, chainId: number): `0x${string}` {
  const deployment = deploymentFor(chainId);
  const address = deployment.addresses[name];
  if (!address) throw new UnknownContractError(name, chainId);
  return address;
}

/** The block an indexer should start from for a given chain. */
export function startBlockFor(chainId: number): bigint {
  return BigInt(deploymentFor(chainId).startBlock);
}

/** Flower token ids pack a strain and a quality tier: id = strainId * 4 + tier. */
export const FLOWER_TIERS = 4n;

export type QualityTier = 0 | 1 | 2;

export const TIER_NAMES: Record<QualityTier, string> = {
  0: "Bulk",
  1: "Standard",
  2: "Premium",
};

export function flowerId(strainId: number | bigint, tier: QualityTier): bigint {
  return BigInt(strainId) * FLOWER_TIERS + BigInt(tier);
}

export function decodeFlowerId(id: bigint): { strainId: number; tier: QualityTier } {
  return {
    strainId: Number(id / FLOWER_TIERS),
    tier: Number(id % FLOWER_TIERS) as QualityTier,
  };
}

/** Quality to tier, matching GrowGame._mintFlower exactly. */
export function tierForQuality(quality: number): QualityTier {
  if (quality >= 80) return 2;
  if (quality >= 50) return 1;
  return 0;
}

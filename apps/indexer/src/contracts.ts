import {
  hesoyamTokenAbi,
  flowerAbi,
  strainCardAbi,
  growBenchAbi,
  revenueRouterAbi,
  stakingVaultAbi,
  strainRegistryAbi,
  growGameAbi,
  cardCrafterAbi,
  marketplaceAbi,
  dispensaryAbi,
  deploymentFor,
  type ContractName,
} from "@hesoyam/sdk";
import type { Abi } from "viem";

export type Watched = {
  name: ContractName;
  address: `0x${string}`;
  abi: Abi;
};

const ABIS: Partial<Record<ContractName, Abi>> = {
  HesoyamToken: hesoyamTokenAbi as unknown as Abi,
  Flower: flowerAbi as unknown as Abi,
  StrainCard: strainCardAbi as unknown as Abi,
  GrowBench: growBenchAbi as unknown as Abi,
  RevenueRouter: revenueRouterAbi as unknown as Abi,
  StakingVault: stakingVaultAbi as unknown as Abi,
  StrainRegistry: strainRegistryAbi as unknown as Abi,
  GrowGame: growGameAbi as unknown as Abi,
  CardCrafter: cardCrafterAbi as unknown as Abi,
  Marketplace: marketplaceAbi as unknown as Abi,
  Dispensary: dispensaryAbi as unknown as Abi,
};

/**
 * Every contract the indexer watches, for one chain.
 *
 * MockUSDC is deliberately absent. Settlement token transfers are high volume and
 * carry no protocol meaning, and the amounts that matter are already in the router's
 * own events.
 */
export function watchedContracts(chainId: number): Watched[] {
  const deployment = deploymentFor(chainId);
  const out: Watched[] = [];

  for (const [name, abi] of Object.entries(ABIS) as [ContractName, Abi][]) {
    const address = deployment.addresses[name];
    if (!address) continue;
    out.push({ name, address, abi });
  }
  return out;
}

export function startBlock(chainId: number): bigint {
  return BigInt(deploymentFor(chainId).startBlock);
}

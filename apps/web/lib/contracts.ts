"use client";

import { useChainId } from "wagmi";
import {
  hesoyamTokenAbi,
  flowerAbi,
  strainCardAbi,
  growBenchAbi,
  plotAbi,
  revenueRouterAbi,
  randomBeaconAbi,
  stakingVaultAbi,
  strainRegistryAbi,
  growGameAbi,
  cardCrafterAbi,
  marketplaceAbi,
  dispensaryAbi,
  mockUSDCAbi,
  DEPLOYMENTS,
  type ContractName,
} from "@hesoyam/sdk";

export const ABIS = {
  HesoyamToken: hesoyamTokenAbi,
  Flower: flowerAbi,
  StrainCard: strainCardAbi,
  GrowBench: growBenchAbi,
  Plot: plotAbi,
  RevenueRouter: revenueRouterAbi,
  RandomBeacon: randomBeaconAbi,
  StakingVault: stakingVaultAbi,
  StrainRegistry: strainRegistryAbi,
  GrowGame: growGameAbi,
  CardCrafter: cardCrafterAbi,
  Marketplace: marketplaceAbi,
  Dispensary: dispensaryAbi,
  MockUSDC: mockUSDCAbi,
} as const;

export type Addresses = Partial<Record<ContractName, `0x${string}`>>;

export function addressesFor(chainId: number): Addresses {
  return DEPLOYMENTS[chainId]?.addresses ?? {};
}

export function isDeployed(chainId: number): boolean {
  return Boolean(DEPLOYMENTS[chainId]);
}

/**
 * Addresses for the connected chain.
 *
 * Returns an empty map rather than throwing when the chain has no deployment, so a
 * user on the wrong network sees a prompt to switch instead of a crashed page.
 */
export function useAddresses(): { addresses: Addresses; chainId: number; deployed: boolean } {
  const chainId = useChainId();
  return { addresses: addressesFor(chainId), chainId, deployed: isDeployed(chainId) };
}

/** Builds a wagmi read config, or undefined when the contract is not on this chain. */
export function contractFor<T extends keyof typeof ABIS>(
  addresses: Addresses,
  name: T
): { address: `0x${string}`; abi: (typeof ABIS)[T] } | undefined {
  const address = addresses[name as ContractName];
  if (!address) return undefined;
  return { address, abi: ABIS[name] };
}

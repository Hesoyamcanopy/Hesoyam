import { defineChain, type Chain } from "viem";
import { arbitrumSepolia } from "viem/chains";

/**
 * The local development chain. Present in the config on purpose, because most of the
 * team runs against it and a chain missing from the config cannot be added to a
 * wallet through `wallet_addEthereumChain`.
 */
export const hardhatLocal = defineChain({
  id: 31337,
  name: "Hesoyam Local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  testnet: true,
});

/**
 * Robinhood Chain. Arbitrum Orbit, ETH for gas.
 *
 * Both of these are real and answering: mainnet 4663 and testnet 46630 respond to
 * eth_chainId on the public RPCs below. Those public endpoints are rate limited,
 * so set NEXT_PUBLIC_ROBINHOOD_RPC to an Alchemy URL for anything with traffic.
 */
export const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      http: [process.env.NEXT_PUBLIC_ROBINHOOD_RPC || "https://rpc.mainnet.chain.robinhood.com"],
    },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
});

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      http: [
        process.env.NEXT_PUBLIC_ROBINHOOD_TESTNET_RPC || "https://rpc.testnet.chain.robinhood.com",
      ],
    },
  },
  blockExplorers: {
    default: { name: "Explorer", url: "https://explorer.testnet.chain.robinhood.com" },
  },
  testnet: true,
});

/**
 * An escape hatch for any other chain, driven entirely from the environment.
 *
 * Kept now that Robinhood Chain is defined properly above, because the launch
 * chain could still change and this avoids a rebuild to point somewhere else.
 */
export const hesoyamTarget = defineChain({
  id: Number(process.env.NEXT_PUBLIC_TARGET_CHAIN_ID || 0) || 31338,
  name: process.env.NEXT_PUBLIC_TARGET_CHAIN_NAME || "Hesoyam Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_TARGET_RPC || ""] } },
  blockExplorers: process.env.NEXT_PUBLIC_TARGET_EXPLORER
    ? { default: { name: "Explorer", url: process.env.NEXT_PUBLIC_TARGET_EXPLORER } }
    : undefined,
  testnet: true,
});

export const targetIsConfigured = Boolean(process.env.NEXT_PUBLIC_TARGET_RPC);

/**
 * The chain a visitor reads from before connecting a wallet.
 *
 * The fallback differs by build because getting it wrong differs by build. A
 * production deploy that forgets NEXT_PUBLIC_DEFAULT_CHAIN_ID should read the
 * launch chain, not point the public site at a local node nobody can reach.
 */
export const DEFAULT_CHAIN_ID = Number(
  process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID ||
    (process.env.NODE_ENV === "production" ? 4663 : 31337)
);

const ALL_CHAINS: [Chain, ...Chain[]] = [
  robinhood,
  robinhoodTestnet,
  hardhatLocal,
  arbitrumSepolia,
  ...(targetIsConfigured ? [hesoyamTarget] : []),
];

/**
 * The default chain leads the list.
 *
 * With no wallet connected, wagmi reads against `chains[0]` rather than anything
 * this file calls a default. Leaving the order fixed meant a read only visitor
 * on a local build was querying Robinhood mainnet, so the room came back empty
 * and every deployment lookup missed.
 */
export const SUPPORTED_CHAINS: [Chain, ...Chain[]] = (() => {
  const preferred = ALL_CHAINS.find((c) => c.id === DEFAULT_CHAIN_ID);
  if (!preferred) return ALL_CHAINS;
  return [preferred, ...ALL_CHAINS.filter((c) => c.id !== preferred.id)];
})();

export function explorerTx(chainId: number, hash: string): string | null {
  const chain = SUPPORTED_CHAINS.find((c) => c.id === chainId);
  const base = chain?.blockExplorers?.default?.url;
  return base ? `${base}/tx/${hash}` : null;
}

export function chainName(chainId: number): string {
  return SUPPORTED_CHAINS.find((c) => c.id === chainId)?.name ?? `Chain ${chainId}`;
}

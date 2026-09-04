import { createConfig, http, cookieStorage, createStorage } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";
import {
  SUPPORTED_CHAINS,
  hardhatLocal,
  hesoyamTarget,
  robinhood,
  robinhoodTestnet,
  targetIsConfigured,
} from "./chain";
import { arbitrumSepolia } from "viem/chains";

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_ID;

/**
 * Wallet configuration.
 *
 * WalletConnect is only registered when a project id is present. Registering it
 * without one throws at runtime, and a landing page that crashes because an optional
 * integration is unconfigured is worse than not offering it.
 */
const connectors = [
  injected({ shimDisconnect: true }),
  ...(projectId
    ? [
        walletConnect({
          projectId,
          showQrModal: true,
          metadata: {
            name: "HESOYAM CANOPY",
            description: "An on-chain grow economy.",
            url: process.env.NEXT_PUBLIC_SITE_URL || "https://hesoyam.fi",
            icons: [],
          },
        }),
      ]
    : []),
];

export const wagmiConfig = createConfig({
  chains: SUPPORTED_CHAINS,
  connectors,
  ssr: true,
  storage: createStorage({ storage: cookieStorage }),
  /**
   * One transport per chain in `chains`, with no exceptions.
   *
   * A chain listed without a transport does not degrade, it throws
   * `transports[chainId] is not a function` on the first read and takes the
   * whole page down with it. Robinhood mainnet and testnet were missing here,
   * which is the launch chain, so this has to stay exhaustive.
   *
   * `http()` with no argument uses the chain's own rpcUrls, which for Robinhood
   * already honours NEXT_PUBLIC_ROBINHOOD_RPC.
   */
  transports: {
    [robinhood.id]: http(),
    [robinhoodTestnet.id]: http(),
    [hardhatLocal.id]: http("http://127.0.0.1:8545"),
    [arbitrumSepolia.id]: http(process.env.NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC),
    ...(targetIsConfigured ? { [hesoyamTarget.id]: http(process.env.NEXT_PUBLIC_TARGET_RPC) } : {}),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}

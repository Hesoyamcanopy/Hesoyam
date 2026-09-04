"use client";

import { useEffect, useState } from "react";
import { useAccount, useConnect, useDisconnect, useChainId, useSwitchChain, useBalance } from "wagmi";
import { SUPPORTED_CHAINS, DEFAULT_CHAIN_ID, chainName } from "../lib/chain";
import { isDeployed } from "../lib/contracts";
import { shortAddress } from "../lib/format";
import { explainError } from "../lib/errors";

/**
 * Wallet connection.
 *
 * Three states a player can be in, and all three are visible rather than implied:
 * disconnected, connected to a chain with no Hesoyam deployment, and ready.
 */
export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connectors, connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const { switchChain, isPending: switching } = useSwitchChain();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  // Wallet state differs between server and client, so nothing wallet dependent is
  // rendered until after hydration.
  useEffect(() => setMounted(true), []);

  const { data: balance } = useBalance({ address, query: { enabled: Boolean(address) } });

  if (!mounted) {
    return (
      <span className="btn btn-ghost btn-sm" aria-hidden="true" style={{ opacity: 0.5 }}>
        Connect
      </span>
    );
  }

  if (!isConnected) {
    return (
      <div style={{ position: "relative" }}>
        <button className="btn btn-primary btn-sm" onClick={() => setOpen((v) => !v)} type="button">
          {isPending ? "Check your wallet" : "Connect wallet"}
        </button>
        {open ? (
          <div className="dropdown">
            <p className="dropdown-title">Choose a wallet</p>
            {connectors.length === 0 ? (
              <p className="dropdown-empty">No wallet detected in this browser.</p>
            ) : (
              connectors.map((c) => (
                <button
                  key={c.uid}
                  className="dropdown-item"
                  type="button"
                  onClick={() => {
                    connect({ connector: c, chainId: DEFAULT_CHAIN_ID });
                    setOpen(false);
                  }}
                >
                  {c.name}
                </button>
              ))
            )}
            {error ? <p className="dropdown-error">{explainError(error).title}</p> : null}
            <p className="dropdown-note">
              Connecting only proves you hold the address. It cannot move anything.
            </p>
          </div>
        ) : null}
      </div>
    );
  }

  if (!isDeployed(chainId)) {
    return (
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span className="pill pill-warn">No Hesoyam on {chainName(chainId)}</span>
        <button
          className="btn btn-primary btn-sm"
          type="button"
          disabled={switching}
          onClick={() => switchChain({ chainId: DEFAULT_CHAIN_ID })}
        >
          {switching ? "Switching" : `Switch to ${chainName(DEFAULT_CHAIN_ID)}`}
        </button>
      </div>
    );
  }

  return (
    <div style={{ position: "relative" }}>
      <button className="wallet-chip" onClick={() => setOpen((v) => !v)} type="button">
        <span className="wallet-dot" aria-hidden="true" />
        <span className="mono">{shortAddress(address)}</span>
        {balance ? (
          <span className="mono wallet-balance">
            {Number(balance.formatted).toFixed(3)} {balance.symbol}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="dropdown">
          <p className="dropdown-title">{chainName(chainId)}</p>
          {SUPPORTED_CHAINS.filter((c) => c.id !== chainId).map((c) => (
            <button
              key={c.id}
              className="dropdown-item"
              type="button"
              onClick={() => {
                switchChain({ chainId: c.id });
                setOpen(false);
              }}
            >
              Switch to {c.name}
              {isDeployed(c.id) ? "" : " (not deployed)"}
            </button>
          ))}
          <button
            className="dropdown-item dropdown-danger"
            type="button"
            onClick={() => {
              disconnect();
              setOpen(false);
            }}
          >
            Disconnect
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Blocks a page until the wallet is connected to a chain that has a deployment. */
const SPECTATE_KEY = "hesoyam.spectate.v1";
const WATCH_KEY = "hesoyam.watch.v1";

const isAddress = (v: string): v is `0x${string}` => /^0x[0-9a-fA-F]{40}$/.test(v);

/**
 * The address the page reads positions for.
 *
 * A connected wallet is always the answer when there is one. Without one, a read
 * only visitor may name an address to watch, which turns the empty spectator
 * view into somebody's actual grow room. Watching only reads: every write in the
 * app goes through TxButton, which stays disabled while disconnected.
 */
export function useViewer() {
  const { address: connected } = useAccount();
  const [watched, setWatched] = useState<`0x${string}` | undefined>();

  useEffect(() => {
    // A link is the easiest way to hand someone a room to look at, so the query
    // string wins over whatever the tab happened to remember.
    const fromUrl = new URLSearchParams(window.location.search).get("as") || "";
    if (isAddress(fromUrl)) {
      try {
        sessionStorage.setItem(WATCH_KEY, fromUrl);
      } catch {
        // Blocked site data. The address still applies to this page view.
      }
      setWatched(fromUrl);
      return;
    }
    try {
      const saved = sessionStorage.getItem(WATCH_KEY) || "";
      if (isAddress(saved)) setWatched(saved);
    } catch {
      // See above.
    }
  }, []);

  const watch = (value: string) => {
    const next = isAddress(value) ? value : undefined;
    try {
      if (next) sessionStorage.setItem(WATCH_KEY, next);
      else sessionStorage.removeItem(WATCH_KEY);
    } catch {
      // See above.
    }
    setWatched(next);
  };

  return { address: connected ?? watched, watching: !connected && Boolean(watched), watch };
}

/**
 * Read only browsing.
 *
 * Kept in sessionStorage rather than component state so it survives navigating
 * between rooms, and dies with the tab. A spectator sees real chain state, just
 * none of their own, because there is no address to read positions for.
 */
export function useSpectator() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    // Arriving on a link that names a room to watch is itself the request to
    // look around, so it does not also need the button to have been pressed.
    const fromUrl = new URLSearchParams(window.location.search).get("as") || "";
    if (isAddress(fromUrl)) {
      setOn(true);
      return;
    }
    try {
      setOn(sessionStorage.getItem(SPECTATE_KEY) === "1");
    } catch {
      // Private mode and blocked site data both throw. Not being able to
      // remember the choice is not a reason to fail the page.
    }
  }, []);
  const enable = () => {
    try {
      sessionStorage.setItem(SPECTATE_KEY, "1");
    } catch {
      // Ignored, see above. The flag still works for this page view.
    }
    setOn(true);
  };
  return { spectating: on, enable };
}

/** The read only banner, plus the box that points it at a room to watch. */
function SpectateStrip() {
  const { address, watching, watch } = useViewer();
  const [draft, setDraft] = useState("");

  return (
    <div className="spectate-strip">
      <span className="risk-tag">Read only</span>
      {watching ? (
        <>
          <span>
            Watching <span className="mono">{shortAddress(address)}</span>. This is their room,
            live from the chain. Nothing here can be signed.
          </span>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => watch("")}>
            Stop watching
          </button>
        </>
      ) : (
        <>
          <span>Looking around without a wallet. Paste an address to watch its room.</span>
          <form
            className="spectate-form"
            onSubmit={(e) => {
              e.preventDefault();
              watch(draft.trim());
            }}
          >
            <input
              className="input mono"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="0x"
              spellCheck={false}
              aria-label="Address to watch"
            />
            <button className="btn btn-ghost btn-sm" type="submit">
              Watch
            </button>
          </form>
        </>
      )}
      <ConnectButton />
    </div>
  );
}

export function RequireWallet({ children }: { children: React.ReactNode }) {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const [mounted, setMounted] = useState(false);
  const { spectating, enable } = useSpectator();
  useEffect(() => setMounted(true), []);

  if (!mounted) return <div className="panel panel-quiet">Loading.</div>;

  if (!isConnected && spectating) {
    return (
      <>
        <SpectateStrip />
        {children}
      </>
    );
  }

  if (!isConnected) {
    return (
      <div className="panel panel-quiet">
        <h3>Connect a wallet to continue</h3>
        <p>
          Everything on this page reads your own positions. Nothing is signed until you ask
          for it.
        </p>
        <div className="row-actions">
          <ConnectButton />
          <button className="btn btn-ghost" type="button" onClick={enable}>
            Look around first
          </button>
        </div>
        <p className="panel-note">
          Read only browsing needs no wallet and signs nothing. You will see the strains, the
          fees and the state of the economy. Name an address once you are in and you will see
          that room too, plants and all.
        </p>
      </div>
    );
  }

  if (!isDeployed(chainId)) {
    return (
      <div className="panel panel-quiet">
        <h3>Hesoyam is not deployed on {chainName(chainId)}</h3>
        <p>Switch to a network where the contracts exist.</p>
        <ConnectButton />
      </div>
    );
  }

  return <>{children}</>;
}

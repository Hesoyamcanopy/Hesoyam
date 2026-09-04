"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { isAddress } from "viem";
import { MAINNET_LAUNCH_ISO, MAINNET_LAUNCH_MS, remainingUntil } from "../lib/launch";

const PAD = (n: number) => String(n).padStart(2, "0");

/**
 * Countdown to the mainnet launch instant.
 *
 * Renders held placeholders until after mount. The server and the browser are
 * never on the same millisecond, so rendering real digits on the server would
 * guarantee a hydration mismatch on every load.
 */
export function LaunchCountdown() {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const left = now === null ? null : remainingUntil(now, MAINNET_LAUNCH_MS);

  const cells: Array<[string, string]> = [
    ["Days", left ? String(left.days) : "--"],
    ["Hours", left ? PAD(left.hours) : "--"],
    ["Minutes", left ? PAD(left.minutes) : "--"],
    ["Seconds", left ? PAD(left.seconds) : "--"],
  ];

  const launchLabel = useMemo(
    () =>
      new Date(MAINNET_LAUNCH_ISO).toLocaleString(undefined, {
        dateStyle: "full",
        timeStyle: "short",
      }),
    []
  );

  if (left?.passed) {
    return (
      <div className="countdown countdown-live">
        <p className="countdown-live-title">Mainnet is live</p>
        <p className="countdown-live-sub">
          The wait is over. Open the app and go plant something.
        </p>
      </div>
    );
  }

  return (
    <div className="countdown">
      <ol className="countdown-cells">
        {cells.map(([label, value]) => (
          <li className="countdown-cell" key={label}>
            <span className="countdown-v">{value}</span>
            <span className="countdown-k">{label}</span>
          </li>
        ))}
      </ol>
      <p className="countdown-target">
        Mainnet opens {" "}
        <time dateTime={MAINNET_LAUNCH_ISO} suppressHydrationWarning>
          {now === null ? "soon" : launchLabel}
        </time>
      </p>
    </div>
  );
}

type State =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "done" }
  | { kind: "error"; message: string };

/**
 * Waitlist signup.
 *
 * Prefills from a connected wallet when there is one, and otherwise takes a pasted
 * address. Nothing here is signed, so nothing here is a claim. That is stated on
 * the page rather than left for someone to assume.
 */
export function WaitlistForm() {
  const { address } = useAccount();
  const [wallet, setWallet] = useState("");
  const [touched, setTouched] = useState(false);
  const [state, setState] = useState<State>({ kind: "idle" });

  // Prefill once a wallet appears, without stomping on something already typed.
  useEffect(() => {
    if (address && !touched) setWallet(address);
  }, [address, touched]);

  const trimmed = wallet.trim();
  const valid = isAddress(trimmed);
  const showInvalid = touched && trimmed.length > 0 && !valid;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!valid || state.kind === "sending") return;

    setState({ kind: "sending" });
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: trimmed, source: address ? "connected" : "pasted" }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };

      if (!res.ok) {
        setState({ kind: "error", message: data.error ?? "Could not save that. Try again." });
        return;
      }
      setState({ kind: "done" });
    } catch {
      setState({ kind: "error", message: "Network problem. Check your connection and try again." });
    }
  }

  if (state.kind === "done") {
    return (
      <div className="waitlist-done">
        <p className="waitlist-done-title">You are on the list</p>
        <p className="waitlist-done-sub">
          Saved <code className="waitlist-done-addr">{trimmed}</code>. Nothing else to do.
          Come back when the clock runs out.
        </p>
        <a className="btn btn-ghost btn-sm" href="/app">
          Play the testnet in the meantime
        </a>
      </div>
    );
  }

  return (
    <form className="waitlist-form" onSubmit={submit} noValidate>
      <label className="waitlist-label" htmlFor="waitlist-wallet">
        Wallet address
      </label>
      <div className="waitlist-controls">
        <input
          id="waitlist-wallet"
          className="waitlist-input"
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="0x..."
          value={wallet}
          aria-invalid={showInvalid}
          aria-describedby={showInvalid ? "waitlist-error" : "waitlist-note"}
          onChange={(e) => {
            setTouched(true);
            setWallet(e.target.value);
            if (state.kind === "error") setState({ kind: "idle" });
          }}
        />
        <button
          className="btn btn-primary"
          type="submit"
          disabled={!valid || state.kind === "sending"}
        >
          {state.kind === "sending" ? "Saving" : "Join the waitlist"}
        </button>
      </div>

      {showInvalid ? (
        <p className="waitlist-msg waitlist-msg-bad" id="waitlist-error">
          That is not a valid address. It should start with 0x and be 42 characters.
        </p>
      ) : state.kind === "error" ? (
        <p className="waitlist-msg waitlist-msg-bad" role="alert">
          {state.message}
        </p>
      ) : (
        <p className="waitlist-msg" id="waitlist-note">
          {address
            ? "Filled in from your connected wallet. You can paste a different one."
            : "Paste the address you want on the list, or connect in the app to fill it in."}
        </p>
      )}
    </form>
  );
}

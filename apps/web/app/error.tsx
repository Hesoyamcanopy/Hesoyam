"use client";

import { useEffect } from "react";
import { captureError } from "../lib/log";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureError(error, { scope: "app-boundary", digest: error.digest });
  }, [error]);

  return (
    <main className="wrap" style={{ paddingTop: 160, paddingBottom: 160, maxWidth: 640 }}>
      <p className="eyebrow">Something broke</p>
      <h1 style={{ fontSize: 40, letterSpacing: "-0.03em", lineHeight: 1.08, margin: "16px 0 0" }}>
        That page did not load.
      </h1>
      <p style={{ color: "var(--ink-2)", marginTop: 16, fontSize: 16.5, lineHeight: 1.6 }}>
        The error has been recorded. Nothing on chain was affected, because pages do not
        move value. You can retry, or head back to the start.
      </p>
      {error.digest ? (
        <p className="mono" style={{ color: "var(--ink-3)", marginTop: 20, fontSize: 12.5 }}>
          reference {error.digest}
        </p>
      ) : null}
      <div style={{ display: "flex", gap: 12, marginTop: 28, flexWrap: "wrap" }}>
        <button className="btn btn-primary" onClick={reset} type="button">
          Try again
        </button>
        <a className="btn btn-ghost" href="/">
          Back to the start
        </a>
      </div>
    </main>
  );
}

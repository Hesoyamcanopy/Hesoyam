"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt, useChainId } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import type { Abi } from "viem";
import { explainError, type FriendlyError } from "../lib/errors";
import { explorerTx } from "../lib/chain";
import { shortHash } from "../lib/format";
import { captureError } from "../lib/log";
import { useViewer } from "./connect";

export type TxState = "idle" | "signing" | "mining" | "done" | "error";

/**
 * One transaction, with every state a player actually sees.
 *
 * The pending states are split on purpose. "Confirm in your wallet" and "Waiting for
 * the chain" are different problems with different fixes, and collapsing them into a
 * single spinner is how a stuck wallet prompt goes unnoticed.
 */
export function useTx(options?: { onDone?: () => void; invalidate?: boolean }) {
  const { writeContractAsync } = useWriteContract();
  const queryClient = useQueryClient();
  const chainId = useChainId();

  const [hash, setHash] = useState<`0x${string}` | undefined>();
  const [state, setState] = useState<TxState>("idle");
  const [error, setError] = useState<FriendlyError | null>(null);

  const receipt = useWaitForTransactionReceipt({ hash, query: { enabled: Boolean(hash) } });

  useEffect(() => {
    if (!hash) return;
    if (receipt.isSuccess) {
      setState("done");
      if (options?.invalidate !== false) void queryClient.invalidateQueries();
      options?.onDone?.();
    }
    if (receipt.isError) {
      setState("error");
      setError({ title: "The transaction was mined but reverted.", rejected: false, raw: "reverted" });
    }
    // options is intentionally not a dependency: callers pass inline objects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash, receipt.isSuccess, receipt.isError, queryClient]);

  const run = useCallback(
    async (config: { address: `0x${string}`; abi: Abi; functionName: string; args?: readonly unknown[] }) => {
      setError(null);
      setHash(undefined);
      setState("signing");
      try {
        const h = await writeContractAsync({
          address: config.address,
          abi: config.abi,
          functionName: config.functionName,
          args: config.args as never,
        } as never);
        setHash(h);
        setState("mining");
        return h;
      } catch (e) {
        const friendly = explainError(e);
        setError(friendly);
        setState("error");
        if (!friendly.rejected) {
          captureError(e, { scope: "tx", functionName: config.functionName });
        }
        return undefined;
      }
    },
    [writeContractAsync]
  );

  const reset = useCallback(() => {
    setState("idle");
    setError(null);
    setHash(undefined);
  }, []);

  return { run, reset, state, error, hash, explorer: hash ? explorerTx(chainId, hash) : null };
}

export function TxStatus({ tx }: { tx: ReturnType<typeof useTx> }) {
  if (tx.state === "idle") return null;

  if (tx.state === "error" && tx.error) {
    // A rejection is not a failure, it is a person changing their mind, so it
    // stays quiet. A revert gets the banner.
    if (tx.error.rejected) {
      return (
        <div className="tx-note tx-note-quiet">
          <span>{tx.error.title}</span>
          <button className="tx-dismiss" type="button" onClick={tx.reset}>
            Dismiss
          </button>
        </div>
      );
    }
    return (
      <div className="tx-outcome">
        <span className="sa-banner sa-banner-bad">Deal fell through</span>
        <p className="sa-banner-sub">{tx.error.title}</p>
        <button className="tx-dismiss" type="button" onClick={tx.reset}>
          Dismiss
        </button>
      </div>
    );
  }

  if (tx.state === "signing") return <div className="tx-note">Confirm in your wallet.</div>;

  if (tx.state === "mining") {
    return (
      <div className="tx-note">
        Waiting for the chain.{" "}
        {tx.explorer ? (
          <a href={tx.explorer} target="_blank" rel="noreferrer">
            {shortHash(tx.hash)}
          </a>
        ) : (
          <span className="mono">{shortHash(tx.hash)}</span>
        )}
      </div>
    );
  }

  return (
    <div className="tx-outcome">
      <span className="sa-banner sa-banner-good">Deal closed</span>
      <p className="sa-banner-sub">
        Settled on chain.{" "}
        {tx.explorer ? (
          <a href={tx.explorer} target="_blank" rel="noreferrer">
            {shortHash(tx.hash)}
          </a>
        ) : (
          <span className="mono">{shortHash(tx.hash)}</span>
        )}
      </p>
      <button className="tx-dismiss" type="button" onClick={tx.reset}>
        Dismiss
      </button>
    </div>
  );
}

export function TxButton({
  tx,
  onClick,
  children,
  disabled,
  variant = "primary",
  title,
}: {
  tx: ReturnType<typeof useTx>;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  variant?: "primary" | "ghost";
  title?: string;
}) {
  const busy = tx.state === "signing" || tx.state === "mining";
  // A read only visitor has no account to sign with. Disabling here covers every
  // write in the app, because they all go through this button.
  const { isConnected } = useAccount();
  return (
    <button
      className={`btn btn-${variant} btn-sm`}
      type="button"
      title={isConnected ? title : "Connect a wallet to do this"}
      disabled={disabled || busy || !isConnected}
      onClick={onClick}
    >
      {busy ? (tx.state === "signing" ? "Confirm" : "Working") : children}
    </button>
  );
}

/**
 * ERC-20 allowance, and the approval that fixes it.
 *
 * Approves the exact amount rather than an unlimited allowance. It costs one more
 * transaction the first time and means a bug in a spender cannot drain a wallet.
 */
export function useAllowance(token?: { address: `0x${string}`; abi: Abi }, spender?: `0x${string}`) {
  const { address } = useViewer();

  const { data, refetch } = useReadContract({
    address: token?.address,
    abi: token?.abi,
    functionName: "allowance",
    args: address && spender ? [address, spender] : undefined,
    query: { enabled: Boolean(token && address && spender) },
  });

  const allowance = (data as bigint | undefined) ?? 0n;

  return {
    allowance,
    refetch,
    isEnough: (amount: bigint) => allowance >= amount,
  };
}

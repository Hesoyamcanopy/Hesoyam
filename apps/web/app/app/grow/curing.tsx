"use client";

import { useEffect, useState } from "react";
import { useReadContract, useReadContracts } from "wagmi";
import { useViewer } from "../../../components/connect";
import { applyCure, tierForQuality } from "@hesoyam/game-core";
import { TIER_NAMES } from "@hesoyam/sdk";
import { Panel, Empty, Pill, Row } from "../../../components/ui";
import { useTx, TxStatus, TxButton } from "../../../components/tx";
import { units, timeUntil } from "../../../lib/format";

const MAX_SCANNED = 60;

/**
 * Harvests that are curing, and the collect step that finishes them.
 *
 * Without this the loop dead ends: a player who chose to cure has Flower they cannot
 * reach, because minting is deliberately deferred until the cure completes.
 */
export function CuringPanel({ gameC }: { gameC: { address: `0x${string}`; abi: readonly unknown[] } }) {
  const { address } = useViewer();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const { data: nextId } = useReadContract({
    address: gameC.address,
    abi: gameC.abi as never,
    functionName: "nextHarvestId",
  });

  const total = Number((nextId as bigint | undefined) ?? 1n) - 1;
  const scanned = Math.min(total, MAX_SCANNED);
  const firstId = Math.max(1, total - scanned + 1);

  const { data } = useReadContracts({
    contracts: Array.from({ length: scanned }, (_, i) => ({
      address: gameC.address,
      abi: gameC.abi as never,
      functionName: "pendingHarvests" as const,
      args: [BigInt(firstId + i)],
    })),
    query: { enabled: scanned > 0 },
  });

  const mine = (data ?? [])
    .map((r, i) => {
      const h = r.result as readonly [`0x${string}`, number, number, number, bigint, boolean] | undefined;
      if (!h) return undefined;
      if (h[0].toLowerCase() !== address?.toLowerCase()) return undefined;
      if (h[5]) return undefined;
      return {
        id: BigInt(firstId + i),
        strainId: Number(h[1]),
        units: Number(h[2]),
        quality: Number(h[3]),
        readyAt: Number(h[4]),
      };
    })
    .filter((h): h is NonNullable<typeof h> => Boolean(h));

  if (total <= 0) return null;

  return (
    <Panel title="Curing" subtitle="Two days in the jar, then collect. The cure is worth up to 12 quality.">
      {mine.length === 0 ? (
        <Empty title="Nothing is curing." />
      ) : (
        <div className="curing-list">
          {mine.map((h) => (
            <CuringRow key={h.id.toString()} harvest={h} gameC={gameC} now={now} />
          ))}
        </div>
      )}
    </Panel>
  );
}

function CuringRow({
  harvest,
  gameC,
  now,
}: {
  harvest: { id: bigint; strainId: number; units: number; quality: number; readyAt: number };
  gameC: { address: `0x${string}`; abi: readonly unknown[] };
  now: number;
}) {
  const tx = useTx();
  const ready = now >= harvest.readyAt;
  const cured = applyCure(harvest.quality);
  const tier = tierForQuality(cured);

  return (
    <div className="curing-row">
      <div className="curing-main">
        <span className="mono">Strain {harvest.strainId}</span>
        <span className="mono">{units(harvest.units)} units</span>
        <Pill tone={ready ? "cash" : "amber"}>
          {ready ? "ready" : timeUntil(harvest.readyAt, now)}
        </Pill>
      </div>
      <Row
        label="Quality after curing"
        value={`${harvest.quality} to ${cured}, ${TIER_NAMES[tier]}`}
        tone={tier === 2 ? "cash" : undefined}
      />
      <TxButton
        tx={tx}
        disabled={!ready}
        onClick={() =>
          void tx.run({
            address: gameC.address,
            abi: gameC.abi as never,
            functionName: "collect",
            args: [harvest.id],
          })
        }
      >
        Collect
      </TxButton>
      <TxStatus tx={tx} />
    </div>
  );
}

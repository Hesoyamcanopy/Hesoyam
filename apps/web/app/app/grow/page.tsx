"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBlock, useReadContract, useReadContracts } from "wagmi";
import { keccak256, encodeAbiParameters, parseAbiParameters } from "viem";
import {
  careScore,
  feedWindow,
  eventWindow,
  firedMask,
  growProgress,
  maturesAt,
  nextActions,
  qualityRange,
  tierForQuality,
  yieldUnits,
  cycleCost,
  type Strain,
} from "@hesoyam/game-core";
import { useAddresses, contractFor } from "../../../lib/contracts";
import { RequireWallet, useViewer } from "../../../components/connect";
import { Panel, StatGrid, Stat, Empty, Row, Track, Pill, Field, Warning } from "../../../components/ui";
import { useTx, TxStatus, TxButton, useAllowance } from "../../../components/tx";
import { RoomView, type RoomBench, type RoomAction } from "../../../components/room";
import { hesoyam, units, timeUntil, dateOf } from "../../../lib/format";
import { CuringPanel } from "./curing";

/** Salts are kept per grow in local storage. Losing one makes a harvest unclaimable. */
const SALT_KEY = "hesoyam.salts.v1";

function loadSalts(): Record<string, `0x${string}`> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(SALT_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveSalt(key: string, salt: `0x${string}`) {
  const all = loadSalts();
  all[key] = salt;
  window.localStorage.setItem(SALT_KEY, JSON.stringify(all));
}

function randomSalt(): `0x${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return ("0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
}

const commitFor = (salt: `0x${string}`) =>
  keccak256(encodeAbiParameters(parseAbiParameters("bytes32"), [salt]));

/**
 * The current time, as the chain sees it.
 *
 * This used to return the browser clock, which is wrong: every deadline in the
 * game is enforced against block.timestamp. The two drift on any chain, and on a
 * local one they can be days apart, so the interface would happily say a grow
 * was ready while the transaction reverted NotMature, or hide a feed window that
 * was actually open.
 *
 * Anchored to the latest block and interpolated between blocks, so the progress
 * bar still moves smoothly without lying about which second it is.
 */
function useNow(intervalMs = 1000) {
  const { data: block } = useBlock({ watch: true });
  const anchor = useRef<{ chain: number; local: number } | null>(null);
  const [, tick] = useState(0);

  if (block?.timestamp !== undefined) {
    const chain = Number(block.timestamp);
    if (!anchor.current || anchor.current.chain !== chain) {
      anchor.current = { chain, local: Date.now() };
    }
  }

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);

  if (!anchor.current) return Math.floor(Date.now() / 1000);
  return anchor.current.chain + Math.floor((Date.now() - anchor.current.local) / 1000);
}

export default function GrowPage() {
  const { address } = useViewer();

  // Populated by GrowBody once a wallet is connected. Empty before that, which
  // is a walkable empty room rather than a missing feature.
  const [roomActions, setRoomActions] = useState<{ fn: (b: RoomBench) => RoomAction[] }>({
    fn: () => [],
  });
  const [roomState, setRoomState] = useState<Record<string, RoomBench>>({});
  const reportBench = useCallback((b: RoomBench) => {
    setRoomState((prev) => {
      const key = b.id.toString();
      const old = prev[key];
      if (
        old &&
        old.progress === b.progress &&
        old.care === b.care &&
        old.ready === b.ready &&
        old.growId === b.growId &&
        old.feedIndex === b.feedIndex &&
        old.treatSlot === b.treatSlot
      ) {
        return prev;
      }
      return { ...prev, [key]: b };
    });
  }, []);

  const roomBenches = useMemo(() => Object.values(roomState), [roomState]);

  return (
    <div className="page">
      <header className="page-head">
        <h1>Grow room</h1>
        <p>
          Growth is a pure function of time and the care you gave. Miss a window and the
          plant stalls, ignore an event and you lose yield.
        </p>
      </header>

      <RoomView
        benches={roomBenches}
        playerName={address ? address.slice(2, 8) : "grower"}
        actionsFor={roomActions.fn}
      />

      <RequireWallet>
        <GrowBody onBenchState={reportBench} onActions={setRoomActions} />
      </RequireWallet>
    </div>
  );
}

function GrowBody({
  onBenchState,
  onActions,
}: {
  onBenchState: (b: RoomBench) => void;
  onActions: (a: { fn: (b: RoomBench) => RoomAction[] }) => void;
}) {
  const { address } = useViewer();
  const roomTx = useTx();
  const { addresses } = useAddresses();
  const now = useNow();

  const benchC = contractFor(addresses, "GrowBench");
  const gameC = contractFor(addresses, "GrowGame");
  const registryC = contractFor(addresses, "StrainRegistry");
  const hesoyamC = contractFor(addresses, "HesoyamToken");

  const { data: benchCount } = useReadContract({
    ...benchC!,
    functionName: "balanceOf",
    args: [address!],
    query: { enabled: Boolean(benchC && address) },
  });

  const owned = Number((benchCount as bigint | undefined) ?? 0n);

  const { data: benchIds } = useReadContracts({
    contracts: Array.from({ length: owned }, (_, i) => ({
      ...benchC!,
      functionName: "tokenOfOwnerByIndex" as const,
      args: [address!, BigInt(i)],
    })),
    query: { enabled: Boolean(benchC && address && owned > 0) },
  });

  const ids = useMemo(
    () => (benchIds ?? []).map((r) => r.result as bigint | undefined).filter((v): v is bigint => v !== undefined),
    [benchIds]
  );

  const { data: benchState } = useReadContracts({
    contracts: ids.flatMap((id) => [
      { ...benchC!, functionName: "tierOf" as const, args: [id] },
      { ...gameC!, functionName: "benchBusyWith" as const, args: [id] },
    ]),
    query: { enabled: ids.length > 0 },
  });

  const benches = ids.map((id, i) => ({
    id,
    tier: Number((benchState?.[i * 2]?.result as number | undefined) ?? 0),
    growId: (benchState?.[i * 2 + 1]?.result as bigint | undefined) ?? 0n,
  }));

  const { data: strainCount } = useReadContract({
    ...registryC!,
    functionName: "count",
    query: { enabled: Boolean(registryC) },
  });

  const nStrains = Number((strainCount as bigint | undefined) ?? 0n);

  const { data: strainData } = useReadContracts({
    contracts: Array.from({ length: nStrains }, (_, i) => ({
      ...registryC!,
      functionName: "get" as const,
      args: [i],
    })),
    query: { enabled: Boolean(registryC && nStrains > 0) },
  });

  const strains = (strainData ?? []).map((r, i) => {
    const s = r.result as
      | {
          cycleSeconds: number;
          baseYield: number;
          geneticsBps: number;
          eventChance: number;
          geneQuality: number;
          seedPrice: bigint;
          active: boolean;
          name: string;
        }
      | undefined;
    return s ? { id: i, ...s } : undefined;
  });

  const { data: fees } = useReadContracts({
    contracts: [
      { ...gameC!, functionName: "nutrientFee" as const },
      { ...gameC!, functionName: "treatmentFee" as const },
      { ...gameC!, functionName: "utilityPerDay" as const },
      { ...gameC!, functionName: "cureFee" as const },
    ],
    query: { enabled: Boolean(gameC) },
  });

  const feeOf = (i: number) => (fees?.[i]?.result as bigint | undefined) ?? 0n;

  const allowance = useAllowance(hesoyamC, gameC?.address);

  /**
   * What you can do standing in front of a given bench.
   *
   * These call exactly the same contract functions the panels below do. The room
   * is another way to reach them, never a second implementation of them.
   */
  const gameAddr = gameC?.address;
  const gameAbi = gameC?.abi;
  const firstStrain = strains.find((s) => s?.active) ?? null;

  const buildActions = useCallback(
    (b: RoomBench): RoomAction[] => {
      if (!gameAddr || !gameAbi) return [];
      const call = (functionName: string, args: unknown[]) =>
        void roomTx.run({ address: gameAddr, abi: gameAbi as never, functionName, args });

      // An empty bench: plant the first active strain. The salt is stored the
      // same way the panel stores it, because harvest needs it either way.
      if (b.growId === 0n) {
        if (!firstStrain) return [];
        return [
          {
            label: `Plant ${firstStrain.name}`,
            onRun: () => {
              const salt = randomSalt();
              saveSalt(`${gameAddr}:${b.id}`, salt);
              call("plant", [firstStrain.id, Number(b.id), commitFor(salt)]);
            },
          },
        ];
      }

      const out: RoomAction[] = [];
      if (b.feedIndex !== null) {
        const i = b.feedIndex;
        out.push({ label: `Feed window ${i + 1}`, onRun: () => call("feed", [b.growId, i]) });
      }
      if (b.treatSlot !== null) {
        const slot = b.treatSlot;
        out.push({ label: `Treat pest ${slot + 1}`, onRun: () => call("treat", [b.growId, slot]) });
      }
      if (b.ready) {
        const salt = loadSalts()[`${gameAddr}:${b.id}`];
        out.push({
          label: salt ? "Harvest" : "Harvest, secret missing",
          disabled: !salt,
          onRun: () => salt && call("harvest", [b.growId, salt, false]),
        });
      }
      return out;
    },
    [gameAddr, gameAbi, firstStrain, roomTx]
  );

  /**
   * Published once, not on every render.
   *
   * `buildActions` closes over live state and `useTx`, which hands back a fresh
   * object each render, so its identity is never stable. Sending that identity
   * up set state in the parent on every render and spun until React gave up
   * with "maximum update depth exceeded". The live builder lives in a ref now
   * and what goes up is a stable wrapper that reads it.
   */
  const buildRef = useRef(buildActions);
  buildRef.current = buildActions;
  const publishedBuild = useCallback((b: RoomBench) => buildRef.current(b), []);

  useEffect(() => {
    onActions({ fn: publishedBuild });
  }, [onActions, publishedBuild]);


  if (!benchC || !gameC || !registryC || !hesoyamC) {
    return <Empty title="Hesoyam is not deployed on this network." />;
  }

  return (
    <>
      <StatGrid>
        <Stat label="Benches" value={owned} note="one plant each" />
        <Stat label="Occupied" value={benches.filter((b) => b.growId > 0n).length} />
        <Stat label="Strains available" value={strains.filter((s) => s?.active).length} />
        <Stat label="Nutrient fee" value={`${hesoyam(feeOf(0))} HESOYAM`} note="per window" />
      </StatGrid>

      <ApprovalNotice allowance={allowance} game={gameC.address} hesoyamC={hesoyamC} />

      {owned === 0 ? (
        <BuyBench benchC={benchC} hesoyamC={hesoyamC} />
      ) : (
        <div className="bench-grid">
          {benches.map((b) => (
            <BenchCard
              key={b.id.toString()}
              bench={b}
              strains={strains}
              gameC={gameC}
              now={now}
              fees={{
                nutrient: feeOf(0),
                treatment: feeOf(1),
                utilityPerDay: feeOf(2),
                cure: feeOf(3),
              }}
              onState={onBenchState}
            />
          ))}
        </div>
      )}

      <CuringPanel gameC={gameC} />

      {owned > 0 ? <BuyBench benchC={benchC} hesoyamC={hesoyamC} compact /> : null}
    </>
  );
}

function ApprovalNotice({
  allowance,
  game,
  hesoyamC,
}: {
  allowance: ReturnType<typeof useAllowance>;
  game: `0x${string}`;
  hesoyamC: { address: `0x${string}`; abi: readonly unknown[] };
}) {
  const tx = useTx({ onDone: () => void allowance.refetch() });
  const NEEDED = 100_000n * 10n ** 18n;

  if (allowance.allowance >= NEEDED) return null;

  return (
    <Panel quiet>
      <Warning>
        The grow room needs permission to spend HESOYAM for seeds, nutrients and utilities.
        This approves a fixed amount rather than an unlimited one, so a bug in the game
        contract can never drain your wallet.
      </Warning>
      <div className="row-actions">
        <TxButton
          tx={tx}
          onClick={() =>
            void tx.run({
              address: hesoyamC.address,
              abi: hesoyamC.abi as never,
              functionName: "approve",
              args: [game, NEEDED],
            })
          }
        >
          Approve {hesoyam(NEEDED, 0)} HESOYAM
        </TxButton>
      </div>
      <TxStatus tx={tx} />
    </Panel>
  );
}

function BuyBench({
  benchC,
  hesoyamC,
  compact,
}: {
  benchC: { address: `0x${string}`; abi: readonly unknown[] };
  hesoyamC: { address: `0x${string}`; abi: readonly unknown[] };
  compact?: boolean;
}) {
  const tx = useTx();
  const approveTx = useTx();
  const allowance = useAllowance(hesoyamC as never, benchC.address);

  const { data: count } = useReadContract({
    address: benchC.address,
    abi: benchC.abi as never,
    functionName: "trancheCount",
  });

  const n = Number((count as bigint | undefined) ?? 0n);

  const { data: tranches } = useReadContracts({
    contracts: Array.from({ length: n }, (_, i) => ({
      address: benchC.address,
      abi: benchC.abi as never,
      functionName: "tranches" as const,
      args: [BigInt(i)],
    })),
    query: { enabled: n > 0 },
  });

  const rows = (tranches ?? [])
    .map((r, i) => {
      const t = r.result as readonly [bigint, number, number, number, boolean] | undefined;
      if (!t) return undefined;
      return { id: i, price: t[0], cap: t[1], sold: t[2], tier: t[3], open: t[4] };
    })
    .filter((t): t is NonNullable<typeof t> => Boolean(t) && t!.open && t!.sold < t!.cap);

  if (rows.length === 0) {
    return compact ? null : <Empty title="No benches are for sale right now." />;
  }

  return (
    <Panel
      title={compact ? "Buy another bench" : "Buy your first bench"}
      subtitle="The whole price is protocol revenue. Higher tiers score better on environment control."
    >
      <div className="tranche-grid">
        {rows.map((t) => {
          const enough = allowance.allowance >= t.price;
          return (
            <div key={t.id} className="tranche">
              <div className="tranche-top">
                <span className="tranche-tier">Tier {t.tier}</span>
                <Pill tone={t.tier === 2 ? "cash" : "plain"}>
                  {t.tier === 0 ? "0" : t.tier === 1 ? "15" : "30"} care points
                </Pill>
              </div>
              <p className="tranche-price mono">{hesoyam(t.price, 0)} HESOYAM</p>
              <p className="tranche-left mono">
                {t.cap - t.sold} of {t.cap} left
              </p>
              {enough ? (
                <TxButton
                  tx={tx}
                  onClick={() =>
                    void tx.run({
                      address: benchC.address,
                      abi: benchC.abi as never,
                      functionName: "buy",
                      args: [BigInt(t.id)],
                    })
                  }
                >
                  Buy
                </TxButton>
              ) : (
                <TxButton
                  tx={approveTx}
                  variant="ghost"
                  onClick={() =>
                    void approveTx
                      .run({
                        address: hesoyamC.address,
                        abi: hesoyamC.abi as never,
                        functionName: "approve",
                        args: [benchC.address, t.price],
                      })
                      .then(() => allowance.refetch())
                  }
                >
                  Approve
                </TxButton>
              )}
            </div>
          );
        })}
      </div>
      <TxStatus tx={tx} />
      <TxStatus tx={approveTx} />
    </Panel>
  );
}

type StrainRow =
  | ({ id: number } & {
      cycleSeconds: number;
      baseYield: number;
      geneticsBps: number;
      eventChance: number;
      geneQuality: number;
      seedPrice: bigint;
      active: boolean;
      name: string;
    })
  | undefined;

function BenchCard({
  bench,
  strains,
  gameC,
  now,
  fees,
  onState,
}: {
  bench: { id: bigint; tier: number; growId: bigint };
  strains: StrainRow[];
  gameC: { address: `0x${string}`; abi: readonly unknown[] };
  now: number;
  fees: { nutrient: bigint; treatment: bigint; utilityPerDay: bigint; cure: bigint };
  onState?: (b: RoomBench) => void;
}) {
  const empty = bench.growId === 0n;

  // An empty bench still exists in the room, it just has nothing growing on it.
  // Only ActiveGrow reported before, so a player who owned benches but had not
  // planted walked into a room with no benches in it.
  const report = onState;
  useEffect(() => {
    if (!report || !empty) return;
    report({
      id: bench.id,
      tier: bench.tier,
      growId: 0n,
      strainName: "empty",
      progress: 0,
      care: 0,
      ready: false,
      feedIndex: null,
      treatSlot: null,
    });
  }, [report, empty, bench.id, bench.tier]);

  return (
    <div className="bench-card">
      <div className="bench-card-head">
        <span className="bench-card-id mono">Bench {bench.id.toString()}</span>
        <Pill tone={bench.tier === 2 ? "cash" : "plain"}>Tier {bench.tier}</Pill>
      </div>
      {empty ? (
        <PlantForm bench={bench} strains={strains} gameC={gameC} fees={fees} />
      ) : (
        <ActiveGrow bench={bench} strains={strains} gameC={gameC} now={now} fees={fees} onState={onState} />
      )}
    </div>
  );
}

function PlantForm({
  bench,
  strains,
  gameC,
  fees,
}: {
  bench: { id: bigint; tier: number };
  strains: StrainRow[];
  gameC: { address: `0x${string}`; abi: readonly unknown[] };
  fees: { nutrient: bigint; treatment: bigint; utilityPerDay: bigint; cure: bigint };
}) {
  const available = strains.filter((s): s is NonNullable<StrainRow> => Boolean(s?.active));
  const [strainId, setStrainId] = useState<number | null>(null);
  const tx = useTx();

  const chosen = available.find((s) => s.id === strainId) ?? available[0];

  if (available.length === 0) return <Empty title="No strains are active." />;

  const projected = chosen
    ? yieldUnits(chosen.baseYield, chosen.geneticsBps, 100, 0n)
    : 0;
  const cost = chosen
    ? cycleCost({
        seedPrice: chosen.seedPrice,
        nutrientFee: fees.nutrient,
        treatmentFee: fees.treatment,
        utilityPerDay: fees.utilityPerDay,
        cureFee: fees.cure,
        cycleSeconds: chosen.cycleSeconds,
        feeds: 3,
        treatments: 0,
        curing: false,
      })
    : 0n;

  return (
    <div className="bench-card-body">
      <p className="bench-empty">This bench is free.</p>
      <Field label="Strain">
        <select
          className="input"
          value={chosen?.id ?? ""}
          onChange={(e) => setStrainId(Number(e.target.value))}
        >
          {available.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>

      {chosen ? (
        <>
          <Row label="Cycle" value={`${(chosen.cycleSeconds / 86400).toFixed(1)} days`} />
          <Row label="Seed" value={`${hesoyam(chosen.seedPrice)} HESOYAM`} />
          <Row label="Cost at full care" value={`${hesoyam(cost)} HESOYAM`} />
          <Row label="Yield at care 100" value={`${units(projected)} units`} tone="cash" />
          <Row
            label="Event risk"
            value={`${((chosen.eventChance / 256) * 100).toFixed(0)}% per slot`}
            tone={chosen.eventChance > 128 ? "amber" : undefined}
          />
        </>
      ) : null}

      <TxButton
        tx={tx}
        disabled={!chosen}
        onClick={() => {
          if (!chosen) return;
          const salt = randomSalt();
          saveSalt(`${gameC.address}:${bench.id}`, salt);
          void tx.run({
            address: gameC.address,
            abi: gameC.abi as never,
            functionName: "plant",
            args: [chosen.id, Number(bench.id), commitFor(salt)],
          });
        }}
      >
        Plant
      </TxButton>
      <p className="field-hint">
        Planting stores a secret in this browser. You need it to harvest, so do not clear
        site data before you finish the cycle.
      </p>
      <TxStatus tx={tx} />
    </div>
  );
}

function ActiveGrow({
  bench,
  strains,
  gameC,
  now,
  fees,
  onState,
}: {
  bench: { id: bigint; tier: number; growId: bigint };
  strains: StrainRow[];
  gameC: { address: `0x${string}`; abi: readonly unknown[] };
  now: number;
  fees: { nutrient: bigint; treatment: bigint; utilityPerDay: bigint; cure: bigint };
  onState?: (b: RoomBench) => void;
}) {
  const tx = useTx();
  const [cure, setCure] = useState(false);
  const abandonTx = useTx();

  const { data: grow } = useReadContract({
    address: gameC.address,
    abi: gameC.abi as never,
    functionName: "grows",
    args: [bench.growId],
  });

  // The seed is derived from a beacon round that may not be revealed yet, so it
  // is read from the contract rather than taken from the struct.
  const { data: seedData } = useReadContract({
    address: gameC.address,
    abi: gameC.abi as never,
    functionName: "seedFor",
    args: [bench.growId],
  });

  const g = grow as
    | readonly [`0x${string}`, number, number, bigint, `0x${string}`, bigint, number, number, boolean]
    | undefined;

  const strain = g ? strains.find((s) => s?.id === Number(g[1])) : undefined;

  /**
   * Everything derived from the grow, or null while it is still loading.
   *
   * This used to sit behind two early returns, which put the hooks below them on
   * a different path once the reads resolved and crashed the page with "rendered
   * more hooks than during the previous render". Hooks now run unconditionally
   * and the bail out happens after them.
   */
  const view = (() => {
    if (!g || !strain) return null;

    const plantedAt = Number(g[3]);
    const eventSeed =
      (seedData as `0x${string}` | undefined) ?? (("0x" + "0".repeat(64)) as `0x${string}`);
    const feedMask = Number(g[6]);
    const treatedMask = Number(g[7]);

    const strainCore: Strain = {
      cycleSeconds: strain.cycleSeconds,
      baseYield: strain.baseYield,
      geneticsBps: strain.geneticsBps,
      eventChance: strain.eventChance,
      geneQuality: strain.geneQuality,
      seedPrice: strain.seedPrice,
      active: strain.active,
    };

    const { care, damageBps } = careScore(
      { feedMask, treatedMask, benchTier: bench.tier },
      eventSeed,
      strain.eventChance
    );
    const actions = nextActions(
      { plantedAt, strainId: strain.id, benchTier: bench.tier, eventSeed, feedMask, treatedMask, active: true },
      strainCore,
      now
    );
    const openFeed = actions.find((a) => a.kind === "feed" && now >= a.opensAt);
    const openTreat = actions.find((a) => a.kind === "treat" && now >= a.opensAt);

    return {
      plantedAt,
      eventSeed,
      seedReady: eventSeed !== "0x" + "0".repeat(64),
      feedMask,
      treatedMask,
      care,
      damageBps,
      progress: growProgress(plantedAt, strain.cycleSeconds, now),
      ready: now >= maturesAt(plantedAt, strain.cycleSeconds),
      projectedUnits: yieldUnits(strain.baseYield, strain.geneticsBps, care, damageBps),
      qRange: qualityRange(care, strain.geneQuality, damageBps),
      fires: firedMask(eventSeed, strain.eventChance),
      actions,
      feedIndex: openFeed && openFeed.kind === "feed" ? openFeed.index : null,
      treatSlot: openTreat && openTreat.kind === "treat" ? openTreat.slot : null,
    };
  })();

  // Flattened out of `view` so the dependency array stays a fixed list of
  // primitives rather than an object that is new on every render.
  const report = onState;
  const rName = strain?.name;
  const rProgress = view?.progress;
  const rCare = view?.care;
  const rReady = view?.ready;
  const rFeed = view?.feedIndex ?? null;
  const rTreat = view?.treatSlot ?? null;
  useEffect(() => {
    if (!report || rName === undefined || rProgress === undefined) return;
    report({
      id: bench.id,
      tier: bench.tier,
      growId: bench.growId,
      strainName: rName,
      progress: rProgress,
      care: rCare as number,
      ready: rReady as boolean,
      feedIndex: rFeed,
      treatSlot: rTreat,
    });
  }, [report, bench.id, bench.tier, bench.growId, rName, rProgress, rCare, rReady, rFeed, rTreat]);

  if (!g) return <div className="bench-card-body">Reading.</div>;
  if (!strain || !view) return <div className="bench-card-body">Unknown strain.</div>;

  const {
    plantedAt,
    eventSeed,
    seedReady,
    feedMask,
    treatedMask,
    care,
    damageBps,
    progress,
    ready,
    projectedUnits,
    qRange,
    fires,
    actions,
  } = view;

  const salt = loadSalts()[`${gameC.address}:${bench.id}`];

  return (
    <div className="bench-card-body">
      <p className="bench-strain-name">{strain.name}</p>
      <Track value={progress} tone={ready ? "cash" : "amber"} />
      <div className="bench-legend mono">
        <span>{ready ? "ready" : `${Math.round(progress * 100)}% grown`}</span>
        <span>{ready ? "harvest now" : timeUntil(maturesAt(plantedAt, strain.cycleSeconds), now)}</span>
      </div>

      <Row label="Care score" value={`${care} / 100`} tone={care >= 80 ? "cash" : undefined} />
      <Row
        label="Damage"
        value={damageBps === 0n ? "none" : `${Number(damageBps) / 100}%`}
        tone={damageBps > 0n ? "amber" : undefined}
      />
      <Row label="Projected yield" value={`${units(projectedUnits)} units`} />
      <Row
        label="Projected quality"
        value={`${qRange.min} to ${qRange.max}, tier ${tierForQuality(qRange.min)}`}
      />

      <div className="window-row">
        {[0, 1, 2].map((i) => {
          const done = Boolean(feedMask & (1 << i));
          const w = feedWindow(plantedAt, strain.cycleSeconds, i);
          const open = now >= w.opensAt && now <= w.closesAt;
          const missed = !done && now > w.closesAt;
          return (
            <button
              key={`feed-${i}`}
              type="button"
              className={`window-chip${done ? " is-done" : open ? " is-open" : missed ? " is-missed" : ""}`}
              disabled={!open || done}
              title={
                done
                  ? "Fed"
                  : missed
                    ? `Missed, closed ${dateOf(w.closesAt)}`
                    : open
                      ? `Open until ${dateOf(w.closesAt)}`
                      : `Opens ${dateOf(w.opensAt)}`
              }
              onClick={() =>
                void tx.run({
                  address: gameC.address,
                  abi: gameC.abi as never,
                  functionName: "feed",
                  args: [bench.growId, i],
                })
              }
            >
              Feed {i + 1}
            </button>
          );
        })}
      </div>

      {fires > 0 ? (
        <div className="window-row">
          {[0, 1, 2].map((slot) => {
            if (!(fires & (1 << slot))) return null;
            const done = Boolean(treatedMask & (1 << slot));
            const w = eventWindow(plantedAt, strain.cycleSeconds, slot);
            const open = now >= w.opensAt && now <= w.closesAt;
            const missed = !done && now > w.closesAt;
            return (
              <button
                key={`treat-${slot}`}
                type="button"
                className={`window-chip${done ? " is-done" : open ? " is-open" : missed ? " is-missed" : ""}`}
                disabled={!open || done}
                title={done ? "Treated" : missed ? "Missed" : open ? "Treat now" : `Opens ${dateOf(w.opensAt)}`}
                onClick={() =>
                  void tx.run({
                    address: gameC.address,
                    abi: gameC.abi as never,
                    functionName: "treat",
                    args: [bench.growId, slot],
                  })
                }
              >
                Pest {slot + 1}
              </button>
            );
          })}
        </div>
      ) : null}

      {!seedReady ? (
        <Warning>
          This grow is waiting on its randomness round. The schedule and the harvest
          roll are fixed by a beacon value that had not been revealed when you planted,
          which is what stops anyone choosing their own outcome. It settles shortly.
        </Warning>
      ) : null}

      {ready ? (
        <div className="harvest-box">
          <label className="check">
            <input type="checkbox" checked={cure} onChange={(e) => setCure(e.target.checked)} />
            <span>
              Cure for 48 hours, up to 12 more quality, costs {hesoyam(fees.cure)} HESOYAM
            </span>
          </label>
          {salt ? (
            <TxButton
              tx={tx}
              onClick={() =>
                void tx.run({
                  address: gameC.address,
                  abi: gameC.abi as never,
                  functionName: "harvest",
                  args: [bench.growId, salt, cure],
                })
              }
            >
              Harvest
            </TxButton>
          ) : (
            <>
              <Warning>
                The secret for this grow is not in this browser, so it cannot be harvested
                here. Use the browser you planted from. If it is gone for good, abandoning
                frees the bench, at the cost of the whole crop.
              </Warning>
              <TxButton
                tx={abandonTx}
                variant="ghost"
                title="Frees the bench. The harvest is lost."
                onClick={() =>
                  void abandonTx.run({
                    address: gameC.address,
                    abi: gameC.abi as never,
                    functionName: "abandon",
                    args: [bench.growId],
                  })
                }
              >
                Abandon and free the bench
              </TxButton>
              <TxStatus tx={abandonTx} />
            </>
          )}
        </div>
      ) : (
        <p className="next-action mono">
          Next: {describe(actions[0], now)}
        </p>
      )}

      <TxStatus tx={tx} />
    </div>
  );
}

function describe(action: ReturnType<typeof nextActions>[number] | undefined, now: number): string {
  if (!action) return "nothing to do";
  if (action.kind === "harvest") return `harvest in ${timeUntil(action.at, now)}`;
  if (action.kind === "feed") {
    return now >= action.opensAt
      ? `feed window ${action.index + 1} is open`
      : `feed window ${action.index + 1} in ${timeUntil(action.opensAt, now)}`;
  }
  return now >= action.opensAt
    ? `pest ${action.slot + 1} needs treating`
    : `pest ${action.slot + 1} in ${timeUntil(action.opensAt, now)}`;
}

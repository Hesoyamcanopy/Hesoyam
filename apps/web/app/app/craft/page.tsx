"use client";

import { useEffect, useState } from "react";
import { useBlockNumber, useReadContract, useReadContracts } from "wagmi";
import { TIER_NAMES, flowerId, type QualityTier } from "@hesoyam/sdk";
import { useAddresses, contractFor } from "../../../lib/contracts";
import { RequireWallet, useViewer } from "../../../components/connect";
import { Panel, StatGrid, Stat, Empty, Pill, Row, Warning } from "../../../components/ui";
import { useTx, TxStatus, TxButton, useAllowance } from "../../../components/tx";
import { hesoyam, units } from "../../../lib/format";

const RARITY = ["Common", "Uncommon", "Rare", "Mythic"];
const MAX_SCANNED = 40;

export default function Craft() {
  return (
    <div className="page">
      <header className="page-head">
        <h1>Crafting</h1>
        <p>
          Burn Flower to make a Strain Card. Cards raise your share of the staker rail, so
          this is the only bridge between growing and holding. It is also the only thing
          that takes Flower out of circulation.
        </p>
      </header>
      <RequireWallet>
        <CraftBody />
      </RequireWallet>
    </div>
  );
}

function CraftBody() {
  const { address } = useViewer();
  const { addresses } = useAddresses();
  const crafterC = contractFor(addresses, "CardCrafter");
  const flowerC = contractFor(addresses, "Flower");
  const hesoyamC = contractFor(addresses, "HesoyamToken");
  const registryC = contractFor(addresses, "StrainRegistry");

  const [strain, setStrain] = useState("1");
  const [tier, setTier] = useState<QualityTier>(0);

  const request = useTx();
  const approveFlower = useTx();
  const allowance = useAllowance(hesoyamC as never, crafterC?.address);
  const approveFee = useTx({ onDone: () => void allowance.refetch() });

  const { data: cfg } = useReadContracts({
    contracts: [
      { ...crafterC!, functionName: "flowerPerCraft" as const },
      { ...crafterC!, functionName: "craftFee" as const },
      { ...crafterC!, functionName: "totalCrafted" as const },
      { ...crafterC!, functionName: "totalFlowerBurned" as const },
      { ...crafterC!, functionName: "nextRequestId" as const },
      { ...registryC!, functionName: "count" as const },
    ],
    query: { enabled: Boolean(crafterC && registryC) },
  });
  const c = (i: number) => cfg?.[i]?.result as bigint | undefined;

  const perCraft = c(0) ?? 0n;
  const fee = c(1) ?? 0n;

  const strainId = Math.max(1, Number(strain) || 1);
  const tokenId = flowerId(strainId, tier);

  const { data: held } = useReadContract({
    address: flowerC?.address,
    abi: flowerC?.abi as never,
    functionName: "balanceOf",
    args: address ? [address, tokenId] : undefined,
    query: { enabled: Boolean(flowerC && address) },
  });
  const flowerHeld = (held as bigint | undefined) ?? 0n;

  const { data: approved } = useReadContract({
    address: flowerC?.address,
    abi: flowerC?.abi as never,
    functionName: "isApprovedForAll",
    args: address && crafterC ? [address, crafterC.address] : undefined,
    query: { enabled: Boolean(flowerC && address && crafterC) },
  });

  const { data: odds } = useReadContract({
    address: crafterC?.address,
    abi: crafterC?.abi as never,
    functionName: "oddsFor",
    args: [tier],
    query: { enabled: Boolean(crafterC) },
  });
  const o = odds as readonly [number, number, number, number] | undefined;

  if (!crafterC || !flowerC || !hesoyamC) {
    return <Empty title="Hesoyam is not deployed on this network." />;
  }

  const enoughFlower = flowerHeld >= perCraft;
  const enoughAllowance = allowance.isEnough(fee);

  return (
    <>
      <StatGrid>
        <Stat label="Cards crafted" value={units(c(2))} note="all time" />
        <Stat label="Flower burned" value={units(c(3))} tone="cash" note="gone from supply" />
        <Stat label="Cost per craft" value={units(perCraft)} note="units of Flower" />
        <Stat label="Craft fee" value={`${hesoyam(fee)}`} tone="gold" note="HESOYAM, to the router" />
      </StatGrid>

      <div className="two-col">
        <Panel title="Craft a card" subtitle="Higher quality Flower gives better odds. The roll is settled two blocks later.">
          <div className="field">
            <span className="field-label">Strain</span>
            <input
              className="input"
              value={strain}
              inputMode="numeric"
              aria-label="Strain id"
              onChange={(e) => setStrain(e.target.value)}
            />
          </div>

          <div className="tier-picker" style={{ marginTop: 16 }}>
            {[0, 1, 2].map((t) => (
              <button
                key={t}
                type="button"
                className={`tier-option${tier === t ? " is-active" : ""}`}
                onClick={() => setTier(t as QualityTier)}
              >
                <span className="tier-option-name">{TIER_NAMES[t as QualityTier]}</span>
                <span className="tier-option-lock">tier {t}</span>
              </button>
            ))}
          </div>

          <Row label="You hold" value={`${units(flowerHeld)} units`} tone={enoughFlower ? "cash" : undefined} />
          <Row label="This burns" value={`${units(perCraft)} units`} />

          {o ? (
            <div className="odds-row">
              {RARITY.map((r, i) => (
                <div className="odds-cell" key={r}>
                  <span className="odds-k">{r}</span>
                  <span className={`odds-v${i === 3 ? " tone-gold" : ""}`}>{(o[i] / 100).toFixed(1)}%</span>
                </div>
              ))}
            </div>
          ) : null}

          {!enoughFlower ? (
            <Warning>
              You need {units(perCraft)} units of {TIER_NAMES[tier]} Flower from strain {strainId}.
              Harvest it, or buy it on the market.
            </Warning>
          ) : null}

          <div className="row-actions">
            {!approved ? (
              <TxButton
                tx={approveFlower}
                onClick={() =>
                  void approveFlower.run({
                    ...flowerC,
                    abi: flowerC.abi as never,
                    functionName: "setApprovalForAll",
                    args: [crafterC.address, true],
                  })
                }
              >
                Allow the crafter to burn Flower
              </TxButton>
            ) : !enoughAllowance ? (
              <TxButton
                tx={approveFee}
                onClick={() =>
                  void approveFee.run({
                    ...hesoyamC,
                    abi: hesoyamC.abi as never,
                    functionName: "approve",
                    args: [crafterC.address, fee],
                  })
                }
              >
                Approve {hesoyam(fee)} fee
              </TxButton>
            ) : (
              <TxButton
                tx={request}
                disabled={!enoughFlower}
                onClick={() =>
                  void request.run({
                    ...crafterC,
                    abi: crafterC.abi as never,
                    functionName: "requestCraft",
                    args: [strainId, tier],
                  })
                }
              >
                Burn and roll
              </TxButton>
            )}
          </div>
          <TxStatus tx={approveFlower} />
          <TxStatus tx={approveFee} />
          <TxStatus tx={request} />

          <p className="panel-note">
            The Flower and the fee are taken when you request. The rarity is settled from a
            block that has not been mined yet, so nobody can see the result before
            committing to it.
          </p>
        </Panel>

        <PendingCrafts crafterC={crafterC} nextId={c(4)} />
      </div>
    </>
  );
}

/**
 * Requests waiting on their reveal block.
 *
 * Nothing pays anyone to finalise, so an unfinalised request is money already
 * spent. Surfacing them prominently is the cheapest fix for that until a keeper
 * exists.
 */
function PendingCrafts({
  crafterC,
  nextId,
}: {
  crafterC: { address: `0x${string}`; abi: readonly unknown[] };
  nextId: bigint | undefined;
}) {
  const { address } = useViewer();
  const { data: block } = useBlockNumber({ watch: true });

  const total = Number(nextId ?? 1n) - 1;
  const scanned = Math.min(total, MAX_SCANNED);
  const first = Math.max(1, total - scanned + 1);

  const { data } = useReadContracts({
    contracts: Array.from({ length: scanned }, (_, i) => ({
      address: crafterC.address,
      abi: crafterC.abi as never,
      functionName: "requests" as const,
      args: [BigInt(first + i)],
    })),
    query: { enabled: scanned > 0 },
  });

  const mine = (data ?? [])
    .map((r, i) => {
      const q = r.result as readonly [`0x${string}`, number, number, bigint, boolean] | undefined;
      if (!q) return undefined;
      if (q[0].toLowerCase() !== address?.toLowerCase()) return undefined;
      if (q[4]) return undefined;
      return { id: BigInt(first + i), strainId: Number(q[1]), tier: Number(q[2]), revealBlock: q[3] };
    })
    .filter((v): v is NonNullable<typeof v> => Boolean(v));

  return (
    <Panel title="Waiting to settle" subtitle="Two blocks after the request, the roll can be read.">
      {mine.length === 0 ? (
        <Empty title="Nothing waiting." />
      ) : (
        <div className="curing-list">
          {mine.map((r) => (
            <CraftRow key={r.id.toString()} req={r} crafterC={crafterC} head={block} />
          ))}
        </div>
      )}
    </Panel>
  );
}

function CraftRow({
  req,
  crafterC,
  head,
}: {
  req: { id: bigint; strainId: number; tier: number; revealBlock: bigint };
  crafterC: { address: `0x${string}`; abi: readonly unknown[] };
  head: bigint | undefined;
}) {
  const tx = useTx();
  const ready = head !== undefined && head > req.revealBlock;
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 4000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="curing-row">
      <div className="curing-main">
        <span className="mono">Request {req.id.toString()}</span>
        <span className="mono">
          Strain {req.strainId}, {TIER_NAMES[req.tier as QualityTier]}
        </span>
        <Pill tone={ready ? "cash" : "amber"}>
          {ready ? "ready" : `block ${req.revealBlock.toString()}`}
        </Pill>
      </div>
      <TxButton
        tx={tx}
        disabled={!ready}
        onClick={() =>
          void tx.run({
            ...crafterC,
            abi: crafterC.abi as never,
            functionName: "finalizeCraft",
            args: [req.id],
          })
        }
      >
        Settle the roll
      </TxButton>
      <TxStatus tx={tx} />
    </div>
  );
}

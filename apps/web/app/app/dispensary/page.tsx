"use client";

import { useEffect, useMemo, useState } from "react";
import { useReadContract, useReadContracts } from "wagmi";
import { TIER_NAMES, flowerId, type QualityTier } from "@hesoyam/sdk";
import { dispensaryPrice } from "@hesoyam/game-core";
import { useAddresses, contractFor } from "../../../lib/contracts";
import { RequireWallet, useViewer } from "../../../components/connect";
import { Panel, StatGrid, Stat, Empty, Row, Track, Pill, Field, Warning } from "../../../components/ui";
import { useTx, TxStatus, TxButton } from "../../../components/tx";
import { money, units, duration } from "../../../lib/format";

export default function DispensaryPage() {
  return (
    <div className="page">
      <header className="page-head">
        <h1>Dispensary</h1>
        <p>
          The buyer of last resort, funded only by revenue that arrived. The bid opens
          above market and falls until the budget is gone.
        </p>
      </header>
      <RequireWallet>
        <DispensaryBody />
      </RequireWallet>
    </div>
  );
}

function DispensaryBody() {
  const { address } = useViewer();
  const { addresses } = useAddresses();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const dispC = contractFor(addresses, "Dispensary");
  const flowerC = contractFor(addresses, "Flower");
  const registryC = contractFor(addresses, "StrainRegistry");

  const { data } = useReadContracts({
    contracts: [
      { ...dispC!, functionName: "epochBudget" as const },
      { ...dispC!, functionName: "epochSpent" as const },
      { ...dispC!, functionName: "epochStart" as const },
      { ...dispC!, functionName: "auctionDuration" as const },
      { ...dispC!, functionName: "totalFunded" as const },
      { ...dispC!, functionName: "totalSpent" as const },
      { ...dispC!, functionName: "totalUnitsBought" as const },
      { ...dispC!, functionName: "referencePrice" as const, args: [0] },
      { ...dispC!, functionName: "referencePrice" as const, args: [1] },
      { ...dispC!, functionName: "referencePrice" as const, args: [2] },
    ],
    query: { enabled: Boolean(dispC) },
  });

  const v = (i: number) => (data?.[i]?.result as bigint | undefined) ?? 0n;

  const budget = v(0);
  const spent = v(1);
  const remaining = budget > spent ? budget - spent : 0n;
  const epochStart = Number(v(2));
  const auctionDuration = Number(v(3));
  const references = [v(7), v(8), v(9)];

  const { data: strainCount } = useReadContract({
    ...registryC!,
    functionName: "count",
    query: { enabled: Boolean(registryC) },
  });
  const nStrains = Number((strainCount as bigint | undefined) ?? 0n);

  const ids = useMemo(() => {
    const out: { id: bigint; strainId: number; tier: QualityTier }[] = [];
    for (let s = 0; s < nStrains; s++) {
      for (let t = 0; t < 3; t++) {
        out.push({ id: flowerId(s, t as QualityTier), strainId: s, tier: t as QualityTier });
      }
    }
    return out;
  }, [nStrains]);

  const { data: balances } = useReadContract({
    ...flowerC!,
    functionName: "balanceOfBatch",
    args: address ? [ids.map(() => address), ids.map((i) => i.id)] : undefined,
    query: { enabled: Boolean(flowerC && address && ids.length > 0) },
  });

  const holdings = ((balances as bigint[] | undefined) ?? [])
    .map((bal, i) => ({ ...ids[i], amount: bal }))
    .filter((h) => h.amount > 0n);

  if (!dispC || !flowerC) return <Empty title="Hesoyam is not deployed on this network." />;

  const elapsed = Math.max(0, now - epochStart);
  const progress = auctionDuration > 0 ? Math.min(1, elapsed / auctionDuration) : 1;

  return (
    <>
      <StatGrid>
        <Stat label="Budget left" value={money(remaining)} tone="cash" note="this epoch" />
        <Stat label="Spent" value={money(spent)} note="of the current budget" />
        <Stat label="Bought all time" value={units(v(6))} note="units burned" />
        <Stat
          label="Auction"
          value={progress >= 1 ? "at floor" : duration(auctionDuration - elapsed)}
          note={progress >= 1 ? "60 percent of reference" : "until the floor"}
        />
      </StatGrid>

      <Panel title="The falling bid" subtitle="Opens at 115 percent of reference, decays to 60 percent across the epoch.">
        <Track value={1 - progress} tone={progress > 0.75 ? "amber" : "cash"} />
        <div className="bench-legend mono">
          <span>115%</span>
          <span>60%</span>
        </div>
        <div className="tier-prices">
          {[0, 1, 2].map((t) => {
            const price = dispensaryPrice(references[t], epochStart, now, auctionDuration);
            return (
              <div key={t} className="tier-price">
                <Pill tone={t === 2 ? "cash" : "plain"}>{TIER_NAMES[t as QualityTier]}</Pill>
                <span className="mono tier-price-v">
                  {references[t] === 0n ? "no bid" : money(price)}
                </span>
                <span className="tier-price-n">
                  {references[t] === 0n ? "no reference set" : `reference ${money(references[t])}`}
                </span>
              </div>
            );
          })}
        </div>
        {remaining === 0n ? (
          <Warning>
            The budget is spent for this epoch. That is the mechanism working, not a
            failure. Sell on the market, or wait for the next sweep.
          </Warning>
        ) : null}
      </Panel>

      <SellToDispensary
        holdings={holdings}
        dispC={dispC}
        flowerC={flowerC}
        references={references}
        epochStart={epochStart}
        auctionDuration={auctionDuration}
        remaining={remaining}
        now={now}
      />

      <Panel title="Lifetime" quiet>
        <Row label="Funded from revenue" value={money(v(4))} />
        <Row label="Paid to growers" value={money(v(5))} tone="amber" />
        <p className="panel-note">
          The Dispensary can never spend more than it was funded. That is checked on chain
          rather than promised here.
        </p>
      </Panel>
    </>
  );
}

function SellToDispensary({
  holdings,
  dispC,
  flowerC,
  references,
  epochStart,
  auctionDuration,
  remaining,
  now,
}: {
  holdings: { id: bigint; strainId: number; tier: QualityTier; amount: bigint }[];
  dispC: { address: `0x${string}`; abi: readonly unknown[] };
  flowerC: { address: `0x${string}`; abi: readonly unknown[] };
  references: bigint[];
  epochStart: number;
  auctionDuration: number;
  remaining: bigint;
  now: number;
}) {
  const { address } = useViewer();
  const [selected, setSelected] = useState(0);
  const [qty, setQty] = useState("");
  const tx = useTx();
  const approveTx = useTx();

  const { data: approved, refetch } = useReadContract({
    address: flowerC.address,
    abi: flowerC.abi as never,
    functionName: "isApprovedForAll",
    args: address ? [address, dispC.address] : undefined,
    query: { enabled: Boolean(address) },
  });

  if (holdings.length === 0) {
    return (
      <Panel title="Sell to the Dispensary" quiet>
        <Empty title="You have no Flower.">Harvest something first.</Empty>
      </Panel>
    );
  }

  const holding = holdings[Math.min(selected, holdings.length - 1)];
  const price = dispensaryPrice(references[holding.tier], epochStart, now, auctionDuration);
  const amount = qty ? BigInt(qty) : 0n;
  const proceeds = price * amount;
  const affordable = price > 0n ? remaining / price : 0n;
  const tooMuch = proceeds > remaining;

  return (
    <Panel title="Sell to the Dispensary" subtitle="Units are burned. This is a real sink, not a warehouse.">
      <div className="sell-grid">
        <Field label="Holding">
          <select className="input" value={selected} onChange={(e) => setSelected(Number(e.target.value))}>
            {holdings.map((h, i) => (
              <option key={h.id.toString()} value={i}>
                Strain {h.strainId}, {TIER_NAMES[h.tier]}, {h.amount.toString()} units
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Units"
          hint={
            price === 0n
              ? "No bid on this tier right now."
              : `The budget can absorb ${affordable.toString()} at the current bid`
          }
        >
          <input
            className="input"
            inputMode="numeric"
            value={qty}
            onChange={(e) => setQty(e.target.value.replace(/[^0-9]/g, ""))}
            placeholder="0"
          />
        </Field>
        <Field label="You receive" hint="settled immediately">
          <div className="input input-readonly mono">{money(proceeds)}</div>
        </Field>
      </div>

      {tooMuch ? <Warning>That is more than the remaining budget can absorb.</Warning> : null}

      <div className="row-actions">
        {approved ? (
          <TxButton
            tx={tx}
            disabled={amount === 0n || amount > holding.amount || price === 0n || tooMuch}
            onClick={() =>
              void tx.run({
                address: dispC.address,
                abi: dispC.abi as never,
                functionName: "sell",
                args: [holding.strainId, holding.tier, amount],
              })
            }
          >
            Sell {amount > 0n ? amount.toString() : ""} units
          </TxButton>
        ) : (
          <TxButton
            tx={approveTx}
            onClick={() =>
              void approveTx
                .run({
                  address: flowerC.address,
                  abi: flowerC.abi as never,
                  functionName: "setApprovalForAll",
                  args: [dispC.address, true],
                })
                .then(() => refetch())
            }
          >
            Allow the Dispensary to burn on your behalf
          </TxButton>
        )}
      </div>
      <TxStatus tx={tx} />
      <TxStatus tx={approveTx} />
    </Panel>
  );
}

"use client";

import { useMemo, useState } from "react";
import { useReadContract, useReadContracts } from "wagmi";
import { parseUnits } from "viem";
import { TIER_NAMES, flowerId, decodeFlowerId, type QualityTier } from "@hesoyam/sdk";
import { useAddresses, contractFor } from "../../../lib/contracts";
import { RequireWallet, useViewer } from "../../../components/connect";
import { Panel, StatGrid, Stat, Empty, Pill, Field } from "../../../components/ui";
import { useTx, TxStatus, TxButton, useAllowance } from "../../../components/tx";
import { hesoyam, units, shortAddress } from "../../../lib/format";

const MAX_LISTINGS_SCANNED = 200;

export default function MarketPage() {
  return (
    <div className="page">
      <header className="page-head">
        <h1>Market</h1>
        <p>
          Player to player. The protocol takes 4 percent of every fill and routes it
          straight to revenue.
        </p>
      </header>
      <RequireWallet>
        <MarketBody />
      </RequireWallet>
    </div>
  );
}

function MarketBody() {
  const { address } = useViewer();
  const { addresses } = useAddresses();

  const marketC = contractFor(addresses, "Marketplace");
  const flowerC = contractFor(addresses, "Flower");
  const hesoyamC = contractFor(addresses, "HesoyamToken");
  const registryC = contractFor(addresses, "StrainRegistry");

  const { data: nextId } = useReadContract({
    ...marketC!,
    functionName: "nextListingId",
    query: { enabled: Boolean(marketC) },
  });

  const total = Number((nextId as bigint | undefined) ?? 1n) - 1;
  const scanned = Math.min(total, MAX_LISTINGS_SCANNED);
  const firstId = Math.max(1, total - scanned + 1);

  const { data: listingData } = useReadContracts({
    contracts: Array.from({ length: scanned }, (_, i) => ({
      ...marketC!,
      functionName: "listings" as const,
      args: [BigInt(firstId + i)],
    })),
    query: { enabled: Boolean(marketC) && scanned > 0 },
  });

  const listings = (listingData ?? [])
    .map((r, i) => {
      const l = r.result as readonly [`0x${string}`, bigint, bigint, bigint, boolean] | undefined;
      if (!l || !l[4]) return undefined;
      return { id: BigInt(firstId + i), seller: l[0], tokenId: l[1], amount: l[2], price: l[3] };
    })
    .filter((l): l is NonNullable<typeof l> => Boolean(l))
    .reverse();

  const { data: strainCount } = useReadContract({
    ...registryC!,
    functionName: "count",
    query: { enabled: Boolean(registryC) },
  });
  const nStrains = Number((strainCount as bigint | undefined) ?? 0n);

  const myIds = useMemo(() => {
    const out: bigint[] = [];
    for (let s = 0; s < nStrains; s++) {
      for (let t = 0 as QualityTier; t < 3; t++) out.push(flowerId(s, t as QualityTier));
    }
    return out;
  }, [nStrains]);

  const { data: balances } = useReadContract({
    ...flowerC!,
    functionName: "balanceOfBatch",
    args: address ? [myIds.map(() => address), myIds] : undefined,
    query: { enabled: Boolean(flowerC && address && myIds.length > 0) },
  });

  const holdings = ((balances as bigint[] | undefined) ?? [])
    .map((bal, i) => ({ tokenId: myIds[i], amount: bal }))
    .filter((h) => h.amount > 0n);

  if (!marketC || !flowerC || !hesoyamC) return <Empty title="Hesoyam is not deployed on this network." />;

  const volume = listings.reduce((acc, l) => acc + l.amount * l.price, 0n);

  return (
    <>
      <StatGrid>
        <Stat label="Open listings" value={listings.length} />
        <Stat label="Shelf value" value={`${hesoyam(volume, 0)} HESOYAM`} note="at asking prices" />
        <Stat label="Your inventory" value={holdings.reduce((a, h) => a + Number(h.amount), 0)} note="units of Flower" />
        <Stat label="Take" value="4.0%" note="to revenue on every fill" />
      </StatGrid>

      <SellPanel holdings={holdings} marketC={marketC} flowerC={flowerC} />

      <Panel title="On the shelf" subtitle="Newest first.">
        {listings.length === 0 ? (
          <Empty title="Nothing is listed right now.">
            Harvest something and be the first seller.
          </Empty>
        ) : (
          <div className="listing-table">
            <div className="listing-head mono">
              <span>Strain</span>
              <span>Tier</span>
              <span>Units</span>
              <span>Price</span>
              <span>Seller</span>
              <span />
            </div>
            {listings.map((l) => (
              <ListingRow key={l.id.toString()} listing={l} marketC={marketC} hesoyamC={hesoyamC} mine={l.seller.toLowerCase() === address?.toLowerCase()} />
            ))}
          </div>
        )}
      </Panel>
    </>
  );
}

function ListingRow({
  listing,
  marketC,
  hesoyamC,
  mine,
}: {
  listing: { id: bigint; seller: `0x${string}`; tokenId: bigint; amount: bigint; price: bigint };
  marketC: { address: `0x${string}`; abi: readonly unknown[] };
  hesoyamC: { address: `0x${string}`; abi: readonly unknown[] };
  mine: boolean;
}) {
  const [qty, setQty] = useState("");
  const tx = useTx();
  const approveTx = useTx();
  const allowance = useAllowance(hesoyamC as never, marketC.address);
  const { strainId, tier } = decodeFlowerId(listing.tokenId);

  const amount = qty ? BigInt(qty) : 0n;
  const cost = amount * listing.price;
  const enough = allowance.allowance >= cost && cost > 0n;

  return (
    <div className="listing-row">
      <span>Strain {strainId}</span>
      <span>
        <Pill tone={tier === 2 ? "cash" : "plain"}>{TIER_NAMES[tier]}</Pill>
      </span>
      <span className="mono">{units(listing.amount)}</span>
      <span className="mono">{hesoyam(listing.price)} HESOYAM</span>
      <span className="mono">{mine ? "you" : shortAddress(listing.seller)}</span>
      <span className="listing-actions">
        {mine ? (
          <TxButton
            tx={tx}
            variant="ghost"
            onClick={() =>
              void tx.run({
                address: marketC.address,
                abi: marketC.abi as never,
                functionName: "cancel",
                args: [listing.id],
              })
            }
          >
            Cancel
          </TxButton>
        ) : (
          <>
            <input
              className="input input-inline"
              inputMode="numeric"
              placeholder="qty"
              value={qty}
              onChange={(e) => setQty(e.target.value.replace(/[^0-9]/g, ""))}
            />
            {enough ? (
              <TxButton
                tx={tx}
                disabled={amount === 0n || amount > listing.amount}
                title={cost > 0n ? `${hesoyam(cost)} HESOYAM` : undefined}
                onClick={() =>
                  void tx.run({
                    address: marketC.address,
                    abi: marketC.abi as never,
                    functionName: "buy",
                    args: [listing.id, amount],
                  })
                }
              >
                Buy
              </TxButton>
            ) : (
              <TxButton
                tx={approveTx}
                variant="ghost"
                disabled={cost === 0n}
                onClick={() =>
                  void approveTx
                    .run({
                      address: hesoyamC.address,
                      abi: hesoyamC.abi as never,
                      functionName: "approve",
                      args: [marketC.address, cost],
                    })
                    .then(() => allowance.refetch())
                }
              >
                Approve
              </TxButton>
            )}
          </>
        )}
      </span>
      <TxStatus tx={tx} />
      <TxStatus tx={approveTx} />
    </div>
  );
}

function SellPanel({
  holdings,
  marketC,
  flowerC,
}: {
  holdings: { tokenId: bigint; amount: bigint }[];
  marketC: { address: `0x${string}`; abi: readonly unknown[] };
  flowerC: { address: `0x${string}`; abi: readonly unknown[] };
}) {
  const { address } = useViewer();
  const [selected, setSelected] = useState(0);
  const [qty, setQty] = useState("");
  const [price, setPrice] = useState("");
  const tx = useTx();
  const approveTx = useTx();

  const { data: approved, refetch } = useReadContract({
    address: flowerC.address,
    abi: flowerC.abi as never,
    functionName: "isApprovedForAll",
    args: address ? [address, marketC.address] : undefined,
    query: { enabled: Boolean(address) },
  });

  if (holdings.length === 0) {
    return (
      <Panel title="Sell" quiet>
        <Empty title="You have no Flower to sell.">Grow something first.</Empty>
      </Panel>
    );
  }

  const holding = holdings[Math.min(selected, holdings.length - 1)];
  const { strainId, tier } = decodeFlowerId(holding.tokenId);
  const amount = qty ? BigInt(qty) : 0n;
  const priceWei = price ? parseUnits(price, 18) : 0n;
  const valid = amount > 0n && amount <= holding.amount && priceWei > 0n;

  return (
    <Panel title="Sell" subtitle="You set the price. Buyers come to you.">
      <div className="sell-grid">
        <Field label="Holding">
          <select className="input" value={selected} onChange={(e) => setSelected(Number(e.target.value))}>
            {holdings.map((h, i) => {
              const d = decodeFlowerId(h.tokenId);
              return (
                <option key={h.tokenId.toString()} value={i}>
                  Strain {d.strainId}, {TIER_NAMES[d.tier]}, {h.amount.toString()} units
                </option>
              );
            })}
          </select>
        </Field>
        <Field label="Units" hint={`You hold ${holding.amount.toString()}`}>
          <input
            className="input"
            inputMode="numeric"
            value={qty}
            onChange={(e) => setQty(e.target.value.replace(/[^0-9]/g, ""))}
            placeholder="0"
          />
        </Field>
        <Field label="Price per unit" hint={amount > 0n && priceWei > 0n ? `Gross ${hesoyam(amount * priceWei)} HESOYAM, you keep ${hesoyam((amount * priceWei * 96n) / 100n)}` : "in HESOYAM"}>
          <input
            className="input"
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="0.0"
          />
        </Field>
      </div>

      <p className="panel-note">
        Strain {strainId}, {TIER_NAMES[tier]} tier. Premium tiers craft better cards, which
        is why buyers pay more for them.
      </p>

      <div className="row-actions">
        {approved ? (
          <TxButton
            tx={tx}
            disabled={!valid}
            onClick={() =>
              void tx.run({
                address: marketC.address,
                abi: marketC.abi as never,
                functionName: "list",
                args: [holding.tokenId, amount, priceWei],
              })
            }
          >
            List for sale
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
                  args: [marketC.address, true],
                })
                .then(() => refetch())
            }
          >
            Allow the market to hold your Flower
          </TxButton>
        )}
      </div>
      <TxStatus tx={tx} />
      <TxStatus tx={approveTx} />
    </Panel>
  );
}

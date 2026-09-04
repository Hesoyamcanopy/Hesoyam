"use client";

import { useState } from "react";
import { useReadContract, useReadContracts } from "wagmi";
import { useAddresses, contractFor } from "../../../lib/contracts";
import { RequireWallet, useViewer } from "../../../components/connect";
import { Panel, StatGrid, Stat, Empty, Pill, Row, Warning } from "../../../components/ui";
import { useTx, TxStatus, TxButton, useAllowance } from "../../../components/tx";
import { hesoyam } from "../../../lib/format";

const DISTRICTS = ["Dust", "Bayside", "Downtown", "Ridge", "Docks", "Badlands", "County", "The Strip"];
const TIERS = ["Lot", "Fenced", "Greenhouse", "Lit"];

/**
 * The art arrives as a base64 data URI holding base64 JSON. Unwrap the outer
 * layer and hand back the inner image URI unchanged.
 *
 * The returned value is only ever used as the `src` of an `img`. It is never
 * injected into the document. An SVG referenced by `img` cannot run script,
 * cannot load anything external, and cannot reach the page around it, whereas
 * the same bytes passed to dangerouslySetInnerHTML execute `script`, `onload`
 * and `foreignObject` on our own origin. That mattered here more than usual,
 * because this origin holds every grow's commit reveal salt in localStorage, so
 * a hostile tokenURI would have been four lines away from making every harvest
 * on this wallet unclaimable.
 */
function imageFromTokenURI(uri: string | undefined): string | undefined {
  if (!uri || !uri.startsWith("data:application/json;base64,")) return undefined;
  try {
    const json = JSON.parse(atob(uri.slice("data:application/json;base64,".length)));
    const image: unknown = json.image;
    if (typeof image !== "string") return undefined;
    if (!image.startsWith("data:image/svg+xml;base64,")) return undefined;
    return image;
  } catch {
    // A malformed URI is a contract bug, not a reason to blank the page.
    return undefined;
  }
}

export default function Plots() {
  return (
    <div className="page">
      <header className="page-head">
        <h1>Plots</h1>
        <p>
          Ground you can own. A bench sited on your plot pays you rent, and a plot nobody
          wants to grow on earns nothing. The art is generated on chain.
        </p>
      </header>
      <RequireWallet>
        <PlotsBody />
      </RequireWallet>
    </div>
  );
}

function PlotsBody() {
  const { address } = useViewer();
  const { addresses } = useAddresses();
  const plotC = contractFor(addresses, "Plot");
  const hesoyamC = contractFor(addresses, "HesoyamToken");
  const benchC = contractFor(addresses, "GrowBench");
  const claim = useTx();

  const { data: head } = useReadContracts({
    contracts: [
      { ...plotC!, functionName: "totalSupply" as const },
      { ...plotC!, functionName: "minted" as const },
      { ...plotC!, functionName: "rentOwed" as const, args: [address ?? "0x0000000000000000000000000000000000000000"] },
      { ...plotC!, functionName: "totalRentPaid" as const },
      { ...plotC!, functionName: "totalToProtocol" as const },
    ],
    query: { enabled: Boolean(plotC) },
  });

  const h = (i: number) => head?.[i]?.result as bigint | undefined;
  const supply = Number(h(0) ?? 0n);
  const owed = h(2) ?? 0n;

  const { data: ids } = useReadContracts({
    contracts: Array.from({ length: Math.min(supply, 48) }, (_, i) => ({
      ...plotC!,
      functionName: "tokenByIndex" as const,
      args: [BigInt(i)],
    })),
    query: { enabled: Boolean(plotC) && supply > 0 },
  });

  const plotIds = (ids ?? [])
    .map((r) => r.result as bigint | undefined)
    .filter((v): v is bigint => v !== undefined);

  // Which benches this wallet actually owns. Siting quotes a real bench id
  // rather than reusing the plot id, which was a bug: it charged rent against a
  // bench the player may not own and could lock a stranger's bench out.
  const { data: benchCount } = useReadContract({
    address: benchC?.address,
    abi: benchC?.abi as never,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(benchC && address) },
  });
  const owned = Number((benchCount as bigint | undefined) ?? 0n);
  const { data: benchIdData } = useReadContracts({
    contracts: Array.from({ length: Math.min(owned, 24) }, (_, i) => ({
      ...benchC!,
      functionName: "tokenOfOwnerByIndex" as const,
      args: [address!, BigInt(i)],
    })),
    query: { enabled: Boolean(benchC && address) && owned > 0 },
  });
  const myBenches = (benchIdData ?? [])
    .map((r) => r.result as bigint | undefined)
    .filter((v): v is bigint => v !== undefined);

  if (!plotC || !hesoyamC) return <Empty title="Hesoyam is not deployed on this network." />;

  return (
    <>
      <StatGrid>
        <Stat label="Plots in existence" value={supply} note={`${Number(h(1) ?? 0n)} ever minted, cap 256`} />
        <Stat label="Rent you can claim" value={hesoyam(owed)} tone="cash" note="paid by growers" />
        <Stat label="Rent paid, all time" value={hesoyam(h(3))} note="across every plot" />
        <Stat label="Of that, to the protocol" value={hesoyam(h(4))} tone="gold" note="30 percent cut" />
      </StatGrid>

      {owed > 0n ? (
        <Panel title="Rent" subtitle="Every unit of this was paid by a grower who sited a bench on your ground.">
          <Row label="Claimable" value={`${hesoyam(owed)} HESOYAM`} tone="cash" />
          <div className="row-actions">
            <TxButton
              tx={claim}
              onClick={() => void claim.run({ ...plotC, functionName: "claimRent", args: [] })}
            >
              Claim rent
            </TxButton>
          </div>
          <TxStatus tx={claim} />
        </Panel>
      ) : null}

      <MintPanel plotC={plotC} hesoyamC={hesoyamC} me={address} />

      <FusePanel plotC={plotC} hesoyamC={hesoyamC} me={address} plotIds={plotIds} />

      {plotIds.length === 0 ? (
        <Empty title="No plots exist on this network yet">
          On a local chain the seed script mints a handful. The collection caps at 256 and
          the only other supply change is fusing, which burns two to make one.
        </Empty>
      ) : (
        <div className="plot-grid">
          {plotIds.map((id) => (
            <PlotCard
              key={id.toString()}
              plotId={id}
              plotC={plotC}
              hesoyamC={hesoyamC}
              me={address}
              benches={myBenches}
            />
          ))}
        </div>
      )}
    </>
  );
}

function PlotCard({
  plotId,
  plotC,
  hesoyamC,
  me,
  benches,
}: {
  plotId: bigint;
  plotC: { address: `0x${string}`; abi: readonly unknown[] };
  hesoyamC: { address: `0x${string}`; abi: readonly unknown[] };
  me: `0x${string}` | undefined;
  benches: bigint[];
}) {
  const site = useTx();
  const [days, setDays] = useState("14");
  const [bench, setBench] = useState("");
  const [rateDraft, setRateDraft] = useState("");
  const setRate = useTx();
  const allowance = useAllowance(hesoyamC as never, plotC.address);
  const approve = useTx({ onDone: () => void allowance.refetch() });

  const { data } = useReadContracts({
    contracts: [
      { ...plotC, functionName: "tokenURI" as const, args: [plotId] },
      { ...plotC, functionName: "info" as const, args: [plotId] },
      { ...plotC, functionName: "ownerOf" as const, args: [plotId] },
      { ...plotC, functionName: "rateOf" as const, args: [plotId] },
      { ...plotC, functionName: "leaseOf" as const, args: [plotId] },
    ],
  });

  const art = imageFromTokenURI(data?.[0]?.result as string | undefined);
  const info = data?.[1]?.result as readonly [number, number, bigint] | undefined;
  const owner = data?.[2]?.result as `0x${string}` | undefined;
  const rate = (data?.[3]?.result as bigint | undefined) ?? 0n;
  const lease = data?.[4]?.result as readonly [`0x${string}`, bigint, bigint] | undefined;

  const mine = owner && me && owner.toLowerCase() === me.toLowerCase();
  const letUntil = Number(lease?.[2] ?? 0n);
  const isLet = letUntil * 1000 > Date.now();
  const dayCount = Math.max(1, Math.min(90, Number(days) || 1));
  const cost = rate * BigInt(dayCount);
  const benchId = bench !== "" ? BigInt(bench) : benches[0];
  const canSite = benchId !== undefined;

  return (
    <div className="plot-card">
      <div className="plot-art">
        {art ? (
          <img src={art} alt={`Plot ${plotId.toString()}`} />
        ) : (
          <div className="plot-art-empty">rendering</div>
        )}
      </div>

      <div className="plot-body">
        <div className="plot-head">
          <span className="plot-id">Plot {plotId.toString()}</span>
          {mine ? <Pill tone="gold">Yours</Pill> : null}
          {isLet ? <Pill tone="amber">Let</Pill> : <Pill tone="cash">Open</Pill>}
        </div>

        <div className="plot-meta">
          <span>{info ? DISTRICTS[info[0] % 8] : ""}</span>
          <span>{info ? TIERS[info[1] % 4] : ""}</span>
        </div>

        <Row label="Day rate" value={`${hesoyam(rate)} HESOYAM`} />

        {mine ? (
          <div className="plot-owner">
            <div className="plot-site">
              <input
                className="input input-inline"
                value={rateDraft}
                inputMode="numeric"
                aria-label="Day rate in HESOYAM"
                placeholder={hesoyam(rate)}
                onChange={(e) => setRateDraft(e.target.value)}
              />
              <TxButton
                tx={setRate}
                variant="ghost"
                disabled={rateDraft === ""}
                onClick={() =>
                  void setRate.run({
                    ...plotC,
                    abi: plotC.abi as never,
                    functionName: "setDayRate",
                    args: [plotId, BigInt(Math.max(0, Math.floor(Number(rateDraft) || 0))) * 10n ** 18n],
                  })
                }
              >
                Set rent
              </TxButton>
            </div>
            <TxStatus tx={setRate} />
          </div>
        ) : null}

        {!mine && !isLet ? (
          <>
            <div className="plot-site">
              <select
                className="input input-inline plot-bench"
                aria-label="Bench to site"
                value={bench}
                onChange={(e) => setBench(e.target.value)}
              >
                {benches.length === 0 ? <option value="">no bench</option> : null}
                {benches.map((b) => (
                  <option key={b.toString()} value={b.toString()}>
                    Bench {b.toString()}
                  </option>
                ))}
              </select>
              <input
                className="input input-inline"
                value={days}
                inputMode="numeric"
                aria-label="Days to rent"
                onChange={(e) => setDays(e.target.value)}
              />
              <span className="plot-cost">{hesoyam(cost)} HESOYAM</span>
            </div>
            {allowance.isEnough(cost) ? (
              <TxButton
                tx={site}
                disabled={!canSite}
                onClick={() =>
                  void site.run({
                    ...plotC,
                    abi: plotC.abi as never,
                    functionName: "site",
                    // maxTotal pins the price the player agreed to. Without it a
                    // plot owner can raise the rate in front of this call.
                    args: [plotId, benchId!, dayCount, cost],
                  })
                }
              >
                Site a bench
              </TxButton>
            ) : (
              <TxButton
                tx={approve}
                onClick={() =>
                  void approve.run({
                    ...hesoyamC,
                    abi: hesoyamC.abi as never,
                    functionName: "approve",
                    args: [plotC.address, cost],
                  })
                }
              >
                Approve {hesoyam(cost)}
              </TxButton>
            )}
            <TxStatus tx={site} />
            <TxStatus tx={approve} />
          </>
        ) : null}
      </div>
    </div>
  );
}


const FUSE_DISTRICTS = DISTRICTS;

/**
 * Fusing: burn two plots of the same district AND the same tier to mint one of
 * the next tier up.
 *
 * Both constraints are enforced on chain. Equal tiers in particular is what
 * makes the top tier cost eight plots rather than four, so the picker only ever
 * offers pairs the contract will actually accept.
 */
function FusePanel({
  plotC,
  hesoyamC,
  me,
  plotIds,
}: {
  plotC: { address: `0x${string}`; abi: readonly unknown[] };
  hesoyamC: { address: `0x${string}`; abi: readonly unknown[] };
  me: `0x${string}` | undefined;
  plotIds: bigint[];
}) {
  const fuse = useTx();
  const allowance = useAllowance(hesoyamC as never, plotC.address);
  const approve = useTx({ onDone: () => void allowance.refetch() });
  const [pick, setPick] = useState<string>("");

  const { data: fee } = useReadContract({
    address: plotC.address,
    abi: plotC.abi as never,
    functionName: "fuseFee",
  });
  const fuseFee = (fee as bigint | undefined) ?? 0n;

  const { data } = useReadContracts({
    contracts: plotIds.flatMap((id) => [
      { address: plotC.address, abi: plotC.abi as never, functionName: "ownerOf" as const, args: [id] },
      { address: plotC.address, abi: plotC.abi as never, functionName: "info" as const, args: [id] },
      { address: plotC.address, abi: plotC.abi as never, functionName: "leaseOf" as const, args: [id] },
    ]),
    query: { enabled: plotIds.length > 0 },
  });

  const now = Math.floor(Date.now() / 1000);
  const mine = plotIds
    .map((id, i) => {
      const owner = data?.[i * 3]?.result as `0x${string}` | undefined;
      const info = data?.[i * 3 + 1]?.result as readonly [number, number, bigint] | undefined;
      const lease = data?.[i * 3 + 2]?.result as readonly [`0x${string}`, bigint, bigint] | undefined;
      if (!owner || !info || !me) return undefined;
      if (owner.toLowerCase() !== me.toLowerCase()) return undefined;
      if (Number(lease?.[2] ?? 0n) > now) return undefined; // a let plot cannot fuse
      return { id, district: Number(info[0]), tier: Number(info[1]) };
    })
    .filter((v): v is NonNullable<typeof v> => Boolean(v));

  // Only pairs the contract will accept: same district, same tier, below the cap.
  const pairs: { a: bigint; b: bigint; label: string }[] = [];
  for (let i = 0; i < mine.length; i++) {
    for (let j = i + 1; j < mine.length; j++) {
      const x = mine[i];
      const y = mine[j];
      if (x.district !== y.district || x.tier !== y.tier || x.tier >= 3) continue;
      pairs.push({
        a: x.id,
        b: y.id,
        label: `#${x.id} + #${y.id}, ${FUSE_DISTRICTS[x.district % 8]}, tier ${x.tier} to ${x.tier + 1}`,
      });
    }
  }

  const chosen = pairs.find((p) => `${p.a}-${p.b}` === pick) ?? pairs[0];

  return (
    <Panel
      title="Fuse"
      subtitle="Burn two matching plots to make one of the next tier. Supply only ever falls."
    >
      {pairs.length === 0 ? (
        <Empty title="No fusable pair.">
          You need two plots in the same district, at the same tier, with neither currently
          let. That is what keeps the top tier scarce.
        </Empty>
      ) : (
        <>
          <div className="field">
            <span className="field-label">Pair</span>
            <select
              className="input"
              aria-label="Plots to fuse"
              value={pick || `${pairs[0].a}-${pairs[0].b}`}
              onChange={(e) => setPick(e.target.value)}
            >
              {pairs.map((p) => (
                <option key={`${p.a}-${p.b}`} value={`${p.a}-${p.b}`}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <Row label="Fuse fee" value={`${hesoyam(fuseFee)} HESOYAM`} tone="gold" />
          <div className="row-actions">
            {allowance.isEnough(fuseFee) ? (
              <TxButton
                tx={fuse}
                disabled={!chosen}
                onClick={() =>
                  void fuse.run({
                    ...plotC,
                    abi: plotC.abi as never,
                    functionName: "fuse",
                    args: [chosen!.a, chosen!.b],
                  })
                }
              >
                Burn both and fuse
              </TxButton>
            ) : (
              <TxButton
                tx={approve}
                onClick={() =>
                  void approve.run({
                    ...hesoyamC,
                    abi: hesoyamC.abi as never,
                    functionName: "approve",
                    args: [plotC.address, fuseFee],
                  })
                }
              >
                Approve {hesoyam(fuseFee)}
              </TxButton>
            )}
          </div>
          <TxStatus tx={fuse} />
          <TxStatus tx={approve} />
        </>
      )}
    </Panel>
  );
}


/**
 * Minting a plot.
 *
 * The whole price goes to the RevenueRouter, so buying ground is itself a
 * revenue line rather than a transfer to the team. Every mint is tier 0: the
 * only way to a higher tier is fusing, which burns two.
 */
function MintPanel({
  plotC,
  hesoyamC,
  me,
}: {
  plotC: { address: `0x${string}`; abi: readonly unknown[] };
  hesoyamC: { address: `0x${string}`; abi: readonly unknown[] };
  me: `0x${string}` | undefined;
}) {
  const mint = useTx();
  const allowance = useAllowance(hesoyamC as never, plotC.address);
  const approve = useTx({ onDone: () => void allowance.refetch() });
  const [count, setCount] = useState("1");

  const { data } = useReadContracts({
    contracts: [
      { address: plotC.address, abi: plotC.abi as never, functionName: "mintOpen" as const },
      { address: plotC.address, abi: plotC.abi as never, functionName: "mintPrice" as const },
      { address: plotC.address, abi: plotC.abi as never, functionName: "maxPerWallet" as const },
      { address: plotC.address, abi: plotC.abi as never, functionName: "minted" as const },
      { address: plotC.address, abi: plotC.abi as never, functionName: "MAX_SUPPLY" as const },
      {
        address: plotC.address,
        abi: plotC.abi as never,
        functionName: "mintableBy" as const,
        args: [me ?? "0x0000000000000000000000000000000000000000"],
      },
    ],
  });

  const open = Boolean(data?.[0]?.result);
  const price = (data?.[1]?.result as bigint | undefined) ?? 0n;
  const perWallet = Number((data?.[2]?.result as bigint | undefined) ?? 0n);
  const mintedSoFar = Number((data?.[3]?.result as bigint | undefined) ?? 0n);
  const cap = Number((data?.[4]?.result as bigint | undefined) ?? 0n);
  const canMint = Number((data?.[5]?.result as bigint | undefined) ?? 0n);

  const n = Math.max(1, Math.min(10, Number(count) || 1));
  const cost = price * BigInt(n);
  const tooMany = n > canMint;

  return (
    <Panel
      title="Mint a plot"
      subtitle="The whole price is protocol revenue. Every mint is tier 0, and the only way up is fusing."
    >
      <Row label="Minted" value={`${mintedSoFar} of ${cap}`} />
      <Row label="Price" value={`${hesoyam(price)} HESOYAM each`} tone="gold" />
      <Row label="Your limit" value={`${perWallet} per wallet, ${canMint} left`} />

      {!open ? (
        <Warning>
          Minting is closed. The owner opens it with setMint, and until then the only
          plots in circulation are the initial allocation.
        </Warning>
      ) : (
        <>
          <div className="plot-site" style={{ marginTop: 14 }}>
            <input
              className="input input-inline"
              value={count}
              inputMode="numeric"
              aria-label="How many to mint"
              onChange={(e) => setCount(e.target.value)}
            />
            <span className="plot-cost">{hesoyam(cost)} HESOYAM</span>
          </div>

          {tooMany ? (
            <Warning>
              You can mint {canMint} more. The per wallet cap exists so one buyer cannot
              take the supply and leave no rental market behind.
            </Warning>
          ) : null}

          <div className="row-actions">
            {allowance.isEnough(cost) ? (
              <TxButton
                tx={mint}
                disabled={tooMany || canMint === 0}
                onClick={() =>
                  void mint.run({
                    ...plotC,
                    abi: plotC.abi as never,
                    functionName: "mint",
                    args: [n],
                  })
                }
              >
                Mint {n}
              </TxButton>
            ) : (
              <TxButton
                tx={approve}
                onClick={() =>
                  void approve.run({
                    ...hesoyamC,
                    abi: hesoyamC.abi as never,
                    functionName: "approve",
                    args: [plotC.address, cost],
                  })
                }
              >
                Approve {hesoyam(cost)}
              </TxButton>
            )}
          </div>
          <TxStatus tx={mint} />
          <TxStatus tx={approve} />
        </>
      )}
    </Panel>
  );
}

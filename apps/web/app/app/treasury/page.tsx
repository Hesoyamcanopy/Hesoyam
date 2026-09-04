"use client";

import { useReadContracts } from "wagmi";
import { useAddresses, contractFor } from "../../../lib/contracts";
import { Panel, StatGrid, Stat, Row, Empty, Pill } from "../../../components/ui";
import { hesoyam, money, pct } from "../../../lib/format";

/**
 * The page that makes the honesty checkable.
 *
 * Every figure is read live from a contract. The invariants below are not restated
 * claims, they are comparisons between two numbers the chain reports, and each one
 * fails visibly if it stops holding.
 */
export default function TreasuryPage() {
  const { addresses, deployed } = useAddresses();

  const routerC = contractFor(addresses, "RevenueRouter");
  const vaultC = contractFor(addresses, "StakingVault");
  const dispC = contractFor(addresses, "Dispensary");
  const hesoyamC = contractFor(addresses, "HesoyamToken");
  const flowerC = contractFor(addresses, "Flower");

  const { data, isLoading } = useReadContracts({
    contracts: [
      { ...routerC!, functionName: "totalRealized" as const },
      { ...routerC!, functionName: "totalToEquity" as const },
      { ...routerC!, functionName: "totalToDispensary" as const },
      { ...routerC!, functionName: "totalToLiquidity" as const },
      { ...routerC!, functionName: "totalToOps" as const },
      { ...routerC!, functionName: "reserveBalance" as const },
      { ...routerC!, functionName: "pendingHesoyam" as const },
      { ...vaultC!, functionName: "totalNotified" as const },
      { ...vaultC!, functionName: "totalDistributed" as const },
      { ...vaultC!, functionName: "totalPrincipal" as const },
      { ...hesoyamC!, functionName: "balanceOf" as const, args: [vaultC?.address ?? "0x0"] },
      { ...hesoyamC!, functionName: "totalSupply" as const },
      { ...hesoyamC!, functionName: "MAX_SUPPLY" as const },
      { ...dispC!, functionName: "totalFunded" as const },
      { ...dispC!, functionName: "totalSpent" as const },
      { ...routerC!, functionName: "allocation" as const },
    ],
    query: { enabled: deployed && Boolean(routerC && vaultC && dispC && hesoyamC) },
  });

  if (!deployed) return <div className="page"><Empty title="Hesoyam is not deployed on this network." /></div>;
  if (isLoading) return <div className="page"><div className="panel panel-quiet">Reading the chain.</div></div>;

  const v = (i: number) => (data?.[i]?.result as bigint | undefined) ?? 0n;
  const allocation = data?.[15]?.result as readonly [number, number, number, number, number] | undefined;

  const realized = v(0);
  const notified = v(7);
  const distributed = v(8);
  const principal = v(9);
  const vaultHesoyam = v(10);
  const supply = v(11);
  const maxSupply = v(12);
  const dispFunded = v(13);
  const dispSpent = v(14);

  const invariants = [
    {
      id: "INV-1",
      claim: "Rewards paid never exceed rewards received",
      left: `${money(distributed)} claimed`,
      right: `${money(notified)} delivered`,
      holds: distributed <= notified,
    },
    {
      id: "INV-2",
      claim: "Staked principal is covered by the HESOYAM actually held",
      left: `${hesoyam(vaultHesoyam)} held`,
      right: `${hesoyam(principal)} owed`,
      holds: vaultHesoyam >= principal,
    },
    {
      id: "INV-3",
      claim: "Supply never changes",
      left: `${hesoyam(supply, 0)} supply`,
      right: `${hesoyam(maxSupply, 0)} at launch`,
      holds: supply === maxSupply,
    },
    {
      id: "INV-9",
      claim: "The Dispensary cannot outspend its funding",
      left: `${money(dispSpent)} spent`,
      right: `${money(dispFunded)} funded`,
      holds: dispSpent <= dispFunded,
    },
  ];

  const share = (part: bigint) =>
    realized > 0n ? pct(Number((part * 10_000n) / realized) / 100) : "0%";

  return (
    <div className="page">
      <header className="page-head">
        <h1>Treasury</h1>
        <p>
          Read live from the contracts. If a number here disagrees with something we said
          elsewhere, this one is right.
        </p>
      </header>

      <StatGrid>
        <Stat label="Revenue realized" value={money(realized)} note="all time" />
        <Stat label="To stakers" value={money(v(1))} tone="cash" note={share(v(1))} />
        <Stat label="To growers" value={money(v(2))} tone="amber" note={share(v(2))} />
        <Stat label="Waiting to convert" value={`${hesoyam(v(6))} HESOYAM`} note="in the router" />
      </StatGrid>

      <div className="two-col">
        <Panel title="Where revenue went" subtitle="The split is written into the contract.">
          <Row label="Equity desk, stakers" value={`${money(v(1))} (${share(v(1))})`} tone="cash" />
          <Row label="Dispensary, growers" value={`${money(v(2))} (${share(v(2))})`} tone="amber" />
          <Row label="Liquidity" value={`${money(v(3))} (${share(v(3))})`} />
          <Row label="Operations" value={`${money(v(4))} (${share(v(4))})`} />
          <Row label="Reserve held" value={money(v(5))} />
          {allocation ? (
            <p className="panel-note mono">
              Configured split: {allocation[0] / 100}% / {allocation[1] / 100}% /{" "}
              {allocation[2] / 100}% / {allocation[3] / 100}% / {allocation[4] / 100}%
            </p>
          ) : null}
        </Panel>

        <Panel title="Invariants" subtitle="Compared live, not restated.">
          <div className="invariant-list">
            {invariants.map((inv) => (
              <div key={inv.id} className="invariant">
                <div className="invariant-head">
                  <span className="mono invariant-id">{inv.id}</span>
                  <Pill tone={inv.holds ? "cash" : "red"}>{inv.holds ? "holds" : "BROKEN"}</Pill>
                </div>
                <p className="invariant-claim">{inv.claim}</p>
                <p className="invariant-numbers mono">
                  {inv.left} against {inv.right}
                </p>
              </div>
            ))}
          </div>
          <p className="panel-note">
            These four are the ones a reader can check from public state alone. The full
            set, including the ones that need a transaction trace, lives in the contract
            test suite.
          </p>
        </Panel>
      </div>

      <Panel title="What this page does not show" quiet>
        <p className="panel-note">
          There is no projected yield here, and there will not be one. Revenue is a
          consequence of people trading and playing, so the only honest forward looking
          number is the one you work out yourself from the trailing figures above.
        </p>
      </Panel>
    </div>
  );
}

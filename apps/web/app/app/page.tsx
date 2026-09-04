"use client";

import Link from "next/link";
import { useReadContracts } from "wagmi";
import { useAddresses, contractFor } from "../../lib/contracts";
import { RequireWallet, useViewer } from "../../components/connect";
import { Panel, StatGrid, Stat, Empty, Row } from "../../components/ui";
import { Hud, Meter } from "../../components/hud";
import { hesoyam, money, units } from "../../lib/format";

export default function Overview() {
  return (
    <div className="page">
      <header className="page-head">
        <h1>Overview</h1>
        <p>Everything you hold, and what the protocol has actually earned.</p>
      </header>
      <RequireWallet>
        <OverviewBody />
      </RequireWallet>
    </div>
  );
}

function OverviewBody() {
  const { address } = useViewer();
  const { addresses } = useAddresses();

  const hesoyamC = contractFor(addresses, "HesoyamToken");
  const vaultC = contractFor(addresses, "StakingVault");
  const routerC = contractFor(addresses, "RevenueRouter");
  const gameC = contractFor(addresses, "GrowGame");
  const benchC = contractFor(addresses, "GrowBench");
  const cardC = contractFor(addresses, "StrainCard");

  const { data, isLoading } = useReadContracts({
    contracts: [
      { ...hesoyamC!, functionName: "balanceOf", args: [address!] },
      { ...vaultC!, functionName: "weightOf", args: [address!] },
      { ...vaultC!, functionName: "pendingReward", args: [address!] },
      { ...vaultC!, functionName: "totalWeight" },
      { ...vaultC!, functionName: "totalPrincipal" },
      { ...routerC!, functionName: "totalRealized" },
      { ...routerC!, functionName: "totalToEquity" },
      { ...routerC!, functionName: "totalToDispensary" },
      { ...gameC!, functionName: "totalPlanted" },
      { ...gameC!, functionName: "totalHarvested" },
      { ...benchC!, functionName: "balanceOf", args: [address!] },
      { ...cardC!, functionName: "balanceOf", args: [address!] },
      { ...vaultC!, functionName: "cardBonusBps", args: [address!] },
      { ...vaultC!, functionName: "equippedCardCount", args: [address!] },
    ],
    query: { enabled: Boolean(address && hesoyamC && vaultC && routerC && gameC && benchC && cardC) },
  });

  const v = (i: number) => data?.[i]?.result as bigint | undefined;

  const totalWeight = v(3) ?? 0n;
  const myWeight = v(1) ?? 0n;
  const share = totalWeight > 0n ? Number((myWeight * 1_000_000n) / totalWeight) / 10_000 : 0;

  // Both caps are contract constants, not display choices. MAX_CARD_BONUS_BPS is
  // 4200 and MAX_EQUIPPED_CARDS is 5, which is why the stars top out at five.
  const bonusBps = Number(v(12) ?? 0n);
  const bonusPct = (bonusBps / 4200) * 100;
  const equipped = Number(v(13) ?? 0n);

  if (isLoading) return <div className="panel panel-quiet">Reading the chain.</div>;

  return (
    <>
      <div className="panel hud-panel">
        <Hud cash={hesoyam(v(0))} stars={{ value: equipped, max: 5, label: "Strain cards equipped" }}>
          <Meter
            label="Pool"
            pct={share}
            value={`${share.toFixed(3)}% of pool weight`}
            tone="health"
          />
          <Meter
            label="Cards"
            pct={bonusPct}
            value={`${bonusBps} of 4200 bps`}
            tone="armor"
          />
        </Hud>
      </div>

      <StatGrid>
        <Stat label="HESOYAM balance" value={hesoyam(v(0))} note="in your wallet" />
        <Stat label="Your weight" value={hesoyam(myWeight)} note={`${share.toFixed(3)}% of the pool`} />
        <Stat label="Claimable" value={money(v(2))} tone="cash" note="settled, waiting for you" />
        <Stat label="Benches" value={units(v(10))} note={`${units(v(11))} strain cards`} />
      </StatGrid>

      <div className="two-col">
        <Panel title="Protocol revenue" subtitle="Realized, not projected.">
          <Row label="Total realized" value={money(v(5))} />
          <Row label="To stakers" value={money(v(6))} tone="cash" />
          <Row label="To growers" value={money(v(7))} tone="amber" />
          <Row label="Staked principal" value={`${hesoyam(v(4))} HESOYAM`} />
          <p className="panel-note">
            Every number here is money that arrived. If trading and playing stop, these
            stop moving, and no reward is paid from anyone&rsquo;s deposit.
          </p>
        </Panel>

        <Panel title="The game so far">
          <Row label="Grows planted" value={units(v(8))} />
          <Row label="Harvests taken" value={units(v(9))} />
          <div className="quick-links">
            <Link className="btn btn-primary btn-sm" href="/app/grow">
              Go to the grow room
            </Link>
            <Link className="btn btn-ghost btn-sm" href="/app/stake">
              Stake HESOYAM
            </Link>
          </div>
        </Panel>
      </div>

      {myWeight === 0n && (v(0) ?? 0n) === 0n ? (
        <Empty title="You have no HESOYAM on this network">
          On a local chain, run the seed script to fund the test accounts. On testnet, use
          the faucet link in the docs.
        </Empty>
      ) : null}
    </>
  );
}

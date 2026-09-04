"use client";

import { useState } from "react";
import { useReadContract, useReadContracts } from "wagmi";
import { parseUnits } from "viem";
import { stakeWeight, earlyExitPenalty, MAX_CARD_BONUS_BPS } from "@hesoyam/game-core";
import { useAddresses, contractFor } from "../../../lib/contracts";
import { RequireWallet, useViewer } from "../../../components/connect";
import { Panel, StatGrid, Stat, Empty, Row, Pill, Field, Warning } from "../../../components/ui";
import { useTx, TxStatus, TxButton, useAllowance } from "../../../components/tx";
import { hesoyam, money, bpsToX, dateOf, timeUntil } from "../../../lib/format";

const TIER_NAMES = ["Seedling", "Vegetative", "Flowering", "Canopy"];

export default function StakePage() {
  return (
    <div className="page">
      <header className="page-head">
        <h1>Stake</h1>
        <p>
          Lock HESOYAM for weight, and weight earns a share of the settlement the treasury
          collected. There is no rate here, only a share.
        </p>
      </header>
      <RequireWallet>
        <StakeBody />
      </RequireWallet>
    </div>
  );
}

function StakeBody() {
  const { address } = useViewer();
  const { addresses } = useAddresses();
  const now = Math.floor(Date.now() / 1000);

  const vaultC = contractFor(addresses, "StakingVault");
  const hesoyamC = contractFor(addresses, "HesoyamToken");
  const cardC = contractFor(addresses, "StrainCard");

  const { data } = useReadContracts({
    contracts: [
      { ...vaultC!, functionName: "tierCount" as const },
      { ...vaultC!, functionName: "weightOf" as const, args: [address!] },
      { ...vaultC!, functionName: "baseWeight" as const, args: [address!] },
      { ...vaultC!, functionName: "cardBonusBps" as const, args: [address!] },
      { ...vaultC!, functionName: "pendingReward" as const, args: [address!] },
      { ...vaultC!, functionName: "totalWeight" as const },
      { ...vaultC!, functionName: "positionCount" as const, args: [address!] },
      { ...hesoyamC!, functionName: "balanceOf" as const, args: [address!] },
      { ...vaultC!, functionName: "totalNotified" as const },
      { ...vaultC!, functionName: "totalDistributed" as const },
    ],
    query: { enabled: Boolean(vaultC && hesoyamC && address) },
  });

  const v = (i: number) => (data?.[i]?.result as bigint | undefined) ?? 0n;
  const nTiers = Number(v(0));
  const nPositions = Number(v(6));

  const { data: tierData } = useReadContracts({
    contracts: Array.from({ length: nTiers }, (_, i) => ({
      ...vaultC!,
      functionName: "tiers" as const,
      args: [BigInt(i)],
    })),
    query: { enabled: Boolean(vaultC) && nTiers > 0 },
  });

  const tiers = (tierData ?? []).map((r, i) => {
    const t = r.result as readonly [number, number, boolean] | undefined;
    return t ? { id: i, lockSeconds: Number(t[0]), multiplierBps: Number(t[1]), enabled: t[2] } : undefined;
  });

  const { data: positionData } = useReadContracts({
    contracts: Array.from({ length: nPositions }, (_, i) => ({
      ...vaultC!,
      functionName: "positions" as const,
      args: [address!, BigInt(i)],
    })),
    query: { enabled: Boolean(vaultC && address) && nPositions > 0 },
  });

  const positions = (positionData ?? [])
    .map((r, i) => {
      const p = r.result as readonly [bigint, bigint, number, boolean] | undefined;
      if (!p || p[3]) return undefined;
      return { id: i, amount: p[0], unlockAt: Number(p[1]), multiplierBps: p[2] };
    })
    .filter((p): p is NonNullable<typeof p> => Boolean(p));

  if (!vaultC || !hesoyamC) return <Empty title="Hesoyam is not deployed on this network." />;

  const totalWeight = v(5);
  const myWeight = v(1);
  const share = totalWeight > 0n ? Number((myWeight * 1_000_000n) / totalWeight) / 10_000 : 0;

  return (
    <>
      <StatGrid>
        <Stat label="Your weight" value={hesoyam(myWeight)} note={`${share.toFixed(3)}% of the pool`} />
        <Stat label="Claimable" value={money(v(4))} tone="cash" />
        <Stat label="Card bonus" value={bpsToX(10_000 + Number(v(3)))} note={`capped at ${bpsToX(10_000 + MAX_CARD_BONUS_BPS)}`} />
        <Stat label="Wallet" value={`${hesoyam(v(7))} HESOYAM`} />
      </StatGrid>

      <ClaimPanel vaultC={vaultC} pending={v(4)} notified={v(8)} distributed={v(9)} />

      <StakeForm vaultC={vaultC} hesoyamC={hesoyamC} tiers={tiers} balance={v(7)} cardBonus={Number(v(3))} />

      <Panel title="Your positions">
        {positions.length === 0 ? (
          <Empty title="Nothing staked yet." />
        ) : (
          <div className="position-list">
            {positions.map((p) => (
              <PositionRow key={p.id} position={p} vaultC={vaultC} now={now} />
            ))}
          </div>
        )}
      </Panel>

      <EquippedPanel vaultC={vaultC} />
      <CardPanel vaultC={vaultC} cardC={cardC} />
    </>
  );
}

function ClaimPanel({
  vaultC,
  pending,
  notified,
  distributed,
}: {
  vaultC: { address: `0x${string}`; abi: readonly unknown[] };
  pending: bigint;
  notified: bigint;
  distributed: bigint;
}) {
  const tx = useTx();
  return (
    <Panel title="Rewards" subtitle="Settled in the treasury's settlement token.">
      <Row label="Waiting for you" value={money(pending)} tone="cash" />
      <Row label="Delivered to the vault, all time" value={money(notified)} />
      <Row label="Claimed by everyone, all time" value={money(distributed)} />
      <div className="row-actions">
        <TxButton
          tx={tx}
          disabled={pending === 0n}
          onClick={() =>
            void tx.run({
              address: vaultC.address,
              abi: vaultC.abi as never,
              functionName: "claim",
            })
          }
        >
          Claim {money(pending)}
        </TxButton>
      </div>
      <p className="panel-note">
        Claimed can never exceed delivered. That is an invariant with a test behind it,
        not a policy.
      </p>
      <TxStatus tx={tx} />
    </Panel>
  );
}

function StakeForm({
  vaultC,
  hesoyamC,
  tiers,
  balance,
  cardBonus,
}: {
  vaultC: { address: `0x${string}`; abi: readonly unknown[] };
  hesoyamC: { address: `0x${string}`; abi: readonly unknown[] };
  tiers: ({ id: number; lockSeconds: number; multiplierBps: number; enabled: boolean } | undefined)[];
  balance: bigint;
  cardBonus: number;
}) {
  const [amount, setAmount] = useState("");
  const [tierId, setTierId] = useState(0);
  const tx = useTx();
  const approveTx = useTx();
  const allowance = useAllowance(hesoyamC as never, vaultC.address);

  const wei = amount ? parseUnits(amount, 18) : 0n;
  const tier = tiers.find((t) => t?.id === tierId);
  const weight = tier ? stakeWeight(wei, tier.multiplierBps, cardBonus) : 0n;
  const enough = allowance.allowance >= wei && wei > 0n;
  const overBalance = wei > balance;

  return (
    <Panel title="Open a position" subtitle="Longer locks carry more weight. Leaving early costs 4 percent.">
      <div className="tier-picker">
        {tiers.filter((t): t is NonNullable<typeof t> => Boolean(t?.enabled)).map((t) => (
          <button
            key={t.id}
            type="button"
            className={`tier-option${tierId === t.id ? " is-active" : ""}`}
            onClick={() => setTierId(t.id)}
          >
            <span className="tier-option-name">{TIER_NAMES[t.id] ?? `Tier ${t.id}`}</span>
            <span className="tier-option-lock mono">
              {t.lockSeconds === 0 ? "no lock" : `${Math.round(t.lockSeconds / 86400)} days`}
            </span>
            <span className="tier-option-mult mono">{bpsToX(t.multiplierBps)}</span>
          </button>
        ))}
      </div>

      <div className="sell-grid">
        <Field label="Amount" hint={`Balance ${hesoyam(balance)} HESOYAM`}>
          <input
            className="input"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="0.0"
          />
        </Field>
        <Field label="Weight you gain" hint="amount times tier times card bonus">
          <div className="input input-readonly mono">{hesoyam(weight)}</div>
        </Field>
        <Field label="Unlocks" hint={tier && tier.lockSeconds > 0 ? "early exit costs 4 percent" : "no lock"}>
          <div className="input input-readonly mono">
            {tier && tier.lockSeconds > 0
              ? dateOf(Math.floor(Date.now() / 1000) + tier.lockSeconds)
              : "anytime"}
          </div>
        </Field>
      </div>

      {overBalance ? <Warning>That is more than your balance.</Warning> : null}

      <div className="row-actions">
        {enough ? (
          <TxButton
            tx={tx}
            disabled={wei === 0n || overBalance}
            onClick={() =>
              void tx.run({
                address: vaultC.address,
                abi: vaultC.abi as never,
                functionName: "stake",
                args: [wei, BigInt(tierId)],
              })
            }
          >
            Stake
          </TxButton>
        ) : (
          <TxButton
            tx={approveTx}
            disabled={wei === 0n || overBalance}
            onClick={() =>
              void approveTx
                .run({
                  address: hesoyamC.address,
                  abi: hesoyamC.abi as never,
                  functionName: "approve",
                  args: [vaultC.address, wei],
                })
                .then(() => allowance.refetch())
            }
          >
            Approve {amount || "0"} HESOYAM
          </TxButton>
        )}
      </div>
      <TxStatus tx={tx} />
      <TxStatus tx={approveTx} />
    </Panel>
  );
}

function PositionRow({
  position,
  vaultC,
  now,
}: {
  position: { id: number; amount: bigint; unlockAt: number; multiplierBps: number };
  vaultC: { address: `0x${string}`; abi: readonly unknown[] };
  now: number;
}) {
  const tx = useTx();
  const locked = now < position.unlockAt;
  const penalty = earlyExitPenalty(position.amount, position.unlockAt, now);

  return (
    <div className="position-row">
      <div className="position-main">
        <span className="mono position-amount">{hesoyam(position.amount)} HESOYAM</span>
        <Pill tone={locked ? "amber" : "cash"}>
          {locked ? `locked ${timeUntil(position.unlockAt, now)}` : "unlocked"}
        </Pill>
        <span className="mono position-mult">{bpsToX(position.multiplierBps)}</span>
      </div>
      <div className="position-actions">
        {penalty > 0n ? (
          <span className="position-penalty mono">exit costs {hesoyam(penalty)} HESOYAM</span>
        ) : null}
        <TxButton
          tx={tx}
          variant={locked ? "ghost" : "primary"}
          onClick={() =>
            void tx.run({
              address: vaultC.address,
              abi: vaultC.abi as never,
              functionName: "unstake",
              args: [BigInt(position.id)],
            })
          }
        >
          {locked ? "Exit early" : "Unstake"}
        </TxButton>
      </div>
      <TxStatus tx={tx} />
    </div>
  );
}

function CardPanel({
  vaultC,
  cardC,
}: {
  vaultC: { address: `0x${string}`; abi: readonly unknown[] };
  cardC?: { address: `0x${string}`; abi: readonly unknown[] };
}) {
  const { address } = useViewer();
  const tx = useTx();
  const approveTx = useTx();

  const { data: balance } = useReadContract({
    address: cardC?.address,
    abi: cardC?.abi as never,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(cardC && address) },
  });

  const owned = Number((balance as bigint | undefined) ?? 0n);

  const { data: tokens } = useReadContracts({
    contracts: Array.from({ length: owned }, (_, i) => ({
      address: cardC!.address,
      abi: cardC!.abi as never,
      functionName: "tokenOfOwnerByIndex" as const,
      args: [address!, BigInt(i)],
    })),
    query: { enabled: Boolean(cardC && address) && owned > 0 },
  });

  const ids = (tokens ?? []).map((t) => t.result as bigint | undefined).filter((v): v is bigint => v !== undefined);

  const { data: weights } = useReadContracts({
    contracts: ids.map((id) => ({
      address: cardC!.address,
      abi: cardC!.abi as never,
      functionName: "weightBpsOf" as const,
      args: [id],
    })),
    query: { enabled: ids.length > 0 },
  });

  const { data: approved, refetch } = useReadContract({
    address: cardC?.address,
    abi: cardC?.abi as never,
    functionName: "isApprovedForAll",
    args: address && cardC ? [address, vaultC.address] : undefined,
    query: { enabled: Boolean(cardC && address) },
  });

  if (!cardC) return null;

  return (
    <Panel title="Strain cards" subtitle="Equipping a card raises your weight. The total is capped per wallet.">
      {owned === 0 ? (
        <Empty title="You hold no cards.">
          Burn 400 units of Flower in the crafter to make one.
        </Empty>
      ) : (
        <div className="card-list">
          {ids.map((id, i) => (
            <div key={id.toString()} className="card-item">
              <span className="mono">#{id.toString()}</span>
              <Pill tone="cash">{bpsToX(Number((weights?.[i]?.result as number | undefined) ?? 10_000))}</Pill>
              {approved ? (
                <TxButton
                  tx={tx}
                  onClick={() =>
                    void tx.run({
                      address: vaultC.address,
                      abi: vaultC.abi as never,
                      functionName: "equipCard",
                      args: [id],
                    })
                  }
                >
                  Equip
                </TxButton>
              ) : (
                <TxButton
                  tx={approveTx}
                  variant="ghost"
                  onClick={() =>
                    void approveTx
                      .run({
                        address: cardC.address,
                        abi: cardC.abi as never,
                        functionName: "setApprovalForAll",
                        args: [vaultC.address, true],
                      })
                      .then(() => refetch())
                  }
                >
                  Approve
                </TxButton>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="panel-note">
        A card raises your slice of a fixed pool, not the size of the pool. Between
        stakers, cards are zero sum.
      </p>
      <TxStatus tx={tx} />
      <TxStatus tx={approveTx} />
    </Panel>
  );
}


/**
 * Cards currently held by the vault on your behalf.
 *
 * The vault takes custody when you equip, so these are invisible to any wallet
 * balance read. Unequipping returns the card and recomputes the bonus from the
 * remaining set rather than subtracting a clipped value.
 */
function EquippedPanel({ vaultC }: { vaultC: { address: `0x${string}`; abi: readonly unknown[] } }) {
  const { address } = useViewer();
  const tx = useTx();

  const { data: head } = useReadContracts({
    contracts: [
      { address: vaultC.address, abi: vaultC.abi as never, functionName: "equippedCardCount" as const, args: [address!] },
      { address: vaultC.address, abi: vaultC.abi as never, functionName: "cardBonusBps" as const, args: [address!] },
    ],
    query: { enabled: Boolean(address) },
  });
  const count = Number((head?.[0]?.result as bigint | undefined) ?? 0n);
  const bonus = Number((head?.[1]?.result as bigint | undefined) ?? 0n);

  const { data: ids } = useReadContracts({
    contracts: Array.from({ length: count }, (_, i) => ({
      address: vaultC.address,
      abi: vaultC.abi as never,
      functionName: "equippedCards" as const,
      args: [address!, BigInt(i)],
    })),
    query: { enabled: Boolean(address) && count > 0 },
  });
  const equipped = (ids ?? [])
    .map((r) => r.result as bigint | undefined)
    .filter((v): v is bigint => v !== undefined);

  return (
    <Panel
      title="Equipped cards"
      subtitle={`${count} of 5 slots used. Total bonus ${bonus} of 4200 bps, which is the per wallet cap.`}
    >
      {equipped.length === 0 ? (
        <Empty title="No cards equipped.">
          Equipping moves a card into the vault and raises your weight. You can take it
          back at any time.
        </Empty>
      ) : (
        <div className="card-list">
          {equipped.map((id) => (
            <div key={id.toString()} className="card-item">
              <span className="mono">#{id.toString()}</span>
              <Pill tone="armor">equipped</Pill>
              <TxButton
                tx={tx}
                variant="ghost"
                onClick={() =>
                  void tx.run({
                    address: vaultC.address,
                    abi: vaultC.abi as never,
                    functionName: "unequipCard",
                    args: [id],
                  })
                }
              >
                Unequip
              </TxButton>
            </div>
          ))}
        </div>
      )}
      <TxStatus tx={tx} />
    </Panel>
  );
}

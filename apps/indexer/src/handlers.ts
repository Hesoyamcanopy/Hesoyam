import type { Db } from "./db.ts";
import { decodeFlowerId } from "@hesoyam/sdk";

export type DecodedEvent = {
  contract: string;
  eventName: string;
  address: string;
  blockNumber: bigint;
  blockTime: Date | null;
  txHash: string;
  logIndex: number;
  args: Record<string, unknown>;
};

const s = (v: unknown) => (v === undefined || v === null ? null : String(v));
const n = (v: unknown) => (v === undefined || v === null ? null : Number(v));
const addr = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : null);

const ZERO = "0x0000000000000000000000000000000000000000";

/** Seconds since epoch to a Date, for the uint64 timestamps the contracts emit. */
const ts = (v: unknown) => new Date(Number(v) * 1000);

type Handler = (db: Db, e: DecodedEvent) => Promise<void>;

/**
 * Derived state updates, keyed by contract and event.
 *
 * Every handler is idempotent. Replaying the same event twice must leave the same
 * rows, because a reindex does exactly that. Inserts use `on conflict do update` or
 * `do nothing` rather than assuming a clean table.
 */
export const HANDLERS: Record<string, Handler> = {
  // ------------------------------------------------------------ grow game

  "GrowGame.Planted": async (db, e) => {
    await db.query(
      `insert into grows (grow_id, grower, strain_id, bench_id, planted_at, event_seed, block_number)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (grow_id) do update set
         grower = excluded.grower, strain_id = excluded.strain_id,
         bench_id = excluded.bench_id, planted_at = excluded.planted_at,
         event_seed = excluded.event_seed, block_number = excluded.block_number`,
      [
        s(e.args.growId),
        addr(e.args.grower),
        n(e.args.strainId),
        s(e.args.benchId),
        e.blockTime ?? new Date(0),
        s(e.args.eventSeed),
        Number(e.blockNumber),
      ]
    );
  },

  "GrowGame.Fed": async (db, e) => {
    await db.query(
      `update grows set feed_mask = feed_mask | (1 << $2) where grow_id = $1`,
      [s(e.args.growId), n(e.args.window)]
    );
  },

  "GrowGame.Treated": async (db, e) => {
    await db.query(
      `update grows set treated_mask = treated_mask | (1 << $2) where grow_id = $1`,
      [s(e.args.growId), n(e.args.slot)]
    );
  },

  "GrowGame.Harvested": async (db, e) => {
    await db.query(`update grows set active = false, outcome = 'harvested' where grow_id = $1`, [
      s(e.args.growId),
    ]);
    await db.query(
      `insert into harvests
         (grow_id, grower, units, quality, care, damage_bps, curing, block_number, tx_hash)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (grow_id) do update set
         units = excluded.units, quality = excluded.quality, care = excluded.care,
         damage_bps = excluded.damage_bps, curing = excluded.curing`,
      [
        s(e.args.growId),
        addr(e.args.grower),
        n(e.args.units),
        n(e.args.quality),
        n(e.args.care),
        n(e.args.damageBps),
        Boolean(e.args.curing),
        Number(e.blockNumber),
        e.txHash,
      ]
    );
  },

  "GrowGame.Collected": async (db, e) => {
    const { tier } = decodeFlowerId(BigInt(String(e.args.tokenId)));
    // Scope to exactly one row.
    //
    // This used to match on grower alone, so a player curing two harvests at
    // once had BOTH marked collected by a single event, and both stamped with
    // the same harvest id, tier and quality. The second harvest silently
    // vanished from their inventory. Any player could trigger it by accident.
    await db.query(
      `update harvests set collected = true, harvest_id = $2, final_tier = $3, quality = $4
       where grow_id = (
         select grow_id from harvests
         where grower = $1 and collected = false and curing = true
         order by block_number, grow_id
         limit 1
       )`,
      [addr(e.args.grower), s(e.args.harvestId), tier, n(e.args.quality)]
    );
  },

  "GrowGame.Abandoned": async (db, e) => {
    await db.query(`update grows set active = false, outcome = 'abandoned' where grow_id = $1`, [
      s(e.args.growId),
    ]);
  },

  // ------------------------------------------------------------ marketplace

  "Marketplace.Listed": async (db, e) => {
    const tokenId = BigInt(String(e.args.tokenId));
    const { strainId, tier } = decodeFlowerId(tokenId);
    await db.query(
      `insert into listings
         (listing_id, seller, token_id, strain_id, tier, amount, listed_amount, price_per_unit, block_number)
       values ($1,$2,$3,$4,$5,$6,$6,$7,$8)
       on conflict (listing_id) do update set
         amount = excluded.amount, listed_amount = excluded.listed_amount,
         price_per_unit = excluded.price_per_unit, active = true`,
      [
        s(e.args.listingId),
        addr(e.args.seller),
        s(tokenId),
        strainId,
        tier,
        s(e.args.amount),
        s(e.args.pricePerUnit),
        Number(e.blockNumber),
      ]
    );
  },

  "Marketplace.Filled": async (db, e) => {
    await db.query(
      `insert into fills
         (tx_hash, log_index, listing_id, buyer, amount, gross, fee, block_number, block_time)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (tx_hash, log_index) do nothing`,
      [
        e.txHash,
        e.logIndex,
        s(e.args.listingId),
        addr(e.args.buyer),
        s(e.args.amount),
        s(e.args.gross),
        s(e.args.fee),
        Number(e.blockNumber),
        e.blockTime,
      ]
    );
    // Derived, not accumulated. Replaying this event must land on the same
    // number, and it cannot go below zero however many times it runs.
    await db.query(
      `update listings l
         set amount = greatest(0, l.listed_amount - coalesce(
               (select sum(f.amount) from fills f where f.listing_id = l.listing_id), 0)),
             active = (l.listed_amount - coalesce(
               (select sum(f.amount) from fills f where f.listing_id = l.listing_id), 0)) > 0
       where l.listing_id = $1`,
      [s(e.args.listingId)]
    );
    await db.query(
      `update fills f set seller = l.seller, token_id = l.token_id
       from listings l
       where l.listing_id = f.listing_id and f.tx_hash = $1 and f.log_index = $2`,
      [e.txHash, e.logIndex]
    );
  },

  "Marketplace.Cancelled": async (db, e) => {
    await db.query(`update listings set active = false, amount = 0 where listing_id = $1`, [
      s(e.args.listingId),
    ]);
  },

  // ------------------------------------------------------------ dispensary

  "Dispensary.Sold": async (db, e) => {
    await db.query(
      `insert into dispensary_sales
         (tx_hash, log_index, seller, token_id, units, price_per_unit, proceeds, block_number)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (tx_hash, log_index) do nothing`,
      [
        e.txHash,
        e.logIndex,
        addr(e.args.seller),
        s(e.args.tokenId),
        s(e.args.units),
        s(e.args.pricePerUnit),
        s(e.args.proceeds),
        Number(e.blockNumber),
      ]
    );
  },

  // ------------------------------------------------------------ staking

  "StakingVault.Staked": async (db, e) => {
    await db.query(
      `insert into positions (owner, position_id, amount, tier_id, unlock_at, block_number)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (owner, position_id) do update set
         amount = excluded.amount, tier_id = excluded.tier_id,
         unlock_at = excluded.unlock_at, active = true, exit_kind = null`,
      [
        addr(e.args.user),
        n(e.args.positionId),
        s(e.args.amount),
        n(e.args.tierId),
        ts(e.args.unlockAt),
        Number(e.blockNumber),
      ]
    );
  },

  "StakingVault.Unstaked": async (db, e) => {
    await db.query(
      `update positions set active = false, exit_kind = 'unstake', returned = $3, penalty = $4
       where owner = $1 and position_id = $2`,
      [addr(e.args.user), n(e.args.positionId), s(e.args.returned), s(e.args.penalty)]
    );
  },

  "StakingVault.EmergencyWithdrawn": async (db, e) => {
    await db.query(
      `update positions set active = false, exit_kind = 'emergency', returned = $3, penalty = $4
       where owner = $1 and position_id = $2`,
      [addr(e.args.user), n(e.args.positionId), s(e.args.returned), s(e.args.penalty)]
    );
  },

  "StakingVault.Claimed": async (db, e) => {
    await db.query(
      `insert into claims (tx_hash, log_index, claimer, amount, block_number, block_time)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (tx_hash, log_index) do nothing`,
      [e.txHash, e.logIndex, addr(e.args.user), s(e.args.amount), Number(e.blockNumber), e.blockTime]
    );
  },

  "StakingVault.RewardNotified": async (db, e) => {
    await db.query(
      `insert into reward_notifications (tx_hash, log_index, amount, acc_per_weight, block_number)
       values ($1,$2,$3,$4,$5)
       on conflict (tx_hash, log_index) do nothing`,
      [e.txHash, e.logIndex, s(e.args.amount), s(e.args.accPerWeight), Number(e.blockNumber)]
    );
  },

  "StakingVault.CardEquipped": async (db, e) => {
    await db.query(`update cards set equipped_by = $2 where token_id = $1`, [
      s(e.args.tokenId),
      addr(e.args.user),
    ]);
  },

  "StakingVault.CardUnequipped": async (db, e) => {
    await db.query(`update cards set equipped_by = null where token_id = $1`, [s(e.args.tokenId)]);
  },

  // ------------------------------------------------------------ revenue

  "RevenueRouter.Distributed": async (db, e) => {
    const total =
      BigInt(String(e.args.equity)) +
      BigInt(String(e.args.dispensary)) +
      BigInt(String(e.args.liquidity)) +
      BigInt(String(e.args.ops)) +
      BigInt(String(e.args.reserve));
    await db.query(
      `insert into distributions
         (tx_hash, log_index, to_equity, to_dispensary, to_liquidity, to_ops, to_reserve,
          total, block_number, block_time)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (tx_hash, log_index) do nothing`,
      [
        e.txHash,
        e.logIndex,
        s(e.args.equity),
        s(e.args.dispensary),
        s(e.args.liquidity),
        s(e.args.ops),
        s(e.args.reserve),
        s(total),
        Number(e.blockNumber),
        e.blockTime,
      ]
    );
  },

  "RevenueRouter.Swept": async (db, e) => {
    await db.query(
      `insert into sweeps (tx_hash, log_index, hesoyam_in, usdc_out, distributed, block_number)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (tx_hash, log_index) do nothing`,
      [
        e.txHash,
        e.logIndex,
        s(e.args.hesoyamIn),
        s(e.args.usdcOut),
        s(e.args.distributed),
        Number(e.blockNumber),
      ]
    );
  },

  // ------------------------------------------------------------ assets

  "StrainCard.CardMinted": async (db, e) => {
    await db.query(
      `insert into cards (token_id, owner, weight_bps, strain_id, rarity, block_number)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (token_id) do update set
         owner = excluded.owner, weight_bps = excluded.weight_bps,
         strain_id = excluded.strain_id, rarity = excluded.rarity`,
      [
        s(e.args.tokenId),
        addr(e.args.to),
        n(e.args.weightBps),
        n(e.args.strainId),
        n(e.args.rarity),
        Number(e.blockNumber),
      ]
    );
  },

  "GrowBench.BenchSold": async (db, e) => {
    await db.query(
      `insert into benches (token_id, owner, tranche_id, price, block_number)
       values ($1,$2,$3,$4,$5)
       on conflict (token_id) do update set owner = excluded.owner`,
      [
        s(e.args.tokenId),
        addr(e.args.buyer),
        s(e.args.trancheId),
        s(e.args.price),
        Number(e.blockNumber),
      ]
    );
  },

  "StrainRegistry.StrainAdded": async (db, e) => {
    await db.query(
      `insert into strains (strain_id, name, cycle_seconds, seed_price, block_number)
       values ($1,$2,$3,$4,$5)
       on conflict (strain_id) do update set
         name = excluded.name, cycle_seconds = excluded.cycle_seconds,
         seed_price = excluded.seed_price`,
      [
        n(e.args.strainId),
        String(e.args.name),
        n(e.args.cycleSeconds),
        s(e.args.seedPrice),
        Number(e.blockNumber),
      ]
    );
  },

  "StrainRegistry.StrainActiveSet": async (db, e) => {
    await db.query(`update strains set active = $2 where strain_id = $1`, [
      n(e.args.strainId),
      Boolean(e.args.active),
    ]);
  },

  // ------------------------------------------------------------ crafting

  "CardCrafter.CraftRequested": async (db, e) => {
    await db.query(
      `insert into crafts (request_id, player, strain_id, tier, reveal_block, requested_at)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (request_id) do nothing`,
      [
        s(e.args.requestId),
        addr(e.args.player),
        n(e.args.strainId),
        n(e.args.tier),
        Number(e.args.revealBlock),
        Number(e.blockNumber),
      ]
    );
  },

  "CardCrafter.CraftFinalized": async (db, e) => {
    await db.query(
      `update crafts set finalized = true, expired = $2, card_token_id = $3,
         rarity = $4, weight_bps = $5, finalized_at = $6
       where request_id = $1`,
      [
        s(e.args.requestId),
        Boolean(e.args.expired),
        s(e.args.tokenId),
        n(e.args.rarity),
        n(e.args.weightBps),
        Number(e.blockNumber),
      ]
    );
  },

  // ------------------------------------------------------------ ownership

  // A mint emits Transfer before the contract's own event, so the row does not exist
  // yet and this is a no op. Every later trade is what this actually catches, and
  // without it an owner column goes stale the first time a card changes hands.
  "StrainCard.Transfer": async (db, e) => {
    const to = addr(e.args.to);
    if (!to || to === ZERO) return;
    await db.query(`update cards set owner = $2 where token_id = $1`, [s(e.args.tokenId), to]);
  },

  "GrowBench.Transfer": async (db, e) => {
    const to = addr(e.args.to);
    if (!to || to === ZERO) return;
    await db.query(`update benches set owner = $2 where token_id = $1`, [s(e.args.tokenId), to]);
  },

  // ------------------------------------------------------------ dispensary state

  "Dispensary.Funded": async (db, e) => {
    await db.query(
      `insert into dispensary_epochs
         (tx_hash, log_index, amount, budget, epoch_start, block_number)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (tx_hash, log_index) do nothing`,
      [
        e.txHash,
        e.logIndex,
        s(e.args.amount),
        s(e.args.budget),
        ts(e.args.epochStart),
        Number(e.blockNumber),
      ]
    );
  },

  "Dispensary.ReferenceSet": async (db, e) => {
    await db.query(
      `insert into reference_prices
         (tx_hash, log_index, tier, price, block_number, block_time)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (tx_hash, log_index) do nothing`,
      [e.txHash, e.logIndex, n(e.args.tier), s(e.args.price), Number(e.blockNumber), e.blockTime]
    );
  },

  // ------------------------------------------------------------ tax

  "HesoyamToken.TaxTaken": async (db, e) => {
    await db.query(
      `insert into tax_events
         (tx_hash, log_index, from_addr, to_addr, platform_fee, protocol_fee,
          block_number, block_time)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (tx_hash, log_index) do nothing`,
      [
        e.txHash,
        e.logIndex,
        addr(e.args.from),
        addr(e.args.to),
        s(e.args.creatorFee),
        s(e.args.protocolFee),
        Number(e.blockNumber),
        e.blockTime,
      ]
    );
  },
};

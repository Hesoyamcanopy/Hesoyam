/**
 * Game maths, mirrored from Solidity.
 *
 * Every function here has a counterpart in GrowGame.sol and must agree with it
 * exactly. The client uses these to preview an outcome before a transaction, and a
 * disagreement means the interface promises a yield the contract will not pay.
 *
 * `test/parity.test.ts` runs both against a live chain and fails on any divergence.
 * If you change one side, change the other in the same commit.
 *
 * Integer division is deliberate throughout. TypeScript numbers would round where
 * Solidity truncates, so anything that touches a yield or a fee uses bigint.
 */

export const BPS = 10_000n;
export const FEED_WINDOWS = 3;
export const EVENT_SLOTS = 3;
export const CURE_SECONDS = 48 * 60 * 60;
export const CURE_QUALITY_BONUS = 12;
export const DAMAGE_PER_MISSED_EVENT_BPS = 1500n;
export const MAX_DAMAGE_BPS = 4500n;

export type Strain = {
  cycleSeconds: number;
  baseYield: number;
  geneticsBps: number;
  eventChance: number;
  geneQuality: number;
  seedPrice: bigint;
  active: boolean;
};

export type GrowState = {
  plantedAt: number;
  strainId: number;
  benchTier: number;
  eventSeed: `0x${string}`;
  feedMask: number;
  treatedMask: number;
  active: boolean;
};

export type Window = { opensAt: number; closesAt: number };

/** GrowGame.feedWindow. Centred at (2i+1)/7 of the cycle, one seventh wide. */
export function feedWindow(plantedAt: number, cycleSeconds: number, index: number): Window {
  const cycle = BigInt(cycleSeconds);
  const centre = BigInt(plantedAt) + (cycle * BigInt(2 * index + 1)) / 7n;
  const half = cycle / 14n;
  return { opensAt: Number(centre - half), closesAt: Number(centre + half) };
}

/** GrowGame.eventWindow. Fires at (2i+2)/7 of the cycle, response window one seventh. */
export function eventWindow(plantedAt: number, cycleSeconds: number, slot: number): Window {
  const cycle = BigInt(cycleSeconds);
  const at = BigInt(plantedAt) + (cycle * BigInt(2 * slot + 2)) / 7n;
  return { opensAt: Number(at), closesAt: Number(at + cycle / 7n) };
}

export function maturesAt(plantedAt: number, cycleSeconds: number): number {
  return plantedAt + cycleSeconds;
}

/** GrowGame.eventFires. Byte `slot` of the seed, compared against the strain threshold. */
export function eventFires(eventSeed: `0x${string}`, eventChance: number, slot: number): boolean {
  const seed = BigInt(eventSeed);
  const draw = Number((seed >> BigInt(8 * slot)) & 0xffn);
  return draw < eventChance;
}

/** GrowGame.firedMask. */
export function firedMask(eventSeed: `0x${string}`, eventChance: number): number {
  let mask = 0;
  for (let i = 0; i < EVENT_SLOTS; i++) {
    if (eventFires(eventSeed, eventChance, i)) mask |= 1 << i;
  }
  return mask;
}

function popcount3(mask: number): number {
  return (mask & 1 ? 1 : 0) + (mask & 2 ? 1 : 0) + (mask & 4 ? 1 : 0);
}

/**
 * GrowGame.careScore. Out of 100: feeding 40, environment 30, event response 30.
 *
 * A grow where nothing fired scores the full 30 for events. Punishing a player for
 * quiet luck would make the score a lottery rather than a measure of attention.
 */
export function careScore(
  grow: Pick<GrowState, "feedMask" | "treatedMask" | "benchTier">,
  eventSeed: `0x${string}`,
  eventChance: number
): { care: number; damageBps: bigint } {
  const feedPts = (BigInt(popcount3(grow.feedMask)) * 40n) / BigInt(FEED_WINDOWS);

  let envPts = BigInt(grow.benchTier) * 15n;
  if (envPts > 30n) envPts = 30n;

  const fires = firedMask(eventSeed, eventChance);
  const fired = BigInt(popcount3(fires));
  const handled = BigInt(popcount3(fires & grow.treatedMask));

  const eventPts = fired === 0n ? 30n : (handled * 30n) / fired;

  const total = feedPts + envPts + eventPts;
  const care = Number(total > 100n ? 100n : total);

  const dmg = (fired - handled) * DAMAGE_PER_MISSED_EVENT_BPS;
  const damageBps = dmg > MAX_DAMAGE_BPS ? MAX_DAMAGE_BPS : dmg;

  return { care, damageBps };
}

/**
 * GrowGame yield. Care moves the multiplier across a 0.55 to 1.00 band, which is the
 * 1.8x skill spread the economy is balanced around.
 */
export function yieldUnits(
  baseYield: number,
  geneticsBps: number,
  care: number,
  damageBps: bigint
): number {
  let y = (BigInt(baseYield) * BigInt(geneticsBps)) / BPS;
  y = (y * (5500n + (4500n * BigInt(care)) / 100n)) / BPS;
  y = (y * (BPS - damageBps)) / BPS;
  return Number(y);
}

/**
 * GrowGame quality. The roll is the only part the client cannot know in advance,
 * because it mixes in a block hash from the harvest block itself.
 */
export function quality(
  care: number,
  geneQuality: number,
  roll: bigint,
  damageBps: bigint
): number {
  let q = 20n + (BigInt(care) * 40n) / 100n + BigInt(geneQuality) + (roll % 21n);
  const penalty = damageBps / 500n;
  q = q > penalty ? q - penalty : 0n;
  if (q > 100n) q = 100n;
  return Number(q);
}

/** The range quality can land in, given everything that is knowable before harvest. */
export function qualityRange(
  care: number,
  geneQuality: number,
  damageBps: bigint
): { min: number; max: number } {
  return {
    min: quality(care, geneQuality, 0n, damageBps),
    max: quality(care, geneQuality, 20n, damageBps),
  };
}

/** GrowGame._mintFlower. */
export function tierForQuality(q: number): 0 | 1 | 2 {
  if (q >= 80) return 2;
  if (q >= 50) return 1;
  return 0;
}

export function applyCure(q: number): number {
  return Math.min(100, q + CURE_QUALITY_BONUS);
}

/** Total HESOYAM a cycle costs, before the harvest is sold. */
export function cycleCost(params: {
  seedPrice: bigint;
  nutrientFee: bigint;
  treatmentFee: bigint;
  utilityPerDay: bigint;
  cureFee: bigint;
  cycleSeconds: number;
  feeds: number;
  treatments: number;
  curing: boolean;
}): bigint {
  const utilities = (params.utilityPerDay * BigInt(params.cycleSeconds)) / 86400n;
  return (
    params.seedPrice +
    params.nutrientFee * BigInt(params.feeds) +
    params.treatmentFee * BigInt(params.treatments) +
    utilities +
    (params.curing ? params.cureFee : 0n)
  );
}

// ---------------------------------------------------------------- staking

/** StakingVault weight. Base is amount times the tier, then the capped card bonus. */
export function stakeWeight(amount: bigint, tierMultBps: number, cardBonusBps: number): bigint {
  const base = (amount * BigInt(tierMultBps)) / BPS;
  return (base * (BPS + BigInt(cardBonusBps))) / BPS;
}

export const MAX_CARD_BONUS_BPS = 4200;
export const EARLY_EXIT_PENALTY_BPS = 400n;

export function earlyExitPenalty(amount: bigint, unlockAt: number, now: number): bigint {
  if (now >= unlockAt) return 0n;
  return (amount * EARLY_EXIT_PENALTY_BPS) / BPS;
}

// ---------------------------------------------------------------- dispensary

export const DISPENSARY_CEIL_BPS = 11_500n;
export const DISPENSARY_FLOOR_BPS = 6_000n;

/** Dispensary.currentPrice. Linear decay from the ceiling to the floor. */
export function dispensaryPrice(
  referencePrice: bigint,
  epochStart: number,
  now: number,
  auctionDuration: number
): bigint {
  if (referencePrice === 0n) return 0n;
  const elapsed = BigInt(Math.max(0, now - epochStart));
  const duration = BigInt(auctionDuration);
  const bps =
    elapsed >= duration
      ? DISPENSARY_FLOOR_BPS
      : DISPENSARY_CEIL_BPS - ((DISPENSARY_CEIL_BPS - DISPENSARY_FLOOR_BPS) * elapsed) / duration;
  return (referencePrice * bps) / BPS;
}

// ---------------------------------------------------------------- presentation

export type GrowPhase = "growing" | "ready" | "finished";

export function growPhase(grow: GrowState, cycleSeconds: number, now: number): GrowPhase {
  if (!grow.active) return "finished";
  return now >= maturesAt(grow.plantedAt, cycleSeconds) ? "ready" : "growing";
}

/** 0 to 1 across the cycle, for a progress track. */
export function growProgress(plantedAt: number, cycleSeconds: number, now: number): number {
  if (cycleSeconds <= 0) return 0;
  const p = (now - plantedAt) / cycleSeconds;
  return Math.min(1, Math.max(0, p));
}

export type ActionPrompt =
  | { kind: "feed"; index: number; opensAt: number; closesAt: number }
  | { kind: "treat"; slot: number; opensAt: number; closesAt: number }
  | { kind: "harvest"; at: number };

/**
 * What the player should do next, and when. Drives both the notification scheduler
 * and the prompt in the grow room.
 */
export function nextActions(
  grow: GrowState,
  strain: Strain,
  now: number
): ActionPrompt[] {
  if (!grow.active) return [];
  const out: ActionPrompt[] = [];

  for (let i = 0; i < FEED_WINDOWS; i++) {
    if (grow.feedMask & (1 << i)) continue;
    const w = feedWindow(grow.plantedAt, strain.cycleSeconds, i);
    if (now <= w.closesAt) out.push({ kind: "feed", index: i, ...w });
  }

  const fires = firedMask(grow.eventSeed, strain.eventChance);
  for (let slot = 0; slot < EVENT_SLOTS; slot++) {
    if (!(fires & (1 << slot))) continue;
    if (grow.treatedMask & (1 << slot)) continue;
    const w = eventWindow(grow.plantedAt, strain.cycleSeconds, slot);
    if (now <= w.closesAt) out.push({ kind: "treat", slot, ...w });
  }

  const ready = maturesAt(grow.plantedAt, strain.cycleSeconds);
  out.push({ kind: "harvest", at: ready });

  return out.sort((a, b) => ("at" in a ? a.at : a.opensAt) - ("at" in b ? b.at : b.opensAt));
}

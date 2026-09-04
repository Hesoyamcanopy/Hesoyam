import { formatUnits } from "viem";

/**
 * Number formatting.
 *
 * Every amount that comes off chain is a bigint. Converting to a JavaScript number
 * before formatting loses precision above 2^53, so everything here works from the
 * bigint and only produces a string at the very end.
 */

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export function hesoyam(value: bigint | undefined, decimals = 2): string {
  if (value === undefined) return "–";
  const s = formatUnits(value, 18);
  const n = Number(s);
  if (Number.isFinite(n) && Math.abs(n) >= 1_000_000) return compact.format(n);
  return n.toLocaleString("en-US", { maximumFractionDigits: decimals });
}

export function usdc(value: bigint | undefined, decimals = 2): string {
  if (value === undefined) return "–";
  const n = Number(formatUnits(value, 6));
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function money(value: bigint | undefined): string {
  return value === undefined ? "–" : `$${usdc(value)}`;
}

export function units(value: bigint | number | undefined): string {
  if (value === undefined) return "–";
  return Number(value).toLocaleString("en-US");
}

export function pct(value: number, decimals = 1): string {
  return `${value.toFixed(decimals)}%`;
}

export function bpsToX(bps: number | bigint): string {
  return `${(Number(bps) / 10_000).toFixed(2)}x`;
}

export function shortAddress(address?: string): string {
  if (!address) return "–";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function shortHash(hash?: string): string {
  if (!hash) return "–";
  return `${hash.slice(0, 10)}…`;
}

/** Human duration for a countdown. Always rounds down, never shows a negative. */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function timeUntil(timestamp: number, now: number): string {
  return timestamp <= now ? "now" : duration(timestamp - now);
}

export function dateOf(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

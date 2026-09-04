/**
 * When mainnet goes live.
 *
 * One constant, imported by both the countdown and the copy around it, so the
 * date can never say one thing in a heading and another in the digits.
 *
 * Change this single line to move the date. It is an explicit UTC instant rather
 * than an offset from "now", because an offset would restart the countdown for
 * every visitor and mean nothing.
 */
export const MAINNET_LAUNCH_ISO = "2026-09-08T16:00:00Z";

export const MAINNET_LAUNCH_MS = Date.parse(MAINNET_LAUNCH_ISO);

export type Remaining = {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  /** True once the launch instant has passed. */
  passed: boolean;
};

/**
 * Splits the time left into display parts.
 *
 * Clamps at zero rather than counting negative, so a launch that slips shows a
 * held zero and the "live" copy instead of a countdown running backwards.
 */
export function remainingUntil(nowMs: number, targetMs: number = MAINNET_LAUNCH_MS): Remaining {
  const delta = targetMs - nowMs;
  if (delta <= 0) return { days: 0, hours: 0, minutes: 0, seconds: 0, passed: true };

  const totalSeconds = Math.floor(delta / 1000);
  return {
    days: Math.floor(totalSeconds / 86_400),
    hours: Math.floor((totalSeconds % 86_400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
    passed: false,
  };
}

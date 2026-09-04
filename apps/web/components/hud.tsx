import type { ReactNode } from "react";

/**
 * The corner HUD.
 *
 * The form is the homage: a money counter in the display face, two meters under
 * it, and a star rating alongside. The labels are not. Each meter says what it
 * actually reads from the chain and prints the real value beside the bar, so the
 * styling never implies a stat the protocol does not have.
 */

const STAR = "M12 2.2l2.9 6.2 6.6.9-4.8 4.7 1.2 6.8L12 17.6 6.1 20.8l1.2-6.8L2.5 9.3l6.6-.9z";

export function Stars({ value, max = 5, label }: { value: number; max?: number; label: string }) {
  const filled = Math.max(0, Math.min(max, Math.floor(value)));
  return (
    <div className="hud-stars" role="img" aria-label={`${label}: ${filled} of ${max}`}>
      {Array.from({ length: max }, (_, i) => (
        <svg
          key={i}
          className={`hud-star ${i < filled ? "hud-star-on" : "hud-star-off"}`}
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path d={STAR} fill="currentColor" />
        </svg>
      ))}
    </div>
  );
}

export function Meter({
  label,
  pct,
  value,
  tone = "health",
}: {
  label: string;
  /** 0 to 100. Clamped, because a contract can always return more than expected. */
  pct: number;
  value: ReactNode;
  tone?: "health" | "armor";
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="hud-meter">
      <span className="hud-meter-label">{label}</span>
      <span
        className="hud-track"
        role="img"
        aria-label={`${label}: ${clamped.toFixed(1)} percent`}
      >
        <span className={`hud-fill hud-fill-${tone}`} style={{ width: `${clamped}%` }} />
      </span>
      <span className="hud-meter-v">{value}</span>
    </div>
  );
}

export function Hud({
  cash,
  unit = "HESOYAM",
  children,
  stars,
}: {
  cash: ReactNode;
  unit?: string;
  children: ReactNode;
  stars?: { value: number; max?: number; label: string };
}) {
  return (
    <div className="hud">
      <div>
        <div className="hud-cash">
          {cash}
          <span className="hud-cash-unit">{unit}</span>
        </div>
        {stars ? (
          <div style={{ marginTop: 10 }}>
            <Stars value={stars.value} max={stars.max} label={stars.label} />
          </div>
        ) : null}
      </div>
      <div className="hud-meters">{children}</div>
    </div>
  );
}

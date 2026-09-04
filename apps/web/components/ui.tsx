"use client";

import type { ReactNode } from "react";

export function Panel({
  title,
  subtitle,
  actions,
  children,
  quiet,
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  quiet?: boolean;
}) {
  return (
    <section className={`panel${quiet ? " panel-quiet" : ""}`}>
      {title ? (
        <header className="panel-head">
          <div>
            <h3>{title}</h3>
            {subtitle ? <p className="panel-sub">{subtitle}</p> : null}
          </div>
          {actions ? <div className="panel-actions">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="stat-grid">{children}</div>;
}

export function Stat({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: "cash" | "amber" | "gold" | "plain";
}) {
  return (
    <div className="stat-cell">
      <span className="stat-cell-k">{label}</span>
      <span className={`stat-cell-v${tone && tone !== "plain" ? ` tone-${tone}` : ""}`}>{value}</span>
      {note ? <span className="stat-cell-n">{note}</span> : null}
    </div>
  );
}

export function Row({ label, value, tone }: { label: ReactNode; value: ReactNode; tone?: "cash" | "amber" | "gold" }) {
  return (
    <div className="kv-row">
      <span className="kv-k">{label}</span>
      <span className={`kv-v${tone ? ` tone-${tone}` : ""}`}>{value}</span>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children ? <div className="empty-body">{children}</div> : null}
    </div>
  );
}

export function Pill({ children, tone = "plain" }: { children: ReactNode; tone?: "cash" | "amber" | "gold" | "armor" | "red" | "plain" }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function Track({ value, tone = "cash" }: { value: number; tone?: "cash" | "amber" | "gold" }) {
  const pctValue = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className="track" role="img" aria-label={`${pctValue} percent`}>
      <div className={`track-fill track-${tone}`} style={{ width: `${pctValue}%` }} />
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Warning({ children }: { children: ReactNode }) {
  return <div className="warning">{children}</div>;
}

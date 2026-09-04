export default function NotFound() {
  return (
    <main className="wrap" style={{ paddingTop: 160, paddingBottom: 160, maxWidth: 640 }}>
      <p className="eyebrow">404</p>
      <h1 style={{ fontSize: 40, letterSpacing: "-0.03em", lineHeight: 1.08, margin: "16px 0 0" }}>
        Nothing is growing here.
      </h1>
      <p style={{ color: "var(--ink-2)", marginTop: 16, fontSize: 16.5, lineHeight: 1.6 }}>
        That address does not exist. It may have been a bench that was harvested, or a
        link that was never real.
      </p>
      <div style={{ display: "flex", gap: 12, marginTop: 28, flexWrap: "wrap" }}>
        <a className="btn btn-primary" href="/">
          Back to the start
        </a>
      </div>
    </main>
  );
}

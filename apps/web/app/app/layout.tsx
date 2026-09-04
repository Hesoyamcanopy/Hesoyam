import Link from "next/link";
import type { Metadata } from "next";
import { ConnectButton } from "../../components/connect";
import { BrandMark } from "../nav";
import { AppNav } from "./app-nav";

export const metadata: Metadata = {
  title: "HESOYAM CANOPY",
  description: "Grow, trade and stake.",
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <header className="app-bar">
        <div className="app-bar-inner">
          <Link href="/" className="brand" aria-label="HESOYAM CANOPY home">
            <BrandMark />
            <span className="brand-name">
              <b>Hesoyam</b>
              <i>Canopy</i>
            </span>
          </Link>
          <AppNav />
          <div className="app-bar-actions">
            <ConnectButton />
          </div>
        </div>
      </header>

      <div className="risk-strip">
        <span className="risk-tag">Variable</span>
        <span>
          Rewards are a share of fees that were actually collected. They are not a rate,
          they are not guaranteed, and they can be zero.
        </span>
      </div>

      <main className="app-main">{children}</main>
    </div>
  );
}

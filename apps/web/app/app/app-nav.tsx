"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/app", label: "Overview" },
  { href: "/app/grow", label: "Grow room" },
  { href: "/app/plots", label: "Plots" },
  { href: "/app/craft", label: "Crafting" },
  { href: "/app/market", label: "Market" },
  { href: "/app/dispensary", label: "Dispensary" },
  { href: "/app/stake", label: "Stake" },
  { href: "/app/treasury", label: "Treasury" },
];

export function AppNav() {
  const pathname = usePathname();
  return (
    <nav className="app-nav" aria-label="Application">
      {LINKS.map((l) => {
        const active = l.href === "/app" ? pathname === "/app" : pathname.startsWith(l.href);
        return (
          <Link key={l.href} href={l.href} className={`app-nav-link${active ? " is-active" : ""}`}>
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}

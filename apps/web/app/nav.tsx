"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import logo from "../public/logo.jpg";

const LINKS = [
  { href: "#how", label: "How it works" },
  { href: "#cycle", label: "Grow cycle" },
  { href: "#rails", label: "Economy" },
  { href: "#faq", label: "FAQ" },
];

/**
 * The mark, used in the landing nav, the landing footer and the app bar.
 *
 * Drawn a little larger than the old inline glyph it replaces, because the
 * artwork is a full HUD panel rather than a single silhouette and it stops
 * reading below about thirty pixels. Rendered with `image-rendering: pixelated`
 * so the pixel art stays hard edged instead of being smoothed into mush by the
 * browser's default downscale.
 */
export function BrandMark() {
  return (
    <Image
      className="brand-mark"
      src={logo}
      alt=""
      width={32}
      height={32}
      priority
      aria-hidden="true"
    />
  );
}

export default function Nav() {
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className="nav" data-stuck={stuck}>
      <div className="nav-inner">
        <a href="#top" className="brand" aria-label="HESOYAM CANOPY home">
          <BrandMark />
          <span className="brand-name">
            <b>Hesoyam</b>
            <i>Canopy</i>
          </span>
        </a>

        <nav className="nav-links" aria-label="Main">
          {LINKS.map((l) => (
            <a key={l.href} href={l.href}>
              {l.label}
            </a>
          ))}
        </nav>

        <div className="nav-actions">
          <a className="quiet" href="/hesoyam-canopy-whitepaper.pdf" target="_blank" rel="noreferrer">
            Whitepaper
          </a>
          <a className="btn btn-primary btn-sm" href="/app">
            Launch app
          </a>
        </div>
      </div>
    </header>
  );
}

import type { Metadata } from "next";
import "./globals.css";
import "./app.css";
import { Providers } from "../components/providers";

export const metadata: Metadata = {
  title: "HESOYAM CANOPY",
  description:
    "An on-chain grow game named after a cheat code, built so the payout is funded rather than printed. Every reward is paid for by a trade somebody made, never by a new deposit and never by minting.",
  openGraph: {
    title: "HESOYAM CANOPY",
    description:
      "A cheat code, except somebody paid for it. An on-chain grow economy where every reward is funded by realized fees.",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Anton&family=Archivo:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&family=Oswald:wght@400;500;600&display=swap"
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

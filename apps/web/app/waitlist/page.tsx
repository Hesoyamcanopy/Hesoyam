import type { Metadata } from "next";
import Nav from "../nav";
import { LaunchCountdown, WaitlistForm } from "../../components/waitlist";

export const metadata: Metadata = {
  title: "Mainnet waitlist | HESOYAM CANOPY",
  description:
    "Put your wallet on the list before HESOYAM CANOPY goes live on Robinhood Chain mainnet. The testnet is playable right now.",
  openGraph: {
    title: "HESOYAM CANOPY mainnet waitlist",
    description: "The clock is running. Get your wallet on the list.",
    type: "website",
  },
};

const WHAT_HAPPENS = [
  {
    k: "Now",
    v: "Testnet is open",
    body:
      "Everything works today on Robinhood Chain testnet, with a faucet built into the app. No allowlist, no permission, nothing to wait for.",
  },
  {
    k: "At launch",
    v: "Mainnet opens on Pons",
    body:
      "The same fourteen contracts, the same mechanics, real money. The list gets told first, before anything is posted anywhere else.",
  },
  {
    k: "Always",
    v: "Fees fund the rewards",
    body:
      "Nothing is minted to pay anybody. When trading is quiet the pool is quiet, and the app says so instead of printing a number.",
  },
];

export default function Waitlist() {
  return (
    <>
      <Nav />
      <main className="waitlist-page" id="top">
        <div className="wrap waitlist-wrap">
          <header className="waitlist-head">
            <p className="eyebrow">Mainnet launch</p>
            <h1 className="waitlist-title">The clock is running</h1>
            <p className="lead">
              HESOYAM CANOPY goes live on Robinhood Chain mainnet through Pons. Put your
              wallet on the list and you hear about it first.
            </p>
          </header>

          <LaunchCountdown />

          <section className="waitlist-card" aria-labelledby="join">
            <h2 className="waitlist-card-title" id="join">
              Get on the list
            </h2>
            <p className="waitlist-card-sub">
              One address, once. No email, no signature, no wallet permissions requested.
            </p>
            <WaitlistForm />
            <p className="waitlist-fine">
              Adding an address here is a mailing list entry, not a claim on anything.
              Whatever launch day grants is decided on chain, and your wallet signs for
              itself when that happens.
            </p>
          </section>

          <section className="waitlist-what" aria-label="What happens next">
            {WHAT_HAPPENS.map((row) => (
              <article className="waitlist-what-item" key={row.k}>
                <span className="waitlist-what-k">{row.k}</span>
                <h3 className="waitlist-what-v">{row.v}</h3>
                <p className="waitlist-what-body">{row.body}</p>
              </article>
            ))}
          </section>

          <footer className="waitlist-foot">
            <p>
              Do not want to wait? The whole game is playable on testnet right now, with
              free test tokens from the faucet on the overview page.
            </p>
            <a className="btn btn-primary" href="/app">
              Play the testnet
            </a>
          </footer>
        </div>
      </main>
    </>
  );
}

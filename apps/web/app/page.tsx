import Image from "next/image";
import Nav, { BrandMark } from "./nav";
import cover from "../public/cover.jpg";
import { Hud, Meter } from "../components/hud";

const STATS = [
  { v: "14", k: "contracts shipped and tested" },
  { v: "131", k: "contract tests passing" },
  { v: "0", k: "tokens minted to pay rewards" },
  { v: "10", k: "revenue lines feeding one pool" },
];

const STEPS = [
  {
    n: "01",
    title: "People trade and play",
    body: "Every buy, sell, seed, nutrient dose, listing, craft and day of rent charges a fee. None of it is optional and none of it is a deposit. It is the cost of doing the thing you came to do.",
    figure: ["Transfer tax", "5.0%"],
  },
  {
    n: "02",
    title: "One contract collects it",
    body: "All ten revenue lines land in a single router. There is no treasury wallet in the middle and no discretion about where the money goes, because the split is written into the contract.",
    figure: ["To the flywheel", "1.0% of volume"],
  },
  {
    n: "03",
    title: "The pool pays both sides",
    body: "Half buys tokenized stock for stakers. Just over a quarter funds the bid that buys harvests from growers. The rest deepens liquidity, runs the thing and covers failures.",
    figure: ["To players", "78% of revenue"],
  },
];

const HONESTY = [
  {
    title: "No fixed APY, ever",
    body: "The number you see is trailing arithmetic on fees that were actually collected. It moves every block and we will never print a rate on a banner.",
  },
  {
    title: "New deposits fund nothing",
    body: "There is no function anywhere that moves staked principal into the reward vault. Not restricted, not guarded. It does not exist.",
  },
  {
    title: "No emissions",
    body: "Supply is fixed at launch and the mint path was never written. Rewards are stock and stablecoin the treasury bought with money it earned.",
  },
  {
    title: "No downline, no matrix",
    body: "Referral pay is one level deep, capped at five basis points of revenue, and comes out of the protocol's own slice rather than the person you invited.",
  },
];

const FAQS = [
  {
    q: "Where do rewards actually come from?",
    a: [
      "Fees. The transfer tax on the token, bench sales, seeds, nutrients, treatments, utilities, curing, the marketplace take, the craft fee, and land rent. Ten lines, all of them somebody paying for something they wanted.",
      "Every reward credited on chain references the purchase transaction that funded it, so you can click through from a payout to the buy that paid for it.",
    ],
  },
  {
    q: "What happens if trading volume drops to zero?",
    a: [
      "Rewards drop to zero. Not negative, not a collapse, just zero, because nobody's principal was ever the source. Your stake is still yours and still withdrawable, and the game still runs.",
      "That is the whole point of building it this way. A quiet month is boring rather than fatal.",
    ],
  },
  {
    q: "Do I have to farm to earn?",
    a: [
      "No. You can stake and never plant anything. But growers and stakers are connected on purpose: burning harvested Flower is the only way to create a Strain Card, and a card raises your share of the reward pool.",
      "So a staker who never grows still wants Flower, and buys it from someone who did.",
    ],
  },
  {
    q: "Is the game profitable for the average player?",
    a: [
      "In aggregate, players pay more into the game than the game pays out. It is a rake, and we would rather say so than let you find out later.",
      "Upside comes from being better than average, which is worth about 1.8x on yield, from owning scarce things like benches and licences that other people pay to use, and from staking what you earn.",
    ],
  },
  {
    q: "What do I need to start?",
    a: [
      "A wallet and some HESOYAM. Every action is a normal transaction you sign, so nothing moves without your signature.",
      "You can also walk the grow room without connecting anything, to see what is there before you commit to it.",
    ],
  },
];

function CycleFigure() {
  const day = (d: number) => 60 + (d * 800) / 9;
  return (
    <svg viewBox="0 0 920 190" role="img" aria-label="A seven day grow cycle: plant on day zero, feeding windows on days one, three and five, a pest risk window from day two to day six, harvest on day seven, and an optional two day cure before sale on day nine.">
      <rect x={day(1) - 26} y="52" width="52" height="34" rx="3" fill="#5fbf4a" opacity="0.09" />
      <rect x={day(3) - 26} y="52" width="52" height="34" rx="3" fill="#5fbf4a" opacity="0.09" />
      <rect x={day(5) - 26} y="52" width="52" height="34" rx="3" fill="#5fbf4a" opacity="0.09" />

      <rect x={day(2)} y="46" width={day(6) - day(2)} height="46" rx="3" fill="none" stroke="#e0913a" strokeWidth="1" strokeDasharray="4 4" opacity="0.7" />
      <text x={(day(2) + day(6)) / 2} y="36" textAnchor="middle" fontFamily="'IBM Plex Mono', monospace" fontSize="11" fill="#e0913a">
        pest risk window
      </text>

      <line x1="40" y1="69" x2="880" y2="69" stroke="#414d2e" strokeWidth="1.5" />
      <line x1="40" y1="69" x2={day(7)} y2="69" stroke="#5fbf4a" strokeWidth="1.5" />

      {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
        <line key={d} x1={day(d)} y1="63" x2={day(d)} y2="75" stroke="#414d2e" strokeWidth="1" />
      ))}

      {[
        { d: 0, label: "plant", accent: true },
        { d: 1, label: "feed" },
        { d: 3, label: "feed" },
        { d: 5, label: "feed" },
        { d: 7, label: "harvest", accent: true },
        { d: 9, label: "sell" },
      ].map((m) => (
        <g key={`${m.d}-${m.label}`}>
          <line x1={day(m.d)} y1="59" x2={day(m.d)} y2="79" stroke={m.accent ? "#5fbf4a" : "#f4f1e0"} strokeWidth={m.accent ? 2.5 : 1.6} />
          <text x={day(m.d)} y="104" textAnchor="middle" fontFamily="'IBM Plex Mono', monospace" fontSize="12" fill={m.accent ? "#5fbf4a" : "#f4f1e0"}>
            {m.label}
          </text>
        </g>
      ))}

      <line x1={day(7)} y1="69" x2={day(9)} y2="69" stroke="#f4f1e0" strokeWidth="1.5" strokeDasharray="3 3" opacity="0.55" />
      <text x={(day(7) + day(9)) / 2} y="52" textAnchor="middle" fontFamily="'IBM Plex Mono', monospace" fontSize="11" fill="#b9b89a">
        cure, plus 12 quality
      </text>

      {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
        <text key={`d${d}`} x={day(d)} y="126" textAnchor="middle" fontFamily="'IBM Plex Mono', monospace" fontSize="10.5" fill="#83866a">
          d{d}
        </text>
      ))}

      <line x1="40" y1="150" x2="880" y2="150" stroke="#2c3520" strokeWidth="1" />
      <text x="40" y="172" fontFamily="'IBM Plex Mono', monospace" fontSize="11" fill="#83866a">
        care score 100 pays full yield
      </text>
      <text x="880" y="172" textAnchor="end" fontFamily="'IBM Plex Mono', monospace" fontSize="11" fill="#83866a">
        care score 0 pays 55 percent
      </text>
    </svg>
  );
}

export default function Home() {
  return (
    <>
      <Nav />

      <main id="top">
        {/*
          The cover art carries the name itself, so it sits above the hero as a
          masthead rather than behind the headline where the two sets of type
          would fight. Priority loaded because it is the first thing on screen.
        */}
        <section className="cover" aria-label="HESOYAM CANOPY">
          <Image src={cover} alt="HESOYAM CANOPY" priority sizes="100vw" />
        </section>

        {/* hero */}
        <section className="hero">
          <div className="wrap hero-grid">
            <div>
              <p className="eyebrow">On-chain grow economy</p>
              <h1>
                A cheat code, except <em>somebody paid for it</em>.
              </h1>
              <p className="lead">
                The code it is named after handed you health, armor and cash for nothing. This one
                cannot. Plant, cure and sell on chain, and every fee the protocol collects buys
                tokenized stock for stakers and funds the bid that buys your harvest. Nothing is
                minted, and no deposit ever funds anyone else&rsquo;s payout.
              </p>
              <div className="hero-cta">
                <a className="btn btn-primary" href="/app/grow">
                  Enter the grow room
                </a>
                <a className="btn btn-ghost" href="#how">
                  See where the money goes
                </a>
              </div>

              <div className="stats">
                {STATS.map((s) => (
                  <div className="stat" key={s.k}>
                    <span className="stat-v">{s.v}</span>
                    <span className="stat-k">{s.k}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="hero-right">
              <div className="panel hud-panel">
                <Hud cash="1,240,000" stars={{ value: 3, max: 5, label: "Strain cards equipped" }}>
                  <Meter label="Pool" pct={6.4} value="6.40% of pool weight" tone="health" />
                  <Meter label="Cards" pct={70} value="2940 of 4200 bps" tone="armor" />
                </Hud>
                <p className="hud-caption">Example readout. In the app every value here is read from a contract.</p>
              </div>

              <div className="bench">
              <div className="bench-head">
                <span className="bench-id">Bench 04</span>
                <span className="bench-live">
                  <span aria-hidden="true" />
                  Growing
                </span>
              </div>
              <div className="bench-body">
                <h2 className="bench-strain">Northern Lights</h2>
                <p className="bench-sub">Canopy tier bench, 7 day cycle</p>

                <div className="track" role="img" aria-label="Day 5 of a 7 day cycle, 71 percent complete">
                  <div className="track-fill" style={{ width: "71%" }} />
                </div>
                <div className="track-legend">
                  <span>day 5 of 7</span>
                  <span>harvest in 48h</span>
                </div>

                <div className="bench-rows">
                  <div className="bench-row">
                    <span className="k">Care score</span>
                    <span className="v hi">92 / 100</span>
                  </div>
                  <div className="bench-row">
                    <span className="k">Feed windows</span>
                    <span className="marks" role="img" aria-label="Two of three feed windows completed">
                      <span className="mark on" />
                      <span className="mark on" />
                      <span className="mark" />
                    </span>
                  </div>
                  <div className="bench-row">
                    <span className="k">Next event</span>
                    <span className="v warn">Spider mites, 14h</span>
                  </div>
                  <div className="bench-row">
                    <span className="k">Projected</span>
                    <span className="v">96 units, quality 81</span>
                  </div>
                </div>
              </div>
              <div className="bench-foot">
                <span>Fees paid this cycle</span>
                <span>
                  <b>260 HESOYAM</b> to revenue
                </span>
              </div>
              </div>
            </div>
          </div>
        </section>

        {/* how it works */}
        <section className="section" id="how">
          <div className="wrap">
            <div className="section-head">
              <p className="eyebrow eyebrow-quiet">How the money moves</p>
              <h2>Three steps, and no step where value appears from nowhere.</h2>
              <p>
                Most reward systems break at the second step, where the money is supposed to come
                from and quietly does not. Here it comes from people transacting, which means it is
                bounded, auditable, and honestly capable of reaching zero.
              </p>
            </div>
            <div className="steps">
              {STEPS.map((s) => (
                <article className="step" key={s.n}>
                  <span className="step-n">{s.n}</span>
                  <h3>{s.title}</h3>
                  <p>{s.body}</p>
                  <div className="figure">
                    {s.figure[0]} <b>{s.figure[1]}</b>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* grow cycle */}
        <section className="section" id="cycle">
          <div className="wrap">
            <div className="section-head">
              <p className="eyebrow eyebrow-quiet">The grow cycle</p>
              <h2>Seven days, three feeding windows, and a plant that notices whether you showed up.</h2>
              <p>
                Growth is a pure function of time and the care you actually gave. Miss a window and
                the plant stalls. Ignore a pest event and you lose yield. Attention is worth about
                1.8x, which is wide enough to matter and narrow enough that sleeping is allowed.
              </p>
            </div>

            <div className="cycle-figure">
              <CycleFigure />
            </div>

            <div className="cycle-notes">
              <div className="cycle-note">
                <h4>Feeding</h4>
                <p>
                  Three windows, each a day wide. Hitting all three is 40 of your 100 care points,
                  and you can delegate them to a hired player if you will be away.
                </p>
              </div>
              <div className="cycle-note">
                <h4>Events</h4>
                <p>
                  Mites, mould, heat. Your schedule is fixed at planting and visible from the
                  moment you plant, so responding is a decision rather than a coin flip.
                </p>
              </div>
              <div className="cycle-note">
                <h4>Curing</h4>
                <p>
                  Two extra days for up to 12 quality points. Quality decides which tier your
                  harvest lands in, and premium tiers craft better cards.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* rails */}
        <section className="section" id="rails">
          <div className="wrap">
            <div className="section-head">
              <p className="eyebrow eyebrow-quiet">Two ways in</p>
              <h2>One pool of revenue, two rails drinking from it.</h2>
              <p>
                Stakers hold and get paid in tokenized stock. Growers play and get paid when the
                protocol buys their harvest. The split between the two is the main economic lever,
                and changing it takes a 48 hour timelock.
              </p>
            </div>

            <div className="rails">
              <div className="rail-card armor">
                <span className="rail-share">50%</span>
                <h3>Stake HESOYAM, earn stock</h3>
                <p>
                  Lock for longer and your weight goes up. Strain Cards raise it further, capped at
                  1.42x per wallet so the leaderboard cannot simply be bought.
                </p>
                <ul className="rail-list">
                  <li>
                    <span>Seedling, 1 hour</span>
                    <span className="n">1.0x</span>
                  </li>
                  <li>
                    <span>Vegetative, 30 days</span>
                    <span className="n">1.3x</span>
                  </li>
                  <li>
                    <span>Flowering, 60 days</span>
                    <span className="n">1.8x</span>
                  </li>
                  <li>
                    <span>Canopy, 90 days</span>
                    <span className="n">2.5x</span>
                  </li>
                </ul>
              </div>

              <div className="rail-card amber">
                <span className="rail-share">28%</span>
                <h3>Grow, cure, sell</h3>
                <p>
                  Sell to another player at your price, or into the Dispensary bid, which opens
                  above market and falls across the day until the budget is spent.
                </p>
                <ul className="rail-list">
                  <li>
                    <span>Opening bid</span>
                    <span className="n">115% of market</span>
                  </li>
                  <li>
                    <span>Floor after 24h</span>
                    <span className="n">60% of market</span>
                  </li>
                  <li>
                    <span>Marketplace take</span>
                    <span className="n">4.0%</span>
                  </li>
                  <li>
                    <span>Guaranteed floor</span>
                    <span className="n">none</span>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* honesty */}
        <section className="section" id="honesty">
          <div className="wrap">
            <div className="section-head">
              <p className="eyebrow eyebrow-quiet">Read this part twice</p>
              <h2>What the code does not do.</h2>
              <p>
                These are properties of the code, not promises in a document. Each one is a named
                test in the repository, and the invariants page in the app reads them live from the
                contracts rather than restating them.
              </p>
            </div>
            <div className="honesty">
              {HONESTY.map((h) => (
                <div className="honest-item" key={h.title}>
                  <span className="x" aria-hidden="true">
                    &times;
                  </span>
                  <div>
                    <h4>{h.title}</h4>
                    <p>{h.body}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* faq */}
        <section className="section" id="faq">
          <div className="wrap">
            <div className="section-head">
              <p className="eyebrow eyebrow-quiet">Questions</p>
              <h2>The ones worth asking before you put money in.</h2>
            </div>
            <div className="faq">
              {FAQS.map((f, i) => (
                <details key={f.q} open={i === 0}>
                  <summary>{f.q}</summary>
                  <div className="answer">
                    {f.a.map((para) => (
                      <p key={para}>{para}</p>
                    ))}
                  </div>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* cta */}
        <section className="cta" id="cta">
          <div className="wrap">
            <div className="cta-inner">
              <div>
                <p className="eyebrow">Testnet first</p>
                <h2>The grow room opens on testnet before it opens on mainnet.</h2>
                <p>
                  Every number in the economy is a guess until real players push volume through it.
                  Come break it while the money is fake, and help set the numbers that ship.
                </p>
              </div>
              <div className="cta-actions">
                <a className="btn btn-primary" href="/app">
                  Open the app
                </a>
                <a className="btn btn-ghost" href="/hesoyam-canopy-whitepaper.pdf" target="_blank" rel="noreferrer">
                  Read the whitepaper
                </a>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* footer */}
      <footer className="footer" id="whitepaper">
        <div className="wrap">
          <div className="footer-grid">
            <div className="footer-brand">
              <a href="#top" className="brand" aria-label="HESOYAM CANOPY home">
                <BrandMark />
                <span className="brand-name">
                  <b>Hesoyam</b>
                  <i>Canopy</i>
                </span>
              </a>
              <p>
                An on-chain grow economy where rewards are funded by realized revenue and every
                payout traces to the purchase that paid for it.
              </p>
            </div>

            <div className="footer-col">
              <h5>Product</h5>
              <ul>
                <li><a href="#cycle">Grow room</a></li>
                <li><a href="#rails">Marketplace</a></li>
                <li><a href="#rails">Dispensary</a></li>
                <li><a href="#rails">Staking</a></li>
              </ul>
            </div>

            <div className="footer-col">
              <h5>Protocol</h5>
              <ul>
                <li><a href="#how">Blueprint</a></li>
                <li><a href="#cycle">Grow loop</a></li>
                <li><a href="#honesty">Invariants</a></li>
                <li><a href="/hesoyam-canopy-whitepaper.pdf" target="_blank" rel="noreferrer">Whitepaper</a></li>
              </ul>
            </div>

            <div className="footer-col">
              <h5>Legal</h5>
              <ul>
                <li><a href="#whitepaper">Risk disclosure</a></li>
                <li><a href="#whitepaper">Terms</a></li>
                <li><a href="#whitepaper">Privacy</a></li>
              </ul>
            </div>
          </div>

          <div className="footer-bottom">
            <p className="footer-legal">
              Rewards are a variable share of trading and gameplay fees. They are not a yield, not
              a rate, and not guaranteed. Staked value can fall, locked positions cannot be exited
              without a penalty, and the honest floor for a fee funded reward is zero. Nothing here
              is financial advice. Availability depends on where you live.
            </p>
            <span className="footer-meta">Testnet, not yet deployed</span>
          </div>
        </div>
      </footer>
    </>
  );
}

/**
 * Draws the HESOYAM CANOPY flywheel as an SVG, then Chrome renders it to PNG.
 *
 * Every number in here is copied from the contracts rather than invented, and the
 * SOURCES table at the bottom of the diagram says which contract each band comes
 * from, so the picture can be checked against the code instead of trusted.
 *
 * Coordinates are computed from a layout model rather than hand placed, because a
 * diagram this size is impossible to keep aligned by hand.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const W = 2100;
// Height is derived from where the content actually ends, not guessed. Guessing
// it cropped the bottom two bands off the first render.
let H = 0;

const C = {
  bg: "#0e1109",
  panel: "#161a0f",
  panel2: "#1f2516",
  line: "#2c3520",
  line2: "#414d2e",
  ink: "#f4f1e0",
  ink2: "#b9b89a",
  ink3: "#83866a",
  cash: "#5fbf4a",
  health: "#9ad34a",
  armor: "#c3ced4",
  gold: "#f5c542",
  amber: "#e0913a",
  red: "#c9453a",
};

const F_DISPLAY = "'Arial Black','Segoe UI',Impact,sans-serif";
const F_UI = "'Segoe UI',Arial,sans-serif";
const F_MONO = "'Consolas','Courier New',monospace";

const out = [];
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function push(s) {
  out.push(s);
}

/** Rough character wrapping. Good enough for a fixed diagram at known sizes. */
function wrap(text, maxWidth, fontSize, weight = 400) {
  const perChar = fontSize * (weight >= 700 ? 0.6 : 0.53);
  const max = Math.max(8, Math.floor(maxWidth / perChar));
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if (!cur.length) cur = w;
    else if ((cur + " " + w).length <= max) cur += " " + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur.length) lines.push(cur);
  return lines;
}

function text(x, y, s, o = {}) {
  const {
    size = 20,
    fill = C.ink,
    family = F_UI,
    weight = 400,
    anchor = "start",
    spacing = 0,
    upper = false,
  } = o;
  const body = upper ? String(s).toUpperCase() : s;
  push(
    `<text x="${x}" y="${y}" font-family="${family}" font-size="${size}" font-weight="${weight}" ` +
      `fill="${fill}" text-anchor="${anchor}"` +
      (spacing ? ` letter-spacing="${spacing}"` : "") +
      `>${esc(body)}</text>`
  );
}

function para(x, y, s, o = {}) {
  const { size = 18, lh = 1.45, width = 400 } = o;
  const lines = wrap(s, width, size, o.weight || 400);
  lines.forEach((ln, i) => text(x, y + i * size * lh, ln, o));
  return y + lines.length * size * lh;
}

function rect(x, y, w, h, o = {}) {
  const { fill = C.panel, stroke = C.line2, sw = 2, rx = 0 } = o;
  push(
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" ` +
      `stroke="${stroke}" stroke-width="${sw}"/>`
  );
}

/** A titled band spanning the poster, with a coloured rule under the heading. */
function band(y, label, sub, accent) {
  text(70, y, label, {
    size: 40,
    family: F_DISPLAY,
    fill: accent,
    weight: 900,
    upper: true,
    spacing: 1,
  });
  if (sub) text(70, y + 34, sub, { size: 20, fill: C.ink3 });
  push(
    `<rect x="70" y="${y + (sub ? 52 : 20)}" width="${W - 140}" height="3" fill="${accent}" opacity="0.5"/>`
  );
  return y + (sub ? 84 : 52);
}

function arrow(x1, y1, x2, y2, o = {}) {
  const { color = C.gold, sw = 3, dash = null, marker = "head" } = o;
  push(
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${sw}"` +
      (dash ? ` stroke-dasharray="${dash}"` : "") +
      ` marker-end="url(#${marker})"/>`
  );
}

function curve(d, o = {}) {
  const { color = C.gold, sw = 3, dash = null, marker = "head" } = o;
  push(
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="${sw}"` +
      (dash ? ` stroke-dasharray="${dash}"` : "") +
      (marker ? ` marker-end="url(#${marker})"` : "") +
      `/>`
  );
}

// ---------------------------------------------------------------- content

const STEPS = [
  ["1", "Buy a bench", "GrowBench.buy(tranche)", "The whole purchase price is protocol revenue. Higher tranches score better on environment control.", "fee"],
  ["2", "Site it on a plot", "Plot.site(plot, bench, days)", "Rent for the days you want. Splits 70 percent to the plot owner, 30 percent to the router.", "fee"],
  ["3", "Plant", "GrowGame.plant(bench, strain)", "Seed fee. The whole event schedule is fixed and visible at planting, so responding is a decision, not a coin flip.", "fee"],
  ["4", "Feed, three windows", "GrowGame.feed(grow, window)", "One nutrient fee per window, each a day wide. Hitting all three is 40 of your 100 care points.", "fee"],
  ["5", "Treat what goes wrong", "GrowGame.treat(grow, event)", "Mites, mould, heat. Treatment fee each. Ignore one and you lose yield you cannot get back.", "fee"],
  ["6", "Pay utilities", "charged at harvest", "Utility per day across the whole cycle. Light and water are not free.", "fee"],
  ["7", "Harvest on day seven", "GrowGame.harvest(grow)", "Yield is a pure function of care, bench tier and strain. Care 0 pays 55 percent of base. Care 100 pays all of it.", "act"],
  ["8", "Cure, two days", "GrowGame.cure(harvest)", "Cure fee. Worth up to 12 quality points, and quality is what decides which tier your Flower lands in.", "fee"],
  ["9", "Collect the Flower", "GrowGame.collect(harvest)", "ERC-1155 Flower minted to you, id = strain * 4 + tier. Now you have something to sell or to burn.", "act"],
];

const FEE_LINES = [
  ["Token transfer tax", "3.0%", "2% to the router, 1% to the platform. Every transfer, unless both ends are exempt."],
  ["Bench sale", "100%", "The entire price of a bench is revenue."],
  ["Seed fee", "per plant", "Charged when a grow starts."],
  ["Nutrients", "x3", "One fee per feeding window."],
  ["Treatment", "per event", "Charged when you respond to a pest or heat event."],
  ["Utilities", "per day", "Accrues across the cycle, settled at harvest."],
  ["Cure fee", "per cure", "Only paid if you choose to cure."],
  ["Marketplace take", "4.0%", "On every peer to peer Flower fill."],
  ["Card craft fee", "per craft", "Paid on top of the Flower that gets burned."],
  ["Plot rent cut", "30%", "The protocol's share of what a grower pays a plot owner."],
  ["Plot fuse fee", "per fuse", "Paid to burn two plots into one of the next tier."],
];

const SPLIT = [
  ["Stakers", 5000, C.cash, "StakingVault.notifyReward"],
  ["Growers", 2800, C.amber, "Dispensary.fundEpoch"],
  ["Liquidity", 1200, C.armor, "deepens the pool"],
  ["Operations", 800, C.ink2, "runs the thing"],
  ["Reserve", 200, C.ink3, "covers failures"],
];

const LOOPS = [
  [
    "1",
    "The revenue loop",
    C.cash,
    ["Somebody plays or trades", "Fees land in the router", "Half of it buys the stakers' reward", "Holding and locking HESOYAM pays more", "More people hold, stake and play"],
  ],
  [
    "2",
    "The floor loop",
    C.amber,
    ["Fees fund the Dispensary budget", "The Dispensary opens a bid above market", "A grower always has a buyer", "Growing is worth doing", "More grows, so more fees"],
  ],
  [
    "3",
    "The scarcity loop",
    C.health,
    ["Flower is burned to craft a Strain Card", "Circulating Flower falls", "The price of Flower rises", "Growing pays better per unit", "More grows, so more fees"],
  ],
  [
    "4",
    "The land loop",
    C.gold,
    ["More grows means more benches sited", "Plot owners collect more rent", "Plots become worth more", "More siting and more fusing", "Both pay the router again"],
  ],
];

const CANNOT = [
  ["No mint path exists", "Not restricted, not guarded. The function is absent from the token, and the flywheel script proves it from the ABI rather than by trying to call it."],
  ["Claims can never exceed what was funded", "INV-1. Checked in the contract suite and again against live chain state on every CI run."],
  ["The vault always holds what it owes", "Settlement held is always at least notified minus claimed, so the last person to claim is paid the same as the first."],
  ["The split is exactly 100 percent", "Five parts summing to 10000 basis points, enforced on chain. It cannot be set to anything else."],
  ["The Dispensary cannot overspend", "Epoch spend is capped by epoch budget, and the budget is only ever what the router actually delivered."],
  ["A plot pays only what a grower paid", "Rent is credited at the moment of siting from money that arrived. A plot nobody grows on earns zero, forever."],
  ["No deposit funds another payout", "There is no function anywhere that moves staked principal into the reward pool."],
  ["The honest floor is zero", "If trading and playing stop, rewards go to zero. Not negative, not a collapse. Your stake is still yours and still withdrawable."],
];

// ---------------------------------------------------------------- draw

// ---- title
text(70, 92, "HESOYAM CANOPY", {
  size: 62,
  family: F_DISPLAY,
  weight: 900,
  fill: C.gold,
  upper: true,
});
text(70, 140, "The flywheel, every step", { size: 32, fill: C.ink, weight: 600 });
para(
  70,
  180,
  "Read it top to bottom. A player spends, the spending becomes revenue, one contract splits that revenue by a published rule, and the two rails pay it back out in a way that makes playing worth more. Nothing is minted to pay anyone.",
  { size: 21, fill: C.ink2, width: 1500 }
);
push(`<rect x="70" y="228" width="${W - 140}" height="4" fill="${C.gold}"/>`);

// ---- band 1: the player loop
let y = band(300, "1. What a player actually does", "Nine steps. Seven of them charge a fee, and that fee is the only source of everything below.", C.health);

const cols = 3;
const cw = (W - 140 - 40 * (cols - 1)) / cols;
const chh = 218;
STEPS.forEach((s, i) => {
  const cx = 70 + (i % cols) * (cw + 40);
  const cy = y + Math.floor(i / cols) * (chh + 26);
  rect(cx, cy, cw, chh, { fill: C.panel, stroke: s[4] === "fee" ? C.line2 : C.health });
  push(`<rect x="${cx}" y="${cy}" width="6" height="${chh}" fill="${s[4] === "fee" ? C.gold : C.health}"/>`);
  text(cx + 26, cy + 52, s[0], { size: 42, family: F_DISPLAY, weight: 900, fill: s[4] === "fee" ? C.gold : C.health });
  text(cx + 78, cy + 48, s[1], { size: 25, weight: 700, fill: C.ink });
  text(cx + 78, cy + 76, s[2], { size: 16, family: F_MONO, fill: C.ink3 });
  para(cx + 26, cy + 116, s[3], { size: 17.5, fill: C.ink2, width: cw - 52 });
  if (s[4] === "fee") {
    text(cx + cw - 22, cy + 32, "PAYS A FEE", {
      size: 13,
      anchor: "end",
      fill: C.gold,
      weight: 700,
      spacing: 1.5,
    });
  }
});
y += 3 * (chh + 26) + 24;

// arrow down into band 2
arrow(W / 2, y - 8, W / 2, y + 52, { sw: 5 });
text(W / 2 + 24, y + 34, "every fee above goes to one place", { size: 19, fill: C.gold, weight: 600 });
y += 92;

// ---- band 2: fee lines
y = band(y, "2. Where the money enters", "Eleven fee lines, all of them somebody paying for something they wanted. None of them is a deposit.", C.gold);

const fw = (W - 140 - 30 * 2) / 3;
FEE_LINES.forEach((f, i) => {
  const cx = 70 + (i % 3) * (fw + 30);
  const cy = y + Math.floor(i / 3) * 116;
  rect(cx, cy, fw, 100, { fill: C.panel2, stroke: C.line });
  text(cx + 22, cy + 38, f[0], { size: 22, weight: 700, fill: C.ink });
  text(cx + fw - 22, cy + 38, f[1], { size: 24, family: F_MONO, fill: C.gold, anchor: "end", weight: 700 });
  para(cx + 22, cy + 64, f[2], { size: 16, fill: C.ink3, width: fw - 44 });
});
y += 4 * 116 + 20;

arrow(W / 2, y - 4, W / 2, y + 52, { sw: 5 });
y += 92;

// ---- band 3: the router
y = band(y, "3. One contract splits it", "RevenueRouter. No treasury wallet in the middle, and no discretion about where the money goes.", C.armor);

const routerH = 300;
rect(70, y, W - 140, routerH, { fill: C.panel, stroke: C.armor });

text(110, y + 52, "GUARDS BEFORE ANYTHING MOVES", { size: 16, weight: 700, fill: C.armor, spacing: 1.5 });
const guards = [
  ["Max sweep", "2,000,000 HESOYAM", "one sweep cannot dump the whole balance"],
  ["Cooldown", "6 hours", "and cannot do it repeatedly"],
  ["TWAP deviation", "at most 2%", "refuses to swap into a manipulated price"],
];
guards.forEach((g, i) => {
  const gx = 110 + i * 480;
  text(gx, y + 92, g[0], { size: 19, fill: C.ink2 });
  text(gx, y + 122, g[1], { size: 26, family: F_MONO, fill: C.armor, weight: 700 });
  para(gx, y + 150, g[2], { size: 15.5, fill: C.ink3, width: 430 });
});

push(`<line x1="110" y1="${y + 196}" x2="${W - 110}" y2="${y + 196}" stroke="${C.line2}" stroke-width="2"/>`);
text(110, y + 232, "THEN SWAP HESOYAM INTO THE SETTLEMENT TOKEN, THEN SPLIT", {
  size: 16,
  weight: 700,
  fill: C.armor,
  spacing: 1.5,
});
para(110, y + 262, "Rewards are paid in a settlement token the treasury bought with money it earned, never in newly minted HESOYAM. The split below is stored on chain and must sum to exactly 10000 basis points.", {
  size: 17.5,
  fill: C.ink2,
  width: 1800,
});
y += routerH + 36;

// the split bar
const barX = 70;
const barW = W - 140;
const barH = 92;
// A 2 percent segment is 40px wide and cannot hold a word. Anything under 6
// percent puts its name and destination in a leader below the bar instead of
// inside it, so no label is ever clipped.
const NARROW = 1000;
let acc = 0;
const below = [];
SPLIT.forEach(([name, bps, col, dest]) => {
  const segW = (barW * bps) / 10000;
  push(`<rect x="${barX + acc}" y="${y}" width="${segW}" height="${barH}" fill="${col}"/>`);
  const mid = barX + acc + segW / 2;
  const roomy = bps >= NARROW;
  text(mid, y + (roomy ? 42 : 56), `${bps / 100}%`, {
    size: roomy ? 34 : 22,
    family: F_DISPLAY,
    weight: 900,
    fill: "#0e1109",
    anchor: "middle",
  });
  if (roomy) {
    text(mid, y + 72, name, { size: 19, weight: 700, fill: "#0e1109", anchor: "middle" });
  }
  below.push({ mid, name, dest, col, roomy, segW });
  acc += segW;
});
y += barH;

// Leaders and captions under the bar.
const capTop = y + 10;
let narrowSlot = 0;
below.forEach((b) => {
  if (b.roomy) {
    const lines = wrap(b.dest, b.segW - 20, 15);
    lines.forEach((ln, i) =>
      text(b.mid, capTop + 26 + i * 20, ln, { size: 15, fill: b.col, anchor: "middle", family: F_MONO })
    );
  } else {
    // Step the narrow ones down so their captions cannot collide with each other.
    const drop = capTop + 26 + narrowSlot * 44;
    narrowSlot++;
    push(
      `<line x1="${b.mid}" y1="${capTop - 4}" x2="${b.mid}" y2="${drop - 14}" stroke="${b.col}" stroke-width="1.5"/>`
    );
    // A narrow segment near the right edge would centre its caption off the
    // canvas, so anchor it inward once it no longer fits.
    const label = `${b.name}, ${b.dest}`;
    const halfW = (label.length * 15 * 0.55) / 2;
    let lx = b.mid;
    let anchor = "middle";
    if (b.mid + halfW > W - 70) {
      lx = W - 70;
      anchor = "end";
    } else if (b.mid - halfW < 70) {
      lx = 70;
      anchor = "start";
    }
    text(lx, drop, label, { size: 15, fill: b.col, anchor, family: F_MONO });
  }
});
y = capTop + 26 + Math.max(2, narrowSlot) * 44 + 16;

// ---- band 4: the rails
y = band(y, "4. The two rails that pay you", "Half to the people who hold. Just over a quarter back to the people who grow.", C.cash);

const railW = (W - 140 - 40) / 2;
const railH = 470;

// staker rail
rect(70, y, railW, railH, { fill: C.panel, stroke: C.cash });
push(`<rect x="70" y="${y}" width="${railW}" height="8" fill="${C.cash}"/>`);
text(102, y + 62, "50%", { size: 52, family: F_DISPLAY, weight: 900, fill: C.cash });
text(248, y + 58, "The staker rail", { size: 28, weight: 700, fill: C.ink });
text(248, y + 86, "StakingVault", { size: 16, family: F_MONO, fill: C.ink3 });
let ry = para(102, y + 128, "Revenue arrives as notifyReward and is spread across everyone's weight using an accumulator, so a deposit made after the money arrived cannot claim any of it.", {
  size: 17.5,
  fill: C.ink2,
  width: railW - 64,
});
ry += 18;
text(102, ry, "WEIGHT = AMOUNT x LOCK MULTIPLIER x CARD BONUS", { size: 15, weight: 700, fill: C.cash, spacing: 1.2 });
ry += 30;
const tiers = [
  ["Seedling", "no lock", "1.0x"],
  ["Vegetative", "30 days", "1.3x"],
  ["Flowering", "60 days", "1.8x"],
  ["Canopy", "90 days", "2.5x"],
];
tiers.forEach((t, i) => {
  const ty = ry + i * 30;
  text(102, ty, t[0], { size: 18, fill: C.ink });
  text(320, ty, t[1], { size: 17, fill: C.ink3 });
  text(102 + railW - 128, ty, t[2], { size: 20, family: F_MONO, fill: C.cash, anchor: "end", weight: 700 });
});
ry += 4 * 30 + 12;
para(102, ry, "Strain Cards raise it further. At most five equipped, and the total card bonus is capped at 4200 basis points, so the leaderboard cannot simply be bought. Leaving a lock early costs 400 basis points.", {
  size: 17,
  fill: C.ink3,
  width: railW - 64,
});

// grower rail
const gx0 = 70 + railW + 40;
rect(gx0, y, railW, railH, { fill: C.panel, stroke: C.amber });
push(`<rect x="${gx0}" y="${y}" width="${railW}" height="8" fill="${C.amber}"/>`);
text(gx0 + 32, y + 62, "28%", { size: 52, family: F_DISPLAY, weight: 900, fill: C.amber });
text(gx0 + 178, y + 58, "The grower rail", { size: 28, weight: 700, fill: C.ink });
text(gx0 + 178, y + 86, "Dispensary", { size: 16, family: F_MONO, fill: C.ink3 });
let gy = para(gx0 + 32, y + 128, "The money funds an epoch budget, and the Dispensary uses it to bid for Flower. It opens above market and falls across the day until the budget is spent or nobody sells.", {
  size: 17.5,
  fill: C.ink2,
  width: railW - 64,
});
gy += 18;
text(gx0 + 32, gy, "THE BID, ACROSS ONE 24 HOUR EPOCH", { size: 15, weight: 700, fill: C.amber, spacing: 1.2 });
gy += 34;

// dutch auction curve
const dw = railW - 96;
const dh = 148;
const dx = gx0 + 32;
push(`<rect x="${dx}" y="${gy}" width="${dw}" height="${dh}" fill="${C.panel2}" stroke="${C.line}" stroke-width="1"/>`);
push(
  `<path d="M ${dx} ${gy + dh * 0.3} L ${dx + dw} ${gy + dh * 0.82}" stroke="${C.amber}" stroke-width="3" fill="none"/>`
);
push(
  `<line x1="${dx}" y1="${gy + dh * 0.58}" x2="${dx + dw}" y2="${gy + dh * 0.58}" stroke="${C.ink3}" stroke-width="1" stroke-dasharray="5 5"/>`
);
text(dx + 12, gy + 24, "opens at 115% of reference", { size: 15, fill: C.amber, family: F_MONO });
text(dx + dw - 12, gy + dh - 10, "floors at 60% after 24h", { size: 15, fill: C.amber, family: F_MONO, anchor: "end" });
text(dx + 12, gy + dh * 0.58 - 8, "market reference", { size: 14, fill: C.ink3, family: F_MONO });
gy += dh + 30;
para(gx0 + 32, gy, "Spend can never exceed the budget, and the budget is only ever what the router actually delivered. There is no guaranteed floor, because a guaranteed floor would need money nobody had earned yet.", {
  size: 17,
  fill: C.ink3,
  width: railW - 64,
});
y += railH + 46;

// ---- the loop closing, as its own band so nothing overlaps the rails
const closeH = 190;
rect(70, y, W - 140, closeH, { fill: C.panel2, stroke: C.line2 });
text(W / 2, y + 44, "AND THAT IS WHAT SENDS YOU BACK TO STEP ONE", {
  size: 20,
  weight: 700,
  fill: C.gold,
  anchor: "middle",
  spacing: 2,
});

const backs = [
  [C.cash, "headCash", "Stakers are paid in a settlement token, so holding and locking HESOYAM is worth more than it was."],
  [C.amber, "headAmber", "Growers always have a buyer above market, so planting the next cycle is worth doing."],
];
backs.forEach((b, i) => {
  const bx = 120 + i * ((W - 240) / 2);
  const bw = (W - 240) / 2 - 60;
  const by = y + 92;
  curve(`M ${bx + bw} ${by} L ${bx + 40} ${by}`, { color: b[0], sw: 4, marker: b[1] });
  const lines = wrap(b[2], bw - 70, 16.5);
  lines.forEach((ln, k) =>
    text(bx + 56, by + 26 + k * 22, ln, { size: 16.5, fill: b[0] === C.cash ? C.cash : C.amber })
  );
});
y += closeH + 46;

// ---- band 5: the loops
y = band(y, "5. Why it is a wheel and not a pipe", "Four loops that feed each other. Each one ends where another begins.", C.gold);

const lw = (W - 140 - 30 * 3) / 4;
const loopH = 460;
LOOPS.forEach((lp, i) => {
  const cx = 70 + i * (lw + 30);
  rect(cx, y, lw, loopH, { fill: C.panel, stroke: lp[2] });
  push(`<rect x="${cx}" y="${y}" width="${lw}" height="6" fill="${lp[2]}"/>`);
  text(cx + 22, y + 62, lp[0], { size: 40, family: F_DISPLAY, weight: 900, fill: lp[2] });
  text(cx + 22, y + 100, lp[1], { size: 23, weight: 700, fill: C.ink });
  let ly = y + 140;
  lp[3].forEach((stepText, k) => {
    push(`<circle cx="${cx + 32}" cy="${ly - 6}" r="7" fill="${lp[2]}"/>`);
    if (k < lp[3].length - 1) {
      push(
        `<line x1="${cx + 32}" y1="${ly + 2}" x2="${cx + 32}" y2="${ly + 44}" stroke="${lp[2]}" stroke-width="2" opacity="0.5"/>`
      );
    }
    const end = para(cx + 54, ly, stepText, { size: 16.5, fill: C.ink2, width: lw - 80 });
    ly = Math.max(end + 14, ly + 52);
  });
  // The return curve has to stay inside the card. Route it through the gap
  // between the last bullet and the card's bottom edge.
  const foot = Math.min(ly + 14, y + loopH - 18);
  push(
    `<path d="M ${cx + 32} ${foot - 8} C ${cx + 16} ${foot + 10}, ${cx + lw - 34} ${foot + 10}, ${cx + lw - 34} ${y + 134}" ` +
      `fill="none" stroke="${lp[2]}" stroke-width="2" stroke-dasharray="6 5" marker-end="url(#head)" opacity="0.75"/>`
  );
  text(cx + lw - 26, y + 168, "loops", {
    size: 13,
    fill: lp[2],
    anchor: "end",
    weight: 700,
    spacing: 1,
  });
});
y += loopH + 46;

// ---- band 6: invariants
y = band(y, "6. What cannot happen", "These are properties of the code. Each one is a named test, and the flywheel script checks six of them against live chain state.", C.red);

const iw = (W - 140 - 30) / 2;
CANNOT.forEach((it, i) => {
  const cx = 70 + (i % 2) * (iw + 30);
  const cy = y + Math.floor(i / 2) * 128;
  rect(cx, cy, iw, 112, { fill: C.panel2, stroke: C.line });
  push(`<rect x="${cx}" y="${cy}" width="5" height="112" fill="${C.red}"/>`);
  text(cx + 24, cy + 38, it[0], { size: 22, weight: 700, fill: C.ink });
  para(cx + 24, cy + 66, it[1], { size: 16.5, fill: C.ink3, width: iw - 48 });
});
y += 4 * 128 + 26;

// ---- sources
push(`<line x1="70" y1="${y}" x2="${W - 70}" y2="${y}" stroke="${C.line2}" stroke-width="2"/>`);
y += 34;
text(70, y, "WHERE EACH NUMBER COMES FROM", { size: 15, weight: 700, fill: C.ink3, spacing: 1.6 });
y += 30;
const SRC =
  "Steps and fees: GrowGame.sol, GrowBench.sol, Plot.sol.  " +
  "Tax: HesoyamToken.sol, 3% split 2/1.  " +
  "Guards and split: RevenueRouter.sol, allocation 5000/2800/1200/800/200 bps.  " +
  "Lock tiers and card cap: StakingVault.sol, MAX_CARD_BONUS_BPS 4200, MAX_EQUIPPED_CARDS 5.  " +
  "Bid curve: Dispensary.sol, CEIL_BPS 11500, FLOOR_BPS 6000.  " +
  "Rent split and supply: Plot.sol, protocolBps 3000, MAX_SUPPLY 256.  " +
  "Live checks: scripts/flywheel.js.";
y = para(70, y, SRC, { size: 16, fill: C.ink3, width: W - 140 });

// ---------------------------------------------------------------- assemble

H = Math.ceil(y + 70);

const header =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
  `<defs>` +
  `<marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">` +
  `<path d="M 0 0 L 10 5 L 0 10 z" fill="${C.gold}"/></marker>` +
  `<marker id="headCash" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">` +
  `<path d="M 0 0 L 10 5 L 0 10 z" fill="${C.cash}"/></marker>` +
  `<marker id="headAmber" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">` +
  `<path d="M 0 0 L 10 5 L 0 10 z" fill="${C.amber}"/></marker>` +
  `</defs>` +
  `<rect width="${W}" height="${H}" fill="${C.bg}"/>`;

// ---------------------------------------------------------------- render

const svg = header + "\n" + out.join("\n") + "\n</svg>";
const docs = path.join(__dirname, "..", "docs");
fs.mkdirSync(docs, { recursive: true });
const svgPath = path.join(docs, "flywheel.svg");
const htmlPath = path.join(docs, "flywheel.html");
const pngPath = path.join(docs, "flywheel.png");

fs.writeFileSync(svgPath, svg);
fs.writeFileSync(
  htmlPath,
  `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:${C.bg};width:${W}px;height:${H}px;overflow:hidden}svg{display:block}</style>${svg}`
);

const chrome =
  process.env.CHROME ||
  "C:/Program Files/Google/Chrome/Application/chrome.exe";
const scale = process.env.SCALE || "2";

execFileSync(
  chrome,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    `--force-device-scale-factor=${scale}`,
    `--window-size=${W},${H}`,
    `--screenshot=${pngPath.replace(/\\/g, "/")}`,
    `file:///${htmlPath.replace(/\\/g, "/")}`,
  ],
  { stdio: "pipe" }
);

const b = fs.readFileSync(pngPath);
if (b.slice(1, 4).toString() !== "PNG") throw new Error("output is not a PNG");
console.log(
  `docs/flywheel.png  ${b.readUInt32BE(16)} x ${b.readUInt32BE(20)}  ${(b.length / 1024).toFixed(0)} KB`
);
console.log(`docs/flywheel.svg  ${(svg.length / 1024).toFixed(0)} KB source`);

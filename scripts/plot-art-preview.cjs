/**
 * Prototype of the next generation of Plot art, 24 by 24 instead of 16 by 16.
 *
 * This is a JavaScript mirror of what PixelArt.sol will do, written first so the
 * composition can be judged before it is committed to a contract that can never
 * be changed afterwards. Once the look is agreed this gets ported to Solidity and
 * a parity test pins the two together, the same way game-core is pinned to the
 * game contracts today.
 *
 * The scene, top to bottom: sky with a low sun, a distant skyline, a facade with
 * lit windows and a door, a palm, the lot itself with rows of plants, a fence,
 * and the road. Every element is a pure function of the seed.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const SIZE = 24;
const SCALE = 16;

// Nine colours per district: skyTop, sky, wall, shade, window, ground, plant,
// accent, road.
const PALETTES = [
  ["Dust", ["#2a2418", "#4a3a22", "#6b5f42", "#4a4130", "#f5c542", "#52472f", "#9ad34a", "#c9453a", "#35301f"]],
  ["Bayside", ["#1c3038", "#34565e", "#7a8f8a", "#55665f", "#f5e0a3", "#6b7a5a", "#9ad34a", "#6ec8d8", "#263a3a"]],
  ["Downtown", ["#16181e", "#2a2f3a", "#4a5058", "#33383f", "#f5c542", "#3a3f42", "#7ab648", "#c9453a", "#23262a"]],
  ["Ridge", ["#22301e", "#40542e", "#5c6b47", "#414d33", "#f0d98a", "#4a5535", "#9ad34a", "#f5c542", "#2e3a26"]],
  ["Docks", ["#191f22", "#2e3d42", "#45524f", "#303a38", "#d8b25a", "#38423f", "#6f9e3f", "#8a9aa5", "#242c2e"]],
  ["Badlands", ["#2e2214", "#5a3a22", "#7a6144", "#574531", "#f5c542", "#5e4b33", "#8ab83c", "#c9453a", "#3a2d1c"]],
  ["County", ["#1e2618", "#3c4a28", "#5f6b3f", "#43502d", "#ecd582", "#4d5a32", "#9ad34a", "#d8863a", "#2a3320"]],
  ["The Strip", ["#1a1424", "#32254a", "#4f4460", "#372f45", "#f5c542", "#3d3548", "#9ad34a", "#e05ca8", "#251f2e"]],
];

const TIERS = ["Lot", "Fenced", "Greenhouse", "Lit"];

const SKY_TOP = 0, SKY = 1, WALL = 2, SHADE = 3, WINDOW = 4, GROUND = 5, PLANT = 6, ACCENT = 7, ROAD = 8;

/** Same avalanche the contract will use, so small seeds still vary the art. */
function mix(seed) {
  const h = crypto.createHash("sha256").update(String(seed)).digest();
  return BigInt("0x" + h.toString("hex"));
}

function bits(m, shift, mod) {
  return Number((m >> BigInt(shift)) % BigInt(mod));
}

function tile(seed, tier) {
  const m = mix(seed);
  const px = new Array(SIZE * SIZE).fill(SKY);

  const bl = 2 + bits(m, 0, 3);
  const br = bl + 8 + bits(m, 4, 3);
  const roof = 12;
  const sunX = 4 + bits(m, 8, 14);
  const sunY = 4;
  const palm = 17 + bits(m, 12, 3);
  // Spacing is wide on purpose. Dense rows of single pixels read as a barcode
  // rather than as a crop, which is what the first pass at this looked like.
  const spacing = tier >= 2 ? 4 : 5;
  const plantOff = bits(m, 16, 4);

  const set = (x, y, c) => {
    if (x >= 0 && x < SIZE && y >= 0 && y < SIZE) px[y * SIZE + x] = c;
  };

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let c = SKY;
      if (y <= 1) c = SKY_TOP;

      // A low sun, the thing that makes it read as dusk rather than daylight.
      const dx = x - sunX;
      const dy = y - sunY;
      if (dx * dx + dy * dy <= 4) c = WINDOW;

      // Distant skyline. Each column gets its own height from the seed.
      const skyline = 8 + bits(m, 20 + (x % 20), 3);
      if (y >= skyline && y <= 10) c = SHADE;

      if (y >= 18) c = GROUND;
      if (y >= 22) c = ROAD;

      set(x, y, c);
    }
  }

  // The facade.
  for (let y = roof; y <= 17; y++) {
    for (let x = bl; x <= br; x++) {
      let c = WALL;
      if (x === br) c = SHADE;
      else if ((x - bl) % 3 === 1 && (y - roof) % 2 === 0) {
        const bit = Math.floor((x - bl) / 3) + Math.floor((y - roof) / 2) * 5;
        // Tier 3 is the lit plot, so every window in it is on.
        c = tier >= 3 || bits(m, 60 + (bit % 60), 2) === 1 ? WINDOW : SHADE;
      }
      set(x, y, c);
    }
  }
  // A door in the darkest colour available, so it reads against the wall
  // instead of disappearing into the unlit windows.
  set(bl + 1, 16, ROAD);
  set(bl + 1, 17, ROAD);
  set(bl + 2, 16, ROAD);
  set(bl + 2, 17, ROAD);

  // The palm. Trunk, then fronds spread either side of it.
  for (let y = 13; y <= 17; y++) set(palm, y, SHADE);
  const fronds = [
    [-2, 12], [-1, 11], [0, 10], [1, 11], [2, 12],
    [-1, 12], [1, 12], [-3, 12], [3, 12],
  ];
  fronds.forEach(([ox, oy]) => set(palm + ox, oy, PLANT));

  // Plants drawn as plants: a spread of leaves over a single stem. Full height
  // bars at every column read as a fence, which is what the first pass did.
  for (let x = 0; x < SIZE; x++) {
    if ((x + plantOff) % spacing !== 0) continue;
    set(x - 1, 20, PLANT);
    set(x, 20, PLANT);
    set(x + 1, 20, PLANT);
    set(x, 21, PLANT);
  }

  // The road: one clean band with sparse dashes, not a chequerboard.
  for (let x = 0; x < SIZE; x++) {
    if (x % 6 === 1 || x % 6 === 2) set(x, 22, WINDOW);
  }

  // Each tier adds one clearly readable thing.
  if (tier >= 1) {
    // A fence line along the front of the lot.
    for (let x = 0; x < SIZE; x++) set(x, 18, x % 2 === 0 ? ACCENT : SHADE);
  }
  if (tier >= 2) {
    // A sign across the roof line.
    for (let x = bl; x <= br; x++) if (x % 2 === 0) set(x, roof - 1, ACCENT);
  }
  if (tier >= 3) {
    // A lit kerb under the road.
    for (let x = 0; x < SIZE; x++) set(x, 23, x % 3 === 0 ? ACCENT : ROAD);
  }

  return px;
}

/** Run length encode each row, exactly as the contract will. */
function svg(px, palette) {
  const dim = SIZE * SCALE;
  let body = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" width="${dim}" height="${dim}">`;
  let rects = 0;
  for (let y = 0; y < SIZE; y++) {
    let x = 0;
    while (x < SIZE) {
      let run = 1;
      while (x + run < SIZE && px[y * SIZE + x + run] === px[y * SIZE + x]) run++;
      body += `<rect x="${x * SCALE}" y="${y * SCALE}" width="${run * SCALE}" height="${SCALE}" fill="${palette[px[y * SIZE + x]]}"/>`;
      rects++;
      x += run;
    }
  }
  return { svg: body + "</svg>", rects };
}

// ---------------------------------------------------------------- render

const samples = [];
PALETTES.forEach(([name, pal], d) => {
  const t = d % 4;
  const s = svg(tile(1000 + d * 7717, t), pal);
  samples.push({ label: `${name}, ${TIERS[t]}`, ...s });
});
// The same plot at all four tiers, so the progression is visible side by side.
PALETTES.slice(0, 1).forEach(([name, pal]) => {
  for (let t = 0; t < 4; t++) {
    const s = svg(tile(424242, t), pal);
    samples.push({ label: `${name}, ${TIERS[t]}, same seed`, ...s });
  }
});

const avg = Math.round(samples.reduce((a, s) => a + s.rects, 0) / samples.length);

const html =
  `<!doctype html><meta charset="utf-8"><title>Plot art</title><style>` +
  `body{background:#0e1109;color:#f4f1e0;font:15px 'Segoe UI',Arial,sans-serif;margin:0;padding:44px}` +
  `h1{font:900 40px 'Arial Black',sans-serif;text-transform:uppercase;color:#f5c542;margin:0 0 6px;text-shadow:2px 2px 0 rgba(0,0,0,.85)}` +
  `p.sub{color:#b9b89a;margin:0 0 32px;font-size:17px}` +
  `.g{display:grid;grid-template-columns:repeat(4,1fr);gap:26px}` +
  `.c{background:#161a0f;border:1px solid #414d2e;padding:14px}` +
  `.c svg{width:100%;height:auto;display:block;image-rendering:pixelated}` +
  `.n{margin-top:12px;font-size:13px;color:#b9b89a;font-family:Consolas,monospace}` +
  `.r{font-size:11px;color:#83866a;font-family:Consolas,monospace}` +
  `</style>` +
  `<h1>Plot art, 24 x 24</h1>` +
  `<p class="sub">Eight districts, four tiers. Generated entirely from the seed, no off chain asset. Average ${avg} rects per tile.</p>` +
  `<div class="g">` +
  samples
    .map((s) => `<div class="c">${s.svg}<div class="n">${s.label}</div><div class="r">${s.rects} rects</div></div>`)
    .join("") +
  `</div>`;

const docs = path.join(__dirname, "..", "docs");
fs.mkdirSync(docs, { recursive: true });
const htmlPath = path.join(docs, "plot-art.html");
const pngPath = path.join(docs, "plot-art-sample.png");
fs.writeFileSync(htmlPath, html);

const chrome = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
execFileSync(
  chrome,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    "--force-device-scale-factor=2",
    "--window-size=1700,1620",
    `--screenshot=${pngPath.replace(/\\/g, "/")}`,
    `file:///${htmlPath.replace(/\\/g, "/")}`,
  ],
  { stdio: "pipe" }
);

const b = fs.readFileSync(pngPath);
if (b.slice(1, 4).toString() !== "PNG") throw new Error("output is not a PNG");
console.log(`docs/plot-art-sample.png  ${b.readUInt32BE(16)} x ${b.readUInt32BE(20)}  ${(b.length / 1024).toFixed(0)} KB`);
console.log(`average ${avg} rects per tile, ${samples.length} samples`);

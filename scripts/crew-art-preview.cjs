/**
 * Crew: original 24x24 pixel portraits, generated from a seed.
 *
 * These are the people who work your plots. The look is the West Coast street
 * style of that era as a genre, built from traits, not a copy of anybody's
 * characters. No specific game character is referenced or reproduced.
 *
 * Prototype in JavaScript first, exactly like the plot art was, so the
 * composition can be judged before it goes into a contract that can never be
 * changed afterwards.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const SIZE = 24;
const SCALE = 16;

// Palette slots.
const BG = 0, SKIN = 1, SHADE = 2, HAIR = 3, DARK = 4, CLOTH = 5, CLOTH2 = 6, GOLD = 7, WHITE = 8;

/** Skin tones. A street in that part of the world is not one colour. */
const SKINS = [
  ["#8d5524", "#6b3f19"],
  ["#c68642", "#9a6330"],
  ["#e0ac69", "#b8854b"],
  ["#f1c27d", "#c99a5b"],
  ["#5c3317", "#42230f"],
  ["#a86b3c", "#7d4d29"],
];

const HAIRS = ["#1b1410", "#2e2018", "#4a3520", "#6b4a2a", "#0f0d0c", "#7a6a55"];

const BACKDROPS = [
  ["Dust", "#4a3a22"],
  ["Bayside", "#34565e"],
  ["Downtown", "#2a2f3a"],
  ["Ridge", "#40542e"],
  ["Docks", "#2e3d42"],
  ["Badlands", "#5a3a22"],
  ["County", "#3c4a28"],
  ["The Strip", "#32254a"],
];

const CLOTHS = [
  ["Tank top", "#d8d3c0", "#a9a493"],
  ["Hoodie", "#3f4a55", "#2b333b"],
  ["Plaid", "#9c3f36", "#6e2c26"],
  ["Jacket", "#2f3a26", "#212a1b"],
  ["Vest", "#5a4a30", "#3f3421"],
  ["Jersey", "#c9a227", "#94761c"],
];

const HEADWEAR = ["None", "Fade", "Afro", "Cornrows", "Cap", "Bandana", "Beanie", "Durag"];
const FACIAL = ["Clean", "Moustache", "Goatee", "Full beard"];
const EYEWEAR = ["None", "Shades"];

function mix(seed) {
  return BigInt("0x" + crypto.createHash("sha256").update(String(seed)).digest("hex"));
}
function bits(m, shift, mod) {
  return Number((m >> BigInt(shift)) % BigInt(mod));
}

function portrait(seed) {
  const m = mix(seed);
  const t = {
    skin: bits(m, 0, SKINS.length),
    hair: bits(m, 6, HAIRS.length),
    backdrop: bits(m, 12, BACKDROPS.length),
    cloth: bits(m, 18, CLOTHS.length),
    head: bits(m, 24, HEADWEAR.length),
    facial: bits(m, 30, FACIAL.length),
    eyes: bits(m, 36, 4) === 0 ? 1 : 0, // shades are the rarer trait
    chain: bits(m, 42, 3) === 0 ? 1 : 0,
    earring: bits(m, 48, 4) === 0 ? 1 : 0,
  };

  const px = new Array(SIZE * SIZE).fill(BG);
  const set = (x, y, c) => {
    if (x >= 0 && x < SIZE && y >= 0 && y < SIZE) px[y * SIZE + x] = c;
  };
  const rect = (x0, y0, x1, y1, c) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, c);
  };

  // Shoulders first, so the head and neck sit on top of them.
  rect(2, 19, 21, 23, CLOTH);
  rect(2, 19, 4, 23, CLOTH2);
  rect(19, 19, 21, 23, CLOTH2);
  if (t.cloth === 0) {
    // A tank top: bare shoulders, straps over them.
    rect(2, 19, 7, 23, SKIN);
    rect(16, 19, 21, 23, SKIN);
    rect(8, 19, 9, 23, CLOTH);
    rect(14, 19, 15, 23, CLOTH);
    rect(10, 21, 13, 23, CLOTH);
  }
  if (t.cloth === 2) {
    // Plaid: a check, not a texture. Two lines each way is enough at this size.
    for (let y = 19; y <= 23; y++) for (let x = 2; x <= 21; x++) if (x % 4 === 0) set(x, y, CLOTH2);
    for (let x = 2; x <= 21; x++) if (x % 4 !== 0) set(x, 21, CLOTH2);
  }
  if (t.cloth === 1) {
    // Hoodie: a collar behind the neck.
    rect(8, 19, 15, 20, CLOTH2);
  }

  // Neck and jaw.
  rect(10, 16, 13, 19, SHADE);
  rect(10, 16, 13, 18, SKIN);
  set(10, 18, SHADE);
  set(13, 18, SHADE);

  // Head.
  rect(6, 5, 17, 16, SKIN);
  // Rounded corners, so it is a head rather than a box.
  set(6, 5, BG); set(17, 5, BG); set(6, 16, BG); set(17, 16, BG);
  set(6, 15, SHADE); set(17, 15, SHADE);
  // Shaded side, one light source. Stops short of the jaw so it reads as a
  // cheek rather than a stripe.
  for (let y = 7; y <= 14; y++) set(17, y, SHADE);
  set(16, 16, SHADE);
  set(16, 15, SHADE);

  // Ears.
  set(5, 10, SKIN); set(5, 11, SKIN); set(5, 12, SHADE);
  set(18, 10, SHADE); set(18, 11, SHADE);
  if (t.earring) set(18, 12, GOLD);

  // Brows.
  rect(8, 9, 9, 9, DARK);
  rect(14, 9, 15, 9, DARK);

  // Eyes, or shades across both.
  if (t.eyes === 1) {
    rect(7, 10, 16, 11, DARK);
    set(6, 10, DARK); set(17, 10, DARK); // arms reaching the temples
    set(11, 10, SHADE); set(12, 10, SHADE); // bridge
    set(8, 10, WHITE); set(15, 10, WHITE); // glint, so they read as lenses
  } else {
    rect(8, 10, 9, 10, WHITE);
    rect(14, 10, 15, 10, WHITE);
    set(9, 10, DARK);
    set(14, 10, DARK);
    set(8, 11, SHADE);
    set(15, 11, SHADE);
  }

  // Nose, one column, and a mouth that is two pixels rather than four.
  set(11, 12, SHADE);
  set(11, 13, SHADE);
  rect(11, 14, 12, 14, DARK);

  // Facial hair. Drawn around the mouth rather than over the whole jaw, so the
  // lower face keeps its shape instead of collapsing into one dark block.
  if (t.facial === 1) {
    rect(10, 13, 13, 13, HAIR);
  }
  if (t.facial === 2) {
    rect(10, 13, 13, 13, HAIR);
    rect(11, 15, 12, 15, HAIR);
  }
  if (t.facial === 3) {
    rect(10, 13, 13, 13, HAIR);
    // Jaw line only: an outline, not a fill.
    rect(8, 15, 15, 15, HAIR);
    rect(9, 16, 14, 16, HAIR);
    for (let y = 11; y <= 14; y++) { set(7, y, HAIR); set(16, y, HAIR); }
    rect(11, 14, 12, 14, DARK); // mouth stays visible through it
  }

  // Headwear. Drawn last because it sits over the hairline.
  const H = t.head;
  if (H === 1) {
    // Fade: close on the sides, a little height on top.
    rect(6, 4, 17, 6, HAIR);
    rect(6, 7, 7, 9, HAIR);
    rect(16, 7, 17, 9, HAIR);
    set(6, 4, BG); set(17, 4, BG);
  } else if (H === 2) {
    // Afro.
    rect(4, 1, 19, 6, HAIR);
    set(4, 1, BG); set(5, 1, BG); set(18, 1, BG); set(19, 1, BG);
    set(4, 2, BG); set(19, 2, BG);
    rect(4, 7, 5, 10, HAIR);
    rect(18, 7, 19, 10, HAIR);
  } else if (H === 3) {
    // Cornrows: braids running back, gaps between them.
    rect(6, 4, 17, 7, HAIR);
    for (let x = 8; x <= 15; x += 3) for (let y = 5; y <= 7; y++) set(x, y, DARK);
    rect(6, 8, 6, 9, HAIR);
    rect(17, 8, 17, 9, HAIR);
  } else if (H === 4) {
    // Cap, with the brim forward.
    rect(6, 3, 17, 7, CLOTH);
    rect(6, 3, 17, 4, CLOTH2);
    rect(3, 8, 17, 8, CLOTH2);
    set(6, 3, BG); set(17, 3, BG);
  } else if (H === 5) {
    // Bandana, tied at the side.
    rect(6, 4, 17, 7, CLOTH);
    for (let x = 6; x <= 17; x += 3) set(x, 6, CLOTH2);
    set(18, 7, CLOTH); set(19, 8, CLOTH); set(18, 9, CLOTH);
  } else if (H === 6) {
    // Beanie, with a fold.
    rect(5, 2, 18, 7, CLOTH);
    rect(5, 6, 18, 7, CLOTH2);
    set(5, 2, BG); set(18, 2, BG);
  } else if (H === 7) {
    // Durag, with the tails hanging behind.
    rect(6, 4, 17, 7, CLOTH);
    rect(17, 8, 19, 9, CLOTH2);
    rect(18, 10, 19, 13, CLOTH2);
  } else {
    // Shaved: a receding shadow at the temples rather than a band across the
    // crown, which just looked like a hat brim.
    set(6, 6, SHADE); set(7, 5, SHADE);
    set(17, 6, SHADE); set(16, 5, SHADE);
    rect(8, 5, 15, 5, SHADE);
  }

  // A chain, over the collarbone.
  if (t.chain) {
    for (let x = 8; x <= 15; x++) if (x % 2 === 0) set(x, 20, GOLD);
    set(11, 21, GOLD);
    set(12, 21, GOLD);
  }

  const palette = [
    BACKDROPS[t.backdrop][1],
    SKINS[t.skin][0],
    SKINS[t.skin][1],
    HAIRS[t.hair],
    "#141110",
    CLOTHS[t.cloth][1],
    CLOTHS[t.cloth][2],
    "#f5c542",
    "#f2efe2",
  ];

  return { px, palette, t };
}

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

const samples = [];
for (let i = 0; i < 24; i++) {
  const p = portrait(7000 + i * 4211);
  const s = svg(p.px, p.palette);
  samples.push({
    ...s,
    label: `${HEADWEAR[p.t.head]}, ${CLOTHS[p.t.cloth][0]}`,
    sub: `${FACIAL[p.t.facial]}${p.t.eyes ? ", shades" : ""}${p.t.chain ? ", chain" : ""}${p.t.earring ? ", earring" : ""}`,
  });
}
const avg = Math.round(samples.reduce((a, s) => a + s.rects, 0) / samples.length);

const html =
  `<!doctype html><meta charset="utf-8"><title>Crew</title><style>` +
  `body{background:#0e1109;color:#f4f1e0;font:15px 'Segoe UI',Arial,sans-serif;margin:0;padding:44px}` +
  `h1{font:900 40px 'Arial Black',sans-serif;text-transform:uppercase;color:#f5c542;margin:0 0 6px;text-shadow:2px 2px 0 rgba(0,0,0,.85)}` +
  `p.sub{color:#b9b89a;margin:0 0 32px;font-size:17px;max-width:80ch}` +
  `.g{display:grid;grid-template-columns:repeat(6,1fr);gap:22px}` +
  `.c{background:#161a0f;border:1px solid #414d2e;padding:12px}` +
  `.c svg{width:100%;height:auto;display:block;image-rendering:pixelated}` +
  `.n{margin-top:10px;font-size:12px;color:#f4f1e0;font-family:Consolas,monospace}` +
  `.r{font-size:11px;color:#83866a;font-family:Consolas,monospace}` +
  `</style>` +
  `<h1>Crew, 24 x 24</h1>` +
  `<p class="sub">Original street portraits built from traits: eight headwear, six tops, six skin tones, four facial hair, plus shades, chain and earring. Every pixel generated from the seed, nothing off chain. Average ${avg} rects per portrait.</p>` +
  `<div class="g">` +
  samples
    .map((s) => `<div class="c">${s.svg}<div class="n">${s.label}</div><div class="r">${s.sub}</div></div>`)
    .join("") +
  `</div>`;

const docs = path.join(__dirname, "..", "docs");
fs.mkdirSync(docs, { recursive: true });
const htmlPath = path.join(docs, "crew-art.html");
const pngPath = path.join(docs, "crew-art-sample.png");
fs.writeFileSync(htmlPath, html);

execFileSync(
  process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    "--force-device-scale-factor=2", "--window-size=1700,1460",
    `--screenshot=${pngPath.replace(/\\/g, "/")}`,
    `file:///${htmlPath.replace(/\\/g, "/")}`,
  ],
  { stdio: "pipe" }
);

const b = fs.readFileSync(pngPath);
if (b.slice(1, 4).toString() !== "PNG") throw new Error("output is not a PNG");
console.log(`docs/crew-art-sample.png  ${b.readUInt32BE(16)} x ${b.readUInt32BE(20)}  ${(b.length / 1024).toFixed(0)} KB`);
console.log(`average ${avg} rects per portrait, ${samples.length} samples`);

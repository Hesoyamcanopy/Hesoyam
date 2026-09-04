/**
 * Generates the page backdrops as SVG.
 *
 * These are original artwork, not stills from anybody's game. The look comes from
 * the things that era of open world game actually put on screen at dusk: a low
 * sun, a flat horizon, a ridge line, power poles, palms, and a lot of haze. All
 * of it is silhouette and gradient, so it survives being scaled to any viewport
 * and weighs a few kilobytes.
 *
 * They are deliberately low contrast. A backdrop that competes with the text in
 * front of it is a worse backdrop, however nice it looks on its own.
 *
 * Usage: npm run backgrounds
 */
const fs = require("fs");
const path = require("path");

const W = 1600;
const H = 900;

/** Deterministic noise, so a regenerate does not reshuffle the artwork. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function palm(x, groundY, scale, fill, opacity) {
  const h = 150 * scale;
  const trunkW = Math.max(2, 5 * scale);
  let d = "";
  // A trunk that leans, because a straight one reads as a pole.
  const lean = 18 * scale;
  d += `<path d="M ${x} ${groundY} C ${x + lean * 0.3} ${groundY - h * 0.5}, ${x + lean * 0.7} ${groundY - h * 0.8}, ${x + lean} ${groundY - h}" `;
  d += `stroke="${fill}" stroke-width="${trunkW}" fill="none" opacity="${opacity}"/>`;
  // Fronds, drooping either side.
  const tipX = x + lean;
  const tipY = groundY - h;
  const fronds = [
    [-1, -0.15], [-1, 0.25], [-0.75, 0.55],
    [1, -0.15], [1, 0.25], [0.75, 0.55],
    [-0.2, -0.6], [0.2, -0.6],
  ];
  for (const [dx, dy] of fronds) {
    const ex = tipX + dx * 62 * scale;
    const ey = tipY + dy * 52 * scale;
    const cx = tipX + dx * 34 * scale;
    const cy = tipY + dy * 10 * scale - 20 * scale;
    d += `<path d="M ${tipX} ${tipY} Q ${cx} ${cy}, ${ex} ${ey}" stroke="${fill}" stroke-width="${Math.max(1.5, 3.4 * scale)}" fill="none" opacity="${opacity}" stroke-linecap="round"/>`;
  }
  return d;
}

function pole(x, groundY, scale, fill, opacity) {
  const h = 190 * scale;
  const top = groundY - h;
  const armW = 34 * scale;
  return (
    `<path d="M ${x} ${groundY} L ${x} ${top}" stroke="${fill}" stroke-width="${Math.max(2, 4 * scale)}" opacity="${opacity}"/>` +
    `<path d="M ${x - armW} ${top + 16 * scale} L ${x + armW} ${top + 16 * scale}" stroke="${fill}" stroke-width="${Math.max(1.5, 3 * scale)}" opacity="${opacity}"/>` +
    `<path d="M ${x - armW * 0.7} ${top + 34 * scale} L ${x + armW * 0.7} ${top + 34 * scale}" stroke="${fill}" stroke-width="${Math.max(1.5, 3 * scale)}" opacity="${opacity}"/>`
  );
}

/** A ragged ridge line across the whole width. */
function ridge(seed, baseY, amp, fill, opacity) {
  const r = rng(seed);
  const step = 90;
  let d = `M 0 ${H} L 0 ${baseY}`;
  for (let x = 0; x <= W + step; x += step) {
    const y = baseY - r() * amp;
    d += ` L ${x} ${y.toFixed(1)}`;
  }
  d += ` L ${W} ${H} Z`;
  return `<path d="${d}" fill="${fill}" opacity="${opacity}"/>`;
}

/** A blocky skyline, the mid distance of a city at night. */
function skyline(seed, baseY, fill, opacity, lit) {
  const r = rng(seed);
  let out = "";
  let x = -40;
  while (x < W + 40) {
    const w = 40 + r() * 90;
    const h = 60 + r() * 210;
    const top = baseY - h;
    out += `<rect x="${x.toFixed(0)}" y="${top.toFixed(0)}" width="${w.toFixed(0)}" height="${(baseY - top).toFixed(0)}" fill="${fill}" opacity="${opacity}"/>`;
    if (lit) {
      // Sparse lit windows. Sparse is the point: a fully lit grid reads as a
      // spreadsheet rather than a city.
      for (let wy = top + 16; wy < baseY - 14; wy += 22) {
        for (let wx = x + 10; wx < x + w - 10; wx += 18) {
          if (r() > 0.82) {
            out += `<rect x="${wx.toFixed(0)}" y="${wy.toFixed(0)}" width="5" height="7" fill="${lit}" opacity="${(opacity * 1.6).toFixed(2)}"/>`;
          }
        }
      }
    }
    x += w + 6 + r() * 26;
  }
  return out;
}

function scene({ name, skyTop, skyMid, skyLow, sunColor, sunY, ridges, sky, props }) {
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice">`;
  s += `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">`;
  s += `<stop offset="0%" stop-color="${skyTop}"/>`;
  s += `<stop offset="55%" stop-color="${skyMid}"/>`;
  s += `<stop offset="100%" stop-color="${skyLow}"/>`;
  s += `</linearGradient>`;
  s += `<radialGradient id="glow" cx="50%" cy="50%" r="50%">`;
  s += `<stop offset="0%" stop-color="${sunColor}" stop-opacity="0.55"/>`;
  s += `<stop offset="100%" stop-color="${sunColor}" stop-opacity="0"/>`;
  s += `</radialGradient></defs>`;

  s += `<rect width="${W}" height="${H}" fill="url(#sky)"/>`;

  // The sun and its haze.
  const sunX = W * 0.68;
  s += `<circle cx="${sunX}" cy="${sunY}" r="300" fill="url(#glow)"/>`;
  s += `<circle cx="${sunX}" cy="${sunY}" r="46" fill="${sunColor}" opacity="0.5"/>`;

  if (sky) s += sky;

  for (const rg of ridges) s += rg;
  for (const p of props) s += p;

  // Haze along the horizon, which is what stops the silhouettes looking pasted on.
  s += `<rect x="0" y="${H * 0.62}" width="${W}" height="${H * 0.38}" fill="${skyLow}" opacity="0.35"/>`;

  s += `</svg>`;
  return { name, svg: s };
}

const OUT = path.join(__dirname, "..", "apps", "web", "public", "bg");
fs.mkdirSync(OUT, { recursive: true });

const scenes = [];

// The landing page: desert at dusk, ridge line, palms and a power pole.
scenes.push(
  scene({
    name: "desert",
    skyTop: "#0e1109",
    skyMid: "#2a2416",
    skyLow: "#4a3a22",
    sunColor: "#f5c542",
    sunY: 470,
    ridges: [
      ridge(9001, 560, 70, "#1d2113", 0.85),
      ridge(4242, 640, 46, "#141709", 0.9),
    ],
    props: [
      palm(150, 720, 1.15, "#0e1109", 0.85),
      palm(255, 700, 0.8, "#0e1109", 0.7),
      pole(1180, 700, 1.0, "#0e1109", 0.6),
      palm(1420, 730, 1.3, "#0e1109", 0.9),
    ],
  })
);

// The app shell: a city at night, quieter, so dense UI sits on top of it.
scenes.push(
  scene({
    name: "city",
    skyTop: "#0b0d10",
    skyMid: "#151a20",
    skyLow: "#232b2e",
    sunColor: "#6ea9d8",
    sunY: 520,
    ridges: [],
    sky: skyline(777, 690, "#0e1216", 0.9, "#f5c542"),
    props: [pole(120, 760, 0.9, "#080a0c", 0.55), palm(1500, 780, 1.0, "#080a0c", 0.6)],
  })
);

for (const s of scenes) {
  const file = path.join(OUT, `${s.name}.svg`);
  fs.writeFileSync(file, s.svg);
  console.log(`apps/web/public/bg/${s.name}.svg  ${(s.svg.length / 1024).toFixed(1)} KB`);
}

// A contact sheet, so the artwork can be judged before it goes behind anything.
const sheet =
  `<!doctype html><meta charset="utf-8"><title>Backdrops</title>` +
  `<style>body{margin:0;background:#0e1109;color:#f4f1e0;font:15px 'Segoe UI',Arial,sans-serif;padding:40px}` +
  `h1{font:900 36px 'Arial Black',sans-serif;text-transform:uppercase;color:#f5c542;margin:0 0 26px}` +
  `.c{margin-bottom:34px;border:1px solid #414d2e}` +
  `.c img{display:block;width:100%;height:auto}` +
  `.n{padding:10px 14px;font-family:Consolas,monospace;font-size:13px;color:#b9b89a;background:#161a0f}` +
  `.demo{position:relative}` +
  `.demo .ov{position:absolute;inset:0;display:flex;align-items:center;padding:0 60px}` +
  `.demo h2{font:900 54px 'Arial Black',sans-serif;text-transform:uppercase;color:#f4f1e0;text-shadow:2px 2px 0 rgba(0,0,0,.85);margin:0;max-width:16ch}` +
  `</style><h1>Backdrops</h1>` +
  scenes
    .map(
      (s) =>
        `<div class="c"><div class="demo"><img src="bg/${s.name}.svg" alt="">` +
        `<div class="ov"><h2>Text has to stay readable on top</h2></div></div>` +
        `<div class="n">${s.name}.svg</div></div>`
    )
    .join("");
fs.writeFileSync(path.join(OUT, "..", "backdrops.html"), sheet);
console.log("apps/web/public/backdrops.html  contact sheet");

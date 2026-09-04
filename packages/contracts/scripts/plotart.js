/**
 * Pulls plot art off the chain and writes it to disk.
 *
 * Nothing here generates the image. It calls tokenURI, decodes the base64 the
 * contract returned, and saves exactly what a wallet would render, which is the
 * only honest way to check that on chain art actually works.
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const a = JSON.parse(fs.readFileSync(file, "utf8")).addresses;
  const plot = await ethers.getContractAt("Plot", a.plot);

  const outDir = path.join(__dirname, "..", "art");
  fs.mkdirSync(outDir, { recursive: true });

  const supply = await plot.totalSupply();
  console.log(`\n${supply} plots on chain.\n`);

  const cells = [];
  for (let i = 0; i < supply; i++) {
    const id = await plot.tokenOfOwnerByIndex(await plot.ownerOf(await plot.tokenByIndex(i)), 0).catch(() => null);
    const plotId = await plot.tokenByIndex(i);
    const info = await plot.info(plotId);
    const uri = await plot.tokenURI(plotId);

    const json = JSON.parse(
      Buffer.from(uri.slice("data:application/json;base64,".length), "base64").toString("utf8")
    );
    const svg = Buffer.from(
      json.image.slice("data:image/svg+xml;base64,".length), "base64"
    ).toString("utf8");

    const name = `plot-${plotId}.svg`;
    fs.writeFileSync(path.join(outDir, name), svg);
    cells.push({ plotId, name, json, svg });

    console.log(
      `  ${json.name.padEnd(26)} tier ${info.tier}  ${svg.length} bytes  ${(svg.match(/<rect/g) || []).length} rects`
    );
    void id;
  }

  // A contact sheet, so the whole collection can be eyeballed at once.
  const sheet =
    "<!doctype html><meta charset='utf-8'><title>HESOYAM CANOPY plots</title>" +
    "<style>body{background:#0e1109;color:#f4f1e0;font:14px system-ui;margin:0;padding:32px}" +
    "h1{font:400 28px/1 system-ui;letter-spacing:.02em;text-transform:uppercase}" +
    ".g{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:20px;margin-top:24px}" +
    ".c{background:#161a0f;border:1px solid #414d2e;padding:12px}" +
    ".c svg{width:100%;height:auto;display:block;image-rendering:pixelated}" +
    ".n{margin-top:10px;font-size:12px;color:#b9b89a}</style>" +
    "<h1>Plots, rendered from chain</h1><div class='g'>" +
    cells
      .map((c) => `<div class='c'>${c.svg}<div class='n'>${c.json.name}</div></div>`)
      .join("") +
    "</div>";
  fs.writeFileSync(path.join(outDir, "index.html"), sheet);

  console.log(`\nWrote ${cells.length} SVGs and a contact sheet to packages/contracts/art\n`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

/* Fails the build when coverage drops below the floor.
   Floors sit a little under the current numbers so a small refactor does not break
   CI, but a whole untested contract does. Raise them, never lower them. */
const fs = require("fs");
const path = require("path");

const FLOORS = { statements: 95, lines: 93, functions: 95, branches: 65 };
const file = path.join(__dirname, "..", "coverage", "coverage-summary.json");

if (!fs.existsSync(file)) {
  console.error("No coverage summary at " + file + ". Run `npm run coverage` first.");
  process.exit(1);
}

const total = JSON.parse(fs.readFileSync(file, "utf8")).total;
let failed = false;

for (const [key, floor] of Object.entries(FLOORS)) {
  const pct = total[key].pct;
  const ok = pct >= floor;
  if (!ok) failed = true;
  console.log(
    (ok ? "  ok   " : "  FAIL ") +
      key.padEnd(11) +
      String(pct).padStart(6) +
      "%  floor " +
      String(floor) +
      "%"
  );
}

process.exit(failed ? 1 : 0);

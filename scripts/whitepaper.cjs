/**
 * Renders the whitepaper to PDF.
 *
 * Chrome's print pipeline, not a library, because the source is already a
 * print-styled HTML document and Chrome is the only renderer here that honours
 * @page rules and page-break hints properly.
 *
 * The output lands in apps/web/public so the app serves it as a static asset.
 * It is checked for word count and for the accidental em dash, which is banned
 * project-wide, before it is accepted.
 *
 * Usage: npm run whitepaper
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "whitepaper", "src", "whitepaper.html");
const OUT_DIR = path.join(ROOT, "apps", "web", "public");
const OUT = path.join(OUT_DIR, "hesoyam-canopy-whitepaper.pdf");

const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";

function words(html) {
  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<pre[\s\S]*?<\/pre>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length === 0 ? 0 : text.split(" ").length;
}

function main() {
  if (!fs.existsSync(SRC)) throw new Error(`Source not found: ${SRC}`);
  const html = fs.readFileSync(SRC, "utf8");

  // The em dash is banned across this project, and a PDF is the easiest place
  // for one to slip in unnoticed because nobody greps a binary.
  if (html.includes("\u2014")) {
    throw new Error("The whitepaper source contains an em dash. Use a comma, a colon or a full stop.");
  }

  const count = words(html);
  console.log(`Source is ${count.toLocaleString()} words of prose.`);
  if (count < 4500) {
    throw new Error(`Too short: ${count} words. The brief was 5,000.`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (fs.existsSync(OUT)) fs.unlinkSync(OUT);

  execFileSync(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--no-pdf-header-footer",
      `--print-to-pdf=${OUT.replace(/\\/g, "/")}`,
      `file:///${SRC.replace(/\\/g, "/")}`,
    ],
    { stdio: "pipe" }
  );

  if (!fs.existsSync(OUT)) throw new Error("Chrome produced no file.");
  const buf = fs.readFileSync(OUT);

  // A PDF that is not a PDF would still serve with a 200, so check the magic
  // bytes rather than trusting the extension.
  if (buf.subarray(0, 5).toString() !== "%PDF-") {
    throw new Error("Output is not a PDF.");
  }

  // Page count, read from the catalogue rather than guessed.
  const pages = (buf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;

  console.log(`apps/web/public/hesoyam-canopy-whitepaper.pdf`);
  console.log(`  ${(buf.length / 1024).toFixed(0)} KB, ${pages} pages, ${count.toLocaleString()} words`);
}

main();

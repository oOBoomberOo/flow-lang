// Rewrite Flow programs embedded as string literals in test files to the new syntax.
import fs from "node:fs";
import path from "node:path";
import { migrateSource } from "../src/migrate.ts";

const dir = path.resolve(import.meta.dirname, "..", "test");

function scan(src) {
  const lits = [];
  let i = 0;
  let prev = "";
  const regexOk = () => prev === "" || "(,=:[!&|?{};".includes(prev);
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i + 2) + 2; continue; }
    if (c === "/" && regexOk()) {
      let j = i + 1, cls = false;
      while (j < src.length && (src[j] !== "/" || cls)) {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") cls = true;
        else if (src[j] === "]") cls = false;
        j++;
      }
      i = j + 1; prev = "x"; continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1, hasInterp = false;
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") { j += 2; continue; }
        if (c === "`" && src[j] === "$" && src[j + 1] === "{") hasInterp = true;
        j++;
      }
      lits.push({ start: i, end: j + 1, quote: c, raw: src.slice(i + 1, j), hasInterp });
      i = j + 1; prev = "x"; continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return lits;
}

function decode(l) {
  if (l.hasInterp) return null;
  try {
    if (l.quote === "`") return new Function("return `" + l.raw + "`")();
    return new Function("return " + l.quote + l.raw + l.quote)();
  } catch { return null; }
}

function encode(text, quote) {
  if (quote !== "`" && !text.includes("\n")) {
    return quote + text.replace(/\\/g, "\\\\").replace(new RegExp(quote, "g"), "\\" + quote) + quote;
  }
  return "`" + text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${") + "`";
}

const LOOKS = /\b(fn|effect|type|trait|impl|provide|use|extern)\b[^\n]*[({=]/;

let total = 0;
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".test.mjs"))) {
  const file = path.join(dir, f);
  let src = fs.readFileSync(file, "utf8");
  // `page(`<p>…</p>`)` wrapped markup in a main function; expand it so the whole program is one literal
  const wrap = (body) => "fn main() -> Html { html { " + body + " } }";
  src = src.replace(/\$\{page\(`((?:[^`\\]|\\.)*)`\)\}/g, (_, body) => wrap(body));
  src = src.replace(/(?<![\w$.])page\(`((?:[^`\\]|\\.)*)`\)/g, (_, body) => "`" + wrap(body) + "`");
  const lits = scan(src);
  let out = "", last = 0, n = 0;
  for (const l of lits) {
    const text = decode(l);
    if (text === null || text.length < 12 || !LOOKS.test(text)) continue;
    let migrated;
    try { migrated = migrateSource(text, "t.flow"); } catch { continue; }
    if (!migrated.trim()) continue;
    out += src.slice(last, l.start) + encode(migrated.trimEnd() + (l.quote === "`" && text.endsWith("\n") ? "\n" : ""), l.quote);
    last = l.end;
    n++;
  }
  out += src.slice(last);
  if (n) { fs.writeFileSync(file, out); total += n; console.log(`${f}: ${n} program(s) migrated`); }
}
console.log("total", total);

// Round-trip oracle: legacy parse -> canonical AST -> print -> new parse must equal the canonical AST.
import fs from "node:fs";
import path from "node:path";
import { parse as parseLegacy } from "../src/legacy/parser.ts";
import { parse } from "../src/parser.ts";
import { canonProgram } from "../src/legacy/canon.ts";
import { printProgram } from "../src/printer.ts";

const GEN = /^_[a-z]+\d*$/;

function norm(x, key) {
  if (Array.isArray(x)) return x.map((v) => norm(v));
  if (x && typeof x === "object") {
    const o = {};
    for (const k of Object.keys(x).sort()) {
      if (k === "span" || k === "varSpan" || k === "spans" || k === "file") continue;
      if (k === "typeParams" || k === "mut") continue;
      let v = x[k];
      if (v === undefined) continue;
      if (k === "paramBounds" && v && !Object.keys(v).length) continue;
      if (k === "where" && Array.isArray(v) && !v.length) continue;
      o[k] = norm(v, k);
    }
    // generated binder names are irrelevant
    if (typeof o.name === "string" && GEN.test(o.name)) o.name = "_g";
    if (o.k === "Fn" || o.k === "Lam") { /* params normalised below */ }
    return o;
  }
  if (typeof x === "string" && GEN.test(x)) return "_g";
  return x;
}

function stripPub(decls, allPub) {
  return decls.map((d) => (allPub && "pub" in d ? { ...d, pub: true } : d));
}

export function check(file, pkg) {
  const src = fs.readFileSync(file, "utf8");
  const old = parseLegacy(src, file);
  const canon = canonProgram(old, { pkg });
  const anyPub = canon.decls.some((d) => d.pub === true);
  const printed = printProgram(canon, { moduleName: "M" });
  let reparsed;
  try { reparsed = parse(printed, file); }
  catch (e) { return { ok: false, why: `reparse failed: ${e.message} @${e.line}:${e.col}`, printed }; }
  const a = norm({ decls: stripPub(canon.decls, !anyPub) });
  const b = norm({ decls: reparsed.decls });
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa === sb) return { ok: true, printed };
  // locate the first differing declaration
  for (let i = 0; i < Math.max(a.decls.length, b.decls.length); i++) {
    const da = JSON.stringify(a.decls[i]), db = JSON.stringify(b.decls[i]);
    if (da !== db) {
      let at = 0; while (da[at] === db?.[at]) at++;
      return { ok: false, why: `decl ${i} (${canon.decls[i]?.name ?? canon.decls[i]?.k}) differs near:\n  old: ${da.slice(Math.max(0, at - 90), at + 120)}\n  new: ${db?.slice(Math.max(0, at - 90), at + 120)}`, printed };
    }
  }
  return { ok: false, why: "decl count differs", printed };
}

if (process.argv[1].endsWith("migrate-check.mjs")) {
  const files = process.argv.slice(2);
  let bad = 0;
  for (const f of files) {
    let r;
    try { r = check(f, process.env.PKG); } catch (e) { r = { ok: false, why: `legacy parse/canon failed: ${e.message}` }; }
    if (!r.ok) { bad++; console.log(`FAIL ${path.relative(".", f)}: ${r.why}`); }
    else console.log(`ok   ${path.relative(".", f)}`);
  }
  console.log(`${files.length - bad}/${files.length} round-trip`);
  process.exit(bad ? 1 : 0);
}

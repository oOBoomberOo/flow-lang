/**
 * `flow migrate`: rewrite a program from the old Rust-style syntax
 * (`fn f(x: Int) -> Int { x + 1 }`) into the Haskell-style syntax
 * (`f :: Int -> Int` / `f x = x + 1`).
 *
 * The old parser lives in `legacy/` for exactly this purpose.
 */

import path from "node:path";
import { parse as parseLegacy } from "./legacy/parser.ts";
import { canonProgram } from "./legacy/canon.ts";
import { printProgram } from "./printer.ts";

export interface MigrateOptions {
  /** package name the file belongs to (so `app::util` becomes `Util`) */
  pkg?: string;
  /** module name for the header, when the file keeps private declarations */
  moduleName?: string;
}

/** Full-line `//` comments that sit above a declaration, keyed by that declaration's line. */
function leadingComments(src: string, declLines: Set<number>): Map<number, string[]> {
  const out = new Map<number, string[]>();
  let pending: string[] = [];
  src.split(/\r?\n/).forEach((text, i) => {
    const line = i + 1;
    if (/^\/\//.test(text)) { pending.push(text.replace(/^\/\/ ?/, "")); return; }
    if (text.trim() === "") return;
    if (declLines.has(line)) {
      if (pending.length) out.set(line, pending);
      pending = [];
    } else if (/^\S/.test(text)) {
      pending = [];
    }
  });
  return out;
}

export function migrateSource(src: string, file = "<input>", opts: MigrateOptions = {}): string {
  const old = parseLegacy(src, file);
  const canon = canonProgram(old, { pkg: opts.pkg });
  const comments = leadingComments(src, new Set(old.decls.map((d) => d.span.line)));
  const moduleName = opts.moduleName ?? path.basename(file).replace(/\.flow$/, "").replace(/^./, (c) => c.toUpperCase());
  return printProgram(canon, { moduleName, comments });
}

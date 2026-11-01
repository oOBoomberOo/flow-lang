/**
 * Semantic tokens for Flow.
 *
 * The interesting distinction in Flow is not the syntax kind of a name but
 * *where it runs*. Every symbol is therefore tagged with the tier or the cut
 * that owns it:
 *
 *   client / server   ordinary typed code
 *   cut1 ... cut12    code the compiler moved across the boundary
 *   crossing          an expression that mixes both sides
 *   dependency        a free variable a cut carries from its enclosing scope
 *
 * A cut dependency keeps the colour of the scope it belongs to (the enclosing
 * cut or function) and gains `dependency` so an editor can underline it: it
 * crosses *into* the cut but still belongs *outside* it.
 *
 * A palette, not an arbitrary colour per token, is the portable model: the
 * LSP semantic-token legend is fixed for the lifetime of the server session,
 * so cuts beyond the palette cycle back to its first colour.
 */

import path from "node:path";
import type { Region } from "../analysis.ts";
import { lex } from "../lexer.ts";
import type { Token } from "../lexer.ts";

export const CUT_PALETTE_SIZE = 12;

export const TOKEN_TYPES = [
  "keyword", "function", "variable", "type", "class", "string", "number",
  "comment", "operator", "parameter", "property", "namespace",
];

export const TOKEN_MODIFIERS = [
  "client", "server", "cut", "crossing", "dependency",
  ...Array.from({ length: CUT_PALETTE_SIZE }, (_, i) => `cut${i + 1}`),
];

export const SEMANTIC_LEGEND = {
  tokenTypes: TOKEN_TYPES,
  tokenModifiers: TOKEN_MODIFIERS,
};

const TYPE = {
  keyword: 0,
  function: 1,
  variable: 2,
  type: 3,
  class: 4,
  string: 5,
  number: 6,
  comment: 7,
  operator: 8,
  parameter: 9,
  property: 10,
  namespace: 11,
} as const;

/** Token types that describe a symbol and therefore get a boundary colour. */
const SYMBOL_TYPES = new Set<number>([
  TYPE.function, TYPE.variable, TYPE.type, TYPE.class,
  TYPE.parameter, TYPE.property, TYPE.namespace,
]);

const MOD_BIT = new Map(TOKEN_MODIFIERS.map((name, i) => [name, 1 << i]));
const mod = (name: string): number => MOD_BIT.get(name) ?? 0;

/** 1-based palette slot for a cut id (`cut1` -> 1, `cut13` -> 1). */
export function cutSlot(cutId: string | undefined): number {
  const n = Number((cutId ?? "").replace(/\D+/g, ""));
  return n > 0 ? ((n - 1) % CUT_PALETTE_SIZE) + 1 : 1;
}

/** Palette modifier name for a cut id: `cut7`. */
export function cutColorKey(cutId: string | undefined): string {
  return `cut${cutSlot(cutId)}`;
}

function classify(t: Token, prev: Token | undefined, next: Token | undefined): number {
  switch (t.kind) {
    case "kw": return TYPE.keyword;
    case "str": return TYPE.string;
    case "num":
    case "float": return TYPE.number;
    case "op":
    case "sym": return TYPE.operator;
    case "Con":
      // `Flow.List.map`: a capitalised name followed by `.` is a namespace.
      return next?.value === "." ? TYPE.namespace : TYPE.type;
    case "id":
      if (next && (next.value === "::" || next.value === "=")) return TYPE.function;
      if (next && next.value === "(") return TYPE.function;
      if (prev && prev.value === "\\") return TYPE.parameter;
      if (prev && prev.value === ".") return TYPE.property;
      if (prev && (prev.value === "->" || prev.value === "|")) return TYPE.type;
      return TYPE.variable;
    default:
      return -1;
  }
}

function contains(region: Region, line: number, character: number): boolean {
  const s = region.range.start;
  const e = region.range.end;
  const after = line > s.line || (line === s.line && character >= s.character);
  const before = line < e.line || (line === e.line && character <= e.character);
  return after && before;
}

function spanSize(region: Region): number {
  const s = region.range.start;
  const e = region.range.end;
  return (e.line - s.line) * 1_000_000 + (e.character - s.character);
}

/** Regions containing a position, outermost first. */
function stackAt(regions: Region[], line: number, character: number): Region[] {
  return regions
    .filter((r) => contains(r, line, character))
    .sort((a, b) => spanSize(b) - spanSize(a));
}

function colorMods(region: Region | undefined): number {
  if (!region) return 0;
  if (region.kind === "cut") return mod(cutColorKey(region.cutId));
  if (region.kind === "crossing") return mod("crossing");
  if (region.side === "client") return mod("client");
  if (region.side === "server") return mod("server");
  return 0;
}

export interface SemanticToken {
  line: number;
  char: number;
  len: number;
  type: number;
  mods: number;
}

/**
 * Build the full semantic-token stream for one file.
 *
 * `text` is the live buffer (the editor may be mid-edit); `regions` is the
 * last analysis of the package. Syntax tokens always come from the buffer, so
 * highlighting keeps working while a declaration is broken.
 */
export function semanticTokensFor(
  text: string,
  file: string,
  allRegions: Region[],
): { data: number[]; tokens: SemanticToken[] } {
  const target = path.resolve(file);
  const regions = allRegions.filter((r) => path.resolve(r.file) === target);
  const toks: SemanticToken[] = [];

  let lexed: Token[] = [];
  try {
    lexed = lex(text, file);
  } catch {
    lexed = [];
  }

  for (let i = 0; i < lexed.length; i++) {
    const t = lexed[i]!;
    if (t.kind === "eof") continue;
    const prev = lexed[i - 1];
    const next = lexed[i + 1];
    const type = classify(t, prev, next);
    if (type < 0) continue;

    let mods = 0;
    if (SYMBOL_TYPES.has(type)) {
      const stack = stackAt(regions, t.line - 1, t.col - 1);
      const cut = [...stack].reverse().find((r) => r.kind === "cut");
      if (cut) {
        const owner = stack[stack.lastIndexOf(cut) - 1];
        // A dependency is a *reference* to a free variable: `todo.title` is a
        // field access, `title = ...` is a record field label or a binding, and
        // `\title ->` binds a new name. None of those are carried across.
        const isBinding = next?.value === "=" || next?.value === "::";
        const isDep = t.kind === "id"
          && !isBinding
          && prev?.value !== "."
          && prev?.value !== "\\"
          && (cut.deps ?? []).includes(t.value);
        if (isDep && owner) {
          // The dependency belongs to the enclosing scope and crosses in.
          mods |= mod("dependency") | colorMods(owner);
        } else {
          mods |= mod("cut") | mod(cutColorKey(cut.cutId));
        }
      } else {
        const crossing = [...stack].reverse().find((r) => r.kind === "crossing");
        if (crossing) {
          mods |= mod("crossing");
        } else {
          const fn = [...stack].reverse().find((r) => r.kind === "function");
          mods |= colorMods(fn);
        }
      }
    }

    toks.push({
      line: t.line - 1,
      char: t.col - 1,
      len: t.value.length,
      type,
      mods,
    });
  }

  const re = /--[^\n]*|\{-[\s\S]*?-\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(0, m.index);
    const line = before.split("\n").length - 1;
    toks.push({
      line,
      char: m.index - (before.lastIndexOf("\n") + 1),
      len: m[0].length,
      type: TYPE.comment,
      mods: 0,
    });
  }

  toks.sort((a, b) => a.line - b.line || a.char - b.char);
  const data: number[] = [];
  let pl = 0;
  let pc = 0;
  for (const t of toks) {
    const dl = t.line - pl;
    data.push(dl, dl === 0 ? t.char - pc : t.char, t.len, t.type, t.mods);
    pl = t.line;
    pc = t.char;
  }
  return { data, tokens: toks };
}

/**
 * Flow — editor analysis.
 *
 * Turns a package (or file) into everything an editor needs: diagnostics,
 * placement regions, typed nodes and a symbol index. All of it is derived from
 * one compile, so hover/completion/definitions can never disagree with the
 * compiler.
 */

import fs from "node:fs";
import path from "node:path";
import { compileFile } from "./compile.ts";
import { FlowError } from "./lexer.ts";
import { prune, typeStr } from "./types.ts";
import type { Type } from "./types.ts";
import type { Program, Span } from "./ast.ts";
import type { Place } from "./types.ts";
import type { SymKind } from "./modules.ts";

export interface Position { line: number; character: number }
export interface Range { start: Position; end: Position }

export interface Diagnostic { file: string; range: Range; message: string; code: string; severity: 1 }

export type RegionKind = "function" | "cut" | "expression";

export interface Region {
  file: string;
  range: Range;
  side: "client" | "server" | "neutral";
  kind: RegionKind;
  label: string;
}

export interface SignatureInfo {
  name: string;
  params: { name: string; type: string }[];
  ret: string;
  effects: string[];
}

export interface NodeInfo {
  file: string;
  range: Range;
  type: string;
  place: Place;
  effects: string[];
  /** the identifier this node references, if it is a Var or a constructor */
  ident?: string;
  /** record fields, when the node's type is a record */
  fields?: string[];
  /** element type, when the node's type is Cell<a> */
  cellElem?: string;
  /** callable signature, when the node is a call */
  signature?: SignatureInfo;
}

export interface SymbolInfo {
  name: string;
  display: string;
  finalName: string;
  kind: SymKind;
  file: string;
  range: Range;
}

export interface Analysis {
  ok: boolean;
  entry: string;
  entryUnit?: string;
  diagnostics: Diagnostic[];
  regions: Region[];
  nodes: NodeInfo[];
  symbols: SymbolInfo[];
  units: { id: string; file: string }[];
  program?: Program;
  display?: Map<string, string>;
  importedByFile?: Map<string, Set<string>>;
}

export function readSource(file: string, overlay?: Map<string, string>): string {
  const abs = path.resolve(file);
  if (overlay?.has(abs)) return overlay.get(abs)!;
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return "";
  }
}

export function offsetToPosition(src: string, offset: number): Position {
  let line = 0, character = 0;
  const end = Math.min(offset, src.length);
  for (let i = 0; i < end; i++) {
    if (src[i] === "\n") { line++; character = 0; } else { character++; }
  }
  return { line, character };
}

export function spanRange(src: string, span: Span): Range {
  const start = span.line != null
    ? { line: span.line - 1, character: span.col - 1 }
    : offsetToPosition(src, span.start);
  return { start, end: offsetToPosition(src, span.end) };
}

export function analyze(entry: string, overlay?: Map<string, string>): Analysis {
  const abs = path.resolve(entry);

  try {
    const result = compileFile(abs, { overlay, collectErrors: true, requireMain: false });
    const srcCache = new Map<string, string>();
    const srcFor = (file: string) => {
      let s = srcCache.get(file);
      if (s === undefined) { s = readSource(file, overlay); srcCache.set(file, s); }
      return s;
    };

    const nodes: NodeInfo[] = [];
    const signatures = new Map<string, SignatureInfo>();
    for (const [name, fn] of result.mod.fns) {
      if (fn.scheme.k !== "fun") continue;
      signatures.set(name, {
        name,
        params: fn.params.map((p, i) => ({ name: p.name, type: typeStr(fn.scheme.k === "fun" ? fn.scheme.params[i]! : p.type as never) })),
        ret: typeStr(fn.scheme.ret),
        effects: [...fn.scheme.eff.labels].sort(),
      });
    }

    for (const [node, info] of result.mod.info) {
      const span = (node as { span?: Span }).span;
      if (!span || !span.file) continue;
      const src = srcFor(span.file);
      const ty = prune(info.ty);
      const entry: NodeInfo = {
        file: span.file,
        range: spanRange(src, span),
        type: typeStr(ty),
        place: info.place,
        effects: [...info.eff.labels].sort(),
      };

      const k = (node as { k?: string }).k;
      if (k === "Var" || k === "Ctor" || k === "Component") entry.ident = (node as { name: string }).name;
      if (k === "App") {
        const fnNode = (node as { fn: { k: string; name?: string } }).fn;
        if (fnNode.k === "Var" || fnNode.k === "Ctor") {
          const sig = signatures.get(fnNode.name ?? "");
          if (sig) entry.signature = sig;
        }
      }
      if (ty.k === "rec") entry.fields = Object.keys(ty.fields);
      if (ty.k === "con" && ty.name === "Cell") entry.cellElem = typeStr(ty.args[0]!);
      nodes.push(entry);
    }

    const symbols: SymbolInfo[] = [];
    for (const [finalName, sym] of result.symbols ?? []) {
      const src = srcFor(sym.file);
      symbols.push({
        name: sym.name,
        display: result.display?.get(finalName) ?? sym.name,
        finalName,
        kind: sym.kind,
        file: sym.file,
        range: spanRange(src, sym.span),
      });
    }

    const regions: Region[] = [];
    if (result.codegen) {
      for (const [name, fn] of result.mod.fns) {
        if (fn.synthetic) continue;
        const origin = result.display?.get(name) ?? name;
        if (origin.startsWith("std::")) continue;
        const h = result.codegen.home(fn.body);
        if (h === "neutral") continue;
        const src = srcFor(fn.body.span.file ?? abs);
        regions.push({
          file: fn.body.span.file ?? abs,
          range: spanRange(src, fn.span ?? fn.body.span),
          side: h,
          kind: "function",
          label: `${origin} runs on ${h}`,
        });
      }
      for (const cut of result.codegen.cutList) {
        const span = (cut.node as { span: Span }).span;
        if (!span?.file) continue;
        const src = srcFor(span.file);
        regions.push({
          file: span.file,
          range: spanRange(src, span),
          side: cut.home,
          kind: "cut",
          label: `${cut.mode} cut ${cut.id} → ${cut.home}` + (cut.deps.length ? ` (deps: ${cut.deps.join(", ")})` : ""),
        });
      }
    }

    const diagnostics: Diagnostic[] = (result.errors ?? []).map((e) => {
      const file = e.file ?? abs;
      const src = srcFor(file);
      const line = Math.max(0, (e.line ?? 1) - 1);
      const character = Math.max(0, (e.col ?? 1) - 1);
      const lineText = src.split(/\r?\n/)[line] ?? "";
      return {
        file,
        range: { start: { line, character }, end: { line, character: Math.max(character + 1, lineText.length) } },
        message: e.message,
        code: e.code ?? "E_TYPE",
        severity: 1 as const,
      };
    });

    return {
      ok: diagnostics.length === 0,
      entry: abs,
      entryUnit: result.units[0]?.id,
      diagnostics,
      regions,
      nodes,
      symbols,
      units: result.units,
      program: result.program,
      display: result.display,
      importedByFile: result.importedByFile,
    };
  } catch (e) {
    if (!(e instanceof FlowError)) throw e;
    const file = e.file ?? abs;
    const src = readSource(file, overlay);
    const line = Math.max(0, (e.line ?? 1) - 1);
    const character = Math.max(0, (e.col ?? 1) - 1);
    const lineText = src.split(/\r?\n/)[line] ?? "";
    return {
      ok: false,
      entry: abs,
      diagnostics: [{
        file,
        range: { start: { line, character }, end: { line, character: Math.max(character + 1, lineText.length) } },
        message: e.message,
        code: e.code ?? "E_TYPE",
        severity: 1,
      }],
      regions: [],
      nodes: [],
      symbols: [],
      units: [],
    };
  }
}

export function findNodeAt(a: Analysis, file: string, pos: Position): NodeInfo | null {
  let best: NodeInfo | null = null;
  for (const n of a.nodes) {
    if (path.resolve(n.file) !== path.resolve(file)) continue;
    if (!contains(n.range, pos)) continue;
    if (!best || size(n.range) < size(best.range)) best = n;
  }
  return best;
}

function contains(r: Range, p: Position): boolean {
  const after = p.line > r.start.line || (p.line === r.start.line && p.character >= r.start.character);
  const before = p.line < r.end.line || (p.line === r.end.line && p.character <= r.end.character);
  return after && before;
}

function size(r: Range): number {
  return (r.end.line - r.start.line) * 100000 + (r.end.character - r.start.character);
}

export type { Type, SymKind };

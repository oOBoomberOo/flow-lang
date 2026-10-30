/**
 * Flow — editor analysis.
 *
 * One place that turns a package (or file) into what an editor needs:
 *   • diagnostics with precise positions
 *   • placement regions (the client/server boundary, per file)
 *   • typed nodes for hover
 *
 * Used by the LSP server and by the tests that exercise it.
 */

import fs from "node:fs";
import path from "node:path";
import { compileFile } from "./compile.ts";
import { FlowError } from "./lexer.ts";
import { prune, typeStr, type Type } from "./types.ts";
import type { Span } from "./ast.ts";
import type { Place } from "./types.ts";

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

export interface NodeInfo {
  file: string;
  range: Range;
  type: string;
  place: Place;
  effects: string[];
}

export interface Analysis {
  ok: boolean;
  entry: string;
  diagnostics: Diagnostic[];
  regions: Region[];
  nodes: NodeInfo[];
  units: { id: string; file: string }[];
}

const builtinSources = new Map<string, string>();

export function readSource(file: string, overlay?: Map<string, string>): string {
  const abs = path.resolve(file);
  if (overlay?.has(abs)) return overlay.get(abs)!;
  if (builtinSources.has(abs)) return builtinSources.get(abs)!;
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return "";
  }
}

export function offsetToPosition(src: string, offset: number): Position {
  let line = 0;
  let character = 0;
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
  const src = readSource(abs, overlay);

  try {
    const result = compileFile(abs, { overlay });
    const regions: Region[] = [];
    const nodes: NodeInfo[] = [];

    for (const [node, info] of result.mod.info) {
      const span = (node as { span?: Span }).span;
      if (!span || !span.file) continue;
      const fileSrc = readSource(span.file, overlay);
      const range = spanRange(fileSrc, span);
      nodes.push({
        file: span.file,
        range,
        type: typeStr(prune(info.ty)),
        place: info.place,
        effects: [...info.eff.labels].sort(),
      });
    }

    for (const [name, fn] of result.mod.fns) {
      if (fn.synthetic) continue;
      const origin = result.display?.get(name) ?? name;
      if (origin.startsWith("std::")) continue;      // library internals are not the user's boundary
      const h = result.codegen.home(fn.body);
      if (h === "neutral") continue;                 // runs on both sides: nothing to colour
      const fileSrc = readSource(fn.body.span.file ?? abs, overlay);
      regions.push({
        file: fn.body.span.file ?? abs,
        range: spanRange(fileSrc, fn.span ?? fn.body.span),
        side: h,
        kind: "function",
        label: `${origin} runs on ${h}`,
      });
    }

    for (const cut of result.codegen.cutList) {
      const span = (cut.node as { span: Span }).span;
      if (!span?.file) continue;
      const fileSrc = readSource(span.file, overlay);
      regions.push({
        file: span.file,
        range: spanRange(fileSrc, span),
        side: cut.home,
        kind: "cut",
        label: `${cut.mode} cut ${cut.id} → ${cut.home}` + (cut.deps.length ? ` (deps: ${cut.deps.join(", ")})` : ""),
      });
    }

    return {
      ok: true,
      entry: abs,
      diagnostics: [],
      regions,
      nodes,
      units: result.units,
    };
  } catch (e) {
    if (!(e instanceof FlowError)) throw e;
    const file = e.file ?? abs;
    const srcForFile = readSource(file, overlay);
    const line = Math.max(0, (e.line ?? 1) - 1);
    const character = Math.max(0, (e.col ?? 1) - 1);
    const lineText = srcForFile.split(/\r?\n/)[line] ?? "";
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
  const afterStart = p.line > r.start.line || (p.line === r.start.line && p.character >= r.start.character);
  const beforeEnd = p.line < r.end.line || (p.line === r.end.line && p.character <= r.end.character);
  return afterStart && beforeEnd;
}

function size(r: Range): number {
  return (r.end.line - r.start.line) * 100000 + (r.end.character - r.start.character);
}

export type { Type };

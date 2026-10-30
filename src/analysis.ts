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

export type RegionKind = "function" | "cut" | "crossing" | "expression";

export interface Region {
  file: string;
  range: Range;
  side: "client" | "server" | "neutral";
  kind: RegionKind;
  label: string;
  /** For a cut/crossing: which way the tier boundary is crossed, e.g. `client→server`. */
  direction?: string;
  /** Cut identity, when this region is an inferred cut. */
  cutId?: string;
  /** How the cut is driven: a reactive edge or a request/response call. */
  mode?: "reactive" | "call";
  /** Free variables carried across the boundary. */
  deps?: string[];
  /** The boundary value's type, when known. */
  type?: string;
  /** The enclosing function's display name, for cuts. */
  parent?: string;
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

    // Effect operations are not linker symbols; index them for navigation.
    for (const eff of result.mod.effects.values()) {
      for (const [opName, op] of eff.ops) {
        const span = op.sig.span;
        if (!span?.file) continue;
        const src = srcFor(span.file);
        symbols.push({
          name: opName,
          display: `${eff.name}.${opName}`,
          finalName: opName,
          kind: "function",
          file: span.file,
          range: spanRange(src, span),
        });
      }
    }

    // Primitive types live in the compiler/runtime; point navigation at the
    // builtins documentation so `Html`, `Int`, `List`, … have a definition.
    const builtinsFile = path.join(import.meta.dirname, "..", "stdlib", "builtins.flow");
    if (fs.existsSync(builtinsFile)) {
      const builtins = fs.readFileSync(builtinsFile, "utf8");
      for (const name of ["Html", "Int", "Float", "Str", "Bool", "Unit", "List", "Cell", "Event", "Dom"]) {
        if (symbols.some((s) => s.name === name && s.kind === "type")) continue;
        const at = builtins.indexOf(name);
        if (at < 0) continue;
        const start = offsetToPosition(builtins, at);
        symbols.push({
          name,
          display: `std::builtins::${name}`,
          finalName: name,
          kind: "type",
          file: builtinsFile,
          range: { start, end: { line: start.line, character: start.character + name.length } },
        });
      }
    }

    const regions: Region[] = [];
    const fnRegions: Region[] = [];
    if (result.codegen) {
      for (const [name, fn] of result.mod.fns) {
        if (fn.synthetic) continue;
        const origin = result.display?.get(name) ?? name;
        if (origin.startsWith("std::")) continue;
        const h = result.codegen.home(fn.body);
        if (h === "neutral") continue;
        const src = srcFor(fn.body.span.file ?? abs);
        const region: Region = {
          file: fn.body.span.file ?? abs,
          range: spanRange(src, fn.span ?? fn.body.span),
          side: h,
          kind: "function",
          label: `${origin} runs on ${h}`,
        };
        regions.push(region);
        fnRegions.push(region);
      }

      const containsRange = (outer: Range, inner: Range) =>
        (outer.start.line < inner.start.line ||
          (outer.start.line === inner.start.line && outer.start.character <= inner.start.character)) &&
        (outer.end.line > inner.end.line ||
          (outer.end.line === inner.end.line && outer.end.character >= inner.end.character));

      const cutKeys = new Set<string>();
      const cutSpans = result.codegen.cutList
        .map((cut) => {
          const span = (cut.node as { span: Span }).span;
          if (!span?.file) return null;
          const src = srcFor(span.file);
          return { cut, span, range: spanRange(src, span) };
        })
        .filter((x): x is { cut: typeof result.codegen.cutList[number]; span: Span; range: Range } => x !== null);
      const cutRegions: Region[] = [];
      for (const { cut, span, range } of cutSpans) {
        // The direction is measured from the nearest enclosing region: a cut nested
        // inside another cut crosses from *that* cut's side, not from the function's.
        const parent = [...fnRegions, ...cutRegions]
          .filter((r) => containsRange(r.range, range))
          .sort((a, b) =>
            (a.range.end.line - a.range.start.line) - (b.range.end.line - b.range.start.line) ||
            (a.range.end.character - a.range.start.character) - (b.range.end.character - b.range.start.character))[0];
        const from = parent ? parent.side : "shared";
        const direction = `${from}→${cut.home}`;
        const ty = result.mod.info.get(cut.node)?.ty;
        const type = ty ? typeStr(prune(ty)) : undefined;
        const parentName = parent
          ? parent.kind === "function"
            ? parent.label.replace(/ runs on .*$/, "")
            : parent.cutId
          : undefined;
        cutKeys.add(`${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`);
        const region: Region = {
          file: span.file,
          range,
          side: cut.home,
          kind: "cut",
          direction,
          cutId: cut.id,
          mode: cut.mode,
          deps: [...cut.deps],
          type,
          parent: parentName,
          label:
            `${direction} ${cut.mode} cut ${cut.id}` +
            (parentName ? ` in ${parentName}` : "") +
            ` → ${cut.home}` +
            (cut.deps.length ? ` (deps: ${cut.deps.join(", ")})` : "") +
            (type ? ` : ${type}` : ""),
        };
        regions.push(region);
        cutRegions.push(region);
      }

      // Cross-tier expressions: values that really mix both sides (an Int computed
      // from a server call and a client cell). Html containers are skipped: their
      // mixed children are already marked by the cuts inside them.
      const crossingKeys = new Set<string>();
      const crossingKinds = new Set(["Binary", "App", "If", "Match", "Ctor", "Field"]);
      for (const [node, info] of result.mod.info) {
        if (info.place !== "cross") continue;
        const span = (node as { span?: Span }).span;
        if (!span?.file) continue;
        if (!crossingKinds.has((node as { k?: string }).k ?? "")) continue;
        const ty = prune(info.ty);
        if (ty.k === "fun") continue;
        if (ty.k === "con" && (ty.name === "Html" || ty.name === "Cell" || ty.name === "Event")) continue;
        const src = srcFor(span.file);
        const range = spanRange(src, span);
        const key = `${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
        if (cutKeys.has(key) || crossingKeys.has(key)) continue;
        crossingKeys.add(key);
        const home = result.codegen.home(node);
        const type = typeStr(ty);
        regions.push({
          file: span.file,
          range,
          side: home === "neutral" ? "neutral" : home,
          kind: "crossing",
          direction: `mixed→${home}`,
          type,
          label: `cross-tier expression mixes client and server: ${type} → ${home}`,
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

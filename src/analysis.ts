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
import { parse } from "./parser.ts";
import { FlowError } from "./lexer.ts";
import { prune, typeStr } from "./types.ts";
import type { Type } from "./types.ts";
import type { Param, Program, Span } from "./ast.ts";
import type { Place } from "./types.ts";
import type { SymKind } from "./modules.ts";
import { printType } from "./printer.ts";
import { STDLIB_DIR } from "./paths.ts";
import { adtRecordFieldNames, domFieldNames } from "./infer.ts";

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
  /** parameter types, when the node is a lambda (inferred, not only as written) */
  params?: string[];
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
  /** exported from its module (private members are not offered under `Module.`) */
  public: boolean;
  /** the unit that declares it, for "is this the current module" checks */
  unit: string;
}

/** One public declaration of a module, for completion without compiling it. */
export interface ModuleMember { name: string; kind: SymKind }
export interface ModuleIndex { id: string; file: string; members: ModuleMember[] }

export interface Analysis {
  ok: boolean;
  entry: string;
  entryUnit?: string;
  diagnostics: Diagnostic[];
  regions: Region[];
  nodes: NodeInfo[];
  symbols: SymbolInfo[];
  /** inferred signatures for functions, by final name */
  signatures: Map<string, SignatureInfo>;
  units: { id: string; file: string }[];
  /** Every std module and its public members, indexed once without type-checking. */
  modules: ModuleIndex[];
  program?: Program;
  display?: Map<string, string>;
  importedByFile?: Map<string, Set<string>>;
}

const isStd = (file: string) => {
  const abs = path.resolve(file);
  return abs === STDLIB_DIR || abs.startsWith(STDLIB_DIR + path.sep);
};

/** File contents, reused while the file is unchanged (the editor asks constantly). */
const sourceCache = new Map<string, { mtimeMs: number; src: string }>();

export function readSource(file: string, overlay?: Map<string, string>): string {
  const abs = path.resolve(file);
  if (overlay?.has(abs)) return overlay.get(abs)!;
  try {
    const st = fs.statSync(abs);
    const hit = sourceCache.get(abs);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.src;
    const src = fs.readFileSync(abs, "utf8");
    sourceCache.set(abs, { mtimeMs: st.mtimeMs, src });
    return src;
  } catch {
    return "";
  }
}

let STD_MODULES: ModuleIndex[] | null = null;

/**
 * The std library as completion sees it: module ids plus their public members,
 * parsed once. Compiling every std module on each keystroke was the main reason
 * the language server felt slow while typing.
 */
export function stdModules(): ModuleIndex[] {
  if (STD_MODULES) return STD_MODULES;
  const modules: ModuleIndex[] = [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(STDLIB_DIR).filter((f) => f.endsWith(".flow") && f !== "builtins.flow").sort();
  } catch { /* no std */ }
  for (const f of files) {
    const file = path.join(STDLIB_DIR, f);
    try {
      const program = parse(fs.readFileSync(file, "utf8"), file, { recover: true });
      const members: ModuleMember[] = [];
      const add = (name: string, kind: SymKind) => {
        if (!members.some((m) => m.name === name)) members.push({ name, kind });
      };
      for (const d of program.decls) {
        if (!(d as { pub?: boolean }).pub) continue;
        switch (d.k) {
          case "Fn": add(d.name, "function"); break;
          case "Extern": add(d.sig.name, "function"); break;
          case "Adt":
            add(d.name, "type");
            for (const v of d.variants) add(v.name, "constructor");
            break;
          case "RecordType": add(d.name, "record"); break;
          case "Alias": add(d.name, "alias"); break;
          case "Trait": add(d.name, "trait"); break;
          case "Effect": add(d.name, "effect"); break;
          default: break;
        }
      }
      modules.push({ id: `flow::${f.replace(/\.flow$/, "")}`, file, members });
    } catch { /* a broken std file must not disable completion */ }
  }
  STD_MODULES = modules;
  return modules;
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
    // Only the modules this program actually reaches. Preloading the whole std
    // library made every keystroke cost 10-20x more; completion reads stdModules().
    const result = compileFile(abs, { overlay, collectErrors: true, requireMain: false, recover: true });
    const srcCache = new Map<string, string>();
    const srcFor = (file: string) => {
      let s = srcCache.get(file);
      if (s === undefined) { s = readSource(file, overlay); srcCache.set(file, s); }
      return s;
    };

    // Which final names are exported? `Module.` completion must not offer
    // private helpers (Time.host_now, Time.yearOf, …).
    const publicDecls = new Set<string>();
    for (const d of result.program.decls) {
      if (!(d as { pub?: boolean }).pub) continue;
      if (d.k === "Fn") publicDecls.add(d.name);
      else if (d.k === "Extern") publicDecls.add(d.sig.name);
      else if (d.k === "Adt") {
        publicDecls.add(d.name);
        for (const variant of d.variants) publicDecls.add(variant.name);
      } else if (d.k === "RecordType" || d.k === "Alias" || d.k === "Trait" || d.k === "Effect") {
        publicDecls.add(d.name);
      }
    }

    const nodes: NodeInfo[] = [];
    const signatures = new Map<string, SignatureInfo>();
    for (const [name, fn] of result.mod.fns) {
      if (fn.scheme.k !== "fun") continue;
      // A declared signature is shown as written (`serve :: AppConfig -> ()`),
      // not as the resolved record it expands to. Inferred parts still print
      // the inferred type.
      const declared = (p: Param, i: number): string =>
        p.type.k === "TVar" && p.type.name === "_"
          ? typeStr(fn.scheme.k === "fun" ? fn.scheme.params[i]! : p.type as never)
          : printType(p.type);
      signatures.set(name, {
        name,
        params: fn.params.map((p, i) => ({ name: p.name, type: declared(p, i) })),
        ret: fn.ret ? printType(fn.ret) : typeStr(fn.scheme.ret),
        effects: [...fn.scheme.eff.labels].sort(),
      });
    }

    for (const [node, info] of result.mod.info) {
      const span = (node as { span?: Span }).span;
      if (!span || !span.file) continue;
      // Std implementation details are only interesting if the user opened one.
      if (isStd(span.file) && !overlay?.has(path.resolve(span.file))) continue;
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
      else if (ty.k === "con") {
        const fields = adtRecordFieldNames(ty, result.mod.typeDefs) ?? domFieldNames(ty.name);
        if (fields) entry.fields = fields;
      }
      if (ty.k === "con" && ty.name === "Cell") entry.cellElem = typeStr(ty.args[0]!);
      if (k === "Lam" && ty.k === "fun") entry.params = ty.params.map((p) => typeStr(prune(p)));
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
        public: publicDecls.has(finalName),
        unit: sym.unit,
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
          public: publicDecls.has(eff.name),
          unit: "",
        });
      }
    }

    // Primitive types live in the compiler/runtime; point navigation at the
    // builtins documentation so `Html`, `Int`, `List`, … have a definition.
    const builtinsFile = path.join(STDLIB_DIR, "builtins.flow");
    if (fs.existsSync(builtinsFile)) {
      const builtins = fs.readFileSync(builtinsFile, "utf8");
      for (const name of ["Html", "Int", "Float", "Str", "Bool", "Unit", "List", "Cell", "Event", "Dom"]) {
        if (symbols.some((s) => s.name === name && s.kind === "type")) continue;
        const at = builtins.indexOf(name);
        if (at < 0) continue;
        const start = offsetToPosition(builtins, at);
        symbols.push({
          name,
          display: `Flow.Builtins.${name}`,
          finalName: name,
          kind: "type",
          file: builtinsFile,
          range: { start, end: { line: start.line, character: start.character + name.length } },
          public: true,
          unit: "",
        });
      }
    }

    const regions: Region[] = [];
    const fnRegions: Region[] = [];
    if (result.codegen) {
      for (const [name, fn] of result.mod.fns) {
        if (fn.synthetic) continue;
        const origin = result.display?.get(name) ?? name;
        if (origin.startsWith("flow::") || origin.startsWith("Flow.")) continue;
        let h: "client" | "server" | "neutral";
        try {
          h = result.codegen.home(fn.body);
        } catch {
          // One function with a placement error must not blank the whole file.
          continue;
        }
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
        if (isStd(span.file) && !overlay?.has(path.resolve(span.file))) continue;
        if (!crossingKinds.has((node as { k?: string }).k ?? "")) continue;
        const ty = prune(info.ty);
        if (ty.k === "fun") continue;
        if (ty.k === "con" && (ty.name === "Html" || ty.name === "Cell" || ty.name === "Event")) continue;
        const src = srcFor(span.file);
        const range = spanRange(src, span);
        const key = `${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
        if (cutKeys.has(key) || crossingKeys.has(key)) continue;
        crossingKeys.add(key);
        let home: "client" | "server" | "neutral";
        try {
          home = result.codegen.home(node);
        } catch {
          continue;
        }
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
      signatures,
      units: result.units,
      modules: stdModules(),
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
      signatures: new Map(),
      units: [],
      modules: stdModules(),
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

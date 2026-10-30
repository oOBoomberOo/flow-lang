/**
 * Flow — module system.
 *
 * A *package* is a directory with a `flow.json` manifest and a `src/` tree of
 * `.flow` files. A *module* is one file; its id is `package::path::to::file`
 * (forward slashes become `::`).
 *
 * Because the tier split requires whole-program analysis (exactly as in Ur/Web
 * and Electric), modules are linked at compile time: imports are resolved,
 * visibility is checked, every declaration gets a globally unique final name,
 * and the resulting single program is handed to the type checker.
 */

import fs from "node:fs";
import path from "node:path";
import { parse } from "./parser.ts";
import { FlowError } from "./lexer.ts";
import type { Decl, Expr, HtmlNode, Pattern, Program, Span, TypeExpr } from "./ast.ts";

export const STDLIB_DIR = path.join(import.meta.dirname, "..", "stdlib");

export interface Manifest {
  name: string;
  version: string;
  dependencies: Record<string, string>;
}

export interface Package {
  name: string;
  root: string;
  srcDir: string;
  manifest?: Manifest;
  deps: Map<string, Package>;
  singleFile?: string;
}

export interface SourceUnit {
  id: string;
  pkg: string;
  pkgObj: Package;
  modulePath: string[];
  file: string;
  program: Program;
  /** names this unit declares (simple names) */
  declares: Map<string, Decl>;
}

export type SymKind = "function" | "type" | "constructor" | "trait" | "effect" | "record" | "alias";

export interface SymInfo {
  name: string;
  finalName: string;
  kind: SymKind;
  file: string;
  span: Span;
  unit: string;
}

function kindOf(decl: Decl, name: string): SymKind {
  switch (decl.k) {
    case "Fn": return "function";
    case "Extern": return "function";
    case "Adt": return decl.name === name ? "type" : "constructor";
    case "RecordType": return "record";
    case "Alias": return "alias";
    case "Trait": return "trait";
    case "Effect": return "effect";
    default: return "type";
  }
}

export interface LinkedProgram {
  program: Program;
  units: SourceUnit[];
  /** final name -> "pkg::mod::name" for diagnostics */
  display: Map<string, string>;
  /** final name -> declaration site (for go-to-definition, references, symbols) */
  symbols: Map<string, SymInfo>;
  /** file -> final names imported into that file (for auto-import) */
  importedByFile: Map<string, Set<string>>;
  entry: SourceUnit;
}

/* ------------------------------------------------------------------ */
/* packages                                                           */
/* ------------------------------------------------------------------ */

export function readManifest(dir: string): Manifest | null {
  const file = path.join(dir, "flow.json");
  if (!fs.existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new FlowError(`invalid flow.json: ${(e as Error).message}`, { file, code: "E_MANIFEST" });
  }
  const m = raw as Partial<Manifest>;
  if (!m.name || !/^[a-z][a-z0-9_-]*$/.test(m.name)) {
    throw new FlowError("flow.json: 'name' must match [a-z][a-z0-9_-]*", { file, code: "E_MANIFEST" });
  }
  if (!m.version || !/^\d+\.\d+\.\d+/.test(m.version)) {
    throw new FlowError("flow.json: 'version' must be semver (x.y.z)", { file, code: "E_MANIFEST" });
  }
  return {
    name: m.name,
    version: m.version,
    dependencies: m.dependencies ?? {},
  };
}

/** Find the package containing `file` (walks up to a flow.json). */
export function loadPackage(entryFile: string): Package {
  const abs = path.resolve(entryFile);

  if (path.basename(abs) === "flow.json") {
    return packageAt(path.dirname(abs));
  }

  let dir = path.dirname(abs);
  for (;;) {
    if (fs.existsSync(path.join(dir, "flow.json"))) {
      const pkg = packageAt(dir);
      // entry must live inside src/
      const rel = path.relative(pkg.srcDir, abs);
      if (rel.startsWith("..")) {
        throw new FlowError(
          `${path.basename(abs)} is outside ${path.join(dir, "src")}`,
          { file: abs, code: "E_MODULE" },
        );
      }
      return pkg;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // single-file mode: the file is the whole program
  return {
    name: "main",
    root: path.dirname(abs),
    srcDir: path.dirname(abs),
    deps: new Map(),
    singleFile: abs,
  };
}

export function packageAt(root: string): Package {
  const manifest = readManifest(root)!;
  const srcDir = path.join(root, "src");
  const deps = new Map<string, Package>();

  for (const [name, spec] of Object.entries(manifest.dependencies)) {
    const dir = resolveDependency(root, name, spec);
    deps.set(name, packageAt(dir));
  }

  return { name: manifest.name, root, srcDir, manifest, deps };
}

/** `path:../x` is the only spec form in 0.1; `flow install` vendors registry
 *  packages into `flow_modules/<name>` and rewrites the lock, not the manifest. */
export function resolveDependency(root: string, name: string, spec: string): string {
  if (spec.startsWith("path:")) {
    const dir = path.resolve(root, spec.slice(5));
    if (!fs.existsSync(path.join(dir, "flow.json"))) {
      throw new FlowError(`dependency '${name}' not found at ${dir}`, { code: "E_PKG" });
    }
    return dir;
  }
  const vendored = path.join(root, "flow_modules", name);
  if (fs.existsSync(path.join(vendored, "flow.json"))) return vendored;
  throw new FlowError(
    `dependency '${name}' (${spec}) is not installed — run 'flow install'`,
    { code: "E_PKG" },
  );
}

/* ------------------------------------------------------------------ */
/* loading                                                            */
/* ------------------------------------------------------------------ */

const MODULE_FILE = (pkg: Package, modulePath: string[]) => {
  if (pkg.singleFile && modulePath.length === 1 && modulePath[0] === "main") return pkg.singleFile;
  return path.join(pkg.srcDir, ...modulePath) + ".flow";
};

export class Linker {
  units = new Map<string, SourceUnit>();
  /** In-memory file contents (unsaved editor buffers) keyed by absolute path. */
  overlay: Map<string, string>;

  constructor(opts: { overlay?: Map<string, string> } = {}) {
    this.overlay = opts.overlay ?? new Map();
  }

  private read(file: string): string {
    const buf = this.overlay.get(path.resolve(file));
    return buf !== undefined ? buf : fs.readFileSync(file, "utf8");
  }

  entry!: SourceUnit;

  link(entryFile: string): LinkedProgram {
    const pkg = loadPackage(entryFile);
    const rel = pkg.singleFile
      ? ["main"]
      : path.relative(pkg.srcDir, path.resolve(entryFile)).replace(/\.flow$/, "").split(/[\\/]/);

    this.entry = this.loadUnit(pkg, rel);
    const ordered: SourceUnit[] = [];
    const seen = new Set<string>();
    const visit = (u: SourceUnit) => {
      if (seen.has(u.id)) return;
      seen.add(u.id);
      for (const imp of this.importsOf(u)) visit(imp.unit);
      ordered.push(u);
    };
    visit(this.entry);
    for (const u of this.units.values()) visit(u);

    // The prelude is injected into every module: intrinsics and the capability
    // effects live in std, not in the compiler.
    const prelude = this.loadUnit(stdPackage(), ["prelude"]);
    if (!ordered.includes(prelude)) ordered.unshift(prelude);

    return this.flatten(ordered);
  }

  /* ---------- unit loading ---------- */

  private loadUnit(pkg: Package, modulePath: string[]): SourceUnit {
    const id = `${pkg.name}::${modulePath.join("::")}`;
    const cached = this.units.get(id);
    if (cached) return cached;

    const file = MODULE_FILE(pkg, modulePath);
    if (!fs.existsSync(file)) {
      throw new FlowError(`module '${id}' not found (expected ${file})`, { code: "E_MODULE" });
    }
    const src = this.read(file);
    const program = parse(src, file);
    const declares = new Map<string, Decl>();
    for (const d of program.decls) {
      if (d.k === "Use" || d.k === "Impl" || d.k === "Provide") continue;
      declares.set(d.k === "Extern" ? d.sig.name : d.name, d);
      if (d.k === "Adt") for (const v of d.variants) declares.set(v.name, d);
    }
    const unit: SourceUnit = { id, pkg: pkg.name, pkgObj: pkg, modulePath, file, program, declares };
    this.units.set(id, unit);

    // eagerly load imported modules so cycles work
    for (const use of program.decls) {
      if (use.k !== "Use") continue;
      for (const ref of this.resolveUse(pkg, unit, use)) {
        if (!this.units.has(ref.id)) this.loadUnit(ref.pkg, ref.modulePath);
      }
    }
    return unit;
  }

  /* ---------- import resolution ---------- */

  private resolveUse(pkg: Package, unit: SourceUnit, use: Decl & { k: "Use" }) {
    const [pkgName, ...rest] = use.path;
    if (!pkgName) throw new FlowError("empty 'use' path", { file: unit.file, code: "E_MODULE" });
    if (use.glob) {
      throw new FlowError("glob imports ('*') are not supported; import names explicitly", { file: unit.file, code: "E_MODULE" });
    }

    let target: Package;
    if (pkgName === "std") target = stdPackage();
    else if (pkgName === pkg.name) target = pkg;
    else {
      const dep = pkg.deps.get(pkgName);
      if (!dep) {
        throw new FlowError(
          `unknown package '${pkgName}' in 'use ${use.path.join("::")}' — add it to flow.json`,
          { file: unit.file, code: "E_MODULE" },
        );
      }
      target = dep;
    }

    if (!rest.length) throw new FlowError(`'use ${use.path.join("::")}' imports nothing`, { file: unit.file, code: "E_MODULE" });
    const file = MODULE_FILE(target, rest);
    if (!fs.existsSync(file)) {
      throw new FlowError(
        `module '${pkgName}::${rest.join("::")}' not found (expected ${file})`,
        { file: unit.file, code: "E_MODULE" },
      );
    }
    return [{ pkg: target, id: `${target.name}::${rest.join("::")}`, modulePath: rest }];
  }

  /** All resolved imports of a unit: alias -> target unit + exported name. */
  importTable(unit: SourceUnit): Map<string, { unit: SourceUnit; name: string }> {
    const pkg = this.packageOf(unit);
    const table = new Map<string, { unit: SourceUnit; name: string }>();
    for (const d of unit.program.decls) {
      if (d.k !== "Use") continue;
      const [ref] = this.resolveUse(pkg, unit, d);
      const targetUnit = { id: ref.id };
      const target = this.loadUnit(ref.pkg, ref.modulePath);
      for (const item of d.items) {
        const alias = item.alias ?? item.name;
        if (table.has(alias)) {
          throw new FlowError(`duplicate import '${alias}'`, { file: unit.file, code: "E_MODULE" });
        }
        const decl = target.declares.get(item.name);
        if (!decl) {
          throw new FlowError(
            `'${item.name}' is not exported by ${targetUnit.id}`,
            { file: unit.file, code: "E_MODULE" },
          );
        }
        if (!(decl as { pub?: boolean }).pub) {
          throw new FlowError(
            `'${item.name}' is private in ${targetUnit.id}; mark it 'pub' to export it`,
            { file: unit.file, code: "E_MODULE" },
          );
        }
        table.set(alias, { unit: target, name: item.name });
      }
    }
    return table;
  }

  private importsOf(unit: SourceUnit): { unit: SourceUnit }[] {
    const pkg = this.packageOf(unit);
    const out: { unit: SourceUnit }[] = [];
    for (const d of unit.program.decls) {
      if (d.k !== "Use") continue;
      for (const ref of this.resolveUse(pkg, unit, d)) {
        out.push({ unit: this.loadUnit(ref.pkg, ref.modulePath) });
      }
    }
    return out;
  }

  packageOf(unit: SourceUnit): Package {
    return unit.pkgObj;
  }

  /* ---------- flattening ---------- */

  private flatten(units: SourceUnit[]): LinkedProgram {
    // 1. every declaration name, grouped by simple name
    const byName = new Map<string, { unit: SourceUnit; decl: Decl; name: string }[]>();
    for (const u of units) {
      for (const d of u.program.decls) {
        if (d.k === "Use" || d.k === "Impl" || d.k === "Provide") continue;
        const names: string[] = [d.k === "Extern" ? d.sig.name : d.name];
        if (d.k === "Adt") names.push(...d.variants.map((v) => v.name));
        // `type Priority = Priority(Int)` names a type and a constructor with the
        // same identifier: that is one name, not a collision.
        for (const n of new Set(names)) {
          if (!byName.has(n)) byName.set(n, []);
          byName.get(n)!.push({ unit: u, decl: d, name: n });
        }
      }
    }

    // 2. final names: keep the simple name when unique, otherwise qualify
    const PINNED = new Set(["Server", "Client", "Store"]); // runtime capability names
    const finalName = new Map<string, string>(); // `${unit.id}::${name}` -> final
    const symbols = new Map<string, SymInfo>();
    for (const [name, entries] of byName) {
      const unique = entries.length === 1 || PINNED.has(name);
      for (const e of entries) {
        const key = `${e.unit.id}::${e.name}`;
        const final = unique ? name : `${name}$${e.unit.id.replace(/::/g, "$")}`;
        finalName.set(key, final);
        const span = e.decl.k === "Adt" && e.name !== e.decl.name
          ? (e.decl.variants.find((v) => v.name === e.name)?.span ?? e.decl.span)
          : e.decl.span;
        symbols.set(final, {
          name: e.name,
          finalName: final,
          kind: kindOf(e.decl, e.name),
          file: e.unit.file,
          span,
          unit: e.unit.id,
        });
      }
    }

    // 3. per-unit scopes and AST rewriting
    const out: Decl[] = [];
    const display = new Map<string, string>();
    const importedByFile = new Map<string, Set<string>>();

    // exports of std::prelude, injected into every module with the lowest priority
    const preludeUnit = this.units.get("std::prelude");
    const preludeValues = new Map<string, string>();
    const preludeTypes = new Map<string, string>();
    if (preludeUnit) {
      for (const [n, d] of preludeUnit.declares) {
        const final = finalName.get(`${preludeUnit.id}::${n}`);
        if (!final) continue;
        if (d.k === "Adt" || d.k === "RecordType" || d.k === "Alias") preludeTypes.set(n, final);
        else preludeValues.set(n, final);
        if (d.k === "Adt") {
          for (const v of d.variants) {
            const vFinal = finalName.get(`${preludeUnit.id}::${v.name}`);
            if (vFinal) preludeValues.set(v.name, vFinal);
          }
        }
      }
    }

    for (const u of units) {
      const values = new Map<string, string>();
      const types = new Map<string, string>();
      for (const [n, d] of u.declares) {
        const final = finalName.get(`${u.id}::${n}`);
        if (!final) continue;
        display.set(final, `${u.id}::${n}`);
        if (d.k === "Adt" || d.k === "RecordType" || d.k === "Alias") types.set(n, final);
        if (d.k === "Adt") for (const v of d.variants) values.set(v.name, finalName.get(`${u.id}::${v.name}`)!);
        if (d.k === "Fn" || d.k === "Extern" || d.k === "Trait" || d.k === "Effect") values.set(n, final);
      }
      for (const [alias, ref] of this.importTable(u)) {
        const final = finalName.get(`${ref.unit.id}::${ref.name}`);
        if (!final) continue;
        display.set(final, `${ref.unit.id}::${ref.name}`);
        const decl = ref.unit.declares.get(ref.name)!;
        if (decl.k === "Adt" || decl.k === "RecordType" || decl.k === "Alias") types.set(alias, final);
        else values.set(alias, final);
        // importing an ADT also brings its constructors into scope
        if (decl.k === "Adt") {
          for (const v of decl.variants) {
            const vFinal = finalName.get(`${ref.unit.id}::${v.name}`);
            if (vFinal) values.set(v.name, vFinal);
          }
        }
        if (!importedByFile.has(u.file)) importedByFile.set(u.file, new Set());
        importedByFile.get(u.file)!.add(final);
      }

      // prelude names fill in whatever this unit does not declare or import
      for (const [k, v] of preludeValues) if (!values.has(k)) values.set(k, v);
      for (const [k, v] of preludeTypes) if (!types.has(k)) types.set(k, v);

      for (const d of u.program.decls) {
        if (d.k === "Use") continue;
        out.push(rewriteDecl(d, values, types, u.file));
      }
    }

    return {
      program: { decls: out, file: this.entry.file },
      units,
      display,
      symbols,
      importedByFile,
      entry: this.entry,
    };
  }
}

let _std: Package | null = null;
export function stdPackage(): Package {
  if (_std) return _std;
  _std = { name: "std", root: STDLIB_DIR, srcDir: STDLIB_DIR, deps: new Map(), manifest: { name: "std", version: "0.1.0", dependencies: {} } };
  return _std;
}

/* ------------------------------------------------------------------ */
/* AST rewriting                                                      */
/* ------------------------------------------------------------------ */

const BUILTIN_TYPES = new Set([
  "Int", "Float", "Str", "Bool", "Unit", "Html", "List", "Option", "Cell", "Event", "Dom",
]);

let CURRENT_VALUES: Map<string, string> = new Map();
const effLabels = (row: { effects: string[] }) => ({ ...row, effects: row.effects.map((e) => CURRENT_VALUES.get(e) ?? e) });

function rewriteDecl(d: Decl, values: Map<string, string>, types: Map<string, string>, file: string): Decl {
  CURRENT_VALUES = values;
  switch (d.k) {
    case "Use": return d;
    case "Fn": {
      const scope = new Set<string>();
      const params = d.params.map((p) => ({ ...p, type: rwType(p.type, types) }));
      for (const p of params) scope.add(p.name);
      return {
        ...d,
        name: values.get(d.name) ?? d.name,
        params,
        ret: d.ret ? rwType(d.ret, types) : undefined,
        body: rwExpr(d.body, scope, values, types),
      };
    }
    case "Adt":
      return {
        ...d,
        name: types.get(d.name) ?? d.name,
        variants: d.variants.map((v) => ({
          ...v,
          name: values.get(v.name) ?? v.name,
          args: v.args.map((a) => rwType(a, types)),
        })),
      };
    case "RecordType":
      return { ...d, name: types.get(d.name) ?? d.name, fields: d.fields.map((f) => ({ ...f, type: rwType(f.type, types) })) };
    case "Alias":
      return { ...d, name: types.get(d.name) ?? d.name, type: rwType(d.type, types) };
    case "Trait":
      return { ...d, name: values.get(d.name) ?? d.name, methods: d.methods.map((m) => rwSig(m, types)) };
    case "Effect":
      return { ...d, name: values.get(d.name) ?? d.name, ops: d.ops.map((m) => rwSig(m, types)) };
    case "Impl":
      return {
        ...d,
        trait: values.get(d.trait) ?? d.trait,
        traitArgs: d.traitArgs.map((t) => rwType(t, types)),
        target: rwType(d.target, types),
        methods: d.methods.map((m) => ({
          ...rwSig(m, types),
          body: rwExpr(m.body, new Set(m.params.map((p) => p.name)), values, types),
        })),
      };
    case "Provide":
      return {
        ...d,
        effect: values.get(d.effect) ?? d.effect,
        target: d.target ? rwType(d.target, types) : undefined,
        ops: d.ops.map((o) => ({ ...o, fn: rwExpr(o.fn, new Set(), values, types) })),
      };
    case "Extern":
      return { ...d, sig: { ...rwSig(d.sig, types), name: values.get(d.sig.name) ?? d.sig.name } };
  }
  return d;
}

function rwSig(s: { params: { name: string; type: TypeExpr; span: Span }[]; ret?: TypeExpr; eff?: { effects: string[] } }, types: Map<string, string>) {
  return {
    ...s,
    params: s.params.map((p) => ({ ...p, type: rwType(p.type, types) })),
    ret: s.ret ? rwType(s.ret, types) : undefined,
    eff: s.eff ? effLabels(s.eff) : undefined,
  };
}

function rwType(t: TypeExpr, types: Map<string, string>): TypeExpr {
  switch (t.k) {
    case "TVar": return t;
    case "TCon":
      return { ...t, name: types.get(t.name) ?? t.name, args: t.args.map((a) => rwType(a, types)) };
    case "TFun":
      return { ...t, params: t.params.map((p) => rwType(p, types)), ret: rwType(t.ret, types), eff: t.eff ? effLabels(t.eff) : t.eff };
    case "TRecord":
      return { ...t, fields: t.fields.map((f) => ({ ...f, type: rwType(f.type, types) })) };
    case "TTuple":
      return { ...t, items: t.items.map((i) => rwType(i, types)) };
    case "TPlaced":
      return { ...t, inner: rwType(t.inner, types) };
  }
}

function rwExpr(e: Expr, scope: Set<string>, values: Map<string, string>, types: Map<string, string>): Expr {
  switch (e.k) {
    case "Lit": return e;
    case "Var":
      return scope.has(e.name) ? e : { ...e, name: values.get(e.name) ?? e.name };
    case "Ctor":
      return { ...e, name: values.get(e.name) ?? e.name, args: e.args.map((a) => rwExpr(a, scope, values, types)) };
    case "Lam": {
      const inner = new Set(scope);
      for (const p of e.params) inner.add(p.name);
      return { ...e, params: e.params.map((p) => ({ ...p, type: rwType(p.type, types) })), ret: e.ret ? rwType(e.ret, types) : undefined, body: rwExpr(e.body, inner, values, types) };
    }
    case "App":
      return { ...e, fn: rwExpr(e.fn, scope, values, types), args: e.args.map((a) => rwExpr(a, scope, values, types)) };
    case "If":
      return { ...e, cond: rwExpr(e.cond, scope, values, types), then: rwExpr(e.then, scope, values, types), else: rwExpr(e.else, scope, values, types) };
    case "Match": {
      return {
        ...e,
        scrut: rwExpr(e.scrut, scope, values, types),
        arms: e.arms.map((a) => {
          const inner = new Set(scope);
          rwPattern(a.pat, inner, values);
          return { ...a, guard: a.guard ? rwExpr(a.guard, inner, values, types) : undefined, body: rwExpr(a.body, inner, values, types) };
        }),
      };
    }
    case "Let": {
      const value = rwExpr(e.value, scope, values, types);
      const inner = new Set(scope);
      inner.add(e.name);
      return { ...e, ann: e.ann ? rwType(e.ann, types) : undefined, value, body: rwExpr(e.body, inner, values, types) };
    }
    case "Record":
      return { ...e, fields: e.fields.map((f) => ({ ...f, value: rwExpr(f.value, scope, values, types) })) };
    case "Field":
      return { ...e, target: rwExpr(e.target, scope, values, types) };
    case "Tuple": case "List":
      return { ...e, items: e.items.map((i) => rwExpr(i, scope, values, types)) };
    case "Binary":
      return { ...e, l: rwExpr(e.l, scope, values, types), r: rwExpr(e.r, scope, values, types) };
    case "Unary":
      return { ...e, e: rwExpr(e.e, scope, values, types) };
    case "Html":
      return { ...e, nodes: e.nodes.map((n) => rwHtml(n, scope, values, types)) };
    case "Block": {
      let inner = new Set(scope);
      const stmts = e.stmts.map((s) => {
        if (s.k === "LetStmt") {
          const value = rwExpr(s.value, inner, values, types);
          const next = new Set(inner);
          next.add(s.name);
          inner = next;
          return { ...s, ann: s.ann ? rwType(s.ann, types) : undefined, value };
        }
        return { ...s, e: rwExpr(s.e, inner, values, types) };
      });
      return { ...e, stmts, value: e.value ? rwExpr(e.value, inner, values, types) : undefined };
    }
  }
}

function rwHtml(n: HtmlNode, scope: Set<string>, values: Map<string, string>, types: Map<string, string>): HtmlNode {
  switch (n.k) {
    case "Text": return n;
    case "Hole": return { ...n, e: rwExpr(n.e, scope, values, types) };
    case "Element":
      return { ...n, attrs: n.attrs.map((a) => (a.value.k === "expr" ? { ...a, value: { k: "expr", e: rwExpr(a.value.e, scope, values, types) } } : a)), children: n.children.map((c) => rwHtml(c, scope, values, types)) };
    case "Component":
      return {
        ...n,
        name: values.get(n.name) ?? n.name,
        attrs: n.attrs.map((a) => (a.value.k === "expr" ? { ...a, value: { k: "expr", e: rwExpr(a.value.e, scope, values, types) } } : a)),
        children: n.children.map((c) => rwHtml(c, scope, values, types)),
      };
  }
}

function rwPattern(p: Pattern, scope: Set<string>, values: Map<string, string>): void {
  switch (p.k) {
    case "PVar": scope.add(p.name); return;
    case "PTuple": p.items.forEach((q) => rwPattern(q, scope, values)); return;
    case "PRecord": p.fields.forEach((f) => rwPattern(f.pat, scope, values)); return;
    case "PList": p.items.forEach((q) => rwPattern(q, scope, values)); if (p.rest) scope.add(p.rest); return;
    case "PCtor": (p as { name: string }).name = values.get(p.name) ?? p.name; p.args.forEach((q) => rwPattern(q, scope, values)); return;
    default: return;
  }
}

void BUILTIN_TYPES;

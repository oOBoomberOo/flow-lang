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
import type { Decl, Expr, FnSig, HtmlNode, Pattern, Program, Span, TypeExpr } from "./ast.ts";
import { parseDependency, fetchGit, type DependencyValue, type RegistryConfig } from "./registry.ts";

export const STDLIB_DIR = path.join(import.meta.dirname, "..", "stdlib");

export interface Manifest {
  name: string;
  version: string;
  dependencies: Record<string, DependencyValue>;
  /** where this project's packages come from; see src/registry.ts */
  registry?: string | RegistryConfig;
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
  /** declared module name (`Flow.List`), or the path-derived name in lenient mode */
  moduleName: string[];
  file: string;
  program: Program;
  /** names this unit declares (simple names) */
  declares: Map<string, Decl>;
  /** module qualifiers usable in this file (`List`, `L` from `import List as L`) -> unit id */
  quals: Map<string, string>;
}

const decap = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const cap = (s: string) => s.split(/[-_]/).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");

/** `std::list` -> `Flow.List`, `app::shapes::circle` -> `Shapes.Circle`, `flow-charts::bar` -> `FlowCharts.Bar` */
export function moduleDisplayName(
  unit: { pkg: string; modulePath: string[]; moduleName?: string[] },
  currentPkg?: string,
): string {
  const declared = unit.moduleName
    ?? (unit.pkg === "std" ? ["Flow", ...unit.modulePath.map(cap)] : unit.modulePath.map(cap));
  if (unit.pkg === "std" || unit.pkg === currentPkg || unit.pkg === "main") return declared.join(".");
  return [cap(unit.pkg), ...declared].join(".");
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
  /** parse/link errors collected in editor mode */
  errors: FlowError[];
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
    ...(m.registry !== undefined ? { registry: m.registry } : {}),
  };
}

/** Find the package containing `file` (walks up to a flow.json). */
export function loadPackage(entryFile: string): Package {
  const abs = path.resolve(entryFile);
  // A std file is part of the Flow namespace even when opened directly.
  if (abs === STDLIB_DIR || abs.startsWith(STDLIB_DIR + path.sep)) return stdPackage();

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
export function resolveDependency(root: string, name: string, spec: DependencyValue): string {
  const dep = parseDependency(name, spec);
  if (dep.kind === "path") {
    const dir = path.resolve(root, dep.dir);
    if (!fs.existsSync(path.join(dir, "flow.json"))) {
      throw new FlowError(`dependency '${name}' not found at ${dir}`, { code: "E_PKG" });
    }
    return dir;
  }
  const vendored = path.join(root, "flow_modules", name);
  if (fs.existsSync(path.join(vendored, "flow.json"))) return vendored;
  if (dep.kind === "git") {
    const dir = path.join(root, "flow_modules", name);
    if (fs.existsSync(path.join(dir, "flow.json"))) return dir;
    throw new FlowError(
      `dependency '${name}' is a git dependency (${dep.url}) that is not installed — run 'flow install'`,
      { code: "E_PKG" },
    );
  }
  throw new FlowError(
    `dependency '${name}' (${dep.range}) is not installed — run 'flow install'`,
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
  /** editor mode: recover from parse/link errors instead of throwing */
  recover: boolean;
  /** editor mode: preload every std module so path completion works */
  allStd: boolean;
  /** require every real .flow file to start with a matching `module A.B where` */
  requireModule: boolean;
  errors: FlowError[] = [];

  constructor(opts: { overlay?: Map<string, string>; recover?: boolean; allStd?: boolean; requireModule?: boolean } = {}) {
    this.overlay = opts.overlay ?? new Map();
    this.recover = Boolean(opts.recover);
    this.allStd = Boolean(opts.allStd);
    this.requireModule = opts.requireModule !== false;
  }

  private read(file: string): string {
    const buf = this.overlay.get(path.resolve(file));
    return buf !== undefined ? buf : fs.readFileSync(file, "utf8");
  }

  entry!: SourceUnit;

  link(entryFile: string): LinkedProgram {
    this.errors = [];
    const pkg = loadPackage(entryFile);
    const rel = pkg.singleFile
      ? [path.basename(pkg.singleFile, ".flow")]
      : path.relative(pkg.srcDir, path.resolve(entryFile)).replace(/\.flow$/, "").split(/[\\/]/);
    return this.linkUnit(pkg, rel);
  }

  /** Link a source that only exists in memory (tests, the REPL, docs snippets). */
  linkSource(src: string, file: string): LinkedProgram {
    this.errors = [];
    const abs = path.resolve(file);
    this.overlay.set(abs, src);
    const pkg: Package = {
      name: "main",
      root: path.dirname(abs),
      srcDir: path.dirname(abs),
      deps: new Map(),
      singleFile: abs,
    };
    return this.linkUnit(pkg, ["main"]);
  }

  private linkUnit(pkg: Package, rel: string[]): LinkedProgram {
    this.entry = this.loadUnit(pkg, rel);
    if (this.allStd) {
      let files: string[] = [];
      try { files = fs.readdirSync(STDLIB_DIR).filter((f) => f.endsWith(".flow") && f !== "builtins.flow"); } catch { /* no std */ }
      for (const f of files) {
        try { this.loadUnit(stdPackage(), [f.replace(/\.flow$/, "")]); }
        catch (e) { if (this.recover && e instanceof FlowError) this.errors.push(e); else throw e; }
      }
    }
    const ordered: SourceUnit[] = [];
    const seen = new Set<string>();
    const visit = (u: SourceUnit) => {
      if (seen.has(u.id)) return;
      seen.add(u.id);
      for (const imp of this.importsOf(u)) visit(imp.unit);
      ordered.push(u);
    };
    const prelude = this.loadUnit(stdPackage(), ["prelude"]);
    visit(prelude);
    visit(this.entry);
    for (const u of this.units.values()) visit(u);

    // The prelude is injected into every module: intrinsics and the capability
    // effects live in std, not in the compiler. Visiting it also pulls in the
    // modules it re-exports (the Monad family). It must be first so its types
    // (Option, …) are registered before modules that use them.
    const preludeIndex = ordered.indexOf(prelude);
    if (preludeIndex >= 0) ordered.splice(preludeIndex, 1);
    ordered.unshift(prelude);

    return this.flatten(ordered);
  }

  /* ---------- unit loading ---------- */

  private loadUnit(pkg: Package, modulePath: string[]): SourceUnit {
    const id = `${pkg.name}::${modulePath.join("::")}`;
    const cached = this.units.get(id);
    if (cached) return cached;

    const file = MODULE_FILE(pkg, modulePath);
    if (!fs.existsSync(file) && !this.overlay.has(path.resolve(file))) {
      throw new FlowError(`module '${id}' not found (expected ${file})`, { code: "E_MODULE" });
    }
    const src = this.read(file);
    const program = parse(src, file, { recover: this.recover });
    if (program.errors?.length) this.errors.push(...program.errors);
    const expected = this.expectedModuleName(pkg, modulePath);
    if (this.requireModule) {
      if (!program.module) {
        this.reportModule(file, `every .flow file must start with \`module ${expected.join(".")} where\``);
      } else if (program.module.join(".") !== expected.join(".")) {
        this.reportModule(
          file,
          `module '${program.module.join(".")}' does not match this file; expected \`module ${expected.join(".")} where\``,
          program.moduleSpan,
        );
      }
    }
    const moduleName = program.module ?? expected;
    const declares = new Map<string, Decl>();
    for (const d of program.decls) {
      if (d.k === "Use" || d.k === "Impl" || d.k === "Provide") continue;
      declares.set(d.k === "Extern" ? d.sig.name : d.name, d);
      if (d.k === "Adt") for (const v of d.variants) declares.set(v.name, d);
    }
    const unit: SourceUnit = { id, pkg: pkg.name, pkgObj: pkg, modulePath, moduleName, file, program, declares, quals: new Map() };
    this.units.set(id, unit);

    // eagerly load imported modules so cycles work
    for (const use of program.decls) {
      if (use.k !== "Use") continue;
      try {
        for (const ref of this.resolveUse(pkg, unit, use)) {
          const target = this.units.get(ref.id) ?? this.loadUnit(ref.pkg, ref.modulePath);
          const u = use as Decl & { k: "Use" };
          unit.quals.set(u.alias ?? u.path.join("."), target.id);
        }
      } catch (e) {
        if (this.recover && e instanceof FlowError) this.errors.push(e);
        else throw e;
      }
    }

    // `List.map` works without an `import`: load the module the qualifier names.
    this.discoverQualified(unit);
    return unit;
  }

  /** `Flow.List` for std, `Shapes.Circle` for `src/shapes/circle.flow`. */
  private expectedModuleName(pkg: Package, modulePath: string[]): string[] {
    return pkg.name === "std"
      ? ["Flow", ...modulePath.map(cap)]
      : modulePath.map(cap);
  }

  private reportModule(file: string, msg: string, span?: { line?: number; col?: number }): void {
    const err = new FlowError(msg, { file, line: span?.line ?? 1, col: span?.col ?? 1, code: "E_MODULE" });
    if (this.recover) this.errors.push(err);
    else throw err;
  }

  /** `["List"]` / `["Flow","List"]` / `["Shapes","Circle"]` / `["FlowCharts","Bar"]` -> the module file's package and path. */
  private findModule(pkg: Package, parts: string[]): { pkg: Package; modulePath: string[] } | null {
    const exists = (p: Package, mp: string[]) => {
      try { return mp.length > 0 && fs.existsSync(MODULE_FILE(p, mp)); } catch { return false; }
    };
    // `Flow.*` is reserved for the standard library.
    if (parts[0] === "Flow") {
      const rest = parts.slice(1).map(decap);
      return rest.length && exists(stdPackage(), rest) ? { pkg: stdPackage(), modulePath: rest } : null;
    }
    const lower = parts.map(decap);
    // a lone file is a whole program: its neighbours in the directory are not modules
    if (!pkg.singleFile && exists(pkg, lower)) return { pkg, modulePath: lower };
    for (const [name, dep] of pkg.deps) {
      if (parts.length > 1 && cap(name) === parts[0] && exists(dep, lower.slice(1))) {
        return { pkg: dep, modulePath: lower.slice(1) };
      }
    }
    // Short std names still work (`List`), but a local/dependency module with
    // the same name wins; `Flow.List` is the unambiguous spelling.
    const std = stdPackage();
    if (exists(std, lower)) return { pkg: std, modulePath: lower };
    return null;
  }

  /** Load modules named by qualified references (`List.map`, `Option.Some`, `Util.f`). */
  private discoverQualified(unit: SourceUnit): void {
    for (const qual of collectQualifiers(unit.program)) {
      if (unit.quals.has(qual)) continue;
      // a locally declared effect / type / constructor is not a module
      if (unit.declares.has(qual.split(".")[0]!) && !qual.includes(".")) continue;
      const found = this.findModule(unit.pkgObj, qual.split("."));
      if (!found) continue;
      try {
        const target = this.loadUnit(found.pkg, found.modulePath);
        unit.quals.set(qual, target.id);
      } catch (e) {
        if (this.recover && e instanceof FlowError) this.errors.push(e); else throw e;
      }
    }
  }

  /* ---------- import resolution ---------- */

  private resolveUse(pkg: Package, unit: SourceUnit, use: Decl & { k: "Use" }) {
    if (!use.path.length) throw new FlowError("empty 'import'", { file: unit.file, line: use.span?.line, col: use.span?.col, code: "E_MODULE" });
    const found = this.findModule(pkg, use.path);
    if (!found) {
      const name = use.path.join(".");
      const first = use.path[0]!;
      const hint = use.path.length > 1 && !pkg.deps.has(decap(first)) && !/^[A-Z]/.test(first) ? "" :
        use.path.length > 1 && ![...pkg.deps.keys()].some((d) => cap(d) === first) && !this.findModule(pkg, [first])
          ? ` — if '${first}' is a package, add it to flow.json`
          : "";
      throw new FlowError(`module '${name}' not found${hint}`, { file: unit.file, line: use.span?.line, col: use.span?.col, code: "E_MODULE" });
    }
    return [{ pkg: found.pkg, id: `${found.pkg.name}::${found.modulePath.join("::")}`, modulePath: found.modulePath }];
  }

  /** All resolved imports of a unit: alias -> target unit + exported name. */
  importTable(unit: SourceUnit): Map<string, { unit: SourceUnit; name: string }> {
    const pkg = this.packageOf(unit);
    const table = new Map<string, { unit: SourceUnit; name: string }>();
    for (const d of unit.program.decls) {
      if (d.k !== "Use") continue;
      try {
        const [ref] = this.resolveUse(pkg, unit, d);
        const targetUnit = { id: ref.id };
        const target = this.loadUnit(ref.pkg, ref.modulePath);
        for (const item of d.items) {
          const alias = item.alias ?? item.name;
          if (table.has(alias)) {
            throw new FlowError(`duplicate import '${alias}'`, { file: unit.file, code: "E_MODULE" });
          }
          let actualUnit = target;
          let actualName = item.name;
          let decl = target.declares.get(item.name);
          // The prelude is a re-export surface: importing a name from it
          // resolves through the module that actually declares the name.
          if (!decl && target.id === "std::prelude") {
            const re = this.importTable(target).get(item.name);
            if (re) {
              actualUnit = re.unit;
              actualName = re.name;
              decl = actualUnit.declares.get(actualName);
            }
          }
          const where = moduleDisplayName(target, unit.pkg);
          if (!decl) {
            throw new FlowError(
              `'${item.name}' is not exported by module ${where}`,
              { file: unit.file, line: d.span?.line, col: d.span?.col, code: "E_MODULE" },
            );
          }
          if (!(decl as { pub?: boolean }).pub) {
            throw new FlowError(
              `'${item.name}' is private in module ${where}; add it to the export list of ${where}`,
              { file: unit.file, line: d.span?.line, col: d.span?.col, code: "E_MODULE" },
            );
          }
          table.set(alias, { unit: actualUnit, name: actualName });
        }
      } catch (e) {
        if (this.recover && e instanceof FlowError) this.errors.push(e);
        else throw e;
      }
    }
    return table;
  }

  private importsOf(unit: SourceUnit): { unit: SourceUnit }[] {
    const pkg = this.packageOf(unit);
    const out: { unit: SourceUnit }[] = [];
    for (const d of unit.program.decls) {
      if (d.k !== "Use") continue;
      try {
        for (const ref of this.resolveUse(pkg, unit, d)) {
          out.push({ unit: this.loadUnit(ref.pkg, ref.modulePath) });
        }
      } catch (e) {
        if (this.recover && e instanceof FlowError) this.errors.push(e);
        else throw e;
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

    // 2. final names: keep the simple name when unique, otherwise qualify.
    // Class methods are called by their bare name inside instances, so a global
    // function with the same name is qualified apart (`get` vs `get$std$http`).
    const methodNames = new Set<string>();
    for (const u of units) {
      for (const d of u.program.decls) {
        if (d.k !== "Trait") continue;
        for (const m of d.methods) methodNames.add(m.name);
      }
    }
    const finalName = new Map<string, string>(); // `${unit.id}::${name}` -> final
    const symbols = new Map<string, SymInfo>();
    for (const [name, entries] of byName) {
      // Two declarations of the same effect name are the same capability (std
      // declares Server/Client/Store; a program may redeclare them), so effects
      // keep their simple name instead of being qualified apart.
      const sameEffect = entries.every((e) => e.decl.k === "Effect");
      const unique = (entries.length === 1 && !methodNames.has(name)) || sameEffect;
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
      // The prelude also re-exports what it imports: the Monad family is
      // declared in std::monad but every module sees `Functor`, `Applicative`,
      // `Monad` and `Alternative` through the prelude.
      for (const [alias, ref] of this.importTable(preludeUnit)) {
        const final = finalName.get(`${ref.unit.id}::${ref.name}`);
        if (!final) continue;
        const decl = ref.unit.declares.get(ref.name);
        if (!decl) continue;
        if (decl.k === "Adt" || decl.k === "RecordType" || decl.k === "Alias") preludeTypes.set(alias, final);
        else preludeValues.set(alias, final);
        if (decl.k === "Adt") {
          for (const v of decl.variants) {
            const vFinal = finalName.get(`${ref.unit.id}::${v.name}`);
            if (vFinal) preludeValues.set(v.name, vFinal);
          }
        }
      }
    }

    // `std::list::map` paths resolve through the same final names, visible only
    // when the declaration is `pub`.
    const qValues = new Map<string, string>();
    const qTypes = new Map<string, string>();
    const isTypeName = (d: Decl, name: string) =>
      d.k === "RecordType" || d.k === "Alias" || (d.k === "Adt" && name === d.name);
    for (const u of units) {
      for (const [n, d] of u.declares) {
        if (!(d as { pub?: boolean }).pub) continue;
        const key = `${u.id}::${n}`;
        const final = finalName.get(key);
        if (!final) continue;
        if (isTypeName(d, n)) qTypes.set(key, final);
        else qValues.set(key, final);
      }
    }

    // The prelude is an import surface too: `Prelude.at` / `Flow.Prelude.at`
    // resolve to the module that actually declares the name.
    const preludeQual = this.units.get("std::prelude");
    if (preludeQual) {
      for (const [alias, ref] of this.importTable(preludeQual)) {
        const final = finalName.get(`${ref.unit.id}::${ref.name}`);
        const decl = ref.unit.declares.get(ref.name);
        if (!final || !decl) continue;
        const key = `${preludeQual.id}::${alias}`;
        if (isTypeName(decl, ref.name)) qTypes.set(key, final);
        else qValues.set(key, final);
      }
    }
    QUALIFIED_VALUES = qValues;
    QUALIFIED_TYPES = qTypes;

    UNIT_BY_ID = new Map(units.map((u) => [u.id, u]));

    for (const u of units) {
      const values = new Map<string, string>();
      const types = new Map<string, string>();
      const unitName = moduleDisplayName(u, this.entry.pkg);
      for (const [n, d] of u.declares) {
        const final = finalName.get(`${u.id}::${n}`);
        if (!final) continue;
        display.set(final, `${unitName}.${n}`);
        if (d.k === "Adt" || d.k === "RecordType" || d.k === "Alias") types.set(n, final);
        if (d.k === "Adt") for (const v of d.variants) values.set(v.name, finalName.get(`${u.id}::${v.name}`)!);
        if (d.k === "Fn" || d.k === "Extern" || d.k === "Trait" || d.k === "Effect") values.set(n, final);
      }
      for (const [alias, ref] of this.importTable(u)) {
        const final = finalName.get(`${ref.unit.id}::${ref.name}`);
        if (!final) continue;
        display.set(final, `${moduleDisplayName(ref.unit, this.entry.pkg)}.${ref.name}`);
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

      CUR_QUALS = u.quals;
      CUR_UNIT = u;
      CUR_REPORT = (msg, span) => {
        const err = new FlowError(msg, { file: u.file, line: span?.line, col: span?.col, code: "E_MODULE" });
        if (this.recover) this.errors.push(err); else throw err;
      };
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
      errors: this.errors,
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

/**
 * Every dotted reference in a unit — `Option.map`, `Option.Some`, `Shapes.Circle.area`,
 * `List.List a` — as the full name; the qualifier is everything before the last dot.
 */
function collectQualifiers(program: Program): Set<string> {
  const out = new Set<string>();
  const add = (name?: string) => {
    if (!name) return;
    const i = name.lastIndexOf(".");
    if (i > 0) out.add(name.slice(0, i));
  };
  const ty = (t?: TypeExpr): void => {
    if (!t) return;
    switch (t.k) {
      case "TCon": add(t.name); t.args.forEach(ty); return;
      case "TFun": t.params.forEach(ty); ty(t.ret); t.eff?.effects.forEach(add); return;
      case "TRecord": t.fields.forEach((f) => ty(f.type)); return;
      case "TTuple": t.items.forEach(ty); return;
      case "TPlaced": ty(t.inner); return;
      default: return;
    }
  };
  const pat = (p: Pattern): void => {
    switch (p.k) {
      case "PCtor": add(p.name); p.args.forEach(pat); return;
      case "PTuple": p.items.forEach(pat); return;
      case "PRecord": p.fields.forEach((f) => pat(f.pat)); return;
      case "PList": p.items.forEach(pat); return;
      case "PVar": ty(p.ann); return;
      default: return;
    }
  };
  const sig = (s: FnSig): void => {
    s.params.forEach((p) => ty(p.type));
    ty(s.ret);
    s.eff?.effects.forEach(add);
  };
  const html = (n: HtmlNode): void => {
    switch (n.k) {
      case "Hole": ex(n.e); return;
      case "Element": case "Component":
        for (const a of n.attrs) if (a.value.k === "expr") ex(a.value.e);
        n.children.forEach(html);
        return;
      default: return;
    }
  };
  const ex = (e?: Expr): void => {
    if (!e) return;
    switch (e.k) {
      case "Lit": case "Var": return;
      case "Ctor": add(e.name); e.args.forEach(ex); return;
      case "Lam":
        e.params.forEach((p) => ty(p.type)); ty(e.ret); e.eff?.effects.forEach(add);
        ex(e.body); return;
      case "App": ex(e.fn); e.args.forEach(ex); return;
      case "If": ex(e.cond); ex(e.then); ex(e.else); return;
      case "Match":
        ex(e.scrut);
        for (const a of e.arms) { pat(a.pat); ex(a.guard); ex(a.body); }
        return;
      case "Let": ty(e.ann); ex(e.value); ex(e.body); return;
      case "Record": e.fields.forEach((f) => ex(f.value)); return;
      case "Field":
        // `Option.map`: a constructor-shaped target is a candidate module qualifier
        if (e.target.k === "Ctor" && e.target.args.length === 0) add(`${e.target.name}.${e.name}`);
        else ex(e.target);
        return;
      case "Tuple": case "List": e.items.forEach(ex); return;
      case "Binary": ex(e.l); ex(e.r); return;
      case "Unary": ex(e.e); return;
      case "Html": e.nodes.forEach(html); return;
      case "Handle":
        add(e.effect);
        for (const op of e.ops) ex(op.fn);
        ex(e.body); return;
      case "Assign": ex(e.target); ex(e.value); return;
      case "Block":
        for (const s of e.stmts) { if (s.k === "LetStmt") { ty(s.ann); ex(s.value); } else ex(s.e); }
        ex(e.value); return;
    }
  };

  for (const d of program.decls) {
    switch (d.k) {
      case "Use": break;
      case "Fn":
        d.params.forEach((p) => ty(p.type)); ty(d.ret); d.eff?.effects.forEach(add);
        ex(d.body);
        break;
      case "Extern": sig(d.sig); break;
      case "Adt": for (const v of d.variants) v.args.forEach(ty); break;
      case "RecordType": d.fields.forEach((f) => ty(f.type)); break;
      case "Alias": ty(d.type); break;
      case "Trait": d.methods.forEach(sig); break;
      case "Impl":
        add(d.trait);
        d.traitArgs.forEach(ty); ty(d.target);
        for (const m of d.methods) { sig(m); ex(m.body); }
        break;
      case "Effect": d.ops.forEach(sig); break;
      case "Provide":
        add(d.effect);
        ty(d.target);
        d.ops.forEach((o) => ex(o.fn));
        break;
    }
  }
  return out;
}

const BUILTIN_TYPES = new Set([
  "Int", "Float", "Str", "Bool", "Unit", "Html", "List", "Option", "Cell", "Event", "Dom",
]);

/* Per-unit state of the rewrite in progress (the rewriters are plain recursive functions). */
let CURRENT_VALUES: Map<string, string> = new Map();
let QUALIFIED_VALUES: Map<string, string> = new Map();
let QUALIFIED_TYPES: Map<string, string> = new Map();
let UNIT_BY_ID: Map<string, SourceUnit> = new Map();
let CUR_QUALS: Map<string, string> = new Map();
let CUR_UNIT: SourceUnit | null = null;
let CUR_REPORT: (msg: string, span?: { line?: number; col?: number }) => void = () => {};

/** `List` + `map` -> the final name of `List.map`, or reports why it cannot be used. */
function qualify(qual: string, name: string, kind: "value" | "type", span?: { line?: number; col?: number }): string | null {
  const unitId = CUR_QUALS.get(qual);
  if (!unitId) return null;
  const key = `${unitId}::${name}`;
  const hit = (kind === "type" ? QUALIFIED_TYPES : QUALIFIED_VALUES).get(key);
  if (hit) return hit;
  const target = UNIT_BY_ID.get(unitId);
  const where = target ? moduleDisplayName(target, CUR_UNIT?.pkg) : qual;
  const decl = target?.declares.get(name);
  if (decl && !(decl as { pub?: boolean }).pub) {
    CUR_REPORT(`'${qual}.${name}' is private: ${name} is not in the export list of module ${where}`, span);
  } else {
    CUR_REPORT(`module ${where} has no ${kind === "type" ? "type" : "member"} '${name}'`, span);
  }
  return null;
}

/** A dotted name `A.B.f` in a value position. */
function qualValue(full: string, span?: { line?: number; col?: number }): string | undefined {
  const i = full.lastIndexOf(".");
  if (i <= 0) return undefined;
  return qualify(full.slice(0, i), full.slice(i + 1), "value", span) ?? undefined;
}

const effLabels = (row: { effects: string[] }) => ({
  ...row,
  effects: row.effects.map((e) => CURRENT_VALUES.get(e) ?? qualValue(e) ?? e),
});

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
        paramBounds: rwBounds(d.paramBounds, values, d.span),
        params,
        ret: d.ret ? rwType(d.ret, types) : undefined,
        eff: d.eff ? effLabels(d.eff) : undefined,
        body: rwExpr(d.body, scope, values, types),
      };
    }
    case "Adt":
      return {
        ...d,
        name: types.get(d.name) ?? d.name,
        paramBounds: rwBounds(d.paramBounds, values, d.span),
        variants: d.variants.map((v) => ({
          ...v,
          name: values.get(v.name) ?? v.name,
          args: v.args.map((a) => rwType(a, types)),
        })),
      };
    case "RecordType":
      return {
        ...d,
        name: types.get(d.name) ?? d.name,
        paramBounds: rwBounds(d.paramBounds, values, d.span),
        fields: d.fields.map((f) => ({ ...f, type: rwType(f.type, types) })),
      };
    case "Alias":
      return {
        ...d,
        name: types.get(d.name) ?? d.name,
        paramBounds: rwBounds(d.paramBounds, values, d.span),
        type: rwType(d.type, types),
      };
    case "Trait":
      return {
        ...d,
        name: values.get(d.name) ?? d.name,
        paramBounds: rwBounds(d.paramBounds, values, d.span),
        methods: d.methods.map((m) => rwSig(m, types, values)),
      };
    case "Effect":
      return { ...d, name: values.get(d.name) ?? d.name, ops: d.ops.map((m) => rwSig(m, types, values)) };
    case "Impl":
      return {
        ...d,
        trait: values.get(d.trait) ?? qualValue(d.trait, d.span) ?? d.trait,
        traitArgs: d.traitArgs.map((t) => rwType(t, types)),
        target: rwType(d.target, types),
        ...(d.where
          ? { where: d.where.map((w) => ({ ...w, bounds: w.bounds.map((b) => values.get(b) ?? qualValue(b, d.span) ?? b) })) }
          : {}),
        methods: d.methods.map((m) => ({
          ...rwSig(m, types, values),
          body: rwExpr(m.body, new Set(m.params.map((p) => p.name)), values, types),
        })),
      };
    case "Provide":
      return {
        ...d,
        effect: values.get(d.effect) ?? qualValue(d.effect, d.span) ?? d.effect,
        target: d.target ? rwType(d.target, types) : undefined,
        ops: d.ops.map((o) => ({ ...o, fn: rwExpr(o.fn, new Set(), values, types) })),
      };
    case "Extern":
      return { ...d, sig: { ...rwSig(d.sig, types, values), name: values.get(d.sig.name) ?? d.sig.name } };
  }
  return d;
}

/** Bounds are plain names until here; they must become the same final names as uses. */
function rwBounds(
  bounds: Record<string, string[]> | undefined,
  values: Map<string, string>,
  span?: Span,
): Record<string, string[]> | undefined {
  if (!bounds) return undefined;
  const out: Record<string, string[]> = {};
  for (const [param, names] of Object.entries(bounds)) {
    out[param] = names.map((n) => values.get(n) ?? qualValue(n, span) ?? n);
  }
  return out;
}

function rwSig(
  s: { params: { name: string; type: TypeExpr; span: Span }[]; ret?: TypeExpr; eff?: { effects: string[] }; paramBounds?: Record<string, string[]>; span?: Span },
  types: Map<string, string>,
  values: Map<string, string>,
) {
  return {
    ...s,
    params: s.params.map((p) => ({ ...p, type: rwType(p.type, types) })),
    ret: s.ret ? rwType(s.ret, types) : undefined,
    eff: s.eff ? effLabels(s.eff) : undefined,
    ...(s.paramBounds ? { paramBounds: rwBounds(s.paramBounds, values, s.span) } : {}),
  };
}

function rwType(t: TypeExpr, types: Map<string, string>): TypeExpr {
  switch (t.k) {
    case "TVar": return t;
    case "TCon": {
      const name = types.get(t.name)
        ?? (t.name.includes(".") ? (qualify(t.name.slice(0, t.name.lastIndexOf(".")), t.name.slice(t.name.lastIndexOf(".") + 1), "type", t.span) ?? undefined) : undefined)
        ?? t.name;
      return { ...t, name, args: t.args.map((a) => rwType(a, types)) };
    }
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
    case "Ctor": {
      const name = values.get(e.name) ?? (e.name.includes(".") ? qualValue(e.name, e.span) : undefined) ?? e.name;
      return { ...e, name, args: e.args.map((a) => rwExpr(a, scope, values, types)) };
    }
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
          rwPattern(a.pat, inner, values, types);
          return { ...a, guard: a.guard ? rwExpr(a.guard, inner, values, types) : undefined, body: rwExpr(a.body, inner, values, types) };
        }),
      };
    }
    case "Let": {
      // the name is in scope in its own value, so local functions can recurse
      const inner = new Set(scope);
      inner.add(e.name);
      const value = rwExpr(e.value, inner, values, types);
      return { ...e, ann: e.ann ? rwType(e.ann, types) : undefined, value, body: rwExpr(e.body, inner, values, types) };
    }
    case "Record":
      return { ...e, fields: e.fields.map((f) => ({ ...f, value: rwExpr(f.value, scope, values, types) })) };
    case "Field": {
      // `Option.map` — a module-qualified name — versus `Server.log`, an effect operation
      const t = e.target;
      if (t.k === "Ctor" && t.args.length === 0 && !values.has(t.name) && CUR_QUALS.has(t.name)) {
        const hit = qualify(t.name, e.name, "value", e.span);
        if (hit) return { k: "Var", name: hit, span: e.span };
      }
      return { ...e, target: rwExpr(e.target, scope, values, types) };
    }
    case "Tuple": case "List":
      return { ...e, items: e.items.map((i) => rwExpr(i, scope, values, types)) };
    case "Binary":
      return { ...e, l: rwExpr(e.l, scope, values, types), r: rwExpr(e.r, scope, values, types) };
    case "Assign":
      return {
        ...e,
        target: rwExpr(e.target, scope, values, types),
        ...(e.value ? { value: rwExpr(e.value, scope, values, types) } : {}),
      };
    case "Unary":
      return { ...e, e: rwExpr(e.e, scope, values, types) };
    case "Html":
      return { ...e, nodes: e.nodes.map((n) => rwHtml(n, scope, values, types)) };
    case "Handle":
      return {
        ...e,
        effect: values.get(e.effect) ?? qualValue(e.effect, e.span) ?? e.effect,
        ops: e.ops.map((op) => ({ ...op, fn: rwExpr(op.fn, scope, values, types) })),
        body: rwExpr(e.body, scope, values, types),
      };
    case "Block": {
      let inner = new Set(scope);
      const stmts = e.stmts.map((s) => {
        if (s.k === "LetStmt") {
          const next = new Set(inner);
          next.add(s.name);
          const value = rwExpr(s.value, next, values, types);
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
        name: values.get(n.name) ?? (n.name.includes(".") ? qualValue(n.name, n.span) : undefined) ?? n.name,
        attrs: n.attrs.map((a) => (a.value.k === "expr" ? { ...a, value: { k: "expr", e: rwExpr(a.value.e, scope, values, types) } } : a)),
        children: n.children.map((c) => rwHtml(c, scope, values, types)),
      };
  }
}

function rwPattern(p: Pattern, scope: Set<string>, values: Map<string, string>, types: Map<string, string>): void {
  switch (p.k) {
    case "PVar": scope.add(p.name); if (p.ann) (p as { ann?: TypeExpr }).ann = rwType(p.ann, types); return;
    case "PTuple": p.items.forEach((q) => rwPattern(q, scope, values, types)); return;
    case "PRecord": p.fields.forEach((f) => rwPattern(f.pat, scope, values, types)); return;
    case "PList": p.items.forEach((q) => rwPattern(q, scope, values, types)); if (p.rest) scope.add(p.rest); return;
    case "PCtor":
      (p as { name: string }).name = values.get(p.name) ?? (p.name.includes(".") ? qualValue(p.name, p.span) : undefined) ?? p.name;
      p.args.forEach((q) => rwPattern(q, scope, values, types));
      return;
    default: return;
  }
}

void BUILTIN_TYPES;

/**
 * Flow — type inference, effect rows, and *placement inference*.
 *
 * The boundary is not written by the programmer. Every expression is assigned a
 * placement `p ∈ {neutral, client, server, cross}` derived from the *authority*
 * it exercises (the effects it requires). The tier split (split.ts) then cuts the
 * program exactly at the nodes whose placement does not match their context.
 *
 * Judgement:   Γ ⊢ e : τ ! ε @ p
 * Reference:   docs/type-system.md
 */

import { FlowError } from "./lexer.ts";
import type {
  Decl, Expr, FnSig, HtmlNode, Param, Pattern, Program, TypeExpr, EffRow, Place, Span,
} from "./ast.ts";
import {
  type Type, type Eff, fresh, prune, unify, unifyEff, generalize, instantiate,
  freeVars, emptyEff, con, INT, FLOAT, STR, BOOL, UNIT, HTML, fnT, listOf,
  cellOf, eventOf, typeStr, typeStrs, typeKey, joinPlace, typePlace, withTypePlace, hasGeneric,
  sendable, snapshotSubst, restoreSubst, markGeneric, resetSubst, resetIds, occurs,
} from "./types.ts";

export interface ResInfo { ty: Type; place: Place; eff: Eff }

export interface CtorInfo {
  typeName: string; variant: string; arity: number;
  typeParams: string[]; argTypes: TypeExpr[]; scheme: Type;
}

export interface TraitInfo {
  name: string; params: string[];
  /** type parameters used as type constructors (`f<a>`) */
  ctorParams: Set<string>;
  /** the trait's parameter variables, as they appear in method signatures */
  paramVars: Map<string, Type>;
  methods: Map<string, { sig: FnSig; ty: Type }>;
  /** superclass traits from `class Super f => Trait f` */
  supers: string[];
}

/** A hidden dictionary parameter for a bounded type parameter. */
export interface DictParam {
  trait: string;
  typeParam: string;
  name: string;
  varId: number;
}

export interface ImplInfo {
  trait: string; target: TypeExpr; targetType?: Type; index: number;
  where?: { name: string; bounds: string[] }[];
  params?: Map<string, Type>;
  dicts?: DictParam[];
  methods: Map<string, { params: Param[]; ret?: TypeExpr; eff?: EffRow; body: Expr }>;
  mangled: Map<string, string>;
}

export interface EffectInfo {
  name: string;
  ops: Map<string, { sig: FnSig; ty: Type }>;
  place: Place;
  /** The effect has a default handler installed by provide. */
  provided?: boolean;
}

export interface ProvideInfo { effect: string; ops: Map<string, Expr>; target?: TypeExpr; place: Place }

/** The only placement annotations a type may carry in source. */
export type AnnPlace = "client" | "server";

/** Top-level `@client` / `@server` on a type expression, if written. */
export function annotatedPlace(te: TypeExpr | undefined): AnnPlace | undefined {
  return te && te.k === "TPlaced" ? te.place : undefined;
}

export interface FnInfo {
  name: string; scheme: Type; params: Param[]; ret?: TypeExpr;
  eff?: EffRow; body?: Expr; pub: boolean; synthetic?: boolean;
  /** declared type parameters, resolved to their scheme variables */
  typeParams?: Map<string, Type>;
  /** top-level placement annotations on the signature, if written */
  paramPlaces?: (AnnPlace | undefined)[];
  retPlace?: AnnPlace;
  /** hidden dictionaries required by bounded type parameters */
  dicts?: DictParam[];
  /** native (JavaScript) implementation, for `unsafe extern` declarations */
  extern?: { target: "js"; implName: string; modulePath?: string; exportName?: string };
  /** placement of an FFI import, from its signature annotation */
  place?: Place;
  /** the placement inferred for this function's body */
  bodyPlace?: Place;
  /** declaration span, for editor features */
  span?: { start: number; end: number; line: number; col: number; file?: string };
}

export interface EnvEntry { ty: Type; envVars: Set<number>; place: Place }

export interface Module {
  file: string;
  fns: Map<string, FnInfo>;
  ctors: Map<string, CtorInfo>;
  traits: Map<string, TraitInfo>;
  impls: ImplInfo[];
  effects: Map<string, EffectInfo>;
  provides: Map<string, ProvideInfo>;
  typeDefs: Map<string, { params: string[]; kind: "adt" | "record" | "alias"; decl: Decl }>;
  info: Map<object, ResInfo>;
  implChoices: Map<object, { impl: ImplInfo; method: string; mangled: string; dicts?: { trait: string; type: Type }[] }>;
  /** trait calls on a bounded type variable, dispatched through a dictionary parameter */
  boundChoices: Map<object, { dictName: string; method: string; trait: string }>;
  /** dictionaries passed to a direct call of a bounded function */
  dictArgs: Map<object, { trait: string; type: Type }[]>;
  varTypes: Map<object, Type>;
  methodIndex: Map<string, string>;
  diagnostics: string[];
  /** type errors collected for the editor (the CLI rethrows the first one) */
  errors: FlowError[];
  /** calls whose callee may perform algebraic operations (they need `yield*`) */
  genCalls: Set<object>;
  /** calls with fewer arguments than the function's arity (curried partials) */
  partialCalls: Set<object>;
  /**
   * Right sections: a partial call whose supplied arguments fill the trailing
   * parameters, e.g. `Option.map f` for `map :: Option a -> (a -> b) -> Option b`.
   * The number stored is how many leading parameters the result still takes.
   */
  rightPartials: Map<object, number>;
  /** `resume` references inside algebraic handler operations */
  resumeVars: Set<object>;
  /**
   * Field projections that read a single-constructor ADT's record payload
   * (`data Todo = Todo { id :: Int }` -> `todo.id`). Codegen must read the
   * constructor's first argument instead of the value itself.
   */
  adtProjections: Set<object>;
  /**
   * Record patterns that destructure a single-constructor ADT's payload
   * (`case todo of { id = n } -> n`). Codegen must read `.args[0]` instead of
   * treating the value as a plain record.
   */
  recordAdtPatterns: Set<object>;
  /** references to top-level constants (`pi = 3.14`): evaluated by calling them */
  constRefs: Set<object>;
}

// The language surface that used to be injected here now lives in real std
// modules (Flow.Basics, Flow.List, Flow.String, Flow.Cell, Flow.Store) and
// reaches the host through `unsafe extern js` bindings. No callable primitive
// is registered by the compiler.

/** The source name of a trait, without a linker qualification suffix. */
export const traitBase = (trait: string) => trait.split("$")[0]!;

export const implFnName = (trait: string, index: number, method: string) =>
  `$impl_${traitBase(trait)}_${index}_${method}`;

export const dictParamName = (trait: string, typeParam: string) =>
  `$d_${traitBase(trait)}_${typeParam}`;

/** Key for the trait dictionaries carried by one type variable. */
export const dictKey = (trait: string, varId: number) => `${varId}:${trait}`;

/** Fields of the built-in browser DOM values (`Event`, `Dom`). */
const DOM_FIELDS: Record<string, Record<string, Type>> = {
  Event: {
    target: con("Dom"),
    currentTarget: con("Dom"),
    key: STR,
    type: STR,
  },
  Dom: {
    value: STR,
    checked: BOOL,
    id: STR,
    className: STR,
    tagName: STR,
    textContent: STR,
    innerHTML: STR,
  },
};

export function domFieldType(typeName: string, field: string): Type | null {
  return DOM_FIELDS[typeName]?.[field] ?? null;
}

export function domFieldNames(typeName: string): string[] | null {
  const fields = DOM_FIELDS[typeName];
  return fields ? Object.keys(fields) : null;
}

/** HTML boolean attributes accept `Bool`; `setAttr` adds/removes them. */
const BOOL_ATTRIBUTES = new Set([
  "checked", "disabled", "selected", "readonly", "readOnly", "required",
  "autofocus", "multiple", "hidden", "open", "novalidate", "formnovalidate",
]);

/** Numeric HTML attributes. */
const INT_ATTRIBUTES = new Set([
  "cols", "rows", "size", "maxlength", "maxLength", "minlength", "minLength",
  "tabindex", "tabIndex", "width", "height", "span", "start", "step",
]);

/** A type parameter's declared bounds, or an empty list. */
const boundsOf = (paramBounds: Record<string, string[]> | undefined, name: string): string[] =>
  paramBounds?.[name] ?? [];

const BUILTIN_TYPES = new Set([
  "Int", "Float", "Str", "Bool", "Unit", "Html", "List", "Cell", "Event", "Dom",
]);

export class Infer {
  mod: Module;
  env = new Map<string, EnvEntry>();
  /** type parameters of the declaration whose body is being checked */
  typeParams = new Map<string, Type>();
  /** declarations whose signature failed: references must not cascade errors */
  private failedNames = new Set<string>();
  /** `(variable id, trait)` -> dictionary parameter name while checking a body */
  currentDicts = new Map<string, string>();
  /** return-position trait calls waiting for the body's types to settle */
  private pendingTraitCalls: {
    node: object;
    trait: string;
    method: string;
    target: Type;
    di: number;
    span?: { line?: number; col?: number; file?: string };
  }[] = [];
  private uidCtor = 0;
  /** the type a lambda argument is expected to have, so its parameters need no annotation */
  private expectedFor = new Map<Expr, Type>();
  /**
   * Field accesses on a value whose type is not known yet. Committing such a
   * value to `{ field :: t }` would reject a nominal record ADT that arrives
   * later (`List.fold f 0 . map (\t -> t.id)` annotated `List Todo -> Int`),
   * so the access is resolved once the value's type is known.
   */
  private pendingFields: {
    target: Type;
    name: string;
    ty: Type;
    span: { line?: number; col?: number; file?: string };
    node: Expr;
  }[] = [];

  /** Can `t` be generalized now, or does a field access still constrain it? */
  private canGeneralize(t: Type): boolean {
    if (!this.pendingFields.length) return true;
    const held = new Set<number>();
    for (const p of this.pendingFields) {
      const q = prune(p.target);
      if (q.k === "var") held.add(q.id);
    }
    if (!held.size) return true;
    for (const id of freeVars(t)) if (held.has(id)) return false;
    return true;
  }

  /**
   * Infer a call argument; a lambda learns its parameter types from the callee,
   * and a record literal hands the expected field types down to nested
   * lambdas, so `serve { page = \req -> … }` types `req` as `RequestObject`.
   */
  private inferArg(a: Expr, expected: Type): ResInfo {
    if (a.k === "Lam" || a.k === "Record") this.expectedFor.set(a, expected);
    return this.infer(a);
  }

  constructor(file: string) {
    this.mod = {
      file, fns: new Map(), ctors: new Map(), traits: new Map(), impls: [],
      effects: new Map(), provides: new Map(), typeDefs: new Map(),
      info: new Map(), implChoices: new Map(), boundChoices: new Map(), dictArgs: new Map(), methodIndex: new Map(),
      varTypes: new Map(),
      diagnostics: [],
      errors: [],
      genCalls: new Set(),
      partialCalls: new Set(),
      rightPartials: new Map(),
      adtProjections: new Set(),
      recordAdtPatterns: new Set(),
      constRefs: new Set(),
      resumeVars: new Set(),
    };
  }

  fail(msg: string, span?: { line?: number; col?: number; file?: string }): never {
    const s = span ?? this.lastSpan;
    throw new FlowError(msg, {
      file: s?.file ?? this.mod.file,
      line: s?.line, col: s?.col, code: "E_TYPE",
    });
  }

  lastSpan: { line?: number; col?: number; file?: string } | undefined;

  /** Run a checking step, recording type errors instead of aborting the whole
   *  analysis — an editor wants every error, not just the first. */
  private collect(step: () => void): boolean {
    try {
      step();
      return true;
    } catch (e) {
      if (!(e instanceof FlowError)) throw e;
      const key = `${e.file}:${e.line}:${e.col}:${e.message}`;
      if (!this.mod.errors.some((x) => `${x.file}:${x.line}:${x.col}:${x.message}` === key)) {
        this.mod.errors.push(e);
      }
      return false;
    }
  }

  /* ---------------------------------------------------------------- */
  /* driver                                                           */
  /* ---------------------------------------------------------------- */

  run(prog: Program): Module {
    // Unification state is process-global so `prune` can follow bindings by id.
    // It must start empty per compilation: leaving it behind made every
    // speculative `snapshotSubst()` copy grow with all previous compiles, which
    // turned each editor reanalysis into seconds of work.
    resetSubst();
    resetIds();
    this.failedNames.clear();
    this.collect(() => this.checkDuplicateDeclarations(prog));
    // Register every type first: effects and traits in a later unit may name a
    // type that appears earlier or later in the flattened program.
    for (const d of prog.decls) {
      if (d.k === "Adt" || d.k === "RecordType" || d.k === "Alias") this.collect(() => this.registerType(d));
    }
    for (const d of prog.decls) {
      if (d.k === "Trait") this.collect(() => this.registerTrait(d));
      if (d.k === "Effect") this.collect(() => this.registerEffect(d));
    }
    this.checkDeclaredRows(prog);
    for (const d of prog.decls) if (d.k === "Adt") this.collect(() => this.registerCtors(d));
    for (const d of prog.decls) if (d.k === "Impl") this.collect(() => this.registerImpl(d));
    for (const d of prog.decls) if (d.k === "Fn") {
      const ok = this.isInferredFn(d) ? this.collect(() => this.declareInferred(d)) : this.collect(() => this.declareFn(d));
      if (!ok) this.failedNames.add(d.name);
    }
    for (const d of prog.decls) if (d.k === "Extern") {
      if (!this.collect(() => this.declareExtern(d))) this.failedNames.add(d.sig.name);
    }

    // Capabilities (Server / Client / Store) are declared by Flow.Server,
    // Flow.Client and Flow.Store, which every module reaches through the
    // prelude re-export; the compiler injects nothing here.

    // Providers determine where an effect lives, and effect placement determines
    // where the calls are placed. Run both to a fixpoint.
    this.collect(() => this.checkProvides(prog));
    for (const d of prog.decls) if (d.k === "Provide") this.collect(() => this.registerProvide(d));
    this.applyProviderPlaces();

    // Functions without a signature are inferred callee-first, so that each one
    // is generalized before its callers instantiate it.
    const groups = this.fnGroups(prog);
    const generalized = new Set<string>();
    for (let pass = 0; pass < 8; pass++) {
      const before = this.placementFingerprint();
      for (const group of groups) {
        for (const d of group) this.collect(() => this.checkFnBody(d));
        for (const d of group) {
          if (!this.isInferredFn(d) || generalized.has(d.name)) continue;
          const info = this.mod.fns.get(d.name);
          if (info) markGeneric(info.scheme);
          generalized.add(d.name);
        }
      }
      for (const d of prog.decls) if (d.k === "Impl") this.collect(() => this.checkImplBodies(d));
      this.collect(() => this.checkProvides(prog));
      for (const d of prog.decls) if (d.k === "Provide") this.collect(() => this.registerProvide(d));
      this.applyProviderPlaces();
      if (this.placementFingerprint() === before) break;
    }

    this.mod.diagnostics = [...this.mod.info.values()].length ? [] : [];
    return this.mod;
  }

  private placementFingerprint(): string {
    const parts = [this.effectFingerprint()];
    for (const e of this.mod.effects.values()) parts.push(`p:${e.name}:${e.place}:${e.provided ? "provider" : "handled"}`);
    for (const p of this.mod.provides.values()) parts.push(`v:${p.effect}:${p.place}`);
    return parts.join(";");
  }

  private effectFingerprint(): string {
    const parts: string[] = [];
    for (const f of this.mod.fns.values()) {
      if (f.scheme.k === "fun") parts.push(f.name + ":" + [...f.scheme.eff.labels].sort().join("|"));
      // a body's inferred side feeds its callers, so it participates in the fixpoint
      if (f.bodyPlace) parts.push("bp:" + f.name + ":" + f.bodyPlace);
    }
    return parts.sort().join(";");
  }

  /* ---------------------------------------------------------------- */
  /* environment                                                      */
  /* ---------------------------------------------------------------- */

  lookupVar(name: string, span?: { line: number; col: number }): Type {
    if (this.failedNames.has(name)) return fresh(0);
    const local = this.env.get(name);
    if (local) return hasGeneric(local.ty) ? instantiate(local.ty, 0) : local.ty;
    const fn = this.mod.fns.get(name);
    if (fn) return instantiate(fn.scheme, 0);
    const ctor = this.mod.ctors.get(name);
    if (ctor) return instantiate(ctor.scheme, 0);
    const eop = this.findEffectOp(name);
    if (eop) { const t = instantiate(eop.ty, 0); if (t.k === "fun") t.eff.labels.add(eop.effect); return t; }
    const tname = this.mod.methodIndex.get(name);
    if (tname) {
      const tr = this.mod.traits.get(tname)!;
      return instantiate(tr.methods.get(name)!.ty, 0);
    }
    const hint = name === "serve"
      ? " - add `import Flow.Http (serve)` or write `Flow.Http.serve`"
      : "";
    this.fail(`unbound name '${name}'${hint}`, span);
  }

  private findEffectOp(name: string): { ty: Type; effect: string } | null {
    let found: { ty: Type; effect: string } | null = null;
    for (const e of this.mod.effects.values()) {
      const op = e.ops.get(name);
      if (op) {
        if (found) this.fail(`ambiguous effect operation '${name}' — qualify it as Effect.${name}()`);
        found = { ty: op.ty, effect: e.name };
      }
    }
    return found;
  }

  /** Placement contributed by a variable reference.
   *  A binding is a name, not a location: the *value* that flows into it is
   *  where the cut happens, so locals are always place-neutral. */
  varPlace(name: string): Place {
    if (this.env.has(name)) return "neutral";
    const fn = this.mod.fns.get(name);
    // a function placed by its body (client/server modules, FFI annotations)
    if (fn?.place) return fn.place;
    if (fn?.bodyPlace && fn.bodyPlace !== 'neutral') return fn.bodyPlace;
    if (fn && fn.scheme.k === "fun") return placeFromEffects(fn.scheme.eff, this);
    const eop = this.findEffectOp(name);
    if (eop) { const e = this.mod.effects.get(eop.effect); return e ? e.place : "server"; }
    return "neutral";
  }

  /* ---------------------------------------------------------------- */
  /* declarations                                                     */
  /* ---------------------------------------------------------------- */

  /** Two declarations of the same name in one file are always a mistake; the
   *  linker renames across modules, so equal names here mean one file. */
  private checkDuplicateDeclarations(prog: Program) {
    const seen = new Map<string, Decl>();
    for (const d of prog.decls) {
      let name: string | null = null;
      if (d.k === "Fn" || d.k === "Adt" || d.k === "RecordType" || d.k === "Alias" || d.k === "Trait" || d.k === "Effect") name = d.name;
      if (d.k === "Extern") name = d.sig.name;
      if (!name || d.k === "Effect") continue; // effect declarations merge
      const key = `${d.span?.file ?? prog.file}\u0000${name}`;
      const prev = seen.get(key);
      if (prev) {
        this.fail(`duplicate declaration '${name}' (first declared at line ${prev.span?.line ?? "?"})`, d.span);
      }
      seen.set(key, d);
    }
  }

  /** Validate rows and signatures once every effect and trait is known. */
  private checkDeclaredRows(prog: Program) {
    for (const d of prog.decls) this.collect(() => this.checkDeclaredRow(d));
  }

  private checkDeclaredRow(d: Decl) {
    switch (d.k) {
        case "Fn":
          this.checkSigRows(d);
          break;
        case "Extern":
          this.checkSigRows(d.sig);
          break;
        case "Effect":
          for (const op of d.ops) this.checkSigRows(op);
          break;
        case "Trait":
          this.checkBounds(d.params, d.paramBounds, d.span);
          for (const m of d.methods) this.checkSigRows(m);
          break;
        case "Impl": {
          const names = new Set<string>();
          for (const w of d.where ?? []) {
            if (names.has(w.name)) this.fail(`duplicate impl parameter '${w.name}'`, d.span);
            names.add(w.name);
            for (const b of w.bounds) {
              if (!this.mod.traits.has(b)) this.fail(`unknown trait '${b}' in the bounds of '${w.name}'${this.traitHint(b)}`, d.span);
            }
          }
          for (const m of d.methods) this.checkSigRows(m);
          break;
        }
        case "Adt":
          this.checkBounds(d.params, d.paramBounds, d.span);
          for (const v of d.variants) for (const a of v.args) this.checkTypeRows(a);
          break;
        case "RecordType": {
          this.checkBounds(d.params, d.paramBounds, d.span);
          const params = new Map<string, Type>();
          for (const p of d.params) { const v = fresh(0); v.generic = true; params.set(p, v); }
          const seenFields = new Set<string>();
          for (const f of d.fields) {
            if (seenFields.has(f.name)) this.fail(`duplicate field '${f.name}' in record type ${d.name}`, f.type.span);
            seenFields.add(f.name);
            this.checkTypeRows(f.type);
            this.resolveType(f.type, params);
          }
          break;
        }
        case "Alias": {
          this.checkBounds(d.params, d.paramBounds, d.span);
          const params = new Map<string, Type>();
          for (const p of d.params) { const v = fresh(0); v.generic = true; params.set(p, v); }
          this.checkTypeRows(d.type);
          this.resolveType(d.type, params);
          break;
        }
        case "Provide":
          if (d.target) this.resolveType(d.target, new Map());
          break;
    }
  }

  private checkSigRows(s: FnSig) {
    this.checkBounds(s.typeParams, s.paramBounds, s.span);
    const typeParams = new Set<string>();
    for (const tp of s.typeParams ?? []) {
      if (typeParams.has(tp)) this.fail(`duplicate type parameter '${tp}'`, s.span);
      typeParams.add(tp);
    }
    const names = new Set<string>();
    for (const p of s.params) {
      if (names.has(p.name)) this.fail(`duplicate parameter '${p.name}' in '${s.name}'`, p.span);
      names.add(p.name);
      this.checkTypeRows(p.type);
    }
    this.checkTypeRows(s.ret);
    this.checkEffectRow(s.eff, s.span);
  }

  private checkTypeRows(te: TypeExpr | undefined) {
    if (!te) return;
    switch (te.k) {
      case "TVar": return;
      case "TCon": for (const a of te.args) this.checkTypeRows(a); return;
      case "TFun":
        for (const p of te.params) this.checkTypeRows(p);
        this.checkTypeRows(te.ret);
        this.checkEffectRow(te.eff, te.span);
        return;
      case "TRecord":
        for (const f of te.fields) this.checkTypeRows(f.type);
        return;
      case "TTuple": for (const i of te.items) this.checkTypeRows(i); return;
      case "TPlaced": this.checkTypeRows(te.inner); return;
    }
  }

  private checkEffectRow(row: EffRow | undefined, span: Span) {
    if (row?.var) {
      this.fail(
        `effect row variables are not supported (found '${row.var}'): list the effects explicitly`,
        row.varSpan ?? span,
      );
    }
    for (const label of row?.effects ?? []) {
      if (!this.mod.effects.has(label)) {
        const at = row?.spans?.find((s) => s.name === label)?.span ?? span;
        this.fail(`unknown effect '${label}'${this.effectHint(label)}`, at);
      }
    }
  }

  private checkBounds(params: string[] | undefined, bounds: Record<string, string[]> | undefined, span: Span) {
    this.checkParamList(params, span);
    if (!bounds) return;
    const declared = new Set(params ?? []);
    for (const [param, list] of Object.entries(bounds)) {
      if (!declared.has(param)) this.fail(`bound on undeclared type parameter '${param}'`, span);
      for (const b of list) {
        if (!this.mod.traits.has(b)) this.fail(`unknown trait '${b}' in the bounds of '${param}'${this.traitHint(b)}`, span);
      }
    }
  }

  private checkParamList(params: string[] | undefined, span: Span) {
    const seen = new Set<string>();
    for (const p of params ?? []) {
      if (seen.has(p)) this.fail(`duplicate type parameter '${p}'`, span);
      seen.add(p);
    }
  }

  private effectHint(name: string): string {
    const lower = name.toLowerCase();
    const near = [...this.mod.effects.keys()].find((k) => k.toLowerCase() === lower) ??
      [...this.mod.effects.keys()].find((k) => editDistance(k.toLowerCase(), lower) <= 2);
    return near ? ` — did you mean '${near}'?` : "";
  }

  private traitHint(name: string): string {
    const lower = name.toLowerCase();
    const near = [...this.mod.traits.keys()].find((k) => k.toLowerCase() === lower) ??
      [...this.mod.traits.keys()].find((k) => editDistance(k.toLowerCase(), lower) <= 2);
    return near ? ` — did you mean '${near}'?` : "";
  }

  registerType(d: Decl) {
    if (d.k === "Adt") this.mod.typeDefs.set(d.name, { params: d.params, kind: "adt", decl: d });
    if (d.k === "RecordType") this.mod.typeDefs.set(d.name, { params: d.params, kind: "record", decl: d });
    if (d.k === "Alias") this.mod.typeDefs.set(d.name, { params: d.params, kind: "alias", decl: d });
  }

  registerCtors(d: Decl & { k: "Adt" }) {
    const variants = new Set<string>();
    for (const v of d.variants) {
      if (variants.has(v.name)) this.fail(`duplicate constructor '${v.name}' in type ${d.name}`, v.span);
      variants.add(v.name);
      if (this.mod.ctors.has(v.name)) this.fail(`duplicate constructor '${v.name}' (already declared)`, v.span);
      const params = new Map<string, Type>();
      for (const p of d.params) { const tv = fresh(0); tv.generic = true; params.set(p, tv); }
      const argTypes = v.args.map((a) => this.resolveType(a, params));
      const result = con(d.name, ...d.params.map((p) => params.get(p)!));
      const ty = argTypes.length ? fnT(argTypes, result) : result;
      this.mod.ctors.set(v.name, {
        typeName: d.name, variant: v.name, arity: v.args.length,
        typeParams: d.params, argTypes: v.args, scheme: ty,
      });
    }
  }

  registerTrait(d: Decl & { k: "Trait" }) {
    const params = new Map<string, Type>();
    for (const p of d.params) { const tv = fresh(0); tv.generic = true; params.set(p, tv); }
    const ctorParams = new Set<string>();
    const scanType = (te: TypeExpr | undefined) => {
      if (!te) return;
      switch (te.k) {
        case "TCon":
          if (d.params.includes(te.name) && te.args.length > 0) ctorParams.add(te.name);
          for (const a of te.args) scanType(a);
          break;
        case "TFun":
          for (const p of te.params) scanType(p);
          scanType(te.ret);
          break;
        case "TRecord":
          for (const f of te.fields) scanType(f.type);
          break;
        case "TTuple":
          for (const item of te.items) scanType(item);
          break;
        case "TPlaced":
          scanType(te.inner);
          break;
      }
    };
    for (const m of d.methods) {
      for (const p of m.params) scanType(p.type);
      scanType(m.ret);
    }
    const methods = new Map<string, { sig: FnSig; ty: Type }>();
    for (const m of d.methods) {
      const ty = this.resolveSig(m, params);
      methods.set(m.name, { sig: m, ty });
      this.mod.methodIndex.set(m.name, d.name);
    }
    const supers = [...new Set(Object.values(d.paramBounds ?? {}).flat())];
    this.mod.traits.set(d.name, { name: d.name, params: d.params, ctorParams, paramVars: params, methods, supers });
  }

  /** A trait and all of its superclasses, in written-then-super order. */
  expandBounds(bounds: string[]): string[] {
    const out: string[] = [];
    const visit = (trait: string) => {
      if (out.includes(trait)) return;
      out.push(trait);
      for (const superTrait of this.mod.traits.get(trait)?.supers ?? []) visit(superTrait);
    };
    for (const b of bounds) visit(b);
    return out;
  }

  registerEffect(d: Decl & { k: "Effect" }) {
    // Declarations with the same name describe the same capability: merge their
    // operations so a program may redeclare a subset (or extend) an effect that
    // std already declares.
    const existing = this.mod.effects.get(d.name);
    const ops = new Map(existing?.ops ?? []);
    for (const o of d.ops) ops.set(o.name, { sig: o, ty: this.resolveSig(o, new Map()) });
    this.mod.effects.set(d.name, {
      name: d.name,
      ops,
      // An effect may be declared on a side or left neutral. A provider can
      // pin it later; an unprovided effect runs wherever its handler runs.
      place: d.place ?? existing?.place ?? "neutral",
      provided: existing?.provided,
    });
  }

  /** A provider decides where its effect runs; otherwise the declaration's
   *  `@ client` / `@ server` annotation stands. A provider whose body is
   *  placement-neutral (FFI calls, pure code) does not move the effect. */
  private applyProviderPlaces() {
    for (const e of this.mod.effects.values()) {
      const p = this.mod.provides.get(e.name);
      e.provided = Boolean(p);
      if (p && p.place !== "neutral") e.place = p.place;
    }
  }

  registerImpl(d: Decl & { k: "Impl" }) {
    const index = this.mod.impls.length;
    const mangled = new Map<string, string>();
    const methods = new Map<string, { params: Param[]; ret?: TypeExpr; eff?: EffRow; body: Expr }>();
    const implParams = new Map<string, Type>();
    const dicts: DictParam[] = [];

    // 1. the trait's type parameters, so method signatures can name them
    const traitInfo = this.mod.traits.get(d.trait);
    for (const p of traitInfo?.params ?? []) {
      const v = fresh(0);
      v.generic = true;
      implParams.set(p, v);
    }

    // 2. `where a: Trait` gives the impl's type variables their dictionaries.
    for (const w of d.where ?? []) {
      const v = implParams.get(w.name) ?? fresh(0);
      v.generic = true;
      const bs = this.expandBounds(w.bounds);
      v.bounds = [...new Set([...(v.bounds ?? []), ...bs])];
      implParams.set(w.name, v);
      for (const b of bs) {
        dicts.push({ trait: b, typeParam: w.name, name: dictParamName(b, w.name), varId: v.id });
      }
    }

    // 3. Type variables that appear only in the target are implicitly quantified
    //    per instance: `instance Functor (Result e)` has an error type `e`.
    const collectTargetVars = (te: TypeExpr): void => {
      switch (te.k) {
        case "TVar":
          if (te.name !== "_" && !implParams.has(te.name)) {
            const v = fresh(0);
            v.generic = true;
            implParams.set(te.name, v);
          }
          return;
        case "TCon":
          for (const a of te.args) collectTargetVars(a);
          return;
        case "TFun":
          for (const p of te.params) collectTargetVars(p);
          collectTargetVars(te.ret);
          return;
        case "TRecord":
          for (const f of te.fields) collectTargetVars(f.type);
          return;
        case "TTuple":
          for (const item of te.items) collectTargetVars(item);
          return;
        case "TPlaced":
          collectTargetVars(te.inner);
          return;
      }
    };
    collectTargetVars(d.target);

    const targetType = this.resolveType(d.target, implParams);
    for (const v of implParams.values()) if (v.k === "var") v.generic = true;

    const clash = this.mod.impls.find((im) =>
      im.trait === d.trait && im.targetType && typeKey(im.targetType) === typeKey(targetType));
    if (clash) {
      this.fail(`duplicate impl of ${traitBase(d.trait)} for ${typeStr(targetType)}`, d.span);
    }

    const implNames = new Set(d.methods.map((m) => m.name));
    if (!traitInfo) this.fail(`impl for unknown trait '${d.trait}'`, d.span);
    for (const m of d.methods) {
      if (traitInfo && !traitInfo.methods.has(m.name)) {
        this.fail(`trait ${traitBase(d.trait)} has no method '${m.name}'`, m.span);
      }
    }
    if (traitInfo) {
      const missing = [...traitInfo.methods.keys()].filter((name) => !implNames.has(name));
      if (missing.length) {
        this.fail(
          `impl ${traitBase(d.trait)} for ${typeStr(targetType)} is missing method(s) ${missing.sort().join(", ")}`,
          d.span,
        );
      }
    }

    for (const m of d.methods) {
      const fname = implFnName(d.trait, index, m.name);
      const scheme = this.resolveSig(m, implParams);
      markGeneric(scheme);
      const traitMethod = traitInfo?.methods.get(m.name);
      if (traitMethod) {
        const before = snapshotSubst();
        let keepTypes = false;
        try {
          // Split the impl's type parameters the same way dispatch does: the
          // impl target must be the trait method's receiver. Then the rest of
          // the signature has to line up exactly.
          if (traitInfo) {
            if (d.traitArgs.length && d.traitArgs.length !== traitInfo.params.length) {
              this.fail(
                `impl ${d.trait} expects ${traitInfo.params.length} trait argument(s), got ${d.traitArgs.length}`,
                d.span,
              );
            }
            // work on a fresh copy of the trait's method type so nothing leaks into it
            const tmi = instantiate(traitMethod.ty, 0);
            if (tmi.k === "fun") {
              // the receiver is the first parameter that mentions the trait's type
              // parameter; a method with none (`empty :: () -> a`) dispatches on its result
              const di = this.dispatchIndex(traitInfo, traitMethod.ty);
              const sel = di >= 0 ? tmi.params[di]! : tmi.ret;
              const receiver = traitInfo.ctorParams.size > 0 ? headConstructor(sel) : sel;
              unify(receiver, targetType);
            }
            unify(tmi, scheme);
          } else {
            unify(scheme, traitMethod.ty);
          }
          // an instance method written without types takes them from the trait
          if (m.params.every((p) => p.type.k === "TVar" && p.type.name === "_") && !m.ret) keepTypes = true;
        } catch (err) {
          restoreSubst(before);
          if (err instanceof FlowError) {
            this.fail(
              `impl ${traitBase(d.trait)}.${m.name} does not match the trait signature: ${err.message}`,
              m.span,
            );
          }
          throw err;
        }
        if (!keepTypes) restoreSubst(before);
      }
      mangled.set(m.name, fname);
      methods.set(m.name, { params: m.params, ret: m.ret, eff: m.eff, body: m.body });
      this.mod.fns.set(fname, {
        name: fname, scheme, params: m.params, ret: m.ret,
        eff: m.eff, body: m.body, pub: false, synthetic: true, span: m.span,
        paramPlaces: m.params.map((p) => annotatedPlace(p.type)),
        retPlace: annotatedPlace(m.ret),
        dicts,
        typeParams: implParams,
      });
    }
    this.mod.impls.push({
      trait: d.trait, target: d.target, targetType, index,
      where: d.where, params: implParams, dicts, methods, mangled,
    });
  }

  checkImplBodies(d: Decl & { k: "Impl" }) {
    const index = this.mod.impls.findIndex((i) => i.trait === d.trait && i.target === d.target);
    if (index < 0) return;
    for (const m of d.methods) {
      const fname = implFnName(d.trait, index, m.name);
      this.checkNamedBody(fname, m.params, m.body, m.ret, m.eff);
    }
  }

  checkProvides(prog: Program) {
    for (const d of prog.decls) {
      if (d.k !== "Provide") continue;
      const effect = this.mod.effects.get(d.effect);
      if (!effect) this.fail(`provide for unknown effect '${d.effect}'`, d.span);
      for (const o of d.ops) {
        const decl = effect.ops.get(o.name);
        if (!decl) this.fail(`effect ${d.effect} has no operation '${o.name}'`, o.span);
        const r = this.infer(o.fn);
        const before = snapshotSubst();
        try {
          unify(r.ty, instantiate(decl.ty, 0));
        } catch (e) {
          restoreSubst(before);
          if (e instanceof FlowError) {
            this.fail(`provider for ${d.effect}.${o.name} does not match its signature: ${e.message}`, o.span);
          }
          throw e;
        }
        this.resolvePendingFields();
        restoreSubst(before);
      }
    }
  }

  registerProvide(d: Decl & { k: "Provide" }) {
    const effect = this.mod.effects.get(d.effect);
    if (!effect) this.fail(`provide for unknown effect '${d.effect}'`, d.span);
    const ops = new Map<string, Expr>();
    let place: Place = "neutral";
    for (const o of d.ops) {
      // The provider runs where its implementation runs: look through the
      // operation's lambda (which is itself place-neutral, as all functions are)
      // at the body that actually performs the work.
      const body = o.fn.k === "Lam" ? o.fn.body : o.fn;
      const r = this.mod.info.get(body) ?? this.mod.info.get(o.fn);
      place = joinPlace(place, r ? r.place : "neutral");
      ops.set(o.name, o.fn);
    }
    this.mod.provides.set(d.effect, { effect: d.effect, ops, target: d.target, place });
  }

  /** No signature: the parameter and result types are inferred from the body. */
  isInferredFn(d: Decl & { k: "Fn" }): boolean {
    return d.ret === undefined && !d.eff;
  }

  declareInferred(d: Decl & { k: "Fn" }) {
    const paramTypes = d.params.map((p) => this.resolveType(p.type, new Map()));
    const ty = fnT(paramTypes, fresh(0), emptyEff());
    this.mod.fns.set(d.name, {
      name: d.name, scheme: ty, params: d.params, ret: undefined, eff: undefined, body: d.body, pub: d.pub, span: d.span,
      paramPlaces: d.params.map((p) => annotatedPlace(p.type)),
      retPlace: undefined,
      dicts: [],
      typeParams: new Map(),
    });
  }

  /** Dependency-ordered groups of function declarations (strongly connected components). */
  private fnGroups(prog: Program): (Decl & { k: "Fn" })[][] {
    const fns = prog.decls.filter((d): d is Decl & { k: "Fn" } => d.k === "Fn");
    const byName = new Map(fns.map((d) => [d.name, d]));
    const edges = new Map<string, string[]>();
    const collectHtml = (n: HtmlNode, add: (name: string) => void) => {
      if (n.k === "Component") add(n.name);
      if (n.k === "Element" || n.k === "Component") n.children.forEach((c) => collectHtml(c, add));
    };
    for (const d of fns) {
      const refs = new Set<string>();
      const add = (name: string) => {
        const t = byName.get(name);
        if (t && this.isInferredFn(t)) refs.add(name);
      };
      forEachExpr(d.body, (x) => {
        if (x.k === "Var") add(x.name);
        if (x.k === "Html") x.nodes.forEach((n) => collectHtml(n, add));
      });
      edges.set(d.name, [...refs]);
    }
    // Tarjan: components come out callees-first
    const index = new Map<string, number>(), low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const out: (Decl & { k: "Fn" })[][] = [];
    let counter = 0;
    const visit = (v: string) => {
      index.set(v, counter); low.set(v, counter); counter++;
      stack.push(v); onStack.add(v);
      for (const w of edges.get(v) ?? []) {
        if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
        else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
      if (low.get(v) === index.get(v)) {
        const comp: (Decl & { k: "Fn" })[] = [];
        for (;;) {
          const w = stack.pop()!;
          onStack.delete(w);
          comp.push(byName.get(w)!);
          if (w === v) break;
        }
        out.push(comp.reverse());
      }
    };
    for (const d of fns) if (!index.has(d.name)) visit(d.name);
    return out;
  }

  /** The placement written on a whole signature (`Str -> () @client`). */
  private signaturePlace(sig: FnSig): Place | undefined {
    const t = sig.ret;
    return t && t.k === "TPlaced" ? t.place : undefined;
  }

  declareFn(d: Decl & { k: "Fn" }) {
    const params = new Map<string, Type>();
    const dicts: DictParam[] = [];
    for (const tp of d.typeParams ?? []) {
      const v = fresh(0);
      v.generic = true;
      const bs = this.expandBounds(boundsOf(d.paramBounds, tp));
      if (bs.length) {
        v.bounds = [...bs];
        for (const b of bs) dicts.push({ trait: b, typeParam: tp, name: dictParamName(b, tp), varId: v.id });
      }
      params.set(tp, v);
    }
    const paramTypes = d.params.map((p) => this.resolveType(p.type, params));
    const ret = d.ret ? this.resolveType(d.ret, params) : fresh(0);
    const eff: Eff = d.eff ? { labels: new Set(d.eff.effects) } : emptyEff();
    const ty = fnT(paramTypes, ret, eff);
    markGeneric(ty);
    this.mod.fns.set(d.name, {
      name: d.name, scheme: ty, params: d.params, ret: d.ret, eff: d.eff, body: d.body, pub: d.pub, span: d.span,
      paramPlaces: d.params.map((p) => annotatedPlace(p.type)),
      retPlace: annotatedPlace(d.ret),
      dicts,
      typeParams: params,
    });
  }

  checkFnBody(d: Decl & { k: "Fn" }) {
    this.checkNamedBody(d.name, d.params, d.body, d.ret, d.eff);
  }

  /** `unsafe extern js fn f(..) -> T = "Math.floor"` — a raw JavaScript call.
   *  Placement is neutral: the same target exists on whichever side runs it. */
  declareExtern(d: Decl & { k: "Extern" }) {
    const params = new Map<string, Type>();
    for (const tp of d.sig.typeParams ?? []) {
      const v = fresh(0);
      v.generic = true;
      params.set(tp, v);
    }
    const ty = this.resolveSig(d.sig, params);
    markGeneric(ty);
    // `f :: Str -> () @client`: the primitive only exists on one side
    const place = d.sig.ret && d.sig.ret.k === "TPlaced" ? d.sig.ret.place : undefined;
    this.mod.fns.set(d.sig.name, {
      name: d.sig.name,
      scheme: ty,
      place,
      params: d.sig.params,
      ret: d.sig.ret,
      eff: d.sig.eff,
      pub: d.pub,
      paramPlaces: d.sig.params.map((p) => annotatedPlace(p.type)),
      retPlace: annotatedPlace(d.sig.ret),
      extern: { target: d.target, implName: d.implName, modulePath: (d as { modulePath?: string }).modulePath, exportName: (d as { exportName?: string }).exportName },
      span: d.span,
    });
  }

  /** A top-level placement annotation constrains the inferred placement.
   *  Neutral and cross expressions are not rejected: they either can run on
   *  either side or contain a cut, which is checked separately by codegen. */
  private checkPlacement(
    expected: AnnPlace | undefined,
    actual: string,
    span: { line?: number; col?: number; file?: string },
    what: string,
  ) {
    if (!expected || actual === "neutral" || actual === "cross" || actual === expected) return;
    this.fail(`placement mismatch: ${what} is annotated @${expected}, but is placed ${actual}`, span);
  }

  /** Resolve a dictionary for a type variable and trait by id or instantiation origin. */
  private dictForVar(v: Type, trait: string): string | undefined {
    const p = prune(v);
    if (p.k !== "var") return undefined;
    const direct = this.currentDicts.get(dictKey(trait, p.id));
    if (direct) return direct;
    return p.origin !== undefined ? this.currentDicts.get(dictKey(trait, p.origin)) : undefined;
  }

  /** The place of a call argument, resolving locals from the environment so an
   *  annotated parameter sees the value the binding actually carries. */
  private exprPlace(e: Expr, fallback: string): string {
    if (e.k === "Var") {
      const env = this.env.get(e.name);
      if (env) return env.place;
    }
    return fallback;
  }

  private checkNamedBody(name: string, params: Param[], body: Expr, ret?: TypeExpr, declaredEff?: EffRow) {
    const info = this.mod.fns.get(name);
    if (!info) return; // a declaration error was already reported
    // Constraints left over from a body that failed to infer must not leak.
    this.pendingFields = [];
    // Do not report cascades caused by a declaration that already failed.
    let poisoned = false;
    forEachExpr(body, (x) => {
      if (x.k === "Var" && this.failedNames.has(x.name)) poisoned = true;
    });
    if (poisoned) return;
    const t = info.scheme;
    if (t.k !== "fun") return;

    const saved = this.env;
    const savedDicts = this.currentDicts;
    const savedTypeParams = this.typeParams;
    this.env = new Map(saved);
    this.currentDicts = new Map((info.dicts ?? []).map((d) => [dictKey(d.trait, d.varId), d.name]));
    this.typeParams = info.typeParams ?? new Map();
    const savedPending = this.pendingTraitCalls;
    this.pendingTraitCalls = [];
    for (let i = 0; i < params.length; i++) {
      const p = params[i]!;
      const pt = t.params[i]!;
      this.env.set(p.name, { ty: pt, envVars: new Set(), place: typePlace(pt) });
    }
    let r: ResInfo;
    try {
      r = this.infer(body);
    } catch (e) {
      this.env = saved;
      this.currentDicts = savedDicts;
      this.typeParams = savedTypeParams;
      this.pendingTraitCalls = savedPending;
      if (e instanceof FlowError) {
        this.fail(
          `${e.message}\n  in fn ${name}`,
          e.line != null ? { line: e.line, col: e.col ?? 1, file: e.file } : undefined,
        );
      }
      throw e;
    }
    this.checkPlacement(info.retPlace, r.place, body.span, `fn ${name}`);

    // The return type is checked against the *tail* expression, not the whole
    // function body: a wrong literal should be underlined where it is written.
    const before = snapshotSubst();
    try {
      unify(r.ty, t.ret);
    } catch (e) {
      restoreSubst(before);
      this.env = saved;
      this.currentDicts = savedDicts;
      this.typeParams = savedTypeParams;
      this.pendingTraitCalls = savedPending;
      if (e instanceof FlowError) {
        const [wantText, gotText] = typeStrs([t.ret, r.ty]);
        this.fail(
          `return type mismatch in fn ${name}: expected ${wantText}, got ${gotText}`,
          tailSpan(body),
        );
      }
      throw e;
    }

    try {
      this.resolvePendingTraitCalls();
    } catch (e) {
      this.env = saved;
      this.currentDicts = savedDicts;
      this.typeParams = savedTypeParams;
      this.pendingTraitCalls = savedPending;
      if (e instanceof FlowError) {
        this.fail(
          `${e.message}\n  in fn ${name}`,
          e.line != null ? { line: e.line, col: e.col ?? 1, file: e.file } : undefined,
        );
      }
      throw e;
    }
    try {
      this.resolvePendingFields();
    } catch (e) {
      this.env = saved;
      this.currentDicts = savedDicts;
      this.typeParams = savedTypeParams;
      this.pendingTraitCalls = savedPending;
      this.pendingFields = [];
      if (e instanceof FlowError) {
        this.fail(
          `${e.message}\n  in fn ${name}`,
          e.line != null ? { line: e.line, col: e.col ?? 1, file: e.file } : undefined,
        );
      }
      throw e;
    }
    this.currentDicts = savedDicts;
    this.pendingTraitCalls = savedPending;

    try {
      if (declaredEff) {
        const declared = new Set(declaredEff.effects);
        const extra = [...r.eff.labels].filter((l) => !declared.has(l));
        if (extra.length) {
          this.fail(
            `unhandled effect(s) {${extra.sort().join(", ")}} in fn ${name}: ` +
            `declared ! {${[...declared].sort().join(", ")}}`,
            body.span,
          );
        }
      } else {
        for (const l of r.eff.labels) t.eff.labels.add(l);
      }
    } catch (e) {
      this.env = saved;
      this.currentDicts = savedDicts;
      this.typeParams = savedTypeParams;
      this.pendingTraitCalls = savedPending;
      throw e;
    }
    this.env = saved;
    this.typeParams = savedTypeParams;
    this.mod.info.set(body, r);
    // a function runs where its body runs; callers inherit that placement
    if (r.place !== 'neutral') info.bodyPlace = r.place;
  }

  /* ---------------------------------------------------------------- */
  /* type expressions                                                 */
  /* ---------------------------------------------------------------- */

  resolveSig(s: FnSig, params: Map<string, Type>): Type {
    const local = new Map(params);
    for (const tp of s.typeParams ?? []) {
      const v = fresh(0);
      v.generic = true;
      const bs = this.expandBounds(boundsOf(s.paramBounds, tp));
      if (bs.length) v.bounds = [...bs];
      local.set(tp, v);
    }
    const ps = s.params.map((p) => this.resolveType(p.type, local));
    const ret = s.ret ? this.resolveType(s.ret, local) : fresh(0);
    const eff: Eff = s.eff ? { labels: new Set(s.eff.effects) } : emptyEff();
    return fnT(ps, ret, eff);
  }

  /** A type name that is not declared: suggest a case fix and note value/type confusion. */
  private typeHint(name: string): string {
    const known = [...BUILTIN_TYPES, ...this.mod.typeDefs.keys(), ...this.mod.traits.keys()];
    const lower = name.toLowerCase();
    const near = known.find((k) => k.toLowerCase() === lower) ??
      known.find((k) => editDistance(k.toLowerCase(), lower) <= 2);
    const isValue = this.mod.fns.has(name) || this.mod.ctors.has(name);
    const parts: string[] = [];
    if (isValue) parts.push(`'${name}' is a value, not a type`);
    if (near) parts.push(`did you mean '${near}'?`);
    return parts.length ? ` — ${parts.join("; ")}` : "";
  }

  resolveType(te: TypeExpr, params: Map<string, Type>): Type {
    switch (te.k) {
      case "TVar": {
        if (te.name === "_") return fresh(0);
        if (params.has(te.name)) return params.get(te.name)!;
        // Lowercase names in type position are type variables, but only if they
        // were declared (`fn f<a>(x: a)`). Otherwise `fn f() -> str` would
        // silently quantify a fresh variable instead of reporting a misspelling.
        if (this.typeParams.has(te.name)) return this.typeParams.get(te.name)!;
        this.fail(`unknown type '${te.name}'${this.typeHint(te.name)}`, te.span);
      }
      case "TCon": {
        // A type parameter applied to arguments is a higher-kinded application:
        // `f<a>` where `f` is a trait/function type parameter.
        if (params.has(te.name)) {
          const v = params.get(te.name)!;
          if (te.args.length === 0) return v;
          return { k: "app", fn: v, args: te.args.map((a) => this.resolveType(a, params)) };
        }
        const def = this.mod.typeDefs.get(te.name);
        if (te.name === "List") {
          if (te.args.length > 1) this.fail(`type 'List' expects 1 type argument, got ${te.args.length}`, te.span);
          return te.args.length ? listOf(this.resolveType(te.args[0]!, params)) : con("List");
        }
        if (te.name === "Cell") {
          if (te.args.length > 1) this.fail(`type 'Cell' expects 1 type argument, got ${te.args.length}`, te.span);
          return te.args.length ? cellOf(this.resolveType(te.args[0]!, params)) : con("Cell");
        }
        if (te.name === "Event") {
          if (te.args.length) this.fail(`type 'Event' takes no type arguments`, te.span);
          return con("Event");
        }
        if (def && def.kind === "alias") {
          const d = def.decl as Decl & { k: "Alias" };
          const inner = new Map<string, Type>();
          d.params.forEach((p, i) => inner.set(p, this.resolveType(te.args[i]!, params)));
          return this.resolveType(d.type, inner);
        }
        if (def && def.kind === "record") {
          const d = def.decl as Decl & { k: "RecordType" };
          const inner = new Map(params);
          d.params.forEach((p, i) => inner.set(p, this.resolveType(te.args[i]!, params)));
          const fields: Record<string, Type> = {};
          for (const f of d.fields) fields[f.name] = this.resolveType(f.type, inner);
          return { k: "rec", fields };
        }
        if (def && def.kind === "adt" && te.args.length > def.params.length) {
          this.fail(`${te.name} expects ${def.params.length} type argument(s)`);
        }
        if (!def && !BUILTIN_TYPES.has(te.name)) {
          this.fail(`unknown type '${te.name}'${this.typeHint(te.name)}`, te.span);
        }
        if (te.name === "Int" || te.name === "Float" || te.name === "Str" || te.name === "Bool" ||
            te.name === "Unit" || te.name === "Html" || te.name === "Dom") {
          if (te.args.length) this.fail(`type '${te.name}' takes no type arguments`, te.span);
        }
        return con(te.name, ...te.args.map((a) => this.resolveType(a, params)));
      }
      case "TFun":
        return fnT(
          te.params.map((p) => this.resolveType(p, params)),
          this.resolveType(te.ret, params),
          te.eff && te.eff.effects.length ? { labels: new Set(te.eff.effects) } : emptyEff(),
        );
      case "TRecord": {
        const fields: Record<string, Type> = {};
        const seen = new Set<string>();
        for (const f of te.fields) {
          if (seen.has(f.name)) this.fail(`duplicate field '${f.name}' in record type`, te.span);
          seen.add(f.name);
          fields[f.name] = this.resolveType(f.type, params);
        }
        return { k: "rec", fields };
      }
      case "TTuple":
        return { k: "tuple", items: te.items.map((i) => this.resolveType(i, params)) };
      case "TPlaced":
        return withTypePlace(this.resolveType(te.inner, params), te.place);
    }
  }

  /* ---------------------------------------------------------------- */
  /* inference                                                        */
  /* ---------------------------------------------------------------- */

  infer(e: Expr): ResInfo {
    const r = this.inferRaw(e);
    this.mod.info.set(e, r);
    return r;
  }

  info(e: object): ResInfo {
    const r = this.mod.info.get(e);
    if (!r) this.fail("internal: missing inference info");
    return r;
  }

  private inferRaw(e: Expr): ResInfo {
    this.lastSpan = e.span;
    switch (e.k) {
      case "Lit": {
        const ty =
          e.lit.k === "Int" ? INT : e.lit.k === "Float" ? FLOAT : e.lit.k === "Str" ? STR :
          e.lit.k === "Bool" ? BOOL : UNIT;
        return { ty, place: "neutral", eff: emptyEff() };
      }

      case "Var": {
        if (e.name === "resume" && !this.env.has("resume") && !this.mod.fns.has("resume")) {
          this.fail("'resume' is only available inside an operation handler of an effect", e.span);
        }
        // A trait method with no parameters is a value: `empty`, not `empty ()`.
        const nullaryTrait = !this.env.has(e.name) && !this.mod.fns.has(e.name) ? this.mod.methodIndex.get(e.name) : undefined;
        if (nullaryTrait) {
          const m = this.mod.traits.get(nullaryTrait)?.methods.get(e.name);
          if (m && m.ty.k === "fun" && m.ty.params.length === 0) {
            return this.inferTraitCall(nullaryTrait, e.name, m.ty, [], e);
          }
        }
        const ty = this.lookupVar(e.name, e.span);
        this.mod.varTypes.set(e, ty);
        // a top-level constant (`pi = 3.14`) is a nullary function: referencing it evaluates it
        const fnInfo = !this.env.has(e.name) ? this.mod.fns.get(e.name) : undefined;
        if (fnInfo && !fnInfo.extern && fnInfo.params.length === 0 && ty.k === "fun" && ty.params.length === 0) {
          this.mod.constRefs.add(e);
          return {
            ty: ty.ret,
            place: joinPlace(this.varPlace(e.name), typePlace(ty.ret)),
            eff: { labels: new Set(ty.eff.labels) },
          };
        }
        return { ty, place: this.varPlace(e.name), eff: emptyEff() };
      }

      case "Lam": {
        const saved = this.env;
        this.env = new Map(saved);
        const seenParams = new Set<string>();
        const expFn = this.expectedFor.get(e) ? prune(this.expectedFor.get(e)!) : undefined;
        const paramTypes = e.params.map((p, pi) => {
          if (seenParams.has(p.name)) this.fail(`duplicate parameter '${p.name}'`, p.span);
          seenParams.add(p.name);
          const useExpected = p.type.k === "TVar" && p.type.name === "_" && expFn?.k === "fun" && expFn.params.length === e.params.length;
          const t = useExpected ? expFn.params[pi]! : this.resolveType(p.type, this.typeParams);
          this.env.set(p.name, { ty: t, envVars: new Set(), place: typePlace(t) });
          return t;
        });
        this.checkEffectRow(e.eff, e.span);
        const body = this.infer(e.body);
        this.env = saved;
        const ret = e.ret ? this.resolveType(e.ret, this.typeParams) : body.ty;
        const eff: Eff = { labels: new Set(body.eff.labels) };
        if (e.eff) for (const l of e.eff.effects) eff.labels.add(l);
        // A function is a value, not a region. Its side is where it is invoked,
        // which the consumer decides; the effects of its body live in the fn's
        // effect row and become per-statement cuts at codegen time.
        return { ty: fnT(paramTypes, ret, eff), place: "neutral", eff: { labels: new Set() } };
      }

      case "App": return this.inferApp(e);

      case "If": {
        const c = this.infer(e.cond);
        this.expectType(c.ty, BOOL, e.cond, "if condition");
        const t = this.infer(e.then);
        const f = this.infer(e.else);
        const before = snapshotSubst();
        try { unify(t.ty, f.ty); }
        catch (err) {
          restoreSubst(before);
          if (err instanceof FlowError) {
            const [thenText, elseText] = typeStrs([t.ty, f.ty]);
            this.fail(
              `if branches have different types: then is ${thenText}, else is ${elseText}`,
              tailSpan(e.else),
            );
          }
          throw err;
        }
        return { ty: t.ty, place: joinPlace(joinPlace(c.place, t.place), f.place), eff: mergeEff(c.eff, t.eff, f.eff) };
      }

      case "Match": return this.inferMatch(e);

      case "Let": {
        const annTy = e.ann ? this.resolveType(e.ann, this.typeParams) : undefined;
        const v = this.inferBinding(e.name, e.value, annTy);
        if (annTy) {
          this.checkAnnotation(v.ty, annTy, e.name, e.value.span);
          this.checkPlacement(annotatedPlace(e.ann), v.place, e.ann!.span, `'${e.name}'`);
        }
        const envVars = new Set<number>();
        for (const s of this.env.values()) for (const x of freeVars(s.ty)) envVars.add(x);
        // A value whose type still waits on a field access stays monomorphic,
        // so the use site can bind it to a record ADT.
        const gen = this.canGeneralize(v.ty) ? generalize(v.ty, envVars) : v.ty;
        const saved = this.env;
        this.env = new Map(saved);
        this.env.set(e.name, { ty: gen, envVars, place: v.place });
        const scope = this.infer(e.body);
        this.env = saved;
        return { ty: scope.ty, place: joinPlace(v.place, scope.place), eff: mergeEff(v.eff, scope.eff) };
      }

      case "Record": {
        const fields: Record<string, Type> = {};
        const seenFields = new Set<string>();
        const expectedRec = this.expectedFor.get(e) ? prune(this.expectedFor.get(e)!) : undefined;
        let place: Place = "neutral";
        let eff = emptyEff();
        for (const f of e.fields) {
          if (seenFields.has(f.name)) this.fail(`duplicate field '${f.name}' in record literal`, f.value.span);
          seenFields.add(f.name);
          const expectedField = expectedRec?.k === "rec" ? expectedRec.fields[f.name] : undefined;
          const r = expectedField ? this.inferArg(f.value, expectedField) : this.infer(f.value);
          fields[f.name] = r.ty;
          place = joinPlace(place, r.place);
          eff = mergeEff(eff, r.eff);
        }
        return { ty: { k: "rec", fields }, place, eff };
      }

      case "Field": {
        const qn = this.qualName(e.target);
        if (qn && this.mod.traits.has(qn)) {
          const method = this.mod.traits.get(qn)?.methods.get(e.name);
          // A nullary trait method is a value, even when qualified:
          // `Alternative.empty`.
          if (method && method.ty.k === "fun" && method.ty.params.length === 0) {
            return this.inferTraitCall(qn, e.name, method.ty, [], e);
          }
        }
        if (qn && (this.mod.effects.has(qn) || this.mod.traits.has(qn))) {
          this.fail(`'${qn}.${e.name}' is a qualified name and must be called: ${qn}.${e.name}(...)`, e.span);
        }
        const target = this.infer(e.target);
        const tt = prune(target.ty);
        if (/^\d+$/.test(e.name)) {
          if (tt.k !== "tuple") this.fail(`'.${e.name}' needs a tuple, got ${typeStr(tt)}`, e.span);
          const idx = Number(e.name);
          if (idx >= tt.items.length) this.fail(`tuple has no element ${idx}`, e.span);
          return { ty: tt.items[idx]!, place: target.place, eff: target.eff };
        }
        if (tt.k === "con" && tt.name === "Cell") {
          if (e.name === "value") {
            // `cell.value` is sugar for CellOps.get. Its place is the cell's
            // placement: a `Cell a @server` read happens on the server and
            // becomes a reactive cut on the client.
            const elem = tt.args[0] ?? fresh(0);
            return {
              ty: elem,
              place: joinPlace(target.place, typePlace(tt)),
              eff: emptyEff(),
            };
          }
          this.fail(`Cell has no field '${e.name}' (use .value, .get(), .set(value) or .update(fn))`, e.span);
        }
        if (tt.k === "con" && (tt.name === "Event" || tt.name === "Dom")) {
          const field = domFieldType(tt.name, e.name);
          if (!field) this.fail(`${tt.name} has no field '${e.name}'`, e.span);
          return {
            ty: field,
            place: joinPlace(joinPlace(target.place, typePlace(tt)), typePlace(field)),
            eff: target.eff,
          };
        }
        const t = prune(target.ty);
        let ty: Type;
        if (t.k === "var") {
          // Defer: the value may turn out to be a record ADT, whose payload
          // fields are not represented like anonymous record fields.
          ty = fresh(0);
          this.pendingFields.push({ target: t, name: e.name, ty, span: e.span, node: e });
        } else if (t.k === "rec") {
          let f = t.fields[e.name];
          if (!f && (t.open || t.atLeast)) { f = fresh(0); t.fields[e.name] = f; }
          if (!f) this.fail(`record has no field '${e.name}'`, e.span);
          ty = f;
        } else if (t.k === "con") {
          const payload = this.recordPayload(t);
          if (!payload) this.fail(`cannot project '.${e.name}' from ${typeStr(t)}`, e.span);
          const f = payload.fields[e.name];
          if (!f) this.fail(`${typeStr(t)} has no field '${e.name}'`, e.span);
          ty = f;
          this.mod.adtProjections.add(e);
        } else {
          this.fail(`cannot project '.${e.name}' from ${typeStr(t)}`, e.span);
        }
        return { ty, place: joinPlace(target.place, typePlace(ty)), eff: target.eff };
      }

      case "Tuple": {
        let place: Place = "neutral";
        let eff = emptyEff();
        const items = e.items.map((i) => { const r = this.infer(i); place = joinPlace(place, r.place); eff = mergeEff(eff, r.eff); return r.ty; });
        return { ty: { k: "tuple", items }, place, eff };
      }

      case "List": {
        const el = fresh(0);
        let place: Place = "neutral";
        let eff = emptyEff();
        for (const i of e.items) {
          const r = this.infer(i);
          this.unifyArg(r.ty, el, i.span, "list elements must share a type");
          place = joinPlace(place, r.place);
          eff = mergeEff(eff, r.eff);
        }
        return { ty: listOf(el), place, eff };
      }

      case "Ctor": {
        const c = this.mod.ctors.get(e.name);
        const base = this.lookupVar(e.name, e.span);
        let place: Place = "neutral";
        let eff = emptyEff();
        if (c && c.arity > 0 && e.args.length < c.arity) {
          // `Some` / `Node left` used as a function: eta-expand into a lambda
          const names = Array.from({ length: c.arity - e.args.length }, () => `_k${this.uidCtor++}`);
          const params = names.map((n) => ({ name: n, type: { k: "TVar" as const, name: "_", span: e.span }, span: e.span }));
          const body: Expr = { k: "Ctor", name: e.name, args: [...e.args, ...names.map((n): Expr => ({ k: "Var", name: n, span: e.span }))], span: e.span };
          const span = e.span;
          for (const key of Object.keys(e)) delete (e as unknown as Record<string, unknown>)[key];
          Object.assign(e, { k: "Lam", params, body, span });
          return this.inferRaw(e);
        }
        if (c && c.arity > 0) {
          if (e.args.length !== c.arity) this.fail(`constructor ${e.name} expects ${c.arity} argument(s)`, e.span);
          const inst = instantiate(c.scheme, 0);
          if (inst.k === "fun") {
            e.args.forEach((a, i) => {
              const r = this.inferArg(a, inst.params[i]!);
              this.unifyArg(r.ty, inst.params[i]!, a.span, `constructor ${e.name} argument ${i + 1}`);
              place = joinPlace(place, r.place);
              eff = mergeEff(eff, r.eff);
            });
            return { ty: inst.ret, place: joinPlace(place, typePlace(inst.ret)), eff };
          }
        }
        if (e.args.length) this.fail(`constructor ${e.name} takes no arguments`, e.span);
        return { ty: base, place: typePlace(base), eff };
      }

      case "Binary": return this.inferBinary(e);

      case "Unary": {
        const r = this.infer(e.e);
        if (e.op === "not" || e.op === "!") { this.expectType(r.ty, BOOL, e.e, "operand of not"); return { ty: BOOL, place: r.place, eff: r.eff }; }
        const t = prune(r.ty);
        if (t.k === "con" && t.name === "Float") return { ty: FLOAT, place: r.place, eff: r.eff };
        this.expectType(r.ty, INT, e.e, "operand of unary '-'");
        return { ty: INT, place: r.place, eff: r.eff };
      }

      case "Html": {
        let place: Place = "client";
        let eff = emptyEff();
        for (const n of e.nodes) {
          const r = this.inferHtmlNode(n);
          place = joinPlace(place, r.place);
          eff = mergeEff(eff, r.eff);
        }
        return { ty: HTML, place, eff };
      }

      case "Handle": return this.inferHandle(e);

      case "Assign": return this.inferAssign(e);

      case "Block": {
        const saved = this.env;
        this.env = new Map(saved);
        let place: Place = "neutral";
        let eff = emptyEff();
        for (const s of e.stmts) {
          if (s.k === "LetStmt") {
            const annTy = s.ann ? this.resolveType(s.ann, this.typeParams) : undefined;
            const v = this.inferBinding(s.name, s.value, annTy);
            if (annTy) {
              this.checkAnnotation(v.ty, annTy, s.name, s.value.span);
              this.checkPlacement(annotatedPlace(s.ann), v.place, s.ann!.span, `'${s.name}'`);
            }
            // local functions are polymorphic; other values stay monomorphic (value restriction)
            let ty = v.ty;
            if (s.value.k === "Lam" && this.canGeneralize(v.ty)) {
              const envVars = new Set<number>();
              for (const x of this.env.values()) for (const y of freeVars(x.ty)) envVars.add(y);
              ty = generalize(v.ty, envVars);
            }
            this.env.set(s.name, { ty, envVars: new Set(), place: v.place });
            place = joinPlace(place, v.place);
            eff = mergeEff(eff, v.eff);
          } else {
            const r = this.infer(s.e);
            this.mod.info.set(s, r);
            place = joinPlace(place, r.place);
            eff = mergeEff(eff, r.eff);
          }
        }
        let ty: Type = UNIT;
        if (e.value) {
          const r = this.infer(e.value);
          ty = r.ty;
          place = joinPlace(place, r.place);
          eff = mergeEff(eff, r.eff);
        }
        this.env = saved;
        return { ty, place, eff };
      }
    }
  }

  /**
   * The value of a `let`. A lambda may refer to its own name, so local helper
   * functions (`go acc xs = … go …`) recurse; everything else is inferred as is.
   */
  private inferBinding(name: string, value: Expr, expected?: Type): ResInfo {
    // A binding of an explicitly placed value lives on that side even when the
    // producing expression is neutral: `let c = Server.state 0` binds a server
    // cell, and every later read/write is a server computation.
    const placed = (v: ResInfo): ResInfo => ({
      ...v,
      place: joinPlace(v.place, typePlace(v.ty)),
    });
    if (value.k !== "Lam") {
      return placed(expected ? this.inferArg(value, expected) : this.infer(value));
    }
    const self = fresh(0);
    const saved = this.env;
    this.env = new Map(saved);
    this.env.set(name, { ty: self, envVars: new Set(), place: "neutral" });
    let v: ResInfo;
    try { v = expected ? this.inferArg(value, expected) : this.infer(value); }
    finally { this.env = saved; }
    try { unify(self, v.ty); }
    catch (err) {
      if (err instanceof FlowError) this.fail(`recursive use of '${name}' does not fit its definition: ${err.message}`, value.span);
      throw err;
    }
    return placed(v);
  }

  qualName(e: Expr): string | null {
    if (e.k === "Var") return e.name;
    if (e.k === "Ctor" && e.args.length === 0) return e.name;
    return null;
  }

  inferHandle(e: Expr & { k: "Handle" }): ResInfo {
    const effect = this.mod.effects.get(e.effect);
    if (!effect) this.fail(`handler for unknown effect '${e.effect}'`, e.span);
    return this.inferAlgebraicHandle(e, effect);
  }

  /**
   * Algebraic handlers. The handled body is inferred first so that every
   * operation handler can be typed against the body's result type: `resume(v)`
   * returns the rest of the handled computation, so an operation handler
   * returns the same type as the `handle` expression itself. A handler that
   * never calls `resume` aborts and its return value becomes that result.
   */
  private inferAlgebraicHandle(e: Expr & { k: "Handle" }, effect: EffectInfo): ResInfo {
    const seen = new Set<string>();
    for (const op of e.ops) {
      if (seen.has(op.name)) this.fail(`duplicate handler operation '${op.name}'`, op.span);
      seen.add(op.name);
      if (!effect.ops.has(op.name)) this.fail(`effect ${e.effect} has no operation '${op.name}'`, op.span);
      const binder = findBinderNamed(op.fn, "resume");
      if (binder) this.fail("'resume' is reserved inside a handler operation", binder);
      if (op.fn.k !== "Lam") {
        this.fail(
          `the handler for ${e.effect}.${op.name} must be a function definition: ${op.name} x = …`,
          op.span,
        );
      }
    }
    const missing = [...effect.ops.keys()].filter((name) => !seen.has(name));
    if (missing.length) {
      this.fail(`handler for ${e.effect} is missing operation(s) ${missing.sort().join(", ")}`, e.span);
    }

    const body = this.infer(e.body);

    let opPlace: Place = "neutral";
    let opEff = emptyEff();
    for (const op of e.ops) {
      const declared = effect.ops.get(op.name)!;
      const inst = instantiate(declared.ty, 0);
      if (inst.k !== "fun") this.fail(`effect operation ${e.effect}.${op.name} is not callable`, op.span);
      // `resume` takes the operation's result and returns the handled result.
      const resumeTy = fnT([inst.ret], body.ty);

      const saved = this.env;
      this.env = new Map(saved);
      this.env.set("resume", { ty: resumeTy, envVars: new Set(), place: "neutral" });
      let r: ResInfo;
      try {
        r = this.infer(op.fn);
      } finally {
        this.env = saved;
      }
      this.markResumeVars(op.fn);

      // `resume` is a continuation, not a first-class value in 0.1: calling it
      // anywhere but directly would return a suspended iterator.
      const called = new Set<object>();
      forEachExpr(op.fn, (x) => {
        if (x.k === "App" && x.fn.k === "Var" && x.fn.name === "resume") called.add(x.fn);
      });
      forEachExpr(op.fn, (x) => {
        if (x.k === "Var" && x.name === "resume" && !called.has(x)) {
          this.fail("'resume' must be called directly: resume(value)", x.span);
        }
      });

      const before = snapshotSubst();
      try {
        unify(r.ty, fnT(inst.params, body.ty));
      } catch (err) {
        restoreSubst(before);
        if (err instanceof FlowError) {
          this.fail(
            `handler for ${e.effect}.${op.name} must return the handled result ${typeStr(body.ty)} ` +
            `(a handler that resumes returns what the rest of the body returns): ${err.message}`,
            op.span,
          );
        }
        throw err;
      }
      restoreSubst(before);

      opPlace = joinPlace(opPlace, r.place);
      opEff = mergeEff(opEff, r.eff);
    }

    const labels = new Set(body.eff.labels);
    labels.delete(e.effect);
    return {
      ty: body.ty,
      place: joinPlace(opPlace, body.place),
      eff: mergeEff({ labels }, opEff),
    };
  }

  private markResumeVars(e: Expr): void {
    forEachExpr(e, (x) => {
      if (x.k === "Var" && x.name === "resume") this.mod.resumeVars.add(x);
    });
  }

  /** `cell.value = e`, `cell += e`, `cell++` — sugar over CellOps get/set. */
  private inferAssign(e: Expr & { k: "Assign" }): ResInfo {
    const target = e.target;
    const isValue = target.k === "Field" && target.name === "value";
    const cellExpr = isValue ? (target as Expr & { k: "Field" }).target : target;
    const cell = this.infer(cellExpr);
    const ct = prune(cell.ty);
    if (!(ct.k === "con" && ct.name === "Cell")) {
      this.fail(
        isValue
          ? `assignment target must be a Cell, but this is ${typeStr(ct)}`
          : `assignment target must be a Cell, but this is ${typeStr(ct)} (write cells with \`cell.value = …\`)`,
        target.span,
      );
    }
    const elem = ct.args[0]!;
    const cellPlace = typePlace(ct);
    // Record the read type so codegen can pick Int division for `/=` and `++`.
    this.mod.info.set(target, {
      ty: isValue ? elem : ct,
      place: joinPlace(cell.place, cellPlace),
      eff: emptyEff(),
    });

    let value: ResInfo | null = null;
    if (e.op === "++" || e.op === "--") {
      this.unifyArg(elem, INT, e.span, `cell ${e.op} expects an Int cell`);
    } else {
      value = this.infer(e.value!);
      if (e.op === "=") {
        // `state := pure x` is a common mistake: `:=` writes the element,
        // while `pure` adds a functor layer (`pure x :: f x`).
        const pureCall =
          e.value!.k === "App" &&
          e.value!.fn.k === "Var" &&
          /(^|\.)pure$/.test(e.value!.fn.name);
        const cellName = cellExpr.k === "Var" ? cellExpr.name : "the cell";
        this.unifyArg(
          value.ty,
          elem,
          e.value!.span,
          "cell value",
          pureCall
            ? "':=' writes the cell's element directly. 'pure x' has type 'f x' and adds a " +
              "functor layer; drop it unless the element is itself a cell " +
              `('${cellName} := x').`
            : undefined,
        );
      } else this.checkCompound(elem, value.ty, e.op, e.value!.span);
    }

    return {
      ty: UNIT,
      place: joinPlace(value?.place ?? "neutral", cellPlace),
      eff: value?.eff ?? emptyEff(),
    };
  }

  private checkCompound(elem: Type, value: Type, op: string, span: { line: number; col: number; file?: string }) {
    const t = prune(elem);
    const name = t.k === "con" ? t.name : "";
    if (op === "+=" && (name === "Str" || name === "Float")) {
      this.unifyArg(value, name === "Str" ? STR : FLOAT, span, `cell ${op} on ${name}`);
      return;
    }
    if (name === "Float") {
      this.unifyArg(value, FLOAT, span, `cell ${op} on Float`);
      return;
    }
    if (t.k === "var") this.unifyArg(t, INT, span, `cell ${op} expects an Int cell`);
    if (name === "Int" || t.k === "var") {
      this.unifyArg(value, INT, span, `cell ${op} expects Int`);
      return;
    }
    this.fail(`cell ${op} needs an Int or Float cell, got ${typeStr(elem)}`, span);
  }

  /** Resolve field accesses that were waiting for their value's type. */
  private resolvePendingFields() {
    if (!this.pendingFields.length) return;
    let pending = this.pendingFields;
    this.pendingFields = [];
    // Projecting one field can bind another pending value, so iterate.
    for (let pass = 0; pass < 8; pass++) {
      const rest: typeof pending = [];
      let bound = false;
      for (const p of pending) {
        const t = prune(p.target);
        if (t.k === "var") { rest.push(p); continue; }
        bound = true;
        if (t.k === "rec") {
          let f = t.fields[p.name];
          if (!f && (t.open || t.atLeast)) { f = fresh(0); t.fields[p.name] = f; }
          if (!f) this.fail(`record has no field '${p.name}'`, p.span);
          unify(p.ty, f);
        } else if (t.k === "con") {
          const domField = domFieldType(t.name, p.name);
          if (domField) {
            unify(p.ty, domField);
          } else {
            const payload = this.recordPayload(t);
            if (!payload) this.fail(`cannot project '.${p.name}' from ${typeStr(t)}`, p.span);
            const f = payload.fields[p.name];
            if (!f) this.fail(`${typeStr(t)} has no field '${p.name}'`, p.span);
            unify(p.ty, f);
            this.mod.adtProjections.add(p.node);
          }
        } else {
          this.fail(`cannot project '.${p.name}' from ${typeStr(t)}`, p.span);
        }
      }
      pending = rest;
      if (!bound) break;
    }
    // Nothing constrained the value: it is an anonymous record requirement.
    for (const p of pending) {
      unify(p.target, { k: "rec", fields: { [p.name]: p.ty }, atLeast: true });
    }
  }

  /**
   * The record payload of a single-constructor ADT, resolved with the type
   * arguments at this occurrence: `data Todo = Todo { id :: Int }` makes
   * `Todo` project like `{ id :: Int }`. Null for any other type.
   */
  private recordPayload(t: Type): (Type & { k: "rec" }) | null {
    if (t.k !== "con") return null;
    const def = this.mod.typeDefs.get(t.name);
    if (!def || def.kind !== "adt") return null;
    const decl = def.decl;
    if (decl.k !== "Adt" || decl.variants.length !== 1) return null;
    const variant = decl.variants[0]!;
    if (variant.args.length !== 1 || variant.args[0]!.k !== "TRecord") return null;
    const params = new Map<string, Type>();
    decl.params.forEach((name, i) => params.set(name, t.args[i] ?? fresh(0)));
    const fields: Record<string, Type> = {};
    for (const f of variant.args[0]!.fields) fields[f.name] = this.resolveType(f.type, params);
    return { k: "rec", fields };
  }

  /**
   * Unify each supplied argument with one parameter slot. Slots are normally
   * `0, 1, 2, ...`; a right section fills the trailing slots instead.
   */
  private inferCallArgs(
    e: Expr & { k: "App" },
    ft: Type & { k: "fun" },
    callee: FnInfo | undefined,
    slots: number[],
    seed: Place,
  ): { place: Place; argEff: Eff; funArgEff: Eff } {
    let place = seed;
    let argEff = emptyEff();
    // Effects carried by function arguments are deferred to the consumer: a
    // full call performs them, a partial application puts them in its result
    // type.
    let funArgEff = emptyEff();
    // Infer values before callbacks: `map f xs` needs the element type from
    // `xs` before checking `f`'s parameter.
    const order = e.args.map((_, i) => i)
      .sort((a, b) => Number(e.args[a]!.k === "Lam") - Number(e.args[b]!.k === "Lam"));
    for (const i of order) {
      const a = e.args[i]!;
      const slot = slots[i]!;
      const want = ft.params[slot]!;
      const r = this.inferArg(a, want);
      try { unify(r.ty, want); }
      catch (err) {
        if (err instanceof FlowError) this.fail(`${err.message}\n  in argument ${i + 1}`, a.span);
        throw err;
      }
      // A callback's effects are not performed here: a full call forwards them
      // to the consumer, while a partial application stores them in the result
      // function type. The callee invokes the callback in a generator-aware
      // way, so effectful callbacks are ordinary values.
      const argFun = prune(r.ty);
      if (argFun.k === "fun") {
        const declared = callee?.scheme.k === "fun" ? callee.scheme.params[slot] : undefined;
        funArgEff = mergeEff(funArgEff, this.unadmittedEffects(argFun.eff, declared));
      }
      const expected = callee?.paramPlaces?.[slot];
      if (expected) {
        this.checkPlacement(expected, this.exprPlace(a, r.place), a.span, `argument ${i + 1} to ${callee!.name}`);
      }
      place = joinPlace(place, r.place);
      argEff = mergeEff(argEff, r.eff);
    }
    return { place, argEff, funArgEff };
  }

  inferApp(e: Expr & { k: "App" }): ResInfo {
    // Method-call syntax: `receiver.method(args)` dispatches to a trait method
    // when the receiver is not a record with a field of that name. Cell.get /
    // Cell.set are just `CellOps` methods under this rule - no compiler special
    // case and no hardcoded method names.
    {
      const qn0 = e.fn.k === "Field" ? this.qualName(e.fn.target) : null;
      const qualified0 = qn0 && (this.mod.effects.has(qn0) || this.mod.traits.has(qn0));
      if (e.fn.k === "Field" && !qualified0) {
        const target = this.infer(e.fn.target);
        const tt = prune(target.ty);
        const recordField = tt.k === "rec" && Object.prototype.hasOwnProperty.call(tt.fields, e.fn.name);
        if (!recordField) {
          const tname = this.mod.methodIndex.get(e.fn.name);
          if (tname) {
            const tr = this.mod.traits.get(tname)!;
            const m = tr.methods.get(e.fn.name)!;
            // `cell.get ()`: a method that takes only the receiver ignores the unit argument
            if (e.args.length === 1 && e.args[0]!.k === "Lit" && e.args[0]!.lit.k === "Unit" && m.ty.k === "fun" && m.ty.params.length === 1) {
              e.args = [];
            }
            const di = this.dispatchIndex(tr, m.ty);
            if (m.ty.k === "fun" && di >= 0 && e.args.length + 1 === m.ty.params.length) {
              const callArgs: Expr[] = [];
              let ai = 0;
              for (let i = 0; i < m.ty.params.length; i++) {
                callArgs.push(i === di ? e.fn.target : e.args[ai++]!);
              }
              return this.inferTraitCall(tname, e.fn.name, m.ty, callArgs, e);
            }
            return this.inferTraitCall(tname, e.fn.name, m.ty, [e.fn.target, ...e.args], e);
          }
        }
      }
    }

    const qn = e.fn.k === "Field" ? this.qualName(e.fn.target) : null;
    const isQualified = e.fn.k === "Field" && qn && (this.mod.effects.has(qn) || this.mod.traits.has(qn));
    if (e.fn.k === "Field" && isQualified) {
      const qual = qn!;
      const op = e.fn.name;

      const eff = this.mod.effects.get(qual);
      if (eff) {
        const opInfo = eff.ops.get(op);
        if (!opInfo) this.fail(`effect ${qual} has no operation '${op}'`, e.fn.span);
        const inst = instantiate(opInfo.ty, 0);
        if (inst.k !== "fun") this.fail(`effect operation ${qual}.${op} is not callable`, e.fn.span);
        if (e.args.length !== inst.params.length) this.fail(`${qual}.${op} expects ${inst.params.length} argument(s)`, e.span);
        let place: Place = eff.place;
        let argEff = emptyEff();
        e.args.forEach((a, i) => {
          const r = this.inferArg(a, inst.params[i]!);
          this.unifyArg(r.ty, inst.params[i]!, a.span, `${qual}.${op} argument ${i + 1}`);
          place = joinPlace(place, r.place);
          argEff = mergeEff(argEff, r.eff);
        });
        const callEff: Eff = { labels: new Set([...inst.eff.labels, qual, ...argEff.labels]) };
        // record the callee so placement of the call can see where the op lives
        this.mod.info.set(e.fn, { ty: inst, place: eff.place, eff: callEff });
        return { ty: inst.ret, place, eff: callEff };
      }

      const tr = this.mod.traits.get(qual);
      if (tr) {
        const m = tr.methods.get(op);
        if (!m) this.fail(`trait ${qual} has no method '${op}'`, e.fn.span);
        return this.inferTraitCall(qual, op, m.ty, e.args, e);
      }

      this.fail(`'${qual}.${op}' is not an effect operation or trait method`, e.fn.span);
      this.fail(`'${qual}.${op}' is not an effect operation, trait method, or record field`, e.fn.span);
    }

    if (e.fn.k === "Var") {
      const nm = e.fn.name;
      const tname = this.mod.methodIndex.get(nm);
      if (tname && !this.env.has(nm) && !this.mod.fns.has(nm)) {
        const tr = this.mod.traits.get(tname)!;
        const m = tr.methods.get(nm)!;
        return this.inferTraitCall(tname, nm, m.ty, e.args, e);
      }
    }

    const callee = e.fn.k === "Var" && !this.env.has(e.fn.name) ? this.mod.fns.get(e.fn.name) : undefined;
    let calleeTrace: Map<number, Type> | undefined;
    let fnInfo: ResInfo;
    if (callee?.dicts?.length) {
      calleeTrace = new Map();
      const ty = instantiate(callee.scheme, 0, calleeTrace);
      fnInfo = { ty, place: this.varPlace(e.fn.name), eff: emptyEff() };
      this.mod.info.set(e.fn, fnInfo);
    } else {
      fnInfo = this.infer(e.fn);
    }
    let ft = prune(fnInfo.ty);
    if (ft.k === "var") {
      // calling a function whose type is not known yet (a parameter): it must be
      // a function of this many arguments
      const shape = fnT(e.args.map(() => fresh(0)), fresh(0));
      unify(ft, shape);
      ft = prune(fnInfo.ty);
    }
    if (ft.k !== "fun") this.fail(`attempt to call a value of type ${typeStr(ft)}`, e.fn.span);
    if (e.args.length > ft.params.length) {
      // `f a b c` where `f a b` returns a function: apply in two steps
      const n = ft.params.length;
      if (n === 0) this.fail(`expected no arguments, got ${e.args.length}`, e.span);
      const inner: Expr = { k: "App", fn: e.fn, args: e.args.slice(0, n), span: e.span };
      e.fn = inner;
      e.args = e.args.slice(n);
      return this.inferApp(e);
    }
    const partial = e.args.length < ft.params.length;
    if (partial) {
      if (callee?.dicts?.length) {
        this.fail(`cannot partially apply '${callee.name}': it needs trait dictionaries; call it with all arguments`, e.span);
      }
      if (e.fn.k === "Var" && !this.env.has(e.fn.name) && this.findEffectOp(e.fn.name)) {
        this.fail(`cannot partially apply effect operation '${e.fn.name}'`, e.span);
      }
    }

    const seed = joinPlace(fnInfo.place, typePlace(ft));
    let slots = e.args.map((_, i) => i);
    let right = false;
    let inferred: { place: Place; argEff: Eff; funArgEff: Eff };
    const beforeArgs = snapshotSubst();
    try {
      inferred = this.inferCallArgs(e, ft, callee, slots, seed);
    } catch (err) {
      // The argument does not fit the next parameter. It may be a right section
      // (`Option.map f` supplies the mapper; the option is still missing), so
      // retry with the arguments in the trailing slots. If that also fails,
      // keep the original error: it describes the call the user wrote.
      if (!partial || e.args.length === 0 || !(err instanceof FlowError)) throw err;
      restoreSubst(beforeArgs);
      // The failed attempt may have marked nested calls (partials, algebraic
      // generators); re-inference below decides those again.
      for (const a of e.args) {
        forEachExpr(a, (x) => {
          this.mod.partialCalls.delete(x);
          this.mod.rightPartials.delete(x);
          this.mod.genCalls.delete(x);
        });
      }
      slots = e.args.map((_, i) => ft.params.length - e.args.length + i);
      right = true;
      try {
        inferred = this.inferCallArgs(e, ft, callee, slots, seed);
      } catch {
        restoreSubst(beforeArgs);
        throw err;
      }
    }
    const { place, argEff, funArgEff } = inferred;

    if (partial) {
      this.mod.partialCalls.add(e);
      if (right) this.mod.rightPartials.set(e, ft.params.length - e.args.length);
      const remaining = right
        ? ft.params.slice(0, ft.params.length - e.args.length)
        : ft.params.slice(e.args.length);
      // The remaining function performs the callee's effects and those of any
      // callbacks already supplied; constructing the partial itself does not.
      const eff: Eff = mergeEff(ft.eff, funArgEff);
      return {
        ty: fnT(remaining, ft.ret, eff),
        // A partial application is a function value: it runs where it is
        // invoked, and its arguments are cut separately. Keep the callee's side
        // (a server function stays server), not the argument's.
        place: joinPlace(fnInfo.place, placeFromEffects(ft.eff, this)),
        eff: mergeEff(fnInfo.eff, argEff),
      };
    }

    const eff = mergeEff(fnInfo.eff, ft.eff, argEff, funArgEff);
    if (callee?.dicts?.length && calleeTrace) {
      const dicts: { trait: string; type: Type }[] = [];
      for (const d of callee.dicts) {
        const t = calleeTrace.get(d.varId);
        if (t) dicts.push({ trait: d.trait, type: prune(t) });
      }
      this.mod.dictArgs.set(e, dicts);
    }
    if (this.effHasAlgebraic(eff)) this.mod.genCalls.add(e);
    // Producing a placed value places the call: `Server.state 0` returns a
    // `Cell a @server`, and a component returns `Html`.
    return {
      ty: ft.ret,
      place: joinPlace(joinPlace(place, placeFromEffects(eff, this)), typePlace(ft.ret)),
      eff,
    };
  }

  private effHasAlgebraic(eff: Eff): boolean {
    // A provided effect is handled by its default provider and does not turn
    // the caller into a generator; an unprovided effect must be handled.
    for (const l of eff.labels) {
      const e = this.mod.effects.get(l);
      if (e && !e.provided) return true;
    }
    return false;
  }

  /**
   * A callback's effects propagate through the consumer only when the
   * declared parameter row does not admit them. `withState` and `Exn.attempt`
   * declare the handled row, so their callbacks do not leak State/Exn into the
   * caller; `map` declares a pure callback, so an effectful lambda propagates.
   */
  private unadmittedEffects(arg: Eff, param: Type | undefined): Eff {
    const p = param ? prune(param) : undefined;
    if (!p || p.k !== "fun") {
      return {
        labels: new Set(
          [...arg.labels].filter(
            (l) => this.mod.effects.has(l) && !this.mod.effects.get(l)?.provided,
          ),
        ),
      };
    }
    if (p.eff.tail !== undefined) return emptyEff();
    const admitted = p.eff.labels;
    return {
      labels: new Set(
        [...arg.labels].filter(
          (l) => this.mod.effects.has(l) && !this.mod.effects.get(l)?.provided && !admitted.has(l),
        ),
      ),
    };
  }

  /** Index of the parameter a trait method dispatches on; -1 means its result. */
  dispatchIndex(trait: TraitInfo, tm: Type): number {
    if (tm.k !== "fun") return -1;
    const sv = trait.params.length ? trait.paramVars.get(trait.params[0]!) : undefined;
    const pv = sv ? prune(sv) : undefined;
    if (!pv || pv.k !== "var") return tm.params.length ? 0 : -1;
    // Prefer the parameter whose head is the constructor itself (`f a`), not a
    // function that merely mentions it (`a -> f b`, as in `bind`).
    const headIndex = tm.params.findIndex((p) => {
      const q = prune(p);
      if (q.k !== "app") return false;
      const fn = prune(q.fn);
      return fn.k === "var" && fn.id === pv.id;
    });
    if (headIndex >= 0) return headIndex;
    return tm.params.findIndex((p) => occurs(pv.id, p));
  }

  inferTraitCall(traitName: string, method: string, schemeTy: Type, args: Expr[], node: object): ResInfo {
    const inst = instantiate(schemeTy, 0);
    if (inst.k !== "fun") this.fail(`${traitName}.${method} is not callable`);
    const arity = inst.params.length;
    if (args.length > arity) this.fail(`${traitName}.${method} expects ${arity} argument(s)`);
    const partial = args.length < arity;
    // A trait method may declare effects; they participate in placement exactly
    // like a function's declared row (CellOps declares `! Client`).
    const seed: Place = placeFromEffects(inst.eff, this);
    const inferArgs = (slots: number[]): { place: Place; evalEff: Eff; funArgEff: Eff } => {
      let place = seed;
      let evalEff = emptyEff();
      let funArgEff = emptyEff();
      const order = args.map((_, i) => i)
        .sort((a, b) => Number(args[a]!.k === "Lam") - Number(args[b]!.k === "Lam"));
      for (const i of order) {
        const a = args[i]!;
        const slot = slots[i]!;
        const want = inst.params[slot]!;
        const r = this.inferArg(a, want);
        const hint =
          traitBase(traitName) === "Monad" && method === "bind" && i === 0
            ? this.cellBindHint(r.ty, want)
            : undefined;
        this.unifyArg(r.ty, want, a.span, `${traitName}.${method} argument ${i + 1}`, hint);
        // Callback effects are deferred to the consumer (full call) or to the
        // resulting function type (partial application).
        const argFun = prune(r.ty);
        if (argFun.k === "fun") {
          const declared = schemeTy.k === "fun" ? schemeTy.params[slot] : undefined;
          funArgEff = mergeEff(funArgEff, this.unadmittedEffects(argFun.eff, declared));
        }
        place = joinPlace(place, r.place);
        evalEff = mergeEff(evalEff, r.eff);
      }
      return { place, evalEff, funArgEff };
    };
    let slots = args.map((_, i) => i);
    let right = false;
    const beforeArgs = snapshotSubst();
    let placed: { place: Place; evalEff: Eff; funArgEff: Eff };
    try {
      placed = inferArgs(slots);
    } catch (err) {
      // `map f` and other sections fill the trailing parameters.
      if (!partial || args.length === 0 || !(err instanceof FlowError)) throw err;
      restoreSubst(beforeArgs);
      slots = args.map((_, i) => arity - args.length + i);
      right = true;
      try {
        placed = inferArgs(slots);
      } catch {
        restoreSubst(beforeArgs);
        throw err;
      }
    }
    const { place, evalEff, funArgEff } = placed;
    const callEff = mergeEff(inst.eff, evalEff, funArgEff);
    if (!partial && this.effHasAlgebraic(callEff)) this.mod.genCalls.add(node);
    if (partial) {
      this.mod.partialCalls.add(node);
      if (right) this.mod.rightPartials.set(node, arity - args.length);
    }
    const remaining = right ? inst.params.slice(0, arity - args.length) : inst.params.slice(args.length);
    const resultTy = partial
      ? fnT(remaining, inst.ret, mergeEff(inst.eff, funArgEff))
      : inst.ret;
    const eff = partial ? evalEff : callEff;

    const trait = this.mod.traits.get(traitName)!;
    const di = this.dispatchIndex(trait, schemeTy);
    // A partial call produces a function value. Its data arguments are cut
    // separately, but a non-sendable receiver (a Cell, a DOM handle) pins the
    // closure to that receiver's side.
    const recvTy = di >= 0 && args[di] ? this.mod.info.get(args[di]!)?.ty : undefined;
    const pinned = recvTy ? !sendable(recvTy).ok : false;
    const recvPlace = pinned && args[di]
      ? joinPlace(this.mod.info.get(args[di]!)?.place ?? "neutral", typePlace(recvTy!))
      : "neutral";
    const resultPlace = partial ? joinPlace(seed, recvPlace) : place;
    let target = prune(di >= 0 ? inst.params[di]! : inst.ret);
    if (trait.ctorParams.size && trait.params.length && trait.ctorParams.has(trait.params[0]!)) {
      const head = headConstructor(target);
      // Keep the full applied type for concrete constructors: a partially
      // applied instance (`Functor (Result e)`) matches its fixed prefix
      // against the actual `Result e a`. A type variable still dispatches
      // through its dictionary.
      target = head.k === "con" ? target : head;
    }
    this.mod.info.set(node, { ty: resultTy, place: resultPlace, eff });

    if (target.k === "var") {
      if (target.bounds?.includes(traitName)) {
        this.bindTraitChoice(node, traitName, method, target);
        return { ty: resultTy, place: resultPlace, eff };
      }
      // A return-position method (`pure`, `empty`, `return`) has no receiver to
      // dispatch on yet. Defer until the enclosing body has unified the result
      // type; the enclosing lambda or annotation may still supply it.
      this.pendingTraitCalls.push({
        node, trait: traitName, method, target, di,
        span: (node as { span?: { line?: number; col?: number; file?: string } }).span,
      });
      return { ty: resultTy, place: resultPlace, eff };
    }
    this.bindTraitChoice(node, traitName, method, target);
    return { ty: resultTy, place: resultPlace, eff };
  }

  /** Point a trait call at a dictionary parameter or a concrete impl. */
  private bindTraitChoice(
    node: object,
    traitName: string,
    method: string,
    target: Type,
    span?: { line?: number; col?: number; file?: string },
  ): void {
    const t = prune(target);
    if (t.k === "var") {
      if (!t.bounds?.includes(traitName)) {
        const label = traitName.split("$")[0]!;
        this.fail(
          `no instance of ${label} for type variable ${typeStr(t)}; ` +
          `add a trait bound such as <a: ${label}>`,
          span,
        );
      }
      const dictName = this.dictForVar(t, traitName);
      if (!dictName) this.fail(`internal: no dictionary parameter for ${traitName} ${typeStr(t)}`, span);
      this.mod.boundChoices.set(node, { dictName, method, trait: traitName });
      return;
    }
    const resolved = this.resolveImplInfo(traitName, t);
    if (!resolved) this.fail(`no instance of ${traitName.split("$")[0]} for ${typeStr(t)}`, span);
    const impl = resolved.impl;
    const dicts: { trait: string; type: Type }[] = [];
    for (const d of impl.dicts ?? []) {
      const sub = resolved.subst.get(d.varId);
      if (sub) dicts.push({ trait: d.trait, type: sub });
    }
    this.mod.implChoices.set(node, { impl, method, mangled: impl.mangled.get(method)!, dicts });
  }

  /** Resolve deferred return-position trait calls once the body's types are known. */
  private resolvePendingTraitCalls(): void {
    const pending = this.pendingTraitCalls;
    this.pendingTraitCalls = [];
    for (const p of pending) {
      let target = prune(p.target);
      // A call with no receiver and one instance can still pick that instance,
      // but only after the body's annotations have had a chance to constrain it.
      if (p.di < 0 && target.k === "var" && !target.bounds?.includes(p.trait)) {
        const impls = this.mod.impls.filter((im) => im.trait === p.trait && im.targetType);
        if (impls.length === 1) {
          unify(target, instantiate(impls[0]!.targetType!, 0));
          target = prune(target);
        }
      }
      this.bindTraitChoice(p.node, p.trait, p.method, target, p.span);
    }
  }

  resolveImplInfo(trait: string, target: Type): { impl: ImplInfo; subst: Map<number, Type> } | null {
    for (const im of this.mod.impls) {
      if (im.trait !== trait || !im.targetType) continue;
      const before = snapshotSubst();
      try {
        const trace = new Map<number, Type>();
        const inst = instantiate(im.targetType, 0, trace);
        const instType = prune(inst);
        const actual = prune(target);
        // A constructor instance may be partially applied (`Functor (Result e)`,
        // `Functor Option`): match the fixed prefix and leave the rest open.
        if (instType.k === "con" && actual.k === "con"
          && instType.name === actual.name && instType.args.length <= actual.args.length) {
          for (let i = 0; i < instType.args.length; i++) unify(instType.args[i]!, actual.args[i]!);
        } else {
          unify(instType, actual);
        }
        const subst = new Map<number, Type>();
        for (const [oldId, freshVar] of trace) subst.set(oldId, prune(freshVar));
        return { impl: im, subst };
      } catch {
        restoreSubst(before);
      }
    }
    return null;
  }

  resolveImpl(trait: string, target: Type): ImplInfo | null {
    return this.resolveImplInfo(trait, target)?.impl ?? null;
  }

  inferMatch(e: Expr & { k: "Match" }): ResInfo {
    const scrut = this.infer(e.scrut);
    const result = fresh(0);
    let place = scrut.place;
    let eff = scrut.eff;
    const seen = new Set<string>();

    for (const arm of e.arms) {
      const saved = this.env;
      this.env = new Map(saved);
      this.bindPattern(arm.pat, scrut.ty, seen);
      if (arm.guard) {
        const g = this.infer(arm.guard);
        this.expectType(g.ty, BOOL, arm.guard, "match guard");
        eff = mergeEff(eff, g.eff);
        place = joinPlace(place, g.place);
      }
      const b = this.infer(arm.body);
      const beforeArm = snapshotSubst();
      try { unify(b.ty, result); }
      catch (err) {
        restoreSubst(beforeArm);
        if (err instanceof FlowError) {
          const [armText, otherText] = typeStrs([b.ty, result]);
          this.fail(
            `match arm returns ${armText}, but the other arms return ${otherText}`,
            tailSpan(arm.body),
          );
        }
        throw err;
      }
      place = joinPlace(place, b.place);
      eff = mergeEff(eff, b.eff);
      this.env = saved;
    }

    const st = prune(scrut.ty);
    if (st.k === "con") {
      const ctors = [...this.mod.ctors.values()].filter((c) => c.typeName === st.name);
      if (ctors.length && !this.hasWildcard(e.arms)) {
        const missing = ctors.filter((c) => !seen.has(c.variant)).map((c) => c.variant);
        if (missing.length) this.fail(`non-exhaustive match on ${st.name}: missing ${missing.join(", ")}`, e.span);
      }
    }
    return { ty: result, place, eff };
  }

  private hasWildcard(arms: { pat: Pattern }[]): boolean {
    return arms.some((a) => a.pat.k === "PWild" || a.pat.k === "PVar"
      // `{ id = n }` matches the only constructor of a record ADT.
      || (a.pat.k === "PRecord" && this.mod.recordAdtPatterns.has(a.pat) && irrefutablePattern(a.pat)));
  }

  bindPattern(p: Pattern, ty: Type, seen: Set<string>) {
    switch (p.k) {
      case "PWild": return;
      case "PVar":
        if (p.ann) this.unifyArg(ty, this.resolveType(p.ann, this.typeParams), p.span, `'${p.name}' is annotated ${typeStr(this.resolveType(p.ann, this.typeParams))}`);
        this.env.set(p.name, { ty, envVars: new Set(), place: "neutral" });
        return;
      case "PLit": {
        const lt = p.lit.k === "Int" ? INT : p.lit.k === "Float" ? FLOAT : p.lit.k === "Str" ? STR : p.lit.k === "Unit" ? UNIT : BOOL;
        this.unifyArg(ty, lt, p.span, "pattern does not match the scrutinee"); return;
      }
      case "PTuple": {
        const items = p.items.map(() => fresh(0));
        this.unifyArg(ty, { k: "tuple", items }, p.span, "tuple pattern does not match the scrutinee");
        p.items.forEach((q, i) => this.bindPattern(q, items[i]!, seen));
        return;
      }
      case "PRecord": {
        const fields: Record<string, Type> = {};
        for (const f of p.fields) fields[f.name] = fresh(0);
        const t = prune(ty);
        const payload = t.k === "con" ? this.recordPayload(t) : null;
        if (payload) {
          // A record pattern destructures the payload of a record ADT.
          for (const name of Object.keys(fields)) {
            const f = payload.fields[name];
            if (!f) this.fail(`${typeStr(t)} has no field '${name}'`, p.span);
            unify(fields[name]!, f);
          }
          this.mod.recordAdtPatterns.add(p);
        } else {
          this.unifyArg(ty, { k: "rec", fields, atLeast: true }, p.span, "record pattern does not match the scrutinee");
        }
        for (const f of p.fields) this.bindPattern(f.pat, fields[f.name]!, seen);
        return;
      }
      case "PList": {
        const el = fresh(0);
        this.unifyArg(ty, listOf(el), p.span, "list pattern does not match the scrutinee");
        for (const q of p.items) this.bindPattern(q, el, seen);
        if (p.rest) this.env.set(p.rest, { ty: listOf(el), envVars: new Set(), place: "neutral" });
        return;
      }
      case "PCtor": {
        const c = this.mod.ctors.get(p.name);
        if (!c) this.fail(`unknown constructor '${p.name}'`, p.span);
        seen.add(p.name);
        const inst = instantiate(c.scheme, 0);
        const result = inst.k === "fun" ? inst.ret : inst;
        const argTypes = inst.k === "fun" ? inst.params : [];
        this.unifyArg(ty, result, p.span, `pattern ${p.name} does not match the scrutinee`);
        if (p.args.length !== argTypes.length) this.fail(`constructor ${p.name} expects ${argTypes.length} pattern argument(s)`, p.span);
        p.args.forEach((q, i) => this.bindPattern(q, argTypes[i]!, seen));
        return;
      }
    }
  }

  inferBinary(e: Expr & { k: "Binary" }): ResInfo {
    if (e.op === ">>=") {
      const monad = this.mod.traits.get("Monad");
      if (!monad) this.fail("operator '>>=' needs the Monad trait: import Flow.Monad (Monad)", e.span);
      const bind = monad.methods.get("bind");
      if (!bind) this.fail("trait Monad has no 'bind' method", e.span);
      return this.inferTraitCall("Monad", "bind", bind.ty, [e.r, e.l], e);
    }
    const l = this.infer(e.l);
    const r = this.infer(e.r);
    const op = e.op;
    const place = joinPlace(l.place, r.place);
    const eff = mergeEff(l.eff, r.eff);
    const left = () => typeStr(l.ty);
    const right = () => typeStr(r.ty);

    if (op === "++") {
      // append: strings and lists
      const lt = prune(l.ty);
      if (lt.k === "con" && lt.name === "Str") { this.unifyArg(r.ty, STR, e.r.span, `right operand of '++' (left is Str)`); return { ty: STR, place, eff }; }
      const rt = prune(r.ty);
      if (rt.k === "con" && rt.name === "Str") { this.unifyArg(l.ty, STR, e.l.span, `left operand of '++' (right is Str)`); return { ty: STR, place, eff }; }
      this.unifyArg(r.ty, l.ty, e.r.span, `operands of '++' must share a type (left is ${left()}, right is ${right()})`);
      return { ty: l.ty, place, eff };
    }
    if (op === "and" || op === "or" || op === "&&" || op === "||") {
      this.expectType(l.ty, BOOL, e.l, `operand of ${op}`);
      this.expectType(r.ty, BOOL, e.r, `operand of ${op}`);
      return { ty: BOOL, place, eff };
    }
    if (op === "==" || op === "!=") {
      this.unifyArg(l.ty, r.ty, e.r.span, `operands of '${op}' must share a type (left is ${left()}, right is ${right()})`);
      return { ty: BOOL, place, eff };
    }
    if (["<", "<=", ">", ">="].includes(op)) {
      const lt = prune(l.ty);
      if (lt.k === "con" && lt.name === "Float") this.unifyArg(r.ty, FLOAT, e.r.span, `right operand of '${op}'`);
      else if (lt.k === "con" && lt.name === "Str") this.unifyArg(r.ty, STR, e.r.span, `right operand of '${op}'`);
      else {
        this.unifyArg(l.ty, INT, e.l.span, `left operand of '${op}'`);
        this.unifyArg(r.ty, INT, e.r.span, `right operand of '${op}'`);
      }
      return { ty: BOOL, place, eff };
    }
    if (op === "+") {
      const lt = prune(l.ty);
      if (lt.k === "con" && lt.name === "Str") { this.unifyArg(r.ty, STR, e.r.span, `right operand of '+' (left is Str)`); return { ty: STR, place, eff }; }
      if (lt.k === "con" && lt.name === "Float") { this.unifyArg(r.ty, FLOAT, e.r.span, `right operand of '+' (left is Float)`); return { ty: FLOAT, place, eff }; }
      this.unifyArg(l.ty, INT, e.l.span, `left operand of '+'`);
      this.unifyArg(r.ty, INT, e.r.span, `right operand of '+' (left is Int)`);
      return { ty: INT, place, eff };
    }
    if (["-", "*", "/", "%"].includes(op)) {
      const lt = prune(l.ty);
      if (lt.k === "con" && lt.name === "Float") { this.unifyArg(r.ty, FLOAT, e.r.span, `right operand of '${op}' (left is Float)`); return { ty: FLOAT, place, eff }; }
      this.unifyArg(l.ty, INT, e.l.span, `left operand of '${op}'`);
      this.unifyArg(r.ty, INT, e.r.span, `right operand of '${op}'`);
      return { ty: INT, place, eff };
    }
    this.fail(`unknown operator '${op}'`, e.span);
  }

  inferHtmlNode(n: HtmlNode): ResInfo {
    switch (n.k) {
      case "Text":
        return { ty: HTML, place: "client", eff: emptyEff() };
      case "Hole": {
        const r = this.infer(n.e);
        const t = prune(r.ty);
        if (t.k === "con" && t.name === "Html") return { ty: HTML, place: joinPlace(r.place, "client"), eff: r.eff };
        if (t.k === "var") { unify(r.ty, STR); return { ty: HTML, place: joinPlace(r.place, "client"), eff: r.eff }; }
        if (t.k === "con" && ["Int", "Float", "Str", "Bool"].includes(t.name)) return { ty: HTML, place: joinPlace(r.place, "client"), eff: r.eff };
        return { ty: HTML, place: joinPlace(r.place, "client"), eff: r.eff };
      }
      case "Element": {
        let place: Place = "client";
        let eff = emptyEff();
        for (const a of n.attrs) {
          if (a.value.k === "expr") {
            const r = this.infer(a.value.e);
            if (a.name.startsWith("on")) {
              this.unifyArg(r.ty, fnT([con("Event")], UNIT), a.value.e.span, `event handler '${a.name}'`);
            } else {
              const want = BOOL_ATTRIBUTES.has(a.name) ? BOOL : INT_ATTRIBUTES.has(a.name) ? INT : STR;
              this.unifyArg(r.ty, want, a.value.e.span, `attribute '${a.name}'`);
            }
            place = joinPlace(place, r.place);
            eff = mergeEff(eff, r.eff);
          }
        }
        for (const c of n.children) {
          const r = this.inferHtmlNode(c);
          place = joinPlace(place, r.place);
          eff = mergeEff(eff, r.eff);
        }
        return { ty: HTML, place, eff };
      }
      case "Component": {
        const fields: Record<string, Type> = {};
        let place: Place = "neutral";
        let eff = emptyEff();
        for (const a of n.attrs) {
          if (a.value.k === "expr") {
            const r = this.infer(a.value.e);
            fields[a.name] = r.ty;
            place = joinPlace(place, r.place);
            eff = mergeEff(eff, r.eff);
          } else {
            fields[a.name] = STR;
          }
        }
        // `children` is always supplied at the call site (an empty fragment when
        // there are none). Components that do not declare it simply ignore the
        // extra field, because call-site records are open.
        fields["children"] = HTML;
        const inst = instantiate(this.lookupVar(n.name, n.span), 0);
        if (inst.k !== "fun") this.fail(`component '${n.name}' is not a function`, n.span);
        if (inst.params.length === 1) {
          unify(inst.params[0]!, { k: "rec", fields, open: true });
        } else if (inst.params.length > 1) {
          this.fail(`component '${n.name}' must take zero or one record parameter`, n.span);
        }
        unify(inst.ret, HTML);
        for (const c of n.children) {
          const r = this.inferHtmlNode(c);
          place = joinPlace(place, r.place);
          eff = mergeEff(eff, r.eff);
        }
        const res: ResInfo = { ty: HTML, place: joinPlace(place, "client"), eff: mergeEff(eff, inst.eff) };
        // record component calls so editor features can resolve their names
        this.mod.info.set(n, res);
        return res;
      }
    }
  }

  /** Unify an argument/value with an expected type, reporting at its span. */
  private unifyArg(
    got: Type,
    want: Type,
    span: { line: number; col: number; file?: string },
    what: string,
    hint?: string,
  ) {
    const before = snapshotSubst();
    const gotText = typeStr(got);
    const wantText = typeStr(want);
    try {
      unify(got, want);
    } catch (err) {
      restoreSubst(before);
      if (err instanceof FlowError) {
        this.fail(`${what}: expected ${wantText}, got ${gotText}${hint ? `\n${hint}` : ""}`, span);
      }
      throw err;
    }
  }

  /** A `let x: T = value` annotation: report both types at the value. */
  /** Explain `x <- cell` when the continuation ends in `()` instead of a cell. */
  private cellBindHint(got: Type, want: Type): string | undefined {
    const g = prune(got);
    const w = prune(want);
    if (g.k !== "fun" || w.k !== "fun") return undefined;
    const gr = prune(g.ret);
    const wr = prune(w.ret);
    if (!(gr.k === "con" && gr.name === "Unit")) return undefined;
    if (!(wr.k === "con" && wr.name === "Cell")) return undefined;
    return "`<-` reads a cell's current value, and the rest of the do block must " +
      "produce a Cell (usually `Cell.pure ...`). For an event handler that reads " +
      "and then writes, use `let x = get cell` instead.";
  }

  private checkAnnotation(got: Type, want: Type, name: string, span: { line: number; col: number; file?: string }) {
    const before = snapshotSubst();
    try {
      unify(got, want);
    } catch (err) {
      restoreSubst(before);
      if (err instanceof FlowError) {
        const [wantText, gotText] = typeStrs([want, got]);
        this.fail(`'${name}' is annotated ${wantText}, but its value is ${gotText}`, span);
      }
      throw err;
    }
  }

  expectType(got: Type, want: Type, node: Expr, what: string) {
    try { unify(got, want); }
    catch (err) {
      if (err instanceof FlowError) this.fail(`${what}: ${err.message}`, node.span);
      throw err;
    }
  }
}

/** The expression that actually produces a body's value (the tail of a block). */
function tailSpan(body: Expr): { line: number; col: number; file?: string } {
  if (body.k === "Block") {
    if (body.value) return body.value.span;
    for (let i = body.stmts.length - 1; i >= 0; i--) {
      const s = body.stmts[i]!;
      if (s.k === "ExprStmt") return s.span;
    }
  }
  return body.span;
}

export function mergeEff(...rows: Eff[]): Eff {
  const out: Eff = { labels: new Set() };
  for (const r of rows) for (const l of r.labels) out.labels.add(l);
  return out;
}

/** Levenshtein distance, for "did you mean" hints. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = tmp;
    }
  }
  return prev[b.length]!;
}

/** The head constructor of a type, for traits parameterised by a type
 *  constructor (`Functor<f>` dispatches on List, Option, …). */
function headConstructor(t: Type): Type {
  const p = prune(t);
  if (p.k === "con") return { k: "con", name: p.name, args: [] };
  if (p.k === "app") return headConstructor(p.fn);
  return p;
}

export function placeFromEffects(eff: Eff, inf: Infer): Place {
  let p: Place = "neutral";
  for (const l of eff.labels) {
    // An effect carries the placement declared on it or supplied by its
    // provider. An unprovided effect is neutral and runs where it is handled.
    const e = inf.mod.effects.get(l);
    if (e) p = joinPlace(p, e.place);
  }
  return p;
}

/* ------------------------------------------------------------------ */
/* AST walkers used by the algebraic-effect checks                     */
/* ------------------------------------------------------------------ */

export function forEachExpr(e: Expr, fn: (e: Expr) => void): void {
  fn(e);
  switch (e.k) {
    case "Lit": case "Var": return;
    case "Lam": forEachExpr(e.body, fn); return;
    case "App": forEachExpr(e.fn, fn); for (const a of e.args) forEachExpr(a, fn); return;
    case "If": forEachExpr(e.cond, fn); forEachExpr(e.then, fn); forEachExpr(e.else, fn); return;
    case "Match":
      forEachExpr(e.scrut, fn);
      for (const a of e.arms) { if (a.guard) forEachExpr(a.guard, fn); forEachExpr(a.body, fn); }
      return;
    case "Let": forEachExpr(e.value, fn); forEachExpr(e.body, fn); return;
    case "Record": for (const f of e.fields) forEachExpr(f.value, fn); return;
    case "Field": forEachExpr(e.target, fn); return;
    case "Tuple": case "List": for (const i of e.items) forEachExpr(i, fn); return;
    case "Ctor": for (const a of e.args) forEachExpr(a, fn); return;
    case "Binary": forEachExpr(e.l, fn); forEachExpr(e.r, fn); return;
    case "Assign":
      forEachExpr(e.target, fn);
      if (e.value) forEachExpr(e.value, fn);
      return;
    case "Unary": forEachExpr(e.e, fn); return;
    case "Html": for (const n of e.nodes) forEachHtmlExpr(n, fn); return;
    case "Handle":
      for (const op of e.ops) forEachExpr(op.fn, fn);
      forEachExpr(e.body, fn);
      return;
    case "Block":
      for (const s of e.stmts) forEachExpr(s.k === "LetStmt" ? s.value : s.e, fn);
      if (e.value) forEachExpr(e.value, fn);
      return;
  }
}

function forEachHtmlExpr(n: HtmlNode, fn: (e: Expr) => void): void {
  switch (n.k) {
    case "Text": return;
    case "Hole": forEachExpr(n.e, fn); return;
    case "Element": case "Component":
      for (const a of n.attrs) if (a.value.k === "expr") forEachExpr(a.value.e, fn);
      for (const c of n.children) forEachHtmlExpr(c, fn);
      return;
  }
}

/** A pattern that cannot fail to match a value of its type. */
function irrefutablePattern(p: Pattern): boolean {
  switch (p.k) {
    case "PWild": case "PVar": return true;
    case "PTuple": return p.items.every(irrefutablePattern);
    case "PRecord": return p.fields.every((f) => irrefutablePattern(f.pat));
    default: return false;
  }
}

/** The first binder (parameter, `let`, or pattern) named `name` in `e`, if any. */
/**
 * Field names of a single-constructor ADT with a record payload, for editor
 * completion. `Infer.recordPayload` resolves the same payload's field types.
 */
export function adtRecordFieldNames(
  t: Type,
  typeDefs: Map<string, { params: string[]; kind: "adt" | "record" | "alias"; decl: Decl }>,
): string[] | null {
  if (t.k !== "con") return null;
  const def = typeDefs.get(t.name);
  if (!def || def.kind !== "adt") return null;
  const decl = def.decl;
  if (decl.k !== "Adt" || decl.variants.length !== 1) return null;
  const variant = decl.variants[0]!;
  if (variant.args.length !== 1 || variant.args[0]!.k !== "TRecord") return null;
  return variant.args[0]!.fields.map((f) => f.name);
}

export function findBinderNamed(e: Expr, name: string): { line: number; col: number } | null {
  let found: { line: number; col: number } | null = null;
  const pat = (p: Pattern): void => {
    if (found) return;
    switch (p.k) {
      case "PVar": if (p.name === name) found = p.span; return;
      case "PTuple": p.items.forEach(pat); return;
      case "PRecord": p.fields.forEach((f) => pat(f.pat)); return;
      case "PList": p.items.forEach(pat); if (p.rest === name) found = p.span; return;
      case "PCtor": p.args.forEach(pat); return;
      default: return;
    }
  };
  forEachExpr(e, (x) => {
    if (found) return;
    switch (x.k) {
      case "Lam": for (const p of x.params) if (p.name === name) found = p.span; return;
      case "Let": if (x.name === name) found = x.span; return;
      case "Match": for (const a of x.arms) pat(a.pat); return;
      case "Block":
        for (const s of x.stmts) if (s.k === "LetStmt" && s.name === name) found = s.span;
        return;
    }
  });
  return found;
}

export { fresh, prune, typeStr };

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
  Decl, Expr, FnSig, HtmlNode, Param, Pattern, Program, TypeExpr, EffRow, Place,
} from "./ast.ts";
import {
  type Type, type Eff, fresh, prune, unify, unifyEff, generalize, instantiate,
  freeVars, emptyEff, con, INT, FLOAT, STR, BOOL, UNIT, HTML, fnT, listOf,
  cellOf, eventOf, typeStr, joinPlace, typePlace,
  snapshotSubst, restoreSubst, markGeneric,
} from "./types.ts";

export interface ResInfo { ty: Type; place: Place; eff: Eff }

export interface CtorInfo {
  typeName: string; variant: string; arity: number;
  typeParams: string[]; argTypes: TypeExpr[]; scheme: Type;
}

export interface TraitInfo {
  name: string; params: string[];
  methods: Map<string, { sig: FnSig; ty: Type }>;
}

export interface ImplInfo {
  trait: string; target: TypeExpr; index: number;
  methods: Map<string, { params: Param[]; ret?: TypeExpr; eff?: EffRow; body: Expr }>;
  mangled: Map<string, string>;
}

export interface EffectInfo {
  name: string; ops: Map<string, { sig: FnSig; ty: Type }>; place: Place;
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
  /** top-level placement annotations on the signature, if written */
  paramPlaces?: (AnnPlace | undefined)[];
  retPlace?: AnnPlace;
  /** native (JavaScript) implementation, for `unsafe extern` declarations */
  extern?: { target: "js"; implName: string };
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
  implChoices: Map<object, { impl: ImplInfo; method: string; mangled: string }>;
  varTypes: Map<object, Type>;
  methodIndex: Map<string, string>;
  diagnostics: string[];
  /** type errors collected for the editor (the CLI rethrows the first one) */
  errors: FlowError[];
}

// The language surface that used to be injected here now lives in
// std/prelude.flow and reaches the host through `unsafe extern js` bindings.
// No callable primitive is registered by the compiler.

export const implFnName = (trait: string, index: number, method: string) =>
  `$impl_${trait}_${index}_${method}`;

const BUILTIN_TYPES = new Set([
  "Int", "Float", "Str", "Bool", "Unit", "Html", "List", "Cell", "Event", "Dom",
]);

export class Infer {
  mod: Module;
  env = new Map<string, EnvEntry>();

  constructor(file: string) {
    this.mod = {
      file, fns: new Map(), ctors: new Map(), traits: new Map(), impls: [],
      effects: new Map(), provides: new Map(), typeDefs: new Map(),
      info: new Map(), implChoices: new Map(), methodIndex: new Map(),
      varTypes: new Map(),
      diagnostics: [],
      errors: [],
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
  private collect(step: () => void) {
    try {
      step();
    } catch (e) {
      if (!(e instanceof FlowError)) throw e;
      const key = `${e.file}:${e.line}:${e.col}:${e.message}`;
      if (!this.mod.errors.some((x) => `${x.file}:${x.line}:${x.col}:${x.message}` === key)) {
        this.mod.errors.push(e);
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* driver                                                           */
  /* ---------------------------------------------------------------- */

  run(prog: Program): Module {
    for (const d of prog.decls) {
      if (d.k === "Adt" || d.k === "RecordType" || d.k === "Alias") this.registerType(d);
      if (d.k === "Trait") this.registerTrait(d);
      if (d.k === "Effect") this.registerEffect(d);
    }
    for (const d of prog.decls) if (d.k === "Adt") this.registerCtors(d);
    for (const d of prog.decls) if (d.k === "Impl") this.registerImpl(d);
    for (const d of prog.decls) if (d.k === "Fn") this.declareFn(d);
    for (const d of prog.decls) if (d.k === "Extern") this.declareExtern(d);

    // Capabilities (Server / Client / Store) are declared by std::prelude, which
    // every module imports implicitly; the compiler injects nothing here.

    // Providers determine where an effect lives, and effect placement determines
    // where the calls are placed. Run both to a fixpoint.
    this.checkProvides(prog);
    for (const d of prog.decls) if (d.k === "Provide") this.registerProvide(d);
    this.applyProviderPlaces();

    for (let pass = 0; pass < 8; pass++) {
      const before = this.placementFingerprint();
      for (const d of prog.decls) if (d.k === "Fn") this.collect(() => this.checkFnBody(d));
      for (const d of prog.decls) if (d.k === "Impl") this.collect(() => this.checkImplBodies(d));
      this.collect(() => this.checkProvides(prog));
      for (const d of prog.decls) if (d.k === "Provide") this.registerProvide(d);
      this.applyProviderPlaces();
      if (this.placementFingerprint() === before) break;
    }

    this.mod.diagnostics = [...this.mod.info.values()].length ? [] : [];
    return this.mod;
  }

  private placementFingerprint(): string {
    const parts = [this.effectFingerprint()];
    for (const e of this.mod.effects.values()) parts.push(`p:${e.name}:${e.place}`);
    for (const p of this.mod.provides.values()) parts.push(`v:${p.effect}:${p.place}`);
    return parts.join(";");
  }

  private effectFingerprint(): string {
    const parts: string[] = [];
    for (const f of this.mod.fns.values()) {
      if (f.scheme.k === "fun") parts.push(f.name + ":" + [...f.scheme.eff.labels].sort().join("|"));
    }
    return parts.sort().join(";");
  }

  /* ---------------------------------------------------------------- */
  /* environment                                                      */
  /* ---------------------------------------------------------------- */

  lookupVar(name: string, span?: { line: number; col: number }): Type {
    const local = this.env.get(name);
    if (local) return instantiate(local.ty, 0);
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
    this.fail(`unbound name '${name}'`, span);
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
    if (fn && fn.scheme.k === "fun") return placeFromEffects(fn.scheme.eff, this);
    const eop = this.findEffectOp(name);
    if (eop) { const e = this.mod.effects.get(eop.effect); return e ? e.place : "server"; }
    return "neutral";
  }

  /* ---------------------------------------------------------------- */
  /* declarations                                                     */
  /* ---------------------------------------------------------------- */

  registerType(d: Decl) {
    if (d.k === "Adt") this.mod.typeDefs.set(d.name, { params: d.params, kind: "adt", decl: d });
    if (d.k === "RecordType") this.mod.typeDefs.set(d.name, { params: d.params, kind: "record", decl: d });
    if (d.k === "Alias") this.mod.typeDefs.set(d.name, { params: d.params, kind: "alias", decl: d });
  }

  registerCtors(d: Decl & { k: "Adt" }) {
    for (const v of d.variants) {
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
    const methods = new Map<string, { sig: FnSig; ty: Type }>();
    for (const m of d.methods) {
      const ty = this.resolveSig(m, params);
      methods.set(m.name, { sig: m, ty });
      this.mod.methodIndex.set(m.name, d.name);
    }
    this.mod.traits.set(d.name, { name: d.name, params: d.params, methods });
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
      place: d.place ?? existing?.place ?? "server",
    });
  }

  /** A provider decides where its effect runs; otherwise the declaration's
   *  `@ client` / `@ server` annotation stands. A provider whose body is
   *  placement-neutral (FFI calls, pure code) does not move the effect. */
  private applyProviderPlaces() {
    for (const e of this.mod.effects.values()) {
      const p = this.mod.provides.get(e.name);
      if (p && p.place !== "neutral") e.place = p.place;
    }
  }

  registerImpl(d: Decl & { k: "Impl" }) {
    const index = this.mod.impls.length;
    const mangled = new Map<string, string>();
    const methods = new Map<string, { params: Param[]; ret?: TypeExpr; eff?: EffRow; body: Expr }>();
    for (const m of d.methods) {
      const fname = implFnName(d.trait, index, m.name);
      mangled.set(m.name, fname);
      methods.set(m.name, { params: m.params, ret: m.ret, eff: m.eff, body: m.body });
      this.mod.fns.set(fname, {
        name: fname, scheme: fnT([], fresh(0)), params: m.params, ret: m.ret,
        eff: m.eff, body: m.body, pub: false, synthetic: true, span: m.span,
        paramPlaces: m.params.map((p) => annotatedPlace(p.type)),
        retPlace: annotatedPlace(m.ret),
      });
    }
    this.mod.impls.push({ trait: d.trait, target: d.target, index, methods, mangled });
    // declare signatures for the synthetic functions
    for (const m of d.methods) {
      const fname = implFnName(d.trait, index, m.name);
      const info = this.mod.fns.get(fname)!;
      info.scheme = this.resolveSig(m, new Map());
      markGeneric(info.scheme);
    }
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
        restoreSubst(before);
      }
    }
  }

  registerProvide(d: Decl & { k: "Provide" }) {
    if (!this.mod.effects.has(d.effect)) this.fail(`provide for unknown effect '${d.effect}'`, d.span);
    const ops = new Map<string, Expr>();
    let place: Place = "neutral";
    for (const o of d.ops) {
      const r = this.mod.info.get(o.fn);
      place = joinPlace(place, r ? r.place : "neutral");
      ops.set(o.name, o.fn);
    }
    this.mod.provides.set(d.effect, { effect: d.effect, ops, target: d.target, place });
  }

  declareFn(d: Decl & { k: "Fn" }) {
    const params = new Map<string, Type>();
    for (const tp of d.typeParams ?? []) {
      const v = fresh(0);
      v.generic = true;
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
    this.mod.fns.set(d.sig.name, {
      name: d.sig.name,
      scheme: ty,
      params: d.sig.params,
      ret: d.sig.ret,
      eff: d.sig.eff,
      pub: d.pub,
      paramPlaces: d.sig.params.map((p) => annotatedPlace(p.type)),
      retPlace: annotatedPlace(d.sig.ret),
      extern: { target: d.target, implName: d.implName },
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
    const info = this.mod.fns.get(name)!;
    const t = info.scheme;
    if (t.k !== "fun") return;

    const saved = this.env;
    this.env = new Map(saved);
    for (let i = 0; i < params.length; i++) {
      const p = params[i]!;
      this.env.set(p.name, { ty: t.params[i]!, envVars: new Set(), place: "neutral" });
    }
    let r: ResInfo;
    try {
      r = this.infer(body);
    } catch (e) {
      this.env = saved;
      if (e instanceof FlowError) this.fail(`${e.message}\n  in fn ${name}`, e.span ? { line: e.span.line, col: e.span.col } : undefined);
      throw e;
    }
    this.checkPlacement(info.retPlace, r.place, body.span, `fn ${name}`);
    try {
      unify(r.ty, t.ret);
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
      if (e instanceof FlowError) this.fail(`${e.message}\n  in fn ${name}`, body.span);
      throw e;
    }
    this.env = saved;
    this.mod.info.set(body, r);
  }

  /* ---------------------------------------------------------------- */
  /* type expressions                                                 */
  /* ---------------------------------------------------------------- */

  resolveSig(s: FnSig, params: Map<string, Type>): Type {
    const local = new Map(params);
    for (const tp of s.typeParams ?? []) {
      const v = fresh(0);
      v.generic = true;
      local.set(tp, v);
    }
    const ps = s.params.map((p) => this.resolveType(p.type, local));
    const ret = s.ret ? this.resolveType(s.ret, local) : fresh(0);
    const eff: Eff = s.eff ? { labels: new Set(s.eff.effects) } : emptyEff();
    return fnT(ps, ret, eff);
  }

  resolveType(te: TypeExpr, params: Map<string, Type>): Type {
    switch (te.k) {
      case "TVar": {
        if (params.has(te.name)) return params.get(te.name)!;
        const t = fresh(0);
        params.set(te.name, t);
        return t;
      }
      case "TCon": {
        const def = this.mod.typeDefs.get(te.name);
        if (te.name === "List") return listOf(this.resolveType(te.args[0]!, params));
        if (te.name === "Cell") return cellOf(this.resolveType(te.args[0]!, params));
        if (te.name === "Event") return con("Event");
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
        if (def && def.kind === "adt" && te.args.length !== def.params.length && te.args.length !== 0) {
          this.fail(`${te.name} expects ${def.params.length} type argument(s)`);
        }
        if (!def && !BUILTIN_TYPES.has(te.name)) {
          this.fail(`unknown type '${te.name}'`);
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
        for (const f of te.fields) fields[f.name] = this.resolveType(f.type, params);
        return { k: "rec", fields };
      }
      case "TTuple":
        return { k: "tuple", items: te.items.map((i) => this.resolveType(i, params)) };
      case "TPlaced":
        return this.resolveType(te.inner, params);
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
        const ty = this.lookupVar(e.name, e.span);
        this.mod.varTypes.set(e, ty);
        return { ty, place: this.varPlace(e.name), eff: emptyEff() };
      }

      case "Lam": {
        const saved = this.env;
        this.env = new Map(saved);
        const paramTypes = e.params.map((p) => {
          const t = this.resolveType(p.type, new Map());
          this.env.set(p.name, { ty: t, envVars: new Set(), place: "neutral" });
          return t;
        });
        const body = this.infer(e.body);
        this.env = saved;
        const ret = e.ret ? this.resolveType(e.ret, new Map()) : body.ty;
        const eff: Eff = { labels: new Set(body.eff.labels) };
        if (e.eff) for (const l of e.eff.effects) eff.labels.add(l);
        return { ty: fnT(paramTypes, ret, eff), place: body.place, eff: { labels: new Set() } };
      }

      case "App": return this.inferApp(e);

      case "If": {
        const c = this.infer(e.cond);
        this.expectType(c.ty, BOOL, e.cond, "if condition");
        const t = this.infer(e.then);
        const f = this.infer(e.else);
        unify(t.ty, f.ty);
        return { ty: t.ty, place: joinPlace(joinPlace(c.place, t.place), f.place), eff: mergeEff(c.eff, t.eff, f.eff) };
      }

      case "Match": return this.inferMatch(e);

      case "Let": {
        const v = this.infer(e.value);
        if (e.ann) {
          unify(v.ty, this.resolveType(e.ann, new Map()));
          this.checkPlacement(annotatedPlace(e.ann), v.place, e.ann.span, `'${e.name}'`);
        }
        const envVars = new Set<number>();
        for (const s of this.env.values()) for (const x of freeVars(s.ty)) envVars.add(x);
        const gen = generalize(v.ty, envVars);
        const saved = this.env;
        this.env = new Map(saved);
        this.env.set(e.name, { ty: gen, envVars, place: v.place });
        const scope = this.infer(e.body);
        this.env = saved;
        return { ty: scope.ty, place: joinPlace(v.place, scope.place), eff: mergeEff(v.eff, scope.eff) };
      }

      case "Record": {
        const fields: Record<string, Type> = {};
        let place: Place = "neutral";
        let eff = emptyEff();
        for (const f of e.fields) {
          const r = this.infer(f.value);
          fields[f.name] = r.ty;
          place = joinPlace(place, r.place);
          eff = mergeEff(eff, r.eff);
        }
        return { ty: { k: "rec", fields }, place, eff };
      }

      case "Field": {
        const qn = this.qualName(e.target);
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
          this.fail(`Cell has no field '${e.name}' (use .get() or .set(value))`, e.span);
        }
        const t = prune(target.ty);
        let ty: Type;
        if (t.k === "var") {
          ty = fresh(0);
          unify(t, { k: "rec", fields: { [e.name]: ty }, open: true });
        } else if (t.k === "rec") {
          const f = t.fields[e.name];
          if (!f) this.fail(`record has no field '${e.name}'`, e.span);
          ty = f;
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
          unify(r.ty, el);
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
        if (c && c.arity > 0) {
          if (e.args.length !== c.arity) this.fail(`constructor ${e.name} expects ${c.arity} argument(s)`, e.span);
          const inst = instantiate(c.scheme, 0);
          if (inst.k === "fun") {
            e.args.forEach((a, i) => {
              const r = this.infer(a);
              unify(r.ty, inst.params[i]!);
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

      case "Block": {
        const saved = this.env;
        this.env = new Map(saved);
        let place: Place = "neutral";
        let eff = emptyEff();
        for (const s of e.stmts) {
          if (s.k === "LetStmt") {
            const v = this.infer(s.value);
            if (s.ann) {
              unify(v.ty, this.resolveType(s.ann, new Map()));
              this.checkPlacement(annotatedPlace(s.ann), v.place, s.ann.span, `'${s.name}'`);
            }
            this.env.set(s.name, { ty: v.ty, envVars: new Set(), place: v.place });
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

  qualName(e: Expr): string | null {
    if (e.k === "Var") return e.name;
    if (e.k === "Ctor" && e.args.length === 0) return e.name;
    return null;
  }

  inferApp(e: Expr & { k: "App" }): ResInfo {
    // Method-call syntax: `receiver.method(args)` dispatches to a trait method
    // when the receiver is not a record with a field of that name. Cell.get /
    // Cell.set are just `CellOps` methods under this rule — no compiler special
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
          const r = this.infer(a);
          unify(r.ty, inst.params[i]!);
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

    const fnInfo = this.infer(e.fn);
    const ft = prune(fnInfo.ty);
    if (ft.k !== "fun") this.fail(`attempt to call a value of type ${typeStr(ft)}`, e.fn.span);
    if (e.args.length !== ft.params.length) this.fail(`expected ${ft.params.length} argument(s), got ${e.args.length}`, e.span);

    // Direct calls to a named function can check annotated parameter placements.
    const callee = e.fn.k === "Var" && !this.env.has(e.fn.name) ? this.mod.fns.get(e.fn.name) : undefined;
    let place = joinPlace(fnInfo.place, typePlace(ft));
    let eff = mergeEff(fnInfo.eff, ft.eff);
    e.args.forEach((a, i) => {
      const r = this.infer(a);
      try { unify(r.ty, ft.params[i]!); }
      catch (err) {
        if (err instanceof FlowError) this.fail(`${err.message}\n  in argument ${i + 1}`, a.span);
        throw err;
      }
      const expected = callee?.paramPlaces?.[i];
      if (expected) {
        this.checkPlacement(expected, this.exprPlace(a, r.place), a.span, `argument ${i + 1} to ${callee!.name}`);
      }
      place = joinPlace(place, r.place);
      eff = mergeEff(eff, r.eff);
    });
    return { ty: ft.ret, place: joinPlace(place, placeFromEffects(eff, this)), eff };
  }

  inferTraitCall(traitName: string, method: string, schemeTy: Type, args: Expr[], node: object): ResInfo {
    const inst = instantiate(schemeTy, 0);
    if (inst.k !== "fun") this.fail(`${traitName}.${method} is not callable`);
    if (args.length !== inst.params.length) this.fail(`${traitName}.${method} expects ${inst.params.length} argument(s)`);
    // A trait method may declare effects; they participate in placement exactly
    // like a function's declared row (CellOps declares `! Client`).
    let place: Place = placeFromEffects(inst.eff, this);
    let eff: Eff = { labels: new Set(inst.eff.labels) };
    args.forEach((a, i) => {
      const r = this.infer(a);
      unify(r.ty, inst.params[i]!);
      place = joinPlace(place, r.place);
      eff = mergeEff(eff, r.eff);
    });
    const target = prune(inst.params[0] ?? fresh());
    const impl = this.resolveImpl(traitName, target);
    if (!impl) this.fail(`no instance of ${traitName} for ${typeStr(target)}`);
    this.mod.info.set(node, { ty: inst.ret, place, eff });
    this.mod.implChoices.set(node, { impl, method, mangled: impl.mangled.get(method)! });
    return { ty: inst.ret, place, eff };
  }

  resolveImpl(trait: string, target: Type): ImplInfo | null {
    for (const im of this.mod.impls) {
      if (im.trait !== trait) continue;
      const before = snapshotSubst();
      try {
        const vars = new Map<string, Type>();
        const t = this.resolveType(im.target, vars);
        unify(t, target);
        return im;
      } catch {
        restoreSubst(before);
      }
    }
    return null;
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
      unify(b.ty, result);
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
    return arms.some((a) => a.pat.k === "PWild" || a.pat.k === "PVar");
  }

  bindPattern(p: Pattern, ty: Type, seen: Set<string>) {
    switch (p.k) {
      case "PWild": return;
      case "PVar": this.env.set(p.name, { ty, envVars: new Set(), place: "neutral" }); return;
      case "PLit": {
        const lt = p.lit.k === "Int" ? INT : p.lit.k === "Str" ? STR : BOOL;
        unify(ty, lt); return;
      }
      case "PTuple": {
        const items = p.items.map(() => fresh(0));
        unify(ty, { k: "tuple", items });
        p.items.forEach((q, i) => this.bindPattern(q, items[i]!, seen));
        return;
      }
      case "PRecord": {
        const fields: Record<string, Type> = {};
        for (const f of p.fields) fields[f.name] = fresh(0);
        unify(ty, { k: "rec", fields, open: true });
        for (const f of p.fields) this.bindPattern(f.pat, fields[f.name]!, seen);
        return;
      }
      case "PList": {
        const el = fresh(0);
        unify(ty, listOf(el));
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
        unify(ty, result);
        if (p.args.length !== argTypes.length) this.fail(`constructor ${p.name} expects ${argTypes.length} pattern argument(s)`, p.span);
        p.args.forEach((q, i) => this.bindPattern(q, argTypes[i]!, seen));
        return;
      }
    }
  }

  inferBinary(e: Expr & { k: "Binary" }): ResInfo {
    const l = this.infer(e.l);
    const r = this.infer(e.r);
    const op = e.op;
    const place = joinPlace(l.place, r.place);
    const eff = mergeEff(l.eff, r.eff);

    if (op === "and" || op === "or" || op === "&&" || op === "||") {
      this.expectType(l.ty, BOOL, e.l, `operand of ${op}`);
      this.expectType(r.ty, BOOL, e.r, `operand of ${op}`);
      return { ty: BOOL, place, eff };
    }
    if (op === "==" || op === "!=") {
      unify(l.ty, r.ty);
      return { ty: BOOL, place, eff };
    }
    if (["<", "<=", ">", ">="].includes(op)) {
      const lt = prune(l.ty);
      if (lt.k === "con" && lt.name === "Float") unify(r.ty, FLOAT);
      else if (lt.k === "con" && lt.name === "Str") unify(r.ty, STR);
      else { unify(l.ty, INT); unify(r.ty, INT); }
      return { ty: BOOL, place, eff };
    }
    if (op === "+") {
      const lt = prune(l.ty);
      if (lt.k === "con" && lt.name === "Str") { unify(r.ty, STR); return { ty: STR, place, eff }; }
      if (lt.k === "con" && lt.name === "Float") { unify(r.ty, FLOAT); return { ty: FLOAT, place, eff }; }
      unify(l.ty, INT); unify(r.ty, INT);
      return { ty: INT, place, eff };
    }
    if (["-", "*", "/", "%"].includes(op)) {
      const lt = prune(l.ty);
      if (lt.k === "con" && lt.name === "Float") { unify(r.ty, FLOAT); return { ty: FLOAT, place, eff }; }
      unify(l.ty, INT); unify(r.ty, INT);
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
              unify(r.ty, fnT([con("Event")], UNIT));
            } else if (a.name === "class" || a.name === "style" || a.name === "id" || a.name === "type" ||
                       a.name === "placeholder" || a.name === "href" || a.name === "value" || a.name === "title") {
              unify(r.ty, STR);
            } else {
              unify(prune(r.ty).k === "con" && prune(r.ty).name === "Bool" ? r.ty : STR, r.ty);
              unify(r.ty, STR);
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

  expectType(got: Type, want: Type, node: Expr, what: string) {
    try { unify(got, want); }
    catch (err) {
      if (err instanceof FlowError) this.fail(`${what}: ${err.message}`, node.span);
      throw err;
    }
  }
}

export function mergeEff(...rows: Eff[]): Eff {
  const out: Eff = { labels: new Set() };
  for (const r of rows) for (const l of r.labels) out.labels.add(l);
  return out;
}

export function placeFromEffects(eff: Eff, inf: Infer): Place {
  let p: Place = "neutral";
  for (const l of eff.labels) {
    // Every effect carries its own placement (declared `@ client`/`@ server`, or
    // the provider's), so there is no name-based special casing here.
    const e = inf.mod.effects.get(l);
    if (e) p = joinPlace(p, e.place);
  }
  return p;
}

export { fresh, prune, typeStr };

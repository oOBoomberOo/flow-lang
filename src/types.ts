/**
 * Flow — semantic types, unification, effect rows and the placement lattice.
 *
 * Theoretical reference: docs/type-system.md
 *   Γ ⊢ e : τ ! ε @ p        (expression e has type τ, effect row ε, placement p)
 */

import { FlowError } from "./lexer.ts";

export type Place = "neutral" | "client" | "server" | "cross";

export interface TVar { k: "var"; id: number; level: number; generic?: boolean; bounds?: string[]; origin?: number }
export interface TCon { k: "con"; name: string; args: Type[] }
/** A higher-kinded application: `f<a>` where `f` is a type constructor. */
export interface TApp { k: "app"; fn: Type; args: Type[] }
export interface TFun { k: "fun"; params: Type[]; ret: Type; eff: Eff }
export interface TRec {
  k: "rec";
  fields: Record<string, Type>;
  /** This value may carry fields beyond the ones listed (a call-site record). */
  open?: boolean;
  /** Every listed field must exist on the other record (a field-access bound). */
  atLeast?: boolean;
}
export interface TTuple { k: "tuple"; items: Type[] }
export type Type = TVar | TCon | TApp | TFun | TRec | TTuple;

export interface Eff { labels: Set<string>; tail?: number }

export const emptyEff = (): Eff => ({ labels: new Set() });

let nextId = 1;
export function resetIds() { nextId = 1; }
export function fresh(level = 0): TVar { return { k: "var", id: nextId++, level }; }

/* ------------------------------------------------------------------ */
/* placement lattice                                                   */
/* ------------------------------------------------------------------ */

/** neutral ⊑ client, neutral ⊑ server, client ⊔ server = cross */
export function joinPlace(a: Place, b: Place): Place {
  if (a === "neutral") return b;
  if (b === "neutral") return a;
  if (a === b) return a;
  return "cross";
}

export function placeName(p: Place): string {
  return p;
}

/** Types that can only exist in one place. Anything else is place-neutral. */
// Html/Event are DOM values; Dom is a handle. A Cell is neutral: it may live on
// either side and its value crosses the boundary as an ordinary cut.
const PLACED_TYPES: Record<string, Place> = {
  Html: "client",
  Event: "client",
  Dom: "client",
};
export function typePlace(t: Type): Place {
  const p = prune(t);
  if (p.k === "con") {
    const own = PLACED_TYPES[p.name];
    if (own) return own;
    // a container of a placed type is itself placed
    for (const a of p.args) {
      const q = typePlace(a);
      if (q !== "neutral") return q;
    }
  }
  if (p.k === "tuple") {
    for (const i of p.items) { const q = typePlace(i); if (q !== "neutral") return q; }
  }
  if (p.k === "app") {
    const q = typePlace(p.fn);
    if (q !== "neutral") return q;
    for (const a of p.args) { const r = typePlace(a); if (r !== "neutral") return r; }
  }
  if (p.k === "rec") {
    for (const f of Object.values(p.fields)) { const q = typePlace(f); if (q !== "neutral") return q; }
  }
  return "neutral";
}

/** Values of placed types cannot cross the boundary. */
export function sendable(t: Type): { ok: true } | { ok: false; reason: string } {
  const p = prune(t);
  switch (p.k) {
    case "var": return { ok: true };
    case "fun": return { ok: false, reason: "functions are not serializable across the boundary" };
    case "con": {
      if (p.name === "Cell") return { ok: false, reason: "Cell<a> is client-local reactive state" };
      if (p.name === "Dom") return { ok: false, reason: "Dom handles cannot leave the client" };
      if (p.name === "Event") return { ok: false, reason: "Event handles cannot leave the client" };
      if (p.name === "Html") return { ok: false, reason: "Html can only be produced on the client" };
      for (const a of p.args) { const r = sendable(a); if (!r.ok) return r; }
      return { ok: true };
    }
    case "app": {
      const fn = prune(p.fn);
      if (fn.k === "con" && fn.args.length === 0) {
        return sendable({ k: "con", name: fn.name, args: p.args });
      }
      return { ok: true };
    }
    case "tuple": {
      for (const i of p.items) { const r = sendable(i); if (!r.ok) return r; }
      return { ok: true };
    }
    case "rec": {
      for (const f of Object.values(p.fields)) { const r = sendable(f); if (!r.ok) return r; }
      return { ok: true };
    }
  }
}

/* ------------------------------------------------------------------ */
/* unification                                                         */
/* ------------------------------------------------------------------ */

export function prune(t: Type): Type {
  if (t.k === "var" && subst.has(t.id)) {
    const r = prune(subst.get(t.id)!);
    subst.set(t.id, r);
    return r;
  }
  if (t.k === "app") {
    const fn = prune(t.fn);
    const args = t.args.map((a) => prune(a));
    // `List<Int>` is represented as a constructor application until the
    // constructor is known; once it is, normalize to an ordinary TCon.
    if (fn.k === "con" && fn.args.length === 0) {
      return { k: "con", name: fn.name, args };
    }
    if (fn === t.fn && args.every((a, i) => a === t.args[i])) return t;
    return { k: "app", fn, args };
  }
  return t;
}

const subst = new Map<number, Type>();
export function resetSubst() { subst.clear(); }
/** Size of the live unification state (regression test: it must not grow per compile). */
export function substSize(): number { return subst.size; }
export function snapshotSubst(): Map<number, Type> { return new Map(subst); }
export function restoreSubst(m: Map<number, Type>) { subst.clear(); for (const [k, v] of m) subst.set(k, v); }

/** Mark every free unification variable of `t` as generic. */
export function markGeneric(t: Type): void {
  const p = prune(t);
  if (p.k === "var") { p.generic = true; return; }
  mapType(p, (x) => { const q = prune(x); if (q.k === "var") q.generic = true; return q; });
}

export class UnifyError extends FlowError {
  constructor(msg: string) { super(msg, { code: "E_TYPE" }); }
}

const tErr = (msg: string): never => { throw new UnifyError(msg); };

export function occurs(id: number, t: Type): boolean {
  const p = prune(t);
  switch (p.k) {
    case "var": return p.id === id;
    case "con": return p.args.some((a) => occurs(id, a));
    case "app": return occurs(id, p.fn) || p.args.some((a) => occurs(id, a));
    case "fun": return p.params.some((a) => occurs(id, a)) || occurs(id, p.ret);
    case "rec": return Object.values(p.fields).some((f) => occurs(id, f));
    case "tuple": return p.items.some((i) => occurs(id, i));
  }
}

export function unify(a: Type, b: Type): void {
  const x = prune(a), y = prune(b);
  if (x === y) return;
  if (x.k === "var") {
    if (occurs(x.id, y)) { const [a, b] = typeStrs([x, y]); tErr(`infinite type: ${a} = ${b}`); }
    // A bound survives unification with another type variable so the call site
    // can still find (or pass) a dictionary for it.
    if (y.k === "var" && x.bounds?.length) {
      y.bounds = [...new Set([...(y.bounds ?? []), ...x.bounds])];
      if (y.origin === undefined) y.origin = x.origin ?? x.id;
    }
    bind(x.id, y);
    return;
  }
  if (y.k === "var") {
    if (occurs(y.id, x)) { const [a, b] = typeStrs([x, y]); tErr(`infinite type: ${a} = ${b}`); }
    bind(y.id, x);
    return;
  }
  if (x.k === "app" || y.k === "app") {
    if (x.k === "app" && y.k === "app") {
      unify(x.fn, y.fn);
      if (x.args.length !== y.args.length) {
        { const [a, b] = typeStrs([x, y]); tErr(`type constructor arity mismatch: ${a} vs ${b}`); }
      }
      for (let i = 0; i < x.args.length; i++) unify(x.args[i]!, y.args[i]!);
      return;
    }
    const app = x.k === "app" ? x : (y as TApp);
    const con = x.k === "con" ? x : (y.k === "con" ? y : undefined);
    if (con) {
      const fn = prune(app.fn);
      if (fn.k === "var") {
        if (occurs(fn.id, con)) { const [a, b] = typeStrs([fn, con]); tErr(`infinite type: ${a} = ${b}`); }
        bind(fn.id, { k: "con", name: con.name, args: [] });
        return unify({ k: "con", name: con.name, args: app.args }, con);
      }
      if (fn.k === "con" && fn.args.length === 0) {
        return unify({ k: "con", name: fn.name, args: app.args }, con);
      }
    }
    { const [a, b] = typeStrs([x, y]); tErr(`type mismatch: ${a} vs ${b}`); }
  }
  if (x.k === "fun" && y.k === "fun") {
    if (x.params.length !== y.params.length) {
      // a -> b -> c and a -> (b -> c) are the same curried function type
      const [short, long] = x.params.length < y.params.length ? [x, y] : [y, x];
      if (short.params.length === 0) { const [a, b] = typeStrs([x, y]); tErr(`function arity mismatch: ${a} vs ${b}`); }
      const n = short.params.length;
      for (let i = 0; i < n; i++) unify(short.params[i]!, long.params[i]!);
      unify(short.ret, { k: "fun", params: long.params.slice(n), ret: long.ret, eff: long.eff });
      unifyEff(short.eff, long.eff);
      return;
    }
    for (let i = 0; i < x.params.length; i++) unify(x.params[i]!, y.params[i]!);
    unify(x.ret, y.ret);
    unifyEff(x.eff, y.eff);
    return;
  }
  if (x.k === "con" && y.k === "con") {
    if (x.name !== y.name) { const [a, b] = typeStrs([x, y]); tErr(`type mismatch: ${a} vs ${b}`); }
    if (x.args.length !== y.args.length) { const [a, b] = typeStrs([x, y]); tErr(`type arity mismatch: ${a} vs ${b}`); }
    for (let i = 0; i < x.args.length; i++) unify(x.args[i]!, y.args[i]!);
    return;
  }
  if (x.k === "rec" && y.k === "rec") {
    // Two different partial records can meet here:
    //  * `open` marks a real value that may have fields beyond those listed
    //    (a component call site supplies at least its attributes + children);
    //  * `atLeast` marks a requirement created by field access or a record
    //    pattern: whatever the value is, it must have these fields.
    // A requirement is checked against the actual record's fields; a plain
    // record is exact, so two exact records must match in both directions.
    const actualOf = (t: TRec) => t.open === true;
    const checkFields = (req: TRec, actual: TRec) => {
      for (const k of Object.keys(req.fields)) {
        if (!(k in actual.fields)) tErr(`record mismatch: field '${k}' is missing in ${typeStr(actual)}`);
        unify(req.fields[k]!, actual.fields[k]!);
      }
    };
    if (x.atLeast && y.atLeast) {
      // Two constraints on the same value accumulate: keep both field sets.
      for (const k of Object.keys(y.fields)) if (!(k in x.fields)) x.fields[k] = y.fields[k]!;
      for (const k of Object.keys(x.fields)) if (!(k in y.fields)) y.fields[k] = x.fields[k]!;
      for (const k of Object.keys(x.fields)) unify(x.fields[k]!, y.fields[k]!);
      return;
    }
    if (x.atLeast) {
      checkFields(x, y);
      return;
    }
    if (y.atLeast) {
      checkFields(y, x);
      return;
    }
    if (actualOf(x) && actualOf(y)) {
      for (const k of Object.keys(x.fields)) if (k in y.fields) unify(x.fields[k]!, y.fields[k]!);
    } else if (actualOf(x)) {
      checkFields(y, x);
    } else if (actualOf(y)) {
      checkFields(x, y);
    } else {
      checkFields(x, y);
      checkFields(y, x);
    }
    return;
  }
  if (x.k === "tuple" && y.k === "tuple") {
    if (x.items.length !== y.items.length) { const [a, b] = typeStrs([x, y]); tErr(`tuple arity mismatch: ${a} vs ${b}`); }
    for (let i = 0; i < x.items.length; i++) unify(x.items[i]!, y.items[i]!);
    return;
  }
  { const [a, b] = typeStrs([x, y]); tErr(`type mismatch: ${a} vs ${b}`); }
}

function bind(id: number, t: Type) {
  if (t.k === "var" && t.id === id) return;
  subst.set(id, t);
}

export function unifyEff(a: Eff, b: Eff): void {
  // Effect rows accumulate monotonically: a call site inherits the union.
  // (Declared rows are checked as upper bounds in Infer.checkNamedBody.)
  for (const l of b.labels) a.labels.add(l);
  for (const l of a.labels) b.labels.add(l);
}

/** Mark every free unification variable of `t` that is not bound in the
 *  environment as generic (let-polymorphism). */
export function generalize(t: Type, envVars: Set<number>): Type {
  const p = prune(t);
  if (p.k === "var") {
    if (!envVars.has(p.id)) p.generic = true;
    return p;
  }
  return mapType(p, (x) => generalize(x, envVars));
}

/** Replace generic variables with fresh ones. `trace` records the mapping from
 *  each generalized variable to its fresh instantiation (for dictionaries). */
export function instantiate(t: Type, level: number, trace?: Map<number, Type>): Type {
  const mapping = new Map<number, Type>();
  const go = (x: Type): Type => {
    const p = prune(x);
    if (p.k === "var") {
      if (p.generic) {
        if (!mapping.has(p.id)) {
          const v = fresh(level);
          if (p.bounds) v.bounds = [...p.bounds];
          if (p.bounds?.length) v.origin = p.origin ?? p.id;
          mapping.set(p.id, v);
          if (trace) trace.set(p.id, v);
        }
        return mapping.get(p.id)!;
      }
      return p;
    }
    return mapType(p, go);
  };
  return go(t);
}

export function mapType(t: Type, f: (t: Type) => Type): Type {
  const p = prune(t);
  switch (p.k) {
    case "var": return f(p);
    case "con": return { k: "con", name: p.name, args: p.args.map((a) => mapType(a, f)) };
    case "app": return { k: "app", fn: mapType(p.fn, f), args: p.args.map((a) => mapType(a, f)) };
    case "fun": return {
      k: "fun",
      params: p.params.map((a) => mapType(a, f)),
      ret: mapType(p.ret, f),
      // Effect rows are per-instantiation: cloning prevents one call site's
      // unification from leaking labels into every other use of the scheme.
      eff: { labels: new Set(p.eff.labels), ...(p.eff.tail !== undefined ? { tail: p.eff.tail } : {}) },
    };
    case "rec": {
      const fields: Record<string, Type> = {};
      for (const [k, v] of Object.entries(p.fields)) fields[k] = mapType(v, f);
      // Partial records must stay partial through generalization/instantiation;
      // turning one into an exact record would reject the real value it meets.
      const out: TRec = { k: "rec", fields };
      if (p.open) out.open = true;
      if (p.atLeast) out.atLeast = true;
      return out;
    }
    case "tuple": return { k: "tuple", items: p.items.map((i) => mapType(i, f)) };
  }
}

/** True when the type mentions a generalized (scheme) variable. */
export function hasGeneric(t: Type): boolean {
  const p = prune(t);
  switch (p.k) {
    case "var": return Boolean(p.generic);
    case "con": return p.args.some(hasGeneric);
    case "app": return hasGeneric(p.fn) || p.args.some(hasGeneric);
    case "fun": return p.params.some(hasGeneric) || hasGeneric(p.ret);
    case "rec": return Object.values(p.fields).some(hasGeneric);
    case "tuple": return p.items.some(hasGeneric);
  }
}

export function freeVars(t: Type, acc = new Set<number>()): Set<number> {
  const p = prune(t);
  switch (p.k) {
    case "var": acc.add(p.id); break;
    case "con": p.args.forEach((a) => freeVars(a, acc)); break;
    case "app": freeVars(p.fn, acc); p.args.forEach((a) => freeVars(a, acc)); break;
    case "fun": p.params.forEach((a) => freeVars(a, acc)); freeVars(p.ret, acc); break;
    case "rec": Object.values(p.fields).forEach((a) => freeVars(a, acc)); break;
    case "tuple": p.items.forEach((a) => freeVars(a, acc)); break;
  }
  return acc;
}

/* ------------------------------------------------------------------ */
/* printing                                                           */
/* ------------------------------------------------------------------ */

/** A type argument needs parentheses when it is itself a function or a tuple. */
function typeArg(t: Type, names: Map<number, string>, raw: boolean): string {
  const p = prune(t);
  const s = typeStr(p, names, raw);
  return p.k === "fun" || p.k === "rec" ? `(${s})` : s;
}

/** `a`, `b`, ..., `z`, `a1`, `b1`, ... in first-seen order. */
function typeVarName(index: number): string {
  const letter = String.fromCharCode(97 + (index % 26));
  const round = Math.floor(index / 26);
  return round === 0 ? letter : `${letter}${round}`;
}

/**
 * Render a type for humans. Unification variables are named `a`, `b`, ... in
 * first-seen order instead of leaking compiler ids (`t429`). Pass a shared
 * `names` map (or use `typeStrs`) when several types appear in one message, so
 * variables keep distinct names across them.
 *
 * `raw` keeps the `t<id>` form for identity checks that compare printed types.
 */
export function typeStr(t: Type, names: Map<number, string> = new Map(), raw = false): string {
  const p = prune(t);
  switch (p.k) {
    case "var": {
      if (raw) return `t${p.id}`;
      let name = names.get(p.id);
      if (!name) {
        name = typeVarName(names.size);
        names.set(p.id, name);
      }
      return name;
    }
    case "con": return p.args.length ? `${p.name} ${p.args.map((a) => typeArg(a, names, raw)).join(" ")}` : p.name;
    case "app": return `${typeStr(p.fn, names, raw)} ${p.args.map((a) => typeArg(a, names, raw)).join(" ")}`;
    case "fun": {
      const eff = p.eff.labels.size ? ` ! {${[...p.eff.labels].join(", ")}}` : "";
      return `${p.params.map((a) => typeArg(a, names, raw)).join(" -> ")} -> ${typeStr(p.ret, names, raw)}${eff}`;
    }
    case "rec": return `{ ${Object.entries(p.fields).map(([k, v]) => `${k} :: ${typeStr(v, names, raw)}`).join(", ")} }`;
    case "tuple": return `(${p.items.map((i) => typeStr(i, names, raw)).join(", ")})`;
  }
}

/** Several types in one message, sharing one set of variable names. */
export function typeStrs(types: Type[]): string[] {
  const names = new Map<number, string>();
  return types.map((t) => {
    const p = prune(t);
    const s = typeStr(p, names);
    // `a -> b vs Option c` would read ambiguously; keep comparisons grouped.
    return p.k === "fun" || p.k === "rec" ? `(${s})` : s;
  });
}

/** A stable printed form for comparing two types; variables keep their ids. */
export function typeKey(t: Type): string {
  return typeStr(t, new Map(), true);
}

export function effStr(e: Eff): string {
  return e.labels.size ? `{${[...e.labels].sort().join(", ")}}` : "{}";
}

/* helpers */

export const con = (name: string, ...args: Type[]): TCon => ({ k: "con", name, args });
export const INT = con("Int");
export const FLOAT = con("Float");
export const STR = con("Str");
export const BOOL = con("Bool");
export const UNIT = con("Unit");
export const HTML = con("Html");
export const fnT = (params: Type[], ret: Type, eff: Eff = emptyEff()): TFun => ({ k: "fun", params, ret, eff });
export const listOf = (t: Type): TCon => con("List", t);
export const optionOf = (t: Type): TCon => con("Option", t);
export const cellOf = (t: Type): TCon => con("Cell", t);
export const eventOf = (t: Type): TCon => con("Event", t);

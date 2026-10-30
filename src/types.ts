/**
 * Flow — semantic types, unification, effect rows and the placement lattice.
 *
 * Theoretical reference: docs/type-system.md
 *   Γ ⊢ e : τ ! ε @ p        (expression e has type τ, effect row ε, placement p)
 */

import { FlowError } from "./lexer.ts";

export type Place = "neutral" | "client" | "server" | "cross";

export interface TVar { k: "var"; id: number; level: number; generic?: boolean }
export interface TCon { k: "con"; name: string; args: Type[] }
export interface TFun { k: "fun"; params: Type[]; ret: Type; eff: Eff }
export interface TRec { k: "rec"; fields: Record<string, Type>; open?: boolean }
export interface TTuple { k: "tuple"; items: Type[] }
export type Type = TVar | TCon | TFun | TRec | TTuple;

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
const PLACED_TYPES: Record<string, Place> = {
  Html: "client",
  Event: "client",
  Cell: "client",
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
  return t;
}

const subst = new Map<number, Type>();
export function resetSubst() { subst.clear(); }
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
    case "fun": return p.params.some((a) => occurs(id, a)) || occurs(id, p.ret);
    case "rec": return Object.values(p.fields).some((f) => occurs(id, f));
    case "tuple": return p.items.some((i) => occurs(id, i));
  }
}

export function unify(a: Type, b: Type): void {
  const x = prune(a), y = prune(b);
  if (x === y) return;
  if (x.k === "var") {
    if (occurs(x.id, y)) tErr(`infinite type: ${typeStr(x)} = ${typeStr(y)}`);
    bind(x.id, y);
    return;
  }
  if (y.k === "var") {
    if (occurs(y.id, x)) tErr(`infinite type: ${typeStr(x)} = ${typeStr(y)}`);
    bind(y.id, x);
    return;
  }
  if (x.k === "fun" && y.k === "fun") {
    if (x.params.length !== y.params.length) {
      tErr(`function arity mismatch: ${typeStr(x)} vs ${typeStr(y)}`);
    }
    for (let i = 0; i < x.params.length; i++) unify(x.params[i]!, y.params[i]!);
    unify(x.ret, y.ret);
    unifyEff(x.eff, y.eff);
    return;
  }
  if (x.k === "con" && y.k === "con") {
    if (x.name !== y.name) tErr(`type mismatch: ${typeStr(x)} vs ${typeStr(y)}`);
    if (x.args.length !== y.args.length) tErr(`type arity mismatch: ${typeStr(x)} vs ${typeStr(y)}`);
    for (let i = 0; i < x.args.length; i++) unify(x.args[i]!, y.args[i]!);
    return;
  }
  if (x.k === "rec" && y.k === "rec") {
    // An `open` record is a lower bound (the fields a call site supplies).
    const check = (closed: TRec, open: TRec) => {
      for (const k of Object.keys(closed.fields)) {
        if (!(k in open.fields)) tErr(`record mismatch: field '${k}' is missing in ${typeStr(open)}`);
        unify(closed.fields[k]!, open.fields[k]!);
      }
    };
    if (x.open && y.open) {
      for (const k of Object.keys(x.fields)) if (k in y.fields) unify(x.fields[k]!, y.fields[k]!);
    } else if (x.open) {
      check(y, x);
    } else if (y.open) {
      check(x, y);
    } else {
      check(x, y);
      check(y, x);
    }
    return;
  }
  if (x.k === "tuple" && y.k === "tuple") {
    if (x.items.length !== y.items.length) tErr(`tuple arity mismatch: ${typeStr(x)} vs ${typeStr(y)}`);
    for (let i = 0; i < x.items.length; i++) unify(x.items[i]!, y.items[i]!);
    return;
  }
  tErr(`type mismatch: ${typeStr(x)} vs ${typeStr(y)}`);
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

/** Replace generic variables with fresh ones. */
export function instantiate(t: Type, level: number): Type {
  const mapping = new Map<number, Type>();
  const go = (x: Type): Type => {
    const p = prune(x);
    if (p.k === "var") {
      if (p.generic) {
        if (!mapping.has(p.id)) mapping.set(p.id, fresh(level));
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
      return { k: "rec", fields };
    }
    case "tuple": return { k: "tuple", items: p.items.map((i) => mapType(i, f)) };
  }
}

export function freeVars(t: Type, acc = new Set<number>()): Set<number> {
  const p = prune(t);
  switch (p.k) {
    case "var": acc.add(p.id); break;
    case "con": p.args.forEach((a) => freeVars(a, acc)); break;
    case "fun": p.params.forEach((a) => freeVars(a, acc)); freeVars(p.ret, acc); break;
    case "rec": Object.values(p.fields).forEach((a) => freeVars(a, acc)); break;
    case "tuple": p.items.forEach((a) => freeVars(a, acc)); break;
  }
  return acc;
}

/* ------------------------------------------------------------------ */
/* printing                                                           */
/* ------------------------------------------------------------------ */

export function typeStr(t: Type): string {
  const p = prune(t);
  switch (p.k) {
    case "var": return `t${p.id}`;
    case "con": return p.args.length ? `${p.name}<${p.args.map(typeStr).join(", ")}>` : p.name;
    case "fun": {
      const eff = p.eff.labels.size ? ` ! {${[...p.eff.labels].join(", ")}}` : "";
      return `(${p.params.map(typeStr).join(", ")}) -> ${typeStr(p.ret)}${eff}`;
    }
    case "rec": return `{ ${Object.entries(p.fields).map(([k, v]) => `${k}: ${typeStr(v)}`).join(", ")} }`;
    case "tuple": return `(${p.items.map(typeStr).join(", ")})`;
  }
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

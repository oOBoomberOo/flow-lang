/**
 * Migration support: rewrite a program parsed by the legacy (Rust-style) parser
 * into the *shape the new parser produces*. The printer then emits Haskell-style
 * source for it, and the round-trip tests compare against this canonical AST.
 *
 * What changes:
 *  - there are no nullary functions: `() -> a` is `Unit -> a`, `f()` is `f ()`
 *    (a nullary top-level `main` stays a constant)
 *  - blocks keep their last expression as the value; `{ e }` is just `e`
 *  - `not`/`and`/`or` are an ordinary function and `&&` / `||`
 *  - `x++` / `x--` become `x += 1` / `x -= 1`
 *  - qualified `a::b::c` paths become module-qualified `B.c`
 *  - lambda return annotations disappear (they are inferred)
 *  - instance / provider / handler members drop their signatures
 */

import type {
  Decl, Expr, FnSig, HtmlNode, MatchArm, Param, Pattern, Program, Span, Stmt, TypeExpr,
} from "../ast.ts";

export interface CanonOptions {
  /** name of the package the file belongs to (its own modules need no prefix) */
  pkg?: string;
}

const cap = (s: string) => s.split(/[-_]/).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");

/** `std::list` -> `List`, `app::util::x` -> `Util`, `flow-charts::bar` -> `FlowCharts.Bar`. */
export function modulePathFromLegacy(path: string[], pkg?: string): string[] {
  const [first, ...rest] = path;
  if (!first) return [];
  if (first === "std") return rest.map(cap);
  if (first === pkg) return rest.map(cap);
  return [cap(first), ...rest.map(cap)];
}

const unitT = (span: Span): TypeExpr => ({ k: "TCon", name: "Unit", args: [], span });
const wild = (span: Span): TypeExpr => ({ k: "TVar", name: "_", span });

export function canonProgram(p: Program, opts: CanonOptions = {}): Program {
  const c = new Canon(opts);
  return { ...p, decls: p.decls.map((d) => c.decl(d)) };
}

class Canon {
  opts: CanonOptions;
  constructor(opts: CanonOptions) { this.opts = opts; }

  /* ---------- names ---------- */

  /** `std::list::map` -> { mod: ["List"], name: "map" } */
  private qual(name: string): { mod: string[]; name: string } | null {
    if (!name.includes("::")) return null;
    const parts = name.split("::");
    const last = parts.pop()!;
    return { mod: modulePathFromLegacy(parts, this.opts.pkg), name: last };
  }

  private typeName(name: string): string {
    const q = this.qual(name);
    return q ? [...q.mod, q.name].join(".") : name;
  }

  /* ---------- types ---------- */

  type(t: TypeExpr): TypeExpr {
    switch (t.k) {
      case "TVar": return t;
      case "TCon": return { ...t, name: this.typeName(t.name), args: t.args.map((a) => this.type(a)) };
      case "TFun": {
        const params = t.params.length ? t.params.map((p) => this.type(p)) : [unitT(t.span)];
        return { ...t, params, ret: this.type(t.ret) };
      }
      case "TRecord": return { ...t, fields: t.fields.map((f) => ({ ...f, type: this.type(f.type) })) };
      case "TTuple": return { ...t, items: t.items.map((i) => this.type(i)) };
      case "TPlaced": return { ...t, inner: this.type(t.inner) };
    }
  }

  private sig(s: FnSig): FnSig {
    const params: Param[] = s.params.length
      ? s.params.map((p, i) => ({ ...p, name: `a${i + 1}`, type: this.type(p.type) }))
      : [{ name: "a1", type: unitT(s.span), span: s.span }];
    return { ...s, params, ret: s.ret ? this.type(s.ret) : undefined, eff: s.eff ? { ...s.eff, written: true } : undefined };
  }

  /* ---------- declarations ---------- */

  decl(d: Decl): Decl {
    switch (d.k) {
      case "Use": {
        const legacy = d as Decl & { k: "Use" };
        // `use std::list::map` keeps its item; `use std::html::Card` is parsed as path+item
        return { ...legacy, path: modulePathFromLegacy(legacy.path, this.opts.pkg) };
      }
      case "Adt": return { ...d, variants: d.variants.map((v) => ({ ...v, args: v.args.map((a) => this.type(a)) })) };
      case "RecordType": return { ...d, fields: d.fields.map((f) => ({ ...f, type: this.type(f.type) })) };
      case "Alias": return { ...d, type: this.type(d.type) };
      case "Trait": return { ...d, methods: d.methods.map((m) => this.methodSig(m, d.params)) };
      case "Impl": {
        return {
          ...d,
          trait: this.typeName(d.trait),
          traitArgs: d.traitArgs.map((a) => this.type(a)),
          target: this.type(d.target),
          methods: d.methods.map((m) => this.implMethod(m)),
        };
      }
      case "Effect": return { ...d, ops: d.ops.map((o) => this.sig(o)) };
      case "Provide": return { ...d, effect: this.typeName(d.effect), target: d.target ? this.type(d.target) : undefined, ops: d.ops.map((o) => ({ ...o, fn: this.untypedLam(o.fn) })) };
      case "Extern": return { ...d, sig: this.sig(d.sig) };
      case "Fn": return this.fn(d);
    }
  }

  private methodSig(m: FnSig, classParams: string[]): FnSig {
    const s = this.sig(m);
    return { ...s, typeParams: (s.typeParams ?? []).filter((t) => !classParams.includes(t)) };
  }

  private implMethod(m: FnSig & { body: Expr }): FnSig & { body: Expr } {
    const params = m.params.length
      ? m.params.map((p) => ({ ...p, type: wild(p.span) }))
      : [{ name: "_u", type: unitT(m.span), span: m.span }];
    return { name: m.name, typeParams: [], params, span: m.span, body: this.expr(m.body) };
  }

  private fn(d: Decl & { k: "Fn" }): Decl {
    const isMain = d.name === "main" && d.params.length === 0;
    let params: Param[] = d.params.map((p) => ({ ...p, type: this.type(p.type) }));
    if (!params.length && !isMain) params = [{ name: "_u", type: unitT(d.span), span: d.span }];
    let ret = d.ret ? this.type(d.ret) : undefined;
    // without a result type there is no signature to print: let inference decide
    if (!d.ret) params = params.map((p) => ({ ...p, type: wild(p.span) }));
    if (!d.ret && d.params.length === 0 && !isMain) ret = undefined;
    return { ...d, params, ret, eff: d.eff ? { ...d.eff, written: true } : undefined, body: this.expr(d.body) };
  }

  private untypedLam(e: Expr): Expr {
    const x = this.expr(e);
    if (x.k !== "Lam") return x;
    return { ...x, params: x.params.map((p) => ({ ...p, type: p.type.k === "TCon" && p.type.name === "Unit" ? p.type : wild(p.span) })), ret: undefined, eff: undefined };
  }

  /* ---------- patterns ---------- */

  pat(p: Pattern): Pattern {
    switch (p.k) {
      // the legacy lexer read a lone `_` as an identifier
      case "PVar": return p.name === "_" ? { k: "PWild", span: p.span } : p;
      case "PCtor": return { ...p, name: this.typeName(p.name), args: p.args.map((a) => this.pat(a)) };
      case "PTuple": return { ...p, items: p.items.map((a) => this.pat(a)) };
      case "PList": return { ...p, items: p.items.map((a) => this.pat(a)) };
      case "PRecord": return { ...p, fields: p.fields.map((f) => ({ ...f, pat: this.pat(f.pat) })) };
      default: return p;
    }
  }

  /* ---------- expressions ---------- */

  private stmts(stmts: Stmt[], value: Expr | undefined, span: Span): Expr {
    const out: Stmt[] = stmts.map((s) =>
      s.k === "LetStmt"
        ? { ...s, mut: false, ann: s.ann ? this.type(s.ann) : undefined, value: this.expr(s.value) }
        : { ...s, e: this.expr(s.e) });
    let v = value ? this.expr(value) : undefined;
    if (!v) {
      const last = out[out.length - 1];
      if (last && last.k === "ExprStmt") { out.pop(); v = last.e; }
      else v = { k: "Lit", lit: { k: "Unit" }, span };
    }
    if (!out.length) return v;
    return { k: "Block", stmts: out, value: v, span };
  }

  expr(e: Expr): Expr {
    switch (e.k) {
      case "Lit": return e;
      case "Var": {
        const q = this.qual(e.name);
        if (!q) return e;
        return this.qualified(q.mod, q.name, e.span);
      }
      case "Lam": {
        const params: Param[] = e.params.length
          ? e.params.map((p) => ({ ...p, type: this.type(p.type) }))
          : [{ name: "_u", type: unitT(e.span), span: e.span }];
        return { ...e, params, ret: undefined, eff: undefined, body: this.expr(e.body) };
      }
      case "App": {
        const args = e.args.length ? e.args.map((a) => this.expr(a)) : [{ k: "Lit", lit: { k: "Unit" }, span: e.span } as Expr];
        const fn = this.expr(e.fn);
        // a qualified constructor was a variable to the legacy parser
        if (fn.k === "Ctor" && fn.args.length === 0) return { ...fn, args, span: e.span };
        return { ...e, fn, args };
      }
      case "If": return { ...e, cond: this.expr(e.cond), then: this.expr(e.then), else: this.expr(e.else) };
      case "Match":
        return { ...e, scrut: this.expr(e.scrut), arms: e.arms.map((a): MatchArm => ({ ...a, pat: this.pat(a.pat), guard: a.guard ? this.expr(a.guard) : undefined, body: this.expr(a.body) })) };
      case "Let": return { ...e, mut: false, ann: e.ann ? this.type(e.ann) : undefined, value: this.expr(e.value), body: this.expr(e.body) };
      case "Record": return { ...e, fields: e.fields.map((f) => ({ ...f, value: this.expr(f.value) })) };
      case "Field": return { ...e, target: this.expr(e.target) };
      case "Tuple": return { ...e, items: e.items.map((i) => this.expr(i)) };
      case "List": return { ...e, items: e.items.map((i) => this.expr(i)) };
      case "Ctor": {
        const name = this.typeName(e.name);
        return { ...e, name, args: e.args.map((a) => this.expr(a)) };
      }
      case "Binary": {
        const op = e.op === "and" ? "&&" : e.op === "or" ? "||" : e.op;
        return { ...e, op, l: this.expr(e.l), r: this.expr(e.r) };
      }
      case "Unary": {
        const inner = this.expr(e.e);
        if (e.op === "not" || e.op === "!") {
          return { k: "App", fn: { k: "Var", name: "not", span: e.span }, args: [inner], span: e.span };
        }
        if (inner.k === "Lit" && (inner.lit.k === "Int" || inner.lit.k === "Float")) {
          return { k: "Lit", lit: { ...inner.lit, v: -inner.lit.v } as typeof inner.lit, span: e.span };
        }
        return { ...e, e: inner };
      }
      case "Html": return { ...e, nodes: e.nodes.map((n) => this.html(n)) };
      case "Assign": {
        if (e.op === "++" || e.op === "--") {
          return { ...e, op: e.op === "++" ? "+=" : "-=", target: this.expr(e.target), value: { k: "Lit", lit: { k: "Int", v: 1 }, span: e.span } };
        }
        if (e.op === "/=") {
          const target = this.expr(e.target);
          const value = this.expr(e.value!);
          // `/=` only existed for cells: read the cell, divide, write it back
          const current: Expr = { k: "Field", target, name: "value", span: e.span };
          return { ...e, op: "=", target, value: { k: "Binary", op: "/", l: current, r: value, span: e.span } };
        }
        return { ...e, target: this.expr(e.target), value: e.value ? this.expr(e.value) : undefined };
      }
      case "Handle":
        return { ...e, effect: this.typeName(e.effect), ops: e.ops.map((o) => ({ ...o, fn: this.untypedLam(o.fn) })), body: this.expr(e.body) };
      case "Block": return this.stmts(e.stmts, e.value, e.span);
    }
  }

  /** `a::b::f` -> `B.f`, `Mod::Con` -> a qualified constructor */
  private qualified(mod: string[], name: string, span: Span): Expr {
    const head: Expr = { k: "Ctor", name: mod.join("."), args: [], span };
    if (/^[A-Z]/.test(name)) return { k: "Ctor", name: `${mod.join(".")}.${name}`, args: [], span };
    return { k: "Field", target: head, name, span };
  }

  private html(n: HtmlNode): HtmlNode {
    switch (n.k) {
      case "Text": return n;
      case "Hole": return { ...n, e: this.expr(n.e) };
      case "Element": case "Component":
        return {
          ...n,
          attrs: n.attrs.map((a) => a.value.k === "expr" ? { ...a, value: { k: "expr" as const, e: this.expr(a.value.e) } } : a),
          children: n.children.map((c) => this.html(c)),
        };
    }
  }
}

/**
 * Flow — tier splitting and code generation.
 *
 * Input : a checked module where every expression carries (type, effect row, placement).
 * Output: a client program and a server program that cooperate.
 *
 * Algorithm
 *   1. `home(e)` collapses the placement lattice to a concrete side for every node,
 *      resolving `cross` nodes by data-flow direction (docs/type-system.md §5).
 *   2. A *cut* is a node whose home differs from the home of its enclosing context.
 *      Every cut gets a stable id; its free variables become transport edges.
 *   3. Each side emits its own functions, the cuts it serves (`R.serve`), and
 *      references to the cuts it consumes (`R.remote` for streaming cuts,
 *      `R.call` for request/response cuts inside event handlers).
 */

import type { Decl, Expr, HtmlNode, Pattern, Program } from "./ast.ts";
import type { Module, Infer } from "./infer.ts";
import { implFnName } from "./infer.ts";
import type { Place, Type } from "./types.ts";
import { prune, typeStr, typePlace, sendable } from "./types.ts";
import { FlowError } from "./lexer.ts";

export type Side = "client" | "server";

export interface CutInfo {
  id: string;
  node: Expr;
  home: Side;
  deps: string[];
  mode: "reactive" | "call";
  line: number;
  file?: string;
}

export interface Compiled { client: string; server: string; cuts: CutInfo[]; diagnostics: string[] }

const ev = (s: string) => JSON.stringify(s);

export class Codegen {
  mod: Module;
  inf: Infer;
  prog: Program;
  homes = new Map<object, Side | "neutral">();
  cuts = new Map<object, CutInfo>();
  cutList: CutInfo[] = [];
  emitting = new Set<object>();
  diagnostics: string[] = [];
  private counter = 0;
  private tmp = 0;

  constructor(mod: Module, inf: Infer, prog: Program) {
    this.mod = mod;
    this.inf = inf;
    this.prog = prog;
  }

  fail(msg: string, span?: { line: number; col: number }): never {
    throw new FlowError(msg, { file: this.mod.file, line: span?.line, col: span?.col, code: "E_SPLIT" });
  }

  /* ---------------------------------------------------------------- */
  /* 1. home assignment                                               */
  /* ---------------------------------------------------------------- */

  placeOf(e: object): Place { return this.mod.info.get(e)?.place ?? "neutral"; }

  home(e: Expr): Side | "neutral" {
    const cached = this.homes.get(e);
    if (cached) return cached;
    const p = this.placeOf(e);
    let h: Side | "neutral";
    if (p === "neutral") h = "neutral";
    else if (p === "client") h = "client";
    else if (p === "server") h = "server";
    else h = this.resolveCross(e);
    this.homes.set(e, h);
    return h;
  }

  /**
   * A `cross` node has parts on both sides. Rule order:
   *   (a) a type that can only live on one side wins (Html/Cell/Event ⇒ client);
   *   (b) otherwise the callee side wins (compute where the function lives);
   *   (c) otherwise the first non-neutral operand side;
   *   (d) otherwise server (keep computation near the authoritative data).
   */
  private resolveCross(e: Expr): Side {
    const t = this.mod.info.get(e)?.ty;
    if (t) { const tp = typePlace(t); if (tp === "client" || tp === "server") return tp; }

    switch (e.k) {
      case "App": { const f = this.home(e.fn); if (f !== "neutral") return f; break; }
      case "Html": return "client";
      case "Match": { for (const a of e.arms) { const h = this.home(a.body); if (h !== "neutral") return h; } break; }
      case "If": {
        const a = this.home(e.then), b = this.home(e.else);
        if (a === b && a !== "neutral") return a;
        if (a !== "neutral") return a;
        if (b !== "neutral") return b;
        break;
      }
      case "Block": {
        for (const s of e.stmts) { const h = this.home(s.k === "LetStmt" ? s.value : s.e); if (h !== "neutral") return h; }
        break;
      }
    }
    for (const c of childExprs(e)) { const h = this.home(c); if (h !== "neutral") return h; }
    return "server";
  }

  /* ---------------------------------------------------------------- */
  /* 2. cut collection                                                */
  /* ---------------------------------------------------------------- */

  collect(): void {
    for (const d of this.prog.decls) {
      if (d.k === "Fn") this.walk(d.body, "neutral", false, d.body);
      if (d.k === "Impl") for (const m of d.methods) this.walk(m.body, "neutral", false, m.body);
      if (d.k === "Provide") for (const o of d.ops) this.walk(o.fn, "neutral", false, o.fn);
    }
  }

  private walk(e: Expr, ctxHome: Side | "neutral", inHandler: boolean, top: Expr): void {
    const h = this.home(e);
    if (h !== "neutral" && ctxHome !== "neutral" && h !== ctxHome) {
      const cut: CutInfo = {
        id: `cut${++this.counter}`,
        node: e,
        home: h,
        deps: [...freeVars(e, new Set())].filter((n) => this.isRuntimeLocal(n)),
        mode: inHandler ? "call" : "reactive",
        line: e.span.line,
        file: e.span.file,
      };
      this.checkSendable(cut);
      this.cuts.set(e, cut);
      this.cutList.push(cut);
      this.diagnostics.push(
        `cut ${cut.id}: ${cut.mode} ${h}-side block @${cut.file ? cut.file.split(/[\\\\/]/).pop() + ":" : ""}${cut.line}` +
        (cut.deps.length ? ` deps=[${cut.deps.join(", ")}]` : " deps=[]") +
        ` type=${this.mod.info.get(e) ? typeStr(this.mod.info.get(e)!.ty) : "?"}`,
      );
      ctxHome = h;
    } else if (h !== "neutral") {
      ctxHome = h;
    }

    for (const c of childExprs(e)) this.walk(c, ctxHome, inHandler || this.isHandlerExpr(e, c), top);
  }

  private walkHtml(n: HtmlNode, ctxHome: Side | "neutral", inHandler: boolean, top: Expr): void {
    switch (n.k) {
      case "Text": return;
      case "Hole": this.walk(n.e, ctxHome, inHandler, top); return;
      case "Element": case "Component":
        for (const a of n.attrs) {
          if (a.value.k === "expr") this.walk(a.value.e, ctxHome, inHandler || a.name.startsWith("on"), top);
        }
        for (const c of n.children) this.walkHtml(c, ctxHome, inHandler, top);
        return;
    }
  }

  private isHandlerExpr(parent: Expr, child: Expr): boolean {
    if (parent.k !== "Html") return false;
    const scan = (n: HtmlNode): boolean =>
      (n.k === "Element" || n.k === "Component") &&
      (n.attrs.some((a) => a.name.startsWith("on") && a.value.k === "expr" && a.value.e === child) ||
        n.children.some(scan));
    return parent.nodes.some(scan);
  }

  private isRuntimeLocal(name: string): boolean {
    if (this.mod.fns.has(name) || this.mod.ctors.has(name)) return false;
    if (this.mod.effects.has(name) || this.mod.traits.has(name)) return false;
    return true;
  }

  /** Every value that crosses the wire must be sendable. This is the type system's teeth. */
  private checkSendable(cut: CutInfo) {
    const res = this.mod.info.get(cut.node);
    if (res) {
      const r0 = sendable(res.ty);
      if (!r0.ok) {
        this.fail(
          `this ${cut.home}-side block produces ${typeStr(res.ty)}, which cannot cross the boundary: ${r0.reason}`,
          { line: cut.line, col: 1 },
        );
      }
    }
    for (const dep of cut.deps) {
      let t = this.typeOfName(cut.node, dep);
      if (!t) continue;
      // A Cell is transmitted as its current *value*, so check the element type.
      const p = prune(t);
      if (p.k === "con" && p.name === "Cell") t = p.args[0]!;
      const r = sendable(t);
      if (!r.ok) {
        this.fail(
          `value '${dep}' of type ${typeStr(t)} cannot cross the ${cut.home} boundary: ${r.reason}`,
          { line: cut.line, col: 1 },
        );
      }
    }
  }

  private typeOfName(node: Expr, name: string): Type | null {
    for (const c of [node, ...allDescendants(node)]) {
      if (c.k === "Var" && c.name === name) {
        const t = this.mod.varTypes.get(c);
        if (t) return t;
      }
    }
    return null;
  }

  /* ---------------------------------------------------------------- */
  /* 3. emission                                                      */
  /* ---------------------------------------------------------------- */

  compile(): Compiled {
    this.collect();
    return {
      client: this.emitModule("client"),
      server: this.emitModule("server"),
      cuts: this.cutList,
      diagnostics: this.diagnostics,
    };
  }

  private emitModule(side: Side): string {
    const out: string[] = [];
    out.push(`// Generated by Flow. Do not edit.`);
    out.push(`// side: ${side}   cuts: ${this.cutList.length}`);
    out.push(side === "client" ? `import { R } from "/runtime/client.js";` : `import { R } from "./runtime/server-runtime.js";`);
    out.push("");

    for (const d of this.prog.decls) {
      if (d.k === "Fn") {
        const h = this.home(d.body);
        if (h === side || h === "neutral") out.push(this.emitFn(d.name, d.params, d.body, side));
      }
    }
    for (let i = 0; i < this.mod.impls.length; i++) {
      const im = this.mod.impls[i]!;
      for (const [mname, m] of im.methods) {
        const h = this.home(m.body);
        if (h === side || h === "neutral") {
          out.push(this.emitFn(implFnName(im.trait, i, mname), m.params, m.body, side));
        }
      }
    }
    for (const d of this.prog.decls) {
      if (d.k !== "Provide") continue;
      const ops = d.ops
        .map((o) => {
          const h = this.home(o.fn);
          if (h !== side && h !== "neutral") return null;
          return `${ev(o.name)}: ${this.emitExpr(o.fn, side, "neutral", new Set())}`;
        })
        .filter((x) => x !== null);
      if (ops.length) out.push(`R.provide(${ev(d.effect)}, { ${ops.join(", ")} });`);
    }

    for (const cut of this.cutList) {
      if (cut.home !== side) continue;
      this.emitting.add(cut.node);
      const body = this.emitExpr(cut.node, side, side, new Set(cut.deps));
      this.emitting.delete(cut.node);
      const destructure = cut.deps.length ? `const { ${cut.deps.join(", ")} } = A;` : "";
      const asyncKw = this.hasCallCut(cut.node, true) ? "async " : "";
      out.push(`R.serve(${ev(cut.id)}, ${asyncKw}(A) => { ${destructure} return ${body}; });`);
    }

    if (side === "client") {
      out.push("");
      out.push(`export function __flow_start(root) { R.mount(root, () => R.v(main())); }`);
      out.push(`export { R };`);
    } else {
      out.push("");
      out.push(`export { R };`);
    }
    out.push("");
    return out.join("\n");
  }

  private emitFn(name: string, params: { name: string }[], body: Expr, side: Side): string {
    const env = new Set(params.map((p) => p.name));
    const js = this.emitExpr(body, side, side, env);
    const asyncKw = this.hasCallCut(body) ? "async " : "";
    return `${asyncKw}function ${name}(${params.map((p) => p.name).join(", ")}) { return ${js}; }`;
  }

  /** True when evaluating `e` needs `await`, i.e. it contains a request/response cut. */
  hasCallCut(e: Expr, skipSelf = false): boolean {
    const c = this.cuts.get(e);
    if (c && !skipSelf) return c.mode === "call";
    if (e.k === "Lam") return false; // a nested lambda becomes async on its own
    for (const x of childExprs(e)) if (this.hasCallCut(x)) return true;
    for (const n of htmlChildren(e)) for (const h of htmlHoles([n])) if (this.hasCallCut(h)) return true;
    return false;
  }

  /* ---------------- expressions ---------------- */

  emitExpr(e: Expr, side: Side, ctxHome: Side | "neutral", env: Set<string>): string {
    const cut = this.emitting.has(e) ? null : this.cuts.get(e);
    if (cut) return this.emitCutRef(cut);

    switch (e.k) {
      case "Lit": return litJs(e.lit);
      case "Var": {
        const ext = this.mod.fns.get(e.name)?.extern;
        if (ext && !env.has(e.name)) return `R.ffiFn(${ev(ext.implName)})`;
        return e.name;
      }
      case "Lam": {
        const inner = new Set(env);
        for (const p of e.params) inner.add(p.name);
        const asyncKw = this.hasCallCut(e.body) ? "async " : "";
        return `(${asyncKw}(${e.params.map((p) => p.name).join(", ")}) => ${this.emitExpr(e.body, side, ctxHome, inner)})`;
      }
      case "App": return this.emitApp(e, side, ctxHome, env);
      case "If":
        return `(${this.val(e.cond, side, ctxHome, env)} ? ${this.emitExpr(e.then, side, ctxHome, env)} : ${this.emitExpr(e.else, side, ctxHome, env)})`;
      case "Match": return this.emitMatch(e, side, ctxHome, env);
      case "Let": {
        const vJs = this.emitExpr(e.value, side, ctxHome, env);
        const inner = new Set(env); inner.add(e.name);
        const bind = this.hasCallCut(e.value) ? `const ${e.name} = ${vJs};` : `const ${e.name} = R.sig(() => ${vJs});`;
        const bodyJs = this.emitExpr(e.body, side, ctxHome, inner);
        const needsAwait = this.hasCallCut(e);
        return needsAwait
          ? `(await (async () => { ${bind} return ${bodyJs}; })())`
          : `((() => { ${bind} return ${bodyJs}; })())`;
      }
      case "Record":
        return `({ ${e.fields.map((f) => `${ev(f.name)}: ${this.emitExpr(f.value, side, ctxHome, env)}`).join(", ")} })`;
      case "Field":
        if (/^\d+$/.test(e.name)) return `${this.emitExpr(e.target, side, ctxHome, env)}[${e.name}]`;
        return `R.v(${this.emitExpr(e.target, side, ctxHome, env)}).${e.name}`;
      case "Tuple": return `[${e.items.map((i) => this.emitExpr(i, side, ctxHome, env)).join(", ")}]`;
      case "List": return `[${e.items.map((i) => this.emitExpr(i, side, ctxHome, env)).join(", ")}]`;
      case "Ctor": return `R.ctor(${ev(e.name)}, [${e.args.map((a) => this.emitExpr(a, side, ctxHome, env)).join(", ")}])`;
      case "Binary": return this.emitBinary(e, side, ctxHome, env);
      case "Unary":
        return e.op === "not" || e.op === "!" ? `(!${this.val(e.e, side, ctxHome, env)})` : `(-${this.val(e.e, side, ctxHome, env)})`;
      case "Html": return this.emitHtml(e.nodes, side, ctxHome, env);
      case "Block": return this.emitBlock(e, side, ctxHome, env);
    }
  }

  private val(e: Expr, side: Side, ctxHome: Side | "neutral", env: Set<string>): string {
    return `R.v(${this.emitExpr(e, side, ctxHome, env)})`;
  }

  private emitCutRef(cut: CutInfo): string {
    const deps = cut.deps.length ? `{ ${cut.deps.map((d) => `${ev(d)}: ${d}`).join(", ")} }` : "{}";
    if (cut.mode === "call") return `(await R.call(${ev(cut.id)}, ${deps}))`;
    return `R.remote(${ev(cut.id)}, () => (${deps}))`;
  }

  private effectOfOp(name: string): string | null {
    for (const e of this.mod.effects.values()) if (e.ops.has(name)) return e.name;
    return null;
  }

  private qualNameOf(e: Expr): string | null {
    if (e.k === "Var") return e.name;
    if (e.k === "Ctor" && e.args.length === 0) return e.name;
    return null;
  }

  private emitApp(e: Expr & { k: "App" }, side: Side, ctxHome: Side | "neutral", env: Set<string>): string {
    const choice = this.mod.implChoices.get(e);
    if (choice) {
      // A method call carries its receiver outside `e.args`; a qualified trait
      // call (`Trait.method(x, …)`) already has it in the argument list.
      const qn = e.fn.k === "Field" ? this.qualNameOf(e.fn.target) : null;
      const qualified = qn && (this.mod.traits.has(qn) || this.mod.effects.has(qn));
      const parts = e.args.map((a) => this.emitExpr(a, side, ctxHome, env));
      if (e.fn.k === "Field" && !qualified) parts.unshift(this.emitExpr(e.fn.target, side, ctxHome, env));
      return `${choice.mangled}(${parts.join(", ")})`;
    }

    const args = e.args.map((a) => this.val(a, side, ctxHome, env)).join(", ");

    // `unsafe extern js fn` — call the host directly
    if (e.fn.k === "Var") {
      const ext = this.mod.fns.get(e.fn.name)?.extern;
      if (ext && !env.has(e.fn.name)) {
        return `R.ffiCall(${ev(ext.implName)}, [${args}])`;
      }
    }

    const qual = e.fn.k === "Field" ? this.qualNameOf(e.fn.target) : null;
    if (e.fn.k === "Field" && qual && this.mod.effects.has(qual)) {
      return `R.op(${ev(qual)}, ${ev(e.fn.name)})(${args})`;
    }
    if (e.fn.k === "Var") {
      const qual = this.effectOfOp(e.fn.name);
      if (qual && !env.has(e.fn.name) && !this.mod.fns.has(e.fn.name)) {
        return `R.op(${ev(qual)}, ${ev(e.fn.name)})(${args})`;
      }
    }
    return `${this.emitExpr(e.fn, side, ctxHome, env)}(${args})`;
  }

  private emitBinary(e: Expr & { k: "Binary" }, side: Side, ctxHome: Side | "neutral", env: Set<string>): string {
    const l = this.val(e.l, side, ctxHome, env);
    const r = this.val(e.r, side, ctxHome, env);
    // Equality is a std-level primitive now: the host provides it through the FFI.
    if (e.op === "==") return `R.ffiCall("__flow.eq", [${l}, ${r}])`;
    if (e.op === "!=") return `(!R.ffiCall("__flow.eq", [${l}, ${r}]))`;
    if (e.op === "/") {
      const t = prune(this.mod.info.get(e)?.ty ?? { k: "var", id: -1, level: 0 });
      // Int / Int is integer division; the host provides the truncation.
      if (t.k === "con" && t.name === "Int") return `R.ffiCall("Math.trunc", [${l} / ${r}])`;
    }
    const op = e.op === "and" || e.op === "&&" ? "&&" : e.op === "or" || e.op === "||" ? "||" : e.op;
    return `(${l} ${op} ${r})`;
  }

  private emitMatch(e: Expr & { k: "Match" }, side: Side, ctxHome: Side | "neutral", env: Set<string>): string {
    const scrut = `R.v(${this.emitExpr(e.scrut, side, ctxHome, env)})`;
    const lines: string[] = ["((() => {", `  const $m${++this.tmp} = ${scrut};`];
    const m = `$m${this.tmp}`;
    for (const arm of e.arms) {
      const inner = new Set(env);
      const body = this.emitExpr(arm.body, side, ctxHome, inner);
      const guard = arm.guard ? this.val(arm.guard, side, ctxHome, inner) : null;
      lines.push(this.emitArm(arm.pat, m, body, guard));
    }
    lines.push(`  throw new Error(${ev("non-exhaustive match at runtime")});`);
    lines.push("})())");
    return lines.join("\n");
  }

  /** Emits `if`-nested statements that bind pattern variables, ending in `inner`. */
  private emitArm(p: Pattern, ref: string, body: string, guard: string | null): string {
    const leaf = guard ? `if (${guard}) { return ${body}; }` : `return ${body};`;
    return this.armStatements(p, ref, leaf);
  }

  private armStatements(p: Pattern, ref: string, inner: string): string {
    switch (p.k) {
      case "PWild": return `{ ${inner} }`;
      case "PVar": return `{ const ${p.name} = ${ref}; ${inner} }`;
      case "PLit": return `if (${ref} === ${litJs(p.lit)}) { ${inner} }`;
      case "PTuple": {
        const t = `$t${++this.tmp}`;
        const items = p.items.map((q, i) => ({ q, r: `${t}[${i}]` }));
        return `{ const ${t} = ${ref}; ${this.armSeq(items.map((x) => x.q), items.map((x) => x.r), inner)} }`;
      }
      case "PRecord": {
        const t = `$t${++this.tmp}`;
        const fs = p.fields.map((f) => ({ q: f.pat, r: `${t}[${ev(f.name)}]` }));
        return `{ const ${t} = ${ref}; ${this.armSeq(fs.map((x) => x.q), fs.map((x) => x.r), inner)} }`;
      }
      case "PCtor": {
        const c = `$c${++this.tmp}`;
        const head = `if (${c} && ${c}.$ === ${ev(p.name)})`;
        const args = p.args.map((q, i) => ({ q, r: `${c}.args[${i}]` }));
        return `{ const ${c} = ${ref}; ${head} { ${this.armSeq(args.map((x) => x.q), args.map((x) => x.r), inner)} } }`;
      }
      case "PList": {
        const t = `$t${++this.tmp}`;
        const len = p.items.length;
        const cond = p.rest ? `${t}.length >= ${len}` : `${t}.length === ${len}`;
        const inner2 = p.rest
          ? `{ const ${p.rest} = ${t}.slice(${len}); ${inner} }`
          : inner;
        const seq = p.items.map((q, i) => ({ q, r: `${t}[${i}]` }));
        return `{ const ${t} = ${ref}; if (Array.isArray(${t}) && ${cond}) { ${this.armSeq(seq.map((x) => x.q), seq.map((x) => x.r), inner2)} } }`;
      }
    }
  }

  private armSeq(ps: Pattern[], refs: string[], inner: string): string {
    if (ps.length === 0) return inner;
    const [p, ...rest] = ps;
    const [r, ...rrest] = refs;
    return this.armStatements(p!, r!, this.armSeq(rest, rrest, inner));
  }

  private emitBlock(e: Expr & { k: "Block" }, side: Side, ctxHome: Side | "neutral", env: Set<string>): string {
    const stmts: string[] = [];
    const inner = new Set(env);
    for (const s of e.stmts) {
      if (s.k === "LetStmt") {
        const v = this.emitExpr(s.value, side, ctxHome, inner);
        stmts.push(this.hasCallCut(s.value) ? `const ${s.name} = ${v};` : `const ${s.name} = R.sig(() => ${v});`);
        inner.add(s.name);
      } else {
        stmts.push(`${this.emitExpr(s.e, side, ctxHome, inner)};`);
      }
    }
    const value = e.value ? this.emitExpr(e.value, side, ctxHome, inner) : "null";
    return this.hasCallCut(e)
      ? `(await (async () => { ${stmts.join(" ")} return ${value}; })())`
      : `((() => { ${stmts.join(" ")} return ${value}; })())`;
  }

  /* ---------------- html ---------------- */

  emitHtml(nodes: HtmlNode[], side: Side, ctxHome: Side | "neutral", env: Set<string>): string {
    const items = nodes.map((n) => this.emitHtmlNode(n, side, ctxHome, env)).filter((x) => x !== "null");
    if (items.length === 0) return `R.frag([])`;
    if (items.length === 1) return items[0]!;
    return `R.frag([${items.join(", ")}])`;
  }

  private emitHtmlNode(n: HtmlNode, side: Side, ctxHome: Side | "neutral", env: Set<string>): string {
    switch (n.k) {
      case "Text": return n.v.length ? `R.text(${ev(n.v)})` : "null";
      case "Hole": return `R.hole(() => ${this.emitExpr(n.e, side, ctxHome, env)})`;
      case "Element": {
        const attrs = n.attrs.map((a) => {
          if (a.name.startsWith("on") && a.value.k === "expr") {
            return `${ev("on:" + a.name.slice(2).toLowerCase())}: ${this.emitExpr(a.value.e, side, ctxHome, env)}`;
          }
          if (a.value.k === "static") return `${ev(a.name)}: ${ev(a.value.v)}`;
          return `${ev(a.name)}: R.attr(() => ${this.emitExpr(a.value.e, side, ctxHome, env)})`;
        });
        const kids = n.children.map((c) => this.emitHtmlNode(c, side, ctxHome, env)).filter((x) => x !== "null");
        return `R.el(${ev(n.tag)}, { ${attrs.join(", ")} }, [${kids.join(", ")}])`;
      }
      case "Component": {
        const fields: string[] = [];
        for (const a of n.attrs) {
          fields.push(`${ev(a.name)}: ${a.value.k === "static" ? ev(a.value.v) : this.emitExpr(a.value.e, side, ctxHome, env)}`);
        }
        const kids = n.children.map((c) => this.emitHtmlNode(c, side, ctxHome, env)).filter((x) => x !== "null");
        const fnInfo = this.mod.fns.get(n.name);
        if (fnInfo && fnInfo.params.length === 0) return `R.v(${n.name}())`;
        fields.push(`${ev("children")}: ${kids.length === 1 ? kids[0] : `R.frag([${kids.join(", ")}])`}`);
        return `R.v(${n.name}({ ${fields.join(", ")} }))`;
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function litJs(l: { k: string; v?: unknown }): string {
  if (l.k === "Unit") return "null";
  if (l.k === "Str") return JSON.stringify(l.v);
  if (l.k === "Bool") return l.v ? "true" : "false";
  return String(l.v);
}

function htmlChildren(e: Expr): HtmlNode[] {
  switch (e.k) {
    case "Html": return e.nodes;
    case "Block": return [
      ...e.stmts.flatMap((s) => htmlChildren(s.k === "LetStmt" ? s.value : s.e)),
      ...(e.value ? htmlChildren(e.value) : []),
    ];
    case "If": return [...htmlChildren(e.then), ...htmlChildren(e.else)];
    default: return [];
  }
}

export function childExprs(e: Expr): Expr[] {
  switch (e.k) {
    case "Lit": case "Var": return [];
    case "Lam": return [e.body];
    case "App": return [e.fn, ...e.args];
    case "If": return [e.cond, e.then, e.else];
    case "Match": return [e.scrut, ...e.arms.flatMap((a) => a.guard ? [a.guard, a.body] : [a.body])];
    case "Let": return [e.value, e.body];
    case "Record": return e.fields.map((f) => f.value);
    case "Field": return [e.target];
    case "Tuple": case "List": return e.items;
    case "Ctor": return e.args;
    case "Binary": return [e.l, e.r];
    case "Unary": return [e.e];
    case "Html": return htmlHoles(e.nodes);
    case "Block": return [
      ...e.stmts.map((s) => (s.k === "LetStmt" ? s.value : s.e)),
      ...(e.value ? [e.value] : []),
    ];
  }
}

function htmlHoles(nodes: HtmlNode[]): Expr[] {
  const out: Expr[] = [];
  for (const n of nodes) {
    if (n.k === "Hole") out.push(n.e);
    if (n.k === "Element" || n.k === "Component") {
      for (const a of n.attrs) if (a.value.k === "expr") out.push(a.value.e);
      out.push(...htmlHoles(n.children));
    }
  }
  return out;
}

export function freeVars(e: Expr, bound: Set<string>): Set<string> {
  const out = new Set<string>();
  const go = (x: Expr, b: Set<string>) => {
    switch (x.k) {
      case "Var": if (!b.has(x.name)) out.add(x.name); return;
      case "Lit": return;
      case "Lam": {
        const inner = new Set(b);
        for (const p of x.params) inner.add(p.name);
        go(x.body, inner);
        return;
      }
      case "Let": {
        go(x.value, b);
        const inner = new Set(b); inner.add(x.name);
        go(x.body, inner);
        return;
      }
      case "Match": {
        go(x.scrut, b);
        for (const a of x.arms) {
          const inner = new Set(b);
          bindPatternVars(a.pat, inner);
          if (a.guard) go(a.guard, inner);
          go(a.body, inner);
        }
        return;
      }
      case "Block": {
        let cur = new Set(b);
        for (const s of x.stmts) {
          if (s.k === "LetStmt") { go(s.value, cur); cur = new Set(cur); cur.add(s.name); }
          else go(s.e, cur);
        }
        if (x.value) go(x.value, cur);
        return;
      }
      case "Html": {
        for (const n of htmlHoles(x.nodes)) go(n, b);
        return;
      }
      default:
        for (const c of childExprs(x)) go(c, b);
        return;
    }
  };
  go(e, new Set(bound));
  return out;
}

function bindPatternVars(p: Pattern, into: Set<string>) {
  switch (p.k) {
    case "PVar": into.add(p.name); return;
    case "PTuple": p.items.forEach((q) => bindPatternVars(q, into)); return;
    case "PRecord": p.fields.forEach((f) => bindPatternVars(f.pat, into)); return;
    case "PList": p.items.forEach((q) => bindPatternVars(q, into)); if (p.rest) into.add(p.rest); return;
    case "PCtor": p.args.forEach((q) => bindPatternVars(q, into)); return;
    default: return;
  }
}

function* allDescendants(e: Expr): Generator<Expr> {
  for (const c of childExprs(e)) { yield c; yield* allDescendants(c); }
  for (const n of htmlChildren(e)) for (const h of htmlHoles([n])) { yield h; yield* allDescendants(h); }
}

void prune;

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
import type { Module, Infer, DictParam } from "./infer.ts";
import { implFnName } from "./infer.ts";
import type { Place, Type } from "./types.ts";
import { prune, typeStr, typePlace, sendable } from "./types.ts";
import type { Eff } from "./types.ts";
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
  /** type-variable id -> dictionary parameter name while emitting a function */
  private currentDicts = new Map<number, string>();
  /** effects that suspend and resume (`algebraic effect`) */
  private algebraicEffects = new Set<string>();
  /** true while emitting the body of a JS generator function */
  private genMode = false;

  constructor(mod: Module, inf: Infer, prog: Program) {
    this.mod = mod;
    this.inf = inf;
    this.prog = prog;
    for (const e of mod.effects.values()) if (e.algebraic) this.algebraicEffects.add(e.name);
  }

  private isAlgebraic(effect: string): boolean {
    return this.algebraicEffects.has(effect);
  }

  private rowHasAlgebraic(eff: Eff | undefined | null): boolean {
    if (!eff) return false;
    for (const l of eff.labels) if (this.isAlgebraic(l)) return true;
    return false;
  }

  private typeHasAlgebraic(t: Type | undefined): boolean {
    const p = t ? prune(t) : undefined;
    return Boolean(p && p.k === "fun" && this.rowHasAlgebraic(p.eff));
  }

  private effOf(e: object): Eff | undefined {
    return this.mod.info.get(e)?.eff;
  }

  /** Emit `js` as a value of the enclosing generator, or explain why not. */
  private yieldStar(js: string, span?: { line: number; col: number }, what = "this call"): string {
    if (!this.genMode) {
      this.fail(
        `${what} performs an algebraic effect, but it is evaluated in a lazy or foreign slot ` +
        `(a reactive block, an HTML attribute/hole, an event listener, a provider, or a component). ` +
        `Handle the effect in a plain expression instead.`,
        span,
      );
    }
    return `(yield* ${js})`;
  }

  private perform(effect: string, op: string, args: string, span?: { line: number; col: number }): string {
    if (!this.genMode) {
      this.fail(
        `algebraic effect ${effect}.${op} is performed in a lazy or foreign slot ` +
        `(a reactive block, an HTML attribute/hole, an event listener, a provider, or a component). ` +
        `Algebraic effects are scoped to 'handle … with …' and must run inside a plain expression.`,
        span,
      );
    }
    return `(yield R.perform(${ev(effect)}, ${ev(op)}, [${args}]))`;
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
      if (this.rowHasAlgebraic(this.effOf(e))) {
        this.fail(
          `an algebraic effect cannot cross the ${h} tier boundary: handle it before the cut ` +
          `('handle … with { … } { … }' must run on the side that performs it)`,
          e.span,
        );
      }
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
    this.checkEntryEffects();
    this.collect();
    return {
      client: this.emitModule("client"),
      server: this.emitModule("server"),
      cuts: this.cutList,
      diagnostics: this.diagnostics,
    };
  }

  /** `main` is mounted by the renderer, outside any handler scope. */
  private checkEntryEffects(): void {
    const main = this.mod.fns.get("main");
    if (!main || main.scheme.k !== "fun") return;
    const unhandled = [...main.scheme.eff.labels].filter((l) => this.isAlgebraic(l));
    if (unhandled.length) {
      this.fail(
        `main performs algebraic effect(s) {${unhandled.sort().join(", ")}} without handling them: ` +
        `wrap the work in 'handle ${unhandled[0]} with { … } { … }'`,
        main.span,
      );
    }
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
        const info = this.mod.fns.get(d.name);
        if (h === side || h === "neutral") out.push(this.emitFn(d.name, d.params, d.body, side, info?.dicts));
      }
    }
    for (let i = 0; i < this.mod.impls.length; i++) {
      const im = this.mod.impls[i]!;
      for (const [mname, m] of im.methods) {
        const h = this.home(m.body);
        if (h === side || h === "neutral") {
          const fname = implFnName(im.trait, i, mname);
          const info = this.mod.fns.get(fname);
          out.push(this.emitFn(fname, m.params, m.body, side, info?.dicts));
        }
      }
    }
    for (const d of this.prog.decls) {
      if (d.k !== "Provide") continue;
      const ops = d.ops
        .map((o) => {
          if (this.rowHasAlgebraic(this.effOf(o.fn))) {
            this.fail(
              `provider for capability ${d.effect}.${o.name} cannot perform an algebraic effect: ` +
              `providers are called from anywhere, so there is no handler scope`,
              o.span,
            );
          }
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
      out.push(`export function __flow_start(root) { R.mount(root, () => R.v(R.run(() => main()))); }`);
      out.push(`export { R };`);
    } else {
      const routesFn = this.prog.decls.find((d) => d.k === "Fn" && d.name === "routes");
      if (routesFn && (this.home(routesFn.body) === "server" || this.home(routesFn.body) === "neutral")) {
        out.push("");
        out.push(`export { ${routesFn.name} as routes };`);
      }
      out.push("");
      out.push(`export { R };`);
    }
    out.push("");
    return out.join("\n");
  }

  private emitFn(name: string, params: { name: string }[], body: Expr, side: Side, dicts?: DictParam[]): string {
    const dictParams = (dicts ?? []).map((d) => d.name);
    const env = new Set([...params.map((p) => p.name), ...dictParams]);
    const savedDicts = this.currentDicts;
    const savedGen = this.genMode;
    this.currentDicts = new Map((dicts ?? []).map((d) => [d.varId, d.name]));
    const info = this.mod.fns.get(name);
    const gen = Boolean(info && info.scheme.k === "fun" && this.rowHasAlgebraic(info.scheme.eff));
    this.genMode = gen;
    let js: string;
    try {
      js = this.emitExpr(body, side, side, env);
    } finally {
      this.currentDicts = savedDicts;
      this.genMode = savedGen;
    }
    if (gen && this.hasCallCut(body)) {
      this.fail(
        `fn ${name} both performs an algebraic effect and needs a request/response cut; ` +
        `handle the effect before the cut`,
        body.span,
      );
    }
    const asyncKw = this.hasCallCut(body) ? "async " : "";
    const allParams = [...params.map((p) => p.name), ...dictParams];
    return `${asyncKw}function${gen ? "*" : ""} ${name}(${allParams.join(", ")}) { return ${js}; }`;
  }

  /**
   * A `let` is a lazy signal only when its value is pure. Bindings that exist for
   * their effect must run in program order: `_`, `Unit`-typed values, and values
   * that call an `unsafe extern` (FFI) function such as `window.setInterval`.
   */
  isEagerLet(e: { name: string; value: Expr }): boolean {
    if (e.name === "_") return true;
    const ty = this.mod.info.get(e.value)?.ty;
    if (ty && typeStr(ty) === "Unit") return true;
    return this.callsExtern(e.value);
  }

  private callsExtern(e: Expr): boolean {
    if (e.k === "Lam") return false;
    if (e.k === "App" && e.fn.k === "Var" && this.mod.fns.get(e.fn.name)?.extern) return true;
    for (const x of childExprs(e)) if (this.callsExtern(x)) return true;
    return false;
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
        if (!env.has(e.name)) {
          const ctor = this.mod.ctors.get(e.name);
          if (ctor) {
            // A constructor referenced through a path (`std::option::Some`) is a
            // value, not a JS function.
            if (ctor.arity === 0) return `R.ctor(${ev(e.name)}, [])`;
            return `((...$ctorArgs) => R.ctor(${ev(e.name)}, $ctorArgs))`;
          }
        }
        const ext = this.mod.fns.get(e.name)?.extern;
        if (ext && !env.has(e.name)) return `R.ffiFn(${ev(ext.implName)})`;
        return e.name;
      }
      case "Lam": {
        const inner = new Set(env);
        for (const p of e.params) inner.add(p.name);
        const gen = this.typeHasAlgebraic(this.mod.info.get(e)?.ty);
        if (gen && this.hasCallCut(e.body)) {
          this.fail("a function that performs an algebraic effect cannot also contain a request/response cut", e.span);
        }
        const savedGen = this.genMode;
        this.genMode = gen;
        let bodyJs: string;
        try {
          bodyJs = this.emitExpr(e.body, side, ctxHome, inner);
        } finally {
          this.genMode = savedGen;
        }
        if (gen) return `(function* (${e.params.map((p) => p.name).join(", ")}) { return ${bodyJs}; })`;
        const asyncKw = this.hasCallCut(e.body) ? "async " : "";
        return `(${asyncKw}(${e.params.map((p) => p.name).join(", ")}) => ${bodyJs})`;
      }
      case "App": return this.emitApp(e, side, ctxHome, env);
      case "If":
        return `(${this.val(e.cond, side, ctxHome, env)} ? ${this.emitExpr(e.then, side, ctxHome, env)} : ${this.emitExpr(e.else, side, ctxHome, env)})`;
      case "Match": return this.emitMatch(e, side, ctxHome, env);
      case "Let": {
        const gen = this.genMode || this.rowHasAlgebraic(this.effOf(e));
        if (gen) {
          if (this.hasCallCut(e)) this.fail("a block that performs an algebraic effect cannot also contain a request/response cut", e.span);
          const savedGen = this.genMode;
          this.genMode = true;
          const vJs = this.emitExpr(e.value, side, ctxHome, env);
          const inner = new Set(env); inner.add(e.name);
          const bind = gen || this.rowHasAlgebraic(this.effOf(e.value))
            ? `const ${e.name} = ${vJs};`
            : `const ${e.name} = R.sig(() => ${vJs});`;
          const bodyJs = this.emitExpr(e.body, side, ctxHome, inner);
          this.genMode = savedGen;
          return `(yield* (function* () { ${bind} return ${bodyJs}; })())`;
        }
        const vJs = this.emitExpr(e.value, side, ctxHome, env);
        const inner = new Set(env); inner.add(e.name);
        const bind = this.hasCallCut(e.value) || this.isEagerLet(e) ? `const ${e.name} = ${vJs};` : `const ${e.name} = R.sig(() => ${vJs});`;
        const bodyJs = this.emitExpr(e.body, side, ctxHome, inner);
        const needsAwait = this.hasCallCut(e);
        return needsAwait
          ? `(await (async () => { ${bind} return ${bodyJs}; })())`
          : `((() => { ${bind} return ${bodyJs}; })())`;
      }
      case "Record":
        return `({ ${e.fields.map((f) => `${ev(f.name)}: ${this.val(f.value, side, ctxHome, env)}`).join(", ")} })`;
      case "Field":
        if (e.name === "value") {
          const targetType = prune(this.mod.info.get(e.target)?.ty ?? { k: "var", id: -1, level: 0 });
          if (targetType.k === "con" && targetType.name === "Cell") {
            return `R.ffiCall("__flow.get", [${this.emitExpr(e.target, side, ctxHome, env)}])`;
          }
        }
        if (/^\d+$/.test(e.name)) return `${this.emitExpr(e.target, side, ctxHome, env)}[${e.name}]`;
        return `R.v(${this.emitExpr(e.target, side, ctxHome, env)}).${e.name}`;
      case "Tuple": return `[${e.items.map((i) => this.val(i, side, ctxHome, env)).join(", ")}]`;
      case "List": return `[${e.items.map((i) => this.val(i, side, ctxHome, env)).join(", ")}]`;
      case "Ctor": return `R.ctor(${ev(e.name)}, [${e.args.map((a) => this.val(a, side, ctxHome, env)).join(", ")}])`;
      case "Binary": return this.emitBinary(e, side, ctxHome, env);
      case "Unary":
        return e.op === "not" || e.op === "!" ? `(!${this.val(e.e, side, ctxHome, env)})` : `(-${this.val(e.e, side, ctxHome, env)})`;
      case "Html": return this.emitHtml(e.nodes, side, ctxHome, env);
      case "Handle": return this.emitHandle(e, side, ctxHome, env);
      case "Assign": return this.emitAssign(e, side, ctxHome, env);
      case "Block": return this.emitBlock(e, side, ctxHome, env);
    }
  }

  private val(e: Expr, side: Side, ctxHome: Side | "neutral", env: Set<string>): string {
    return `R.v(${this.emitExpr(e, side, ctxHome, env)})`;
  }

  /**
   * `handle E with { … } { body }`.
   *
   * Capability effects stay scoped providers (`R.withEffect`). Algebraic
   * effects suspend: the body becomes a generator, the handler operations
   * receive `resume`, and the handle is driven by `R.handle`, or by the
   * enclosing handler when the body performs an outer algebraic effect.
   */
  private emitHandle(
    e: Expr & { k: "Handle" },
    side: Side,
    ctxHome: Side | "neutral",
    env: Set<string>,
  ): string {
    if (this.isAlgebraic(e.effect)) {
      const ops = e.ops
        .map((op) => `${ev(op.name)}: ${this.emitAlgebraicOp(op, side, ctxHome, env)}`)
        .join(", ");
      const savedGen = this.genMode;
      this.genMode = true;
      let bodyJs: string;
      try {
        bodyJs = this.emitExpr(e.body, side, ctxHome, env);
      } finally {
        this.genMode = savedGen;
      }
      const call = `R.handle(${ev(e.effect)}, { ${ops} }, function* () { return ${bodyJs}; })`;
      return this.genMode ? `(yield* ${call})` : `R.run(${call})`;
    }

    const ops = e.ops
      .map((op) => {
        if (this.rowHasAlgebraic(this.effOf(op.fn))) {
          this.fail(
            `provider for capability ${e.effect}.${op.name} cannot perform an algebraic effect: ` +
            `providers are called from anywhere, so there is no handler scope`,
            op.span,
          );
        }
        return `${ev(op.name)}: ${this.emitExpr(op.fn, side, ctxHome, env)}`;
      })
      .join(", ");

    if (this.rowHasAlgebraic(this.effOf(e.body))) {
      const savedGen = this.genMode;
      this.genMode = true;
      let bodyJs: string;
      try {
        bodyJs = this.emitExpr(e.body, side, ctxHome, env);
      } finally {
        this.genMode = savedGen;
      }
      return this.yieldStar(
        `R.withEffectGen(${ev(e.effect)}, { ${ops} }, function* () { return ${bodyJs}; })`,
        e.span,
        `a capability handler body`,
      );
    }

    const asyncKw = this.hasCallCut(e.body) ? "async " : "";
    return `R.withEffect(${ev(e.effect)}, { ${ops} }, ${asyncKw}() => ${this.emitExpr(e.body, side, ctxHome, env)})`;
  }

  /** `cell.value = e`, `cell += e`, `cell++` compiled to host get/set. */
  private emitAssign(
    e: Expr & { k: "Assign" },
    side: Side,
    ctxHome: Side | "neutral",
    env: Set<string>,
  ): string {
    const target = e.target;
    const isValue = target.k === "Field" && target.name === "value";
    const cellExpr = isValue ? (target as Expr & { k: "Field" }).target : target;
    const cellType = prune(this.mod.info.get(cellExpr)?.ty ?? { k: "var", id: -1, level: 0 });
    if (!(cellType.k === "con" && cellType.name === "Cell")) {
      this.fail("assignment target must be a Cell", target.span);
    }
    const cell = this.emitExpr(cellExpr, side, ctxHome, env);
    const get = `R.ffiCall("__flow.get", [${cell}])`;
    if (e.op === "=") {
      return `R.ffiCall("__flow.set", [${cell}, ${this.val(e.value!, side, ctxHome, env)}])`;
    }
    if (e.op === "++" || e.op === "--") {
      return `R.ffiCall("__flow.set", [${cell}, (${get} ${e.op === "++" ? "+" : "-"} 1)])`;
    }
    const value = this.val(e.value!, side, ctxHome, env);
    const elem = cellType.args[0] ?? { k: "var", id: -1, level: 0 };
    if (e.op === "/=" && elem.k === "con" && elem.name === "Int") {
      return `R.ffiCall("__flow.set", [${cell}, R.ffiCall("__flow.divInt", [${get}, ${value}])])`;
    }
    return `R.ffiCall("__flow.set", [${cell}, (${get} ${e.op[0]} ${value})])`;
  }

  /** An algebraic operation handler: a generator that also receives `resume`. */
  private emitAlgebraicOp(
    op: { name: string; fn: Expr; span: { line: number; col: number } },
    side: Side,
    ctxHome: Side | "neutral",
    env: Set<string>,
  ): string {
    if (op.fn.k !== "Lam") this.fail(`the handler for an algebraic operation must be a function literal`, op.span);
    const lam = op.fn;
    if (this.hasCallCut(lam.body)) {
      this.fail(`a handler operation cannot contain a request/response cut`, lam.span);
    }
    const inner = new Set(env);
    for (const p of lam.params) inner.add(p.name);
    inner.add("resume");
    const savedGen = this.genMode;
    this.genMode = true;
    let bodyJs: string;
    try {
      bodyJs = this.emitExpr(lam.body, side, ctxHome, inner);
    } finally {
      this.genMode = savedGen;
    }
    const params = [...lam.params.map((p) => p.name), "resume"].join(", ");
    return `function* (${params}) { return ${bodyJs}; }`;
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
    // `resume(v)` inside an algebraic operation handler: the continuation.
    if (e.fn.k === "Var" && this.mod.resumeVars.has(e.fn)) {
      const args = e.args.map((a) => this.val(a, side, ctxHome, env)).join(", ");
      return this.yieldStar(`resume(${args})`, e.span, `resume`);
    }
    if (this.mod.partialCalls.has(e)) return this.emitPartialApp(e, side, ctxHome, env);

    const genCall = (js: string): string =>
      this.mod.genCalls.has(e) ? this.yieldStar(js, e.span, `'${this.callName(e)}'`) : js;

    const bound = this.mod.boundChoices.get(e);
    if (bound) {
      const qn = e.fn.k === "Field" ? this.qualNameOf(e.fn.target) : null;
      const qualified = qn && (this.mod.traits.has(qn) || this.mod.effects.has(qn));
      const parts = e.args.map((a) => this.emitExpr(a, side, ctxHome, env));
      if (e.fn.k === "Field" && !qualified) parts.unshift(this.emitExpr(e.fn.target, side, ctxHome, env));
      return genCall(`${bound.dictName}.${bound.method}(${parts.join(", ")})`);
    }

    const choice = this.mod.implChoices.get(e);
    if (choice) {
      // A method call carries its receiver outside `e.args`; a qualified trait
      // call (`Trait.method(x, …)`) already has it in the argument list.
      const qn = e.fn.k === "Field" ? this.qualNameOf(e.fn.target) : null;
      const qualified = qn && (this.mod.traits.has(qn) || this.mod.effects.has(qn));
      const parts = e.args.map((a) => this.emitExpr(a, side, ctxHome, env));
      if (e.fn.k === "Field" && !qualified) parts.unshift(this.emitExpr(e.fn.target, side, ctxHome, env));
      for (const d of choice.dicts ?? []) parts.push(this.emitDict(d.trait, d.type));
      return genCall(`${choice.mangled}(${parts.join(", ")})`);
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
      if (this.isAlgebraic(qual)) return this.perform(qual, e.fn.name, args, e.span);
      return `R.op(${ev(qual)}, ${ev(e.fn.name)})(${args})`;
    }
    if (e.fn.k === "Var") {
      const qual = this.effectOfOp(e.fn.name);
      if (qual && !env.has(e.fn.name) && !this.mod.fns.has(e.fn.name)) {
        if (this.isAlgebraic(qual)) return this.perform(qual, e.fn.name, args, e.span);
        return `R.op(${ev(qual)}, ${ev(e.fn.name)})(${args})`;
      }
    }
    const dicts = e.fn.k === "Var" ? this.mod.dictArgs.get(e) ?? [] : [];
    const callArgs = [args, ...dicts.map((d) => this.emitDict(d.trait, d.type))]
      .filter((x) => x.length > 0)
      .join(", ");
    return genCall(`${this.calleeJs(e.fn, side, ctxHome, env)}(${callArgs})`);
  }

  /** A local function value lives in a reactive Node; dereference before calling. */
  private calleeJs(fn: Expr, side: Side, ctxHome: Side | "neutral", env: Set<string>): string {
    const js = this.emitExpr(fn, side, ctxHome, env);
    return fn.k === "Var" && env.has(fn.name) ? `R.v(${js})` : js;
  }

  private callName(e: Expr & { k: "App" }): string {
    if (e.fn.k === "Var") return e.fn.name;
    if (e.fn.k === "Field") return e.fn.name;
    return "call";
  }

  /** `f(a)` with fewer arguments than the arity: a closure over `a`. */
  private emitPartialApp(
    e: Expr & { k: "App" },
    side: Side,
    ctxHome: Side | "neutral",
    env: Set<string>,
  ): string {
    if (e.fn.k === "Var") {
      const fn = this.mod.fns.get(e.fn.name);
      if (fn?.body && this.hasCallCut(fn.body)) {
        this.fail(`cannot partially apply '${e.fn.name}': it needs a request/response cut`, e.span);
      }
    } else if (this.hasCallCut(e.fn)) {
      this.fail("cannot partially apply a function that needs a request/response cut", e.span);
    }

    const n = ++this.tmp;
    const fnVar = `$p${n}`;
    const restVar = `$r${n}`;
    let fnJs: string;
    let provided: string[] = [];
    let suffix: string[] = [];

    const bound = this.mod.boundChoices.get(e);
    const choice = this.mod.implChoices.get(e);
    if (bound) {
      const qn = e.fn.k === "Field" ? this.qualNameOf(e.fn.target) : null;
      const qualified = qn && (this.mod.traits.has(qn) || this.mod.effects.has(qn));
      provided = e.args.map((a) => this.emitExpr(a, side, ctxHome, env));
      if (e.fn.k === "Field" && !qualified) provided.unshift(this.emitExpr(e.fn.target, side, ctxHome, env));
      fnJs = `${bound.dictName}.${bound.method}`;
    } else if (choice) {
      const qn = e.fn.k === "Field" ? this.qualNameOf(e.fn.target) : null;
      const qualified = qn && (this.mod.traits.has(qn) || this.mod.effects.has(qn));
      provided = e.args.map((a) => this.emitExpr(a, side, ctxHome, env));
      if (e.fn.k === "Field" && !qualified) provided.unshift(this.emitExpr(e.fn.target, side, ctxHome, env));
      suffix = (choice.dicts ?? []).map((d) => this.emitDict(d.trait, d.type));
      fnJs = choice.mangled;
    } else if (e.fn.k === "Var") {
      const ext = this.mod.fns.get(e.fn.name)?.extern;
      fnJs = ext && !env.has(e.fn.name)
        ? `R.ffiFn(${ev(ext.implName)})`
        : this.calleeJs(e.fn, side, ctxHome, env);
      provided = e.args.map((a) => this.val(a, side, ctxHome, env));
    } else {
      fnJs = this.emitExpr(e.fn, side, ctxHome, env);
      provided = e.args.map((a) => this.val(a, side, ctxHome, env));
    }

    const args = [...provided, `...${restVar}`, ...suffix].join(", ");
    return `((${fnVar}) => (...${restVar}) => ${fnVar}(${args}))(${fnJs})`;
  }

  /** Emit a dictionary object for a trait instance, closing over inner
   *  dictionaries when the instance itself is generic with bounds. */
  private emitDict(trait: string, type: Type): string {
    const t = prune(type);
    if (t.k === "var") {
      const name = this.currentDicts.get(t.id) ?? (t.origin !== undefined ? this.currentDicts.get(t.origin) : undefined);
      if (name) return name;
      // The variable may be a fresh alias whose origin was lost during
      // unification; if this function carries a dictionary for the same trait,
      // that is the dictionary to pass.
      const fallback = [...this.currentDicts.values()].find((n) => n.startsWith(`$d_${trait}_`));
      if (fallback) return fallback;
      this.fail(`no dictionary for ${trait} ${typeStr(t)} is in scope`);
    }
    const resolved = this.inf.resolveImplInfo(trait, t);
    if (!resolved) this.fail(`no instance of ${trait} for ${typeStr(t)} is available for a dictionary`);
    const inner = (resolved.impl.dicts ?? [])
      .map((d) => {
        const innerType = resolved.subst.get(d.varId);
        return innerType ? this.emitDict(d.trait, innerType) : null;
      })
      .filter((x): x is string => Boolean(x));
    const fields = [...resolved.impl.mangled.entries()].map(([method, fn]) => {
      if (inner.length) return `${JSON.stringify(method)}: (...a) => ${fn}(...a, ${inner.join(", ")})`;
      return `${JSON.stringify(method)}: ${fn}`;
    });
    return `{ ${fields.join(", ")} }`;
  }

  private emitBinary(e: Expr & { k: "Binary" }, side: Side, ctxHome: Side | "neutral", env: Set<string>): string {
    if (e.op === ">>=") {
      const choice = this.mod.implChoices.get(e);
      if (!choice) this.fail("internal: '>>=' was not resolved to a Monad instance", e.span);
      return `${choice.mangled}(${this.val(e.l, side, ctxHome, env)}, ${this.emitExpr(e.r, side, ctxHome, env)})`;
    }
    const l = this.val(e.l, side, ctxHome, env);
    const r = this.val(e.r, side, ctxHome, env);
    // Equality is a std-level primitive now: the host provides it through the FFI.
    if (e.op === "==") return `R.ffiCall("__flow.eq", [${l}, ${r}])`;
    if (e.op === "!=") return `(!R.ffiCall("__flow.eq", [${l}, ${r}]))`;
    if (e.op === "/") {
      const t = prune(this.mod.info.get(e)?.ty ?? { k: "var", id: -1, level: 0 });
      // Int / Int is integer division; the host provides the truncation.
      if (t.k === "con" && t.name === "Int") return `R.ffiCall("__flow.divInt", [${l}, ${r}])`;
    }
    const op = e.op === "and" || e.op === "&&" ? "&&" : e.op === "or" || e.op === "||" ? "||" : e.op;
    return `(${l} ${op} ${r})`;
  }

  private emitMatch(e: Expr & { k: "Match" }, side: Side, ctxHome: Side | "neutral", env: Set<string>): string {
    const gen = this.genMode || this.rowHasAlgebraic(this.effOf(e));
    if (gen && this.hasCallCut(e)) {
      this.fail("a match that performs an algebraic effect cannot also contain a request/response cut", e.span);
    }
    const savedGen = this.genMode;
    if (gen) this.genMode = true;
    const scrut = `R.v(${this.emitExpr(e.scrut, side, ctxHome, env)})`;
    const body: string[] = [`const $m${++this.tmp} = ${scrut};`];
    const m = `$m${this.tmp}`;
    for (const arm of e.arms) {
      const inner = new Set(env);
      const armBody = this.emitExpr(arm.body, side, ctxHome, inner);
      const guard = arm.guard ? this.val(arm.guard, side, ctxHome, inner) : null;
      body.push(this.emitArm(arm.pat, m, armBody, guard));
    }
    body.push(`throw new Error(${ev("non-exhaustive match at runtime")});`);
    this.genMode = savedGen;
    if (gen) return `(yield* (function* () { ${body.join("\n")} })())`;
    return ["((() => {", ...body.map((l) => "  " + l), "})())"].join("\n");
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
    const gen = this.genMode || this.rowHasAlgebraic(this.effOf(e));
    if (gen && this.hasCallCut(e)) {
      this.fail("a block that performs an algebraic effect cannot also contain a request/response cut", e.span);
    }
    const savedGen = this.genMode;
    if (gen) this.genMode = true;
    const stmts: string[] = [];
    const inner = new Set(env);
    for (const s of e.stmts) {
      if (s.k === "LetStmt") {
        const v = this.emitExpr(s.value, side, ctxHome, inner);
        const eager = gen || this.hasCallCut(s.value) || this.isEagerLet(s);
        stmts.push(eager ? `const ${s.name} = ${v};` : `const ${s.name} = R.sig(() => ${v});`);
        inner.add(s.name);
      } else {
        stmts.push(`${this.emitExpr(s.e, side, ctxHome, inner)};`);
      }
    }
    const value = e.value ? this.emitExpr(e.value, side, ctxHome, inner) : "null";
    this.genMode = savedGen;
    if (gen) return `(yield* (function* () { ${stmts.join(" ")} return ${value}; })())`;
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
      case "Hole":
        if (this.rowHasAlgebraic(this.effOf(n.e))) {
          this.fail(
            "an algebraic effect cannot be performed in an HTML hole: holes are evaluated lazily, " +
            "outside the handler's scope. Handle the effect before the hole.",
            n.span,
          );
        }
        return `R.hole(() => ${this.emitExpr(n.e, side, ctxHome, env)})`;
      case "Element": {
        const attrs = n.attrs.map((a) => {
          if (a.name.startsWith("on") && a.value.k === "expr") {
            if (this.typeHasAlgebraic(this.mod.info.get(a.value.e)?.ty) || this.rowHasAlgebraic(this.effOf(a.value.e))) {
              this.fail(
                `the '${a.name}' listener cannot perform an algebraic effect: listeners run after the ` +
                `handler's scope has ended. Handle the effect inside the listener instead.`,
                n.span,
              );
            }
            return `${ev("on:" + a.name.slice(2).toLowerCase())}: ${this.emitExpr(a.value.e, side, ctxHome, env)}`;
          }
          if (a.value.k === "static") return `${ev(a.name)}: ${ev(a.value.v)}`;
          if (this.rowHasAlgebraic(this.effOf(a.value.e))) {
            this.fail(
              `an algebraic effect cannot be performed in the '${a.name}' attribute: attributes are ` +
              `evaluated lazily. Handle the effect before the attribute.`,
              n.span,
            );
          }
          return `${ev(a.name)}: R.attr(() => ${this.emitExpr(a.value.e, side, ctxHome, env)})`;
        });
        const kids = n.children.map((c) => this.emitHtmlNode(c, side, ctxHome, env)).filter((x) => x !== "null");
        return `R.el(${ev(n.tag)}, { ${attrs.join(", ")} }, [${kids.join(", ")}])`;
      }
      case "Component": {
        if (this.rowHasAlgebraic(this.effOf(n))) {
          this.fail(
            `component '${n.name}' performs an algebraic effect without handling it: components are ` +
            `called by the renderer, outside any handler scope. Wrap the effect in 'handle … with' inside the component.`,
            n.span,
          );
        }
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
    case "Handle": return [...e.ops.map((op) => op.fn), e.body];
    case "Assign": return e.value ? [e.target, e.value] : [e.target];
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

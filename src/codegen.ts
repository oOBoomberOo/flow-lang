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
import { implFnName, dictKey, traitBase } from "./infer.ts";
import type { Place, Type } from "./types.ts";
import { prune, typeStr, typePlace, sendable } from "./types.ts";
import type { Eff } from "./types.ts";
import fs from "node:fs";
import path from "node:path";
import { FlowError } from "./lexer.ts";

export type Side = "client" | "server";

export interface CutInfo {
  id: string;
  node: Expr;
  /** The server-side body, with duplicated pure local helpers folded in. */
  serverNode?: Expr;
  home: Side;
  deps: string[];
  mode: "reactive" | "call";
  /** A placeholder value for a reactive cut until the first wire value. */
  initial?: string;
  line: number;
  file?: string;
}

export interface Compiled {
  client: string;
  server: string;
  cuts: CutInfo[];
  /** the program has a browser entry (main :: Html or serve.page) */
  hasClient: boolean;
  /** the program registers server routes (serve.routes, routes(), or Router) */
  hasRoutes: boolean;
  /** shim modules imported by the program: source file and bundled name */
  modules: { file: string; name: string }[];
  /** shim modules imported by the program: source file and bundled name */
  modules: { file: string; name: string }[];
  diagnostics: string[];
  /** shim modules the program imports: source file and the bundled file name */
  modules: { file: string; name: string }[];
}

const ev = (s: string) => JSON.stringify(s);

export class Codegen {
  mod: Module;
  inf: Infer;
  prog: Program;
  homes = new Map<object, Side | "neutral">();
  /** local binding -> emitted name, when the binder shadows a top-level name */
  private localNames = new Map<string, string>();
  /** shim file -> import alias, bundle name and where it is used */
  private shims = new Map<string, { alias: string; name: string; ts: boolean; used: Set<Side> }>();
  /** extern name -> shim alias */
  private shimAlias = new Map<string, string>();
  cuts = new Map<object, CutInfo>();
  cutList: CutInfo[] = [];
  /** Local `let`/`where` bindings in scope, for duplicating pure helpers. */
  private localDefs = new Map<string, Expr>();
  /** Functions compiled as generators because they may call a callback. */
  private generatorFns = new Set<string>();
  /** Trait methods that take a callback and may propagate its effects. */
  private generatorTraitMethods = new Set<string>();
  /** Effects currently handled by an enclosing local `handle`. */
  private currentHandledEffects = new Set<string>();
  emitting = new Set<object>();
  diagnostics: string[] = [];
  private counter = 0;
  private tmp = 0;
  /** type-variable id -> dictionary parameter name while emitting a function */
  private currentDicts = new Map<string, string>();
  /** effects that suspend and resume (`effect`) */
  private algebraicEffects = new Set<string>();
  /** true while emitting the body of a JS generator function */
  private genMode = false;
  /** the `page` field passed to `serve`, mounted in the browser at startup */
  private servePage: Expr | null = null;
  /** the `routes` field passed to `serve`, registered on the server at startup */
  private serveRoutes: Expr | null = null;
  /** a top-level app-object constant consumed by `serve` (not emitted normally) */
  private serveConfigName: string | null = null;
  /** the declaration containing the serve call, for app-constant use checks */
  private serveOwner: Decl | null = null;
  /** entry facts for the CLI: does this program need a client/server host? */
  hasClient = false;
  hasRoutes = false;
  /** the `serve` call site, used for capture diagnostics */
  private serveSpan: { line?: number; col?: number } | null = null;

  constructor(mod: Module, inf: Infer, prog: Program) {
    this.mod = mod;
    this.inf = inf;
    this.prog = prog;
    // An effect without a provider must be handled by `handle` and compiles to
    // a suspending generator call. A provided effect is a default handler and
    // compiles to a direct provider call unless a local handler is in scope.
    for (const e of mod.effects.values()) {
      if (!mod.provides.has(e.name)) this.algebraicEffects.add(e.name);
    }
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
        `${what} performs an effect, but it is evaluated in a lazy or foreign slot ` +
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
        `effect ${effect}.${op} is performed in a lazy or foreign slot ` +
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

  home(e: Expr | undefined): Side | "neutral" {
    if (!e) return "neutral";
    const cached = this.homes.get(e);
    if (cached) return cached;
    const p = this.placeOf(e);
    let h: Side | "neutral";
    if (p === "neutral") {
      // Inference can record a neutral place before a field or parameter type
      // resolves (`event.target.value` while `event` is still a type variable).
      // The resolved type is authoritative, and a neutral node with placed
      // children belongs to their side.
      const t = this.mod.info.get(e)?.ty;
      const tp = t ? typePlace(t) : "neutral";
      h = tp === "client" || tp === "server" ? tp : this.resolveCross(e);
    } else if (p === "client") h = "client";
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
   *   (d) otherwise neutral (the node has no side; run it where it is used).
   */
  private resolveCross(e: Expr): Side | "neutral" {
    const t = this.mod.info.get(e)?.ty;
    if (t) { const tp = typePlace(t); if (tp === "client" || tp === "server") return tp; }

    switch (e.k) {
      // A function is a value; its body runs where it is invoked.
      case "Lam": return "neutral";
      case "App": {
        // A neutral function is a value: it can run where the call is used, so
        // its client/server arguments become the cuts instead of the whole call.
        const f = this.home(e.fn);
        return f === "neutral" ? "neutral" : f;
      }
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
    // Nothing in this node needs a particular side: run it where it is used.
    return "neutral";
  }

  /* ---------------------------------------------------------------- */
  /* 2. cut collection                                                */
  /* ---------------------------------------------------------------- */

  /** True when `body` invokes one of `names` as a function. */
  private callsFunctionParam(body: Expr, names: Set<string>): boolean {
    if (!names.size) return false;
    let found = false;
    const visit = (e: Expr) => {
      if (found || e.k === "Lam") return;
      if (e.k === "App" && this.mod.partialCalls.has(e)) {
        for (const a of e.args) visit(a);
        return;
      }
      if (e.k === "App" && e.fn.k === "Var" && names.has(e.fn.name)) {
        found = true;
        return;
      }
      for (const c of childExprs(e)) visit(c);
      for (const n of htmlChildren(e)) for (const h of htmlHoles([n])) visit(h);
    };
    visit(body);
    return found;
  }

  /** True when the body calls a function that may return a generator. */
  private callsGenerator(body: Expr): boolean {
    let found = false;
    const visit = (e: Expr) => {
      if (found || e.k === "Lam") return;
      if (e.k === "App" && this.mod.partialCalls.has(e)) {
        for (const a of e.args) visit(a);
        return;
      }
      if (e.k === "App" && this.calleeMayGenerate(e.fn)) { found = true; return; }
      for (const c of childExprs(e)) visit(c);
    };
    visit(body);
    return found;
  }

  /**
   * A function that may call a callback, perform a cut, or call another
   * generator is compiled as a generator; calls are driven with `R.genCall`.
   * This is what lets an effect propagate to a handler up the stack.
   */
  private computeGenerators(): void {
    for (const [tname, tr] of this.mod.traits) {
      for (const [mname, m] of tr.methods) {
        if (m.ty.k === "fun" && m.ty.params.some((p) => prune(p).k === "fun")) {
          this.generatorTraitMethods.add(`${tname}.${mname}`);
          this.generatorTraitMethods.add(`${traitBase(tname)}.${mname}`);
        }
      }
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const d of this.prog.decls) {
        if (d.k !== "Fn" || this.generatorFns.has(d.name)) continue;
        const gen =
          this.rowHasAlgebraic(this.mod.info.get(d.body)?.eff) ||
          this.callsFunctionParam(d.body, new Set(d.params.map((p) => p.name)));
        if (gen) { this.generatorFns.add(d.name); changed = true; }
      }
      for (let i = 0; i < this.mod.impls.length; i++) {
        const im = this.mod.impls[i]!;
        for (const [mname, m] of im.methods) {
          const fname = implFnName(im.trait, i, mname);
          if (this.generatorFns.has(fname)) continue;
          const gen =
            this.rowHasAlgebraic(this.mod.info.get(m.body)?.eff) ||
            this.callsFunctionParam(m.body, new Set(m.params.map((p) => p.name)));
          if (gen) { this.generatorFns.add(fname); changed = true; }
        }
      }
    }
  }

  /** A callee that may return a generator: a callback, partial or generator fn. */
  private calleeMayGenerate(e: Expr): boolean {
    if (e.k === "App" && this.mod.partialCalls.has(e)) return true;
    // A function-valued expression (a partial application or a returned
    // function) may be a generator; driving it is always safe.
    if (e.k === "App" || e.k === "Lam") return true;
    const t = this.mod.info.get(e)?.ty;
    const fun = t ? prune(t) : undefined;
    if (!fun || fun.k !== "fun") return false;
    if (e.k === "Var") {
      if (this.generatorFns.has(e.name)) return true;
      // A local/parameter function value has unknown effects.
      if (!this.mod.fns.has(e.name) && !this.mod.effects.has(e.name) && !this.mod.traits.has(e.name)) {
        return true;
      }
    }
    return false;
  }

  collect(): void {
    for (const d of this.prog.decls) {
      if (d.k === "Fn" && d.name !== this.serveConfigName) this.walk(d.body, "neutral", false, d.body);
      if (d.k === "Impl") for (const m of d.methods) this.walk(m.body, "neutral", false, m.body);
      if (d.k === "Provide") for (const o of d.ops) this.walk(o.fn, "neutral", false, o.fn);
    }
  }

  private walk(e: Expr, ctxHome: Side | "neutral", inHandler: boolean, top: Expr): void {
    // `serve` is a build-time entry point: `page` belongs to the browser and
    // `routes` to the server, so their cuts are collected with the matching
    // context instead of the enclosing call's.
    if (this.isServeCall(e)) {
      if (this.servePage) this.walk(this.servePage, "client", true, this.servePage);
      if (this.serveRoutes) this.walk(this.serveRoutes, "server", true, this.serveRoutes);
      return;
    }
    const h = this.home(e);
    // A let/block is a sequence of independently placed parts, not one region.
    // Walk the binding(s) and the body separately so `let title = event.value`
    // stays on the client while the server call in the body becomes the cut.
    if (e.k === "Let" || e.k === "Block" || e.k === "Handle") {
      if (ctxHome === "neutral" && h !== "neutral" && h !== "cross") ctxHome = h;
      if (e.k === "Let") {
        this.walk(e.value, ctxHome, inHandler, top);
        const prev = this.localDefs.get(e.name);
        this.localDefs.set(e.name, e.value);
        this.walk(e.body, ctxHome, inHandler, top);
        if (prev) this.localDefs.set(e.name, prev);
        else this.localDefs.delete(e.name);
        return;
      }
      if (e.k === "Handle") {
        for (const c of childExprs(e)) this.walk(c, ctxHome, inHandler, top);
        return;
      }
      const saved = new Map(this.localDefs);
      for (const s of e.stmts) {
        if (s.k === "LetStmt") {
          this.walk(s.value, ctxHome, inHandler, top);
          this.localDefs.set(s.name, s.value);
        } else {
          this.walk(s.e, ctxHome, inHandler, top);
        }
      }
      if (e.value) this.walk(e.value, ctxHome, inHandler, top);
      this.localDefs = saved;
      return;
    }
    if (h !== "neutral" && ctxHome !== "neutral" && h !== ctxHome) {
      const deps = [...freeVars(e, new Set())].filter((n) => this.isRuntimeLocal(n));
      const lifted = this.liftLocalDeps(e, deps, h);
      const mode = inHandler ? "call" : "reactive";
      const cut: CutInfo = {
        id: `cut${++this.counter}`,
        node: e,
        serverNode: lifted.node === e ? undefined : lifted.node,
        home: h,
        deps: lifted.wire,
        mode,
        initial: mode === "reactive" ? this.initialFor(this.mod.info.get(e)?.ty) : undefined,
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

    // A lambda body runs later, on the side that holds the function: anything it
    // needs from the other side is a request/response call, not a subscription.
    const deferred = e.k === "Lam";
    for (const c of childExprs(e)) this.walk(c, ctxHome, inHandler || deferred || this.isHandlerExpr(e, c), top);
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

  /** A pure local helper that can be re-emitted on the cut's side. */
  private canDuplicateLocal(name: string, side: Side, seen = new Set<string>()): boolean {
    if (seen.has(name)) return true;
    seen.add(name);
    const def = this.localDefs.get(name);
    if (!def) return false;
    const t = this.mod.info.get(def)?.ty;
    if (!t || prune(t).k !== "fun") return false;
    if (this.home(def) !== "neutral") return false;
    if (this.effOf(def)?.labels.size) return false;
    // A lambda whose body belongs to the other tier (`event.target`, a client
    // cell) cannot be emitted on this side. Neutral and same-side bodies can.
    if (def.k === "Lam") {
      const bodyHome = this.home(def.body);
      if (bodyHome !== "neutral" && bodyHome !== side) return false;
    }
    for (const v of freeVars(def, new Set())) {
      if (!this.localDefs.has(v)) continue;
      // Captured values are sent as ordinary deps; only captured functions
      // need to be duplicated recursively.
      const vt = this.mod.info.get(this.localDefs.get(v)!)?.ty;
      if (vt && prune(vt).k === "fun" && !this.canDuplicateLocal(v, side, seen)) return false;
    }
    return true;
  }

  /** Replace wire dependencies that are pure local helpers with local bindings. */
  private liftLocalDeps(node: Expr, deps: string[], side: Side): { node: Expr; wire: string[] } {
    const wire: string[] = [];
    const lifted: string[] = [];
    const seen = new Set<string>();
    const add = (name: string) => {
      if (seen.has(name)) return;
      seen.add(name);
      const def = this.localDefs.get(name);
      if (!def) return;
      // Dependencies first; the reverse wrap below puts them outside the helper.
      for (const v of freeVars(def, new Set())) {
        if (!this.localDefs.has(v)) continue;
        const vdef = this.localDefs.get(v)!;
        const vt = this.mod.info.get(vdef)?.ty;
        if (vt && prune(vt).k === "fun") add(v);
        else if (!wire.includes(v)) wire.push(v);
      }
      lifted.push(name);
    };
    for (const d of deps) {
      if (this.canDuplicateLocal(d, side)) add(d);
      else wire.push(d);
    }
    // A duplicated helper may capture another local value; that value still
    // has to cross the wire (it is not part of the original cut node).
    const liftedSet = new Set(lifted);
    for (const d of lifted) {
      const def = this.localDefs.get(d)!;
      for (const v of freeVars(def, new Set())) {
        if (this.localDefs.has(v) && !liftedSet.has(v) && !wire.includes(v)) wire.push(v);
      }
    }
    let out = node;
    for (const d of lifted.reverse()) {
      const def = this.localDefs.get(d)!;
      const binding: Expr = { k: "Let", name: d, mut: false, value: def, body: out, span: node.span };
      const info = this.mod.info.get(out);
      if (info) this.mod.info.set(binding, info);
      out = binding;
    }
    return { node: out, wire };
  }

  private isRuntimeLocal(name: string): boolean {
    if (this.mod.fns.has(name) || this.mod.ctors.has(name)) return false;
    if (this.mod.effects.has(name) || this.mod.traits.has(name)) return false;
    // Trait methods are dispatched at the call site, not captured as values.
    if (this.mod.methodIndex.has(name)) return false;
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
    // A duplicated helper can reference a local that the cut node itself does
    // not mention; its binding still tells us what crosses.
    const def = this.localDefs.get(name);
    if (def) return this.mod.info.get(def)?.ty ?? null;
    return null;
  }

  /* ---------------------------------------------------------------- */
  /* 3. emission                                                      */
  /* ---------------------------------------------------------------- */

  compile(): Compiled {
    this.collectShims();
    this.findServe();
    this.collect();
    this.computeGenerators();
    this.checkEntryEffects();
    const main = this.mod.fns.get("main");
    const mainUsesRouter = Boolean(
      main && main.scheme.k === "fun" && main.scheme.eff.labels.has("Router"),
    );
    const legacyRoutes = this.prog.decls.some((d) => d.k === "Fn" && d.name === "routes");
    this.hasClient = this.mainKind() === "page" || Boolean(this.servePage);
    this.hasRoutes = Boolean(this.serveRoutes) || legacyRoutes || mainUsesRouter;
    return {
      client: this.emitModule("client"),
      server: this.emitModule("server"),
      cuts: this.cutList,
      hasClient: this.hasClient,
      hasRoutes: this.hasRoutes,
      diagnostics: this.diagnostics,
      modules: [...this.shims].map(([file, s]) => ({ file, name: s.name })),
    };
  }

  /** Which typed `serve` entry point is this? */
  private serveKind(name: string): "config" | "page" | "routes" | null {
    const impl = this.mod.fns.get(name)?.extern?.implName;
    if (impl === "__flow.serve") return "config";
    if (impl === "__flow.serve.page") return "page";
    if (impl === "__flow.serve.routes") return "routes";
    return null;
  }

  private isServeName(name: string): boolean {
    return this.serveKind(name) !== null;
  }

  private isServeCall(e: Expr): boolean {
    return e.k === "App" && e.fn.k === "Var" && this.isServeName(e.fn.name);
  }

  /**
   * `serve`, `servePage` and `serveApi` are build-time entry points, not server
   * calls: the page is emitted in the browser bundle and the server only
   * records that the program has a page router. Find the single call and check
   * that the page does not close over server startup locals.
   */
  private findServe(): void {
    let owner: Decl | null = null;
    const scan = (e: Expr, bound: Set<string>): void => {
      if (this.isServeCall(e)) {
        if (this.serveSpan) {
          this.fail(
            "`serve` can be called only once: put the page and routes in one app object",
            e.span,
          );
        }
        const kind = this.serveKind((e.fn as Expr & { k: "Var" }).name)!;
        const arg = (e as Expr & { k: "App" }).args[0];
        if (!arg) this.fail("`serve` expects an app object or page", e.span);
        this.serveSpan = e.span;
        this.serveOwner = owner;

        if (kind === "page") {
          this.servePage = arg;
          this.checkServePageType(arg, e.span, "`servePage`");
          this.checkServeCapture(arg, bound);
          return;
        }
        if (kind === "routes") {
          this.serveRoutes = arg;
          this.checkServeRoutesType(arg, e.span, "`serveApi`");
          return;
        }

        // `serve` takes the full AppConfig. It may be inline or a top-level
        // constant; the constant is consumed here and not emitted as a value.
        let config: (Expr & { k: "Record" }) | null = null;
        if (arg.k === "Record") {
          config = arg;
        } else if (arg.k === "Var") {
          const decl = this.prog.decls.find((d) =>
            d.k === "Fn" && d.name === arg.name && d.params.length === 0 && d.body.k === "Record"
          ) as (Decl & { k: "Fn"; body: Expr & { k: "Record" } }) | undefined;
          if (decl) {
            const otherUse = this.prog.decls.some((d) =>
              d !== decl && d !== this.serveOwner && d.k === "Fn" &&
              [d.body, ...allDescendants(d.body)].some((x) => x.k === "Var" && x.name === decl.name)
            );
            if (otherUse) {
              this.fail(
                `\`${decl.name}\` is consumed by serve and cannot also be used as a value; ` +
                `inline the app object or use its fields directly`,
                decl.span,
              );
            }
            this.serveConfigName = decl.name;
            config = decl.body;
          }
        }
        if (!config) {
          this.fail(
            "`serve` expects an app object `{ page = ..., routes = [...] }` " +
            "(written inline or as a top-level constant)",
            arg.span ?? e.span,
          );
        }
        const page = config.fields.find((f) => f.name === "page")?.value;
        const routes = config.fields.find((f) => f.name === "routes")?.value;
        if (!page || !routes) {
          this.fail(
            "`serve` needs an AppConfig with both `page` and `routes`; " +
            "use `servePage` for a page-only app or `serveApi` for a routes-only app",
            config.span,
          );
        }
        this.servePage = page;
        this.checkServePageType(page, config.span);
        this.checkServeCapture(page, bound);
        this.serveRoutes = routes;
        this.checkServeRoutesType(routes, config.span);
        return;
      }
      switch (e.k) {
        case "Lam": {
          const inner = new Set(bound);
          for (const p of e.params) inner.add(p.name);
          scan(e.body, inner);
          return;
        }
        case "Let": {
          scan(e.value, bound);
          const inner = new Set(bound);
          inner.add(e.name);
          scan(e.body, inner);
          return;
        }
        case "Match": {
          scan(e.scrut, bound);
          for (const arm of e.arms) {
            const inner = new Set(bound);
            bindPatternVars(arm.pat, inner);
            if (arm.guard) scan(arm.guard, inner);
            scan(arm.body, inner);
          }
          return;
        }
        case "Block": {
          let cur = new Set(bound);
          for (const s of e.stmts) {
            if (s.k === "LetStmt") {
              scan(s.value, cur);
              cur = new Set(cur);
              cur.add(s.name);
            } else {
              scan(s.e, cur);
            }
          }
          if (e.value) scan(e.value, cur);
          return;
        }
        default:
          for (const c of childExprs(e)) scan(c, bound);
      }
    };
    for (const d of this.prog.decls) {
      owner = d;
      if (d.k === "Fn") scan(d.body, new Set(d.params.map((p) => p.name)));
      if (d.k === "Impl") for (const m of d.methods) scan(m.body, new Set(m.params.map((p) => p.name)));
      if (d.k === "Provide") for (const o of d.ops) scan(o.fn, new Set());
    }
  }

  /** The page argument must be a client callback returning markup. */
  private checkServePageType(page: Expr, span?: { line?: number; col?: number; file?: string }, label = "`serve.page`"): void {
    const ty = this.mod.info.get(page)?.ty;
    if (!ty) return;
    const p = prune(ty);
    if (p.k === "var") return;
    const ret = p.k === "fun" ? prune(p.ret) : null;
    const isHtml = ret && ret.k === "con" && (ret.name === "Html" || ret.name.startsWith("Html$"));
    if (p.k !== "fun" || !isHtml) {
      this.fail(`${label} must be a client handler ` + "`RequestObject -> Html`", span ?? page.span);
    }
  }

  /** The routes argument is a plain list of server response routes. */
  private checkServeRoutesType(routes: Expr, span?: { line?: number; col?: number; file?: string }, label = "`serve.routes`"): void {
    const ty = this.mod.info.get(routes)?.ty;
    if (!ty) return;
    const p = prune(ty);
    if (p.k === "var") return;
    if (p.k !== "con" || (p.name !== "List" && !p.name.startsWith("List$"))) {
      this.fail(`${label} must be a ` + "`List Route`", span ?? routes.span);
    }
    const item = p.args[0] ? prune(p.args[0]) : null;
    if (!item || item.k === "var") return; // an empty list is fine
    const isRoute = item.k === "rec" &&
      Boolean(item.fields.method) && Boolean(item.fields.path) && Boolean(item.fields.handler);
    if (!isRoute) {
      this.fail(`${label} must be a ` + "`List Route` (`get`, `post`, `route`, ...)", span ?? routes.span);
    }
  }
  /** A page handler is emitted in the browser, so it cannot read local bindings. */
  private checkServeCapture(handler: Expr, bound: Set<string>): void {
    const free = freeVars(handler, new Set());
    const captured = [...free].filter((name) =>
      bound.has(name) || (this.isRuntimeLocal(name) && !this.mod.fns.has(name) && !this.mod.ctors.has(name))
    );
    if (captured.length) {
      this.fail(
        `the page handler cannot capture server startup binding(s) ${captured.map((n) => `'${n}'`).join(", ")}: ` +
        `it runs in the browser. Move the value to a top-level server function or a Cell, ` +
        `and call it from the handler`,
        handler.span ?? this.serveSpan ?? undefined,
      );
    }
  }

  /** The JS target of a compiler-recognized extern call, if any. */
  private implOf(fn: Expr): string | null {
    if (fn.k !== "Var") return null;
    return this.mod.fns.get(fn.name)?.extern?.implName ?? null;
  }

  /** The linker's final constructor name for a reflection ADT variant. */
  private metaCtor(variant: string): string {
    for (const [final, info] of this.mod.ctors) {
      if (info.variant === variant && info.typeName === "TypeInfo") return final;
    }
    for (const [final, info] of this.mod.ctors) {
      if (
        info.typeName.startsWith("TypeInfo") &&
        (info.variant === variant || info.variant.startsWith(variant + "$"))
      ) return final;
    }
    return variant;
  }

  /** A stdlib function referenced by generated code (tolerates a rename). */
  private stdlibFn(fileSuffix: string, simple: string): string {
    for (const [final, info] of this.mod.fns) {
      const file = (info.span?.file ?? "").replace(/\\/g, "/");
      if (file.endsWith(fileSuffix) && (final === simple || final.startsWith(simple + "$"))) return final;
    }
    this.fail(`internal: ${fileSuffix} is not linked`);
  }

  /** A canonical key for a reflected data type, unambiguous for nested args. */
  private reflectKey(t: Type): string {
    const p = prune(t);
    switch (p.k) {
      case "con":
        if (!p.args.length) return p.name;
        return `${p.name} ${p.args.map((arg) => {
          const q = prune(arg);
          const text = this.reflectKey(q);
          return q.k === "con" && q.args.length ? `(${text})` : text;
        }).join(" ")}`;
      case "tuple": return `(${p.items.map((item) => this.reflectKey(item)).join(", ")})`;
      case "rec":
        return `{ ${Object.entries(p.fields).map(([name, field]) => `${name} :: ${this.reflectKey(field)}`).join(", ")} }`;
      case "fun":
        return `${p.params.map((param) => this.reflectKey(param)).join(" -> ")} -> ${this.reflectKey(p.ret)}`;
      case "var": case "app": return typeStr(p);
    }
  }

  /** Build the `Reflected` value for a static type. */
  private reflectJs(t: Type, span?: { line?: number; col?: number; file?: string }): string {
    const defs = new Map<string, string>();
    const root = this.reflectNode(t, defs, span);
    const entries = [...defs].map(([key, def]) => `[${ev(key)}, ${def || "null"}]`).join(", ");
    return `{ "root": ${root}, "defs": [${entries}] }`;
  }

  /**
   * Auto serialization rejects a static type that has no JSON data shape.
   * Explicit `*With` calls still report this at runtime, because their metadata
   * can be built dynamically.
   */
  private assertSerializable(
    t: Type,
    what: string,
    span?: { line?: number; col?: number; file?: string },
    visited = new Set<string>(),
  ): void {
    const p = prune(t);
    switch (p.k) {
      case "con": {
        const name = p.name;
        if (["Int", "Float", "Str", "Bool", "Unit"].some((n) => name === n || name.startsWith(n + "$"))) return;
        if (name === "List") {
          if (p.args[0]) this.assertSerializable(p.args[0], what, span, visited);
          return;
        }
        const def = this.mod.typeDefs.get(name);
        if (def?.kind === "adt") {
          const key = this.reflectKey(p);
          if (visited.has(key)) return;
          visited.add(key);
          const d = def.decl as Decl & { k: "Adt" };
          const params = new Map<string, Type>();
          d.params.forEach((param, i) => {
            const arg = p.args[i];
            if (arg) params.set(param, arg);
          });
          for (const variant of d.variants) {
            for (const te of variant.args) {
              this.assertSerializable(this.inf.resolveType(te, new Map(params)), what, span, visited);
            }
          }
          return;
        }
        this.fail(`${what} cannot handle ${typeStr(p)}: only data types have a JSON shape`, span);
      }
      case "rec":
        for (const field of Object.values(p.fields)) this.assertSerializable(field, what, span, visited);
        return;
      case "tuple":
        for (const item of p.items) this.assertSerializable(item, what, span, visited);
        return;
      case "fun":
        this.fail(`${what} cannot handle ` + typeStr(p) + ": functions are not data", span);
      case "var":
        this.fail(`${what} needs a concrete type (got \`${typeStr(p)}\`)`, span);
      case "app":
        this.fail(`${what} cannot handle ${typeStr(p)}`, span);
    }
  }

  /**
   * Translate a semantic type into TypeInfo constructor calls.
   * Named data types become `TRef key` and their shape is collected in `defs`,
   * which is what keeps recursive types finite.
   */
  private reflectNode(
    t: Type,
    defs: Map<string, string>,
    span?: { line?: number; col?: number; file?: string },
  ): string {
    const p = prune(t);
    const meta = (variant: string, args: string): string =>
      `R.ctor(${ev(this.metaCtor(variant))}, [${args}])`;
    switch (p.k) {
      case "con": {
        const name = p.name;
        if (name === "Int" || name.startsWith("Int$")) return meta("TInt", "");
        if (name === "Float" || name.startsWith("Float$")) return meta("TFloat", "");
        if (name === "Str" || name.startsWith("Str$")) return meta("TStr", "");
        if (name === "Bool" || name.startsWith("Bool$")) return meta("TBool", "");
        if (name === "Unit") return meta("TUnit", "");
        if (name === "List") {
          if (!p.args[0]) return meta("TUnknown", ev(typeStr(p)));
          return meta("TList", this.reflectNode(p.args[0], defs, span));
        }
        const def = this.mod.typeDefs.get(name);
        if (def && def.kind === "adt") {
          const key = this.reflectKey(p);
          if (!defs.has(key)) {
            // Mark the key before walking the fields so recursion becomes a ref.
            defs.set(key, "");
            const d = def.decl as Decl & { k: "Adt" };
            const params = new Map<string, Type>();
            d.params.forEach((param, i) => {
              const arg = p.args[i];
              if (arg) params.set(param, arg);
            });
            const variants = d.variants.map((v) => {
              const args = v.args.map((te) => this.inf.resolveType(te, new Map(params)));
              const infos = args.map((arg) => this.reflectNode(arg, defs, span));
              return `{ "name": ${ev(v.name)}, "args": [${infos.join(", ")}] }`;
            });
            defs.set(key, `{ "name": ${ev(name)}, "variants": [${variants.join(", ")}] }`);
          }
          return meta("TRef", ev(key));
        }
        return meta("TUnknown", ev(typeStr(p)));
      }
      case "rec": {
        const fields = Object.entries(p.fields).map(
          ([name, field]) => `[${ev(name)}, ${this.reflectNode(field, defs, span)}]`,
        );
        return meta("TRecord", `[${fields.join(", ")}]`);
      }
      case "tuple":
        return meta("TTuple", `[${p.items.map((item) => this.reflectNode(item, defs, span)).join(", ")}]`);
      case "fun":
        return meta(
          "TFun",
          `[${p.params.map((param) => this.reflectNode(param, defs, span)).join(", ")}], ` +
          this.reflectNode(p.ret, defs, span),
        );
      case "app":
        return meta("TUnknown", ev(typeStr(p)));
      case "var":
        this.fail(
          `cannot reflect \`${typeStr(p)}\`: the type is still polymorphic. ` +
          `Annotate the value, or pass a Reflected value in from the caller`,
          span,
        );
    }
  }

  /** The static type of an auto-reflected value. */
  private staticType(arg: Expr, span?: { line?: number; col?: number; file?: string }): Type {
    const t = this.mod.info.get(arg)?.ty;
    if (!t) this.fail("cannot determine the type of this reflection argument", span ?? arg.span);
    return t;
  }

  /** The `a` in the `Result a Str` a decode call produces. */
  private decodedType(e: Expr, span?: { line?: number; col?: number; file?: string }): Type {
    const t = this.mod.info.get(e)?.ty;
    const p = t ? prune(t) : null;
    if (p && p.k === "con" && (p.name === "Result" || p.name.startsWith("Result$")) && p.args.length >= 2) {
      // `Result e a`: the success type is the last argument.
      const target = prune(p.args[p.args.length - 1]!);
      if (target.k === "var") {
        this.fail(
          "cannot infer the target type of Serialize.decode: annotate the result, " +
          "e.g. `let user :: Result Str User = Serialize.decode text`",
          span ?? e.span,
        );
      }
      return target;
    }
    this.fail(
      "Serialize.decode must produce `Result Str a`: annotate the result, " +
      "e.g. `let user :: Result Str User = Serialize.decode text`",
      span ?? e.span,
    );
  }

  /** `Reflect.meta`, `Serialize.encode/decode/...` are resolved from the static type. */
  private emitAutoReflection(
    e: Expr & { k: "App" },
    impl: string,
    side: Side,
    ctxHome: Side | "neutral",
    env: Set<string>,
  ): string | null {
    if (impl === "__flow.reflect.meta") {
      const value = e.args[0];
      if (!value) this.fail("Reflect.meta expects a value", e.span);
      return this.reflectJs(this.staticType(value, e.span), e.span);
    }
    if (!impl.startsWith("__flow.serialize.")) return null;
    const value = e.args[0];
    if (!value) {
      this.fail(
        `${impl.slice("__flow.serialize.".length)} is resolved from the static type and must be called with its argument; ` +
        `use the *With forms to pass a Reflected value`,
        e.span,
      );
    }
    const argument = this.val(value!, side, ctxHome, env);
    const encodeType = () => {
      const t = this.staticType(value!, e.span);
      this.assertSerializable(t, "Serialize.encode", e.span);
      return this.reflectJs(t, e.span);
    };
    const decodeType = () => {
      const t = this.decodedType(e, e.span);
      this.assertSerializable(t, "Serialize.decode", e.span);
      return this.reflectJs(t, e.span);
    };
    switch (impl) {
      case "__flow.serialize.encode":
        return `${this.stdlibFn("serialize.flow", "encodeWith")}(${encodeType()}, ${argument})`;
      case "__flow.serialize.toJson":
        return `${this.stdlibFn("serialize.flow", "toJsonWith")}(${encodeType()}, ${argument})`;
      case "__flow.serialize.decode":
        return `${this.stdlibFn("serialize.flow", "decodeWith")}(${decodeType()}, ${argument})`;
      case "__flow.serialize.fromJson":
        return `${this.stdlibFn("serialize.flow", "fromJsonWith")}(${decodeType()}, ${argument})`;
      default:
        this.fail(`internal: unknown serialization intrinsic ${impl}`, e.span);
    }
  }

  /** `main :: Html` is a single client page; `main :: ()` is server startup. */
  private mainKind(): "page" | "server" | null {
    const main = this.mod.fns.get("main");
    if (!main || main.scheme.k !== "fun") return null;
    const ret = prune(main.scheme.ret);
    if (ret.k === "con" && ret.name === "Html") return "page";
    if (ret.k === "con" && ret.name === "Unit") return "server";
    return null;
  }

  /** `main` is mounted by the renderer, outside any handler scope. */
  private checkEntryEffects(): void {
    const main = this.mod.fns.get("main");
    if (!main || main.scheme.k !== "fun") return;
    const unhandled = [...main.scheme.eff.labels].filter(
      (l) => this.isAlgebraic(l) && !this.mod.provides.has(l),
    );
    if (unhandled.length) {
      this.fail(
        `main performs effect(s) {${unhandled.sort().join(", ")}} without handling them: ` +
        `wrap the work in 'handle ${unhandled[0]} with … in …'`,
        main.span,
      );
    }
    if (this.mainKind() === "server" && main.body && this.home(main.body) === "client") {
      this.fail(
        "`main` returns () but only touches the browser; server startup must use a " +
        "server capability (Fs, Server, …) or call `serve`, or return Html for a single page",
        main.body.span,
      );
    }
    if (this.mainKind() === "server" && main.body && this.hasCallCut(main.body)) {
      this.fail(
        "`main` runs once on the server at startup and cannot wait on the browser: " +
        "move request-time work into the `serve` handler or a server function",
        main.body.span,
      );
    }
    if (this.servePage && this.mainKind() === "page") {
      this.fail(
        "`serve` needs `main :: ()`: a `main :: Html` program is already a single page. " +
        "Move the page into the serve handler and make main the server startup hook",
        main.span,
      );
    }
  }

  /** Give every shim module an import alias; the import is emitted per side. */
  private collectShims(): void {
    let n = 0;
    for (const [name, info] of this.mod.fns) {
      const ext = info.extern;
      if (!ext?.modulePath) continue;
      const file = path.resolve(path.dirname(info.span?.file ?? this.mod.file), ext.modulePath);
      if (!fs.existsSync(file)) {
        this.fail(`shim module not found: "${ext.modulePath}" (looked for ${file})`, info.span);
      }
      let entry = this.shims.get(file);
      if (!entry) {
        const base = path.basename(file);
        n += 1;
        entry = { alias: `$shim${n}`, name: `${n}-${base}`, ts: /\.ts$/.test(base), used: new Set() };
        this.shims.set(file, entry);
      }
      // the export must exist, otherwise the failure would only show at runtime
      if (ext.exportName && !hasExport(fs.readFileSync(file, "utf8"), ext.exportName)) {
        this.fail(
          `"${ext.modulePath}" does not export '${ext.exportName}' — ` +
          `add \`export function ${ext.exportName}\` (or \`export { ${ext.exportName} }\`) to the shim`,
          info.span,
        );
      }
      this.shimAlias.set(name, entry.alias);
    }
  }

  /** The shim files a build must copy: [source file, bundled name]. */
  shimModules(): [string, string][] {
    return [...this.shims].map(([file, s]) => [file, s.name]);
  }

  /** Reference to a shim export, recording which side needs the import. */
  private shimRef(declaring: string | undefined, modulePath: string, exportName: string, side: Side): string {
    const file = path.resolve(path.dirname(declaring ?? this.mod.file), modulePath);
    const entry = this.shims.get(file)!;
    entry.used.add(side);
    return `${entry.alias}.${exportName}`;
  }

  private emitModule(side: Side): string {
    const out: string[] = [];
    out.push(`// Generated by Flow. Do not edit.`);
    out.push(`// side: ${side}   cuts: ${this.cutList.length}`);
    out.push(side === "client" ? `import { R } from "/runtime/client.js";` : `import { R } from "./runtime/server-runtime.js";`);
    out.push("");

    for (const d of this.prog.decls) {
      if (d.k === "Fn") {
        if (d.name === this.serveConfigName) continue;
        const info = this.mod.fns.get(d.name);
        // A top-level value with an explicit placed type (`state :: Cell Int
        // @server`) owns that side even when its initializer is neutral.
        const retTy = info?.scheme.k === "fun" ? info.scheme.ret : undefined;
        const declared = info?.retPlace ?? (retTy ? typePlace(retTy) : "neutral");
        const h = this.home(d.body);
        const home = h === "neutral" && declared !== "neutral" && declared !== "cross" ? declared : h;
        if (home === side || home === "neutral") out.push(this.emitFn(d.name, d.params, d.body, side, info?.dicts));
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
              `provider for capability ${d.effect}.${o.name} cannot perform an effect: ` +
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
      const gen = this.rowHasAlgebraic(this.effOf(cut.node));
      const nestedCall = this.hasCallCut(cut.node, true);
      if (gen && nestedCall) {
        this.fail(
          "a cut that performs an effect cannot also contain a request/response cut",
          cut.node.span,
        );
      }
      this.emitting.add(cut.node);
      const savedGen = this.genMode;
      if (gen) this.genMode = true;
      let body: string;
      try {
        body = this.emitExpr(cut.serverNode ?? cut.node, side, side, new Set(cut.deps));
      } finally {
        this.genMode = savedGen;
        this.emitting.delete(cut.node);
      }
      const destructure = cut.deps.length ? `const { ${cut.deps.join(", ")} } = A;` : "";
      const asyncKw = !gen && nestedCall ? "async " : "";
      const runner = gen ? `(function* () { return ${body}; })()` : body;
      out.push(`R.serve(${ev(cut.id)}, ${asyncKw}(A) => { ${destructure} return ${runner}; });`);
    }

    // The page handler is a client value; emit it before the shim imports so
    // its shim references are included in the import check.
    if (side === "client" && this.servePage) {
      const handlerJs = this.emitExpr(this.servePage, "client", "client", new Set());
      out.push("");
      out.push(`const $serve = ${handlerJs};`);
    }

    for (const [file, shim] of this.shims) {
      if (!shim.used.has(side)) continue;
      if (shim.ts && side === "client") {
        this.fail(
          `the shim ${path.basename(file)} is TypeScript, which the browser cannot load; ` +
          `annotate its bindings @server or compile it to .js`,
        );
      }
      out.push(`import * as ${shim.alias} from "./modules/${shim.name}";`);
    }

    if (side === "client") {
      out.push("");
      if (this.servePage) {
        out.push(`export async function __flow_start(root, request) {`);
        out.push(`  const page = await R.runAsync(() => $serve(request));`);
        out.push(`  R.mount(root, () => page);`);
        out.push(`}`);
      } else if (this.mainKind() === "server") {
        // An API-only program has no client page; the shell stays empty.
        out.push(`export function __flow_start(root) { R.mount(root, () => null); }`);
      } else {
        out.push(`export async function __flow_start(root) {`);
        out.push(`  const page = await R.runAsync(() => main());`);
        out.push(`  R.mount(root, () => R.v(page));`);
        out.push(`}`);
      }
      out.push(`export { R };`);
    } else {
      if (this.mainKind() === "server") {
        out.push("");
        out.push(`export { main as __flow_entry };`);
      }
      if (this.servePage) {
        out.push(`export const __flow_serve = true;`);
      }
      // Legacy entry point: new programs pass `routes` inside `serve`, which
      // registers them during `main`. Keep `routes()` working for old apps.
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
    this.currentDicts = new Map((dicts ?? []).map((d) => [dictKey(d.trait, d.varId), d.name]));
    const info = this.mod.fns.get(name);
    const gen =
      this.generatorFns.has(name) ||
      this.rowHasAlgebraic(this.mod.info.get(body)?.eff);
    if (gen && this.hasCallCut(body)) {
      this.fail(
        `fn ${name} both performs an effect and needs a request/response cut; ` +
        `handle the effect before the cut`,
        body.span,
      );
    }
    this.genMode = gen;
    let js: string;
    try {
      js = this.emitExpr(body, side, side, env);
    } finally {
      this.currentDicts = savedDicts;
      this.genMode = savedGen;
    }
    const asyncKw = this.hasCallCut(body) ? "async " : "";
    const allParams = [...params.map((p) => p.name), ...dictParams];
    // A cell-typed value is evaluated once. A top-level server cell must be the
    // same object on every read, otherwise writes would land in a fresh cell
    // that the next read never sees. Other top-level values stay re-evaluated
    // so a derived expression can remain reactive.
    const ret = info?.scheme.k === "fun" ? prune(info.scheme.ret) : undefined;
    const isCellValue = Boolean(ret && ret.k === "con" && ret.name === "Cell");
    if (allParams.length === 0 && !gen && !asyncKw && isCellValue) {
      const slot = `__flow_v_${name}`;
      return `let ${slot};\nfunction ${name}() { if (${slot} === undefined) ${slot} = ${js}; return ${slot}; }`;
    }
    return `${asyncKw}function${gen ? "*" : ""} ${name}(${allParams.join(", ")}) { return ${js}; }`;
  }

  /** A binding may not create a cell bound to the other tier. */
  private checkCellBinding(
    name: string,
    ty: Type | undefined,
    side: Side,
    span?: { line: number; col: number },
  ) {
    if (!ty) return;
    const p = prune(ty);
    if (p.k !== "con" || p.name !== "Cell") return;
    if (!p.place || p.place === "neutral" || p.place === side) return;
    this.fail(
      `'${name}' is a ${p.place}-bound cell; declare it at the top level ` +
        `(\`${name} :: ${typeStr(p)}\`) so reads and writes become ${p.place} cuts`,
      span,
    );
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
    // Binding for the effect it performs (`let cancel = Timer.every(…)`) must run
    // even if the variable is never read; the effect is the point.
    const eff = this.effOf(e.value);
    if (eff && eff.labels.size > 0) return true;
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
    // A cut node currently being emitted is the call's target, not a call site;
    // its own `await` belongs to the caller.
    if (c && !skipSelf && !this.emitting.has(e)) return c.mode === "call";
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
        const traitChoice = this.mod.implChoices.get(e);
        if (traitChoice) return `${traitChoice.mangled}()`;
        const traitBound = this.mod.boundChoices.get(e);
        if (traitBound) return `${traitBound.dictName}.${traitBound.method}()`;
        if (!env.has(e.name)) {
          const ctor = this.mod.ctors.get(e.name);
          if (ctor) {
            // A constructor referenced through a path (`flow::option::Some`) is a
            // value, not a JS function.
            if (ctor.arity === 0) return `R.ctor(${ev(e.name)}, [])`;
            return `((...$ctorArgs) => R.ctor(${ev(e.name)}, $ctorArgs))`;
          }
        }
        const info = this.mod.fns.get(e.name);
        const ext = info?.extern;
        if (ext && !env.has(e.name)) {
          if (ext.implName.startsWith("__flow.reflect.") || ext.implName.startsWith("__flow.serialize.") || ext.implName.startsWith("__flow.serve")) {
            this.fail(
              ext.implName.startsWith("__flow.serve")
                ? "`serve`, `servePage` and `serveApi` must be called directly with their config"
                : `'${e.name}' is resolved from the static type at a call site and cannot be used as a value; ` +
                  `pass Reflect.meta or an explicit *With function instead`,
              e.span,
            );
          }
          if (ext.modulePath && ext.exportName) {
            return this.shimRef(info!.span?.file, ext.modulePath, ext.exportName, side);
          }
          return `R.ffiFn(${ev(ext.implName)})`;
        }
        // a top-level constant (`pi = 3.14`) is a nullary function: read its value
        if (!env.has(e.name) && this.mod.constRefs.has(e)) {
          const call = `${e.name}()`;
          const info = this.mod.fns.get(e.name);
          if (this.generatorFns.has(e.name) || (info?.body && this.callsGenerator(info.body))) {
            return this.genMode ? `(yield* R.genCall(() => ${call}))` : `R.run(${call})`;
          }
          return call;
        }
        // a local that shadows a top-level name was renamed when it was bound
        return env.has(e.name) ? (this.localNames.get(e.name) ?? e.name) : e.name;
      }
      case "Lam": {
        const inner = new Set(env);
        for (const p of e.params) inner.add(p.name);
        const gen =
          this.typeHasAlgebraic(this.mod.info.get(e)?.ty) ||
          this.callsFunctionParam(e.body, new Set(e.params.map((p) => p.name)));
        if (gen && this.hasCallCut(e.body)) {
          this.fail("a function that performs an effect cannot also contain a request/response cut", e.span);
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
        this.checkCellBinding(e.name, this.mod.info.get(e.value)?.ty, side, e.value.span);
        const gen = this.genMode || this.rowHasAlgebraic(this.effOf(e));
        if (gen) {
          if (this.hasCallCut(e)) this.fail("a block that performs an effect cannot also contain a request/response cut", e.span);
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
        // a binder that shadows a top-level function (`let args = Env.args ()`)
        // would capture its own initializer, so the local gets a distinct name
        const shadows = !env.has(e.name) && (this.mod.fns.has(e.name) || this.mod.ctors.has(e.name));
        const bindName = shadows ? `${e.name}$local` : e.name;
        const inner = new Set(env); inner.add(e.name);
        // a local function may call itself, so its own name is in scope while its
        // body is emitted (and the binding is a real function, not a lazy node)
        const selfRec = e.value.k === "Lam";
        const vJs = this.emitExpr(e.value, side, ctxHome, selfRec ? inner : env);
        const bind = this.hasCallCut(e.value) || this.isEagerLet(e) || selfRec
          ? `const ${bindName} = ${vJs};`
          : `const ${bindName} = R.sig(() => ${vJs});`;
        const previousName = this.localNames.get(e.name);
        if (shadows) this.localNames.set(e.name, bindName);
        const bodyJs = this.emitExpr(e.body, side, ctxHome, inner);
        if (shadows) {
          if (previousName === undefined) this.localNames.delete(e.name);
          else this.localNames.set(e.name, previousName);
        }
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
        if (this.mod.adtProjections.has(e)) {
          return `R.v(${this.emitExpr(e.target, side, ctxHome, env)}).args[0].${e.name}`;
        }
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
   * enclosing handler when the body performs an outer effect.
   */
  private emitHandle(
    e: Expr & { k: "Handle" },
    side: Side,
    ctxHome: Side | "neutral",
    env: Set<string>,
  ): string {
    if (this.mod.effects.has(e.effect)) {
      const ops = e.ops
        .map((op) => `${ev(op.name)}: ${this.emitAlgebraicOp(op, side, ctxHome, env)}`)
        .join(", ");
      const cutBody = this.hasCallCut(e.body);
      const savedGen = this.genMode;
      const hadHandler = this.currentHandledEffects.has(e.effect);
      this.currentHandledEffects.add(e.effect);
      this.genMode = !cutBody;
      let bodyJs: string;
      try {
        bodyJs = this.emitExpr(e.body, side, ctxHome, env);
      } finally {
        this.genMode = savedGen;
        if (!hadHandler) this.currentHandledEffects.delete(e.effect);
      }
      const bodyFn = cutBody ? `async () => ${bodyJs}` : `function* () { return ${bodyJs}; }`;
      const call = `R.handle(${ev(e.effect)}, { ${ops} }, ${bodyFn})`;
      if (cutBody) {
        const drive = `R.runAsync(${call})`;
        return this.genMode ? `(yield ${drive})` : `(await ${drive})`;
      }
      return this.genMode ? `(yield* ${call})` : `R.run(${call})`;
    }

    const ops = e.ops
      .map((op) => {
        if (this.rowHasAlgebraic(this.effOf(op.fn))) {
          this.fail(
            `provider for capability ${e.effect}.${op.name} cannot perform an effect: ` +
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

  /**
   * A reactive cut has no value until the first wire message. Give it a
   * type-appropriate placeholder so the initial render does not pattern-match
   * `undefined` (for example, `map (get serverCell) $ ...` on an empty list).
   */
  private initialFor(t: Type | undefined): string | undefined {
    if (!t) return undefined;
    const p = prune(t);
    if (p.k === "tuple") {
      const items = p.items.map((i) => this.initialFor(i));
      return items.some((x) => x === undefined) ? undefined : `[${items.join(", ")}]`;
    }
    if (p.k === "rec") {
      const fields = Object.entries(p.fields).map(([k, v]) => [k, this.initialFor(v)] as const);
      return fields.some(([, v]) => v === undefined)
        ? undefined
        : `{ ${fields.map(([k, v]) => `${ev(k)}: ${v}`).join(", ")} }`;
    }
    if (p.k !== "con") return undefined;
    switch (p.name) {
      case "List": return "[]";
      case "Str": return '""';
      case "Int": case "Float": return "0";
      case "Bool": return "false";
      case "Unit": return "null";
      case "Option": return 'R.ctor("None", [])';
      case "Json": return 'R.ctor("JNull", [])';
      case "Html": case "Dom": case "Event": case "Cell": return "null";
      default: return "null";
    }
  }

  private emitCutRef(cut: CutInfo): string {
    const deps = cut.deps.length ? `{ ${cut.deps.map((d) => `${ev(d)}: ${d}`).join(", ")} }` : "{}";
    if (cut.mode === "call") return `(await R.call(${ev(cut.id)}, ${deps}))`;
    const initial = cut.initial !== undefined ? `, ${cut.initial}` : "";
    return `R.remote(${ev(cut.id)}, () => (${deps})${initial})`;
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
    // `serve` is a build-time entry point. The server registers the plain
    // `routes` data at startup; the browser mounts the page (separately).
    if (this.isServeCall(e)) {
      if (side === "server" && this.serveRoutes) {
        const routes = this.val(this.serveRoutes, "server", "server", env);
        return `R.ffiCall("__flow.host.routes", [${routes}])`;
      }
      return "null";
    }

    // Reflection and the auto serializers are resolved from the static type.
    const impl = this.implOf(e.fn);
    if (impl) {
      const auto = this.emitAutoReflection(e, impl, side, ctxHome, env);
      if (auto !== null) return auto;
    }

    // `resume(v)` inside an algebraic operation handler: the continuation.
    if (e.fn.k === "Var" && this.mod.resumeVars.has(e.fn)) {
      const args = e.args.map((a) => this.val(a, side, ctxHome, env)).join(", ");
      return this.yieldStar(`resume(${args})`, e.span, `resume`);
    }
    if (this.mod.partialCalls.has(e)) return this.emitPartialApp(e, side, ctxHome, env);

    const genCall = (js: string, force = false): string => {
      const mayGen = force || this.mod.genCalls.has(e) || this.calleeMayGenerate(e);
      if (!mayGen) return js;
      if (this.genMode) {
        // Evaluate the call (including any yield-bearing arguments) inside the
        // generator, then drive a generator result if there is one.
        const v = `$g${++this.tmp}`;
        return `(yield* (function* () { const ${v} = ${js}; return ${v} && typeof ${v}.next === "function" ? (yield* ${v}) : ${v}; })())`;
      }
      return this.mod.genCalls.has(e) ? `R.runAsync(${js})` : `R.run(${js})`;
    };

    const bound = this.mod.boundChoices.get(e);
    if (bound) {
      const qn = e.fn.k === "Field" ? this.qualNameOf(e.fn.target) : null;
      const qualified = qn && (this.mod.traits.has(qn) || this.mod.effects.has(qn));
      let parts = e.args.map((a) => this.emitExpr(a, side, ctxHome, env));
      if (e.fn.k === "Field" && !qualified) {
        parts = this.withReceiver(parts, bound.trait, bound.method, this.emitExpr(e.fn.target, side, ctxHome, env));
      }
      const traitMayGen =
        this.generatorTraitMethods.has(`${bound.trait}.${bound.method}`) ||
        this.generatorTraitMethods.has(`${traitBase(bound.trait)}.${bound.method}`);
      return genCall(`${bound.dictName}.${bound.method}(${parts.join(", ")})`, traitMayGen);
    }

    const choice = this.mod.implChoices.get(e);
    if (choice) {
      // A method call carries its receiver outside `e.args`; a qualified trait
      // call (`Trait.method(x, …)`) already has it in the argument list. Put the
      // receiver in its dispatch slot, whatever the method's parameter order is.
      const qn = e.fn.k === "Field" ? this.qualNameOf(e.fn.target) : null;
      const qualified = qn && (this.mod.traits.has(qn) || this.mod.effects.has(qn));
      let parts = e.args.map((a) => this.emitExpr(a, side, ctxHome, env));
      if (e.fn.k === "Field" && !qualified) {
        parts = this.withReceiver(parts, choice.impl.trait, choice.method, this.emitExpr(e.fn.target, side, ctxHome, env));
      }
      for (const d of choice.dicts ?? []) parts.push(this.emitDict(d.trait, d.type));
      const traitMayGen =
        this.generatorFns.has(choice.mangled) ||
        this.generatorTraitMethods.has(`${choice.impl.trait}.${choice.method}`) ||
        this.generatorTraitMethods.has(`${traitBase(choice.impl.trait)}.${choice.method}`);
      return genCall(`${choice.mangled}(${parts.join(", ")})`, traitMayGen);
    }

    const args = e.args.map((a) => this.val(a, side, ctxHome, env)).join(", ");

    // `unsafe extern js fn` — call the host directly, or a shim module export
    if (e.fn.k === "Var") {
      const info = this.mod.fns.get(e.fn.name);
      const ext = info?.extern;
      if (ext && !env.has(e.fn.name)) {
        // `__flow.get` / `__flow.set` take the Cell itself, not its value.
        const cellPrim = ext.implName === "__flow.get" || ext.implName === "__flow.set";
        const externalArgs = e.args
          .map((a, i) => (cellPrim && i === 0
            ? this.emitExpr(a, side, ctxHome, env)
            : this.val(a, side, ctxHome, env)))
          .join(", ");
        if (ext.modulePath && ext.exportName) {
          return `${this.shimRef(info!.span?.file, ext.modulePath, ext.exportName, side)}(${externalArgs})`;
        }
        return `R.ffiCall(${ev(ext.implName)}, [${externalArgs}])`;
      }
    }

    const qual = e.fn.k === "Field" ? this.qualNameOf(e.fn.target) : null;
    if (e.fn.k === "Field" && qual && this.mod.effects.has(qual)) {
      if (this.isAlgebraic(qual) || this.currentHandledEffects.has(qual)) {
        return this.perform(qual, e.fn.name, args, e.span);
      }
      return `R.op(${ev(qual)}, ${ev(e.fn.name)})(${args})`;
    }
    if (e.fn.k === "Var") {
      const qual = this.effectOfOp(e.fn.name);
      if (qual && !env.has(e.fn.name) && !this.mod.fns.has(e.fn.name)) {
        if (this.isAlgebraic(qual) || this.currentHandledEffects.has(qual)) {
          return this.perform(qual, e.fn.name, args, e.span);
        }
        return `R.op(${ev(qual)}, ${ev(e.fn.name)})(${args})`;
      }
    }
    const dicts = e.fn.k === "Var" ? this.mod.dictArgs.get(e) ?? [] : [];
    const callArgs = [args, ...dicts.map((d) => this.emitDict(d.trait, d.type))]
      .filter((x) => x.length > 0)
      .join(", ");
    return genCall(`${this.calleeJs(e.fn, side, ctxHome, env)}(${callArgs})`);
  }

  /** Place a method receiver in its trait dispatch slot. */
  private withReceiver(parts: string[], traitName: string, method: string, receiver: string): string[] {
    const tr = this.mod.traits.get(traitName);
    const m = tr?.methods.get(method);
    const di = tr && m ? this.inf.dispatchIndex(tr, m.ty) : 0;
    parts.splice(Math.max(0, di), 0, receiver);
    return parts;
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
      const info2 = this.mod.fns.get(e.fn.name);
      const ext = info2?.extern;
      fnJs = ext && !env.has(e.fn.name)
        ? (ext.modulePath && ext.exportName
          ? this.shimRef(info2!.span?.file, ext.modulePath, ext.exportName, side)
          : `R.ffiFn(${ev(ext.implName)})`)
        : this.calleeJs(e.fn, side, ctxHome, env);
      provided = e.args.map((a) => this.val(a, side, ctxHome, env));
    } else {
      fnJs = this.emitExpr(e.fn, side, ctxHome, env);
      provided = e.args.map((a) => this.val(a, side, ctxHome, env));
    }

    const rightLead = this.mod.rightPartials.get(e) ?? 0;
    const args = rightLead > 0
      ? [`...${restVar}`, ...provided, ...suffix].join(", ")
      : [...provided, `...${restVar}`, ...suffix].join(", ");
    const call = `${fnVar}(${args})`;
    const mayGen = this.typeHasAlgebraic(this.mod.info.get(e)?.ty);
    if (mayGen) {
      return `((${fnVar}) => function* (...${restVar}) { return yield* R.genCall(() => ${call}); })(${fnJs})`;
    }
    return `((${fnVar}) => (...${restVar}) => ${call})(${fnJs})`;
  }

  /** Emit a dictionary object for a trait instance, closing over inner
   *  dictionaries when the instance itself is generic with bounds. */
  private emitDict(trait: string, type: Type): string {
    const t = prune(type);
    if (t.k === "var") {
      const name = this.currentDicts.get(dictKey(trait, t.id)) ?? (t.origin !== undefined ? this.currentDicts.get(dictKey(trait, t.origin)) : undefined);
      if (name) return name;
      // The variable may be a fresh alias whose origin was lost during
      // unification; if this function carries a dictionary for the same trait,
      // that is the dictionary to pass.
      const fallback = [...this.currentDicts.values()].find((n) => n.startsWith(`$d_${traitBase(trait)}_`));
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
      const bound = this.mod.boundChoices.get(e);
      const choice = bound ? undefined : this.mod.implChoices.get(e);
      if (!bound && !choice) this.fail("internal: '>>=' was not resolved to a Monad instance", e.span);
      const k = this.emitExpr(e.r, side, ctxHome, env);
      const value = this.val(e.l, side, ctxHome, env);
      const js = bound
        ? `${bound.dictName}.bind(${k}, ${value})`
        : `${choice!.mangled}(${k}, ${value})`;
      // bind may be a generator (its callback can perform effects). Drive it
      // here, in the caller's generator/async context.
      if (this.genMode) {
        const v = `$g${++this.tmp}`;
        return `(yield* (function* () { const ${v} = ${js}; return ${v} && typeof ${v}.next === "function" ? (yield* ${v}) : ${v}; })())`;
      }
      return `R.run(${js})`;
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
    if (e.op === "++") {
      // `++` is Flow's append. JavaScript has no such operator: str ++ str is
      // `+`, and list ++ list concatenates arrays.
      const t = prune(this.mod.info.get(e)?.ty ?? { k: "var", id: -1, level: 0 });
      if (t.k === "con" && t.name === "Str") return `(${l} + ${r})`;
      return `R.ffiCall("@concat", [${l}, ${r}])`;
    }
    return `(${l} ${op} ${r})`;
  }

  private emitMatch(e: Expr & { k: "Match" }, side: Side, ctxHome: Side | "neutral", env: Set<string>): string {
    const gen = this.genMode || this.rowHasAlgebraic(this.effOf(e));
    if (gen && this.hasCallCut(e)) {
      this.fail("a match that performs an effect cannot also contain a request/response cut", e.span);
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
        const target = this.mod.recordAdtPatterns.has(p) ? `${t}.args[0]` : t;
        const fs = p.fields.map((f) => ({ q: f.pat, r: `${target}[${ev(f.name)}]` }));
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
      this.fail("a block that performs an effect cannot also contain a request/response cut", e.span);
    }
    const savedGen = this.genMode;
    if (gen) this.genMode = true;
    const stmts: string[] = [];
    const inner = new Set(env);
    for (const s of e.stmts) {
      if (s.k === "LetStmt") {
        this.checkCellBinding(s.name, this.mod.info.get(s.value)?.ty, side, s.value.span);
        // a binder that shadows a top-level function would capture its own
        // initializer (`let args = Env.args ()`), so give the local a new name
        const shadows = !inner.has(s.name) && (this.mod.fns.has(s.name) || this.mod.ctors.has(s.name));
        const bindName = shadows ? `${s.name}$local` : s.name;
        const v = this.emitExpr(s.value, side, ctxHome, inner);
        if (shadows) this.localNames.set(s.name, bindName);
        const eager = gen || this.hasCallCut(s.value) || this.isEagerLet(s) || s.value.k === "Lam";
        stmts.push(eager ? `const ${bindName} = ${v};` : `const ${bindName} = R.sig(() => ${v});`);
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
            "an effect cannot be performed in an HTML hole: holes are evaluated lazily, " +
            "outside the handler's scope. Handle the effect before the hole.",
            n.span,
          );
        }
        return `R.hole(${this.hasCallCut(n.e) ? "async " : ""}() => ${this.emitExpr(n.e, side, ctxHome, env)})`;
      case "Element": {
        const attrs = n.attrs.map((a) => {
          if (a.name.startsWith("on") && a.value.k === "expr") {
            // The DOM listener drives generators with `R.runAsync`, so the
            // listener can install its own handler or forward an effect from a
            // cut to a handler in its lexical scope.
            return `${ev("on:" + a.name.slice(2).toLowerCase())}: ${this.emitExpr(a.value.e, side, ctxHome, env)}`;
          }
          if (a.value.k === "static") return `${ev(a.name)}: ${ev(a.value.v)}`;
          if (this.rowHasAlgebraic(this.effOf(a.value.e))) {
            this.fail(
              `an effect cannot be performed in the '${a.name}' attribute: attributes are ` +
              `evaluated lazily. Handle the effect before the attribute.`,
              n.span,
            );
          }
          return `${ev(a.name)}: R.attr(${this.hasCallCut(a.value.e) ? "async " : ""}() => ${this.emitExpr(a.value.e, side, ctxHome, env)})`;
        });
        const kids = n.children.map((c) => this.emitHtmlNode(c, side, ctxHome, env)).filter((x) => x !== "null");
        return `R.el(${ev(n.tag)}, { ${attrs.join(", ")} }, [${kids.join(", ")}])`;
      }
      case "Component": {
        if (this.rowHasAlgebraic(this.effOf(n))) {
          this.fail(
            `component '${n.name}' performs an effect without handling it: components are ` +
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

/** Whether a JS/TS module text exports `name` (a cheap but useful guard). */
function hasExport(src: string, name: string): boolean {
  const n = name.replace(/[^A-Za-z0-9_$]/g, "");
  if (!n) return false;
  const patterns = [
    new RegExp(`export\\s+(?:async\\s+)?function\\s+${n}\\b`),
    new RegExp(`export\\s+(?:const|let|var|class)\\s+${n}\\b`),
    new RegExp(`export\\s*\\{[^}]*\\b${n}\\b`),
    new RegExp(`export\\s+default\\s+${n}\\b`),
  ];
  return patterns.some((re) => re.test(src));
}

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

/**
 * Flow — pretty printer. Turns an AST back into Haskell-style source.
 *
 * It is the formatter (`flow fmt`) and the back end of `flow migrate`, which
 * rewrites programs written in the old Rust-style syntax.
 */

import type {
  Decl, EffRow, Expr, FnSig, HtmlAttr, HtmlNode, MatchArm, Param, Pattern, Program, Stmt, TypeExpr,
} from "./ast.ts";

export interface PrintOptions {
  /** module name when the source has no parsed header (used by migrate) */
  moduleName?: string;
  /** comment lines to emit above the declaration that starts on a given line */
  comments?: Map<number, string[]>;
  /** line width at which `if` / lists are broken up */
  width?: number;
}

const OP_PREC: Record<string, { prec: number; right: boolean }> = {
  "||": { prec: 2, right: true }, "&&": { prec: 3, right: true },
  "==": { prec: 4, right: false }, "!=": { prec: 4, right: false },
  "<": { prec: 4, right: false }, "<=": { prec: 4, right: false },
  ">": { prec: 4, right: false }, ">=": { prec: 4, right: false },
  "++": { prec: 5, right: true },
  "+": { prec: 6, right: false }, "-": { prec: 6, right: false },
  "*": { prec: 7, right: false }, "/": { prec: 7, right: false }, "%": { prec: 7, right: false },
  ">>=": { prec: 1, right: false },
};

const sp = (n: number) => " ".repeat(n);
const isWild = (t: TypeExpr) => t.k === "TVar" && t.name === "_";

/* ------------------------------------------------------------------ */
/* types                                                              */
/* ------------------------------------------------------------------ */

export function printType(t: TypeExpr, prec = 0): string {
  switch (t.k) {
    case "TVar": return t.name;
    case "TCon": {
      if (t.name === "Unit" && !t.args.length) return "()";
      if (!t.args.length) return t.name;
      const s = `${t.name} ${t.args.map((a) => printType(a, 2)).join(" ")}`;
      return prec >= 2 ? `(${s})` : s;
    }
    case "TFun": {
      const params = t.params.map((p) => printType(p, 1)).join(" -> ");
      let s = `${params} -> ${printType(t.ret, 0)}`;
      if (t.eff && (t.eff.written || t.eff.effects.length || t.eff.var)) s += ` ! ${printEff(t.eff)}`;
      return prec >= 1 ? `(${s})` : s;
    }
    case "TRecord": return `{ ${t.fields.map((f) => `${f.name} :: ${printType(f.type)}`).join(", ")} }`;
    case "TTuple": return `(${t.items.map((i) => printType(i)).join(", ")})`;
    case "TPlaced": {
      const s = `${printType(t.inner, 2)} @${t.place}`;
      return prec >= 1 ? `(${s})` : s;
    }
  }
}

function printEff(e: EffRow): string {
  const parts = [...e.effects];
  if (e.var) parts.push(e.var);
  return parts.length === 1 && !e.var ? parts[0]! : `{${parts.join(", ")}}`;
}

function context(bounds: Record<string, string[]> | undefined): string {
  const entries: string[] = [];
  for (const [v, bs] of Object.entries(bounds ?? {})) for (const b of bs) entries.push(`${b} ${v}`);
  if (!entries.length) return "";
  return entries.length === 1 ? `${entries[0]} => ` : `(${entries.join(", ")}) => `;
}

/** `a -> b -> c` for a function's parameters and result. */
function sigType(params: Param[], ret: TypeExpr | undefined, eff: EffRow | undefined, span: TypeExpr["span"]): string {
  const r = ret ?? { k: "TCon", name: "Unit", args: [], span } as TypeExpr;
  if (!params.length) return printType(r);
  return printType({ k: "TFun", params: params.map((p) => p.type), ret: r, eff: eff ?? { effects: [] }, span });
}

/* ------------------------------------------------------------------ */
/* patterns                                                           */
/* ------------------------------------------------------------------ */

export function printPattern(p: Pattern, atom = false): string {
  switch (p.k) {
    case "PWild": return "_";
    case "PVar": return p.ann ? `(${p.name} :: ${printType(p.ann)})` : p.name;
    case "PLit": {
      const l = p.lit;
      if (l.k === "Int") return l.v < 0 ? `(${l.v})` : String(l.v);
      if (l.k === "Float") return l.v < 0 ? `(${floatStr(l.v)})` : floatStr(l.v);
      if (l.k === "Str") return quote(l.v);
      if (l.k === "Bool") return l.v ? "True" : "False";
      return "()";
    }
    case "PCtor": {
      if (!p.args.length) return p.name;
      const s = `${p.name} ${p.args.map((a) => printPattern(a, true)).join(" ")}`;
      return atom ? `(${s})` : s;
    }
    case "PTuple": return `(${p.items.map((i) => printPattern(i)).join(", ")})`;
    case "PList": {
      if (p.rest === undefined) return `[${p.items.map((i) => printPattern(i)).join(", ")}]`;
      const s = [...p.items.map((i) => printPattern(i, true)), p.rest.startsWith("_r") ? "_" : p.rest].join(" : ");
      return atom ? `(${s})` : s;
    }
    case "PRecord":
      return `{ ${p.fields.map((f) => (f.pat.k === "PVar" && f.pat.name === f.name && !f.pat.ann ? f.name : `${f.name} = ${printPattern(f.pat)}`)).join(", ")} }`;
  }
}

function floatStr(v: number): string {
  return Number.isInteger(v) ? `${v}.0` : String(v);
}

function quote(s: string): string {
  let out = '"';
  for (const ch of s) {
    out += ch === "\n" ? "\\n" : ch === "\t" ? "\\t" : ch === "\r" ? "\\r" : ch === "\0" ? "\\0" : ch === "\\" ? "\\\\" : ch === '"' ? '\\"' : ch;
  }
  return out + '"';
}

/* ------------------------------------------------------------------ */
/* expressions                                                        */
/* ------------------------------------------------------------------ */

const ARG = 11;
const FN = 10;

class Printer {
  width: number;
  constructor(width = 90) { this.width = width; }

  private multi(s: string) { return s.includes("\n"); }

  private isAtom(e: Expr): boolean {
    switch (e.k) {
      case "Lit": return !((e.lit.k === "Int" || e.lit.k === "Float") && e.lit.v < 0);
      case "Var": return true;
      case "Ctor": return e.args.length === 0;
      case "Tuple": case "List": case "Record": return true;
      case "Field": return this.isAtom(e.target);
      default: return false;
    }
  }

  /** parenthesize `e` when it cannot appear in a context with this precedence */
  e(x: Expr, ind: number, ctx = 0): string {
    const s = this.raw(x, ind, ctx);
    return this.needsParens(x, ctx, s) ? `(${s})` : s;
  }

  private needsParens(x: Expr, ctx: number, printed: string): boolean {
    if (ctx === 0 || this.isAtom(x)) return false;
    if (x.k === "Html") return ctx >= FN && this.multi(printed);
    if (ctx >= FN) return true;
    // operand of a binary operator
    switch (x.k) {
      case "Binary": {
        const info = OP_PREC[x.op]!;
        return info.prec < ctx;
      }
      case "App": case "Ctor": case "Unary": return false;
      default: return true;
    }
  }

  private raw(x: Expr, ind: number, ctx: number): string {
    switch (x.k) {
      case "Lit": {
        const l = x.lit;
        if (l.k === "Int") return l.v < 0 ? `-${-l.v}` : String(l.v);
        if (l.k === "Float") return l.v < 0 ? `-${floatStr(-l.v)}` : floatStr(l.v);
        if (l.k === "Str") return quote(l.v);
        if (l.k === "Bool") return l.v ? "True" : "False";
        return "()";
      }
      case "Var": return x.name;
      case "Ctor":
        return x.args.length ? `${x.name} ${x.args.map((a) => this.e(a, ind, ARG)).join(" ")}` : x.name;
      case "Lam": {
        // Pattern lambdas are desugared to `\_aN -> case _aN of pat -> body`.
        // Print the source shape back when it is the only parameter and arm.
        const param = x.params[0];
        if (
          x.params.length === 1 &&
          param &&
          /^_[a-z]\d+$/.test(param.name) &&
          x.body.k === "Match" &&
          x.body.scrut.k === "Var" &&
          x.body.scrut.name === param.name &&
          x.body.arms.length === 1 &&
          !x.body.arms[0]!.guard &&
          !x.ret && !x.eff
        ) {
          return `\\${printPattern(x.body.arms[0]!.pat)} -> ${this.e(x.body.arms[0]!.body, ind, 0)}`;
        }
        const ps = x.params.map((p) => this.lamParam(p, x.body)).join(" ");
        return `\\${ps} -> ${this.e(x.body, ind, 0)}`;
      }
      case "App": {
        const fn = this.e(x.fn, ind, FN);
        return `${fn} ${x.args.map((a) => this.e(a, ind, ARG)).join(" ")}`;
      }
      case "If": {
        const c = this.e(x.cond, ind, 0), t = this.e(x.then, ind + 2, 0), f = this.e(x.else, ind + 2, 0);
        const one = `if ${c} then ${t} else ${f}`;
        if (!this.multi(one) && one.length + ind <= this.width) return one;
        return `if ${c}\n${sp(ind + 2)}then ${t}\n${sp(ind + 2)}else ${f}`;
      }
      case "Match": {
        const alts = x.arms.map((a) => this.arm(a, ind + 2));
        return `case ${this.e(x.scrut, ind, 0)} of\n${alts.map((a) => sp(ind + 2) + a).join("\n")}`;
      }
      case "Let": return this.letExpr(x, ind);
      case "Record":
        return x.fields.length ? `{ ${x.fields.map((f) => `${f.name} = ${this.e(f.value, ind, 0)}`).join(", ")} }` : "{}";
      case "Field": return `${this.e(x.target, ind, ARG)}.${x.name}`;
      case "Tuple": return `(${x.items.map((i) => this.e(i, ind, 0)).join(", ")})`;
      case "List": {
        const items = x.items.map((i) => this.e(i, ind + 2, 0));
        const one = `[${items.join(", ")}]`;
        if (!this.multi(one) && one.length + ind <= this.width) return one;
        return `[ ${items.join(`\n${sp(ind + 2)}, `)}\n${sp(ind + 2)}]`;
      }
      case "Binary": {
        const info = OP_PREC[x.op] ?? { prec: 4, right: false };
        const lp = info.right ? info.prec + 1 : info.prec;
        const rp = info.right ? info.prec : info.prec + 1;
        const op = x.op === "!=" ? "/=" : x.op;
        return `${this.e(x.l, ind, lp)} ${op} ${this.e(x.r, ind, rp)}`;
      }
      case "Unary": {
        const inner = this.e(x.e, ind, ARG);
        return `-${inner}`;
      }
      case "Html": return this.htmlExpr(x.nodes, ind);
      case "Assign": {
        const op = x.op === "=" ? ":=" : x.op;
        return `${this.e(x.target, ind, ARG)} ${op} ${x.value ? this.e(x.value, ind, 0) : "()"}`;
      }
      case "Handle": {
        const ops = x.ops.map((o) => this.clause(o.name, o.fn, ind + 2));
        return `handle ${x.effect} with\n${ops.map((o) => sp(ind + 2) + o).join("\n")}\n${sp(ind)}in ${this.e(x.body, ind, 0)}`;
      }
      case "Block": return this.doBlock(x, ind);
      case "Error": return "()";
    }
  }

  private lamParam(p: Param, body: Expr): string {
    if (p.type.k === "TCon" && p.type.name === "Unit" && /^_u/.test(p.name)) return "()";
    if (!isWild(p.type)) return `(${p.name} :: ${printType(p.type)})`;
    // Pattern lambdas are desugared to `\_aN -> case _aN of ...`; keep the
    // generated name when the body uses it, otherwise print a plain wildcard.
    if (/^_[a-z]\d+$/.test(p.name)) return exprMentions(body, p.name) ? p.name : "_";
    return p.name;
  }

  private arm(a: MatchArm, ind: number): string {
    const pat = printPattern(a.pat);
    const head = a.guard ? `${pat} | ${this.e(a.guard, ind, 0)}` : pat;
    const body = this.e(a.body, ind, 0);
    if (!this.multi(body) && head.length + body.length + ind < this.width) return `${head} -> ${body}`;
    return `${head} ->\n${sp(ind + 2)}${this.e(a.body, ind + 2, 0)}`;
  }

  private letExpr(x: Expr & { k: "Let" }, ind: number): string {
    // collect a chain of lets
    const binds: (Expr & { k: "Let" })[] = [];
    let cur: Expr = x;
    while (cur.k === "Let") { binds.push(cur); cur = cur.body; }
    const body = cur;
    if (binds.length === 1 && !binds[0]!.ann) {
      const v = this.e(binds[0]!.value, ind, 0);
      const b = this.e(body, ind, 0);
      const one = `let ${binds[0]!.name} = ${v} in ${b}`;
      if (!this.multi(one) && one.length + ind <= this.width) return one;
    }
    const lines = binds.map((b) => this.letBinding(b.name, b.value, b.ann, ind + 2));
    return `let\n${lines.map((l) => sp(ind + 2) + l).join("\n")}\n${sp(ind)}in ${this.e(body, ind, 0)}`;
  }

  /** `x = v` (with an optional signature line); lambdas print as clauses */
  private letBinding(name: string, value: Expr, ann: TypeExpr | undefined, ind: number): string {
    const head = ann ? `${name} :: ${printType(ann)}\n${sp(ind)}` : "";
    return head + this.clause(name, value, ind);
  }

  /** `name p1 p2 = body`, splitting a lambda into clause parameters */
  clause(name: string, value: Expr, ind: number): string {
    let params = "";
    let body = value;
    if (value.k === "Lam" && value.params.every((p) => isWild(p.type) || (p.type.k === "TCon" && p.type.name === "Unit"))) {
      params = value.params.map((p) => this.lamParam(p)).join(" ");
      body = value.body;
    }
    return `${name}${params ? " " + params : ""} = ${this.rhs(body, ind)}`;
  }

  /** the right-hand side of `=`: inline when short, otherwise on the next line */
  rhs(body: Expr, ind: number): string {
    const s = this.e(body, ind, 0);
    if (body.k === "Block" || body.k === "Match") return s;
    if (!this.multi(s) && s.length + ind <= this.width) return s;
    return `\n${sp(ind + 2)}${this.e(body, ind + 2, 0)}`;
  }

  private doBlock(x: Expr & { k: "Block" }, ind: number): string {
    const lines: string[] = [];
    for (const s of x.stmts) lines.push(this.stmt(s, ind + 2));
    lines.push(this.e(x.value ?? { k: "Lit", lit: { k: "Unit" }, span: x.span }, ind + 2, 0));
    return `do\n${lines.map((l) => sp(ind + 2) + l).join("\n")}`;
  }

  private stmt(s: Stmt, ind: number): string {
    if (s.k === "ExprStmt") return this.e(s.e, ind, 0);
    if (s.ann) return `let\n${sp(ind + 2)}${s.name} :: ${printType(s.ann)}\n${sp(ind + 2)}${s.name} = ${this.rhs(s.value, ind + 2)}`;
    // the let block opens at the binder, so continuation lines must indent past it
    return `let ${s.name} = ${this.rhs(s.value, ind + 4)}`;
  }

  /* ---------- markup ---------- */

  private htmlExpr(nodes: HtmlNode[], ind: number): string {
    if (nodes.length === 1 && (nodes[0]!.k === "Element" || nodes[0]!.k === "Component")) {
      return this.element(nodes[0]!, ind);
    }
    if (!nodes.length) return "<></>";
    const kids = nodes.map((n) => this.htmlChild(n, ind + 2));
    return `<>\n${kids.map((k) => sp(ind + 2) + k).join("\n")}\n${sp(ind)}</>`;
  }

  private attr(a: HtmlAttr, ind: number): string {
    if (a.value.k === "static") return a.value.v === "" ? a.name : `${a.name}=${quote(a.value.v)}`;
    return `${a.name}={${this.e(a.value.e, ind, 0)}}`;
  }

  private htmlChild(n: HtmlNode, ind: number): string {
    switch (n.k) {
      case "Text": return n.v;
      case "Hole": return `{${this.e(n.e, ind, 0)}}`;
      case "Element": case "Component": return this.element(n, ind);
    }
  }

  private element(n: HtmlNode & { k: "Element" | "Component" }, ind: number): string {
    const tag = n.k === "Element" ? n.tag : n.name;
    const attrs = n.attrs.map((a) => this.attr(a, ind));
    const open = `<${tag}${attrs.length ? " " + attrs.join(" ") : ""}`;
    if (!n.children.length) return `${open} />`;
    const simple = n.children.every((c) => c.k === "Text" || c.k === "Hole");
    if (simple) {
      const inline = n.children.map((c) => this.htmlChild(c, ind)).join(" ");
      const one = `${open}>${inline}</${tag}>`;
      if (!this.multi(one) && one.length + ind <= this.width) return one;
    }
    const kids = n.children.map((c) => this.htmlChild(c, ind + 2));
    return `${open}>\n${kids.map((k) => sp(ind + 2) + k).join("\n")}\n${sp(ind)}</${tag}>`;
  }
}

export function printExpr(e: Expr, ind = 0): string {
  return new Printer().e(e, ind, 0);
}

/* ------------------------------------------------------------------ */
/* declarations                                                       */
/* ------------------------------------------------------------------ */

function exportName(d: Decl): string | null {
  switch (d.k) {
    case "Fn": return d.name;
    case "Extern": return d.sig.name;
    case "Adt": return `${d.name}(..)`;
    case "RecordType": case "Alias": case "Trait": case "Effect": return d.name;
    default: return null;
  }
}

export function printProgram(p: Program, opts: PrintOptions = {}): string {
  const pr = new Printer(opts.width ?? 90);
  const out: string[] = [];

  const exportable = p.decls.filter((d) => exportName(d) !== null);
  const allPublic = exportable.every((d) => (d as { pub: boolean }).pub);
  // a module that exports nothing explicitly (no `pub` anywhere) exports everything
  const anyPublic = exportable.some((d) => (d as { pub: boolean }).pub);
  const hasExportList = anyPublic && !allPublic;
  // Every file has a header now; keep the declared name when the source has one.
  const moduleName = p.module?.join(".") ?? opts.moduleName ?? "Main";
  if (hasExportList) {
    const names = exportable.filter((d) => (d as { pub: boolean }).pub).map((d) => exportName(d)!);
    out.push(`module ${moduleName} (${names.join(", ")}) where\n`);
  } else {
    out.push(`module ${moduleName} where\n`);
  }

  let prevUse = false;
  for (const d of p.decls) {
    const isUse = d.k === "Use";
    const comments = opts.comments?.get(d.span.line);
    const chunk = (comments?.length ? comments.map((c) => `-- ${c}`.trimEnd()).join("\n") + "\n" : "") + printDecl(d, pr);
    if (out.length && !(isUse && prevUse)) out.push("");
    out.push(chunk);
    prevUse = isUse;
  }
  return out.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function printDecl(d: Decl, pr: Printer): string {
  switch (d.k) {
    case "Error": return `-- ERROR: ${d.message}`;
    case "Use": {
      const u = d as Decl & { k: "Use" };
      let s = `import ${u.path.join(".")}`;
      if (u.alias) s += ` as ${u.alias}`;
      if (u.items.length) s += ` (${u.items.map((i) => (i.alias ? `${i.name} as ${i.alias}` : i.name)).join(", ")})`;
      return s;
    }
    case "Adt": {
      const head = `data ${[d.name, ...d.params].join(" ")}`;
      const vs = d.variants.map((v) => (v.args.length ? `${v.name} ${v.args.map((a) => printType(a, 2)).join(" ")}` : v.name));
      const one = `${head} = ${vs.join(" | ")}`;
      if (one.length <= 80) return one;
      return `${head}\n${vs.map((v, i) => `  ${i === 0 ? "=" : "|"} ${v}`).join("\n")}`;
    }
    case "RecordType":
      return `type ${[d.name, ...d.params].join(" ")} = { ${d.fields.map((f) => `${f.name} :: ${printType(f.type)}`).join(", ")} }`;
    case "Alias": return `type ${[d.name, ...d.params].join(" ")} = ${printType(d.type)}`;
    case "Trait": {
      const ctx = context(d.paramBounds);
      const head = `class ${ctx}${[d.name, ...d.params].join(" ")} where`;
      return `${head}\n${d.methods.map((m) => `  ${printSig(m)}`).join("\n")}`;
    }
    case "Impl": {
      const ctx = context(Object.fromEntries((d.where ?? []).map((w) => [w.name, w.bounds])));
      const args = [d.target, ...d.traitArgs].map((t) => printType(t, 2)).join(" ");
      const head = `instance ${ctx}${d.trait} ${args} where`;
      const body = d.methods.map((m) => {
        const params = m.params.map((p) => (p.type.k === "TCon" && p.type.name === "Unit" && /^_u/.test(p.name) ? "()" : /^_[a-z]\d+$/.test(p.name) ? "_" : p.name)).join(" ");
        return `  ${m.name}${params ? " " + params : ""} = ${pr.rhs(m.body, 2)}`;
      });
      return `${head}\n${body.join("\n")}`;
    }
    case "Effect": {
      const head = `effect ${d.name}${d.place ? ` @ ${d.place}` : ""} where`;
      return `${head}\n${d.ops.map((o) => `  ${printSig(o)}`).join("\n")}`;
    }
    case "Provide": {
      const head = `provide ${d.effect}${d.target ? ` for ${printType(d.target, 2)}` : ""} where`;
      return `${head}\n${d.ops.map((o) => `  ${pr.clause(o.name, o.fn, 2)}`).join("\n")}`;
    }
    case "Extern": {
      const source = d.modulePath ?? d.implName;
      const typeText = sigType(d.sig.params, d.sig.ret, d.sig.eff, d.sig.span as TypeExpr["span"]);
      return `foreign import js unsafe ${JSON.stringify(source)} {\n  ${d.sig.name} :: ${typeText}\n}`;
    }
    case "Fn": {
      const lines: string[] = [];
      const hasSig = d.ret !== undefined;
      if (hasSig) lines.push(`${d.name} :: ${context(d.paramBounds)}${sigType(d.params, d.ret, d.eff, d.span as TypeExpr["span"])}`);
      const params = d.params.map((p) => {
        if (p.type.k === "TCon" && p.type.name === "Unit" && /^_u/.test(p.name)) return "()";
        if (/^_[a-z]\d+$/.test(p.name)) return exprMentions(d.body, p.name) ? p.name : "_";
        if (!hasSig && !isWild(p.type)) return `(${p.name} :: ${printType(p.type)})`;
        return p.name;
      });
      lines.push(`${d.name}${params.length ? " " + params.join(" ") : ""} = ${pr.rhs(d.body, 0)}`);
      return lines.join("\n");
    }
  }
}

function printSig(s: FnSig): string {
  return `${s.name} :: ${context(s.paramBounds)}${sigType(s.params, s.ret, s.eff, s.span as TypeExpr["span"])}`;
}

/** Does an expression mention `name`? Used to keep synthetic pattern-lambda
 *  parameters (`_a1`) when the desugared case body refers to them. */
function exprMentions(e: Expr, name: string): boolean {
  switch (e.k) {
    case "Lit": case "Error": return false;
    case "Var": return e.name === name;
    case "Lam": return exprMentions(e.body, name);
    case "App": return exprMentions(e.fn, name) || e.args.some((a) => exprMentions(a, name));
    case "If": return exprMentions(e.cond, name) || exprMentions(e.then, name) || exprMentions(e.else, name);
    case "Match":
      return exprMentions(e.scrut, name) ||
        e.arms.some((a) => (a.guard ? exprMentions(a.guard, name) : false) || exprMentions(a.body, name));
    case "Let": return exprMentions(e.value, name) || exprMentions(e.body, name);
    case "Record": return e.fields.some((f) => exprMentions(f.value, name));
    case "Field": return exprMentions(e.target, name);
    case "Tuple": case "List": return e.items.some((i) => exprMentions(i, name));
    case "Ctor": return e.args.some((a) => exprMentions(a, name));
    case "Binary": return exprMentions(e.l, name) || exprMentions(e.r, name);
    case "Unary": return exprMentions(e.e, name);
    case "Html": return htmlMentions(e.nodes, name);
    case "Handle": return e.ops.some((o) => exprMentions(o.fn, name)) || exprMentions(e.body, name);
    case "Assign": return exprMentions(e.target, name) || (e.value ? exprMentions(e.value, name) : false);
    case "Block":
      return e.stmts.some((s) => exprMentions(s.k === "LetStmt" ? s.value : s.e, name)) ||
        (e.value ? exprMentions(e.value, name) : false);
  }
}

function htmlMentions(nodes: HtmlNode[], name: string): boolean {
  for (const n of nodes) {
    if (n.k === "Hole" && exprMentions(n.e, name)) return true;
    if ((n.k === "Element" || n.k === "Component")) {
      if (n.attrs.some((a) => a.value.k === "expr" && exprMentions(a.value.e, name))) return true;
      if (htmlMentions(n.children, name)) return true;
    }
  }
  return false;
}

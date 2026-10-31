/**
 * Flow — layout-sensitive recursive-descent parser (Haskell-style surface syntax).
 *
 * The offside rule is implemented inside the parser: `tok` yields virtual `;` and
 * `}` tokens when a line starts at (or left of) the indentation of the innermost
 * implicit block. Blocks open after `where`, `let`, `of`, `do` and `with`.
 * Brackets and markup holes suspend layout, so multi-line literals just work.
 *
 * Grammar reference: docs/grammar.ebnf
 */

import { lex, FlowError } from "./lexer.ts";
import type { Token } from "./lexer.ts";
import type {
  Decl, Expr, HtmlAttr, HtmlNode, MatchArm, Param, Pattern, Program, Span,
  Stmt, TypeExpr, EffRow, Place, FnSig,
} from "./ast.ts";

const V_SEMI = "v;";
const V_CLOSE = "v}";

interface OpInfo { prec: number; right: boolean }

const OPS: Record<string, OpInfo> = {
  "$": { prec: 0, right: true },
  "<|": { prec: 0, right: true },
  "|>": { prec: 1, right: false },
  ">>=": { prec: 1, right: false },
  "||": { prec: 2, right: true },
  "&&": { prec: 3, right: true },
  "==": { prec: 4, right: false }, "/=": { prec: 4, right: false },
  "<": { prec: 4, right: false }, "<=": { prec: 4, right: false },
  ">": { prec: 4, right: false }, ">=": { prec: 4, right: false },
  "++": { prec: 5, right: true },
  ":": { prec: 5, right: true },
  "+": { prec: 6, right: false }, "-": { prec: 6, right: false },
  "*": { prec: 7, right: false }, "/": { prec: 7, right: false }, "%": { prec: 7, right: false },
  ".": { prec: 9, right: true },
};

const BACKTICK_PREC: OpInfo = { prec: 9, right: false };
const ASSIGN_OPS = new Set([":=", "+=", "-=", "*="]);

interface Binding {
  name: string;
  pats: Pattern[];
  /** a pattern binding `(a, b) = e` has no name */
  pattern?: Pattern;
  rhs: Rhs;
  nameTok: Token;
  ann?: TypeExpr;
}

interface Rhs {
  body?: Expr;
  guards?: { guard: Expr; body: Expr }[];
  where: Binding[];
}

interface Sig { type: TypeExpr; bounds: Record<string, string[]>; tok: Token }

interface ExportSpec { names: Set<string> }

const loc = (left: Expr, right: Expr, file: string): Span =>
  ({ start: left.span.start, end: right.span.end, line: left.span.line, col: left.span.col, file });

const isWild = (t: TypeExpr) => t.k === "TVar" && t.name === "_";

export class Parser {
  src: string;
  file: string;
  toks: Token[];
  pos = 0;
  recover: boolean;
  /** indentation stack: > 0 for an implicit block, 0 for a bracketed context */
  layout: number[] = [];
  semiAt = -1;
  uid = 0;

  constructor(src: string, file = "<input>", opts: { recover?: boolean } = {}) {
    this.src = src;
    this.file = file;
    this.toks = lex(src, file);
    this.recover = Boolean(opts.recover);
  }

  /* ---------- token helpers ---------- */

  get raw(): Token { return this.toks[this.pos]!; }
  peekRaw(n = 1): Token { return this.toks[Math.min(this.pos + n, this.toks.length - 1)]!; }

  private virt(value: string, at: Token): Token {
    return { kind: "sym", value, start: at.start, end: at.start, line: at.line, col: at.col, bol: true, spBefore: true, spAfter: true };
  }

  get tok(): Token {
    const t = this.toks[this.pos]!;
    const n = this.layout.length ? this.layout[this.layout.length - 1]! : 0;
    if (n > 0) {
      if (t.kind === "eof") return this.virt(V_CLOSE, t);
      if (t.bol && this.semiAt !== this.pos) {
        if (t.col === n) return this.virt(V_SEMI, t);
        if (t.col < n) return this.virt(V_CLOSE, t);
      }
    }
    return t;
  }

  private isVSemi(t: Token) { return t.kind === "sym" && t.value === V_SEMI; }
  private isVClose(t: Token) { return t.kind === "sym" && t.value === V_CLOSE; }

  at(kind: string, value?: string): boolean {
    const t = this.tok;
    return t.kind === kind && (value === undefined || t.value === value);
  }
  atKw(v: string) { return this.at("kw", v); }
  atOp(v: string) { return this.at("op", v); }
  atSym(v: string) { return this.at("sym", v); }

  next(): Token {
    const t = this.tok;
    if (this.isVSemi(t)) { this.semiAt = this.pos; return t; }
    if (this.isVClose(t)) { this.layout.pop(); return t; }
    if (this.pos < this.toks.length - 1) this.pos++;
    return t;
  }

  eat(kind: string, value?: string): Token | null {
    if (this.at(kind, value)) return this.next();
    return null;
  }

  expect(kind: string, value?: string): Token {
    if (this.at(kind, value)) return this.next();
    const t = this.tok;
    this.err(`expected ${value ? JSON.stringify(value) : kind}, found ${this.show(t)}`, t);
  }
  expectKw(v: string) { return this.expect("kw", v); }
  expectOp(v: string) { return this.expect("op", v); }
  expectSym(v: string) { return this.expect("sym", v); }

  private show(t: Token): string {
    if (this.isVSemi(t) || this.isVClose(t)) return "the end of the line (check the indentation)";
    if (t.kind === "eof") return "end of file";
    return JSON.stringify(t.value);
  }

  err(msg: string, t: Token = this.tok): never {
    throw new FlowError(msg, { file: this.file, line: t.line, col: t.col, code: "E_PARSE" });
  }

  spanFrom(start: Token): Span {
    const e = this.toks[Math.max(0, this.pos - 1)]!;
    return { start: start.start, end: Math.max(e.end, start.start), line: start.line, col: start.col, file: this.file };
  }

  private fresh(prefix: string) { return `${prefix}${++this.uid}`; }

  /** Skip a layout `;` that sits before `kw` (`if` / `then` / `else` in a do block). */
  private skipSemiBefore(...kws: string[]) {
    const t = this.tok;
    if (this.isVSemi(t)) {
      const r = this.raw;
      if (r.kind === "kw" && kws.includes(r.value)) this.next();
    } else if (t.kind === "sym" && t.value === ";") {
      const r = this.peekRaw();
      if (r.kind === "kw" && kws.includes(r.value)) this.next();
    }
  }

  /* ---------- layout blocks ---------- */

  private enclosingIndent(): number {
    return this.layout.length ? this.layout[this.layout.length - 1]! : 0;
  }

  /** Open an implicit block at the next token; false when the block is empty. */
  private openBlock(): boolean {
    const t = this.raw;
    if (t.kind === "eof" || t.col <= this.enclosingIndent()) return false;
    this.layout.push(t.col);
    this.semiAt = this.pos;
    return true;
  }

  private blockEnder(): boolean {
    const t = this.tok;
    if (t.kind === "eof") return true;
    if (t.kind === "kw") return t.value === "in" || t.value === "then" || t.value === "else" || t.value === "of";
    if (t.kind === "sym") return t.value === ")" || t.value === "]" || t.value === "}" || t.value === ",";
    return false;
  }

  /** Parse `item { ; item }` inside a freshly opened implicit block. */
  private blockItems<T>(parseItem: () => T | null): T[] {
    const items: T[] = [];
    if (!this.openBlock()) return items;
    for (;;) {
      while (this.isVSemi(this.tok) || this.atSym(";")) this.next();
      if (this.isVClose(this.tok)) { this.next(); break; }
      if (this.blockEnder()) { this.layout.pop(); break; }
      const it = parseItem();
      if (it !== null) items.push(it);
      const t = this.tok;
      if (this.isVSemi(t) || this.atSym(";")) continue;
      if (this.isVClose(t)) { this.next(); break; }
      // the item ended at a token that cannot continue the block: close it
      this.layout.pop();
      break;
    }
    return items;
  }

  /** Run `f` with layout suspended (inside brackets, markup holes). */
  private bracketed<T>(f: () => T): T {
    this.layout.push(0);
    const depth = this.layout.length;
    try { return f(); }
    finally { this.layout.length = depth - 1; }
  }

  /* ---------- program ---------- */

  parseProgram(): Program {
    const items: TopItem[] = [];
    const errors: FlowError[] = [];
    let exportSpec: ExportSpec | null = null;

    try {
      if (this.raw.kind === "kw" && this.raw.value === "module") {
        this.next();
        this.moduleName();
        if (this.atSym("(")) exportSpec = this.parseExportList();
        this.expectKw("where");
      }
    } catch (e) {
      if (!this.recover || !(e instanceof FlowError)) throw e;
      errors.push(e);
      while (this.raw.kind !== "eof" && !(this.raw.kind === "kw" && this.raw.value === "where")) this.pos++;
      if (this.raw.kind !== "eof") this.pos++;
    }

    if (this.raw.kind !== "eof") {
      const top = this.raw.col;
      this.layout = [top];
      this.semiAt = this.pos;
      for (;;) {
        while (this.isVSemi(this.tok) || this.atSym(";")) this.next();
        if (this.raw.kind === "eof" || this.isVClose(this.tok)) break;
        const before = this.pos;
        try {
          const it = this.parseTopItem();
          if (it) items.push(it);
          const t = this.tok;
          if (!(this.isVSemi(t) || this.atSym(";") || this.isVClose(t) || t.kind === "eof")) {
            this.err(`unexpected ${this.show(t)}`, t);
          }
        } catch (e) {
          if (!this.recover || !(e instanceof FlowError)) throw e;
          errors.push(e);
          if (this.pos === before) this.pos = Math.min(this.pos + 1, this.toks.length - 1);
          this.layout = [top];
          this.syncTop(top);
        }
      }
    }

    const decls = this.groupItems(items, errors);
    if (exportSpec) this.applyExports(decls, exportSpec);
    return { decls, file: this.file, ...(errors.length ? { errors } : {}) };
  }

  /** Skip to the next line that starts at the top-level indentation. */
  private syncTop(top: number) {
    while (this.raw.kind !== "eof") {
      const t = this.raw;
      if (t.bol && t.col <= top && this.pos > 0) { this.semiAt = this.pos; return; }
      this.pos++;
    }
  }

  private moduleName(): string[] {
    const parts = [this.expect("Con").value];
    while (this.atOp(".") && !this.raw.spAfter && this.peekRaw().kind === "Con") {
      this.next();
      parts.push(this.next().value);
    }
    return parts;
  }

  private parseExportList(): ExportSpec {
    const names = new Set<string>();
    this.bracketed(() => {
      this.expectSym("(");
      while (!this.atSym(")")) {
        const t = this.tok;
        if (t.kind === "id" || t.kind === "Con") {
          this.next();
          names.add(t.value);
          if (this.atSym("(")) {
            this.next();
            while (!this.atSym(")")) {
              if (this.atOp("..")) { this.next(); continue; }
              const c = this.next();
              names.add(c.value);
              if (!this.eat("sym", ",")) break;
            }
            this.expectSym(")");
          }
        } else this.err(`expected an exported name, found ${this.show(t)}`, t);
        if (!this.eat("sym", ",")) break;
      }
      this.expectSym(")");
    });
    return { names };
  }

  private applyExports(decls: Decl[], spec: ExportSpec) {
    for (const d of decls) {
      const name =
        d.k === "Extern" ? d.sig.name :
        d.k === "Fn" || d.k === "Adt" || d.k === "RecordType" || d.k === "Alias" || d.k === "Trait" || d.k === "Effect" ? d.name :
        null;
      if (name === null) continue;
      const exported = spec.names.has(name) ||
        (d.k === "Adt" && d.variants.some((v) => spec.names.has(v.name)));
      (d as { pub: boolean }).pub = exported;
    }
  }

  /* ---------- top-level items ---------- */

  private parseTopItem(): TopItem | null {
    const t = this.tok;
    if (t.kind === "kw") {
      switch (t.value) {
        case "import": return { k: "decl", decl: this.parseImport() };
        case "data": return { k: "decl", decl: this.parseData() };
        case "type": return { k: "decl", decl: this.parseTypeDecl() };
        case "class": return { k: "decl", decl: this.parseClass() };
        case "instance": return { k: "decl", decl: this.parseInstance() };
        case "algebraic": {
          const s = this.next();
          if (!this.atKw("effect")) this.err("expected 'effect' after 'algebraic'");
          return { k: "decl", decl: this.parseEffect(s, true) };
        }
        case "effect": return { k: "decl", decl: this.parseEffect(t, false) };
        case "provide": return { k: "decl", decl: this.parseProvide() };
        case "foreign": return { k: "decl", decl: this.parseForeign() };
        default:
          this.err(`unexpected keyword ${JSON.stringify(t.value)} at the top level`, t);
      }
    }

    // functions are lower-case; a component such as `Card` is the one exception
    if (t.kind === "id" || t.kind === "Con") {
      // `name :: type`  — a signature
      if (this.peekRaw().kind === "op" && this.peekRaw().value === "::") {
        this.next(); this.next();
        const { type, bounds } = this.parseSigType();
        return { k: "sig", name: t.value, sig: { type, bounds, tok: t } };
      }
      return { k: "clause", binding: this.parseBinding(t.kind === "Con") };
    }

    this.err(`expected a declaration, found ${this.show(t)}`, t);
  }

  /** Group signatures and adjacent clauses into `Fn` declarations. */
  private groupItems(items: TopItem[], errors: FlowError[]): Decl[] {
    const decls: Decl[] = [];
    const sigs = new Map<string, Sig>();
    const defined = new Set<string>();
    let i = 0;
    const record = (e: unknown) => {
      if (!this.recover || !(e instanceof FlowError)) throw e;
      errors.push(e);
    };
    while (i < items.length) {
      const it = items[i]!;
      if (it.k === "decl") { decls.push(it.decl); i++; continue; }
      if (it.k === "sig") {
        if (sigs.has(it.name)) record(new FlowError(`duplicate type signature for '${it.name}'`, { file: this.file, line: it.sig.tok.line, col: it.sig.tok.col, code: "E_PARSE" }));
        sigs.set(it.name, it.sig);
        i++;
        continue;
      }
      // a run of clauses for one function
      const name = it.binding.name;
      const group = [it.binding];
      let j = i + 1;
      while (j < items.length) {
        const n = items[j]!;
        if (n.k === "clause" && n.binding.name === name && n.binding.pats.length > 0) { group.push(n.binding); j++; }
        else break;
      }
      i = j;
      try {
        if (defined.has(name)) {
          this.err(`duplicate definition of '${name}' (clauses of a function must be adjacent)`, it.binding.nameTok);
        }
        defined.add(name);
        const sig = sigs.get(name);
        sigs.delete(name);
        decls.push(this.buildFn(name, group, sig, true));
      } catch (e) { record(e); }
    }
    for (const [name, s] of sigs) {
      record(new FlowError(`the type signature for '${name}' lacks an accompanying binding`, { file: this.file, line: s.tok.line, col: s.tok.col, code: "E_PARSE" }));
    }
    return decls;
  }

  /* ---------- declarations ---------- */

  private parseImport(): Decl {
    const start = this.expectKw("import");
    const path = this.moduleName();
    let alias: string | undefined;
    const items: { name: string; alias?: string }[] = [];
    if (this.atKw("as")) { this.next(); alias = this.expect("Con").value; }
    if (this.atSym("(")) {
      this.bracketed(() => {
        this.next();
        while (!this.atSym(")")) {
          const t = this.tok;
          if (t.kind !== "id" && t.kind !== "Con") this.err(`expected an imported name, found ${this.show(t)}`, t);
          this.next();
          const item: { name: string; alias?: string } = { name: t.value };
          if (this.atSym("(")) {
            this.next();
            while (!this.atSym(")")) { this.next(); if (!this.eat("sym", ",")) break; }
            this.expectSym(")");
          }
          if (this.atKw("as")) { this.next(); item.alias = this.next().value; }
          items.push(item);
          if (!this.eat("sym", ",")) break;
        }
        this.expectSym(")");
      });
    }
    return { k: "Use", path, items, glob: false, alias, span: this.spanFrom(start) } as Decl;
  }

  private tyVarNames(): string[] {
    const names: string[] = [];
    while (this.tok.kind === "id") names.push(this.next().value);
    return names;
  }

  private parseData(): Decl {
    const start = this.expectKw("data");
    const name = this.expect("Con").value;
    const params = this.tyVarNames();
    this.expectOp("=");
    const variants: { name: string; args: TypeExpr[]; span: Span }[] = [];
    for (;;) {
      const ct = this.expect("Con");
      const args: TypeExpr[] = [];
      while (this.startsAType()) args.push(this.parseAType());
      variants.push({ name: ct.value, args, span: this.spanFrom(ct) });
      if (!this.eatOpIf("|")) break;
    }
    return { k: "Adt", name, params, paramBounds: {}, variants, pub: true, span: this.spanFrom(start) };
  }

  private eatOpIf(v: string): boolean {
    if (this.atOp(v)) { this.next(); return true; }
    return false;
  }

  private parseTypeDecl(): Decl {
    const start = this.expectKw("type");
    const name = this.expect("Con").value;
    const params = this.tyVarNames();
    this.expectOp("=");
    if (this.atSym("{")) {
      const fields = this.parseRecordTypeFields();
      return { k: "RecordType", name, params, paramBounds: {}, fields, pub: true, span: this.spanFrom(start) };
    }
    const type = this.parseType();
    return { k: "Alias", name, params, paramBounds: {}, type, pub: true, span: this.spanFrom(start) };
  }

  private parseClass(): Decl {
    const start = this.expectKw("class");
    let bounds: Record<string, string[]> = {};
    let head = this.parseHead();
    if (this.atOp("=>")) { this.next(); bounds = this.contextBounds(head.type); head = this.parseHead(); }
    const name = this.headCon(head.type);
    const params = this.headArgs(head.type);
    this.expectKw("where");
    const methods = this.blockItems<FnSig>(() => {
      const t = this.expect("id");
      this.expectOp("::");
      const { type, bounds: b } = this.parseSigType();
      const sig = this.sigFromType(t.value, type, b, t);
      // the class's own type parameters are not re-quantified by each method
      return { ...sig, typeParams: sig.typeParams.filter((v) => !params.includes(v)), span: this.spanFrom(t) };
    });
    return { k: "Trait", name, params, paramBounds: bounds, methods, pub: true, span: this.spanFrom(start) };
  }

  /** `Con a b` as a type, for class and instance heads. */
  private parseHead(): { type: TypeExpr } {
    return { type: this.parseBTypeNoArrow() };
  }

  private headCon(t: TypeExpr): string {
    if (t.k === "TCon") return t.name;
    this.err("expected a class name");
  }
  private headArgs(t: TypeExpr): string[] {
    if (t.k !== "TCon") return [];
    return t.args.map((a) => (a.k === "TVar" ? a.name : this.err("class parameters must be type variables", this.raw)));
  }

  private contextBounds(t: TypeExpr): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    const add = (c: TypeExpr) => {
      if (c.k !== "TCon" || c.args.length !== 1 || c.args[0]!.k !== "TVar") this.err("a context entry looks like `Show a`", this.raw);
      const v = (c.args[0] as { name: string }).name;
      (out[v] ??= []).push(c.name);
    };
    if (t.k === "TTuple") t.items.forEach(add); else add(t);
    return out;
  }

  private parseInstance(): Decl {
    const start = this.expectKw("instance");
    const head = this.parseBTypeNoArrow();
    let ctx: Record<string, string[]> = {};
    let real = head;
    if (this.atOp("=>")) { this.next(); ctx = this.contextBounds(head); real = this.parseBTypeNoArrow(); }
    if (real.k !== "TCon" || real.args.length === 0) this.err("an instance head looks like `Show Int`", start);
    const trait = real.name;
    const [target, ...traitArgs] = real.args as [TypeExpr, ...TypeExpr[]];
    this.expectKw("where");
    const where = Object.entries(ctx).map(([name, bounds]) => ({ name, bounds }));
    const bindings = this.blockItems<Binding>(() => this.parseBinding());
    const methods = this.groupBindings(bindings).map((g) => {
      const fn = this.buildFn(g.name, g.clauses, undefined, false);
      return { ...this.fnToSig(fn), body: fn.body, span: fn.span };
    });
    return { k: "Impl", trait, traitArgs, target, where, methods, span: this.spanFrom(start) };
  }

  private parseEffect(start: Token, algebraic: boolean): Decl {
    this.expectKw("effect");
    const name = this.expect("Con").value;
    let place: Place | undefined;
    if (this.atOp("@")) {
      this.next();
      const p = this.next().value;
      if (p !== "client" && p !== "server" && p !== "neutral") this.err(`unknown placement '${p}' (expected client|server|neutral)`);
      place = p as Place;
    }
    if (algebraic && place) this.err("an algebraic effect has no placement: it is handled where it is performed", start);
    this.expectKw("where");
    const ops = this.blockItems<FnSig>(() => {
      const t = this.expect("id");
      this.expectOp("::");
      const { type, bounds } = this.parseSigType();
      return { ...this.sigFromType(t.value, type, bounds, t), span: this.spanFrom(t) };
    });
    return { k: "Effect", name, ops, pub: true, place, algebraic, span: this.spanFrom(start) };
  }

  private parseProvide(): Decl {
    const start = this.expectKw("provide");
    const effect = this.qualConName();
    let target: TypeExpr | undefined;
    if (this.atKw("for")) { this.next(); target = this.parseAType(); }
    this.expectKw("where");
    const bindings = this.blockItems<Binding>(() => this.parseBinding());
    const ops = this.groupBindings(bindings).map((g) => ({
      name: g.name,
      fn: this.opLambda(g.clauses),
      span: g.clauses[0]!.nameTok ? this.spanOf(g.clauses[0]!.nameTok) : this.spanFrom(start),
    }));
    return { k: "Provide", effect, target, ops, span: this.spanFrom(start) };
  }

  private parseForeign(): Decl {
    const start = this.expectKw("foreign");
    this.expectKw("import");
    const target = this.expect("id").value;
    if (target !== "js") this.err(`unsupported FFI target '${target}' (expected js)`);
    if (!(this.tok.kind === "id" && this.tok.value === "unsafe")) {
      this.err("FFI declarations must be explicitly marked `unsafe`", this.tok);
    }
    this.next();
    const implName = this.expect("str").value;
    if (!/^(?:[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*|[@#][A-Za-z_$][A-Za-z0-9_$]*)$/.test(implName)) {
      this.err(`invalid JavaScript FFI target '${implName}' (expected "Math.floor", "@method" or "#property")`, start);
    }
    const nameTok = this.expect("id");
    this.expectOp("::");
    const { type, bounds } = this.parseSigType();
    const sig = this.sigFromType(nameTok.value, type, bounds, nameTok);
    return { k: "Extern", sig, target: "js", implName, unsafe: true, pub: true, span: this.spanFrom(start) };
  }

  private spanOf(t: Token): Span {
    return { start: t.start, end: t.end, line: t.line, col: t.col, file: this.file };
  }

  /* ---------- function construction ---------- */

  private groupBindings(bs: Binding[]): { name: string; clauses: Binding[] }[] {
    const out: { name: string; clauses: Binding[] }[] = [];
    for (const b of bs) {
      if (b.pattern) this.err("a pattern binding is not allowed here", b.nameTok);
      const last = out[out.length - 1];
      if (last && last.name === b.name && b.pats.length > 0) last.clauses.push(b);
      else if (out.some((g) => g.name === b.name)) this.err(`duplicate definition of '${b.name}'`, b.nameTok);
      else out.push({ name: b.name, clauses: [b] });
    }
    return out;
  }

  private opLambda(clauses: Binding[]): Expr {
    // `state = makeCell` provides the operation with an existing function value
    if (clauses.length === 1 && clauses[0]!.pats.length === 0) return this.rhsToExpr(clauses[0]!.rhs, clauses[0]!.nameTok);
    const { params, body } = this.clausesToFn(clauses, undefined);
    const span = this.spanOf(clauses[0]!.nameTok);
    return { k: "Lam", params, body, span: { ...span, end: body.span.end } };
  }

  private fnToSig(fn: Decl & { k: "Fn" }): FnSig {
    return { name: fn.name, typeParams: fn.typeParams, paramBounds: fn.paramBounds, params: fn.params, ret: fn.ret, eff: fn.eff, span: fn.span };
  }

  /** Split a signature type into parameters / result for `n` written parameters. */
  private splitType(type: TypeExpr, n: number, tok: Token): { params: TypeExpr[]; ret: TypeExpr; eff?: EffRow; extra: TypeExpr[] } {
    if (type.k !== "TFun") {
      if (n > 0) this.err(`the signature of '${tok.value}' has no function arrows but the definition takes ${n} argument(s)`, tok);
      return { params: [], ret: type, extra: [] };
    }
    if (n > type.params.length) {
      this.err(`the definition of '${tok.value}' takes ${n} argument(s) but its signature has only ${type.params.length}`, tok);
    }
    const eff = type.eff && (type.eff.written || type.eff.effects.length || type.eff.var) ? type.eff : undefined;
    if (n === type.params.length) return { params: type.params, ret: type.ret, eff, extra: [] };
    // fewer written parameters than arrows: the rest are eta-expanded by the caller
    return { params: type.params, ret: type.ret, eff, extra: type.params.slice(n) };
  }

  private collectTyVars(t: TypeExpr, out: string[]) {
    switch (t.k) {
      case "TVar": if (t.name !== "_" && !out.includes(t.name)) out.push(t.name); return;
      case "TCon":
        if (/^[a-z]/.test(t.name) && !out.includes(t.name)) out.push(t.name);
        t.args.forEach((a) => this.collectTyVars(a, out));
        return;
      case "TFun": t.params.forEach((a) => this.collectTyVars(a, out)); this.collectTyVars(t.ret, out); return;
      case "TRecord": t.fields.forEach((f) => this.collectTyVars(f.type, out)); return;
      case "TTuple": t.items.forEach((a) => this.collectTyVars(a, out)); return;
      case "TPlaced": this.collectTyVars(t.inner, out); return;
    }
  }

  private sigFromType(name: string, type: TypeExpr, bounds: Record<string, string[]>, tok: Token): FnSig {
    const arity = type.k === "TFun" ? type.params.length : 0;
    const { params, ret, eff } = this.splitType(type, arity, tok);
    const typeParams: string[] = [];
    this.collectTyVars(type, typeParams);
    return {
      name,
      typeParams,
      paramBounds: bounds,
      params: params.map((p, i) => ({ name: `a${i + 1}`, type: p, span: p.span })),
      ret,
      eff,
      span: this.spanOf(tok),
    };
  }

  /** Build a top-level / instance function from its clauses and optional signature. */
  private buildFn(name: string, clauses: Binding[], sig: Sig | undefined, pub: boolean): Decl & { k: "Fn" } {
    const first = clauses[0]!;
    const n = first.pats.length;
    for (const c of clauses) {
      if (c.pats.length !== n) this.err(`the clauses of '${name}' have different numbers of arguments`, c.nameTok);
    }
    let paramTypes: TypeExpr[] | undefined;
    let ret: TypeExpr | undefined;
    let eff: EffRow | undefined;
    let extra: TypeExpr[] = [];
    let typeParams: string[] = [];
    let bounds: Record<string, string[]> = {};
    if (sig) {
      const s = this.splitType(sig.type, n, sig.tok);
      paramTypes = s.params;
      ret = s.ret;
      eff = s.eff;
      extra = s.extra;
      this.collectTyVars(sig.type, typeParams);
      bounds = sig.bounds;
      if (extra.length) {
        // the signature promises more arrows than there are parameters: the
        // result is a function, so the definition is eta-expanded
        ret = s.ret;
      }
    }
    const { params, body } = this.clausesToFn(clauses, paramTypes?.slice(0, n), extra);
    const fullParams = params.map((p, i) => ({ ...p, type: paramTypes && paramTypes[i] ? paramTypes[i]! : p.type }));
    // a declaration starts at its signature when it has one
    const span = this.spanOf(sig ? sig.tok : first.nameTok);
    return {
      k: "Fn",
      name,
      typeParams,
      paramBounds: bounds,
      params: fullParams,
      ret,
      eff,
      body,
      pub,
      span: { ...span, end: body.span.end },
    };
  }

  /** Turn clauses into parameters + a body (pattern matching when needed). */
  private clausesToFn(clauses: Binding[], types?: TypeExpr[], extra: TypeExpr[] = []): { params: Param[]; body: Expr } {
    const n = clauses[0]!.pats.length;
    const first = clauses[0]!;
    const unitT = (s: Span): TypeExpr => ({ k: "TCon", name: "Unit", args: [], span: s });

    const simple = clauses.length === 1 && first.pats.every((p) => p.k === "PVar" || p.k === "PWild");
    const params: Param[] = [];
    const scrutVars: Expr[] = [];
    for (let i = 0; i < n; i++) {
      const p = first.pats[i]!;
      let name: string;
      if (simple && p.k === "PVar") name = p.name;
      else if (simple && p.k === "PWild") name = this.fresh("_w");
      else if (!simple && clauses.length === 1 && p.k === "PVar") name = p.name;
      else if (p.k === "PLit" && p.lit.k === "Unit" && clauses.length === 1) name = this.fresh("_u");
      else name = this.fresh("_a");
      const ty: TypeExpr = p.k === "PVar" && p.ann ? p.ann
        : p.k === "PLit" && p.lit.k === "Unit" ? unitT(p.span)
        : { k: "TVar", name: "_", span: p.span };
      params.push({ name, type: types?.[i] ?? ty, span: p.span });
      scrutVars.push({ k: "Var", name, span: p.span });
    }

    let body: Expr;
    if (simple || (clauses.length === 1 && first.pats.every((p) => p.k === "PVar" || p.k === "PWild" || (p.k === "PLit" && p.lit.k === "Unit")))) {
      body = this.rhsToExpr(first.rhs, first.nameTok);
    } else {
      const arms: MatchArm[] = [];
      for (const c of clauses) {
        const pat: Pattern = n === 1 ? c.pats[0]! : { k: "PTuple", items: c.pats, span: c.pats[0]!.span };
        for (const a of this.rhsToArms(c.rhs, pat, c.nameTok)) arms.push(a);
      }
      const scrut: Expr = n === 1 ? scrutVars[0]! : { k: "Tuple", items: scrutVars, span: scrutVars[0]!.span };
      body = { k: "Match", scrut, arms, span: this.spanOf(first.nameTok) };
    }

    // eta-expansion for signatures with more arrows than written parameters
    if (extra.length && body.k === "Lam" && body.params.length === extra.length) {
      // `f x = \a b -> …` against `f :: x -> a -> b -> r` is already a 3-parameter function
      body.params.forEach((p, i) => params.push({ ...p, type: isWild(p.type) ? extra[i]! : p.type }));
      body = body.body;
    } else if (extra.length) {
      const args: Expr[] = [];
      for (const t of extra) {
        const name = this.fresh("_e");
        params.push({ name, type: t, span: t.span });
        args.push({ k: "Var", name, span: t.span });
      }
      body = { k: "App", fn: body, args, span: body.span };
    }
    return { params, body };
  }

  private whereLet(where: Binding[], body: Expr): Expr {
    if (!where.length) return body;
    return this.bindingsToLets(where, body);
  }

  private rhsToExpr(rhs: Rhs, tok: Token): Expr {
    if (rhs.body) return this.whereLet(rhs.where, rhs.body);
    const guards = rhs.guards!;
    return this.whereLet(rhs.where, this.guardsToIf(guards, tok));
  }

  private guardsToIf(guards: { guard: Expr; body: Expr }[], tok: Token): Expr {
    const isOtherwise = (g: Expr) => (g.k === "Var" && g.name === "otherwise") || (g.k === "Ctor" && g.name === "True" && !g.args.length) || (g.k === "Lit" && g.lit.k === "Bool" && g.lit.v);
    const last = guards[guards.length - 1]!;
    if (!isOtherwise(last.guard)) {
      this.err("guards here must end with `otherwise` (the last alternative needs a catch-all)", tok);
    }
    let out = last.body;
    for (let i = guards.length - 2; i >= 0; i--) {
      const g = guards[i]!;
      out = { k: "If", cond: g.guard, then: g.body, else: out, span: loc(g.guard, out, this.file) };
    }
    return out;
  }

  private rhsToArms(rhs: Rhs, pat: Pattern, tok: Token): MatchArm[] {
    if (rhs.body) {
      return [{ pat, body: this.whereLet(rhs.where, rhs.body), span: pat.span }];
    }
    const guards = rhs.guards!;
    if (rhs.where.length) {
      return [{ pat, body: this.whereLet(rhs.where, this.guardsToIf(guards, tok)), span: pat.span }];
    }
    return guards.map((g) => {
      const isOtherwise = (g.guard.k === "Var" && g.guard.name === "otherwise") || (g.guard.k === "Ctor" && g.guard.name === "True");
      return { pat, guard: isOtherwise ? undefined : g.guard, body: g.body, span: pat.span } as MatchArm;
    });
  }

  /** `let` chain for `where` / `let` blocks. */
  private bindingsToLets(bs: Binding[], body: Expr): Expr {
    const groups: ({ pattern: Pattern; rhs: Rhs; tok: Token } | { name: string; clauses: Binding[]; ann?: TypeExpr })[] = [];
    for (const b of bs) {
      if (b.pattern) { groups.push({ pattern: b.pattern, rhs: b.rhs, tok: b.nameTok }); continue; }
      const last = groups[groups.length - 1];
      if (last && "name" in last && last.name === b.name && b.pats.length > 0) last.clauses.push(b);
      else groups.push({ name: b.name, clauses: [b], ann: b.ann });
    }
    let out = body;
    for (let i = groups.length - 1; i >= 0; i--) {
      const g = groups[i]!;
      if ("pattern" in g) {
        const value = this.rhsToExpr(g.rhs, g.tok);
        out = { k: "Match", scrut: value, arms: [{ pat: g.pattern, body: out, span: g.pattern.span }], span: loc(value, out, this.file) };
        continue;
      }
      const first = g.clauses[0]!;
      let value: Expr;
      if (first.pats.length === 0) {
        value = this.rhsToExpr(first.rhs, first.nameTok);
      } else {
        const { params, body: fb } = this.clausesToFn(g.clauses, undefined);
        value = { k: "Lam", params, body: fb, span: { ...this.spanOf(first.nameTok), end: fb.span.end } };
      }
      out = { k: "Let", name: g.name, mut: false, ann: g.ann, value, body: out, span: loc(value, out, this.file) };
    }
    return out;
  }

  /* ---------- bindings ---------- */

  /** `name apat* rhs` or `pattern rhs`, as in a function clause or a `let`. */
  private parseBinding(allowCon = false): Binding {
    const t = this.tok;
    // a pattern binding such as `(a, b) = e`
    if (!((t.kind === "id" || (allowCon && t.kind === "Con")) && this.peekRaw().value !== "@")) {
      const pattern = this.parsePat();
      const rhs = this.parseRhs("=");
      return { name: "", pats: [], pattern, rhs, nameTok: t };
    }
    this.next();
    const pats: Pattern[] = [];
    while (this.startsAPat()) pats.push(this.parseAPat());
    const rhs = this.parseRhs("=");
    return { name: t.value, pats, rhs, nameTok: t };
  }

  /** `= expr`, or guards `| g = e`, followed by an optional `where` block. */
  private parseRhs(eq: "=" | "->"): Rhs {
    let body: Expr | undefined;
    let guards: { guard: Expr; body: Expr }[] | undefined;
    if (this.atOp("|")) {
      guards = [];
      while (this.atOp("|")) {
        this.next();
        const guard = this.parseExpr();
        this.expectOp(eq);
        guards.push({ guard, body: this.parseExpr() });
      }
    } else {
      this.expectOp(eq);
      body = this.parseExpr();
    }
    let where: Binding[] = [];
    if (this.atKw("where")) {
      this.next();
      where = this.blockItems<Binding>(() => this.parseLocalItem());
      where = this.attachSigs(where);
    }
    return { body, guards, where };
  }

  private pendingSigs = new Map<Binding, Sig>();

  /** Local `name :: type` signatures are recorded as annotations on the next binding. */
  private parseLocalItem(): Binding | null {
    const t = this.tok;
    if (t.kind === "id" && this.peekRaw().kind === "op" && this.peekRaw().value === "::") {
      this.next(); this.next();
      const { type } = this.parseSigType();
      const b: Binding = { name: t.value, pats: [], rhs: { where: [] }, nameTok: t, ann: type, __sig: true } as Binding & { __sig: boolean };
      return b;
    }
    return this.parseBinding();
  }

  /** Merge `x :: T` pseudo-bindings into the annotated binding that follows. */
  private attachSigs(bs: Binding[]): Binding[] {
    const out: Binding[] = [];
    const sigs = new Map<string, TypeExpr>();
    for (const b of bs) {
      if ((b as Binding & { __sig?: boolean }).__sig) { sigs.set(b.name, b.ann!); continue; }
      if (sigs.has(b.name) && !b.ann) { b.ann = sigs.get(b.name); sigs.delete(b.name); }
      out.push(b);
    }
    return out;
  }

  /* ---------- types ---------- */

  parseSigType(): { type: TypeExpr; bounds: Record<string, string[]> } {
    const first = this.parseType();
    if (this.atOp("=>")) {
      this.next();
      const bounds = this.contextBounds(first);
      return { type: this.parseType(), bounds };
    }
    return { type: first, bounds: {} };
  }

  parseType(): TypeExpr {
    const start = this.tok;
    let t = this.parseBType();
    if (this.atOp("@") && this.peekRaw().kind === "id") {
      this.next();
      const p = this.next().value;
      if (p !== "client" && p !== "server") this.err(`unknown placement ${JSON.stringify(p)} (expected client|server)`, start);
      t = { k: "TPlaced", inner: t, place: p as Place, span: this.spanFrom(start) };
    }
    if (this.atOp("->")) {
      this.next();
      const ret = this.parseType();
      let eff: EffRow = { effects: [] };
      if (this.atOp("!")) { this.next(); eff = this.parseEffRow(); }
      if (ret.k === "TFun") {
        // a -> b -> c is one curried function
        return { k: "TFun", params: [t, ...ret.params], ret: ret.ret, eff: eff.written ? eff : ret.eff, span: this.spanFrom(start) };
      }
      return { k: "TFun", params: [t], ret, eff, span: this.spanFrom(start) };
    }
    return t;
  }

  private parseEffRow(): EffRow {
    const effects: string[] = [];
    const spans: { name: string; span: Span }[] = [];
    let rowVar: string | undefined;
    let varSpan: Span | undefined;
    if (this.atSym("{")) {
      this.bracketed(() => {
        this.next();
        if (!this.atSym("}")) {
          do {
            if (this.tok.kind === "id") {
              const tv = this.tok;
              rowVar = this.next().value;
              varSpan = this.spanFrom(tv);
              break;
            }
            const t = this.tok;
            const name = this.expect("Con").value;
            effects.push(name);
            spans.push({ name, span: this.spanFrom(t) });
          } while (this.eat("sym", ","));
        }
        this.expectSym("}");
      });
    } else {
      const t = this.tok;
      const name = this.expect("Con").value;
      effects.push(name);
      spans.push({ name, span: this.spanFrom(t) });
    }
    return { effects, var: rowVar, varSpan, spans, written: true };
  }

  private startsAType(): boolean {
    const t = this.tok;
    return t.kind === "Con" || t.kind === "id" || (t.kind === "sym" && (t.value === "(" || t.value === "[" || t.value === "{"));
  }

  /** Type application: `Maybe a`, `List (Cell Int)`, `f a`. */
  private parseBType(): TypeExpr {
    const start = this.tok;
    const head = this.parseAType();
    if (head.k === "TCon" && head.args.length === 0 && !this.parenthesized.has(head)) {
      const args: TypeExpr[] = [];
      while (this.startsAType()) args.push(this.parseAType());
      if (args.length) return { k: "TCon", name: head.name, args, span: this.spanFrom(start) };
      return head;
    }
    if (head.k === "TVar") {
      const args: TypeExpr[] = [];
      while (this.startsAType()) args.push(this.parseAType());
      if (args.length) return { k: "TCon", name: head.name, args, span: this.spanFrom(start) };
    }
    return head;
  }

  private parenthesized = new WeakSet<object>();

  /** A type without arrows (class / instance heads). */
  private parseBTypeNoArrow(): TypeExpr {
    return this.parseBType();
  }

  private qualConName(): string {
    const parts = [this.expect("Con").value];
    while (this.atOp(".") && !this.raw.spBefore && !this.raw.spAfter && this.peekRaw().kind === "Con") {
      this.next();
      parts.push(this.next().value);
    }
    return parts.join(".");
  }

  parseAType(): TypeExpr {
    const start = this.tok;

    if (this.atSym("(")) {
      return this.bracketed(() => {
        this.next();
        if (this.atSym(")")) { this.next(); return { k: "TCon", name: "Unit", args: [], span: this.spanFrom(start) } as TypeExpr; }
        const items: TypeExpr[] = [this.parseType()];
        while (this.eat("sym", ",")) items.push(this.parseType());
        this.expectSym(")");
        if (items.length === 1) {
          const inner = items[0]!;
          if (inner.k === "TCon") this.parenthesized.add(inner);
          return inner;
        }
        return { k: "TTuple", items, span: this.spanFrom(start) } as TypeExpr;
      });
    }

    if (this.atSym("[")) {
      return this.bracketed(() => {
        this.next();
        const el = this.parseType();
        this.expectSym("]");
        return { k: "TCon", name: "List", args: [el], span: this.spanFrom(start) } as TypeExpr;
      });
    }

    if (this.atSym("{")) {
      const fields = this.parseRecordTypeFields();
      return { k: "TRecord", fields, span: this.spanFrom(start) };
    }

    if (this.tok.kind === "Con") {
      const name = this.qualConName();
      return { k: "TCon", name, args: [], span: this.spanFrom(start) };
    }

    if (this.tok.kind === "id") {
      const name = this.next().value;
      return { k: "TVar", name, span: this.spanFrom(start) };
    }

    this.err(`expected a type, found ${this.show(this.tok)}`);
  }

  private parseRecordTypeFields(): { name: string; type: TypeExpr }[] {
    return this.bracketed(() => {
      this.expectSym("{");
      const fields: { name: string; type: TypeExpr }[] = [];
      while (!this.atSym("}")) {
        const name = this.expect("id").value;
        this.expectOp("::");
        const type = this.parseType();
        fields.push({ name, type });
        if (!this.eat("sym", ",")) break;
      }
      this.expectSym("}");
      return fields;
    });
  }

  /* ---------- patterns ---------- */

  private startsAPat(): boolean {
    const t = this.tok;
    if (t.kind === "id" || t.kind === "Con" || t.kind === "num" || t.kind === "float" || t.kind === "str") return true;
    return t.kind === "sym" && (t.value === "(" || t.value === "[" || t.value === "{");
  }

  /** A full pattern: constructor application and `:` cons. */
  parsePat(): Pattern {
    const start = this.tok;
    const head = this.parsePat10();
    if (this.atOp(":")) {
      this.next();
      const rest = this.parsePat();
      const items = [head];
      let restName: string | undefined;
      if (rest.k === "PList") { items.push(...rest.items); restName = rest.rest; }
      else if (rest.k === "PVar") restName = rest.name;
      else if (rest.k === "PWild") restName = this.fresh("_r");
      else this.err("the tail of a `:` pattern must be a variable", start);
      return { k: "PList", items, rest: restName, span: this.spanFrom(start) };
    }
    return head;
  }

  private parsePat10(): Pattern {
    const start = this.tok;
    if (start.kind === "Con") {
      const name = this.qualConName();
      if (name === "True" || name === "False") return { k: "PLit", lit: { k: "Bool", v: name === "True" }, span: this.spanFrom(start) };
      const args: Pattern[] = [];
      while (this.startsAPat()) args.push(this.parseAPat());
      return { k: "PCtor", name, args, span: this.spanFrom(start) };
    }
    return this.parseAPat();
  }

  parseAPat(): Pattern {
    const t = this.tok;
    if (t.kind === "id") {
      this.next();
      if (t.value === "_") return { k: "PWild", span: this.spanFrom(t) };
      return { k: "PVar", name: t.value, span: this.spanFrom(t) };
    }
    if (t.kind === "num") { this.next(); return { k: "PLit", lit: { k: "Int", v: Number(t.value) }, span: this.spanFrom(t) }; }
    if (t.kind === "float") { this.next(); return { k: "PLit", lit: { k: "Float", v: Number(t.value) }, span: this.spanFrom(t) }; }
    if (t.kind === "str") { this.next(); return { k: "PLit", lit: { k: "Str", v: t.value }, span: this.spanFrom(t) }; }
    if (t.kind === "op" && t.value === "-" && (this.peekRaw().kind === "num" || this.peekRaw().kind === "float")) {
      this.next();
      const n = this.next();
      return { k: "PLit", lit: n.kind === "num" ? { k: "Int", v: -Number(n.value) } : { k: "Float", v: -Number(n.value) }, span: this.spanFrom(t) };
    }
    if (t.kind === "Con") {
      const name = this.qualConName();
      if (name === "True" || name === "False") return { k: "PLit", lit: { k: "Bool", v: name === "True" }, span: this.spanFrom(t) };
      return { k: "PCtor", name, args: [], span: this.spanFrom(t) };
    }
    if (this.atSym("(")) {
      return this.bracketed(() => {
        this.next();
        if (this.atSym(")")) { this.next(); return { k: "PLit", lit: { k: "Unit" }, span: this.spanFrom(t) } as Pattern; }
        const items: Pattern[] = [this.parsePat()];
        if (this.atOp("::") && items[0]!.k === "PVar") {
          this.next();
          const ann = this.parseType();
          this.expectSym(")");
          return { ...(items[0] as { k: "PVar"; name: string; span: Span }), ann, span: this.spanFrom(t) } as Pattern;
        }
        while (this.eat("sym", ",")) items.push(this.parsePat());
        this.expectSym(")");
        return items.length === 1 ? items[0]! : ({ k: "PTuple", items, span: this.spanFrom(t) } as Pattern);
      });
    }
    if (this.atSym("[")) {
      return this.bracketed(() => {
        this.next();
        const items: Pattern[] = [];
        while (!this.atSym("]")) {
          items.push(this.parsePat());
          if (!this.eat("sym", ",")) break;
        }
        this.expectSym("]");
        return { k: "PList", items, span: this.spanFrom(t) } as Pattern;
      });
    }
    if (this.atSym("{")) {
      return this.bracketed(() => {
        this.next();
        const fields: { name: string; pat: Pattern }[] = [];
        while (!this.atSym("}")) {
          const ft = this.expect("id");
          let pat: Pattern;
          if (this.atOp("=")) { this.next(); pat = this.parsePat(); }
          else pat = { k: "PVar", name: ft.value, span: this.spanFrom(ft) };
          fields.push({ name: ft.value, pat });
          if (!this.eat("sym", ",")) break;
        }
        this.expectSym("}");
        return { k: "PRecord", fields, span: this.spanFrom(t) } as Pattern;
      });
    }
    this.err(`expected a pattern, found ${this.show(t)}`);
  }

  /* ---------- expressions ---------- */

  parseExpr(): Expr {
    const start = this.tok;
    let left = this.parseOpExpr(0);

    if (this.atOp("::")) {
      this.next();
      const ann = this.parseType();
      // `(e :: T)`: an annotation is a let binding that is immediately read back
      const name = this.fresh("_ann");
      const span = this.spanFrom(start);
      left = { k: "Let", name, mut: false, ann, value: left, body: { k: "Var", name, span }, span };
    }

    if (this.tok.kind === "op" && ASSIGN_OPS.has(this.tok.value)) {
      const op = this.next().value;
      const value = this.parseExpr();
      return {
        k: "Assign", target: left, op: (op === ":=" ? "=" : op) as "=" | "+=" | "-=" | "*=" | "/=" | "++" | "--",
        value, span: loc(left, value, this.file),
      };
    }
    return left;
  }

  private binOp(): { op: string; info: OpInfo; ticks: boolean } | null {
    const t = this.tok;
    if (t.kind === "op") {
      const info = OPS[t.value];
      if (info) return { op: t.value, info, ticks: false };
      return null;
    }
    if (t.kind === "sym" && t.value === "`") {
      return { op: "`", info: BACKTICK_PREC, ticks: true };
    }
    return null;
  }

  private parseOpExpr(minPrec: number): Expr {
    let left = this.parseOperand();
    for (;;) {
      const o = this.binOp();
      if (!o || o.info.prec < minPrec) break;
      // `(e op)` is a left section: leave the operator to the paren parser
      if (!o.ticks && this.peekRaw().kind === "sym" && this.peekRaw().value === ")") break;
      let opName = o.op;
      let fnVar: Expr | null = null;
      if (o.ticks) {
        this.next();
        const nt = this.tok;
        if (nt.kind !== "id" && nt.kind !== "Con") this.err("expected a function name between backticks", nt);
        this.next();
        fnVar = nt.kind === "Con" ? { k: "Ctor", name: nt.value, args: [], span: this.spanOf(nt) } : { k: "Var", name: nt.value, span: this.spanOf(nt) };
        this.expectSym("`");
        opName = "`" + nt.value;
      } else {
        this.next();
      }
      const right = this.parseOpExpr(o.info.right ? o.info.prec : o.info.prec + 1);
      left = this.mkBinary(opName, left, right, fnVar);
    }
    return left;
  }

  private mkBinary(op: string, l: Expr, r: Expr, fnVar: Expr | null): Expr {
    const span = loc(l, r, this.file);
    if (fnVar) return { k: "App", fn: fnVar, args: [l, r], span };
    switch (op) {
      case "$": case "<|": return { k: "App", fn: l, args: [r], span };
      case "|>": return { k: "App", fn: r, args: [l], span };
      case ".": {
        const x = this.fresh("_c");
        const xv: Expr = { k: "Var", name: x, span };
        return {
          k: "Lam", params: [{ name: x, type: { k: "TVar", name: "_", span }, span }],
          body: { k: "App", fn: l, args: [{ k: "App", fn: r, args: [xv], span }], span }, span,
        };
      }
      case ":": return { k: "App", fn: { k: "Var", name: "cons", span }, args: [l, r], span };
      case "/=": return { k: "Binary", op: "!=", l, r, span };
      default: return { k: "Binary", op, l, r, span };
    }
  }

  private parseOperand(): Expr {
    const start = this.tok;
    if (this.atOp("-")) {
      this.next();
      const e = this.parseOperand();
      if (e.k === "Lit" && (e.lit.k === "Int" || e.lit.k === "Float")) {
        return { k: "Lit", lit: { ...e.lit, v: -e.lit.v } as typeof e.lit, span: this.spanFrom(start) };
      }
      return { k: "Unary", op: "-", e, span: this.spanFrom(start) };
    }
    return this.parseApp();
  }

  private startsArg(): boolean {
    const t = this.tok;
    switch (t.kind) {
      case "id": case "Con": case "num": case "float": case "str": return true;
      case "sym": return t.value === "(" || t.value === "[" || t.value === "{";
      case "op": return this.startsMarkup();
      default: return false;
    }
  }

  private startsMarkup(): boolean {
    const t = this.tok;
    if (t.kind !== "op") return false;
    if (t.value === "<>") return true;
    if (t.value !== "<" || t.spAfter) return false;
    const n = this.peekRaw();
    return (n.kind === "id" || n.kind === "Con" || n.kind === "kw") && n.start === t.end;
  }

  private startsBlockArg(): boolean {
    const t = this.tok;
    if (t.kind === "sym") return t.value === "\\";
    return t.kind === "kw" && (t.value === "do" || t.value === "case" || t.value === "if" || t.value === "let" || t.value === "handle");
  }

  private parseApp(): Expr {
    const start = this.tok;
    const head = this.parsePostfix();
    const args: Expr[] = [];
    for (;;) {
      if (this.startsArg()) { args.push(this.parsePostfix()); continue; }
      if (this.startsBlockArg()) { args.push(this.parsePrimary()); break; }
      break;
    }
    if (!args.length) return head;
    if (head.k === "Ctor" && head.args.length === 0) {
      return { k: "Ctor", name: head.name, args, span: this.spanFrom(start) };
    }
    return { k: "App", fn: head, args, span: this.spanFrom(start) };
  }

  /** An atom followed by tight `.field` / `.Con` projections. */
  private parsePostfix(): Expr {
    let e = this.parsePrimary();
    for (;;) {
      const t = this.tok;
      if (t.kind === "op" && t.value === "." && !t.spBefore && !t.spAfter) {
        const n = this.peekRaw();
        if (n.kind === "id" || n.kind === "num") {
          this.next();
          const name = this.next().value;
          e = { k: "Field", target: e, name, span: { start: e.span.start, end: this.toks[this.pos - 1]!.end, line: e.span.line, col: e.span.col, file: this.file } };
          continue;
        }
        if (n.kind === "Con" && e.k === "Ctor" && e.args.length === 0) {
          // qualified constructor `Option.Some`, qualified module path `A.B.f`
          this.next();
          const c = this.next();
          e = { k: "Ctor", name: `${e.name}.${c.value}`, args: [], span: { ...e.span, end: c.end } };
          continue;
        }
      }
      break;
    }
    return e;
  }

  private parsePrimary(): Expr {
    const t = this.tok;

    if (t.kind === "num") { this.next(); return { k: "Lit", lit: { k: "Int", v: Number(t.value) }, span: this.spanFrom(t) }; }
    if (t.kind === "float") { this.next(); return { k: "Lit", lit: { k: "Float", v: Number(t.value) }, span: this.spanFrom(t) }; }
    if (t.kind === "str") { this.next(); return { k: "Lit", lit: { k: "Str", v: t.value }, span: this.spanFrom(t) }; }

    if (t.kind === "kw") {
      switch (t.value) {
        case "if": return this.parseIf();
        case "case": return this.parseCase();
        case "let": return this.parseLet();
        case "do": return this.parseDo();
        case "handle": return this.parseHandle();
      }
    }

    if (t.kind === "sym" && t.value === "\\") return this.parseLambda();

    if (t.kind === "op" && this.startsMarkup()) return this.parseMarkup();

    if (t.kind === "sym" && t.value === "(") return this.parseParen();

    if (t.kind === "sym" && t.value === "[") {
      return this.bracketed(() => {
        this.next();
        const items: Expr[] = [];
        while (!this.atSym("]")) {
          items.push(this.parseExpr());
          if (!this.eat("sym", ",")) break;
        }
        this.expectSym("]");
        return { k: "List", items, span: this.spanFrom(t) } as Expr;
      });
    }

    if (t.kind === "sym" && t.value === "{") {
      return this.bracketed(() => {
        this.next();
        const fields: { name: string; value: Expr }[] = [];
        while (!this.atSym("}")) {
          const ft = this.expect("id");
          let value: Expr;
          if (this.atOp("=")) { this.next(); value = this.parseExpr(); }
          else value = { k: "Var", name: ft.value, span: this.spanOf(ft) };
          fields.push({ name: ft.value, value });
          if (!this.eat("sym", ",")) break;
        }
        this.expectSym("}");
        return { k: "Record", fields, span: this.spanFrom(t) } as Expr;
      });
    }

    if (t.kind === "Con") {
      this.next();
      if (t.value === "True" || t.value === "False") {
        return { k: "Lit", lit: { k: "Bool", v: t.value === "True" }, span: this.spanFrom(t) };
      }
      return { k: "Ctor", name: t.value, args: [], span: this.spanFrom(t) };
    }

    if (t.kind === "id") {
      this.next();
      if (t.value === "_") this.err("a wildcard `_` can only be used in patterns", t);
      return { k: "Var", name: t.value, span: this.spanFrom(t) };
    }

    this.err(`expected an expression, found ${this.show(t)}`);
  }

  private parseParen(): Expr {
    const t = this.tok;
    return this.bracketed(() => {
      this.next(); // (
      if (this.atSym(")")) { this.next(); return { k: "Lit", lit: { k: "Unit" }, span: this.spanFrom(t) } as Expr; }

      // operator section or operator as a function: (+ 1)  (+)  (`div` 2)
      const o0 = this.tok;
      if ((o0.kind === "op" && o0.value !== "-" && !this.startsMarkup() && o0.value !== "\\") || (o0.kind === "sym" && o0.value === "`")) {
        const info = this.binOp();
        if (info || o0.kind === "op") {
          let fnVar: Expr | null = null;
          let opName = o0.value;
          this.next();
          if (info && info.ticks) {
            const nt = this.tok;
            this.next();
            fnVar = nt.kind === "Con" ? { k: "Ctor", name: nt.value, args: [], span: this.spanOf(nt) } : { k: "Var", name: nt.value, span: this.spanOf(nt) };
            this.expectSym("`");
            opName = "`" + nt.value;
          }
          const span = this.spanFrom(t);
          if (this.atSym(")")) {
            this.next();
            const a = this.fresh("_s"), b = this.fresh("_s");
            const tv = (n: string): Param => ({ name: n, type: { k: "TVar", name: "_", span }, span });
            const av: Expr = { k: "Var", name: a, span }, bv: Expr = { k: "Var", name: b, span };
            return { k: "Lam", params: [tv(a), tv(b)], body: this.mkBinary(opName, av, bv, fnVar), span } as Expr;
          }
          const operand = this.parseOpExpr(OPS[o0.value]?.prec ?? 0);
          this.expectSym(")");
          const x = this.fresh("_s");
          const xv: Expr = { k: "Var", name: x, span };
          return {
            k: "Lam", params: [{ name: x, type: { k: "TVar", name: "_", span }, span }],
            body: this.mkBinary(opName, xv, operand, fnVar), span: this.spanFrom(t),
          } as Expr;
        }
      }

      const first = this.parseExpr();

      // left section: (e +)
      const ob = this.binOp();
      if (ob && !(ob.ticks) && this.peekRaw().kind === "sym" && this.peekRaw().value === ")") {
        const opTok = this.next();
        this.expectSym(")");
        const span = this.spanFrom(t);
        const x = this.fresh("_s");
        const xv: Expr = { k: "Var", name: x, span };
        return {
          k: "Lam", params: [{ name: x, type: { k: "TVar", name: "_", span }, span }],
          body: this.mkBinary(opTok.value, first, xv, null), span,
        } as Expr;
      }

      if (this.atSym(",")) {
        const items = [first];
        while (this.eat("sym", ",")) items.push(this.parseExpr());
        this.expectSym(")");
        return { k: "Tuple", items, span: this.spanFrom(t) } as Expr;
      }
      this.expectSym(")");
      return first;
    });
  }

  /* ---------- control forms ---------- */

  private parseIf(): Expr {
    const start = this.expectKw("if");
    const cond = this.parseExpr();
    this.skipSemiBefore("then");
    this.expectKw("then");
    const then = this.parseExpr();
    this.skipSemiBefore("else");
    this.expectKw("else");
    const els = this.parseExpr();
    return { k: "If", cond, then, else: els, span: this.spanFrom(start) };
  }

  private parseCase(): Expr {
    const start = this.expectKw("case");
    const scrut = this.parseExpr();
    this.skipSemiBefore("of");
    this.expectKw("of");
    const alts = this.blockItems<MatchArm[]>(() => this.parseAlt());
    const arms = alts.flat();
    return { k: "Match", scrut, arms, span: this.spanFrom(start) };
  }

  private parseAlt(): MatchArm[] {
    const start = this.tok;
    const pat = this.parsePat();
    const rhs = this.parseRhs("->");
    return this.rhsToArms(rhs, pat, start);
  }

  private parseLet(): Expr {
    const start = this.expectKw("let");
    let bindings = this.blockItems<Binding>(() => this.parseLocalItem());
    bindings = this.attachSigs(bindings);
    this.skipSemiBefore("in");
    this.expectKw("in");
    const body = this.parseExpr();
    return { ...this.bindingsToLets(bindings, body), span: this.spanFrom(start) };
  }

  private parseLambda(): Expr {
    const start = this.expectSym("\\");
    if (this.atKw("case")) {
      this.next();
      this.skipSemiBefore("of");
      const x = this.fresh("_k");
      const alts = this.blockItems<MatchArm[]>(() => this.parseAlt());
      const span = this.spanFrom(start);
      return {
        k: "Lam", params: [{ name: x, type: { k: "TVar", name: "_", span }, span }],
        body: { k: "Match", scrut: { k: "Var", name: x, span }, arms: alts.flat(), span }, span,
      };
    }
    const pats: Pattern[] = [];
    while (this.startsAPat()) pats.push(this.parseAPat());
    if (!pats.length) this.err("a lambda needs at least one parameter: \\x -> …", this.tok);
    this.expectOp("->");
    const body = this.parseExpr();
    const { params, body: wrapped } = this.clausesToFn([{ name: "", pats, rhs: { body, where: [] }, nameTok: start }], undefined);
    // `\x -> \y -> e` is one two-parameter function
    if (wrapped.k === "Lam" && wrapped.params.every((p) => p.type.k === "TVar" && p.type.name === "_") &&
        params.every((p) => p.type.k === "TVar" && p.type.name === "_")) {
      return { k: "Lam", params: [...params, ...wrapped.params], body: wrapped.body, span: this.spanFrom(start) };
    }
    return { k: "Lam", params, body: wrapped, span: this.spanFrom(start) };
  }

  private parseHandle(): Expr {
    const start = this.expectKw("handle");
    const effect = this.qualConName();
    this.expectKw("with");
    const bindings = this.blockItems<Binding>(() => this.parseBinding());
    const ops = this.groupBindings(bindings).map((g) => ({
      name: g.name,
      fn: this.opLambda(g.clauses),
      span: this.spanOf(g.clauses[0]!.nameTok),
    }));
    this.skipSemiBefore("in");
    this.expectKw("in");
    const body = this.parseExpr();
    return { k: "Handle", effect, ops, body, span: this.spanFrom(start) };
  }

  /* ---------- do notation ---------- */

  private parseDo(): Expr {
    const start = this.expectKw("do");
    type DoStmt =
      | { k: "bind"; pat: Pattern; value: Expr; span: Span }
      | { k: "let"; bindings: Binding[]; span: Span }
      | { k: "expr"; e: Expr; span: Span };
    const stmts = this.blockItems<DoStmt>(() => {
      const t = this.tok;
      if (this.atKw("let")) {
        // `let` without `in` inside a do block
        const save = this.snapshot();
        this.next();
        let bindings = this.blockItems<Binding>(() => this.parseLocalItem());
        bindings = this.attachSigs(bindings);
        if (this.atKw("in")) {
          // it was a let-expression statement: re-parse as an expression
          this.restore(save);
          const e = this.parseExpr();
          return { k: "expr", e, span: e.span };
        }
        return { k: "let", bindings, span: this.spanFrom(t) };
      }
      // `pat <- expr`
      const save = this.snapshot();
      try {
        const pat = this.parsePat();
        if (this.atOp("<-")) {
          this.next();
          const value = this.parseExpr();
          return { k: "bind", pat, value, span: this.spanFrom(t) };
        }
      } catch (e) {
        if (!(e instanceof FlowError)) throw e;
      }
      this.restore(save);
      const e = this.parseExpr();
      return { k: "expr", e, span: e.span };
    });
    if (!stmts.length) this.err("an empty do block", start);
    const last = stmts[stmts.length - 1]!;
    if (last.k !== "expr") this.err("the last statement of a do block must be an expression", last.span as unknown as Token);

    const build = (i: number): Expr => {
      const prefix: Stmt[] = [];
      let j = i;
      for (; j < stmts.length - 1; j++) {
        const s = stmts[j]!;
        if (s.k === "expr") { prefix.push({ k: "ExprStmt", e: s.e, span: s.span }); continue; }
        if (s.k === "let") {
          const simple = s.bindings.every((b) => !b.pattern && b.pats.length === 0 && s.bindings.filter((x) => x.name === b.name).length === 1);
          if (simple) {
            for (const b of s.bindings) {
              prefix.push({ k: "LetStmt", name: b.name, mut: false, ann: b.ann, value: this.rhsToExpr(b.rhs, b.nameTok), span: this.spanOf(b.nameTok) });
            }
            continue;
          }
          break;
        }
        break;
      }
      let value: Expr;
      if (j >= stmts.length - 1) {
        value = (stmts[stmts.length - 1] as { e: Expr }).e;
      } else {
        const s = stmts[j]!;
        const rest = build(j + 1);
        if (s.k === "bind") {
          const { params, body } = this.clausesToFn([{ name: "", pats: [s.pat], rhs: { body: rest, where: [] }, nameTok: this.raw }], undefined);
          const lam: Expr = { k: "Lam", params, body, span: loc(s.value, rest, this.file) };
          value = { k: "Binary", op: ">>=", l: s.value, r: lam, span: loc(s.value, rest, this.file) };
        } else if (s.k === "let") {
          value = this.bindingsToLets(s.bindings, rest);
        } else {
          value = rest;
        }
      }
      if (!prefix.length) return value;
      return { k: "Block", stmts: prefix, value, span: loc(prefix[0]!.k === "ExprStmt" ? prefix[0]!.e : (prefix[0] as { value: Expr }).value, value, this.file) };
    };
    const out = build(0);
    return out;
  }

  private snapshot() {
    return { pos: this.pos, layout: this.layout.slice(), semiAt: this.semiAt, uid: this.uid };
  }
  private restore(s: { pos: number; layout: number[]; semiAt: number; uid: number }) {
    this.pos = s.pos; this.layout = s.layout; this.semiAt = s.semiAt; this.uid = s.uid;
  }

  /* ---------- markup ---------- */

  private parseMarkup(): Expr {
    const start = this.raw;
    if (start.kind === "op" && start.value === "<>") {
      this.pos++;
      const nodes = this.parseHtmlChildren(null);
      return { k: "Html", nodes, span: this.spanFrom(start) };
    }
    const el = this.parseHtmlElement();
    return { k: "Html", nodes: [el], span: el.span };
  }

  /** Consume a `>` that may be glued to following text (`>-`, `>=`). */
  private eatGt(): void {
    const t = this.raw;
    if (t.kind === "op" && t.value[0] === ">") {
      if (t.value.length === 1) { this.pos++; return; }
      this.toks[this.pos] = { ...t, value: t.value.slice(1), start: t.start + 1, col: t.col + 1, spBefore: false };
      return;
    }
    this.err(`expected '>', found ${this.show(t)}`, t);
  }

  private tagName(): { name: string; isComponent: boolean; tok: Token } {
    const t = this.raw;
    if (t.kind !== "id" && t.kind !== "Con" && t.kind !== "kw") this.err("expected a tag name after '<'", t);
    this.pos++;
    let name = t.value;
    // custom element names: my-element
    while (this.raw.kind === "op" && this.raw.value === "-" && !this.raw.spBefore && !this.raw.spAfter) {
      this.pos++;
      name += "-" + this.raw.value;
      this.pos++;
    }
    return { name, isComponent: t.kind === "Con", tok: t };
  }

  private parseHtmlElement(): HtmlNode {
    const start = this.raw;
    if (!(start.kind === "op" && start.value === "<")) this.err("expected '<'", start);
    this.pos++;
    const { name, isComponent } = this.tagName();

    const attrs: HtmlAttr[] = [];
    for (;;) {
      const r = this.raw;
      if (r.kind === "op" && (r.value === "/>" || r.value[0] === ">")) break;
      if (r.kind !== "id" && r.kind !== "Con" && r.kind !== "kw") this.err(`expected an attribute name or '>', found ${this.show(r)}`, r);
      this.pos++;
      let aname = r.value;
      while (this.raw.kind === "op" && this.raw.value === "-" && !this.raw.spBefore && !this.raw.spAfter) {
        this.pos++;
        aname += "-" + this.raw.value;
        this.pos++;
      }
      let value: HtmlAttr["value"] = { k: "static", v: "" };
      if (this.raw.kind === "op" && this.raw.value === "=") {
        this.pos++;
        if (this.raw.kind === "str") {
          value = { k: "static", v: this.raw.value };
          this.pos++;
        } else if (this.raw.kind === "sym" && this.raw.value === "{") {
          value = { k: "expr", e: this.parseHole() };
        } else {
          this.err("attribute value must be a string literal or { expression }", this.raw);
        }
      }
      attrs.push({ name: aname, value, span: this.spanOf(r) });
    }

    if (this.raw.kind === "op" && this.raw.value === "/>") {
      this.pos++;
      return isComponent
        ? { k: "Component", name, attrs, children: [], span: this.spanFrom(start) }
        : { k: "Element", tag: name, attrs, children: [], span: this.spanFrom(start) };
    }
    this.eatGt();
    const children = this.parseHtmlChildren(name);
    return isComponent
      ? { k: "Component", name, attrs, children, span: this.spanFrom(start) }
      : { k: "Element", tag: name, attrs, children, span: this.spanFrom(start) };
  }

  /** `{ expression }` inside markup: layout is suspended for its duration. */
  private parseHole(): Expr {
    this.pos++; // {
    this.layout.push(0);
    const depth = this.layout.length;
    try {
      const e = this.parseExpr();
      const r = this.raw;
      if (!(r.kind === "sym" && r.value === "}")) this.err(`expected '}', found ${this.show(this.tok)}`, r);
      this.pos++;
      return e;
    } finally {
      this.layout.length = depth - 1;
    }
  }

  private parseHtmlChildren(closeTag: string | null): HtmlNode[] {
    const nodes: HtmlNode[] = [];
    for (;;) {
      const r = this.raw;
      if (r.kind === "eof") this.err("unterminated markup");
      if (r.kind === "op" && r.value === "</") {
        this.pos++;
        if (closeTag === null) {
          this.eatGt();
          return nodes;
        }
        const { name } = this.tagName();
        if (name !== closeTag) this.err(`mismatched closing tag </${name}>, expected </${closeTag}>`);
        this.eatGt();
        return nodes;
      }
      if (r.kind === "op" && r.value === "<" && !r.spAfter) {
        nodes.push(this.parseHtmlElement());
        continue;
      }
      if (r.kind === "op" && r.value === "<>") {
        this.pos++;
        nodes.push(...this.parseHtmlChildren(null));
        continue;
      }
      if (r.kind === "sym" && r.value === "{") {
        const hs = r;
        const e = this.parseHole();
        nodes.push({ k: "Hole", e, span: { start: hs.start, end: this.toks[this.pos - 1]!.end, line: hs.line, col: hs.col, file: this.file } });
        continue;
      }
      // raw text run up to the next tag or hole
      const textStart = r.start;
      let textEnd = textStart;
      while (this.raw.kind !== "eof") {
        const x = this.raw;
        if (x.kind === "sym" && x.value === "{") break;
        if (x.kind === "op" && (x.value === "</" || x.value === "<>" || (x.value === "<" && !x.spAfter))) break;
        textEnd = x.end;
        this.pos++;
      }
      const text = this.src.slice(textStart, textEnd);
      if (text.trim().length > 0) {
        nodes.push({ k: "Text", v: collapseWs(text), span: { start: textStart, end: textEnd, line: r.line, col: r.col, file: this.file } });
      }
    }
  }
}

type TopItem =
  | { k: "decl"; decl: Decl }
  | { k: "sig"; name: string; sig: Sig }
  | { k: "clause"; binding: Binding };

function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").replace(/^ | $/g, "");
}

export function parse(src: string, file = "<input>", opts: { recover?: boolean } = {}): Program {
  return new Parser(src, file, opts).parseProgram();
}

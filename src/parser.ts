/**
 * Flow — recursive-descent + Pratt parser.
 * Grammar reference: docs/grammar.ebnf
 */

import { lex, FlowError } from "./lexer.ts";
import type { Token } from "./lexer.ts";
import type {
  Decl, Expr, HtmlAttr, HtmlNode, MatchArm, Param, Pattern, Program, Span,
  Stmt, TypeExpr, EffRow, Place, FnSig,
} from "./ast.ts";

const PREC: Record<string, number> = {
  or: 1, "||": 1,
  and: 2, "&&": 2,
  "==": 3, "!=": 3, "<": 3, "<=": 3, ">": 3, ">=": 3,
  "+": 4, "-": 4,
  "*": 5, "/": 5, "%": 5,
};

export class Parser {
  src: string;
  file: string;
  toks: Token[];
  pos = 0;
  lastSpan: Span = { start: 0, end: 0, line: 1, col: 1 };

  constructor(src: string, file = "<input>") {
    this.src = src;
    this.file = file;
    this.toks = lex(src, file);
  }

  /* ---------- token helpers ---------- */

  get tok(): Token { return this.toks[this.pos]!; }
  peek(n = 1): Token { return this.toks[Math.min(this.pos + n, this.toks.length - 1)]!; }

  at(kind: string, value?: string): boolean {
    const t = this.tok;
    if (t.kind !== kind) return false;
    return value === undefined || t.value === value;
  }
  atKw(v: string) { return this.at("kw", v); }
  atSym(v: string) { return this.at("sym", v); }

  next(): Token {
    const t = this.tok;
    if (this.pos < this.toks.length - 1) this.pos++;
    this.lastSpan = { start: t.start, end: t.end, line: t.line, col: t.col };
    return t;
  }

  eat(kind: string, value?: string): Token | null {
    if (this.at(kind, value)) return this.next();
    return null;
  }
  eatKw(v: string) { return this.eat("kw", v); }
  eatSym(v: string) { return this.eat("sym", v); }

  expect(kind: string, value?: string): Token {
    if (this.at(kind, value)) return this.next();
    const t = this.tok;
    const want = value ?? kind;
    this.err(`expected ${JSON.stringify(want)}, found ${JSON.stringify(t.value)}`, t);
  }
  expectKw(v: string) { return this.expect("kw", v); }
  expectSym(v: string) { return this.expect("sym", v); }

  err(msg: string, t: Token = this.tok): never {
    throw new FlowError(msg, { file: this.file, line: t.line, col: t.col, code: "E_PARSE" });
  }

  spanFrom(start: Token, endTok?: Token): Span {
    const e = endTok ?? this.toks[Math.max(0, this.pos - 1)]!;
    return { start: start.start, end: e.end, line: start.line, col: start.col, file: this.file };
  }

  /* ---------- program ---------- */

  parseProgram(): Program {
    const decls: Decl[] = [];
    while (!this.at("eof")) {
      decls.push(this.parseDecl());
    }
    return { decls, file: this.file };
  }

  parseDecl(): Decl {
    const t = this.tok;

    if (this.atKw("use")) return this.parseUse(t);

    let pub = false;
    if (this.atKw("pub")) { this.next(); pub = true; }

    if (this.atKw("extern") || this.atKw("unsafe")) return this.parseExtern(t, pub);
    if (this.atKw("type")) return this.parseTypeDecl(t, pub);
    if (this.atKw("trait")) return this.parseTrait(t, pub);
    if (this.atKw("impl")) return this.parseImpl(t);
    if (this.atKw("effect")) return this.parseEffect(t, pub);
    if (this.atKw("provide")) return this.parseProvide(t);

    if (this.atKw("fn")) {
      this.expectKw("fn");
      const sig = this.parseFnSig();
      const body = this.parseBlock();
      return { k: "Fn", ...sig, body, pub, span: this.spanFrom(t) };
    }

    this.err(`expected a declaration, found ${JSON.stringify(this.tok.value)}`);
  }

  parseUse(start: Token): Decl {
    this.expectKw("use");
    const segments: string[] = [];
    const items: { name: string; alias?: string }[] = [];
    let glob = false;

    segments.push(this.pathSegment());

    let braced = false;
    while (this.eatSym("::")) {
      if (this.atSym("{")) {
        this.next();
        braced = true;
        while (!this.atSym("}")) {
          items.push({ name: this.word(), alias: this.eatKw("as") ? this.word() : undefined });
          if (!this.eatSym(",")) break;
        }
        this.expectSym("}");
        break;
      }
      if (this.atSym("*")) { this.next(); glob = true; break; }
      segments.push(this.pathSegment());
    }
    this.eatSym(";");

    // resolve "package::module::item" later: keep the raw path plus any trailing item
    let tailItem: { name: string; alias?: string } | undefined;
    if (!braced && !glob && segments.length >= 3) {
      const name = segments.pop()!;
      const alias = this.eatKw("as") ? this.word() : undefined;
      tailItem = { name, alias };
    }
    return {
      k: "Use",
      path: segments,
      items: tailItem ? [tailItem] : items,
      glob,
      span: this.spanFrom(start),
    };
  }

  /** A module path segment: identifiers, constructors and keywords are all
   *  legal, because module files may be named `html`, `type`, `match`, … */
  word(): string {
    const t = this.tok;
    if (t.kind === "id" || t.kind === "Con" || t.kind === "kw") { this.next(); return t.value; }
    this.err(`expected a name, found ${JSON.stringify(t.value)}`);
  }

  /** A module path segment: `html`, `list`, `flow-charts`, … */
  pathSegment(): string {
    let name = this.word();
    while (this.atSym("-")) {
      this.next();
      name += "-" + this.word();
    }
    return name;
  }

  parseExtern(start: Token, pub = false): Decl {
    if (!this.eatKw("unsafe")) this.err("FFI declarations must be explicitly marked `unsafe`", this.tok);
    this.expectKw("extern");
    const target = this.word();
    if (target !== "js") this.err(`unsupported FFI target '${target}' (expected js)`);
    this.expectKw("fn");
    const sig = this.parseFnSig();
    this.expectSym("=");
    const implName = this.expect("str").value;
    if (!/^(?:[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*|[@#][A-Za-z_$][A-Za-z0-9_$]*)$/.test(implName)) {
      this.err(`invalid JavaScript FFI target '${implName}' (expected "Math.floor", "@method" or "#property")`, start);
    }
    this.eatSym(";");
    return { k: "Extern", sig, target: "js", implName, unsafe: true, pub, span: this.spanFrom(start) };
  }

  parseTypeDecl(start: Token, pub = false): Decl {
    this.expectKw("type");
    const name = this.expect("Con").value;
    const { names: params, bounds } = this.parseTypeParams();

    // record type:  type T = { a: Int, ... }
    if (this.atSym("=") && this.peek().kind === "sym" && this.peek().value === "{") {
      this.next();
      const fields = this.parseRecordTypeFields();
      return { k: "RecordType", name, params, paramBounds: bounds, fields, pub, span: this.spanFrom(start) };
    }

    this.expectSym("=");

    // ADT when the right-hand side is a variant list: a leading '|', or a
    // constructor followed by a payload '(' or another '|'. Anything else is an
    // alias, so `type Id = Int` stays an alias.
    if (this.atSym("|") || (this.at("Con") && (this.peek().value === "(" || this.peek().value === "|"))) {
      return this.parseAdtBody(start, name, params, bounds, pub);
    }

    const type = this.parseType();
    this.eatSym(";");
    return { k: "Alias", name, params, paramBounds: bounds, type, pub, span: this.spanFrom(start) };
  }

  parseAdtBody(start: Token, name: string, params: string[], paramBounds: Record<string, string[]> = {}, pub = false): Decl {
    this.eatSym("|");
    const variants: { name: string; args: TypeExpr[]; span: Span }[] = [];
    do {
      const ct = this.expect("Con");
      const args: TypeExpr[] = [];
      if (this.eatSym("(")) {
        if (!this.atSym(")")) {
          do { args.push(this.parseType()); } while (this.eatSym(","));
        }
        this.expectSym(")");
      }
      variants.push({ name: ct.value, args, span: this.spanFrom(ct) });
    } while (this.eatSym("|"));
    this.eatSym(";");
    return { k: "Adt", name, params, paramBounds, variants, pub, span: this.spanFrom(start) };
  }

  parseTrait(start: Token, pub = false): Decl {
    this.expectKw("trait");
    const name = this.expect("Con").value;
    const { names: params, bounds } = this.parseTypeParams();
    this.expectSym("{");
    const methods: FnSig[] = [];
    while (!this.atSym("}")) {
      const t = this.tok;
      this.expectKw("fn");
      const sig = this.parseFnSig();
      this.eatSym(";");
      methods.push({ ...sig, span: this.spanFrom(t) });
    }
    this.expectSym("}");
    return { k: "Trait", name, params, paramBounds: bounds, methods, pub, span: this.spanFrom(start) };
  }

  parseImpl(start: Token): Decl {
    this.expectKw("impl");
    const trait = this.expect("Con").value;
    let traitArgs: TypeExpr[] = [];
    if (this.atSym("<")) traitArgs = this.parseTypeArgs();
    this.expectKw("for");
    const target = this.parseType();
    const where: { name: string; bounds: string[] }[] = [];
    if (this.tok.kind === "id" && this.tok.value === "where") {
      this.next();
      do {
        const name = this.typeVarName();
        this.expectSym(":");
        where.push({ name, bounds: this.parseTraitBounds() });
      } while (this.eatSym(","));
    }
    this.expectSym("{");
    const methods: (FnSig & { body: Expr })[] = [];
    while (!this.atSym("}")) {
      const t = this.tok;
      this.expectKw("fn");
      const sig = this.parseFnSig();
      const body = this.parseBlock();
      methods.push({ ...sig, body, span: this.spanFrom(t) });
    }
    this.expectSym("}");
    return { k: "Impl", trait, traitArgs, target, where, methods, span: this.spanFrom(start) };
  }

  parseEffect(start: Token, pub = false): Decl {
    this.expectKw("effect");
    const name = this.expect("Con").value;
    let place: Place | undefined;
    if (this.eatSym("@")) {
      const p = this.word();
      if (p !== "client" && p !== "server") this.err(`unknown placement '${p}' (expected client|server)`);
      place = p as Place;
    }
    this.expectSym("{");
    const ops: FnSig[] = [];
    while (!this.atSym("}")) {
      const t = this.tok;
      this.expectKw("fn");
      const sig = this.parseFnSig();
      this.eatSym(";");
      ops.push({ ...sig, span: this.spanFrom(t) });
    }
    this.expectSym("}");
    return { k: "Effect", name, ops, pub, place, span: this.spanFrom(start) };
  }

  parseProvide(start: Token): Decl {
    this.expectKw("provide");
    const effect = this.expect("Con").value;
    let target: TypeExpr | undefined;
    if (this.atKw("for")) { this.next(); target = this.parseType(); }
    this.expectKw("with");
    this.expectSym("{");
    const ops: { name: string; fn: Expr; span: Span }[] = [];
    while (!this.atSym("}")) {
      const t = this.tok;
      const opName = this.expect("id").value;
      this.expectSym("=");
      const fn = this.parseExpr();
      this.eatSym(",");
      this.eatSym(";");
      ops.push({ name: opName, fn, span: this.spanFrom(t) });
    }
    this.expectSym("}");
    this.eatSym(";");
    return { k: "Provide", effect, target, ops, span: this.spanFrom(start) };
  }

  parseHandle(): Expr {
    const start = this.expectKw("handle");
    const effect = this.expect("Con").value;
    this.expectKw("with");
    this.expectSym("{");
    const ops: { name: string; fn: Expr; span: Span }[] = [];
    while (!this.atSym("}")) {
      const t = this.tok;
      const name = this.expect("id").value;
      this.expectSym("=");
      const fn = this.parseExpr();
      this.eatSym(",");
      this.eatSym(";");
      ops.push({ name, fn, span: this.spanFrom(t) });
    }
    this.expectSym("}");
    const body = this.parseBlock();
    return { k: "Handle", effect, ops, body, span: this.spanFrom(start) };
  }

  parseFnSig(): FnSig {
    const start = this.tok;
    const nameTok = this.tok;
    if (nameTok.kind !== "id" && nameTok.kind !== "Con") this.err("expected a function name", nameTok);
    this.next();
    const name = nameTok.value;
    const { names: typeParams, bounds } = this.parseTypeParams();
    this.expectSym("(");
    const params: Param[] = [];
    if (!this.atSym(")")) {
      do {
        const pt = this.tok;
        const pname = this.expect("id").value;
        this.expectSym(":");
        const type = this.parseType();
        params.push({ name: pname, type, span: this.spanFrom(pt) });
      } while (this.eatSym(","));
    }
    this.expectSym(")");
    let ret: TypeExpr | undefined;
    let eff: EffRow | undefined;
    if (this.eatSym("->")) ret = this.parseType();
    if (this.atSym("!")) { this.next(); eff = this.parseEffRow(); }
    return { name, typeParams, paramBounds: bounds, params, ret, eff, span: this.spanFrom(start) };
  }

  parseTypeParams(): { names: string[]; bounds: Record<string, string[]> } {
    const names: string[] = [];
    const bounds: Record<string, string[]> = {};
    if (this.atSym("<")) {
      this.next();
      do {
        const name = this.typeVarName();
        names.push(name);
        if (this.eatSym(":")) bounds[name] = this.parseTraitBounds();
      } while (this.eatSym(","));
      this.expectSym(">");
    }
    return { names, bounds };
  }

  parseTraitBounds(): string[] {
    const bounds: string[] = [];
    do { bounds.push(this.expect("Con").value); } while (this.eatSym("+"));
    return bounds;
  }

  typeVarName(): string {
    const t = this.tok;
    if (t.kind === "id" || t.kind === "Con") { this.next(); return t.value; }
    this.err("expected a type parameter name", t);
  }

  parseTypeArgs(): TypeExpr[] {
    this.expectSym("<");
    const args: TypeExpr[] = [];
    do { args.push(this.parseType()); } while (this.eatSym(","));
    this.expectSym(">");
    return args;
  }

  /* ---------- types ---------- */

  parseEffRow(): EffRow {
    const start = this.tok;
    const effects: string[] = [];
    let rowVar: string | undefined;
    if (this.eatSym("{")) {
      if (!this.atSym("}")) {
        do {
          if (this.tok.kind === "id") { rowVar = this.next().value; break; }
          effects.push(this.expect("Con").value);
        } while (this.eatSym(","));
      }
      this.expectSym("}");
    } else {
      // bare effect:  ! Server
      effects.push(this.expect("Con").value);
    }
    void start;
    return { effects, var: rowVar };
  }

  parseType(): TypeExpr {
    const start = this.tok;
    let t = this.parseTypeAtom();
    if (this.atSym("@")) {
      this.next();
      const p = this.expect("id").value;
      if (p !== "client" && p !== "server") this.err(`unknown placement ${JSON.stringify(p)} (expected client|server)`, start);
      t = { k: "TPlaced", inner: t, place: p as Place, span: this.spanFrom(start) };
    }
    if (this.eatSym("->")) {
      const ret = this.parseType();
      let eff: EffRow = { effects: [] };
      if (this.atSym("!")) { this.next(); eff = this.parseEffRow(); }
      // `(a, b) -> c` is a two-argument function; `((a, b)) -> c` takes a tuple.
      const params = t.k === "TTuple" ? t.items : [t];
      return { k: "TFun", params, ret, eff, span: this.spanFrom(start) };
    }
    return t;
  }

  parseTypeAtom(): TypeExpr {
    const start = this.tok;

    if (this.atSym("(")) {
      this.next();
      if (this.atSym(")")) { this.next(); return { k: "TCon", name: "Unit", args: [], span: this.spanFrom(start) }; }
      const items: TypeExpr[] = [this.parseType()];
      while (this.eatSym(",")) items.push(this.parseType());
      this.expectSym(")");
      if (items.length === 1) return items[0]!;
      return { k: "TTuple", items, span: this.spanFrom(start) };
    }

    if (this.atSym("{")) {
      const fields = this.parseRecordTypeFields();
      return { k: "TRecord", fields, span: this.spanFrom(start) };
    }

    if (this.tok.kind === "Con") {
      const name = this.next().value;
      const args = this.atSym("<") ? this.parseTypeArgs() : [];
      return { k: "TCon", name, args, span: this.spanFrom(start) };
    }

    if (this.tok.kind === "id") {
      const name = this.next().value;
      // A lowercase type parameter can be higher-kinded: `f<a>`.
      if (this.atSym("<")) {
        const args = this.parseTypeArgs();
        return { k: "TCon", name, args, span: this.spanFrom(start) };
      }
      return { k: "TVar", name, span: this.spanFrom(start) };
    }

    this.err(`expected a type, found ${JSON.stringify(this.tok.value)}`);
  }

  parseRecordTypeFields(): { name: string; type: TypeExpr }[] {
    this.expectSym("{");
    const fields: { name: string; type: TypeExpr }[] = [];
    while (!this.atSym("}")) {
      const name = this.expect("id").value;
      this.expectSym(":");
      const type = this.parseType();
      fields.push({ name, type });
      if (!this.eatSym(",")) break;
    }
    this.expectSym("}");
    return fields;
  }

  /* ---------- blocks & statements ---------- */

  parseBlock(): Expr {
    const start = this.expectSym("{");
    const stmts: Stmt[] = [];
    let value: Expr | undefined;

    while (!this.atSym("}")) {
      if (this.at("eof")) this.err("unterminated block", start);
      if (this.atKw("let")) {
        stmts.push(this.parseLetStmt());
        continue;
      }
      const e = this.parseExpr();
      if (this.eatSym(";")) {
        stmts.push({ k: "ExprStmt", e, span: e.span });
        continue;
      }
      // trailing expression = block value
      value = e;
      if (!this.atSym("}")) this.err(`expected ';' or '}' after expression, found ${JSON.stringify(this.tok.value)}`);
      break;
    }
    this.expectSym("}");
    return { k: "Block", stmts, value, span: this.spanFrom(start) };
  }

  parseLetStmt(): Stmt {
    const start = this.expectKw("let");
    const mut = !!this.eatKw("mut");
    const name = this.expect("id").value;
    let ann: TypeExpr | undefined;
    if (this.eatSym(":")) ann = this.parseType();
    this.expectSym("=");
    const value = this.parseExpr();
    this.eatSym(";");
    return { k: "LetStmt", name, mut, ann, value, span: this.spanFrom(start) };
  }

  /* ---------- expressions ---------- */

  parseExpr(minPrec = 0): Expr {
    let left = this.parseUnary();

    for (;;) {
      const t = this.tok;
      let op: string | null = null;
      if (t.kind === "sym" || t.kind === "kw") op = t.value;
      if (op === null) break;
      const prec = PREC[op];
      if (prec === undefined || prec < minPrec) break;
      this.next();
      const right = this.parseExpr(prec + 1);
      left = { k: "Binary", op, l: left, r: right, span: { start: left.span.start, end: right.span.end, line: left.span.line, col: left.span.col, file: this.file } };
    }
    return left;
  }

  parseUnary(): Expr {
    const start = this.tok;
    if (this.atSym("-") || this.atSym("!") || this.atKw("not")) {
      this.next();
      const e = this.parseUnary();
      return { k: "Unary", op: start.value, e, span: this.spanFrom(start) };
    }
    return this.parsePostfix();
  }

  parsePostfix(): Expr {
    let e = this.parsePrimary();
    for (;;) {
      if (this.atSym("(")) {
        const start = e.span;
        this.next();
        const args: Expr[] = [];
        if (!this.atSym(")")) {
          do { args.push(this.parseExpr()); } while (this.eatSym(","));
        }
        this.expectSym(")");
        e = { k: "App", fn: e, args, span: { start: start.start, end: this.toks[this.pos - 1]!.end, line: start.line, col: start.col, file: this.file } };
        continue;
      }
      if (this.atSym(".")) {
        this.next();
        const name = this.tok.kind === "num" ? this.next().value : this.expect("id").value;
        e = { k: "Field", target: e, name, span: { start: e.span.start, end: this.toks[this.pos - 1]!.end, line: e.span.line, col: e.span.col, file: this.file } };
        continue;
      }
      break;
    }
    return e;
  }

  parsePrimary(): Expr {
    const t = this.tok;

    if (t.kind === "num") { this.next(); return { k: "Lit", lit: { k: "Int", v: Number(t.value) }, span: this.spanFrom(t) }; }
    if (t.kind === "float") { this.next(); return { k: "Lit", lit: { k: "Float", v: Number(t.value) }, span: this.spanFrom(t) }; }
    if (t.kind === "str") { this.next(); return { k: "Lit", lit: { k: "Str", v: t.value }, span: this.spanFrom(t) }; }

    if (this.atKw("true")) { this.next(); return { k: "Lit", lit: { k: "Bool", v: true }, span: this.spanFrom(t) }; }
    if (this.atKw("false")) { this.next(); return { k: "Lit", lit: { k: "Bool", v: false }, span: this.spanFrom(t) }; }

    if (this.atKw("fn")) return this.parseLambda();
    if (this.atKw("if")) return this.parseIf();
    if (this.atKw("match")) return this.parseMatch();
    if (this.atKw("handle")) return this.parseHandle();
    if (this.atKw("html")) return this.parseHtml();

    // `{ a: 1 }` is a record literal; `{ expr }` is a block.
    if (this.atSym("{") && this.peek().kind === "id" && this.peek(2).kind === "sym" && this.peek(2).value === ":") {
      return this.parseRecordLiteral();
    }
    if (this.atSym("{")) return this.parseBlock();

    // An html element is an expression, so `if (c) { <p>a</p> } else { <p>b</p> }`
    // works in any expression position.
    if (this.atSym("<")) {
      const el = this.parseHtmlElement();
      return { k: "Html", nodes: [el], span: el.span };
    }

    if (this.atSym("(")) {
      this.next();
      if (this.atSym(")")) { this.next(); return { k: "Lit", lit: { k: "Unit" }, span: this.spanFrom(t) }; }
      const first = this.parseExpr();
      if (this.atSym(",")) {
        const items = [first];
        while (this.eatSym(",")) {
          if (this.atSym(")")) break;
          items.push(this.parseExpr());
        }
        this.expectSym(")");
        return { k: "Tuple", items, span: this.spanFrom(t) };
      }
      this.expectSym(")");
      return first;
    }

    if (this.atSym("[")) {
      this.next();
      const items: Expr[] = [];
      if (!this.atSym("]")) { do { items.push(this.parseExpr()); } while (this.eatSym(",")); if (this.atSym(",")) this.next(); }
      this.expectSym("]");
      return { k: "List", items, span: this.spanFrom(t) };
    }

    if (t.kind === "Con") {
      this.next();
      const args: Expr[] = [];
      if (this.atSym("(")) {
        this.next();
        if (!this.atSym(")")) { do { args.push(this.parseExpr()); } while (this.eatSym(",")); }
        this.expectSym(")");
      }
      return { k: "Ctor", name: t.value, args, span: this.spanFrom(t) };
    }

    if (t.kind === "id") {
      this.next();
      return { k: "Var", name: t.value, span: this.spanFrom(t) };
    }

    this.err(`expected an expression, found ${JSON.stringify(t.value)}`);
  }

  parseRecordLiteral(): Expr {
    const start = this.expectSym("{");
    const fields: { name: string; value: Expr }[] = [];
    while (!this.atSym("}")) {
      const name = this.expect("id").value;
      this.expectSym(":");
      const value = this.parseExpr();
      fields.push({ name, value });
      if (!this.eatSym(",")) break;
    }
    this.expectSym("}");
    return { k: "Record", fields, span: this.spanFrom(start) };
  }

  parseLambda(): Expr {
    const start = this.expectKw("fn");
    this.expectSym("(");
    const params: Param[] = [];
    if (!this.atSym(")")) {
      do {
        const pt = this.tok;
        const name = this.expect("id").value;
        this.expectSym(":");
        const type = this.parseType();
        params.push({ name, type, span: this.spanFrom(pt) });
      } while (this.eatSym(","));
    }
    this.expectSym(")");
    let ret: TypeExpr | undefined;
    if (this.eatSym("->")) ret = this.parseType();
    let eff: EffRow | undefined;
    if (this.atSym("!")) { this.next(); eff = this.parseEffRow(); }
    const body = this.parseBlock();
    return { k: "Lam", params, ret, eff, body, span: this.spanFrom(start) };
  }

  parseIf(): Expr {
    const start = this.expectKw("if");
    this.expectSym("(");
    const cond = this.parseExpr();
    this.expectSym(")");
    const then = this.parseBlock();
    let els: Expr;
    if (this.eatKw("else")) {
      els = this.atKw("if") ? this.parseIf() : this.parseBlock();
    } else {
      els = { k: "Lit", lit: { k: "Unit" }, span: start };
    }
    return { k: "If", cond, then, else: els, span: this.spanFrom(start) };
  }

  parseMatch(): Expr {
    const start = this.expectKw("match");
    const scrut = this.parseExpr();
    this.expectSym("{");
    const arms: MatchArm[] = [];
    while (!this.atSym("}")) {
      const at = this.tok;
      const pat = this.parsePattern();
      let guard: Expr | undefined;
      if (this.eatKw("if")) guard = this.parseExpr();
      this.expectSym("=>");
      const body = this.parseExpr();
      arms.push({ pat, guard, body, span: this.spanFrom(at) });
      this.eatSym(",");
      this.eatSym(";");
    }
    this.expectSym("}");
    return { k: "Match", scrut, arms, span: this.spanFrom(start) };
  }

  parsePattern(): Pattern {
    const t = this.tok;
    if (this.atSym("_")) { this.next(); return { k: "PWild", span: this.spanFrom(t) }; }
    if (t.kind === "num") { this.next(); return { k: "PLit", lit: { k: "Int", v: Number(t.value) }, span: this.spanFrom(t) }; }
    if (t.kind === "str") { this.next(); return { k: "PLit", lit: { k: "Str", v: t.value }, span: this.spanFrom(t) }; }
    if (this.atKw("true")) { this.next(); return { k: "PLit", lit: { k: "Bool", v: true }, span: this.spanFrom(t) }; }
    if (this.atKw("false")) { this.next(); return { k: "PLit", lit: { k: "Bool", v: false }, span: this.spanFrom(t) }; }
    if (this.atSym("(")) {
      this.next();
      const items: Pattern[] = [];
      do { items.push(this.parsePattern()); } while (this.eatSym(","));
      this.expectSym(")");
      return items.length === 1 ? items[0]! : { k: "PTuple", items, span: this.spanFrom(t) };
    }
    if (this.atSym("{")) {
      this.next();
      const fields: { name: string; pat: Pattern }[] = [];
      while (!this.atSym("}")) {
        const name = this.expect("id").value;
        this.expectSym(":");
        fields.push({ name, pat: this.parsePattern() });
        if (!this.eatSym(",")) break;
      }
      this.expectSym("}");
      return { k: "PRecord", fields, span: this.spanFrom(t) };
    }
    if (this.atSym("[")) {
      this.next();
      const items: Pattern[] = [];
      let rest: string | undefined;
      while (!this.atSym("]")) {
        if (this.atSym("..")) { this.next(); rest = this.expect("id").value; }
        else items.push(this.parsePattern());
        if (!this.eatSym(",")) break;
      }
      this.expectSym("]");
      return { k: "PList", items, rest, span: this.spanFrom(t) };
    }
    if (t.kind === "Con") {
      this.next();
      const args: Pattern[] = [];
      if (this.atSym("(")) {
        this.next();
        if (!this.atSym(")")) { do { args.push(this.parsePattern()); } while (this.eatSym(",")); }
        this.expectSym(")");
      }
      return { k: "PCtor", name: t.value, args, span: this.spanFrom(t) };
    }
    if (t.kind === "id") { this.next(); return { k: "PVar", name: t.value, span: this.spanFrom(t) }; }
    this.err(`expected a pattern, found ${JSON.stringify(t.value)}`);
  }

  /* ---------- html ---------- */

  parseHtml(): Expr {
    const start = this.expectKw("html");
    this.expectSym("{");
    const nodes = this.parseHtmlChildren(null);
    this.expectSym("}");
    return { k: "Html", nodes, span: this.spanFrom(start) };
  }

  parseHtmlChildren(closeTag: string | null): HtmlNode[] {
    const nodes: HtmlNode[] = [];
    for (;;) {
      if (this.at("eof")) this.err("unterminated html fragment");
      if (this.atSym("}")) {
        if (closeTag) this.err(`expected </${closeTag}>`);
        return nodes;
      }
      if (this.atSym("<")) {
        if (closeTag && this.peek().kind === "sym" && this.peek().value === "/") {
          this.next(); this.next(); // </
          const nameTok = this.tok;
          if (nameTok.kind !== "id" && nameTok.kind !== "Con") this.err("expected a closing tag name");
          this.next();
          const name = nameTok.value;
          if (name !== closeTag) this.err(`mismatched closing tag </${name}>, expected </${closeTag}>`);
          const gt = this.expectSym(">");
          void gt;
          return nodes;
        }
        nodes.push(this.parseHtmlElement());
        continue;
      }
      if (this.atSym("{")) {
        const hs = this.next();
        const e = this.parseExpr();
        this.expectSym("}");
        nodes.push({ k: "Hole", e, span: this.spanFrom(hs) });
        continue;
      }
      // raw text run: consume tokens until '<' , '{' or '}'
      const textStart = this.tok.start;
      let textEnd = textStart;
      while (!this.at("eof") && !this.atSym("<") && !this.atSym("{") && !this.atSym("}")) {
        textEnd = this.tok.end;
        this.next();
      }
      const raw = this.src.slice(textStart, textEnd);
      if (raw.trim().length > 0) {
        nodes.push({ k: "Text", v: collapseWs(raw), span: { start: textStart, end: textEnd, line: this.tok.line, col: this.tok.col, file: this.file } });
      }
    }
  }

  parseHtmlElement(): HtmlNode {
    const start = this.expectSym("<");
    const nameTok = this.tok;
    if (nameTok.kind !== "id" && nameTok.kind !== "Con") this.err("expected a tag name after '<'");
    this.next();
    const isComponent = nameTok.kind === "Con";
    const name = nameTok.value;

    const attrs: HtmlAttr[] = [];
    for (;;) {
      if (this.atSym("/") || this.atSym(">")) break;
      const at = this.tok;
      if (at.kind !== "id" && at.kind !== "Con") this.err(`expected an attribute name or '>', found ${JSON.stringify(at.value)}`);
      this.next();
      let value: HtmlAttr["value"] = { k: "static", v: "" };
      if (this.eatSym("=")) {
        if (this.tok.kind === "str") {
          value = { k: "static", v: this.next().value };
        } else if (this.atSym("{")) {
          this.next();
          const e = this.parseExpr();
          this.expectSym("}");
          value = { k: "expr", e };
        } else {
          this.err("attribute value must be a string literal or { expression }");
        }
      }
      attrs.push({ name: at.value, value, span: this.spanFrom(at) });
    }

    if (this.eatSym("/")) {
      this.expectSym(">");
      return isComponent
        ? { k: "Component", name, attrs, children: [], span: this.spanFrom(start) }
        : { k: "Element", tag: name, attrs, children: [], span: this.spanFrom(start) };
    }
    this.expectSym(">");
    // parseHtmlChildren consumes the closing `</name>` (including its '>') and returns.
    const children = this.parseHtmlChildren(name);
    return isComponent
      ? { k: "Component", name, attrs, children, span: this.spanFrom(start) }
      : { k: "Element", tag: name, attrs, children, span: this.spanFrom(start) };
  }
}

function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").replace(/^ | $/g, "");
}

export function parse(src: string, file = "<input>"): Program {
  return new Parser(src, file).parseProgram();
}

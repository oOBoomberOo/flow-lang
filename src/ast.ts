/**
 * Flow — abstract syntax tree.
 * Grammar reference: docs/grammar.ebnf § 3–§ 6
 */

export interface Span { start: number; end: number; line: number; col: number; file?: string }

/* ---------- types (syntax) ---------- */

export type TypeExpr =
  | { k: "TVar"; name: string; span: Span }
  | { k: "TCon"; name: string; args: TypeExpr[]; span: Span }
  | { k: "TFun"; params: TypeExpr[]; ret: TypeExpr; eff: EffRow; span: Span }
  | { k: "TRecord"; fields: { name: string; type: TypeExpr }[]; span: Span }
  | { k: "TTuple"; items: TypeExpr[]; span: Span }
  | { k: "TPlaced"; inner: TypeExpr; place: Place; span: Span };

export type Place = "client" | "server";

export interface EffRow { effects: string[]; var?: string }

/* ---------- expressions ---------- */

export type Pattern =
  | { k: "PWild"; span: Span }
  | { k: "PVar"; name: string; span: Span }
  | { k: "PLit"; lit: Literal; span: Span }
  | { k: "PCtor"; name: string; args: Pattern[]; span: Span }
  | { k: "PTuple"; items: Pattern[]; span: Span }
  | { k: "PList"; items: Pattern[]; rest?: string; span: Span }
  | { k: "PRecord"; fields: { name: string; pat: Pattern }[]; span: Span };

export type Literal =
  | { k: "Int"; v: number }
  | { k: "Float"; v: number }
  | { k: "Str"; v: string }
  | { k: "Bool"; v: boolean }
  | { k: "Unit" };

export interface HtmlAttr {
  name: string;
  value: { k: "static"; v: string } | { k: "expr"; e: Expr };
  span: Span;
}

export type HtmlNode =
  | { k: "Element"; tag: string; attrs: HtmlAttr[]; children: HtmlNode[]; span: Span }
  | { k: "Component"; name: string; attrs: HtmlAttr[]; children: HtmlNode[]; span: Span }
  | { k: "Hole"; e: Expr; span: Span }
  | { k: "Text"; v: string; span: Span };

export type Expr =
  | { k: "Lit"; lit: Literal; span: Span }
  | { k: "Var"; name: string; span: Span }
  | { k: "Lam"; params: Param[]; ret?: TypeExpr; eff?: EffRow; body: Expr; span: Span }
  | { k: "App"; fn: Expr; args: Expr[]; span: Span }
  | { k: "If"; cond: Expr; then: Expr; else: Expr; span: Span }
  | { k: "Match"; scrut: Expr; arms: MatchArm[]; span: Span }
  | { k: "Let"; name: string; mut: boolean; ann?: TypeExpr; value: Expr; body: Expr; span: Span }
  | { k: "Record"; fields: { name: string; value: Expr }[]; span: Span }
  | { k: "Field"; target: Expr; name: string; span: Span }
  | { k: "Tuple"; items: Expr[]; span: Span }
  | { k: "List"; items: Expr[]; span: Span }
  | { k: "Ctor"; name: string; args: Expr[]; span: Span }
  | { k: "Binary"; op: string; l: Expr; r: Expr; span: Span }
  | { k: "Unary"; op: string; e: Expr; span: Span }
  | { k: "Html"; nodes: HtmlNode[]; span: Span }
  | { k: "Block"; stmts: Stmt[]; value?: Expr; span: Span };

export type Stmt =
  | { k: "LetStmt"; name: string; mut: boolean; ann?: TypeExpr; value: Expr; span: Span }
  | { k: "ExprStmt"; e: Expr; span: Span };

export interface MatchArm { pat: Pattern; guard?: Expr; body: Expr; span: Span }

export interface Param { name: string; type: TypeExpr; span: Span }

/* ---------- declarations ---------- */

export interface FnSig {
  name: string;
  typeParams: string[];
  params: Param[];
  ret?: TypeExpr;
  eff?: EffRow;
  span: Span;
}

export type Decl =
  | { k: "Use"; path: string[]; items: { name: string; alias?: string }[]; glob: boolean; span: Span }
  | { k: "Adt"; name: string; params: string[]; variants: { name: string; args: TypeExpr[]; span: Span }[]; pub: boolean; span: Span }
  | { k: "RecordType"; name: string; params: string[]; fields: { name: string; type: TypeExpr }[]; pub: boolean; span: Span }
  | { k: "Alias"; name: string; params: string[]; type: TypeExpr; pub: boolean; span: Span }
  | { k: "Trait"; name: string; params: string[]; methods: FnSig[]; pub: boolean; span: Span }
  | { k: "Impl"; trait: string; traitArgs: TypeExpr[]; target: TypeExpr; methods: FnSig & { body: Expr }; span: Span }
  | { k: "Effect"; name: string; ops: FnSig[]; pub: boolean; span: Span }
  | { k: "Provide"; effect: string; target?: TypeExpr; ops: { name: string; fn: Expr; span: Span }[]; span: Span }
  | { k: "Extern"; sig: FnSig; implName: string; span: Span }
  | { k: "Fn"; name: string; typeParams: string[]; params: Param[]; ret?: TypeExpr; eff?: EffRow; body: Expr; pub: boolean; span: Span };

export interface Program { decls: Decl[]; file: string }

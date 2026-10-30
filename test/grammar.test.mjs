import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser.ts";
import { lex, FlowError } from "../src/lexer.ts";

/* ------------------------------------------------------------------ */
/* lexical                                                            */
/* ------------------------------------------------------------------ */

test("lexer: identifiers, constructors, numbers, strings", () => {
  const t = lex(`foo Bar 12 3.5 "a\\"b"`).map((x) => [x.kind, x.value]);
  assert.deepEqual(t.slice(0, 5), [
    ["id", "foo"], ["Con", "Bar"], ["num", "12"], ["float", "3.5"], ["str", 'a"b'],
  ]);
});

test("lexer: keywords are distinct from identifiers", () => {
  const t = lex("if fn html type let");
  assert.deepEqual(t.slice(0, 5).map((x) => x.kind), ["kw", "kw", "kw", "kw", "kw"]);
});

test("lexer: line and block comments are skipped", () => {
  const t = lex("a // x\n b /* y */ c");
  assert.deepEqual(t.filter((x) => x.kind === "id").map((x) => x.value), ["a", "b", "c"]);
});

test("lexer: unterminated string is an error", () => {
  assert.throws(() => lex('"abc'), /unterminated string/);
});

test("lexer: unexpected character is an error", () => {
  assert.throws(() => lex("§"), /unexpected character/);
});

/* ------------------------------------------------------------------ */
/* types                                                              */
/* ------------------------------------------------------------------ */

const T = (src) => parse(`type X = ${src}\nfn main() -> Html { html { <p>{"x"}</p> } }`);

test("types: named, generic, tuple, record, arrow", () => {
  T("Int");
  T("List<Option<Int>>");
  T("(Int, Str)");
  T("{ a: Int, b: Str }");
  T("(Int) -> Str");
  T("Int -> Str -> Bool");
});

test("types: effect rows on arrows", () => {
  T("(Int) -> Str ! {Server, Db}");
  T("(Int) -> Str ! Server");
  T("(Int) -> Str ! {}");
});

test("types: placement annotation parses", () => {
  T("Html@client");
  T("Int@server");
});

/* ------------------------------------------------------------------ */
/* declarations                                                       */
/* ------------------------------------------------------------------ */

const D = (src) => parse(`${src}\nfn main() -> Html { html { <p>{"x"}</p> } }`);

test("decl: single-variant ADT needs the leading bar", () => {
  const p = parse("type Color = | Red\nfn main() -> Html { html { <p>{\"x\"}</p> } }");
  assert.equal(p.decls[0].k, "Adt");
  const q = parse("type Color = Red\nfn main() -> Html { html { <p>{\"x\"}</p> } }");
  assert.equal(q.decls[0].k, "Alias");
});

test("decl: multi-variant ADT with and without payloads", () => {
  D("type Shape = | Circle(Float) | Rect(Float, Float) | Empty");
});

test("decl: record type", () => {
  D("type User = { name: Str, age: Int }");
});

test("decl: alias", () => {
  D("type Id = Int");
  D("type Pair<a> = (a, a)");
});

test("decl: trait with methods", () => {
  D(`trait Show<a> {
       fn show(x: a) -> Str
       fn debug(x: a) -> Str
     }`);
});

test("decl: impl with methods", () => {
  D(`trait Show<a> { fn show(x: a) -> Str }
     impl Show for Int { fn show(x: Int) -> Str { "i" } }`);
});

test("decl: generic impl", () => {
  D(`trait Show<a> { fn show(x: a) -> Str }
     impl Show<a> for List<a> { fn show(x: List<a>) -> Str { "l" } }`);
});

test("decl: effect declaration", () => {
  D(`effect Server {
       fn now() -> Int
       fn secret(name: Str) -> Str
     }`);
});

test("decl: polymorphic effect operation", () => {
  D(`effect Client { fn state<a>(init: a) -> Cell<a> }`);
});

test("decl: provide with implementation", () => {
  D(`effect Clock { fn tick() -> Int }
     provide Clock with { tick = fn() -> Int { 1 } }`);
});

test("decl: generic function", () => {
  D("fn id<a>(x: a) -> a { x }");
});

test("decl: pub is accepted", () => {
  D("pub fn f() -> Int { 1 }");
});

/* ------------------------------------------------------------------ */
/* expressions                                                        */
/* ------------------------------------------------------------------ */

const E = (src) => {
  const p = parse(`fn main() -> Html { html { <p>{${src}}</p> } }`);
  return p;
};

test("expr: precedence — * binds tighter than +", () => {
  const p = E("1 + 2 * 3");
  const body = p.decls[0].body.value.nodes[0].children[0].e;
  assert.equal(body.k, "Binary");
  assert.equal(body.op, "+");
  assert.equal(body.r.k, "Binary");
  assert.equal(body.r.op, "*");
});

test("expr: unary minus and not", () => {
  E("-1");
  E("not true");
});

test("expr: comparison chain is left associative", () => {
  E("1 < 2");
  E("(1 < 2) == true");
});

test("expr: application and field access", () => {
  E("f(1)(2)");
  E("r.a.b");
});

test("expr: lambdas with and without return annotation", () => {
  E("fn(x: Int) -> Int { x + 1 }");
  E("fn() { 1 }");
});

test("expr: if / else if / else", () => {
  E(`if (true) { 1 } else if (false) { 2 } else { 3 }`);
});

test("expr: match with guards and patterns", () => {
  E(`match x {
       None => 0,
       Some(n) if (n > 0) => n,
       Some(_) => 0,
       _ => 0,
     }`);
});

test("expr: list / tuple / record literals", () => {
  E("[1, 2, 3]");
  E("(1, true)");
  E("{ a: 1, b: 2 }");
});

test("expr: record literal vs block disambiguation", () => {
  const p = E("{ a: 1 }");
  const body = p.decls[0].body.value.nodes[0].children[0].e;
  assert.equal(body.k, "Record");

  const q = E("{ 1 }");
  const body2 = q.decls[0].body.value.nodes[0].children[0].e;
  assert.equal(body2.k, "Block");
});

test("expr: html element is an expression", () => {
  const p = E(`if (true) { <b>{"x"}</b> } else { <i>{"y"}</i> }`);
  const body = p.decls[0].body.value.nodes[0].children[0].e;
  assert.equal(body.k, "If");
  assert.equal(body.then.value.k, "Html");
});

/* ------------------------------------------------------------------ */
/* html                                                               */
/* ------------------------------------------------------------------ */

const H = (src) => parse(`fn main() -> Html { html { ${src} } }`).decls[0].body.value.nodes;

test("html: nested elements and attributes", () => {
  const [d] = H(`<div class="a" id={"b"}><p>{"x"}</p></div>`);
  assert.equal(d.k, "Element");
  assert.equal(d.tag, "div");
  assert.equal(d.attrs.length, 2);
  assert.equal(d.attrs[0].value.k, "static");
  assert.equal(d.attrs[1].value.k, "expr");
  assert.equal(d.children[0].tag, "p");
});

test("html: self closing and components with children", () => {
  const [c] = H(`<Card title={"t"}><p>{"b"}</p></Card>`);
  assert.equal(c.k, "Component");
  assert.equal(c.name, "Card");
  assert.equal(c.children.length, 1);
});

test("html: text runs and holes", () => {
  const nodes = H(`<p>Hello, {name}!</p>`);
  const kids = nodes[0].children;
  assert.equal(kids.map((k) => k.k).join(","), "Text,Hole,Text");
});

test("html: event attributes", () => {
  const [b] = H(`<button onClick={fn(e: Event) { x }}>{"go"}</button>`);
  assert.equal(b.attrs[0].name, "onClick");
});

test("html: mismatched closing tag is an error", () => {
  assert.throws(() => H(`<div></span>`), /mismatched closing tag/);
});

/* ------------------------------------------------------------------ */
/* rejected constructs                                                */
/* ------------------------------------------------------------------ */

test("decl: use imports items, with aliases", () => {
  const p = parse(`use std::list::{map, filter}
use std::option::map as omap
use std::html::Card
fn main() -> Html { html { <p>{"x"}</p> } }`);
  assert.equal(p.decls[0].k, "Use");
  assert.deepEqual(p.decls[0].path, ["std", "list"]);
  assert.deepEqual(p.decls[0].items.map((i) => i.name), ["map", "filter"]);
  assert.deepEqual(p.decls[1].items, [{ name: "map", alias: "omap" }]);
  assert.deepEqual(p.decls[2].path, ["std", "html"]);
  assert.deepEqual(p.decls[2].items, [{ name: "Card", alias: undefined }]);
});

test("decl: module paths may use keywords as segments", () => {
  const p = parse(`use std::html::Card\nfn main() -> Html { html { <p>{"x"}</p> } }`);
  assert.deepEqual(p.decls[0].path, ["std", "html"]);
});

test("extern is rejected with an explanation", () => {
  assert.throws(() => parse('extern fn f() -> Int = "f"'), /reserved/);
});

test("errors carry line and column", () => {
  try {
    parse("fn main() -> Html {\n  html { <div></span> }\n}", "x.flow");
    assert.fail("should throw");
  } catch (e) {
    assert.ok(e instanceof FlowError);
    assert.equal(e.line, 2);
    assert.ok(e.col >= 1);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser.ts";
import { lex } from "../src/lexer.ts";

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
  const t = lex("if then else where data class");
  assert.deepEqual(t.slice(0, 6).map((x) => x.kind), ["kw", "kw", "kw", "kw", "kw", "kw"]);
});

test("lexer: `if` is a keyword but `iffy` is not", () => {
  assert.equal(lex("if iffy")[0].kind, "kw");
  assert.equal(lex("if iffy")[1].kind, "id");
});

test("lexer: line and block comments are skipped", () => {
  const t = lex("a -- x\n b {- y -} c");
  assert.deepEqual(t.filter((x) => x.kind === "id").map((x) => x.value), ["a", "b", "c"]);
});

test("lexer: block comments nest", () => {
  const t = lex("a {- outer {- inner -} still -} b");
  assert.deepEqual(t.filter((x) => x.kind === "id").map((x) => x.value), ["a", "b"]);
});

test("lexer: operator runs split around markup", () => {
  const t = lex("</div><br/>x");
  assert.deepEqual(t.slice(0, 5).map((x) => x.value), ["</", "div", ">", "<", "br"]);
});

test("lexer: layout flags mark line starts", () => {
  const t = lex("a\n  b");
  assert.equal(t[0].bol, true);
  assert.equal(t[1].bol, true);
  assert.equal(t[1].col, 3);
});

test("lexer: unterminated string is an error", () => {
  assert.throws(() => lex('"abc'), /unterminated string/);
});

/* ------------------------------------------------------------------ */
/* declarations                                                       */
/* ------------------------------------------------------------------ */

const D = (src) => parse(src, "t.flow");

test("declarations: a module header exports only the listed names", () => {
  const p = D(`module Demo (shown) where

shown :: Int
shown = 1

hidden :: Int
hidden = 2`);
  const shown = p.decls.find((d) => d.name === "shown");
  const hidden = p.decls.find((d) => d.name === "hidden");
  assert.equal(shown.pub, true);
  assert.equal(hidden.pub, false);
});

test("declarations: a program without a header exports everything", () => {
  const p = D(`f :: Int
f = 1`);
  assert.equal(p.decls[0].pub, true);
});

test("declarations: import forms", () => {
  const p = D(`import List
import List (map, filter)
import List as L
import Http (get as httpGet)
import Foo.Bar (thing)`);
  const [a, b, c, d, e] = p.decls;
  assert.deepEqual(a.path, ["List"]);
  assert.deepEqual(b.items.map((i) => i.name), ["map", "filter"]);
  assert.equal(c.alias, "L");
  assert.equal(d.items[0].alias, "httpGet");
  assert.deepEqual(e.path, ["Foo", "Bar"]);
});

test("declarations: data with several variants and fields", () => {
  const p = D(`data Shape a
  = Circle Float
  | Rect Float Float
  | Empty`);
  const d = p.decls[0];
  assert.deepEqual(d.params, ["a"]);
  assert.deepEqual(d.variants.map((v) => v.name), ["Circle", "Rect", "Empty"]);
  assert.equal(d.variants[1].args.length, 2);
});

test("declarations: records and aliases", () => {
  const p = D(`type Point = { x :: Int, y :: Int }
type Name = Str`);
  assert.equal(p.decls[0].k, "RecordType");
  assert.deepEqual(p.decls[0].fields.map((f) => f.name), ["x", "y"]);
  assert.equal(p.decls[1].k, "Alias");
});

test("declarations: class and instance", () => {
  const p = D(`class Show a where
  show :: a -> Str

instance Show Int where
  show x = str x`);
  const cls = p.decls[0];
  assert.equal(cls.k, "Trait");
  assert.deepEqual(cls.params, ["a"]);
  assert.equal(cls.methods[0].name, "show");
  const inst = p.decls[1];
  assert.equal(inst.k, "Impl");
  assert.equal(inst.trait, "Show");
  assert.equal(inst.methods[0].name, "show");
});

test("declarations: class context is a bound", () => {
  const p = D(`class Eq a => Ord a where
  compare :: a -> a -> Int`);
  assert.deepEqual(p.decls[0].paramBounds, { a: ["Eq"] });
});

test("declarations: effect, provide and foreign", () => {
  const p = D(`
provide Server where
  secret k = k

foreign import js unsafe "Math.floor" floor :: Float -> Int`);
  assert.equal(p.decls[0].k, "Effect");
  assert.equal(p.decls[0].place, "server");
  assert.equal(p.decls[1].k, "Provide");
  assert.equal(p.decls[2].k, "Extern");
  assert.equal(p.decls[2].implName, "Math.floor");
});

test("declarations: a signature is attached to its clauses", () => {
  const p = D(`add :: Int -> Int -> Int
add a b = a + b`);
  const fn = p.decls[0];
  assert.equal(fn.k, "Fn");
  assert.deepEqual(fn.params.map((x) => x.name), ["a", "b"]);
  assert.equal(fn.ret.k, "TCon");
});

test("declarations: equation clauses become a case", () => {
  const p = D(`f :: Int -> Int
f 0 = 1
f n = n * n`);
  const fn = p.decls[0];
  assert.equal(fn.body.k, "Match");
  assert.equal(fn.body.arms.length, 2);
});

test("declarations: guards and otherwise", () => {
  const p = D(`classify :: Int -> Str
classify n
  | n < 0 = "neg"
  | otherwise = "pos"`);
  const body = p.decls[0].body;
  assert.equal(body.k, "If");
});

test("declarations: where binds helpers", () => {
  const p = D(`total :: List Int -> Int
total xs = go xs 0
  where
    go [] acc = acc
    go (x : rest) acc = go rest (acc + x)`);
  const body = p.decls[0].body;
  assert.equal(body.k, "Let");
  assert.equal(body.name, "go");
});

test("declarations: no signature means an inferred function", () => {
  const p = D(`double xs = List.map (\\x -> x + x) xs`);
  const fn = p.decls[0];
  assert.equal(fn.ret, undefined);
  assert.equal(fn.params.length, 1);
});

test("declarations: a nullary definition is a constant", () => {
  const p = D(`pi = 3.14`);
  assert.equal(p.decls[0].params.length, 0);
});

/* ------------------------------------------------------------------ */
/* types                                                              */
/* ------------------------------------------------------------------ */

const T = (src) => {
  const fn = D(`f :: ${src}\nf = undefined`).decls[0];
  if (!fn.params.length) return fn.ret;
  return { k: "TFun", params: fn.params.map((x) => x.type), ret: fn.ret, eff: fn.eff };
};

test("types: application, tuple, record, arrows", () => {
  assert.equal(T("Int").name, "Int");
  const list = T("List (Option Int)");
  assert.equal(list.name, "List");
  assert.equal(list.args[0].args[0].name, "Int");
  assert.equal(T("(Int, Str)").k, "TTuple");
  assert.equal(T("{ a :: Int }").k, "TRecord");
  const fn = T("Int -> Str -> Bool");
  assert.deepEqual(fn.params.length, 2, "arrows are curried");
  assert.equal(fn.ret.name, "Bool");
});

test("types: effect rows on arrows", () => {
  assert.deepEqual(T("Int -> Str ! {Server, Db}").eff.effects, ["Server", "Db"]);
  assert.deepEqual(T("Int -> Str ! Server").eff.effects, ["Server"]);
  assert.deepEqual(T("Int -> Str ! {}").eff.effects, []);
});

test("types: placement annotations", () => {
  assert.equal(T("Html @client").k, "TPlaced");
  assert.equal(T("Int @server").place, "server");
});

/* ------------------------------------------------------------------ */
/* expressions                                                        */
/* ------------------------------------------------------------------ */

const E = (src) => {
  const p = D(`f = ${src}`);
  return p.decls[0].body;
};

test("expressions: application by juxtaposition", () => {
  const e = E("add 1 2");
  assert.equal(e.k, "App");
  assert.equal(e.args.length, 2);
  const nested = E("add (mul 1 2) 3");
  assert.equal(nested.args[0].k, "App");
});

test("expressions: operator precedence and associativity", () => {
  const e = E("1 + 2 * 3");
  assert.equal(e.op, "+");
  assert.equal(e.r.op, "*");
  const cons = E("1 : 2 : xs");
  assert.equal(cons.fn.name, "cons", "cons desugars to the cons function");
  assert.equal(cons.args[1].args[1].name, "xs", "cons is right-associative");
});

test("expressions: $ and . are operators", () => {
  const app = E("print $ 1 + 2");
  assert.equal(app.k, "App");
  assert.equal(app.args[0].op, "+");
  const piped = E("inc . double");
  assert.equal(piped.k, "Lam", "composition desugars to a lambda");
});

test("expressions: sections and operator values", () => {
  assert.equal(E("(+ 1)").k, "Lam");
  assert.equal(E("(1 +)").k, "Lam");
  assert.equal(E("(+)").k, "Lam");
});

test("expressions: lambdas, including several parameters and \\case", () => {
  const one = E("\\x -> x + 1");
  assert.equal(one.k, "Lam");
  assert.equal(one.params.length, 1);
  assert.equal(E("\\x y -> x").params.length, 2);
  assert.equal(E("\\case\n  True -> 1\n  False -> 0").k, "Lam");
});

test("expressions: if / then / else", () => {
  const e = E("if a then 1 else 2");
  assert.equal(e.k, "If");
});

test("expressions: case / of", () => {
  const e = E("case x of\n  Just y -> y\n  Nothing -> 0");
  assert.equal(e.k, "Match");
  assert.equal(e.arms.length, 2);
});

test("expressions: let / in", () => {
  const e = E("let x = 1 in x + 2");
  assert.equal(e.k, "Let");
  assert.equal(e.body.k, "Binary");
});

test("expressions: do with bind, let and a result", () => {
  const e = E("do\n  x <- action\n  let y = x\n  pure y");
  assert.equal(e.k, "Binary");
  assert.equal(e.op, ">>=");
});

test("expressions: records use = and can elide the field name", () => {
  const e = E("{ a = 1, b }");
  assert.equal(e.k, "Record");
  assert.equal(e.fields[1].value.k, "Var");
});

test("expressions: lists, tuples and cons", () => {
  assert.equal(E("[1, 2, 3]").k, "List");
  assert.equal(E("(1, 2)").k, "Tuple");
  const cons = E("1 : xs");
  assert.equal(cons.k, "App");
  assert.equal(cons.fn.name, "cons");
});

test("expressions: markup is an expression", () => {
  const e = E("<div class=\"a\">\n  Hello {name}\n</div>");
  assert.equal(e.k, "Html");
  const el = e.nodes[0];
  assert.equal(el.k, "Element");
  assert.equal(el.attrs[0].name, "class");
  assert.equal(el.children[1].k, "Hole");
});

test("expressions: html holes suspend layout", () => {
  const e = E("<p>{if a then 1 else 2}</p>");
  assert.equal(e.nodes[0].children[0].e.k, "If");
});

test("expressions: markup fragment and component", () => {
  const e = E("<>\n  <Card title=\"t\" />\n  <p>x</p>\n</>");
  assert.equal(e.k, "Html");
  assert.equal(e.nodes[0].k, "Component");
  assert.equal(e.nodes[0].name, "Card");
});

/* ------------------------------------------------------------------ */
/* patterns                                                           */
/* ------------------------------------------------------------------ */

test("patterns: constructors, literals and wildcards", () => {
  const e = E("case v of\n  Just x -> x\n  0 -> 1\n  _ -> 2");
  assert.equal(e.arms[0].pat.k, "PCtor");
  assert.equal(e.arms[1].pat.k, "PLit");
  assert.equal(e.arms[2].pat.k, "PWild");
});

test("patterns: cons and list patterns", () => {
  const e = E("case xs of\n  [] -> 0\n  x : rest -> x");
  assert.equal(e.arms[0].pat.k, "PList");
  assert.equal(e.arms[1].pat.k, "PList");
  assert.equal(e.arms[1].pat.rest, "rest");
});

test("patterns: tuple and record", () => {
  const e = E("case v of\n  (a, b) -> a\n  { x = n } -> n");
  assert.equal(e.arms[0].pat.k, "PTuple");
  assert.equal(e.arms[1].pat.k, "PRecord");
});

/* ------------------------------------------------------------------ */
/* layout                                                             */
/* ------------------------------------------------------------------ */

test("layout: a dedented line closes the block", () => {
  const p = D(`f = do
  a
  b
g = 2`);
  assert.equal(p.decls.length, 2);
  assert.equal(p.decls[0].body.k, "Block");
});

test("layout: brackets suspend the offside rule", () => {
  const p = D(`f = [ 1
  , 2
  ]`);
  assert.equal(p.decls[0].body.items.length, 2);
});

/* ------------------------------------------------------------------ */
/* errors                                                             */
/* ------------------------------------------------------------------ */

test("errors: a missing `where` after a class is reported", () => {
  assert.throws(() => D("class Show a\n  show :: a -> Str"), /expected "where"|expected where/);
});

test("errors: an unterminated markup tag is reported", () => {
  assert.throws(() => D("f = <div><span></div>"), /mismatched closing tag/);
});

test("errors: recursion in recovery keeps later declarations", () => {
  const p = parse(`good :: Int
good = 1

bad = 1 +

other :: Int
other = 3`, "r.flow", { recover: true });
  assert.ok(p.errors && p.errors.length >= 1);
  assert.ok(p.decls.some((d) => d.name === "good"));
});

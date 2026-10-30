import { test } from "node:test";
import assert from "node:assert/strict";
import { compileSource } from "../src/compile.ts";

/**
 * Diagnostics must (a) exist when the program is wrong and (b) point at the
 * expression that is wrong, not at the enclosing function or block.
 */

function errorOf(src) {
  try {
    compileSource(src, "diag.flow");
  } catch (e) {
    return e;
  }
  assert.fail("expected a compile error");
}

// 1-based line/col of the first occurrence of `needle`.
function at(src, needle, offset = 0) {
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const c = lines[i].indexOf(needle);
    if (c >= 0) return { line: i + 1, col: c + 1 + offset };
  }
  throw new Error(`missing ${needle}`);
}

const page = (body) => `fn main() -> Html { html { ${body} } }`;

test("diagnostics: a value used as a type is rejected at the annotation", () => {
  const src = `fn f() -> str { "hello" }
${page(`<p>{f()}</p>`)}`;
  const e = errorOf(src);
  assert.match(e.message, /unknown type 'str'/);
  assert.match(e.message, /'str' is a value, not a type/);
  assert.match(e.message, /did you mean 'Str'\?/);
  assert.deepEqual({ line: e.line, col: e.col }, at(src, "str"));
});

test("diagnostics: a misspelled type name suggests the declaration", () => {
  const src = `type Colour = Red | Green
fn f() -> Colour { Red }
fn g() -> Colur { f() }
${page(`<p>{str(g())}</p>`)}`;
  const e = errorOf(src);
  assert.match(e.message, /unknown type 'Colur'/);
  assert.match(e.message, /did you mean 'Colour'\?/);
  assert.deepEqual({ line: e.line, col: e.col }, at(src, "Colur"));
});

test("diagnostics: a returned literal is checked against the declared return type", () => {
  const src = `fn f() -> Str { 42 }
${page(`<p>{f()}</p>`)}`;
  const e = errorOf(src);
  assert.match(e.message, /return type mismatch in fn f: expected Str, got Int/);
  assert.deepEqual({ line: e.line, col: e.col }, at(src, "42"));
});

test("diagnostics: a wrong return points at a multi-line tail expression", () => {
  const src = `fn f(flag: Bool) -> Str {
  let x = 1;
  if (flag) { 1 } else { 2 }
}
${page(`<p>{f(true)}</p>`)}`;
  const e = errorOf(src);
  assert.match(e.message, /return type mismatch in fn f: expected Str/);
  assert.deepEqual({ line: e.line, col: e.col }, at(src, "if (flag)"));
});

test("diagnostics: a let annotation reports the value and both types", () => {
  const src = `fn main() -> Html {
  let n: Str = 42;
  html { <p>{n}</p> }
}`;
  const e = errorOf(src);
  assert.match(e.message, /'n' is annotated Str, but its value is Int/);
  assert.deepEqual({ line: e.line, col: e.col }, at(src, "42"));
});

test("diagnostics: mismatched if branches point at the else branch", () => {
  const src = `fn f(flag: Bool) -> Str {
  if (flag) { "yes" } else { 42 }
}
${page(`<p>{f(true)}</p>`)}`;
  const e = errorOf(src);
  assert.match(e.message, /if branches have different types: then is Str, else is Int/);
  assert.deepEqual({ line: e.line, col: e.col }, at(src, "42 }"));
});

test("diagnostics: a mismatched match arm points at that arm", () => {
  const src = `type C = A | B
fn f(c: C) -> Str { match c { A => "a", B => 1 } }
${page(`<p>{f(A)}</p>`)}`;
  const e = errorOf(src);
  assert.match(e.message, /match arm returns Int, but the other arms return Str/);
  assert.deepEqual({ line: e.line, col: e.col }, at(src, "1 }"));
});

test("diagnostics: a call argument mismatch points at the argument", () => {
  const src = `fn f(n: Int) -> Int { n }
${page(`<p>{str(f("no"))}</p>`)}`;
  const e = errorOf(src);
  assert.match(e.message, /type mismatch/);
  assert.match(e.message, /in argument 1/);
  assert.deepEqual({ line: e.line, col: e.col }, at(src, '"no"'));
});

test("diagnostics: an unknown effect label is rejected at the label", () => {
  const src = `fn f() -> Int ! {Nope} { 1 }
${page(`<p>{str(f())}</p>`)}`;
  const e = errorOf(src);
  assert.match(e.message, /unknown effect 'Nope'/);
  assert.deepEqual({ line: e.line, col: e.col }, at(src, "Nope"));
});

test("diagnostics: an unknown trait bound is rejected", () => {
  const src = `fn f<a: Shwo>(x: a) -> a { x }
${page(`<p>{"x"}</p>`)}`;
  const e = errorOf(src);
  assert.match(e.message, /unknown trait 'Shwo' in the bounds of 'a'/);
  assert.equal(e.line, 1);
});

test("diagnostics: effect row variables are rejected", () => {
  const src = `fn f() -> Int ! {e} { 1 }
${page(`<p>{str(f())}</p>`)}`;
  const e = errorOf(src);
  assert.match(e.message, /effect row variables are not supported/);
  assert.deepEqual({ line: e.line, col: e.col }, at(src, "e}"));
});

test("diagnostics: a duplicate declaration is rejected", () => {
  const src = `fn f() -> Int { 1 }
fn f() -> Int { 2 }
${page(`<p>{str(f())}</p>`)}`;
  const e = errorOf(src);
  assert.match(e.message, /duplicate declaration 'f/);
  assert.equal(e.line, 2);
  assert.equal(e.col, 1);
});

test("diagnostics: duplicate record fields are rejected", () => {
  const typeDup = errorOf(`type R = { a: Int, a: Str }
${page(`<p>{"x"}</p>`)}`);
  assert.match(typeDup.message, /duplicate field 'a' in record type R/);
  assert.deepEqual({ line: typeDup.line, col: typeDup.col }, at(`type R = { a: Int, a: Str }`, "Str"));

  const litSrc = `fn main() -> Html { let r = { a: 1, a: 2 }; html { <p>{str(r.a)}</p> } }`;
  const litDup = errorOf(litSrc);
  assert.match(litDup.message, /duplicate field 'a' in record literal/);
  assert.deepEqual({ line: litDup.line, col: litDup.col }, at(litSrc, "2 }"));
});

test("diagnostics: builtin types check their type arguments", () => {
  const list = errorOf(`fn f(xs: List<Int, Str>) -> Int { len(xs) }
${page(`<p>{str(f([1]))}</p>`)}`);
  assert.match(list.message, /type 'List' expects 1 type argument, got 2/);
  assert.deepEqual({ line: list.line, col: list.col }, at(`fn f(xs: List<Int, Str>) -> Int { len(xs) }`, "List"));

  const event = errorOf(`fn f(x: Event<Int>) -> Int { 1 }
${page(`<p>{str(f())}</p>`)}`);
  assert.match(event.message, /type 'Event' takes no type arguments/);
});

test("diagnostics: unknown types in unused declarations are reported", () => {
  const alias = errorOf(`type A = Nope
${page(`<p>{"x"}</p>`)}`);
  assert.match(alias.message, /unknown type 'Nope'/);
  assert.deepEqual({ line: alias.line, col: alias.col }, at(`type A = Nope`, "Nope"));

  const record = errorOf(`type R = { a: Nope }
${page(`<p>{"x"}</p>`)}`);
  assert.match(record.message, /unknown type 'Nope'/);
});

test("diagnostics: a provide target is a real type", () => {
  const src = `effect E @ server { fn go() -> Int }
provide E for Nope with { go = fn() -> Int { 1 } }
${page(`<p>{str(E.go())}</p>`)}`;
  const e = errorOf(src);
  assert.match(e.message, /unknown type 'Nope'/);
  assert.deepEqual({ line: e.line, col: e.col }, at(src, "Nope"));
});

test("diagnostics: impls must implement exactly the trait's methods", () => {
  const extra = `trait Show<a> { fn show(x: a) -> Str }
impl Show for Int {
  fn show(x: Int) -> Str { str(x) }
  fn bogus(x: Int) -> Int { x }
}
${page(`<p>{Show.show(1)}</p>`)}`;
  const e1 = errorOf(extra);
  assert.match(e1.message, /trait Show has no method 'bogus'/);
  assert.deepEqual({ line: e1.line, col: e1.col }, at(extra, "fn bogus"));

  const missing = `trait Show<a> { fn show(x: a) -> Str }
impl Show for Int { }
${page(`<p>{Show.show(1)}</p>`)}`;
  const e2 = errorOf(missing);
  assert.match(e2.message, /impl Show for Int is missing method\(s\) show/);
  assert.equal(e2.line, 2);

  const unknown = `impl Nope for Int { fn show(x: Int) -> Str { "x" } }
${page(`<p>{"x"}</p>`)}`;
  assert.match(errorOf(unknown).message, /impl for unknown trait 'Nope'/);
});

test("diagnostics: impl method signatures must match the trait", () => {
  const wrongReturn = `trait Show<a> { fn show(x: a) -> Str }
impl Show for Int { fn show(x: Int) -> Int { x } }
${page(`<p>{Show.show(1)}</p>`)}`;
  const e1 = errorOf(wrongReturn);
  assert.match(e1.message, /impl Show\.show does not match the trait signature/);
  assert.equal(e1.line, 2);
  assert.equal(e1.col, wrongReturn.split("\n")[1].indexOf("fn show") + 1);

  const wrongParam = `trait Show<a> { fn show(x: a) -> Str }
impl Show for Int { fn show(x: Str) -> Str { x } }
${page(`<p>{Show.show(1)}</p>`)}`;
  assert.match(errorOf(wrongParam).message, /impl Show\.show does not match the trait signature/);
});

test("diagnostics: duplicate impls and duplicate type parameters are rejected", () => {
  const dupImpl = `trait Show<a> { fn show(x: a) -> Str }
impl Show for Int { fn show(x: Int) -> Str { str(x) } }
impl Show for Int { fn show(x: Int) -> Str { str(x) } }
${page(`<p>{Show.show(1)}</p>`)}`;
  const e1 = errorOf(dupImpl);
  assert.match(e1.message, /duplicate impl of Show for Int/);
  assert.equal(e1.line, 3);

  const dupParam = `type R<a, a> = { v: a }
${page(`<p>{"x"}</p>`)}`;
  assert.match(errorOf(dupParam).message, /duplicate type parameter 'a'/);
});

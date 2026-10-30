import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { compileFile, compileSource } from "../src/compile.ts";

/**
 * Trait bounds and dictionary passing: bounded functions receive hidden
 * dictionaries, generic instances close over inner dictionaries, and an
 * unbounded trait call on a type variable is rejected.
 */

test("bounds: the example compiles and emits dictionary dispatch", () => {
  const r = compileFile(path.join(import.meta.dirname, "..", "examples", "bounds.flow"));
  assert.deepEqual(r.diagnostics, []);
  assert.ok(r.client.includes("$d_Show_a"), "bounded functions carry a dictionary parameter");
  assert.match(r.client, /showAll\([^;]*\$d_Show_a/, "recursive bounded calls pass the dictionary");
  assert.ok(
    r.client.includes('...a, { "show":'),
    "the generic List instance closes over the element dictionary",
  );
});

test("bounds: an unbounded trait call on a type variable is an error", () => {
  const src = `
trait Show<a> { fn show(x: a) -> Str }
impl Show for Int { fn show(x: Int) -> Str { "Int" } }
fn bad<a>(x: a) -> Str { Show.show(x) }
fn main() -> Html { html { <p>{bad(1)}</p> } }
`;
  assert.throws(() => compileSource(src, "bounds.flow"), /add a trait bound such as <a: Show>/);
});

test("bounds: multiple bounds are carried as multiple dictionaries", () => {
  const src = `
trait A<a> { fn a(x: a) -> Str }
trait B<a> { fn b(x: a) -> Str }
impl A for Int { fn a(x: Int) -> Str { "a" } }
impl B for Int { fn b(x: Int) -> Str { "b" } }
fn both<a: A + B>(x: a) -> Str { A.a(x) + B.b(x) }
fn main() -> Html { html { <p>{both(1)}</p> } }
`;
  const r = compileSource(src, "bounds.flow");
  assert.deepEqual(r.diagnostics, []);
  assert.ok(r.client.includes("$d_A_a"), "dictionary for A");
  assert.ok(r.client.includes("$d_B_a"), "dictionary for B");
  assert.match(r.client, /both\([^;]*\{ "a":/, "A dictionary is passed at the call site");
  assert.match(r.client, /both\([^;]*\{ "b":/, "B dictionary is passed at the call site");
});

test("bounds: a nullary trait method can use a unique instance", () => {
  const src = `
trait Zero<a> { fn zero() -> a }
impl Zero for Int { fn zero() -> Int { 0 } }
fn main() -> Html { html { <p>{str(Zero.zero())}</p> } }
`;
  const r = compileSource(src, "bounds.flow");
  assert.deepEqual(r.diagnostics, []);
  assert.ok(r.client.includes("\$impl_Zero_"), "the unique instance is dispatched");
});

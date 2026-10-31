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
  const src = `class Show a where
  show :: a -> Str

instance Show Int where
  show x = "Int"

bad :: a -> Str
bad x = Show.show x

main :: Html
main = <p>{bad 1}</p>
`;
  assert.throws(() => compileSource(src, "bounds.flow"), /add a trait bound such as <a: Show>/);
});

test("bounds: multiple bounds are carried as multiple dictionaries", () => {
  const src = `class A a where
  a :: a -> Str

class B a where
  b :: a -> Str

instance A Int where
  a x = "a"

instance B Int where
  b x = "b"

both :: (A a, B a) => a -> Str
both x = A.a x + B.b x

main :: Html
main = <p>{both 1}</p>
`;
  const r = compileSource(src, "bounds.flow");
  assert.deepEqual(r.diagnostics, []);
  assert.ok(r.client.includes("$d_A_a"), "dictionary for A");
  assert.ok(r.client.includes("$d_B_a"), "dictionary for B");
  assert.match(r.client, /both\([^;]*\{ "a":/, "A dictionary is passed at the call site");
  assert.match(r.client, /both\([^;]*\{ "b":/, "B dictionary is passed at the call site");
});

test("bounds: a nullary trait method can use a unique instance", () => {
  const src = `class Zero a where
  zero :: () -> a

instance Zero Int where
  zero () = 0

main :: Html
main = <p>{str (Zero.zero ())}</p>
`;
  const r = compileSource(src, "bounds.flow");
  assert.deepEqual(r.diagnostics, []);
  assert.ok(r.client.includes("\$impl_Zero_"), "the unique instance is dispatched");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { compileFile, compileSource } from "../src/compile.ts";

/**
 * Higher-kinded type parameters: a trait may range over a type constructor
 * (`Functor<f>`), methods use `f<a>` / `f<b>`, and impls dispatch on the head
 * constructor (List, Option, …).
 */

test("hkt: Functor over List and Option compiles", () => {
  const r = compileFile(path.join(import.meta.dirname, "..", "examples", "hkt.flow"));
  assert.deepEqual(r.diagnostics, []);
  const impls = r.client.match(/\$impl_Functor_/g) ?? [];
  assert.ok(impls.length >= 2, "both List and Option instances are emitted");
  assert.match(r.client, /function main\(\)/, "main compiles");
});

test("hkt: f<a> parameters work in trait methods", () => {
  const src = `class Unwrap f where
  unwrapOr :: f a -> a -> a

instance Unwrap Option where
  unwrapOr value fallback = case value of
    None -> fallback
    Some x -> x

main :: Html
main = <p>{str (Unwrap.unwrapOr (Some 7) 0)}</p>
`;
  const r = compileSource(src, "hkt.flow");
  assert.deepEqual(r.diagnostics, []);
  assert.ok(r.client.includes("$impl_Unwrap_"), "the Option instance is dispatched");
  assert.ok(r.client.includes("Some"), "the Option value is compiled");
});

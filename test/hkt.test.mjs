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
  const src = `
trait Unwrap<f> {
  fn unwrapOr<a>(value: f<a>, fallback: a) -> a
}

impl Unwrap for Option {
  fn unwrapOr<a>(value: Option<a>, fallback: a) -> a {
    match value {
      None => fallback,
      Some(x) => x,
    }
  }
}

fn main() -> Html { html { <p>{str(Unwrap.unwrapOr(Some(7), 0))}</p> } }
`;
  const r = compileSource(src, "hkt.flow");
  assert.deepEqual(r.diagnostics, []);
  assert.ok(r.client.includes("$impl_Unwrap_"), "the Option instance is dispatched");
  assert.ok(r.client.includes("Some"), "the Option value is compiled");
});

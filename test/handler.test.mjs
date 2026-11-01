import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { compileFile, compileSource } from "../src/compile.ts";

/**
 * Local effect handlers: `handle Effect with { … } { body }` installs a
 * scoped provider, nests/restores, and removes the handled effect from the
 * body's effect row.
 */

test("handler: local providers compile and nest", () => {
  const r = compileFile(path.join(import.meta.dirname, "..", "examples", "handler.flow"));
  assert.deepEqual(r.diagnostics, []);
  assert.match(r.client, /R\.handle\("Local"/, "a scoped provider is emitted");
  const count = (r.client.match(/R\.handle\("Local"/g) ?? []).length;
  assert.ok(count >= 2, "nested handlers are both emitted");
});

test("handler: the handled effect is removed from the row", () => {
  const src = `effect Local @ client where
  ping :: () -> Str

f :: () -> Str
f () =
  handle Local with
    ping () = resume "ok"
  in Local.ping ()

main :: Html
main = <p>{f ()}</p>
`;
  const r = compileSource(src, "handler.flow");
  assert.deepEqual(r.diagnostics, []);
});

test("handler: a complete local handler can replace a global provider", () => {
  const src = `effect Global @ client where
  read :: () -> Str

provide Global where
  read () = "global"

main :: Html
main = do
  let x =
        handle Global with
          read () = resume "local"
        in Global.read ()
  <p>{x}</p>
`;
  const r = compileSource(src, "handler.flow");
  assert.deepEqual(r.diagnostics, []);
  assert.match(r.client, /R\.handle\("Global"/);
});

test("handler: missing operations are rejected", () => {
  const src = `effect Two @ client where
  a :: () -> Int
  b :: () -> Int

main :: Html
main = do
  let x =
        handle Two with
          a () = resume 1
        in Two.a ()
  <p>{str x}</p>
`;
  assert.throws(() => compileSource(src, "handler.flow"), /missing operation\(s\) b/);
});

test("handler: an operation signature mismatch is rejected", () => {
  const src = `effect Local @ client where
  ping :: () -> Str

main :: Html
main = do
  let x =
        handle Local with
          ping () = resume 1
        in Local.ping ()
  <p>{str x}</p>
`;
  assert.throws(() => compileSource(src, "handler.flow"), /type mismatch|does not match its signature/);
});

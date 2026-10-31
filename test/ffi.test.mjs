import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileFile } from "../src/compile.ts";
import { parse } from "../src/parser.ts";
import { withModule, moduleNameFor } from "./helpers.mjs";

/**
 * The FFI/std end-state:
 *
 *   * `unsafe extern js` is the only native escape hatch.
 *   * The standard library owns every callable primitive (lists, strings,
 *     conversions, equality, logging, timing, arithmetic, Option, CellOps).
 *   * Server / Client / Store are declared *and provided* in std.
 *   * The compiler registers no builtin functions and hardcodes no capability.
 */

function packageWith(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-ffi-"));
  fs.writeFileSync(path.join(root, "flow.json"), JSON.stringify({ name: "ffipkg", version: "0.1.0" }, null, 2));
  for (const [rel, src] of Object.entries(files)) {
    const file = path.join(root, "src", rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rel.endsWith(".flow") ? withModule(src, moduleNameFor(rel)) : src);
  }
  return { root, entry: path.join(root, "src", "main.flow") };
}


test("ffi: unsafe extern js reaches every JavaScript target form", () => {
  const { entry } = packageWith({
    "main.flow": `foreign import js unsafe "Math.hypot" {
  hypot :: Float -> Float -> Float
}

foreign import js unsafe "@toUpperCase" {
  shout :: Str -> Str
}

foreign import js unsafe "#length" {
  count :: List Int -> Int
}

foreign import js unsafe "#index" {
  item :: List Int -> Int -> Int
}

main :: Html
main = <p>{str (hypot 3.0 4.0)} {shout "ok"} {str (count [1, 2])} {str (item [10, 20] 1)}</p>`,
  });
  const r = compileFile(entry);
  for (const target of ["Math.hypot", "@toUpperCase", "#length", "#index"]) {
    assert.ok(r.client.includes(`R.ffiCall("${target}"`), `emits ${target}`);
  }
  assert.deepEqual(r.diagnostics, []);
});

test("ffi: unsafe is mandatory and only js is implemented", () => {
  assert.throws(() => parse('foreign import js "Math.abs" f :: () -> Int'), /marked `unsafe`/);
  assert.throws(() => parse('foreign import wasm unsafe "x" f :: () -> Int'), /unsupported FFI target/);
});

test("ffi: std wrappers are FFI calls, not compiler builtins", () => {
  const { entry } = packageWith({
    "main.flow": `import Math (sqrt)

main :: Html
main = <p>{str (len [1, 2])} {trim " x "} {str (eq 1 1)} {str (sqrt 4.0)}</p>`,
  });
  const r = compileFile(entry);
  assert.ok(r.client.includes('R.ffiCall("#length"'), "len uses the host");
  assert.ok(r.client.includes('R.ffiCall("@trim"'), "trim uses the host");
  assert.ok(r.client.includes('R.ffiCall("__flow.eq"'), "eq uses the host");
  assert.ok(r.client.includes('R.ffiCall("Math.sqrt"'), "sqrt uses the host");
  assert.ok(!r.client.includes("R.builtin("), "no compiler primitive emission");
});

test("ffi: Server / Client / Store are declared and provided in std", () => {
  const { entry } = packageWith({
    "main.flow": `
main :: Html
main = <p>{str (Server.now ())} {str (((Client.state 0).get) ())}</p>`,
  });
  const r = compileFile(entry);
  assert.ok(r.server.includes('R.ffiCall("__flow.host.log"'), "Server.log is std over the host");
  assert.ok(r.client.includes('R.ffiCall("__flow.host.cell"'), "Client.state is std over the host");
  // Both are ordinary std functions now, not provided effects.
  assert.ok(r.client.includes("makeCell"), "Client.state is a std function");
  assert.ok(!r.client.includes('R.provide("Client"'), "Client is a module, not a capability");
  // ...while the runtime only exposes raw host primitives.
  const runtime = fs.readFileSync(new URL("../src/runtime/core.js", import.meta.url), "utf8");
  assert.ok(!runtime.includes('R.provide("Client"'), "the runtime does not implement Client");
});

test("ffi: Option is a std ADT", () => {
  const { entry } = packageWith({
    "main.flow": `main :: Html
main = <p>{str (Some 1)} {str None}</p>`,
  });
  const r = compileFile(entry);
  assert.ok(r.client.includes('R.ctor("Some"'), "Some is a normal constructor");
  assert.ok(!r.client.includes("R.builtin("), "no compiler Option builtin");
});

test("ffi: Cell.get / Cell.set dispatch to the std CellOps trait", () => {
  const { entry } = packageWith({
    "main.flow": `
main :: Html
main = <p>{str (((Client.state 0).get) ())}</p>`,
  });
  const r = compileFile(entry);
  assert.ok(r.client.includes("$impl_CellOps_"), "the std trait impl is emitted");
  assert.ok(r.client.includes('R.ffiCall("__flow.get"'), "get uses the host primitive");
  assert.ok(!r.client.includes("R.get("), "no direct compiler R.get for Cell.get");
});

test("ffi: Int division uses the host divInt primitive", () => {
  const { entry } = packageWith({
    "main.flow": `main :: Html
main = <p>{str (7 / 2)}</p>`,
  });
  const r = compileFile(entry);
  assert.ok(r.client.includes('R.ffiCall("__flow.divInt"'), "division uses __flow.divInt");
  assert.ok(!r.client.includes("Math.trunc"), "no direct library call");
});

test("ffi: a dotted target can be a global constant", () => {
  const { entry } = packageWith({
    "main.flow": `import Math (pi, e)

main :: Html
main = <p>{str pi} {str e}</p>`,
  });
  const r = compileFile(entry);
  assert.ok(r.client.includes('R.ffiCall("Math.PI"'), "pi reads Math.PI");
  assert.ok(r.client.includes('R.ffiCall("Math.E"'), "e reads Math.E");
});

test("Flow.Random is built on the FFI-backed random source", () => {
  const { entry } = packageWith({
    "main.flow": `import Random (int, bool, pick, chance)

main :: Html
main = <p>{str (int 1 10)} {str (bool ())} {str (pick [1, 2, 3])} {str (chance 50)}</p>`,
  });
  const r = compileFile(entry);
  assert.ok(r.client.includes('R.ffiCall("Math.random"'), "random uses the host");
  assert.deepEqual(r.diagnostics, []);
});

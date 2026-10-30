import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileFile } from "../src/compile.ts";
import { parse } from "../src/parser.ts";

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
    fs.writeFileSync(file, src);
  }
  return { root, entry: path.join(root, "src", "main.flow") };
}

const page = (body) => `fn main() -> Html { html { ${body} } }`;

test("ffi: unsafe extern js reaches every JavaScript target form", () => {
  const { entry } = packageWith({
    "main.flow": `unsafe extern js fn hypot(a: Float, b: Float) -> Float = "Math.hypot"
unsafe extern js fn shout(s: Str) -> Str = "@toUpperCase"
unsafe extern js fn count(xs: List<Int>) -> Int = "#length"
unsafe extern js fn item(xs: List<Int>, i: Int) -> Int = "#index"

${page(`<p>{str(hypot(3.0, 4.0))}{shout("ok")}{str(count([1, 2]))}{str(item([10, 20], 1))}</p>`)}`,
  });
  const r = compileFile(entry);
  for (const target of ["Math.hypot", "@toUpperCase", "#length", "#index"]) {
    assert.ok(r.client.includes(`R.ffiCall("${target}"`), `emits ${target}`);
  }
  assert.deepEqual(r.diagnostics, []);
});

test("ffi: unsafe is mandatory and only js is implemented", () => {
  assert.throws(() => parse('extern js fn f() -> Int = "Math.abs"'), /marked `unsafe`/);
  assert.throws(() => parse('unsafe extern wasm fn f() -> Int = "x"'), /unsupported FFI target/);
});

test("ffi: std wrappers are FFI calls, not compiler builtins", () => {
  const { entry } = packageWith({
    "main.flow": `use std::math::sqrt

${page(`<p>{str(len([1, 2]))}{trim(" x ")}{str(eq(1, 1))}{str(sqrt(4.0))}</p>`)}`,
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
    "main.flow": `effect Server @ server { fn secret(k: Str) -> Str }
effect Client @ client { fn state<a>(init: a) -> Cell<a> }

${page(`<p>{Server.secret("k")}{str(Client.state(0).get())}</p>`)}`,
  });
  const r = compileFile(entry);
  assert.ok(r.server.includes('R.ffiCall("__flow.host.secret"'), "Server.secret is std over the host");
  assert.ok(r.client.includes('R.ffiCall("__flow.host.cell"'), "Client.state is std over the host");
  // The provider itself is compiled std code...
  assert.ok(r.client.includes('R.provide("Client"'), "std provides Client");
  assert.ok(r.client.includes("makeCell"), "Client.state is a std function");
  // ...while the runtime only exposes raw host primitives.
  const runtime = fs.readFileSync(new URL("../src/runtime/core.js", import.meta.url), "utf8");
  assert.ok(!runtime.includes('R.provide("Client"'), "the runtime does not implement Client");
});

test("ffi: Option is a std ADT", () => {
  const { entry } = packageWith({
    "main.flow": page(`<p>{str(Some(1))}{str(None)}</p>`),
  });
  const r = compileFile(entry);
  assert.ok(r.client.includes('R.ctor("Some"'), "Some is a normal constructor");
  assert.ok(!r.client.includes("R.builtin("), "no compiler Option builtin");
});

test("ffi: Cell.get / Cell.set dispatch to the std CellOps trait", () => {
  const { entry } = packageWith({
    "main.flow": `effect Client @ client { fn state<a>(init: a) -> Cell<a> }
${page(`<p>{str(Client.state(0).get())}</p>`)}`,
  });
  const r = compileFile(entry);
  assert.ok(r.client.includes("$impl_CellOps_"), "the std trait impl is emitted");
  assert.ok(r.client.includes('R.ffiCall("__flow.get"'), "get uses the host primitive");
  assert.ok(!r.client.includes("R.get("), "no direct compiler R.get for Cell.get");
});

test("ffi: Int division uses the host divInt primitive", () => {
  const { entry } = packageWith({
    "main.flow": page(`<p>{str(7 / 2)}</p>`),
  });
  const r = compileFile(entry);
  assert.ok(r.client.includes('R.ffiCall("__flow.divInt"'), "division uses __flow.divInt");
  assert.ok(!r.client.includes("Math.trunc"), "no direct library call");
});

test("ffi: a dotted target can be a global constant", () => {
  const { entry } = packageWith({
    "main.flow": `use std::math::{pi, e}

${page(`<p>{str(pi())}{str(e())}</p>`)}`,
  });
  const r = compileFile(entry);
  assert.ok(r.client.includes('R.ffiCall("Math.PI"'), "pi reads Math.PI");
  assert.ok(r.client.includes('R.ffiCall("Math.E"'), "e reads Math.E");
});

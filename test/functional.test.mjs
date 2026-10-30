import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileSource, compileFile } from "../src/compile.ts";
import { createHost } from "../src/host.ts";

const RUNTIME_FILES = ["core.js", "server.js", "dom.js", "client.js"];

function emit(result, outDir) {
  const rt = path.join(import.meta.dirname, "..", "src", "runtime");
  fs.mkdirSync(path.join(outDir, "runtime"), { recursive: true });
  fs.writeFileSync(path.join(outDir, "app.js"), result.client);
  fs.writeFileSync(path.join(outDir, "server.js"), result.server);
  for (const f of RUNTIME_FILES) fs.copyFileSync(path.join(rt, f), path.join(outDir, "runtime", f));
  fs.writeFileSync(
    path.join(outDir, "runtime", "server-runtime.js"),
    `import { createServerRuntime } from "./server.js";\n` +
    `const opts = JSON.parse(process.env.FLOW_OPTS || "{}");\n` +
    `export const R = createServerRuntime(opts);\n`,
  );
}

function compileInTemp(src) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-fp-"));
  const file = path.join(dir, "main.flow");
  fs.writeFileSync(file, src);
  try {
    return compileFile(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function withHost(source, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-fp-host-"));
  const file = path.join(dir, "main.flow");
  fs.writeFileSync(file, source);
  const result = compileFile(file);
  const outDir = path.join(dir, "build");
  emit(result, outDir);
  const host = await createHost({ outDir, port: 0, secrets: {} });
  try {
    return await fn(host, result);
  } finally {
    await host.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("functional: partial application, chained calls and pipes run", async () => {
  const source = `use std::fn::{compose}
use std::monad::{Monad}
use std::list::{map, filter, range}
use std::http::{get, Router, RequestObject, Response, textResponse}

fn add(a: Int, b: Int) -> Int { a + b }
fn mul(a: Int, b: Int) -> Int { a * b }

fn routes() -> Unit {
  Router.mount([
    get("/fp", fn(_req: RequestObject) -> Response {
      let inc = add(1);
      let local = fn(a: Int, b: Int) -> Int { a * b };
      let double = local(2);
      let xs = range(5);
      let odds = xs |> map(inc) |> filter(fn(x) => x % 2 == 1);
      let piped = 3 |> add(1) |> mul(2);
      let composed = compose(fn(x) => x + 1, fn(x) => x * 2);
      let dollar = add $ 1 + 2;
      let applied = add <| 5;
      let opt = Some(2).map(fn(x) => x + 1);
      textResponse(str(inc(9)) + "|" + str(double(4)) + "|" + str(odds) + "|" + str(piped) +
        "|" + str(composed(3)) + "|" + str(dollar(4)) + "|" + str(applied(1)) + "|" + str(opt))
    })
  ]);
}

fn main() -> Html { html { <p>{"fp"}</p> } }
`;
  await withHost(source, async (host) => {
    const res = await fetch(host.url + "/fp");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "10|8|[1, 3, 5]|8|7|7|6|Some(3)");
  });
});

test("functional: inferred lambda parameters work in every position", () => {
  const src = `use std::list::{map, filter, range}
fn main() -> Html {
  let xs = range(5);
  let a = xs |> map(fn(x) => x + 1);
  let b = xs |> filter(fn(x) => x % 2 == 0);
  let f = fn(x) => x * 3;
  let g = fn(a, b) => a + b;
  html { <p>{str(a)}{str(b)}{str(f(2))}{str(g(1, 2))}</p> }
}`;
  const r = compileInTemp(src);
  assert.deepEqual(r.errors, []);
  assert.match(r.client, /R\.v\(x\) \* R\.v\(3\)/, "the expression-bodied lambda is emitted");
});

test("functional: over-application and invalid partials are rejected", () => {
  assert.throws(
    () => compileSource(`fn add(a: Int, b: Int) -> Int { a + b }
fn main() -> Html { let x = add(1, 2, 3); html { <p>{str(x)}</p> } }`, "over.flow"),
    /expected 2 argument\(s\), got 3/,
  );
  assert.throws(
    () => compileInTemp(`use std::state::{State}
fn f(a: Int, b: Int) -> Int ! {State} { a + b }
fn main() -> Html { let g = f(1); html { <p>{str(g(2))}</p> } }`),
    /cannot partially apply 'f': it performs an algebraic effect/,
  );
  assert.throws(
    () => compileInTemp(`trait S<a> { fn s(x: a) -> Str }
impl S for Int { fn s(x: Int) -> Str { "i" } }
fn g<a: S>(x: a, y: Int) -> Str { S.s(x) }
fn main() -> Html { let f = g(1); html { <p>{f(2)}</p> } }`),
    /cannot partially apply 'g': it needs trait dictionaries/,
  );
  assert.throws(
    () => compileSource(`fn add(a: Int, b: Int) -> Int { a + b }
fn main() -> Html { let x = add(1)("no"); html { <p>{str(x)}</p> } }`, "wrong.flow"),
    /type mismatch: Str vs Int/,
  );
});

test("functional: partials keep types through let and pipe", () => {
  const r = compileSource(`fn add(a: Int, b: Int) -> Int { a + b }
fn main() -> Html {
  let inc = add(1);
  let twice = fn(f: (Int) -> Int, x: Int) -> Int { f(f(x)) };
  let n = twice(inc, 3);
  let piped = 3 |> add(1) |> add(1);
  html { <p>{str(n)}{str(piped)}</p> }
}`, "types.flow");
  assert.deepEqual(r.errors, []);
  assert.ok(r.client.includes("...$r"), "a partial closure is emitted");
});

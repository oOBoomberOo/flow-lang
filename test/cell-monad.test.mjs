import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileSource } from "../src/compile.ts";
import { compileFile } from "../src/compile.ts";
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

async function withHost(source, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-cm-"));
  const entry = path.join(root, "main.flow");
  fs.writeFileSync(entry, source);
  const result = compileFile(entry);
  const outDir = path.join(root, "build");
  emit(result, outDir);
  const host = await createHost({ outDir, port: 0, secrets: {} });
  try {
    return await fn(host, result);
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const page = (body) => `fn main() -> Html { html { ${body} } }`;

test("cells: value/assignment/update sugar lowers to host get/set", () => {
  const src = `main :: Html
main = do
  let c = Client.state 1
  c.value := c.value + 1
  c += 2
  c -= 1
  c *= 3
  c := c.value / 2
  c += 1
  c -= 1
  c.update (\\(x :: Int) -> x + 10)
  <p>{str c.value}</p>`;
  const r = compileSource(src, "cell.flow");
  assert.deepEqual(r.errors, []);
  assert.ok(r.client.includes('R.ffiCall("__flow.get"'), "read lowers to the host get");
  assert.ok(r.client.includes('R.ffiCall("__flow.set"'), "write lowers to the host set");
  assert.ok(r.client.includes('R.ffiCall("__flow.divInt"'), "Int /= uses integer division");
  assert.ok(r.client.includes("$impl_CellOps_"), "CellOps.update is emitted");
  const sets = (r.client.match(/__flow\.set/g) ?? []).length;
  assert.ok(sets >= 7, `every update writes (${sets})`);
});

test("cells: old get()/set() and string/float compound updates still work", () => {
  const src = `main :: Html
main = do
  let n = Client.state 1
  n.set (n.get () + 1)
  let s = Client.state "a"
  s += "b"
  let f = Client.state 0.5
  f += 0.25
  f *= 2.0
  <p>{str (n.get ())} {s.value} {str f.value}</p>`;
  const r = compileSource(src, "cell2.flow");
  assert.deepEqual(r.errors, []);
});

test("cells: wrong value types and non-cell targets are rejected", () => {
  assert.throws(
    () => compileSource(`main :: Html
main = do
  let c = Client.state 1
  c += "x"
  <p>{str c.value}</p>`, "c1.flow"),
    /cell \+= expects Int: expected Int, got Str/,
  );
  assert.throws(
    () => compileSource(`main :: Html
main = do
  let c = Client.state 1
  c.value := "x"
  <p>{"x"}</p>`, "c2.flow"),
    /cell value: expected Int, got Str/,
  );
  assert.throws(
    () => compileSource(`main :: Html
main = do
  let n = 1
  n += 1
  <p>{str n}</p>`, "c3.flow"),
    /assignment target must be a Cell/,
  );
  assert.throws(
    () => compileSource(`main :: Html
main = do
  let n = 1
  n.value := 2
  <p>{str n}</p>`, "c4.flow"),
    /assignment target must be a Cell/,
  );
  assert.throws(
    () => compileSource(`main :: Html
main = do
  let c = Client.state "a"
  c -= "b"
  <p>{c.value}</p>`, "c5.flow"),
    /cell -= needs an Int or Float cell/,
  );
});

test("monads: do blocks and >>= run for Option and List on the server", async () => {
  const source = `import Monad (Monad)
import Http (get, Router, RequestObject, Response, textResponse)

routes :: () -> ()
routes () =
  Router.mount [ get "/m" (\\(_req :: RequestObject) -> do
      let o = Some 2 >>= (\\x -> Some 3 >>= (\\y -> Some (x + y)))
      let l = [1, 2] >>= (\\x -> [10, 20] >>= (\\y -> [x + y]))
      let b = Some 1 >>= (\\(v :: Int) -> Some (v * 10))
      let n = Some 1 >>= (\\v -> let w = v + 1 in Some (w + 1))
      textResponse (str o + "|" + str l + "|" + str b + "|" + str n))
    ]

main :: Html
main = <p>{"monads"}</p>
`;
  await withHost(source, async (host) => {
    const res = await fetch(host.url + "/m");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "Some(5)|[11, 21, 12, 22]|Some(10)|Some(3)");
  });
});

function compileInTemp(src, name = "main.flow") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-cm-src-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, src);
  try {
    return compileFile(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("monads: >>= and do reject mismatched monads and missing imports", () => {
  assert.throws(
    () => compileInTemp(`import Monad (Monad)

main :: Html
main = do
  let x = Some 1 >>= (\\(v :: Int) -> [v])
  <p>{str x}</p>`),
    /Monad\.bind argument 1: expected Int -> Option a, got Int -> List Int/,
  );
  assert.throws(
    () => compileInTemp(`import Monad (Monad)

main :: Html
main = do
  let x = Some 1 >>= (\\a -> [2] >>= (\\b -> Some (a + b)))
  <p>{str x}</p>`),
    /Monad.bind argument 1/,
  );
  // The Monad family is part of the prelude, so `>>=` needs no import.
  const noImport = compileSource(`main :: Html
main = do
  let x = Some 1 >>= (\\(v :: Int) -> Some v)
  <p>{str x}</p>`, "m3.flow");
  assert.deepEqual(noImport.errors, []);
  assert.throws(
    () => compileInTemp(`import Monad (Monad)

main :: Html
main = do
  let x = Some "a" >>= (\\(v :: Str) -> [v])
  <p>{str x}</p>`),
    /Monad.bind argument 1/,
  );
});

test("cells: the combined example compiles and the client bundle is coherent", () => {
  const src = `main :: Html
main = do
  let c = Client.state 1
  c.value := c.value + 1
  c += 2
  c += 1
  <p>{str c.value}</p>`;
  const r = compileSource(src, "example.flow");
  assert.deepEqual(r.errors, []);
  const uses = (r.client.match(/__flow\.(get|set)/g) ?? []).length;
  assert.ok(uses >= 5, "reads and writes are emitted");
  assert.ok(r.client.includes('__flow.host.cell'), "the cell comes from the neutral host primitive");
});

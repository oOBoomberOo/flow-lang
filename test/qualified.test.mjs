import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileFile } from "../src/compile.ts";
import { createHost } from "../src/host.ts";
import { withModule, moduleNameFor } from "./helpers.mjs";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-q-"));
  const file = path.join(dir, "main.flow");
  fs.writeFileSync(file, withModule(source));
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

function packageWith(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-qpkg-"));
  fs.writeFileSync(path.join(root, "flow.json"), JSON.stringify({ name: "app", version: "0.1.0", dependencies: {} }));
  for (const [rel, src] of Object.entries(files)) {
    const f = path.join(root, "src", rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, withModule(src, moduleNameFor(rel)));
  }
  return { root, entry: path.join(root, "src", "main.flow") };
}

test("qualified: values, constructors, types and effects work without a use", async () => {
  const source = `import Monad (Monad)
import Http (get, Router, Response, textResponse)

counted :: () -> Int
counted () =
  handle State.State with
    get () = resume 41
    put x = resume ()
  in State.State.get () + 1

routes :: () -> ()
routes () =
  Router.mount [ get "/q" (\\(_req :: Http.RequestObject) -> do
      let n = List.length [1, 2]
      let s = Math.sqrt 9.0
      let o = Option.Some 2 >>= (\\(x :: Int) -> Option.Some (x + 1))
      textResponse (str n + "|" + str s + "|" + str o + "|" + str (counted ())))
    ]

main :: Html
main = <p>{"q"}</p>
`;
  await withHost(source, async (host) => {
    const res = await fetch(host.url + "/q");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "2|3|Some(3)|42");
  });
});

test("qualified: public cross-module paths work, private and missing names are rejected", () => {
  const { entry } = packageWith({
    "util.flow": `module Util (tally, Report) where

tally :: List Int -> Int
tally xs = len xs

hidden :: () -> Int
hidden () = 7

type Report = { total :: Int }
`,
    "main.flow": `main :: Html
main = do
  let n = Util.tally [1, 2, 3]
  let
    r :: Util.Report
    r = { total = n }
  <p>{str r.total}</p>
`,
  });
  const result = compileFile(entry);
  assert.equal(result.errors.length, 0);
  assert.ok(result.client.includes('"total"'), "the qualified record type resolved");

  const privateUse = packageWith({
    "util.flow": `module Util (visible) where

visible :: () -> Int
visible () = 1

hidden :: () -> Int
hidden () = 7
`,
    "main.flow": `main :: Html
main = do
  let n = Util.hidden ()
  <p>{str n}</p>
`,
  });
  assert.throws(
    () => compileFile(privateUse.entry),
    /'Util\.hidden' is private: hidden is not in the export list of module Util/,
  );

  const missing = packageWith({
    "main.flow": `main :: Html
main = do
  let n = List.nope ()
  <p>{str n}</p>
`,
  });
  assert.throws(
    () => compileFile(missing.entry),
    /module Flow.List has no member 'nope'/,
  );
});

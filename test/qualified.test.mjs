import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-q-"));
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

function packageWith(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-qpkg-"));
  fs.writeFileSync(path.join(root, "flow.json"), JSON.stringify({ name: "app", version: "0.1.0", dependencies: {} }));
  for (const [rel, src] of Object.entries(files)) {
    const f = path.join(root, "src", rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, src);
  }
  return { root, entry: path.join(root, "src", "main.flow") };
}

test("qualified: values, constructors, types and effects work without a use", async () => {
  const source = `use std::monad::{Monad}
use std::http::{get, Router, Response, textResponse}

fn counted() -> Int {
  handle std::state::State with {
    get = fn() -> Int { resume(41) },
    put = fn(x: Int) -> Int { resume(()) }
  } {
    std::state::State.get() + 1
  }
}

fn routes() -> Unit {
  Router.mount([
    get("/q", fn(_req: std::http::RequestObject) -> Response {
      let n = std::list::length([1, 2]);
      let s = std::math::sqrt(9.0);
      let o = std::option::Some(2) >>= fn(x: Int) -> std::option::Option<Int> { std::option::Some(x + 1) };
      textResponse(str(n) + "|" + str(s) + "|" + str(o) + "|" + str(counted()))
    })
  ]);
}

fn main() -> Html { html { <p>{"q"}</p> } }
`;
  await withHost(source, async (host) => {
    const res = await fetch(host.url + "/q");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "2|3|Some(3)|42");
  });
});

test("qualified: public cross-module paths work, private and missing names are rejected", () => {
  const { entry } = packageWith({
    "util.flow": `pub fn tally(xs: List<Int>) -> Int { len(xs) }
fn hidden() -> Int { 7 }
pub type Report = { total: Int }
`,
    "main.flow": `fn main() -> Html {
  let n = app::util::tally([1, 2, 3]);
  let r: app::util::Report = { total: n };
  html { <p>{str(r.total)}</p> }
}
`,
  });
  const result = compileFile(entry);
  assert.equal(result.errors.length, 0);
  assert.ok(result.client.includes('"total"'), "the qualified record type resolved");

  const privateUse = packageWith({
    "util.flow": `fn hidden() -> Int { 7 }
`,
    "main.flow": `fn main() -> Html { let n = app::util::hidden(); html { <p>{str(n)}</p> } }
`,
  });
  assert.throws(
    () => compileFile(privateUse.entry),
    /unbound name 'app::util::hidden'/,
  );

  const missing = packageWith({
    "main.flow": `fn main() -> Html { let n = std::list::nope(); html { <p>{str(n)}</p> } }
`,
  });
  assert.throws(
    () => compileFile(missing.entry),
    /unbound name 'std::list::nope'/,
  );
});

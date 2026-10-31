import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileFile } from "../src/compile.ts";
import { createHost } from "../src/host.ts";

/**
 * A package's own JavaScript/TypeScript, bound with
 * `foreign import js module "./shim.js" { … }`, on both sides.
 */

const RUNTIME_FILES = ["core.js", "server.js", "dom.js", "client.js"];

function emit(result, outDir) {
  const rt = path.join(import.meta.dirname, "..", "src", "runtime");
  fs.mkdirSync(path.join(outDir, "runtime"), { recursive: true });
  fs.writeFileSync(path.join(outDir, "app.js"), result.client);
  fs.writeFileSync(path.join(outDir, "server.js"), result.server);
  for (const f of RUNTIME_FILES) fs.copyFileSync(path.join(rt, f), path.join(outDir, "runtime", f));
  const modules = result.codegen?.shimModules?.() ?? [];
  if (modules.length) {
    fs.mkdirSync(path.join(outDir, "modules"), { recursive: true });
    for (const [file, name] of modules) fs.copyFileSync(file, path.join(outDir, "modules", name));
  }
  fs.writeFileSync(
    path.join(outDir, "runtime", "server-runtime.js"),
    `import { createServerRuntime } from "./server.js";\n` +
    `const opts = JSON.parse(process.env.FLOW_OPTS || "{}");\n` +
    `export const R = createServerRuntime(opts);\n`,
  );
}

function packageWith(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-shim-"));
  fs.writeFileSync(path.join(root, "flow.json"), JSON.stringify({ name: "shimapp", version: "0.1.0", dependencies: {} }));
  for (const [rel, src] of Object.entries(files)) {
    const f = path.join(root, "src", rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, src);
  }
  return path.join(root, "src", "main.flow");
}

async function withHost(entry, fn) {
  const result = compileFile(entry);
  const outDir = path.join(path.dirname(entry), "..", ".flow-build");
  emit(result, outDir);
  const host = await createHost({ outDir, port: 0, secrets: {} });
  try {
    return await fn(host, result);
  } finally {
    await host.close();
  }
}

test("ffi shim: a package binds its own JS module and runs it on the client", async () => {
  const entry = packageWith({
    "main.flow": `import Http (get, Router, textResponse)

foreign import js module "./text.js" {
  shout :: Str -> Str
  slug :: Str -> Str
}

routes :: () -> ()
routes () = Router.mount [ get "/t" (\\_req -> textResponse (slug (shout "Hello World"))) ]

main :: Html
main = <div>
    <p class="client">{shout "hi"}</p>
    <p class="server">{slug (shout "a B c")}</p>
  </div>
`,
    "text.js": `export const shout = (s) => String(s).toUpperCase();
export const slug = (s) => String(s).toLowerCase().replace(/\\s+/g, "-");
`,
  });
  const result = compileFile(entry);
  assert.ok(result.client.includes('import * as $shim1 from "./modules/1-text.js";'), "namespace import in the client");
  assert.ok(result.server.includes('import * as $shim1 from "./modules/1-text.js";'), "namespace import on the server");
  assert.ok(result.client.includes("$shim1.shout"), "the client calls the shim export");

  await withHost(entry, async (host) => {
    // the shim is served to the browser and evaluated on the server
    const mod = await fetch(host.url + "/modules/1-text.js");
    assert.equal(mod.status, 200);
    assert.match(await mod.text(), /export const shout/);

    const res = await fetch(host.url + "/t");
    assert.equal(await res.text(), "hello-world", "the server half runs through the same shim");
  });
});

test("ffi shim: a TypeScript shim works on the server and a client use is rejected", () => {
  const entry = packageWith({
    "main.flow": `foreign import js module "./calc.ts" {
  addAll :: List Int -> Int @server
}

main :: Html
main = <p>{str (addAll [1, 2, 3])}</p>
`,
    "calc.ts": `export const addAll = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
`,
  });
  const result = compileFile(entry);
  assert.ok(result.server.includes('from "./modules/1-calc.ts"'), "the server imports the TS shim");
  assert.ok(!result.client.includes("calc.ts"), "the client does not import TypeScript");

  const clientUse = packageWith({
    "main.flow": `foreign import js module "./calc.ts" {
  addAll :: List Int -> Int
}

main :: Html
main = <p>{str (addAll [1, 2, 3])}</p>
`,
    "calc.ts": `export const addAll = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
`,
  });
  assert.throws(() => compileFile(clientUse), /TypeScript, which the browser cannot load/);
});

test("ffi shim: missing files and missing exports are build errors", () => {
  const missing = packageWith({
    "main.flow": `foreign import js module "./nope.js" {
  f :: Int
}
main :: Html
main = <p>{"x"}</p>
`,
  });
  assert.throws(() => compileFile(missing), /shim module not found: "\.\/nope\.js"/);

  const noExport = packageWith({
    "main.flow": `foreign import js module "./lib.js" {
  absent :: Str -> Str
}
main :: Html
main = <p>{"x"}</p>
`,
    "lib.js": `export function present(s) { return s; }\n`,
  });
  assert.throws(() => compileFile(noExport), /does not export 'absent'/);
});

test("ffi shim: a shim can wrap an existing library and be passed Flow callbacks", () => {
  const entry = packageWith({
    "main.flow": `foreign import js module "./tiny-chart.js" {
  renderChart :: List Int -> (Int -> Str) -> Str
}

main :: Html
main = <p>{renderChart [1, 2, 3] (\\n -> "#" + str n)}</p>
`,
    // stand-in for a third-party module: a tiny renderer with its own API
    "tiny-chart.js": `export function renderChart(values, format) {
  return values.map((v) => format(v) + "=" + v).join(" ");
}
`,
  });
  const result = compileFile(entry);
  assert.equal(result.errors.length, 0);
  assert.ok(result.client.includes("$shim1.renderChart"), "the wrapper is called on the client");
  assert.match(result.client, /\$shim1\.renderChart\(/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileFile } from "../src/compile.ts";
import { createHost } from "../src/host.ts";

/**
 * End-to-end HTTP capability tests: the std::http Request/Router effects are
 * provided by the host, routes() is called at startup, and real requests are
 * dispatched to Flow handlers.
 */

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

async function withHttpHost(fn) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-http-"));
  const result = compileFile(path.join(import.meta.dirname, "..", "examples", "http.flow"));
  emit(result, outDir);
  const host = await createHost({ outDir, port: 0, secrets: {} });
  try {
    return await fn(host, result);
  } finally {
    await host.close();
  }
}

test("http: Request/Router capabilities route real requests", async () => {
  await withHttpHost(async (host, result) => {
    assert.ok(result.server.includes("as routes"), "routes() is exported by the server bundle");
    assert.ok(result.server.includes('__flow.host.routes'), "Router is a host-backed capability");

    const request = async (urlPath, init) => {
      const res = await fetch(host.url + urlPath, init);
      return { status: res.status, type: res.headers.get("content-type") ?? "", text: await res.text() };
    };

    const root = await request("/");
    assert.equal(root.status, 200);
    assert.match(root.type, /text\/html/);
    assert.match(root.text, /<h1>Hello world<\/h1>/);
    assert.match((await request("/?name=Flow")).text, /Hello Flow/);

    const health = await request("/health");
    assert.equal(health.status, 200);
    assert.match(health.type, /application\/json/);
    assert.match(health.text, /"ok":true/);

    const echo = await request("/echo", { method: "POST", body: "hi there" });
    assert.equal(echo.text, "hi there");

    assert.equal((await request("/users/42")).text, "user 42");
    assert.equal((await request("/whoami")).text, "GET /whoami");
    assert.equal((await request("/agent", { headers: { "x-test": "yes" } })).text, "header yes");

    const missing = await request("/missing");
    assert.equal(missing.status, 404);
    assert.match(missing.text, /no route for \/missing/);
  });
});

test("http: the client bundle and runtime remain served", async () => {
  await withHttpHost(async (host) => {
    const app = await fetch(host.url + "/app.js");
    assert.equal(app.status, 200);
    assert.match(app.headers.get("content-type") ?? "", /javascript/);
    assert.match(await app.text(), /__flow_start/);

    const runtime = await fetch(host.url + "/runtime/core.js");
    assert.equal(runtime.status, 200);
    assert.match(await runtime.text(), /createRuntime/);
  });
});

test("http: dispatch is a reusable in-language capability handler", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-http-handle-"));
  const file = path.join(root, "main.flow");
  fs.writeFileSync(file, `use std::http::{get, dispatch, RequestObject, Response, textResponse}

fn main() -> Html {
  let routes = [get("/x", fn(req: RequestObject) -> Response { textResponse(req.path) })];
  let request = { method: "GET", path: "/x", query: "", body: "", headers: [], params: [] };
  html { <p>{dispatch(routes, request).body}</p> }
}
`);
  const r = compileFile(file);
  assert.deepEqual(r.diagnostics, []);
  assert.ok(r.client.includes("dispatch("), "the pure handler is compiled");
});

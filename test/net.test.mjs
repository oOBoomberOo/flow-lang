import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
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

const source = (port) => `use std::net::{get as netGet, NetResult}
use std::fs::{tmpDir, writeText}
use std::http::{get, Router, RequestObject, Response, textResponse}

fn routes() -> Unit {
  Router.mount([
    get("/start", fn(_req: RequestObject) -> Response {
      netGet("http://127.0.0.1:${port}/ping", fn(result: NetResult) -> Unit {
        writeText(tmpDir() + "/flow-net-test.txt", if (result.ok) { result.body } else { "error:" + result.error })
      });
      textResponse("started")
    })
  ]);
}

fn main() -> Html { html { <p>{"net"}</p> } }
`;

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function waitForFile(file, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

test("net: the Net effect is placement-neutral and runs on the server", async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === "/ping") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("pong");
    } else {
      res.writeHead(404); res.end("no");
    }
  });
  const upstreamPort = await listen(upstream);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-net-"));
  const entry = path.join(root, "main.flow");
  fs.writeFileSync(entry, source(upstreamPort));
  const result = compileFile(entry);
  const outDir = path.join(root, "build");
  emit(result, outDir);
  const host = await createHost({ outDir, port: 0, secrets: {} });
  const file = path.join(os.tmpdir(), "flow-net-test.txt");
  fs.rmSync(file, { force: true });
  try {
    const effect = result.mod.effects.get("Net");
    assert.ok(effect, "Net effect exists");
    assert.equal(effect.place, "neutral", "Net is placement-neutral");
    assert.ok(result.server.includes('R.ffiFn("__flow.host.netRequest"'), "server provides Net over the host");
    assert.ok(result.client.includes('R.ffiFn("__flow.host.netRequest"'), "client also carries the host binding");

    const res = await fetch(host.url + "/start");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "started");

    const text = await waitForFile(file);
    assert.equal(text, "pong", "the server callback fetched the upstream response");
  } finally {
    await host.close();
    await close(upstream);
    fs.rmSync(file, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

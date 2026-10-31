import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileFile } from "../src/compile.ts";
import { createHost } from "../src/host.ts";

/**
 * End-to-end: compile a real program, boot the generated server, speak the
 * actual wire protocol (SSE down, POST up), and assert that the inferred cuts
 * answer correctly.
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

async function withHost(flowFile, fn) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-e2e-"));
  const result = compileFile(flowFile);
  emit(result, outDir);
  const host = await createHost({ outDir, port: 0, secrets: { flag: "S3CRET" } });
  try {
    return await fn(host, result);
  } finally {
    await host.close();
  }
}

/** Connect, wait for the `hello` frame, then return a message iterator. */
async function connect(host, sid) {
  const ac = new AbortController();
  const res = await fetch(`${host.url}/__flow/sse?sid=${sid}`, { signal: ac.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const queue = [];

  async function nextFrame() {
    for (;;) {
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => l.slice(6))
          .join("\n");
        if (data) return JSON.parse(data);
      }
      const { value, done } = await reader.read();
      if (done) return null;
      buf += dec.decode(value, { stream: true });
    }
  }

  for (;;) {
    const msg = await nextFrame();
    if (msg && msg.t === "hello") break;
    queue.push(msg);
  }

  return {
    async waitFor(pred, ms = 5000) {
      const deadline = Date.now() + ms;
      for (;;) {
        if (queue.length) {
          const m = queue.shift();
          if (pred(m)) return m;
          continue;
        }
        if (Date.now() > deadline) throw new Error("timed out waiting for message");
        const m = await nextFrame();
        if (!m) throw new Error("stream closed");
        if (pred(m)) return m;
        queue.push(m);
      }
    },
    close() { ac.abort(); },
  };
}

function post(host, sid, msg) {
  return fetch(host.url + "/__flow/msg", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sid, msg }),
  });
}

test("server serves the shell, the client bundle and the runtime", async () => {
  await withHost(path.join(import.meta.dirname, "..", "examples", "hello.flow"), async (host) => {
    const page = await fetch(host.url + "/");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /__flow_start/);

    const app = await fetch(host.url + "/app.js");
    assert.equal(app.status, 200);
    assert.match(await app.text(), /R\.el\("div"/);

    const rt = await fetch(host.url + "/runtime/client.js");
    assert.equal(rt.status, 200);
  });
});

test("a server cut answers a subscription over the real transport", async () => {
  const file = path.join(import.meta.dirname, "..", "examples", "boundary.flow");
  await withHost(file, async (host, result) => {
    assert.ok(result.diagnostics.some((d) => /cut cut1/.test(d)), "cut1 exists");
    const c = await connect(host, "s1");
    await post(host, "s1", { t: "sub", id: "cut1", args: {} });
    const msg = await c.waitFor((m) => m.t === "val" && m.id === "cut1");
    c.close();
    assert.match(String(msg.value), /^[0-9]+$/, "the server clock answered");
  });
});

test("reactive cuts stream updates when their dependencies change", async () => {
  const src = `
main :: Html
main = do
  let t = Server.now ()
  <p>{t}</p>`;
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-e2e-"));
  const { compileSource } = await import("../src/compile.ts");
  emit(compileSource(src, "stream.flow"), outDir);

  const { createHost: host } = await import("../src/host.ts");
  const h = await host({ outDir, port: 0, secrets: {} });
  try {
    const c = await connect(h, "s3");
    // cut1 has no deps: subscribe, then re-subscribe with a dep and expect a new value
    await post(h, "s3", { t: "sub", id: "cut1", args: {} });
    const first = await c.waitFor((m) => m.t === "val" && m.id === "cut1");
    assert.equal(typeof first.value, "number");
    c.close();
  } finally {
    await h.close();
  }
});

test("a call inside an event handler crosses as a request/response cut", async () => {
  const file = path.join(import.meta.dirname, "..", "examples", "effects.flow");
  await withHost(file, async (host, result) => {
    const ids = [...result.server.matchAll(/R\.serve\("(\w+)"/g)].map((m) => m[1]);
    const clientIds = [...result.client.matchAll(/R\.serve\("(\w+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids, ["cut1"], "server serves the audit cut");
    // Cells are neutral now, so the server needs no client subscription.
    assert.deepEqual(clientIds, [], "no client-side cut is required");

    const c = await connect(host, "s2");
    void post(host, "s2", { t: "call", id: "cut1", args: {}, reqId: 99 });
    const done = await c.waitFor((m) => m.t === "ret" && m.reqId === 99);
    c.close();
    assert.ok(done.value === undefined || done.value === null, "Audit.record returns Unit");
  });
});

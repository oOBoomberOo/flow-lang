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

/** Connect, wait for the `hello` frame, then yield frames. */
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
        const data = frame.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
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

const post = (host, sid, msg) => fetch(host.url + "/__flow/msg", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ sid, msg }),
});

const TIMER = `
type IO<a> = () -> a

effect Timer {
  fn every(ms: Int, callback: IO<Unit>) -> IO<Unit>
}

provide Timer with {
  every = fn(ms: Int, callback: IO<Unit>) -> IO<Unit> {
    let timer_id = unsafe_create_timer(callback, ms);
    fn() { unsafe_remove_timer(timer_id) }
  }
}

unsafe extern js fn unsafe_create_timer(callback: IO<Unit>, ms: Int) -> Int
  = "window.setInterval"
unsafe extern js fn unsafe_remove_timer(timer_id: Int)
  = "window.clearInterval"

fn main() -> Html {
  let cancel = Timer.every(1000, fn() {
    Server.log("tick");
  });
  html { <div>{"Hello World!"}</div> }
}
`;

test("callback UX: the callback is hosted on the client and its server effect is a call cut", () => {
  const result = compileSource(TIMER, "timer.flow");
  assert.equal(result.errors.length, 0);

  // The callback value never crosses: it is emitted in the client bundle, where
  // the provider invokes it, and awaits a server call when it runs.
  assert.match(result.client, /R\.op\("Timer", "every"\)\(R\.v\(1000\), R\.v\(\(async \(\) => \(await R\.call\("cut1", \{\}\)\)\)\)\)/);
  assert.doesNotMatch(result.client, /R\.serve\("cut1"/, "the client hosts the callback, not the cut");
  assert.match(result.client, /R\.provide\("Timer"/, "the provider runs on the client");

  // The server hosts only the statement that needs it.
  assert.match(result.server, /R\.serve\("cut1"/);
  assert.match(result.server, /R\.op\("Server", "log"\)/);
  assert.ok(result.diagnostics.some((d) => /cut cut1: .*type=Unit/.test(d)), "the cut returns Unit, not a function");
});

test("callback UX: the server half of the callback really runs", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-ux-"));
  emit(compileSource(TIMER, "timer.flow"), outDir);

  const logged = [];
  const original = console.log;
  console.log = (...args) => { logged.push(args.join(" ")); };
  const host = await createHost({ outDir, port: 0, secrets: {} });
  try {
    const c = await connect(host, "ux1");
    await post(host, "ux1", { t: "call", id: "cut1", args: {}, reqId: 7 });
    const ret = await c.waitFor((m) => m.t === "ret" && m.reqId === 7);
    c.close();
    assert.equal(ret.error, undefined);
    assert.ok(logged.includes("tick"), `server logged the callback body (got ${JSON.stringify(logged)})`);
  } finally {
    console.log = original;
    await host.close();
  }
});

test("callback UX: statements may cross individually inside one callback", () => {
  const src = `
fn main() -> Html {
  let cb = fn() {
    Client.log("on the client");
    Server.log("on the server");
  };
  cb();
  html { <p>{"x"}</p> }
}
`;
  const result = compileSource(src, "mix.flow");
  assert.equal(result.errors.length, 0);
  const client = result.client;
  const server = result.server;
  const cuts = [...client.matchAll(/R\.call\("(cut\d+)"/g)].map((m) => m[1]);
  assert.equal(cuts.length, 1, "only the server statement is a call cut");
  assert.match(client, /R\.op\("Client", "log"\)/);
  assert.match(server, /R\.op\("Server", "log"\)/);
});

test("callback UX: a callback value that must cross still fails clearly", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-ux-err-"));
  const file = path.join(dir, "main.flow");
  fs.writeFileSync(file, `
fn make() -> () -> Int {
  fn() { Server.now() }
}

fn main() -> Html {
  let f = make();
  html { <p>{str(f())}</p> }
}
`);
  try {
    assert.throws(() => compileFile(file), (e) => {
      assert.match(e.message, /cannot cross the/);
      assert.match(e.message, /functions are not serializable/);
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

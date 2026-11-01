import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileFile, compileSource } from "../src/compile.ts";
import { createHost } from "../src/host.ts";
import { withModule } from "./helpers.mjs";

/**
 * Cell placement: `Cell a @client` and `Cell a @server` are explicit, and the
 * compiler turns reads/writes into cuts on the owning side. A cell crosses as
 * a handle (never as a serialized cell object), so it can be created in any
 * local scope on either tier.
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
      const pending = queue.findIndex(pred);
      if (pending >= 0) return queue.splice(pending, 1)[0];
      for (;;) {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error("timed out waiting for message");
        let timer;
        const m = await Promise.race([
          nextFrame(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("timed out waiting for message")), left);
            if (timer && typeof timer.unref === "function") timer.unref();
          }),
        ]).finally(() => clearTimeout(timer));
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

const SERVER_CELL_PROGRAM = `
counter :: Cell Int @server
counter = Server.state 0

bump :: Int -> ()
bump n = counter := counter.value + n

main :: Html
main = <div>
  <button onClick={\\(e :: Event) -> bump 1}>{"+1"}</button>
  <p>{str counter.value}</p>
</div>`;

test("cells: Client.state is client-bound and stays in the browser bundle", () => {
  const r = compileSource(`main :: Html
main = do
  let c = Client.state 1
  c := c.value + 1
  <p>{str c.value}</p>`, "client-cell.flow");
  assert.deepEqual(r.errors, []);
  assert.match(r.client, /__flow\.host\.cell/, "the cell is created on the client");
  assert.match(r.client, /__flow\.(get|set)/, "reads and writes are client host calls");
  assert.ok(!r.diagnostics.some((d) => /^cut /.test(d)), "no cut is needed");
});

test("cells: a top-level Cell a @client stays in the client bundle", () => {
  const r = compileSource(`clientCell :: Cell Int @client
clientCell = Client.state 0

main :: Html
main = <p>{str clientCell.value}</p>`, "client-cell-top.flow");
  assert.deepEqual(r.errors, []);
  assert.ok(!r.diagnostics.some((d) => /^cut /.test(d)), "no cut is needed");
  assert.match(r.client, /let __flow_v_clientCell/);
  assert.ok(!/function clientCell\(/.test(r.server), "the client cell is not emitted on the server");
});

test("cells: a server-bound cell is created once and read/written through cuts", () => {
  const r = compileSource(SERVER_CELL_PROGRAM, "server-cell.flow");
  assert.deepEqual(r.errors, []);
  // A call cut for the mutation and a reactive cut for the value read.
  const call = r.diagnostics.find((d) => /^cut \w+: call /.test(d));
  const reactive = r.diagnostics.find((d) => /^cut \w+: reactive /.test(d));
  assert.ok(call, "the handler crosses as a call cut");
  assert.ok(reactive, "the read crosses as a reactive cut");
  assert.match(r.server, /let __flow_v_counter/);
  assert.match(r.server, /function counter\(\) \{ if \(__flow_v_counter === undefined\)/,
    "the server cell is memoized, not re-created on every read");
  assert.match(r.server, /R\.serve\("[^"]+", \(A\) => \{  return (?:R\.run\()?bump\(/);
  assert.match(r.client, /on:click/);
  assert.match(r.client, /R\.call\("/, "the handler calls the server");
  assert.match(r.client, /R\.remote\("/, "the read subscribes to the server cell");
  assert.ok(!/function counter\(/.test(r.client), "the cell is not created in the browser");
});

test("cells: an event handler sends the field value, not the Event", () => {
  const r = compileSource(`
data Todo = Todo { id :: Int, title :: Str, completed :: Bool }

addTodo :: Todo -> List Todo -> List Todo
addTodo todo todos = todos ++ [todo]

state :: Cell (List Todo)
state = Server.state []

homePage req =
  <div>
    <button onClick={addItem}>{"+"}</button>
  </div>
  where
    addItem event =
      let title = event.target.value in
        state.update $
          \\todos -> addTodo (Todo { id = getLastId todos + 1, title = title, completed = False }) todos
            where
              getLastId = List.fold Math.maxInt 0 . map \\t -> t.id

main :: Html
main = homePage ()`, "event-cut.flow");
  assert.deepEqual(r.errors, []);
  const cut = r.diagnostics.find((d) => /^cut \w+: call server-side/.test(d));
  assert.ok(cut, "the update crosses as a call cut");
  assert.match(cut, /deps=\[title\]/, "only the string crosses, not the Event");
  assert.match(r.server, /const getLastId =/, "the pure local helper is duplicated on the server");
  assert.doesNotMatch(r.server, /event\.target/, "the server never touches the Event");
});

test("cells: a pure local helper is duplicated and only its captured value crosses", () => {
  const r = compileSource(`main :: Html
main = do
  let n = 1
  let f = \\(x :: Int) -> x + n
  <p>{Server.log (str (f 1))}</p>`, "helper-cut.flow");
  assert.deepEqual(r.errors, []);
  const cut = r.diagnostics.find((d) => /^cut \w+: reactive server-side/.test(d));
  assert.ok(cut, "the log call crosses");
  assert.match(cut, /deps=\[n\]/, "the captured value crosses, not the function");
  assert.match(r.server, /const f =/, "the helper is re-emitted on the server");
});

test("cells: a right-section map reads the list on the server and renders on the client", () => {
  const r = compileSource(`state :: Cell (List Int)
state = Server.state []

main :: Html
main = <ul>{map (get state) $ \\n -> <li>{str n}</li>}</ul>`, "map-cut.flow");
  assert.deepEqual(r.errors, []);
  const cut = r.diagnostics.find((d) => /^cut \w+: reactive server-side/.test(d));
  assert.ok(cut, "the list read is a reactive cut");
  assert.match(cut, /type=List Int/, "the cut produces the list, not a function");
  assert.doesNotMatch(cut, /->/, "no function value crosses");
  assert.match(r.client, /map|Functor/, "the map runs in the browser");
  assert.match(
    r.client,
    /R\.remote\("[^"]+", \(\) => \(\{\}\), \[\]\)/,
    "the list has an empty placeholder until the first server value",
  );
});

test("cells: a server-bound cell can be created inside client code", () => {
  const r = compileSource(`main :: Html
main = do
  let counter = Server.state 0
  <p>{str counter.value}</p>`, "local-server-cell.flow");
  assert.deepEqual(r.errors, []);
  assert.match(r.client, /R\.remote\("/, "creating the cell crosses as a cut");
  assert.match(r.client, /__flow\.get/, "the client reads through the handle");
  assert.ok(!/function counter\(/.test(r.client), "the cell is not created in the browser");
  assert.match(r.server, /state\$flow\$server|__flow\.host\.cell/, "the cell is created on the server");
});

test("cells: local client and server cells can share a tuple", () => {
  const r = compileSource(`main :: Html
main = <p>{"cells"}</p>

hello :: () -> (Cell Int @client, Cell Bool @server, Cell Str @client)
hello () =
  let x = Client.state 0 in
  let y = Server.state False in
  let z = Client.state "" in
  (x, y, z)`, "local-cell-tuple.flow");
  assert.deepEqual(r.errors, []);
  assert.match(r.client, /R\.remote\("/, "the server cell is a remote handle");
  assert.match(r.server, /state\$flow\$server|__flow\.host\.cell/, "the server cell is created on the server");
});

test("cells: a server cell keeps its identity and streams updates", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-cell-place-"));
  const entry = path.join(root, "main.flow");
  fs.writeFileSync(entry, withModule(SERVER_CELL_PROGRAM));
  const result = compileFile(entry);
  assert.deepEqual(result.errors, []);

  const call = result.diagnostics.find((d) => /^cut (\w+): call /.test(d))?.match(/^cut (\w+):/)?.[1];
  const reactive = result.diagnostics.find((d) => /^cut (\w+): reactive /.test(d))?.match(/^cut (\w+):/)?.[1];
  assert.ok(call && reactive, "both cuts exist");

  const outDir = path.join(root, "build");
  emit(result, outDir);
  const host = await createHost({ outDir, port: 0, secrets: {} });
  let c;
  try {
    c = await connect(host, "cell1");
    await post(host, "cell1", { t: "sub", id: reactive, args: {} });
    const first = await c.waitFor((m) => m.t === "val" && m.id === reactive);
    assert.equal(first.value, "0");

    await post(host, "cell1", { t: "call", id: call, args: {}, reqId: 1 });
    const done = await c.waitFor((m) => m.t === "ret" && m.reqId === 1);
    assert.equal(done.error, undefined);

    const next = await c.waitFor((m) => m.t === "val" && m.id === reactive && m.value !== "0");
    assert.equal(next.value, "1", "the server cell changed and the subscription re-sent it");
  } finally {
    c?.close();
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

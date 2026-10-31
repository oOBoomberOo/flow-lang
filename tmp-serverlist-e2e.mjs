import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileSource } from "./src/compile.ts";
import { createHost } from "./src/host.ts";

const SRC = `
data Todo = Todo { id :: Int, title :: Str, completed :: Bool }

addTodo :: Todo -> List Todo -> List Todo
addTodo todo todos = todos ++ [todo]

getLastId :: List Todo -> Int
getLastId = List.fold Math.maxInt 0 . map \\t -> t.id

state :: Cell (List Todo) @server
state = Server.state []

addItem :: Event -> ()
addItem event =
  let title = event.target.value in
    state.update $
      \\todos -> addTodo (Todo { id = getLastId todos + 1, title = title, completed = False }) todos

main :: Html
main = <div>
  <button onClick={addItem}>{"+"}</button>
  {map (get state) $ \\todo -> <span>{todo.title}</span>}
</div>`;

const RUNTIME_FILES = ["core.js", "server.js", "dom.js", "client.js"];
function emit(result, outDir) {
  const rt = path.join(import.meta.dirname, "src", "runtime");
  fs.mkdirSync(path.join(outDir, "runtime"), { recursive: true });
  fs.writeFileSync(path.join(outDir, "app.js"), result.client);
  fs.writeFileSync(path.join(outDir, "server.js"), result.server);
  for (const f of RUNTIME_FILES) fs.copyFileSync(path.join(rt, f), path.join(outDir, "runtime", f));
  fs.writeFileSync(
    path.join(outDir, "runtime", "server-runtime.js"),
    `import { createServerRuntime } from "./server.js";\nconst opts = JSON.parse(process["env"].FLOW_OPTS || "{}");\nexport const R = createServerRuntime(opts);\n`,
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
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
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
        if (Date.now() > deadline) throw new Error("timed out");
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
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sid, msg }),
});

const result = compileSource(SRC, "server-list.flow");
console.log("errors", result.errors, "cuts", result.diagnostics);
if (result.errors.length) process.exit(1);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-server-list-"));
const outDir = path.join(root, "build");
emit(result, outDir);
const host = await createHost({ outDir, port: 0, secrets: {} });
const c = await connect(host, "s1");
const reactive = result.diagnostics.find((d) => /reactive/.test(d))?.match(/^cut (\w+):/)?.[1];
const call = result.diagnostics.find((d) => /call/.test(d))?.match(/^cut (\w+):/)?.[1];
await post(host, "s1", { t: "sub", id: reactive, args: {} });
const first = await c.waitFor((m) => m.t === "val" && m.id === reactive);
console.log("initial", JSON.stringify(first.value));
await post(host, "s1", { t: "call", id: call, args: { title: "hello" }, reqId: 1 });
const done = await c.waitFor((m) => m.t === "ret" && m.reqId === 1);
console.log("ret", JSON.stringify(done));
const next = await c.waitFor((m) => m.t === "val" && m.id === reactive && JSON.stringify(m.value) !== JSON.stringify(first.value));
console.log("updated", JSON.stringify(next.value));
c.close();
await host.close();
fs.rmSync(root, { recursive: true, force: true });

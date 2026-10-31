import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The editor must keep working while a file has errors: parse recovery keeps
 * the other declarations, and completion understands module paths without a
 * `use`.
 */

class Client {
  constructor(proc) {
    this.proc = proc;
    this.buf = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.inbox = [];
    this.waiters = [];
    proc.stdout.on("data", (c) => this.feed(c));
    proc.stderr.on("data", () => {});
  }
  feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const idx = this.buf.indexOf("\r\n\r\n");
      if (idx < 0) return;
      const m = /Content-Length:\s*(\d+)/i.exec(this.buf.slice(0, idx).toString("utf8"));
      if (!m) { this.buf = this.buf.slice(idx + 4); continue; }
      const len = Number(m[1]);
      if (this.buf.length < idx + 4 + len) return;
      const msg = JSON.parse(this.buf.slice(idx + 4, idx + 4 + len).toString("utf8"));
      this.buf = this.buf.slice(idx + 4 + len);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      } else {
        this.inbox.push(msg);
        this.waiters.splice(0).forEach((w) => w());
      }
    }
  }
  send(msg) {
    const body = JSON.stringify({ jsonrpc: "2.0", ...msg });
    this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`timeout: ${method}`)); }, 8000).unref?.();
    });
  }
  notify(method, params) { this.send({ method, params }); }
  async waitFor(pred, ms = 8000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const i = this.inbox.findIndex(pred);
      if (i >= 0) return this.inbox.splice(i, 1)[0];
      if (Date.now() > deadline) throw new Error("timeout waiting for notification");
      await new Promise((r) => { this.waiters.push(r); setTimeout(r, 100).unref?.(); });
    }
  }
}

const SERVER = path.join(import.meta.dirname, "..", "src", "lsp", "server.ts");
const startServer = () => new Client(spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] }));
const uri = (file) => `file:///${path.resolve(file).replace(/\\/g, "/").replace(/^\/+/, "")}`;

function fileWith(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-res-"));
  const file = path.join(dir, "main.flow");
  fs.writeFileSync(file, text);
  return file;
}

async function open(c, file, text) {
  c.notify("textDocument/didOpen", { textDocument: { uri: uri(file), languageId: "flow", version: 1, text } });
  await c.waitFor((m) => m.method === "textDocument/publishDiagnostics");
}

const pos = (text, needle, offset = 1, nth = 0) => {
  const lines = text.split("\n");
  let seen = 0;
  for (let l = 0; l < lines.length; l++) {
    let from = 0;
    for (;;) {
      const i = lines[l].indexOf(needle, from);
      if (i < 0) break;
      if (seen++ === nth) return { line: l, character: i + offset };
      from = i + 1;
    }
  }
  throw new Error(`not found: ${needle}`);
};

test("lsp: module-path completion works without imports", async () => {
  const text = `main :: Html
main = <p>{"x"}</p>

probe :: Int
probe = List.
`;
  const file = fileWith(text);
  const c = startServer();
  try {
    await c.request("initialize", { rootUri: null, capabilities: {} });
    await open(c, file, text);

    const members = await c.request("textDocument/completion", {
      textDocument: { uri: uri(file) },
      position: pos(text, "List.", 5),
    });
    const memberLabels = (members.items ?? []).map((i) => i.label);
    assert.ok(memberLabels.includes("map"), "List. offers map");
    assert.ok(memberLabels.includes("sortBy"), "List. offers sortBy");
    assert.ok(memberLabels.includes("length"), "List. offers length");
    const map = members.items.find((i) => i.label === "map");
    assert.match(String(map.detail), /List\.map/);
  } finally { c.proc.kill(); }
});

test("lsp: a syntax error keeps the other declarations analysable", async () => {
  const text = `good :: () -> Int
good () = 2

bad () = 1 +

main :: Html
main = <p>{str (good ())}</p>

-- go
`;
  const file = fileWith(text);
  const c = startServer();
  try {
    await c.request("initialize", { rootUri: null, capabilities: {} });
    await open(c, file, text);

    const diags = await c.request("textDocument/documentSymbol", { textDocument: { uri: uri(file) } });
    const names = diags.map((s) => s.name);
    assert.ok(names.includes("good"), "good survives the syntax error");
    assert.ok(names.includes("main"), "main survives the syntax error");

    const hover = await c.request("textDocument/hover", {
      textDocument: { uri: uri(file) },
      position: pos(text, "good ()", 2, 1),
    });
    assert.ok(hover?.contents?.value, "hover works on the good declaration");
    assert.match(hover.contents.value, /Placement/);

    const completion = await c.request("textDocument/completion", {
      textDocument: { uri: uri(file) },
      position: pos(text, "-- go", 4),
    });
    assert.ok((completion.items ?? []).some((i) => i.label === "good"), "completion still sees good");

    const tokens = await c.request("textDocument/semanticTokens/full", { textDocument: { uri: uri(file) } });
    assert.ok(tokens.data.length > 0, "semantic tokens are still produced");
  } finally { c.proc.kill(); }
});

test("lsp: a type error in one function keeps symbols and completion for the rest", async () => {
  const text = `bad :: () -> Int
bad () = "x"

good :: () -> Int
good () = 2

main :: Html
main = <p>{str (good ())} {str (bad ())}</p>

-- go
`;
  const file = fileWith(text);
  const c = startServer();
  try {
    await c.request("initialize", { rootUri: null, capabilities: {} });
    await open(c, file, text);

    const syms = await c.request("textDocument/documentSymbol", { textDocument: { uri: uri(file) } });
    const names = syms.map((s) => s.name);
    for (const n of ["bad", "good", "main"]) assert.ok(names.includes(n), `${n} is listed`);

    const completion = await c.request("textDocument/completion", {
      textDocument: { uri: uri(file) },
      position: pos(text, "-- go", 4),
    });
    assert.ok((completion.items ?? []).some((i) => i.label === "good"));

    const hover = await c.request("textDocument/hover", {
      textDocument: { uri: uri(file) },
      position: pos(text, "good ()", 2, 1),
    });
    assert.match(hover.contents.value, /Placement/);
  } finally { c.proc.kill(); }
});

test("lsp: a broken import keeps the file analysable", async () => {
  const text = `import Nope.Missing (x)

good :: () -> Int
good () = 2

main :: Html
main = <p>{str (good ())}</p>
`;
  const file = fileWith(text);
  const c = startServer();
  try {
    await c.request("initialize", { rootUri: null, capabilities: {} });
    await open(c, file, text);
    const syms = await c.request("textDocument/documentSymbol", { textDocument: { uri: uri(file) } });
    const names = syms.map((s) => s.name);
    assert.ok(names.includes("good"));
    assert.ok(names.includes("main"));
  } finally { c.proc.kill(); }
});

test("lsp: a burst of keystrokes is coalesced into one analysis", async () => {
  const text = `main :: Html
main = <p>{"x"}</p>
`;
  const file = fileWith(text);
  const c = startServer();
  try {
    await c.request("initialize", { rootUri: null, capabilities: {} });
    await open(c, file, text);
    // consume both notifications produced by didOpen before counting
    await c.waitFor((m) => m.method === "flow/boundaryChanged");
    c.inbox = c.inbox.filter((m) => m.method !== "flow/boundaryChanged");

    const pos = { line: 1, character: 0 };
    for (const ch of "// typing") {
      c.notify("textDocument/didChange", {
        textDocument: { uri: uri(file), version: 2 },
        contentChanges: [{ range: { start: pos, end: pos }, text: ch }],
      });
      await new Promise((r) => setTimeout(r, 5));
    }
    await c.waitFor((m) => m.method === "textDocument/publishDiagnostics");
    // let any wrongly-scheduled analyses fire before counting
    await new Promise((r) => setTimeout(r, 400));

    const boundaryUpdates = c.inbox.filter((m) => m.method === "flow/boundaryChanged").length;
    assert.equal(boundaryUpdates, 1, "10 keystrokes produce one analysis, not ten");
  } finally { c.proc.kill(); }
});

test("lsp: cell dot completion offers value/get/set/update", async () => {
  const text = `main :: Html
main = do
  let c = Client.state 0
  <p>{c.value}</p>
`;
  const file = fileWith(text);
  const c = startServer();
  try {
    await c.request("initialize", { rootUri: null, capabilities: {} });
    await open(c, file, text);
    const items = await c.request("textDocument/completion", {
      textDocument: { uri: uri(file) },
      position: pos(text, "c.value", 2),
    });
    const labels = (items.items ?? []).map((i) => i.label);
    for (const l of ["value", "get", "set", "update"]) {
      assert.ok(labels.includes(l), `cell completion includes ${l}`);
    }
  } finally { c.proc.kill(); }
});

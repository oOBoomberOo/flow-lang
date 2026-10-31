import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Drives the real language server over stdio, exactly as an editor would.
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
      const header = this.buf.slice(0, idx).toString("utf8");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) { this.buf = this.buf.slice(idx + 4); continue; }
      const len = Number(m[1]);
      if (this.buf.length < idx + 4 + len) return;
      const body = this.buf.slice(idx + 4, idx + 4 + len).toString("utf8");
      this.buf = this.buf.slice(idx + 4 + len);
      const msg = JSON.parse(body);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
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
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout: ${method}`));
      }, 8000).unref?.();
    });
  }

  notify(method, params) { this.send({ method, params }); }

  async waitFor(pred, ms = 8000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const i = this.inbox.findIndex(pred);
      if (i >= 0) return this.inbox.splice(i, 1)[0];
      if (Date.now() > deadline) throw new Error("timeout waiting for notification");
      await new Promise((r) => {
        this.waiters.push(r);
        setTimeout(r, 100).unref?.();
      });
    }
  }
}

function startServer() {
  const proc = spawn(process.execPath, [path.join(import.meta.dirname, "..", "src", "lsp", "server.ts")], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new Client(proc);
}

function tmpFlow(src) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-lsp-"));
  const file = path.join(dir, "main.flow");
  fs.writeFileSync(file, src);
  return file;
}

const uri = (file) => `file:///${path.resolve(file).replace(/\\/g, "/").replace(/^\/+/, "")}`;

const GOOD = `
main :: Html
main = do
  let n = Client.state 0
  <div>
    <button onClick={\\(e :: Event) -> n.set (n.get () + 1)}>{"+1"}</button>
    <p>{"count: "} {n.get ()}</p>
    <p>{"secret: "} {str (Server.now ())}</p>
  </div>
`;

const BAD = `main :: Html
main = <p>{1 + "a"}</p>
`;

test("lsp: initialize advertises semantic tokens and hover", async () => {
  const c = startServer();
  try {
    const res = await c.request("initialize", { rootUri: null, capabilities: {} });
    assert.ok(res.capabilities.semanticTokensProvider);
    assert.ok(res.capabilities.semanticTokensProvider.legend.tokenTypes.includes("keyword"));
    assert.ok(res.capabilities.semanticTokensProvider.legend.tokenModifiers.includes("client"));
    assert.ok(res.capabilities.hoverProvider);
    assert.equal(res.serverInfo.name, "flow-lsp");
  } finally { c.proc.kill(); }
});

test("lsp: diagnostics are published for a type error", async () => {
  const file = tmpFlow(BAD);
  const c = startServer();
  try {
    await c.request("initialize", { rootUri: null, capabilities: {} });
    c.notify("textDocument/didOpen", {
      textDocument: { uri: uri(file), languageId: "flow", version: 1, text: BAD },
    });
    const note = await c.waitFor((m) => m.method === "textDocument/publishDiagnostics");
    assert.equal(note.params.uri, uri(file));
    assert.equal(note.params.diagnostics.length, 1);
    assert.match(note.params.diagnostics[0].message, /right operand of '\+' \(left is Int\): expected Int, got Str/);
    assert.equal(note.params.diagnostics[0].severity, 1);
    assert.equal(note.params.diagnostics[0].source, "flow");
  } finally { c.proc.kill(); }
});

test("lsp: clean file has no diagnostics and reports boundary regions", async () => {
  const file = tmpFlow(GOOD);
  const c = startServer();
  try {
    await c.request("initialize", { rootUri: null, capabilities: {} });
    c.notify("textDocument/didOpen", {
      textDocument: { uri: uri(file), languageId: "flow", version: 1, text: GOOD },
    });
    const note = await c.waitFor((m) => m.method === "textDocument/publishDiagnostics");
    assert.equal(note.params.diagnostics.length, 0);

    const boundary = await c.request("flow/boundary", { uri: uri(file) });
    assert.ok(boundary.regions.length > 0, "has regions");
    const cuts = boundary.regions.filter((r) => r.kind === "cut");
    assert.ok(cuts.length >= 1, "has a cut");
    assert.ok(cuts.some((r) => r.side === "server"), "server-side cut");
    assert.equal(boundary.summary.cuts, cuts.length);
  } finally { c.proc.kill(); }
});

test("lsp: semantic tokens carry client/server modifiers", async () => {
  const file = tmpFlow(GOOD);
  const c = startServer();
  try {
    await c.request("initialize", { rootUri: null, capabilities: {} });
    c.notify("textDocument/didOpen", {
      textDocument: { uri: uri(file), languageId: "flow", version: 1, text: GOOD },
    });
    await c.waitFor((m) => m.method === "textDocument/publishDiagnostics");
    const toks = await c.request("textDocument/semanticTokens/full", { textDocument: { uri: uri(file) } });
    assert.ok(toks.data.length > 0);
    assert.equal(toks.data.length % 5, 0);

    // decode and check that at least one token is a keyword and one carries a side modifier
    let line = 0, char = 0;
    let sawKeyword = false, sawClient = false, sawServer = false;
    for (let i = 0; i < toks.data.length; i += 5) {
      const dl = toks.data[i], dc = toks.data[i + 1], type = toks.data[i + 3], mods = toks.data[i + 4];
      line += dl;
      char = dl === 0 ? char + dc : dc;
      if (type === 0) sawKeyword = true;
      if (mods & 1) sawClient = true;
      if (mods & 2) sawServer = true;
      void line; void char;
    }
    assert.ok(sawKeyword, "keywords are tokenized");
    assert.ok(sawClient, "some token is client-colored");
    assert.ok(sawServer, "some token is server-colored");
  } finally { c.proc.kill(); }
});

test("lsp: hover reports the inferred type and placement", async () => {
  const file = tmpFlow(GOOD);
  const c = startServer();
  try {
    await c.request("initialize", { rootUri: null, capabilities: {} });
    c.notify("textDocument/didOpen", {
      textDocument: { uri: uri(file), languageId: "flow", version: 1, text: GOOD },
    });
    await c.waitFor((m) => m.method === "textDocument/publishDiagnostics");

    // position on `n` in `n.get()` inside the <p>
    const lines = GOOD.split("\n");
    const line = lines.findIndex((l) => l.includes('"count: "'));
    const character = lines[line].indexOf("n.get");
    const hover = await c.request("textDocument/hover", {
      textDocument: { uri: uri(file) },
      position: { line, character },
    });
    assert.ok(hover, "hover result");
    assert.match(hover.contents.value, /Placement/);
  } finally { c.proc.kill(); }
});

test("lsp: incremental edits re-diagnose", async () => {
  const file = tmpFlow(GOOD);
  const c = startServer();
  try {
    await c.request("initialize", { rootUri: null, capabilities: {} });
    c.notify("textDocument/didOpen", {
      textDocument: { uri: uri(file), languageId: "flow", version: 1, text: GOOD },
    });
    await c.waitFor((m) => m.method === "textDocument/publishDiagnostics" && m.params.diagnostics.length === 0);

    // break the file: replace `n.get() + 1` with `n.get() + "x"`
    const lineIdx = GOOD.split("\n").findIndex((l) => l.includes("n.get () + 1"));
    const lineText = GOOD.split("\n")[lineIdx];
    const start = lineText.indexOf("n.get () + 1");
    c.notify("textDocument/didChange", {
      textDocument: { uri: uri(file), version: 2 },
      contentChanges: [{
        range: { start: { line: lineIdx, character: start }, end: { line: lineIdx, character: start + "n.get () + 1".length } },
        text: 'n.get () + "x"',
      }],
    });
    const note = await c.waitFor((m) => m.method === "textDocument/publishDiagnostics" && m.params.diagnostics.length > 0);
    assert.match(note.params.diagnostics[0].message, /right operand of '\+'/);
  } finally { c.proc.kill(); }
});

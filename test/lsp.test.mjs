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

/** Decode LSP relative semantic-token data into absolute positions. */
function decodeTokens(data) {
  const out = [];
  let line = 0, char = 0;
  for (let i = 0; i < data.length; i += 5) {
    const dl = data[i], dc = data[i + 1];
    line += dl;
    char = dl === 0 ? char + dc : dc;
    out.push({ line, char, len: data[i + 2], type: data[i + 3], mods: data[i + 4] });
  }
  return out;
}

function hasMod(token, legend, name) {
  const at = legend.tokenModifiers.indexOf(name);
  return at >= 0 && (token.mods & (1 << at)) !== 0;
}

const GOOD = `
module Main where

main :: Html
main = do
  let n = Client.state 0
  <div>
    <button onClick={\\(e :: Event) -> n.set (n.get () + 1)}>{"+1"}</button>
    <p>{"count: "} {n.get ()}</p>
    <p>{"secret: "} {str (Server.now ())}</p>
  </div>
`;

const BAD = `module Main where

main :: Html
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
    const res = await c.request("initialize", { rootUri: null, capabilities: {} });
    c.notify("textDocument/didOpen", {
      textDocument: { uri: uri(file), languageId: "flow", version: 1, text: GOOD },
    });
    await c.waitFor((m) => m.method === "textDocument/publishDiagnostics");
    const toks = await c.request("textDocument/semanticTokens/full", { textDocument: { uri: uri(file) } });
    assert.ok(toks.data.length > 0);
    assert.equal(toks.data.length % 5, 0);

    // Decode and check that symbols carry their tier. A cut is its own colour;
    // it does not masquerade as an ordinary server symbol.
    const legend = res.capabilities.semanticTokensProvider.legend;
    const decoded = decodeTokens(toks.data);
    assert.ok(decoded.some((t) => t.type === 0), "keywords are tokenized");
    assert.ok(decoded.some((t) => hasMod(t, legend, "client")), "some symbol is client-colored");

    const cut = decoded.filter((t) => hasMod(t, legend, "cut"));
    assert.ok(cut.length > 0, "symbols inside the inferred cut are marked");
    assert.ok(cut.some((t) => hasMod(t, legend, "cut1")), "the cut uses its palette slot");
    assert.ok(!cut.some((t) => hasMod(t, legend, "server")), "a cut is not also painted as plain server code");
  } finally { c.proc.kill(); }
});

test("lsp: separate cuts get separate colours and dependencies keep their owner's", async () => {
  const src = `module Main where

main :: Html
main = do
  let n = Client.now ()
  <div>
    <p>{str (Server.now ())}</p>
    <p>{str (Server.now () + n)}</p>
  </div>
`;
  const file = tmpFlow(src);
  const c = startServer();
  try {
    const res = await c.request("initialize", { rootUri: null, capabilities: {} });
    const legend = res.capabilities.semanticTokensProvider.legend;
    c.notify("textDocument/didOpen", {
      textDocument: { uri: uri(file), languageId: "flow", version: 1, text: src },
    });
    await c.waitFor((m) => m.method === "textDocument/publishDiagnostics");

    const boundary = await c.request("flow/boundary", { uri: uri(file) });
    const cuts = boundary.regions.filter((r) => r.kind === "cut");
    assert.equal(cuts.length, 2, "two server calls are two cuts");
    const depCut = cuts.find((r) => (r.deps || []).includes("n"));
    assert.ok(depCut, "the second cut carries `n` across the boundary");
    assert.ok(cuts.every((r) => r.palette >= 1 && r.colorKey), "every cut reports a palette slot");

    const toks = await c.request("textDocument/semanticTokens/full", { textDocument: { uri: uri(file) } });
    const decoded = decodeTokens(toks.data);

    const cutSlots = decoded.filter((t) => hasMod(t, legend, "cut"))
      .map((t) => legend.tokenModifiers.find((m) => /^cut\d+$/.test(m) && hasMod(t, legend, m)));
    assert.ok(cutSlots.includes("cut1") && cutSlots.includes("cut2"), "the two cuts use different palette colours");

    // `n` in the second cut is the dependency, not a symbol owned by cut2.
    const lines = src.split("\n");
    const depLine = lines.findIndex((l) => l.includes("Server.now () + n"));
    const depChar = lines[depLine].indexOf("n)");
    const dep = decoded.find((t) => t.line === depLine && t.char === depChar && t.len === 1);
    assert.ok(dep, "the dependency token is present");
    assert.ok(hasMod(dep, legend, "dependency"), "the dependency is marked as crossing in");
    assert.ok(hasMod(dep, legend, "client"), "the dependency keeps its client owner's colour");
    assert.ok(!hasMod(dep, legend, "cut"), "the dependency is not owned by the cut it is used in");
    assert.ok(!hasMod(dep, legend, "cut2"), "the dependency does not take the cut's palette colour");
  } finally { c.proc.kill(); }
});

test("lsp: a where-clause cut inherits its function's tier and dependency owner", async () => {
  const src = `module Main where

main :: Html
main =
  <div>{str (add 1)}</div>

  where
    add x = Server.now () + x
`;
  const file = tmpFlow(src);
  const c = startServer();
  try {
    const res = await c.request("initialize", { rootUri: null, capabilities: {} });
    const legend = res.capabilities.semanticTokensProvider.legend;
    c.notify("textDocument/didOpen", {
      textDocument: { uri: uri(file), languageId: "flow", version: 1, text: src },
    });
    await c.waitFor((m) => m.method === "textDocument/publishDiagnostics");

    const boundary = await c.request("flow/boundary", { uri: uri(file) });
    const cut = boundary.regions.find((r) => r.kind === "cut");
    assert.ok(cut, "the server call in the where binding is a cut");
    assert.equal(cut.parent, "Main.main", "the cut belongs to the enclosing function, not to nothing");
    assert.equal(cut.direction, "client→server");
    assert.deepEqual(cut.deps, ["x"]);

    const toks = await c.request("textDocument/semanticTokens/full", { textDocument: { uri: uri(file) } });
    const decoded = decodeTokens(toks.data);
    const lines = src.split("\n");
    const line = lines.findIndex((l) => l.includes("Server.now () + x"));
    const char = lines[line].lastIndexOf("x");
    const dep = decoded.find((t) => t.line === line && t.char === char && t.len === 1);
    assert.ok(dep, "the dependency reference is tokenized");
    assert.ok(hasMod(dep, legend, "dependency"), "the where-clause dependency is marked");
    assert.ok(hasMod(dep, legend, "client"), "it keeps the enclosing client function's colour");
    assert.ok(!hasMod(dep, legend, "cut1"), "it is not painted as a symbol owned by the cut");
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

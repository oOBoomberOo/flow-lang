import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Exercises the IDE surface of the language server: completion, navigation,
 * symbols, signature help, inlay hints, folding, highlights, formatting,
 * code actions, code lens, rename and multi-error diagnostics.
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

function startServer() {
  const proc = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
  return new Client(proc);
}

const uri = (file) => `file:///${path.resolve(file).replace(/\\/g, "/").replace(/^\/+/, "")}`;

function packageWith(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-lspf-"));
  fs.writeFileSync(path.join(root, "flow.json"), JSON.stringify({ name: "app", version: "0.1.0", dependencies: {} }));
  for (const [rel, src] of Object.entries(files)) {
    const f = path.join(root, "src", rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, src);
  }
  return { root, entry: path.join(root, "src", "main.flow") };
}

async function open(client, file) {
  const text = fs.readFileSync(file, "utf8");
  client.notify("textDocument/didOpen", {
    textDocument: { uri: uri(file), languageId: "flow", version: 1, text },
  });
  await client.waitFor((m) => m.method === "textDocument/publishDiagnostics");
  return text;
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

const MAIN = `use app::util::{tally, Report}

fn Label(props: { r: Report }) -> Html {
  html { <p>{props.r.title}</p> }
}

fn main() -> Html {
  let report = { title: "Stats", count: 3 };
  let total = tally([1, 2, 3]);
  html {
    <div>
      <Label r={report} />
      <p>{"total: "}{total}</p>
    </div>
  }
}
`;

const UTIL = `pub type Report = { title: Str, count: Int }

pub fn meaning() -> Int { 42 }

pub fn tally(xs: List<Int>) -> Int {
  match xs {
    [] => 0,
    [x, ..rest] => x + tally(rest),
  }
}
`;

test("lsp: completion offers keywords, locals, symbols and module members", async () => {
  const { entry, root } = packageWith({ "main.flow": MAIN, "util.flow": UTIL });
  fs.writeFileSync(path.join(root, "src", "uses.flow"), `use app::util::\nfn x() -> Int { 1 }\n`);
  const c = startServer();
  try {
    await c.request("initialize", { rootUri: null, capabilities: {} });
    const text = await open(c, entry);

    const atBody = pos(text, "let total", 0);
    const res = await c.request("textDocument/completion", { textDocument: { uri: uri(entry) }, position: atBody });
    const labels = res.items.map((i) => i.label);
    assert.ok(labels.includes("fn"), "keyword completion");
    assert.ok(labels.includes("html"), "keyword completion");
    assert.ok(labels.includes("tally"), "imported symbol completion");
    assert.ok(labels.includes("report"), "local completion");

    // field completion after a dot
    const atField = pos(text, "r.title", 2);
    const fields = await c.request("textDocument/completion", { textDocument: { uri: uri(entry) }, position: atField });
    assert.deepEqual(fields.items.map((i) => i.label).sort(), ["count", "title"]);

    // The item is visible without an import, and selecting it inserts the import.
    const hole = pos(text, "{total}", 1);
    const auto = await c.request("textDocument/completion", { textDocument: { uri: uri(entry) }, position: hole });
    const meaning = auto.items.find((i) => i.label === "meaning");
    assert.ok(meaning, "unimported package symbols are offered");
    assert.match(meaning.additionalTextEdits[0].newText, /use app::util::\{meaning\}/);

    // module members after ::
    const usesFile = path.join(root, "src", "uses.flow");
    const usesText = await open(c, usesFile);
    const atModule = pos(usesText, "use app::util::", 15);
    const members = await c.request("textDocument/completion", { textDocument: { uri: uri(usesFile) }, position: atModule });
    assert.ok(members.items.some((i) => i.label === "tally"));
    assert.ok(members.items.some((i) => i.label === "Report"));
  } finally { c.proc.kill(); }
});

test("lsp: definition, references, highlights and rename", async () => {
  const { entry, root } = packageWith({ "main.flow": MAIN, "util.flow": UTIL });
  const c = startServer();
  try {
    await c.request("initialize", { rootUri: null, capabilities: {} });
    const text = await open(c, entry);

    const atTally = pos(text, "tally([", 1);
    const def = await c.request("textDocument/definition", { textDocument: { uri: uri(entry) }, position: atTally });
    assert.ok(def, "definition found");
    assert.equal(path.basename(new URL(def.uri).pathname), "util.flow");
    assert.ok(def.range.start.line >= 2, "points at the declaration");

    const refs = await c.request("textDocument/references", {
      textDocument: { uri: uri(entry) }, position: atTally, context: { includeDeclaration: true },
    });
    assert.ok(refs.length >= 1);
    assert.ok(refs.some((r) => r.uri.endsWith("util.flow")), "reference in the other module");

    const hits = await c.request("textDocument/documentHighlight", { textDocument: { uri: uri(entry) }, position: atTally });
    assert.ok(hits.length >= 1);

    const prep = await c.request("textDocument/prepareRename", { textDocument: { uri: uri(entry) }, position: atTally });
    assert.ok(prep, "prepareRename");

    const ren = await c.request("textDocument/rename", {
      textDocument: { uri: uri(entry) }, position: atTally, newName: "sumUp",
    });
    const edits = Object.values(ren.changes).flat();
    assert.ok(edits.length >= 2, "renames every site");
    assert.ok(edits.every((e) => e.newText === "sumUp"));
  } finally { c.proc.kill(); }
});

test("lsp: symbols, signature help and inlay hints", async () => {
  const { entry, root } = packageWith({ "main.flow": MAIN, "util.flow": UTIL });
  const c = startServer();
  try {
    await c.request("initialize", { rootUri: null, capabilities: {} });
    const text = await open(c, entry);

    const syms = await c.request("textDocument/documentSymbol", { textDocument: { uri: uri(entry) } });
    assert.deepEqual(syms.map((s) => s.name).sort(), ["Label", "main"]);

    const all = await c.request("workspace/symbol", { query: "tally" });
    assert.ok(all.some((s) => s.name === "tally" && s.containerName === "app::util"));

    const atCall = pos(text, "tally([", 6);
    const sig = await c.request("textDocument/signatureHelp", { textDocument: { uri: uri(entry) }, position: atCall });
    assert.ok(sig, "signature help");
    assert.match(sig.signatures[0].label, /tally\(xs: List<Int>\) -> Int/);

    const hints = await c.request("textDocument/inlayHint", {
      textDocument: { uri: uri(entry) }, range: { start: { line: 0, character: 0 }, end: { line: 30, character: 0 } },
    });
    assert.ok(hints.some((h) => /client|server/.test(String(h.label))), "placement hint");
    const totalHint = hints.find((h) => String(h.label).includes(": Int"));
    assert.ok(totalHint, "let initializer gets its exact inferred type, not the callee type");
  } finally { c.proc.kill(); }
});

test("lsp: folding, selection ranges, formatting and code lens", async () => {
  const { entry, root } = packageWith({ "main.flow": MAIN, "util.flow": UTIL });
  const c = startServer();
  try {
    await c.request("initialize", { rootUri: null, capabilities: {} });
    const text = await open(c, entry);

    const folds = await c.request("textDocument/foldingRange", { textDocument: { uri: uri(entry) } });
    assert.ok(folds.length >= 2);
    assert.ok(folds.every((f) => f.endLine >= f.startLine));

    const sel = await c.request("textDocument/selectionRange", {
      textDocument: { uri: uri(entry) }, positions: [pos(text, "r={report}", 4)],
    });
    assert.ok(sel[0], "selection range");
    assert.ok(sel[0].parent, "nested selection range");

    const edits = await c.request("textDocument/formatting", {
      textDocument: { uri: uri(entry) }, options: { tabSize: 2, insertSpaces: true },
    });
    assert.equal(edits.length, 1);
    // formatting is idempotent
    const formatted = edits[0].newText;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-fmt-"));
    const f2 = path.join(dir, "main.flow");
    fs.writeFileSync(f2, formatted);
    await open(c, f2);
    const again = await c.request("textDocument/formatting", { textDocument: { uri: uri(f2) }, options: { tabSize: 2, insertSpaces: true } });
    assert.equal(again[0].newText, formatted, "formatting is stable");

    const lenses = await c.request("textDocument/codeLens", { textDocument: { uri: uri(entry) } });
    assert.ok(lenses.length >= 2, "a lens per function");
    assert.ok(lenses.some((l) => /cut/.test(l.command.title)));
  } finally { c.proc.kill(); }
});

test("lsp: code actions offer make-public and imports", async () => {
  const { entry, root } = packageWith({
    "main.flow": "use app::util::{tally}\nfn helper() -> Int { 1 }\nfn main() -> Html { html { <p>{str(tally([1]))}</p> } }\n",
    "util.flow": UTIL,
  });
  const c = startServer();
  try {
    await c.request("initialize", { rootUri: null, capabilities: {} });
    const text = await open(c, entry);

    const acts = await c.request("textDocument/codeAction", {
      textDocument: { uri: uri(entry) },
      range: { start: { line: 1, character: 3 }, end: { line: 1, character: 3 } },
      context: { diagnostics: [] },
    });
    assert.ok(acts.some((a) => /Make 'helper' public/.test(a.title)), "make public");

    // an unbound name suggests an import
    const bad = `fn main() -> Html { html { <p>{str(tally([1]))}</p> } }\n`;
    const f3 = path.join(root, "src", "third.flow");
    fs.writeFileSync(f3, bad);
    await open(c, f3);
    const fixes = await c.request("textDocument/codeAction", {
      textDocument: { uri: uri(f3) },
      range: { start: { line: 0, character: 30 }, end: { line: 0, character: 30 } },
      context: { diagnostics: [{ message: "unbound name 'tally'" }] },
    });
    const imp = fixes.find((a) => /Import 'tally'/.test(a.title));
    assert.ok(imp, "import quick fix; got: " + JSON.stringify(fixes.map((f) => f.title)));
    assert.match(Object.values(imp.edit.changes)[0][0].newText, /use app::util::\{tally\}/);
  } finally { c.proc.kill(); }
});

test("lsp: every type error is reported, not just the first", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "flow-multi-")), "main.flow");
  fs.writeFileSync(file, `fn a() -> Int { 1 + "x" }\nfn b() -> Int { true + 1 }\nfn main() -> Html { html { <p>{"ok"}</p> } }\n`);
  const c = startServer();
  try {
    await c.request("initialize", { rootUri: null, capabilities: {} });
    const text = fs.readFileSync(file, "utf8");
    c.notify("textDocument/didOpen", { textDocument: { uri: uri(file), languageId: "flow", version: 1, text } });
    const note = await c.waitFor((m) => m.method === "textDocument/publishDiagnostics");
    assert.equal(note.params.diagnostics.length, 2, `expected 2 diagnostics, got ${note.params.diagnostics.length}`);
    assert.ok(note.params.diagnostics.some((d) => /type mismatch/.test(d.message)));
  } finally { c.proc.kill(); }
});

test("lsp: markup completion offers tags, attributes and components", async () => {
  const { entry } = packageWith({ "main.flow": MAIN, "util.flow": UTIL });
  const c = startServer();
  try {
    await c.request("initialize", { rootUri: null, capabilities: {} });
    const text = await open(c, entry);

    const mk = (s) => {
      const lines = s.split("\n");
      const l = lines.findIndex((x) => x.includes("<div>"));
      return { line: l, character: lines[l].indexOf("<div>") };
    };
    const atTag = mk(text);
    const tags = await c.request("textDocument/completion", {
      textDocument: { uri: uri(entry) },
      position: { line: atTag.line, character: atTag.character + 1 },
    });
    assert.ok(tags.items.some((i) => i.label === "div"), "tag names");
    assert.ok(tags.items.some((i) => i.detail === "component"), "components are offered");

    const attrPos = pos(text, "<Label ", 7);
    const attrs = await c.request("textDocument/completion", { textDocument: { uri: uri(entry) }, position: attrPos });
    assert.ok(attrs.items.some((i) => i.label === "class"), "attributes");
    assert.ok(attrs.items.some((i) => i.label === "onClick"), "event attributes");
  } finally { c.proc.kill(); }
});

test("lsp: document links point at the imported module", async () => {
  const { entry } = packageWith({ "main.flow": MAIN, "util.flow": UTIL });
  const c = startServer();
  try {
    await c.request("initialize", { rootUri: null, capabilities: {} });
    await open(c, entry);
    const links = await c.request("textDocument/documentLink", { textDocument: { uri: uri(entry) } });
    assert.equal(links.length, 1);
    assert.ok(links[0].target.endsWith("util.flow"), links[0].target);
    assert.match(links[0].tooltip, /app::util/);
  } finally { c.proc.kill(); }
});

test("lsp: type definition resolves a named type", async () => {
  const { entry } = packageWith({
    "main.flow": `use app::util::{Priority, rank}
fn main() -> Html {
  let p = Priority(2);
  html { <p>{str(rank(p))}</p> }
}
`,
    "util.flow": `pub type Priority = Priority(Int)
pub fn rank(p: Priority) -> Int { match p { Priority(n) => n } }
`,
  });
  const c = startServer();
  try {
    await c.request("initialize", { rootUri: null, capabilities: {} });
    const text = await open(c, entry);
    const lines = text.split("\n");
    const l = lines.findIndex((x) => x.includes("rank(p)"));
    const at = { line: l, character: lines[l].indexOf("rank(p)") + 6 };
    const td = await c.request("textDocument/typeDefinition", { textDocument: { uri: uri(entry) }, position: at });
    assert.ok(td, "type definition");
    assert.ok(td.uri.endsWith("util.flow"));
    assert.match(text.split("\n")[0], /Priority/);
  } finally { c.proc.kill(); }
});

test("lsp: watched-file changes re-analyse the package", async () => {
  const { entry, root } = packageWith({ "main.flow": MAIN, "util.flow": UTIL });
  const c = startServer();
  try {
    await c.request("initialize", { rootUri: null, capabilities: {} });
    await open(c, entry);
    // break util.flow on disk, then notify as an editor would
    fs.writeFileSync(path.join(root, "src", "util.flow"), UTIL.replace("pub fn tally", "fn tally"));
    c.notify("workspace/didChangeWatchedFiles", {
      changes: [{ uri: uri(path.join(root, "src", "util.flow")), type: 2 }],
    });
    const note = await c.waitFor((m) =>
      m.method === "textDocument/publishDiagnostics" && m.params.diagnostics.length > 0);
    assert.match(note.params.diagnostics[0].message, /private in app::util/);
  } finally { c.proc.kill(); }
});

test("lsp: prelude primitives resolve into std, not a compiler builtin", async () => {
  const { entry } = packageWith({
    "main.flow": `fn main() -> Html { html { <p>{str(1)}{str(len([1, 2]))}{str(Some(3))}</p> } }\n`,
  });
  const c = startServer();
  try {
    await c.request("initialize", { rootUri: null, capabilities: {} });
    const text = await open(c, entry);
    for (const [needle, name] of [["str(1)", "str"], ["len(", "len"], ["Some(", "Some"]]) {
      const at = pos(text, needle, 1);
      const def = await c.request("textDocument/definition", { textDocument: { uri: uri(entry) }, position: at });
      assert.ok(def, `definition for ${name}`);
      assert.match(new URL(def.uri).pathname, /stdlib\/prelude\.flow$/, `${name} is std code`);
    }
  } finally { c.proc.kill(); }
});

test("lsp: unsafe extern declarations are first-class symbols", async () => {
  const { entry } = packageWith({
    "main.flow": `unsafe extern js fn hypot(a: Float, b: Float) -> Float = "Math.hypot"
fn main() -> Html { html { <p>{str(hypot(3.0, 4.0))}</p> } }
`,
  });
  const c = startServer();
  try {
    await c.request("initialize", { rootUri: null, capabilities: {} });
    const text = await open(c, entry);
    const at = pos(text, "hypot(3.0", 1);
    const def = await c.request("textDocument/definition", { textDocument: { uri: uri(entry) }, position: at });
    assert.ok(def, "definition found");
    assert.equal(path.basename(new URL(def.uri).pathname), "main.flow");
    assert.equal(def.range.start.line, 0);
    const syms = await c.request("textDocument/documentSymbol", { textDocument: { uri: uri(entry) } });
    assert.ok(syms.some((s) => s.name === "hypot"), "extern appears in the outline");
  } finally { c.proc.kill(); }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

/**
 * Loads the real VS Code extension against a mock `vscode` module, starts the
 * real language server, and checks that boundary decorations and diagnostics
 * actually arrive in the editor.
 */

const require = createRequire(import.meta.url);
const REPO = path.join(import.meta.dirname, "..");

function makeMock(workspaceRoot) {
  const handlers = {};
  const applied = [];
  const mockConfig = {
    clientColor: "rgba(80, 140, 255, 0.16)",
    serverColor: "rgba(255, 150, 60, 0.16)",
    cutColor: "rgba(190, 90, 255, 0.55)",
    enableDecorations: true,
    serverPath: "",
  };
  const statusBar = { text: "", tooltip: "", show() {}, dispose() {} };
  const decos = [];
  let diagnosticsSets = 0;

  const d = () => ({ dispose() {} });

  const mock = {
    StatusBarAlignment: { Left: 1, Right: 2 },
    OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    Range: class { constructor(a, b, c, e) { this.start = { line: a, character: b }; this.end = { line: c, character: e }; } },
    Position: class { constructor(line, character) { this.line = line; this.character = character; } },
    Uri: {
      parse: (s) => ({ toString: () => s, fsPath: s.replace(/^file:\/\/\//, "") }),
      file: (p) => ({ toString: () => `file:///${p.replace(/\\/g, "/").replace(/^\/+/, "")}`, fsPath: p }),
    },
    MarkdownString: class { constructor(v) { this.value = v; } },
    Hover: class { constructor(c, r) { this.contents = c; this.range = r; } },
    Diagnostic: class { constructor(r, m, s) { this.range = r; this.message = m; this.severity = s; } },
    window: {
      createOutputChannel: () => ({ appendLine() {}, clear() {}, show() {}, dispose() {} }),
      createStatusBarItem: () => statusBar,
      createTextEditorDecorationType: (opts) => { const t = { opts, dispose() {} }; decos.push(t); return t; },
      visibleTextEditors: [],
      onDidChangeVisibleTextEditors: (h) => { handlers.visible = h; return d(); },
      onDidChangeActiveTextEditor: (h) => { handlers.active = h; return d(); },
      showWarningMessage() {},
      showErrorMessage() {},
      setStatusBarMessage() {},
      activeTextEditor: undefined,
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: workspaceRoot, toString: () => "file:///" + workspaceRoot.replace(/\\/g, "/") } }],
      textDocuments: [],
      getConfiguration: () => ({
        get: (k, fallback) => mockConfig[k] ?? fallback,
      }),
      onDidOpenTextDocument: (h) => { handlers.open = h; return d(); },
      onDidChangeTextDocument: (h) => { handlers.change = h; return d(); },
      onDidSaveTextDocument: (h) => { handlers.save = h; return d(); },
      onDidCloseTextDocument: (h) => { handlers.close = h; return d(); },
      onDidChangeConfiguration: (h) => { handlers.config = h; return d(); },
    },
    languages: {
      createDiagnosticCollection: () => ({
        set: () => { diagnosticsSets++; },
        delete() {},
        dispose() {},
      }),
      registerHoverProvider: () => d(),
    },
    commands: { registerCommand: () => d() },
  };

  return { mock, handlers, applied, statusBar, decos, get diagnosticsSets() { return diagnosticsSets; } };
}

async function waitUntil(fn, ms = 8000, label = "condition") {
  const deadline = Date.now() + ms;
  for (;;) {
    if (fn()) return;
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const SRC = `effect Server { fn secret(k: Str) -> Str }
effect Client { fn state<a>(init: a) -> Cell<a> }

fn main() -> Html {
  let n = Client.state(0);
  html {
    <div>
      <p>{"n = "}{n.get()}</p>
      <p>{"s = "}{Server.secret("k")}</p>
    </div>
  }
}
`;

test("vscode: extension activates, drives the server and colours the boundary", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-vsc-"));
  const file = path.join(dir, "main.flow");
  fs.writeFileSync(file, SRC);

  const env = makeMock(REPO);
  const Module = require("node:module");
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "vscode") return env.mock;
    return origLoad.apply(this, arguments);
  };

  const extPath = path.join(REPO, "vscode-extension", "extension.js");
  delete require.cache[require.resolve(extPath)];
  const ext = require(extPath);

  try {
    const context = { subscriptions: [], extensionPath: path.join(REPO, "vscode-extension") };
    ext.activate(context);

    // the status bar starts neutral and updates after analysis
    assert.ok(env.statusBar.text.startsWith("$(radio-tower)"));

    const doc = {
      languageId: "flow",
      uri: env.mock.Uri.file(file),
      version: 1,
      getText: () => SRC,
    };
    const editor = {
      document: doc,
      setDecorations(type, list) { env.applied.push({ type, list }); },
    };
    env.mock.window.visibleTextEditors.push(editor);

    // open the document, as VS Code would
    await waitUntil(() => typeof env.handlers.open === "function", 3000, "open handler");
    env.handlers.open(doc);

    await waitUntil(() => /cuts \d+/.test(env.statusBar.text), 8000, "boundary summary");

    const counts = env.applied.map((a) => a.list.length);
    assert.ok(counts.some((n) => n > 0), `decorations applied (got ${JSON.stringify(counts)})`);

    const serverPaint = env.applied.filter((a) => a.list.length && a.list.some((x) => x.hoverMessage));
    assert.ok(serverPaint.length > 0, "regions carry labels");

    // the client decoration type and the server decoration type are distinct colours
    assert.equal(env.decos.length, 3, "client, server and cut decoration types");
    assert.notEqual(env.decos[0].opts.backgroundColor, env.decos[1].opts.backgroundColor);
  } finally {
    ext.deactivate();
    Module._load = origLoad;
  }
});

test("vscode: extension reports type errors through diagnostics", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-vsc-"));
  const file = path.join(dir, "main.flow");
  const bad = `fn main() -> Html { html { <p>{1 + "x"}</p> } }\n`;
  fs.writeFileSync(file, bad);

  const env = makeMock(REPO);
  const Module = require("node:module");
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === "vscode") return env.mock;
    return origLoad.apply(this, arguments);
  };
  const extPath = path.join(REPO, "vscode-extension", "extension.js");
  delete require.cache[require.resolve(extPath)];
  const ext = require(extPath);

  try {
    ext.activate({ subscriptions: [], extensionPath: path.join(REPO, "vscode-extension") });
    await waitUntil(() => typeof env.handlers.open === "function", 3000, "open handler");
    env.handlers.open({ languageId: "flow", uri: env.mock.Uri.file(file), version: 1, getText: () => bad });
    await waitUntil(() => env.diagnosticsSets > 0, 8000, "diagnostics pushed");
    assert.ok(env.diagnosticsSets > 0);
  } finally {
    ext.deactivate();
    Module._load = origLoad;
  }
});

test("vscode: package.json and grammar are valid and complete", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "vscode-extension", "package.json"), "utf8"));
  assert.equal(pkg.main, "./extension.js");
  assert.ok(pkg.engines.vscode);
  assert.equal(pkg.contributes.languages[0].id, "flow");
  assert.deepEqual(pkg.contributes.languages[0].extensions, [".flow"]);
  assert.ok(fs.existsSync(path.join(REPO, "vscode-extension", pkg.contributes.grammars[0].path)));

  const grammar = JSON.parse(fs.readFileSync(path.join(REPO, "vscode-extension", "syntaxes", "flow.tmLanguage.json"), "utf8"));
  assert.equal(grammar.scopeName, "source.flow");
  const names = Object.keys(grammar.repository);
  for (const need of ["comments", "strings", "numbers", "keywords", "types", "html", "declarations", "imports"]) {
    assert.ok(names.includes(need), `grammar repository has ${need}`);
  }
  // every regex must compile
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (o && typeof o === "object") {
      for (const [k, v] of Object.entries(o)) {
        if ((k === "match" || k === "begin" || k === "end") && typeof v === "string") {
          assert.doesNotThrow(() => new RegExp(v), `regex ${v}`);
        } else walk(v);
      }
    }
  };
  walk(grammar);
});

test("vscode: extension.js parses as CommonJS", async () => {
  const { execFileSync } = await import("node:child_process");
  const extPath = path.join(REPO, "vscode-extension", "extension.js");
  assert.doesNotThrow(() => execFileSync(process.execPath, ["--check", extPath], { stdio: "pipe" }));
});

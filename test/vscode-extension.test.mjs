import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

/**
 * Loads the real VS Code extension against a mock `vscode` module, starts the
 * real language server, and checks that the editor-facing surface works:
 * decorations, diagnostics and every registered provider.
 */

const require = createRequire(import.meta.url);
const REPO = path.join(import.meta.dirname, "..");

function makeMock(workspaceRoot) {
  const handlers = {};
  const applied = [];
  const registered = [];
  const statusBar = { text: "", tooltip: "", show() {}, dispose() {} };
  const decos = [];
  const commands = [];
  let diagnosticsSets = 0;

  const d = () => ({ dispose() {} });
  class Stub { constructor(...args) { this.args = args; Object.assign(this, args.length && typeof args[0] === "object" ? args[0] : {}); } }

  const mockConfig = {
    clientColor: "rgba(80, 140, 255, 0.16)",
    serverColor: "rgba(255, 150, 60, 0.16)",
    cutColor: "rgba(190, 90, 255, 0.55)",
    enableDecorations: true,
    serverPath: "",
  };

  const mock = {
    StatusBarAlignment: { Left: 1, Right: 2 },
    OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    SymbolKind: { File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5, Property: 6, Field: 7,
      Constructor: 8, Enum: 9, Interface: 10, Function: 11, Variable: 12, Constant: 13, String: 14, Number: 15,
      Boolean: 16, Array: 17, Object: 18, Key: 19, Null: 20, EnumMember: 21, Struct: 22, Event: 23,
      Operator: 24, TypeParameter: 25 },
    CompletionItemKind: { Text: 0, Method: 1, Function: 2, Constructor: 3, Field: 4, Variable: 5, Class: 6,
      Interface: 7, Module: 8, Property: 9, Unit: 10, Value: 11, Enum: 12, Keyword: 13, Snippet: 14, Color: 15,
      File: 16, Reference: 17, Folder: 18, EnumMember: 19, Constant: 20, Struct: 21, Event: 22, Operator: 23,
      TypeParameter: 24 },
    CodeActionKind: { QuickFix: "quickfix", Refactor: "refactor", RefactorRewrite: "refactor.rewrite", Source: "source" },
    Range: class { constructor(a, b, c, e) { this.start = { line: a, character: b }; this.end = { line: c, character: e }; } },
    Position: class { constructor(line, character) { this.line = line; this.character = character; } },
    Uri: {
      parse: (s) => ({ toString: () => s, fsPath: s.replace(/^file:\/\/\//, "") }),
      file: (p) => ({ toString: () => `file:///${p.replace(/\\/g, "/").replace(/^\/+/, "")}`, fsPath: p }),
    },
    MarkdownString: class { constructor(v) { this.value = v; } },
    Hover: class { constructor(c, r) { this.contents = c; this.range = r; } },
    Diagnostic: class { constructor(r, m, s) { this.range = r; this.message = m; this.severity = s; } },
    Location: class { constructor(uri, range) { this.uri = uri; this.range = range; } },
    SymbolInformation: class { constructor(name, kind, containerName, location) { Object.assign(this, { name, kind, containerName, location }); } },
    DocumentSymbol: class { constructor(name, detail, kind, range, selectionRange) { Object.assign(this, { name, detail, kind, range, selectionRange }); } },
    CompletionItem: class { constructor(label, kind) { this.label = label; this.kind = kind; } },
    CompletionList: class { constructor(items, isIncomplete) { this.items = items; this.isIncomplete = isIncomplete; } },
    SignatureHelp: class { constructor() { this.signatures = []; this.activeSignature = 0; this.activeParameter = 0; } },
    SignatureInformation: class { constructor(label, doc) { this.label = label; this.documentation = doc; this.parameters = []; } },
    ParameterInformation: class { constructor(label) { this.label = label; } },
    InlayHint: class { constructor(position, label, kind) { Object.assign(this, { position, label, kind }); } },
    FoldingRange: class { constructor(startLine, endLine, kind) { Object.assign(this, { startLine, endLine, kind }); } },
    SelectionRange: class { constructor(range, parent) { this.range = range; this.parent = parent; } },
    DocumentHighlight: class { constructor(range, kind) { this.range = range; this.kind = kind; } },
    TextEdit: class { static replace(range, newText) { return { range, newText }; } },
    CodeAction: class { constructor(title, kind) { this.title = title; this.kind = kind; } },
    CodeLens: class { constructor(range, command) { this.range = range; this.command = command; } },
    DocumentLink: class { constructor(range, target) { this.range = range; this.target = target; } },
    WorkspaceEdit: class { constructor() { this.edits = []; } replace(uri, range, newText) { this.edits.push({ uri, range, newText }); } },
    window: {
      createOutputChannel: () => ({ appendLine() {}, clear() {}, show() {}, dispose() {} }),
      createStatusBarItem: () => statusBar,
      createTextEditorDecorationType: (opts) => { const t = { opts, dispose() {} }; decos.push(t); return t; },
      visibleTextEditors: [],
      onDidChangeVisibleTextEditors: (h) => { handlers.visible = h; return d(); },
      onDidChangeActiveTextEditor: (h) => { handlers.active = h; return d(); },
      showWarningMessage() {},
      showErrorMessage(msg) { handlers.lastError = msg; },
      showInformationMessage() {},
      setStatusBarMessage() {},
      activeTextEditor: undefined,
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: workspaceRoot, toString: () => "file:///" + workspaceRoot.replace(/\\/g, "/") } }],
      textDocuments: [],
      getConfiguration: () => ({ get: (k, fallback) => mockConfig[k] ?? fallback }),
      onDidOpenTextDocument: (h) => { handlers.open = h; return d(); },
      onDidChangeTextDocument: (h) => { handlers.change = h; return d(); },
      onDidSaveTextDocument: (h) => { handlers.save = h; return d(); },
      onDidCloseTextDocument: (h) => { handlers.close = h; return d(); },
      onDidChangeConfiguration: (h) => { handlers.config = h; return d(); },
      createFileSystemWatcher: () => ({ onDidChange: () => d(), onDidCreate: () => d(), onDidDelete: () => d(), dispose() {} }),
    },
    languages: {
      createDiagnosticCollection: () => ({ set: () => { diagnosticsSets++; }, delete() {}, dispose() {} }),
      registerHoverProvider: (_l, p) => { registered.push(["hover", p]); return d(); },
      registerCompletionItemProvider: (_l, p, ...t) => { registered.push(["completion", p, t]); return d(); },
      registerDefinitionProvider: (_l, p) => { registered.push(["definition", p]); return d(); },
      registerReferenceProvider: (_l, p) => { registered.push(["references", p]); return d(); },
      registerDocumentSymbolProvider: (_l, p) => { registered.push(["documentSymbol", p]); return d(); },
      registerWorkspaceSymbolProvider: (p) => { registered.push(["workspaceSymbol", p]); return d(); },
      registerSignatureHelpProvider: (_l, p) => { registered.push(["signatureHelp", p]); return d(); },
      registerInlayHintsProvider: (_l, p) => { registered.push(["inlayHint", p]); return d(); },
      registerFoldingRangeProvider: (_l, p) => { registered.push(["foldingRange", p]); return d(); },
      registerSelectionRangeProvider: (_l, p) => { registered.push(["selectionRange", p]); return d(); },
      registerDocumentHighlightProvider: (_l, p) => { registered.push(["documentHighlight", p]); return d(); },
      registerDocumentLinkProvider: (_l, p) => { registered.push(["documentLink", p]); return d(); },
      registerTypeDefinitionProvider: (_l, p) => { registered.push(["typeDefinition", p]); return d(); },
      registerDocumentFormattingEditProvider: (_l, p) => { registered.push(["formatting", p]); return d(); },
      registerCodeActionsProvider: (_l, p, m) => { registered.push(["codeAction", p, m]); return d(); },
      registerCodeLensProvider: (_l, p) => { registered.push(["codeLens", p]); return d(); },
      registerRenameProvider: (_l, p) => { registered.push(["rename", p]); return d(); },
    },
    commands: { registerCommand: (name, fn) => { commands.push([name, fn]); return d(); } },
  };

  return {
    mock, handlers, applied, statusBar, decos, registered, commands,
    get diagnosticsSets() { return diagnosticsSets; },
  };
}

async function waitUntil(fn, ms = 8000, label = "condition") {
  const deadline = Date.now() + ms;
  for (;;) {
    if (fn()) return;
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function loadExtension(env) {
  const Module = require("node:module");
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === "vscode") return env.mock;
    return origLoad.apply(this, arguments);
  };
  const extPath = path.join(REPO, "vscode-extension", "extension.js");
  delete require.cache[require.resolve(extPath)];
  const ext = require(extPath);
  return { ext, restore: () => { Module._load = origLoad; } };
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

test("vscode: activates, drives the server and colours the boundary", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-vsc-"));
  const file = path.join(dir, "main.flow");
  fs.writeFileSync(file, SRC);

  const env = makeMock(REPO);
  const { ext, restore } = loadExtension(env);
  try {
    ext.activate({ subscriptions: [], extensionPath: path.join(REPO, "vscode-extension") });
    const doc = { languageId: "flow", uri: env.mock.Uri.file(file), version: 1, getText: () => SRC };
    const editor = { document: doc, setDecorations(type, list) { env.applied.push({ type, list }); } };
    env.mock.window.visibleTextEditors.push(editor);

    await waitUntil(() => typeof env.handlers.open === "function", 3000, "open handler");
    env.handlers.open(doc);
    await waitUntil(() => /cuts \d+/.test(env.statusBar.text), 8000, "boundary summary");

    assert.ok(env.applied.some((a) => a.list.length > 0), "decorations applied");
    assert.equal(env.decos.length, 3, "client, server and cut decoration types");
    assert.notEqual(env.decos[0].opts.backgroundColor, env.decos[1].opts.backgroundColor);

    // every provider the server implements is registered with VS Code
    const names = env.registered.map((r) => r[0]).sort();
    assert.deepEqual(names, [
      "codeAction", "codeLens", "completion", "definition", "documentHighlight", "documentLink",
      "documentSymbol", "foldingRange", "formatting", "hover", "inlayHint",
      "references", "rename", "selectionRange", "signatureHelp", "typeDefinition", "workspaceSymbol",
    ]);
  } finally {
    ext.deactivate();
    restore();
  }
});

test("vscode: providers return real results from the server", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-vsc-"));
  const file = path.join(dir, "main.flow");
  fs.writeFileSync(file, SRC);

  const env = makeMock(REPO);
  const { ext, restore } = loadExtension(env);
  try {
    ext.activate({ subscriptions: [], extensionPath: path.join(REPO, "vscode-extension") });
    const doc = { languageId: "flow", uri: env.mock.Uri.file(file), version: 1, getText: () => SRC };
    env.handlers.open(doc);
    await waitUntil(() => env.registered.length >= 15, 5000, "providers");
    await new Promise((r) => setTimeout(r, 300));

    const provider = (name) => env.registered.find((r) => r[0] === name)[1];
    const at = (needle, extra = 1) => {
      const lines = SRC.split("\n");
      const l = lines.findIndex((x) => x.includes(needle));
      return new env.mock.Position(l, lines[l].indexOf(needle) + extra);
    };

    const symbols = await provider("documentSymbol").provideDocumentSymbols(doc);
    assert.ok(symbols.some((s) => s.name === "main"), "document symbols");

    const hints = await provider("inlayHint").provideInlayHints(doc, new env.mock.Range(0, 0, 40, 0));
    assert.ok(hints.some((h) => String(h.label).includes("client")), "placement hint");

    const hover = await provider("hover").provideHover(doc, at("Server.secret"));
    assert.ok(hover && /Placement/.test(hover.contents.value), "hover");

    const completion = await provider("completion").provideCompletionItems(doc, at("html {", 6));
    assert.ok(completion.items.length > 10, "completion items");

    const lenses = await provider("codeLens").provideCodeLenses(doc);
    assert.ok(lenses.length >= 1, "code lenses");

    const edits = await provider("formatting").provideDocumentFormattingEdits(doc);
    assert.ok(edits.length >= 1, "formatting edits");
  } finally {
    ext.deactivate();
    restore();
  }
});

test("vscode: completion carries auto-import edits and module links", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-vsc-mod-"));
  fs.writeFileSync(path.join(dir, "flow.json"), JSON.stringify({ name: "app", version: "0.1.0", dependencies: {} }));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  const source = `use app::util::known
fn main() -> Html {
  html { <p>{str(known())}{str(meaning())}</p> }
}
`;
  fs.writeFileSync(path.join(dir, "src", "main.flow"), source);
  fs.writeFileSync(path.join(dir, "src", "util.flow"), `pub fn known() -> Int { 1 }\npub fn meaning() -> Int { 42 }\n`);

  const env = makeMock(REPO);
  const { ext, restore } = loadExtension(env);
  try {
    ext.activate({ subscriptions: [], extensionPath: path.join(REPO, "vscode-extension") });
    const file = path.join(dir, "src", "main.flow");
    const doc = { languageId: "flow", uri: env.mock.Uri.file(file), version: 1, getText: () => source };
    await waitUntil(() => typeof env.handlers.open === "function", 3000, "open handler");
    env.handlers.open(doc);
    await waitUntil(() => env.registered.some((r) => r[0] === "documentLink"), 3000, "providers");
    await new Promise((r) => setTimeout(r, 250));

    const provider = (name) => env.registered.find((r) => r[0] === name)[1];
    const line = source.split("\n").findIndex((l) => l.includes("meaning()"));
    const character = source.split("\n")[line].indexOf("meaning") + 3;
    const completion = await provider("completion").provideCompletionItems(doc, new env.mock.Position(line, character));
    const item = completion.items.find((i) => i.label === "meaning");
    assert.ok(item, "unimported package symbol is suggested");
    assert.equal(item.additionalTextEdits.length, 1);
    assert.match(item.additionalTextEdits[0].newText, /use app::util::\{meaning\}/);

    const links = await provider("documentLink").provideDocumentLinks(doc);
    assert.ok(links.some((l) => l.target.fsPath.endsWith("util.flow")), "import becomes clickable link");
  } finally {
    ext.deactivate();
    restore();
  }
});

test("vscode: extension reports type errors through diagnostics", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-vsc-"));
  const file = path.join(dir, "main.flow");
  const bad = `fn main() -> Html { html { <p>{1 + "x"}</p> } }\n`;
  fs.writeFileSync(file, bad);

  const env = makeMock(REPO);
  const { ext, restore } = loadExtension(env);
  try {
    ext.activate({ subscriptions: [], extensionPath: path.join(REPO, "vscode-extension") });
    await waitUntil(() => typeof env.handlers.open === "function", 3000, "open handler");
    env.handlers.open({ languageId: "flow", uri: env.mock.Uri.file(file), version: 1, getText: () => bad });
    await waitUntil(() => env.diagnosticsSets > 0, 8000, "diagnostics pushed");
  } finally {
    ext.deactivate();
    restore();
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
  for (const need of ["comments", "strings", "numbers", "keywords", "types", "html", "declarations", "imports"]) {
    assert.ok(Object.keys(grammar.repository).includes(need), `grammar has ${need}`);
  }
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

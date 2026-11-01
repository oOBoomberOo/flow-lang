import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { CUT_PALETTE_SIZE, SEMANTIC_LEGEND } from "../src/lsp/semantic.ts";

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
  const outputLines = [];
  const statusMessages = [];
  const watchers = [];
  const appliedEdits = [];
  let diagnosticsSets = 0;

  const d = () => ({ dispose() {} });
  class Stub { constructor(...args) { this.args = args; Object.assign(this, args.length && typeof args[0] === "object" ? args[0] : {}); } }

  const mockConfig = {
    clientColor: "rgba(80, 140, 255, 0.16)",
    serverColor: "rgba(255, 150, 60, 0.16)",
    cutColor: "rgba(190, 90, 255, 0.55)",
    cutInColor: "rgba(90, 168, 255, 0.6)",
    crossingColor: "rgba(176, 176, 176, 0.7)",
    enableDecorations: true,
    serverPath: "",
    useWorkspaceServer: true,
    devWatch: true,
  };

  class RelativePattern {
    constructor(base, pattern) { this.base = typeof base === "string" ? base : base?.fsPath; this.pattern = pattern; }
  }

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
    Range: class { constructor(a, b, c, e) {
      if (a && typeof a === "object") { this.start = a; this.end = b; }
      else { this.start = { line: a, character: b }; this.end = { line: c, character: e }; }
    } },
    Position: class { constructor(line, character) { this.line = line; this.character = character; } },
    RelativePattern,
    Uri: {
      parse: (s) => ({ toString: () => s, fsPath: s.replace(/^file:\/\/\//, "") }),
      file: (p) => ({ toString: () => `file:///${p.replace(/\\/g, "/").replace(/^\/+/, "")}`, fsPath: p }),
    },
    MarkdownString: class {
      constructor(v) { this.value = v; this.isTrusted = false; }
      appendMarkdown(v) { this.value = (this.value ?? "") + v; return this; }
      appendText(v) { this.value = (this.value ?? "") + v; return this; }
    },
    Hover: class { constructor(c, r) { this.contents = c; this.range = r; } },
    Diagnostic: class { constructor(r, m, s) { this.range = r; this.message = m; this.severity = s; } },
    Location: class { constructor(uri, range) { this.uri = uri; this.range = range; } },
    SymbolInformation: class { constructor(name, kind, containerName, location) { Object.assign(this, { name, kind, containerName, location }); } },
    DocumentSymbol: class { constructor(name, detail, kind, range, selectionRange) { Object.assign(this, { name, detail, kind, range, selectionRange }); } },
    CompletionItem: class { constructor(label, kind) { this.label = label; this.kind = kind; } },
    SnippetString: class { constructor(value) { this.value = value; } },
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
    WorkspaceEdit: class {
      constructor() { this.edits = []; }
      replace(uri, range, newText) { this.edits.push({ uri, range, newText }); }
      insert(uri, position, newText) { this.edits.push({ uri, range: { start: position, end: position }, newText }); }
    },
    SemanticTokens: class { constructor(data, resultId) { this.data = data; this.resultId = resultId; } },
    EventEmitter: class {
      constructor() {
        this.listeners = [];
        this.event = (listener) => { this.listeners.push(listener); return d(); };
      }
      fire() { for (const listener of this.listeners) listener(); }
      dispose() { this.listeners.length = 0; }
    },
    window: {
      createOutputChannel: () => ({ appendLine: (line) => outputLines.push(line), clear() { outputLines.length = 0; }, show() {}, dispose() {} }),
      createStatusBarItem: () => statusBar,
      createTextEditorDecorationType: (opts) => { const t = { opts, dispose() {} }; decos.push(t); return t; },
      visibleTextEditors: [],
      onDidChangeVisibleTextEditors: (h) => { handlers.visible = h; return d(); },
      onDidChangeActiveTextEditor: (h) => { handlers.active = h; return d(); },
      showWarningMessage() {},
      showErrorMessage(msg) { handlers.lastError = msg; },
      showInformationMessage() {},
      setStatusBarMessage(msg) { statusMessages.push(msg); },
      activeTextEditor: undefined,
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: workspaceRoot, toString: () => "file:///" + workspaceRoot.replace(/\\/g, "/") } }],
      textDocuments: [],
      getConfiguration: () => ({ get: (k, fallback) => mockConfig[k] ?? fallback }),
      applyEdit: (edit) => { appliedEdits.push(...edit.edits); return true; },
      onDidOpenTextDocument: (h) => { handlers.open = h; return d(); },
      onDidChangeTextDocument: (h) => { handlers.change = h; return d(); },
      onDidSaveTextDocument: (h) => { handlers.save = h; return d(); },
      onDidCloseTextDocument: (h) => { handlers.close = h; return d(); },
      onDidChangeConfiguration: (h) => { handlers.config = h; return d(); },
      createFileSystemWatcher: (pattern) => {
        const watcher = {
          pattern,
          handlers: { change: [], create: [], delete: [] },
          onDidChange(h) { watcher.handlers.change.push(h); return d(); },
          onDidCreate(h) { watcher.handlers.create.push(h); return d(); },
          onDidDelete(h) { watcher.handlers.delete.push(h); return d(); },
          dispose() { watcher.disposed = true; },
          fire(type, uri) { for (const h of watcher.handlers[type]) h(uri); },
        };
        watchers.push(watcher);
        return watcher;
      },
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
      registerOnTypeFormattingEditProvider: (_l, p, ...triggers) => { registered.push(["onTypeFormatting", p, triggers]); return d(); },
      registerFoldingRangeProvider: (_l, p) => { registered.push(["foldingRange", p]); return d(); },
      registerSelectionRangeProvider: (_l, p) => { registered.push(["selectionRange", p]); return d(); },
      registerDocumentHighlightProvider: (_l, p) => { registered.push(["documentHighlight", p]); return d(); },
      registerDocumentLinkProvider: (_l, p) => { registered.push(["documentLink", p]); return d(); },
      registerTypeDefinitionProvider: (_l, p) => { registered.push(["typeDefinition", p]); return d(); },
      registerDocumentFormattingEditProvider: (_l, p) => { registered.push(["formatting", p]); return d(); },
      registerCodeActionsProvider: (_l, p, m) => { registered.push(["codeAction", p, m]); return d(); },
      registerCodeLensProvider: (_l, p) => { registered.push(["codeLens", p]); return d(); },
      registerRenameProvider: (_l, p) => { registered.push(["rename", p]); return d(); },
      registerDocumentSemanticTokensProvider: (_l, p, legend) => { registered.push(["semanticTokens", p, legend]); return d(); },
    },
    commands: { registerCommand: (name, fn) => { commands.push([name, fn]); return d(); } },
  };

  return {
    mock, handlers, applied, appliedEdits, statusBar, decos, registered, commands, watchers, outputLines, statusMessages,
    config: mockConfig,
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

const SRC = `
main :: Html
main = do
  let n = Client.state 0
  <div>
    <p>{"n = "} {n.get ()}</p>
    <p>{"s = "} {str (Server.now ())}</p>
  </div>
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
    assert.equal(env.decos.length, 25, "server/client marker for each of 12 palette slots, plus crossing");
    assert.ok(env.decos[0].opts.gutterIconPath, "cuts get a gutter marker");
    assert.notEqual(env.decos[0].opts.borderColor, env.decos[2].opts.borderColor, "each cut slot has its own colour");
    assert.equal(env.decos[0].opts.overviewRulerLane, env.mock.OverviewRulerLane.Center);

    // every provider the server implements is registered with VS Code
    await waitUntil(() => env.registered.some((r) => r[0] === "semanticTokens"), 8000, "semantic tokens");
    const names = [...new Set(env.registered.map((r) => r[0]))].sort();
    assert.deepEqual(names, [
      "codeAction", "codeLens", "completion", "definition", "documentHighlight", "documentLink",
      "documentSymbol", "foldingRange", "formatting", "hover", "inlayHint",
      "onTypeFormatting", "references", "rename", "selectionRange", "semanticTokens",
      "signatureHelp", "typeDefinition", "workspaceSymbol",
    ]);
    const commandNames = env.commands.map(([name]) => name);
    for (const name of ["flow.importSymbol", "flow.moveSymbol", "flow.organizeImports"]) {
      assert.ok(commandNames.includes(name), `registers ${name}`);
    }
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

    const hover = await provider("hover").provideHover(doc, at("Server.now"));
    assert.ok(hover && /Inferred cut/.test(hover.contents.value), "hover on a cut shows boundary details");
    assert.match(hover.contents.value, /client→server/);

    const plain = await provider("hover").provideHover(doc, at("n.get", 2));
    assert.ok(plain && /Placement/.test(plain.contents.value), "hover on ordinary code shows placement");

    const completion = await provider("completion").provideCompletionItems(doc, at("<p>", 2));
    assert.ok(completion.items.length > 2, "completion items");

    const lenses = await provider("codeLens").provideCodeLenses(doc);
    assert.ok(lenses.length >= 1, "code lenses");

    const edits = await provider("formatting").provideDocumentFormattingEdits(doc);
    assert.ok(edits.length >= 1, "formatting edits");

    const sem = env.registered.find((r) => r[0] === "semanticTokens");
    assert.ok(sem, "semantic token provider registered");
    const tokens = await sem[1].provideDocumentSemanticTokens(doc);
    assert.ok(tokens.data.length > 0 && tokens.data.length % 5 === 0, "semantic tokens are returned");
    assert.ok(sem[2].tokenModifiers.includes("client"), "legend carries the client modifier");
    assert.ok(sem[2].tokenModifiers.includes("cut1"), "legend carries the cut palette");

    const onType = env.registered.find((r) => r[0] === "onTypeFormatting");
    assert.ok(onType, "on-type formatting provider registered");
    assert.deepEqual(onType[2], [">", "/"], "typing > (and /) asks the server for tag edits");
  } finally {
    ext.deactivate();
    restore();
  }
});

test("vscode: completion carries auto-import edits and module links", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-vsc-mod-"));
  fs.writeFileSync(path.join(dir, "flow.json"), JSON.stringify({ name: "app", version: "0.1.0", dependencies: {} }));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  const source = `import Util (known)

main :: Html
main = <p>{str (known ())} {str (meaning ())}</p>
`;
  fs.writeFileSync(path.join(dir, "src", "main.flow"), source);
  fs.writeFileSync(path.join(dir, "src", "util.flow"), `known :: () -> Int
known () = 1

meaning :: () -> Int
meaning () = 42
`);

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
    const line = source.split("\n").findIndex((l) => l.includes("meaning ()"));
    const character = source.split("\n")[line].indexOf("meaning") + 3;
    const completion = await provider("completion").provideCompletionItems(doc, new env.mock.Position(line, character));
    const item = completion.items.find((i) => i.label === "meaning");
    assert.ok(item, "unimported package symbol is suggested");
    assert.equal(item.additionalTextEdits.length, 1);
    assert.match(item.additionalTextEdits[0].newText, /import Util \(meaning\)/);

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
  const bad = `main :: Html
main = <p>{1 + "x"}</p>
`;
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
  for (const key of ["flow.serverPath", "flow.useWorkspaceServer", "flow.devWatch", "flow.enableDecorations"]) {
    assert.ok(pkg.contributes.configuration.properties[key], `contributes ${key}`);
  }
  assert.equal(pkg.configurationDefaults["editor.semanticHighlighting.enabled"], true, "semantic highlighting is enabled by default");
  assert.equal(pkg.configurationDefaults["[flow]"]["editor.quickSuggestions"].other, true, "suggestions appear as you type");
  assert.equal(pkg.configurationDefaults["[flow]"]["editor.formatOnType"], true, "tag closing runs on type");
  assert.equal(pkg.configurationDefaults["[flow]"]["editor.inlayHints.enabled"], "on", "inlay hints are visible");
  const restart = pkg.contributes.commands.find((c) => c.command === "flow.restart");
  assert.ok(restart, "Flow: Restart Language Server is contributed");
  for (const command of ["flow.importSymbol", "flow.moveSymbol", "flow.organizeImports"]) {
    assert.ok(pkg.contributes.commands.some((c) => c.command === command), `contributes ${command}`);
  }

  const language = JSON.parse(fs.readFileSync(path.join(REPO, "vscode-extension", "language-configuration.json"), "utf8"));
  assert.equal(language.comments.lineComment, "--");
  assert.deepEqual(language.comments.blockComment, ["{-", "-}"]);
  const pairs = language.autoClosingPairs.map((p) => p.open);
  for (const open of ["{", "[", "(", "\""]) {
    assert.ok(pairs.includes(open), `auto-closes ${open}`);
  }
  assert.ok(Array.isArray(language.onEnterRules) && language.onEnterRules.length >= 2, "markup and layout enter rules");
  assert.ok(language.indentationRules.increaseIndentPattern, "indentation rules");

  const grammar = JSON.parse(fs.readFileSync(path.join(REPO, "vscode-extension", "syntaxes", "flow.tmLanguage.json"), "utf8"));
  assert.equal(grammar.scopeName, "source.flow");
  for (const need of ["comments", "strings", "numbers", "keywords", "html", "declarations", "imports", "signatures", "module"]) {
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

test("vscode: completion syncs the current document text before asking", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-vsc-sync-"));
  fs.writeFileSync(path.join(dir, "flow.json"), JSON.stringify({ name: "app", version: "0.1.0", dependencies: {} }));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  const file = path.join(dir, "src", "main.flow");
  const oldText = `main :: Html
main = <p>{"old"}</p>
`;
  fs.writeFileSync(file, oldText);

  const env = makeMock(REPO);
  const { ext, restore } = loadExtension(env);
  try {
    ext.activate({ subscriptions: [], extensionPath: path.join(REPO, "vscode-extension") });
    const uri = env.mock.Uri.file(file);
    const opened = { languageId: "flow", uri, version: 1, getText: () => oldText };
    env.handlers.open(opened);
    await waitUntil(() => env.registered.length >= 15, 5000, "providers");
    await new Promise((r) => setTimeout(r, 300));

    // The user has typed a new line, but no didChange event has fired yet in
    // this test: the provider itself must send the current text to the server.
    const changedText = `main :: Html
main = 
  Time.
`;
    const changed = { languageId: "flow", uri, version: 2, getText: () => changedText };
    const provider = env.registered.find((r) => r[0] === "completion")[1];
    const res = await provider.provideCompletionItems(changed, new env.mock.Position(2, 7));
    const labels = res.items.map((i) => i.label);
    assert.ok(labels.includes("now"), "Time members are offered");
    assert.ok(!labels.includes("Ok") && !labels.includes("padLeft"), "only Time members are offered");
    assert.ok(!labels.includes("host_now"), "private Time helpers are not offered");
  } finally {
    ext.deactivate();
    restore();
  }
});

test("vscode: switching editors reanalyses the newly active file", async () => {
  const mkPkg = (name, source) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `flow-vsc-${name}-`));
    fs.writeFileSync(path.join(dir, "flow.json"), JSON.stringify({ name, version: "0.1.0", dependencies: {} }));
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    const file = path.join(dir, "src", "main.flow");
    fs.writeFileSync(file, source);
    return { dir, file };
  };
  const a = mkPkg("appa", `main :: Html
main = <p>{str (Server.now ())}</p>
`);
  const b = mkPkg("appb", `main :: Html
main = <p>{str (Server.now ())} {str (Server.now ())} {str (Server.now ())}</p>
`);

  const env = makeMock(REPO);
  const { ext, restore } = loadExtension(env);
  try {
    ext.activate({ subscriptions: [], extensionPath: path.join(REPO, "vscode-extension") });
    const docA = { languageId: "flow", uri: env.mock.Uri.file(a.file), version: 1, getText: () => fs.readFileSync(a.file, "utf8") };
    env.handlers.open(docA);
    await waitUntil(() => /cuts 1/.test(env.statusBar.text), 8000, "package A boundary");

    const docB = { languageId: "flow", uri: env.mock.Uri.file(b.file), version: 1, getText: () => fs.readFileSync(b.file, "utf8") };
    env.handlers.open(docB);
    const editorB = { document: docB, setDecorations() {} };
    env.handlers.active(editorB);
    await waitUntil(() => /cuts 3/.test(env.statusBar.text), 8000, "package B boundary");

    // Switching back must reanalyse A again.
    const editorA = { document: docA, setDecorations() {} };
    env.handlers.active(editorA);
    await waitUntil(() => /cuts 1/.test(env.statusBar.text), 8000, "package A boundary again");
  } finally {
    ext.deactivate();
    restore();
  }
});

test("vscode: hover syncs the current document text before asking", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-vsc-hover-sync-"));
  fs.writeFileSync(path.join(dir, "flow.json"), JSON.stringify({ name: "app", version: "0.1.0", dependencies: {} }));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  const file = path.join(dir, "src", "main.flow");
  const oldText = `main :: Html
main = <p>{"old"}</p>
`;
  fs.writeFileSync(file, oldText);

  const env = makeMock(REPO);
  const { ext, restore } = loadExtension(env);
  try {
    ext.activate({ subscriptions: [], extensionPath: path.join(REPO, "vscode-extension") });
    const uri = env.mock.Uri.file(file);
    const opened = { languageId: "flow", uri, version: 1, getText: () => oldText };
    env.handlers.open(opened);
    await waitUntil(() => env.registered.length >= 15, 5000, "providers");
    await new Promise((r) => setTimeout(r, 300));

    const changedText = `count :: Int
count = 1

main :: Html
main = <p>{"new"}</p>
`;
    const changed = { languageId: "flow", uri, version: 2, getText: () => changedText };
    const provider = env.registered.find((r) => r[0] === "hover")[1];
    const hover = await provider.provideHover(changed, new env.mock.Position(0, 10));
    assert.ok(hover, "hover is returned for the new text");
    assert.match(hover.contents.value, /Integer/, "the server saw `Int`, not the stale `Html`");
  } finally {
    ext.deactivate();
    restore();
  }
});

test("vscode: server resolution prefers a compiler checkout over the bundle", () => {
  const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-vsc-ext-"));
  const bundled = path.join(extDir, "vendor", "src", "lsp", "server.ts");
  fs.mkdirSync(path.dirname(bundled), { recursive: true });
  fs.writeFileSync(bundled, "");

  const env = makeMock(REPO);
  const { ext, restore } = loadExtension(env);
  try {
    const context = { extensionPath: extDir };
    const found = ext._internals.findServer(context);
    assert.equal(found.kind, "workspace", "a checkout beats the installed bundle");
    assert.equal(path.resolve(found.path), path.resolve(path.join(REPO, "src", "lsp", "server.ts")));
    assert.equal(path.resolve(ext._internals.compilerRoot(found.path)), path.resolve(REPO));

    env.config.useWorkspaceServer = false;
    const fallback = ext._internals.findServer(context);
    assert.equal(fallback.kind, "bundled", "opting out uses the packaged server");
    assert.equal(path.resolve(fallback.path), path.resolve(bundled));

    env.config.useWorkspaceServer = true;
    env.config.serverPath = bundled;
    assert.equal(ext._internals.findServer(context).kind, "setting", "an explicit path wins");
  } finally {
    restore();
  }
});

test("vscode: compiler saves restart the language server without reinstalling", async () => {
  const env = makeMock(REPO);
  const { ext, restore } = loadExtension(env);
  try {
    ext.activate({ subscriptions: [], extensionPath: path.join(REPO, "vscode-extension") });
    await waitUntil(() => env.outputLines.some((l) => l.includes("(workspace)")), 5000, "workspace server selected");
    assert.ok(env.outputLines.some((l) => l.includes("watching") && l.includes(REPO)), "watches the checkout");

    const devWatches = env.watchers.filter((w) => w.pattern instanceof env.mock.RelativePattern);
    assert.deepEqual(
      devWatches.map((w) => w.pattern.pattern).sort(),
      ["registry/**/*.flow", "src/**/*.ts"],
      "compiler and stdlib are watched",
    );

    const src = devWatches.find((w) => w.pattern.pattern === "src/**/*.ts");
    const before = env.outputLines.filter((l) => l.includes("restarting the language server")).length;
    const uri = env.mock.Uri.file(path.join(REPO, "src", "analysis.ts"));
    src.fire("change", uri);
    src.fire("change", uri); // a save burst must coalesce into one restart
    await waitUntil(
      () => env.outputLines.filter((l) => l.includes("restarting the language server")).length > before,
      5000,
      "auto restart",
    );
    await new Promise((r) => setTimeout(r, 800));

    assert.equal(
      env.outputLines.filter((l) => l.includes("restarting the language server")).length,
      before + 1,
      "a burst restarts the server once",
    );
    assert.ok(env.outputLines.some((l) => l.includes("analysis.ts changed")), "the changed file is named");
    assert.ok(env.statusMessages.some((m) => /restarting language server/.test(m)), "restart is visible in the status bar");
    assert.ok(ext._internals.serverRunning(), "a server runs after the restart");
    assert.ok(src.disposed, "the pre-restart watcher is replaced");
  } finally {
    ext.deactivate();
    assert.equal(ext._internals.serverRunning(), false, "deactivate stops the server");
    restore();
  }
});

test("vscode: markup completion inserts a tag snippet over the typed prefix", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-vsc-markup-"));
  fs.writeFileSync(path.join(dir, "flow.json"), JSON.stringify({ name: "app", version: "0.1.0", dependencies: {} }));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  const file = path.join(dir, "src", "main.flow");
  const source = `main :: Html
main = <di
`;
  fs.writeFileSync(file, source);

  const env = makeMock(REPO);
  const { ext, restore } = loadExtension(env);
  try {
    ext.activate({ subscriptions: [], extensionPath: path.join(REPO, "vscode-extension") });
    const doc = { languageId: "flow", uri: env.mock.Uri.file(file), version: 1, getText: () => source };
    env.handlers.open(doc);
    await waitUntil(() => env.registered.length >= 15, 5000, "providers");
    await new Promise((r) => setTimeout(r, 300));

    const provider = env.registered.find((r) => r[0] === "completion")[1];
    const res = await provider.provideCompletionItems(doc, new env.mock.Position(1, 10));
    const div = res.items.find((i) => i.label === "div");
    assert.ok(div, "tag completion");
    assert.ok(div.range, "completion replaces the typed prefix");
    assert.equal(div.range.start.character, 7);
    assert.ok(div.insertText && typeof div.insertText.value === "string", "snippet inserted");
    assert.match(div.insertText.value, /<div>\$\{0\}<\/div>/);
  } finally {
    ext.deactivate();
    restore();
  }
});

test("vscode: refactor commands are exposed as code actions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-vsc-refactor-"));
  fs.writeFileSync(path.join(dir, "flow.json"), JSON.stringify({ name: "app", version: "0.1.0", dependencies: {} }));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  const file = path.join(dir, "src", "main.flow");
  const source = `answer :: Int -> Int
answer x = x + 1

main :: Html
main = <p>{"x"}</p>
`;
  fs.writeFileSync(file, source);

  const env = makeMock(REPO);
  const { ext, restore } = loadExtension(env);
  try {
    ext.activate({ subscriptions: [], extensionPath: path.join(REPO, "vscode-extension") });
    const doc = { languageId: "flow", uri: env.mock.Uri.file(file), version: 1, getText: () => source };
    env.handlers.open(doc);
    await waitUntil(() => env.registered.length >= 15, 5000, "providers");
    await new Promise((r) => setTimeout(r, 300));

    const provider = env.registered.find((r) => r[0] === "codeAction")[1];
    const actions = await provider.provideCodeActions(
      doc,
      new env.mock.Range(0, 1, 0, 1),
      { diagnostics: [] },
    );
    const commands = actions.filter((a) => a.command).map((a) => a.command.command);
    assert.ok(commands.includes("flow.importSymbol"), JSON.stringify(commands));
    assert.ok(commands.includes("flow.moveSymbol"), JSON.stringify(commands));
    assert.ok(commands.includes("flow.organizeImports"), JSON.stringify(commands));
  } finally {
    ext.deactivate();
    restore();
  }
});

test("vscode: the cut palette matches the server legend and theme defaults", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "vscode-extension", "package.json"), "utf8"));
  const env = makeMock(REPO);
  const { ext, restore } = loadExtension(env);
  try {
    assert.equal(ext._internals.cutSlots, CUT_PALETTE_SIZE, "the client and server agree on the palette size");
    assert.deepEqual(ext._internals.semanticLegend, SEMANTIC_LEGEND, "the fallback legend matches the server's");
    assert.equal(ext._internals.cutPalette.length, CUT_PALETTE_SIZE, "a colour for every slot");

    const cutModifiers = pkg.contributes.semanticTokenModifiers.filter((m) => /^cut\d+$/.test(m.id));
    assert.equal(cutModifiers.length, CUT_PALETTE_SIZE, "every slot is contributed to VS Code");

    const rules = pkg.configurationDefaults["editor.semanticTokenColorCustomizations"].rules;
    for (let i = 1; i <= CUT_PALETTE_SIZE; i++) {
      assert.ok(rules[`*.cut${i}`], `a default theme rule for cut${i}`);
    }
    assert.ok(rules["*.client"] && rules["*.server"], "tier colours are themed");
    assert.ok(rules["*.dependency"]?.underline, "dependencies are underlined");
    assert.deepEqual(ext._internals.semanticRules, rules, "the runtime rules match the contributed defaults");
  } finally {
    restore();
  }
});

test("vscode: toggle line comment inserts Flow's --, not //", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-comment-"));
  const file = path.join(dir, "main.flow");
  const env = makeMock(REPO);
  const { ext, restore } = loadExtension(env);
  try {
    ext.activate({ subscriptions: [], extensionPath: path.join(REPO, "vscode-extension") });
    let text = "let x = 1\nlet y = 2\n";
    const doc = { languageId: "flow", uri: env.mock.Uri.file(file), getText: () => text };
    const editor = {
      document: doc,
      selections: [{ start: { line: 0, character: 0 }, end: { line: 2, character: 0 } }],
    };
    env.mock.window.activeTextEditor = editor;
    const run = env.commands.find(([name]) => name === "flow.toggleComment")[1];
    assert.ok(run, "Flow: Toggle Line Comment is registered");

    await run();
    assert.equal(env.appliedEdits.length, 2);
    assert.ok(env.appliedEdits.every((e) => e.newText === "-- "), "line comments start with --");
    assert.ok(!env.appliedEdits.some((e) => e.newText.includes("//")), "never inserts //");

    env.appliedEdits.length = 0;
    text = "-- let x = 1\n-- let y = 2\n";
    await run();
    assert.equal(env.appliedEdits.length, 2);
    assert.ok(env.appliedEdits.every((e) => e.newText === ""), "a second toggle removes the comment");
  } finally {
    ext.deactivate();
    restore();
  }
});

test("vscode: semantic colours stay on when cut markers are disabled", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-semoff-"));
  const file = path.join(dir, "main.flow");
  fs.writeFileSync(file, SRC);
  const env = makeMock(REPO);
  env.config.enableDecorations = false;
  const { ext, restore } = loadExtension(env);
  try {
    ext.activate({ subscriptions: [], extensionPath: path.join(REPO, "vscode-extension") });
    const doc = { languageId: "flow", uri: env.mock.Uri.file(file), version: 1, getText: () => SRC };
    env.handlers.open(doc);
    await waitUntil(() => env.registered.some((r) => r[0] === "semanticTokens"), 8000, "semantic tokens");
    const sem = env.registered.find((r) => r[0] === "semanticTokens");
    const tokens = await sem[1].provideDocumentSemanticTokens(doc);
    assert.ok(tokens.data.length > 0, "semantic tokens are independent of marker decoration state");
  } finally {
    ext.deactivate();
    restore();
  }
});

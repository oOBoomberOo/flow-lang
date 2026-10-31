// Flow VS Code extension.
//
// A complete language client: syntax highlighting (TextMate) + every LSP
// provider the server implements (completion, hover, definition, references,
// symbols, signature help, inlay hints, folding, selection, highlights,
// formatting, code actions, code lens, rename), plus Flow's own feature —
// colouring the inferred client/server boundary.

const vscode = require("vscode");
const cp = require("child_process");
const path = require("path");
const fs = require("fs");

let client = null;
let diagnostics = null;
let statusBar = null;
let output = null;
let deco = null;
let enabled = true;
let extensionPath = null;
let regionCache = new Map(); // uri -> {client:[], server:[], cut:[]}

/* ------------------------------------------------------------------ */
/* LSP client                                                         */
/* ------------------------------------------------------------------ */

class LspClient {
  constructor(serverPath, cwd) {
    this.nextId = 1;
    this.pending = new Map();
    this.buf = Buffer.alloc(0);
    this.proc = cp.spawn(process.execPath, [serverPath], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout.on("data", (c) => this.feed(c));
    this.proc.stderr.on("data", (d) => output && output.appendLine(`[server] ${d.toString().trim()}`));
    this.proc.on("exit", () => this.pending.clear());
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
      const body = this.buf.slice(idx + 4, idx + 4 + len).toString("utf8");
      this.buf = this.buf.slice(idx + 4 + len);
      let msg;
      try { msg = JSON.parse(body); } catch { continue; }
      this.dispatch(msg);
    }
  }

  dispatch(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics") return publishDiagnostics(msg.params);
    if (msg.method === "flow/boundaryChanged") return applyBoundary(msg.params);
  }

  send(msg) {
    const body = JSON.stringify({ jsonrpc: "2.0", ...msg });
    this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  notify(method, params) { this.send({ method, params }); }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`flow: ${method} timed out`));
      }, 10000).unref?.();
    });
  }

  stop() { try { this.proc.kill(); } catch { /* already gone */ } }
}

/* ------------------------------------------------------------------ */
/* conversions                                                        */
/* ------------------------------------------------------------------ */

const P = (p) => new vscode.Position(p.line, p.character);
const R = (r) => new vscode.Range(P(r.start), P(r.end));
const back = (r) => ({ start: { line: r.start.line, character: r.start.character }, end: { line: r.end.line, character: r.end.character } });
const backPos = (p) => ({ line: p.line, character: p.character });

/** Make sure the server has the document text *before* a provider request.
 *  Completion can fire in the same tick as the keystroke that changed the
 *  buffer, so the didChange event may still be in flight; without this a
 *  `Time.` request can be answered against the previous line. */
function syncDocument(document) {
  if (!client) return;
  client.notify("textDocument/didChange", {
    textDocument: { uri: document.uri.toString(), version: document.version },
    contentChanges: [{ text: document.getText() }],
  });
}

const KINDS = {
  function: vscode.SymbolKind.Function,
  type: vscode.SymbolKind.Class,
  constructor: vscode.SymbolKind.Constructor,
  trait: vscode.SymbolKind.Interface,
  effect: vscode.SymbolKind.Interface,
  record: vscode.SymbolKind.Struct,
  alias: vscode.SymbolKind.TypeParameter,
};

async function ask(method, params, fallback) {
  if (!client) return fallback;
  try { return await client.request(method, params); } catch (e) { output?.appendLine(`[flow] ${method}: ${e.message}`); return fallback; }
}

/* ------------------------------------------------------------------ */
/* diagnostics + boundary                                             */
/* ------------------------------------------------------------------ */

function publishDiagnostics(params) {
  const uri = vscode.Uri.parse(params.uri);
  const list = (params.diagnostics || []).map((d) => {
    const v = new vscode.Diagnostic(
      R(d.range), d.message,
      d.severity === 1 ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
    );
    v.source = "flow";
    v.code = d.code;
    return v;
  });
  diagnostics.set(uri, list);
}

function makeDecorations() {
  const cfg = vscode.workspace.getConfiguration("flow");
  if (deco) {
    deco.client.dispose();
    deco.server.dispose();
    deco.cutOut.dispose();
    deco.cutIn.dispose();
    deco.crossing.dispose();
  }
  const media = (name) => (extensionPath ? vscode.Uri.file(path.join(extensionPath, "media", name)) : undefined);
  deco = {
    client: vscode.window.createTextEditorDecorationType({
      backgroundColor: cfg.get("clientColor"),
      borderRadius: "2px",
      overviewRulerColor: cfg.get("clientColor"),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    }),
    server: vscode.window.createTextEditorDecorationType({
      backgroundColor: cfg.get("serverColor"),
      borderRadius: "2px",
      overviewRulerColor: cfg.get("serverColor"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    }),
    // A cut that sends work client→server, and one that pulls a server value back.
    cutOut: vscode.window.createTextEditorDecorationType({
      textDecoration: "underline",
      borderWidth: "0 0 1px 0",
      borderStyle: "solid",
      borderColor: cfg.get("cutColor"),
      overviewRulerColor: cfg.get("cutColor"),
      overviewRulerLane: vscode.OverviewRulerLane.Center,
      gutterIconPath: media("cut-out.svg"),
      gutterIconSize: "contain",
      after: { contentText: " → server", color: cfg.get("cutColor"), margin: "0 0 0 0.4em" },
    }),
    cutIn: vscode.window.createTextEditorDecorationType({
      textDecoration: "underline",
      borderWidth: "0 0 1px 0",
      borderStyle: "solid",
      borderColor: cfg.get("cutInColor"),
      overviewRulerColor: cfg.get("cutInColor"),
      overviewRulerLane: vscode.OverviewRulerLane.Center,
      gutterIconPath: media("cut-in.svg"),
      gutterIconSize: "contain",
      after: { contentText: " → client", color: cfg.get("cutInColor"), margin: "0 0 0 0.4em" },
    }),
    // A cross-tier expression resolved without a whole cut.
    crossing: vscode.window.createTextEditorDecorationType({
      borderWidth: "0 0 1px 0",
      borderStyle: "dotted",
      borderColor: cfg.get("crossingColor"),
      overviewRulerColor: cfg.get("crossingColor"),
      overviewRulerLane: vscode.OverviewRulerLane.Full,
      gutterIconPath: media("crossing.svg"),
      gutterIconSize: "contain",
      after: { contentText: " ⇄ mixed", color: cfg.get("crossingColor"), margin: "0 0 0 0.4em" },
    }),
  };
}

function applyBoundary(payload) {
  const uri = payload.uri || (payload.regions && payload.regions[0] && payload.regions[0].fileUri);
  const byFile = new Map();
  const empty = () => ({ client: [], server: [], cutOut: [], cutIn: [], crossing: [] });
  for (const r of payload.regions || []) {
    const key = r.fileUri || uri;
    if (!key) continue;
    if (!byFile.has(key)) byFile.set(key, empty());
    const bucket = byFile.get(key);
    const range = R(r.range);
    const hover = detailMessage(r);
    if (r.kind === "cut") {
      (r.side === "server" ? bucket.cutOut : bucket.cutIn).push({ range, hoverMessage: hover });
    } else if (r.kind === "crossing") {
      bucket.crossing.push({ range, hoverMessage: hover });
    } else if (r.side === "client") bucket.client.push({ range, hoverMessage: r.label });
    else if (r.side === "server") bucket.server.push({ range, hoverMessage: r.label });
  }
  regionCache = byFile;
  paintAll();
  const s = payload.summary || { client: 0, server: 0, cuts: 0, crossings: 0 };
  const crossings = s.crossings ? ` · crossings ${s.crossings}` : "";
  statusBar.text = `$(radio-tower) Flow · client ${s.client} · server ${s.server} · cuts ${s.cuts}${crossings}`;
  statusBar.tooltip = "Flow: inferred placement. Click to explain.";
}

/** Rich hover for a cut/crossing marker. */
function detailMessage(r) {
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  if (r.kind === "cut") {
    md.appendMarkdown(`**Inferred cut${r.cutId ? ` \`${r.cutId}\`` : ""}** — \`${r.direction || r.side}\`\n\n`);
    md.appendMarkdown(`- boundary: \`${r.direction || r.side}\`\n`);
    if (r.mode) md.appendMarkdown(`- mode: \`${r.mode}\`\n`);
    if (r.parent) md.appendMarkdown(`- in: \`${r.parent}\`\n`);
    if (r.deps && r.deps.length) md.appendMarkdown(`- deps: \`${r.deps.join(", ")}\`\n`);
    if (r.type) md.appendMarkdown(`- type: \`${r.type}\`\n`);
    md.appendMarkdown("\nThis block runs on the other tier; the compiler splits it out and moves the value across.");
  } else {
    md.appendMarkdown(`**Cross-tier expression** — \`${r.direction || r.side}\`\n\n`);
    if (r.type) md.appendMarkdown(`- type: \`${r.type}\`\n`);
    md.appendMarkdown("\nThis value mixes client and server authority; the compiler resolves it to one side.");
  }
  return md;
}

function paint(editor) {
  if (!deco) return;
  const buckets = regionCache.get(editor.document.uri.toString());
  if (!enabled || !buckets) {
    editor.setDecorations(deco.client, []);
    editor.setDecorations(deco.server, []);
    editor.setDecorations(deco.cutOut, []);
    editor.setDecorations(deco.cutIn, []);
    editor.setDecorations(deco.crossing, []);
    return;
  }
  editor.setDecorations(deco.client, buckets.client);
  editor.setDecorations(deco.server, buckets.server);
  editor.setDecorations(deco.cutOut, buckets.cutOut);
  editor.setDecorations(deco.cutIn, buckets.cutIn);
  editor.setDecorations(deco.crossing, buckets.crossing);
}

function paintAll() {
  for (const editor of vscode.window.visibleTextEditors) paint(editor);
}

async function refresh(uri) {
  if (!client) return;
  const payload = await ask("flow/boundary", uri ? { uri } : {}, null);
  if (payload) applyBoundary({ ...payload, uri });
}

/* ------------------------------------------------------------------ */
/* providers                                                          */
/* ------------------------------------------------------------------ */

function registerProviders(context) {
  const doc = (d) => ({ uri: d.uri.toString() });
  const push = (d) => context.subscriptions.push(d);

  push(vscode.languages.registerCompletionItemProvider("flow", {
    async provideCompletionItems(document, position) {
      syncDocument(document);
      const res = await ask("textDocument/completion", { textDocument: doc(document), position: backPos(position) }, { items: [] });
      const list = new vscode.CompletionList([], false);
      for (const it of res.items || []) {
        const item = new vscode.CompletionItem(it.label, it.kind ?? vscode.CompletionItemKind.Text);
        if (it.detail) item.detail = it.detail;
        if (it.documentation) item.documentation = typeof it.documentation === "string" ? it.documentation : it.documentation.value;
        if (it.sortText) item.sortText = it.sortText;
        if (it.insertTextFormat === 2 && it.insertText && vscode.SnippetString) {
          item.insertText = new vscode.SnippetString(it.insertText);
        } else if (it.insertText) {
          item.insertText = it.insertText;
        }
        if (it.additionalTextEdits) {
          item.additionalTextEdits = it.additionalTextEdits.map((e) => vscode.TextEdit.replace(R(e.range), e.newText));
        }
        list.items.push(item);
      }
      return list;
    },
  }, ".", ":", "@"));

  push(vscode.languages.registerHoverProvider("flow", {
    async provideHover(document, position) {
      const h = await ask("textDocument/hover", { textDocument: doc(document), position: backPos(position) }, null);
      if (!h || !h.contents) return null;
      return new vscode.Hover(new vscode.MarkdownString(h.contents.value), h.range ? R(h.range) : undefined);
    },
  }));

  push(vscode.languages.registerDefinitionProvider("flow", {
    async provideDefinition(document, position) {
      const d = await ask("textDocument/definition", { textDocument: doc(document), position: backPos(position) }, null);
      return d ? new vscode.Location(vscode.Uri.parse(d.uri), R(d.range)) : null;
    },
  }));

  push(vscode.languages.registerReferenceProvider("flow", {
    async provideReferences(document, position, ctx) {
      const refs = await ask("textDocument/references", {
        textDocument: doc(document), position: backPos(position),
        context: { includeDeclaration: ctx.includeDeclaration },
      }, []);
      return (refs || []).map((r) => new vscode.Location(vscode.Uri.parse(r.uri), R(r.range)));
    },
  }));

  push(vscode.languages.registerDocumentSymbolProvider("flow", {
    async provideDocumentSymbols(document) {
      const syms = await ask("textDocument/documentSymbol", { textDocument: doc(document) }, []);
      return (syms || []).map((s) => {
        const ds = new vscode.DocumentSymbol(s.name, s.detail ?? "", KINDS[s.detail] ?? s.kind, R(s.range), R(s.selectionRange));
        return ds;
      });
    },
  }));

  push(vscode.languages.registerWorkspaceSymbolProvider({
    async provideWorkspaceSymbols(query) {
      const syms = await ask("workspace/symbol", { query }, []);
      return (syms || []).map((s) =>
        new vscode.SymbolInformation(s.name, s.kind, s.containerName ?? "", new vscode.Location(vscode.Uri.parse(s.location.uri), R(s.location.range))));
    },
  }));

  push(vscode.languages.registerSignatureHelpProvider("flow", {
    async provideSignatureHelp(document, position) {
      const h = await ask("textDocument/signatureHelp", { textDocument: doc(document), position: backPos(position) }, null);
      if (!h) return null;
      const help = new vscode.SignatureHelp();
      help.signatures = (h.signatures || []).map((s) => {
        const sig = new vscode.SignatureInformation(s.label, s.documentation);
        sig.parameters = (s.parameters || []).map((p) => new vscode.ParameterInformation(p.label));
        return sig;
      });
      help.activeSignature = h.activeSignature ?? 0;
      help.activeParameter = h.activeParameter ?? 0;
      return help;
    },
  }, "(", ","));

  push(vscode.languages.registerInlayHintsProvider("flow", {
    async provideInlayHints(document, range) {
      const hints = await ask("textDocument/inlayHint", { textDocument: doc(document), range: back(range) }, []);
      return (hints || []).map((h) => {
        const hint = new vscode.InlayHint(P(h.position), h.label, h.kind);
        if (h.tooltip) hint.tooltip = h.tooltip;
        if (h.paddingLeft) hint.paddingLeft = true;
        if (h.paddingRight) hint.paddingRight = true;
        return hint;
      });
    },
  }));

  push(vscode.languages.registerFoldingRangeProvider("flow", {
    async provideFoldingRanges(document) {
      const ranges = await ask("textDocument/foldingRange", { textDocument: doc(document) }, []);
      return (ranges || []).map((r) => new vscode.FoldingRange(r.startLine, r.endLine, r.kind));
    },
  }));

  push(vscode.languages.registerSelectionRangeProvider("flow", {
    async provideSelectionRanges(document, positions) {
      const res = await ask("textDocument/selectionRange", { textDocument: doc(document), positions: positions.map(backPos) }, null);
      if (!res) return null;
      const convert = (r) => r ? new vscode.SelectionRange(R(r), r.parent ? convert(r.parent) : undefined) : undefined;
      return res.map(convert).filter(Boolean);
    },
  }));

  push(vscode.languages.registerDocumentHighlightProvider("flow", {
    async provideDocumentHighlights(document, position) {
      const hits = await ask("textDocument/documentHighlight", { textDocument: doc(document), position: backPos(position) }, []);
      return (hits || []).map((h) => new vscode.DocumentHighlight(R(h.range), h.kind));
    },
  }));

  push(vscode.languages.registerDocumentLinkProvider("flow", {
    async provideDocumentLinks(document) {
      const links = await ask("textDocument/documentLink", { textDocument: doc(document) }, []);
      return (links || []).map((l) => {
        const link = new vscode.DocumentLink(R(l.range), vscode.Uri.parse(l.target));
        if (l.tooltip) link.tooltip = l.tooltip;
        return link;
      });
    },
  }));

  push(vscode.languages.registerTypeDefinitionProvider("flow", {
    async provideTypeDefinition(document, position) {
      const d = await ask("textDocument/typeDefinition", { textDocument: doc(document), position: backPos(position) }, null);
      return d ? new vscode.Location(vscode.Uri.parse(d.uri), R(d.range)) : null;
    },
  }));

  push(vscode.languages.registerDocumentFormattingEditProvider("flow", {
    async provideDocumentFormattingEdits(document) {
      const edits = await ask("textDocument/formatting", {
        textDocument: doc(document), options: { tabSize: 2, insertSpaces: true },
      }, []);
      return (edits || []).map((e) => vscode.TextEdit.replace(R(e.range), e.newText));
    },
  }));

  push(vscode.languages.registerCodeActionsProvider("flow", {
    async provideCodeActions(document, range, ctx) {
      const actions = await ask("textDocument/codeAction", {
        textDocument: doc(document), range: back(range),
        context: { diagnostics: ctx.diagnostics.map((d) => ({ message: d.message })) },
      }, []);
      return (actions || []).map((a) => {
        const action = new vscode.CodeAction(a.title, a.kind === "quickfix" ? vscode.CodeActionKind.QuickFix : vscode.CodeActionKind.RefactorRewrite);
        const edit = new vscode.WorkspaceEdit();
        for (const [uri, edits] of Object.entries(a.edit.changes || {})) {
          for (const e of edits) edit.replace(vscode.Uri.parse(uri), R(e.range), e.newText);
        }
        action.edit = edit;
        return action;
      });
    },
  }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.RefactorRewrite] }));

  push(vscode.languages.registerCodeLensProvider("flow", {
    async provideCodeLenses(document) {
      const lenses = await ask("textDocument/codeLens", { textDocument: doc(document) }, []);
      return (lenses || []).map((l) => new vscode.CodeLens(R(l.range), {
        title: l.command.title,
        command: "flow.cutInfo",
        arguments: l.command.arguments,
      }));
    },
  }));

  push(vscode.languages.registerRenameProvider("flow", {
    async prepareRename(document, position) {
      const r = await ask("textDocument/prepareRename", { textDocument: doc(document), position: backPos(position) }, null);
      return r ? R(r) : null;
    },
    async provideRenameEdits(document, position, newName) {
      const res = await ask("textDocument/rename", { textDocument: doc(document), position: backPos(position), newName }, null);
      if (!res) return null;
      const edit = new vscode.WorkspaceEdit();
      for (const [uri, changes] of Object.entries(res.changes || {})) {
        for (const c of changes) edit.replace(vscode.Uri.parse(uri), R(c.range), c.newText);
      }
      return edit;
    },
  }));
}

/* ------------------------------------------------------------------ */
/* activation                                                         */
/* ------------------------------------------------------------------ */

function findServer(context) {
  const cfg = vscode.workspace.getConfiguration("flow").get("serverPath");
  if (cfg && fs.existsSync(cfg)) return cfg;
  const bundled = path.join(context.extensionPath, "vendor", "src", "lsp", "server.ts");
  if (fs.existsSync(bundled)) return bundled;
  for (const root of (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath)) {
    const candidate = path.join(root, "src", "lsp", "server.ts");
    if (fs.existsSync(candidate)) return candidate;
  }
  const sibling = path.join(context.extensionPath, "..", "src", "lsp", "server.ts");
  return fs.existsSync(sibling) ? sibling : null;
}

async function start(context) {
  const serverPath = findServer(context);
  if (!serverPath) {
    vscode.window.showWarningMessage("Flow: could not find src/lsp/server.ts. Set flow.serverPath.");
    return;
  }
  const cwd = (vscode.workspace.workspaceFolders || [])[0]?.uri.fsPath || path.dirname(serverPath);
  client = new LspClient(serverPath, cwd);
  try {
    await client.request("initialize", {
      processId: process.pid,
      rootUri: vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? null,
      capabilities: {
        textDocument: {
          hover: { contentFormat: ["markdown"] },
          completion: { completionItem: { documentationFormat: ["markdown", "plaintext"] } },
          publishDiagnostics: { relatedInformation: false },
        },
        workspace: { symbol: {} },
      },
    });
    client.notify("initialized", {});
  } catch (e) {
    vscode.window.showErrorMessage(`Flow language server failed: ${e.message}`);
  }
  for (const doc of vscode.workspace.textDocuments) if (doc.languageId === "flow") openDoc(doc);
  const active = vscode.window.activeTextEditor;
  if (active && active.document.languageId === "flow") {
    activateDoc(active.document);
    await refresh(active.document.uri.toString());
  }
}

function activateDoc(doc) {
  if (!client || doc.languageId !== "flow") return;
  client.notify("flow/activate", { uri: doc.uri.toString() });
}

function openDoc(doc) {
  if (!client || doc.languageId !== "flow") return;
  client.notify("textDocument/didOpen", {
    textDocument: { uri: doc.uri.toString(), languageId: "flow", version: doc.version, text: doc.getText() },
  });
}

function activate(context) {
  extensionPath = context.extensionPath;
  output = vscode.window.createOutputChannel("Flow");
  diagnostics = vscode.languages.createDiagnosticCollection("flow");
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "flow.explain";
  statusBar.text = "$(radio-tower) Flow";
  statusBar.show();
  makeDecorations();

  context.subscriptions.push(
    diagnostics, statusBar, output,
    vscode.workspace.onDidOpenTextDocument(openDoc),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!client || e.document.languageId !== "flow") return;
      if (!e.contentChanges.length) return;
      client.notify("textDocument/didChange", {
        textDocument: { uri: e.document.uri.toString(), version: e.document.version },
        contentChanges: [{ text: e.document.getText() }],
      });
      debounce(e.document.uri.toString());
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!client || doc.languageId !== "flow") return;
      client.notify("textDocument/didSave", { textDocument: { uri: doc.uri.toString() }, text: doc.getText() });
      refresh(doc.uri.toString());
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (!client || doc.languageId !== "flow") return;
      client.notify("textDocument/didClose", { textDocument: { uri: doc.uri.toString() } });
      diagnostics.delete(doc.uri);
      regionCache.delete(doc.uri.toString());
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => paintAll()),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (ed && ed.document.languageId === "flow") {
        activateDoc(ed.document);
        paint(ed);
        refresh(ed.document.uri.toString());
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("flow")) return;
      makeDecorations();
      enabled = vscode.workspace.getConfiguration("flow").get("enableDecorations", true);
      paintAll();
    }),
    vscode.commands.registerCommand("flow.explain", () => explainCurrent()),
    vscode.commands.registerCommand("flow.cutInfo", (name) => {
      const buckets = [...regionCache.entries()]
        .filter(([uri]) => uri === vscode.window.activeTextEditor?.document.uri.toString())
        .map(([, b]) => b);
      const cuts = buckets.reduce((n, b) => n + b.cutOut.length + b.cutIn.length, 0);
      const crossings = buckets.reduce((n, b) => n + b.crossing.length, 0);
      vscode.window.showInformationMessage(
        `Flow: ${name ?? "this function"} — ${cuts} inferred cut(s), ${crossings} crossing(s) in this file.`,
      );
    }),
    vscode.commands.registerCommand("flow.toggleBoundary", () => {
      enabled = !enabled;
      paintAll();
      vscode.window.setStatusBarMessage(`Flow boundary colouring ${enabled ? "on" : "off"}`, 2000);
    }),
    vscode.commands.registerCommand("flow.restart", async () => {
      client?.stop();
      await start(context);
    }),
  );

  registerProviders(context);

  // edits to files that are not open (another module, a teammate's change) still
  // re-analyse the package
  const watcher = vscode.workspace.createFileSystemWatcher("**/*.flow");
  const watch = (uri, type) =>
    client?.notify("workspace/didChangeWatchedFiles", { changes: [{ uri: uri.toString(), type }] });
  watcher.onDidChange((u) => watch(u, 2));
  watcher.onDidCreate((u) => watch(u, 1));
  watcher.onDidDelete((u) => watch(u, 3));
  context.subscriptions.push(watcher);

  start(context);
}

const timers = new Map();
function debounce(uri) {
  clearTimeout(timers.get(uri));
  timers.set(uri, setTimeout(() => refresh(uri), 250));
}

function explainCurrent() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const file = ed.document.uri.fsPath;
  const root = (vscode.workspace.workspaceFolders || [])[0]?.uri.fsPath;
  const candidates = [
    root && path.join(root, "bin", "flow.mjs"),
    extensionPath && path.join(extensionPath, "vendor", "bin", "flow.mjs"),
  ].filter(Boolean);
  const bin = candidates.find((p) => fs.existsSync(p));
  output.clear();
  output.show(true);
  if (!bin) {
    output.appendLine("flow: cannot find bin/flow.mjs (workspace or bundled).");
    return;
  }
  cp.execFile(process.execPath, [bin, "explain", file], { cwd: path.dirname(path.dirname(bin)) }, (err, stdout, stderr) => {
    output.appendLine(stdout || "");
    if (stderr) output.appendLine(stderr);
    if (err) output.appendLine(`exit ${err.code}`);
  });
}

function deactivate() { client?.stop(); }

module.exports = { activate, deactivate };

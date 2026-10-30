// Flow VS Code extension: syntax highlighting (TextMate grammar), diagnostics,
// hover, and — the point of the thing — colouring the inferred client/server
// boundary directly in the editor.
//
// It speaks LSP to src/lsp/server.ts over stdio. No npm dependencies.

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
let regionCache = new Map(); // uri -> {client:[], server:[], cut:[]}
let extensionPath = null;

/* ------------------------------------------------------------------ */
/* LSP client                                                         */
/* ------------------------------------------------------------------ */

class LspClient {
  constructor(serverPath, cwd) {
    this.nextId = 1;
    this.pending = new Map();
    this.buf = Buffer.alloc(0);
    this.proc = cp.spawn(process.execPath, [serverPath], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.on("data", (c) => this.feed(c));
    this.proc.stderr.on("data", (d) => output && output.appendLine(`[server] ${d.toString().trim()}`));
    this.proc.on("exit", () => { this.pending.clear(); });
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

  stop() { try { this.proc.kill(); } catch { /* ignore */ } }
}

/* ------------------------------------------------------------------ */
/* diagnostics                                                        */
/* ------------------------------------------------------------------ */

function publishDiagnostics(params) {
  const uri = vscode.Uri.parse(params.uri);
  const list = (params.diagnostics || []).map((d) => {
    const v = new vscode.Diagnostic(
      new vscode.Range(d.range.start.line, d.range.start.character, d.range.end.line, d.range.end.character),
      d.message,
      d.severity === 1 ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
    );
    v.source = "flow";
    v.code = d.code;
    return v;
  });
  diagnostics.set(uri, list);
}

/* ------------------------------------------------------------------ */
/* boundary colouring                                                 */
/* ------------------------------------------------------------------ */

function makeDecorations() {
  const cfg = vscode.workspace.getConfiguration("flow");
  if (deco) { deco.client.dispose(); deco.server.dispose(); deco.cut.dispose(); }
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
    cut: vscode.window.createTextEditorDecorationType({
      textDecoration: "underline",
      borderWidth: "0 0 1px 0",
      borderStyle: "solid",
      borderColor: cfg.get("cutColor"),
    }),
  };
}

function toRange(r) {
  return new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
}

function applyBoundary(payload) {
  const uri = payload.uri || (payload.regions && payload.regions[0] && payload.regions[0].fileUri);
  const regions = payload.regions || [];
  const byFile = new Map();
  for (const r of regions) {
    const key = r.fileUri || uri;
    if (!key) continue;
    if (!byFile.has(key)) byFile.set(key, { client: [], server: [], cut: [] });
    const bucket = byFile.get(key);
    const range = toRange(r.range);
    if (r.kind === "cut") bucket.cut.push({ range, hoverMessage: r.label });
    else if (r.side === "client") bucket.client.push({ range, hoverMessage: r.label });
    else if (r.side === "server") bucket.server.push({ range, hoverMessage: r.label });
  }
  regionCache = byFile;
  paintAll();

  const s = payload.summary || { client: 0, server: 0, cuts: 0 };
  statusBar.text = `$(radio-tower) Flow · client ${s.client} · server ${s.server} · cuts ${s.cuts}`;
  statusBar.tooltip = "Flow: inferred placement. Click to explain.";
}

function paint(editor) {
  if (!deco) return;
  const key = editor.document.uri.toString();
  const buckets = regionCache.get(key);
  if (!enabled || !buckets) {
    editor.setDecorations(deco.client, []);
    editor.setDecorations(deco.server, []);
    editor.setDecorations(deco.cut, []);
    return;
  }
  editor.setDecorations(deco.client, buckets.client);
  editor.setDecorations(deco.server, buckets.server);
  editor.setDecorations(deco.cut, buckets.cut);
}

function paintAll() {
  for (const editor of vscode.window.visibleTextEditors) paint(editor);
}

async function refresh(uri) {
  if (!client) return;
  try {
    const payload = await client.request("flow/boundary", uri ? { uri } : {});
    applyBoundary({ ...payload, uri });
  } catch (e) {
    output.appendLine(`[flow] boundary request failed: ${e.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* activation                                                         */
/* ------------------------------------------------------------------ */

function findServer(context) {
  const cfg = vscode.workspace.getConfiguration("flow").get("serverPath");
  if (cfg && fs.existsSync(cfg)) return cfg;
  // 1. self-contained install: the compiler is bundled with the extension
  const bundled = path.join(context.extensionPath, "vendor", "src", "lsp", "server.ts");
  if (fs.existsSync(bundled)) return bundled;
  // 2. workspace checkout
  const roots = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  for (const root of roots) {
    const candidate = path.join(root, "src", "lsp", "server.ts");
    if (fs.existsSync(candidate)) return candidate;
  }
  // 3. extension installed next to the repo
  const sibling = path.join(context.extensionPath, "..", "src", "lsp", "server.ts");
  if (fs.existsSync(sibling)) return sibling;
  return null;
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
      capabilities: { textDocument: { hover: { contentFormat: ["markdown"] } } },
    });
    client.notify("initialized", {});
  } catch (e) {
    vscode.window.showErrorMessage(`Flow language server failed: ${e.message}`);
  }

  for (const doc of vscode.workspace.textDocuments) {
    if (doc.languageId === "flow") openDoc(doc);
  }
  const active = vscode.window.activeTextEditor;
  if (active && active.document.languageId === "flow") await refresh(active.document.uri.toString());
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
    diagnostics,
    statusBar,
    output,
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
      if (ed && ed.document.languageId === "flow") { paint(ed); refresh(ed.document.uri.toString()); }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("flow")) return;
      makeDecorations();
      enabled = vscode.workspace.getConfiguration("flow").get("enableDecorations", true);
      paintAll();
    }),
    vscode.languages.registerHoverProvider("flow", {
      async provideHover(document, position) {
        if (!client) return null;
        try {
          const h = await client.request("textDocument/hover", {
            textDocument: { uri: document.uri.toString() },
            position: { line: position.line, character: position.character },
          });
          if (!h || !h.contents) return null;
          const md = new vscode.MarkdownString(typeof h.contents === "string" ? h.contents : h.contents.value);
          return new vscode.Hover(md, h.range ? toRange(h.range) : undefined);
        } catch { return null; }
      },
    }),
    vscode.commands.registerCommand("flow.explain", () => explainCurrent()),
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
  const cwd = path.dirname(path.dirname(bin));
  cp.execFile(process.execPath, [bin, "explain", file], { cwd }, (err, stdout, stderr) => {
    output.appendLine(stdout || "");
    if (stderr) output.appendLine(stderr);
    if (err) output.appendLine(`exit ${err.code}`);
  });
}

function deactivate() {
  client?.stop();
}

module.exports = { activate, deactivate };

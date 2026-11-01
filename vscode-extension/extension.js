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
let regionCache = new Map(); // uri -> { cuts: {server:[], client:[]}, crossing:[] }
let devWatcher = null;
let devRestartTimer = null;
let startGeneration = 0;
let semanticRegistration = null;
let semanticEmitter = null;
let semanticEnabled = true;

/* Cut markers cycle through this palette; the semantic-token defaults in
 * package.json use the same colours. A cut keeps a slot for its lifetime. */
const CUT_SLOTS = 12;
const CUT_PALETTE = [
  "#c678dd", "#56b6c2", "#e5c07b", "#e06c75", "#98c379", "#d19a66",
  "#d16d9e", "#89ddff", "#b48ead", "#a3be8c", "#ebcb8b", "#7f9cf5",
];

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

function cutColors() {
  const cfg = vscode.workspace.getConfiguration("flow");
  const configured = cfg.get("cutPalette", CUT_PALETTE);
  const base = Array.isArray(configured) && configured.length ? configured : CUT_PALETTE;
  return Array.from({ length: CUT_SLOTS }, (_, i) => base[i % base.length]);
}

function makeDecorations() {
  if (deco) {
    for (const side of ["server", "client"]) for (const t of deco.cuts[side]) t.dispose();
    deco.crossing.dispose();
  }
  const cfg = vscode.workspace.getConfiguration("flow");
  const media = (name) => (extensionPath ? vscode.Uri.file(path.join(extensionPath, "media", name)) : undefined);
  const colors = cutColors();
  // One marker type per palette slot and direction. Symbol colours themselves
  // come from semantic tokens; these marks show where a cut starts.
  const cuts = { server: [], client: [] };
  for (let i = 0; i < CUT_SLOTS; i++) {
    const color = colors[i];
    for (const [side, icon] of [["server", "cut-out.svg"], ["client", "cut-in.svg"]]) {
      cuts[side].push(vscode.window.createTextEditorDecorationType({
        borderWidth: "0 0 1px 0",
        borderStyle: "solid",
        borderColor: color,
        overviewRulerColor: color,
        overviewRulerLane: vscode.OverviewRulerLane.Center,
        gutterIconPath: media(icon),
        gutterIconSize: "contain",
      }));
    }
  }
  deco = {
    cuts,
    // A cross-tier expression resolved without a whole cut.
    crossing: vscode.window.createTextEditorDecorationType({
      borderWidth: "0 0 1px 0",
      borderStyle: "dotted",
      borderColor: cfg.get("crossingColor", "rgba(176, 176, 176, 0.7)"),
      overviewRulerColor: cfg.get("crossingColor", "rgba(176, 176, 176, 0.7)"),
      overviewRulerLane: vscode.OverviewRulerLane.Full,
      gutterIconPath: media("crossing.svg"),
      gutterIconSize: "contain",
    }),
  };
}

function emptyBuckets() {
  return {
    cuts: {
      server: Array.from({ length: CUT_SLOTS }, () => []),
      client: Array.from({ length: CUT_SLOTS }, () => []),
    },
    crossing: [],
  };
}

function applyBoundary(payload) {
  const uri = payload.uri || (payload.regions && payload.regions[0] && payload.regions[0].fileUri);
  const byFile = new Map();
  for (const r of payload.regions || []) {
    const key = r.fileUri || uri;
    if (!key) continue;
    if (!byFile.has(key)) byFile.set(key, emptyBuckets());
    const bucket = byFile.get(key);
    const range = R(r.range);
    const hover = detailMessage(r);
    if (r.kind === "cut") {
      const side = r.side === "client" ? "client" : "server";
      const slot = Math.max(0, Math.min(CUT_SLOTS - 1, (Number(r.palette) || 1) - 1));
      bucket.cuts[side][slot].push({ range, hoverMessage: hover });
    } else if (r.kind === "crossing") {
      bucket.crossing.push({ range, hoverMessage: hover });
    }
  }
  regionCache = byFile;
  paintAll();
  semanticEmitter?.fire();
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
    if (r.palette) md.appendMarkdown(`- palette: \`cut${r.palette}\`\n`);
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
    for (const side of ["server", "client"]) for (const t of deco.cuts[side]) editor.setDecorations(t, []);
    editor.setDecorations(deco.crossing, []);
    return;
  }
  for (const side of ["server", "client"]) {
    for (let i = 0; i < CUT_SLOTS; i++) editor.setDecorations(deco.cuts[side][i], buckets.cuts[side][i]);
  }
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

/**
 * Register the server's semantic tokens. The legend is read from the server's
 * `initialize` response so the two can never drift apart. Firing the change
 * event re-requests tokens after a re-analysis that did not edit the buffer
 * (a cut can move without the text changing).
 */
function registerSemanticTokens(context, legend) {
  if (!legend || !vscode.languages.registerDocumentSemanticTokensProvider) return;
  semanticRegistration?.dispose();
  semanticEmitter?.dispose();
  semanticEmitter = new vscode.EventEmitter();
  const provider = {
    onDidChangeSemanticTokens: semanticEmitter.event,
    async provideDocumentSemanticTokens(document) {
      if (!semanticEnabled || !client) return new vscode.SemanticTokens(new Uint32Array());
      // The editor already sent didChange for this buffer. Do not sync here:
      // that would notify the server, which emits flow/boundaryChanged, which
      // fires onDidChangeSemanticTokens again - an endless refresh loop.
      const res = await ask(
        "textDocument/semanticTokens/full",
        { textDocument: { uri: document.uri.toString() } },
        { data: [] },
      );
      const data = Array.isArray(res?.data) ? res.data : [];
      return new vscode.SemanticTokens(Uint32Array.from(data));
    },
  };
  semanticRegistration = vscode.languages.registerDocumentSemanticTokensProvider("flow", provider, legend);
  context.subscriptions.push(semanticRegistration);
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
        if (it.textEdit) {
          item.range = R(it.textEdit.range);
          item.insertText = it.insertTextFormat === 2 && vscode.SnippetString
            ? new vscode.SnippetString(it.textEdit.newText)
            : it.textEdit.newText;
        } else if (it.insertTextFormat === 2 && it.insertText && vscode.SnippetString) {
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
  }, ".", ":", "@", "<", "/"));

  push(vscode.languages.registerHoverProvider("flow", {
    async provideHover(document, position) {
      syncDocument(document);
      const h = await ask("textDocument/hover", { textDocument: doc(document), position: backPos(position) }, null);
      if (!h || !h.contents) return null;
      return new vscode.Hover(new vscode.MarkdownString(h.contents.value), h.range ? R(h.range) : undefined);
    },
  }));

  push(vscode.languages.registerDefinitionProvider("flow", {
    async provideDefinition(document, position) {
      syncDocument(document);
      const d = await ask("textDocument/definition", { textDocument: doc(document), position: backPos(position) }, null);
      return d ? new vscode.Location(vscode.Uri.parse(d.uri), R(d.range)) : null;
    },
  }));

  push(vscode.languages.registerReferenceProvider("flow", {
    async provideReferences(document, position, ctx) {
      syncDocument(document);
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
      syncDocument(document);
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

  push(vscode.languages.registerOnTypeFormattingEditProvider("flow", {
    async provideOnTypeFormattingEdits(document, position, ch, options) {
      syncDocument(document);
      const edits = await ask("textDocument/onTypeFormatting", {
        textDocument: doc(document),
        position: backPos(position),
        ch,
        options: { tabSize: options?.tabSize ?? 2, insertSpaces: options?.insertSpaces ?? true },
      }, []);
      return (edits || []).map((e) => vscode.TextEdit.replace(R(e.range), e.newText));
    },
  }, ">", "/"));

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
      syncDocument(document);
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
        const kind = a.kind === "quickfix"
          ? vscode.CodeActionKind.QuickFix
          : a.kind === "source.organizeImports"
            ? (vscode.CodeActionKind.SourceOrganizeImports ?? vscode.CodeActionKind.Source)
            : vscode.CodeActionKind.RefactorRewrite;
        const action = new vscode.CodeAction(a.title, kind);
        if (a.command) {
          action.command = {
            title: a.command.title ?? a.title,
            command: a.command.command,
            arguments: a.command.arguments,
          };
        }
        if (a.edit) {
          const edit = new vscode.WorkspaceEdit();
          for (const [uri, edits] of Object.entries(a.edit.changes || {})) {
            for (const e of edits) edit.replace(vscode.Uri.parse(uri), R(e.range), e.newText);
          }
          action.edit = edit;
        }
        return action;
      });
    },
  }, {
    providedCodeActionKinds: [
      vscode.CodeActionKind.QuickFix,
      vscode.CodeActionKind.RefactorRewrite,
      ...(vscode.CodeActionKind.SourceOrganizeImports ? [vscode.CodeActionKind.SourceOrganizeImports] : []),
    ],
  }));

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

function workspaceRoots() {
  return (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
}

/** A Flow compiler checkout: the LSP source and the std package live side by side. */
function isCompilerCheckout(root) {
  return Boolean(root)
    && fs.existsSync(path.join(root, "src", "lsp", "server.ts"))
    && fs.existsSync(path.join(root, "registry", "packages", "flow", "1.0.0", "src", "http.flow"));
}

/**
 * Which language server to run.
 *
 * A checkout of the compiler wins over the copy installed with the extension:
 * while working on Flow itself, `src/` and the `registry` std package must be the code being
 * edited, not the last packaged snapshot. Normal users have no checkout in
 * their workspace, so they keep running the bundled `vendor/` server.
 */
function findServer(context) {
  const cfg = vscode.workspace.getConfiguration("flow");
  const explicit = cfg.get("serverPath");
  if (explicit && fs.existsSync(explicit)) return { path: explicit, kind: "setting" };
  if (cfg.get("useWorkspaceServer", true)) {
    for (const root of workspaceRoots()) {
      if (!isCompilerCheckout(root)) continue;
      return { path: path.join(root, "src", "lsp", "server.ts"), kind: "workspace" };
    }
  }
  const bundled = path.join(context.extensionPath, "vendor", "src", "lsp", "server.ts");
  if (fs.existsSync(bundled)) return { path: bundled, kind: "bundled" };
  for (const root of workspaceRoots()) {
    const candidate = path.join(root, "src", "lsp", "server.ts");
    if (fs.existsSync(candidate)) return { path: candidate, kind: "workspace" };
  }
  const sibling = path.join(context.extensionPath, "..", "src", "lsp", "server.ts");
  return fs.existsSync(sibling) ? { path: sibling, kind: "checkout" } : null;
}

/** `<root>/src/lsp/server.ts` -> `<root>`; null when the path is not a checkout. */
function compilerRoot(serverPath) {
  if (!serverPath) return null;
  const root = path.dirname(path.dirname(path.dirname(serverPath)));
  return isCompilerCheckout(root) ? root : null;
}

function insideExtensionBundle(context, file) {
  if (!context || !context.extensionPath) return false;
  const vendor = path.resolve(context.extensionPath, "vendor") + path.sep;
  return path.resolve(file).startsWith(vendor);
}

/** Watch the checkout's compiler and std package; restart after a short pause. */
function startDevWatch(context, serverPath) {
  devWatcher?.dispose();
  devWatcher = null;
  if (insideExtensionBundle(context, serverPath)) return;
  const root = compilerRoot(serverPath);
  if (!root) return;
  if (!vscode.workspace.getConfiguration("flow").get("devWatch", true)) return;
  if (typeof vscode.RelativePattern !== "function") return;

  const watchers = ["src/**/*.ts", "registry/**/*.flow"].map((pattern) => {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, pattern));
    const changed = (uri) => scheduleDevRestart(context, uri);
    watcher.onDidChange(changed);
    watcher.onDidCreate(changed);
    watcher.onDidDelete(changed);
    return watcher;
  });
  devWatcher = {
    root,
    dispose() {
      clearTimeout(devRestartTimer);
      devRestartTimer = null;
      for (const watcher of watchers) watcher.dispose();
    },
  };
  output?.appendLine(`[flow] watching ${root} for compiler and std package changes`);
}

function scheduleDevRestart(context, uri) {
  clearTimeout(devRestartTimer);
  devRestartTimer = setTimeout(() => {
    devRestartTimer = null;
    const file = uri && uri.fsPath && devWatcher?.root
      ? path.relative(devWatcher.root, uri.fsPath) || uri.fsPath
      : "compiler source";
    output?.appendLine(`[flow] ${file} changed; restarting the language server`);
    vscode.window.setStatusBarMessage("Flow: restarting language server…", 2000);
    void restart(context);
  }, 300);
  devRestartTimer.unref?.();
}

/** Stop the current server and start a fresh one against the resolved source. */
async function restart(context) {
  const old = client;
  client = null;
  old?.stop();
  await start(context);
}

async function start(context) {
  const generation = ++startGeneration;
  const found = findServer(context);
  if (!found) {
    vscode.window.showWarningMessage("Flow: could not find src/lsp/server.ts. Set flow.serverPath.");
    return;
  }
  const serverPath = found.path;
  const cwd = (vscode.workspace.workspaceFolders || [])[0]?.uri.fsPath || path.dirname(serverPath);
  try {
    output?.appendLine(`[flow] extension ${require("./package.json").version} · server ${serverPath} (${found.kind})`);
    if (found.kind === "workspace" || found.kind === "setting") {
      output?.appendLine("[flow] using the compiler checkout; edits under src/ and registry/ restart it automatically");
    }
  } catch { /* version is diagnostic only */ }
  startDevWatch(context, serverPath);
  const started = new LspClient(serverPath, cwd);
  client = started;
  let capabilities = null;
  try {
    const init = await started.request("initialize", {
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
    capabilities = init?.capabilities ?? null;
    started.notify("initialized", {});
  } catch (e) {
    if (client === started) client = null;
    started.stop();
    vscode.window.showErrorMessage(`Flow language server failed: ${e.message}`);
    return;
  }
  // A newer start (another save, or Restart) superseded this one while the
  // handshake was in flight; its process must not survive.
  if (generation !== startGeneration) {
    if (client === started) client = null;
    started.stop();
    return;
  }
  const legend = capabilities?.semanticTokensProvider?.legend;
  if (legend) registerSemanticTokens(context, legend);
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
  enabled = vscode.workspace.getConfiguration("flow").get("enableDecorations", true);
  semanticEnabled = enabled;
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
      semanticEnabled = enabled;
      semanticEmitter?.fire();
      paintAll();
      // The server source is chosen from settings; re-resolve and re-arm the
      // watcher immediately instead of waiting for a window reload.
      if (e.affectsConfiguration("flow.serverPath") ||
          e.affectsConfiguration("flow.useWorkspaceServer") ||
          e.affectsConfiguration("flow.devWatch")) {
        void restart(context);
      }
    }),
    vscode.commands.registerCommand("flow.explain", () => explainCurrent()),
    vscode.commands.registerCommand("flow.cutInfo", (name) => {
      const buckets = [...regionCache.entries()]
        .filter(([uri]) => uri === vscode.window.activeTextEditor?.document.uri.toString())
        .map(([, b]) => b);
      const cuts = buckets.reduce((n, b) =>
        n + ["server", "client"].reduce((m, side) =>
          m + b.cuts[side].reduce((k, list) => k + list.length, 0), 0), 0);
      const crossings = buckets.reduce((n, b) => n + b.crossing.length, 0);
      vscode.window.showInformationMessage(
        `Flow: ${name ?? "this function"} — ${cuts} inferred cut(s), ${crossings} crossing(s) in this file.`,
      );
    }),
    vscode.commands.registerCommand("flow.toggleBoundary", () => {
      enabled = !enabled;
      semanticEnabled = enabled;
      paintAll();
      semanticEmitter?.fire();
      vscode.window.setStatusBarMessage(`Flow boundary colouring ${enabled ? "on" : "off"}`, 2000);
    }),
    vscode.commands.registerCommand("flow.restart", async () => {
      output?.appendLine("[flow] restart requested");
      await restart(context);
    }),
    vscode.commands.registerCommand("flow.importSymbol", () => importSymbol()),
    vscode.commands.registerCommand("flow.moveSymbol", () => moveSymbol()),
    vscode.commands.registerCommand("flow.organizeImports", () => organizeImports()),
    vscode.commands.registerCommand("flow.toggleComment", () => toggleComment()),
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

async function applyChanges(changes) {
  if (!changes) return false;
  const edit = new vscode.WorkspaceEdit();
  let any = false;
  for (const [uri, edits] of Object.entries(changes)) {
    for (const e of edits) {
      edit.replace(vscode.Uri.parse(uri), R(e.range), e.newText);
      any = true;
    }
  }
  return any ? vscode.workspace.applyEdit(edit) : false;
}

function activeFlowEditor() {
  const ed = vscode.window.activeTextEditor;
  return ed && ed.document.languageId === "flow" ? ed : null;
}

async function importSymbol() {
  const ed = activeFlowEditor();
  if (!ed || !client) return;
  const uri = ed.document.uri.toString();
  const candidates = await ask("flow/importCandidates", { uri }, []);
  if (!candidates.length) {
    vscode.window.showInformationMessage("Flow: no unimported symbols are available.");
    return;
  }
  const pick = await vscode.window.showQuickPick(
    candidates.map((c) => ({ label: c.name, description: c.module, detail: c.kind })),
    { placeHolder: "Import which symbol?" },
  );
  if (!pick) return;
  const res = await ask("flow/importSymbol", { uri, name: pick.label, module: pick.description }, null);
  if (res && await applyChanges(res.changes)) {
    vscode.window.showInformationMessage(`Flow: imported ${pick.label} from ${pick.description}.`);
  }
}

async function moveSymbol() {
  const ed = activeFlowEditor();
  if (!ed || !client) return;
  const uri = ed.document.uri.toString();
  const files = await vscode.workspace.findFiles("**/*.flow");
  const items = files
    .filter((f) => f.toString() !== uri)
    .map((f) => ({
      label: vscode.workspace.asRelativePath ? vscode.workspace.asRelativePath(f) : f.fsPath,
      uri: f,
    }));
  if (!items.length) {
    vscode.window.showInformationMessage("Flow: no other .flow file to move the symbol to.");
    return;
  }
  const pick = await vscode.window.showQuickPick(items, { placeHolder: "Move the symbol to which file?" });
  if (!pick) return;
  const res = await ask("flow/moveSymbol", {
    uri, position: backPos(ed.selection.active), targetUri: pick.uri.toString(),
  }, null);
  if (res?.error) {
    vscode.window.showErrorMessage(`Flow: ${res.error}`);
    return;
  }
  if (await applyChanges(res?.changes)) {
    vscode.window.showInformationMessage(`Flow: moved the symbol into ${pick.label}.`);
  }
}

async function organizeImports() {
  const ed = activeFlowEditor();
  if (!ed || !client) return;
  const res = await ask("flow/organizeImports", { uri: ed.document.uri.toString() }, null);
  if (await applyChanges(res?.changes)) {
    vscode.window.showInformationMessage("Flow: imports organized.");
  }
}

/**
 * Flow's toggle-line-comment. VS Code normally derives this from
 * `language-configuration.json`, but an updated window can keep the previous
 * comment token cached; this command makes the `--` behaviour explicit.
 */
function toggleComment() {
  const ed = activeFlowEditor();
  if (!ed) return;
  const text = ed.document.getText();
  const lines = text.split(/\r?\n/);
  const selections = ed.selections?.length
    ? ed.selections
    : [{ start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }];
  const picked = new Set();
  for (const sel of selections) {
    const start = sel.start.line;
    let end = sel.end.line;
    if (sel.end.character === 0 && end > start) end--;
    for (let i = start; i <= end; i++) if (i >= 0 && i < lines.length) picked.add(i);
  }
  const targets = [...picked].sort((a, b) => a - b).filter((i) => lines[i].trim() !== "");
  if (!targets.length) return;
  const commented = targets.map((i) => /^(\s*)-- ?/.exec(lines[i]));
  const allCommented = commented.every(Boolean);

  const edit = new vscode.WorkspaceEdit();
  for (const i of targets) {
    const line = lines[i];
    if (allCommented) {
      const m = /^(\s*)-- ?/.exec(line);
      const start = m[1].length;
      const end = start + (m[0].length - start);
      edit.replace(ed.document.uri, new vscode.Range(i, start, i, end), "");
    } else {
      const indent = /^\s*/.exec(line)[0].length;
      edit.insert(ed.document.uri, new vscode.Position(i, indent), "-- ");
    }
  }
  return Promise.resolve(vscode.workspace.applyEdit(edit)).then((applied) => {
    // The line is a comment now; re-request semantic tokens immediately so a
    // previously coloured symbol cannot keep its tier/cut colour.
    semanticEmitter?.fire();
    return applied;
  });
}

function deactivate() {
  clearTimeout(devRestartTimer);
  devRestartTimer = null;
  devWatcher?.dispose();
  devWatcher = null;
  semanticRegistration?.dispose();
  semanticRegistration = null;
  semanticEmitter?.dispose();
  semanticEmitter = null;
  client?.stop();
  client = null;
}

module.exports = {
  activate,
  deactivate,
  _internals: {
    findServer,
    compilerRoot,
    isCompilerCheckout,
    serverRunning: () => Boolean(client),
    cutSlots: CUT_SLOTS,
    cutPalette: CUT_PALETTE,
  },
};

/**
 * Flow — language server (LSP over stdio, no dependencies).
 *
 * Capabilities
 *   textDocumentSync           incremental
 *   textDocument/semanticTokens/full   keywords/types/functions + client/server modifiers
 *   textDocument/hover         inferred type, placement and effect row
 *   publishDiagnostics         whole-package diagnostics, per file
 *   flow/boundary              placement regions (the client/server boundary)
 *
 * Run: node src/lsp/server.ts --stdio
 */

import path from "node:path";
import { analyze, findNodeAt, readSource } from "../analysis.ts";
import type { Analysis, Region } from "../analysis.ts";
import { lex } from "../lexer.ts";
import type { Token } from "../lexer.ts";
import { loadPackage } from "../modules.ts";

/* ------------------------------------------------------------------ */
/* JSON-RPC framing                                                   */
/* ------------------------------------------------------------------ */

type Json = Record<string, unknown>;

function write(msg: Json) {
  const body = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function reply(id: unknown, result: unknown) {
  write({ jsonrpc: "2.0", id, result });
}

function replyError(id: unknown, code: number, message: string) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function notify(method: string, params: unknown) {
  write({ jsonrpc: "2.0", method, params });
}

class Reader {
  private buf = Buffer.alloc(0);
  private wanted = -1;
  private chunks: Json[] = [];
  private listeners: ((m: Json) => void)[] = [];

  push(chunk: Buffer) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.wanted < 0) {
        const idx = this.buf.indexOf("\r\n\r\n");
        if (idx < 0) return;
        const header = this.buf.slice(0, idx).toString("utf8");
        const m = /Content-Length:\s*(\d+)/i.exec(header);
        if (!m) { this.buf = this.buf.slice(idx + 4); continue; }
        this.wanted = Number(m[1]);
        this.buf = this.buf.slice(idx + 4);
      }
      if (this.buf.length < this.wanted) return;
      const body = this.buf.slice(0, this.wanted).toString("utf8");
      this.buf = this.buf.slice(this.wanted);
      this.wanted = -1;
      try {
        const msg = JSON.parse(body) as Json;
        for (const l of this.listeners) l(msg);
      } catch {
        /* ignore malformed frame */
      }
    }
  }

  onMessage(fn: (m: Json) => void) { this.listeners.push(fn); }
}

/* ------------------------------------------------------------------ */
/* state                                                              */
/* ------------------------------------------------------------------ */

const openDocs = new Map<string, string>();   // uri -> text
const versions = new Map<string, number>();
let workspaceRoot: string | null = null;
let lastAnalysis: Analysis | null = null;
let lastEntry: string | null = null;

function uriToPath(uri: string): string {
  let p = decodeURIComponent(uri.replace(/^file:\/\//, ""));
  if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
  return path.normalize(p);
}

function pathToUri(p: string): string {
  const abs = path.resolve(p).replace(/\\/g, "/");
  return `file:///${abs.replace(/^\/+/, "")}`;
}

function overlay(): Map<string, string> {
  const m = new Map<string, string>();
  for (const [uri, text] of openDocs) m.set(path.resolve(uriToPath(uri)), text);
  return m;
}

function entryFor(file: string): string {
  // Prefer the package entry (src/main.flow); otherwise treat `file` as the program.
  try {
    const pkg = loadPackage(file);
    if (pkg.singleFile) return pkg.singleFile;
    const main = path.join(pkg.srcDir, "main.flow");
    return main;
  } catch {
    return file;
  }
}

function reanalyze(): Analysis | null {
  const first = [...openDocs.keys()][0];
  if (!first && !lastEntry) return null;
  const file = lastEntry ?? uriToPath(first!);
  const entry = entryFor(file);
  lastEntry = entry;

  let a: Analysis;
  try {
    a = analyze(entry, overlay());
  } catch (e) {
    console.error("[flow-lsp]", e);
    return null;
  }
  lastAnalysis = a;

  for (const uri of openDocs.keys()) publishDiagnostics(uri, a);
  return a;
}

function publishDiagnostics(uri: string, a: Analysis) {
  const file = path.resolve(uriToPath(uri));
  const diags = a.diagnostics
    .filter((d) => path.resolve(d.file) === file)
    .map((d) => ({
      range: d.range,
      severity: d.severity,
      code: d.code,
      source: "flow",
      message: d.message,
    }));
  notify("textDocument/publishDiagnostics", { uri, diagnostics: diags });
}

/* ------------------------------------------------------------------ */
/* semantic tokens                                                    */
/* ------------------------------------------------------------------ */

const TOKEN_TYPES = [
  "keyword", "function", "variable", "type", "class", "string", "number",
  "comment", "operator", "parameter", "property", "namespace",
];
const TOKEN_MODIFIERS = ["client", "server", "cut", "boundary"];

function inRegion(regions: Region[], line: number, character: number): Region | null {
  let best: Region | null = null;
  for (const r of regions) {
    const afterStart = line > r.range.start.line || (line === r.range.start.line && character >= r.range.start.character);
    const beforeEnd = line < r.range.end.line || (line === r.range.end.line && character <= r.range.end.character);
    if (afterStart && beforeEnd) {
      if (!best || r.kind === "cut") best = r;
    }
  }
  return best;
}

function semanticTokens(uri: string): { data: number[] } {
  const file = path.resolve(uriToPath(uri));
  const text = openDocs.get(uri) ?? readSource(file);
  const regions = (lastAnalysis?.regions ?? []).filter((r) => path.resolve(r.file) === file);

  const toks: { line: number; char: number; len: number; type: number; mods: number }[] = [];

  // real tokens
  let lexed: Token[] = [];
  try { lexed = lex(text, file); } catch { lexed = []; }

  for (let i = 0; i < lexed.length; i++) {
    const t = lexed[i]!;
    if (t.kind === "eof") continue;
    let type = -1;
    let mods = 0;
    const prev = lexed[i - 1];
    if (t.kind === "kw") type = 0;
    else if (t.kind === "str") type = 5;
    else if (t.kind === "num" || t.kind === "float") type = 6;
    else if (t.kind === "sym") type = 8;
    else if (t.kind === "Con") type = 3;
    else if (t.kind === "id") {
      type = prev && prev.value === "fn" ? 1 : 9;
      const next = lexed[i + 1];
      if (next && next.value === "(") type = 1;
    }
    if (type < 0) continue;

    const region = inRegion(regions, t.line - 1, t.col - 1);
    if (region) {
      if (region.side === "client") mods |= 1 << 0;
      if (region.side === "server") mods |= 1 << 1;
      if (region.kind === "cut") mods |= 1 << 2;
      if (region.kind === "cut") mods |= 1 << 3;
    }
    toks.push({ line: t.line - 1, char: t.col - 1, len: t.value.length, type, mods });
  }

  // comments (the lexer drops them)
  const re = /\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(0, m.index);
    const line = before.split("\n").length - 1;
    const lineStart = before.lastIndexOf("\n") + 1;
    toks.push({ line, char: m.index - lineStart, len: m[0].length, type: 7, mods: 0 });
  }

  toks.sort((a, b) => a.line - b.line || a.char - b.char);

  const data: number[] = [];
  let prevLine = 0, prevChar = 0;
  for (const t of toks) {
    const deltaLine = t.line - prevLine;
    const deltaChar = deltaLine === 0 ? t.char - prevChar : t.char;
    data.push(deltaLine, deltaChar, t.len, t.type, t.mods);
    prevLine = t.line;
    prevChar = t.char;
  }
  return { data };
}

/* ------------------------------------------------------------------ */
/* boundary                                                           */
/* ------------------------------------------------------------------ */

function boundary(uri?: string) {
  const a = lastAnalysis;
  if (!a) return { regions: [], summary: { client: 0, server: 0, cuts: 0 } };
  // Package-wide: the client maps regions back to their own files. `uri` only
  // tells the editor which document triggered the request.
  const regions = a.regions.map((r) => ({
    ...r,
    fileUri: pathToUri(r.file),
    label: r.label,
  }));
  void uri;
  return {
    regions,
    summary: {
      client: regions.filter((r) => r.side === "client" && r.kind === "function").length,
      server: regions.filter((r) => r.side === "server" && r.kind === "function").length,
      cuts: regions.filter((r) => r.kind === "cut").length,
    },
  };
}

/* ------------------------------------------------------------------ */
/* dispatch                                                           */
/* ------------------------------------------------------------------ */

const reader = new Reader();

reader.onMessage((msg) => {
  const method = msg.method as string | undefined;
  const id = msg.id;
  const params = (msg.params ?? {}) as Json;

  if (method === "initialize") {
    workspaceRoot = params.rootUri ? uriToPath(params.rootUri as string) : null;
    reply(id, {
      capabilities: {
        textDocumentSync: { openClose: true, change: 2, save: { includeText: true } },
        semanticTokensProvider: {
          legend: { tokenTypes: TOKEN_TYPES, tokenModifiers: TOKEN_MODIFIERS },
          full: true,
        },
        hoverProvider: true,
      },
      serverInfo: { name: "flow-lsp", version: "0.2.0" },
    });
    return;
  }

  if (method === "initialized") {
    if (workspaceRoot) lastEntry = null;
    return;
  }

  if (method === "shutdown") { reply(id, null); return; }
  if (method === "exit") { process.exit(0); }

  if (method === "textDocument/didOpen") {
    const doc = (params.textDocument ?? {}) as Json;
    openDocs.set(doc.uri as string, doc.text as string);
    versions.set(doc.uri as string, doc.version as number);
    lastEntry = null;
    const a = reanalyze();
    if (a) notifyBoundary(doc.uri as string);
    return;
  }

  if (method === "textDocument/didChange") {
    const doc = (params.textDocument ?? {}) as Json;
    const changes = (params.contentChanges ?? []) as Json[];
    let text = openDocs.get(doc.uri as string) ?? "";
    for (const c of changes) {
      if (typeof c.text !== "string") continue;
      if (!c.range) { text = c.text; continue; }
      const r = c.range as { start: { line: number; character: number }; end: { line: number; character: number } };
      const lines = text.split("\n");
      const startOffset = offsetOf(lines, r.start.line, r.start.character);
      const endOffset = offsetOf(lines, r.end.line, r.end.character);
      text = text.slice(0, startOffset) + c.text + text.slice(endOffset);
    }
    openDocs.set(doc.uri as string, text);
    versions.set(doc.uri as string, doc.version as number);
    reanalyze();
    notifyBoundary(doc.uri as string);
    return;
  }

  if (method === "textDocument/didSave") {
    const doc = (params.textDocument ?? {}) as Json;
    if (typeof params.text === "string") openDocs.set(doc.uri as string, params.text);
    reanalyze();
    notifyBoundary(doc.uri as string);
    return;
  }

  if (method === "textDocument/didClose") {
    const doc = (params.textDocument ?? {}) as Json;
    openDocs.delete(doc.uri as string);
    return;
  }

  if (method === "textDocument/semanticTokens/full") {
    const doc = (params.textDocument ?? {}) as Json;
    reply(id, semanticTokens(doc.uri as string));
    return;
  }

  if (method === "textDocument/hover") {
    const doc = (params.textDocument ?? {}) as Json;
    const pos = params.position as { line: number; character: number };
    if (!lastAnalysis) reanalyze();
    const file = path.resolve(uriToPath(doc.uri as string));
    const node = lastAnalysis ? findNodeAt(lastAnalysis, file, pos) : null;
    if (!node) { reply(id, null); return; }
    const eff = node.effects.length ? `\n\nEffects: \`{${node.effects.join(", ")}}\`` : "";
    reply(id, {
      contents: {
        kind: "markdown",
        value: `**${node.type}**\n\nPlacement: \`${node.place}\`${eff}`,
      },
      range: node.range,
    });
    return;
  }

  if (method === "flow/boundary") {
    if (!lastAnalysis) reanalyze();
    reply(id, boundary(params.uri as string | undefined));
    return;
  }

  if (method === "flow/status") {
    reply(id, {
      analysis: lastAnalysis ? { ok: lastAnalysis.ok, entry: lastAnalysis.entry, units: lastAnalysis.units } : null,
    });
    return;
  }

  if (id !== undefined) replyError(id, -32601, `unhandled method ${method}`);
});

function notifyBoundary(uri: string) {
  notify("flow/boundaryChanged", { uri, ...boundary(uri) });
}

function offsetOf(lines: string[], line: number, character: number): number {
  let offset = 0;
  for (let i = 0; i < line && i < lines.length; i++) offset += lines[i]!.length + 1;
  return offset + character;
}

process.stdin.on("data", (chunk: Buffer) => reader.push(chunk));
process.stdin.on("end", () => process.exit(0));

if (process.argv.includes("--selftest")) {
  // handled by test/lsp.test.mjs spawning the server
}

console.error("[flow-lsp] ready");

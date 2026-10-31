/**
 * Flow — language server (LSP over stdio, no dependencies).
 *
 * textDocument: synchronization, diagnostics, hover, completion, definition,
 * references, document/workspace symbols, signature help, inlay hints,
 * folding ranges, selection ranges, document highlights, formatting, code
 * actions, code lenses, rename.
 *
 * Plus the Flow-specific `flow/boundary` request: placement regions per file,
 * which is what the editor paints.
 */

import path from "node:path";
import { analyze, findNodeAt, readSource, offsetToPosition, spanRange, stdModules } from "../analysis.ts";
import { moduleDisplayName } from "../modules.ts";

/** `std::list` -> `List` for the cheap std index, which carries only ids. */
const moduleNameOf = (m: { id: string }) => m.id.split("::").slice(1).map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(".");
import type { Analysis, NodeInfo, Region, SymbolInfo } from "../analysis.ts";
import { lex } from "../lexer.ts";
import type { Token } from "../lexer.ts";
import type { Decl, Expr, FnSig, Program } from "../ast.ts";
import { printType } from "../printer.ts";

/* ------------------------------------------------------------------ */
/* JSON-RPC framing                                                   */
/* ------------------------------------------------------------------ */

type Json = Record<string, unknown>;

function write(msg: Json) {
  const body = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}
const reply = (id: unknown, result: unknown) => write({ jsonrpc: "2.0", id, result });
const replyError = (id: unknown, code: number, message: string) =>
  write({ jsonrpc: "2.0", id, error: { code, message } });
const notify = (method: string, params: unknown) => write({ jsonrpc: "2.0", method, params });

class Reader {
  private buf = Buffer.alloc(0);
  private wanted = -1;
  private listeners: ((m: Json) => void)[] = [];
  push(chunk: Buffer) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.wanted < 0) {
        const idx = this.buf.indexOf("\r\n\r\n");
        if (idx < 0) return;
        const m = /Content-Length:\s*(\d+)/i.exec(this.buf.slice(0, idx).toString("utf8"));
        if (!m) { this.buf = this.buf.slice(idx + 4); continue; }
        this.wanted = Number(m[1]);
        this.buf = this.buf.slice(idx + 4);
      }
      if (this.buf.length < this.wanted) return;
      const body = this.buf.slice(0, this.wanted).toString("utf8");
      this.buf = this.buf.slice(this.wanted);
      this.wanted = -1;
      let msg: Json;
      try {
        msg = JSON.parse(body) as Json;
      } catch {
        continue; // not a JSON-RPC frame
      }
      for (const l of this.listeners) l(msg); // handler errors must surface
    }
  }
  onMessage(fn: (m: Json) => void) { this.listeners.push(fn); }
}

/* ------------------------------------------------------------------ */
/* state                                                              */
/* ------------------------------------------------------------------ */

const openDocs = new Map<string, string>();
let workspaceRoot: string | null = null;
let lastAnalysis: Analysis | null = null;
let lastEntry: string | null = null;
/** the file the editor is focused on; analysis follows it across files/packages */
let activeFile: string | null = null;

const uriToPath = (uri: string): string => {
  let p = decodeURIComponent(uri.replace(/^file:\/\//, ""));
  if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
  return path.normalize(p);
};
const pathToUri = (p: string): string => `file:///${path.resolve(p).replace(/\\/g, "/").replace(/^\/+/, "")}`;

function overlay(): Map<string, string> {
  const m = new Map<string, string>();
  for (const [uri, text] of openDocs) m.set(path.resolve(uriToPath(uri)), text);
  return m;
}

function textOf(fileOrUri: string): string {
  const uri = fileOrUri.startsWith("file:") ? fileOrUri : pathToUri(fileOrUri);
  const text = openDocs.get(uri);
  return text !== undefined ? text : readSource(uriToPath(uri));
}

function overlayKey(o: Map<string, string>): string {
  const parts: string[] = [];
  for (const k of [...o.keys()].sort()) parts.push(`${k}\u0000${o.get(k)}`);
  return parts.join("\u0001");
}

let lastInputKey = "";
let reanalyzeTimer: ReturnType<typeof setTimeout> | null = null;
let analysisStale = false;

/** Discard the cache (a file changed on disk). */
function invalidateAnalysis(): void {
  lastInputKey = "";
}

function reanalyze(): Analysis | null {
  const first = [...openDocs.keys()][0];
  const focus = activeFile ?? lastEntry ?? (first ? uriToPath(first) : null);
  if (!focus) return null;
  // Analyse the focused file itself. It may be a module that the package entry
  // does not import, or a file in another package; mapping back to main.flow
  // would leave the editor without diagnostics, symbols or boundary colouring.
  const entry = focus;
  lastEntry = entry;
  const ov = overlay();
  // The same text is analysed once: didSave after didChange is free, and a
  // debounced timer that lands on unchanged input does not recompile.
  const key = `${entry}\u0002${overlayKey(ov)}`;
  if (key === lastInputKey && lastAnalysis) {
    for (const uri of openDocs.keys()) {
      publishDiagnostics(uri, lastAnalysis);
      notify("flow/boundaryChanged", { uri, ...boundary(uri) });
    }
    return lastAnalysis;
  }
  try {
    const started = performance.now();
    lastAnalysis = analyze(entry, ov);
    lastInputKey = key;
    if (process.env.FLOW_LSP_DEBUG) {
      console.error(`[flow-lsp] analyze ${(performance.now() - started).toFixed(1)}ms`);
    }
  } catch (e) {
    console.error("[flow-lsp]", e);
    return null;
  }
  for (const uri of openDocs.keys()) {
    publishDiagnostics(uri, lastAnalysis);
    notify("flow/boundaryChanged", { uri, ...boundary(uri) });
  }
  return lastAnalysis;
}

/**
 * Coalesce a burst of keystrokes into one analysis. Recompiling synchronously on
 * every `didChange` was what made typing feel slow.
 */
function scheduleReanalyze(delay = 150): void {
  analysisStale = true;
  if (reanalyzeTimer) clearTimeout(reanalyzeTimer);
  reanalyzeTimer = setTimeout(() => {
    reanalyzeTimer = null;
    reanalyze();
    analysisStale = false;
  }, delay);
}

/** Requests the user initiated get a fresh analysis; background ones reuse it. */
function flushAnalysis(): void {
  if (!analysisStale) return;
  if (reanalyzeTimer) {
    clearTimeout(reanalyzeTimer);
    reanalyzeTimer = null;
  }
  reanalyze();
  analysisStale = false;
}

const FRESH_METHODS = new Set([
  "textDocument/completion",
  "textDocument/hover",
  "textDocument/definition",
  "textDocument/typeDefinition",
  "textDocument/references",
  "textDocument/documentSymbol",
  "textDocument/documentHighlight",
  "textDocument/signatureHelp",
  "textDocument/prepareRename",
  "textDocument/rename",
  "textDocument/codeAction",
  "textDocument/codeLens",
  "workspace/symbol",
]);

function publishDiagnostics(uri: string, a: Analysis) {
  const file = path.resolve(uriToPath(uri));
  notify("textDocument/publishDiagnostics", {
    uri,
    diagnostics: a.diagnostics
      .filter((d) => path.resolve(d.file) === file)
      .map((d) => ({ range: d.range, severity: d.severity, code: d.code, source: "flow", message: d.message })),
  });
}

const nodeAt = (file: string, pos: Position): NodeInfo | null =>
  lastAnalysis ? findNodeAt(lastAnalysis, file, pos) : null;

interface Position { line: number; character: number }

/* ------------------------------------------------------------------ */
/* helpers over source text                                            */
/* ------------------------------------------------------------------ */

function offsetAt(text: string, pos: Position): number {
  let line = 0, off = 0;
  while (line < pos.line && off < text.length) {
    const nl = text.indexOf("\n", off);
    if (nl < 0) return text.length;
    off = nl + 1;
    line++;
  }
  return Math.min(off + pos.character, text.length);
}

function wordAt(text: string, off: number): { word: string; start: number; end: number } {
  let s = off, e = off;
  const isW = (c: string) => /[A-Za-z0-9_']/.test(c);
  while (s > 0 && isW(text[s - 1]!)) s--;
  while (e < text.length && isW(text[e]!)) e++;
  return { word: text.slice(s, e), start: s, end: e };
}

const LSP_KIND: Record<string, number> = {
  function: 3, type: 5, constructor: 4, trait: 11, effect: 25, record: 23, alias: 26,
};

function symbolKind(name: string): number { return LSP_KIND[name] ?? 13; }

/* ------------------------------------------------------------------ */
/* symbols / definitions                                              */
/* ------------------------------------------------------------------ */

function symbolsInFile(file: string): SymbolInfo[] {
  const f = path.resolve(file);
  return (lastAnalysis?.symbols ?? []).filter((s) => path.resolve(s.file) === f);
}

function symbolForName(finalName: string): SymbolInfo | undefined {
  return lastAnalysis?.symbols.find((s) => s.finalName === finalName);
}

/** Resolve a name on an `import` (or legacy `use`) line to its declaration. */
function importTargetAt(file: string, pos: Position): SymbolInfo | null {
  const text = textOf(file);
  const line = (text.split("\n")[pos.line] ?? "");
  const m = /^\s*(?:use|import)\s+([A-Za-z0-9_.:]+)/.exec(line);
  if (!m) return null;
  const word = wordAt(text, offsetAt(text, pos)).word;
  if (!word) return null;
  const parts = m[1]!.split(/::|\./).filter(Boolean);
  const moduleName = parts[parts.length - 1] ?? m[1]!;
  const cands = (lastAnalysis?.symbols ?? []).filter((s) => s.name === word);
  if (!cands.length) return null;
  return cands.find((s) => s.display === `${moduleName}.${word}`)
    ?? cands.find((s) => s.display.endsWith(`.${word}`) && s.display.includes(moduleName))
    ?? cands[0]!;
}

const BUILTIN_TYPE_DOC: Record<string, string> = {
  Html: "Client-rendered markup tree.",
  Int: "Integer.",
  Float: "Floating-point number.",
  Str: "Text string.",
  Bool: "`true` or `false`.",
  Unit: "The empty value, written `()`.",
  List: "A built-in list, written `List a`.",
  Cell: "Client-local reactive state.",
  Event: "A DOM event.",
  Dom: "A DOM handle.",
};

/** `data Shape = …`, `type User = { … }`, etc. for hover. */
function renderTypeDecl(d: Decl): string | null {
  const params = (p: string[] | undefined) => (p && p.length ? " " + p.join(" ") : "");
  const name = (n: string) => n.replace(/\$[A-Za-z0-9_$]+$/, "");
  const sig = (s: FnSig) =>
    `${s.name} :: ${s.params.map((p) => printType(p.type)).join(" -> ")}${s.ret ? " -> " + printType(s.ret) : ""}`;
  switch (d.k) {
    case "Adt":
      return `data ${name(d.name)}${params(d.params)} = ` +
        d.variants.map((v) => v.args.length ? `${v.name} ${v.args.map((t) => printType(t)).join(" ")}` : v.name).join(" | ");
    case "RecordType":
      return `type ${name(d.name)}${params(d.params)} = { ` +
        d.fields.map((f) => `${f.name} :: ${printType(f.type)}`).join(", ") + " }";
    case "Alias":
      return `type ${name(d.name)}${params(d.params)} = ${printType(d.type)}`;
    case "Trait":
      return `class ${name(d.name)}${params(d.params)} where\n  ` +
        d.methods.map(sig).join("\n  ");
    case "Effect":
      return `effect ${name(d.name)}${d.place ? ` @${d.place}` : ""} where\n  ` +
        d.ops.map(sig).join("\n  ");
    default:
      return null;
  }
}

/** Type names in annotations are not expression nodes; resolve them by word. */
function typeHoverAt(file: string, pos: Position) {
  const a = lastAnalysis;
  if (!a) return null;
  const text = textOf(file);
  const word = wordAt(text, offsetAt(text, pos));
  if (!word.word) return null;
  const curUnit = (a.units ?? []).find((u) => path.resolve(u.file) === path.resolve(file));
  const typeKinds = new Set(["type", "record", "alias", "trait", "effect"]);
  const cands = (a.symbols ?? []).filter((s) => s.name === word.word && typeKinds.has(s.kind));
  if (!cands.length) return null;
  const sym = cands.find((s) => s.unit === curUnit?.id) ?? cands.find((s) => s.public) ?? cands[0]!;
  const decl = (a.program?.decls ?? []).find((d) =>
    (d.k === "Adt" || d.k === "RecordType" || d.k === "Alias" || d.k === "Trait" || d.k === "Effect") &&
    d.name === sym.finalName
  );
  const code = decl ? renderTypeDecl(decl) : null;
  const builtin = BUILTIN_TYPE_DOC[word.word];
  if (!code && !builtin) return null;
  const block = code ? `\`\`\`flow\n${code}\n\`\`\`\n\n` : "";
  const note = builtin ? `${builtin}\n\n` : "";
  const where = sym.unit === "" ? "Built-in type." : `Declared in \`${sym.display}\` (${sym.kind}).`;
  return {
    contents: { kind: "markdown", value: `**Type** \`${word.word}\`\n\n${block}${note}${where}` },
    range: { start: offsetToPosition(text, word.start), end: offsetToPosition(text, word.end) },
  };
}

function definition(file: string, pos: Position) {
  const node = nodeAt(file, pos);
  const text = textOf(file);
  const word = wordAt(text, offsetAt(text, pos)).word;
  const sym = (node?.ident ? symbolForName(node.ident) : undefined)
    ?? (word ? (lastAnalysis?.symbols ?? []).find((s) => s.name === word) : undefined)
    ?? importTargetAt(file, pos);
  if (!sym) return null;
  return { uri: pathToUri(sym.file), range: sym.range };
}

function occurrences(finalName: string, limitFile?: string) {
  const out: { uri: string; range: Range }[] = [];
  for (const n of lastAnalysis?.nodes ?? []) {
    if (n.ident !== finalName) continue;
    if (limitFile && path.resolve(n.file) !== path.resolve(limitFile)) continue;
    out.push({ uri: pathToUri(n.file), range: n.range });
  }
  return out;
}

type Range = { start: Position; end: Position };

/* ------------------------------------------------------------------ */
/* locals (for completion, rename, highlights)                        */
/* ------------------------------------------------------------------ */

interface Local { name: string; type: string; place: string; range: Range; declSpan: number }

function collectLocal(d: unknown, out: Local[], file: string, text: string) {
  const push = (name: string, span: { start: number; end: number; line?: number; col?: number; file?: string }, type: string, place: string) => {
    if (span.file && path.resolve(span.file) !== path.resolve(file)) return;
    const start = span.start;
    const at = text.indexOf(name, start);
    const from = at >= 0 ? at : start;
    out.push({
      name, type, place, declSpan: start,
      range: { start: offsetToPosition(text, from), end: offsetToPosition(text, from + name.length) },
    });
  };
  const visit = (e: Expr) => {
    switch (e.k) {
      case "Lam":
        for (const p of e.params) push(p.name, e.span, typeText(p.type), "neutral");
        visit(e.body);
        return;
      case "Let":
        push(e.name, e.span, "", "neutral");
        visit(e.value); visit(e.body);
        return;
      case "Block":
        for (const s of e.stmts) {
          if (s.k === "LetStmt") { push(s.name, s.span, "", "neutral"); visit(s.value); }
          else visit(s.e);
        }
        if (e.value) visit(e.value);
        return;
      case "Match":
        visit(e.scrut);
        for (const a of e.arms) {
          const walk = (p: unknown) => {
            const q = p as { k: string; name?: string; items?: unknown[]; args?: unknown[]; fields?: { pat: unknown }[]; rest?: string };
            if (q.k === "PVar" && q.name) push(q.name, a.pat.span, "", "neutral");
            if (q.items) q.items.forEach(walk);
            if (q.args) q.args.forEach(walk);
            if (q.fields) q.fields.forEach((f) => walk(f.pat));
            if (q.rest) push(q.rest, a.pat.span, "", "neutral");
          };
          walk(a.pat);
          visit(a.body);
        }
        return;
      case "App": visit(e.fn); e.args.forEach(visit); return;
      case "If": visit(e.cond); visit(e.then); visit(e.else); return;
      case "Binary": visit(e.l); visit(e.r); return;
      case "Assign": visit(e.target); if (e.value) visit(e.value); return;
      case "Unary": visit(e.e); return;
      case "Tuple": case "List": e.items.forEach(visit); return;
      case "Ctor": e.args.forEach(visit); return;
      case "Record": e.fields.forEach((f) => visit(f.value)); return;
      case "Field": visit(e.target); return;
      case "Html": for (const n of htmlExprs(e)) visit(n); return;
      case "Lit": case "Var": return;
    }
  };
  visit(d as Expr);
  void out;
}

function htmlExprs(e: Expr): Expr[] {
  const out: Expr[] = [];
  const walk = (nodes: unknown[]) => {
    for (const n of nodes as { k: string; e?: Expr; attrs?: { value: { k: string; e?: Expr } }[]; children?: unknown[] }[]) {
      if (n.k === "Hole" && n.e) out.push(n.e);
      for (const a of n.attrs ?? []) if (a.value.k === "expr" && a.value.e) out.push(a.value.e);
      if (n.children) walk(n.children);
    }
  };
  walk(e.nodes);
  return out;
}

function typeText(t: unknown): string {
  const ty = t as { k: string; name?: string; args?: unknown[]; items?: unknown[] };
  if (!ty) return "";
  if (ty.k === "TCon") return ty.args?.length ? `${ty.name}<${ty.args.map(typeText).join(", ")}>` : String(ty.name);
  if (ty.k === "TVar") return "a";
  return "?";
}

function declContaining(program: Program, file: string, offset: number): Decl | null {
  for (const d of program.decls) {
    const span = (d as { span?: { start: number; end: number; file?: string } }).span;
    if (!span || (span.file && path.resolve(span.file) !== path.resolve(file))) continue;
    if (offset >= span.start && offset <= span.end) return d;
  }
  return null;
}

function localsAt(file: string, pos: Position): Local[] {
  const a = lastAnalysis;
  if (!a?.program) return [];
  const text = textOf(file);
  const off = offsetAt(text, pos);
  const decl = declContaining(a.program, file, off);
  if (!decl) return [];
  const locals: Local[] = [];
  if (decl.k === "Fn") collectLocal(decl.body, locals, file, text);
  else if (decl.k === "Impl") for (const m of decl.methods) collectLocal(m.body, locals, file, text);
  return locals.filter((l) => l.declSpan <= off);
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
  const rank = (r: Region) => r.kind === "cut" ? 2 : r.kind === "crossing" ? 1 : 0;
  for (const r of regions) {
    const after = line > r.range.start.line || (line === r.range.start.line && character >= r.range.start.character);
    const before = line < r.range.end.line || (line === r.range.end.line && character <= r.range.end.character);
    if (after && before && (!best || rank(r) > rank(best))) best = r;
  }
  return best;
}

/** The innermost cut/crossing region at a position, if any. */
function boundaryAt(file: string, pos: Position): Region | null {
  const regions = (lastAnalysis?.regions ?? []).filter((r) =>
    path.resolve(r.file) === path.resolve(file) && (r.kind === "cut" || r.kind === "crossing"));
  let best: Region | null = null;
  const size = (r: Region) =>
    (r.range.end.line - r.range.start.line) * 10000 + (r.range.end.character - r.range.start.character);
  for (const r of regions) {
    const after = pos.line > r.range.start.line || (pos.line === r.range.start.line && pos.character >= r.range.start.character);
    const before = pos.line < r.range.end.line || (pos.line === r.range.end.line && pos.character <= r.range.end.character);
    if (after && before && (!best || size(r) < size(best))) best = r;
  }
  return best;
}

function semanticTokens(uri: string): { data: number[] } {
  const file = path.resolve(uriToPath(uri));
  const text = textOf(uri);
  const regions = (lastAnalysis?.regions ?? []).filter((r) => path.resolve(r.file) === file);
  const toks: { line: number; char: number; len: number; type: number; mods: number }[] = [];

  let lexed: Token[] = [];
  try { lexed = lex(text, file); } catch { lexed = []; }

  for (let i = 0; i < lexed.length; i++) {
    const t = lexed[i]!;
    if (t.kind === "eof") continue;
    let type = -1, mods = 0;
    const prev = lexed[i - 1];
    if (t.kind === "kw") type = 0;
    else if (t.kind === "str") type = 5;
    else if (t.kind === "num" || t.kind === "float") type = 6;
    else if (t.kind === "sym") type = 8;
    else if (t.kind === "Con") type = 3;
    else if (t.kind === "id") {
      // a name beside `::` or `=` starts a definition; `f x` is a call
      const next = lexed[i + 1];
      type = 9;
      if (next && (next.value === "::" || next.value === "=")) type = 1;
      if (prev && (prev.value === "->" || prev.value === "|")) type = 1;
    }
    if (type < 0) continue;
    const region = inRegion(regions, t.line - 1, t.col - 1);
    if (region) {
      if (region.side === "client") mods |= 1;
      if (region.side === "server") mods |= 2;
      if (region.kind === "cut") mods |= 12;
      else if (region.kind === "crossing") mods |= 8;
    }
    toks.push({ line: t.line - 1, char: t.col - 1, len: t.value.length, type, mods });
  }

  const re = /--[^\n]*|\{-[\s\S]*?-\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(0, m.index);
    const line = before.split("\n").length - 1;
    toks.push({ line, char: m.index - (before.lastIndexOf("\n") + 1), len: m[0].length, type: 7, mods: 0 });
  }

  toks.sort((a, b) => a.line - b.line || a.char - b.char);
  const data: number[] = [];
  let pl = 0, pc = 0;
  for (const t of toks) {
    const dl = t.line - pl;
    data.push(dl, dl === 0 ? t.char - pc : t.char, t.len, t.type, t.mods);
    pl = t.line; pc = t.char;
  }
  return { data };
}

/* ------------------------------------------------------------------ */
/* completion                                                         */
/* ------------------------------------------------------------------ */

const KEYWORDS = [
  "module", "import", "as", "data", "type", "class", "instance", "where", "let", "in",
  "if", "then", "else", "case", "of", "do", "effect", "algebraic", "provide", "handle",
  "with", "for", "foreign",
];

const HTML_TAGS = [
  "div", "span", "p", "h1", "h2", "h3", "h4", "h5", "h6", "button", "input", "textarea",
  "ul", "ol", "li", "a", "img", "section", "header", "footer", "main", "nav", "aside",
  "form", "label", "table", "thead", "tbody", "tr", "td", "th", "strong", "em", "code",
  "pre", "hr", "br", "figure", "figcaption", "details", "summary", "select", "option",
];

const HTML_ATTRS = [
  "class", "id", "style", "href", "src", "value", "placeholder", "title", "type",
  "disabled", "checked", "selected", "name", "target", "alt", "width", "height",
  "onClick", "onInput", "onChange", "onSubmit", "onKeyDown", "onKeyUp", "onFocus",
  "onBlur", "onMouseEnter", "onMouseLeave",
];

/** Are we in markup position inside an `html { … }` block?
 *  depth 1 = directly in markup; depth ≥ 2 = inside a `{expr}` hole. */
function htmlContext(before: string): { inside: boolean; depth: number; inTag: boolean; afterLt: boolean } {
  // markup is bare syntax, so decide from the current line: `<di` or `<div ` is a tag
  const line = before.slice(before.lastIndexOf("\n") + 1);
  const afterLt = /<([A-Za-z][\w-]*)?$/.test(line);
  const inTag = /<[A-Za-z][\w-]*\s+[^<>]*$/.test(line) || afterLt;
  const inside = afterLt || inTag;
  return { inside, depth: inside ? 1 : 0, inTag, afterLt };
}

const KEYWORD_DOC: Record<string, string> = {
  module: "module Name (exported, names) where  — private by default",
  import: "import Module (name)",
  data: "data Name a = Variant T | Other",
  type: "type Name = T  — an alias; `{ field :: T }` for a record",
  class: "class Name a where\n  method :: a -> T",
  instance: "instance Name T where\n  method x = …",
  let: "let name = value in expression",
  if: "if condition then a else b",
  case: "case value of\n  Pattern -> expression",
  do: "do\n  x <- action\n  result",
  effect: "effect Name @ client|server where\n  op :: T -> R",
  algebraic: "algebraic effect Name where\n  op :: T -> R",
  provide: "provide Effect where\n  op x = …",
  handle: "handle Effect with\n  op x = resume x\nin body",
  foreign: 'foreign import js unsafe "Math.floor" name :: Float -> Int',
  where: "where  — bind helpers under a clause",
};

const KEYWORD_SNIPPETS: Record<string, string> = {
  module: "module ${1:Name} (${2}) where\n\n${0}",
  import: "import ${1:Module} (${2:name})",
  data: "data ${1:Name} = ${2:Variant} ${3:Type}",
  type: "type ${1:Name} = ${2:T}",
  class: "class ${1:Name} a where\n\t${2:method} :: a -> ${3:Type}",
  instance: "instance ${1:Name} ${2:T} where\n\t${3:method} x = ${0}",
  let: "let ${1:name} = ${2:value} in ${0}",
  if: "if ${1:condition} then ${2:a} else ${3:b}",
  case: "case ${1:value} of\n\t${2:Pattern} -> ${0}",
  do: "do\n\t${1:x} <- ${2:action}\n\t${0}",
  effect: "effect ${1:Name} @ ${2|client,server|} where\n\t${3:op} :: ${4:Type}",
  algebraic: "algebraic effect ${1:Name} where\n\t${2:op} :: ${3:Type}",
  provide: "provide ${1:Effect} where\n\t${2:op} ${3:x} = ${0}",
  handle: "handle ${1:Effect} with\n\t${2:op} ${3:x} = resume ${3:x}\nin ${0}",
  foreign: "foreign import js unsafe \"${1:Math.floor}\" ${2:name} :: ${3:Type}",
};

function completion(file: string, pos: Position) {
  const text = textOf(file);
  const off = offsetAt(text, pos);
  const before = text.slice(0, off);

  // a module qualifier is capitalised (`Option.`, `FlowCharts.Bar.`) and may
  // already have a partial member (`Time.no`); `props.r.` is a field
  const qualifier = /((?:[A-Z][A-Za-z0-9_]*\.)+)([A-Za-z0-9_']*)\s*$/.exec(before);
  const dot = /([A-Za-z0-9_.()]+)\.\s*$/.exec(before);
  const prefixMatch = /[A-Za-z0-9_']*$/.exec(before);
  const prefix = prefixMatch ? prefixMatch[0] : "";

  // Module members: `Option.map`, `List.`, `Time.no`
  if (qualifier) {
    const q = qualifier[1]!;
    const memberPrefix = qualifier[2] ?? "";
    const a = lastAnalysis;
    const modules = a?.modules ?? stdModules();
    const curUnit = (a?.units ?? []).find((u) => path.resolve(u.file) === path.resolve(file));
    const prefixLower = memberPrefix.toLowerCase();
    const seen = new Set<string>();
    const items: Record<string, unknown>[] = [];

    const add = (name: string, kind: number, detail: string, sort: string) => {
      if (memberPrefix && !name.toLowerCase().startsWith(prefixLower)) return;
      if (seen.has(name)) return;
      seen.add(name);
      items.push({
        label: name,
        kind,
        detail,
        documentation: { kind: "markdown", value: `\`${detail}\`` },
        sortText: sort + name,
      });
    };
    // loaded modules carry real declaration sites; only exported names belong
    // to `Module.` (private helpers stay inside their module)
    for (const s of a?.symbols ?? []) {
      if (!s.public && s.unit !== curUnit?.id) continue;
      if (!s.display.startsWith(q)) continue;
      const rest = s.display.slice(q.length);
      if (!rest || rest.includes(".")) continue;
      add(s.name, symbolKind(s.kind), s.display, "0");
    }
    // std modules the program has not imported yet come from the cheap index
    for (const m of modules) {
      const disp = moduleNameOf(m);
      if (`${disp}.` !== q) continue;
      for (const mem of m.members) add(mem.name, symbolKind(mem.kind), `${disp}.${mem.name}`, "0");
    }
    return { isIncomplete: false, items };
  }

  // Field access: `props.` / `cell.`
  if (dot) {
    const recvEnd = off - (dot[0].length - dot[1]!.length);
    const recvPos = offsetToPosition(text, Math.max(0, recvEnd));
    const node = nodeAt(file, { line: recvPos.line, character: recvPos.character });
    const fields = node?.fields ?? [];
    const items = fields.map((f) => ({ label: f, kind: 5, detail: "field", sortText: "0" + f }));
    if (node?.cellElem) {
      items.unshift(
        { label: "value", kind: 5, detail: node.cellElem, sortText: "0value" },
        { label: "get", kind: 2, detail: `() -> ${node.cellElem}`, sortText: "0get" },
        { label: "set", kind: 2, detail: `(${node.cellElem}) -> Unit`, sortText: "0set" },
        { label: "update", kind: 2, detail: `((${node.cellElem}) -> ${node.cellElem}) -> Unit`, sortText: "0update" },
      );
    }
    return { isIncomplete: false, items };
  }

  // Markup: inside `html { … }` (but not inside a `{expr}` hole)
  const h = htmlContext(before);
  if (h.inside && h.depth === 1) {
    if (h.inTag && !h.afterLt) {
      return {
        isIncomplete: false,
        items: HTML_ATTRS
          .filter((a) => !prefix || a.toLowerCase().startsWith(prefix.toLowerCase()))
          .map((a) => ({
            label: a,
            kind: a.startsWith("on") ? 5 : 9,
            detail: a.startsWith("on") ? "event handler" : "attribute",
            sortText: "0" + a,
          })),
      };
    }
    const components = (lastAnalysis?.symbols ?? [])
      .filter((s) => s.kind === "function")
      .map((s) => ({ label: s.name, kind: 3, detail: "component", sortText: "1" + s.name }));
    return {
      isIncomplete: false,
      items: [
        ...HTML_TAGS.filter((t) => !prefix || t.startsWith(prefix)).map((t) => ({
          label: t, kind: 10, detail: "tag", sortText: "0" + t,
        })),
        ...components.filter((c) => !prefix || c.label.startsWith(prefix)),
      ],
    };
  }

  const items: unknown[] = [];
  for (const k of KEYWORDS) {
    if (prefix && !k.startsWith(prefix)) continue;
    const snippet = KEYWORD_SNIPPETS[k];
    const item: Record<string, unknown> = {
      label: k, kind: 15, detail: "keyword", documentation: KEYWORD_DOC[k], sortText: "3" + k,
    };
    if (snippet) {
      // `fn`, `match`, `html`, … expand into a skeleton the user fills in
      item.insertText = snippet;
      item.insertTextFormat = 2;
      item.kind = 14;
    }
    items.push(item);
  }
  for (const l of localsAt(file, pos)) {
    if (prefix && !l.name.startsWith(prefix)) continue;
    items.push({ label: l.name, kind: 6, detail: l.type || "local", sortText: "0" + l.name });
  }
  const curUnit = (lastAnalysis?.units ?? []).find((u) => path.resolve(u.file) === path.resolve(file));
  const imported = lastAnalysis?.importedByFile?.get(path.resolve(file)) ?? new Set<string>();
  const lastUseLine = text.split("\n").reduce((acc, l, i) => (l.startsWith("import ") ? i : acc), -1);
  const prefixLower = prefix.toLowerCase();
  const seenSymbols = new Set<string>();

  for (const s of lastAnalysis?.symbols ?? []) {
    const currentUnit = s.unit === curUnit?.id;
    if (!s.public && !currentUnit) continue;
    if (prefix) {
      const name = s.name.toLowerCase();
      if (!name.startsWith(prefixLower) && !name.includes(prefixLower)) continue;
    }
    const key = `${s.name}|${s.display}`;
    if (seenSymbols.has(key)) continue;
    seenSymbols.add(key);
    const inScope = currentUnit || imported.has(s.finalName);
    const prefixRank = s.name.toLowerCase().startsWith(prefixLower) ? "0" : "1";
    const item: Record<string, unknown> = {
      label: s.name,
      kind: symbolKind(s.kind),
      detail: inScope ? s.kind : `${s.kind} · ${s.display.split(".").slice(0, -1).join(".")}`,
      documentation: { kind: "markdown", value: `\`${s.display}\`` },
      sortText: (inScope ? "1" : "2") + prefixRank + s.name,
    };
    if (!inScope) {
      // completing a name from another module inserts its import
      const dir = s.display.split(".").slice(0, -1).join(".");
      const at = { line: lastUseLine + 1, character: 0 };
      item.additionalTextEdits = [{
        range: { start: at, end: at },
        newText: `import ${dir} (${s.name})\n`,
      }];
    }
    items.push(item);
  }

  // Public std members from modules this file does not import yet. The cheap
  // index keeps this working without compiling the whole standard library.
  const loaded = new Set((lastAnalysis?.units ?? []).map((u) => u.id));
  for (const m of lastAnalysis?.modules ?? []) {
    if (loaded.has(m.id)) continue;
    for (const mem of m.members) {
      if (prefix) {
        const name = mem.name.toLowerCase();
        if (!name.startsWith(prefixLower) && !name.includes(prefixLower)) continue;
      }
      const key = `${mem.name}|${m.id}`;
      if (seenSymbols.has(key)) continue;
      seenSymbols.add(key);
      const at = { line: lastUseLine + 1, character: 0 };
      items.push({
        label: mem.name,
        kind: symbolKind(mem.kind),
        detail: `${mem.kind} · ${moduleNameOf(m)}`,
        documentation: { kind: "markdown", value: `\`${moduleNameOf(m)}.${mem.name}\`` },
        sortText: `2${mem.name.toLowerCase().startsWith(prefixLower) ? "0" : "1"}${mem.name}`,
        additionalTextEdits: [{
          range: { start: at, end: at },
          newText: `import ${moduleNameOf(m)} (${mem.name})\n`,
        }],
      });
    }
  }
  return { isIncomplete: false, items };
}

/* ------------------------------------------------------------------ */
/* signature help                                                     */
/* ------------------------------------------------------------------ */

function signatureHelp(file: string, pos: Position) {
  const a = lastAnalysis;
  if (!a) return null;
  const f = path.resolve(file);
  // the innermost *call* containing the cursor (the innermost node is often the callee)
  const call = a.nodes
    .filter((n) => n.signature && path.resolve(n.file) === f && contains(n.range, pos))
    .sort((x, y) => spanSize(x.range) - spanSize(y.range))[0];
  if (!call?.signature) return null;
  const text = textOf(file);
  const off = offsetAt(text, pos);
  // count commas since the opening paren to pick the active parameter
  let depth = 0, commas = 0;
  for (let i = off - 1; i >= 0 && off - i < 400; i--) {
    const c = text[i];
    if (c === ")") depth++;
    else if (c === "(") { if (depth === 0) break; depth--; }
    else if (c === "," && depth === 0) commas++;
  }
  const sig = call.signature;
  // Haskell-style signature: `tally :: List Int -> Int`
  const typeText = sig.params.length ? `${sig.params.map((p) => p.type).join(" -> ")} -> ${sig.ret}` : sig.ret;
  const effect = sig.effects.length ? ` ! {${sig.effects.join(", ")}}` : "";
  return {
    signatures: [{
      label: `${sig.name} :: ${typeText}${effect}`,
      documentation: sig.params.length ? `parameters: ${sig.params.map((p) => p.name).join(", ")}` : undefined,
      parameters: sig.params.map((p) => ({ label: p.type })),
    }],
    activeSignature: 0,
    activeParameter: Math.min(commas, Math.max(0, sig.params.length - 1)),
  };
}

/* ------------------------------------------------------------------ */
/* inlay hints                                                        */
/* ------------------------------------------------------------------ */

function inlayHints(file: string): unknown[] {
  const a = lastAnalysis;
  if (!a?.program) return [];
  const text = textOf(file);
  const f = path.resolve(file);
  const hints: unknown[] = [];

  for (const d of a.program.decls) {
    const span = (d as { span?: { start: number; end: number; file?: string } }).span;
    if (!span || (span.file && path.resolve(span.file) !== f)) continue;
    if (d.k !== "Fn") continue;

    const at = text.indexOf(d.name, span.start);
    const p = offsetToPosition(text, at >= 0 ? at : span.start);
    const region = a.regions.find((r) =>
      r.kind === "function" &&
      r.range.start.line === p.line &&
      r.range.start.character <= p.character);
    if (!region) continue;
    hints.push({
      position: { line: p.line, character: p.character + d.name.length },
      label: ` ${region.side}`,
      kind: 1,
      paddingLeft: true,
      tooltip: `runs on the ${region.side}`,
    });
  }

  // cut markers: one inline hint at the end of every inferred cut
  for (const r of a.regions) {
    if (r.kind !== "cut") continue;
    if (path.resolve(r.file) !== f) continue;
    hints.push({
      position: r.range.end,
      label: ` ${r.cutId ?? "cut"}→${r.side}`,
      kind: 1,
      paddingLeft: true,
      paddingRight: false,
      tooltip: r.label,
    });
  }

  // inferred types for unannotated `let` bindings
  const addBinding = (
    name: string,
    stmtSpan: { start: number },
    valueSpan: { start: number; end: number; line: number; col: number; file?: string },
    annotated: boolean,
  ) => {
    if (annotated) return;
    const wanted = spanRange(text, valueSpan);
    const node = a.nodes.find((n) =>
      path.resolve(n.file) === f &&
      n.range.start.line === wanted.start.line &&
      n.range.start.character === wanted.start.character &&
      n.range.end.line === wanted.end.line &&
      n.range.end.character === wanted.end.character);
    if (!node) return;
    const atName = text.indexOf(name, stmtSpan.start);
    if (atName < 0) return;
    const p = offsetToPosition(text, atName + name.length);
    hints.push({
      position: p,
      label: `: ${node.type}`,
      kind: 1,
      paddingLeft: true,
      tooltip: "inferred type",
    });
  };

  const walk = (e: unknown) => {
    if (!e || typeof e !== "object") return;
    const n = e as Record<string, unknown> & { k?: string };
    const espan = n.span as { file?: string } | undefined;
    if (espan?.file && path.resolve(espan.file) !== f) return;
    switch (n.k) {
      case "Let":
        addBinding(n.name as string, n.span as { start: number }, (n.value as { span: { line: number; col: number } }).span, !n.ann);
        walk(n.value); walk(n.body);
        return;
      case "Block":
        for (const s of (n.stmts as unknown[]) ?? []) {
          const st = s as { k: string; name?: string; ann?: unknown; value?: unknown; e?: unknown; span: { start: number } };
          if (st.k === "LetStmt") {
            const v = st.value as { span: { line: number; col: number } };
            addBinding(st.name!, st.span, v.span, !!st.ann);
            walk(st.value);
          } else walk(st.e);
        }
        walk(n.value);
        return;
      case "Lam": walk(n.body); return;
      case "App": walk(n.fn); for (const x of (n.args as unknown[]) ?? []) walk(x); return;
      case "If": walk(n.cond); walk(n.then); walk(n.else); return;
      case "Match": walk(n.scrut); for (const a2 of (n.arms as unknown[]) ?? []) walk((a2 as { body: unknown }).body); return;
      case "Binary": walk(n.l); walk(n.r); return;
      case "Assign": walk(n.target); if (n.value) walk(n.value); return;
      case "Unary": walk(n.e); return;
      case "Tuple": case "List": for (const x of (n.items as unknown[]) ?? []) walk(x); return;
      case "Ctor": for (const x of (n.args as unknown[]) ?? []) walk(x); return;
      case "Record": for (const x of (n.fields as { value: unknown }[]) ?? []) walk(x.value); return;
      case "Field": walk(n.target); return;
      case "Html":
        for (const x of htmlExprs(n as never)) walk(x);
        return;
      default: return;
    }
  };
  for (const d of a.program.decls) {
    const body = (d as { body?: unknown }).body;
    if (body) walk(body);
  }
  return hints;
}

/* ------------------------------------------------------------------ */
/* folding / selection / highlights                                   */
/* ------------------------------------------------------------------ */

function foldingRanges(file: string) {
  const text = textOf(file);
  const lines = text.split("\n");
  const ranges: unknown[] = [];
  // layout blocks: `do`, `case … of`, `where`, `let` fold to the end of their indented run
  const indentOf = (l: string) => l.length - l.trimStart().length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!/(\bdo|\bof|\bwhere|\blet)\s*(--.*)?$/.test(line.replace(/\s+$/, ""))) continue;
    const base = indentOf(line);
    let end = i;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (!l.trim()) continue;
      if (indentOf(l) <= base) break;
      end = j;
    }
    if (end > i) ranges.push({ startLine: i, endLine: end, kind: "region" });
  }
  // markup: an element that spans lines folds to its closing tag
  const openTag = /<([A-Za-z][\w-]*)(?:\s[^>]*)?>\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const m = openTag.exec(lines[i]!);
    if (!m) continue;
    const tag = m[1]!;
    for (let j = i + 1; j < lines.length; j++) {
      if (new RegExp(`</${tag}>`).test(lines[j]!)) {
        if (j > i) ranges.push({ startLine: i, endLine: j, kind: "region" });
        break;
      }
    }
  }
  // comment blocks
  const re = /\{-[\s\S]*?-\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = text.slice(0, m.index).split("\n").length - 1;
    const end = start + m[0].split("\n").length - 1;
    if (end > start) ranges.push({ startLine: start, endLine: end, kind: "comment" });
  }
  return ranges;
}

function selectionRanges(file: string, positions: Position[]) {
  const a = lastAnalysis;
  const f = path.resolve(file);
  return positions.map((pos) => {
    const ranges = (a?.nodes ?? [])
      .filter((n) => path.resolve(n.file) === f && contains(n.range, pos))
      .map((n) => n.range)
      .sort((x, y) => spanSize(y) - spanSize(x));
    // collapse duplicates
    const unique: Range[] = [];
    for (const r of ranges) {
      if (!unique.length || spanSize(r) !== spanSize(unique[unique.length - 1]!)) unique.push(r);
    }
    let parent: unknown = undefined;
    for (let i = unique.length - 1; i >= 0; i--) parent = { start: unique[i]!.start, end: unique[i]!.end, parent };
    return parent ?? { start: pos, end: pos };
  });
}

function contains(r: Range, p: Position): boolean {
  const after = p.line > r.start.line || (p.line === r.start.line && p.character >= r.start.character);
  const before = p.line < r.end.line || (p.line === r.end.line && p.character <= r.end.character);
  return after && before;
}

const spanSize = (r: Range) => (r.end.line - r.start.line) * 100000 + (r.end.character - r.start.character);

function documentHighlights(file: string, pos: Position) {
  const node = nodeAt(file, pos);
  if (!node?.ident) return [];
  const a = lastAnalysis;
  return (a?.nodes ?? [])
    .filter((n) => n.ident === node.ident && path.resolve(n.file) === path.resolve(file))
    .map((n) => ({ range: n.range, kind: 1 }));
}

/* ------------------------------------------------------------------ */
/* formatting                                                         */
/* ------------------------------------------------------------------ */

/** Layout-sensitive code is indentation-driven, so formatting only normalises
 *  trailing whitespace and the final newline; it never re-indents. */
function format(file: string) {
  const text = textOf(file);
  const lines = text.split("\n");
  const out = lines.map((l) => l.replace(/[ \t]+$/, ""));
  while (out.length && out[out.length - 1] === "") out.pop();
  return [{ range: { start: { line: 0, character: 0 }, end: { line: lines.length, character: 0 } }, newText: out.join("\n") + "\n" }];
}

/* ------------------------------------------------------------------ */
/* code actions / lenses / rename                                     */
/* ------------------------------------------------------------------ */

function codeActions(file: string, range: Range, diagnostics: { message: string }[]) {
  const a = lastAnalysis;
  const actions: unknown[] = [];
  const text = textOf(file);
  const lines = text.split("\n");

  // "make it public": the declaration whose span covers the cursor line
  const startLine = range?.start?.line ?? 0;
  const sym = symbolsInFile(file).find((s) =>
    s.range.start.line <= startLine && s.range.end.line >= startLine);
  if (sym) {
    actions.push({
      title: `Export '${sym.name}' from this module`,
      kind: "refactor.rewrite",
      edit: { changes: { [pathToUri(file)]: [exportEdit(file, text, sym.name)] } },
    });
  }

  // "import 'x'" for unbound names
  for (const d of diagnostics ?? []) {
    const m = /unbound name '([A-Za-z_][A-Za-z0-9_]*)'/.exec(d.message);
    if (!m) continue;
    const name = m[1]!;
    const target = (a?.symbols ?? []).find((s) => s.name === name);
    if (!target) continue;
    const modPath = target.display.split(".").slice(0, -1).join(".");
    if (!modPath) continue;
    const lastUse = lines.reduce((acc, l, i) => (l.startsWith("import ") ? i : acc), -1);
    const at = { line: lastUse + 1, character: 0 };
    actions.push({
      title: `Import '${name}' from ${modPath}`,
      kind: "quickfix",
      edit: { changes: { [pathToUri(file)]: [{ range: { start: at, end: at }, newText: `import ${modPath} (${name})\n` }] } },
    });
  }
  return actions;
}

/** Add `name` to the module export list, creating the header when there is none. */
function exportEdit(file: string, text: string, name: string): { range: Range; newText: string } {
  const lines = text.split("\n");
  const header = lines.findIndex((l) => l.startsWith("module "));
  if (header >= 0) {
    const close = lines[header]!.lastIndexOf(")");
    const at = { line: header, character: close > 0 ? close : lines[header]!.length };
    return { range: { start: at, end: at }, newText: close > 0 ? `, ${name}` : ` (${name})` };
  }
  const start = { line: 0, character: 0 };
  const fileName = path.basename(file).replace(/\.flow$/, "").replace(/^./, (c) => c.toUpperCase());
  return { range: { start, end: start }, newText: `module ${fileName} (${name}) where\n\n` };
}

function codeLens(file: string) {
  const a = lastAnalysis;
  if (!a) return [];
  const lenses: unknown[] = [];
  for (const sym of symbolsInFile(file)) {
    if (sym.kind !== "function") continue;
    const region = a.regions.find((r) => r.kind === "function" && r.range.start.line === sym.range.start.line);
    const cuts = a.regions.filter((r) => r.kind === "cut"
      && r.range.start.line >= sym.range.start.line
      && r.range.start.line <= (a.regions.find((x) => x.kind === "function" && x.range.start.line === sym.range.start.line)?.range.end.line ?? sym.range.end.line));
    const crossings = a.regions.filter((r) => r.kind === "crossing"
      && r.range.start.line >= sym.range.start.line
      && r.range.start.line <= (a.regions.find((x) => x.kind === "function" && x.range.start.line === sym.range.start.line)?.range.end.line ?? sym.range.end.line));
    const cutsText = `${cuts.length} cut${cuts.length === 1 ? "" : "s"}`;
    const crossText = crossings.length ? ` · ${crossings.length} crossing${crossings.length === 1 ? "" : "s"}` : "";
    const title = `${region ? `${region.side} · ` : ""}${cutsText}${crossText}`;
    lenses.push({
      range: sym.range,
      command: { title, command: "flow.cutInfo", arguments: [sym.display ?? sym.name] },
    });
  }
  return lenses;
}

function rename(file: string, pos: Position, newName: string) {
  const node = nodeAt(file, pos);
  if (!node?.ident) return null;
  if (!/^[A-Za-z_][A-Za-z0-9_']*$/.test(newName)) return null;

  const a = lastAnalysis;
  const isGlobal = !!symbolForName(node.ident);
  const text = textOf(file);
  const off = offsetAt(text, pos);
  const decl = a?.program ? declContaining(a.program, file, off) : null;
  const span = (decl as { span?: { start: number; end: number } } | null)?.span;

  const changes: Record<string, unknown[]> = {};
  const occ = isGlobal || !span ? occurrences(node.ident) : occurrences(node.ident, file);
  if (!occ.length) return null;
  for (const o of occ) {
    if (!isGlobal && span) {
      // a local: stay inside the declaration that binds it
      const startLine = offsetToPosition(text, span.start).line;
      const endLine = offsetToPosition(text, span.end).line;
      if (o.range.start.line < startLine || o.range.start.line > endLine) continue;
    }
    (changes[o.uri] ??= []).push({ range: o.range, newText: newName });
  }
  return { changes };
}

function documentLinks(file: string) {
  const a = lastAnalysis;
  if (!a) return [];
  const text = textOf(file);
  const out: unknown[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*import\s+)([A-Za-z0-9_.]+)/.exec(lines[i]!);
    if (!m) continue;
    const p = m[2]!;
    const parts = p.split(".");
    let target: string | null = null;
    let unitName = p;
    for (let n = parts.length; n > 0; n--) {
      const wanted = parts.slice(0, n).map((s) => s.toLowerCase());
      const unit = a.units.find((u) => {
        const tail = u.id.split("::").slice(1);
        return tail.length === wanted.length && tail.every((seg, k) => seg === wanted[k]);
      });
      if (unit) { target = unit.file; unitName = unit.id.split("::").slice(1).map((s) => s[0]!.toUpperCase() + s.slice(1)).join("."); break; }
    }
    if (!target) continue;
    const start = m[1]!.length;
    out.push({
      range: { start: { line: i, character: start }, end: { line: i, character: start + p.length } },
      target: pathToUri(target),
      tooltip: `open module ${unitName}`,
    });
  }
  return out;
}

function typeDefinition(file: string, pos: Position) {
  const node = nodeAt(file, pos);
  const text = textOf(file);
  const word = wordAt(text, offsetAt(text, pos)).word;
  const name = node && /^[A-Z][A-Za-z0-9_]*$/.test(node.type) ? node.type : word;
  if (!name || !/^[A-Z][A-Za-z0-9_]*$/.test(name)) return null;
  const sym = (lastAnalysis?.symbols ?? []).find((s) =>
    s.name === name && (s.kind === "type" || s.kind === "record" || s.kind === "alias"));
  return sym ? { uri: pathToUri(sym.file), range: sym.range } : null;
}

/* ------------------------------------------------------------------ */
/* boundary                                                           */
/* ------------------------------------------------------------------ */

function boundary(uri?: string) {
  const a = lastAnalysis;
  if (!a) return { regions: [], summary: { client: 0, server: 0, cuts: 0, crossings: 0 } };
  const regions = a.regions.map((r) => ({ ...r, fileUri: pathToUri(r.file) }));
  void uri;
  return {
    regions,
    summary: {
      client: regions.filter((r) => r.side === "client" && r.kind === "function").length,
      server: regions.filter((r) => r.side === "server" && r.kind === "function").length,
      cuts: regions.filter((r) => r.kind === "cut").length,
      crossings: regions.filter((r) => r.kind === "crossing").length,
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
  const p = (msg.params ?? {}) as Json;
  const docUri = (p.textDocument as Json | undefined)?.uri as string | undefined;

  // Typing schedules a debounced analysis; a real request brings it up to date
  // first so completion and hover still see the text the user just typed.
  if (method && FRESH_METHODS.has(method)) flushAnalysis();

  switch (method) {
    case "initialize":
      workspaceRoot = p.rootUri ? uriToPath(p.rootUri as string) : null;
      reply(id, {
        capabilities: {
          textDocumentSync: { openClose: true, change: 2, save: { includeText: true } },
          semanticTokensProvider: { legend: { tokenTypes: TOKEN_TYPES, tokenModifiers: TOKEN_MODIFIERS }, full: true },
          hoverProvider: true,
          completionProvider: { triggerCharacters: [".", ":", "@", '"'], resolveProvider: false },
          definitionProvider: true,
          referencesProvider: true,
          documentSymbolProvider: true,
          workspaceSymbolProvider: true,
          signatureHelpProvider: { triggerCharacters: ["(", ","] },
          inlayHintProvider: true,
          foldingRangeProvider: true,
          selectionRangeProvider: true,
          documentHighlightProvider: true,
          documentFormattingProvider: true,
          documentLinkProvider: { resolveProvider: false },
          typeDefinitionProvider: true,
          codeActionProvider: true,
          codeLensProvider: { resolveProvider: false },
          renameProvider: { prepareProvider: true },
        },
        serverInfo: { name: "flow-lsp", version: "0.3.0" },
      });
      return;

    case "initialized": return;
    case "shutdown": reply(id, null); return;
    case "exit": process.exit(0);

    case "textDocument/didOpen": {
      const doc = p.textDocument as Json;
      openDocs.set(doc.uri as string, doc.text as string);
      if (!activeFile) activeFile = uriToPath(doc.uri as string);
      lastEntry = null;
      reanalyze();
      return;
    }

    case "textDocument/didChange": {
      const doc = p.textDocument as Json;
      const uri = doc.uri as string;
      let text = openDocs.get(uri) ?? "";
      for (const c of (p.contentChanges ?? []) as Json[]) {
        if (typeof c.text !== "string") continue;
        if (!c.range) { text = c.text; continue; }
        const r = c.range as { start: Position; end: Position };
        text = text.slice(0, offsetAt(text, r.start)) + c.text + text.slice(offsetAt(text, r.end));
      }
      openDocs.set(uri, text);
      scheduleReanalyze();
      return;
    }

    case "textDocument/didSave": {
      const doc = p.textDocument as Json;
      if (typeof p.text === "string") openDocs.set(doc.uri as string, p.text);
      reanalyze();
      return;
    }

    case "textDocument/didClose": {
      const uri = (p.textDocument as Json).uri as string;
      openDocs.delete(uri);
      if (activeFile === uriToPath(uri)) {
        activeFile = null;
        lastEntry = null;
        reanalyze();
      }
      return;
    }

    case "flow/activate": {
      const uri = (p.uri as string | undefined) ?? docUri;
      if (!uri) return;
      activeFile = uriToPath(uri);
      lastEntry = null;
      analysisStale = false;
      if (reanalyzeTimer) {
        clearTimeout(reanalyzeTimer);
        reanalyzeTimer = null;
      }
      reanalyze();
      return;
    }

    case "textDocument/semanticTokens/full":
      reply(id, semanticTokens(docUri!));
      return;

    case "textDocument/hover": {
      if (!lastAnalysis) reanalyze();
      const file = path.resolve(uriToPath(docUri!));
      const boundaryRegion = boundaryAt(file, p.position as Position);
      if (boundaryRegion) {
        const b = boundaryRegion;
        const lines = [
          `**${b.kind === "cut" ? "Inferred cut" : "Cross-tier expression"}**`,
          "",
          `- boundary: \`${b.direction ?? b.side}\``,
        ];
        if (b.cutId) lines.push(`- cut: \`${b.cutId}\``);
        if (b.mode) lines.push(`- mode: \`${b.mode}\``);
        if (b.parent) lines.push(`- in: \`${b.parent}\``);
        if (b.deps?.length) lines.push(`- deps: \`${b.deps.join(", ")}\``);
        if (b.type) lines.push(`- type: \`${b.type}\``);
        lines.push(
          "",
          b.kind === "cut"
            ? "This block runs on the other tier; the compiler splits it out and moves the value across."
            : "This value mixes client and server authority; the compiler resolves it to one side.",
        );
        reply(id, { contents: { kind: "markdown", value: lines.join("\n") }, range: b.range });
        return;
      }
      const node = nodeAt(file, p.position as Position);
      if (!node) {
        const typeInfo = typeHoverAt(file, p.position as Position);
        if (typeInfo) { reply(id, typeInfo); return; }
        const imp = importTargetAt(file, p.position as Position);
        if (!imp) { reply(id, null); return; }
        const mod = imp.display.split("::").slice(0, -1).join("::");
        reply(id, {
          contents: { kind: "markdown", value: `**${imp.display}**\n\n\`${imp.kind}\` exported by \`${mod}\`` },
          range: imp.range,
        });
        return;
      }
      const sym = node.ident ? symbolForName(node.ident) : undefined;
      const eff = node.effects.length ? `\n\nEffects: \`{${node.effects.join(", ")}}\`` : "";
      const origin = sym ? `\n\nDeclared in \`${sym.display}\` (${sym.kind})` : "";
      reply(id, {
        contents: { kind: "markdown", value: `**${node.type}**\n\nPlacement: \`${node.place}\`${eff}${origin}` },
        range: node.range,
      });
      return;
    }

    case "textDocument/definition": {
      if (!lastAnalysis) reanalyze();
      const d = definition(path.resolve(uriToPath(docUri!)), p.position as Position);
      reply(id, d ? { uri: d.uri, range: d.range } : null);
      return;
    }

    case "textDocument/references": {
      if (!lastAnalysis) reanalyze();
      const node = nodeAt(path.resolve(uriToPath(docUri!)), p.position as Position);
      if (!node?.ident) { reply(id, []); return; }
      reply(id, occurrences(node.ident, (p.context as Json | undefined)?.includeDeclaration ? undefined : undefined));
      return;
    }

    case "textDocument/documentSymbol":
      reply(id, symbolsInFile(path.resolve(uriToPath(docUri!))).map((s) => ({
        name: s.name,
        detail: s.kind,
        kind: symbolKind(s.kind),
        range: s.range,
        selectionRange: s.range,
      })));
      return;

    case "workspace/symbol": {
      if (!lastAnalysis) reanalyze();
      const q = String(p.query ?? "").toLowerCase();
      reply(id, (lastAnalysis?.symbols ?? [])
        .filter((s) => !q || s.name.toLowerCase().includes(q))
        .slice(0, 200)
        .map((s) => ({
          name: s.name,
          kind: symbolKind(s.kind),
          location: { uri: pathToUri(s.file), range: s.range },
          containerName: s.display.split(".").slice(0, -1).join("."),
        })));
      return;
    }

    case "textDocument/completion":
      reply(id, completion(path.resolve(uriToPath(docUri!)), p.position as Position));
      return;

    case "textDocument/signatureHelp":
      reply(id, signatureHelp(path.resolve(uriToPath(docUri!)), p.position as Position));
      return;

    case "textDocument/inlayHint":
      reply(id, inlayHints(path.resolve(uriToPath(docUri!))));
      return;

    case "textDocument/foldingRange":
      reply(id, foldingRanges(path.resolve(uriToPath(docUri!))));
      return;

    case "textDocument/selectionRange":
      reply(id, selectionRanges(path.resolve(uriToPath(docUri!)), p.positions as Position[]));
      return;

    case "textDocument/documentHighlight":
      reply(id, documentHighlights(path.resolve(uriToPath(docUri!)), p.position as Position));
      return;

    case "textDocument/documentLink":
      reply(id, documentLinks(path.resolve(uriToPath(docUri!))));
      return;

    case "textDocument/typeDefinition": {
      if (!lastAnalysis) reanalyze();
      reply(id, typeDefinition(path.resolve(uriToPath(docUri!)), p.position as Position));
      return;
    }

    case "workspace/didChangeWatchedFiles": {
      invalidateAnalysis();
      reanalyze();
      return;
    }

    case "textDocument/formatting":
      reply(id, format(path.resolve(uriToPath(docUri!))));
      return;

    case "textDocument/codeAction":
      reply(id, codeActions(path.resolve(uriToPath(docUri!)), p.range as Range, (p.context as Json | undefined)?.diagnostics as { message: string }[] ?? []));
      return;

    case "textDocument/codeLens":
      reply(id, codeLens(path.resolve(uriToPath(docUri!))));
      return;

    case "textDocument/prepareRename": {
      const node = nodeAt(path.resolve(uriToPath(docUri!)), p.position as Position);
      reply(id, node?.ident ? node.range : null);
      return;
    }

    case "textDocument/rename": {
      const res = rename(path.resolve(uriToPath(docUri!)), p.position as Position, String(p.newName ?? ""));
      reply(id, res);
      return;
    }

    case "flow/boundary":
      if (!lastAnalysis) reanalyze();
      reply(id, boundary(p.uri as string | undefined));
      return;

    case "flow/status":
      reply(id, {
        analysis: lastAnalysis ? { ok: lastAnalysis.ok, entry: lastAnalysis.entry, units: lastAnalysis.units } : null,
      });
      return;

    default:
      if (id !== undefined) replyError(id, -32601, `unhandled method ${method}`);
  }
});

process.stdin.on("data", (c: Buffer) => reader.push(c));
process.stdin.on("end", () => process.exit(0));

console.error("[flow-lsp] ready");

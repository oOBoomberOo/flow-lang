// Temporary smoke test: exercise every LSP method against a real package.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const file = path.resolve("packages/app/src/main.flow");
const uri = `file:///${file.replace(/\\/g, "/")}`;
const text = fs.readFileSync(file, "utf8");

const proc = spawn(process.execPath, ["src/lsp/server.ts"], { stdio: ["pipe", "pipe", "pipe"] });
let buf = Buffer.alloc(0);
const pending = new Map();
let id = 0;
const failures = [];

proc.stdout.on("data", (c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) {
    const i = buf.indexOf("\r\n\r\n");
    if (i < 0) return;
    const len = Number(/Content-Length:\s*(\d+)/i.exec(buf.slice(0, i).toString())[1]);
    if (buf.length < i + 4 + len) return;
    const msg = JSON.parse(buf.slice(i + 4, i + 4 + len).toString());
    buf = buf.slice(i + 4 + len);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});

const send = (m) => {
  const body = JSON.stringify({ jsonrpc: "2.0", ...m });
  proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};
const req = (method, params) => new Promise((res) => { pending.set(++id, res); send({ id, method, params }); });

async function check(name, method, params, summarise) {
  const r = await req(method, params);
  if (r.error) { failures.push(`${name}: ${r.error.message}`); return; }
  let out;
  try { out = summarise(r.result); } catch (e) { failures.push(`${name}: ${e.message}`); return; }
  console.log(`${name.padEnd(18)} ${out}`);
}

await req("initialize", { rootUri: null, capabilities: {} });
send({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "flow", version: 1, text } } });
await new Promise((r) => setTimeout(r, 500));

const lineOf = (needle) => {
  const lines = text.split("\n");
  const l = lines.findIndex((x) => x.includes(needle));
  return { line: l, character: lines[l].indexOf(needle) + 2 };
};

const lineOfLast = (needle) => {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].includes(needle)) return { line: i, character: lines[i].indexOf(needle) + 2 };
  return { line: 0, character: 0 };
};
const atCard = lineOfLast("<Chart");
const atBars = lineOfLast("<Card");
const atCall = lineOfLast("hms(");

await check("hover", "textDocument/hover", { textDocument: { uri }, position: atCard }, (r) => r ? `${r.contents.value.split("\n")[0]} place=${/Placement: `([a-z]+)`/.exec(r.contents.value)?.[1]}` : "null");
await check("definition", "textDocument/definition", { textDocument: { uri }, position: atCard }, (r) => r ? `${path.basename(r.uri)}:${r.range.start.line + 1}` : "null");
await check("references", "textDocument/references", { textDocument: { uri }, position: atCard, context: { includeDeclaration: true } }, (r) => `${r.length} site(s)`);
await check("documentSymbol", "textDocument/documentSymbol", { textDocument: { uri } }, (r) => r.map((s) => s.name).join(", ") || "none");
await check("workspaceSymbol", "workspace/symbol", { query: "chart" }, (r) => `${r.length} match(es): ${r.slice(0, 3).map((s) => s.name).join(", ")}`);
await check("completion", "textDocument/completion", { textDocument: { uri }, position: { line: text.split("\n").length - 2, character: 2 } }, (r) => `${r.items.length} item(s)`);
await check("completion .", "textDocument/completion", { textDocument: { uri }, position: atBars }, (r) => `${r.items.length} item(s)`);
await check("signatureHelp", "textDocument/signatureHelp", { textDocument: { uri }, position: atCall }, (r) => r ? r.signatures[0].label : "null");
await check("inlayHint", "textDocument/inlayHint", { textDocument: { uri }, range: { start: { line: 0, character: 0 }, end: { line: 200, character: 0 } } }, (r) => r.map((h) => h.label.trim()).join(", ") || "none");
await check("foldingRange", "textDocument/foldingRange", { textDocument: { uri } }, (r) => `${r.length} range(s)`);
await check("selectionRange", "textDocument/selectionRange", { textDocument: { uri }, positions: [atCard] }, (r) => r[0] ? "nested" : "null");
await check("documentHighlight", "textDocument/documentHighlight", { textDocument: { uri }, position: atCard }, (r) => `${r.length} hit(s)`);
await check("formatting", "textDocument/formatting", { textDocument: { uri }, options: { tabSize: 2, insertSpaces: true } }, (r) => r.length ? `${r[0].newText.split("\n").length} line(s)` : "no change");
await check("codeAction", "textDocument/codeAction", { textDocument: { uri }, range: { start: atCard, end: atCard }, context: { diagnostics: [] } }, (r) => r.map((a) => a.title).join(" | ") || "none");
await check("codeLens", "textDocument/codeLens", { textDocument: { uri } }, (r) => r.map((l) => l.command.title).join(" | ") || "none");
await check("prepareRename", "textDocument/prepareRename", { textDocument: { uri }, position: atCard }, (r) => r ? "ok" : "null");
await check("rename", "textDocument/rename", { textDocument: { uri }, position: atCard, newName: "ZZZ" }, (r) => r ? `${Object.values(r.changes).flat().length} edit(s)` : "null");
await check("semanticTokens", "textDocument/semanticTokens/full", { textDocument: { uri } }, (r) => `${r.data.length / 5} token(s)`);
await check("boundary", "flow/boundary", { uri }, (r) => `client=${r.summary.client} server=${r.summary.server} cuts=${r.summary.cuts}`);

console.log("");
console.log(failures.length ? `FAILURES:\n  ${failures.join("\n  ")}` : "all methods responded");
proc.kill();
process.exit(failures.length ? 1 : 0);

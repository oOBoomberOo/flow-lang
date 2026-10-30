/**
 * Cargo-style terminal output: colours, rustc-style diagnostics and progress
 * lines. Everything here is pure string building; the CLI decides the streams.
 */

import fs from "node:fs";
import path from "node:path";
import { FlowError } from "./lexer.ts";

export type ColorMode = "auto" | "always" | "never";

const RESET = "\x1b[0m";

export interface Style {
  enabled: boolean;
  red(s: string): string;
  green(s: string): string;
  blue(s: string): string;
  yellow(s: string): string;
  bold(s: string): string;
  dim(s: string): string;
}

export function makeStyle(mode: ColorMode, stream: NodeJS.WriteStream = process.stderr): Style {
  const enabled = mode === "always" ||
    (mode === "auto" && !("NO_COLOR" in process.env) && Boolean(stream.isTTY));
  const wrap = (code: string) => (s: string) => (enabled ? `\x1b[${code}m${s}${RESET}` : s);
  return {
    enabled,
    red: wrap("1;31"),
    green: wrap("1;32"),
    blue: wrap("1;34"),
    yellow: wrap("1;33"),
    bold: wrap("1"),
    dim: wrap("2"),
  };
}

export function relativePath(file: string, cwd = process.cwd()): string {
  const rel = path.relative(cwd, path.resolve(file));
  return rel && !rel.startsWith("..") ? rel : path.resolve(file);
}

function expandTabs(s: string): string {
  return s.replace(/\t/g, "    ");
}

/** How many characters of the line the caret should cover. */
function caretLength(rest: string): number {
  const m = /^(?:[A-Za-z_][A-Za-z0-9_']*|\d+(?:\.\d+)?|"(?:[^"\\]|\\.)*"?|\S)/.exec(rest);
  return Math.max(1, m ? m[0].length : 1);
}

function readLines(file: string): string[] | null {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/);
  } catch {
    return null;
  }
}

/**
 * `error[E_TYPE]: message`
 * ` --> file:line:col`
 * `  |`
 * `1 | source line`
 * `  |           ^^^`
 * `  |`
 * `  = help: …`
 */
export function renderError(err: FlowError, style: Style): string {
  const raw = err.message.split("\n");
  let head = raw.shift() ?? "error";
  const notes = raw.map((l) => l.trim()).filter(Boolean);

  let help: string | undefined;
  const sep = head.indexOf(" — ");
  if (sep >= 0) {
    help = head.slice(sep + 3).trim();
    head = head.slice(0, sep).trim();
  }

  const code = err.code ? style.red(`[${err.code}]`) : "";
  const out: string[] = [`${style.red("error")}${code}: ${style.bold(head)}`];

  if (err.file) {
    const rel = relativePath(err.file);
    const loc = err.line ? `${rel}:${err.line}:${err.col ?? 1}` : rel;
    out.push(` ${style.blue("-->")} ${loc}`);

    if (err.line) {
      const lines = readLines(err.file);
      const text = lines?.[err.line - 1];
      if (text !== undefined) {
        const number = String(err.line);
        const pad = " ".repeat(number.length);
        const col = Math.max(1, err.col ?? 1);
        const shown = expandTabs(text);
        const before = expandTabs(text.slice(0, col - 1));
        const carets = "^".repeat(caretLength(text.slice(col - 1)));
        out.push(`${pad} ${style.blue("|")}`);
        out.push(`${style.blue(number)} ${style.blue("|")} ${shown}`);
        out.push(`${pad} ${style.blue("|")} ${" ".repeat(before.length)}${style.red(carets)}`);
        out.push(`${pad} ${style.blue("|")}`);
      }
    }
  }

  for (const note of notes) {
    out.push(`  ${style.blue("=")} ${style.blue("note")}: ${note}`);
  }
  if (help) {
    out.push(`  ${style.blue("=")} ${style.blue("help")}: ${help}`);
  }
  return out.join("\n");
}

function dedupe(errors: FlowError[]): FlowError[] {
  const seen = new Set<string>();
  const out: FlowError[] = [];
  for (const e of errors) {
    const key = `${e.file ?? ""}:${e.line ?? ""}:${e.col ?? ""}:${e.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/** All collected errors plus the `could not …` summary line. */
export function renderErrors(
  errors: FlowError[],
  entry: string,
  style: Style,
  verb: "check" | "compile",
): string {
  const list = dedupe(errors);
  const blocks = list.map((e) => renderError(e, style));
  const name = relativePath(entry);
  const count = list.length;
  blocks.push(
    `${style.red("error")}: could not ${verb} \`${name}\` due to ${count} previous error${count === 1 ? "" : "s"}`,
  );
  return blocks.join("\n") + "\n";
}

/** `   Compiling` / `    Finished` / `     Running`, right-aligned like Cargo. */
export function status(style: Style, label: "Checking" | "Compiling" | "Installing" | "Finished" | "Running" | "Watching", text: string): string {
  return `${" ".repeat(Math.max(0, 12 - label.length))}${style.green(label)} ${text}`;
}

export function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

export function timestamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function clearScreen(): void {
  process.stderr.write("\x1b[2J\x1b[3J\x1b[H");
}

/** True when a watched path should trigger a rebuild. */
export function relevantWatchPath(file: string): boolean {
  const norm = file.replace(/\\/g, "/");
  if (/(^|\/)(node_modules|flow_modules|\.git|dist|\.flow-build|build)(\/|$)/.test(norm)) return false;
  return norm.endsWith(".flow") || norm.endsWith("/flow.json") || norm.endsWith("/flow.lock") ||
    norm === "flow.json" || norm === "flow.lock";
}

/**
 * Watch a directory recursively. Returns a stop function. Falls back to
 * mtime polling when recursive `fs.watch` is not supported.
 */
export function watchTree(root: string, onChange: (relative: string) => void): () => void {
  const ignored = (p: string) =>
    /(^|[\\/])(node_modules|flow_modules|\.git|dist|\.flow-build|build)([\\/]|$)/.test(p);

  try {
    const watcher = fs.watch(root, { recursive: true }, (_event, name) => {
      if (!name) return;
      const rel = name.toString();
      if (ignored(rel)) return;
      onChange(rel);
    });
    watcher.on("error", () => { /* keep the process alive; polling is not needed here */ });
    return () => watcher.close();
  } catch {
    const seen = new Map<string, number>();
    const scan = () => {
      const walk = (dir: string) => {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (ignored(full)) continue;
          if (entry.isDirectory()) { walk(full); continue; }
          let mtime = 0;
          try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
          const rel = path.relative(root, full);
          if (seen.get(rel) !== mtime) {
            seen.set(rel, mtime);
            onChange(rel);
          }
        }
      };
      walk(root);
    };
    scan();
    const timer = setInterval(scan, 300);
    return () => clearInterval(timer);
  }
}

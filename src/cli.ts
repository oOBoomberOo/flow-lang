import fs from "node:fs";
import path from "node:path";
import { compileFile } from "./compile.ts";
import { parse } from "./parser.ts";
import { printProgram } from "./printer.ts";
import { migrateSource } from "./migrate.ts";
import { createHost } from "./host.ts";
import { FlowError } from "./lexer.ts";
import { install, add, verifyLock, readRegistry, registryDir } from "./pkg.ts";
import {
  makeStyle, renderError, renderErrors, status, formatDuration,
  timestamp, clearScreen, relativePath, relevantWatchPath, watchTree,
} from "./cli-output.ts";
import type { ColorMode, Style } from "./cli-output.ts";

const RUNTIME_FILES = ["core.js", "server.js", "dom.js", "client.js"];
const VERSION = "0.1.0";

const stderr = (s: string) => process.stderr.write(s);
const stdout = (s: string) => process.stdout.write(s);

interface GlobalArgs {
  color: ColorMode;
  quiet: boolean;
  help: boolean;
  version: boolean;
  rest: string[];
}

function parseGlobal(argv: string[]): GlobalArgs {
  const rest: string[] = [];
  let color: ColorMode = "auto";
  let quiet = false, help = false, version = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") help = true;
    else if (a === "--version" || a === "-V" || a === "-v") version = true;
    else if (a === "--quiet" || a === "-q") quiet = true;
    else if (a === "--color") {
      const value = argv[++i];
      if (!value) throw new FlowError("a value is required for '--color <WHEN>'", { code: "E_CLI" });
      color = parseColor(value);
    } else if (a.startsWith("--color=")) color = parseColor(a.slice("--color=".length));
    else if (a === "--no-color") color = "never";
    else rest.push(a);
  }
  return { color, quiet, help, version, rest };
}

function parseColor(value: string): ColorMode {
  if (value === "auto" || value === "always" || value === "never") return value;
  throw new FlowError(`invalid value '${value}' for '--color <WHEN>' (possible values: auto, always, never)`, {
    code: "E_CLI",
  });
}

export async function main(argv: string[]): Promise<void> {
  let g: GlobalArgs;
  try {
    g = parseGlobal(argv);
  } catch (e) {
    reportCliError(e, makeStyle("auto"));
    return;
  }
  const style = makeStyle(g.color);
  if (g.version) {
    stdout(`flow ${VERSION}\n`);
    return;
  }

  const [cmd, ...rest] = g.rest;
  if (g.help) {
    if (cmd) commandHelp(cmd, style);
    else usage(style);
    return;
  }
  if (!cmd) {
    usage(style);
    return;
  }
  if (cmd === "help") {
    if (rest[0]) commandHelp(rest[0], style);
    else usage(style);
    return;
  }

  try {
    switch (cmd) {
      case "build": return build(rest, style, g.quiet);
      case "check": return check(rest, style, g.quiet);
      case "explain": return explain(rest, style);
      case "fmt": return fmt(rest, style);
      case "migrate": return migrate(rest, style);
      case "run": return await run(rest, style, g.quiet);
      case "watch": return await watch(rest, style, g.quiet);
      case "install": return cmdInstall(rest, style, g.quiet);
      case "add": return cmdAdd(rest, style);
      case "verify": return cmdVerify(rest, style);
      case "registry": return cmdRegistry(style);
      case "version": stdout(`flow ${VERSION}\n`); return;
      default: return unknownCommand(cmd, style);
    }
  } catch (e) {
    reportCliError(e, style);
  }
}

function reportCliError(e: unknown, style: Style): void {
  if (e instanceof FlowError) {
    stderr(`${e.code === "E_CLI" ? `${style.red("error")}: ${e.message}` : renderError(e, style)}\n`);
    process.exitCode = 1;
    return;
  }
  if (e instanceof Error) {
    stderr(`${style.red("error")}: internal error: ${e.message}\n`);
    if (process.env.FLOW_DEBUG) stderr(`${e.stack ?? ""}\n`);
    process.exitCode = 1;
    return;
  }
  throw e;
}

function unknownCommand(cmd: string, style: Style): void {
  process.exitCode = 1;
  stderr(`${style.red("error")}: unrecognized subcommand '${cmd}'\n\n`);
  stderr(`${style.bold("Usage:")} flow [OPTIONS] <COMMAND>\n\n`);
  stderr(`For more information, try 'flow --help'.\n`);
}

function cutText(n: number): string {
  return n === 0 ? "no cuts" : `${n} cut${n === 1 ? "" : "s"}`;
}

function usage(style: Style): void {
  const b = (s: string) => style.bold(s);
  stdout(`Flow — a tierless language with a type-inferred client/server boundary

${b("Usage:")} flow [OPTIONS] <COMMAND>

${b("Commands:")}
  check     Type-check a package or file
  build     Compile to app.js, server.js and the runtime
  run       Type-check, build, and serve the app
  watch     Re-check or rebuild when source files change
  explain   Print inferred placement and boundary cuts
  fmt       Format a file with the Flow pretty printer
  migrate   Rewrite Rust-style Flow source into the Haskell-style syntax
  install   Resolve dependencies and vendor them
  add       Add a dependency from the registry
  verify    Verify installed packages against the lockfile
  registry  List packages in the registry
  help      Print this message or help for a command

${b("Options:")}
  -q, --quiet         Suppress progress output
      --color <WHEN>  Color output: auto, always, never [default: auto]
  -h, --help          Print help
  -V, --version       Print version

Run 'flow help <COMMAND>' for more information on a command.
`);
}

const HELP: Record<string, string> = {
  fmt: `Format a file. Writes the result back unless --check is given.

Usage: flow fmt <file.flow> [--check]

Options:
      --check         Do not write; exit 1 if the file is not formatted
  -h, --help          Print help`,
  migrate: `Rewrite the old Rust-style syntax into the Haskell-style syntax.

Usage: flow migrate <file.flow> [...] [--write]

Without --write the result is printed to stdout.
`,
  check: `Type-check a package or file.

Usage: flow check [file.flow]

Arguments:
  <file.flow>  Entry file [default: src/main.flow in the current package]

Options:
  -q, --quiet         Suppress progress output
      --color <WHEN>  Color output: auto, always, never
  -h, --help          Print help`,
  build: `Compile a program to ES modules and copy the runtime.

Usage: flow build [file.flow] [--out <DIR>]

Arguments:
  <file.flow>  Entry file [default: src/main.flow in the current package]

Options:
      --out <DIR>     Output directory [default: dist]
  -q, --quiet         Suppress progress output
      --color <WHEN>  Color output: auto, always, never
  -h, --help          Print help`,
  run: `Type-check, build, and serve a program.

Usage: flow run [file.flow] [--port <PORT>] [--secret <KEY=VALUE>]...

Arguments:
  <file.flow>  Entry file [default: src/main.flow in the current package]

Options:
      --port <PORT>       Port to listen on [default: 4173]
      --secret <K=V>      Expose a server secret to Server.secret (repeatable)
  -q, --quiet             Suppress progress output
      --color <WHEN>      Color output: auto, always, never
  -h, --help              Print help`,
  watch: `Re-check or rebuild when source files change.

Usage: flow watch [file.flow] [OPTIONS]

Watches the package directory (source files, flow.json, flow.lock) and reruns on
change. With --run, the server is restarted after each successful build.

Arguments:
  <file.flow>  Entry file [default: src/main.flow in the current package]

Options:
      --out <DIR>         Output directory when not using --run [default: .flow-build]
      --run               Build and serve, restarting the server on change
      --port <PORT>       Port to listen on with --run [default: 4173]
      --secret <K=V>      Expose a server secret (repeatable)
      --debounce <MS>     Wait this long after the last change [default: 120]
      --no-clear          Do not clear the screen between rebuilds
  -q, --quiet             Suppress progress output
      --color <WHEN>      Color output: auto, always, never
  -h, --help              Print help`,
  explain: `Print inferred placement and boundary cuts.

Usage: flow explain <file.flow>

Arguments:
  <file.flow>  Entry file [default: src/main.flow in the current package]

Options:
      --color <WHEN>  Color output: auto, always, never
  -h, --help          Print help`,
  install: `Resolve dependencies, vendor flow_modules/, and write flow.lock.

Usage: flow install [DIR]

Options:
  -q, --quiet         Suppress progress output
  -h, --help          Print help`,
  add: `Add a dependency from the registry and install it.

Usage: flow add <name>[@range] [DIR]

Options:
  -h, --help  Print help`,
  verify: `Verify installed packages against flow.lock.

Usage: flow verify [DIR]

Options:
  -h, --help  Print help`,
  registry: `List packages in the registry.

Usage: flow registry

Options:
  -h, --help  Print help`,
};

function commandHelp(cmd: string, style: Style): void {
  const text = HELP[cmd];
  if (text) {
    stdout(`${text}\n`);
    return;
  }
  process.exitCode = 1;
  stderr(`${style.red("error")}: no such command: '${cmd}'\n\n`);
  stderr(`For more information, try 'flow --help'.\n`);
}

function pkgDir(argv: string[], fallback = process.cwd()): string {
  const dir = argv.find((a) => !a.startsWith("-"));
  return path.resolve(dir ?? fallback);
}

function arg(list: string[], name: string): string | undefined {
  const i = list.indexOf(name);
  return i >= 0 ? list[i + 1] : undefined;
}

function entryArg(argv: string[], cmd: string): string {
  const file = argv.find((a) => !a.startsWith("-") && a.endsWith(".flow"));
  if (file) return file;
  // A directory argument means "the package here": use its src/main.flow.
  const dirArg = argv.find((a) => !a.startsWith("-") && !a.includes("="));
  if (dirArg) {
    const dir = path.resolve(dirArg);
    try {
      if (fs.statSync(dir).isDirectory()) {
        const candidate = path.join(dir, "src", "main.flow");
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch { /* not a path; fall through */ }
  }
  const fallback = findEntry();
  if (fallback) return fallback;
  throw new FlowError(
    `${cmd}: missing <file.flow> (no src/main.flow found in this package)`,
    { code: "E_CLI" },
  );
}

/** Cargo-like default entry: src/main.flow in the enclosing package. */
function findEntry(cwd = process.cwd()): string | null {
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, "src", "main.flow");
    if (fs.existsSync(candidate)) return candidate;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function assertFlags(argv: string[], allowed: Record<string, "value" | "flag">, usageLine: string): void {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("-")) continue;
    const name = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    const kind = allowed[name];
    if (!kind) {
      throw new FlowError(`unexpected argument '${a}' found\n\nUsage: ${usageLine}`, { code: "E_CLI" });
    }
    if (kind === "value" && !a.includes("=")) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new FlowError(`a value is required for '${name} <VALUE>' but none was supplied`, { code: "E_CLI" });
      }
      i++;
    }
  }
}

function parseSecrets(argv: string[]): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--secret") continue;
    const pair = argv[i + 1] ?? "";
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new FlowError(`--secret expects KEY=VALUE, got '${pair}'`, { code: "E_CLI" });
    secrets[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return secrets;
}

/** Compile with every error collected; render them Cargo-style on failure. */
function compile(file: string, style: Style, verb: "check" | "compile") {
  let result;
  try {
    result = compileFile(file, { collectErrors: true });
  } catch (e) {
    if (e instanceof FlowError) {
      stderr(renderErrors([e], file, style, verb));
      process.exitCode = 1;
      return null;
    }
    throw e;
  }
  if (result.errors.length) {
    stderr(renderErrors(result.errors, file, style, verb));
    process.exitCode = 1;
    return null;
  }
  return result;
}

/** Read a source file's format: module header, comments and declarations. */
function formatFile(file: string, pkg?: string): string {
  const src = fs.readFileSync(file, "utf8");
  const program = parse(src, file, { recover: true });
  const comments = new Map<number, string[]>();
  let pending: string[] = [];
  const declLines = new Set(program.decls.map((d) => d.span.line));
  src.split(/\r?\n/).forEach((text, i) => {
    const line = i + 1;
    if (/^\s*--/.test(text)) { pending.push(text.replace(/^\s*-- ?/, "")); return; }
    if (!text.trim()) return;
    if (declLines.has(line)) {
      if (pending.length) comments.set(line, pending);
      pending = [];
    } else if (/^\S/.test(text)) pending = [];
  });
  const moduleName = path.basename(file).replace(/\.flow$/, "").replace(/^./, (c) => c.toUpperCase());
  return printProgram(program, { moduleName, comments });
}

function fmt(argv: string[], style: Style): void {
  const checkOnly = argv.includes("--check");
  const file = argv.find((a) => !a.startsWith("-"));
  if (!file) { reportCliError(new FlowError("flow fmt needs a file"), style); return; }
  const abs = path.resolve(file);
  const out = formatFile(abs);
  const current = fs.readFileSync(abs, "utf8");
  if (checkOnly) {
    if (out !== current) {
      reportCliError(new FlowError(`${file} is not formatted`, { file: abs, code: "E_FMT" }), style);
      return;
    }
    stdout(`${file} is formatted\n`);
    return;
  }
  if (out !== current) fs.writeFileSync(abs, out);
  stdout(`Formatted ${file}\n`);
}

function migrate(argv: string[], style: Style): void {
  const write = argv.includes("--write");
  const files = argv.filter((a) => !a.startsWith("-"));
  if (!files.length) { reportCliError(new FlowError("flow migrate needs at least one file"), style); return; }
  for (const file of files) {
    const abs = path.resolve(file);
    const out = migrateSource(fs.readFileSync(abs, "utf8"), abs, {});
    if (write) { fs.writeFileSync(abs, out); stdout(`Migrated ${file}\n`); }
    else stdout(out);
  }
}

function check(argv: string[], style: Style, quiet: boolean): void {
  assertFlags(argv, {}, "flow check <file.flow>");
  const file = entryArg(argv, "check");
  const t0 = Date.now();
  if (!quiet) stderr(`${status(style, "Checking", relativePath(file))}\n`);
  const result = compile(file, style, "check");
  if (!result) return;
  if (!quiet) {
    const time = formatDuration(Date.now() - t0);
    stderr(`${status(style, "Finished", `check in ${time} (${cutText(result.diagnostics.length)})`)}\n`);
  }
}

function build(argv: string[], style: Style, quiet: boolean): void {
  assertFlags(argv, { "--out": "value" }, "flow build <file.flow> [--out <DIR>]");
  const file = entryArg(argv, "build");
  const outDir = arg(argv, "--out") ?? "dist";
  const t0 = Date.now();
  if (!quiet) stderr(`${status(style, "Compiling", relativePath(file))}\n`);
  const result = compile(file, style, "compile");
  if (!result) return;
  emit(result, outDir);
  if (!quiet) {
    const time = formatDuration(Date.now() - t0);
    stderr(`${status(style, "Finished", `build in ${time} -> ${outDir} (${cutText(result.diagnostics.length)})`)}\n`);
    for (const d of result.diagnostics) stderr(`  ${d}\n`);
  }
}

function explain(argv: string[], style: Style): void {
  assertFlags(argv, {}, "flow explain <file.flow>");
  const file = entryArg(argv, "explain");
  const result = compile(file, style, "check");
  if (!result) return;
  const origin = (name: string) => result.display?.get(name) ?? name;
  stdout(`# ${file}\n\n`);
  stdout("## functions and their inferred placement\n");
  for (const [name, fn] of result.mod.fns) {
    if (fn.synthetic) continue;
    const from = origin(name);
    if (from.startsWith("std::")) continue;
    const h = result.codegen!.home(fn.body);
    const eff = fn.scheme.k === "fun" ? [...fn.scheme.eff.labels].sort() : [];
    stdout(`  ${from.padEnd(34)} ${(h === "neutral" ? "both" : h).padEnd(8)} effects: {${eff.join(", ")}}\n`);
  }
  stdout("\n## boundary cuts\n");
  if (!result.diagnostics.length) stdout("  (none — the program is single-tier)\n");
  for (const d of result.diagnostics) stdout(`  ${d}\n`);
  stdout(`\n## emitted bundles\n  client: ${result.client.split("\n").length} lines\n  server: ${result.server.split("\n").length} lines\n`);
}

async function run(argv: string[], style: Style, quiet: boolean): Promise<void> {
  assertFlags(argv, {
    "--port": "value", "--secret": "value",
  }, "flow run <file.flow> [--port <PORT>] [--secret <KEY=VALUE>]...");
  const file = entryArg(argv, "run");
  const port = Number(arg(argv, "--port") ?? 4173);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new FlowError(`invalid port '${arg(argv, "--port")}'`, { code: "E_CLI" });
  }
  const secrets = parseSecrets(argv);

  const t0 = Date.now();
  if (!quiet) stderr(`${status(style, "Compiling", relativePath(file))}\n`);
  const result = compile(file, style, "compile");
  if (!result) return;

  const outDir = path.join(process.cwd(), ".flow-build");
  emit(result, outDir);
  const host = await startHost({ outDir, port, secrets }, port);

  if (!quiet) {
    stderr(`${status(style, "Finished", `build in ${formatDuration(Date.now() - t0)}`)}\n`);
    stderr(`${status(style, "Running", host.url)}\n`);
    stderr(`  ${cutText(result.diagnostics.length)} across the boundary\n`);
    for (const d of result.diagnostics) stderr(`    ${d}\n`);
    stderr("  ctrl-c to stop\n");
  }

  const shutdown = async () => { await host.close(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function startHost(opts: Parameters<typeof createHost>[0], port: number) {
  try {
    return await createHost(opts);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    const hint = /EADDRINUSE|address already in use/i.test(detail)
      ? ` (port ${port} is already in use; try --port <PORT>)`
      : "";
    throw new FlowError(`could not start the server${hint}: ${detail}`, { code: "E_CLI" });
  }
}

function packageRoot(file: string): string {
  let dir = path.dirname(path.resolve(file));
  for (;;) {
    if (fs.existsSync(path.join(dir, "flow.json"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.dirname(path.resolve(file));
    dir = up;
  }
}

async function watch(argv: string[], style: Style, quiet: boolean): Promise<void> {
  assertFlags(argv, {
    "--out": "value", "--run": "flag", "--port": "value", "--secret": "value",
    "--debounce": "value", "--no-clear": "flag",
  }, "flow watch <file.flow> [--run] [--out <DIR>] [--port <PORT>]");
  const file = entryArg(argv, "watch");
  const runMode = argv.includes("--run");
  const outDir = path.resolve(arg(argv, "--out") ?? ".flow-build");
  const port = Number(arg(argv, "--port") ?? 4173);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new FlowError(`invalid port '${arg(argv, "--port")}'`, { code: "E_CLI" });
  }
  const secrets = parseSecrets(argv);
  const debounceMs = Math.max(20, Number(arg(argv, "--debounce") ?? 120) || 120);
  const clear = !argv.includes("--no-clear") && Boolean(process.stderr.isTTY);
  const root = packageRoot(file);

  let host: Awaited<ReturnType<typeof createHost>> | null = null;
  let stopped = false;
  let running = false;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Set<string>();

  const rebuild = async (changed: string[], initial: boolean): Promise<void> => {
    if (!initial && clear && !quiet) clearScreen();
    if (!initial && changed.length && !quiet) {
      stderr(`${style.dim(`[${timestamp()}]`)} change: ${changed.join(", ")}\n`);
    }
    const t0 = Date.now();
    if (!quiet) stderr(`${status(style, runMode ? "Compiling" : "Checking", relativePath(file))}\n`);

    const result = compile(file, style, runMode ? "compile" : "check");
    if (!result) {
      if (!quiet) stderr(`${style.yellow("waiting for changes...")}\n`);
      return;
    }

    emit(result, outDir);
    const time = formatDuration(Date.now() - t0);
    if (runMode) {
      await host?.close();
      host = await startHost({ outDir, port, secrets, cacheBust: String(Date.now()) }, port);
      if (!quiet) {
        stderr(`${status(style, "Finished", `build in ${time}`)}\n`);
        stderr(`${status(style, "Running", host.url)}\n`);
        stderr(`  ${cutText(result.diagnostics.length)} across the boundary\n`);
        stderr("  ctrl-c to stop\n");
      }
    } else if (!quiet) {
      stderr(`${status(style, "Finished", `check in ${time} (${cutText(result.diagnostics.length)})`)}\n`);
    }
  };

  const kick = async (): Promise<void> => {
    if (stopped) return;
    if (running) { again = true; return; }
    running = true;
    const files = [...pending];
    pending.clear();
    if (timer) { clearTimeout(timer); timer = null; }
    try {
      await rebuild(files, false);
    } finally {
      running = false;
      if (again) { again = false; void kick(); }
    }
  };

  await rebuild([], true);

  const stopWatching = watchTree(root, (changed) => {
    if (!relevantWatchPath(changed)) return;
    pending.add(changed);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void kick(), debounceMs);
  });

  if (!quiet) {
    stderr(`${status(style, "Watching", `${relativePath(root)} for changes (ctrl-c to stop)`)}\n`);
  }

  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    stopWatching();
    if (timer) clearTimeout(timer);
    await host?.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function cmdInstall(argv: string[], style: Style, quiet: boolean): void {
  const dir = pkgDir(argv);
  const t0 = Date.now();
  if (!quiet) stderr(`${status(style, "Installing", "dependencies")}\n`);
  const report = install(dir);
  for (const p of report.installed) stdout(`  ${p.name}@${p.version}  ${p.integrity.slice(0, 23)}…\n`);
  for (const p of report.fromPath) stdout(`  ${p.name} (path) -> ${p.dir}\n`);
  if (!report.installed.length && !report.fromPath.length) stdout("  (no dependencies)\n");
  if (!quiet) {
    stderr(`${status(style, "Finished", `install in ${formatDuration(Date.now() - t0)} (${path.join(dir, "flow_modules")})`)}\n`);
  }
}

function cmdAdd(argv: string[], style: Style): void {
  const spec = argv.find((a) => !a.startsWith("-") && !a.startsWith(".") && !path.isAbsolute(a));
  if (!spec) throw new FlowError("add: missing <name>[@range]", { code: "E_CLI" });
  const dir = pkgDir(argv.filter((a) => a !== spec));
  const { name, version } = add(dir, spec);
  stdout(`added ${name}@^${version} to ${path.join(dir, "flow.json")}\n`);
}

function cmdVerify(argv: string[], style: Style): void {
  const dir = pkgDir(argv);
  const problems = verifyLock(dir);
  if (problems.length) {
    for (const p of problems) stderr(`${style.red("error")}: ${p}\n`);
    process.exitCode = 1;
    return;
  }
  stdout("ok: flow_modules matches flow.lock\n");
}

function cmdRegistry(style: Style): void {
  const index = readRegistry();
  stdout(`registry: ${registryDir()}\n`);
  for (const [name, info] of Object.entries(index.packages)) {
    stdout(`  ${name.padEnd(20)} ${Object.keys(info.versions).sort().join(", ")}\n`);
  }
}

function emit(result: ReturnType<typeof compileFile>, outDir: string): void {
  const rt = path.join(import.meta.dirname, "runtime");
  fs.mkdirSync(path.join(outDir, "runtime"), { recursive: true });
  fs.writeFileSync(path.join(outDir, "app.js"), result.client);
  fs.writeFileSync(path.join(outDir, "server.js"), result.server);
  for (const f of RUNTIME_FILES) {
    fs.copyFileSync(path.join(rt, f), path.join(outDir, "runtime", f));
  }
  fs.writeFileSync(
    path.join(outDir, "runtime", "server-runtime.js"),
    `import { createServerRuntime } from "./server.js";\n` +
    `const opts = JSON.parse(process.env.FLOW_OPTS || "{}");\n` +
    `export const R = createServerRuntime(opts);\n`,
  );
}

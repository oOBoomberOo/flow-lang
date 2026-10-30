import fs from "node:fs";
import path from "node:path";
import { compileFile } from "./compile.ts";
import { createHost } from "./host.ts";
import { FlowError } from "./lexer.ts";
import { install, add, verifyLock, readRegistry, registryDir } from "./pkg.ts";

const RUNTIME_FILES = ["core.js", "server.js", "dom.js", "client.js"];

export async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "build": return build(rest);
      case "check": return check(rest);
      case "explain": return explain(rest);
      case "run": return run(rest);
      case "install": return cmdInstall(rest);
      case "add": return cmdAdd(rest);
      case "verify": return cmdVerify(rest);
      case "registry": return cmdRegistry();
      case "version": case "--version": case "-v":
        console.log("flow 0.1.0");
        return;
      default:
        return usage();
    }
  } catch (e) {
    if (e instanceof FlowError) {
      console.error(e.format());
      process.exitCode = 1;
      return;
    }
    throw e;
  }
}

function usage() {
  console.log(`flow — a tierless language with a type-inferred client/server boundary

  flow check   <file.flow>            type-check a package entry (or a single file)
  flow explain <file.flow>            type-check + print inferred boundary cuts
  flow build   <file.flow> --out <dir>  emit app.js / server.js / runtime/
  flow run     <file.flow> [--port N] [--secret k=v ...]

  flow install [dir]                  resolve dependencies, vendor flow_modules/, write flow.lock
  flow add <name>[@range] [dir]       add a dependency from the registry and install it
  flow verify [dir]                   check installed packages against flow.lock
  flow registry                       list packages in the registry

Every program defines \`fn main() -> Html\` in <pkg>/src/main.flow.`);
}

function pkgDir(argv: string[], fallback = process.cwd()): string {
  const dir = argv.find((a) => !a.startsWith("-"));
  return path.resolve(dir ?? fallback);
}

function cmdInstall(argv: string[]): void {
  const dir = pkgDir(argv);
  const report = install(dir);
  console.log(`installed into ${path.join(dir, "flow_modules")}`);
  for (const p of report.installed) console.log(`  ${p.name}@${p.version}  ${p.integrity.slice(0, 23)}…`);
  for (const p of report.fromPath) console.log(`  ${p.name} (path) -> ${p.dir}`);
  if (!report.installed.length && !report.fromPath.length) console.log("  (no dependencies)");
  console.log(`wrote ${path.join(dir, "flow.lock")}`);
}

function cmdAdd(argv: string[]): void {
  const spec = argv.find((a) => !a.startsWith("-") && !a.startsWith(".") && !path.isAbsolute(a));
  if (!spec) throw new FlowError("add: missing <name>[@range]", { code: "E_CLI" });
  const dir = pkgDir(argv.filter((a) => a !== spec));
  const { name, version } = add(dir, spec);
  console.log(`added ${name}@^${version} to ${path.join(dir, "flow.json")}`);
}

function cmdVerify(argv: string[]): void {
  const dir = pkgDir(argv);
  const problems = verifyLock(dir);
  if (problems.length) {
    for (const p of problems) console.error(`  ${p}`);
    process.exitCode = 1;
    return;
  }
  console.log("ok: flow_modules matches flow.lock");
}

function cmdRegistry(): void {
  const index = readRegistry();
  console.log(`registry: ${registryDir()}`);
  for (const [name, info] of Object.entries(index.packages)) {
    console.log(`  ${name.padEnd(20)} ${Object.keys(info.versions).sort().join(", ")}`);
  }
}

function arg(list: string[], name: string): string | undefined {
  const i = list.indexOf(name);
  return i >= 0 ? list[i + 1] : undefined;
}

function build(argv: string[]): void {
  const file = argv.find((a) => a.endsWith(".flow"));
  if (!file) throw new FlowError("build: missing <file.flow>", { code: "E_CLI" });
  const outDir = arg(argv, "--out") ?? "dist";
  const result = compileFile(file);
  emit(result, outDir);
  console.log(`built ${file} -> ${outDir}`);
  console.log(`  ${result.diagnostics.length} cut(s) inferred`);
  for (const d of result.diagnostics) console.log(`    ${d}`);
}

function check(argv: string[]): void {
  const file = argv.find((a) => a.endsWith(".flow"));
  if (!file) throw new FlowError("check: missing <file.flow>", { code: "E_CLI" });
  const result = compileFile(file);
  console.log(`ok: ${file} type-checks (${result.diagnostics.length} cut(s) inferred)`);
}

function explain(argv: string[]): void {
  const file = argv.find((a) => a.endsWith(".flow"));
  if (!file) throw new FlowError("explain: missing <file.flow>", { code: "E_CLI" });
  const result = compileFile(file);
  const origin = (name: string) => result.display?.get(name) ?? name;
  console.log(`# ${file}`);
  console.log("");
  console.log("## functions and their inferred placement");
  for (const [name, fn] of result.mod.fns) {
    if (fn.synthetic) continue;
    const from = origin(name);
    if (from.startsWith("std::")) continue; // the library itself is noise here
    const h = result.codegen.home(fn.body);
    const eff = fn.scheme.k === "fun" ? [...fn.scheme.eff.labels].sort() : [];
    console.log(`  ${from.padEnd(34)} ${(h === "neutral" ? "both" : h).padEnd(8)} effects: {${eff.join(", ")}}`);
  }
  console.log("");
  console.log("## boundary cuts");
  if (!result.diagnostics.length) console.log("  (none — the program is single-tier)");
  for (const d of result.diagnostics) console.log(`  ${d}`);
  console.log("");
  console.log("## emitted bundles");
  console.log(`  client: ${result.client.split("\n").length} lines`);
  console.log(`  server: ${result.server.split("\n").length} lines`);
}

async function run(argv: string[]): Promise<void> {
  const file = argv.find((a) => a.endsWith(".flow"));
  if (!file) throw new FlowError("run: missing <file.flow>", { code: "E_CLI" });
  const port = Number(arg(argv, "--port") ?? 4173);
  const secrets: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--secret") {
      const pair = argv[i + 1] ?? "";
      const eq = pair.indexOf("=");
      if (eq > 0) secrets[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }

  const result = compileFile(file);
  const outDir = path.join(process.cwd(), ".flow-build");
  emit(result, outDir);

  const host = await createHost({ outDir, port, secrets });
  console.log(`flow: ${file}`);
  console.log(`  serving ${host.url}`);
  console.log(`  ${result.diagnostics.length} cut(s) inferred across the boundary`);
  for (const d of result.diagnostics) console.log(`    ${d}`);
  console.log("  ctrl-c to stop");

  const shutdown = async () => { await host.close(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
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

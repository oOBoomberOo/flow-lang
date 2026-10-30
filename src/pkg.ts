/**
 * Flow — package management.
 *
 * Manifest (`flow.json`):  { name, version, dependencies }
 * Lockfile (`flow.lock`):  resolved versions + integrity hashes
 * Registry:                ./registry/index.json  (or $FLOW_REGISTRY)
 * Vendored deps:           ./flow_modules/<name>/
 *
 * Dependency specs: `"path:../x"` (local) or a semver range (`^1.2.0`, `~1.2`,
 * `1.2.3`, `*`) resolved against the registry.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { FlowError } from "./lexer.ts";
import { readManifest } from "./modules.ts";
import type { Manifest } from "./modules.ts";

export interface LockEntry {
  version: string;
  integrity: string;
  dependencies: Record<string, string>;
}

export interface Lockfile {
  lockfileVersion: number;
  packages: Record<string, LockEntry>;
}

export const DEFAULT_REGISTRY = path.join(import.meta.dirname, "..", "registry");

export function registryDir(): string {
  return process.env.FLOW_REGISTRY ?? DEFAULT_REGISTRY;
}

/* ------------------------------------------------------------------ */
/* semver (the small, honest subset)                                  */
/* ------------------------------------------------------------------ */

type SemVer = [number, number, number];

export function parseVersion(v: string): SemVer {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) throw new FlowError(`invalid version '${v}' (expected x.y.z)`, { code: "E_PKG" });
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i]! !== y[i]!) return x[i]! - y[i]!;
  return 0;
}

/** Supports `*`, `1.2.3`, `^1.2.3`, `~1.2.3`. */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  const r = range.trim();
  if (r === "*" || r === "" || r === "latest") return true;

  const op = r[0] === "^" || r[0] === "~" ? r[0] : "";
  const base = op ? r.slice(1) : r;
  const lo = parseVersion(base);

  const ge = (a: SemVer, b: SemVer) =>
    a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] >= b[2])));
  const lt = (a: SemVer, b: SemVer) =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));

  if (!op) return v[0] === lo[0] && v[1] === lo[1] && v[2] === lo[2];

  let hi: SemVer;
  if (op === "~") {
    hi = [lo[0], lo[1] + 1, 0];                       // ~1.2.3 := >=1.2.3 <1.3.0
  } else if (lo[0] === 0) {
    hi = [0, lo[1] + 1, 0];                           // ^0.2.3 := >=0.2.3 <0.3.0
  } else {
    hi = [lo[0] + 1, 0, 0];                           // ^1.2.3 := >=1.2.3 <2.0.0
  }
  return ge(v, lo) && lt(v, hi);
}

export function bestVersion(versions: string[], range: string): string | null {
  const ok = versions.filter((v) => satisfies(v, range)).sort(compareVersions);
  return ok.length ? ok[ok.length - 1]! : null;
}

/* ------------------------------------------------------------------ */
/* registry                                                           */
/* ------------------------------------------------------------------ */

export interface RegistryIndex {
  packages: Record<string, { versions: Record<string, { path: string }> }>;
}

export function readRegistry(dir = registryDir()): RegistryIndex {
  const file = path.join(dir, "index.json");
  if (!fs.existsSync(file)) {
    throw new FlowError(`registry index not found at ${file}`, { code: "E_PKG" });
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as RegistryIndex;
}

export function resolveFromRegistry(name: string, range: string, dir = registryDir()): { version: string; dir: string } {
  const index = readRegistry(dir);
  const pkg = index.packages[name];
  if (!pkg) throw new FlowError(`package '${name}' is not in the registry`, { code: "E_PKG" });
  const version = bestVersion(Object.keys(pkg.versions), range);
  if (!version) {
    throw new FlowError(
      `no version of '${name}' satisfies '${range}' (available: ${Object.keys(pkg.versions).join(", ")})`,
      { code: "E_PKG" },
    );
  }
  return { version, dir: path.join(dir, pkg.versions[version]!.path) };
}

/* ------------------------------------------------------------------ */
/* integrity                                                          */
/* ------------------------------------------------------------------ */

export function treeIntegrity(dir: string): string {
  const files: string[] = [];
  const walk = (d: string, prefix: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.name === "flow_modules" || entry.name === "node_modules") continue;
      if (entry.isDirectory()) walk(full, rel);
      else files.push(rel);
    }
  };
  walk(dir, "");
  const h = crypto.createHash("sha256");
  for (const rel of files) {
    h.update(rel);
    h.update("\0");
    h.update(fs.readFileSync(path.join(dir, rel)));
    h.update("\0");
  }
  return "sha256-" + h.digest("hex");
}

function copyTree(from: string, to: string) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === "flow_modules" || entry.name === "node_modules") continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

/* ------------------------------------------------------------------ */
/* install                                                            */
/* ------------------------------------------------------------------ */

export interface InstallReport {
  installed: { name: string; version: string; integrity: string }[];
  fromPath: { name: string; dir: string }[];
}

export function install(root: string): InstallReport {
  const manifest = readManifest(root);
  if (!manifest) throw new FlowError(`no flow.json in ${root}`, { code: "E_PKG" });

  const lock: Lockfile = { lockfileVersion: 1, packages: {} };
  const report: InstallReport = { installed: [], fromPath: [] };
  const queue: { name: string; range: string; parent: string }[] = Object.entries(manifest.dependencies)
    .map(([name, range]) => ({ name, range, parent: manifest.name }));
  const done = new Set<string>();

  while (queue.length) {
    const { name, range, parent } = queue.shift()!;
    if (done.has(name)) continue;
    done.add(name);

    if (range.startsWith("path:")) {
      const dir = path.resolve(root, range.slice(5));
      report.fromPath.push({ name, dir });
      // still hoist its own registry deps
      const sub = readManifest(dir);
      for (const [n, r] of Object.entries(sub?.dependencies ?? {})) {
        queue.push({ name: n, range: r, parent: name });
      }
      continue;
    }

    const { version, dir } = resolveFromRegistry(name, range);
    const integrity = treeIntegrity(dir);
    const dest = path.join(root, "flow_modules", name);
    copyTree(dir, dest);
    const sub = readManifest(dest);
    lock.packages[name] = { version, integrity, dependencies: sub?.dependencies ?? {} };
    report.installed.push({ name, version, integrity });

    for (const [n, r] of Object.entries(sub?.dependencies ?? {})) {
      if (!r.startsWith("path:")) queue.push({ name: n, range: r, parent: name });
    }
  }

  fs.writeFileSync(path.join(root, "flow.lock"), JSON.stringify(lock, null, 2) + "\n");
  return report;
}

export function verifyLock(root: string): string[] {
  const lockFile = path.join(root, "flow.lock");
  if (!fs.existsSync(lockFile)) return ["no flow.lock (run 'flow install')"];
  const lock = JSON.parse(fs.readFileSync(lockFile, "utf8")) as Lockfile;
  const problems: string[] = [];
  for (const [name, entry] of Object.entries(lock.packages)) {
    const dir = path.join(root, "flow_modules", name);
    if (!fs.existsSync(dir)) { problems.push(`${name}: not installed`); continue; }
    const actual = treeIntegrity(dir);
    if (actual !== entry.integrity) problems.push(`${name}: integrity mismatch (expected ${entry.integrity}, got ${actual})`);
  }
  return problems;
}

export function add(root: string, spec: string): { name: string; version: string } {
  const at = spec.lastIndexOf("@");
  const name = at > 0 ? spec.slice(0, at) : spec;
  const range = at > 0 ? spec.slice(at + 1) : "*";
  const { version } = resolveFromRegistry(name, range);

  const manifestFile = path.join(root, "flow.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as Manifest;
  manifest.dependencies = { ...(manifest.dependencies ?? {}), [name]: `^${version}` };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  install(root);
  return { name, version };
}

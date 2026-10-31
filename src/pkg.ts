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
import {
  parseDependency, resolveRegistry, fetchGit, registryDirFor, DEFAULT_REGISTRY_URL,
  type DependencyValue, type RegistryConfig,
} from "./registry.ts";

export type DependencySource = "registry" | "path" | "git";

export interface LockEntry {
  version: string;
  integrity: string;
  /** where the code came from, so an install can be reproduced */
  source?: DependencySource;
  /** registry url/path, git url, or local directory */
  resolved?: string;
  dependencies: Record<string, string | DependencyValue>;
}

export interface Lockfile {
  lockfileVersion: number;
  packages: Record<string, LockEntry>;
}

/** The registry that applies to `root`, honouring project/global/env settings. */
export function registryFor(root: string, manifest?: Manifest | null, refresh = false) {
  return resolveRegistry({
    root,
    project: manifest?.registry,
    refresh,
    quiet: false,
  });
}

/** Directory of a local registry shipped with the repo, for offline development. */
export const DEFAULT_REGISTRY = path.join(import.meta.dirname, "..", "registry");

export function registryDir(root = process.cwd()): string {
  return registryFor(root).dir;
}

export interface InstallOptions {
  /** re-fetch git registries and git dependencies */
  refresh?: boolean;
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
  fromGit: { name: string; url: string; ref?: string; dir: string }[];
}

export function install(root: string, opts: InstallOptions = {}): InstallReport {
  const manifest = readManifest(root);
  if (!manifest) throw new FlowError(`no flow.json in ${root}`, { code: "E_PKG" });

  const lock: Lockfile = { lockfileVersion: 1, packages: {} };
  const report: InstallReport = { installed: [], fromPath: [], fromGit: [] };
  const queue: { name: string; spec: DependencyValue; parent: string }[] = Object.entries(manifest.dependencies)
    .map(([name, spec]) => ({ name, spec, parent: manifest.name }));
  const done = new Set<string>();

  while (queue.length) {
    const { name, spec, parent } = queue.shift()!;
    if (done.has(name)) continue;
    done.add(name);
    const dep = parseDependency(name, spec);

    if (dep.kind === "path") {
      const dir = path.resolve(root, dep.dir);
      if (!fs.existsSync(path.join(dir, "flow.json"))) {
        throw new FlowError(`dependency '${name}' not found at ${dir}`, { code: "E_PKG" });
      }
      report.fromPath.push({ name, dir });
      const sub = readManifest(dir);
      lock.packages[name] = {
        version: sub?.version ?? "0.0.0",
        integrity: treeIntegrity(dir),
        source: "path",
        resolved: dep.dir,
        dependencies: sub?.dependencies ?? {},
      };
      for (const [n, r] of Object.entries(sub?.dependencies ?? {})) {
        queue.push({ name: n, spec: r, parent: name });
      }
      continue;
    }

    if (dep.kind === "git") {
      const cached = fetchGit(dep.url, dep.ref, { refresh: opts.refresh });
      const sub = readManifest(cached);
      if (!sub) throw new FlowError(`git dependency '${name}' (${dep.url}) has no flow.json`, { code: "E_PKG" });
      const dest = path.join(root, "flow_modules", name);
      copyTree(cached, dest);
      lock.packages[name] = {
        version: sub.version,
        integrity: treeIntegrity(dest),
        source: "git",
        resolved: `${dep.url}${dep.ref ? `#${dep.ref}` : ""}`,
        dependencies: sub.dependencies ?? {},
      };
      report.fromGit.push({ name, url: dep.url, ref: dep.ref, dir: dest });
      for (const [n, r] of Object.entries(sub.dependencies ?? {})) {
        queue.push({ name: n, spec: r, parent: name });
      }
      continue;
    }

    const registry = resolveRegistry({
      root,
      project: manifest.registry,
      override: dep.registry,
      refresh: opts.refresh,
      quiet: false,
    });
    const { version, dir } = resolveFromRegistry(name, dep.range, registry.dir);
    const integrity = treeIntegrity(dir);
    const dest = path.join(root, "flow_modules", name);
    copyTree(dir, dest);
    const sub = readManifest(dest);
    lock.packages[name] = {
      version,
      integrity,
      source: "registry",
      resolved: registry.source,
      dependencies: sub?.dependencies ?? {},
    };
    report.installed.push({ name, version, integrity });

    for (const [n, r] of Object.entries(sub?.dependencies ?? {})) {
      if (!String(r).startsWith("path:")) queue.push({ name: n, spec: r, parent: name });
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
    // path dependencies are linked from their directory, not vendored
    if (entry.source === "path") {
      const dir = entry.resolved ? path.resolve(root, entry.resolved) : path.join(root, "flow_modules", name);
      if (!fs.existsSync(path.join(dir, "flow.json"))) problems.push(`${name}: path dependency missing at ${dir}`);
      continue;
    }
    const dir = path.join(root, "flow_modules", name);
    if (!fs.existsSync(dir)) { problems.push(`${name}: not installed`); continue; }
    const actual = treeIntegrity(dir);
    if (actual !== entry.integrity) problems.push(`${name}: integrity mismatch (expected ${entry.integrity}, got ${actual})`);
  }
  return problems;
}

/**
 * `flow add <name>[@range]`, `flow add path:../x`, `flow add git:<url>#<ref>`.
 * A path/git spec takes its name from the dependency's flow.json.
 */
export function add(root: string, spec: string): { name: string; version: string } {
  const manifestFile = path.join(root, "flow.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as Manifest;

  if (spec.startsWith("path:") || spec.startsWith("file:") || spec.startsWith("git:") || spec.startsWith("github:")) {
    const probe = parseDependency("", spec);
    let name: string;
    let version: string;
    let value: DependencyValue = spec;
    if (probe.kind === "path") {
      const dir = path.resolve(root, probe.dir);
      const sub = readManifest(dir);
      if (!sub) throw new FlowError(`no flow.json at ${dir}`, { code: "E_PKG" });
      name = sub.name;
      version = sub.version;
    } else if (probe.kind === "git") {
      const dir = fetchGit(probe.url, probe.ref, {});
      const sub = readManifest(dir);
      if (!sub) throw new FlowError(`no flow.json in ${probe.url}`, { code: "E_PKG" });
      name = sub.name;
      version = sub.version;
      value = spec;
    } else {
      throw new FlowError(`unsupported spec '${spec}'`, { code: "E_PKG" });
    }
    manifest.dependencies = { ...(manifest.dependencies ?? {}), [name]: value };
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
    install(root);
    return { name, version };
  }

  const at = spec.lastIndexOf("@");
  const name = at > 0 ? spec.slice(0, at) : spec;
  const range = at > 0 ? spec.slice(at + 1) : "*";
  const { version } = resolveFromRegistry(name, range, registryFor(root, manifest).dir);

  manifest.dependencies = { ...(manifest.dependencies ?? {}), [name]: `^${version}` };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  install(root);
  return { name, version };
}

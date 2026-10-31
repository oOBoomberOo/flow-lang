/**
 * Flow — registries and dependency specs.
 *
 * A *registry* is a directory containing `index.json`:
 *
 *   { "packages": { "flow-time": { "versions": { "1.2.0": { "path": "packages/flow-time/1.2.0" } } } } }
 *
 * It can be a local directory or a git repository. The default registry is the
 * flow-registry GitHub repository; git registries are cloned into a cache and
 * refreshed on demand.
 *
 * Which registry applies, from strongest to weakest:
 *
 *   1. the dependency's own `registry` (per package)
 *   2. the project's `flow.json` `registry` (per project)
 *   3. the user's `~/.config/flow/config.json` (global)
 *   4. `$FLOW_REGISTRY`
 *   5. the default registry
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { FlowError } from "./lexer.ts";

export const DEFAULT_REGISTRY_URL = "https://github.com/oOBoomberOo/flow-registry.git";

/** A registry location: a git URL, or a directory on disk. */
export interface RegistryConfig {
  /** git URL (`https://…`, `git@…`, `file:///…`) or a path */
  url?: string;
  /** branch, tag or commit for a git registry */
  ref?: string;
  /** local directory (wins over `url` when both are set) */
  path?: string;
}

export type RegistryOrigin = "dependency" | "project" | "global" | "env" | "default";

export interface ResolvedRegistry {
  /** directory containing index.json */
  dir: string;
  /** human-readable source, e.g. `git:https://…@main` or `./registry` */
  source: string;
  origin: RegistryOrigin;
}

/* ------------------------------------------------------------------ */
/* configuration                                                      */
/* ------------------------------------------------------------------ */

export function userConfigPath(): string {
  if (process.env.FLOW_CONFIG) return path.resolve(process.env.FLOW_CONFIG);
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "flow", "config.json");
}

export interface UserConfig {
  registry?: string | RegistryConfig;
}

export function readUserConfig(): UserConfig {
  const file = userConfigPath();
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as UserConfig;
  } catch (e) {
    throw new FlowError(`invalid user config ${file}: ${(e as Error).message}`, { file, code: "E_PKG" });
  }
}

/** The cache root for fetched git registries and dependencies. */
export function cacheDir(): string {
  if (process.env.FLOW_CACHE) return path.resolve(process.env.FLOW_CACHE);
  return path.join(os.homedir(), ".flow", "cache");
}

export function registryCacheDir(): string {
  return path.join(cacheDir(), "registries");
}

function slug(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

/* ------------------------------------------------------------------ */
/* spec parsing                                                       */
/* ------------------------------------------------------------------ */

export type DependencySpec =
  | { kind: "registry"; name: string; range: string; registry?: string | RegistryConfig }
  | { kind: "path"; name: string; dir: string }
  | { kind: "git"; name: string; url: string; ref?: string };

export interface DependencyObject {
  range?: string;
  registry?: string | RegistryConfig;
  path?: string;
  git?: string;
  github?: string;
  ref?: string;
}

export type DependencyValue = string | DependencyObject;

function splitRef(text: string): { url: string; ref?: string } {
  const at = text.lastIndexOf("#");
  if (at <= 0) return { url: text };
  return { url: text.slice(0, at), ref: text.slice(at + 1) || undefined };
}

function gitUrl(text: string): string {
  if (text.startsWith("github:")) {
    return `https://github.com/${text.slice("github:".length).replace(/\.git$/, "")}.git`;
  }
  if (text.startsWith("git+")) return text.slice(4);
  return text;
}

/** Read a dependency entry: a range, `path:…`, `git:…`, `github:…`, or an object. */
/** `git:…`/`github:…`/`https://…` is a git registry; anything else is a directory. */
export function parseRegistryConfig(cfg: string): RegistryConfig {
  const text = cfg.trim();
  if (/^(git\+|git:|github:|https?:\/\/|git@|ssh:\/\/)/.test(text)) {
    const { url, ref } = splitRef(text.replace(/^(git\+|git):/, ""));
    return { url: gitUrl(url), ref };
  }
  return { path: text };
}

export function parseDependency(name: string, spec: DependencyValue): DependencySpec {
  if (typeof spec === "object" && spec !== null) {
    if (spec.path) return { kind: "path", name, dir: spec.path };
    if (spec.git || spec.github) {
      const { url, ref } = splitRef(gitUrl(spec.git ?? spec.github!));
      return { kind: "git", name, url, ref: spec.ref ?? ref };
    }
    return { kind: "registry", name, range: spec.range ?? "*", registry: spec.registry };
  }
  const text = String(spec).trim();
  if (text.startsWith("path:") || text.startsWith("file:")) {
    return { kind: "path", name, dir: text.replace(/^(path|file):/, "") };
  }
  if (text.startsWith("git:") || text.startsWith("git+") || text.startsWith("github:") || /^https?:\/\/.*\.git(#.*)?$/.test(text)) {
    const { url, ref } = splitRef(text.replace(/^git(\+|:)/, ""));
    return { kind: "git", name, url: gitUrl(url), ref };
  }
  return { kind: "registry", name, range: text || "*" };
}

/* ------------------------------------------------------------------ */
/* git                                                                */
/* ------------------------------------------------------------------ */

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitAvailable(): boolean {
  try { git(["--version"]); return true; } catch { return false; }
}

export interface FetchOptions {
  /** re-fetch even when a cached copy exists */
  refresh?: boolean;
  /** quiet: do not print progress */
  quiet?: boolean;
}

/**
 * Clone (or update) `url` at `ref` into the cache and return the directory.
 * When the fetch fails and a cached copy exists, the cache is used with a
 * warning rather than failing the build.
 */
export function fetchGit(url: string, ref: string | undefined, opts: FetchOptions = {}): string {
  const dir = path.join(registryCacheDir(), `${slug(url)}${ref ? `-${slug(ref)}` : ""}`);
  const exists = fs.existsSync(path.join(dir, "index.json")) || fs.existsSync(path.join(dir, ".git"));
  if (!exists) {
    if (!gitAvailable()) {
      throw new FlowError(`git is required to fetch ${url} (install git or use a local registry path)`, { code: "E_PKG" });
    }
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const args = ["clone", "--depth", "1"];
    if (ref) args.push("--branch", ref);
    args.push(url, dir);
    try {
      git(args);
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new FlowError(`could not clone ${url}${ref ? `#${ref}` : ""}: ${(e as Error).message}`, { code: "E_PKG" });
    }
    return dir;
  }
  if (!opts.refresh) return dir;
  try {
    git(["fetch", "--depth", "1", "origin", ref ?? "HEAD"], dir);
    git(["reset", "--hard", "FETCH_HEAD"], dir);
  } catch (e) {
    if (!opts.quiet) {
      console.error(`[flow] using the cached copy of ${url}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  return dir;
}

/** Turn a registry config into the directory that holds its `index.json`. */
export function registryDirFor(cfg: RegistryConfig | string, root: string, opts: FetchOptions = {}): { dir: string; source: string } {
  const config: RegistryConfig = typeof cfg === "string" ? parseRegistryConfig(cfg) : cfg;
  if (config.path) {
    const dir = path.resolve(root, config.path);
    if (!fs.existsSync(path.join(dir, "index.json"))) {
      throw new FlowError(`registry at ${dir} has no index.json`, { file: dir, code: "E_PKG" });
    }
    return { dir, source: config.path };
  }
  const url = config.url ?? DEFAULT_REGISTRY_URL;
  if (!/^(https?:\/\/|git@|ssh:\/\/|file:\/\/|\.{0,2}\/)/.test(url)) {
    // a bare path is a directory registry
    const dir = path.resolve(root, url);
    if (fs.existsSync(path.join(dir, "index.json"))) return { dir, source: url };
  }
  const dir = fetchGit(url, config.ref, opts);
  if (!fs.existsSync(path.join(dir, "index.json"))) {
    throw new FlowError(
      `registry ${url}${config.ref ? `#${config.ref}` : ""} has no index.json at its root ` +
      `(expected the registry repository to contain index.json and packages/)`,
      { code: "E_PKG" },
    );
  }
  return { dir, source: `git:${url}${config.ref ? `@${config.ref}` : ""}` };
}

/** Resolve the registry for a project, honouring the documented precedence. */
export function resolveRegistry(opts: {
  /** project root (for relative paths and the project's flow.json) */
  root: string;
  /** the project's `registry` field, if any */
  project?: string | RegistryConfig;
  /** the dependency's own registry, if any */
  override?: string | RegistryConfig;
  refresh?: boolean;
  quiet?: boolean;
}): ResolvedRegistry {
  const fetchOpts = { refresh: opts.refresh, quiet: opts.quiet };
  if (opts.override) {
    const r = registryDirFor(opts.override, opts.root, fetchOpts);
    return { ...r, origin: "dependency" };
  }
  if (opts.project) {
    const r = registryDirFor(opts.project, opts.root, fetchOpts);
    return { ...r, origin: "project" };
  }
  const global = readUserConfig().registry;
  if (global) {
    const r = registryDirFor(global, opts.root, fetchOpts);
    return { ...r, origin: "global" };
  }
  if (process.env.FLOW_REGISTRY) {
    const r = registryDirFor(process.env.FLOW_REGISTRY, opts.root, fetchOpts);
    return { ...r, origin: "env" };
  }
  const r = registryDirFor({ url: DEFAULT_REGISTRY_URL }, opts.root, fetchOpts);
  return { ...r, origin: "default" };
}

/** A short description of the active registry chain, for `flow registry`. */
export function describeRegistryChain(root: string, project?: string | RegistryConfig): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  const global = readUserConfig().registry;
  const show = (label: string, v: string | RegistryConfig | undefined) => {
    if (!v) return;
    if (typeof v === "string") out.push({ label, value: v });
    else out.push({ label, value: v.path ?? `git:${v.url ?? DEFAULT_REGISTRY_URL}${v.ref ? `@${v.ref}` : ""}` });
  };
  show("project", project);
  show("global", global);
  if (process.env.FLOW_REGISTRY) out.push({ label: "env", value: process.env.FLOW_REGISTRY });
  out.push({ label: "default", value: DEFAULT_REGISTRY_URL });
  void root;
  return out;
}

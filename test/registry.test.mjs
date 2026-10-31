import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { install, verifyLock, add } from "../src/pkg.ts";
import {
  parseDependency, resolveRegistry, readUserConfig, userConfigPath, cacheDir,
} from "../src/registry.ts";
import { FlowError } from "../src/lexer.ts";

/* A registry or package is just a git repository; build them locally so the
 * tests never touch the network. */

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function gitRepo(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, src] of Object.entries(files)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, src);
  }
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

function bareRepo(source, dest) {
  git(path.dirname(dest), "clone", "-q", "--bare", source, dest);
  return dest;
}

/** A registry checkout with one package, as a git repository. */
function registryRepo(pkgName, version, extraDeps = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "flow-regwork-"));
  const pkgDir = path.join(work, "packages", pkgName, version);
  gitRepo(work, {
    "index.json": JSON.stringify({
      packages: { [pkgName]: { versions: { [version]: { path: `packages/${pkgName}/${version}` } } } },
    }, null, 2),
    [`packages/${pkgName}/${version}/flow.json`]: JSON.stringify({
      name: pkgName, version, dependencies: extraDeps,
    }, null, 2),
    [`packages/${pkgName}/${version}/src/lib.flow`]: `greeting :: Str -> Str\ngreeting who = "hi " + who\n`,
  });
  void pkgDir;
  const bare = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "flow-regbare-")), "registry.git");
  return bareRepo(work, bare);
}

function packageRepo(name, version, deps = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "flow-pkgwork-"));
  gitRepo(work, {
    "flow.json": JSON.stringify({ name, version, dependencies: deps }, null, 2),
    "src/lib.flow": `value :: Int\nvalue = 1\n`,
  });
  const bare = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "flow-pkgbare-")), `${name}.git`);
  return bareRepo(work, bare);
}

function project(deps, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-regproj-"));
  fs.writeFileSync(path.join(dir, "flow.json"), JSON.stringify({
    name: "consumer", version: "0.1.0", dependencies: deps, ...extra,
  }, null, 2));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  return dir;
}

// Keep the tests hermetic: no user config and no env registry leaking in.
function isolate(env = {}) {
  const saved = { FLOW_CACHE: process.env.FLOW_CACHE, FLOW_REGISTRY: process.env.FLOW_REGISTRY, FLOW_CONFIG: process.env.FLOW_CONFIG };
  process.env.FLOW_CACHE = fs.mkdtempSync(path.join(os.tmpdir(), "flow-cache-"));
  process.env.FLOW_CONFIG = path.join(process.env.FLOW_CACHE, "config.json");
  delete process.env.FLOW_REGISTRY;
  Object.assign(process.env, env);
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

test("registry: dependency specs parse every form", () => {
  assert.deepEqual(parseDependency("a", "^1.2.0"), { kind: "registry", name: "a", range: "^1.2.0" });
  assert.deepEqual(parseDependency("a", "*"), { kind: "registry", name: "a", range: "*" });
  assert.deepEqual(parseDependency("a", "path:../a"), { kind: "path", name: "a", dir: "../a" });
  assert.deepEqual(parseDependency("a", "file:./a"), { kind: "path", name: "a", dir: "./a" });
  assert.deepEqual(parseDependency("a", "git:https://x/y.git#v1"), { kind: "git", name: "a", url: "https://x/y.git", ref: "v1" });
  assert.deepEqual(parseDependency("a", "github:me/pkg#main"), { kind: "git", name: "a", url: "https://github.com/me/pkg.git", ref: "main" });
  assert.deepEqual(parseDependency("a", { git: "https://x/y.git", ref: "v2" }), { kind: "git", name: "a", url: "https://x/y.git", ref: "v2" });
  assert.deepEqual(parseDependency("a", { range: "^2", registry: "./reg" }), { kind: "registry", name: "a", range: "^2", registry: "./reg" });
});

test("registry: precedence is dependency > project > global > env > default", () => {
  const repoRegistry = path.join(import.meta.dirname, "..", "registry");
  const restore = isolate({ FLOW_REGISTRY: repoRegistry });
  try {
    const root = project({});
    // nothing configured: the default git registry
    assert.equal(resolveRegistry({ root, refresh: false }).origin, "env");
    // env
    const viaEnv = resolveRegistry({ root });
    assert.equal(viaEnv.origin, "env");
    assert.equal(viaEnv.dir, repoRegistry);
    // global config beats env
    fs.writeFileSync(userConfigPath(), JSON.stringify({ registry: { path: repoRegistry } }));
    const viaGlobal = resolveRegistry({ root });
    assert.equal(viaGlobal.origin, "global");
    // project beats global
    const viaProject = resolveRegistry({ root, project: { path: repoRegistry } });
    assert.equal(viaProject.origin, "project");
    // a dependency override beats the project
    const viaDep = resolveRegistry({ root, project: { path: repoRegistry }, override: { path: repoRegistry } });
    assert.equal(viaDep.origin, "dependency");
  } finally {
    restore();
  }
});

test("registry: installs from a git registry, a git package and a local path", () => {
  const restore = isolate();
  try {
    const registry = registryRepo("remote-lib", "1.0.0");
    const gitPkg = packageRepo("git-lib", "2.0.0");
    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-localpkg-"));
    fs.writeFileSync(path.join(localDir, "flow.json"), JSON.stringify({ name: "local-lib", version: "3.0.0", dependencies: {} }));
    fs.mkdirSync(path.join(localDir, "src"));
    fs.writeFileSync(path.join(localDir, "src", "lib.flow"), "localValue :: Int\nlocalValue = 3\n");

    const root = project(
      {
        "remote-lib": "^1.0.0",
        "git-lib": `git:${gitPkg}#main`,
        "local-lib": "path:../flow-localpkg",
      },
      { registry: `git:${registry}` },
    );
    // the path dependency is resolved relative to the project, so place it next door
    const sibling = path.join(path.dirname(root), "flow-localpkg");
    fs.rmSync(sibling, { recursive: true, force: true });
    fs.cpSync(localDir, sibling, { recursive: true });
    fs.writeFileSync(path.join(root, "flow.json"), JSON.stringify({
      name: "consumer", version: "0.1.0",
      registry: `git:${registry}`,
      dependencies: {
        "remote-lib": "^1.0.0",
        "git-lib": `git:${gitPkg}#main`,
        "local-lib": "path:../flow-localpkg",
      },
    }, null, 2));

    const report = install(root);
    assert.deepEqual(report.installed.map((p) => `${p.name}@${p.version}`), ["remote-lib@1.0.0"]);
    assert.equal(report.fromGit.length, 1);
    assert.equal(report.fromGit[0].name, "git-lib");
    assert.equal(report.fromPath[0].name, "local-lib");
    assert.ok(fs.existsSync(path.join(root, "flow_modules", "remote-lib", "src", "lib.flow")));
    assert.ok(fs.existsSync(path.join(root, "flow_modules", "git-lib", "src", "lib.flow")));

    const lock = JSON.parse(fs.readFileSync(path.join(root, "flow.lock"), "utf8"));
    assert.equal(lock.packages["remote-lib"].source, "registry");
    assert.match(lock.packages["remote-lib"].resolved, /^git:/);
    assert.equal(lock.packages["git-lib"].source, "git");
    assert.match(lock.packages["git-lib"].resolved, /#main$/);
    assert.equal(lock.packages["local-lib"].source, "path");
    assert.deepEqual(verifyLock(root), []);
  } finally {
    restore();
  }
});

test("registry: a per-package registry overrides the project", () => {
  const restore = isolate();
  try {
    const registryA = registryRepo("pkg-a", "1.0.0");
    const registryB = registryRepo("pkg-b", "1.0.0");
    const root = project(
      {
        "pkg-a": "^1.0.0",
        "pkg-b": { range: "^1.0.0", registry: `git:${registryB}` },
      },
      { registry: `git:${registryA}` },
    );
    const report = install(root);
    assert.deepEqual(report.installed.map((p) => p.name).sort(), ["pkg-a", "pkg-b"]);
    const lock = JSON.parse(fs.readFileSync(path.join(root, "flow.lock"), "utf8"));
    assert.match(lock.packages["pkg-a"].resolved, new RegExp(registryA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(lock.packages["pkg-b"].resolved, new RegExp(registryB.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    restore();
  }
});

test("registry: a missing package or bad ref has an actionable error", () => {
  const restore = isolate();
  try {
    const registry = registryRepo("only-pkg", "1.0.0");
    const root = project({ "nope": "^1.0.0" }, { registry: `git:${registry}` });
    assert.throws(() => install(root), /is not in the registry/);

    const badRef = project({ "only-pkg": "^1.0.0" }, { registry: `git:${registry}#does-not-exist` });
    assert.throws(() => install(badRef), /could not clone|does not exist|not found/i);
  } finally {
    restore();
  }
});

test("registry: add understands a path spec and records it verbatim", () => {
  const restore = isolate();
  try {
    const root = project({});
    const local = path.join(path.dirname(root), "flow-addlib");
    fs.rmSync(local, { recursive: true, force: true });
    fs.mkdirSync(path.join(local, "src"), { recursive: true });
    fs.writeFileSync(path.join(local, "flow.json"), JSON.stringify({ name: "addlib", version: "1.2.3", dependencies: {} }));
    fs.writeFileSync(path.join(local, "src", "lib.flow"), "added :: Int\nadded = 1\n");
    const { name, version } = add(root, "path:../flow-addlib");
    assert.equal(name, "addlib");
    assert.equal(version, "1.2.3");
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "flow.json"), "utf8"));
    assert.equal(manifest.dependencies.addlib, "path:../flow-addlib");
  } finally {
    restore();
  }
});

test("registry: the cache path is overridable and the user config is read", () => {
  const restore = isolate();
  try {
    assert.ok(cacheDir().endsWith(path.basename(process.env.FLOW_CACHE)));
    assert.deepEqual(readUserConfig(), {});
    fs.writeFileSync(userConfigPath(), JSON.stringify({ registry: "github:me/reg#main" }));
    assert.equal(readUserConfig().registry, "github:me/reg#main");
  } finally {
    restore();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * CLI integration tests: spawn the real `flow` command and check Cargo-style
 * output, exit codes, color handling, build artifacts and `flow watch`.
 */

const REPO = path.join(import.meta.dirname, "..");
const CLI = path.join(REPO, "bin", "flow.mjs");

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function run(args, opts = {}) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI, ...args], {
      cwd: opts.cwd ?? REPO,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
    if (opts.timeout) {
      setTimeout(() => { try { proc.kill(); } catch {} }, opts.timeout).unref?.();
    }
  });
}

function write(dir, name, text) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

const MAIN = `main :: Html
main = <p>{"hello"}</p>`;

test("cli: help lists the commands and options", async () => {
  const r = await run(["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage: flow \[OPTIONS\] <COMMAND>/);
  assert.match(r.stdout, /Commands:/);
  for (const cmd of ["check", "build", "run", "watch", "explain", "install"]) {
    assert.match(r.stdout, new RegExp(`\\b${cmd}\\b`), `${cmd} is listed`);
  }
  assert.match(r.stdout, /--color <WHEN>/);

  const w = await run(["help", "watch"]);
  assert.equal(w.code, 0);
  assert.match(w.stdout, /Re-check or rebuild when source files change/);
  assert.match(w.stdout, /--run/);
  assert.match(w.stdout, /--debounce <MS>/);
});

test("cli: version and unknown subcommands", async () => {
  const v = await run(["--version"]);
  assert.equal(v.code, 0);
  assert.match(v.stdout, /^flow \d+\.\d+\.\d+\n$/);

  const bad = await run(["frobnicate"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /error: unrecognized subcommand 'frobnicate'/);
  assert.match(bad.stderr, /Usage: flow \[OPTIONS\] <COMMAND>/);
  assert.match(bad.stderr, /flow --help/);

  const helpBad = await run(["help", "nope"]);
  assert.equal(helpBad.code, 1);
  assert.match(helpBad.stderr, /no such command: 'nope'/);
});

test("cli: check succeeds with Cargo-style progress", async () => {
  const dir = tmp("flow-cli-ok-");
  const file = write(dir, "main.flow", MAIN);
  const r = await run(["check", file]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /Checking .*main\.flow/);
  assert.match(r.stderr, /Finished check in \d+\.\d+s \(no cuts\)/);
});

test("cli: type errors render as rustc-style diagnostics with a summary", async () => {
  const dir = tmp("flow-cli-bad-");
  const file = write(dir, "bad.flow", `f :: () -> Strr
f () = "hello"

g :: () -> Str
g () = 42

main :: Html
main = <p>{f ()} {g ()}</p>
`);
  const r = await run(["check", file, "--color", "never"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /error\[E_TYPE\]: unknown type 'Strr'/);
  assert.match(r.stderr, /--> .*bad\.flow:1:12/);
  assert.match(r.stderr, /1 \| f :: \(\) -> Strr/);
  assert.match(r.stderr, /\| {12}\^\^\^\^/);
  assert.match(r.stderr, /did you mean 'Str'\?/);
  assert.match(r.stderr, /return type mismatch in fn g: expected Str, got Int/);
  assert.match(r.stderr, /5 \| g \(\) = 42/);
  assert.match(r.stderr, /due to 2 previous errors/);
  assert.doesNotMatch(r.stderr, /\x1b\[/, "no color when piped");
});

test("cli: --color always forces ANSI, --color never strips it", async () => {
  const dir = tmp("flow-cli-color-");
  const file = write(dir, "bad.flow", `main :: Html
main = <p>{1 + "x"}</p>`);

  const always = await run(["check", file, "--color", "always"]);
  assert.equal(always.code, 1);
  assert.match(always.stderr, /\x1b\[1;31merror\x1b\[0m/);
  assert.match(always.stderr, /\x1b\[1;34m-->\x1b\[0m/);

  const never = await run(["check", file, "--color", "never"]);
  assert.equal(never.code, 1);
  assert.doesNotMatch(never.stderr, /\x1b\[/);

  const auto = await run(["check", file], { env: { NO_COLOR: "1" } });
  assert.doesNotMatch(auto.stderr, /\x1b\[/);
});

test("cli: unknown flags and missing arguments are rejected", async () => {
  const dir = tmp("flow-cli-flags-");
  const file = write(dir, "main.flow", MAIN);

  const flag = await run(["check", file, "--wat"]);
  assert.equal(flag.code, 1);
  assert.match(flag.stderr, /unexpected argument '--wat' found/);

  const missing = await run(["check"]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /check: missing <file\.flow>/);

  const color = await run(["check", file, "--color", "rainbow"]);
  assert.equal(color.code, 1);
  assert.match(color.stderr, /invalid value 'rainbow' for '--color <WHEN>'/);
});

test("cli: defaults to src/main.flow and accepts a package directory", async () => {
  const dir = tmp("flow-cli-default-");
  write(dir, "flow.json", JSON.stringify({ name: "demo", version: "0.1.0", dependencies: {} }));
  write(dir, "src/main.flow", MAIN);

  const fromCwd = await run(["check"], { cwd: dir });
  assert.equal(fromCwd.code, 0);
  assert.match(fromCwd.stderr, /Checking .*src[\\/]main\.flow/);

  const fromDir = await run(["check", dir]);
  assert.equal(fromDir.code, 0);
  assert.match(fromDir.stderr, /Checking .*src[\\/]main\.flow/);
});

test("cli: build emits modules and the runtime", async () => {
  const dir = tmp("flow-cli-build-");
  const file = write(dir, "main.flow", MAIN);
  const out = path.join(dir, "dist");
  const r = await run(["build", file, "--out", out]);
  assert.equal(r.code, 0);
  for (const f of ["app.js", "server.js", "runtime/core.js", "runtime/server.js", "runtime/client.js", "runtime/dom.js"]) {
    assert.ok(fs.existsSync(path.join(out, f)), `${f} was emitted`);
  }
  assert.match(r.stderr, /Finished build in \d+\.\d+s/);
  assert.match(r.stderr, /-> .*dist/);
});

test("cli: build failure renders diagnostics and does not emit", async () => {
  const dir = tmp("flow-cli-buildfail-");
  const file = write(dir, "bad.flow", `main :: Html
main = 42`);
  const out = path.join(dir, "dist");
  const r = await run(["build", file, "--out", out]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /return type mismatch in fn main: expected Html, got Int/);
  assert.match(r.stderr, /due to 1 previous error/);
  assert.ok(!fs.existsSync(path.join(out, "app.js")), "nothing was emitted");
});

function startWatch(args) {
  const proc = spawn(process.execPath, [CLI, ...args], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  proc.stdout.on("data", (d) => { output += d.toString(); });
  proc.stderr.on("data", (d) => { output += d.toString(); });
  const waitFor = (re, ms = 8000) => new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const tick = () => {
      const m = re.exec(output);
      if (m) return resolve(m);
      if (Date.now() > deadline) return reject(new Error(`timeout waiting for ${re}\n--- output ---\n${output}`));
      setTimeout(tick, 50);
    };
    tick();
  });
  const count = (re) => (output.match(re) ?? []).length;
  return { proc, waitFor, count, output: () => output };
}

async function stopWatch(w) {
  w.proc.kill();
  await new Promise((resolve) => {
    if (w.proc.exitCode !== null) return resolve();
    w.proc.once("close", resolve);
    setTimeout(resolve, 2000).unref?.();
  });
}

test("cli: watch rebuilds on edits and recovers from errors", { timeout: 30000 }, async () => {
  const dir = tmp("flow-cli-watch-");
  const file = write(dir, "main.flow", `main :: Html
main = <p>{"one"}</p>`);
  const out = path.join(dir, "out");
  const w = startWatch(["watch", file, "--out", out, "--debounce", "50", "--color", "never"]);
  try {
    await w.waitFor(/Watching .* for changes/);
    assert.match(fs.readFileSync(path.join(out, "app.js"), "utf8"), /"one"/);

    write(dir, "main.flow", `main :: Html
main = <p>{1 + "x"}</p>`);
    await w.waitFor(/error\[E_TYPE\].*right operand of '\+'/);
    await w.waitFor(/waiting for changes\.\.\./);

    write(dir, "main.flow", `main :: Html
main = <p>{"two"}</p>`);
    await w.waitFor(/Finished check in [\d.]+s \(no cuts\)\s*\n[\s\S]*Finished check/);
    assert.match(fs.readFileSync(path.join(out, "app.js"), "utf8"), /"two"/);
  } finally {
    await stopWatch(w);
  }
});

test("cli: watch --run restarts the server and serves the new bundle", { timeout: 30000 }, async () => {
  const dir = tmp("flow-cli-watchrun-");
  const file = write(dir, "main.flow", `main :: Html
main = <p>{"alpha"}</p>`);
  const out = path.join(dir, "out");
  const w = startWatch(["watch", file, "--run", "--port", "0", "--out", out, "--debounce", "50", "--color", "never"]);
  try {
    await w.waitFor(/Running http:\/\/localhost:\d+/);
    write(dir, "main.flow", `main :: Html
main = <p>{"beta"}</p>`);
    await w.waitFor(/Running http:\/\/localhost:\d+[\s\S]*Running http:\/\/localhost:\d+/);
    assert.match(fs.readFileSync(path.join(out, "app.js"), "utf8"), /"beta"/);
  } finally {
    await stopWatch(w);
  }
});

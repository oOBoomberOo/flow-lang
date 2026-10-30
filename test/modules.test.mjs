import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileFile } from "../src/compile.ts";
import { install, verifyLock, satisfies, bestVersion, add } from "../src/pkg.ts";
import { FlowError } from "../src/lexer.ts";

/** Build a throwaway package with the given files. */
function packageWith(files, deps = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-pkg-"));
  fs.writeFileSync(path.join(root, "flow.json"), JSON.stringify({ name: "testpkg", version: "0.1.0", dependencies: deps }, null, 2));
  for (const [rel, src] of Object.entries(files)) {
    const file = path.join(root, "src", rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, src);
  }
  return { root, entry: path.join(root, "src", "main.flow") };
}

const page = (body) => `fn main() -> Html { html { ${body} } }`;

/* ------------------------------------------------------------------ */
/* modules                                                            */
/* ------------------------------------------------------------------ */

test("modules: import a value and a type from another module", () => {
  const { entry } = packageWith({
    "main.flow": `use testpkg::util::{Priority, rank, label}
fn main() -> Html {
  let p = Priority(2);
  html { <p>{label(p)}{str(rank(p))}</p> }
}`,
    "util.flow": `pub type Priority = Priority(Int)
pub fn rank(p: Priority) -> Int { match p { Priority(n) => n } }
pub fn label(p: Priority) -> Str { "p" + str(rank(p)) }`,
  });
  const r = compileFile(entry);
  assert.match(r.client, /function rank|function label/);
});

test("modules: private declarations cannot be imported", () => {
  const { entry } = packageWith({
    "main.flow": `use testpkg::util::hidden\nfn main() -> Html { html { <p>{str(hidden())}</p> } }`,
    "util.flow": `fn hidden() -> Int { 1 }`,
  });
  assert.throws(() => compileFile(entry), /private in testpkg::util/);
});

test("modules: a missing module is reported with the expected path", () => {
  const { entry } = packageWith({
    "main.flow": `use testpkg::nope::x\nfn main() -> Html { html { <p>{"x"}</p> } }`,
  });
  assert.throws(() => compileFile(entry), /not found/);
});

test("modules: a missing export is reported", () => {
  const { entry } = packageWith({
    "main.flow": `use testpkg::util::nope\nfn main() -> Html { html { <p>{"x"}</p> } }`,
    "util.flow": `pub fn yes() -> Int { 1 }`,
  });
  assert.throws(() => compileFile(entry), /'nope' is not exported by testpkg::util/);
});

test("modules: duplicate names across modules are made unique, not shadowed", () => {
  const { entry } = packageWith({
    "main.flow": `use testpkg::a::twice
use testpkg::b::thrice
use testpkg::a::twice as again
fn main() -> Html {
  html { <p>{str(twice(2))}{str(thrice(2))}{str(again(3))}</p> }
}`,
    "a.flow": `pub fn twice(n: Int) -> Int { n * 2 }`,
    "b.flow": `pub fn thrice(n: Int) -> Int { n * 3 }`,
  });
  const r = compileFile(entry);
  // both stay callable; emitted names exist
  assert.match(r.client, /twice/);
  assert.match(r.client, /thrice/);
});

test("modules: aliasing avoids a clash", () => {
  const { entry } = packageWith({
    "main.flow": `use testpkg::a::f
use testpkg::b::f as g
fn main() -> Html { html { <p>{str(f(1) + g(1))}</p> } }`,
    "a.flow": `pub fn f(n: Int) -> Int { n }`,
    "b.flow": `pub fn f(n: Int) -> Int { n + 10 }`,
  });
  const r = compileFile(entry);
  assert.match(r.client, /function f\$|function f\(/);
});

test("modules: duplicate import alias is rejected", () => {
  const { entry } = packageWith({
    "main.flow": `use testpkg::a::f
use testpkg::b::f
fn main() -> Html { html { <p>{str(f(1))}</p> } }`,
    "a.flow": `pub fn f(n: Int) -> Int { n }`,
    "b.flow": `pub fn f(n: Int) -> Int { n }`,
  });
  assert.throws(() => compileFile(entry), /duplicate import 'f'/);
});

test("modules: nested module paths", () => {
  const { entry } = packageWith({
    "main.flow": `use testpkg::deep::nest::value\nfn main() -> Html { html { <p>{str(value())}</p> } }`,
    "deep/nest.flow": `pub fn value() -> Int { 42 }`,
  });
  assert.doesNotThrow(() => compileFile(entry));
});

/* ------------------------------------------------------------------ */
/* stdlib                                                             */
/* ------------------------------------------------------------------ */

test("stdlib: list, math, option and string modules", () => {
  const { entry } = packageWith({
    "main.flow": `use std::list::{map, filter, range, fold}
use std::math::{sum, clamp}
use std::option::{withDefault, isSome}
use std::string::{padLeft, capitalize}
fn main() -> Html {
  let xs = map(range(5), fn(n: Int) -> Int { n * n });
  let evens = filter(xs, fn(n: Int) -> Bool { n % 2 == 0 });
  let total = fold(evens, 0, fn(a: Int, b: Int) -> Int { a + b });
  html {
    <p>{str(total)}{str(sum(xs))}{str(clamp(9, 0, 5))}</p>
    <p>{str(isSome(head(xs)))}{str(withDefault(head([]), 0))}</p>
    <p>{padLeft(str(total), 4, "0")}{capitalize("flow")}</p>
  }
}`,
  });
  const r = compileFile(entry);
  assert.ok(r.client.includes("R.builtin"), "uses prelude builtins");
});

test("stdlib: html components are usable", () => {
  const { entry } = packageWith({
    "main.flow": `use std::html::{Card, Badge}
fn main() -> Html {
  html { <Card title={"t"}><Badge label={"b"} /></Card> }
}`,
  });
  const r = compileFile(entry);
  assert.match(r.client, /card-title/);
});

/* ------------------------------------------------------------------ */
/* packages                                                           */
/* ------------------------------------------------------------------ */

test("semver: ranges", () => {
  assert.ok(satisfies("1.2.3", "^1.0.0"));
  assert.ok(satisfies("1.9.9", "^1.0.0"));
  assert.ok(!satisfies("2.0.0", "^1.0.0"));
  assert.ok(satisfies("1.2.9", "~1.2.3"));
  assert.ok(!satisfies("1.3.0", "~1.2.3"));
  assert.ok(satisfies("1.2.3", "1.2.3"));
  assert.ok(!satisfies("1.2.4", "1.2.3"));
  assert.ok(satisfies("4.5.6", "*"));
  assert.equal(bestVersion(["1.0.0", "1.2.0"], "^1.0.0"), "1.2.0");
  assert.equal(bestVersion(["1.0.0", "1.2.0"], "~1.0.0"), "1.0.0");
});

test("packages: install vendors dependencies and writes a lockfile", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-install-"));
  fs.writeFileSync(path.join(dir, "flow.json"), JSON.stringify({
    name: "consumer", version: "0.1.0",
    dependencies: { "flow-charts": "^1.0.0", "flow-time": "^1.2.0" },
  }, null, 2));

  const report = install(dir);
  assert.deepEqual(report.installed.map((p) => `${p.name}@${p.version}`).sort(), ["flow-charts@1.0.0", "flow-time@1.2.0"]);
  assert.ok(fs.existsSync(path.join(dir, "flow_modules", "flow-charts", "src", "bar.flow")));

  const lock = JSON.parse(fs.readFileSync(path.join(dir, "flow.lock"), "utf8"));
  assert.equal(lock.lockfileVersion, 1);
  assert.match(lock.packages["flow-charts"].integrity, /^sha256-[0-9a-f]{64}$/);
  assert.deepEqual(verifyLock(dir), []);
});

test("packages: integrity detects a tampered dependency", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-tamper-"));
  fs.writeFileSync(path.join(dir, "flow.json"), JSON.stringify({
    name: "consumer", version: "0.1.0", dependencies: { "flow-time": "^1.2.0" },
  }, null, 2));
  install(dir);
  fs.appendFileSync(path.join(dir, "flow_modules", "flow-time", "src", "format.flow"), "\n// tampered\n");
  const problems = verifyLock(dir);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /integrity mismatch/);
});

test("packages: a registry dependency used by a program", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-use-"));
  fs.writeFileSync(path.join(dir, "flow.json"), JSON.stringify({
    name: "consumer", version: "0.1.0", dependencies: { "flow-charts": "^1.0.0", "flow-time": "^1.2.0" },
  }, null, 2));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "main.flow"), `use flow-charts::bar::Bar
use flow-time::format::hms
fn main() -> Html { html { <div><Bar label={"a"} value={2} max={4} /><p>{hms(61000)}</p></div> } }
`);
  install(dir);
  const r = compileFile(path.join(dir, "src", "main.flow"));
  assert.match(r.client, /bar-fill/);
});

test("packages: missing dependency produces an actionable error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-missing-"));
  fs.writeFileSync(path.join(dir, "flow.json"), JSON.stringify({
    name: "consumer", version: "0.1.0", dependencies: { "flow-charts": "^1.0.0" },
  }, null, 2));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "main.flow"), `fn main() -> Html { html { <p>{"x"}</p> } }`);
  assert.throws(() => compileFile(path.join(dir, "src", "main.flow")), /flow install/);
});

test("packages: add resolves the best version and updates the manifest", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-add-"));
  fs.writeFileSync(path.join(dir, "flow.json"), JSON.stringify({ name: "consumer", version: "0.1.0", dependencies: {} }, null, 2));
  const { name, version } = add(dir, "flow-time");
  assert.equal(name, "flow-time");
  assert.equal(version, "1.2.0");
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "flow.json"), "utf8"));
  assert.equal(manifest.dependencies["flow-time"], "^1.2.0");
});

test("packages: manifest validation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-bad-"));
  fs.writeFileSync(path.join(dir, "flow.json"), JSON.stringify({ name: "Bad Name", version: "x" }));
  assert.throws(() => install(dir), FlowError);
});

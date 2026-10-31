import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileFile } from "../src/compile.ts";
import { install, verifyLock, satisfies, bestVersion, add } from "../src/pkg.ts";
import { FlowError } from "../src/lexer.ts";

// The package tests use the registry that ships with this repo, not the network.
process.env.FLOW_REGISTRY = path.join(import.meta.dirname, "..", "registry");

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
    "main.flow": `import Util (Priority, rank, label)

main :: Html
main = do
  let p = Priority 2
  <p>{label p} {str (rank p)}</p>`,
    "util.flow": `data Priority = Priority Int

rank :: Priority -> Int
rank p = case p of
  Priority n -> n

label :: Priority -> Str
label p = "p" + str (rank p)`,
  });
  const r = compileFile(entry);
  assert.match(r.client, /function rank|function label/);
});

test("modules: private declarations cannot be imported", () => {
  const { entry } = packageWith({
    "main.flow": `import Util (hidden)

main :: Html
main = <p>{str (hidden ())}</p>`,
    "util.flow": `module Util (shown) where

shown :: () -> Int
shown () = 2

hidden :: () -> Int
hidden () = 1`,
  });
  assert.throws(() => compileFile(entry), /'hidden' is private in module Util/);
});

test("modules: a missing module is reported with the expected path", () => {
  const { entry } = packageWith({
    "main.flow": `import Nope (x)

main :: Html
main = <p>{"x"}</p>`,
  });
  assert.throws(() => compileFile(entry), /not found/);
});

test("modules: a missing export is reported", () => {
  const { entry } = packageWith({
    "main.flow": `import Util (nope)

main :: Html
main = <p>{"x"}</p>`,
    "util.flow": `yes :: () -> Int
yes () = 1`,
  });
  assert.throws(() => compileFile(entry), /'nope' is not exported by module Util/);
});

test("modules: duplicate names across modules are made unique, not shadowed", () => {
  const { entry } = packageWith({
    "main.flow": `import A (twice)
import B (thrice)
import A (twice as again)

main :: Html
main = <p>{str (twice 2)} {str (thrice 2)} {str (again 3)}</p>`,
    "a.flow": `twice :: Int -> Int
twice n = n * 2`,
    "b.flow": `thrice :: Int -> Int
thrice n = n * 3`,
  });
  const r = compileFile(entry);
  // both stay callable; emitted names exist
  assert.match(r.client, /twice/);
  assert.match(r.client, /thrice/);
});

test("modules: aliasing avoids a clash", () => {
  const { entry } = packageWith({
    "main.flow": `import A (f)
import B (f as g)

main :: Html
main = <p>{str (f 1 + g 1)}</p>`,
    "a.flow": `f :: Int -> Int
f n = n`,
    "b.flow": `f :: Int -> Int
f n = n + 10`,
  });
  const r = compileFile(entry);
  assert.match(r.client, /function f\$|function f\(/);
});

test("modules: duplicate import alias is rejected", () => {
  const { entry } = packageWith({
    "main.flow": `import A (f)
import B (f)

main :: Html
main = <p>{str (f 1)}</p>`,
    "a.flow": `f :: Int -> Int
f n = n`,
    "b.flow": `f :: Int -> Int
f n = n`,
  });
  assert.throws(() => compileFile(entry), /duplicate import 'f'/);
});

test("modules: nested module paths", () => {
  const { entry } = packageWith({
    "main.flow": `import Deep.Nest (value)

main :: Html
main = <p>{str (value ())}</p>`,
    "deep/nest.flow": `value :: () -> Int
value () = 42`,
  });
  assert.doesNotThrow(() => compileFile(entry));
});

/* ------------------------------------------------------------------ */
/* stdlib                                                             */
/* ------------------------------------------------------------------ */

test("stdlib: list, math, option and string modules", () => {
  const { entry } = packageWith({
    "main.flow": `import List (map, filter, range, fold)
import Math (sum, clamp)
import Option (withDefault, isSome)
import String (padLeft, capitalize)

main :: Html
main = do
  let xs = map (range 5) (\\(n :: Int) -> n * n)
  let evens = filter xs (\\(n :: Int) -> n % 2 == 0)
  let total = fold evens 0 (\\(a :: Int) (b :: Int) -> a + b)
  <>
    <p>{str total} {str (sum xs)} {str (clamp 9 0 5)}</p>
    <p>{str (isSome (head xs))} {str (withDefault (head []) 0)}</p>
    <p>{padLeft (str total) 4 "0"} {capitalize "flow"}</p>
  </>`,
  });
  const r = compileFile(entry);
  // the intrinsics are std code now: they reach the host through the FFI
  assert.ok(r.client.includes("R.ffiCall"), "stdlib intrinsics go through the FFI");
  assert.ok(!r.client.includes("R.builtin("), "no compiler-injected primitives");
});

test("stdlib: html components are usable", () => {
  const { entry } = packageWith({
    "main.flow": `import Html (Card, Badge)

main :: Html
main =
  <Card title={"t"}>
    <Badge label={"b"} />
  </Card>`,
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
  fs.writeFileSync(path.join(dir, "src", "main.flow"), `import FlowCharts.Bar (Bar)
import FlowTime.Format (hms)

main :: Html
main =
  <div>
    <Bar label={"a"} value={2} max={4} />
    <p>{hms 61000}</p>
  </div>
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
  fs.writeFileSync(path.join(dir, "src", "main.flow"), `main :: Html
main = <p>{"x"}</p>`);
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

test("ffi: a std wrapper follows the placement of its call site", () => {
  const { entry } = packageWith({
    "main.flow": `import Log (info)

stamp :: () -> Int
stamp () = do
  info "stamping on the server"
  Server.now ()

main :: Html
main = <p>{"t = "} {str (stamp ())}</p>
`,
  });
  const r = compileFile(entry);
  // `stamp` is server-placed, so the neutral `info` (and its console.log FFI)
  // is emitted into the server bundle and reached through a cut.
  assert.match(r.server, /R\.ffiCall\("console\.log"/);
  assert.equal(r.diagnostics.filter((d) => /server-side/.test(d)).length, 1);
});

test("ffi: equality is a std-level FFI primitive", () => {
  const { entry } = packageWith({
    "main.flow": `main :: Html
main = <p>{str (1 == 1)} {str ([1] == [1])}</p>
`,
  });
  const r = compileFile(entry);
  assert.match(r.client, /R\.ffiCall\("__flow\.eq"/);
  assert.ok(!r.client.includes("R.eq("), "the compiler no longer emits R.eq");
});

test("stdlib: list sorting and search go through the FFI", () => {
  const { entry } = packageWith({
    "main.flow": `import List (sortInts, sortStrings, contains, indexOfItem, sortBy)

main :: Html
main = do
  let ints = sortInts [3, 1, 2]
  let strs = sortStrings ["pear", "apple", "fig"]
  let idx = indexOfItem ints 2
  <ul>
    <li>{str ints} {":"} {str (indexOfItem ints 99)} {":"} {str (contains ints 2)}</li>
    <li>{str strs} {":"} {str idx}</li>
    <li>{str (sortBy ints (\\(a :: Int) (b :: Int) -> b - a))}</li>
  </ul>
`,
  });
  const r = compileFile(entry);
  assert.ok(r.client.includes('R.ffiCall("@sort"'), "sorting reaches the host through the FFI");
  assert.deepEqual(r.diagnostics, []);
});

test("ffi: user code can declare and call raw JavaScript directly", () => {
  const { entry } = packageWith({
    "main.flow": `foreign import js unsafe "Math.hypot" hypot :: Float -> Float -> Float

foreign import js unsafe "@toUpperCase" shout :: Str -> Str

main :: Html
main = <p>{str (hypot 3.0 4.0)} {shout "ok"}</p>
`,
  });
  const r = compileFile(entry);
  assert.match(r.client, /R\.ffiCall\("Math\.hypot"/);
  assert.match(r.client, /R\.ffiCall\("@toUpperCase"/);
  assert.deepEqual(r.diagnostics, []);
});

test("ffi: Int division lowers through the host primitive", () => {
  const { entry } = packageWith({
    "main.flow": `main :: Html
main = <p>{str (7 / 2)}</p>
`,
  });
  const r = compileFile(entry);
  assert.match(r.client, /R\.ffiCall\("__flow\.divInt"/);
  assert.ok(!r.client.includes("Math.trunc"), "no direct library call");
});

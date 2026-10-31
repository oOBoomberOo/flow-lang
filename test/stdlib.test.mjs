import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileSource } from "../src/compile.ts";
import { createHost } from "../src/host.ts";

/**
 * The standard library as a program actually uses it: a route computes values
 * with Dict, Set, Tuple, Result, Iter and String and returns them as text.
 */

const RUNTIME_FILES = ["core.js", "server.js", "dom.js", "client.js"];

function emit(result, outDir) {
  const rt = path.join(import.meta.dirname, "..", "src", "runtime");
  fs.mkdirSync(path.join(outDir, "runtime"), { recursive: true });
  fs.writeFileSync(path.join(outDir, "app.js"), result.client);
  fs.writeFileSync(path.join(outDir, "server.js"), result.server);
  for (const f of RUNTIME_FILES) fs.copyFileSync(path.join(rt, f), path.join(outDir, "runtime", f));
  fs.writeFileSync(
    path.join(outDir, "runtime", "server-runtime.js"),
    `import { createServerRuntime } from "./server.js";\n` +
    `const opts = JSON.parse(process.env.FLOW_OPTS || "{}");\n` +
    `export const R = createServerRuntime(opts);\n`,
  );
}

async function withRoute(routeBody, fn) {
  const source = `import Dict
import Set
import Tuple
import Result
import Iter
import String (padRight, splitOnce, isDigit)
import Http (get, Router, textResponse)

routes :: () -> ()
routes () =
  Router.mount [ get "/t" (\\_req -> textResponse (report ())) ]

report :: () -> Str
report () = ${routeBody}

main :: Html
main = <p>{"stdlib"}</p>
`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-stdlib-"));
  const result = compileSource(source, path.join(dir, "main.flow"));
  const outDir = path.join(dir, "build");
  emit(result, outDir);
  const host = await createHost({ outDir, port: 0, secrets: {} });
  try {
    const res = await fetch(host.url + "/t");
    assert.equal(res.status, 200);
    return await fn(await res.text());
  } finally {
    await host.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("dict: insert, lookup, keys, delete and union are ordered", async () => {
  await withRoute(`do
  let empty = Dict.stringDict []
  let d = Dict.stringInsert "b" 2 (Dict.stringInsert "a" 1 (Dict.stringInsert "c" 3 empty))
  let d2 = Dict.stringRemove "b" d
  let d3 = Dict.union Dict.stringCompare d (Dict.stringDict [("d", 4)])
  str (Dict.stringLookup "a" d) + "|" + str (Dict.keys d) + "|" + str (Dict.keys d2) +
    "|" + str (Dict.size d3) + "|" + str (Dict.member Dict.stringCompare "z" d)`, (text) => {
    assert.equal(text, "Some(1)|[a, b, c]|[a, c]|4|False");
  });
});

test("set: union, intersect and difference follow comparison order", async () => {
  await withRoute(`do
  let a = Set.intSet [1, 2, 3]
  let b = Set.intSet [3, 4]
  str (Set.toList (Set.union Set.intCompare a b)) + "|" +
    str (Set.toList (Set.intersect Set.intCompare a b)) + "|" +
    str (Set.toList (Set.difference Set.intCompare a b)) + "|" +
    str (Set.member Set.intCompare 2 a)`, (text) => {
    assert.equal(text, "[1, 2, 3, 4]|[3]|[1, 2]|True");
  });
});

test("tuple: fst, snd, swap, curry and zip3", async () => {
  await withRoute(`do
  let pair = (1, "x")
  let add = Tuple.curry (\\p -> Tuple.fst p + Tuple.snd p)
  str (Tuple.fst pair) + "|" + str (Tuple.snd pair) + "|" + str (Tuple.swap pair) +
    "|" + str (add 2 3) + "|" + str (Tuple.zip3 [1] [2] [3])`, (text) => {
    assert.equal(text, '1|x|[x, 1]|5|[[1, 2, 3]]');
  });
});

test("result: Ok/Err survive with map, andThen, withDefault and all", async () => {
  await withRoute(`do
  let ok = Result.mapOk (\\x -> x + 1) (Ok 2)
  let bad = Result.andThen (\\x -> if x > 0 then Ok x else Err "neg") (Ok 5)
  let neg = Result.andThen (\\x -> if x > 0 then Ok x else Err "neg") (Ok (0 - 1))
  let list = Result.all [Ok 1, Ok 2]
  str ok + "|" + str bad + "|" + str (Result.withDefault 0 neg) +
    "|" + str list + "|" + str (Result.toOption bad)`, (text) => {
    assert.equal(text, "Ok(3)|Ok(5)|0|Ok([1, 2])|Some(5)");
  });
});

test("iter: enumerate, partition, chunks, groupBy, average and scanl", async () => {
  await withRoute(`do
  let parts = Iter.partition (\\x -> x % 2 == 0) [1, 2, 3, 4]
  str (Iter.enumerate ["a", "b"]) + "|" +
    str parts + "|" +
    str (Iter.chunks 2 [1, 2, 3]) + "|" +
    str (Iter.groupBy (\\a b -> a == b) [1, 1, 2]) + "|" +
    str (Iter.average [1, 2, 3]) + "|" +
    str (Iter.scanl (\\acc x -> acc + x) 0 [1, 2, 3]) + "|" +
    str (Iter.zipWith (\\a b -> a * b) [1, 2] [3, 4])`, (text) => {
    assert.equal(text, '[[0, a], [1, b]]|[[4, 2], [3, 1]]|[[1, 2], [3]]|[[1, 1], [2]]|Some(2)|[0, 1, 3, 6]|[3, 8]');
  });
});

test("string: padRight, endsWith, indexOf, splitOnce and character tests", async () => {
  await withRoute(`do
  str (padRight "a" 4 ".") + "|" +
    str (String.endsWith "hello" "lo") + "|" +
    str (String.indexOf "abc" "c") + "|" +
    str (splitOnce "a=b" "=") + "|" +
    str (isDigit "7") + "|" +
    str (String.isDigit "x") + "|" +
    str (String.toUpper "hi")`, (text) => {
    assert.equal(text, 'a...|True|2|Some([a, b])|True|False|HI');
  });
});

test("math: toFloat, isEven, powInt and roundTo", async () => {
  await withRoute(`do
  str (Math.toFloat 3 / Math.toFloat 2) + "|" +
    str (Math.isEven 4) + "|" +
    str (Math.powInt 2 10) + "|" +
    str (Math.roundTo 3.14159 2) + "|" +
    str (Math.clamp 10 0 5)`, (text) => {
    assert.equal(text, "1.5|True|1024|3.14|5");
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileFile } from "../src/compile.ts";
import { createHost } from "../src/host.ts";
import { withModule, moduleNameFor } from "./helpers.mjs";

/**
 * Reflection and the JSON serialization standard.
 *
 * Reflection metadata is produced by the compiler from the static type
 * (`Reflect.meta value`); Flow.Serialize walks that metadata and the runtime
 * representation. Server mains write their results to a file so the test can
 * assert on real encoded data and error paths without a browser.
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

function packageWith(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-reflect-"));
  fs.writeFileSync(path.join(root, "flow.json"), JSON.stringify({ name: "reflectapp", version: "0.1.0", dependencies: {} }));
  for (const [rel, src] of Object.entries(files)) {
    const f = path.join(root, "src", rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, withModule(src, moduleNameFor(rel)));
  }
  return path.join(root, "src", "main.flow");
}

/** Write `source` as a package, run its server main, return the result file. */
async function runServer(source) {
  const out = path.join(os.tmpdir(), `flow-reflect-out-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const entry = packageWith({ "main.flow": source.replaceAll("$OUT", JSON.stringify(out)) });
  const result = compileFile(entry);
  const outDir = path.join(path.dirname(entry), "..", ".flow-build");
  emit(result, outDir);
  const host = await createHost({ outDir, port: 0, secrets: {} });
  await host.close();
  return fs.readFileSync(out, "utf8");
}

const USER = `
data Role = Admin | Member Str | Team Str Int

type User =
  { name :: Str
  , age :: Int
  , role :: Role
  , tags :: List Str
  , pair :: (Int, Str)
  , maybe :: Option Int
  }

user :: User
user =
  { name = "Ada"
  , age = 36
  , role = Member "gold"
  , tags = ["a", "b"]
  , pair = (1, "x")
  , maybe = Some 3
  }
`;

test("reflect: metadata describes records, sums and nested types", async () => {
  const text = await runServer(`import Reflect
import Fs (writeText)

${USER}

main :: ()
main = do
  let info = Reflect.meta user
  writeText $OUT (Reflect.describeAll info)
`);
  assert.match(text, /root: \{ name :: Str, age :: Int, role :: Role, tags :: List Str, pair :: \(Int, Str\), maybe :: Option Int \}/);
  assert.match(text, /Role = Admin \| Member Str \| Team Str Int/);
  assert.match(text, /Option Int = None \| Some Int/);
});

test("serialize: round trip through JSON for records, sums, lists, tuples and options", async () => {
  const text = await runServer(`import Reflect
import Serialize
import Result
import Fs (writeText)

${USER}

main :: ()
main = do
  let info = Reflect.meta user
  let encoded = Result.withDefault "ENCODE ERROR" (Serialize.encode user)
  let decoded :: Result User Str = Serialize.decode encoded
  let again = case decoded of
        Err why -> "DECODE ERROR: " + why
        Ok value -> Result.withDefault "RE-ENCODE ERROR" (Serialize.encode value)
  writeText $OUT (Reflect.describeAll info + "\\n---\\n" + encoded + "\\n---\\n" + again)
`);
  const [metadata, encoded, again] = text.split("\n---\n");
  assert.match(metadata, /root: /);
  assert.equal(encoded, '{"name":"Ada","age":36,"role":{"Member":"gold"},"tags":["a","b"],"pair":[1,"x"],"maybe":{"Some":3}}');
  assert.equal(again, encoded, "decoding and re-encoding is stable");
});

test("serialize: primitives, unit and lists", async () => {
  const text = await runServer(`import Serialize
import Result
import Fs (writeText)

main :: ()
main = do
  let intJson = Result.withDefault "ERR" (Serialize.encode (1 :: Int))
  let floatJson = Result.withDefault "ERR" (Serialize.encode (1.5 :: Float))
  let boolJson = Result.withDefault "ERR" (Serialize.encode (True :: Bool))
  let strJson = Result.withDefault "ERR" (Serialize.encode ("a\\nb" :: Str))
  let unitJson = Result.withDefault "ERR" (Serialize.encode (()))
  let listJson = Result.withDefault "ERR" (Serialize.encode ([1, 2] :: List Int))
  let intBack :: Result Int Str = Serialize.decode intJson
  let strBack :: Result Str Str = Serialize.decode strJson
  let listBack :: Result (List Int) Str = Serialize.decode listJson
  let showInt = case intBack of
        Ok value -> str value
        Err why -> why
  let showStr = case strBack of
        Ok value -> value
        Err why -> why
  let showList = case listBack of
        Ok value -> Result.withDefault "ERR" (Serialize.encode value)
        Err why -> why
  writeText $OUT (intJson + "\\n" + floatJson + "\\n" + boolJson + "\\n" + strJson + "\\n" + unitJson + "\\n" + listJson + "\\n" + showInt + "\\n" + showStr + "\\n" + showList)
`);
  const lines = text.split("\n");
  assert.deepEqual(lines.slice(0, 6), ["1", "1.5", "true", '"a\\nb"', "null", "[1,2]"]);
  assert.equal(lines[6], "1");
  assert.equal(lines[7], "a");
  assert.equal(lines[8], "b");
  assert.equal(lines[9], "[1,2]");
});

test("serialize: nested options are unambiguous", async () => {
  const text = await runServer(`import Serialize
import Result
import Fs (writeText)

main :: ()
main = do
  let encoded = Result.withDefault "ERR" (Serialize.encode (Some (None :: Option Int)))
  let decoded :: Result (Option (Option Int)) Str = Serialize.decode encoded
  let again = case decoded of
        Err why -> "DECODE ERROR: " + why
        Ok value -> Result.withDefault "RE-ENCODE ERROR" (Serialize.encode value)
  writeText $OUT (encoded + "\\n" + again)
`);
  const [encoded, again] = text.split("\n");
  assert.equal(encoded, '{"Some":{"None":null}}');
  assert.equal(again, encoded);
});

test("serialize: explicit Reflected metadata is the same standard", async () => {
  const text = await runServer(`import Reflect
import Serialize
import Result
import Json (Json(..))
import Fs (writeText)

${USER}

main :: ()
main = do
  let info = Reflect.meta user
  let encoded = Result.withDefault "ENCODE ERROR" (Serialize.encodeWith info user)
  let json = Result.withDefault JNull (Serialize.toJsonWith info user)
  let decoded :: Result User Str = Serialize.fromJsonWith info json
  let autoJson :: Result User Str = Serialize.fromJson json
  let again = case decoded of
        Err why -> "DECODE ERROR: " + why
        Ok value -> case autoJson of
          Err why -> "AUTO DECODE ERROR: " + why
          Ok auto -> Result.withDefault "RE-ENCODE ERROR" (Serialize.encodeWith info auto)
  writeText $OUT (encoded + "\\n" + again)
`);
  const [encoded, again] = text.split("\n");
  assert.match(encoded, /"name":"Ada"/);
  assert.equal(again, encoded);
});

test("serialize: decode errors name the field and what was expected", async () => {
  const text = await runServer(`import Serialize
import Result
import Fs (writeText)

${USER}

showError :: Result User Str -> Str
showError result = case result of
  Ok _ -> "unexpected OK"
  Err why -> why

full :: Str -> Str
full role =
  "{\\"name\\":\\"Ada\\",\\"age\\":36,\\"role\\":" + role +
  ",\\"tags\\":[],\\"pair\\":[1,\\"x\\"],\\"maybe\\":{\\"None\\":null}}"

main :: ()
main = do
  writeText $OUT (showError (Serialize.decode "{}") + "\\n" +
    showError (Serialize.decode "{\\"name\\":1}") + "\\n" +
    showError (Serialize.decode (full "{\\"Boss\\":1}")) + "\\n" +
    showError (Serialize.decode (full "{\\"Team\\":[1]}")) + "\\n" +
    showError (Serialize.decode "{\\"name\\":\\"Ada\\",\\"age\\":1.5}") + "\\n" +
    showError (Serialize.decode "{\\"name\\":\\"Ada\\",\\"age\\":36,\\"role\\":{\\"Admin\\":null},\\"tags\\":\\"x\\",\\"pair\\":[1,\\"x\\"],\\"maybe\\":{\\"None\\":null}}") + "\\n" +
    showError (Serialize.decode "{\\"name\\":\\"Ada\\",\\"age\\":36,\\"role\\":{\\"Admin\\":null},\\"tags\\":[],\\"pair\\":[1],\\"maybe\\":{\\"None\\":null}}"))
`);
  const lines = text.split("\n");
  assert.equal(lines[0], "name: missing field");
  assert.equal(lines[1], "name: expected a string");
  assert.match(lines[2], /role: unknown constructor 'Boss' for Role/);
  assert.match(lines[3], /role\.Team: constructor Team expects 2 value\(s\)/);
  assert.equal(lines[4], "age: expected an integer, got 1.5");
  assert.equal(lines[5], "tags: expected an array");
  assert.equal(lines[6], "pair: expected 2 tuple value(s), got 1");
});

test("reflect: recursive data types use references and round trip", async () => {
  const text = await runServer(`import Reflect
import Serialize
import Result
import Fs (writeText)

data Tree = Leaf Int | Node Tree Tree

tree :: Tree
tree = Node (Leaf 1) (Leaf 2)

main :: ()
main = do
  let info = Reflect.meta tree
  let encoded = Result.withDefault "ENCODE ERROR" (Serialize.encode tree)
  let decoded :: Result Tree Str = Serialize.decode encoded
  let again = case decoded of
        Err why -> "DECODE ERROR: " + why
        Ok value -> Result.withDefault "RE-ENCODE ERROR" (Serialize.encode value)
  writeText $OUT (Reflect.describeAll info + "\\n---\\n" + encoded + "\\n---\\n" + again)
`);
  const [metadata, encoded, again] = text.split("\n---\n");
  assert.match(metadata, /root: Tree/);
  assert.match(metadata, /Tree = Leaf Int \| Node Tree Tree/);
  assert.equal(encoded, '{"Node":[{"Leaf":1},{"Leaf":2}]}');
  assert.equal(again, encoded);
});

test("serialize: Dict and Set aliases use their list representation", async () => {
  const text = await runServer(`import Serialize
import Dict
import Result
import Fs (writeText)

scores :: Dict Str Int
scores = Dict.stringDict [("ada", 36), ("grace", 85)]

main :: ()
main = do
  let encoded = Result.withDefault "ENCODE ERROR" (Serialize.encode scores)
  let decoded :: Result (Dict Str Int) Str = Serialize.decode encoded
  let again = case decoded of
        Err why -> "DECODE ERROR: " + why
        Ok value -> Result.withDefault "RE-ENCODE ERROR" (Serialize.encode value)
  writeText $OUT (encoded + "\\n" + again)
`);
  const [encoded, again] = text.split("\n");
  assert.equal(encoded, '[["ada",36],["grace",85]]');
  assert.equal(again, encoded);
});

test("serialize: auto mode rejects unsupported static types", () => {
  const entry = packageWith({
    "main.flow": `import Serialize

main :: Html
main = do
  let text = Serialize.encode (\\x -> x + 1)
  <p>{"x"}</p>
`,
  });
  assert.throws(() => compileFile(entry), /functions are not data/);
});

test("serialize: explicit metadata reports an unsupported value at runtime", async () => {
  const text = await runServer(`import Reflect
import Serialize
import Result
import Fs (writeText)

main :: ()
main = do
  let info = Reflect.meta (\\x -> x + 1)
  let text = case Serialize.encodeWith info (\\x -> x + 1) of
        Ok _ -> "unexpected OK"
        Err why -> why
  writeText $OUT text
`);
  assert.match(text, /functions cannot be serialized/);
});

test("reflect: auto entry points need a concrete static type", () => {
  const polymorphic = packageWith({
    "main.flow": `import Reflect

main :: Html
main = <p>{Reflect.describe (Reflect.meta []).root}</p>
`,
  });
  assert.throws(() => compileFile(polymorphic), /cannot reflect/);

  const untypedDecode = packageWith({
    "main.flow": `import Serialize

main :: Html
main = do
  let decoded = Serialize.decode "1"
  <p>{"x"}</p>
`,
  });
  assert.throws(() => compileFile(untypedDecode), /cannot infer the target type of Serialize.decode/);

  const firstClass = packageWith({
    "main.flow": `import Serialize

main :: Html
main = do
  let encode = Serialize.encode
  <p>{"x"}</p>
`,
  });
  assert.throws(() => compileFile(firstClass), /cannot be used as a value/);

  const firstClassMeta = packageWith({
    "main.flow": `import Reflect

main :: Html
main = do
  let meta = Reflect.meta
  <p>{"x"}</p>
`,
  });
  assert.throws(() => compileFile(firstClassMeta), /cannot be used as a value/);
});

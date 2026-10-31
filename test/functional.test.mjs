import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileSource, compileFile } from "../src/compile.ts";
import { createHost } from "../src/host.ts";

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

function compileInTemp(src) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-fp-"));
  const file = path.join(dir, "main.flow");
  fs.writeFileSync(file, src);
  try {
    return compileFile(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function withHost(source, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-fp-host-"));
  const file = path.join(dir, "main.flow");
  fs.writeFileSync(file, source);
  const result = compileFile(file);
  const outDir = path.join(dir, "build");
  emit(result, outDir);
  const host = await createHost({ outDir, port: 0, secrets: {} });
  try {
    return await fn(host, result);
  } finally {
    await host.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("functional: partial application, chained calls and pipes run", async () => {
  const source = `import Fn (compose)
import Monad (Monad)
import List (map, filter, range)
import Http (get, Router, RequestObject, Response, textResponse)

add :: Int -> Int -> Int
add a b = a + b

mul :: Int -> Int -> Int
mul a b = a * b

routes :: () -> ()
routes () =
  Router.mount [ get "/fp" (\\(_req :: RequestObject) -> do
      let inc = add 1
      let local = \\(a :: Int) (b :: Int) -> a * b
      let double = local 2
      let xs = range 5
      let odds = filter (map xs inc) (\\x -> x % 2 == 1)
      let piped = mul (add 3 1) 2
      let composed = compose (\\x -> x + 1) (\\x -> x * 2)
      let dollar = add (1 + 2)
      let applied = add 5
      let opt = ((Some 2).map) (\\x -> x + 1)
      textResponse (str (inc 9) + "|" + str (double 4) + "|" + str odds + "|" + str piped + "|" + str (composed 3) + "|" + str (dollar 4) + "|" + str (applied 1) + "|" + str opt))
    ]

main :: Html
main = <p>{"fp"}</p>
`;
  await withHost(source, async (host) => {
    const res = await fetch(host.url + "/fp");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "10|8|[1, 3, 5]|8|7|7|6|Some(3)");
  });
});

test("functional: a right section fills the trailing parameters", async () => {
  const source = `import List (map)
import Option
import Http (get, Router, RequestObject, textResponse)

doubleAll :: List Int -> List Int
doubleAll = map (\\x -> x * 2)

incOption :: Option Int -> Option Int
incOption = Option.map (\\x -> x + 1)

addPair :: Option (Int, Int) -> Option Int
addPair = Option.map \\(a, b) -> a + b

routes :: () -> ()
routes () =
  Router.mount [ get "/rs" (\\(_req :: RequestObject) ->
    textResponse (str (doubleAll [1, 2, 3]) + "|" + str (incOption (Some 4)) + "|" +
      str (incOption None) + "|" + str (addPair (Some (2, 3))) + "|" +
      str ([1, 2, 3] |> map (\\x -> x + 10)))) ]

main :: Html
main = <p>{"rs"}</p>
`;
  await withHost(source, async (host) => {
    const res = await fetch(host.url + "/rs");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "[2, 4, 6]|Some(5)|None|Some(5)|[11, 12, 13]");
  });
});

test("functional: a record ADT projects its payload fields", async () => {
  const source = `import Http (get, Router, RequestObject, textResponse)

data Todo = Todo
  { id :: Int
  , title :: Str
  , completed :: Bool
  }

data Box a = Box { value :: a }

makeTodo :: Int -> Str -> Todo
makeTodo id title = Todo { id = id, title = title, completed = False }

isTodo :: Todo -> Int -> Bool
isTodo todo target = todo.id == target

unbox :: Box Int -> Int
unbox box = box.value

routes :: () -> ()
routes () =
  Router.mount [ get "/adt" (\\(_req :: RequestObject) ->
    textResponse (str (isTodo (makeTodo 7 "ship") 7) + "|" +
      str ((makeTodo 9 "later").title) + "|" +
      str (unbox (Box { value = 4 })))) ]

main :: Html
main = <p>{"adt"}</p>
`;
  await withHost(source, async (host) => {
    const res = await fetch(host.url + "/adt");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "True|later|4");
  });
});

test("functional: inferred lambda parameters work in every position", () => {
  const src = `import List (map, filter, range)

main :: Html
main = do
  let xs = range 5
  let a = map xs (\\x -> x + 1)
  let b = filter xs (\\x -> x % 2 == 0)
  let f = \\x -> x * 3
  let g = \\a b -> a + b
  <p>{str a} {str b} {str (f 2)} {str (g 1 2)}</p>`;
  const r = compileInTemp(src);
  assert.deepEqual(r.errors, []);
  assert.match(r.client, /R\.v\(x\) \* R\.v\(3\)/, "the expression-bodied lambda is emitted");
});

test("functional: over-application and invalid partials are rejected", () => {
  assert.throws(
    () => compileSource(`add :: Int -> Int -> Int
add a b = a + b

main :: Html
main = do
  let x = add 1 2 3
  <p>{str x}</p>`, "over.flow"),
    /attempt to call a value of type Int/,
  );
  assert.throws(
    () => compileInTemp(`import State (State)

f :: Int -> Int -> Int ! State
f a b = a + b

main :: Html
main = do
  let g = f 1
  <p>{str (g 2)}</p>`),
    /cannot partially apply 'f': it performs an algebraic effect/,
  );
  assert.throws(
    () => compileInTemp(`class S a where
  s :: a -> Str

instance S Int where
  s x = "i"

g :: S a => a -> Int -> Str
g x y = S.s x

main :: Html
main = do
  let f = g 1
  <p>{f 2}</p>`),
    /cannot partially apply 'g': it needs trait dictionaries/,
  );
  assert.throws(
    () => compileSource(`add :: Int -> Int -> Int
add a b = a + b

main :: Html
main = do
  let x = (add 1) "no"
  <p>{str x}</p>`, "wrong.flow"),
    /type mismatch: Str vs Int/,
  );
});

test("functional: partials keep types through let and pipe", () => {
  const r = compileSource(`add :: Int -> Int -> Int
add a b = a + b

main :: Html
main = do
  let inc = add 1
  let twice = \\(f :: Int -> Int) (x :: Int) -> f (f x)
  let n = twice inc 3
  let piped = add (add 3 1) 1
  <p>{str n} {str piped}</p>`, "types.flow");
  assert.deepEqual(r.errors, []);
  assert.ok(r.client.includes("...$r"), "a partial closure is emitted");
});

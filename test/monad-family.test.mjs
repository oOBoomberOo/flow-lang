import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileFile } from "../src/compile.ts";
import { createHost } from "../src/host.ts";

/**
 * The Functor / Applicative / Monad / Alternative family: one `map`, `pure`,
 * `return`, `bind` and `empty`; instances for List, Option and Cell; the
 * classes come from the prelude, so no import is needed.
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

async function withHost(source, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-monad-"));
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

const SOURCE = `import Http (get, Router, RequestObject, textResponse)
import Option
import Dict

data Todo = Todo { id :: Int }

twice :: (Monad f) => f Int -> f Int
twice value = bind (\\n -> pure (n * 2)) value

render :: Option (Todo, Int) -> Option Int
render value = map (\\(todo, n) -> todo.id + n) value

optionDo :: Option Int
optionDo = do
  a <- Some 1
  b <- Some 2
  return (a + b)

applied :: Option Int
applied = ap (Some (\\x -> x + 1)) (Some 4)

methodMap :: Option Int
methodMap = (Some 2).map (\\x -> x + 1)

emptyList :: List Int
emptyList = empty

emptyDict :: Dict.Dict Str Int
emptyDict = empty

routes :: () -> ()
routes () =
  Router.mount [ get "/monad" (\\(_req :: RequestObject) ->
    textResponse (str (twice (Some 3)) + "|" + str (twice [1, 2]) + "|" +
      str (render (Some (Todo { id = 10 }, 5))) + "|" +
      str ([1, 2] |> map (\\x -> x * 10)) + "|" +
      str (orElse None (Some 9)) + "|" + str optionDo + "|" +
      str applied + "|" + str methodMap + "|" + str emptyList + "|" + str emptyDict)) ]

main :: Html
main = <p>{"monad"}</p>
`;

test("monad family: map, pure, return, bind, empty and the instances", async () => {
  await withHost(SOURCE, async (host, result) => {
    assert.deepEqual(result.diagnostics, []);
    const res = await fetch(host.url + "/monad");
    assert.equal(res.status, 200);
    assert.equal(
      await res.text(),
      "Some(6)|[2, 4]|Some(15)|[10, 20]|Some(9)|Some(3)|Some(5)|Some(3)|[]|[]",
    );
  });
});

test("monad family: a bound function passes superclass dictionaries", async () => {
  await withHost(`import Http (get, Router, RequestObject, textResponse)

use :: (Monad f) => f Int -> f Int
use value = bind (\\n -> pure (n + 1)) value

main :: Html
main = <p>{"d"}</p>

routes :: () -> ()
routes () =
  Router.mount [ get "/d" (\\(_req :: RequestObject) ->
    textResponse (str (use (Some 1)) + "|" + str (use [1, 2]))) ]
`, async (host, result) => {
    const js = result.client + result.server;
    assert.match(js, /\$d_Monad_/, "the Monad dictionary is passed");
    assert.match(js, /\$d_Applicative_/, "its Applicative superclass dictionary is passed");
    assert.match(js, /\$d_Functor_/, "its Functor superclass dictionary is passed");
    const res = await fetch(host.url + "/d");
    assert.equal(await res.text(), "Some(2)|[2, 3]");
  });
});

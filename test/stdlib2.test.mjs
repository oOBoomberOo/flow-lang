import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileSource } from "../src/compile.ts";
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

async function withRoute(imports, body, fn) {
  const source = `${imports}
import Http (get, Router, textResponse)

routes :: () -> ()
routes () = Router.mount [ get "/t" (\\_req -> textResponse (report ())) ]

report :: () -> Str
report () = ${body}

main :: Html
main = <p>{"stdlib"}</p>
`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-stdlib2-"));
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

test("json: encode primitives, lists and objects", async () => {
  await withRoute("import Json (Json(..), encode)", `do
  let doc = Json.JObject [
        ("name", Json.JStr "ada"),
        ("age", Json.JNum 36.0),
        ("ok", Json.JBool True),
        ("tags", Json.JList [Json.JStr "a", Json.JNull])
      ]
  encode doc`, (text) => {
    assert.equal(text, '{"name":"ada","age":36,"ok":true,"tags":["a",null]}');
  });
});

test("json: decode round-trips and accessors read fields", async () => {
  await withRoute("import Json (Json(..), encode, decode, field, asString, asInt, asList)", `do
  let parsed = decode "{\\"user\\":{\\"name\\":\\"ada\\",\\"age\\":36},\\"tags\\":[1,2]}"
  let name = Json.getPath ["user", "name"] parsed
  let age = Json.getPath ["user", "age"] parsed
  let nameText = case name of
        Some v -> Json.asString v
        None -> None
  let ageInt = case age of
        Some v -> Json.asInt v
        None -> None
  let tags = case Json.field "tags" parsed of
        Some t -> Json.asList t
        None -> None
  let count = case tags of
        Some ts -> len ts
        None -> 0
  str nameText + "|" + str ageInt + "|" + str count + "|" + encode parsed`, (text) => {
    assert.equal(text, 'Some(ada)|Some(36)|2|{"user":{"name":"ada","age":36},"tags":[1,2]}');
  });
});

test("json: decodeSafe reports invalid input", async () => {
  await withRoute("import Json (Json(..), decodeSafe)", `do
  case decodeSafe "{oops" of
    Ok _ -> "parsed"
    Err why -> why`, (text) => {
    assert.equal(text, "invalid JSON");
  });
});

test("time: iso formatting, parts and arithmetic", async () => {
  await withRoute("import Time", `do
  let t = 1793427000000
  Time.formatIso t + "|" + Time.formatDate t + "|" + Time.formatClock t + "|" +
    Time.weekday t + "|" + Time.month t + "|" +
    str (Time.diffSeconds (Time.addDays 1 t) t)`, (text) => {
    assert.equal(text, "2026-10-31T06:10:00Z|2026-10-31|06:10:00|Saturday|October|86400");
  });
});

test("path: join, basename, dirname, extension and normalize", async () => {
  await withRoute("import Path", `do
  Path.join ["a", "b", "c.flow"] + "|" +
    Path.basename "a/b/c.flow" + "|" +
    Path.dirname "a/b/c.flow" + "|" +
    Path.extension "a/b/c.flow" + "|" +
    Path.normalize "a/./b/../c" + "|" +
    str (Path.isAbsolute "/tmp/x")`, (text) => {
    assert.equal(text, "a/b/c.flow|c.flow|a/b|.flow|a/c|True");
  });
});

test("env: variables, defaults and platform are readable on the server", async () => {
  await withRoute("import Env", `do
  let args = Env.args ()
  str (Env.exists "PATH") + "|" + str (Env.getOr "fallback" "FLOW_STDLIB_MISSING") + "|" +
    str (strLen (Env.platform ()) > 0) + "|" + str (len args >= 0)`, (text) => {
    assert.equal(text, "True|fallback|True|True");
  });
});

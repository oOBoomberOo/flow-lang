import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileFile } from "../src/compile.ts";
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

const SOURCE = `import Fs (tmpDir, makeDir, writeText, appendText, readText, tryReadText, exists, listDir, stat, removeFile, removeDir)
import Http (get, Router, RequestObject, Response, textResponse)

routes :: () -> ()
routes () =
  Router.mount [ get "/fs" (\\(_req :: RequestObject) -> do
      let dir = tmpDir () + "/flow-fs-test-dir"
      makeDir dir
      let file = dir + "/a.txt"
      writeText file "hello"
      appendText file " fs"
      let text = readText file
      let again = case tryReadText file of
            Some x -> x
            None -> "missing"
      let missing = case tryReadText (file + ".nope") of
            Some _ -> "some"
            None -> "none"
      let info = stat file
      let names = listDir dir
      let present = exists file
      textResponse (text + "|" + again + "|" + str info.size + "|" + str names + "|" + missing + "|" + str present))
    , get "/fs-remove" (\\(_req :: RequestObject) -> do
      let dir = tmpDir () + "/flow-fs-remove-dir"
      makeDir dir
      let file = dir + "/b.txt"
      writeText file "x"
      removeFile file
      let gone = exists file
      removeDir dir
      textResponse (str gone))
    ]

main :: Html
main = <p>{"fs"}</p>
`;

async function withFsHost(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-fs-"));
  const entry = path.join(root, "main.flow");
  fs.writeFileSync(entry, SOURCE);
  const outDir = path.join(root, "build");
  const result = compileFile(entry);
  emit(result, outDir);
  const host = await createHost({ outDir, port: 0, secrets: {} });
  try {
    return await fn(host, result);
  } finally {
    await host.close();
    fs.rmSync(path.join(os.tmpdir(), "flow-fs-test-dir"), { recursive: true, force: true });
    fs.rmSync(path.join(os.tmpdir(), "flow-fs-remove-dir"), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("fs: server filesystem effect reads, writes, stats and lists", async () => {
  await withFsHost(async (host, result) => {
    assert.ok(result.server.includes('R.ffiFn("__flow.host.fsReadText"'), "readText is provided over the host");
    assert.ok(result.server.includes('R.ffiFn("__flow.host.fsWriteText"'), "writeText is provided over the host");

    const res = await fetch(host.url + "/fs");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "hello fs|hello fs|8|[a.txt]|none|True");
  });
});

test("fs: removeFile and removeDir work from the server", async () => {
  await withFsHost(async (host) => {
    const res = await fetch(host.url + "/fs-remove");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "False");
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileFile } from "../src/compile.ts";
import { createHost } from "../src/host.ts";
import { createRuntime } from "../src/runtime/core.js";

/**
 * The server-first entry model:
 *
 *   main :: ()     runs once on the server at startup (server-side setup)
 *   serve handler  installs a client-placed page handler (Request -> Html)
 *
 * `main :: Html` remains a single-page client entry, and `routes()` remains the
 * server-side response table (JSON, redirects, custom status).
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-serve-"));
  fs.writeFileSync(path.join(root, "flow.json"), JSON.stringify({ name: "webapp", version: "0.1.0", dependencies: {} }));
  for (const [rel, src] of Object.entries(files)) {
    const f = path.join(root, "src", rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, src);
  }
  return path.join(root, "src", "main.flow");
}

async function withHost(entry, fn) {
  const result = compileFile(entry);
  const outDir = path.join(path.dirname(entry), "..", ".flow-build");
  emit(result, outDir);
  const host = await createHost({ outDir, port: 0, secrets: {} });
  try {
    return await fn(host, result);
  } finally {
    await host.close();
  }
}

const pageApp = (marker) => `import Http (RequestObject, PageRoute, serve, page, matchPage)
import Fs (writeText)

pages :: List PageRoute
pages =
  [ page "/" (\\_ -> <h1>{"Home ${marker}"}</h1>)
  , page "/about" (\\_ -> <h1>{"About ${marker}"}</h1>)
  ]

main :: ()
main = do
  writeText ${JSON.stringify(marker)} "started"
  serve (\\req ->
    case matchPage pages req of
      Some (matched, view) -> view matched
      None -> <h1>{"404 " + req.path}</h1>)
`;

test("serve: main is a server startup hook and serve installs the client page", async () => {
  const marker = path.join(os.tmpdir(), `flow-startup-${process.pid}-${Date.now()}.txt`);
  const entry = packageWith({ "main.flow": pageApp(marker) });
  await withHost(entry, async (host, result) => {
    assert.ok(result.server.includes("export { main as __flow_entry }"), "main is exported to the host");
    assert.ok(result.server.includes("export const __flow_serve = true"), "the page router is announced");
    assert.ok(result.client.includes("const $serve ="), "the handler is emitted in the client bundle");
    assert.ok(!/__flow_start\(root\)[^\n]*main\(\)/.test(result.client), "the client does not mount main");
    assert.ok(fs.existsSync(marker), "main ran once on the server before the first request");
    assert.equal(fs.readFileSync(marker, "utf8"), "started");

    const request = async (urlPath, init) => {
      const res = await fetch(host.url + urlPath, init);
      return { status: res.status, type: res.headers.get("content-type") ?? "", text: await res.text() };
    };

    for (const pagePath of ["/", "/about", "/missing"]) {
      const res = await request(pagePath);
      assert.equal(res.status, 200);
      assert.match(res.type, /text\/html/);
      assert.match(res.text, /__flow_start/);
      assert.match(res.text, new RegExp(`"path":"${pagePath}"`), "the shell carries the real request");
    }

    const post = await request("/form?x=1", { method: "POST", body: "a=1" });
    assert.match(post.text, /"method":"POST"/);
    assert.match(post.text, /"query":"x=1"/);
    assert.match(post.text, /"body":"a=1"/);

    const app = await request("/app.js");
    assert.match(app.text, /\$serve/);
    assert.doesNotMatch(app.text, /main\(\)/);
  });
});

test("serve: a named page function works and path captures are matched", () => {
  const entry = packageWith({
    "main.flow": `import Http (RequestObject, PageRoute, serve, page, matchPage, pathParam)

users :: List PageRoute
users = [ page "/users/:id" (\\req ->
    case pathParam req "id" of
      Some id -> <h1>{"User " + id}</h1>
      None -> <h1>{"Missing id"}</h1>) ]

main :: ()
main = serve (\\req ->
  case matchPage users req of
    Some (matched, view) -> view matched
    None -> <h1>{"Not found"}</h1>)
`,
  });
  const r = compileFile(entry);
  assert.deepEqual(r.diagnostics, []);
  assert.ok(r.client.includes("pathParam"), "the page can read its captures");
  assert.ok(r.client.includes('"page"'), "the route table is emitted for the browser");
});

test("serve: a page handler cannot capture server startup locals", () => {
  const entry = packageWith({
    "main.flow": `import Http (serve)

main :: ()
main = do
  let secret = "shh"
  serve (\\_ -> <p>{secret}</p>)
`,
  });
  assert.throws(() => compileFile(entry), /cannot capture server startup binding\(s\) 'secret'/);
});

test("serve: it can be installed once, and main must return () or Html", () => {
  const twice = packageWith({
    "main.flow": `import Http (serve)

main :: ()
main = do
  serve (\\_ -> <p>{"one"}</p>)
  serve (\\_ -> <p>{"two"}</p>)
`,
  });
  assert.throws(() => compileFile(twice), /`serve` can be called only once/);

  const bad = packageWith({
    "main.flow": `main :: Int
main = 1
`,
  });
  assert.throws(() => compileFile(bad), /must return Html .* or \(\)/);

  const clientOnly = packageWith({
    "main.flow": `import Client (log)

main :: ()
main = log "only the browser"
`,
  });
  assert.throws(() => compileFile(clientOnly), /only touches the browser/);
});

test("serve: legacy main :: Html is still a single client page", async () => {
  const entry = packageWith({
    "main.flow": `main :: Html
main = <h1>{"Legacy page"}</h1>
`,
  });
  await withHost(entry, async (host, result) => {
    assert.ok(!result.server.includes("__flow_entry"), "a page main is not a server hook");
    assert.ok(!result.server.includes("__flow_serve"), "a page main installs no router");
    assert.ok(/__flow_start\(root\)[^\n]*main\(\)/.test(result.client), "the client mounts main");
    const root = await fetch(host.url + "/");
    assert.equal(root.status, 200);
    assert.match(await root.text(), /__flow_start/);
    assert.equal((await fetch(host.url + "/other")).status, 404, "a single page app keeps the old 404");
  });
});

test("serve: server routes and page routing coexist", async () => {
  const entry = packageWith({
    "main.flow": `import Http (RequestObject, serve, get, Router, jsonResponse, redirect)

routes :: () -> ()
routes () = Router.mount
  [ get "/api/health" (\\_ -> jsonResponse "{\\"ok\\":true}")
  , get "/go" (\\_ -> redirect "/")
  ]

main :: ()
main = serve (\\req -> <h1>{"page " + req.path}</h1>)
`,
  });
  await withHost(entry, async (host) => {
    const api = await fetch(host.url + "/api/health");
    assert.equal(api.status, 200);
    assert.match(api.headers.get("content-type") ?? "", /application\/json/);
    assert.equal(await api.text(), '{"ok":true}');

    const go = await fetch(host.url + "/go", { redirect: "manual" });
    assert.equal(go.status, 302);
    assert.equal(go.headers.get("location"), "/");

    const page = await fetch(host.url + "/some/page");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await page.text(), /__flow_start/);
  });
});

test("runtime: a remote value updates the node without re-subscribing", async () => {
  const R = createRuntime();
  const sent = [];
  R._attach((msg) => sent.push(msg));
  const node = R.remote("cut1", () => ({}));
  assert.equal(sent.filter((m) => m.t === "sub").length, 1, "the first read subscribes");

  await R._receive({ t: "val", id: "cut1", value: "Visits: 1" });
  assert.equal(R.v(node), "Visits: 1", "the node carries the new value");
  assert.equal(sent.filter((m) => m.t === "sub").length, 1, "a reply must not re-subscribe");

  // A dependency change still asks the server again.
  const dep = R.cell(0);
  const dependent = R.remote("cut2", () => ({ dep }));
  assert.equal(R.v(dependent), undefined);
  const before = sent.filter((m) => m.t === "sub").length;
  dep.set(1);
  assert.equal(R.v(dependent), undefined);
  assert.equal(sent.filter((m) => m.t === "sub").length, before + 1, "a dependency change re-subscribes");
});

test("serve: an API-only server main does not reference main in the browser", async () => {
  const entry = packageWith({
    "main.flow": `import Http (RequestObject, get, Router, textResponse)

routes :: () -> ()
routes () = Router.mount [ get "/api" (\\_ -> textResponse "ok") ]

main :: ()
main = Router.mount [ get "/from-main" (\\_ -> textResponse "main") ]
`,
  });
  await withHost(entry, async (host, result) => {
    assert.match(result.client, /__flow_start\(root\) \{ R\.mount\(root, \(\) => null\); \}/);
    assert.equal((await fetch(host.url + "/api")).status, 200);
    assert.equal(await (await fetch(host.url + "/from-main")).text(), "main");
    assert.equal((await fetch(host.url + "/page")).status, 404);
  });
});

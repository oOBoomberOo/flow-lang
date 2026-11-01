import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileFile, compileSource } from "../src/compile.ts";
import { createHost } from "../src/host.ts";
import { withModule } from "./helpers.mjs";

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-alg-"));
  const entry = path.join(root, "main.flow");
  fs.writeFileSync(entry, withModule(source));
  const result = compileFile(entry);
  const outDir = path.join(root, "build");
  emit(result, outDir);
  const host = await createHost({ outDir, port: 0, secrets: {} });
  try {
    return await fn(host, result);
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const ROUTES = (body) => `import State (withState, runState, execState, State)
import Http (get as httpGet, Router, RequestObject, Response, textResponse)

${body}

routes :: () -> ()
routes () = Router.mount [httpGet "/run" (\\_req -> textResponse (run ()))]

main :: Html
main = <p>{"algebraic"}</p>
`;

test("algebraic: a state handler resumes at get/put and returns the body result", async () => {
  const source = ROUTES(`compute :: () -> Int ! State
compute () = do
  State.put 10
  State.put (State.get () + 5)
  State.get () + State.get ()

run :: () -> Str
run () = do
  let value = withState 0 (\\() -> compute ())
  let pair =
        runState 1 (\\() -> do
          State.put 41
          State.get ())
  let end =
        execState 0 (\\() -> do
          State.put 9
          0)
  str value + "|" + str pair + "|" + str end
`);
  await withHost(source, async (host, result) => {
    assert.ok(result.server.includes('R.handle("State"'), "the handler is emitted");
    assert.ok(/function\*/.test(result.server), "the handled body compiles to a generator");
    assert.ok(result.server.includes('yield R.perform("State", "get"'), "operations suspend");
    assert.ok(result.server.includes("yield* resume("), "handlers call the continuation");

    const res = await fetch(host.url + "/run");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "30|[41, 41]|9");
  });
});

test("algebraic: a handler that does not resume aborts the body", async () => {
  const source = ROUTES(`effect Fail where
  fail :: Str -> Int

guarded :: () -> Int
guarded () =
  handle Fail with
    fail msg = 0 - 1
  in do
    Fail.fail "boom"
    7

run :: () -> Str
run () = str (guarded ())
`);
  await withHost(source, async (host) => {
    const res = await fetch(host.url + "/run");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "-1", "the handler's value replaces the whole handled result");
  });
});

test("algebraic: handler code after resume runs and can transform the result", async () => {
  const source = ROUTES(`effect Tick where
  tick :: () -> ()

run :: () -> Str
run () = do
  let out =
        handle Tick with
          tick () = do
            let rest = resume ()
            rest + 100
        in do
          Tick.tick ()
          7
  str out
`);
  await withHost(source, async (host) => {
    const res = await fetch(host.url + "/run");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "107");
  });
});

test("algebraic: inner handlers shadow outer ones and restore afterwards", async () => {
  const source = ROUTES(`run :: () -> Str
run () = do
  let out =
        withState 5 (\\() -> do
          let inner = withState 100 (\\() -> State.get ())
          State.get () + inner)
  str out
`);
  await withHost(source, async (host) => {
    const res = await fetch(host.url + "/run");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "105");
  });
});

test("algebraic: operations of an unhandled effect are forwarded to the outer handler", async () => {
  const source = ROUTES(`effect A where
  a :: () -> Int

effect B where
  b :: () -> Int

run :: () -> Str
run () = do
  let out =
        handle A with
          a () = resume 1
        in handle B with
          b () = resume 2
        in A.a () + B.b ()
  str out
`);
  await withHost(source, async (host) => {
    const res = await fetch(host.url + "/run");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "3");
  });
});

test("algebraic: the handled effect leaves the row", () => {
  const ok = compileSource(`effect E where
  ask :: () -> Int

f :: () -> Int
f () =
  handle E with
    ask () = resume 0
  in E.ask ()

main :: Html
main = <p>{str (f ())}</p>
`, "row.flow");
  assert.deepEqual(ok.diagnostics, []);

  assert.throws(
    () => compileSource(`effect E where
  ask :: () -> Int

f :: () -> Int
f () = E.ask ()

main :: Html
main = <p>{str (f ())}</p>
`, "row.flow"),
    /performs effect\(s\) \{E\} without handling them/,
  );
});

test("algebraic: provide installs a default handler", () => {
  const r = compileSource(`effect E where
  ask :: () -> Int

provide E where
  ask () = 41

main :: Html
main = <p>{str (E.ask ())}</p>
`, "provide.flow");
  assert.deepEqual(r.errors, []);
  assert.match(r.client, /R\.provide\("E"/, "the default handler is installed");
});

test("algebraic: resume is only available inside a handler operation", () => {
  assert.throws(
    () => compileSource(`main :: Html
main = <p>{str (resume 1)}</p>
`, "resume.flow"),
    /'resume' is only available inside an operation handler/,
  );
});

test("algebraic: resume must be called directly, and only once", async () => {
  assert.throws(
    () => compileSource(`effect E where
  ask :: () -> Int

f :: () -> Int
f () =
  handle E with
    ask () = do
      let k = resume
      k 1
  in E.ask ()

main :: Html
main = <p>{str (f ())}</p>
`, "resume-value.flow"),
    /'resume' must be called directly/,
  );

  const { createRuntime } = await import("../src/runtime/core.js");
  const R = createRuntime();
  const gen = R.handle("E", {
    ask: function* (resume) {
      yield* resume(1);
      yield* resume(2);
      return 0;
    },
  }, function* () { return yield R.perform("E", "ask", []); });
  assert.throws(() => R.run(gen), /called more than once/);
});

test("algebraic: a handler operation must return the handled result", () => {
  assert.throws(
    () => compileSource(`effect E where
  ask :: () -> Int

f :: () -> Int
f () =
  handle E with
    ask () = ()
  in E.ask ()

main :: Html
main = <p>{str (f ())}</p>
`, "shape.flow"),
    /must return the handled result Int/,
  );
});

test("algebraic: an effectful callback needs an effect row on the consumer", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-alg-cb-"));
  const entry = path.join(root, "main.flow");
  fs.writeFileSync(entry, withModule(`import State (State)

f :: () -> List Int
f () = map (\\(x :: Int) -> State.get () + x) [1]

main :: Html
main = <p>{str (f ())}</p>
`));
  try {
    assert.throws(
      () => compileFile(entry),
      /performs effect.*\{State\}.*without handling/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("algebraic: Flow.Exn aborts, maps failures, and recovers at the failure point", async () => {
  const source = `import Exn (attempt, recoverWith, recover, fail, Exn)
import Http (get as httpGet, Router, RequestObject, Response, textResponse)

risky :: Int -> Int ! Exn
risky n = if n < 0 then fail "negative" else n * 2

run :: () -> Str
run () = do
  let a = attempt 0 (\\() -> risky 21)
  let b = attempt (0 - 1) (\\() -> risky (0 - 3))
  let c = recoverWith (\\(_m :: Str) -> 5) (\\() -> risky (0 - 3))
  let d = recover 99 (\\() -> fail "soft")
  str a + "|" + str b + "|" + str c + "|" + str d

routes :: () -> ()
routes () = Router.mount [httpGet "/run" (\\(_req :: RequestObject) -> textResponse (run ()))]

main :: Html
main = <p>{"exn"}</p>
`;
  await withHost(source, async (host) => {
    const res = await fetch(host.url + "/run");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "42|-1|5|99");
  });
});

test("algebraic: unhandled operations fail loudly at runtime", async () => {
  const { createRuntime } = await import("../src/runtime/core.js");
  const R = createRuntime();
  assert.throws(
    () => R.run((function* () { yield R.perform("Nope", "go", []); })()),
    /unhandled effect Nope\.go/,
  );
  assert.equal(R.run((function* () { return 42; })()), 42);
  assert.equal(R.run(() => 7), 7);
});

test("algebraic: a server cut's effect reaches the caller's handler", async () => {
  const { createRuntime } = await import("../src/runtime/core.js");
  const client = createRuntime();
  const server = createRuntime();
  client._attach((m) => server._receive(m), "client");
  server._attach((m) => client._receive(m), "server");
  server.serve("ask", () =>
    (function* () { return yield server.perform("Ask", "ask", [null]); })());
  server.serve("abort", () =>
    (function* () { return yield server.perform("Ask", "stop", [null]); })());

  const resumed = await client.runAsync(client.handle("Ask", {
    ask: function* (_unit, resume) { return yield* resume(41); },
  }, async () => await client.call("ask")));
  assert.equal(resumed, 41, "the client handler resumes the server computation");

  const aborted = await client.runAsync(client.handle("Ask", {
    stop: function* (_unit, _resume) { return 7; },
  }, async () => await client.call("abort")));
  assert.equal(aborted, 7, "a handler that does not resume supplies the result");
});

test("algebraic: the client entry drives main through the runtime", () => {
  const r = compileSource(`effect E where
  ask :: () -> Int

main :: Html
main = do
  let n =
        handle E with
          ask () = resume 3
        in E.ask ()
  <p>{str n}</p>
`, "client.flow");
  assert.ok(r.client.includes("R.runAsync(() => main())"), "main is driven, not called bare");
  assert.ok(/function\*/.test(r.client), "the handled body is a generator");
});

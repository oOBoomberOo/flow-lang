import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileFile, compileSource } from "../src/compile.ts";
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

async function withHost(source, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-alg-"));
  const entry = path.join(root, "main.flow");
  fs.writeFileSync(entry, source);
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

const ROUTES = (body) => `use std::state::{withState, runState, execState, State}
use std::http::{get as httpGet, Router, RequestObject, Response, textResponse}

${body}

fn routes() -> Unit {
  Router.mount([ httpGet("/run", fn(_req: RequestObject) -> Response { textResponse(run()) }) ]);
}

fn main() -> Html { html { <p>{"algebraic"}</p> } }
`;

test("algebraic: a state handler resumes at get/put and returns the body result", async () => {
  const source = ROUTES(`
fn compute() -> Int ! {State} {
  State.put(10);
  State.put(State.get() + 5);
  State.get() + State.get()
}

fn run() -> Str {
  let value = withState(0, fn() -> Int { compute() });
  let pair = runState(1, fn() -> Int { State.put(41); State.get() });
  let end = execState(0, fn() -> Int { State.put(9); 0 });
  str(value) + "|" + str(pair) + "|" + str(end)
}
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
  const source = ROUTES(`
algebraic effect Fail {
  fn fail(msg: Str) -> Int
}

fn guarded() -> Int {
  handle Fail with {
    fail = fn(msg: Str) -> Int { 0 - 1 }
  } {
    Fail.fail("boom");
    7
  }
}

fn run() -> Str { str(guarded()) }
`);
  await withHost(source, async (host) => {
    const res = await fetch(host.url + "/run");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "-1", "the handler's value replaces the whole handled result");
  });
});

test("algebraic: handler code after resume runs and can transform the result", async () => {
  const source = ROUTES(`
algebraic effect Tick {
  fn tick() -> Unit
}

fn run() -> Str {
  let out = handle Tick with {
    tick = fn() -> Int {
      let rest = resume(());
      rest + 100
    }
  } {
    Tick.tick();
    7
  };
  str(out)
}
`);
  await withHost(source, async (host) => {
    const res = await fetch(host.url + "/run");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "107");
  });
});

test("algebraic: inner handlers shadow outer ones and restore afterwards", async () => {
  const source = ROUTES(`
fn run() -> Str {
  let out = withState(5, fn() -> Int {
    let inner = withState(100, fn() -> Int { State.get() });
    State.get() + inner
  });
  str(out)
}
`);
  await withHost(source, async (host) => {
    const res = await fetch(host.url + "/run");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "105");
  });
});

test("algebraic: operations of an unhandled effect are forwarded to the outer handler", async () => {
  const source = ROUTES(`
algebraic effect A { fn a() -> Int }
algebraic effect B { fn b() -> Int }

fn run() -> Str {
  let out = handle A with {
    a = fn() -> Int { resume(1) }
  } {
    handle B with {
      b = fn() -> Int { resume(2) }
    } {
      A.a() + B.b()
    }
  };
  str(out)
}
`);
  await withHost(source, async (host) => {
    const res = await fetch(host.url + "/run");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "3");
  });
});

test("algebraic: the handled effect leaves the row", () => {
  const ok = compileSource(`
algebraic effect E { fn ask() -> Int }

fn f() -> Int ! {} {
  handle E with { ask = fn() -> Int { resume(0) } } { E.ask() }
}

fn main() -> Html { html { <p>{str(f())}</p> } }
`, "row.flow");
  assert.deepEqual(ok.diagnostics, []);

  assert.throws(
    () => compileSource(`
algebraic effect E { fn ask() -> Int }

fn f() -> Int ! {} { E.ask() }

fn main() -> Html { html { <p>{str(f())}</p> } }
`, "row.flow"),
    /unhandled effect\(s\) \{E\}/,
  );
});

test("algebraic: provide is rejected", () => {
  assert.throws(
    () => compileSource(`
algebraic effect E { fn ask() -> Int }
provide E with { ask = fn() -> Int { 0 } }
fn main() -> Html { html { <p>{"no"}</p> } }
`, "provide.flow"),
    /algebraic effect 'E' cannot be provided/,
  );
});

test("algebraic: resume is only available inside a handler operation", () => {
  assert.throws(
    () => compileSource(`
fn main() -> Html { html { <p>{str(resume(1))}</p> } }
`, "resume.flow"),
    /'resume' is only available inside an operation handler/,
  );
});

test("algebraic: resume must be called directly, and only once", async () => {
  assert.throws(
    () => compileSource(`
algebraic effect E { fn ask() -> Int }

fn f() -> Int {
  handle E with {
    ask = fn() -> Int {
      let k = resume;
      k(1)
    }
  } { E.ask() }
}

fn main() -> Html { html { <p>{str(f())}</p> } }
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
    () => compileSource(`
algebraic effect E { fn ask() -> Int }

fn f() -> Int {
  handle E with { ask = fn() -> Unit { () } } { E.ask() }
}

fn main() -> Html { html { <p>{str(f())}</p> } }
`, "shape.flow"),
    /must return the handled result Int/,
  );
});

test("algebraic: an effectful callback needs an effect row on the consumer", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-alg-cb-"));
  const entry = path.join(root, "main.flow");
  fs.writeFileSync(entry, `use std::state::State
use std::list::{map}

fn f() -> List<Int> {
  map([1], fn(x: Int) -> Int { State.get() + x })
}

fn main() -> Html { html { <p>{str(f())}</p> } }
`);
  try {
    assert.throws(
      () => compileFile(entry),
      /cannot pass a function that performs \{State\} to '.*map'/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("algebraic: std::exn aborts, maps failures, and recovers at the failure point", async () => {
  const source = `use std::exn::{attempt, recoverWith, recover, fail, Exn}
use std::http::{get as httpGet, Router, RequestObject, Response, textResponse}

fn risky(n: Int) -> Int ! {Exn} {
  if (n < 0) { fail("negative") } else { n * 2 }
}

fn run() -> Str {
  let a = attempt(0, fn() -> Int { risky(21) });
  let b = attempt(0 - 1, fn() -> Int { risky(0 - 3) });
  let c = recoverWith(fn(_m: Str) -> Int { 5 }, fn() -> Int { risky(0 - 3) });
  let d = recover(99, fn() -> Int { fail("soft") });
  str(a) + "|" + str(b) + "|" + str(c) + "|" + str(d)
}

fn routes() -> Unit {
  Router.mount([ httpGet("/run", fn(_req: RequestObject) -> Response { textResponse(run()) }) ]);
}

fn main() -> Html { html { <p>{"exn"}</p> } }
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
    /unhandled algebraic effect Nope\.go/,
  );
  assert.equal(R.run((function* () { return 42; })()), 42);
  assert.equal(R.run(() => 7), 7);
});

test("algebraic: the client entry drives main through the runtime", () => {
  const r = compileSource(`
algebraic effect E { fn ask() -> Int }

fn main() -> Html {
  let n = handle E with { ask = fn() -> Int { resume(3) } } { E.ask() };
  html { <p>{str(n)}</p> }
}
`, "client.flow");
  assert.ok(r.client.includes("R.run(() => main())"), "main is driven, not called bare");
  assert.ok(/function\*/.test(r.client), "the handled body is a generator");
});

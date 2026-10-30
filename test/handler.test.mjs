import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { compileFile, compileSource } from "../src/compile.ts";

/**
 * Local capability handlers: `handle Effect with { … } { body }` installs a
 * scoped provider, nests/restores, and removes the handled effect from the
 * body's effect row.
 */

test("handler: local providers compile and nest", () => {
  const r = compileFile(path.join(import.meta.dirname, "..", "examples", "handler.flow"));
  assert.deepEqual(r.diagnostics, []);
  assert.match(r.client, /R\.withEffect\("Local"/, "a scoped provider is emitted");
  const count = (r.client.match(/R\.withEffect\("Local"/g) ?? []).length;
  assert.ok(count >= 2, "nested handlers are both emitted");
});

test("handler: the handled effect is removed from the row", () => {
  const src = `
effect Local @ client { fn ping() -> Str }

fn f() -> Str ! {} {
  handle Local with {
    ping = fn() -> Str { "ok" }
  } {
    Local.ping()
  }
}

fn main() -> Html { html { <p>{f()}</p> } }
`;
  const r = compileSource(src, "handler.flow");
  assert.deepEqual(r.diagnostics, []);
});

test("handler: a complete local handler can replace a global provider", () => {
  const src = `
effect Global @ client { fn read() -> Str }
provide Global with { read = fn() -> Str { "global" } }

fn main() -> Html {
  let x = handle Global with {
    read = fn() -> Str { "local" }
  } {
    Global.read()
  };
  html { <p>{x}</p> }
}
`;
  const r = compileSource(src, "handler.flow");
  assert.deepEqual(r.diagnostics, []);
  assert.match(r.client, /R\.withEffect\("Global"/);
});

test("handler: missing operations are rejected", () => {
  const src = `
effect Two @ client {
  fn a() -> Int
  fn b() -> Int
}

fn main() -> Html {
  let x = handle Two with {
    a = fn() -> Int { 1 }
  } {
    Two.a()
  };
  html { <p>{str(x)}</p> }
}
`;
  assert.throws(() => compileSource(src, "handler.flow"), /missing operation\(s\) b/);
});

test("handler: an operation signature mismatch is rejected", () => {
  const src = `
effect Local @ client { fn ping() -> Str }

fn main() -> Html {
  let x = handle Local with {
    ping = fn() -> Int { 1 }
  } {
    Local.ping()
  };
  html { <p>{str(x)}</p> }
}
`;
  assert.throws(() => compileSource(src, "handler.flow"), /does not match its signature/);
});

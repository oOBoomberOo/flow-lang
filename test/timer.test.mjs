import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileFile } from "../src/compile.ts";

function compileSource(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-timer-"));
  const file = path.join(dir, "main.flow");
  fs.writeFileSync(file, source);
  try {
    return compileFile(file).client;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const TIMER = `type IO<a> = () -> a

unsafe extern js fn unsafe_create_timer(callback: IO<Unit>, ms: Int) -> Int
  = "window.setInterval"

fn make_timer(ms: Int, callback: IO<Unit>) -> Int {
  let timer_id = unsafe_create_timer(callback, ms);
  timer_id
}

fn main() -> Html {
  Client.log("started");
  let _ = make_timer(500) <| fn() {
    Client.log("tick");
  };
  html { <div>{"x"}</div> }
}
`;

test("timer: FFI calls and discarded bindings run eagerly, not as lazy signals", () => {
  const client = compileSource(TIMER);
  assert.match(client, /const timer_id = R\.ffiCall\("window\.setInterval"/);
  assert.doesNotMatch(client, /R\.sig\(\(\) => R\.ffiCall\("window\.setInterval"/);
  assert.match(client, /const _ = \(\(\$p1\)/);
  assert.doesNotMatch(client, /const _ = R\.sig/);
});

test("timer: pure lets stay lazy signals", () => {
  const client = compileSource(`fn main() -> Html {
  let n = 1 + 2;
  html { <p>{str(n)}</p> }
}
`);
  assert.match(client, /const n = R\.sig\(/);
});

test("timer: a Unit-typed let runs in program order", () => {
  const client = compileSource(`fn main() -> Html {
  let u = Client.log("once");
  html { <p>{"x"}</p> }
}
`);
  assert.doesNotMatch(client, /const u = R\.sig/);
});

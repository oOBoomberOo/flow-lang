import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileFile } from "../src/compile.ts";
import { withModule } from "./helpers.mjs";

function compileSource(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-timer-"));
  const file = path.join(dir, "main.flow");
  fs.writeFileSync(file, withModule(source));
  try {
    return compileFile(file).client;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const TIMER = `type IO a = () -> a

foreign import js unsafe "window.setInterval" {
  unsafe_create_timer :: IO () -> Int -> Int
}

make_timer :: Int -> IO () -> Int
make_timer ms callback = do
  let timer_id = unsafe_create_timer callback ms
  timer_id

main :: Html
main = do
  Client.log "started"
  let _ = (make_timer 500) (\\() -> Client.log "tick")
  <div>{"x"}</div>
`;

test("timer: FFI calls and discarded bindings run eagerly, not as lazy signals", () => {
  const client = compileSource(TIMER);
  assert.match(client, /const timer_id = R\.ffiCall\("window\.setInterval"/);
  assert.doesNotMatch(client, /R\.sig\(\(\) => R\.ffiCall\("window\.setInterval"/);
  assert.match(client, /const _ = .*\(\$p\d+\)/);
  assert.doesNotMatch(client, /const _ = R\.sig/);
});

test("timer: pure lets stay lazy signals", () => {
  const client = compileSource(`main :: Html
main = do
  let n = 1 + 2
  <p>{str n}</p>
`);
  assert.match(client, /const n = R\.sig\(/);
});

test("timer: a Unit-typed let runs in program order", () => {
  const client = compileSource(`main :: Html
main = do
  let u = Client.log "once"
  <p>{"x"}</p>
`);
  assert.doesNotMatch(client, /const u = R\.sig/);
});

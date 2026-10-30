import { test } from "node:test";
import assert from "node:assert/strict";
import { compileSource } from "../src/compile.ts";
import { substSize } from "../src/types.ts";

const PROGRAM = `
type Tree<a> = Leaf(a) | Node(Tree<a>, Tree<a>)

fn sum(t: Tree<Int>) -> Int {
  match t {
    Leaf(x) => x,
    Node(l, r) => sum(l) + sum(r),
  }
}

fn twice<a>(x: a, f: (a) -> a) -> a { f(f(x)) }

fn total(xs: List<Int>) -> Int {
  if (isEmpty(xs)) { 0 } else { at(xs, 0) + total(tail(xs)) }
}

fn main() -> Html {
  let t = Node(Leaf(1), Leaf(2));
  let n = twice(3, fn(x: Int) -> Int { x + 1 });
  html { <p>{str(sum(t) + n + total([1, 2, 3]))}</p> }
}
`;

test("perf: unification state does not accumulate across compiles", () => {
  compileSource(PROGRAM);
  const first = substSize();
  assert.ok(first > 0, "the compile binds type variables");

  // Compiling the same input again must start from empty state, not from the
  // previous compile's bindings (which made snapshots progressively slower).
  compileSource(PROGRAM);
  const second = substSize();
  assert.equal(second, first, "the second compile leaves exactly the same state");

  for (let i = 0; i < 5; i++) compileSource(PROGRAM);
  assert.equal(substSize(), first, "state stays flat over many compiles");
});

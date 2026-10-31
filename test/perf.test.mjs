import { test } from "node:test";
import assert from "node:assert/strict";
import { compileSource } from "../src/compile.ts";
import { substSize } from "../src/types.ts";

const PROGRAM = `data Tree a = Leaf a | Node (Tree a) (Tree a)

sum :: Tree Int -> Int
sum t = case t of
  Leaf x -> x
  Node l r -> sum l + sum r

twice :: a -> (a -> a) -> a
twice x f = f (f x)

total :: List Int -> Int
total xs = if isEmpty xs then 0 else at xs 0 + total (tail xs)

main :: Html
main = do
  let t = Node (Leaf 1) (Leaf 2)
  let n = twice 3 (\\(x :: Int) -> x + 1)
  <p>{str (sum t + n + total [1, 2, 3])}</p>
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

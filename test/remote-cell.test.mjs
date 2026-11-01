import { test } from "node:test";
import assert from "node:assert/strict";
import { createRuntime } from "../src/runtime/core.js";

/**
 * A Cell that crosses a boundary is a handle, not a serialized cell object.
 * The owner keeps the real cell; the peer gets a Cell-shaped proxy whose
 * reads are local snapshots and whose writes travel back.
 */

function pair() {
  const A = createRuntime();
  const B = createRuntime();
  const toB = [];
  const toA = [];
  A._attach((msg) => toB.push(JSON.parse(JSON.stringify(msg))), "A");
  B._attach((msg) => toA.push(JSON.parse(JSON.stringify(msg))), "B");
  async function pump() {
    for (;;) {
      if (toB.length) { await B._receive(toB.shift()); continue; }
      if (toA.length) { await A._receive(toA.shift()); continue; }
      break;
    }
  }
  return { A, B, pump };
}

test("remote cells: a cell crosses as a handle and keeps both sides in sync", async () => {
  const { A, B, pump } = pair();
  const cell = A.cell(0);
  A.serve("makeCell", () => cell);

  const pending = B.call("makeCell", {});
  await pump();
  const proxy = await pending;
  await pump();

  assert.ok(proxy && proxy.__cell, "the peer receives a Cell-shaped value");
  assert.equal(B.get(proxy), 0, "the handle carries the initial value");

  B.set(proxy, 5);
  await pump();
  assert.equal(A.get(cell), 5, "a peer write reaches the owner");

  const seen = [];
  const watcher = B.sig(() => B.get(proxy));
  watcher.watch((v) => seen.push(v));
  assert.equal(watcher.get(), 5, "the watching node starts from the current value");

  A.set(cell, 7);
  await pump();
  assert.equal(B.get(proxy), 7, "an owner write reaches the peer");
  assert.ok(seen.includes(7), "the peer proxy is reactive");
});

test("remote cells: a handle nested in a tuple still works", async () => {
  const { A, B, pump } = pair();
  const cell = A.cell(3);
  A.serve("makeTuple", () => [cell, "tail"]);

  const pending = B.call("makeTuple", {});
  await pump();
  const tuple = await pending;
  await pump();

  assert.ok(Array.isArray(tuple), "the tuple crosses structurally");
  assert.equal(tuple[1], "tail");
  assert.ok(tuple[0] && tuple[0].__cell, "the nested cell is a handle");
  assert.equal(B.get(tuple[0]), 3);

  B.set(tuple[0], 9);
  await pump();
  assert.equal(A.get(cell), 9);
});

test("remote cells: a reactive subscription can carry a cell handle", async () => {
  const { A, B, pump } = pair();
  const cell = A.cell(1);
  A.serve("cellStream", () => cell);

  const node = B.remote("cellStream", () => ({}), null);
  await pump();
  const proxy = B.v(node);
  assert.ok(proxy && proxy.__cell, "the subscription's value is a handle");
  assert.equal(B.get(proxy), 1);

  B.set(proxy, 2);
  await pump();
  assert.equal(A.get(cell), 2, "the client writes the server cell through the subscription handle");
});

test("remote cells: a local server cell can be read and written from client code", async () => {
  const { A, B, pump } = pair();
  const cell = A.cell(false);
  A.serve("localServerCell", () => cell);

  const pending = B.call("localServerCell", {});
  await pump();
  const proxy = await pending;
  await pump();

  assert.equal(B.get(proxy), false);
  B.set(proxy, true);
  await pump();
  assert.equal(A.get(cell), true, "the client-side proxy writes the server cell");
});

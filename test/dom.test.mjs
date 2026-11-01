import { test } from "node:test";
import assert from "node:assert/strict";
import { createRuntime } from "../src/runtime/core.js";
import { installDom } from "../src/runtime/dom.js";

/** The smallest DOM the renderer touches, so node kinds can be asserted. */
function fakeDocument() {
  const make = (nodeType, tagName) => ({
    nodeType,
    tagName,
    style: {},
    textContent: "",
    childNodes: [],
    attrs: {},
    appendChild(n) { this.childNodes.push(n); return n; },
    replaceChildren(...n) { this.childNodes = n; },
    setAttribute(n, v) { this.attrs[n] = String(v); },
    removeAttribute(n) { delete this.attrs[n]; },
    addEventListener() {},
  });
  globalThis.document = {
    createElement: (tag) => make(1, tag),
    createTextNode: (text) => { const n = make(3, undefined); n.textContent = text; return n; },
    createDocumentFragment: () => make(11, undefined),
  };
}

function runtime() {
  fakeDocument();
  return installDom(createRuntime());
}

test("dom: an empty list renders no elements", () => {
  const R = runtime();
  assert.deepEqual(R._toNodes([]), []);
  assert.equal(R.el("ul", {}, [[]]).childNodes.length, 0, "empty list child adds nothing");
  assert.equal(R.el("ul", {}, [[], []]).childNodes.length, 0, "nested empty lists add nothing");
});

test("dom: boolean attributes set and clear their attribute", () => {
  const R = runtime();
  const checked = R.el("input", { type: "checkbox", checked: true });
  assert.equal(checked.attrs.checked, "", "true sets the attribute");
  const unchecked = R.el("input", { type: "checkbox", checked: false });
  assert.equal(unchecked.attrs.checked, undefined, "false removes the attribute");
});

test("dom: a reactive value/checked binding updates the live control", () => {
  const R = runtime();
  const draft = R.cell("old");
  const todo = R.cell(true);
  const input = R.el("input", { value: R.attr(() => R.get(draft)) });
  const box = R.el("input", { type: "checkbox", checked: R.attr(() => R.get(todo)) });
  assert.equal(input.value, "old");
  assert.equal(box.checked, true);
  draft.set("");
  todo.set(false);
  assert.equal(input.value, "", "clearing the cell clears the live input");
  assert.equal(box.checked, false, "unchecking updates the live property, not only the attribute");
});

test("dom: a reactive cut starts with its placeholder until the first value", async () => {
  const R = runtime();
  const node = R.remote("cut1", () => ({}), []);
  assert.deepEqual(R.v(node), []);
  await R._receive({ t: "val", id: "cut1", value: [1, 2] });
  assert.deepEqual(R.v(node), [1, 2]);
});

test("dom: eventField walks target.value and target.checked", () => {
  runtime();
  const host = globalThis.__flow.host;
  const event = { target: { value: "12", checked: true }, key: "a" };
  assert.deepEqual(host.eventField(event, "target.value"), {
    $: "Some", args: [{ $: "JStr", args: ["12"] }],
  });
  assert.deepEqual(host.eventField(event, "target.checked"), {
    $: "Some", args: [{ $: "JBool", args: [true] }],
  });
  assert.deepEqual(host.eventField(event, "target.missing"), { $: "None", args: [] });
});

test("dom: a list of markup renders its elements, empty lists included", () => {
  const R = runtime();
  const nodes = [document.createElement("li"), document.createElement("li")];
  assert.equal(R._toNodes([[], ...nodes]).length, 2, "an empty list inside markup contributes nothing");
  assert.equal(R.el("ul", {}, [nodes]).childNodes.length, 2);
});

test("dom: a non-empty list of plain values still renders structurally", () => {
  const R = runtime();
  const nodes = R._toNodes([1, 2, 3]);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].textContent, "[1, 2, 3]");
});

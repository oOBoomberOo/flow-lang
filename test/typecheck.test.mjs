import { test } from "node:test";
import assert from "node:assert/strict";
import { compileSource } from "../src/compile.ts";

const ok = (src) => compileSource(src, "t.flow");
const bad = (src, re) => assert.throws(() => compileSource(src, "t.flow"), re);

const page = (body) => `fn main() -> Html { html { ${body} } }`;

/* ------------------------- types ------------------------- */

test("literals and arithmetic type-check", () => {
  ok(page(`<p>{1 + 2 * 3}</p>`));
});

test("string concatenation", () => {
  ok(page(`<p>{"a" + "b"}</p>`));
});

test("arithmetic on a string is a type error", () => {
  bad(page(`<p>{1 + "a"}</p>`), /type mismatch: (Int vs Str|Str vs Int)/);
});

test("condition must be Bool", () => {
  bad(page(`<p>{if (1) { "a" } else { "b" }}</p>`), /if condition/);
});

test("applying a non-function is rejected", () => {
  bad(`fn f() -> Int { 1 } fn main() -> Html { html { <p>{f(1)}</p> } }`, /expected 0 argument|argument/);
});

test("unbound names are rejected", () => {
  bad(page(`<p>{nope}</p>`), /unbound name 'nope'/);
});

/* ------------------------- ADTs ------------------------- */

test("exhaustive match on an ADT", () => {
  ok(`
type Colour = Red | Green | Blue
fn name(c: Colour) -> Str {
  match c { Red => "red", Green => "green", Blue => "blue" }
}
${page(`<p>{name(Red)}</p>`)}`);
});

test("non-exhaustive match is a type error", () => {
  bad(`
type Colour = Red | Green | Blue
fn name(c: Colour) -> Str { match c { Red => "red", Green => "green" } }
${page(`<p>{name(Red)}</p>`)}`, /non-exhaustive match on Colour: missing Blue/);
});

test("match arms must agree on a type", () => {
  bad(`
type C = A | B
fn f(c: C) -> Str { match c { A => "a", B => 1 } }
${page(`<p>{f(A)}</p>`)}`, /type mismatch/);
});

test("list patterns bind head and tail", () => {
  ok(`
fn sum(xs: List<Int>) -> Int {
  match xs { [] => 0, [x, ..rest] => x + sum(rest) }
}
${page(`<p>{sum([1,2,3])}</p>`)}`);
});

test("constructor arity is checked", () => {
  bad(`
type O = None | Some(Int)
fn f(o: O) -> Int { match o { None => 0, Some(a, b) => a } }
${page(`<p>{f(None)}</p>`)}`, /expects 1 pattern argument/);
});

test("unknown type names are rejected", () => {
  bad(`
type Colour = Red
fn f(c: Colour) -> Colour { c }
${page(`<p>{str(f(1))}</p>`)}`, /unknown type 'Red'/);
});

test("aliases resolve", () => {
  ok(`
type Id = Int
fn f(x: Id) -> Id { x }
${page(`<p>{f(1)}</p>`)}`);
});

/* ------------------------- traits ------------------------- */

test("trait dispatch resolves by type", () => {
  const r = ok(`
trait Show<a> { fn show(x: a) -> Str }
impl Show for Int { fn show(x: Int) -> Str { "i" } }
impl Show for Str { fn show(x: Str) -> Str { "s" } }
${page(`<p>{Show.show(1) + Show.show("x")}</p>`)}`);
  assert.equal(r.diagnostics.length, 0);
});

test("missing instance is a type error", () => {
  bad(`
trait Show<a> { fn show(x: a) -> Str }
${page(`<p>{Show.show(1)}</p>`)}`, /no instance of Show for Int/);
});

test("generic instances match any element", () => {
  ok(`
type Box<a> = Box(a)
trait Show<a> { fn show(x: a) -> Str }
impl Show<a> for List<a> { fn show(xs: List<a>) -> Str { "list" } }
${page(`<p>{Show.show([1,2,3])}</p>`)}`);
});

/* ------------------------- effects ------------------------- */

test("declared effect row must cover inferred effects", () => {
  bad(`
effect Server { fn now() -> Int }
fn f() -> Int ! {} { Server.now() }
${page(`<p>{f()}</p>`)}`, /unhandled effect\(s\) \{Server\}/);
});

test("effect operations require a declared effect", () => {
  ok(`
effect Clock { fn tick() -> Int }
provide Clock with { tick = fn() -> Int { 7 } }
${page(`<p>{Clock.tick()}</p>`)}`);
});

test("provider signature is checked", () => {
  bad(`
effect Clock { fn tick() -> Int }
provide Clock with { tick = fn() -> Str { "no" } }
${page(`<p>{Clock.tick()}</p>`)}`, /does not match its signature/);
});

/* ------------------------- placement ------------------------- */

test("a pure program is single-tier", () => {
  const r = ok(page(`<p>{"hi"}</p>`));
  assert.equal(r.diagnostics.length, 0);
});

test("client state never crosses", () => {
  const r = ok(`
effect Client { fn state<a>(init: a) -> Cell<a> }
fn main() -> Html {
  let n = Client.state(0);
  html { <div>{if (n.get() > 0) { <b>{"hot"}</b> } else { <i>{"cold"}</i> }}</div> }
}`);
  assert.equal(r.diagnostics.length, 0);
});

test("server authority creates a server-side cut", () => {
  const r = ok(`
effect Server { fn secret(k: Str) -> Str }
${page(`<p>{Server.secret("k")}</p>`)}`);
  assert.equal(r.diagnostics.length, 1);
  assert.match(r.diagnostics[0], /server-side block/);
  assert.match(r.server, /R\.serve\("cut1"/);
  assert.match(r.client, /R\.remote\("cut1"/);
});

test("client code calling a server op inside an if keeps the if on the client", () => {
  const r = ok(`
effect Server { fn secret(k: Str) -> Str }
effect Client { fn state<a>(init: a) -> Cell<a> }
fn main() -> Html {
  let on = Client.state(false);
  html { <div>{if (on.get()) { <p>{Server.secret("k")}</p> } else { <p>{"no"}</p> }}</div> }
}`);
  assert.equal(r.diagnostics.length, 1, "exactly the secret is cut out");
  assert.match(r.client, /R\.get/);              // condition stays on the client
  assert.match(r.server, /R\.serve\("cut1"/);    // branch body is served
});

test("server code can consume a client value (uplink)", () => {
  const r = ok(`
effect Server { fn now() -> Int }
effect Client { fn now() -> Int }
${page(`<p>{Server.now() - Client.now()}</p>`)}`);
  assert.equal(r.diagnostics.length, 2);
  assert.ok(r.diagnostics.some((d) => /client-side block/.test(d)));
  assert.match(r.client, /R\.serve/);
  assert.match(r.server, /R\.remote/);
});

test("server value used in client arithmetic is cut only once", () => {
  const r = ok(`
effect Server { fn now() -> Int }
fn main() -> Html {
  let t = Server.now();
  html { <p>{"a"}{t}</p> }
}`);
  assert.equal(r.diagnostics.length, 1);
});

test("a non-serializable value cannot cross", () => {
  bad(`
effect Server { fn log(m: Str) -> Unit }
fn main() -> Html {
  let f = fn(x: Int) -> Int { x };
  html { <p>{Server.log(str(f))}</p> }
}`, /cannot cross the boundary|functions are not serializable/);
});

/* ------------------------- html ------------------------- */

test("components take a record and render", () => {
  ok(`
fn Card(props: { title: Str, children: Html }) -> Html {
  html { <section><h2>{props.title}</h2>{props.children}</section> }
}
${page(`<Card title={"t"}><p>{"body"}</p></Card>`)}`);
});

test("event handlers must take an Event", () => {
  bad(page(`<button onClick={fn(x: Int) { 1 }}>{"x"}</button>`), /type mismatch/);
});

test("adt values in html holes render structurally", () => {
  const r = ok(`
type Weird = W(Int)
${page(`<p>{W(1)}</p>`)}`);
  assert.match(r.client, /R\.ctor\("W"/);
});

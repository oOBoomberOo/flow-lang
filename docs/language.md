# Flow — language guide

Flow is a web language with no client/server boundary in the source. You write functions,
data, markup and effects; the type checker works out which parts must run on the server (they
need server authority), which must run in the browser (they need the DOM), and cuts the
program between them.

```flow
effect Server { fn secret(name: Str) -> Str }
effect Client { fn state<a>(init: a) -> Cell<a> }

fn main() -> Html {
  let reveal = Client.state(false);
  html {
    <div class="card">
      <button onClick={fn(e: Event) { reveal.set(not reveal.get()) }}>{"toggle"}</button>
      {if (reveal.get()) {
        <p>{"server says: "}{Server.secret("flag")}</p>
      } else {
        <p>{"nothing to see here"}</p>
      }}
    </div>
  }
}
```

Nothing above says "client" or "server" about *code*. The `if` stays in the browser (its
branches are markup); the secret is fetched from the server, and only when the branch is
taken. `flow explain` prints exactly that:

```
cut cut1: reactive server-side block @24 deps=[] type=Str
```

---

## 1. Install and run

```
node bin/flow.mjs check   examples/boundary.flow     # type-check only
node bin/flow.mjs explain examples/boundary.flow     # + inferred boundary
node bin/flow.mjs build   examples/boundary.flow --out dist
node bin/flow.mjs run     examples/boundary.flow --port 4173 --secret flag=hunter2
```

Requires Node ≥ 22.6 (TypeScript type-stripping). No dependencies, no build step.

A program is a package: `flow.json` plus `src/**.flow`, entry `src/main.flow`.
Modules are linked at compile time and the standard library is available as
`std::list`, `std::option`, `std::math`, `std::string`, `std::html` — see
[`docs/modules.md`](modules.md). A single file without a manifest still works.
`extern` is reserved and rejected with an explicit message.

---

## 2. Values and functions

```flow
fn area(w: Float, h: Float) -> Float { w * h }

fn main() -> Html {
  let x = 1 + 2 * 3;            // Int
  let s = "a" + "b";            // Str (no implicit conversion)
  let f = 3.5;                  // Float
  let b = not (x == 0);         // Bool
  let t = (1, "two");           // tuple
  let xs = [1, 2, 3];           // List<Int>
  html { <p>{s}{x}{b}{f}</p> }
}
```

* Types are inferred; annotations are optional except on function parameters.
* Arithmetic requires matching numeric types — there is no implicit `Int`/`Float` coercion.
* Strings concatenate with `+`; `str(x)` renders any value.
* Functions are values: `fn(x: Int) -> Int { x + 1 }` is a lambda.

---

## 3. Blocks, `let`, and reactivity

```flow
fn main() -> Html {
  let n = Client.state(0);
  let doubled = n.get() * 2;         // derived: re-evaluates when n changes
  html {
    <div>
      <button onClick={fn(e: Event) { n.set(n.get() + 1) }}>{"+1"}</button>
      <p>{"n = "}{n.get()}{", doubled = "}{doubled}</p>
    </div>
  }
}
```

A block's value is its final expression. `let` bindings are **reactive thunks**: a binding that
reads a cell is recomputed when the cell changes, so `doubled` stays correct without you wiring
anything. A binding that performs a request/response cut (an effect call inside a handler) is
evaluated once, because a round trip yields a value, not a stream.

`mut` is accepted and treated as `let`; mutation is expressed with cells (`Cell<τ>`), which
exist only on the client.

---

## 4. ADTs and pattern matching

```flow
type Shape =
  | Circle(Float)
  | Rect(Float, Float)
  | Triangle(Float, Float, Float)

fn area(s: Shape) -> Float {
  match s {
    Circle(r) => 3.141592653589793 * r * r,
    Rect(w, h) => w * h,
    Triangle(a, b, _) => 0.5 * a * b,
  }
}
```

* `type T = A | B(x) | C(x, y)` declares a sum type. Constructors are ordinary functions for
  the arity they declare.
* `match` is exhaustive: leaving out `Triangle` is a compile error.
  ```
  non-exhaustive match on Shape: missing Triangle
  ```
* Patterns: `_`, binders, literals, `Ctor(…)`, tuples `(a, b)`, records `{ x: a }`, lists
  `[]`, `[x, ..rest]`.
* Constructors are JSON-shaped at runtime (`{ $: "Circle", args: [r] }`), which is why they can
  cross the boundary.

Record types:

```flow
type Money = { cents: Int, currency: Str }
let m = { cents: 1250, currency: "USD" };   // record literal
m.cents                                      // field access
```

---

## 5. Traits

```flow
trait Describe<a> {
  fn describe(x: a) -> Str
}

impl Describe for Int  { fn describe(x: Int) -> Str { "Int(" + str(x) + ")" } }
impl Describe for Str  { fn describe(x: Str) -> Str { "\"" + x + "\"" } }
impl Describe<a> for List<a> {
  fn describe(xs: List<a>) -> Str { "List of " + str(len(xs)) }
}

fn main() -> Html {
  html { <p>{Describe.describe(42)}{Describe.describe([1,2,3])}</p> }
}
```

* Dispatch is static: the instance is chosen by matching the first argument's type, and the
  call compiles to a direct function call.
* Generic instances (`for List<a>`) match any element type.
* A missing instance is a compile error: `no instance of Describe for Bool`.
* Methods are called qualified (`Describe.describe(x)`) or unqualified if the name is unique
  (`describe(x)` — resolved through the method index).

---

## 6. Effects are capabilities

Declare:

```flow
effect Server {
  fn now() -> Int
  fn secret(name: Str) -> Str
  fn log(msg: Str) -> Unit
}

effect Audit {
  fn record(msg: Str) -> Unit
}
```

Provide:

```flow
provide Audit with {
  record = fn(msg: Str) -> Unit { Server.log(msg) }
}
```

Call:

```flow
Audit.record("hello")      // placed wherever the provider lives
```

Rules:

1. **A call requires a provider.** Without one, it is a type error.
2. **The provider's placement decides where the call runs.** `record` uses `Server.log`, so
   `Audit` is server-placed, so every `Audit.record` call is a server computation — even when
   written inside a client event handler.
3. **The provider is type-checked** against the effect signature.
4. **Rows are inferred.** You only write `! {…}` when you want to pin an upper bound:
   ```flow
   fn f() -> Int { Server.now() }          // inferred ! {Server}
   fn g() -> Int ! {} { Server.now() }     // error: unhandled effect(s) {Server}
   ```

---

## 7. HTML and events

```flow
html {
  <div class="card">
    <h1>{"Title"}</h1>
    <p>{"count: "}{n.get()}</p>
    <button onClick={fn(e: Event) { n.set(n.get() + 1) }}>{"+1"}</button>
  </div>
}
```

* `{ … }` is a **hole**: an arbitrary expression rendered in place. `Html` nests; primitives
  render as text; anything else renders structurally (`Circle(2.0)` → `Circle(2)`).
* Attributes: `class="card"` (static) or `class={expr}` (reactive).
* `on<Event>` binds a listener. The handler receives an `Event`:
  `onClick`, `onInput`, `onSubmit`, `onChange`, …
* Boolean attributes: `disabled={flag}` sets/removes the attribute.

**Components** are functions taking one record and returning `Html`. Tags beginning with an
upper-case letter are component calls; children become the `children` field:

```flow
fn Card(props: { title: Str, children: Html }) -> Html {
  html { <section><h2>{props.title}</h2>{props.children}</section> }
}

html { <Card title={"Hi"}><p>{"body"}</p></Card> }
```

A bare element is also an expression, which is what makes conditional markup possible:

```flow
{if (cond) { <p>{"yes"}</p> } else { <p>{"no"}</p> }}
```

---

## 8. The boundary, worked through

### 8.1 Client code reads a server value

```flow
fn main() -> Html {
  let t = Server.now();
  html { <p>{t}</p> }
}
```

`Server.now` is server-placed; the hole is client-placed; the value crosses down as a reactive
cut.

### 8.2 Server code reads a client value

```flow
{"skew: "}{Server.now() - Client.now()}
```

The subtraction belongs to the server (its left operand is authoritative there), so the client
clock crosses *up*:

```
cut cut2: reactive server-side block @28 deps=[]   type=Int
cut cut3: reactive client-side block @28 deps=[]   type=Int
```

### 8.3 An `if` in client code runs a server block

```flow
{if (reveal.get()) {
  <p>{"server says: "}{Server.secret("flag")}</p>
} else {
  <p>{"nothing to see here"}</p>
}}
```

The `if` stays on the client because both branches produce `Html`, which cannot exist on the
server. The secret is cut out as its own server node, and — because the branch is only built
when taken — the server is not called at all until you toggle.

### 8.4 Effects inside handlers become round trips

```flow
onClick={fn(e: Event) {
  clicks.set(clicks.get() + 1);
  Audit.record("clicked " + str(clicks.get()));
}}
```

`Audit.record` is server-placed but sits in an event handler, so the compiler emits
`await R.call("cut1", { clicks })`. If the argument itself needs a client computation, the
server calls *back*:

```
client  →  await R.call("cut1", {clicks: 1})
server  →  await R.call("cut2", {clicks: 1})     // needs the client to format the message
client  →  "clicked 1"
server  →  Server.log("clicked 1")
```

One expression, two crossings, no annotations.

---

## 9. What gets emitted

```
dist/
  app.js                    client program (ES module)
  server.js                 server program (ES module)
  runtime/
    client.js dom.js        shipped to the browser
    core.js server.js       shared reactive core + server transport
    server-runtime.js
```

* `R.serve(id, fn)` registers a cut that this side owns.
* `R.remote(id, deps)` returns a signal backed by a cut on the other side.
* `R.call(id, args)` awaits a request/response cut.
* Transport: Server-Sent Events down, `POST /__flow/msg` up. Both sides implement both halves.

`flow build` output is plain ES modules; you can serve it from anything.

---

## 10. Diagnostics

```
$ flow check bad.flow
bad.flow:12:14 — [E_TYPE] non-exhaustive match on Shape: missing Triangle
  in fn area

$ flow check bad.flow
bad.flow:9:20 — [E_TYPE] type mismatch: Int vs Str
  in argument 1
  in fn main

$ flow check bad.flow
bad.flow:7:3 — [E_SPLIT] value 'f' of type (Int) -> Int cannot cross the server
boundary: functions are not serializable across the boundary
```

Error codes: `E_LEX`, `E_PARSE`, `E_TYPE`, `E_SPLIT`, `E_ENTRY`.

`flow explain` reports, for every function, its inferred placement and effect row, plus every
cut with its mode, line, dependencies and type.

---

## 11. Modules, packages and the standard library

A module is a file; a package is a directory with `flow.json`. `pub` marks what a
module exports.

```flow
use app::util::{Priority, describe}
use std::list::{map, range}
use flow-charts::bar::Chart
```

```bash
flow install          # resolve + vendor deps into flow_modules/, write flow.lock
flow add flow-time    # add the best matching version from the registry
```

The standard library ships as modules: `std::list`, `std::option`, `std::math`,
`std::string`, `std::html`. Full reference: [`docs/modules.md`](modules.md).

---

## 12. Limits of 0.1

Honest list, so you do not discover them by surprise:

* `extern` is rejected (no native escapes); modules and packages are supported (see docs/modules.md).
* Traits dispatch on one parameter; no superclasses or instance constraints.
* No effect handlers (no `handle … with …`); effects are capabilities.
* No `String` interpolation — use `+`.
* Effect rows over-approximate through unification (may place extra code on the server).
* Reactive cuts re-run their body when inputs change: keep side effects in handler cuts.
* One logical session per server; no auth model.
* `@client`/`@server` type annotations parse but do not affect inference.

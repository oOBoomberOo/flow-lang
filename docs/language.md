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
node bin/flow.mjs watch   examples/boundary.flow     # re-check on every save
node bin/flow.mjs watch   examples/boundary.flow --run --port 4173
node bin/flow.mjs build   examples/boundary.flow --out dist
node bin/flow.mjs run     examples/boundary.flow --port 4173 --secret flag=hunter2
```

`flow watch` watches the package directory (sources, `flow.json`, `flow.lock`),
rebuilds after a short debounce, and keeps running when a build fails. Add
`--run` to rebuild and restart the server on every successful change.

Progress goes to stderr (`Checking`, `Compiling`, `Finished in 0.12s`) and honours
`--quiet`, `NO_COLOR` and `--color always|never`.

Requires Node ≥ 22.6 (TypeScript type-stripping). No dependencies, no build step.

A program is a package: `flow.json` plus `src/**.flow`, entry `src/main.flow`.
Modules are linked at compile time and the standard library is available as
`std::list`, `std::option`, `std::math`, `std::random`, `std::string`, `std::html`,
`std::log`, `std::time`, `std::http`, `std::net`, `std::fs`, `std::state`, `std::exn`, `std::ref`, `std::monad`, `std::fn` — see [`docs/modules.md`](modules.md). A single
file without a manifest still works. Host access goes through explicitly `unsafe`
FFI bindings (§12).

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

* Types are inferred; function declarations may annotate parameters, while lambdas can omit
  them (`fn(x) => x + 1`) and infer from the expected function type.
* Arithmetic requires matching numeric types — there is no implicit `Int`/`Float` coercion.
* Strings concatenate with `+`; `str(x)` renders any value.
* Functions are values and **curry**: `add(1)` partially applies, `add(1)(2)` calls the result.
* Chain with `|>` (data first), or apply with `<|` / `$`:

```flow
fn add(a: Int, b: Int) -> Int { a + b }
fn inc(x: Int) -> Int { x + 1 }

let f = add(1);                 // (Int) -> Int
let n = f(2);                   // 3
let m = 1 |> inc |> add(1);     // add(inc(1)) = 3
let k = inc $ 1 + 1;            // inc(2) = 3
```

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

### Cell sugar

Reads and writes have short forms that lower to `CellOps.get`/`set` and keep the
`Client` placement:

```flow
let n = Client.state(0);
n.value = n.value + 1;    // set(n, get(n) + 1)
n += 2;                   // update: set(n, get(n) + 2)
n -= 1; n *= 3; n /= 2;
n++; n--;                 // Int cells
n.update(fn(x: Int) -> Int { x + 10 });

html { <p>{str(n.value)}</p> }   // reading a cell recomputes reactively
```

* `cell.value` reads the cell; using `.value` on a non-`Cell` is an error.
* `cell.value = e` writes it, and the value must match the cell's element type.
* `+=` works for `Int`, `Float` and `Str`; `-=`, `*=`, `/=` work for `Int`/`Float`;
  `/=` on `Int` truncates; `++`/`--` are `Int`-only.
* The long forms `cell.get()` and `cell.set(value)` keep working.

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

A generic function can require an instance with a trait bound:

```flow
fn render<a: Describe>(x: a) -> Str { Describe.describe(x) }

fn describeAll<a: Describe>(xs: List<a>) -> Str {
  match xs {
    [] => "",
    [x, ..rest] => Describe.describe(x) + ";" + describeAll(rest),
  }
}

impl Describe<a> for List<a> where a: Describe {
  fn describe(xs: List<a>) -> Str { describeAll(xs) }
}
```

Bounded parameters are compiled as hidden dictionary parameters. The call site
supplies the instance (`render(42)` passes the `Describe<Int>` dictionary), and a
bounded generic instance closes over the dictionary for its element type. Multiple
bounds are allowed (`<a: Describe + Monoid>`). Calling a trait method on a type
variable without the matching bound is an error:

```
no instance of Describe for type variable t; add a trait bound such as <a: Describe>
```

A nullary trait method (such as `Monoid.empty()`) uses the unique instance when
the trait has exactly one; with several instances it is an error unless a value
or annotation determines the type.

A trait parameter may also range over a **type constructor** (a higher-kinded
parameter). Apply it to type arguments with `f<a>`, and write instances at the
constructor:

```flow
trait Functor<f> {
  fn map<a, b>(value: f<a>, mapper: (a) -> b) -> f<b>
}

impl Functor for List {
  fn map<a, b>(value: List<a>, mapper: (a) -> b) -> List<b> {
    match value {
      [] => [],
      [x, ..rest] => concat([mapper(x)], map(rest, mapper)),
    }
  }
}

impl Functor for Option {
  fn map<a, b>(value: Option<a>, mapper: (a) -> b) -> Option<b> {
    match value { None => None, Some(x) => Some(mapper(x)) }
  }
}
```

Dispatch uses the head constructor of the constructor-typed argument:
`Functor.map([1, 2], …)` selects the `List` instance, while
`Functor.map(Some(1), …)` selects `Option`. Type applications are normalized
after unification, so `f<b>` becomes `List<b>` or `Option<b>`.

### Monads

`std::monad` declares `Monad<f>` with `bind` and `map`, and instances for `Option`
and `List`. `>>=` and `do { … }` are sugar over `bind`:

```flow
use std::monad::{Monad}

let chained = Some(2) >>= fn(x: Int) -> Option<Int> { Some(x + 1) };

let option = do {
  x <- Some(2);
  y <- Some(3);
  Some(x + y)                 // Some(5)
};

let list = do {
  x <- [1, 2];
  y <- [10, 20];
  [x + y]                     // [11, 21, 12, 22]
};

Some(2).map(fn(x: Int) -> Int { x + 1 })   // Some(3)
```

`do { … }` desugars to nested `>>=` applications; `let` bindings inside it stay
ordinary lets. The instance is chosen from the first bound value's type, so
mixing `Option` and `List` in one block is a type error. `>>=` requires the
`Monad` trait to be imported (which also links the instances).

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

A `provide` block is the **capability handler** for an effect: it supplies the
implementation that runs when the effect is called. The provider's placement
determines where the call runs.

An effect can pin its own placement, which is what the standard library does for
the built-in capabilities (`std::prelude` declares `Server @ server`,
`Client @ client`, `Store @ server`). A provider still wins when there is one:

```flow
effect Client @ client {
  fn state<a>(init: a) -> Cell<a>
}
```

`@ neutral` means the effect has no fixed side: a call follows the placement of
its arguments and callbacks. `std::net` declares `Net @ neutral`, so the same
request API can run on the client or the server depending on the callback.

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

1. **A call requires a handler.** It must be supplied by a file-level `provide` or an
   enclosing `handle` expression (see below).
2. **The provider's placement decides where the call runs.** `record` uses `Server.log`, so
   `Audit` is server-placed, so every `Audit.record` call is a server computation — even when
   written inside a client event handler.
3. **The provider is type-checked** against the effect signature.
4. **Rows are inferred.** You only write `! {…}` when you want to pin an upper bound:
   ```flow
   fn f() -> Int { Server.now() }          // inferred ! {Server}
   fn g() -> Int ! {} { Server.now() }     // error: unhandled effect(s) {Server}
   ```

### Local capability handlers

`provide` is file-level. A `handle Effect with { … } { body }` expression installs
a **scoped** capability handler for the body, like Koka's `with` handlers:

```flow
effect Local @ client {
  fn ping(msg: Str) -> Str
}

fn main() -> Html {
  let msg = handle Local with {
    ping = fn(msg: Str) -> Str { "pong " + msg }
  } {
    Local.ping("x")
  };
  html { <p>{msg}</p> }
}
```

* The handler is active only while `body` runs; nested handlers restore the
  previous provider when they finish.
* A local handler overrides the operations it supplies and falls back to a
  file-level `provide` for the rest. Without a global provider, it must supply
  every operation.
* The handled effect is removed from the body's effect row; the handler
  operations' own effects remain. The body sees the handler's placement.
* Handler operations are capability implementations, not continuations: there is
  no `resume`. The handler runs the operation and the call returns normally.

### Algebraic effects

An `algebraic effect` is not a capability: its operations **suspend** the caller and
return control to the nearest `handle`. Handler operations receive a `resume`
continuation, the way algebraic effect handlers do in Koka.

```flow
algebraic effect State {
  fn get() -> Int
  fn put(x: Int) -> Unit
}

fn counter() -> Int ! {State} {
  State.put(State.get() + 1);
  State.get()
}

fn withState<a>(init: Int, action: () -> a ! {State}) -> a {
  let cell: Ref<Int> = newRef(init);           // std::ref
  handle State with {
    get = fn() -> a { resume(cell.get()) },
    put = fn(x: Int) -> a { cell.set(x); resume(()) }
  } {
    action()
  }
}
```

Calling an operation suspends the body; the handler runs **with a `resume`
continuation**. `resume(v)` continues the body from the operation site, with `v`
as the operation's result, and returns what the rest of the body returns.

Rules:

1. **A handler operation returns the handled result.** Every operation handler in
   an algebraic `handle` must produce the same type as the `handle` expression
   itself, because its return value is that expression's value.
2. **Not resuming aborts.** A handler that returns without calling `resume`
   abandons the rest of the body and supplies the result — this is how errors and
   defaults are implemented (`std::exn`).
3. **Handlers are deep.** Operations performed by the continuation are handled by
   the same handler; nested handlers shadow outer ones and restore afterwards.
4. **One-shot.** `resume` may be called once; a second call is a runtime error.
5. **Forwarding.** An operation of a different algebraic effect is forwarded to
   the enclosing handler.
6. **Rows.** The handled effect leaves the body's row; operation handlers'
   effects stay. `! {State}` on a function says it may suspend at `State`.
7. **No placement.** Algebraic effects are neutral: they run wherever the handler
   runs. They cannot cross a tier cut, and cannot be performed in lazy slots
   (HTML holes and attributes, event listeners, reactive blocks, providers,
   components). Wrap that work in `handle … with … { … }` inside an eager
   expression, or move it out of the lazy slot.
8. **No `provide`.** A file-level provider supplies a capability implementation;
   an algebraic effect has to be handled (`provide Exn with …` is a type error).
9. **Effectful callbacks need a row.** A function that may suspend can only be
   passed to a parameter whose declared type admits the effect, e.g.
   `action: () -> a ! {State}`. Passing it to `List.map` (whose parameter has no
   row) is a type error rather than a runtime surprise.

The standard library ships two of them: `std::state` (`State` with
`withState`/`runState`/`execState`) and `std::exn` (`Exn` with
`attempt`/`recoverWith`/`recover`).

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

A component call in a static position is built once. Put it in a hole to make it
re-render when its inputs change:

```flow
{<Counter n={n.get()} />}
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

Placement is inferred, but a type may carry an explicit `@client` / `@server`
intent:

```flow
fn view(x: Str) -> Html@client { html { <p>{x}</p> } }
fn save(x: Str@server) -> Unit { Server.log(x) }
fn main() -> Html {
  let secret: Str@server = Server.secret("k");
  html { <p>{str(save(secret))}</p> }
}
```

These annotations are checked, not inferred: a return must agree with its body,
a direct call argument must agree with its parameter, and a `let` value must
agree with its binding. A neutral value is compatible with either side; a
`cross` expression contains a cut and is also allowed. The compiler still
decides every cut; an annotation only rejects a mismatch.

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

Flow renders errors like rustc: an error code, the source location, the offending
line with a caret underline, and a one-line summary. Every error in the package is
reported, not just the first.

```
$ flow check bad.flow
    Checking bad.flow
error[E_TYPE]: unknown type 'str'
 --> bad.flow:1:11
  |
1 | fn f() -> str { "hello" }
  |           ^^^
  |
  = help: 'str' is a value, not a type; did you mean 'Str'?
error: could not check `bad.flow` due to 1 previous error
```

```
$ flow check bad.flow
    Checking bad.flow
error[E_TYPE]: right operand of '+' (left is Int): expected Int, got Str
 --> bad.flow:4:40
  |
4 | fn main() -> Html { html { <p>{1 + "x"}</p> } }
  |                                        ^^^
  |
  = note: in argument 1
  = note: in fn main
error: could not check `bad.flow` due to 1 previous error
```

The process exits 1 on failure and 0 on success. Colour is enabled on a TTY and
can be forced or disabled with `--color always` / `--color never` (or `NO_COLOR`).
`--quiet` suppresses the progress lines.

Diagnostics point at the expression that is wrong, not at the enclosing function:

* a returned value is checked against the declared return type at the **tail
  expression** (`return type mismatch …`);
* `if` branches report the offending `else`, match arms the offending arm, call
  arguments the argument (with `in argument N`), and `let` annotations the value;
* an undeclared lowercase type name is an error (`unknown type 'str'` with a
  suggested fix) instead of silently becoming a fresh type variable — type
  parameters must be declared (`fn f<a>(x: a)`);
* unknown effect labels and trait bounds, effect row variables, duplicate
  declarations/parameters/fields/impls, wrong builtin type arity, and impl methods
  that do not exist or do not match the trait signature are rejected;
* errors raised inside a function keep their original line/column (the
  `in fn …` wrapper only adds context).

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

A name can also be used through its full path, without a `use`:

```flow
let n = std::list::length(xs);
let o = std::option::Some(1);
let req: std::http::RequestObject = Request.current();
handle std::state::State with { … } { … }
```

Paths work for functions, constructors, effects, traits and types; the linker
loads the module on demand and still enforces `pub`. Completion offers modules
after `std::`, members after `std::list::`, and unimported names with an import
insertion.

```bash
flow install          # resolve + vendor deps into flow_modules/, write flow.lock
flow add flow-time    # add the best matching version from the registry
```

The standard library ships as modules: `std::list`, `std::option`, `std::math`,
`std::random`, `std::string`, `std::html`, `std::log`, `std::time`, `std::http`, `std::net`, `std::fs`, `std::state`, `std::exn`, `std::ref`, `std::monad`, `std::fn`.
Full reference: [`docs/modules.md`](modules.md).

---

## 12. Native access (unsafe FFI)

Anything that must touch the host — the console, the clock, `Math` — is declared
explicitly and marked `unsafe`. This is how the standard library is built: the
compiler no longer emits primitives for logging, timing or arithmetic.

```flow
unsafe extern js fn console_log(msg: Str) -> Unit = "console.log"
unsafe extern js fn sqrt(x: Float) -> Float = "Math.sqrt"
unsafe extern js fn upper(s: Str) -> Str = "@toUpperCase"
unsafe extern js fn size(s: Str) -> Int = "#length"
```

Targets:

| form | meaning | example |
|---|---|---|
| `"Path.to.fn"` | global function, called with its receiver; a non-function reads as a constant when the binding is nullary | `"Math.floor"`, `"Math.PI"` |
| `"@method"` | method on the first argument | `"@concat"` → `xs.concat(ys)` |
| `"#property"` | property of the first argument | `"#length"` → `xs.length` |
| `"#index"` | element of the first argument | `xs[i]` |

Rules:

* The declaration **must** say `unsafe`; `extern` alone is a parse error.
* Only the `js` target exists in 0.1.
* An FFI function is **placement-neutral**: it runs wherever it is called, so
  `Date.now` is the client clock on the client and the server clock on the
  server. If you want authority, call it behind a capability:
  ```flow
  provide Server with { now = fn() -> Int { date_now() } }
  ```
* FFI calls are **not sandboxed** and bypass the serializer. Nothing stops you
  from mutating host state; that is what `unsafe` is admitting.

`std::log`, `std::time` and `std::math` are thin wrappers over exactly these
bindings:

```flow
use std::log::{info, value}
use std::time::{nowMs, duration}
use std::math::{sqrt, floor, pow}
```

The compiler registers no callable primitives. `std::prelude` declares `Option`,
`Server` / `Client` / `Store`, `CellOps`, and the list, string, conversion and
equality helpers as ordinary Flow over these bindings; the runtime only exposes
raw host primitives (`__flow.show`, `__flow.eq`, `__flow.get`, `__flow.set`, and
`__flow.host.*`).

---

## 13. Limits of 0.1

Honest list, so you do not discover them by surprise:

* FFI targets are JavaScript only; FFI is unsafe and unchecked at the boundary.
* Traits dispatch on one parameter; supertraits and associated types are not supported.
  Trait bounds, bounded generic instances and higher-kinded type parameters are supported
  (`fn f<a: Show>`, `impl Show<a> for List<a> where a: Show`, `trait Functor<f>`).
* Local capability handlers are scoped providers. Algebraic effects have real
  `resume` continuations, but handlers are **one-shot**: `resume` may be called
  once (multi-shot/nondeterminism handlers are not supported).
* No `String` interpolation — use `+`.
* Reactive cuts re-run their body when inputs change: keep side effects in handler cuts.
* One logical session per server; no auth model.

Placement annotations are enforced: `τ@client` / `τ@server` on a function
return, parameter or `let` binding is checked against inference, and direct call
arguments are checked against annotated parameters. Effect rows are
per-instantiation, so a polymorphic function used with a server callback at one
call site is not forced server-side at another. See
[`docs/type-system.md`](type-system.md) §8.

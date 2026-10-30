# Flow — modules, packages, and the standard library

Flow links modules at compile time. That is not laziness: the tier split is a
whole-program analysis (as in Ur/Web and Electric), so the compiler must see every
declaration before it can cut anything. Modules are therefore a *source*
convenience that disappears into one typed tree.

---

## 1. A package

```
myapp/
  flow.json
  flow.lock
  flow_modules/          # vendored dependencies (installed)
  src/
    main.flow            # entry: must define fn main() -> Html
    util.flow
    deep/nest.flow
```

`flow.json`:

```json
{
  "name": "myapp",
  "version": "0.1.0",
  "dependencies": {
    "flow-charts": "^1.0.0",
    "flow-time": "^1.2.0",
    "local-thing": "path:../local-thing"
  }
}
```

Rules:

* `name` must match `[a-z][a-z0-9_-]*` (hyphens are fine; they become a path segment).
* `version` is semver `x.y.z`.
* A dependency is either a **semver range** resolved from the registry, or `path:…`.
* The entry module is always `src/main.flow`.

A single file with no `flow.json` still works: it is treated as a one-module package
named `main`.

---

## 2. Modules

A module is one `.flow` file. Its id is derived from its path:

| File | Module id |
|---|---|
| `src/main.flow` | `myapp::main` |
| `src/util.flow` | `myapp::util` |
| `src/deep/nest.flow` | `myapp::deep::nest` |

### Importing

```flow
use myapp::util::{Priority, describe}     // several names
use myapp::util::describe                 // one name
use myapp::util::describe as describeIt   // renamed
use std::list::{map, filter, range}
use flow-charts::bar::Chart
```

* `use` paths are `package :: module :: … :: name`.
* Hyphenated package names work: `use flow-charts::bar::Chart`.
* Keyword-like module names work too: `use std::html::Card`.
* Glob imports (`*`) are parsed and rejected — be explicit.

Names can be referenced by their full path without importing them:

```flow
let n = std::list::length(xs);
let o = std::option::Some(1);
let req: std::http::RequestObject = Request.current();
handle std::state::State with { … } { … }
match o { std::option::Some(x) => x, std::option::None => 0 }
```

The module is loaded on demand, `pub` is still required, and the path appears
verbatim in diagnostics if it is unknown or private. This works for functions,
constructors (including patterns), effects, traits and types; the editor does not
need a `use` either, and completes module segments after `std::`.

### Visibility

Only `pub` declarations can be imported:

```flow
pub type Priority = | Low | High
pub fn describe(p: Priority) -> Str { … }
fn secretSauce() -> Str { "sssh" }      // private to this file
```

```
$ flow check src/main.flow
src/main.flow:1:26 — [E_MODULE] 'secretSauce' is private in myapp::util;
  mark it 'pub' to export it
```

### Constructors travel with their type

`use myapp::util::Priority` imports the type **and** its constructors, so
`Low`/`High` are in scope. Importing an ADT by a different alias does not rename
its constructors; import those explicitly if you need to.

### Name collisions

Every declaration gets one global name. If two modules export the same simple name,
*both* are qualified deterministically (`map$std$list`, `map$std$option`), so neither
silently shadows the other. Aliasing is the way to keep both usable in one file:

```flow
use std::list::map
use std::option::map as mapOption
```

---

## 3. Standard library

`std` is resolved by the compiler (no manifest entry, no install step).

### `std::prelude` — injected into every module

These names are available without an import. A module's own declarations and
imports take precedence over the prelude.

| | |
|---|---|
| types | `Option<a> = None \| Some(a)` - a plain ADT declared in Flow, not a compiler builtin |
| effects | `Server`, `Client`, `Store` - declared **and provided** here, not by the compiler; the runtime only exposes raw host primitives |
| cells | `CellOps.get` / `CellOps.set` / `CellOps.update` - std trait methods over the host's `__flow.get` / `__flow.set` primitives, declaring the `Client` effect. Source sugar: `cell.value`, `cell.value = e`, `cell += e`, `cell++` |
| lists | `len`, `isEmpty`, `push`, `head`, `tail`, `concat`, `reverse` |
| strings | `str`, `trim`, `upper`, `lower`, `split`, `replace`, `contains`, `join`, `chars`, `strLen` |
| numbers | `int`, `float`, `eq`, `neq` |

The prelude is ordinary Flow: every primitive is an `unsafe extern js` binding to
the host (`#length`, `@toUpperCase`, `__flow.show`, …). Nothing here is emitted by
the compiler.

### `std::list`

```flow
use std::list::{map, filter, fold, forEach, headOf, take, drop, range, zip, any, all, length}
```

| function | type |
|---|---|
| `map` | `(List<a>, (a) -> b) -> List<b>` |
| `filter` | `(List<a>, (a) -> Bool) -> List<a>` |
| `fold` | `(List<a>, b, (b, a) -> b) -> b` |
| `forEach` | `(List<a>, (a) -> b) -> Unit` |
| `take` / `drop` | `(List<a>, Int) -> List<a>` |
| `range` | `(Int) -> List<Int>` |
| `zip` | `(List<a>, List<b>) -> List<(a, b)>` |
| `any` / `all` | `(List<a>, (a) -> Bool) -> Bool` |
| `sortBy` | `(List<a>, (a, a) -> Int) -> List<a>` |
| `sortInts` / `sortStrings` | `(List<Int>) -> List<Int>` / `(List<Str>) -> List<Str>` |
| `contains` / `indexOfItem` | `(List<a>, a) -> Bool` / `(List<a>, a) -> Int` |

`sortBy` copies the list and calls the host's `Array.prototype.sort` through the
FFI (`unsafe extern js … = "@sort"`); no compiler intrinsic is involved.

### `std::option`

`map`, `withDefault`, `isSome`, `isNone`, `toList` - all over the prelude
`Option<a>`.

### `std::math`

Int helpers in Flow: `abs`, `minInt`, `maxInt`, `clamp`, `sum`, `product`, `sign`, `div`, `mod`.
Float primitives through the FFI: `sqrt`, `pow`, `floor`, `ceil`, `round`, `absF`,
`minF`, `maxF`, `logF`, `expF`, `sinF`, `cosF`, `random`, `pi`, `e`.

### `std::random`

`int(lo, hi)`, `bool()`, `chance(percent)`, `pick(xs)` — uniform helpers built
on the FFI-backed `std::math::random()`.

### `std::http`

Request and routing **effect capabilities**, plus easy routing:

```flow
use std::http::{get, post, Router, Request, RequestObject, Response, htmlResponse}
```

| | |
|---|---|
| `Request` effect | `Request.current() -> RequestObject`; the current server request |
| `Router` effect | `Router.mount(routes)`, `Router.notFound(handler)`; provided by the host |
| route helpers | `get`, `post`, `put`, `patch`, `del`, `route` |
| responses | `textResponse`, `htmlResponse`, `jsonResponse`, `withStatus`, `withHeader`, `redirect`, `notFoundResponse` |
| request helpers | `queryParam`, `pathParam`, `header` |
| handler | `dispatch(routes, request)` — pure in-language dispatch |

A program opts in with `fn routes() -> Unit { Router.mount([...]) }`; the host
calls it at startup and serves matching HTTP requests. Full reference:
[`docs/http.md`](http.md).

### `std::net`

Placement-neutral network requests through the `Net @ neutral` effect capability:

```flow
use std::net::{request, get, post, put, del, getText, NetResult}
```

| function | type |
|---|---|
| `request` | `(Str, Str, List<(Str, Str)>, Str, (NetResult) -> Unit) -> Unit` |
| `get` / `del` | `(Str, (NetResult) -> Unit) -> Unit` |
| `post` / `put` | `(Str, Str, (NetResult) -> Unit) -> Unit` |
| `getText` | `(Str, (Option<Str>) -> Unit) -> Unit` |

`NetResult = { ok: Bool, status: Int, body: Str, error: Str }`. The host
provides `fetch` on both sides (browser or Node), so the callback decides where
the work runs: a callback using client state places the request on the client;
one using server capabilities places it on the server. The API is callback-based
because `fetch` is asynchronous.

### `std::state` — algebraic state

`State` is an **algebraic effect**: `get`/`put` suspend the caller, and the
handler resumes at the operation site. State lives in a neutral `Ref` inside the
handler, so the same code runs on the client or the server.

```flow
use std::state::{withState, runState, execState, State}

fn counter() -> Int ! {State} {
  State.put(State.get() + 1);
  State.get()
}

withState(0, fn() -> Int { counter() })   // 1
runState(0, fn() -> Int { counter() })    // (1, 1)
```

| function | type |
|---|---|
| `withState` | `(Int, () -> a ! {State}) -> a` |
| `runState` | `(Int, () -> a ! {State}) -> (a, Int)` |
| `execState` | `(Int, () -> a ! {State}) -> Int` |

Handlers:

```flow
handle State with {
  get = fn() -> a { resume(cell.get()) },
  put = fn(x: Int) -> a { cell.set(x); resume(()) }
} { action() }
```

### `std::exn` — abortive algebraic effects

`Exn` suspends at `fail`; a handler may resume with a value (`recover`) or return
a fallback, aborting the rest of the computation (`attempt`, `recoverWith`).

```flow
use std::exn::{attempt, recoverWith, recover, fail, Exn}

fn risky(n: Int) -> Int ! {Exn} {
  if (n < 0) { fail("negative") } else { n * 2 }
}

attempt(0, fn() -> Int { risky(21) })                      // 42
attempt(-1, fn() -> Int { risky(-3) })                     // -1
recoverWith(fn(m: Str) -> Int { 0 }, fn() -> Int { risky(-3) })  // 0
recover(99, fn() -> Int { fail("soft") })                  // 99
```

| function | type |
|---|---|
| `fail` | `(Str) -> a ! {Exn}` |
| `attempt` | `(a, () -> a ! {Exn}) -> a` — abort with the fallback |
| `recoverWith` | `((Str) -> a, () -> a ! {Exn}) -> a` |
| `recover` | `(a, () -> a ! {Exn}) -> a` — resume at the failure point |

### `std::fn` — combinators for curried code

```flow
use std::fn::{identity, constant, flip, compose, pipe, apply, applyTwice}
```

| function | type |
|---|---|
| `identity` | `(a) -> a` |
| `constant` | `(a, b) -> a` |
| `flip` | `((a, b) -> c) -> (b, a) -> c` |
| `compose` | `((b) -> c, (a) -> b) -> (a) -> c` — `f(g(x))` |
| `pipe` | `((a) -> b, (b) -> c) -> (a) -> c` — `g(f(x))` |
| `apply` | `(a, (a) -> b) -> b` |
| `applyTwice` | `((a) -> a, a) -> a` |

```flow
let inc = add(1);
let f = compose(fn(x) => x + 1, fn(x) => x * 2);
let xs = [1, 2, 3] |> map(inc);
```

### `std::monad` — bind/do for Option and List

```flow
use std::monad::{Monad}
```

| member | type |
|---|---|
| `Monad<f>.bind` | `(f<a>, (a) -> f<b>) -> f<b>` |
| `Monad<f>.map` | `(f<a>, (a) -> b) -> f<b>` |
| instances | `impl Monad for Option`, `impl Monad for List` |
| `some` / `one` | `pure` helpers: `(a) -> Option<a>` / `(a) -> List<a>` |

Sugar:

```flow
let o = Some(2) >>= fn(x: Int) -> Option<Int> { Some(x + 1) };
let l = do { x <- [1, 2]; y <- [10, 20]; [x + y] };   // [11, 21, 12, 22]
Some(2).map(fn(x: Int) -> Int { x + 1 })              // Some(3)
```

`do { … }` desugars to nested `>>=`; `let` bindings inside stay ordinary lets. The
instance is chosen from the first bound value, so mixing `Option` and `List` is a
type error. Importing `Monad` links the instances.

### `std::ref` — a neutral mutable box

`Ref<a>` is a small mutable slot with no reactivity and no placement. It exists so
stateful algebraic handlers work on either side of the boundary.

```flow
use std::ref::{Ref, newRef, get, set, modify}
```

| function | type |
|---|---|
| `newRef` | `(a) -> Ref<a>` |
| `get` / `set` | `(Ref<a>) -> a` / `(Ref<a>, a) -> Unit` |
| `modify` | `(Ref<a>, (a) -> a) -> Unit` |

`Ref<a> = { get: () -> a, set: (a) -> Unit }`; the host implements it with a
closure (`__flow.host.refNew`).

### `std::fs`

Server-side filesystem access through the `Fs @ server` effect capability:

```flow
use std::fs::{
  readText, tryReadText, writeText, appendText, exists, listDir,
  makeDir, removeFile, removeDir, stat, tmpDir, FileInfo,
}
```

| function | type |
|---|---|
| `readText` | `(Str) -> Str` — throws if missing |
| `tryReadText` | `(Str) -> Option<Str>` |
| `writeText` / `appendText` | `(Str, Str) -> Unit` (UTF-8) |
| `exists` | `(Str) -> Bool` |
| `listDir` | `(Str) -> List<Str>` — sorted names |
| `makeDir` | `(Str) -> Unit` — recursive |
| `removeFile` / `removeDir` | `(Str) -> Unit` — `removeDir` is recursive |
| `stat` | `(Str) -> FileInfo` (`size`, `isDir`, `modified`) |
| `tmpDir` | `() -> Str` — OS temporary directory |

The server runtime provides `Fs` with Node's synchronous `fs` module. Calls are
server-placed; paths are server paths and are not sandboxed. The client bundle
never receives filesystem primitives.

### `std::log`

```flow
use std::log::{info, warn, error, debug, value}
```

`console.log` / `warn` / `error` / `debug` behind a typed wrapper, plus
`value("label", x)` which prints `label = str(x)`.

### `std::time`

```flow
use std::time::{nowMs, nowPrecise, elapsedSince, since, hms, duration}
```

`Date.now()` and `performance.now()` behind typed functions, plus `hms` and
`duration` formatting.

### `std::string`

Composed helpers over the prelude primitives (`trim`, `upper`, `lower`, `split`,
`replace`, `contains`, `join`, `chars`, `len`): `length`, `isEmptyStr`, `joinWith`,
`repeat`, `padLeft`, `words`, `startsWith`, `capitalize`, `take`/`drop`.

### `std::html`

`classNames(xs)`, `text(s)`, and components: `Card`, `Badge`, `Page`, `Button`,
`Items`.

```flow
use std::html::{Card, Badge}
use std::list::map

fn main() -> Html {
  html {
    <Card title={"Team"}>
      <Badge label={"beta"} />
      {map([1, 2, 3], fn(n: Int) -> Html { html { <p>{str(n)}</p> } })}
    </Card>
  }
}
```

Everything in `stdlib/` is written in Flow and compiled with your program — it is the
first real user of the module system.

---

## 4. The package manager

```bash
flow install [dir]              # resolve dependencies, vendor, write flow.lock
flow add flow-time              # add the best matching version, then install
flow add flow-time@^1.0.0       # explicit range
flow add flow-time@~1.0.0       # resolves 1.0.0, not 1.2.0
flow verify [dir]               # integrity check against flow.lock
flow registry                   # list registry contents
```

### Resolution

Ranges are the usual subset: `*`, `1.2.3`, `^1.2.3`, `~1.2.3`.

| range | matches |
|---|---|
| `^1.2.3` | `>=1.2.3 <2.0.0` |
| `^0.2.3` | `>=0.2.3 <0.3.0` |
| `~1.2.3` | `>=1.2.3 <1.3.0` |
| `1.2.3` | exactly `1.2.3` |

The highest satisfying version wins. Dependencies of dependencies are hoisted into
`flow_modules/` (flat, like Node).

### Vendor + lock

```
flow_modules/flow-time/src/format.flow
flow.lock
```

```json
{
  "lockfileVersion": 1,
  "packages": {
    "flow-time": {
      "version": "1.2.0",
      "integrity": "sha256-<64 hex chars>",
      "dependencies": {}
    }
  }
}
```

`integrity` is a SHA-256 over every file in the package (sorted paths + contents).
`flow verify` recomputes it:

```
$ flow verify
  flow-time: integrity mismatch (expected sha256-9c1e…, got sha256-41aa…)
```

### Registry

The default registry is `registry/` in the compiler repo; override it with
`FLOW_REGISTRY=/path/to/registry`.

```
registry/
  index.json                    {"packages":{"name":{"versions":{"1.2.0":{"path":"packages/name/1.2.0"}}}}}
  packages/flow-time/1.2.0/flow.json
  packages/flow-time/1.2.0/src/format.flow
```

Publishing in 0.1 means copying a directory into the registry and adding a version
entry. `flow install` copies it into `flow_modules/`, hashes it, and records it.

### Build-time resolution

The linker resolves `flow-charts` to `flow_modules/flow-charts` through the
consumer's `flow.json`; a missing install is a single actionable error:

```
flow-charts: dependency 'flow-charts' (^1.0.0) is not installed — run 'flow install'
```

---

## 5. Worked example

```
packages/app/
  flow.json        { "name": "app", "dependencies": { "flow-charts": "^1.0.0", "flow-time": "^1.2.0" } }
  src/main.flow
  src/dashboard.flow
```

```flow
// src/main.flow
use app::dashboard::{Card, bars}
use flow-charts::bar::Chart
use flow-time::format::hms
use std::list::map

fn main() -> Html {
  html {
    <div class="app">
      <Chart title={"Squares"} bars={bars()} />
      <p>{"uptime: "}{hms(3723000)}</p>
      {map([1, 2], fn(n: Int) -> Html { html { <Card n={n} /> } })}
    </div>
  }
}
```

```bash
$ cd packages/app && node ../../bin/flow.mjs install .
installed into .../flow_modules
  flow-charts@1.0.0  sha256-3b18e5f94ed108de…
  flow-time@1.2.0    sha256-a4a00629dde2c39e…
wrote .../flow.lock

$ node ../../bin/flow.mjs check src/main.flow
    Checking src/main.flow
    Finished check in 0.07s (no cuts)
```

Verified in a browser: `uptime: 01:02:03`, bars at `width:42%`, cards rendered —
see `README.md`.

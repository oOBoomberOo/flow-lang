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
| effects | `Server`, `Client`, `Store` — declared **and provided** here, not by the compiler; the runtime only exposes raw host primitives |
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

### `std::option`

`map`, `withDefault`, `isSome`, `isNone`, `toList` — all over the builtin
`Option<a>`.

### `std::math`

Int helpers in Flow: `abs`, `minInt`, `maxInt`, `clamp`, `sum`, `product`, `sign`.
Float primitives through the FFI: `sqrt`, `pow`, `floor`, `ceil`, `round`, `absF`,
`minF`, `maxF`, `logF`, `expF`, `sinF`, `cosF`.

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
ok: src/main.flow type-checks (0 cut(s) inferred)
```

Verified in a browser: `uptime: 01:02:03`, bars at `width:42%`, cards rendered —
see `README.md`.

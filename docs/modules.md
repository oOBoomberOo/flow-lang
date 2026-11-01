# Flow — modules, packages and namespacing

A **package** is a directory with a `flow.json` manifest and a `src/` tree of `.flow` files. A
**module** is one file, and every file starts with a `module` header whose dotted name mirrors
its path inside `src/`:

```
flow.json
src/
  main.flow        module Main          -- the entry (defines main, serve and/or routes)
  util.flow        module Util
  shapes/
    circle.flow    module Shapes.Circle
```

The header is mandatory and is checked against the path (with an optional package-namespace
prefix), so a moved or renamed file cannot keep a stale namespace. The standard library is the
registry package `flow`: its `src/list.flow` is `module Flow.List`, `src/http.flow` is
`module Flow.Http`, and so on.

## Importing

```flow
import Flow.List                     -- every export, unqualified
import Flow.List (filter)            -- only this name
import Flow.List (filter as keep)    -- renamed
import Flow.List as L                -- qualified only: L.filter
import FlowCharts.Bar (Chart)        -- a dependency's module
```

Short std names still work, so existing code keeps compiling:

```flow
import List (filter)                 -- the local/dependency List if one exists, otherwise Flow.List
```

`import` never fails silently: a missing module, a missing name or a name missing from the
module's export list is an error at the import line. When a module and the standard library share
a short name, the local/dependency module wins; write `Flow.List` to reach std unambiguously.

## Namespaces

Every public declaration can also be reached through its module qualifier, **without an
import**:

```flow
let sorted = Flow.List.sortBy (\a b -> a - b) [3, 1, 2]
let o = map (\x -> x + 1) (Option.Some 1)
let f = Option.withDefault "fallback" Option.None
```

The linker sees the qualifier, loads the module on demand, checks visibility and rewrites the
reference to the declaration. `List`, `Math`, `Http` and the other short std names keep working
when no local module claims them; `Flow.*` always names the standard library. `Option.Some` and
`Option.None` resolve to `Flow.Option`; the monad family (`map`, `pure`, `return`, `bind`,
`empty`) is re-exported by the prelude from `Flow.Monad`.

Qualified references work for values, constructors, effects, traits and types:

```flow
handle State.State with
  get () = resume 1
in State.State.get ()

type P = Http.RequestObject
let r = Some 1
case r of
  Option.Some x -> x
  Option.None -> 0
```

## Visibility

A module is **private by default** once it has an export list:

```flow
module Util (Priority, describe) where

data Priority = Low | High        -- exported (and its constructors)

describe :: Priority -> Str      -- exported
describe p = case p of
  Low -> "low"
  High -> "high"

secretSauce :: () -> Str         -- private to this file
secretSauce () = "sssh"
```

A module with no export list exports everything. `data Shape (..)` exports the type and all its
constructors; `data Shape (Circle)` exports only that constructor.

Importing a private name reports:

```
'hidden' is private in module Util; add it to the export list of Util
```

Referencing a private name through the qualifier reports:

```
'Util.hidden' is private: hidden is not in the export list of module Util
```

## Module names

A file's qualifier is its path under `src/` with each segment capitalised. The header may use
the short path name or prefix it with the package namespace:

| file | header |
|---|---|
| `src/util.flow` | `module Util where` or `module App.Util where` |
| `src/shapes/circle.flow` | `module Shapes.Circle where` or `module App.Shapes.Circle where` |
| `src/main.flow` | `module Main where` or `module App.Main where` |
| a dependency `flow-charts/src/bar.flow` | `module Bar where` or `module FlowCharts.Bar where` |
| the standard library's `src/list.flow` | `module Flow.List where` |

The namespace is the package name capitalised (`app` → `App`, `flow-charts` → `FlowCharts`,
`flow` → `Flow`). Package-qualified imports work too: `import App.Util` and `import Util` name
the same file inside package `app`.

A standalone file compiled outside a package (a script, an example) uses its own file name:
`hello.flow` is `module Hello where`; `main.flow` is `module Main where`. Hyphenated and
underscored segments become one capitalised word (`flow-charts/bar.flow` → `FlowCharts.Bar`).

The `Flow` root is the standard library package. It is an ordinary registry package named
`flow`, shipped at `registry/packages/flow/1.0.0/` with a real `flow.json` and `src/` tree.
`import Flow.List` and `Flow.List.sortBy` always mean std even if a project defines its own
`List` module. A project may list `"flow": "1.0.0"` in `flow.json`; the compiler resolves it to
the bundled package.

## Packages

```json
{
  "name": "app",
  "version": "0.1.0",
  "dependencies": { "flow-time": "^1.2.0" }
}
```

```bash
flow install            # resolve, vendor into flow_modules/, write flow.lock
flow install --refresh  # re-fetch git registries and git dependencies
flow add flow-time      # add the newest matching version
flow verify             # check the vendored tree against the lockfile
flow registry           # the active registry and its packages
```

Inside the package, `import Util` resolves to `src/util.flow`; `import FlowTime.Format`
resolves to the dependency's `src/format.flow`.

A package may ship JavaScript or TypeScript beside its Flow sources and bind it with
`foreign import js unsafe "./text.js" { … }` (see [language.md](language.md) § 8). The file is
resolved relative to the declaring source, copied into `modules/` at build time and served to the
browser, so one shim runs on both tiers. `examples/ffi-shim` shows a hand-written helper, a
wrapper around an existing library and a server-only TypeScript module.

### Registries

The default registry is **[flow-registry](https://github.com/oOBoomberOo/flow-registry.git)**.
It is a git repository containing `index.json` and `packages/<name>/<version>/`; Flow clones it
into a cache (`~/.flow/cache/registries`, overridable with `FLOW_CACHE`). Git registries are
refreshed automatically when the cache is older than five minutes; `--refresh` forces a fetch,
and `FLOW_REGISTRY_TTL=<seconds>` changes the interval (`0` refreshes every command).

A registry can also be a **directory on disk**. You can choose one at three levels, with the
strongest winning:

```json
// project: flow.json — applies to this project
{ "registry": "https://github.com/oOBoomberOo/flow-registry.git" }

// a git registry at a ref, or a local directory
{ "registry": { "url": "https://github.com/me/flow-pkgs.git", "ref": "main" } }
{ "registry": { "path": "../my-registry" } }
```

```json
// global: ~/.config/flow/config.json (or %USERPROFILE%\.config\flow\config.json)
{ "registry": "github:me/flow-pkgs#main" }
```

```bash
FLOW_REGISTRY=../my-registry flow install   # environment
```

Order: **dependency override → project → global config → `FLOW_REGISTRY` → default**.
`flow registry --verbose` prints the chain, the cache path and every version.

### Dependency specs

```json
{
  "dependencies": {
    "flow-time": "^1.2.0",
    "shapes": "path:../shapes",
    "tool": "git:https://github.com/oOBoomberOo/flow-tool.git#v1.0.0",
    "widgets": "github:me/flow-widgets#main",
    "internal": { "range": "^2.0.0", "registry": "git:https://github.com/me/flow-pkgs.git" }
  }
}
```

* `path:…` / `file:…` — a package directory on disk. It is linked, not copied, so edits are live;
  `flow verify` checks that the directory still has a `flow.json`.
* `git:<url>#<ref>` and `github:owner/repo#<ref>` — cloned into the cache and copied into
  `flow_modules`, with the ref recorded in `flow.lock`.
* `{ "range": …, "registry": … }` — a registry dependency pinned to a different registry.
* a bare semver range — resolved against the active registry.

`flow.lock` records each package's `version`, `integrity`, and where it came from
(`source: "registry" | "git" | "path"` plus the resolved URL or directory).

```bash
flow add shapes path:../shapes
flow add tool git:https://github.com/oOBoomberOo/flow-tool.git#v1.0.0
```

## The prelude

`registry/packages/flow/1.0.0/src/prelude.flow` (`module Flow.Prelude`) is a **re-export surface**, injected into every
module with the lowest priority. It declares nothing itself: it imports names from the real
modules, and every unit sees them unqualified (`str`, `len`, `Some`, `None`, `not`, `concat`,
`push`, ...) and through their namespaces. A unit's own declarations and imports win.

```flow
at 0 [1, 2]                 -- injected prelude surface
Prelude.at 0 [1, 2]         -- qualified re-export
import Flow.Prelude (at)    -- explicit import through the prelude
```

The sources are `Flow.Basics` (`str`, `eq`, `neq`, `not`), `Flow.Option` (`Option`, `None`,
`Some`), `Flow.List` (`len`, `length`, `isEmpty`, `push`, `concat`, `cons`, `head`, `tail`,
`reverse`, `at`), `Flow.String` (`trim`, `upper`, `lower`, `split`, `replace`, `contains`,
`join`, `chars`, `strLen`, `int`, `float`), `Flow.Cell` (`CellOps`, `makeCell`), `Flow.Classes` (`Eq`, `Ord`, `Show`, `Semigroup`, `Monoid`, `Foldable`), `Flow.Store`
(`Store`) and `Flow.Monad` (`Functor`, `Applicative`, `Monad`, `Alternative`).

The standard library ships as modules under the reserved `Flow` namespace: `Flow.Basics`,
`Flow.Classes`, `Flow.List`, `Flow.Iter`, `Flow.Dict`, `Flow.Set`, `Flow.Tuple`, `Flow.Option`, `Flow.Result`,
`Flow.Math`, `Flow.Random`, `Flow.String`, `Flow.Html`, `Flow.Log`, `Flow.Time`, `Flow.Path`,
`Flow.Env`, `Flow.Http`, `Flow.Net`, `Flow.Fs`, `Flow.State`, `Flow.Exn`, `Flow.Ref`,
`Flow.Cell`, `Flow.Store`, `Flow.Client`, `Flow.Server`, `Flow.Monad`, `Flow.Fn`, `Flow.Json`,
`Flow.Reflect` and `Flow.Serialize`. Short names (`List`, `Math`, ...) still resolve to these
modules when nothing local claims them. The full catalogue is in [`language.md`](language.md)
section 7.1; reflection and JSON are in [`serialize.md`](serialize.md).

Cells are neutral by default (`Cell.makeCell`). `Client.state` returns a
`Cell a @client` and `Server.state` a `Cell a @server`. A cell can be created in
any local scope; reads and writes on the other tier become cuts, and the cell
itself crosses as a handle.

## Everything is ordinary Flow

The primitive helpers are ordinary `foreign import js unsafe` bindings in their modules
(`Flow.Basics`, `Flow.List`, `Flow.String`, `Flow.Cell`, `Flow.Store`); there are no compiler
intrinsics for values. `Flow.List.sortBy` is written in Flow over an FFI `@sort`; only the
primitive operations (`#length`, `@concat`, `#index`, …) reach JavaScript.

## Web entry points

`main :: ()` is the server startup hook: it runs once, before any request, so
server-side state can be initialised there. `serve` takes a plain app object with
a browser page handler and a server route list:

```flow
module Main where

import Flow.Http (RequestObject, serve, page, matchPage, PageRoute, get, jsonResponse)
import Flow.Prelude (Store)

pages :: List PageRoute
pages = [ page "/" (\_ -> <h1>{"Home"}</h1>) ]

main :: ()
main = do
  Store.set "ready" "yes"
  serve
    { page = \req ->
        case matchPage pages req of
          Some (matched, view) -> view matched
          None -> <h1>{"Not found"}</h1>
    , routes = [ get "/api/ready" (\_ -> jsonResponse "{\"ready\":true}") ]
    }
```

A legacy `routes :: () -> ()` table is still called after `main` for existing
programs. `serve` is a typed function (`AppConfig -> ()`), so page-only apps use
`servePage` and server-only APIs use `serveApi`. Server route handlers run on
the server; `serve`/`servePage` pages run in the browser. `main :: Html` remains
the single-page client form. See [`http.md`](http.md).

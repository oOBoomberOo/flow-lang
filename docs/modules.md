# Flow — modules, packages and namespacing

A **package** is a directory with a `flow.json` manifest and a `src/` tree of `.flow` files. A
**module** is one file. Modules are namespaces: `Option`, `List`, `Http`, and so on.

```
flow.json
src/
  main.flow        -- the entry module (defines main, serve and/or routes)
  util.flow        -- module Util
  shapes/
    circle.flow    -- module Shapes.Circle
```

## Importing

```flow
import List                          -- every export, unqualified
import List (map, filter)            -- only these names
import List (map as transform)       -- renamed
import List as L                     -- qualified only: L.map
import Flow.Charts.Bar (Chart)       -- nested module paths
```

`import` never fails silently: a missing module, a missing name or a name missing from the
module's export list is an error at the import line.

## Namespaces

Every public declaration can also be reached through its module qualifier, **without an
import**:

```flow
let sorted = List.sortBy [3, 1, 2] (\a b -> a - b)
let o = Option.map (Option.Some 1) (\x -> x + 1)
let f = Option.withDefault (Option.None) "fallback"
```

The linker sees the qualifier, loads the module on demand, checks visibility and rewrites the
reference to the declaration. Members of the injected prelude are reachable through their
conventional module, so `Option.Some`, `Option.None` and `Option.map` all work even though the
`Option` type itself lives in the prelude.

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

A file **without** a header exports everything. `data Shape (..)` exports the type and all its
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

A file's qualifier is its path with each segment capitalised: `list.flow` → `List`,
`http/response.flow` → `Http.Response`, `flow-charts/bar.flow` → `FlowCharts.Bar` (a package's
own name joins the path). Hyphenated package names are fine.

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
into a cache (`~/.flow/cache/registries`, overridable with `FLOW_CACHE`) and refreshes on
`--refresh`.

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

`std/prelude.flow` is injected into every module with the lowest priority: its declarations are
available unqualified (`str`, `len`, `Some`, `None`, `True`, `False`, `not`, `concat`, `push`, …)
and through the `Option` / `List` namespaces. A unit's own declarations and imports win.

The standard library ships as modules: `List`, `Iter`, `Dict`, `Set`, `Tuple`, `Option`, `Result`, `Math`, `Random`, `String`, `Html`, `Log`, `Time`, `Path`, `Env`, `Http`, `Net`, `Fs`, `State`, `Exn`, `Ref`, `Cell`, `Client`, `Server`, `Monad`, `Fn` and `Json`. The full catalogue is in [`language.md`](language.md) § 7.1.

## Everything is ordinary Flow

The prelude's primitives are `foreign import js unsafe` bindings to the host; there are no
compiler intrinsics for values. `List.sortBy` is written in Flow over an FFI `@sort`; only the
primitive operations (`#length`, `@concat`, `#index`, …) reach JavaScript.

## Web entry points

`main :: ()` is the server startup hook: it runs once, before any request, so
server-side state can be initialised there. `serve` installs a client page
handler for multi-page apps:

```flow
import Http (RequestObject, serve, page, matchPage, PageRoute)
import Prelude (Store)

pages :: List PageRoute
pages = [ page "/" (\_ -> <h1>{"Home"}</h1>) ]

main :: ()
main = do
  Store.set "ready" "yes"
  serve (\req ->
    case matchPage pages req of
      Some (matched, view) -> view matched
      None -> <h1>{"Not found"}</h1>)
```

A server response API is still a `routes :: () -> ()` table:

```flow
import Http (get, Router, RequestObject, textResponse)

routes :: () -> ()
routes () =
  Router.mount [
    get "/hello" (\req -> textResponse ("hello " + req.path))
  ]
```

The host calls `main ()` first, then `routes ()`, both once at startup. Server
route handlers run on the server; `serve` pages run in the browser. `main :: Html`
remains the single-page client form. See [`http.md`](http.md).

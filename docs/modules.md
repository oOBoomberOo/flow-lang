# Flow — modules, packages and namespacing

A **package** is a directory with a `flow.json` manifest and a `src/` tree of `.flow` files. A
**module** is one file. Modules are namespaces: `Option`, `List`, `Http`, and so on.

```
flow.json
src/
  main.flow        -- the entry module (defines main or routes)
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
flow install     # resolve, vendor into flow_modules/, write flow.lock
flow add flow-time
flow verify      # check the vendored tree against the lockfile
```

Inside the package, `import Util` resolves to `src/util.flow`; `import FlowTime.Format`
resolves to the dependency's `src/format.flow`.

## The prelude

`std/prelude.flow` is injected into every module with the lowest priority: its declarations are
available unqualified (`str`, `len`, `Some`, `None`, `True`, `False`, `not`, `concat`, `push`, …)
and through the `Option` / `List` namespaces. A unit's own declarations and imports win.

The standard library ships as modules: `List`, `Iter`, `Dict`, `Set`, `Tuple`, `Option`, `Result`, `Math`, `Random`, `String`, `Html`, `Log`, `Time`, `Path`, `Env`, `Http`, `Net`, `Fs`, `State`, `Exn`, `Ref`, `Cell`, `Client`, `Server`, `Monad`, `Fn` and `Json`. The full catalogue is in [`language.md`](language.md) § 7.1.

## Everything is ordinary Flow

The prelude's primitives are `foreign import js unsafe` bindings to the host; there are no
compiler intrinsics for values. `List.sortBy` is written in Flow over an FFI `@sort`; only the
primitive operations (`#length`, `@concat`, `#index`, …) reach JavaScript.

## Server routes

A program opts into HTTP by defining `routes :: () -> ()`:

```flow
import Http (get, Router, RequestObject, Response, textResponse)

routes :: () -> ()
routes () =
  Router.mount [
    get "/hello" (\req -> textResponse ("hello " + req.path))
  ]

main :: Html
main = <p>{"client"}</p>
```

The host calls `routes ()` once at startup. Request handlers run on the server; `main` still
compiles into the client bundle.

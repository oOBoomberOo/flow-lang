# Flow

A tierless web language with a **Haskell-style surface** — layout-driven, curried, inferred —
where the client/server boundary is derived from the types. Modules, packages, a standard
library, a language server, and a VS Code extension that colours the boundary in your editor.

You write one program. Every expression gets a *placement* derived from the authority it
requires — `Client` for the DOM, `Server` for secrets and state, user effects for whatever their
provider needs. Where placements disagree, the compiler cuts the program into a browser bundle
and a server bundle, and turns the seam into a wire.

```flow
import Server
import Client

greeting :: Str -> Html
greeting name = <p>{"Hello, " + name}</p>

main :: Html
main = do
  let who = str (Server.now ())
  let count = Client.state 0
  <div class="card">
    <h1>{greeting who}</h1>
    <button onClick={\e -> count := count.value + 1}>{"+1"}</button>
    <p>{str count.value}</p>
  </div>
```

A function is a value, not a region: a callback is hosted by whoever invokes it, and the
statements inside it cross individually when they need the other side. A client timer callback
that logs with `Server.log` stays in the browser; only the log statement is a server call.

## The syntax in one screen

```flow
module Shapes (Shape(..), area, main) where

import List (map, sum)
import Option as O

-- data, records and aliases
data Shape = Circle Float | Rect Float Float
type Point = { x :: Float, y :: Float }

area :: Shape -> Float
area (Circle r) = 3.14 * r * r
area (Rect w h) = w * h

-- clauses, guards and where
classify :: Int -> Str
classify n
  | n < 0 = "neg"
  | n == 0 = "zero"
  | otherwise = "pos"

total :: List Int -> Int
total xs = go xs 0
  where
    go [] acc = acc
    go (x : rest) acc = go rest (acc + x)

-- currying, sections, composition
incs = map (+ 1)
evens = filter (\x -> x `mod` 2 == 0)
banner = upper . trim

main :: Html
main = do
  let shapes = [Circle 2.0, Rect 3.0 4.0]
  <ul>{map (\s -> <li>{str (area s)}</li>) shapes}</ul>
```

Layout is the block structure: `where`, `let`, `of`, `do` and `with` open a block, and a line
that starts at or left of the block's indentation closes it. Brackets and `{expr}` holes inside
markup suspend layout, so multi-line literals just work.

## Modules are namespaces

```flow
import Option (withDefault)
import List as L
import Http (get, Router, textResponse)

main :: Html
main = <p>{withDefault (Option.map Option.Some 3) "none"}</p>
```

* `import Module (a, b)` brings names into scope.
* `import Module as M` (or just mentioning `Module.x`) lets you write `M.x`.
* Qualified names work **without any import**: `Option.map`, `Option.withDefault`, `List.sortBy`,
  `Http.textResponse`. The linker loads the module on demand and checks its export list.

`module Name (exports) where` makes everything else private. A file without a header exports
everything.

## Commands

```bash
node bin/flow.mjs check   examples/hello.flow
node bin/flow.mjs explain examples/boundary.flow
node bin/flow.mjs run     examples/counter.flow --port 4173
node bin/flow.mjs fmt     src/main.flow          # format in place
node bin/flow.mjs migrate old-syntax.flow --write # rewrite the old Rust-style syntax
```

```
examples/hello.flow      the smallest app
examples/counter.flow    client state and events
examples/boundary.flow   if across the boundary, uplink, downlink
examples/effects.flow    capabilities and providers
examples/algebraic.flow  algebraic effects, resume, handlers
examples/fp.flow         currying, sections, composition, partial application
examples/modules.flow    local modules, imports and namespacing
examples/http.flow       routes, request capabilities
examples/bounds.flow     trait bounds
examples/hkt.flow        higher-kinded type parameters
examples/traits.flow     user traits and instances
examples/lists.flow      list functions
examples/adt.flow        data types and pattern matching
examples/ffi.flow        unsafe FFI
examples/fs.flow         server-side filesystem access
examples/net.flow        outbound HTTP from the server
examples/handler.flow    local algebraic handlers
```

Tests: `npm test` — **256 tests** across grammar, layout, types, boundaries, modules, packages,
registries, the standard library, algebraic effects, cell sugar, monads, currying, qualified paths,
trait bounds, higher-kinded types, local handlers, the language server and the VS Code extension.

## Feature list

* **One language, two tiers** — `Client` / `Server` effects decide placement; the compiler
  emits a browser bundle and a server bundle plus the wire between them
* **Haskell-style syntax** — layout blocks, partial application, `\x -> e`, `if/then/else`,
  `case … of`, `let … in`, `where`, operator sections, `$` and `.`
* **Full inference** — signatures are optional; unannotated functions are inferred callee-first
  and generalized, lambda parameters take their types from the caller
* **Modules as namespaces** — `Option.map`, `Option.withDefault`, `List.sortBy`, plus the
  `import` forms; no `::` paths to remember
* **Data and records** — `data Shape = Circle Float | Rect Float Float`, `type P = { x :: Int }`
* **Classes and instances** — `class Show a where`, `instance Show Int where`, contexts
  (`Eq a => Ord a`), higher-kinded parameters (`class Functor f where map :: (a -> b) -> f a -> f b`)
* **Batteries included** — `List`, `Iter`, `Dict`, `Set`, `Tuple`, `Option`, `Result`, `String`,
  `Math`, `Json`, `Time`, `Path`, `Env`, `Cell`, `Client`/`Server`, `Monad`: containers,
  iteration, JSON, dates and paths ship in the language
* **FFI for libraries** - bind globals (`Math.floor`), methods (`@trim`) and your own JS/TS
  modules with `foreign import js module "./shim.js" { … }`; shims are copied into the build and
  served to the browser, so one file runs on both tiers
* **Packages and registries** - `flow install` resolves from the default
  [flow-registry](https://github.com/oOBoomberOo/flow-registry) git registry; registries can be
  set per dependency, per project or globally, and dependencies may be `path:` directories or
  `git:`/`github:` repositories
* **Effects are capabilities** — `effect Server @ server where`, `provide`, `handle`
* **Algebraic effects** — `algebraic effect State where get :: () -> Int`, resumed with `resume`
* **Cell sugar** — `cell.value`, `cell := e`, `cell += n`, `cell.update`
* **Boundary colouring** — client code washed blue, server code amber; every inferred cut is
  underlined, with a gutter marker and an overview ruler
* **Inlay hints** — `fn render server`, `let total: Int`, `cut1→server`: the boundary is inline
* **Language server** — completion, hover, definitions, references, rename, semantic tokens,
  folding, formatting, code actions, code lenses, boundary regions
* **Formatter and migration** — `flow fmt` prints canonical syntax; `flow migrate` rewrites
  programs written in the old Rust-style syntax

## How it works

1. **Parse** (`src/parser.ts`) — layout-sensitive recursive descent into one AST.
2. **Link** (`src/modules.ts`) — imports, exports, namespacing and one flat program.
3. **Infer** (`src/infer.ts`) — types, effect rows, trait dispatch, and the placement lattice.
4. **Cut** (`src/codegen.ts`) — resolve `cross` nodes into two programs and the wire.
5. **Runtime** (`src/runtime/`) — a dependency-tracking dataflow graph shared by both sides.

Most "full-stack" tools make you *write* the boundary: file directives, server actions, RPC
stubs. Flow treats tiers as an effect system: you write one program, and the compiler works out
where each part has to run.

## Licence

MIT.

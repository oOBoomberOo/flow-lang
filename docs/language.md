# Flow — language reference

Flow is a tierless web language with a Haskell-style surface: layout-driven blocks, curried
functions, pattern matching and full type inference. You write one program; the compiler splits
it into a browser bundle and a server bundle based on the effects each expression requires.

```
docs/language.md      this reference
docs/modules.md       modules, packages and namespacing
docs/type-system.md   types, effects and placement inference
docs/editor.md        the language server and the VS Code extension
docs/http.md          startup, page routing and server responses
docs/serialize.md     reflection and JSON serialization
docs/grammar.ebnf     the grammar
```

---

## 1. Layout

There are no braces for blocks. `where`, `let`, `of`, `do` and `with` open an implicit block at
the indentation of the next token, and a line that starts at or left of that indentation closes
it. This is Haskell's offside rule:

```flow
total :: List Int -> Int
total xs = go xs 0
  where
    go [] acc = acc
    go (x : rest) acc = go rest (acc + x)
```

Brackets, list and record literals, and `{expr}` holes inside markup suspend layout, so these
all work:

```flow
let xs = [ 1
         , 2
         ]
main = <p>{if ready then "yes" else "no"}</p>
```

`--` starts a line comment; `{- … -}` is a block comment and nests.

## 2. Declarations

```flow
module Shapes (Shape(..), area) where   -- required; exports control what is public

import Flow.List (filter)               -- bring a name into scope
import Flow.Option as O                 -- qualified access as O.map
import Flow.Http (get as httpGet)       -- rename on import

data Shape = Circle Float | Rect Float Float
type Point = { x :: Float, y :: Float }
type Name = Str

area :: Shape -> Float
area (Circle r) = 3.14 * r * r
area (Rect w h) = w * h
```

Every `.flow` file starts with a `module` header whose dotted name mirrors its path; a module
without an export list exports everything. `pub` does not exist.

### Signatures are optional

```flow
double xs = map (\x -> x + x) xs   -- inferred
```

An unannotated function is inferred when its callees have been, and generalized afterwards, so
callers can use it at several types. Lambda parameters take their types from the caller:
`map (\x -> x + 1) xs` needs no annotation when `xs :: List Int`.

A definition with no parameters is a constant:

```flow
pi = 3.14159
main = <p>{str pi}</p>
```

### Clauses, guards and `where`

```flow
fact :: Int -> Int
fact 0 = 1
fact n = n * fact (n - 1)

classify :: Int -> Str
classify n
  | n < 0 = "negative"
  | n == 0 = "zero"
  | otherwise = "positive"
```

Several clauses become a `case` on the parameters; every clause must have the same number of
patterns. Guards must end with `otherwise` (or `True`).

### Classes and instances

```flow
class Show a where
  show :: a -> Str

instance Show Int where
  show n = str n

class Eq a => Ord a where
  compare :: a -> a -> Int
```

A method whose signature mentions no value of `a` (`empty :: () -> a`) dispatches on its result.
An instance method written without types takes them from the class.

Higher-kinded parameters work too. The standard library defines the monad family
and re-exports it from the prelude, so `map`, `pure`, `return`, `bind` and
`empty` are always in scope:

```flow
class Functor f where
  map :: (a -> b) -> f a -> f b

class Functor f => Applicative f where
  pure :: a -> f a

class Applicative f => Monad f where
  bind :: (a -> f b) -> f a -> f b
  return :: a -> f a
```

`map f xs` and `map f (Some 1)` both work; a `Monad f` bound also carries the
Applicative and Functor dictionaries, so generic code can call `pure` and `map`.
Instances are declared per class, exactly like the `Show`/`Ord` examples above.

`Option`, `List`, `Cell` and `Result e` have Functor/Applicative/Monad
instances; `Option` and `List` also have `Alternative` (`empty`/`orElse`).
`Dict k` and `Set a` are aliases of `List`, so `map`/`empty` use the List
instance (use `Dict.mapWithKey` / `Set.mapWith` when the key or a comparator is
needed). `Result e` fixes the error type and is a monad over the success value,
exactly like Haskell's `Either e`; `Result.mapOk`/`andThen` remain available.

### Common classes

`Flow.Classes` (re-exported by the prelude) adds the other everyday Haskell
classes. The built-in operators stay as they are; the class methods have
unambiguous names:

| class | methods | notes |
|---|---|---|
| `Eq a` | `equals`, `notEquals` | `==` remains the built-in equality operator |
| `Ord a` | `compare`, `minOf`, `maxOf` | superclass `Eq a`; `<`/`>` remain built-in |
| `Show a` | `show` | `str` still shows any value |
| `Semigroup a` | `append` | `Str`, `List a`, `Option a` |
| `Monoid a` | `mempty` | superclass `Semigroup a`; `Str`, `List a`, `Unit`, `Option a` |
| `Foldable t` | `foldr`, `toList` | plus `foldMap :: (Foldable t, Monoid m) => (a -> m) -> t a -> m` |

Instances cover `Int`, `Float`, `Str`, `Bool`, `Unit`, `List a`, `Option a`
and `Result e a`, with the usual element constraints. A local class with the
same name shadows the prelude one.

## 3. Expressions

```flow
f x y = x + y          -- application by juxtaposition
g = f 1                -- partial application (fills from the left)
h = f 1 2              -- fully applied
byOption = map f       -- `map f` is waiting for the option
```

Functions take their operation or index first and the data last, so
`xs |> map f` is `map f xs`, `xs |> filter p` is `filter p xs`, and
`fold step init xs` folds. A call may also fill the **trailing** parameters
when needed (a right section, mirroring `(+ 1)`), but the compiler prefers the
normal left-filled partial.

Operators, from loosest to tightest: `$`, `<|`, `|>`, `>>=`, `||`, `&&`, comparisons, `:`,
`++`, `+ -`, `* / %`, `.`. `x |> f a` is `f a x` (insert as the next argument); `f <| x` and
`f $ x` are `f x`. `.` composes: `(f . g) x = f (g x)`.

Sections and operator values:

```flow
inc = (+ 1)
double = (* 2)
sum = foldl (+) 0
```

Control forms:

```flow
sign n = if n < 0 then -1 else 1

describe o = case o of
  None -> "nothing"
  Some x -> "some " + str x

pairs = let a = 1
            b = 2
        in (a, b)
```

Lambdas: `\x -> e`, `\x y -> e`, and `\case` for a one-argument match.

`do` notation is monadic (`>>=` on `Monad`):

```flow
answer = do
  x <- Option.Some 2
  y <- Option.Some 3
  Option.Some (x + y)
```

String append is `++` (also list append). Equality is `==` / `/=`, booleans are `True` /
`False`, negation is the function `not`.

## 4. Data, records and patterns

```flow
data Tree a = Leaf | Node (Tree a) a (Tree a)

size :: Tree a -> Int
size Leaf = 0
size (Node l _ r) = 1 + size l + size r
```

Patterns: constructors (`Node l _ r`), literals, wildcards, tuples, records
(`{ x = a }`), lists (`[1, 2]`) and cons (`x : rest`). A `case` over an ADT must cover every
constructor.

Records:

```flow
type User = { name :: Str, age :: Int }

u = { name = "ada", age = 36 }
shout = u.name ++ "!"
```

A `data` type with **one constructor whose only payload is a record** is a named
record: fields project directly, and the payload still pattern-matches.

```flow
data Todo = Todo { id :: Int, title :: Str, completed :: Bool }

done :: Todo -> Bool
done todo = todo.completed

retitle :: Todo -> Str -> Todo
retitle (Todo t) title = Todo { id = t.id, title = title, completed = t.completed }
```

Projection is only unambiguous for a single constructor; a multi-constructor
type must be matched with `case` before reading fields.

A projection or record pattern does not pin the value to an anonymous record.
When the value's type is only known later (an annotated function, or a local
helper used with a `List Todo`), the access resolves against that type, so the
lambda needs no parameter annotation:

```flow
data Todo = Todo { id :: Int, title :: Str }

lastId :: List Todo -> Int
lastId = List.fold Math.maxInt 0 . map (\t -> t.id)

idOf :: Todo -> Int
idOf todo = case todo of
  { id = n } -> n
```

## 5. Client, Server and effects

`Client` and `Server` are **modules**, not effects. Each function lives on one
side because its body reaches a primitive that only exists there; the FFI import
that reaches it carries the placement:

```flow
module Server (log, now, random) where

foreign import js unsafe "__flow.host.log" {
  server_write :: Str -> () @server
}

log :: Str -> ()
log msg = server_write msg
```

Calling one from the other side is a cut, exactly like any other crossing:

```flow
import Flow.Http (servePage)

main :: ()
main = do
  Store.set "started" (str (Server.now ()))   -- server setup, once
  servePage (\_ ->                            -- rendered in the browser
    let count = Client.state 0
    <div>
      <button onClick={\e -> count := count.value + 1}>{"+1"}</button>
      <p>{str count.value}</p>
    </div>)
```

A function without an annotation inherits the placement of its body, so ordinary
code needs no annotations at all — only the FFI leaf says which side it belongs to.

`effect` is for **effects you define**, with a default handler (`provide`) that decides where
they run (see §5.2). The standard library uses it for `Store`.

### 5.1 Cells

A cell is reactive state, and its type names the side that owns it:

| type | created by | reads and writes |
|---|---|---|
| `Cell a @client` | `Client.state x` | client computations; lives in the browser |
| `Cell a @server` | `Server.state x` | server computations; shared by every client |
| `Cell a` | `Cell.makeCell x` | neutral: lives where it is created and used |

A server-bound cell may be declared at the top level when it is shared:

```flow
counter :: Cell Int @server
counter = Server.state 0

bump :: Int -> ()
bump n = counter := counter.value + n

main :: Html
main = <div>
  <button onClick={\(e :: Event) -> bump 1}>{"+1"}</button>
  <p>{str counter.value}</p>
</div>
```

It may equally be created in any local scope, on either tier:

```flow
page = do
  let draft = Client.state ""
  let local = Server.state False
  <div>...</div>
```

Client reads of `counter.value` and `local.value` become reactive cuts (the owner
pushes the current value when it changes); writes (`counter := ...`, `+=`, ...)
become call cuts. A cell crosses as a **handle**, never as a serialized cell
object: the owner keeps the cell, the other side gets a Cell-shaped proxy with a
local value and a subscription. Creating `Server.state` inside client code (or
`Client.state` inside server code) is therefore ordinary code. The element type
must still be serializable when its value crosses.

`cell.value` reads, `cell := e` writes, `cell += n` / `-=` / `*=` update, and
`cell.update f` maps the current value; `cell.get ()` and `cell.set v` are the
method forms. `Cell.pure x` creates a neutral cell.

Cells are monads, so a sequence of reads is an ordinary `do` block — no special
syntax:

```flow
label :: Cell Str
label = do
  n <- counter
  Cell.pure ("count: " + str n)
```

`<-` reads the cell's current value, and the rest of the block must produce a
`Cell` (usually `Cell.pure ...`). A write returns `()`, so it cannot be the tail
of a `Cell` do block. In an event handler (which returns `()`), read with
`let x = get cell` / `cell.value` and write with `cell := ...`.

### 5.2 Effects

Every effect is algebraic: operations suspend, and a handler decides whether to
resume or abort. `effect X where` declares the effect. `provide X where` installs
its **default handler** (what used to be called a capability); `handle X with . in .`
installs a scoped handler that overrides the default for its body.

```flow
effect Audit where
  record :: Str -> ()

provide Audit where
  record msg = Server.log msg      -- default handler on the server

effect State where
  get :: () -> Int
  put :: Int -> ()

compute :: () -> Int ! State
compute () = do
  State.put 10
  State.get () + 1

run :: () -> Int
run () = handle State with
    get () = resume 41
    put x = resume ()
  in compute ()
```

`Audit.record "hi"` uses its default handler, so it is a server call wherever it
is written. A local `handle` takes precedence for the duration of its body.
Operations suspend; a handler calls `resume` to continue, or returns to abort.

Calls are effect-lenient: a callback's effects flow through higher-order functions such as
`map`, `bind` and `Cell.update` instead of being rejected at the callback boundary, and
partially applying an effectful function keeps its effect row:

```flow
toggle :: Int -> List Todo -> List Todo ! Exn
toggle id = map \(t) -> if t.id == id then ... else ...
```

The same effect can cross a tier cut. A cut body that performs an operation sends it to the
caller's handler; `resume` continues the remote body, and a handler that does not resume
supplies the call's result:

```flow
handle Exn with
  fail msg = Client.log ("caught: " + msg)
in state.update $ Todo.toggleTodo todo.id
```

The handler is on the caller's side; the effect row no longer has to be handled before the cut.

### 5.3 Entry points

A program has a server startup hook and one plain-data app object:

```flow
main :: ()                   -- once, on the server, before any request
main = do
  Store.set "visits" "0"
  serve
    { page = \request -> <h1>{"Hello " + request.path}</h1>
    , routes = [ get "/api/visits" (\_ -> jsonResponse "{\"visits\":0}") ]
    }
```

`serve` takes `{ page, routes }`: `page` is a **client-placed**
`RequestObject -> Html` handler, and `routes` is a plain `List Route` of
server response handlers. The host sends the shell for any page request and the
page callback renders it, so page routing is just a `case` on `request.path`
(or `matchPage` over a route list). Server data used by a page is a normal cut:
put it behind a top-level server function.

`main :: Html` is still a single client page:

```flow
main :: Html
main = <p>{"one page"}</p>
```

The page handler cannot capture `main`'s locals: it is compiled into the browser
bundle. It runs on every request; `main` runs once. See
[docs/http.md](http.md) for routing, request fields and server responses.

## 6. Markup

Markup is an expression. A lower-case tag is an element, an upper-case tag is a component (a
function taking a record), `{expr}` interpolates, and `<> … </>` is a fragment.

```flow
Label :: { title :: Str } -> Html
Label props = <span class="label">{props.title}</span>

main :: Html
main = <div class="card">
    <h1>{"Hello"}</h1>
    <Label title={"hi"} />
    <button onClick={\e -> Client.log "clicked"}>{"+1"}</button>
  </div>
```

An empty list interpolates as nothing; a list of markup renders its elements.

Event attributes (`onClick`, `onSubmit`, `onChange`, …) receive a client
`Event`. `e.target` is the DOM node that fired it and exposes `value`, `checked`,
`id`, `className`, `tagName`, `textContent` and `innerHTML`; `e.currentTarget`
is the node the handler is attached to, and `e.key`/`e.type` describe the event.
A handler must return `()`.

```flow
main :: Html
main = <input type="text" onSubmit={\e ->
  let title = e.target.value in
  set titleCell title
} />
```

`Html.eventValue event path` decodes a field path to the type expected at the
call site:

```flow
import Html (eventValue)

readCount event =
  Exn.attempt 0 (\() ->
    let n :: Int = eventValue event "target.value"
    in n)

readChecked event =
  Exn.attempt False (\() ->
    let checked :: Bool = eventValue event "target.checked"
    in checked)
```

`Str` reads strings, `Int`/`Float` parse numeric values, and `Bool` accepts
`target.checked` or `"true"`/`"false"`/`"on"`/`"off"`/`"1"`/`"0"`. A missing
path or an undecodable value raises the `Exn` effect.

`Event` and `Dom` are client-only and cannot cross the boundary (they cannot be
serialized or sent to the server).

Boolean attributes (`checked`, `disabled`, `selected`, `required`, …) take `Bool`;
numeric ones (`rows`, `cols`, `size`, `tabIndex`, …) take `Int`; every other
attribute takes `Str`.

## 7. Modules and namespacing

See [`modules.md`](modules.md). In short:

```flow
module Main where

import Flow.Option (withDefault)
import Flow.List as L

best = withDefault 0 (map (\x -> x * 2) (Option.Some 3))
sorted = L.sortBy (\a b -> a - b) [3, 1, 2]
```

Any public name can be reached by its module qualifier without an import:
`Flow.Option.withDefault`, `Flow.List.sortBy`, `Flow.Http.textResponse`. The short names
(`Option`, `List`, `Http`) resolve to std when no local or dependency module claims them, and
`Flow.*` always names the standard library. `module M (a, b) where` controls what is public.
The monad family is a prelude export, so `map`/`pure`/`return`/`empty` need no qualifier.

### 7.1 The standard library

The standard library is meant to be a one-stop toolkit: reach for it before the FFI. Its modules
live under the reserved `Flow` namespace; the short names below are accepted when no local
module claims them.

| Module | What it gives you |
|---|---|
| `Flow.Prelude` | re-export surface injected everywhere: `str`, `len`, `length`, `head`, `tail`, `push`, `concat`, `cons`, `at`, `trim`, `upper`, `lower`, `split`, `join`, `chars`, `strLen`, `int`, `float`, `eq`, `neq`, `not`, `makeCell`, `CellOps`, `Store`, `Option`, `Functor`, `Applicative`, `Monad`, `Alternative`, `Eq`, `Ord`, `Show`, `Semigroup`, `Monoid`, `Foldable` |
| `Flow.Basics` | `str`, `eq`, `neq`, `not` |
| `Flow.List` | `len`, `length`, `isEmpty`, `push`, `concat`, `cons`, `head`, `tail`, `reverse`, `at`, `filter`, `fold`, `take`, `drop`, `range`, `zip`, `sortBy`, `sortInts`, `sortStrings`, `any`, `all`, `contains`, `indexOfItem` (`map` comes from Functor) |
| `Flow.Iter` | `enumerate`, `zipWith`, `takeWhile`, `dropWhile`, `partition`, `groupBy`, `chunks`, `interleave`, `product2`, `find`, `count`, `minimum`, `maximum`, `average`, `scanl` |
| `Flow.Dict` | an ordered map: `fromList`, `insert`, `lookup`, `remove`, `keys`, `values`, `mapWithKey`, `filter`, `union`, `intersect`, `difference`, plus `string*` helpers |
| `Flow.Set` | `fromList`, `insert`, `member`, `remove`, `union`, `intersect`, `difference`, `mapWith`, `filter`, `intSet`, `stringSet` |
| `Flow.Tuple` | `fst`, `snd`, `swap`, `both`, `mapFirst`, `mapSecond`, `curry`, `uncurry`, `zip3`, `unzip` |
| `Flow.Option` | `Option`, `None`, `Some`, `withDefault`, `isSome`, `isNone`, `toList` (`map` comes from Functor) |
| `Flow.Result` | `Result e a` with `Ok`/`Err`, `mapOk`, `mapError`, `andThen`, `withDefault`, `toOption`, `fromOption`, `map2`, `all`, `first`, `firstOr`; `Functor`/`Applicative`/`Monad` over the success value |
| `Flow.String` | `length`, `joinWith`, `repeat`, `padLeft`, `padRight`, `words`, `startsWith`, `endsWith`, `indexOf`, `splitOnce`, `capitalize`, `isDigit`, `isAlpha`, `isAlphaNum`, `isSpace`, `isUpper`, `isLower`, `toUpper`, `toLower` |
| `Flow.Math` | `sqrt`, `pow`, `floor`, `ceil`, `round`, `abs`, `div`, `mod`, `minInt`, `maxInt`, `clamp`, `sum`, `product`, `sign`, `toFloat`, `toInt`, `isEven`, `isOdd`, `powInt`, `roundTo`, `pi`, `e`, trig and logs |
| `Flow.Json` | `Json` (`JNull`/`JBool`/`JNum`/`JStr`/`JList`/`JObject`), `encode`, `decode`, `decodeSafe`, `field`, `getPath`, `at`, `asString`, `asInt`, `asBool`, `asList` |
| `Flow.Reflect` | `meta`, `root`, `defs`, `lookup`, `typeName`, `describe`, `describeAll`; `TypeInfo` metadata for primitives, containers, records and data types |
| `Flow.Serialize` | `encode`/`decode` (static type) and `encodeWith`/`decodeWith`/`toJsonWith`/`fromJsonWith` (explicit `Reflected`): reflection-driven JSON with `Result` errors and field paths |
| `Flow.Time` | `now`, `nowMillis`, `nowPrecise`, `addSeconds`, `addDays`, `diffSeconds`, `formatIso`, `formatDate`, `formatClock`, `weekday`, `month`, `duration`, `hms` |
| `Flow.Path` | `join`, `basename`, `dirname`, `extension`, `normalize`, `isAbsolute`, `separator` |
| `Flow.Env` | `get`, `getOr`, `exists`, `all`, `args`, `name`, `platform` (`@server`) |
| `Flow.Monad` | the `Functor`/`Applicative`/`Monad`/`Alternative` family re-exported by the prelude, with instances for `Option`, `List`, `Cell` and `Result e`, plus `>>=`/`do` |
| `Flow.Classes` | `Eq` (`equals`/`notEquals`), `Ord` (`compare`/`minOf`/`maxOf`), `Show` (`show`), `Semigroup` (`append`), `Monoid` (`mempty`) and `Foldable` (`foldr`/`toList`/`foldMap`), with primitives and container instances |
| `Flow.Cell` | `pure`, `make`, `read`, `write`, `makeCell`, `CellOps` - neutral reactive values and monads |
| `Flow.Client` / `Flow.Server` | `log`, `now`, `state :: a -> Cell a @client` / `log`, `now`, `random`, `state :: a -> Cell a @server`, placed by their bodies |
| `Flow.State`, `Flow.Exn`, `Flow.Ref` | `State`, exceptions with `resume`, and mutable references |
| `Flow.Fs`, `Flow.Net`, `Flow.Http`, `Flow.Random`, `Flow.Store` | server file access, outbound HTTP, `serve`/page routing and server routes, randomness and key/value storage |

Containers are ordinary values, so they work on both sides of the boundary:
`Dict.stringLookup "k" d` in a render function reads a server-built map through a cut.
Reflection (`Reflect.meta`) and the JSON serialization standard built on it are
described in [`serialize.md`](serialize.md).

```flow
import Flow.Dict
import Flow.Iter
import Flow.Json (Json(..), encode, decodeSafe, getPath)

scores = Dict.stringDict [("ada", 36), ("grace", 85)]

summary :: () -> Str
summary () =
  let best = Iter.maximum (Dict.values scores)
  let doc = Json.JObject [("best", Json.JNum 85.0)]
  case decodeSafe (encode doc) of
    Ok parsed -> str (getPath ["best"] parsed)
    Err why -> why
```

## 8. FFI

FFI has **one shape**: a source and a block of bindings.

```flow
foreign import js unsafe "./text.js" { shout :: Str -> Str }

foreign import js unsafe "Math" {
  floor :: Float -> Int
  sqrt :: Float -> Float
}

foreign import js unsafe "@toUpperCase" { upper :: Str -> Str }
```

The **source** says where the JavaScript lives; the **block** says which names Flow sees.
A block may hold one binding or many, and every binding is an ordinary Flow value (curried,
passable to `map`, usable on either side of the boundary).

| Source | Meaning | Lookup |
|---|---|---|
| `"./shim.js"` `"./stats.ts"` | a module shipped next to the `.flow` file | the exported name of each binding |
| `"Math"` | a global object | each binding is one of its properties (`Math.floor`) |
| `"Math.floor"` | a single global leaf | the source itself (the block has one binding) |
| `"@toUpperCase"` | a method on the first argument | `arg0.toUpperCase(rest…)` |
| `"#length"` | a property of the first argument | `arg0.length` |

```flow
foreign import js unsafe "Math.hypot" { hypot :: Float -> Float -> Float }   -- a leaf
foreign import js unsafe "console" {
  log :: Str -> ()                                                           -- console.log
}
```

FFI is `unsafe` by construction and only the `js` target exists.

### Shimming your own module

```flow
foreign import js unsafe "./text.js" {
  shout :: Str -> Str
  slug :: Str -> Str
}
```

The path is resolved relative to the declaring source. The file is copied into the build
(`modules/`) and **served to the browser** at `/modules/<name>`, while the server imports the
same file, so one shim serves both tiers.

```js
// text.js
export const shout = (s) => String(s).toUpperCase() + "!";
export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-");
```

* A missing file, or an export the block names but the module does not have, is a **build error**.
* TypeScript works on the server (Node strips the types). A client binding to a `.ts` shim is a
  build error — annotate those bindings `@server` (which turns calls into cuts) or ship `.js`.

### Wrapping an existing library

Declare the shape you need and keep the adapter in the shim, where the third-party API lives:

```flow
foreign import js unsafe "./tiny-chart.js" {
  renderChart :: List Int -> (Int -> Str) -> Str
}
```

```js
// tiny-chart.js — wraps a package with its own API
import { Chart } from "tiny-chart";
export function renderChart(values, format) {
  return new Chart(values).render({ label: format });
}
```

Flow lambdas cross into JS as ordinary functions, so callbacks such as `format` are just
`a -> b` values. See `examples/ffi-shim` for one package using a hand-written helper, a wrapped
library and a TypeScript shim.

## 9. Diagnostics

Errors carry a code, a span and a caret snippet:

```
error[E_TYPE]: return type mismatch in fn g: expected Str, got Int
 --> src/main.flow:5:8
  |
5 | g = 42
  |     ^^
```

A wrong literal is underlined where it is written; `if` branches report the offending branch,
`case` arms the offending arm, call arguments the argument, and annotations the value. Type
names get "did you mean" hints. `flow check` fails on the first error; the editor shows all of
them.

## 10. Tooling

```bash
flow check src/main.flow    # type-check
flow build src/main.flow    # emit app.js, server.js and the runtime
flow run src/main.flow      # build + serve (or run a server-only main once)
flow fmt src/main.flow      # format with the pretty printer (--check to verify)
flow migrate old.flow --write  # rewrite the old Rust-style syntax
flow explain src/main.flow  # print placements and cuts
```

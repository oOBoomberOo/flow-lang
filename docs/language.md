# Flow — language reference

Flow is a tierless web language with a Haskell-style surface: layout-driven blocks, curried
functions, pattern matching and full type inference. You write one program; the compiler splits
it into a browser bundle and a server bundle based on the effects each expression requires.

```
docs/language.md      this reference
docs/modules.md       modules, packages and namespacing
docs/type-system.md   types, effects and placement inference
docs/editor.md        the language server and the VS Code extension
docs/http.md          server-side routes
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
module Shapes (Shape(..), area) where   -- exports; everything else is private

import List (map, filter)               -- bring names into scope
import Option as O                      -- qualified access as O.map
import Http (get as httpGet)            -- rename on import

data Shape = Circle Float | Rect Float Float
type Point = { x :: Float, y :: Float }
type Name = Str

area :: Shape -> Float
area (Circle r) = 3.14 * r * r
area (Rect w h) = w * h
```

A file without a `module` header exports everything. `pub` does not exist.

### Signatures are optional

```flow
double xs = List.map xs (\x -> x + x)   -- inferred
```

An unannotated function is inferred when its callees have been, and generalized afterwards, so
callers can use it at several types. Lambda parameters take their types from the caller:
`List.map xs (\x -> x + 1)` needs no annotation when `xs :: List Int`.

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

Higher-kinded parameters work too:

```flow
class Functor f where
  fmap :: (a -> b) -> f a -> f b

instance Functor List where
  fmap f xs = List.map xs f
```

## 3. Expressions

```flow
f x y = x + y          -- application by juxtaposition
g = f 1                -- partial application
h = f 1 2              -- fully applied
```

Operators, from loosest to tightest: `$`, `<|`, `|>`, `>>=`, `||`, `&&`, comparisons, `:`,
`++`, `+ -`, `* / %`, `.`. `x |> f` is `f x` (insert as first argument); `f <| x` and `f $ x`
are `f x`. `.` composes: `(f . g) x = f (g x)`.

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

## 5. Effects and services

Capabilities are effects with a provider:

```flow
effect Server @ server where
  secret :: Str -> Str
  log :: Str -> ()

effect Client @ client where
  state :: a -> Cell a

provide Server where
  secret k = host_secret k
  log msg = host_log msg
```

Calls look like ordinary functions and are placed by their effect:

```flow
main :: Html
main = do
  let token = Server.secret "api"     -- runs on the server
  let count = Client.state 0          -- runs on the client
  <p>{token}{str count.value}</p>
```

### Cells

`cell.value` reads, `cell := e` writes, `cell += n` / `-=` / `*=` update, and
`cell.update f` maps the current value. `cell.get ()` and `cell.set v` are the method forms.

### Algebraic effects

```flow
algebraic effect State where
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

Operations suspend the body; the handler calls `resume` to continue it. A handler that never
resumes aborts the handled body.

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

## 7. Modules and namespacing

See [`modules.md`](modules.md). In short:

```flow
import Option (withDefault)
import List as L

best = withDefault (Option.map (Option.Some 3) (\x -> x * 2)) 0
sorted = L.sortBy [3, 1, 2] (\a b -> a - b)
```

Any public name can be reached by its module qualifier without an import: `Option.map`,
`List.sortBy`, `Http.textResponse`. `module M (a, b) where` controls what is public.

## 8. FFI

```flow
foreign import js unsafe "Math.sqrt" sqrt :: Float -> Float
foreign import js unsafe "@toUpperCase" upper :: Str -> Str
foreign import js unsafe "#length" length :: List a -> Int
```

`"Path"` calls a global (keeping its receiver), `"@name"` is a method on the first argument,
`"#name"` a property, `"#index"` an element access. FFI is unsafe by construction and only the
`js` target exists.

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
flow run src/main.flow      # build and serve
flow fmt src/main.flow      # format with the pretty printer (--check to verify)
flow migrate old.flow --write  # rewrite the old Rust-style syntax
flow explain src/main.flow  # print placements and cuts
```

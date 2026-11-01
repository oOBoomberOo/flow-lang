# Reflection and JSON serialization

Flow has two layers:

1. **Reflection** (`Flow.Reflect`) turns the *static* type of a value into
   `TypeInfo` metadata.
2. **Serialization** (`Flow.Serialize`) walks that metadata and converts values
   to and from JSON.

Both are ordinary Flow modules. The compiler only resolves the type in
`Reflect.meta` and in the auto `Serialize.encode` / `decode` entry points.

## Reflection

```flow
import Flow.Reflect
import Flow.Serialize
import Flow.Result

type User =
  { name :: Str
  , role :: Role
  , tags :: List Str
  }

data Role = Admin | Member Str

user :: User
user = { name = "Ada", role = Member "gold", tags = ["flow", "json"] }

main :: Html
main = do
  let info = Reflect.meta user
  <pre>{Reflect.describeAll info}</pre>
```

`Reflect.meta` is resolved from the static type of its argument, so it doesn't
inspect the runtime value. The result is a `Reflected` record:

```flow
type Reflected = { root :: TypeInfo, defs :: List (Str, TypeDef) }
type TypeDef = { name :: Str, variants :: List Variant }
type Variant = { name :: Str, args :: List TypeInfo }

data TypeInfo
  = TInt
  | TFloat
  | TStr
  | TBool
  | TUnit
  | TList TypeInfo
  | TTuple (List TypeInfo)
  | TRecord (List (Str, TypeInfo))
  | TRef Str
  | TFun (List TypeInfo) TypeInfo
  | TUnknown Str
```

Named data types are represented by reference (`TRef "Role"`); their shape is
in `defs`. That keeps recursive types finite:

```flow
data Tree = Leaf Int | Node Tree Tree

tree :: Tree
tree = Node (Leaf 1) (Leaf 2)

let info = Reflect.meta tree
-- root: Tree
-- Tree = Leaf Int | Node Tree Tree
```

Helpers:

| Function | Meaning |
|---|---|
| `Reflect.root info` | the metadata for the value's own type |
| `Reflect.defs info` | `[(name, TypeDef)]` for every referenced data type |
| `Reflect.lookup name info` | one definition, if present |
| `Reflect.typeName info` | `Some name` for a `TRef` |
| `Reflect.describe typeInfo` | a compact human-readable type |
| `Reflect.describeAll info` | the root plus every definition |

### What is reflected

* primitives: `Int`, `Float`, `Str`, `Bool`, `()`
* `List a`, tuples, structural records (field names and order)
* data types (constructors, arity and argument types), including generic and
  recursive ones
* `Option a`, `Result e a`, `Json` and user ADTs are normal data types
* `Cell`, `Html`, `Dom`, `Event` and other non-data types become `TUnknown`
* functions become `TFun`

`Reflect.meta` needs a concrete static type. In a polymorphic function, pass a
`Reflected` value from the caller:

```flow
import Flow.Reflect
import Flow.Serialize
import Flow.Result

encodePair :: Reflect.Reflected -> (a, b) -> Result Str Str
encodePair info value = Serialize.encodeWith info value
```

## The JSON standard

`Serialize.encode` returns `Result Str Str`; `Serialize.decode` returns
`Result Str a`:

```flow
case Serialize.encode user of
  Err why -> ...
  Ok text -> case (Serialize.decode text :: Result Str User) of
    Err why -> ...
    Ok loaded -> ...
```

The target type of `decode` comes from context, usually a `let` annotation or a
function argument. The `*With` forms take an explicit `Reflected`:

```flow
let info = Reflect.meta user
Serialize.encodeWith info user
Serialize.decodeWith info text
Serialize.toJsonWith info user
Serialize.fromJsonWith info json
```

`toJsonWith`/`fromJsonWith` work with the `Json` value directly; `encodeWith`/
`decodeWith` add JSON text parsing and encoding.

### Shapes

| Flow value | JSON |
|---|---|
| `Int`, `Float` | number (`Int` decoding rejects fractions) |
| `Str`, `Bool` | string, boolean |
| `()` | `null` |
| `List a` | array |
| tuple | array of its items |
| record | object keyed by field name |
| `None` | `{"None": null}` |
| `Some x` | `{"Some": x}` |
| `Ok x` / `Err e` | `{"Ok": x}` / `{"Err": e}` |
| nullary constructor | `{"Ctor": null}` |
| one-argument constructor | `{"Ctor": value}` |
| multi-argument constructor | `{"Ctor": [a, b, ...]}` |

Tagged constructors keep nested options unambiguous (`Some None` is
`{"Some":{"None":null}}`).

Records require all declared fields; extra JSON fields are ignored. The error
message includes a path:

```text
role.Member: expected a string
pair: expected 2 tuple value(s), got 1
tags: expected an array
```

`Dict k v` and `Set a` are type aliases for lists, so they serialize in that
representation: `Dict` becomes an array of `[key, value]` pairs, `Set` an array
of elements.

### Limits

* Reflection uses the static type; a value whose type is still polymorphic
  cannot be reflected automatically. Pass `Reflected` explicitly.
* Type aliases resolve away, so reflection reports the underlying type. Records
  are structural and anonymous; named data types keep their constructor and type
  names.
* Functions, cells, events and DOM values have metadata but are not
  serializable. Auto `encode`/`decode` reject such a static type at compile time;
  the explicit `*With` forms return an error at runtime instead of writing
  `null`.
* Recursive *records* are not supported by Flow's type resolver; use a data type
  for recursive shapes.
* `Int` is encoded as a JSON number, so values beyond JavaScript's exact integer
  range lose precision. `Float` follows JSON's number representation.

## Files

* `registry/packages/flow/1.0.0/src/reflect.flow` - `TypeInfo`, `Reflected` and the metadata helpers.
* `registry/packages/flow/1.0.0/src/serialize.flow` - the JSON encoder/decoder and error paths.
* `examples/reflect.flow` - a page that prints metadata, encoded JSON and a
  round trip, plus a recursive tree.
* `test/reflect.test.mjs` - metadata, round trips, recursive types, error paths
  and the static-type diagnostics.

# Flow — the type system

Flow's central claim is that **the client/server boundary is a typing artefact**. The
programmer never writes `client` or `server`; they write *effects* — and each effect is a
**capability** whose provider determines where its calls must run. The type checker derives a
*placement* for every expression from the effects it requires, and the compiler cuts the
program exactly where the placements disagree.

This document defines the judgement, the lattice, the cut algorithm, and states precisely
what is and is not guaranteed.

---

## 1. Judgement

```
        Γ ⊢ e : τ ! ε @ p
```

* `Γ` — typing environment (values, constructors, traits, effects, placements)
* `τ` — the type (`Int`, `Str`, `List<τ>`, `{a: τ}`, `τ₁ -> τ₂`, user ADTs, `Html`, `Cell<τ>`, `Event`)
* `ε` — the effect row: a set of effect labels
* `p` — the placement: `neutral ⊑ {client, server} ⊑ cross`

`p` is not an annotation. It is computed by the rules below and exists only inside the
compiler. Source code has no placement syntax except the optional `τ@client` / `τ@server`
escape hatch (documented in §8).

---

## 2. The placement lattice

```
            cross
           /     \
      client     server
           \     /
          neutral
```

```
join : Place × Place → Place
join(neutral, x)      = x
join(client, client)  = client
join(server, server)  = server
join(client, server)  = cross
join(cross, _)        = cross
```

* **neutral** — pure computation; can be duplicated on either side at no cost.
* **client** / **server** — must run on that side (the authority is there).
* **cross** — the node is a *frontier*: parts of it belong to both sides. `cross` is never
  emitted; the cutter (§5) resolves it into two programs.

The key structural rule is that `cross` is a *lattice join*, not an error. A conflict is not
a mistake — it is a boundary that the compiler will build.

---

## 3. Effects are capabilities

An effect declares an interface:

```flow
effect Server {
  fn secret(name: Str) -> Str
  fn now() -> Int
}
```

A `provide` installs a file-level implementation:

```flow
provide Audit with {
  record = fn(msg: Str) -> Unit { Server.log(msg) }
}
```

A `handle Effect with { … } { body }` expression installs a **scoped** capability
handler for `body`; nested handlers restore the previous provider. The handled
effect is removed from the body's row and the handler operations' effects are
added:

```
ε_handle = (ε_body \ {E}) ⊔ ε_ops
```

The **placement of an effect is the join of the placements of its providers**. That is the
whole story:

```
place(ε) = ⊔ { place(E) | E ∈ ε }
place(Server) = server          (installed by the server runtime)
place(Client) = client          (installed by the client runtime)
place(Store)  = server
place(E)      = ⊔ { home(provider_op) | provider of E }   for user effects
```

Consequences worth stating explicitly:

1. **Authority determines location.** You do not say *where* code runs; you say *what it needs*.
   Code that needs a server secret runs on the server. Code that needs the DOM runs on the
   client. Code that needs both is cut.
2. **Moving a capability moves the boundary.** Change a provider from a client lambda to a
   server lambda and the cut relocates itself. This is the property no annotation-based system
   has.
3. **No handler, no call.** A call to `E.op` whose effect has no file-level `provide`
   and no enclosing `handle` is a type error.

Effect rows **accumulate**. There is no subtraction and no row-polymorphic tail in 0.1:

```
ε_call = ε_callee ⊔ {E} ⊔ ε_arguments
```

A declared row `! {A, B}` on a function is an **upper bound**: inference checks
`ε_inferred ⊆ {A, B}` and reports the difference otherwise. Without a declaration the row is
inferred and propagated. This is why Flow programs are usually annotation-free.

---

## 4. Inference rules

### 4.1 Atoms

```
──────────────────────            ──────────────────────────
Γ ⊢ n : Int ! ∅ @ neutral         Γ ⊢ s : Str ! ∅ @ neutral


Γ(x) = τ
──────────────────────
Γ ⊢ x : τ ! ∅ @ neutral
```

A binding is a *name*, not a location: `let t = Server.now()` binds a neutral name whose
*value expression* is placed on the server. The cut happens at the expression, once — not at
every use.

### 4.2 Application

```
Γ ⊢ f : (τ₁,…,τₙ) -> τ ! ε_f @ p_f
Γ ⊢ aᵢ : τᵢ ! εᵢ @ pᵢ            (for each i)

────────────────────────────────────────────────────────────
Γ ⊢ f(a₁,…,aₙ) : τ ! (ε_f ⊔ ⨆εᵢ) @ (p_f ⊔ ⨆pᵢ ⊔ place(ε_f ⊔ ⨆εᵢ))
```

The last join is the important one: **a call inherits the placement of its effects**. This is
how `Server.secret("k")` becomes a server computation without any annotation.

### 4.3 Conditionals

```
Γ ⊢ c : Bool ! ε_c @ p_c
Γ ⊢ e₁ : τ ! ε₁ @ p₁        Γ ⊢ e₂ : τ ! ε₂ @ p₂
─────────────────────────────────────────────────────────
Γ ⊢ if c { e₁ } else { e₂ } : τ ! (ε_c ⊔ ε₁ ⊔ ε₂) @ (p_c ⊔ p₁ ⊔ p₂)
```

`if` has no special typing rule for tiers. When `p_c = client` and `p₁ = server`, the result
is `cross`; §5 decides whether the *client* keeps the `if` (because the branches produce
`Html`) or the *server* does (because the result is data).

### 4.4 Let / generalization

```
Γ ⊢ e₁ : τ₁ ! ε₁ @ p₁
Γ, x : Gen(τ₁, Γ) ⊢ e₂ : τ₂ ! ε₂ @ p₂
────────────────────────────────────────────────────────
Γ ⊢ let x = e₁; e₂ : τ₂ ! (ε₁ ⊔ ε₂) @ (p₁ ⊔ p₂)
```

`let` generalizes free unification variables not bound in `Γ` (Hindley–Milner, level-based).
At runtime a `let` becomes a *reactive thunk* (`R.sig`), so a binding that reads a cell is
re-evaluated when the cell changes. Bindings that contain a request/response cut are
evaluated eagerly (§6.2) because a round trip is a one-shot value, not a stream.

### 4.5 HTML

```
Γ ⊢ e : Html ! ε @ p            (element / component / hole producing Html)
────────────────────────────────────────────────────
Γ ⊢ html { … e … } : Html ! ε @ client ⊔ p
```

`Html`, `Cell<τ>` and `Event` are **client-only types**. `typePlace` propagates: a container of
a client-only type is itself client-only. This is what guarantees that a markup tree can never
be built on the server — the server has no DOM.

```
──────────────────────────────
Γ ⊢ html { <p>…</p> } : Html ! ε @ client
```

A hole accepts `Html` (nested tree), a primitive (rendered as text), or any value (rendered
structurally by `show`). Event attributes have type `(Event) -> Unit`.

### 4.6 Traits

```
Γ ⊢ e : τ ! ε @ p
instance D : Show ⟨τ⟩            (resolved by matching the first argument's type)
──────────────────────────────────────────────────────────────
Γ ⊢ Show.show(e) : Str ! ε @ p    ⇒    $impl_Show_0_show(e)
```

Dispatch is **static dictionary passing**. `resolveImpl` unifies the instance head
(`impl Show for List<a>`) against the argument type in a rolled-back substitution, so a failed
attempt never pollutes inference. Generic instances are allowed and dispatch on the *head*
constructor; the dictionary is monomorphic after resolution.

A bounded type parameter (`fn render<a: Show>(x: a)`) compiles to a hidden
dictionary parameter. Each call supplies the instance dictionary, and a bounded
generic instance (`impl Show<a> for List<a> where a: Show`) closes over the
dictionary for its element type. Calling a trait method on a type variable
without the matching bound is rejected at the call site.

Traits still dispatch on one parameter: the type after `for` is the dispatch key.
A parameter may itself be a type constructor (`trait Functor<f>`); `f<a>` is a
higher-kinded application, normalized to `List<a>` / `Option<a>` after unification,
and impls are written at the constructor (`impl Functor for List`). Dispatch uses
the head constructor of the constructor-typed argument.

### 4.7 Exhaustiveness

For a scrutinee whose type is a known ADT, if no arm is a wildcard or binder, every
constructor must appear:

```
ctors(τ) \ { c | c appears in an arm } = ∅      otherwise: error
```

---

## 5. From typing to two programs

### 5.1 `home`: resolving `cross`

```
home(e) = p                    if p ∈ {neutral, client, server}
home(e) = resolve(e)           if p = cross
```

`resolve` is deterministic and documented, in priority order:

| # | Rule | Rationale |
|---|------|-----------|
| 1 | If `typePlace(τ(e))` is one-sided, that side wins | an `Html` value cannot exist on the server |
| 2 | `App`: the callee's home wins | compute where the function lives; arguments travel |
| 3 | `If`/`Match`/`Block`: the first non-neutral branch wins | follow the work |
| 4 | first non-neutral operand | data flow direction |
| 5 | otherwise **server** | keep computation next to authoritative state |

### 5.2 Cuts

```
cut(e)  ⇔  home(e) ≠ neutral  ∧  home(parent_context) ≠ neutral  ∧  home(e) ≠ home(parent_context)
```

Every cut gets a stable id. Its **free variables** become transport edges:

```
deps(cut) = fv(cut.node) ∩ runtime-locals
```

Two cut modes, chosen by *where the node sits*, not by a flag:

| Context | Mode | Semantics |
|---|---|---|
| render graph (html, cells, derived values) | `reactive` | a stream: the serving side recomputes when deps change and pushes values down |
| inside an event handler | `call` | request/response: the handler `await`s a round trip |

The distinction is forced by the data: render-position dependencies are *signals* (they have a
current value and can be subscribed to); handler-position dependencies are *event locals* that
exist for one instant. Reactive cuts are why Flow never produces request waterfalls in the
render path — there is no request, only graph edges.

### 5.3 Serialization

```
sendable(τ) ⇔ τ is JSON-shaped
```

`Cell<τ>` is transmitted as its *current value* (and re-sent when it changes), so a cell
dependency is legal; `Html`, `Dom`, `Event` and function types are not sendable and produce a
compile error at the cut:

```
value 'f' of type (Int) -> Int cannot cross the server boundary:
  functions are not serializable across the boundary
```

### 5.4 What the compiler emits

For a program with cuts `c₁ … cₙ` it produces:

```
client.js   functions with home = client
            R.serve(ci, …) for cuts with home = client      (uplink servers)
            R.remote(ci, deps) / await R.call(ci, deps)      (consumers)

server.js   functions with home = server
            R.serve(ci, …) for cuts with home = server
            R.remote / R.call for client-owned cuts
```

Neutral functions are emitted on **both** sides. This is *code splitting, not code sharing*: a
pure helper is duplicated rather than shipped over the wire.

---

## 6. Execution model

### 6.1 Dataflow

Every value is a node in a dependency graph:

```
read(x)   registers x as a dependency of the currently computing node
write(m)  invalidates the node and propagates to subscribers
```

`html` holes, dynamic attributes and `let` bindings are all nodes. A server cut is a node
whose computation lives on the other process; its edges are the wire.

### 6.2 Cut modes, concretely

```
reactive:   R.remote("c1", () => ({ user }))       // a signal
call:       await R.call("c1", { clicks })         // a value
```

Both directions use the same protocol; the *client* can serve cuts as well as consume them.
That is what makes server code able to read a client value:

```flow
{"skew: "}{Server.now() - Client.now()}
```

```
cut cut2: reactive server-side  →  R.op("Server","now")() - R.remote("cut3")
cut cut3: reactive client-side  →  R.op("Client","now")()
```

Two cuts, opposite directions, one expression — with no annotation anywhere.

---

## 7. What is guaranteed, and what is not

**Guaranteed.**

1. **No placement errors at runtime.** A value that cannot be serialized cannot cross; a
   DOM value cannot be produced on the server. Both are compile errors.
2. **Every effect has a provider.** A call to an unprovided effect does not type-check.
3. **Provider signatures match.** Each `provide` operation is checked against the declared
   effect signature (in a rolled-back substitution, so polymorphism is preserved).
4. **Exhaustive matches.** Missing constructors are reported at compile time.
5. **Deterministic cuts.** `home` is a pure function of the typed tree; `flow explain` prints
   exactly what the compiler will do.
6. **Per-instantiation effect rows.** Each use of a polymorphic function gets a fresh row, so a
   server callback at one call site does not force another call site server-side.
7. **Checked placement annotations.** `@client` / `@server` on returns, parameters and `let`
   bindings is checked against inference, and direct call arguments against parameters.

**Not guaranteed (0.1).**

1. **No latency model.** The type system does not distinguish "cheap" from "one round trip".
   A `call` cut inside a handler is a real network wait. `flow explain` shows it; nothing
   prevents it.
2. **No at-most-once guarantee.** A `reactive` cut whose body performs an effect will re-run
   when its inputs change. Keep effects in `call` cuts (handlers), where they run once per
   event.
3. **Single session.** The server keeps one logical session; multi-user isolation is future
   work.
4. **No separate compilation.** The cut requires whole-program analysis, exactly as in
   Ur/Web and Electric. Client and server must be deployed atomically.

---

## 8. Placement annotations

A type may carry an explicit placement:

```flow
fn render(x: Str) -> Html@client { … }
```

The annotation is checked against inference:

* a function return annotation must agree with the body's inferred placement;
* a parameter annotation must agree with each direct call argument;
* a `let` binding annotation must agree with the value's placement.

Neutral and `cross` expressions remain compatible with either side; the compiler
reports `placement mismatch` when a concrete client value is annotated `@server`
or vice versa. The annotation records and checks intent; it does not decide the
cut — `flow explain` remains the authoritative view of placement.

---

## 9. Where this sits in the literature

| System | Placement decided by | Control flow across the boundary |
|---|---|---|
| **Flow** | effect → capability → provider | dataflow edges (reactive) + awaited calls (handlers) |
| Links (2006) | `client`/`server` annotations + effect types | CPS-translated continuations, state on the client |
| Hop (2006) | `*` annotations | native call/return, serialized continuations |
| Opa (2009) | slicer over annotations | AJAX + marshalling, compiler-generated |
| Ur/Web (2015) | type-directed, whole program | typed RPC, monadic transactions |
| ScalaLoci (2018) | placement types (`placed`) | remote calls with peer types |
| Electric (2021–) | explicit `e/server` at leaves, inferred cut | streaming dataflow, no continuation moves |

Flow's specific bet is the *capability-first* formulation: `place(effect) = place(provider)`,
so authority, not syntax, is the source of truth. That is a small idea, but it is the one that
lets the boundary move when the implementation moves.

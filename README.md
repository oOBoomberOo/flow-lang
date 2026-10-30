# Flow

A tierless web language where **the client/server boundary is inferred by the type
system** — with modules, packages, a standard library, a language server, and a VS
Code extension that colours the boundary in your editor.

You write one program. Every expression gets a *placement* derived from the authority it
requires — `Client` for the DOM, `Server` for secrets and state, user effects for whatever their
provider needs. Where placements disagree, the compiler cuts the program into a browser bundle
and a server bundle, and turns the seam into a wire.

```flow
effect Server { fn secret(name: Str) -> Str }
effect Client { fn state<a>(init: a) -> Cell<a> }

fn main() -> Html {
  let reveal = Client.state(false);
  html {
    <div class="card">
      <button onClick={fn(e: Event) { reveal.set(not reveal.get()) }}>{"toggle"}</button>
      {if (reveal.get()) {
        <p>{"server says: "}{Server.secret("flag")}</p>
      } else {
        <p>{"nothing to see here"}</p>
      }}
    </div>
  }
}
```

No `"use client"`, no loaders, no API layer, no serialization code. `flow explain` prints what
the type checker decided:

```
cut cut1: reactive server-side block @16 deps=[] type=Str
```

The `if` stays in the browser (branches are markup, and `Html` cannot exist on the server); the
secret is cut out as a server node and fetched only when the branch is taken.

---

## Quickstart

Requires **Node ≥ 22.6** (native TypeScript type-stripping). No dependencies, no build step.

```bash
node bin/flow.mjs check   examples/boundary.flow
node bin/flow.mjs explain examples/boundary.flow
node bin/flow.mjs run     examples/boundary.flow --port 4173 --secret flag=hunter2
# open http://localhost:4173
```

A package with real dependencies:

```bash
cd packages/app
node ../../bin/flow.mjs install .        # vendor flow_modules/, write flow.lock
node ../../bin/flow.mjs check src/main.flow
```

```
examples/hello.flow      markup only
examples/counter.flow    client state + events + components
examples/boundary.flow   if across the boundary, uplink, downlink
examples/adt.flow        sum types, records, exhaustive matching
examples/traits.flow     trait dispatch, generic instances, list patterns
examples/bounds.flow     trait bounds, bounded generic instances, dictionaries
examples/hkt.flow        higher-kinded type parameters (Functor for List/Option)
examples/handler.flow    scoped and nested local capability handlers
examples/net.flow        server-or-client network effect capability
examples/fs.flow         server-side filesystem effect capability
examples/http.flow       request/routing effect capabilities and easy routing
examples/effects.flow    user-defined capability, request/response cut chain

packages/demo/           package with a local module (util.flow)
packages/app/            package with registry dependencies (flow-charts, flow-time)
stdlib/                  std::prelude, list, option, math, random, string, html, log, time, http, net, fs
registry/                a small package registry (index.json + packages/)
```

Tests: `npm test` — **155 tests** across grammar, types, boundaries, modules, packages,
the language server, HTTP capabilities, network capabilities, filesystem capabilities, trait bounds,
higher-kinded types, local handlers and the VS Code extension.

---

## Editor support

```
$ node src/lsp/server.ts     # LSP on stdio
```

* **Syntax highlighting** — TextMate grammar (`vscode-extension/syntaxes/flow.tmLanguage.json`).
* **Boundary colouring** — client code washed blue, server code amber, every inferred cut
  underlined in violet. Hover a region to see `reactive cut cut1 → server (deps: token)`.
* **Inlay hints** — `fn render server`, `let total: Int`: the boundary is visible inline.
* **Code lenses** — `client · 2 cuts` above each function; status bar `Flow · client 6 · server 0 · cuts 2`.
* **Diagnostics** — every type error in the package, with quick fixes (*make public*, *import*).
* **Completion** — keywords, locals, package symbols, module members after `::`, fields and
  Cell members after `.`.
* **Navigation** - go-to-definition (including from `use` lines, effects, effect operations and
  builtin types such as `Html`/`List`/`Int`), find references, rename
  (package-wide for globals, scoped for locals), document/workspace symbols.
* **Editing** — signature help, folding, selection ranges, document highlights, formatting.

Install the extension: `npm run package:extension && code --install-extension build/flow-language.vsix --force`
(add `--profile "<name>"` if your workspace uses a VS Code profile).

Details: [`docs/editor.md`](editor.md).

---

## The idea in one paragraph

Most "full-stack" tools make you *write* the boundary: file directives, server actions, RPC
stubs. Flow makes the boundary a **consequence of the types**. Every effect is a capability; the
placement of an effect is the placement of its provider; a call inherits the placement of its
effects. When a client-placed context and a server-placed computation meet, the join is `cross` —
not an error, but a frontier the compiler resolves by data-flow direction. The result is two
programs that cooperate, generated from one typed tree, with no continuation ever serialized: the
seam is an edge in a dataflow graph.

Full details: [`docs/type-system.md`](docs/type-system.md).

---

## What you get

**A real type system**

```flow
type Shape = Circle(Float) | Rect(Float, Float) | Triangle(Float, Float, Float)

fn area(s: Shape) -> Float {
  match s {
    Circle(r) => 3.141592653589793 * r * r,
    Rect(w, h) => w * h,
    Triangle(a, b, _) => 0.5 * a * b,
  }
}
```

* Hindley–Milner inference, let-generalization, universal polymorphism
* Algebraic data types, records, tuples, lists — with **exhaustiveness checking**
* **Traits** with static dictionary dispatch and generic instances
* **Trait bounds** - `fn render<a: Show>(x: a)` and bounded generic instances
  (`impl Show<a> for List<a> where a: Show`) with dictionary passing at call sites
* **Higher-kinded type parameters** - `trait Functor<f>` with `f<a>` / `f<b>`;
  instances at the constructor (`impl Functor for List`), dispatch by head constructor
* **Local capability handlers** - `handle Effect with { … } { body }` scopes a
  provider, nests/restores correctly, and removes the handled effect from the row
* **HTTP capabilities** - `std::http` declares `Request` and `Router` as effect
  capabilities, with easy `get`/`post` route helpers and a host-backed dispatcher
* **Network** - `std::net` is a placement-neutral `Net` effect capability with
  callback-based `get`/`post`/`put`/`del` requests on the client or the server
* **Server filesystem** - `std::fs` is an `Fs @ server` effect capability over Node
  `fs`: text read/write/append, directories, stat, existence and temp paths
* **Effect rows** on arrows, inferred and propagated; declared rows are checked upper bounds
* **Placement inference** - the thing no other mainstream language does
* **Checked placement annotations** - `@client` / `@server` on returns, parameters and
  `let` bindings; effect rows are per-instantiation, so one server call does not poison
  unrelated call sites
* **Unsafe FFI** - `unsafe extern js fn sqrt(x: Float) -> Float = "Math.sqrt"`; the
  standard library (logging, timing, arithmetic, strings, lists) is built on it rather
  than on compiler-emitted primitives

**Modules, packages, and a standard library**

```flow
use app::dashboard::{Card, bars}
use flow-charts::bar::Chart
use flow-time::format::hms
use std::list::map
```

* `pub` visibility, compile-time linking, deterministic name qualification on collision
* `flow.json` manifest, `flow install` / `flow add`, `flow_modules/`, `flow.lock` with
  `sha256` integrity per package, semver ranges (`^`, `~`, exact, `*`)
* A registry (`registry/index.json`) with real packages, plus `std` (resolved by the compiler)
* The standard library is written in Flow and compiled with your program

**Native markup and events**

```flow
html {
  <div class="card">
    <h1>{"Counter"}</h1>
    <button onClick={fn(e: Event) { n.set(n.get() + 1) }}>{"+1"}</button>
    <Counter n={n.get()} />
  </div>
}
```

**Two cut modes, chosen by context — not by a flag**

| Where the cut sits | Emitted | Semantics |
|---|---|---|
| render path (`html`, cells) | `R.remote(id, deps)` | a stream; no request, no waterfall |
| inside an event handler | `await R.call(id, args)` | one round trip per event |

Because the transport is symmetric, the *server* can consume client values too:

```flow
{"skew: "}{Server.now() - Client.now()}
```

```
cut cut2: reactive server-side block @28  →  Server.now() - R.remote("cut3")
cut cut3: reactive client-side block @28  →  Client.now()
```

---

## Repository layout

```
src/
  lexer.ts        tokens with source offsets
  parser.ts       recursive descent + Pratt; native HTML; `use`/`pub`
  ast.ts          syntax tree
  types.ts        unification, effect rows, placement lattice, sendability
  infer.ts        Γ ⊢ e : τ ! ε @ p — inference, traits, exhaustiveness, providers
  codegen.ts      home assignment, cut detection, dual emission
  modules.ts      package discovery, import resolution, linking, AST rewriting
  pkg.ts          manifest, semver, registry, install, lockfile, integrity
  analysis.ts     editor-facing analysis (diagnostics, regions, typed nodes)
  host.ts         HTTP host: shell, bundles, SSE down, POST up
  cli.ts          check / explain / build / run / install / add / verify / registry
  lsp/server.ts   language server (stdio JSON-RPC, no dependencies)
  runtime/
    core.js       dependency-tracking dataflow + symmetric transport + capabilities
    dom.js        el / text / hole / attr / mount
    client.js     browser entry (served at /runtime/client.js)
    server.js     server entry + SSE hub
stdlib/           prelude, list, option, math, random, string, html, log, time (written in Flow)
registry/         index.json + packages/{flow-charts,flow-time}
packages/         demo (local modules), app (registry dependencies)
vscode-extension/ package.json, tmLanguage grammar, extension.js
docs/
  grammar.ebnf    normative grammar
  type-system.md  judgement, lattice, cut algorithm, guarantees
  language.md     practical guide
  modules.md      modules, packages, registry, standard library
  editor.md       LSP protocol and VS Code extension
test/
  grammar.test.mjs          38 lexical/grammar tests
  typecheck.test.mjs        31 type-system and boundary tests
  modules.test.mjs          17 module/package/stdlib tests
  lsp.test.mjs              6 language-server tests
  e2e.test.mjs              4 end-to-end transport tests
  vscode-extension.test.mjs 4 extension tests
```

---

## Guarantees (and the ones you do not get)

Compile-time: no un-sendable value crosses a cut; `Html` can never be produced on the server;
every effect call has a provider whose signature matches; every `match` is exhaustive; every
imported name exists and is `pub`; installed packages match their lockfile hashes; cuts are
deterministic and printable; annotated placements are checked and effect rows are
per-instantiation.

Not in 0.1: latency is not modelled (a handler cut is a real round trip); reactive cuts re-run
their body when inputs change, so side effects belong in handler cuts; one session per server;
whole-program compilation means client and server deploy atomically; no publishing command
(copy into `registry/`).

`docs/language.md §13` lists every remaining limitation explicitly.

---

## Related work

The idea is old and good. Links (2006) proved "web programming without tiers"; Hop, Opa and
Ur/Web each built a real implementation; ScalaLoci gave placement types; Electric Clojure
(formerly Hyperfiddle Photon) showed that a reactive dataflow cut removes the request waterfall
in practice. Flow's specific bet is **capability-first placement**:
`place(effect) = place(provider)`, so authority — not syntax — is the source of truth, and
moving an implementation moves the boundary with it.

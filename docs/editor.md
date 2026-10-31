# Flow — editor support

Two pieces, both dependency-free:

* `src/lsp/server.ts` — the language server (stdio, JSON-RPC).
* `vscode-extension/` — the VS Code client: syntax highlighting, every provider
  below, and **colouring of the inferred client/server boundary**.

The server derives everything from one compile, so hover, completion, definitions,
inlay hints and the boundary can never disagree with the compiler.

---

## 1. Language server

```bash
node src/lsp/server.ts          # LSP on stdin/stdout
```

### Feature matrix

| LSP request / notification | Behaviour |
|---|---|
| `textDocument/didOpen/didChange/didSave/didClose` | incremental sync over an in-memory overlay, so **unsaved buffers analyse correctly**. `didChange` is debounced (150 ms) and bursts of keystrokes are coalesced; the analysis is compared against the previous input so identical text is not recompiled |
| `textDocument/publishDiagnostics` | **every** type error in the package (not just the first), plus parser/module/link errors, published per file. Editor mode recovers at declaration boundaries, so one broken declaration does not blank the file |
| `textDocument/semanticTokens/full` | keywords, types, constructors, functions, strings, numbers, comments, operators + `client` / `server` / `cut` / `boundary` modifiers |
| `textDocument/hover` | resolved type (inferred types included, for local `let` bindings, function and lambda parameters and `case` pattern variables), placement, effect row, and where a symbol is declared; works on variables, parameters and local bindings, constructors, function declarations (showing the inferred signature), type names (built-in description or `data`/`type`/`class`/`effect` definition) and imported names |
| `textDocument/completion` | keywords, locals in scope, every symbol in the package, **the std module list after `Flow.`**, **a module's public members after `Module.` / `Flow.List.` / `Module.no`**, unimported names (with an import edit), **fields and Cell members after `.`** (`value`, `get`, `set`, `update`); prefix-ranked and deduplicated |
| `textDocument/definition` | variables, constructors, components, effect names, effect operations, builtin types (`Html`, `List`, `Int`, …) and names on `use` lines → the declaring file/range |
| `textDocument/references` | every occurrence of a global (unique final name) or a scoped local |
| `textDocument/documentSymbol` | functions, types, constructors, traits, effects, records |
| `workspace/symbol` | search the whole package graph |
| `textDocument/signatureHelp` | parameter list, return type, effect row, active parameter |
| `textDocument/inlayHint` | **` client` / ` server` badge on every function**, ` cut1→server` on each cut, plus inferred `: Type` on unannotated `let` bindings |
| `textDocument/foldingRange` | brace regions and block comments |
| `textDocument/selectionRange` | the AST ancestor chain at the cursor |
| `textDocument/documentHighlight` | occurrences of the symbol under the cursor |
| `textDocument/formatting` | re-indent by nesting depth (idempotent) |
| `textDocument/codeAction` | *Export 'f' from this module*, *Import 'x' from Module*, *Add `module X where`* / *Rename the module to `X`* for a missing or mismatched header |
| `textDocument/codeLens` | `client · 2 cuts` above each function, plus crossings when present |
| `textDocument/prepareRename` + `rename` | rename globals across the package; rename locals only inside their declaration |
| `flow/boundary` | placement regions for the whole package, one entry per file |

### Typing latency

Typing must never wait for a full compile:

* **Debounced analysis.** `didChange` schedules one analysis 150 ms after the
  last keystroke; another keystroke replaces the pending one. Requests the user
  initiates (completion, hover, definition, symbols, rename, …) flush the pending
  analysis first, so they still see the text just typed. Semantic tokens and
  inlay hints never flush — they answer immediately from the current text and the
  last analysis.
* **Text before requests.** The VS Code client sends the current document text
  immediately before position-sensitive requests (completion, hover, definition,
  references, signature help, highlights), so a request cannot be answered
  against the previous line or fall back to the global symbol list.
* **Active-file focus.** Switching editors sends `flow/activate`; the server
  reanalyses the file you switched to and its imports, so a module the package
  entry does not import (or a file in another package) still gets diagnostics,
  symbols, completion and boundary colouring.
* **No std preload.** Analysis compiles only the modules the program imports.
  Completion's view of `Flow.List.`, `Flow.Option.` and the other std namespaces comes from a
  cached index that parses the std
  library once (`stdModules()`), instead of type-checking all of it on every
  keystroke.
* **No shared unification state.** Type variables and their bindings are reset at
  the start of each compile. They used to be process-global and accumulate, so
  every speculative `snapshotSubst()` copied the bindings of all previous
  compiles; a long editing session got slower and slower.
* **Cached inputs.** File contents are cached by mtime, and unchanged input skips
  the compile entirely.

Measured on this repository (`examples/http.flow`, release Node): 452–578 ms per
analysis before, 66–80 ms after; a 20-module/882-declaration package went from
3.4 s growing to 19.4 s across runs to ~1–2 s stable. With a 150 ms debounce a
typing burst produces one analysis, and completion answers in single-digit ms.

### Error resilience

Editor analysis runs with recovery enabled: the parser skips a broken declaration
and keeps the rest, type errors are collected per function, and module imports that
fail do not discard the file. Symbols, semantic tokens, hover, definitions and
completion therefore keep working while the buffer has errors; the diagnostic list
still shows them. `flow check` / `build` keep the strict behaviour and fail on the
first error.

Paths work without imports: `Flow.List.length xs` (or the short `List.length xs` when nothing
local claims `List`) loads the module on demand, and completion offers module members after
`Flow.List.` / `List.` / `Option.` even before any `import` is written. Typing `Flow.` lists
the std modules.

`flow/boundary` is the Flow-specific piece: LSP tokens can colour a *token*, but the
thing worth seeing is a **region** — "these twelve lines run on the server".

```json
{
  "regions": [
    { "kind": "function", "side": "client", "range": {…}, "label": "Main.main runs on client" },
    {
      "kind": "cut",
      "side": "server",
      "direction": "client→server",
      "cutId": "cut1",
      "mode": "reactive",
      "deps": ["token"],
      "type": "Str",
      "parent": "Main.main",
      "range": {…},
      "label": "client→server reactive cut cut1 in Main.main → server (deps: token) : Str"
    },
    { "kind": "crossing", "side": "server", "direction": "mixed→server", "type": "Int", "range": {…}, "label": "…" }
  ],
  "summary": { "client": 6, "server": 0, "cuts": 2, "crossings": 1 }
}
```

A **cut** is a node the compiler moved to the other tier; `direction` says which way the
value now travels (`client→server` or `server→client`). A **crossing** is an expression
whose value mixes both sides and is resolved without a whole cut (e.g. `Server.now() -
Client.now()`), so it gets a lighter marker instead of an underline. Neutral functions
(pure code duplicated on both sides) are not reported — there is nothing to colour.

In the VS Code client:

* a cut that runs work on the server gets a violet underline, a **→ gutter arrow**, a
  centre overview-ruler mark and an inline ` → server` label;
* a cut that pulls a value back to the client gets the blue **←** variant;
* a crossing gets a dotted underline, a **⇄ gutter arrow** and ` ⇄ mixed`;
* hovering any marker shows cut id, direction, mode, deps, type and the enclosing function;
* every cut also gets an inlay hint (` cut1→server`), and the status bar / code lens count
  cuts and crossings.

The markers are refreshed by `flow/boundaryChanged`, which the server emits after every
`didOpen` / `didChange` / `didSave` and on watched-file changes, so they stay live while
you type.

### How analysis works

1. Find the package for the open file (walk up to `flow.json`); the entry is
   `src/main.flow` (or the file itself in single-file mode).
2. Compile with an **overlay** of unsaved buffers (`Linker({ overlay })`) and
   `collectErrors: true`, so every error is reported.
3. On success, walk the typed tree: every node carries a span *and its file*, a
   placement, a type, its record fields and — for calls — the callee's signature.
4. The linker also hands over a symbol index (`finalName` → declaration site), which
   is what definition/references/rename/symbols are built on.

---

## 2. VS Code extension

```
vscode-extension/
  package.json                  language contribution, grammar, commands, settings
  syntaxes/flow.tmLanguage.json TextMate grammar (base highlighting)
  language-configuration.json   brackets, comments, auto-closing
  extension.js                  LSP client + all providers + decorations
```

### Install (packaged, self-contained)

```bash
npm run extension:install            # build -> build/flow-language.vsix, then install it
# or, separately:
npm run package:extension
code --install-extension build/flow-language.vsix --force
```

If your workspace runs a **profile**, install into that profile too:

```bash
code --install-extension build/flow-language.vsix --force --profile "Minecraft Development"
code --list-extensions --show-versions --profile "Minecraft Development" | grep flow
```

The packaged extension carries `vendor/{src,stdlib,registry,bin}`, so it works in any
workspace — the server, the formatter and `Flow: Explain Boundary` all run from the
bundle.

### Developing Flow itself (no rebuild loop)

Open the Flow checkout in VS Code and the installed extension runs
`<workspace>/src/lsp/server.ts` instead of its own bundled copy. Compiler and stdlib
changes are therefore live without touching the VSIX:

* resolution order is `flow.serverPath` → workspace compiler checkout → bundled vendor;
* saving anything under `src/**/*.ts` or `stdlib/**/*.flow` restarts the language
  server automatically (300 ms debounce) and re-opens the documents you have open;
* `Flow: Restart Language Server` (command `flow.restart`) does the same restart on
  demand; changing `flow.serverPath`, `flow.useWorkspaceServer` or `flow.devWatch`
  restarts it too;
* the **Flow** output channel prints the extension version, the server path and whether
  it came from the workspace, a setting or the bundle, e.g.
  `[flow] extension 0.9.0 · server F:\projects\flow\src\lsp\server.ts (workspace)`.

Point `flow.serverPath` at another checkout (a worktree, a second clone) and the
watcher follows that checkout's `src/` and `stdlib/` instead. Turn
`flow.useWorkspaceServer` off to compare against the packaged compiler, and
`flow.devWatch` off to restart manually only.

Changing the **client** (`extension.js`, `vscode-extension/package.json`, the grammar)
still needs `npm run extension:install` and a window reload, because VS Code loads the
extension host code once per window. Compiler/stdlib work does not.


### Completion and refactors

**Brackets and markup.** Brackets, quotes and block comments auto-close. Inside
markup, typing `<di` offers `div` and inserts `<div></div>` with the cursor
between the tags; void tags (`<input>`, `<br>`, `<img>`, …) insert self-closed
with the cursor in the attribute position; components insert
`<Card ></Card>`. Typing `</` offers `</tag>` for the innermost open tag and every
enclosing tag. Attributes are suggested inside a tag with the right shape:
`class="${0}"`, `onClick={${0}}`, `checked={${0}}`. Opening tags indent, closing
tags outdent.

**Rename.** F2 renames a local or a package-wide symbol and now also rewrites
`import Module (name)` lists, so renaming a public function does not leave broken
imports behind.

**Refactors.** Available from the lightbulb menu and the command palette:

| command | effect |
|---|---|
| `Flow: Import Symbol` | quick-pick an unimported public symbol and insert `import Module (name)` |
| `Flow: Move Symbol to Module` | move the top-level declaration at the cursor to another `.flow` file, adding the target import in the source and the needed imports in the target |
| `Flow: Organize Imports` | sort the leading import block, merge duplicate module imports and de-duplicate names |

Code actions also offer `Import symbol…`, `Move 'name' to another module…` and
`Organize imports` directly. Move Symbol refuses declarations that use private
helpers from their old module (the error names them) so a move cannot silently
break.

### What you see

* **Syntax highlighting** from the TextMate grammar.
* **Boundary colouring**: client code washed blue, server code amber, every inferred
  cut underlined in violet; hovering a region shows its label.
* **Inlay hints**: `render server`, `let total :: Int` — the boundary is visible
  without opening a panel.
* **Code lenses**: `client · 2 cuts` per function.
* **Status bar**: `Flow · client 6 · server 0 · cuts 2`.
* **Diagnostics as you type**, with quick fixes.
* Completion, hover, go-to-definition, references, rename, signature help, folding,
  selection ranges, highlights and formatting — all backed by the server.

### Settings

| setting | default | meaning |
|---|---|---|
| `flow.clientColor` | `rgba(80, 140, 255, 0.16)` | client background |
| `flow.serverColor` | `rgba(255, 150, 60, 0.16)` | server background |
| `flow.cutColor` | `rgba(190, 90, 255, 0.55)` | cut underline |
| `flow.enableDecorations` | `true` | toggle colouring |
| `flow.serverPath` | `""` | explicit `src/lsp/server.ts`; overrides auto-detection |
| `flow.useWorkspaceServer` | `true` | in a compiler checkout, run its server instead of the bundle |
| `flow.devWatch` | `true` | restart the server when the checkout's compiler/stdlib changes |

### Commands

| command | effect |
|---|---|
| `Flow: Explain Boundary` | runs `flow explain` into an output channel |
| `Flow: Toggle Boundary Colouring` | flips decorations |
| `Flow: Restart Language Server` | restarts the process |
| `Flow: Import Symbol` | add an import for an unimported public symbol |
| `Flow: Move Symbol to Module` | move a top-level declaration to another file, fixing imports |
| `Flow: Organize Imports` | sort and merge the import block |

---

## 3. Tests

| file | covers |
|---|---|
| `test/lsp.test.mjs` | initialize, diagnostics, open/edit, semantic tokens, hover, boundary |
| `test/lsp-features.test.mjs` | completion (3 kinds), markup tag/attribute snippets, closing-tag completion, definition, references, highlights, rename with imports, symbols, signature help, inlay hints, folding, selection, formatting idempotence, code actions, import/move/organize refactors, code lens, multi-error reporting |
| `test/lsp-resilience.test.mjs` | module-path completion without imports, symbols/hover/completion/semantic tokens during syntax and type errors, keystroke bursts coalesced into one analysis, Cell dot completion |
| `test/vscode-extension.test.mjs` | the real `extension.js` against a mock host: 15 providers registered, decorations applied, diagnostics delivered, providers return real server results, checkout-vs-bundle server resolution, auto-restart on compiler saves, refactor commands and tag completion snippets |

```
$ node --test test/lsp.test.mjs test/lsp-features.test.mjs test/vscode-extension.test.mjs
# pass 16
# fail 0
```

That is as close to "it works in VS Code" as you can get without a display: the real
client code, the real protocol, the real server.

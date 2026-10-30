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
| `textDocument/didOpen/didChange/didSave/didClose` | incremental sync over an in-memory overlay, so **unsaved buffers analyse correctly** |
| `textDocument/publishDiagnostics` | **every** type error in the package (not just the first), plus parser/module/link errors, published per file. Editor mode recovers at declaration boundaries, so one broken declaration does not blank the file |
| `textDocument/semanticTokens/full` | keywords, types, constructors, functions, strings, numbers, comments, operators + `client` / `server` / `cut` / `boundary` modifiers |
| `textDocument/hover` | inferred type, placement, effect row, and where a symbol is declared; works on `use` lines too |
| `textDocument/completion` | keywords, locals in scope, every symbol in the package, **modules after `std::`**, **module members after `std::list::`**, unimported names (with an import edit), **fields and Cell members after `.`** (`value`, `get`, `set`, `update`); prefix-ranked and deduplicated |
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
| `textDocument/codeAction` | *Make 'f' public*, *Import 'x' from pkg::mod* |
| `textDocument/codeLens` | `client · 2 cuts` above each function, plus crossings when present |
| `textDocument/prepareRename` + `rename` | rename globals across the package; rename locals only inside their declaration |
| `flow/boundary` | placement regions for the whole package, one entry per file |

### Error resilience

Editor analysis runs with recovery enabled: the parser skips a broken declaration
and keeps the rest, type errors are collected per function, and module imports that
fail do not discard the file. Symbols, semantic tokens, hover, definitions and
completion therefore keep working while the buffer has errors; the diagnostic list
still shows them. `flow check` / `build` keep the strict behaviour and fail on the
first error.

Paths work without imports: `std::list::length(xs)` loads `std::list` on demand,
and completion offers modules after `std::` and members after `std::list::` even
before any `use` is written.

`flow/boundary` is the Flow-specific piece: LSP tokens can colour a *token*, but the
thing worth seeing is a **region** — "these twelve lines run on the server".

```json
{
  "regions": [
    { "kind": "function", "side": "client", "range": {…}, "label": "app::main::main runs on client" },
    {
      "kind": "cut",
      "side": "server",
      "direction": "client→server",
      "cutId": "cut1",
      "mode": "reactive",
      "deps": ["token"],
      "type": "Str",
      "parent": "app::main::main",
      "range": {…},
      "label": "client→server reactive cut cut1 in app::main::main → server (deps: token) : Str"
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
npm run package:extension            # -> build/flow-language.vsix (bundles the compiler)
code --install-extension build/flow-language.vsix --force
```

If your workspace runs a **profile**, install into that profile too:

```bash
code --install-extension build/flow-language.vsix --force --profile "Minecraft Development"
code --list-extensions --show-versions --profile "Minecraft Development" | grep flow
```

The packaged extension carries `vendor/{src,stdlib,registry,bin}`, so it works in any
workspace — the server, the formatter and `Flow: Explain Boundary` all run from the
bundle. In a checkout it prefers `src/lsp/server.ts` from the workspace, so edits are
picked up live.

### What you see

* **Syntax highlighting** from the TextMate grammar.
* **Boundary colouring**: client code washed blue, server code amber, every inferred
  cut underlined in violet; hovering a region shows its label.
* **Inlay hints**: `fn render server`, `let total: Int` — the boundary is visible
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
| `flow.serverPath` | `""` | explicit server path |

### Commands

| command | effect |
|---|---|
| `Flow: Explain Boundary` | runs `flow explain` into an output channel |
| `Flow: Toggle Boundary Colouring` | flips decorations |
| `Flow: Restart Language Server` | restarts the process |

---

## 3. Tests

| file | covers |
|---|---|
| `test/lsp.test.mjs` | initialize, diagnostics, open/edit, semantic tokens, hover, boundary |
| `test/lsp-features.test.mjs` | completion (3 kinds), definition, references, highlights, rename, symbols, signature help, inlay hints, folding, selection, formatting idempotence, code actions, code lens, multi-error reporting |
| `test/lsp-resilience.test.mjs` | module-path completion without imports, symbols/hover/completion/semantic tokens during syntax and type errors, Cell dot completion |
| `test/vscode-extension.test.mjs` | the real `extension.js` against a mock host: 15 providers registered, decorations applied, diagnostics delivered, providers return real server results |

```
$ node --test test/lsp.test.mjs test/lsp-features.test.mjs test/vscode-extension.test.mjs
# pass 16
# fail 0
```

That is as close to "it works in VS Code" as you can get without a display: the real
client code, the real protocol, the real server.

# Flow — editor support

Two pieces:

* `src/lsp/server.ts` — a dependency-free language server (stdio, JSON-RPC).
* `vscode-extension/` — the VS Code client: syntax highlighting, diagnostics,
  hover, and **colouring of the inferred client/server boundary**.

---

## 1. Language server

```bash
node src/lsp/server.ts          # speaks LSP on stdin/stdout
```

### Capabilities

| capability | behaviour |
|---|---|
| `textDocumentSync` | incremental (changes are applied to an in-memory overlay, so unsaved buffers analyse correctly) |
| `textDocument/publishDiagnostics` | whole-package diagnostics, published per file |
| `textDocument/semanticTokens/full` | keywords, types, constructors, functions, strings, numbers, comments, operators — plus `client` / `server` / `cut` / `boundary` modifiers |
| `textDocument/hover` | inferred type, placement and effect row of the innermost node |
| `flow/boundary` | placement regions for a file: `{ regions, summary }` |
| `flow/boundaryChanged` | server push of the same payload after every change |
| `flow/status` | analysis state (entry, module list) |

Semantic-token legend:

```
tokenTypes:     keyword function variable type class string number
                comment operator parameter property namespace
tokenModifiers: client server cut boundary
```

### Why `flow/boundary` exists

LSP semantic tokens can *decorate* a token, but the thing worth seeing is a **region**:
"these twelve lines run on the server". So the server also reports ranges:

```json
{
  "regions": [
    { "kind": "function", "side": "client", "range": {…}, "label": "main runs on client" },
    { "kind": "cut", "side": "server", "range": {…}, "label": "reactive cut cut1 → server (deps: token)" }
  ],
  "summary": { "client": 1, "server": 0, "cuts": 1 }
}
```

Each region carries its file URI, so a package with several modules colours each file
independently: `flow/boundary` always returns the **whole package**, and the editor maps each
region to the document it belongs to. Neutral functions (pure code duplicated on both sides)
are not reported — there is nothing to colour.

### How analysis works

1. Find the package for the open file (walk up to `flow.json`); the entry is
   `src/main.flow` (or the file itself in single-file mode).
2. Compile with an **overlay** of unsaved buffers (`Linker({ overlay })`).
3. On success, walk the typed tree: every node has a `span` (with its file) and a
   placement; cuts come from the code generator.
4. On failure, map the `FlowError` position to a range and publish one diagnostic.

---

## 2. VS Code extension

```
vscode-extension/
  package.json                 language contribution, grammar, commands, settings
  syntaxes/flow.tmLanguage.json TextMate grammar (base highlighting)
  language-configuration.json  brackets, comments, auto-closing
  extension.js                 LSP client + decorations + commands
```

### Install (development)

```bash
# from the Flow repo
code --extensionDevelopmentPath="$PWD/vscode-extension" .
```

### Install (packaged, self-contained)

```bash
npm run package:extension            # -> build/flow-language.vsix (bundles the compiler)
code --install-extension build/flow-language.vsix --force
code --list-extensions --show-versions | grep flow
# flow-lang.flow-language@0.2.0
```

The packaged extension carries `vendor/{src,stdlib,registry,bin}`, so it works in any
workspace — the language server and `Flow: Explain Boundary` run from the bundle. In a
checkout it prefers `src/lsp/server.ts` from the workspace, so edits are picked up.

or copy `vscode-extension/` into `~/.vscode/extensions/flow-language-0.2.0/`.

The extension auto-detects the server; override with `flow.serverPath`.

### What you see

* **Syntax highlighting** from the TextMate grammar.
* **Boundary colouring**: client-placed code gets a blue wash, server-placed code an
  amber wash, and every inferred cut gets a violet underline. Hovering a region shows
  its label (`reactive cut cut1 → server (deps: token)`).
* **Status bar**: `Flow · client 2 · server 1 · cuts 3`.
* **Diagnostics** as you type (type errors, module errors, split errors).
* **Hover**: `Str` / `Placement: server` / `Effects: {Server}`.

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
| `Flow: Explain Boundary` | runs `flow explain` on the active file into an output channel |
| `Flow: Toggle Boundary Colouring` | flips decorations |
| `Flow: Restart Language Server` | restarts the process |

---

## 3. Tests

`test/lsp.test.mjs` drives the server over stdio exactly as an editor would:
initialize, open, edit, diagnostics, semantic tokens, hover, boundary.

`test/vscode-extension.test.mjs` loads `extension.js` against a mock `vscode` module,
starts the real server, opens a document, and asserts that three decoration types are
created and applied with non-empty ranges, and that diagnostics reach the collection.

```
$ node --test test/lsp.test.mjs test/vscode-extension.test.mjs
# pass 10
# fail 0
```

That is as close to "it works in VS Code" as you can get without a display: the real
extension code, the real protocol, the real server.

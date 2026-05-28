# ABL LSP / VS Code Extension -- Low-Level Design

## Implementation Structure

The feature is implemented across three packages with a clear dependency chain:

```
@abl/core (parsers)
    ^
    |
@abl/language-service (editor-agnostic intelligence)
    ^
    |
@abl/lsp-server (LSP protocol adapter)
    ^
    |
kore-abl (VS Code extension client)
```

---

## Package 1: `@abl/language-service`

### Purpose

Editor-agnostic language intelligence for ABL. Provides diagnostics, completions, hover, and document symbols. Shared across VS Code (via LSP server), and potentially Studio (via Monaco adapter) and CLI tools.

### Key Files

| File                    | LOC (approx) | Purpose                                                                                                                    |
| ----------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `src/types.ts`          | ~93          | All shared types (Position, Diagnostic, CompletionItem, DocumentSymbol, HoverInfo, CompletionContext, CompileFn)           |
| `src/detect-format.ts`  | ~34          | Heuristic: first non-comment line lowercase key -> YAML, uppercase -> legacy                                               |
| `src/diagnostics.ts`    | ~93          | Three-tier diagnostics: Tier 1 (parse errors), Tier 2 (structural warnings), Tier 3 (optional compileFn injection)         |
| `src/completions.ts`    | ~400+        | Context-aware completions engine: analyzes cursor position to determine enclosing section, returns appropriate suggestions |
| `src/hover.ts`          | ~27          | Keyword lookup: extracts word at cursor, normalizes, looks up in KEYWORD_DOCS                                              |
| `src/symbols.ts`        | ~327         | Hierarchical outline: parses document, builds Agent -> Sections -> Items tree                                              |
| `src/docs.ts`           | ~38          | Static keyword documentation map (markdown strings)                                                                        |
| `src/cel-functions.ts`  | ~100+        | Static CEL function metadata registry (name, signature, description, category)                                             |
| `src/serialize-yaml.ts` | ~varies      | YAML serialization utility for agent documents                                                                             |
| `src/index.ts`          | ~31          | Barrel re-exports                                                                                                          |

### Completion Engine Detail

The completions engine (`completions.ts`) is the most substantial module. It determines context by:

1. Checking if cursor is at column 0 or 1 (top-level key completion)
2. Scanning backwards from cursor line to find the enclosing section key
3. Matching the section key to specific completion sets:
   - `tools:` section -> tool names from `CompletionContext.availableTools`
   - `handoff:`/`delegate:` -> agent names from `CompletionContext.availableAgents`
   - `flow:`/`steps:` -> flow step keywords (respond, call, then, gather, when, set, etc.)
   - `gather:` -> field property keywords (name, type, required, prompt, validation, etc.)
   - `constraints:` -> constraint keywords (rule, action, when, message)
   - CEL expression contexts (when, validate, set, condition) -> CEL function names
   - Enum-valued fields (mode, type, action, strategy, priority) -> enum value completions

### Diagnostics Pipeline

```
source string
    |
    v
detectFormat(source) -> 'yaml' | 'legacy'
    |
    v
parseYamlABL(source)  or  parseAgentBasedABL(source)
    |                           |
    v                           v
result.errors -> Tier 1     result.errors -> Tier 1
result.warnings -> Tier 2   result.warnings -> Tier 2
    |
    v
[optional] compileFn(source) -> Tier 3 (not wired in LSP server)
    |
    v
Diagnostic[] with severity, message, line, column, source tag
```

---

## Package 2: `@abl/lsp-server`

### Purpose

Bridges `@abl/language-service` to the Language Server Protocol. Handles LSP lifecycle, document synchronization, workspace scanning, and type conversion.

### Key Files

| File                          | LOC (approx) | Purpose                                                                                         |
| ----------------------------- | ------------ | ----------------------------------------------------------------------------------------------- |
| `src/server.ts`               | ~134         | LSP connection, lifecycle, event handlers, diagnostics debouncing                               |
| `src/capabilities.ts`         | ~12          | ServerCapabilities declaration (textDocSync, completion, hover, documentSymbol)                 |
| `src/workspace-scanner.ts`    | ~118         | Discovers .agent.yaml/.agent.abl files, extracts agent/tool names, caches CompletionContext     |
| `src/adapters/completions.ts` | ~33          | ABL CompletionItem -> LSP CompletionItem (kind mapping, sortText padding)                       |
| `src/adapters/diagnostics.ts` | ~31          | ABL Diagnostic -> LSP Diagnostic (severity mapping, 1-based to 0-based conversion)              |
| `src/adapters/hover.ts`       | ~15          | ABL HoverInfo -> LSP Hover (markdown MarkupContent, position conversion)                        |
| `src/adapters/symbols.ts`     | ~38          | ABL DocumentSymbol -> LSP DocumentSymbol (kind mapping, range construction, recursive children) |

### Server Lifecycle

1. `createConnection(ProposedFeatures.all)` -- creates LSP connection
2. `onInitialize` -- receives workspace folders, returns capabilities
3. `onInitialized` -- triggers initial workspace scan
4. `documents.onDidChangeContent` -- schedules debounced diagnostics
5. `documents.onDidClose` -- clears pending diagnostics, sends empty diagnostics
6. `onCompletion` -- calls `getCompletions` with workspace context
7. `onHover` -- calls `getHoverInfo`
8. `onDocumentSymbol` -- calls `getDocumentSymbols`
9. `onDidChangeWatchedFiles` -- invalidates workspace scanner cache

### Workspace Scanner

- Recursively scans workspace folders for `.agent.yaml` and `.agent.abl` files
- Limits: max 100 files, max depth 5
- Skips: `node_modules`, `dist`, `.git`, `.worktrees`, `coverage`
- Extracts agent names via regex: `^agent:\s*(.+)$` or `^AGENT:\s*(.+)$`
- Extracts tool names from `tools:` section via line-by-line parsing
- Deduplicates agent and tool names across files
- Caches result as `CompletionContext`; invalidated via `invalidate()` on file change events

### Adapter Type Mappings

| ABL Kind   | LSP CompletionItemKind | LSP SymbolKind  |
| ---------- | ---------------------- | --------------- |
| keyword    | Keyword (14)           | -               |
| section    | Module (9)             | Namespace (3)   |
| tool       | Function (3)           | Function (12)   |
| agent      | Class (7)              | Class (5)       |
| function   | Function (3)           | -               |
| field      | Field (5)              | Field (8)       |
| value      | Value (12)             | -               |
| step       | -                      | Method (6)      |
| constraint | -                      | Property (7)    |
| handoff    | -                      | Interface (11)  |
| delegate   | -                      | Event (24)      |
| handler    | -                      | Constructor (9) |

---

## Package 3: `kore-abl` (VS Code Extension)

### Purpose

VS Code extension that activates on ABL files, starts the LSP server, and provides syntax highlighting, snippets, and commands.

### Key Files

| File                                  | Purpose                                                                                                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/extension.ts`                    | Activation: creates LanguageClient, registers validate command, starts server                                     |
| `package.json`                        | Extension manifest: language registrations, grammar paths, snippet paths, commands, activation events             |
| `language-configuration.json`         | Editor behavior: comment style (#), bracket pairs, auto-closing, folding (offSide), indentation rules             |
| `syntaxes/abl-yaml.tmLanguage.json`   | TextMate grammar for YAML ABL: top-level keys, sub-keys, template variables, CEL expressions, block scalars       |
| `syntaxes/abl-legacy.tmLanguage.json` | TextMate grammar for legacy ABL: uppercase section keywords, sub-keywords, template variables                     |
| `snippets/abl.snippets.json`          | 8 snippets: Agent Scaffold, Tool Definition, Flow Step, Constraint, Handoff, Gather Field, Flow Section, Delegate |
| `esbuild.config.mjs`                  | Bundles extension.ts + server.ts from abl-lsp-server into dist/                                                   |
| `.vscodeignore`                       | Files excluded from VSIX package                                                                                  |

### Extension Activation

- Activates on: `onLanguage:abl-yaml`, `onLanguage:abl-legacy`, `workspaceContains:**/*.agent.yaml`
- Server transport: stdio
- Document selector: `{ scheme: 'file', language: 'abl-yaml' }` and `{ scheme: 'file', language: 'abl-legacy' }`
- File watcher: `**/*.agent.{yaml,abl}` (forwarded to LSP server as `onDidChangeWatchedFiles`)

### TextMate Grammar Scopes (YAML format)

| Pattern                 | Scope Name                          |
| ----------------------- | ----------------------------------- |
| `#` comments            | `comment.line.number-sign.abl`      |
| `{{...}}`               | `variable.other.template.abl`       |
| Top-level keys          | `keyword.control.section.abl`       |
| Sub-keys                | `entity.name.tag.abl`               |
| Block scalars `\|`, `>` | `keyword.operator.block-scalar.abl` |
| List items `- `         | `punctuation.definition.list.abl`   |
| Constants               | `constant.language.abl`             |
| Numbers                 | `constant.numeric.abl`              |
| Strings                 | `string.quoted.{double,single}.abl` |
| Arrows `->`, `=>`       | `keyword.operator.arrow.abl`        |
| CEL expressions         | `variable.other.dotted.abl`         |

---

## Known Gaps

| Gap   | Description                                         | Recommendation                                                      |
| ----- | --------------------------------------------------- | ------------------------------------------------------------------- |
| GAP-1 | Tier 3 compile diagnostics not wired                | Wire `@abl/compiler`'s compile function as `compileFn` in server.ts |
| GAP-2 | No go-to-definition for cross-file references       | Requires maintaining a symbol index across workspace files          |
| GAP-3 | No E2E tests for LSP protocol                       | Spawn server via stdio, send JSON-RPC requests, verify responses    |
| GAP-4 | Hover range is point-based                          | Calculate word boundaries in `toLSPHover` adapter                   |
| GAP-5 | Workspace scanner uses sync I/O                     | Acceptable for LSP server; would need async version for Studio      |
| GAP-6 | No Monaco adapter for Studio integration            | Create `@abl/monaco-adapter` wrapping language-service              |
| GAP-7 | Extension not packaged for marketplace distribution | Run `vsce package`, add CI/CD step for VSIX build                   |

---

## Build & Development

```bash
# Build all three packages
pnpm build --filter=@abl/language-service --filter=@abl/lsp-server --filter=kore-abl

# Watch mode (language-service + LSP server)
pnpm dev --filter=@abl/language-service --filter=@abl/lsp-server

# VS Code extension watch (bundles extension + server)
cd packages/abl-vscode && pnpm watch

# Run tests
pnpm test --filter=@abl/language-service --filter=@abl/lsp-server

# Package VSIX
cd packages/abl-vscode && pnpm package
```

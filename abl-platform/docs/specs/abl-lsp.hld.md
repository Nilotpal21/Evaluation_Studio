# High-Level Design: ABL Language Server Protocol & VS Code Extension

- **Feature**: abl-lsp (F017-LSP)
- **Status**: PLANNED
- **Created**: 2026-03-23
- **Last Updated**: 2026-03-23

## 1. Architecture Overview

The ABL developer tooling follows a three-layer architecture that separates language intelligence from protocol transport from editor integration:

```
┌──────────────────────────────────────────────────────────┐
│                   Editor Layer                            │
│                                                          │
│  ┌─────────────────┐    ┌──────────────────────────┐     │
│  │  kore-abl        │    │  Studio (Monaco)          │     │
│  │  (VS Code ext)   │    │  (apps/studio)            │     │
│  │  packages/        │    │  Direct import of         │     │
│  │  abl-vscode       │    │  @abl/language-service    │     │
│  └────────┬──────────┘    └──────────┬───────────────┘     │
│           │ LSP/stdio                │ Direct fn call       │
│           ▼                          │                      │
│  ┌─────────────────┐                 │                      │
│  │  @abl/lsp-server │                 │                      │
│  │  packages/        │                │                      │
│  │  abl-lsp-server   │                │                      │
│  └────────┬──────────┘                │                      │
│           │ fn calls                  │                      │
│           ▼                          ▼                      │
│  ┌───────────────────────────────────────────────────┐     │
│  │              @abl/language-service                  │     │
│  │              packages/language-service              │     │
│  │                                                    │     │
│  │  ┌────────────┐ ┌───────────┐ ┌──────────────┐    │     │
│  │  │ diagnostics │ │completions│ │   symbols     │    │     │
│  │  └──────┬─────┘ └─────┬─────┘ └──────┬───────┘    │     │
│  │         │              │               │            │     │
│  │  ┌──────┴─────┐ ┌─────┴─────┐ ┌──────┴───────┐    │     │
│  │  │   hover     │ │ cel-funcs │ │ serialize    │    │     │
│  │  └──────┬─────┘ └───────────┘ └──────────────┘    │     │
│  │         │                                          │     │
│  │  ┌──────┴──────────────────────────────────────┐   │     │
│  │  │           detect-format + docs               │   │     │
│  │  └──────────────────────────────────────────────┘   │     │
│  └────────────────────────┬──────────────────────────┘     │
│                           │ depends on                      │
│                           ▼                                 │
│  ┌───────────────────────────────────────────────────┐     │
│  │                    @abl/core                       │     │
│  │  parseYamlABL, parseAgentBasedABL,                │     │
│  │  AgentBasedDocument types                         │     │
│  └───────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────┘
```

### Key Design Principles

1. **Editor-agnostic core**: `@abl/language-service` has zero editor/protocol dependencies. It exposes pure functions that accept source text and return typed results.
2. **Protocol adapter layer**: `@abl/lsp-server` translates between LSP JSON-RPC and language service function calls via adapter modules.
3. **Thin client**: The VS Code extension (`kore-abl`) is a minimal client that launches the LSP server and configures document selectors.
4. **Parser delegation**: All parsing is delegated to `@abl/core`. The language service never implements its own parser.
5. **Optional compile tier**: Compile-level diagnostics are opt-in via `CompileFn` injection, keeping the language service free of `@abl/compiler` dependencies.

## 2. Component Design

### 2.1 Language Service (`@abl/language-service`)

**Responsibility**: Provide editor-agnostic language intelligence for ABL source files.

**Module inventory**:

| Module           | Exported Function                            | Input                                     | Output                     | Dependencies                     |
| ---------------- | -------------------------------------------- | ----------------------------------------- | -------------------------- | -------------------------------- |
| `detect-format`  | `detectFormat(source)`                       | source string                             | `'yaml' \| 'legacy'`       | None                             |
| `diagnostics`    | `getDiagnostics(source, opts?)`              | source string, optional CompileFn         | `Diagnostic[]`             | @abl/core parsers, detect-format |
| `completions`    | `getCompletions(source, position, context?)` | source, cursor position, optional context | `CompletionItem[]`         | cel-functions                    |
| `symbols`        | `getDocumentSymbols(source)`                 | source string                             | `DocumentSymbol[]`         | @abl/core parsers, detect-format |
| `hover`          | `getHoverInfo(source, position)`             | source, cursor position                   | `HoverInfo \| null`        | docs                             |
| `docs`           | `KEYWORD_DOCS`                               | N/A (constant)                            | Record of markdown strings | None                             |
| `cel-functions`  | `CEL_FUNCTIONS`                              | N/A (constant)                            | CelFunctionMeta[]          | None                             |
| `serialize-yaml` | `serializeToYAML(ir)`                        | AgentIR (as Record)                       | YAML string                | None                             |

**New modules (P1/P2)**:

| Module            | Exported Function                            | Input                              | Output             | Priority |
| ----------------- | -------------------------------------------- | ---------------------------------- | ------------------ | -------- |
| `definition`      | `getDefinition(source, position, resolver)`  | source, cursor, file resolver      | `Location \| null` | P1       |
| `references`      | `getReferences(source, position, resolver)`  | source, cursor, file resolver      | `Location[]`       | P1       |
| `code-actions`    | `getCodeActions(source, range, diagnostics)` | source, range, current diagnostics | `CodeAction[]`     | P2       |
| `semantic-tokens` | `getSemanticTokens(source)`                  | source string                      | `SemanticToken[]`  | P2       |

**Type system**:

All types are defined in `types.ts` using editor-agnostic abstractions:

- `Position` (1-based line/column) — differs from LSP (0-based)
- `Diagnostic` with severity enum, range, source tag
- `DocumentSymbol` with hierarchical children
- `CompletionItem` with kind enum, insertText, sortOrder
- `HoverInfo` with markdown contents
- `CompileFn` callback type for optional compile-tier diagnostics

### 2.2 LSP Server (`@abl/lsp-server`)

**Responsibility**: Bridge between LSP protocol and language service via JSON-RPC over stdio.

**Architecture**:

```
stdio ←→ vscode-languageserver Connection
             │
             ├─ onInitialize → return SERVER_CAPABILITIES
             ├─ onInitialized → workspace scanner.scan()
             │
             ├─ documents.onDidChangeContent → scheduleDiagnostics()
             │     └─ debounce 300ms → getDiagnostics() → toLSPDiagnostics()
             │
             ├─ documents.onDidClose → clear diagnostics
             │
             ├─ onCompletion → getCompletions() → toLSPCompletionItems()
             ├─ onHover → getHoverInfo() → toLSPHover()
             ├─ onDocumentSymbol → getDocumentSymbols() → toLSPDocumentSymbols()
             │
             └─ onDidChangeWatchedFiles → scanner.invalidate()
```

**Adapter pattern**: Each language feature has a dedicated adapter in `adapters/` that converts between language-service types (1-based positions, string enums) and LSP types (0-based positions, numeric enums). This isolates the protocol-specific code.

| Adapter                   | Converts                                  | Direction              |
| ------------------------- | ----------------------------------------- | ---------------------- |
| `adapters/diagnostics.ts` | `Diagnostic[] → LSP.Diagnostic[]`         | language-service → LSP |
| `adapters/completions.ts` | `CompletionItem[] → LSP.CompletionItem[]` | language-service → LSP |
| `adapters/symbols.ts`     | `DocumentSymbol[] → LSP.DocumentSymbol[]` | language-service → LSP |
| `adapters/hover.ts`       | `HoverInfo → LSP.Hover`                   | language-service → LSP |

**New adapters (P1/P2)**:

| Adapter                       | Converts                               | Priority |
| ----------------------------- | -------------------------------------- | -------- |
| `adapters/definition.ts`      | `Location → LSP.Location`              | P1       |
| `adapters/references.ts`      | `Location[] → LSP.Location[]`          | P1       |
| `adapters/code-actions.ts`    | `CodeAction[] → LSP.CodeAction[]`      | P2       |
| `adapters/semantic-tokens.ts` | `SemanticToken[] → LSP encoded tokens` | P2       |

**Workspace scanner**: Scans workspace for `.agent.yaml`/`.agent.abl` files up to MAX_FILES=100, depth=5. Extracts agent names and tool names via regex (no full parse). Results are cached and invalidated on file watcher events. Provides `CompletionContext` for cross-file completions.

**Debounce strategy**: Diagnostics are debounced at 300ms per document URI. Each new keystroke resets the timer. This prevents redundant parsing during fast typing while keeping feedback under 500ms.

### 2.3 VS Code Extension (`kore-abl`)

**Responsibility**: VS Code-specific integration — language registration, LSP client lifecycle, commands, snippets, syntax highlighting.

**Architecture**:

```
VS Code
  │
  ├─ Language Registration
  │   ├─ abl-yaml (.agent.yaml)
  │   └─ abl-legacy (.agent.abl)
  │
  ├─ TextMate Grammars
  │   ├─ abl-yaml.tmLanguage.json
  │   └─ abl-legacy.tmLanguage.json
  │
  ├─ Snippets
  │   └─ abl.snippets.json (7 snippets)
  │
  ├─ Language Configuration
  │   └─ language-configuration.json (brackets, folding, indentation)
  │
  ├─ Commands
  │   └─ abl.validate → triggers re-validation
  │
  └─ LanguageClient
      ├─ serverOptions: { module: dist/server.js, transport: stdio }
      ├─ clientOptions: { documentSelector: [abl-yaml, abl-legacy] }
      └─ synchronize: { fileEvents: **/*.agent.{yaml,abl} }
```

**Build pipeline**: esbuild bundles both the extension client (`src/extension.ts`) and the LSP server (`../abl-lsp-server/src/server.ts`) into `dist/extension.js` and `dist/server.js` respectively. Both are CommonJS format targeting Node 18.

**Activation**: The extension activates on:

1. Opening a file with language ID `abl-yaml` or `abl-legacy`
2. Workspace containing `**/*.agent.yaml` files

## 3. Data Flow

### 3.1 Diagnostics Flow

```
User types → VS Code didChange → LSP server
  → scheduleDiagnostics(uri, document)
  → debounce 300ms
  → getDiagnostics(source)
    → detectFormat(source) → 'yaml' | 'legacy'
    → parseYamlABL/parseAgentBasedABL(source)
    → Tier 1: extract parser.errors
    → Tier 2: extract parser.warnings
    → Tier 3: compileFn(source) if injected
  → toLSPDiagnostics(diagnostics)
  → connection.sendDiagnostics({ uri, diagnostics })
→ VS Code renders squiggly underlines + Problems panel
```

### 3.2 Completions Flow

```
User triggers completion → VS Code completion request → LSP server
  → onCompletion(params)
  → get document text, convert position (0-based → 1-based)
  → scanner.scan(workspaceFolders) → CompletionContext
  → getCompletions(text, position, context)
    → determine cursor context (top-level, tools, flow, handoff, CEL, value, gather)
    → return appropriate CompletionItem[]
  → toLSPCompletionItems(items)
→ VS Code renders completion list
```

### 3.3 Go-to-Definition Flow (P1 — new)

```
User Ctrl+Click on agent name → VS Code definition request → LSP server
  → onDefinition(params)
  → get document text, convert position
  → getDefinition(text, position, fileResolver)
    → determine if cursor is on handoff `to:` or delegate `agent:` value
    → extract target agent name
    → fileResolver.findAgentFile(agentName) → file path
    → return Location { uri, range }
  → toLSPLocation(location)
→ VS Code navigates to target file
```

## 4. Cross-Cutting Concerns

### 4.1 Performance

| Concern         | Strategy                                                                 | Implementation                                               |
| --------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Parsing latency | Debounce diagnostics at 300ms; parse only on demand                      | `scheduleDiagnostics()` with setTimeout                      |
| Workspace scan  | Cache with invalidation; MAX_FILES=100 cap; depth=5 limit                | `WorkspaceScanner` with `cached` field                       |
| Memory          | No document caching beyond TextDocuments manager; scanner cache is small | `TextDocuments` from vscode-languageserver handles lifecycle |
| Bundle size     | esbuild tree-shaking; no server-side compiler in extension               | esbuild with CJS output                                      |

### 4.2 Error Handling

| Failure Mode                                    | Handling                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| Parser crashes on malformed input               | try-catch in getDiagnostics; return single "parse failed" diagnostic |
| CompileFn crashes                               | try-catch in getDiagnostics; silently skip Tier 3                    |
| Workspace scan fails (permissions, missing dir) | try-catch in readdirSync; skip inaccessible directories              |
| LSP connection drops                            | vscode-languageserver handles reconnection                           |
| Extension activation fails                      | VS Code shows error in Output panel                                  |

### 4.3 Extensibility

| Extension Point         | Mechanism                                                                  |
| ----------------------- | -------------------------------------------------------------------------- |
| New ABL keywords        | Add to `docs.ts` (hover), completions constants, TextMate grammar patterns |
| New CEL functions       | Add to `cel-functions.ts` registry                                         |
| New diagnostic rules    | Inject via `CompileFn` or add to parser                                    |
| New completion contexts | Add case in `getCompletions()`                                             |
| New LSP features        | Add handler in `server.ts`, new adapter in `adapters/`                     |

### 4.4 Security

| Concern                  | Mitigation                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------- |
| File system access       | Workspace scanner only reads files with `.agent.yaml`/`.agent.abl` extensions; skips node_modules, .git |
| Arbitrary code execution | No eval, no dynamic require; pure data processing                                                       |
| Credential exposure      | Language service never accesses network, credentials, or environment variables                          |
| Supply chain             | Minimal dependencies: @abl/core, vscode-languageserver                                                  |

### 4.5 Observability

| Signal                   | Current State                           | Target State                                             |
| ------------------------ | --------------------------------------- | -------------------------------------------------------- |
| LSP server logging       | None (console.debug in symbols.ts only) | Structured logging via connection.console.log/warn/error |
| Extension output channel | None                                    | Dedicated "ABL Language Server" output channel           |
| Diagnostics source tags  | `abl-syntax`, `abl`                     | Add `abl-structural`, `abl-compile` for filtering        |
| Performance metrics      | None                                    | Log parse times > 100ms to output channel                |

### 4.6 Testing

See `docs/testing/abl-lsp.md` for the full test spec. Key architectural testing decisions:

1. **Language service tests are pure unit tests** — no mocks needed since all functions are pure
2. **LSP server integration tests** use a real LSP client communicating over stdio
3. **VS Code E2E tests** use `@vscode/test-electron` for real extension lifecycle testing
4. **No mocking of codebase components** per CLAUDE.md standards

### 4.7 Deployment & Distribution

| Artifact                     | Format                                   | Distribution                           |
| ---------------------------- | ---------------------------------------- | -------------------------------------- |
| `@abl/language-service`      | npm workspace package                    | Internal monorepo consumption          |
| `@abl/lsp-server`            | npm workspace package + `abl-lsp` binary | Internal + standalone CLI              |
| `kore-abl` VS Code extension | `.vsix` package                          | VS Code Marketplace (future), sideload |

**Build chain**:

1. `pnpm build --filter=@abl/language-service` — tsc
2. `pnpm build --filter=@abl/lsp-server` — tsc
3. `pnpm build --filter=kore-abl` — esbuild (bundles both client + server)
4. `cd packages/abl-vscode && pnpm run package` — vsce package → `.vsix`

### 4.8 Backward Compatibility

| Concern                      | Strategy                                                             |
| ---------------------------- | -------------------------------------------------------------------- |
| YAML format (`.agent.yaml`)  | Primary format, full support                                         |
| Legacy format (`.agent.abl`) | Full support via `parseAgentBasedABL` and dedicated TextMate grammar |
| Format detection             | `detectFormat()` auto-detects based on first non-empty line          |
| Mixed-format workspaces      | Both formats coexist; scanner discovers both                         |

### 4.9 Configuration

| Setting                        | Scope     | Default | Purpose                                  |
| ------------------------------ | --------- | ------- | ---------------------------------------- |
| `abl.diagnostics.enabled`      | workspace | true    | Toggle diagnostics                       |
| `abl.diagnostics.compileLevel` | workspace | false   | Enable Tier 3 compile diagnostics        |
| `abl.completion.enabled`       | workspace | true    | Toggle completions                       |
| `abl.trace.server`             | workspace | 'off'   | LSP trace level (off, messages, verbose) |

These settings would be declared in the VS Code extension's `contributes.configuration` and read by the LSP server via `connection.workspace.getConfiguration`.

### 4.10 Internationalization

Not applicable for v1. All diagnostic messages, hover docs, and completion labels are English-only. The architecture supports i18n by externalizing string tables in `docs.ts` and `cel-functions.ts`.

### 4.11 Accessibility

VS Code's built-in accessibility features (screen reader, high contrast) work automatically with LSP features. TextMate grammar scopes map to VS Code's accessible theme tokens. No custom UI beyond VS Code's standard language feature panels.

### 4.12 Data Model

No persistent data model. All state is in-memory:

| State                       | Scope            | Lifecycle                               | Size Bound                            |
| --------------------------- | ---------------- | --------------------------------------- | ------------------------------------- |
| Open document text          | Per document     | didOpen → didClose                      | Managed by TextDocuments              |
| Diagnostics debounce timers | Per document URI | Created on change, cleared on close     | Map<string, Timeout>, max = open docs |
| Workspace scanner cache     | Per workspace    | onInitialized → onDidChangeWatchedFiles | MAX_FILES=100, ~50KB                  |
| Workspace folders           | Per connection   | onInitialize                            | Small array                           |

## 5. Alternatives Considered

### 5.1 In-process language service (no LSP)

**Rejected**: Would tie language intelligence to VS Code only. The LSP architecture allows future Neovim, JetBrains, Sublime, and web editor support with zero language service changes.

### 5.2 Tree-sitter instead of TextMate grammars

**Deferred**: Tree-sitter would provide better incremental parsing and semantic highlighting. However, it requires maintaining a custom grammar and is overkill for ABL's relatively simple YAML-based syntax. TextMate grammars are sufficient for v1.

### 5.3 Monaco integration via LSP-over-WebSocket

**Deferred**: Studio uses `@abl/language-service` directly in the browser. Adding LSP-over-WebSocket would enable the full server-side feature set (workspace scanning, compile diagnostics) in Studio. Not needed for v1.

### 5.4 Bundling @abl/compiler in the LSP server

**Rejected**: `@abl/compiler` has heavy dependencies (CEL runtime, platform constructs). The `CompileFn` injection pattern keeps the language service lightweight while allowing opt-in compile diagnostics.

## 6. Implementation Phases

| Phase                                       | Scope                                                                                                          | Priority | Estimated Effort |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------- | ---------------- |
| Phase 1: Harden P0                          | Fix edge cases in existing diagnostics, completions, hover, symbols; add missing tests; improve error handling | P0       | 2 days           |
| Phase 2: LSP Integration Tests              | Add protocol-level integration tests for all existing features                                                 | P0       | 1 day            |
| Phase 3: Configuration + Observability      | Add VS Code settings, output channel, structured logging                                                       | P1       | 1 day            |
| Phase 4: Go-to-Definition + Find-References | New language service modules + LSP handlers + adapters                                                         | P1       | 2 days           |
| Phase 5: VS Code E2E Tests                  | Set up @vscode/test-electron, write E2E scenarios                                                              | P1       | 1 day            |
| Phase 6: Code Actions + Semantic Tokens     | Quick fixes for common errors; CEL expression highlighting                                                     | P2       | 2 days           |
| Phase 7: Marketplace Readiness              | Icon, README, changelog, vsce package, CI integration                                                          | P1       | 1 day            |

# LLD + Implementation Plan: ABL Language Server Protocol & VS Code Extension

- **Feature**: abl-lsp (F017-LSP)
- **Status**: PLANNED
- **Created**: 2026-03-23
- **Last Updated**: 2026-03-23
- **Feature Spec**: `docs/features/abl-lsp.md`
- **Test Spec**: `docs/testing/abl-lsp.md`
- **HLD**: `docs/specs/abl-lsp.hld.md`

## Implementation Overview

This plan is organized into 7 phases, each with explicit entry criteria, exit criteria, and a file-level change manifest. All phases target the existing three packages:

- `packages/language-service` — `@abl/language-service`
- `packages/abl-lsp-server` — `@abl/lsp-server`
- `packages/abl-vscode` — `kore-abl`

---

## Phase 1: Harden P0 Features (Priority: P0, Effort: 2 days)

### Entry Criteria

- All three packages exist with v0.1.0 baseline
- Existing tests pass: `pnpm test --filter=@abl/language-service`, `pnpm test --filter=@abl/lsp-server`

### Objective

Fix edge cases in existing language service functions, improve error handling, add missing unit tests for uncovered paths.

### Change Manifest

#### 1.1 Language Service — Diagnostics Hardening

**File**: `packages/language-service/src/diagnostics.ts`

Changes:

- Add source tag `'structural'` for Tier 2 warnings (currently all use `'syntax'`)
- Add source tag `'compile'` for Tier 3 diagnostics from CompileFn
- Handle empty source input (return empty array, no parse attempt)

```typescript
// Current: all warnings tagged as 'syntax'
source: 'syntax';
// Target: Tier 2 warnings tagged as 'structural'
source: 'structural';
// Target: Tier 3 diagnostics tagged as 'compile'
source: 'compile';
```

**File**: `packages/language-service/src/__tests__/diagnostics.test.ts`

New tests:

- `LS-DG-06`: CompileFn that throws Error — verify graceful degradation
- `LS-DG-07`: Empty string input — verify returns empty Diagnostic[]
- Verify Tier 2 warnings have source `'structural'`
- Verify Tier 3 diagnostics have source `'compile'`

#### 1.2 Language Service — Completions Hardening

**File**: `packages/language-service/src/completions.ts`

Changes:

- Improve `isHandoffTarget()` to also match delegate section patterns (`- agent: <cursor>`)
- Add delegate section detection alongside handoff

**File**: `packages/language-service/src/__tests__/completions.test.ts`

New tests:

- `LS-CP-12`: Built-in tools merged with context tools, context tools take priority
- `LS-CP-13`: Delegate target completions (agent names in delegate section)

#### 1.3 Language Service — Hover Hardening

**File**: `packages/language-service/src/hover.ts`

Changes:

- Handle empty line (return null when no word found)
- Verify case-insensitive matching works for uppercase keywords (legacy format)

**File**: `packages/language-service/src/__tests__/hover.test.ts`

New tests:

- `LS-HV-03`: Cursor on empty line returns null
- `LS-HV-04`: Uppercase keyword (AGENT) matches after normalization

#### 1.4 Language Service — Symbols Hardening

**File**: `packages/language-service/src/__tests__/symbols.test.ts`

New tests:

- `LS-SY-08`: Legacy format document symbols (AGENT:, TOOLS: etc.)

#### 1.5 Language Service — Format Detection Hardening

**File**: `packages/language-service/src/__tests__/detect-format.test.ts`

New tests:

- `LS-DF-04`: Comment-only input (all lines are `#` comments) returns `'legacy'` (default)

#### 1.6 Language Service — CEL Functions Registry

**File**: `packages/language-service/src/__tests__/cel-completions.test.ts`

New tests:

- `LS-CF-01`: Verify all 30 CEL functions have name, signature, description, category

#### 1.7 LSP Server — Workspace Scanner Hardening

**File**: `packages/abl-lsp-server/src/__tests__/workspace-scanner.test.ts`

New tests:

- `LSP-WS-08`: MAX_FILES cap (create >100 files, verify only 100 scanned)
- `LSP-WS-09`: Depth limit (create deeply nested structure, verify depth=5 limit)
- `LSP-WS-10`: Finds `.agent.abl` files (legacy extension)

#### 1.8 LSP Server — Capabilities Test

**File**: `packages/abl-lsp-server/src/__tests__/capabilities.test.ts` (NEW)

New tests:

- `LSP-CP-01`: Verify SERVER_CAPABILITIES has correct shape (textDocumentSync, completionProvider, hoverProvider, documentSymbolProvider)

### Exit Criteria

- [ ] All existing tests still pass
- [ ] All new tests pass (LS-DG-06, LS-DG-07, LS-CP-12, LS-CP-13, LS-HV-03, LS-HV-04, LS-SY-08, LS-DF-04, LS-CF-01, LSP-WS-08, LSP-WS-09, LSP-WS-10, LSP-CP-01)
- [ ] Diagnostic source tags correctly differentiate tiers: `'syntax'`, `'structural'`, `'compile'`
- [ ] `pnpm build --filter=@abl/language-service` succeeds
- [ ] `pnpm build --filter=@abl/lsp-server` succeeds

---

## Phase 2: LSP Integration Tests (Priority: P0, Effort: 1 day)

### Entry Criteria

- Phase 1 complete (all P0 hardening done)

### Objective

Add protocol-level integration tests that start the real LSP server as a child process and communicate via JSON-RPC over stdio.

### Change Manifest

#### 2.1 Test Infrastructure

**File**: `packages/abl-lsp-server/src/__tests__/integration/lsp-test-client.ts` (NEW)

A lightweight LSP test client that:

- Spawns `node dist/server.js` as a child process
- Sends JSON-RPC messages via stdin
- Reads JSON-RPC responses from stdout
- Provides typed helper methods: `initialize()`, `didOpen()`, `didChange()`, `completion()`, `hover()`, `documentSymbol()`, `didClose()`, `shutdown()`
- Handles Content-Length headers per LSP transport spec
- Collects server-pushed notifications (e.g., `textDocument/publishDiagnostics`)

```typescript
interface LSPTestClient {
  initialize(workspaceFolders?: string[]): Promise<InitializeResult>;
  didOpen(uri: string, languageId: string, text: string): Promise<void>;
  didChange(uri: string, version: number, text: string): Promise<void>;
  completion(uri: string, line: number, character: number): Promise<CompletionItem[]>;
  hover(uri: string, line: number, character: number): Promise<Hover | null>;
  documentSymbol(uri: string): Promise<DocumentSymbol[]>;
  didClose(uri: string): Promise<void>;
  waitForDiagnostics(uri: string, timeoutMs?: number): Promise<Diagnostic[]>;
  shutdown(): Promise<void>;
}
```

#### 2.2 Integration Test Suite

**File**: `packages/abl-lsp-server/src/__tests__/integration/lsp-protocol.test.ts` (NEW)

Tests:

- `INT-01`: Server initializes with correct capabilities (textDocumentSync, completionProvider, hoverProvider, documentSymbolProvider)
- `INT-02`: textDocument/didOpen triggers diagnostics publication
- `INT-03`: textDocument/didChange triggers debounced diagnostics (verify only 1 publication for 2 rapid changes)
- `INT-04`: textDocument/completion returns context-aware items (empty file → top-level keys; excludes already-present keys)
- `INT-05`: textDocument/hover returns markdown for "agent" keyword
- `INT-06`: textDocument/documentSymbol returns hierarchical outline (agent root → Tools → tool items, Flow → step items)
- `INT-07`: workspace/didChangeWatchedFiles invalidates scanner cache
- `INT-08`: textDocument/didClose clears diagnostics for document

Each test:

1. Creates a fresh LSP client
2. Initializes the connection
3. Opens/modifies documents
4. Asserts protocol-level responses
5. Shuts down cleanly

### Exit Criteria

- [ ] LSP test client can start/stop the server reliably
- [ ] All 8 integration tests pass
- [ ] Tests run in CI without flakiness (timeouts configured generously)
- [ ] No mocking of language-service functions

---

## Phase 3: Configuration + Observability (Priority: P1, Effort: 1 day)

### Entry Criteria

- Phase 2 complete (integration tests passing)

### Objective

Add VS Code workspace settings, an output channel for logging, and structured diagnostics source tags.

### Change Manifest

#### 3.1 VS Code Extension — Configuration

**File**: `packages/abl-vscode/package.json`

Add `contributes.configuration`:

```json
{
  "contributes": {
    "configuration": {
      "title": "ABL Language Server",
      "properties": {
        "abl.diagnostics.enabled": {
          "type": "boolean",
          "default": true,
          "description": "Enable/disable ABL diagnostics"
        },
        "abl.diagnostics.compileLevel": {
          "type": "boolean",
          "default": false,
          "description": "Enable compile-level (Tier 3) diagnostics"
        },
        "abl.completion.enabled": {
          "type": "boolean",
          "default": true,
          "description": "Enable/disable ABL completions"
        },
        "abl.trace.server": {
          "type": "string",
          "enum": ["off", "messages", "verbose"],
          "default": "off",
          "description": "Trace communication with the ABL language server"
        }
      }
    }
  }
}
```

#### 3.2 VS Code Extension — Output Channel

**File**: `packages/abl-vscode/src/extension.ts`

Changes:

- Create a dedicated output channel: `window.createOutputChannel('ABL Language Server')`
- Pass trace setting to language client options
- Log extension activation and server lifecycle events

#### 3.3 LSP Server — Configuration Handler

**File**: `packages/abl-lsp-server/src/server.ts`

Changes:

- Add `onDidChangeConfiguration` handler
- Read `abl.diagnostics.enabled` setting — skip diagnostics if false
- Read `abl.completion.enabled` setting — return empty if false
- Use `connection.console.log/warn/error` for structured logging instead of console.debug

#### 3.4 LSP Server — Diagnostic Source Tags

**File**: `packages/abl-lsp-server/src/adapters/diagnostics.ts`

No changes needed — source tags come from language service. Verify the mapping:

- `source: 'syntax'` → `abl-syntax`
- `source: 'structural'` → `abl-structural`
- `source: 'compile'` → `abl-compile`
- `source: undefined` → `abl`

### Exit Criteria

- [ ] `abl.diagnostics.enabled = false` suppresses all diagnostics
- [ ] `abl.completion.enabled = false` returns empty completions
- [ ] Output channel "ABL Language Server" is created on activation
- [ ] `connection.console` used instead of `console.debug`
- [ ] Integration tests still pass with default settings

---

## Phase 4: Go-to-Definition + Find-References (Priority: P1, Effort: 2 days)

### Entry Criteria

- Phase 3 complete
- Workspace scanner already discovers agent names and maps them to file paths

### Objective

Implement cross-file navigation: Ctrl+Click on handoff/delegate target navigates to the agent's definition file. Find-references shows all files that reference a given agent.

### Change Manifest

#### 4.1 Language Service — Location Type

**File**: `packages/language-service/src/types.ts`

Add:

```typescript
export interface Location {
  /** File path or URI */
  uri: string;
  /** Start position */
  start: Position;
  /** End position (optional — defaults to same as start) */
  end?: Position;
}

/**
 * Resolver interface for cross-file lookups.
 * Implemented by the LSP server using workspace scanner data.
 */
export interface FileResolver {
  findAgentFile(agentName: string): string | null;
  findAgentReferences(agentName: string): Array<{
    uri: string;
    line: number;
    column: number;
  }>;
}
```

#### 4.2 Language Service — Definition Module

**File**: `packages/language-service/src/definition.ts` (NEW)

```typescript
export function getDefinition(
  source: string,
  position: Position,
  resolver: FileResolver,
): Location | null;
```

Logic:

1. Determine if cursor is on a handoff `to:` value or delegate `agent:` value
2. Extract the target agent name
3. Call `resolver.findAgentFile(agentName)` to get the file path
4. Return Location with uri pointing to the agent's `agent:` line (line 1)
5. Return null if not in a handoff/delegate context or agent not found

#### 4.3 Language Service — References Module

**File**: `packages/language-service/src/references.ts` (NEW)

```typescript
export function getReferences(
  source: string,
  position: Position,
  resolver: FileResolver,
): Location[];
```

Logic:

1. Determine if cursor is on an `agent:` top-level key value (the agent's own name)
2. Extract the agent name
3. Call `resolver.findAgentReferences(agentName)` to find all handoff/delegate references
4. Return Location[] for each reference
5. Return empty array if not on an agent name

#### 4.4 Language Service — Export Updates

**File**: `packages/language-service/src/index.ts`

Add exports:

```typescript
export type { Location, FileResolver } from './types.js';
export { getDefinition } from './definition.js';
export { getReferences } from './references.js';
```

#### 4.5 LSP Server — Workspace Scanner Enhancement

**File**: `packages/abl-lsp-server/src/workspace-scanner.ts`

Changes:

- Add `findAgentFile(agentName: string): string | null` — returns file path for given agent name
- Add `findAgentReferences(agentName: string): Array<{ uri, line, column }>` — scans all files for handoff/delegate references to the given agent
- Store file-to-agent-name mapping during scan
- Implement FileResolver interface from @abl/language-service

#### 4.6 LSP Server — Definition Adapter

**File**: `packages/abl-lsp-server/src/adapters/definition.ts` (NEW)

Convert language-service Location to LSP Location (1-based to 0-based, path to URI).

#### 4.7 LSP Server — References Adapter

**File**: `packages/abl-lsp-server/src/adapters/references.ts` (NEW)

Convert language-service Location[] to LSP Location[].

#### 4.8 LSP Server — Server Handlers

**File**: `packages/abl-lsp-server/src/server.ts`

Add:

- `connection.onDefinition` handler — calls `getDefinition()` with workspace scanner as FileResolver
- `connection.onReferences` handler — calls `getReferences()` with workspace scanner as FileResolver

**File**: `packages/abl-lsp-server/src/capabilities.ts`

Add:

```typescript
definitionProvider: true,
referencesProvider: true,
```

#### 4.9 Tests

**Files**:

- `packages/language-service/src/__tests__/definition.test.ts` (NEW) — unit tests with mock FileResolver
- `packages/language-service/src/__tests__/references.test.ts` (NEW) — unit tests with mock FileResolver
- `packages/abl-lsp-server/src/__tests__/integration/lsp-protocol.test.ts` — add definition + references integration tests

### Exit Criteria

- [ ] Ctrl+Click on `to: booking_agent` navigates to `booking_agent.agent.yaml`
- [ ] Find References on `agent: booking_agent` shows all handoff/delegate references
- [ ] Unit tests pass for definition and references modules
- [ ] Integration tests pass for textDocument/definition and textDocument/references
- [ ] Works across both YAML and legacy format files

---

## Phase 5: VS Code E2E Tests (Priority: P1, Effort: 1 day)

### Entry Criteria

- Phase 4 complete
- Extension builds successfully (`pnpm build --filter=kore-abl`)

### Objective

Set up real VS Code E2E testing with `@vscode/test-electron` and implement 7 E2E scenarios.

### Change Manifest

#### 5.1 Test Infrastructure

**File**: `packages/abl-vscode/package.json`

Add devDependencies:

```json
{
  "@vscode/test-electron": "^2.3.8",
  "glob": "^10.0.0"
}
```

Add script:

```json
{
  "test:e2e": "node ./out/test/runTest.js"
}
```

**File**: `packages/abl-vscode/src/__tests__/e2e/runTest.ts` (NEW)

Test runner that launches VS Code with the extension, points to the test suite, and reports results.

**File**: `packages/abl-vscode/src/__tests__/e2e/index.ts` (NEW)

Test suite entry point that discovers and runs all `*.e2e.test.ts` files.

**File**: `packages/abl-vscode/src/__tests__/fixtures/` (NEW directory)

ABL fixture files:

- `minimal.agent.yaml` — valid minimal agent
- `invalid-syntax.agent.yaml` — has parse errors
- `multi-agent/supervisor.agent.yaml` — has handoff references
- `multi-agent/billing.agent.yaml` — referenced by supervisor

#### 5.2 E2E Test Suite

**File**: `packages/abl-vscode/src/__tests__/e2e/extension.e2e.test.ts` (NEW)

Tests:

- `E2E-01`: Extension activates on .agent.yaml file open
- `E2E-02`: Diagnostics appear in Problems panel for invalid ABL
- `E2E-03`: Completions suggest top-level keys in empty .agent.yaml
- `E2E-04`: Hover shows documentation for ABL keywords
- `E2E-05`: Document outline shows agent structure
- `E2E-06`: Snippets insert correctly
- `E2E-07`: abl.validate command triggers re-validation

### Exit Criteria

- [ ] E2E test runner launches VS Code headlessly
- [ ] All 7 E2E tests pass
- [ ] Tests pass in CI with xvfb (Linux) or without display (macOS)
- [ ] Fixture files are committed and working

---

## Phase 6: Code Actions + Semantic Tokens (Priority: P2, Effort: 2 days)

### Entry Criteria

- Phase 5 complete
- All P0 and P1 features working

### Objective

Add quick-fix code actions for common errors and semantic token support for CEL expressions.

### Change Manifest

#### 6.1 Language Service — Code Actions

**File**: `packages/language-service/src/types.ts`

Add:

```typescript
export interface CodeAction {
  title: string;
  kind: 'quickfix' | 'refactor';
  diagnostics?: Diagnostic[];
  edit?: TextEdit[];
}

export interface TextEdit {
  range: { start: Position; end: Position };
  newText: string;
}
```

**File**: `packages/language-service/src/code-actions.ts` (NEW)

Code actions:

1. "Add missing tool to tools section" — when a tool name in a `call:` is not in the `tools:` list
2. "Did you mean X?" — when an agent name in handoff/delegate is close to a known agent (Levenshtein distance <= 2)

#### 6.2 Language Service — Semantic Tokens

**File**: `packages/language-service/src/types.ts`

Add:

```typescript
export interface SemanticToken {
  line: number;
  startCharacter: number;
  length: number;
  tokenType: SemanticTokenType;
  tokenModifiers?: string[];
}

export type SemanticTokenType =
  | 'function'
  | 'variable'
  | 'operator'
  | 'keyword'
  | 'string'
  | 'number';
```

**File**: `packages/language-service/src/semantic-tokens.ts` (NEW)

Provides semantic tokens for:

- CEL function names (`abl.upper`, `abl.round`) — type `function`
- Context variable references (`context.topic`) — type `variable`
- Template variables (`{{name}}`) — type `variable`

#### 6.3 LSP Server Integration

Add adapters, handlers, and capabilities for code actions and semantic tokens (following existing adapter pattern).

### Exit Criteria

- [ ] Quick-fix actions appear for missing tools and misspelled agent names
- [ ] Semantic tokens provide distinct coloring for CEL functions and context variables
- [ ] Unit tests pass for code-actions and semantic-tokens modules
- [ ] Integration tests verify LSP protocol for both features

---

## Phase 7: Marketplace Readiness (Priority: P1, Effort: 1 day)

### Entry Criteria

- Phase 5 complete (E2E tests passing)

### Objective

Prepare the VS Code extension for marketplace publishing.

### Change Manifest

#### 7.1 Extension Metadata

**File**: `packages/abl-vscode/package.json`

Add/update:

```json
{
  "icon": "images/abl-icon.png",
  "galleryBanner": {
    "color": "#1e1e2e",
    "theme": "dark"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/kore-ai/abl-platform"
  },
  "keywords": ["abl", "agent", "blueprint", "language", "kore"],
  "badges": []
}
```

#### 7.2 Extension Assets

**Files** (NEW):

- `packages/abl-vscode/images/abl-icon.png` — 128x128 extension icon
- `packages/abl-vscode/README.md` — marketplace README with features, installation, configuration
- `packages/abl-vscode/CHANGELOG.md` — version history

#### 7.3 Build & Package

**File**: `packages/abl-vscode/package.json`

Update scripts:

```json
{
  "prepackage": "pnpm build",
  "package": "vsce package --no-dependencies"
}
```

#### 7.4 CI Integration

Verify the extension builds and packages successfully in CI:

```bash
pnpm build --filter=kore-abl
cd packages/abl-vscode && pnpm run package
```

### Exit Criteria

- [ ] `vsce package` produces a valid `.vsix` file
- [ ] Extension installs from `.vsix` in VS Code
- [ ] README displays correctly in marketplace preview
- [ ] All features work after install from `.vsix`

---

## Wiring Checklist

| Wiring Point                              | Source                                                              | Target                                                             | Verified      |
| ----------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------- |
| language-service exports in index.ts      | New modules (definition, references, code-actions, semantic-tokens) | index.ts re-exports                                                | [ ]           |
| LSP server imports language-service       | server.ts                                                           | @abl/language-service                                              | Already wired |
| LSP capabilities declaration              | capabilities.ts                                                     | New features (definition, references, codeAction, semanticTokens)  | [ ]           |
| LSP handler registration                  | server.ts                                                           | onDefinition, onReferences, onCodeAction, onDocumentSemanticTokens | [ ]           |
| VS Code extension contributes             | package.json                                                        | configuration, commands                                            | [ ]           |
| esbuild bundles server                    | esbuild.config.mjs                                                  | ../abl-lsp-server/src/server.ts                                    | Already wired |
| Workspace scanner implements FileResolver | workspace-scanner.ts                                                | FileResolver interface                                             | [ ]           |
| Diagnostic source tags                    | diagnostics.ts                                                      | 'syntax', 'structural', 'compile'                                  | [ ]           |

## Risk Mitigations

| Risk                                       | Mitigation                                                           | Phase      |
| ------------------------------------------ | -------------------------------------------------------------------- | ---------- |
| Integration tests flaky due to timing      | Use generous timeouts (5s), retry logic for diagnostics notification | Phase 2    |
| E2E tests require display server           | Use xvfb-run on Linux, --headless on macOS                           | Phase 5    |
| Workspace scanner too slow for large repos | MAX_FILES=100 cap already exists; add progress reporting             | Phase 1    |
| TextMate grammar misses new keywords       | Add keywords to grammar arrays when adding to docs.ts                | Ongoing    |
| esbuild bundling breaks with new imports   | Test esbuild after each phase                                        | Each phase |

## Summary

| Phase                      | Files Changed | Files Created | Tests Added |
| -------------------------- | ------------- | ------------- | ----------- |
| Phase 1: Harden P0         | 5             | 1             | 13          |
| Phase 2: Integration Tests | 0             | 2             | 8           |
| Phase 3: Configuration     | 3             | 0             | 0           |
| Phase 4: Go-to-Definition  | 4             | 5             | ~10         |
| Phase 5: E2E Tests         | 1             | 6             | 7           |
| Phase 6: Code Actions      | 1             | 3             | ~8          |
| Phase 7: Marketplace       | 1             | 3             | 0           |
| **Total**                  | **15**        | **20**        | **~46**     |

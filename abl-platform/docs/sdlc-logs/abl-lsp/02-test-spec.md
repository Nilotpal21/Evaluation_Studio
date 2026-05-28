# SDLC Log: abl-lsp — Phase 2: Test Spec

- **Date**: 2026-03-23
- **Phase**: Test Spec
- **Artifact**: `docs/testing/abl-lsp.md`
- **Status**: COMPLETE

## Test Coverage Analysis

### Existing Test Files Discovered

1. `packages/language-service/src/__tests__/detect-format.test.ts` — format detection
2. `packages/language-service/src/__tests__/diagnostics.test.ts` — 3-tier diagnostics
3. `packages/language-service/src/__tests__/completions.test.ts` — context-aware completions
4. `packages/language-service/src/__tests__/cel-completions.test.ts` — CEL function completions
5. `packages/language-service/src/__tests__/symbols.test.ts` — document symbols
6. `packages/language-service/src/__tests__/hover.test.ts` — hover info
7. `packages/language-service/src/__tests__/serialize-yaml.test.ts` — YAML serialization
8. `packages/abl-lsp-server/src/__tests__/adapters.test.ts` — all 4 adapter conversions
9. `packages/abl-lsp-server/src/__tests__/workspace-scanner.test.ts` — workspace scanning

### Coverage Summary

| Category                      | Existing | New    | Total   |
| ----------------------------- | -------- | ------ | ------- |
| Unit tests (language-service) | ~25      | 10     | ~35     |
| Unit tests (lsp-server)       | ~20      | 5      | ~25     |
| Integration tests             | 0        | 8      | 8       |
| E2E tests                     | 0        | 7      | 7       |
| **Total**                     | **~45**  | **30** | **~75** |

### Key Gaps Identified

1. **Integration tests**: Zero LSP protocol-level tests exist. All server.ts testing is manual.
2. **E2E tests**: Zero VS Code extension tests exist. Extension has never been tested end-to-end.
3. **Legacy format**: Limited test coverage for `.agent.abl` format across all modules.
4. **Edge cases**: CompileFn crash handling, empty input, MAX_FILES cap, depth limits untested.
5. **Cross-file features**: Go-to-definition and find-references have no tests (not yet implemented).

## Decisions

| Decision                                                      | Classification | Rationale                                         |
| ------------------------------------------------------------- | -------------- | ------------------------------------------------- |
| Integration tests use stdio child process, not in-process LSP | DECIDED        | More realistic, tests real transport layer        |
| E2E tests require @vscode/test-electron                       | DECIDED        | Only way to test real VS Code extension lifecycle |
| E2E tests in CI require xvfb for headless operation           | DECIDED        | Standard approach for VS Code extension testing   |
| No mocking of language service in LSP server tests            | DECIDED        | Per CLAUDE.md E2E test standards                  |
| Fixture files provide standard test data                      | DECIDED        | Avoids duplicating test strings across test files |

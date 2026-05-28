# SDLC Log: abl-lsp — Phase 1: Feature Spec

- **Date**: 2026-03-23
- **Phase**: Feature Spec
- **Artifact**: `docs/features/abl-lsp.md`
- **Status**: COMPLETE

## Codebase Discovery

Discovered 3 existing packages forming the ABL developer tooling stack:

1. **`packages/language-service`** (`@abl/language-service` v0.1.0) — Editor-agnostic language intelligence:
   - Diagnostics (3 tiers: syntax, structural, compile)
   - Completions (context-aware: top-level, tools, flow steps, handoff targets, CEL functions, value enums, gather fields)
   - Document symbols (hierarchical outline)
   - Hover documentation (18 keywords)
   - Format detection (YAML vs legacy)
   - CEL function metadata (30 functions)
   - YAML serialization (IR round-trip)
   - Dependencies: `@abl/core` only

2. **`packages/abl-lsp-server`** (`@abl/lsp-server` v0.1.0) — LSP protocol bridge:
   - LSP connection via `vscode-languageserver` ^9.0.1
   - Debounced diagnostics (300ms)
   - Workspace scanner (agent/tool name discovery)
   - 4 adapters: diagnostics, completions, symbols, hover
   - Capabilities: incremental sync, completion triggers, hover, document symbols

3. **`packages/abl-vscode`** (`kore-abl` v0.1.0) — VS Code extension:
   - Dual language registration (abl-yaml, abl-legacy)
   - TextMate grammars for both formats
   - 7 code snippets
   - esbuild bundling (client + server)
   - Language configuration (brackets, folding, indentation)

## Decisions

| Decision                                                              | Classification | Rationale                                                                            |
| --------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------ |
| Feature is scoped to hardening + gap-filling existing v0.1.0 packages | DECIDED        | All 3 packages exist with working baseline; no greenfield needed                     |
| Go-to-definition and find-references are P1, not P0                   | DECIDED        | Existing P0 features (diagnostics, completions, hover, symbols) need hardening first |
| Multi-root workspace support is out of scope                          | DECIDED        | Adds complexity without clear user demand for v1                                     |
| Studio/Monaco integration is out of scope                             | DECIDED        | Studio already consumes @abl/language-service directly                               |
| Semantic tokens are P2                                                | DECIDED        | TextMate grammars cover 90% of highlighting needs                                    |

## Audit Findings

- No critical findings
- Feature spec grounded in actual codebase discovery (all code paths verified)

# SDLC Log: abl-lsp — Phase 4: LLD + Implementation Plan

- **Date**: 2026-03-23
- **Phase**: Low-Level Design + Implementation Plan
- **Artifact**: `docs/plans/2026-03-23-abl-lsp-impl-plan.md`
- **Status**: COMPLETE

## Plan Structure

7 implementation phases organized by priority:

| Phase                                       | Priority | Effort | Key Deliverable                                            |
| ------------------------------------------- | -------- | ------ | ---------------------------------------------------------- |
| Phase 1: Harden P0                          | P0       | 2d     | 13 new unit tests, diagnostic source tags, edge case fixes |
| Phase 2: LSP Integration Tests              | P0       | 1d     | LSP test client + 8 protocol-level tests                   |
| Phase 3: Configuration + Observability      | P1       | 1d     | VS Code settings, output channel, structured logging       |
| Phase 4: Go-to-Definition + Find-References | P1       | 2d     | Cross-file navigation, FileResolver interface              |
| Phase 5: VS Code E2E Tests                  | P1       | 1d     | 7 real VS Code E2E tests with @vscode/test-electron        |
| Phase 6: Code Actions + Semantic Tokens     | P2       | 2d     | Quick fixes, CEL expression highlighting                   |
| Phase 7: Marketplace Readiness              | P1       | 1d     | .vsix packaging, icon, README                              |

**Total**: 15 files changed, 20 files created, ~46 new tests

## Key Design Decisions

### FileResolver Interface

Rather than making the language service depend on file system operations, we defined a `FileResolver` interface that the LSP server implements using the workspace scanner. This keeps the language service pure and testable.

```typescript
interface FileResolver {
  findAgentFile(agentName: string): string | null;
  findAgentReferences(agentName: string): Array<{ uri: string; line: number; column: number }>;
}
```

### LSP Test Client

Integration tests use a real child process (stdio transport) rather than in-process mocking. This tests the actual JSON-RPC framing, Content-Length headers, and debounce behavior.

### Diagnostic Source Tag Refinement

The current code tags all diagnostics with either `'syntax'` or nothing. The plan refines this to three distinct tags:

- `'syntax'` — Tier 1 parser errors
- `'structural'` — Tier 2 parser warnings
- `'compile'` — Tier 3 compile-level diagnostics

This allows VS Code users to filter diagnostics by source in the Problems panel.

### Phase Dependencies

```
Phase 1 (P0) → Phase 2 (P0) → Phase 3 (P1) → Phase 4 (P1)
                                                    ↓
                                              Phase 5 (P1) → Phase 7 (P1)
                                                    ↓
                                              Phase 6 (P2)
```

Phases 1-2 are P0 blockers. Phases 3-5 and 7 can be parallelized after Phase 2. Phase 6 is independent P2 work.

## Audit Findings

- No critical findings
- All file paths verified against existing codebase
- No new packages needed; all work is within existing 3 packages
- Wiring checklist documents all integration points

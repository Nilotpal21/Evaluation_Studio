# SDLC Log: Agent Anatomy — Test Spec (Phase 2)

**Date**: 2026-03-22
**Phase**: Test Spec
**Artifact**: `docs/testing/agent-anatomy.md`

## Decision Log

| Question                                            | Classification | Resolution                                                                                                            |
| --------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------- |
| Which FRs are highest risk?                         | DECIDED        | FR-1 (compilation) and FR-5 (tool snapshots) — compilation is the core pipeline; snapshots are the audit trail        |
| What existing test coverage exists?                 | ANSWERED       | 6 test files found in runtime/**tests**/, plus compiler tests. Source: file listing in test directories               |
| Should cross-agent validation have E2E tests?       | DECIDED        | Unit coverage is sufficient for validation logic; E2E would test compilation API endpoints which are version creation |
| Are behavior profiles covered at E2E level?         | ANSWERED       | Yes — `behavior-profile.e2e.test.ts` exists in runtime tests. Source: file listing                                    |
| What service boundaries need integration tests?     | DECIDED        | VersionService->Compiler->MongoDB, model config layering, IR validation orchestrator, graph extraction, tool snapshot |
| Should compilation timeout have dedicated E2E test? | DECIDED        | Unit test with mock timeout is sufficient; E2E would require a slow-compilation fixture that is fragile               |

## Files Created/Modified

- `docs/testing/agent-anatomy.md` — Re-generated test spec with 7 E2E + 7 integration scenarios
- `docs/sdlc-logs/agent-anatomy/test-spec.log.md` — This log

## Review Findings

### Round 1 — Coverage & Completeness

- [x] 7 E2E test scenarios (minimum 5)
- [x] 7 integration test scenarios (minimum 5)
- [x] Every FR from feature spec appears in coverage matrix (FR-1 through FR-10)
- [x] E2E scenarios specify auth context
- [x] E2E scenarios do NOT reference mocks or direct DB access
- [x] Integration scenarios specify service boundaries
- [x] Security & isolation section filled with specific test file references
- [x] Test file mapping has actual paths

### Round 2 — Alignment

- [x] Scenarios cover the highest-risk FRs (FR-1 compilation, FR-5 snapshots)
- [x] E2E scenarios match user stories from feature spec
- [x] Integration boundaries match the data flow from feature spec

## Key Learnings

- 7 E2E scenarios cover: CRUD with tenant isolation, model config lifecycle, version creation/promotion, execution model resolution, version diff, compilation errors, and tenant-scoped discovery
- 7 integration scenarios cover: compile-and-persist, model layering, IR validation, behavior profiles, version promotion lifecycle, static graph extraction, and tool snapshot capture
- FR-6, FR-7, FR-9, FR-10 are currently unit-tested only — flagged as known gaps for future E2E coverage

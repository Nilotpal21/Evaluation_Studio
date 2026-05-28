# SDLC Log: Connectors LLD

**Feature:** connectors
**Phase:** LLD (Phase 4)
**Date:** 2026-03-22

## Summary

Generated Low-Level Design and implementation plan for the Connectors Platform. The plan focuses on hardening the existing BETA implementation to production quality across 5 phases with 18 tasks.

## Key Decisions

| ID  | Classification | Decision                                                                                                             |
| --- | -------------- | -------------------------------------------------------------------------------------------------------------------- |
| D1  | DECIDED        | LLD focuses on hardening, not new features -- implementation is 18/18 tasks complete                                 |
| D2  | DECIDED        | Phase order: code quality -> observability -> E2E tests -> integration tests -> consolidation                        |
| D3  | DECIDED        | Top 3 E2E priorities: Connection CRUD (E2E-1), Webhook Trigger (E2E-4), Connection Test (E2E-6)                      |
| D4  | DECIDED        | Top 3 integration priorities: OAuth Refresh Lock (INT-1), Credential Encryption (INT-4), Resolution Priority (INT-2) |
| D5  | INFERRED       | Total effort ~7.5 days across all 5 phases                                                                           |
| D6  | DECIDED        | OAuth consolidation (OQ-10) is documentation-only in this plan; implementation deferred                              |

## Phases

1. **Code Quality Hardening** (P0, 1d) -- Fix console.log, tenant isolation gaps, registry bounds
2. **Observability & Security** (P0, 2d) -- OTel spans, retention policy, key rotation, circuit breaker
3. **E2E Tests** (P0, 2d) -- Connection CRUD, webhook trigger, connection test
4. **Integration Tests** (P1, 1.5d) -- OAuth refresh lock, credential encryption, resolution priority
5. **Consolidation** (P2, 1d) -- Token manager fix, OAuth consolidation doc, webhook renewal verification

## Code Quality Issues Identified

1. `connector-delta-sync.ts` uses `console.log` (CLAUDE.md violation)
2. `connector-delta-sync.ts` has queries without `tenantId` (isolation violation)
3. `ConnectorRegistry` Map has no max size (CLAUDE.md violation)
4. `findOAuthTokenByFilter()` doesn't enforce tenantId (isolation risk)

## Output

- `docs/plans/2026-03-22-connectors-impl-plan.md` -- 5-phase plan with 18 tasks and exit criteria

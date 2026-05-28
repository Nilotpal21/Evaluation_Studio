# HLD Log: Arch AI v0.3

**Date**: 2026-04-06
**Phase**: HLD (retroactive — feature already implemented)
**Feature Spec**: `docs/features/arch-ai-assistant.md`
**Artifact**: `docs/specs/arch-ai-v03.hld.md`

## Oracle Decisions

15 clarifying questions asked, 0 escalated to user.

| #   | Question                      | Classification | Key Finding                                            |
| --- | ----------------------------- | -------------- | ------------------------------------------------------ |
| Q1  | Architecture pattern finality | ANSWERED       | Coordinator/executor/specialist is final for Act 1     |
| Q2  | Transport (SSE vs WS)         | ANSWERED       | SSE chosen, no WebSocket planned                       |
| Q3  | Expected scale                | ANSWERED       | 10 sessions/tenant, 200 messages, 50MB files           |
| Q4  | Surface-agnostic claim        | INFERRED       | Architecturally valid, tool execution coupling is gap  |
| Q5  | Phase transition mechanism    | ANSWERED       | Fully deterministic, coordinator owns all transitions  |
| Q6  | LLM providers & resolution    | ANSWERED       | 4-tier chain: Model Hub → tenant key → env key → error |
| Q7  | Compiler interaction          | ANSWERED       | On-demand during BUILD, compile-fix loop max 3 rounds  |
| Q8  | Session relationship          | ANSWERED       | Completely separate from runtime sessions              |
| Q9  | CREATE phase writes           | ANSWERED       | Real ProjectAgent records, no transactional rollback   |
| Q10 | Specialist interaction        | ANSWERED       | One per turn, sequential, no parallel execution        |
| Q11 | Biggest technical risk        | DECIDED        | 3,093-line message route with 29% E2E coverage         |
| Q12 | v2 data migration             | ANSWERED       | Clean break, no migration needed                       |
| Q13 | Rollback strategy             | INFERRED       | Route/API/DB isolation; feature flag recommended       |
| Q14 | Blast radius                  | INFERRED       | Minimal; risk vectors are CREATE + IN_PROJECT writes   |
| Q15 | Message route split plan      | DECIDED        | Phased extraction recommended for MCP portability      |

## Code Review Findings (addressed before HLD)

| ID  | Severity | Issue                                       | Status   |
| --- | -------- | ------------------------------------------- | -------- |
| C1  | CRITICAL | Journal countDocuments missing tenantId     | FIXED    |
| C2  | CRITICAL | Project health missing requireProjectAccess | FIXED    |
| C3  | CRITICAL | No TraceEvent emission                      | DEFERRED |
| C4  | CRITICAL | Unbounded message array growth              | FIXED    |
| C5  | CRITICAL | No payload size validation                  | FIXED    |
| H1  | HIGH     | 3 swallowed catch blocks                    | FIXED    |
| H2  | HIGH     | requireAuth instead of requireTenantAuth    | FIXED    |
| H3  | HIGH     | SessionFile missing userId                  | DEFERRED |
| H4  | HIGH     | Triplicated dead code                       | FIXED    |
| H5  | HIGH     | Magic numbers                               | FIXED    |
| H6  | HIGH     | ~48 `any` types                             | DEFERRED |
| H7  | HIGH     | No gzip compression                         | DEFERRED |
| L1  | LOW      | Unsanitized Content-Disposition             | FIXED    |

## Audit Rounds

- Round 1: NEEDS_REVISION — 2 CRITICAL (FR traceability, data model indexes), 5 HIGH, 1 MEDIUM → all fixed
- Round 2: NEEDS_REVISION — 4 HIGH (journal indexes wrong, session index wrong, archivedAt TTL missing, FR-5 section missing), 2 MEDIUM → all fixed
- Round 3: **APPROVED** — 0 CRITICAL, 0 HIGH, 2 MEDIUM (informational: stale FR-8.2 in feature spec, cosmetic SuggestionGenerator naming)

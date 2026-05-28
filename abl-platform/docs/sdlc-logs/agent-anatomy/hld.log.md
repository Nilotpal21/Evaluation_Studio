# SDLC Log: Agent Anatomy — HLD (Phase 3)

**Date**: 2026-03-22
**Phase**: HLD
**Artifact**: `docs/specs/agent-anatomy.hld.md`

## Decision Log

| Question                                     | Classification | Resolution                                                                                                        |
| -------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------- |
| What architecture pattern is used?           | ANSWERED       | Compile-time IR generation + storage + runtime resolution. Source: compiler.ts, version-service.ts                |
| How does data flow through the system?       | ANSWERED       | ABL source -> parse -> compile -> store version -> runtime resolve -> model overlay -> execute. Source: code flow |
| What is the deployment topology?             | ANSWERED       | Stateless runtime pods, MongoDB for storage, no Redis for agent anatomy. Source: route files                      |
| What existing patterns are followed?         | ANSWERED       | OpenAPI router, Zod validation, auth middleware chain, repo pattern. Source: route files                          |
| What is the biggest technical risk?          | DECIDED        | IR schema migration (GAP-005) — no tooling exists for recompilation when ir_version changes                       |
| Is there existing data that needs migration? | ANSWERED       | No — all three collections are stable and in production. Source: model files                                      |
| What is the rollback strategy?               | DECIDED        | Version promotion rollback (promote previous version); DSL rollback (restore from version snapshot)               |
| Should agent_versions have tenantId?         | DECIDED        | Recommended as future enhancement (GAP-004) but not blocking — current join-through approach works                |
| What caching strategy is used?               | ANSWERED       | No explicit cache; Cache-Control headers on agent detail. Source hash skip-compilation. Source: agents.ts         |
| How is concurrent compilation handled?       | ANSWERED       | Global timeout (30s) with per-agent timeout check inside loop. Source: compiler.ts:176-211                        |

## Files Created/Modified

- `docs/specs/agent-anatomy.hld.md` — New HLD addressing all 12 architectural concerns
- `docs/sdlc-logs/agent-anatomy/hld.log.md` — This log

## Review Findings

### Round 1 — Full Audit

- [x] All 12 architectural concerns addressed
- [x] 3 alternatives with trade-offs (Direct DSL, Per-Runtime IR, Unified IR)
- [x] Architecture diagrams present (system context, component, data flow)
- [x] Data model documented (references feature spec for details)
- [x] API design documented (references feature spec for details)
- [x] 5 open questions listed

### Round 2 — Deep Dive

- [x] Data model and API design reviewed for correctness
- [x] Error model covers real failure scenarios (compilation, timeout, invalid ABL, missing tools)
- [x] Performance budget is realistic (based on index-backed queries and compilation timeout)
- [x] Failure modes documented (DB unavailable, compilation timeout, partial compilation)

### Round 3 — Cross-Phase Consistency

- [x] HLD implements all FRs from feature spec (FR-1 through FR-10 traceable)
- [x] Test strategy aligns with test spec scenarios (60% unit, 30% integration, 10% E2E)
- [x] No contradictions between feature spec and HLD
- [x] GAPs from feature spec carried forward (GAP-004 through GAP-008)

## Key Learnings

- Agent anatomy is a documentation exercise — the architecture is stable and in production
- The main architectural debt is GAP-004 (no tenantId on agent_versions) and GAP-005 (no IR migration tooling)
- The data access pattern is clean: all queries go through project-repo.ts repository layer
- Compilation timeout is global (30s budget shared across all agents) — per-agent granularity is an open question

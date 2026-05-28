# SDLC Log: Agent Testing & Evals — HLD

**Phase:** High-Level Design (Phase 3)
**Date:** 2026-03-22
**Status:** Completed

## Inputs Read

1. Feature Spec: `docs/features/agent-testing-evals.md`
2. Test Spec: `docs/testing/agent-testing-evals.md`
3. All 15+ eval service source files in pipeline-engine
4. All 6 eval MongoDB models
5. ClickHouse DDL with 3 tables + 4 MVs
6. Studio integration layer (store, hooks, repo, 22 API routes)

## Architecture Decisions Documented

| ID   | Decision                                                        | Rationale                                    |
| ---- | --------------------------------------------------------------- | -------------------------------------------- |
| AD-1 | Dual storage: MongoDB (config) + ClickHouse (execution results) | Each store excels at its workload pattern    |
| AD-2 | Restate durable workflow for orchestration                      | Custom fan-out logic + durable state + retry |
| AD-3 | Four evaluator types                                            | Balance cost, determinism, and coverage      |
| AD-4 | LLM-based persona simulation                                    | Diversity, realism, adversarial capability   |
| AD-5 | Built-in bias mitigation (4 techniques)                         | Proactive quality over post-hoc analysis     |

## Twelve Concerns Addressed

All 12 architectural concerns documented with concrete implementation details:

1. Resource Isolation
2. Authentication & Authorization
3. Data Model & Persistence
4. Error Handling & Resilience
5. Observability
6. Performance & Scalability
7. Security
8. Compliance & Data Lifecycle
9. Extensibility
10. Testing Strategy
11. Migration & Backward Compatibility
12. Cost Management

## Open Questions Identified

5 open questions documented with impact assessment, primarily around production eval pipeline wiring and CI integration.

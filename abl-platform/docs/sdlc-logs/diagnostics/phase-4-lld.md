# SDLC Log: Diagnostics -- Phase 4 (LLD)

> **Date:** 2026-03-22
> **Phase:** LLD
> **Artifact:** `docs/plans/2026-03-22-diagnostics-impl-plan.md`

## Implementation Plan Summary

- **5 implementation phases**, 23 tasks total
- **Phase 1**: Report persistence + history API (FR-01, FR-02, FR-04, FR-18) -- foundation
- **Phase 2**: Guardrail + Memory analyzers (FR-07, FR-09) -- new coverage
- **Phase 3**: Scheduling + Summary (FR-03, FR-05, FR-06, FR-20) -- automation
- **Phase 4**: Webhook + Conversation Quality analyzers (FR-08, FR-10) -- extended coverage
- **Phase 5**: Remediation framework (FR-11, FR-12) -- actionable findings

## Key Design Decisions

| Decision                               | Rationale                                                       |
| -------------------------------------- | --------------------------------------------------------------- |
| Phase 1 first (persistence)            | All other phases depend on report storage                       |
| Analyzers (Phases 2, 4) parallelizable | They add plugins without dependency on persistence/scheduling   |
| SSRF protection via DNS resolution     | Validates IP before HTTP request, not just URL pattern matching |
| Graceful ClickHouse degradation        | ConversationQualityAnalyzer returns no-data finding, not error  |
| Preview/confirm remediation flow       | Safety guarantee: user must explicitly approve actions          |

## FR-to-Phase Mapping

| Phase    | FRs Covered                              |
| -------- | ---------------------------------------- |
| 1        | FR-01, FR-02, FR-04, FR-18               |
| 2        | FR-07, FR-09                             |
| 3        | FR-03, FR-05, FR-06, FR-20               |
| 4        | FR-08, FR-10                             |
| 5        | FR-11, FR-12                             |
| Deferred | FR-13, FR-14, FR-15, FR-16, FR-17, FR-19 |

## Files to Create (New)

| File                                                                      | Phase | Purpose                           |
| ------------------------------------------------------------------------- | ----- | --------------------------------- |
| `packages/database/src/models/diagnostic-report.ts`                       | 1     | Mongoose model for stored reports |
| `apps/runtime/src/services/diagnostics/persistence.ts`                    | 1     | Report save/query service         |
| `apps/runtime/src/services/diagnostics/analyzers/guardrail-health.ts`     | 2     | GuardrailHealthAnalyzer           |
| `apps/runtime/src/services/diagnostics/analyzers/memory-health.ts`        | 2     | MemoryHealthAnalyzer              |
| `packages/database/src/models/diagnostic-schedule.ts`                     | 3     | Mongoose model for schedules      |
| `apps/runtime/src/services/diagnostics/scheduler.ts`                      | 3     | BullMQ scheduler worker           |
| `apps/runtime/src/services/diagnostics/summary.ts`                        | 3     | Aggregation service               |
| `apps/runtime/src/routes/diagnostics-tenant.ts`                           | 3     | Tenant-level summary route        |
| `apps/runtime/src/services/diagnostics/analyzers/webhook-reachability.ts` | 4     | WebhookReachabilityAnalyzer       |
| `apps/runtime/src/services/diagnostics/analyzers/conversation-quality.ts` | 4     | ConversationQualityAnalyzer       |
| `apps/runtime/src/services/diagnostics/remediation.ts`                    | 5     | Remediation service               |
| `apps/runtime/src/services/diagnostics/handlers/revalidate-credential.ts` | 5     | Credential revalidation handler   |

## Files to Modify (Existing)

| File                                              | Phase   | Change                                              |
| ------------------------------------------------- | ------- | --------------------------------------------------- |
| `packages/database/src/models/index.ts`           | 1, 3    | Export new models                                   |
| `apps/runtime/src/routes/diagnostics.ts`          | 1, 3, 5 | Add history, summary, schedule, remediate endpoints |
| `apps/runtime/src/services/diagnostics/engine.ts` | 2, 4    | Register new analyzers                              |
| `apps/runtime/src/server.ts`                      | 3       | Mount tenant diagnostics router                     |

## Estimated Effort

- **Total**: 7-12 days
- **23 tasks** across 5 phases
- **Critical path**: Phase 1 -> Phase 3 -> Phase 5 (persistence -> scheduling -> remediation)

## Audit Notes

- Each phase has explicit exit criteria with build and test verification
- Wiring checklist ensures no dangling components
- Dependency graph documented for parallel vs sequential phases
- Risk mitigation plan per phase
- All new files follow existing patterns (analyzer interface, route middleware chain, model indexing)

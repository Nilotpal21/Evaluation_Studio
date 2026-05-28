# SDLC Log: Guardrails Feature Spec

**Phase**: 1 - Feature Spec
**Date**: 2026-03-22
**Status**: Complete

---

## Clarifying Questions & Resolutions

### Scope Questions

1. **Q: How many evaluation tiers exist and what are their latency budgets?**
   - Classification: ANSWERED
   - Source: `packages/compiler/src/platform/guardrails/pipeline.ts` (lines 1-18)
   - Answer: 3 tiers -- Tier 1 local (<5ms), Tier 2 model (<500ms), Tier 3 LLM (<5s)

2. **Q: What adapter types are defined vs implemented?**
   - Classification: ANSWERED
   - Source: `packages/database/src/constants/guardrail-adapters.ts`
   - Answer: 15 adapter types in DB enum; 4 have working runtime implementations (openai_moderation, custom_http, custom_webhook, custom_llm); builtin_pii is auto-registered separately

3. **Q: What evaluation kinds are supported?**
   - Classification: ANSWERED
   - Source: `packages/compiler/src/platform/ir/schema.ts` (line 1203)
   - Answer: 5 kinds: input, output, tool_input, tool_output, handoff

### User Stories Questions

4. **Q: Who manages providers vs policies?**
   - Classification: ANSWERED
   - Source: `apps/runtime/src/routes/guardrail-providers.ts` (tenant-scoped), `guardrail-policies.ts` (project-scoped)
   - Answer: Providers are tenant-scoped (tenant admins). Policies are project-scoped (project builders).

5. **Q: Can agents define their own guardrails?**
   - Classification: ANSWERED
   - Source: `packages/compiler/src/platform/ir/schema.ts` Guardrail interface, pipeline.ts PipelinePolicy.additionalGuardrails
   - Answer: Yes, via GUARDRAILS: DSL section in agent definition. These are the highest priority in the 4-level merge.

### Technical Questions

6. **Q: How does policy resolution work across scopes?**
   - Classification: ANSWERED
   - Source: `apps/runtime/src/services/guardrails/policy-resolver.ts` (lines 72-79)
   - Answer: 4-layer merge: platform defaults -> tenant -> project -> agent DSL. Lower-scope rules replace higher-scope for same guardrail name.

7. **Q: How does cost tracking work?**
   - Classification: ANSWERED
   - Source: `apps/runtime/src/services/guardrails/cost-tracker.ts`
   - Answer: Redis INCRBY with microdollars (1 USD = 1,000,000). Key format: guardrail:cost:{tenantId}:{projectId}:{YYYY-MM}. 35-day TTL.

8. **Q: What is the cache key design?**
   - Classification: ANSWERED
   - Source: `apps/runtime/src/services/guardrails/cache.ts`
   - Answer: guardrail:{tenantId}:{projectId}:{guardrailName}:{sha256_16(content)}. TTLs: local=24h, model=1h, llm=never.

9. **Q: How does streaming evaluation work?**
   - Classification: ANSWERED
   - Source: `apps/runtime/src/services/guardrails/streaming-evaluator.ts`
   - Answer: StreamingGuardrailEvaluator buffers tokens, evaluates at sentence boundaries or chunk sizes. Terminal violations trigger early termination.

10. **Q: What trace events are emitted?**
    - Classification: ANSWERED
    - Source: `apps/runtime/src/services/guardrails/trace-events.ts`
    - Answer: 15 event types covering checks, violations, warnings, fixes, reasks, pipeline completion, cost, circuit breaker, cache, provider errors, tool/handoff blocking.

11. **Q: Is the Audit tab in Studio UI functional?**
    - Classification: ANSWERED
    - Source: `apps/studio/src/components/guardrails/GuardrailsConfigPage.tsx` (line 7 comment)
    - Answer: Stub -- "Audit: Guardrail evaluation history (stub)"

12. **Q: Are webhook URLs validated for SSRF?**
    - Classification: ANSWERED
    - Source: `apps/runtime/src/services/guardrails/webhook.ts` (line 15)
    - Answer: Yes, via `assertUrlSafeForSSRF` from `@agent-platform/shared-kernel/security`

## Key Findings

- 49 test files found across compiler and runtime guardrail tests
- 5 Studio UI guardrail components + 2 admin components
- Strong unit coverage for all individual components
- Primary gap: E2E coverage via runtime HTTP API
- 11 of 15 adapter types have no runtime implementation (only DB enum)
- Semantic similarity caching defined in DB schema but not implemented in cache.ts
- `authProfileId` on provider config is reserved but not wired to runtime consumer
- `settings.timeouts` and `settings.webhookUrl` on PolicyResolver are deprecated/not consumed

## Sections Verified

All 18 TEMPLATE.md sections populated:

- [x] 1. Introduction (Problem, Goal, Summary)
- [x] 2. Scope (11 goals, 5 non-goals)
- [x] 3. User Stories (9 stories)
- [x] 4. Functional Requirements (14 FRs)
- [x] 5. Feature Classification (lifecycle table + 8 related features)
- [x] 6. Design Considerations
- [x] 7. Technical Considerations
- [x] 8. How to Consume (Studio UI, Runtime API, Studio API, Admin, Channels)
- [x] 9. Data Model (2 collections + Redis keys)
- [x] 10. Key Implementation Files (25 domain, 5 routes, 10 UI, 1 worker, 49 test files)
- [x] 11. Configuration (4 env vars, runtime config, DSL schema)
- [x] 12. Non-Functional Concerns (isolation, security, performance, reliability, observability, data lifecycle)
- [x] 13. Delivery Plan (8 parent tasks with subtasks)
- [x] 14. Success Metrics (8 metrics)
- [x] 15. Open Questions (5 items)
- [x] 16. Gaps (10 items)
- [x] 17. Testing & Validation (23-item coverage matrix)
- [x] 18. References

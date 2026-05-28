# Guardrail Runtime Audit Fixes — High-Level Design

## What

Fix 8 gaps identified during a deep audit of the guardrail runtime subsystem. These range from dead code paths (constitution field, unused trace factories) to missing wiring (webhook port, streaming config, projectId for cost tracking) to incorrect data flow (wrong GuardrailContext in flow-step-executor, dropped `isActive` on provider overrides) and a missing input guardrail gate for pure flow steps. The fixes make the guardrail system production-complete: every configured feature actually executes, every trace event uses the canonical factory, and every pipeline call site passes correct context.

## Architecture Approach

### Packages changed

| Package             | What changes                                                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/compiler` | `PipelinePolicy.providerOverrides` gains `isActive` field; `Tier3Evaluator.buildEvalPrompt` accepts constitution constraints; pipeline skips inactive providers                                                                      |
| `packages/database` | No schema changes — `IGuardrailStreamingSettings`, `IConstitutionPrinciple`, `webhookUrl/Secret` already exist in the model                                                                                                          |
| `apps/runtime`      | `pipeline-factory.ts` threads `projectId` and `constitution`, wires webhook; `flow-step-executor.ts` fixes GuardrailContext and adds top-level input guardrails; `runtime-executor.ts` and all executors adopt trace-event factories |

### Data Flow

```
                     DB Policy Document
                           |
                    [constitution[], webhookUrl,
                     webhookSecret, streaming,
                     providerOverrides[].isActive]
                           |
                     loadPoliciesFromDB()
                           |
                     policy-resolver.ts
                     (merges scopes)
                           |
                     toPipelinePolicy()     <-- Gap 1: thread constitution
                           |                <-- Gap 2: wire webhook from settings
                           |                <-- Gap 4: forward isActive
                           |                <-- Gap 5: real projectId
                           |
              createGuardrailPipeline(llmEval, tenantId, projectId, options)
                           |
              ┌────────────┼────────────┐
          Tier 1         Tier 2       Tier 3
         (CEL)       (Providers)   (LLM Judge)
              |            |            |
              |     skip isActive=false |
              |            |     prepend constitution
              |            |     constraints to prompt
              └────────────┼────────────┘
                           |
                     Pipeline Result
                           |
                  ┌────────┼────────┐
          trace factories  webhook   streaming config
          (Gap 8)         (Gap 2)   (Gap 6)
```

### Key Integration Points

1. **pipeline-factory.ts** is the central hub — 5 of 8 gaps touch it
2. **flow-step-executor.ts** has 2 gaps (input guardrail gate + wrong context)
3. **Tier3Evaluator** in compiler needs constitution injection
4. **All 4 executors** need trace factory adoption (Gap 8)
5. **Tier2Evaluator** in compiler needs `isActive` check in pipeline dispatch

## Decisions & Tradeoffs

- **Decision 1**: Thread constitution through `PipelinePolicy` rather than as a separate parameter to `pipeline.execute()` — keeps the policy as the single source of runtime config, avoids changing the 15+ call sites of `pipeline.execute()`.
- **Decision 2**: Constitution is injected as a system-level prefix in the Tier 3 LLM prompt rather than creating a separate tier — constitutions are evaluated by the same LLM judge, just with additional context. Keeps the 3-tier architecture clean.
- **Decision 3**: The `isActive` check happens at the pipeline level (skip provider when `isActive === false`) rather than in the registry — the registry is a permanent store, `isActive` is a policy overlay.
- **Decision 4**: Webhook wiring reads `webhookUrl`/`webhookSecret` from the resolved policy's settings rather than from a separate config table — the fields already exist in the DB model.
- **Decision 5**: For Gap 3 (flow-step input guardrails), we reuse the existing `checkInputGuardrails` pattern already present at line 5145 of `flow-step-executor.ts` but ensure it runs unconditionally for all flow entry points, not just when entering a reasoning zone.
- **Decision 6**: Gap 6 (streaming config) threads the policy's `settings.streaming` into `StreamingEvalConfig` — no new DB schema needed since `IGuardrailStreamingSettings` already exists.
- **Decision 7**: Gap 8 (trace factory adoption) is a pure refactor — replace hand-constructed `onTraceEvent({type, data})` objects with the corresponding factory call from `trace-events.ts`. No behavior change.

## Task Decomposition

| Task                                          | Package(s)        | Independent? | Est. Files | Gap(s)   |
| --------------------------------------------- | ----------------- | ------------ | ---------- | -------- |
| T-1: Constitution injection                   | compiler, runtime | Yes          | 4-5        | Gap 1    |
| T-2: Webhook wiring                           | runtime           | Yes          | 2-3        | Gap 2    |
| T-3: Flow-step input guardrails + context fix | runtime           | Yes          | 1-2        | Gap 3, 7 |
| T-4: Provider isActive forwarding             | compiler, runtime | Yes          | 2-3        | Gap 4    |
| T-5: ProjectId cost tracking                  | runtime           | Yes          | 2-3        | Gap 5    |
| T-6: Streaming config threading               | runtime           | Yes          | 2-3        | Gap 6    |
| T-7: Trace factory adoption                   | runtime           | Yes          | 4-5        | Gap 8    |

## Out of Scope

- No new UI components (Gap 6 originally mentioned Studio form changes — deferred since the streaming toggle UI is a separate feature)
- No new Mongoose schema changes — all fields already exist in the DB model
- No changes to the 3-tier pipeline architecture
- No changes to the policy resolution merge logic
- No new test files for individual gaps — these are wiring fixes verified by existing test infrastructure and build checks

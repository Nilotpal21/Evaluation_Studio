# LLD: PII Studio -> DB -> DSL -> Runtime Hardening

**Feature Spec**: `docs/features/pii-detection.md`
**HLD**: `docs/specs/pii-detection.hld.md`
**Test Spec**: `docs/testing/pii-detection.md`
**Status**: DONE
**Date**: 2026-05-03

---

## 1. Design Decisions

### Decision Log

| ID   | Decision                                                                                                        | Rationale                                                                                                                                                                                                            | Alternatives Rejected                                                                                                                                 |
| ---- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1  | Keep project-scoped PII detection request-scoped, not singleton-scoped                                          | Studio patterns and builtin overrides are project policy, so shared compiler singletons and tenant-wide guardrail registries are the wrong ownership level                                                           | Mutating `getDefaultPIIRecognizerRegistry()` at runtime; stuffing project state into tenant-scoped `GuardrailProviderRegistry`                        |
| D-2  | Use a reusable runtime project PII snapshot loader for non-session boundaries                                   | Persistence and omnichannel read surfaces often know `tenantId` + `projectId` but do not hold a live session                                                                                                         | Requiring every caller to hand-build a registry; duplicating DB loads in each service                                                                 |
| D-3  | Thread the recognizer registry through compiler evaluation seams as optional context                            | CEL, builtin guardrails, action application, trace scrubbing, and provider evaluation all need the same project-aware detector without breaking existing call sites                                                  | Rewriting all APIs around a new detector object in one pass                                                                                           |
| D-4  | Reuse the existing runtime read-boundary renderer for omnichannel history surfaces                              | Session history routes already have the right contract: secrets always scrubbed, original rendering suppressed on normal read paths, and custom patterns honored                                                     | Keeping separate omnichannel-only redaction logic with `filterOutputPII()`                                                                            |
| D-5  | Fix transient serialization independently before broader runtime work                                           | The serializer bug is isolated, easy to lock with tests, and prevents Studio from silently dropping runtime semantics                                                                                                | Bundling serializer work into runtime slices and increasing blast radius                                                                              |
| D-6  | Route analytics custom-dimension validation through the same project/session PII seam                           | `_meta.*`, SDK `customAttributes`, and REST metadata injection all end up in `platform_events.custom_dimensions`, so they must honor project custom patterns and builtin overrides                                   | Keeping a bespoke regex allow/deny list in analytics metadata validation                                                                              |
| D-7  | Centralize stored-session read-surface context construction in one helper                                       | The session route fallback still rebuilds project PII context manually; one helper keeps vault deserialization, pattern loading, and future cache/epoch changes from drifting                                        | Letting `sessions.ts` keep its own snapshot reconstruction path                                                                                       |
| D-8  | Resolve trace scrubbing registries lazily from the live runtime session                                         | Trace writers are long-lived per session, so getter-backed registry resolution avoids stale custom-pattern coverage after cache refresh or policy invalidation                                                       | Capturing a one-time registry snapshot when the handler/tracer is first created                                                                       |
| D-9  | Treat streaming output guardrails as first-class runtime PII boundaries                                         | Streaming `builtin-pii` / CEL output checks execute on runtime-owned pipelines, so they must receive the same session-scoped recognizer registry as non-streaming guardrails                                         | Relying on built-in-only fallback during streaming while the rest of runtime uses project-aware detection                                             |
| D-10 | Rehydrate persisted vaults through the shared session refresh seam before first use                             | Cross-pod session restores should become PII-ready immediately instead of depending on a later execution/read path to attach the project registry                                                                    | Leaving vault registry repair as an incidental side effect of later reasoning or read-surface refreshes                                               |
| D-11 | Introduce one shared scripted-output protection seam for authored flow text                                     | Flow prompts, ON_START greetings, and template RESPOND steps all need the same user-visible rendering and tokenized-history behavior as reasoning mode                                                               | Fixing each flow prompt site ad hoc with bespoke `filterOutputPII()` calls                                                                            |
| D-12 | Refresh session PII context before init-time guardrails and lifecycle execution                                 | Fresh sessions must be PII-ready before streaming pipelines, ON_START, and other init-time runtime logic run                                                                                                         | Depending on later turn execution or read-surface access to hydrate project/session PII state                                                         |
| D-13 | Make init-time trace centralization idempotent and session-scoped                                               | `initializeSession()` can be called standalone or from `executeMessage()`, so the centralized trace wrapper must avoid double-wrapping while still covering init-only channel paths                                  | Duplicating trace-storage logic in every channel handler or leaving init-time trace scrubbing as a handler-specific concern                           |
| D-14 | Protect authored structured payloads with a field-aware transform instead of blind JSON redaction               | User-visible strings inside `richContent`, `voiceConfig`, and action labels need redaction, but narrow transport fields like action IDs/render IDs must stay stable for runtime behavior                             | Redacting every structured string indiscriminately and breaking action callbacks or transport wiring                                                  |
| D-15 | Finalize flow-owned structured payloads at shared return seams and pending-state writes                         | Flow execution emits structured payloads from many branches (`ON_START`, gather prompts, normal RESPOND, action handlers), so one return-time seam plus pending-state protection reduces drift                       | Patching every individual `lastResult` construction site by hand and relying on future branches to remember the fix                                   |
| D-16 | Redact durable structured envelopes textually, then fail closed if preserved transport fields still contain PII | Persistence must sanitize user-visible structured fields while refusing to store envelopes when callback/value-style transport fields still contain raw PII after redaction                                          | Dropping every structured envelope whenever any text PII is present; storing raw envelopes and trusting later read surfaces                           |
| D-17 | Route helper-owned assistant side effects through one shared execution-result protection seam                   | `COMPLETE`, `AWAIT_ATTACHMENT`, constraint responses, and KB `DIRECT` fast paths all emit assistant text outside `FlowStepExecutor`, so they need one reusable contract for delivery vs history                      | Fixing each helper independently with ad hoc PII calls and relying on future helper paths not to drift                                                |
| D-18 | Treat cross-thread returns and error-handler `respond` payloads as first-class output seams                     | Remote handoff returns, hook/error fallback responses, and compiled `onError` structured payloads all re-enter runtime delivery outside normal authored-flow paths, so they need the same shared protection contract | Leaving remote/error helper paths partially raw or fixing text-only behavior while compiled `richContent` / `voiceConfig` payloads still drop or leak |
| D-19 | Preserve hook structured payloads and structured tool-error responses as typed envelopes, not metadata sidecars | Hook cards/voice/actions and reasoning error-handler structured responses need canonical runtime delivery surfaces that survive parser/compiler/runtime boundaries without inventing one-off reserved metadata seams | Keeping hook structure text-only at runtime; relying on `__error_handler_*` reserved metadata without a break-loop result contract                    |

### Assumptions

- The highest-value end-to-end path is `Studio config -> DB patterns/config -> compiler/runtime evaluation -> persistence/read surfaces`.
- Compiler NLU tenant-manager wiring remains shared-config based today; this plan hardens the request-scoped runtime execution path first and keeps any optional NLU registry plumbing backward compatible.
- Existing dirty worktree changes are unrelated and must not be reverted.

### Current Execution Status

- Phase 1 is complete: Studio transient gather serialization now round-trips correctly.
- Phase 2 is complete: compiler/CEL/guardrail/action/trace seams now accept request-scoped recognizer registries.
- Phase 3 is complete: runtime persistence, traces, and omnichannel read surfaces now use project snapshots with epoch invalidation.
- Phase 4 is complete: analytics metadata/custom dimensions now honor the shared project/session PII seam.
- Phase 5 is complete: stored-session read surfaces now build context through the shared helper in `session-pii-context.ts`.
- Phase 6 is complete: centralized runtime trace storage and tracer-originated events now resolve project/session PII registries lazily from the live runtime session.
- Phase 7 is complete: runtime streaming output guardrails and session rehydration now align with the same live project/session PII seam.
- Phase 8 is complete: scripted flow/template outputs now converge on a shared output-protection seam so ON_START, RESPOND, and authored flow prompts use masked delivery plus tokenized history.
- Phase 9 is complete: fresh-session initialization now hydrates project/session PII state before init-time guardrails and lifecycle execution.
- Phase 10 is complete: init-only trace paths now reuse the centralized scrub/store seam without duplicating TraceStore writes in channel handlers.
- Phase 11 is complete: authored flow structured payloads now use a field-aware protection seam so ON_START, normal RESPOND, gather prompts, and returned action labels do not leak raw project/session PII.
- Phase 12 is complete: durable assistant `contentEnvelope` persistence now detects structured-only PII, redacts user-visible structured fields, and drops the envelope if preserved transport fields still contain raw PII.
- Phase 13 is complete: `ACTION_HANDLER.respond` now reuses the same protected text/history seam as other authored runtime output paths.
- Phase 14 is complete: helper-owned runtime output paths (`COMPLETE`, `AWAIT_ATTACHMENT`, constraint responses, and KB `DIRECT` short-circuit replies) now reuse a shared execution-result protection seam for redacted delivery plus tokenized history.
- Phase 15 is complete: remote handoff returns/resume paths, helper fallback `respond` flows, hook `RESPOND`, and runtime error-handler structured payload delivery now align with the shared output-protection seam.
- Phase 16 is complete: hook structured payloads now survive parser -> compiler -> runtime history wiring, async remote sync-fallback and escalated-session fallback replies are protected, and reasoning structured `on_error` responses now exit through a typed break-loop result instead of metadata-only sidecars.

### Key Interfaces & Types

```ts
interface GuardrailContext {
  recentMessages?: Array<{ role: string; content: string }>;
  piiRecognizerRegistry?: PIIRecognizerRegistry;
}

interface GuardrailEvalRequest {
  content: string;
  category: string;
  context?: {
    recentMessages?: Array<{ role: string; content: string }>;
    piiRecognizerRegistry?: PIIRecognizerRegistry;
  };
}

interface RuntimePIIProjectSnapshot {
  piiRedactionConfig: RuntimePIIRedactionConfig;
  piiRecognizerRegistry?: PIIRecognizerRegistry;
  piiPatternConfigs: PIIPatternConfig[];
}

interface DimensionValidationOptions {
  piiRecognizerRegistry?: PIIRecognizerRegistry;
  enforcePII?: boolean;
}

interface DimensionPolicyContext {
  piiRecognizerRegistry?: PIIRecognizerRegistry;
  piiRedactionConfig?: { enabled?: boolean };
}

interface TraceScrubContext {
  piiRecognizerRegistry?: PIIRecognizerRegistry;
}

interface WritePipelineConfig {
  getPIIRecognizerRegistry?: () => PIIRecognizerRegistry | undefined;
}

interface StructuredOutputPayload {
  blocks?: ContentBlock[];
  richContent?: RichContentIR;
  actions?: ActionSetIR;
  voiceConfig?: VoiceConfigIR;
}

interface ProtectedExecutionResultForUser {
  result: ExecutionResult;
  historyText: string;
}
```

### Module Boundaries

| Module                                                                  | Responsibility                                                                                                            | Depends On                                                   |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `apps/studio/src/lib/abl-serializers.ts`                                | Preserve Studio-authored gather semantics in DSL output                                                                   | Studio gather field model                                    |
| `packages/compiler/src/platform/security/*`                             | Pure PII detect/redact helpers with optional registry                                                                     | `PIIRecognizerRegistry`                                      |
| `packages/compiler/src/platform/guardrails/*`                           | Request-scoped CEL/provider/action plumbing                                                                               | security helpers                                             |
| `apps/runtime/src/services/pii/session-pii-context.ts`                  | Build project/session PII snapshots from DB config + patterns                                                             | runtime config repo, pattern loader                          |
| `apps/runtime/src/services/metadata/custom-dimensions.ts`               | Validate analytics metadata with the same project/session PII policy seam                                                 | compiler detector + runtime session PII context              |
| `apps/runtime/src/services/message-persistence-queue.ts`                | Persist safe canonical message content, including structured-envelope redaction and fail-closed durable envelope handling | runtime PII snapshot loader                                  |
| `apps/runtime/src/services/trace-emitter.ts`                            | Scrub traces with session-aware recognizer registry                                                                       | trace scrubber + runtime session                             |
| `apps/runtime/src/services/runtime-executor.ts`                         | Centralized runtime trace storage and execution-time EventStore forwarding                                                | trace scrubber + live runtime session                        |
| `apps/runtime/src/services/tracing/write-pipeline.ts`                   | Scrub tracer-originated span/events with live session-aware recognizer state                                              | trace scrubber + live runtime session                        |
| `apps/runtime/src/services/execution/session-output-protection.ts`      | Shared user/history rendering contract plus field-aware structured payload transforms for authored runtime outputs        | `output-pii-filter`, runtime audit logger, session PII state |
| `apps/runtime/src/services/execution/await-attachment-executor.ts`      | Route attachment helper first prompts and re-prompts through the shared execution-result protection seam                  | `session-output-protection`, thread await state              |
| `apps/runtime/src/services/execution/constraint-checker.ts`             | Route constraint response side effects through shared execution-result protection                                         | `session-output-protection`, localized message helpers       |
| `apps/runtime/src/services/execution/routing-executor.ts`               | Route `executeComplete(...)` through shared execution-result protection                                                   | `session-output-protection`, routing helper contracts        |
| `apps/runtime/src/services/execution/reasoning-executor.ts`             | Route KB `DIRECT` short-circuit replies through shared execution-result protection                                        | `session-output-protection`, KB fast-path classification     |
| `apps/runtime/src/services/execution/hook-executor.ts`                  | Route hook-owned `RESPOND` side effects through the shared protected delivery/history seam                                | `session-output-protection`, hook side-effect helpers        |
| `apps/runtime/src/services/execution/error-handler-router.ts`           | Preserve compiled `onError` structured payload fields through runtime error resolution                                    | compiler error-handler IR                                    |
| `apps/runtime/src/services/runtime-executor.ts`                         | Protect remote resume/fire-and-forget return delivery before final runtime response construction                          | `session-output-protection`, thread return helpers           |
| `apps/runtime/src/__tests__/execution/flow-authored-output-pii.test.ts` | Lock DSL-compiled ON_START/RESPOND authored output masking behavior                                                       | `FlowStepExecutor`, session PII refresh seam                 |
| `apps/runtime/src/__tests__/agent-lifecycle.test.ts`                    | Lock runtime-created streaming guardrail pipeline wiring                                                                  | mocked runtime executor streaming imports                    |
| `apps/runtime/src/services/omnichannel/*`                               | Read-boundary rendering for transcript/recall                                                                             | runtime PII snapshot loader + runtime read-boundary renderer |

## 2. File-Level Change Map

### New Files

| File                                                                     | Purpose                     | LOC Estimate |
| ------------------------------------------------------------------------ | --------------------------- | ------------ |
| `docs/plans/2026-05-02-pii-studio-db-dsl-runtime-hardening-impl-plan.md` | Focused LLD and phased plan | ~180         |

### Modified Files

| File                                                                                    | Change Description                                                                                                                                              | Risk   |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `apps/studio/src/lib/abl-serializers.ts`                                                | Serialize `transient: true` independently of `sensitive`                                                                                                        | Low    |
| `apps/studio/src/__tests__/abl-serializers.test.ts`                                     | Lock serializer behavior                                                                                                                                        | Low    |
| `packages/compiler/src/platform/security/pii-detector.ts`                               | Allow `redactPII()` to use an optional registry                                                                                                                 | Low    |
| `packages/compiler/src/platform/constructs/cel-functions.ts`                            | Build CEL envs bound to optional project registry                                                                                                               | Medium |
| `packages/compiler/src/platform/constructs/cel-evaluator.ts`                            | Allow request-scoped CEL evaluation options                                                                                                                     | Medium |
| `packages/compiler/src/platform/guardrails/provider.ts`                                 | Extend provider request context with optional recognizer registry                                                                                               | Low    |
| `packages/compiler/src/platform/guardrails/providers/builtin-pii.ts`                    | Use request-scoped registry when provided                                                                                                                       | Low    |
| `packages/compiler/src/platform/guardrails/tier1-evaluator.ts`                          | Evaluate CEL with project-scoped registry                                                                                                                       | Medium |
| `packages/compiler/src/platform/guardrails/tier2-evaluator.ts`                          | Pass project-scoped registry to model providers                                                                                                                 | Medium |
| `packages/compiler/src/platform/guardrails/types.ts`                                    | Extend guardrail context with optional recognizer registry                                                                                                      | Low    |
| `packages/compiler/src/platform/guardrails/action-executors.ts`                         | Redact/fix actions honor project-scoped registry                                                                                                                | Medium |
| `packages/compiler/src/platform/guardrails/action-applier.ts`                           | Thread registry into content-modifying actions                                                                                                                  | Medium |
| `packages/compiler/src/platform/constructs/executors/trace-scrubber.ts`                 | Scrub traces with optional project-scoped registry                                                                                                              | Medium |
| `packages/compiler/src/platform/nlu/enterprise/pii-guard.ts`                            | Backward-compatible optional registry plumbing for input redaction hook                                                                                         | Low    |
| `apps/runtime/src/services/pii/session-pii-context.ts`                                  | Export reusable project snapshot loader with bounded cache                                                                                                      | Medium |
| `apps/runtime/src/services/metadata/custom-dimensions.ts`                               | Replace bespoke regex checks with project/session-aware validation seam                                                                                         | Medium |
| `apps/runtime/src/services/metadata/__tests__/custom-dimensions.test.ts`                | Lock custom-pattern, builtin override, and disabled-policy metadata behavior                                                                                    | Low    |
| `apps/runtime/src/services/message-persistence-queue.ts`                                | Detect structured-only PII, redact durable structured envelopes, and fail closed when preserved transport fields still contain PII                              | High   |
| `apps/runtime/src/services/trace-emitter.ts`                                            | Accept and use a session recognizer registry                                                                                                                    | Medium |
| `apps/runtime/src/services/omnichannel/live-session-service.ts`                         | Render transcript backfill through project-aware read boundary                                                                                                  | Medium |
| `apps/runtime/src/services/omnichannel/recall-service.ts`                               | Render recall history through project-aware read boundary                                                                                                       | Medium |
| `apps/runtime/src/websocket/handler.ts`                                                 | Pass session recognizer registry into trace emitter                                                                                                             | Low    |
| `apps/runtime/src/websocket/sdk-handler.ts`                                             | Route SDK metadata extraction through session-aware dimension validation                                                                                        | Medium |
| `apps/runtime/src/services/execution/flow-step-executor.ts`                             | Finalize authored structured payloads at return seams, protect pending rich content, and route action-handler respond through the shared output-protection seam | Medium |
| `apps/runtime/src/services/execution/reasoning-executor.ts`                             | Route runtime `_meta.*` writes through session-aware dimension validation and protect KB `DIRECT` fast-path short-circuit replies                               | Medium |
| `apps/runtime/src/services/execution/session-output-protection.ts`                      | Share masked-delivery/tokenized-history rendering, field-aware structured transforms, and execution-result protection for helper-owned runtime outputs          | Medium |
| `apps/runtime/src/services/execution/routing-executor.ts`                               | Route `executeComplete(...)` through shared execution-result protection                                                                                         | Medium |
| `apps/runtime/src/services/execution/await-attachment-executor.ts`                      | Route attachment helper first prompts and re-prompts through shared execution-result protection                                                                 | Medium |
| `apps/runtime/src/services/execution/constraint-checker.ts`                             | Route constraint response side effects and handoff-failure fallbacks through shared execution-result protection                                                 | Medium |
| `apps/runtime/src/routes/sessions.ts`                                                   | Route REST metadata injection and stored-session read-surface fallback through shared helpers                                                                   | Medium |
| `apps/runtime/src/services/runtime-executor.ts`                                         | Pass session-aware recognizer registry into centralized runtime trace scrubbing                                                                                 | Medium |
| `apps/runtime/src/services/tracing/write-pipeline.ts`                                   | Resolve a live recognizer registry during tracer-originated event scrubbing                                                                                     | Medium |
| `apps/runtime/src/__tests__/agent-lifecycle.test.ts`                                    | Lock streaming output guardrail pipeline registry wiring for init + execute paths                                                                               | Low    |
| `apps/runtime/src/services/execution/__tests__/session-output-protection.test.ts`       | Lock authored-output masking/tokenized-history behavior plus execution-result protection parity                                                                 | Low    |
| `apps/runtime/src/__tests__/routing/routing-executor-unit.test.ts`                      | Lock completion helper custom-pattern protection for delivery, history, and structured payloads                                                                 | Low    |
| `apps/runtime/src/__tests__/execution/flow-step-await-attachment.test.ts`               | Lock attachment helper prompt and re-prompt custom-pattern protection                                                                                           | Low    |
| `apps/runtime/src/__tests__/execution/pre-refactor/constraint-actions-extended.test.ts` | Lock constraint response side effects against raw custom-pattern delivery/history leakage                                                                       | Low    |
| `packages/compiler/src/__tests__/guardrails/providers/builtin-pii.test.ts`              | Lock project-aware builtin provider behavior                                                                                                                    | Low    |
| `packages/compiler/src/__tests__/guardrails/cel-guardrail-functions.test.ts`            | Lock project-aware CEL PII functions                                                                                                                            | Low    |
| `packages/compiler/src/__tests__/guardrails/action-applier.test.ts`                     | Lock project-aware redact/fix actions                                                                                                                           | Low    |
| `packages/compiler/src/__tests__/enterprise/pii-guard.test.ts`                          | Lock optional project-aware PII guard hook                                                                                                                      | Low    |
| `packages/compiler/src/__tests__/constructs/trace-scrubber.test.ts`                     | Lock project-aware trace scrubbing                                                                                                                              | Low    |
| `apps/runtime/src/__tests__/pii/session-pii-context.test.ts`                            | Lock snapshot loading and session hydration                                                                                                                     | Low    |
| `apps/runtime/src/__tests__/reported-pii-masking-gaps.test.ts`                          | Lock structured-envelope persistence redaction, fail-closed envelope dropping, and KB `DIRECT` fast-path helper protection                                      | Medium |
| `apps/runtime/src/__tests__/trace-emitter-masking.test.ts`                              | Lock custom-pattern trace scrubbing                                                                                                                             | Medium |
| `apps/runtime/src/__tests__/channels/omnichannel-recall-service.integration.test.ts`    | Lock DB -> recall -> read-surface custom redaction                                                                                                              | Medium |
| `apps/runtime/src/__tests__/observability/tracing/write-pipeline.test.ts`               | Lock tracer write-pipeline custom-pattern scrubbing and live-registry refresh                                                                                   | Low    |

## 3. Implementation Phases

### Phase 1: Studio Serializer Fidelity

**Goal**: Preserve transient gather semantics when Studio round-trips visual editor state back to DSL.

**Tasks**:

1. Add a serializer test that covers `transient: true` with `sensitive: false`.
2. Emit `transient: true` independently from the `sensitive` block.
3. Verify no existing gather semantics regress.

**Files Touched**:

- `apps/studio/src/lib/abl-serializers.ts`
- `apps/studio/src/__tests__/abl-serializers.test.ts`

**Exit Criteria**:

- [ ] A serializer test fails before the fix and passes after it.
- [ ] `transient: true` is present in serialized gather DSL when authored without `sensitive: true`.
- [ ] `pnpm build --filter=@agent-platform/studio` succeeds.

**Test Strategy**:

- Unit: serializer regression in `abl-serializers.test.ts`

**Rollback**: Revert the serializer condition; no data migration required.

### Phase 2: Compiler Request-Scoped PII Plumbing

**Goal**: Make DSL/CEL/builtin guardrail/trace/action code honor a project-scoped recognizer registry without mutating process-wide singletons.

**Tasks**:

1. Extend core detector helpers and trace scrubbers to accept an optional registry.
2. Add request-scoped registry plumbing to CEL environment creation/evaluation.
3. Extend guardrail provider request/context types and thread registry through Tier 1, Tier 2, and action application.
4. Keep `createPIIGuardHook()` backward compatible while allowing an explicit registry.

**Files Touched**:

- `packages/compiler/src/platform/security/pii-detector.ts`
- `packages/compiler/src/platform/constructs/cel-functions.ts`
- `packages/compiler/src/platform/constructs/cel-evaluator.ts`
- `packages/compiler/src/platform/guardrails/provider.ts`
- `packages/compiler/src/platform/guardrails/providers/builtin-pii.ts`
- `packages/compiler/src/platform/guardrails/tier1-evaluator.ts`
- `packages/compiler/src/platform/guardrails/tier2-evaluator.ts`
- `packages/compiler/src/platform/guardrails/types.ts`
- `packages/compiler/src/platform/guardrails/action-executors.ts`
- `packages/compiler/src/platform/guardrails/action-applier.ts`
- `packages/compiler/src/platform/constructs/executors/trace-scrubber.ts`
- `packages/compiler/src/platform/nlu/enterprise/pii-guard.ts`

**Exit Criteria**:

- [ ] `builtin-pii` detects custom patterns when a registry is supplied.
- [ ] `abl.contains_pii()` and `abl.redact_pii()` honor custom patterns and disabled builtins when evaluated with a registry.
- [ ] Guardrail redact/fix actions and trace scrubbing honor custom patterns when a registry is supplied.
- [ ] `pnpm build --filter=@abl/compiler` succeeds.

**Test Strategy**:

- Unit: provider, CEL, action-applier, trace-scrubber, and PII guard tests

**Rollback**: Remove optional registry threading and fall back to builtin-only helpers.

### Phase 3: Runtime Snapshot Loader And Boundary Propagation

**Goal**: Reuse one bounded project snapshot seam across persistence, traces, and omnichannel read surfaces.

**Tasks**:

1. Refactor `session-pii-context.ts` to expose a reusable project snapshot loader with TTL + bounded eviction.
2. Update message persistence to use the project snapshot when `tenantId` + `projectId` are known.
3. Update trace emission to accept session recognizer registry and scrub custom patterns in trace payloads.
4. Route omnichannel transcript/recall reads through the read-boundary renderer using a project snapshot.

**Files Touched**:

- `apps/runtime/src/services/pii/session-pii-context.ts`
- `apps/runtime/src/services/message-persistence-queue.ts`
- `apps/runtime/src/services/trace-emitter.ts`
- `apps/runtime/src/services/omnichannel/live-session-service.ts`
- `apps/runtime/src/services/omnichannel/recall-service.ts`
- `apps/runtime/src/websocket/handler.ts`

**Exit Criteria**:

- [ ] Persistence redacts custom project patterns from raw message content when runtime config enables scrubbing.
- [ ] Trace emitter redacts custom project patterns when given a session recognizer registry.
- [ ] Recall/live-session read surfaces honor custom patterns and disabled builtins from DB-backed project config.
- [ ] `pnpm build --filter=@agent-platform/runtime` succeeds.

**Test Strategy**:

- Unit: snapshot loader, message persistence gap regression, trace emitter masking regression
- Integration: omnichannel recall with DB-seeded project runtime config and PII patterns

**Rollback**: Revert boundary callers to their old helper paths and remove the snapshot loader usage.

### Phase 4: Analytics Metadata PII Policy Alignment

**Goal**: Make custom dimensions honor the same project/session PII policy as the rest of runtime execution.

**Tasks**:

1. Add dimension-validation options that accept a recognizer registry and policy enablement flag.
2. Add a shared session-level helper so SDK bootstrap, websocket caller-context, DSL `SET _meta.*`, reasoning writes, and REST metadata injection all use one validation seam.
3. Replace the legacy hardcoded PII regex subset with compiler-backed detection that can honor project custom patterns and builtin overrides.
4. Add regression tests for custom project patterns, builtin phone/IP coverage, and disabled-policy pass-through.

**Files Touched**:

- `apps/runtime/src/services/metadata/custom-dimensions.ts`
- `apps/runtime/src/services/metadata/__tests__/custom-dimensions.test.ts`
- `apps/runtime/src/websocket/sdk-handler.ts`
- `apps/runtime/src/websocket/handler.ts`
- `apps/runtime/src/services/execution/flow-step-executor.ts`
- `apps/runtime/src/services/execution/reasoning-executor.ts`
- `apps/runtime/src/routes/sessions.ts`

**Exit Criteria**:

- [ ] Project custom PII patterns are rejected from custom dimensions when session/project PII policy is enabled.
- [ ] Builtin phone/IP recognizers are applied to custom dimensions when a builtin registry is present.
- [ ] Disabled project/session PII policy can intentionally allow metadata values through without the validator forcing legacy regex behavior.
- [ ] `pnpm build --filter=@agent-platform/runtime` succeeds.

**Test Strategy**:

- Unit: custom-dimension validator and shared session-level helper regressions

**Rollback**: Revert the helper/callsite migration and restore the legacy regex subset.

### Phase 5: Stored-Session Read-Surface Consolidation

**Goal**: Ensure stored-session read surfaces construct PII context from one shared helper instead of route-local duplication.

**Tasks**:

1. Add a shared helper that builds read-surface context for stored sessions using runtime config, project patterns, and optional serialized vault state.
2. Update `sessions.ts` to call the shared helper instead of rebuilding registries and pattern configs inline.
3. Add regression coverage proving serialized vault data still renders through the shared helper with project custom patterns.

**Files Touched**:

- `apps/runtime/src/services/pii/session-pii-context.ts`
- `apps/runtime/src/__tests__/pii/session-pii-context.test.ts`
- `apps/runtime/src/routes/sessions.ts`

**Exit Criteria**:

- [ ] Stored-session read-surface helper rehydrates serialized vault data with the project recognizer registry.
- [ ] Session route builds with no direct recognizer-registry/pattern-loader duplication left in the fallback path.
- [ ] `pnpm build --filter=@agent-platform/runtime` succeeds.

**Test Strategy**:

- Unit: session PII context helper regression covering stored-session vault deserialization

**Rollback**: Revert the helper extraction and restore the session-route-local fallback builder.

### Phase 6: Runtime Execution Trace Registry Parity

**Goal**: Ensure centralized trace storage and tracer-originated events honor the same live project/session PII registry as the rest of runtime execution.

**Tasks**:

1. Add a failing regression proving `RuntimeExecutor.createCentralizedTraceHandler()` misses custom project patterns when scrubbing trace data.
2. Add a failing regression proving `WritePipelineImpl` misses custom project patterns unless it resolves a live recognizer registry.
3. Extend the centralized trace handler to read `piiRecognizerRegistry` from the live session reference on every emit.
4. Extend `WritePipelineImpl` with a getter-backed `getPIIRecognizerRegistry()` seam and wire it from `RuntimeExecutor`.
5. Keep all new trace-registry plumbing optional and backward compatible for existing callers/tests.

**Files Touched**:

- `apps/runtime/src/services/runtime-executor.ts`
- `apps/runtime/src/services/tracing/write-pipeline.ts`
- `apps/runtime/src/__tests__/reported-pii-masking-gaps.test.ts`
- `apps/runtime/src/__tests__/observability/tracing/write-pipeline.test.ts`

**Exit Criteria**:

- [ ] Centralized runtime trace storage redacts custom project patterns when the session recognizer registry is present.
- [ ] Tracer-originated `tool_call`/span events redact custom project patterns via a live registry getter.
- [ ] Trace scrubbing remains backward compatible when no recognizer registry is available.
- [ ] `pnpm build --filter=@agent-platform/runtime` succeeds.

**Test Strategy**:

- Unit: centralized runtime trace regression in `reported-pii-masking-gaps.test.ts`
- Unit: write-pipeline registry getter regression in `observability/tracing/write-pipeline.test.ts`

**Rollback**: Remove the live-registry plumbing and revert the tests; runtime falls back to built-in-only trace scrubbing.

### Phase 7: Runtime Streaming And Rehydration Registry Parity

**Goal**: Ensure runtime-owned streaming guardrail pipelines and cross-pod session rehydration are PII-ready on first use.

**Tasks**:

1. Add failing regressions proving `initializeSession()` and `executeMessage()` streaming output guardrails create pipelines without the session recognizer registry.
2. Thread `session.piiRecognizerRegistry` into both runtime-created streaming guardrail pipelines.
3. Add a failing regression proving rehydrated sessions do not repair vault registry state until a later path refreshes it.
4. Refresh session PII context during `rehydrateSession()` so restored vaults, pattern configs, and recognizer registries are consistent before the session re-enters the runtime map.
5. Keep both changes backward compatible when no PII registry/config is available.

**Files Touched**:

- `apps/runtime/src/services/runtime-executor.ts`
- `apps/runtime/src/__tests__/agent-lifecycle.test.ts`
- `apps/runtime/src/__tests__/sessions/session-rehydration.test.ts`

**Exit Criteria**:

- [ ] `initializeSession()` streaming output guardrails pass `session.piiRecognizerRegistry` into `createGuardrailPipeline(...)`.
- [ ] `executeMessage()` streaming output guardrails pass `session.piiRecognizerRegistry` into `createGuardrailPipeline(...)`.
- [ ] Rehydrated sessions restore vault registry context before the session is stored back into the local runtime map.
- [ ] `pnpm build --filter=@agent-platform/runtime` succeeds.

**Test Strategy**:

- Unit: mocked runtime-executor streaming pipeline wiring regressions
- Unit: session rehydration regression covering immediate vault-registry repair

**Rollback**: Revert the runtime-executor wiring changes and remove the targeted regressions; behavior returns to the prior delayed/built-in-only paths.

### Phase 8: Scripted Output PII Parity

**Goal**: Make authored flow output honor the same masked-delivery/tokenized-history contract as reasoning mode.

**Tasks**:

1. Add failing regressions proving ON_START authored responses and canonical flow RESPOND output bypass project/session PII output protection.
2. Introduce a shared runtime helper that converts authored output into user-visible text plus history-safe text, including vault-aware tokenization and audit logging.
3. Refresh project/session PII context in scripted execution before authored output is rendered.
4. Thread the shared helper through ON_START and authored flow response/prompt emission paths so user delivery, pending response state, and conversation history stay aligned.
5. Keep the helper backward compatible when no project/session PII state is present.

**Files Touched**:

- `apps/runtime/src/services/execution/session-output-protection.ts`
- `apps/runtime/src/services/execution/__tests__/session-output-protection.test.ts`
- `apps/runtime/src/services/execution/flow-step-executor.ts`
- `apps/runtime/src/__tests__/execution/flow-authored-output-pii.test.ts`

**Exit Criteria**:

- [x] ON_START authored responses redact project/session PII before delivery and do not retain raw values in returned output.
- [x] Authored flow RESPOND/prompt history stores tokenized text when vault-backed output protection is active.
- [x] Scripted execution refreshes project/session PII context before authored output rendering.
- [x] `pnpm build --filter=@agent-platform/runtime` succeeds.

**Test Strategy**:

- Unit: session-output-protection helper regressions for masked delivery + tokenized history
- Integration: DSL-compiled `FlowStepExecutor` regressions covering ON_START and flow authored output with project-aware PII refresh

**Rollback**: Remove the shared scripted-output helper and revert authored flow output call sites to raw template rendering.

### Phase 9: Fresh-Session Init PII Hydration

**Goal**: Ensure fresh sessions hydrate project/session PII state before init-time guardrails and lifecycle execution.

**Tasks**:

1. Add a failing regression proving `initializeSession()` can build init-time streaming guardrail pipelines before `refreshSessionPIIContext()` hydrates the session.
2. Add a failing regression proving fresh-session initialization can skip PII refresh entirely when no streaming guardrails are present.
3. Refresh project/session PII context at the start of `initializeSession()` before any init-time guardrail setup, lifecycle hook execution, or first flow step execution.
4. Preserve fail-open behavior when project runtime config/pattern loading is unavailable.

**Files Touched**:

- `apps/runtime/src/services/runtime-executor.ts`
- `apps/runtime/src/__tests__/agent-lifecycle.test.ts`

**Exit Criteria**:

- [x] `initializeSession()` refreshes project/session PII context before init-time streaming output guardrails build their pipeline.
- [x] Fresh sessions without streaming guardrails still refresh project/session PII context before ON_START / first-step execution.
- [x] `pnpm build --filter=@agent-platform/runtime` succeeds.

**Test Strategy**:

- Unit: mocked runtime-executor init regressions covering hydration order and non-streaming init refresh

**Rollback**: Revert the early `initializeSession()` refresh and restore the prior delayed hydration behavior.

### Phase 10: Init-Time Centralized Trace Parity

**Goal**: Route init-only trace events through the same centralized scrub/store seam as normal execution without duplicate handler-side TraceStore writes.

**Tasks**:

1. Add a failing regression proving standalone `initializeSession()` trace events bypass centralized scrub/store behavior.
2. Add a failing regression proving init-time trace forwarding still depends on handler-local TraceStore writes for storage.
3. Introduce an idempotent centralized trace-wrapper seam that can be reused by both `executeMessage()` and `initializeSession()`.
4. Remove the remaining SDK init fallback TraceStore write now that init traces are centrally stored.
5. Keep callback forwarding behavior intact so channels still receive trace events and metrics.

**Files Touched**:

- `apps/runtime/src/services/runtime-executor.ts`
- `apps/runtime/src/websocket/sdk-handler.ts`
- `apps/runtime/src/__tests__/agent-lifecycle.test.ts`

**Exit Criteria**:

- [x] Standalone `initializeSession()` stores init-time traces through centralized trace storage and forwards only scrubbed payloads.
- [x] `initializeSession()` does not double-wrap an already centralized trace callback passed from `executeMessage()`.
- [x] SDK init trace forwarding no longer performs a fallback direct `TraceStore.addEvent(...)` write.
- [x] `pnpm build --filter=@agent-platform/runtime` succeeds.

**Test Strategy**:

- Unit: runtime-executor init trace centralization/scrubbing regression
- Unit: SDK init trace forwarding regression for no-direct-TraceStore fallback

**Rollback**: Revert the init-time centralized wrapper and restore prior handler-local trace storage behavior.

### Phase 11: Structured Authored Output Protection

**Goal**: Ensure authored flow-owned structured payloads (`richContent`, `voiceConfig`, action labels) honor the same project/session PII policy as authored text.

**Tasks**:

1. Add failing helper regressions for structured payload delivery/history behavior with custom project patterns.
2. Add failing flow regressions proving ON_START and normal RESPOND still return raw structured payloads and pending rich content.
3. Extend `session-output-protection.ts` with a field-aware structured transform that redacts user-visible strings while preserving narrow transport keys.
4. Finalize flow-owned structured payloads at shared return seams and protect `pendingRichContent` at write time.

**Files Touched**:

- `apps/runtime/src/services/execution/session-output-protection.ts`
- `apps/runtime/src/services/execution/__tests__/session-output-protection.test.ts`
- `apps/runtime/src/services/execution/flow-step-executor.ts`
- `apps/runtime/src/__tests__/execution/flow-authored-output-pii.test.ts`

**Exit Criteria**:

- [x] ON_START authored structured payloads redact custom project/session PII before delivery.
- [x] Flow RESPOND/gather prompt structured payloads and pending rich content redact custom project/session PII before delivery.
- [x] Action labels returned from authored flow execution no longer carry raw custom-pattern values.
- [x] `pnpm build --filter=@agent-platform/runtime` succeeds.

**Test Strategy**:

- Unit: structured-output helper regressions for delivery vs history behavior
- Integration: DSL-compiled `FlowStepExecutor` regressions for ON_START and authored RESPOND structured payloads

**Rollback**: Remove the structured transform and restore raw authored structured payload delivery.

### Phase 12: Durable Structured Envelope Persistence

**Goal**: Close the persistence gap where assistant `contentEnvelope` blobs can store raw PII that exists only inside structured payloads.

**Tasks**:

1. Add failing regressions proving structured-only PII does not set `hasPII` and still persists raw envelopes.
2. Detect PII independently across plain text and structured payload JSON.
3. Redact structured user-visible fields with the same field-aware transform policy used by live output delivery.
4. Drop the durable envelope when preserved transport fields still contain raw PII after structured redaction.

**Files Touched**:

- `apps/runtime/src/services/message-persistence-queue.ts`
- `apps/runtime/src/__tests__/reported-pii-masking-gaps.test.ts`

**Exit Criteria**:

- [x] Structured-only PII marks persisted assistant messages as `hasPII`.
- [x] Rich-content and voice-config assistant envelopes redact custom project/session PII before durable storage.
- [x] Envelopes are dropped instead of stored when preserved transport fields still contain raw PII after redaction.
- [x] `pnpm build --filter=@agent-platform/runtime` succeeds.

**Test Strategy**:

- Unit: message-persistence regressions covering structured redaction and fail-closed envelope dropping

**Rollback**: Revert to text-only PII detection and restore the previous envelope handling path.

### Phase 13: Action Handler Output Parity

**Goal**: Make `ACTION_HANDLER.respond` reuse the same authored output protection contract as other flow-authored response paths.

**Tasks**:

1. Add a failing regression proving action-handler authored text, streamed chunks, and structured payloads still leak raw custom-pattern values.
2. Route action-handler text emission through the shared protected text/history helper.
3. Rely on the shared structured return finalization seam so action-handler rich content and voice payloads stay aligned with other authored outputs.

**Files Touched**:

- `apps/runtime/src/services/execution/flow-step-executor.ts`
- `apps/runtime/src/__tests__/execution/flow-authored-output-pii.test.ts`

**Exit Criteria**:

- [x] `ACTION_HANDLER.respond` streams redacted text instead of raw custom-pattern values.
- [x] Action-handler assistant history stores tokenized text when vault-backed output protection is active.
- [x] Action-handler structured payloads use the same protected authored-output seam as other flow paths.
- [x] `pnpm build --filter=@agent-platform/runtime` succeeds.

**Test Strategy**:

- Integration: DSL-compiled `FlowStepExecutor` action-handler regression

**Rollback**: Restore the previous raw action-handler respond path.

### Phase 14: Helper Output Protection Parity

**Goal**: Close the remaining helper-owned runtime output seams so redacted delivery plus tokenized history apply even outside `FlowStepExecutor`.

**Tasks**:

1. Add failing regressions for `executeComplete(...)`, `executeAwaitAttachment(...)`, constraint response side effects, and KB `DIRECT` fast-path short-circuit replies.
2. Add a shared execution-result protection helper that protects delivery text, structured payloads, and mirrored `action.message` fields while preserving tokenized history text.
3. Route `executeComplete(...)`, `executeAwaitAttachment(...)`, and constraint side effects through that shared helper.
4. Route KB `DIRECT` short-circuit responses through the same helper before early return.

**Files Touched**:

- `apps/runtime/src/services/execution/session-output-protection.ts`
- `apps/runtime/src/services/execution/routing-executor.ts`
- `apps/runtime/src/services/execution/await-attachment-executor.ts`
- `apps/runtime/src/services/execution/constraint-checker.ts`
- `apps/runtime/src/services/execution/reasoning-executor.ts`
- `apps/runtime/src/services/execution/__tests__/session-output-protection.test.ts`
- `apps/runtime/src/__tests__/routing/routing-executor-unit.test.ts`
- `apps/runtime/src/__tests__/execution/flow-step-await-attachment.test.ts`
- `apps/runtime/src/__tests__/execution/pre-refactor/constraint-actions-extended.test.ts`
- `apps/runtime/src/__tests__/reported-pii-masking-gaps.test.ts`

**Exit Criteria**:

- [x] `executeComplete(...)` redacts custom-pattern delivery, tokenizes assistant history, and protects returned `richContent` / `voiceConfig`.
- [x] `AWAIT_ATTACHMENT` first prompts and re-prompts redact custom-pattern delivery while storing tokenized assistant history.
- [x] Constraint response side effects redact delivery output and tokenize history before returning to flow/reasoning callers.
- [x] KB `DIRECT` fast-path short-circuit replies no longer bypass project/session output protection.
- [x] Focused runtime regression pack passes.

**Test Strategy**:

- Unit: shared execution-result helper regression
- Unit: routing helper, await-attachment helper, and constraint side-effect regressions
- Integration: reasoning KB fast-path regression for `DIRECT` short-circuit custom-pattern protection

**Rollback**: Revert the helper seams to their prior raw delivery/history writes and remove the shared execution-result wrapper.

### Phase 15: Cross-Thread Return And Error-Responder Parity

**Goal**: Close the remaining runtime helper seams where assistant-visible output re-enters the session outside normal authored-flow delivery paths.

**Tasks**:

1. Add failing regressions for remote handoff return/resume delivery, hook `RESPOND`, delegate/handoff failure `respond` fallbacks, and runtime `onError` structured payload preservation.
2. Extend the shared output-protection helper with a reusable assistant-message emission seam for custom history targets.
3. Route remote handoff sync/streaming returns, async resume/fire-and-forget return paths, and delegate/handoff failure `respond` handlers through the shared protected delivery/history contract.
4. Route hook `RESPOND` side effects through the same helper and preserve compiled `onError` `richContent` / `voiceConfig` / `actions` through runtime error resolution plus pending delivery state.

**Files Touched**:

- `apps/runtime/src/services/execution/session-output-protection.ts`
- `apps/runtime/src/services/execution/types.ts`
- `apps/runtime/src/services/execution/hook-executor.ts`
- `apps/runtime/src/services/execution/routing-executor.ts`
- `apps/runtime/src/services/execution/reasoning-executor.ts`
- `apps/runtime/src/services/execution/flow-step-executor.ts`
- `apps/runtime/src/services/execution/error-handler-router.ts`
- `apps/runtime/src/services/runtime-executor.ts`
- `apps/runtime/src/services/execution/__tests__/session-output-protection.test.ts`
- `apps/runtime/src/__tests__/hooks-integration.test.ts`
- `apps/runtime/src/__tests__/routing/routing-executor-unit.test.ts`
- `apps/runtime/src/__tests__/routing/routing-remote-handoff.test.ts`
- `apps/runtime/src/__tests__/execution/async-handoff-resume.test.ts`
- `apps/runtime/src/__tests__/error-handler-integration.test.ts`
- `apps/runtime/src/__tests__/on-error-respond-streaming.test.ts`
- `apps/runtime/src/__tests__/reported-pii-masking-gaps.test.ts`

**Exit Criteria**:

- [x] Remote handoff sync/streaming return delivery redacts custom-pattern output while thread history stores tokenized values.
- [x] Async remote resume and fire-and-forget resume completion return protected delivery text instead of raw remote output.
- [x] Delegate/handoff failure `respond` paths and hook `RESPOND` side effects reuse the shared protected assistant-message helper.
- [x] Runtime `onError` resolution preserves compiled structured payloads (`richContent`, `voiceConfig`, `actions`) through delivery/pending-state seams.
- [x] Focused runtime regression pack passes; the wider async-resume suite remains tracked separately if unrelated worker instability persists.

**Test Strategy**:

- Unit: shared protected assistant-message helper regression
- Integration: hook, routing remote handoff, and error-handler structured payload regressions
- Targeted runtime resume regression for protected remote callback delivery

**Rollback**: Revert remote return/fallback/helper paths to their previous raw message writes and remove the structured payload propagation fields from runtime error resolution.

### Phase 16: Hook Envelope And Structured Error-Response Parity

**Goal**: Close the remaining parser/compiler/runtime seams where structured hook payloads or structured reasoning error responses still dropped before canonical runtime delivery.

**Tasks**:

1. Add failing parser/compiler regressions proving hook structured RESPOND payloads still lose `ACTIONS` or typed structured fields before IR.
2. Add failing runtime regressions for async remote sync-fallback redaction, escalated-session fallback redaction, hook structured history envelopes, and reasoning structured `on_error` delivery.
3. Patch the canonical and YAML hook parsers plus compiler hook compilation so `actions`, `voiceConfig`, and `richContent` survive DSL -> IR.
4. Patch hook execution to attach structured history envelopes, protect async remote sync-fallback and escalated-session replies, and return structured reasoning `on_error` payloads through a typed break-loop result.

**Files Touched**:

- `packages/core/src/parser/agent-based-parser.ts`
- `packages/core/src/parser/yaml-parser.ts`
- `packages/core/src/__tests__/dsl-extensions-parser.test.ts`
- `packages/compiler/src/platform/ir/compiler.ts`
- `packages/compiler/src/__tests__/ir/abl-spec-parity-compilation.test.ts`
- `apps/runtime/src/services/execution/hook-executor.ts`
- `apps/runtime/src/services/execution/reasoning-executor.ts`
- `apps/runtime/src/services/execution/routing-executor.ts`
- `apps/runtime/src/services/runtime-executor.ts`
- `apps/runtime/src/__tests__/hooks-integration.test.ts`
- `apps/runtime/src/__tests__/hooks-lifecycle.e2e.test.ts`
- `apps/runtime/src/__tests__/routing/routing-remote-handoff.test.ts`
- `apps/runtime/src/__tests__/reported-pii-masking-gaps.test.ts`

**Exit Criteria**:

- [x] Hook structured RESPOND payloads preserve `actions`, `rich_content`, and `voice_config` from parser -> compiler IR.
- [x] Hook structured RESPOND side effects persist a canonical protected `contentEnvelope` on the emitted assistant history message.
- [x] Async remote sync-fallback and escalated-session fallback replies redact custom-pattern delivery while assistant history remains tokenized.
- [x] Structured reasoning `on_error` responses preserve delivery payloads while the final assistant history text remains tokenized.
- [x] Focused core/compiler/runtime regression packs pass.

**Test Strategy**:

- Unit: parser/compiler hook structured payload regressions
- Integration: hook runtime envelope wiring plus remote handoff fallback regressions
- Unit: reported PII regression for structured reasoning `on_error` delivery

**Rollback**: Revert the hook parser/compiler/runtime envelope wiring and restore the prior raw/metadata-only helper paths.

### Phase 17: Studio Lifecycle Fidelity And Flow Error-Response Parity

**Goal**: Preserve the remaining lifecycle metadata that Studio actually rewrites today, future-proof canonical `HOOKS` serialization, and surface terminal flow `ON_ERROR respond` structured payloads through the runtime result contract.

**Tasks**:

1. Revalidate the prior audit list against the real Studio save paths and runtime return seams, and narrow the slice to confirmed gaps only.
2. Add failing Studio regressions for `ON_ERROR`, `COMPLETE`, and canonical `HOOKS` serializer fidelity plus editor-store lifecycle parsing.
3. Add a failing runtime regression for terminal flow `ON_ERROR respond` structured payload delivery.
4. Patch the Studio lifecycle section model/serializers and the flow executor fallback bridge, then re-run scoped builds and focused regressions.

**Files Touched**:

- `apps/studio/src/store/agent-detail-store.ts`
- `apps/studio/src/lib/abl-serializers.ts`
- `apps/studio/src/lib/abl/lifecycle-visual-editor-compat.ts`
- `apps/studio/src/__tests__/abl-serializers.test.ts`
- `apps/studio/src/__tests__/lifecycle-visual-editor-compat.test.ts`
- `apps/studio/src/__tests__/stores/agent-editor-store.test.ts`
- `apps/runtime/src/services/execution/flow-step-executor.ts`
- `apps/runtime/src/__tests__/on-error-respond-streaming.test.ts`

**Exit Criteria**:

- [x] Studio `ON_ERROR` saves preserve supported structured fields (`voice_config`, `rich_content`, retry settings, handoff target) instead of collapsing to `respond` + `then`.
- [x] Studio `COMPLETE` saves preserve supported structured fields (`voice_config`, `rich_content`, `store`) instead of collapsing to `when` + `respond`.
- [x] Canonical lifecycle serialization can emit full `HOOKS` bodies when hook configs are present, avoiding future boolean-only rewrites.
- [x] Visual-editor compatibility checks stop blocking the newly preserved `ON_ERROR` / `COMPLETE` fields while still flagging truly unsupported lifecycle metadata.
- [x] Terminal flow `ON_ERROR respond` structured payloads now surface through the returned `ExecutionResult`.
- [x] Scoped Studio/runtime builds and focused regression packs pass.

**Test Strategy**:

- Studio unit: serializer round-trip + compatibility guard + editor-store parse fidelity
- Runtime integration: terminal flow `ON_ERROR respond` structured outcome regression

**Rollback**: Revert the lifecycle model/serializer extensions and the handled-error fallback bridge in `flow-step-executor.ts`, restoring the prior lossy Studio/runtime behavior.

## 4. Wiring Checklist

- [x] Studio serializer output still feeds existing DSL save routes with no new API fields
- [x] Compiler exports remain backward compatible for existing callers/tests
- [x] Guardrail pipeline passes request-scoped PII context from runtime-created pipelines
- [x] Runtime snapshot loader is used by both session hydration and non-session boundaries
- [x] WebSocket trace emitter receives session recognizer registry when a runtime session is available
- [x] Omnichannel read surfaces route through the same runtime read-boundary renderer used by session history APIs
- [x] Analytics custom-dimension writes route through one shared session-aware validation helper
- [x] Stored-session read-surface fallback routes through a shared helper in `session-pii-context.ts`
- [x] Centralized runtime trace storage reads PII scrubbing context from the live session reference
- [x] Tracer write-pipeline resolves a live PII recognizer registry instead of capturing a stale snapshot
- [x] Runtime-created streaming output guardrail pipelines receive the live session recognizer registry
- [x] Cross-pod session rehydration refreshes PII context before restored sessions re-enter the local runtime map
- [x] Authored scripted outputs route through one shared user/history PII protection helper
- [x] Flow-owned structured payloads finalize through the shared authored-output protection seam before delivery
- [x] Durable structured assistant envelopes redact user-visible fields and fail closed when preserved transport fields still contain PII
- [x] Fresh-session initialization refreshes PII context before init-time guardrails and lifecycle execution
- [x] Init-only trace events use the same centralized scrub/store seam as normal execution without handler-side duplicate TraceStore writes
- [x] Helper-owned runtime output paths now reuse one shared execution-result protection seam instead of open-coding raw chunk/history writes
- [x] Cross-thread remote return/resume paths and helper fallback `respond` branches now reuse the shared protected assistant-message seam
- [x] Compiled `onError` structured payload fields survive runtime error resolution and pending-delivery wiring
- [x] Hook structured RESPOND payloads survive parser -> compiler -> runtime history/content-envelope wiring
- [x] Structured reasoning `on_error` responses exit through a typed break-loop result so delivery payloads are preserved without sacrificing tokenized assistant history
- [x] Studio lifecycle section models/serializers preserve supported structured `ON_ERROR` and `COMPLETE` metadata end to end
- [x] Flow execution promotes terminal handled-error structured payloads into the returned `ExecutionResult`
- [x] Structured flow branch payloads (`ON_INPUT`, `ON_RESULT`, `ON_SUCCESS`, `ON_FAILURE`) survive parser -> compiler -> runtime delivery without dropping `actions`, `voice_config`, or `rich_content`
- [x] Prompt-less `ON_INPUT` steps evaluate the first live user turn without requiring an intermediate waiting-state shim

## 5. Cross-Phase Concerns

### Caching

- Project PII snapshot cache must be bounded and TTL-based.
- Cache entries must not retain mutable session token vault state; only config/registry snapshots are reusable.

### Compatibility

- New compiler/runtime parameters must remain optional so existing tests and callers keep working.
- No Studio or DB schema changes are required for these slices.

### Metadata Safety

- `platform_events.custom_dimensions` must never rely on a stale hand-maintained regex subset when project-aware PII policy is available.
- Session-aware metadata validation should remain opt-in via existing PII policy enablement rather than silently introducing a new policy toggle.

### Observability

- Logs should mention snapshot load failures with tenant/project context but must not log raw PII.
- Trace/EventStore behavior should keep existing secret scrubbing intact while improving custom-pattern coverage.
- Long-lived trace writers should resolve PII registries lazily so runtime cache invalidation does not leave stale custom-pattern coverage behind.

## 6. Acceptance Criteria

- [x] Studio-authored transient-only gather fields survive save/round-trip
- [x] Project-scoped custom patterns and builtin disables affect DSL/CEL guardrail evaluation
- [x] Runtime persistence, traces, and omnichannel history surfaces honor the same project-scoped PII policy
- [x] Analytics custom dimensions honor project custom patterns and builtin overrides through the shared metadata validation seam
- [x] Stored-session read surfaces use one shared helper for project PII context construction
- [x] Centralized trace storage and tracer-originated events honor live project/session PII registries
- [x] Runtime streaming output guardrails and rehydrated sessions honor live project/session PII registries on first use
- [x] Authored scripted outputs honor masked-delivery/tokenized-history PII rendering on first use
- [x] Fresh-session initialization and init-only trace paths are PII-ready before any ON_START/first-step execution happens
- [x] Helper-owned runtime output paths (`COMPLETE`, `AWAIT_ATTACHMENT`, constraint responses, KB `DIRECT`) honor the same delivery/history protection contract as authored flow output
- [x] Cross-thread remote returns/resume callbacks, hook `RESPOND`, and helper fallback `respond` paths honor the shared delivery/history protection contract
- [x] Runtime `onError` handlers preserve compiled structured payloads through delivery/pending state without dropping them at the runtime boundary
- [x] Studio lifecycle visual-editor saves preserve currently supported structured lifecycle metadata without silently dropping it
- [x] Terminal flow handled-error responses can carry structured payloads through the canonical runtime outcome
- [x] Structured flow branch payloads authored in DSL/YAML survive parser/compiler lowering and runtime auto-advance delivery
- [x] Scoped builds and targeted tests for Studio, compiler, and runtime pass
- [x] No new singleton or tenant-global mutation is introduced for project-scoped PII state

## 7. Open Questions

1. Compiler NLU tenant-manager still builds hooks from shared tenant config only. If runtime starts depending on that path for per-session execution, it should get the same project snapshot seam rather than a global registry mutation.
2. If future trace writers outside `RuntimeExecutor` need project-aware PII scrubbing, they should adopt the same getter-backed live-registry seam instead of capturing registry snapshots.
3. If analytics metadata ever needs a stricter policy than conversation/traces, add that as an explicit config contract instead of preserving hidden regex-only behavior.
4. If future callback/resumption/helper seams emit assistant-visible output outside `FlowStepExecutor`, they should adopt the shared protected assistant-message helper rather than open-coding delivery/history writes.
5. Revalidation found the previously suspected runtime hook-return seam was already covered by the current outcome wiring; future audits should keep verifying that with a concrete regression before widening scope.

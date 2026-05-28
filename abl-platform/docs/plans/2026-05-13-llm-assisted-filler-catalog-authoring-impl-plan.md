# LLM-Assisted Filler Catalog Authoring Implementation Plan

**Feature Spec**: `docs/features/filler-messages.md`
**HLD**: `docs/specs/filler-messages.hld.md`
**Test Spec**: `docs/testing/filler-messages.md`
**Related Guide**: `docs/guides/filler-messages-configuration-and-technical-guide.md`
**Status**: DRAFT
**Date**: 2026-05-13

---

## 1. Recommendation

Do **not** make automatic compile-time, post-compile, runtime, or first-interaction LLM generation the primary source of filler messages.

Instead, implement **LLM-assisted filler catalog authoring**:

```text
Studio UI
  -> agent developer clicks "Generate filler suggestions"
  -> backend builds sanitized AgentIR/tool/constraint summary
  -> LLM drafts a candidate filler catalog
  -> deterministic validator rejects risky phrases
  -> developer reviews, edits, and approves
  -> approved catalog is stored as project/agent config
  -> publish snapshots catalog version/hash
  -> runtime selects deterministically from approved catalog
```

Runtime should not improvise user-visible filler text as the default path. Runtime should choose from an approved, bounded catalog using verified turn context, then apply a final fail-closed validator before emitting `status_update`.

## 2. Why This Design

### 2.1 Why Not Automatic Compile-Time Generation

Automatic generation during every compile is not the right default because:

- compiles become slower and network-dependent;
- generated text is nondeterministic;
- LLM/model failures can break authoring or publish flows;
- developers cannot review subtle capability or tone mistakes;
- regenerated phrases churn IR/session hashes even when agent behavior did not materially change.

The compile/publish path should validate and snapshot approved catalogs. It should not silently invent user-visible filler text.

### 2.2 Why Not Runtime Or First-Interaction Generation

Runtime generation has the same core failure mode this work is trying to prevent: unreviewed text appears while the user is waiting.

Runtime generation can remain useful for:

- shadow-mode comparison;
- internal evaluation;
- optional fallback for agents without approved catalogs;
- background suggestions for later developer review.

It should not be the primary production path.

### 2.3 Why Human-Reviewed LLM Authoring

Human-reviewed authoring gives the best tradeoff:

- LLM helps create varied, contextual language.
- Deterministic validation removes obvious unsafe/unsupported phrases.
- Developer review catches domain nuance and brand voice.
- Publish freezes a stable catalog.
- Runtime stays fast, deterministic, and fail-closed.

## 3. Core Design

```text
Authoring time:
  AgentIR + tools + flows + constraints + guardrails + persona
    -> sanitized generation input
    -> LLM candidate catalog
    -> deterministic validator
    -> Studio review/edit/approve UI
    -> persisted approved catalog

Publish time:
  approved catalog
    -> validate again
    -> snapshot catalog id/version/hash with release artifact

Runtime:
  session AgentIR + approved catalog + guardrail state + active tool + execution state + recent fillers
    -> deterministic selector
    -> final validator
    -> status_update or suppress
```

The runtime invariant remains:

```text
Open early. Select late. Validate always. Clear on real output. Suppress when uncertain.
```

### 3.1 Compatibility With Current Runtime Sources

This design is an incremental layer over the current runtime filler architecture, not a replacement of the whole path.

Current runtime code has three user-visible filler sources:

| Current Source                 | Current Code Path                                                                                                    | Current Behavior                                                                                                    | Target Behavior With Catalog Layer                                                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Static fallback pools          | `apps/runtime/src/services/filler/message-pools.ts` via operation traces in `RuntimeExecutor`                        | Operation traces choose generic fallback text and call `FillerMessageService.queueFiller(..., source='static')`.    | Keep as `catalogMode: off` behavior. In `shadow`, emit as today and compare against catalog decision. In `enforce`, use only as final legacy fallback if configured.  |
| Parallel pipeline filler       | `apps/runtime/src/services/filler/pipeline-filler.ts` called from `RuntimeExecutor` when `pipelineGenerationEnabled` | A short parallel LLM call generates contextual text and updates the pending turn filler with `source='pipeline'`.   | Keep as `off` behavior. In `shadow`, generate and validate for comparison only. In `enforce`, treat as an untrusted candidate/context signal, not direct text.        |
| Response-model `<status>` tags | `apps/runtime/src/services/filler/status-tag-parser.ts` wraps streamed chunks in `RuntimeExecutor`                   | `<status>...</status>` is stripped from visible output and updates pending filler text with `source='piggybacked'`. | Keep parsing and stripping in all modes. In `shadow`, validate and compare. In `enforce`, never emit raw tag text directly; use it only as context or fallback input. |

Mode semantics:

| Mode      | User-Visible Text Source                                                                  | Pipeline Filler Role                                                                    | `<status>` Tag Role                                               | Static Pool Role                                           |
| --------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| `off`     | Existing behavior exactly: whichever current source updates `FillerMessageService` first. | Direct pending-text update as today.                                                    | Direct pending-text update as today after stripping from output.  | Direct fallback as today.                                  |
| `shadow`  | Existing behavior remains user-visible.                                                   | Still direct as today; additionally validated/scored in shadow.                         | Still direct as today; additionally validated/scored in shadow.   | Still direct as today; additionally compared to catalog.   |
| `enforce` | Approved catalog selector, then final validator, then `status_update` or suppression.     | Candidate/context signal only unless explicit fallback is enabled and validator passes. | Context signal only; raw tag text is never directly user-visible. | Last-resort legacy fallback only if explicitly configured. |

The important runtime shape is:

```text
user-message boundary
  -> open filler turn and start delay timer
  -> current sources may arrive in parallel:
       static operation trace
       pipeline generated text
       response-model <status> tag
  -> source events update FillerContextEnvelope and candidate buffer
  -> timer fires
  -> mode decides whether current pending text or approved catalog selector owns visible text
  -> final validator approves/fallbacks/suppresses
  -> status_update / status_clear contract remains unchanged
```

This preserves current chat and voice behavior while allowing the approved catalog path to be introduced safely. No client or channel adapter should need a new event type.

## 4. Storage And IR Weight

A bounded filler catalog is small, but it should still be treated as a versioned artifact rather than uncontrolled IR bulk.

Recommended storage:

1. Store the editable approved catalog in a project/agent-scoped DB model.
2. Store catalog version/hash with release artifacts.
3. Put a compact reference in IR by default:

```ts
interface FillerCatalogRefIR {
  catalogId: string;
  version: number;
  hash: string;
  status: 'approved';
}
```

4. Optionally embed the frozen compact catalog in production IR only if runtime lookup would add operational risk.

Avoid unlimited generated text in core `AgentIR`. `SessionService.computeIRHash()` hashes the full IR JSON; phrase churn would cause unnecessary IR cache churn if every generation mutates IR directly.

## 5. Design Decisions

| #   | Decision                                                                    | Rationale                                                                         | Alternatives Rejected                                                           |
| --- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| D-1 | Make LLM generation an explicit Studio authoring action.                    | Keeps developer in control of tone, capability claims, and domain nuance.         | Automatic compile-time generation, which is nondeterministic and review-free.   |
| D-2 | Persist approved catalogs as versioned project/agent artifacts.             | Catalogs need lifecycle, auditability, and stable publish references.             | Store only inside AgentIR, which creates unnecessary hash churn.                |
| D-3 | Publish validates and snapshots the approved catalog.                       | Production runtime should use a frozen artifact, not draft phrases.               | Runtime loading mutable draft catalog.                                          |
| D-4 | Runtime selects deterministically from approved catalog.                    | Prevents user-visible hallucinated filler text.                                   | Runtime LLM generation as default.                                              |
| D-5 | Keep existing `status_update` / `status_clear` client contract.             | Chat, Studio, and voice paths already consume it.                                 | New client-visible filler protocol.                                             |
| D-6 | Add `filler.catalogMode` with `off`, `shadow`, and `enforce` modes.         | Allows safe rollout and side-by-side comparison with legacy behavior.             | Big-bang replacement.                                                           |
| D-7 | Track recent filler history per session.                                    | Solves repetition without persisting fillers as assistant messages.               | Persist filler text in conversation history.                                    |
| D-8 | Add `filler_decision` traces that exclude raw unsafe user text.             | Debuggability without leaking sensitive/abusive content.                          | Only emitting `status_update`, which hides rejected/suppressed decisions.       |
| D-9 | Runtime-generated filler remains optional and must pass the same validator. | Preserves flexibility for experiments while keeping the production contract safe. | Removing runtime generation immediately or allowing it to bypass safety checks. |

## 6. Key Interfaces

### 6.1 Stored Catalog Model

```ts
export interface FillerCatalogDocument {
  _id: string;
  tenantId: string;
  projectId: string;
  agentId?: string;
  agentName?: string;
  version: number;
  status: 'draft' | 'approved' | 'archived';
  source: 'manual' | 'llm_assisted' | 'imported';
  sourceHash: string;
  catalog: ApprovedFillerCatalog;
  validation: FillerCatalogValidationSummary;
  generatedBy?: string;
  approvedBy?: string;
  approvedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}
```

### 6.2 Approved Catalog

```ts
export interface ApprovedFillerCatalog {
  version: 1;
  neutral: FillerPhrase[];
  byOperation: Partial<Record<StatusOperation, FillerPhrase[]>>;
  byTool: Record<string, ToolFillerBucket>;
  guardrailFallbacks: {
    unknown: FillerPhrase[];
    outOfScope: FillerPhrase[];
    unsafe: FillerPhrase[];
    abusive: FillerPhrase[];
  };
  forbiddenGlobalClaims: string[];
}

export interface FillerPhrase {
  id: string;
  text: string;
  maxChannel: 'chat' | 'voice' | 'both';
  tone: 'neutral' | 'calm' | 'minimal' | 'apologetic';
  allowedStates: FillerExecutionState[];
}

export interface ToolFillerBucket {
  toolName: string;
  safeCapabilitySummary: string;
  actionType: 'read' | 'search' | 'schedule' | 'update' | 'cancel' | 'handoff' | 'unknown';
  sideEffectLevel: 'none' | 'read' | 'write' | 'external';
  allowedClaims: string[];
  forbiddenClaims: string[];
  fillers: FillerPhrase[];
}
```

### 6.3 Runtime Context Envelope

```ts
export type FillerGuardrailState = 'unknown' | 'in_scope' | 'out_of_scope' | 'unsafe' | 'abusive';

export type FillerCapabilityState = 'unknown' | 'supported' | 'unsupported' | 'needs_clarification';

export type FillerExecutionState =
  | 'reasoning'
  | 'guardrail_check'
  | 'tool_pending'
  | 'tool_running'
  | 'handoff'
  | 'delegation'
  | 'extraction'
  | 'constraint_check';

export interface FillerContextEnvelope {
  sessionId: string;
  channelType?: string;
  guardrailState: FillerGuardrailState;
  capabilityState: FillerCapabilityState;
  executionState: FillerExecutionState;
  activeTool?: {
    name: string;
    actionType: ToolFillerBucket['actionType'];
    sideEffectLevel: ToolFillerBucket['sideEffectLevel'];
    safeCapabilitySummary: string;
  };
  recentFillers: string[];
  tone: 'neutral' | 'calm' | 'minimal' | 'apologetic';
}
```

### 6.4 Selection Result

```ts
export interface FillerSelectionResult {
  decision: 'emit' | 'suppress' | 'fallback';
  source:
    | 'approved_tool'
    | 'approved_operation'
    | 'approved_guardrail'
    | 'approved_neutral'
    | 'static_legacy'
    | 'pipeline_generated'
    | 'llm_status_tag';
  text?: string;
  reason?: string;
  rejectedCandidateIds?: string[];
}
```

### 6.5 Runtime Source Candidate Buffer

```ts
export interface RuntimeFillerCandidate {
  source: 'static_legacy' | 'pipeline_generated' | 'llm_status_tag';
  operation: StatusOperation;
  text: string;
  receivedAt: number;
  validation?: FillerCandidateValidation;
}
```

`RuntimeExecutor` should populate this buffer from the existing `queueFiller` inputs before the timer fires. In `off` mode, the buffer is only a compatibility detail and current pending-text behavior remains unchanged. In `shadow` and `enforce`, the selector can use the buffer for trace comparison, context, or explicitly configured fallback.

## 7. Module Boundaries

| Module              | Responsibility                                                                 | Depends On                              |
| ------------------- | ------------------------------------------------------------------------------ | --------------------------------------- |
| Studio authoring UI | Generate, review, edit, approve, archive catalogs.                             | Runtime API proxy, project context      |
| Catalog API         | CRUD, generation, validation, approval, version listing.                       | Auth, project RBAC, DB model, LLM       |
| Catalog generator   | Builds sanitized input and calls LLM for candidate phrases.                    | LLM client/model resolution             |
| Catalog validator   | Deterministically rejects unsafe, unsupported, overlong, duplicate phrases.    | Catalog types, capability summaries     |
| Catalog storage     | Stores draft/approved/versioned catalogs scoped by tenant/project/agent.       | MongoDB, tenant isolation               |
| Publish integration | Validates approved catalog and snapshots ref/hash into release artifact or IR. | Release/module build path               |
| Runtime resolver    | Resolves approved catalog by release snapshot/ref.                             | Session AgentIR, cache, DB fallback     |
| Runtime selector    | Selects safest phrase from approved catalog using verified execution context.  | Filler context, catalog, recent history |
| Observability       | Emits `filler_decision` traces.                                                | Existing trace pipeline                 |

## 8. File-Level Change Map

### New Files

| File                                                                           | Purpose                                                                     | Risk |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ---- |
| `packages/database/src/models/filler-catalog.model.ts`                         | Tenant/project/agent-scoped catalog model.                                  | Med  |
| `apps/runtime/src/routes/filler-catalogs.ts`                                   | Runtime API for list/get/create/update/generate/validate/approve/archive.   | High |
| `apps/runtime/src/services/filler/catalog/types.ts`                            | Shared runtime catalog, context, selection, and validation types.           | Low  |
| `apps/runtime/src/services/filler/catalog/catalog-generator.ts`                | LLM-assisted suggestion generator.                                          | Med  |
| `apps/runtime/src/services/filler/catalog/catalog-prompt.ts`                   | Sanitized prompt and JSON contract.                                         | Med  |
| `apps/runtime/src/services/filler/catalog/catalog-validator.ts`                | Deterministic validation for suggestions and approved catalogs.             | High |
| `apps/runtime/src/services/filler/catalog/catalog-selector.ts`                 | Runtime deterministic selection from approved catalog.                      | High |
| `apps/runtime/src/services/filler/catalog/filler-context.ts`                   | Runtime context builder/updater from trace/guardrail/tool state.            | High |
| `apps/runtime/src/services/filler/catalog/recent-filler-history.ts`            | Bounded per-session recent filler tracking.                                 | Low  |
| `apps/studio/src/app/api/projects/[id]/filler-catalogs/route.ts`               | Studio proxy route for catalog list/create/generate.                        | Med  |
| `apps/studio/src/app/api/projects/[id]/filler-catalogs/[catalogId]/route.ts`   | Studio proxy route for update/approve/archive.                              | Med  |
| `apps/studio/src/components/settings/FillerCatalogEditor.tsx`                  | Studio UI for generation, review, editing, approval.                        | High |
| `apps/runtime/src/services/filler/catalog/__tests__/catalog-validator.test.ts` | Unit validation coverage.                                                   | Low  |
| `apps/runtime/src/services/filler/catalog/__tests__/catalog-selector.test.ts`  | Runtime selection coverage.                                                 | Low  |
| `apps/runtime/src/services/filler/catalog/__tests__/catalog-generator.test.ts` | Mocked LLM suggestion tests.                                                | Med  |
| `apps/runtime/src/__tests__/routes/filler-catalogs.test.ts`                    | API auth/isolation/validation tests.                                        | High |
| `apps/runtime/src/__tests__/thoughts-status-approved-filler-ws.e2e.test.ts`    | Public WebSocket regression for approved catalog selection and suppression. | High |

### Modified Files

| File                                                               | Change Description                                                                                      | Risk |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ---- |
| `packages/database/src/models/index.ts`                            | Export `FillerCatalog`.                                                                                 | Low  |
| `packages/shared/src/validation/project-runtime-config.ts`         | Add `filler.catalogMode` and optional catalog binding/ref fields if stored in runtime config.           | Med  |
| `packages/database/src/models/project-runtime-config.model.ts`     | Persist catalog mode/ref if project-level config owns selection.                                        | Med  |
| `apps/runtime/src/routes/project-runtime-config.ts`                | Read/write catalog mode/ref.                                                                            | Med  |
| `apps/runtime/src/server.ts` or route registration file            | Mount `filler-catalogs` route.                                                                          | Med  |
| `packages/compiler/src/platform/ir/schema.ts`                      | Add compact `filler_catalog_ref?` if publish snapshots ref in AgentIR.                                  | Med  |
| `apps/studio/src/app/api/projects/[id]/module/releases/route.ts`   | Validate approved catalog and snapshot catalog ref/hash during release build.                           | High |
| `apps/runtime/src/channels/session-resolver.ts`                    | Resolve approved catalog for working-copy/channel sessions.                                             | High |
| `apps/runtime/src/services/runtime-executor.ts`                    | Use context envelope, selector, final validator, history, `filler_decision` traces.                     | High |
| `apps/runtime/src/services/filler/filler-service.ts`               | Support delayed selection at timer fire time.                                                           | High |
| `apps/runtime/src/services/filler/message-pools.ts`                | Keep as legacy fallback and fallback catalog seed.                                                      | Low  |
| `apps/runtime/src/services/filler/pipeline-filler.ts`              | Keep current generation path in `off`; feed candidate buffer in `shadow`/`enforce`.                     | Med  |
| `apps/runtime/src/services/filler/status-tag-parser.ts`            | Keep stripping tags; feed parsed tag text into candidate buffer instead of direct emit in enforce mode. | Med  |
| `apps/runtime/src/services/filler/index.ts`                        | Export catalog utilities.                                                                               | Low  |
| `apps/studio/src/components/settings/RuntimeConfigTab.tsx`         | Add entry point to catalog editor and optionally catalog mode controls.                                 | Med  |
| `docs/guides/filler-messages-configuration-and-technical-guide.md` | Update recommended design and runtime order.                                                            | Low  |
| `docs/features/filler-messages.md`                                 | Update scope/status for approved catalog layer.                                                         | Low  |
| `docs/specs/filler-messages.hld.md`                                | Add architecture subsection for LLM-assisted authoring.                                                 | Low  |
| `docs/testing/filler-messages.md`                                  | Add coverage rows and E2E scenarios.                                                                    | Low  |

## 9. Implementation Phases

Each phase should be independently buildable and keep existing filler behavior available.

### Phase 1: Catalog Data Contract And Validator

**Goal**: Define the approved catalog shape and deterministic validator.

**Tasks**:

- **1.1** Add catalog interfaces in `apps/runtime/src/services/filler/catalog/types.ts`.
- **1.2** Add compact `filler_catalog_ref?` IR type only if release/runtime needs IR reference.
- **1.3** Implement `catalog-validator.ts` rules:
  - phrase max word count;
  - no questions;
  - no factual answers;
  - no unsupported action verbs;
  - no forbidden claims;
  - no off-topic validation language;
  - voice phrase length constraints;
  - duplicate and near-duplicate rejection.
- **1.4** Add validator tests for the demo problem cases:
  - unsupported cancellation claim;
  - out-of-scope validating phrase;
  - repeated phrase set;
  - tone-deaf phrase for abusive/frustrated context;
  - backend-state phrase with unknown tool state.

**Exit Criteria**:

- [ ] Validator rejects “canceling your appointment” when no cancel capability is allowed.
- [ ] Validator rejects “looking that up” in out-of-scope fallback buckets.
- [ ] Validator enforces voice phrase limits.
- [ ] Validator returns structured warnings and rejected candidate IDs.
- [ ] `pnpm --filter @agent-platform/runtime exec vitest apps/runtime/src/services/filler/catalog/__tests__/catalog-validator.test.ts` passes.
- [ ] `pnpm --filter @agent-platform/runtime build` passes.

**Rollback**:

Remove new catalog files. Existing filler behavior is untouched.

---

### Phase 2: Catalog Persistence And APIs

**Goal**: Store draft/approved filler catalogs as tenant/project/agent-scoped artifacts.

**Tasks**:

- **2.1** Add `FillerCatalog` Mongoose model scoped by `tenantId`, `projectId`, and optional `agentId`.
- **2.2** Add indexes:
  - `{ tenantId, projectId, agentId, status, version }`;
  - unique approved active version constraint if needed.
- **2.3** Add runtime API routes:
  - `GET /api/projects/:projectId/filler-catalogs`;
  - `POST /api/projects/:projectId/filler-catalogs/generate`;
  - `POST /api/projects/:projectId/filler-catalogs/validate`;
  - `PUT /api/projects/:projectId/filler-catalogs/:catalogId`;
  - `POST /api/projects/:projectId/filler-catalogs/:catalogId/approve`;
  - `POST /api/projects/:projectId/filler-catalogs/:catalogId/archive`.
- **2.4** Enforce project RBAC with `requireProjectScope('projectId')`.
- **2.5** Ensure every query includes `tenantId` and `projectId`.
- **2.6** Reject unknown fields with strict schemas.

**Exit Criteria**:

- [ ] Catalog CRUD is project/tenant scoped.
- [ ] Cross-project and cross-tenant access returns non-leaky 404.
- [ ] Approval runs deterministic validation before changing status.
- [ ] Archived catalogs cannot be selected for publish/runtime.
- [ ] `apps/runtime/src/__tests__/routes/filler-catalogs.test.ts` passes.
- [ ] `pnpm --filter @agent-platform/runtime build` passes.

**Rollback**:

Leave model unused and do not mount routes, or remove route registration.

---

### Phase 3: LLM-Assisted Suggestion Generator

**Goal**: Generate candidate catalogs on demand from Studio without making compile/publish nondeterministic.

**Tasks**:

- **3.1** Implement sanitized generation input builder from:
  - `AgentIR.identity.goal`;
  - `AgentIR.identity.persona`;
  - `AgentIR.identity.limitations`;
  - `AgentIR.constraints`;
  - `AgentIR.tools` names/descriptions/schema summaries;
  - `AgentIR.flow` step summaries;
  - `AgentIR.coordination`;
  - current filler config.
- **3.2** Infer tool action metadata conservatively:
  - read/search/schedule/update/cancel/handoff/unknown;
  - side effect none/read/write/external;
  - unknown tools get neutral phrases only.
- **3.3** Implement JSON-only LLM prompt.
- **3.4** Call selected model with bounded timeout.
- **3.5** Validate generated JSON with schema and deterministic validator.
- **3.6** Return accepted phrases, rejected phrases, and warnings to Studio.
- **3.7** Never include tenant IDs, project IDs, credentials, auth profile values, or raw secrets in the LLM prompt.

**Exit Criteria**:

- [ ] Malformed JSON returns a safe error and no catalog is persisted.
- [ ] Unsafe generated phrases are rejected and surfaced as warnings.
- [ ] Generator can produce a draft catalog without approving it.
- [ ] Generator never stores raw LLM output without validation.
- [ ] `apps/runtime/src/services/filler/catalog/__tests__/catalog-generator.test.ts` passes.
- [ ] `pnpm --filter @agent-platform/runtime build` passes.

**Rollback**:

Disable the generate endpoint. Manual catalog authoring can still proceed once Phase 2 exists.

---

### Phase 4: Studio Review And Approval UI

**Goal**: Let agent developers generate, review, edit, validate, and approve filler catalogs.

**Tasks**:

- **4.1** Add Studio proxy routes for runtime catalog APIs.
- **4.2** Add `FillerCatalogEditor` under project runtime settings.
- **4.3** UI states:
  - no catalog;
  - generating;
  - draft with warnings;
  - validation failed;
  - approved;
  - archived.
- **4.4** Show buckets:
  - neutral;
  - guardrail fallbacks;
  - by operation;
  - by tool.
- **4.5** Allow edit/delete/add phrase.
- **4.6** Show rejected LLM suggestions separately with reasons.
- **4.7** Require validation pass before approval.
- **4.8** Save approved catalog with version/hash.

**Exit Criteria**:

- [ ] Developer can generate a draft from current agent/tool context.
- [ ] Developer can edit phrases before approval.
- [ ] Approval is blocked on validation errors.
- [ ] Approved catalog version/hash is visible.
- [ ] Studio route handlers explicitly scope to `tenantId` and project permission.
- [ ] `pnpm --filter @agent-platform/studio build` passes.

**Rollback**:

Hide the UI entry point. API/catalog data remains unused by runtime until later phases.

---

### Phase 5: Publish Snapshot And Runtime Resolution

**Goal**: Freeze approved catalog identity at publish/release time and make it available to runtime.

**Tasks**:

- **5.1** Add `filler.catalogMode: 'off' | 'shadow' | 'enforce'`.
- **5.2** Add catalog binding in project runtime config or release metadata:
  - approved `catalogId`;
  - `version`;
  - `hash`.
- **5.3** During release/module publish, validate the approved catalog again.
- **5.4** Snapshot compact `filler_catalog_ref` into release artifact or IR.
- **5.5** Runtime session resolver loads approved catalog by ref/hash.
- **5.6** Cache resolved catalog by `{ tenantId, projectId, catalogId, version, hash }`.
- **5.7** Working-copy/dev sessions may use latest approved catalog or explicit draft only in preview/debug mode.

**Exit Criteria**:

- [ ] Publish fails or warns clearly when configured catalog is missing/archived/invalid.
- [ ] Runtime session has access to approved catalog for production/deployed sessions.
- [ ] Draft catalogs are not used for production runtime.
- [ ] Catalog lookup is tenant/project scoped.
- [ ] IR hash churn is limited to catalog ref/hash changes, not incidental draft generation.
- [ ] `pnpm --filter @agent-platform/runtime build` and `pnpm --filter @agent-platform/studio build` pass.

**Rollback**:

Set `filler.catalogMode = 'off'` and stop resolving catalog refs.

---

### Phase 6: Runtime Selector And Delayed Selection

**Goal**: Use approved catalogs at runtime with verified execution context while preserving current static, pipeline, and `<status>` behavior behind mode controls.

**Tasks**:

- **6.1** Implement `FillerContextEnvelope` builder:
  - initial state is `guardrailState: unknown`, `capabilityState: unknown`, `executionState: reasoning`;
  - trace updates for tool call, handoff, delegation, extraction, constraint check;
  - active tool extraction from trace data;
  - tone hints from available safety/frustration signals.
- **6.2** Add a `RuntimeFillerCandidate` buffer in `RuntimeExecutor`:
  - static operation trace text enters as `source: 'static_legacy'`;
  - `generatePipelineFiller()` output enters as `source: 'pipeline_generated'`;
  - `StatusTagParser` output enters as `source: 'llm_status_tag'`;
  - candidates record source, operation, text, arrival time, validation state, and rejection reason;
  - candidates are not persisted to conversation history.
- **6.3** Implement mode-specific compatibility:
  - `catalogMode: off`: preserve current `FillerMessageService.queueFiller(operation, text, source)` behavior exactly;
  - `catalogMode: shadow`: preserve current emitted text, but run catalog selector and validator in parallel and emit `filler_decision` traces with `decision: 'shadow'`;
  - `catalogMode: enforce`: approved catalog selector owns user-visible text; pipeline and `<status>` text cannot directly emit unless explicit fallback is enabled and final validation passes.
- **6.4** Implement enforce-mode selection order:
  1. guardrail fallback when guardrail state is not `in_scope`;
  2. active verified tool bucket;
  3. operation bucket;
  4. neutral bucket;
  5. validated candidate buffer fallback, if enabled;
  6. legacy static fallback, if enabled;
  7. suppress.
- **6.5** Modify `FillerMessageService` to support delayed selection:
  - start timer at user-message boundary as today;
  - in `off`, emit the current pending text as today;
  - in `shadow`, emit current pending text and record selector comparison;
  - in `enforce`, call selector when timer fires;
  - suppress if validator rejects all candidates.
- **6.6** Update `RuntimeExecutor`:
  - build/update context envelope;
  - keep existing `generatePipelineFiller()` startup path;
  - keep existing `StatusTagParser` wrapping and tag stripping;
  - route static/pipeline/status text into candidate buffer;
  - keep `status_update` and `status_clear` unchanged.
- **6.7** Runtime-generated filler remains optional:
  - direct user-visible emission only in `off`;
  - shadow scoring in `shadow`;
  - fallback candidate only in `enforce` when configured and validated.

**Current Source Compatibility Contract**:

```text
off:
  static / pipeline / <status> -> queueFiller -> status_update

shadow:
  static / pipeline / <status> -> queueFiller -> status_update
  approved catalog selector -> filler_decision only

enforce:
  static / pipeline / <status> -> candidate buffer + context updates
  approved catalog selector -> final validator -> status_update or suppress
```

Pipeline and `<status>` remain useful, but their trust level changes by mode. In `enforce`, they are inputs to selection and observability, not authoritative text.

**Exit Criteria**:

- [ ] Timer starts at the user-message boundary.
- [ ] Text is selected at emit time from latest verified context.
- [ ] `catalogMode: off` preserves current static, pipeline, and `<status>` user-visible behavior.
- [ ] `catalogMode: shadow` emits current text but records approved-catalog comparison in traces.
- [ ] `catalogMode: enforce` prevents raw pipeline and raw `<status>` text from directly emitting.
- [ ] Unknown tool/capability state cannot emit specific action claims.
- [ ] Out-of-scope context selects neutral guardrail fallback or suppresses.
- [ ] Real output before delay cancels pending selection.
- [ ] Existing client event contract remains unchanged.
- [ ] Existing filler tests pass after compatibility updates.

**Rollback**:

Feature flag selector path to legacy `queueFiller(operation, text, source)`.

---

### Phase 7: Safety, Repetition, And Observability

**Goal**: Make runtime selection robust against repetition, safety issues, and debugging blind spots.

**Tasks**:

- **7.1** Add bounded recent filler history:
  - last 5-10 emitted filler texts per session;
  - no conversation-history persistence;
  - reset with session;
  - bounded memory only.
- **7.2** Feed recent history into selector and validator.
- **7.3** Add final validator:
  - repeated/near-duplicate rejection;
  - action claim vs capability state;
  - off-topic validation;
  - profanity echoing;
  - voice length/tone.
- **7.4** Add `filler_decision` trace event:

```ts
{
  type: 'filler_decision',
  data: {
    decision: 'emitted' | 'suppressed' | 'fallback',
    source,
    guardrailState,
    capabilityState,
    executionState,
    rejectedReason,
    operation,
    activeToolName
  }
}
```

Do not include raw unsafe user text in this event.

**Exit Criteria**:

- [ ] Exact repeats are avoided within recent history when alternatives exist.
- [ ] Unsafe/abusive/out-of-scope state emits neutral fallback or suppresses.
- [ ] `filler_decision` traces appear for emitted, suppressed, and fallback decisions.
- [ ] Trace data does not include raw abusive text, tenant secrets, model credentials, or auth values.
- [ ] Catalog selector and validator tests pass.

**Rollback**:

Disable selector/history path with `catalogMode: off`.

---

### Phase 8: E2E Coverage And Documentation

**Goal**: Prove the new design solves the demo failure modes through public surfaces.

**Tasks**:

- **8.1** Add WebSocket E2E for unsupported cancellation:
  - agent can schedule but cannot cancel;
  - user asks to cancel;
  - filler must not mention canceling.
- **8.2** Add WebSocket E2E for out-of-scope query:
  - user asks unrelated factual question;
  - filler must not answer or validate lookup.
- **8.3** Add WebSocket E2E for repetition:
  - multiple slow turns;
  - no exact repeat within last 5 fillers when alternatives exist.
- **8.4** Add abusive/profane input regression:
  - filler is minimal/neutral or suppressed.
- **8.5** Add voice integration regression:
  - barge-in suppression still works;
  - voice phrase length rules apply.
- **8.6** Update docs:
  - `docs/guides/filler-messages-configuration-and-technical-guide.md`;
  - `docs/features/filler-messages.md`;
  - `docs/specs/filler-messages.hld.md`;
  - `docs/testing/filler-messages.md`.

**Exit Criteria**:

- [ ] Unsupported cancellation filler regression passes.
- [ ] Out-of-scope filler regression passes.
- [ ] Repetition regression passes.
- [ ] Abusive/profane neutralization regression passes.
- [ ] Voice barge-in regression passes.
- [ ] E2E tests do not mock existing codebase components or directly access DB.
- [ ] Docs describe authoring, approval, publish, runtime selection, and rollback.

**Rollback**:

Keep tests and docs, but set rollout mode to `off` until failures are resolved.

## 10. Runtime Execution Order After Implementation

```text
1. User message enters RuntimeExecutor.executeMessage()
2. Runtime resolves session and AgentIR/release metadata
3. Runtime resolves approved filler catalog by catalog ref/hash
4. Runtime resolves channel filler mode from ChannelManifest
5. Runtime merges channel defaults and project filler config
6. Runtime reads filler.catalogMode: off | shadow | enforce
7. Runtime builds initial FillerContextEnvelope and empty RuntimeFillerCandidate buffer
8. Runtime starts FillerMessageService timer at user-message boundary
9. Main execution proceeds: guardrails, routing, prompt build, LLM, tools
10. Existing sources arrive in parallel:
    a. operation traces produce static fallback text
    b. generatePipelineFiller() may produce pipeline text
    c. StatusTagParser strips <status> tags and extracts status text
11. Runtime records those source texts in the candidate buffer
12. In off/shadow mode, current queueFiller behavior still updates pending visible text
13. Guardrail/tool/trace events update FillerContextEnvelope
14. Timer fires
15. Mode decision:
    off: emit current pending text as today
    shadow: emit current pending text as today, plus selector comparison trace
    enforce: CatalogSelector selects safest approved candidate
16. Final validator approves, falls back, or suppresses
17. Runtime emits filler_decision trace
18. If approved, runtime emits status_update
19. Real output starts
20. Runtime cancels filler window and emits status_clear if needed
21. Runtime records emitted filler in bounded recent history
22. Runtime destroys FillerMessageService at turn completion
```

## 11. Acceptance Criteria For Whole Feature

- [ ] Agent developer can generate LLM-assisted filler suggestions from Studio.
- [ ] Developer can review, edit, validate, approve, and archive catalogs.
- [ ] Approved catalog is project/agent scoped and versioned.
- [ ] Publish snapshots an approved catalog ref/hash or clearly warns/fails when missing.
- [ ] Runtime uses only approved catalogs in enforce mode.
- [ ] Filler never claims unsupported capability in cancellation-style demo cases.
- [ ] Filler never answers or validates out-of-scope factual questions.
- [ ] Filler avoids exact repetition across at least the last 5 emitted fillers when alternatives exist.
- [ ] Filler uses neutral/minimal tone for abusive, unsafe, or prompt-injection turns.
- [ ] Runtime emits existing `status_update` / `status_clear` client events.
- [ ] Voice channels keep barge-in suppression and phrase length constraints.
- [ ] Realtime S2S and VXML remain disabled unless transport support changes.

## 12. Open Questions

1. Should catalogs be scoped per project, per agent, or both with project defaults and agent overrides?
2. Should publish fail if no approved catalog exists in enforce mode, or fall back to static legacy fillers?
3. Which model should power “Generate suggestions”: existing filler model config, `tool_selection`, or a dedicated admin-selected authoring model?
4. Should Studio expose `catalogMode` to all project admins or keep it behind an internal feature flag initially?
5. Should working-copy debug sessions be allowed to use draft catalogs, or only approved catalogs?

## 13. Verification Commands

Run formatting before any commit:

```bash
npx prettier --write docs/plans/2026-05-13-llm-assisted-filler-catalog-authoring-impl-plan.md <all changed files>
```

Build before tests:

```bash
pnpm build
```

Targeted tests during implementation:

```bash
pnpm --filter @agent-platform/runtime exec vitest apps/runtime/src/services/filler/catalog/__tests__/catalog-validator.test.ts
pnpm --filter @agent-platform/runtime exec vitest apps/runtime/src/services/filler/catalog/__tests__/catalog-selector.test.ts
pnpm --filter @agent-platform/runtime exec vitest apps/runtime/src/services/filler/catalog/__tests__/catalog-generator.test.ts
pnpm --filter @agent-platform/runtime exec vitest apps/runtime/src/__tests__/routes/filler-catalogs.test.ts
pnpm --filter @agent-platform/runtime exec vitest apps/runtime/src/__tests__/thoughts-status-approved-filler-ws.e2e.test.ts
```

Security-sensitive PRs touching guardrails, HTTP handlers, or user input processing should also run:

```bash
./tools/run-semgrep.sh
```

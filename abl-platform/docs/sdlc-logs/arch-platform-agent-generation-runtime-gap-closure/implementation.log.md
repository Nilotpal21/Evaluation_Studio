# Arch + Runtime Agent Gap Closure Implementation Log

## 2026-05-16 — Slice 1: OpenAI Responses API History

### Scope

- Preserve OpenAI Responses API continuity across multi-turn tool-use sessions.
- Use `previousResponseId` round-tripping instead of attempting to serialize hidden `rs_*` reasoning items into platform history.
- Keep the change provider-aware so Anthropic, Google, Bedrock, and OpenAI Chat Completions behavior remains unchanged.

### Changes

- Added `extractOpenAIResponsesPreviousResponseId()` in `@agent-platform/llm` to recover the newest OpenAI Responses `responseId` from stored content-block provider metadata.
- Re-exported the helper through the runtime adapter wrapper.
- Updated `SessionLLMClient` to:
  - send `providerOptions.openai.store = true` for direct OpenAI Responses calls,
  - send `providerOptions.openai.previousResponseId` when prior assistant metadata contains a response id,
  - send only the messages after the referenced response when `previousResponseId` is present, avoiding resend of the previous assistant `function_call` item without its hidden reasoning item,
  - preserve the current response id on returned `rawContent` metadata for both generate and streaming paths,
  - keep existing `disableParallelToolUse` provider options merged into the same OpenAI/Anthropic provider option envelope.

### Test Lock

- `packages/llm/src/__tests__/tool-adapters.test.ts`
  - newest response id wins,
  - non-OpenAI provider metadata is ignored,
  - pruned request history still resolves `tool_result.toolName` from full history.
- `apps/runtime/src/__tests__/sessions/session-llm-client-timeout.test.ts`
  - runtime passes `previousResponseId` into OpenAI Responses calls,
  - runtime stores the current OpenAI `responseId` in returned raw content.

### Audit Notes

- The fix deliberately disables this history mode while the LiteLLM proxy is active because the provider factory routes LiteLLM through an OpenAI-compatible surface with proxy-specific semantics. A separate compatibility slice should validate whether LiteLLM supports Responses `previous_response_id` before enabling it there.
- Round 1 audit found that `previousResponseId` alone was insufficient if the runtime still resent the prior assistant tool-call message. The implementation now tracks the response-id location and prunes request history to the messages that followed that response.
- Round 2 audit found that pruning the previous assistant tool-call could remove the local `toolCallId -> toolName` lookup needed by AI SDK tool-result conversion. The converter now accepts full-history lookup context while still emitting only the pruned request messages.

## 2026-05-16 — Slice 2: Routing State Vocabulary Validation

### Scope

- Catch the Arch-generated HANDOFF-rule class that mixed `routing_intent` with `intent.category`.
- Keep the diagnostic warning-level so existing `intent.category` routing remains compatible.

### Changes

- Added `MIXED_ROUTING_CONDITION_STATE`.
- `validateFieldReferences()` now warns when routing or handoff rules combine `routing_intent` and `intent.category` in the same condition.

### Test Lock

- `packages/compiler/src/__tests__/validate-field-refs.test.ts`
  - warning emitted for `routing_intent != null AND intent.category == "post_purchase_issue"`,
  - no warning for canonical `intent.category`-only routing.

## 2026-05-16 — Slice 3: Interaction-Aware Behavior Profiles

### Scope

- Let behavior profile `WHEN:` expressions react to interaction state such as sentiment, emotion, and current turn topic.
- Move empathy/profile activation out of persona prose and into composable profile conditions.

### Changes

- Extended `ProfileContext` with an `interaction` object containing `sentiment_score`, `sentiment_label`, `emotion_label`, and `turn_topic`.
- Added extraction logic that accepts current nested interaction payloads and flat/camelCase equivalents:
  - `sentiment.score`, `sentiment_score`, `sentimentScore`,
  - `sentiment.label`, `sentiment_label`, `sentimentLabel`,
  - `emotion.label`, `emotion.name`, `emotion_label`, `emotionLabel`,
  - `turn.topic`, `turn_topic`, `turnTopic`.
- Defaulted missing interaction fields to neutral values so existing profiles continue evaluating deterministically.

### Test Lock

- `apps/runtime/src/__tests__/profile-resolver.test.ts`
  - minimal context includes neutral interaction defaults,
  - nested interaction state is exposed in profile context,
  - `interaction.sentiment_score < -0.3` activates a matching behavior profile.

### Audit Notes

- Round 1 audit checked the change stays inside profile context assembly and does not alter behavior-profile merge semantics.
- Round 2 audit checked the accepted input shapes are provider/runtime tolerant without using `any` or coupling CEL evaluation to domain-specific engine fields.

## 2026-05-16 — Post-Merge Verification

### Scope

- Fetched and merged latest `origin/develop@3f57414b22` into local `develop` at `20ca49c675`.
- Re-ran focused regression locks after upstream changes landed in nearby runtime and Studio areas.

### Verification

- `pnpm --filter @agent-platform/llm build`
- `pnpm --filter @abl/compiler build`
- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/llm exec vitest run src/__tests__/tool-adapters.test.ts`
- `pnpm --filter @abl/compiler exec vitest run src/__tests__/validate-field-refs.test.ts`
- `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/sessions/session-llm-client-timeout.test.ts src/__tests__/profile-resolver.test.ts`
- `pnpm abl:docs:check`

### Remaining Gaps

- Full symbol-table validation is still open beyond the mixed routing-state warning.
- Shared-voice HANDOFF, silent DELEGATE, consent-aware confirmation, editable static responses, structured diagnostics, default model policy, http_async continuity, fallback UI warnings, and lockfile repair remain future slices.

## 2026-05-16 — Slice 4: Editable Tool-Test Fixtures Backend

### Scope

- Add the backend surface needed for Studio to read and update hosted tool-test `staticResponse` and `sampleInput` values after bootstrap.
- Keep public invoke/spec capabilities stable when editing scenario data.

### Changes

- Added project-scoped fixture serialization and update helpers in `tool-test-endpoint-service`.
- Added `GET` and `PATCH` handlers to `/api/tool-test/:projectId/:toolId` with project permission checks, strict body validation, and scoped 404 behavior.
- Preserved existing `POST` tool execution behavior on the same Turbopack-compatible flat route.

### Test Lock

- `apps/studio/src/__tests__/api-routes/public-tool-test-api.test.ts`
  - loads a project-scoped editable fixture by tool id,
  - updates static response without rotating invoke/spec public capabilities.

### Verification

- `pnpm --filter @agent-platform/pipeline-engine build`
- `pnpm --filter @agent-platform/studio build`
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/api-routes/public-tool-test-api.test.ts`

### Audit Notes

- Round 1 audit verified every query path includes `tenantId`, `projectId`, and `projectToolId` or scoped tool id.
- Round 2 audit verified PATCH can update scenario data without changing public capabilities, so existing generated tool endpoints keep working.

## 2026-05-16 — Slice 5: Responses Reasoning-Item Diagnostics

### Scope

- Turn the known OpenAI Responses missing-reasoning-item failure into a sanitized, machine-readable runtime diagnostic.
- Keep this slice limited to the LLM classifier so it can land independently from the full runtime error-envelope and Studio trace UI work.

### Changes

- Added an LLM diagnostic sidecar map with `getLlmErrorDiagnostic()` for classified `AppError` instances.
- Classified OpenAI Responses errors where a `function_call` item is rejected because its required reasoning item is missing.
- Replaced raw `fc_*` / `rs_*` provider ids with a stable customer-safe message.
- Attached an operator hint recommending `previous_response_id` or adjacent reasoning/function-call preservation.

### Test Lock

- `apps/runtime/src/__tests__/classify-llm-error.test.ts`
  - verifies the Responses missing-reasoning-item error maps to `MODEL_API_ERROR`,
  - verifies customer-facing text omits raw provider item ids,
  - verifies the operator diagnostic exposes a stable code, provider, hint, and recommended action.

### Audit Notes

- Round 1 audit verified the customer-facing `AppError.message` is static and omits raw `fc_*` / `rs_*` provider item ids before existing `isLlmError()` channel surfaces render it.
- Round 2 audit verified the diagnostic helper uses a sidecar `WeakMap` and does not change shared `AppError` response serialization or leak raw provider payloads through `errorToResponse()`.

## 2026-05-16 — Slice 6: Local Lockfile Recompute CLI

### Scope

- Add a documented local repair path for v2 `abl.lock` files after hand edits to exported project folders.
- Keep the command offline and scoped to the CLI package so it does not depend on Studio availability.

### Changes

- Added `kore-platform-cli lockfile recompute <projectDir>` with optional `--check`.
- Recomputes agent/tool/config/etc. `source_hash` values, layer hashes, and root `integrity` using the existing v2 hash algorithm.
- Resolves agent source files through `project.json` manifest paths when available, with filename fallbacks for hand-built folders.
- Documented the command in `packages/kore-platform-cli/README.md`.

### Test Lock

- `packages/kore-platform-cli/src/__tests__/commands/lockfile.test.ts`
  - verifies stale v2 source hashes, layer hashes, and root integrity are recomputed in place,
  - verifies `--check`-style execution reports drift without writing,
  - verifies `integrity: null` hand-repair cases are recomputed,
  - verifies unsupported lockfile versions fail with an actionable error.

### Audit Notes

- Round 1 audit verified the CLI command mirrors `project-io` v2 integrity payload ordering and writes only `abl.lock`, not exported source files.
- Round 2 audit verified missing source files fail closed instead of silently generating misleading hashes, and directory traversal uses `lstat` so symlinked directories are not followed during recompute.

## 2026-05-16 — Slice 7: Consent-Aware Confirmation Runtime Gate

### Scope

- Preserve confirmation safety for side-effecting tools while skipping the redundant explicit prompt when the customer has already consented to the same action in the conversation.
- Keep this runtime-first: tool IR can carry consent fields and the executor honors them; Arch contract emission and ABL parser syntax are handled in Slice 8.

### Changes

- Extended tool confirmation IR with:
  - `consent_required_in`,
  - `consent_scope`,
  - `consent_action`,
  - `consent_fallback`.
- Added `evaluateConversationConsent()` to detect action-specific consent from the latest user turn.
- Matched common support actions such as replacement, refund, and credit while keeping replacement and refund distinct.
- Added scoped identifier mismatch detection so consent naming another order-like id still falls back to explicit confirmation.
- Wired the reasoning executor to skip the prompt only when scoped conversation consent is detected, and to emit consent-specific trace events.

### Test Lock

- `apps/runtime/src/__tests__/tools-deployment/tool-confirmation.test.ts`
  - detects "Replacement, please" as consent for `create_replacement`,
  - does not treat replacement consent as refund consent,
  - reports scope mismatch when the user names a different order id,
  - preserves legacy explicit-prompt behavior when conversation consent is not configured.
- `apps/runtime/src/__tests__/tools-deployment/tool-confirmation-gate.test.ts`
  - existing legacy gate behavior remains unchanged.

### Verification

- `pnpm --filter @abl/compiler build`
- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/tools-deployment/tool-confirmation.test.ts src/__tests__/tools-deployment/tool-confirmation-gate.test.ts`

### Audit Notes

- Round 1 audit verified existing tools keep legacy confirmation behavior unless they opt into `consent_required_in: conversation`.
- Round 2 audit verified scoped mismatches fail closed to the existing explicit prompt path instead of silently executing the tool.

## 2026-05-16 — Slice 8: Arch Consent Policy Emission

### Scope

- Make consent-aware confirmation expressible from generated ABL, not just hand-authored runtime IR.
- Keep the slice bounded to ABL syntax, compiler preservation, and Arch generator defaults for side-effecting tools.

### Changes

- Extended core tool confirmation AST with:
  - `consentRequiredIn`,
  - `consentScope`,
  - `consentAction`,
  - `consentFallback`.
- Parsed ABL tool properties:
  - `consent_required_in`,
  - `consent_scope`,
  - `consent_action`,
  - `consent_fallback`.
- Preserved those fields into compiler `ToolDefinition.confirmation`.
- Added Blueprint v2 tool confirmation contract fields and `sideEffects` hint.
- Updated blueprint rendering and skeleton generation so write/mutation tools emit:
  - `side_effects: true`,
  - `confirm: when_side_effects`,
  - scoped `immutable`,
  - conversation consent policy with explicit fallback.
- Updated Arch build prompt guidance so generated side-effecting tools use the new consent policy instead of unconditional "reply yes" prompts.

### Test Lock

- `packages/core/src/__tests__/agent-based-parser.test.ts`
  - parses consent-aware confirmation fields into the core AST.
- `packages/compiler/src/__tests__/ir/compiler-auth-profile.test.ts`
  - preserves consent-aware confirmation fields into compiled IR.
- `packages/compiler/src/__tests__/tool-confirmation-validation.test.ts`
  - existing side-effecting tool confirmation warning remains locked.
- `packages/arch-ai/src/__tests__/blueprint/v2-renderer.test.ts`
  - renders and compiles consent policy for `issue_refund(order_id, refund_amount)`.
  - keeps read-only `get_order` free of `side_effects: true` when confirmation is explicitly disabled.
- `packages/arch-ai/src/__tests__/generation/abl-pipeline.test.ts`
  - skeleton tools infer consent policy for `create_replacement(order_id, customer_id)`.
  - read-only skeleton tools do not get consent prompts from downstream-action wording in their descriptions.

### Verification

- `pnpm --filter @abl/core build`
- `pnpm --filter @abl/compiler build`
- `pnpm --filter @agent-platform/arch-ai build`
- `pnpm --filter @abl/core exec vitest run src/__tests__/agent-based-parser.test.ts`
- `pnpm --filter @abl/compiler exec vitest run src/__tests__/ir/compiler-auth-profile.test.ts src/__tests__/tool-confirmation-validation.test.ts`
- `pnpm --filter @agent-platform/arch-ai exec vitest run src/__tests__/blueprint/v2-renderer.test.ts src/__tests__/generation/abl-pipeline.test.ts`
- `pnpm abl:docs:check`

### Audit Notes

- Round 1 audit verified the consent fields now propagate parser -> core AST -> compiler IR -> Arch renderer without relying on runtime-only hand edits.
- Round 2 audit verified read-only generated tools are not marked side-effecting and explicit non-consenting confirmation metadata does not force `side_effects: true`.

## 2026-05-16 — Slice 9: Arch Default Model Policy

### Scope

- Make Arch-generated support agents fast and non-reasoning by default.
- Keep reasoning models available only when the intermediate contract or explicit agent model requires them.
- Leave runtime model resolution and tenant/project override semantics unchanged.

### Changes

- Added Blueprint v2 `modelPolicy` with:
  - `agentType`,
  - `reasoningRequired`,
  - `defaultModelClass`.
- Added an Arch model-policy resolver with model classes:
  - `fastToolCapable`,
  - `reasoning`,
  - `research`.
- Added override seams so concrete model IDs can come from:
  - explicit `agent.model`,
  - render/skeleton caller options,
  - blueprint-level `modelDefaults`,
  - package fallback defaults.
- Updated Blueprint v2 rendering so generated agents always include an explicit `EXECUTION` model:
  - the configured fast tool-capable default for ordinary support, classifier, dispatcher, scripted, and specialist agents,
  - the configured reasoning/research default for explicit reasoning/research `agentType`, `reasoningRequired`, or model class policy,
  - the exact `agent.model` value when the contract already specifies one.
- Updated Arch skeleton generation with the same model-selection policy.
- Updated build-prompt guidance to stop defaulting support agents to o-series models and to use the configured fast tool-capable default.

### Test Lock

- `packages/arch-ai/src/__tests__/blueprint/v2-renderer.test.ts`
  - default Blueprint v2 fixtures compile with the package fast tool-capable default,
  - blueprint and caller model defaults override package fallback defaults,
  - explicit reasoning policy emits the package reasoning default,
  - explicit model values override inferred policy.
- `packages/arch-ai/src/__tests__/generation/abl-pipeline.test.ts`
  - support skeletons emit the package fast tool-capable default,
  - caller model defaults override package fallback defaults,
  - reasoning/research policy emits the package research/reasoning default.
- `packages/arch-ai/src/__tests__/model-policy.test.ts`
  - verifies support/research/reasoning class selection,
  - verifies explicit models win over policy defaults,
  - verifies partial overrides merge with package fallback defaults,
  - verifies `reasoningRequired` cannot be accidentally overridden by a fast model class,
  - verifies blank override strings are ignored.
- `packages/arch-ai/src/__tests__/build-prompt-contract.test.ts`
  - verifies BUILD prompt model guidance can be rendered from supplied model defaults instead of freezing fallback model text.

### Audit Notes

- Round 1 audit verified the policy is generator-only and does not touch runtime model-resolution caches or credential-bearing resolution.
- Round 2 audit verified explicit `agent.model` still wins, so tenant/project migration paths and hand-authored ABL retain their selected model.
- Hardcoding audit found renderer/skeleton-level concrete model IDs were too brittle. The follow-up moved concrete models behind the model-class resolver and added blueprint/caller override paths.
- Deep audit found two hidden issues:
  - a contradictory `defaultModelClass: fast_tool_capable` could override `reasoningRequired: true`,
  - BUILD prompt guidance still used package fallback text with no override seam.
    Both were fixed by making `reasoningRequired` the stronger signal and adding `renderBuildPhasePrompt({ modelDefaults })`.

## 2026-05-16 — Slice 10: Reasoning Fallback Trace Warning

### Scope

- Surface reasoning-fallback handoff/routing decisions in Studio without requiring raw trace inspection.
- Keep raw event payloads out of trace explorer list responses.

### Changes

- Runtime trace explorer aggregates known reasoning-fallback markers from ClickHouse event JSON:
  - `isReasoningFallback`,
  - `reasoningFallback`,
  - `routingSource: reasoning_fallback`,
  - `decisionSource: reasoning_fallback`,
  - `source: reasoning_fallback`.
- Runtime normalizes those markers into a sanitized warning envelope with code `REASONING_FALLBACK`.
- Studio trace rows render a warning badge with a possible-misconfiguration hint when that warning is present.

### Test Lock

- `apps/runtime/src/routes/__tests__/traces-explorer-parity.test.ts`
  - verifies trace explorer query derives fallback warning counts/codes from event data and still omits raw `data`.
- `apps/studio/src/__tests__/components/traces-page-parity.test.tsx`
  - verifies Studio renders the reasoning-fallback warning badge.

### Audit Notes

- Deep audit found no literal `isReasoningFallback` symbol in current runtime source, so the fix intentionally detects serialized trace payload markers at the trace explorer boundary instead of depending on one emission path.
- The warning envelope is additive and optional, so older rows without fallback metadata render unchanged.

## 2026-05-16 — Slice 11: HTTP Async Status Bridge

### Scope

- Give HTTP Async clients a mid-turn continuity signal before long tool calls without pretending the channel supports token streaming.
- Keep final `agent.response` delivery unchanged.

### Changes

- Added `agent.status` to the HTTP Async webhook event contract and webhook delivery/subscription model enums.
- New subscriptions default to `agent.response` plus `agent.status`; existing subscriptions receive status events only after opting in through their `events` list.
- Inbound worker emits one non-blocking `agent.status` delivery from the first visible streamed bridge chunk for `http_async`.
- Status payload includes `status: in_progress`, a truncated bridge message, `trace_context.delivery: status_event`, and `metadata.status_kind: pre_tool_bridge`.

### Test Lock

- `apps/runtime/src/__tests__/inbound-worker.test.ts`
  - verifies opt-in HTTP Async status delivery is created and queued before the final response delivery.
- `apps/runtime/src/__tests__/http-async-events.test.ts`
  - locks the expanded webhook event union.
- `apps/runtime/src/__tests__/channels/adapters/http-async-adapter.test.ts`
  - keeps adapter payload transformation behavior stable.

### Audit Notes

- The slice deliberately uses a distinct status event instead of flipping `http_async.supportsStreaming`; callback delivery remains queue-based and retryable.
- Status emission is best-effort. If the subscription is not opted in or the status delivery fails, the final `agent.response` still proceeds.

## 2026-05-16 — Slice 12: Capability-Driven Model Parameters

### Scope

- Remove hardcoded assumptions that every tenant/project model supports the same sampling controls.
- Keep Arch model selection future-ready by pairing model-class policy with registry/catalog-discovered runtime parameters.

### Changes

- Model registry catalog exposes Microsoft Foundry Anthropic as a first-class browse provider while preserving base model capabilities.
- Model capabilities route now returns recursive dynamic hyperparameter metadata and capability flags such as `supportsReasoningEffort`, `supportsThinkingBudget`, `temperatureDisabled`, and `topPDisabled`.
- Studio model management renders nested hyperparameter controls, stores provider-specific `hyperParameters`, and stops submitting generic temperature/max-token fields when the model does not advertise them.
- Tenant/project model persistence and import/export carry `hyperParameters`.
- Runtime model resolution parses tenant, project, and agent hyperparameter bags into provider-neutral resolved parameters, strips unsupported values, and maps OpenAI/Anthropic/Google/Bedrock thinking or reasoning options at the provider boundary.

### Test Lock

- `packages/compiler/src/__tests__/llm/model-registry.test.ts`
  - locks catalog aliases and filtered model metadata.
- `apps/runtime/src/__tests__/model-catalog.test.ts`
  - locks Foundry catalog browse behavior.
- `apps/runtime/src/__tests__/model-resolution-comprehensive.test.ts`
  - verifies tenant/project hyperparameter resolution and unsupported-parameter stripping.
- `apps/runtime/src/__tests__/sessions/session-llm-client-timeout.test.ts`
  - verifies provider option mapping for Anthropic thinking and OpenAI reasoning effort.
- `apps/runtime/src/__tests__/model-hub-overrides.e2e.test.ts`
  - verifies platform-admin provisioning preserves dynamic hyperparameters and runtime execution toggles.
- `apps/studio/src/__tests__/components/hyper-parameter-form.test.tsx`
  - verifies nested controls, runtime parameter aliases, and the mutually-exclusive radio default fix.
- `apps/studio/src/__tests__/components/model-management.test.tsx`
  - verifies Studio no longer renders/submits generic sampling controls for models without advertised controls and wires Foundry catalog credential setup.
- `packages/project-io/src/__tests__/core-assembler.test.ts`, `core-direct-apply.test.ts`, and `entity-schemas.test.ts`
  - lock import/export propagation of project model `hyperParameters`.

### Audit Notes

- `docs/sdlc-logs/arch-platform-agent-generation-runtime-gap-closure/data-flow-audit.md` records the propagation matrix.
- Deep audit found and fixed a hidden radio-option bug: default generation was persisting both `temperature` and `top_p` alternatives. Radio option defaults now render visually but persist only when stored or changed.
- Second audit found and fixed a platform-admin propagation gap: provisioned models accepted `hyperParameters` but dropped `useResponsesApi`/`useStreaming` and rejected `embedding` capability metadata.
- Legacy scalar `temperature` and `maxTokens` remain in tenant/project model schemas for compatibility; runtime suppresses scalar sampling when a dynamic hyperparameter bag exists.

## 2026-05-16 — Slice 13: Dotted Condition Symbol Validation

### Scope

- Tighten the compiler field-reference validator so dotted condition paths prove their root exists instead of being skipped as dynamic.
- Preserve legitimate runtime dotted roots such as `intent`, `user`, `session`, `caller`, `env`, `sentiment`, and `interaction`.

### Changes

- Added dotted-root validation for condition references such as `action_request.kind`.
- Added known roots for raw stored tool results (`last_<tool>_result`) and explicit tool `on_result` / `on_error` mappings.
- Normalized dotted assignment targets so a producer for `profile.status` also declares the `profile` root.

### Test Lock

- `packages/compiler/src/__tests__/validate-field-refs.test.ts`
  - verifies an undeclared `action_request.kind` handoff condition now emits `UNDEFINED_CONDITION_VAR`,
  - verifies declared dotted roots remain accepted,
  - verifies tool result mappings and raw stored tool-result roots are accepted.

### Verification

- `pnpm --filter @abl/compiler build`
- `pnpm --filter @abl/compiler exec vitest run src/__tests__/validate-field-refs.test.ts`
- `pnpm --filter @abl/compiler exec vitest run src/__tests__/validate-integration.test.ts src/__tests__/validate-cross-agent.test.ts src/__tests__/routing-default-agent.test.ts`

### Audit Notes

- Deep audit found the previous validator skipped every dotted path, which masked missing producer variables in the exact style Arch generated during the VoltMart session.
- Round 2 checked adjacent validation suites to keep the change warning-level and avoid breaking valid `intent.category` and runtime-context routing expressions.

## 2026-05-16 — Slice 14: Tool-Test Fixture Editor UI

### Scope

- Make hosted tool-test endpoint fixtures editable from Studio so scenario data no longer requires rerunning Arch synthesis or deploying an external mock server.
- Keep the editor scoped to existing hosted test endpoints and hidden for tools without one.

### Changes

- Added Studio API client helpers for hosted tool-test fixture `GET` and `PATCH`.
- Wired the tool detail testing section with `projectId` and `toolId` so it can lazily load fixture metadata.
- Added a fixture editor for `staticResponse` and `sampleInput` with format, reset, and save controls.
- Preserved `sampleInput: null` as `null` instead of silently normalizing it to `{}` during unrelated edits.

### Test Lock

- `apps/studio/src/__tests__/components/tool-testing-section.test.tsx`
  - verifies hosted fixture JSON loads, edits, saves, and updates version metadata,
  - verifies the editor stays hidden when no hosted test endpoint exists.
- `apps/studio/src/__tests__/components/tool-test-panel.test.tsx`
  - remains locked for the existing standalone tool-test panel flow.

### Verification

- `pnpm --filter @agent-platform/studio build`
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/components/tool-testing-section.test.tsx src/__tests__/components/tool-test-panel.test.tsx`

### Audit Notes

- Deep data-flow audit traced `staticResponse` and `sampleInput` through backend route response, Studio API client, editor state, save payload, and refreshed endpoint response.
- Round 2 found the null-preservation gap for `sampleInput`; the editor now round-trips null fixtures without accidental mutation.

## 2026-05-16 — Slice 15: LLM Operator Diagnostics In Trace Explorer

### Scope

- Carry existing LLM operator diagnostics from classifier output into runtime trace events and Studio trace list warnings.
- Keep customer-facing messages sanitized while giving operators a recognizable model-diagnostic badge.

### Changes

- Added a normalized LLM operator diagnostic envelope derived from classified provider errors.
- Runtime execution errors now emit the sanitized customer message plus operator-only diagnostic metadata into trace events.
- Reasoning-loop handled errors preserve LLM operator diagnostics instead of only configuration diagnostics.
- Trace explorer detects the OpenAI Responses missing-reasoning-item diagnostic from trace event JSON and returns a structured warning code.
- Studio trace rows render a `Model diagnostic` warning badge with the operator hint in the title.

### Test Lock

- `apps/runtime/src/__tests__/classify-llm-error.test.ts`
  - verifies the OpenAI Responses missing-reasoning-item classifier emits the operator diagnostic envelope without leaking `fc_*` or `rs_*` IDs to the customer message.
- `apps/runtime/src/routes/__tests__/traces-explorer-parity.test.ts`
  - verifies trace explorer ClickHouse aggregation recognizes the diagnostic code and returns the warning.
- `apps/studio/src/__tests__/components/traces-page-parity.test.tsx`
  - verifies Studio renders the model diagnostic badge.

### Verification

- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/classify-llm-error.test.ts src/routes/__tests__/traces-explorer-parity.test.ts`
- `pnpm --filter @agent-platform/studio build`
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/components/traces-page-parity.test.tsx`

### Audit Notes

- Deep audit found the classifier diagnostic was created but lost before trace exploration; the fix threads it through both top-level execution errors and handled reasoning-loop errors.
- Round 2 kept the channel contract sanitized: runtime logs keep the raw error, trace data gets the safe customer message plus operator hint, and customer-facing error text does not include provider item IDs.

## 2026-05-16 — Slice 16: DELEGATE Trace Correlation

### Scope

- Make silent DELEGATE executions easier to audit by carrying one stable delegation correlation id across parent and child trace events.
- Keep existing customer suppression behavior unchanged: delegated child execution still runs with no customer-facing chunk callback.

### Changes

- Added `delegationId` to recursive `executeMessage` options.
- Propagated `delegationId` through delegated child `delegated_message`, `agent_enter`, `turn_start`/`turn_end` when emitted, `agent_lifecycle`, `thread_return`, and `delegate_complete` events.
- Added `delegationId` support to delegation trace data and failure completion traces.

### Test Lock

- `apps/runtime/src/__tests__/execution/flow-action-dispatch.test.ts`
  - verifies ON_ACTION DELEGATE emits one stable `delegationId` across delegate start, delegated message, child agent entry, thread return, and delegate completion.

### Verification

- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/execution/flow-action-dispatch.test.ts`

### Audit Notes

- Deep audit found suppression already relies on passing `onChunk: undefined` to delegated child execution; this slice leaves that runtime behavior intact.
- The hidden observability gap was correlation, not streaming: parent/child session and thread indexes existed on some events, but there was no single id operators could follow across the whole delegated run.

## 2026-05-16 — Slice 17: Arch Scaffold Flow Filler Removal

### Scope

- Remove customer-visible canned normal-path FLOW text from Arch-derived scaffold plans.
- Keep explicit failure copy in place for controlled tool-call fallback responses.

### Changes

- Studio scaffold `deriveScaffoldRuntimePlan()` now renders tool-backed flows as tool-call steps followed by `THEN: COMPLETE`, without `start` and `finalize` `RESPOND` filler.
- Package-level construct-plan defaults now do the same for blueprint-derived tool-backed agents.
- Non-tool construct defaults also avoid invented normal-path `RESPOND` text, letting generated persona/complete behavior own customer wording instead of planner fallbacks.

### Test Lock

- `apps/studio/src/lib/arch-ai/scaffold/__tests__/runtime-flow.test.ts`
  - verifies tool-backed scaffold flows contain no normal-path `respond` values,
  - verifies routing supervisors do not synthesize scripted transition copy.
- `packages/arch-ai/src/__tests__/planning/construct-plan.test.ts`
  - verifies blueprint-derived tool-backed defaults no longer contain the exact canned progress/completion strings from the VoltMart failure.

### Verification

- `pnpm build` in `packages/arch-ai`
- `pnpm --filter @agent-platform/studio build`
- `pnpm test -- src/__tests__/planning/construct-plan.test.ts` in `packages/arch-ai`
- `pnpm --filter @agent-platform/studio exec vitest run src/lib/arch-ai/scaffold/__tests__/runtime-flow.test.ts`

### Audit Notes

- Deep audit found two independent generators carrying the same hidden filler: Studio scaffold runtime flow and package-level construct-plan fallback flow.
- Production string search now finds no remaining instances of the VoltMart canned normal-path phrases outside regression tests.
- Remaining Arch generation gaps are structured tool signatures, welcome shaping, duplicate delegation HTTP tools, and contract-derived gather/context semantics.

## 2026-05-16 — Slice 18: Structured Tool Signature Fallbacks

### Scope

- Replace Arch's generic `(input: string) -> { result: string }` fallback family with structured, name-derived tool contracts.
- Cover both package-level Arch rendering paths and Studio scaffold generation.

### Changes

- Added `inferFallbackToolSignature()` in `packages/arch-ai` for missing blueprint/tool signatures.
- Wired the helper through construct-plan derivation, blueprint rendering, battle fixtures, and the legacy ABL generation pipeline.
- Updated Studio scaffold tool stubs to infer domain-shaped inputs and outputs, including order lookup fields (`last_scan_at`, `promised_delivery_date`, `eligible_options`) and write-action IDs for replacements/refunds/credits.
- Added generic-signature detection tests so the old fallback shape remains locked out.

### Test Lock

- `packages/arch-ai/src/__tests__/planning/tool-signature-inference.test.ts`
  - verifies `get_order` and `create_replacement` infer structured signatures,
  - verifies legacy generic fallbacks are recognized as generic.
- `packages/arch-ai/src/__tests__/planning/construct-plan.test.ts`
  - keeps blueprint-derived construct plans valid after fixture signature inference changes.
- `apps/studio/src/lib/arch-ai/scaffold/__tests__/scaffold-generator.test.ts`
  - verifies Studio scaffold emits structured `get_order` and `create_replacement` signatures.

### Verification

- `pnpm build` in `packages/arch-ai`
- `pnpm --filter @agent-platform/studio build`
- `pnpm test -- src/__tests__/planning/tool-signature-inference.test.ts src/__tests__/planning/construct-plan.test.ts` in `packages/arch-ai`
- `pnpm --filter @agent-platform/studio exec vitest run src/lib/arch-ai/scaffold/__tests__/scaffold-generator.test.ts src/lib/arch-ai/scaffold/__tests__/runtime-flow.test.ts`

### Audit Notes

- Deep audit found generic fallback signatures in four package-level paths plus Studio scaffold generation.
- Production string search now finds no remaining direct generic fallback generation under `packages/arch-ai/src` or `apps/studio/src/lib/arch-ai/scaffold`.
- This is still heuristic inference, not a full SOP-derived contract. The future-proof contract generator should replace these fallbacks with source-grounded tool schemas when SOP/API specs provide them.

## 2026-05-16 — Slice 19: Channel-Shaped Entry Welcome

### Scope

- Replace Studio scaffold's long generated entry greeting with a brief, channel-shaped welcome.
- Keep the change deterministic and contract-adjacent while the broader channel persona contract remains future work.

### Changes

- `buildEntryWelcomeMessage()` now emits one short sentence for chat and a slightly tighter variant when the project includes voice.
- Removed role/routing jargon from generated `ON_START` copy.

### Test Lock

- `apps/studio/src/lib/arch-ai/scaffold/__tests__/scaffold-generator.test.ts`
  - verifies web chat welcome is one short sentence,
  - verifies voice welcome is shorter and avoids routing/policy jargon.

### Verification

- `pnpm --filter @agent-platform/studio build`
- `pnpm --filter @agent-platform/studio exec vitest run src/lib/arch-ai/scaffold/__tests__/scaffold-generator.test.ts`

### Audit Notes

- This fixes the concrete 60-word-policy-dump class at the scaffold fallback layer.
- The full future-proof resolution is still contract-driven welcome shaping with per-channel budgets, persona deltas, and voice-specific abbreviation rules.

## 2026-05-16 — Slice 20: Customer-Clean Generated Responses

### Scope

- Remove implementation language from generated customer-facing fallback responses.
- Extend the cleanup to the older Studio ABL builder copy that still used mechanical "processing" language.

### Changes

- Studio scaffold failure responses now use human support language:
  - "I'm having trouble checking that right now. I can try again or get someone to help."
  - transaction/escalation/pipeline variants avoid `tool`, `step`, `workflow`, `context`, `retry`, and `escalation`.
- Package-level construct-plan failure responses use the same customer-clean fallback.
- Legacy Studio ABL builder copy now says "I am checking that now." instead of "Processing your request..."

### Test Lock

- `apps/studio/src/lib/arch-ai/scaffold/__tests__/runtime-flow.test.ts`
  - verifies generated failure responses do not contain implementation terms.
- `packages/arch-ai/src/__tests__/planning/construct-plan.test.ts`
  - verifies blueprint-derived tool-call failure responses do not contain implementation terms.
- `apps/studio/src/__tests__/arch-ai/abl-builder.test.ts`
  - verifies the legacy builder no longer emits "Processing your request".

### Verification

- `pnpm build` in `packages/arch-ai`
- `pnpm --filter @agent-platform/studio build`
- `pnpm test -- src/__tests__/planning/construct-plan.test.ts` in `packages/arch-ai`
- `pnpm --filter @agent-platform/studio exec vitest run src/lib/arch-ai/scaffold/__tests__/runtime-flow.test.ts src/__tests__/arch-ai/abl-builder.test.ts`

### Audit Notes

- Production grep for the original customer-visible phrases no longer finds executable generation code; remaining hits are documentation/comments that are not emitted as customer responses.
- Internal schema, DSL, and diagnostic terms remain unchanged because those are not customer-visible responses.

## 2026-05-16 — Slice 21: Duplicate Relationship Tool Filtering

### Scope

- Stop Arch and Studio scaffolds from generating relationship-as-HTTP-tool duplicates when the same target is already represented by a HANDOFF/DELEGATE relationship.
- Keep real business tools intact while filtering helper names such as `consult_policy_advisor` and `delegate_to_fulfillment`.

### Changes

- Added a shared `filterRelationshipToolRefs()` planning helper that recognizes relationship verbs plus specialist target aliases.
- Applied the filter in:
  - package-level construct-plan tool emission,
  - package-level blueprint renderer tool emission,
  - Studio scaffold tool stub generation.
- Target aliases include full agent names and common suffix-stripped forms, so `PolicyAdvisor` matches `consult_policy_advisor` and `policy`, while `get_order` remains a normal tool.

### Test Lock

- `packages/arch-ai/src/__tests__/planning/relationship-tool-filter.test.ts`
  - verifies consult/delegate helpers are filtered and normal tools remain.
- `packages/arch-ai/src/__tests__/planning/construct-plan.test.ts`
  - verifies construct plans do not carry duplicate relationship tools or tool calls.
- `packages/arch-ai/src/__tests__/blueprint/v2-renderer.test.ts`
  - verifies rendered ABL excludes duplicate relationship tools.
- `apps/studio/src/lib/arch-ai/scaffold/__tests__/scaffold-generator.test.ts`
  - verifies Studio scaffold tools exclude relationship duplicates for handoff targets.

### Verification

- `pnpm build` in `packages/arch-ai`
- `pnpm --filter @agent-platform/studio build`
- `pnpm test -- src/__tests__/planning/relationship-tool-filter.test.ts src/__tests__/planning/construct-plan.test.ts src/__tests__/blueprint/v2-renderer.test.ts` in `packages/arch-ai`
- `pnpm --filter @agent-platform/studio exec vitest run src/lib/arch-ai/scaffold/__tests__/scaffold-generator.test.ts`

### Audit Notes

- Production search for the concrete duplicate names is clean outside tests.
- This is a deterministic guardrail for generated relationship duplicates. The future-proof contract generator should still decide topology mode explicitly so tools, handoffs, and delegates are derived from one relationship model instead of inferred from names.

## 2026-05-16 — Slice 22: Context-Aware Gather Source Filtering

### Scope

- Stop Arch from turning supervisor-provided context, session memory, tool-derived state, or parent handoff payloads into customer-facing required GATHER prompts.
- Keep true user-supplied fields available as normal GATHER fields.

### Changes

- Added `source: user | context | tool | memory` to Blueprint v2 gather fields, defaulting to `user` for compatibility.
- Package-level construct planning now marks fields passed by an incoming handoff as `context` instead of `user`.
- Package-level blueprint rendering skips non-user and incoming-context fields when emitting customer-facing `GATHER:`.
- Source-contract topology synthesis no longer converts SOP Memory/session variables or shared memory into `gatherFields`.
- Studio scaffold generation accepts optional gather field source metadata and only scaffolds user-origin fields.
- Tightened the Studio and package-level topology-generation prompt descriptions so generated gather fields are only values the agent must ask the end user for directly, not values it can receive from a supervisor, context, tools, or memory.

### Test Lock

- `packages/arch-ai/src/__tests__/blueprint/source-architecture-contract.test.ts`
  - verifies session memory such as `customer_id` is not synthesized as specialist gather input.
- `packages/arch-ai/src/__tests__/planning/construct-plan.test.ts`
  - verifies fields passed by parent handoff context are marked `source: context`.
- `packages/arch-ai/src/__tests__/blueprint/v2-renderer.test.ts`
  - verifies context-provided fields are not rendered as customer-facing `GATHER` prompts while user fields still render.
- `apps/studio/src/lib/arch-ai/scaffold/__tests__/scaffold-generator.test.ts`
  - verifies scaffold generation omits non-user gather fields from skeleton prompts and memory session vars.

### Verification

- `pnpm build` in `packages/arch-ai`
- `pnpm test -- src/__tests__/blueprint/source-architecture-contract.test.ts src/__tests__/planning/construct-plan.test.ts src/__tests__/blueprint/v2-renderer.test.ts` in `packages/arch-ai`
- `pnpm --filter @agent-platform/studio exec vitest run src/lib/arch-ai/scaffold/__tests__/scaffold-generator.test.ts`
- `pnpm --filter @agent-platform/studio build`

### Audit Notes

- This closes the concrete source of "supervisor gives you X" becoming "ask the customer for X" in the source-contract and scaffold paths.
- Follow-up grep found no remaining topology-generation prompt text telling models that gather fields may be "collected or received."
- Broader contract generation still needs first-class relationship payload fields so parent pass/context, child required inputs, and completion conditions are derived from one source of truth instead of inferred post-hoc.

## 2026-05-16 — Slice 23: Return-Target Prompt Hygiene

### Scope

- Remove residual Arch guidance that forced every RETURN/delegate target to have customer-facing GATHER fields.
- Align prompt and warning language with the new source-aware gather contract: return targets need completion state, not necessarily user questions.

### Changes

- Updated the package-level ABL construct expert prompt so delegate targets require a COMPLETE block driven by declared state.
- Updated Studio handbook generation rules so completion can be driven by user GATHER, CONTEXT.pass, MEMORY, FLOW SET, or tool result state.
- Updated the delegate-missing-gather warning copy to recommend user GATHER only when the child must ask directly; otherwise it points to context, memory, flow, or tool state.

### Test Lock

- `packages/arch-ai/src/__tests__/build-prompt-contract.test.ts`
  - verifies the multi-agent architect prompt tells generation to use gather fields only for direct end-user questions and no longer says fields may be "collected or received."

### Verification

- `pnpm build` in `packages/arch-ai`
- `pnpm test -- src/__tests__/build-prompt-contract.test.ts` in `packages/arch-ai`
- `pnpm --filter @agent-platform/studio exec vitest run src/lib/arch-ai/scaffold/__tests__/scaffold-generator.test.ts`
- `pnpm --filter @agent-platform/studio build`

### Audit Notes

- Production grep under `packages/arch-ai/src` and `apps/studio/src/lib/arch-ai` no longer finds the stale phrases `MUST have GATHER`, `child MUST have GATHER`, `missing GATHER: fields`, or `collect or receive`.
- `apps/studio/src/__tests__/arch-ai/build-agent-system-prompt.test.ts` still has a pre-existing import-time failure (`getAblContractRegistry is not a function`) and could not be used as a focused lock for this slice.

## 2026-05-17 — Slice 24: Customer Continuity Events

### Scope

- Treat HTTP Async status as one consumer of a broader customer-continuity contract, not as the feature itself.
- Ensure Arch-authored shared-voice handoff agents are told to use clean pre-action bridge language.
- Prevent internal implementation language from reaching end customers through status/bridge events.

### Changes

- Added `apps/runtime/src/channels/customer-continuity.ts` with:
  - channel-to-continuity delivery mapping,
  - customer-safe bridge text normalization,
  - status payload construction for status-event channels.
- Updated inbound worker HTTP Async status delivery to use the continuity helper instead of directly serializing the first streamed chunk.
- Added continuity metadata to status payloads: `status_kind`, `continuity_kind`, `visibility`, and `source`.
- Updated Arch's shared-voice handoff behavior profile to require brief customer-facing bridge phrases before longer lookups/actions and prohibit tool/workflow/system/internal handoff wording.
- Updated the LLD wording so the slice is scoped around authored-agent customer experience across consumers, with HTTP Async as one transport-specific consumer.

### Test Lock

- `apps/runtime/src/__tests__/channels/customer-continuity.test.ts`
  - locks delivery-mode mapping and bridge text sanitization.
- `apps/runtime/src/__tests__/inbound-worker.test.ts`
  - locks HTTP Async `agent.status` payload metadata and sanitization before `WebhookDelivery`.
- `packages/arch-ai/src/__tests__/blueprint/v2-renderer.test.ts`
  - locks generated shared-voice behavior profile guidance.

### Verification

- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/arch-ai build`
- `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/channels/customer-continuity.test.ts src/__tests__/inbound-worker.test.ts`
- `pnpm --filter @agent-platform/arch-ai exec vitest run src/__tests__/blueprint/v2-renderer.test.ts`
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/arch-ai/in-project-tools-topology.test.ts`

### Audit Notes

- Data-flow audit appended in `docs/sdlc-logs/arch-platform-agent-generation-runtime-gap-closure/data-flow-audit.md`.
- Remaining work: emit and render `long_running_status` and `handoff_transition`, add callback E2E proof for HTTP Async `agent.status`, and gather voice/live channel timing evidence.

## 2026-05-17 — Slice 25: Runtime Topology Continuity Semantics

### Scope

- Carry authored topology experience semantics into runtime handoff/delegate traces.
- Make visible handoff transitions consumable by channels without changing shared-voice handoff behavior.
- Keep silent delegates internal and suppressed by construction.

### Changes

- Runtime handoff traces now include `experienceMode`, customer/internal `visibility`, `suppressChildOutput`, and a `continuity` envelope.
- `visible_handoff` and `human_escalation` emit a customer-visible `handoff_transition`; `shared_voice_handoff` remains customer-facing child output but has no transfer announcement.
- Streaming-text channels receive the visible handoff transition as a sanitized streamed chunk before child execution.
- HTTP Async consumes the same customer-visible handoff transition through an opt-in `agent.status` event with `source: runtime_topology`.
- Delegate traces now include `experienceMode: silent_delegate`, `visibility: internal`, and `suppressChildOutput: true`.
- Customer-continuity status payloads preserve the continuity `kind` and `source`, and the sanitizer no longer treats normal phrases such as "carrier response" as implementation language.

### Test Lock

- `apps/runtime/src/__tests__/channels/customer-continuity.test.ts`
  - locks non-bridge continuity kinds and source metadata.
- `apps/runtime/src/__tests__/inbound-worker.test.ts`
  - verifies HTTP Async queues a handoff-transition `agent.status` only when topology marks it customer-visible.
- `apps/runtime/src/__tests__/execution/reasoning-gather-handoff.test.ts`
  - verifies shared-voice handoff stays internally silent for transfer continuity,
  - verifies visible handoff traces include a customer-visible transition and streaming channels receive the transition chunk,
  - verifies delegate traces remain internal/suppressed.

### Verification

- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/channels/customer-continuity.test.ts src/__tests__/inbound-worker.test.ts`
- `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/execution/reasoning-gather-handoff.test.ts -t "should emit handoff trace and dsl_collect|RETURN: true should keep thread|executeDelegate should emit delegate_complete trace|executeDelegate should pass INPUT context"`

### Audit Notes

- Deep data-flow audit traced `experienceMode` and continuity fields from compiled runtime coordination config into executor traces, HTTP Async delivery, and streamed channel chunks.
- Full `reasoning-gather-handoff.test.ts` still has pre-existing multi-delegate failures where the second delegate result is not merged; the focused topology-continuity locks pass, and the failing area is outside this slice's trace/status propagation change.
- Remaining work: implement an actual `long_running_status` emitter, add full HTTP Async callback E2E proof, and capture voice/live timing evidence.

## 2026-05-17 — Slice 26: Long-Running Continuity Status And Complete Filler Phrases

### Scope

- Emit a delayed customer-visible continuity signal when an HTTP Async tool/action stays open long enough to create silence.
- Keep the status before the final response in callback queue order.
- Make runtime-generated filler/status phrases complete before they reach voice or chat consumers.

### Changes

- Added an HTTP Async long-running watchdog in the inbound worker that arms on tool-call start traces and clears on tool result/error/completion traces.
- The watchdog emits one opt-in `agent.status` payload with `continuity_kind: long_running_status` and `source: runtime_topology` after the configured delay.
- HTTP Async status idempotency now includes the continuity kind so a pre-action bridge and a later long-running status can both be delivered once.
- Customer-continuity normalization now completes common filler fragments like "Pulling that up now" and "Checking..." into spoken-safe sentences.
- The older `FillerMessageService` now normalizes text at the emission gate, and its fallback message pools use complete human phrases.
- Runtime-authored handoff bridge chunks now pass through the same completion gate before being emitted.

### Test Lock

- `apps/runtime/src/__tests__/channels/customer-continuity.test.ts`
  - verifies fragment completion and long-running status payload metadata.
- `apps/runtime/src/__tests__/inbound-worker.test.ts`
  - verifies long-running HTTP Async status delivery waits for the delay, then queues before the final `agent.response`.
- `apps/runtime/src/__tests__/extraction/filler-service.test.ts`
  - verifies filler emission completes custom/static/pipeline fragments.
- `apps/runtime/src/__tests__/extraction/filler-integration.test.ts`
  - verifies trace-derived filler text is spoken-safe after emission.
- `apps/runtime/src/__tests__/extraction/filler-config-propagation.test.ts`
  - verifies channel-configured filler services emit complete phrases.
- `apps/runtime/src/__tests__/routing/routing-executor-unit.test.ts` and `apps/runtime/src/__tests__/routing/routing-remote-handoff.test.ts`
  - verify runtime handoff bridge copy is emitted as a completed phrase.

### Verification

- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/channels/customer-continuity.test.ts src/__tests__/inbound-worker.test.ts src/__tests__/extraction/filler-service.test.ts src/__tests__/extraction/filler-integration.test.ts src/__tests__/extraction/filler-config-propagation.test.ts`
- `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/routing/routing-executor-unit.test.ts src/__tests__/routing/routing-remote-handoff.test.ts -t "project-owned voice handoff copy|localized voice handoff copy|localized voice|remote handoff"`

### Audit Notes

- Deep data-flow audit appended for the long-running status emitter and filler phrase-completion gate.
- Voice/live timer-driven fillers remain evidence-gated. This slice completes the phrases for existing runtime emitters but does not add a voice timer that could interrupt active TTS.

## 2026-05-17 — Slice 27: HTTP Async Callback Ordering Proof

### Scope

- Lock the callback delivery edge for HTTP Async continuity events.
- Prove queued status payloads and final responses are posted to the callback in queue order.

### Changes

- Added delivery-worker regression coverage that processes an `agent.status` job followed by an `agent.response` job for the same HTTP Async subscription.
- The test verifies the callback receives `agent.status` before `agent.response`, the long-running continuity metadata survives serialization, and delivered statuses are updated with tenant-scoped filters.

### Test Lock

- `apps/runtime/src/__tests__/delivery-worker.test.ts`
  - verifies callback POST body ordering and delivery status updates for status/result pairs.

### Verification

- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/delivery-worker.test.ts src/__tests__/inbound-worker.test.ts`

### Audit Notes

- This complements Slice 26's inbound-worker queue-order proof. Together they lock both halves of the HTTP Async path without introducing a fake Redis stack.

## 2026-05-17 — Slice 27a: HTTP Async Callback Sink Proof

### Scope

- Strengthen the HTTP Async callback proof without taking on a full deployed/browser run.
- Audit the Web Chat status path and keep residual proof gaps explicit.

### Changes

- Added a delivery-worker regression with a real local HTTP callback sink instead of a stubbed `fetch`.
- The test processes an `agent.status` job before the final `agent.response` job and verifies the callback receives two POST bodies in order.
- The test verifies the status body preserves customer-visible continuity metadata and that the final answer text appears only in the final response body.

### Test Lock

- `apps/runtime/src/__tests__/delivery-worker.test.ts`
  - verifies real callback consumer ordering for HTTP Async status/result pairs.

### Audit Notes

- Web Chat status rendering is a separate websocket path: runtime emits `status_update` / `status_clear`, `packages/web-sdk` maps them through `ChatClient` and `DefaultTransport`, and React/provider/widget rendering still needs browser-level proof.
- HTTP Async `agent.status` is webhook-only; this slice proves callback consumer delivery, not Studio Web Chat rendering.
- A full deployed callback E2E remains useful later, but the worker-level callback sink now protects the ordering contract through a real HTTP consumer.

## 2026-05-17 — Slice 28: Voice Continuity Evidence

### Scope

- Verify existing voice/live handoff behavior does not require a timer-driven filler to preserve continuity.
- Keep the user-experience constraint explicit: do not inject synthetic voice fillers unless the transport is proven to queue complete utterances behind active speech.

### Evidence

- Grok S2S handoff orchestration tracks `response.output_audio_transcript.done` and matching `response.done` before sending inline session updates, so the live session changes after the transfer speech completes.
- KoreVG non-streaming filler playback waits for synthesized-audio completion before final response delivery, and LiveKit forwards runtime status updates through the normal TTS stream path.
- Runtime-authored filler/handoff strings are now phrase-complete from Slice 26, so existing voice consumers receive complete text when those emitters are used.

### Verification

- `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/channels/korevg-router-grok.test.ts -t "stores Grok S2S metadata and updates the live session inline after handoff speech completes|updates the live session when the transfer response completes before handoff scheduling finishes|does not repeat authored internal handoff speech"`

### Audit Notes

- No new voice timer was added. That remains blocked until provider-specific evidence proves filler utterances are queued, not interruptive.

## 2026-05-17 — Slice 29: Continuity Consumer Matrix Lock

### Scope

- Close the typing-only and sync/final-response continuity gap with manifest-wide contract tests.
- Ensure future channels cannot accidentally receive synthetic text status payloads when they only support native typing indicators or final responses.

### Changes

- Extended `customer-continuity.test.ts` to assert every `CHANNEL_MANIFEST` row maps to exactly one continuity consumption mode:
  - HTTP Async -> `agent.status`
  - streaming channels -> streamed text
  - typing-capable non-streaming channels -> native typing indicator
  - sync/final-only channels -> final response only
- Added regression coverage that typing-only and final-response channels never get synthesized `agent.status` text payloads.

### Verification

- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/channels/customer-continuity.test.ts`

### Audit Notes

- This closes the channel-matrix proof for current manifest channels. It does not implement provider-specific typing refresh timers; it prevents the unsafe fallback of sending partial text status to channels that cannot render it safely.

## 2026-05-17 — Slice 30: Lockfile Repair Docs

### Scope

- Close the builder/operator documentation gap for stale `abl.lock` repair.
- Make the supported recompute command discoverable from import/export docs, not only the CLI README.

### Changes

- Added v2 lockfile repair guidance to `docs/design/EXPORT_V2_FORMAT_SPEC.md`.
- Added pre-import lockfile repair guidance to `docs/reference/ABL_IMPORT_GUIDE.md`.
- Updated the LLD status and wiring checklist to mark the lockfile repair docs path complete.

### Verification

- `npx prettier --write` on changed docs.
- `pnpm abl:docs:check`
- `git diff --check`

### Audit Notes

- This slice documents the existing CLI recompute implementation. It does not change lockfile hashing behavior.

## 2026-05-17 — Slice 31: HANDOFF ON_RETURN Map Validation Hardening

### Scope

- Tighten the Phase 2 compiler validation slice for HANDOFF return-state contracts.
- Keep the change scoped to compiler validation and tests; no runtime HTTP async or channel continuity files touched.

### Changes

- Promoted `UNKNOWN_HANDOFF_RETURN_FIELD` from warning to error when a local HANDOFF `ON_RETURN MAP` references a child field the target agent cannot declare or obviously produce.
- Added compiler-level regression coverage proving invalid HANDOFF child keys land in `compilation_errors`, not `compilation_warnings`.

### Verification

- `pnpm --filter @abl/compiler build`
- `pnpm --filter @abl/compiler exec vitest run src/__tests__/validate-cross-agent.test.ts`
- `pnpm --filter @abl/compiler exec vitest run src/__tests__/validate-cross-agent.test.ts src/__tests__/validate-integration.test.ts`

### Remaining Gaps

- Undefined dotted HANDOFF variables remain warning-level outside this specific return-contract slice.
- GATHER producer/consumer analysis is still open.

## 2026-05-17 — Slice 32: DELEGATE Auth Preflight

### Scope

- Close the runtime topology semantics gap where a silent delegated child could begin execution before target-agent auth requirements were checked.
- Keep the fail-closed point before delegate stack mutation, child thread creation, activation, or child `executeMessage`.

### Changes

- Generalized the handoff auth preflight helper and added `validateDelegateAuthRequirements`.
- Added delegate-target auth preflight in `RoutingExecutor.executeDelegate()`.
- Blocked delegate attempts emit structured `delegate_start` metadata with `blockReason: auth_preflight` and missing requirement summaries, then complete through the existing delegate failure path.
- Added focused tests proving missing auth blocks child execution and satisfied auth still executes the delegated child normally.
- Added a runtime package learning note for future child-agent invocation paths.

### Verification

- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/execution/delegate-auth-preflight.test.ts src/__tests__/auth/auth-profile-propagation.test.ts`

### Remaining Gaps

- This is focused runtime unit coverage. Full channel/session E2E auth flow coverage remains a separate broader test slice.

## 2026-05-17 — Slice 33: Arch Model-Policy Topology Fallbacks

### Scope

- Close the hidden Arch model-policy gap where active deterministic topology and system-agent paths lacked a provider-neutral `modelPolicy` surface even though Blueprint v2 rendering could already consume one.
- Avoid concrete model IDs in topology output; preserve model class hints for later catalog/policy resolution.

### Changes

- Added `inferArchModelPolicyFromText()` with support, dispatcher, reasoning, and research classification.
- Added optional `modelPolicy` to topology agents and threaded it through source-contract synthesis, deterministic topology synthesis, and system-agent skeleton generation.
- Preserved `experienceMode` into deterministic handoff skeletons when building from topology edges.
- Updated architect prompt guidance to emit `modelPolicy` hints and avoid concrete provider model IDs.
- Added focused regressions for topology synthesis, source-contract synthesis, skeleton rendering, prompt contract text, and model-policy inference.
- Added an Arch package learning note that `executionMode: "reasoning"` is not proof that a reasoning model family is required.

### Verification

- `pnpm --filter @agent-platform/arch-ai build`
- `pnpm --filter @agent-platform/arch-ai exec vitest run src/__tests__/model-policy.test.ts src/__tests__/coordinator/topology-synthesis.test.ts src/__tests__/blueprint/source-architecture-contract.test.ts src/__tests__/generation/abl-pipeline.test.ts src/__tests__/build-prompt-contract.test.ts`

### Remaining Gaps

- Shared-voice/channel shaping is still split in one deterministic system-agent project creation path: it now preserves `EXPERIENCE_MODE`, but full managed behavior-profile persistence for that path remains open.

## 2026-05-17 — Slice 34: Final Parallel Closure Batch

### Scope

- Close the remaining high-value partial slices with focused subagent patches, then re-audit integration points before commit.
- Keep model policy future-ready by treating Arch output as provider-neutral capability intent, not concrete model selection.

### Changes

- Compiler validation now detects required GATHER fields that have no known consumer across COMPLETE responses, MEMORY remembers, FLOW expressions, handoff/delegate inputs, tool inputs, and return mappings.
- Runtime channel outcomes now reuse sanitized runtime error envelopes when available, so customers receive clean messages while traces retain operator diagnostics and trace IDs.
- HTTP Async delivery has a real local callback-sink regression proving `agent.status` is delivered before final `agent.response`.
- Arch system-agent project finalization persists managed shared-voice behavior profiles for shared-voice topologies and deletes stale Arch-managed profile variables when a topology stops using them.
- Arch scaffold/topology generation preserves `EXPERIENCE_MODE`, while Studio topology visualization labels shared, visible, silent, and human escalation edge experiences.
- Arch model policy remains a capability hint. Explicit author-selected models still win, but Arch no longer picks concrete reasoning/research defaults that may not exist in the customer's tenant catalog.
- Runtime model resolution treats dynamic hyperparameter bags as authoritative for agent-level settings and avoids reviving stale legacy scalar temperature when dynamic parameters exist.

### Test Lock

- `packages/compiler/src/__tests__/validate-field-refs.test.ts`
- `apps/runtime/src/services/channel/__tests__/outcome.test.ts`
- `apps/runtime/src/__tests__/delivery-worker.test.ts`
- `apps/runtime/src/__tests__/tenant-models.test.ts`
- `packages/arch-ai/src/__tests__/system-agent-process-deps.test.ts`
- `packages/arch-ai/src/__tests__/model-policy.test.ts`
- `apps/studio/src/__tests__/arch-ai/scaffold-generation.test.ts`
- `apps/studio/src/__tests__/arch-ai/finalize-project-tool-bootstrap.test.ts`

### Verification

- `pnpm --filter @abl/compiler build`
- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/arch-ai build`
- `pnpm --filter @agent-platform/studio build`
- `pnpm --filter @abl/compiler exec vitest run src/__tests__/validate-field-refs.test.ts src/__tests__/validate-field-refs-tool-returns.test.ts src/__tests__/validate-cross-agent.test.ts`
- `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/delivery-worker.test.ts src/__tests__/inbound-worker.test.ts src/__tests__/channels/customer-continuity.test.ts src/services/channel/__tests__/outcome.test.ts src/__tests__/classify-llm-error.test.ts src/__tests__/tenant-models.test.ts src/__tests__/sessions/session-llm-client-timeout.test.ts`
- `pnpm --filter @agent-platform/arch-ai exec vitest run src/__tests__/system-agent-process-deps.test.ts src/__tests__/model-policy.test.ts src/__tests__/blueprint/v2-renderer.test.ts src/__tests__/build-prompt-contract.test.ts src/__tests__/generation/abl-pipeline.test.ts`
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/arch-ai/scaffold-generation.test.ts`
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/arch-ai/finalize-project-tool-bootstrap.test.ts`

### Remaining Gaps

- The full intermediate Arch contract generator is still the major remaining product slice.
- Full browser rendering proof for Web Chat status events and provider-recorded voice audio evidence remain open.
- Runtime diagnostics still need adapter-specific delivery-failure normalization beyond the inbound outcome path.

## 2026-05-17 — Slice 35: Source Contract Customer Experience Fields

### Scope

- Close a focused part of the intermediate Arch contract generator gap without touching runtime, Studio, or browser consumers.
- Keep model-policy output provider-neutral: source contracts now carry capability intent, not concrete model IDs.

### Changes

- Added source-contract fields for welcome shape, channel rules, consent policies, scenario fixtures, and per-agent model-policy intent.
- Added extraction/defaulting for VoltMart-like SOPs: perceived persona/welcome limits, voice/chat/WhatsApp channel rules, side-effect consent scope/fallback, fixture tables, and reasoning-required advisory roles.
- Rendered the new fields into the uploaded-source architecture prompt so topology generation sees the CX contract.
- Exported the new contract field types from `packages/arch-ai`.
- Added focused regressions for VoltMart-like input plus legacy-source compatibility.

### Verification

- `pnpm --filter @agent-platform/arch-ai exec vitest run src/__tests__/blueprint/source-architecture-contract.test.ts`
- `pnpm --filter @agent-platform/arch-ai build`

### Remaining Gaps

- Blueprint/project generation does not yet consume these fields into full generated ABL behavior profiles, tool static fixtures, or consent-aware construct planning.
- Extraction is intentionally heuristic and source-document based; richer structured SOP schemas can tighten this later.

## 2026-05-17 — Slice 36: Parallel Closure Batch Two

### Scope

- Continue closing the remaining plan gaps with disjoint subagent slices, then verify the combined tree locally.
- Keep the model/access boundary clear: Arch and source contracts emit capability intent and customer-experience metadata; runtime/model catalog resolves concrete access.

### Changes

- Runtime diagnostics: added a sanitized channel-delivery diagnostic helper and wired Slack delivery failures for missing config, missing metadata, provider rejection, and network/timeout failures so `SendResult.error` no longer leaks raw provider/network text.
- Web SDK: React `AgentProvider` now consumes `statusUpdate` / `statusClear`, `useChat()` exposes `statusMessage`, and `ChatWidget` renders a transient status indicator outside message history that clears on final non-user responses.
- Compiler validation: added warning-level `MISSING_VARIABLE_PRODUCER_WARNING` for explicit non-condition consumers such as templates, tool input templates, `SET` expressions, memory stores, transforms, and action responses when no known producer exists.
- Model parameters: added provider-level supported parameter fallback for unknown model IDs and fail-closed filtering for unknown providers, without hardcoding customer model IDs.
- Arch contract: source architecture contracts now carry welcome shape, channel rules, consent policies, scenario fixtures, and provider-neutral per-agent model-policy intent.

### Verification

- `pnpm --filter @abl/compiler build`
- `pnpm --filter @agent-platform/arch-ai build`
- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/web-sdk build`
- `pnpm --filter @abl/compiler exec vitest run src/__tests__/validate-field-refs.test.ts src/__tests__/validate-field-refs-tool-returns.test.ts src/__tests__/validate-cross-agent.test.ts src/__tests__/knowledge-drift.test.ts`
- `pnpm --filter @agent-platform/arch-ai exec vitest run src/__tests__/blueprint/source-architecture-contract.test.ts`
- `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts --maxWorkers=1 src/channels/adapters/__tests__/slack-delivery-diagnostics.test.ts src/services/channel/__tests__/outcome.test.ts src/__tests__/model-resolution-comprehensive.test.ts`
- `pnpm --filter @agent-platform/web-sdk exec vitest run src/__tests__/agent-provider-transport.test.tsx src/__tests__/react-components.test.tsx`
- `pnpm --filter @abl/compiler build:knowledge`
- `pnpm abl:docs:check`
- `git diff --check`

### Remaining Gaps

- The new Arch CX contract fields are not yet consumed end-to-end into generated ABL behavior profiles, tool static fixtures, or construct-planning consent.
- Slack is the first direct-send adapter normalized; Telegram, Twilio, LINE, email, Teams, WhatsApp, and similar adapters still need the same delivery diagnostic treatment.
- Web SDK has deterministic DOM proof, but a live Runtime slow-tool Playwright flow and provider-recorded voice evidence remain open.
- Compiler producer checks are whole-agent, not control-flow/order aware.

## 2026-05-17 — Slice 37: Blueprint Source-Contract Consumption

### Scope

- Close the next Arch contract-generation gap by making the Blueprint renderer consume SOP-derived source-contract metadata instead of leaving it prompt-only.
- Keep the change focused on generated ABL surfaces that already exist: tool confirmation metadata and shared-voice behavior profile channel selection.

### Changes

- Blueprint rendering now accepts `sourceContract` alongside model defaults.
- Tool rendering uses source-contract consent policies when a blueprint tool has no explicit confirmation metadata, preserving explicit blueprint confirmation as the higher-precedence author choice.
- Shared-voice behavior profile rendering now includes channels declared by the source contract and channel rules when the Blueprint specification did not retain them.
- Studio's `rebuild_agents_from_blueprint` path now reloads the source architecture contract from the originating Arch session and passes it into Blueprint rendering.

### Verification

- `pnpm --filter @agent-platform/arch-ai exec vitest run src/__tests__/blueprint/v2-renderer.test.ts`

### Remaining Gaps

- Source-contract scenario fixtures are still not emitted into tool-test static responses.
- Construct-plan generation still needs direct consent-policy awareness before the Blueprint renderer fallback.
- Full live generated-project proof remains open.

## 2026-05-17 — Slice 38: Lockfile Repair Command Coverage

### Scope

- Harden the FR-13 local lockfile repair slice without touching the hash algorithm or import/export runtime paths.
- Cover the operator-facing `kore-platform-cli lockfile recompute --check` command path in addition to the direct helper.

### Changes

- Added command-level coverage for `lockfile recompute <projectDir> --check`, including non-zero exit code, stale-lockfile stderr, and no file writes.
- Added a fail-closed regression for missing source files referenced by `abl.lock`.
- Updated the test matrix to mark FR-13 unit coverage done while leaving integration/E2E status partial/planned.

### Verification

- `pnpm --filter @agent-platform/cli build`
- `pnpm --filter @agent-platform/cli exec vitest run src/__tests__/commands/lockfile.test.ts`
- `pnpm --filter @agent-platform/cli test:fast`

### Remaining Gaps

- FR-13 remains partially open at the broader integration/E2E level; the next step would be a CLI process-level fixture or import-preflight path that invokes the built binary against an exported project folder.

## 2026-05-17 — Slice 39: Lockfile Repair CLI Process Smoke

### Scope

- Close the remaining FR-13 integration proof for the local repair command by invoking the built CLI entry point as a separate process.
- Keep the slice constrained to lockfile repair verification and status docs.

### Changes

- Added a process-level smoke test that runs `node dist/index.js lockfile recompute <projectDir> --check` against a stale exported project fixture.
- Verified the process exits with code 1, reports the stale `abl.lock` path on stderr, and leaves the file unchanged.
- Updated the test matrix to mark FR-13 integration coverage done while preserving E2E/manual as planned.

### Verification

- `pnpm --filter @agent-platform/cli build`
- `pnpm --filter @agent-platform/cli exec vitest run src/__tests__/commands/lockfile.test.ts`
- `pnpm --filter @agent-platform/cli test:fast`

### Remaining Gaps

- FR-13 still has no dedicated browser/UI E2E, which is acceptable for the local CLI-only repair path unless import-preflight UX later exposes it.

## 2026-05-17 — Slice 40: Source Fixtures Into Hosted Tool-Test Static Responses

### Scope

- Close the next source-contract consumption gap after Blueprint consent/channel rendering.
- Seed Studio-hosted Test API fixtures from SOP scenario examples when generated project finalization bootstraps HTTP tools.
- Keep the slice scoped to existing finalization/bootstrap paths; no route, database, or fixture-editor behavior changes.

### Changes

- `synthesizeOnboardingBootstrapTools()` now accepts an optional `sourceContract`.
- Matching `sourceContract.scenarioFixtures[].toolFixtures` override generated placeholder static responses by tool name.
- JSON fixture responses are parsed directly; short symbolic fixture responses such as `damaged_delivered` are coerced into the generated return shape, preferring fields such as `status`, `state`, `result`, `message`, or `outcome`.
- Message/query-style sample input parameters can be seeded from the source scenario user message when the generated sample did not already provide a value.
- `finalizeProject()` now reloads `metadata.sourceArchitectureContract` from the fresh session and passes it into tool bootstrap synthesis.

### Test Lock

- `apps/studio/src/__tests__/arch-ai/finalize-project-tool-bootstrap.test.ts`
  - verifies pure bootstrap synthesis uses source-contract scenario fixture responses for matching tools,
  - verifies final project creation passes source-derived static responses into hosted tool-test endpoint upserts.

### Verification

- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/arch-ai/finalize-project-tool-bootstrap.test.ts`

### Remaining Gaps

- Fixture input values remain heuristic unless the source contract supplies explicit per-tool sample inputs.
- Full generated-project browser proof is still open.

## 2026-05-17 — Slice 41: Source-Grounded Tool-Test Inputs And Direct-Send Diagnostics

### Scope

- Prioritize the next two open gap-closure items:
  - richer source-grounded fixture inputs/schemas for hosted Tool Test API bootstrap,
  - broader direct-send channel adapter diagnostic normalization beyond Slack/Messenger.
- Keep the slice constrained to existing source-contract extraction, Studio bootstrap, and direct-send adapter `SendResult` behavior.

### Changes

- Extended source-contract scenario tool fixtures with optional per-tool JSON `sampleInput`.
- Enhanced scenario fixture table parsing to accept both:
  - `tool_name({"field":"value"}): response`
  - `tool_name input={"field":"value"} => response`
- Studio bootstrap now merges explicit source fixture sample inputs into hosted Tool Test API `sampleInput` values.
- Studio bootstrap now source-infers common top-level fixture inputs from scenario text and fixture responses:
  - message/query/question/prompt fields use the source user message,
  - ID-like fields can pick up SOP-style identifiers such as `VM-48217-A` or `CUST-442`,
  - enum/status, amount, email, phone, and date-like fields get deterministic source-grounded values when present.
- Telegram, LINE, Instagram, Twilio SMS, Zendesk, and Microsoft Teams direct-send adapters now return the shared sanitized `channelDiagnostic` / `errorEnvelope` shape for configuration, metadata, provider, network, and timeout failures.
- Raw provider text, tokens, tenant identifiers, URLs, and exception messages stay in logs only; `SendResult.error` remains customer-clean.

### Test Lock

- `packages/arch-ai/src/__tests__/blueprint/source-architecture-contract.test.ts`
  - verifies scenario fixture extraction preserves explicit per-tool sample input objects.
- `apps/studio/src/__tests__/arch-ai/finalize-project-tool-bootstrap.test.ts`
  - verifies pure bootstrap synthesis and final project endpoint upserts receive source-grounded sample inputs and static responses.
- `apps/runtime/src/channels/adapters/__tests__/direct-send-delivery-diagnostics.test.ts`
  - verifies Telegram, LINE, Instagram, Twilio SMS, Zendesk, and Microsoft Teams return sanitized delivery diagnostics and do not leak raw provider secret strings.

### Verification

- `pnpm --filter @agent-platform/arch-ai build`
- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/studio build`
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/arch-ai/finalize-project-tool-bootstrap.test.ts`
- `pnpm --filter @agent-platform/arch-ai exec vitest run src/__tests__/blueprint/source-architecture-contract.test.ts`
- `pnpm --filter @agent-platform/runtime exec vitest run src/channels/adapters/__tests__/direct-send-delivery-diagnostics.test.ts src/channels/adapters/__tests__/slack-delivery-diagnostics.test.ts src/channels/adapters/__tests__/messenger-delivery-diagnostics.test.ts`

### Remaining Gaps

- Fixture inference is intentionally top-level and deterministic; nested object/array schema-aware fixture synthesis remains open.
- Email, WhatsApp provider implementations, AI4W, Audiocodes, VXML, KoreVG, Genesys, and other lower-volume direct-send/voice adapters still need the same delivery diagnostic parity where they return customer-visible `SendResult` failures.

## 2026-05-17 — Slice 42: Remaining Direct-Send Adapter Diagnostic Parity

### Scope

- Continue the runtime diagnostics track from Slice 41.
- Normalize lower-volume direct-send paths that still returned raw or missing `SendResult.error` values.
- Keep voice/sync adapters that return success-only direct sends out of scope until their route-specific customer-visible failure surfaces are audited.

### Changes

- Email direct-send failures now use the shared sanitized channel-delivery envelope for missing recipient metadata and Graph transport configuration gaps.
- AI4W async callback preparation now returns sanitized configuration diagnostics when connection secrets or callback base URLs are missing.
- WhatsApp Meta Cloud, Infobip, Netcore, and Gupshup provider sends now normalize:
  - missing provider credentials or endpoint configuration,
  - missing recipient/sender metadata,
  - HTTP provider rejections,
  - application-level provider rejection payloads,
  - network failures and abort/timeout failures.
- Raw provider text, credential names, token values, tenant IDs, and exception strings remain log-only and do not appear in customer-visible `SendResult.error` values.

### Test Lock

- `apps/runtime/src/channels/adapters/__tests__/direct-send-delivery-diagnostics.test.ts`
  - verifies Email metadata/configuration diagnostics,
  - verifies AI4W async configuration diagnostics,
  - verifies WhatsApp provider rejection diagnostics for Meta Cloud, Infobip, Netcore, and Gupshup,
  - verifies secret/provider-detail strings do not leak into serialized send results.

### Verification

- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/runtime exec vitest run src/channels/adapters/__tests__/direct-send-delivery-diagnostics.test.ts src/channels/adapters/__tests__/slack-delivery-diagnostics.test.ts src/channels/adapters/__tests__/messenger-delivery-diagnostics.test.ts`
- `pnpm abl:docs:check`
- `git diff --check`

### Remaining Gaps

- Direct-send diagnostic parity now covers the major async/direct channel adapters and WhatsApp providers; media downloaders, streaming channels, and sync/voice route-specific failures need a separate audit because they do not expose the same direct `SendResult` failure surface.
- At this point in the log, nested/object-schema-aware source fixture synthesis was still open; Slice 43 below closes the Studio bootstrap portion.

## 2026-05-17 — Slice 43: Schema-Aware Tool-Test Sample Inputs

### Scope

- Continue the hosted Tool Test API fixture work from Slices 40 and 41.
- Close the top-level-only sample-input gap for HTTP tool parameters that declare object or array schemas.
- Keep the slice inside Studio bootstrap synthesis and finalization tests; no route or editor behavior changes.

### Changes

- Studio bootstrap now parses HTTP tool parameter `objectSchema` metadata when generating hosted Tool Test API `sampleInput` values.
- Object parameter schemas are walked recursively so nested customer/order/contact payloads receive deterministic sample values instead of `{}`.
- Array parameter schemas now receive one representative item generated from the item schema.
- Source scenario text grounds nested fields using the same fixture evidence as top-level fields: IDs, email, phone, enum/status, amount, date, and SKU/order/customer patterns.
- Explicit source-contract fixture `sampleInput` values are deeply merged over generated nested schema values, preserving source-authored overrides without discarding generated sibling fields.

### Test Lock

- `apps/studio/src/__tests__/arch-ai/finalize-project-tool-bootstrap.test.ts`
  - verifies nested object-schema sample inputs are source-grounded for customer/order replacement payloads,
  - verifies explicit nested source fixture input overrides generated nested leaves while preserving generated sibling values,
  - preserves existing hosted fixture finalization coverage for static responses and top-level sample inputs.

### Verification

- `pnpm --filter @agent-platform/studio typecheck`
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/arch-ai/finalize-project-tool-bootstrap.test.ts`
- `pnpm --filter @agent-platform/studio build` — attempted after waiting for an existing `.next/lock` owner to exit; Next reached "Creating an optimized production build ..." and then terminated with `SIGTERM` without reporting a TypeScript or application error.
- `pnpm abl:docs:check`
- `git diff --check`

### Remaining Gaps

- Full generated-project browser proof for source-grounded fixtures remains open.
- Studio bootstrap now handles object/array schema metadata available on HTTP tool parameters; agent-declared tools without nested schema metadata still fall back to their declared flat signatures.

## 2026-05-17 — Slice 44: Scaffold Build Stall Diagnostics

### Scope

- Address deployed Arch BUILD sessions where one Sonnet-backed scaffold worker can leave the UI at `3/4 compiled` with the active agent still spinning.
- Keep the fix scoped to worker abort propagation and builder-facing terminal diagnostics.

### Changes

- Propagated the per-agent BUILD abort signal into deterministic scaffold `generateObject()` calls.
- Added terminal abort handling for scaffold workers so a stalled model call emits `build_agent_error` instead of falling through silently or continuing blind regeneration.
- Guarded scaffold progress callbacks after abort so late model callbacks cannot keep the UI in a compiling state.

### Test Lock

- `apps/studio/src/__tests__/arch-ai/scaffold-slot-fix-loop.test.ts`
  - verifies a pre-aborted scaffold fill is terminal and does not fall back to deterministic creative content.

### Remaining Gaps

- Deployed callback/browser proof for the full VoltMart BUILD flow remains open.

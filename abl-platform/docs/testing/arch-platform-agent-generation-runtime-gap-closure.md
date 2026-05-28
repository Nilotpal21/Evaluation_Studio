# Test Specification: Arch And Runtime Agent Gap Closure

**Feature Spec**: None yet. Derived from the VoltMart agent-build session findings.
**HLD**: None yet.
**LLD**: `docs/plans/2026-05-16-arch-platform-agent-generation-runtime-gap-closure.lld.md`
**Status**: IN PROGRESS
**Last Updated**: 2026-05-17
**Grounded Against**: `origin/develop@3f57414b22` merged locally at `20ca49c675`

---

## 1. Coverage Matrix

| FR    | Description                                                                                                                | Unit    | Integration | E2E     | Manual  | Status  |
| ----- | -------------------------------------------------------------------------------------------------------------------------- | ------- | ----------- | ------- | ------- | ------- |
| FR-1  | OpenAI Responses history preserves reasoning items or uses `previous_response_id` across tool turns                        | Done    | Partial     | Planned | Planned | PARTIAL |
| FR-2  | Runtime topology supports shared-voice HANDOFF, visible HANDOFF, and silent DELEGATE as distinct customer-experience modes | Partial | Partial     | Planned | Planned | PARTIAL |
| FR-3  | DELEGATE invokes child agents with structured input, suppresses child customer output, and returns state to parent         | Partial | Partial     | Planned | Planned | PARTIAL |
| FR-4  | Consent-aware confirmation prompts only when specific conversation consent is missing or mismatched                        | Done    | Partial     | Planned | Planned | PARTIAL |
| FR-5  | Tool-test static responses and sample inputs are editable after bootstrap                                                  | Done    | Partial     | Partial | Planned | PARTIAL |
| FR-6  | Runtime errors surface sanitized customer messages and Studio operator hints                                               | Partial | Planned     | Planned | Planned | PARTIAL |
| FR-7  | Compiler/import validation catches undefined HANDOFF/MEMORY/GATHER/ON_RETURN symbols                                       | Partial | Planned     | Planned | Planned | PARTIAL |
| FR-8  | Arch generation is contract-driven and does not emit generic signatures, canned FLOW filler, or placeholder fixtures       | Partial | Partial     | Planned | Planned | PARTIAL |
| FR-9  | New support agents default to non-reasoning tool-capable models unless the contract requires reasoning                     | Done    | Partial     | Planned | Planned | PARTIAL |
| FR-10 | Behavior profile context exposes interaction state such as sentiment and emotion                                           | Done    | Planned     | Planned | Planned | PARTIAL |
| FR-11 | http_async can deliver mid-turn bridge/status events before long tool calls                                                | Done    | Partial     | Planned | Planned | PARTIAL |
| FR-12 | Studio flags `isReasoningFallback: true` as a warning                                                                      | Done    | Partial     | Planned | Planned | PARTIAL |
| FR-13 | Lockfile repair/recompute command and docs exist                                                                           | Done    | Done        | Planned | Planned | PARTIAL |
| FR-14 | Model parameter controls and provider options are capability-driven instead of hardcoded per default model                 | Done    | Partial     | Planned | Planned | PARTIAL |

## 2. E2E Test Scenarios

All E2E scenarios must exercise public HTTP or WebSocket surfaces with real servers, real middleware, and project/tenant auth. Do not mock codebase modules. External LLM/provider behavior may be supplied through a test provider boundary or provider test fixture injected through supported runtime configuration.

### E2E-1: OpenAI Responses reasoning model completes multi-turn tool use

- **Preconditions**:
  - Runtime server starts on a random port with real auth and tenant/project scoping.
  - Project has an agent using an OpenAI Responses-compatible reasoning model.
  - Agent has a read tool and a write or second read tool.
  - Test provider fixture emits `reasoning -> function_call` on turn 1 and requires prior reasoning/function adjacency or `previous_response_id` on turn 2.
- **Steps**:
  1. Create session through public runtime API.
  2. Send message that triggers tool call 1.
  3. Let runtime execute the tool and ask the model for the next step.
  4. Send a follow-up user message that triggers another model turn.
  5. Fetch session trace through public trace/session API.
- **Expected Result**:
  - No provider error complaining that a `function_call` item is missing a required reasoning item.
  - Trace shows either `previous_response_id` linkage or adjacent reasoning/function-call history.
  - Final assistant message is delivered to the customer channel.
- **Auth Context**: Tenant A, Project X, project editor/owner.
- **Isolation Check**: Tenant B cannot fetch the session or trace; returns 404.

### E2E-2: Shared-voice HANDOFF preserves one perceived customer voice

- **Preconditions**:
  - Generated VoltMart project has Reception and Orders agents.
  - Relationship mode Reception -> Orders is `shared_voice_handoff`.
  - Both agents use perceived persona `Alex`.
- **Steps**:
  1. Start a web chat or http_async session.
  2. Send: "My order is three days late and I need it for a flight."
  3. Reception acknowledges briefly and triggers HANDOFF.
  4. Send order id/email.
  5. Orders agent calls `get_order` and continues resolution.
- **Expected Result**:
  - Customer-visible transcript never says "Sam here" or reintroduces a new agent.
  - Orders agent continues naturally as Alex.
  - Empathy is not repeated unless the user adds a new emotional signal.
  - Tools available to Orders are scoped to Orders, not Reception.
- **Auth Context**: Public/customer session scoped to tenant/project/channel identity.
- **Isolation Check**: Studio debug user from another project cannot view session transcript.

### E2E-3: Visible HANDOFF intentionally changes ownership

- **Preconditions**:
  - Generated project includes HumanEscalation relationship mode `visible_handoff`.
- **Steps**:
  1. Start session and trigger abuse/sentiment escalation.
  2. Supervisor sends a short visible transfer line.
  3. HumanEscalation agent responds with its configured visible ownership.
- **Expected Result**:
  - Transcript contains an intentional transfer line.
  - Trace records HANDOFF with mode `visible_handoff`.
  - No shared-voice continuity rule suppresses the escalation identity.
- **Auth Context**: Tenant A, Project X.
- **Isolation Check**: Cross-tenant trace fetch returns 404.

### E2E-4: Silent DELEGATE returns structured state without customer-visible child output

- **Preconditions**:
  - Parent agent has a policy advisory child configured with `silent_delegate`.
  - Child may produce internal RESPOND-like text during reasoning.
- **Steps**:
  1. Start session and ask a policy eligibility question.
  2. Parent invokes DELEGATE with structured payload.
  3. Child completes with structured recommendation.
  4. Parent responds to customer using the result.
- **Expected Result**:
  - Customer transcript contains only parent messages.
  - Trace shows child execution and state return.
  - Parent context receives structured result fields.
  - Consent gate is not invoked for DELEGATE itself.
- **Auth Context**: Tenant A, Project X.
- **Isolation Check**: Child trace is visible only to authorized project users.

### E2E-5: Consent-aware write action skips redundant prompt after specific consent

- **Preconditions**:
  - Orders agent has `create_replacement`, `issue_refund`, and `apply_goodwill_credit`.
  - `create_replacement` and `issue_refund` require conversation consent scoped by `order_id` and action.
- **Steps**:
  1. Customer asks for delayed order help.
  2. Agent offers replacement or refund.
  3. Customer says: "Replacement, please."
  4. Agent calls `create_replacement`.
  5. Agent attempts no refund unless separately consented.
- **Expected Result**:
  - No "reply yes to proceed" prompt before replacement.
  - Replacement tool executes for the consented order.
  - Refund tool is not called.
  - Trace records consent detection evidence without leaking private content beyond trace access controls.
- **Auth Context**: Customer channel session plus project operator trace access.
- **Isolation Check**: Cross-tenant user cannot inspect consent evidence.

### E2E-6: Consent-aware write action prompts when consent is missing or mismatched

- **Preconditions**:
  - Same Orders agent and tools as E2E-5.
- **Steps**:
  1. Customer asks "What are my options?"
  2. Agent attempts `issue_refund` without a clear customer choice.
  3. Customer says yes to replacement, then agent attempts refund.
- **Expected Result**:
  - Runtime blocks or prompts before the unconsented refund.
  - Confirmation prompt is channel-appropriate and specific to the refund action.
  - Replacement consent does not authorize refund.
- **Auth Context**: Tenant A, Project X.
- **Isolation Check**: N/A beyond standard session scoping.

### E2E-7: StaticResponse edit updates public tool-test behavior

- **Preconditions**:
  - Studio and Runtime route stack available with project auth.
  - HTTP tool-test endpoint exists for `get_order`.
- **Steps**:
  1. Fetch tool-test endpoint config through Studio API.
  2. PATCH `staticResponse` to a realistic delayed-order fixture and `sampleInput` to a matching order id/email.
  3. Invoke public tool-test endpoint.
  4. Reload Studio ToolTestPanel.
- **Expected Result**:
  - Public test endpoint returns the edited static response.
  - Studio panel shows edited JSON and sample input.
  - Invalid JSON is rejected with structured 400.
- **Auth Context**: Tenant A, Project X, editor/owner.
- **Isolation Check**: Same tenant Project Y and Tenant B both receive 404 for edit/read.

### E2E-8: Structured runtime diagnostics expose operator hint without leaking raw provider error

- **Preconditions**:
  - Agent configured to trigger a known provider error, such as missing Responses reasoning item or model incompatibility.
- **Steps**:
  1. Start session and send a message that triggers the provider error.
  2. Observe customer channel response.
  3. Fetch trace/diagnostics through Studio API.
- **Expected Result**:
  - Customer sees sanitized channel-appropriate message.
  - Studio trace shows `code`, `operator_hint`, and `trace_id`.
  - Raw provider payload, tenant id, credential hints, and internal remediation text are not serialized to customer channel.
- **Auth Context**: Customer session plus project operator.
- **Isolation Check**: Unauthorized user cannot fetch operator hint.

### E2E-9: Arch-generated VoltMart project passes contract and runtime smoke

- **Preconditions**:
  - Arch project generation runs from VoltMart SOP/source docs.
  - Tool-test fixtures are generated from contract scenario data.
- **Steps**:
  1. Build project through Arch/Studio public flow.
  2. Import/compile generated ABL.
  3. Run a delayed-order chat scenario.
  4. Run a billing classification scenario.
  5. Run a human escalation scenario.
- **Expected Result**:
  - No compiler errors or reasoning-fallback warnings for generated HANDOFF rules.
  - No generic tool signatures.
  - Tool descriptions include when-to-call and when-not-to-call guidance.
  - No canned tool-backed FLOW responses.
  - No duplicate delegation-as-HTTP tools for relationships already represented as HANDOFF or DELEGATE.
  - Specialist context passed from the supervisor does not become customer-facing required GATHER prompts.
  - Welcome text satisfies channel budget.
  - Support agents use non-reasoning defaults unless explicitly marked reasoning.
- **Auth Context**: Tenant A, Project X, project owner.
- **Isolation Check**: Generated project artifacts remain project-scoped.

### E2E-10: http_async emits continuity event before long tool call

- **Preconditions**:
  - http_async channel connection exists.
  - Agent emits text before a long-running tool call.
- **Steps**:
  1. Send customer message through http_async.
  2. Model emits "Pulling that up now..." followed by tool call.
  3. Tool intentionally waits long enough to observe outbound queue behavior.
- **Expected Result**:
  - Customer receives bridge/status event before final answer.
  - Final answer still arrives once tool completes.
  - No duplicate assistant messages in history.
- **Auth Context**: Channel session identity.
- **Isolation Check**: Session list for another tenant does not include the http_async session.

## 3. Integration Test Scenarios

### INT-1: OpenAI Responses history builder preserves provider-native adjacency

- **Boundary**: Runtime session history -> OpenAI Responses adapter.
- **Setup**: Synthetic prior assistant turn with reasoning item and function call.
- **Expected Result**: Next request has `previous_response_id` or adjacent reasoning/function-call items.
- **Failure Mode**: Missing reasoning item returns typed diagnostic, not generic fallback.

### INT-1a: Blueprint renderer consumes source-contract consent policy

- **Boundary**: Arch source contract -> Blueprint renderer -> ABL compiler.
- **Setup**: Blueprint tool omits explicit confirmation; source contract declares the tool action, consent mode, scope fields, and fallback.
- **Expected Result**: Rendered ABL includes `confirm`, immutable scope, `consent_required_in`, `consent_scope`, `consent_action`, and `consent_fallback`, and the compiler preserves the confirmation IR.
- **Failure Mode**: Explicit blueprint confirmation still wins over the source contract, so author overrides do not get rewritten during rebuild.

### INT-1b: Blueprint renderer carries source-contract channel declarations into shared-voice profile generation

- **Boundary**: Arch source contract -> managed behavior profile renderer.
- **Setup**: Blueprint topology has a `shared_voice_handoff` edge; source contract declares voice/chat channels even when the Blueprint specification omits them.
- **Expected Result**: Rendered managed profile includes voice and messaging continuity rules, remains parseable ABL, and can be compiled with the generated agent documents.

### INT-2: Non-OpenAI providers are unaffected by provider-native history

- **Boundary**: Runtime history -> Anthropic/Gemini/Bedrock adapters.
- **Setup**: Same multi-turn tool conversation through non-OpenAI provider adapter.
- **Expected Result**: Existing content blocks remain unchanged.
- **Failure Mode**: Adapter rejects unknown provider item types before outbound request.

### INT-3: Compiler rejects undefined dotted HANDOFF symbols

- **Boundary**: Core parser -> compiler IR validation.
- **Setup**: ABL with `WHEN: routing_intent != null AND intent.category == "orders"` but no `intent` producer.
- **Expected Result**: Structured validation error with code such as `UNDEFINED_CONDITION_VAR`.
- **Failure Mode**: Warn mode records diagnostic without blocking when configured.

### INT-4: GATHER and ON_RETURN producer/consumer validation

- **Boundary**: Compiler IR validation.
- **Setup**: Required GATHER field never consumed; ON_RETURN maps child key child never produces.
- **Expected Result**: GATHER warning and ON_RETURN error.
- **Failure Mode**: Source location included when parser metadata is available.

### INT-5: Arch contract extraction captures customer-experience relationship modes

- **Boundary**: SourceArchitectureContract extraction -> construct planning.
- **Setup**: SOP text for reception, orders specialist, policy advisory, and human escalation.
- **Expected Result**: Orders relationship is `shared_voice_handoff`, policy relationship is `silent_delegate`, human relationship is `visible_handoff` or `human_escalation`.
- **Failure Mode**: Ambiguous topology emits planning diagnostic requiring user choice.

### INT-6: Construct plan rejects generic tool signatures

- **Boundary**: Contract tools -> ConstructPlan tool emission.
- **Setup**: Tool missing input/output schema.
- **Expected Result**: Quality gate diagnostic instead of `(input: string) -> { result: string }`.
- **Failure Mode**: Legacy mode may warn but still emit fallback only when explicitly enabled.

### INT-7: Shared persona inheritance compiles into child agent instructions

- **Boundary**: Arch contract -> ABL generator.
- **Setup**: Shared perceived persona `Alex`, Orders specialist delta.
- **Expected Result**: Child persona includes continuity rules and no reintroduction instruction.
- **Failure Mode**: Visible handoff intentionally omits shared-voice continuity.

### INT-8: DELEGATE executor suppresses child chunks and returns state

- **Boundary**: Runtime routing/reasoning executor -> child thread.
- **Setup**: Child emits chunks and final state.
- **Expected Result**: `onChunk` not called for child output; parent receives mapped state.
- **Failure Mode**: Child error becomes structured delegate error in parent context.

### INT-9: Consent classifier scopes consent to tool and immutable fields

- **Boundary**: Tool confirmation service -> consent classifier.
- **Setup**: Conversation says "replacement, please" for order A.
- **Expected Result**: Replacement for order A allowed; refund or order B blocked/prompted.
- **Failure Mode**: Ambiguous consent falls back to explicit prompt.

### INT-9a: Arch-generated side-effecting tools carry consent policy through ABL

- **Boundary**: Arch blueprint/skeleton renderer -> core parser -> compiler IR.
- **Setup**: Generated support tool such as `issue_refund(order_id, refund_amount)`.
- **Expected Result**: Rendered ABL includes `side_effects: true`, `confirm: when_side_effects`, `immutable`, `consent_required_in: conversation`, scoped consent fields, action label, and fallback; compiled IR preserves all fields.
- **Failure Mode**: Read-only tools do not get marked side-effecting, and explicit `confirm: never` does not force consent metadata.

### INT-9b: Arch-generated support agents default through model-class policy

- **Boundary**: Arch Blueprint v2 renderer / skeleton generator -> core parser -> compiler IR.
- **Setup**: Generated support, classifier, dispatcher, or ordinary specialist agent with no explicit `model` and no `reasoningRequired` policy.
- **Expected Result**: Rendered ABL includes `EXECUTION` with the configured `fastToolCapable` default; compiled IR preserves that concrete model.
- **Failure Mode**: A contract with explicit `model` keeps that model; a contract with explicit `agentType: "research"`, `agentType: "reasoning"`, or reasoning/research requirement emits the reasoning-capable default instead.

### INT-10: StaticResponse PATCH route updates scoped endpoint

- **Boundary**: Studio API route -> tool-test-endpoint service -> public tool-test route.
- **Setup**: Existing test endpoint in Project X.
- **Expected Result**: PATCH updates persisted endpoint, public route returns new response.
- **Failure Mode**: Cross-project or cross-tenant returns 404.

### INT-11: Structured diagnostics flow from runtime to Studio trace UI

- **Boundary**: Runtime error classifier -> trace store -> Studio route/UI.
- **Setup**: Synthetic provider error classified as `MODEL_API_ERROR`.
- **Expected Result**: Trace carries sanitized envelope and operator hint.
- **Failure Mode**: Raw provider text never appears in customer-visible event.

### INT-12: ProfileContext includes interaction state

- **Boundary**: Runtime profile context assembler -> profile resolver.
- **Setup**: Sentiment score and emotion label in session/turn context.
- **Expected Result**: Profile WHEN can evaluate `interaction.sentiment_score < -0.3`.
- **Failure Mode**: Missing interaction data leaves fields undefined and does not crash profile resolution.

### INT-13: http_async mid-turn bridge preserves history integrity

- **Boundary**: Reasoning executor streaming chunk -> inbound worker -> webhook delivery queue -> session history.
- **Setup**: Subscription opts into `agent.status`; text chunk appears before tool call, then final response.
- **Expected Result**: Customer receives one `agent.status` bridge event before final `agent.response`; canonical assistant history remains structurally valid.
- **Failure Mode**: Missing `agent.status` subscription keeps old final-response-only behavior.

### INT-13a: http_async callback sink receives status before final response

- **Boundary**: Delivery worker -> real HTTP callback consumer.
- **Setup**: Process an `agent.status` delivery job followed by the final `agent.response` job for the same subscription against a local callback sink.
- **Expected Result**: Callback receives two POST bodies in order; the status body preserves continuity metadata and the final response text appears only in the final response body.
- **Failure Mode**: Callback delivery reorders jobs, drops continuity metadata, or duplicates the final answer in the status payload.

### INT-14: Reasoning fallback warning renders in Studio

- **Boundary**: Runtime trace explorer -> Studio trace explorer UI.
- **Setup**: Platform event metadata with `isReasoningFallback: true`, `reasoningFallback: true`, or equivalent routing-source marker.
- **Expected Result**: UI displays warning: rule did not match; possible misconfiguration.
- **Failure Mode**: Missing metadata renders normal trace item.

### INT-15: Lockfile recompute command repairs source hashes

- **Boundary**: CLI command -> project file map -> lockfile/source hash writer.
- **Setup**: Project with stale or null source hashes.
- **Expected Result**: CLI recomputes hashes deterministically and docs describe command.
- **Failure Mode**: Invalid project structure returns structured error and leaves files unchanged.

## 4. Unit Test Scenarios

| ID     | Module                         | Scenario                                                                                                          |
| ------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| UT-1   | `session-llm-client`           | Builds Responses request with previous response linkage.                                                          |
| UT-2   | `tool-adapters`                | Converts provider-native OpenAI reasoning/function-call items without flattening.                                 |
| UT-3   | `validate-field-refs`          | Validates dotted paths root-by-root.                                                                              |
| UT-4   | `construct-plan`               | Emits diagnostics for missing tool schema instead of fallback signature.                                          |
| UT-5   | `construct-plan`               | Does not emit canned FLOW text for tool-backed steps.                                                             |
| UT-6   | `construct-plan`               | Generates tool descriptions from call policy and freshness rules.                                                 |
| UT-7   | `construct-plan`               | Does not generate delegation-as-HTTP tools for real HANDOFF or DELEGATE relationships.                            |
| UT-8   | `source-architecture-contract` | Merges extracted topology with customer-experience modes.                                                         |
| UT-9   | `abl-pipeline`                 | Emits shared-voice HANDOFF and visible HANDOFF differently.                                                       |
| UT-10  | `delegate-executor`            | Suppresses child chunks and returns final state.                                                                  |
| UT-11  | `tool-confirmation`            | Detects scoped consent and prompts only on mismatch.                                                              |
| UT-11a | `agent-based-parser`           | Parses consent-aware confirmation tool properties into the core AST.                                              |
| UT-11b | `compiler`                     | Preserves consent-aware confirmation fields into `ToolDefinition.confirmation`.                                   |
| UT-11c | `blueprint` / `abl-pipeline`   | Emits consent-aware confirmation metadata for generated side-effecting support tools.                             |
| UT-11d | `model-policy`                 | Resolves model class defaults, caller overrides, explicit-model precedence, and contradictory reasoning signals.  |
| UT-11e | `blueprint` / `abl-pipeline`   | Emits configured fast default and reasoning defaults only for explicit reasoning policy.                          |
| UT-11f | `build-prompt-contract`        | Renders BUILD guidance from supplied model defaults instead of freezing package fallback text.                    |
| UT-12  | `classify-llm-error`           | Maps Responses missing-reasoning-item error to sanitized envelope and operator hint.                              |
| UT-13  | `ToolTestPanel`                | Validates JSON editor, save, reset, and sample input states.                                                      |
| UT-14  | `profile-resolver`             | Evaluates interaction-conditioned behavior profile.                                                               |
| UT-15  | `inbound-worker`               | Queues opt-in HTTP Async `agent.status` bridge event before final response.                                       |
| UT-15a | `delivery-worker`              | Posts status then final response to a real callback sink without duplicating final response text.                 |
| UT-16  | Runtime/Studio trace explorer  | Runtime normalizes reasoning fallback markers and Studio renders the warning badge.                               |
| UT-17  | CLI lockfile command           | Recomputes hash from source content and refuses malformed projects.                                               |
| UT-18  | `model-registry`               | Exposes provider catalog aliases and filters unsupported hyperparameters.                                         |
| UT-19  | `model-resolution`             | Parses tenant/project/agent hyperparameter bags and strips unsupported provider parameters.                       |
| UT-20  | `HyperParameterForm`           | Renders nested controls and avoids persisting mutually-exclusive radio defaults.                                  |
| UT-21  | `validate-field-refs`          | Warns when required GATHER fields have no known COMPLETE/MEMORY/FLOW/tool/handoff/delegate consumer.              |
| UT-22  | `channel/outcome`              | Builds customer-clean outcomes from sanitized runtime error envelopes and attaches operator diagnostics to trace. |
| UT-23  | `system-agent-process-deps`    | Persists shared-voice managed behavior profiles and identifies stale managed profile keys for cleanup.            |
| UT-24  | `source-architecture-contract` | Extracts welcome shape, channel rules, consent policies, fixtures, and provider-neutral model-policy intent.      |
| UT-25  | `slack-adapter`                | Returns sanitized delivery diagnostics for Slack config, metadata, provider, and network failures.                |
| UT-26  | Web SDK React chat             | Renders transient status messages outside message history and clears them on final assistant response.            |
| UT-27  | `validate-field-refs`          | Warns when explicit non-condition consumers reference variables with no known producer.                           |
| UT-28  | `model-resolution`             | Filters dynamic parameters by registry or provider-level supported parameter classes for unknown model IDs.       |

## 5. Security And Isolation Tests

- Cross-tenant session and trace fetch returns 404.
- Cross-project tool-test endpoint edit returns 404.
- StaticResponse edit requires project tool edit permission.
- Runtime operator hints are visible only through authenticated project-scoped Studio surfaces.
- Customer-visible runtime errors do not include tenant IDs, model IDs, provider raw payloads, credential names, or internal remediation text.
- Consent evidence stored in traces is scoped and redacted where needed.
- DELEGATE child traces cannot be fetched outside the parent project.
- Project import validation does not leak whether another tenant has an agent/tool with a referenced name.

## 6. Performance And Load Tests

- Responses history strategy does not grow request payload unbounded; `previous_response_id` path is preferred for long conversations.
- Consent classifier adds bounded latency and times out to explicit prompt.
- http_async bridge/status events do not create unbounded queue growth during long tool calls.
- Compiler validation runs within acceptable import/build latency for large generated projects.
- StaticResponse JSON editor enforces payload size limits before persistence.

## 7. Test Infrastructure

| Area                 | Requirement                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Runtime E2E          | Real Express server on random port, real auth middleware, project/tenant scoped APIs.                               |
| Studio E2E           | Real Studio route handlers or Playwright for UI slices that need browser proof.                                     |
| LLM provider fixture | External provider boundary only; do not mock runtime/compiler code.                                                 |
| Tool fixtures        | Use tool-test endpoint APIs and staticResponse editor, no direct DB writes in E2E.                                  |
| Arch generation      | Use public Arch/Studio generation path where possible; package-level contract tests cover pure extraction/planning. |
| Trace assertions     | Fetch through public project/session/trace APIs.                                                                    |

## 8. Test File Mapping

| Test File                                                                             | Type             | Covers                       | Status  |
| ------------------------------------------------------------------------------------- | ---------------- | ---------------------------- | ------- |
| `packages/llm/src/__tests__/tool-adapters.test.ts`                                    | Unit             | FR-1                         | Done    |
| `apps/runtime/src/__tests__/sessions/session-llm-client-timeout.test.ts`              | Unit             | FR-1                         | Done    |
| `packages/compiler/src/__tests__/validate-field-refs.test.ts`                         | Unit             | FR-7                         | Partial |
| `packages/compiler/src/__tests__/validate-field-refs-tool-returns.test.ts`            | Unit             | FR-7                         | Partial |
| `packages/arch-ai/src/__tests__/blueprint/source-architecture-contract.test.ts`       | Unit             | FR-2, FR-8                   | Partial |
| `packages/arch-ai/src/__tests__/planning/construct-plan.test.ts`                      | Unit             | FR-2, FR-8, FR-9             | Partial |
| `packages/core/src/__tests__/agent-based-parser.test.ts`                              | Unit             | FR-4                         | Done    |
| `packages/compiler/src/__tests__/ir/compiler-auth-profile.test.ts`                    | Unit             | FR-4                         | Done    |
| `packages/arch-ai/src/__tests__/blueprint/v2-renderer.test.ts`                        | Unit             | FR-4, FR-8, FR-9             | Partial |
| `packages/arch-ai/src/__tests__/generation/abl-pipeline.test.ts`                      | Unit             | FR-2, FR-4, FR-8, FR-9       | Partial |
| `packages/arch-ai/src/__tests__/model-policy.test.ts`                                 | Unit             | FR-9                         | Partial |
| `packages/arch-ai/src/__tests__/build-prompt-contract.test.ts`                        | Unit             | FR-8, FR-9                   | Partial |
| `apps/studio/src/__tests__/arch-ai/scaffold-generation.test.ts`                       | Unit/Integration | FR-2, FR-8, FR-9             | Partial |
| `apps/runtime/src/__tests__/routing/routing-executor-unit.test.ts`                    | Unit/Integration | FR-2, FR-3                   | Partial |
| `apps/runtime/src/__tests__/routing/routing-delegate-failures.test.ts`                | Integration      | FR-3                         | Partial |
| `apps/runtime/src/__tests__/tools-deployment/tool-confirmation.test.ts`               | Unit             | FR-4                         | Partial |
| `apps/runtime/src/__tests__/tools-deployment/tool-confirmation-gate.test.ts`          | Unit             | FR-4                         | Done    |
| `apps/runtime/src/__tests__/classify-llm-error.test.ts`                               | Unit             | FR-6                         | Partial |
| `apps/runtime/src/services/channel/__tests__/outcome.test.ts`                         | Unit             | FR-6                         | Partial |
| `apps/runtime/src/channels/adapters/__tests__/slack-delivery-diagnostics.test.ts`     | Unit             | FR-6                         | Partial |
| `apps/runtime/src/channels/adapters/__tests__/messenger-delivery-diagnostics.test.ts` | Unit             | FR-6                         | Partial |
| `apps/studio/src/__tests__/api-routes/public-tool-test-api.test.ts`                   | Unit/Route       | FR-5                         | Done    |
| `apps/studio/src/__tests__/components/topology-canvas-experience-mode.test.tsx`       | Component        | FR-8                         | Partial |
| `apps/studio/src/__tests__/components/tool-test-panel.test.tsx`                       | Component        | FR-5                         | Partial |
| `apps/studio/src/__tests__/components/tool-testing-section.test.tsx`                  | Component        | FR-5                         | Partial |
| `apps/runtime/src/__tests__/profile-resolver.test.ts`                                 | Unit             | FR-10                        | Done    |
| `apps/runtime/src/__tests__/channels/channel-behavior-contract.test.ts`               | Unit             | FR-11                        | Partial |
| `apps/runtime/src/__tests__/channels/http-async-bridge.e2e.test.ts`                   | E2E              | FR-11                        | Planned |
| `apps/studio/src/__tests__/components/status-update-rendering.test.tsx`               | Component        | FR-12                        | Partial |
| `packages/kore-platform-cli/src/__tests__/commands/lockfile.test.ts`                  | Unit/Integration | FR-13                        | Done    |
| `packages/compiler/src/__tests__/llm/model-registry.test.ts`                          | Unit             | FR-14                        | Partial |
| `apps/runtime/src/__tests__/model-catalog.test.ts`                                    | Unit             | FR-14                        | Partial |
| `apps/runtime/src/__tests__/tenant-models.test.ts`                                    | Unit             | FR-14                        | Partial |
| `apps/runtime/src/__tests__/model-resolution-comprehensive.test.ts`                   | Unit             | FR-14                        | Partial |
| `packages/web-sdk/src/__tests__/agent-provider-transport.test.tsx`                    | Component        | FR-11, FR-12                 | Partial |
| `packages/web-sdk/src/__tests__/react-components.test.tsx`                            | Component        | FR-11, FR-12                 | Partial |
| `apps/runtime/src/__tests__/model-hub-overrides.e2e.test.ts`                          | E2E              | FR-14                        | Partial |
| `apps/studio/src/__tests__/components/hyper-parameter-form.test.tsx`                  | Component        | FR-14                        | Partial |
| `apps/studio/src/__tests__/components/model-management.test.tsx`                      | Component        | FR-14                        | Partial |
| `packages/project-io/src/__tests__/core-assembler.test.ts`                            | Unit             | FR-14                        | Partial |
| `packages/project-io/src/__tests__/core-direct-apply.test.ts`                         | Unit             | FR-14                        | Partial |
| `packages/project-io/src/__tests__/entity-schemas.test.ts`                            | Unit             | FR-14                        | Partial |
| `packages/arch-ai/src/__tests__/system-agent-process-deps.test.ts`                    | Unit             | FR-8, FR-9                   | Partial |
| `apps/runtime/src/__tests__/e2e/arch-platform-agent-gap-closure.e2e.test.ts`          | E2E              | FR-1, FR-2, FR-3, FR-4, FR-6 | Planned |
| `apps/studio/e2e/tool-test-fixture-editor.spec.ts`                                    | UI E2E           | FR-5                         | Partial |
| `apps/studio/e2e/arch-platform-agent-gap-closure.spec.ts`                             | UI E2E           | FR-5, FR-8, FR-12            | Planned |

## 9. Open Testing Questions

1. Which provider test fixture should represent OpenAI Responses native reasoning items without calling the real OpenAI API in CI?
2. Should the first DELEGATE E2E cover IR-native DELEGATE only, or also a persisted `agent` project tool if that design is chosen?
3. Which Studio page should own the staticResponse editor: tool detail page only, or Arch-generated tool bootstrap review as well?
4. Should compile-time symbol validation start as blocking in CI or warning-only for generated legacy fixtures?
5. What is the maximum allowed latency for consent classifier before falling back to explicit prompt?

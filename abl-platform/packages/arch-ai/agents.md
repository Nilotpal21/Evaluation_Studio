# packages/arch-ai — Agent Learnings

> Append-only log of learnings from SDLC phases. Read before modifying this package; write after completing work.

## 2026-04-06 — B57 Feature Spec (Quick Actions & Commands)

- **MessageRequestSchema**: Discriminated union on `type` field with 5 variants. Adding a 6th `type: 'command'` variant is the established pattern. File: `src/types/message-request.ts`.
- **Specialist IDs**: ONBOARDING and IN_PROJECT modes have distinct specialist ID sets. See `src/types/constants.ts` lines 12-30. `/ask-*` commands must map to the correct ID per mode.
- **PageContext pattern**: Client-side collection via `buildPageContext()` then attached to request. @mention resolution should follow the same pattern (client-side resolution, server-side injection).
- **Prompt injection point**: System prompts are assembled in `src/prompts/index.ts`. New `## Referenced Entities` section must go AFTER `## Current Context`.
- **Phase-gated tools**: `PHASE_TOOL_MAP` in `src/types/tools.ts` establishes the pattern of filtering capabilities by phase. Slash command `when` predicates should follow this pattern.

## 2026-04-16 — ABLP-162 Agent Architecture Planner (IMPLEMENTED)

- **Pure planning module** at `src/planning/` — `types.ts`, `topology-analyzer.ts`, `agent-architecture-planner.ts`, `index.ts`. Zero I/O, zero classes, zero external deps. Pattern to emulate for any pre-generation deterministic logic.
- **Test co-location exception**: planner tests live at `src/__tests__/` (`agent-architecture-planner.test.ts`, `topology-analyzer.test.ts`), NOT alongside the module. Match this pattern when extending.
- **Topology input contract**: consumers pass edge types as `string | undefined` from session metadata; the planner uses a strict `'delegate' | 'escalate' | 'transfer'` union. A `coerceEdgeType()` helper in `apps/studio/src/lib/arch-ai/build-parallel-gen.ts` defaults unknown types to `'delegate'`. Re-use this helper on any new ingress path.
- **Backward compatibility rule**: the `plan?` field is OPTIONAL in `AgentGenerationContext`. Old ad-hoc prompt sections (Return-Path Contract, Entry-Point Routing, Routing Contract) remain present and are only guarded when `context.plan` is defined. Do not drop the non-plan code paths without data showing they are unreachable.
- **Cost budget**: plan section renders ~500 tokens; removing 3 old sections saves ~800 — net ~300 token savings per worker prompt.
- **Testing gap (follow-up)**: handbook-reference.test.ts does not yet cover plan rendering (FR-10/11/12). Add when touching the planner integration next.

## 2026-04-19 — Coordination contract follow-up (knowledge-card syntax drift)

- **Learning**: Architecture knowledge cards that teach ABL snippets need the same canonical-contract discipline as public docs. Once the platform default moved to `history: auto`, leaving `grant_memory` or `summary_only`-as-default in knowledge cards would train future prompt generation and architecture guidance against stale coordination semantics.
- **Files**: `src/knowledge/cards/multi-supervisor.ts`, `src/knowledge/cards/cross-agent-validation.ts`
- **Impact**: Future ABL contract shifts should update architecture-card snippets in the same slice as the runtime/docs change, otherwise generated design guidance will keep reintroducing deprecated authoring patterns.

## 2026-04-19 — Coordination contract follow-up (golden corpus coupling)

- **Learning**: Arch-AI golden-corpus expectations are coupled to the exact user-facing terminology in the knowledge cards, not just the underlying concept. When a card intentionally moves from a compatibility term like `grant_memory` to the canonical `memory_grants`, the matching `requiredKnowledge` strings in `src/__tests__/golden-corpus/scenarios.ts` must be updated in the same slice or `test:fast` will fail even though the knowledge content is now more correct.
- **Files**: `src/__tests__/golden-corpus/scenarios.ts`, `src/knowledge/cards/multi-supervisor.ts`
- **Impact**: Any future wording migration in knowledge cards should include a quick `rg` over the golden corpus for the old term before relying on the package test sweep.

## 2026-04-19 — Phase 8 contract-backed knowledge (direct compiler facts)

- **Learning**: The safest way to keep Arch-AI knowledge cards aligned with ABL is to import compiler-owned contract facts directly into the card source, then let curated prose wrap those facts. Purely hand-copied syntax blocks are too easy to drift, especially around coordination shorthand and memory scope naming.
- **Files**: `src/knowledge/contract-facts.ts`, `src/knowledge/cards/multi-supervisor.ts`, `src/knowledge/cards/cross-agent-validation.ts`, `src/knowledge/cards/memory-full.ts`
- **Impact**: Any future high-signal ABL knowledge card should consume compiler contract facts first and only layer narrative guidance on top, so Arch guidance stays coupled to the executable contract instead of static prose snapshots.

## 2026-04-19 — ABL Contract Hardening Phase 10C (contract facts over inline compatibility examples)

- **Learning**: Even tiny inline coordination comments inside knowledge-card snippets can quietly reintroduce stale authoring syntax after the contract moves. The durable pattern is to keep the card anchored on compiler-backed fact inserts and use prose for compatibility caveats instead of sprinkling concrete legacy examples like `history: last_10` into the snippet itself.
- **Files**: `src/knowledge/cards/multi-supervisor.ts`, `src/knowledge/contract-facts.ts`
- **Impact**: Future Arch-AI ABL cards should minimize handwritten syntax in example comments and let compiler-owned facts carry compatibility language wherever possible.

## 2026-04-21 — Trace Diagnosis Tool for Natural-Language Observability

- **Learning**: Relative observability requests should resolve through a high-level `trace_diagnosis` tool, not by forcing the model to pre-normalize dates or session IDs itself. The durable contract is: keep the user's original wording in `query`, let the resolver infer windows like `today`, `two days`, `3 months`, `my last session`, and use lower-level tools like `query_traces` only for raw follow-up exploration.
- **Files**: `src/types/tools.ts`, `src/tools/schemas/in-project-schemas.ts`, `src/prompts/phases/in-project.ts`, `src/prompts/specialists/diagnostician.ts`, `src/prompts/specialists/observer.ts`, `src/prompts/specialists/analyst.ts`
- **Impact**: Future Arch-AI observability or self-healing work should extend the diagnosis resolver/executor contract first so prompts stay simple and natural-language coverage expands without duplicating time/session parsing logic across specialists.

## 2026-04-21 — Prompt structure improves narrow-chat readability

- **Learning**: Arch output quality in Studio improves when prompts teach response shape explicitly, not just task policy. Base and phase prompts should call out narrow-window constraints, prefer short headed sections, compact tables, and fenced code or JSON blocks so blueprint explanations and in-project findings stay readable in the slider UI.
- **Files**: `src/prompts/base.ts`, `src/prompts/phases/blueprint.ts`, `src/prompts/phases/in-project.ts`
- **Impact**: Future Arch UX/readability work should usually pair renderer changes with prompt-side formatting guidance instead of treating presentation as a frontend-only concern.

## 2026-04-21 — Environment observability needs structured tool fields, not prompt-only phrasing

- **Learning**: Once Arch needs to answer “production only”, “staging vs prod”, or “across environments”, the capability should graduate from examples in prompts to explicit tool-schema fields. `trace_diagnosis` now has structured `environment`, `compareWithEnvironment`, and `groupByEnvironment` inputs, while prompts only teach when to use those fields and keep the user’s natural wording in `query`.
- **Files**: `src/tools/schemas/in-project-schemas.ts`, `src/prompts/phases/in-project.ts`, `src/prompts/specialists/diagnostician.ts`, `src/prompts/specialists/observer.ts`, `src/prompts/specialists/analyst.ts`, `src/knowledge/cards/diagnostics-workflow.ts`
- **Impact**: Future observability/self-healing features should add real schema surface area first, then update specialist guidance to route into it, instead of multiplying fragile prompt heuristics across roles.

## 2026-04-28 — Analytics and session page context are production-optimization surfaces

- **Learning**: Studio Analytics, dashboard, agent performance, quality monitor, voice analytics, customer insights, and Sessions page contexts should tell Arch they are production-agent optimization surfaces. The durable signal is capability-based (`production_agent_optimization`, `containment_optimization`, `quality_improvement`, `trace_step_analysis`, `flow_pattern_analysis`, `agent_goal_review`) plus concise summary fields, with Analytics active-tab state read from persisted filters because the tab is not represented in the route. Session detail is an automatic current-session target; list-style Sessions/Analytics pages should clarify all visible/filtered sessions vs a focused sample vs a specific ID, especially if an Arch proposal/action is pending.
- **Files**: `apps/studio/src/lib/arch-ai/page-context-registry.ts`, `apps/studio/src/lib/arch-ai/build-page-context.ts`, `src/prompts/index.ts`, `src/prompts/specialists/diagnostician.ts`, `src/prompts/specialists/analyst.ts`
- **Impact**: Future analytics/session context work should preserve this framing so vague asks like “improve this” are grounded in containment, escalation handling, quality, reliability, chronological trace evidence, agent GOAL/FLOW-step review, and modification rationale instead of generic page awareness.

## 2026-04-29 — Health Cleanup Return Contract Safety

- **Learning**: G-09 unused-GATHER diagnostics must account for incoming `RETURN: true` handoffs. A child field can be a valid return payload through the default same-name merge or `ON_RETURN.map`, even if it is not referenced locally. For return targets, diagnostic guidance should prefer wiring/replacing fields while preserving `COMPLETE`, not deleting GATHER/MEMORY/COMPLETE to chase health-score cleanup.
- **Files**: `src/diagnostics/semantic-validators.ts`, `src/prompts/specialists/diagnostician.ts`, `src/prompts/specialists/abl-construct-expert.ts`, `src/prompts/specialists/in-project-generalist.ts`, `src/prompts/phases/in-project.ts`, `src/knowledge/platform-limits.ts`
- **Impact**: Future health-check/proposal work should inspect full topology and return contracts before recommending cleanup. In-project prompt composition uses the generalist prompt plus knowledge cards, so critical cleanup rules belong there and in always-loaded L0 knowledge, not only in specialist prompts. Removing a warning must not introduce CO-04 or other cross-agent semantic errors.

---

### 2026-05-06 — A2A Spec 1 (ABLP-162): External-Agent Adaptiveness Layer

**Category**: knowledge / coordinator / engine

**Learning 1 — `routeByContent` returns structured `RoutingDecision`, not bare specialist id.**
The signature was widened to `RoutingDecision { specialist, matchedPattern, pageContextBias? }` so the pattern-source string survives the 4-layer plumbing (router → coordinator-bridge → turn-engine → studio call sites). This is what enables OTel head-sampling on routing decisions. Callers must read `decision.specialist`, not the legacy bare-id return. New rules added at the TOP of the integration-methodologist patterns block — order matters because the diagnostician/multi-agent-architect rules below have very broad regexes (`\bdebug\b`, `\bdelegate\b`, `\b(failing|broken|...)\b`) that would otherwise capture remote-agent intents.

**Files**: `src/coordinator/content-router.ts`, `src/engine/coordinator-bridge.ts` (`TurnPlan.routing`), `src/engine/turn-engine.ts` (`RunTurnInput.routing` + emit at `runTurn()`), `src/engine/trace/event-names.ts` (`EVENT_ROUTING_DECISION`).

**Impact**: Future routing extensions should add patterns to the existing rule's `patterns: []` array, not invent a new rule. New trace-event emission belongs at `turn-engine.ts runTurn()` after `TurnTraceRecorder` construction — NOT inside `routeByContent` (which is now pure data) or `resolveTurnPlan` (which doesn't have access to the recorder).

**Learning 2 — L2 cards are auto-generated from MDX; never hand-edit `cards/generated/*.ts`.**
Adding a new L2 card requires four coordinated edits:

1. Add MDX H2 sections to `apps/docs-internal/content/abl-reference/<source>.mdx` (mirror to `apps/studio/content/...` per `phase6-doc-alignment.test.ts`)
2. Append `CARD_MAPPINGS` entry in `tools/abl-docs/card-mapping.ts` with `sections: [...]` and `maxTokens`
3. Append `CARD_FILE_COVERAGE` entry in `src/knowledge/cards/_mapping.ts` (prevents L3 BM25 from injecting duplicate chunks)
4. Run `pnpm abl:docs:generate` and register the resulting `EXTERNAL_AGENTS_CARD` constant in `src/knowledge/card-router.ts` with trigger patterns

**Files**: `tools/abl-docs/card-mapping.ts`, `src/knowledge/cards/_mapping.ts`, `src/knowledge/card-router.ts`, `src/knowledge/cards/generated/external-agents.ts`.

**Impact**: A future docs reorg or rename cascades through all 4 places. The generator silently produces zero-byte cards if all source files vanish — consider adding a `parts.length > 0` assertion in `card-generator.ts` (R5 M-3 follow-up).

**Learning 3 — `TurnTraceRecorder` does not expose `setAttribute`.**
The recorder API is `event/startSpan/endSpan/endTrace`. Promoting an attribute to the parent span (e.g. `arch.specialist`) for OTel head-sampling requires extending the recorder contract. Spec 1 emitted the attribute on the inline span event instead; head-sampling on the event is supported but on the parent span is not. Track recorder-contract extension as a separate ticket.

---

### 2026-05-06 — In-Project Integrations v1 (ABLP-162): Knowledge + routing wiring

**Category**: knowledge / coordinator / pageContext

**Learning 1 — IN_PROJECT mode always uses GENERALIST prompt; specialist tool maps gate tools, not prompt content.**
`composeInProjectPrompt` does NOT swap to a specialist prompt when content-router resolves a specialist — `IN_PROJECT_SPECIALIST_TOOL_MAP[specialist]` only restricts the tool surface. To inject domain reasoning context into IN_PROJECT, add **L2 knowledge cards** keyed on regex triggers, not specialist prompt edits. The integration feature shipped 3 L2 cards (`integration-setup-workflow`, `oauth-flow-primer`, `integration-failure-diagnosis`) wired through `card-router.ts` instead of editing the methodologist prompt.

**Files**: `src/knowledge/cards/generated/integration-{setup-workflow,failure-diagnosis}.ts`, `src/knowledge/cards/generated/oauth-flow-primer.ts`, `src/knowledge/card-router.ts`, `src/knowledge/__tests__/*`.

**Impact**: Future IN_PROJECT context expansion should default to L2 cards. Specialist prompts only matter in onboarding / non-IN_PROJECT phases. When adding L2 cards, follow the 4-step generator flow from the 2026-05-06 entry above.

**Learning 2 — Content-router rule ordering: provider regexes must precede broad verb regexes.**
SaaS provider names (`\bslack\b`, `\bgithub\b`, `\bjira\b`, …) and integration verbs (`hook up`, `wire up`, `integrate with`) were added at the top of the integration-methodologist rule. Placed below the diagnostician's `\bfailing\b` pattern they would have been swallowed because failure-diagnosis text often mentions a provider name. Rule order is significant.

**Files**: `src/coordinator/content-router.ts`, `src/coordinator/__tests__/content-router.test.ts`.

**Impact**: Any new integration vocabulary belongs in the existing methodologist rule's `patterns: []`, NOT in a new rule below.

**Learning 3 — `pageContext` extension requires three coordinated edits.**
Adding a new entity type to `pageContext` (here: `integration_draft`) needed:

1. Add to `EntityType` enum in `src/types/page-context.ts`
2. Optional `user` field on `PageContext` (Studio populates `role` + `scopes`)
3. Bias logic in `getPageContextSpecialistBias()` in `src/engine/coordinator-bridge.ts`

Tests live in `src/__tests__/engine/coordinator-bridge-in-project-context.test.ts`.

**Impact**: Without the bridge update the entity type compiles but never affects routing — pure dead code. Always extend the bridge.

**Learning 4 — Studio prompt-injection loaders complement L2 cards but are NOT replacement for them.**
The integration feature added two Studio-side loaders (`projectStateSummaryLoader`, `activeDraftSnapshotLoader` in `apps/studio/src/lib/arch-ai/processors/runtime-support.ts`) that inject _runtime project state_ (5-min cached query of 5 collections) and _active draft snapshot_ into the prompt. These run BEFORE the LLM sees the message; L2 cards run as part of the knowledge layer triggered by user content. They serve different purposes — state injection is for "what exists", L2 cards are for "how to think about it". Don't conflate.

**Files**: (Studio side, listed for cross-reference) `apps/studio/src/lib/arch-ai/processors/runtime-support.ts`.

**Impact**: When adding new context, classify as state (loader) or reasoning (L2 card) before implementing.

## 2026-05-07 — Headless CLI driver (`kore-platform-cli arch *`) — ABLP-162

A surface-agnostic CLI now drives the engine end-to-end without Studio's frontend. Lives in `packages/kore-platform-cli/src/commands/arch.ts` (~600 LOC). Pure HTTP/SSE client over Studio's existing `/api/arch-ai/*` routes — **no engine or Studio orchestration changes**.

- **Why this is forward-compatible**: CLI is coupled to contracts (`MessageRequestSchema`, `ArchSSEEvent` discriminated union, `/api/arch-ai/*` route shapes), not implementation. New tools/specialists/phases/prompts/models surface in the CLI for free. Only contract changes touch the CLI, and those break loud at TypeScript build time.
- **Renderer entry point**: switch on `event.type` in `renderEvent()`. New SSE event types fall through to `ARCH_VERBOSE=1` JSON dump — non-blocking, but worth adding a renderer when stable.
- **Studio orchestration is NOT in this package**: `apps/studio/src/lib/arch-ai/processors/process-message.ts` (~2,879 LOC) is the real LLM orchestrator using Vercel AI SDK `streamText`. The engine's `executeSpecialistTurn` (`src/executor/specialist-executor.ts`) is the contract-driven path but is NOT what production uses for ONBOARDING/IN_PROJECT chat. CLI tests the production path because it goes through Studio routes.
- **Backlog**: see `docs/todo/cli-driver/README.md` for Phase 2 (shared client extraction), Phase 3 (headless server), and the SSE header fix.
- **Docs**: `packages/kore-platform-cli/README.md` has end-to-end workflows (ONBOARDING create, IN_PROJECT modify, battle-test, checkpoint exploration) intended to onboard both humans and LLM tools driving the CLI.

## 2026-05-14 — Project Feature Capability Audit

**Category**: knowledge / audit / feature-inventory

**Learning**: Arch AI feature capability needs a feature-level catalog, not only a tool-level audit. Page context, tool registration, specialist maps, knowledge-card mappings, product feature docs, and test guides each describe a different slice of the same capability surface, so drift is easy: a feature can have page context but no executable tool, or knowledge cards can teach an unavailable tool. The current concrete drift example is channel guidance mentioning `channel_ops` while executable channel support lives under `deployment_ops` and `platform_context`.

**Files**: `docs/wip/2026-05-14-project-feature-capability-audit.md`, `apps/studio/src/lib/arch-ai/page-context-registry.ts`, `apps/studio/src/lib/arch-ai/tools/in-project-tools.ts`, `src/types/tools.ts`, `src/knowledge/cards/_mapping.ts`.

**Impact**: Future Arch feature work should update a generated or test-backed feature capability catalog that joins page capability tags, executable tools/actions, knowledge cards, and test docs. For every project feature, explicitly classify support as full, strong, partial, context-only, or gap so read-only awareness is not mistaken for action coverage.

## 2026-05-16 — Generated write tools need consent contracts

**Category**: generation pattern
**Learning**: Arch-generated side-effecting support tools must emit both confirmation policy and conversation-consent metadata. The generator now infers common write tools (`create_*`, `issue_refund`, `apply_credit`, `book_*`, `send_*`, etc.), marks them `side_effects: true`, emits `confirm: when_side_effects`, locks scoped identifier/amount fields with `immutable`, and adds `consent_required_in: conversation` plus `consent_action`/`consent_fallback`.
**Files**: `src/blueprint/renderer.ts`, `src/blueprint/v2-schema.ts`, `src/generation/abl-pipeline.ts`, `src/prompts/phases/build.ts`, `src/__tests__/blueprint/v2-renderer.test.ts`, `src/__tests__/generation/abl-pipeline.test.ts`
**Impact**: Future Arch contract work should prefer explicit `sideEffects` and `confirmation` fields in the intermediate contract, with inference as a fallback only. Keep read-only prefixes (`get`, `lookup`, `search`, `fetch`, etc.) from being marked side-effecting just because their descriptions mention downstream actions.

## 2026-05-16 — Generated support agents default to fast non-reasoning models

**Category**: generation pattern
**Learning**: Arch owns generated ABL configuration, while runtime owns execution. For generated support, classifier, dispatcher, scripted, and ordinary specialist agents, Arch should emit an explicit `EXECUTION` model from the configured fast tool-capable policy default instead of relying on platform defaults. Reasoning models remain opt-in through `modelPolicy.agentType: "research" | "reasoning"`, `modelPolicy.reasoningRequired`, a reasoning/research `defaultModelClass`, or an explicit `agent.model`.
**Files**: `src/blueprint/renderer.ts`, `src/blueprint/v2-schema.ts`, `src/generation/abl-pipeline.ts`, `src/prompts/phases/build.ts`, `src/__tests__/blueprint/v2-renderer.test.ts`, `src/__tests__/generation/abl-pipeline.test.ts`
**Impact**: Future contract extraction should set `reasoningRequired` only from explicit source evidence such as research, open-ended policy synthesis, or deep planning needs. Do not infer reasoning from "specialist" or "support" alone; those should stay on the fast tool-capable path.

## 2026-05-16 — Model defaults are policy, not renderer constants

**Category**: generation pattern
**Learning**: Concrete model IDs must not live in Blueprint renderer or skeleton-generation control flow. Use `resolveArchExecutionModel()` from `src/model-policy.ts`, pass model defaults through blueprint `modelDefaults` or render/skeleton options, and let explicit `agent.model` win. Package defaults are last-resort fallbacks, not the authoring contract.
**Files**: `src/model-policy.ts`, `src/blueprint/renderer.ts`, `src/blueprint/v2-schema.ts`, `src/generation/abl-pipeline.ts`, `src/prompts/phases/build.ts`, `src/__tests__/model-policy.test.ts`, `src/__tests__/blueprint/v2-renderer.test.ts`, `src/__tests__/generation/abl-pipeline.test.ts`
**Impact**: Future model changes should update policy defaults or pass tenant/project defaults into rendering. Do not add new provider-specific model literals to renderers, skeleton builders, or prompt examples.

## 2026-05-16 — Reasoning-required beats model-class hints

**Category**: generation pattern
**Learning**: `modelPolicy.reasoningRequired` is the strongest model-selection signal. It must not be overridden by `defaultModelClass: "fast_tool_capable"`, because that reopens the exact class of support-flow failures this policy was meant to avoid. Prompt guidance must also be rendered through `renderBuildPhasePrompt({ modelDefaults })` wherever a caller has tenant/project model defaults; otherwise the prompt can drift from renderer policy.
**Files**: `src/model-policy.ts`, `src/prompts/phases/build.ts`, `src/prompts/index.ts`, `src/__tests__/model-policy.test.ts`, `src/__tests__/build-prompt-contract.test.ts`
**Impact**: When adding new model classes or provider defaults, test both resolver behavior and prompt rendering. Treat blank override strings as unset so partial tenant/project configuration cannot emit invalid `EXECUTION` blocks.

## 2026-05-17 — Model-policy defaults are capability-gated

**Category**: generation pattern
**Learning**: Arch model-default selection now lives in `src/model-policy.ts` and accepts project/tenant catalog candidates. Fast tool-capable defaults filter out reasoning-capable families, while reasoning/research defaults are selected only from explicit reasoning-capable candidates or explicit policy opt-in. `@agent-platform/arch-ai/model-policy` is the narrow package export for Studio bootstrap code; importing the package root can load unrelated Arch generation modules in unit tests.
**Files**: `src/model-policy.ts`, `src/__tests__/model-policy.test.ts`, `package.json`, cross-reference `apps/studio/src/lib/arch-ai/model-policy-defaults.ts`
**Impact**: Future model-default work should pass live catalog/config candidates into `selectArchModelPolicyDefaults()` instead of duplicating tier sorting in Studio or renderers. Keep support/classifier/dispatcher assertions capability-based rather than pinned to a literal model ID.

## 2026-05-17 — Arch error messages are builder-facing diagnostics

**Category**: user-facing diagnostics
**Learning**: `src/engine/error-classifier.ts` feeds `classified.message` into Arch live error events and durable `turn_ended` payloads. The reader is an agent builder/operator, not the end customer, so Arch should preserve technical cause language such as model provider rate limits, authentication, billing, configuration, and timeout classes. Still sanitize raw secrets, tenant IDs, model IDs, file paths, and credential hints before emitting the message.
**Files**: `src/engine/error-classifier.ts`, `src/__tests__/engine/error-classifier.test.ts`, cross-reference `apps/studio/src/lib/arch-ai/engine-factory.ts`
**Impact**: Future error-classifier changes should add regression expectations for both the code and the sanitized technical message. Do not pass raw model-resolution messages through `MODEL_CONFIG_ERROR`; normalize to an Arch model-settings diagnostic.

## 2026-05-17 — Blueprint topology experience must render into ABL

**Category**: data propagation
**Learning**: Blueprint topology `edge.experienceMode` cannot live only in Arch's JSON state. Generated handoff ABL should emit `EXPERIENCE_MODE` so imported/exported bundles preserve shared/visible/silent topology intent through the normal parser/compiler path. Behavior profiles still carry shared-voice instructions; `EXPERIENCE_MODE` carries the topology contract.
**Files**: `src/blueprint/renderer.ts`, `src/__tests__/blueprint/v2-renderer.test.ts`
**Impact**: Future topology contract fields should be rendered into ABL when they affect runtime/Studio semantics. Do not rely solely on Arch-side blueprint metadata if the project can later be imported, edited, or compiled outside the Arch generation path.

## 2026-05-17 — Topology fallbacks must carry model-policy hints

**Category**: generation pattern
**Learning**: The v2 blueprint renderer can consume `modelPolicy`, but deterministic `TopologyOutput` fallbacks and system-agent builds are still active generation paths. They must carry provider-neutral `modelPolicy` hints through `TopologyAgent` into `buildSkeleton()` so fallback agents express fast support defaults and explicit reasoning/research opt-in without embedding concrete model IDs.
**Files**: `src/model-policy.ts`, `src/types/blueprint.ts`, `src/coordinator/topology-synthesis.ts`, `src/blueprint/source-architecture-contract.ts`, `src/system-agent-process-deps.ts`, `src/generation/abl-pipeline.ts`
**Impact**: Future model-policy work should update both the v2 Blueprint contract and the topology-driven fallback contract. Treat `executionMode: "reasoning"` as control-flow behavior, not proof that the agent needs a reasoning model family.

## 2026-05-17 — Source contracts should preserve CX intent before generation

**Category**: data propagation
**Learning**: Uploaded SOP/source contracts now carry customer-experience intent as intermediate data: welcome shape, channel rules, consent policy, scenario fixtures, and provider-neutral `modelPolicy` intent. These fields should be extracted before topology/build generation so later consumers can avoid inventing welcome copy, consent behavior, or concrete model IDs.
**Files**: `src/blueprint/source-architecture-contract.ts`, `src/__tests__/blueprint/source-architecture-contract.test.ts`
**Impact**: Future project-generation work should consume these source-contract fields into behavior profiles, construct planning, and tool-test fixture generation. Keep `reasoningRequired` tied to explicit source evidence such as policy synthesis, research, diagnosis, or advisory analysis.

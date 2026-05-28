# Feature: Gather Interrupt Semantic Routing

**Doc Type**: SUB-FEATURE
**Parent Feature**: [NLU / Intent Classification & Entity Extraction](../nlu.md) / [Multi-Agent Orchestration](../multi-agent-orchestration.md)
**Status**: ALPHA
**Feature Area(s)**: `agent lifecycle`, `customer experience`, `observability`, `governance`
**Package(s)**: `apps/runtime`, `packages/compiler`, `packages/core`, `apps/nlu-sidecar`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/sub-features/gather-interrupt-semantic-routing.md](../../testing/sub-features/gather-interrupt-semantic-routing.md)
**Last Updated**: 2026-04-23

---

## 1. Introduction / Overview

### Problem Statement

`GATHER` steps currently own the active turn until the runtime detects that the user has changed intent. That interrupt routing is critical in customer-facing flows such as authentication, verification, and data collection, because users often switch from the current gather question to a different request mid-flow.

Before the current mitigation, the lexical fallback contract in `packages/compiler/src/platform/constructs/utils.ts` only matched exact word boundaries. That preserved precision, but it caused a visible failure mode when the semantic classifier was unavailable or skipped: straightforward inflectional variants of a declared interrupt keyword were treated as regular gather input instead of as an interrupt. The result was a re-prompt loop inside the child flow rather than a return to the parent supervisor.

The immediate issue is now mitigated in code by keeping the global exact matcher intact and adding a gather-only normalized lexical path. The broader architecture gap remains: semantic interrupt routing still depends on the pipeline LLM path when available, while the existing NLU sidecar and compiler-side embedding infrastructure are not yet the active semantic-routing system for gather interrupts.

### Goal Statement

Provide a future-ready interrupt-routing contract for `GATHER` steps that preserves exact deterministic matching where it is valuable, reliably detects common lexical variation during gather interrupts, exposes explicit fallback policy for supervisor reroutes, and evolves toward a dedicated semantic-routing path that is less dependent on the main LLM pipeline.

### Summary

Gather Interrupt Semantic Routing covers three closely related execution paths in `apps/runtime/src/services/execution/flow-step-executor.ts`:

1. **Step digressions** detected during `GATHER` via `DIGRESSIONS`
2. **Step sub-intents** detected during `GATHER` via `SUB_INTENTS`
3. **Child-to-parent supervisor reroutes** when a child flow is waiting for gather input but the user has changed intent

The current implementation now provides:

- classifier-first handling for flow escape candidates when the pipeline path is available
- deterministic normalized lexical fallback for gather interrupts without loosening `detectIntent()` globally
- supervisor authoring control via `INTENTS: LEXICAL_FALLBACK: never | when_unavailable | always`
- trace payloads that distinguish `detectionMode` and `lexicalMatchType`

The next phase of the feature is to move semantic gather routing closer to a dedicated NLU path by compiling richer candidate surfaces and adding a finite-candidate semantic ranking lane in the sidecar, with the main LLM pipeline used only when needed.

---

## 2. Scope

### Goals

- Detect user intent changes during `GATHER` steps across digressions, sub-intents, and parent-supervisor reroutes.
- Preserve the exact global `detectIntent()` contract while allowing gather-specific deterministic normalization.
- Keep semantic classifier results authoritative when they explicitly reject a reroute, unless policy explicitly allows lexical rescue.
- Give supervisor authors explicit control over lexical rescue behavior through `INTENTS: LEXICAL_FALLBACK`.
- Emit traces that explain which interrupt detector won and why.
- Define the future semantic-routing architecture that moves gather interrupts toward a dedicated sidecar or embedding-backed path instead of relying only on the main pipeline LLM.

### Non-Goals (Out of Scope)

- Replacing all runtime routing with embeddings or a sidecar in this slice.
- Loosening `detectIntent()` globally for every existing caller.
- Shipping a production semantic sidecar model in the current mitigation slice.
- Replacing open-ended reasoning or final response generation with the sidecar.
- Treating inferred category descriptions as the long-term lexical contract.

---

## 3. User Stories

1. As an **end user**, I want the assistant to recognize that I changed my mind during a gather step so I do not get trapped in repeated authentication or data-collection prompts.
2. As a **supervisor author**, I want to decide whether lexical rescue is allowed when semantic routing is unavailable so I can choose between strict semantic routing and resilience to classifier outages.
3. As a **runtime engineer**, I want interrupt routing to be deterministic and observable so I can debug why a turn stayed in the child flow or returned to the parent supervisor.
4. As a **platform architect**, I want a path from exact lexical routing to finite-candidate semantic routing that does not require the main reasoning LLM to be healthy on every turn.

---

## 4. Functional Requirements

1. **FR-1**: The system must detect `DIGRESSIONS` and `SUB_INTENTS` during `GATHER` using a classifier-first contract when the pipeline classifier is available and actionable.
2. **FR-2**: The system must preserve the active gather step when the flow-escape classifier runs and does not produce a matching candidate, rather than rescuing that turn lexically by default.
3. **FR-3**: The system must support deterministic lexical fallback for gather interrupts when the semantic classifier is unavailable or skipped.
4. **FR-4**: Deterministic lexical fallback for gather interrupts must support normalized matching for common inflectional variants without changing the exact matching semantics of the shared `detectIntent()` helper.
5. **FR-5**: Parent-supervisor reroutes from a child gather step must continue to resolve their final target through the existing supervisor routing rules, not through direct keyword-to-agent shortcuts.
6. **FR-6**: Supervisor authors must be able to configure `INTENTS: LEXICAL_FALLBACK: never | when_unavailable | always`, and that setting must survive parser and compiler lowering into runtime IR.
7. **FR-7**: Trace events for digressions, sub-intents, and parent reroutes must include the detection mode and, when lexical fallback wins, the lexical match type.
8. **FR-8**: The system must continue to reroute gather interrupts deterministically when no pipeline model is configured, the pipeline is disabled, or the pipeline classifier is otherwise unavailable.
9. **FR-9**: The future semantic-routing path must support finite-candidate semantic ranking for gather interrupts without requiring the main reasoning loop to classify every interrupt turn.
10. **FR-10**: The future semantic-routing path must preserve fail-closed behavior by exposing explicit policy for when lexical fallback or LLM adjudication may override a semantic negative result.
11. **FR-11**: The future semantic-routing path must let tenant policy define allowed semantic service profiles, default profile, and hardware entitlements, while projects may inherit the tenant default or select an allowed profile override.
12. **FR-12**: Semantic service profiles must declare operational characteristics including accuracy target, multilingual coverage, memory footprint, target throughput, target concurrent requests, latency objective, and CPU/GPU support, and runtime selection must validate those characteristics before dispatch.

> FR-1 through FR-8 describe the current shipped contract. FR-9 through FR-12 define the next architecture phase.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                |
| -------------------------- | ------------ | -------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Project runtime config controls pipeline and sidecar availability    |
| Agent lifecycle            | PRIMARY      | Gather routing changes which agent or step owns the current turn     |
| Customer experience        | PRIMARY      | Prevents gather dead-ends and improves interrupt handling            |
| Integrations / channels    | SECONDARY    | Same routing contract must hold across chat, SDK, and voice surfaces |
| Observability / tracing    | PRIMARY      | Trace payloads expose detection mode and lexical match type          |
| Governance / controls      | SECONDARY    | `LEXICAL_FALLBACK` is an author-controlled routing policy            |
| Enterprise / compliance    | SECONDARY    | Future sidecar path will interact with plan-gated advanced NLU       |
| Admin / operator workflows | NONE         | No dedicated admin workflow in the current slice                     |

### Related Feature Integration Matrix

| Related Feature                                                   | Relationship Type         | Why It Matters                                                                                                    | Key Touchpoints                                                 | Current State |
| ----------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------- |
| [NLU / Intent Classification & Entity Extraction](../nlu.md)      | parent / child            | Gather interrupts currently use the pipeline classifier and sidecar/NLU roadmap from the umbrella feature         | `services/pipeline/*`, `services/nlu/sidecar-client.ts`         | BETA          |
| [Multi-Agent Orchestration](../multi-agent-orchestration.md)      | shares data with          | Parent-supervisor reroutes depend on thread stack, return-to-parent mechanics, and handoff targeting              | `returnExpected`, `threadStack`, `handleHandoff`                | BETA          |
| [Entity Extraction & Semantic Entities](../entity-extraction.md)  | shares execution boundary | Gather execution already mixes extraction, correction detection, and interrupt detection in the same runtime path | `flow-step-executor.ts`, sidecar client, extraction tiers       | ALPHA         |
| [Tracing & Observability](../tracing-observability.md)            | emits into                | Interrupt routing is debuggable only when traces clearly record semantic vs lexical decisions                     | `digression`, `sub_intent`, `return_to_parent`, pipeline traces | BETA          |
| [ABL Language](../abl-language.md)                                | configured by             | `DIGRESSIONS`, `SUB_INTENTS`, and supervisor `INTENTS` are authored in ABL and lowered into runtime IR            | parser/compiler/IR schema                                       | STABLE        |
| [Localized Interaction Context](localized-interaction-context.md) | future dependency         | Future semantic routing will need locale-aware candidate surfaces and multilingual policy                         | interaction context, sidecar locale input                       | PLANNED       |

---

## 6. Design Considerations (Optional)

There is no dedicated Studio UI for this feature today. Authors consume it indirectly by defining `DIGRESSIONS`, `SUB_INTENTS`, and supervisor `INTENTS` in ABL, while operators influence the semantic path through project runtime config for pipeline and advanced NLU settings.

The current UX requirement is not “make interrupt routing feel more clever.” It is “make interrupt routing predictable, debuggable, and safe.” Precision matters because false interrupts are costly during authentication and regulated flows. That is why the design keeps exact matching available as the shared primitive and scopes normalization to gather interrupts instead of applying it globally.

---

## 7. Technical Considerations (Optional)

### What Is Working Now

- `packages/compiler/src/platform/constructs/utils.ts` keeps `detectIntent()` exact and adds `detectIntentLexically(..., { allowNormalized: true })` for gather-only normalized lexical matching.
- `apps/runtime/src/services/execution/flow-step-executor.ts` uses classifier-first resolution for `detectFlowEscapeMatch()` and `detectParentSupervisorRoute()`.
- `resolveFlowEscapeLexicalMatch()` enables normalized lexical fallback for gather interrupt candidates without changing non-gather callers.
- Parent-supervisor reroutes still resolve the final target through `resolveRouting()`, so the same routing rules and `WHEN` conditions remain authoritative.
- The DSL/parser/compiler path now lowers `INTENTS: LEXICAL_FALLBACK` through `packages/core/src/parser/agent-based-parser.ts`, `packages/core/src/types/agent-based.ts`, `packages/compiler/src/platform/ir/schema.ts`, and `packages/compiler/src/platform/ir/compiler.ts`.
- Traces now expose `detectionMode` and `lexicalMatchType`, which makes the fallback lane visible in runtime debugging.

### Current Limitations

- Semantic gather routing is still LLM-pipeline based when a classifier model is available; embeddings are not yet part of the active gather interrupt path.
- The Python sidecar in `apps/nlu-sidecar/app.py` is still a stub with `/health`, `/extract`, and `/detect-correction`, but no semantic intent-ranking endpoint and no production semantic model wiring.
- Supervisor lexical candidate generation still derives keywords from category names and descriptions in `buildSupervisorCategoryKeywords()`. That is serviceable for fallback, but it is not a strong long-term intent contract.
- The compiler-side NLU engine in `packages/compiler/src/platform/nlu/engine.ts` already supports plugin -> embeddings -> LLM -> fallback sequencing, but `flow-step-executor.ts` does not use it for gather interrupts.
- Repo coverage for this sub-feature now includes dedicated public chat, SDK HTTP, and `voice_vxml` E2E suites for gather-interrupt rerouting. Any additional LiveKit/WebSocket-specific parity is adjacent voice-runtime work rather than a blocker for this slice.
- Current project config uses `advanced_sidecar_url`, which exposes deployment topology directly to tenant/project configuration. That is workable for today’s stub sidecar, but it is too low-level for long-term profile selection, service pooling, and capacity-aware routing.

### Model and Service Selection Criteria

The future semantic routing layer, and the shared service-profile control plane that should later also support `memory-compactor`, should choose models and service profiles using explicit operational criteria, not just benchmark accuracy in isolation.

| Criterion                                   | Why It Matters                                                                                                                     | Selection Implication                                                                                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accuracy / recall on interrupt corpora      | The model must distinguish true intent changes from ordinary gather input and avoid false interrupts in sensitive flows.           | High-recall profiles may be appropriate for routing-heavy assistants; high-precision profiles may be required for authentication and regulated flows. |
| Multilingual support                        | Interrupt routing must work when projects serve multiple locales or when users switch languages mid-session.                       | Profiles must declare supported languages or locale classes, not assume English-only behavior.                                                        |
| Memory footprint                            | Small semantic models may fit on CPU or low-memory nodes, while larger multilingual models may require larger memory reservations. | The control plane should know per-profile memory requirements before assigning workloads to a pool.                                                   |
| Throughput per replica                      | Finite-candidate routing is only useful inline if a profile can sustain enough requests per second under normal load.              | Service pools need target QPS per replica so autoscaling and admission control can be tuned.                                                          |
| Max concurrent in-flight requests           | Saturation usually shows up as queueing and timeout spikes before outright failure.                                                | Profiles should publish safe concurrency envelopes so runtime can avoid overdriving a pool.                                                           |
| P50 / P95 latency                           | Gather interrupts are on the critical path of every user turn, so latency must stay bounded.                                       | Low-latency profiles may be preferred for voice or realtime channels; slower high-recall profiles may fit async or chat-heavy projects.               |
| CPU / GPU support                           | Some embedding encoders run well on CPU, while others only become viable at target latency on GPU.                                 | Tenant or project policy should constrain whether a profile may route to CPU pools, GPU pools, or auto-select.                                        |
| Model load / cold-start time                | Large models can be operationally expensive if they take too long to load or recover after scale-out.                              | Profiles should declare warmup expectations so service pools can pre-warm or keep minimum replicas.                                                   |
| Batching behavior                           | Some models deliver acceptable throughput only with micro-batching, while others are better with one-request-per-call latency.     | The service type should expose whether batching is compatible with interactive gather routing.                                                        |
| Input length / candidate-set size tolerance | Some profiles handle larger candidate sets or longer multilingual examples better than others.                                     | Runtime should match profile choice to the expected number of candidate intents and utterance length.                                                 |
| Operational maturity                        | Health probes, determinism, error rates, and fallback semantics matter as much as model quality.                                   | Profiles should only be tenant/project selectable once they have clear health and recovery characteristics.                                           |

### Additional Compaction-Specific Criteria

The same control plane will eventually need criteria that are specific to conversation-state compaction, not semantic routing alone.

| Criterion                        | Why It Matters                                                                                                 | Selection Implication                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| State-preservation fidelity      | A compactor must preserve user goals, preferences, auth state, and unresolved tasks across the compacted turn. | Favor profiles that retain operational state faithfully, not just produce a readable prose summary.           |
| Token-budget adherence           | Compaction exists to shrink context to a bounded size without losing critical information.                     | Profiles should publish target token-budget behavior and acceptable overflow characteristics.                 |
| Structured-output support        | The runtime should consume compaction as structured memory, not only free-form text.                           | Prefer profiles that can return stable JSON-like structures for facts, tasks, preferences, and carry-forward. |
| Determinism / replay consistency | Recompacting similar conversations should not drift unpredictably, especially in regulated or audited flows.   | Profiles should be benchmarked for low variance and stable output shapes under repeated execution.            |
| Carry-forward precision          | Incorrectly retained or invented facts can damage later turns more than a missing sentence in a user summary.  | Favor profiles with strong factual retention and low hallucination rates in compacted state.                  |
| Compaction latency vs quality    | Compaction is less latency-sensitive than interrupt routing, but it still sits on the conversational hot path. | Projects may choose fast compaction for high-throughput chat or higher-fidelity compaction for longer flows.  |

### Future Vision

The target architecture is:

1. **Exact deterministic matching** for precise low-noise lexical contracts
2. **Normalized deterministic matching** for gather interrupts and other explicitly approved surfaces
3. **Finite-candidate semantic ranking** through a dedicated semantic service pool or embedding-backed NLU lane
4. **Optional LLM adjudication** only for ambiguous or policy-approved cases

This keeps gather interrupt routing close to a real NLU subsystem and reduces dependence on the main pipeline classifier for every interrupt turn. The important shift is from “regex or pipeline LLM” to “deterministic routing first, semantic ranking second, main LLM only when necessary,” with service selection based on logical profiles rather than direct endpoint URLs.

### Adjacent Future Service Type: Memory Compactor

`memory-compactor` should be treated as an adjacent service type that shares the same control plane as semantic routing, but not the same runtime contract.

- `semantic-router` decides whether the active turn should interrupt the current gather step.
- `memory-compactor` shrinks active conversation state to a target token budget for future turns.
- `summary` is user-facing or operator-facing output and should remain distinct from internal compaction.
- `memory-store` handles persistent cross-session recall and should remain distinct from inline turn compaction.

Recommended future service taxonomy:

- `semantic-router`
- `memory-compactor`
- `memory-store`
- `entity-extractor`
- `correction-detector`
- `summary`

Managed-provider mapping for planning:

| Provider          | Routing-Oriented Equivalent                                            | Memory / Compaction Equivalent                           | Planning Note                                                                                            |
| ----------------- | ---------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Amazon Bedrock    | Managed embedding + reranker stack                                     | Provider-native Claude compaction                        | Best current fit for native compaction semantics                                                         |
| Azure Foundry     | Managed embedding / rerank models                                      | Foundry memory stores plus app-managed compactor         | Strong memory primitives, but compaction should still be modeled as a platform contract                  |
| Vertex AI         | Managed embeddings plus Ranking API                                    | Context caching plus app-managed compactor               | Caching reduces repeated context cost, but it is not itself compaction                                   |
| OCI Generative AI | Managed embed / rerank / chat capabilities                             | Chat-model or summarization-backed app-managed compactor | Treat compaction as a platform layer above OCI chat and summarization capabilities                       |
| Databricks        | Hosted embedding models for semantic retrieval and semantic similarity | App-managed compactor on top of hosted chat models       | Useful as a managed semantic lane, but compaction should remain a logical service type rather than a URL |

These mappings are planning references only. Tenant and project configuration should select logical service profiles, not cloud-provider-specific model IDs.

### What Will Be Built New and How

1. **Compile richer interrupt candidate surfaces**
   1.1 Add first-class deterministic surfaces for `INTENTS`, `DIGRESSIONS`, and `SUB_INTENTS` beyond inferred names and descriptions.
   1.2 Preserve author intent, declaration order, and condition semantics when lowering those surfaces into IR.
   1.3 Stop relying on description token scraping as the primary lexical fallback source for supervisor categories.

2. **Replace raw sidecar URLs with semantic service-pool selection**
   2.1 Introduce logical semantic service selection as the primary future config surface instead of per-project raw sidecar URLs.
   2.2 Define service types such as `semantic-router`, `memory-compactor`, `entity-extractor`, `correction-detector`, and `summary`, each backed by a pool of containers rather than one fixed endpoint.
   2.3 Register service profiles with declared model family, hardware class, memory requirements, target throughput, concurrency envelope, latency objective, language coverage, and any service-type-specific fidelity requirements.
   2.4 Resolve tenant/project selection to a healthy container pool at runtime through service discovery instead of embedding deployment topology in project config.

3. **Add model-selection policy and tenant/project choice**
   3.1 Let tenant policy define the default service profile per service type, allowed profiles, hardware entitlements, and concurrency guardrails.
   3.2 Let projects inherit tenant defaults or select allowed overrides for `semantic-router` and `memory-compactor` based on latency, multilingual, accuracy, and state-fidelity needs.
   3.3 Validate that the selected profile satisfies the project’s routing objective before runtime dispatch.
   3.4 Reject unknown, disallowed, or currently unhosted profiles during project validation or publish instead of letting projects bind to unresolved runtime targets.
   3.5 If a selected profile is valid in config but no healthy pool is available at runtime, enter an explicit degraded mode rather than failing silently or hanging the gather step.
   3.6 Require a deprecate -> migrate -> remove lifecycle for profiles that are in use, and block undeploy or deletion while active project references remain unless an operator uses an explicit force-removal path.
   3.7 Do not silently substitute another profile unless tenant policy explicitly defines an approved fallback chain for that service type.

4. **Integrate semantic ranking into gather execution**
   4.1 Insert a semantic ranking stage ahead of lexical rescue when the selected semantic service profile is configured and healthy.
   4.2 Preserve current fail-closed behavior by making semantic negatives authoritative unless policy explicitly opts into another rescue lane.
   4.3 Keep `resolveRouting()` as the final deterministic mapping stage for supervisor categories.

5. **Improve observability and rollout control**
   5.1 Trace the semantic provider, service type, service profile, score, threshold, and fallback reason for each gather interrupt decision.
   5.2 Add rollout policy that lets projects choose strict deterministic mode, service-pool-assisted mode, or hybrid mode.
   5.3 Validate the contract through targeted public E2E lanes for chat and voice surfaces plus capacity tests for the selected service profiles.

### Why `detectIntent()` Stays Exact

The shared `detectIntent()` helper is still valuable because many callers want exact word-boundary behavior and low false-positive risk. The current implementation uses `detectIntentLexically()` as the common lexical primitive and leaves `detectIntent()` as the exact wrapper. Gather interrupts opt into normalization deliberately rather than forcing every lexical caller in the platform to accept broader matching.

---

## 8. How to Consume

### Studio UI

There is no dedicated Studio page for this sub-feature today. Authors consume it by:

- defining `DIGRESSIONS` and `SUB_INTENTS` inside flow steps
- defining supervisor `INTENTS` and `HANDOFF` rules in ABL
- optionally setting `LEXICAL_FALLBACK` in the `INTENTS` block for supervisors

### Surface Semantics Matrix

| Asset / Entity Type                        | Source of Truth / Ownership                   | Design-Time Surface(s)                | Editable or Read-Only? | Consumer Reference / Binding Model                                                                                                                                                | Runtime Materialization / Resolution                                                                                                 | Notes / Unsupported State                                                                                            |
| ------------------------------------------ | --------------------------------------------- | ------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Flow digressions                           | Flow step definition                          | `DIGRESSIONS` block in ABL            | Editable               | `INTENT`, `KEYWORDS`, `CONDITION`, `RESPOND`, `RETURN_TO_PARENT`, `RESUME`, `GOTO`                                                                                                | Lowered into flow escape candidates and evaluated during `GATHER`                                                                    | Current semantic path is classifier-first, then lexical fallback                                                     |
| Flow sub-intents                           | Flow step definition                          | `SUB_INTENTS` block in ABL            | Editable               | `INTENT`, `KEYWORDS`, `CONDITION`, `SET`, `GOTO`, `RESPOND`, `RESUME`                                                                                                             | Lowered into flow escape candidates and evaluated during `GATHER`                                                                    | Shares the same lexical/semantic detection contract as digressions                                                   |
| Supervisor intent categories               | Supervisor definition                         | `INTENTS` block in ABL                | Editable               | Category names, optional descriptions, `LEXICAL_FALLBACK`                                                                                                                         | Lowered into `routing.intent_classification` and consumed by pipeline classifier and lexical fallback                                | Current lexical fallback still synthesizes keywords from names/descriptions                                          |
| Parent routing rules                       | Supervisor definition                         | `HANDOFF` rules in ABL                | Editable               | `WHEN intent.category == ...` plus rule priority                                                                                                                                  | Final deterministic target resolution through `resolveRouting()`                                                                     | Category match alone does not decide the target                                                                      |
| Current sidecar / future AI service config | Project runtime config / future tenant policy | Runtime config API / settings surface | Editable               | Current: `extraction.nlu_provider`, `advanced_sidecar_url`, timeout and circuit-breaker fields. Future: `service_type`, `service_profile`, hardware preference, latency objective | Current runtime creates a per-session sidecar client. Future runtime resolves to a healthy service pool and profile before dispatch. | Raw URL config is current-state only; future semantic routing and compaction should prefer service profile selection |
| Trace events                               | Runtime execution                             | Observability surfaces                | Read-only              | `digression`, `sub_intent`, `return_to_parent`, pipeline events                                                                                                                   | Emitted during gather execution and routing resolution                                                                               | `lexicalMatchType` is present only when lexical fallback wins                                                        |

### Design-Time vs Runtime Behavior

At design time, authors declare interrupt candidates and supervisor routing vocabulary in ABL. At compile time, the parser/compiler lower those declarations into intent categories, flow escape candidates, and routing rules. At runtime, `flow-step-executor.ts` evaluates the current turn in this order:

1. semantic classifier when available and actionable
2. deterministic lexical fallback when allowed for that path
3. routing rule resolution for supervisor targets
4. normal gather extraction or re-prompting if no interrupt route wins

The future semantic sidecar phase should add a finite-candidate semantic ranking step before lexical rescue, not after the main reasoning loop.

### API (Runtime)

This feature is primarily an execution-time behavior layered onto existing APIs.

| Method / Transport        | Path / Surface                            | Purpose                                                                                  |
| ------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| POST                      | `/api/v1/chat/agent`                      | Execute public chat turns where gather interrupt routing may trigger                     |
| POST + `X-SDK-Token`      | `/api/v1/chat/agent`                      | Execute SDK chat turns on the same runtime ingress while preserving end-user ownership   |
| GET                       | `/api/projects/:projectId/runtime-config` | Read pipeline and advanced NLU configuration that affects semantic routing availability  |
| PUT                       | `/api/projects/:projectId/runtime-config` | Update pipeline and advanced NLU configuration for semantic routing and sidecar use      |
| Voice / realtime adapters | Channel-specific ingress                  | Reuse the same runtime gather interrupt and return-to-parent behavior across voice paths |

### API (Studio)

N/A for the current slice. Studio authors configure this behavior through ABL authoring and runtime config, not through a dedicated route or UI.

### Admin Portal

N/A for the current slice.

### Channel / SDK / Voice / A2A / MCP Integration

- Chat, SDK, and voice surfaces all converge on the same runtime gather execution path once the message reaches `flow-step-executor.ts`.
- The realtime voice validation lane from ABLP-242 shares the same underlying gather interrupt and return-to-parent mechanics as chat.
- Future sidecar-based semantic routing should remain channel-agnostic and operate on normalized message text plus finite candidate sets.

---

## 9. Data Model

### Collections / Tables

No new dedicated database collection is required for the current mitigation slice. The feature relies on:

- compiled agent IR for flow steps and supervisor routing
- existing project runtime config for pipeline and sidecar settings
- existing in-session thread stack, return-to-parent state, and trace emission

### Canonical Runtime / IR Shapes

```text
FlowEscapeIntentCandidate (runtime-derived):
  - intent: string
  - keywords?: string[]
  - condition?: string

FlowEscapeMatch (runtime):
  - intent: string
  - matched: string
  - detectionMode: 'pipeline' | 'lexical'
  - lexicalMatchType?: 'exact' | 'normalized'
  - candidateIndex: number

IntentConfig (IR):
  - categories: IntentCategory[]
  - min_confidence: number
  - source: 'explicit' | 'inferred'
  - lexical_fallback?: 'never' | 'when_unavailable' | 'always'
```

### Key Relationships

- Flow step interrupt declarations are authored in ABL, compiled into IR/runtime candidates, and evaluated inside `FlowStepExecutor`.
- Supervisor `INTENTS` and `HANDOFF` rules are authored in ABL, compiled into `routing.intent_classification` and `routing.rules`, and resolved through `resolveRouting()`.
- Project runtime config controls whether pipeline classification and advanced NLU sidecar infrastructure are available on a given turn.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                        | Purpose                                                                                              |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `packages/compiler/src/platform/constructs/utils.ts`        | Exact lexical matching, gather-only normalized lexical matching, and shared `detectIntent()` helpers |
| `apps/runtime/src/services/execution/flow-step-executor.ts` | Gather execution, flow escape detection, parent-supervisor reroute detection, and trace emission     |
| `apps/runtime/src/services/pipeline/classifier.ts`          | LLM-backed semantic classification for finite supervisor and flow candidate sets                     |
| `apps/runtime/src/services/pipeline/routing-resolver.ts`    | Deterministic target resolution from classified categories and supervisor routing rules              |
| `packages/compiler/src/platform/nlu/engine.ts`              | Existing compiler-side NLU engine with plugin -> embeddings -> LLM -> fallback sequencing            |
| `apps/runtime/src/services/nlu/sidecar-client.ts`           | Runtime sidecar transport and circuit breaker for advanced NLU                                       |
| `apps/nlu-sidecar/app.py`                                   | Current Python sidecar service stub and future semantic endpoint host                                |

### Routes / Handlers

| File                                                | Purpose                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `apps/runtime/src/routes/project-runtime-config.ts` | Project runtime config CRUD for pipeline and advanced NLU settings |

### UI Components

| File  | Purpose                                        |
| ----- | ---------------------------------------------- |
| `N/A` | No dedicated UI component in the current slice |

### Jobs / Workers / Background Processes

| File                      | Purpose                                                                        |
| ------------------------- | ------------------------------------------------------------------------------ |
| `apps/nlu-sidecar/app.py` | Future semantic ranking service process for finite-candidate interrupt routing |

### Tests

| File                                                                                      | Type        | Coverage Focus                                                                      |
| ----------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------- |
| `packages/compiler/src/platform/constructs/__tests__/detect-intent-word-boundary.test.ts` | unit        | Exact vs normalized lexical helper contract                                         |
| `packages/core/src/__tests__/parser/intents-section.test.ts`                              | unit        | Parsing supervisor `LEXICAL_FALLBACK` config                                        |
| `packages/compiler/src/__tests__/extract-intent-categories.test.ts`                       | unit        | Compiler lowering of lexical fallback into routing IR                               |
| `apps/runtime/src/__tests__/execution/flow-intents-digressions.test.ts`                   | integration | Gather-step digressions and normalized lexical fallback traces                      |
| `apps/runtime/src/__tests__/execution/reasoning-pipeline-contract.test.ts`                | integration | Parent-supervisor reroute, semantic rejection behavior, and lexical fallback policy |
| `apps/runtime/src/__tests__/execution/gather-interrupt.e2e.test.ts`                       | e2e         | Public chat gather reroute, semantic rejection, and trace payload parity            |
| `apps/runtime/src/__tests__/execution/gather-interrupt-sdk.e2e.test.ts`                   | e2e         | SDK chat gather reroute parity and resumed-session end-user ownership               |
| `apps/runtime/src/__tests__/channels/channels-voice-ingress.e2e.test.ts`                  | e2e         | `voice_vxml` gather reroute parity and parent-supervisor trace contract             |
| `apps/runtime/src/__tests__/project-runtime-config-route.test.ts`                         | integration | Runtime-config validation and persisted advanced NLU routing config behavior        |
| `apps/runtime/src/__tests__/project-runtime-config-resolver.integration.test.ts`          | integration | Runtime-config resolver stability after invalid updates and cross-project isolation |

---

## 11. Configuration

### Environment Variables

| Variable          | Default | Description                                                                                                                            |
| ----------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `NLU_SIDECAR_URL` | none    | Default sidecar URL used by runtime infrastructure when configured; project runtime config can override the per-project sidecar target |

### Runtime Configuration

Interrupt routing is affected by existing project runtime config in `project_runtime_configs`, especially:

- `pipeline.enabled`
- `pipeline.intentBridge.enabled`
- `extraction.nlu_provider`
- `extraction.advanced_sidecar_url`
- sidecar timeout and circuit-breaker tuning fields used by advanced NLU

### Future Runtime Service Selection (Planned)

The current `advanced_sidecar_url` field should be treated as a transitional integration contract, not the long-term platform choice. The future semantic-routing path, and any future `memory-compactor` path, should move to logical service selection backed by service pools.

Suggested future tenant policy shape:

```json
{
  "ai_services": {
    "semantic-router": {
      "enabled": true,
      "default_service_profile": "multilingual-balanced",
      "allowed_service_profiles": [
        "english-fast-cpu",
        "multilingual-balanced",
        "multilingual-high-recall-gpu"
      ],
      "allowed_hardware": ["cpu", "gpu"],
      "max_concurrency_per_project": 200
    },
    "memory-compactor": {
      "enabled": true,
      "default_service_profile": "chat-compact-balanced",
      "allowed_service_profiles": [
        "chat-compact-fast",
        "chat-compact-balanced",
        "chat-compact-high-fidelity"
      ],
      "allowed_hardware": ["cpu", "gpu"],
      "max_concurrency_per_project": 100
    }
  }
}
```

Suggested future project runtime config shape:

```json
{
  "semantic_routing": {
    "provider": "service_pool",
    "service_type": "semantic-router",
    "service_profile": "multilingual-balanced",
    "hardware_preference": "auto",
    "objective": "balanced",
    "latency_budget_ms": 80,
    "max_candidates": 16,
    "min_score": 0.76,
    "fallback_policy": "lexical_then_llm"
  },
  "memory_compaction": {
    "provider": "service_pool",
    "service_type": "memory-compactor",
    "service_profile": "chat-compact-balanced",
    "hardware_preference": "auto",
    "objective": "state_fidelity",
    "latency_budget_ms": 250,
    "target_token_budget": 1200,
    "structured_output": true,
    "fallback_policy": "preserve_recent_messages"
  }
}
```

Suggested future service profile registry shape:

```text
ServiceProfile:
  - id: string
  - serviceType: 'semantic-router' | 'memory-compactor' | 'entity-extractor' | 'correction-detector' | 'summary'
  - modelFamily: string
  - languages: string[]
  - hardwareClass: 'cpu' | 'gpu'
  - memoryGiB: number
  - targetThroughputQps: number
  - maxConcurrentRequests: number
  - targetP95LatencyMs: number
  - supportsBatching: boolean
  - accuracyTier: 'precision' | 'balanced' | 'recall'
  - structuredOutput?: boolean
  - targetTokenBudget?: number
  - fidelityTier?: 'fast' | 'balanced' | 'high_fidelity'
```

The important contract change is that tenant/project config chooses a logical service profile, while platform discovery resolves that profile to a healthy container pool. Direct URLs can remain as a platform-admin or local-development override, but they should not be the main user-facing control plane contract.

### Service Profile Lifecycle and Degraded-Mode Contract

For this control plane, "not hosted" should be treated as a product state, not a vague infrastructure detail. A profile is considered hostable only when it exists in the service-profile registry, is allowed by tenant policy, and resolves to at least one healthy pool for the requested service type.

The future contract should be:

- **Unknown or disallowed profile**: reject project configuration or publish before runtime dispatch. Projects should not be allowed to reference a profile id that is missing from the registry, disabled for the tenant, or incompatible with declared hardware or language requirements.
- **Known profile, but no healthy pool at runtime**: mark the project or execution path as degraded and use the configured fallback behavior. For `semantic-router`, degrade to deterministic exact/normalized interrupt matching and only use any additional rescue lane if policy explicitly allows it. For `memory-compactor`, do not silently switch to a random model; use the configured compaction fallback policy such as `preserve_recent_messages`.
- **Profile deprecation or removal while still referenced**: require a managed lifecycle. The platform should support deprecating a profile, migrating projects to another approved profile, and only then removing it. Removing or undeploying an in-use profile should be blocked by default. If operators force removal, affected projects must surface degraded health rather than appearing healthy until the next runtime failure.
- **Automatic substitution**: never happen implicitly. If tenant policy wants automatic substitution, it should declare an ordered fallback chain or equivalent policy per service type so the behavior remains auditable and predictable.

The main goal is to make profile failure visible, deterministic, and policy-driven. Service discovery may change which specific container serves a request, but it should not change the logical profile contract behind the user's back.

Suggested future compaction result shape:

```text
MemoryCompactionResult:
  - summaryText: string
  - mustKeepFacts: string[]
  - openTasks: string[]
  - userPreferences: string[]
  - authOrSessionState: string[]
  - sourceMessageRange:
      - startIndex: number
      - endIndex: number
  - targetTokenBudget: number
  - estimatedOutputTokens: number
```

Compaction should optimize for carry-forward fidelity, not just human readability. That is why `memory-compactor` should be distinct from a generic user-facing summary service.

### DSL / Agent IR / Schema

Current shipped ABL surface:

```yaml
INTENTS:
  LEXICAL_FALLBACK: when_unavailable
  location_lookup: 'Help users find a nearby service location'

HANDOFF:
  - TO: LocationAgent
    WHEN: intent.category == "location_lookup"

collect_phone_id:
  REASONING: false
  GATHER:
    - phone_id: required
  DIGRESSIONS:
    - INTENT: location_lookup
      KEYWORDS: [location, service center]
      RETURN_TO_PARENT: true
      RESPOND: 'I can help with that request.'
```

Current lowered IR surface:

```json
{
  "routing": {
    "intent_classification": {
      "categories": [
        { "name": "location_lookup", "description": "Help users find a nearby service location" }
      ],
      "min_confidence": 0.7,
      "source": "explicit",
      "lexical_fallback": "when_unavailable"
    }
  }
}
```

Future semantic-provider configuration is not implemented yet and should be treated as a design follow-up, not a shipped contract.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | Project runtime config reads and writes must remain scoped by `projectId`, and cross-project access must return 404.                |
| Tenant isolation  | Pipeline and sidecar configuration resolution must remain tenant-scoped, and cross-tenant access must return 404.                   |
| User isolation    | Session execution must preserve existing user/session ownership checks; this feature must not introduce cross-user session routing. |

### Security & Compliance

- No new public auth surface is introduced by the current mitigation slice.
- The future sidecar ranking endpoint must reuse existing authenticated project/runtime configuration rather than accepting arbitrary unscoped routing requests.
- User-facing error surfaces must remain sanitized when classifier or sidecar resolution fails.

### Performance & Scalability

- Exact and normalized lexical matching is in-process and low-latency.
- Pipeline classification is bounded by the existing classifier timeout and circuit breaker.
- The future semantic service pools should be optimized for small finite candidate sets and fast failover, not for open-ended generation.
- Service profiles should publish memory, throughput, concurrency, and latency envelopes so tenant/project selection can be based on measured capacity rather than intuition.
- Future `memory-compactor` profiles can tolerate higher latency than inline interrupt routing, but they should publish explicit token-budget, fidelity, and structured-output guarantees.

### Reliability & Failure Modes

- If the pipeline classifier is unavailable, gather interrupts fall back deterministically instead of failing open into an unbounded reasoning path.
- If the pipeline classifier runs and rejects a flow escape, the gather step remains active unless policy explicitly allows another rescue lane.
- The future sidecar must fail gracefully behind its circuit breaker so gather execution can continue without semantic ranking.
- Future project validation should reject unknown, disallowed, or unhosted profiles before runtime dispatch.
- If a valid profile has no healthy pool at runtime, the project should enter an explicit degraded mode with service-type-specific fallback rather than silently swapping profiles.
- Profile removal should be lifecycle-managed: deprecate, migrate, remove. Forced removal must surface degraded project health and trace evidence.

### Observability

- Gather interrupt traces currently expose `detectionMode` and `lexicalMatchType`.
- The future semantic service-pool path should also expose provider, service profile, score, threshold, and fallback reason.
- Future compaction traces should expose provider, service profile, target token budget, estimated output tokens, and whether structured output was returned.
- Debugging should continue to rely on shared trace events rather than ad hoc logs.

### Data Lifecycle

- The current mitigation adds no new persisted data store.
- Future semantic ranking should avoid storing raw per-turn embeddings unless there is a clear operational reason and a documented retention policy.

---

## 13. Delivery Plan / Work Breakdown

1. Harden the current deterministic gather interrupt contract
   1.1 Keep `detectIntent()` exact and document gather-only normalized lexical matching.
   1.2 Maintain parser/compiler/runtime regression coverage for lexical fallback policy and trace payloads.
   1.3 Sync umbrella NLU docs and testing guides so the shipped contract is discoverable.
2. Compile richer interrupt intent surfaces
   2.1 Add first-class lexical and semantic surfaces for supervisor `INTENTS`, `DIGRESSIONS`, and `SUB_INTENTS`.
   2.2 Reduce reliance on synthesized keywords from category descriptions.
   2.3 Preserve condition semantics, declaration order, and routing priority across lowering.
   2.4 Define the shared service-profile registry so `semantic-router` and `memory-compactor` can use the same control plane without sharing the same runtime contract.
3. Implement semantic sidecar ranking for gather interrupts
   3.1 Add a finite-candidate semantic ranking endpoint to the sidecar service.
   3.2 Extend the runtime sidecar client and runtime config plumbing for semantic ranking.
   3.3 Integrate sidecar ranking into `detectFlowEscapeMatch()` and `detectParentSupervisorRoute()` ahead of lexical rescue.
4. Roll out, validate, and observe
   4.1 Maintain the current public chat + SDK + `voice_vxml` E2E coverage for gather interrupts and parent reroutes, then extend to additional realtime voice surfaces as adjacent work.
   4.2 Add semantic decision traces with score and fallback reason.
   4.3 Add shared service-profile validation for `semantic-router` and `memory-compactor`.
   4.4 Tune thresholds and fallback policy on a labeled interrupt corpus before promoting beyond ALPHA.

---

## 14. Success Metrics

| Metric                              | Baseline                                                                                             | Target                                                                                                                                        | How Measured                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Gather interrupt lexical resilience | Exact lexical fallback previously missed inflectional variants when semantic routing was unavailable | No regression on normalized lexical interrupt lanes across runtime/compiler suites                                                            | `flow-intents-digressions.test.ts`, `reasoning-pipeline-contract.test.ts`, lexical helper tests |
| Semantic routing independence       | Gather interrupt semantics currently depend on pipeline LLM when available                           | Sidecar or embedding-backed semantic ranking handles finite-candidate interrupt routing without requiring the main pipeline LLM on every turn | Integration and E2E traces showing semantic provider other than pipeline LLM                    |
| Debuggability                       | Current traces expose `detectionMode` and lexical match type only                                    | Semantic traces include provider, score, threshold, and fallback reason                                                                       | Trace payload inspection in integration and E2E suites                                          |
| Public API confidence               | Public chat, SDK, and `voice_vxml` E2E now cover gather reroute behavior on shipped public surfaces  | At least one public chat E2E, one SDK E2E, and one public voice E2E keep gather reroute behavior locked as the feature evolves                | `apps/runtime` E2E suites plus manual validation checklist                                      |
| Profile selection readiness         | No measured profile metadata exists for routing-oriented model choice                                | Candidate profiles publish validated multilingual support, memory, throughput, concurrency, and latency envelopes                             | Benchmark suites and service-profile registry metadata                                          |

---

## 15. Open Questions

1. Should the future semantic interrupt path reuse the compiler-side NLU engine directly, or should the runtime continue to prefer a separate sidecar boundary for semantic ranking?
2. What is the right first-class authoring surface for semantic candidate examples and hints on `INTENTS`, `DIGRESSIONS`, and `SUB_INTENTS`?
3. Should `LEXICAL_FALLBACK: always` remain supported once semantic service-pool routing exists, or should hybrid semantic routing narrow that override?
4. Which multilingual policy should the selected semantic service profile enforce when locale and language context disagree or are missing?
5. Should semantic service profiles be globally platform-managed, cluster-managed, or tenant-partitioned for noisy-neighbor protection?
6. Do we want a dedicated public runtime diagnostic surface for gather interrupt decisions, or are enriched trace events sufficient?
7. Should `memory-compactor` use the same service-profile registry and tenant policy mechanism as `semantic-router`, or should it have a separate memory-specific control plane?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                                        | Severity | Status    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | --------- |
| GAP-001 | The Python sidecar is still a stub and does not yet provide semantic interrupt ranking.                                                                                                                            | High     | Open      |
| GAP-002 | Supervisor lexical fallback still derives keywords from category names and descriptions instead of from explicit compiled interrupt vocabulary.                                                                    | Medium   | Open      |
| GAP-003 | The shipped public voice surface (`voice_vxml`) is now covered, but LiveKit/WebSocket-specific parity still belongs to broader voice-runtime follow-on work rather than this sub-feature's core regression packet. | Low      | Mitigated |
| GAP-004 | Semantic gather routing still depends on the pipeline LLM path when available; embeddings are not yet wired into the active runtime interrupt path.                                                                | Medium   | Open      |
| GAP-005 | Current advanced NLU config is URL-based and does not yet support tenant/project selection of service profiles or service pools for semantic routing or memory compaction.                                         | Medium   | Open      |
| GAP-006 | The immediate lexical-variant reroute gap is mitigated in code, but the broader future-ready semantic architecture is not yet implemented.                                                                         | Low      | Mitigated |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                                      | Coverage Type | Status | Test File / Note                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------- | ------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Exact vs normalized lexical helper behavior remains stable                                    | unit          | PASS   | `packages/compiler/src/platform/constructs/__tests__/detect-intent-word-boundary.test.ts`                                                         |
| 2   | Supervisor `LEXICAL_FALLBACK` parses and lowers into IR                                       | unit          | PASS   | `packages/core/src/__tests__/parser/intents-section.test.ts`, `packages/compiler/src/__tests__/extract-intent-categories.test.ts`                 |
| 3   | Gather-step digression normalized lexical fallback routes correctly                           | integration   | PASS   | `apps/runtime/src/__tests__/execution/flow-intents-digressions.test.ts`                                                                           |
| 4   | Parent-supervisor reroute uses normalized lexical fallback when classification is unavailable | integration   | PASS   | `apps/runtime/src/__tests__/execution/reasoning-pipeline-contract.test.ts`                                                                        |
| 5   | Parent-supervisor reroute honors semantic rejection and lexical fallback policy               | integration   | PASS   | `apps/runtime/src/__tests__/execution/reasoning-pipeline-contract.test.ts`                                                                        |
| 6   | Public chat E2E for child gather reroute to parent supervisor                                 | e2e           | PASS   | `apps/runtime/src/__tests__/execution/gather-interrupt.e2e.test.ts`                                                                               |
| 7   | Voice or SDK E2E for gather interrupt return-to-parent behavior                               | e2e           | PASS   | `apps/runtime/src/__tests__/execution/gather-interrupt-sdk.e2e.test.ts`, `apps/runtime/src/__tests__/channels/channels-voice-ingress.e2e.test.ts` |

### Testing Notes

The current branch already contains the targeted regression coverage needed for the reported gather interrupt gap:

- runtime targeted suites: `34/34` passing on 2026-04-23
- compiler targeted suites: `22/22` passing on 2026-04-23
- core parser targeted suites: `11/11` passing on 2026-04-23
- runtime targeted build: passing on 2026-04-23
- runtime config route regression lane: `25/25` passing on 2026-04-23
- runtime config resolver integration lane: `1/1` passing on 2026-04-23
- gather-interrupt public chat + SDK E2E lanes: `3/3` passing on 2026-04-23
- voice ingress E2E lane: `10/10` passing on 2026-04-23, including the deployment-bound gather-interrupt VXML parity scenario

The shipped public surfaces now have parity proof across public chat, SDK HTTP chat, and `voice_vxml` ingress. LiveKit/WebSocket-specific expansion is broader voice-runtime follow-on work rather than an open blocker for this sub-feature.

> Full testing details: [docs/testing/sub-features/gather-interrupt-semantic-routing.md](../../testing/sub-features/gather-interrupt-semantic-routing.md)

---

## 18. References

- Design note: [docs/plans/2026-04-21-nlu-sidecar-semantic-routing-writeup.md](../../plans/2026-04-21-nlu-sidecar-semantic-routing-writeup.md)
- Related feature docs: [docs/features/nlu.md](../nlu.md), [docs/features/multi-agent-orchestration.md](../multi-agent-orchestration.md), [docs/features/entity-extraction.md](../entity-extraction.md), [docs/features/tracing-observability.md](../tracing-observability.md)
- Reference docs: [docs/feature-matrix.md](../../feature-matrix.md), [docs/enterprise-readiness.md](../../enterprise-readiness.md)

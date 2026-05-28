# Feature: NLU / Intent Classification & Entity Extraction

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: BETA
**Feature Area(s)**: `agent lifecycle`, `customer experience`, `governance`
**Package(s)**: `apps/runtime`, `packages/nl-parser`, `packages/compiler`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/nlu.md](../testing/nlu.md)
**Focused Sub-Feature(s)**: [docs/features/entity-extraction.md](./entity-extraction.md), [docs/features/sub-features/gather-interrupt-semantic-routing.md](./sub-features/gather-interrupt-semantic-routing.md), [docs/features/sub-features/localized-interaction-context.md](./sub-features/localized-interaction-context.md)
**Last Updated**: 2026-04-21

---

## 1. Introduction / Overview

### Problem Statement

Multi-agent systems need to understand user intent and extract structured entities from natural language input. Without a dedicated NLU layer, all classification and extraction relies solely on the primary LLM's reasoning loop, which is slow (3-10s per turn), expensive (full-model inference), and cannot apply programmatic routing rules. Additionally, specialized entity extraction (dates, currencies, corrections to previously gathered fields) requires ML models that general-purpose LLMs handle inconsistently.

### Goal Statement

Provide a multi-tier NLU subsystem that classifies user intents for agent routing, extracts entities for gather operations, and supports multi-intent detection — all with configurable confidence thresholds, tiered fallback, and optional ML-based sidecar enhancement.

### Summary

The NLU subsystem spans three layers:

1. A **pipeline classifier** (`apps/runtime/src/services/pipeline/classifier.ts`) that runs a fast LLM call (qwen3-30b, 10s timeout) before the reasoning loop to classify intents and determine short-circuit routing. The pipeline also includes a **tool filter** for reducing the tool set, a **circuit breaker** (`circuit-breaker.ts`) scoped per tenant to prevent cascade failures, and a **merge module** (`merge.ts`) for synthesizing multi-agent fan-out responses.

2. An **NLU sidecar client** (`apps/runtime/src/services/nlu/sidecar-client.ts`) that integrates with an external Python ML service for entity extraction and correction detection, with its own self-contained circuit breaker.

3. A **multi-intent system** with intent queuing (`intent-queue.ts`), strategy resolution (`multi-intent-strategy.ts`), and a shared router (`multi-intent/multi-intent-router.ts`) that preserves executable targets across pipeline, reasoning, and flow execution.

The `@abl/nl-parser` package provides natural-language-to-ABL conversion for the Studio AI assistant (Arch).

> Canonical split (2026-04-21): this document remains the umbrella feature for intent classification and routing. Detailed semantic entity, `ENTITIES`, `ENTITY_REF`, and runtime observation-pipeline ownership now lives in [docs/features/entity-extraction.md](./entity-extraction.md). Detailed gather-step interrupt routing, parent-supervisor reroute behavior, normalized lexical fallback, and future semantic sidecar ownership now lives in [docs/features/sub-features/gather-interrupt-semantic-routing.md](./sub-features/gather-interrupt-semantic-routing.md).

---

## 2. Scope

### Goals

- Classify user intent(s) using a fast pipeline LLM call before the reasoning loop
- Support short-circuit routing when a single intent has high confidence and no keyword veto fires
- Support multi-intent short-circuit fan-out when all intents have targets and high confidence
- Extract entities from user text via tiered strategy (LLM + optional ML sidecar)
- Detect user corrections to previously gathered fields via sidecar
- Support multi-intent detection with configurable strategies (primary_queue, sequential, parallel, disambiguate)
- Gate advanced NLU features by tenant plan (Enterprise only for sidecar)
- Provide natural-language-to-ABL extraction for agent/supervisor creation via nl-parser

### Non-Goals (Out of Scope)

- Training custom NLU models (the sidecar uses pre-trained models)
- Sentiment analysis (handled by analytics pipeline)
- Speech-to-text / ASR (handled by voice subsystem)
- Per-agent NLU model selection (uses project-level pipeline model)
- Real-time NLU model updates without restart

---

## 3. User Stories

1. As a **supervisor agent**, I want to classify incoming user messages to route them to the correct sub-agent with sub-second latency, so that users get fast, accurate responses without the full reasoning loop.
2. As a **gather-mode agent**, I want entities automatically extracted from user messages (via LLM or ML sidecar), so that I can collect structured data without asking redundant questions.
3. As a **platform operator**, I want to configure whether my project uses standard (LLM-only) or advanced (ML sidecar) NLU via the project runtime config API, so that I can balance cost and accuracy.
4. As a **multi-intent user**, I want the system to handle multiple requests in a single message (e.g., "book a flight and reserve a hotel"), so that I do not have to send separate messages for each need.
5. As a **Studio user (Arch assistant)**, I want to paste a natural-language SOP and get a structured agent or supervisor ABL definition, so that I can create agents without learning DSL syntax.

---

## 4. Functional Requirements

1. **FR-1**: The pipeline classifier must classify user intent(s) into target agents with confidence scores using a fast LLM call (10s timeout, temperature 0, 300 max tokens).
2. **FR-2**: When a single intent exceeds the short-circuit confidence threshold (default 0.85), has a non-null target, and no keyword veto fires, the system must route directly without entering the reasoning loop.
3. **FR-3**: Multi-intent messages (2+ intents) where all intents have non-null targets and confidence >= threshold must trigger fan-out short-circuit, dispatching to all targets simultaneously.
4. **FR-4**: Multi-intent messages that do not qualify for fan-out must be handled via the configured strategy: primary_queue, sequential, parallel (supervisor only), or disambiguate.
5. **FR-5**: The NLU sidecar client must support entity extraction (`POST /extract`) and correction detection (`POST /detect-correction`) with circuit breaker failover (CLOSED -> OPEN -> HALF_OPEN states).
6. **FR-6**: The sidecar circuit breaker must transition to OPEN after N consecutive failures (default 5), wait a reset period (default 30s), then transition to HALF_OPEN for a single probe request.
7. **FR-7**: Advanced NLU (sidecar) must be gated by tenant plan (Enterprise only) and require an `advanced_sidecar_url` in project runtime config.
8. **FR-8**: The pipeline module must include a tenant-scoped circuit breaker (`circuit-breaker.ts`) with LRU eviction (max 500 entries), 3-failure threshold, and 60s reset timeout to prevent cascade failures when the pipeline model is down.
9. **FR-9**: The intent queue must support enqueue (with duplicate merging by intent name, higher confidence wins), dequeue (highest-confidence first), peek, prune expired entries (by `maxAgeMs`), and max size enforcement.
10. **FR-10**: The `@abl/nl-parser` package must extract agent definitions (steps, tools, guardrails) and supervisor definitions (routing rules, intent mappings) from natural language SOPs using Anthropic API (claude-sonnet-4-20250514).
11. **FR-11**: The pipeline configuration must be resolvable from a three-level cascade: agent IR execution config -> project-level pipeline config -> hardcoded defaults (in `config.ts`).
12. **FR-12**: The pipeline merge module must synthesize fan-out agent responses into a single coherent reply using the pipeline model, with fallback to concatenation on LLM failure.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                              |
| -------------------------- | ------------ | ------------------------------------------------------------------ |
| Project lifecycle          | SECONDARY    | Project-level NLU config (extraction strategy, sidecar URL)        |
| Agent lifecycle            | PRIMARY      | Intent classification drives agent routing and execution           |
| Customer experience        | PRIMARY      | Fast routing, entity extraction, multi-intent handling             |
| Integrations / channels    | SECONDARY    | Pipeline runs for all channels (message processing path)           |
| Observability / tracing    | SECONDARY    | Pipeline trace events (classify, filter, short_circuit, veto, etc) |
| Governance / controls      | SECONDARY    | Tenant plan gating for advanced NLU                                |
| Enterprise / compliance    | SECONDARY    | Enterprise-only sidecar feature                                    |
| Admin / operator workflows | NONE         | No admin-specific NLU management                                   |

### Related Feature Integration Matrix

| Related Feature               | Relationship Type | Why It Matters                                                                                                          | Key Touchpoints                                                    | Current State |
| ----------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------- |
| Pipeline Engine               | depends on        | Classifier is part of the pre-reasoning pipeline                                                                        | `services/pipeline/index.ts`, `services/pipeline/*.ts`             | STABLE        |
| Gather/Data Collection        | shares data with  | Entity extraction populates gather fields                                                                               | Extraction pipeline, sidecar client                                | STABLE        |
| Agent Routing                 | extends           | Intent classification drives handoff routing                                                                            | `services/execution/routing-executor.ts`                           | STABLE        |
| Tenant Config                 | configured by     | Enterprise plan gates advanced NLU                                                                                      | `tenant-config.ts`, provider gating                                | STABLE        |
| Project Runtime Config        | configured by     | NLU settings stored per project in MongoDB                                                                              | `services/config/project-runtime-config-resolver.ts`               | STABLE        |
| Entity Extraction             | parent / child    | Semantic entity registry, `ENTITY_REF`, and runtime observations are now tracked separately                             | `docs/features/entity-extraction.md`                               | ALPHA         |
| Localized Interaction Context | shares data with  | Prompt construction, entity extraction, and relative-date parsing need canonical language, locale, and timezone context | `prompt-builder.ts`, `flow-step-executor.ts`, `date-extraction.ts` | Planned       |
| Arch AI Assistant             | depends on        | nl-parser provides NL-to-ABL extraction                                                                                 | `packages/nl-parser`                                               | STABLE        |
| Circuit Breaker               | uses              | Both pipeline and sidecar use circuit breakers                                                                          | `pipeline/circuit-breaker.ts`, `nlu/sidecar-client.ts`             | STABLE        |

---

## 6. Design Considerations (Optional)

No dedicated NLU management UI in Studio. NLU configuration is managed via project runtime config API (`PUT /api/projects/:projectId/runtime-config`). The pipeline classifier runs transparently before the reasoning loop. Future work may add a Studio page for NLU config and intent analytics visualization.

---

## 7. Technical Considerations (Optional)

- Pipeline classifier uses a fast model (qwen3-30b) separate from the agent's primary LLM to keep classification latency under 1 second. Model resolved via Vercel AI SDK `generateText`.
- The NLU sidecar is an external Python ML service (`kore-nlu`) that must be deployed separately. Enterprise plan gating ensures only paying customers use the sidecar infrastructure.
- Multi-intent execution now converges on `multi-intent/multi-intent-router.ts`: classifier-driven short-circuit, guided reasoning dispatch, and flow `ON_INPUT` detection all produce the same target-preserving plan shape.
- `project-runtime-config-resolver.ts` now maps the full `pipeline` block, including `intentBridge`, into IR so live project runtime config changes affect classifier/guided behavior without hand-written session patching.
- The nl-parser package is hardcoded to use Anthropic's API (claude-sonnet-4-20250514). No provider-neutral fallback exists.
- Keyword veto uses simple word-boundary regex matching (tool name parts split on `_`, minimum 3 chars), not NLP-based detection.
- Pipeline circuit breaker is tenant-scoped with LRU eviction (max 500 entries) to prevent unbounded memory growth.
- The merge module supports both streaming (`streamText`) and non-streaming (`generateText`) synthesis, with 15s timeout and concatenation fallback.

---

## 8. How to Consume

### API (Runtime)

NLU is triggered automatically during message processing. No user-facing NLU API exists. Configuration is via project runtime config.

| Method | Path                                      | Purpose                                                                                  |
| ------ | ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| POST   | `/api/v1/chat/agent`                      | Execute a chat turn; pipeline classification, guided multi-intent, and merge happen here |
| GET    | `/api/projects/:projectId/runtime-config` | Read project NLU config                                                                  |
| PUT    | `/api/projects/:projectId/runtime-config` | Update NLU config (pipeline, extraction strategy, nlu_provider, sidecar URL)             |

### DSL / Agent IR / Schema

Pipeline configuration resolved from agent IR:

```yaml
EXECUTION:
  pipeline:
    enabled: true
    mode: 'parallel'
    model: 'qwen3-30b'
    short_circuit:
      enabled: true
      confidence_threshold: 0.85
    tool_filter:
      enabled: true
      max_tools: 6
    keyword_veto:
      enabled: true
      keywords: []
```

Project runtime config (MongoDB `project_runtime_configs` collection):

```json
{
  "pipeline": {
    "enabled": true,
    "mode": "parallel",
    "shortCircuit": {
      "enabled": true,
      "confidenceThreshold": 0.85
    },
    "toolFilter": {
      "enabled": true,
      "maxTools": 6
    },
    "keywordVeto": {
      "enabled": true,
      "keywords": []
    },
    "intentBridge": {
      "enabled": true,
      "programmaticThreshold": 0.85,
      "guidedThreshold": 0.5,
      "outOfScopeDecline": true,
      "multiIntentSignal": true
    }
  },
  "extraction": {
    "strategy": "auto",
    "nlu_provider": "advanced",
    "advanced_sidecar_url": "http://kore-nlu:8090",
    "correction_detection": "ml"
  },
  "multi_intent": {
    "enabled": true,
    "strategy": "primary_queue",
    "max_intents": 3,
    "confidence_threshold": 0.6,
    "queue_max_age_ms": 600000
  }
}
```

---

## 9. Data Model

### In-Memory Session State

```text
IntentQueue (serialized on session):
  - pending: PendingIntentEntry[]
    - intent: string
    - confidence: number (0..1)
    - original_message: string
    - detected_at: string (ISO)

ClassifierResult (pipeline output):
  - intents: ClassifiedIntent[]
    - target: string | null
    - confidence: number (0-1)
    - summary: string
  - shouldExecuteInAgent: boolean
  - matchedTools: string[]

PipelineResult (orchestrator output):
  - shortCircuit: boolean
  - handoffInput?: { target, message, context? }
  - fanOutTargets?: Array<{ target, intent, context? }>
  - filteredTools?: ToolDefinition[]
  - classifierResult?: ClassifierResult
  - toolFilterResult?: ToolFilterResult
```

### Project Runtime Config (MongoDB)

```text
Collection: project_runtime_configs
Fields:
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - extraction.strategy: 'auto' | 'llm' | 'regex' | 'sidecar'
  - extraction.nlu_provider: 'standard' | 'advanced'
  - extraction.advanced_sidecar_url: string
  - extraction.advanced_sidecar_timeout_ms: number
  - extraction.advanced_sidecar_circuit_breaker_threshold: number
  - extraction.correction_detection: 'ml' | 'regex' | 'off'
  - extraction.sidecar_timeout_ms: number
  - extraction.sidecar_circuit_breaker_threshold: number
  - multi_intent.enabled: boolean
  - multi_intent.strategy: 'primary_queue' | 'sequential' | 'parallel' | 'disambiguate'
  - multi_intent.max_intents: number
  - multi_intent.confidence_threshold: number
  - multi_intent.queue_max_age_ms: number
  - inference.confidence: number
  - inference.confirm: boolean
  - inference.model_tier: string
  - inference.max_fields_per_pass: number
  - conversion.currency_mode: 'static' | 'live'
  - conversion.currency_api_url: string
  - lookup_tables: Array<{ name, source, values?, ... }>
Indexes:
  - { tenantId: 1, projectId: 1 }
```

### NLU Sidecar Types

```text
SidecarConfig:
  - url: string
  - timeoutMs: number (default 3000)
  - circuitBreakerThreshold: number (default 5)
  - circuitBreakerResetMs: number (default 30000)

ExtractionRequest: { text, fields: ExtractionField[], locale }
ExtractionResult: { entities: Record<string, unknown>, confidence: Record<string, number> }
CorrectionRequest: { text, context: Record<string, unknown>, locale }
CorrectionResult: { is_correction, field, new_value, confidence }
```

---

## 10. Key Implementation Files

> Canonical split note: this section is intentionally routing- and classifier-heavy. Detailed parser/compiler/runtime entity-registry ownership is tracked in [docs/features/entity-extraction.md](./entity-extraction.md).

### Domain / Core Logic

| File                                                                      | Purpose                                                                                            |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/pipeline/classifier.ts`                        | Pipeline intent classifier (prompt building, JSON parsing, short-circuit check, keyword veto)      |
| `apps/runtime/src/services/pipeline/index.ts`                             | Pipeline orchestrator (classifier + tool filter, parallel/sequential modes, fan-out detection)     |
| `apps/runtime/src/services/pipeline/types.ts`                             | PipelineConfig, ClassifierResult, PipelineResult, ToolFilterResult, trace event types              |
| `apps/runtime/src/services/pipeline/config.ts`                            | Pipeline config resolution (agent IR -> project config -> defaults)                                |
| `apps/runtime/src/services/pipeline/merge.ts`                             | Multi-intent fan-out response synthesis (streaming + non-streaming)                                |
| `apps/runtime/src/services/pipeline/tool-filter.ts`                       | LLM-based tool filtering to reduce tool set for reasoning loop                                     |
| `apps/runtime/src/services/pipeline/circuit-breaker.ts`                   | Per-tenant pipeline circuit breaker (LRU, 3-failure threshold, 60s reset)                          |
| `apps/runtime/src/services/pipeline/intent-bridge.ts`                     | Target-aware intent bridge from classifier output into shared multi-intent types and session state |
| `apps/runtime/src/services/pipeline/tiered-resolver.ts`                   | Tiered action resolution: `resolveTieredAction()` — Tier 1/2/3 discrimination logic (180 LOC)      |
| `apps/runtime/src/services/nlu/sidecar-client.ts`                         | NLUSidecarClient: HTTP + circuit breaker for entity extraction and correction detection            |
| `apps/runtime/src/services/nlu/currency-rate-client.ts`                   | CurrencyRateClient: live exchange rates with in-memory cache + static fallback                     |
| `apps/runtime/src/services/execution/multi-intent-strategy.ts`            | resolveStrategy: auto/parallel/sequential/disambiguate based on agent type                         |
| `apps/runtime/src/services/execution/multi-intent/multi-intent-router.ts` | Canonical multi-intent planner for pipeline, reasoning, and flow paths                             |
| `apps/runtime/src/services/execution/multi-intent/multi-intent-types.ts`  | Shared detected-intent, target, and queue-entry types plus config resolution                       |
| `apps/runtime/src/services/execution/intent-queue.ts`                     | IntentQueue: enqueue (dedup), dequeue, peek, pruneExpired, max size                                |
| `apps/runtime/src/services/execution/reasoning-executor.ts`               | Guided multi-intent execution path, pipeline hints, and merge orchestration                        |
| `apps/runtime/src/services/execution/flow-step-executor.ts`               | Flow `ON_INPUT` multi-intent detection adapted into the shared plan model                          |
| `apps/runtime/src/services/config/project-runtime-config-resolver.ts`     | Load project NLU config from MongoDB, map to ProjectRuntimeConfigIR                                |
| `packages/nl-parser/src/extractor.ts`                                     | NLExtractor: Anthropic API calls for agent/supervisor extraction from NL SOPs                      |
| `packages/nl-parser/src/generator.ts`                                     | ABLGenerator: converts AgentExtraction/SupervisorExtraction to ABL DSL strings                     |
| `packages/nl-parser/src/types.ts`                                         | Zod schemas: AgentExtractionSchema, SupervisorExtractionSchema, ExtractedStep, InferredTool        |
| `packages/nl-parser/src/prompts/agent.ts`                                 | Agent extraction system prompt and prompt builder                                                  |
| `packages/nl-parser/src/prompts/supervisor.ts`                            | Supervisor extraction system prompt and prompt builder                                             |

### Routes / Handlers

| File                                                | Purpose                                       |
| --------------------------------------------------- | --------------------------------------------- |
| `apps/runtime/src/routes/project-runtime-config.ts` | GET/PUT project runtime config (NLU settings) |
| `apps/runtime/src/routes/pipeline-config.ts`        | Pipeline configuration endpoints              |

### Tests

| File                                                                           | Type        | Coverage Focus                                                                            |
| ------------------------------------------------------------------------------ | ----------- | ----------------------------------------------------------------------------------------- |
| `apps/runtime/src/__tests__/nlu-sidecar-client.test.ts`                        | unit        | Extract, correction, circuit breaker states                                               |
| `apps/runtime/src/__tests__/nlu-sidecar-half-open-probe.test.ts`               | unit        | Half-open probe behavior                                                                  |
| `apps/runtime/src/__tests__/nlu-sidecar-per-session.test.ts`                   | unit        | Per-session sidecar client creation from config                                           |
| `apps/runtime/src/__tests__/nlu-sidecar-wiring.test.ts`                        | unit        | Sidecar wiring in runtime executor                                                        |
| `apps/runtime/src/__tests__/nlu-provider-gating.test.ts`                       | unit        | Enterprise plan gating                                                                    |
| `apps/runtime/src/__tests__/tenant-config-advanced-nlu.test.ts`                | unit        | Tenant config NLU feature flags                                                           |
| `apps/runtime/src/__tests__/project-runtime-config-route-nlu.test.ts`          | unit        | NLU config in project runtime config route                                                |
| `apps/runtime/src/__tests__/pipeline-classifier.test.ts`                       | unit        | Classifier prompt building, JSON parsing                                                  |
| `apps/runtime/src/__tests__/pipeline-executor.test.ts`                         | unit        | Pipeline orchestrator logic                                                               |
| `apps/runtime/src/__tests__/pipeline-config.test.ts`                           | unit        | Config resolution cascade                                                                 |
| `apps/runtime/src/__tests__/pipeline-circuit-breaker.test.ts`                  | unit        | Tenant-scoped circuit breaker                                                             |
| `apps/runtime/src/__tests__/pipeline-tool-filter.test.ts`                      | unit        | Tool filter selection                                                                     |
| `apps/runtime/src/__tests__/pipeline-intent-bridge.test.ts`                    | unit        | Intent bridge: target category map, session state bridging, multi-intent result (345 LOC) |
| `apps/runtime/src/__tests__/pipeline-tiered-resolver.test.ts`                  | unit        | Tiered resolver: Tier 1/2/3 action discrimination (306 LOC)                               |
| `apps/runtime/src/__tests__/routing/multi-intent-strategy.test.ts`             | unit        | Multi-intent strategy resolution                                                          |
| `apps/runtime/src/__tests__/intent-queue.test.ts`                              | unit        | Intent queue operations                                                                   |
| `apps/runtime/src/__tests__/intent-queue-expanded.test.ts`                     | unit        | Intent queue edge cases                                                                   |
| `apps/runtime/src/__tests__/intent-queue-max-intents.test.ts`                  | unit        | Queue max size enforcement                                                                |
| `apps/runtime/src/__tests__/routing/multi-intent-router.test.ts`               | unit        | Canonical multi-intent plan creation and executable-target preservation                   |
| `apps/runtime/src/__tests__/routing/multi-intent-integration.test.ts`          | integration | Multi-intent dispatch flow                                                                |
| `apps/runtime/src/__tests__/routing/multi-intent-executor-integration.test.ts` | integration | Multi-intent executor integration                                                         |
| `apps/runtime/src/__tests__/routing/multi-intent-dispatch-wiring.test.ts`      | integration | Multi-intent dispatch wiring                                                              |
| `apps/runtime/src/__tests__/routing/routing-executor-multi-intent.test.ts`     | unit        | Routing executor multi-intent facade behavior                                             |
| `apps/runtime/src/__tests__/execution/reasoning-pipeline-bridge.test.ts`       | integration | Guided planning, tiered action, and shared merge/router execution                         |
| `apps/runtime/src/__tests__/project-runtime-config-resolver.test.ts`           | unit        | Project runtime pipeline config mapping, including `intentBridge`                         |
| `apps/runtime/src/__tests__/extraction-pipeline.test.ts`                       | unit        | Entity extraction pipeline                                                                |
| `apps/runtime/src/__tests__/extraction-strategy.test.ts`                       | unit        | Extraction strategy selection                                                             |
| `apps/runtime/src/__tests__/extraction-tool-call.test.ts`                      | unit        | Tool-call-based extraction                                                                |
| `apps/runtime/src/__tests__/extraction-decision-traces.test.ts`                | unit        | Extraction decision trace events                                                          |
| `apps/runtime/src/__tests__/currency-rate-client.test.ts`                      | unit        | Currency conversion client                                                                |
| `apps/runtime/src/__tests__/sidecar-config-wiring.test.ts`                     | integration | Sidecar config wiring in session creation                                                 |
| `apps/runtime/src/__tests__/flow-detect-intent-constraints.test.ts`            | unit        | Flow-level intent detection constraints                                                   |
| `apps/runtime/src/__tests__/flow-intents-digressions.test.ts`                  | unit        | Flow intent digression handling                                                           |
| `apps/runtime/src/__tests__/flow-queued-intents.test.ts`                       | unit        | Flow queued intent processing                                                             |
| `apps/runtime/src/__tests__/pinned-intent-enforcement.test.ts`                 | unit        | Pinned intent enforcement                                                                 |
| `apps/runtime/src/__tests__/on-input-multi-intent-invariant.test.ts`           | unit        | On-input multi-intent invariants                                                          |
| `apps/runtime/src/__tests__/delegation-intent-isolation.test.ts`               | unit        | Delegation intent isolation                                                               |
| `apps/runtime/src/__tests__/post-extraction-conversion.test.ts`                | unit        | Post-extraction currency/unit conversion                                                  |
| `apps/runtime/src/__tests__/post-extraction-inference.test.ts`                 | unit        | Post-extraction inference                                                                 |
| `apps/runtime/src/__tests__/post-extraction-lookup.test.ts`                    | unit        | Post-extraction lookup table matching                                                     |
| `apps/runtime/src/__tests__/js-extraction-email-currency.test.ts`              | unit        | JS-based email/currency extraction                                                        |
| `apps/runtime/src/__tests__/e2e/routing-phase5.e2e.test.ts`                    | e2e         | Live project runtime config + guided multi-intent HTTP regression                         |
| `packages/nl-parser/src/__tests__/generator.test.ts`                           | unit        | ABL generation from extraction                                                            |

---

## 11. Configuration

### Environment Variables

| Variable          | Default | Description                                        |
| ----------------- | ------- | -------------------------------------------------- |
| `NLU_SIDECAR_URL` | none    | Default sidecar URL (overridden by project config) |

### Runtime Configuration

| Config Key                          | Default         | Description                                                    |
| ----------------------------------- | --------------- | -------------------------------------------------------------- |
| `extraction.nlu_provider`           | `standard`      | NLU provider: `standard` (LLM-only) or `advanced` (ML sidecar) |
| `extraction.advanced_sidecar_url`   | none            | Sidecar service URL (required when provider is `advanced`)     |
| `extraction.strategy`               | `auto`          | Entity extraction strategy                                     |
| `extraction.correction_detection`   | `ml`            | Correction detection mode                                      |
| `multi_intent.strategy`             | `primary_queue` | Multi-intent handling strategy                                 |
| `multi_intent.max_intents`          | `3`             | Maximum intents per message                                    |
| `multi_intent.confidence_threshold` | `0.6`           | Minimum confidence for intent detection                        |
| `multi_intent.queue_max_age_ms`     | `600000`        | Intent queue entry max age before pruning                      |

### Pipeline Configuration (Defaults from `types.ts`)

| Config Key                                    | Default     | Description                                      |
| --------------------------------------------- | ----------- | ------------------------------------------------ |
| `pipeline.enabled`                            | `false`     | Whether pipeline runs before reasoning loop      |
| `pipeline.mode`                               | `parallel`  | Parallel or sequential classifier + tool filter  |
| `pipeline.model`                              | `qwen3-30b` | Fast model for classification                    |
| `pipeline.shortCircuit.enabled`               | `true`      | Enable short-circuit routing                     |
| `pipeline.shortCircuit.confidenceThreshold`   | `0.85`      | Minimum confidence for short-circuit             |
| `pipeline.toolFilter.enabled`                 | `true`      | Enable LLM-based tool filtering                  |
| `pipeline.toolFilter.maxTools`                | `6`         | Maximum tools to return from filter              |
| `pipeline.keywordVeto.enabled`                | `true`      | Enable keyword veto for short-circuit            |
| `pipeline.keywordVeto.keywords`               | `[]`        | Additional veto keywords                         |
| `pipeline.intentBridge.enabled`               | `true`      | Enable classifier-to-router bridge               |
| `pipeline.intentBridge.programmaticThreshold` | `0.85`      | Confidence needed for programmatic short-circuit |
| `pipeline.intentBridge.guidedThreshold`       | `0.5`       | Confidence needed for guided multi-intent hints  |
| `pipeline.intentBridge.outOfScopeDecline`     | `true`      | Allow pipeline to mark requests as out of scope  |
| `pipeline.intentBridge.multiIntentSignal`     | `true`      | Inject guided multi-intent hints into reasoning  |

### Tenant Plan Gating

| Plan       | Advanced NLU | Notes                    |
| ---------- | ------------ | ------------------------ |
| FREE       | No           | Standard extraction only |
| TEAM       | No           | Standard extraction only |
| BUSINESS   | No           | Standard extraction only |
| ENTERPRISE | Yes          | Full sidecar access      |

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern          | Requirement / Expectation                                                            |
| ---------------- | ------------------------------------------------------------------------------------ |
| Tenant isolation | Project runtime config scoped by tenantId + projectId at query level                 |
| Plan gating      | Advanced NLU requires Enterprise plan — enforced at route level (returns 403)        |
| Pipeline CB      | Pipeline circuit breaker scoped per tenantId to prevent cross-tenant interference    |
| Sidecar URL      | Sidecar URL configured per project (not shared), avoiding cross-project data leakage |

### Security & Compliance

- Advanced NLU (sidecar) gated by Enterprise tenant plan at the route level (returns 403 for non-Enterprise).
- Pipeline classifier prompt does not include sensitive session data — only the user message and agent target names/descriptions.
- Sidecar URL configured per project (not shared across projects), avoiding cross-project data leakage.
- Project runtime config scoped by tenantId + projectId with RBAC enforcement.
- NLU sidecar HTTP calls use configurable timeout (default 3s) to prevent hanging connections.

### Performance & Scalability

- Pipeline classifier uses a fast model (qwen3-30b) with 10s timeout, temperature 0, 300 max tokens
- NLU sidecar has 3s default timeout per request
- Pipeline circuit breaker uses LRU map (max 500 entries) with auto-eviction to prevent memory growth
- Intent queue stored on session (serializable) — no cross-pod coordination needed
- Merge module uses 15s timeout for response synthesis
- Tool filter reduces tool set to max 6 (configurable) to improve reasoning speed

### Reliability & Failure Modes

- Classifier failure falls through to full reasoning loop (returns `shouldExecuteInAgent: true`)
- Sidecar unavailability returns null (callers fall back to LLM extraction)
- Sidecar circuit breaker: 5 consecutive failures -> open -> 30s -> half-open probe -> close on success
- Pipeline circuit breaker: 3 consecutive failures -> open -> 60s -> half-open probe
- Malformed classifier JSON gracefully parsed with fallback result (`parse_failure` summary)
- Merge module falls back to simple concatenation on LLM error

### Observability

- `pipeline_classify` trace event with intents, model, latencyMs
- `pipeline_filter` trace event with originalToolCount, filteredTools, model, latencyMs
- `pipeline_short_circuit` trace event with target, confidence, intentSummary
- `pipeline_keyword_veto` trace event with matchedKeywords, vetoedTarget
- `pipeline_multi_intent` trace event with intentCount, targets, mergedTools
- `pipeline_multi_intent_short_circuit` trace event with targets, intents, confidences
- `pipeline_merge` trace event with latencyMs, agentCount, responseLength
- NLU sidecar logs at DEBUG (requests) and WARN (failures) levels
- Pipeline circuit breaker logs at INFO (half-open) and WARN (opened) levels

### Data Lifecycle

- Intent classification results are stored in session state (in-memory, persisted with session).
- Intent queue entries expire via `pruneExpired()` with configurable `queue_max_age_ms` (default 600s).
- Project runtime config persisted in MongoDB with standard document lifecycle.
- No separate retention policy for NLU data — inherits session retention.
- Pipeline circuit breaker state is in-memory only (lost on pod restart, which is acceptable behavior).

---

## 13. Delivery Plan / Work Breakdown

1. Pipeline Classifier
   1.1 Prompt building with targets, tools, routing descriptions (`classifier.ts`)
   1.2 JSON response parsing with markdown fence stripping and fallback (`parseClassifierResponse`)
   1.3 Short-circuit check with keyword veto (`shouldShortCircuit`, `checkKeywordVeto`)
   1.4 Trace event emission for classify, short-circuit, veto
2. Pipeline Orchestrator
   2.1 Target and tool name extraction from tool definitions (`extractTargets`, `extractToolNames`)
   2.2 Parallel and sequential execution modes (`runPipeline`)
   2.3 Multi-intent fan-out detection and routing
   2.4 Pipeline result building with filtered tools
3. Pipeline Infrastructure
   3.1 Config resolution cascade: agent IR -> project -> defaults (`config.ts`)
   3.2 Per-tenant circuit breaker with LRU eviction (`circuit-breaker.ts`)
   3.3 Tool filter via fast LLM call (`tool-filter.ts`)
   3.4 Fan-out response merge with streaming support (`merge.ts`)
4. NLU Sidecar Client
   4.1 Entity extraction HTTP client (`POST /extract`)
   4.2 Correction detection HTTP client (`POST /detect-correction`)
   4.3 Circuit breaker state machine (closed -> open -> half-open)
   4.4 Per-session client creation from project config
5. Multi-Intent System
   5.1 Strategy resolution by agent type and relationship (`multi-intent-strategy.ts`)
   5.2 Intent queue operations: enqueue, dequeue, prune, max size (`intent-queue.ts`)
   5.3 Routing executor integration for multi-intent dispatch
6. nl-parser Package
   6.1 NL-to-structured extraction (Anthropic API) for agents and supervisors (`extractor.ts`)
   6.2 ABL DSL generation from extraction results (`generator.ts`)
   6.3 Zod validation schemas for extraction types (`types.ts`)

---

## 14. Success Metrics

| Metric                          | Baseline | Target | How Measured                                           |
| ------------------------------- | -------- | ------ | ------------------------------------------------------ |
| Classification accuracy         | N/A      | > 85%  | Pipeline trace events — short-circuit success rate     |
| Classification latency          | N/A      | < 1s   | `pipeline_classify` trace event latencyMs              |
| Sidecar availability            | N/A      | > 99%  | Circuit breaker open-state frequency                   |
| Multi-intent detection accuracy | N/A      | > 80%  | Manual evaluation of multi-intent dispatch correctness |
| Entity extraction accuracy      | N/A      | > 90%  | Sidecar extraction confidence scores                   |
| Pipeline circuit breaker rate   | N/A      | < 1%   | `pipeline-circuit-breaker` WARN log frequency          |

---

## 15. Open Questions

1. Should the pipeline classifier include conversation history for context (currently single-turn only)?
2. Should flow keyword detection and classifier taxonomy converge further now that both feed the shared `ResolvedMultiIntentPlan` model?
3. Should the nl-parser support provider-neutral LLM backends beyond Anthropic?
4. Should the pipeline circuit breaker be moved to Redis for cross-pod state sharing?
5. Should tool filter results be cached per-session to avoid redundant LLM calls on follow-up messages?

---

## 16. Implementation Status (as of 2026-04-15)

**Status rationale**: BETA — guided multi-intent and routing remain broadly implemented with real public HTTP regression coverage. Entity semantics and runtime observation work now have their own canonical child feature docs, while the NLU sidecar is still a stub and the broader public-API E2E matrix remains narrow.

### Fully Implemented

- Pipeline classifier (`classifier.ts`) — prompt building, JSON parsing, short-circuit, keyword veto
- Pipeline orchestrator (`index.ts`) — parallel/sequential modes, fan-out detection
- Intent bridge + shared multi-intent router — classifier output now preserves executable targets into `multi-intent/multi-intent-router.ts`
- Tiered resolver (`tiered-resolver.ts`, 180 LOC) — `resolveTieredAction()` with Tier 1/2/3 discrimination
- Circuit breaker (`circuit-breaker.ts`) — per-tenant, LRU-evicted
- Response merge (`merge.ts`) — streaming + non-streaming fan-out synthesis
- Tool filter (`tool-filter.ts`) — LLM-based tool set reduction
- NLU sidecar client (`sidecar-client.ts`) — HTTP client with self-contained circuit breaker
- Intent queue (`intent-queue.ts`) — enqueue/dedup, dequeue, prune, max size
- Multi-intent strategy + router (`multi-intent-strategy.ts`, `multi-intent/multi-intent-router.ts`) — auto/parallel/sequential/disambiguate plus canonical plan building
- Reasoning + flow execution wiring — guided reasoning dispatch and flow `ON_INPUT` now converge on the shared planner
- Project runtime config — routes plus resolver mapping for the full `pipeline` block, including `intentBridge`
- nl-parser package — NL-to-ABL extraction + generation via Anthropic API
- Compiler NLU engine (`packages/compiler/src/platform/nlu/`, 32 files, 5,753 LOC) — tasks (intent detection, entity extraction, category classification, correction detection, digression detection, language detection), embeddings, enterprise features (cache, audit, PII guard, tenant manager), prompt templates
- Deterministic public-HTTP regression — `routing-phase5.e2e.test.ts` covers live project runtime config, classifier guidance, shared multi-intent planning, and merge traces
- Canonical child feature split — semantic entity registry, `ENTITIES` / `ENTITY_REF`, and observation-pipeline documentation now live under `entity-extraction.*`

### Stub / Incomplete

- **NLU sidecar Python app** (`apps/nlu-sidecar/app.py`, 45 lines) — Flask endpoints return empty results with TODO comments; no real ML models (Kore.ai, spaCy) are wired

### Partially Implemented

- **E2E matrix** — one real HTTP scenario is implemented, but single-intent short-circuit, keyword veto, sidecar extraction, classifier-failure fallback, and circuit-breaker flows still lack public-API coverage
- **Real sidecar ML models** — sidecar returns empty; all sidecar tests mock `fetch`

---

## 17. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                         | Severity | Status    |
| ------- | ------------------------------------------------------------------------------------------------------------------- | -------- | --------- |
| GAP-001 | Reasoning-path multi-intent divergence has been closed by the shared router and target-preserving bridge            | N/A      | Resolved  |
| GAP-002 | Public-API E2E now covers guided multi-intent, but most pipeline scenarios still lack HTTP/WebSocket coverage       | High     | Partial   |
| GAP-003 | No real LLM integration tests for classifier (tests mock `generateText`)                                            | Medium   | Open      |
| GAP-004 | Parallel multi-intent strategy only works for supervisor agents                                                     | Low      | By design |
| GAP-005 | nl-parser requires Anthropic API key (no provider-neutral fallback)                                                 | Low      | Open      |
| GAP-006 | Pipeline classifier prompt does not include conversation history (single-turn only)                                 | Medium   | Open      |
| GAP-007 | No real sidecar integration tests (all sidecar tests mock fetch)                                                    | High     | Open      |
| GAP-008 | Pipeline circuit breaker is in-memory only (state lost on pod restart)                                              | Low      | By design |
| GAP-009 | Keyword veto uses simple word-boundary regex, not NLP-based detection                                               | Low      | Open      |
| GAP-010 | NLU sidecar is a stub: `apps/nlu-sidecar/app.py` returns empty results with TODO comments — no real ML models wired | High     | Open      |

---

## 18. Testing & Validation

### Required Test Coverage

| #   | Scenario                                 | Coverage Type | Status     | Test File / Note                                                                                |
| --- | ---------------------------------------- | ------------- | ---------- | ----------------------------------------------------------------------------------------------- |
| 1   | Sidecar entity extraction                | unit          | PASS       | `nlu-sidecar-client.test.ts`                                                                    |
| 2   | Circuit breaker states                   | unit          | PASS       | `nlu-sidecar-client.test.ts`, `nlu-sidecar-half-open-probe.test.ts`                             |
| 3   | Enterprise plan gating                   | unit          | PASS       | `nlu-provider-gating.test.ts`                                                                   |
| 4   | Pipeline classifier                      | unit          | PASS       | `pipeline-classifier.test.ts`                                                                   |
| 5   | Pipeline orchestrator                    | unit          | PASS       | `pipeline-executor.test.ts`                                                                     |
| 6   | Pipeline config resolution               | unit          | PASS       | `pipeline-config.test.ts`                                                                       |
| 7   | Pipeline circuit breaker                 | unit          | PASS       | `pipeline-circuit-breaker.test.ts`                                                              |
| 8   | Multi-intent strategy                    | unit          | PASS       | `routing/multi-intent-strategy.test.ts`                                                         |
| 9   | Intent queue operations                  | unit          | PASS       | `intent-queue.test.ts`, `intent-queue-expanded.test.ts`, `intent-queue-max-intents.test.ts`     |
| 10  | ABL generation                           | unit          | PASS       | `packages/nl-parser generator.test.ts`                                                          |
| 11  | Multi-intent integration                 | integration   | PASS       | `routing/multi-intent-integration.test.ts`, `routing/multi-intent-executor-integration.test.ts` |
| 12  | Guided planning + runtime config bridge  | integration   | PASS       | `execution/reasoning-pipeline-bridge.test.ts`, `project-runtime-config-resolver.test.ts`        |
| 13  | E2E: guided multi-intent via public HTTP | e2e           | PARTIAL    | `e2e/routing-phase5.e2e.test.ts`                                                                |
| 14  | E2E: sidecar with real ML service        | e2e           | NOT TESTED | Tests mock fetch, no real sidecar                                                               |

### Testing Notes

Extensive unit test coverage exists across classifier/orchestrator/config/circuit-breaker/tool-filter/sidecar/multi-intent/extraction/nl-parser modules. Integration coverage now includes the shared multi-intent router and live runtime-config bridge. The main remaining E2E gaps are breadth gaps: only guided multi-intent has a public-API regression today, and the sidecar is still a stub with no real-service test path.

> Full testing details: [docs/testing/nlu.md](../testing/nlu.md)
>
> Related child guide: [docs/testing/entity-extraction.md](../testing/entity-extraction.md)

---

## 19. References

- Child feature: [docs/features/entity-extraction.md](./entity-extraction.md)
- Child testing guide: [docs/testing/entity-extraction.md](../testing/entity-extraction.md)
- Child HLD: [docs/specs/entity-extraction.hld.md](../specs/entity-extraction.hld.md)
- Child LLD: [docs/plans/entity-extraction.lld.md](../plans/entity-extraction.lld.md)
- HLD: `docs/specs/nlu.hld.md`
- LLD: `docs/plans/nlu.lld.md`
- Pipeline types: `apps/runtime/src/services/pipeline/types.ts`
- Pipeline orchestrator: `apps/runtime/src/services/pipeline/index.ts`
- Pipeline classifier: `apps/runtime/src/services/pipeline/classifier.ts`
- Pipeline circuit breaker: `apps/runtime/src/services/pipeline/circuit-breaker.ts`
- Pipeline merge: `apps/runtime/src/services/pipeline/merge.ts`
- Pipeline intent bridge: `apps/runtime/src/services/pipeline/intent-bridge.ts`
- Pipeline tiered resolver: `apps/runtime/src/services/pipeline/tiered-resolver.ts`
- NLU sidecar client: `apps/runtime/src/services/nlu/sidecar-client.ts`
- Multi-intent strategy: `apps/runtime/src/services/execution/multi-intent-strategy.ts`
- Intent queue: `apps/runtime/src/services/execution/intent-queue.ts`
- nl-parser package: `packages/nl-parser/src/`
- Compiler NLU engine: `packages/compiler/src/platform/nlu/` (32 files, 5,753 LOC)
- NLU sidecar (stub): `apps/nlu-sidecar/app.py`

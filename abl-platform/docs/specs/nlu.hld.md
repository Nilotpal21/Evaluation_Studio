# NLU / Intent Classification & Entity Extraction — High-Level Design

**Feature**: NLU
**Status**: APPROVED
**Last Updated**: 2026-04-15
**Feature Spec**: [docs/features/nlu.md](../features/nlu.md)
**Test Spec**: [docs/testing/nlu.md](../testing/nlu.md)
**Related Child HLD**: [docs/specs/entity-extraction.hld.md](./entity-extraction.hld.md)

---

## 1. Problem Statement

Multi-agent systems need to understand user intent and extract structured entities from natural language input. Without a dedicated NLU layer, all classification and extraction relies solely on the primary LLM's reasoning loop, which is slow (3-10s per turn), expensive (full-model inference for every message), and cannot apply programmatic routing rules. The pipeline classifier enables sub-second routing decisions. ML-based entity extraction via a sidecar service provides higher accuracy for structured data types. Multi-intent detection allows compound user messages to be decomposed and dispatched to multiple specialist agents.

### Post-Implementation Notes (2026-04-15)

- Guided reasoning multi-intent, classifier-driven fan-out, and flow `ON_INPUT` routing now converge on the shared `multi-intent/multi-intent-router.ts` planner.
- `project-runtime-config-resolver.ts` now maps the full project `pipeline` block, including `intentBridge`, into IR, so live config updates participate in execution without ad hoc patching.
- The feature now has a deterministic public-HTTP regression for guided multi-intent through `/api/v1/chat/agent`, but the broader public-API matrix is still partial.
- The Python sidecar remains a stub, so the feature lifecycle stays BETA even though the architecture and docs are now aligned.
- Canonical semantic-entity and observation-pipeline design ownership moved into the child HLD `entity-extraction.hld.md`; this NLU HLD remains the routing / classifier umbrella.

---

## Implementation Status

| Component                  | Status  | Details                                                                                              |
| -------------------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| Pipeline classifier        | DONE    | `pipeline/classifier.ts` — LLM intent classification, prompt building, JSON parsing, keyword veto    |
| Pipeline orchestrator      | DONE    | `pipeline/index.ts` — parallel/sequential execution, short-circuit, fan-out                          |
| Intent bridge              | DONE    | `pipeline/intent-bridge.ts` — target-aware bridge from ClassifierResult to shared multi-intent types |
| Tiered resolver            | DONE    | `pipeline/tiered-resolver.ts` — 180 LOC, resolves Tier 1/2/3 actions from PipelineResult             |
| Pipeline circuit breaker   | DONE    | `pipeline/circuit-breaker.ts` — per-tenant LRU with open/closed/half-open states                     |
| Tool filter                | DONE    | `pipeline/tool-filter.ts` — LLM-based tool set reduction                                             |
| Merge module               | DONE    | `pipeline/merge.ts` — fan-out response synthesis                                                     |
| Pipeline config resolution | DONE    | `pipeline/config.ts` — agent IR -> project config -> defaults cascade                                |
| Pipeline types             | DONE    | `pipeline/types.ts` — PipelineConfig (incl. `intentBridge` field), TieredAction, GuidedHints, traces |
| NLU sidecar client         | DONE    | `nlu/sidecar-client.ts` — TypeScript HTTP client with circuit breaker                                |
| NLU sidecar server         | STUB    | `apps/nlu-sidecar/app.py` — Python Flask app, returns empty responses (TODO: wire ML models)         |
| Intent queue               | DONE    | `execution/intent-queue.ts` — session-serialized queue with dedup, expiry, max size                  |
| Multi-intent strategy      | DONE    | `execution/multi-intent-strategy.ts` — auto/parallel/sequential/disambiguate resolution              |
| Multi-intent router        | DONE    | `execution/multi-intent/multi-intent-router.ts` — canonical plan builder for pipeline/reasoning/flow |
| Project runtime config     | DONE    | Routes, resolver, DB model — full CRUD with tenant isolation                                         |
| Compiler NLU engine        | DONE    | `packages/compiler/src/platform/nlu/` — 34 files, 5,753 LOC (tasks, embeddings, enterprise, prompts) |
| nl-parser                  | DONE    | `packages/nl-parser/src/` — Anthropic API extraction + ABL DSL generation                            |
| Unit tests                 | DONE    | 35+ test files including `pipeline-intent-bridge.test.ts` and `pipeline-tiered-resolver.test.ts`     |
| Integration tests          | DONE    | 3+ test files covering multi-intent dispatch and executor integration                                |
| E2E tests                  | PARTIAL | Guided multi-intent HTTP regression exists; the broader matrix is still planned                      |

---

## 2. Alternatives Considered

### Alternative A: LLM-Only NLU (No Separate Classifier)

**Description**: Rely entirely on the agent's primary LLM to perform intent classification as part of the reasoning loop. No pre-reasoning pipeline.

**Pros**: Simpler architecture, no extra model dependency, no pipeline latency. Full context available (tools, history).

**Cons**: Slow (3-10s per classification vs < 1s with pipeline). Expensive (full model inference). Cannot short-circuit routing. Cannot do multi-intent fan-out before reasoning.

**Effort**: S (already the fallback behavior)

### Alternative B: Dedicated Classification Microservice

**Description**: Build a standalone NLU classification microservice (Python/FastAPI) with trained models for intent classification and entity extraction.

**Pros**: Purpose-built models for higher accuracy. Language-agnostic. Could serve multiple platforms.

**Cons**: Major infrastructure cost (model training, deployment, versioning). Adds network hop latency. Requires ML engineering expertise. Over-engineered for current scale.

**Effort**: L

### Alternative C: Fast Pipeline Classifier + Optional ML Sidecar (Selected)

**Description**: Use a fast, lightweight LLM (qwen3-30b) for intent classification in a pre-reasoning pipeline, with an optional ML sidecar for entity extraction and correction detection. The pipeline runs before the reasoning loop and can short-circuit routing for high-confidence classifications.

**Pros**: Sub-second classification (10s timeout, but typically < 1s). Short-circuit routing avoids the full reasoning loop. ML sidecar provides specialized extraction accuracy. Tiered architecture (pipeline -> sidecar -> LLM fallback). Enterprise plan gating for cost control.

**Cons**: Adds a model dependency (pipeline model). Sidecar requires separate deployment. Two circuit breakers to maintain. Pipeline prompt is single-turn (no conversation history).

**Effort**: M

### Recommendation

**Alternative C** was selected because it provides the best balance of speed, accuracy, and cost. The fast pipeline classifier handles the common case (single-intent routing) in sub-second time while the reasoning loop remains available as a fallback. The ML sidecar is opt-in (Enterprise only) and provides specialized extraction for structured data types that LLMs handle inconsistently. The tiered architecture degrades gracefully — any layer can fail without breaking the system.

---

## 3. Architecture

### System Context Diagram

```
                              ┌──────────────────────────────────┐
                              │          User / Channel           │
                              └──────────┬───────────────────────┘
                                         │ WebSocket / HTTP
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Runtime (Express + WS)                              │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │                    Pre-Reasoning Pipeline                             │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐                │    │
│  │  │  Classifier  │  │ Tool Filter │  │Circuit Breaker│                │    │
│  │  │  (qwen3-30b) │  │ (qwen3-30b) │  │ (per-tenant)  │                │    │
│  │  └──────┬──────┘  └──────┬──────┘  └──────────────┘                │    │
│  │         │ ClassifierResult│ ToolFilterResult                         │    │
│  │         ▼                 ▼                                          │    │
│  │  ┌──────────────────────────────────────┐                           │    │
│  │  │       Pipeline Orchestrator           │                           │    │
│  │  │  (parallel/sequential, short-circuit, │                           │    │
│  │  │   fan-out, result building)           │                           │    │
│  │  └──────────────┬───────────────────────┘                           │    │
│  └─────────────────┼────────────────────────────────────────────────────┘    │
│                    │ PipelineResult                                           │
│                    ▼                                                          │
│  ┌─────────────────────────────────────┐                                     │
│  │     Short-Circuit?                    │                                     │
│  │  yes: handoff/fan-out directly       │                                     │
│  │  no:  enter reasoning loop           │                                     │
│  └──────────────┬──────────────────────┘                                     │
│                 │                                                              │
│     ┌───────────┼───────────────────┐                                         │
│     ▼                               ▼                                         │
│  ┌──────────┐              ┌──────────────────┐                              │
│  │ Reasoning │              │  Fan-Out Targets  │                              │
│  │ Executor  │              │ (multi-intent)    │──▶ Sub-Agent A               │
│  └──────────┘              │                    │──▶ Sub-Agent B               │
│     │                       └────────┬─────────┘                              │
│     ▼                                ▼                                         │
│  ┌──────────────┐         ┌──────────────────┐                                │
│  │ Gather Mode?  │         │  Merge Module     │                                │
│  │ (extraction)  │         │  (response synth)  │                                │
│  └──────┬───────┘         └──────────────────┘                                │
│         │                                                                      │
│         ▼                                                                      │
│  ┌──────────────────────────┐          ┌──────────────────────┐              │
│  │  Extraction Pipeline      │          │  External NLU Sidecar │              │
│  │  (tiered: regex/LLM/      │───HTTP──▶│  (Python ML service)  │              │
│  │   sidecar)                │          │  /extract             │              │
│  │                            │          │  /detect-correction   │              │
│  │  ┌────────────────────┐   │          └──────────────────────┘              │
│  │  │ Circuit Breaker     │   │                                                │
│  │  │ (sidecar-level)     │   │                                                │
│  │  └────────────────────┘   │                                                │
│  └────────────────────────────┘                                                │
│                                                                                 │
│  ┌──────────────────────────┐                                                  │
│  │  Multi-Intent System      │                                                  │
│  │  ┌───────────────────┐    │                                                  │
│  │  │ Strategy Resolver  │    │                                                  │
│  │  │ (auto/parallel/    │    │                                                  │
│  │  │  sequential/disamb)│    │                                                  │
│  │  └───────────────────┘    │                                                  │
│  │  ┌───────────────────┐    │                                                  │
│  │  │ Intent Queue       │    │                                                  │
│  │  │ (session-serialized)│   │                                                  │
│  │  └───────────────────┘    │                                                  │
│  └────────────────────────────┘                                                 │
│                                                                                 │
│  ┌──────────────────────────┐                                                  │
│  │  nl-parser Package        │                                                  │
│  │  (NL → ABL extraction)    │───HTTP──▶ Anthropic API (claude-sonnet-4-20250514)│
│  └────────────────────────────┘                                                 │
│                                                                                 │
│  ┌──────────────────────────┐                                                  │
│  │  Config Resolution        │                                                  │
│  │  Agent IR → Project →     │───DB────▶ MongoDB (project_runtime_configs)      │
│  │  Defaults                 │                                                  │
│  └────────────────────────────┘                                                 │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### Component Diagram

```
apps/runtime/src/services/
├── pipeline/
│   ├── classifier.ts       — LLM intent classification
│   ├── index.ts            — Pipeline orchestrator
│   ├── config.ts           — Config resolution cascade
│   ├── types.ts            — Type definitions + defaults (incl. IntentBridgeConfig)
│   ├── intent-bridge.ts    — Maps ClassifierResult → session state + MultiIntentResult
│   ├── tiered-resolver.ts  — Resolves TieredAction (Tier 1/2/3) from PipelineResult
│   ├── tool-filter.ts      — LLM tool filtering
│   ├── circuit-breaker.ts  — Per-tenant pipeline CB
│   └── merge.ts            — Fan-out response synthesis
├── nlu/
│   ├── sidecar-client.ts   — ML sidecar HTTP + CB
│   └── currency-rate-client.ts — Exchange rate client
├── execution/
│   ├── multi-intent-strategy.ts — Strategy resolution
│   ├── multi-intent/multi-intent-router.ts — Canonical plan builder/dispatcher
│   ├── multi-intent/multi-intent-types.ts — Target-preserving intent and plan types
│   └── intent-queue.ts     — Session-serialized queue
└── config/
    └── project-runtime-config-resolver.ts — DB config loader

packages/nl-parser/src/
├── extractor.ts            — Anthropic API extraction
├── generator.ts            — ABL DSL generation
├── types.ts                — Zod schemas
├── prompts/
│   ├── agent.ts            — Agent extraction prompt
│   └── supervisor.ts       — Supervisor extraction prompt
└── index.ts                — Package entry point
```

### Data Flow: Single-Intent Short-Circuit

1. User sends message via WebSocket.
2. Runtime resolves pipeline config: agent IR -> project config -> defaults.
3. Pipeline circuit breaker checked for tenant — if open, skip pipeline entirely.
4. Classifier LLM call (qwen3-30b, 10s timeout, temperature 0).
5. Response parsed: `ClassifierResult { intents, shouldExecuteInAgent, matchedTools }`.
6. Short-circuit check: single intent + confidence >= 0.85 + target not null.
7. Keyword veto check: user message scanned for tool-name-derived keywords.
8. If short-circuit eligible: `PipelineResult.shortCircuit = true`, handoff directly to target agent.
9. Target agent processes message. Response returned to user.

### Data Flow: Multi-Intent Fan-Out

1. Steps 1-5 same as above.
2. Multiple intents detected, all with targets and confidence >= threshold.
3. `PipelineResult.fanOutTargets` populated with `{ target, intent }` per intent.
4. Each sub-agent receives its respective sub-request in parallel.
5. Sub-agent responses collected.
6. Merge module synthesizes responses using pipeline model (qwen3-30b, 15s timeout).
7. Merged response returned to user.

### Data Flow: Entity Extraction (Gather Mode)

1. Agent enters gather mode (collecting structured fields).
2. User sends message with entities: "My name is John, email john@example.com".
3. Extraction pipeline runs tiered strategy:
   a. Regex extraction (fast, pattern-based).
   b. LLM extraction (primary model).
   c. Sidecar extraction (if `nlu_provider: "advanced"` and Enterprise plan).
4. Sidecar client checks circuit breaker state before HTTP call.
5. `POST /extract` to sidecar with `{ text, fields, locale }`.
6. Extracted entities populate gather fields.

---

## 4. The 12 Architectural Concerns

### Structural Concerns

#### 1. Tenant Isolation

- Project runtime config queried with `findOne({ tenantId, projectId })` — never by ID alone.
- Pipeline circuit breaker state scoped per `tenantId` (Map key = tenantId).
- NLU sidecar URL configured per project (not shared across projects).
- Cross-tenant access to project runtime config returns 404 (not 403).
- Enterprise plan gating checked per tenant before allowing advanced NLU.

#### 2. Data Access Pattern

- **Project runtime config**: Direct Mongoose model access via `ProjectRuntimeConfig.findOne({ tenantId, projectId }).lean()` in `project-runtime-config-resolver.ts`. No repository abstraction — follows existing runtime pattern.
- **Pipeline config**: Resolved in-memory from agent IR + project config + defaults via `resolvePipelineConfig()`. No DB access.
- **Intent queue**: Pure in-memory data structure serialized on the session object. No separate storage.
- **Circuit breaker state**: In-memory `Map<string, BreakerState>` with LRU eviction. Lost on pod restart (acceptable — resets to closed).
- **Caching**: Pipeline circuit breaker uses LRU map (max 500 entries). Currency rate client uses in-memory cache with TTL. No Redis caching for NLU data.

#### 3. API Contract

- **Project runtime config API**:
  - `GET /api/projects/:projectId/runtime-config` -> `{ success: true, data: ProjectRuntimeConfig }`
  - `PUT /api/projects/:projectId/runtime-config` -> `{ success: true, data: ProjectRuntimeConfig }`
  - Error: `{ success: false, error: { code: string, message: string } }`
- **NLU sidecar API** (external):
  - `POST /extract` -> `{ entities: Record, confidence: Record }`
  - `POST /detect-correction` -> `{ is_correction, field, new_value, confidence }`
  - `GET /health` -> 200 OK
- **Internal interfaces**: All pipeline functions use typed parameters and return typed results. No dynamic dispatch.

#### 4. Security Surface

- **Auth**: Project runtime config routes use `requireProjectPermission(req, res, 'project:write')`. Pipeline runs under existing session auth.
- **Input validation**: Pipeline classifier prompt is constructed server-side (user cannot inject targets). Keyword veto uses regex with proper escaping (`kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`).
- **SSRF prevention**: Sidecar URL configured via project runtime config (admin-only write). Not user-controllable.
- **Encryption**: No NLU-specific encryption. Sidecar URL stored in project config (MongoDB, encrypted at rest). Session state (including intent queue) follows existing session encryption.
- **Plan gating**: Advanced NLU requires Enterprise plan — enforced at route level, returns 403.

### Behavioral Concerns

#### 5. Error Model

| Error Scenario                    | Behavior                                        | User Experience                                  |
| --------------------------------- | ----------------------------------------------- | ------------------------------------------------ |
| Classifier LLM call fails         | Falls through to reasoning loop (Tier 3)        | Slightly slower response, but correct            |
| Classifier returns malformed JSON | Parsed with fallback (`parse_failure` summary)  | Falls through to reasoning loop                  |
| Sidecar unavailable               | Returns null, LLM extraction used instead       | Slightly less accurate extraction                |
| Sidecar returns 500               | Recorded as failure, circuit breaker increments | Same as unavailable                              |
| Pipeline circuit open             | Pipeline skipped entirely                       | Full reasoning loop used (slower but functional) |
| Merge LLM call fails              | Falls back to response concatenation            | Less polished multi-intent response              |
| Config resolution fails           | Defaults used (graceful degradation)            | Pipeline uses default config                     |

#### 6. Failure Modes

- **Sidecar circuit breaker**: CLOSED -> OPEN after 5 consecutive failures -> HALF_OPEN after 30s -> probe success returns to CLOSED, probe failure returns to OPEN. Single probe request allowed in half-open to prevent thundering herd.
- **Pipeline circuit breaker**: Per-tenant, 3-failure threshold, 60s reset. LRU eviction at 500 entries. State lost on pod restart (resets to closed, which is safe).
- **Merge module**: 15s timeout. On failure, concatenates responses (graceful degradation).
- **No cascading failures**: Pipeline and sidecar operate independently. Pipeline failure does not affect sidecar. Sidecar failure does not affect pipeline.

#### 7. Idempotency

- **Pipeline classification**: Idempotent — same input produces same classification (temperature 0, deterministic).
- **Intent queue operations**: Not idempotent for enqueue (duplicate detection by name, higher confidence wins). Dequeue is destructive (removes entry).
- **Project config writes**: PUT is idempotent (full replacement).
- **Sidecar requests**: Stateless HTTP calls — naturally idempotent.

#### 8. Observability

8 pipeline trace event types emitted to the trace store:

| Trace Event                           | When                                  | Key Data                                           |
| ------------------------------------- | ------------------------------------- | -------------------------------------------------- |
| `pipeline_classify`                   | After classifier LLM call             | intents, model, latencyMs                          |
| `pipeline_filter`                     | After tool filter LLM call            | originalToolCount, filteredTools, model, latencyMs |
| `pipeline_short_circuit`              | When short-circuit fires              | target, confidence, intentSummary                  |
| `pipeline_keyword_veto`               | When veto prevents short-circuit      | matchedKeywords, vetoedTarget                      |
| `pipeline_multi_intent`               | When multi-intent detected            | intentCount, targets, mergedTools                  |
| `pipeline_multi_intent_short_circuit` | When multi-intent short-circuit fires | targets, intents, confidences                      |
| `pipeline_merge`                      | After merge LLM call                  | latencyMs, agentCount, responseLength              |
| (sidecar logs)                        | On sidecar requests/failures          | url, path, status, error                           |

Pipeline circuit breaker emits structured logs at INFO (half-open) and WARN (opened) levels.

### Operational Concerns

#### 9. Performance Budget

| Operation               | Latency Target | Timeout                                       | Notes                                    |
| ----------------------- | -------------- | --------------------------------------------- | ---------------------------------------- |
| Pipeline classification | < 1s           | 10s                                           | qwen3-30b, temperature 0, 300 max tokens |
| Tool filtering          | < 1s           | 10s (shared with classifier in parallel mode) | Same model                               |
| Sidecar extraction      | < 500ms        | 3s                                            | ML model inference                       |
| Sidecar correction      | < 500ms        | 3s                                            | ML model inference                       |
| Response merge          | < 2s           | 15s                                           | qwen3-30b, 500 max tokens                |
| Config resolution       | < 5ms          | N/A                                           | In-memory cascade                        |
| Intent queue ops        | < 1ms          | N/A                                           | Pure in-memory                           |

#### 10. Migration Path

**Current state**: Pipeline classifier, intent bridge, tiered resolver, multi-intent router, sidecar client, compiler NLU engine, and nl-parser are implemented and broadly tested. The sidecar server is still a stub, and only one deterministic public-HTTP E2E slice exists today.

**Target state**: Broader public-API E2E coverage for the full NLU pipeline plus a real sidecar implementation.

**Migration**: No data migration needed. Feature is additive (pipeline disabled by default). Existing deployments unaffected until pipeline is explicitly enabled.

#### 11. Rollback Plan

- **Pipeline**: Set `pipeline.enabled = false` in agent IR or project config. System falls through to reasoning loop immediately.
- **Sidecar**: Set `extraction.nlu_provider = "standard"` in project runtime config. LLM extraction used instead.
- **Multi-intent**: Set `multi_intent.enabled = false` in project runtime config. Single-intent processing only.
- **All changes are config-driven** — no code deployment needed for rollback.

#### 12. Test Strategy

| Layer       | Count          | Coverage                                                                                                                        |
| ----------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | 35+ test files | All modules: classifier, orchestrator, config, CB, filter, intent bridge, tiered resolver, sidecar, queue, strategy, extraction |
| Integration | 3+ test files  | Multi-intent dispatch, sidecar config wiring, executor integration                                                              |
| E2E         | 1 partial      | Guided multi-intent via `/api/v1/chat/agent`; broader pipeline routing, sidecar, fallback, veto, CB, isolation remain planned   |

**Coverage target**: Maintain unit/integration pass rate, keep the shipped HTTP regression green, and expand the remaining public-API scenarios incrementally.

**Test approach**: Unit tests mock LLM calls and HTTP. Integration tests wire real modules together. E2E tests use real servers with test doubles for external services (sidecar, LLM).

---

## 5. Data Model

### New Collections/Tables

None. NLU uses the existing `project_runtime_configs` collection.

### Modified Collections/Tables

**project_runtime_configs** — NLU fields within the existing document:

```text
extraction:
  strategy: 'auto' | 'llm' | 'regex' | 'sidecar'
  nlu_provider: 'standard' | 'advanced'
  advanced_sidecar_url: string
  advanced_sidecar_timeout_ms: number
  advanced_sidecar_circuit_breaker_threshold: number
  correction_detection: 'ml' | 'regex' | 'off'
  sidecar_timeout_ms: number
  sidecar_circuit_breaker_threshold: number

multi_intent:
  enabled: boolean
  strategy: 'primary_queue' | 'sequential' | 'parallel' | 'disambiguate'
  max_intents: number
  confidence_threshold: number
  queue_max_age_ms: number
```

### In-Memory Structures

- `PipelineConfig`: Resolved from agent IR + project config + defaults
- `IntentQueue`: Serialized on session, array of `PendingIntentEntry`
- `BreakerState` (pipeline CB): `Map<tenantId, { consecutiveFailures, isOpen, openedAt }>`
- `NLUSidecarClient`: Per-session instance with its own circuit breaker state

### Key Relationships

- Pipeline config -> Agent IR (`IRExecutionConfig.pipeline`)
- Pipeline config -> Project runtime config (MongoDB)
- Intent queue -> Session state (serialized)
- Sidecar client -> Project runtime config (`extraction` fields)
- Plan gating -> Tenant config (`advancedNlu` feature flag)

---

## 6. API Design

### Existing Endpoints (NLU-Relevant)

| Method | Path                                      | Purpose                                           | Auth                   |
| ------ | ----------------------------------------- | ------------------------------------------------- | ---------------------- |
| POST   | `/api/v1/chat/agent`                      | Execute chat through live pipeline + routing path | `session:send_message` |
| GET    | `/api/projects/:projectId/runtime-config` | Read project NLU config                           | `project:read`         |
| PUT    | `/api/projects/:projectId/runtime-config` | Update project NLU config                         | `project:write`        |

### External API (NLU Sidecar)

| Method | Path                 | Purpose              | Auth                    |
| ------ | -------------------- | -------------------- | ----------------------- |
| POST   | `/extract`           | Entity extraction    | None (internal service) |
| POST   | `/detect-correction` | Correction detection | None (internal service) |
| GET    | `/health`            | Health check         | None                    |

### Error Responses

| Status | Code               | When                                                  |
| ------ | ------------------ | ----------------------------------------------------- |
| 403    | `PLAN_RESTRICTION` | Non-Enterprise tenant sets `nlu_provider: "advanced"` |
| 404    | `NOT_FOUND`        | Cross-tenant access to project runtime config         |
| 400    | `VALIDATION_ERROR` | Invalid config values                                 |

---

## 7. Cross-Cutting Concerns

### Audit Logging

No NLU-specific audit logging. Pipeline trace events provide observability. Project runtime config changes are logged via standard API audit trail.

### Rate Limiting

No NLU-specific rate limiting. Inherits request-level rate limits from the runtime. Sidecar timeout (3s) and circuit breaker provide natural throttling.

### Caching

- Pipeline circuit breaker: In-memory LRU map (max 500 entries, per-tenant).
- Currency rate client: In-memory cache with TTL.
- No Redis caching for NLU results — classification is per-message and context-dependent.

### Encryption

- NLU data follows existing session encryption (at rest and in transit).
- Sidecar URL stored in MongoDB (encrypted at rest via platform-level encryption).
- Pipeline classifier prompt does not include sensitive data.

---

## 8. Dependencies

### Upstream (This Feature Depends On)

| Dependency                              | Risk   | Notes                                                                                  |
| --------------------------------------- | ------ | -------------------------------------------------------------------------------------- |
| Vercel AI SDK (`ai` package)            | Low    | Stable, well-maintained. Used for `generateText`/`streamText` in classifier and merge. |
| `@anthropic-ai/sdk`                     | Low    | Used by nl-parser only. Stable.                                                        |
| `@abl/compiler` IR types                | Low    | Internal. IR schema defines pipeline config shape.                                     |
| `@agent-platform/database`              | Low    | Internal. ProjectRuntimeConfig model.                                                  |
| External NLU sidecar (Python)           | Medium | Separate deployment. Circuit breaker mitigates availability risk.                      |
| External exchange rate API              | Low    | Currency client only. Static fallback available.                                       |
| Pipeline model availability (qwen3-30b) | Medium | Model must be accessible via LLM provider chain. Pipeline CB mitigates.                |

### Downstream (Depends On This Feature)

| Consumer              | Impact | Notes                                               |
| --------------------- | ------ | --------------------------------------------------- |
| Reasoning Executor    | High   | Consumes `PipelineResult` to decide execution path. |
| Routing Executor      | High   | Receives multi-intent dispatch commands.            |
| Gather System         | Medium | Entity extraction results populate gather fields.   |
| Studio Arch Assistant | Medium | Uses nl-parser for NL-to-ABL conversion.            |
| Trace Store           | Low    | Receives pipeline trace events.                     |

---

## 9. Open Questions & Decisions Needed

1. Should the pipeline classifier include conversation history for context (currently single-turn only)?
2. Should flow keyword detection and classifier taxonomy converge further now that both paths use the shared multi-intent plan model?
3. Should the nl-parser support provider-neutral LLM backends beyond Anthropic?
4. Should the pipeline circuit breaker be moved to Redis for cross-pod state sharing?
5. Should tool filter results be cached per-session to avoid redundant LLM calls?

---

## 10. References

- Feature spec: [docs/features/nlu.md](../features/nlu.md)
- Test spec: [docs/testing/nlu.md](../testing/nlu.md)
- Pipeline types: `apps/runtime/src/services/pipeline/types.ts`
- Pipeline orchestrator: `apps/runtime/src/services/pipeline/index.ts`
- Pipeline classifier: `apps/runtime/src/services/pipeline/classifier.ts`
- Intent bridge: `apps/runtime/src/services/pipeline/intent-bridge.ts`
- Tiered resolver: `apps/runtime/src/services/pipeline/tiered-resolver.ts`
- Pipeline circuit breaker: `apps/runtime/src/services/pipeline/circuit-breaker.ts`
- Pipeline merge: `apps/runtime/src/services/pipeline/merge.ts`
- NLU sidecar client: `apps/runtime/src/services/nlu/sidecar-client.ts`
- Multi-intent strategy: `apps/runtime/src/services/execution/multi-intent-strategy.ts`
- Intent queue: `apps/runtime/src/services/execution/intent-queue.ts`
- Config resolver: `apps/runtime/src/services/config/project-runtime-config-resolver.ts`
- nl-parser: `packages/nl-parser/src/`

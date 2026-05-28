# NLU Robustness & Feature Completion Design

## Overview

Three-phase initiative to replace fragile regex-based NLU components with robust ML/LLM approaches, add multi-intent recognition with configurable strategies, and complete stubbed IR features (`convert_to`, `lookup`, `infer`).

**Phases:**

1. Robust Entity Extraction Pipeline (regex → ML models + JS libs)
2. Multi-Intent Recognition (5 strategies with LLM auto mode)
3. Stubbed Feature Completion (convert_to, lookup, infer)

---

## Project Runtime Config (New Concept)

### Problem

NLU/extraction/multi-intent settings need project-level defaults that agents inherit. Currently, configs are either per-agent (in AgentIR) or per-tenant (TenantModel). There is no project-level runtime behavior config.

### Existing Project Config Landscape

| Concept                  | Collection                 | Purpose                                    | Resolved At  |
| ------------------------ | -------------------------- | ------------------------------------------ | ------------ |
| `IProject`               | `projects`                 | Metadata (name, slug, entryAgent)          | Always       |
| `IProjectConfigVariable` | `project_config_variables` | Compile-time `{{config.KEY}}` substitution | Compile time |
| `IProjectLLMConfig`      | `project_llm_configs`      | Operation-to-tier overrides                | Runtime      |
| `IModelConfig`           | `model_configs`            | Available models in project                | Runtime      |

### Solution: `ProjectRuntimeConfig`

A new model that absorbs `ProjectLLMConfig.operationTierOverrides` and adds NLU, extraction, and multi-intent defaults. Single document per (tenantId, projectId).

**Collection:** `project_runtime_configs`

```typescript
interface IProjectRuntimeConfig {
  _id: string;
  tenantId: string;
  projectId: string;

  // Absorbed from ProjectLLMConfig (backward compatible)
  operationTierOverrides?: Record<OperationType, ModelTier>;

  // Phase 1: Extraction
  extraction: {
    strategy: ExtractionStrategy; // default: 'auto'
    sidecar_url?: string; // default: from env SIDECAR_URL
    sidecar_timeout_ms: number; // default: 500
    sidecar_circuit_breaker_threshold: number; // default: 5
    correction_detection: 'ml' | 'heuristic' | 'llm'; // default: 'ml'
  };

  // Phase 2: Multi-intent
  multi_intent: {
    enabled: boolean; // default: true
    strategy: MultiIntentStrategy; // default: 'primary_queue'
    max_intents: number; // default: 3
    confidence_threshold: number; // default: 0.6
    queue_max_age_ms: number; // default: 600000 (10 min)
  };

  // Phase 3: Inference & conversion
  inference: {
    confidence: number; // default: 0.8
    confirm: boolean; // default: true
    model_tier: 'fast' | 'balanced'; // default: 'fast'
    max_fields_per_pass: number; // default: 3
  };
  conversion: {
    currency_mode: 'static' | 'live'; // default: 'static'
    currency_api_url?: string;
  };

  // Shared lookup tables
  lookup_tables: LookupTableConfig[];

  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

interface LookupTableConfig {
  name: string;
  source: 'inline' | 'mongodb' | 'http';
  values?: string[]; // inline only (< 1000 entries)
  collection?: string; // mongodb source
  endpoint?: string; // http source
  field?: string; // which field to match
  case_sensitive: boolean; // default: false
  fuzzy_match: boolean; // default: false
  fuzzy_threshold: number; // default: 0.85
}
```

### Inheritance Chain

```
Platform Defaults → ProjectRuntimeConfig → AgentIR → Field-level config
```

Resolution: field-level wins → agent-level wins → project-level wins → platform defaults.

### API & UI

- **API:** `/api/projects/:projectId/runtime-config` (GET, PUT) — follows `ProjectLLMConfig` pattern
- **Studio tab:** New "Runtime Config" tab in Project Settings (alongside Members, API Keys, Models, Config Vars, Git)
- **Backward compatibility:** Existing `/api/projects/:projectId/llm-config` becomes an alias that reads/writes `operationTierOverrides` on `ProjectRuntimeConfig`

---

## Phase 1: Robust Entity Extraction Pipeline

### Problem

Current entity extraction relies on fragile regex patterns for dates, numbers, destinations, phones, emails, and correction detection. These fail on multilingual input, natural language expressions, and formats not explicitly coded.

### Architecture

Replace the extraction hierarchy with a 4-tier pipeline:

```
Tier 1: In-Process JS Models (< 5ms)
  ├─ chrono-node         → dates (multilingual, relative, ranges, timezones)
  ├─ libphonenumber-js   → phone numbers (all countries, E.164)
  ├─ email-validator     → email (acceptable as regex)
  └─ existing regex      → kept as internal fallback within this tier only

Tier 2: Python Sidecar / Kore ML Models (5-50ms)
  ├─ Kore.ai NER         → locations, destinations, named entities
  ├─ Kore.ai number NLU  → natural language numbers ("two hundred fifty")
  └─ spaCy/custom models → domain-specific entity types

Tier 3: Fast LLM (2-5s)
  └─ _extract_entities tool call (existing, unchanged)

Tier 4: Balanced LLM Fallback (5-10s)
  └─ Same as today (existing, unchanged)
```

### Strategy Types

```typescript
type ExtractionStrategy =
  | 'auto' // Default: Tier 1 → Tier 2 → Tier 3 → Tier 4
  | 'ml' // Tier 1 + Tier 2 only (no LLM, fast + offline-capable)
  | 'llm' // Tier 3 + Tier 4 only (existing behavior)
  | 'hybrid' // DEPRECATED alias for 'auto'
  | 'pattern'; // DEPRECATED alias for 'ml'
```

### Python Sidecar

Reuse existing microservice pattern (like preprocessing service on port 8003, Docling on 8080).

**API:**

```
POST /extract
  Body: { text, fields: [{ name, type, hints }], locale }
  Response: { entities: { field_name: value }, confidence: { field_name: number } }

POST /detect-correction
  Body: { text, context, locale }
  Response: { is_correction: boolean, field?, old_value?, new_value?, confidence }

GET /health
```

**Deployment:** Docker container `abl-nlu-sidecar` in `docker-compose.yml`. Optional — if unavailable, Tier 2 is skipped gracefully.

**Circuit breaker:** 5 consecutive failures → open for 30s → half-open probe.

### Correction Detection (Updated)

```
Current:  Regex patterns → LLM fallback (optional)
Proposed: In-process heuristic (fast) → Sidecar ML model → LLM fallback
```

### Defaults

| Setting                      | Default                         | Rationale                                    |
| ---------------------------- | ------------------------------- | -------------------------------------------- |
| `extraction_strategy`        | `'auto'`                        | Full cascade: JS → sidecar → LLM             |
| Sidecar unavailable          | Skip Tier 2, continue to Tier 3 | Graceful degradation                         |
| Sidecar timeout              | `500ms`                         | Fast enough for extraction, fail-fast to LLM |
| Circuit breaker threshold    | `5 failures` → open `30s`       | Prevent hammering dead sidecar               |
| `chrono-node` locale         | `session.locale` or `'en'`      | Multilingual date parsing                    |
| Correction detection primary | `'ml'` (sidecar)                | ML more robust than regex                    |
| Legacy `'hybrid'`            | Maps to `'auto'`                | Backward compatible                          |
| Legacy `'pattern'`           | Maps to `'ml'`                  | Backward compatible                          |

### Files Modified

| File                                                        | Change                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| `packages/compiler/src/platform/ir/schema.ts`               | Update `ExtractionStrategy` type                                          |
| `apps/runtime/src/services/execution/flow-step-executor.ts` | Wire Tier 1 + Tier 2, rename `extractEntitiesWithLLM` → `extractEntities` |
| `packages/compiler/src/platform/utils/entity-extraction.ts` | Replace regex with `chrono-node` / `libphonenumber-js`                    |
| `packages/compiler/src/platform/constructs/utils.ts`        | Update `detectCorrection()` to call sidecar                               |
| New: `apps/runtime/src/services/nlu/sidecar-client.ts`      | HTTP client with health check + circuit breaker                           |
| New: `apps/nlu-sidecar/`                                    | Python sidecar service                                                    |
| `docker-compose.yml`                                        | Add `abl-nlu-sidecar` container                                           |

---

## Phase 2: Multi-Intent Recognition

### Problem

`IntentResult.alternatives` is declared but never populated. `IntentEmbeddingIndex.matchTopN()` exists but isn't wired in. No LLM prompt asks for multiple intents. No runtime handling of multi-intent results.

### Detection Changes

**Embedding layer:** Wire `matchTopN(message, 5)` into the pipeline. Return all matches above threshold.

**LLM prompt change:** Return multiple intents with relationship analysis:

```json
{
  "intents": [
    { "intent": "book_hotel", "confidence": 0.92 },
    { "intent": "rent_car", "confidence": 0.85 }
  ],
  "relationships": {
    "type": "independent | dependent | ambiguous",
    "reasoning": "Both are travel tasks but neither depends on the other"
  }
}
```

### Five Strategies

```typescript
type MultiIntentStrategy = 'sequential' | 'parallel' | 'primary_queue' | 'disambiguate' | 'auto';
```

| Strategy        | Behavior                                                        | Use Case                              |
| --------------- | --------------------------------------------------------------- | ------------------------------------- |
| `sequential`    | Build ordered plan, execute one-by-one, pass context forward    | Dependent intents                     |
| `parallel`      | Fan-out to sub-agents via `FanOutExecutor`                      | Independent intents (supervisor only) |
| `primary_queue` | Handle highest-confidence, queue rest, surface after completion | Safe default                          |
| `disambiguate`  | Present detected intents, let user choose                       | Ambiguous cases                       |
| `auto`          | LLM-assessed `relationships.type` determines strategy           | Intelligent routing                   |

### Strategy Restrictions by Agent Type

| Strategy        | Scripted                               | Reasoning        | Supervisor   |
| --------------- | -------------------------------------- | ---------------- | ------------ |
| `primary_queue` | Yes                                    | Yes              | Yes          |
| `sequential`    | Yes                                    | Yes              | Yes          |
| `parallel`      | **No**                                 | **No**           | **Yes only** |
| `disambiguate`  | Yes                                    | Yes              | Yes          |
| `auto`          | Yes (downgrades parallel → sequential) | Yes (downgrades) | Yes (full)   |

**Why `parallel` is supervisor-only:**

- Scripted agents have a single flow state machine — can't be in two steps simultaneously
- Reasoning agents have a single conversation context — parallel tool chains conflict
- Supervisors are designed for delegation — fan-out is their native capability

**`auto` resolution table:**

| Relationship  | Supervisor     | Scripted / Reasoning      |
| ------------- | -------------- | ------------------------- |
| `independent` | `parallel`     | `sequential` (downgraded) |
| `dependent`   | `sequential`   | `sequential`              |
| `ambiguous`   | `disambiguate` | `disambiguate`            |

### Interaction With Existing Flow Mechanics

**Rule 1: ON_INPUT and digression evaluation happen BEFORE multi-intent dispatch.** The current step's local routing always takes priority over secondary intents. Secondary intents never interfere with the active step's control flow.

**Rule 2: Multi-intent routing happens AT the supervisor/top-level agent.** Child agents delegated by a supervisor each receive a single intent. They never see multi-intent state.

**Rule 3: Reasoning agents handle multi-intent naturally** via tool chaining within a single turn. The multi-intent system adds explicit tracking and strategy control on top.

### Intent Queue

```typescript
interface IntentQueue {
  pending: Array<{
    intent: string;
    confidence: number;
    original_message: string;
    detected_at: string;
  }>;
}
```

Stored on `session.intentQueue`. After primary flow completes: "You also mentioned {intent}. Shall I help?"

Queue entries expire after `queue_max_age_ms` (default 10 minutes).

### DSL Syntax

```yaml
AGENT booking_assistant:
  MULTI_INTENT:
    strategy: auto
    max_intents: 3
    confidence_threshold: 0.6
```

Compiles to `AgentIR.intent_handling.multi_intent`.

### Defaults

| Setting                                        | Default                    | Rationale                                           |
| ---------------------------------------------- | -------------------------- | --------------------------------------------------- |
| `multi_intent.enabled`                         | `true`                     | Always detect; `primary_queue` is safe              |
| `multi_intent.strategy`                        | `'primary_queue'`          | Queue secondary intents, no breaking change         |
| `multi_intent.max_intents`                     | `3`                        | Prevent hallucinated long-tail                      |
| `multi_intent.confidence_threshold`            | `0.6`                      | Secondary intents need lower bar than primary (0.7) |
| `queue_max_age_ms`                             | `600000` (10 min)          | Stale intents discarded                             |
| `parallel` on non-supervisor                   | Downgraded to `sequential` | Safety restriction                                  |
| Single-intent agents (no MULTI_INTENT section) | `primary_queue`            | Backward compatible                                 |

### Files Modified

| File                                                        | Change                                      |
| ----------------------------------------------------------- | ------------------------------------------- |
| `packages/compiler/src/platform/ir/schema.ts`               | Add `IntentHandlingConfig`                  |
| `packages/compiler/src/parser/`                             | Parse `MULTI_INTENT:` section               |
| `packages/compiler/src/platform/nlu/engine.ts`              | Return array, populate `alternatives`       |
| `packages/compiler/src/platform/nlu/intent-detector.ts`     | LLM prompt for multi-intent + relationships |
| `packages/compiler/src/platform/nlu/types.ts`               | Extend `IntentResult` with `relationships`  |
| `apps/runtime/src/services/execution/flow-step-executor.ts` | Multi-intent dispatch after detection       |
| `apps/runtime/src/services/execution/routing-executor.ts`   | Strategy-based routing                      |
| New: `apps/runtime/src/services/execution/intent-queue.ts`  | Queue management                            |

---

## Phase 3: Stubbed Feature Completion

### 3A: `convert_to` — Post-Extraction Unit Conversion

**Where in pipeline:** After extraction + validation, before storing in `session.data.values`.

```
Extract → Validate → Convert → Store
```

**Conversion registry** — built-in common conversions:

| Category    | Units                                                  |
| ----------- | ------------------------------------------------------ |
| Temperature | celsius, fahrenheit, kelvin                            |
| Distance    | km, miles, meters, feet, yards                         |
| Weight      | kg, lbs, grams, ounces                                 |
| Currency    | USD, EUR, GBP, ... (static rates default, live opt-in) |
| Time        | seconds, minutes, hours, days                          |
| Volume      | liters, gallons, ml, cups                              |

**DSL usage:**

```yaml
COLLECT:
  - temperature:
      TYPE: number
      PROMPT: 'What temperature?'
      SEMANTICS:
        unit: fahrenheit
        convert_to: celsius
```

**Storage:** Both original and converted values preserved:

```typescript
session.data.values.temperature = 22; // converted
session.data.values._original.temperature = 72; // original
```

**Implementation:** Pure function `convertValue(value, fromUnit, toUnit)` in `packages/compiler/src/platform/utils/unit-conversion.ts`.

**Currency modes:**

- `'static'` (default): compile-time rates baked into IR
- `'live'` (opt-in): runtime HTTP call to rates API

### 3B: `lookup` — Reference Table Validation

**Two modes based on table size:**

| Mode     | When                               | Mechanism                           |
| -------- | ---------------------------------- | ----------------------------------- |
| Inline   | < 1000 entries                     | Baked into IR as `Set`, O(1) lookup |
| External | >= 1000 entries or `dynamic: true` | MongoDB collection or HTTP endpoint |

**DSL usage:**

```yaml
LOOKUP_TABLES:
  iata_codes:
    source: inline
    values: [LAX, JFK, CDG, LHR, NRT]

  hotel_chains:
    source: mongodb
    collection: lookup_hotel_chains
    field: name
```

**IR schema:**

```typescript
interface LookupTableIR {
  name: string;
  source: 'inline' | 'mongodb' | 'http';
  values?: string[];
  collection?: string;
  endpoint?: string;
  field?: string;
  case_sensitive: boolean;
  fuzzy_match: boolean;
  fuzzy_threshold: number;
}
```

**Validation integration:** Runs alongside pattern/range/enum as a validation step. Value not in table → validation failure with `error_message`.

**Fuzzy matching** (opt-in): Levenshtein distance for inline tables. ML-based fuzzy via sidecar for external.

### 3C: `infer` — LLM Field Inference

**When:** After extraction pass, if a field with `infer: true` is still missing.

**Mechanism:** Fast-tier LLM call with collected context:

```
System: Based on context, infer the most likely value for the missing field.
        Only return if confidence > threshold. Return null if uncertain.

Context: { destination: "Paris", check_in: "2026-03-15", guests: 2 }
Missing: hotel_class (budget | standard | premium | luxury)

Response: { "value": "standard", "confidence": 0.85, "reasoning": "Default for leisure" }
```

**Confidence gate:** Accept only above `infer_confidence` threshold (default 0.8). Below → prompt user.

**User transparency:** Inferred values are marked and (by default) confirmed:

```typescript
session.data.values.hotel_class = 'standard';
session.data.values._inferred.hotel_class = {
  confidence: 0.85,
  reasoning: 'Default for leisure travel with 2 guests',
};
```

Agent confirms: "I'll assume standard class — does that work?"

**DSL usage:**

```yaml
COLLECT:
  - hotel_class:
      TYPE: string
      PROMPT: 'What hotel class?'
      VALIDATION:
        type: enum
        rule: budget|standard|premium|luxury
      infer: true
      infer_confidence: 0.8
      infer_confirm: true
```

### Defaults

| Setting                        | Default        | Rationale                             |
| ------------------------------ | -------------- | ------------------------------------- |
| `convert_to` currency mode     | `'static'`     | No runtime API dependency             |
| `convert_to` preserve original | `true`         | Store original in `_original.{field}` |
| `lookup` mode threshold        | `1000 entries` | Below = inline, above = external      |
| `lookup` case_sensitive        | `false`        | Case-insensitive by default           |
| `lookup` fuzzy_match           | `false`        | Exact match unless enabled            |
| `lookup` fuzzy_threshold       | `0.85`         | Levenshtein similarity                |
| `lookup` source                | `'inline'`     | Baked into IR unless specified        |
| `infer` per field              | `false`        | Opt-in with `infer: true`             |
| `infer_confidence`             | `0.8`          | Minimum to accept                     |
| `infer_confirm`                | `true`         | Always confirm with user              |
| `infer` model tier             | `'fast'`       | Cost-efficient                        |
| `infer` max fields per pass    | `3`            | Don't infer too many at once          |

### Files Modified (Phase 3)

| File                                                           | Change                                                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `packages/compiler/src/platform/ir/schema.ts`                  | Add `LookupTableIR`, `infer_confidence`, `infer_confirm` to `GatherField`, `lookup_tables` to `AgentIR` |
| `packages/compiler/src/parser/`                                | Parse `LOOKUP_TABLES:`, `infer:`, `convert_to:`                                                         |
| New: `packages/compiler/src/platform/utils/unit-conversion.ts` | `convertValue()` with built-in registry                                                                 |
| New: `apps/runtime/src/services/execution/lookup-resolver.ts`  | Inline + MongoDB/HTTP lookup                                                                            |
| `apps/runtime/src/services/execution/flow-step-executor.ts`    | Wire convert_to, lookup, infer                                                                          |
| `packages/compiler/src/platform/constructs/semantic-hints.ts`  | Include `convert_to` in hints                                                                           |

---

## Phasing Summary

| Phase | Scope             | Key Deliverables                                                                  |
| ----- | ----------------- | --------------------------------------------------------------------------------- |
| **1** | Robust Extraction | JS libs in-process, Python sidecar, 4-tier pipeline, correction detection upgrade |
| **2** | Multi-Intent      | 5 strategies, LLM auto mode, intent queue, strategy restrictions by agent type    |
| **3** | Stubbed Features  | convert_to, lookup tables (inline + external), LLM field inference                |

**Cross-cutting:** `ProjectRuntimeConfig` model + API + Studio tab (delivered in Phase 1, extended in Phases 2-3).

# Phase 2: Customer Configuration Schema -- Intent Classification Pipeline

> **Pipeline**: Intent Classification
> **Pipeline Type Key**: `intent_classification`
> **Output Table**: `abl_platform.intent_classifications` (ClickHouse)
> **Config Collection**: `pipeline_configs` (MongoDB)
> **Date**: 2026-03-03

---

## Checklist

- [x] 2.1 List all tunable parameters for this pipeline
- [x] 2.2 Classify each: REQUIRED vs OPTIONAL
- [x] 2.3 Define sensible platform defaults for all OPTIONAL parameters
- [x] 2.4 Design the MongoDB schema for pipeline configuration
- [x] 2.5 Define validation rules (min/max, enum values, required fields)
- [x] 2.6 Determine scope: tenant-level, project-level, or agent-level configuration
- [x] 2.7 Plan configuration versioning (when customer changes config, do we re-run?)
- [x] 2.8 Identify parameters that require pipeline re-processing when changed
- [x] 2.9 Identify parameters that only affect future processing (no backfill needed)
- [x] 2.10 Design the Studio UI for configuration (inputs, defaults, help text)

---

## 2.1 All Tunable Parameters

Parameters are organized into three groups matching the interface inheritance chain: **Scope**, **Model**, and **Intent-Specific**.

### Group A: Processing Scope & Filters (from `PipelineScopeConfig`)

| #   | Parameter         | Description                                                                                                                                 |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | `channels`        | Which conversation channels to process (e.g., `web_chat`, `voice`). Empty = all.                                                            |
| A2  | `agents`          | Which agents' conversations to classify. Empty = all.                                                                                       |
| A3  | `minMessageCount` | Minimum messages in a conversation to be eligible for classification. Very short conversations (1 message) rarely have classifiable intent. |
| A4  | `excludeTags`     | Skip conversations tagged with these values (e.g., `test`, `internal`).                                                                     |
| A5  | `sampleRate`      | Fraction of eligible conversations to process (0.0-1.0). For cost control during ramp-up.                                                   |
| A6  | `lookbackDays`    | How many days of historical conversations to process on initial backfill.                                                                   |
| A7  | `processingDelay` | Minutes to wait after `session_end` before processing. Allows late messages to arrive.                                                      |

### Group B: Model & Provider Selection (from `PipelineModelConfig`)

| #   | Parameter                | Description                                                          |
| --- | ------------------------ | -------------------------------------------------------------------- |
| B1  | `provider`               | LLM provider for classification (`anthropic`, `openai`, `gemini`).   |
| B2  | `model`                  | Specific model ID (e.g., `claude-haiku-4-5`, `gpt-4o-mini`).         |
| B3  | `temperature`            | LLM temperature. Lower = more deterministic classification.          |
| B4  | `maxTokens`              | Maximum output tokens for the classification response.               |
| B5  | `maxCostPerDay`          | Daily cost cap in USD. Pipeline pauses when exceeded.                |
| B6  | `maxCostPerConversation` | Per-conversation cost cap. Conversations exceeding this are skipped. |

### Group C: Intent-Specific Parameters

| #   | Parameter                     | Description                                                                                                                       |
| --- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `taxonomy`                    | Customer-defined hierarchical intent taxonomy. Categories with names, descriptions, examples, and optional sub-categories.        |
| C2  | `autoDiscovery`               | Whether to discover intents not present in the taxonomy.                                                                          |
| C3  | `autoDiscoveryMergeThreshold` | Cosine similarity threshold above which auto-discovered clusters are merged into one intent.                                      |
| C4  | `classificationPrompt`        | Custom system prompt override for the classification LLM call. Advanced users only.                                               |
| C5  | `multiLabel`                  | Whether a single conversation can be assigned multiple intents.                                                                   |
| C6  | `confidenceThreshold`         | Confidence score below which the classification is labeled `unknown`.                                                             |
| C7  | `maxCategories`               | Maximum number of taxonomy categories allowed (guards against unbounded taxonomy).                                                |
| C8  | `maxExamplesPerCategory`      | Maximum few-shot examples per category to include in the LLM prompt.                                                              |
| C9  | `inputMessageStrategy`        | Which messages from the conversation to use as classification input: `first_user`, `first_n_user`, `all_user`, `full_transcript`. |
| C10 | `inputMessageCount`           | When `inputMessageStrategy` is `first_n_user`, how many user messages to include.                                                 |
| C11 | `unknownIntentLabel`          | Custom label for conversations that fall below the confidence threshold.                                                          |
| C12 | `taxonomyVersion`             | Read-only auto-incremented version stamp for the taxonomy. Used in provenance tracking.                                           |

---

## 2.2 Required vs Optional Classification

| Parameter                     | Classification | Rationale                                                                                                                 |
| ----------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `taxonomy`                    | **OPTIONAL**   | If not provided, pipeline operates in pure auto-discovery mode. Customers can start without a taxonomy and add one later. |
| `autoDiscovery`               | OPTIONAL       | Has a default.                                                                                                            |
| `autoDiscoveryMergeThreshold` | OPTIONAL       | Has a default.                                                                                                            |
| `classificationPrompt`        | OPTIONAL       | Platform provides a well-tested default prompt.                                                                           |
| `multiLabel`                  | OPTIONAL       | Has a default.                                                                                                            |
| `confidenceThreshold`         | OPTIONAL       | Has a default.                                                                                                            |
| `maxCategories`               | OPTIONAL       | Has a default guard.                                                                                                      |
| `maxExamplesPerCategory`      | OPTIONAL       | Has a default.                                                                                                            |
| `inputMessageStrategy`        | OPTIONAL       | Has a default.                                                                                                            |
| `inputMessageCount`           | OPTIONAL       | Has a default.                                                                                                            |
| `unknownIntentLabel`          | OPTIONAL       | Has a default.                                                                                                            |
| `channels`                    | OPTIONAL       | Empty = all channels.                                                                                                     |
| `agents`                      | OPTIONAL       | Empty = all agents.                                                                                                       |
| `minMessageCount`             | OPTIONAL       | Has a default.                                                                                                            |
| `excludeTags`                 | OPTIONAL       | Empty = no exclusions.                                                                                                    |
| `sampleRate`                  | OPTIONAL       | Has a default.                                                                                                            |
| `lookbackDays`                | OPTIONAL       | Has a default.                                                                                                            |
| `processingDelay`             | OPTIONAL       | Has a default.                                                                                                            |
| `provider`                    | OPTIONAL       | Platform selects from tenant's configured models.                                                                         |
| `model`                       | OPTIONAL       | Platform selects based on tier mapping (`fast` tier).                                                                     |
| `temperature`                 | OPTIONAL       | Has a default.                                                                                                            |
| `maxTokens`                   | OPTIONAL       | Has a default.                                                                                                            |
| `maxCostPerDay`               | OPTIONAL       | No limit by default (tenant billing applies).                                                                             |
| `maxCostPerConversation`      | OPTIONAL       | No limit by default.                                                                                                      |

**Result: Zero REQUIRED parameters.** The pipeline is fully operational with only platform defaults. The customer enables the pipeline and optionally adds a taxonomy. This is an intentional design choice -- the barrier to activation must be zero.

---

## 2.3 Platform Defaults

| Parameter                     | Default               | Rationale                                                                                                         |
| ----------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `taxonomy`                    | `null` (none)         | Pure auto-discovery mode until customer defines categories.                                                       |
| `autoDiscovery`               | `true`                | Always discover unknown intents. If a taxonomy is provided, new clusters outside the taxonomy are still captured. |
| `autoDiscoveryMergeThreshold` | `0.85`                | High similarity required to merge clusters. Prevents over-merging distinct intents.                               |
| `classificationPrompt`        | `null` (use built-in) | The platform prompt is tested and versioned. Custom prompts are an advanced override.                             |
| `multiLabel`                  | `false`               | Single primary intent per conversation. Multi-label adds complexity and is opt-in.                                |
| `confidenceThreshold`         | `0.7`                 | 70% confidence. Below this, the result is tagged as `unknown`. Balances coverage vs accuracy.                     |
| `maxCategories`               | `200`                 | Protects against prompt size explosion. Most taxonomies have 10-50 categories.                                    |
| `maxExamplesPerCategory`      | `5`                   | Limits per-category few-shot examples in the prompt to control token cost.                                        |
| `inputMessageStrategy`        | `'first_n_user'`      | First N user messages capture intent better than full transcript (which includes resolution chatter).             |
| `inputMessageCount`           | `3`                   | First 3 user messages. Intent is typically established early in the conversation.                                 |
| `unknownIntentLabel`          | `'unknown'`           | Standard label for low-confidence classifications.                                                                |
| `channels`                    | `[]` (all)            | Process all channels by default.                                                                                  |
| `agents`                      | `[]` (all)            | Process all agents by default.                                                                                    |
| `minMessageCount`             | `2`                   | At least one user + one assistant message. Single-message conversations are usually noise.                        |
| `excludeTags`                 | `[]` (none)           | No exclusions by default.                                                                                         |
| `sampleRate`                  | `1.0`                 | Process every eligible conversation.                                                                              |
| `lookbackDays`                | `30`                  | One month of historical data for initial backfill.                                                                |
| `processingDelay`             | `5`                   | 5 minutes after session end. Allows late-arriving messages.                                                       |
| `provider`                    | `null` (auto)         | Resolved from tenant's default model for the `fast` tier.                                                         |
| `model`                       | `null` (auto)         | Resolved from tenant's default model for the `fast` tier.                                                         |
| `temperature`                 | `0.1`                 | Low temperature for deterministic, reproducible classification.                                                   |
| `maxTokens`                   | `512`                 | Classification output is structured JSON; 512 tokens is generous.                                                 |
| `maxCostPerDay`               | `null` (no limit)     | Tenant billing limits apply separately.                                                                           |
| `maxCostPerConversation`      | `null` (no limit)     | Individual conversations are cheap for classification.                                                            |

---

## 2.4 MongoDB Schema

### 2.4.a Full TypeScript Interfaces

```typescript
// packages/pipeline-engine/src/pipeline/types/intent-classification-config.ts

// ─── Taxonomy Types ────────────────────────────────────────────────────

export interface IntentCategory {
  /** Machine-readable name. Lowercase, underscored. Stored in ClickHouse `intent` column. */
  name: string;
  /** Human-readable label shown in Studio dashboards. */
  displayName: string;
  /** Description used in the LLM prompt to guide classification. */
  description?: string;
  /** Few-shot example utterances for this intent. */
  examples?: string[];
  /** Sub-categories for hierarchical taxonomy. */
  children?: IntentCategory[];
}

export interface IntentTaxonomy {
  /** Top-level intent categories. */
  categories: IntentCategory[];
}

// ─── Input Message Strategy ────────────────────────────────────────────

export type InputMessageStrategy =
  | 'first_user' // Only the first user message
  | 'first_n_user' // First N user messages (controlled by inputMessageCount)
  | 'all_user' // All user messages (no assistant messages)
  | 'full_transcript'; // Full conversation including assistant turns

// ─── Scope Config ──────────────────────────────────────────────────────

export interface IntentScopeConfig {
  /** Process only these channels. Empty = all. */
  channels?: string[];
  /** Process only conversations handled by these agents. Empty = all. */
  agents?: string[];
  /** Minimum message count for a conversation to be eligible. */
  minMessageCount?: number;
  /** Skip conversations with any of these tags. */
  excludeTags?: string[];
  /** Fraction of eligible conversations to process (0.0 - 1.0). */
  sampleRate?: number;
  /** Days of history to process on initial backfill. */
  lookbackDays?: number;
  /** Minutes to wait after session_end before processing. */
  processingDelay?: number;
}

// ─── Model Config ──────────────────────────────────────────────────────

export interface IntentModelConfig {
  /** LLM provider. Null = resolve from tenant model configuration. */
  provider?: string | null;
  /** LLM model ID. Null = resolve from tenant model configuration. */
  model?: string | null;
  /** LLM temperature. */
  temperature?: number;
  /** Maximum output tokens. */
  maxTokens?: number;
  /** Daily cost cap in USD. Null = no limit. */
  maxCostPerDay?: number | null;
  /** Per-conversation cost cap in USD. Null = no limit. */
  maxCostPerConversation?: number | null;
}

// ─── Intent-Specific Config ────────────────────────────────────────────

export interface IntentClassificationPipelineConfig {
  // --- Scope ---
  scope?: IntentScopeConfig;

  // --- Model ---
  modelConfig?: IntentModelConfig;

  // --- Taxonomy ---
  /** Customer-defined hierarchical intent taxonomy. Null = pure auto-discovery. */
  taxonomy?: IntentTaxonomy | null;
  /** Read-only. Auto-incremented when taxonomy changes. Stored in output provenance. */
  taxonomyVersion?: number;

  // --- Classification behavior ---
  /** Discover intents not in the taxonomy. */
  autoDiscovery?: boolean;
  /** Similarity threshold for merging auto-discovered intent clusters. */
  autoDiscoveryMergeThreshold?: number;
  /** Custom LLM system prompt override. Null = use platform default. */
  classificationPrompt?: string | null;
  /** Allow multiple intent labels per conversation. */
  multiLabel?: boolean;
  /** Confidence below this = unknown. */
  confidenceThreshold?: number;

  // --- Input selection ---
  /** Which messages to send to the classifier. */
  inputMessageStrategy?: InputMessageStrategy;
  /** Number of user messages when strategy is 'first_n_user'. */
  inputMessageCount?: number;

  // --- Taxonomy guards ---
  /** Maximum number of top-level + child categories across the taxonomy. */
  maxCategories?: number;
  /** Maximum few-shot examples per category included in the prompt. */
  maxExamplesPerCategory?: number;

  // --- Labels ---
  /** Label assigned when confidence is below threshold. */
  unknownIntentLabel?: string;
}
```

### 2.4.b MongoDB Document Structure

The intent classification config is stored inside the generic `pipeline_configs` collection as the `config` field of an `IPipelineConfig` document. The outer document provides `tenantId`, `projectId`, `pipelineType`, `version`, `enabled`, and audit fields.

```typescript
// The full document stored in MongoDB pipeline_configs collection:
{
  _id: ObjectId,
  tenantId: string,              // REQUIRED - tenant isolation
  projectId: string | null,      // null = tenant-level, non-null = project override
  pipelineType: 'intent_classification',
  version: number,               // Auto-incremented on every save
  enabled: boolean,              // Master on/off switch

  config: IntentClassificationPipelineConfig,  // Typed blob

  // Processing state (managed by pipeline engine, not customer-editable)
  lastBackfillAt: Date | null,
  backfillStatus: 'idle' | 'running' | 'completed' | 'failed',
  lastProcessedAt: Date | null,

  // Audit
  createdBy: string,
  updatedBy: string,
  createdAt: Date,               // Mongoose timestamp
  updatedAt: Date,               // Mongoose timestamp

  // Change history (last 20 entries)
  configHistory: ConfigChange[]
}
```

### 2.4.c Example MongoDB Document (fully populated)

```json
{
  "_id": "65f8a1b2c3d4e5f6a7b8c9d0",
  "tenantId": "tenant_acme_corp",
  "projectId": "proj_customer_support",
  "pipelineType": "intent_classification",
  "version": 3,
  "enabled": true,
  "config": {
    "scope": {
      "channels": ["web_chat", "whatsapp"],
      "agents": [],
      "minMessageCount": 2,
      "excludeTags": ["test", "internal", "load_test"],
      "sampleRate": 1.0,
      "lookbackDays": 30,
      "processingDelay": 5
    },
    "modelConfig": {
      "provider": null,
      "model": null,
      "temperature": 0.1,
      "maxTokens": 512,
      "maxCostPerDay": 50.0,
      "maxCostPerConversation": null
    },
    "taxonomy": {
      "categories": [
        {
          "name": "billing",
          "displayName": "Billing",
          "description": "Customer inquiries related to billing, charges, and payments",
          "examples": ["I was charged twice for my subscription", "When is my next payment due?"],
          "children": [
            {
              "name": "billing_refund",
              "displayName": "Billing - Refund Request",
              "description": "Customer requesting a refund for a charge",
              "examples": [
                "I want a refund for the overcharge on my account",
                "Can you reverse the charge from last Tuesday?"
              ]
            },
            {
              "name": "billing_dispute",
              "displayName": "Billing - Charge Dispute",
              "description": "Customer disputing the validity of a charge",
              "examples": [
                "I don't recognize this charge on my statement",
                "This fee shouldn't have been applied"
              ]
            }
          ]
        },
        {
          "name": "technical_support",
          "displayName": "Technical Support",
          "description": "Customer experiencing technical issues with the product",
          "examples": [
            "My app keeps crashing when I try to log in",
            "The website is showing an error message"
          ],
          "children": [
            {
              "name": "technical_connectivity",
              "displayName": "Technical - Connectivity Issues",
              "description": "Problems connecting to the service",
              "examples": [
                "I can't connect to your service",
                "My internet works but your app says offline"
              ]
            }
          ]
        },
        {
          "name": "account_management",
          "displayName": "Account Management",
          "description": "Account changes, updates, and access requests",
          "examples": ["I need to update my email address", "How do I change my password?"]
        },
        {
          "name": "cancellation",
          "displayName": "Cancellation",
          "description": "Customer wants to cancel service or subscription",
          "examples": ["I'd like to cancel my subscription", "How do I close my account?"]
        }
      ]
    },
    "taxonomyVersion": 3,
    "autoDiscovery": true,
    "autoDiscoveryMergeThreshold": 0.85,
    "classificationPrompt": null,
    "multiLabel": false,
    "confidenceThreshold": 0.7,
    "inputMessageStrategy": "first_n_user",
    "inputMessageCount": 3,
    "maxCategories": 200,
    "maxExamplesPerCategory": 5,
    "unknownIntentLabel": "unknown"
  },
  "lastBackfillAt": "2026-03-01T08:30:00.000Z",
  "backfillStatus": "completed",
  "lastProcessedAt": "2026-03-03T14:22:15.000Z",
  "createdBy": "user_admin_jane",
  "updatedBy": "user_admin_jane",
  "createdAt": "2026-02-15T10:00:00.000Z",
  "updatedAt": "2026-03-02T16:45:00.000Z",
  "configHistory": [
    {
      "version": 2,
      "changedBy": "user_admin_jane",
      "changedAt": "2026-02-20T14:00:00.000Z",
      "diff": {
        "taxonomy": {
          "old": null,
          "new": { "categories": ["..."] }
        }
      },
      "reprocessingRequired": true
    },
    {
      "version": 3,
      "changedBy": "user_admin_jane",
      "changedAt": "2026-03-02T16:45:00.000Z",
      "diff": {
        "confidenceThreshold": {
          "old": 0.6,
          "new": 0.7
        }
      },
      "reprocessingRequired": false
    }
  ]
}
```

### 2.4.d Minimal Document (defaults only, just enabled)

```json
{
  "_id": "65f8a1b2c3d4e5f6a7b8c9d1",
  "tenantId": "tenant_startup_co",
  "projectId": null,
  "pipelineType": "intent_classification",
  "version": 1,
  "enabled": true,
  "config": {},
  "lastBackfillAt": null,
  "backfillStatus": "idle",
  "lastProcessedAt": null,
  "createdBy": "user_admin_bob",
  "updatedBy": "user_admin_bob",
  "createdAt": "2026-03-03T09:00:00.000Z",
  "updatedAt": "2026-03-03T09:00:00.000Z",
  "configHistory": []
}
```

This minimal document is valid. The pipeline engine applies all platform defaults when fields are absent from `config`.

---

## 2.5 Validation Rules

### Complete Parameter Table

| Parameter                            | Type                     | Req/Opt   | Default          | Validation                                                                                    | Re-process?    |
| ------------------------------------ | ------------------------ | --------- | ---------------- | --------------------------------------------------------------------------------------------- | -------------- |
| **Scope**                            |                          |           |                  |                                                                                               |                |
| `scope.channels`                     | `string[]`               | OPT       | `[]`             | Each: non-empty string, max 50 chars. Array max length: 50.                                   | NO (future)    |
| `scope.agents`                       | `string[]`               | OPT       | `[]`             | Each: non-empty string, max 100 chars. Array max length: 100.                                 | NO (future)    |
| `scope.minMessageCount`              | `number`                 | OPT       | `2`              | Integer, min: 1, max: 100.                                                                    | NO (future)    |
| `scope.excludeTags`                  | `string[]`               | OPT       | `[]`             | Each: non-empty string, max 50 chars. Array max length: 100.                                  | NO (future)    |
| `scope.sampleRate`                   | `number`                 | OPT       | `1.0`            | Float, min: 0.01, max: 1.0.                                                                   | NO (future)    |
| `scope.lookbackDays`                 | `number`                 | OPT       | `30`             | Integer, min: 1, max: 90 (bounded by data TTL).                                               | N/A (backfill) |
| `scope.processingDelay`              | `number`                 | OPT       | `5`              | Integer, min: 0, max: 60 (minutes).                                                           | NO (future)    |
| **Model**                            |                          |           |                  |                                                                                               |                |
| `modelConfig.provider`               | `string \| null`         | OPT       | `null`           | If set: one of tenant's configured providers. Validated at save against tenant model catalog. | YES            |
| `modelConfig.model`                  | `string \| null`         | OPT       | `null`           | If set: must exist in tenant's model catalog for the given provider.                          | YES            |
| `modelConfig.temperature`            | `number`                 | OPT       | `0.1`            | Float, min: 0.0, max: 1.0.                                                                    | YES            |
| `modelConfig.maxTokens`              | `number`                 | OPT       | `512`            | Integer, min: 64, max: 4096.                                                                  | NO (future)    |
| `modelConfig.maxCostPerDay`          | `number \| null`         | OPT       | `null`           | If set: float, min: 0.01.                                                                     | NO (future)    |
| `modelConfig.maxCostPerConversation` | `number \| null`         | OPT       | `null`           | If set: float, min: 0.001.                                                                    | NO (future)    |
| **Intent-Specific**                  |                          |           |                  |                                                                                               |                |
| `taxonomy`                           | `IntentTaxonomy \| null` | OPT       | `null`           | See taxonomy validation below.                                                                | YES            |
| `taxonomyVersion`                    | `number`                 | READ-ONLY | `0`              | Auto-incremented. Not customer-settable via API.                                              | N/A            |
| `autoDiscovery`                      | `boolean`                | OPT       | `true`           | Boolean. Must be `true` if taxonomy is null.                                                  | YES            |
| `autoDiscoveryMergeThreshold`        | `number`                 | OPT       | `0.85`           | Float, min: 0.5, max: 0.99.                                                                   | YES            |
| `classificationPrompt`               | `string \| null`         | OPT       | `null`           | If set: non-empty, max 4000 chars. Must not contain PII or secrets.                           | YES            |
| `multiLabel`                         | `boolean`                | OPT       | `false`          | Boolean.                                                                                      | YES            |
| `confidenceThreshold`                | `number`                 | OPT       | `0.7`            | Float, min: 0.1, max: 0.99.                                                                   | NO (threshold) |
| `inputMessageStrategy`               | `InputMessageStrategy`   | OPT       | `'first_n_user'` | Enum: `first_user`, `first_n_user`, `all_user`, `full_transcript`.                            | YES            |
| `inputMessageCount`                  | `number`                 | OPT       | `3`              | Integer, min: 1, max: 20. Only used when strategy is `first_n_user`.                          | YES            |
| `maxCategories`                      | `number`                 | OPT       | `200`            | Integer, min: 1, max: 500.                                                                    | N/A (guard)    |
| `maxExamplesPerCategory`             | `number`                 | OPT       | `5`              | Integer, min: 0, max: 20.                                                                     | YES            |
| `unknownIntentLabel`                 | `string`                 | OPT       | `'unknown'`      | Non-empty string, max 100 chars, lowercase alphanumeric + underscore.                         | NO (label)     |

### Taxonomy Validation Rules

The `taxonomy` object has its own deep validation:

| Rule                   | Constraint                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `categories` array     | Required if `taxonomy` is non-null. Min length: 1. Max length: governed by `maxCategories`.                                            |
| `category.name`        | Required. 1-100 chars. Pattern: `^[a-z][a-z0-9_]*$` (lowercase, underscore-separated). Must be unique across the entire taxonomy tree. |
| `category.displayName` | Required. 1-200 chars. No restrictions on casing.                                                                                      |
| `category.description` | Optional. Max 500 chars.                                                                                                               |
| `category.examples`    | Optional. Array max length: governed by `maxExamplesPerCategory`. Each example: 1-500 chars.                                           |
| `category.children`    | Optional. Recursive validation. Max depth: 3 levels.                                                                                   |
| Total categories       | Sum of all categories across all levels must not exceed `maxCategories`.                                                               |
| Name uniqueness        | Every `name` across the entire tree (all levels) must be unique.                                                                       |

### Cross-Field Validation Rules

| Rule                                         | Constraint                                                                                                                                                                                                        |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autoDiscovery` required when no taxonomy    | If `taxonomy` is null, `autoDiscovery` must be `true` (or omitted, since default is `true`). Saving `taxonomy: null` + `autoDiscovery: false` is rejected -- the pipeline would have nothing to classify against. |
| `inputMessageCount` only with `first_n_user` | If `inputMessageStrategy` is not `first_n_user`, `inputMessageCount` is ignored (but not rejected).                                                                                                               |
| Model + provider consistency                 | If `model` is set, `provider` must also be set (or both null). Cannot specify a model without a provider.                                                                                                         |
| Cost limits non-negative                     | If either cost limit is set, it must be > 0.                                                                                                                                                                      |

---

## 2.6 Configuration Scope

### Resolution Order

```
1. Project-level config   (pipeline_configs WHERE tenantId = ? AND pipelineType = 'intent_classification' AND projectId = ?)
2. Tenant-level config    (pipeline_configs WHERE tenantId = ? AND pipelineType = 'intent_classification' AND projectId IS NULL)
3. Platform defaults      (hardcoded in IntentClassificationDefaults constant)
```

### Scope Behavior

| Level                 | Use Case                                                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Project-level**     | Primary scope. Each project can have its own taxonomy, thresholds, and model selection. A customer support project has different intents than a sales project. |
| **Tenant-level**      | Shared defaults across all projects. If a tenant sets a taxonomy at the tenant level, every project without its own config inherits it.                        |
| **Platform defaults** | Hardcoded fallbacks. Used when no tenant or project config exists. Ensures the pipeline is always operational.                                                 |

### No Agent-Level Configuration

Intent classification does not support per-agent configuration. The `scope.agents` filter handles agent-level filtering, but the taxonomy and model settings are always at the project or tenant level. Rationale: intents are a property of the customer's request, not the agent handling it. The same intent taxonomy applies regardless of which agent is involved.

### Config Merging Strategy

Configs are NOT deep-merged across levels. The resolution picks the first available document and applies platform defaults for any missing fields within that document. This avoids confusing merge semantics where a project taxonomy partially overrides a tenant taxonomy.

```
resolvedConfig = applyDefaults(projectConfig ?? tenantConfig ?? {})
```

The `applyDefaults` function fills in missing fields with platform defaults from the constant:

```typescript
const INTENT_CLASSIFICATION_DEFAULTS: Required<IntentClassificationPipelineConfig> = {
  scope: {
    channels: [],
    agents: [],
    minMessageCount: 2,
    excludeTags: [],
    sampleRate: 1.0,
    lookbackDays: 30,
    processingDelay: 5,
  },
  modelConfig: {
    provider: null,
    model: null,
    temperature: 0.1,
    maxTokens: 512,
    maxCostPerDay: null,
    maxCostPerConversation: null,
  },
  taxonomy: null,
  taxonomyVersion: 0,
  autoDiscovery: true,
  autoDiscoveryMergeThreshold: 0.85,
  classificationPrompt: null,
  multiLabel: false,
  confidenceThreshold: 0.7,
  inputMessageStrategy: 'first_n_user',
  inputMessageCount: 3,
  maxCategories: 200,
  maxExamplesPerCategory: 5,
  unknownIntentLabel: 'unknown',
};
```

---

## 2.7 Configuration Versioning

### Version Tracking Mechanism

1. Every save to `pipeline_configs` increments the `version` field by 1.
2. The diff between old and new `config` is recorded in `configHistory` (capped at 20 entries).
3. Each history entry includes `reprocessingRequired: boolean`, determined by comparing which fields changed against the re-processing key set.
4. When taxonomy changes, `taxonomyVersion` is also incremented (independently of `version`).
5. The `config_version` and `taxonomy_version` fields in the ClickHouse output table record which version was used to produce each classification.

### When Do We Re-Run?

| Trigger                                          | Behavior                                                                                                                                                                                                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config saved with re-processing-required changes | The `configHistory` entry is marked `reprocessingRequired: true`. The API response includes a `reprocessingRecommended: true` flag. The UI shows a prompt: "Taxonomy changed. Re-classify historical conversations?"                                           |
| Customer clicks "Re-process" in Studio           | A `POST /api/projects/:projectId/pipelines/intent_classification/backfill` request is issued. The backfill service queries for all sessions within `lookbackDays` that either (a) have no classification or (b) were classified with a prior `config_version`. |
| Customer changes threshold only                  | No re-processing needed. Future reads can apply the new threshold retroactively via SQL: `WHERE confidence >= :newThreshold`. The stored confidence score does not change.                                                                                     |
| Customer changes scope filters only              | No backfill for removed scope (those results remain). For added scope, future processing picks up new conversations. Customer can manually trigger backfill for the expanded scope.                                                                            |

### Backfill Protection

- Backfill is always opt-in, never automatic. The pipeline engine sets `backfillStatus: 'idle'` and surfaces the recommendation. The customer decides.
- Concurrent backfills are prevented via `backfillStatus` field (only one `running` at a time per pipeline per project).
- Backfill respects `maxCostPerDay` -- if the daily limit is reached during backfill, it pauses and resumes the next day.

---

## 2.8 Parameters That Require Re-Processing

These parameters fundamentally change the classification output. Changing them means historical classifications were produced with different logic and should be re-generated.

| Parameter                     | Why                                                                                                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `taxonomy`                    | Different categories produce different labels. Old labels may reference categories that no longer exist or miss new ones.                                      |
| `classificationPrompt`        | Different prompt = different classification behavior.                                                                                                          |
| `multiLabel`                  | Switching between single-label and multi-label changes the output schema (secondary_intents populated vs empty).                                               |
| `inputMessageStrategy`        | Different input context = different classification.                                                                                                            |
| `inputMessageCount`           | Same as above -- different prompt content.                                                                                                                     |
| `maxExamplesPerCategory`      | Changes the few-shot examples in the prompt, affecting classification accuracy.                                                                                |
| `autoDiscovery`               | Turning off auto-discovery means historical auto-discovered intents will not be re-discovered. Turning on means new intents may be found in old conversations. |
| `autoDiscoveryMergeThreshold` | Changes how clusters are merged, affecting intent granularity.                                                                                                 |
| `modelConfig.provider`        | Different LLM produces different classifications.                                                                                                              |
| `modelConfig.model`           | Same as above.                                                                                                                                                 |
| `modelConfig.temperature`     | Different temperature = different output distribution.                                                                                                         |

**Re-processing key set** (used by `PipelineConfigService.requiresReprocessing`):

```typescript
const INTENT_REPROCESS_KEYS = new Set([
  'taxonomy',
  'classificationPrompt',
  'multiLabel',
  'inputMessageStrategy',
  'inputMessageCount',
  'maxExamplesPerCategory',
  'autoDiscovery',
  'autoDiscoveryMergeThreshold',
  'modelConfig.provider',
  'modelConfig.model',
  'modelConfig.temperature',
]);
```

---

## 2.9 Parameters That Only Affect Future Processing

These parameters do NOT require backfill when changed. They either control filtering, cost, or labeling that does not alter the LLM classification itself.

| Parameter                            | Why No Backfill                                                                                                                                                            |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `confidenceThreshold`                | The stored `confidence` score does not change. The threshold is applied at query time. Re-labeling `unknown` vs a category can be done via SQL without re-running the LLM. |
| `unknownIntentLabel`                 | A display-level change. The output label can be overridden at read time.                                                                                                   |
| `scope.channels`                     | Adding a channel means new conversations are processed. Removing means new ones are skipped. Existing classifications remain valid.                                        |
| `scope.agents`                       | Same as channels.                                                                                                                                                          |
| `scope.minMessageCount`              | Changes eligibility, not classification logic.                                                                                                                             |
| `scope.excludeTags`                  | Same as above.                                                                                                                                                             |
| `scope.sampleRate`                   | Controls volume, not accuracy.                                                                                                                                             |
| `scope.processingDelay`              | Affects timing, not output.                                                                                                                                                |
| `scope.lookbackDays`                 | Only affects backfill window, not live processing.                                                                                                                         |
| `modelConfig.maxTokens`              | Affects output truncation risk but not classification logic.                                                                                                               |
| `modelConfig.maxCostPerDay`          | Cost guard. Does not affect classification output.                                                                                                                         |
| `modelConfig.maxCostPerConversation` | Same as above.                                                                                                                                                             |
| `maxCategories`                      | A guard limit, not a classification parameter.                                                                                                                             |

---

## 2.10 Studio UI Design

### Navigation

The intent classification config page is accessed via:

```
Project Settings > Analytics Pipelines > Intent Classification
```

Route: `/projects/:projectId/settings/pipelines/intent-classification`

### Page Layout

The page uses a single-column layout with collapsible sections, consistent with the existing Settings tab patterns (`ModelConfigTab`, `SettingsTab`).

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  ← Back to Analytics Pipelines                                              │
│                                                                             │
│  Intent Classification                                           [Enabled ◉]│
│  Classifies the primary intent of each conversation.                        │
│  Last processed: 2 minutes ago  |  Config version: 3  |  Taxonomy v3       │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ▼ Intent Taxonomy                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Define the intents you want to classify. Leave empty for          │    │
│  │  automatic discovery.                                     [+ Add]  │    │
│  │                                                                     │    │
│  │  ┌ Billing                                              [Edit] [×] │    │
│  │  │  "Customer inquiries related to billing..."                     │    │
│  │  │  ├─ Billing - Refund Request                  2 examples        │    │
│  │  │  └─ Billing - Charge Dispute                  2 examples        │    │
│  │  │                                                                  │    │
│  │  ┌ Technical Support                                    [Edit] [×] │    │
│  │  │  "Customer experiencing technical issues..."                    │    │
│  │  │  └─ Technical - Connectivity Issues           2 examples        │    │
│  │  │                                                                  │    │
│  │  ┌ Account Management                                   [Edit] [×] │    │
│  │  │  "Account changes, updates..."                                  │    │
│  │  │                                                                  │    │
│  │  ┌ Cancellation                                         [Edit] [×] │    │
│  │  │  "Customer wants to cancel..."                                  │    │
│  │  └───────────────────────────────────────────────────────────────┘  │    │
│  │                                                                     │    │
│  │  4 categories, 3 sub-categories  |  Max: 200                       │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  ▼ Classification Settings                                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                                                                     │    │
│  │  Auto-discover new intents          [◉ On]                          │    │
│  │  ℹ Discovers intent patterns not in your taxonomy.                  │    │
│  │                                                                     │    │
│  │  Merge threshold                    [=====●===] 0.85                │    │
│  │  ℹ How similar two clusters must be to merge. Higher = stricter.    │    │
│  │                                                                     │    │
│  │  Allow multiple intents             [○ Off]                         │    │
│  │  ℹ When on, a conversation can have more than one intent label.     │    │
│  │                                                                     │    │
│  │  Confidence threshold               [=====●===] 0.70               │    │
│  │  ℹ Below this, conversations are labeled "unknown".                 │    │
│  │    Does not require re-processing when changed.                     │    │
│  │                                                                     │    │
│  │  Unknown intent label               [ unknown          ]            │    │
│  │  ℹ Label for low-confidence classifications.                        │    │
│  │                                                                     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  ▼ Input Selection                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                                                                     │    │
│  │  Message strategy         [ First N user messages      ▼]           │    │
│  │  ℹ Which messages to include when classifying.                      │    │
│  │                                                                     │    │
│  │  Number of messages       [ 3                  ]                    │    │
│  │  ℹ How many user messages to include (when using "First N").        │    │
│  │                                                                     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  ▼ Conversation Filters                                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                                                                     │    │
│  │  Channels                 [+ Add channel filter]                    │    │
│  │  ℹ Process only these channels. Leave empty for all.                │    │
│  │                                                                     │    │
│  │  Agents                   [+ Add agent filter]                      │    │
│  │  ℹ Process only these agents' conversations.                        │    │
│  │                                                                     │    │
│  │  Minimum messages         [ 2                  ]                    │    │
│  │  ℹ Skip conversations with fewer messages.                          │    │
│  │                                                                     │    │
│  │  Exclude tags             [+ Add tag]                               │    │
│  │  ℹ Skip conversations with these tags.                              │    │
│  │                                                                     │    │
│  │  Sample rate              [=========●] 100%                         │    │
│  │  ℹ Fraction of conversations to process. Use < 100% to save cost.  │    │
│  │                                                                     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  ▸ Advanced Settings                                          (collapsed)   │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  • LLM Provider / Model override                                   │    │
│  │  • Temperature                                                      │    │
│  │  • Max tokens                                                       │    │
│  │  • Cost limits (per day / per conversation)                         │    │
│  │  • Custom classification prompt                                     │    │
│  │  • Processing delay                                                 │    │
│  │  • Backfill lookback days                                           │    │
│  │  • Max categories / Max examples per category                       │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ ⚠ Taxonomy changed since last processing. 1,247 conversations      │    │
│  │   were classified with the previous taxonomy.                       │    │
│  │                                           [Re-process] [Dismiss]    │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│                                         [Cancel]  [Save Configuration]      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Taxonomy Editor Dialog

When the user clicks **[+ Add]** or **[Edit]** on a category:

```
┌─────────────────────────────────────────────────────────────────┐
│  Add Intent Category                                    [×]     │
│                                                                 │
│  Name (machine ID)           [ billing_refund         ]         │
│  ℹ Lowercase, underscores. Used in filters and exports.         │
│  Validation: ^[a-z][a-z0-9_]*$                                  │
│                                                                 │
│  Display Name                [ Billing - Refund Request ]       │
│  ℹ Human-readable label shown in dashboards.                    │
│                                                                 │
│  Description                                                    │
│  [ Customer requesting a refund for a charge         ]          │
│  ℹ Helps the AI understand this category. Be specific.          │
│                                                                 │
│  Parent Category             [ Billing               ▼]         │
│  ℹ Optional. Creates a hierarchy (e.g., Billing > Refund).      │
│     "(none - top level)" is the default.                        │
│                                                                 │
│  Example Utterances                                             │
│  ┌───────────────────────────────────────────────────────┐      │
│  │ "I want a refund for the overcharge on my account" [×]│      │
│  │ "Can you reverse the charge from last Tuesday?"    [×]│      │
│  └───────────────────────────────────────────────────────┘      │
│  [+ Add example]                                                │
│  ℹ 2-5 examples improve accuracy. Max 5 per category.           │
│                                                                 │
│                              [Cancel]  [Save Category]          │
└─────────────────────────────────────────────────────────────────┘
```

### UI Component Mapping

| Section                     | Components                                                                                                                             | Data Binding                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Enable toggle               | `Switch` component in header bar                                                                                                       | `enabled` (outer document)                                                      |
| Taxonomy tree               | Custom `TaxonomyTree` component with expand/collapse. Each node shows `displayName`, description preview, and example count.           | `config.taxonomy.categories`                                                    |
| Taxonomy editor             | `Dialog` with form fields                                                                                                              | Single `IntentCategory`                                                         |
| Auto-discovery toggle       | `Switch`                                                                                                                               | `config.autoDiscovery`                                                          |
| Merge threshold slider      | `Slider` with numeric input                                                                                                            | `config.autoDiscoveryMergeThreshold`                                            |
| Multi-label toggle          | `Switch`                                                                                                                               | `config.multiLabel`                                                             |
| Confidence threshold slider | `Slider` with numeric input                                                                                                            | `config.confidenceThreshold`                                                    |
| Unknown label               | `Input` (text)                                                                                                                         | `config.unknownIntentLabel`                                                     |
| Message strategy            | `Select` dropdown                                                                                                                      | `config.inputMessageStrategy`                                                   |
| Message count               | `Input` (number), conditionally shown                                                                                                  | `config.inputMessageCount`                                                      |
| Channel/agent filters       | Multi-select chip input, populated from project's known channels/agents                                                                | `config.scope.channels`, `config.scope.agents`                                  |
| Min messages                | `Input` (number)                                                                                                                       | `config.scope.minMessageCount`                                                  |
| Exclude tags                | Multi-select chip input                                                                                                                | `config.scope.excludeTags`                                                      |
| Sample rate                 | `Slider` (displayed as percentage)                                                                                                     | `config.scope.sampleRate`                                                       |
| Provider/Model              | `Select` dropdowns, populated from tenant model catalog                                                                                | `config.modelConfig.provider`, `config.modelConfig.model`                       |
| Temperature                 | `Slider` with numeric input                                                                                                            | `config.modelConfig.temperature`                                                |
| Max tokens                  | `Input` (number)                                                                                                                       | `config.modelConfig.maxTokens`                                                  |
| Cost limits                 | `Input` (currency) with null = "No limit" toggle                                                                                       | `config.modelConfig.maxCostPerDay`, `config.modelConfig.maxCostPerConversation` |
| Custom prompt               | `Textarea` (collapsible, advanced)                                                                                                     | `config.classificationPrompt`                                                   |
| Processing delay            | `Input` (number, minutes)                                                                                                              | `config.scope.processingDelay`                                                  |
| Lookback days               | `Input` (number)                                                                                                                       | `config.scope.lookbackDays`                                                     |
| Max categories              | `Input` (number)                                                                                                                       | `config.maxCategories`                                                          |
| Max examples                | `Input` (number)                                                                                                                       | `config.maxExamplesPerCategory`                                                 |
| Re-process banner           | `Alert` component (warning variant), shown when `configHistory` latest has `reprocessingRequired: true` and backfill has not run since | Derived from `configHistory` + `lastBackfillAt`                                 |
| Save button                 | `Button` (primary)                                                                                                                     | `PUT /api/projects/:projectId/pipelines/intent_classification/config`           |
| Re-process button           | `Button` (secondary)                                                                                                                   | `POST /api/projects/:projectId/pipelines/intent_classification/backfill`        |

### Help Text & Tooltips

Every parameter has an inline help text (shown below the input) and an optional tooltip for longer explanations. The help text follows the pattern used in `ModelConfigTab` and `OperationTierSection`:

```tsx
<Tooltip content={t('intent.taxonomy_tooltip')} side="right">
  <button
    type="button"
    className="inline-flex items-center justify-center p-0.5 text-muted hover:text-foreground transition-default rounded"
  >
    <Info className="w-3.5 h-3.5" />
  </button>
</Tooltip>
```

### i18n Keys

All user-facing strings use the `useTranslations('settings.pipelines.intent')` namespace:

```
settings.pipelines.intent.title = "Intent Classification"
settings.pipelines.intent.description = "Classifies the primary intent of each conversation."
settings.pipelines.intent.taxonomy.title = "Intent Taxonomy"
settings.pipelines.intent.taxonomy.empty = "No taxonomy defined. The pipeline will auto-discover intents."
settings.pipelines.intent.taxonomy.add = "Add Category"
settings.pipelines.intent.taxonomy.count = "{count} categories, {subCount} sub-categories"
settings.pipelines.intent.taxonomy.max = "Max: {max}"
settings.pipelines.intent.classification.title = "Classification Settings"
settings.pipelines.intent.auto_discovery.label = "Auto-discover new intents"
settings.pipelines.intent.auto_discovery.help = "Discovers intent patterns not in your taxonomy."
settings.pipelines.intent.merge_threshold.label = "Merge threshold"
settings.pipelines.intent.merge_threshold.help = "How similar two clusters must be to merge. Higher = stricter."
settings.pipelines.intent.multi_label.label = "Allow multiple intents"
settings.pipelines.intent.multi_label.help = "When on, a conversation can have more than one intent label."
settings.pipelines.intent.confidence.label = "Confidence threshold"
settings.pipelines.intent.confidence.help = "Below this, conversations are labeled as unknown. Does not require re-processing."
settings.pipelines.intent.unknown_label.label = "Unknown intent label"
settings.pipelines.intent.unknown_label.help = "Label for low-confidence classifications."
settings.pipelines.intent.input.title = "Input Selection"
settings.pipelines.intent.strategy.label = "Message strategy"
settings.pipelines.intent.strategy.help = "Which messages to include when classifying."
settings.pipelines.intent.strategy.first_user = "First user message only"
settings.pipelines.intent.strategy.first_n_user = "First N user messages"
settings.pipelines.intent.strategy.all_user = "All user messages"
settings.pipelines.intent.strategy.full_transcript = "Full transcript"
settings.pipelines.intent.message_count.label = "Number of messages"
settings.pipelines.intent.message_count.help = "How many user messages to include (when using 'First N')."
settings.pipelines.intent.filters.title = "Conversation Filters"
settings.pipelines.intent.channels.label = "Channels"
settings.pipelines.intent.channels.help = "Process only these channels. Leave empty for all."
settings.pipelines.intent.agents.label = "Agents"
settings.pipelines.intent.agents.help = "Process only these agents' conversations."
settings.pipelines.intent.min_messages.label = "Minimum messages"
settings.pipelines.intent.min_messages.help = "Skip conversations with fewer messages."
settings.pipelines.intent.exclude_tags.label = "Exclude tags"
settings.pipelines.intent.exclude_tags.help = "Skip conversations with these tags."
settings.pipelines.intent.sample_rate.label = "Sample rate"
settings.pipelines.intent.sample_rate.help = "Fraction of conversations to process. Use less than 100% to save cost."
settings.pipelines.intent.advanced.title = "Advanced Settings"
settings.pipelines.intent.reprocess.banner = "Taxonomy changed since last processing. {count} conversations were classified with the previous taxonomy."
settings.pipelines.intent.reprocess.button = "Re-process"
settings.pipelines.intent.reprocess.dismiss = "Dismiss"
settings.pipelines.intent.save = "Save Configuration"
settings.pipelines.intent.saved = "Configuration saved."
settings.pipelines.intent.save_failed = "Failed to save configuration."
```

---

## API Endpoints

The configuration is managed via these REST endpoints (defined in Task 16 of the phase 2 plan):

| Method | Endpoint                                                            | Description                                                                                                                                                    |
| ------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/projects/:projectId/pipelines/intent_classification/config`   | Get resolved config (project > tenant > defaults). Returns the effective config with defaults applied.                                                         |
| `PUT`  | `/api/projects/:projectId/pipelines/intent_classification/config`   | Save/update config. Body: `{ config: IntentClassificationPipelineConfig, enabled?: boolean }`. Returns the saved document with `reprocessingRecommended` flag. |
| `POST` | `/api/projects/:projectId/pipelines/intent_classification/backfill` | Trigger historical re-processing. Returns `{ backfillId, estimatedConversations, estimatedCost }`.                                                             |
| `GET`  | `/api/projects/:projectId/pipelines/intent_classification/status`   | Get processing status: `lastProcessedAt`, `backfillStatus`, `backfillProgress`, `conversationsProcessed`, `dailyCostUsed`.                                     |

### Auth & Permissions

All endpoints require:

- `requireAuth` middleware (from `createUnifiedAuthMiddleware`)
- `requireProjectPermission(req, res, 'pipeline:write')` for PUT/POST
- `requireProjectPermission(req, res, 'pipeline:read')` for GET
- Tenant isolation: all queries include `tenantId` from the auth context

### PUT Request Validation

The `PUT` endpoint validates the incoming `config` body against the rules in section 2.5. Validation is performed server-side using a dedicated validator function. The response includes:

```typescript
interface SaveConfigResponse {
  success: true;
  data: {
    config: IPipelineConfig;
    reprocessingRecommended: boolean;
    changedFields: string[];
    reprocessFields: string[]; // subset of changedFields that triggered the recommendation
  };
}
```

---

## Implementation Notes

### Default Application at Runtime

The pipeline engine resolves defaults at execution time, not at storage time. This means:

1. The MongoDB document stores only what the customer explicitly set.
2. The `resolveConfig` method returns the raw document.
3. The `applyDefaults` utility merges the raw config with `INTENT_CLASSIFICATION_DEFAULTS`.
4. This allows platform defaults to evolve (e.g., changing the default model) without requiring a migration of existing configs.

### Taxonomy Version Tracking

`taxonomyVersion` is managed by the API, not the customer:

1. On `PUT`, if the `taxonomy` field diff is non-empty, increment `taxonomyVersion`.
2. The version is written into ClickHouse `taxonomy_version` column for provenance.
3. This allows dashboard queries to detect mixed-version classifications: `SELECT DISTINCT taxonomy_version FROM intent_classifications WHERE tenant_id = ?`.

### Custom Prompt Safety

The `classificationPrompt` field is an advanced escape hatch. The UI should:

1. Hide it behind the "Advanced Settings" collapsible section.
2. Show a warning: "Custom prompts override the platform's tested classification logic. Changes may affect accuracy."
3. Validate max length (4000 chars) but not content (customers may have domain-specific needs).
4. Log custom prompt usage in audit events for support debugging.

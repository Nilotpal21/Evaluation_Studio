# Phase 2: Customer Configuration Schema -- Sentiment Analysis Pipeline

> **Pipeline**: Sentiment Analysis
> **Date**: 2026-03-03
> **Status**: Design
> **Depends on**: Phase 1 (Input Data Readiness Audit) -- completed
> **Feeds**: Phase 3 (Output Schema), Phase 4 (Presentation), Phase 5 (Index & Performance)

---

## Completed Checklist

- [x] **2.1** List all tunable parameters for this pipeline
- [x] **2.2** Classify each: REQUIRED vs OPTIONAL
- [x] **2.3** Define sensible platform defaults for all OPTIONAL parameters
- [x] **2.4** Design the MongoDB schema for pipeline configuration
- [x] **2.5** Define validation rules (min/max, enum values, required fields)
- [x] **2.6** Determine scope: tenant-level, project-level, or agent-level configuration
- [x] **2.7** Plan configuration versioning (when customer changes config, do we re-run?)
- [x] **2.8** Identify parameters that require pipeline re-processing when changed
- [x] **2.9** Identify parameters that only affect future processing (no backfill needed)
- [x] **2.10** Design the Studio UI for configuration (inputs, defaults, help text)

---

## 2.1 All Tunable Parameters

Parameters are organized into three groups matching the base config interfaces from the skill:

### Group A: Processing Scope (PipelineScopeConfig)

| #   | Parameter         | Purpose                                                          |
| --- | ----------------- | ---------------------------------------------------------------- |
| A1  | `channels`        | Restrict processing to specific channels (web_chat, voice, etc.) |
| A2  | `agents`          | Restrict processing to conversations handled by specific agents  |
| A3  | `minMessageCount` | Skip conversations with fewer than N messages                    |
| A4  | `excludeTags`     | Skip conversations tagged with specific labels                   |
| A5  | `sampleRate`      | Process a fraction of conversations (cost control)               |
| A6  | `lookbackDays`    | How far back to process on initial enable / backfill             |
| A7  | `processingDelay` | Minutes to wait after session_end before processing              |

### Group B: Model & Provider (PipelineModelConfig)

| #   | Parameter                | Purpose                                                 |
| --- | ------------------------ | ------------------------------------------------------- |
| B1  | `provider`               | LLM provider (anthropic, openai, gemini)                |
| B2  | `model`                  | Specific model ID                                       |
| B3  | `temperature`            | LLM temperature for sentiment scoring                   |
| B4  | `maxTokens`              | Max output tokens per LLM call                          |
| B5  | `maxCostPerDay`          | Daily cost cap in USD -- pause processing if exceeded   |
| B6  | `maxCostPerConversation` | Per-conversation cost cap in USD -- skip expensive ones |

### Group C: Sentiment-Specific (SentimentAnalysisConfig)

| #   | Parameter             | Purpose                                                                        |
| --- | --------------------- | ------------------------------------------------------------------------------ |
| C1  | `granularity`         | Score at message level, conversation level, or both                            |
| C2  | `scale`               | Score representation: binary, ternary, or continuous                           |
| C3  | `detectTrajectory`    | Whether to compute improving/declining/stable trajectory                       |
| C4  | `pivotDetection`      | Whether to detect sentiment shift points (inflection turns)                    |
| C5  | `pivotThreshold`      | Minimum absolute score change between consecutive messages to count as a pivot |
| C6  | `detectFrustration`   | Whether to detect frustration signals (ALL CAPS, repetition, keywords)         |
| C7  | `frustrationKeywords` | Customer-specific keywords that indicate frustration                           |
| C8  | `analyzeRoles`        | Which message roles to score (user, assistant, or both)                        |

**Total: 21 parameters** (7 scope + 6 model + 8 sentiment-specific)

---

## 2.2 Required vs Optional Classification

### REQUIRED Parameters

**None.** Every parameter has a sensible platform default. The sentiment pipeline is a "zero-config" pipeline: enabling it with all defaults produces useful output immediately. This is by design -- sentiment analysis has a well-defined universal interpretation unlike quality evaluation (which requires a customer-defined rubric) or intent classification (which benefits from a customer taxonomy).

### OPTIONAL Parameters (all 21)

Every parameter is optional. The customer can override any subset; unset values resolve from the configuration chain: project config > tenant config > platform defaults.

---

## 2.3 Platform Defaults

### Group A: Processing Scope Defaults

| Parameter         | Default             | Rationale                                                                            |
| ----------------- | ------------------- | ------------------------------------------------------------------------------------ |
| `channels`        | `[]` (all channels) | No reason to exclude channels by default                                             |
| `agents`          | `[]` (all agents)   | Analyze all agents uniformly                                                         |
| `minMessageCount` | `2`                 | Single-message sessions (e.g., greeting-only) are not useful for sentiment           |
| `excludeTags`     | `[]`                | No default exclusions                                                                |
| `sampleRate`      | `1.0`               | Process all conversations; customer can reduce for cost                              |
| `lookbackDays`    | `30`                | One month of history on initial enable; bounded by ClickHouse messages TTL (90 days) |
| `processingDelay` | `5`                 | 5 minutes after session_end -- allows late messages to arrive                        |

### Group B: Model & Provider Defaults

| Parameter                | Default                   | Rationale                                                                                           |
| ------------------------ | ------------------------- | --------------------------------------------------------------------------------------------------- |
| `provider`               | `null` (platform default) | Resolves via `SessionLLMClient` credential resolution: project > tenant > platform                  |
| `model`                  | `null` (platform default) | Platform selects the cheapest `fast` tier model available (e.g., `claude-haiku-4-5`, `gpt-4o-mini`) |
| `temperature`            | `0.0`                     | Sentiment scoring should be deterministic/reproducible                                              |
| `maxTokens`              | `256`                     | Sentiment response is structured JSON, rarely exceeds 150 tokens                                    |
| `maxCostPerDay`          | `null` (unlimited)        | No cost cap by default; customer enables if needed                                                  |
| `maxCostPerConversation` | `0.05`                    | Skip conversations that would cost more than 5 cents (safety net for very long transcripts)         |

### Group C: Sentiment-Specific Defaults

| Parameter             | Default        | Rationale                                                                                               |
| --------------------- | -------------- | ------------------------------------------------------------------------------------------------------- |
| `granularity`         | `'both'`       | Produce both per-message and conversation-level scores for maximum flexibility                          |
| `scale`               | `'continuous'` | Continuous (-1.0 to +1.0) is the most informative; can be post-bucketed to ternary/binary at query time |
| `detectTrajectory`    | `true`         | Trajectory is one of the highest-value outputs (improving/declining/stable)                             |
| `pivotDetection`      | `true`         | Pivot points identify the exact turn where sentiment shifted                                            |
| `pivotThreshold`      | `0.3`          | A 0.3-point change on a 2.0-point range (-1 to +1) is a 15% shift -- significant                        |
| `detectFrustration`   | `true`         | Frustration signals complement sentiment and are zero-cost (pattern matching, no extra LLM call)        |
| `frustrationKeywords` | `[]`           | No domain-specific keywords by default; customer adds their own                                         |
| `analyzeRoles`        | `['user']`     | User sentiment is the primary use case; analyzing assistant messages is optional and doubles LLM cost   |

---

## 2.4 MongoDB Schema

### Collection: `pipeline_configs`

The sentiment pipeline config lives in the shared `pipeline_configs` collection alongside all other pipeline types, keyed by `(tenantId, pipelineType, projectId)`.

### Document Interface

```typescript
// MongoDB collection: pipeline_configs
// Unique index: { tenantId: 1, pipelineType: 1, projectId: 1 }

interface PipelineConfigDocument {
  _id: ObjectId;
  tenantId: string; // REQUIRED -- tenant isolation
  projectId: string | null; // null = tenant-level config; string = project override
  pipelineType: 'sentiment_analysis'; // Discriminator for this pipeline

  version: number; // Auto-incremented on every save
  enabled: boolean; // Master on/off switch

  config: SentimentAnalysisConfig; // The typed pipeline-specific config

  // Processing state (managed by the engine, not the customer)
  lastBackfillAt: Date | null;
  backfillStatus: 'idle' | 'running' | 'completed' | 'failed';
  lastProcessedAt: Date | null;

  // Audit
  createdBy: string;
  updatedBy: string;
  createdAt: Date; // Mongoose timestamps
  updatedAt: Date;

  // Change history (last 20 changes, capped array)
  configHistory: ConfigChange[];
}

interface ConfigChange {
  version: number;
  changedBy: string;
  changedAt: Date;
  diff: Record<string, { old: unknown; new: unknown }>;
  reprocessingRequired: boolean;
}
```

### Full Typed Config Interface

```typescript
/**
 * SentimentAnalysisConfig
 *
 * All fields are optional. Unset fields resolve from the config chain:
 *   project config > tenant config > platform defaults
 *
 * Stored as the `config` field in a pipeline_configs document
 * where pipelineType === 'sentiment_analysis'.
 */
interface SentimentAnalysisConfig {
  // ── Group A: Processing Scope ──────────────────────────────────
  channels?: string[]; // [] = all
  agents?: string[]; // [] = all
  minMessageCount?: number; // default: 2
  excludeTags?: string[]; // default: []
  sampleRate?: number; // default: 1.0
  lookbackDays?: number; // default: 30
  processingDelay?: number; // default: 5 (minutes)

  // ── Group B: Model & Provider ──────────────────────────────────
  provider?: string; // default: platform default
  model?: string; // default: platform default (fast tier)
  temperature?: number; // default: 0.0
  maxTokens?: number; // default: 256
  maxCostPerDay?: number; // default: null (unlimited)
  maxCostPerConversation?: number; // default: 0.05

  // ── Group C: Sentiment-Specific ────────────────────────────────
  granularity?: 'message' | 'conversation' | 'both'; // default: 'both'
  scale?: 'binary' | 'ternary' | 'continuous'; // default: 'continuous'

  detectTrajectory?: boolean; // default: true
  pivotDetection?: boolean; // default: true
  pivotThreshold?: number; // default: 0.3

  detectFrustration?: boolean; // default: true
  frustrationKeywords?: string[]; // default: []

  analyzeRoles?: Array<'user' | 'assistant'>; // default: ['user']
}
```

### Mongoose Schema Definition

```typescript
// packages/pipeline-engine/src/pipeline/schemas/sentiment-config.schema.ts

import { Schema, model, type Document } from 'mongoose';

const SentimentConfigSchema = new Schema(
  {
    tenantId: { type: String, required: true, index: true },
    projectId: { type: String, default: null },
    pipelineType: {
      type: String,
      required: true,
      enum: ['sentiment_analysis'],
      default: 'sentiment_analysis',
    },
    version: { type: Number, required: true, default: 1 },
    enabled: { type: Boolean, required: true, default: false },

    config: {
      // Scope
      channels: { type: [String], default: undefined },
      agents: { type: [String], default: undefined },
      minMessageCount: { type: Number, default: undefined },
      excludeTags: { type: [String], default: undefined },
      sampleRate: { type: Number, default: undefined },
      lookbackDays: { type: Number, default: undefined },
      processingDelay: { type: Number, default: undefined },

      // Model
      provider: { type: String, default: undefined },
      model: { type: String, default: undefined },
      temperature: { type: Number, default: undefined },
      maxTokens: { type: Number, default: undefined },
      maxCostPerDay: { type: Number, default: undefined },
      maxCostPerConversation: { type: Number, default: undefined },

      // Sentiment-specific
      granularity: {
        type: String,
        enum: ['message', 'conversation', 'both'],
        default: undefined,
      },
      scale: {
        type: String,
        enum: ['binary', 'ternary', 'continuous'],
        default: undefined,
      },
      detectTrajectory: { type: Boolean, default: undefined },
      pivotDetection: { type: Boolean, default: undefined },
      pivotThreshold: { type: Number, default: undefined },
      detectFrustration: { type: Boolean, default: undefined },
      frustrationKeywords: { type: [String], default: undefined },
      analyzeRoles: {
        type: [{ type: String, enum: ['user', 'assistant'] }],
        default: undefined,
      },
    },

    // Processing state
    lastBackfillAt: { type: Date, default: null },
    backfillStatus: {
      type: String,
      enum: ['idle', 'running', 'completed', 'failed'],
      default: 'idle',
    },
    lastProcessedAt: { type: Date, default: null },

    // Audit
    createdBy: { type: String, required: true },
    updatedBy: { type: String, required: true },

    // Change history (capped at 20 entries)
    configHistory: {
      type: [
        {
          version: Number,
          changedBy: String,
          changedAt: Date,
          diff: Schema.Types.Mixed,
          reprocessingRequired: Boolean,
        },
      ],
      default: [],
    },
  },
  {
    timestamps: true,
    collection: 'pipeline_configs',
  },
);

// ── Indexes ────────────────────────────────────────────────────────────────
// Primary lookup: find config for a tenant + pipeline + project
SentimentConfigSchema.index({ tenantId: 1, pipelineType: 1, projectId: 1 }, { unique: true });
// Find all enabled pipelines for a tenant (used by scheduler)
SentimentConfigSchema.index({ tenantId: 1, enabled: 1 });

export const PipelineConfigModel = model('PipelineConfig', SentimentConfigSchema);
```

---

## 2.5 Validation Rules

### Full Validation Table

| Parameter                | Type       | Validation                                                                                         | Error Message                                                                 |
| ------------------------ | ---------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `channels`               | `string[]` | Each element: non-empty string, max 64 chars. Array max length: 50.                                | `"Each channel must be a non-empty string (max 64 chars)"`                    |
| `agents`                 | `string[]` | Each element: non-empty string, max 128 chars. Array max length: 100.                              | `"Each agent name must be a non-empty string (max 128 chars)"`                |
| `minMessageCount`        | `number`   | Integer, min: 1, max: 1000.                                                                        | `"minMessageCount must be an integer between 1 and 1000"`                     |
| `excludeTags`            | `string[]` | Each element: non-empty string, max 64 chars. Array max length: 100.                               | `"Each tag must be a non-empty string (max 64 chars)"`                        |
| `sampleRate`             | `number`   | Float, min: 0.01, max: 1.0.                                                                        | `"sampleRate must be between 0.01 and 1.0"`                                   |
| `lookbackDays`           | `number`   | Integer, min: 1, max: 90. Capped at 90 because ClickHouse messages TTL is 90 days.                 | `"lookbackDays must be between 1 and 90"`                                     |
| `processingDelay`        | `number`   | Integer, min: 0, max: 1440 (24 hours).                                                             | `"processingDelay must be between 0 and 1440 minutes"`                        |
| `provider`               | `string`   | Enum: validated against tenant's configured LLM providers.                                         | `"provider must be one of the tenant's configured providers"`                 |
| `model`                  | `string`   | Validated against available models for the selected provider.                                      | `"model must be available for the selected provider"`                         |
| `temperature`            | `number`   | Float, min: 0.0, max: 1.0. (Sentiment should not use high temperatures.)                           | `"temperature must be between 0.0 and 1.0"`                                   |
| `maxTokens`              | `number`   | Integer, min: 64, max: 1024. (Sentiment output is compact structured JSON.)                        | `"maxTokens must be between 64 and 1024"`                                     |
| `maxCostPerDay`          | `number`   | Float, min: 0.01, max: 10000.0. Null = unlimited.                                                  | `"maxCostPerDay must be between $0.01 and $10,000"`                           |
| `maxCostPerConversation` | `number`   | Float, min: 0.001, max: 10.0.                                                                      | `"maxCostPerConversation must be between $0.001 and $10.00"`                  |
| `granularity`            | `string`   | Enum: `'message'`, `'conversation'`, `'both'`.                                                     | `"granularity must be 'message', 'conversation', or 'both'"`                  |
| `scale`                  | `string`   | Enum: `'binary'`, `'ternary'`, `'continuous'`.                                                     | `"scale must be 'binary', 'ternary', or 'continuous'"`                        |
| `detectTrajectory`       | `boolean`  | Boolean only.                                                                                      | `"detectTrajectory must be true or false"`                                    |
| `pivotDetection`         | `boolean`  | Boolean only.                                                                                      | `"pivotDetection must be true or false"`                                      |
| `pivotThreshold`         | `number`   | Float, min: 0.05, max: 1.0. Only validated when `pivotDetection !== false`.                        | `"pivotThreshold must be between 0.05 and 1.0"`                               |
| `detectFrustration`      | `boolean`  | Boolean only.                                                                                      | `"detectFrustration must be true or false"`                                   |
| `frustrationKeywords`    | `string[]` | Each element: non-empty string, max 128 chars, lowercased on save. Array max length: 200.          | `"Each keyword must be a non-empty string (max 128 chars, max 200 keywords)"` |
| `analyzeRoles`           | `string[]` | Each element must be `'user'` or `'assistant'`. Array must have at least 1 element. Max length: 2. | `"analyzeRoles must contain at least one of 'user' or 'assistant'"`           |

### Cross-Field Validation Rules

1. If `granularity === 'message'`, trajectory and pivot detection are automatically disabled (they require conversation-level aggregation). The API should warn but not reject.
2. If `pivotDetection === false`, `pivotThreshold` is ignored (but still validated if present).
3. If `detectFrustration === false`, `frustrationKeywords` is ignored (but still validated if present).
4. If `analyzeRoles` includes `'assistant'`, the API should display a cost warning: assistant message scoring doubles the per-conversation LLM cost.
5. If `sampleRate < 1.0` and `lookbackDays > 0`, backfill also uses the sample rate (no full backfill at reduced sample rate).

### Zod Validation Schema

```typescript
// packages/pipeline-engine/src/pipeline/schemas/sentiment-config.validation.ts

import { z } from 'zod';

const nonEmptyString = (maxLen: number) => z.string().min(1).max(maxLen);

export const SentimentAnalysisConfigSchema = z
  .object({
    // Scope
    channels: z.array(nonEmptyString(64)).max(50).optional(),
    agents: z.array(nonEmptyString(128)).max(100).optional(),
    minMessageCount: z.number().int().min(1).max(1000).optional(),
    excludeTags: z.array(nonEmptyString(64)).max(100).optional(),
    sampleRate: z.number().min(0.01).max(1.0).optional(),
    lookbackDays: z.number().int().min(1).max(90).optional(),
    processingDelay: z.number().int().min(0).max(1440).optional(),

    // Model
    provider: z.string().min(1).max(64).optional(),
    model: z.string().min(1).max(128).optional(),
    temperature: z.number().min(0.0).max(1.0).optional(),
    maxTokens: z.number().int().min(64).max(1024).optional(),
    maxCostPerDay: z.number().min(0.01).max(10000).nullable().optional(),
    maxCostPerConversation: z.number().min(0.001).max(10.0).optional(),

    // Sentiment-specific
    granularity: z.enum(['message', 'conversation', 'both']).optional(),
    scale: z.enum(['binary', 'ternary', 'continuous']).optional(),
    detectTrajectory: z.boolean().optional(),
    pivotDetection: z.boolean().optional(),
    pivotThreshold: z.number().min(0.05).max(1.0).optional(),
    detectFrustration: z.boolean().optional(),
    frustrationKeywords: z
      .array(nonEmptyString(128))
      .max(200)
      .transform((kw) => kw.map((k) => k.toLowerCase()))
      .optional(),
    analyzeRoles: z
      .array(z.enum(['user', 'assistant']))
      .min(1)
      .max(2)
      .optional(),
  })
  .superRefine((data, ctx) => {
    // Cross-field: warn if granularity=message but trajectory/pivot enabled
    if (data.granularity === 'message') {
      if (data.detectTrajectory === true) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['detectTrajectory'],
          message:
            'Trajectory detection requires conversation-level analysis. Set granularity to "conversation" or "both".',
        });
      }
      if (data.pivotDetection === true) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['pivotDetection'],
          message:
            'Pivot detection requires conversation-level analysis. Set granularity to "conversation" or "both".',
        });
      }
    }
  });

export type ValidatedSentimentConfig = z.infer<typeof SentimentAnalysisConfigSchema>;
```

---

## 2.6 Configuration Scope

### Resolution Chain

```
1. Project-level config   (pipeline_configs WHERE tenantId AND projectId = :projectId)
2. Tenant-level config    (pipeline_configs WHERE tenantId AND projectId IS NULL)
3. Platform defaults      (hardcoded constants in SENTIMENT_DEFAULTS)
```

### Scope Decision per Parameter Group

| Group                     | Scope                              | Rationale                                                                                                                                               |
| ------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A: Processing Scope**   | Project-level                      | Different projects may have different agents/channels. A customer with projects "Support" and "Sales" would configure different agent filters for each. |
| **B: Model & Provider**   | Tenant-level with project override | Provider/model credentials are typically tenant-wide. Individual projects can override to use a specific model. Cost caps differ per project.           |
| **C: Sentiment-Specific** | Tenant-level with project override | Sentiment parameters (scale, trajectory, frustration) are usually consistent across a tenant but can be overridden per project if needed.               |
| **`enabled`**             | Project-level                      | Each project independently enables/disables the pipeline.                                                                                               |

### No Agent-Level Configuration

Agent-level configuration is **not supported** for this pipeline. Rationale:

- The sentiment pipeline processes conversations, not agents. A conversation may traverse multiple agents (via handoffs).
- Filtering by agent is handled by the `agents` scope parameter, which selects which conversations to process based on the primary agent.
- If a customer wants different sentiment settings per agent, they should split them into separate projects.

### Config Resolution Implementation

```typescript
// packages/pipeline-engine/src/pipeline/services/config-resolver.ts

const SENTIMENT_DEFAULTS: Required<SentimentAnalysisConfig> = {
  // Scope
  channels: [],
  agents: [],
  minMessageCount: 2,
  excludeTags: [],
  sampleRate: 1.0,
  lookbackDays: 30,
  processingDelay: 5,

  // Model
  provider: '', // empty = platform default
  model: '', // empty = platform default (fast tier)
  temperature: 0.0,
  maxTokens: 256,
  maxCostPerDay: Infinity,
  maxCostPerConversation: 0.05,

  // Sentiment
  granularity: 'both',
  scale: 'continuous',
  detectTrajectory: true,
  pivotDetection: true,
  pivotThreshold: 0.3,
  detectFrustration: true,
  frustrationKeywords: [],
  analyzeRoles: ['user'],
};

export function resolveSentimentConfig(
  projectConfig: Partial<SentimentAnalysisConfig> | null,
  tenantConfig: Partial<SentimentAnalysisConfig> | null,
): Required<SentimentAnalysisConfig> {
  // Deep merge: project > tenant > platform defaults
  // For arrays, project fully replaces tenant (no merging of arrays)
  // For scalars, first defined value wins
  const merged: Record<string, unknown> = {};

  for (const key of Object.keys(SENTIMENT_DEFAULTS) as Array<keyof SentimentAnalysisConfig>) {
    const projectVal = projectConfig?.[key];
    const tenantVal = tenantConfig?.[key];
    const defaultVal = SENTIMENT_DEFAULTS[key];

    merged[key] =
      projectVal !== undefined ? projectVal : tenantVal !== undefined ? tenantVal : defaultVal;
  }

  return merged as Required<SentimentAnalysisConfig>;
}
```

---

## 2.7 Configuration Versioning

### Version Semantics

- Every save to a `pipeline_configs` document increments `version` by 1.
- The `version` is stored as `config_version` in every output row (`message_sentiment`, `conversation_sentiment`) for provenance tracking.
- The `configHistory` array stores the last 20 changes (capped) with the diff, who changed it, and whether re-processing was triggered.

### Re-Run Policy

When a customer changes configuration:

| Scenario                            | Behavior                                                                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Re-processing parameter changed** | System marks `backfillStatus: 'idle'` and presents "Re-analyze historical data?" prompt in Studio. Customer can accept (triggers backfill) or decline (applies to future only). |
| **Future-only parameter changed**   | Config saved immediately. Next pipeline run uses new config. No backfill offered.                                                                                               |
| **Enabled toggled ON**              | Initial backfill starts automatically for `lookbackDays` of history.                                                                                                            |
| **Enabled toggled OFF**             | Processing stops. Existing results are retained (not deleted).                                                                                                                  |

### Backfill Mechanics

When a backfill is triggered:

1. Engine queries sessions from the last `lookbackDays` that match the current scope filters.
2. Re-processes each session, inserting new rows into `message_sentiment` and `conversation_sentiment` with the new `config_version` and current `processed_at`.
3. `ReplacingMergeTree(processed_at)` ensures the latest result wins after ClickHouse merges.
4. `backfillStatus` transitions: `idle` -> `running` -> `completed` / `failed`.
5. Backfill respects `sampleRate` and `maxCostPerDay` limits.

---

## 2.8 Parameters That Require Re-Processing When Changed

These parameters change **how** the LLM scores sentiment or **what** gets stored. Existing results become inconsistent if not re-processed.

| Parameter             | Why Re-Processing Required                                                                                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scale`               | Changes the output format. Existing `continuous` scores are not comparable to `ternary` labels. Must re-score all messages.                                                                                                                                               |
| `granularity`         | If changed from `'both'` to `'message'`, conversation-level rows should still exist but trajectory/pivot columns become null. If changed to `'conversation'`, per-message rows stop being produced but historical ones remain. Re-processing recommended for consistency. |
| `analyzeRoles`        | Adding `'assistant'` means previously unscored assistant messages now need scoring. Removing `'user'` means conversation aggregates change.                                                                                                                               |
| `detectTrajectory`    | If newly enabled, historical conversations lack trajectory data. Backfill needed to compute trajectories for existing sessions.                                                                                                                                           |
| `pivotDetection`      | If newly enabled, historical conversations lack pivot data.                                                                                                                                                                                                               |
| `pivotThreshold`      | Changing the threshold redefines which score changes qualify as pivots. Existing pivot_count values become stale.                                                                                                                                                         |
| `detectFrustration`   | If newly enabled, historical messages lack frustration signals.                                                                                                                                                                                                           |
| `frustrationKeywords` | Adding new keywords means previously unflagged messages may now be flagged.                                                                                                                                                                                               |
| `provider` / `model`  | Different models produce different scores. Recommended (but not forced) to re-process for consistency. The system flags this as "recommended" but does not auto-trigger backfill.                                                                                         |
| `temperature`         | Affects LLM scoring behavior. Recommended re-processing for consistency.                                                                                                                                                                                                  |

---

## 2.9 Parameters That Only Affect Future Processing

These parameters change **which** conversations are selected or **operational** behavior. No existing results become incorrect.

| Parameter                | Why No Backfill Needed                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `channels`               | A scope filter -- changes which future conversations are selected. Existing results for previously in-scope conversations remain valid. |
| `agents`                 | Same as `channels` -- scope filter only.                                                                                                |
| `minMessageCount`        | Threshold filter. Previously processed short conversations retain their results.                                                        |
| `excludeTags`            | Tag-based filter. Future conversations with these tags are skipped.                                                                     |
| `sampleRate`             | Statistical sampling. Reducing it just means fewer future conversations are processed. Existing results are not affected.               |
| `lookbackDays`           | Only applies to initial enable / manual backfill trigger. Does not affect ongoing processing.                                           |
| `processingDelay`        | Operational timing. Affects when processing starts, not what is processed.                                                              |
| `maxTokens`              | Output buffer size. Existing results were generated with whatever maxTokens was set at the time.                                        |
| `maxCostPerDay`          | Cost control. Affects whether processing pauses, not result quality.                                                                    |
| `maxCostPerConversation` | Cost control. Affects whether individual conversations are skipped, not result quality.                                                 |

### Summary: Re-Processing Classification Matrix

| Parameter                | Category  | Backfill Impact          |
| ------------------------ | --------- | ------------------------ |
| `channels`               | Scope     | FUTURE ONLY              |
| `agents`                 | Scope     | FUTURE ONLY              |
| `minMessageCount`        | Scope     | FUTURE ONLY              |
| `excludeTags`            | Scope     | FUTURE ONLY              |
| `sampleRate`             | Scope     | FUTURE ONLY              |
| `lookbackDays`           | Scope     | FUTURE ONLY              |
| `processingDelay`        | Scope     | FUTURE ONLY              |
| `provider`               | Model     | RECOMMENDED (not forced) |
| `model`                  | Model     | RECOMMENDED (not forced) |
| `temperature`            | Model     | RECOMMENDED (not forced) |
| `maxTokens`              | Model     | FUTURE ONLY              |
| `maxCostPerDay`          | Model     | FUTURE ONLY              |
| `maxCostPerConversation` | Model     | FUTURE ONLY              |
| `granularity`            | Sentiment | REQUIRED                 |
| `scale`                  | Sentiment | REQUIRED                 |
| `detectTrajectory`       | Sentiment | REQUIRED                 |
| `pivotDetection`         | Sentiment | REQUIRED                 |
| `pivotThreshold`         | Sentiment | REQUIRED                 |
| `detectFrustration`      | Sentiment | REQUIRED                 |
| `frustrationKeywords`    | Sentiment | REQUIRED                 |
| `analyzeRoles`           | Sentiment | REQUIRED                 |

---

## 2.10 Studio UI Design

### Page Location

`Settings > Analytics > Sentiment Analysis` (project-level settings page)

The pipeline configuration is accessible from the project settings, under a new "Analytics" section alongside Intent Classification and Quality Evaluation.

### Wireframe

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Settings > Analytics > Sentiment Analysis                                  │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │  [Toggle] Enable Sentiment Analysis Pipeline                      [ON] ││
│  │  Automatically analyze the sentiment of customer conversations.        ││
│  │  Results appear in the Analytics dashboard.                            ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                             │
│  ═══════════════════════════════════════════════════════════════════════════ │
│                                                                             │
│  SENTIMENT SETTINGS                                                         │
│  ─────────────────────────────────────────────────────────────────────────── │
│                                                                             │
│  Analysis Granularity                                                       │
│  ┌──────────────────────────────────────────┐                               │
│  │  (*) Both message and conversation level │ <- default, recommended       │
│  │  ( ) Message level only                  │                               │
│  │  ( ) Conversation level only             │                               │
│  └──────────────────────────────────────────┘                               │
│  (i) "Both" produces per-message scores and conversation-level              │
│      aggregates (avg, trajectory, pivots). Most dashboards need "both".     │
│                                                                             │
│  Score Scale                                                                │
│  ┌──────────────────────────────────────────┐                               │
│  │  (*) Continuous (-1.0 to +1.0)           │ <- default                    │
│  │  ( ) Ternary (positive / neutral / neg)  │                               │
│  │  ( ) Binary (positive / negative)        │                               │
│  └──────────────────────────────────────────┘                               │
│  (i) Continuous provides the most detail. Ternary and binary are            │
│      simpler but lose nuance.                                               │
│                                                                             │
│  Roles to Analyze                                                           │
│  ┌──────────────────────────────────────────┐                               │
│  │  [x] Customer messages                   │ <- default                    │
│  │  [ ] Agent responses                     │                               │
│  └──────────────────────────────────────────┘                               │
│  (!) Enabling agent response analysis will approximately double             │
│      the LLM cost per conversation.                                         │
│                                                                             │
│  ═══════════════════════════════════════════════════════════════════════════ │
│                                                                             │
│  TRAJECTORY & PIVOT DETECTION                                               │
│  ─────────────────────────────────────────────────────────────────────────── │
│                                                                             │
│  [Toggle] Detect Sentiment Trajectory                                [ON]   │
│  Computes whether sentiment is improving, declining, or stable              │
│  across the conversation.                                                   │
│                                                                             │
│  [Toggle] Detect Pivot Points                                        [ON]   │
│  Identifies the exact turn where sentiment shifted significantly.           │
│                                                                             │
│  Pivot Threshold                                                            │
│  ┌──────────────────────────┐                                               │
│  │  [====|=======] 0.30     │  <- slider, 0.05 to 1.0, step 0.05           │
│  └──────────────────────────┘                                               │
│  Minimum score change between consecutive messages to count as a pivot.     │
│  Lower = more sensitive (more pivots detected). Higher = only major shifts. │
│                                                                             │
│  ═══════════════════════════════════════════════════════════════════════════ │
│                                                                             │
│  FRUSTRATION DETECTION                                                      │
│  ─────────────────────────────────────────────────────────────────────────── │
│                                                                             │
│  [Toggle] Detect Frustration Signals                                 [ON]   │
│  Detects ALL CAPS, excessive punctuation, repeated messages,                │
│  and frustration keywords. Zero additional LLM cost.                        │
│                                                                             │
│  Custom Frustration Keywords                                                │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  cancel ✕ | refund ✕ | unsubscribe ✕ | [+ Add keyword]             │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│  Add domain-specific words that indicate customer frustration.              │
│  Built-in detection covers ALL CAPS, repeated messages, and                 │
│  excessive punctuation (!!! ???).                                           │
│                                                                             │
│  ═══════════════════════════════════════════════════════════════════════════ │
│                                                                             │
│  PROCESSING SCOPE                                              [Collapsed] │
│  ─────────────────────────────────────────────────────────────────────────── │
│  ▼ Click to expand                                                          │
│                                                                             │
│  │ Channels          ┌──────────────────────────────────────────────────┐   │
│  │                   │ All channels (default)              [dropdown ▼] │   │
│  │                   └──────────────────────────────────────────────────┘   │
│  │                   Select specific channels to limit analysis.            │
│  │                                                                          │
│  │ Agents            ┌──────────────────────────────────────────────────┐   │
│  │                   │ All agents (default)                [dropdown ▼] │   │
│  │                   └──────────────────────────────────────────────────┘   │
│  │                   Select specific agents to limit analysis.              │
│  │                                                                          │
│  │ Min Messages      ┌──────┐                                               │
│  │                   │  2   │  Skip conversations with fewer messages.      │
│  │                   └──────┘                                               │
│  │                                                                          │
│  │ Exclude Tags      ┌──────────────────────────────────────────────────┐   │
│  │                   │ [+ Add tag]                                      │   │
│  │                   └──────────────────────────────────────────────────┘   │
│  │                   Conversations with these tags will be skipped.         │
│  │                                                                          │
│  │ Sample Rate       ┌──────────────────────────┐                           │
│  │                   │  [================] 100% │  <- slider, 1%-100%       │
│  │                   └──────────────────────────┘                           │
│  │                   Process a percentage of conversations.                 │
│  │                   Reduce to control costs during high volume.            │
│  │                                                                          │
│  │ Processing Delay  ┌──────┐                                               │
│  │                   │  5   │ minutes after session ends                    │
│  │                   └──────┘                                               │
│                                                                             │
│  ═══════════════════════════════════════════════════════════════════════════ │
│                                                                             │
│  MODEL CONFIGURATION                                           [Collapsed] │
│  ─────────────────────────────────────────────────────────────────────────── │
│  ▼ Click to expand                                                          │
│                                                                             │
│  │ Provider          ┌──────────────────────────────────────────────────┐   │
│  │                   │ Platform default                    [dropdown ▼] │   │
│  │                   └──────────────────────────────────────────────────┘   │
│  │                   Uses your default provider. Override to use a          │
│  │                   specific provider for this pipeline.                   │
│  │                                                                          │
│  │ Model             ┌──────────────────────────────────────────────────┐   │
│  │                   │ Platform default (fast tier)        [dropdown ▼] │   │
│  │                   └──────────────────────────────────────────────────┘   │
│  │                   A fast-tier model is recommended for sentiment.        │
│  │                   Higher-tier models improve accuracy marginally.        │
│  │                                                                          │
│  │ Temperature       ┌──────────────────────────┐                           │
│  │                   │  [|================] 0.0  │  <- slider, 0.0-1.0      │
│  │                   └──────────────────────────┘                           │
│  │                   Lower = more deterministic. 0.0 recommended.           │
│  │                                                                          │
│  │ ── Cost Controls ──                                                      │
│  │                                                                          │
│  │ Daily Cost Limit  ┌──────────┐                                           │
│  │                   │ No limit │  USD/day. Pipeline pauses if exceeded.    │
│  │                   └──────────┘                                           │
│  │                                                                          │
│  │ Per-Conversation  ┌──────────┐                                           │
│  │ Cost Limit        │  $0.05   │  Skip conversations exceeding this.      │
│  │                   └──────────┘                                           │
│                                                                             │
│  ═══════════════════════════════════════════════════════════════════════════ │
│                                                                             │
│  PIPELINE STATUS                                                            │
│  ─────────────────────────────────────────────────────────────────────────── │
│  Config Version: 3                                                          │
│  Last Processed: 2 minutes ago                                              │
│  Backfill Status: Completed (30 days, 12,847 conversations)                 │
│  Estimated Daily Cost: ~$1.28 (based on last 7 days)                        │
│                                                                             │
│  ┌──────────────────────┐  ┌──────────────────────────────────────────────┐ │
│  │  [Re-analyze History] │  │  [View Change Log]                          │ │
│  └──────────────────────┘  └──────────────────────────────────────────────┘ │
│                                                                             │
│  ═══════════════════════════════════════════════════════════════════════════ │
│                                                                             │
│                              ┌──────────┐  ┌──────────────────────────────┐ │
│                              │  Cancel   │  │  Save Configuration         │ │
│                              └──────────┘  └──────────────────────────────┘ │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │  (!) Saving will increment config version to 4.                        ││
│  │  Changes to: scale, analyzeRoles require re-processing.                ││
│  │  [Re-analyze historical data?]  [Yes, re-analyze]  [No, future only]  ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
```

### UI Component Mapping

| Section                                        | Component                   | Library                                            |
| ---------------------------------------------- | --------------------------- | -------------------------------------------------- |
| Enable toggle                                  | `Switch`                    | Radix Toggle                                       |
| Granularity, Scale                             | `RadioGroup`                | Radix RadioGroup                                   |
| Roles to Analyze                               | `Checkbox` group            | Radix Checkbox                                     |
| Trajectory, Pivot, Frustration toggles         | `Switch`                    | Radix Toggle                                       |
| Pivot Threshold, Sample Rate                   | `Slider`                    | Radix Slider                                       |
| Frustration Keywords, Exclude Tags             | Tag input (chip list)       | Custom `ChipInput`                                 |
| Channels, Agents                               | Multi-select dropdown       | Custom `MultiSelect` (populated from project data) |
| Min Messages, Processing Delay, Cost fields    | `Input` (number)            | Standard number input                              |
| Provider, Model                                | `Select` dropdown           | Radix Select (populated from tenant model catalog) |
| Temperature                                    | `Slider`                    | Radix Slider                                       |
| Processing Scope, Model Configuration sections | `Collapsible` / `Accordion` | Radix Collapsible                                  |
| Save confirmation with re-process prompt       | `Dialog`                    | Radix AlertDialog                                  |
| Help text                                      | Inline `(i)` icons          | `Tooltip` with `TooltipProvider`                   |

### Save Flow

```
1. Customer edits config in Studio UI
2. Customer clicks "Save Configuration"
3. Frontend computes diff: which fields changed?
4. Frontend classifies changes: any re-processing parameters changed?
5. If re-processing parameters changed:
   a. Show confirmation dialog: "These changes affect how sentiment is scored.
      Re-analyze 30 days of historical data? Estimated cost: ~$3.40"
   b. Customer chooses "Yes, re-analyze" or "No, future only"
6. PUT /api/projects/:projectId/pipeline-config/sentiment_analysis
   Body: { config: {...}, reprocess: true/false }
7. Backend:
   a. Validates config with Zod schema
   b. Computes diff against current config
   c. Increments version
   d. Pushes to configHistory (capped at 20)
   e. Saves to MongoDB
   f. If reprocess=true: triggers backfill workflow via Restate
8. Frontend shows toast: "Configuration saved (v4). Backfill started."
```

---

## MongoDB Document Example

### Tenant-Level Config (defaults for all projects)

```json
{
  "_id": "ObjectId('665a1b2c3d4e5f6a7b8c9d0e')",
  "tenantId": "tenant_acme_corp",
  "projectId": null,
  "pipelineType": "sentiment_analysis",
  "version": 2,
  "enabled": true,
  "config": {
    "scale": "continuous",
    "granularity": "both",
    "detectTrajectory": true,
    "pivotDetection": true,
    "pivotThreshold": 0.3,
    "detectFrustration": true,
    "frustrationKeywords": ["cancel", "refund", "unsubscribe", "broken"],
    "analyzeRoles": ["user"],
    "sampleRate": 1.0,
    "minMessageCount": 2,
    "temperature": 0.0,
    "maxCostPerConversation": 0.05
  },
  "lastBackfillAt": "2026-03-02T14:30:00.000Z",
  "backfillStatus": "completed",
  "lastProcessedAt": "2026-03-03T09:15:22.000Z",
  "createdBy": "user_admin_001",
  "updatedBy": "user_admin_001",
  "createdAt": "2026-03-01T10:00:00.000Z",
  "updatedAt": "2026-03-02T08:45:00.000Z",
  "configHistory": [
    {
      "version": 1,
      "changedBy": "user_admin_001",
      "changedAt": "2026-03-01T10:00:00.000Z",
      "diff": {},
      "reprocessingRequired": false
    },
    {
      "version": 2,
      "changedBy": "user_admin_001",
      "changedAt": "2026-03-02T08:45:00.000Z",
      "diff": {
        "frustrationKeywords": {
          "old": ["cancel", "refund"],
          "new": ["cancel", "refund", "unsubscribe", "broken"]
        }
      },
      "reprocessingRequired": true
    }
  ]
}
```

### Project-Level Override

```json
{
  "_id": "ObjectId('665a1b2c3d4e5f6a7b8c9d1f')",
  "tenantId": "tenant_acme_corp",
  "projectId": "proj_support_team",
  "pipelineType": "sentiment_analysis",
  "version": 1,
  "enabled": true,
  "config": {
    "agents": ["BillingAgent", "TechSupportAgent"],
    "channels": ["web_chat", "voice"],
    "analyzeRoles": ["user", "assistant"],
    "frustrationKeywords": ["outage", "down", "not working"],
    "maxCostPerDay": 25.0
  },
  "lastBackfillAt": "2026-03-02T15:00:00.000Z",
  "backfillStatus": "completed",
  "lastProcessedAt": "2026-03-03T09:15:22.000Z",
  "createdBy": "user_pm_002",
  "updatedBy": "user_pm_002",
  "createdAt": "2026-03-02T12:00:00.000Z",
  "updatedAt": "2026-03-02T12:00:00.000Z",
  "configHistory": []
}
```

### Resolved Config for `proj_support_team`

After merging project > tenant > platform defaults:

```json
{
  "channels": ["web_chat", "voice"],
  "agents": ["BillingAgent", "TechSupportAgent"],
  "minMessageCount": 2,
  "excludeTags": [],
  "sampleRate": 1.0,
  "lookbackDays": 30,
  "processingDelay": 5,
  "provider": "",
  "model": "",
  "temperature": 0.0,
  "maxTokens": 256,
  "maxCostPerDay": 25.0,
  "maxCostPerConversation": 0.05,
  "granularity": "both",
  "scale": "continuous",
  "detectTrajectory": true,
  "pivotDetection": true,
  "pivotThreshold": 0.3,
  "detectFrustration": true,
  "frustrationKeywords": ["outage", "down", "not working"],
  "analyzeRoles": ["user", "assistant"]
}
```

Note: `frustrationKeywords` comes from the **project** config, fully replacing the tenant-level value. Arrays are not merged -- the most specific scope wins entirely. This is intentional: the support team has different frustration signals than the general tenant default.

---

## API Endpoints

### GET `/api/projects/:projectId/pipeline-config/sentiment_analysis`

Returns the resolved config (merged project > tenant > defaults) plus metadata.

**Response:**

```json
{
  "success": true,
  "data": {
    "enabled": true,
    "version": 2,
    "resolvedConfig": {
      /* fully resolved config */
    },
    "projectOverrides": {
      /* only fields set at project level */
    },
    "tenantDefaults": {
      /* only fields set at tenant level */
    },
    "backfillStatus": "completed",
    "lastProcessedAt": "2026-03-03T09:15:22.000Z",
    "estimatedDailyCost": 1.28
  }
}
```

### PUT `/api/projects/:projectId/pipeline-config/sentiment_analysis`

Saves project-level config overrides.

**Request:**

```json
{
  "config": {
    "analyzeRoles": ["user", "assistant"],
    "frustrationKeywords": ["outage", "down"]
  },
  "reprocess": false
}
```

**Response:**

```json
{
  "success": true,
  "data": {
    "version": 3,
    "reprocessingTriggered": false,
    "changedFields": ["analyzeRoles", "frustrationKeywords"],
    "warnings": ["Enabling assistant analysis approximately doubles LLM cost per conversation."]
  }
}
```

### PUT `/api/tenants/:tenantId/pipeline-config/sentiment_analysis`

Saves tenant-level default config (admin-only).

### POST `/api/projects/:projectId/pipeline-config/sentiment_analysis/backfill`

Manually triggers a backfill.

**Request:**

```json
{
  "lookbackDays": 30
}
```

---

## Implementation Notes

### Config Change Detection for Re-Processing

```typescript
// Parameters that require re-processing when changed
const REPROCESS_PARAMS: Set<keyof SentimentAnalysisConfig> = new Set([
  'granularity',
  'scale',
  'analyzeRoles',
  'detectTrajectory',
  'pivotDetection',
  'pivotThreshold',
  'detectFrustration',
  'frustrationKeywords',
]);

// Parameters where re-processing is recommended but not required
const REPROCESS_RECOMMENDED_PARAMS: Set<keyof SentimentAnalysisConfig> = new Set([
  'provider',
  'model',
  'temperature',
]);

function classifyConfigChange(diff: Record<string, { old: unknown; new: unknown }>): {
  required: boolean;
  recommended: boolean;
  fields: string[];
} {
  const changedKeys = Object.keys(diff) as Array<keyof SentimentAnalysisConfig>;

  const requiredFields = changedKeys.filter((k) => REPROCESS_PARAMS.has(k));
  const recommendedFields = changedKeys.filter((k) => REPROCESS_RECOMMENDED_PARAMS.has(k));

  return {
    required: requiredFields.length > 0,
    recommended: recommendedFields.length > 0,
    fields: [...requiredFields, ...recommendedFields],
  };
}
```

### Integration with Pipeline Engine

The config version is passed to the Restate activity service as part of `PipelineStepContext`:

```typescript
// In the pipeline definition step config
{
  id: 'score-sentiment',
  name: 'Score Sentiment',
  type: 'call-llm',
  config: {
    activityService: 'ComputeSentiment',
    // Config is resolved at pipeline start time and passed through
    params: resolvedSentimentConfig,
    configVersion: pipelineConfigDoc.version,
  },
}
```

The `config_version` is written to every output row in `message_sentiment` and `conversation_sentiment`, enabling:

- Filtering results by config version (e.g., "show only results from the current config")
- Identifying stale results that need re-processing
- Audit trail of which config produced which results

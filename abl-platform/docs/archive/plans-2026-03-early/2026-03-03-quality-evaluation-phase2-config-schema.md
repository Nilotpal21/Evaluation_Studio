# Phase 2: Customer Configuration Schema -- LLM-as-Judge Quality Evaluation Pipeline

> **Pipeline**: `quality_evaluation`
> **Scope**: Per-tenant defaults, per-project overrides, agent-level filtering
> **Storage**: MongoDB `pipeline_configs` collection, keyed by `(tenantId, pipelineType, projectId)`
> **Date**: 2026-03-03

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

Parameters are grouped into four categories matching the existing platform patterns: **Scope & Filters** (`PipelineScopeConfig`), **Model & Provider** (`PipelineModelConfig`), **Evaluation Rubric** (pipeline-specific), and **Flagging & Alerts** (pipeline-specific).

### A. Processing Scope & Filters (inherited from PipelineScopeConfig)

| #   | Parameter         | Description                                                                               |
| --- | ----------------- | ----------------------------------------------------------------------------------------- |
| A1  | `channels`        | Which conversation channels to evaluate (e.g., `['web_chat', 'voice']`). Empty = all.     |
| A2  | `agents`          | Which agent names to evaluate (e.g., `['BillingAgent']`). Empty = all.                    |
| A3  | `minMessageCount` | Skip conversations with fewer than N messages (filters noise from accidental opens).      |
| A4  | `excludeTags`     | Skip conversations tagged with these labels (e.g., `['test', 'internal']`).               |
| A5  | `sampleRate`      | Fraction of eligible conversations to evaluate. 1.0 = all, 0.1 = 10% sample.              |
| A6  | `lookbackDays`    | How far back to go during initial backfill.                                               |
| A7  | `processingDelay` | Minutes to wait after `session_end` before processing (ensures all messages are written). |

### B. Model & Provider Selection (inherited from PipelineModelConfig)

| #   | Parameter                | Description                                                                          |
| --- | ------------------------ | ------------------------------------------------------------------------------------ |
| B1  | `provider`               | LLM provider for the judge. Platform resolves via SessionLLMClient credential chain. |
| B2  | `model`                  | Specific model ID. Platform provides a cost-effective default.                       |
| B3  | `temperature`            | LLM temperature for evaluation calls. Lower = more deterministic scoring.            |
| B4  | `maxTokens`              | Max output tokens for the judge LLM response.                                        |
| B5  | `maxCostPerDay`          | USD daily budget cap. Pipeline pauses when exceeded; resumes next day.               |
| B6  | `maxCostPerConversation` | USD per-conversation cap. Skips conversations whose transcript would exceed this.    |

### C. Evaluation Rubric (pipeline-specific)

| #   | Parameter                  | Description                                                                                                                                         |
| --- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `dimensions`               | Array of evaluation dimensions (the rubric). At least one required. This is the core product.                                                       |
| C1a | `dimensions[].name`        | Machine-readable identifier (e.g., `'helpfulness'`). Unique within the rubric.                                                                      |
| C1b | `dimensions[].displayName` | Human-readable label shown in UI and reports (e.g., `'Helpfulness'`).                                                                               |
| C1c | `dimensions[].description` | What this dimension measures. Sent to the judge LLM as evaluation instructions.                                                                     |
| C1d | `dimensions[].scale`       | Scoring scale `{ min, max }`. Typically `{ min: 1, max: 5 }`.                                                                                       |
| C1e | `dimensions[].weight`      | Relative weight for the weighted overall score calculation.                                                                                         |
| C1f | `dimensions[].criteria`    | Specific rubric points the judge should check (array of strings).                                                                                   |
| C2  | `overallScoreMethod`       | How to compute the overall score from per-dimension scores.                                                                                         |
| C3  | `evaluatorSystemPrompt`    | Additional system-level instructions prepended to the judge prompt. Advanced override.                                                              |
| C4  | `domainContext`            | Business context string sent to the judge (e.g., `'We are a telecom company specializing in enterprise fiber optic services.'`). Improves accuracy. |
| C5  | `includeToolCalls`         | Whether to include tool call details (name, args, result) in the context sent to the judge.                                                         |
| C6  | `includeFlowSteps`         | Whether to include flow step trace data (step entries, exits, transitions) in judge context.                                                        |
| C7  | `includeAgentDefinition`   | Whether to include the agent's persona, goal, and constraints in judge context.                                                                     |

### D. Flagging & Alert Thresholds (pipeline-specific)

| #   | Parameter                 | Description                                                                   |
| --- | ------------------------- | ----------------------------------------------------------------------------- |
| D1  | `flagThreshold`           | Overall score below this value triggers a Watchtower flag (warning severity). |
| D2  | `criticalThreshold`       | Overall score below this value triggers a Watchtower critical alert.          |
| D3  | `dimensionFlagThresholds` | Per-dimension override thresholds. Map of `dimensionName -> threshold`.       |
| D4  | `autoEscalateOnCritical`  | Whether a critical score triggers an automatic escalation notification.       |

---

## 2.2 Classification: REQUIRED vs OPTIONAL

| Parameter                          | Classification | Rationale                                                          |
| ---------------------------------- | -------------- | ------------------------------------------------------------------ |
| **A1** `channels`                  | OPTIONAL       | Default: all channels                                              |
| **A2** `agents`                    | OPTIONAL       | Default: all agents                                                |
| **A3** `minMessageCount`           | OPTIONAL       | Platform default: 2                                                |
| **A4** `excludeTags`               | OPTIONAL       | Default: none                                                      |
| **A5** `sampleRate`                | OPTIONAL       | Default: 1.0 (evaluate everything)                                 |
| **A6** `lookbackDays`              | OPTIONAL       | Default: 30                                                        |
| **A7** `processingDelay`           | OPTIONAL       | Default: 5 minutes                                                 |
| **B1** `provider`                  | OPTIONAL       | Platform resolves from tenant LLM config                           |
| **B2** `model`                     | OPTIONAL       | Platform default: cost-effective model (claude-haiku-4-5)          |
| **B3** `temperature`               | OPTIONAL       | Default: 0.1 (near-deterministic for consistency)                  |
| **B4** `maxTokens`                 | OPTIONAL       | Default: 2048                                                      |
| **B5** `maxCostPerDay`             | OPTIONAL       | Default: no limit                                                  |
| **B6** `maxCostPerConversation`    | OPTIONAL       | Default: no limit                                                  |
| **C1** `dimensions`                | **REQUIRED**   | The rubric is the product. At least one dimension must be defined. |
| **C1a** `dimensions[].name`        | **REQUIRED**   | Machine identifier for storage and queries.                        |
| **C1b** `dimensions[].displayName` | **REQUIRED**   | Human label for UI.                                                |
| **C1c** `dimensions[].description` | **REQUIRED**   | Judge LLM needs to know what to evaluate.                          |
| **C1d** `dimensions[].scale`       | OPTIONAL       | Default: `{ min: 1, max: 5 }`                                      |
| **C1e** `dimensions[].weight`      | OPTIONAL       | Default: 1.0 (equal weight)                                        |
| **C1f** `dimensions[].criteria`    | OPTIONAL       | Default: none (judge uses description only)                        |
| **C2** `overallScoreMethod`        | OPTIONAL       | Default: `'weighted'`                                              |
| **C3** `evaluatorSystemPrompt`     | OPTIONAL       | Default: none (platform-provided prompt)                           |
| **C4** `domainContext`             | OPTIONAL       | Default: none                                                      |
| **C5** `includeToolCalls`          | OPTIONAL       | Default: `true`                                                    |
| **C6** `includeFlowSteps`          | OPTIONAL       | Default: `false`                                                   |
| **C7** `includeAgentDefinition`    | OPTIONAL       | Default: `true`                                                    |
| **D1** `flagThreshold`             | OPTIONAL       | Default: 3.0 (on 1-5 scale)                                        |
| **D2** `criticalThreshold`         | OPTIONAL       | Default: 2.0 (on 1-5 scale)                                        |
| **D3** `dimensionFlagThresholds`   | OPTIONAL       | Default: none (uses global thresholds)                             |
| **D4** `autoEscalateOnCritical`    | OPTIONAL       | Default: `false`                                                   |

**Summary**: Only `dimensions` (with `name`, `displayName`, `description` per dimension) is REQUIRED. Everything else has a sensible platform default. This means a customer can enable quality evaluation with minimal configuration -- just define what to measure.

---

## 2.3 Platform Defaults

```typescript
const QUALITY_EVALUATION_DEFAULTS = {
  // Scope & Filters
  channels: [], // All channels
  agents: [], // All agents
  minMessageCount: 2, // Skip single-message sessions
  excludeTags: [], // No exclusions
  sampleRate: 1.0, // Evaluate all conversations
  lookbackDays: 30, // 30-day initial backfill
  processingDelay: 5, // 5 minutes after session_end

  // Model & Provider
  provider: undefined, // Resolved from tenant LLM config chain
  model: undefined, // Resolved from tenant LLM config chain; fallback: 'claude-haiku-4-5'
  temperature: 0.1, // Near-deterministic for scoring consistency
  maxTokens: 2048, // Sufficient for structured JSON output
  maxCostPerDay: undefined, // No daily cap
  maxCostPerConversation: undefined, // No per-conversation cap

  // Rubric
  // dimensions: REQUIRED -- no default
  overallScoreMethod: 'weighted' as const,
  evaluatorSystemPrompt: undefined,
  domainContext: undefined,
  includeToolCalls: true, // Tool calls are often critical for judging accuracy
  includeFlowSteps: false, // Flow steps add noise unless debugging agent logic
  includeAgentDefinition: true, // Persona/constraints help the judge understand expected behavior

  // Flagging
  flagThreshold: 3.0, // Score below 3.0/5.0 = flagged
  criticalThreshold: 2.0, // Score below 2.0/5.0 = critical
  dimensionFlagThresholds: {}, // No per-dimension overrides
  autoEscalateOnCritical: false, // Don't auto-escalate by default

  // Default dimension scale (used when dimension.scale is omitted)
  _defaultScale: { min: 1, max: 5 },
  _defaultWeight: 1.0,
} as const;
```

### Starter Rubric Templates

The platform provides pre-built rubric templates that customers can clone and customize. These are NOT defaults -- they are templates offered during setup:

**General Customer Service Template** (3 dimensions):

```typescript
const GENERAL_CS_TEMPLATE: EvaluationDimension[] = [
  {
    name: 'helpfulness',
    displayName: 'Helpfulness',
    description: "Did the agent understand and address the customer's actual need?",
    scale: { min: 1, max: 5 },
    weight: 1.5,
    criteria: [
      'Agent correctly identified the core issue or request',
      'Agent provided a concrete resolution or next step',
      "Agent confirmed the customer's need was met before closing",
    ],
  },
  {
    name: 'accuracy',
    displayName: 'Accuracy',
    description:
      "Were the agent's responses factually correct and consistent with available information?",
    scale: { min: 1, max: 5 },
    weight: 2.0,
    criteria: [
      'Information provided was factually correct',
      'Tool results were interpreted and relayed accurately',
      'No contradictions between agent statements',
      'No hallucinated information (making up data not in tool results)',
    ],
  },
  {
    name: 'professionalism',
    displayName: 'Professionalism',
    description: "Was the agent's tone appropriate, empathetic, and professional?",
    scale: { min: 1, max: 5 },
    weight: 1.0,
    criteria: [
      'Tone was polite and respectful throughout',
      'Agent showed empathy when the customer expressed frustration',
      'Language was clear and free of jargon',
    ],
  },
];
```

**Telco-Specific Template** (5 dimensions, adds technical accuracy and compliance):

```typescript
const TELCO_TEMPLATE: EvaluationDimension[] = [
  // ... helpfulness, accuracy, professionalism (same as above) ...
  {
    name: 'technical_accuracy',
    displayName: 'Technical Accuracy',
    description: 'Were technical details about network, services, and configurations correct?',
    scale: { min: 1, max: 5 },
    weight: 2.0,
    criteria: [
      'Network terminology used correctly (OSPF, BGP, DWDM, etc.)',
      'Service plan details matched what tools returned',
      'Troubleshooting steps were technically sound',
    ],
  },
  {
    name: 'compliance',
    displayName: 'Regulatory Compliance',
    description: 'Did the agent follow required regulatory and company policies?',
    scale: { min: 1, max: 5 },
    weight: 2.5,
    criteria: [
      'Customer identity verified before accessing account data',
      'Required disclosures were provided when applicable',
      'No unauthorized changes made to customer account',
    ],
  },
];
```

---

## 2.4 MongoDB Schema

### Document Interface

```typescript
// MongoDB collection: pipeline_configs
// Compound unique index: { tenantId: 1, pipelineType: 1, projectId: 1 }

interface QualityEvaluationPipelineConfig {
  _id: ObjectId;

  // ─── Identity & Scope ──────────────────────────────────────────
  tenantId: string; // REQUIRED -- tenant isolation
  projectId?: string; // Optional -- project-level override
  pipelineType: 'quality_evaluation'; // Discriminator -- always this value

  // ─── Lifecycle ─────────────────────────────────────────────────
  enabled: boolean; // Master on/off switch
  version: number; // Auto-incremented on every save

  // ─── Processing Scope (PipelineScopeConfig) ────────────────────
  config: {
    scope: {
      channels: string[]; // Default: [] (all)
      agents: string[]; // Default: [] (all)
      minMessageCount: number; // Default: 2
      excludeTags: string[]; // Default: []
      sampleRate: number; // Default: 1.0
      lookbackDays: number; // Default: 30
      processingDelay: number; // Default: 5 (minutes)
    };

    // ─── Model Selection (PipelineModelConfig) ───────────────────
    model: {
      provider?: string; // Resolved from tenant LLM config if absent
      model?: string; // Resolved from tenant LLM config if absent
      temperature: number; // Default: 0.1
      maxTokens: number; // Default: 2048
      maxCostPerDay?: number; // USD -- undefined = no limit
      maxCostPerConversation?: number; // USD -- undefined = no limit
    };

    // ─── Evaluation Rubric ───────────────────────────────────────
    rubric: {
      dimensions: EvaluationDimension[]; // REQUIRED -- at least 1, max 10
      overallScoreMethod: 'average' | 'weighted' | 'minimum'; // Default: 'weighted'
    };

    // ─── Judge Context ───────────────────────────────────────────
    context: {
      evaluatorSystemPrompt?: string; // Additional judge instructions (max 4000 chars)
      domainContext?: string; // Business context (max 2000 chars)
      includeToolCalls: boolean; // Default: true
      includeFlowSteps: boolean; // Default: false
      includeAgentDefinition: boolean; // Default: true
    };

    // ─── Flagging Thresholds ─────────────────────────────────────
    flagging: {
      flagThreshold: number; // Default: 3.0
      criticalThreshold: number; // Default: 2.0
      dimensionFlagThresholds: Record<string, number>; // Default: {}
      autoEscalateOnCritical: boolean; // Default: false
    };
  };

  // ─── Processing State ──────────────────────────────────────────
  lastBackfillAt?: Date;
  backfillStatus: 'idle' | 'running' | 'completed' | 'failed';
  lastProcessedAt?: Date;
  lastProcessedSessionId?: string; // Cursor for incremental processing

  // ─── Metadata ──────────────────────────────────────────────────
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;

  // ─── Change History ────────────────────────────────────────────
  configHistory: ConfigChange[]; // Last 20 changes (ring buffer)
}

interface EvaluationDimension {
  name: string; // Machine-readable, unique, lowercase_snake
  displayName: string; // Human-readable
  description: string; // Instructions for the judge
  scale: {
    min: number; // Default: 1
    max: number; // Default: 5
  };
  weight: number; // Default: 1.0
  criteria: string[]; // Specific rubric points (optional, default: [])
}

interface ConfigChange {
  version: number;
  changedBy: string; // userId
  changedAt: Date;
  diff: Record<string, { old: unknown; new: unknown }>;
  reprocessingRequired: boolean;
}
```

### Mongoose Schema

```typescript
const EvaluationDimensionSchema = new Schema(
  {
    name: { type: String, required: true },
    displayName: { type: String, required: true },
    description: { type: String, required: true },
    scale: {
      min: { type: Number, required: true, default: 1 },
      max: { type: Number, required: true, default: 5 },
    },
    weight: { type: Number, required: true, default: 1.0 },
    criteria: { type: [String], default: [] },
  },
  { _id: false },
);

const ConfigChangeSchema = new Schema(
  {
    version: { type: Number, required: true },
    changedBy: { type: String, required: true },
    changedAt: { type: Date, required: true },
    diff: { type: Schema.Types.Mixed, required: true },
    reprocessingRequired: { type: Boolean, required: true },
  },
  { _id: false },
);

const QualityEvaluationConfigSchema = new Schema(
  {
    tenantId: { type: String, required: true, index: true },
    projectId: { type: String, default: null },
    pipelineType: { type: String, required: true, enum: ['quality_evaluation'] },
    enabled: { type: Boolean, required: true, default: false },
    version: { type: Number, required: true, default: 1 },
    config: {
      scope: {
        channels: { type: [String], default: [] },
        agents: { type: [String], default: [] },
        minMessageCount: { type: Number, default: 2 },
        excludeTags: { type: [String], default: [] },
        sampleRate: { type: Number, default: 1.0 },
        lookbackDays: { type: Number, default: 30 },
        processingDelay: { type: Number, default: 5 },
      },
      model: {
        provider: { type: String },
        model: { type: String },
        temperature: { type: Number, default: 0.1 },
        maxTokens: { type: Number, default: 2048 },
        maxCostPerDay: { type: Number },
        maxCostPerConversation: { type: Number },
      },
      rubric: {
        dimensions: { type: [EvaluationDimensionSchema], required: true },
        overallScoreMethod: {
          type: String,
          enum: ['average', 'weighted', 'minimum'],
          default: 'weighted',
        },
      },
      context: {
        evaluatorSystemPrompt: { type: String },
        domainContext: { type: String },
        includeToolCalls: { type: Boolean, default: true },
        includeFlowSteps: { type: Boolean, default: false },
        includeAgentDefinition: { type: Boolean, default: true },
      },
      flagging: {
        flagThreshold: { type: Number, default: 3.0 },
        criticalThreshold: { type: Number, default: 2.0 },
        dimensionFlagThresholds: { type: Schema.Types.Mixed, default: {} },
        autoEscalateOnCritical: { type: Boolean, default: false },
      },
    },
    backfillStatus: {
      type: String,
      enum: ['idle', 'running', 'completed', 'failed'],
      default: 'idle',
    },
    lastBackfillAt: { type: Date },
    lastProcessedAt: { type: Date },
    lastProcessedSessionId: { type: String },
    createdBy: { type: String, required: true },
    updatedBy: { type: String, required: true },
    configHistory: { type: [ConfigChangeSchema], default: [] },
  },
  {
    timestamps: true,
    collection: 'pipeline_configs',
  },
);

// ─── Indexes ─────────────────────────────────────────────────────

// Primary lookup: find config for a specific pipeline in a project
QualityEvaluationConfigSchema.index(
  { tenantId: 1, pipelineType: 1, projectId: 1 },
  { unique: true },
);

// Find all enabled pipelines for a tenant (for scheduler/backfill)
QualityEvaluationConfigSchema.index({ tenantId: 1, enabled: 1, pipelineType: 1 });
```

---

## 2.5 Validation Rules

### Full Parameter Validation Table

| Parameter                                 | Type                     | Required | Default      | Validation                                                                                                                     | Error Message                                                                                                     |
| ----------------------------------------- | ------------------------ | -------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `config.scope.channels`                   | `string[]`               | No       | `[]`         | Each element: non-empty string, max 50 chars. Max 20 entries.                                                                  | `Each channel must be a non-empty string (max 50 chars). Maximum 20 channels.`                                    |
| `config.scope.agents`                     | `string[]`               | No       | `[]`         | Each element: non-empty string, max 100 chars. Max 50 entries.                                                                 | `Each agent name must be a non-empty string (max 100 chars). Maximum 50 agents.`                                  |
| `config.scope.minMessageCount`            | `number`                 | No       | `2`          | Integer, min: 1, max: 100                                                                                                      | `Minimum message count must be between 1 and 100.`                                                                |
| `config.scope.excludeTags`                | `string[]`               | No       | `[]`         | Each element: non-empty string, max 50 chars. Max 20 entries.                                                                  | `Each tag must be a non-empty string (max 50 chars). Maximum 20 tags.`                                            |
| `config.scope.sampleRate`                 | `number`                 | No       | `1.0`        | Float, min: 0.01, max: 1.0                                                                                                     | `Sample rate must be between 0.01 and 1.0.`                                                                       |
| `config.scope.lookbackDays`               | `number`                 | No       | `30`         | Integer, min: 1, max: 90 (bound by data TTL)                                                                                   | `Lookback must be between 1 and 90 days (data retention limit).`                                                  |
| `config.scope.processingDelay`            | `number`                 | No       | `5`          | Integer, min: 1, max: 60 (minutes)                                                                                             | `Processing delay must be between 1 and 60 minutes.`                                                              |
| `config.model.provider`                   | `string`                 | No       | (resolved)   | One of: `'anthropic'`, `'openai'`, `'google'`, `'azure'`, `'cohere'`, `'groq'`, `'bedrock'`                                    | `Provider must be one of: anthropic, openai, google, azure, cohere, groq, bedrock.`                               |
| `config.model.model`                      | `string`                 | No       | (resolved)   | Non-empty string, max 100 chars. Must be valid for the selected provider.                                                      | `Model ID must be a valid model string (max 100 chars).`                                                          |
| `config.model.temperature`                | `number`                 | No       | `0.1`        | Float, min: 0.0, max: 1.0                                                                                                      | `Temperature must be between 0.0 and 1.0.`                                                                        |
| `config.model.maxTokens`                  | `number`                 | No       | `2048`       | Integer, min: 256, max: 8192                                                                                                   | `Max tokens must be between 256 and 8192.`                                                                        |
| `config.model.maxCostPerDay`              | `number`                 | No       | (none)       | Float, min: 0.01                                                                                                               | `Daily cost cap must be at least $0.01 if set.`                                                                   |
| `config.model.maxCostPerConversation`     | `number`                 | No       | (none)       | Float, min: 0.001                                                                                                              | `Per-conversation cost cap must be at least $0.001 if set.`                                                       |
| `config.rubric.dimensions`                | `EvaluationDimension[]`  | **Yes**  | --           | Array, min length: 1, max length: 10. Each element validated below.                                                            | `At least 1 and at most 10 evaluation dimensions are required.`                                                   |
| `dimensions[].name`                       | `string`                 | **Yes**  | --           | Lowercase alphanumeric + underscore, 1-50 chars. Must be unique within the dimensions array. Regex: `/^[a-z][a-z0-9_]{0,49}$/` | `Dimension name must be lowercase alphanumeric/underscore (1-50 chars), unique within the rubric.`                |
| `dimensions[].displayName`                | `string`                 | **Yes**  | --           | Non-empty string, 1-100 chars                                                                                                  | `Display name is required (1-100 chars).`                                                                         |
| `dimensions[].description`                | `string`                 | **Yes**  | --           | Non-empty string, 10-1000 chars                                                                                                | `Description is required (10-1000 chars). This is sent to the judge LLM.`                                         |
| `dimensions[].scale.min`                  | `number`                 | No       | `1`          | Integer, min: 0, max: 9. Must be less than `scale.max`.                                                                        | `Scale minimum must be 0-9 and less than maximum.`                                                                |
| `dimensions[].scale.max`                  | `number`                 | No       | `5`          | Integer, min: 1, max: 10. Must be greater than `scale.min`.                                                                    | `Scale maximum must be 1-10 and greater than minimum.`                                                            |
| `dimensions[].weight`                     | `number`                 | No       | `1.0`        | Float, min: 0.1, max: 10.0                                                                                                     | `Weight must be between 0.1 and 10.0.`                                                                            |
| `dimensions[].criteria`                   | `string[]`               | No       | `[]`         | Each element: 5-500 chars. Max 10 criteria per dimension.                                                                      | `Each criterion must be 5-500 chars. Maximum 10 criteria per dimension.`                                          |
| `config.rubric.overallScoreMethod`        | `string`                 | No       | `'weighted'` | One of: `'average'`, `'weighted'`, `'minimum'`                                                                                 | `Overall score method must be one of: average, weighted, minimum.`                                                |
| `config.context.evaluatorSystemPrompt`    | `string`                 | No       | (none)       | Max 4000 chars                                                                                                                 | `System prompt must not exceed 4000 characters.`                                                                  |
| `config.context.domainContext`            | `string`                 | No       | (none)       | Max 2000 chars                                                                                                                 | `Domain context must not exceed 2000 characters.`                                                                 |
| `config.context.includeToolCalls`         | `boolean`                | No       | `true`       | Boolean                                                                                                                        | --                                                                                                                |
| `config.context.includeFlowSteps`         | `boolean`                | No       | `false`      | Boolean                                                                                                                        | --                                                                                                                |
| `config.context.includeAgentDefinition`   | `boolean`                | No       | `true`       | Boolean                                                                                                                        | --                                                                                                                |
| `config.flagging.flagThreshold`           | `number`                 | No       | `3.0`        | Float, min: `scale.min`, max: `scale.max`. Must be greater than `criticalThreshold`.                                           | `Flag threshold must be within the scoring scale and above the critical threshold.`                               |
| `config.flagging.criticalThreshold`       | `number`                 | No       | `2.0`        | Float, min: `scale.min`, max: `scale.max`. Must be less than `flagThreshold`.                                                  | `Critical threshold must be within the scoring scale and below the flag threshold.`                               |
| `config.flagging.dimensionFlagThresholds` | `Record<string, number>` | No       | `{}`         | Keys must match a `dimensions[].name`. Values: float within the dimension's scale.                                             | `Dimension flag threshold keys must match defined dimension names. Values must be within that dimension's scale.` |
| `config.flagging.autoEscalateOnCritical`  | `boolean`                | No       | `false`      | Boolean                                                                                                                        | --                                                                                                                |

### Cross-Field Validation Rules

1. **Threshold ordering**: `criticalThreshold < flagThreshold` -- always.
2. **Threshold scale alignment**: Both `flagThreshold` and `criticalThreshold` must fall within the range of the dimensions' scales. If dimensions have different scales, thresholds apply to the _overall_ score, which is normalized to the first dimension's scale.
3. **Dimension name uniqueness**: No two dimensions may share the same `name`.
4. **Weight sum sanity**: When `overallScoreMethod` is `'weighted'`, at least one dimension must have `weight > 0`.
5. **Scale consistency**: All dimensions must use the same `scale.min` and `scale.max` for v1 (simplifies overall score computation). Different scales per dimension is a v2 feature.
6. **dimensionFlagThresholds keys**: Every key in `dimensionFlagThresholds` must correspond to a `dimensions[].name`. Orphaned keys are rejected.

---

## 2.6 Configuration Scope

### Resolution Hierarchy

```
Priority 1 (highest): Project-level config
  └─ pipeline_configs WHERE tenantId = ? AND pipelineType = 'quality_evaluation' AND projectId = ?

Priority 2: Tenant-level config (fallback)
  └─ pipeline_configs WHERE tenantId = ? AND pipelineType = 'quality_evaluation' AND projectId IS NULL

Priority 3 (lowest): Platform defaults (hardcoded)
  └─ QUALITY_EVALUATION_DEFAULTS constant in code
```

### Merge Strategy

Config resolution is **full document replacement**, not deep merge. A project-level config overrides the entire tenant-level config. This is deliberate:

- **Simple mental model**: Customers understand "Project A has its own quality rubric."
- **Avoids confusion**: No hidden partial overrides where one dimension comes from tenant and another from project.
- **Copy-on-customize**: When creating a project-level config, the UI pre-populates it with a copy of the tenant-level config.

### Agent-Level Scoping

Agent-level configuration is achieved via the `agents` filter, not via separate config documents:

```typescript
// Tenant-level: evaluate all agents
{ tenantId: 'acme', projectId: null, config: { scope: { agents: [] } } }

// Project-level: only evaluate BillingAgent and SupportAgent
{ tenantId: 'acme', projectId: 'proj-1', config: { scope: { agents: ['BillingAgent', 'SupportAgent'] } } }
```

If a customer needs _different rubrics per agent_, they create separate project-level configs where each project contains different agents. A future v2 could introduce `agentOverrides` within a single config document.

---

## 2.7 Configuration Versioning

### Version Lifecycle

1. **On every save**, the `version` field is atomically incremented via `$inc: { version: 1 }`.
2. **The diff is recorded** in `configHistory` (last 20 entries, ring buffer).
3. **The config version is stamped** on every output row: `config_version` column in the `quality_evaluations` ClickHouse table.
4. **Re-processing is not automatic**. The UI shows a banner when a change requires re-processing, and the customer must explicitly trigger a backfill.

### When Does a Change Require Re-processing?

The system computes `reprocessingRequired` by inspecting which fields changed:

```typescript
const REPROCESSING_FIELDS = new Set([
  'config.rubric.dimensions', // Rubric changed
  'config.rubric.overallScoreMethod', // Score computation changed
  'config.context.evaluatorSystemPrompt', // Judge instructions changed
  'config.context.domainContext', // Context changed
  'config.context.includeToolCalls', // Different data sent to judge
  'config.context.includeFlowSteps', // Different data sent to judge
  'config.context.includeAgentDefinition', // Different data sent to judge
  'config.model.provider', // Different model = different scores
  'config.model.model', // Different model = different scores
  'config.model.temperature', // Affects scoring behavior
]);

function requiresReprocessing(diff: Record<string, unknown>): boolean {
  return Object.keys(diff).some((key) => REPROCESSING_FIELDS.has(key));
}
```

### Backfill Behavior

When the customer triggers a re-processing backfill:

1. `backfillStatus` is set to `'running'`.
2. The pipeline re-evaluates all conversations within `lookbackDays`.
3. Output rows are written with the new `config_version`.
4. ClickHouse `ReplacingMergeTree(processed_at)` ensures the latest evaluation wins.
5. On completion, `backfillStatus` is set to `'completed'`, `lastBackfillAt` is updated.

### Cost Estimation for Backfill

Before triggering, the UI shows an estimated cost:

```
Re-processing will evaluate ~2,340 conversations.
Estimated cost: $23.40 - $117.00 (depending on transcript length)
Estimated time: ~45 minutes
```

Formula: `conversationCount * avgTokensPerTranscript * costPerToken * dimensionCount`

---

## 2.8 Parameters That Require Re-processing When Changed

These parameters affect the _evaluation itself_ -- changing them means past scores are stale:

| Parameter                        | Why Re-processing Is Required                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| `dimensions` (add/remove/modify) | Different dimensions = different scores. Adding a dimension means no historical data for it. |
| `overallScoreMethod`             | Overall score formula changes. Past overall scores are wrong.                                |
| `evaluatorSystemPrompt`          | Different instructions = different judge behavior = different scores.                        |
| `domainContext`                  | Different business context = different interpretation = different scores.                    |
| `includeToolCalls`               | Judge sees different evidence, may score differently.                                        |
| `includeFlowSteps`               | Judge sees different evidence, may score differently.                                        |
| `includeAgentDefinition`         | Judge sees different evidence, may score differently.                                        |
| `provider` / `model`             | Different LLM = different scoring behavior and calibration.                                  |
| `temperature`                    | Different randomness = potentially different scores (especially at higher values).           |

### Partial Re-processing

When only a _single dimension_ is added, the system can optimize:

- Existing dimension scores remain valid.
- Only the new dimension needs evaluation for historical conversations.
- The overall score is re-computed from existing + new dimension scores.
- This optimization is flagged as v2; v1 does full re-evaluation.

---

## 2.9 Parameters That Only Affect Future Processing

These parameters do NOT invalidate past evaluations:

| Parameter                 | Why No Backfill Needed                                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `channels`                | Only changes which conversations are _selected_. Past evaluations remain valid for the conversations they covered.                                                |
| `agents`                  | Same as channels -- scoping filter only.                                                                                                                          |
| `minMessageCount`         | Scoping filter.                                                                                                                                                   |
| `excludeTags`             | Scoping filter.                                                                                                                                                   |
| `sampleRate`              | Reducing from 1.0 to 0.5 just means fewer future evaluations. Past evaluations remain valid.                                                                      |
| `lookbackDays`            | Only affects initial backfill window, not ongoing processing.                                                                                                     |
| `processingDelay`         | Timing parameter, does not affect evaluation quality.                                                                                                             |
| `maxTokens`               | May truncate judge output, but does not change scoring (previous results already have scores).                                                                    |
| `maxCostPerDay`           | Budget cap -- pauses/resumes processing.                                                                                                                          |
| `maxCostPerConversation`  | Budget cap -- skips expensive conversations.                                                                                                                      |
| `flagThreshold`           | Threshold change only affects _which conversations get flagged_. Scores do not change. Watchtower re-applies thresholds to existing scores without re-processing. |
| `criticalThreshold`       | Same as flagThreshold.                                                                                                                                            |
| `dimensionFlagThresholds` | Same as flagThreshold.                                                                                                                                            |
| `autoEscalateOnCritical`  | Alert routing only.                                                                                                                                               |

### Threshold Hot-Apply

Flag and critical thresholds can be re-applied to existing evaluation data without re-running the LLM. This is a ClickHouse query:

```sql
-- Find conversations that now exceed the new flag threshold
SELECT session_id, overall_score
FROM quality_evaluations FINAL
WHERE tenant_id = {tenantId}
  AND project_id = {projectId}
  AND overall_score < {newFlagThreshold}
  AND overall_score >= {oldFlagThreshold}
  AND session_started_at >= now() - INTERVAL {lookbackDays} DAY
```

---

## 2.10 Studio UI Design

### Navigation Path

```
Studio > Project > Analytics > Quality Evaluation > Settings
```

### Page Layout (Text Wireframe)

```
┌──────────────────────────────────────────────────────────────────┐
│  PageHeader                                                      │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Quality Evaluation Settings                               │  │
│  │  Configure how conversations are evaluated for quality     │  │
│  │                                              [Save] [Reset]│  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ Master Toggle ────────────────────────────────────────────┐  │
│  │  [Toggle] Enable Quality Evaluation                        │  │
│  │  Evaluate conversations using an LLM judge against your    │  │
│  │  custom rubric.                                            │  │
│  │                                                            │  │
│  │  Status: ● Running  |  Last processed: 2 minutes ago      │  │
│  │  Conversations evaluated: 12,345  |  Config version: 7    │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ Section 1: Evaluation Rubric ─────────────────────────────┐  │
│  │                                                            │  │
│  │  ┌─ Info Banner ────────────────────────────────────────┐  │  │
│  │  │  The rubric defines what your LLM judge evaluates.   │  │  │
│  │  │  Start from a template or build from scratch.        │  │  │
│  │  │  [Use Template ▾]  [Add Dimension]                   │  │  │
│  │  └──────────────────────────────────────────────────────┘  │  │
│  │                                                            │  │
│  │  ┌─ Dimension Card: Helpfulness ──────────────[drag]──┐   │  │
│  │  │  Name: helpfulness        Display: Helpfulness     │   │  │
│  │  │                                                    │   │  │
│  │  │  Description:                                      │   │  │
│  │  │  ┌──────────────────────────────────────────────┐  │   │  │
│  │  │  │ Did the agent understand and address the     │  │   │  │
│  │  │  │ customer's actual need?                      │  │   │  │
│  │  │  └──────────────────────────────────────────────┘  │   │  │
│  │  │                                                    │   │  │
│  │  │  Scale: [1] to [5]    Weight: [===●===] 1.5       │   │  │
│  │  │                                                    │   │  │
│  │  │  Rubric Criteria:                                  │   │  │
│  │  │  ☑ Agent identified the core issue                │   │  │
│  │  │  ☑ Provided a concrete resolution                 │   │  │
│  │  │  ☑ Confirmed customer satisfaction                │   │  │
│  │  │  [+ Add criterion]                                │   │  │
│  │  │                                          [Remove]  │   │  │
│  │  └────────────────────────────────────────────────────┘   │  │
│  │                                                            │  │
│  │  ┌─ Dimension Card: Accuracy ─────────────────[drag]──┐   │  │
│  │  │  Name: accuracy           Display: Accuracy        │   │  │
│  │  │  ...                                               │   │  │
│  │  └────────────────────────────────────────────────────┘   │  │
│  │                                                            │  │
│  │  Overall Score Method: (●) Weighted  ( ) Average  ( ) Min │  │
│  │                                                            │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ Section 2: Judge Context ─────────────────────────────────┐  │
│  │                                                            │  │
│  │  Domain Context (optional):                                │  │
│  │  ┌──────────────────────────────────────────────────────┐  │  │
│  │  │ We are a telecom company specializing in enterprise  │  │  │
│  │  │ fiber optic services. Our agents handle billing,     │  │  │
│  │  │ network troubleshooting, and plan changes.           │  │  │
│  │  └──────────────────────────────────────────────────────┘  │  │
│  │  Helps the judge understand your industry and business.    │  │
│  │  2000 character limit.                                     │  │
│  │                                                            │  │
│  │  Custom Judge Instructions (advanced, optional):           │  │
│  │  ┌──────────────────────────────────────────────────────┐  │  │
│  │  │                                                      │  │  │
│  │  └──────────────────────────────────────────────────────┘  │  │
│  │  Prepended to the judge system prompt. Use for special     │  │
│  │  scoring rules.  4000 character limit.                     │  │
│  │                                                            │  │
│  │  Context included in evaluation:                           │  │
│  │  [✓] Tool call details                                     │  │
│  │  [ ] Flow step trace                                       │  │
│  │  [✓] Agent definition (persona, constraints)               │  │
│  │                                                            │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ Section 3: Flagging & Alerts ─────────────────────────────┐  │
│  │                                                            │  │
│  │  ┌─ Threshold Visualization ────────────────────────────┐  │  │
│  │  │                                                      │  │  │
│  │  │  1.0  ████ Critical ████ 2.0 ░░░ Flag ░░░ 3.0 ▓▓▓▓ │  │  │
│  │  │  Good ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ 5.0  │  │  │
│  │  │                                                      │  │  │
│  │  └──────────────────────────────────────────────────────┘  │  │
│  │                                                            │  │
│  │  Flag threshold:     [===●=====] 3.0                       │  │
│  │  Score below this triggers a Watchtower warning.           │  │
│  │                                                            │  │
│  │  Critical threshold: [=●=======] 2.0                       │  │
│  │  Score below this triggers a Watchtower critical alert.    │  │
│  │                                                            │  │
│  │  [ ] Auto-escalate on critical scores                      │  │
│  │  When enabled, critical scores automatically send          │  │
│  │  escalation notifications to the configured channels.      │  │
│  │                                                            │  │
│  │  ▶ Per-dimension thresholds (advanced)                     │  │
│  │  ┌──────────────────────────────────────────────────────┐  │  │
│  │  │  helpfulness:     [======●==] 3.0                    │  │  │
│  │  │  accuracy:        [====●====] 2.5                    │  │  │
│  │  │  professionalism: [======●==] 3.0                    │  │  │
│  │  └──────────────────────────────────────────────────────┘  │  │
│  │                                                            │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ Section 4: Processing Scope ──────────────────────────────┐  │
│  │                                                            │  │
│  │  Channels: [Multi-select: web_chat, voice, whatsapp, ...]  │  │
│  │  Leave empty to evaluate all channels.                     │  │
│  │                                                            │  │
│  │  Agents:   [Multi-select: BillingAgent, SupportAgent, ...] │  │
│  │  Leave empty to evaluate all agents.                       │  │
│  │                                                            │  │
│  │  Minimum messages: [===●=====] 2                           │  │
│  │  Skip conversations with fewer messages.                   │  │
│  │                                                            │  │
│  │  Sample rate:      [=========●] 100%                       │  │
│  │  Evaluate this percentage of eligible conversations.       │  │
│  │                                                            │  │
│  │  Exclude tags:     [Tag input: test, internal, ...]        │  │
│  │                                                            │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ Section 5: Model & Cost Control ─────────────────────────┐  │
│  │                                                            │  │
│  │  LLM Provider:  [Dropdown: (Use tenant default) ▾]        │  │
│  │  Model:         [Dropdown: (Use tenant default) ▾]        │  │
│  │                                                            │  │
│  │  Temperature:    [●=========] 0.1                          │  │
│  │  Lower values produce more consistent scores.              │  │
│  │                                                            │  │
│  │  Max output tokens: [====●====] 2048                       │  │
│  │                                                            │  │
│  │  ▶ Cost Controls (optional)                                │  │
│  │  ┌──────────────────────────────────────────────────────┐  │  │
│  │  │  Daily budget cap:         [$________] USD            │  │  │
│  │  │  Per-conversation cap:     [$________] USD            │  │  │
│  │  │  Pipeline pauses when daily cap is reached.           │  │  │
│  │  └──────────────────────────────────────────────────────┘  │  │
│  │                                                            │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ Re-processing Banner (shown when reprocessing needed) ────┐  │
│  │                                                            │  │
│  │  ⚠ Configuration changed (rubric, model, or context).     │  │
│  │  Historical evaluations may no longer match current        │  │
│  │  settings. Re-process to update past scores.               │  │
│  │                                                            │  │
│  │  Estimated: ~2,340 conversations | ~$23 | ~45 min          │  │
│  │                                                            │  │
│  │  [Re-process Historical Data]  [Dismiss]                   │  │
│  │                                                            │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ Footer ───────────────────────────────────────────────────┐  │
│  │                                     [Cancel]  [Save Config]│  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### UI Component Mapping

| UI Element                 | Component                                          | Notes                                                          |
| -------------------------- | -------------------------------------------------- | -------------------------------------------------------------- |
| Master toggle              | `Toggle` (existing)                                | Enables/disables the pipeline                                  |
| Dimension cards            | Custom `DimensionCard`                             | Draggable (for reordering/weight visual), expandable           |
| Weight sliders             | `HyperParameterForm` `RangeSliderParam` (existing) | Reuse existing slider with `min: 0.1, max: 10.0, step: 0.1`    |
| Scale inputs               | Two `NumberInput` fields                           | Constrained: min < max, both integers                          |
| Criteria list              | `TagInput` variant                                 | Add/remove string items, max 10                                |
| Template selector          | `DropdownParam` (existing)                         | Populates dimensions from template                             |
| Description textarea       | `TextParam` (existing)                             | Reuse with `rows: 3`                                           |
| Threshold sliders          | `RangeSliderParam` (existing)                      | Custom track coloring: red/yellow/green zones                  |
| Channel/Agent multi-select | `MultiSelect` (existing)                           | Populated from project's known channels/agents                 |
| Provider/Model dropdowns   | `ProviderSelect` (existing)                        | Reuse from ArchSettingsPage, add "(Use tenant default)" option |
| Cost inputs                | `NumberInput` with `$` prefix                      | Optional, leave blank for no limit                             |
| Re-processing banner       | `AlertBanner` (existing)                           | Yellow warning with cost estimate                              |

### Section Ordering Rationale

The sections are ordered by importance and frequency of interaction:

1. **Rubric** first -- this is the core product. Customers will spend 80% of their time here.
2. **Judge Context** second -- domain context directly affects evaluation quality.
3. **Flagging** third -- thresholds determine what shows up in Watchtower.
4. **Scope** fourth -- usually set once during initial configuration.
5. **Model & Cost** fifth -- advanced, most customers use defaults.

### Help Text Registry

Each parameter has standardized help text for tooltips:

```typescript
const HELP_TEXT = {
  dimensions: 'Define what the LLM judge evaluates. Each dimension produces a separate score.',
  'dimensions.name':
    'Machine-readable identifier. Used in API responses and ClickHouse columns. Cannot be changed after evaluation data exists.',
  'dimensions.displayName': 'Human-readable label shown in dashboards and reports.',
  'dimensions.description':
    'Detailed instructions sent to the judge LLM. Be specific about what constitutes a high vs low score.',
  'dimensions.scale':
    'The numerical range for scores. Most teams use 1-5. All dimensions must use the same scale.',
  'dimensions.weight':
    'Relative importance when computing the overall score. Higher weight = more influence. Only used when overall score method is "weighted".',
  'dimensions.criteria':
    'Specific rubric points the judge checks. These are included in the judge prompt as a checklist.',
  overallScoreMethod:
    'How to compute a single overall score from per-dimension scores. Weighted (default) uses dimension weights. Average treats all equally. Minimum uses the lowest dimension score.',
  domainContext:
    'Tell the judge about your industry and business. Example: "We are a telecom company. Our agents handle billing, network troubleshooting, and plan changes." This improves scoring accuracy.',
  evaluatorSystemPrompt:
    "Advanced: Additional instructions prepended to the judge system prompt. Use for special scoring rules that don't fit in dimension descriptions.",
  includeToolCalls:
    'When enabled, the judge sees which tools the agent called, with what arguments, and what results were returned. Recommended for accuracy scoring.',
  includeFlowSteps:
    "When enabled, the judge sees the agent's internal flow step trace. Useful for evaluating process adherence but adds noise for most use cases.",
  includeAgentDefinition:
    "When enabled, the judge sees the agent's persona, goal, and constraints. Helps the judge evaluate whether the agent followed its instructions.",
  flagThreshold:
    'Conversations scoring below this value appear in Watchtower as warnings. Adjust based on your quality expectations.',
  criticalThreshold:
    'Conversations scoring below this value appear in Watchtower as critical alerts. Reserved for clearly unacceptable performance.',
  sampleRate:
    'Evaluate a random subset of conversations. Use 1.0 (100%) for complete coverage, or lower to control LLM costs. Minimum 1% (0.01).',
  temperature:
    'Controls LLM randomness. Lower values (0.0-0.2) produce more consistent, reproducible scores. Higher values introduce more variation.',
  maxCostPerDay:
    'Maximum daily spend on LLM calls for this pipeline. Pipeline pauses when reached and resumes the next day. Leave empty for no limit.',
} as const;
```

---

## Full TypeScript Interface (Consolidated)

```typescript
// ─── Pipeline Type Enum ──────────────────────────────────────────────

type PipelineType =
  | 'intent_classification'
  | 'quality_evaluation'
  | 'sentiment_analysis'
  | 'anomaly_detection';

// ─── Base Configs (shared across all pipelines) ──────────────────────

interface PipelineScopeConfig {
  channels: string[];
  agents: string[];
  minMessageCount: number;
  excludeTags: string[];
  sampleRate: number;
  lookbackDays: number;
  processingDelay: number;
}

interface PipelineModelConfig {
  provider?: string;
  model?: string;
  temperature: number;
  maxTokens: number;
  maxCostPerDay?: number;
  maxCostPerConversation?: number;
}

// ─── Quality Evaluation Specific ─────────────────────────────────────

interface EvaluationDimension {
  /** Machine-readable identifier. Lowercase alphanumeric + underscore. Unique within rubric. */
  name: string;

  /** Human-readable label for UI and reports. */
  displayName: string;

  /** Instructions sent to the judge LLM describing what this dimension measures. */
  description: string;

  /** Scoring scale. All dimensions in a rubric must use the same scale. */
  scale: {
    min: number; // Default: 1
    max: number; // Default: 5
  };

  /** Relative weight for weighted overall score. Default: 1.0. */
  weight: number;

  /** Specific rubric criteria the judge checks. Sent as a checklist in the prompt. */
  criteria: string[];
}

interface QualityEvaluationRubricConfig {
  /** At least 1, at most 10 evaluation dimensions. */
  dimensions: EvaluationDimension[];

  /** How to compute the overall score from per-dimension scores. */
  overallScoreMethod: 'average' | 'weighted' | 'minimum';
}

interface QualityEvaluationContextConfig {
  /** Additional system-level instructions prepended to the judge prompt. */
  evaluatorSystemPrompt?: string;

  /** Business/industry context to improve judge accuracy. */
  domainContext?: string;

  /** Include tool call details (name, args, result) in judge context. */
  includeToolCalls: boolean;

  /** Include flow step trace data in judge context. */
  includeFlowSteps: boolean;

  /** Include agent persona, goal, and constraints in judge context. */
  includeAgentDefinition: boolean;
}

interface QualityEvaluationFlaggingConfig {
  /** Overall score below this = Watchtower warning. */
  flagThreshold: number;

  /** Overall score below this = Watchtower critical alert. */
  criticalThreshold: number;

  /** Per-dimension flag thresholds. Keys must match dimension names. */
  dimensionFlagThresholds: Record<string, number>;

  /** Whether critical scores auto-send escalation notifications. */
  autoEscalateOnCritical: boolean;
}

interface QualityEvaluationConfig {
  scope: PipelineScopeConfig;
  model: PipelineModelConfig;
  rubric: QualityEvaluationRubricConfig;
  context: QualityEvaluationContextConfig;
  flagging: QualityEvaluationFlaggingConfig;
}

// ─── Pipeline Config Document (MongoDB) ──────────────────────────────

interface ConfigChange {
  version: number;
  changedBy: string;
  changedAt: Date;
  diff: Record<string, { old: unknown; new: unknown }>;
  reprocessingRequired: boolean;
}

interface PipelineConfigDocument {
  _id: ObjectId;

  /** Tenant isolation -- every query must include this. */
  tenantId: string;

  /** Optional project-level override. null = tenant-level default. */
  projectId: string | null;

  /** Pipeline discriminator. */
  pipelineType: PipelineType;

  /** Master on/off switch. */
  enabled: boolean;

  /** Auto-incremented on every save. Stamped on output rows. */
  version: number;

  /** Pipeline-specific configuration (typed per pipelineType). */
  config: QualityEvaluationConfig; // For quality_evaluation

  /** Processing state. */
  backfillStatus: 'idle' | 'running' | 'completed' | 'failed';
  lastBackfillAt?: Date;
  lastProcessedAt?: Date;
  lastProcessedSessionId?: string;

  /** Audit metadata. */
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;

  /** Last 20 configuration changes (ring buffer). */
  configHistory: ConfigChange[];
}
```

---

## MongoDB Document Example

```json
{
  "_id": { "$oid": "66a1b2c3d4e5f6a7b8c9d0e1" },
  "tenantId": "tenant-acme-corp",
  "projectId": "proj-customer-support",
  "pipelineType": "quality_evaluation",
  "enabled": true,
  "version": 7,

  "config": {
    "scope": {
      "channels": ["web_chat", "voice"],
      "agents": [],
      "minMessageCount": 3,
      "excludeTags": ["test", "internal"],
      "sampleRate": 1.0,
      "lookbackDays": 30,
      "processingDelay": 5
    },

    "model": {
      "provider": "anthropic",
      "model": "claude-haiku-4-5",
      "temperature": 0.1,
      "maxTokens": 2048,
      "maxCostPerDay": 50.0
    },

    "rubric": {
      "dimensions": [
        {
          "name": "helpfulness",
          "displayName": "Helpfulness",
          "description": "Did the agent understand and address the customer's actual need? Consider whether the agent identified the core issue, provided actionable steps, and confirmed resolution.",
          "scale": { "min": 1, "max": 5 },
          "weight": 1.5,
          "criteria": [
            "Agent correctly identified the core issue or request",
            "Agent provided a concrete resolution or clear next step",
            "Agent confirmed the customer's need was met before closing"
          ]
        },
        {
          "name": "accuracy",
          "displayName": "Accuracy",
          "description": "Were the agent's responses factually correct and consistent with tool results and available information?",
          "scale": { "min": 1, "max": 5 },
          "weight": 2.0,
          "criteria": [
            "Information provided was factually correct",
            "Tool results were interpreted and relayed accurately",
            "No contradictions between agent statements",
            "No hallucinated information (data not in tool results)"
          ]
        },
        {
          "name": "professionalism",
          "displayName": "Professionalism",
          "description": "Was the agent's tone appropriate, empathetic, and professional throughout the conversation?",
          "scale": { "min": 1, "max": 5 },
          "weight": 1.0,
          "criteria": [
            "Tone was polite and respectful throughout",
            "Agent showed empathy when the customer expressed frustration",
            "Language was clear and free of unnecessary jargon"
          ]
        }
      ],
      "overallScoreMethod": "weighted"
    },

    "context": {
      "evaluatorSystemPrompt": null,
      "domainContext": "We are a telecom company specializing in enterprise fiber optic services. Our agents handle billing inquiries, network troubleshooting, plan changes, and service outage reports.",
      "includeToolCalls": true,
      "includeFlowSteps": false,
      "includeAgentDefinition": true
    },

    "flagging": {
      "flagThreshold": 3.0,
      "criticalThreshold": 2.0,
      "dimensionFlagThresholds": {
        "accuracy": 2.5
      },
      "autoEscalateOnCritical": false
    }
  },

  "backfillStatus": "completed",
  "lastBackfillAt": { "$date": "2026-03-02T14:30:00.000Z" },
  "lastProcessedAt": { "$date": "2026-03-03T10:15:22.000Z" },
  "lastProcessedSessionId": "sess-abc-12345",

  "createdBy": "user-jane-doe",
  "updatedBy": "user-jane-doe",
  "createdAt": { "$date": "2026-02-15T09:00:00.000Z" },
  "updatedAt": { "$date": "2026-03-01T16:45:00.000Z" },

  "configHistory": [
    {
      "version": 7,
      "changedBy": "user-jane-doe",
      "changedAt": { "$date": "2026-03-01T16:45:00.000Z" },
      "diff": {
        "config.flagging.flagThreshold": { "old": 3.5, "new": 3.0 }
      },
      "reprocessingRequired": false
    },
    {
      "version": 6,
      "changedBy": "user-john-smith",
      "changedAt": { "$date": "2026-02-28T11:20:00.000Z" },
      "diff": {
        "config.rubric.dimensions[2].criteria": {
          "old": ["Tone was polite", "Agent showed empathy"],
          "new": [
            "Tone was polite and respectful throughout",
            "Agent showed empathy when the customer expressed frustration",
            "Language was clear and free of unnecessary jargon"
          ]
        }
      },
      "reprocessingRequired": true
    }
  ]
}
```

---

## Configuration Resolution Example

When the pipeline processes a conversation for `tenant-acme-corp` / `proj-customer-support`:

```
Step 1: Query pipeline_configs WHERE tenantId='tenant-acme-corp'
        AND pipelineType='quality_evaluation'
        AND projectId='proj-customer-support'

        Found? YES -> Use this document (project-level config).

Step 2: (skipped -- project-level found)

Step 3: For any field with value undefined/null in the document,
        apply QUALITY_EVALUATION_DEFAULTS.

Step 4: For model.provider and model.model, if still undefined,
        resolve via SessionLLMClient tenant credential chain.
```

---

## API Endpoints

```
# Configuration CRUD
GET    /api/projects/:projectId/pipelines/quality_evaluation/config
PUT    /api/projects/:projectId/pipelines/quality_evaluation/config
DELETE /api/projects/:projectId/pipelines/quality_evaluation/config

# Tenant-level default config
GET    /api/pipelines/quality_evaluation/config
PUT    /api/pipelines/quality_evaluation/config

# Templates
GET    /api/pipelines/quality_evaluation/templates

# Backfill
POST   /api/projects/:projectId/pipelines/quality_evaluation/backfill
GET    /api/projects/:projectId/pipelines/quality_evaluation/backfill/status

# Cost estimate
POST   /api/projects/:projectId/pipelines/quality_evaluation/backfill/estimate

# Validation (dry-run)
POST   /api/pipelines/quality_evaluation/config/validate
```

All endpoints require `requireProjectPermission(req, res, 'pipeline:write')` for mutations and `'pipeline:read'` for reads. Every query is scoped to `tenantId` from the auth context.

---

## Summary of Key Design Decisions

1. **Only `dimensions` is REQUIRED.** Everything else has a sensible default. A customer can enable quality evaluation by just defining their rubric.

2. **Full document replacement, not deep merge.** Project-level config fully overrides tenant-level. Copy-on-customize in the UI.

3. **Re-processing is explicit, not automatic.** Changing the rubric shows a banner with cost estimate. Customer chooses when to backfill.

4. **Thresholds are hot-applied.** Changing flag/critical thresholds does not require re-processing -- existing scores are re-evaluated against new thresholds via ClickHouse query.

5. **Scale consistency enforced.** All dimensions in a rubric use the same scale (v1 constraint). Simplifies overall score computation and threshold comparison.

6. **Config version stamped on output.** Every ClickHouse row includes `config_version`, enabling before/after comparison when config changes.

7. **20-entry ring buffer for config history.** Enough for audit trail without unbounded growth. Full audit via `audit_events` table.

8. **Templates are not defaults.** The platform does not auto-populate a rubric. Templates are offered during setup as a starting point. This avoids customers unknowingly running with a generic rubric.

9. **Model selection follows tenant LLM chain.** If provider/model are unset, the pipeline uses the tenant's configured LLM (same credential chain as Arch). No separate API key management for pipelines.

10. **Max 10 dimensions.** Practical limit to bound LLM cost per evaluation and keep judge prompts focused. Each dimension adds approximately 200-500 tokens to the prompt.

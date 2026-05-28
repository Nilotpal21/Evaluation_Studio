# LLM Evaluate Node — Design Spec

> Generic, tag-driven LLM evaluation node for the pipeline engine. Replaces the existing `call-llm` node with a unified evaluation primitive that stores results to a single ClickHouse table, queryable by tag.

## Problem

The pipeline engine has 10+ specialized evaluation processors (sentiment, quality, hallucination, etc.), each with hardcoded prompts, dedicated ClickHouse tables, and custom service code. Adding a new evaluation type requires:

1. Writing a new Restate service
2. Defining a new ClickHouse table
3. Adding activity metadata
4. Registering in the activity router
5. Creating API endpoints
6. Updating the UI

The customer query analysis identified ~96 partially answerable and ~43 unanswerable queries — many of which need custom LLM evaluations (extraction quality, reasoning quality, routing accuracy, CSAT inference, etc.). Building dedicated processors for each is not scalable.

## Solution

Enhance the existing `call-llm` activity type into `llm-evaluate` — a generic evaluation node where users define the task via:

- **System prompt** — fixed instructions defining the evaluation task
- **User prompt** — hybrid template with `{{context.conversation}}` variable resolution
- **Output schema** — optional JSON schema defining expected output structure
- **Tag** — mandatory string identifier for filtering/querying results
- **Score field** — which output field contains the numeric score

All outputs go to a single `llm_evaluate` ClickHouse table, discriminated by `tag`. Threshold-based flagging lives in the presentation layer, not the data layer.

## Design Decisions

### Tag is mandatory

Without a tag, results stored in the unified table cannot be meaningfully queried. This node's purpose is evaluation with storage — a tagless LLM call is a different use case (and can be handled via the backward-compatible `call-llm` alias which skips storage when no tag is present).

### Single `userPrompt` field (not separate static/template)

At runtime, check if the prompt contains `{{...}}` patterns. If yes, resolve templates. If no, use as-is. Users don't need to think about which field to use. For backward compatibility, if `userPromptTemplate` is present in config but `userPrompt` is not, use `userPromptTemplate` as the prompt.

### Output schema is optional

- **Not provided:** Output is treated as raw string, no validation, stored as-is in the `output` JSON column.
- **Provided:** Schema is injected into the system prompt to guide the LLM. Response is validated against the schema.
- **Provided + strict mode:** On validation failure (including JSON parse failure), the LLM is re-called with the validation errors appended (max 2 retries).

### Score extraction convention

Default: look for a field called `score` in the parsed output. Override via `scoreField` config (e.g., `"scoreField": "extraction_accuracy"`). If the field doesn't exist or isn't numeric, `score` is stored as `NULL`. Scores outside [0, 1] are stored as-is with a warning logged — the service does not clamp or normalize.

### Threshold-based flagging is a presentation concern

**Not stored in the data layer.** Rationale:

1. **Directionality varies** — toxicity: lower is better; groundedness: higher is better. A simple threshold doesn't encode direction.
2. **Thresholds change** — modifying a threshold would require rewriting historical data.
3. **Query-time evaluation is instant** — the API/UI applies `direction + threshold` at query time. No data migration needed.

Threshold config is stored per tag in MongoDB and applied by the API layer.

### Re-evaluation overwrites previous results

The `llm_evaluate` table uses `ReplacingMergeTree` with ORDER BY `(tenant_id, project_id, tag, session_id)`. Re-evaluating the same session with the same tag replaces the previous result (keeping the latest by `processed_at`). This makes re-runs idempotent. If point-in-time comparison is needed in the future, `config_version` or `pipeline_id` can be added to the ORDER BY.

### Strict retry cost

Strict mode can make up to 3 LLM calls per activity execution (1 initial + 2 retries). Combined with the activity-level `defaultRetries: 2`, the theoretical worst case is 3 calls x 3 attempts = 9 LLM calls. In practice, activity-level retries only fire on infrastructure errors (timeouts, 5xx), not on validation failures. The strict retry loop is internal to a single activity attempt.

## ClickHouse Table

```sql
CREATE TABLE IF NOT EXISTS ${DATABASE}.llm_evaluate (
  tenant_id          String,
  project_id         String,
  session_id         String,
  session_started_at DateTime64(3),
  tag                LowCardinality(String),
  score              Nullable(Float32),
  output             String,                          -- full JSON blob from LLM response
  agent_name         LowCardinality(String),
  channel            LowCardinality(String),
  model_id           LowCardinality(String),
  input_tokens       UInt32,
  output_tokens      UInt32,
  processing_ms      UInt32,
  pipeline_id        String,
  pipeline_type      LowCardinality(String) DEFAULT '',
  source             LowCardinality(String) DEFAULT 'batch',
  config_version     UInt32 DEFAULT 1,
  processed_at       DateTime64(3),

  INDEX idx_tag tag TYPE set(100) GRANULARITY 4,
  INDEX idx_score score TYPE minmax GRANULARITY 4
) ENGINE = ReplacingMergeTree(processed_at)
PARTITION BY (tenant_id, toYYYYMM(processed_at))
ORDER BY (tenant_id, project_id, tag, session_id)
TTL toDateTime(processed_at) + INTERVAL 730 DAY DELETE
```

### Daily Rollup (Materialized View)

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS ${DATABASE}.mv_daily_llm_evaluate
ENGINE = SummingMergeTree()
ORDER BY (tenant_id, project_id, day, tag, agent_name)
AS SELECT
  tenant_id,
  project_id,
  toDate(processed_at) AS day,
  tag,
  agent_name,
  count() AS eval_count,
  countIf(score IS NOT NULL) AS scored_eval_count,
  sumIf(score, score IS NOT NULL) AS total_score
FROM ${DATABASE}.llm_evaluate
WHERE source = 'batch' OR source = ''
GROUP BY tenant_id, project_id, day, tag, agent_name
```

Average score is computed at query time: `total_score / scored_eval_count` (avoids inflation from NULL scores).

### Queryability

Any field in the `output` JSON blob can be queried using ClickHouse JSON functions:

```sql
-- Extract a specific field from the JSON output
SELECT JSONExtractFloat(output, 'extraction_accuracy') AS accuracy
FROM llm_evaluate
WHERE tag = 'extraction_quality';

-- Filter by a nested field
SELECT * FROM llm_evaluate
WHERE tag = 'reasoning_check'
  AND JSONExtractBool(output, 'self_corrected') = true;
```

## Activity Metadata

The `ConfigField[]` array used by the pipeline editor UI (rendered by `ConfigSchemaForm.tsx`):

```typescript
'llm-evaluate': {
  name: 'LLM Evaluate',
  description: 'LLM-powered evaluation with structured output, tagging, and auto-storage',
  configSchema: {
    required: ['tag', 'systemPrompt', 'userPrompt'],
    properties: {
      tag: {
        type: 'string',
        description: 'Evaluation identifier (e.g. "extraction_quality"). Results are stored and queryable by this tag.',
        label: 'Tag',
        placeholder: 'e.g., extraction_quality',
      },
      systemPrompt: {
        type: 'string',
        description: 'System instructions defining the evaluation task',
        label: 'System Prompt',
        placeholder: 'You are an expert evaluator...',
        multiline: true,
      },
      userPrompt: {
        type: 'string',
        description: 'User prompt — supports {{context.conversation}} and {{steps.stepId.output.field}} template variables',
        label: 'User Prompt',
        placeholder: 'Analyze this conversation:\n\n{{steps.read-conversation.output.transcript}}',
        multiline: true,
      },
      outputSchema: {
        type: 'object',
        description: 'Optional JSON schema defining expected LLM output structure. Injected into system prompt to guide the LLM. Without a schema, the output is stored as-is with no validation.',
        label: 'Output Schema',
        group: 'schema',
      },
      strict: {
        type: 'boolean',
        description: 'When enabled, retries LLM call with validation errors if output does not match schema (max 2 retries). Requires Output Schema to be defined.',
        label: 'Strict Schema Validation',
        group: 'schema',
      },
      scoreField: {
        type: 'string',
        description: 'Output field to use as the numeric score (default: "score")',
        label: 'Score Field',
        placeholder: 'score',
      },
      model: {
        type: 'string',
        description: 'LLM model override (default: project default)',
        label: 'Model',
        group: 'advanced',
      },
      temperature: {
        type: 'number',
        description: 'LLM temperature (default: 0)',
        label: 'Temperature',
        default: 0,
        group: 'advanced',
      },
      maxTokens: {
        type: 'number',
        description: 'Max output tokens (default: 1024)',
        label: 'Max Tokens',
        default: 1024,
        group: 'advanced',
      },
    },
  },
  outputSchema: {
    properties: {
      tag:          { type: 'string', description: 'The evaluation tag' },
      score:        { type: 'number', description: 'Extracted numeric score, null if not found' },
      output:       { type: 'object', description: 'Full parsed JSON output from LLM' },
      raw:          { type: 'string', description: 'Raw text response' },
      inputTokens:  { type: 'number', description: 'Input token count' },
      outputTokens: { type: 'number', description: 'Output token count' },
      model:        { type: 'string', description: 'Model used' },
    },
  },
  defaultTimeout: 60_000,
  defaultRetries: 2,
},
```

### UI Rendering Notes

**Multiline prompts:** The `systemPrompt` and `userPrompt` fields use `multiline: true`. This requires adding `multiline` support to `ConfigField` type and `ConfigSchemaForm.tsx` — when `field.type === 'string' && field.multiline`, render a `<textarea>` instead of `<Input>`. This is a small addition (~5 lines in the renderer).

**Schema group:** `outputSchema` and `strict` are grouped under `group: 'schema'` so they render in a collapsible "Schema" section. The `strict` toggle always renders but its description clarifies it requires Output Schema — no `showWhen` needed since the existing `showWhen` mechanism doesn't support "has a value" checks on object fields.

**Info icons:** Fields with longer descriptions should render an info icon tooltip. This is already supported by `ConfigSchemaForm.tsx` for fields with `description` — no change needed.

## Service Logic

### Execute Flow

````
1. Extract config
   tag, systemPrompt, userPrompt, outputSchema, strict, scoreField, model, temperature, maxTokens
   Backward compat: userPrompt = config.userPrompt ?? config.userPromptTemplate

2. Resolve userPrompt
   - Scan for {{...}} patterns using TEMPLATE_PLACEHOLDER_RE
   - If found → resolveTemplate(userPrompt, previousSteps, pipelineInput)
   - If not → use as-is

3. Build final system prompt
   - Start with config.systemPrompt
   - If outputSchema defined → append:
     "\n\nYou MUST respond with valid JSON matching this schema:\n```json\n{JSON.stringify(outputSchema, null, 2)}\n```"

4. Call LLM (Restate durable via ctx.run)
   - messages: [{ role: 'system', content: finalSystemPrompt }, { role: 'user', content: resolvedUserPrompt }]
   - responseFormat: 'json'
   - model, temperature, maxTokens from config

5. Parse + validate response (see Strict Retry Logic below)
   - Handles JSON parse failure, schema validation failure, and strict retries

6. Extract score
   - Field name = config.scoreField ?? 'score'
   - If field exists in parsed output and is numeric → use it
   - If score is outside [0, 1] → log warning, store as-is
   - Otherwise → null

7. Write to ClickHouse (llm_evaluate table)
   {
     tenant_id, project_id, session_id, session_started_at, tag,
     score,
     output: JSON.stringify(parsedOutput),
     agent_name, channel,        // from execution context metadata
     model_id, input_tokens, output_tokens, processing_ms,
     pipeline_id, pipeline_type, source, config_version,
     processed_at
   }

8. Return StepOutput
   {
     status: 'success',
     data: { tag, score, ...parsedOutput, inputTokens, outputTokens, model }
   }
````

### Strict Retry Logic

```
attempt = 0
MAX_RETRIES = 2

while attempt <= MAX_RETRIES:
  response = callLLM(messages)

  // Step A: Parse JSON
  try:
    parsed = JSON.parse(response)
  catch:
    if strict AND attempt < MAX_RETRIES:
      messages.push({ role: 'assistant', content: response })
      messages.push({ role: 'user', content:
        "Your response was not valid JSON. Please respond with valid JSON only."
      })
      attempt++
      continue
    else:
      return { status: 'fail', data: { error: 'JSON parse failed' } }

  // Step B: Validate against schema (if defined)
  if outputSchema is defined:
    errors = validate(parsed, outputSchema)
    if errors.length > 0 AND strict AND attempt < MAX_RETRIES:
      messages.push({ role: 'assistant', content: response })
      messages.push({ role: 'user', content:
        "Your response did not match the required schema.\n" +
        "Validation errors:\n" +
        errors.map(e => `- ${e.path}: ${e.message}`).join('\n') +
        "\n\nPlease respond again with valid JSON matching the schema."
      })
      attempt++
      continue

  break  // valid, or not strict, or max retries reached
```

Key: When `strict` is enabled, JSON parse failures also trigger retries (not just schema validation failures).

## Threshold Config (Presentation Layer)

### MongoDB Model

```typescript
interface EvaluationTagConfig {
  tenantId: string;
  projectId: string;
  tag: string; // matches llm_evaluate.tag
  direction: 'higher_is_better' | 'lower_is_better'; // default: 'higher_is_better'
  threshold: number; // e.g., 0.7
  displayName?: string; // e.g., "Extraction Quality"
  description?: string; // shown in UI
}
```

**Collection:** `evaluationTagConfigs`
**Unique index:** `{ tenantId: 1, projectId: 1, tag: 1 }` (compound unique)
**All queries must include `tenantId`** per Core Invariant #1 (Resource Isolation).

### API

```
GET  /api/projects/:projectId/evaluation-tags          → list all tags with configs
PUT  /api/projects/:projectId/evaluation-tags/:tag     → upsert threshold/direction/display
```

Routes use `requireProjectPermission` middleware.

### Query-Time Flagging

The pipeline analytics API applies threshold config when returning results:

```sql
-- direction = 'higher_is_better', threshold = 0.7
SELECT *, (score IS NOT NULL AND score < 0.7) AS flagged
FROM llm_evaluate WHERE tag = 'groundedness';

-- direction = 'lower_is_better', threshold = 0.3
SELECT *, (score IS NOT NULL AND score > 0.3) AS flagged
FROM llm_evaluate WHERE tag = 'toxicity';
```

NULL scores are never flagged.

## Backward Compatibility

### Alias for existing `call-llm`

The activity router `SERVICE_HANDLERS` map gets both entries pointing to the same handler:

```typescript
// In activity-router.service.ts — SERVICE_HANDLERS
'llm-evaluate': (llmEvaluateService as any).service.execute,
'call-llm':     (llmEvaluateService as any).service.execute,  // backward compat alias
```

The `ACTIVITY_TYPES` metadata also retains a `call-llm` entry (identical to `llm-evaluate`) so metadata lookups don't fail for existing pipeline definitions.

When routed via the `call-llm` alias:

- `tag` is not required — if absent, no ClickHouse write occurs
- Behaves exactly like the current `call-llm` node
- Existing pipelines continue to work without modification

### Config field migration

If `config.userPromptTemplate` exists but `config.userPrompt` does not, use `userPromptTemplate` as the prompt. This is a one-line fallback in the service:

```typescript
const prompt = (input.config.userPrompt ?? input.config.userPromptTemplate) as string;
```

## Pipeline Editor UI Changes

### ConfigField type addition

Add `multiline?: boolean` to the `ConfigField` interface in `types.ts`:

```typescript
export interface ConfigField {
  // ... existing fields ...
  multiline?: boolean; // NEW: render as textarea instead of single-line input
}
```

### ConfigSchemaForm.tsx change

When rendering a `type: 'string'` field, check `field.multiline`:

```typescript
// In the string field rendering section
if (field.multiline) {
  return <textarea className="..." rows={6} value={value} onChange={...} placeholder={field.placeholder} />;
}
return <Input type="text" value={value} onChange={...} placeholder={field.placeholder} />;
```

### Node Configuration Panel

When an `llm-evaluate` node is selected in the graph editor, the right panel renders:

1. **Tag** — text input, required, top of form
   - Placeholder: `"e.g., extraction_quality"`

2. **System Prompt** — textarea (multiline), required
   - Placeholder: `"You are an expert evaluator..."`

3. **User Prompt** — textarea (multiline), required
   - Helper text: _"Use `{{context.conversation}}` to inject conversation data. Use `{{steps.stepId.output.field}}` for prior step outputs."_

4. **Score Field** — text input, default `"score"`
   - Helper text: _"Which field in the output contains the numeric score"_

5. **Schema** (collapsible group):
   - **Output Schema** — JSON editor (optional)
     - Info icon tooltip: _"Define the expected JSON structure for the LLM's response. When provided, this schema is injected into the system prompt to guide the response format. Without a schema, the output is stored as-is with no validation."_
   - **Strict Schema Validation** — toggle
     - Info icon tooltip: _"When enabled, if the LLM's response doesn't match the schema, the call is retried with validation error feedback (up to 2 retries). Requires Output Schema to be defined."_

6. **Advanced** (collapsible group):
   - Model — searchable dropdown (fetches `/api/models`)
   - Temperature — number input (default 0)
   - Max Tokens — number input (default 1024)

### Node Palette

- Category: `compute`
- Label: "LLM Evaluate"
- Description: "LLM-powered evaluation with structured output and tagging"

## Files to Change

### Pipeline Engine (`packages/pipeline-engine/`)

| File                                               | Change                                                                                                                                                                                    |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/pipeline/services/call-llm.service.ts`        | Rename to `llm-evaluate.service.ts`. Add: tag, outputSchema injection, strict retry, score extraction, ClickHouse write.                                                                  |
| `src/pipeline/types.ts`                            | Add `multiline?: boolean` to `ConfigField` interface.                                                                                                                                     |
| `src/pipeline/activity-metadata.ts`                | Replace `call-llm` entry with `llm-evaluate`. Keep `call-llm` as duplicate entry for backward compat.                                                                                     |
| `src/pipeline/handlers/activity-router.service.ts` | Update SERVICE_HANDLERS: add `llm-evaluate` entry, keep `call-llm` alias. Replace `console.log` with `createLogger`.                                                                      |
| `src/pipeline/server.ts`                           | Update import and Restate binding name.                                                                                                                                                   |
| `src/pipeline/schemas/init-analytics-tables.ts`    | Add `llm_evaluate` table and `mv_daily_llm_evaluate` MV DDL entries.                                                                                                                      |
| `src/__tests__/call-llm.test.ts`                   | Rename to `llm-evaluate.test.ts`. Add tests for: tag storage, schema validation, strict retry (including JSON parse retry), score extraction, NULL score handling, backward compat alias. |

### Runtime (`apps/runtime/`)

| File                                | Change                                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `src/routes/pipeline-analytics.ts`  | Add `llm-evaluate` as a valid pipeline type. Support tag-based filtering. Apply query-time flagging from `EvaluationTagConfig`. |
| `src/routes/evaluation-tags.ts`     | **New file.** CRUD routes for `EvaluationTagConfig` with `requireProjectPermission`.                                            |
| `src/models/EvaluationTagConfig.ts` | **New file.** Mongoose schema with compound unique index `(tenantId, projectId, tag)`.                                          |

### Studio (`apps/studio/`)

| File                                            | Change                                                                                        |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/components/pipelines/ConfigSchemaForm.tsx` | Add `multiline` check for string fields — render `<textarea>` when `field.multiline` is true. |

## Example Usage

### Extraction Quality Evaluation

**Pipeline definition:**

```yaml
steps:
  - id: read-conversation
    activityType: read-conversation
  - id: evaluate-extraction
    activityType: llm-evaluate
    config:
      tag: 'extraction_quality'
      systemPrompt: |
        You are an expert at evaluating information extraction quality in customer support conversations.
        Assess how well the AI agent extracted required information from the customer.
      userPrompt: |
        Analyze this conversation for extraction quality:

        {{steps.read-conversation.output.transcript}}
      outputSchema:
        type: object
        properties:
          score:
            type: number
            description: 'Overall extraction quality 0-1'
          fields_expected:
            type: number
          fields_extracted:
            type: number
          fields_correct:
            type: number
          missing_fields:
            type: array
            items:
              type: string
          summary:
            type: string
        required: [score, fields_expected, fields_extracted, fields_correct]
      strict: true
      scoreField: 'score'
```

**Threshold config (set via API):**

```json
{
  "tag": "extraction_quality",
  "direction": "higher_is_better",
  "threshold": 0.7,
  "displayName": "Extraction Quality",
  "description": "How well the agent extracts required fields from customer messages"
}
```

**Stored result (ClickHouse row):**

```json
{
  "tenant_id": "tenant-123",
  "project_id": "proj-456",
  "session_id": "sess-789",
  "tag": "extraction_quality",
  "score": 0.85,
  "output": "{\"score\":0.85,\"fields_expected\":5,\"fields_extracted\":5,\"fields_correct\":4,\"missing_fields\":[],\"summary\":\"Agent extracted 4/5 fields correctly...\"}",
  "agent_name": "BillingAgent",
  "model_id": "claude-haiku-4-5",
  "source": "batch",
  "processing_ms": 1200,
  "processed_at": "2026-03-12 14:30:00.000"
}
```

**Query-time flagging (API applies threshold):**

```sql
SELECT *, (score IS NOT NULL AND score < 0.7) AS flagged
FROM llm_evaluate
WHERE tenant_id = 'tenant-123'
  AND project_id = 'proj-456'
  AND tag = 'extraction_quality'
  AND processed_at >= '2026-03-01'
ORDER BY processed_at DESC;
```

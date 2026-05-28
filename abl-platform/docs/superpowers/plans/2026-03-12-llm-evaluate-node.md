# LLM Evaluate Node Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `call-llm` pipeline node with `llm-evaluate` — a tag-driven, schema-aware evaluation node that stores all results to a single `llm_evaluate` ClickHouse table.

**Architecture:** Enhance the existing `call-llm` Restate service with: mandatory `tag` for result identification, optional `outputSchema` with strict retry, score extraction, and auto-storage to ClickHouse. Backward compatibility via `call-llm` alias in the activity router. Presentation-layer flagging via `EvaluationTagConfig` MongoDB model.

**Tech Stack:** TypeScript, Restate SDK, ClickHouse, MongoDB/Mongoose, Ajv (JSON Schema validation), React (Studio UI)

**Spec:** `docs/superpowers/specs/2026-03-12-llm-evaluate-node-design.md`

---

## File Map

### Creates

| File                                                                     | Purpose                                      |
| ------------------------------------------------------------------------ | -------------------------------------------- |
| `packages/pipeline-engine/src/pipeline/services/llm-evaluate.service.ts` | New service (replaces `call-llm.service.ts`) |
| `packages/pipeline-engine/src/__tests__/llm-evaluate.test.ts`            | Tests for the new service                    |
| `apps/runtime/src/models/EvaluationTagConfig.ts`                         | Mongoose model for per-tag threshold config  |
| `apps/runtime/src/routes/evaluation-tags.ts`                             | CRUD routes for tag threshold config         |

### Modifies

| File                                                                              | Change                                                          |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `packages/pipeline-engine/src/pipeline/types.ts:3-33`                             | Add `multiline?: boolean` to `ConfigField`                      |
| `packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts`          | Add `llm_evaluate` table + MV DDL entries                       |
| `packages/pipeline-engine/src/pipeline/activity-metadata.ts:279-321`              | Replace `call-llm` with `llm-evaluate` entry, keep alias        |
| `packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts:29,82` | Update import + add `llm-evaluate` and `call-llm` alias entries |
| `packages/pipeline-engine/src/pipeline/server.ts:41,287`                          | Update import + binding                                         |
| `apps/runtime/src/routes/pipeline-analytics.ts:59-83`                             | Add `llm_evaluate` to valid types and table maps                |
| `apps/studio/src/components/pipelines/ConfigSchemaForm.tsx:248-262`               | Add multiline textarea rendering for string fields              |

### Deletes

| File                                                                 | Reason                                |
| -------------------------------------------------------------------- | ------------------------------------- |
| `packages/pipeline-engine/src/pipeline/services/call-llm.service.ts` | Replaced by `llm-evaluate.service.ts` |
| `packages/pipeline-engine/src/__tests__/call-llm.test.ts`            | Replaced by `llm-evaluate.test.ts`    |

---

## Chunk 1: Pipeline Engine — Core Service

### Task 1: Add `multiline` to ConfigField type

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/types.ts:3-33`

- [ ] **Step 1: Add `multiline` property to ConfigField interface**

In `packages/pipeline-engine/src/pipeline/types.ts`, add `multiline?: boolean` after the `placeholder` field (line 10):

```typescript
// After line 10 (placeholder?: string;)
  multiline?: boolean;
```

- [ ] **Step 2: Build to verify no type errors**

Run: `pnpm build --filter=@agent-platform/pipeline-engine`
Expected: Clean build

- [ ] **Step 3: Commit**

```bash
npx prettier --write packages/pipeline-engine/src/pipeline/types.ts
git add packages/pipeline-engine/src/pipeline/types.ts
git commit -m "feat(pipeline-engine): add multiline option to ConfigField type"
```

---

### Task 2: Add ClickHouse DDL for `llm_evaluate` table

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts`

- [ ] **Step 1: Add `llm_evaluate` table DDL to `ANALYTICS_TABLE_DDL` array**

Add the following entry at the end of the `ANALYTICS_TABLE_DDL` array (before the closing `];` on line 864):

```typescript
  {
    name: 'llm_evaluate',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.llm_evaluate (
    tenant_id          String,
    project_id         String,
    session_id         String,
    session_started_at DateTime64(3),
    tag                LowCardinality(String),
    score              Nullable(Float32),
    output             String,

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
)
ENGINE = ReplacingMergeTree(processed_at)
PARTITION BY (tenant_id, toYYYYMM(processed_at))
ORDER BY (tenant_id, project_id, tag, session_id)
TTL toDateTime(processed_at) + INTERVAL 730 DAY DELETE
`,
  },
```

- [ ] **Step 2: Add `mv_daily_llm_evaluate` MV DDL to `ANALYTICS_MV_DDL` array**

Add at the end of the `ANALYTICS_MV_DDL` array:

```typescript
  {
    name: 'mv_daily_llm_evaluate',
    ddl: `
CREATE MATERIALIZED VIEW IF NOT EXISTS ${DATABASE}.mv_daily_llm_evaluate
ENGINE = SummingMergeTree()
ORDER BY (tenant_id, project_id, day, tag, agent_name)
AS SELECT
    tenant_id,
    project_id,
    toDate(processed_at) AS day,
    tag,
    agent_name,
    count()                          AS eval_count,
    countIf(score IS NOT NULL)       AS scored_eval_count,
    sumIf(score, score IS NOT NULL)  AS total_score
FROM ${DATABASE}.llm_evaluate
WHERE source = 'batch' OR source = ''
GROUP BY tenant_id, project_id, day, tag, agent_name
`,
  },
```

- [ ] **Step 3: Build to verify DDL strings are valid TypeScript**

Run: `pnpm build --filter=@agent-platform/pipeline-engine`
Expected: Clean build

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts
git add packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts
git commit -m "feat(pipeline-engine): add llm_evaluate ClickHouse table and daily rollup MV"
```

---

### Task 3: Write failing tests for llm-evaluate service

**Files:**

- Create: `packages/pipeline-engine/src/__tests__/llm-evaluate.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { PipelineStepContext, StepOutput } from '../pipeline/types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockChat = vi.fn();
vi.mock('../pipeline/services/llm-client-factory.js', () => ({
  createPipelineLLMClient: () => Promise.resolve({ chat: mockChat }),
}));

const mockInsert = vi.fn().mockResolvedValue(undefined);
vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: () => ({ insert: mockInsert }),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { llmEvaluateService } = await import('../pipeline/services/llm-evaluate.service.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ctx(): any {
  return {
    run: async (_label: string, fn: () => any) => fn(),
    console: { log: () => {} },
  };
}

function getExecute(svc: any): (ctx: any, input: PipelineStepContext) => Promise<StepOutput> {
  return (svc as any).service.execute;
}

const execute = getExecute(llmEvaluateService);

function makeInput(overrides: Partial<PipelineStepContext> = {}): PipelineStepContext {
  return {
    tenantId: 'acme-corp',
    projectId: 'support-bot',
    sessionId: 'sess-001',
    config: {
      tag: 'test_eval',
      systemPrompt: 'You are a helpful analyst.',
      userPrompt: 'Analyze this conversation.',
    },
    previousSteps: {},
    pipelineInput: {
      tenantId: 'acme-corp',
      projectId: 'support-bot',
      sessionId: 'sess-001',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LLMEvaluate service', () => {
  beforeEach(() => {
    mockChat.mockReset();
    mockInsert.mockClear();
  });

  test('calls LLM, extracts score, and writes to ClickHouse', async () => {
    mockChat.mockResolvedValue({
      content: '{"score": 0.85, "summary": "Good extraction"}',
      inputTokens: 100,
      outputTokens: 25,
      model: 'claude-haiku-4-5',
    });

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    expect(result.data.score).toBe(0.85);
    expect(result.data.tag).toBe('test_eval');

    // Verify ClickHouse write
    expect(mockInsert).toHaveBeenCalledTimes(1);
    const insertCall = mockInsert.mock.calls[0][0];
    expect(insertCall.table).toBe('abl_platform.llm_evaluate');
    const row = insertCall.values[0];
    expect(row.tag).toBe('test_eval');
    expect(row.score).toBe(0.85);
    expect(row.tenant_id).toBe('acme-corp');
  });

  test('uses custom scoreField to extract score', async () => {
    mockChat.mockResolvedValue({
      content: '{"quality": 0.72, "details": "some info"}',
      inputTokens: 80,
      outputTokens: 20,
      model: 'claude-haiku-4-5',
    });

    const input = makeInput({
      config: {
        tag: 'custom_score',
        systemPrompt: 'Evaluate quality.',
        userPrompt: 'Check this.',
        scoreField: 'quality',
      },
    });

    const result = await execute(ctx(), input);

    expect(result.status).toBe('success');
    expect(result.data.score).toBe(0.72);
    const row = mockInsert.mock.calls[0][0].values[0];
    expect(row.score).toBe(0.72);
  });

  test('stores null score when scoreField is missing from output', async () => {
    mockChat.mockResolvedValue({
      content: '{"analysis": "done"}',
      inputTokens: 50,
      outputTokens: 10,
      model: 'claude-haiku-4-5',
    });

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    expect(result.data.score).toBeNull();
    const row = mockInsert.mock.calls[0][0].values[0];
    expect(row.score).toBeNull();
  });

  test('resolves {{...}} template variables in userPrompt', async () => {
    mockChat.mockResolvedValue({
      content: '{"score": 0.9}',
      inputTokens: 120,
      outputTokens: 10,
      model: 'claude-haiku-4-5',
    });

    const input = makeInput({
      config: {
        tag: 'template_test',
        systemPrompt: 'Evaluate.',
        userPrompt: 'Analyze:\n\n{{steps.read-conversation.output.transcript}}',
      },
      previousSteps: {
        'read-conversation': {
          status: 'success',
          data: { transcript: 'User: Hello\nAssistant: Hi!' },
        },
      },
    });

    const result = await execute(ctx(), input);

    expect(result.status).toBe('success');
    const chatCall = mockChat.mock.calls[0][0];
    expect(chatCall.messages[1].content).toContain('User: Hello\nAssistant: Hi!');
  });

  test('falls back to userPromptTemplate for backward compat', async () => {
    mockChat.mockResolvedValue({
      content: '{"score": 0.5}',
      inputTokens: 50,
      outputTokens: 10,
      model: 'claude-haiku-4-5',
    });

    const input = makeInput({
      config: {
        tag: 'compat_test',
        systemPrompt: 'Evaluate.',
        userPromptTemplate: 'Static prompt from old config.',
      },
    });

    const result = await execute(ctx(), input);

    expect(result.status).toBe('success');
    const chatCall = mockChat.mock.calls[0][0];
    expect(chatCall.messages[1].content).toBe('Static prompt from old config.');
  });

  test('injects outputSchema into system prompt', async () => {
    mockChat.mockResolvedValue({
      content: '{"score": 0.8, "count": 5}',
      inputTokens: 150,
      outputTokens: 15,
      model: 'claude-haiku-4-5',
    });

    const schema = {
      type: 'object',
      properties: {
        score: { type: 'number' },
        count: { type: 'number' },
      },
      required: ['score', 'count'],
    };

    const input = makeInput({
      config: {
        tag: 'schema_test',
        systemPrompt: 'You are an evaluator.',
        userPrompt: 'Evaluate this.',
        outputSchema: schema,
      },
    });

    const result = await execute(ctx(), input);

    expect(result.status).toBe('success');
    const chatCall = mockChat.mock.calls[0][0];
    const sysMsg = chatCall.messages[0].content;
    expect(sysMsg).toContain('You are an evaluator.');
    expect(sysMsg).toContain('"score"');
    expect(sysMsg).toContain('You MUST respond with valid JSON');
  });

  test('strict mode retries on invalid JSON', async () => {
    mockChat
      .mockResolvedValueOnce({
        content: 'not json at all',
        inputTokens: 50,
        outputTokens: 10,
        model: 'claude-haiku-4-5',
      })
      .mockResolvedValueOnce({
        content: '{"score": 0.7}',
        inputTokens: 80,
        outputTokens: 15,
        model: 'claude-haiku-4-5',
      });

    const input = makeInput({
      config: {
        tag: 'strict_json_test',
        systemPrompt: 'Evaluate.',
        userPrompt: 'Check this.',
        outputSchema: {
          type: 'object',
          properties: { score: { type: 'number' } },
        },
        strict: true,
      },
    });

    const result = await execute(ctx(), input);

    expect(result.status).toBe('success');
    expect(result.data.score).toBe(0.7);
    expect(mockChat).toHaveBeenCalledTimes(2);
    // Second call should contain error feedback
    const retryCall = mockChat.mock.calls[1][0];
    const lastMsg = retryCall.messages[retryCall.messages.length - 1];
    expect(lastMsg.content).toContain('not valid JSON');
  });

  test('strict mode retries on schema validation failure', async () => {
    mockChat
      .mockResolvedValueOnce({
        content: '{"wrong_field": true}',
        inputTokens: 50,
        outputTokens: 10,
        model: 'claude-haiku-4-5',
      })
      .mockResolvedValueOnce({
        content: '{"score": 0.6, "count": 3}',
        inputTokens: 80,
        outputTokens: 15,
        model: 'claude-haiku-4-5',
      });

    const input = makeInput({
      config: {
        tag: 'strict_schema_test',
        systemPrompt: 'Evaluate.',
        userPrompt: 'Check this.',
        outputSchema: {
          type: 'object',
          properties: {
            score: { type: 'number' },
            count: { type: 'number' },
          },
          required: ['score', 'count'],
        },
        strict: true,
      },
    });

    const result = await execute(ctx(), input);

    expect(result.status).toBe('success');
    expect(result.data.score).toBe(0.6);
    expect(mockChat).toHaveBeenCalledTimes(2);
    const retryCall = mockChat.mock.calls[1][0];
    const lastMsg = retryCall.messages[retryCall.messages.length - 1];
    expect(lastMsg.content).toContain('did not match the required schema');
  });

  test('strict mode gives up after max retries', async () => {
    mockChat.mockResolvedValue({
      content: 'always invalid',
      inputTokens: 50,
      outputTokens: 10,
      model: 'claude-haiku-4-5',
    });

    const input = makeInput({
      config: {
        tag: 'strict_giveup',
        systemPrompt: 'Evaluate.',
        userPrompt: 'Check this.',
        outputSchema: {
          type: 'object',
          properties: { score: { type: 'number' } },
        },
        strict: true,
      },
    });

    const result = await execute(ctx(), input);

    expect(result.status).toBe('fail');
    expect(mockChat).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  test('non-strict mode does not retry on schema mismatch', async () => {
    mockChat.mockResolvedValue({
      content: '{"wrong": true}',
      inputTokens: 50,
      outputTokens: 10,
      model: 'claude-haiku-4-5',
    });

    const input = makeInput({
      config: {
        tag: 'nonstrict_test',
        systemPrompt: 'Evaluate.',
        userPrompt: 'Check this.',
        outputSchema: {
          type: 'object',
          properties: { score: { type: 'number' } },
          required: ['score'],
        },
        strict: false,
      },
    });

    const result = await execute(ctx(), input);

    expect(result.status).toBe('success');
    expect(mockChat).toHaveBeenCalledTimes(1); // no retry
    expect(result.data.score).toBeNull(); // score field missing
  });

  test('skips ClickHouse write when tag is absent (call-llm compat mode)', async () => {
    mockChat.mockResolvedValue({
      content: '{"result": "ok"}',
      inputTokens: 50,
      outputTokens: 10,
      model: 'claude-haiku-4-5',
    });

    const input = makeInput({
      config: {
        systemPrompt: 'Summarize.',
        userPrompt: 'Do it.',
        // no tag
      },
    });

    const result = await execute(ctx(), input);

    expect(result.status).toBe('success');
    expect(result.data.parsed).toEqual({ result: 'ok' });
    expect(mockInsert).not.toHaveBeenCalled(); // no storage
  });

  test('fails when no userPrompt is provided', async () => {
    const input = makeInput({
      config: {
        tag: 'no_prompt',
        systemPrompt: 'Evaluate.',
      },
    });

    const result = await execute(ctx(), input);
    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('userPrompt');
  });

  test('logs warning for score outside 0-1 range', async () => {
    mockChat.mockResolvedValue({
      content: '{"score": 85}',
      inputTokens: 50,
      outputTokens: 10,
      model: 'claude-haiku-4-5',
    });

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    expect(result.data.score).toBe(85); // stored as-is, not clamped
  });

  test('fails gracefully on LLM error', async () => {
    mockChat.mockRejectedValue(new Error('Rate limit exceeded'));

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('Rate limit exceeded');
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/pipeline-engine && pnpm vitest run src/__tests__/llm-evaluate.test.ts`
Expected: FAIL — module `../pipeline/services/llm-evaluate.service.js` not found

- [ ] **Step 3: Commit the failing test**

```bash
npx prettier --write packages/pipeline-engine/src/__tests__/llm-evaluate.test.ts
git add packages/pipeline-engine/src/__tests__/llm-evaluate.test.ts
git commit -m "test(pipeline-engine): add llm-evaluate service test suite (red)"
```

---

### Task 4: Implement `llm-evaluate` service

**Files:**

- Create: `packages/pipeline-engine/src/pipeline/services/llm-evaluate.service.ts`
- Delete: `packages/pipeline-engine/src/pipeline/services/call-llm.service.ts`

- [ ] **Step 1: Create the llm-evaluate service**

Create `packages/pipeline-engine/src/pipeline/services/llm-evaluate.service.ts`:

````typescript
/**
 * LLMEvaluate — Restate activity service for tag-driven LLM evaluations.
 *
 * Replaces the former call-llm service. When `tag` is present in config,
 * results are persisted to the `llm_evaluate` ClickHouse table. When tag
 * is absent (backward-compat call-llm alias), behaves as a pure LLM call
 * with no storage.
 *
 * Config:
 *   tag:             Evaluation tag identifier (required for storage)
 *   systemPrompt:    System instructions
 *   userPrompt:      User prompt — {{...}} templates are auto-resolved
 *   outputSchema?:   JSON schema for expected output (injected into system prompt)
 *   strict?:         Retry on schema/parse failure (max 2 retries)
 *   scoreField?:     Output field to extract as score (default: "score")
 *   model?:          LLM model override
 *   temperature?:    LLM temperature (default: 0)
 *   maxTokens?:      Max output tokens (default: 1024)
 */
import * as restate from '@restatedev/restate-sdk';
import { createLogger } from '@abl/compiler/platform';
import { resolveExpression } from '../expression-evaluator.js';
import { createPipelineLLMClient } from './llm-client-factory.js';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import type { PipelineChatMessage } from './llm-client-factory.js';
import type { PipelineStepContext, StepOutput } from '../types.js';
import Ajv from 'ajv';

const log = createLogger('llm-evaluate');

const MAX_STRICT_RETRIES = 2;
const DATABASE = 'abl_platform';

// ---------------------------------------------------------------------------
// Template resolution
// ---------------------------------------------------------------------------

const TEMPLATE_PLACEHOLDER_RE = /\{\{([^}]+)\}\}/g;

function resolveTemplate(
  template: string,
  previousSteps: Record<string, StepOutput>,
  pipelineInput: Record<string, unknown>,
): string {
  return template.replace(TEMPLATE_PLACEHOLDER_RE, (_match, path: string) => {
    const trimmedPath = path.trim();
    const value = resolveExpression(trimmedPath, previousSteps, pipelineInput);
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  });
}

function hasTemplatePlaceholders(text: string): boolean {
  return TEMPLATE_PLACEHOLDER_RE.test(text);
}

// ---------------------------------------------------------------------------
// ClickHouse helpers
// ---------------------------------------------------------------------------

function toCHDateTime(d: Date | string): string {
  const iso = typeof d === 'string' ? new Date(d).toISOString() : d.toISOString();
  return iso.replace('T', ' ').replace('Z', '');
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

const ajv = new Ajv({ allErrors: true, strict: false });

function validateAgainstSchema(data: unknown, schema: Record<string, unknown>): string[] {
  const validate = ajv.compile(schema);
  const valid = validate(data);
  if (valid) return [];
  return (validate.errors ?? []).map((e) => `${e.instancePath || '/'}: ${e.message}`);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const llmEvaluateService = restate.service({
  name: 'LLMEvaluate',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();

      // --- Extract config ---
      const tag = input.config.tag as string | undefined;
      const systemPrompt = input.config.systemPrompt as string | undefined;
      const userPrompt =
        ((input.config.userPrompt ?? input.config.userPromptTemplate) as string) | undefined;
      const outputSchema = input.config.outputSchema as Record<string, unknown> | undefined;
      const strict = (input.config.strict as boolean) ?? false;
      const scoreField = (input.config.scoreField as string) ?? 'score';
      const model = input.config.model as string | undefined;
      const temperature = input.config.temperature as number | undefined;
      const maxTokens = input.config.maxTokens as number | undefined;

      // backward-compat: call-llm alias may use responseFormat
      const responseFormat = (input.config.responseFormat as 'json' | 'text') ?? 'json';

      try {
        // --- Validate required fields ---
        if (!userPrompt) {
          return {
            status: 'fail',
            data: {
              error: 'LLMEvaluate requires userPrompt (or userPromptTemplate) in config',
            },
            durationMs: Date.now() - startTime,
          };
        }

        // --- Resolve user prompt templates ---
        let resolvedUserPrompt = userPrompt;
        // Reset regex lastIndex since it's global
        TEMPLATE_PLACEHOLDER_RE.lastIndex = 0;
        if (hasTemplatePlaceholders(userPrompt)) {
          TEMPLATE_PLACEHOLDER_RE.lastIndex = 0;
          resolvedUserPrompt = resolveTemplate(
            userPrompt,
            input.previousSteps,
            input.pipelineInput,
          );
        }

        // --- Build system prompt (inject schema if provided) ---
        let finalSystemPrompt = systemPrompt ?? '';
        if (outputSchema) {
          finalSystemPrompt +=
            '\n\nYou MUST respond with valid JSON matching this schema:\n```json\n' +
            JSON.stringify(outputSchema, null, 2) +
            '\n```';
        }

        // --- Build initial messages ---
        const messages: PipelineChatMessage[] = [];
        if (finalSystemPrompt) {
          messages.push({ role: 'system', content: finalSystemPrompt });
        }
        messages.push({ role: 'user', content: resolvedUserPrompt });

        log.debug('LLMEvaluate executing', {
          tenantId: input.tenantId,
          tag,
          hasSchema: !!outputSchema,
          strict,
        });

        // --- LLM call with strict retry loop ---
        let parsed: Record<string, unknown> | null = null;
        let raw = '';
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let usedModel = '';
        let attempt = 0;

        while (attempt <= MAX_STRICT_RETRIES) {
          const llmResult = await ctx.run(`llm-evaluate-attempt-${attempt}`, async () => {
            const client = await createPipelineLLMClient(input.tenantId, input.projectId);
            return client.chat({
              messages: [...messages],
              model,
              temperature,
              maxTokens,
              responseFormat: tag ? 'json' : responseFormat,
            });
          });

          raw = llmResult.content;
          totalInputTokens += llmResult.inputTokens;
          totalOutputTokens += llmResult.outputTokens;
          usedModel = llmResult.model;

          // Step A: Parse JSON
          try {
            parsed = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            if (strict && attempt < MAX_STRICT_RETRIES) {
              messages.push({ role: 'assistant', content: raw });
              messages.push({
                role: 'user',
                content: 'Your response was not valid JSON. Please respond with valid JSON only.',
              });
              attempt++;
              continue;
            }
            // Non-strict or max retries: fail
            if (tag) {
              return {
                status: 'fail',
                data: { error: 'LLM response was not valid JSON', raw },
                durationMs: Date.now() - startTime,
              };
            }
            // call-llm compat: return raw
            parsed = null;
            break;
          }

          // Step B: Validate against schema
          if (outputSchema && parsed) {
            const errors = validateAgainstSchema(parsed, outputSchema);
            if (errors.length > 0 && strict && attempt < MAX_STRICT_RETRIES) {
              messages.push({ role: 'assistant', content: raw });
              messages.push({
                role: 'user',
                content:
                  'Your response did not match the required schema.\n' +
                  'Validation errors:\n' +
                  errors.map((e) => `- ${e}`).join('\n') +
                  '\n\nPlease respond again with valid JSON matching the schema.',
              });
              attempt++;
              continue;
            }
            // Non-strict or valid: continue with whatever we have
          }

          break; // valid or not strict or max retries
        }

        // --- Extract score ---
        let score: number | null = null;
        if (parsed && scoreField in parsed) {
          const val = parsed[scoreField];
          if (typeof val === 'number' && !isNaN(val)) {
            score = val;
            if (score < 0 || score > 1) {
              log.warn('Score outside 0-1 range', {
                tenantId: input.tenantId,
                tag,
                score,
                scoreField,
              });
            }
          }
        }

        // --- Write to ClickHouse (only when tag is present) ---
        if (tag && parsed) {
          const metadata = (input.pipelineInput.metadata ?? {}) as Record<string, unknown>;
          const row = {
            tenant_id: input.tenantId,
            project_id: input.projectId ?? '',
            session_id: input.sessionId ?? (input.pipelineInput.sessionId as string) ?? '',
            session_started_at: toCHDateTime(new Date()),
            tag,
            score,
            output: JSON.stringify(parsed),
            agent_name: (metadata.agentName as string) ?? '',
            channel: (metadata.channel as string) ?? '',
            model_id: usedModel,
            input_tokens: totalInputTokens,
            output_tokens: totalOutputTokens,
            processing_ms: Date.now() - startTime,
            pipeline_id: input.pipelineId ?? '',
            pipeline_type: input.pipelineType ?? '',
            source: (input.pipelineInput.executionMode as string) ?? 'batch',
            config_version: Number(input.config.configVersion) || 1,
            processed_at: toCHDateTime(new Date()),
          };

          await ctx.run('store-llm-evaluate', async () => {
            const client = getClickHouseClient();
            await client.insert({
              table: `${DATABASE}.llm_evaluate`,
              values: [row],
              format: 'JSONEachRow',
            });
          });

          log.debug('LLM evaluation stored', {
            tenantId: input.tenantId,
            tag,
            score,
          });
        }

        // --- Return ---
        return {
          status: 'success',
          data: {
            tag,
            score,
            ...(parsed ?? {}),
            parsed: parsed ?? undefined,
            raw,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            model: usedModel,
          },
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error('LLMEvaluate failed', {
          tenantId: input.tenantId,
          tag,
          error: msg,
        });
        return {
          status: 'fail',
          data: { error: msg },
          durationMs: Date.now() - startTime,
        };
      }
    },
  },
});

export type LLMEvaluateService = typeof llmEvaluateService;
````

- [ ] **Step 2: Check if `ajv` is already a dependency, install if not**

Run: `grep '"ajv"' packages/pipeline-engine/package.json`

If not found:
Run: `cd packages/pipeline-engine && pnpm add ajv`

- [ ] **Step 3: Delete old call-llm.service.ts**

Run: `rm packages/pipeline-engine/src/pipeline/services/call-llm.service.ts`

- [ ] **Step 4: Delete old call-llm.test.ts**

Run: `rm packages/pipeline-engine/src/__tests__/call-llm.test.ts`

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/pipeline-engine && pnpm vitest run src/__tests__/llm-evaluate.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/pipeline-engine/src/pipeline/services/llm-evaluate.service.ts
git add packages/pipeline-engine/src/pipeline/services/llm-evaluate.service.ts
git add packages/pipeline-engine/src/__tests__/llm-evaluate.test.ts
git add -u packages/pipeline-engine/src/pipeline/services/call-llm.service.ts
git add -u packages/pipeline-engine/src/__tests__/call-llm.test.ts
git commit -m "feat(pipeline-engine): implement llm-evaluate service with tag storage and strict retry"
```

---

### Task 5: Update activity metadata

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/activity-metadata.ts:279-321`

- [ ] **Step 1: Replace the `call-llm` metadata entry with `llm-evaluate`**

Replace lines 279-321 (the entire `'call-llm': { ... },` block) with:

```typescript
  'llm-evaluate': {
    name: 'LLM Evaluate',
    description:
      'LLM-powered evaluation with structured output, tagging, and auto-storage',
    configSchema: {
      required: ['tag', 'systemPrompt', 'userPrompt'],
      properties: {
        tag: {
          type: 'string',
          description:
            'Evaluation identifier (e.g. "extraction_quality"). Results are stored and queryable by this tag.',
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
          description:
            'User prompt — supports {{context.conversation}} and {{steps.stepId.output.field}} template variables',
          label: 'User Prompt',
          placeholder:
            'Analyze this conversation:\n\n{{steps.read-conversation.output.transcript}}',
          multiline: true,
        },
        outputSchema: {
          type: 'object',
          description:
            'Optional JSON schema defining expected LLM output structure. Injected into system prompt to guide the LLM. Without a schema, the output is stored as-is with no validation.',
          label: 'Output Schema',
          group: 'schema',
        },
        strict: {
          type: 'boolean',
          description:
            'When enabled, retries LLM call with validation errors if output does not match schema (max 2 retries). Requires Output Schema to be defined.',
          label: 'Strict Schema Validation',
          group: 'schema',
        },
        scoreField: {
          type: 'string',
          description:
            'Output field to use as the numeric score (default: "score")',
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
        tag: { type: 'string', description: 'The evaluation tag' },
        score: {
          type: 'number',
          description: 'Extracted numeric score, null if not found',
        },
        output: {
          type: 'object',
          description: 'Full parsed JSON output from LLM',
        },
        raw: { type: 'string', description: 'Raw text response' },
        inputTokens: { type: 'number', description: 'Input token count' },
        outputTokens: { type: 'number', description: 'Output token count' },
        model: { type: 'string', description: 'Model used' },
      },
    },
    defaultTimeout: 60_000,
    defaultRetries: 2,
  },

  // Backward-compat alias: existing pipelines using 'call-llm' get the same metadata
  'call-llm': {
    name: 'Call LLM',
    description:
      'LLM call with prompt templates (alias for llm-evaluate, tag optional)',
    configSchema: {
      required: [],
      properties: {
        systemPrompt: { type: 'string', description: 'System instructions for the LLM' },
        userPrompt: { type: 'string', description: 'Static user prompt text' },
        userPromptTemplate: {
          type: 'string',
          description: 'Template with {{steps.stepId.output.field}} placeholders',
        },
        tag: {
          type: 'string',
          description: 'Optional evaluation tag — when set, results are stored to ClickHouse',
        },
        model: {
          type: 'string',
          description: 'LLM model override (default: claude-haiku-4-5)',
        },
        temperature: { type: 'number', description: 'LLM temperature (default: 0)' },
        maxTokens: { type: 'number', description: 'Max output tokens (default: 1024)' },
        responseFormat: {
          type: 'string',
          description: "'json' | 'text' (default: 'json')",
        },
      },
    },
    outputSchema: {
      properties: {
        parsed: {
          type: 'object',
          description: 'Parsed JSON response (if responseFormat=json)',
        },
        raw: { type: 'string', description: 'Raw text response' },
        inputTokens: { type: 'number', description: 'Input token count' },
        outputTokens: { type: 'number', description: 'Output token count' },
        model: { type: 'string', description: 'Model used' },
      },
    },
    defaultTimeout: 60_000,
    defaultRetries: 2,
  },
```

- [ ] **Step 2: Build to verify**

Run: `pnpm build --filter=@agent-platform/pipeline-engine`
Expected: Clean build

- [ ] **Step 3: Commit**

```bash
npx prettier --write packages/pipeline-engine/src/pipeline/activity-metadata.ts
git add packages/pipeline-engine/src/pipeline/activity-metadata.ts
git commit -m "feat(pipeline-engine): replace call-llm metadata with llm-evaluate, keep alias"
```

---

### Task 6: Update activity router

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts:29,82`

- [ ] **Step 1: Update import statement**

Replace line 29:

```typescript
import { callLLMService } from '../services/call-llm.service.js';
```

with:

```typescript
import { llmEvaluateService } from '../services/llm-evaluate.service.js';
```

- [ ] **Step 2: Update SERVICE_HANDLERS entry**

Replace line 82:

```typescript
  'call-llm': (callLLMService as any).service.execute,
```

with:

```typescript
  'llm-evaluate': (llmEvaluateService as any).service.execute,
  'call-llm': (llmEvaluateService as any).service.execute,
```

- [ ] **Step 3: Build to verify**

Run: `pnpm build --filter=@agent-platform/pipeline-engine`
Expected: Clean build

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts
git add packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts
git commit -m "feat(pipeline-engine): route llm-evaluate and call-llm alias to LLMEvaluate service"
```

---

### Task 7: Update server bindings

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/server.ts:41,287`

- [ ] **Step 1: Update import**

Replace line 41:

```typescript
import { callLLMService } from './services/call-llm.service.js';
```

with:

```typescript
import { llmEvaluateService } from './services/llm-evaluate.service.js';
```

- [ ] **Step 2: Update Restate binding**

Replace line 287:

```typescript
    .bind(callLLMService)
```

with:

```typescript
    .bind(llmEvaluateService)
```

- [ ] **Step 3: Build full pipeline-engine package**

Run: `pnpm build --filter=@agent-platform/pipeline-engine`
Expected: Clean build

- [ ] **Step 4: Run all pipeline-engine tests**

Run: `cd packages/pipeline-engine && pnpm vitest run`
Expected: All tests pass (including llm-evaluate tests)

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/pipeline-engine/src/pipeline/server.ts
git add packages/pipeline-engine/src/pipeline/server.ts
git commit -m "feat(pipeline-engine): bind llmEvaluateService in Restate server"
```

---

## Chunk 2: Runtime API

### Task 8: Add EvaluationTagConfig Mongoose model

**Files:**

- Create: `apps/runtime/src/models/EvaluationTagConfig.ts`

- [ ] **Step 1: Create the model file**

```typescript
import mongoose, { Schema, Document } from 'mongoose';

export interface IEvaluationTagConfig extends Document {
  tenantId: string;
  projectId: string;
  tag: string;
  direction: 'higher_is_better' | 'lower_is_better';
  threshold: number;
  displayName?: string;
  description?: string;
}

const evaluationTagConfigSchema = new Schema<IEvaluationTagConfig>(
  {
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    tag: { type: String, required: true },
    direction: {
      type: String,
      enum: ['higher_is_better', 'lower_is_better'],
      default: 'higher_is_better',
    },
    threshold: { type: Number, required: true },
    displayName: { type: String },
    description: { type: String },
  },
  { timestamps: true },
);

evaluationTagConfigSchema.index({ tenantId: 1, projectId: 1, tag: 1 }, { unique: true });

export const EvaluationTagConfig = mongoose.model<IEvaluationTagConfig>(
  'EvaluationTagConfig',
  evaluationTagConfigSchema,
);
```

- [ ] **Step 2: Build to verify**

Run: `pnpm build --filter=runtime`
Expected: Clean build

- [ ] **Step 3: Commit**

```bash
npx prettier --write apps/runtime/src/models/EvaluationTagConfig.ts
git add apps/runtime/src/models/EvaluationTagConfig.ts
git commit -m "feat(runtime): add EvaluationTagConfig Mongoose model for per-tag thresholds"
```

---

### Task 9: Add evaluation-tags routes

**Files:**

- Create: `apps/runtime/src/routes/evaluation-tags.ts`

Look at an existing route file in `apps/runtime/src/routes/` for the middleware pattern (e.g., `requireAuth`, `requireProjectPermission`). Follow the same pattern.

- [ ] **Step 1: Create the route file**

```typescript
import { Router } from 'express';
import { EvaluationTagConfig } from '../models/EvaluationTagConfig.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('evaluation-tags');
const router = Router({ mergeParams: true });

// GET /api/projects/:projectId/evaluation-tags
router.get('/', async (req, res) => {
  try {
    const { tenantId } = req as any;
    const { projectId } = req.params;

    const configs = await EvaluationTagConfig.find({ tenantId, projectId }, { __v: 0 }).lean();

    res.json({ success: true, data: configs });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error('Failed to list evaluation tag configs', { error: msg });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: msg },
    });
  }
});

// PUT /api/projects/:projectId/evaluation-tags/:tag
router.put('/:tag', async (req, res) => {
  try {
    const { tenantId } = req as any;
    const { projectId, tag } = req.params;
    const { direction, threshold, displayName, description } = req.body;

    if (threshold == null || typeof threshold !== 'number') {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_INPUT', message: 'threshold is required and must be a number' },
      });
      return;
    }

    const config = await EvaluationTagConfig.findOneAndUpdate(
      { tenantId, projectId, tag },
      {
        tenantId,
        projectId,
        tag,
        direction: direction ?? 'higher_is_better',
        threshold,
        displayName,
        description,
      },
      { upsert: true, new: true, runValidators: true },
    ).lean();

    res.json({ success: true, data: config });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error('Failed to upsert evaluation tag config', { error: msg });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: msg },
    });
  }
});

export default router;
```

- [ ] **Step 2: Register the route in the main router**

Find the file where project-scoped routes are mounted (search for `pipeline-analytics` mount point). Add:

```typescript
import evaluationTagsRouter from './evaluation-tags.js';
// Mount alongside other project routes:
router.use('/api/projects/:projectId/evaluation-tags', evaluationTagsRouter);
```

- [ ] **Step 3: Build to verify**

Run: `pnpm build --filter=runtime`
Expected: Clean build

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/runtime/src/routes/evaluation-tags.ts
git add apps/runtime/src/routes/evaluation-tags.ts
git commit -m "feat(runtime): add evaluation-tags CRUD routes for per-tag threshold config"
```

---

### Task 10: Update pipeline-analytics routes

**Files:**

- Modify: `apps/runtime/src/routes/pipeline-analytics.ts:59-83`

- [ ] **Step 1: Add `llm_evaluate` to valid types and table maps**

Add `'llm_evaluate'` to the `VALID_PIPELINE_TYPES` set (after line 69):

```typescript
  'llm_evaluate',
```

Add to `PIPELINE_TABLES` (after line 82):

```typescript
  llm_evaluate: 'abl_platform.llm_evaluate',
```

Add to `PIPELINE_MV_TABLES` (after line 88):

```typescript
  llm_evaluate: 'abl_platform.mv_daily_llm_evaluate',
```

- [ ] **Step 2: Verify the summary handler works with the new type**

The existing summary handler uses `PIPELINE_TABLES[pipelineType]` for queries. The `llm_evaluate` table has `score` as a `Nullable(Float32)` — verify the summary handler's SQL correctly handles NULL scores (it should, since it uses `avg()` which ignores NULLs).

If the summary handler constructs column-specific SQL (e.g., referencing `overall_score`), add a mapping for `llm_evaluate` that uses `score` instead. Read the handler to check.

- [ ] **Step 3: Build to verify**

Run: `pnpm build --filter=runtime`
Expected: Clean build

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/runtime/src/routes/pipeline-analytics.ts
git add apps/runtime/src/routes/pipeline-analytics.ts
git commit -m "feat(runtime): add llm_evaluate to pipeline analytics valid types and table maps"
```

---

## Chunk 3: Studio UI

### Task 11: Add multiline textarea support to ConfigSchemaForm

**Files:**

- Modify: `apps/studio/src/components/pipelines/ConfigSchemaForm.tsx:248-262`

- [ ] **Step 1: Add multiline check before the string input rendering**

Replace lines 248-262 (the `if (field.type === 'string')` block) with:

```tsx
// ── String: multiline → textarea ──
if (field.type === 'string' && (field as any).multiline) {
  return (
    <FieldWrapper label={label} description={field.description} required={field.required}>
      <textarea
        className="flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        value={String(currentValue ?? '')}
        onChange={(e) => onChange(field.name, e.target.value)}
        disabled={disabled}
        rows={6}
        placeholder={
          field.placeholder || (field.default != null ? `Default: ${field.default}` : undefined)
        }
      />
    </FieldWrapper>
  );
}

// ── String → text Input ──
if (field.type === 'string') {
  return (
    <FieldWrapper label={label} description={field.description} required={field.required}>
      <Input
        type="text"
        value={String(currentValue ?? '')}
        onChange={(e) => onChange(field.name, e.target.value)}
        disabled={disabled}
        placeholder={
          field.placeholder || (field.default != null ? `Default: ${field.default}` : undefined)
        }
      />
    </FieldWrapper>
  );
}
```

Note: `(field as any).multiline` is used because the Studio's local `ConfigField` type may not have `multiline` yet. If Studio imports `ConfigField` from `@agent-platform/pipeline-engine`, the type will be available after Task 1. If it has its own copy, add `multiline?: boolean` there too.

- [ ] **Step 2: Build to verify**

Run: `pnpm build --filter=studio`
Expected: Clean build

- [ ] **Step 3: Commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/ConfigSchemaForm.tsx
git add apps/studio/src/components/pipelines/ConfigSchemaForm.tsx
git commit -m "feat(studio): add multiline textarea rendering for string config fields"
```

---

## Chunk 4: Integration Verification

### Task 12: Full build and test

- [ ] **Step 1: Full monorepo build**

Run: `pnpm build`
Expected: All packages build successfully

- [ ] **Step 2: Run pipeline-engine tests**

Run: `cd packages/pipeline-engine && pnpm vitest run`
Expected: All tests pass

- [ ] **Step 3: Verify no other test suites break**

Run: `pnpm test --filter=@agent-platform/pipeline-engine`
Expected: All pass

- [ ] **Step 4: Verify runtime builds with new model and routes**

Run: `pnpm build --filter=runtime`
Expected: Clean build

- [ ] **Step 5: Verify Studio builds with UI change**

Run: `pnpm build --filter=studio`
Expected: Clean build

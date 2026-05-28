# Analytics Phase 2: Core Pipeline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the foundation infrastructure (Gaps 1-5, 11, 14) and implement the first 3 analytics pipelines (Sentiment, Intent Classification, LLM-as-Judge Quality) end-to-end — from data ingestion through processing to queryable API.

**Architecture:** New Restate activity services (`call-llm`, `read-conversation`) plug into the existing pipeline engine. Each pipeline writes to dedicated ClickHouse tables with materialized views. A new analytics API layer serves results to the frontend. Pipeline configuration is stored per-tenant in MongoDB.

**Tech Stack:** Restate SDK, ClickHouse (ReplacingMergeTree), MongoDB (pipeline_configs), Redis (analytics cache), EncryptionService (batch decrypt), SessionLLMClient (LLM calls)

**Reference Docs:**

- Gap analysis: `/abl-review/metrics/pipeline-engine-gap-analysis.md`
- Data readiness: `/abl-review/metrics/pipeline-input-data-readiness.md`
- Query catalog: `/abl-review/metrics/simple-query-vs-pipeline-analysis.md`
- Skill checklist: `.claude/skills/analytics-pipeline-development.md`

---

## Sprint Overview

| Sprint                                  | Tasks                                                                                                       | Delivers                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **S1: Foundation** (Tasks 1-7)          | ConversationReader, call-llm activity, outcome classification, batch decrypt, ClickHouse output tables, MVs | Engine can read conversations, call LLMs, store typed results |
| **S2: Sentiment Pipeline** (Tasks 8-11) | Sentiment activity, pipeline definition, analytics query API, Redis cache                                   | First pipeline running end-to-end, queryable                  |
| **S3: Intent Pipeline** (Tasks 12-14)   | Intent classification activity, pipeline definition, analytics API extension                                | Second pipeline, foundational dimension for cross-filtering   |
| **S4: Quality Pipeline** (Tasks 15-18)  | Quality evaluation activity, pipeline config API, backfill mechanism, pipeline definition                   | Third pipeline with customer-configurable rubrics             |

---

## Task 1: ConversationReader Service

Addresses **Gap 2** (CRITICAL) and **Gap 14** (batch decrypt).

**Files:**

- Create: `packages/pipeline-engine/src/pipeline/services/conversation-reader.ts`
- Create: `packages/pipeline-engine/src/__tests__/conversation-reader.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/pipeline-engine/src/__tests__/conversation-reader.test.ts
import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock ClickHouse client
const mockQuery = vi.fn();
vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: () => ({ query: mockQuery }),
}));

// Mock EncryptionService
const mockDecrypt = vi.fn();
vi.mock('@agent-platform/shared/services/encryption-service', () => ({
  getEncryptionService: () => ({
    decryptAndDecompressForTenant: mockDecrypt,
  }),
}));

const { ConversationReader } = await import('../pipeline/services/conversation-reader.js');

function makeMessageRows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    tenant_id: 'tenant-1',
    session_id: 'sess-1',
    message_id: `msg-${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `encrypted-content-${i}`,
    created_at: new Date(Date.now() + i * 1000).toISOString(),
    channel: 'web_chat',
    metadata: '{}',
  }));
}

function makeTraceRows() {
  return [
    {
      session_id: 'sess-1',
      event_type: 'tool_call',
      agent_name: 'BillingAgent',
      data: 'encrypted-tool-data',
      timestamp: new Date().toISOString(),
      duration_ms: 150,
      has_error: 0,
    },
    {
      session_id: 'sess-1',
      event_type: 'escalation',
      agent_name: 'BillingAgent',
      data: 'encrypted-escalation-data',
      timestamp: new Date().toISOString(),
      duration_ms: 0,
      has_error: 0,
    },
  ];
}

describe('ConversationReader', () => {
  let reader: InstanceType<typeof ConversationReader>;

  beforeEach(() => {
    mockQuery.mockReset();
    mockDecrypt.mockReset();
    reader = new ConversationReader();
  });

  test('reads and decrypts messages for a session', async () => {
    const rows = makeMessageRows(4);
    mockQuery.mockResolvedValueOnce({ json: async () => rows });
    mockDecrypt.mockImplementation((_data: string, _tenantId: string) =>
      Promise.resolve('decrypted content'),
    );

    const result = await reader.readSession('tenant-1', 'sess-1');

    expect(result.messages).toHaveLength(4);
    expect(result.messages[0].content).toBe('decrypted content');
    expect(result.messages[0].role).toBe('user');
    expect(mockDecrypt).toHaveBeenCalledTimes(4);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test('returns empty result for session with no messages', async () => {
    mockQuery.mockResolvedValueOnce({ json: async () => [] });

    const result = await reader.readSession('tenant-1', 'sess-empty');

    expect(result.messages).toHaveLength(0);
    expect(result.metadata.messageCount).toBe(0);
  });

  test('reads messages + traces when enrichWithTraces is true', async () => {
    const msgRows = makeMessageRows(2);
    const traceRows = makeTraceRows();

    mockQuery
      .mockResolvedValueOnce({ json: async () => msgRows })
      .mockResolvedValueOnce({ json: async () => traceRows });

    mockDecrypt.mockResolvedValue('decrypted content');

    const result = await reader.readSession('tenant-1', 'sess-1', {
      enrichWithTraces: true,
    });

    expect(result.messages).toHaveLength(2);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.escalations).toHaveLength(1);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  test('readBatch processes multiple sessions', async () => {
    mockQuery.mockResolvedValue({ json: async () => makeMessageRows(2) });
    mockDecrypt.mockResolvedValue('decrypted');

    const results = await reader.readBatch('tenant-1', ['sess-1', 'sess-2']);

    expect(results.size).toBe(2);
    expect(results.get('sess-1')).toBeDefined();
    expect(results.get('sess-2')).toBeDefined();
  });

  test('formats transcript as string', async () => {
    const rows = makeMessageRows(2);
    mockQuery.mockResolvedValueOnce({ json: async () => rows });
    mockDecrypt
      .mockResolvedValueOnce('Hello, I need help with my bill')
      .mockResolvedValueOnce('Sure, I can help you with that.');

    const result = await reader.readSession('tenant-1', 'sess-1');
    const transcript = reader.formatTranscript(result);

    expect(transcript).toContain('User: Hello, I need help with my bill');
    expect(transcript).toContain('Assistant: Sure, I can help you with that.');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/pipeline-engine && npx vitest run src/__tests__/conversation-reader.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// packages/pipeline-engine/src/pipeline/services/conversation-reader.ts
/**
 * ConversationReader — reads and decrypts conversation data from ClickHouse.
 *
 * Reconstructs full conversation transcripts from encrypted messages and traces.
 * Designed for batch pipeline processing with tenant-scoped encryption.
 */
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import { getEncryptionService } from '@agent-platform/shared/services/encryption-service';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('conversation-reader');

export interface ConversationMessage {
  messageId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: string;
  channel?: string;
  metadata?: Record<string, unknown>;
}

export interface ConversationToolCall {
  toolName: string;
  arguments: Record<string, unknown>;
  result: unknown;
  success: boolean;
  errorMessage?: string;
  timestamp: string;
  durationMs: number;
}

export interface ConversationEscalation {
  reason: string;
  severity: string;
  timestamp: string;
}

export interface ConversationData {
  tenantId: string;
  sessionId: string;
  messages: ConversationMessage[];
  toolCalls: ConversationToolCall[];
  escalations: ConversationEscalation[];
  metadata: {
    agentName?: string;
    channel?: string;
    messageCount: number;
    durationMs?: number;
  };
}

export interface ReadSessionOptions {
  enrichWithTraces?: boolean;
  roles?: string[];
}

export class ConversationReader {
  private readonly ch = getClickHouseClient();
  private readonly encryption = getEncryptionService();

  /**
   * Read and decrypt all messages for a single session.
   */
  async readSession(
    tenantId: string,
    sessionId: string,
    options: ReadSessionOptions = {},
  ): Promise<ConversationData> {
    const messages = await this.readMessages(tenantId, sessionId, options.roles);

    let toolCalls: ConversationToolCall[] = [];
    let escalations: ConversationEscalation[] = [];

    if (options.enrichWithTraces) {
      const traces = await this.readTraces(tenantId, sessionId);
      toolCalls = traces.toolCalls;
      escalations = traces.escalations;
    }

    const firstMsg = messages[0];

    return {
      tenantId,
      sessionId,
      messages,
      toolCalls,
      escalations,
      metadata: {
        agentName: undefined, // populated from traces if available
        channel: firstMsg?.channel,
        messageCount: messages.length,
      },
    };
  }

  /**
   * Read messages for multiple sessions in a single query, then decrypt per-session.
   */
  async readBatch(
    tenantId: string,
    sessionIds: string[],
    options: ReadSessionOptions = {},
  ): Promise<Map<string, ConversationData>> {
    if (sessionIds.length === 0) return new Map();

    const placeholders = sessionIds.map((id) => `'${id.replace(/'/g, "\\'")}'`).join(',');
    const query = `
      SELECT tenant_id, session_id, message_id, role, content, created_at, channel, metadata
      FROM abl_platform.messages
      WHERE tenant_id = {tenantId:String}
        AND session_id IN (${placeholders})
      ORDER BY session_id, created_at ASC
    `;

    const result = await this.ch.query({
      query,
      query_params: { tenantId },
    });
    const rows = (await result.json()) as any[];

    // Group by session
    const grouped = new Map<string, any[]>();
    for (const row of rows) {
      const sid = row.session_id;
      if (!grouped.has(sid)) grouped.set(sid, []);
      grouped.get(sid)!.push(row);
    }

    // Decrypt and build per-session
    const results = new Map<string, ConversationData>();
    for (const sessionId of sessionIds) {
      const sessionRows = grouped.get(sessionId) ?? [];
      const messages = await this.decryptMessages(tenantId, sessionRows);

      results.set(sessionId, {
        tenantId,
        sessionId,
        messages,
        toolCalls: [],
        escalations: [],
        metadata: {
          channel: messages[0]?.channel,
          messageCount: messages.length,
        },
      });
    }

    return results;
  }

  /**
   * Format a ConversationData as a human-readable transcript string.
   * Suitable for passing to an LLM as context.
   */
  formatTranscript(data: ConversationData): string {
    const lines: string[] = [];
    for (const msg of data.messages) {
      const role = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
      lines.push(`${role}: ${msg.content}`);
    }
    return lines.join('\n');
  }

  private async readMessages(
    tenantId: string,
    sessionId: string,
    roles?: string[],
  ): Promise<ConversationMessage[]> {
    let roleFilter = '';
    if (roles && roles.length > 0) {
      const roleList = roles.map((r) => `'${r}'`).join(',');
      roleFilter = `AND role IN (${roleList})`;
    }

    const query = `
      SELECT tenant_id, session_id, message_id, role, content, created_at, channel, metadata
      FROM abl_platform.messages
      WHERE tenant_id = {tenantId:String}
        AND session_id = {sessionId:String}
        ${roleFilter}
      ORDER BY created_at ASC
    `;

    const result = await this.ch.query({
      query,
      query_params: { tenantId, sessionId },
    });
    const rows = (await result.json()) as any[];

    return this.decryptMessages(tenantId, rows);
  }

  private async decryptMessages(tenantId: string, rows: any[]): Promise<ConversationMessage[]> {
    const messages: ConversationMessage[] = [];

    for (const row of rows) {
      let content = '';
      try {
        content = row.content
          ? await this.encryption.decryptAndDecompressForTenant(row.content, tenantId)
          : '';
      } catch (err) {
        log.warn('Failed to decrypt message', {
          messageId: row.message_id,
          error: err instanceof Error ? err.message : String(err),
        });
        content = '[decryption failed]';
      }

      messages.push({
        messageId: row.message_id,
        role: row.role,
        content,
        timestamp: row.created_at,
        channel: row.channel,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      });
    }

    return messages;
  }

  private async readTraces(
    tenantId: string,
    sessionId: string,
  ): Promise<{ toolCalls: ConversationToolCall[]; escalations: ConversationEscalation[] }> {
    const query = `
      SELECT event_type, agent_name, data, timestamp, duration_ms, has_error
      FROM abl_platform.traces
      WHERE tenant_id = {tenantId:String}
        AND session_id = {sessionId:String}
        AND event_type IN ('tool_call', 'escalation')
      ORDER BY timestamp ASC
    `;

    const result = await this.ch.query({
      query,
      query_params: { tenantId, sessionId },
    });
    const rows = (await result.json()) as any[];

    const toolCalls: ConversationToolCall[] = [];
    const escalations: ConversationEscalation[] = [];

    for (const row of rows) {
      let data: Record<string, any> = {};
      try {
        const decrypted = row.data
          ? await this.encryption.decryptAndDecompressForTenant(row.data, tenantId)
          : '{}';
        data = JSON.parse(decrypted);
      } catch {
        log.warn('Failed to decrypt trace data', { sessionId, eventType: row.event_type });
      }

      if (row.event_type === 'tool_call') {
        toolCalls.push({
          toolName: data.toolName ?? 'unknown',
          arguments: data.arguments ?? {},
          result: data.result,
          success: data.success ?? true,
          errorMessage: data.errorMessage,
          timestamp: row.timestamp,
          durationMs: row.duration_ms ?? 0,
        });
      } else if (row.event_type === 'escalation') {
        escalations.push({
          reason: data.reason ?? 'unknown',
          severity: data.severity ?? 'medium',
          timestamp: row.timestamp,
        });
      }
    }

    return { toolCalls, escalations };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm build && cd packages/pipeline-engine && npx vitest run src/__tests__/conversation-reader.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/pipeline-engine/src/pipeline/services/conversation-reader.ts packages/pipeline-engine/src/__tests__/conversation-reader.test.ts
git commit -m "feat(pipeline-engine): add ConversationReader service for batch transcript reconstruction

Reads encrypted messages from ClickHouse, decrypts per-tenant, reconstructs
ordered transcripts. Supports single session and batch reads. Optionally
enriches with trace data (tool calls, escalations).

Addresses Gap 2 (conversation reconstruction) and Gap 14 (batch decrypt)."
```

---

## Task 2: Heuristic Outcome Classification

Addresses **Gap 11**. Adds write-time outcome classification on session end.

**Files:**

- Modify: `packages/database/src/models/session.model.ts` (add `outcome` field)
- Modify: `apps/runtime/src/services/stores/clickhouse-trace-store.ts` (classify on session_end)
- Create: `packages/pipeline-engine/src/__tests__/outcome-classification.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/pipeline-engine/src/__tests__/outcome-classification.test.ts
import { describe, test, expect } from 'vitest';

// Import the pure classification function (no I/O)
const { classifyOutcome } = await import('../pipeline/services/outcome-classification.js');

describe('classifyOutcome', () => {
  test('contained: session completed without escalation', () => {
    expect(classifyOutcome({ status: 'completed', hasEscalation: false })).toBe('contained');
  });

  test('contained: session ended without escalation', () => {
    expect(classifyOutcome({ status: 'ended', hasEscalation: false })).toBe('contained');
  });

  test('escalated: session has escalation event', () => {
    expect(classifyOutcome({ status: 'completed', hasEscalation: true })).toBe('escalated');
    expect(classifyOutcome({ status: 'escalated', hasEscalation: false })).toBe('escalated');
  });

  test('abandoned: session timed out or user left', () => {
    expect(classifyOutcome({ status: 'abandoned', hasEscalation: false })).toBe('abandoned');
  });

  test('active: session still in progress', () => {
    expect(classifyOutcome({ status: 'active', hasEscalation: false })).toBe(null);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/pipeline-engine && npx vitest run src/__tests__/outcome-classification.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// packages/pipeline-engine/src/pipeline/services/outcome-classification.ts
/**
 * Heuristic outcome classification for sessions.
 *
 * Derives a normalized `outcome` field from session status and escalation events.
 * Pure function — no I/O, used at write time when session ends.
 *
 * Outcome values:
 *   contained  — session completed without human escalation
 *   escalated  — session had an escalation event or status is 'escalated'
 *   abandoned  — session ended by timeout, user exit, or inactivity
 *   null       — session still active (not yet classifiable)
 */

export type SessionOutcome = 'contained' | 'escalated' | 'abandoned';

export interface OutcomeInput {
  status: string;
  hasEscalation: boolean;
}

export function classifyOutcome(input: OutcomeInput): SessionOutcome | null {
  const { status, hasEscalation } = input;

  // Active sessions are not yet classifiable
  if (status === 'active' || status === 'idle') return null;

  // Escalation takes priority
  if (hasEscalation || status === 'escalated') return 'escalated';

  // Abandoned = timeout, user left, or explicit abandoned status
  if (status === 'abandoned') return 'abandoned';

  // Completed/ended without escalation = contained
  if (status === 'completed' || status === 'ended' || status === 'archived') return 'contained';

  return null;
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm build && cd packages/pipeline-engine && npx vitest run src/__tests__/outcome-classification.test.ts`
Expected: PASS

**Step 5: Add `outcome` field to Session model**

Modify `packages/database/src/models/session.model.ts` — add after the `dispositionCode` field (~line 107):

```typescript
  outcome: {
    type: String,
    enum: ['contained', 'escalated', 'abandoned', null],
    default: null,
    index: true,
  },
```

**Step 6: Commit**

```bash
git add packages/pipeline-engine/src/pipeline/services/outcome-classification.ts packages/pipeline-engine/src/__tests__/outcome-classification.test.ts packages/database/src/models/session.model.ts
git commit -m "feat(pipeline-engine): add heuristic outcome classification for sessions

Pure function: classifies session outcome as contained/escalated/abandoned
based on session status and escalation events. Adds outcome field to Session
model. Unlocks containment rate, deflection rate, and 12+ simple queries.

Addresses Gap 11."
```

---

## Task 3: ClickHouse Output Tables

Addresses **Gap 5**. Creates dedicated tables for sentiment, intent, and quality pipeline outputs.

**Files:**

- Create: `packages/pipeline-engine/src/pipeline/schemas/clickhouse-analytics-tables.sql`
- Modify: `scripts/clickhouse-init/01-init.sql` (add new tables)
- Create: `packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts`

**Step 1: Write the SQL schema**

```sql
-- packages/pipeline-engine/src/pipeline/schemas/clickhouse-analytics-tables.sql

-- =========================================================================
-- SENTIMENT: Per-message sentiment scores
-- =========================================================================
CREATE TABLE IF NOT EXISTS abl_platform.message_sentiment (
    tenant_id        String,
    session_id       String,
    message_id       String,

    message_at       DateTime64(3),
    processed_at     DateTime64(3),

    role             LowCardinality(String),
    agent_name       LowCardinality(String),
    channel          LowCardinality(String),

    sentiment_score  Float32,
    sentiment_label  LowCardinality(String),
    frustration_detected  UInt8,
    frustration_signals   Array(String),

    model_id         LowCardinality(String),
    config_version   UInt32,
    confidence       Float32,
    processing_ms    UInt32
)
ENGINE = ReplacingMergeTree(processed_at)
PARTITION BY (tenant_id, toYYYYMM(message_at))
ORDER BY (tenant_id, session_id, message_id)
TTL message_at + INTERVAL 730 DAY DELETE;

-- =========================================================================
-- SENTIMENT: Conversation-level aggregation
-- =========================================================================
CREATE TABLE IF NOT EXISTS abl_platform.conversation_sentiment (
    tenant_id        String,
    project_id       String,
    session_id       String,

    session_started_at  DateTime64(3),
    processed_at        DateTime64(3),

    agent_name       LowCardinality(String),
    channel          LowCardinality(String),

    avg_sentiment           Float32,
    start_sentiment         Float32,
    end_sentiment           Float32,
    min_sentiment           Float32,
    max_sentiment           Float32,
    sentiment_trajectory    LowCardinality(String),
    sentiment_shift_count   UInt16,

    frustration_turn_count  UInt16,
    frustration_detected    UInt8,

    pivot_count             UInt16,
    worst_pivot_at          Nullable(DateTime64(3)),
    worst_pivot_delta       Nullable(Float32),

    model_id         LowCardinality(String),
    config_version   UInt32,
    message_count    UInt16,
    processing_ms    UInt32
)
ENGINE = ReplacingMergeTree(processed_at)
PARTITION BY (tenant_id, toYYYYMM(session_started_at))
ORDER BY (tenant_id, project_id, session_id)
TTL session_started_at + INTERVAL 730 DAY DELETE;

-- =========================================================================
-- INTENT: Per-conversation intent classification
-- =========================================================================
CREATE TABLE IF NOT EXISTS abl_platform.intent_classifications (
    tenant_id        String,
    project_id       String,
    session_id       String,

    session_started_at  DateTime64(3),
    processed_at        DateTime64(3),

    agent_name       LowCardinality(String),
    channel          LowCardinality(String),

    intent           LowCardinality(String),
    intent_display   String,
    sub_intent       LowCardinality(String),
    confidence       Float32,
    secondary_intents Array(String),
    is_auto_discovered UInt8,

    model_id         LowCardinality(String),
    config_version   UInt32,
    taxonomy_version LowCardinality(String),
    processing_ms    UInt32,
    input_tokens     UInt32,
    output_tokens    UInt32
)
ENGINE = ReplacingMergeTree(processed_at)
PARTITION BY (tenant_id, toYYYYMM(session_started_at))
ORDER BY (tenant_id, project_id, session_id)
TTL session_started_at + INTERVAL 730 DAY DELETE;

-- =========================================================================
-- QUALITY: Per-conversation LLM-as-judge evaluation
-- =========================================================================
CREATE TABLE IF NOT EXISTS abl_platform.quality_evaluations (
    tenant_id        String,
    project_id       String,
    session_id       String,

    session_started_at  DateTime64(3),
    processed_at        DateTime64(3),

    agent_name       LowCardinality(String),
    agent_version    LowCardinality(String),
    channel          LowCardinality(String),

    overall_score    Float32,
    helpfulness      Float32,
    accuracy         Float32,
    professionalism  Float32,
    instruction_following Float32,

    custom_dimensions String,

    flagged          UInt8,
    flag_reasons     Array(String),
    reasoning        String,

    model_id         LowCardinality(String),
    config_version   UInt32,
    pipeline_version LowCardinality(String),
    confidence       Float32,
    processing_ms    UInt32,
    input_tokens     UInt32,
    output_tokens    UInt32
)
ENGINE = ReplacingMergeTree(processed_at)
PARTITION BY (tenant_id, toYYYYMM(session_started_at))
ORDER BY (tenant_id, project_id, session_id)
TTL session_started_at + INTERVAL 730 DAY DELETE;

-- =========================================================================
-- SKIP INDICES
-- =========================================================================
ALTER TABLE abl_platform.conversation_sentiment
    ADD INDEX IF NOT EXISTS idx_trajectory sentiment_trajectory TYPE set(10) GRANULARITY 4;

ALTER TABLE abl_platform.conversation_sentiment
    ADD INDEX IF NOT EXISTS idx_frustration frustration_detected TYPE set(2) GRANULARITY 4;

ALTER TABLE abl_platform.intent_classifications
    ADD INDEX IF NOT EXISTS idx_intent intent TYPE set(200) GRANULARITY 4;

ALTER TABLE abl_platform.quality_evaluations
    ADD INDEX IF NOT EXISTS idx_overall_score overall_score TYPE minmax GRANULARITY 4;

ALTER TABLE abl_platform.quality_evaluations
    ADD INDEX IF NOT EXISTS idx_flagged flagged TYPE set(2) GRANULARITY 4;
```

**Step 2: Write the TypeScript init function**

```typescript
// packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts
import { createLogger } from '@abl/compiler/platform';
import type { ClickHouseClient } from '@clickhouse/client';

const log = createLogger('analytics-tables-init');

const TABLES = [
  'message_sentiment',
  'conversation_sentiment',
  'intent_classifications',
  'quality_evaluations',
];

export async function initAnalyticsTables(client: ClickHouseClient): Promise<void> {
  // Read and execute the SQL file at startup
  const { readFileSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const sqlPath = resolve(__dirname, 'clickhouse-analytics-tables.sql');
  const sql = readFileSync(sqlPath, 'utf-8');

  // Split on semicolons (outside of strings) and execute each statement
  const statements = sql
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('--'));

  for (const stmt of statements) {
    try {
      await client.command({ query: stmt });
    } catch (err) {
      log.warn('Analytics table init statement failed (may already exist)', {
        error: err instanceof Error ? err.message : String(err),
        statement: stmt.slice(0, 100),
      });
    }
  }

  log.info('Analytics ClickHouse tables initialized', { tables: TABLES });
}
```

**Step 3: Wire into pipeline engine startup**

Modify `packages/pipeline-engine/src/pipeline/server.ts` — add after line 41 (`await initClickHouseSchema(chClient)`):

```typescript
import { initAnalyticsTables } from './schemas/init-analytics-tables.js';
// ... inside start():
await initAnalyticsTables(chClient);
console.log('Analytics tables initialized');
```

**Step 4: Commit**

```bash
git add packages/pipeline-engine/src/pipeline/schemas/clickhouse-analytics-tables.sql packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts packages/pipeline-engine/src/pipeline/server.ts
git commit -m "feat(pipeline-engine): add dedicated ClickHouse tables for analytics pipelines

Creates message_sentiment, conversation_sentiment, intent_classifications,
and quality_evaluations tables with ReplacingMergeTree for re-processing
support. Includes skip indices for common filter patterns.

Addresses Gap 5."
```

---

## Task 4: Materialized Views for Daily Aggregations

Addresses **Gap 6**.

**Files:**

- Create: `packages/pipeline-engine/src/pipeline/schemas/clickhouse-analytics-mvs.sql`
- Modify: `packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts` (add MV init)

**Step 1: Write the MV SQL**

```sql
-- packages/pipeline-engine/src/pipeline/schemas/clickhouse-analytics-mvs.sql

-- Daily sentiment aggregation
CREATE MATERIALIZED VIEW IF NOT EXISTS abl_platform.mv_daily_sentiment
ENGINE = SummingMergeTree()
PARTITION BY (tenant_id, toYYYYMM(date))
ORDER BY (tenant_id, project_id, date, agent_name)
TTL date + INTERVAL 730 DAY DELETE
AS SELECT
    tenant_id,
    project_id,
    toDate(session_started_at) AS date,
    agent_name,
    count() AS conversation_count,
    sum(avg_sentiment) AS total_sentiment,
    sum(CASE WHEN sentiment_trajectory = 'declining' THEN 1 ELSE 0 END) AS declining_count,
    sum(CASE WHEN frustration_detected = 1 THEN 1 ELSE 0 END) AS frustrated_count
FROM abl_platform.conversation_sentiment
GROUP BY tenant_id, project_id, date, agent_name;

-- Daily intent distribution
CREATE MATERIALIZED VIEW IF NOT EXISTS abl_platform.mv_daily_intent_distribution
ENGINE = SummingMergeTree()
PARTITION BY (tenant_id, toYYYYMM(date))
ORDER BY (tenant_id, project_id, date, intent)
TTL date + INTERVAL 730 DAY DELETE
AS SELECT
    tenant_id,
    project_id,
    toDate(session_started_at) AS date,
    intent,
    count() AS conversation_count,
    sum(confidence) AS total_confidence
FROM abl_platform.intent_classifications
GROUP BY tenant_id, project_id, date, intent;

-- Daily quality score aggregation
CREATE MATERIALIZED VIEW IF NOT EXISTS abl_platform.mv_daily_quality_scores
ENGINE = SummingMergeTree()
PARTITION BY (tenant_id, toYYYYMM(date))
ORDER BY (tenant_id, project_id, date, agent_name, channel)
TTL date + INTERVAL 730 DAY DELETE
AS SELECT
    tenant_id,
    project_id,
    toDate(session_started_at) AS date,
    agent_name,
    channel,
    count() AS conversation_count,
    sum(overall_score) AS total_score,
    sum(helpfulness) AS total_helpfulness,
    sum(accuracy) AS total_accuracy,
    sum(professionalism) AS total_professionalism,
    sum(CASE WHEN flagged = 1 THEN 1 ELSE 0 END) AS flagged_count
FROM abl_platform.quality_evaluations
GROUP BY tenant_id, project_id, date, agent_name, channel;
```

**Step 2: Update init to include MVs**

Modify `packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts` — add a second SQL file read for MVs after the tables init:

```typescript
// Also create materialized views
const mvSqlPath = resolve(__dirname, 'clickhouse-analytics-mvs.sql');
const mvSql = readFileSync(mvSqlPath, 'utf-8');
const mvStatements = mvSql
  .split(/;\s*$/m)
  .map((s) => s.trim())
  .filter((s) => s.length > 0 && !s.startsWith('--'));

for (const stmt of mvStatements) {
  try {
    await client.command({ query: stmt });
  } catch (err) {
    log.warn('Analytics MV init statement failed (may already exist)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

log.info('Analytics materialized views initialized');
```

**Step 3: Commit**

```bash
git add packages/pipeline-engine/src/pipeline/schemas/clickhouse-analytics-mvs.sql packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts
git commit -m "feat(pipeline-engine): add materialized views for daily analytics aggregations

Creates mv_daily_sentiment, mv_daily_intent_distribution, and
mv_daily_quality_scores using SummingMergeTree for fast dashboard queries.

Addresses Gap 6."
```

---

## Task 5: Pipeline Configuration Schema & Model

Addresses **Gap 4** (config storage part).

**Files:**

- Create: `packages/pipeline-engine/src/schemas/pipeline-config.schema.ts`
- Create: `packages/pipeline-engine/src/pipeline/services/pipeline-config.service.ts`
- Create: `packages/pipeline-engine/src/__tests__/pipeline-config.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/pipeline-engine/src/__tests__/pipeline-config.test.ts
import { describe, test, expect, vi, beforeEach } from 'vitest';

const mockFindOne = vi.fn();
const mockFindOneAndUpdate = vi.fn();
vi.mock('mongoose', () => {
  const model = {
    findOne: mockFindOne,
    findOneAndUpdate: mockFindOneAndUpdate,
  };
  return {
    default: {
      model: () => model,
      Schema: vi.fn().mockReturnValue({ index: vi.fn(), pre: vi.fn() }),
    },
  };
});

const { PipelineConfigService } = await import('../pipeline/services/pipeline-config.service.js');

describe('PipelineConfigService', () => {
  let service: InstanceType<typeof PipelineConfigService>;

  beforeEach(() => {
    mockFindOne.mockReset();
    mockFindOneAndUpdate.mockReset();
    service = new PipelineConfigService();
  });

  test('resolveConfig returns project config when it exists', async () => {
    const projectConfig = {
      tenantId: 't1',
      projectId: 'p1',
      pipelineType: 'sentiment_analysis',
      enabled: true,
      version: 2,
      config: { granularity: 'both' },
    };
    mockFindOne.mockResolvedValueOnce(projectConfig);

    const result = await service.resolveConfig('t1', 'sentiment_analysis', 'p1');

    expect(result).toEqual(projectConfig);
    expect(mockFindOne).toHaveBeenCalledWith({
      tenantId: 't1',
      pipelineType: 'sentiment_analysis',
      projectId: 'p1',
    });
  });

  test('resolveConfig falls back to tenant config when no project config', async () => {
    const tenantConfig = {
      tenantId: 't1',
      projectId: null,
      pipelineType: 'sentiment_analysis',
      enabled: true,
      version: 1,
      config: { granularity: 'conversation' },
    };
    mockFindOne
      .mockResolvedValueOnce(null) // no project config
      .mockResolvedValueOnce(tenantConfig); // tenant config

    const result = await service.resolveConfig('t1', 'sentiment_analysis', 'p1');

    expect(result).toEqual(tenantConfig);
    expect(mockFindOne).toHaveBeenCalledTimes(2);
  });

  test('resolveConfig returns null when no config exists', async () => {
    mockFindOne.mockResolvedValue(null);

    const result = await service.resolveConfig('t1', 'sentiment_analysis', 'p1');

    expect(result).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/pipeline-engine && npx vitest run src/__tests__/pipeline-config.test.ts`
Expected: FAIL — module not found

**Step 3: Write the MongoDB schema**

```typescript
// packages/pipeline-engine/src/schemas/pipeline-config.schema.ts
import mongoose, { type Document, Schema } from 'mongoose';

export type PipelineType =
  | 'sentiment_analysis'
  | 'intent_classification'
  | 'quality_evaluation'
  | 'anomaly_detection'
  | 'nl_to_sql'
  | 'knowledge_gap'
  | 'hallucination_detection'
  | 'embedding_drift'
  | 'predictive_ml'
  | 'simulation'
  | 'guardrail_analysis';

export interface ConfigChange {
  version: number;
  changedBy: string;
  changedAt: Date;
  diff: Record<string, { old: unknown; new: unknown }>;
  reprocessingRequired: boolean;
}

export interface IPipelineConfig extends Document {
  tenantId: string;
  projectId?: string | null;
  pipelineType: PipelineType;
  version: number;
  enabled: boolean;
  config: Record<string, unknown>;
  lastBackfillAt?: Date;
  backfillStatus?: 'idle' | 'running' | 'completed' | 'failed';
  lastProcessedAt?: Date;
  createdBy: string;
  updatedBy: string;
  configHistory?: ConfigChange[];
  createdAt: Date;
  updatedAt: Date;
}

const PipelineConfigSchema = new Schema<IPipelineConfig>(
  {
    tenantId: { type: String, required: true },
    projectId: { type: String, default: null },
    pipelineType: {
      type: String,
      required: true,
      enum: [
        'sentiment_analysis',
        'intent_classification',
        'quality_evaluation',
        'anomaly_detection',
        'nl_to_sql',
        'knowledge_gap',
        'hallucination_detection',
        'embedding_drift',
        'predictive_ml',
        'simulation',
        'guardrail_analysis',
      ],
    },
    version: { type: Number, default: 1 },
    enabled: { type: Boolean, default: false },
    config: { type: Schema.Types.Mixed, default: {} },
    lastBackfillAt: Date,
    backfillStatus: {
      type: String,
      enum: ['idle', 'running', 'completed', 'failed'],
      default: 'idle',
    },
    lastProcessedAt: Date,
    createdBy: { type: String, required: true },
    updatedBy: { type: String, required: true },
    configHistory: [
      {
        version: Number,
        changedBy: String,
        changedAt: Date,
        diff: Schema.Types.Mixed,
        reprocessingRequired: Boolean,
      },
    ],
  },
  { timestamps: true, collection: 'pipeline_configs' },
);

PipelineConfigSchema.index({ tenantId: 1, pipelineType: 1, projectId: 1 }, { unique: true });
PipelineConfigSchema.index({ tenantId: 1, enabled: 1 });

export const PipelineConfigModel = mongoose.model<IPipelineConfig>(
  'PipelineConfig',
  PipelineConfigSchema,
);
```

**Step 4: Write the config service**

```typescript
// packages/pipeline-engine/src/pipeline/services/pipeline-config.service.ts
import { createLogger } from '@abl/compiler/platform';
import {
  PipelineConfigModel,
  type IPipelineConfig,
  type PipelineType,
} from '../../schemas/pipeline-config.schema.js';

const log = createLogger('pipeline-config');

export class PipelineConfigService {
  /**
   * Resolve effective config: project-level > tenant-level > null.
   */
  async resolveConfig(
    tenantId: string,
    pipelineType: PipelineType,
    projectId?: string,
  ): Promise<IPipelineConfig | null> {
    // 1. Project-level config
    if (projectId) {
      const projectConfig = await PipelineConfigModel.findOne({
        tenantId,
        pipelineType,
        projectId,
      });
      if (projectConfig) return projectConfig;
    }

    // 2. Tenant-level config
    const tenantConfig = await PipelineConfigModel.findOne({
      tenantId,
      pipelineType,
      projectId: null,
    });

    return tenantConfig;
  }

  /**
   * Save or update pipeline config. Auto-increments version.
   */
  async saveConfig(
    tenantId: string,
    pipelineType: PipelineType,
    config: Record<string, unknown>,
    updatedBy: string,
    projectId?: string,
  ): Promise<IPipelineConfig> {
    const existing = await PipelineConfigModel.findOne({
      tenantId,
      pipelineType,
      projectId: projectId ?? null,
    });

    if (existing) {
      // Build diff for history
      const diff: Record<string, { old: unknown; new: unknown }> = {};
      for (const key of Object.keys(config)) {
        if (JSON.stringify(existing.config[key]) !== JSON.stringify(config[key])) {
          diff[key] = { old: existing.config[key], new: config[key] };
        }
      }

      const reprocessingRequired = this.requiresReprocessing(pipelineType, diff);

      existing.config = config;
      existing.version += 1;
      existing.updatedBy = updatedBy;

      // Append to history (keep last 20)
      if (!existing.configHistory) existing.configHistory = [];
      existing.configHistory.push({
        version: existing.version,
        changedBy: updatedBy,
        changedAt: new Date(),
        diff,
        reprocessingRequired,
      });
      if (existing.configHistory.length > 20) {
        existing.configHistory = existing.configHistory.slice(-20);
      }

      await existing.save();
      log.info('Pipeline config updated', {
        tenantId,
        pipelineType,
        version: existing.version,
        reprocessingRequired,
      });
      return existing;
    }

    // Create new
    const newConfig = await PipelineConfigModel.create({
      tenantId,
      projectId: projectId ?? null,
      pipelineType,
      version: 1,
      enabled: false,
      config,
      createdBy: updatedBy,
      updatedBy,
    });

    log.info('Pipeline config created', { tenantId, pipelineType });
    return newConfig;
  }

  /**
   * Determine if a config change requires re-processing historical data.
   */
  private requiresReprocessing(
    _pipelineType: PipelineType,
    diff: Record<string, { old: unknown; new: unknown }>,
  ): boolean {
    // These keys always require reprocessing when changed
    const reprocessKeys = new Set([
      'taxonomy',
      'dimensions',
      'model',
      'provider',
      'classificationPrompt',
      'evaluatorSystemPrompt',
      'granularity',
      'scale',
      'multiLabel',
    ]);

    return Object.keys(diff).some((key) => reprocessKeys.has(key));
  }
}
```

**Step 5: Export from schemas/index.ts**

Add to `packages/pipeline-engine/src/schemas/index.ts`:

```typescript
export {
  PipelineConfigModel,
  type IPipelineConfig,
  type PipelineType,
  type ConfigChange,
} from './pipeline-config.schema.js';
```

**Step 6: Run test to verify it passes**

Run: `pnpm build && cd packages/pipeline-engine && npx vitest run src/__tests__/pipeline-config.test.ts`
Expected: PASS

**Step 7: Commit**

```bash
git add packages/pipeline-engine/src/schemas/pipeline-config.schema.ts packages/pipeline-engine/src/pipeline/services/pipeline-config.service.ts packages/pipeline-engine/src/__tests__/pipeline-config.test.ts packages/pipeline-engine/src/schemas/index.ts
git commit -m "feat(pipeline-engine): add pipeline configuration schema and service

MongoDB schema for per-tenant pipeline configs with version tracking,
change history, and reprocessing detection. Config resolution chain:
project-level > tenant-level > null.

Addresses Gap 4 (storage part)."
```

---

## Task 6: Call-LLM Activity Service

Addresses **Gap 1** (CRITICAL).

**Files:**

- Create: `packages/pipeline-engine/src/pipeline/services/call-llm.service.ts`
- Create: `packages/pipeline-engine/src/__tests__/call-llm.test.ts`
- Modify: `packages/pipeline-engine/src/pipeline/activity-metadata.ts` (register)
- Modify: `packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts` (register)
- Modify: `packages/pipeline-engine/src/pipeline/server.ts` (bind)

**Step 1: Write the failing test**

```typescript
// packages/pipeline-engine/src/__tests__/call-llm.test.ts
import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { PipelineStepContext, StepOutput } from '../pipeline/types.js';

const mockChat = vi.fn();
vi.mock('../pipeline/services/llm-client-factory.js', () => ({
  createPipelineLLMClient: () => ({
    chat: mockChat,
  }),
}));

const { callLLMService } = await import('../pipeline/services/call-llm.service.js');

function ctx(): any {
  return {
    run: async (_label: string, fn: () => any) => fn(),
    console: { log: () => {} },
  };
}

function getExecute(svc: any) {
  return (svc as any).service.execute;
}

const execute = getExecute(callLLMService);

describe('CallLLM activity', () => {
  beforeEach(() => mockChat.mockReset());

  test('calls LLM and returns parsed JSON response', async () => {
    mockChat.mockResolvedValueOnce({
      content: '{"intent": "billing_refund", "confidence": 0.92}',
      inputTokens: 150,
      outputTokens: 30,
      model: 'claude-haiku-4-5',
    });

    const input: PipelineStepContext = {
      tenantId: 'tenant-1',
      config: {
        systemPrompt: 'Classify the intent of this conversation.',
        userPrompt: 'I want a refund for my last bill.',
        responseFormat: 'json',
      },
      previousSteps: {},
      pipelineInput: { tenantId: 'tenant-1' },
    };

    const result = await execute(ctx(), input);

    expect(result.status).toBe('success');
    expect(result.data.parsed).toEqual({ intent: 'billing_refund', confidence: 0.92 });
    expect(result.data.inputTokens).toBe(150);
    expect(result.data.outputTokens).toBe(30);
    expect(result.data.model).toBe('claude-haiku-4-5');
  });

  test('returns raw text when responseFormat is text', async () => {
    mockChat.mockResolvedValueOnce({
      content: 'The customer is frustrated about billing.',
      inputTokens: 100,
      outputTokens: 20,
      model: 'claude-haiku-4-5',
    });

    const input: PipelineStepContext = {
      tenantId: 'tenant-1',
      config: {
        systemPrompt: 'Summarize the conversation.',
        userPrompt: 'Hi, my bill is wrong again!',
        responseFormat: 'text',
      },
      previousSteps: {},
      pipelineInput: { tenantId: 'tenant-1' },
    };

    const result = await execute(ctx(), input);

    expect(result.status).toBe('success');
    expect(result.data.raw).toBe('The customer is frustrated about billing.');
    expect(result.data.parsed).toBeUndefined();
  });

  test('substitutes variables from previousSteps in prompt', async () => {
    mockChat.mockResolvedValueOnce({
      content: '{"score": 4}',
      inputTokens: 200,
      outputTokens: 10,
      model: 'claude-haiku-4-5',
    });

    const input: PipelineStepContext = {
      tenantId: 'tenant-1',
      config: {
        systemPrompt: 'Rate this transcript.',
        userPromptTemplate: 'Transcript:\n{{transcript}}',
        responseFormat: 'json',
      },
      previousSteps: {
        'read-conversation': {
          status: 'success',
          data: { transcript: 'User: Help\nAssistant: Sure!' },
        },
      },
      pipelineInput: { tenantId: 'tenant-1' },
    };

    const result = await execute(ctx(), input);

    expect(result.status).toBe('success');
    expect(mockChat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            content: 'Transcript:\nUser: Help\nAssistant: Sure!',
          }),
        ]),
      }),
    );
  });

  test('fails gracefully on LLM error', async () => {
    mockChat.mockRejectedValueOnce(new Error('Rate limit exceeded'));

    const input: PipelineStepContext = {
      tenantId: 'tenant-1',
      config: {
        systemPrompt: 'Test',
        userPrompt: 'Test',
      },
      previousSteps: {},
      pipelineInput: { tenantId: 'tenant-1' },
    };

    const result = await execute(ctx(), input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('Rate limit exceeded');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/pipeline-engine && npx vitest run src/__tests__/call-llm.test.ts`
Expected: FAIL — module not found

**Step 3: Write the LLM client factory**

```typescript
// packages/pipeline-engine/src/pipeline/services/llm-client-factory.ts
/**
 * Factory for creating LLM clients within pipeline context.
 *
 * Wraps the platform's LLM credential resolution to provide a simple
 * chat interface for pipeline activities. Does NOT use SessionLLMClient
 * directly (that's tied to session runtime). Instead, resolves credentials
 * per-tenant and calls the provider API.
 */
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('pipeline-llm-client');

export interface PipelineChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface PipelineChatRequest {
  messages: PipelineChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json';
}

export interface PipelineChatResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface PipelineLLMClient {
  chat(request: PipelineChatRequest): Promise<PipelineChatResponse>;
}

/**
 * Create an LLM client for pipeline use. Resolves credentials per-tenant.
 *
 * TODO: Integrate with ModelResolutionService for full credential resolution.
 * For now, uses environment variables (same as SearchAI fallback path).
 */
export function createPipelineLLMClient(tenantId: string): PipelineLLMClient {
  return {
    async chat(request: PipelineChatRequest): Promise<PipelineChatResponse> {
      // Resolve API key — check env vars as initial implementation
      const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error('No LLM API key configured for pipeline processing');
      }

      const provider = process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'openai';
      const model =
        request.model ?? (provider === 'anthropic' ? 'claude-haiku-4-5' : 'gpt-4o-mini');

      log.debug('Pipeline LLM call', { tenantId, provider, model });

      if (provider === 'anthropic') {
        return callAnthropic(apiKey, model, request);
      }
      return callOpenAI(apiKey, model, request);
    },
  };
}

async function callAnthropic(
  apiKey: string,
  model: string,
  request: PipelineChatRequest,
): Promise<PipelineChatResponse> {
  const systemMsg = request.messages.find((m) => m.role === 'system');
  const userMsgs = request.messages.filter((m) => m.role !== 'system');

  const body: Record<string, unknown> = {
    model,
    max_tokens: request.maxTokens ?? 1024,
    temperature: request.temperature ?? 0,
    messages: userMsgs.map((m) => ({ role: m.role, content: m.content })),
  };
  if (systemMsg) body.system = systemMsg.content;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Anthropic API error ${resp.status}: ${text}`);
  }

  const data = (await resp.json()) as any;
  const content = data.content?.[0]?.text ?? '';

  return {
    content,
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
    model: data.model ?? model,
  };
}

async function callOpenAI(
  apiKey: string,
  model: string,
  request: PipelineChatRequest,
): Promise<PipelineChatResponse> {
  const body = {
    model,
    max_tokens: request.maxTokens ?? 1024,
    temperature: request.temperature ?? 0,
    messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
    ...(request.responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}),
  };

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI API error ${resp.status}: ${text}`);
  }

  const data = (await resp.json()) as any;
  const content = data.choices?.[0]?.message?.content ?? '';

  return {
    content,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    model: data.model ?? model,
  };
}
```

**Step 4: Write the call-llm activity service**

```typescript
// packages/pipeline-engine/src/pipeline/services/call-llm.service.ts
/**
 * CallLLM — Restate activity service for making LLM calls within pipelines.
 *
 * Accepts a system prompt, user prompt (or template with variable substitution
 * from prior steps), and returns the LLM response with token tracking.
 *
 * Config:
 *   systemPrompt:       System instructions for the LLM
 *   userPrompt:         Static user prompt text
 *   userPromptTemplate: Template with {{stepId.field}} placeholders (alternative to userPrompt)
 *   model:              Override model (default: claude-haiku-4-5)
 *   temperature:        LLM temperature (default: 0)
 *   maxTokens:          Max output tokens (default: 1024)
 *   responseFormat:     'json' | 'text' (default: 'json')
 */
import * as restate from '@restatedev/restate-sdk';
import { createLogger } from '@abl/compiler/platform';
import type { PipelineStepContext, StepOutput } from '../types.js';
import { createPipelineLLMClient, type PipelineChatMessage } from './llm-client-factory.js';
import { resolveExpression } from '../expression-evaluator.js';

const log = createLogger('call-llm');

/**
 * Resolve {{variable}} placeholders in a template string.
 * Supports: {{steps.stepId.output.field}} and {{pipelineInput.field}}
 */
function resolveTemplate(
  template: string,
  previousSteps: Record<string, StepOutput>,
  pipelineInput: Record<string, unknown>,
): string {
  return template.replace(/\{\{(.+?)\}\}/g, (_match, path: string) => {
    const trimmed = path.trim();
    const value = resolveExpression(trimmed, previousSteps, pipelineInput);
    return value != null ? String(value) : '';
  });
}

export const callLLMService = restate.service({
  name: 'CallLLM',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();
      const config = input.config;

      const systemPrompt = config.systemPrompt as string | undefined;
      const responseFormat = (config.responseFormat as string) ?? 'json';

      // Resolve user prompt — either static or template
      let userPrompt: string;
      if (config.userPromptTemplate) {
        userPrompt = resolveTemplate(
          config.userPromptTemplate as string,
          input.previousSteps,
          input.pipelineInput,
        );
      } else if (config.userPrompt) {
        userPrompt = config.userPrompt as string;
      } else {
        return {
          status: 'fail',
          data: { error: 'CallLLM requires either userPrompt or userPromptTemplate in config' },
          durationMs: Date.now() - startTime,
        };
      }

      try {
        const result = await ctx.run('call-llm', async () => {
          const client = createPipelineLLMClient(input.tenantId);
          const messages: PipelineChatMessage[] = [];

          if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
          }
          messages.push({ role: 'user', content: userPrompt });

          return client.chat({
            messages,
            model: config.model as string | undefined,
            temperature: config.temperature as number | undefined,
            maxTokens: config.maxTokens as number | undefined,
            responseFormat: responseFormat as 'json' | 'text',
          });
        });

        // Parse JSON response if requested
        let parsed: unknown;
        if (responseFormat === 'json') {
          try {
            parsed = JSON.parse(result.content);
          } catch {
            log.warn('LLM returned non-JSON response when JSON was requested', {
              tenantId: input.tenantId,
              content: result.content.slice(0, 200),
            });
            // Return raw content; caller can handle
          }
        }

        return {
          status: 'success',
          data: {
            ...(parsed != null ? { parsed } : {}),
            raw: parsed == null ? result.content : undefined,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            model: result.model,
          },
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        log.error('CallLLM failed', {
          tenantId: input.tenantId,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          status: 'fail',
          data: { error: error instanceof Error ? error.message : String(error) },
          durationMs: Date.now() - startTime,
        };
      }
    },
  },
});

export type CallLLMService = typeof callLLMService;
```

**Step 5: Register in activity-metadata.ts**

Add to `ACTIVITY_TYPES` in `packages/pipeline-engine/src/pipeline/activity-metadata.ts` (after the `compute-tool-effectiveness` entry, before the closing `}`):

```typescript
  'call-llm': {
    name: 'Call LLM',
    description: 'Make an LLM call with prompt templates and variable substitution from prior steps',
    configSchema: {
      required: [],
      properties: {
        systemPrompt: { type: 'string', description: 'System instructions for the LLM' },
        userPrompt: { type: 'string', description: 'Static user prompt text' },
        userPromptTemplate: {
          type: 'string',
          description: 'Template with {{steps.stepId.output.field}} placeholders',
        },
        model: { type: 'string', description: 'LLM model override (default: claude-haiku-4-5)' },
        temperature: { type: 'number', description: 'LLM temperature (default: 0)' },
        maxTokens: { type: 'number', description: 'Max output tokens (default: 1024)' },
        responseFormat: { type: 'string', description: "'json' | 'text' (default: 'json')" },
      },
    },
    outputSchema: {
      properties: {
        parsed: { type: 'object', description: 'Parsed JSON response (if responseFormat=json)' },
        raw: { type: 'string', description: 'Raw text response (if responseFormat=text or JSON parse failed)' },
        inputTokens: { type: 'number', description: 'Input token count' },
        outputTokens: { type: 'number', description: 'Output token count' },
        model: { type: 'string', description: 'Model used' },
      },
    },
    defaultTimeout: 60_000,
    defaultRetries: 2,
  },

  'read-conversation': {
    name: 'Read Conversation',
    description: 'Read and decrypt a conversation transcript from ClickHouse messages + traces',
    configSchema: {
      required: [],
      properties: {
        enrichWithTraces: { type: 'boolean', description: 'Include tool calls and escalation data (default: true)' },
        roles: { type: 'array', description: 'Filter by message roles (default: all)' },
      },
    },
    outputSchema: {
      properties: {
        transcript: { type: 'string', description: 'Formatted conversation transcript' },
        messages: { type: 'array', description: 'Array of decrypted messages with metadata' },
        toolCalls: { type: 'array', description: 'Tool call details (if enrichWithTraces)' },
        escalations: { type: 'array', description: 'Escalation events (if enrichWithTraces)' },
        metadata: { type: 'object', description: '{ agentName, channel, messageCount, durationMs }' },
      },
    },
    defaultTimeout: 30_000,
    defaultRetries: 2,
  },
```

**Step 6: Register handlers in activity-router.service.ts**

Add imports and entries to `SERVICE_HANDLERS` in `packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts`:

```typescript
// Add imports after line 23:
import { callLLMService } from '../services/call-llm.service.js';
import { readConversationService } from '../services/read-conversation.service.js';

// Add to SERVICE_HANDLERS after line 51:
  'call-llm': (callLLMService as any).service.execute,
  'read-conversation': (readConversationService as any).service.execute,
```

**Step 7: Bind in server.ts**

Add to `packages/pipeline-engine/src/pipeline/server.ts`:

```typescript
// Add imports:
import { callLLMService } from './services/call-llm.service.js';
import { readConversationService } from './services/read-conversation.service.js';

// Add .bind() calls before .listen(port):
    .bind(callLLMService)
    .bind(readConversationService)
```

**Step 8: Run tests**

Run: `pnpm build && cd packages/pipeline-engine && npx vitest run src/__tests__/call-llm.test.ts`
Expected: PASS

**Step 9: Commit**

```bash
git add packages/pipeline-engine/src/pipeline/services/call-llm.service.ts packages/pipeline-engine/src/pipeline/services/llm-client-factory.ts packages/pipeline-engine/src/__tests__/call-llm.test.ts packages/pipeline-engine/src/pipeline/activity-metadata.ts packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts packages/pipeline-engine/src/pipeline/server.ts
git commit -m "feat(pipeline-engine): add call-llm activity for LLM-based pipeline processing

New Restate activity that calls LLMs with prompt templates and variable
substitution from prior step outputs. Supports JSON and text response
formats, token tracking, and multi-provider (Anthropic/OpenAI).

Also registers read-conversation activity metadata.

Addresses Gap 1 (CRITICAL)."
```

---

## Task 7: Read-Conversation Activity Service

Wraps ConversationReader as a Restate activity.

**Files:**

- Create: `packages/pipeline-engine/src/pipeline/services/read-conversation.service.ts`
- Create: `packages/pipeline-engine/src/__tests__/read-conversation.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/pipeline-engine/src/__tests__/read-conversation.test.ts
import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { PipelineStepContext } from '../pipeline/types.js';

const mockReadSession = vi.fn();
const mockFormatTranscript = vi.fn();
vi.mock('../pipeline/services/conversation-reader.js', () => ({
  ConversationReader: vi.fn().mockImplementation(() => ({
    readSession: mockReadSession,
    formatTranscript: mockFormatTranscript,
  })),
}));

const { readConversationService } =
  await import('../pipeline/services/read-conversation.service.js');

function ctx(): any {
  return {
    run: async (_label: string, fn: () => any) => fn(),
    console: { log: () => {} },
  };
}

const execute = (readConversationService as any).service.execute;

describe('ReadConversation activity', () => {
  beforeEach(() => {
    mockReadSession.mockReset();
    mockFormatTranscript.mockReset();
  });

  test('reads conversation and returns transcript + messages', async () => {
    const conversationData = {
      tenantId: 't1',
      sessionId: 's1',
      messages: [
        { messageId: 'm1', role: 'user', content: 'Help me', timestamp: '2024-01-01' },
        { messageId: 'm2', role: 'assistant', content: 'Sure!', timestamp: '2024-01-01' },
      ],
      toolCalls: [],
      escalations: [],
      metadata: { messageCount: 2, channel: 'web_chat' },
    };

    mockReadSession.mockResolvedValueOnce(conversationData);
    mockFormatTranscript.mockReturnValueOnce('User: Help me\nAssistant: Sure!');

    const input: PipelineStepContext = {
      tenantId: 't1',
      sessionId: 's1',
      config: {},
      previousSteps: {},
      pipelineInput: { tenantId: 't1', sessionId: 's1' },
    };

    const result = await execute(ctx(), input);

    expect(result.status).toBe('success');
    expect(result.data.transcript).toBe('User: Help me\nAssistant: Sure!');
    expect(result.data.messages).toHaveLength(2);
    expect(result.data.metadata.messageCount).toBe(2);
  });

  test('fails when sessionId is missing', async () => {
    const input: PipelineStepContext = {
      tenantId: 't1',
      config: {},
      previousSteps: {},
      pipelineInput: { tenantId: 't1' },
    };

    const result = await execute(ctx(), input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('sessionId');
  });
});
```

**Step 2: Write the implementation**

```typescript
// packages/pipeline-engine/src/pipeline/services/read-conversation.service.ts
/**
 * ReadConversation — Restate activity that reads and decrypts a session transcript.
 *
 * Wraps ConversationReader as a pipeline activity, making full conversation
 * transcripts available to subsequent steps (e.g., call-llm for quality eval).
 *
 * Config:
 *   enrichWithTraces?: boolean  — include tool calls + escalation data (default: true)
 *   roles?: string[]            — filter by message roles (default: all)
 */
import * as restate from '@restatedev/restate-sdk';
import { createLogger } from '@abl/compiler/platform';
import type { PipelineStepContext, StepOutput } from '../types.js';
import { ConversationReader } from './conversation-reader.js';

const log = createLogger('read-conversation');

export const readConversationService = restate.service({
  name: 'ReadConversation',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();

      const sessionId = input.sessionId ?? input.pipelineInput.sessionId;
      if (!sessionId) {
        return {
          status: 'fail',
          data: { error: 'ReadConversation requires sessionId in pipeline context' },
          durationMs: Date.now() - startTime,
        };
      }

      try {
        const result = await ctx.run('read-conversation', async () => {
          const reader = new ConversationReader();
          const enrichWithTraces = (input.config.enrichWithTraces as boolean) ?? true;
          const roles = input.config.roles as string[] | undefined;

          const data = await reader.readSession(input.tenantId, sessionId, {
            enrichWithTraces,
            roles,
          });

          const transcript = reader.formatTranscript(data);

          return { ...data, transcript };
        });

        return {
          status: 'success',
          data: {
            transcript: result.transcript,
            messages: result.messages,
            toolCalls: result.toolCalls,
            escalations: result.escalations,
            metadata: result.metadata,
          },
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        log.error('ReadConversation failed', {
          tenantId: input.tenantId,
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          status: 'fail',
          data: { error: error instanceof Error ? error.message : String(error) },
          durationMs: Date.now() - startTime,
        };
      }
    },
  },
});

export type ReadConversationService = typeof readConversationService;
```

**Step 3: Run tests**

Run: `pnpm build && cd packages/pipeline-engine && npx vitest run src/__tests__/read-conversation.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/pipeline-engine/src/pipeline/services/read-conversation.service.ts packages/pipeline-engine/src/__tests__/read-conversation.test.ts
git commit -m "feat(pipeline-engine): add read-conversation activity wrapping ConversationReader

Restate activity that reads and decrypts a session transcript, making it
available to downstream steps like call-llm. Supports trace enrichment
and role filtering."
```

---

## Task 8: Sentiment Analysis Pipeline Activity

First end-to-end pipeline. Builds on Tasks 1, 3, 6, 7.

**Files:**

- Create: `packages/pipeline-engine/src/pipeline/services/compute-sentiment.service.ts`
- Create: `packages/pipeline-engine/src/__tests__/compute-sentiment.test.ts`
- Modify: `packages/pipeline-engine/src/pipeline/activity-metadata.ts` (register)
- Modify: `packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts` (register)
- Modify: `packages/pipeline-engine/src/pipeline/server.ts` (bind)

**Step 1: Write the failing test**

```typescript
// packages/pipeline-engine/src/__tests__/compute-sentiment.test.ts
import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { PipelineStepContext } from '../pipeline/types.js';

const mockChat = vi.fn();
vi.mock('../pipeline/services/llm-client-factory.js', () => ({
  createPipelineLLMClient: () => ({ chat: mockChat }),
}));

const mockInsert = vi.fn().mockResolvedValue(undefined);
vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: () => ({ insert: mockInsert }),
}));

const { computeSentimentService } =
  await import('../pipeline/services/compute-sentiment.service.js');

function ctx(): any {
  return {
    run: async (_label: string, fn: () => any) => fn(),
    console: { log: () => {} },
  };
}

const execute = (computeSentimentService as any).service.execute;

describe('ComputeSentiment activity', () => {
  beforeEach(() => {
    mockChat.mockReset();
    mockInsert.mockReset();
  });

  test('scores sentiment per message and computes conversation trajectory', async () => {
    // LLM returns per-message sentiment scores
    mockChat.mockResolvedValueOnce({
      content: JSON.stringify({
        messages: [
          {
            messageId: 'm1',
            score: -0.6,
            label: 'negative',
            frustration: true,
            signals: ['ALL_CAPS'],
          },
          { messageId: 'm2', score: 0.2, label: 'neutral', frustration: false, signals: [] },
          { messageId: 'm3', score: 0.7, label: 'positive', frustration: false, signals: [] },
        ],
        trajectory: 'improving',
      }),
      inputTokens: 300,
      outputTokens: 100,
      model: 'claude-haiku-4-5',
    });

    const input: PipelineStepContext = {
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      config: {},
      previousSteps: {
        'read-conversation': {
          status: 'success',
          data: {
            transcript:
              'User: I AM SO FRUSTRATED\nAssistant: I understand.\nUser: Thanks for helping.',
            messages: [
              {
                messageId: 'm1',
                role: 'user',
                content: 'I AM SO FRUSTRATED',
                timestamp: '2024-01-01T10:00:00Z',
              },
              {
                messageId: 'm2',
                role: 'assistant',
                content: 'I understand.',
                timestamp: '2024-01-01T10:00:05Z',
              },
              {
                messageId: 'm3',
                role: 'user',
                content: 'Thanks for helping.',
                timestamp: '2024-01-01T10:00:10Z',
              },
            ],
            metadata: { channel: 'web_chat', agentName: 'SupportAgent' },
          },
        },
      },
      pipelineInput: {
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        sessionId: 'sess-1',
        eventTimestamp: '2024-01-01T10:00:00Z',
      },
    };

    const result = await execute(ctx(), input);

    expect(result.status).toBe('success');
    expect(result.data.conversationSentiment.sentiment_trajectory).toBe('improving');
    expect(result.data.conversationSentiment.frustration_detected).toBe(1);
    expect(result.data.messageSentiments).toHaveLength(3);
    expect(result.data.inputTokens).toBe(300);
    expect(mockInsert).toHaveBeenCalledTimes(2); // message_sentiment + conversation_sentiment
  });

  test('skips conversations with no user messages', async () => {
    const input: PipelineStepContext = {
      tenantId: 'tenant-1',
      sessionId: 'sess-1',
      config: {},
      previousSteps: {
        'read-conversation': {
          status: 'success',
          data: {
            transcript: '',
            messages: [],
            metadata: { messageCount: 0 },
          },
        },
      },
      pipelineInput: { tenantId: 'tenant-1', sessionId: 'sess-1' },
    };

    const result = await execute(ctx(), input);

    expect(result.status).toBe('skipped');
    expect(mockChat).not.toHaveBeenCalled();
  });
});
```

**Step 2: Write the implementation**

```typescript
// packages/pipeline-engine/src/pipeline/services/compute-sentiment.service.ts
/**
 * ComputeSentiment — Restate activity for LLM-based sentiment analysis.
 *
 * Reads conversation transcript from a prior read-conversation step,
 * sends to LLM for per-message sentiment scoring, computes conversation-level
 * trajectory, and writes results to message_sentiment + conversation_sentiment tables.
 *
 * Pipeline definition should have:
 *   1. read-conversation (produces transcript + messages)
 *   2. compute-sentiment (this — reads from step 1, writes to ClickHouse)
 */
import * as restate from '@restatedev/restate-sdk';
import { createLogger } from '@abl/compiler/platform';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import type { PipelineStepContext, StepOutput } from '../types.js';
import { createPipelineLLMClient } from './llm-client-factory.js';

const log = createLogger('compute-sentiment');

const SENTIMENT_SYSTEM_PROMPT = `You are a sentiment analysis system. Analyze each message in the conversation and return a JSON object with:
{
  "messages": [
    {
      "messageId": "<id>",
      "score": <float -1.0 to 1.0>,
      "label": "positive" | "neutral" | "negative",
      "frustration": <boolean>,
      "signals": ["ALL_CAPS", "repetition", "keyword:<word>", "excessive_punctuation"]
    }
  ],
  "trajectory": "improving" | "declining" | "stable" | "volatile"
}

Score scale: -1.0 (very negative) to +1.0 (very positive). 0 is neutral.
Frustration signals: ALL_CAPS shouting, repeated questions, profanity, excessive punctuation.
Trajectory: based on how user sentiment changes over the conversation.
Only analyze user messages. Return the same messageId provided in input.`;

interface SentimentLLMResponse {
  messages: Array<{
    messageId: string;
    score: number;
    label: string;
    frustration: boolean;
    signals: string[];
  }>;
  trajectory: string;
}

function toCHDateTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

export const computeSentimentService = restate.service({
  name: 'ComputeSentiment',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();

      // Read conversation from prior step
      const convStep = input.previousSteps['read-conversation'];
      if (!convStep || convStep.status !== 'success') {
        return {
          status: 'fail',
          data: { error: 'ComputeSentiment requires a successful read-conversation step' },
          durationMs: Date.now() - startTime,
        };
      }

      const messages = convStep.data.messages as Array<{
        messageId: string;
        role: string;
        content: string;
        timestamp: string;
      }>;
      const metadata = convStep.data.metadata as Record<string, unknown>;

      // Skip empty conversations
      const userMessages = messages.filter((m) => m.role === 'user');
      if (userMessages.length === 0) {
        return {
          status: 'skipped',
          data: { reason: 'No user messages' },
          durationMs: Date.now() - startTime,
        };
      }

      try {
        const result = await ctx.run('compute-sentiment', async () => {
          const client = createPipelineLLMClient(input.tenantId);

          // Build the user prompt with message IDs
          const messageList = userMessages.map((m) => `[${m.messageId}] ${m.content}`).join('\n');

          const userPrompt = `Analyze sentiment for each message:\n\n${messageList}`;

          const llmResult = await client.chat({
            messages: [
              { role: 'system', content: SENTIMENT_SYSTEM_PROMPT },
              { role: 'user', content: userPrompt },
            ],
            responseFormat: 'json',
            temperature: 0,
          });

          const parsed = JSON.parse(llmResult.content) as SentimentLLMResponse;

          // Write per-message sentiments to ClickHouse
          const ch = getClickHouseClient();
          const sessionId = input.sessionId ?? input.pipelineInput.sessionId ?? '';
          const projectId = input.projectId ?? input.pipelineInput.projectId ?? '';
          const now = toCHDateTime(new Date());

          const messageRows = parsed.messages.map((s) => {
            const origMsg = messages.find((m) => m.messageId === s.messageId);
            return {
              tenant_id: input.tenantId,
              session_id: sessionId,
              message_id: s.messageId,
              message_at: origMsg ? toCHDateTime(origMsg.timestamp) : now,
              processed_at: now,
              role: origMsg?.role ?? 'user',
              agent_name: String(metadata.agentName ?? ''),
              channel: String(metadata.channel ?? ''),
              sentiment_score: s.score,
              sentiment_label: s.label,
              frustration_detected: s.frustration ? 1 : 0,
              frustration_signals: s.signals,
              model_id: llmResult.model,
              config_version: 1,
              confidence: 0.9,
              processing_ms: Date.now() - startTime,
            };
          });

          await ch.insert({
            table: 'abl_platform.message_sentiment',
            values: messageRows,
            format: 'JSONEachRow',
          });

          // Compute conversation-level aggregation
          const scores = parsed.messages.map((m) => m.score);
          const avgSentiment = scores.reduce((a, b) => a + b, 0) / scores.length;
          const frustrationCount = parsed.messages.filter((m) => m.frustration).length;

          const convRow = {
            tenant_id: input.tenantId,
            project_id: projectId,
            session_id: sessionId,
            session_started_at: messages[0]?.timestamp ? toCHDateTime(messages[0].timestamp) : now,
            processed_at: now,
            agent_name: String(metadata.agentName ?? ''),
            channel: String(metadata.channel ?? ''),
            avg_sentiment: avgSentiment,
            start_sentiment: scores[0] ?? 0,
            end_sentiment: scores[scores.length - 1] ?? 0,
            min_sentiment: Math.min(...scores),
            max_sentiment: Math.max(...scores),
            sentiment_trajectory: parsed.trajectory,
            sentiment_shift_count: countShifts(scores, 0.3),
            frustration_turn_count: frustrationCount,
            frustration_detected: frustrationCount > 0 ? 1 : 0,
            pivot_count: countShifts(scores, 0.3),
            worst_pivot_at: null,
            worst_pivot_delta: null,
            model_id: llmResult.model,
            config_version: 1,
            message_count: userMessages.length,
            processing_ms: Date.now() - startTime,
          };

          await ch.insert({
            table: 'abl_platform.conversation_sentiment',
            values: [convRow],
            format: 'JSONEachRow',
          });

          return {
            conversationSentiment: convRow,
            messageSentiments: messageRows,
            inputTokens: llmResult.inputTokens,
            outputTokens: llmResult.outputTokens,
            model: llmResult.model,
          };
        });

        return {
          status: 'success',
          data: result,
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        log.error('ComputeSentiment failed', {
          tenantId: input.tenantId,
          sessionId: input.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          status: 'fail',
          data: { error: error instanceof Error ? error.message : String(error) },
          durationMs: Date.now() - startTime,
        };
      }
    },
  },
});

/** Count significant sentiment shifts (delta > threshold between consecutive messages). */
function countShifts(scores: number[], threshold: number): number {
  let shifts = 0;
  for (let i = 1; i < scores.length; i++) {
    if (Math.abs(scores[i] - scores[i - 1]) >= threshold) shifts++;
  }
  return shifts;
}

export type ComputeSentimentService = typeof computeSentimentService;
```

**Step 3: Register in activity-metadata.ts, activity-router, and server.ts**

Follow the same pattern as Task 6 — add `'compute-sentiment'` entry to `ACTIVITY_TYPES`, `SERVICE_HANDLERS`, and `.bind()`.

**Step 4: Run tests**

Run: `pnpm build && cd packages/pipeline-engine && npx vitest run src/__tests__/compute-sentiment.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/pipeline-engine/src/pipeline/services/compute-sentiment.service.ts packages/pipeline-engine/src/__tests__/compute-sentiment.test.ts packages/pipeline-engine/src/pipeline/activity-metadata.ts packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts packages/pipeline-engine/src/pipeline/server.ts
git commit -m "feat(pipeline-engine): add compute-sentiment activity with LLM scoring

Per-message sentiment via LLM, conversation-level trajectory computation,
writes to message_sentiment + conversation_sentiment ClickHouse tables.
Supports frustration detection and pivot point analysis."
```

---

## Task 9-11: Analytics Query API, Redis Cache, Sentiment Pipeline Definition

> These tasks follow the same TDD pattern. Abbreviated for plan size.

### Task 9: Analytics Query API

**Files:**

- Create: `apps/runtime/src/routes/pipeline-analytics.ts`
- Create: `apps/runtime/src/routes/__tests__/pipeline-analytics.test.ts`

Implements:

```
GET /api/projects/:projectId/analytics/:pipelineType/summary?period=7d
GET /api/projects/:projectId/analytics/:pipelineType/breakdown?period=7d&dimension=agent_name
GET /api/projects/:projectId/analytics/:pipelineType/conversations?period=7d&filter=score_lt:3.0
GET /api/projects/:projectId/analytics/:pipelineType/conversation/:sessionId
```

Each endpoint: auth middleware → project permission check → ClickHouse query → Redis cache → response.

### Task 10: Redis Cache Layer

**Files:**

- Create: `packages/pipeline-engine/src/pipeline/services/analytics-cache.ts`
- Create: `packages/pipeline-engine/src/__tests__/analytics-cache.test.ts`

Cache keys: `analytics:{tenantId}:{projectId}:{pipeline}:{queryType}:{period}`
TTLs: summary=300s, timeseries=600s, breakdown=300s, conversation=3600s.

### Task 11: Sentiment Pipeline Definition

Create and register the pipeline definition that chains: `read-conversation` → `compute-sentiment`.

**Files:**

- Create: `packages/pipeline-engine/src/pipeline/definitions/sentiment-pipeline.ts`

Pipeline triggered by `abl.session.ended` Kafka event with filter `payload.reason = completed`.

---

## Tasks 12-14: Intent Classification Pipeline

### Task 12: Compute-Intent Activity

**Files:**

- Create: `packages/pipeline-engine/src/pipeline/services/compute-intent.service.ts`
- Create: `packages/pipeline-engine/src/__tests__/compute-intent.test.ts`

LLM classifies conversation intent from first 2-3 user messages. Supports customer-defined taxonomy from pipeline config. Writes to `intent_classifications` table.

### Task 13: Intent Pipeline Definition

Chain: `read-conversation` → `compute-intent` → `store-to-clickhouse`.
Triggered by `abl.session.ended`.

### Task 14: Extend Analytics API for Intent

Add intent-specific queries to the analytics API: intent distribution, intent trend, intent × containment cross-filter.

---

## Tasks 15-18: Quality Evaluation Pipeline

### Task 15: Compute-Quality Activity

**Files:**

- Create: `packages/pipeline-engine/src/pipeline/services/compute-quality.service.ts`
- Create: `packages/pipeline-engine/src/__tests__/compute-quality.test.ts`

LLM-as-judge evaluates conversation quality against configurable rubric dimensions. Reads rubric from pipeline config. Writes to `quality_evaluations` table.

### Task 16: Pipeline Config API Endpoints

**Files:**

- Create: `apps/runtime/src/routes/pipeline-config.ts`
- Create: `apps/runtime/src/routes/__tests__/pipeline-config.test.ts`

```
GET    /api/projects/:projectId/pipelines/:pipelineType/config
PUT    /api/projects/:projectId/pipelines/:pipelineType/config
POST   /api/projects/:projectId/pipelines/:pipelineType/backfill
GET    /api/projects/:projectId/pipelines/:pipelineType/status
```

### Task 17: Backfill Mechanism

**Files:**

- Create: `packages/pipeline-engine/src/pipeline/services/backfill.service.ts`
- Create: `packages/pipeline-engine/src/__tests__/backfill.test.ts`

Queries unprocessed sessions → batch-processes via pipeline → tracks progress in MongoDB. Triggered by config change or manual API call.

### Task 18: Quality Pipeline Definition

Chain: `read-conversation` → `compute-quality`. Uses rubric from pipeline config. Triggered by `abl.session.ended`.

---

## Export Updates

After all tasks, update `packages/pipeline-engine/src/index.ts` to export:

```typescript
// New exports
export { ConversationReader } from './pipeline/services/conversation-reader.js';
export {
  classifyOutcome,
  type SessionOutcome,
} from './pipeline/services/outcome-classification.js';
export { PipelineConfigService } from './pipeline/services/pipeline-config.service.js';
export {
  PipelineConfigModel,
  type IPipelineConfig,
  type PipelineType,
} from './schemas/pipeline-config.schema.js';
export { callLLMService } from './pipeline/services/call-llm.service.js';
export { readConversationService } from './pipeline/services/read-conversation.service.js';
export { computeSentimentService } from './pipeline/services/compute-sentiment.service.js';
```

---

## Verification Checklist

After all tasks complete:

- [ ] `pnpm build` succeeds with no errors
- [ ] `pnpm test` passes all pipeline-engine tests
- [ ] ClickHouse tables exist: `message_sentiment`, `conversation_sentiment`, `intent_classifications`, `quality_evaluations`
- [ ] MVs exist: `mv_daily_sentiment`, `mv_daily_intent_distribution`, `mv_daily_quality_scores`
- [ ] Activities registered: `call-llm`, `read-conversation`, `compute-sentiment`, `compute-intent`, `compute-quality`
- [ ] Pipeline configs storable and resolvable per-tenant
- [ ] Analytics API returns data from ClickHouse with Redis caching
- [ ] Sentiment pipeline processes a test conversation end-to-end
- [ ] Intent pipeline classifies test conversation
- [ ] Quality pipeline evaluates test conversation with rubric

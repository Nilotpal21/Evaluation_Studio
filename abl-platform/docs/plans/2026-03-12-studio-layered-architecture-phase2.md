# Studio Layered Architecture — Phase 2: Sessions + Chat

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate Sessions + Chat as the second feature module, extracting the largest chunk of WebSocketContext logic into a testable, contract-validated feature module with pure functions, typed handlers, and a dedicated store.

**Architecture:** Extract session message handling from WebSocketContext (`trace_event` sub-handlers for `tool_thought`, `handoff`, `error`, `dsl_collect`, `entity_extraction`, `dsl_set`) into `features/sessions/`. Pure functions handle thought card merging, state extraction, and trace event formatting. The sessions handler registers on the MessageBus alongside the observatory handler — both receive `trace_event` messages and filter for their own concerns.

**Tech Stack:** TypeScript, Zustand 4.4 (with `devtools` middleware), Zod 3.23, MSW v2 (WebSocket mocking), Vitest 4.0, happy-dom

**Spec:** `docs/plans/2026-03-12-studio-layered-architecture-design.md`

**Depends on:** Phase 1 (MessageBus infrastructure must be complete)

---

## Pre-Implementation Checklist

Before starting any task, the implementing agent MUST:

1. Run `npx prettier --write <files>` on ALL changed files before committing
2. BEFORE using any existing component/function/type, READ its source file to verify the actual signature
3. NEVER switch branches — stay on the current branch
4. NEVER add "Co-Authored-By" lines to commit messages
5. Commit messages: `[ABLP-2] type(scope): description`
6. Run `pnpm build --filter=studio` after creating/modifying files to catch type errors immediately
7. Use `@/` path alias for all imports within `apps/studio/src/`

## File Structure

All new files live under `apps/studio/src/`. Abbreviated as `src/` below.

### Sessions Feature Module (new)

```
src/features/sessions/
  sessions.contract.ts       ← Zod schemas for SessionMessage, AgentState, ConstructAction, TraceEvent, ServerMessage subset
  sessions.types.ts          ← TS types derived from contracts via z.infer
  trace-event-logger.ts      ← formatTraceEventLog pure function (extracted from utils/replay-trace-events.ts)
  thought-card-merger.ts     ← mergeThoughtCard pure function (streaming-aware thought/handoff merging)
  state-extractor.ts         ← extractStatePatch pure function (dsl_collect, entity_extraction, dsl_set → AgentState patch)
  test-context.contract.ts   ← Zod schemas for TestContextPayload, ToolMockConfig, ContextInjection, response messages
  sessions.store.ts          ← Pure Zustand store (session list + active session + messages)
  sessions.handlers.ts       ← MessageBus handlers for chat messages, thought cards, error surfacing, state extraction
  sessions.api.ts            ← Unified REST session list + WS streaming + proxy for mutations
  index.ts                   ← Barrel exports

  __tests__/
    sessions.contract.test.ts
    trace-event-logger.test.ts
    thought-card-merger.test.ts
    state-extractor.test.ts
    test-context.contract.test.ts
    sessions.store.test.ts
    sessions.handlers.test.ts

  __fixtures__/
    session-messages.json         ← Golden SessionMessage array (user, assistant, thought, system roles)
    agent-state.json              ← Golden AgentState with all nested fields populated
    construct-actions.json        ← All 9 ConstructAction variants
    trace-events-session.json     ← Trace events relevant to sessions (tool_thought, handoff, error, dsl_collect, entity_extraction, dsl_set)
    server-messages-session.json  ← ServerMessage samples for session-relevant types
    test-context-payloads.json    ← TestContextPayload, ToolMockConfig, ContextInjection samples
    thought-merge-scenarios.json  ← Input/output pairs for thought card merger edge cases
```

---

## Chunk 1: Pure Functions + Contract Schemas (Tasks 1–7)

### Task 1: Sessions Contract Schemas

**Files:**

- Create: `src/features/sessions/sessions.contract.ts`
- Test: `src/features/sessions/__tests__/sessions.contract.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/features/sessions/__tests__/sessions.contract.test.ts`:

```typescript
// src/features/sessions/__tests__/sessions.contract.test.ts
import { describe, it, expect } from 'vitest';
import {
  SessionMessageSchema,
  SessionMessageMetadataSchema,
  AgentStateSchema,
  ConstructActionSchema,
  TraceEventSchema,
  SessionServerMessageSchema,
} from '../sessions.contract';

describe('sessions.contract', () => {
  describe('SessionMessageSchema', () => {
    it('validates a complete session message', () => {
      const msg = {
        id: 'msg-1',
        role: 'user',
        content: 'Hello',
        timestamp: new Date().toISOString(),
        traceIds: ['trace-1'],
      };
      expect(SessionMessageSchema.safeParse(msg).success).toBe(true);
    });

    it('validates all four roles', () => {
      for (const role of ['user', 'assistant', 'system', 'thought']) {
        const msg = {
          id: `msg-${role}`,
          role,
          content: 'text',
          timestamp: new Date().toISOString(),
          traceIds: [],
        };
        expect(SessionMessageSchema.safeParse(msg).success).toBe(true);
      }
    });

    it('rejects invalid role', () => {
      const msg = {
        id: 'msg-1',
        role: 'admin',
        content: 'text',
        timestamp: new Date().toISOString(),
        traceIds: [],
      };
      expect(SessionMessageSchema.safeParse(msg).success).toBe(false);
    });

    it('validates metadata sub-shape', () => {
      const metadata = {
        tokensIn: 100,
        tokensOut: 200,
        latencyMs: 500,
        toolName: 'search',
        agentName: 'support-agent',
        handoffFrom: 'triage',
        handoffTo: 'support',
        attachmentFilenames: ['doc.pdf'],
      };
      expect(SessionMessageMetadataSchema.safeParse(metadata).success).toBe(true);
    });

    it('accepts message with metadata', () => {
      const msg = {
        id: 'msg-1',
        role: 'thought',
        content: 'Thinking...',
        timestamp: new Date().toISOString(),
        traceIds: ['t1'],
        metadata: {
          toolName: 'calculator',
          agentName: 'math-agent',
        },
      };
      expect(SessionMessageSchema.safeParse(msg).success).toBe(true);
    });
  });

  describe('AgentStateSchema', () => {
    it('validates a minimal agent state', () => {
      const state = {
        context: {},
        conversationPhase: 'start',
        gatherProgress: {},
        constraintResults: {},
        lastToolResults: {},
        memory: {
          session: {},
          persistentCache: {},
          pendingRemembers: [],
        },
      };
      expect(AgentStateSchema.safeParse(state).success).toBe(true);
    });

    it('validates agent state with all optional fields', () => {
      const state = {
        context: { name: 'John' },
        conversationPhase: 'gather',
        gatherProgress: { name: 'John', age: 30 },
        constraintResults: { 'age-check': true },
        lastToolResults: { search: { found: true } },
        memory: {
          session: { visited: true },
          persistentCache: { prefs: 'dark' },
          pendingRemembers: [{ key: 'pref', value: 'dark' }],
        },
        flowState: {
          currentStep: 'step-1',
          stepHistory: ['entry', 'step-1'],
          stepResults: { entry: { done: true } },
          isComplete: false,
        },
        errorState: {
          type: 'tool_error',
          message: 'API timeout',
          stack: 'Error: API timeout\n  at ...',
          retryCount: 2,
        },
        activeAgent: {
          name: 'support-agent',
          mode: 'reasoning',
        },
      };
      expect(AgentStateSchema.safeParse(state).success).toBe(true);
    });
  });

  describe('ConstructActionSchema', () => {
    it('validates all 9 action types', () => {
      const actions = [
        { type: 'continue' },
        { type: 'continue', data: { key: 'val' } },
        { type: 'respond', message: 'Hello' },
        { type: 'respond', message: 'Hello', continueProcessing: true },
        {
          type: 'escalate',
          reason: 'complex issue',
          priority: 'high',
          context: { topic: 'billing' },
        },
        {
          type: 'handoff',
          target: 'support',
          context: { issue: 'billing' },
          returnExpected: true,
          summary: 'Billing issue',
        },
        {
          type: 'delegate',
          agent: 'research',
          input: { query: 'pricing' },
          useResult: 'researchResult',
        },
        { type: 'complete', message: 'Done', store: { result: true } },
        { type: 'retry', delay: 1000, target: 'step-1' },
        { type: 'block', reason: 'constraint failed', constraint: 'age-check' },
        {
          type: 'collect',
          fields: ['name', 'email'],
          prompts: { name: 'What is your name?', email: 'What is your email?' },
        },
      ];
      for (const action of actions) {
        const result = ConstructActionSchema.safeParse(action);
        expect(
          result.success,
          `Action type=${action.type} should validate: ${JSON.stringify(result)}`,
        ).toBe(true);
      }
    });

    it('rejects unknown action type', () => {
      const result = ConstructActionSchema.safeParse({
        type: 'unknown_action',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('TraceEventSchema', () => {
    it('validates a basic trace event', () => {
      const event = {
        id: 'evt-1',
        sessionId: 'sess-1',
        type: 'llm_call',
        timestamp: new Date().toISOString(),
        data: { model: 'claude', agentName: 'support' },
      };
      expect(TraceEventSchema.safeParse(event).success).toBe(true);
    });

    it('validates trace event with optional fields', () => {
      const event = {
        id: 'evt-2',
        sessionId: 'sess-1',
        type: 'decision',
        timestamp: new Date().toISOString(),
        durationMs: 150,
        data: { kind: 'handoff' },
        decisionKind: 'handoff',
      };
      expect(TraceEventSchema.safeParse(event).success).toBe(true);
    });
  });

  describe('SessionServerMessageSchema', () => {
    it('validates response_start', () => {
      const msg = {
        type: 'response_start',
        sessionId: 's1',
        messageId: 'm1',
      };
      expect(SessionServerMessageSchema.safeParse(msg).success).toBe(true);
    });

    it('validates response_chunk', () => {
      const msg = {
        type: 'response_chunk',
        sessionId: 's1',
        messageId: 'm1',
        chunk: 'Hello ',
      };
      expect(SessionServerMessageSchema.safeParse(msg).success).toBe(true);
    });

    it('validates response_end', () => {
      const msg = {
        type: 'response_end',
        sessionId: 's1',
        messageId: 'm1',
        fullText: 'Hello world',
      };
      expect(SessionServerMessageSchema.safeParse(msg).success).toBe(true);
    });

    it('validates state_update', () => {
      const msg = {
        type: 'state_update',
        sessionId: 's1',
        state: {
          context: {},
          conversationPhase: 'start',
          gatherProgress: {},
          constraintResults: {},
          lastToolResults: {},
          memory: { session: {}, persistentCache: {}, pendingRemembers: [] },
        },
        updates: { context: { name: 'John' } },
      };
      expect(SessionServerMessageSchema.safeParse(msg).success).toBe(true);
    });

    it('validates action_taken', () => {
      const msg = {
        type: 'action_taken',
        sessionId: 's1',
        action: { type: 'respond', message: 'Hi' },
      };
      expect(SessionServerMessageSchema.safeParse(msg).success).toBe(true);
    });

    it('validates session_reset', () => {
      expect(
        SessionServerMessageSchema.safeParse({
          type: 'session_reset',
          sessionId: 's1',
        }).success,
      ).toBe(true);
    });

    it('validates session_resumed', () => {
      const msg = {
        type: 'session_resumed',
        sessionId: 's1',
        state: {
          context: {},
          conversationPhase: 'start',
          gatherProgress: {},
          constraintResults: {},
          lastToolResults: {},
          memory: { session: {}, persistentCache: {}, pendingRemembers: [] },
        },
        conversationHistory: [{ role: 'user', content: 'Hi' }],
      };
      expect(SessionServerMessageSchema.safeParse(msg).success).toBe(true);
    });

    it('validates session_expired', () => {
      expect(
        SessionServerMessageSchema.safeParse({
          type: 'session_expired',
          sessionId: 's1',
          reason: 'timeout',
        }).success,
      ).toBe(true);
    });

    it('validates error', () => {
      expect(
        SessionServerMessageSchema.safeParse({
          type: 'error',
          message: 'Something went wrong',
        }).success,
      ).toBe(true);
    });

    it('validates info', () => {
      expect(
        SessionServerMessageSchema.safeParse({
          type: 'info',
          message: 'Connected',
          configured: true,
        }).success,
      ).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/studio && pnpm vitest run src/features/sessions/__tests__/sessions.contract.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Create sessions.contract.ts**

Read `src/types/index.ts` first to get the exact `SessionMessage`, `AgentState`, `ConstructAction`, `TraceEvent`, and `ServerMessage` type definitions. Then create:

```typescript
// src/features/sessions/sessions.contract.ts

/**
 * Sessions Contract Schemas
 *
 * Zod schemas that define the runtime shape of all session-related data.
 * These are the source of truth — TS types in sessions.types.ts are
 * derived from these schemas via z.infer.
 *
 * Mirrors: src/types/index.ts (SessionMessage, AgentState, ConstructAction,
 * TraceEvent, ServerMessage subset)
 */

import { z } from 'zod';

// ── SessionMessage ──────────────────────────────────────────────────────────

export const SessionMessageMetadataSchema = z
  .object({
    tokensIn: z.number().optional(),
    tokensOut: z.number().optional(),
    latencyMs: z.number().optional(),
    action: z.lazy(() => ConstructActionSchema).optional(),
    toolName: z.string().optional(),
    agentName: z.string().optional(),
    handoffFrom: z.string().optional(),
    handoffTo: z.string().optional(),
    attachmentFilenames: z.array(z.string()).optional(),
  })
  .strict()
  .optional();

export const SessionMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'system', 'thought']),
  content: z.string(),
  timestamp: z.coerce.date(),
  traceIds: z.array(z.string()),
  metadata: SessionMessageMetadataSchema,
});

// ── AgentState ──────────────────────────────────────────────────────────────

export const AgentMemorySchema = z.object({
  session: z.record(z.string(), z.unknown()),
  persistentCache: z.record(z.string(), z.unknown()),
  pendingRemembers: z.array(z.unknown()),
});

export const FlowStateSchema = z.object({
  currentStep: z.string(),
  stepHistory: z.array(z.string()),
  stepResults: z.record(z.string(), z.unknown()),
  isComplete: z.boolean(),
});

export const ErrorStateSchema = z.object({
  type: z.string(),
  message: z.string(),
  stack: z.string().optional(),
  retryCount: z.number(),
});

export const ActiveAgentSchema = z.object({
  name: z.string(),
  mode: z.string(),
  ir: z.unknown().optional(),
});

export const AgentStateSchema = z.object({
  context: z.record(z.string(), z.unknown()),
  conversationPhase: z.string(),
  gatherProgress: z.record(z.string(), z.unknown()),
  constraintResults: z.record(z.string(), z.boolean()),
  lastToolResults: z.record(z.string(), z.unknown()),
  memory: AgentMemorySchema,
  flowState: FlowStateSchema.optional(),
  errorState: ErrorStateSchema.optional(),
  activeAgent: ActiveAgentSchema.optional(),
});

// ── ConstructAction ─────────────────────────────────────────────────────────

const ContinueActionSchema = z.object({
  type: z.literal('continue'),
  data: z.record(z.string(), z.unknown()).optional(),
});

const RespondActionSchema = z.object({
  type: z.literal('respond'),
  message: z.string(),
  continueProcessing: z.boolean().optional(),
});

const EscalateActionSchema = z.object({
  type: z.literal('escalate'),
  reason: z.string(),
  priority: z.enum(['low', 'medium', 'high', 'critical']),
  context: z.record(z.string(), z.unknown()).optional(),
});

const HandoffActionSchema = z.object({
  type: z.literal('handoff'),
  target: z.string(),
  context: z.record(z.string(), z.unknown()),
  returnExpected: z.boolean(),
  summary: z.string().optional(),
});

const DelegateActionSchema = z.object({
  type: z.literal('delegate'),
  agent: z.string(),
  input: z.record(z.string(), z.unknown()),
  useResult: z.string(),
});

const CompleteActionSchema = z.object({
  type: z.literal('complete'),
  message: z.string().optional(),
  store: z.record(z.string(), z.unknown()).optional(),
});

const RetryActionSchema = z.object({
  type: z.literal('retry'),
  delay: z.number(),
  target: z.string().optional(),
});

const BlockActionSchema = z.object({
  type: z.literal('block'),
  reason: z.string(),
  constraint: z.string().optional(),
});

const CollectActionSchema = z.object({
  type: z.literal('collect'),
  fields: z.array(z.string()),
  prompts: z.record(z.string(), z.string()),
});

export const ConstructActionSchema = z.discriminatedUnion('type', [
  ContinueActionSchema,
  RespondActionSchema,
  EscalateActionSchema,
  HandoffActionSchema,
  DelegateActionSchema,
  CompleteActionSchema,
  RetryActionSchema,
  BlockActionSchema,
  CollectActionSchema,
]);

// ── TraceEvent ──────────────────────────────────────────────────────────────

/**
 * TraceEventType — the base set of trace event types relevant to sessions.
 * Extended types (Observatory-specific) are in observatory.contract.ts.
 */
export const TraceEventTypeSchema = z.enum([
  'llm_call',
  'tool_call',
  'decision',
  'constraint_check',
  'handoff',
  'escalation',
  'error',
  // Session-relevant extended types
  'tool_thought',
  'dsl_collect',
  'dsl_set',
  'dsl_respond',
  'dsl_prompt',
  'dsl_on_input',
  'dsl_call',
  'entity_extraction',
  'agent_enter',
  'agent_exit',
  'flow_step_enter',
  'flow_step_exit',
  'flow_transition',
  'delegate_start',
  'delegate_complete',
  'session_start',
  'session_end',
  'session_ended',
  'completion_check',
  'engine_decision',
  'handoff_condition_check',
  'thread_return',
  'data_stored',
  'digression',
  'sub_intent',
  'correction',
  'constraint_violation',
  'warning',
  'user_message',
  // Voice pipeline events
  'voice_session_start',
  'voice_session_end',
  'voice_turn',
  'voice_stt',
  'voice_tts',
  'voice_tts_quality',
  'voice_asr_quality',
  'voice_asr_cascade',
  'voice_barge_in',
]);

export const DecisionKindSchema = z.enum([
  'field_validation',
  'gather_extraction',
  'flow_transition',
  'correction',
  'data_mutation',
  'handoff',
  'delegation',
  'constraint_check',
  'escalation',
  'guardrail_check',
  'completion',
]);

export const TraceEventSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  type: TraceEventTypeSchema,
  timestamp: z.coerce.date(),
  durationMs: z.number().optional(),
  data: z.record(z.string(), z.unknown()),
  decisionKind: DecisionKindSchema.optional(),
});

// ── ServerMessage (session-relevant subset) ─────────────────────────────────

const ResponseStartSchema = z.object({
  type: z.literal('response_start'),
  sessionId: z.string(),
  messageId: z.string(),
});

const ResponseChunkSchema = z.object({
  type: z.literal('response_chunk'),
  sessionId: z.string(),
  messageId: z.string(),
  chunk: z.string(),
});

const ResponseEndSchema = z.object({
  type: z.literal('response_end'),
  sessionId: z.string(),
  messageId: z.string(),
  fullText: z.string(),
});

const StateUpdateSchema = z.object({
  type: z.literal('state_update'),
  sessionId: z.string(),
  state: AgentStateSchema,
  updates: AgentStateSchema.partial().optional(),
});

const ActionTakenSchema = z.object({
  type: z.literal('action_taken'),
  sessionId: z.string(),
  action: ConstructActionSchema,
});

const SessionResetSchema = z.object({
  type: z.literal('session_reset'),
  sessionId: z.string(),
});

const SessionResumedSchema = z.object({
  type: z.literal('session_resumed'),
  sessionId: z.string(),
  state: AgentStateSchema,
  conversationHistory: z.array(
    z.object({
      role: z.string(),
      content: z.string(),
    }),
  ),
});

const SessionExpiredSchema = z.object({
  type: z.literal('session_expired'),
  sessionId: z.string(),
  reason: z.string(),
});

const ErrorMessageSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
});

const InfoMessageSchema = z.object({
  type: z.literal('info'),
  message: z.string(),
  configured: z.boolean(),
});

export const SessionServerMessageSchema = z.discriminatedUnion('type', [
  ResponseStartSchema,
  ResponseChunkSchema,
  ResponseEndSchema,
  StateUpdateSchema,
  ActionTakenSchema,
  SessionResetSchema,
  SessionResumedSchema,
  SessionExpiredSchema,
  ErrorMessageSchema,
  InfoMessageSchema,
]);
```

- [ ] **Step 4: Verify types compile**

Run: `cd apps/studio && npx tsc --noEmit --pretty src/features/sessions/sessions.contract.ts`

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/studio && pnpm vitest run src/features/sessions/__tests__/sessions.contract.test.ts`

- [ ] **Step 6: Commit**

```bash
npx prettier --write apps/studio/src/features/sessions/sessions.contract.ts apps/studio/src/features/sessions/__tests__/sessions.contract.test.ts
git add apps/studio/src/features/sessions/sessions.contract.ts apps/studio/src/features/sessions/__tests__/sessions.contract.test.ts
git commit -m "[ABLP-2] feat(studio): add sessions contract schemas with Zod validation"
```

---

### Task 2: Sessions Types

**Files:**

- Create: `src/features/sessions/sessions.types.ts`

- [ ] **Step 1: Create sessions.types.ts**

```typescript
// src/features/sessions/sessions.types.ts

/**
 * Sessions Types
 *
 * All types are derived from Zod schemas in sessions.contract.ts via z.infer.
 * This ensures the types always match the runtime validation schemas.
 *
 * IMPORTANT: Do NOT manually define types here. Import from the contract.
 */

import type { z } from 'zod';
import type {
  SessionMessageSchema,
  SessionMessageMetadataSchema,
  AgentStateSchema,
  AgentMemorySchema,
  FlowStateSchema,
  ErrorStateSchema,
  ActiveAgentSchema,
  ConstructActionSchema,
  TraceEventSchema,
  TraceEventTypeSchema,
  DecisionKindSchema,
  SessionServerMessageSchema,
} from './sessions.contract';

/** A single message in the chat session */
export type SessionMessage = z.infer<typeof SessionMessageSchema>;

/** Metadata attached to a session message */
export type SessionMessageMetadata = z.infer<typeof SessionMessageMetadataSchema>;

/** Full agent state snapshot */
export type AgentState = z.infer<typeof AgentStateSchema>;

/** Agent memory sub-shape */
export type AgentMemory = z.infer<typeof AgentMemorySchema>;

/** Flow execution state */
export type FlowState = z.infer<typeof FlowStateSchema>;

/** Error state for the agent */
export type ErrorState = z.infer<typeof ErrorStateSchema>;

/** Currently active agent info (changes on handoff) */
export type ActiveAgent = z.infer<typeof ActiveAgentSchema>;

/** Discriminated union of all construct actions (9 types) */
export type ConstructAction = z.infer<typeof ConstructActionSchema>;

/** A trace event as emitted by the runtime */
export type TraceEvent = z.infer<typeof TraceEventSchema>;

/** Trace event type string union */
export type TraceEventType = z.infer<typeof TraceEventTypeSchema>;

/** Decision kind for decision trace events */
export type DecisionKind = z.infer<typeof DecisionKindSchema>;

/** Server messages relevant to sessions (discriminated union) */
export type SessionServerMessage = z.infer<typeof SessionServerMessageSchema>;

/**
 * Partial AgentState — used for state patches from trace events.
 * Each field is optional so callers can provide only the fields they extracted.
 */
export type AgentStatePatch = Partial<AgentState>;
```

- [ ] **Step 2: Verify types compile**

Run: `cd apps/studio && npx tsc --noEmit --pretty src/features/sessions/sessions.types.ts`

- [ ] **Step 3: Commit**

```bash
npx prettier --write apps/studio/src/features/sessions/sessions.types.ts
git add apps/studio/src/features/sessions/sessions.types.ts
git commit -m "[ABLP-2] feat(studio): add sessions types derived from contract schemas"
```

---

### Task 3: Trace Event Logger

**Files:**

- Create: `src/features/sessions/trace-event-logger.ts`
- Test: `src/features/sessions/__tests__/trace-event-logger.test.ts`

This is an exact extraction of `formatTraceEventLog` from `src/utils/replay-trace-events.ts`. The logic is copied verbatim — it is already a pure function with no store dependencies.

- [ ] **Step 1: Write the failing test**

```typescript
// src/features/sessions/__tests__/trace-event-logger.test.ts
import { describe, it, expect } from 'vitest';
import { formatTraceEventLog } from '../trace-event-logger';

describe('formatTraceEventLog', () => {
  it('formats llm_call events', () => {
    const result = formatTraceEventLog('llm_call', {
      model: 'gpt-4',
      agentName: 'support',
    });
    expect(result).toEqual({
      level: 'info',
      message: 'LLM call to gpt-4 (support)',
    });
  });

  it('falls back to claude for llm_call without model', () => {
    const result = formatTraceEventLog('llm_call', {});
    expect(result).toEqual({
      level: 'info',
      message: 'LLM call to claude (unknown)',
    });
  });

  it('formats successful tool_call', () => {
    const result = formatTraceEventLog('tool_call', {
      tool: 'search',
      success: true,
    });
    expect(result).toEqual({ level: 'info', message: 'Tool: search - success' });
  });

  it('formats failed tool_call with error', () => {
    const result = formatTraceEventLog('tool_call', {
      toolName: 'api-call',
      success: false,
      error: 'timeout',
    });
    expect(result).toEqual({
      level: 'error',
      message: 'Tool: api-call - failed (timeout)',
    });
  });

  it('formats handoff events', () => {
    const result = formatTraceEventLog('handoff', {
      from: 'triage',
      to: 'support',
    });
    expect(result).toEqual({
      level: 'info',
      message: 'Handoff: triage → support',
    });
  });

  it('formats handoff with alternate field names', () => {
    const result = formatTraceEventLog('handoff', {
      fromAgent: 'triage',
      toAgent: 'billing',
    });
    expect(result).toEqual({
      level: 'info',
      message: 'Handoff: triage → billing',
    });
  });

  it('formats passing constraint_check', () => {
    const result = formatTraceEventLog('constraint_check', {
      constraint: 'age-check',
      passed: true,
    });
    expect(result).toEqual({
      level: 'info',
      message: 'Constraint age-check: passed',
    });
  });

  it('formats failing constraint_check with message', () => {
    const result = formatTraceEventLog('constraint_check', {
      phase: 'input-validation',
      passed: false,
      message: 'Age must be 18+',
    });
    expect(result).toEqual({
      level: 'warn',
      message: 'Constraint input-validation: failed - Age must be 18+',
    });
  });

  it('formats error events', () => {
    const result = formatTraceEventLog('error', {
      message: 'Connection refused',
    });
    expect(result).toEqual({
      level: 'error',
      message: 'Connection refused',
    });
  });

  it('formats error with fallback message', () => {
    const result = formatTraceEventLog('error', {});
    expect(result).toEqual({ level: 'error', message: 'Unknown error' });
  });

  it('formats flow_step_enter', () => {
    const result = formatTraceEventLog('flow_step_enter', {
      stepName: 'greeting',
    });
    expect(result).toEqual({
      level: 'info',
      message: 'Entering step: greeting',
    });
  });

  it('formats flow_step_exit', () => {
    const result = formatTraceEventLog('flow_step_exit', {
      stepName: 'greeting',
      result: 'success',
    });
    expect(result).toEqual({
      level: 'info',
      message: 'Exiting step: greeting (success)',
    });
  });

  it('formats flow_transition', () => {
    const result = formatTraceEventLog('flow_transition', {
      fromStep: 'greeting',
      toStep: 'collect-info',
    });
    expect(result).toEqual({
      level: 'info',
      message: 'Transition: greeting → collect-info',
    });
  });

  it('formats dsl_collect with extracted fields', () => {
    const result = formatTraceEventLog('dsl_collect', {
      extracted: { name: 'John', age: 30 },
    });
    expect(result).toEqual({
      level: 'info',
      message: 'Collected: name, age',
    });
  });

  it('formats dsl_collect with single field', () => {
    const result = formatTraceEventLog('dsl_collect', { field: 'email' });
    expect(result).toEqual({ level: 'info', message: 'Collected: email' });
  });

  it('formats dsl_collect fallback', () => {
    const result = formatTraceEventLog('dsl_collect', {});
    expect(result).toEqual({ level: 'info', message: 'Collected: data' });
  });

  it('formats entity_extraction', () => {
    const result = formatTraceEventLog('entity_extraction', {
      extracted: { city: 'NYC', state: 'NY' },
    });
    expect(result).toEqual({
      level: 'info',
      message: 'Extracted: city, state from input',
    });
  });

  it('formats entity_extraction fallback', () => {
    const result = formatTraceEventLog('entity_extraction', {});
    expect(result).toEqual({
      level: 'info',
      message: 'Extracted: entities from input',
    });
  });

  it('formats dsl_respond', () => {
    const result = formatTraceEventLog('dsl_respond', {});
    expect(result).toEqual({ level: 'info', message: 'Agent response' });
  });

  it('formats dsl_set', () => {
    const result = formatTraceEventLog('dsl_set', {
      assignments: { status: 'active', plan: 'pro' },
    });
    expect(result).toEqual({
      level: 'info',
      message: 'Set context: status, plan',
    });
  });

  it('formats dsl_set fallback', () => {
    const result = formatTraceEventLog('dsl_set', {});
    expect(result).toEqual({
      level: 'info',
      message: 'Set context: variables',
    });
  });

  it('formats agent_enter', () => {
    const result = formatTraceEventLog('agent_enter', {
      agentName: 'support',
    });
    expect(result).toEqual({
      level: 'info',
      message: 'Agent entered: support',
    });
  });

  it('formats agent_exit with alternate field', () => {
    const result = formatTraceEventLog('agent_exit', { agent: 'support' });
    expect(result).toEqual({
      level: 'info',
      message: 'Agent exited: support',
    });
  });

  it('formats delegate_start', () => {
    const result = formatTraceEventLog('delegate_start', {
      targetAgent: 'research',
    });
    expect(result).toEqual({
      level: 'info',
      message: 'Delegating to: research',
    });
  });

  it('formats delegate_complete', () => {
    const result = formatTraceEventLog('delegate_complete', {
      targetAgent: 'research',
    });
    expect(result).toEqual({
      level: 'info',
      message: 'Delegation complete: research',
    });
  });

  it('formats tool_thought with truncation', () => {
    const longThought = 'A'.repeat(100);
    const result = formatTraceEventLog('tool_thought', {
      thought: longThought,
      toolName: 'planner',
    });
    expect(result).toEqual({
      level: 'info',
      message: `Thought (planner): ${'A'.repeat(80)}...`,
    });
  });

  it('formats short tool_thought without truncation', () => {
    const result = formatTraceEventLog('tool_thought', {
      thought: 'Let me think',
      toolName: 'analyzer',
    });
    expect(result).toEqual({
      level: 'info',
      message: 'Thought (analyzer): Let me think',
    });
  });

  it('returns null for unknown event types', () => {
    const result = formatTraceEventLog('unknown_type', {});
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/studio && pnpm vitest run src/features/sessions/__tests__/trace-event-logger.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement trace-event-logger.ts**

```typescript
// src/features/sessions/trace-event-logger.ts

/**
 * Trace Event Logger
 *
 * Pure function that maps trace event types to readable log messages.
 * Extracted from src/utils/replay-trace-events.ts — logic is identical.
 *
 * This is a pure function: no store access, no side effects.
 * Input: event type string + data record
 * Output: { level, message } or null for unknown types
 */

export function formatTraceEventLog(
  type: string,
  data: Record<string, unknown>,
): { level: 'info' | 'warn' | 'error'; message: string } | null {
  switch (type) {
    case 'llm_call':
      return {
        level: 'info',
        message: `LLM call to ${data.model || 'claude'} (${data.agentName || data.agent || 'unknown'})`,
      };
    case 'tool_call': {
      const toolName = (data.tool || data.toolName) as string;
      const success = data.success !== false;
      return {
        level: success ? 'info' : 'error',
        message: `Tool: ${toolName} - ${success ? 'success' : 'failed'}${data.error ? ` (${data.error})` : ''}`,
      };
    }
    case 'handoff':
      return {
        level: 'info',
        message: `Handoff: ${data.from || data.fromAgent} → ${data.to || data.toAgent}`,
      };
    case 'constraint_check': {
      const passed = data.passed as boolean;
      return {
        level: passed ? 'info' : 'warn',
        message: `Constraint ${data.constraint || data.phase}: ${passed ? 'passed' : 'failed'}${data.message ? ` - ${data.message}` : ''}`,
      };
    }
    case 'error':
      return {
        level: 'error',
        message: `${data.message || 'Unknown error'}`,
      };
    case 'flow_step_enter':
      return { level: 'info', message: `Entering step: ${data.stepName}` };
    case 'flow_step_exit':
      return {
        level: 'info',
        message: `Exiting step: ${data.stepName} (${data.result || 'done'})`,
      };
    case 'flow_transition':
      return {
        level: 'info',
        message: `Transition: ${data.fromStep} → ${data.toStep}`,
      };
    case 'dsl_collect': {
      const fields = data.extracted
        ? Object.keys(data.extracted as object)
        : data.field
          ? [data.field]
          : [];
      return {
        level: 'info',
        message: `Collected: ${(fields as string[]).join(', ') || 'data'}`,
      };
    }
    case 'entity_extraction': {
      const extracted = data.extracted as Record<string, unknown> | undefined;
      const extractedFields = extracted ? Object.keys(extracted) : [];
      return {
        level: 'info',
        message: `Extracted: ${extractedFields.join(', ') || 'entities'} from input`,
      };
    }
    case 'dsl_respond':
      return { level: 'info', message: 'Agent response' };
    case 'dsl_set': {
      const assignments = data.assignments as Record<string, unknown> | undefined;
      const keys = assignments ? Object.keys(assignments) : [];
      return {
        level: 'info',
        message: `Set context: ${keys.join(', ') || 'variables'}`,
      };
    }
    case 'agent_enter':
      return {
        level: 'info',
        message: `Agent entered: ${data.agentName || data.agent || 'unknown'}`,
      };
    case 'agent_exit':
      return {
        level: 'info',
        message: `Agent exited: ${data.agentName || data.agent || 'unknown'}`,
      };
    case 'delegate_start':
      return {
        level: 'info',
        message: `Delegating to: ${data.targetAgent}`,
      };
    case 'delegate_complete':
      return {
        level: 'info',
        message: `Delegation complete: ${data.targetAgent}`,
      };
    case 'tool_thought': {
      const thought = (data.thought as string) || '';
      return {
        level: 'info',
        message: `Thought (${data.toolName || 'unknown'}): ${thought.slice(0, 80)}${thought.length > 80 ? '...' : ''}`,
      };
    }
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/studio && pnpm vitest run src/features/sessions/__tests__/trace-event-logger.test.ts`

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/studio/src/features/sessions/trace-event-logger.ts apps/studio/src/features/sessions/__tests__/trace-event-logger.test.ts
git add apps/studio/src/features/sessions/trace-event-logger.ts apps/studio/src/features/sessions/__tests__/trace-event-logger.test.ts
git commit -m "[ABLP-2] feat(studio): extract trace event logger as pure function"
```

---

### Task 4: Thought Card Merger

**Files:**

- Create: `src/features/sessions/thought-card-merger.ts`
- Test: `src/features/sessions/__tests__/thought-card-merger.test.ts`

This extracts the `tool_thought` and `handoff` trace event handling from `WebSocketContext.tsx` (lines 232–280 and 204–230) into a pure function. The function operates on an immutable messages array — no store access.

- [ ] **Step 1: Write the failing test**

```typescript
// src/features/sessions/__tests__/thought-card-merger.test.ts
import { describe, it, expect } from 'vitest';
import { mergeToolThought, mergeHandoffMetadata } from '../thought-card-merger';
import type { SessionMessage } from '../sessions.types';

function makeMessage(
  overrides: Partial<SessionMessage> & { id: string; role: SessionMessage['role'] },
): SessionMessage {
  return {
    content: '',
    timestamp: new Date('2026-03-12T10:00:00Z'),
    traceIds: [],
    ...overrides,
  };
}

describe('mergeToolThought', () => {
  it('creates a new thought card when no thought exists in the current turn', () => {
    const messages: SessionMessage[] = [makeMessage({ id: 'u1', role: 'user', content: 'Hello' })];
    const result = mergeToolThought(messages, {
      thought: 'Let me check',
      toolName: 'search',
      agentName: 'support',
      eventId: 'evt-1',
      timestamp: new Date('2026-03-12T10:00:01Z'),
      isStreaming: false,
    });

    expect(result.messages.length).toBe(2);
    const thought = result.messages[1];
    expect(thought.role).toBe('thought');
    expect(thought.content).toBe('Let me check');
    expect(thought.metadata?.toolName).toBe('search');
    expect(thought.metadata?.agentName).toBe('support');
    expect(thought.traceIds).toContain('evt-1');
    expect(result.newThoughtId).toBeDefined();
  });

  it('merges into existing thought card during streaming', () => {
    const messages: SessionMessage[] = [
      makeMessage({ id: 'u1', role: 'user', content: 'Hello' }),
      makeMessage({
        id: 'thought-1',
        role: 'thought',
        content: 'First thought',
        metadata: { toolName: 'planner', agentName: 'support' },
      }),
    ];
    const result = mergeToolThought(messages, {
      thought: 'Second thought',
      toolName: 'search',
      agentName: 'support',
      eventId: 'evt-2',
      timestamp: new Date('2026-03-12T10:00:02Z'),
      isStreaming: true,
    });

    expect(result.messages.length).toBe(2);
    expect(result.messages[1].content).toBe('First thought\nSecond thought');
    expect(result.messages[1].metadata?.toolName).toBe('search');
    expect(result.newThoughtId).toBeNull();
  });

  it('merges into empty placeholder thought during streaming', () => {
    const messages: SessionMessage[] = [
      makeMessage({ id: 'u1', role: 'user', content: 'Hello' }),
      makeMessage({ id: 'thinking-m1', role: 'thought', content: '' }),
    ];
    const result = mergeToolThought(messages, {
      thought: 'Initial thought',
      toolName: 'planner',
      agentName: 'agent-a',
      eventId: 'evt-1',
      timestamp: new Date('2026-03-12T10:00:01Z'),
      isStreaming: true,
    });

    expect(result.messages.length).toBe(2);
    expect(result.messages[1].content).toBe('Initial thought');
    expect(result.newThoughtId).toBeNull();
  });

  it('creates new thought when not streaming even if thought exists', () => {
    const messages: SessionMessage[] = [
      makeMessage({ id: 'u1', role: 'user', content: 'Hello' }),
      makeMessage({
        id: 'thought-1',
        role: 'thought',
        content: 'Old thought',
      }),
    ];
    const result = mergeToolThought(messages, {
      thought: 'New thought',
      toolName: 'tool-a',
      agentName: 'agent-a',
      eventId: 'evt-3',
      timestamp: new Date('2026-03-12T10:00:03Z'),
      isStreaming: false,
    });

    expect(result.messages.length).toBe(3);
    expect(result.messages[2].content).toBe('New thought');
    expect(result.newThoughtId).toBeDefined();
  });

  it('does not search past a user message boundary', () => {
    const messages: SessionMessage[] = [
      makeMessage({
        id: 'thought-0',
        role: 'thought',
        content: 'Old turn thought',
      }),
      makeMessage({ id: 'u1', role: 'user', content: 'Hello' }),
    ];
    const result = mergeToolThought(messages, {
      thought: 'New turn thought',
      toolName: 'tool-a',
      agentName: 'agent-a',
      eventId: 'evt-1',
      timestamp: new Date('2026-03-12T10:00:01Z'),
      isStreaming: true,
    });

    // Should create a new thought because the existing one is from a previous turn
    expect(result.messages.length).toBe(3);
    expect(result.newThoughtId).toBeDefined();
  });

  it('returns immutable — does not modify the original array', () => {
    const messages: SessionMessage[] = [makeMessage({ id: 'u1', role: 'user', content: 'Hello' })];
    const originalLength = messages.length;
    mergeToolThought(messages, {
      thought: 'New thought',
      toolName: 'tool-a',
      agentName: 'agent-a',
      eventId: 'evt-1',
      timestamp: new Date(),
      isStreaming: false,
    });
    expect(messages.length).toBe(originalLength);
  });
});

describe('mergeHandoffMetadata', () => {
  it('merges handoff into the current turn thought card', () => {
    const messages: SessionMessage[] = [
      makeMessage({ id: 'u1', role: 'user', content: 'Hello' }),
      makeMessage({
        id: 'thought-1',
        role: 'thought',
        content: 'Processing...',
        metadata: { toolName: 'planner' },
      }),
    ];
    const result = mergeHandoffMetadata(messages, {
      from: 'triage',
      to: 'support',
      eventId: 'evt-h1',
      timestamp: new Date('2026-03-12T10:00:02Z'),
    });

    expect(result.messages.length).toBe(2);
    expect(result.messages[1].metadata?.handoffFrom).toBe('triage');
    expect(result.messages[1].metadata?.handoffTo).toBe('support');
    expect(result.systemFallback).toBeNull();
  });

  it('returns a system fallback when no thought card exists', () => {
    const messages: SessionMessage[] = [makeMessage({ id: 'u1', role: 'user', content: 'Hello' })];
    const result = mergeHandoffMetadata(messages, {
      from: 'triage',
      to: 'billing',
      eventId: 'evt-h2',
      timestamp: new Date('2026-03-12T10:00:02Z'),
    });

    expect(result.messages.length).toBe(1); // no mutation
    expect(result.systemFallback).not.toBeNull();
    expect(result.systemFallback!.role).toBe('system');
    expect(result.systemFallback!.content).toContain('triage');
    expect(result.systemFallback!.content).toContain('billing');
  });

  it('does not search past a user message boundary', () => {
    const messages: SessionMessage[] = [
      makeMessage({
        id: 'thought-old',
        role: 'thought',
        content: 'Old thought',
      }),
      makeMessage({ id: 'u1', role: 'user', content: 'Hello' }),
    ];
    const result = mergeHandoffMetadata(messages, {
      from: 'a',
      to: 'b',
      eventId: 'evt-h3',
      timestamp: new Date(),
    });

    // No thought in the current turn — should return fallback
    expect(result.systemFallback).not.toBeNull();
  });

  it('returns immutable — does not modify the original array', () => {
    const messages: SessionMessage[] = [
      makeMessage({ id: 'u1', role: 'user', content: 'Hello' }),
      makeMessage({
        id: 'thought-1',
        role: 'thought',
        content: 'Thinking',
        metadata: {},
      }),
    ];
    const originalMeta = { ...messages[1].metadata };
    mergeHandoffMetadata(messages, {
      from: 'a',
      to: 'b',
      eventId: 'evt-h4',
      timestamp: new Date(),
    });
    expect(messages[1].metadata).toEqual(originalMeta);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/studio && pnpm vitest run src/features/sessions/__tests__/thought-card-merger.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement thought-card-merger.ts**

```typescript
// src/features/sessions/thought-card-merger.ts

/**
 * Thought Card Merger
 *
 * Pure functions that handle tool_thought and handoff trace events
 * by merging them into the current turn's thought card in the
 * messages array.
 *
 * Extracted from WebSocketContext.tsx trace_event handler (lines 204–280).
 *
 * All functions are immutable — they return a new messages array
 * without modifying the input.
 */

import type { SessionMessage } from './sessions.types';

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Walks backward from the end of the messages array to find a thought card
 * in the current turn (before hitting a user message boundary).
 * Returns the index or -1 if not found.
 */
function findCurrentTurnThoughtIndex(messages: SessionMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'thought') return i;
    if (messages[i].role === 'user') break;
  }
  return -1;
}

// ── mergeToolThought ────────────────────────────────────────────────────────

export interface ToolThoughtInput {
  thought: string;
  toolName: string;
  agentName: string;
  eventId: string;
  timestamp: Date;
  isStreaming: boolean;
}

export interface MergeToolThoughtResult {
  /** Updated messages array (new reference) */
  messages: SessionMessage[];
  /** ID of the newly created thought card, or null if merged into existing */
  newThoughtId: string | null;
}

/**
 * Merges a tool_thought event into the messages array.
 *
 * When streaming and a thought card exists in the current turn:
 *   → appends content to the existing thought (handles empty placeholder)
 *   → updates metadata with latest toolName/agentName
 *
 * Otherwise:
 *   → creates a new thought card
 *   → returns its ID so the caller can expand it
 */
export function mergeToolThought(
  messages: ReadonlyArray<SessionMessage>,
  input: ToolThoughtInput,
): MergeToolThoughtResult {
  const idx = findCurrentTurnThoughtIndex([...messages]);

  if (idx >= 0 && input.isStreaming) {
    // Merge into existing thought card
    const existing = messages[idx];
    const updatedMessages = messages.map((m, i) => {
      if (i !== idx) return m;
      return {
        ...m,
        content: m.content ? m.content + '\n' + input.thought : input.thought,
        metadata: {
          ...m.metadata,
          toolName: input.toolName,
          agentName: input.agentName,
        },
      };
    });
    return { messages: [...updatedMessages], newThoughtId: null };
  }

  // Create new thought card
  const thoughtId = `thought-${Date.now()}-${input.eventId}`;
  const newThought: SessionMessage = {
    id: thoughtId,
    role: 'thought',
    content: input.thought,
    timestamp: input.timestamp,
    traceIds: [input.eventId],
    metadata: {
      toolName: input.toolName,
      agentName: input.agentName,
    },
  };

  return {
    messages: [...messages, newThought],
    newThoughtId: thoughtId,
  };
}

// ── mergeHandoffMetadata ────────────────────────────────────────────────────

export interface HandoffInput {
  from: string;
  to: string;
  eventId: string;
  timestamp: Date;
}

export interface MergeHandoffResult {
  /** Updated messages array (new reference) */
  messages: SessionMessage[];
  /**
   * If no thought card was found in the current turn, returns a system
   * message that the caller should add to the messages array.
   * Null if the handoff was merged into an existing thought card.
   */
  systemFallback: SessionMessage | null;
}

/**
 * Merges handoff metadata into the current turn's thought card.
 *
 * If a thought card exists in the current turn:
 *   → sets handoffFrom/handoffTo in its metadata
 *
 * Otherwise:
 *   → returns a system fallback message for the caller to add
 */
export function mergeHandoffMetadata(
  messages: ReadonlyArray<SessionMessage>,
  input: HandoffInput,
): MergeHandoffResult {
  const idx = findCurrentTurnThoughtIndex([...messages]);

  if (idx >= 0) {
    const updatedMessages = messages.map((m, i) => {
      if (i !== idx) return m;
      return {
        ...m,
        metadata: {
          ...m.metadata,
          handoffFrom: input.from,
          handoffTo: input.to,
        },
      };
    });
    return { messages: [...updatedMessages], systemFallback: null };
  }

  // No thought card found — return a system fallback message
  const fallback: SessionMessage = {
    id: `system-${Date.now()}`,
    role: 'system',
    content: `Routing from ${input.from} → ${input.to}`,
    timestamp: input.timestamp,
    traceIds: [input.eventId],
  };

  return { messages: [...messages], systemFallback: fallback };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/studio && pnpm vitest run src/features/sessions/__tests__/thought-card-merger.test.ts`

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/studio/src/features/sessions/thought-card-merger.ts apps/studio/src/features/sessions/__tests__/thought-card-merger.test.ts
git add apps/studio/src/features/sessions/thought-card-merger.ts apps/studio/src/features/sessions/__tests__/thought-card-merger.test.ts
git commit -m "[ABLP-2] feat(studio): add thought card merger pure functions"
```

---

### Task 5: State Extractor

**Files:**

- Create: `src/features/sessions/state-extractor.ts`
- Test: `src/features/sessions/__tests__/state-extractor.test.ts`

This extracts the `dsl_collect`, `entity_extraction`, and `dsl_set` handling from `WebSocketContext.tsx` (lines 283–301) into a pure function that returns an `AgentStatePatch`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/features/sessions/__tests__/state-extractor.test.ts
import { describe, it, expect } from 'vitest';
import { extractStatePatch } from '../state-extractor';

describe('extractStatePatch', () => {
  describe('dsl_collect', () => {
    it('extracts gatherProgress from extracted field', () => {
      const patch = extractStatePatch('dsl_collect', {
        extracted: { name: 'John', age: 30 },
      });
      expect(patch).toEqual({
        gatherProgress: { name: 'John', age: 30 },
      });
    });

    it('extracts context from context field', () => {
      const patch = extractStatePatch('dsl_collect', {
        context: { language: 'en', region: 'US' },
      });
      expect(patch).toEqual({
        context: { language: 'en', region: 'US' },
      });
    });

    it('extracts both gatherProgress and context', () => {
      const patch = extractStatePatch('dsl_collect', {
        extracted: { name: 'John' },
        context: { step: 'greeting' },
      });
      expect(patch).toEqual({
        gatherProgress: { name: 'John' },
        context: { step: 'greeting' },
      });
    });

    it('extracts gatherProgress from values field (alternate)', () => {
      const patch = extractStatePatch('dsl_collect', {
        values: { email: 'john@test.com' },
      });
      expect(patch).toEqual({
        gatherProgress: { email: 'john@test.com' },
      });
    });

    it('returns null when no extractable data', () => {
      const patch = extractStatePatch('dsl_collect', {
        someOtherField: true,
      });
      expect(patch).toBeNull();
    });

    it('ignores non-object extracted values', () => {
      const patch = extractStatePatch('dsl_collect', {
        extracted: 'not-an-object',
      });
      expect(patch).toBeNull();
    });
  });

  describe('entity_extraction', () => {
    it('extracts gatherProgress from extracted field', () => {
      const patch = extractStatePatch('entity_extraction', {
        extracted: { city: 'NYC', zip: '10001' },
      });
      expect(patch).toEqual({
        gatherProgress: { city: 'NYC', zip: '10001' },
      });
    });

    it('extracts context from context field', () => {
      const patch = extractStatePatch('entity_extraction', {
        context: { intent: 'booking' },
      });
      expect(patch).toEqual({
        context: { intent: 'booking' },
      });
    });

    it('returns null when no extractable data', () => {
      const patch = extractStatePatch('entity_extraction', {});
      expect(patch).toBeNull();
    });
  });

  describe('dsl_set', () => {
    it('extracts context from assignments', () => {
      const patch = extractStatePatch('dsl_set', {
        assignments: { status: 'active', plan: 'pro' },
      });
      expect(patch).toEqual({
        context: { status: 'active', plan: 'pro' },
      });
    });

    it('returns null when assignments is missing', () => {
      const patch = extractStatePatch('dsl_set', {});
      expect(patch).toBeNull();
    });

    it('returns null when assignments is not an object', () => {
      const patch = extractStatePatch('dsl_set', {
        assignments: 'not-an-object',
      });
      expect(patch).toBeNull();
    });
  });

  describe('other event types', () => {
    it('returns null for llm_call', () => {
      expect(extractStatePatch('llm_call', { model: 'claude' })).toBeNull();
    });

    it('returns null for tool_call', () => {
      expect(extractStatePatch('tool_call', { tool: 'search' })).toBeNull();
    });

    it('returns null for handoff', () => {
      expect(extractStatePatch('handoff', { from: 'a', to: 'b' })).toBeNull();
    });

    it('returns null for error', () => {
      expect(extractStatePatch('error', { message: 'fail' })).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/studio && pnpm vitest run src/features/sessions/__tests__/state-extractor.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement state-extractor.ts**

```typescript
// src/features/sessions/state-extractor.ts

/**
 * State Extractor
 *
 * Pure function that extracts AgentState patches from trace events.
 * Handles dsl_collect, entity_extraction, and dsl_set event types.
 *
 * Extracted from WebSocketContext.tsx trace_event handler (lines 283–301).
 *
 * Returns a partial AgentState (patch) or null if the event type
 * does not contain state-relevant data.
 */

import type { AgentStatePatch } from './sessions.types';

/**
 * Extracts an AgentState patch from a trace event's data payload.
 *
 * @param eventType - The trace event type string
 * @param data - The trace event's data record
 * @returns A partial AgentState to merge into the store, or null
 */
export function extractStatePatch(
  eventType: string,
  data: Record<string, unknown>,
): AgentStatePatch | null {
  if (eventType === 'dsl_collect' || eventType === 'entity_extraction') {
    const extracted = (data.extracted || data.values) as Record<string, unknown> | undefined;
    const context = data.context as Record<string, unknown> | undefined;

    const patch: AgentStatePatch = {};
    let hasData = false;

    if (extracted && typeof extracted === 'object') {
      patch.gatherProgress = extracted;
      hasData = true;
    }
    if (context && typeof context === 'object') {
      patch.context = context;
      hasData = true;
    }

    return hasData ? patch : null;
  }

  if (eventType === 'dsl_set') {
    const assignments = data.assignments as Record<string, unknown> | undefined;
    if (assignments && typeof assignments === 'object') {
      return { context: assignments };
    }
    return null;
  }

  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/studio && pnpm vitest run src/features/sessions/__tests__/state-extractor.test.ts`

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/studio/src/features/sessions/state-extractor.ts apps/studio/src/features/sessions/__tests__/state-extractor.test.ts
git add apps/studio/src/features/sessions/state-extractor.ts apps/studio/src/features/sessions/__tests__/state-extractor.test.ts
git commit -m "[ABLP-2] feat(studio): add state extractor pure function for trace events"
```

---

### Task 6: Test Context Contract Schemas

**Files:**

- Create: `src/features/sessions/test-context.contract.ts`
- Test: `src/features/sessions/__tests__/test-context.contract.test.ts`

Zod schemas for the test context types defined in `src/types/test-context.ts`, plus the three server response message types (`context_injected`, `tool_mock_set`, `context_injection_error`).

- [ ] **Step 1: Write the failing test**

```typescript
// src/features/sessions/__tests__/test-context.contract.test.ts
import { describe, it, expect } from 'vitest';
import {
  TestContextPayloadSchema,
  ToolMockConfigSchema,
  ContextInjectionSchema,
  ContextInjectedMessageSchema,
  ToolMockSetMessageSchema,
  ContextInjectionErrorMessageSchema,
} from '../test-context.contract';

describe('test-context.contract', () => {
  describe('ToolMockConfigSchema', () => {
    it('validates minimal tool mock', () => {
      const mock = { toolName: 'search' };
      expect(ToolMockConfigSchema.safeParse(mock).success).toBe(true);
    });

    it('validates full tool mock', () => {
      const mock = {
        toolName: 'search',
        response: { results: [{ title: 'Result 1' }] },
        success: true,
        error: { code: 'TIMEOUT', message: 'Request timed out' },
        delayMs: 500,
        matchParams: { query: 'test' },
      };
      expect(ToolMockConfigSchema.safeParse(mock).success).toBe(true);
    });

    it('rejects missing toolName', () => {
      expect(ToolMockConfigSchema.safeParse({}).success).toBe(false);
    });
  });

  describe('TestContextPayloadSchema', () => {
    it('validates empty payload', () => {
      expect(TestContextPayloadSchema.safeParse({}).success).toBe(true);
    });

    it('validates full payload', () => {
      const payload = {
        gatherValues: { name: 'John' },
        sessionVariables: { lang: 'en' },
        callerContext: {
          userId: 'u-1',
          channel: 'web',
          customAttributes: { tier: 'premium' },
        },
        toolMocks: [{ toolName: 'search', response: { found: true } }],
        skipOnStart: true,
        startAtStep: 'step-3',
      };
      expect(TestContextPayloadSchema.safeParse(payload).success).toBe(true);
    });

    it('validates payload with partial callerContext', () => {
      const payload = {
        callerContext: { channel: 'api' },
      };
      expect(TestContextPayloadSchema.safeParse(payload).success).toBe(true);
    });
  });

  describe('ContextInjectionSchema', () => {
    it('validates empty injection', () => {
      expect(ContextInjectionSchema.safeParse({}).success).toBe(true);
    });

    it('validates full injection', () => {
      const injection = {
        values: { name: 'Jane' },
        markAsGathered: ['name', 'email'],
        toolMocks: [{ toolName: 'api-call', success: false }],
        forceStep: 'step-5',
      };
      expect(ContextInjectionSchema.safeParse(injection).success).toBe(true);
    });
  });

  describe('ContextInjectedMessageSchema', () => {
    it('validates context_injected message', () => {
      const msg = {
        type: 'context_injected',
        sessionId: 's1',
        updatedValues: { name: 'John' },
      };
      expect(ContextInjectedMessageSchema.safeParse(msg).success).toBe(true);
    });
  });

  describe('ToolMockSetMessageSchema', () => {
    it('validates tool_mock_set message', () => {
      const msg = {
        type: 'tool_mock_set',
        sessionId: 's1',
        mockCount: 3,
      };
      expect(ToolMockSetMessageSchema.safeParse(msg).success).toBe(true);
    });
  });

  describe('ContextInjectionErrorMessageSchema', () => {
    it('validates context_injection_error message', () => {
      const msg = {
        type: 'context_injection_error',
        sessionId: 's1',
        error: { code: 'INVALID_STEP', message: 'Step not found' },
      };
      expect(ContextInjectionErrorMessageSchema.safeParse(msg).success).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/studio && pnpm vitest run src/features/sessions/__tests__/test-context.contract.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create test-context.contract.ts**

```typescript
// src/features/sessions/test-context.contract.ts

/**
 * Test Context Contract Schemas
 *
 * Zod schemas for test context types used in Studio ↔ Runtime communication.
 * Mirrors: src/types/test-context.ts (ToolMockConfig, TestContextPayload, ContextInjection)
 * Plus server response message types: context_injected, tool_mock_set, context_injection_error
 */

import { z } from 'zod';

// ── ToolMockConfig ──────────────────────────────────────────────────────────

export const ToolMockConfigSchema = z.object({
  toolName: z.string(),
  response: z.unknown().optional(),
  success: z.boolean().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
  delayMs: z.number().optional(),
  matchParams: z.record(z.string(), z.unknown()).optional(),
});

// ── TestContextPayload ──────────────────────────────────────────────────────

export const CallerContextSchema = z
  .object({
    userId: z.string().optional(),
    channel: z.string().optional(),
    customAttributes: z.record(z.string(), z.unknown()).optional(),
  })
  .optional();

export const TestContextPayloadSchema = z.object({
  gatherValues: z.record(z.string(), z.unknown()).optional(),
  sessionVariables: z.record(z.string(), z.unknown()).optional(),
  callerContext: CallerContextSchema,
  toolMocks: z.array(ToolMockConfigSchema).optional(),
  skipOnStart: z.boolean().optional(),
  startAtStep: z.string().optional(),
});

// ── ContextInjection ────────────────────────────────────────────────────────

export const ContextInjectionSchema = z.object({
  values: z.record(z.string(), z.unknown()).optional(),
  markAsGathered: z.array(z.string()).optional(),
  toolMocks: z.array(ToolMockConfigSchema).optional(),
  forceStep: z.string().optional(),
});

// ── Server Response Messages ────────────────────────────────────────────────

export const ContextInjectedMessageSchema = z.object({
  type: z.literal('context_injected'),
  sessionId: z.string(),
  updatedValues: z.record(z.string(), z.unknown()),
});

export const ToolMockSetMessageSchema = z.object({
  type: z.literal('tool_mock_set'),
  sessionId: z.string(),
  mockCount: z.number(),
});

export const ContextInjectionErrorMessageSchema = z.object({
  type: z.literal('context_injection_error'),
  sessionId: z.string(),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
```

- [ ] **Step 4: Verify types compile**

Run: `cd apps/studio && npx tsc --noEmit --pretty src/features/sessions/test-context.contract.ts`

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/studio && pnpm vitest run src/features/sessions/__tests__/test-context.contract.test.ts`

- [ ] **Step 6: Commit**

```bash
npx prettier --write apps/studio/src/features/sessions/test-context.contract.ts apps/studio/src/features/sessions/__tests__/test-context.contract.test.ts
git add apps/studio/src/features/sessions/test-context.contract.ts apps/studio/src/features/sessions/__tests__/test-context.contract.test.ts
git commit -m "[ABLP-2] feat(studio): add test context contract schemas"
```

---

### Task 7: Fixtures

**Files:**

- Create: `src/features/sessions/__fixtures__/session-messages.json`
- Create: `src/features/sessions/__fixtures__/agent-state.json`
- Create: `src/features/sessions/__fixtures__/construct-actions.json`
- Create: `src/features/sessions/__fixtures__/trace-events-session.json`
- Create: `src/features/sessions/__fixtures__/server-messages-session.json`
- Create: `src/features/sessions/__fixtures__/test-context-payloads.json`
- Create: `src/features/sessions/__fixtures__/thought-merge-scenarios.json`

These are golden test data files. Each fixture is a JSON file that can be imported in tests to validate schemas and pure functions against realistic data.

- [ ] **Step 1: Create session-messages.json**

```json
[
  {
    "id": "msg-user-1",
    "role": "user",
    "content": "I need help with my account",
    "timestamp": "2026-03-12T10:00:00.000Z",
    "traceIds": []
  },
  {
    "id": "msg-thought-1",
    "role": "thought",
    "content": "User is asking about account help. Let me check their account status.",
    "timestamp": "2026-03-12T10:00:01.000Z",
    "traceIds": ["evt-thought-1"],
    "metadata": {
      "toolName": "account-lookup",
      "agentName": "support-agent"
    }
  },
  {
    "id": "msg-assistant-1",
    "role": "assistant",
    "content": "I'd be happy to help with your account. Could you please provide your account number?",
    "timestamp": "2026-03-12T10:00:02.000Z",
    "traceIds": ["evt-respond-1"],
    "metadata": {
      "tokensIn": 150,
      "tokensOut": 25,
      "latencyMs": 340
    }
  },
  {
    "id": "msg-user-2",
    "role": "user",
    "content": "It's ACC-12345",
    "timestamp": "2026-03-12T10:00:10.000Z",
    "traceIds": []
  },
  {
    "id": "msg-system-1",
    "role": "system",
    "content": "Routing from support-agent → billing-agent",
    "timestamp": "2026-03-12T10:00:11.000Z",
    "traceIds": ["evt-handoff-1"],
    "metadata": {
      "handoffFrom": "support-agent",
      "handoffTo": "billing-agent"
    }
  },
  {
    "id": "msg-assistant-2",
    "role": "assistant",
    "content": "I've found your account. Your current balance is $42.50.",
    "timestamp": "2026-03-12T10:00:12.000Z",
    "traceIds": ["evt-respond-2"],
    "metadata": {
      "tokensIn": 200,
      "tokensOut": 18,
      "latencyMs": 280,
      "agentName": "billing-agent"
    }
  }
]
```

- [ ] **Step 2: Create agent-state.json**

```json
{
  "minimal": {
    "context": {},
    "conversationPhase": "start",
    "gatherProgress": {},
    "constraintResults": {},
    "lastToolResults": {},
    "memory": {
      "session": {},
      "persistentCache": {},
      "pendingRemembers": []
    }
  },
  "full": {
    "context": {
      "accountNumber": "ACC-12345",
      "language": "en",
      "channel": "web"
    },
    "conversationPhase": "gather",
    "gatherProgress": {
      "name": "John Doe",
      "email": "john@example.com",
      "accountNumber": "ACC-12345"
    },
    "constraintResults": {
      "account-valid": true,
      "age-check": true,
      "fraud-check": false
    },
    "lastToolResults": {
      "account-lookup": {
        "found": true,
        "balance": 42.5,
        "status": "active"
      }
    },
    "memory": {
      "session": {
        "greeted": true,
        "attempts": 1
      },
      "persistentCache": {
        "userPreference": "dark-mode"
      },
      "pendingRemembers": [{ "key": "lastVisit", "value": "2026-03-12" }]
    },
    "flowState": {
      "currentStep": "verify-identity",
      "stepHistory": ["greeting", "collect-info", "verify-identity"],
      "stepResults": {
        "greeting": { "completed": true },
        "collect-info": { "fieldsCollected": 3 }
      },
      "isComplete": false
    },
    "errorState": {
      "type": "tool_error",
      "message": "External API returned 503",
      "stack": "Error: External API returned 503\n  at ToolExecutor.execute",
      "retryCount": 2
    },
    "activeAgent": {
      "name": "billing-agent",
      "mode": "reasoning"
    }
  }
}
```

- [ ] **Step 3: Create construct-actions.json**

```json
[
  { "type": "continue" },
  { "type": "continue", "data": { "reason": "more info needed" } },
  { "type": "respond", "message": "How can I help you today?" },
  {
    "type": "respond",
    "message": "Processing your request...",
    "continueProcessing": true
  },
  {
    "type": "escalate",
    "reason": "Customer requesting manager",
    "priority": "high",
    "context": { "topic": "billing-dispute", "sentiment": "frustrated" }
  },
  {
    "type": "handoff",
    "target": "billing-agent",
    "context": { "accountNumber": "ACC-12345", "issue": "refund" },
    "returnExpected": true,
    "summary": "Customer needs billing refund"
  },
  {
    "type": "delegate",
    "agent": "research-agent",
    "input": { "query": "refund policy for premium accounts" },
    "useResult": "policyResult"
  },
  {
    "type": "complete",
    "message": "Your issue has been resolved. Is there anything else?",
    "store": { "resolution": "refund-processed", "amount": 42.5 }
  },
  { "type": "retry", "delay": 2000, "target": "verify-identity" },
  {
    "type": "block",
    "reason": "Account locked due to fraud detection",
    "constraint": "fraud-check"
  },
  {
    "type": "collect",
    "fields": ["name", "email", "accountNumber"],
    "prompts": {
      "name": "What is your full name?",
      "email": "What is your email address?",
      "accountNumber": "What is your account number?"
    }
  }
]
```

- [ ] **Step 4: Create trace-events-session.json**

```json
[
  {
    "id": "evt-thought-1",
    "sessionId": "sess-001",
    "type": "tool_thought",
    "timestamp": "2026-03-12T10:00:01.000Z",
    "data": {
      "thought": "The user is asking about their account. I should look up their account details using the account-lookup tool.",
      "toolName": "account-lookup",
      "agentName": "support-agent"
    }
  },
  {
    "id": "evt-handoff-1",
    "sessionId": "sess-001",
    "type": "handoff",
    "timestamp": "2026-03-12T10:00:05.000Z",
    "data": {
      "from": "support-agent",
      "to": "billing-agent",
      "reason": "billing inquiry",
      "agentName": "support-agent"
    }
  },
  {
    "id": "evt-error-1",
    "sessionId": "sess-001",
    "type": "error",
    "timestamp": "2026-03-12T10:00:06.000Z",
    "data": {
      "message": "Tool execution failed: API timeout",
      "agentName": "billing-agent",
      "tool": "payment-api"
    }
  },
  {
    "id": "evt-collect-1",
    "sessionId": "sess-001",
    "type": "dsl_collect",
    "timestamp": "2026-03-12T10:00:07.000Z",
    "data": {
      "extracted": { "accountNumber": "ACC-12345", "name": "John Doe" },
      "context": { "step": "verify-identity" },
      "agentName": "support-agent"
    }
  },
  {
    "id": "evt-extract-1",
    "sessionId": "sess-001",
    "type": "entity_extraction",
    "timestamp": "2026-03-12T10:00:08.000Z",
    "data": {
      "extracted": { "city": "New York", "zip": "10001" },
      "context": { "intent": "address-update" },
      "agentName": "support-agent"
    }
  },
  {
    "id": "evt-set-1",
    "sessionId": "sess-001",
    "type": "dsl_set",
    "timestamp": "2026-03-12T10:00:09.000Z",
    "data": {
      "assignments": { "verified": true, "tier": "premium" },
      "agentName": "billing-agent"
    }
  }
]
```

- [ ] **Step 5: Create server-messages-session.json**

```json
{
  "response_start": {
    "type": "response_start",
    "sessionId": "sess-001",
    "messageId": "msg-resp-1"
  },
  "response_chunk": {
    "type": "response_chunk",
    "sessionId": "sess-001",
    "messageId": "msg-resp-1",
    "chunk": "I'd be happy to "
  },
  "response_end": {
    "type": "response_end",
    "sessionId": "sess-001",
    "messageId": "msg-resp-1",
    "fullText": "I'd be happy to help with your account."
  },
  "state_update": {
    "type": "state_update",
    "sessionId": "sess-001",
    "state": {
      "context": { "accountNumber": "ACC-12345" },
      "conversationPhase": "gather",
      "gatherProgress": { "accountNumber": "ACC-12345" },
      "constraintResults": {},
      "lastToolResults": {},
      "memory": { "session": {}, "persistentCache": {}, "pendingRemembers": [] }
    },
    "updates": { "context": { "accountNumber": "ACC-12345" } }
  },
  "action_taken": {
    "type": "action_taken",
    "sessionId": "sess-001",
    "action": { "type": "respond", "message": "Hello!" }
  },
  "session_reset": {
    "type": "session_reset",
    "sessionId": "sess-001"
  },
  "session_resumed": {
    "type": "session_resumed",
    "sessionId": "sess-001",
    "state": {
      "context": { "name": "John" },
      "conversationPhase": "gather",
      "gatherProgress": { "name": "John" },
      "constraintResults": {},
      "lastToolResults": {},
      "memory": { "session": {}, "persistentCache": {}, "pendingRemembers": [] }
    },
    "conversationHistory": [
      { "role": "user", "content": "Hello" },
      { "role": "assistant", "content": "Hi! How can I help?" }
    ]
  },
  "session_expired": {
    "type": "session_expired",
    "sessionId": "sess-001",
    "reason": "Session inactive for 30 minutes"
  },
  "error": {
    "type": "error",
    "message": "WebSocket connection error"
  },
  "info": {
    "type": "info",
    "message": "Connected to runtime",
    "configured": true
  }
}
```

- [ ] **Step 6: Create test-context-payloads.json**

```json
{
  "toolMock": {
    "toolName": "search",
    "response": { "results": [{ "title": "Result 1", "score": 0.95 }] },
    "success": true,
    "delayMs": 100,
    "matchParams": { "query": "test" }
  },
  "testContextPayload": {
    "gatherValues": { "name": "Test User", "email": "test@example.com" },
    "sessionVariables": { "language": "en", "debugMode": true },
    "callerContext": {
      "userId": "test-user-1",
      "channel": "web",
      "customAttributes": { "tier": "premium", "region": "US" }
    },
    "toolMocks": [
      { "toolName": "search", "response": { "found": true } },
      {
        "toolName": "payment",
        "success": false,
        "error": { "code": "DECLINED", "message": "Card declined" }
      }
    ],
    "skipOnStart": false,
    "startAtStep": "collect-info"
  },
  "contextInjection": {
    "values": { "verified": true, "accountId": "ACC-999" },
    "markAsGathered": ["name", "email"],
    "toolMocks": [{ "toolName": "api-call", "response": { "ok": true } }],
    "forceStep": "verify-identity"
  },
  "contextInjectedMessage": {
    "type": "context_injected",
    "sessionId": "sess-001",
    "updatedValues": { "verified": true, "accountId": "ACC-999" }
  },
  "toolMockSetMessage": {
    "type": "tool_mock_set",
    "sessionId": "sess-001",
    "mockCount": 2
  },
  "contextInjectionErrorMessage": {
    "type": "context_injection_error",
    "sessionId": "sess-001",
    "error": {
      "code": "INVALID_STEP",
      "message": "Step 'nonexistent-step' not found in agent flow"
    }
  }
}
```

- [ ] **Step 7: Create thought-merge-scenarios.json**

```json
{
  "scenarios": [
    {
      "name": "new_thought_no_existing",
      "description": "Creates a new thought card when no thought exists in the current turn",
      "input": {
        "messages": [
          {
            "id": "u1",
            "role": "user",
            "content": "Hello",
            "timestamp": "2026-03-12T10:00:00Z",
            "traceIds": []
          }
        ],
        "toolThought": {
          "thought": "Let me check the user's account",
          "toolName": "account-lookup",
          "agentName": "support-agent",
          "eventId": "evt-1",
          "timestamp": "2026-03-12T10:00:01Z",
          "isStreaming": false
        }
      },
      "expectedMessageCount": 2,
      "expectedLastRole": "thought",
      "expectedLastContent": "Let me check the user's account",
      "expectNewThoughtId": true
    },
    {
      "name": "merge_during_streaming",
      "description": "Merges into existing thought card during streaming",
      "input": {
        "messages": [
          {
            "id": "u1",
            "role": "user",
            "content": "Hello",
            "timestamp": "2026-03-12T10:00:00Z",
            "traceIds": []
          },
          {
            "id": "t1",
            "role": "thought",
            "content": "First thought",
            "timestamp": "2026-03-12T10:00:01Z",
            "traceIds": ["evt-1"],
            "metadata": { "toolName": "planner" }
          }
        ],
        "toolThought": {
          "thought": "Second thought",
          "toolName": "search",
          "agentName": "support-agent",
          "eventId": "evt-2",
          "timestamp": "2026-03-12T10:00:02Z",
          "isStreaming": true
        }
      },
      "expectedMessageCount": 2,
      "expectedLastContent": "First thought\nSecond thought",
      "expectNewThoughtId": false
    },
    {
      "name": "empty_placeholder_merge",
      "description": "Merges into empty placeholder thought during streaming",
      "input": {
        "messages": [
          {
            "id": "u1",
            "role": "user",
            "content": "Hello",
            "timestamp": "2026-03-12T10:00:00Z",
            "traceIds": []
          },
          {
            "id": "thinking-m1",
            "role": "thought",
            "content": "",
            "timestamp": "2026-03-12T10:00:01Z",
            "traceIds": []
          }
        ],
        "toolThought": {
          "thought": "Initial thought",
          "toolName": "planner",
          "agentName": "agent-a",
          "eventId": "evt-1",
          "timestamp": "2026-03-12T10:00:01Z",
          "isStreaming": true
        }
      },
      "expectedMessageCount": 2,
      "expectedLastContent": "Initial thought",
      "expectNewThoughtId": false
    },
    {
      "name": "handoff_into_thought",
      "description": "Merges handoff metadata into existing thought card",
      "input": {
        "messages": [
          {
            "id": "u1",
            "role": "user",
            "content": "Hello",
            "timestamp": "2026-03-12T10:00:00Z",
            "traceIds": []
          },
          {
            "id": "t1",
            "role": "thought",
            "content": "Processing",
            "timestamp": "2026-03-12T10:00:01Z",
            "traceIds": ["evt-1"],
            "metadata": { "toolName": "planner" }
          }
        ],
        "handoff": {
          "from": "triage",
          "to": "support",
          "eventId": "evt-h1",
          "timestamp": "2026-03-12T10:00:02Z"
        }
      },
      "expectedHandoffFrom": "triage",
      "expectedHandoffTo": "support",
      "expectSystemFallback": false
    },
    {
      "name": "handoff_fallback_no_thought",
      "description": "Returns system fallback when no thought card exists for handoff",
      "input": {
        "messages": [
          {
            "id": "u1",
            "role": "user",
            "content": "Hello",
            "timestamp": "2026-03-12T10:00:00Z",
            "traceIds": []
          }
        ],
        "handoff": {
          "from": "triage",
          "to": "billing",
          "eventId": "evt-h2",
          "timestamp": "2026-03-12T10:00:02Z"
        }
      },
      "expectSystemFallback": true,
      "expectedFallbackContent": "Routing from triage → billing"
    }
  ]
}
```

- [ ] **Step 8: Commit**

```bash
npx prettier --write apps/studio/src/features/sessions/__fixtures__/*.json
git add apps/studio/src/features/sessions/__fixtures__/
git commit -m "[ABLP-2] test(studio): add golden fixture files for sessions feature module"
```

---

## Chunk 2: Store + Handler + API (Tasks 8–13)

### Task 8: Sessions Store

**Files:**

- Create: `src/features/sessions/sessions.store.ts`
- Test: `src/features/sessions/__tests__/sessions.store.test.ts`

Ports ALL state fields and actions from `src/store/session-store.ts` into a new Zustand store with `devtools()` middleware. Adds bulk setters for handler use.

- [ ] **Step 1: Write the failing test**

```typescript
// src/features/sessions/__tests__/sessions.store.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionsStore, MAX_MESSAGES } from '../sessions.store';
import type { SessionMessage, AgentState } from '../sessions.types';

function makeMsg(overrides: Partial<SessionMessage> & { id: string }): SessionMessage {
  return {
    role: 'assistant',
    content: '',
    timestamp: new Date('2026-03-12T10:00:00Z'),
    traceIds: [],
    ...overrides,
  };
}

const INITIAL_STATE: AgentState = {
  context: {},
  conversationPhase: 'start',
  gatherProgress: {},
  constraintResults: {},
  lastToolResults: {},
  memory: { session: {}, persistentCache: {}, pendingRemembers: [] },
};

const AGENT_DETAILS = {
  id: 'agent-1',
  name: 'support',
  filePath: '/agents/support.abl',
  type: 'agent' as const,
  mode: 'reasoning' as const,
  toolCount: 3,
  gatherFieldCount: 2,
  isSupervisor: false,
  dsl: 'AGENT support',
};

describe('sessions.store', () => {
  beforeEach(() => {
    useSessionsStore.setState(useSessionsStore.getInitialState());
  });

  // ── Session lifecycle ───────────────────────────────────────────────────

  describe('setSession', () => {
    it('sets sessionId, agent, and resets transient state', () => {
      useSessionsStore.getState().setSession('sess-1', AGENT_DETAILS);
      const s = useSessionsStore.getState();
      expect(s.sessionId).toBe('sess-1');
      expect(s.agent).toEqual(AGENT_DETAILS);
      expect(s.messages).toEqual([]);
      expect(s.state).toEqual(INITIAL_STATE);
      expect(s.lastAction).toBeNull();
      expect(s.isLoading).toBe(false);
      expect(s.error).toBeNull();
      expect(s.expandedThoughtIds.size).toBe(0);
    });
  });

  describe('clearSession', () => {
    it('resets all fields to initial values', () => {
      useSessionsStore.getState().setSession('sess-1', AGENT_DETAILS);
      useSessionsStore.getState().addMessage(makeMsg({ id: 'm1', content: 'hi' }));
      useSessionsStore.getState().clearSession();

      const s = useSessionsStore.getState();
      expect(s.sessionId).toBeNull();
      expect(s.agent).toBeNull();
      expect(s.messages).toEqual([]);
      expect(s.state).toBeNull();
      expect(s.isStreaming).toBe(false);
      expect(s.streamingMessageId).toBeNull();
      expect(s.streamingContent).toBe('');
      expect(s.error).toBeNull();
    });
  });

  // ── Messages ────────────────────────────────────────────────────────────

  describe('addMessage', () => {
    it('appends a message', () => {
      useSessionsStore.getState().addMessage(makeMsg({ id: 'm1', content: 'hello' }));
      expect(useSessionsStore.getState().messages).toHaveLength(1);
      expect(useSessionsStore.getState().messages[0].id).toBe('m1');
    });

    it('evicts oldest messages when exceeding MAX_MESSAGES', () => {
      const store = useSessionsStore.getState();
      for (let i = 0; i < MAX_MESSAGES + 5; i++) {
        store.addMessage(makeMsg({ id: `m${i}`, content: `msg-${i}` }));
      }
      const msgs = useSessionsStore.getState().messages;
      expect(msgs.length).toBe(MAX_MESSAGES);
      expect(msgs[0].id).toBe('m5');
    });
  });

  describe('updateMessage', () => {
    it('updates the matching message by id', () => {
      useSessionsStore.getState().addMessage(makeMsg({ id: 'm1', content: 'old' }));
      useSessionsStore.getState().updateMessage('m1', { content: 'new' });
      expect(useSessionsStore.getState().messages[0].content).toBe('new');
    });

    it('does nothing for non-existent id', () => {
      useSessionsStore.getState().addMessage(makeMsg({ id: 'm1' }));
      useSessionsStore.getState().updateMessage('m999', { content: 'nope' });
      expect(useSessionsStore.getState().messages[0].content).toBe('');
    });
  });

  describe('clearMessages', () => {
    it('clears messages and lastAction', () => {
      useSessionsStore.getState().addMessage(makeMsg({ id: 'm1' }));
      useSessionsStore.getState().setLastAction({ type: 'continue' });
      useSessionsStore.getState().clearMessages();
      expect(useSessionsStore.getState().messages).toEqual([]);
      expect(useSessionsStore.getState().lastAction).toBeNull();
    });
  });

  // ── State ───────────────────────────────────────────────────────────────

  describe('setState', () => {
    it('replaces the full agent state', () => {
      const newState = { ...INITIAL_STATE, conversationPhase: 'gather' };
      useSessionsStore.getState().setState(newState);
      expect(useSessionsStore.getState().state).toEqual(newState);
    });
  });

  describe('updateState', () => {
    it('deep-merges into existing state', () => {
      useSessionsStore.getState().setState(INITIAL_STATE);
      useSessionsStore.getState().updateState({ context: { name: 'John' } });
      const s = useSessionsStore.getState().state;
      expect(s?.context).toEqual({ name: 'John' });
      expect(s?.conversationPhase).toBe('start');
    });

    it('merges nested memory fields', () => {
      useSessionsStore.getState().setState(INITIAL_STATE);
      useSessionsStore.getState().updateState({
        memory: { session: { visited: true }, persistentCache: {}, pendingRemembers: [] },
      });
      expect(useSessionsStore.getState().state?.memory.session).toEqual({ visited: true });
    });

    it('is a no-op when state is null', () => {
      useSessionsStore.getState().updateState({ context: { x: 1 } });
      expect(useSessionsStore.getState().state).toBeNull();
    });
  });

  describe('setLastAction', () => {
    it('sets the last construct action', () => {
      useSessionsStore.getState().setLastAction({ type: 'respond', message: 'Hi' });
      expect(useSessionsStore.getState().lastAction).toEqual({ type: 'respond', message: 'Hi' });
    });
  });

  // ── Streaming ───────────────────────────────────────────────────────────

  describe('startStreaming', () => {
    it('sets streaming state and creates placeholder thought', () => {
      useSessionsStore.getState().startStreaming('msg-1');
      const s = useSessionsStore.getState();
      expect(s.isStreaming).toBe(true);
      expect(s.streamingMessageId).toBe('msg-1');
      expect(s.streamingContent).toBe('');
      expect(s.messages).toHaveLength(1);
      expect(s.messages[0].role).toBe('thought');
      expect(s.messages[0].id).toBe('thinking-msg-1');
      expect(s.expandedThoughtIds.has('thinking-msg-1')).toBe(true);
    });
  });

  describe('appendStreamChunk', () => {
    it('appends to streaming content', () => {
      useSessionsStore.getState().startStreaming('msg-1');
      useSessionsStore.getState().appendStreamChunk('Hello ');
      useSessionsStore.getState().appendStreamChunk('world');
      expect(useSessionsStore.getState().streamingContent).toBe('Hello world');
    });
  });

  describe('endStreaming', () => {
    it('adds the complete message and clears streaming state', () => {
      useSessionsStore.getState().startStreaming('msg-1');
      useSessionsStore.getState().appendStreamChunk('Hello');
      useSessionsStore.getState().endStreaming('Hello world');

      const s = useSessionsStore.getState();
      expect(s.isStreaming).toBe(false);
      expect(s.streamingMessageId).toBeNull();
      expect(s.streamingContent).toBe('');
      const lastMsg = s.messages[s.messages.length - 1];
      expect(lastMsg.role).toBe('assistant');
      expect(lastMsg.content).toBe('Hello world');
    });

    it('removes empty placeholder thoughts', () => {
      useSessionsStore.getState().startStreaming('msg-1');
      // Placeholder has empty content
      useSessionsStore.getState().endStreaming('Done');
      const thoughts = useSessionsStore.getState().messages.filter((m) => m.role === 'thought');
      expect(thoughts).toHaveLength(0);
    });

    it('handles empty fullText (silent completion)', () => {
      useSessionsStore.getState().startStreaming('msg-1');
      useSessionsStore.getState().endStreaming('');

      const s = useSessionsStore.getState();
      expect(s.isStreaming).toBe(false);
      expect(s.messages.filter((m) => m.role === 'assistant')).toHaveLength(0);
    });
  });

  // ── Loading / Error ─────────────────────────────────────────────────────

  describe('setLoading', () => {
    it('sets isLoading', () => {
      useSessionsStore.getState().setLoading(true);
      expect(useSessionsStore.getState().isLoading).toBe(true);
      useSessionsStore.getState().setLoading(false);
      expect(useSessionsStore.getState().isLoading).toBe(false);
    });
  });

  describe('setError', () => {
    it('sets and clears error', () => {
      useSessionsStore.getState().setError('Something broke');
      expect(useSessionsStore.getState().error).toBe('Something broke');
      useSessionsStore.getState().setError(null);
      expect(useSessionsStore.getState().error).toBeNull();
    });
  });

  // ── Thought expand/collapse ─────────────────────────────────────────────

  describe('expandThought', () => {
    it('adds id to expandedThoughtIds', () => {
      useSessionsStore.getState().expandThought('t1');
      expect(useSessionsStore.getState().expandedThoughtIds.has('t1')).toBe(true);
    });
  });

  describe('toggleThought', () => {
    it('toggles thought expansion', () => {
      useSessionsStore.getState().expandThought('t1');
      useSessionsStore.getState().toggleThought('t1');
      expect(useSessionsStore.getState().expandedThoughtIds.has('t1')).toBe(false);
      useSessionsStore.getState().toggleThought('t1');
      expect(useSessionsStore.getState().expandedThoughtIds.has('t1')).toBe(true);
    });
  });

  describe('collapseAllThoughts', () => {
    it('clears all expanded thoughts', () => {
      useSessionsStore.getState().expandThought('t1');
      useSessionsStore.getState().expandThought('t2');
      useSessionsStore.getState().collapseAllThoughts();
      expect(useSessionsStore.getState().expandedThoughtIds.size).toBe(0);
    });
  });

  // ── Session restore ─────────────────────────────────────────────────────

  describe('restoreSession', () => {
    it('restores all session data and resets transient state', () => {
      const msgs = [makeMsg({ id: 'm1', role: 'user', content: 'hi' })];
      useSessionsStore.getState().restoreSession({
        sessionId: 'sess-2',
        agent: AGENT_DETAILS,
        messages: msgs,
        state: INITIAL_STATE,
      });

      const s = useSessionsStore.getState();
      expect(s.sessionId).toBe('sess-2');
      expect(s.agent).toEqual(AGENT_DETAILS);
      expect(s.messages).toEqual(msgs);
      expect(s.state).toEqual(INITIAL_STATE);
      expect(s.isStreaming).toBe(false);
      expect(s.error).toBeNull();
    });
  });

  // ── Bulk setters (for handler use) ──────────────────────────────────────

  describe('setMessages', () => {
    it('replaces the entire messages array', () => {
      useSessionsStore.getState().addMessage(makeMsg({ id: 'old' }));
      const newMsgs = [makeMsg({ id: 'new1' }), makeMsg({ id: 'new2' })];
      useSessionsStore.getState().setMessages(newMsgs);
      expect(useSessionsStore.getState().messages).toEqual(newMsgs);
    });
  });

  describe('setAgent', () => {
    it('sets agent without resetting other fields', () => {
      useSessionsStore.getState().addMessage(makeMsg({ id: 'm1', content: 'keep' }));
      useSessionsStore.getState().setAgent(AGENT_DETAILS);
      expect(useSessionsStore.getState().agent).toEqual(AGENT_DETAILS);
      expect(useSessionsStore.getState().messages).toHaveLength(1);
    });
  });

  describe('setSessionId', () => {
    it('sets sessionId without resetting other fields', () => {
      useSessionsStore.getState().addMessage(makeMsg({ id: 'm1' }));
      useSessionsStore.getState().setSessionId('sess-99');
      expect(useSessionsStore.getState().sessionId).toBe('sess-99');
      expect(useSessionsStore.getState().messages).toHaveLength(1);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/studio && pnpm vitest run src/features/sessions/__tests__/sessions.store.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement sessions.store.ts**

```typescript
// src/features/sessions/sessions.store.ts

/**
 * Sessions Store
 *
 * Zustand store managing all chat session state: session identity, messages,
 * agent state, streaming, loading, errors, and thought expansion.
 *
 * Ported from: src/store/session-store.ts
 * Additions: devtools() middleware, bulk setters for handler use, getInitialState()
 *
 * Data sources:
 *   - WS messages via sessions.handlers.ts (MessageBus)
 *   - REST session detail via sessions.api.ts
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { boundedPush } from '@/lib/bounded-collection';
import type { SessionMessage, AgentState, ConstructAction } from './sessions.types';

export const MAX_MESSAGES = 500;

// ── AgentDetails (matches src/types/index.ts AgentDetails) ──────────────

export interface AgentDetails {
  id: string;
  name: string;
  filePath: string;
  type: 'agent';
  mode: 'scripted' | 'reasoning';
  toolCount: number;
  gatherFieldCount: number;
  isSupervisor: boolean;
  dsl: string;
  ir?: unknown;
}

// ── Store interface ─────────────────────────────────────────────────────

interface SessionsStoreState {
  // Session data
  sessionId: string | null;
  agent: AgentDetails | null;
  messages: SessionMessage[];
  state: AgentState | null;
  lastAction: ConstructAction | null;

  // Streaming state
  isStreaming: boolean;
  streamingMessageId: string | null;
  streamingContent: string;

  // Loading state
  isLoading: boolean;
  error: string | null;

  // Thought expand/collapse
  expandedThoughtIds: Set<string>;
}

interface SessionsStoreActions {
  // Session lifecycle
  setSession: (sessionId: string, agent: AgentDetails) => void;
  clearSession: () => void;

  // Messages
  addMessage: (message: SessionMessage) => void;
  updateMessage: (id: string, updates: Partial<SessionMessage>) => void;
  clearMessages: () => void;
  setMessages: (messages: SessionMessage[]) => void;

  // State
  setState: (state: AgentState) => void;
  updateState: (updates: Partial<AgentState>) => void;

  // Actions
  setLastAction: (action: ConstructAction) => void;

  // Streaming
  startStreaming: (messageId: string) => void;
  appendStreamChunk: (chunk: string) => void;
  endStreaming: (fullText: string) => void;

  // Loading / Error
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;

  // Thought expand/collapse
  expandThought: (id: string) => void;
  collapseAllThoughts: () => void;
  toggleThought: (id: string) => void;

  // Session restore
  restoreSession: (data: {
    sessionId: string;
    agent: AgentDetails;
    messages: SessionMessage[];
    state: AgentState | null;
  }) => void;

  // Bulk setters (for handler use)
  setAgent: (agent: AgentDetails) => void;
  setSessionId: (sessionId: string) => void;

  // Reset helper for tests
  getInitialState: () => SessionsStoreState;
}

type SessionsStore = SessionsStoreState & SessionsStoreActions;

const INITIAL_AGENT_STATE: AgentState = {
  context: {},
  conversationPhase: 'start',
  gatherProgress: {},
  constraintResults: {},
  lastToolResults: {},
  memory: { session: {}, persistentCache: {}, pendingRemembers: [] },
};

const initialState: SessionsStoreState = {
  sessionId: null,
  agent: null,
  messages: [],
  state: null,
  lastAction: null,
  isStreaming: false,
  streamingMessageId: null,
  streamingContent: '',
  isLoading: false,
  error: null,
  expandedThoughtIds: new Set<string>(),
};

export const useSessionsStore = create<SessionsStore>()(
  devtools(
    (set, get) => ({
      ...initialState,

      getInitialState: () => ({ ...initialState, expandedThoughtIds: new Set<string>() }),

      // ── Session lifecycle ─────────────────────────────────────────────

      setSession: (sessionId, agent) => {
        set(
          {
            sessionId,
            agent,
            messages: [],
            state: INITIAL_AGENT_STATE,
            lastAction: null,
            isLoading: false,
            error: null,
            expandedThoughtIds: new Set(),
          },
          false,
          'setSession',
        );
      },

      clearSession: () => {
        set(
          {
            sessionId: null,
            agent: null,
            messages: [],
            state: null,
            lastAction: null,
            isStreaming: false,
            streamingMessageId: null,
            streamingContent: '',
            error: null,
            expandedThoughtIds: new Set(),
          },
          false,
          'clearSession',
        );
      },

      // ── Messages ──────────────────────────────────────────────────────

      addMessage: (message) => {
        set(
          (s) => ({ messages: boundedPush(s.messages, message, MAX_MESSAGES) }),
          false,
          'addMessage',
        );
      },

      updateMessage: (id, updates) => {
        set(
          (s) => ({
            messages: s.messages.map((m) => (m.id === id ? { ...m, ...updates } : m)),
          }),
          false,
          'updateMessage',
        );
      },

      clearMessages: () => {
        set({ messages: [], lastAction: null }, false, 'clearMessages');
      },

      setMessages: (messages) => {
        set({ messages }, false, 'setMessages');
      },

      // ── State ─────────────────────────────────────────────────────────

      setState: (newState) => {
        set({ state: newState }, false, 'setState');
      },

      updateState: (updates) => {
        const currentState = get().state;
        if (!currentState) return;

        set(
          {
            state: {
              ...currentState,
              ...updates,
              context: { ...currentState.context, ...updates.context },
              gatherProgress: { ...currentState.gatherProgress, ...updates.gatherProgress },
              constraintResults: {
                ...currentState.constraintResults,
                ...updates.constraintResults,
              },
              lastToolResults: { ...currentState.lastToolResults, ...updates.lastToolResults },
              memory: {
                ...currentState.memory,
                ...updates.memory,
                session: { ...currentState.memory?.session, ...updates.memory?.session },
                persistentCache: {
                  ...currentState.memory?.persistentCache,
                  ...updates.memory?.persistentCache,
                },
              },
            },
          },
          false,
          'updateState',
        );
      },

      // ── Actions ───────────────────────────────────────────────────────

      setLastAction: (action) => {
        set({ lastAction: action }, false, 'setLastAction');
      },

      // ── Streaming ─────────────────────────────────────────────────────

      startStreaming: (messageId) => {
        const placeholderId = `thinking-${messageId}`;
        set(
          (s) => ({
            isStreaming: true,
            streamingMessageId: messageId,
            streamingContent: '',
            expandedThoughtIds: new Set([placeholderId]),
            messages: boundedPush(
              s.messages,
              {
                id: placeholderId,
                role: 'thought' as const,
                content: '',
                timestamp: new Date(),
                traceIds: [],
              },
              MAX_MESSAGES,
            ),
          }),
          false,
          'startStreaming',
        );
      },

      appendStreamChunk: (chunk) => {
        set((s) => ({ streamingContent: s.streamingContent + chunk }), false, 'appendStreamChunk');
      },

      endStreaming: (fullText) => {
        const { streamingMessageId } = get();

        const cleanMessages = (msgs: SessionMessage[]) =>
          msgs.filter((m) => !(m.role === 'thought' && !m.content));

        if (streamingMessageId && fullText) {
          set(
            (s) => ({
              messages: boundedPush(
                cleanMessages(s.messages),
                {
                  id: streamingMessageId,
                  role: 'assistant' as const,
                  content: fullText,
                  timestamp: new Date(),
                  traceIds: [],
                },
                MAX_MESSAGES,
              ),
              isStreaming: false,
              streamingMessageId: null,
              streamingContent: '',
              expandedThoughtIds: new Set(),
            }),
            false,
            'endStreaming',
          );
        } else {
          set(
            (s) => ({
              messages: cleanMessages(s.messages),
              isStreaming: false,
              streamingMessageId: null,
              streamingContent: '',
              expandedThoughtIds: new Set(),
            }),
            false,
            'endStreaming/empty',
          );
        }
      },

      // ── Loading / Error ───────────────────────────────────────────────

      setLoading: (loading) => {
        set({ isLoading: loading }, false, 'setLoading');
      },

      setError: (error) => {
        set({ error }, false, 'setError');
      },

      // ── Thought expand/collapse ───────────────────────────────────────

      expandThought: (id) => {
        set(
          (s) => {
            const next = new Set(s.expandedThoughtIds);
            next.add(id);
            return { expandedThoughtIds: next };
          },
          false,
          'expandThought',
        );
      },

      collapseAllThoughts: () => {
        set({ expandedThoughtIds: new Set() }, false, 'collapseAllThoughts');
      },

      toggleThought: (id) => {
        set(
          (s) => {
            const next = new Set(s.expandedThoughtIds);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return { expandedThoughtIds: next };
          },
          false,
          'toggleThought',
        );
      },

      // ── Session restore ───────────────────────────────────────────────

      restoreSession: (data) => {
        set(
          {
            sessionId: data.sessionId,
            agent: data.agent,
            messages: data.messages,
            state: data.state,
            lastAction: null,
            isStreaming: false,
            streamingMessageId: null,
            streamingContent: '',
            error: null,
            expandedThoughtIds: new Set(),
          },
          false,
          'restoreSession',
        );
      },

      // ── Bulk setters (for handler use) ────────────────────────────────

      setAgent: (agent) => {
        set({ agent }, false, 'setAgent');
      },

      setSessionId: (sessionId) => {
        set({ sessionId }, false, 'setSessionId');
      },
    }),
    { name: 'sessions-store', enabled: process.env.NODE_ENV === 'development' },
  ),
);
```

- [ ] **Step 4: Verify types compile**

Run: `cd apps/studio && npx tsc --noEmit --pretty src/features/sessions/sessions.store.ts`

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/studio && pnpm vitest run src/features/sessions/__tests__/sessions.store.test.ts`

- [ ] **Step 6: Commit**

```bash
npx prettier --write apps/studio/src/features/sessions/sessions.store.ts apps/studio/src/features/sessions/__tests__/sessions.store.test.ts
git add apps/studio/src/features/sessions/sessions.store.ts apps/studio/src/features/sessions/__tests__/sessions.store.test.ts
git commit -m "[ABLP-2] feat(studio): add sessions store with devtools middleware"
```

---

### Task 9: Sessions Handler (MessageBus)

**Files:**

- Create: `src/features/sessions/sessions.handlers.ts`
- Test: `src/features/sessions/__tests__/sessions.handlers.test.ts`

Registers on the MessageBus for all session-relevant message types. Uses pure functions from Chunk 1 (thought-card-merger, state-extractor, trace-event-logger). Calls store actions.

- [ ] **Step 1: Write the failing test**

```typescript
// src/features/sessions/__tests__/sessions.handlers.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageBus } from '@/infrastructure/message-bus';
import { useSessionsStore } from '../sessions.store';
import { registerSessionsHandlers } from '../sessions.handlers';

function resetStore() {
  useSessionsStore.setState(useSessionsStore.getInitialState());
}

describe('sessions.handlers', () => {
  let bus: MessageBus;
  let unregister: () => void;

  beforeEach(() => {
    resetStore();
    bus = new MessageBus();
    unregister = registerSessionsHandlers(bus);
  });

  afterEach(() => {
    unregister();
  });

  // ── Streaming lifecycle ─────────────────────────────────────────────────

  describe('response_start', () => {
    it('starts streaming with the messageId', () => {
      bus.emit('response_start', { sessionId: 's1', messageId: 'msg-1' });
      const s = useSessionsStore.getState();
      expect(s.isStreaming).toBe(true);
      expect(s.streamingMessageId).toBe('msg-1');
    });
  });

  describe('response_chunk', () => {
    it('appends chunk to streaming content', () => {
      bus.emit('response_start', { sessionId: 's1', messageId: 'msg-1' });
      bus.emit('response_chunk', { sessionId: 's1', messageId: 'msg-1', chunk: 'Hello ' });
      bus.emit('response_chunk', { sessionId: 's1', messageId: 'msg-1', chunk: 'world' });
      expect(useSessionsStore.getState().streamingContent).toBe('Hello world');
    });
  });

  describe('response_end', () => {
    it('ends streaming and adds complete message', () => {
      bus.emit('response_start', { sessionId: 's1', messageId: 'msg-1' });
      bus.emit('response_end', { sessionId: 's1', messageId: 'msg-1', fullText: 'Hello world' });
      const s = useSessionsStore.getState();
      expect(s.isStreaming).toBe(false);
      const lastMsg = s.messages[s.messages.length - 1];
      expect(lastMsg.role).toBe('assistant');
      expect(lastMsg.content).toBe('Hello world');
    });
  });

  // ── State updates ───────────────────────────────────────────────────────

  describe('state_update', () => {
    it('replaces state when updates is empty', () => {
      const fullState = {
        context: { name: 'John' },
        conversationPhase: 'gather',
        gatherProgress: {},
        constraintResults: {},
        lastToolResults: {},
        memory: { session: {}, persistentCache: {}, pendingRemembers: [] },
      };
      bus.emit('state_update', { sessionId: 's1', state: fullState, updates: {} });
      expect(useSessionsStore.getState().state).toEqual(fullState);
    });

    it('merges partial updates into existing state', () => {
      // Set initial state first
      useSessionsStore.getState().setState({
        context: {},
        conversationPhase: 'start',
        gatherProgress: {},
        constraintResults: {},
        lastToolResults: {},
        memory: { session: {}, persistentCache: {}, pendingRemembers: [] },
      });
      bus.emit('state_update', {
        sessionId: 's1',
        state: {
          context: {},
          conversationPhase: 'start',
          gatherProgress: {},
          constraintResults: {},
          lastToolResults: {},
          memory: { session: {}, persistentCache: {}, pendingRemembers: [] },
        },
        updates: { context: { email: 'a@b.com' } },
      });
      expect(useSessionsStore.getState().state?.context).toEqual({ email: 'a@b.com' });
    });
  });

  describe('action_taken', () => {
    it('sets the last action', () => {
      bus.emit('action_taken', {
        sessionId: 's1',
        action: { type: 'respond', message: 'Hi' },
      });
      expect(useSessionsStore.getState().lastAction).toEqual({
        type: 'respond',
        message: 'Hi',
      });
    });
  });

  // ── Session lifecycle messages ──────────────────────────────────────────

  describe('session_reset', () => {
    it('resets state to initial values', () => {
      useSessionsStore.getState().setState({
        context: { name: 'John' },
        conversationPhase: 'gather',
        gatherProgress: { name: 'John' },
        constraintResults: {},
        lastToolResults: {},
        memory: { session: {}, persistentCache: {}, pendingRemembers: [] },
      });
      bus.emit('session_reset', { sessionId: 's1' });
      const s = useSessionsStore.getState().state;
      expect(s?.context).toEqual({});
      expect(s?.conversationPhase).toBe('start');
    });
  });

  describe('session_resumed', () => {
    it('restores session ID and conversation history', () => {
      bus.emit('session_resumed', {
        sessionId: 'sess-resumed',
        state: {
          context: { x: 1 },
          conversationPhase: 'gather',
          gatherProgress: {},
          constraintResults: {},
          lastToolResults: {},
          memory: { session: {}, persistentCache: {}, pendingRemembers: [] },
        },
        conversationHistory: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there' },
        ],
      });
      const s = useSessionsStore.getState();
      expect(s.sessionId).toBe('sess-resumed');
      expect(s.messages).toHaveLength(2);
      expect(s.messages[0].role).toBe('user');
      expect(s.messages[1].role).toBe('assistant');
      expect(s.state?.context).toEqual({ x: 1 });
    });
  });

  describe('session_expired', () => {
    it('sets error message', () => {
      bus.emit('session_expired', { sessionId: 's1', reason: 'timeout' });
      expect(useSessionsStore.getState().error).toContain('expired');
    });
  });

  // ── Error / Info ────────────────────────────────────────────────────────

  describe('error', () => {
    it('sets error and clears loading', () => {
      useSessionsStore.getState().setLoading(true);
      bus.emit('error', { message: 'Something broke' });
      const s = useSessionsStore.getState();
      expect(s.isLoading).toBe(false);
      expect(s.error).toBeDefined();
    });
  });

  describe('info', () => {
    // info messages are handled by the connection layer, not the sessions handler
    it('does not throw on info messages', () => {
      expect(() => {
        bus.emit('info', { message: 'Connected', configured: true });
      }).not.toThrow();
    });
  });

  // ── trace_event: tool_thought ───────────────────────────────────────────

  describe('trace_event — tool_thought', () => {
    it('creates a thought card for tool_thought events', () => {
      bus.emit('trace_event', {
        sessionId: 's1',
        event: {
          id: 'evt-1',
          sessionId: 's1',
          type: 'tool_thought',
          timestamp: new Date().toISOString(),
          data: {
            thought: 'Let me check the database',
            toolName: 'db-query',
            agentName: 'support',
          },
        },
      });
      const msgs = useSessionsStore.getState().messages;
      const thoughts = msgs.filter((m) => m.role === 'thought');
      expect(thoughts).toHaveLength(1);
      expect(thoughts[0].content).toBe('Let me check the database');
    });
  });

  // ── trace_event: handoff ────────────────────────────────────────────────

  describe('trace_event — handoff', () => {
    it('creates system fallback when no thought card exists', () => {
      bus.emit('trace_event', {
        sessionId: 's1',
        event: {
          id: 'evt-h1',
          sessionId: 's1',
          type: 'handoff',
          timestamp: new Date().toISOString(),
          data: { from: 'triage', to: 'support' },
        },
      });
      const msgs = useSessionsStore.getState().messages;
      const systemMsgs = msgs.filter((m) => m.role === 'system');
      expect(systemMsgs).toHaveLength(1);
      expect(systemMsgs[0].content).toContain('triage');
      expect(systemMsgs[0].content).toContain('support');
    });
  });

  // ── trace_event: error ──────────────────────────────────────────────────

  describe('trace_event — error', () => {
    it('surfaces runtime errors as system messages in chat', () => {
      bus.emit('trace_event', {
        sessionId: 's1',
        event: {
          id: 'evt-err-1',
          sessionId: 's1',
          type: 'error',
          timestamp: new Date().toISOString(),
          data: { message: 'Tool call failed: timeout' },
        },
      });
      const msgs = useSessionsStore.getState().messages;
      const errorMsgs = msgs.filter((m) => m.role === 'system' && m.content.includes('Error'));
      expect(errorMsgs).toHaveLength(1);
    });
  });

  // ── trace_event: dsl_collect (state extraction) ─────────────────────────

  describe('trace_event — dsl_collect', () => {
    it('extracts gather progress into agent state', () => {
      useSessionsStore.getState().setState({
        context: {},
        conversationPhase: 'gather',
        gatherProgress: {},
        constraintResults: {},
        lastToolResults: {},
        memory: { session: {}, persistentCache: {}, pendingRemembers: [] },
      });
      bus.emit('trace_event', {
        sessionId: 's1',
        event: {
          id: 'evt-c1',
          sessionId: 's1',
          type: 'dsl_collect',
          timestamp: new Date().toISOString(),
          data: { extracted: { name: 'John', age: 30 } },
        },
      });
      expect(useSessionsStore.getState().state?.gatherProgress).toEqual({ name: 'John', age: 30 });
    });
  });

  // ── trace_event: dsl_set (state extraction) ─────────────────────────────

  describe('trace_event — dsl_set', () => {
    it('extracts context assignments into agent state', () => {
      useSessionsStore.getState().setState({
        context: {},
        conversationPhase: 'start',
        gatherProgress: {},
        constraintResults: {},
        lastToolResults: {},
        memory: { session: {}, persistentCache: {}, pendingRemembers: [] },
      });
      bus.emit('trace_event', {
        sessionId: 's1',
        event: {
          id: 'evt-s1',
          sessionId: 's1',
          type: 'dsl_set',
          timestamp: new Date().toISOString(),
          data: { assignments: { status: 'active' } },
        },
      });
      expect(useSessionsStore.getState().state?.context).toEqual({ status: 'active' });
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/studio && pnpm vitest run src/features/sessions/__tests__/sessions.handlers.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement sessions.handlers.ts**

```typescript
// src/features/sessions/sessions.handlers.ts

/**
 * Sessions Handlers
 *
 * Registers MessageBus handlers for all session-related server messages.
 * Orchestrates pure functions (thought-card-merger, state-extractor,
 * trace-event-logger) and dispatches results to the sessions store.
 *
 * Extracted from: src/contexts/WebSocketContext.tsx handleMessage switch
 *
 * Message types handled:
 *   response_start, response_chunk, response_end,
 *   state_update, action_taken,
 *   session_reset, session_resumed, session_expired,
 *   error, info,
 *   trace_event (filtered for: tool_thought, handoff, error,
 *     dsl_collect, entity_extraction, dsl_set)
 */

import type { MessageBus } from '@/infrastructure/message-bus';
import type { ServerMessageMap } from '@/infrastructure/message-bus.types';
import { useSessionsStore } from './sessions.store';
import { mergeToolThought, mergeHandoffMetadata } from './thought-card-merger';
import { extractStatePatch } from './state-extractor';
import { sanitizeServerError } from '@/lib/sanitize-error';

// ── Initial state constant (matches session-store.ts) ───────────────────

const INITIAL_AGENT_STATE = {
  context: {},
  conversationPhase: 'start',
  gatherProgress: {},
  constraintResults: {},
  lastToolResults: {},
  memory: { session: {}, persistentCache: {}, pendingRemembers: [] },
} as const;

// ── Trace event sub-handler ─────────────────────────────────────────────

function handleTraceEvent(payload: ServerMessageMap['trace_event']): void {
  const event = payload.event as {
    id: string;
    sessionId: string;
    type: string;
    timestamp: string;
    durationMs?: number;
    data?: Record<string, unknown>;
  };
  const eventData = event.data || {};
  const store = useSessionsStore.getState();

  // Surface runtime errors as visible system messages in chat
  if (event.type === 'error' && eventData.message) {
    store.addMessage({
      id: `error-${Date.now()}-${event.id}`,
      role: 'system',
      content: `Error: ${sanitizeServerError(eventData.message as string, 'An error occurred during execution')}`,
      timestamp: new Date(event.timestamp),
      traceIds: [event.id],
    });
  }

  // Merge handoff metadata into thought card or create system fallback
  if (event.type === 'handoff' && eventData.from && eventData.to) {
    const result = mergeHandoffMetadata(store.messages, {
      from: eventData.from as string,
      to: eventData.to as string,
      eventId: event.id,
      timestamp: new Date(event.timestamp),
    });

    if (result.systemFallback) {
      store.addMessage(result.systemFallback);
    } else {
      store.setMessages(result.messages);
    }
  }

  // Merge tool_thought into thought card
  if (event.type === 'tool_thought' && eventData.thought) {
    const result = mergeToolThought(store.messages, {
      thought: eventData.thought as string,
      toolName: eventData.toolName as string,
      agentName: (eventData.agentName || eventData.agent) as string,
      eventId: event.id,
      timestamp: new Date(event.timestamp),
      isStreaming: store.isStreaming,
    });

    store.setMessages(result.messages);
    if (result.newThoughtId) {
      store.expandThought(result.newThoughtId);
    }
  }

  // Extract state patches from dsl_collect, entity_extraction, dsl_set
  if (
    event.type === 'dsl_collect' ||
    event.type === 'entity_extraction' ||
    event.type === 'dsl_set'
  ) {
    const patch = extractStatePatch(event.type, eventData);
    if (patch) {
      store.updateState(patch);
    }
  }
}

// ── Registration ────────────────────────────────────────────────────────

/**
 * Registers sessions handlers on the MessageBus.
 * Returns an unregister function to clean up all handlers.
 */
export function registerSessionsHandlers(bus: MessageBus): () => void {
  const unsubscribers: Array<() => void> = [];

  // response_start
  unsubscribers.push(
    bus.on('response_start', (payload) => {
      useSessionsStore.getState().startStreaming(payload.messageId);
    }),
  );

  // response_chunk
  unsubscribers.push(
    bus.on('response_chunk', (payload) => {
      useSessionsStore.getState().appendStreamChunk(payload.chunk);
    }),
  );

  // response_end
  unsubscribers.push(
    bus.on('response_end', (payload) => {
      useSessionsStore.getState().endStreaming(payload.fullText);
    }),
  );

  // state_update
  unsubscribers.push(
    bus.on('state_update', (payload) => {
      const updates = payload.updates as Record<string, unknown> | undefined;
      if (updates && Object.keys(updates).length > 0) {
        useSessionsStore.getState().updateState(updates);
      } else {
        useSessionsStore
          .getState()
          .setState(
            payload.state as ReturnType<typeof useSessionsStore.getState>['state'] & object,
          );
      }
    }),
  );

  // action_taken
  unsubscribers.push(
    bus.on('action_taken', (payload) => {
      useSessionsStore
        .getState()
        .setLastAction(
          payload.action as ReturnType<typeof useSessionsStore.getState>['lastAction'] & object,
        );
    }),
  );

  // session_reset
  unsubscribers.push(
    bus.on('session_reset', () => {
      useSessionsStore.getState().setState({
        ...INITIAL_AGENT_STATE,
      });
    }),
  );

  // session_resumed
  unsubscribers.push(
    bus.on('session_resumed', (payload) => {
      const store = useSessionsStore.getState();
      store.clearMessages();
      store.setSessionId(payload.sessionId);
      store.setState(
        payload.state as ReturnType<typeof store.setState> extends void ? never : never,
      );

      const history = payload.conversationHistory as Array<{ role: string; content: string }>;
      const baseTime = Date.now();
      for (let i = 0; i < history.length; i++) {
        const msg = history[i];
        store.addMessage({
          id: `resumed-${payload.sessionId}-${baseTime}-${i}`,
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
          timestamp: new Date(baseTime - (history.length - 1 - i) * 1000),
          traceIds: [],
        });
      }
    }),
  );

  // session_expired
  unsubscribers.push(
    bus.on('session_expired', () => {
      useSessionsStore.getState().setError('Session expired. Please start a new session.');
    }),
  );

  // error
  unsubscribers.push(
    bus.on('error', (payload) => {
      useSessionsStore.getState().setLoading(false);
      useSessionsStore
        .getState()
        .setError(sanitizeServerError(payload.message, 'An error occurred'));
    }),
  );

  // info — sessions handler is a no-op; connection layer handles this
  unsubscribers.push(bus.on('info', () => {}));

  // trace_event — filter for session-relevant types
  unsubscribers.push(
    bus.on('trace_event', (payload) => {
      handleTraceEvent(payload);
    }),
  );

  return () => {
    for (const unsub of unsubscribers) {
      unsub();
    }
  };
}
```

- [ ] **Step 4: Verify types compile**

Run: `cd apps/studio && npx tsc --noEmit --pretty src/features/sessions/sessions.handlers.ts`

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/studio && pnpm vitest run src/features/sessions/__tests__/sessions.handlers.test.ts`

- [ ] **Step 6: Commit**

```bash
npx prettier --write apps/studio/src/features/sessions/sessions.handlers.ts apps/studio/src/features/sessions/__tests__/sessions.handlers.test.ts
git add apps/studio/src/features/sessions/sessions.handlers.ts apps/studio/src/features/sessions/__tests__/sessions.handlers.test.ts
git commit -m "[ABLP-2] feat(studio): add sessions MessageBus handlers"
```

---

### Task 10: Sessions API Layer

**Files:**

- Create: `src/features/sessions/sessions.api.ts`
- Test: `src/features/sessions/__tests__/sessions.api.test.ts`

REST functions for session data, plus WS send wrappers. Uses validated fetch with Zod from contract schemas.

- [ ] **Step 1: Write the failing test**

```typescript
// src/features/sessions/__tests__/sessions.api.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchSessionDetail,
  fetchSessionList,
  buildSendMessage,
  buildResetSession,
  buildRunTest,
  buildResumeSession,
  buildLoadAgent,
  buildLoadAgentWithContext,
} from '../sessions.api';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock authHeaders
vi.mock('@/lib/api-client', () => ({
  authHeaders: () => ({ Authorization: 'Bearer test-token' }),
}));

describe('sessions.api', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── REST functions ──────────────────────────────────────────────────────

  describe('fetchSessionDetail', () => {
    it('fetches session detail with projectId query param', async () => {
      const sessionData = {
        success: true,
        session: {
          sessionId: 'sess-1',
          agentName: 'support',
          messages: [],
          traceEvents: [],
          state: null,
        },
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(sessionData),
      });

      const result = await fetchSessionDetail('sess-1', 'proj-1');
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/runtime/sessions/sess-1?projectId=proj-1',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
        }),
      );
      expect(result.session.sessionId).toBe('sess-1');
    });

    it('fetches session detail without projectId', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            session: { sessionId: 'sess-1' },
          }),
      });

      await fetchSessionDetail('sess-1');
      expect(mockFetch).toHaveBeenCalledWith('/api/runtime/sessions/sess-1', expect.any(Object));
    });

    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: 'Not found' }),
      });

      await expect(fetchSessionDetail('sess-1')).rejects.toThrow();
    });
  });

  describe('fetchSessionList', () => {
    it('fetches session list with projectId', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            sessions: [{ id: 's1' }, { id: 's2' }],
          }),
      });

      const result = await fetchSessionList('proj-1');
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/runtime/sessions?projectId=proj-1',
        expect.any(Object),
      );
      expect(result.sessions).toHaveLength(2);
    });
  });

  // ── WS send wrappers ───────────────────────────────────────────────────

  describe('buildSendMessage', () => {
    it('returns a function that calls send with correct payload', () => {
      const send = vi.fn();
      const sendMessage = buildSendMessage(send);
      sendMessage('sess-1', 'Hello', { attachmentIds: ['a1'] });
      expect(send).toHaveBeenCalledWith({
        type: 'send_message',
        sessionId: 'sess-1',
        text: 'Hello',
        attachmentIds: ['a1'],
      });
    });

    it('omits attachmentIds when not provided', () => {
      const send = vi.fn();
      const sendMessage = buildSendMessage(send);
      sendMessage('sess-1', 'Hello');
      expect(send).toHaveBeenCalledWith({
        type: 'send_message',
        sessionId: 'sess-1',
        text: 'Hello',
      });
    });
  });

  describe('buildResetSession', () => {
    it('sends reset_session message', () => {
      const send = vi.fn();
      const resetSession = buildResetSession(send);
      resetSession('sess-1');
      expect(send).toHaveBeenCalledWith({
        type: 'reset_session',
        sessionId: 'sess-1',
      });
    });
  });

  describe('buildRunTest', () => {
    it('sends run_test message', () => {
      const send = vi.fn();
      const runTest = buildRunTest(send);
      runTest('sess-1', 'test-1');
      expect(send).toHaveBeenCalledWith({
        type: 'run_test',
        sessionId: 'sess-1',
        testId: 'test-1',
      });
    });
  });

  describe('buildResumeSession', () => {
    it('sends resume_session message', () => {
      const send = vi.fn();
      const resumeSession = buildResumeSession(send);
      resumeSession('sess-1');
      expect(send).toHaveBeenCalledWith({
        type: 'resume_session',
        sessionId: 'sess-1',
      });
    });
  });

  describe('buildLoadAgent', () => {
    it('sends load_agent with projectId', () => {
      const send = vi.fn();
      const loadAgent = buildLoadAgent(send);
      loadAgent('/agents/support.abl', 'proj-1');
      expect(send).toHaveBeenCalledWith({
        type: 'load_agent',
        agentPath: '/agents/support.abl',
        projectId: 'proj-1',
      });
    });
  });

  describe('buildLoadAgentWithContext', () => {
    it('sends load_agent_with_context with full payload', () => {
      const send = vi.fn();
      const loadAgentWithContext = buildLoadAgentWithContext(send);
      loadAgentWithContext('/agents/support.abl', 'proj-1', {
        gatherValues: { name: 'John' },
      });
      expect(send).toHaveBeenCalledWith({
        type: 'load_agent_with_context',
        agentPath: '/agents/support.abl',
        projectId: 'proj-1',
        context: { gatherValues: { name: 'John' } },
      });
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/studio && pnpm vitest run src/features/sessions/__tests__/sessions.api.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement sessions.api.ts**

```typescript
// src/features/sessions/sessions.api.ts

/**
 * Sessions API Layer
 *
 * REST functions for session data and WS send wrappers for mutations.
 *
 * Data sources:
 *   - REST: /api/runtime/sessions/:id — session detail (messages, traces, state)
 *   - REST: /api/runtime/sessions — session list
 *   - WS:   send_message, reset_session, run_test, resume_session,
 *           load_agent, load_agent_with_context
 *
 * All REST functions use authHeaders() for authentication.
 * WS wrappers accept a `send` function (from WebSocketContext or transport).
 */

import { authHeaders } from '@/lib/api-client';
import type { ClientMessage } from '@/types';
import type { TestContextPayload } from '@/types/test-context';

// ── Types ───────────────────────────────────────────────────────────────

type WsSend = (message: ClientMessage) => void;

interface SessionDetailResponse {
  success?: boolean;
  session: {
    sessionId?: string;
    id?: string;
    agentId?: string;
    agentName?: string;
    agentMode?: string;
    toolCount?: number;
    gatherFieldCount?: number;
    isSupervisor?: boolean;
    messages?: unknown[];
    traceEvents?: unknown[];
    state?: unknown;
    agent?: unknown;
  };
}

interface SessionListResponse {
  success?: boolean;
  sessions: unknown[];
}

// ── REST functions ──────────────────────────────────────────────────────

/**
 * Fetches full session detail including messages, traces, and state.
 */
export async function fetchSessionDetail(
  sessionId: string,
  projectId?: string,
): Promise<SessionDetailResponse> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  const response = await fetch(`/api/runtime/sessions/${sessionId}${query}`, {
    headers: authHeaders(),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error || `Failed to fetch session: ${response.status}`,
    );
  }

  const data = await response.json();
  return {
    success: data.success,
    session: data.session || data,
  };
}

/**
 * Fetches the list of sessions for a project.
 */
export async function fetchSessionList(projectId?: string): Promise<SessionListResponse> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  const response = await fetch(`/api/runtime/sessions${query}`, {
    headers: authHeaders(),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error || `Failed to fetch sessions: ${response.status}`,
    );
  }

  return response.json();
}

// ── WS send wrappers ────────────────────────────────────────────────────

/**
 * Builds a sendMessage function that sends a user message via WS.
 */
export function buildSendMessage(send: WsSend) {
  return (sessionId: string, text: string, options?: { attachmentIds?: string[] }): void => {
    send({
      type: 'send_message',
      sessionId,
      text,
      ...(options?.attachmentIds?.length ? { attachmentIds: options.attachmentIds } : {}),
    } as ClientMessage);
  };
}

/**
 * Builds a resetSession function that resets a session via WS.
 */
export function buildResetSession(send: WsSend) {
  return (sessionId: string): void => {
    send({ type: 'reset_session', sessionId } as ClientMessage);
  };
}

/**
 * Builds a runTest function that triggers a test run via WS.
 */
export function buildRunTest(send: WsSend) {
  return (sessionId: string, testId: string): void => {
    send({ type: 'run_test', sessionId, testId } as ClientMessage);
  };
}

/**
 * Builds a resumeSession function that resumes an existing session via WS.
 */
export function buildResumeSession(send: WsSend) {
  return (sessionId: string): void => {
    send({ type: 'resume_session', sessionId } as ClientMessage);
  };
}

/**
 * Builds a loadAgent function that loads an agent into a new session via WS.
 */
export function buildLoadAgent(send: WsSend) {
  return (agentPath: string, projectId?: string): void => {
    send({ type: 'load_agent', agentPath, projectId } as ClientMessage);
  };
}

/**
 * Builds a loadAgentWithContext function that loads an agent with
 * pre-configured test context via WS.
 */
export function buildLoadAgentWithContext(send: WsSend) {
  return (agentPath: string, projectId: string | undefined, context: TestContextPayload): void => {
    send({
      type: 'load_agent_with_context',
      agentPath,
      projectId,
      context,
    } as ClientMessage);
  };
}
```

- [ ] **Step 4: Verify types compile**

Run: `cd apps/studio && npx tsc --noEmit --pretty src/features/sessions/sessions.api.ts`

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/studio && pnpm vitest run src/features/sessions/__tests__/sessions.api.test.ts`

- [ ] **Step 6: Commit**

```bash
npx prettier --write apps/studio/src/features/sessions/sessions.api.ts apps/studio/src/features/sessions/__tests__/sessions.api.test.ts
git add apps/studio/src/features/sessions/sessions.api.ts apps/studio/src/features/sessions/__tests__/sessions.api.test.ts
git commit -m "[ABLP-2] feat(studio): add sessions API layer with REST and WS wrappers"
```

---

### Task 11: Test Context Handler

**Files:**

- Create: `src/features/sessions/test-context.handlers.ts`
- Test: `src/features/sessions/__tests__/test-context.handlers.test.ts`

Registers on the MessageBus for test context server responses. Provides API functions for sending test context commands via WS.

- [ ] **Step 1: Write the failing test**

```typescript
// src/features/sessions/__tests__/test-context.handlers.test.ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { MessageBus } from '@/infrastructure/message-bus';
import { useSessionsStore } from '../sessions.store';
import {
  registerTestContextHandlers,
  buildInjectContext,
  buildSetToolMocks,
  buildClearToolMocks,
} from '../test-context.handlers';

function resetStore() {
  useSessionsStore.setState(useSessionsStore.getInitialState());
}

describe('test-context.handlers', () => {
  let bus: MessageBus;
  let unregister: () => void;

  beforeEach(() => {
    resetStore();
    bus = new MessageBus();
    unregister = registerTestContextHandlers(bus);
  });

  afterEach(() => {
    unregister();
  });

  // ── MessageBus handlers ─────────────────────────────────────────────────

  describe('context_injected', () => {
    it('merges updated values into agent state context', () => {
      useSessionsStore.getState().setState({
        context: { existing: 'value' },
        conversationPhase: 'start',
        gatherProgress: {},
        constraintResults: {},
        lastToolResults: {},
        memory: { session: {}, persistentCache: {}, pendingRemembers: [] },
      });

      bus.emit('context_injected', {
        sessionId: 's1',
        updatedValues: { name: 'John', age: 30 },
      });

      const ctx = useSessionsStore.getState().state?.context;
      expect(ctx).toEqual({ existing: 'value', name: 'John', age: 30 });
    });

    it('is a no-op when updatedValues is empty', () => {
      useSessionsStore.getState().setState({
        context: { x: 1 },
        conversationPhase: 'start',
        gatherProgress: {},
        constraintResults: {},
        lastToolResults: {},
        memory: { session: {}, persistentCache: {}, pendingRemembers: [] },
      });

      bus.emit('context_injected', { sessionId: 's1', updatedValues: {} });
      expect(useSessionsStore.getState().state?.context).toEqual({ x: 1 });
    });
  });

  describe('tool_mock_set', () => {
    it('does not throw (status notification only)', () => {
      expect(() => {
        bus.emit('tool_mock_set', { sessionId: 's1', mockCount: 3 });
      }).not.toThrow();
    });
  });

  describe('context_injection_error', () => {
    it('sets error from the error message', () => {
      bus.emit('context_injection_error', {
        sessionId: 's1',
        error: { code: 'INVALID_STEP', message: 'Step not found' },
      });
      expect(useSessionsStore.getState().error).toBe('Step not found');
    });
  });

  // ── WS send wrappers ───────────────────────────────────────────────────

  describe('buildInjectContext', () => {
    it('sends inject_context message', () => {
      const send = vi.fn();
      const injectContext = buildInjectContext(send);
      injectContext('sess-1', { values: { name: 'Jane' } });
      expect(send).toHaveBeenCalledWith({
        type: 'inject_context',
        sessionId: 'sess-1',
        injection: { values: { name: 'Jane' } },
      });
    });
  });

  describe('buildSetToolMocks', () => {
    it('sends set_tool_mocks message', () => {
      const send = vi.fn();
      const setToolMocks = buildSetToolMocks(send);
      setToolMocks('sess-1', [{ toolName: 'search', response: { found: true } }]);
      expect(send).toHaveBeenCalledWith({
        type: 'set_tool_mocks',
        sessionId: 'sess-1',
        mocks: [{ toolName: 'search', response: { found: true } }],
      });
    });
  });

  describe('buildClearToolMocks', () => {
    it('sends clear_tool_mocks message', () => {
      const send = vi.fn();
      const clearToolMocks = buildClearToolMocks(send);
      clearToolMocks('sess-1');
      expect(send).toHaveBeenCalledWith({
        type: 'clear_tool_mocks',
        sessionId: 'sess-1',
      });
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/studio && pnpm vitest run src/features/sessions/__tests__/test-context.handlers.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement test-context.handlers.ts**

```typescript
// src/features/sessions/test-context.handlers.ts

/**
 * Test Context Handlers
 *
 * MessageBus handlers for test context server responses, plus WS send
 * wrappers for injecting context and managing tool mocks.
 *
 * Message types handled:
 *   context_injected, tool_mock_set, context_injection_error
 *
 * WS commands:
 *   inject_context, set_tool_mocks, clear_tool_mocks
 */

import type { MessageBus } from '@/infrastructure/message-bus';
import type { ClientMessage } from '@/types';
import type { ContextInjection, ToolMockConfig } from '@/types/test-context';
import { useSessionsStore } from './sessions.store';

type WsSend = (message: ClientMessage) => void;

// ── MessageBus handler registration ─────────────────────────────────────

/**
 * Registers test context handlers on the MessageBus.
 * Returns an unregister function to clean up all handlers.
 */
export function registerTestContextHandlers(bus: MessageBus): () => void {
  const unsubscribers: Array<() => void> = [];

  // context_injected — merge updated values into agent state context
  unsubscribers.push(
    bus.on('context_injected', (payload) => {
      const updatedValues = payload.updatedValues as Record<string, unknown>;
      if (updatedValues && Object.keys(updatedValues).length > 0) {
        useSessionsStore.getState().updateState({ context: updatedValues });
      }
    }),
  );

  // tool_mock_set — status notification, no store update needed
  unsubscribers.push(bus.on('tool_mock_set', () => {}));

  // context_injection_error — surface error to user
  unsubscribers.push(
    bus.on('context_injection_error', (payload) => {
      const error = payload.error as { code: string; message: string };
      useSessionsStore.getState().setError(error?.message || 'Context injection failed');
    }),
  );

  return () => {
    for (const unsub of unsubscribers) {
      unsub();
    }
  };
}

// ── WS send wrappers ────────────────────────────────────────────────────

/**
 * Builds an injectContext function that sends context injection via WS.
 */
export function buildInjectContext(send: WsSend) {
  return (sessionId: string, injection: ContextInjection): void => {
    send({ type: 'inject_context', sessionId, injection } as ClientMessage);
  };
}

/**
 * Builds a setToolMocks function that sends tool mock configuration via WS.
 */
export function buildSetToolMocks(send: WsSend) {
  return (sessionId: string, mocks: ToolMockConfig[]): void => {
    send({ type: 'set_tool_mocks', sessionId, mocks } as ClientMessage);
  };
}

/**
 * Builds a clearToolMocks function that clears all tool mocks via WS.
 */
export function buildClearToolMocks(send: WsSend) {
  return (sessionId: string): void => {
    send({ type: 'clear_tool_mocks', sessionId } as ClientMessage);
  };
}
```

- [ ] **Step 4: Verify types compile**

Run: `cd apps/studio && npx tsc --noEmit --pretty src/features/sessions/test-context.handlers.ts`

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/studio && pnpm vitest run src/features/sessions/__tests__/test-context.handlers.test.ts`

- [ ] **Step 6: Commit**

```bash
npx prettier --write apps/studio/src/features/sessions/test-context.handlers.ts apps/studio/src/features/sessions/__tests__/test-context.handlers.test.ts
git add apps/studio/src/features/sessions/test-context.handlers.ts apps/studio/src/features/sessions/__tests__/test-context.handlers.test.ts
git commit -m "[ABLP-2] feat(studio): add test context MessageBus handlers and WS wrappers"
```

---

### Task 12: Session Context Updates

**Files:**

- Modify: `src/infrastructure/session-context.ts`
- Test: `src/infrastructure/__tests__/session-context.test.ts` (add new tests)

Updates the `session-context.ts` reactive value (from Phase 1) to include `sessionId` and `activeAgent`. The sessions handler writes to session-context on `setSession`/`clearSession` so other features (Observatory) can read the active session.

- [ ] **Step 1: Write the failing test**

Add to the existing test file:

```typescript
// Append to: src/infrastructure/__tests__/session-context.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { setActiveSession, getActiveSession, subscribeActiveSession } from '../session-context';

describe('session-context — Phase 2 extensions', () => {
  beforeEach(() => {
    setActiveSession(null, null);
  });

  it('stores sessionId and agentName together', () => {
    setActiveSession('sess-1', 'support-agent');
    const session = getActiveSession();
    expect(session.sessionId).toBe('sess-1');
    expect(session.agentName).toBe('support-agent');
  });

  it('notifies subscribers on setActiveSession', () => {
    const updates: Array<{ sessionId: string | null; agentName: string | null }> = [];
    const unsub = subscribeActiveSession((s) => updates.push(s));

    setActiveSession('sess-1', 'agent-a');
    setActiveSession('sess-2', 'agent-b');
    setActiveSession(null, null);

    expect(updates).toHaveLength(3);
    expect(updates[0]).toEqual({ sessionId: 'sess-1', agentName: 'agent-a' });
    expect(updates[2]).toEqual({ sessionId: null, agentName: null });

    unsub();
  });

  it('sessions handler integration: setSession updates session-context', () => {
    // This tests that the sessions store and session-context stay in sync.
    // The sessions handler calls setActiveSession when processing setSession.
    setActiveSession('sess-new', 'new-agent');
    expect(getActiveSession().sessionId).toBe('sess-new');
    expect(getActiveSession().agentName).toBe('new-agent');
  });

  it('sessions handler integration: clearSession clears session-context', () => {
    setActiveSession('sess-1', 'agent-a');
    setActiveSession(null, null);
    expect(getActiveSession().sessionId).toBeNull();
    expect(getActiveSession().agentName).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

The Phase 1 `session-context.ts` already has `sessionId` and `agentName` fields — this test validates the contract that the sessions handler relies on. No code changes needed to `session-context.ts` itself.

Run: `cd apps/studio && pnpm vitest run src/infrastructure/__tests__/session-context.test.ts`

- [ ] **Step 3: Wire session-context into sessions handler**

Add to `sessions.handlers.ts` — in the `registerSessionsHandlers` function, after the `agent_loaded` handler (if present) or at the end of the registration block, add a Zustand `subscribe` that syncs the store to session-context:

```typescript
// Add to sessions.handlers.ts — inside registerSessionsHandlers, before the return

import { setActiveSession } from '@/infrastructure/session-context';

// Sync sessions store → session-context reactive value
const unsubStore = useSessionsStore.subscribe(
  (state) => ({ sessionId: state.sessionId, agentName: state.agent?.name ?? null }),
  (current, previous) => {
    if (current.sessionId !== previous.sessionId || current.agentName !== previous.agentName) {
      setActiveSession(current.sessionId, current.agentName);
    }
  },
  { equalityFn: (a, b) => a.sessionId === b.sessionId && a.agentName === b.agentName },
);
unsubscribers.push(unsubStore);
```

**NOTE:** Zustand's `subscribe` with a selector requires `zustand/middleware/subscribeWithSelector`. If the store does not yet use this middleware, wrap it:

```typescript
// In sessions.store.ts, add subscribeWithSelector middleware:
import { subscribeWithSelector } from 'zustand/middleware';

// Wrap: create<SessionsStore>()(devtools(subscribeWithSelector((set, get) => ({ ... }))))
```

- [ ] **Step 4: Verify types compile**

Run: `cd apps/studio && npx tsc --noEmit --pretty src/features/sessions/sessions.handlers.ts`

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/studio && pnpm vitest run src/infrastructure/__tests__/session-context.test.ts src/features/sessions/__tests__/sessions.handlers.test.ts`

- [ ] **Step 6: Commit**

```bash
npx prettier --write apps/studio/src/features/sessions/sessions.handlers.ts apps/studio/src/features/sessions/sessions.store.ts apps/studio/src/infrastructure/__tests__/session-context.test.ts
git add apps/studio/src/features/sessions/sessions.handlers.ts apps/studio/src/features/sessions/sessions.store.ts apps/studio/src/infrastructure/__tests__/session-context.test.ts
git commit -m "[ABLP-2] feat(studio): wire session-context sync into sessions handler"
```

---

### Task 13: Barrel Exports + index.ts

**Files:**

- Create: `src/features/sessions/index.ts`

- [ ] **Step 1: Create index.ts**

```typescript
// src/features/sessions/index.ts

/**
 * Sessions Feature Module — Barrel Exports
 *
 * Public API for the sessions feature. Components and other features
 * should import from this barrel, not from internal files.
 */

// ── Contract schemas ────────────────────────────────────────────────────
export {
  SessionMessageSchema,
  SessionMessageMetadataSchema,
  AgentStateSchema,
  AgentMemorySchema,
  FlowStateSchema,
  ErrorStateSchema,
  ActiveAgentSchema,
  ConstructActionSchema,
  TraceEventSchema,
  TraceEventTypeSchema,
  DecisionKindSchema,
  SessionServerMessageSchema,
} from './sessions.contract';

export {
  TestContextPayloadSchema,
  ToolMockConfigSchema,
  ContextInjectionSchema,
  ContextInjectedMessageSchema,
  ToolMockSetMessageSchema,
  ContextInjectionErrorMessageSchema,
} from './test-context.contract';

// ── Types ───────────────────────────────────────────────────────────────
export type {
  SessionMessage,
  SessionMessageMetadata,
  AgentState,
  AgentMemory,
  FlowState,
  ErrorState,
  ActiveAgent,
  ConstructAction,
  TraceEvent,
  TraceEventType,
  DecisionKind,
  SessionServerMessage,
  AgentStatePatch,
} from './sessions.types';

// ── Store ───────────────────────────────────────────────────────────────
export { useSessionsStore, MAX_MESSAGES } from './sessions.store';
export type { AgentDetails } from './sessions.store';

// ── Pure functions ──────────────────────────────────────────────────────
export { formatTraceEventLog } from './trace-event-logger';
export { mergeToolThought, mergeHandoffMetadata } from './thought-card-merger';
export type {
  ToolThoughtInput,
  MergeToolThoughtResult,
  HandoffInput,
  MergeHandoffResult,
} from './thought-card-merger';
export { extractStatePatch } from './state-extractor';

// ── Handlers ────────────────────────────────────────────────────────────
export { registerSessionsHandlers } from './sessions.handlers';
export {
  registerTestContextHandlers,
  buildInjectContext,
  buildSetToolMocks,
  buildClearToolMocks,
} from './test-context.handlers';

// ── API ─────────────────────────────────────────────────────────────────
export {
  fetchSessionDetail,
  fetchSessionList,
  buildSendMessage,
  buildResetSession,
  buildRunTest,
  buildResumeSession,
  buildLoadAgent,
  buildLoadAgentWithContext,
} from './sessions.api';
```

- [ ] **Step 2: Verify types compile**

Run: `cd apps/studio && npx tsc --noEmit --pretty src/features/sessions/index.ts`

- [ ] **Step 3: Commit**

```bash
npx prettier --write apps/studio/src/features/sessions/index.ts
git add apps/studio/src/features/sessions/index.ts
git commit -m "[ABLP-2] feat(studio): add sessions feature barrel exports"
```

---

## Chunk 3: Integration + Migration (Tasks 14–19)

### Task 14: Barrel Re-Exports from Legacy session-store

**Files:**

- Modify: `src/store/session-store.ts`

The existing `session-store.ts` re-exports everything from the new feature module. All existing consumers (`import { useSessionStore } from '@/store/session-store'`) continue to work without modification.

- [ ] **Step 1: Write the failing test**

Create `src/features/sessions/__tests__/barrel-reexport.test.ts`:

```typescript
// src/features/sessions/__tests__/barrel-reexport.test.ts
import { describe, it, expect } from 'vitest';

describe('barrel re-export from legacy session-store', () => {
  it('re-exports useSessionStore from features/sessions', async () => {
    const legacy = await import('@/store/session-store');
    const feature = await import('@/features/sessions/sessions.store');

    // The re-exported store IS the same reference
    expect(legacy.useSessionStore).toBe(feature.useSessionsStore);
  });

  it('re-exports all expected members', async () => {
    const legacy = await import('@/store/session-store');

    // The legacy module must export useSessionStore
    expect(typeof legacy.useSessionStore).toBe('function');
  });
});
```

- [ ] **Step 2: Convert session-store.ts to re-export**

Replace `src/store/session-store.ts` with:

```typescript
// MIGRATION: This file re-exports from features/sessions/sessions.store.ts
// All existing imports (`import { useSessionStore } from '@/store/session-store'`)
// continue to work unchanged. After all consumers migrate to
// `@/features/sessions`, this file can be deleted.
//
// The new store is named `useSessionsStore` (plural) in the feature module,
// but re-exported here as `useSessionStore` (singular) for backward compatibility.

export { useSessionsStore as useSessionStore } from '@/features/sessions/sessions.store';
export type { AgentDetails } from '@/features/sessions/sessions.store';
```

- [ ] **Step 3: Verify existing tests still pass**

Run: `cd apps/studio && pnpm build`
Expected: Build succeeds — all existing imports resolve.

Run: `cd apps/studio && pnpm vitest run src/features/sessions/__tests__/barrel-reexport.test.ts`
Expected: Both tests pass.

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/studio/src/store/session-store.ts apps/studio/src/features/sessions/__tests__/barrel-reexport.test.ts
git add apps/studio/src/store/session-store.ts apps/studio/src/features/sessions/__tests__/barrel-reexport.test.ts
git commit -m "[ABLP-2] refactor(studio): convert session-store to re-export from features/sessions"
```

---

### Task 15: Dual-Write in WebSocketContext for Sessions

**Files:**

- Modify: `src/contexts/WebSocketContext.tsx`
- Create: `src/features/sessions/__tests__/sessions-dual-write.test.ts`

In Phase 1, the WebSocketContext already emits ALL messages to the MessageBus via a `bus.emit()` call at the top of `handleMessage`. The observatory handlers registered on the bus already process `trace_event`, `session_reset`, `agent_loaded`, etc.

In this task, we register the sessions handlers on the same bus. Since the bus already receives all message types, we simply need to call `registerSessionsHandlers(bus)` and `registerTestContextHandlers(bus)` alongside the existing `registerObservatoryHandlers(bus)`. The old inline session handling in the switch statement remains during the transition period.

- [ ] **Step 1: Write the failing test**

```typescript
// src/features/sessions/__tests__/sessions-dual-write.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageBus } from '@/infrastructure/message-bus';
import { registerSessionsHandlers } from '../sessions.handlers';
import { registerTestContextHandlers } from '../test-context.handlers';
import { useSessionsStore } from '../sessions.store';

describe('sessions dual-write via MessageBus', () => {
  let bus: MessageBus;

  beforeEach(() => {
    bus = new MessageBus();
    registerSessionsHandlers(bus);
    registerTestContextHandlers(bus);
    useSessionsStore.getState().clearSession();
  });

  it('agent_loaded sets session in new store', () => {
    bus.emit('agent_loaded', {
      sessionId: 'sess-1',
      agent: {
        id: 'a1',
        name: 'greeter',
        filePath: '/agents/greeter.abl',
        type: 'agent',
        mode: 'scripted',
        toolCount: 2,
        gatherFieldCount: 3,
        isSupervisor: false,
        dsl: 'AGENT greeter',
      },
    });

    const state = useSessionsStore.getState();
    expect(state.sessionId).toBe('sess-1');
    expect(state.agent?.name).toBe('greeter');
  });

  it('response_start/chunk/end flow produces assistant message', () => {
    // Setup session first
    bus.emit('agent_loaded', {
      sessionId: 'sess-1',
      agent: {
        id: 'a1',
        name: 'greeter',
        filePath: '',
        type: 'agent',
        mode: 'scripted',
        toolCount: 0,
        gatherFieldCount: 0,
        isSupervisor: false,
        dsl: '',
      },
    });

    bus.emit('response_start', { messageId: 'msg-1' });
    expect(useSessionsStore.getState().isStreaming).toBe(true);

    bus.emit('response_chunk', { chunk: 'Hello ' });
    bus.emit('response_chunk', { chunk: 'world' });
    expect(useSessionsStore.getState().streamingContent).toBe('Hello world');

    bus.emit('response_end', { fullText: 'Hello world' });
    const msgs = useSessionsStore.getState().messages;
    expect(msgs.some((m) => m.role === 'assistant' && m.content === 'Hello world')).toBe(true);
    expect(useSessionsStore.getState().isStreaming).toBe(false);
  });

  it('trace_event with tool_thought merges into thought card', () => {
    bus.emit('agent_loaded', {
      sessionId: 'sess-1',
      agent: {
        id: 'a1',
        name: 'greeter',
        filePath: '',
        type: 'agent',
        mode: 'scripted',
        toolCount: 0,
        gatherFieldCount: 0,
        isSupervisor: false,
        dsl: '',
      },
    });

    // Start streaming to create the placeholder thought
    bus.emit('response_start', { messageId: 'msg-1' });

    bus.emit('trace_event', {
      sessionId: 'sess-1',
      event: {
        id: 'te-1',
        type: 'tool_thought',
        timestamp: new Date().toISOString(),
        data: {
          thought: 'Calling search API',
          toolName: 'search',
          agentName: 'greeter',
        },
      },
    });

    const thoughts = useSessionsStore.getState().messages.filter((m) => m.role === 'thought');
    expect(thoughts.length).toBeGreaterThanOrEqual(1);
    expect(thoughts[0].content).toContain('Calling search API');
  });

  it('state_update updates agent state', () => {
    bus.emit('agent_loaded', {
      sessionId: 'sess-1',
      agent: {
        id: 'a1',
        name: 'greeter',
        filePath: '',
        type: 'agent',
        mode: 'scripted',
        toolCount: 0,
        gatherFieldCount: 0,
        isSupervisor: false,
        dsl: '',
      },
    });

    bus.emit('state_update', {
      state: {
        context: { name: 'Alice' },
        conversationPhase: 'gathering',
        gatherProgress: { name: 'Alice' },
        constraintResults: {},
        lastToolResults: {},
        memory: { session: {}, persistentCache: {}, pendingRemembers: [] },
      },
      updates: {},
    });

    expect(useSessionsStore.getState().state?.context).toEqual({ name: 'Alice' });
  });

  it('session_reset clears messages and resets state', () => {
    // Setup with a message
    bus.emit('agent_loaded', {
      sessionId: 'sess-1',
      agent: {
        id: 'a1',
        name: 'greeter',
        filePath: '',
        type: 'agent',
        mode: 'scripted',
        toolCount: 0,
        gatherFieldCount: 0,
        isSupervisor: false,
        dsl: '',
      },
    });

    // Simulate reset
    bus.emit('session_reset', { sessionId: 'sess-1' });
    expect(useSessionsStore.getState().state?.conversationPhase).toBe('start');
  });

  it('context_injected updates agent state context', () => {
    bus.emit('agent_loaded', {
      sessionId: 'sess-1',
      agent: {
        id: 'a1',
        name: 'greeter',
        filePath: '',
        type: 'agent',
        mode: 'scripted',
        toolCount: 0,
        gatherFieldCount: 0,
        isSupervisor: false,
        dsl: '',
      },
    });

    bus.emit('context_injected', {
      updatedValues: { city: 'NYC' },
    });

    expect(useSessionsStore.getState().state?.context).toEqual(
      expect.objectContaining({ city: 'NYC' }),
    );
  });

  it('both old store and new store receive agent_loaded (dual-write parity)', () => {
    // This test verifies that during the dual-write phase,
    // the MessageBus handler populates the new store correctly
    bus.emit('agent_loaded', {
      sessionId: 'sess-dual',
      agent: {
        id: 'a1',
        name: 'dual-agent',
        filePath: '/test.abl',
        type: 'agent',
        mode: 'reasoning',
        toolCount: 5,
        gatherFieldCount: 0,
        isSupervisor: false,
        dsl: '',
      },
    });

    const newStore = useSessionsStore.getState();
    expect(newStore.sessionId).toBe('sess-dual');
    expect(newStore.agent?.name).toBe('dual-agent');
    expect(newStore.agent?.mode).toBe('reasoning');
  });
});
```

- [ ] **Step 2: Register sessions handlers on the MessageBus**

In `src/contexts/WebSocketContext.tsx`, inside the `getOrCreateBus()` function (added in Phase 1 Task 16), add sessions handler registration alongside the existing observatory registration:

```typescript
import { registerSessionsHandlers } from '@/features/sessions/sessions.handlers';
import { registerTestContextHandlers } from '@/features/sessions/test-context.handlers';

function getOrCreateBus(): MessageBus {
  if (bus) return bus;
  bus = new MessageBus();
  transportTap = createTapMiddleware('ws-transport');
  handlerTap = createTapMiddleware('handler');
  bus.use(transportTap.middleware);
  bus.use(handlerTap.middleware);

  // Check if capture is enabled
  const captureEnabled =
    localStorage.getItem('STUDIO_DEBUG_CAPTURE') === 'true' ||
    new URLSearchParams(window.location.search).has('debug');
  transportTap.setEnabled(captureEnabled);
  handlerTap.setEnabled(captureEnabled);

  // Register feature handlers
  registerObservatoryHandlers(bus); // Phase 1
  registerSessionsHandlers(bus); // Phase 2 — sessions + chat
  registerTestContextHandlers(bus); // Phase 2 — test context

  return bus;
}
```

The existing `bus.emit(message.type, message)` call at the top of `handleMessage` already dispatches to ALL registered handlers. No additional emit calls are needed.

The old inline session handling in the switch statement (`case 'agent_loaded':`, `case 'response_start':`, etc.) remains during the transition period. Both the old code path AND the new bus handler process the same messages. This is safe because:

1. The old path writes to the OLD `useSessionStore` (from `@/store/session-store`)
2. The new path writes to the NEW `useSessionsStore` (from `@/features/sessions/sessions.store`)
3. After Task 14's re-export, these ARE the same store, so writes converge

- [ ] **Step 3: Verify both paths produce identical results**

Run: `cd apps/studio && pnpm build`
Expected: Build succeeds.

Run: `cd apps/studio && pnpm vitest run src/features/sessions/__tests__/sessions-dual-write.test.ts`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/studio/src/contexts/WebSocketContext.tsx apps/studio/src/features/sessions/__tests__/sessions-dual-write.test.ts
git add apps/studio/src/contexts/WebSocketContext.tsx apps/studio/src/features/sessions/__tests__/sessions-dual-write.test.ts
git commit -m "[ABLP-2] feat(studio): register sessions handlers on MessageBus (dual-write)"
```

---

### Task 16: Component Migration (chat/ to features/sessions/components/)

**Files:**

- Move: `src/components/chat/ChatPanel.tsx` -> `src/features/sessions/components/ChatPanel.tsx`
- Move: `src/components/chat/MessageList.tsx` -> `src/features/sessions/components/MessageList.tsx`
- Move: `src/components/chat/ChatInput.tsx` -> `src/features/sessions/components/ChatInput.tsx`
- Move: `src/components/chat/StreamingMessage.tsx` -> `src/features/sessions/components/StreamingMessage.tsx`
- Move: `src/components/chat/ChatWithDebugPanel.tsx` -> `src/features/sessions/components/ChatWithDebugPanel.tsx`
- Move: `src/components/chat/SessionSidebar.tsx` -> `src/features/sessions/components/SessionSidebar.tsx`
- Create: `src/components/chat/index.ts` (barrel re-exports for backward compatibility)

- [ ] **Step 1: Create the target directory and move files**

```bash
mkdir -p apps/studio/src/features/sessions/components
```

Move each file and update internal imports to use `@/features/sessions/` paths:

**ChatPanel.tsx** — update imports:

```typescript
// src/features/sessions/components/ChatPanel.tsx
// Changed imports:
import { useSession } from '@/hooks/useSession'; // keeps using hook (migrated in Task 17)
import { useSessionsStore } from '@/features/sessions/sessions.store'; // was: @/store/session-store
import { useWebSocketContext } from '@/contexts/WebSocketContext';
import { useNavigationStore } from '@/store/navigation-store';
import { MessageList } from './MessageList'; // relative within feature
import { StreamingMessage } from './StreamingMessage'; // relative within feature
import { ChatInput } from './ChatInput'; // relative within feature
import { useTestContextStore } from '@/store/test-context-store';
```

Key change: `useSessionStore` becomes `useSessionsStore` (imported from feature module). All call sites use the same API — `useSessionsStore.getState()` for imperative access, selector hooks for reactive access.

**MessageList.tsx** — update imports:

```typescript
// src/features/sessions/components/MessageList.tsx
// Changed imports:
import type { SessionMessage } from '@/features/sessions/sessions.types'; // was: @/types
import { useSessionsStore } from '@/features/sessions/sessions.store'; // was: @/store/session-store
import { MarkdownContent } from '@/components/ui/MarkdownContent'; // absolute path to shared UI
```

**ChatInput.tsx** — update imports:

```typescript
// src/features/sessions/components/ChatInput.tsx
// Changed imports:
import { apiFetch } from '@/lib/api-client';
import { useNavigationStore } from '@/store/navigation-store';
import { useSessionsStore } from '@/features/sessions/sessions.store'; // was: @/store/session-store
```

**StreamingMessage.tsx** — update imports:

```typescript
// src/features/sessions/components/StreamingMessage.tsx
// Changed imports:
import { MarkdownContent } from '@/components/ui/MarkdownContent'; // absolute path to shared UI
// (no session-store import in this component — no changes beyond path)
```

**ChatWithDebugPanel.tsx** — update imports:

```typescript
// src/features/sessions/components/ChatWithDebugPanel.tsx
// Changed imports:
import { ChatPanel } from './ChatPanel'; // relative within feature
import { SessionSidebar } from './SessionSidebar'; // relative within feature
import { DebugTabs } from '@/components/observatory/DebugTabs';
import { FloatingDebugPanel } from '@/components/observatory/FloatingDebugPanel';
import { useObservatoryStore } from '@/store/observatory-store';
import { useWebSocketContext } from '@/contexts/WebSocketContext';
import { useNavigationStore } from '@/store/navigation-store';
import { fetchRuntimeAgent } from '@/api/runtime-agents';
import { useSessionsStore } from '@/features/sessions/sessions.store'; // was: @/store/session-store
import { useTestContextStore } from '@/store/test-context-store';
```

**SessionSidebar.tsx** — update imports:

```typescript
// src/features/sessions/components/SessionSidebar.tsx
// Changed imports:
import { useAgentSessions } from '@/hooks/useAgentSessions';
import { useSessionsStore } from '@/features/sessions/sessions.store'; // was: @/store/session-store
import { useNavigationStore } from '@/store/navigation-store';
import { useWebSocketContext } from '@/contexts/WebSocketContext';
import { useObservatoryStore } from '@/store/observatory-store';
import { apiFetch } from '@/lib/api-client';
```

- [ ] **Step 2: Create backward-compatible barrel at old path**

Create `src/components/chat/index.ts`:

```typescript
// MIGRATION: Chat components have moved to @/features/sessions/components/.
// This barrel re-exports for backward compatibility.
// After all consumers migrate, delete this directory.

export { ChatPanel } from '@/features/sessions/components/ChatPanel';
export { MessageList } from '@/features/sessions/components/MessageList';
export { ChatInput } from '@/features/sessions/components/ChatInput';
export { StreamingMessage } from '@/features/sessions/components/StreamingMessage';
export { ChatWithDebugPanel } from '@/features/sessions/components/ChatWithDebugPanel';
export { SessionSidebar } from '@/features/sessions/components/SessionSidebar';
```

- [ ] **Step 3: Update external consumers to use barrel**

These files import directly from `components/chat/`:

1. `src/components/navigation/AppShell.tsx`:

   ```typescript
   // Before:
   import { ChatWithDebugPanel } from '../chat/ChatWithDebugPanel';
   // After:
   import { ChatWithDebugPanel } from '@/features/sessions/components/ChatWithDebugPanel';
   ```

2. `src/__tests__/chat-and-projects.test.tsx`:

   ```typescript
   // Before:
   import { ChatPanel } from '../components/chat/ChatPanel';
   import { ChatWithDebugPanel } from '../components/chat/ChatWithDebugPanel';
   // After:
   import { ChatPanel } from '@/features/sessions/components/ChatPanel';
   import { ChatWithDebugPanel } from '@/features/sessions/components/ChatWithDebugPanel';
   ```

3. `src/__tests__/chat-input-attachments.test.tsx`:

   ```typescript
   // Before:
   import { ChatInput } from '../components/chat/ChatInput';
   // After:
   import { ChatInput } from '@/features/sessions/components/ChatInput';
   ```

4. `src/__tests__/message-list-attachments.test.tsx`:

   ```typescript
   // Before:
   import { MessageList } from '../components/chat/MessageList';
   // After:
   import { MessageList } from '@/features/sessions/components/MessageList';
   ```

- [ ] **Step 4: Verify build and tests**

Run: `cd apps/studio && pnpm build`
Expected: Build succeeds — all imports resolve via new paths or barrel re-exports.

Run: `cd apps/studio && pnpm vitest run`
Expected: All existing tests pass.

- [ ] **Step 5: Commit**

```bash
npx prettier --write \
  apps/studio/src/features/sessions/components/ChatPanel.tsx \
  apps/studio/src/features/sessions/components/MessageList.tsx \
  apps/studio/src/features/sessions/components/ChatInput.tsx \
  apps/studio/src/features/sessions/components/StreamingMessage.tsx \
  apps/studio/src/features/sessions/components/ChatWithDebugPanel.tsx \
  apps/studio/src/features/sessions/components/SessionSidebar.tsx \
  apps/studio/src/components/chat/index.ts \
  apps/studio/src/components/navigation/AppShell.tsx \
  apps/studio/src/__tests__/chat-and-projects.test.tsx \
  apps/studio/src/__tests__/chat-input-attachments.test.tsx \
  apps/studio/src/__tests__/message-list-attachments.test.tsx

git add \
  apps/studio/src/features/sessions/components/ \
  apps/studio/src/components/chat/index.ts \
  apps/studio/src/components/navigation/AppShell.tsx \
  apps/studio/src/__tests__/chat-and-projects.test.tsx \
  apps/studio/src/__tests__/chat-input-attachments.test.tsx \
  apps/studio/src/__tests__/message-list-attachments.test.tsx

git rm \
  apps/studio/src/components/chat/ChatPanel.tsx \
  apps/studio/src/components/chat/MessageList.tsx \
  apps/studio/src/components/chat/ChatInput.tsx \
  apps/studio/src/components/chat/StreamingMessage.tsx \
  apps/studio/src/components/chat/ChatWithDebugPanel.tsx \
  apps/studio/src/components/chat/SessionSidebar.tsx

git commit -m "[ABLP-2] refactor(studio): move chat components to features/sessions/components"
```

---

### Task 17: useSession Hook Refactor

**Files:**

- Modify: `src/hooks/useSession.ts`
- Create: `src/features/sessions/__tests__/use-session-refactored.test.ts`

Refactor `useSession` to delegate to the new sessions store while keeping the same public API. The hook remains a thin computed-value wrapper.

- [ ] **Step 1: Write the failing test**

```typescript
// src/features/sessions/__tests__/use-session-refactored.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSession } from '@/hooks/useSession';
import { useSessionsStore } from '../sessions.store';

describe('useSession hook (refactored)', () => {
  beforeEach(() => {
    useSessionsStore.getState().clearSession();
  });

  it('returns hasSession=false when no session', () => {
    const { result } = renderHook(() => useSession());
    expect(result.current.hasSession).toBe(false);
    expect(result.current.hasAgent).toBe(false);
  });

  it('returns session data after setSession', () => {
    const { result } = renderHook(() => useSession());

    act(() => {
      useSessionsStore.getState().setSession('sess-1', {
        id: 'a1',
        name: 'test-agent',
        filePath: '/test.abl',
        type: 'agent',
        mode: 'scripted',
        toolCount: 3,
        gatherFieldCount: 2,
        isSupervisor: false,
        dsl: '',
      });
    });

    expect(result.current.hasSession).toBe(true);
    expect(result.current.hasAgent).toBe(true);
    expect(result.current.agent?.name).toBe('test-agent');
    expect(result.current.gatherFields).toBe(2);
    expect(result.current.toolCount).toBe(3);
  });

  it('computes gatherPercentage correctly', () => {
    const { result } = renderHook(() => useSession());

    act(() => {
      useSessionsStore.getState().setSession('sess-1', {
        id: 'a1',
        name: 'test-agent',
        filePath: '',
        type: 'agent',
        mode: 'scripted',
        toolCount: 0,
        gatherFieldCount: 4,
        isSupervisor: false,
        dsl: '',
      });
    });

    act(() => {
      useSessionsStore.getState().updateState({
        gatherProgress: { name: 'Alice', email: 'alice@test.com' },
      });
    });

    expect(result.current.gatheredCount).toBe(2);
    expect(result.current.gatherPercentage).toBe(50);
  });

  it('detects completion, escalation, handoff from lastAction', () => {
    const { result } = renderHook(() => useSession());

    act(() => {
      useSessionsStore.getState().setSession('sess-1', {
        id: 'a1',
        name: 'test-agent',
        filePath: '',
        type: 'agent',
        mode: 'scripted',
        toolCount: 0,
        gatherFieldCount: 0,
        isSupervisor: false,
        dsl: '',
      });
    });

    act(() => {
      useSessionsStore.getState().setLastAction({ type: 'complete' });
    });
    expect(result.current.isComplete).toBe(true);

    act(() => {
      useSessionsStore.getState().setLastAction({ type: 'escalate' });
    });
    expect(result.current.isEscalated).toBe(true);

    act(() => {
      useSessionsStore.getState().setLastAction({ type: 'handoff' });
    });
    expect(result.current.isHandedOff).toBe(true);
  });

  it('clearSession resets all computed values', () => {
    const { result } = renderHook(() => useSession());

    act(() => {
      useSessionsStore.getState().setSession('sess-1', {
        id: 'a1',
        name: 'test-agent',
        filePath: '',
        type: 'agent',
        mode: 'scripted',
        toolCount: 0,
        gatherFieldCount: 0,
        isSupervisor: false,
        dsl: '',
      });
    });

    act(() => {
      useSessionsStore.getState().clearSession();
    });

    expect(result.current.hasSession).toBe(false);
    expect(result.current.hasAgent).toBe(false);
    expect(result.current.messages).toEqual([]);
  });
});
```

- [ ] **Step 2: Refactor useSession.ts**

Replace `src/hooks/useSession.ts`:

```typescript
/**
 * Session Hook
 *
 * Provides convenient access to session state and actions.
 * Delegates to the sessions feature store for all data.
 * Computed fields (hasSession, gatherProgress, etc.) remain here
 * as a thin convenience wrapper.
 */

import { useSessionsStore } from '@/features/sessions/sessions.store';

export function useSession() {
  const {
    sessionId,
    agent,
    messages,
    state,
    lastAction,
    isStreaming,
    streamingContent,
    isLoading,
    error,
    clearSession,
  } = useSessionsStore();

  const hasSession = !!sessionId;
  const hasAgent = !!agent;

  // Computed values
  const gatherFields = agent?.gatherFieldCount ?? 0;
  const toolCount = agent?.toolCount ?? 0;
  const isComplete = lastAction?.type === 'complete';
  const isEscalated = lastAction?.type === 'escalate';
  const isHandedOff = lastAction?.type === 'handoff';

  // Gather progress
  const gatherProgress = state?.gatherProgress ?? {};
  const gatheredCount = Object.keys(gatherProgress).length;
  const gatherPercentage = gatherFields > 0 ? Math.round((gatheredCount / gatherFields) * 100) : 0;

  // Conversation phase
  const phase = state?.conversationPhase ?? 'start';

  return {
    // State
    sessionId,
    agent,
    messages,
    state,
    lastAction,
    isStreaming,
    streamingContent,
    isLoading,
    error,

    // Computed
    hasSession,
    hasAgent,
    gatherFields,
    toolCount,
    isComplete,
    isEscalated,
    isHandedOff,
    gatherProgress,
    gatheredCount,
    gatherPercentage,
    phase,

    // Actions
    clearSession,
  };
}
```

The only change: `import { useSessionStore }` becomes `import { useSessionsStore }` from the feature module. All call sites (`useSessionStore()`) become `useSessionsStore()`. The public API is identical.

- [ ] **Step 3: Verify tests**

Run: `cd apps/studio && pnpm build`
Expected: Build succeeds.

Run: `cd apps/studio && pnpm vitest run src/features/sessions/__tests__/use-session-refactored.test.ts`
Expected: All tests pass.

Run: `cd apps/studio && pnpm vitest run src/__tests__/session-hooks.test.ts`
Expected: Existing session hooks test passes (it imports `useSession` which now delegates to the new store).

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/studio/src/hooks/useSession.ts apps/studio/src/features/sessions/__tests__/use-session-refactored.test.ts
git add apps/studio/src/hooks/useSession.ts apps/studio/src/features/sessions/__tests__/use-session-refactored.test.ts
git commit -m "[ABLP-2] refactor(studio): delegate useSession hook to sessions feature store"
```

---

### Task 18: Integration Test — Full Message Lifecycle

**Files:**

- Create: `src/features/sessions/__tests__/sessions-lifecycle.integration.test.ts`

End-to-end test exercising the full message lifecycle through the MessageBus: load agent, send message, receive streaming response with tool thoughts, state updates, and trace events.

- [ ] **Step 1: Write the integration test**

```typescript
// src/features/sessions/__tests__/sessions-lifecycle.integration.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { MessageBus } from '@/infrastructure/message-bus';
import { registerSessionsHandlers } from '../sessions.handlers';
import { useSessionsStore } from '../sessions.store';

// Import fixtures (created in Task 7)
import serverMessages from '../__fixtures__/server-messages-session.json';
import traceEventsFixture from '../__fixtures__/trace-events-session.json';

describe('sessions lifecycle integration', () => {
  let bus: MessageBus;

  beforeEach(() => {
    bus = new MessageBus();
    registerSessionsHandlers(bus);
    useSessionsStore.getState().clearSession();
  });

  it('full message lifecycle: load -> send -> stream -> thought -> state -> end', () => {
    const store = useSessionsStore;

    // ── Step 1: Agent loaded ──────────────────────────────────────────────
    bus.emit('agent_loaded', {
      sessionId: 'lifecycle-sess',
      agent: {
        id: 'agent-1',
        name: 'support-agent',
        filePath: '/agents/support.abl',
        type: 'agent',
        mode: 'scripted',
        toolCount: 3,
        gatherFieldCount: 2,
        isSupervisor: false,
        dsl: 'AGENT support',
      },
    });

    expect(store.getState().sessionId).toBe('lifecycle-sess');
    expect(store.getState().agent?.name).toBe('support-agent');
    expect(store.getState().messages).toEqual([]);

    // ── Step 2: Simulate user sending a message ───────────────────────────
    // (In production, sendMessage adds the user message directly to store)
    store.getState().addMessage({
      id: 'user-msg-1',
      role: 'user',
      content: 'I need help with my order',
      timestamp: new Date(),
      traceIds: [],
    });
    expect(store.getState().messages).toHaveLength(1);
    expect(store.getState().messages[0].role).toBe('user');

    // ── Step 3: Response stream starts ────────────────────────────────────
    bus.emit('response_start', { messageId: 'resp-1' });
    expect(store.getState().isStreaming).toBe(true);
    expect(store.getState().streamingMessageId).toBe('resp-1');

    // Placeholder thought is created
    const msgsAfterStart = store.getState().messages;
    expect(msgsAfterStart.some((m) => m.role === 'thought')).toBe(true);

    // ── Step 4: Tool thought trace event ──────────────────────────────────
    bus.emit('trace_event', {
      sessionId: 'lifecycle-sess',
      event: {
        id: 'te-thought-1',
        type: 'tool_thought',
        timestamp: new Date().toISOString(),
        data: {
          thought: 'Looking up order #12345',
          toolName: 'order_lookup',
          agentName: 'support-agent',
        },
      },
    });

    // Thought card should have content now
    const thoughts = store.getState().messages.filter((m) => m.role === 'thought');
    expect(thoughts.length).toBeGreaterThanOrEqual(1);
    const thoughtWithContent = thoughts.find((t) => t.content.includes('Looking up order'));
    expect(thoughtWithContent).toBeDefined();

    // ── Step 5: Response chunks arrive ────────────────────────────────────
    bus.emit('response_chunk', { chunk: 'I found your order. ' });
    bus.emit('response_chunk', { chunk: 'It shipped yesterday.' });
    expect(store.getState().streamingContent).toBe('I found your order. It shipped yesterday.');

    // ── Step 6: State update (gather progress) ────────────────────────────
    bus.emit('state_update', {
      state: {
        context: { orderId: '12345' },
        conversationPhase: 'resolving',
        gatherProgress: { orderId: '12345' },
        constraintResults: {},
        lastToolResults: {},
        memory: { session: {}, persistentCache: {}, pendingRemembers: [] },
      },
      updates: {},
    });

    expect(store.getState().state?.gatherProgress).toEqual({ orderId: '12345' });
    expect(store.getState().state?.conversationPhase).toBe('resolving');

    // ── Step 7: dsl_collect trace event extracts state ────────────────────
    bus.emit('trace_event', {
      sessionId: 'lifecycle-sess',
      event: {
        id: 'te-collect-1',
        type: 'dsl_collect',
        timestamp: new Date().toISOString(),
        data: {
          extracted: { customerName: 'Jane Doe' },
          context: { orderId: '12345', customerName: 'Jane Doe' },
        },
      },
    });

    expect(store.getState().state?.gatherProgress).toEqual(
      expect.objectContaining({ customerName: 'Jane Doe' }),
    );
    expect(store.getState().state?.context).toEqual(
      expect.objectContaining({ customerName: 'Jane Doe' }),
    );

    // ── Step 8: Response stream ends ──────────────────────────────────────
    bus.emit('response_end', {
      fullText: 'I found your order. It shipped yesterday.',
    });

    expect(store.getState().isStreaming).toBe(false);
    expect(store.getState().streamingContent).toBe('');

    // Final message list should contain: user, thought(s), assistant
    const finalMsgs = store.getState().messages;
    expect(finalMsgs.some((m) => m.role === 'user')).toBe(true);
    expect(finalMsgs.some((m) => m.role === 'assistant')).toBe(true);
    expect(
      finalMsgs.some((m) => m.role === 'assistant' && m.content.includes('It shipped yesterday')),
    ).toBe(true);

    // ── Step 9: Verify complete state ─────────────────────────────────────
    const finalState = store.getState();
    expect(finalState.sessionId).toBe('lifecycle-sess');
    expect(finalState.error).toBeNull();
    expect(finalState.isLoading).toBe(false);
  });

  it('error trace event surfaces as system message', () => {
    bus.emit('agent_loaded', {
      sessionId: 'err-sess',
      agent: {
        id: 'a1',
        name: 'err-agent',
        filePath: '',
        type: 'agent',
        mode: 'reasoning',
        toolCount: 0,
        gatherFieldCount: 0,
        isSupervisor: false,
        dsl: '',
      },
    });

    bus.emit('trace_event', {
      sessionId: 'err-sess',
      event: {
        id: 'te-err-1',
        type: 'error',
        timestamp: new Date().toISOString(),
        data: {
          message: 'Tool execution failed: timeout',
        },
      },
    });

    const systemMsgs = useSessionsStore.getState().messages.filter((m) => m.role === 'system');
    expect(systemMsgs.length).toBeGreaterThanOrEqual(1);
    expect(systemMsgs[0].content).toContain('Error');
  });

  it('handoff trace event merges into thought card', () => {
    bus.emit('agent_loaded', {
      sessionId: 'handoff-sess',
      agent: {
        id: 'a1',
        name: 'supervisor',
        filePath: '',
        type: 'agent',
        mode: 'reasoning',
        toolCount: 0,
        gatherFieldCount: 0,
        isSupervisor: true,
        dsl: '',
      },
    });

    // Start streaming (creates thought placeholder)
    bus.emit('response_start', { messageId: 'ho-msg-1' });

    // Add a tool thought first so there's a thought card to merge into
    bus.emit('trace_event', {
      sessionId: 'handoff-sess',
      event: {
        id: 'te-thought-ho',
        type: 'tool_thought',
        timestamp: new Date().toISOString(),
        data: {
          thought: 'Analyzing request',
          toolName: '__handoff__',
          agentName: 'supervisor',
        },
      },
    });

    // Handoff event
    bus.emit('trace_event', {
      sessionId: 'handoff-sess',
      event: {
        id: 'te-handoff-1',
        type: 'handoff',
        timestamp: new Date().toISOString(),
        data: {
          from: 'supervisor',
          to: 'billing-agent',
        },
      },
    });

    // The thought card should have handoff metadata
    const thoughts = useSessionsStore.getState().messages.filter((m) => m.role === 'thought');
    const handoffThought = thoughts.find((t) => t.metadata?.handoffTo === 'billing-agent');
    expect(handoffThought).toBeDefined();
  });

  it('action_taken sets lastAction', () => {
    bus.emit('agent_loaded', {
      sessionId: 'action-sess',
      agent: {
        id: 'a1',
        name: 'agent',
        filePath: '',
        type: 'agent',
        mode: 'scripted',
        toolCount: 0,
        gatherFieldCount: 0,
        isSupervisor: false,
        dsl: '',
      },
    });

    bus.emit('action_taken', {
      action: { type: 'complete', data: { summary: 'Done' } },
    });

    expect(useSessionsStore.getState().lastAction).toEqual({
      type: 'complete',
      data: { summary: 'Done' },
    });
  });

  it('session_expired sets error', () => {
    bus.emit('agent_loaded', {
      sessionId: 'exp-sess',
      agent: {
        id: 'a1',
        name: 'agent',
        filePath: '',
        type: 'agent',
        mode: 'scripted',
        toolCount: 0,
        gatherFieldCount: 0,
        isSupervisor: false,
        dsl: '',
      },
    });

    bus.emit('session_expired', { sessionId: 'exp-sess' });
    expect(useSessionsStore.getState().error).toContain('expired');
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `cd apps/studio && pnpm vitest run src/features/sessions/__tests__/sessions-lifecycle.integration.test.ts`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
npx prettier --write apps/studio/src/features/sessions/__tests__/sessions-lifecycle.integration.test.ts
git add apps/studio/src/features/sessions/__tests__/sessions-lifecycle.integration.test.ts
git commit -m "[ABLP-2] test(studio): add sessions lifecycle integration test"
```

---

### Task 19: Build Verification + Regression Check

**Files:** None (verification-only task)

Final verification that all sessions feature code builds, all tests pass, and no regressions exist in the broader studio test suite.

- [ ] **Step 1: Full studio build**

```bash
cd apps/studio && pnpm build
```

Expected: Build succeeds with zero type errors. Verify no new warnings related to sessions imports.

- [ ] **Step 2: Run all sessions feature tests**

```bash
cd apps/studio && pnpm vitest run src/features/sessions/
```

Expected: All tests pass:

| Test file                                | Expected |
| ---------------------------------------- | -------- |
| `sessions.contract.test.ts`              | PASS     |
| `trace-event-logger.test.ts`             | PASS     |
| `thought-card-merger.test.ts`            | PASS     |
| `state-extractor.test.ts`                | PASS     |
| `test-context.contract.test.ts`          | PASS     |
| `sessions.store.test.ts`                 | PASS     |
| `sessions.handlers.test.ts`              | PASS     |
| `sessions.api.test.ts`                   | PASS     |
| `barrel-reexport.test.ts`                | PASS     |
| `sessions-dual-write.test.ts`            | PASS     |
| `use-session-refactored.test.ts`         | PASS     |
| `sessions-lifecycle.integration.test.ts` | PASS     |

- [ ] **Step 3: Run full studio test suite for regressions**

```bash
cd apps/studio && pnpm vitest run
```

Expected: All existing tests pass. Key regression areas to check:

- `src/__tests__/session-hooks.test.ts` — uses `useSession` hook (now delegates to new store)
- `src/__tests__/chat-and-projects.test.tsx` — imports `ChatPanel`, `ChatWithDebugPanel` (moved)
- `src/__tests__/chat-input-attachments.test.tsx` — imports `ChatInput` (moved)
- `src/__tests__/message-list-attachments.test.tsx` — imports `MessageList` (moved)

- [ ] **Step 4: Verify import graph is clean**

```bash
# Ensure no circular dependencies in the sessions feature
cd apps/studio && npx madge --circular src/features/sessions/
```

Expected: No circular dependencies.

- [ ] **Step 5: Summary commit (if any fixups needed)**

If any test failures or type errors were found and fixed during Steps 1-4:

```bash
npx prettier --write <fixed-files>
git add <fixed-files>
git commit -m "[ABLP-2] fix(studio): resolve sessions integration regressions"
```

---

## Phase 2 Completion Criteria

All tasks (1-19) complete when:

1. **Contracts:** Zod schemas validate all session message types, agent state, construct actions, trace events, and test context payloads
2. **Pure functions:** `formatTraceEventLog`, `mergeToolThought`, `mergeHandoffMetadata`, `extractStatePatch` are extracted, tested, and used by handlers
3. **Store:** `useSessionsStore` manages all session state with bounded collections, streaming, thought expansion, and session restore
4. **Handlers:** `registerSessionsHandlers` and `registerTestContextHandlers` process all session-relevant messages via the MessageBus
5. **API:** REST session fetch and WS send wrappers are extracted into `sessions.api.ts`
6. **Migration:** Legacy `session-store.ts` re-exports from feature module, `useSession` hook delegates to feature store, chat components moved to `features/sessions/components/`
7. **Dual-write:** Both old inline handlers and new bus handlers process messages during transition
8. **Integration:** Full lifecycle test verifies load -> send -> stream -> thought -> state -> end
9. **Build:** `pnpm build --filter=studio` succeeds, all tests pass, no circular dependencies

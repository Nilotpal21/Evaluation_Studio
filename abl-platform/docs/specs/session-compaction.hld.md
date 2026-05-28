# Session Compaction -- High-Level Design

**Feature**: Session Compaction
**Status**: ALPHA
**Feature Spec**: `docs/features/session-compaction.md`
**Test Spec**: `docs/testing/session-compaction.md`
**Last Updated**: 2026-03-22

---

## 1. Problem Statement

Long-running agent conversations accumulate messages that eventually exceed the LLM's context window, causing failures or degraded response quality. The ABL runtime had 5 compaction behaviors hardcoded with magic numbers and domain-specific field lists baked into engine code, making compaction opaque and non-configurable. The system needs automatic, transparent context management that (1) compacts older conversation history into summaries, and (2) provides a configurable policy system for controlling compaction strategies at platform, project, and agent levels.

---

## 2. Alternatives Considered

### Alternative A: Fixed Sliding Window (Current Baseline)

**Description**: Keep the existing `DEFAULT_CONVERSATION_WINDOW = 40` message limit. When messages exceed the window, drop the oldest messages (preserving the first system message).

**Pros**:

- Zero complexity -- already implemented
- Deterministic behavior
- No LLM call overhead

**Cons**:

- Information loss -- older context is permanently dropped, not summarized
- Fixed window size doesn't adapt to model context window
- Users must repeat themselves when context is dropped
- No configurability per agent or project

**Effort**: N/A (status quo)

### Alternative B: LLM-Powered Compaction with Configurable Policy (Selected)

**Description**: Automatically summarize older conversation history when token usage approaches the model's context window limit. Use a 3-level configurable `CompactionPolicy` (platform -> project -> agent) to control strategies. Provide both LLM abstractive and extractive fallback summarization.

**Pros**:

- Preserves key information through intelligent summarization
- Adapts to model context window via registry lookup
- Configurable at 3 levels with right-side-wins semantics
- Graceful degradation (extractive fallback when LLM unavailable)
- Removes domain-specific hardcoding from engine code

**Cons**:

- Adds one LLM call per compaction event (latency cost amortized over many turns)
- Summary quality depends on LLM capabilities
- Token estimation is approximate (character heuristic, not real tokenizer)

**Effort**: M (core engine exists; policy resolver implemented; integration wired)

### Alternative C: Real Tokenizer with Tiktoken

**Description**: Use tiktoken or equivalent for exact token counting instead of the character heuristic.

**Pros**:

- Exact token counts per model
- Accurate threshold triggering

**Cons**:

- Adds a dependency (tiktoken WASM/native module)
- Per-model tokenizer loading adds latency
- Marginal accuracy gain vs. character heuristic for threshold-based decisions
- Complex to maintain across model updates

**Effort**: S (isolated change to `estimateTokens()`)

### Recommendation

**Alternative B** is selected as the primary approach. The character-based heuristic (Alternative A/C tradeoff) is sufficient for threshold decisions where approximate accuracy is acceptable. Alternative C can be adopted later if under-estimation for specific languages becomes a production issue.

---

## 3. Architecture

### System Context Diagram

```
                                    ABL Platform
    ┌─────────────────────────────────────────────────────────────────┐
    │                                                                 │
    │  ┌──────────────┐    ┌────────────────┐    ┌──────────────────┐│
    │  │   Channels    │    │  Runtime Server │    │  Session Store   ││
    │  │ (WS, SDK,    │───>│                │───>│ (Redis/Memory)   ││
    │  │  Twilio, A2A) │    │  ┌────────────┐│    └──────────────────┘│
    │  └──────────────┘    │  │ Reasoning   ││    ┌──────────────────┐│
    │                      │  │ Executor    ││───>│  Cold Storage     ││
    │  ┌──────────────┐    │  │     │       ││    │  (MongoDB)       ││
    │  │  Model Hub   │<───│  │     v       ││    └──────────────────┘│
    │  │ (Registry)   │    │  │ Compaction  ││                        │
    │  └──────────────┘    │  │ Engine      ││    ┌──────────────────┐│
    │                      │  │     │       ││    │  LLM Provider    ││
    │  ┌──────────────┐    │  │     v       ││───>│  (OpenAI, etc.)  ││
    │  │  Compiler    │    │  │ Compaction  ││    └──────────────────┘│
    │  │ (IR Schema)  │    │  │ Policy      ││                        │
    │  └──────────────┘    │  └────────────┘│                        │
    │                      └────────────────┘                        │
    └─────────────────────────────────────────────────────────────────┘
```

### Component Diagram

```
┌───────────────────────────────────────────────────────────────┐
│                    Runtime Server (apps/runtime)              │
│                                                               │
│  ┌─────────────────────┐     ┌──────────────────────────────┐│
│  │  Reasoning Executor  │     │  Session Service              ││
│  │  (reasoning-         │     │  (session-service.ts)         ││
│  │   executor.ts)       │     │                               ││
│  │                      │     │  ┌──────────────────────────┐││
│  │  ┌────────────────┐  │     │  │  Session Store Interface │││
│  │  │ Pre-LLM Check  │──│────>│  │  (Redis / Memory)       │││
│  │  │ autoCompact()   │  │     │  └──────────────────────────┘││
│  │  └────────────────┘  │     │                               ││
│  │         │            │     │  ┌──────────────────────────┐││
│  │         v            │     │  │  Tiered Session Store    │││
│  │  ┌────────────────┐  │     │  │  (cold storage fallback) │││
│  │  │ Compaction     │  │     │  └──────────────────────────┘││
│  │  │ Engine         │  │     └──────────────────────────────┘│
│  │  │ (compaction-   │  │                                     │
│  │  │  engine.ts)    │  │     ┌──────────────────────────────┐│
│  │  └────────────────┘  │     │  Compaction Policy            ││
│  │         │            │     │  (compaction-policy.ts)       ││
│  │         v            │     │                               ││
│  │  ┌────────────────┐  │     │  Platform defaults            ││
│  │  │ LLM Client     │  │     │      ↓                        ││
│  │  │ (session's own) │  │     │  Project config (DB)          ││
│  │  └────────────────┘  │     │      ↓                        ││
│  └─────────────────────┘     │  Agent IR (compile-time)      ││
│                               │      ↓                        ││
│  ┌─────────────────────┐     │  Tool essential_fields         ││
│  │  Tool-Result         │     └──────────────────────────────┘│
│  │  Compressor          │                                     │
│  │  (tool-result-       │     ┌──────────────────────────────┐│
│  │   compressor.ts)     │────>│  Model Registry               ││
│  └─────────────────────┘     │  (model-capabilities.js)      ││
│                               │  Context window lookup        ││
│                               └──────────────────────────────┘│
└───────────────────────────────────────────────────────────────┘
```

### Data Flow

```
1. User sends message via channel (WebSocket/REST/SDK)
2. Message enters reasoning executor loop
3. Before each LLM call:
   a. CompactionEngine.autoCompact(session) is called
   b. Check if compactionEnabled (SessionConfig)
   c. Get active thread from session.threads[activeThreadIndex]
   d. Resolve context window size:
      - session.resolvedModelId → getModelRegistryEntry() → entry.contextWindow
      - OR thread.agentIR.execution.model → registry
      - OR session.agentIR.execution.model → registry
      - OR fallback: 128,000 tokens
   e. estimateTokens(conversationHistory):
      - For each message: count content chars + 10 role overhead
      - Divide total chars by 4 (CHARS_PER_TOKEN)
   f. Compare: currentTokens vs contextWindow * effectiveThreshold
      - effectiveThreshold = session.resolvedCompactionThreshold ?? config.autoCompactThreshold
   g. If under threshold: return null (no compaction)
   h. If over threshold: compactThread()
      - splitPoint = max(MIN_ACTIVE_WINDOW=10, floor(length/2))
      - toCompact = history[0 .. length-splitPoint]
      - toKeep = history[length-splitPoint .. end]
      - summary = generateSummary(toCompact, thread, session)
        - Try LLM: chatWithToolUse(summarization prompt, transcript)
        - Fallback: extractiveSummary(agent name, first/last msgs, gathered data)
      - Rebuild: [summarySystemMessage, ...toKeep]
      - Emit auto_compact trace event
4. LLM call proceeds with compacted conversation history
5. Session is saved (compacted history persists to store)
```

### Sequence Diagram (Auto-Compaction Flow)

```
ReasoningExecutor    CompactionEngine    ModelRegistry    LLMClient    SessionStore
       │                    │                 │              │              │
       │─autoCompact()─────>│                 │              │              │
       │                    │                 │              │              │
       │                    │─getModelRegistryEntry()──>│   │              │
       │                    │<──contextWindow──────────│    │              │
       │                    │                 │              │              │
       │                    │─estimateTokens()│              │              │
       │                    │ (internal)      │              │              │
       │                    │                 │              │              │
       │                    │ [tokens > threshold?]          │              │
       │                    │                 │              │              │
       │                    │─splitHistory()  │              │              │
       │                    │                 │              │              │
       │                    │─generateSummary()─────────────>│              │
       │                    │<──summary text──────────────────│              │
       │                    │                 │              │              │
       │                    │─rebuildHistory() │              │              │
       │                    │                 │              │              │
       │                    │─emitTraceEvent()│              │              │
       │                    │                 │              │              │
       │<─CompactionResult──│                 │              │              │
       │                    │                 │              │              │
       │ [proceed with LLM call]              │              │              │
       │                    │                 │              │              │
       │ [after response]   │                 │              │──save()─────>│
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

#### 1. Tenant Isolation

Compaction operates entirely within session scope. The summarization LLM call uses `thread.llmClient || session.llmClient`, which is tenant-specific (wired with tenant's credentials during session creation in `llm-wiring.ts`). No cross-tenant data access occurs during compaction. The `_projectRuntimeConfig` on the session is already loaded with tenant-scoped data via `requireProjectPermission()`.

**Evidence**: `compaction-engine.ts` line 259: `const llmClient = thread.llmClient || session.llmClient;` -- session-scoped, not global.

#### 2. Data Access Pattern

- **No repository layer**: Compaction operates on in-memory `thread.conversationHistory` arrays. No direct DB access.
- **Caching**: `session._compactionPolicy` is lazily resolved and cached per session (compaction-policy.ts line 60). Model registry entries are cached in the compiler package.
- **Persistence**: Compacted history is saved via the existing `SessionStore.save()` / `TieredSessionStore.persistToCold()` path. No separate persistence mechanism.

#### 3. API Contract

No external API. Compaction is an internal runtime optimization triggered before each LLM call. The only external configuration surfaces are:

- Environment variables (`SESSION_COMPACTION_ENABLED`, etc.)
- DSL `EXECUTION.compaction` block (compiled into AgentIR)
- Project-level `ProjectRuntimeConfig.compaction` in MongoDB

Compaction results are communicated via:

- `auto_compact` trace events
- INFO/WARN log entries
- Modified `conversationHistory` on the session (transparent to callers)

#### 4. Security Surface

- **Auth**: Uses session's own credentials for LLM calls. No separate auth flow.
- **Input validation**: `autoCompactThreshold` validated via Zod in config (`z.coerce.number().min(0).max(1)`).
- **PII**: Compaction summaries may contain PII from original messages. If PII redaction is enabled, compaction processes already-redacted content (compaction runs after input redaction in the pipeline).
- **SSRF**: No external HTTP calls beyond the session's configured LLM endpoint (already validated in LLM wiring).
- **Encryption**: Session data (including compacted history) is encrypted at rest when `EncryptionService` is available (wired in `ensureSessionService()`).

### Behavioral Concerns

#### 5. Error Model

| What Fails              | How                                                | User Experience                    | Recovery                                     |
| ----------------------- | -------------------------------------------------- | ---------------------------------- | -------------------------------------------- |
| LLM summarization fails | Exception caught, falls back to extractive summary | None -- transparent fallback       | Automatic (extractive fallback)              |
| Model registry miss     | Returns DEFAULT_CONTEXT_WINDOW (128K)              | None -- conservative threshold     | Automatic (safe default)                     |
| Config not loaded       | Uses DEFAULT_SESSION_CONFIG values                 | None -- safe defaults              | Automatic                                    |
| Token estimation error  | Would propagate as unhandled error                 | Reasoning loop catches at line 579 | Logged as WARN, continues without compaction |

#### 6. Failure Modes

- **LLM timeout**: Caught by the try/catch in `generateSummary()` (line 275). Falls back to extractive summary. Logged at WARN.
- **Session version conflict**: Compaction modifies in-memory state. Save is handled by the reasoning executor's normal session save path with optimistic concurrency checks.
- **Redis unavailable**: Session store falls back to MemorySessionStore. Compacted history stays in memory. No additional failure mode introduced by compaction.
- **Blast radius**: Compaction failure does NOT prevent the LLM call from proceeding. The reasoning executor catches the error (line 579) and continues without compaction.

#### 7. Idempotency

Compaction is idempotent in the sense that running it twice on the same state produces the same result (re-summarizes the same messages). However, because compaction modifies history in-place, repeated compaction on an already-compacted session will summarize the summary. This is mitigated by the threshold check -- after compaction, token usage drops below the threshold, so the next call skips compaction.

The execution lock (`SessionService.acquireLock()`) prevents concurrent compaction on the same session from different pods.

#### 8. Observability

- **Trace events**: `auto_compact` event with `threadIndex`, `agentName`, `messagesCompacted`, `tokensBefore`, `tokensAfter`, `summaryLength` (emitted via `onTraceEvent` callback in compaction-engine.ts lines 210-222).
- **Structured logs**:
  - INFO: Compaction trigger (`sessionId`, `threadIndex`, `agentName`, `currentTokens`, `threshold`, `contextWindow`)
  - INFO: Compaction completion (`sessionId`, `agentName`, `messagesCompacted`, `tokensBefore`, `tokensAfter`, `compressionRatio`)
  - WARN: LLM summarization failure (`error` message)
- **Debug in production**: Use `debug_analyze_session` MCP tool to inspect session state and compaction trace events.

### Operational Concerns

#### 9. Performance Budget

| Operation                         | Target Latency | Notes                                   |
| --------------------------------- | -------------- | --------------------------------------- |
| Token estimation (estimateTokens) | < 1ms          | O(n) string length, no I/O              |
| Policy resolution (first call)    | < 1ms          | Deep merge of 3 config objects          |
| Policy resolution (cached)        | < 0.01ms       | Direct object reference return          |
| Extractive summary generation     | < 5ms          | CPU-only string extraction              |
| LLM abstractive summary           | < 3s           | One LLM call; amortized over many turns |
| Compaction threshold check        | < 1ms          | Token estimate + comparison             |

**Payload sizes**: Compaction summary messages are 2-4 sentences (~200-400 chars). The summary replaces N messages (potentially thousands of chars), always reducing total payload.

#### 10. Migration Path

- **Current state**: Compaction engine and policy resolver exist and are wired into the reasoning executor. Compaction is disabled by default (`compactionEnabled: false`).
- **Target state**: Compaction enabled in production with validated threshold settings.
- **Transition**: Enable via `SESSION_COMPACTION_ENABLED=true` environment variable. No data migration needed -- compaction operates on in-memory state and produces standard conversation history messages.
- **Rollback**: Set `SESSION_COMPACTION_ENABLED=false`. In-progress sessions continue with their current history. No cleanup needed.

#### 11. Rollback Plan

1. Set `SESSION_COMPACTION_ENABLED=false` (env var or config)
2. Restart runtime pods (config is read at startup)
3. Existing sessions with compacted history continue to function (the `[Conversation Summary]` message is a valid system message)
4. New sessions proceed without compaction
5. No data cleanup or migration required

**Risk**: Sessions that were compacted cannot be "un-compacted" (original messages are gone). This is by design -- the summary replaces the original messages permanently within the session.

#### 12. Test Strategy

| Level       | Coverage Target | What Gets Tested                                                                                                                                             |
| ----------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit        | 90%+            | Token estimation, threshold logic, history splitting, summary generation (both paths), policy merge, essential_fields, compressor strategies                 |
| Integration | 70%+            | CompactionEngine within reasoning executor flow, policy resolution with real session structure, compressor with policy, session store persistence round-trip |
| E2E         | 50%+            | Long conversation auto-compaction via WebSocket, disabled-by-default behavior, per-agent threshold override, conversation coherence after compaction         |

**Current state**: Unit coverage is strong (~22 tests across 4 files). Integration and E2E are at 0% -- these are the primary gaps documented in the test spec.

---

## 5. Data Model

### In-Memory (per session)

**CompactionResult** (returned by `compactThread()`):

```typescript
interface CompactionResult {
  compacted: boolean;
  threadIndex: number;
  messagesCompacted: number;
  tokensBefore: number;
  tokensAfter: number;
  summary?: string;
}
```

**CompactionPolicy** (from `@abl/compiler/platform/ir/schema.ts`):

```typescript
interface CompactionPolicy {
  model?: string;
  tool_results: ToolResultCompactionConfig;
  prior_turns: PriorTurnCompactionConfig;
}

interface ToolResultCompactionConfig {
  strategy: 'none' | 'truncate' | 'structured' | 'summarize';
  max_chars: number; // default 102_400
  structured_threshold: number; // default 10_000
  keep_recent: number; // default 2
  essential_fields?: Record<string, string[]>;
  max_description_length?: number; // default 200
  summarize_prompt?: string;
}

interface PriorTurnCompactionConfig {
  strategy: 'none' | 'placeholder' | 'compact' | 'summarize';
  assistant_preview_chars: number; // default 200
}
```

**SessionConfig** (compaction-related fields):

```typescript
interface SessionConfig {
  compactionEnabled: boolean; // default false
  autoCompactThreshold: number; // default 0.8
  compactionModel: string; // default 'gpt-4o-mini'
}
```

### Persistence

Compaction operates entirely in-memory on `thread.conversationHistory`. The compacted history is persisted when the session itself is saved via the standard `SessionStore.save()` path. No separate compaction-specific collection or table exists.

- **Redis TTL**: `sessionTtlMinutes` (default 1440 / 24h)
- **MongoDB cold storage TTL**: `coldTtlDays` (default 90)

### Modified Types

**RuntimeSession** (non-serialized cached fields):

```typescript
interface RuntimeSession {
  _compactionPolicy?: CompactionPolicy; // lazy cache
  resolvedCompactionThreshold?: number; // from model resolution
  resolvedModelId?: string; // for context window lookup
}
```

---

## 6. API Design

### No New External API

Compaction has no user-facing API endpoints. It is triggered internally by the reasoning executor before each LLM call. The external configuration surfaces are:

| Surface                           | Type      | Details                                     |
| --------------------------------- | --------- | ------------------------------------------- |
| `SESSION_COMPACTION_ENABLED`      | Env var   | Master toggle (boolean)                     |
| `SESSION_AUTO_COMPACT_THRESHOLD`  | Env var   | Threshold ratio (0-1)                       |
| `SESSION_COMPACTION_MODEL`        | Env var   | Summarization model (string, not yet wired) |
| `EXECUTION.compaction`            | DSL block | Per-agent compaction config                 |
| `ProjectRuntimeConfig.compaction` | MongoDB   | Per-project compaction config               |

### Internal API (CompactionEngine)

```typescript
class CompactionEngine {
  constructor(config?: Partial<SessionConfig>);
  autoCompact(session: RuntimeSession, onTraceEvent?): Promise<CompactionResult | null>;
  compactThread(
    session: RuntimeSession,
    threadIndex: number,
    onTraceEvent?,
  ): Promise<CompactionResult>;
}
```

### Internal API (CompactionPolicy)

```typescript
function resolveCompactionPolicy(session): CompactionPolicy;
const DEFAULT_COMPACTION_POLICY: CompactionPolicy;
```

### Internal API (ToolResultCompressor)

```typescript
function compressToolResult(
  serialized: string,
  toolName?: string,
  policy?: CompactionPolicy,
): string;
function summarizeToolResult(
  serialized: string,
  toolName: string,
  llmFn: SummarizeLLMFn,
  customPrompt?: string,
): Promise<string | null>;
```

---

## 7. Cross-Cutting Concerns

### Audit Logging

No dedicated audit logging for compaction events. The `auto_compact` trace event serves as the audit record. If full audit logging is required (compliance), the trace event can be forwarded to the audit store via the existing trace pipeline.

### Rate Limiting

No rate limiting on compaction itself. Compaction is bounded by the reasoning executor loop (one per LLM call iteration). The LLM summarization call is subject to the existing LLM rate limiting on the session's endpoint.

### Caching

| Cache                       | Type                      | TTL                  | Max Size                         |
| --------------------------- | ------------------------- | -------------------- | -------------------------------- |
| `session._compactionPolicy` | In-memory (per session)   | Session lifetime     | 1 entry per session              |
| Model registry entries      | In-memory (module-level)  | Process lifetime     | ~100 entries (all known models)  |
| `irL1Cache`                 | In-memory (pod-local LRU) | No TTL, LRU eviction | `irCacheMaxEntries` (default 50) |

### Encryption

Compacted history is encrypted at rest when the session store has encryption enabled (wired via `EncryptionService` in `RedisSessionStore`). The `[Conversation Summary]` message is a standard conversation history entry and inherits all encryption protections.

---

## 8. Dependencies

### Upstream (This Feature Depends On)

| Dependency                                                     | Risk   | Notes                                                                    |
| -------------------------------------------------------------- | ------ | ------------------------------------------------------------------------ |
| Model Registry (`getModelRegistryEntry()`)                     | Low    | Stable, well-tested. Fallback to 128K if miss.                           |
| Session LLM Client (`thread.llmClient \|\| session.llmClient`) | Medium | LLM availability affects summary quality. Extractive fallback mitigates. |
| RuntimeSession structure                                       | Low    | Core type, stable.                                                       |
| SessionConfig / Config module                                  | Low    | Standard config loading.                                                 |
| `@abl/compiler` IR schema types                                | Low    | CompactionPolicy types are defined and stable.                           |

### Downstream (Depends On This Feature)

| Dependent                       | Impact | Notes                                                                     |
| ------------------------------- | ------ | ------------------------------------------------------------------------- |
| Reasoning Executor              | High   | Calls `autoCompact()` before each LLM call. Failure handling at line 579. |
| Tool-Result Compressor          | Medium | Reads CompactionPolicy for compression strategy.                          |
| Session persistence (save flow) | Low    | Compacted history is saved via normal save path. No special handling.     |
| Trace system                    | Low    | Receives `auto_compact` events.                                           |

---

## 9. Open Questions & Decisions Needed

1. **Dedicated compaction model**: Should `compactionModel` be wired to create a separate LLM client? (Currently uses session's primary LLM -- the TODO at line 257 has been open since initial implementation.)
2. **Observatory integration**: Should compaction events be surfaced in the Observatory session detail panel?
3. **Token estimation for CJK**: Should the `CHARS_PER_TOKEN` constant be model-dependent or language-dependent?
4. **Compaction history archival**: Should original messages be archived before being replaced by the summary?
5. **Multi-compaction**: If a session triggers compaction multiple times, should previous summaries be merged into a single summary?

---

## 10. References

- Feature spec: `docs/features/session-compaction.md`
- Test spec: `docs/testing/session-compaction.md`
- Compaction strategies design: `docs/plans/2026-03-09-compaction-strategies-design.md`
- Compaction strategies plan: `docs/plans/2026-03-09-compaction-strategies-plan.md`
- IR schema: `packages/compiler/src/platform/ir/schema.ts` (lines 344-432)
- Session types: `apps/runtime/src/services/session/types.ts`
- Compaction engine: `apps/runtime/src/services/session/compaction-engine.ts`
- Compaction policy: `apps/runtime/src/services/execution/compaction-policy.ts`
- Tool-result compressor: `apps/runtime/src/services/execution/tool-result-compressor.ts`

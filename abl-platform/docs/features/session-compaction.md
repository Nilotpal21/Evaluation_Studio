# Feature: Session Compaction

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: ALPHA
**Feature Area(s)**: `agent lifecycle`, `customer experience`, `governance`
**Package(s)**: `apps/runtime`, `packages/compiler`
**Owner(s)**: `Platform team`
**Testing Guide**: `../testing/session-compaction.md`
**Last Updated**: 2026-03-22

---

## 1. Introduction / Overview

### Problem Statement

Long-running agent conversations accumulate messages that eventually exceed the LLM's context window. When this happens, the LLM either receives truncated input (losing critical conversation state), returns errors due to exceeding token limits, or produces degraded responses because key context is outside the window. Without automatic management, operators must set low conversation window limits (currently hardcoded at 40 messages in `DEFAULT_CONVERSATION_WINDOW`), which sacrifices conversation continuity and forces users to repeat themselves.

Additionally, tool results (which can be large JSON payloads from search, CRM, or connector tools) consume a disproportionate share of the context window. The runtime had 5 compaction behaviors hardcoded across `reasoning-executor.ts` and `tool-result-compressor.ts` with magic numbers (`MAX_TOOL_RESULT_CHARS = 102_400`, `KEEP_RECENT_TOOL_RESULTS = 2`, etc.) and domain-specific field lists (`ESSENTIAL_PRODUCT_FIELDS`, `ESSENTIAL_OFFER_FIELDS`) baked into engine code, making compaction opaque and non-configurable.

### Goal Statement

Provide a two-layer compaction system that (1) automatically summarizes older conversation history when context usage approaches the model's limit, and (2) offers a configurable `CompactionPolicy` that allows platform operators, project-level config, and agent DSL authors to control compaction strategies for both tool results and prior turns. The system should be transparent to end users, configurable at three levels, and degrade gracefully when LLM summarization is unavailable.

### Summary

Session Compaction consists of two components:

1. **CompactionEngine** (`apps/runtime/src/services/session/compaction-engine.ts`): Monitors context usage per thread and triggers automatic summarization when estimated token count exceeds a configurable threshold (default 80% of context window). It splits history into a compact portion and an active window (minimum 10 messages), generates a `[Conversation Summary]` system message via LLM abstractive summarization or extractive fallback, and emits `auto_compact` trace events.

2. **CompactionPolicy** (`apps/runtime/src/services/execution/compaction-policy.ts`): A 3-level configuration resolver that merges platform defaults, project config (from MongoDB `ProjectRuntimeConfig`), and agent IR compile-time settings. Tool-level `essential_fields` annotations declared in `ToolDefinition.compaction` are collected into the policy. The policy governs both tool-result compression (via `tool-result-compressor.ts`) and prior-turn truncation (via `reasoning-executor.ts`).

---

## 2. Scope

### Goals

- Automatically compact conversation history before each LLM call when context usage exceeds the configured threshold (default 80% of context window)
- Preserve recent messages in an active window (minimum `MIN_ACTIVE_WINDOW = 10` messages)
- Generate concise summaries of compacted messages using the session's LLM client with a focused summarization prompt
- Provide an extractive fallback summary when the LLM is unavailable (agent name, first/last user messages, gathered data, message count)
- Support 3-level policy resolution: platform defaults -> project config (DB) -> agent IR (compile-time), with right-side-wins per leaf field
- Collect tool-level `essential_fields` annotations from `ToolDefinition.compaction` entries into the resolved policy
- Emit `auto_compact` trace events with token counts, compression ratio, and summary length
- Replace all hardcoded compaction magic numbers with configurable `CompactionPolicy` fields
- Support 4 tool-result strategies: `none`, `truncate`, `structured`, `summarize`
- Support 4 prior-turn strategies: `none`, `placeholder`, `compact`, `summarize`

### Non-Goals (Out of Scope)

- Dedicated compaction model wiring (the `compactionModel` field exists in `SessionConfig` and `CompactionPolicy.model` but is not wired to a separate LLM client; summarization reuses the session's primary LLM client)
- User-visible compaction notifications or UI indicators in Studio
- Cross-session compaction or history archival beyond existing session TTL/cold storage
- Real tokenizer integration (e.g., tiktoken) -- uses character-based heuristic
- Compaction analytics dashboards in Observatory
- Internationalized token estimation for CJK or other non-Latin scripts

---

## 3. User Stories

1. As an **end user**, I want my long conversations to remain coherent without me having to repeat context, so that I can have natural multi-turn interactions that span many exchanges.
2. As a **platform operator**, I want automatic compaction so that conversations do not fail due to context window limits, and I can enable it via an environment variable (`SESSION_COMPACTION_ENABLED`).
3. As an **agent developer**, I want to control compaction thresholds and strategies per agent via DSL (`EXECUTION.compaction`), so that I can tune behavior for my specific use case (e.g., lower thresholds for smaller models, different strategies for data-heavy vs conversational agents).
4. As a **tool author**, I want to declare `essential_fields` on my tool definition so that when tool results are compacted, the most important data (IDs, prices, names) is preserved.
5. As a **project administrator**, I want to set project-level compaction defaults that apply to all agents in my project, overridable per agent.

---

## 4. Functional Requirements

1. **FR-1**: The system must estimate token usage for the active thread's conversation history using a character-based heuristic (`CHARS_PER_TOKEN = 4`, with 10 chars role overhead per message), implemented in `estimateTokens()` in `compaction-engine.ts`.
2. **FR-2**: The system must trigger auto-compaction when estimated tokens exceed `contextWindow * effectiveThreshold`, where `effectiveThreshold` resolves from `session.resolvedCompactionThreshold` (per-session override from model resolution) falling back to `SessionConfig.autoCompactThreshold` (default `0.8`).
3. **FR-3**: The system must resolve the model's context window size via `getModelRegistryEntry()` from `@abl/compiler/platform/llm/model-capabilities.js`, supporting prefix matching for versioned model IDs (e.g., `anthropic.claude-sonnet-4-20250514-v1:0`), falling back to `DEFAULT_CONTEXT_WINDOW = 128_000` tokens for unknown models.
4. **FR-4**: On compaction, the system must split history at `max(MIN_ACTIVE_WINDOW, floor(length/2))` from the end, summarize the older portion, and replace it with a single `[Conversation Summary]` system message prefixed by `COMPACTION_SUMMARY_PREFIX`.
5. **FR-5**: The active window must retain at least `MIN_ACTIVE_WINDOW = 10` messages after compaction; if the history has 10 or fewer messages, compaction is a no-op.
6. **FR-6**: The system must support LLM-based abstractive summarization using `thread.llmClient || session.llmClient` with a system prompt focused on key decisions, collected data, conversation state, and pending actions, producing 2-4 sentence summaries.
7. **FR-7**: If LLM summarization fails or no LLM client is available, the system must fall back to extractive summary containing: agent name, first user message (truncated to 200 chars), last user message (truncated to 200 chars), gathered data from `thread.data.values` (first 10 entries), and message count.
8. **FR-8**: CompactionPolicy must resolve via 3-level merge: `DEFAULT_COMPACTION_POLICY` -> `session._projectRuntimeConfig.compaction` -> `session.agentIR.execution.compaction`, with right-side-wins per leaf field via `deepMergeCompaction()`. The resolved policy must be lazily cached on `session._compactionPolicy`.
9. **FR-9**: Tool-level `essential_fields` annotations must be collected from `ToolDefinition.compaction.essential_fields` entries into `policy.tool_results.essential_fields` keyed by tool name during policy resolution.
10. **FR-10**: The system must emit an `auto_compact` trace event via the `onTraceEvent` callback with: `threadIndex`, `agentName`, `messagesCompacted`, `tokensBefore`, `tokensAfter`, `summaryLength`.
11. **FR-11**: The tool-result compressor (`compressToolResult()`) must support 4 strategies controlled by `policy.tool_results.strategy`: `none` (passthrough), `truncate` (char-cap only), `structured` (strip non-essential fields + truncate descriptions + char-cap), `summarize` (LLM-powered with `structured` fallback).
12. **FR-12**: The system must be disabled by default (`compactionEnabled: false`) and require explicit opt-in via the `SESSION_COMPACTION_ENABLED` environment variable or per-session config.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                |
| -------------------------- | ------------ | ------------------------------------------------------------------------------------ |
| Project lifecycle          | SECONDARY    | Project-level `compaction` key in `ProjectRuntimeConfig` model                       |
| Agent lifecycle            | PRIMARY      | Per-agent compaction threshold and strategy via `AgentIR.execution.compaction`       |
| Customer experience        | PRIMARY      | Prevents context window overflow failures; preserves conversation continuity         |
| Integrations / channels    | NONE         | Compaction is channel-agnostic; operates on internal conversation history            |
| Observability / tracing    | SECONDARY    | `auto_compact` trace events with token counts and compression ratio                  |
| Governance / controls      | SECONDARY    | 3-level policy control (platform -> project -> agent) with right-side-wins semantics |
| Enterprise / compliance    | SECONDARY    | Compaction summaries may contain PII; inherit session retention policies             |
| Admin / operator workflows | SECONDARY    | `SESSION_COMPACTION_ENABLED` env var toggle                                          |

### Related Feature Integration Matrix

| Related Feature      | Relationship Type | Why It Matters                                                       | Key Touchpoints                                                                 | Current State |
| -------------------- | ----------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------- |
| Model Hub            | depends on        | Context window lookup via model registry prefix matching             | `getModelRegistryEntry()` in `@abl/compiler/platform/llm/model-capabilities.js` | STABLE        |
| Session Management   | extends           | Compaction modifies thread conversation history within session state | `RuntimeSession.threads[].conversationHistory`, `SessionConfig`, `SessionStore` | STABLE        |
| Tool Results         | shares data with  | Tool-level `essential_fields` annotations feed into CompactionPolicy | `ToolDefinition.compaction` in IR schema, `compressToolResult()` in compressor  | STABLE        |
| Reasoning Executor   | configured by     | CompactionEngine called before each LLM call; policy drives behavior | `reasoning-executor.ts` lines 575-581, `resolveCompactionPolicy()` at line 827  | STABLE        |
| LLM Wiring           | depends on        | Resolved compaction threshold comes from model resolution chain      | `llm-wiring.ts` line 1015-1016, `session.resolvedCompactionThreshold`           | STABLE        |
| Tiered Session Store | extends           | Compacted history persists via normal session save (cold + hot)      | `TieredSessionStore.save()`, `persistToCold()`                                  | STABLE        |

---

## 6. Design Considerations (Optional)

No dedicated UI for Session Compaction. Compaction operates transparently within the runtime. Future work may expose compaction status (last compaction timestamp, compression ratio, summary preview) in the Observatory trace viewer's session detail panel.

---

## 7. Technical Considerations (Optional)

- **Token estimation heuristic**: Uses `CHARS_PER_TOKEN = 4` with 10-char role overhead. This is conservative for English but may under-estimate for CJK languages where a single character can represent a full token. A real tokenizer (tiktoken) would add a dependency and latency; the heuristic is O(n) on string length.
- **Summary prompt engineering**: The system prompt for LLM summarization focuses on "key decisions, collected data (names, dates, IDs), conversation state, and pending actions" and requests 2-4 sentences. This balances information density with compactness.
- **Lazy policy caching**: `resolveCompactionPolicy()` caches on `session._compactionPolicy` (a non-serialized field) to avoid repeated deep-merge computation per LLM call within the same session.
- **Resolved compaction threshold**: `session.resolvedCompactionThreshold` is set by `llm-wiring.ts` during model resolution, allowing per-agent/per-project threshold overrides from the DB without modifying the global config.
- **Content block handling**: `estimateTokens()` supports both `string` content and `ContentBlock[]` arrays (extracting `.text` from text blocks). Image blocks and other non-text blocks are not counted.
- **Compaction summary as system message**: The compacted summary uses role `system` with the `[Conversation Summary]` prefix, ensuring it appears before the active window messages and is treated as context by the LLM.

---

## 8. How to Consume

### Studio UI

N/A. Compaction is transparent and has no Studio UI.

### API (Runtime)

Compaction is triggered automatically before each LLM call within the reasoning executor. No user-facing REST or WebSocket API exists for compaction. The only external control surfaces are:

| Surface          | How                                                       |
| ---------------- | --------------------------------------------------------- |
| Environment var  | `SESSION_COMPACTION_ENABLED=true` enables auto-compaction |
| DSL              | `EXECUTION.compaction` block per agent                    |
| Project config   | `ProjectRuntimeConfig.compaction` in MongoDB              |
| Model resolution | Per-agent `compactionThreshold` in agent DB hyperParams   |

### API (Studio)

N/A. No Studio-side API routes for compaction.

### Admin Portal

N/A. No admin-facing compaction management. Operators control compaction via environment variables and project config.

### Channel / SDK / Voice / A2A / MCP Integration

Compaction is channel-agnostic. It operates on the internal `conversationHistory` array within `AgentThread` and is invisible to all channel integrations (WebSocket, SDK, Twilio, A2A, MCP).

---

## 9. Data Model

### In-Memory Session State

```text
CompactionResult (returned by compactThread):
  - compacted: boolean
  - threadIndex: number
  - messagesCompacted: number
  - tokensBefore: number
  - tokensAfter: number
  - summary?: string

CompactionPolicy (from @abl/compiler/platform/ir/schema.ts):
  - model?: string
  - tool_results: ToolResultCompactionConfig
    - strategy: 'none' | 'truncate' | 'structured' | 'summarize'
    - max_chars: number (default 102_400)
    - structured_threshold: number (default 10_000)
    - keep_recent: number (default 2)
    - essential_fields?: Record<string, string[]>
    - max_description_length?: number (default 200)
    - summarize_prompt?: string
  - prior_turns: PriorTurnCompactionConfig
    - strategy: 'none' | 'placeholder' | 'compact' | 'summarize'
    - assistant_preview_chars: number (default 200)

SessionConfig (compaction fields, from apps/runtime/src/services/session/types.ts):
  - compactionEnabled: boolean (default false)
  - autoCompactThreshold: number (default 0.8)
  - compactionModel: string (default 'gpt-4o-mini')

RuntimeSession cached fields (non-serialized):
  - _compactionPolicy?: CompactionPolicy (lazy cache)
  - resolvedCompactionThreshold?: number (from model resolution)
  - resolvedModelId?: string (for context window lookup)
```

### Persistence

Compaction operates in-memory on `thread.conversationHistory`. The compacted history is persisted when the session itself is saved via `SessionStore.save()` and/or `TieredSessionStore.persistToCold()`. No separate compaction-specific collection exists. Compaction summaries share the session's TTL (`sessionTtlMinutes` for Redis, `coldTtlDays` for MongoDB cold storage).

### Key Relationships

- `CompactionEngine` reads `RuntimeSession` and modifies `thread.conversationHistory` in place
- `CompactionPolicy` types defined in `packages/compiler/src/platform/ir/schema.ts`, resolved in `apps/runtime/src/services/execution/compaction-policy.ts`
- `SessionConfig` compaction fields populated from env vars via `apps/runtime/src/config/index.ts` (env mappings: `SESSION_COMPACTION_ENABLED`, `SESSION_AUTO_COMPACT_THRESHOLD`, `SESSION_COMPACTION_MODEL`)

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                            | Purpose                                                                                                                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/session/compaction-engine.ts`        | CompactionEngine class: `autoCompact()`, `compactThread()`, `generateSummary()`, `extractiveSummary()`, `estimateTokens()`, `getContextWindowSize()`          |
| `apps/runtime/src/services/execution/compaction-policy.ts`      | `resolveCompactionPolicy()`, `DEFAULT_COMPACTION_POLICY`, `deepMergeCompaction()`, merge functions for tool_results and prior_turns                           |
| `apps/runtime/src/services/execution/tool-result-compressor.ts` | `compressToolResult()`, `summarizeToolResult()`, structured field extraction, truncation strategies                                                           |
| `apps/runtime/src/services/session/types.ts`                    | `SessionConfig` interface with `compactionEnabled`, `autoCompactThreshold`, `compactionModel`                                                                 |
| `packages/compiler/src/platform/ir/schema.ts`                   | `CompactionPolicy`, `ToolResultCompactionConfig`, `PriorTurnCompactionConfig` type definitions; `compaction?` field on `ExecutionConfig` and `ToolDefinition` |

### Routes / Handlers

| File                                                        | Purpose                                                                                                                                              |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/execution/reasoning-executor.ts` | Integrates CompactionEngine (`autoCompact()` at line 575) and CompactionPolicy (`resolveCompactionPolicy()` at line 827); cross-turn tool truncation |

### Jobs / Workers / Background Processes

N/A. Compaction runs synchronously before each LLM call within the reasoning loop. No background jobs.

### Tests

| File                                                            | Type | Coverage Focus                                                                                                                                    |
| --------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/__tests__/compaction-engine.test.ts`          | unit | Auto-compact trigger logic, threshold checks, model registry, trace events, extractive fallback, per-session threshold override, min-window guard |
| `apps/runtime/src/__tests__/compaction-policy.test.ts`          | unit | Platform defaults, 3-level merge (agent over project over platform), tool essential_fields collection, lazy caching                               |
| `apps/runtime/src/__tests__/tool-result-compressor.test.ts`     | unit | Structured field extraction with essential_fields, truncation strategy, LLM summarization, max_chars enforcement                                  |
| `apps/runtime/src/__tests__/cross-turn-tool-truncation.test.ts` | unit | Prior-turn tool result truncation, current-turn preservation, assistant_preview_chars                                                             |

---

## 11. Configuration

### Environment Variables

| Variable                         | Default       | Description                                                    |
| -------------------------------- | ------------- | -------------------------------------------------------------- |
| `SESSION_COMPACTION_ENABLED`     | `false`       | Master toggle for auto-compaction                              |
| `SESSION_AUTO_COMPACT_THRESHOLD` | `0.8`         | Context usage ratio (0-1) that triggers compaction             |
| `SESSION_COMPACTION_MODEL`       | `gpt-4o-mini` | Model for compaction summaries (not yet wired to separate LLM) |

### Runtime Configuration (SessionConfig)

| Config Key             | Default       | Description                                                                 |
| ---------------------- | ------------- | --------------------------------------------------------------------------- |
| `compactionEnabled`    | `false`       | Master toggle (mapped from `SESSION_COMPACTION_ENABLED`)                    |
| `autoCompactThreshold` | `0.8`         | Context usage ratio (mapped from `SESSION_AUTO_COMPACT_THRESHOLD`)          |
| `compactionModel`      | `gpt-4o-mini` | Summarization model (mapped from `SESSION_COMPACTION_MODEL`; not yet wired) |

### Constants (Hardcoded)

| Constant                    | Value                      | Location               |
| --------------------------- | -------------------------- | ---------------------- |
| `DEFAULT_CONTEXT_WINDOW`    | `128_000`                  | `compaction-engine.ts` |
| `CHARS_PER_TOKEN`           | `4`                        | `compaction-engine.ts` |
| `MIN_ACTIVE_WINDOW`         | `10`                       | `compaction-engine.ts` |
| `COMPACTION_SUMMARY_ROLE`   | `system`                   | `compaction-engine.ts` |
| `COMPACTION_SUMMARY_PREFIX` | `[Conversation Summary]\n` | `compaction-engine.ts` |

### DSL / Agent IR / Schema

Agent-level compaction in DSL:

```yaml
AGENT ProductAdvisor:
  EXECUTION:
    compaction:
      model: 'gpt-4o-mini'
      tool_results:
        strategy: 'structured'
        max_chars: 50000
        structured_threshold: 8000
        keep_recent: 2
      prior_turns:
        strategy: 'compact'
        assistant_preview_chars: 300

  TOOLS:
    product_search:
      compaction:
        essential_fields: [id, title, brand, price, salePrice, color, size, description]
        max_description_length: 200
```

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation  | Compaction operates within session scope. LLM summarization uses the session's own credentials/model (tenant-scoped). No cross-tenant data access.            |
| Project isolation | CompactionPolicy resolved from project-level config scoped by `tenantId` + `projectId`. The `_projectRuntimeConfig` on the session is already project-scoped. |
| User isolation    | Session-scoped -- no cross-user or cross-session data access during compaction. Compacted history stays within the same session.                              |

### Security & Compliance

- Compaction summaries may contain PII from original messages. They inherit the same data retention policies as the session (Redis TTL + cold storage TTL).
- If PII redaction is enabled on the session (`piiRedactionConfig`), compaction summaries are generated from already-redacted content (compaction runs after input redaction in the pipeline).
- The summarization LLM call uses the session's own credentials, maintaining tenant isolation.
- No external services are contacted beyond the session's configured LLM endpoint.

### Performance & Scalability

- **Token estimation**: O(n) over message content character length. Fast enough for pre-LLM-call checks (sub-millisecond for typical conversation sizes).
- **LLM summarization**: Adds one additional LLM call per compaction event. This is amortized over many turns -- compaction is rare in short conversations and triggers only when approaching the context window limit.
- **Extractive fallback**: Instant (no I/O), purely CPU-based string extraction.
- **Policy resolution**: Cached per session via `_compactionPolicy` -- resolved once, reused for all subsequent LLM calls in the session.
- **Memory**: No additional memory structures beyond the rebuilt `conversationHistory` array. The summary message replaces many messages, reducing memory.

### Reliability & Failure Modes

- **LLM summarization failure**: Gracefully falls back to extractive summary. No user-visible error. Logged at WARN level.
- **Minimum window guard**: Compaction never drops the active window below 10 messages, preventing over-aggressive compaction.
- **Config unavailable**: If runtime config is not loaded, falls back to `DEFAULT_SESSION_CONFIG` values.
- **Model registry miss**: Unknown models fall back to 128K context window, which is conservative and unlikely to trigger premature compaction.
- **Version conflicts**: Compaction modifies the session in-memory. The session save path handles optimistic concurrency via version checks.

### Observability

- **Trace event**: `auto_compact` event includes `threadIndex`, `agentName`, `messagesCompacted`, `tokensBefore`, `tokensAfter`, `summaryLength`.
- **Log entries**: INFO level for compaction triggers (sessionId, threadIndex, agentName, currentTokens, threshold, contextWindow) and completions (sessionId, agentName, messagesCompacted, tokensBefore, tokensAfter, compressionRatio).
- **Log entries**: WARN level for LLM summarization failure (before fallback).

### Data Lifecycle

- Compacted history is persisted when the session itself is saved. No separate compaction-specific collection exists.
- Compaction summaries have the same TTL as the session: `sessionTtlMinutes` (default 1440 / 24h) for Redis, `coldTtlDays` (default 90) for MongoDB cold storage.
- No archival or export of compaction summaries is supported.
- Session deletion cascades normally -- compacted history is deleted with the session.

---

## 13. Delivery Plan / Work Breakdown

1. CompactionEngine core
   1.1 Token estimation heuristic (`estimateTokens()`)
   1.2 Context window resolution via model registry (`getContextWindowSize()`)
   1.3 Auto-compact trigger logic with threshold check
   1.4 History splitting (compact portion + active window with `MIN_ACTIVE_WINDOW` guard)
   1.5 LLM abstractive summarization via `chatWithToolUse()`
   1.6 Extractive fallback summarization
   1.7 Trace event emission via `onTraceEvent` callback
2. CompactionPolicy resolution
   2.1 `DEFAULT_COMPACTION_POLICY` constant with platform defaults
   2.2 `resolveCompactionPolicy()` with 3-level deep merge
   2.3 Tool-level `essential_fields` collection from `ToolDefinition.compaction`
   2.4 Lazy caching on `session._compactionPolicy`
3. Tool-result compressor integration
   3.1 `compressToolResult()` reads strategy from `CompactionPolicy`
   3.2 Essential fields resolved per-tool from policy
   3.3 LLM summarization fallback for `summarize` strategy
4. Reasoning executor integration
   4.1 `CompactionEngine.autoCompact()` called before each LLM call
   4.2 Cross-turn tool result truncation using policy settings
5. Configuration wiring
   5.1 Environment variable mappings in `config/index.ts`
   5.2 SessionConfig fields
   5.3 CompactionPolicy types in IR schema
6. Testing
   6.1 CompactionEngine unit tests
   6.2 CompactionPolicy unit tests
   6.3 Tool-result compressor unit tests
   6.4 Cross-turn truncation unit tests
   6.5 Integration tests (compaction within reasoning loop) -- NOT YET IMPLEMENTED
   6.6 E2E tests (long conversation auto-compaction) -- NOT YET IMPLEMENTED

---

## 14. Success Metrics

| Metric                                | Baseline | Target             | How Measured                                                                       |
| ------------------------------------- | -------- | ------------------ | ---------------------------------------------------------------------------------- |
| Context window overflow errors        | N/A      | 0                  | Trace events -- no `context_window_exceeded` errors in compaction-enabled sessions |
| Compaction compression ratio          | N/A      | > 50%              | `auto_compact` trace event: `tokensAfter / tokensBefore < 0.5`                     |
| Conversation continuity after compact | N/A      | No user complaints | User satisfaction surveys, support tickets                                         |
| Compaction trigger latency (LLM path) | N/A      | < 3s               | `auto_compact` trace event latency (LLM summary call duration)                     |
| Extractive fallback latency           | N/A      | < 10ms             | `auto_compact` trace event latency (no I/O path)                                   |

---

## 15. Open Questions

1. Should the `compactionModel` field be wired to create a separate cheap LLM client for summarization (e.g., `gpt-4o-mini`) instead of reusing the session's primary LLM? The TODO exists in code at `compaction-engine.ts` line 257.
2. Should compaction summaries be visible to operators via the Observatory session detail panel?
3. Should the extractive fallback include tool results (tool call/response pairs) or just user/assistant messages?
4. Should compaction history (before/after) be archived for debugging or compliance auditing?
5. Should `CHARS_PER_TOKEN` be configurable or model-dependent (e.g., 3 for CJK-heavy contexts)?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                              | Severity | Status                          |
| ------- | -------------------------------------------------------------------------------------------------------- | -------- | ------------------------------- |
| GAP-001 | Dedicated compaction model not wired (`compactionModel` field exists but summarization uses session LLM) | Medium   | Open                            |
| GAP-002 | Token estimation heuristic (4 chars/token) may under-estimate for CJK languages                          | Low      | Open                            |
| GAP-003 | Compaction summary quality depends on session LLM quality (no dedicated summarization model)             | Low      | Mitigated (extractive fallback) |
| GAP-004 | No integration test exercises compaction within the reasoning loop                                       | High     | Open                            |
| GAP-005 | No E2E test for transparent long-conversation auto-compaction                                            | High     | Open                            |
| GAP-006 | Tests only use string content, not `ContentBlock[]` array content                                        | Medium   | Open                            |
| GAP-007 | Compaction disabled by default -- requires explicit opt-in                                               | Low      | By design                       |
| GAP-008 | `estimateTokens()` does not count image blocks or other non-text ContentBlock types                      | Low      | Open                            |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                        | Coverage Type | Status     | Test File / Note                     |
| --- | ----------------------------------------------- | ------------- | ---------- | ------------------------------------ |
| 1   | Auto-compact skip when disabled                 | unit          | PASS       | `compaction-engine.test.ts`          |
| 2   | Auto-compact skip when under threshold          | unit          | PASS       | `compaction-engine.test.ts`          |
| 3   | Auto-compact triggers at threshold              | unit          | PASS       | `compaction-engine.test.ts`          |
| 4   | History split preserves active window           | unit          | PASS       | `compaction-engine.test.ts`          |
| 5   | Min-window guard (<=10 messages = no-op)        | unit          | PASS       | `compaction-engine.test.ts`          |
| 6   | Extractive fallback on LLM failure              | unit          | PASS       | `compaction-engine.test.ts`          |
| 7   | Trace event emission with token counts          | unit          | PASS       | `compaction-engine.test.ts`          |
| 8   | Per-session threshold override                  | unit          | PASS       | `compaction-engine.test.ts`          |
| 9   | 3-level policy merge (platform/project/agent)   | unit          | PASS       | `compaction-policy.test.ts`          |
| 10  | Tool essential_fields collection                | unit          | PASS       | `compaction-policy.test.ts`          |
| 11  | Policy lazy caching                             | unit          | PASS       | `compaction-policy.test.ts`          |
| 12  | Tool-result structured extraction               | unit          | PASS       | `tool-result-compressor.test.ts`     |
| 13  | Cross-turn tool truncation                      | unit          | PASS       | `cross-turn-tool-truncation.test.ts` |
| 14  | LLM abstractive summary path                    | unit          | NOT TESTED | No mock LLM client provided in tests |
| 15  | ContentBlock[] message content handling         | unit          | NOT TESTED | Tests only use string content        |
| 16  | Compaction within reasoning loop                | integration   | NOT TESTED | No integration test exists           |
| 17  | Long-conversation auto-compaction via WebSocket | e2e           | NOT TESTED | No E2E test exists                   |

### Testing Notes

Solid unit test coverage exists for the CompactionEngine trigger logic, threshold checks, extractive fallback, trace events, and CompactionPolicy resolution. Major gaps are integration testing (compaction within the actual reasoning loop) and E2E testing (real WebSocket session with compaction). The LLM abstractive summary path is also untested.

> Full testing details: `../testing/session-compaction.md`

---

## 18. References

- HLD: `docs/specs/session-compaction.hld.md`
- LLD: `docs/plans/2026-03-22-session-compaction-impl-plan.md`
- Compaction strategies design: `docs/plans/2026-03-09-compaction-strategies-design.md`
- Compaction strategies plan: `docs/plans/2026-03-09-compaction-strategies-plan.md`
- Assistant response compaction: `docs/plans/2026-03-09-assistant-response-compaction.md`
- IR schema types: `packages/compiler/src/platform/ir/schema.ts` (lines 344-432)

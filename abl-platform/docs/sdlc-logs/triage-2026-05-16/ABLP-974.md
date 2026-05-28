# ABLP-974 — A2A Functional Observations (7 Issues)

> **Review update — 2026-05-17 (GPT-5.5 high review)** · Verdict: **DISAGREE**
>
> - **Test fake server URL is wrong**: exposes `/.well-known/agent.json` but discovery defaults to `agent-card.json` (`packages/a2a/src/application/discover-agent.ts:16`). The test fails on discovery setup before reaching the issue 2/6 assertions (`packages/a2a/src/__tests__/a2a-turn-context.repro.test.ts:46,166`). Fix the URL (or serve both paths).
> - **Issue 2 taskId carryover test manually injects** the remote taskId instead of exercising routing storage (`a2a-turn-context.repro.test.ts:214`). Rewrite to assert that the routing-executor persists and re-sends the taskId from the previous turn.
> - **Drop "server-generated contextId" from Issue 1 scope.** It conflicts with the existing adapter contract that maps client-supplied contextId to a platform session (`packages/a2a/src/infrastructure/agent-executor-adapter.ts:484,501,529`). Accept the trade-off: "client owns correlation ID, server enforces tenant-scoped mapping with strict validation." Document the security boundary explicitly.
> - **Issue 4 (custom metadata) is bigger than the doc implies**: needs DSL surface + AST + IR + runtime propagation — `HandoffConfig` has no metadata field in AST today (`packages/core/src/types/agent-based.ts:1220`). Split into its own story.
> - Issues 2/6 (taskId carryover, contextId in traces) are correctly identified and reproducible after the discovery-URL fix; Issues 3, 5, 7 root causes are accurate.
>
> Full review: [`codex-review.md`](codex-review.md)

> **Takeover update — 2026-05-17**
>
> - Fixed the repro fake server to serve `/.well-known/agent-card.json` and
>   return a card URL matching the ephemeral test server.
> - Re-ran the repro. The remaining failures are now the intended product gaps:
>   missing `contextId` on outbound traces and URL leakage in discovery `taskId`.
> - The taskId carryover unit path now passes when the remote taskId is supplied
>   explicitly; the production routing persistence gap remains documented below.

## Issue Table

| #   | Issue                                                         | Root Cause (file:line)                                                                                                                                                                                                                                                         | Solution                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | contextId is client-generated — should be server-generated    | `apps/runtime/src/services/execution/routing-executor.ts:1970` — `contextId: session.id` is always sent; the inbound path at `packages/a2a/src/infrastructure/express-handlers.ts` accepts whatever contextId the client provides without server-side generation on first turn | Inbound: on first turn (no existing session for contextId), server generates contextId, maps it to session, returns it in response. Client echoes on subsequent turns. Outbound: already uses `session.id` which is correct.                                                                                                  |
| 2   | TaskId not carried forward across turns                       | `apps/runtime/src/services/execution/routing-executor.ts:1964` — `const taskId = \`task*${session.id}*${Date.now()}\``generates a fresh taskId every call; remote response`result.id`(the server-assigned taskId) is never extracted or stored on the`AgentThread`             | After sync/streaming response with `input-required` state, extract `result.id` from the remote Task response and store it on `remoteThread.data.values._a2aRemoteTaskId`. On next turn, if stored taskId exists and remote task is not in terminal state, include it in `sdkMessage.message.taskId`. Clear on terminal state. |
| 3   | TaskId leaked as URL in discovery trace                       | `packages/a2a/src/application/discover-agent.ts:53` — `const DISCOVERY_TASK_ID = \`discovery:${params.endpoint}\`` embeds the full endpoint URL into the trace taskId field                                                                                                    | Use a hash or opaque identifier: `const DISCOVERY_TASK_ID = \`discovery:${crypto.createHash('sha256').update(params.endpoint).digest('hex').slice(0, 12)}\``or simply`'discovery'`.                                                                                                                                           |
| 4   | No way to configure custom metadata for outbound A2A requests | `packages/core/src/types/agent-based.ts:1220-1231` — `HandoffConfig` interface has no `metadata` field; `routing-executor.ts:1978` only sends `{ context }` in `metadata`                                                                                                      | Add `metadata?: Record<string, unknown>` to `HandoffConfig`. In routing-executor, merge `handoffConfig.metadata` into `sdkMessage.metadata` alongside `context`. DSL: `METADATA: { key: value }` in HANDOFF block.                                                                                                            |
| 5   | Task state not included in traces                             | `apps/runtime/src/services/execution/routing-executor.ts:2120-2131` (and all `handoff_progress` emissions) — `data.phase` uses internal phases (`started`, `completed`, `failed`); the actual A2A task state from `result.status.state` is never included                      | Add `remoteTaskState: result.status.state` to every `handoff_progress` emission where a response is available. For `working` and `input-required`, emit an explicit `handoff_progress` event with `phase: 'working'` / `phase: 'input-required'`.                                                                             |
| 6   | contextId missing from all A2A traces                         | `apps/runtime/src/services/execution/routing-executor.ts:2063-2065` (and all other `handoff_progress`/`a2a_call` emissions); `packages/a2a/src/domain/ports.ts:11-20` — `A2ATracingPort.traceOutbound` interface has no `contextId` parameter                                  | Add `contextId?: string` to `A2ATracingPort.traceOutbound` params. Pass `session.id` (which IS the contextId for outbound) through tracing adapter. Add `contextId` to every `handoff_progress` and `a2a_call` trace emission.                                                                                                |
| 7   | Only A2A v0.3 JSON-RPC supported                              | `packages/a2a/src/infrastructure/client-factory.ts:14` — only `A2AClient` (JSON-RPC) from `@a2a-js/sdk` is instantiated; no HTTP transport or v1.0 support                                                                                                                     | Future: abstract client behind a `TransportAdapter` interface; detect protocol version from agent card `protocolVersion` field; add HTTP transport adapter. Low priority — v0.3 JSON-RPC covers current ecosystem.                                                                                                            |

## Reproduction Tests

**File:** `packages/a2a/src/__tests__/a2a-turn-context.repro.test.ts`

| Test                                                 | Covers Issues       |
| ---------------------------------------------------- | ------------------- |
| "taskId from response is echoed in subsequent turn"  | #2                  |
| "traceOutbound includes contextId"                   | #6                  |
| "discovery taskId does not contain endpoint URL"     | #3                  |
| "mode mismatch fast-fails (ASYNC:true + push:false)" | Cross-ref ABLP-1059 |

**Test deferred — symptom documented in audit doc:**

- Issue 1 (server-generated contextId) — requires inbound handler changes, covered by existing `session-resolver-integration.test.ts` once fix lands
- Issue 4 (custom metadata config) — requires DSL parser + IR schema change; type-level gap documented
- Issue 5 (task state in trace) — straightforward field addition; no architectural risk
- Issue 7 (protocol version support) — future work, no current ecosystem demand

## Future-Ready Solution: Session-Bound A2A Turn-Context

### Concept

Introduce a typed `A2ATurnContext` object stored per-thread that tracks the ongoing A2A conversation state:

```typescript
// On AgentThread or in thread.data.values
interface A2ATurnContext {
  /** contextId used for outbound A2A calls (= session.id for outbound) */
  contextId: string;
  /** Remote-agent-assigned taskId from latest response — null on first turn or after terminal */
  remoteTaskId: string | null;
  /** Last known remote task state */
  remoteTaskState:
    | 'submitted'
    | 'working'
    | 'input-required'
    | 'completed'
    | 'failed'
    | 'canceled'
    | null;
  /** Custom metadata to include in every outbound call to this agent */
  outboundMetadata?: Record<string, unknown>;
  /** Turn counter for this remote conversation */
  turnCount: number;
}
```

### How It Solves Each Issue

| Issue                          | How A2ATurnContext Solves It                                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 (contextId client-generated) | `contextId` is server-generated (= session.id) and stored in the context. Client receives it in response and echoes it — the context object is the source of truth.                              |
| 2 (taskId not carried)         | `remoteTaskId` is populated from `result.id` after first response. On next turn, if non-null and state is non-terminal, it's included in `sdkMessage.message.taskId`. Cleared on terminal state. |
| 4 (custom metadata)            | `outboundMetadata` is populated from `HandoffConfig.metadata` at handoff start. Merged into every `sdkMessage.metadata` call for this thread.                                                    |
| 6 (contextId in traces)        | `contextId` from the context object is passed to every tracing call — no separate plumbing needed, it's always available on the thread.                                                          |
| 3 (taskId URL leak)            | Trivially observable once proper taskId tracking exists — discovery calls get their own non-leaked identifier.                                                                                   |
| 5 (task state in trace)        | `remoteTaskState` is updated from every response and emitted in trace events — the context is the single source of truth for what the remote agent last reported.                                |

### Implementation Path

1. Add `a2aTurnContext?: A2ATurnContext` to `AgentThread` interface
2. Initialize on first remote handoff (`turnCount: 1, contextId: session.id, remoteTaskId: null`)
3. After each response: update `remoteTaskId` and `remoteTaskState` from `result.id` / `result.status.state`
4. On next turn: read `remoteTaskId` from context, include in `sdkMessage.message.taskId` if non-terminal
5. On terminal state: set `remoteTaskId = null`, increment `turnCount` (new task cycle)
6. Pass `contextId` from context into all tracing emissions
7. Merge `outboundMetadata` into `sdkMessage.metadata` on every call

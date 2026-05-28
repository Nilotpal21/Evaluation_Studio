---
name: code-standards
description: Use when writing, reviewing, or modifying code in this codebase. Covers error handling, logging, async patterns, state management, types, module design, LLM integration, security, testing conventions, and anti-patterns.
---

# Code Standards

## Error Handling

- Never write empty `.catch(() => {})`. Log or propagate every error.
- Every async function called from a sync context (event handlers, WebSocket `on('message')`) must have `.catch()`.
- Return `{ success: boolean, data?, error?: { code: string, message: string } }` on failure — not `{}` or fake success strings.
- Validate at system boundaries (user input, external APIs, WebSocket messages). Don't over-validate internal calls.
- When a loop or retry hits its limit, detect it explicitly — log, emit a trace event, and return a structured error. Never silently return empty.

## Logging

- **Server-side**: Always use `createLogger('module-name')` from `@abl/compiler/platform`. Never `console.log`, `console.warn`, or `console.error` in runtime or compiler packages.
- **Client-side (Studio)**: `console.error` / `console.warn` are acceptable in React components.
- **Call format**: `log.level('message string', { key: value })` — message first, structured context object second. Never pass raw error objects as the second argument.
- **Error extraction**: Always use `err instanceof Error ? err.message : String(err)` — never `(err as Error).message` (unsafe cast produces `undefined` for non-Error rejections).
- **Log levels**:
  - `log.error` — Operational failures that need attention (DB failures, stream errors, unrecoverable states)
  - `log.warn` — Degraded-but-functional paths (fallbacks, non-critical failures, config issues)
  - `log.info` — Significant lifecycle events (session created, client connected, agent loaded)
  - `log.debug` — Expected/benign failures (cost estimation unavailable, SSE chunk parse, config not loaded)
- **Catch blocks**: Every `catch` must capture the error parameter and log it. No bare `catch {}` or `catch { /* comment */ }`. Include relevant context (sessionId, tenantId, modelId) in the log metadata.

## Async

- Use `fs.promises` for all file I/O in server code. Never use `readFileSync`, `writeFileSync`, `existsSync`, `readdirSync`, `statSync` in request/WebSocket handlers.
- Use `promisify(crypto.pbkdf2)` — never `pbkdf2Sync`.
- Use `promisify(gzip)` / `promisify(gunzip)` — never `gzipSync` / `gunzipSync`.
- Sync I/O is allowed only in: `scripts/`, `__tests__/`, one-shot startup before server listens.
- An `async` method must be fully non-blocking. No sync I/O inside async functions.

## State

- One authoritative store per data concept. Compute derived views on demand — never maintain parallel copies synced with `Object.assign`.
- If a field is derivable from the IR or a parent-child chain, write a helper function — don't cache a copy on the session.
- Delete fields that are written but never read.

## Types

- TypeScript interfaces for all data contracts. No `any` where structured types exist.
- Parse at compile time, store as typed IR. Don't re-parse strings at runtime with regex.
- Map ABL types to proper JSON Schema (`ablTypeToJsonSchema`). Don't flatten everything to `type: 'string'`.
- Use discriminated unions with exhaustive `switch` for type-dependent control flow.

## No Magic Numbers

- No inline numeric literals for limits, timeouts, iteration caps, or token counts. Use named constants or read from config/IR.
- Iteration limits, `max_tokens`, retry counts, TTLs, and thresholds must be configurable — not buried in method bodies.

## Module Design

- Decompose methods over 100 lines.
- Use strategy/dispatch patterns — not sequential if/else chains checking every concern for every input.
- Iterative loops for step execution — not recursive self-calls. Use `while (hasNextStep && !waitingForInput)`.
- Keep extraction, intent detection, constraint checking, tool execution, and template rendering as independent callable operations.
- Routing concerns (handoff, delegate, escalate, complete) stay in the routing executor.
- **Extract pure functions out of service classes.** If a function has no `this`, no I/O, and no runtime dependencies — extract to a shared utils module. Re-export from the original location for backward compatibility.
- **Delete stubs when real implementations exist.** Placeholder adapter files returning `NOT_IMPLEMENTED` alongside working adapters are dead code.

## String Literals & Prompt Ownership

Never inline string literals for prompts or messages in engine code. Every string has an owner:

**Platform constants** (engine concerns): System tool descriptions, default extraction rules, supervisor behavior constraints, error codes. These belong in a platform constants/config module.

**Customer/agent-defined** (per agent, per project): Agent persona, goal, user-facing messages, routing hints, extraction prompts. These come from ABL DSL → IR → read at runtime. Fall back to platform defaults from constants module — never inline strings.

**Test rule**: if a string in engine code mentions a domain concept (agent name, tool name, business term), it doesn't belong there.

## Domain Agnosticism

- No domain-specific field names, routing examples, or success conditions in the engine.
- Tool success/failure: use the tool's return type, `success_when` in the step definition, or structured `{ success, data, error }` from the executor. Never check domain-specific field names like `.hotels`.
- No hardcoded synonym tables in entity extraction. Use per-field `GatherFieldIR.extraction_hints` if needed.
- Mock tool responses go in per-example files or a dev-only executor — not in engine source.

## Reuse

- Use the compiler's `LLMProvider` interface and provider factory — don't embed a hardcoded provider client.
- Use `ToolBindingExecutor` (HTTP, Lambda, Sandbox, MCP) — don't bypass with mock dictionaries.
- Use existing persistence stores (`PrismaConversationStore`, `PrismaMessageStore`, `MemoryCheckpointer`, `RedisCheckpointer`).
- If the same class exists in multiple places, consolidate to one behind the abstraction. Delete duplicates.
- If multiple implementations of the same concept exist, consolidate into one shared base with composable mixins.

## Caller Context

- Every session must carry caller identity: `customerId`, `anonymousId`, `tenantId`, `channel`, `initiatedById`.
- Caller context is set at session creation from the edge layer (WebSocket auth, SDK auth, REST auth) and stored on the session.
- Tool execution receives caller context — for user-scoped auth headers, audit logging, and tenant-scoped data access.
- Trace events include caller identity. No anonymous tool calls in production.

## Resources

- Every in-memory `Map` must have a max size, TTL, and eviction strategy.
- Store references (hashes, IDs) on sessions — don't embed full IR blobs per session.
- No append-only collections without cleanup.
- Validate payload size before compression/decompression.

## LLM Integration

- Provider-neutral types in all method signatures: `LLMToolDefinition`, `LLMToolCall`, `LLMToolResult`. No vendor-specific types.
- `max_tokens`, model, reasoning mode come from the agent IR via `CompletionOptions`. Never hardcode.
- Provider-specific format conversion is hidden inside the provider implementation.
- Accept `LLMProvider` via constructor injection.
- **Model resolution chain must be explicit.** DB-backed resolution (deployment override → project model → tenant default) with a clear error when no model is found. No silent fallback to env-var API keys in production — env-var fallbacks for local dev only.
- **LLM error propagation, not silent degradation.** When an LLM call fails, return a structured error — never fall back to stub/canned responses.

## Compiler Validation

- The compiler must validate structural correctness at compile time — don't defer to runtime. Invalid tool references, unreachable flow steps, and orphaned handoff targets should be caught during `compileABLtoIR()`.
- Use `validateToolReferences()` and `validateFlowGraph()`.
- Compilation errors should be structured as `ValidationDiagnostic` with severity (error/warning), location (agent, step, line), and actionable message.
- Handle partial compilation gracefully: compile what you can, collect errors for the rest, provide client-side fallbacks from raw DSL parsing for UI features.

## Deployment vs. Runtime

- Compilation happens at deploy time. Session creation is a lightweight lookup.
- Sessions store `agent_def_id` / `compilation_id` / `irSourceHash` — not full IR copies.
- No methods accepting raw DSL strings on the executor. Work with pre-compiled `AgentIR`.
- Agent registries scoped by deployment/project — no global flat namespace.

## Observability

- Trace events include: session ID, agent name, caller identity, timestamp, machine-readable event type.
- Tool calls traceable with: caller context, parameters, result, duration.
- Single canonical `TraceEvent` type across all packages.
- One shared `TraceStore` with pluggable backends — not multiple independent implementations.

## Executor Design

- `RuntimeExecutor` holds no sessions, registries, or LLM clients as instance state. External stores only.
- Each `processMessage` is self-contained: load → resolve → process → write back.

## Control Flow

- Branch on `agentIR.execution.mode`, not on whether `currentFlowStep` is set.
- Read config from IR (`execution.max_tokens`, `execution.mode`, `execution.reasoning`).
- Read routing rules from `agentIR.routing.rules` and `agentIR.coordination.handoffs` — not cached session copies.

## Security

- No secrets (API keys, tokens, connection strings) in source code. Use environment variables or `SecretsProvider`.
- SSRF protection on all outbound HTTP from tool execution — block private IP ranges and metadata endpoints.
- Validate and sanitize URLs before HTTP tool calls.
- Tool execution in isolated context — never in the same trust boundary as the engine's own state.
- **MongoDB `$regex` injection**: Never pass user input directly into `$regex` queries. Escape special characters with a helper or use `$text` search instead. _(Evidence: lld-reviewer caught this pattern in SearchAI routes)_
- **Upsert race conditions**: When using `findOneAndUpdate` with `upsert: true`, be aware of duplicate key errors under concurrency. Use `try/catch` with retry on `E11000` duplicate key. _(Evidence: lld-reviewer flagged this in connector sync patterns)_

## Testing

- Generate tests alongside new code. Place in `src/__tests__/`, named `*.test.ts`.
- Test error paths, not just happy paths. Every structured error result should have a test.
- Use Vitest with `globals: true`. Runtime tests use `pool: 'forks'`.
- Extract pure functions so they're testable without session setup.

## Anti-Patterns

| Don't                                              | Do                                                     |
| -------------------------------------------------- | ------------------------------------------------------ |
| `.catch(() => {})` or bare `catch {}`              | Log, trace, or propagate                               |
| `console.log/warn/error` in server code            | `createLogger('module')` from `@abl/compiler/platform` |
| `(err as Error).message`                           | `err instanceof Error ? err.message : String(err)`     |
| `log.warn('msg:', rawError)`                       | `log.warn('msg', { error: err.message })`              |
| `readFileSync` / `writeFileSync` in server         | `fs.promises`                                          |
| `pbkdf2Sync`                                       | `promisify(crypto.pbkdf2)` + LRU cache                 |
| `gzipSync` / `gunzipSync` in async                 | `promisify(gzip)` / `promisify(gunzip)`                |
| Return `{}` on failure                             | `{ success: false, error: { code, message } }`         |
| Silent loop/retry exhaustion                       | Log + trace event + structured error                   |
| `Object.assign` across N parallel maps             | Single `values` map + computed views                   |
| Inline prompt/message strings in engine            | Platform constants module or read from IR              |
| Domain field names in engine                       | `success_when` or per-agent config                     |
| Recursive step execution                           | `while` loop, break on user input                      |
| Raw DSL at runtime                                 | Pre-compiled `AgentIR` from deployment                 |
| Vendor types in signatures                         | `LLMToolDefinition`, `LLMToolCall`, `LLMToolResult`    |
| Unbounded `Map`                                    | Max size + TTL + eviction                              |
| Hardcoded `max_tokens` / model / limits            | Named constants or read from IR/config                 |
| `currentFlowStep !== undefined` for mode           | `agentIR.execution.mode === 'scripted'`                |
| Mock data in engine source                         | Per-example files or dev-only executor                 |
| Fire-and-forget async in constructors              | `await` or `.ready` promise                            |
| Fields written but never read                      | Delete                                                 |
| Reimplemented abstractions                         | Import the existing one                                |
| Secrets in source                                  | Environment variables or `SecretsProvider`             |
| Sessions without caller identity                   | Set `CallerContext` at creation from edge auth         |
| `findById(id)` + post-hoc tenant check             | `findOne({ _id: id, tenantId })` at query level        |
| `findByIdAndUpdate` / `findByIdAndDelete`          | `findOneAndUpdate({ _id, tenantId })` etc.             |
| SWR `{ onError: () => {} }` silencing errors       | Handle or display errors; never swallow silently       |
| Zustand store `reset()` without nav guard          | Add `useBlocker` if store holds unsaved drafts         |
| Bare string compilation errors                     | `ValidationDiagnostic` with severity + location        |
| Assuming IR compilation always succeeds            | Client-side DSL parsing as UI fallback                 |
| `requireWriteAccess()` for project resources       | `requireProjectPermission(req, res, 'obj:op')`         |
| `/api/sessions?projectId=` query param             | `/api/projects/:projectId/sessions` path scope         |
| Resource lookup by ID without project check        | `resource.projectId === req.params.projectId`          |
| Silent fallback to stub/canned LLM response        | Propagate errors as structured responses               |
| Keyword intent classification (`startsWith`)       | LLM self-selects via structured tool calls             |
| Implicit platform/demo config fallback             | Fail explicitly with actionable admin error            |
| Env-var API key fallback in production paths       | DB-backed resolution; env-vars for local dev only      |
| Pure functions embedded in service classes         | Extract to shared utils module                         |
| Stub adapters alongside real implementations       | Delete stubs once real adapters exist                  |
| Domain-specific extraction (`includes('checkin')`) | IR metadata: `GatherField.type`, `.extraction_hints`   |
| Flow child without `failParentOnFailure`           | Always set `failParentOnFailure: true` on every child  |
| `removeOnComplete` only on flow parent             | Set on **every** child individually (no cascade)       |
| `useWorkerThreads: true` in BullMQ                 | Use function reference or child process (mem leak)     |
| `FlowProducer.add()` without result validation     | Verify parent job exists after add (silent failures)   |

# Auth Profile Design — Runtime Integration Review

**Reviewer:** Claude Sonnet 4.6 (code review agent)
**Date:** 2026-03-11
**Documents reviewed:**

- `2026-03-11-auth-profile-design.md` (design)

**Method:** Traced the actual execution hot path from `LLMWiringService` through `RuntimeSecretsProvider`, `ToolOAuthService`, and `RoutingExecutor` in `apps/runtime/src/`. Findings are grounded in specific file + line references.

---

## Executive Summary

The design is architecturally sound at the data-model and API layers. The runtime integration layer — how Auth Profiles are actually consumed at execution time — has six significant gaps. Two are blocking (token refresh race condition, delegate/handoff tool executor not re-wired for child credentials), two are important (no cache specification, no retryability classification for auth errors), and two are gaps to address before implementation begins (streaming scenarios and cross-project handoff scoping).

---

## 1. Credential Resolution Hot Path

### 1.1 Current Path (codebase truth)

The live execution path is:

```
Session start
  → LLMWiringService._wireExecutor() [llm-wiring.ts:356]
      → new RuntimeSecretsProvider({ secretStore, decryptor, oauthResolver })
  → ToolBindingExecutor.execute(toolName, params)
      → secrets.getSecret(key) [secrets-provider.ts:133]
          1. In-memory Map<string,string> secretCache (no TTL, no max size)
          2. ToolSecret.findOne({ tenantId, projectId, secretKey, environment })
          3. Agent IR credentials config map
          4. process.env[key]
```

For LLM credentials the path is separate:

```
LLMWiringService.wireLLMClient()
  → ModelResolutionService.resolve()
      → in-memory metadataCache (5-min TTL, max 10K entries) [model-resolution.ts:257]
      → re-decrypt credential on every hit (never cached plaintext)
      → DB-backed: TenantModel + LLMCredential path
```

### 1.2 Design Integration Gap — No Specified Hook Point

**Finding:** Section 4 specifies `authProfileService.resolve()` as the runtime resolution function, but the design does not state where this function is called in `LLMWiringService`. Is it a new layer inside `RuntimeSecretsProvider.getSecret()`? Does it replace `ToolSecret.findOne()`? Does it add a new parallel lookup path?

Without specifying the hook point, implementation agents will make different choices, leading to inconsistent behavior: some tool types may hit Auth Profile resolution while others still hit the old `ToolSecret` path.

**Required addition:** A wiring diagram showing exactly where `authProfileService.resolve()` integrates into `LLMWiringService._wireExecutor()` and `RuntimeSecretsProvider.getSecret()`, and which existing layers it replaces vs. runs alongside.

### 1.3 RuntimeSecretsProvider secretCache Has No Max Size or TTL

**Finding:** `RuntimeSecretsProvider` (`apps/runtime/src/services/secrets-provider.ts:74–75`) uses two unbounded `Map<string, string>` instances — `secretCache` and `envVarCache` — with no max size and no TTL. They live for the session duration. CLAUDE.md rule: "Every in-memory Map needs max size, TTL, and eviction."

This is a pre-existing issue, but the Auth Profile migration adds a new dimension: when an Auth Profile's secrets are rotated mid-session (which is now explicitly supported via `rotationPolicy`), the cached plaintext value in `secretCache` will serve stale credentials for the rest of that session.

**Required addition:** The design should specify that `RuntimeSecretsProvider.secretCache` must be bounded (recommended: max 200 entries, no TTL since sessions are bounded in duration) and must be invalidated on Auth Profile rotation events.

### 1.4 DB Lookup Count Per Tool Call Not Specified

**Finding:** The design's Section 4 resolution priority has 5 levels, with levels 3–5 each potentially requiring a separate DB query:

```
Level 3: project-level Auth Profile with matching authProfileId + environment
Level 4: project-level Auth Profile with environment: null
Level 5: tenant-level Auth Profile fallback
```

In the worst case this is 3 DB queries per tool execution per unique credential key. The current `ToolSecret` path is 1 query. For an agent with 5 tools, each called twice per turn, this is potentially 30 queries per turn vs. 10 today.

**Required addition:** Specify the expected DB lookup strategy — e.g., "one prefetch query at session start that loads all Auth Profiles referenced by the agent's tools" — and whether resolution results must be cached at session scope with the same semantics as the existing `secretCache`.

---

## 2. Token Refresh During Execution

### 2.1 Existing Code Has No Distributed Lock on Refresh (Race Condition)

**Finding:** `ToolOAuthService.refreshToken()` (`apps/runtime/src/services/tool-oauth-service.ts:415–475`) does a bare `fetch(config.tokenUrl)` → `upsertToken()` with zero locking. Two concurrent executions by the same user on the same provider will both detect expiry (`record.expiresAt < Date.now() + 60_000` at line 374), both call the provider, and one will overwrite the other's new access token. If the provider uses refresh token rotation, the second refresh will fail because the first rotation already invalidated the refresh token.

The design's Section 5 correctly specifies a Redis `SET NX PX` distributed lock in step 3. But it says this "replaces" the existing implementations without noting that the current code has this exact race condition today.

**Required addition:** The design should explicitly call out that the existing `ToolOAuthService.refreshToken()` lacks the distributed lock and that this race is a known defect being fixed — not just a code deduplication exercise. This should be labeled as a correctness fix, not just a refactor.

### 2.2 No Retry-with-Refresh Behavior Specified for the Execution Hot Path

**Finding:** When a 401 is returned from a tool call (i.e., the token was valid at credential-resolution time but expired during the HTTP request flight), there is no specified behavior in the design. Currently, `ToolOAuthService.getAccessToken()` returns `undefined` on refresh failure (line 393) and the tool call proceeds with no credential — the downstream service returns a generic HTTP 401 that surfaces as an opaque tool error.

**Required addition:** Specify whether the `ToolBindingExecutor` should retry with a refreshed token on 401. If yes, specify the retry count (recommended: once), the condition (401 response only, not 403 or 429), and how this interacts with `executeWithRetry` in `error-handler-router.ts`.

### 2.3 Thundering Herd on Shared OAuth Tokens

**Finding:** The design mentions the distributed lock preventing concurrent refresh, but does not address what happens to the 2–10 concurrent executions that fail to acquire the lock. Section 5 step 3 says "acquire distributed lock" but does not specify the wait/retry strategy for lock contenders.

In a fan-out execution (10 parallel child agents all sharing one `oauth2_token` profile and all detecting expiry simultaneously), one wins the lock and refreshes; the other 9 will either fail immediately or spin-wait. With `SET NX PX` and no wait loop, all 9 fail immediately, causing 9 tool call failures.

**Required addition:** Specify whether lock contenders should: (a) wait and retry (with max wait of e.g. 2s), (b) use the new token after lock release (re-read from DB), or (c) fail fast with a specific error code. Option (b) — re-read from DB after lock contention — is the correct behavior and should be the specified default.

---

## 3. Streaming Scenarios

### 3.1 Not Addressed Anywhere in the Design

**Finding:** The design has zero mentions of streaming, WebSocket, SSE, or long-lived connections. The runtime has multiple long-lived session types where token TTL is a concern:

- **WebSocket sessions** (`apps/runtime/src/websocket/handler.ts`): Multi-turn conversations can run for 30–60+ minutes. OAuth tokens with 1-hour TTLs may expire mid-session.
- **AG-UI SSE connections** (`apps/runtime/src/channels/adapters/ag-ui-adapter.ts`): Server-sent events channel — auth headers are set at connection time and cannot be refreshed without reconnecting.
- **LiveKit voice sessions** (`apps/runtime/src/services/voice/livekit/agent-worker.ts`): Long-running voice calls that need Deepgram/ElevenLabs credentials valid for the call duration.

**Required addition:** A dedicated section specifying:

1. For WebSocket sessions: whether Auth Profile tokens are re-resolved per-turn or cached for the session duration. If cached, how rotation/expiry mid-session is handled.
2. For SSE/AG-UI: whether auth headers are refreshed proactively (before expiry) or reactively (on 401).
3. For voice sessions: whether the refresh buffer (`AUTH_PROFILE_TOKEN_REFRESH_BUFFER_SECONDS`, default 60s) is sufficient for the expected connection duration, and whether voice service credentials (Deepgram, ElevenLabs) use a different TTL model than API-key-based auth.

---

## 4. Multi-Agent Scenarios

### 4.1 Handoff — Child Agent Inherits Parent's toolExecutor (Credential Mismatch)

**Finding:** `RoutingExecutor.handleHandoff()` (`apps/runtime/src/services/execution/routing-executor.ts:640–662`) calls `wireLLMClient` for the target agent but does NOT call `wireToolExecutor`. The child agent inherits the parent session's `toolExecutor`, which was wired with the parent agent's `agentIR.tools` credential map in `LLMWiringService._wireExecutor()` (line 362–373).

The parent's `RuntimeSecretsProvider` was constructed with `agentIR = parentAgentIR`. If the child agent declares different `auth:` bindings for its tools (a common case when a supervisor hands off to a specialized tool-using agent), those tool credentials will not be in the inherited `secretCache` or `credentialsMap`.

The current ToolSecret/EnvironmentVariable path still works because DB lookups resolve by `tenantId + projectId + secretKey` regardless of which `agentIR` initialized the provider. But the design's Auth Profile resolution adds a new lookup dimension: `connector` and `connectionMode` (per_user vs. shared). The child agent's `per_user` auth requirements, compiled into its `authRequirements` manifest, will not be visible to the parent's `RuntimeSecretsProvider`.

**Required addition:** Specify that `wireToolExecutor` must be called for the target agent's IR at handoff time (as it is for fan-out child sessions at line 2777), passing `childAgentIR` as the source of truth for auth requirements. Alternatively, explicitly document that handoffs rely on tenant/project-scoped Auth Profile resolution (no per-agent scoping) and that `per_user` tokens are resolved via `userId` alone.

### 4.2 Delegate — Same Issue as Handoff

**Finding:** `RoutingExecutor.handleDelegate()` (lines 2115–2128) calls `wireLLMClient` for the target agent but also does not call `wireToolExecutor`. The same credential mismatch risk applies. After delegate return, the parent's LLM client is re-wired (line 2217) but the tool executor is never replaced — the parent resumes with whatever tool executor the child last set.

**Required addition:** Same as 4.1 — specify whether `wireToolExecutor` is called for the child agent's IR at delegate entry.

### 4.3 Fan-Out — authToken Passed as undefined for Child Sessions

**Finding:** Fan-out child sessions do call `wireToolExecutor` (line 2777), but `authToken` is explicitly passed as `undefined` (line 2780):

```typescript
this.llmWiring.wireToolExecutor(
  childSession,
  session.compilationOutput,
  undefined, // authToken — not needed for child
  session.tenantId,
  session.projectId,
);
```

This means child sessions will never resolve `auth_token` or `bearer_token` special keys in `RuntimeSecretsProvider.getSecret()` (line 134–136). If any child agent uses `auth: bearer_token` in its tool DSL, those tool calls will silently fail with no credential.

The comment "not needed for child" is incorrect if child agents use bearer-token-authenticated tools. The design does not address whether `per_user` OAuth tokens are accessible in fan-out child sessions, or whether only `shared` tokens can be used in fan-out scenarios.

**Required addition:** Explicitly document the auth token propagation policy for fan-out: does the parent's authToken propagate to all children? Is `per_user` OAuth supported in fan-out (it requires a userId, which is available on the session)? Specify that `session.authToken` should be passed to `wireToolExecutor` for child sessions that may use bearer-token-authenticated tools.

### 4.4 Cross-Project Handoffs — Auth Profile Scoping Not Addressed

**Finding:** The design's `validateAuthProfileAccess()` (Section 4) enforces that Auth Profiles are accessible only within the same project or at tenant level. The design does not address cross-project agent handoffs where a child agent in project B is invoked from a parent agent in project A (via A2A protocol or in-process routing).

In the current routing executor, remote A2A agents carry their own auth config inline in the registry entry (`agentInfo.remote?.auth`). For in-process cross-project agents, the `session.projectId` is used for all credential lookups. If a child agent belongs to a different project, its project-scoped Auth Profiles will be invisible.

**Required addition:** A cross-project handoff scoping rule: either (a) cross-project handoffs always use tenant-level Auth Profiles only (no project-scoped credentials propagate), or (b) the child agent's `projectId` is used for its own credential resolution (which would require passing the child's `projectId` through the handoff context).

---

## 5. Performance Concerns

### 5.1 No Cache Specification for authProfileService.resolve()

**Finding:** The design specifies `authProfileService.resolve()` as a function (Section 8) but does not specify its caching behavior. The current `ModelResolutionService` has an explicit metadata cache spec (5-min TTL, max 10K entries, credential-free). The current `RuntimeSecretsProvider.secretCache` caches per session. There is no equivalent cache specification for Auth Profile resolution.

Without a cache, each tool call that uses an Auth Profile will require a DB read. With a long-lived session and 10 tool calls per turn over 20 turns, that's 200 DB reads for a single session for credentials that almost never change.

**Required addition:** Specify a two-level cache for `authProfileService.resolve()`:

- Session-level: resolved credentials cached for the session duration (bounded by session lifecycle, like the existing `secretCache`). Max size: same recommendation as `secretCache`.
- Process-level: metadata cache (TTL 5 minutes, max 10K entries) that stores the Auth Profile document without decrypted secrets, mirroring the `ModelResolutionService.metadataCache` pattern.

### 5.2 Latency Impact of 5-Level Resolution Priority vs. Current Single Query

**Finding:** The design's Section 4 resolution priority is correct for correctness, but has no latency discussion. The current `ToolSecret.findOne()` is one indexed query. The new priority requires potentially checking personal tokens first, then shared tokens, then project-level profiles, then environment-scoped fallback, then tenant-level. In the worst case (no personal token, no shared token, environment-specific project profile absent, falling through to tenant-level) this is 5 distinct queries.

**Required addition:** Specify that the resolution priority should be collapsed into a single DB query using `$or` with priority ordering (similar to `validateAuthProfileAccess()` in Section 4), not a sequential waterfall of individual queries. Provide the recommended query shape.

---

## 6. Error Propagation

### 6.1 No TraceEvent Types Specified for Auth Failures

**Finding:** The platform's traceability invariant (CLAUDE.md Core Invariant #4) requires that every execution path emits `TraceEvent`s. Auth failures during execution are significant execution path divergences. The design's Section 10 describes user-visible error messages but does not specify what `TraceEvent` types are emitted when auth fails.

Current execution errors emit trace events via `emitDecisionEvent()` and explicit `onTraceEvent?.(...)` calls. Auth failures from `RuntimeSecretsProvider.getSecret()` emit only a `log.warn()` today (line 169) — no trace event.

**Required addition:** Define trace event types for:

- `auth_profile_resolved` — credential resolved successfully, includes `profileId`, `authType`, `connector`, `fromCache: boolean`
- `auth_profile_refresh` — token refresh attempted, includes `profileId`, `success: boolean`
- `auth_profile_failed` — credential resolution failed, includes `profileId`, `reason: 'not_found' | 'expired' | 'revoked' | 'refresh_failed' | 'misconfigured'`

### 6.2 No Retryability Classification for Auth Errors

**Finding:** `ErrorHandlerRouter` (`apps/runtime/src/services/execution/error-handler-router.ts:28`) uses `ErrorContext.retryable: boolean`. The design does not specify which auth failure scenarios are retryable vs. permanent.

Current behavior: `ToolOAuthService.getAccessToken()` returns `undefined` on refresh failure (line 393), causing the tool executor to proceed with no credential. The downstream service returns a 401/403, which is indistinguishable from a legitimate service authorization error.

The design should specify:

- Token expired, refresh succeeded → not an error, transparent
- Token expired, refresh failed → permanent auth error, `retryable: false`
- Auth Profile status `revoked` → permanent auth error, `retryable: false`
- Auth Profile status `expired` → permanent auth error, `retryable: false`
- Auth Profile not found → permanent auth error, `retryable: false`
- Auth Profile status `invalid` → permanent auth error, `retryable: false`
- Transient network error during refresh → transient, `retryable: true` (up to 2 times)

Without this classification, the error handler may retry a tool call with a permanently revoked credential, wasting LLM budget and potentially triggering rate limiting on the provider.

**Required addition:** An "Auth Error Retryability" table in Section 10 mapping each auth failure scenario to `retryable: true/false` and the recommended user-facing message variant.

### 6.3 Silent Failure Mode: undefined Token Propagates as Missing Credential

**Finding:** When `ToolOAuthService.getAccessToken()` returns `undefined` (line 393 on refresh failure, or line 398 on expiry without refresh token), the `RuntimeSecretsProvider.getUserOAuthToken()` returns `undefined` (line 234 on error, line 224 if no resolver). The `ToolBindingExecutor` then executes the tool with a missing credential, receiving a vague HTTP error from the downstream API.

The design's Section 10 error table says "Runtime returns: 'Gmail authorization expired. [Re-authorize]'" — but this implies the runtime knows the failure was an auth expiry. With the current silent `undefined` propagation, the runtime does not distinguish auth-credential-missing from all other `undefined` secret scenarios.

**Required addition:** Specify that `authProfileService.resolve()` must throw a typed `AuthProfileError` (not return `undefined`) on all non-transient failures, with a discriminated `reason` field. The `RuntimeSecretsProvider` should catch this and either surface it as a typed trace event or re-throw it as a structured `ErrorContext` with `type: 'auth'`, `subtype: reason`, and `retryable: false`.

---

## Summary of Gaps

| #   | Area                | Gap                                                                                                                   | Severity  |
| --- | ------------------- | --------------------------------------------------------------------------------------------------------------------- | --------- |
| 1.2 | Credential hot path | No hook point specified for authProfileService.resolve() in LLMWiringService                                          | Blocking  |
| 1.3 | Credential hot path | secretCache unbounded, not invalidated on rotation                                                                    | Important |
| 1.4 | Credential hot path | DB lookup count unspecified, potential 3–5x increase                                                                  | Important |
| 2.1 | Token refresh       | Existing ToolOAuthService.refreshToken() has no distributed lock (race condition) — not called out as bug being fixed | Blocking  |
| 2.2 | Token refresh       | No retry-with-refresh on 401 from tool call                                                                           | Important |
| 2.3 | Token refresh       | No lock-contention wait strategy — thundering herd in fan-out                                                         | Important |
| 3.1 | Streaming           | Zero coverage of WebSocket/SSE/voice session auth lifecycles                                                          | Important |
| 4.1 | Multi-agent         | Handoff does not re-wire toolExecutor for child agent's auth requirements                                             | Blocking  |
| 4.2 | Multi-agent         | Delegate has same gap as handoff                                                                                      | Blocking  |
| 4.3 | Multi-agent         | Fan-out passes authToken=undefined to child wireToolExecutor                                                          | Important |
| 4.4 | Multi-agent         | Cross-project handoff auth profile scoping not defined                                                                | Important |
| 5.1 | Performance         | No cache spec for authProfileService.resolve()                                                                        | Important |
| 5.2 | Performance         | 5-level resolution may be 5 serial queries — no optimization specified                                                | Important |
| 6.1 | Error propagation   | No TraceEvent types defined for auth failures                                                                         | Important |
| 6.2 | Error propagation   | No retryability classification for auth error scenarios                                                               | Important |
| 6.3 | Error propagation   | Silent undefined propagation instead of typed AuthProfileError                                                        | Important |

```

Now let me write this to the file using a tool (I'll use bash via a write operation — but I don't have a write tool directly). Let me use the approach of creating the file content.

Actually, I need to use a file writing mechanism. Let me check if there's a way to create files. I'll need to use the Bash tool if available, or I realize I should be able to write files. Let me check the available tools — I only have Glob, Grep, Read, WebFetch, and WebSearch. I cannot write files directly.

I need to communicate the findings to the user and have them write the file, or I need to reconsider. Wait — looking at the task, I need to "Save findings to docs/plans/2026-03-11-auth-profile-review-runtime.md". Since I only have read tools, I'll present the full document content clearly so the user can create it, but I should also note I cannot write directly.

Actually, re-reading the instructions — the task asks me to save to that file and run prettier. Since I have no Bash or Write tool, I'll present the complete document inline and explain the situation.

Wait — let me re-read my available tools. I have: Glob, Grep, Read, WebFetch, WebSearch. No Bash, no Write. I cannot create files. I'll deliver the findings as a complete document the user can save.

Reviewing the research I've done:

**Files examined:**
- `/Users/prasannaarikala/projects/agent-platform/docs/plans/2026-03-11-auth-profile-design.md` — full design doc
- `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/services/execution/llm-wiring.ts` — the wiring service that sets up tool execution
- `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/services/secrets-provider.ts` — credential resolution chain
- `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/services/tool-oauth-service.ts` — OAuth token handling, refresh logic
- `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/channels/connection-resolver.ts` — channel credential resolution
- `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/services/llm/model-resolution.ts` — LLM credential resolution with cache
- `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/services/execution/routing-executor.ts` — handoff/delegate/fan-out implementation
- `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/services/execution/error-handler-router.ts` — error context types

I cannot write the file directly. I'll present the complete document to the user.

---

I was unable to write the output file because I have no file-write tool available in this environment. Below is the complete content of the review document. You can save it to `/Users/prasannaarikala/projects/agent-platform/docs/plans/2026-03-11-auth-profile-review-runtime.md` and then run `npx prettier --write docs/plans/2026-03-11-auth-profile-review-runtime.md` from the repo root.

---

## Review: Auth Profile Design — Runtime Integration Gaps

**Files examined:**

- `/Users/prasannaarikala/projects/agent-platform/docs/plans/2026-03-11-auth-profile-design.md`
- `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/services/execution/llm-wiring.ts`
- `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/services/secrets-provider.ts`
- `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/services/tool-oauth-service.ts`
- `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/channels/connection-resolver.ts`
- `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/services/llm/model-resolution.ts`
- `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/services/execution/routing-executor.ts`
- `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/services/execution/error-handler-router.ts`

---

# Auth Profile Design — Runtime Integration Review

**Reviewer:** Claude Sonnet 4.6 (code review agent)
**Date:** 2026-03-11
**Document reviewed:** `2026-03-11-auth-profile-design.md`
**Method:** Traced the actual execution hot path through `LLMWiringService`, `RuntimeSecretsProvider`, `ToolOAuthService`, and `RoutingExecutor` in `apps/runtime/src/`. All findings are grounded in specific file + line references on the `develop` branch.

---

## Executive Summary

The design is architecturally sound at the data-model and API layers. The runtime integration layer — how Auth Profiles are actually consumed at execution time — has sixteen gaps. Four are blocking (token refresh race condition, missing hook point specification, handoff/delegate child-agent credential mismatch, delegate tool executor not re-wired). The remainder are important issues that should be addressed in the design before implementation begins.

---

## 1. Credential Resolution Hot Path

### 1.1 Current Live Execution Path (codebase truth)

The actual credential resolution chain during tool execution is:

```

Session start
LLMWiringService.\_wireExecutor() [llm-wiring.ts:356]
new RuntimeSecretsProvider({ secretStore, decryptor, oauthResolver })

Per tool call
ToolBindingExecutor.execute(toolName, params)
secrets.getSecret(key) [secrets-provider.ts:133] 1. In-memory secretCache (no TTL, no max size) 2. ToolSecret.findOne({ tenantId, projectId, secretKey, environment }) 3. Agent IR credentials config map (baked at compile time) 4. process.env[key]

# Arch AI Tool Extensions — Design Spec

> **Date:** 2026-05-06
> **Goal:** Complete the last 6 tool gaps so Arch AI can fully act on channels, deployments, auth profiles, connections, KB admin, and test conversations — with cross-dependency awareness that prevents half-baked actions.
> **Architecture:** Dual-layer protection — hard guards in tool executors (prevent broken states) + soft intelligence in expertise cards (teach Arch to reason holistically before acting).

---

## 1. Design Principles

### Hard Guards (in tool executor)

Prevent **data loss and broken states** that are unrecoverable. These are fast checks (one DB/API call). They block execution and return structured errors explaining why.

### Soft Intelligence (in expertise cards)

Teach Arch to **think holistically** before calling tools. The LLM reads the decision tree from expertise cards and makes precondition-check tool calls before the destructive action. This is the "senior engineer" layer — not enforced by code, but guided by knowledge.

### Flow

```
User request
  → Expertise card loaded (teaches prerequisites)
  → Arch calls read/list tools to check state
  → Arch reasons about whether to proceed (LLM judgment)
  → Arch calls the action tool
  → Hard guard validates (blocks or allows)
  → Tool executes → returns result with next-step suggestions
  → Expertise card guides post-action follow-up
```

---

## 2. Extension 1: `deployment_ops` — Add `retire`, `rollback`, `list_channel_types`

### Current State

Actions: `list`, `deploy`, `promote`, `list_channels`, `configure_channel`

### New Actions

#### `retire`

| Aspect     | Detail                                                                                                                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input      | `{ action: "retire", deploymentId, confirmed: true }`                                                                                                                                                          |
| Hard guard | Calls `list_channels`. If any channel's `deploymentId` matches → return `{ needsConfirmation: true, warning, boundChannels }`. If no other active deployment in same env → block with `LAST_ACTIVE_DEPLOYMENT` |
| API        | `retireDeployment(projectId, deploymentId)` from `@/api/deployments`                                                                                                                                           |
| Cross-deps | Channels go dark if bound to retired deployment. Expertise card teaches: check channels → reassign or rollback instead                                                                                         |

#### `rollback`

| Aspect     | Detail                                                                                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input      | `{ action: "rollback", deploymentId, confirmed: true }`                                                                                                                 |
| Hard guard | Calls `listDeployments`. If no retired deployment exists in same environment → return `{ blocked: true, code: "NO_PREVIOUS_DEPLOYMENT" }`                               |
| API        | `rollbackDeployment(projectId, deploymentId)` from `@/api/deployments`                                                                                                  |
| Cross-deps | Reactivates previous deployment config (possibly older agent versions). Expertise card teaches: verify previous agents are still compatible with current tools/channels |

#### `list_channel_types`

| Aspect         | Detail                                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Input          | `{ action: "list_channel_types" }`                                                                                          |
| Hard guard     | None (read-only)                                                                                                            |
| Implementation | Returns static channel type catalog: id, name, category, capabilities (multiConnection, hasCredentials, supportsTest, etc.) |
| Cross-deps     | None — informational                                                                                                        |

### Updated Input Type

```typescript
interface DeploymentOpsInput {
  action:
    | 'list'
    | 'deploy'
    | 'promote'
    | 'retire'
    | 'rollback'
    | 'configure_channel'
    | 'list_channels'
    | 'list_channel_types';
  deploymentId?: string;
  environment?: string;
  channelType?: string;
  channelConfig?: Record<string, unknown>;
  confirmed?: boolean;
}
```

---

## 3. Extension 2: `connection_ops` — Add `test`

### Current State

Actions: `list`, `create`, `delete`, `resolve_options`, `resolve_dynamic_props`

### New Action

#### `test`

| Aspect     | Detail                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------- |
| Input      | `{ action: "test", connectionId }`                                                                |
| Hard guard | None (read-only operation)                                                                        |
| API        | `testConnection(projectId, connectionId)` from `@/api/connections`                                |
| Return     | `{ success: true, data: { status: "healthy"                                                       | "error" | "expired", latencyMs, errorDetails? } }` |
| Cross-deps | If expired → expertise card teaches: guide to re-auth. If error → check endpoint URL, credentials |

### Updated Schema

Add to the discriminated union:

```typescript
z.object({ action: z.literal('test'), connectionId: z.string().min(1) });
```

---

## 4. Extension 3: `auth_ops` — Add `revoke` + Expand Auth Types

### Current State

Actions: `list`, `read`, `create`, `update`, `delete`, `validate`
Types: `api_key`, `bearer`, `oauth2_app`, `oauth2_client_credentials`

### New Action

#### `revoke`

| Aspect     | Detail                                                                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input      | `{ action: "revoke", profileId, confirmed: true }`                                                                                                                                                            |
| Hard guard | Fetches profile consumers via `/auth-profiles/:id/consumers` (if available) or notes in warning. Returns `{ needsConfirmation: true, warning: "Revoking will immediately break N tools using this profile" }` |
| API        | `revokeAuthProfile(projectId, profileId)` from `@/api/auth-profiles`                                                                                                                                          |
| Cross-deps | All tools bound to this profile will fail with `AUTH_PROFILE_TOKEN_REQUIRED`. Expertise card teaches: list consumers first, update tools to alternative profile, then revoke                                  |

### Expanded Auth Types

Add to `SUPPORTED_AUTH_TYPES`:

```typescript
const SUPPORTED_AUTH_TYPES = [
  'api_key',
  'bearer',
  'oauth2_app',
  'oauth2_client_credentials',
  'oauth2_token',
  'azure_ad',
  'none',
] as const;
```

New `REQUIRED_SECRETS` entries:

```typescript
const REQUIRED_SECRETS: Record<SupportedAuthType, string[]> = {
  api_key: ['apiKey'],
  bearer: ['token'],
  oauth2_app: ['clientId', 'clientSecret'],
  oauth2_client_credentials: ['clientId', 'clientSecret'],
  oauth2_token: ['accessToken'], // refreshToken optional
  azure_ad: ['clientId', 'clientSecret'], // tenantId is config, not secret
  none: [], // no secrets needed
};
```

For `none` type: skip the `collect_secret` flow entirely — create immediately.
For `oauth2_token`: `accessToken` required, `refreshToken` optional (passed in config).
For `azure_ad`: `tenantId` and `scope` go in config, `clientId` and `clientSecret` are secrets.

---

## 5. Extension 4: `kb_ingest` — Add `remove_source`

### Current State

Actions: `upload_file`, `add_url`, `add_text`, `list_sources`

### New Action

#### `remove_source`

| Aspect     | Detail                                                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input      | `{ action: "remove_source", indexId, sourceId, confirmed: true }`                                                                                                                     |
| Hard guard | Fetch source status. If `status === "syncing"` → block with `SOURCE_SYNCING`. Always require `confirmed: true` (destructive)                                                          |
| API        | `DELETE /api/indexes/:indexId/sources/:sourceId` on SearchAI runtime (`search-ai` app)                                                                                                |
| Return     | `{ success: true, data: { removedChunks: N, remainingSources: M } }`                                                                                                                  |
| Cross-deps | If this is the only source → KB becomes empty → agents querying it get no results. Expertise card teaches: check source count, warn if sole source, suggest replacing before removing |

### Updated Type

```typescript
type IngestAction = 'upload_file' | 'add_url' | 'add_text' | 'list_sources' | 'remove_source';
```

---

## 6. Extension 5: `chat_ops` — New Tool

### Purpose

Send test messages to agents and manage test sessions. This is what the Studio chat panel does — exposed as a tool so Arch can test agents conversationally.

### Actions

#### `send`

| Aspect     | Detail                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Input      | `{ action: "send", agentName, message, sessionId? }`                                                                                                                           |
| Hard guard | Call `agent_ops(compile)` first. If compilation fails → block with `AGENT_NOT_COMPILABLE` and include first 3 errors                                                           |
| API        | `POST /api/internal/chat/agent` on runtime with `{ projectId, agentName, message, sessionId }`                                                                                 |
| Return     | `{ success: true, data: { response, sessionId, traceId, toolCalls?: [...] } }`                                                                                                 |
| Cross-deps | Requires agent to compile. If agent has tools with auth profiles, those must be valid. Expertise card teaches: compile first, then send, inspect trace if response seems wrong |

#### `list_sessions`

| Aspect     | Detail                                                       |
| ---------- | ------------------------------------------------------------ |
| Input      | `{ action: "list_sessions", agentName?, limit?: 10 }`        |
| Hard guard | None (read-only)                                             |
| API        | Reuse `session_ops` internally or call sessions API directly |
| Return     | `{ success: true, data: { sessions: [...] } }`               |

#### `reset`

| Aspect     | Detail                                            |
| ---------- | ------------------------------------------------- |
| Input      | `{ action: "reset", sessionId, confirmed: true }` |
| Hard guard | Require `confirmed: true`                         |
| API        | Session reset endpoint or create new session      |
| Return     | `{ success: true, data: { newSessionId } }`       |

### Tool Definition

```typescript
interface ChatOpsInput {
  action: 'send' | 'list_sessions' | 'reset';
  agentName?: string;
  message?: string;
  sessionId?: string;
  limit?: number;
  confirmed?: boolean;
}
```

### Specialist Assignment

Add `chat_ops` to:

- `diagnostician` — debugging sessions
- `abl-construct-expert` — testing after modifications
- `testing-eval` — part of test workflow

### ToolName Addition

Add `'chat_ops'` to the `ToolName` union type in `packages/arch-ai/src/types/tools.ts`.

---

## 7. Expertise Card Updates

The existing expertise cards reference future tool names that don't exist. Update to match actual tool names:

### `channels-operations` card changes:

| Before                               | After                                                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `channel_ops(action: "list_types")`  | `deployment_ops(action: "list_channel_types")`                                                                    |
| `channel_ops(action: "create", ...)` | `deployment_ops(action: "configure_channel", { channelType, channelConfig, confirmed: true })`                    |
| `channel_ops(action: "test")`        | `chat_ops(action: "send")` through the channel, or `connection_ops(action: "test")` for the underlying connection |
| `channel_ops(action: "bind_env")`    | Part of `channelConfig.environment` in `configure_channel`                                                        |

### `deployment-operations` card changes:

| Before          | After                                                                        |
| --------------- | ---------------------------------------------------------------------------- |
| (not mentioned) | Add: `deployment_ops(action: "retire", { deploymentId, confirmed: true })`   |
| (not mentioned) | Add: `deployment_ops(action: "rollback", { deploymentId, confirmed: true })` |

### `auth-operations` card changes:

| Before             | After                                                                             |
| ------------------ | --------------------------------------------------------------------------------- |
| (mentions 7 types) | Now all 7 types actually work: add `oauth2_token`, `azure_ad`, `none` examples    |
| (not mentioned)    | Add revoke sequence: `auth_ops(action: "revoke", { profileId, confirmed: true })` |

### `kb-operations` card changes:

| Before                          | After                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------- |
| (not mentioned)                 | Add: `kb_ingest(action: "remove_source", { indexId, sourceId, confirmed: true })` |
| (mentions "check source count") | Add pre-removal check sequence                                                    |

---

## 8. Cross-Dependency Matrix

For each tool action, what Arch should check BEFORE and do AFTER:

| Action                     | Check Before                                                 | Execute  | Do After                                                                           |
| -------------------------- | ------------------------------------------------------------ | -------- | ---------------------------------------------------------------------------------- |
| `deployment_ops(retire)`   | List bound channels, check other active deployments          | Retire   | Confirm channels reassigned, suggest monitoring                                    |
| `deployment_ops(rollback)` | Verify previous deployment exists, check agent compatibility | Rollback | Verify channels still work, suggest test message                                   |
| `connection_ops(test)`     | None                                                         | Test     | If failed: diagnose (expired? unreachable?). If passed: confirm which tools use it |
| `auth_ops(revoke)`         | List consumers (tools), warn about breakage                  | Revoke   | Confirm tools updated, suggest replacement profile                                 |
| `kb_ingest(remove_source)` | Check sync status, count chunks, check if sole source        | Remove   | Verify KB still has content, suggest test query                                    |
| `chat_ops(send)`           | Compile agent, verify agent exists                           | Send     | Show response + trace summary, suggest follow-up                                   |

This matrix is encoded in the expertise cards as "Tool Sequence" sections with numbered steps.

---

## 9. Implementation Scope

### Files to Modify

| File                                                      | Changes                                                   |
| --------------------------------------------------------- | --------------------------------------------------------- |
| `apps/studio/src/lib/arch-ai/tools/deployment-ops.ts`     | Add `retire`, `rollback`, `list_channel_types` cases      |
| `apps/studio/src/lib/arch-ai/tools/connection-ops.ts`     | Add `test` case to discriminated union                    |
| `apps/studio/src/lib/arch-ai/tools/auth-ops.ts`           | Add `revoke` case + expand `SUPPORTED_AUTH_TYPES`         |
| `apps/studio/src/lib/arch-ai/tools/kb-ingest.ts`          | Add `remove_source` case                                  |
| `apps/studio/src/lib/arch-ai/tools/chat-ops.ts`           | **New file** — send, list_sessions, reset                 |
| `apps/studio/src/lib/arch-ai/tools/in-project-tools.ts`   | Register `chat_ops` tool definition                       |
| `packages/arch-ai/src/types/tools.ts`                     | Add `'chat_ops'` to ToolName, add to specialist tool maps |
| `packages/arch-ai/src/knowledge/cards/expertise/index.ts` | Update 4 expertise cards with correct tool names          |

### Files NOT Modified

- Card router (already routes correctly)
- Platform cards (factual content unchanged)
- Content router (specialist routing unchanged — `integration-methodologist` already handles deployments/connections/auth)
- L3 index (unchanged)

---

## 10. Success Criteria

| Criteria                                                        | Measurement                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Arch can retire/rollback deployments with channel safety checks | `deployment_ops(retire)` blocks when channels bound, allows after reassignment |
| Arch can test connections end-to-end                            | `connection_ops(test)` returns health status                                   |
| Arch can revoke auth profiles with consumer awareness           | `auth_ops(revoke)` shows consumer warning before executing                     |
| Arch can create all 7 auth types                                | `auth_ops(create)` with `oauth2_token`, `azure_ad`, `none` succeeds            |
| Arch can remove KB sources safely                               | `kb_ingest(remove_source)` blocks during sync, requires confirmation           |
| Arch can send test messages to agents                           | `chat_ops(send)` returns response + trace                                      |
| Expertise cards reference correct tool names                    | No references to non-existent `channel_ops`                                    |
| All hard guards have test coverage                              | Unit tests for each blocker scenario                                           |

# Arch AI Auth Ops Tool — Design Spec

**Date**: 2026-04-13
**Branch**: arch/knowledge
**Status**: DRAFT
**Ticket**: ABLP-162

## Problem

Solution architects using Arch's in-project chat can see existing auth profiles
(via `platform_context` action `list_auth_profiles`) but cannot create, update,
delete, or test them. This forces SAs out of the conversational flow to manually
configure auth profiles in the Studio UI before returning to Arch to bind them to
tools. The gap is most painful for OAuth workflows, which require collecting
multiple config fields and secrets.

## Scope

### In Scope

- New tool module `auth-ops.ts` with CRUD + list + validate actions
- Wire into IN_PROJECT tools in `message/route.ts` `buildInProjectTools()`
- Permission mapping in `guards.ts`
- Integration-methodologist prompt guidance for auth workflow
- System prompt update in `message/route.ts` `processInProjectMessage()` to advertise auth_ops
- Secure secret collection via a non-persisted secret path (see Secret Handling section)
- Support for Core 4 auth types: `api_key`, `bearer`, `oauth2_app`, `oauth2_client_credentials`
- Cache invalidation of `platform_context.list_auth_profiles` after mutations
- Inherited tenant profile handling (read-only surfacing)

### Out of Scope (Backlogged)

- Phase 2+ auth types (basic, custom_header, aws_iam, azure_ad, mtls, ssh_key)
- Phase 3 auth types (digest, kerberos, saml, hawk, ws_security)
- OAuth callback flow (authorize -> callback -> token storage)
- Credential rotation via Arch chat
- Bulk import of auth profiles
- Provider-specific OAuth discovery (auto-populating URLs from provider name)
- Adding auth_ops to the chat route (`context.ts` / `system-prompt.ts`)

## Runtime Stack Clarification

There are two Arch UI surfaces with different API stacks:

| Surface           | Component         | API Route                                      | Tools                                                | Widgets                      |
| ----------------- | ----------------- | ---------------------------------------------- | ---------------------------------------------------- | ---------------------------- |
| Legacy chat panel | `ArchAIChatPanel` | `/api/arch-ai/chat` (Vercel AI SDK `useChat`)  | `context.ts` + `system-prompt.ts`                    | `AskUserRenderer` / `QACard` |
| v3 overlay        | `ArchOverlay`     | `/api/arch-ai/message` (SSE via `useArchChat`) | `buildInProjectTools()` inline in `message/route.ts` | `WidgetRenderer` (arch-v3)   |

**auth_ops lands exclusively in the v3 message route stack.** `ArchOverlay` is the
active IN_PROJECT surface. `ArchAIChatPanel` uses the chat route which has its own
tool set in `context.ts` — that stack is not touched by this spec.

The `useArchChat` hook (used by ArchOverlay) posts to `/api/arch-ai/message`.
Tool answers go through `sendToolAnswer()` -> `POST /api/arch-ai/message` with
`{ type: 'tool_answer', toolCallId, answer }`. Widget rendering uses the v3
`WidgetRenderer` component, not the legacy `AskUserRenderer`/`QACard`.

Files affected:

| Concern               | File                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------- |
| Tool executor         | `apps/studio/src/lib/arch-ai/tools/auth-ops.ts` (new)                                   |
| Tool registration     | `apps/studio/src/app/api/arch-ai/message/route.ts` (`buildInProjectTools`)              |
| Tool map filtering    | `apps/studio/src/app/api/arch-ai/message/route.ts` (`IN_PROJECT_SPECIALIST_TOOL_MAP`)   |
| Permission guards     | `apps/studio/src/lib/arch-ai/guards.ts`                                                 |
| Request schema        | `packages/arch-ai/src/types/message-request.ts` (`MessageRequestSchema`)                |
| Specialist prompt     | `packages/arch-ai/src/prompts/specialists/integration-methodologist.ts`                 |
| Client-side tool list | `packages/arch-ai/src/types/tools.ts` (`isClientSideTool`)                              |
| Secret collection UI  | `apps/studio/src/components/arch-v3/widgets/WidgetRenderer.tsx` + new `SecretInput.tsx` |
| Secret transport      | `apps/studio/src/hooks/useArchChat.ts`                                                  |
| Answered summary      | `apps/studio/src/components/arch-v3/widgets/WidgetRenderer.tsx` (answered branch)       |
| Cache invalidation    | `apps/studio/src/lib/arch-ai/tools/cache-invalidation.ts` (existing helper)             |

## Architecture Decision: REST API Proxy with Translation Layer

The auth_ops tool calls the existing Studio REST API endpoints rather than
accessing Mongoose models directly. This reuses all existing validation:

- Zod schema validation (`CreateAuthProfileSchema`, `UpdateAuthProfileSchema`)
- SSRF protection for OAuth URL fields
- Mongoose encryption plugin for secrets
- Visibility and scope enforcement
- Consumer blocker checks on delete

Because the REST API's Zod schemas have strict, type-discriminated payloads that
differ from a natural LLM-facing schema, the tool includes an explicit
**translation layer** that maps LLM-friendly input to the REST contract:

| LLM Input               | REST API Payload                | Translation                                    |
| ----------------------- | ------------------------------- | ---------------------------------------------- |
| `headerName` (api_key)  | `config.headerName`             | Direct pass-through                            |
| `clientId` (oauth2)     | `secrets.clientId`              | Move to secrets (NOT config)                   |
| `clientSecret` (oauth2) | `secrets.clientSecret`          | From non-persisted secret path                 |
| `scopes` (oauth2_app)   | `config.defaultScopes`          | Rename `scopes` -> `defaultScopes`             |
| `scopes` (oauth2_cc)    | `config.scopes`                 | Direct (cc uses `scopes`, not `defaultScopes`) |
| (implicit)              | `scope: 'project'`, `projectId` | Auto-set by tool from ctx                      |
| (implicit)              | `visibility: 'shared'`          | Default, overridable                           |

The tool also auto-injects `projectId`, `tenantId`, and `createdBy` from the
auth context — the LLM never needs to provide these.

## Secret Handling — Non-Persisted Path

### Problem

The current `ask_user` -> `tool_answer` flow has three places where a secret
value would leak:

1. **WidgetRenderer.tsx** renders the answered value in the chat UI as plain text
2. **useArchChat.ts** `sendToolAnswer()` posts `{ type: 'tool_answer', answer }` to the message route
3. **message/route.ts** persists the answer as a user message AND injects it into `llmMessages` as `User answered: <value>`

A `sensitive: true` flag on the `<input>` element only masks typing — it does
NOT prevent the secret from being echoed, persisted, or sent to the model.

### Solution: `collect_secret` client-side tool with flow-scoped secret store

Instead of extending `ask_user`, introduce a new **client-side tool** `collect_secret`
with a dedicated non-persisted answer flow.

**Key constraints:**

1. OAuth flows require collecting `clientId` and `clientSecret` in separate
   `collect_secret` calls — each is a separate POST to the message route
2. In a multi-pod deployment, sequential requests within a flow may land on
   different processes. Pod-local `Map` storage violates the platform's
   stateless/distributed invariant (CLAUDE.md invariant #3).
3. A session may contain multiple auth setup attempts. Keying secrets only by
   `sessionId + fieldName` causes stale secrets from an abandoned attempt to
   silently contaminate the next one.

#### Flow

1. LLM calls `auth_ops(action: 'create', ...)` — tool detects missing secrets, returns
   `{ needsSecrets: true, requiredSecrets: [...], flowId: '<generated-uuid>' }`
2. LLM calls `collect_secret({ flowId, field: 'clientId', label: 'OAuth Client ID' })`
3. `WidgetRenderer` renders a password-masked input
4. On submit, `useArchChat.sendToolAnswer()` sends
   `{ type: 'tool_answer', toolCallId, answer: '(secret collected)', secrets: { flowId, values: { clientId: '<value>' } } }`
5. The message route writes secrets to the flow-scoped secret store (Redis or in-memory fallback)
   and persists only `'(secret collected)'` as the answer
6. LLM calls `collect_secret({ flowId, field: 'clientSecret', label: 'OAuth Client Secret' })`
7. Same flow — secret accumulates under the same `flowId`
8. LLM calls `auth_ops(action: 'create', profileName, authType, config, flowId)`
9. `auth_ops` reads secrets from the store by `flowId`, builds REST payload, calls API
10. On success or failure, the flow's secrets are consumed (deleted from store)

#### Flow-Scoped Secret Store

**New file:** `apps/studio/src/lib/arch-ai/tools/secret-store.ts`

Follows the hybrid Redis/in-memory pattern from `services/sso/sso-state-store.ts`:

```typescript
import { isRedisAvailable, getRedisClient } from '@/lib/redis-client';

const REDIS_PREFIX = 'arch:secret:';
const SECRET_TTL_SECONDS = 900; // 15 minutes

// In-memory fallback (single-process only)
const memSecrets = new Map<string, { data: Record<string, string>; expiresAt: number }>();

export async function setFlowSecrets(
  flowId: string,
  secrets: Record<string, string>,
): Promise<void> {
  if (isRedisAvailable()) {
    const redis = getRedisClient();
    const existing = await redis.get(`${REDIS_PREFIX}${flowId}`);
    const merged = { ...(existing ? JSON.parse(existing) : {}), ...secrets };
    await redis.set(`${REDIS_PREFIX}${flowId}`, JSON.stringify(merged), 'EX', SECRET_TTL_SECONDS);
    return;
  }
  const entry = memSecrets.get(flowId);
  const merged = { ...(entry?.data ?? {}), ...secrets };
  memSecrets.set(flowId, { data: merged, expiresAt: Date.now() + SECRET_TTL_SECONDS * 1000 });
}

export async function consumeFlowSecrets(flowId: string): Promise<Record<string, string> | null> {
  if (isRedisAvailable()) {
    const redis = getRedisClient();
    const raw = await redis.getdel(`${REDIS_PREFIX}${flowId}`);
    return raw ? JSON.parse(raw) : null;
  }
  const entry = memSecrets.get(flowId);
  memSecrets.delete(flowId);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.data;
}
```

**Key properties:**

- **Redis when available:** Secrets stored as `arch:secret:<flowId>` with 15-min TTL.
  Works across pods — any process can read/consume.
- **In-memory fallback:** Single-process `Map` with TTL expiry. Acceptable for local dev
  and single-pod deployments. Documented as a limitation.
- **Flow-scoped, not session-scoped:** Each `auth_ops` create/update attempt generates a
  unique `flowId` (UUIDv4). Multiple auth setups in the same session use different flowIds.
  Abandoned flows expire via TTL without contaminating subsequent attempts.
- **Atomic consume:** `consumeFlowSecrets()` uses Redis `GETDEL` — read and delete in one
  operation. Prevents a race where two concurrent requests both read the same secrets.
- **No MongoDB persistence:** Secrets live in Redis (ephemeral) or process memory only.
  Never written to the session document, message history, or any durable store.

**Lifecycle:**

| Event                                       | Action                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------- |
| `auth_ops` returns `needsSecrets`           | Generate `flowId`, return to LLM                                                |
| `collect_secret` tool_answer with `secrets` | `setFlowSecrets(flowId, secrets)` — merge into flow                             |
| `auth_ops` create/update with `flowId`      | `consumeFlowSecrets(flowId)` — atomic read+delete                               |
| Abandoned flow (user changes topic)         | TTL expiry (15 min) auto-deletes                                                |
| Failed create/update                        | `consumeFlowSecrets` already deleted; LLM must start new flow with new `flowId` |

**In-memory fallback cleanup:** A `setInterval` (60s) sweeps expired entries from the
fallback `Map`, matching the SSO state store pattern.

#### MessageRequestSchema Update

**File:** `packages/arch-ai/src/types/message-request.ts`

The `tool_answer` variant must accept an optional `secrets` field:

```typescript
z.object({
  sessionId: z.string().min(1),
  type: z.literal('tool_answer'),
  toolCallId: z.string().min(1),
  answer: z.unknown(),
  secrets: z.object({                                    // NEW
    flowId: z.string().min(1),
    values: z.record(z.string(), z.string()),
  }).optional(),
}),
```

This is the ONLY place secrets enter the server. The route extracts `msg.secrets`,
calls `setFlowSecrets(flowId, values)`, and never includes them in persisted
messages or LLM context.

#### Frontend Changes

**useArchChat.ts:** Modify `sendToolAnswer()` to accept an optional `secrets` parameter:

```typescript
sendToolAnswer: (
  toolCallId: string,
  answer: unknown,
  secrets?: { flowId: string; values: Record<string, string> },
) => Promise<void>;
```

When secrets are provided, they are included in the POST body but the `answer` field
is always `'(secret collected)'` — the actual secret value never enters React state
or the message list.

**WidgetRenderer.tsx:** Add a `collect_secret` branch:

```typescript
if (toolName === 'collect_secret' && isObject(safeInput)) {
  // Render SecretInput (password-masked TextInput variant)
  // safeInput has { field, label, flowId }
  // On submit: call onSubmit(toolCallId, '(secret collected)',
  //   { flowId: safeInput.flowId, values: { [safeInput.field]: value } })
}
```

For the **answered summary** branch (when `answeredResult` is set), `collect_secret`
renders as a locked pill: "Secret collected" with a lock icon, never the actual value.

**New component:** `apps/studio/src/components/arch-v3/widgets/SecretInput.tsx`
— a thin wrapper around TextInput that renders `<input type="password">` and
passes the raw value via a separate `onSecretSubmit` callback (not through the
displayed answer).

#### Guarantees

- Secret never appears in chat history (WidgetRenderer shows "Secret collected")
- Secret never sent to the LLM context (`llmMessages` sees `'(secret collected)'`)
- Secret never persisted in MongoDB session storage
- Secrets accumulate across `collect_secret` turns within the same auth flow
- Secrets are flow-scoped — abandoned/failed flows cannot contaminate subsequent attempts
- Multi-pod safe when Redis is available (stateless/distributed invariant preserved)
- Secrets are TTL-evicted after 15 minutes even if not consumed
- In-memory fallback works for single-pod/local dev (documented limitation)

## Tool Module: auth-ops.ts

**File**: `apps/studio/src/lib/arch-ai/tools/auth-ops.ts`

### Input Schema

```typescript
interface AuthOpsInput {
  action: 'create' | 'read' | 'update' | 'delete' | 'list' | 'validate';
  profileId?: string; // read, update, delete, validate
  profileName?: string; // create (required)
  authType?: string; // create: api_key | bearer | oauth2_app | oauth2_client_credentials
  config?: Record<string, unknown>; // LLM-facing config (translated before API call)
  flowId?: string; // create/update — references collected secrets in the secret store
  confirmed?: boolean; // delete (dangerous action gate)
}
```

Note: secrets are NOT in the input schema. They come from the flow-scoped secret
store via `flowId`, populated by prior `collect_secret` calls.

### Actions

| Action     | HTTP Method | Endpoint                                              | Permission            |
| ---------- | ----------- | ----------------------------------------------------- | --------------------- |
| `list`     | GET         | `/api/projects/:id/auth-profiles`                     | `auth_profile:read`   |
| `read`     | GET         | `/api/projects/:id/auth-profiles/:profileId`          | `auth_profile:read`   |
| `create`   | POST        | `/api/projects/:id/auth-profiles`                     | `auth_profile:write`  |
| `update`   | PUT         | `/api/projects/:id/auth-profiles/:profileId`          | `auth_profile:write`  |
| `delete`   | DELETE      | `/api/projects/:id/auth-profiles/:profileId`          | `auth_profile:delete` |
| `validate` | POST        | `/api/projects/:id/auth-profiles/:profileId/validate` | `auth_profile:write`  |

### Create Flow (Multi-Step)

1. LLM calls `auth_ops(action: 'create', profileName, authType, config)` without flowId
2. Tool validates required config fields for the auth type
3. Secrets are needed — tool generates a `flowId` (UUIDv4) and returns:
   ```json
   {
     "success": false,
     "needsSecrets": true,
     "flowId": "550e8400-e29b-41d4-a716-446655440000",
     "requiredSecrets": ["clientId", "clientSecret"],
     "message": "Use collect_secret with this flowId for each required secret, then call create again with the flowId"
   }
   ```
4. LLM calls `collect_secret({ flowId: '550e...', field: 'clientId', label: 'OAuth Client ID' })`
5. User provides value via masked input -> secret store keyed by flowId
6. LLM calls `collect_secret({ flowId: '550e...', field: 'clientSecret', label: 'OAuth Client Secret' })`
7. User provides value -> secret store accumulates under same flowId
8. LLM calls `auth_ops(action: 'create', profileName, authType, config, flowId: '550e...')`
9. Tool calls `consumeFlowSecrets(flowId)` — atomic read+delete from store
10. Builds REST payload via translation layer, calls POST
11. Returns `{ success: true, data: { id, name, authType, status } }`
12. Secrets already consumed by step 9 — no cleanup needed

### Required Fields Per Auth Type (LLM-Facing Schema)

| Auth Type                   | Config Fields (LLM input)                                    | Secret Fields (via collect_secret) |
| --------------------------- | ------------------------------------------------------------ | ---------------------------------- |
| `api_key`                   | `headerName` (default: `X-API-Key`), `placement`?, `prefix`? | `apiKey`                           |
| `bearer`                    | `prefix`?                                                    | `token`                            |
| `oauth2_app`                | `authorizationUrl`, `tokenUrl`, `scopes[]`, `pkceRequired`?  | `clientId`, `clientSecret`         |
| `oauth2_client_credentials` | `tokenUrl`, `scopes[]`                                       | `clientId`, `clientSecret`         |

### REST Payload Translation

The translation layer maps the LLM-facing schema to the strict Zod-validated REST payloads:

**api_key**: Config passes through directly (`headerName`, `prefix`, `placement`).
Secrets pass through directly (`apiKey`).

**bearer**: Config passes through (`prefix`).
Secrets pass through (`token`).

**oauth2_app**: Config translation: `scopes` -> `defaultScopes`. All URL fields pass through.
Secrets: `clientId` + `clientSecret` — both are secret fields per `OAuth2AppSecretsSchema`.

**oauth2_client_credentials**: Config passes through (`tokenUrl`, `scopes`).
Secrets: `clientId` + `clientSecret` per `OAuth2ClientCredentialsSecretsSchema`.

**Auto-injected fields** (not from LLM):

- `scope: 'project'`
- `projectId`: from `ctx.projectId`
- `visibility: 'shared'` (default)
- `connectionMode: 'shared'` (exception: `oauth2_app` defaults to `'per_user'`)

### Validate Action

Uses the existing `POST /api/projects/:id/auth-profiles/:profileId/validate` endpoint.
This endpoint:

- Requires `AUTH_PROFILE_WRITE` permission (not read — it may attempt live connections)
- Decrypts secrets and runs `getMaterializedAuthProfileValidationErrors()`
- For `oauth2_client_credentials`: attempts a real token exchange to the provider
- Returns `{ valid: boolean, latencyMs: number, message?: string }`
- Updates `lastValidatedAt` on success

The tool maps this to a clear LLM-consumable response:

```json
{
  "success": true,
  "data": {
    "valid": true,
    "latencyMs": 342,
    "message": null
  }
}
```

On validation failure:

```json
{
  "success": true,
  "data": {
    "valid": false,
    "latencyMs": 1205,
    "message": "Provider returned 401"
  }
}
```

### Inherited Tenant Profile Handling

The project-level list endpoint returns both project-scoped and inherited
tenant-scoped profiles. However, project-level PUT/DELETE explicitly reject
workspace-level profiles with 403 ("Edit it at Settings > Auth Profiles").

The auth_ops tool handles this as follows:

- **list**: Returns all profiles. Tenant-inherited profiles are tagged with
  `inherited: true` (already set by the REST API).
- **read**: Works for both project and inherited profiles.
- **update/delete**: If the target profile is inherited (`inherited: true`),
  the tool returns a descriptive error BEFORE calling the API:
  ```json
  {
    "success": false,
    "error": {
      "code": "INHERITED_PROFILE",
      "message": "This is a workspace-level auth profile. It can only be modified in Settings > Auth Profiles."
    }
  }
  ```
- **validate**: Works for both project and inherited profiles (the validate
  endpoint accepts both).

The LLM prompt guidance instructs the integration-methodologist to explain
inherited profiles and suggest creating a project-level copy if modifications
are needed.

### Defaults

| Field            | Default     | Notes                                            |
| ---------------- | ----------- | ------------------------------------------------ |
| `scope`          | `'project'` | Arch-created profiles are project-scoped         |
| `visibility`     | `'shared'`  | Visible to all project members                   |
| `connectionMode` | `'shared'`  | Exception: `oauth2_app` defaults to `'per_user'` |
| `status`         | `'active'`  | Set by REST API                                  |
| `environment`    | `null`      | No environment pinning                           |

## Wiring Changes

### guards.ts

```typescript
// ACTION_TO_PERMISSION — new entry
auth_ops: {
  read: 'auth_profile:read',
  list: 'auth_profile:read',
  create: 'auth_profile:write',
  update: 'auth_profile:write',
  delete: 'auth_profile:delete',
  validate: 'auth_profile:write',  // validate can make outbound requests
},

// DANGEROUS_ACTIONS — new entry
auth_ops: ['delete'],
```

### message/route.ts — `buildInProjectTools()`

Register two new tools in the return block:

```typescript
auth_ops: tool({
  description: 'Create, read, update, delete, list, or validate auth profiles...',
  inputSchema: z.object({ /* AuthOpsInput schema */ }),
  execute: async (input) => {
    const { executeAuthOps } = await import('@/lib/arch-ai/tools/auth-ops');
    return executeAuthOps(input, permCtx);
    // auth-ops.ts imports consumeFlowSecrets directly from secret-store.ts
  },
}),

collect_secret: tool({
  description: 'Collect a sensitive credential from the user via a secure masked input. The value is never sent to the model.',
  inputSchema: z.object({
    flowId: z.string().describe('Flow ID from the auth_ops needsSecrets response'),
    field: z.string().describe('Secret field name (e.g., clientSecret, apiKey)'),
    label: z.string().describe('Human-readable label shown to the user'),
  }),
  // NO execute — client-side tool
}),
```

### message/route.ts — `IN_PROJECT_SPECIALIST_TOOL_MAP`

**This is critical.** The message route filters tools per-specialist via
`IN_PROJECT_SPECIALIST_TOOL_MAP` at line 713. Tools not listed for a specialist
are deleted from `vercelTools` before the LLM call. Both `auth_ops` and
`collect_secret` must be added to the `integration-methodologist` entry:

```typescript
'integration-methodologist': [
  'read_agent',
  'propose_modification',
  'apply_modification',
  'dismiss_proposal',
  'compile_abl',
  'ask_user',
  'project_config',
  'auth_ops',         // NEW
  'collect_secret',   // NEW
],
```

### message/route.ts — `processInProjectMessage()`

Two changes:

1. **Secret store population:** When `msg.type === 'tool_answer'` and
   `msg.secrets` is present, call `setFlowSecrets(msg.secrets.flowId, msg.secrets.values)`
   on the flow-scoped secret store BEFORE processing the tool answer normally.

2. **System prompt:** Add auth_ops and collect_secret to the IN_PROJECT capabilities
   list (composed via `composeInProjectPrompt` from `packages/arch-ai`):

```
- auth_ops: Create, read, update, delete, list, or validate auth profiles (OAuth, API Key, Bearer)
- collect_secret: Collect sensitive credentials from the user without exposing them to the model
```

### packages/arch-ai/src/types/tools.ts — Tool Registry

Three changes needed in the shared tool-registry contract:

1. **`ToolName` union:** Add `'auth_ops'` and `'collect_secret'` to the type union (line 10).
   Without this, TypeScript rejects these tool names in any typed context.

2. **`IN_PROJECT_TOOLS` array:** Add `'auth_ops'` and `'collect_secret'` (line 64).
   `getToolsForInProject()` filters against this list. If the tools aren't here,
   they get stripped before reaching the specialist executor.

3. **`CLIENT_SIDE_TOOLS` array:** Add `'collect_secret'` (line 91).
   `isClientSideTool()` checks this. Without it, the executor tries to run
   `collect_secret` server-side and fails (it has no execute function).

### packages/arch-ai/src/prompts/phases/in-project.ts — Global Capabilities

The IN_PROJECT phase prompt at line 10 has a hard-coded **Available tools** list
and a **Capabilities** section. Both must include the new tools:

**Available tools line:** Add `auth_ops, collect_secret` to the tool list.

**Capabilities section:** Add:

```
- Create and manage auth profiles for tool integrations (auth_ops)
- Collect sensitive credentials securely without exposing to model (collect_secret)
```

This is the global prompt that ALL in-project specialists receive. The per-specialist
filtering happens separately in `IN_PROJECT_SPECIALIST_TOOL_MAP`.

## Cache Invalidation

`platform_context.list_auth_profiles` uses a 5-minute TTL cache in
`platform-context.ts` (via `projectCache`). After any mutating auth_ops action
(`create`, `update`, `delete`), the tool must invalidate the cached entry.

**Reuse the existing helper** in `apps/studio/src/lib/arch-ai/tools/cache-invalidation.ts`.
The `invalidateProjectCaches(tenantId, projectId)` function already invalidates
`list_auth_profiles` (line 33) along with other project-scoped cache keys.

```typescript
import { invalidateProjectCaches } from './cache-invalidation';
// After successful create/update/delete:
invalidateProjectCaches(ctx.user.tenantId, ctx.projectId);
```

No new export needed — the existing function handles it.

## Integration Methodologist Prompt

**File**: `packages/arch-ai/src/prompts/specialists/integration-methodologist.ts`

### New Tools Section Entry

```
7. **auth_ops** — Create, read, update, delete, list, or validate auth profiles.
8. **collect_secret** — Collect sensitive credentials (passwords, tokens, client secrets) from the user via a secure masked input.
```

Note: `platform_context` is NOT available in the message route's `buildInProjectTools()`.
The prompt instructs the LLM to use `auth_ops action:"list"` for listing existing profiles.

### New Section: Auth Profile Management Workflow

```
## Auth Profile Management Workflow

When a user needs authentication for a tool integration:

1. CHECK EXISTING: Call auth_ops action:"list" first.
   If a suitable profile exists, suggest reusing it.
   Inherited (workspace-level) profiles are marked inherited:true — these
   are read-only from the project context.

2. RECOMMEND AUTH TYPE:
   - REST API with static key -> api_key
   - REST API with bearer token -> bearer
   - User-scoped OAuth (Salesforce, Google, etc.) -> oauth2_app
   - Machine-to-machine OAuth (server credentials) -> oauth2_client_credentials

3. COLLECT CONFIG conversationally:
   - For api_key: ask which header name (default X-API-Key)
   - For oauth2_app: ask for authorization URL, token URL, scopes
   - For oauth2_client_credentials: ask for token URL, scopes
   - Use ask_user with SingleSelect for common providers with allowCustom:true

4. COLLECT SECRETS via collect_secret (one call per secret):
   - For api_key: collect_secret(field:"apiKey", label:"API Key")
   - For bearer: collect_secret(field:"token", label:"Bearer Token")
   - For oauth2_app: collect_secret(field:"clientId", ...) then collect_secret(field:"clientSecret", ...)
   - For oauth2_client_credentials: same as oauth2_app
   - NEVER ask for secrets via ask_user or plain text
   - NEVER reference secret values in your responses

5. CREATE: Call auth_ops action:"create" with config (secrets auto-injected from secure store)

6. VALIDATE: Call auth_ops action:"validate" to test the profile works
   - For oauth2_client_credentials, this attempts a real token exchange
   - For other types, validates config completeness and profile status

7. BIND: Help the user reference the new auth profile in their tool's
   AUTH section via propose_modification on the agent's ABL code

SECURITY RULES:
- ONLY use collect_secret for credentials — never ask_user or plain text
- Never log, display, or reference secret values in responses
- Never suggest hardcoding secrets in ABL code — always use auth_profile_ref
- If a user pastes a secret in plain chat, warn them and suggest rotating it
- Inherited workspace profiles are read-only — suggest creating a project copy if edits needed
```

## Content Router

No changes needed. `packages/arch-ai/src/coordinator/content-router.ts` already
routes auth-related keywords (`/\boauth/i`, `/\bauth.profile/i`, `/\bjit.auth/i`,
etc.) to `integration-methodologist`.

## Error Handling

| Scenario                 | REST Response        | Tool Behavior                                                               |
| ------------------------ | -------------------- | --------------------------------------------------------------------------- |
| Duplicate profile name   | 409                  | `{ code: 'DUPLICATE_NAME', message }` — LLM suggests different name         |
| Unsupported auth type    | N/A (pre-validated)  | `{ code: 'UNSUPPORTED_TYPE', message }` — reject before API call            |
| SSRF-blocked URL         | 400                  | Pass through API error message for LLM to explain                           |
| Missing authToken        | N/A                  | `{ code: 'AUTH_REQUIRED', message }` — fail fast                            |
| Missing required fields  | N/A (pre-validated)  | `{ code: 'MISSING_PARAM', message: '<field> required for <authType>' }`     |
| Profile in use (delete)  | 409 (PROFILE_IN_USE) | Pass through consumer list so LLM can explain what depends on it            |
| oauth2_token type        | 400                  | `{ code: 'SYSTEM_MANAGED', message }` — auto-created by OAuth flow          |
| Inherited profile mutate | N/A (pre-validated)  | `{ code: 'INHERITED_PROFILE', message }` — reject before API call           |
| Validation failure       | 200 (valid: false)   | Pass through `{ valid, latencyMs, message }` — LLM explains what failed     |
| Secrets not collected    | N/A                  | `{ needsSecrets: true, requiredSecrets: [...] }` — LLM calls collect_secret |

## Files Changed

| File                                                                    | Change                                                                                       |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `apps/studio/src/lib/arch-ai/tools/auth-ops.ts`                         | **New file** — tool executor with translation layer                                          |
| `apps/studio/src/lib/arch-ai/tools/secret-store.ts`                     | **New file** — hybrid Redis/in-memory flow-scoped secret store                               |
| `apps/studio/src/components/arch-v3/widgets/SecretInput.tsx`            | **New file** — password-masked input widget for collect_secret                               |
| `apps/studio/src/app/api/arch-ai/message/route.ts`                      | Register auth_ops + collect_secret in `buildInProjectTools()`                                |
| `apps/studio/src/app/api/arch-ai/message/route.ts`                      | Add both tools to `IN_PROJECT_SPECIALIST_TOOL_MAP['integration-methodologist']`              |
| `apps/studio/src/app/api/arch-ai/message/route.ts`                      | Populate secret store from `msg.secrets` in `processInProjectMessage()`                      |
| `packages/arch-ai/src/types/message-request.ts`                         | Add optional `secrets` field (with `flowId` + `values`) to `tool_answer` variant             |
| `packages/arch-ai/src/types/tools.ts`                                   | Add `'auth_ops'` + `'collect_secret'` to `ToolName`, `IN_PROJECT_TOOLS`, `CLIENT_SIDE_TOOLS` |
| `packages/arch-ai/src/prompts/phases/in-project.ts`                     | Add auth_ops + collect_secret to Available tools list and Capabilities section               |
| `packages/arch-ai/src/prompts/specialists/integration-methodologist.ts` | Add auth_ops + collect_secret tool refs + auth workflow guidance                             |
| `apps/studio/src/lib/arch-ai/guards.ts`                                 | Add `auth_ops` to `ACTION_TO_PERMISSION` and `DANGEROUS_ACTIONS`                             |
| `apps/studio/src/hooks/useArchChat.ts`                                  | Extend `sendToolAnswer()` to accept optional `secrets` param with flowId                     |
| `apps/studio/src/components/arch-v3/widgets/WidgetRenderer.tsx`         | Add `collect_secret` rendering branch + answered summary                                     |
| `apps/studio/src/components/arch-v3/widgets/types.ts`                   | Add `SecretInputInput` type to `WidgetInput` union                                           |

## Testing Strategy

### Unit Tests (`auth-ops.test.ts`)

1. **Translation layer**: Verify LLM input -> REST payload mapping for each auth type
   - `scopes` -> `defaultScopes` for oauth2_app
   - `clientId` placed in secrets, not config
   - Auto-injected fields (projectId, scope, visibility)
2. **Field validation**: Missing required config fields return correct `needsSecrets` / `MISSING_PARAM`
3. **Auth type allowlist**: Unsupported types (e.g., `saml`) rejected before API call
4. **Inherited profile guard**: Update/delete on `inherited: true` profiles returns `INHERITED_PROFILE`
5. **Error mapping**: REST 409 (duplicate name) and 409 (profile in use) correctly mapped

### Integration Tests

1. **Create flow**: Mock fetch to verify POST payload matches `CreateAuthProfileSchema` contract
2. **Validate flow**: Mock fetch to verify POST to `/validate` endpoint, verify response mapping
3. **Cache invalidation**: Verify `invalidateProjectCaches()` called after create/update/delete
4. **Secret store lifecycle (success)**: Verify secrets accumulate by `flowId` across multiple
   `tool_answer` requests, are consumed by `auth_ops` create, and deleted from store after success
5. **Secret store lifecycle (failure)**: Verify `consumeFlowSecrets` deletes secrets even when the
   REST API call fails — subsequent `auth_ops` with the same `flowId` returns null, forcing a new flow
6. **Secret store isolation**: Verify two concurrent flows (different `flowId`s) in the same session
   do not contaminate each other — consuming one leaves the other intact
7. **Secret store TTL**: Verify secrets evict after 15 minutes without consumption
8. **MessageRequestSchema**: Verify `tool_answer` with `secrets` field passes validation;
   verify `secrets` field is stripped from persisted messages and LLM context
9. **Tool map filtering**: Verify `auth_ops` and `collect_secret` are present in
   `IN_PROJECT_SPECIALIST_TOOL_MAP['integration-methodologist']` and absent from other specialists

### Manual E2E Verification

1. SA creates API key profile via Arch chat — secret collected via masked input, not visible in chat
2. SA creates OAuth2 app profile — two secrets collected (clientId, clientSecret)
3. SA validates the profile — sees valid/invalid with latency
4. SA attempts to edit an inherited tenant profile — gets clear "read-only" message
5. SA deletes a profile in use — sees consumer list
6. Verify `platform_context.list_auth_profiles` cache refreshes after create

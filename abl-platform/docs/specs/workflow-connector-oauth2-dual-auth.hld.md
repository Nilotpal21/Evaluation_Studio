# HLD: Workflow Connector OAuth2 Dual-Auth (Jira, Zendesk, ServiceNow)

**Feature Spec**: `docs/features/workflow-connector-oauth2-dual-auth.md`
**Test Spec**: `docs/testing/workflow-connector-oauth2-dual-auth.md`
**Feature ID**: F100
**Status**: DRAFT
**Author**: Jayanth Edam
**Date**: 2026-04-20

---

## 1. Problem Statement

Jira Cloud, Zendesk, and ServiceNow are present in the connector catalog but show an **"Unsupported"** badge in the Studio Integrations UI. No auth profile can be created, no connection can be established, and no workflow step can use them.

Root cause (dual):

1. All three AP pieces use `PieceAuth.CustomAuth` → `authType: 'custom'` in `connector-catalog.json` → `buildIntegrationProviders()` in `integration-provider-service.ts` excludes `'custom'` from `availableAuthTypes` (lines 274–280), producing an empty list → "Unsupported" badge.
2. Even if `availableAuthTypes` is non-empty, `normalizeAuthForAP()` in `context-translator.ts` only handles `apiKey → secret_text` — it cannot bridge OAuth2 tokens or subdomain-specific credentials to the shapes each AP piece expects at runtime.

The fix requires patching all three AP pieces to accept Bearer token auth (and replacing `CustomAuth` field names to match our normalized shapes), extending `normalizeAuthForAP()` to be connector-aware, and wiring both the action execution path and the polling trigger execution path to use the normalized auth.

---

## 2. Alternatives Considered

### Option A: Patch AP Pieces + Extend normalizeAuthForAP (Recommended)

- **Description**: Use `pnpm patch` to modify installed AP piece files in-place. Commit `.patch` files that are re-applied on every `pnpm install`. Extend `normalizeAuthForAP()` with connector-keyed dispatch.
- **Pros**: No fork maintenance. Patches are minimal diffs (auth section only). Single seam (`normalizeAuthForAP`) for all translation logic. Follows existing Shopify/GitHub patterns. Rollback is one `package.json` change + `pnpm install`.
- **Cons**: Patches break silently on AP piece version upgrades — need CI to verify patch application. First use of `patchedDependencies` in this repo.
- **Effort**: M

### Option B: Fork AP Pieces into Monorepo Workspace Packages

- **Description**: Copy `@activepieces/piece-jira-cloud`, `@activepieces/piece-zendesk`, `@activepieces/piece-service-now` into `packages/connectors/pieces/` as local workspace packages with our modifications baked in.
- **Pros**: Full control. No patch-application risk on version bumps. TypeScript source editable directly.
- **Cons**: Loses upstream bug fixes and feature updates automatically. Requires maintaining 3 additional packages indefinitely. Significantly higher ongoing maintenance burden. Repo size increases.
- **Effort**: L

### Option C: Connector-Level Auth Adapter (No Patching)

- **Description**: Keep AP piece auth definitions as-is. Instead of patching, intercept at `translateActionContext()` and pre-construct a synthetic auth object that satisfies the _existing_ AP piece CustomAuth field names (e.g., passing `{ email, token, subdomain }` for Zendesk by deriving `email` from connectionConfig and using `access_token` as `token`).
- **Pros**: No patching needed.
- **Cons**: Fragile — depends on AP piece internal field conventions. Zendesk's existing `email/token/subdomain` BasicAuth shape cannot be satisfied from an OAuth2 profile (no email in the OAuth2 credentials). ServiceNow needs `username/password` — OAuth2 has no equivalent. Dead on arrival for Jira (needs cloud-id-based URL, impossible without patching `sendJiraRequest`).
- **Effort**: S (but does not achieve the goal)

### Recommendation: Option A

**Rationale**: Option A is the only approach that achieves full OAuth2 support without forking. The patch file pattern is already supported by pnpm and is the industry standard for this use case (Next.js, Prisma, and many other ecosystems use it). The maintenance risk (patch failure on version bump) is mitigated by CI verification. Option B's ongoing maintenance cost is too high for 3 external packages. Option C cannot deliver OAuth2 for any of the three connectors.

---

## 3. Architecture

### System Context Diagram

```
┌──────────────────────────────────────────────────────────────┐
│  Studio (Next.js)                                            │
│                                                              │
│  IntegrationProviders API → buildIntegrationProviders()      │
│    ↓ reads connector-catalog.json + Nango providers.json     │
│    ↓ returns availableAuthTypes: ['oauth2', 'api_key']       │
│                                                              │
│  Auth Profile Creation → POST /api/auth-profiles             │
│    ↓ stores encrypted { access_token } or { apiKey }         │
└───────────────────────────┬──────────────────────────────────┘
                            │
                            ▼  HTTP API (Workflow Engine)
┌──────────────────────────────────────────────────────────────┐
│  Workflow Engine (Express)                                    │
│                                                              │
│  POST /api/connectors/execute                                │
│    ↓ ConnectorToolExecutor.execute(toolName, params)         │
│    ↓ ConnectionResolver.resolveAuth(authProfileId)            │
│    ↓ normalizeAuthForAP(connectorName, rawAuth)  ← NEW       │
│    ↓ action.run(apCtx)  [patched AP piece]        ← PATCHED  │
│                                                              │
│  BullMQ Worker: processPollingJob()                          │
│    ↓ authResolver.resolveConnectionAuth()                    │
│    ↓ normalizeAuthForAP(connectorName, rawAuth)  ← NEW       │
│    ↓ trigger.run(ctx)  [patched AP piece]         ← PATCHED  │
└───────────────────────────┬──────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  packages/connectors (shared library)                        │
│                                                              │
│  ConnectorRegistry                                           │
│   └─ loads @activepieces/piece-jira-cloud (PATCHED)          │
│   └─ loads @activepieces/piece-zendesk (PATCHED)             │
│   └─ loads @activepieces/piece-service-now (NEW + PATCHED)   │
│                                                              │
│  context-translator.ts                                       │
│   └─ normalizeAuthForAP(connectorName, auth) ← KEY CHANGE    │
│       ├─ 'jira-cloud'   → OAuth2 top-level pass-through      │
│       ├─ 'zendesk'      → { props: { subdomain, accessToken }}│
│       └─ 'servicenow'   → { props: { instanceUrl, accessToken}}│
│                                                              │
│  catalog/extract-entry.ts                                    │
│   └─ NANGO_SECONDARY_PROVIDERS['zendesk'] += 'zendesk-api-key'│
│   └─ NANGO_SECONDARY_PROVIDERS['servicenow'] += 'sn-api-key' │
└───────────────────────────┬──────────────────────────────────┘
                            │ pnpm install (applies patches)
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  node_modules/@activepieces/piece-*  (patched)               │
│                                                              │
│  piece-zendesk:     zendeskAuth.props = { subdomain,         │
│                       accessToken }  (replaces email, token) │
│  piece-jira-cloud:  jiraCloudAuth = PieceAuth.OAuth2(...)    │
│                       (replaces CustomAuth)                  │
│  piece-service-now: servicenowAuth.props = { instanceUrl,    │
│                       accessToken }  (replaces user, pwd)    │
└──────────────────────────────────────────────────────────────┘
```

### Component Diagram

```
context-translator.ts
┌───────────────────────────────────────────────────────────┐
│ normalizeAuthForAP(connectorName: string,                  │
│                   auth: Record<string, unknown>)           │
│                   : Record<string, unknown>                │
│                                                            │
│  switch(connectorName):                                    │
│    'jira-cloud'  → pass-through (PieceAuth.OAuth2 top-lvl) │
│    'zendesk'     → { props: { subdomain, accessToken } }   │
│    'servicenow'  → { props: { instanceUrl, accessToken } } │
│    default       → existing fallback (apiKey→secret_text)  │
└──────────────────────┬─────────────────────────────────────┘
                       │ called by
         ┌─────────────┴──────────────────┐
         ▼                                ▼
translateActionContext()          processPollingJob()
(ConnectorToolExecutor path)      (BullMQ polling trigger path)
```

### Data Flow: Action Execution

```
1. Studio POST /api/connectors/execute
   { connectorName: 'zendesk', actionName: 'create_ticket',
     authProfileId: 'ap-123', params: { subject: '...' } }

2. ConnectorToolExecutor.execute('zendesk.create_ticket', params)
   ↓
3. ConnectionResolver.resolveAuth('ap-123', tenantId)
   → decrypts AuthProfile.encryptedSecrets
   → returns { access_token: 'zd-tok', connection: { connectionConfig: { subdomain: 'acme' } } }
   ↓
4. normalizeAuthForAP('zendesk', rawAuth)
   → { props: { subdomain: 'acme', accessToken: 'zd-tok' } }
   ↓
5. translateActionContext(ctx with normalized auth)
   → APActionContext { auth: { props: ... }, propsValue: {...} }
   ↓
6. zendeskAction.run(apCtx)
   → reads apCtx.auth.props.subdomain → base URL
   → reads apCtx.auth.props.accessToken → Bearer header
   → POST https://acme.zendesk.com/api/v2/tickets.json
   → returns { ticket: { id: 42 } }
```

### Data Flow: Polling Trigger

```
1. BullMQ fires poll-trigger job for Zendesk 'new_ticket' trigger

2. processPollingJob(job, deps)
   ↓
3. deps.authResolver.resolveConnectionAuth({ connectionId, tenantId, projectId })
   → returns raw { access_token: 'zd-tok', connection: { connectionConfig: { subdomain: 'acme' } } }
   ↓
4. normalizeAuthForAP('zendesk', rawAuth)   ← NEW: was missing
   → { props: { subdomain: 'acme', accessToken: 'zd-tok' } }
   ↓
5. trigger.run({ auth: normalizedAuth, tenantId, store, ... })
   → Zendesk new_ticket trigger uses auth.props.subdomain + auth.props.accessToken
   → fetches recently created tickets, deduplicates, fires workflow per new ticket
```

### Sequence Diagram: normalizeAuthForAP Call Sites

```
                    translateActionContext()     processPollingJob()
                            |                          |
                            | normalizeAuthForAP(      |
                            |   connectorName,         |
                            |   rawAuth)               |
                            |__________________________|
                                         |
                                 context-translator.ts
                                   normalizeAuthForAP()
                                         |
                              ┌──────────┼──────────────┐
                         jira-cloud   zendesk     servicenow
                              |          |              |
                         pass-through  {props}       {props with
                         access_token   subdomain+    instanceUrl}
                                        accessToken
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | Auth profiles are tenant-scoped. `ConnectionResolver.resolveAuth()` enforces `findOne({ _id, tenantId })` — no change needed. Cross-tenant `authProfileId` lookup returns null → HTTP 404. `processPollingJob()` passes `tenantId` through all DB lookups.                                                                                                                             |
| 2   | **Data Access Pattern** | No new data access. Auth profile decryption uses existing `ConnectionResolver` + `EncryptionService` pipeline. `normalizeAuthForAP()` is a pure function — no DB access.                                                                                                                                                                                                               |
| 3   | **API Contract**        | No new REST endpoints. Internal contract change: `normalizeAuthForAP(auth)` → `normalizeAuthForAP(connectorName, auth)`. Two call sites updated: `translateActionContext()` (passes `ctx.connectorName`) and `processPollingJob()` (passes `job.connectorName`). Backward compatibility: `default` branch preserves existing `apiKey → secret_text` fallback for all other connectors. |
| 4   | **Security Surface**    | OAuth2 `access_token` and `apiKey` values must never appear in logs. `normalizeAuthForAP()` must not log `auth` object. The existing `createLogger` redaction is in place for `ConnectorToolExecutor`. AP piece patches must not introduce `console.log` (blocked by pre-commit hook). Error messages for missing `subdomain` must reference field names only, not credential values.  |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | Missing `subdomain` in `normalizeAuthForAP()` throws `ConnectorError` with message referencing `subdomain` — not a generic 500. Expired OAuth2 token → AP piece gets HTTP 401 from Zendesk/Jira/ServiceNow → `action.run()` throws → `ConnectorToolExecutor` propagates as `{ success: false, error: { code: 'ACTION_FAILED', message: '...' } }`. Jira cloudId fetch returning empty array → `action.run()` throws `ConnectorError('No accessible Jira instances found')`. |
| 6   | **Failure Modes** | pnpm patch fails to apply → build fails at `pnpm install` step (CI catches this). AP piece not installed → `ConnectorRegistry.loadConnectors()` throws on startup → service fails health check. Token expired during execution → HTTP 401 from upstream → surfaces to workflow as connection error. `normalizeAuthForAP()` wrong branch → action gets wrong auth shape → HTTP 401/422 from upstream (clear failure, not silent).                                            |
| 7   | **Idempotency**   | Connector actions (create_ticket, create_issue, create_record) are NOT idempotent by nature — the AP piece owns idempotency semantics. Workflow engine handles retry logic at the workflow step level. Polling trigger deduplication is already handled by `deduplicateItems()` in `polling-scheduler.ts` using content hashing.                                                                                                                                            |
| 8   | **Observability** | Existing `tracer.startActiveSpan('connector.execute')` in `ConnectorToolExecutor` emits spans with `connector.name`, `action.name`, `tenant.id`. Auth resolution errors surface via existing `span.setStatus(SpanStatusCode.ERROR)` path. No new trace events needed. Polling trigger errors logged via `log.error('Polling trigger error', ...)` already in `processPollingJob()`.                                                                                         |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 9   | **Performance Budget** | Zendesk/ServiceNow: Bearer token = header swap, zero extra latency vs Basic auth. Jira OAuth2: one extra HTTP call to `GET /oauth/token/accessible-resources` per action (~50–100ms). Mitigated: AP piece caches `cloudId` in `ctx.store` (per-execution KV, key: `jira_cloud_id`) — single call per execution even for multi-action workflows. `normalizeAuthForAP()` is O(1) synchronous — no latency contribution.                                                                                                                                                                                  |
| 10  | **Migration Path**     | No data migration. Feature is additive — deploying it enables the 3 connectors without touching existing auth profiles or connections. Existing auth profiles for other connectors are unaffected (default branch in `normalizeAuthForAP()` preserves backward compatibility).                                                                                                                                                                                                                                                                                                                         |
| 11  | **Rollback Plan**      | Remove `patchedDependencies` block from `packages/connectors/package.json` → run `pnpm install` → AP pieces revert to original. ServiceNow entry in `loader.ts` PIECE_PACKAGES can be commented out. `normalizeAuthForAP()` change has a default fallback that preserves existing behavior — even if not rolled back, other connectors are unaffected. No database changes to revert. Full rollback via single `package.json` change + `pnpm install` + `git revert`.                                                                                                                                  |
| 12  | **Test Strategy**      | Unit: `normalizeAuthForAP()` pure-function tests for all 6 branches (no mocks, no infra). Integration: Real `ConnectorRegistry` + `MongoMemoryServer` for catalog loading, executor chain, and polling trigger auth. E2E: Real Express server on `{ port: 0 }`, auth profiles seeded via HTTP API, actions executed via HTTP API. No `vi.mock()` of codebase components. Coverage targets: 100% branch coverage on `normalizeAuthForAP()`, integration tests for catalog + trigger auth, E2E for all 3 connectors × OAuth2 path. See test spec: `docs/testing/workflow-connector-oauth2-dual-auth.md`. |

---

## 5. Data Model

### New Collections / Tables

None. No new collections required.

### Modified Collections / Tables

None. Existing `connections` and `authProfiles` collections are unchanged. The `connectionConfig.subdomain` field is an existing pattern (used by Shopify). No schema changes needed.

```text
connections (existing, no schema change)
  connectionConfig.subdomain: string  — already supported via Mixed field
  connectionConfig.instanceUrl: string — already supported (Jira legacy field, unused post-patch)
```

### Key Relationships

```
AuthProfile.encryptedSecrets (decrypted)
  OAuth2:   { access_token, refresh_token, token_type, scope, ... }
  API key:  { apiKey: string }

Connection.connectionConfig
  Zendesk:     { subdomain: 'acme' }      — must be provided during OAuth setup
  ServiceNow:  { subdomain: 'dev12345' }   — must be provided during OAuth setup
  Jira:        {}                           — no connectionConfig needed (cloudId resolved at runtime)

normalizeAuthForAP(connectorName, { ...AuthProfile.encryptedSecrets,
                                    connection.connectionConfig })
  → AP piece auth shape:
    Zendesk:     { props: { subdomain, accessToken } }
    Jira:        { access_token, token_type, scope, ... }   (top-level pass-through)
    ServiceNow:  { props: { instanceUrl: 'https://<subdomain>.service-now.com', accessToken } }
```

---

## 6. API Design

### New Endpoints

None. No new REST endpoints.

### Modified Endpoints

None. Existing `/api/connectors/execute` and `/api/connectors/triggers/register` endpoints are unchanged in their HTTP contract. The behavioral change (new connectors now working) is internal.

### Internal Contract Change

`normalizeAuthForAP()` signature change — this is internal to `packages/connectors`:

```typescript
// Before:
export function normalizeAuthForAP(auth: Record<string, unknown>): Record<string, unknown>;

// After:
export function normalizeAuthForAP(
  connectorName: string,
  auth: Record<string, unknown>,
): Record<string, unknown>;
```

**Callers to update:**

| File                                                                  | Line                                 | Change                                                                        |
| --------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------- |
| `packages/connectors/src/adapters/activepieces/context-translator.ts` | `translateActionContext()` line ~119 | Pass `ctx.connectorName` as first arg                                         |
| `packages/connectors/src/triggers/polling-scheduler.ts`               | `processPollingJob()` line ~157      | Add `normalizeAuthForAP(job.connectorName, auth)` call before `trigger.run()` |

**`ActionContext` already carries `connectorName`** — confirmed via grep of `connector-tool-executor.ts`.

### Error Responses

New error conditions and HTTP status codes:

| Condition                                                 | HTTP Status | `error.code`               | `error.message`                                                                                                |
| --------------------------------------------------------- | ----------- | -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Missing `connectionConfig.subdomain` (Zendesk/ServiceNow) | 422         | `CONNECTOR_AUTH_ERROR`     | `'Zendesk connector requires connectionConfig.subdomain — provide the subdomain during auth profile creation'` |
| Jira `accessible-resources` returns empty array           | 422         | `CONNECTOR_ACTION_FAILED`  | `'No accessible Jira Cloud instances found for this OAuth2 token'`                                             |
| `authProfileId` not found for tenant                      | 404         | `AUTH_PROFILE_NOT_FOUND`   | `'Auth profile not found'`                                                                                     |
| Expired OAuth2 token (upstream 401)                       | 502         | `CONNECTOR_UPSTREAM_ERROR` | `'Connector returned HTTP 401 — token may be expired, try re-authorizing'`                                     |

---

## 7. Cross-Cutting Concerns

### Audit Logging

No new audit events. Existing `TraceEvent` emission in `ConnectorToolExecutor` covers auth resolution, action execution, and errors. Auth profile creation/deletion are already logged by the auth-profiles service.

### Rate Limiting

No new rate limiting. AP piece actions are already subject to the Workflow Engine's per-tenant action rate limits. Jira/Zendesk/ServiceNow have their own API rate limits — the AP pieces are responsible for handling 429 responses (out of scope for this feature).

### Caching

Jira cloudId is cached in `ctx.store` (per-execution KV) with key `jira_cloud_id` — avoids repeated `GET /oauth/token/accessible-resources` calls within a single execution. This is per-execution only; persistent cross-execution caching is deferred (GAP-002).

### Encryption

No new encryption. OAuth2 tokens and API keys are stored via the existing AES-256-GCM AuthProfile encryption pipeline. `normalizeAuthForAP()` reads decrypted secrets (already in memory at call time) and constructs a new object — no additional encryption/decryption.

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                                                        | Type                        | Risk                                                            |
| ----------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------- |
| `@activepieces/piece-jira-cloud@0.2.6`                            | npm package (patched)       | Medium — patch must re-apply on version bump                    |
| `@activepieces/piece-zendesk@0.2.7`                               | npm package (patched)       | Medium — patch must re-apply on version bump                    |
| `@activepieces/piece-service-now@0.1.3`                           | npm package (new + patched) | High — early version, action inventory unverified (GAP-004)     |
| `packages/connectors/src/auth/connection-resolver.ts`             | internal                    | Low — no changes to resolver                                    |
| `packages/connectors/src/adapters/nango/generated/providers.json` | generated artifact          | Low — zendesk + servicenow providers exist, OAuth2 URLs present |
| `NANGO_ALIAS_MAP` in `extract-entry.ts`                           | internal constant           | Low — `jira-cloud: 'jira'` already present                      |

### Downstream (depends on this feature)

| Consumer                                     | Impact                                                            |
| -------------------------------------------- | ----------------------------------------------------------------- |
| Workflow Engine — connector action execution | Now able to execute Jira/Zendesk/ServiceNow actions via OAuth2    |
| Workflow Engine — polling triggers           | Now able to run Jira/Zendesk/ServiceNow triggers with OAuth2 auth |
| Studio — Integrations catalog                | Three connectors change from "Unsupported" to "Available"         |
| Studio — auth profile creation flow          | OAuth2 and API key options appear for all 3 connectors            |

---

## 9. Open Questions & Decisions Needed

1. **GAP-001: api_key surfacing for Zendesk and ServiceNow**: No `zendesk-api-key` or `servicenow-api-key` Nango provider configs exist in `providers.json`. Options: (a) Add virtual provider configs to `providers.json` with `authMode: 'api_key'`, (b) Add a new `CATALOG_API_KEY_CONNECTORS` constant in `extract-entry.ts` that lists connectors that support API key without a Nango secondary provider, (c) defer api_key for Zendesk/ServiceNow to a follow-up. Decision needed before implementation.

2. **Jira subdomain**: Current Jira `CustomAuth` stored `instanceUrl` (e.g., `https://company.atlassian.net`). After switching to `PieceAuth.OAuth2`, the cloud-specific URL is derived from `accessible-resources`. Does the existing Jira auth profile creation flow in Studio need any update to remove the `instanceUrl` field from the connectionConfig form? If Jira connections already store `instanceUrl`, do we need a migration or graceful fallback? (Likely no migration — OAuth2 flow won't use it, legacy field is just ignored.)

3. **pnpm patch placement**: Should patch files live in workspace root `patches/` or in `packages/connectors/patches/`? pnpm resolves `patchedDependencies` relative to the package that declares them. Since AP pieces are deps of `packages/connectors`, `patchedDependencies` goes in `packages/connectors/package.json` and patches should live in `packages/connectors/patches/`. Confirm this is correct before creating the first patch.

4. **ServiceNow action inventory verification**: `@activepieces/piece-service-now@0.1.3` may have different action names than assumed in the feature spec. Must verify actual action names (`createRecord`, `create_record`, etc.) after `pnpm install` before writing tests.

---

## 10. References

- Feature spec: `docs/features/workflow-connector-oauth2-dual-auth.md`
- Test spec: `docs/testing/workflow-connector-oauth2-dual-auth.md`
- Parent connector HLD: `docs/specs/connectors.hld.md`
- Auth profiles HLD: `docs/specs/auth-profiles.hld.md`
- OAuth tooling HLD: `docs/specs/oauth-tooling.hld.md`
- Integration auth profiles HLD: `docs/specs/integration-auth-profiles.hld.md`
- Key implementation files:
  - `packages/connectors/src/adapters/activepieces/context-translator.ts`
  - `packages/connectors/src/triggers/polling-scheduler.ts`
  - `packages/connectors/src/catalog/extract-entry.ts`
  - `apps/studio/src/lib/integration-provider-service.ts`

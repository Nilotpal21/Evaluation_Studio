# Feature: Workflow Connector OAuth2 Dual-Auth (Jira, Zendesk, ServiceNow)

**Doc Type**: MAJOR FEATURE
**Parent Feature**: [Connectors Platform](connectors.md)
**Feature ID**: F100
**Slug**: `workflow-connector-oauth2-dual-auth`
**Status**: PLANNED
**Feature Area(s)**: `integrations`, `agent lifecycle`, `enterprise`
**Package(s)**: `packages/connectors`, `apps/studio`
**Owner(s)**: Platform Team
**Testing Guide**: `../testing/workflow-connector-oauth2-dual-auth.md`
**Last Updated**: 2026-04-20

---

## 1. Introduction / Overview

### Problem Statement

Jira Cloud, Zendesk, and ServiceNow are among the most-requested enterprise workflow connectors on the platform. All three are present in the connector catalog but currently show an **"Unsupported"** badge in the Studio Integrations UI — meaning no auth profile can be created, no connection can be established, and no workflow step can use them.

The root cause is structural: all three AP pieces use `PieceAuth.CustomAuth`, which maps to `authType: 'custom'` in `connector-catalog.json`. The `buildIntegrationProviders()` function in `integration-provider-service.ts` explicitly excludes `'custom'` from `availableAuthTypes` (lines 269–280), treating it as a "Phase 2" connector requiring a bespoke credential form that does not yet exist. The result is that enterprise customers who want to automate Jira ticket creation, Zendesk ticket updates, or ServiceNow incident management from their agents cannot do so.

### Goal Statement

Replace the Basic/Custom auth in all three AP pieces with OAuth2 Bearer token auth (and API key as a secondary option), wire them through the existing auth-profile → Nango → normalizeAuthForAP bridge, and expose both `oauth2` and `api_key` as `availableAuthTypes` in Studio — exactly like GitHub's dual-auth pattern. A workflow builder should be able to create a Jira/Zendesk/ServiceNow auth profile in the Studio Integrations page, pick it in a workflow step, and have it work end-to-end without any additional configuration.

### Summary

This feature patches three Activepieces npm packages (`@activepieces/piece-jira-cloud`, `@activepieces/piece-zendesk`, `@activepieces/piece-service-now`) to replace Basic/Custom auth with OAuth2 Bearer token auth. It adds ServiceNow as a new AP piece dependency (currently uninstalled, exists on npm as v0.1.3), registers it in `loader.ts`, and extends `normalizeAuthForAP()` in `context-translator.ts` to bridge auth-profile credential shapes (OAuth2 `access_token` or API key `apiKey`) to the shapes each patched AP piece expects. `NANGO_SECONDARY_PROVIDERS` and/or direct catalog `authType` changes ensure Studio renders both `oauth2` and `api_key` options in the "Create Auth Profile" flow.

---

## 2. Scope

### Goals

- Patch `@activepieces/piece-zendesk` to use OAuth2 Bearer token (subdomain + accessToken) instead of Basic auth (email/token)
- Patch `@activepieces/piece-jira-cloud` to use Atlassian OAuth2 (PieceAuth.OAuth2, cloud-id-based URL) instead of CustomAuth (instanceUrl/email/apiToken)
- Add `@activepieces/piece-service-now` as a new dependency, register it in `loader.ts`, and patch it to use OAuth2 Bearer token (instanceUrl + accessToken) instead of Basic auth
- Extend `normalizeAuthForAP()` to bridge all three connectors' auth-profile credential shapes to their patched AP piece expectations
- Expose `oauth2` and `api_key` as `availableAuthTypes` for all three connectors in Studio (matching GitHub dual-auth pattern)
- Regenerate `connector-catalog.json` to reflect updated auth types

### Non-Goals (Out of Scope)

- SearchAI document sync connectors for Zendesk and ServiceNow (removed from this branch; separate feature if ever needed)
- Webhook-based triggers (all 3 connectors use POLLING triggers — no webhook wiring needed)
- Custom credential forms (Phase 2 connector-specific UX) for any other connectors currently showing "Unsupported"
- Zendesk/ServiceNow subdomain management UI — subdomain is provided by the user as a `connectionConfig` field during OAuth flow setup, using the existing Nango-backed connection config mechanism
- Token refresh orchestration beyond what the existing Nango OAuth2 refresh flow provides
- Multi-instance support (one auth profile = one Jira/Zendesk/ServiceNow instance)

---

## 3. User Stories

1. As a **workflow builder**, I want to create a Jira Cloud auth profile using OAuth2 so that I can add Jira steps (create issue, update issue, search issues) to my workflows without managing raw credentials.

2. As a **workflow builder**, I want to create a Zendesk auth profile using either OAuth2 or an API key so that I can automate ticket creation, updates, and user management from my agents.

3. As a **workflow builder**, I want to create a ServiceNow auth profile using OAuth2 so that I can trigger workflows on new incidents, create records, and update catalog items from the platform.

4. As a **platform admin**, I want all three connectors to show available auth type options (not "Unsupported") in the Studio Integrations catalog so that operators can self-serve connections without engineering involvement.

5. As a **platform admin**, I want auth profiles for these connectors to support API key auth as a fallback so that teams without OAuth2 apps configured can still connect using a service account token.

---

## 4. Functional Requirements

1. **FR-1**: The system must patch `@activepieces/piece-zendesk` so that its `zendeskAuth` definition uses `PieceAuth.CustomAuth` with `{ subdomain, accessToken }` fields (replacing `{ email, token, subdomain }`), and all action/trigger files use `Authorization: Bearer {accessToken}` instead of Basic auth.

2. **FR-2**: The system must patch `@activepieces/piece-jira-cloud` so that its `jiraCloudAuth` uses `PieceAuth.OAuth2` with Atlassian's fixed OAuth2 endpoints (`https://auth.atlassian.com/authorize`, `https://auth.atlassian.com/oauth/token`), and `sendJiraRequest` / `jiraApiCall` resolve the cloud-id-based API base URL from `GET /oauth/token/accessible-resources` using `access_token`.

3. **FR-3**: The system must add `@activepieces/piece-service-now` as a dependency in `packages/connectors/package.json`, register `['servicenow', '@activepieces/piece-service-now']` in `loader.ts`, and patch the piece so its auth definition uses `PieceAuth.CustomAuth` with `{ instanceUrl, accessToken }` fields, replacing Basic auth.

4. **FR-4**: The system must extend `normalizeAuthForAP()` in `context-translator.ts` to bridge auth-profile credential shapes to the shapes each patched AP piece expects:
   - **Zendesk OAuth2**: `auth.access_token` + `auth.connection?.connectionConfig?.subdomain` → `{ props: { subdomain, accessToken } }`
   - **Zendesk API key**: `auth.apiKey` + `connectionConfig.subdomain` → `{ props: { subdomain, accessToken: apiKey } }` (field is `accessToken` per the OAuth2 patch — same field, different source)
   - **Jira OAuth2**: pass `auth.access_token` directly (PieceAuth.OAuth2 top-level `access_token`)
   - **ServiceNow OAuth2**: `auth.access_token` + `connectionConfig.instanceUrl` (subdomain → full URL) → `{ props: { instanceUrl, accessToken } }`
   - **ServiceNow API key**: `auth.apiKey` + `connectionConfig.instanceUrl` → `{ props: { instanceUrl, accessToken: apiKey } }`

5. **FR-5**: The system must ensure `connector-catalog.json` exposes `authType: 'oauth2'` (from `PieceAuth.OAuth2`) for Jira and retains `authType: 'custom'` for Zendesk/ServiceNow (unchanged AP auth type) BUT adds these connectors to `NANGO_SECONDARY_PROVIDERS` or adjusts catalog entries such that `buildIntegrationProviders()` produces `availableAuthTypes: ['oauth2', 'api_key']` for all three in Studio.

6. **FR-6**: The system must regenerate `connector-catalog.json` after all changes and verify via `pnpm connectors:generate-catalog --check` that the file is up to date.

7. **FR-7**: The system must verify that Jira actions (create issue, update issue, find issue, get issue attachments — 15 actions), Zendesk actions (12 actions + custom API call), and ServiceNow actions (6 actions) execute successfully end-to-end when called with an OAuth2 auth profile via the `ConnectorToolExecutor` pipeline.

8. **FR-8**: The system must verify that Jira polling triggers (3), Zendesk polling triggers (8), and ServiceNow polling triggers (2) activate correctly and pass auth credentials to the AP piece trigger context. The trigger execution path in `polling-scheduler.ts` must be verified to call `normalizeAuthForAP()` (or an equivalent `translateTriggerContext()`) — if the trigger path bypasses `translateActionContext()`, a parallel normalization call must be added for the trigger context.

9. **FR-9**: The system must apply AP piece patches using `pnpm patch` workflow (`pnpm patch <pkg>` → edit → `pnpm patch-commit`), committing the resulting `.patch` files so they are re-applied on every `pnpm install` across environments.

10. **FR-10**: The system must not break any existing connectors — `pnpm build --filter=@agent-platform/connectors` must pass and the architecture-fitness test (workspace package count = 47) must remain green.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                            |
| -------------------------- | ------------ | ------------------------------------------------------------------------------------------------ |
| Project lifecycle          | NONE         | Auth profiles are tenant-scoped, not project-scoped                                              |
| Agent lifecycle            | SECONDARY    | Agents that use Jira/Zendesk/ServiceNow connector steps depend on auth profiles being resolvable |
| Customer experience        | PRIMARY      | Directly enables workflow automation for enterprise customers who use these three systems        |
| Integrations / channels    | PRIMARY      | Core: unlocks 3 connectors in the catalog                                                        |
| Observability / tracing    | NONE         | No new trace events needed; existing ConnectorToolExecutor tracing covers auth resolution        |
| Governance / controls      | SECONDARY    | Auth profiles have existing lifecycle (create, revoke, rotate) — no new governance surface       |
| Enterprise / compliance    | SECONDARY    | OAuth2 tokens stored encrypted via existing AES-256-GCM pattern; no new compliance surface       |
| Admin / operator workflows | SECONDARY    | Platform admin can create auth profiles for these connectors in Studio Integrations              |

### Related Feature Integration Matrix

| Related Feature                      | Relationship Type | Why It Matters                                                                                                                                     | Key Touchpoints                                                                                      | Current State                     |
| ------------------------------------ | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------- |
| [Auth Profiles](auth-profiles.md)    | depends on        | Auth profiles are the credential source — OAuth2 tokens and API keys are resolved from auth profile secrets via `ConnectionResolver.resolveAuth()` | `normalizeAuthForAP()` reads `auth.access_token`, `auth.apiKey`, `auth.connection?.connectionConfig` | STABLE — no changes needed        |
| [Connectors Platform](connectors.md) | extends           | This feature is a targeted enhancement to the connector catalog — 3 new usable connectors                                                          | `loader.ts` PIECE_PACKAGES, `context-translator.ts`, `connector-catalog.json`, `extract-entry.ts`    | BETA — touch loader + translator  |
| [Workflows](workflows.md)            | extends           | Workflow steps use connector actions/triggers — these connectors are currently unusable in workflows                                               | `ConnectorToolExecutor`, workflow step execution                                                     | BETA — no workflow engine changes |
| [OAuth Tooling](oauth-tooling.md)    | depends on        | Studio OAuth flow uses Nango provider configs to display connectionConfig fields (subdomain) during auth profile creation                          | `integration-provider-service.ts`, Nango providers.json                                              | ALPHA — no changes needed         |

---

## 6. Design Considerations

The auth profile creation flow in Studio already supports OAuth2 and API key profiles with `connectionConfig` fields (e.g., Shopify subdomain, GitHub PAT). Zendesk and ServiceNow follow the same pattern — the user provides their subdomain during the OAuth2 flow setup, and Nango's `connectionConfig.subdomain` template variable handles the instance-specific OAuth URLs. No new UI components are required.

Jira uses Atlassian's fixed, non-instance-specific OAuth2 endpoints (`https://auth.atlassian.com/`), so it maps cleanly to `PieceAuth.OAuth2` and needs no `connectionConfig` fields for auth — the cloud ID is resolved at runtime from the Atlassian accessible-resources API.

---

## 7. Technical Considerations

### pnpm Patch Strategy

This repo has no existing pnpm patches. The `pnpm patch` workflow will be used for the first time:

1. `pnpm patch @activepieces/piece-zendesk@0.2.7` → edit in temp dir → `pnpm patch-commit <tmp-path>`
2. Same for `@activepieces/piece-jira-cloud@0.2.6`
3. Same for `@activepieces/piece-service-now@0.1.3` (after installation)

Patch files land in `packages/connectors/patches/` (or workspace root `patches/`). They are committed and auto-applied on `pnpm install` via `patchedDependencies` in `packages/connectors/package.json`.

### normalizeAuthForAP Bridge

`normalizeAuthForAP()` in `context-translator.ts` is the single seam where auth-profile credential shapes are coerced into AP piece expectations. The current implementation only handles `apiKey → secret_text`. It needs to become connector-aware — keyed on a connector identifier passed through the `ActionContext` — to produce different shapes for Jira (OAuth2 top-level), Zendesk (CustomAuth props), and ServiceNow (CustomAuth props with instanceUrl).

The `ActionContext` already carries `connectorName` (verified via grep: `packages/connectors/src/executor/connector-tool-executor.ts`). This can be used as the dispatch key.

### Jira Cloud ID Caching

After the Jira patch, `sendJiraRequest` calls `GET /oauth/token/accessible-resources` once per request to get `cloudId`. This adds one extra HTTP round-trip per Jira action. The AP piece can cache the cloudId in `ctx.store` (key: `jira_cloud_id`) to avoid repeated lookups. The `store` is a per-execution KeyValueStore — acceptable for now; persistent cross-execution caching is a future optimization.

### Catalog authType for Zendesk/ServiceNow

After patching, Zendesk and ServiceNow AP pieces still use `PieceAuth.CustomAuth`, so `extractCatalogEntry()` will still produce `authType: 'custom'`. The `integration-provider-service.ts` already handles this: even with `authType: 'custom'`, if `hasOAuth` is true (Nango provider exists with auth URLs), `availableAuthTypes.push('oauth2')` fires. Both `zendesk` and `servicenow` have valid Nango providers with OAuth2 URLs, so `oauth2` will appear automatically. For `api_key`, the service reads `entry.authType === 'api_key'` or `nangoConfig.authMode === 'api_key'` or secondary providers. Since neither Zendesk nor ServiceNow Nango providers have `authMode: 'api_key'`, the only way to surface `api_key` is via `NANGO_SECONDARY_PROVIDERS` or by adding a secondary provider. DECIDED: add `'zendesk': ['zendesk-api-key']` and `'servicenow': ['servicenow-api-key']` as virtual secondary providers — but only if those provider configs exist in providers.json. If they don't, the api_key path must be surfaced differently (see Open Questions).

---

## 8. How to Consume

### Studio UI

**Auth Profile Creation (Integrations page → New Connection)**

1. User navigates to `Studio → Integrations → Catalog`
2. Sees Jira Cloud, Zendesk, ServiceNow with `Available` badge (not "Unsupported")
3. Clicks "Connect" → sees auth type picker: `OAuth2` / `API Key`
4. **OAuth2 path** (Jira): Standard OAuth2 3LO flow via Atlassian. No connectionConfig fields needed.
5. **OAuth2 path** (Zendesk/ServiceNow): OAuth2 flow requiring `subdomain`/`instanceUrl` as a connectionConfig field (populated via Nango's `connectionConfig` form before redirect).
6. **API key path** (all 3): User pastes API token. For Zendesk/ServiceNow, also provides subdomain/instanceUrl.

**Workflow Step Configuration**

1. User adds a workflow step → selects connector (Jira / Zendesk / ServiceNow)
2. Selects action (e.g., "Create Issue", "Create Ticket", "Create Record")
3. Selects auth profile from dropdown (shows all valid profiles for that connector)
4. Configures action parameters (dynamic dropdowns via `resolveOptions()`)
5. Workflow executes: `ConnectorToolExecutor` → `resolveAuth()` → `normalizeAuthForAP()` → AP piece action

### Surface Semantics Matrix

| Asset / Entity Type                       | Source of Truth                               | Design-Time Surface                              | Editable?                     | Consumer Reference                           | Runtime Resolution                                                 | Notes                                                                                 |
| ----------------------------------------- | --------------------------------------------- | ------------------------------------------------ | ----------------------------- | -------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| OAuth2 Auth Profile                       | Auth Profiles collection (MongoDB, encrypted) | Studio Integrations → New Connection → OAuth2    | Read-only after creation      | `authProfileId` on Connection record         | `ConnectionResolver.resolveAuth()` returns `{ access_token, ... }` | Refresh handled by existing Nango token refresh flow                                  |
| API Key Auth Profile                      | Auth Profiles collection                      | Studio Integrations → New Connection → API Key   | Read-only after creation      | `authProfileId` on Connection record         | `resolveAuth()` returns `{ apiKey: "..." }`                        | Stored encrypted; decrypted at resolution time                                        |
| Connection Config (subdomain/instanceUrl) | Connection.connectionConfig (Mixed field)     | OAuth setup wizard (Nango connectionConfig form) | Set at creation, not editable | `auth.connection.connectionConfig.subdomain` | Passed through `normalizeAuthForAP()` to AP piece props            | Zendesk uses `subdomain`, ServiceNow uses `subdomain` (full URL constructed in piece) |

### Design-Time vs Runtime Behavior

**Design-time**: Auth profile is created and validated. For OAuth2, Nango orchestrates the 3LO redirect. For API key, user pastes the token. The auth profile record is encrypted and stored. The `connector-catalog.json` (static, committed) drives what auth types are available in the UI.

**Runtime**: `ConnectorToolExecutor.execute()` calls `ConnectionResolver.resolveAuth()` to decrypt and return credentials. `normalizeAuthForAP()` coerces those credentials to the shape the patched AP piece expects. The AP piece runs with the normalized auth.

### API (Runtime)

N/A — no new Runtime REST endpoints. Connector execution flows through the existing `ConnectorToolExecutor` pipeline.

### API (Studio)

N/A — no new Studio API routes. Auth profile creation and connection selection use existing `/api/connections` and `/api/auth-profiles` endpoints.

### Admin Portal

N/A — connector management is tenant-scoped and surfaced in Studio, not the Admin portal.

### Channel / SDK / Voice / A2A / MCP Integration

Connector actions are invoked as agent tools during conversation execution. Once auth profiles are available for these connectors, any channel that runs agent workflows (REST, WebSocket, A2A, MCP) can invoke Jira/Zendesk/ServiceNow actions. No channel-specific changes required.

---

## 9. Data Model

### Collections / Tables

No new collections. All credential storage uses existing patterns.

```text
Collection: connections (existing)
Relevant fields:
  - _id: ObjectId
  - tenantId: string (required, indexed)
  - connectorName: 'jira-cloud' | 'zendesk' | 'servicenow'
  - authProfileId: string (reference to AuthProfile)
  - connectionConfig: Mixed {
      subdomain?: string       // Zendesk: 'acmehelp', ServiceNow: 'dev12345'
      instanceUrl?: string     // Jira: 'https://company.atlassian.net' (legacy, may not be needed with OAuth2)
    }
  - status: 'active' | 'expired' | 'revoked'
```

```text
Collection: authProfiles (existing)
Relevant fields:
  - _id: ObjectId
  - tenantId: string (required, indexed)
  - authType: 'oauth2' | 'api_key'
  - encryptedSecrets: string   // AES-256-GCM encrypted JSON
  - metadata: { connectorName, displayName, ... }
```

### Key Relationships

- `Connection.authProfileId` → `AuthProfile._id`: one Connection references one AuthProfile
- `Connection.connectionConfig.subdomain` is consumed by `normalizeAuthForAP()` during execution to build the AP piece's `props` object
- `AuthProfile.encryptedSecrets` decrypts to `{ access_token, refresh_token, ... }` for OAuth2 or `{ apiKey }` for API key

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                  | Purpose                                                                                                                 |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `packages/connectors/src/adapters/activepieces/context-translator.ts` | Extend `normalizeAuthForAP()` to bridge auth-profile shapes to patched AP piece expectations (connector-keyed dispatch) |
| `packages/connectors/src/loader.ts`                                   | Add `['servicenow', '@activepieces/piece-service-now']` to `PIECE_PACKAGES`                                             |
| `packages/connectors/src/catalog/extract-entry.ts`                    | Add NANGO_SECONDARY_PROVIDERS or verify Zendesk/ServiceNow OAuth2 auto-detection covers `api_key` surfacing             |
| `packages/connectors/package.json`                                    | Add `@activepieces/piece-service-now: "^0.1.3"` dependency; add `patchedDependencies` entries for all 3 AP pieces       |
| `packages/connectors/src/generated/connector-catalog.json`            | Regenerated artifact — reflects updated auth types after patches                                                        |

### pnpm Patch Files (new)

| File                                                                       | Purpose                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `packages/connectors/patches/@activepieces__piece-zendesk@0.2.7.patch`     | Replace Basic auth with OAuth2 Bearer in zendesk piece       |
| `packages/connectors/patches/@activepieces__piece-jira-cloud@0.2.6.patch`  | Replace CustomAuth with PieceAuth.OAuth2 in jira-cloud piece |
| `packages/connectors/patches/@activepieces__piece-service-now@0.1.3.patch` | Replace Basic auth with OAuth2 Bearer in service-now piece   |

### UI Components

| File                                                  | Purpose                                                                                                                       |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/lib/integration-provider-service.ts` | Potentially: verify `hasOAuth` logic resolves Zendesk/ServiceNow Nango providers correctly; add `api_key` surfacing if needed |

### Tests

| File                                                              | Type | Coverage Focus                                                              |
| ----------------------------------------------------------------- | ---- | --------------------------------------------------------------------------- |
| `packages/connectors/src/__tests__/activepieces-importer.test.ts` | unit | Verify patched AP pieces load correctly and auth type is exposed in catalog |
| `packages/connectors/src/__tests__/context-translator.test.ts`    | unit | `normalizeAuthForAP()` for all 3 connectors × 2 auth types                  |
| New E2E test (see testing guide)                                  | e2e  | Full auth-profile → workflow step execution for each connector              |

---

## 11. Configuration

### Environment Variables

No new environment variables. OAuth2 credentials flow through auth profiles, not env vars.

| Variable | Default | Description                                                                                              |
| -------- | ------- | -------------------------------------------------------------------------------------------------------- |
| N/A      | —       | OAuth2 client IDs/secrets are per-tenant, stored in Connection.connectionConfig or Nango provider config |

### Runtime Configuration

No feature flags. This is an additive change — existing connectors are unaffected. Once deployed, the 3 connectors will show available auth types in Studio.

### DSL / Agent IR / Schema

No DSL changes. Connector actions are referenced by `connectorName` + `actionName` in the workflow IR — these already work for other connectors.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation  | Auth profiles and connections are tenant-scoped. `ConnectionResolver.resolveAuth()` already enforces `{ _id, tenantId }` lookup — no changes needed.                    |
| Project isolation | Auth profiles are tenant-scoped (not project-scoped) per the existing auth-profile data model. Connections may be project-scoped in future but are tenant-scoped today. |
| User isolation    | Auth profiles created by a user are accessible to any workflow builder in the same tenant (shared credential pattern). This is the existing behavior — no change.       |

### Security & Compliance

- OAuth2 tokens and API keys are stored encrypted at rest (AES-256-GCM, tenant-scoped key derivation) via the existing AuthProfile encryption pipeline — no new encryption logic needed
- `accessToken` values must never appear in logs — `normalizeAuthForAP()` must not log the auth object. The existing `createLogger` pattern with redaction is already in place for the ConnectorToolExecutor
- Jira's `access_token` is passed through the AP piece to `Authorization: Bearer` headers — standard OAuth2 Bearer usage, no credential logging risk in the patch
- AP piece patches must not introduce `console.log` statements (blocked by pre-commit hook `console-log-lint.sh`)
- ServiceNow `clientSecret` (if needed for token refresh) must NOT be stored in `connectionConfig.Mixed` — must go into `EndUserOAuthToken.encryptedRefreshToken` per existing pattern

### Performance & Scalability

- Jira OAuth2 adds one extra HTTP call (`GET /oauth/token/accessible-resources`) per action to resolve `cloudId`. This is an Atlassian endpoint and is typically <100ms. The AP piece should cache the result in `ctx.store` (key: `jira_cloud_id`) within a single execution.
- Zendesk and ServiceNow Bearer token auth is a header swap with no extra HTTP calls — zero performance impact vs current Basic auth.
- `normalizeAuthForAP()` is synchronous key lookup + object construction — O(1), no latency impact.

### Reliability & Failure Modes

- If an OAuth2 token is expired, `ConnectorToolExecutor` will receive an HTTP 401 from the AP piece action. The existing `workerError` / error propagation path surfaces this to the workflow as a connection error. Token refresh is handled by the Nango refresh flow (automatic, out of band).
- If `connectionConfig.subdomain` is missing for Zendesk/ServiceNow, `normalizeAuthForAP()` must throw a descriptive `ConnectorError` rather than silently passing `undefined` to the AP piece.
- Jira: if `accessible-resources` returns an empty array (no accessible Jira instances), the action must fail with a clear error message.
- pnpm patch files are re-applied on every `pnpm install` — if the underlying AP piece version changes (e.g., a minor bump), the patch may fail to apply. Patch files must be tested after any AP piece version upgrade.

### Observability

- Existing `TraceEvent` emission in `ConnectorToolExecutor.execute()` covers action start, auth resolution, and completion — no new trace events needed
- Auth resolution errors (expired token, missing subdomain) will surface via the existing error trace path
- Build CI will catch patch application failures during `pnpm install`

### Data Lifecycle

- OAuth2 tokens in AuthProfiles have TTLs managed by the Nango token refresh flow and the existing `revokedAt` / `expiresAt` fields on the `EndUserOAuthToken` document
- No new TTL or retention requirements

---

## 13. Delivery Plan / Work Breakdown

1. **Add ServiceNow AP piece dependency**
   1.1 Add `@activepieces/piece-service-now: "^0.1.3"` to `packages/connectors/package.json`
   1.2 Run `pnpm install` to pull the package into the pnpm store
   1.3 Register `['servicenow', '@activepieces/piece-service-now']` in `loader.ts` PIECE_PACKAGES

2. **Patch AP pieces (pnpm patch workflow)**
   2.1 Patch `@activepieces/piece-zendesk@0.2.7` — replace `zendeskAuth` (email/token → subdomain/accessToken), update all 12 action files and 8 trigger files to Bearer auth, add `getZendeskHeaders()` helper, update `createCustomApiCallAction`
   2.2 Patch `@activepieces/piece-jira-cloud@0.2.6` — replace `jiraCloudAuth` (CustomAuth → PieceAuth.OAuth2), update `sendJiraRequest` and `jiraApiCall` to use `access_token` + cloudId resolution, fix `get-issue-attachment.ts` and `index.ts`
   2.3 Patch `@activepieces/piece-service-now@0.1.3` — replace `servicenowAuth` (username/password → instanceUrl/accessToken), update `tableDropdown`, `recordDropdown`, and `createServiceNowClient` factory
   2.4 Commit patch files and add `patchedDependencies` entries to `packages/connectors/package.json`

3. **Extend normalizeAuthForAP bridge**
   3.1 Refactor `normalizeAuthForAP()` to accept `connectorName` (passed from `ActionContext.connectorName`)
   3.2 Add Zendesk OAuth2 branch: extract `access_token` + `connectionConfig.subdomain` → `{ props: { subdomain, accessToken } }`
   3.3 Add Zendesk API key branch: extract `apiKey` + `connectionConfig.subdomain` → `{ props: { subdomain, accessToken: apiKey } }` (field is `accessToken` per the patched auth definition — not `token`)
   3.4 Add Jira OAuth2 branch: pass `{ access_token, token_type }` directly (PieceAuth.OAuth2 top-level shape)
   3.5 Add ServiceNow OAuth2 branch: extract `access_token` + `connectionConfig.subdomain` → `{ props: { instanceUrl: 'https://<subdomain>.service-now.com', accessToken } }`
   3.6 Add ServiceNow API key branch: extract `apiKey` + `connectionConfig.subdomain` → `{ props: { instanceUrl, accessToken: apiKey } }`
   3.7 Verify `translateActionContext()` passes `connectorName` through to `normalizeAuthForAP()`
   3.8 Audit trigger execution path in `packages/connectors/src/triggers/polling-scheduler.ts` — verify whether AP piece trigger `run()` uses a separate context builder or reuses `translateActionContext()`. If separate, add auth normalization to the trigger path.

4. **Wire catalog auth types**
   4.1 Verify `enrichWithOAuth()` in `extract-entry.ts` picks up `zendesk` and `servicenow` Nango providers (both have OAuth2 URLs in providers.json — this should work automatically)
   4.2 Investigate whether `zendesk-api-key` and `servicenow-api-key` Nango provider entries exist; if not, determine correct mechanism to surface `api_key` in `availableAuthTypes` for these two connectors
   4.3 If needed, add entries to `NANGO_SECONDARY_PROVIDERS` in `extract-entry.ts` OR update `integration-provider-service.ts` to surface `api_key` for connectors that have a known API key auth pattern

5. **Regenerate catalog and verify**
   5.1 Run `pnpm connectors:generate-catalog`
   5.2 Verify Jira, Zendesk, ServiceNow entries in `connector-catalog.json` have `oauth2` block populated
   5.3 Verify `pnpm connectors:generate-catalog --check` passes

6. **Build and type-check**
   6.1 Run `pnpm build --filter=@agent-platform/connectors`
   6.2 Run `pnpm build --filter=@agent-platform/search-ai` (ensure no residual import issues)
   6.3 Fix any TypeScript errors from the `normalizeAuthForAP()` refactor

7. **Testing**
   7.1 Write unit tests for `normalizeAuthForAP()` covering all 6 new branches
   7.2 Write integration test verifying connector catalog loads all 3 connectors with correct auth types
   7.3 Manual / E2E verification: create OAuth2 auth profiles for each connector in Studio, execute one action per connector

---

## 14. Success Metrics

| Metric                                                     | Baseline                      | Target                                                                                                                      | How Measured                                       |
| ---------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Connectors showing "Unsupported" badge in Studio           | 3 (Jira, Zendesk, ServiceNow) | 0                                                                                                                           | Manual check in Studio Integrations catalog        |
| `availableAuthTypes` for Jira in Studio API response       | `[]` (empty, "Unsupported")   | `['oauth2']` (API key for Jira Cloud is blocked by absent `jira-cloud-api-key` Nango provider — tracked as Open Question 2) | `GET /api/integrations/providers` response         |
| `availableAuthTypes` for Zendesk in Studio API response    | `[]`                          | `['oauth2', 'api_key']`                                                                                                     | `GET /api/integrations/providers` response         |
| `availableAuthTypes` for ServiceNow in Studio API response | `[]`                          | `['oauth2', 'api_key']`                                                                                                     | `GET /api/integrations/providers` response         |
| `pnpm build --filter=@agent-platform/connectors`           | Passes (existing)             | Passes (post-change)                                                                                                        | CI build                                           |
| Architecture-fitness test: workspace package count         | 47                            | 47 (unchanged — `@activepieces/piece-service-now` is npm, not workspace)                                                    | `pnpm test --filter=@agent-platform/shared-kernel` |
| Jira workflow action e2e                                   | Not testable (auth broken)    | Passes with OAuth2 auth profile                                                                                             | E2E test                                           |

---

## 15. Open Questions

1. **API key surfacing for Zendesk and ServiceNow**: Do `zendesk-api-key` and `servicenow-api-key` Nango provider entries need to be created in providers.json (mirroring `shopify-api-key`, `github-pat`)? Or is there a simpler mechanism (e.g., directly flagging these connectors as `api_key`-compatible in a catalog override)? The `NANGO_SECONDARY_PROVIDERS` path requires a matching provider config in providers.json with `authMode: 'api_key'`.

2. **Jira API key path**: The impl guide specifies `PieceAuth.OAuth2` for Jira (replacing all Basic auth). Does the Jira AP piece need a separate `api_key` path (API token auth), or is API key access for Jira delivered via a separate connector entry (`jira-data-center-api-key` exists in Nango but is for Data Center, not Cloud)?

3. **normalizeAuthForAP connector name routing**: `translateActionContext()` currently receives an `ActionContext` — does `ActionContext` already carry `connectorName`? Verify `packages/connectors/src/executor/connector-tool-executor.ts` passes the connector name through. If not, the context shape needs a minor additive change.

4. **pnpm patch placement**: Should patch files live in `packages/connectors/patches/` (package-local) or workspace root `patches/`? pnpm resolves `patchedDependencies` from the package that declares them — since AP pieces are deps of `packages/connectors`, the patch should live there.

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                                                                            | Severity | Status                                 |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | -------------------------------------- |
| GAP-001 | No `zendesk-api-key` or `servicenow-api-key` Nango provider configs exist in the bundled providers.json — `api_key` surfacing for these two connectors requires either adding virtual provider configs or an alternative mechanism                     | Medium   | Open                                   |
| GAP-002 | Jira cloudId resolution makes one extra HTTP call per action to `GET /oauth/token/accessible-resources` — no persistent cross-execution cache yet                                                                                                      | Low      | Open (acceptable for initial delivery) |
| GAP-003 | pnpm patches fail silently on version upgrades of the underlying AP piece — no automated check that patches apply cleanly after `pnpm update`                                                                                                          | Medium   | Open                                   |
| GAP-004 | `@activepieces/piece-service-now@0.1.3` is an early version and may have fewer actions than the impl guide assumes — action inventory needs verification against installed version                                                                     | Medium   | Open                                   |
| GAP-005 | If `connectionConfig.subdomain` is absent (e.g., auth profile created without completing the Nango connectionConfig form), Zendesk and ServiceNow actions will fail at `normalizeAuthForAP()` — error message quality needs to be clear and actionable | Low      | Open                                   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                                                 | Coverage Type | Status     | Test File / Note                              |
| --- | -------------------------------------------------------------------------------------------------------- | ------------- | ---------- | --------------------------------------------- |
| 1   | `normalizeAuthForAP()` — Zendesk OAuth2: `access_token` + `subdomain` → correct props shape              | unit          | NOT TESTED | `src/__tests__/context-translator.test.ts`    |
| 2   | `normalizeAuthForAP()` — Zendesk API key: `apiKey` + `subdomain` → correct props shape                   | unit          | NOT TESTED | `src/__tests__/context-translator.test.ts`    |
| 3   | `normalizeAuthForAP()` — Jira OAuth2: `access_token` passed top-level                                    | unit          | NOT TESTED | `src/__tests__/context-translator.test.ts`    |
| 4   | `normalizeAuthForAP()` — ServiceNow OAuth2: `access_token` + `subdomain` → `instanceUrl` URL constructed | unit          | NOT TESTED | `src/__tests__/context-translator.test.ts`    |
| 5   | `normalizeAuthForAP()` — ServiceNow API key: `apiKey` + `subdomain` → correct props shape                | unit          | NOT TESTED | `src/__tests__/context-translator.test.ts`    |
| 6   | Connector catalog loads all 3 connectors with non-empty `oauth2` block                                   | integration   | NOT TESTED | `src/__tests__/activepieces-importer.test.ts` |
| 7   | `buildIntegrationProviders()` returns `['oauth2', 'api_key']` for Jira, Zendesk, ServiceNow              | integration   | NOT TESTED | Studio integration-provider-service test      |
| 8   | Jira OAuth2 auth profile → create-issue action executes successfully (E2E)                               | e2e           | NOT TESTED | New E2E test                                  |
| 9   | Zendesk OAuth2 auth profile → create-ticket action executes successfully (E2E)                           | e2e           | NOT TESTED | New E2E test                                  |
| 10  | ServiceNow OAuth2 auth profile → create-record action executes successfully (E2E)                        | e2e           | NOT TESTED | New E2E test                                  |
| 11  | Zendesk polling trigger activates with OAuth2 auth profile                                               | e2e           | NOT TESTED | New E2E test                                  |
| 12  | Jira polling trigger activates with OAuth2 auth profile                                                  | e2e           | NOT TESTED | New E2E test                                  |
| 13  | ServiceNow polling trigger activates with OAuth2 auth profile                                            | e2e           | NOT TESTED | New E2E test                                  |
| 14  | Missing `subdomain` in connectionConfig → clear error, not silent `undefined`                            | integration   | NOT TESTED | `src/__tests__/context-translator.test.ts`    |

### Testing Notes

All test scenarios require real service interactions via HTTP API — no mocking of `normalizeAuthForAP()`, `ConnectionResolver`, or AP piece internals. Unit tests for `normalizeAuthForAP()` are pure-function tests (input object → output object) and need no mocks. Integration tests for catalog loading use the real `ConnectorRegistry` + `loadConnectors()` path. E2E tests start real Express on `{ port: 0 }` with the full connector execution pipeline.

> Full testing details: `../testing/workflow-connector-oauth2-dual-auth.md`

---

## 18. References

- Design docs: Local OAuth2 implementation guides for jira-oauth2, zendesk-oauth2, and servicenow-oauth2 auth migration (provided by user at session start; not committed to repo)
- Related feature docs: [Connectors Platform](connectors.md), [Auth Profiles](auth-profiles.md), [OAuth Tooling](oauth-tooling.md), [Workflows](workflows.md)
- Nango providers: `packages/connectors/src/adapters/nango/generated/providers.json` — entries: `jira`, `zendesk`, `servicenow`
- AP piece packages: `@activepieces/piece-jira-cloud@0.2.6`, `@activepieces/piece-zendesk@0.2.7`, `@activepieces/piece-service-now@0.1.3`

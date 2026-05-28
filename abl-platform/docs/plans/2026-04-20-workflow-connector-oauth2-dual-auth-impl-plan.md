# LLD: Workflow Connector OAuth2 Dual-Auth

**Feature Spec**: `docs/features/workflow-connector-oauth2-dual-auth.md`
**HLD**: `docs/specs/workflow-connector-oauth2-dual-auth.hld.md`
**Test Spec**: `docs/testing/workflow-connector-oauth2-dual-auth.md`
**Status**: DRAFT
**Date**: 2026-04-20
**Ticket**: ABLP-155

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                                                                                                                          | Rationale                                                                                                                                                                                                | Alternatives Rejected                                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1 | Add `connectorName?: string` to `ActionContext` and `TriggerContext` rather than changing `translateActionContext`/`translateTriggerContext` signatures                           | Keeps context objects as the single carrier of execution metadata; `normalizeAuthForAP(ctx.connectorName, auth)` call is natural at both call sites without requiring adapter function signature changes | Passing `connectorName` as a separate parameter to `translateActionContext()` — would require changing `runtime-adapter.ts` call site too                                        |
| D-2 | Normalize auth in `translateActionContext()` (context-translator.ts) and `translateTriggerContext()` (runtime-adapter.ts) — NOT in `ConnectorToolExecutor` or `processPollingJob` | Keeps normalization co-located with the AP context translation seam; execution-layer code stays connector-agnostic                                                                                       | Normalizing in `ConnectorToolExecutor.execute()` before building ActionContext — splits the AP translation concern across two files                                              |
| D-3 | Add `DIRECT_API_KEY_CONNECTORS` Set in `extract-entry.ts` for api_key surfacing in Studio                                                                                         | No Nango secondary providers exist for zendesk-api-key or servicenow-api-key; adding them to providers.json is a generated-file anti-pattern; a constant is explicit and testable                        | Adding virtual Nango provider configs to providers.json — editing generated artifact is fragile; using NANGO_SECONDARY_PROVIDERS requires matching provider config with authMode |
| D-4 | pnpm patch files live in `packages/connectors/patches/` with `patchedDependencies` in `packages/connectors/package.json`                                                          | AP pieces are deps of `packages/connectors`; pnpm resolves patchedDependencies relative to the declaring package                                                                                         | Workspace root `patches/` — would require patchedDependencies in root package.json which is less scoped                                                                          |
| D-5 | Five implementation phases: (1) normalizeAuthForAP + types, (2) pnpm patches, (3) catalog wiring, (4) integration tests, (5) build verification                                   | Each phase is independently deployable and testable; type changes before patch work ensures TypeScript validates everything; catalog regeneration happens after all pieces are patched                   | Monolithic single-phase — too large to revert if one concern fails                                                                                                               |

### Key Interfaces & Types

```typescript
// packages/connectors/src/types.ts — ADDITIVE CHANGES

// Before:
export interface ActionContext {
  auth: Record<string, unknown>;
  params: Record<string, unknown>;
  tenantId: string;
  projectId: string;
  userId?: string;
  connectionScope: 'tenant' | 'user';
  executionId: string;
  store: KeyValueStore;
}

// After (additive):
export interface ActionContext {
  auth: Record<string, unknown>;
  params: Record<string, unknown>;
  tenantId: string;
  projectId: string;
  userId?: string;
  connectionScope: 'tenant' | 'user';
  executionId: string;
  store: KeyValueStore;
  connectorName?: string; // NEW: passed by ConnectorToolExecutor
}

// Before:
export interface TriggerContext {
  auth: Record<string, unknown>;
  tenantId: string;
  projectId: string;
  connectionId: string;
  store: KeyValueStore;
  webhookUrl?: string;
}

// After (additive):
export interface TriggerContext {
  auth: Record<string, unknown>;
  tenantId: string;
  projectId: string;
  connectionId: string;
  store: KeyValueStore;
  webhookUrl?: string;
  connectorName?: string; // NEW: passed by processPollingJob
}
```

```typescript
// packages/connectors/src/adapters/activepieces/context-translator.ts
// SIGNATURE CHANGE — normalizeAuthForAP

// Before:
export function normalizeAuthForAP(auth: Record<string, unknown>): Record<string, unknown>

// After:
export function normalizeAuthForAP(
  connectorName: string,
  auth: Record<string, unknown>
): Record<string, unknown>

// New dispatch logic:
function normalizeAuthForAP(connectorName: string, auth: Record<string, unknown>) {
  const subdomain = (auth.connection as Record<string, unknown> | undefined)
    ?.connectionConfig as Record<string, unknown> | undefined
    )?.subdomain;

  switch (connectorName) {
    case 'zendesk': {
      const accessToken = typeof auth.access_token === 'string' ? auth.access_token
                        : typeof auth.apiKey === 'string'       ? auth.apiKey
                        : undefined;
      if (!subdomain) throw new Error('Zendesk connector requires connectionConfig.subdomain — set subdomain during auth profile creation');
      if (!accessToken) throw new Error('Zendesk connector requires access_token or apiKey in auth credentials');
      return { props: { subdomain, accessToken } };
    }
    case 'jira-cloud': {
      // PieceAuth.OAuth2 — pass through top-level OAuth2 shape
      return auth;
    }
    case 'servicenow': {
      const accessToken = typeof auth.access_token === 'string' ? auth.access_token
                        : typeof auth.apiKey === 'string'       ? auth.apiKey
                        : undefined;
      if (!subdomain) throw new Error('ServiceNow connector requires connectionConfig.subdomain — set subdomain during auth profile creation');
      if (!accessToken) throw new Error('ServiceNow connector requires access_token or apiKey in auth credentials');
      return { props: { instanceUrl: `https://${subdomain}.service-now.com`, accessToken } };
    }
    default:
      // Existing fallback: apiKey → secret_text for SECRET_TEXT pieces
      if (typeof auth.apiKey === 'string' && auth.secret_text === undefined) {
        return { ...auth, secret_text: auth.apiKey };
      }
      return auth;
  }
}
```

```typescript
// packages/connectors/src/catalog/extract-entry.ts — NEW constant

/**
 * Connectors that support API key auth via the same Bearer token field as OAuth2,
 * but have no Nango secondary provider config. normalizeAuthForAP() handles
 * { apiKey } → { props: { ..., accessToken: apiKey } } for these connectors.
 */
export const DIRECT_API_KEY_CONNECTORS: ReadonlySet<string> = new Set(['zendesk', 'servicenow']);
```

```typescript
// apps/studio/src/lib/integration-provider-service.ts — USE new constant
// Import DIRECT_API_KEY_CONNECTORS from connector-catalog package
// Add before/after the existing availableAuthTypes assembly loop:

import { DIRECT_API_KEY_CONNECTORS } from '@agent-platform/connectors/catalog';

// Add inside buildIntegrationProviders() loop, after existing api_key checks:
if (DIRECT_API_KEY_CONNECTORS.has(entry.name) && !availableAuthTypes.includes('api_key')) {
  availableAuthTypes.push('api_key');
}
```

### Module Boundaries

| Module                                     | Responsibility                                                          | Depends On                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------- |
| `context-translator.ts`                    | Connector-keyed auth normalization (pure function)                      | `types.ts`                                                    |
| `runtime-adapter.ts`                       | AP context translation (actions + triggers); calls `normalizeAuthForAP` | `context-translator.ts`, `types.ts`                           |
| `connector-tool-executor.ts`               | Execution orchestration; sets `connectorName` in ActionContext          | `context-translator.ts`, `types.ts`, `connection-resolver.ts` |
| `polling-scheduler.ts`                     | Polling trigger processing; sets `connectorName` in TriggerRunContext   | `types.ts`, `connection-resolver.ts`                          |
| `loader.ts`                                | AP piece registration                                                   | `registry.ts`, `runtime-adapter.ts`                           |
| `extract-entry.ts`                         | Catalog metadata extraction; exports `DIRECT_API_KEY_CONNECTORS`        | `types.ts`, Nango providers.json                              |
| `integration-provider-service.ts` (Studio) | Auth type surfacing in Studio UI                                        | `extract-entry.ts` (via catalog JSON + import)                |

---

## 2. File-Level Change Map

### New Files

| File                                                                             | Purpose                                                                 | LOC Estimate |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------ |
| `packages/connectors/patches/@activepieces__piece-zendesk@0.2.7.patch`           | Replace email/token BasicAuth with subdomain/accessToken Bearer auth    | ~200         |
| `packages/connectors/patches/@activepieces__piece-jira-cloud@0.2.6.patch`        | Replace CustomAuth with PieceAuth.OAuth2, cloud-id URL resolution       | ~150         |
| `packages/connectors/patches/@activepieces__piece-service-now@0.1.3.patch`       | Replace username/password BasicAuth with instanceUrl/accessToken Bearer | ~100         |
| `packages/connectors/src/__tests__/context-translator.test.ts`                   | Unit tests: all 7 `normalizeAuthForAP()` branches                       | ~120         |
| `packages/connectors/src/__tests__/patch-application.test.ts`                    | Integration test: verify patched auth field shapes in node_modules      | ~60          |
| `apps/studio/src/lib/__tests__/integration-provider-service.integration.test.ts` | Integration test: `buildIntegrationProviders()` availableAuthTypes      | ~80          |

### Modified Files

| File                                                                  | Change Description                                                                                                         | Risk                                           |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `packages/connectors/src/types.ts`                                    | Add `connectorName?: string` to `ActionContext` and `TriggerContext`                                                       | Low — additive optional field                  |
| `packages/connectors/src/adapters/activepieces/context-translator.ts` | `normalizeAuthForAP()` signature + connector-keyed dispatch; update `translateActionContext()` to pass `ctx.connectorName` | Med — existing callers must pass connectorName |
| `packages/connectors/src/adapters/activepieces/runtime-adapter.ts`    | `translateTriggerContext()` passes `ctx.connectorName` to `normalizeAuthForAP()`                                           | Low — one-line addition                        |
| `packages/connectors/src/executor/connector-tool-executor.ts`         | Add `connectorName` to ActionContext construction (line ~124)                                                              | Low — additive field                           |
| `packages/connectors/src/triggers/polling-scheduler.ts`               | Add `connectorName: job.connectorName` to TriggerRunContext in `processPollingJob()`                                       | Low — additive field                           |
| `packages/connectors/src/loader.ts`                                   | Add `['servicenow', '@activepieces/piece-service-now']` to PIECE_PACKAGES                                                  | Low                                            |
| `packages/connectors/package.json`                                    | Add `@activepieces/piece-service-now: "^0.1.3"` + `patchedDependencies` for all 3                                          | Med — first use of patchedDependencies         |
| `packages/connectors/src/catalog/extract-entry.ts`                    | Add `DIRECT_API_KEY_CONNECTORS` constant; export it                                                                        | Low                                            |
| `apps/studio/src/lib/integration-provider-service.ts`                 | Import `DIRECT_API_KEY_CONNECTORS` and use in `buildIntegrationProviders()`                                                | Med — Studio build must still pass             |
| `packages/connectors/src/generated/connector-catalog.json`            | Regenerated — reflects new authType for Jira + ServiceNow added                                                            | Low — generated artifact                       |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 1: normalizeAuthForAP Extension + Type Changes

**Goal**: Extend `normalizeAuthForAP()` with connector-keyed dispatch and add `connectorName` to context types — all pure TypeScript, no AP piece patching yet.

**Tasks**:

1.1. Read `packages/connectors/src/types.ts` — add `connectorName?: string` to `ActionContext` (after `executionId`) and `TriggerContext` (after `webhookUrl?`)

1.2. Read `packages/connectors/src/adapters/activepieces/context-translator.ts` — refactor `normalizeAuthForAP()`:

- Change signature to `(connectorName: string, auth: Record<string, unknown>)`
- Add `switch(connectorName)` with `zendesk`, `jira-cloud`, `servicenow` branches (exact shapes from §1 key interfaces above)
- Preserve `default` branch for backward compatibility
- Throw `Error` (not just return) for missing `subdomain` with message containing `"subdomain"` and connector name
- Update `translateActionContext()` to pass `(ctx.connectorName ?? '', rawAuth)` to `normalizeAuthForAP()`

  1.3. Read `packages/connectors/src/adapters/activepieces/runtime-adapter.ts` line 131 — update `translateTriggerContext()` to pass `(ctx.connectorName ?? '', rawAuth)` to `normalizeAuthForAP()`

  1.4. Read `packages/connectors/src/executor/connector-tool-executor.ts` lines 124–133 — add `connectorName` field to `ActionContext` construction: `connectorName,` (variable is in scope at that point)

  1.5. Read `packages/connectors/src/triggers/polling-scheduler.ts` lines 157–166 — add `connectorName: job.connectorName,` to the TriggerRunContext object passed to `trigger.run()`

  1.6. Run `pnpm build --filter=@agent-platform/connectors` — fix any TypeScript errors

  1.7. Write `packages/connectors/src/__tests__/context-translator.test.ts` — implement all 7 unit test branches (UT-1 through UT-7 from test spec)

  1.8. Run `pnpm test --filter=@agent-platform/connectors` — all 7 unit tests must pass

  1.9. Run `npx prettier --write packages/connectors/src/types.ts packages/connectors/src/adapters/activepieces/context-translator.ts packages/connectors/src/adapters/activepieces/runtime-adapter.ts packages/connectors/src/executor/connector-tool-executor.ts packages/connectors/src/triggers/polling-scheduler.ts packages/connectors/src/__tests__/context-translator.test.ts`

**Files Touched**:

- `packages/connectors/src/types.ts` — add `connectorName?` to ActionContext and TriggerContext
- `packages/connectors/src/adapters/activepieces/context-translator.ts` — refactor normalizeAuthForAP, update translateActionContext
- `packages/connectors/src/adapters/activepieces/runtime-adapter.ts` — update translateTriggerContext
- `packages/connectors/src/executor/connector-tool-executor.ts` — add connectorName to ActionContext
- `packages/connectors/src/triggers/polling-scheduler.ts` — add connectorName to TriggerRunContext
- `packages/connectors/src/__tests__/context-translator.test.ts` — new unit test file

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/connectors` exits 0 with 0 TypeScript errors
- [ ] `packages/connectors/src/__tests__/context-translator.test.ts` contains 7 test cases (UT-1 through UT-7)
- [ ] All 7 unit tests pass: `pnpm test --filter=@agent-platform/connectors -- --reporter=verbose 2>&1 | grep -E "context-translator"` shows 7 passing
- [ ] `normalizeAuthForAP('zendesk', { access_token: 'tok', connection: { connectionConfig: { subdomain: 'x' } } })` returns `{ props: { subdomain: 'x', accessToken: 'tok' } }`
- [ ] `normalizeAuthForAP('zendesk', { access_token: 'tok', connection: { connectionConfig: {} } })` throws with message matching `/subdomain/`
- [ ] Existing test suite still passes: `pnpm test --filter=@agent-platform/connectors` exits 0

**Test Strategy**:

- Unit: `context-translator.test.ts` — pure function, zero mocks, 7 branches
- No integration or E2E needed for this phase

**Rollback**: `git revert` all 5 changed TypeScript files. No pnpm changes.

---

### Phase 2: Install ServiceNow + pnpm Patch AP Pieces

**Goal**: Install `@activepieces/piece-service-now`, patch all 3 AP pieces to use Bearer/OAuth2 auth, and commit the resulting `.patch` files.

**Tasks**:

2.1. Add to `packages/connectors/package.json` dependencies:

```json
"@activepieces/piece-service-now": "^0.1.3"
```

2.2. Run `pnpm install` from workspace root — verify `@activepieces/piece-service-now` lands in `packages/connectors/node_modules` (or pnpm store)

2.3. Add `['servicenow', '@activepieces/piece-service-now']` to PIECE_PACKAGES in `packages/connectors/src/loader.ts` (alphabetical position between `'sendgrid'` and `'shopify'`)

2.4. Patch `@activepieces/piece-zendesk@0.2.7`:

- Run `pnpm patch @activepieces/piece-zendesk@0.2.7` from `packages/connectors/` — pnpm creates a temp working directory
- In the temp dir, locate `src/index.js` (or compiled equivalent) — find `zendeskAuth` definition
- Replace auth props: `email: Property.ShortText(...)` and `token: Property.SecretText(...)` → `subdomain: Property.ShortText(...)` and `accessToken: Property.SecretText(...)`
- In each action's `run()` function, replace Basic auth header construction with Bearer: `'Authorization': 'Bearer ' + auth.props.accessToken`
- Replace subdomain extraction from `auth.props.subdomain` (was already there, keep)
- Run `pnpm patch-commit <tmp-path>` — creates `packages/connectors/patches/@activepieces__piece-zendesk@0.2.7.patch`

  2.5. Patch `@activepieces/piece-jira-cloud@0.2.6`:

- Run `pnpm patch @activepieces/piece-jira-cloud@0.2.6` from `packages/connectors/`
- In `src/auth.js`: replace `PieceAuth.CustomAuth({ props: { instanceUrl, email, apiToken } })` with `PieceAuth.OAuth2({ authUrl: 'https://auth.atlassian.com/authorize', tokenUrl: 'https://auth.atlassian.com/oauth/token', scope: ['read:jira-work', 'write:jira-work', 'offline_access'] })`
- In `src/common/index.js` or equivalent: update `sendJiraRequest` / `jiraApiCall` to:
  - Call `GET https://api.atlassian.com/oauth/token/accessible-resources` using `Authorization: Bearer ${auth.access_token}` on first call
  - Cache `cloudId` in `ctx.store.put('jira_cloud_id', cloudId)` and read back with `ctx.store.get('jira_cloud_id')` on subsequent calls
  - Use `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/` as the base URL
- All action files: remove `instanceUrl` + `email` + `apiToken` references from auth; use `auth.access_token` via `sendJiraRequest`
- Run `pnpm patch-commit <tmp-path>`

  2.6. Patch `@activepieces/piece-service-now@0.1.3`:

- Run `pnpm patch @activepieces/piece-service-now@0.1.3` from `packages/connectors/`
- In auth definition: replace `username: Property.ShortText(...)` and `password: Property.SecretText(...)` with `instanceUrl: Property.ShortText(...)` and `accessToken: Property.SecretText(...)`
- In HTTP client factory: replace Basic auth (`Buffer.from(username + ':' + password).toString('base64')`) with Bearer (`'Authorization': 'Bearer ' + auth.props.accessToken`)
- Replace `auth.props.serverUrl` or base URL construction with `auth.props.instanceUrl`
- Run `pnpm patch-commit <tmp-path>`

  2.7. Add `patchedDependencies` to `packages/connectors/package.json`:

```json
"pnpm": {
  "patchedDependencies": {
    "@activepieces/piece-zendesk@0.2.7": "patches/@activepieces__piece-zendesk@0.2.7.patch",
    "@activepieces/piece-jira-cloud@0.2.6": "patches/@activepieces__piece-jira-cloud@0.2.6.patch",
    "@activepieces/piece-service-now@0.1.3": "patches/@activepieces__piece-service-now@0.1.3.patch"
  }
}
```

2.8. Run `pnpm install` from workspace root — verify patches are applied (pnpm logs "Patching X" for each)

2.9. Write `packages/connectors/src/__tests__/patch-application.test.ts` — verify auth field shapes from installed (patched) AP piece exports (INT-7 from test spec)

2.10. Run `pnpm build --filter=@agent-platform/connectors` — verify no TypeScript errors from patched pieces being loaded

2.11. Run `npx prettier --write packages/connectors/package.json packages/connectors/src/loader.ts packages/connectors/src/__tests__/patch-application.test.ts`

**Files Touched**:

- `packages/connectors/package.json` — new dep + patchedDependencies
- `packages/connectors/src/loader.ts` — add servicenow entry
- `packages/connectors/patches/@activepieces__piece-zendesk@0.2.7.patch` — new
- `packages/connectors/patches/@activepieces__piece-jira-cloud@0.2.6.patch` — new
- `packages/connectors/patches/@activepieces__piece-service-now@0.1.3.patch` — new
- `packages/connectors/src/__tests__/patch-application.test.ts` — new

**Exit Criteria**:

- [ ] `pnpm install` exits 0 with "Patching @activepieces/piece-zendesk", "Patching @activepieces/piece-jira-cloud", "Patching @activepieces/piece-service-now" in output
- [ ] `pnpm build --filter=@agent-platform/connectors` exits 0
- [ ] Patch application test passes: `pnpm test --filter=@agent-platform/connectors -- --reporter=verbose 2>&1 | grep -E "patch-application"` shows passing
- [ ] `require('@activepieces/piece-zendesk').zendesk.auth.props` has `accessToken` field (not `token`)
- [ ] `require('@activepieces/piece-jira-cloud').jiraCloud.auth.type === 'OAUTH2'`
- [ ] `require('@activepieces/piece-service-now').serviceNow.auth.props` has `accessToken` field (not `password`)

**Test Strategy**:

- Integration: `patch-application.test.ts` — imports patched AP pieces directly and asserts auth shapes (no DB, no network, but requires patched node_modules)

**Rollback**: Remove `patchedDependencies` from `packages/connectors/package.json`, remove `packages/connectors/patches/` directory, remove servicenow entry from `loader.ts`, remove `@activepieces/piece-service-now` from dependencies, run `pnpm install`.

---

### Phase 3: Catalog Wiring + api_key Surfacing

**Goal**: Expose `oauth2` and `api_key` as `availableAuthTypes` for all 3 connectors in Studio.

**Tasks**:

3.1. Read `packages/connectors/src/catalog/extract-entry.ts` lines 246–249 — add `DIRECT_API_KEY_CONNECTORS` constant after `NANGO_SECONDARY_PROVIDERS`:

```typescript
export const DIRECT_API_KEY_CONNECTORS: ReadonlySet<string> = new Set(['zendesk', 'servicenow']);
```

3.2. Read `apps/studio/src/lib/integration-provider-service.ts` lines 244–280 — import `DIRECT_API_KEY_CONNECTORS` from `'@agent-platform/connectors/catalog'` and add after the secondary providers loop:

```typescript
if (DIRECT_API_KEY_CONNECTORS.has(entry.name) && !availableAuthTypes.includes('api_key')) {
  availableAuthTypes.push('api_key');
}
```

3.3. Run `pnpm connectors:generate-catalog` from `packages/connectors/` — regenerates `src/generated/connector-catalog.json`

3.4. Verify `connector-catalog.json` contains:

- Entry with `name: "servicenow"` (new — was not present before)
- Entry with `name: "jira-cloud"` having `authType: "oauth2"` (changed from `"custom"`)
- Entry with `name: "zendesk"` having `oauth2.authorizationUrl` populated
- Entry with `name: "servicenow"` having `oauth2.authorizationUrl` populated

  3.5. Run `pnpm connectors:generate-catalog --check` — must pass (no diff)

  3.6. Run `pnpm build --filter=@agent-platform/connectors` — must pass

  3.7. Run `pnpm build --filter=@agent-platform/studio` — must pass (Studio imports the catalog constant)

  3.8. Run `npx prettier --write packages/connectors/src/catalog/extract-entry.ts apps/studio/src/lib/integration-provider-service.ts`

**Files Touched**:

- `packages/connectors/src/catalog/extract-entry.ts` — new `DIRECT_API_KEY_CONNECTORS` constant
- `apps/studio/src/lib/integration-provider-service.ts` — import + use `DIRECT_API_KEY_CONNECTORS`
- `packages/connectors/src/generated/connector-catalog.json` — regenerated

**Exit Criteria**:

- [ ] `pnpm connectors:generate-catalog --check` exits 0 (no diff between generated and committed catalog)
- [ ] `cat packages/connectors/src/generated/connector-catalog.json | grep -A3 '"name": "servicenow"'` shows a servicenow entry
- [ ] `cat packages/connectors/src/generated/connector-catalog.json | grep -A5 '"name": "jira-cloud"'` shows `"authType": "oauth2"` (not `"custom"`)
- [ ] `pnpm build --filter=@agent-platform/connectors` exits 0
- [ ] `pnpm build --filter=@agent-platform/studio` exits 0

**Test Strategy**:

- Integration: Extend `packages/connectors/src/__tests__/generate-catalog.test.ts` to verify ServiceNow appears in loaded registry
- Integration: New `apps/studio/src/lib/__tests__/integration-provider-service.integration.test.ts` — assert `availableAuthTypes` contains `'oauth2'` and `'api_key'` for zendesk and servicenow, `'oauth2'` for jira-cloud

**Rollback**: Revert `extract-entry.ts` and `integration-provider-service.ts` changes. Re-run catalog generation. Studio reverts to showing "Unsupported" badge.

---

### Phase 4: Integration Tests

**Goal**: Write and verify all integration tests from the test spec covering the executor chain, trigger auth path, and catalog loading.

**Tasks**:

4.1. Extend `packages/connectors/src/__tests__/integration/executor-resolver-chain.integration.test.ts` — add test for Zendesk OAuth2 auth normalization through the full executor → resolver → normalizeAuthForAP → action.run() chain (INT-5 from test spec):

- Use MongoMemoryServer + real `ConnectionResolver`
- Stub a Zendesk connector action that captures `ctx.auth`
- Assert `ctx.auth = { props: { subdomain: 'testdomain', accessToken: 'bearer-123' } }`

  4.2. Extend `packages/connectors/src/__tests__/integration/polling-trigger.integration.test.ts` — add test for Zendesk polling trigger auth normalization (INT-4 from test spec):

- Add a test registration with `connectorName: 'zendesk'` and OAuth2 connection config
- Assert `trigger.run()` receives normalized `{ props: { subdomain, accessToken } }` in `ctx.auth`

  4.3. Extend `packages/connectors/src/__tests__/generate-catalog.test.ts` — add tests (INT-2 from test spec):

- Assert `ConnectorRegistry` loads ServiceNow after `loadConnectors()`
- Assert Jira catalog entry has `authType === 'oauth2'`
- Assert Zendesk and ServiceNow entries have populated `oauth2.authorizationUrl`

  4.4. Write `apps/studio/src/lib/__tests__/integration-provider-service.integration.test.ts` — new file (INT-3 from test spec):

- Load real `connector-catalog.json` and real `providers.json`
- Call `buildIntegrationProviders(catalog, nangoProviders)`
- Assert `jira-cloud` has `availableAuthTypes` containing `'oauth2'`, `status === 'available'`
- Assert `zendesk` has `availableAuthTypes` containing `['oauth2', 'api_key']`, `status === 'available'`
- Assert `servicenow` has `availableAuthTypes` containing `['oauth2', 'api_key']`, `status === 'available'`

  4.5. Write `packages/connectors/src/__tests__/context-translator.test.ts` — add INT-1 and INT-6 assertions (pure function tests but grouped with integration for completeness; already written in Phase 1 but verify all branches including ServiceNow URL construction)

  4.6. Run full connector test suite: `pnpm test --filter=@agent-platform/connectors`

  4.7. Run `npx prettier --write` on all new/modified test files

**Files Touched**:

- `packages/connectors/src/__tests__/integration/executor-resolver-chain.integration.test.ts` — extend
- `packages/connectors/src/__tests__/integration/polling-trigger.integration.test.ts` — extend
- `packages/connectors/src/__tests__/generate-catalog.test.ts` — extend
- `apps/studio/src/lib/__tests__/integration-provider-service.integration.test.ts` — new

**Exit Criteria**:

- [ ] `pnpm test --filter=@agent-platform/connectors` exits 0 — all tests pass including new integration tests
- [ ] INT-4 (polling trigger auth normalization) passes: trigger receives `{ props: { subdomain, accessToken } }` not raw `{ access_token, ... }`
- [ ] INT-5 (executor chain auth normalization) passes: action receives normalized auth
- [ ] INT-3 (buildIntegrationProviders): zendesk and servicenow show `availableAuthTypes` containing both `'oauth2'` and `'api_key'`

**Test Strategy**:

- Integration: Real MongoMemoryServer, real ConnectorRegistry, no vi.mock() of codebase components
- Integration: Real connector-catalog.json + providers.json for Studio integration test

**Rollback**: Delete new test files or revert extensions. Does not affect production code.

---

### Phase 5: Build Verification + Architecture Fitness

**Goal**: Verify no regressions — all builds pass, all existing tests pass, workspace count unchanged.

**Tasks**:

5.1. Run `pnpm build` — full workspace build (turbo resolves build order)

5.2. If any build fails, diagnose and fix TypeScript errors in the affected package

5.3. Run `pnpm test:report` (structured test runner) or `pnpm test --filter=@agent-platform/shared-kernel` — verify architecture fitness test passes (workspace count = 47 — unchanged, `@activepieces/piece-service-now` is an npm dep, not a workspace package)

5.4. Run `pnpm test --filter=@agent-platform/connectors` — full connector test suite (unit + integration)

5.5. Run `pnpm build --filter=@agent-platform/search-ai` — verify no residual import issues from the earlier sync connector removal

5.6. Run `npx prettier --write` on any files modified during build-fix iterations

5.7. Review git diff to confirm no accidental deletions of existing exports

**Files Touched**: Potentially any build-error files (TypeScript fixes only, no feature changes)

**Exit Criteria**:

- [ ] `pnpm build` exits 0 (full workspace)
- [ ] `pnpm test --filter=@agent-platform/shared-kernel` exits 0 — architecture fitness passes with count = 47
- [ ] `pnpm test --filter=@agent-platform/connectors` exits 0 — all connector tests pass
- [ ] `pnpm test --filter=@agent-platform/studio` exits 0 (if studio has test runner configured)
- [ ] `git diff --name-only HEAD` shows no unexpected deleted files

**Test Strategy**: Build-time type checking + existing test suites

**Rollback**: N/A — this phase only runs builds and tests, no code changes unless fixing TypeScript errors from prior phases.

---

## 4. Wiring Checklist

CRITICAL: Every new component must be wired into its callers.

- [x] `@activepieces/piece-service-now` added to `packages/connectors/package.json` dependencies
- [x] `['servicenow', '@activepieces/piece-service-now']` added to `PIECE_PACKAGES` in `loader.ts`
- [x] `connectorName` field added to `ActionContext` in `types.ts` AND set in `ConnectorToolExecutor` (Phase 1, tasks 1.1 + 1.4)
- [x] `connectorName` field added to `TriggerContext` in `types.ts` AND set in `processPollingJob()` (Phase 1, tasks 1.1 + 1.5)
- [x] `normalizeAuthForAP(connectorName, auth)` called in `translateActionContext()` with `ctx.connectorName` (Phase 1, task 1.2)
- [x] `normalizeAuthForAP(connectorName, auth)` called in `translateTriggerContext()` with `ctx.connectorName` (Phase 1, task 1.3)
- [x] `patchedDependencies` declared in `packages/connectors/package.json` for all 3 AP pieces (Phase 2, task 2.7)
- [x] `DIRECT_API_KEY_CONNECTORS` exported from `extract-entry.ts` and imported by `integration-provider-service.ts` (Phase 3, tasks 3.1 + 3.2)
- [x] `connector-catalog.json` regenerated after all piece changes (Phase 3, task 3.3)
- [ ] No new REST routes added — N/A
- [ ] No new DI registrations — N/A
- [ ] No new models added — N/A
- [ ] Dockerfiles: `@activepieces/piece-service-now` is an npm dep of `packages/connectors` — pnpm will include it in existing `COPY packages/connectors/package.json` step; no Dockerfile change needed

---

## 5. Cross-Phase Concerns

### Database Migrations

None. No schema changes.

### Feature Flags

None. This is a fully additive change — once deployed, Studio shows the 3 connectors as Available. No phased rollout needed.

### Configuration Changes

None. No new env vars. OAuth2 client IDs/secrets are per-tenant, stored in Connection.connectionConfig or Nango provider config (existing).

### pnpm Patch Re-Application

Patches are re-applied on every `pnpm install`. If `@activepieces/piece-zendesk`, `@activepieces/piece-jira-cloud`, or `@activepieces/piece-service-now` are version-bumped in the future, the corresponding patch file must be:

1. Deleted (the old version's patch)
2. Re-created against the new version using `pnpm patch`
3. Updated in `patchedDependencies` in `packages/connectors/package.json`

This process is not automated — it is tracked as GAP-003 in the feature spec.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] Phase 1 exit criteria met: `normalizeAuthForAP()` has 7 branches, all unit tests pass
- [ ] Phase 2 exit criteria met: all 3 AP pieces patched, `pnpm install` applies patches cleanly
- [ ] Phase 3 exit criteria met: `connector-catalog.json` up to date, `generate-catalog --check` passes, Studio builds
- [ ] Phase 4 exit criteria met: INT-3, INT-4, INT-5 integration tests pass
- [ ] Phase 5 exit criteria met: full workspace build passes, architecture fitness = 47
- [ ] E2E tests from test spec: E2E-1 through E2E-7 scenarios are coverable post-implementation (actual E2E execution requires real Zendesk/Jira/ServiceNow credentials — tracked as Open Testing Question 1)
- [ ] No regressions: `pnpm test --filter=@agent-platform/connectors` passes (all pre-existing tests)
- [ ] `pnpm build` passes (full workspace)

---

## 7. Open Questions

1. **GAP-001 resolution**: The LLD uses `DIRECT_API_KEY_CONNECTORS` in `extract-entry.ts` to surface `api_key` for Zendesk and ServiceNow. This is a catalog-level mechanism separate from Nango secondary providers. The `normalizeAuthForAP()` ServiceNow and Zendesk branches already handle `{ apiKey }` input correctly. Is this sufficient, or does the Nango-backed auth profile creation flow also need to support `api_key` profiles (i.e., does `/api/auth-profiles POST` already accept `authType: 'api_key'` for these connectors)?

2. **Patch working directory**: `pnpm patch` must be run from `packages/connectors/` (not workspace root) so that it resolves AP pieces from the right node_modules. Confirm before Phase 2.

3. **ServiceNow auth field names**: The patch in task 2.6 assumes the ServiceNow piece uses `username/password` for BasicAuth. Verify actual field names after `pnpm install` in Phase 2 by reading `node_modules/.pnpm/@activepieces+piece-service-now@0.1.3/.../src/index.js`. If field names differ, update the patch accordingly.

4. **Jira cloudId scope**: `GET /oauth/token/accessible-resources` returns an array of accessible Jira Cloud instances. The patch assumes the first entry's `id` is the cloudId. If a user has multiple Jira instances, this may pick the wrong one. Acceptable for initial delivery — multi-instance is tracked as a future enhancement.

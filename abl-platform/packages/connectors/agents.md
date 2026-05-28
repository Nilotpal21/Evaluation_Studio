# @agent-platform/connectors — Agent Learnings

## Package Overview

The connectors package is a **framework-agnostic** SDK. It has no Express routes, no middleware,
and no web framework types. All services are injected via typed interfaces (ConnectionModel,
TriggerRegistrationModel, TriggerRedisClient, etc.).

## Build & Test

- `pnpm build --filter=@agent-platform/connectors` — runs `tsc` + copies JSON assets
- `pnpm test --filter=@agent-platform/connectors` — runs vitest with `src/__tests__/**/*.test.ts` (excludes integration/)
- Integration tests: `cd packages/connectors && npx vitest run --config vitest.integration.config.ts`
- `vitest.config.ts` excludes `src/__tests__/integration/**` — integration tests run separately via `vitest.integration.config.ts`
- `vitest.integration.config.ts` uses `pool: 'forks'` for process isolation (MongoMemoryServer requires it)
- Tests include unit tests (mocked deps), E2E tests (real MongoMemoryServer), and integration tests (real services + real DB)

## Testing Patterns

### E2E Tests (src/**tests**/e2e/)

- Use MongoMemoryServer for real MongoDB
- Use real AES-256-GCM encryption (not mock encrypt/decrypt)
- Need a `createModelAdapter()` function to adapt Mongoose models to the `ConnectionModel` interface
- The `ConnectionModel` interface uses chained API: `.find().sort().lean()` — adapter must implement full chain
- Mongoose `{ new: true }` in `findOneAndUpdate` triggers deprecation warning — `returnDocument: 'after'` is preferred but both work

### Webhook Tests

- `handleWebhook` is framework-agnostic — accepts `WebhookRequest` and `WebhookHandlerDeps`
- Redis and Restate are external infrastructure — in-memory doubles are acceptable per E2E test standards
- `InMemoryRegistrationModel` must implement real `$set` and `$inc` semantics for correct testing
- OpenTelemetry spans are created internally — no special OTel setup needed for tests

### Connection Test Lifecycle

- `ConnectionService.test()` calls the connector's `test_connection` action with real credentials
- A real HTTP server on port 0 (random) simulates the external API
- Connection status transitions (active → expired → active) are verified via subsequent reads

### Integration Tests (src/**tests**/integration/)

- Use MongoMemoryServer with real ConnectionResolver / ConnectionService (not mocked)
- Use real AES-256-GCM encryption backed by Node.js crypto
- `ConnectorConnectionModel` adapter wraps Mongoose model for the resolver interface
- `ConnectionModel` adapter wraps Mongoose model for the service interface (with `.find().sort().lean()` chain)
- In-memory `LockManagerLike` implementation simulates distributed locking without Redis
- Mock OAuth provider HTTP server (external service — OK to mock) on random port
- OAuth refresh tests should register test-only providers via `registerProvider()` instead of rewriting `providers.json`
- `providers.json` is committed generated data and should stay populated via `pnpm connectors:import-providers`

## Gotchas

1. **No Express routes exist in this package** — E2E tests exercise the service layer, not HTTP routes
2. **MongoMemoryServer may crash on some platforms** — tests use `skip()` guard when unavailable
3. **Collection names matter** — use unique collection names per test file to avoid cross-contamination
4. **The `ConnectionModel` interface requires a sorted find** — `.find().sort().lean()` chain, not just `.find()`
5. **Encryption is tenant-scoped in the interface** but the current impl uses a global key — future rotation will need tenant-specific keys
6. **providers.json must stay populated** — generated data, run `pnpm connectors:import-providers` when the upstream Nango registry changes
7. **Without LockManager, refreshOAuth2() returns decrypt(connection)** — does NOT call the OAuth provider. This is a documented gap for single-pod deployments
8. **completeOAuthSetup encrypts tokens differently** — access token as JSON `{"accessToken": "..."}`, refresh token as bare string
9. **Two different model adapter interfaces** — `ConnectionModel` (for ConnectionService, with find/create/delete) vs `ConnectorConnectionModel` (for ConnectionResolver, with findOne/findOneAndUpdate only)
10. **Token manager test was double-disabled** — both `describe.skip` inside the file AND `.test.ts.skip` suffix. The vitest config at `packages/connectors/base/vitest.config.ts` excludes `**/*.skip.ts`. When rewriting, create a new `.test.ts` file alongside the `.skip` file rather than renaming (keeps history).
11. **TokenManager constructor changed** — old: `{ tenantId, provider, oauthProvider }` object; current: `(provider, tenantId, userId, tokenModel, options?)` positional args. Tests must mock the token model with `findOne`/`create` methods, not spy on `EndUserOAuthToken` static methods.
12. **Webhook renewal scheduler not wired** — `startScheduledJobs()` in `apps/search-ai/src/scheduler/index.ts` is exported but never called from `startServer()`. The scheduled jobs for webhook renewal, delta sync, and cleanup are all dead code until wired in.
13. **Webhook renewal uses mock tokens** — `webhook-renewal.ts` creates `GraphClient({ accessToken: 'mock-token' })`. Must be replaced with actual OAuth token resolution before it can work in production.

## 2026-04-28 — Authorize at Creation (ABLP-619, FR-9)

**Category**: pattern
**Learning**: The connector factory (`src/services/auth-profile-resolver-factory.ts`) is the only auth-profile resolver that loads-then-checks status in code (the runtime resolver and shared service filter `status: 'active'` at the query level, returning `null` for non-active). ABLP-619 added an explicit `pending_authorization -> AUTH_PROFILE_NOT_AUTHORIZED (403)` branch BEFORE the legacy generic non-active rejection so the user-visible error guides the user to the Authorize action, not a generic "credentials expired" message. The `AuthProfileError` import is from `@agent-platform/shared/services/auth-profile` — the package was previously not used in the factory (it was throwing plain `Error`). The factory is DI-friendly (`authProfileModel` parameter), so the regression test passes a stub document directly with no platform mocks.
**Files**: `src/services/auth-profile-resolver-factory.ts`, `src/__tests__/auth-profile-resolver-factory-pending.test.ts`
**Impact**: When adding new `AuthProfileStatus` values that should not silently resolve, add an explicit branch in the factory (with a typed `AuthProfileError`) before the catch-all "non-active" reject, so the user-facing error stays specific to the new state.

## 2026-04-03 — Connector OAuth + Auth Profile Alignment

1. Connector OAuth work now depends on auth-profile durable-grant behavior, not just legacy embedded token documents. When connector setup or refresh flows look up OAuth state, verify whether the source should be a linked auth profile / grant rather than direct token storage.
2. Connection records still need to persist the right OAuth connection metadata so import/export and reconnect flows can rebuild the provider binding without guessing.
3. Custom / Activepieces auth bridges remain intentionally narrower than the main auth-profile-backed connector flows; Studio should hide or constrain auth-profile choices where the runtime bridge does not support them.

**Impact**: Future connector OAuth changes should trace the full path across connector metadata, auth-profile grant resolution, and Studio setup UX before assuming a token lives in only one place.

## 2026-04-06 — Shared Connector OAuth Template Resolver

1. `src/auth/template-resolver.ts` is now the single seam for connector OAuth `connectionConfig` normalization and template substitution. It merges explicit catalog/provider metadata with keys inferred from `authorizationUrl`, `tokenUrl`, `refreshUrl`, `proxyBaseUrl`, and templated param values, then enforces the shared limits: max 10 keys, max 256 chars per value, hostname/URI validation, and forbidden breakout characters for general fields.
2. Runtime refresh validation must include `proxyBaseUrl` when deriving allowed `connectionConfig` keys. Providers like Salesforce keep `instance_url` only in proxy metadata, so validating against just token/refresh URLs would wrongly reject persisted config during refresh.

**Impact**: Future OAuth hardening should add or update coverage in `src/__tests__/template-resolver.test.ts` first and treat `normalizeConnectionConfig()` as the required gate before any templated URL or param resolution.

## 2026-04-06 — Template Resolver Key Syntax Coverage

1. Generated provider data already uses dotted and hyphenated `connectionConfig` placeholders such as `installation.uuid` and `accounts-server`. The shared template regex in `src/auth/template-resolver.ts` must keep supporting both forms; narrowing it back to underscore-only would break real provider templates.
2. `normalizeConnectionConfig()` has dedicated `enum` and `pattern` validation branches that are easy to miss from route-level happy-path tests. Keep direct regression coverage for those branches in `src/__tests__/template-resolver.test.ts`.

**Impact**: When provider metadata or connectionConfig validation changes, update the shared resolver tests first and treat dotted/hyphenated key support as part of the compatibility contract.

## 2026-04-06 — OAuth Callback Persistence Strict Mode

1. `ConnectionService.completeOAuthSetup()` now accepts `requireExisting`. Callers that have already created or otherwise guaranteed the placeholder connection should set it to `true` so a missing `findOneAndUpdate` result throws `ConnectionServiceError('Connection not found', 'NOT_FOUND')` instead of silently returning `null`.
2. Keep the default nullable behavior for legacy callers that accept user-supplied `connectionId`s, but lock strict-mode behavior in `src/__tests__/connection-service.test.ts` whenever the OAuth setup contract changes.

**Impact**: OAuth callback flows that create a connection and immediately persist tokens should fail closed with `requireExisting: true`; CRUD-style routes can keep the nullable contract when they need 404 semantics.

## 2026-04-15 — Connector Trigger Version Awareness (GAP-001)

**Category**: architecture
**Learning**: The connector trigger types (`TriggerRegistration`, `WorkflowTriggerInput`, `TriggerJobData`, `RegisterTriggerInput`) now include optional `workflowVersionId` and `environment` fields. All three processors (cron, webhook, polling) thread `workflowVersionId` through to `startWorkflow()` when the registration carries one. The `registerCronTrigger` and `registerPollingTrigger` functions include version/environment in BullMQ job data so the scheduler can use them for version resolution. The connector `TriggerRegistration` type is still a subset of the DB model — fields like `webhookUrl`, `webhookMode`, `authProfileId` remain DB-only.
**Files**: `src/triggers/types.ts`, `src/triggers/cron-scheduler.ts`, `src/triggers/webhook-handler.ts`, `src/triggers/polling-scheduler.ts`, `src/triggers/trigger-engine.ts`
**Impact**: Future trigger processors must propagate `workflowVersionId` when present on the registration. The DB model (`packages/database`) is the canonical superset; keep the connector type as a minimal subset needed for processing.

## 2026-04-15 — Dynamic Dropdown Resolver (SDK Layer)

**Category**: architecture
**Learning**: AP `Property.Dropdown` carries an async `options(args, ctx)` closure that cannot be serialized into the static catalog JSON. The runtime-adapter keeps the raw AP options functions in an in-memory `Map<propName, fn>` closed over by a new optional `ConnectorAction.resolveOptions(propName, ctx)` method. The catalog type `ConnectorProperty.refreshers` signals (by presence) that a prop is dynamic. Keep the raw AP closure hidden behind `resolveOptions` — don't leak `__apRawActions` or similar side-channel fields onto `Connector`.
**Files**: `src/types.ts`, `src/adapters/activepieces/type-mapper.ts` (mapProperty copies `refreshers`), `src/adapters/activepieces/runtime-adapter.ts` (createRuntimeAction wires `resolveOptions`), `src/services/dropdown-options-service.ts`
**Impact**: Future connector adapters (non-AP) can implement `resolveOptions` to participate in the same Studio dropdown flow. The `DropdownState` shape — `{disabled, placeholder?, options}` — is the contract.

**Category**: pattern
**Learning**: Design-time service calls that need a credential bundle should reuse `ConnectionResolver.resolve()` + `.resolveAuth()` rather than re-reading the DB. The `KeyValueStore` dep should be a no-op at design-time (matches how `ConnectionService.test()` builds one). AP `options` fns are free to call `store.get/put/delete`; a no-op satisfies the contract without persisting state.
**Files**: `src/services/dropdown-options-service.ts`, `src/services/connection-service.ts` (existing pattern)
**Impact**: Any future design-time helper that invokes a piece closure should follow the same "real resolver + no-op store" composition.

## 2026-04-25 — Alias Providers Can Beat Exact Name Matches

**Category**: architecture
**Learning**: Nango exact-name matches are not always the best auth metadata source. `microsoft-teams` currently exists as a same-name provider with `authMode: 'none'`, while the aliased `microsoft` provider carries the real Azure AD OAuth URLs. Shared catalog enrichment should therefore prefer the alias provider when the exact match lacks usable `authorizationUrl` and `tokenUrl`.
**Files**: `src/catalog/extract-entry.ts`, `src/__tests__/generate-catalog.test.ts`
**Impact**: When adding future connector aliases, test both sides of the decision: exact provider wins if it already has OAuth URLs; alias wins only when the exact match is non-oauth or incomplete.

## 2026-04-25 — Promoting Auth-Only Providers To Real Connectors Requires Three Synchronized Changes

**Category**: process
**Learning**: Turning a provider from "auth-only metadata" into a real generated connector is not just a package install. The piece must be added to `package.json`, registered in `src/loader.ts`, and categorized in `scripts/generate-connector-catalog.ts`, then the generated catalog must be rebuilt. Missing any one of those steps leaves Studio with auth metadata but no actions/triggers, or a package dependency that never becomes visible in the shipped catalog.
**Files**: `package.json`, `src/loader.ts`, `src/generated/connector-catalog.json`, `../../scripts/generate-connector-catalog.ts`
**Impact**: Future connector promotions (especially Microsoft/Azure/AWS additions) should always be done as a catalog-generation slice, not as a Studio-only auth override.

## 2026-05-03 — normalizeAuthForPieceValidate — Shape Divergence (ABLP-619)

**Category**: architecture
**Learning**: `normalizeAuthForPieceValidate` in `src/adapters/activepieces/context-translator.ts` bridges the stored auth shape (from the `auth_profiles` collection) to the shape that AP piece `auth.validate()` hooks expect. Two critical divergences: (1) `SECRET_TEXT` connectors store credentials under a `token` key in `auth_profiles`, but AP pieces expect the value directly as `auth.value` — the normalizer unwraps this. (2) `CUSTOM_AUTH` connectors store an array of `{ key, value }` pairs in `auth_profiles.secrets`, but AP pieces expect a flat object `{ [key]: value }` — the normalizer converts this. Without this normalization, calling `validate()` on a live AP piece would silently succeed (returns no error) because the keys it looks up in the auth object simply wouldn't be found, making the "valid" response a false positive.
**Files**: `src/adapters/activepieces/context-translator.ts` (`normalizeAuthForPieceValidate`), `src/__tests__/normalize-auth-for-piece-validate.test.ts`
**Impact**: When adding new auth types to the connector ecosystem, verify whether the AP piece's `auth.validate()` hook uses a different key convention than what `auth_profiles` stores. If so, add a branch to `normalizeAuthForPieceValidate`. The 16-test suite in `normalize-auth-for-piece-validate.test.ts` is the regression guard — add a test case for each new auth-type branch.

---

**Category**: architecture
**Learning**: Lazy expiry transition lives in `createAuthProfileResolver`. When `status === 'active' && expiresAt + 60s grace < now`, the resolver flips the row via compare-and-swap (`findOneAndUpdate({_id, tenantId, status: 'active'}, {$set:{status: 'expired'}, $inc:{profileVersion:+1}})`) and throws `AUTH_PROFILE_EXPIRED`. The CAS filter loses cleanly to concurrent revokes or token refreshes that already bumped the row. No background sweep needed — every workflow/agent/MCP/dropdown read goes through this gate.
**Files**: `src/services/auth-profile-resolver-factory.ts`, `src/__tests__/auth-profile-resolver-factory-lazy-expiry.test.ts`
**Impact**: If you add a new caller that reads an auth profile directly (not through the resolver), replicate the expiry check or route through `createAuthProfileResolver`. Adding new statuses requires reviewing the throw-order: pending → enabled-gate → expiry → other non-active.

## 2026-05-15 — Document-Extraction Integrations (Phase 1-4) — ABLP-1073

**Category**: architecture | pattern
**Learning**: Workflow steps now drive document extraction via a two-strategy connector family: (a) native `docling` connector wraps a worker-side `streamUrlToDocling` + `workflow-docling-extraction` BullMQ enqueue, returning an `AsyncParkingSentinel` so the engine's `connector_action` dispatch path can park on a Restate callback promise instead of blocking. (b) Activepieces piece `@abl/piece-azure-document-intelligence` is registered lazily, gated on `WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED`. Three new `ActionContext` extensions (`callbackContext`, `workflowExecutionId`, `stepId`, `connectionId`) are populated by `ConnectorToolExecutor.execute` so native bodies can encrypt callback secrets, build callback URLs, enqueue BullMQ jobs, and stash per-step state in `ctx.store` (Redis-backed, see `apps/workflow-engine/src/services/redis-kv-store.ts`). The AP piece reads workflow context off `(ctx as any).abl` populated by `translateActionContext`. `AsyncParkingSentinel.encryptedCallbackSecret` carries the encrypted-at-rest secret; the engine persists it to the step record and decrypts at callback time.
**Files**: `src/types.ts` (sentinel, ActionContext, AzureDocumentIntelligenceServices), `src/native/docling/` (connector + envelope), `src/native/extraction-envelope.ts`, `src/executor/connector-tool-executor.ts`, `src/executor/connector-action-executor.ts` (sentinel→callbackRequest), `src/adapters/activepieces/context-translator.ts` (`(ctx as any).abl` population), `src/loader.ts` (flag-gated registration), `piece-azure-document-intelligence/` (AP piece + inlined SSRF guard + RetryAfter parser).
**Impact**: New extraction strategies (e.g. PDFCo, Unstructured) follow the same pattern: native connector returns sentinel + enqueues to a dedicated queue; OR AP piece consumes the `abl` context bag. SSRF must be re-checked at every Redis hop (the worker re-validates after dequeue). Connector-body rate-limiting uses `rate-limiter-flexible` per-tenant via `CallbackContext.getSharedRedisClient`. Hex IPv6-mapped IPv4 (`::ffff:7f00:1`) requires explicit normalization before regex private-range checks — bug fixed in `piece-azure-document-intelligence/src/safe-fetch.ts`.

## 2026-05-16 — ConnectionService.test() no-auth short-circuit — ABLP-1073

**Category**: bug | symmetry
**Learning**: `ConnectionService.test()` was always calling `authProfileResolver.resolve(...)`, even when the connector declared `auth: { type: 'none' }` (Docling, HTTP). Those connectors carry a synthetic `metadata.authType === 'none'` hint and a placeholder `authProfileId` (e.g. `system-docling-none`) that doesn't exist as a real AuthProfile. The runtime path in `src/auth/connection-resolver.ts:resolveAuth` already short-circuits on the same hint and returns `{}` — but the UI test-button path didn't, so every Test Connection click against a Docling connection threw "Auth profile not found: system-docling-none" and flipped the connection to `expired`. Mirror the short-circuit in the test path: read `connection.metadata.authType`, and when it's `'none'`, pass an empty `auth: {}` to the test action (or skip the action entirely if no `test_connection` exists).
**Files**: `src/services/connection-service.ts` (test method, no-auth branch).
**Impact**: Any future connector with `auth: { type: 'none' }` (HTTP, internal extraction wrappers) gets a working Test button automatically. When adding a new auth-less connector, ensure the synthetic ConnectorConnection is created with `metadata.authType: 'none'` so both runtime and test paths agree.

## 2026-05-17 — Connection resolver sentinel for auth.type='none' connectors — ABLP-1073

**Category**: pattern
**Learning**: `auth.type='none'` connectors (Docling) need a `connectionId` on workflow steps for the engine's `connectionResolver.resolve()` to honor the step, but there's no `AuthProfile` document to bind to (auth.type='none' means no credentials to store). The convention is: Studio's `IntegrationNodeConfig` auto-binds a synthetic sentinel `system-<connector>-none` on step config. `connection-resolver.ts` accepts this sentinel via a regex-guarded `authProfileId` lookup BEFORE its standard `_id` query: `findOne({authProfileId: sentinel, connectorName, tenantId, projectId, status: 'active'})`. The regex `/^system-([a-z0-9-]+)-none$/` is intentionally tight — defense in depth against attacker-crafted workflow IRs that try to pass arbitrary substrings as `connectorName` (even though tenant+project scope already bounds blast radius).
**Files**: `src/auth/connection-resolver.ts:97-130`, `apps/studio/.../IntegrationNodeConfig.tsx:152-158` (sentinel generator), `apps/studio/.../TestActionModal.tsx:92-94` (UI gate using matching regex).
**Impact**: When adding a new `auth.type='none'` connector, no changes needed in connection-resolver. The ConnectorConnection must be auto-provisioned for the project (Docling does this via the project-toggle BFF route). Sentinel and connector name MUST be lowercase + digits + hyphen only — uppercase or special chars will not match the regex and the workflow will fail at resolve time. Keep client (`TestActionModal.tsx`) and server (`connection-resolver.ts`) regexes in sync — they currently both use `^system-[a-z0-9-]+-none$`.

## 2026-05-17 — Azure DI `pages` is a query-string param, not a body field — ABLP-1073

**Category**: gotcha
**Learning**: Azure Document Intelligence REST API v4.0 (`2024-11-30`) accepts the `pages` filter as a URL query string parameter, NOT a body field. Sending `{ urlSource: ..., pages: '1-5' }` in the POST body is silently ignored — Azure OCRs every page anyway. The user-supplied page range has no effect, but no error surfaces. Reference: <https://learn.microsoft.com/en-us/rest/api/aiservices/document-models/analyze-document>. The fix moves `pages` into the URL as `&pages=<encoded>` and keeps only `urlSource` in the body.
**Files**: `piece-azure-document-intelligence/src/actions/extract-document.ts:401-446` (`postAnalyze`).
**Impact**: If you add new optional Azure DI params (`locale`, `stringIndexType`, `features`, `queryFields`, `outputContentFormat`), check Microsoft's REST reference — most of them are query parameters too. The body schema is only `{ urlSource | base64Source }`.

## 2026-05-18 — AP-format pieces need callbackContext forwarded via ctx.abl — ABLP-1073

**Category**: gotcha
**Learning**: Native connectors (Docling — inside `packages/connectors/src/native/`) receive `callbackContext` directly on `ActionContext` and read it as `ctx.callbackContext`. AP-format pieces (ADI — `@abl/piece-azure-document-intelligence`) go through `translateActionContext()` which builds `ctx.abl`. The `abl` object was not forwarding `callbackContext` → ADI received `ctx.abl.callbackContext === undefined` at runtime. Fix: `...(ctx.callbackContext ? { callbackContext: ctx.callbackContext } : {})` in `translateActionContext` at `context-translator.ts`. Also add `callbackContext?: CallbackContext` to `ABLPieceContext` interface so TypeScript enforces it.
**Files**: `packages/connectors/src/adapters/activepieces/context-translator.ts`
**Impact**: Any AP-format piece that needs workflow-engine wiring (enqueue functions, encrypt helpers, Redis client) MUST check that `translateActionContext` forwards the relevant field into `ctx.abl`. The pattern is: native pieces read from `ActionContext` directly; AP pieces read from `ctx.abl`.

## 2026-05-18 — AP store uses `put()` not `set()` — ABLP-1073

**Category**: gotcha
**Learning**: `KeyValueStore.set()` is the internal interface used by native connectors and the `RedisKvStore` implementation. The AP store wrapper (`wrapStore` in `context-translator.ts`) exposes `put()` → calls `store.set()` internally. AP-format pieces (like ADI) go through `wrapStore` and must call `ctx.store.put()`, NOT `ctx.store.set()`. Calling `ctx.store.set()` will throw `TypeError: ctx.store.set is not a function` at runtime.
**Files**: `packages/connectors/src/adapters/activepieces/context-translator.ts` (wrapStore), `packages/connectors/piece-azure-document-intelligence/src/actions/extract-document.ts`
**Impact**: All AP-format pieces writing to `ctx.store` must use `put()` / `get()` / `delete()`. Native pieces use `set()` / `get()` / `delete()`.

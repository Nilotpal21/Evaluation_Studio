# agents.md — apps / search-ai

Agent learning journal for this package. Append-only log of architectural decisions, patterns, gotchas, and insights discovered during SDLC work.

Agents MUST read this file before modifying code in this package. Agents MUST append learnings after completing work.

---

<!-- Append new entries below this line. Format:
## <DATE> — <Feature/Context>
**Category**: architecture | testing | pattern | gotcha | process
**Learning**: <what was learned — specific and actionable>
**Files**: <key files involved>
**Impact**: <how this affects future work in this package>
-->

## 2026-03-24 — SharePoint Connector UX T-06 (Audit Log)

**Category**: pattern
**Learning**: New route files in search-ai follow the pattern: import authMiddleware, create Router, apply authMiddleware, define handleError helper that returns `{ success: false, error: { code, message } }`, validate params/query with Zod `.safeParse()`. Mount in server.ts under `/api/indexes` for index-scoped routes. Services use `getLazyModel('ModelName')` from `../db/index.js` to get Mongoose models — never import models directly.
**Files**: `src/routes/connector-audit.ts`, `src/services/connector-audit.service.ts`, `src/server.ts`
**Impact**: Follow this pattern for any new connector-related routes. The audit service pattern (writeAuditEntry/getAuditLog/exportAuditLog) can be reused by other services that need to write audit entries.

---

## 2026-03-24 — SharePoint Connector UX T-07 (Config Versioning)

**Category**: gotcha
**Learning**: Full search-ai build fails due to pre-existing errors: (1) `connector-audit.ts` has TS2742 "inferred type cannot be named" for `router` variable — needs explicit type annotation `RouterType`, (2) `intelligence-crawl-worker.ts` missing `cheerio` type declarations. These are NOT caused by new code. Use `npx tsc --noEmit` and grep for your file names to verify your changes are clean.
**Files**: `src/routes/connector-audit.ts`, `src/workers/intelligence-crawl-worker.ts`
**Impact**: Do not rely on full `pnpm build --filter=@agent-platform/search-ai` passing — check your specific files with tsc and grep output.

**Category**: pattern
**Learning**: Optimistic concurrency for auto-incrementing fields uses a unique compound index + retry loop on duplicate key error (code 11000). The `isDuplicateKeyError()` helper uses duck-typing `err.code === 11000` to avoid casting to specific Mongoose error types. Max 3 retries is sufficient for typical concurrency levels.
**Files**: `src/services/connector-config-version.service.ts`
**Impact**: Follow this pattern for any service needing auto-incrementing version/sequence numbers.

---

## 2026-04-23 — Discovery Panel LLD (Crawler UX)

**Category**: gotcha
**Learning**: `handleExplorerEvent()` in `crawl-browser-discover.ts` uses an explicit if/else chain for `progress`/`complete`/`error` events only. Any new SSE event type (e.g., `nav-extracted`) will be **silently dropped** by the proxy. When adding new event types from crawler-mcp-server, you MUST add an explicit case in `handleExplorerEvent()`.
**Files**: `src/routes/crawl-browser-discover.ts` (lines 473-500)
**Impact**: Every new SSE event type requires a proxy update — never assume passthrough.

**Category**: architecture
**Learning**: search-ai (port 3005) and crawler-mcp-server (port 3100) are separate processes. In-memory data structures cannot span them. The intervention command queue pattern uses HTTP POST forwarding: Studio → search-ai POST → crawler-mcp-server POST → in-memory queue polled by depth-prober. Same pattern as exploration start.
**Files**: `src/routes/crawl-browser-discover.ts`, `apps/crawler-mcp-server/src/explore/depth-prober.ts`
**Impact**: Any feature requiring cross-process state (search-ai ↔ crawler-mcp-server) must use HTTP forwarding, not shared memory.

---

## 2026-03-24 — SharePoint Connector UX T-01/T-02/T-03

**Category**: gotcha
**Learning**: The `permissionConfig.mode` enum was changed from `['full', 'simplified', 'disabled']` to `['enabled', 'disabled']` across 8+ files. Many other files (CLI, studio store, recommendation model, project-io, tests) still reference the old enum — these need follow-up updates. MongoDB migration is REQUIRED before deploy: `db.connector_configs.updateMany({'permissionConfig.mode': {$in: ['full', 'simplified']}}, {$set: {'permissionConfig.mode': 'enabled'}})`.
**Files**: `connector-config.model.ts`, `connector.interface.ts`, `permission-crawler.interface.ts`, `sharepoint-permission-crawler.ts`, `connector.service.ts`
**Impact**: Any code touching `permissionConfig.mode` must use `'enabled' | 'disabled'`, never `'full'` or `'simplified'`.

**Category**: pattern
**Learning**: When adding a Redis parameter to a service function (like `pauseSync`), always update the route handler to pass `req.app.get('redis')`. Compare with existing patterns like `stopSync` which already has this.
**Files**: `src/services/connector.service.ts`, `src/routes/connectors.ts`
**Impact**: Service functions that need Redis should accept it as a parameter, not create their own connections. Exception: device code session functions use a dedicated lazy Redis instance.

**Category**: pattern
**Learning**: OAuth session storage uses `SET NX PX` (atomic set-if-not-exists with TTL) to prevent race conditions when users double-click auth buttons. All Redis operations in auth flows should wrap errors in `ConnectorError('REDIS_UNAVAILABLE', ..., 503)`.
**Files**: `src/services/connector.service.ts`
**Impact**: Follow this pattern for any Redis-based state that must not be overwritten by concurrent requests.

---

## 2026-03-24 — SharePoint Connector UX Wave 3 Batch 1 (Backend Monitoring)

**Category**: pattern
**Learning**: New monitoring/utility routes follow the same pattern as connector-audit.ts: Router with authMiddleware, local handleError using ConnectorError, Zod safeParse for params/query/body, tenantId from `req.tenantContext!.tenantId`. Multiple routes can share a single router file when they are thematically related (e.g., T-28 overview+breakdown+history + T-33 permission-schedule share connector-monitoring.ts).
**Files**: `src/routes/connector-monitoring.ts`, `src/routes/connector-notifications.ts`, `src/routes/connector-error-recovery.ts`, `src/routes/connector-utilities.ts`
**Impact**: Follow this pattern for any new monitoring/utility routes. Mount under `/api/indexes` before the 404 handler.

**Category**: gotcha
**Learning**: `IConnectorAuditEntry` is NOT exported from `@agent-platform/database/models` — only from the main `@agent-platform/database` barrel. Use `import type { IConnectorAuditEntry } from '@agent-platform/database'` not `from '@agent-platform/database/models'`.
**Files**: `src/services/connector-monitoring.service.ts`
**Impact**: Check the actual exports before importing types from database subpaths.

**Category**: gotcha
**Learning**: Adding fields to Mongoose Schema nested subdocuments (like `syncState`) with `{ type: String, enum: [...] }` causes TypeScript inference failures with `SchemaDefinitionProperty`. Use `{ type: String, default: null }` without enum constraint in the schema — rely on the TypeScript interface for type safety. The `string | null` type in the interface is sufficient.
**Files**: `packages/database/src/models/connector-config.model.ts`
**Impact**: Avoid `enum` constraint in deeply nested Mongoose schema type definitions when strict TypeScript checking is needed.

**Category**: pattern
**Learning**: SSRF protection for webhook tests: resolve hostname via `dns.promises.lookup()`, check IP against RFC 1918 private ranges + loopback + link-local. Use `AbortController` with 10s timeout for the actual HTTP request.
**Files**: `src/services/connector-notification.service.ts`
**Impact**: Follow this pattern for any feature that makes HTTP requests to user-provided URLs.

---

## 2026-03-24 — SharePoint Connector UX Wave 4 Batch 1 (Fleet Ops & Config Management)

**Category**: gotcha
**Learning**: `getRedisConnection()` from `workers/shared.ts` returns `ConnectionOptions` (host/port/password), NOT a Redis instance. Services that need a Redis client must create their own: `new Redis(opts as RedisOptions)` from ioredis. Cache the instance as a module-level singleton.
**Files**: `src/services/connector-presence.service.ts`
**Impact**: Any new service needing direct Redis access must create its own client from connection options.

**Category**: gotcha
**Learning**: `EndUserOAuthToken` has `scope` (singular, space-separated string), NOT `scopes` (array). It also has NO `connectorId` field. To find a connector's token, look up `connector.oauthTokenId` then `EndUserOAuthToken.findOne({ _id: oauthTokenId, tenantId })`.
**Files**: `src/services/connector-security.service.ts`
**Impact**: Critical for any code accessing OAuth tokens — the schema differs from what you might expect.

**Category**: pattern
**Learning**: Bulk action routes should be registered as static routes (`POST /:indexId/connectors/bulk-actions`) BEFORE parameterized routes (`GET /:indexId/connectors/:connectorId`). Express matches top-down, so `bulk-actions` would be captured as a connectorId otherwise.
**Files**: `src/routes/connectors.ts`
**Impact**: Follow Express route ordering rules for any new static connector routes.

**Category**: pattern
**Learning**: Content purge uses async background deletion with cancellation checks between batches. The `runPurgeAsync` pattern fires-and-forgets but updates a ConnectorCleanupJob document that clients poll. Always check `syncState.syncInProgress` before allowing purge (409 conflict).
**Files**: `src/services/connector-content-purge.service.ts`
**Impact**: Follow this pattern for long-running background operations that need progress tracking and cancellation.

## 2026-03-24 — SharePoint Wave 4 Batch 2 (Config Management, Multi-Connector)

**Category**: gotcha
**Learning**: `getConnector()` in connector.service.ts returns `{ connector, source }` — NOT the connector directly. When writing `cloneConnector` or any function that calls `getConnector`, destructure: `const { connector } = await getConnector(id, tenantId)`. Accessing `.connectionConfig` on the raw return value gives a type error.
**Files**: `src/services/connector.service.ts`
**Impact**: Always destructure getConnector() return value.

**Category**: gotcha
**Learning**: The unbounded-collections hook blocks `new Set()` and `new Map()` without size management. In service code that computes diffs/unions, use object-based key patterns: `const allKeysObj: Record<string, true> = {}; for (const k of keys) allKeysObj[k] = true; const allKeys = Object.keys(allKeysObj);`
**Files**: `src/services/connector-config-mgmt.service.ts`, `src/services/connector-config-version.service.ts`
**Impact**: Use object pattern instead of Set for any key union/dedup operations.

**Category**: pattern
**Learning**: Config management routes (export, drift, import) follow the same handleError + Zod pattern as other connector routes. Drift detection compares current connector config against the template's stored configSnapshot. Import is two-phase: preview (parse + validate) then confirm (create connector). Clone uses dynamic import of createConnector to avoid circular deps.
**Files**: `src/routes/connector-config-mgmt.ts`, `src/routes/connector-multi.ts`, `src/services/connector-template.service.ts`
**Impact**: Follow two-phase pattern for any destructive import operations. Use dynamic imports when services have circular dependency risk.

---

## 2026-03-25 — Connector E2E Tests (Phase 6: Discovery-to-Sync)

**Category**: pattern
**Learning**: E2E tests for SearchAI connector routes use DI-injected fake queue factory (`setQueueFactory()` / `resetQueueFactory()` from `workers/shared.ts`) instead of vi.mock. The fake queue captures `add()` calls in a `capturedJobs` array. Auth is injected via a simple Express middleware that sets `req.tenantContext` — no mocking of the auth module needed. Routes are imported dynamically in `createTestApp()` to ensure they bind to the test MongoDB connection (models must be registered via `setupTestMongo()` first).
**Files**: `src/workers/shared.ts`, `src/__tests__/e2e/connector-discovery-sync.e2e.test.ts`
**Impact**: Follow this DI pattern for any future E2E tests that need to intercept BullMQ queue operations. Never use vi.mock in E2E tests.

**Category**: gotcha
**Learning**: Redis ECONNREFUSED errors appear in stderr during E2E tests because `connector.service.ts` creates a lazy Redis connection for device code sessions at module scope. These are non-fatal and don't affect test results since the fake queue factory handles all queue operations. If a test actually needs Redis (e.g., testing device code flow), use a real Redis or mock at the service level via DI.
**Files**: `src/__tests__/e2e/connector-discovery-sync.e2e.test.ts`
**Impact**: Don't be alarmed by Redis ECONNREFUSED in test output — check actual test results.

**Category**: gotcha
**Learning**: E2E tests in `src/__tests__/e2e/` are excluded from the default `vitest.config.ts` and included in `vitest.forks.config.ts` to avoid double-execution. The forks config has 60s timeouts (increased from 30s) to accommodate MongoMemoryServer startup.
**Files**: `vitest.config.ts`, `vitest.forks.config.ts`
**Impact**: When adding new E2E tests, add them to `vitest.forks.config.ts` include list. They are already excluded from the default config via `src/__tests__/e2e/**` glob.

## 2026-04-18 — Document Vocabulary Alias Drift

**Category**: testing
**Learning**: `document-vocabulary-generator.test.ts` must assert aliases from `packages/search-ai-internal/src/canonical/document-field-vocabulary.ts`, not from older `source_type` defaults. After the dynamic-vocabulary refactor, `mime_type` is only included when passed explicitly and its aliases are `file type`/`document type`/`format`/`extension`/`file format`; the `source` alias belongs to `source_type`.
**Files**: `src/services/__tests__/document-vocabulary-generator.test.ts`, `src/services/document-vocabulary-generator.ts`, `../../packages/search-ai-internal/src/canonical/document-field-vocabulary.ts`
**Impact**: When core document-field aliases change, update the canonical vocabulary and generator tests together or CI will fail in `@agent-platform/search-ai#test:fast` with stale expectations.

## 2026-04-20 — Zendesk & ServiceNow Connector Test Spec (F099)

**Category**: testing
**Learning**: E2E tests for Zendesk/ServiceNow sync flows live in `src/__tests__/e2e/` and target the SearchAI HTTP API (`POST /api/indexes/:indexId/connectors`, `POST /api/connectors/:connectorId/sync/start`, `GET /api/connectors/:connectorId/sync/status`). External HTTP clients (`ZendeskClient`, `ServiceNowClient`) are mocked only via DI constructor injection — never via `vi.mock`. Sync status assertions must check `documentsProcessed` and `documentsFailed` fields from `SyncResult` (not raw DB access). The BullMQ sync worker is invoked directly (not via queue) in E2E tests — follow the `setQueueFactory()` / capture pattern established in `connector-discovery-sync.e2e.test.ts`.
**Files**: `src/__tests__/e2e/zendesk-sync-flow.e2e.test.ts` (planned), `src/__tests__/e2e/servicenow-sync-flow.e2e.test.ts` (planned)
**Impact**: When adding Zendesk/ServiceNow sync E2E tests, inject the HTTP clients via the coordinator constructor — the coordinator factory in the worker must accept an optional client override for testability.

## 2026-04-26 — Connector Boundary Strictness & Side-Effect Logging (ABLP-578)

**Category**: pattern
**Learning**: Connector route schemas should use `z.strictObject(...)` at the HTTP boundary, and routes must explicitly return `400` when `safeParse()` fails instead of falling back to `undefined` options. For worker side effects, the shared contract is `runBestEffortWorkerSideEffect()` for logged best-effort audit/telemetry writes, while state-consistency writes like `SearchSource` error-state updates must not be swallowed and should be wrapped with `createWorkerSideEffectFailure()` if they fail during error handling.
**Files**: `src/routes/connectors.ts`, `src/routes/connector-*.ts`, `src/workers/shared.ts`, `src/workers/connector-sync-worker.ts`, `src/__tests__/routes/connector-route-strictness.test.ts`, `src/workers/__tests__/shared-side-effects.test.ts`
**Impact**: Future connector route additions should default to strict request schemas, and async worker cleanup/audit paths should either log best-effort failures through the shared helper or propagate wrapped errors when the side effect is required for state correctness.

---

## 2026-04-23 — Discovery Panel Implementation (Crawler UX)

**Category**: gotcha
**Learning**: `interventionQueues` (in-memory Map in `crawl-browser-discover.ts`) must be cleaned up when an exploration completes — add `interventionQueues.delete(state.id)` in `closeAllListeners()`. Without this, command queues for completed explorations accumulate indefinitely.
**Files**: `src/routes/crawl-browser-discover.ts`
**Impact**: Any in-memory Map associated with an exploration lifecycle must be cleaned up in `closeAllListeners()`.

**Category**: pattern
**Learning**: SSRF protection for user-provided URLs uses `isPrivateOrUnsafeUrl()` checking RFC 1918 ranges (127/10/172.16/192.168/169.254), non-HTTP schemes, and `0.x.x.x`. Applied to intervention endpoint payloads (both single `url` and `urls` arrays). SSE error broadcasts use generic messages — raw errors logged server-side only.
**Files**: `src/routes/crawl-browser-discover.ts`
**Impact**: Any endpoint accepting user URLs must validate with SSRF protection. Any SSE broadcasting errors must sanitize before sending to client.

---

## 2026-04-30 — Crawler Route Architecture

**Category**: architecture
**Learning**: Crawl functionality is spread across 7 route files all mounted at `/api/crawl` (except `crawler-ingestion.ts` at `/api/crawler`). The mounting order in `server.ts` matters — Express matches top-down. Route files and their responsibilities: `intelligence.ts` (single-page LLM analysis + multi-page crawl), `crawl.ts` (batch submission, profiling, clustering, preferences, job CRUD — 16 endpoints), `crawl-discover.ts` (HTTP pattern-guided recursive discovery with SSE), `crawl-browser-discover.ts` (Playwright exploration via MCP server with SSE proxy + interventions), `crawl-drafts.ts` (multi-step draft persistence with bucket URL storage), `crawl-preview.ts` (Readability extraction preview), `crawler-ingestion.ts` (HTML ingestion from Go worker).
**Files**: `src/server.ts` (lines 249-255), `src/routes/crawl*.ts`, `src/routes/intelligence.ts`, `src/routes/crawler-ingestion.ts`
**Impact**: New crawl endpoints should go in the existing route file that matches their domain. History/job listing is in `crawl.ts`, discovery in `crawl-discover.ts`/`crawl-browser-discover.ts`. Architecture doc: `docs/searchai/design/CRAWLER-SYSTEM-ARCHITECTURE.md`.

**Category**: architecture
**Learning**: Two crawler workers consume BullMQ queues: `intelligence-crawl-worker.ts` (queue: `intelligence-crawl`, concurrency 1, 10-min lock, per-tenant Redis distributed lock) handles multi-page LLM crawl with handler reuse + quality gating. `crawler-ingestion-worker.ts` (queue: `content-processing`, concurrency 3, 2-min lock) consumes `BatchResult` from the Go worker and ingests via `CrawlerIngestionService`. Both are started independently from the main pipeline workers.
**Files**: `src/workers/intelligence-crawl-worker.ts`, `src/workers/crawler-ingestion-worker.ts`
**Impact**: The Go worker publishes to `content-processing` queue; intelligence route publishes to `intelligence-crawl` queue. Do not merge these — they have fundamentally different concurrency and locking requirements.

### 2026-05-10 — Per-URL / per-page batches must use `Promise.all`, never `redis.pipeline`

**Category**: cluster-safety
**Learning**: Two pipelines fanned out across per-URL or per-page keys: `bulk-crawl-worker.ts:834` (`pipeline.del` for `crawl:checkpoint:{tenantId}:{jobId}:{urlHash}`) and `intelligence.ts:994` (`pipeline.get` for `intelligence-crawl:page:{tenantId}:{jobId}:*`). Each URL hash / page key lands in a different cluster slot, so a single pipeline returns `CROSSSLOT`. Fix: replace each with `Promise.all(keys.map(k => redis.del(k)))` (or `.get(k).then(([null, val], [err, null]))` to preserve the `[err, val]` reader shape downstream).
**Files**: `src/workers/bulk-crawl-worker.ts`, `src/routes/intelligence.ts`
**Impact**: When iterating crawl URLs / pages and writing per-key in this package, use `Promise.all`. The general rule: a `redis.pipeline()` is only safe when every command targets the **same** hash slot — typically a single key, a hash-tagged family `{...}`, or one global set. Cross-URL, cross-page, cross-tenant, cross-host batches must be `Promise.all`.

## 2026-05-15 — Workflow Docling Worker (Phase 1-4) — ABLP-1073

**Category**: architecture | pattern | gotcha
**Learning**: The Docling extraction worker is now two-queued: existing `search-docling-extraction` (ingestion path, untouched) PLUS new `workflow-docling-extraction` (workflow-path, parks on a callback). Each queue has its own concurrency cap (env: `INGESTION_DOCLING_CONCURRENT_JOBS`, `WORKFLOW_DOCLING_CONCURRENT_JOBS`) summing to a runtime-enforced cap. The workflow branch lives in `src/workers/branches/extraction-only.ts` — it re-validates SSRF on the inbound URL (Redis-hop defense), streams via `streamUrlToDocling` (NOT `safeFetch` for outbound multipart — `safeFetch.normalizeBody` rejects ReadableStreams; use `node:http.request` directly), normalizes via `normalizeDoclingToEnvelope`, applies inline-cap (`DOCLING_WORKFLOW_INLINE_CAP_BYTES`, default 50 MB), and POSTs the callback via `callback-poster.ts` (5 attempts, exponential backoff, platform `buildSignatureHeaders` → `x-webhook-*` headers). The `callbackSecret` field arrives encrypted at-rest via the `workflow-docling-extraction` manifest entry; the worker calls `unwrapJobDataForDecrypt(...)` before destructuring. The callback poster splits 401 responses by `code` field — `TIMESTAMP_EXPIRED` vs `SIGNATURE_INVALID` — so clock-skew failures are observable in the `workflow_docling_callback_post_failures_total` `error_class` dimension. Metrics emission is log-line shaped (`extraction-metrics.ts`) until search-ai boots an OTel SDK; the queue-depth tick lives in the worker constructor (15 s `setInterval`, `.unref()`-ed).
**Files**: `src/workers/branches/extraction-only.ts`, `src/workers/branches/streaming-url-to-docling.ts`, `src/workers/branches/extraction-metrics.ts`, `src/workers/callback-poster.ts`, `src/workers/docling-extraction-worker.ts` (two-queue topology + metric ticks), `src/queues/queue-factory.ts` (`getWorkflowDoclingExtractionQueue`).
**Impact**: Future workflow-bound extractors mirror this branch pattern. Streaming HTTP request bodies must NOT go through `safeFetch`. The worker is responsible for SSRF on user-supplied URLs even when the engine already validated — Redis hops can outlive the engine's check.

---

## 2026-05-21 — ABLP-1073 Phase 5: SEC-10 Parity and Concurrency Tuning

### SEC-10 callbackUrl Hostname Validation

- Both ADI poll worker and Docling extraction worker must validate `callbackUrl` hostname against `WORKFLOW_ENGINE_PUBLIC_URL` AFTER decryption, BEFORE `postCallback()`.
- `EXPECTED_CALLBACK_HOST` is derived from `new URL(process.env.WORKFLOW_ENGINE_PUBLIC_URL).hostname` at module load.
- If validation is added to one worker, always check if parity fix is needed in the sibling worker. ADI had it; Docling was missing it (discovered in data-flow audit Round 2 as N-1).

### Concurrency

- `workflow-docling-extraction` worker: concurrency=3. `search-docling-extraction` (ingestion): concurrency=3. Total cap=6.
- Do NOT raise these without re-checking `docling-rate-limiter.ts` — the rate limiter enforces a global cap that spans both queues.

## 2026-05-21 — ABLP-1073 Phase 5: SEC-10 Parity Fix

**Category**: pattern | security

**SEC-10 callbackUrl hostname validation must be in BOTH workers**:

- ADI poll worker had SEC-10 validation. Docling extraction-only worker was missing it (found in data-flow audit Round 2 as N-1).
- Pattern: derive `EXPECTED_CALLBACK_HOST` from `new URL(process.env.WORKFLOW_ENGINE_PUBLIC_URL).hostname` at module load. Validate AFTER `unwrapJobDataForDecrypt`, BEFORE `postCallback()`. Throw on mismatch.
- When adding SEC-10 to one worker, always add parity check to sibling workers in the same PR.

**Files**: `src/workers/branches/extraction-only.ts` (EXPECTED_CALLBACK_HOST constant + validation block lines 43-108).

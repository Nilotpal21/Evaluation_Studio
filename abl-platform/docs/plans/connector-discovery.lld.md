# Connector Discovery & Permission Sync -- Low-Level Design

**Feature Spec**: `docs/features/connector-discovery.md`
**HLD**: `docs/specs/connector-discovery.hld.md`
**Testing Guide**: `docs/testing/connector-discovery.md`
**Status**: BETA

---

## Implementation Structure

### Routes

| File                                               | Endpoints                                                                                                                                                                                                                                                                    |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/search-ai/src/routes/connector-discovery.ts` | POST /connectors/:connectorId/discover, GET /discovery, GET /discovery/:discoveryId, GET /discovered-sites (paginated+searchable), GET /selected-sites, POST /select-sites, POST /recommendations, GET /recommendations, POST /recommendations/:id/accept, POST /quick-setup |

Route patterns:

- All endpoints validate `req.tenantContext` (401 if missing)
- Connector lookup: `ConnectorConfig.findOne({ _id: connectorId, tenantId })` (tenant-isolated)
- Error envelope: `{ success: true/false, data/error: { code, message } }`
- Discovery validation: connector must have `oauthTokenId` before discovery

### Workers

| File                                                       | Queue                   | Job Data                                                                                             | Purpose                                                                                            |
| ---------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `apps/search-ai/src/workers/connector-discovery-worker.ts` | `connector-discovery`   | `ConnectorDiscoveryJobData { connectorId, tenantId, connectorType, mode, sampleSize?, discoveryId }` | Resource discovery + profiling + optional recommendation                                           |
| `apps/search-ai/src/workers/schema-discovery-worker.ts`    | `schema-discovery`      | `SchemaDiscoveryJobData { tenantId, connectorId, knowledgeBaseId, connectorType, discoveryTrigger }` | Enriched schema discovery (field detection, template enrichment, field mapping suggestion enqueue) |
| `apps/search-ai/src/workers/idp-sync-scheduler.ts`         | Multiple (per provider) | --                                                                                                   | Creates BullMQ repeatable jobs for Azure AD, Okta, Google user and group sync                      |

### Services

| File                                                                          | Purpose                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/search-ai/src/services/setup/quick-setup-orchestrator.ts`               | `triggerDiscovery()`: creates ConnectorDiscovery record, enqueues job. `generateRecommendations()`: calls RecommendationEngineService. `acceptRecommendation()`: applies config, optionally triggers sync. |
| `apps/search-ai/src/services/recommendation/recommendation-engine.service.ts` | Analyzes discovery results (resource profiles) to generate optimal connector configuration recommendations                                                                                                 |

---

## Connector Discovery Worker Detail

The `processDiscoveryJob()` function executes:

1. **Acquire distributed lock**: `DistributedLockManager.acquire(connectorId, { keyPrefix: 'discovery-lock' })` with Redis SET NX PX.
2. **Load connector**: `ConnectorConfig.findOne({ _id: connectorId, tenantId })` -- tenant isolated.
3. **Resolve OAuth token**: `EndUserOAuthToken.findOne({ _id: connector.oauthTokenId, tenantId })`.
4. **Instantiate connector**: Currently only `SharePointConnector` from `@agent-platform/connector-sharepoint`. Extensible via factory pattern.
5. **Discover resources**: Call connector's `discoverResources()` method -- returns `DiscoveredResource[]` (sites, drives, libraries).
6. **Profile resources** (if mode != `discover_only`): Call connector's `profileResource()` per resource -- returns `ContentProfile { totalDocuments, totalSizeBytes, fileTypeDistribution, updateFrequency, dateRange }`.
7. **Update ConnectorDiscovery**: Store resources and profiles in MongoDB.
8. **Generate recommendations** (if mode == `quick_setup`): Call `RecommendationEngineService` with discovery results.
9. **Release lock**: `lock.release()` in finally block.

Worker uses `withTenantContext` and `withTraceContext` wrappers for tenant isolation and trace propagation.

---

## Site Selection Detail

The `POST /select-sites` endpoint:

1. Validates `siteIds` is a non-empty array.
2. Validates `mode` is `selected` or `excluded`.
3. Validates site IDs against latest discovery results (`discovery.resources.filter(r => r.resourceType === 'site')`).
4. Updates `ConnectorConfig.filterConfig.scope`: `{ siteMode: mode, siteIds: siteIds }`.
5. Increments `filterConfig.version`.

The `GET /discovered-sites` endpoint supports:

- Search: case-insensitive filter on name, displayName, url.
- Pagination: page/limit params with max limit 100.
- Enrichment: merges discovery profiles (document count, file types, update frequency) with site data.

---

## IdP Sync Scheduler Detail

The `idp-sync-scheduler.ts` manages scheduled IdP sync:

- **Supported providers**: Azure AD, Okta, Google.
- **Queues per provider**: Separate user-sync and group-sync queues (e.g., `QUEUE_AZUREAD_USER_SYNC`, `QUEUE_AZUREAD_GROUP_SYNC`).
- **Schedule**: BullMQ repeatable jobs at 2 AM UTC daily.
- **Startup**: `startScheduler()` called on server startup; queries `ILLMCredential` for configured tenants.
- **Shutdown**: `stopScheduler()` called on server shutdown.

---

## Known Gaps

1. **Connector factory**: Only SharePoint is instantiated; other connectors need factory registration.
2. **Schema discovery wiring**: Service factory in `schema-discovery-worker.ts` throws for unsupported types; full adapter wiring deferred.
3. **Route logging**: Uses `console.error` in catch blocks instead of `createLogger`.
4. **Lock cleanup**: If worker crashes between lock acquire and release, lock remains until TTL expires (30 min).
5. **Recommendation engine**: No test coverage for the recommendation generation algorithm.

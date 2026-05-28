# LLD + Implementation Plan: Connector Discovery

- **Feature ID**: #39
- **Status**: PLANNED
- **Created**: 2026-03-22
- **Last Updated**: 2026-03-22
- **HLD**: `docs/specs/connector-discovery.hld.md`
- **Test Spec**: `docs/testing/connector-discovery.md`
- **Feature Spec**: `docs/features/connector-discovery.md`

---

## 1. Implementation Overview

This plan addresses the 10 gaps identified in the HLD and brings the connector discovery feature from ALPHA to BETA quality. The implementation is divided into 5 phases, each independently shippable and testable.

### Current State Summary

| Component                    | Exists | Quality | Key Issues                              |
| ---------------------------- | ------ | ------- | --------------------------------------- |
| IResourceDiscovery interface | YES    | GOOD    | Well-designed, extensible               |
| BaseResourceDiscovery        | YES    | GOOD    | Template method pattern, shared helpers |
| SharePointResourceDiscovery  | YES    | GOOD    | Full implementation with Graph API      |
| ConnectorDiscovery model     | YES    | GOOD    | TTL, tenant isolation, indexes          |
| Discovery Worker             | YES    | MEDIUM  | Hard-coded switch, no trace events      |
| Discovery Routes             | YES    | MEDIUM  | console.log, no Zod validation          |
| Quick Setup Orchestrator     | YES    | MEDIUM  | No error recovery, no timeout           |
| Recommendation Engine        | YES    | GOOD    | Pure deterministic, well-tested         |
| Existing Unit Tests          | YES    | LOW     | Heavy mocking, low behavioral coverage  |
| E2E Tests                    | NO     | N/A     | Not implemented                         |
| Integration Tests            | NO     | N/A     | Not implemented                         |

### Phases Summary

| Phase | Focus                                       | Files Changed    | Exit Criteria                                                       |
| ----- | ------------------------------------------- | ---------------- | ------------------------------------------------------------------- |
| 1     | Code quality: logging, validation, registry | 4 files          | No console.log, Zod validation on all endpoints, connector registry |
| 2     | Observability: trace events, lock renewal   | 3 files          | TraceEvent emission, lock renewal for long discoveries              |
| 3     | Connector extensibility: Jira discovery     | 4 new files      | Jira discovery works end-to-end, registry handles 2+ types          |
| 4     | Integration tests                           | 3 new test files | INT-1 through INT-7 passing                                         |
| 5     | E2E tests                                   | 2 new test files | E2E-1 through E2E-7 passing                                         |

---

## 2. Phase 1: Code Quality Hardening

**Goal**: Fix gaps G-2, G-3, G-4 from HLD. Replace console.log with structured logging, add Zod request validation, introduce connector discovery registry.

### 2.1 Replace console.error with createLogger

**File**: `apps/search-ai/src/routes/connector-discovery.ts`

**Changes**:

- Add `import { createLogger } from '@abl/compiler/platform'`
- Replace all `console.error(...)` calls with `logger.error('message', { context })`
- Note: logger signature is `log.error('message', { context })` NOT pino-style

**Before**:

```typescript
console.error('[connector-discovery] Failed to trigger discovery:', errMsg);
```

**After**:

```typescript
const logger = createLogger('connector-discovery');
// ...
logger.error('Failed to trigger discovery', { connectorId, tenantId, error: errMsg });
```

### 2.2 Add Zod Request Validation

**File**: `apps/search-ai/src/routes/connector-discovery.ts`

**Add Zod schemas for all POST bodies**:

```typescript
import { z } from 'zod';

const DiscoverBodySchema = z.object({
  mode: z
    .enum(['discover_only', 'discover_and_profile', 'quick_setup'])
    .default('discover_and_profile'),
  sampleSize: z.number().int().min(1).max(1000).optional(),
});

const RecommendationsBodySchema = z.object({
  discoveryId: z.string().min(1),
});

const AcceptBodySchema = z.object({
  overrides: z.record(z.unknown()).optional(),
  startSync: z.boolean().default(false),
});

const QuickSetupBodySchema = z.object({
  startSync: z.boolean().default(false),
});
```

Apply validation at the start of each POST handler:

```typescript
const parseResult = DiscoverBodySchema.safeParse(req.body);
if (!parseResult.success) {
  res.status(400).json({
    success: false,
    error: { code: 'VALIDATION_ERROR', message: parseResult.error.issues[0].message },
  });
  return;
}
const { mode, sampleSize } = parseResult.data;
```

### 2.3 Connector Discovery Registry

**New File**: `apps/search-ai/src/services/discovery/connector-discovery-registry.ts`

Replace the hard-coded `switch (connectorType)` in the worker with a registry:

```typescript
import type { IConnectorConfig, IEndUserOAuthToken } from '@agent-platform/database/models';
import type { IResourceDiscovery } from '@agent-platform/connectors-base';
import type { Model } from 'mongoose';

type DiscoveryFactory = (
  config: IConnectorConfig,
  tokenModel: Model<IEndUserOAuthToken>,
) => Promise<IResourceDiscovery>;

const registry = new Map<string, DiscoveryFactory>();

export function registerDiscoveryProvider(connectorType: string, factory: DiscoveryFactory): void {
  registry.set(connectorType, factory);
}

export function getDiscoveryProvider(connectorType: string): DiscoveryFactory {
  const factory = registry.get(connectorType);
  if (!factory) {
    throw new Error(`No discovery provider registered for connector type: ${connectorType}`);
  }
  return factory;
}

export function getSupportedDiscoveryTypes(): string[] {
  return Array.from(registry.keys());
}
```

**Registration** (in worker init or server startup):

```typescript
registerDiscoveryProvider('sharepoint', async (config, tokenModel) => {
  const connector = new SharePointConnector(config, tokenModel);
  await connector.initialize();
  const discovery = connector.getResourceDiscovery?.();
  if (!discovery) throw new Error('SharePoint connector does not support resource discovery');
  return discovery;
});
```

**Worker update**: `apps/search-ai/src/workers/connector-discovery-worker.ts`
Replace switch statement with registry lookup:

```typescript
const factory = getDiscoveryProvider(connectorType);
const discovery = await factory(config.toObject(), EndUserOAuthToken);
```

### 2.4 Exit Criteria

- [ ] Zero `console.log` or `console.error` in `connector-discovery.ts` routes
- [ ] All 4 POST endpoints validate body with Zod schemas
- [ ] Connector registry pattern replaces hard-coded switch
- [ ] `pnpm build --filter=@agent-platform/search-ai` succeeds
- [ ] Existing unit tests still pass

---

## 3. Phase 2: Observability Enhancements

**Goal**: Fix gaps G-5 and G-10. Add TraceEvent emission for discovery operations and implement lock renewal for long-running discoveries.

### 3.1 TraceEvent Emission

**File**: `apps/search-ai/src/workers/connector-discovery-worker.ts`

Emit trace events at key milestones:

1. Discovery started (with connectorId, mode, tenantId)
2. Resources discovered (count, duration)
3. Profiling started (resource count)
4. Discovery completed (total duration, resource count, profile count)
5. Discovery failed (error message)
6. Recommendations generated (in quick_setup mode)

**Implementation**:

```typescript
import { TraceStore, createTraceEvent } from '@agent-platform/shared-observability';

// At discovery start:
await TraceStore.emit(
  createTraceEvent({
    type: 'connector.discovery.started',
    tenantId,
    metadata: { connectorId, connectorType, mode },
  }),
);

// At discovery completion:
await TraceStore.emit(
  createTraceEvent({
    type: 'connector.discovery.completed',
    tenantId,
    metadata: { connectorId, resources: resources.length, profiles: profiles.length, durationMs },
  }),
);
```

Note: Must read `TraceStore` and `createTraceEvent` signatures from source before implementation.

### 3.2 Lock Renewal for Long Discoveries

**File**: `apps/search-ai/src/workers/connector-discovery-worker.ts`

For tenants with many sites (500+), discovery can exceed the 10-minute lock TTL. Implement periodic lock renewal:

```typescript
const LOCK_TTL_MS = 600_000; // 10 minutes
const LOCK_RENEWAL_INTERVAL_MS = 300_000; // Renew every 5 minutes

let renewalTimer: NodeJS.Timeout | undefined;

function startLockRenewal(lockMgr: DistributedLockManager, lock: LockHandle): void {
  renewalTimer = setInterval(async () => {
    try {
      await lockMgr.renew(lock, LOCK_TTL_MS);
    } catch {
      // If renewal fails, the lock will expire naturally
    }
  }, LOCK_RENEWAL_INTERVAL_MS);
}

function stopLockRenewal(): void {
  if (renewalTimer) {
    clearInterval(renewalTimer);
    renewalTimer = undefined;
  }
}
```

Note: Must verify `DistributedLockManager.renew()` exists in the source. If not, implement renewal via re-acquire with same key.

### 3.3 Exit Criteria

- [ ] Discovery operations emit TraceEvents at start, completion, and failure
- [ ] Lock renewal prevents expiry during long-running discoveries
- [ ] Trace events visible in observatory (if connected)
- [ ] `pnpm build --filter=@agent-platform/search-ai` succeeds

---

## 4. Phase 3: Connector Extensibility (Jira Discovery)

**Goal**: Fix gap G-1. Implement `IResourceDiscovery` for Jira connector to validate the extensibility of the discovery framework.

### 4.1 Jira Resource Discovery Service

**New File**: `packages/connectors/base/src/discovery/jira-resource-discovery.ts` (or in a `packages/connectors/jira/` package if it exists)

Jira discovery discovers:

- **Projects** (resourceType: 'project'): via Jira REST API `/rest/api/3/project`
- **Issue Types** per project (resourceType: 'issuetype'): metadata for content profiling
- **Boards** (resourceType: 'board'): for Jira Software agile boards

Content profiling for Jira:

- Sample issues from a project to analyze: field usage, attachment types, update frequency
- `fileTypeDistribution` maps to attachment extensions
- `updateFrequency` based on issue modification dates

### 4.2 Registry Registration

Register Jira discovery provider:

```typescript
registerDiscoveryProvider('jira', async (config, tokenModel) => {
  // Initialize Jira HTTP client with OAuth token
  // Return JiraResourceDiscovery instance
});
```

### 4.3 Tests for Jira Discovery

- Unit tests for JiraResourceDiscovery with mocked Jira API
- Verify resource hierarchy: projects -> issue types
- Verify content profiling: field analysis, attachment distribution

### 4.4 Exit Criteria

- [ ] JiraResourceDiscovery implements IResourceDiscovery
- [ ] Discovery worker handles `connectorType: 'jira'` via registry
- [ ] Unit tests pass for Jira discovery
- [ ] `pnpm build` succeeds across affected packages
- [ ] Existing SharePoint tests unaffected

---

## 5. Phase 4: Integration Tests

**Goal**: Implement integration test scenarios INT-1 through INT-7 from test spec.

### 5.1 Test Infrastructure

**File**: `apps/search-ai/src/__tests__/integration/connector-discovery.integration.test.ts`

Setup:

- MongoMemoryServer for test MongoDB
- Redis (real or ioredis-mock for CI)
- Seeded tenant contexts
- nock/msw for external API mocking (Graph API)

### 5.2 Test Implementation Order

1. **INT-1**: Recommendation Engine Scoring Accuracy -- pure function, easiest to verify
2. **INT-4**: Sensitivity Detection Patterns -- pure function with comprehensive inputs
3. **INT-5**: Update Frequency Calculation -- pure function with date arrays
4. **INT-2**: Quick Setup Orchestrator with Real MongoDB -- requires DB setup
5. **INT-3**: Discovery Worker Processing Pipeline -- requires BullMQ + DB
6. **INT-6**: Concurrent Access Locking -- requires Redis
7. **INT-7**: Schema Discovery Trigger After Acceptance -- requires queue inspection

### 5.3 Exit Criteria

- [ ] All 7 integration tests pass
- [ ] Tests use real MongoDB (not mocked)
- [ ] External APIs (Graph API) mocked via nock/msw only
- [ ] No vi.mock of codebase components
- [ ] Tests run in CI pipeline

---

## 6. Phase 5: E2E Tests

**Goal**: Implement E2E test scenarios E2E-1 through E2E-7 from test spec.

### 6.1 Test Infrastructure

**File**: `apps/search-ai/test/e2e/connector-discovery.e2e.test.ts`

Setup:

- Real Express server on random port (`{ port: 0 }`)
- Full middleware chain (auth, tenant context, rate limiting)
- MongoMemoryServer for test MongoDB
- Redis for BullMQ and distributed locks
- nock/msw for external API mocking (only third-party APIs)
- Seeded ConnectorConfig, SearchSource, EndUserOAuthToken documents

### 6.2 Test Implementation Order

1. **E2E-5**: Unauthenticated Connector Rejection -- simplest, no async waiting
2. **E2E-6**: Non-Existent Connector 404 -- simple validation
3. **E2E-1**: Full Discovery Lifecycle -- core flow
4. **E2E-2**: Quick Setup One-Click Flow -- builds on E2E-1
5. **E2E-3**: Tenant Isolation -- security verification
6. **E2E-4**: Discovery Failure and Error Recovery -- error paths
7. **E2E-7**: Recommendation Accept with Overrides -- advanced flow

### 6.3 Test Helper Utilities

```typescript
// Wait for discovery to complete (with timeout)
async function waitForDiscoveryCompletion(
  baseUrl: string,
  connectorId: string,
  discoveryId: string,
  timeoutMs: number = 30000,
): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${baseUrl}/connectors/${connectorId}/discovery/${discoveryId}`);
    const body = await res.json();
    if (body.data.status === 'completed' || body.data.status === 'failed') {
      return body.data;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Discovery did not complete within timeout');
}

// Seed test data
async function seedConnectorConfig(db: Db, tenantId: string): Promise<string> {
  // Insert ConnectorConfig, SearchSource, EndUserOAuthToken
  // Return connectorId
}
```

### 6.4 Exit Criteria

- [ ] All 7 E2E tests pass
- [ ] Tests use real HTTP server with full middleware chain
- [ ] No mocking of codebase components
- [ ] External APIs mocked via nock/msw
- [ ] Tests run in CI pipeline
- [ ] Tenant isolation verified (cross-tenant returns 404)

---

## 7. Wiring Checklist

After all phases are complete, verify the following end-to-end wiring:

| Item                                  | Verification                                                     |
| ------------------------------------- | ---------------------------------------------------------------- |
| Routes registered in server.ts        | `connector-discovery` router is mounted at correct path          |
| Worker started in workers/index.ts    | `connectorDiscoveryWorker` is imported and started               |
| Model registered in ModelRegistry     | `ConnectorDiscovery` is registered for 'platform' database       |
| Model exported from packages/database | `IConnectorDiscovery`, `IConnectorRecommendation` in index.ts    |
| Connector registry initialized        | `registerDiscoveryProvider('sharepoint', ...)` called at startup |
| Schema discovery queue referenced     | `QUEUE_SCHEMA_DISCOVERY` import resolves correctly               |
| Zod schemas validate all body fields  | No unvalidated req.body access in POST handlers                  |
| Logger replaces console.error         | Zero console.log/error in discovery routes and worker            |
| Trace events emit correctly           | Discovery start/complete/fail events in TraceStore               |
| Lock renewal active                   | Timer starts and stops correctly in worker                       |

## 8. Risk Register

| Risk                                             | Probability | Impact | Mitigation                                                          |
| ------------------------------------------------ | ----------- | ------ | ------------------------------------------------------------------- |
| TraceStore API signature differs from assumption | MEDIUM      | LOW    | Read source before implementing; fall back to logger if unavailable |
| DistributedLockManager lacks renew() method      | MEDIUM      | LOW    | Implement renewal via release + re-acquire pattern                  |
| MongoMemoryServer fails in CI                    | LOW         | MEDIUM | Use Docker-based MongoDB in CI as fallback                          |
| Jira REST API requires different auth flow       | MEDIUM      | MEDIUM | Jira discovery is Phase 3; if auth is complex, defer to separate PR |
| E2E tests flaky due to timing                    | MEDIUM      | MEDIUM | Use polling with timeout instead of fixed delays                    |

## 9. Dependencies Between Phases

```
Phase 1 (Code Quality) ─── no dependencies
     │
     ▼
Phase 2 (Observability) ─── depends on Phase 1 (logger)
     │
     ▼
Phase 3 (Jira Discovery) ─── depends on Phase 1 (registry)
     │
     ▼
Phase 4 (Integration Tests) ─── depends on Phase 1 + 2
     │
     ▼
Phase 5 (E2E Tests) ─── depends on all prior phases
```

Phases 1, 2, and 3 can overlap. Phases 4 and 5 are sequential (E2E builds on integration infrastructure).

## 10. Estimated Effort

| Phase                      | Estimated Duration | Complexity |
| -------------------------- | ------------------ | ---------- |
| Phase 1: Code Quality      | 1 day              | LOW        |
| Phase 2: Observability     | 1 day              | MEDIUM     |
| Phase 3: Jira Discovery    | 2 days             | MEDIUM     |
| Phase 4: Integration Tests | 2 days             | MEDIUM     |
| Phase 5: E2E Tests         | 2 days             | HIGH       |
| **Total**                  | **8 days**         |            |

## 11. ALPHA -> BETA Promotion Criteria

| Criterion         | Requirement                                        | Status               |
| ----------------- | -------------------------------------------------- | -------------------- |
| Code quality      | No console.log, Zod validation, structured logging | Phase 1              |
| Observability     | TraceEvent emission, lock renewal                  | Phase 2              |
| Multi-connector   | At least 2 connector types supported               | Phase 3              |
| Integration tests | 7 scenarios passing                                | Phase 4              |
| E2E tests         | 7 scenarios passing                                | Phase 5              |
| Documentation     | Feature spec, test spec, HLD, LLD complete         | This document        |
| Security scan     | semgrep clean on discovery routes                  | Phase 1 verification |

## 12. Changelog

| Date       | Version | Change                                                        |
| ---------- | ------- | ------------------------------------------------------------- |
| 2026-03-22 | 1.0     | Initial LLD + implementation plan generated via SDLC pipeline |

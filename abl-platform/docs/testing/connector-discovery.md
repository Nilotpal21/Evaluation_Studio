# Test Spec: Connector Discovery

- **Feature ID**: #39
- **Status**: PLANNED
- **Created**: 2026-03-22
- **Last Updated**: 2026-03-22
- **Feature Spec**: `docs/features/connector-discovery.md`

---

## 1. Test Coverage Matrix

| Component                    | Unit                   | Integration | E2E     | Status  |
| ---------------------------- | ---------------------- | ----------- | ------- | ------- |
| RecommendationEngineService  | YES (existing)         | PLANNED     | PLANNED | Partial |
| BaseResourceDiscovery        | YES (existing)         | PLANNED     | N/A     | Partial |
| SharePointResourceDiscovery  | YES (existing)         | PLANNED     | PLANNED | Partial |
| ConnectorDiscovery Worker    | YES (existing)         | PLANNED     | PLANNED | Partial |
| Connector Discovery Routes   | YES (existing, mocked) | PLANNED     | PLANNED | Partial |
| Quick Setup Orchestrator     | NO                     | PLANNED     | PLANNED | Missing |
| Discovery Model (MongoDB)    | NO                     | PLANNED     | N/A     | Missing |
| Schema Discovery Integration | NO                     | PLANNED     | PLANNED | Missing |
| Studio Wizard (UI)           | NO                     | N/A         | PLANNED | Missing |

## 2. E2E Test Scenarios

All E2E tests interact exclusively via HTTP API. No mocks of existing components. Real Express servers started on random ports with full middleware chain (auth, rate limiting, tenant isolation, validation).

### E2E-1: Full Discovery Lifecycle

**Description**: Trigger discovery, poll until complete, generate recommendations, accept, verify connector config updated.

**Prerequisites**:

- Real Express server started on `{ port: 0 }`
- MongoDB with seeded ConnectorConfig (authenticated, with oauthTokenId)
- Redis for BullMQ and distributed locking
- Test connector type with stubbed external API (Graph API mock via nock/msw)

**Steps**:

1. `POST /connectors/:connectorId/discover` with `{ mode: "discover_and_profile" }`
2. Assert response: `{ success: true, data: { discoveryId, jobId, status: "pending" } }`
3. Poll `GET /connectors/:connectorId/discovery` until status is `completed`
4. Assert discovery has `resources` array with at least 1 resource
5. Assert discovery has `profiles` array with content profile data
6. `POST /connectors/:connectorId/recommendations` with `{ discoveryId }`
7. Assert response: `{ success: true, data: { resourceScores, syncStrategy, overallConfidence } }`
8. `POST /connectors/:connectorId/recommendations/:recommendationId/accept` with `{ startSync: false }`
9. Assert response: `{ success: true, data: { connector: { configurationSource: "quick_setup" } } }`
10. `GET /connectors/:connectorId` to verify filter config, permission mode, and configurationSource applied

**Assertions**:

- Discovery status transitions: pending -> discovering -> profiling -> completed
- Resources include both sites and drives with correct parentId linkage
- Profiles include fileTypeDistribution, dateRange, updateFrequency
- Resource scores have factors breakdown and reasoning text
- Connector config reflects accepted recommendation

### E2E-2: Quick Setup One-Click Flow

**Description**: Exercise the one-click quick setup path end-to-end.

**Prerequisites**: Same as E2E-1

**Steps**:

1. `POST /connectors/:connectorId/quick-setup` with `{ startSync: false }`
2. Assert response: `{ success: true, data: { discoveryId, jobId, status: "pending" } }`
3. Poll `GET /connectors/:connectorId/discovery` until status is `completed`
4. `GET /connectors/:connectorId/recommendations` to verify recommendations were auto-generated
5. Assert recommendation has resourceScores, syncStrategy, costEstimate
6. `POST /connectors/:connectorId/recommendations/:recommendationId/accept` with `{ startSync: true }`
7. Assert response includes `syncJobId`

**Assertions**:

- Quick setup auto-generates recommendations in worker (no separate POST needed)
- Recommendation status is `generated`
- Acceptance with `startSync: true` queues a full sync job
- Connector configurationSource is `quick_setup`

### E2E-3: Tenant Isolation in Discovery

**Description**: Verify that tenant A cannot access tenant B's discovery results or connectors.

**Prerequisites**: Two distinct tenant contexts seeded in DB

**Steps**:

1. Seed ConnectorConfig for tenant-A
2. Trigger discovery as tenant-A: `POST /connectors/:connectorId/discover`
3. Poll until completed as tenant-A
4. Attempt `GET /connectors/:connectorId/discovery` as tenant-B
5. Assert 404 (not 403)
6. Attempt `POST /connectors/:connectorId/recommendations` as tenant-B with valid discoveryId
7. Assert 404
8. Attempt `POST /connectors/:connectorId/quick-setup` as tenant-B
9. Assert 404

**Assertions**:

- All cross-tenant requests return 404
- No information about resource existence is leaked
- Discovery records are correctly scoped to tenantId

### E2E-4: Discovery Failure and Error Recovery

**Description**: Test error handling when the external API fails during discovery.

**Prerequisites**: Connector configured with mock that fails after partial discovery

**Steps**:

1. Configure test to make Graph API fail after 2 sites discovered
2. `POST /connectors/:connectorId/discover` with `{ mode: "discover_and_profile" }`
3. Poll `GET /connectors/:connectorId/discovery` until status is `failed`
4. Assert discovery record has `error` field with error message
5. Assert resources discovered before failure are NOT persisted (atomic failure)
6. Re-trigger discovery: `POST /connectors/:connectorId/discover`
7. Assert new discovery record is created (lock was released after failure)
8. Poll until new discovery completes successfully

**Assertions**:

- Failed discovery records the error message
- Distributed lock is released on failure (re-discovery is possible)
- Each discovery creates its own record (not overwriting failed one)

### E2E-5: Unauthenticated Connector Rejection

**Description**: Verify discovery is rejected if the connector has no OAuth token.

**Steps**:

1. Seed ConnectorConfig without `oauthTokenId`
2. `POST /connectors/:connectorId/discover`
3. Assert 400 with `{ error: { code: "NOT_AUTHENTICATED" } }`
4. `POST /connectors/:connectorId/quick-setup`
5. Assert 400 with `{ error: { code: "NOT_AUTHENTICATED" } }`

**Assertions**:

- Both discover and quick-setup endpoints require authentication
- Error response follows standard envelope format

### E2E-6: Discovery with Non-Existent Connector

**Description**: Verify 404 for discovery on a non-existent connector ID.

**Steps**:

1. `POST /connectors/non-existent-id/discover`
2. Assert 404 with `{ error: { code: "NOT_FOUND" } }`
3. `GET /connectors/non-existent-id/discovery`
4. Assert 404
5. `POST /connectors/non-existent-id/recommendations`
6. Assert 404

**Assertions**:

- All endpoints return 404 for non-existent connectors
- No server errors or stack traces

### E2E-7: Recommendation Accept with Overrides

**Description**: Accept a recommendation with user-specified overrides.

**Steps**:

1. Complete full discovery + recommendation generation
2. `POST /recommendations/:id/accept` with `{ overrides: { permissionMode: "full", filterConfig: { ... } }, startSync: false }`
3. Verify connector config uses override permission mode, not recommendation default
4. Verify connector config uses override filter config
5. Verify recommendation record has `userDecision.action: "modified"` and `userDecision.overrides`

**Assertions**:

- Overrides are applied to connector config
- Recommendation records both the override action and the override values
- Original recommendation is preserved for audit

## 3. Integration Test Scenarios

Integration tests verify service-to-service boundaries with real MongoDB but mocked external APIs (Graph API, Jira API, etc. via nock/msw -- only external third-party services, never codebase components).

### INT-1: Recommendation Engine Scoring Accuracy

**Description**: Verify scoring algorithm produces correct scores for known input profiles.

**Test Data**:

- Drive with daily updates, 500 docs, 80% PDFs, no sensitivity -> expect score >= 0.8
- Drive with no recent updates, 5 docs, 90% images -> expect score <= 0.3
- Drive with PII indicators, 1000 docs, weekly updates -> expect reduced score due to penalty

**Assertions**:

- Activity score matches threshold rules
- Size score follows bell curve (100-10K ideal)
- Content score correctly classifies rich vs binary content
- Sensitivity penalty correctly reduces overall score
- Recommendation threshold (0.3) is correctly applied

### INT-2: Quick Setup Orchestrator with Real MongoDB

**Description**: Test the three-step orchestrator flow with real database operations.

**Steps**:

1. Seed ConnectorConfig and SearchSource in MongoDB
2. Call `triggerDiscovery()` -- verify ConnectorDiscovery record created with status `pending`
3. Verify BullMQ job was queued with correct data
4. Manually simulate discovery completion by updating record
5. Call `generateRecommendations()` -- verify ConnectorRecommendation record created
6. Call `acceptRecommendation()` -- verify ConnectorConfig updated, schema discovery queued

**Assertions**:

- Each step creates/updates correct MongoDB documents
- Tenant isolation is maintained in all queries
- Schema discovery job is queued after acceptance

### INT-3: Discovery Worker Processing Pipeline

**Description**: Test the worker's processDiscoveryJob function with a real BullMQ job object and mocked connector.

**Steps**:

1. Create a mock Job object with ConnectorDiscoveryJobData
2. Seed ConnectorConfig with oauthTokenId
3. Execute processDiscoveryJob
4. Verify ConnectorDiscovery record transitions: pending -> discovering -> profiling -> completed
5. Verify resources and profiles are saved correctly
6. In quick_setup mode, verify ConnectorRecommendation is also created

**Assertions**:

- Status transitions happen in correct order
- Distributed lock is acquired and released
- Progress updates are emitted (0-100%)
- Error recovery releases lock and sets status to `failed`

### INT-4: Sensitivity Detection Patterns

**Description**: Test the BaseResourceDiscovery sensitivity detection with comprehensive input data.

**Test Data**:

- Filenames containing "SSN-records.xlsx", "payroll-2025.csv" -> expect ['pii', 'financial']
- Filenames containing "patient-records.pdf", "HIPAA-compliance.docx" -> expect ['pii', 'health']
- Filenames containing "quarterly-report.pptx", "meeting-notes.docx" -> expect []
- Metadata containing "This folder has tax returns" -> expect ['financial']

**Assertions**:

- PII patterns match: ssn, passport, driver license, credit card, bank account
- Financial patterns match: payroll, salary, invoice, tax return, budget
- Health patterns match: hipaa, medical, patient, phi
- Results are deduplicated
- Both filenames and string metadata values are scanned

### INT-5: Update Frequency Calculation

**Description**: Test the update frequency algorithm with various date distributions.

**Test Data**:

- 10 files all modified in last 3 days -> expect 'daily'
- 5 files modified in last 2 weeks -> expect 'weekly'
- 3 files modified 2 months ago -> expect 'monthly'
- All files modified over 6 months ago -> expect 'rarely'
- Empty dates array -> expect 'rarely'

**Assertions**:

- Daily detection requires >=5 modifications within 30 days AND most recent within 7 days
- Weekly detection: most recent within 30 days
- Monthly detection: most recent within 90 days
- Rarely: most recent over 90 days

### INT-6: Discovery Concurrent Access Locking

**Description**: Verify distributed lock prevents concurrent discovery for the same connector.

**Steps**:

1. Start first discovery for connector-A
2. Before first completes, attempt second discovery for connector-A
3. Assert second attempt fails with lock contention error
4. After first completes, verify lock is released
5. Third discovery for connector-A succeeds

**Assertions**:

- Only one discovery per connector runs at a time
- Lock is released on success AND on failure
- Lock has 10-minute TTL (auto-expires if worker crashes)

### INT-7: Schema Discovery Trigger After Acceptance

**Description**: Verify that accepting a recommendation queues a schema discovery job.

**Steps**:

1. Complete discovery + recommendation flow
2. Accept recommendation
3. Verify schema discovery queue has a job with correct connectorId, tenantId, knowledgeBaseId
4. Verify job data includes `discoveryTrigger: 'activation'`

**Assertions**:

- Schema discovery is triggered only on acceptance (not on discovery or recommendation generation)
- Job data includes the correct knowledgeBaseId from SearchSource

## 4. Unit Test Gaps (Current State)

Existing unit tests use heavy mocking (`vi.mock`) which masks real integration issues:

| File                                   | Tests | Issue                                                                                    |
| -------------------------------------- | ----- | ---------------------------------------------------------------------------------------- |
| `connector-discovery.test.ts` (routes) | 6     | Mocks DB, orchestrator, and worker -- tests only function callability, not real behavior |
| `connector-discovery-worker.test.ts`   | 2     | Mocks everything -- only tests module exports                                            |

These tests provide import/export validation but no behavioral coverage. The E2E and integration tests defined above are the real quality gates.

## 5. Test Environment Requirements

| Requirement       | Details                                             |
| ----------------- | --------------------------------------------------- |
| MongoDB           | Real instance (MongoMemoryServer for CI)            |
| Redis             | Real instance (for BullMQ and distributed locks)    |
| HTTP Server       | Express on random port `{ port: 0 }`                |
| External API Mock | nock or msw for Graph API responses                 |
| Auth              | Seeded tenant context via middleware                |
| Isolation         | Per-test tenant IDs to prevent cross-test pollution |

## 6. Test Data Fixtures

### Connector Config Fixture

```json
{
  "_id": "test-connector-1",
  "tenantId": "test-tenant-1",
  "connectorType": "sharepoint",
  "oauthTokenId": "test-token-1",
  "sourceId": "test-source-1",
  "status": "active"
}
```

### Discovery Result Fixture

```json
{
  "resources": [
    {
      "id": "site-1",
      "name": "Engineering",
      "displayName": "Engineering",
      "url": "https://...",
      "resourceType": "site",
      "parentId": null,
      "metadata": {}
    },
    {
      "id": "drive-1",
      "name": "Documents",
      "displayName": "Engineering / Documents",
      "url": "https://...",
      "resourceType": "drive",
      "parentId": "site-1",
      "metadata": {}
    }
  ],
  "profiles": [
    {
      "resourceId": "drive-1",
      "totalDocuments": 500,
      "totalSizeBytes": 52428800,
      "fileTypeDistribution": { "pdf": 200, "docx": 150, "xlsx": 100, "png": 50 },
      "dateRange": { "earliest": "2025-01-01T00:00:00Z", "latest": "2026-03-20T00:00:00Z" },
      "averageDocumentSizeBytes": 104857,
      "updateFrequency": "daily",
      "sensitivityIndicators": [],
      "sampleDocumentCount": 100
    }
  ]
}
```

## 7. Coverage Targets

| Layer                    | Target | Current       |
| ------------------------ | ------ | ------------- |
| Recommendation Engine    | 90%    | ~70% (unit)   |
| Discovery Worker         | 80%    | ~10% (mocked) |
| Routes                   | 85%    | ~20% (mocked) |
| Quick Setup Orchestrator | 80%    | 0%            |
| Base Resource Discovery  | 80%    | ~50% (unit)   |
| SharePoint Discovery     | 70%    | ~40% (unit)   |
| Overall Feature          | 80%    | ~30%          |

## 8. Changelog

| Date       | Version | Change                                        |
| ---------- | ------- | --------------------------------------------- |
| 2026-03-22 | 1.0     | Initial test spec generated via SDLC pipeline |

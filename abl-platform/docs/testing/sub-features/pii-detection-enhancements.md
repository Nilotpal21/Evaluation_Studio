# Testing Guide: PII Detection Enhancements

> **Feature Spec**: `../../features/sub-features/pii-detection-enhancements.md`
> **Parent Feature**: [PII Detection & Redaction](../pii-detection.md)
> **Status**: PLANNED
> **Last Updated**: 2026-03-27

---

## Current State

No tests exist for this enhancement yet. All scenarios below are planned.

---

## Coverage Matrix

| FR    | Requirement                                | Unit | Integration | E2E | Manual |
| ----- | ------------------------------------------ | ---- | ----------- | --- | ------ |
| FR-1  | All consumers route through registry       | ❌   | ❌          | ❌  | ❌     |
| FR-2  | Duplicate patterns eliminated              | ❌   | ❌          | ❌  | ❌     |
| FR-3  | Cloud tier in registry                     | ❌   | ❌          | ❌  | ❌     |
| FR-4  | CloudPIIRecognizer base class              | ❌   | ❌          | ❌  | ❌     |
| FR-5  | Google DLP / AWS Comprehend / Azure AI     | ❌   | ❌          | ❌  | ❌     |
| FR-6  | Per-project cloud provider config          | ❌   | ❌          | ❌  | ❌     |
| FR-7  | Credential resolution via auth profiles    | ❌   | ❌          | ❌  | ❌     |
| FR-8  | Latency budget enforcement                 | ❌   | ❌          | ❌  | ❌     |
| FR-9  | Redis content-hash cache                   | ❌   | ❌          | ❌  | ❌     |
| FR-10 | Rate limit + cost budget                   | ❌   | ❌          | ❌  | ❌     |
| FR-11 | Undashed SSN with validation               | ❌   | ❌          | ❌  | ❌     |
| FR-12 | Amex 15-digit + legacy Visa 13-digit       | ❌   | ❌          | ❌  | ❌     |
| FR-13 | E.164 international phone                  | ❌   | ❌          | ❌  | ❌     |
| FR-14 | IPv6 detection                             | ❌   | ❌          | ❌  | ❌     |
| FR-15 | IBAN with Mod 97 validation                | ❌   | ❌          | ❌  | ❌     |
| FR-16 | PIIType widened to string                  | ❌   | ❌          | ❌  | ❌     |
| FR-17 | ClickHouse pii_detections table            | ❌   | ❌          | ❌  | ❌     |
| FR-18 | Hourly/daily materialized views            | ❌   | ❌          | ❌  | ❌     |
| FR-19 | Dual-write audit logger                    | ❌   | ❌          | ❌  | ❌     |
| FR-20 | Observatory PII tab                        | ❌   | ❌          | ❌  | ❌     |
| FR-21 | Tenant + project analytics with time-range | ❌   | ❌          | ❌  | ❌     |
| FR-22 | Configurable gather exemptions             | ❌   | ❌          | ❌  | ❌     |
| FR-23 | Batch vault eviction                       | ❌   | ❌          | ❌  | ❌     |
| FR-24 | PII pattern CRUD E2E                       | ❌   | ❌          | ❌  | ❌     |
| FR-25 | Phone regex tightening (10-digit min)      | ❌   | ❌          | ❌  | ❌     |
| FR-26 | Tenant consent before cloud activation     | ❌   | ❌          | ❌  | ❌     |

---

## E2E Test Scenarios (minimum 6)

### E2E-1: PII Pattern CRUD with Real Auth and Tenant Isolation

**Objective**: Verify PII pattern CRUD via HTTP API with full middleware chain.
**Setup**: `RuntimeApiHarness` + `bootstrapProject()` for two tenants.
**Steps**:

1. POST create custom pattern for tenant A
2. GET list — tenant A sees pattern, tenant B gets empty list (404 on direct access)
3. PUT update pattern
4. POST test pattern against sample text
5. DELETE pattern
6. GET verify deleted

**Assertions**: Tenant isolation (cross-tenant returns 404), auth required (401 without JWT), permissions enforced (403 without `pii-pattern:write`).

### E2E-2: Unified Registry Detection Through HTTP API

**Objective**: Verify custom patterns work in guardrail evaluation path (not just NLU).
**Setup**: `RuntimeApiHarness` + create project with custom PII pattern + guardrail rule using `abl.contains_pii()`.
**Steps**:

1. Create custom PII pattern (e.g., `employee_id` matching `EMP-\d{6}`)
2. Configure output guardrail with `abl.contains_pii(output)` check
3. Send message that triggers agent response containing `EMP-123456`
4. Verify guardrail fires on the custom pattern (not just built-in types)

**Assertions**: Custom pattern detected in guardrail path. Detection event recorded.

### E2E-3: Cloud Provider Health and Fallback

**Objective**: Verify cloud provider status endpoint and fail-open behavior.
**Setup**: `RuntimeApiHarness` + project with cloud provider configured (mock external HTTP only).
**Steps**:

1. GET `/api/projects/:projectId/pii-providers/status` — verify circuit breaker state
2. Trigger 5 consecutive cloud API failures
3. GET status — verify circuit breaker is OPEN
4. Send message — verify detection still works (regex fallback)
5. Wait 30s, send message — verify half-open attempt

**Assertions**: Circuit breaker transitions logged. Detection continues in degraded mode. `pii_cloud_degraded` trace event emitted.

### E2E-4: PII Analytics API with Time-Range Filtering

**Objective**: Verify PII analytics endpoints return correct aggregated data.
**Setup**: `RuntimeApiHarness` + `bootstrapProject()`. PII detection events are generated organically by sending messages through the API (no direct ClickHouse seeding).
**Steps**:

1. Send multiple messages with various PII types
2. GET `/api/projects/:projectId/analytics/pii/summary?range=1h`
3. GET `/api/projects/:projectId/analytics/pii/by-type?range=1h`
4. GET `/api/projects/:projectId/analytics/pii/by-agent?range=1h`
5. GET `/api/projects/:projectId/analytics/pii/trend?range=1h`

**Assertions**: Correct counts per type. Tenant isolation on analytics. Auth required.

### E2E-5: New Regex Recognizers Through HTTP API

**Objective**: Verify new built-in recognizers (undashed SSN, Amex, E.164, IPv6, IBAN) work end-to-end.
**Setup**: `RuntimeApiHarness` + project with PII redaction enabled.
**Steps**:

1. POST test pattern endpoint with text containing undashed SSN `123456789`
2. POST test with text containing Amex card `378282246310005`
3. POST test with text containing E.164 phone `+442079460958`
4. POST test with text containing IPv6 `2001:0db8:85a3::8a2e:0370:7334`
5. POST test with text containing IBAN `GB29NWBK60161331926819`

**Assertions**: All new types detected. Correct type labels. Redaction labels applied.

### E2E-6: Cloud Provider Consent Gate

**Objective**: Verify cloud PII providers cannot be activated without tenant consent acknowledgment.
**Setup**: `RuntimeApiHarness` + `bootstrapProject()`.
**Steps**:

1. PUT `/api/projects/:projectId/pii-providers` with Google DLP config — expect 403 (no consent)
2. PATCH project runtime config to set `cloudPiiConsent: true`
3. PUT `/api/projects/:projectId/pii-providers` with Google DLP config — expect 200
4. Verify cloud provider is now active in provider status endpoint

**Assertions**: 403 response includes descriptive error about missing consent. After consent, provider activates successfully. Consent flag persisted in project runtime config.

---

## Integration Test Scenarios (minimum 5)

### INT-1: Registry Unification — All Consumers Use Registry

**Objective**: Verify `detectPII()`, `containsPII()`, `builtin-pii` provider, vault, and CEL functions all route through `PIIRecognizerRegistry`.
**Setup**: Custom registry with a test recognizer that detects `TEST-\d+`. Register it as permanent.
**Steps**:

1. Call `detectPII(text, registry)` with text containing `TEST-123` — verify detection
2. Call `containsPII(text, registry)` — verify true
3. Call `BuiltinPIIProvider.evaluate()` — verify detection (after provider wired to registry)
4. Create `PIIVault` with registry, tokenize text — verify `TEST-123` tokenized
5. Call CEL `abl.contains_pii()` with registry context — verify detection

**Assertions**: Same test recognizer fires in all 5 consumer paths.

### INT-2: Cloud Provider Loading Per-Session

**Objective**: Verify cloud recognizers are loaded per-session based on project config and credentials resolved.
**Setup**: Real MongoDB with project runtime config containing cloud provider entry. Auth profile with test credential.
**Steps**:

1. Load project config with `google_dlp` enabled and `credentialId`
2. Call `loadCloudProviders(tenantId, projectId, registry)`
3. Verify `cloud-google-dlp` recognizer registered in session registry
4. Verify credential resolved from auth profile

**Assertions**: Cloud recognizer registered with correct config. Credential available. Session isolation maintained.

### INT-3: ClickHouse PII Analytics Pipeline

**Objective**: Verify PII detection events are written to ClickHouse and queryable.
**Setup**: Real ClickHouse with `pii_detections` table.
**Steps**:

1. Write detection events via `BufferedClickHouseWriter`
2. Flush writer
3. Query `pii_detections_hourly` materialized view
4. Verify aggregated counts match

**Assertions**: Raw events written. MV aggregation correct. Tenant isolation in queries.

### INT-4: Dual-Write Audit Logger

**Objective**: Verify `PIIAuditLogger` writes to both MongoDB and ClickHouse.
**Setup**: MongoMemoryServer + ClickHouse.
**Steps**:

1. Configure `PIIAuditLogger` with dual-write stores
2. Log 10 detection events
3. Flush
4. Query MongoDB `pii_audit_logs` — verify 10 entries
5. Query ClickHouse `pii_detections` — verify 10 entries

**Assertions**: Both stores receive events. TTLs configured correctly.

### INT-5: Cloud Recognizer Circuit Breaker + Cache

**Objective**: Verify circuit breaker opens after failures and cache reduces API calls.
**Setup**: Mock cloud HTTP endpoint (DI — external service mock).
**Steps**:

1. Register cloud recognizer with 5-failure threshold
2. Trigger 5 consecutive API failures → circuit breaker OPEN
3. Call detect → returns empty (fail-open), no API call
4. Wait 30s → half-open
5. Success → circuit breaker CLOSED
6. Call detect twice with same text → second call hits Redis cache, no API call

**Assertions**: Circuit breaker state transitions. Cache hit on second call. Metrics recorded.

---

## Security & Isolation Tests

### SEC-1: Cross-Tenant Cloud Provider Isolation

Tenant A's cloud provider config/credentials must not be accessible to Tenant B. Cross-tenant analytics queries return empty results, not 403.

### SEC-2: Cloud Credential Never in Logs

Cloud API keys resolved via auth profiles must never appear in log output, trace events, or ClickHouse analytics data.

### SEC-3: Raw PII Never in Cache

Redis cache keys contain content hashes only. Cache values contain `PIIDetection[]` (type + position), never raw text or PII values.

### SEC-4: Analytics Data Contains No PII

ClickHouse `pii_detections` table contains type names and counts only. No raw PII values, no message content, no detected text.

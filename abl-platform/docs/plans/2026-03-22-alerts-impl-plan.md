# LLD + Implementation Plan: Alerts

**Feature:** alerts
**Status:** ALPHA
**Created:** 2026-03-22
**Last Updated:** 2026-03-22
**HLD Reference:** `docs/specs/alerts.hld.md`

---

## Executive Summary

This plan addresses the critical security vulnerabilities and production-readiness gaps in the Alerts feature. It is organized into 4 phases with clear exit criteria. Phase 1 (security hardening) is the highest priority and blocks BETA promotion.

---

## Phase 1: Security Hardening (P0)

**Goal:** Eliminate SQL injection and mass-assignment vulnerabilities.
**Duration:** 1-2 days
**Exit Criteria:**

- [ ] `metric` and `sourceTable` fields validated against allowlists at creation and evaluation time
- [ ] PUT endpoint uses field allowlist instead of raw `$set: req.body`
- [ ] All existing tests pass
- [ ] New unit tests cover allowlist validation (minimum 5 test cases)
- [ ] `pnpm build --filter=runtime` succeeds without type errors

### 1.1 ClickHouse Identifier Allowlist

**File:** `packages/pipeline-engine/src/schemas/alert-rule.schema.ts` (validation), `apps/runtime/src/routes/alerts.ts` (route), `packages/pipeline-engine/src/pipeline/services/alert-evaluator.service.ts` (evaluator)

**Design:**

Create a centralized allowlist module for valid ClickHouse identifiers:

```typescript
// packages/pipeline-engine/src/pipeline/services/clickhouse-allowlist.ts

/** Allowed ClickHouse tables that alert rules can query */
export const ALLOWED_SOURCE_TABLES = new Set([
  'abl_platform.conversation_sentiment',
  'abl_platform.session_metrics',
  'abl_platform.trace_events',
  'abl_platform.guardrail_events',
  'abl_platform.tool_executions',
]);

/** Allowed metric column names per table */
export const ALLOWED_METRICS: Record<string, Set<string>> = {
  'abl_platform.conversation_sentiment': new Set([
    'avg_sentiment',
    'sentiment_score',
    'positive_ratio',
    'negative_ratio',
  ]),
  'abl_platform.session_metrics': new Set([
    'error_rate',
    'avg_latency_ms',
    'session_count',
    'completion_rate',
    'avg_turns',
  ]),
  // ... extend as tables are added
};

/** Strict identifier regex: only alphanumeric, underscore, dot */
const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_.]*$/;

export function validateSourceTable(table: string): boolean {
  return SAFE_IDENTIFIER.test(table) && ALLOWED_SOURCE_TABLES.has(table);
}

export function validateMetric(table: string, metric: string): boolean {
  if (!SAFE_IDENTIFIER.test(metric)) return false;
  const allowedMetrics = ALLOWED_METRICS[table];
  return allowedMetrics ? allowedMetrics.has(metric) : false;
}
```

**Changes:**

1. Create `clickhouse-allowlist.ts` with table and metric allowlists
2. Add validation in POST `/` route (alerts.ts) before creating rule
3. Add validation in PUT `/:alertId` route before updating rule
4. Add defense-in-depth validation in `alert-evaluator.service.ts` before building query
5. Add defense-in-depth validation in test-fire endpoint before building query

### 1.2 PUT Endpoint Field Allowlist

**File:** `apps/runtime/src/routes/alerts.ts`

**Current (vulnerable):**

```typescript
const updated = await Model.findOneAndUpdate(
  { _id: alertId, tenantId, projectId },
  { $set: req.body }, // Mass assignment!
  { new: true },
);
```

**Fixed:**

```typescript
const ALLOWED_UPDATE_FIELDS = [
  'name',
  'metric',
  'sourceTable',
  'aggregation',
  'windowMinutes',
  'condition',
  'threshold',
  'channels',
  'enabled',
  'cooldownMinutes',
] as const;

const updates: Record<string, unknown> = {};
for (const field of ALLOWED_UPDATE_FIELDS) {
  if (req.body[field] !== undefined) {
    updates[field] = req.body[field];
  }
}

// Validate metric/sourceTable if being updated
if (updates.sourceTable || updates.metric) {
  const table = (updates.sourceTable as string) ?? rule.sourceTable;
  const metric = (updates.metric as string) ?? rule.metric;
  if (!validateSourceTable(table) || !validateMetric(table, metric)) {
    res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'Invalid sourceTable or metric',
      },
    });
    return;
  }
}

const updated = await Model.findOneAndUpdate(
  { _id: alertId, tenantId, projectId },
  { $set: updates },
  { new: true },
);
```

### 1.3 Test Cases for Security Hardening

| Test ID | Description                                        | Expected Result         |
| ------- | -------------------------------------------------- | ----------------------- |
| SEC-1   | Create rule with valid metric and sourceTable      | 200 OK                  |
| SEC-2   | Create rule with SQL injection in metric           | 400 INVALID_INPUT       |
| SEC-3   | Create rule with SQL injection in sourceTable      | 400 INVALID_INPUT       |
| SEC-4   | Create rule with unknown sourceTable               | 400 INVALID_INPUT       |
| SEC-5   | Create rule with metric not in allowlist for table | 400 INVALID_INPUT       |
| SEC-6   | PUT with tenantId in body (mass assignment)        | tenantId not changed    |
| SEC-7   | PUT with status in body (mass assignment)          | status not changed      |
| SEC-8   | Evaluator skips rule with invalid metric           | Rule evaluation skipped |

---

## Phase 2: Production Readiness (P1)

**Goal:** Make the alerting system safe for multi-pod deployment.
**Duration:** 2-3 days
**Exit Criteria:**

- [ ] Redis-backed cooldown store implemented and tested
- [ ] Redis-backed alert state store implemented and tested
- [ ] Distributed lock on scheduler evaluation cycle
- [ ] Max rules per project enforced (100)
- [ ] `pnpm build` succeeds
- [ ] Existing + new tests pass

### 2.1 Redis Cooldown Store

**File:** `packages/eventstore/src/alerting/redis-stores.ts` (new)

Implement `ICooldownStore` using Redis:

```typescript
export class RedisCooldownStore implements ICooldownStore {
  constructor(private readonly redis: RedisClient) {}

  async isInCooldown(ruleId: string): Promise<boolean> {
    const result = await this.redis.get(`alert:cooldown:${ruleId}`);
    return result !== null;
  }

  async setCooldown(ruleId: string, durationSeconds: number): Promise<void> {
    await this.redis.set(`alert:cooldown:${ruleId}`, '1', 'EX', durationSeconds);
  }

  async clearCooldown(ruleId: string): Promise<void> {
    await this.redis.del(`alert:cooldown:${ruleId}`);
  }

  async getAlertState(ruleId: string): Promise<AlertState> {
    const state = await this.redis.get(`alert:state:${ruleId}`);
    return (state as AlertState) ?? 'ok';
  }

  async setAlertState(ruleId: string, state: AlertState): Promise<void> {
    // State keys don't expire -- they track until rule is deleted
    await this.redis.set(`alert:state:${ruleId}`, state);
  }
}
```

### 2.2 Distributed Lock for Scheduler

**File:** `packages/eventstore/src/alerting/alert-scheduler.ts`

Add distributed lock acquisition before `evaluateAll()`:

```typescript
async evaluateAll(): Promise<void> {
  if (!this.running) return;

  // Acquire distributed lock to prevent duplicate evaluations
  const lockKey = 'alert:scheduler:lock';
  const lockTtlMs = this.pollIntervalMs || 60_000;
  const acquired = await this.lockStore.acquire(lockKey, lockTtlMs);
  if (!acquired) return; // Another pod is evaluating

  try {
    const rules = await this.config.ruleStore.getAllActiveRules();
    // ... existing evaluation logic
  } finally {
    await this.lockStore.release(lockKey);
  }
}
```

### 2.3 Max Rules Per Project

**File:** `apps/runtime/src/routes/alerts.ts`

Add a count check before creating a new rule:

```typescript
const MAX_RULES_PER_PROJECT = 100;

const existingCount = await Model.countDocuments({ tenantId, projectId });
if (existingCount >= MAX_RULES_PER_PROJECT) {
  res.status(400).json({
    success: false,
    error: {
      code: 'LIMIT_EXCEEDED',
      message: `Maximum of ${MAX_RULES_PER_PROJECT} alert rules per project`,
    },
  });
  return;
}
```

---

## Phase 3: E2E Test Coverage (P1)

**Goal:** Achieve minimum E2E and integration test coverage.
**Duration:** 2-3 days
**Exit Criteria:**

- [ ] 7 E2E tests pass (from test spec: E2E-1 through E2E-7)
- [ ] 6 integration tests pass (from test spec: INT-1 through INT-6)
- [ ] No mocking of codebase components in E2E tests
- [ ] Real Express server with full middleware chain
- [ ] SQL injection prevention verified in E2E

### 3.1 E2E Test Infrastructure

**File:** `apps/runtime/src/__tests__/e2e/alerts-e2e.test.ts` (new)

Test infrastructure setup:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

describe('Alerts E2E', () => {
  let server: http.Server;
  let baseUrl: string;
  let authToken: string;

  beforeAll(async () => {
    // Start real Express server on random port
    const app = createApp(); // Full app with all middleware
    server = app.listen(0);
    const address = server.address() as AddressInfo;
    baseUrl = `http://localhost:${address.port}`;

    // Authenticate and get token
    // ... real auth flow
  });

  afterAll(async () => {
    server.close();
  });

  // ... E2E test cases from test spec
});
```

### 3.2 E2E Test Scenarios

Implement all 7 E2E scenarios from `docs/testing/alerts.md`:

| ID    | Scenario                  | Key Assertions                       |
| ----- | ------------------------- | ------------------------------------ |
| E2E-1 | Alert Rule CRUD Lifecycle | Create, read, update, delete via API |
| E2E-2 | Tenant Isolation          | Cross-tenant returns 404             |
| E2E-3 | Alert Config CRUD + SSRF  | SSRF blocked on create and update    |
| E2E-4 | Alert Rule Validation     | Invalid inputs rejected with 400     |
| E2E-5 | Test-Fire + SQL Injection | Malicious identifiers rejected       |
| E2E-6 | Alert History             | Correct status and timestamps        |
| E2E-7 | Permission Enforcement    | Auth required, permissions checked   |

### 3.3 Integration Test Scenarios

Implement all 6 integration scenarios from `docs/testing/alerts.md`:

| ID    | Scenario                  | Dependencies                     |
| ----- | ------------------------- | -------------------------------- |
| INT-1 | Evaluator + Real MongoDB  | MongoMemoryServer                |
| INT-2 | Delivery + Real MongoDB   | MongoMemoryServer, mock webhook  |
| INT-3 | Scheduler + ClickHouse    | ClickHouse test instance or mock |
| INT-4 | Mongoose Model Validation | MongoMemoryServer                |
| INT-5 | Alert Config Route + Auth | MongoMemoryServer, real Express  |
| INT-6 | Webhook HMAC Verification | Mock HTTP server                 |

---

## Phase 4: Observability and Polish (P2)

**Goal:** Production observability and error handling improvements.
**Duration:** 1-2 days
**Exit Criteria:**

- [ ] TraceEvent emission from alert routes
- [ ] Audit logging for project-scoped alert rule CRUD
- [ ] Webhook secret encryption at rest
- [ ] Alert evaluation metrics (counters for evaluations, firings, deliveries)
- [ ] Documentation updated

### 4.1 TraceEvent Emission

Add TraceStore integration to alert routes:

```typescript
traceStore.addEvent({
  event_type: 'alert.rule.created',
  tenant_id: tenantId,
  project_id: projectId,
  timestamp: new Date(),
  data: { ruleId: rule._id, name, metric, threshold },
});
```

### 4.2 Audit Logging for Project-Scoped Routes

The tenant-scoped routes (`alert-config.ts`) already have audit logging. Add equivalent logging to the project-scoped routes (`alerts.ts`):

```typescript
writeAuditLog({
  action: 'alert_rule.created',
  userId,
  tenantId,
  metadata: { alertRuleId: rule._id, projectId, name },
});
```

### 4.3 Secret Encryption

Encrypt webhook URL and channel secrets at rest using the platform's encryption service:

```typescript
// Before storing
config.target = await encrypt(config.target, tenantEncryptionKey);

// Before delivery
const decryptedTarget = await decrypt(config.target, tenantEncryptionKey);
```

---

## Wiring Checklist

| Item                                       | Status  | Phase |
| ------------------------------------------ | ------- | ----- |
| Allowlist module created and exported      | PENDING | 1     |
| Allowlist validation in POST /alerts       | PENDING | 1     |
| Allowlist validation in PUT /alerts/:id    | PENDING | 1     |
| Allowlist validation in evaluator service  | PENDING | 1     |
| Allowlist validation in test-fire endpoint | PENDING | 1     |
| PUT field filtering implemented            | PENDING | 1     |
| Redis cooldown store created               | PENDING | 2     |
| Redis cooldown store wired to scheduler    | PENDING | 2     |
| Distributed lock in scheduler              | PENDING | 2     |
| Max rules limit in POST route              | PENDING | 2     |
| E2E test file created                      | PENDING | 3     |
| Integration test file created              | PENDING | 3     |
| TraceEvent in alert routes                 | PENDING | 4     |
| Audit logging in project routes            | PENDING | 4     |
| Secret encryption for webhook URLs         | PENDING | 4     |

## Risk Register

| Risk                                                | Severity | Mitigation                                       |
| --------------------------------------------------- | -------- | ------------------------------------------------ |
| Allowlist may not cover all valid tables/metrics    | MEDIUM   | Make allowlist configurable via environment/DB   |
| Redis store requires Redis connection in tests      | LOW      | Use ioredis-mock in unit tests                   |
| E2E tests need real MongoDB + auth setup            | MEDIUM   | Use MongoMemoryServer + test auth helpers        |
| Existing callers may pass now-invalid metric values | MEDIUM   | Log warnings for existing rules during migration |

## Dependencies Between Phases

```
Phase 1 (Security) ─── blocks ──→ Phase 3 (E2E Tests - SQL injection tests need the fix)
Phase 2 (Production)             Phase 3 (E2E Tests - can run in parallel with Phase 2)
Phase 1 + Phase 2 ──── blocks ──→ Phase 4 (Observability - polishes working system)
```

Phase 1 is strictly prerequisite for BETA promotion. Phases 2 and 3 can proceed in parallel after Phase 1 completes.

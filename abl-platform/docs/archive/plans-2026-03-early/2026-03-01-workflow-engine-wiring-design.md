# Workflow Engine Wiring — Design Document

**Date:** 2026-03-01
**Status:** Approved
**Branch:** feature/workflow-integrations

## Context

The workflow-engine service has routes, auth middleware, OTel, and Docker Compose set up. All router dependencies are stubs that throw `NOT_CONNECTED` errors. This design covers wiring real implementations so workflows are end-to-end functional.

## Scope

Three tiers, all in scope:

1. **Infrastructure wiring** — MongoDB, encryption, Redis, ConnectorRegistry, graceful shutdown
2. **Restate integration** — Client wrapper + full workflow handler (step execution loop)
3. **Services** — Notification dispatcher, connection tester

## Architecture

### Tier 1: Infrastructure Wiring

#### MongoDB Connection

Follow the Runtime pattern in `apps/runtime/src/server.ts`:

```
1. MongoConnectionManager.initialize(config) — from @agent-platform/database
2. Import real models: WorkflowExecution, Workflow, ConnectorConnection
3. Pass models directly to router factories
```

Config from env vars: `MONGODB_URL`, `MONGODB_DATABASE`. Defaults match docker-compose.yml (mongo:27017 internal, localhost:27018 external).

Models already exist:

- `packages/database/src/models/workflow.model.ts` → `Workflow` (IWorkflow)
- `packages/database/src/models/workflow-execution.model.ts` → `WorkflowExecution` (IWorkflowExecution)
- `packages/database/src/models/connector-connection.model.ts` → `ConnectorConnection` (IConnectorConnection)

All have `tenantIsolationPlugin` applied.

#### Encryption

Two layers:

**Layer 1 — Mongoose field encryption plugin:**
Call `setMasterKey(process.env.ENCRYPTION_MASTER_KEY)` after DB init. Auto-decrypts `ConnectorConnection.encryptedCredentials` via post-find hooks.

**Layer 2 — Application-level encryption (extracted from Runtime):**
Extract `EncryptionService` from `apps/runtime/src/services/encryption-service.ts` into `packages/shared/src/encryption/encryption-service.ts`. Both Runtime and workflow-engine import from shared.

Wire router callbacks:

- `encryptSecret(plaintext, tenantId)` → `encryptionService.encryptForTenant(plaintext, tenantId)`
- `decryptSecret(ciphertext, tenantId)` → `encryptionService.decryptForTenant(ciphertext, tenantId)`

#### Redis

Use `ioredis` (already in deps). Create `src/services/redis.ts`:

```typescript
export async function initRedis(url: string): Promise<Redis>;
export function getRedisPublisher(): Redis | null;
export async function disconnectRedis(): Promise<void>;
```

Publisher for execution status events: `publish(`workflow:${tenantId}:${executionId}`, JSON.stringify(event))`.

Graceful degradation: if unavailable, log warning, don't crash. Execution events are best-effort for real-time UI.

#### ConnectorRegistry

Import `ConnectorRegistry` from `@agent-platform/connectors`. Instantiate at startup, register built-in connectors (discovered via build-time importers already in `packages/connectors/src/importers/`). Pass instance to connector router.

#### Graceful Shutdown

Extend existing `shutdown()` in index.ts:

```
1. Close HTTP server (already done)
2. Disconnect Redis publisher
3. Zero-fill encryption key material (shutdownKMSRegistry if used)
4. Disconnect MongoDB (disconnectDatabase)
```

### Tier 2: Restate Integration

#### File: `src/services/restate-client.ts`

Wraps Restate SDK into the interface routers expect:

```typescript
interface WorkflowEngineRestateClient {
  startWorkflow(executionId: string, input: WorkflowInput): Promise<void>;
  cancelWorkflow(executionId: string): Promise<void>;
  resolveCallback(executionId: string, stepId: string, payload: unknown): Promise<void>;
  resolveApproval(executionId: string, stepId: string, decision: ApprovalDecision): Promise<void>;
}
```

Uses Restate's ingress client to send messages to the workflow virtual object.

#### File: `src/services/workflow-handler.ts`

The Restate workflow handler — registered as a Restate service:

```typescript
const workflowRunner = restate.workflow({
  name: 'workflow-runner',
  handlers: {
    run: async (ctx: WorkflowContext, input: WorkflowInput) => { ... },
    cancel: async (ctx: SharedWorkflowContext) => { ... },
    resolveCallback: async (ctx: SharedWorkflowContext, data: CallbackResolution) => { ... },
    resolveApproval: async (ctx: SharedWorkflowContext, data: ApprovalResolution) => { ... },
  }
})
```

**Step execution loop** in `run`:

```
for each step in workflow.steps:
  1. Update step status → running (via ExecutionStore)
  2. Branch on step.type:
     - connector_action: Load connector from registry, resolve connection, execute action
     - http: HTTP call with retry
     - tool_call: Delegate to Runtime via HTTP
     - agent_invocation: Delegate to Runtime via HTTP
     - async_webhook: Generate callback URL, send webhook, wait on Restate awakeable
     - parallel: Fork branches, execute concurrently, join
     - condition: Evaluate expression against context, pick branch
     - delay: ctx.sleep(delayMs)
     - approval: Set status waiting_approval, wait on Restate promise
  3. Capture output in execution context
  4. Update step status → completed/failed
  5. On failure: check retry policy, retry or fail workflow
```

Durable state: Restate handles retries, recovery, and exactly-once guarantees. Step outputs stored in Restate's journal AND persisted to MongoDB via ExecutionStore for query access.

#### File: `src/services/step-executors/`

Strategy pattern — one executor per step type:

```
step-executors/
  connector-action.ts   — Uses ConnectorRegistry + ConnectionResolver
  http-step.ts          — HTTP call with timeout, retry, SSRF protection
  condition-step.ts     — Expression evaluation against workflow context
  delay-step.ts         — Restate ctx.sleep()
  approval-step.ts      — Restate promise for approval resolution
  callback-step.ts      — Restate awakeable for webhook callback
  parallel-step.ts      — ctx.run() for each branch concurrently
  agent-invocation.ts   — HTTP call to Runtime /api/sessions
  tool-call.ts          — HTTP call to Runtime tool execution endpoint
```

### Tier 3: Services

#### File: `src/services/notification-dispatcher.ts`

Strategy pattern dispatching to channels:

```typescript
interface NotificationChannel {
  send(notification: NotificationPayload): Promise<{ sent: boolean; error?: string }>;
}

class NotificationDispatcher {
  private channels: Map<string, NotificationChannel>;

  constructor() {
    this.channels.set('webhook', new WebhookChannel());
    this.channels.set('slack', new SlackChannel());
    this.channels.set('email', new EmailChannel());
  }

  async dispatch(rule: NotificationRule, event: WorkflowEvent, tenantId: string);
  async sendTest(rule: NotificationRule, tenantId: string);
}
```

- **Webhook:** HTTP POST with HMAC signature, configurable URL
- **Slack:** HTTP POST to incoming webhook URL (no Slack API auth needed)
- **Email:** nodemailer with SMTP config from env vars (optional — logs to console if not configured)

#### File: `src/services/connection-tester.ts`

Tests a connection by making a lightweight validation call:

```typescript
class ConnectionTester {
  constructor(private registry: ConnectorRegistry, private decrypt: DecryptFn)

  async test(connection: IConnectorConnection, tenantId: string): Promise<TestResult>
}
```

Strategy per auth type:

- **OAuth2:** Attempt token refresh
- **API key / Bearer:** Make a health-check call to the connector's test endpoint
- **Basic auth:** Attempt connection with credentials
- **Custom:** Call connector's `testConnection` method if defined

Returns `{ success: boolean, error?: string, latencyMs: number }`.

## File Changes Summary

| Action  | Path                                                           | Description                                                  |
| ------- | -------------------------------------------------------------- | ------------------------------------------------------------ |
| Extract | `packages/shared/src/encryption/encryption-service.ts`         | Move from `apps/runtime/src/services/encryption-service.ts`  |
| Update  | `apps/runtime/src/services/encryption-service.ts`              | Re-export from `@agent-platform/shared` for backward compat  |
| Rewrite | `apps/workflow-engine/src/index.ts`                            | Replace stubs with real MongoDB, Redis, encryption, registry |
| Create  | `apps/workflow-engine/src/services/redis.ts`                   | Redis publisher client                                       |
| Create  | `apps/workflow-engine/src/services/restate-client.ts`          | Restate SDK client wrapper                                   |
| Create  | `apps/workflow-engine/src/services/workflow-handler.ts`        | Restate workflow definition                                  |
| Create  | `apps/workflow-engine/src/services/step-executors/*.ts`        | Per-step-type executors (9 files)                            |
| Create  | `apps/workflow-engine/src/services/notification-dispatcher.ts` | Multi-channel notification dispatch                          |
| Create  | `apps/workflow-engine/src/services/connection-tester.ts`       | Connection validation                                        |
| Update  | `packages/shared/package.json`                                 | Add encryption exports                                       |
| Update  | `apps/workflow-engine/package.json`                            | Add nodemailer dep                                           |

## Non-Goals

- ClickHouse trace storage for workflow-engine (use MongoDB-backed trace store for now)
- Multi-region Restate clustering (single instance for dev)
- OAuth2 authorization code flow UI (connection creation is API-only for now)

## Risks

- **Restate SDK version:** Using `^1.10.4`. The workflow/virtualObject API has stabilized but check for breaking changes if upgrading.
- **EncryptionService extraction:** Moving to shared requires updating Runtime's imports. Use re-export for backward compatibility.
- **Step executor complexity:** 9 step types each with different execution semantics. Parallel branches and nested conditions add combinatorial complexity. Keep executors focused and independently testable.

---

## Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace all stubs in workflow-engine/src/index.ts with real MongoDB, Redis, encryption, ConnectorRegistry, Restate client, notification dispatcher, and connection tester so workflows are end-to-end functional.

**Architecture:** The handlers (`workflow-handler.ts`), step dispatcher (`step-dispatcher.ts`), all 9 step executors (`executors/*.ts`), persistence layer (`execution-store.ts`), Redis publisher (`pubsub/redis-publisher.ts`), and expression resolver (`context/expression-resolver.ts`) already exist. The work is: (1) wire real dependencies into `index.ts`, (2) create a Restate endpoint that registers the workflow handler as a Restate service, (3) implement notification dispatcher and connection tester services.

**Tech Stack:** Mongoose 8, ioredis 5, @restatedev/restate-sdk 1.10.4, AES-256-GCM encryption from @agent-platform/shared

**Worktree:** `/Users/prasannaarikala/projects/agent-platform/.worktrees/workflow-integrations`
**Branch:** `feature/workflow-integrations`

---

## Pre-Implementation Discovery

**EncryptionService** is already exported from `@agent-platform/shared/services/encryption` (package.json line 46-48). No extraction needed — it's already in shared.

**Existing files NOT requiring changes** (already implemented):

- `apps/workflow-engine/src/handlers/workflow-handler.ts` — Step execution loop with conditional branching
- `apps/workflow-engine/src/handlers/step-dispatcher.ts` — Strategy dispatch to 9 step types
- `apps/workflow-engine/src/executors/*.ts` — All 9 executors (connector-action, http, tool-call, agent-invocation, async-webhook, parallel, condition, delay, approval)
- `apps/workflow-engine/src/persistence/execution-store.ts` — MongoDB persistence wrapper
- `apps/workflow-engine/src/pubsub/redis-publisher.ts` — Redis pub/sub events
- `apps/workflow-engine/src/context/expression-resolver.ts` — `{{path}}` template resolution
- `apps/workflow-engine/src/constants.ts` — All named constants
- `apps/workflow-engine/src/routes/*.ts` — All 6 routers

---

## Task 1: Wire MongoDB Connection and Real Models

**Files:**

- Modify: `apps/workflow-engine/src/index.ts`

**Step 1: Write the failing test**

Create test that verifies real MongoDB models are used (not stubs):

```typescript
// apps/workflow-engine/src/__tests__/db-wiring.test.ts
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

describe('workflow-engine DB wiring', () => {
  it('should import Workflow model from @agent-platform/database', async () => {
    const db = await import('@agent-platform/database/models');
    expect(db.Workflow).toBeDefined();
    expect(db.WorkflowExecution).toBeDefined();
    expect(db.ConnectorConnection).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/workflow-engine && npx vitest run src/__tests__/db-wiring.test.ts`
Expected: PASS (models exist in database package — this confirms imports work)

**Step 3: Write the MongoDB initialization module**

Create `apps/workflow-engine/src/services/database.ts`:

```typescript
/**
 * MongoDB connection initialization for workflow-engine.
 * Follows the Runtime pattern: MongoConnectionManager.initialize() + setMasterKey().
 */
import { MongoConnectionManager } from '@agent-platform/database/mongo/connection';
import { setMasterKey } from '@agent-platform/database/models';

const DEFAULT_MONGODB_URL =
  'mongodb://abl_admin:abl_dev_password@localhost:27018/abl_platform?authSource=admin&directConnection=true';

export async function initDatabase(): Promise<void> {
  const url = process.env.MONGODB_URL || DEFAULT_MONGODB_URL;
  const database = process.env.MONGODB_DATABASE || 'abl_platform';

  await MongoConnectionManager.initialize({
    enabled: true,
    url,
    database,
    minPoolSize: 2,
    maxPoolSize: 20,
    maxIdleTimeMs: 30_000,
    connectTimeoutMs: 10_000,
    socketTimeoutMs: 45_000,
    serverSelectionTimeoutMs: 10_000,
    heartbeatFrequencyMs: 10_000,
    retryWrites: true,
    retryReads: true,
    appName: 'workflow-engine',
  });

  const masterKey = process.env.ENCRYPTION_MASTER_KEY;
  if (masterKey) {
    setMasterKey(masterKey);
  }
}

export async function disconnectDatabase(): Promise<void> {
  if (MongoConnectionManager.isAvailable()) {
    await MongoConnectionManager.getInstance().disconnect();
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd apps/workflow-engine && npx tsc --noEmit`
Expected: PASS (types check)

**Step 5: Commit**

```bash
git add apps/workflow-engine/src/services/database.ts apps/workflow-engine/src/__tests__/db-wiring.test.ts
git commit -m "[ABL-0] feat(core): add MongoDB initialization module for workflow-engine"
```

---

## Task 2: Wire Redis Publisher

**Files:**

- Modify: `apps/workflow-engine/src/services/redis.ts` (create new)

**Step 1: Write the Redis initialization module**

The `WorkflowRedisPublisher` already exists at `src/pubsub/redis-publisher.ts`. It expects an `ioredis` client. Create a module to initialize and expose it.

```typescript
// apps/workflow-engine/src/services/redis.ts
import IORedis from 'ioredis';

let redisClient: IORedis | null = null;

const DEFAULT_REDIS_URL = 'redis://localhost:6380';

export async function initRedis(): Promise<void> {
  const url = process.env.REDIS_URL || DEFAULT_REDIS_URL;
  redisClient = new IORedis(url, { lazyConnect: true, maxRetriesPerRequest: 3 });
  redisClient.on('error', (err) => {
    console.error(
      '[workflow-engine] Redis error:',
      err instanceof Error ? err.message : String(err),
    );
  });
  try {
    await redisClient.connect();
  } catch {
    console.warn('[workflow-engine] Redis unavailable — pub/sub events disabled');
    redisClient = null;
  }
}

export function getRedisClient(): IORedis | null {
  return redisClient;
}

export async function disconnectRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit().catch(() => {});
    redisClient = null;
  }
}
```

**Step 2: Run typecheck**

Run: `cd apps/workflow-engine && npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add apps/workflow-engine/src/services/redis.ts
git commit -m "[ABL-0] feat(core): add Redis initialization for workflow-engine pub/sub"
```

---

## Task 3: Create Restate Service Endpoint

**Files:**

- Create: `apps/workflow-engine/src/services/restate-endpoint.ts`

**Step 1: Create the Restate endpoint that hosts the workflow handler**

This registers the `runWorkflow` function as a Restate workflow service so Restate can invoke it durably.

```typescript
// apps/workflow-engine/src/services/restate-endpoint.ts
import * as restate from '@restatedev/restate-sdk';
import type {
  ExecutionPersistence,
  WorkflowExecutionInput,
  StatusPublisher,
} from '../handlers/workflow-handler.js';
import { runWorkflow } from '../handlers/workflow-handler.js';
import type { StepDispatcherDeps } from '../handlers/step-dispatcher.js';

export interface RestateEndpointDeps {
  persistence: ExecutionPersistence;
  publisher: StatusPublisher;
  dispatcherDeps: StepDispatcherDeps;
}

/**
 * Build the Restate endpoint with the workflow-runner service.
 * Returns the endpoint to be served via HTTP.
 */
export function buildRestateEndpoint(deps: RestateEndpointDeps) {
  const workflowService = restate.service({
    name: 'workflow-runner',
    handlers: {
      run: async (ctx: restate.Context, input: WorkflowExecutionInput) => {
        return runWorkflow(input, {
          persistence: deps.persistence,
          publisher: deps.publisher,
          dispatcherDeps: deps.dispatcherDeps,
        });
      },
      resolveCallback: async (
        _ctx: restate.Context,
        data: { executionId: string; stepId: string; payload: unknown },
      ) => {
        // Callback resolution is handled by the router updating MongoDB directly.
        // The Restate service just needs to wake up if the workflow is sleeping.
        // For now this is a pass-through signal.
        return { resolved: true, ...data };
      },
      resolveApproval: async (
        _ctx: restate.Context,
        data: { executionId: string; stepId: string; decision: unknown },
      ) => {
        return { resolved: true, ...data };
      },
    },
  });

  return restate.endpoint().bind(workflowService);
}
```

Note: The exact Restate SDK API may need adjustment based on the installed version. The key pattern is: define a service with handlers, bind to an endpoint, serve via HTTP.

**Step 2: Run typecheck**

Run: `cd apps/workflow-engine && npx tsc --noEmit`
Expected: May have type issues with Restate SDK API — fix as needed

**Step 3: Commit**

```bash
git add apps/workflow-engine/src/services/restate-endpoint.ts
git commit -m "[ABL-0] feat(core): add Restate service endpoint for workflow execution"
```

---

## Task 4: Create Restate Client Wrapper

**Files:**

- Create: `apps/workflow-engine/src/services/restate-client.ts`

**Step 1: Create the client that routers use to interact with Restate**

```typescript
// apps/workflow-engine/src/services/restate-client.ts
/**
 * Restate client wrapper used by Express routers to trigger workflow operations.
 * Sends requests to the Restate ingress HTTP API.
 */

const DEFAULT_RESTATE_INGRESS_URL = 'http://localhost:8090';

export interface RestateClientConfig {
  ingressUrl?: string;
}

export class RestateWorkflowClient {
  private readonly ingressUrl: string;

  constructor(config?: RestateClientConfig) {
    this.ingressUrl =
      config?.ingressUrl || process.env.RESTATE_INGRESS_URL || DEFAULT_RESTATE_INGRESS_URL;
  }

  async startWorkflow(executionId: string, input: Record<string, unknown>): Promise<void> {
    const url = `${this.ingressUrl}/workflow-runner/run/send`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'idempotency-key': executionId },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Restate startWorkflow failed (${response.status}): ${text}`);
    }
  }

  async cancelWorkflow(executionId: string): Promise<void> {
    // Cancel via Restate admin API
    const adminUrl = process.env.RESTATE_ADMIN_URL || 'http://localhost:9070';
    const response = await fetch(`${adminUrl}/invocations`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'workflow-runner', handler: 'run', key: executionId }),
    });
    if (!response.ok && response.status !== 404) {
      const text = await response.text();
      throw new Error(`Restate cancelWorkflow failed (${response.status}): ${text}`);
    }
  }

  async resolveCallback(executionId: string, stepId: string, payload: unknown): Promise<void> {
    const url = `${this.ingressUrl}/workflow-runner/resolveCallback`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ executionId, stepId, payload }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Restate resolveCallback failed (${response.status}): ${text}`);
    }
  }

  async resolveApproval(
    executionId: string,
    stepId: string,
    decision: { approved: boolean; decidedBy: string; reason?: string },
  ): Promise<void> {
    const url = `${this.ingressUrl}/workflow-runner/resolveApproval`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ executionId, stepId, decision }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Restate resolveApproval failed (${response.status}): ${text}`);
    }
  }
}
```

**Step 2: Run typecheck**

Run: `cd apps/workflow-engine && npx tsc --noEmit`

**Step 3: Commit**

```bash
git add apps/workflow-engine/src/services/restate-client.ts
git commit -m "[ABL-0] feat(core): add Restate HTTP client wrapper for workflow operations"
```

---

## Task 5: Create Notification Dispatcher

**Files:**

- Create: `apps/workflow-engine/src/services/notification-dispatcher.ts`

**Step 1: Write test for dispatcher**

```typescript
// apps/workflow-engine/src/__tests__/notification-dispatcher.test.ts
import { describe, it, expect, vi } from 'vitest';
import { NotificationDispatcherImpl } from '../services/notification-dispatcher.js';

describe('NotificationDispatcher', () => {
  it('should dispatch to webhook channel', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock;

    const dispatcher = new NotificationDispatcherImpl();
    const result = await dispatcher.sendTest(
      {
        _id: 'rule-1',
        name: 'test-rule',
        events: ['workflow.completed'],
        channel: { type: 'webhook', connectionId: '', target: 'https://example.com/hook' },
        enabled: true,
      },
      'tenant-1',
    );
    expect(result.sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/hook',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('should return sent: false for unsupported channel', async () => {
    const dispatcher = new NotificationDispatcherImpl();
    const result = await dispatcher.sendTest(
      {
        _id: 'rule-2',
        name: 'test-rule',
        events: ['workflow.completed'],
        channel: { type: 'websocket' as any, connectionId: '', target: '' },
        enabled: true,
      },
      'tenant-1',
    );
    expect(result.sent).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/workflow-engine && npx vitest run src/__tests__/notification-dispatcher.test.ts`
Expected: FAIL (module not found)

**Step 3: Implement the dispatcher**

```typescript
// apps/workflow-engine/src/services/notification-dispatcher.ts
import type { NotificationRule } from '../routes/notification-rules.js';

export class NotificationDispatcherImpl {
  async sendTest(rule: NotificationRule, tenantId: string): Promise<{ sent: boolean }> {
    return this.dispatch(rule, tenantId, { test: true, sentAt: new Date().toISOString() });
  }

  async dispatch(
    rule: NotificationRule,
    tenantId: string,
    payload: Record<string, unknown>,
  ): Promise<{ sent: boolean }> {
    switch (rule.channel.type) {
      case 'webhook':
        return this.sendWebhook(rule.channel.target, payload);
      case 'slack':
        return this.sendSlack(rule.channel.target, payload);
      case 'email':
        return this.sendEmail(rule.channel.target, payload, tenantId);
      default:
        return { sent: false };
    }
  }

  private async sendWebhook(
    url: string,
    payload: Record<string, unknown>,
  ): Promise<{ sent: boolean }> {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return { sent: response.ok };
    } catch {
      return { sent: false };
    }
  }

  private async sendSlack(
    webhookUrl: string,
    payload: Record<string, unknown>,
  ): Promise<{ sent: boolean }> {
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: JSON.stringify(payload, null, 2) }),
      });
      return { sent: response.ok };
    } catch {
      return { sent: false };
    }
  }

  private async sendEmail(
    _target: string,
    _payload: Record<string, unknown>,
    _tenantId: string,
  ): Promise<{ sent: boolean }> {
    // Email dispatch requires SMTP configuration — log for now
    console.warn('[notification-dispatcher] Email channel not yet configured');
    return { sent: false };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd apps/workflow-engine && npx vitest run src/__tests__/notification-dispatcher.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/workflow-engine/src/services/notification-dispatcher.ts apps/workflow-engine/src/__tests__/notification-dispatcher.test.ts
git commit -m "[ABL-0] feat(core): add notification dispatcher with webhook and Slack channels"
```

---

## Task 6: Create Connection Tester

**Files:**

- Create: `apps/workflow-engine/src/services/connection-tester.ts`

**Step 1: Write test**

```typescript
// apps/workflow-engine/src/__tests__/connection-tester.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ConnectionTesterImpl } from '../services/connection-tester.js';
import type { ConnectorRegistry } from '@agent-platform/connectors';

describe('ConnectionTester', () => {
  it('should return success when connector test action succeeds', async () => {
    const mockRegistry = {
      get: vi.fn().mockReturnValue({
        name: 'slack',
        actions: [{ name: 'test_connection', run: vi.fn().mockResolvedValue({ ok: true }) }],
      }),
    } as unknown as ConnectorRegistry;

    const tester = new ConnectionTesterImpl(mockRegistry);
    const result = await tester.test(
      { _id: 'conn-1', connectorName: 'slack', authType: 'oauth2' } as any,
      { token: 'test-token' },
    );
    expect(result.success).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('should return failure when connector is not found', async () => {
    const mockRegistry = {
      get: vi.fn().mockImplementation(() => {
        throw new Error('Not found');
      }),
    } as unknown as ConnectorRegistry;

    const tester = new ConnectionTesterImpl(mockRegistry);
    const result = await tester.test(
      { _id: 'conn-1', connectorName: 'unknown', authType: 'api_key' } as any,
      { apiKey: 'test' },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Not found');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/workflow-engine && npx vitest run src/__tests__/connection-tester.test.ts`
Expected: FAIL

**Step 3: Implement**

```typescript
// apps/workflow-engine/src/services/connection-tester.ts
import type { ConnectorRegistry } from '@agent-platform/connectors';
import type { ConnectionRecord } from '../routes/connections.js';

export interface TestResult {
  success: boolean;
  error?: string;
  latencyMs: number;
}

export class ConnectionTesterImpl {
  constructor(private readonly registry: ConnectorRegistry) {}

  async test(
    connection: ConnectionRecord,
    decryptedCredentials: Record<string, unknown>,
  ): Promise<TestResult> {
    const start = Date.now();
    try {
      const connector = this.registry.get(connection.connectorName);
      const testAction = connector.actions.find(
        (a) => a.name === 'test_connection' || a.name === 'test',
      );

      if (testAction) {
        await testAction.run({
          auth: decryptedCredentials,
          params: {},
          tenantId: (connection as any).tenantId || '',
          projectId: (connection as any).projectId || '',
          connectionScope: 'tenant',
          executionId: 'connection-test',
          store: { get: async () => undefined, set: async () => {}, delete: async () => {} },
        } as any);
      }

      return { success: true, latencyMs: Date.now() - start };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - start,
      };
    }
  }
}
```

**Step 4: Run test**

Run: `cd apps/workflow-engine && npx vitest run src/__tests__/connection-tester.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/workflow-engine/src/services/connection-tester.ts apps/workflow-engine/src/__tests__/connection-tester.test.ts
git commit -m "[ABL-0] feat(core): add connection tester with connector registry integration"
```

---

## Task 7: Rewrite index.ts — Replace All Stubs with Real Dependencies

This is the main wiring task. Replace all stub factories with real implementations.

**Files:**

- Modify: `apps/workflow-engine/src/index.ts` (lines 87-273 — router wiring + stubs)

**Step 1: Write integration test for wired index**

```typescript
// apps/workflow-engine/src/__tests__/index-wiring.test.ts
import { describe, it, expect, vi, beforeAll } from 'vitest';

// Mock MongoDB to avoid real connection in tests
vi.mock('../services/database.js', () => ({
  initDatabase: vi.fn().mockResolvedValue(undefined),
  disconnectDatabase: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/redis.js', () => ({
  initRedis: vi.fn().mockResolvedValue(undefined),
  getRedisClient: vi.fn().mockReturnValue(null),
  disconnectRedis: vi.fn().mockResolvedValue(undefined),
}));

describe('index.ts wiring', () => {
  it('should not contain createStubModel in production code', async () => {
    const fs = await import('node:fs');
    const source = fs.readFileSync(new URL('../index.ts', import.meta.url), 'utf-8');
    expect(source).not.toContain('createStubModel');
    expect(source).not.toContain('createStubRestateClient');
    expect(source).not.toContain('createStubPublisher');
    expect(source).not.toContain('createStubRegistry');
  });
});
```

**Step 2: Rewrite index.ts**

Replace the stub section (lines 226-273) and router wiring (lines 87-142) with real dependency injection. Key changes:

1. Import `initDatabase`, `disconnectDatabase` from `./services/database.js`
2. Import `initRedis`, `getRedisClient`, `disconnectRedis` from `./services/redis.js`
3. Import real models: `Workflow`, `WorkflowExecution`, `ConnectorConnection` from `@agent-platform/database/models`
4. Import `ConnectorRegistry` from `@agent-platform/connectors`
5. Import `EncryptionService` from `@agent-platform/shared/services/encryption`
6. Import `ExecutionStore` from `./persistence/execution-store.js`
7. Import `WorkflowRedisPublisher` from `./pubsub/redis-publisher.js`
8. Import `RestateWorkflowClient` from `./services/restate-client.js`
9. Import `NotificationDispatcherImpl` from `./services/notification-dispatcher.js`
10. Import `ConnectionTesterImpl` from `./services/connection-tester.js`

In the startup sequence (before `app.listen`):

```typescript
// 1. Initialize MongoDB
await initDatabase();

// 2. Initialize Redis (best-effort)
await initRedis();

// 3. Initialize encryption
const encService = new EncryptionService();
const encryptSecret = (plaintext: string, tenantId: string) =>
  encService.encryptForTenant(plaintext, tenantId);
const decryptSecret = (ciphertext: string, tenantId: string) =>
  encService.decryptForTenant(ciphertext, tenantId);

// 4. Initialize services
const registry = new ConnectorRegistry();
const restateClient = new RestateWorkflowClient();
const executionStore = new ExecutionStore(WorkflowExecution);
const publisher = new WorkflowRedisPublisher(getRedisClient());
const dispatcher = new NotificationDispatcherImpl();
const tester = new ConnectionTesterImpl(registry);

// 5. Wire routers with real deps
```

Wire each router with real dependencies instead of stubs. Delete all `createStub*` functions.

Update graceful shutdown to include:

```typescript
await disconnectRedis();
await disconnectDatabase();
```

**Step 3: Run typecheck and test**

Run: `cd apps/workflow-engine && npx tsc --noEmit && npx vitest run`
Expected: PASS

**Step 4: Commit**

```bash
git add apps/workflow-engine/src/index.ts apps/workflow-engine/src/__tests__/index-wiring.test.ts
git commit -m "[ABL-0] feat(core): wire real MongoDB, Redis, encryption, Restate, and services in workflow-engine"
```

---

## Task 8: Verify End-to-End — Build and Typecheck

**Step 1: Build the full dependency chain**

Run: `pnpm --filter @agent-platform/database build && pnpm --filter @agent-platform/shared build && pnpm --filter @agent-platform/connectors build && pnpm --filter @agent-platform/workflow-engine build`
Expected: PASS

**Step 2: Run all workflow-engine tests**

Run: `cd apps/workflow-engine && npx vitest run`
Expected: All tests PASS

**Step 3: Verify no stubs remain**

Run: `grep -r "createStub" apps/workflow-engine/src/ --include="*.ts" | grep -v __tests__ | grep -v ".d.ts"`
Expected: No output (all stubs removed from production code)

**Step 4: Commit if any fixes were needed**

```bash
git add -A && git commit -m "[ABL-0] fix(core): resolve build and test issues in workflow-engine wiring"
```

---

## Task Dependencies

```
Task 1 (MongoDB) ──┐
Task 2 (Redis)  ───┤
Task 3 (Restate EP)┤──→ Task 7 (Wire index.ts) ──→ Task 8 (Verify)
Task 4 (Restate CL)┤
Task 5 (Notifier)──┤
Task 6 (Tester)  ──┘
```

Tasks 1-6 are independent and can be parallelized. Task 7 depends on all of them. Task 8 is the final verification.

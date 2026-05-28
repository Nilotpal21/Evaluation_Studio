# Workflows — Deployment, Components, and Server Setup

This document covers the deployment topology, component responsibilities, inter-service interactions, code folder references, and server setup required to run the workflow system.

---

## 1. Deployment Topology

```
                          ┌──────────────────────────┐
                          │      Browser / Client     │
                          └────────────┬─────────────┘
                                       │ HTTPS
                          ┌────────────▼─────────────┐
                          │   Studio (Next.js)        │
                          │   Port: 5173              │
                          │   BFF proxy layer         │
                          └─────┬──────────┬──────────┘
                       CRUD ops │          │ Execution ops
                                │          │
                   ┌────────────▼──┐  ┌────▼───────────────┐
                   │  Runtime      │  │  Workflow Engine    │
                   │  (Express)    │  │  (Express + Restate)│
                   │  Port: 3112   │  │  Port: 9080 (API)  │
                   └───┬───┬──────┘  │  Port: 9081 (H2)   │
                       │   │         └───┬──┬──┬──┬────────┘
                       │   │ proxy       │  │  │  │
                       │   └─────────────┘  │  │  │
                       │                    │  │  │
          ┌────────────▼────────────────────▼──┘  │
          │          MongoDB                │     │
          │          Port: 27017 (container)│     │
          │          Port: 27018 (host)     │     │
          └─────────────────────────────────┘     │
                                                  │
          ┌───────────────────────────────────────▼─┐
          │          Redis                          │
          │          Port: 6379 (container)          │
          │          Port: 6380 (host)               │
          │  ┌─────────┐ ┌──────────┐ ┌──────────┐ │
          │  │ Pub/Sub  │ │ BullMQ   │ │ KV Store │ │
          │  └─────────┘ └──────────┘ └──────────┘ │
          └─────────────────────────────────────────┘

          ┌─────────────────────────────────────────┐
          │          Restate Server                  │
          │          Port: 9070 (Admin API)          │
          │          Port: 8080→8091 (Ingress)       │
          │  ┌─────────────────────────────────┐    │
          │  │  Durable execution runtime       │    │
          │  │  Exactly-once, replay, promises  │    │
          │  └─────────────────────────────────┘    │
          └─────────────────────────────────────────┘
```

---

## 2. Component Responsibilities

### 2.1 Studio (Next.js Frontend)

**Role:** Visual workflow builder and monitoring UI.

| Responsibility       | Details                                                                         |
| -------------------- | ------------------------------------------------------------------------------- |
| Canvas editor        | ReactFlow-based drag-and-drop node graph editor                                 |
| Node configuration   | Type-specific config panels for each of the 17 node types                       |
| Workflow CRUD        | Create, edit, save, delete workflows via API                                    |
| Execution triggering | Run dialog to provide input and start executions                                |
| Live monitoring      | Debug panel overlays execution status on canvas nodes                           |
| BFF proxy            | All API calls proxy through Next.js server routes to Runtime or Workflow Engine |

**Key code paths:**

| Path                                               | What                                            |
| -------------------------------------------------- | ----------------------------------------------- |
| `apps/studio/src/components/workflows/canvas/`     | Canvas, node components, config editors, panels |
| `apps/studio/src/store/workflow-canvas-store.ts`   | Zustand store — node/edge state, serialization  |
| `apps/studio/src/api/workflows.ts`                 | API client functions                            |
| `apps/studio/src/app/api/projects/[id]/workflows/` | ~20 Next.js API routes (BFF proxy)              |
| `apps/studio/src/lib/workflow-engine-proxy.ts`     | Proxy helper to Workflow Engine                 |

### 2.2 Runtime (Express API Gateway)

**Role:** API gateway for all platform resources. Owns workflow CRUD, proxies execution operations to the Workflow Engine.

| Responsibility     | Details                                                      |
| ------------------ | ------------------------------------------------------------ |
| Workflow CRUD      | Create, read, update, archive workflows in MongoDB           |
| Version management | Create/query workflow version snapshots                      |
| Auth gateway       | JWT/API key verification, tenant resolution, RBAC            |
| Proxy to engine    | Forwards execution, trigger, approval, notification requests |
| Session linkage    | Associate workflow executions with conversation sessions     |

**Key code paths:**

| Path                                                                  | What                                  |
| --------------------------------------------------------------------- | ------------------------------------- |
| `apps/runtime/src/routes/workflows.ts`                                | CRUD routes (POST, GET, PUT, archive) |
| `apps/runtime/src/routes/workflow-versions.ts`                        | Version management routes             |
| `apps/runtime/src/middleware/workflow-engine-proxy.ts`                | Proxy middleware to Workflow Engine   |
| `apps/runtime/src/services/stores/mongo-workflow-definition-store.ts` | MongoDB persistence                   |
| `apps/runtime/src/validation/workflow-validation.ts`                  | Server-side validation                |

**Proxy route mapping:**

| Runtime Path                            | Proxied To (Engine)           | Permission            |
| --------------------------------------- | ----------------------------- | --------------------- |
| `POST /:wfId/executions/execute`        | `POST .../executions/execute` | `workflow:execute`    |
| `GET /:wfId/executions`                 | `GET .../executions`          | `workflow:read`       |
| `GET /:wfId/executions/:execId`         | `GET .../executions/:execId`  | `workflow:read`       |
| `POST /:wfId/executions/:execId/cancel` | `POST .../cancel`             | `workflow:execute`    |
| `GET /approvals`                        | `GET .../approvals`           | `workflow:read`       |
| `POST /approvals/.../approve`           | `POST .../approve`            | `workflow:execute`    |
| `GET/POST/DELETE /triggers/...`         | `triggers/...`                | `workflow:read/write` |
| `GET /connectors`                       | `connectors`                  | `workflow:read`       |
| `CRUD /:wfId/notifications/...`         | `notifications/...`           | `workflow:update`     |

### 2.3 Workflow Engine (Execution Service)

**Role:** Durable workflow execution. Converts canvas graphs to steps, runs them via Restate, manages triggers, handles human-in-the-loop, delivers callbacks.

| Responsibility             | Details                                                                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canvas-to-steps conversion | Topological sort of graph → linear step array                                                                                                             |
| Step execution             | 12 executor types (HTTP, condition, delay, transform, loop, parallel, agent invocation, tool call, connector action, async webhook, approval, human task) |
| Expression resolution      | `{{path}}` template resolution against execution context                                                                                                  |
| Durable execution          | Restate-backed exactly-once semantics, replay safety                                                                                                      |
| Trigger management         | Webhook, cron, polling, event, connector trigger lifecycle                                                                                                |
| Job scheduling             | BullMQ workers for cron/polling triggers and callback delivery                                                                                            |
| Approval/human tasks       | Create tasks, await durable promises, resolve via API                                                                                                     |
| Real-time events           | Redis Pub/Sub for step status updates                                                                                                                     |
| Execution persistence      | MongoDB storage of execution state and node results                                                                                                       |
| Notification dispatch      | Rule-based notifications on workflow events                                                                                                               |
| Connection management      | OAuth/credential storage and resolution for connectors                                                                                                    |

**Key code paths:**

| Path                                                                | What                                                           |
| ------------------------------------------------------------------- | -------------------------------------------------------------- |
| `apps/workflow-engine/src/index.ts`                                 | Entry point — server setup, dependency wiring                  |
| `apps/workflow-engine/src/handlers/workflow-handler.ts`             | Core execution logic: `runWorkflow()`, `executeWorkflowStep()` |
| `apps/workflow-engine/src/handlers/step-dispatcher.ts`              | Routes steps to executors                                      |
| `apps/workflow-engine/src/handlers/canvas-to-steps.ts`              | Graph → linear step conversion                                 |
| `apps/workflow-engine/src/context/expression-resolver.ts`           | `{{path}}` expression resolution                               |
| `apps/workflow-engine/src/executors/`                               | 12 step executor implementations                               |
| `apps/workflow-engine/src/services/restate-endpoint.ts`             | Restate workflow service definition                            |
| `apps/workflow-engine/src/services/restate-client.ts`               | Client to Restate ingress API                                  |
| `apps/workflow-engine/src/services/trigger-engine.ts`               | Trigger lifecycle management                                   |
| `apps/workflow-engine/src/services/trigger-scheduler.ts`            | BullMQ cron/polling scheduler                                  |
| `apps/workflow-engine/src/services/callback-delivery-worker.ts`     | Webhook callback delivery                                      |
| `apps/workflow-engine/src/persistence/execution-store.ts`           | MongoDB execution persistence                                  |
| `apps/workflow-engine/src/persistence/human-task-store.ts`          | Human task persistence                                         |
| `apps/workflow-engine/src/pubsub/redis-publisher.ts`                | Redis Pub/Sub event publishing                                 |
| `apps/workflow-engine/src/services/redis-kv-store.ts`               | Redis KV for connector state                                   |
| `apps/workflow-engine/src/notifications/notification-dispatcher.ts` | Notification rule dispatch                                     |
| `apps/workflow-engine/src/routes/`                                  | All API route handlers                                         |
| `apps/workflow-engine/src/constants.ts`                             | All timeout/limit constants                                    |
| `apps/workflow-engine/src/observability/otel-setup.ts`              | OpenTelemetry initialization                                   |

### 2.4 Restate Server

**Role:** Durable execution runtime providing exactly-once guarantees.

| Responsibility         | Details                                                                     |
| ---------------------- | --------------------------------------------------------------------------- |
| Exactly-once execution | Steps wrapped in `ctx.run()` are not re-executed on replay                  |
| Durable sleep          | Delay nodes survive engine restarts via `ctx.sleep()`                       |
| Durable promises       | Approval/callback/human-task nodes await named promises resolved externally |
| Workflow keying        | Each execution has a unique key — prevents duplicate runs                   |
| Replay on failure      | If engine crashes, Restate replays from last checkpoint                     |

**Not application code** — this is an infrastructure service (`restatedev/restate:1.6.2` Docker image).

### 2.5 MongoDB

**Role:** Primary data store for all workflow state.

| Collection              | Owner                         | Purpose                                     |
| ----------------------- | ----------------------------- | ------------------------------------------- |
| `workflows`             | Runtime (CRUD), Engine (read) | Workflow definitions (nodes, edges, config) |
| `workflow_versions`     | Runtime                       | Immutable version snapshots                 |
| `workflow_executions`   | Engine                        | Execution tracking with per-node results    |
| `workflow_api_keys`     | Engine                        | Per-workflow API key auth                   |
| `trigger_registrations` | Engine                        | Trigger subscriptions                       |
| `human_tasks`           | Engine                        | Human-in-the-loop task records              |
| `connector_connections` | Engine                        | OAuth/credential storage                    |
| `deployments`           | Runtime                       | Version pinning per environment             |

### 2.6 Redis

**Role:** Pub/Sub, job queuing, KV state store.

| Usage   | Channel/Queue/Prefix                                 | Purpose                                              |
| ------- | ---------------------------------------------------- | ---------------------------------------------------- |
| Pub/Sub | `workflow:{tenantId}:execution:{executionId}:status` | Real-time step status events                         |
| Pub/Sub | `workflow:{tenantId}:approval:pending`               | New approval notifications                           |
| BullMQ  | `workflow-triggers`                                  | Cron/polling/one-shot trigger jobs (concurrency: 10) |
| BullMQ  | `workflow-callbacks`                                 | Webhook callback delivery jobs (concurrency: 5)      |
| BullMQ  | `connector-polling`                                  | Connector polling triggers                           |
| BullMQ  | `connector-cron`                                     | Connector cron triggers                              |
| KV      | `kv:connector:{tenantId}:{connectorName}:{key}`      | Polling cursor/state persistence                     |

---

## 3. Inter-Service Interaction Diagram

```
Browser
  │
  ▼
Studio ──[CRUD]──▶ Runtime ──[MongoDB]──▶ workflows collection
  │                    │
  │                    │ (proxy)
  │                    ▼
  └──[Execute/Trigger/Approve]──▶ Workflow Engine
                                      │
                          ┌───────────┼───────────────┐
                          │           │               │
                          ▼           ▼               ▼
                    Restate       MongoDB          Redis
                    (durable      (execution       (pub/sub,
                     execution)    persistence)     BullMQ)
                          │
                          │ (HTTP/2 endpoint)
                          ▼
                    Workflow Engine
                    (Restate calls back into
                     the engine to run steps)

External triggers:
  Webhook ──▶ Workflow Engine ──▶ Restate ──▶ runWorkflow()
  Cron/Poll ──▶ BullMQ Worker ──▶ Restate ──▶ runWorkflow()
  Connector ──▶ ConnectorTriggerEngine ──▶ Restate ──▶ runWorkflow()

During execution:
  Step executor ──▶ External HTTP API (api node)
  Step executor ──▶ Runtime API (agent_invocation, tool_call nodes)
  Step executor ──▶ Connector service (connector_action node)

Human-in-the-loop:
  Engine creates HumanTask ──▶ MongoDB
  Engine publishes event ──▶ Redis Pub/Sub
  User approves via Studio ──▶ Engine API ──▶ Restate promise resolved
```

### 3.1 Request Flow — Execute a Workflow

```
1. Browser → Studio API route (POST /api/projects/:id/workflows/:wfId/execute)
2. Studio → proxyToWorkflowEngine() → Workflow Engine (POST /api/v1/.../executions/execute)
3. Engine validates input, generates executionId
4. Engine → Restate Ingress (POST /workflow-runner/{executionId}/run/send)
5. Restate → Engine Restate Endpoint (HTTP/2, port 9081) — calls run() handler
6. run() → buildWorkflowContext() → step loop:
   a. dispatchStep() → executor (e.g., http-executor)
   b. Executor resolves {{expressions}} from context
   c. Executor performs work (HTTP call, etc.)
   d. Result written to ctx.steps[stepId]
   e. ExecutionStore.updateStepStatus() → MongoDB
   f. StatusPublisher.publish() → Redis Pub/Sub
7. Loop completes → ExecutionStore.updateExecutionStatus('completed') → MongoDB
8. Browser polls GET .../executions/:executionId → sees completed status
```

### 3.2 Request Flow — Trigger Fires

```
Cron trigger:
1. BullMQ scheduler fires job from 'workflow-triggers' queue
2. TriggerScheduler.processJob() loads TriggerRegistration from MongoDB
3. Loads Workflow, optionally resolves pinned version from Deployment
4. convertCanvasToSteps(nodes, edges)
5. RestateWorkflowClient.startWorkflow(executionId, input)
6. Same flow as step 5 onwards above

Webhook trigger:
1. External system → POST /api/v1/projects/:projectId/triggers/:registrationId/fire
2. TriggerEngine.fireWebhookTrigger() loads registration + workflow
3. Same version resolution + canvas conversion
4. RestateWorkflowClient.startWorkflow()
5. Returns 202 Accepted with executionId
```

### 3.3 Request Flow — Human Approval

```
1. Workflow reaches approval step
2. Engine creates HumanTask in MongoDB via MongoHumanTaskStore
3. Publishes 'step.waiting_approval' event via Redis
4. Restate durable promise 'sys:approval:{stepId}' is created (blocks execution)
5. Studio UI shows pending approval (via polling or Pub/Sub)
6. User clicks Approve → Studio → Runtime proxy → Engine API
7. POST /api/v1/.../approvals/:wfId/executions/:execId/steps/:stepId/approve
8. Engine → RestateWorkflowClient.resolveApproval(executionId, stepId, decision)
9. Restate resolves the durable promise → execution resumes
10. Next step executes based on approved/rejected routing
```

---

## 4. Internal Package Dependencies

The Workflow Engine depends on these monorepo packages:

```
@agent-platform/workflow-engine
  ├── @abl/compiler
  │    └── createLogger(), runWithObservabilityContext()
  ├── @agent-platform/database
  │    └── Mongoose models: Workflow, WorkflowExecution, ConnectorConnection,
  │        TriggerRegistration, Deployment, WorkflowVersion, HumanTask, etc.
  ├── @agent-platform/shared
  │    └── createUnifiedAuthMiddleware(), requireAuth(), requestIdMiddleware(),
  │        EncryptionService
  ├── @agent-platform/shared-kernel
  │    └── buildSignatureHeaders(), assertUrlSafeForSSRF(), workflow types
  ├── @agent-platform/shared-observability
  │    └── createObservabilityMiddleware()
  ├── @agent-platform/connectors
  │    └── ConnectorRegistry, ConnectionResolver, ConnectorToolExecutor,
  │        loadConnectors(), ConnectorTriggerEngine
  └── @agent-platform/config
       └── Port constants (DEFAULT_WORKFLOW_ENGINE_PORT)
```

---

## 5. Server Setup — How to Run

### 5.1 Infrastructure Prerequisites

All infrastructure runs via Docker Compose:

```bash
docker compose up -d mongo redis restate
```

| Service | Image                      | Container Port               | Host Port  |
| ------- | -------------------------- | ---------------------------- | ---------- |
| MongoDB | `mongo:7`                  | 27017                        | 27018      |
| Redis   | `redis:7-alpine`           | 6379                         | 6380       |
| Restate | `restatedev/restate:1.6.2` | 9070 (admin), 8080 (ingress) | 9070, 8091 |

### 5.2 Environment Variables

**Required:**

| Variable                | Example                                                                                                    | Purpose                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `MONGODB_URL`           | `mongodb://abl_admin:abl_dev_password@localhost:27018/abl_platform?authSource=admin&directConnection=true` | MongoDB connection                     |
| `JWT_SECRET`            | `dev-jwt-secret-that-is-at-least-32chars`                                                                  | JWT signing (shared with Runtime)      |
| `ENCRYPTION_MASTER_KEY` | _(32+ char secret)_                                                                                        | Field-level encryption for credentials |

**Optional (with defaults):**

| Variable                      | Default                   | Purpose                                 |
| ----------------------------- | ------------------------- | --------------------------------------- |
| `PORT`                        | `9080`                    | Express API port                        |
| `RESTATE_ENDPOINT_PORT`       | `9081`                    | Restate HTTP/2 endpoint                 |
| `RESTATE_ADMIN_URL`           | `http://localhost:9070`   | Restate admin API                       |
| `RESTATE_INGRESS_URL`         | `http://localhost:8091`   | Restate ingress for workflow invocation |
| `RESTATE_ENDPOINT_URL`        | `http://localhost:9081`   | Self-URL registered with Restate        |
| `REDIS_URL`                   | `redis://localhost:6380`  | Redis (pub/sub, BullMQ, KV)             |
| `RUNTIME_URL`                 | `http://localhost:3112`   | Runtime API (for agent/tool invocation) |
| `WORKFLOW_ENGINE_PUBLIC_URL`  | `http://localhost:9080`   | Public URL for callback URLs            |
| `MONGODB_DATABASE`            | `abl_platform`            | Database name                           |
| `CALLBACK_HMAC_SECRET`        | `default-callback-secret` | HMAC signing for webhook callbacks      |
| `CALLBACK_MAX_RETRIES`        | `3`                       | Callback delivery retry count           |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4317`   | OTel collector (gRPC)                   |
| `OTEL_ENABLED`                | `true`                    | Set `false` to disable tracing          |
| `NODE_ENV`                    | `development`             | Environment                             |

### 5.3 Starting the Workflow Engine

**Local development (from repo root):**

```bash
# 1. Build dependencies first (Turbo handles order)
pnpm build --filter=@agent-platform/workflow-engine...

# 2. Start the engine
pnpm --filter=@agent-platform/workflow-engine dev
```

**What happens at startup (in order):**

1. `dotenv/config` loads `.env`
2. OpenTelemetry SDK initialized (monkey-patches HTTP/Express/Mongoose/Redis)
3. Express app created with JSON parser (1MB limit), request ID middleware, observability middleware
4. MongoDB connected via `MongoConnectionManager`
5. Redis connected (best-effort — graceful degradation if unavailable)
6. `EncryptionService` initialized with `ENCRYPTION_MASTER_KEY`
7. `ConnectorRegistry` created, all connectors loaded
8. `RestateWorkflowClient` created (talks to Restate ingress)
9. `ExecutionStore` created (MongoDB persistence)
10. `CallbackDeliveryWorker` started (BullMQ, if Redis available)
11. Auth middleware registered (`createUnifiedAuthMiddleware`)
12. All API routes mounted
13. Restate endpoint built and started on port 9081 (HTTP/2)
14. Express server starts listening on port 9080
15. Self-registers with Restate admin (`POST /deployments`)
16. `TriggerScheduler` created and started (BullMQ workers)
17. `TriggerEngine` created
18. Connector trigger queues created (if Redis available)

**Docker Compose (full stack):**

```bash
docker compose up -d
```

The `abl-workflow-engine` container:

- Depends on: `mongo` (healthy), `redis` (healthy), `restate` (healthy)
- Networks: `backend`, `data`
- Uses container-to-container networking (e.g., `http://abl-restate:9070` not `localhost`)

### 5.4 Restate Registration

After the Express server starts, the engine registers itself with Restate:

```
POST http://localhost:9070/deployments
Body: { "uri": "http://localhost:9081" }
```

In Docker: `uri` is `http://abl-workflow-engine:9081` (container-to-container).

This tells Restate where to find the `workflow-runner` service. Restate then calls back to this endpoint via HTTP/2 when workflows are invoked.

**If registration fails:** The engine logs a warning but continues running. Workflow executions won't work until Restate can reach the endpoint. You can manually register via:

```bash
curl -X POST http://localhost:9070/deployments \
  -H 'Content-Type: application/json' \
  -d '{"uri": "http://localhost:9081"}'
```

### 5.5 Verifying the Setup

```bash
# Health check
curl http://localhost:9080/health
# Expected: { "ok": true, "service": "workflow-engine" }

# Readiness check (verifies DB)
curl http://localhost:9080/health/ready
# Expected: { "ok": true }

# Restate health
curl http://localhost:9070/health
# Expected: 200 OK

# Check Restate knows about the workflow service
curl http://localhost:9070/deployments
# Should list the workflow-runner service
```

---

## 6. Operational Constants

All defined in `apps/workflow-engine/src/constants.ts`:

| Constant                       | Value  | Purpose                              |
| ------------------------------ | ------ | ------------------------------------ |
| `MAX_WORKFLOW_STEPS`           | 50     | Max steps per workflow               |
| `MAX_PARALLEL_BRANCHES`        | 10     | Max branches in parallel step        |
| `MAX_STEP_NESTING_DEPTH`       | 5      | Max nesting for condition/parallel   |
| `DEFAULT_STEP_TIMEOUT_MS`      | 30s    | Default step timeout                 |
| `DEFAULT_AGENT_TIMEOUT_MS`     | 120s   | Agent invocation timeout             |
| `DEFAULT_CALLBACK_TIMEOUT_MS`  | 24h    | Async webhook wait timeout           |
| `DEFAULT_APPROVAL_TIMEOUT_MS`  | 72h    | Human approval wait timeout          |
| `MAX_DELAY_MS`                 | 7 days | Maximum delay node duration          |
| `MAX_POLLING_INTERVAL_MS`      | 24h    | Maximum polling trigger interval     |
| `MIN_POLLING_INTERVAL_MS`      | 10s    | Minimum polling trigger interval     |
| `WEBHOOK_DEDUP_WINDOW_MS`      | 10 min | Webhook deduplication window         |
| `CALLBACK_REPLAY_TOLERANCE_MS` | 5 min  | Callback HMAC replay tolerance       |
| `TRIGGER_AUTO_PAUSE_THRESHOLD` | 10     | Consecutive errors before auto-pause |
| `SHUTDOWN_TIMEOUT_MS`          | 15s    | Graceful shutdown force-exit timeout |

---

## 7. Security Model

### 7.1 Authentication

| Route                                         | Auth Method                                     |
| --------------------------------------------- | ----------------------------------------------- |
| `/health`, `/health/ready`                    | None                                            |
| `/api/v1/workflows/callbacks/:execId/:stepId` | HMAC-SHA256 signature (no JWT)                  |
| All other `/api/v1/...` routes                | `createUnifiedAuthMiddleware` + `requireAuth()` |

**Unified auth** supports three token types:

1. **JWT** (`Authorization: Bearer <jwt>`) — user sessions from Studio
2. **SDK session** (`X-SDK-Token` header) — programmatic SDK access
3. **API key** (`x-api-key` header or `Authorization: Bearer abl_*` / `Bearer pk_*`) — machine-to-machine

### 7.2 Callback Security

Webhook callbacks (external → engine) use:

- **Mandatory HMAC-SHA256** — stored `callbackSecret` (encrypted at rest)
- **Replay protection** — `x-callback-timestamp` header checked within 5-minute window
- **SSRF protection** — `assertUrlSafeForSSRF()` validates all outbound callback URLs

### 7.3 Credential Encryption

- Connector credentials encrypted via `EncryptionService.encryptForTenant()` before storage
- Decrypted only at execution time via `ConnectionResolver`
- OAuth2 refresh with distributed Redis lock (30s TTL) to prevent token races

### 7.4 Tenant Isolation

- Every MongoDB query includes `tenantId` AND `projectId`
- Every Redis channel/key is tenant-scoped
- `ExecutionStore` enforces `(executionId, tenantId, projectId)` on all operations

---

## 8. Observability

### 8.1 OpenTelemetry

Initialized in `apps/workflow-engine/src/observability/otel-setup.ts` **before** all other imports.

| Signal  | Exporter  | Destination                                              |
| ------- | --------- | -------------------------------------------------------- |
| Traces  | OTLP gRPC | `OTEL_EXPORTER_OTLP_ENDPOINT` (default `localhost:4317`) |
| Metrics | OTLP gRPC | Same endpoint                                            |
| Logs    | OTLP gRPC | Same endpoint                                            |

Auto-instrumentations: HTTP, Express, MongoDB, Redis (ioredis).

Service name: `OTEL_SERVICE_NAME` (default `workflow-engine`).

### 8.2 Structured Logging

Uses `createLogger('workflow-engine')` from `@abl/compiler/platform`. All logs include request ID and observability context via `runWithObservabilityContext()`.

### 8.3 Real-Time Status Events

Published to Redis Pub/Sub for Studio consumption:

| Event                     | When                            |
| ------------------------- | ------------------------------- |
| `step.started`            | Step begins execution           |
| `step.completed`          | Step finishes successfully      |
| `step.failed`             | Step fails                      |
| `step.waiting_approval`   | Approval step suspends          |
| `step.waiting_callback`   | Webhook callback step suspends  |
| `step.waiting_human_task` | Human task step suspends        |
| `workflow.started`        | Execution begins                |
| `workflow.completed`      | Execution finishes successfully |
| `workflow.failed`         | Execution fails                 |
| `workflow.cancelled`      | Execution cancelled             |
| `workflow.rejected`       | Approval rejected               |

---

## 9. Graceful Shutdown

On `SIGTERM` or `SIGINT`:

1. Set `isShuttingDown = true` (readiness probe returns 503)
2. Stop Express HTTP server (stop accepting new connections)
3. Stop `TriggerScheduler` (drain BullMQ worker)
4. Stop `CallbackDeliveryWorker` (drain BullMQ worker)
5. Disconnect Redis
6. Disconnect MongoDB
7. Force exit after 15 seconds if still running

In-flight Restate workflows are **not lost** — Restate will replay them when the engine comes back up.

---

## 10. Dockerfile and Production Build

**File:** `apps/workflow-engine/Dockerfile`

```
Build stage:   node:24-alpine
               pnpm install --frozen-lockfile
               pnpm build --filter=@agent-platform/workflow-engine
               pnpm deploy --filter=@agent-platform/workflow-engine --prod

Production:    gcr.io/distroless/nodejs22-debian12
               Runs as nonroot user
               Exposes port 9080
               Health check: GET /health every 10s
               CMD ["dist/index.js"]
```

**Important:** When adding new `packages/<name>/` workspace packages that the workflow engine depends on, add the corresponding `COPY packages/<name>/package.json` line to the Dockerfile so `pnpm install --frozen-lockfile` can resolve the dependency graph.

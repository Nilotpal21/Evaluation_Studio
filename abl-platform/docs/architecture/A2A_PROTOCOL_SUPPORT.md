# A2A Protocol Support

> ABL Platform's Agent-to-Agent (A2A) protocol implementation.

**SDK:** `@a2a-js/sdk` v0.2.5 (A2A Protocol Specification v0.3.0)
**Package:** `packages/a2a/` (hexagonal architecture)

---

## Agent Card

The runtime exposes an A2A-compatible agent card at `GET /a2a/.well-known/agent.json`:

```json
{
  "name": "Agent Runtime",
  "description": "ABL Agent Runtime - A2A compatible with async support",
  "url": "/a2a",
  "version": "2.0.0",
  "capabilities": {
    "streaming": true,
    "pushNotifications": true,
    "stateTransitionHistory": true
  },
  "defaultInputModes": ["text"],
  "defaultOutputModes": ["text"],
  "skills": []
}
```

---

## Supported Operations

| Operation             | Method             | Description               |
| --------------------- | ------------------ | ------------------------- |
| `tasks/send`          | JSON-RPC POST      | Synchronous task dispatch |
| `tasks/sendSubscribe` | SSE                | Streaming task dispatch   |
| `tasks/get`           | JSON-RPC POST      | Query task status         |
| `tasks/cancel`        | JSON-RPC POST      | Cancel a running task     |
| Push Notifications    | POST to caller URL | Async status updates      |

---

## Task State Machine

```
submitted → working → input-required → completed
                   ↘ failed
                   ↘ canceled
```

| State            | When                                                  |
| ---------------- | ----------------------------------------------------- |
| `submitted`      | Task received, queued                                 |
| `working`        | Execution in progress, or suspended waiting for async |
| `input-required` | Agent needs human input before continuing             |
| `completed`      | Execution finished successfully                       |
| `failed`         | Execution errored                                     |
| `canceled`       | Task explicitly cancelled                             |

---

## Async Patterns

### Push Notifications (Outbound — Calling Remote Agents)

When calling a remote agent whose card declares `pushNotifications: true`:

1. Platform sends task with `blocking: false` + `pushNotificationConfig`
2. Remote agent returns `Task { state: 'working' }` immediately
3. Execution suspends — session state persisted to Redis/MongoDB
4. Remote agent POSTs result to our callback URL when done
5. Callback claimed atomically → resume job enqueued → execution resumes
6. Result delivered to original channel

### Push Notifications (Inbound — Serving Long-Running Tasks)

When this platform receives a task with `pushNotificationConfig`:

1. Task accepted, execution starts
2. If execution suspends (async tool, human approval), task stays in `working`
3. Push notification config stored in `RedisA2ATaskStore`
4. When execution completes, `PushNotificationDeliveryService` POSTs result to caller

### Streaming via SSE

Clients can use `tasks/sendSubscribe` for Server-Sent Events:

1. `TaskStatusUpdateEvent { state: 'working' }` sent immediately
2. `Message` events sent for each streaming chunk
3. `TaskStatusUpdateEvent { state: 'completed' }` sent at end

### Human Input (`input-required`)

```
Client: sendMessage("Process expense #123")
Server: Task { state: 'working' }
  ... agent needs human approval ...
Server: Task { state: 'input-required' }
        Message { "Approve expense of $500?" }
Client: sendMessage("Approved")      ← same contextId
Server: Task { state: 'working' }
  ... execution resumes ...
Server: Task { state: 'completed' }
```

---

## Callback Endpoints

| Endpoint                             | Purpose                                                      |
| ------------------------------------ | ------------------------------------------------------------ |
| `POST /api/v1/callbacks/:callbackId` | Unified callback for async tools, approvals, remote handoffs |
| `POST /a2a/callbacks/:callbackId`    | A2A-specific push notification callbacks                     |

**Authentication:** HMAC-SHA256 signature via `x-callback-signature` header.
**Rate Limiting:** 100 req/min per IP.

---

## DSL Integration

### Remote Agent with Async

```
ROUTING
  HANDOFF payment_agent
    LOCATION REMOTE
    ENDPOINT "https://payment-agent.example.com"
    PROTOCOL A2A
    ASYNC true
    TIMEOUT 3600
```

### Async Webhook Tool

```
TOOL process_payment
  DESCRIPTION "Initiate payment asynchronously"
  TYPE async_webhook
  ENDPOINT "https://payments.example.com/api/process"
  METHOD POST
  CALLBACK_URL_FIELD callbackUrl
  CALLBACK_TIMEOUT 3600
  PARAMS
    amount: number REQUIRED
    currency: string REQUIRED
```

### Human Approval

```
STEP review_expense
  HUMAN_APPROVAL
    PROMPT "Approve expense of {{amount}} for {{reason}}?"
    ASSIGNEE "{{department}}_manager"
    TIMEOUT 86400
    ON_APPROVE approved_step
    ON_REJECT rejected_step
    ON_TIMEOUT timeout_step
```

---

## Configuration

| Variable            | Default  | Description                            |
| ------------------- | -------- | -------------------------------------- |
| `CALLBACK_BASE_URL` | —        | Public URL for callbacks (must be TLS) |
| `DEFAULT_TENANT_ID` | `system` | Tenant for A2A inbound requests        |

---

## Architecture

```
@a2a-js/sdk (protocol types, transports, handlers)
     ↑
@agent-platform/a2a (platform adapters: tracing, SSRF, execution bridge)
     ↑
apps/runtime (wiring + mounting)
```

See `docs/ASYNC_EXECUTION_ARCHITECTURE.md` for suspension/resumption details.

# ABL Agent Assist — V1 Compatibility Facade API

Reference for integrating third-party Agent Assist software (e.g. Kore.ai Agent
Assist) with the ABL runtime. The facade exposes a V1-compatible HTTP surface at
`/api/v2/apps/:appId/environments/:envName/...` and delegates each turn to the
underlying agent executor.

- **Status:** Stable
- **Base path (direct):** `https://<runtime-host>/api/v2/apps/...` — runtime on port `3112`
- **Base path (public via Studio proxy):** `https://<studio-host>/api/v2/apps/...` — studio on port `5173`, forwards to runtime
- **Content type:** `application/json` (except SSE responses, see below)
- **Authentication:** `x-api-key: abl_<token>` header on every request

Studio publishes the proxy so callers outside the private network can reach the
runtime without exposing it directly. Both base paths accept the same request
shapes and return the same responses.

---

## 1. Concepts

| Term            | Meaning                                                                                                                                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Binding**     | Persistent mapping of a Kore.ai Agent Assist app (`appId` + `environment`) to an ABL project/tenant. Created by the project owner in ABL Studio.                                                                       |
| **App ID**      | The caller-facing identifier used in the URL. Today, `appId === projectId`.                                                                                                                                            |
| **Environment** | Free-form label (e.g. `dev`, `staging`, `production`) that identifies which environment's binding and deployment to use. Case-insensitive.                                                                             |
| **API Key**     | `abl_<token>` minted in Studio for a binding. Presented as `x-api-key`. Must belong to the binding's tenant and include the binding's project in its scope.                                                            |
| **Session**     | A conversation session, keyed by `sessionReference`. The session ID (`s-<uuid>`) is deterministic for the same `(tenantId, appId, environment, sessionReference)` so retries and reconnects hit the same conversation. |
| **Message ID**  | Per-turn identifier `msg_<uuid>` emitted in every response / SSE frame so the client can correlate streaming deltas and final envelopes.                                                                               |

### Feature gating

Access is gated per tenant by an `agent_assist` feature flag granted via an ABL
Deal or plan tier. When the feature is not granted, or when no binding matches,
the response is `404 APP_NOT_FOUND` — identical in shape to a missing binding,
so existence is not observable.

---

## 2. Authentication and isolation

Every request must include:

```
x-api-key: abl_<token>
```

The runtime resolves the API key to its owning `tenantId`, optional
`projectScope[]`, and a set of permissions. Isolation rules:

- The resolved key's `tenantId` **must** equal the binding's `tenantId`.
- If the key has a non-empty `projectScope`, the binding's `projectId` **must** be in it.
- Any mismatch returns **`404 APP_NOT_FOUND`** (never `403`) to avoid leaking existence.

If the header is absent: `401 { error: { code: "API_KEY_REQUIRED" } }`.

---

## 3. Common shapes

### Error envelope

All non-2xx responses (other than SSE error frames) share this body:

```json
{
  "success": false,
  "error": {
    "code": "APP_NOT_FOUND",
    "message": "Agent Assist app not found."
  }
}
```

### Error codes

| Code                    | HTTP | Cause                                                                                                                                                       |
| ----------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_KEY_REQUIRED`      | 401  | `x-api-key` header missing or unparseable                                                                                                                   |
| `APP_NOT_FOUND`         | 404  | Feature not granted, binding missing, binding disabled, or tenant/project scope mismatch — all collapse to the same envelope so existence is not observable |
| `INVALID_INPUT`         | 400  | Request body failed schema validation                                                                                                                       |
| `CALLBACK_URL_REQUIRED` | 400  | `isAsync: true` without `callbackUrl` (and without `stream.enable: true`)                                                                                   |
| `INVALID_CALLBACK_URL`  | 400  | `callbackUrl` is malformed, loopback/private IP, or non-HTTPS                                                                                               |

### Session identity

Where a request accepts `sessionIdentity`, it is an array of type/value pairs.
At least one entry is required.

| `type`             | Purpose                                                                      |
| ------------------ | ---------------------------------------------------------------------------- |
| `sessionReference` | Caller-owned opaque string that keys the conversation. Strongly recommended. |
| `sessionId`        | Alternate alias for `sessionReference` — accepted for compat.                |
| `sessionIdentity`  | Same as `sessionReference` — accepted for compat.                            |
| `userReference`    | Caller-owned opaque string identifying the end user. Optional.               |

Example:

```json
"sessionIdentity": [
  { "type": "sessionReference", "value": "conv-9c1d-203b" },
  { "type": "userReference",    "value": "u-end-user-42" }
]
```

### Input items

`input` is an array of content blocks.

| `type`       | `content`                 | Behavior                                     |
| ------------ | ------------------------- | -------------------------------------------- |
| `text`       | string (max 16,000 chars) | Concatenated and treated as the user message |
| `object`     | string or object          | Accepted for forward-compat, ignored today   |
| `tool_input` | string or object          | Accepted for forward-compat, ignored today   |

---

## 4. Endpoints

### 4.1 POST `/api/v2/apps/:appId/environments/:envName/runs/execute`

Execute one conversational turn. Three transport modes in order of precedence:

1. **SSE streaming** — when `stream.enable === true`
2. **Async-push (webhook)** — when `isAsync === true` and `callbackUrl` is present
3. **Sync JSON** — otherwise

> If `isAsync: true` is sent **together with** `stream.enable: true`, streaming wins and no `callbackUrl` is required.

#### Request body

```json
{
  "sessionIdentity": [{ "type": "sessionReference", "value": "conv-123" }],
  "input": [{ "type": "text", "content": "I have a broadband issue" }],

  "stream": { "enable": false, "streamMode": "tokens" },
  "isAsync": false,
  "callbackUrl": "https://my-server.example/agent-assist/agenticresponse",

  "source": "AIS-AA",
  "metadata": { "conversationId": "c-abc", "botId": "st-...", "language": "en" },

  "debug": { "enable": false, "debugMode": "full" },
  "invoke": null,
  "attachments": null,
  "additionalArgs": null,
  "metrics": null
}
```

| Field                                                         | Type                     | Required | Notes                                                                                                                                                              |
| ------------------------------------------------------------- | ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sessionIdentity`                                             | `SessionIdentity[]`      | ✓        | At least one entry                                                                                                                                                 |
| `input`                                                       | `InputItem[]`            | ✓        | At least one entry                                                                                                                                                 |
| `stream.enable`                                               | boolean                  | —        | `true` → SSE response                                                                                                                                              |
| `stream.streamMode`                                           | `"tokens" \| "messages"` | —        | Only `tokens` is implemented today                                                                                                                                 |
| `isAsync`                                                     | boolean                  | —        | When `true` (and `stream.enable` is falsy) the server returns 202 and POSTs the final envelope to `callbackUrl`                                                    |
| `callbackUrl`                                                 | string                   | —        | Required when `isAsync: true` and not streaming. Must be absolute `https://` (or `http://localhost` in dev). Loopback / RFC1918 / link-local rejected              |
| `source`                                                      | string ≤ 128             | —        | Free-form caller tag; echoed back on session and envelopes                                                                                                         |
| `metadata`                                                    | object                   | —        | Passthrough. Reserved keys stripped before forwarding: `history`, `token`, `credentials`, `apiKey`, `authorization`, `sessionId`, `runId`, `bindingId`, `tenantId` |
| `invoke`, `attachments`, `additionalArgs`, `metrics`, `debug` | any                      | —        | Accepted for forward-compat, not interpreted today                                                                                                                 |

Request body max size: **512 KiB**. Over → `413`.

#### Response — Sync (`200 OK`)

```json
{
  "messageId": "msg_7531d5fe-7922-45ef-863d-c7fe188ba110",
  "output": [{ "type": "text", "content": "Happy to help — can you share…" }],
  "sessionInfo": {
    "sessionId": "s-8b82a405-b6c0-e233-1da0-f055b0184d3a",
    "runId": "50dabc64-217c-4b6c-89b4-677f8f8d89d2",
    "status": "completed",
    "sessionReference": "conv-123",
    "userReference": "u-end-user-42",
    "userId": "019d3e0b-d70d-7075-b1a8-4e584863beec",
    "appId": "019dbbeb-35c7-7e0d-9394-3926e733cff9",
    "source": "AIS-AA"
  },
  "metadata": { "...echoed caller metadata..." }
}
```

#### Response — Async-push (`202 Accepted`)

Immediate body (same shape as sync, but `sessionInfo.status = "processing"` and `output[0].content = ""`). The final envelope — identical to the sync body, with `status: "completed"` — is **POSTed** to `callbackUrl` once execution finishes. Error envelopes are also delivered to the same URL when execution fails.

Callback delivery details are in §5.

#### Response — SSE (`200 OK`, `Content-Type: text/event-stream`)

Frames are raw `data: <json>\n\n` packets (no named SSE events). Each JSON payload matches `V1StreamFrame`:

```
data: { "eventIndex": 0, "isLastEvent": false, "messageId": "msg_...", "sessionInfo": { "sessionId": "s-...", "runId": "...", "status": "processing", "appId": "..." } }

data: { "eventIndex": 1, "isLastEvent": false, "messageId": "msg_...", "output": [{ "type": "text", "content": "Happy " }] }

data: { "eventIndex": 2, "isLastEvent": false, "messageId": "msg_...", "output": [{ "type": "text", "content": "to help — " }] }

data: { "eventIndex": 3, "isLastEvent": true,  "messageId": "msg_...", "output": [{ "type": "text", "content": "Happy to help — can you share…" }], "sessionInfo": { "sessionId": "s-...", "runId": "...", "status": "completed", "appId": "..." } }
```

Frame-level contract:

- The first frame (`eventIndex: 0`) is the **opener** and carries `sessionInfo`. Clients should treat it as the HTTP response handshake.
- Intermediate frames carry incremental `output[].content` deltas that the client concatenates.
- The terminal frame has `isLastEvent: true` and repeats the full `output[0].content` plus the completed `sessionInfo`. Clients should use this to finalize the message.
- Heartbeats are SSE comments: `: heartbeat\n\n` every 15 s. Ignored by spec-compliant parsers.
- On error during streaming, a terminal frame with `sessionInfo.status = "error"` is emitted before the stream closes.

Response headers:

```
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

---

### 4.2 POST `/api/v2/apps/:appId/environments/:envName/sessions`

Create (or fetch) the session envelope Kore.ai's widget uses to initialize a chat. This call is idempotent: the same `sessionReference` produces the same `sessionId`.

#### Request body

```json
{
  "sessionIdentity": [{ "type": "sessionReference", "value": "conv-123" }],
  "metadata": { "isSendWelcomeMessage": true, "language": "en" },
  "source": "smartassist-color-scheme"
}
```

| Field                           | Type                | Required | Notes                                                                                      |
| ------------------------------- | ------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `sessionIdentity`               | `SessionIdentity[]` | ✓        |                                                                                            |
| `metadata.isSendWelcomeMessage` | boolean             | —        | When `true` the response includes a `Welcome_Event` with the binding's configured greeting |
| `source`                        | string ≤ 128        | —        | Caller tag; also read from `metadata.source` as fallback                                   |

#### Response (`200 OK`)

```json
{
  "session": {
    "sessionId": "s-fc36831e-32d7-323d-0d09-b58c3c29c0d1",
    "sessionReference": "conv-123",
    "userReference": "conv-123",
    "status": "idle",
    "userId": "u-a367e5f1-9e49-c93c-2e2e-aaba8e51c271",
    "createdAt": "2026-04-23T20:09:40.459Z",
    "source": "smartassist-color-scheme"
  },
  "events": [{ "type": "Welcome_Event", "content": { "messageToUser": "How can I help you?" } }],
  "output": [{ "type": "text", "content": "How can I help you?" }],
  "allowedMimeTypes": ["pdf", "docx", "doc", "txt", "json", "csv", "png", "jpg"],
  "fileUploadConfig": {
    "maxFileCount": 0,
    "maxFileSize": 0,
    "maxTokens": 0,
    "isAttachmentsEnabled": false
  }
}
```

When `isSendWelcomeMessage` is falsy, `events` and `output` are empty arrays.

#### 4.2.1 Welcome message — how it is resolved

The widget controls **whether** to greet (`metadata.isSendWelcomeMessage`); ABL controls **what** the greeting says. The runtime resolves the text against the binding's active deployment in three tiers, returning the first non-empty, non-templated string:

| Tier | Source                                             | Configure in DSL                                         |
| ---- | -------------------------------------------------- | -------------------------------------------------------- |
| 1    | `agentIR.on_start.respond` of the **entry agent**  | `ON_START.respond` block                                 |
| 2    | `agentIR.messages.greeting` of the **entry agent** | `MESSAGES.greeting` field                                |
| 3    | `DEFAULT_MESSAGES.greeting` (platform default)     | n/a — `"How can I help you?"` baked into `@abl/compiler` |

Implementation: `apps/runtime/src/services/agent-assist/welcome-resolver.ts`.

Skip rules:

- A tier is **skipped** when its string is empty/whitespace **or** contains a `{{placeholder}}`. `/sessions` fires before any session variables exist, so a templated greeting would otherwise leak the literal `{{user.name}}` to the end user. The resolver falls through to the next tier instead.
- Resolver failures (deployment missing, IR missing, exception) are logged at `warn` level and an **empty** `messageToUser` slot is emitted — `/sessions` never 5xx's because of welcome lookup.

What the runtime actually picks for a given binding:

1. `binding.deploymentId` is honored first. If null (the common case), `DeploymentResolver` selects the **environment-active** deployment for the project + environment.
2. The deployment's `entryAgentName` field selects the entry agent.
3. The entry agent's compiled `irContent` is read (from `AgentVersion.irContent`, JSON-decoded), and the priority chain runs against it.

Important compiler behavior (gotcha): the IR compiler **always merges `DEFAULT_MESSAGES` into every agent's IR**, so even agents whose DSL has no `MESSAGES:` block end up with `messages.greeting = "How can I help you?"` in their compiled IR (`packages/compiler/src/platform/ir/compiler.ts:711` → `compileMessages` → `{ ...DEFAULT_MESSAGES, ...docMessages }`). That means tier 2 is virtually never empty, and tier 3 is reached only on resolver failure. To override the welcome you must explicitly set tier 1 or tier 2 in the DSL — there is no "remove default" path.

#### 4.2.2 How to override the welcome — DSL configuration

Edit the DSL of the deployment's **entry agent**, not just any agent in the project. The entry agent name is the value of the deployment's `entryAgentName` field (also visible in Studio under the deployment's manifest).

Two equivalent ways to set it. Tier 1 wins if both are present.

**Option A — `ON_START.respond` (tier 1, canonical per-agent welcome slot):**

```yaml
AGENT: HumanEscalation
GOAL: '...'
PERSONA: |
  ...

ON_START:
  respond: 'Welcome to Telecom Support — how can I help you today?'
```

**Option B — `MESSAGES.greeting` (tier 2):**

```yaml
AGENT: HumanEscalation
GOAL: '...'
PERSONA: |
  ...

MESSAGES:
  greeting: 'Welcome to Telecom Support — how can I help you today?'
  # other defaults stay merged from DEFAULT_MESSAGES — no need to redefine them
```

Rules and pitfalls:

- **No `{{placeholder}}` in either field** — `/sessions` cannot interpolate before the session exists, so any string containing `{{...}}` is silently skipped. If you need dynamic content (user name, account tier, time of day), do it from `runs/execute` instead — `/sessions` is intentionally session-state-free.
- **Promote a new agent version** after the change. Only **promoted** versions are reachable via the deployment manifest; saving a draft is not enough. Studio: bump the version, promote, redeploy (or update the active environment to the new deployment).
- The entry agent for **each environment** is independent. If you have different agents wired as entry for `dev` vs `production`, set the welcome on each.

#### 4.2.3 How to verify the change

After promoting and redeploying:

1. From the widget (or curl), call `POST /sessions` with `metadata.isSendWelcomeMessage: true` and a fresh `sessionReference`.
2. Inspect `events[0].content.messageToUser` and `output[0].content` in the response — both should equal your new string.
3. Trace events for that turn (Observatory or runtime trace store) include `agent_assist.binding_resolved` immediately followed by the session response — useful when correlating widget timing with runtime resolution.

If the response still shows the old text:

- Confirm the deployment your binding points at — `db.agent_assist_bindings.findOne({appId, environment}).deploymentId` (null = env-active resolved at runtime).
- Confirm the entry agent — `db.deployments.findOne({_id}).entryAgentName`.
- Confirm the IR — load `AgentVersion.irContent` for that agent + version and check `agents.<entryAgentName>.on_start.respond` and `.messages.greeting`. The runtime reads exactly those fields.
- If `irContent` looks right, the in-process deployment cache may still be holding the old resolution; restart the runtime or wait for the cache TTL.

---

### 4.3 POST `/api/v2/apps/:appId/environments/:envName/sessions/terminate`

End the session. Fire-and-forget — the terminate envelope is always returned even if the session is unknown or execution cleanup fails.

#### Request body

```json
{
  "sessionIdentity": [
    { "type": "sessionId", "value": "s-fc36831e-..." },
    { "type": "sessionReference", "value": "conv-123" },
    { "type": "userReference", "value": "u-end-user-42" }
  ]
}
```

`sessionId` may be presented as type `sessionId` or `sessionIdentity`. If only `sessionReference` is provided, the same deterministic derivation is used.

#### Response (`200 OK`)

```json
{
  "status": "terminated",
  "sessionId": "s-fc36831e-32d7-323d-0d09-b58c3c29c0d1",
  "sessionReference": "conv-123",
  "userReference": "u-end-user-42",
  "userId": "u-a367e5f1-9e49-c93c-2e2e-aaba8e51c271",
  "appId": "019dbbeb-35c7-7e0d-9394-3926e733cff9",
  "attachments": []
}
```

---

## 5. Async-push callback contract

When the caller supplies `isAsync: true` + `callbackUrl` (and is **not** streaming), the runtime:

1. Returns `202 Accepted` with a `processing` envelope synchronously.
2. Executes the turn asynchronously.
3. Sends a single `POST` to `callbackUrl` with the **final envelope** (same shape as the sync 200 response).

Delivery runs through a durable BullMQ worker that retries with exponential backoff on transient failures and routes to a dead-letter queue after exhausting attempts.

### Callback request

```
POST <callbackUrl>
Content-Type: application/json
X-ABL-Signature: t=1714560623,v1=3b7f8d…
```

Body — identical to the sync 200 response, with `sessionInfo.status = "completed"` or `"error"`.

### X-ABL-Signature

Stripe-style HMAC-SHA256 signature. Format:

```
X-ABL-Signature: t=<unix_seconds>,v1=<hex_hmac_sha256>
```

Signed payload:

```
<unix_seconds> + "." + <raw_json_body>
```

Verification (pseudo-code):

```ts
function verify(header, rawBody, secret) {
  const { t, v1 } = parseCommaList(header);
  const signed = `${t}.${rawBody}`;
  const expected = hmacSHA256Hex(secret, signed);
  return timingSafeEqual(v1, expected) && Math.abs(nowSeconds() - Number(t)) < 300;
}
```

- The shared secret is set per-deployment via the `AGENT_ASSIST_CALLBACK_SIGNING_SECRET` env var.
- Receivers should reject requests older than 5 minutes to prevent replay.

### Callback URL validation

Rejected at request time (`400 INVALID_CALLBACK_URL`):

- Non-`https://` schemes (except `http://localhost` for local dev)
- Loopback addresses (`127.0.0.1`, `::1`, `0.0.0.0`)
- RFC1918 private ranges (`10.*`, `172.16.0.0/12`, `192.168.*`)
- Link-local (`169.254.*`)

---

## 6. Examples

### Sync turn

```bash
curl -sS -X POST \
  "https://<host>/api/v2/apps/019dbbeb-.../environments/production/runs/execute" \
  -H "x-api-key: abl_<token>" \
  -H "content-type: application/json" \
  --data '{
    "sessionIdentity": [{ "type": "sessionReference", "value": "conv-1" }],
    "input": [{ "type": "text", "content": "Hi" }]
  }'
```

### Streaming turn (what Kore.ai sends)

```bash
curl -N -X POST \
  "https://<host>/api/v2/apps/.../runs/execute" \
  -H "x-api-key: abl_<token>" \
  -H "content-type: application/json" \
  --data '{
    "sessionIdentity": [{ "type": "sessionReference", "value": "conv-1" }],
    "input": [{ "type": "text", "content": "I have a broadband issue" }],
    "isAsync": true,
    "stream": { "enable": true, "streamMode": "tokens" }
  }'
```

### Async-push turn

```bash
curl -sS -X POST \
  "https://<host>/api/v2/apps/.../runs/execute" \
  -H "x-api-key: abl_<token>" \
  -H "content-type: application/json" \
  --data '{
    "sessionIdentity": [{ "type": "sessionReference", "value": "conv-1" }],
    "input": [{ "type": "text", "content": "Hi" }],
    "isAsync": true,
    "callbackUrl": "https://my-server.example/ai/callback"
  }'
```

Response: `202` with a `processing` envelope. A second `POST` will arrive at `my-server.example/ai/callback` a few seconds later with the completed envelope and an `X-ABL-Signature` header.

### Create session with welcome

```bash
curl -sS -X POST \
  "https://<host>/api/v2/apps/.../sessions" \
  -H "x-api-key: abl_<token>" \
  -H "content-type: application/json" \
  --data '{
    "sessionIdentity": [{ "type": "sessionReference", "value": "conv-1" }],
    "metadata": { "isSendWelcomeMessage": true }
  }'
```

### Terminate session

```bash
curl -sS -X POST \
  "https://<host>/api/v2/apps/.../sessions/terminate" \
  -H "x-api-key: abl_<token>" \
  -H "content-type: application/json" \
  --data '{
    "sessionIdentity": [{ "type": "sessionReference", "value": "conv-1" }]
  }'
```

---

## 7. Provisioning — how to get `appId` + `apiKey`

An Agent Assist binding is created from **ABL Studio** by the project owner:

1. Open the project → **Settings → Agent Assist**.
2. Enable Agent Assist for the project.
3. Click **Add connection**, pick a provider (e.g. Kore Agent Assist), name it, choose an environment.
4. Click **Configuration** on the new row to reveal:
   - Domain URL (the base URL to call — Studio proxy or runtime)
   - App ID (equals the ABL `projectId`)
   - Environment
   - API Key (shown **once** on generation — copy it immediately; rotate to re-view)

These four values are the full set of credentials an external Agent Assist runtime needs to call the facade.

The Studio-side management API (internally used by the Settings UI) is documented separately under `/api/projects/:projectId/agent-assist-bindings/*` and is not intended for third-party consumption.

---

## 8. Operational notes

### Rate limiting

Standard per-tenant rate limiting applies (`tenantRateLimit('request')`), matching other ABL APIs.

### Observability

The facade emits trace events into the runtime TraceStore on every request. Visible in the Observatory UI:

| Event                              | When                                      |
| ---------------------------------- | ----------------------------------------- |
| `agent_assist.received`            | Entry, after auth, before execution       |
| `agent_assist.binding_resolved`    | Binding lookup succeeded                  |
| `agent_assist.delegated`           | Request handed to the runtime executor    |
| `agent_assist.translated_response` | Final envelope built                      |
| `agent_assist.callback_scheduled`  | Async job enqueued                        |
| `agent_assist.callback_delivered`  | Callback `POST` returned 2xx              |
| `agent_assist.callback_failed`     | Callback delivery exhausted retries (DLQ) |
| `agent_assist.error`               | Execution failure                         |

### Limits and configuration

| Env var                                | Default                       | Purpose                                                |
| -------------------------------------- | ----------------------------- | ------------------------------------------------------ |
| `AGENT_ASSIST_CALLBACK_SIGNING_SECRET` | (required for async-push)     | HMAC secret for `X-ABL-Signature`                      |
| `AGENT_ASSIST_WORKER_CONCURRENCY`      | `10`                          | BullMQ callback worker parallelism                     |
| `AGENT_ASSIST_DEBUG_RECORD`            | `false`                       | Dev: capture each request/response to a JSON-lines log |
| `AGENT_ASSIST_DEBUG_LOG`               | `/tmp/agent-assist-debug.log` | Log path when debug capture is on                      |

| Constant (compiled)     | Value        | Purpose                              |
| ----------------------- | ------------ | ------------------------------------ |
| Max request body        | 512 KiB      | Over → `413`                         |
| Max text input per item | 16,000 chars | Per `input[].content`                |
| Max history messages    | 50           | If `metadata.aa_uamsgs` is forwarded |
| SSE heartbeat           | 15 s         | `: heartbeat` comment line           |

### CORS

The facade is invoked server-to-server by external Agent Assist runtimes, not from browsers. CORS is not enabled on `/api/v2/apps/*`.

---

## 9. Changelog

- **v1 (this document)** — Initial public API reference. SSE streaming, async-push with HMAC-signed callbacks, and sync JSON all supported on `/runs/execute`. Session create/terminate envelopes match Kore.ai's widget contract.

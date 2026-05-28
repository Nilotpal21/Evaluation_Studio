# API Fundamentals

> **Estimated time**: 30 minutes | **Prerequisites**: Platform Concepts, Identity & Authentication

## Learning Objectives

After completing this module, you will be able to:

- Describe the SSE streaming model including the 'complete' event with usage data
- Explain the role of 15-second heartbeats in keeping SSE connections alive
- Use pk\_ public API keys for widget integrations with origin restrictions
- Continue a conversation using sessionId across multiple API calls
- Interpret the 410 Gone response for retired deployments

## The Agent Platform API

The Agent Platform exposes a RESTful API for managing agents, sessions, chat interactions, deployments, and analytics. This module covers the core patterns you need to integrate with the platform: authentication, conversation flow, streaming, and the management endpoints.

## Authentication Methods

Every API request requires authentication. The platform supports four credential types, each designed for a specific use case.

### JWT Bearer Token

Issued after user login, used for Studio and admin operations:

```bash
curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIs..." \
  https://api.ablplatform.com/api/v1/chat/agent
```

### API Key (Secret)

Long-lived keys prefixed with `abl_` for server-to-server integrations:

```bash
curl -H "Authorization: Bearer abl_sk-your-api-key" \
  https://api.ablplatform.com/api/v1/chat/agent
```

For service-to-service calls, you can also use the `X-API-Key` header:

```bash
curl -H "X-API-Key: ak_your_api_key" \
  https://api.ablplatform.com/api/v1/chat/send
```

### SDK Session Token

Short-lived tokens for embedded widget sessions:

```bash
curl -H "X-SDK-Token: sdk_token_value" \
  https://api.ablplatform.com/api/v1/chat/agent
```

### Public API Key (Widgets)

> **Key Concept**: Public API keys start with `pk_` and are designed to be safe for client-side code. They provide limited permissions scoped to SDK usage -- widget configuration, session creation, and message sending. Unlike secret API keys, `pk_` keys can be embedded in browser JavaScript because they are restricted by project scope and origin validation.

```bash
curl -H "X-API-Key: pk_your-public-key" \
  https://api.ablplatform.com/api/v1/sdk/config/PROJECT_ID
```

Always configure allowed origins to prevent unauthorized use:

```json
{
  "allowedOrigins": ["https://your-app.example.com", "https://staging.your-app.example.com"]
}
```

The runtime validates the `Origin` header on every SDK request and rejects requests from unlisted origins. This means even if someone discovers your `pk_` key, they cannot use it from a domain you have not authorized.

## The Conversation API

The conversation API is the core interface for agent interactions. It supports three modes: agent-backed chat, streaming completions, and non-streaming completions.

### Agent-Backed Chat

Send a message through the ABL runtime against a deployed agent project:

```bash
curl -X POST https://api.ablplatform.com/api/v1/chat/agent \
  -H "Authorization: Bearer abl_sk-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "clx1abc2d0000ab12cd34ef56",
    "message": "I need help resetting my password"
  }'
```

The response includes the agent's reply, session state, and trace events:

```json
{
  "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "response": "I can help you reset your password. Could you provide me with the email address associated with your account?",
  "action": { "type": "continue" },
  "state": {
    "currentStep": "gather-email",
    "intent": "password_reset"
  },
  "traceEvents": [
    {
      "type": "llm_call",
      "data": {
        "model": "claude-sonnet-4-20250514",
        "usage": { "inputTokens": 245, "outputTokens": 38 }
      }
    }
  ]
}
```

### Session Continuation with sessionId

> **Key Concept**: The `sessionId` returned in the first response is how you continue a conversation. Pass it in subsequent requests to maintain conversation state, history, and context. Without a sessionId, each request creates a new session with no memory of previous messages. This is the fundamental mechanism for multi-turn conversations.

```bash
# First message -- creates a new session
curl -X POST https://api.ablplatform.com/api/v1/chat/agent \
  -H "Authorization: Bearer abl_sk-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "clx1abc2d0000ab12cd34ef56",
    "message": "I need help resetting my password"
  }'
# Response includes: "sessionId": "a1b2c3d4-..."

# Second message -- continues the same session
curl -X POST https://api.ablplatform.com/api/v1/chat/agent \
  -H "Authorization: Bearer abl_sk-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "clx1abc2d0000ab12cd34ef56",
    "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "message": "user@example.com"
  }'
```

The agent remembers the first message, knows the user is in the "gather-email" step, and processes the email address accordingly.

## Streaming with Server-Sent Events (SSE)

For real-time token delivery, use the streaming endpoint which sends incremental responses via SSE.

### The SSE Event Model

```bash
curl -X POST https://api.ablplatform.com/api/v1/chat/stream \
  -H "Authorization: Bearer abl_sk-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "clx1abc2d0000ab12cd34ef56",
    "messages": [
      { "role": "system", "content": "You are a helpful assistant." },
      { "role": "user", "content": "Explain quantum computing in one paragraph." }
    ]
  }'
```

The response is a stream of named events:

```
event: metadata
data: {"modelId":"claude-sonnet-4-20250514","provider":"anthropic","source":"tenant"}

event: text_delta
data: {"delta":"Quantum computing"}

event: text_delta
data: {"delta":" leverages the principles"}

event: usage
data: {"inputTokens":42,"outputTokens":128}

event: complete
data: {"inputTokens":42,"outputTokens":128,"totalTokens":170,"estimatedCost":0.0012,"latencyMs":2340}
```

### SSE Event Types

| Event             | Data                                                                   | Description                     |
| ----------------- | ---------------------------------------------------------------------- | ------------------------------- |
| `metadata`        | `{ modelId, provider, source }`                                        | Resolved model information      |
| `text_delta`      | `{ delta }`                                                            | Incremental text chunk          |
| `tool_call_start` | `{ id, name }`                                                         | Tool call initiated             |
| `tool_call_delta` | `{ id, arguments }`                                                    | Incremental tool call arguments |
| `tool_call_end`   | `{ id, name, arguments }`                                              | Tool call completed             |
| `usage`           | `{ inputTokens, outputTokens }`                                        | Token usage update              |
| `error`           | `{ error }`                                                            | Stream error                    |
| `complete`        | `{ inputTokens, outputTokens, totalTokens, estimatedCost, latencyMs }` | Stream finished                 |

> **Key Concept**: The `complete` event signals that the stream has finished and includes comprehensive usage data: total input and output tokens, the combined total, estimated cost in USD, and end-to-end latency in milliseconds. This is the event your client should listen for to finalize the response, update usage tracking, and close the connection. It provides all the data you need for cost monitoring and performance tracking in a single payload.

### Heartbeats

> **Key Concept**: SSE connections send periodic heartbeat comments (`: heartbeat`) every **15 seconds** to keep the connection alive through proxies and load balancers. Many reverse proxies (nginx, CloudFlare, AWS ALB) close idle connections after 30-60 seconds. Without heartbeats, a slow LLM response could cause the proxy to terminate the connection before the first token arrives. The heartbeat is an SSE comment (prefixed with `:`) and should be ignored by your SSE parser -- it carries no data.

If you are implementing a custom SSE client, make sure your connection timeout is set above 15 seconds. If you are behind a proxy with a short idle timeout, the heartbeats should prevent premature disconnection.

### Consuming SSE in JavaScript

```javascript
const response = await fetch('/api/v1/chat/stream', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: 'Bearer your-token',
  },
  body: JSON.stringify({
    sessionId: 'session-id',
    message: 'Hello',
  }),
});

const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  const chunk = decoder.decode(value);
  // Parse SSE events from chunk
}
```

## Error Handling

### HTTP Status Codes

| Code  | Meaning               | When It Occurs                                 |
| ----- | --------------------- | ---------------------------------------------- |
| `200` | OK                    | Successful read or update                      |
| `201` | Created               | Resource created successfully                  |
| `400` | Bad Request           | Validation failed, missing required fields     |
| `401` | Unauthorized          | Missing or invalid authentication              |
| `403` | Forbidden             | Valid credentials but insufficient permissions |
| `404` | Not Found             | Resource does not exist or not accessible      |
| `409` | Conflict              | Duplicate resource                             |
| `410` | Gone                  | Resource has been permanently removed          |
| `413` | Payload Too Large     | Request body exceeds size limit                |
| `429` | Too Many Requests     | Rate limit exceeded                            |
| `500` | Internal Server Error | Unexpected failure                             |
| `503` | Service Unavailable   | Backend service offline                        |

### 410 Gone for Retired Deployments

> **Key Concept**: When you target a deployment that has been retired (via the `/retire` endpoint), the API returns **410 Gone**. This is distinct from 404 -- it tells the client that the deployment existed but has been permanently deactivated. Your client should handle 410 by prompting the user to reconnect or by redirecting to a different deployment. Do not retry a 410 -- the deployment will not come back.

```json
{
  "success": false,
  "error": {
    "code": "DEPLOYMENT_RETIRED",
    "message": "Deployment is retired"
  }
}
```

### Error Response Format

Standard error responses follow a consistent structure:

```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Agent not found: my-agent"
  }
}
```

## Rate Limits

The platform enforces per-tenant rate limits. When exceeded, the API returns `429 Too Many Requests` with guidance on when to retry.

### Rate Limit Headers

| Header                  | Description                                    |
| ----------------------- | ---------------------------------------------- |
| `X-RateLimit-Remaining` | Requests remaining in the current window       |
| `X-RateLimit-Reset`     | Unix timestamp when the window resets          |
| `Retry-After`           | Seconds until you can retry (on 429 responses) |

The JSON body also includes a `retryAfterMs` field:

```json
{
  "error": "Session message rate limit exceeded",
  "retryAfterMs": 2000
}
```

Implement exponential backoff for `429` and `503` responses.

## Management APIs

### Agent Discovery

List and inspect agents across your tenant:

```bash
# List all agents
curl https://api.ablplatform.com/api/agents \
  -H "Authorization: Bearer abl_sk-your-api-key"

# Get agent details
curl https://api.ablplatform.com/api/agents/support-agent \
  -H "Authorization: Bearer abl_sk-your-api-key"
```

### Deployments

Create deployments that bundle specific agent versions for a target environment:

```bash
curl -X POST https://api.ablplatform.com/api/projects/proj_abc/deployments \
  -H "Authorization: Bearer abl_sk-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "environment": "production",
    "agentVersionManifest": {
      "support-agent": "3",
      "escalation-agent": "2"
    },
    "entryAgentName": "support-agent",
    "label": "v2.1 production release"
  }'
```

Deployment lifecycle: `active` --> `retired` (via `/retire` endpoint). Retired deployments return 410 Gone. You can also `rollback` a retired deployment or `promote` from staging to production.

### Tool Secrets

Manage encrypted credentials for agent tools:

```bash
# Create a secret
curl -X POST https://api.ablplatform.com/api/tool-secrets \
  -H "Authorization: Bearer abl_sk-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "clx1abc2d0000ab12cd34ef56",
    "toolName": "crm-lookup",
    "secretKey": "API_KEY",
    "value": "sk-your-api-key",
    "environment": "production"
  }'
```

Secret values are encrypted with AES-256-GCM and tenant-scoped keys. The API never returns secret values -- only metadata.

## Sessions

Sessions track conversation state for agent-backed interactions. They are project-scoped and include rich metadata.

```bash
# List sessions
curl "https://api.ablplatform.com/api/projects/proj_abc/sessions?status=active&limit=50" \
  -H "Authorization: Bearer abl_sk-your-api-key"

# Get session details
curl https://api.ablplatform.com/api/projects/proj_abc/sessions/sess_123 \
  -H "Authorization: Bearer abl_sk-your-api-key"

# Get execution traces
curl https://api.ablplatform.com/api/projects/proj_abc/sessions/sess_123/traces \
  -H "Authorization: Bearer abl_sk-your-api-key"
```

Session objects include `messageCount`, `tokenCount`, `estimatedCost`, `errorCount`, `durationMs`, and `handoffCount` -- giving you full visibility into what happened in a conversation.

## Pagination

List endpoints use offset-based pagination:

```bash
# Page 1
curl "https://api.ablplatform.com/api/projects/proj_abc/sessions?limit=50&offset=0" \
  -H "Authorization: Bearer abl_sk-your-api-key"

# Page 2
curl "https://api.ablplatform.com/api/projects/proj_abc/sessions?limit=50&offset=50" \
  -H "Authorization: Bearer abl_sk-your-api-key"
```

The response includes a `total` field to determine whether more pages exist.

## Auth Contract Codes

When an agent requires user authentication (e.g., before an OAuth-protected tool), the API returns structured auth contract codes:

| Code                       | Meaning                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| `AUTH_PREFLIGHT_REQUIRED`  | Agent requires user consent before proceeding                      |
| `AUTH_PREFLIGHT_SATISFIED` | Consent has been granted; session may continue                     |
| `AUTH_JIT_REQUIRED`        | Tool call requires just-in-time authentication (e.g., OAuth popup) |
| `AUTH_JIT_UNSUPPORTED`     | Requested auth method not supported by current channel             |

Handle these in your client to provide seamless authentication flows.

## Key Takeaways

- The SSE `complete` event includes full usage data (tokens, cost, latency) -- use it for cost tracking and performance monitoring
- 15-second heartbeats keep SSE connections alive through proxies; set your client timeout above this interval
- `pk_` public API keys are safe for client-side code and provide limited, project-scoped SDK permissions
- Use `sessionId` from the first response to continue multi-turn conversations; omitting it creates a new session each time
- 410 Gone means a deployment has been permanently retired -- do not retry; redirect to an active deployment

## What's Next

Explore the [Management APIs](../operations-deployment/content.md) module for deployment lifecycle management, or see [Knowledge Architecture](../knowledge-architecture/content.md) for the analytics and cost-breakdown APIs.

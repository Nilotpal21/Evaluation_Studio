# ABL Platform API Reference

## Introduction

The ABL Platform API is a RESTful HTTP API that provides programmatic access to all platform capabilities, including authentication, project management, agent configuration, knowledge base operations, search, and conversations. All API requests must be authenticated, and all responses are returned in JSON format.

**Base URL**: `https://api.ablplatform.io/v1`

**Content-Type**: All request bodies must be sent with `Content-Type: application/json` unless otherwise specified.

**Rate Limiting**: API requests are rate-limited per token at 1000 requests per minute by default. Rate limit headers are included in every response:

```
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 987
X-RateLimit-Reset: 1700000060
```

When a rate limit is exceeded, the API returns `429 Too Many Requests` with a `Retry-After` header indicating when the limit resets.

---

## Authentication

### Login

Authenticate with email and password credentials to receive an access token and refresh token.

**Endpoint**: `POST /auth/login`

**Request**:

```json
{
  "email": "user@example.com",
  "password": "your-password"
}
```

**Response** (`200 OK`):

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "dGhpcyBpcyBhIHJlZnJlc2ggdG9rZW4...",
  "expiresIn": 3600,
  "tokenType": "Bearer",
  "user": {
    "_id": "usr_01HXYZ123",
    "email": "user@example.com",
    "name": "Jane Smith",
    "tenantId": "ten_01HXYZ456",
    "roles": ["member"]
  }
}
```

**Error Responses**:

- `401 Unauthorized` — Invalid email or password
- `403 Forbidden` — Account suspended or tenant inactive
- `429 Too Many Requests` — Too many login attempts

### Development Login

For development and testing environments, the dev-login endpoint accepts a pre-configured user identifier without password verification. This endpoint is only available when `NODE_ENV` is not `production`.

**Endpoint**: `POST /auth/dev-login`

**Request**:

```json
{
  "userId": "usr_01HXYZ123",
  "tenantId": "ten_01HXYZ456"
}
```

**Response** (`200 OK`): Same as standard login response.

### Refresh Token

Exchange a refresh token for a new access token.

**Endpoint**: `POST /auth/refresh`

**Request**:

```json
{
  "refreshToken": "dGhpcyBpcyBhIHJlZnJlc2ggdG9rZW4..."
}
```

**Response** (`200 OK`):

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": 3600,
  "tokenType": "Bearer"
}
```

### Logout

Invalidate the current session and revoke the refresh token.

**Endpoint**: `POST /auth/logout`

**Headers**: `Authorization: Bearer <accessToken>`

**Response** (`204 No Content`): Empty body on success.

### API Keys

API keys provide long-lived authentication for programmatic integrations and service-to-service communication. Unlike JWT tokens, API keys do not expire automatically but can be revoked at any time.

**Create API Key**

**Endpoint**: `POST /auth/api-keys`

**Headers**: `Authorization: Bearer <accessToken>`

**Request**:

```json
{
  "name": "production-integration",
  "description": "API key for production data pipeline",
  "expiresAt": "2025-12-31T23:59:59Z",
  "scopes": ["search:read", "kb:read", "conversations:write"]
}
```

**Response** (`201 Created`):

```json
{
  "apiKey": {
    "_id": "key_01HXYZ789",
    "name": "production-integration",
    "description": "API key for production data pipeline",
    "prefix": "ablk_live_",
    "key": "ablk_live_abc123def456ghi789...",
    "scopes": ["search:read", "kb:read", "conversations:write"],
    "expiresAt": "2025-12-31T23:59:59Z",
    "createdAt": "2024-01-15T10:30:00Z",
    "lastUsedAt": null
  }
}
```

**Important**: The full key value is only returned once at creation time. Store it securely.

**List API Keys**

**Endpoint**: `GET /auth/api-keys`

**Response** (`200 OK`):

```json
{
  "apiKeys": [
    {
      "_id": "key_01HXYZ789",
      "name": "production-integration",
      "prefix": "ablk_live_",
      "scopes": ["search:read", "kb:read"],
      "expiresAt": "2025-12-31T23:59:59Z",
      "createdAt": "2024-01-15T10:30:00Z",
      "lastUsedAt": "2024-06-01T08:15:30Z"
    }
  ],
  "total": 1
}
```

**Revoke API Key**

**Endpoint**: `DELETE /auth/api-keys/:keyId`

**Response** (`204 No Content`): Empty body on success.

---

## Projects API

Projects are the primary organizational unit for resources such as agents, knowledge bases, and search indexes. Every API resource belongs to exactly one project.

### Create Project

**Endpoint**: `POST /api/projects`

**Headers**: `Authorization: Bearer <accessToken>`

**Request**:

```json
{
  "name": "Customer Support AI",
  "description": "AI-powered customer support automation",
  "settings": {
    "defaultLanguage": "en",
    "timezone": "America/New_York",
    "retentionDays": 90
  }
}
```

**Response** (`201 Created`):

```json
{
  "project": {
    "_id": "proj_01HXYZ111",
    "name": "Customer Support AI",
    "description": "AI-powered customer support automation",
    "tenantId": "ten_01HXYZ456",
    "settings": {
      "defaultLanguage": "en",
      "timezone": "America/New_York",
      "retentionDays": 90
    },
    "createdAt": "2024-01-15T10:30:00Z",
    "updatedAt": "2024-01-15T10:30:00Z"
  }
}
```

### List Projects

**Endpoint**: `GET /api/projects`

**Query Parameters**:

| Parameter | Type   | Description                              |
| --------- | ------ | ---------------------------------------- |
| `page`    | number | Page number, default 1                   |
| `limit`   | number | Results per page, default 20, max 100    |
| `search`  | string | Filter projects by name (case-sensitive) |

**Response** (`200 OK`):

```json
{
  "projects": [
    {
      "_id": "proj_01HXYZ111",
      "name": "Customer Support AI",
      "description": "AI-powered customer support automation",
      "createdAt": "2024-01-15T10:30:00Z"
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20
}
```

### Get Project

**Endpoint**: `GET /api/projects/:projectId`

**Response** (`200 OK`): Returns a single project object as shown in the Create response.

**Error Responses**:

- `404 Not Found` — Project does not exist or belongs to a different tenant

### Update Project

**Endpoint**: `PATCH /api/projects/:projectId`

**Request**: Any subset of the fields from the Create request body.

**Response** (`200 OK`): Returns the updated project object.

### Delete Project

**Endpoint**: `DELETE /api/projects/:projectId`

**Response** (`204 No Content`): Project and all associated resources are deleted asynchronously. Deletion is irreversible.

---

## Agents API

Agents are configurable AI entities that process messages, execute tools, and produce responses. Each agent is defined by a model configuration, system prompt, tool bindings, and routing rules.

### Create Agent

**Endpoint**: `POST /api/projects/:projectId/agents`

**Request**:

```json
{
  "name": "Support Agent v1",
  "description": "Handles tier-1 customer support inquiries",
  "model": {
    "provider": "openai",
    "modelId": "gpt-4o",
    "temperature": 0.3,
    "maxTokens": 2048
  },
  "systemPrompt": "You are a helpful customer support agent for Acme Corp. Answer questions about products, returns, and billing. If you cannot resolve an issue, escalate to a human agent.",
  "tools": [
    {
      "type": "knowledge-base",
      "kbId": "kb_01HXYZ222",
      "topK": 5
    },
    {
      "type": "http",
      "name": "lookup_order",
      "url": "https://api.internal.acme.com/orders/{orderId}",
      "method": "GET"
    }
  ],
  "handoffs": [
    {
      "targetAgentId": "agent_01HXYZ333",
      "condition": "user requests escalation or expresses high frustration"
    }
  ]
}
```

**Response** (`201 Created`):

```json
{
  "agent": {
    "_id": "agent_01HXYZ444",
    "name": "Support Agent v1",
    "description": "Handles tier-1 customer support inquiries",
    "projectId": "proj_01HXYZ111",
    "version": 1,
    "status": "active",
    "model": {
      "provider": "openai",
      "modelId": "gpt-4o",
      "temperature": 0.3,
      "maxTokens": 2048
    },
    "createdAt": "2024-01-15T12:00:00Z",
    "updatedAt": "2024-01-15T12:00:00Z"
  }
}
```

### List Agents

**Endpoint**: `GET /api/projects/:projectId/agents`

**Query Parameters**: `page`, `limit`, `status` (active | archived | draft)

**Response** (`200 OK`):

```json
{
  "agents": [
    {
      "_id": "agent_01HXYZ444",
      "name": "Support Agent v1",
      "status": "active",
      "version": 1,
      "createdAt": "2024-01-15T12:00:00Z"
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20
}
```

### Get Agent

**Endpoint**: `GET /api/projects/:projectId/agents/:agentId`

**Response** (`200 OK`): Returns the full agent object including model, tools, and handoffs configuration.

### Update Agent

**Endpoint**: `PATCH /api/projects/:projectId/agents/:agentId`

**Request**: Any subset of agent fields. Updating configuration fields automatically increments the version number.

**Response** (`200 OK`): Returns the updated agent object with incremented version.

### Publish Agent Version

Lock the current agent configuration as a named version for production use.

**Endpoint**: `POST /api/projects/:projectId/agents/:agentId/versions`

**Request**:

```json
{
  "label": "v1.2-stable",
  "notes": "Improved system prompt, added order lookup tool"
}
```

**Response** (`201 Created`):

```json
{
  "version": {
    "_id": "ver_01HXYZ555",
    "agentId": "agent_01HXYZ444",
    "versionNumber": 3,
    "label": "v1.2-stable",
    "notes": "Improved system prompt, added order lookup tool",
    "snapshot": { "...full agent config at time of publish..." },
    "publishedAt": "2024-02-01T09:00:00Z",
    "publishedBy": "usr_01HXYZ123"
  }
}
```

### List Agent Versions

**Endpoint**: `GET /api/projects/:projectId/agents/:agentId/versions`

**Response** (`200 OK`): Array of version objects without full snapshots.

### Delete Agent

**Endpoint**: `DELETE /api/projects/:projectId/agents/:agentId`

**Response** (`204 No Content`): Agent is archived, not permanently deleted. Historical conversation data is preserved.

---

## Knowledge Bases API

Knowledge bases are collections of indexed documents that agents and search endpoints can query for relevant information. Each knowledge base is backed by a search index that supports keyword, vector, and hybrid retrieval.

### Create Knowledge Base

**Endpoint**: `POST /api/knowledge-bases`

**Request**:

```json
{
  "projectId": "proj_01HXYZ111",
  "name": "Product Documentation",
  "description": "Official product documentation and user guides",
  "settings": {
    "chunkSize": 512,
    "chunkOverlap": 64,
    "embeddingModel": "bge-m3",
    "retrievalMode": "hybrid",
    "language": "en"
  }
}
```

**Response** (`201 Created`):

```json
{
  "knowledgeBase": {
    "_id": "kb_01HXYZ222",
    "name": "Product Documentation",
    "description": "Official product documentation and user guides",
    "projectId": "proj_01HXYZ111",
    "searchIndexId": "idx_01HXYZ666",
    "status": "ready",
    "settings": {
      "chunkSize": 512,
      "chunkOverlap": 64,
      "embeddingModel": "bge-m3",
      "retrievalMode": "hybrid"
    },
    "stats": {
      "documentCount": 0,
      "chunkCount": 0,
      "totalSizeBytes": 0
    },
    "createdAt": "2024-01-15T14:00:00Z",
    "updatedAt": "2024-01-15T14:00:00Z"
  }
}
```

### List Knowledge Bases

**Endpoint**: `GET /api/knowledge-bases?projectId=proj_01HXYZ111`

**Required Query Parameter**: `projectId`

**Response** (`200 OK`):

```json
{
  "knowledgeBases": [
    {
      "_id": "kb_01HXYZ222",
      "name": "Product Documentation",
      "status": "ready",
      "stats": {
        "documentCount": 47,
        "chunkCount": 1203,
        "totalSizeBytes": 2457600
      },
      "updatedAt": "2024-03-01T10:00:00Z"
    }
  ],
  "total": 1
}
```

### Upload Document

Upload a document to a knowledge base source for ingestion.

**Endpoint**: `POST /api/indexes/:indexId/sources/:sourceId/documents`

**Content-Type**: `multipart/form-data`

**Form Fields**:

| Field      | Type   | Required | Description                                        |
| ---------- | ------ | -------- | -------------------------------------------------- |
| `file`     | File   | Yes      | Document file (PDF, DOCX, MD, TXT, HTML supported) |
| `metadata` | JSON   | No       | Additional metadata to attach to the document      |
| `tags`     | string | No       | Comma-separated tags for filtering                 |

**Response** (`201 Created`):

```json
{
  "document": {
    "_id": "doc_01HXYZ777",
    "filename": "user-guide-v2.pdf",
    "mimeType": "application/pdf",
    "sizeBytes": 524288,
    "status": "pending",
    "sourceId": "src_01HXYZ888",
    "indexId": "idx_01HXYZ666",
    "uploadedAt": "2024-03-01T11:00:00Z"
  }
}
```

### List Documents

**Endpoint**: `GET /api/indexes/:indexId/sources/:sourceId/documents`

**Query Parameters**: `page`, `limit`, `status` (pending | processing | completed | failed)

**Response** (`200 OK`):

```json
{
  "documents": [
    {
      "_id": "doc_01HXYZ777",
      "filename": "user-guide-v2.pdf",
      "status": "completed",
      "chunkCount": 87,
      "sizeBytes": 524288,
      "uploadedAt": "2024-03-01T11:00:00Z",
      "processedAt": "2024-03-01T11:02:45Z"
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20
}
```

### Trigger Ingestion Job

Manually trigger an ingestion pipeline run for a search index.

**Endpoint**: `POST /api/jobs`

**Request**:

```json
{
  "indexId": "idx_01HXYZ666"
}
```

**Response** (`201 Created`):

```json
{
  "job": {
    "id": "job_01HXYZ999",
    "indexId": "idx_01HXYZ666",
    "status": "queued",
    "documentsTotal": 3,
    "documentsProcessed": 0,
    "documentsErrored": 0,
    "createdAt": "2024-03-01T11:05:00Z"
  }
}
```

### Get Ingestion Job Status

**Endpoint**: `GET /api/jobs/:jobId`

**Response** (`200 OK`):

```json
{
  "job": {
    "id": "job_01HXYZ999",
    "indexId": "idx_01HXYZ666",
    "status": "completed",
    "documentsTotal": 3,
    "documentsProcessed": 3,
    "documentsErrored": 0,
    "startedAt": "2024-03-01T11:05:05Z",
    "completedAt": "2024-03-01T11:07:30Z",
    "durationMs": 145000
  }
}
```

Possible `status` values: `queued`, `running`, `completed`, `failed`, `cancelled`.

---

## Search API

The Search API enables querying over indexed knowledge bases using keyword, vector, and hybrid retrieval strategies.

### Query

Execute a search query against one or more knowledge bases.

**Endpoint**: `POST /api/search/query`

**Request**:

```json
{
  "projectId": "proj_01HXYZ111",
  "query": "What is the return policy for electronics?",
  "indexIds": ["idx_01HXYZ666"],
  "topK": 10,
  "mode": "hybrid",
  "filters": {
    "tags": ["returns", "electronics"],
    "language": "en",
    "uploadedAfter": "2024-01-01T00:00:00Z"
  }
}
```

**Response** (`200 OK`):

```json
{
  "results": [
    {
      "chunkId": "chunk_01HABC111",
      "documentId": "doc_01HXYZ777",
      "filename": "return-policy.pdf",
      "content": "Electronics purchased from our store are eligible for return within 30 days of purchase. Items must be in original packaging with all accessories included...",
      "score": 0.9423,
      "vectorScore": 0.9156,
      "keywordScore": 0.7812,
      "metadata": {
        "pageNumber": 3,
        "section": "Electronics Returns",
        "tags": ["returns", "electronics"]
      }
    }
  ],
  "total": 8,
  "query": "What is the return policy for electronics?",
  "latencyMs": 124
}
```

### Hybrid Search with Filters

Hybrid search combines dense vector similarity with BM25 keyword scoring using reciprocal rank fusion. Filters are applied before retrieval to narrow the candidate set.

**Endpoint**: `POST /api/search/hybrid`

**Request**:

```json
{
  "projectId": "proj_01HXYZ111",
  "query": "refund processing time credit card",
  "indexIds": ["idx_01HXYZ666"],
  "topK": 5,
  "vectorWeight": 0.6,
  "keywordWeight": 0.4,
  "filters": {
    "documentIds": ["doc_01HXYZ777", "doc_01HXYZ778"],
    "metadata": {
      "section": "Refunds"
    }
  },
  "rerank": true
}
```

**Response** (`200 OK`):

```json
{
  "results": [
    {
      "chunkId": "chunk_01HABC222",
      "documentId": "doc_01HXYZ777",
      "content": "Credit card refunds are processed within 5-7 business days after return approval...",
      "score": 0.9712,
      "rerankScore": 0.9812,
      "metadata": {
        "section": "Refunds",
        "pageNumber": 7
      }
    }
  ],
  "total": 3,
  "latencyMs": 198
}
```

### Search with Facets

Retrieve aggregated facet counts alongside search results for building filter UIs.

**Endpoint**: `POST /api/search/facets`

**Request**:

```json
{
  "projectId": "proj_01HXYZ111",
  "query": "product configuration",
  "indexIds": ["idx_01HXYZ666"],
  "facetFields": ["tags", "metadata.section", "metadata.language"]
}
```

**Response** (`200 OK`):

```json
{
  "results": ["...same as query response..."],
  "facets": {
    "tags": [
      { "value": "configuration", "count": 15 },
      { "value": "setup", "count": 9 },
      { "value": "advanced", "count": 4 }
    ],
    "metadata.section": [
      { "value": "Getting Started", "count": 8 },
      { "value": "Advanced Configuration", "count": 7 }
    ]
  }
}
```

---

## Conversations API

The Conversations API provides endpoints for creating and managing agent conversation sessions, sending messages, and streaming responses.

### Create Conversation

Initialize a new conversation session with an agent.

**Endpoint**: `POST /api/projects/:projectId/conversations`

**Request**:

```json
{
  "agentId": "agent_01HXYZ444",
  "metadata": {
    "userId": "end-user-123",
    "channel": "web-widget",
    "locale": "en-US"
  },
  "context": {
    "customerId": "cust_abc123",
    "accountTier": "premium"
  }
}
```

**Response** (`201 Created`):

```json
{
  "conversation": {
    "_id": "conv_01HXYZAAA",
    "agentId": "agent_01HXYZ444",
    "projectId": "proj_01HXYZ111",
    "status": "active",
    "metadata": {
      "userId": "end-user-123",
      "channel": "web-widget",
      "locale": "en-US"
    },
    "messageCount": 0,
    "createdAt": "2024-04-01T09:00:00Z",
    "updatedAt": "2024-04-01T09:00:00Z"
  }
}
```

### Send Message

Send a user message to an active conversation and receive an agent response.

**Endpoint**: `POST /api/projects/:projectId/conversations/:conversationId/messages`

**Request**:

```json
{
  "role": "user",
  "content": "I'd like to return a laptop I purchased last week."
}
```

**Response** (`200 OK`):

```json
{
  "message": {
    "_id": "msg_01HXYZ001",
    "conversationId": "conv_01HXYZAAA",
    "role": "assistant",
    "content": "I can help you with that return. To get started, could you please provide your order number? You can find it in your confirmation email or in your account order history.",
    "model": "gpt-4o",
    "usage": {
      "promptTokens": 847,
      "completionTokens": 45,
      "totalTokens": 892
    },
    "toolCalls": [],
    "latencyMs": 1243,
    "createdAt": "2024-04-01T09:00:05Z"
  }
}
```

### Send Message with Streaming

Stream the agent response as server-sent events for real-time display.

**Endpoint**: `POST /api/projects/:projectId/conversations/:conversationId/messages/stream`

**Headers**: `Accept: text/event-stream`

**Request**: Same as Send Message.

**Response** (`200 OK`, `Content-Type: text/event-stream`):

```
event: delta
data: {"delta": "I can help", "messageId": "msg_01HXYZ002"}

event: delta
data: {"delta": " you with", "messageId": "msg_01HXYZ002"}

event: delta
data: {"delta": " that return.", "messageId": "msg_01HXYZ002"}

event: tool_call
data: {"tool": "lookup_order", "input": {"orderId": "ORD-2024-1234"}, "messageId": "msg_01HXYZ002"}

event: tool_result
data: {"tool": "lookup_order", "output": {"status": "delivered", "items": [{"name": "Laptop Pro 15"}]}}

event: done
data: {"messageId": "msg_01HXYZ002", "usage": {"totalTokens": 934}, "latencyMs": 2156}
```

Each `event: delta` carries a partial response chunk. `event: tool_call` and `event: tool_result` appear when the agent executes tools. `event: done` signals completion with final usage statistics.

### List Conversation Messages

**Endpoint**: `GET /api/projects/:projectId/conversations/:conversationId/messages`

**Query Parameters**:

| Parameter | Type   | Description                                       |
| --------- | ------ | ------------------------------------------------- |
| `limit`   | number | Number of messages to return, default 50, max 200 |
| `before`  | string | Message ID cursor for pagination (older messages) |
| `after`   | string | Message ID cursor for pagination (newer messages) |

**Response** (`200 OK`):

```json
{
  "messages": [
    {
      "_id": "msg_01HXYZ001",
      "role": "user",
      "content": "I'd like to return a laptop I purchased last week.",
      "createdAt": "2024-04-01T09:00:03Z"
    },
    {
      "_id": "msg_01HXYZ002",
      "role": "assistant",
      "content": "I can help you with that return...",
      "usage": {
        "promptTokens": 847,
        "completionTokens": 45,
        "totalTokens": 892
      },
      "createdAt": "2024-04-01T09:00:05Z"
    }
  ],
  "total": 2,
  "hasMore": false
}
```

### List Conversations

**Endpoint**: `GET /api/projects/:projectId/conversations`

**Query Parameters**: `page`, `limit`, `agentId`, `status` (active | closed | archived), `startDate`, `endDate`

**Response** (`200 OK`):

```json
{
  "conversations": [
    {
      "_id": "conv_01HXYZAAA",
      "agentId": "agent_01HXYZ444",
      "status": "active",
      "messageCount": 6,
      "metadata": {
        "userId": "end-user-123",
        "channel": "web-widget"
      },
      "createdAt": "2024-04-01T09:00:00Z",
      "lastMessageAt": "2024-04-01T09:08:45Z"
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20
}
```

### Close Conversation

Mark a conversation as closed. Closed conversations are read-only; no new messages can be sent.

**Endpoint**: `PATCH /api/projects/:projectId/conversations/:conversationId`

**Request**:

```json
{
  "status": "closed",
  "resolution": "resolved",
  "closingNote": "Customer issue resolved via return authorization."
}
```

**Response** (`200 OK`): Returns the updated conversation object with `status: "closed"`.

---

## Error Reference

All API errors follow a consistent response format:

```json
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "The requested project was not found.",
    "details": {
      "resourceType": "project",
      "resourceId": "proj_01HXYZ999"
    },
    "requestId": "req_01HXYZZZZ"
  }
}
```

| HTTP Status | Error Code              | Description                                                      |
| ----------- | ----------------------- | ---------------------------------------------------------------- |
| 400         | `VALIDATION_ERROR`      | Request body or parameters failed validation                     |
| 401         | `UNAUTHORIZED`          | Missing or invalid authentication token                          |
| 403         | `FORBIDDEN`             | Authenticated user lacks required permission                     |
| 404         | `RESOURCE_NOT_FOUND`    | Resource does not exist or is not accessible to this tenant      |
| 409         | `CONFLICT`              | Resource already exists or state conflict (e.g., duplicate name) |
| 422         | `UNPROCESSABLE_ENTITY`  | Semantic validation error (e.g., invalid model configuration)    |
| 429         | `RATE_LIMIT_EXCEEDED`   | Request rate limit exceeded                                      |
| 500         | `INTERNAL_SERVER_ERROR` | Unexpected server error                                          |
| 503         | `SERVICE_UNAVAILABLE`   | Downstream dependency unavailable                                |

The `requestId` field is included in all error responses and can be used to correlate errors with platform logs when contacting support.

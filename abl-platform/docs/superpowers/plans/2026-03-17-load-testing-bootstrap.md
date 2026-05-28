# Load Testing Bootstrap + Validation — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking. Run `npx prettier --write <files>` on ALL changed files before finishing your task. lint-staged WILL silently revert your work if files aren't formatted. BEFORE using any existing component/function/type, READ its source file to verify the actual signature. Never guess prop names or parameter types.

**Goal:** Build the benchmark environment bootstrap harness (setup + teardown + fixtures + ConfigMap script) and validate the 8 critical k6 scripts against real services on staging.

**Architecture:** k6 TypeScript scripts using the k6 HTTP API to call ABL Platform services (Studio, Runtime, Search AI) and create benchmark fixtures. All scripts run as k6 `TestRun` CRDs via the k6 Operator on a staging K8s cluster. The bootstrap creates an isolated tenant/project/agent/KB, and teardown removes them.

**Tech Stack:** k6 1.0 (native TypeScript), k6/http, k6/check, Kubernetes k6 Operator, Prometheus Remote Write

**Spec:** `docs/superpowers/specs/2026-03-17-abl-load-testing-design.md`

---

## File Structure

```
benchmarks/
  setup/
    bootstrap.ts              # Orchestrator — runs all setup modules in sequence
    bootstrap-tenant.ts       # Creates benchmark tenant via dev-login, creates project
    bootstrap-agent.ts        # Creates benchmark agent with tools + model chain
    bootstrap-kb.ts           # Creates KB, uploads sample docs, polls until indexed
    bootstrap-indexes.ts      # Verifies OpenSearch indices + Qdrant collections
    seed-conversations.ts     # Pre-seeds conversations for multi-turn benchmarks
    teardown.ts               # Cleans up all fixtures
    helpers.ts                # Shared utilities (poll, retry, log)
  fixtures/
    agent-config.json         # Benchmark agent DSL definition
    kb-config.json            # Knowledge base configuration
    model-chain-mock.json     # Points to mock LLM endpoint
    model-chain-real.json     # Points to real LLM provider
    documents/
      sample-small.md         # ~500 words — lightweight fixture doc
      sample-medium.md        # ~2000 words
      sample-large.md         # ~5000 words
  scripts/
    create-configmaps.sh      # Creates ConfigMaps from all k6 scripts
  config/
    tier-profiles.json        # VU/parallelism/duration per tier (S/M/L/XL)
  k8s/
    namespace.yaml            # abl-benchmarks namespace + RBAC
    secrets.yaml              # benchmark-secrets Secret template
    testrun-setup.yaml        # TestRun CRD for benchmark-setup
    testrun-teardown.yaml     # TestRun CRD for benchmark-teardown
```

**Existing files that may need fixes (Task 8):**

- `benchmarks/services/runtime.ts`
- `benchmarks/services/search-ai.ts`
- `benchmarks/services/bge-m3.ts`
- `benchmarks/services/mongodb.ts`
- `benchmarks/services/opensearch.ts`
- `benchmarks/integration/agent-conversation-e2e.ts`
- `benchmarks/integration/kb-ingestion-e2e.ts`
- `benchmarks/integration/search-query-e2e.ts`
- `benchmarks/lib/config.ts`
- `benchmarks/lib/auth.ts`

---

## Chunk 1: Setup Helpers + Tenant Bootstrap

### Task 1: Shared Setup Helpers

**Files:**

- Create: `benchmarks/setup/helpers.ts`

- [ ] **Step 1: Create helpers.ts with poll, retry, and logging utilities**

```typescript
// benchmarks/setup/helpers.ts
import http from 'k6/http';
import { sleep, check } from 'k6';

/**
 * Poll a URL until a condition is met or timeout.
 * @returns The final response body parsed as JSON, or null on timeout.
 */
export function pollUntil(
  url: string,
  headers: Record<string, string>,
  condition: (body: Record<string, unknown>) => boolean,
  opts: { intervalSec?: number; timeoutSec?: number; label?: string } = {},
): Record<string, unknown> | null {
  const interval = opts.intervalSec ?? 10;
  const timeout = opts.timeoutSec ?? 600;
  const label = opts.label ?? 'poll';
  const maxAttempts = Math.ceil(timeout / interval);

  for (let i = 0; i < maxAttempts; i++) {
    const res = http.get(url, { headers });
    if (res.status === 200) {
      const body = res.json() as Record<string, unknown>;
      if (condition(body)) {
        console.log(`[${label}] Condition met after ${i * interval}s`);
        return body;
      }
    }
    sleep(interval);
  }
  console.error(`[${label}] Timed out after ${timeout}s`);
  return null;
}

/**
 * Make an HTTP request with retry on 5xx errors.
 */
export function httpWithRetry(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  body: string | null,
  headers: Record<string, string>,
  opts: { maxRetries?: number; label?: string } = {},
) {
  const maxRetries = opts.maxRetries ?? 3;
  const label = opts.label ?? url;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: http.Response;
    if (method === 'GET') {
      res = http.get(url, { headers });
    } else if (method === 'POST') {
      res = http.post(url, body, { headers });
    } else {
      res = http.del(url, body, { headers });
    }

    if (res.status < 500) {
      return res;
    }
    console.warn(`[${label}] Attempt ${attempt + 1} got ${res.status}, retrying...`);
    if (attempt < maxRetries) {
      sleep(2 * (attempt + 1));
    }
  }
  // Return last response even on failure
  if (method === 'GET') return http.get(url, { headers });
  if (method === 'POST') return http.post(url, body, { headers });
  return http.del(url, body, { headers });
}

/**
 * Assert a response status and log on failure.
 */
export function assertStatus(
  res: { status: number; body: string | null },
  expectedStatuses: number[],
  label: string,
): boolean {
  const ok = expectedStatuses.includes(res.status);
  if (!ok) {
    console.error(
      `[${label}] Expected ${expectedStatuses.join('|')}, got ${res.status}: ${res.body}`,
    );
  }
  return ok;
}
```

- [ ] **Step 2: Verify types compile**

Run: `cd benchmarks && npx tsc --noEmit`
Expected: No errors for `setup/helpers.ts`

- [ ] **Step 3: Commit**

```bash
npx prettier --write benchmarks/setup/helpers.ts
git add benchmarks/setup/helpers.ts
git commit -m "feat(benchmarks): add shared setup helpers (poll, retry, assertStatus)"
```

---

### Task 2: Bootstrap Tenant + Project

**Files:**

- Create: `benchmarks/setup/bootstrap-tenant.ts`

**Context:** The dev-login endpoint at `POST {studioUrl}/api/auth/dev-login` creates a user + tenant if none exists. It requires `ENABLE_DEV_LOGIN=true` on the Studio server. For programmatic callers (no `Origin` header), it returns `refreshToken` in the body. After login, create a project via `POST {studioUrl}/api/projects`.

- [ ] **Step 1: Create bootstrap-tenant.ts**

```typescript
// benchmarks/setup/bootstrap-tenant.ts
import http from 'k6/http';
import { check } from 'k6';
import { config } from '../lib/config.js';
import { assertStatus, httpWithRetry } from './helpers.js';

export interface TenantSetupResult {
  accessToken: string;
  userId: string;
  tenantId: string;
  projectId: string;
}

const BENCHMARK_EMAIL = 'benchmark@test.local';
const BENCHMARK_NAME = 'Benchmark User';
const PROJECT_NAME = 'benchmark-project';
const PROJECT_DESCRIPTION = 'Auto-created by k6 benchmark bootstrap';

/**
 * Creates (or reuses) a benchmark tenant and project.
 *
 * Flow:
 * 1. POST /api/auth/dev-login → get accessToken + user
 * 2. POST /api/projects → create benchmark project
 *
 * Returns accessToken, userId, tenantId, projectId for use by subsequent modules.
 */
export function bootstrapTenant(): TenantSetupResult {
  const studioUrl = config.studioUrl;

  // --- Step 1: Dev login to get token ---
  const loginRes = httpWithRetry(
    'POST',
    `${studioUrl}/api/auth/dev-login`,
    JSON.stringify({ email: BENCHMARK_EMAIL, name: BENCHMARK_NAME }),
    { 'Content-Type': 'application/json' },
    { label: 'dev-login' },
  );

  const loginOk = check(loginRes, {
    'dev-login returns 200': (r) => r.status === 200,
    'dev-login has accessToken': (r) => {
      const body = r.json() as Record<string, unknown>;
      return typeof body.accessToken === 'string';
    },
  });

  if (!loginOk) {
    throw new Error(`Dev login failed: ${loginRes.status} ${loginRes.body}`);
  }

  const loginBody = loginRes.json() as {
    user: { id: string };
    accessToken: string;
  };

  const accessToken = loginBody.accessToken;
  const userId = loginBody.user.id;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
  };

  // --- Step 2: Check if benchmark project already exists ---
  const listRes = http.get(`${studioUrl}/api/projects`, { headers });
  assertStatus(listRes, [200], 'list-projects');

  // Studio GET /api/projects returns { success: true, projects: [...] }
  // Note: list items do NOT include tenantId — we use config.tenantId as fallback
  const listBody = listRes.json() as {
    success: boolean;
    projects: Array<{ id: string; name: string; slug: string }>;
  };
  const existing = listBody.projects?.find((p) => p.name === PROJECT_NAME);

  if (existing) {
    console.log(`[bootstrap-tenant] Reusing existing project: ${existing.id}`);
    return { accessToken, userId, tenantId: config.tenantId, projectId: existing.id };
  }

  // --- Step 3: Create new benchmark project ---
  const createRes = httpWithRetry(
    'POST',
    `${studioUrl}/api/projects`,
    JSON.stringify({
      name: PROJECT_NAME,
      slug: 'benchmark-project',
      description: PROJECT_DESCRIPTION,
    }),
    headers,
    { label: 'create-project' },
  );

  const createOk = check(createRes, {
    'create project returns 201': (r) => r.status === 201,
  });

  if (!createOk) {
    throw new Error(`Create project failed: ${createRes.status} ${createRes.body}`);
  }

  // Studio POST /api/projects returns { success: true, project: { id, tenantId, ... } }
  const createBody = createRes.json() as {
    success: boolean;
    project: { id: string; tenantId: string; name: string };
  };

  console.log(`[bootstrap-tenant] Created project: ${createBody.project.id}`);

  return {
    accessToken,
    userId,
    tenantId: createBody.project.tenantId,
    projectId: createBody.project.id,
  };
}
```

- [ ] **Step 2: Verify types compile**

Run: `cd benchmarks && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
npx prettier --write benchmarks/setup/bootstrap-tenant.ts
git add benchmarks/setup/bootstrap-tenant.ts
git commit -m "feat(benchmarks): add bootstrap-tenant — dev-login + project creation"
```

---

### Task 3: Bootstrap Agent

**Files:**

- Create: `benchmarks/setup/bootstrap-agent.ts`
- Create: `benchmarks/fixtures/agent-config.json`

**Context:** Agents are created via the Runtime API at `POST /api/projects/:projectId/agents`. The agent config JSON defines the agent DSL with tools.

- [ ] **Step 1: Create agent-config.json fixture**

```json
{
  "name": "benchmark_agent",
  "description": "Benchmark agent for load testing",
  "instructions": "You are a helpful assistant for benchmark testing. Respond concisely.",
  "model": "gpt-4o-mini",
  "tools": [
    {
      "name": "lookup_account",
      "description": "Look up customer account status by customer ID",
      "parameters": {
        "type": "object",
        "properties": {
          "customer_id": { "type": "string", "description": "The customer ID" }
        },
        "required": ["customer_id"]
      }
    },
    {
      "name": "get_order_history",
      "description": "Retrieve order history for a customer",
      "parameters": {
        "type": "object",
        "properties": {
          "customer_id": { "type": "string", "description": "The customer ID" },
          "limit": { "type": "number", "description": "Max orders to return" }
        },
        "required": ["customer_id"]
      }
    },
    {
      "name": "verify_shipping_address",
      "description": "Verify and validate a shipping address",
      "parameters": {
        "type": "object",
        "properties": {
          "customer_id": { "type": "string", "description": "The customer ID" }
        },
        "required": ["customer_id"]
      }
    }
  ]
}
```

- [ ] **Step 2: Create bootstrap-agent.ts**

```typescript
// benchmarks/setup/bootstrap-agent.ts
import http from 'k6/http';
import { check } from 'k6';
import { config } from '../lib/config.js';
import { assertStatus, httpWithRetry } from './helpers.js';

// Agent config is passed as a JSON string via env var since k6 cannot
// read local files at runtime in distributed mode. The orchestrator
// inlines it before creating the ConfigMap.
const AGENT_CONFIG_JSON = __ENV.AGENT_CONFIG || '{}';

export interface AgentSetupResult {
  agentId: string;
  agentName: string;
  agentPath: string;
}

/**
 * Creates (or reuses) a benchmark agent in the given project.
 */
export function bootstrapAgent(accessToken: string, projectId: string): AgentSetupResult {
  const runtimeUrl = config.runtimeUrl;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
  };

  const agentConfig = JSON.parse(AGENT_CONFIG_JSON) as {
    name: string;
    description: string;
    instructions: string;
    model: string;
    tools: unknown[];
  };

  const agentName = agentConfig.name || 'benchmark_agent';

  // --- Check if agent already exists ---
  const listRes = http.get(`${runtimeUrl}/api/projects/${projectId}/agents`, { headers });
  assertStatus(listRes, [200], 'list-agents');

  const listBody = listRes.json() as {
    success: boolean;
    agents: Array<{ id: string; name: string; agentPath: string }>;
  };

  const existing = listBody.agents?.find((a) => a.name === agentName);
  if (existing) {
    console.log(`[bootstrap-agent] Reusing existing agent: ${existing.id}`);
    return {
      agentId: existing.id,
      agentName: existing.name,
      agentPath: existing.agentPath,
    };
  }

  // --- Create new agent ---
  const createRes = httpWithRetry(
    'POST',
    `${runtimeUrl}/api/projects/${projectId}/agents`,
    JSON.stringify(agentConfig),
    headers,
    { label: 'create-agent' },
  );

  const createOk = check(createRes, {
    'create agent returns 200|201': (r) => r.status === 200 || r.status === 201,
  });

  if (!createOk) {
    throw new Error(`Create agent failed: ${createRes.status} ${createRes.body}`);
  }

  const agent = createRes.json() as {
    success?: boolean;
    agent?: { id: string; name: string; agentPath: string };
    id?: string;
    name?: string;
    agentPath?: string;
  };

  const result = agent.agent || agent;
  console.log(`[bootstrap-agent] Created agent: ${(result as any).id}`);

  return {
    agentId: (result as any).id,
    agentName: (result as any).name || agentName,
    agentPath: (result as any).agentPath || `default/${agentName}`,
  };
}
```

- [ ] **Step 3: Verify types compile**

Run: `cd benchmarks && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
npx prettier --write benchmarks/setup/bootstrap-agent.ts benchmarks/fixtures/agent-config.json
git add benchmarks/setup/bootstrap-agent.ts benchmarks/fixtures/agent-config.json
git commit -m "feat(benchmarks): add bootstrap-agent + agent-config fixture"
```

---

## Chunk 2: KB Bootstrap + Indexes + Seed Conversations

### Task 4: Bootstrap Knowledge Base

**Files:**

- Create: `benchmarks/setup/bootstrap-kb.ts`
- Create: `benchmarks/fixtures/kb-config.json`
- Create: `benchmarks/fixtures/documents/sample-small.md`
- Create: `benchmarks/fixtures/documents/sample-medium.md`
- Create: `benchmarks/fixtures/documents/sample-large.md`

**Context:** KB creation flow: create knowledge base via `POST {searchAiUrl}/api/knowledge-bases` (which auto-creates the linked SearchIndex, default pipeline, and slug). Then upload documents via `POST {searchAiUrl}/api/indexes/:indexId/sources/:sourceId/documents` (multipart/form-data), and poll `GET /api/jobs/:jobId` until ingestion completes. k6 supports `http.file()` for multipart uploads.

**Important:** The KB API returns `{ knowledgeBase: { _id, searchIndexId, ... } }`. The `searchIndexId` is needed for document uploads. A source must be created first via `POST /api/indexes/:indexId/sources` before uploading documents.

- [ ] **Step 1: Create fixture documents**

`benchmarks/fixtures/documents/sample-small.md` (~500 words):

```markdown
# Customer Support Knowledge Base - Returns Policy

## Overview

Our returns policy allows customers to return most items within 30 days of purchase for a full refund. Items must be in their original condition with all tags attached.

## Eligible Items

Most items purchased from our store are eligible for return, including clothing, electronics, home goods, and accessories. Custom-made items, perishable goods, and digital downloads are not eligible for return.

## Return Process

1. Log into your account and navigate to Order History
2. Select the order containing the item you wish to return
3. Click "Initiate Return" and select a reason
4. Print the prepaid shipping label
5. Pack the item securely and attach the label
6. Drop off the package at any authorized shipping location

## Refund Timeline

Refunds are typically processed within 5-7 business days after we receive and inspect the returned item. The refund will be issued to the original payment method.

## Exchanges

If you would like to exchange an item for a different size or color, please initiate a return and place a new order. This ensures the fastest processing time.

## International Returns

International customers are responsible for return shipping costs. Please contact our support team for a return authorization before shipping.

## Damaged or Defective Items

If you received a damaged or defective item, please contact us within 48 hours of delivery. We will arrange a free return pickup and send a replacement immediately.
```

`benchmarks/fixtures/documents/sample-medium.md` (~2000 words):

```markdown
# ABL Platform Technical Architecture Guide

## System Overview

The ABL Platform is a comprehensive AI agent development and deployment system that enables organizations to build, test, and deploy conversational AI agents at scale. The platform consists of several interconnected services that work together to provide a seamless development experience.

## Core Services

### Runtime Service

The Runtime service is the heart of the platform, responsible for executing agent conversations in real-time. It handles WebSocket connections from clients, manages conversation state, and orchestrates the interaction between agents and LLM providers. The service supports multiple concurrent conversations and implements automatic scaling based on connection count and CPU utilization.

Key capabilities include streaming responses via Server-Sent Events, tool calling with automatic function execution, multi-agent orchestration with supervisor-delegate patterns, and session management with Redis-backed state persistence.

### Search AI Service

The Search AI service manages the knowledge base infrastructure, handling document ingestion, chunking, embedding generation, and index management. It integrates with multiple vector stores including OpenSearch and Qdrant, and supports various document formats through the Docling processing pipeline.

The ingestion pipeline processes documents through several stages: upload and validation, text extraction via Docling, intelligent chunking with overlap, embedding generation using BGE-M3, vector indexing in OpenSearch and Qdrant, and knowledge graph creation in Neo4j.

### Studio Application

Studio is the web-based development environment where users design, configure, and test their AI agents. Built with Next.js, it provides a visual agent builder, conversation testing interface, knowledge base management, analytics dashboards, and team collaboration features.

## Data Architecture

### MongoDB

The primary database for all persistent data including user accounts, tenant configurations, project settings, agent definitions, conversation history, and audit logs. Data is organized with strict tenant isolation using compound indexes on tenantId.

### Redis

Used for ephemeral state including session data, conversation context, distributed locks, BullMQ job queues, and caching. The platform requires noeviction policy for BullMQ queue integrity.

### ClickHouse

Handles all analytics and observability data including trace events, LLM usage metrics, billing events, and performance measurements. Data is partitioned by time and uses aggressive compression with ZSTD codecs.

### OpenSearch

Powers the full-text and vector search capabilities. Stores document chunks with their embeddings and supports hybrid search combining BM25 text matching with k-NN vector similarity.

### Qdrant

Provides dedicated vector search for high-performance similarity matching. Used alongside OpenSearch for scenarios requiring pure vector search without text matching overhead.

### Neo4j

Stores knowledge graphs representing relationships between entities extracted from documents. Supports graph-based reasoning and multi-hop traversal queries.

## Security Model

The platform implements a multi-layer security model with tenant isolation at every level. Authentication uses JWT tokens with short-lived access tokens and long-lived refresh tokens. Authorization is permission-based with role inheritance.

All data at rest is encrypted using AES-256. Data in transit uses TLS 1.3. The platform supports customer-managed encryption keys through integration with AWS KMS and Azure Key Vault.

## Deployment Architecture

The platform is designed for Kubernetes deployment with horizontal pod autoscaling, pod disruption budgets for high availability, and node affinity rules for optimal resource placement. Reference architectures are provided for four tiers: Starter, Mid-Market, Enterprise, and Hyperscale.
```

`benchmarks/fixtures/documents/sample-large.md` (~5000 words — truncated here for plan brevity, actual file will contain ~5000 words of API reference documentation):

```markdown
# ABL Platform API Reference

## Authentication

### POST /api/auth/login

Authenticates a user and returns access and refresh tokens.

[... ~5000 words of realistic API documentation ...]
```

- [ ] **Step 2: Create kb-config.json**

```json
{
  "name": "benchmark-kb",
  "description": "Knowledge base for benchmark load testing"
}
```

_Note: The KB API (`POST /api/knowledge-bases`) only requires `projectId`, `name`, and optional `description`. It auto-creates the SearchIndex with system defaults (embedding model, vector store config, search defaults, slug, default pipeline). No need to specify these in the fixture._

- [ ] **Step 3: Create bootstrap-kb.ts**

```typescript
// benchmarks/setup/bootstrap-kb.ts
import http from 'k6/http';
import { check, sleep } from 'k6';
import { config } from '../lib/config.js';
import { assertStatus, httpWithRetry, pollUntil } from './helpers.js';

// Sample document content — inlined because k6 distributed runners
// cannot read local files. For large corpora, use a PVC or HTTP fetch.
// NOTE: The spec calls for ~100 docs. This bootstrap uses 3 representative
// docs for fast setup. Expand the array for more realistic KB sizing.
const SAMPLE_DOCS = [
  {
    filename: 'sample-small.md',
    content: __ENV.DOC_SMALL || 'Sample small document for benchmark testing.',
  },
  {
    filename: 'sample-medium.md',
    content: __ENV.DOC_MEDIUM || 'Sample medium document for benchmark testing.',
  },
  {
    filename: 'sample-large.md',
    content: __ENV.DOC_LARGE || 'Sample large document for benchmark testing.',
  },
];

const KB_NAME = 'benchmark-kb';
const KB_DESCRIPTION = 'Knowledge base for benchmark load testing';

export interface KBSetupResult {
  kbId: string;
  indexId: string;
  sourceId: string;
  documentCount: number;
}

/**
 * Creates a knowledge base (which auto-creates SearchIndex + default pipeline),
 * creates a source, uploads sample documents, and waits for ingestion.
 *
 * Uses POST /api/knowledge-bases (facade over SearchIndex).
 * Polling: 10s interval, 10min timeout.
 * Success: >90% of documents have status "indexed".
 */
export function bootstrapKB(accessToken: string, projectId: string): KBSetupResult {
  const searchAiUrl = config.searchAiUrl;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
  };

  // --- Step 1: Check if KB already exists ---
  const listRes = http.get(`${searchAiUrl}/api/knowledge-bases?projectId=${projectId}`, {
    headers,
  });
  assertStatus(listRes, [200], 'list-kbs');

  const listBody = listRes.json() as {
    knowledgeBases: Array<{
      _id: string;
      name: string;
      searchIndexId: string;
      status: string;
    }>;
  };
  const existing = listBody.knowledgeBases?.find((kb) => kb.name === KB_NAME);

  if (existing) {
    console.log(`[bootstrap-kb] Reusing existing KB: ${existing._id}`);
    return {
      kbId: existing._id,
      indexId: existing.searchIndexId,
      sourceId: 'default',
      documentCount: 0,
    };
  }

  // --- Step 2: Create knowledge base (auto-creates SearchIndex + pipeline) ---
  const createRes = httpWithRetry(
    'POST',
    `${searchAiUrl}/api/knowledge-bases`,
    JSON.stringify({
      projectId,
      name: KB_NAME,
      description: KB_DESCRIPTION,
    }),
    headers,
    { label: 'create-kb' },
  );

  const createOk = check(createRes, {
    'create KB returns 201': (r) => r.status === 201,
  });

  if (!createOk) {
    throw new Error(`Create KB failed: ${createRes.status} ${createRes.body}`);
  }

  // Response: { knowledgeBase: { _id, searchIndexId, ... } }
  const createBody = createRes.json() as {
    knowledgeBase: { _id: string; searchIndexId: string };
  };
  const kbId = createBody.knowledgeBase._id;
  const indexId = createBody.knowledgeBase.searchIndexId;
  console.log(`[bootstrap-kb] Created KB: ${kbId}, Index: ${indexId}`);

  // Wait for index to initialize
  sleep(5);

  // --- Step 3: Create a source for document uploads ---
  const sourceRes = httpWithRetry(
    'POST',
    `${searchAiUrl}/api/indexes/${indexId}/sources`,
    JSON.stringify({
      name: 'benchmark-upload',
      type: 'upload',
      description: 'Source for benchmark document uploads',
    }),
    headers,
    { label: 'create-source' },
  );

  let sourceId = 'default';
  if (sourceRes.status === 201 || sourceRes.status === 200) {
    const sourceBody = sourceRes.json() as {
      source?: { _id: string };
      _id?: string;
    };
    sourceId = sourceBody.source?._id || sourceBody._id || sourceId;
    console.log(`[bootstrap-kb] Created source: ${sourceId}`);
  } else {
    console.warn(`[bootstrap-kb] Source creation returned ${sourceRes.status}, trying 'default'`);
  }

  // --- Step 4: Upload sample documents ---
  let uploadedCount = 0;

  for (const doc of SAMPLE_DOCS) {
    const uploadHeaders = {
      Authorization: `Bearer ${accessToken}`,
    };

    // k6 multipart form data
    const formData = {
      file: http.file(doc.content, doc.filename, 'text/markdown'),
    };

    const uploadRes = http.post(
      `${searchAiUrl}/api/indexes/${indexId}/sources/${sourceId}/documents`,
      formData,
      { headers: uploadHeaders, timeout: '60s' },
    );

    if (uploadRes.status === 201 || uploadRes.status === 200) {
      uploadedCount++;
      console.log(`[bootstrap-kb] Uploaded: ${doc.filename}`);
    } else {
      console.warn(
        `[bootstrap-kb] Upload failed for ${doc.filename}: ${uploadRes.status} ${uploadRes.body}`,
      );
    }
  }

  console.log(`[bootstrap-kb] Uploaded ${uploadedCount}/${SAMPLE_DOCS.length} documents`);

  if (uploadedCount === 0) {
    throw new Error('No documents uploaded successfully');
  }

  // --- Step 5: Trigger ingestion job ---
  const jobRes = httpWithRetry(
    'POST',
    `${searchAiUrl}/api/jobs`,
    JSON.stringify({ indexId }),
    headers,
    { label: 'create-job' },
  );

  if (jobRes.status === 201 || jobRes.status === 200) {
    const jobBody = jobRes.json() as { job: { id: string } };
    const jobId = jobBody.job.id;
    console.log(`[bootstrap-kb] Ingestion job created: ${jobId}`);

    // --- Step 6: Poll for ingestion completion (10s interval, 10min timeout) ---
    const result = pollUntil(
      `${searchAiUrl}/api/jobs/${jobId}`,
      headers,
      (body) => {
        const job = (body as any).job;
        const status = job?.status;
        return status === 'completed' || status === 'failed';
      },
      { intervalSec: 10, timeoutSec: 600, label: 'ingestion-poll' },
    );

    if (result) {
      const job = (result as any).job;
      if (job.status === 'failed') {
        console.error(`[bootstrap-kb] Ingestion failed: ${job.error}`);
      } else {
        console.log(
          `[bootstrap-kb] Ingestion completed: ${job.documentsProcessed}/${job.documentsTotal} docs`,
        );
      }
    }
  } else {
    console.warn(`[bootstrap-kb] Could not create ingestion job: ${jobRes.status}`);
  }

  return { kbId, indexId, sourceId, documentCount: uploadedCount };
}
```

- [ ] **Step 4: Verify types compile**

Run: `cd benchmarks && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
npx prettier --write benchmarks/setup/bootstrap-kb.ts benchmarks/fixtures/kb-config.json benchmarks/fixtures/documents/*.md
git add benchmarks/setup/bootstrap-kb.ts benchmarks/fixtures/
git commit -m "feat(benchmarks): add bootstrap-kb + fixture documents + kb-config"
```

---

### Task 5: Bootstrap Indexes Verification

**Files:**

- Create: `benchmarks/setup/bootstrap-indexes.ts`

- [ ] **Step 1: Create bootstrap-indexes.ts**

```typescript
// benchmarks/setup/bootstrap-indexes.ts
import http from 'k6/http';
import { check } from 'k6';
import { config } from '../lib/config.js';
import { assertStatus } from './helpers.js';

export interface IndexVerificationResult {
  opensearchOk: boolean;
  qdrantOk: boolean;
}

/**
 * Verifies that OpenSearch indices and Qdrant collections exist
 * after KB bootstrap. Does not create them — they should have been
 * created by the Search AI service during ingestion.
 */
export function verifyIndexes(accessToken: string, indexId: string): IndexVerificationResult {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
  };

  // --- Verify OpenSearch index exists ---
  let opensearchOk = false;
  const osUrl = config.opensearchUrl;
  const osRes = http.get(`${osUrl}/_cat/indices?format=json`, {
    headers: { 'Content-Type': 'application/json' },
  });

  if (osRes.status === 200) {
    const indices = osRes.json() as Array<{ index: string }>;
    opensearchOk = indices.some((idx) => idx.index.includes(indexId));
    if (opensearchOk) {
      console.log(`[bootstrap-indexes] OpenSearch index found for ${indexId}`);
    } else {
      console.warn(
        `[bootstrap-indexes] OpenSearch index NOT found for ${indexId}. ` +
          `Available: ${indices.map((i) => i.index).join(', ')}`,
      );
    }
  } else {
    console.warn(`[bootstrap-indexes] Could not query OpenSearch: ${osRes.status}`);
  }

  // --- Verify Qdrant collection exists ---
  let qdrantOk = false;
  const qdrantUrl = config.qdrantUrl;
  const qdrantRes = http.get(`${qdrantUrl}/collections`, {
    headers: { 'Content-Type': 'application/json' },
  });

  if (qdrantRes.status === 200) {
    const body = qdrantRes.json() as {
      result: { collections: Array<{ name: string }> };
    };
    const collections = body.result?.collections || [];
    qdrantOk = collections.some((c) => c.name.includes(indexId));
    if (qdrantOk) {
      console.log(`[bootstrap-indexes] Qdrant collection found for ${indexId}`);
    } else {
      console.warn(
        `[bootstrap-indexes] Qdrant collection NOT found for ${indexId}. ` +
          `Available: ${collections.map((c) => c.name).join(', ')}`,
      );
    }
  } else {
    console.warn(`[bootstrap-indexes] Could not query Qdrant: ${qdrantRes.status}`);
  }

  return { opensearchOk, qdrantOk };
}
```

- [ ] **Step 2: Verify types compile**

Run: `cd benchmarks && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
npx prettier --write benchmarks/setup/bootstrap-indexes.ts
git add benchmarks/setup/bootstrap-indexes.ts
git commit -m "feat(benchmarks): add bootstrap-indexes — verifies OpenSearch + Qdrant"
```

---

### Task 6: Seed Conversations

**Files:**

- Create: `benchmarks/setup/seed-conversations.ts`

- [ ] **Step 1: Create seed-conversations.ts**

```typescript
// benchmarks/setup/seed-conversations.ts
import http from 'k6/http';
import { check, sleep } from 'k6';
import { config } from '../lib/config.js';
import { assertStatus, httpWithRetry } from './helpers.js';

const SEED_CONVERSATION_COUNT = 5;
const MESSAGES_PER_CONVERSATION = 3;

export interface SeedResult {
  conversationCount: number;
  sessionIds: string[];
}

/**
 * Pre-seeds conversations for benchmarks that need existing session state.
 * Creates short conversations via the Runtime chat API.
 */
export function seedConversations(accessToken: string, projectId: string): SeedResult {
  const runtimeUrl = config.runtimeUrl;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    Accept: 'text/event-stream',
  };

  const sessionIds: string[] = [];

  for (let c = 0; c < SEED_CONVERSATION_COUNT; c++) {
    const messages = [];
    for (let m = 0; m < MESSAGES_PER_CONVERSATION; m++) {
      messages.push({
        role: 'user',
        content: `Seed conversation ${c + 1}, message ${m + 1}: What is ${m + 1} + ${c + 1}?`,
      });
    }

    const res = httpWithRetry(
      'POST',
      `${runtimeUrl}/api/v1/chat`,
      JSON.stringify({ projectId, messages: [messages[0]] }),
      headers,
      { label: `seed-conversation-${c}` },
    );

    if (res.status === 200) {
      // Try to extract session ID from SSE response
      const body = res.body as string;
      const sessionMatch = body.match(/"sessionId"\s*:\s*"([^"]+)"/);
      if (sessionMatch) {
        sessionIds.push(sessionMatch[1]);
      }
      console.log(`[seed-conversations] Created conversation ${c + 1}`);
    } else {
      console.warn(`[seed-conversations] Failed conversation ${c + 1}: ${res.status}`);
    }

    sleep(1);
  }

  console.log(
    `[seed-conversations] Seeded ${sessionIds.length}/${SEED_CONVERSATION_COUNT} conversations`,
  );

  return {
    conversationCount: sessionIds.length,
    sessionIds,
  };
}
```

- [ ] **Step 2: Verify types compile**

Run: `cd benchmarks && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
npx prettier --write benchmarks/setup/seed-conversations.ts
git add benchmarks/setup/seed-conversations.ts
git commit -m "feat(benchmarks): add seed-conversations — pre-seeds chat sessions"
```

---

## Chunk 3: Orchestrator, Teardown, Fixtures, Scripts

### Task 7: Bootstrap Orchestrator + Teardown + Model Chain Fixtures

**Files:**

- Create: `benchmarks/setup/bootstrap.ts`
- Create: `benchmarks/setup/teardown.ts`
- Create: `benchmarks/fixtures/model-chain-mock.json`
- Create: `benchmarks/fixtures/model-chain-real.json`

- [ ] **Step 1: Create model chain fixtures**

`benchmarks/fixtures/model-chain-mock.json`:

```json
{
  "provider": "mock",
  "endpoint": "http://mock-llm.abl-benchmarks.svc.cluster.local:8080/v1/chat/completions",
  "model": "mock-gpt-4o-mini",
  "description": "Mock LLM for platform benchmarks — fixed 200ms latency, deterministic responses"
}
```

`benchmarks/fixtures/model-chain-real.json`:

```json
{
  "provider": "openai",
  "model": "gpt-4o-mini",
  "description": "Real LLM for integration benchmarks and customer reports"
}
```

- [ ] **Step 2: Create bootstrap.ts orchestrator**

```typescript
// benchmarks/setup/bootstrap.ts
/**
 * Benchmark Environment Bootstrap Orchestrator
 *
 * Runs all setup modules in sequence to create a complete benchmark environment.
 * Designed to run as a k6 TestRun with --iterations 1 --vus 1.
 *
 * Run:
 *   k6 run benchmarks/setup/bootstrap.ts \
 *     -e STUDIO_URL=http://studio:5173 \
 *     -e RUNTIME_URL=http://runtime:3112 \
 *     -e SEARCH_AI_URL=http://search-ai:3113 \
 *     --iterations 1 --vus 1
 */
import { check } from 'k6';
import { bootstrapTenant } from './bootstrap-tenant.js';
import { bootstrapAgent } from './bootstrap-agent.js';
import { bootstrapKB } from './bootstrap-kb.js';
import { verifyIndexes } from './bootstrap-indexes.js';
import { seedConversations } from './seed-conversations.js';

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1.0'],
  },
};

export default function (): void {
  console.log('=== Benchmark Bootstrap Starting ===');

  // Step 1: Create tenant + project
  console.log('\n--- Step 1: Bootstrap Tenant ---');
  const tenant = bootstrapTenant();
  check(tenant, {
    'tenant has accessToken': (t) => !!t.accessToken,
    'tenant has projectId': (t) => !!t.projectId,
  });
  console.log(`  Tenant: ${tenant.tenantId}`);
  console.log(`  Project: ${tenant.projectId}`);

  // Step 2: Create agent
  console.log('\n--- Step 2: Bootstrap Agent ---');
  const agent = bootstrapAgent(tenant.accessToken, tenant.projectId);
  check(agent, {
    'agent has agentId': (a) => !!a.agentId,
  });
  console.log(`  Agent: ${agent.agentId} (${agent.agentPath})`);

  // Step 3: Create KB + upload documents
  console.log('\n--- Step 3: Bootstrap Knowledge Base ---');
  const kb = bootstrapKB(tenant.accessToken, tenant.projectId);
  check(kb, {
    'kb has indexId': (k) => !!k.indexId,
    'kb has kbId': (k) => !!k.kbId,
  });
  console.log(`  KB: ${kb.kbId}, Index: ${kb.indexId} (${kb.documentCount} docs uploaded)`);

  // Step 4: Verify indexes
  console.log('\n--- Step 4: Verify Indexes ---');
  const indexes = verifyIndexes(tenant.accessToken, kb.indexId);
  console.log(`  OpenSearch: ${indexes.opensearchOk ? 'OK' : 'NOT FOUND'}`);
  console.log(`  Qdrant: ${indexes.qdrantOk ? 'OK' : 'NOT FOUND'}`);

  // Step 5: Seed conversations
  console.log('\n--- Step 5: Seed Conversations ---');
  const seed = seedConversations(tenant.accessToken, tenant.projectId);
  console.log(`  Seeded: ${seed.conversationCount} conversations`);

  console.log('\n=== Benchmark Bootstrap Complete ===');
  console.log(`  Token: ${tenant.accessToken.substring(0, 20)}...`);
  console.log(`  Project ID: ${tenant.projectId}`);
  console.log(`  Agent Path: ${agent.agentPath}`);
  console.log(`  Index ID: ${kb.indexId}`);
}
```

- [ ] **Step 3: Create teardown.ts**

```typescript
// benchmarks/setup/teardown.ts
/**
 * Benchmark Environment Teardown
 *
 * Cleans up all fixtures created by bootstrap.
 * Run after benchmarks complete to leave the cluster clean.
 *
 * Run:
 *   k6 run benchmarks/setup/teardown.ts \
 *     -e STUDIO_URL=http://studio:5173 \
 *     -e RUNTIME_URL=http://runtime:3112 \
 *     -e SEARCH_AI_URL=http://search-ai:3113 \
 *     --iterations 1 --vus 1
 */
import http from 'k6/http';
import { config } from '../lib/config.js';
import { assertStatus } from './helpers.js';

export const options = {
  vus: 1,
  iterations: 1,
};

export default function (): void {
  console.log('=== Benchmark Teardown Starting ===');

  const studioUrl = config.studioUrl;
  const searchAiUrl = config.searchAiUrl;

  // Get auth token
  const loginRes = http.post(
    `${studioUrl}/api/auth/dev-login`,
    JSON.stringify({ email: 'benchmark@test.local' }),
    { headers: { 'Content-Type': 'application/json' } },
  );

  if (loginRes.status !== 200) {
    console.error(`[teardown] Login failed: ${loginRes.status}`);
    return;
  }

  const { accessToken } = loginRes.json() as { accessToken: string };
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
  };

  // --- Delete search indexes (cascades to documents, chunks, vectors) ---
  console.log('[teardown] Cleaning up search indexes...');
  const indexRes = http.get(`${searchAiUrl}/api/indexes?projectId=${config.projectId}`, {
    headers,
  });
  if (indexRes.status === 200) {
    const body = indexRes.json() as { indexes: Array<{ _id: string; name: string }> };
    for (const idx of body.indexes || []) {
      if (idx.name.includes('benchmark')) {
        const delRes = http.del(`${searchAiUrl}/api/indexes/${idx._id}`, null, {
          headers,
        });
        console.log(`  Deleted index ${idx._id}: ${delRes.status}`);
      }
    }
  }

  // --- Delete benchmark project ---
  console.log('[teardown] Cleaning up project...');
  const projRes = http.get(`${studioUrl}/api/projects`, { headers });
  if (projRes.status === 200) {
    const body = projRes.json() as {
      projects: Array<{ id: string; name: string }>;
    };
    for (const proj of body.projects || []) {
      if (proj.name === 'benchmark-project') {
        const delRes = http.del(`${studioUrl}/api/projects/${proj.id}`, null, {
          headers,
        });
        console.log(`  Deleted project ${proj.id}: ${delRes.status}`);
      }
    }
  }

  console.log('=== Benchmark Teardown Complete ===');
}
```

- [ ] **Step 4: Verify types compile**

Run: `cd benchmarks && npx tsc --noEmit`
Expected: No errors for all setup files

- [ ] **Step 5: Commit**

```bash
npx prettier --write benchmarks/setup/bootstrap.ts benchmarks/setup/teardown.ts benchmarks/fixtures/model-chain-*.json
git add benchmarks/setup/bootstrap.ts benchmarks/setup/teardown.ts benchmarks/fixtures/model-chain-*.json
git commit -m "feat(benchmarks): add bootstrap orchestrator + teardown + model chain fixtures"
```

---

### Task 8: ConfigMap Creation Script

**Files:**

- Create: `benchmarks/scripts/create-configmaps.sh`

- [ ] **Step 1: Create create-configmaps.sh**

```bash
#!/bin/bash
# Creates ConfigMaps from all k6 benchmark scripts for k6 Operator TestRuns.
# Usage: ./benchmarks/scripts/create-configmaps.sh [namespace]

set -euo pipefail

NAMESPACE=${1:-abl-benchmarks}
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "Creating ConfigMaps in namespace: ${NAMESPACE}"
echo "Script directory: ${SCRIPT_DIR}"

# Ensure namespace exists
kubectl get namespace "$NAMESPACE" >/dev/null 2>&1 || {
  echo "Creating namespace ${NAMESPACE}..."
  kubectl create namespace "$NAMESPACE"
}

# --- Per-service benchmark scripts ---
echo ""
echo "=== Per-service benchmarks ==="
for script in "${SCRIPT_DIR}"/services/*.ts; do
  [ -f "$script" ] || continue
  name="$(basename "$script" .ts)-benchmark-script"
  echo "  Creating: ${name}"
  kubectl create configmap "$name" \
    --from-file="$(basename "$script")=$script" \
    -n "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
done

# --- Integration benchmark scripts ---
echo ""
echo "=== Integration benchmarks ==="
for script in "${SCRIPT_DIR}"/integration/*.ts; do
  [ -f "$script" ] || continue
  name="$(basename "$script" .ts)-script"
  echo "  Creating: ${name}"
  kubectl create configmap "$name" \
    --from-file="$(basename "$script")=$script" \
    -n "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
done

# --- System-wide benchmark scripts ---
echo ""
echo "=== System-wide benchmarks ==="
for script in "${SCRIPT_DIR}"/system/*.ts; do
  [ -f "$script" ] || continue
  name="$(basename "$script" .ts)-script"
  echo "  Creating: ${name}"
  kubectl create configmap "$name" \
    --from-file="$(basename "$script")=$script" \
    -n "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
done

# --- Shared libraries (needed by all scripts) ---
echo ""
echo "=== Shared libraries ==="
kubectl create configmap benchmark-lib \
  --from-file=config.js="${SCRIPT_DIR}/lib/config.ts" \
  --from-file=auth.js="${SCRIPT_DIR}/lib/auth.ts" \
  --from-file=metrics.js="${SCRIPT_DIR}/lib/metrics.ts" \
  -n "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
echo "  Created: benchmark-lib"

# --- Setup/teardown scripts ---
echo ""
echo "=== Setup/Teardown ==="
kubectl create configmap benchmark-setup-script \
  --from-file=bootstrap.ts="${SCRIPT_DIR}/setup/bootstrap.ts" \
  -n "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
echo "  Created: benchmark-setup-script"

kubectl create configmap benchmark-teardown-script \
  --from-file=teardown.ts="${SCRIPT_DIR}/setup/teardown.ts" \
  -n "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
echo "  Created: benchmark-teardown-script"

echo ""
echo "=== Done ==="
echo "All ConfigMaps created in namespace ${NAMESPACE}"
```

- [ ] **Step 2: Make executable**

Run: `chmod +x benchmarks/scripts/create-configmaps.sh`

- [ ] **Step 3: Commit**

```bash
npx prettier --write benchmarks/scripts/create-configmaps.sh 2>/dev/null || true
git add benchmarks/scripts/create-configmaps.sh
git commit -m "feat(benchmarks): add ConfigMap creation script for k6 Operator"
```

---

### Task 9: K8s Manifests (Namespace, Secrets, TestRun CRDs)

**Files:**

- Create: `benchmarks/k8s/namespace.yaml`
- Create: `benchmarks/k8s/secrets.yaml`
- Create: `benchmarks/k8s/testrun-setup.yaml`
- Create: `benchmarks/k8s/testrun-teardown.yaml`

- [ ] **Step 1: Create namespace.yaml**

```yaml
# benchmarks/k8s/namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: abl-benchmarks
  labels:
    app.kubernetes.io/part-of: abl-platform
    purpose: benchmarks
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: benchmark-quota
  namespace: abl-benchmarks
spec:
  hard:
    requests.cpu: '32'
    requests.memory: 64Gi
    limits.cpu: '64'
    limits.memory: 128Gi
    pods: '50'
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: benchmark-runner
  namespace: abl-benchmarks
  # For AWS: add annotation eks.amazonaws.com/role-arn: arn:aws:iam::role/benchmark-runner
  # For Azure: add annotation azure.workload.identity/client-id: <client-id>
```

- [ ] **Step 2: Create secrets.yaml**

```yaml
# benchmarks/k8s/secrets.yaml
# Template — actual values should be provisioned via External Secrets Operator
# or manually created before running benchmarks.
apiVersion: v1
kind: Secret
metadata:
  name: benchmark-secrets
  namespace: abl-benchmarks
type: Opaque
stringData:
  ADMIN_TOKEN: 'REPLACE_ME'
  LLM_API_KEY: 'REPLACE_ME'
  GRAFANA_API_KEY: 'REPLACE_ME'
```

- [ ] **Step 3: Create testrun-setup.yaml**

```yaml
# benchmarks/k8s/testrun-setup.yaml
apiVersion: k6.io/v1alpha1
kind: TestRun
metadata:
  name: benchmark-setup
  namespace: abl-benchmarks
  labels:
    benchmark-type: setup
spec:
  parallelism: 1
  script:
    configMap:
      name: benchmark-setup-script
      file: bootstrap.ts
  arguments: >-
    --env STUDIO_URL=http://studio.abl-platform.svc.cluster.local:5173
    --env RUNTIME_URL=http://runtime.abl-platform.svc.cluster.local:3112
    --env SEARCH_AI_URL=http://search-ai.abl-platform.svc.cluster.local:3113
    --env OPENSEARCH_URL=https://opensearch.abl-platform.svc.cluster.local:9200
    --env QDRANT_URL=http://qdrant.abl-platform.svc.cluster.local:6333
    --iterations 1
    --vus 1
  runner:
    resources:
      requests:
        cpu: 250m
        memory: 256Mi
      limits:
        cpu: 500m
        memory: 512Mi
```

- [ ] **Step 4: Create testrun-teardown.yaml**

```yaml
# benchmarks/k8s/testrun-teardown.yaml
apiVersion: k6.io/v1alpha1
kind: TestRun
metadata:
  name: benchmark-teardown
  namespace: abl-benchmarks
  labels:
    benchmark-type: teardown
spec:
  parallelism: 1
  script:
    configMap:
      name: benchmark-teardown-script
      file: teardown.ts
  arguments: >-
    --env STUDIO_URL=http://studio.abl-platform.svc.cluster.local:5173
    --env RUNTIME_URL=http://runtime.abl-platform.svc.cluster.local:3112
    --env SEARCH_AI_URL=http://search-ai.abl-platform.svc.cluster.local:3113
    --iterations 1
    --vus 1
  runner:
    resources:
      requests:
        cpu: 250m
        memory: 256Mi
      limits:
        cpu: 500m
        memory: 512Mi
```

- [ ] **Step 5: Commit**

```bash
npx prettier --write benchmarks/k8s/*.yaml 2>/dev/null || true
git add benchmarks/k8s/namespace.yaml benchmarks/k8s/secrets.yaml benchmarks/k8s/testrun-setup.yaml benchmarks/k8s/testrun-teardown.yaml
git commit -m "feat(benchmarks): add K8s manifests — namespace, secrets, setup/teardown TestRuns"
```

---

## Chunk 4: Tier Profiles + Script Validation

### Task 10: Tier Profiles Config

**Files:**

- Create: `benchmarks/config/tier-profiles.json`

- [ ] **Step 1: Create tier-profiles.json**

```json
{
  "s": {
    "perService": { "vus": 10, "parallelism": 1, "duration": "10m" },
    "integration": { "vus": 5, "parallelism": 1, "duration": "10m" },
    "system": { "vus": 20, "parallelism": 2, "duration": "2h" }
  },
  "m": {
    "perService": { "vus": 50, "parallelism": 4, "duration": "30m" },
    "integration": { "vus": 20, "parallelism": 4, "duration": "15m" },
    "system": { "vus": 50, "parallelism": 4, "duration": "4h" }
  },
  "l": {
    "perService": { "vus": 200, "parallelism": 8, "duration": "30m" },
    "integration": { "vus": 100, "parallelism": 8, "duration": "20m" },
    "system": { "vus": 100, "parallelism": 8, "duration": "4h" }
  },
  "xl": {
    "perService": { "vus": 500, "parallelism": 16, "duration": "30m" },
    "integration": { "vus": 250, "parallelism": 16, "duration": "30m" },
    "system": { "vus": 200, "parallelism": 16, "duration": "4h" }
  }
}
```

- [ ] **Step 2: Commit**

```bash
npx prettier --write benchmarks/config/tier-profiles.json
git add benchmarks/config/tier-profiles.json
git commit -m "feat(benchmarks): add tier-profiles.json — VU/parallelism/duration per tier"
```

---

### Task 11: Validate 8 Critical Scripts (Typecheck + Fix)

**Files:**

- Modify: `benchmarks/services/runtime.ts` (if needed)
- Modify: `benchmarks/services/search-ai.ts` (if needed)
- Modify: `benchmarks/services/bge-m3.ts` (if needed)
- Modify: `benchmarks/services/mongodb.ts` (if needed)
- Modify: `benchmarks/services/opensearch.ts` (if needed)
- Modify: `benchmarks/integration/agent-conversation-e2e.ts` (if needed)
- Modify: `benchmarks/integration/kb-ingestion-e2e.ts` (if needed)
- Modify: `benchmarks/integration/search-query-e2e.ts` (if needed)

This task is iterative — run typecheck, fix errors, repeat until clean.

- [ ] **Step 1: Run typecheck on entire benchmarks directory**

Run: `cd benchmarks && npx tsc --noEmit 2>&1 | head -100`
Expected: List of type errors (if any) across all files

- [ ] **Step 2: Fix all type errors in the 8 critical scripts + setup modules**

For each error:

1. Read the source file to understand the issue
2. Fix the type error (wrong import path, missing type, incorrect signature)
3. Run `npx tsc --noEmit` again to verify the fix

Common issues to expect:

- Import paths using `.js` extension (correct for k6 TypeScript)
- Missing `@types/k6` types for newer k6 1.0 APIs
- Mismatched function signatures in shared libs
- **CRITICAL:** `benchmarks/lib/auth.ts` line 41 uses `data.token` but the dev-login API returns `data.accessToken`. Fix: change `return data.token` to `return data.accessToken` and update the `AuthResponse` interface to match.
- **CRITICAL:** ConfigMap bundling — k6 Operator TestRuns mount a single ConfigMap. Scripts that import from `../lib/config.js` will fail because the lib files are in a separate ConfigMap (`benchmark-lib`). Fix: either (a) bundle scripts with esbuild before creating ConfigMaps, or (b) use k6 Operator's multi-configmap support if available, or (c) inline the shared lib code into each script's ConfigMap. The simplest approach for Week 1 is to use a build step with esbuild that bundles each script + its deps into a single file.

- [ ] **Step 3: Verify all 8 scripts parse with k6**

Run (for each script):

```bash
k6 inspect benchmarks/services/runtime.ts
k6 inspect benchmarks/services/search-ai.ts
k6 inspect benchmarks/services/bge-m3.ts
k6 inspect benchmarks/services/mongodb.ts
k6 inspect benchmarks/services/opensearch.ts
k6 inspect benchmarks/integration/agent-conversation-e2e.ts
k6 inspect benchmarks/integration/kb-ingestion-e2e.ts
k6 inspect benchmarks/integration/search-query-e2e.ts
```

Expected: Each outputs valid k6 test metadata (scenarios, thresholds) with no parse errors

- [ ] **Step 4: Verify bootstrap script parses**

Run: `k6 inspect benchmarks/setup/bootstrap.ts`
Expected: Shows options with `vus: 1, iterations: 1`

- [ ] **Step 5: Commit fixes**

```bash
npx prettier --write benchmarks/**/*.ts
git add benchmarks/
git commit -m "fix(benchmarks): fix type errors and k6 parse issues in critical scripts"
```

---

## Validation Checklist

After all tasks are complete, verify:

- [ ] `cd benchmarks && npx tsc --noEmit` passes with zero errors
- [ ] `k6 inspect benchmarks/setup/bootstrap.ts` shows valid test config
- [ ] `k6 inspect benchmarks/setup/teardown.ts` shows valid test config
- [ ] All 8 benchmark scripts pass `k6 inspect`
- [ ] `benchmarks/scripts/create-configmaps.sh` is executable
- [ ] All fixture files exist: `agent-config.json`, `kb-config.json`, `model-chain-mock.json`, `model-chain-real.json`, 3 sample docs
- [ ] All K8s manifests are valid YAML: `kubectl apply --dry-run=client -f benchmarks/k8s/`
- [ ] `benchmarks/config/tier-profiles.json` is valid JSON

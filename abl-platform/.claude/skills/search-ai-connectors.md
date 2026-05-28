---
name: search-ai-connectors
description: Use when working on packages/connectors/, connector workers (connector-sync, connector-discovery, connector-permission-crawl), connector routes/services in apps/search-ai/, or when the user mentions SharePoint, OAuth connectors, delta sync, permission crawling, webhook subscriptions, resource discovery, sync coordinators, filter engines, building new connectors, migrating connectors, or debugging connector sync issues. Covers research, scaffolding, migration, architecture patterns, anti-patterns, debugging runbook, and references to detailed design documentation.
---

# SearchAI Connectors

**Version:** 1.0.0 (2026-03-11)
**Status:** Active Development

## How to Use This Skill

| You want to...                                 | Go to section                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Understand how connectors work                 | [Architecture Overview](#architecture-overview)                                                   |
| Research a new external system before building | [Phase 1: Research](#phase-1-research-the-external-system)                                        |
| Build a new connector from scratch             | [Phase 2: Scaffold](#phase-2-scaffold-a-new-connector)                                            |
| Migrate a connector from another repo          | [Migration Guide](#migrating-a-connector-from-another-repo)                                       |
| Debug a failing connector                      | [Debugging Runbook](#debugging-runbook)                                                           |
| Review connector code                          | [Anti-Patterns](#anti-patterns) + [Architecture Review Checklist](#architecture-review-checklist) |

## Design Documentation

Read these in order when onboarding:

1. **Narrative Walkthrough:** `docs/searchai/design/SHAREPOINT-CONNECTOR-COMPLETE-REFERENCE.md` — 11 scenes from OAuth to search results, explains _why_ every decision was made
2. **Class & Sequence Diagrams:** `docs/searchai/design/SHAREPOINT-CONNECTOR-DIAGRAMS.md` — 17 ASCII diagrams covering every class hierarchy and sequence flow
3. **Connectors Framework:** `apps/search-ai/docs/connectors/search-ai-connectors-framework.md` — IConnector interface spec, base infrastructure, plugin system

---

## Architecture Overview

### Package Structure

```
packages/connectors/
  base/          @agent-platform/connectors-base
    interfaces/    IConnector, ISyncCoordinator, IFilterEngine, IOAuthProvider, IResourceDiscovery
    auth/          TokenManager (auto-refresh, 5-min pre-expiry buffer)
    client/        HttpClient (retry + rate limiting), RateLimiter (token bucket)
    sync/          BaseSyncCoordinator (template method pattern)
    filters/       BaseFilterEngine
    discovery/     BaseResourceDiscovery

  sharepoint/    @agent-platform/connector-sharepoint  [REFERENCE IMPLEMENTATION]
    auth/          MicrosoftOAuthProvider (3 OAuth flows)
    client/        GraphClient extends HttpClient
    sync/          FullSyncCoordinator, DeltaSyncCoordinator, DeltaTokenManager
    filters/       SharePointFilterEngine (scope + document level)
    permissions/   SharePointPermissionCrawler (full + simplified modes)
    discovery/     SharePointResourceDiscovery
    webhooks/      WebhookManager
```

### Key Patterns (Summary)

1. **Template Method** — `BaseSyncCoordinator.performSync()` is the skeleton; subclasses implement `fetchDocuments()`, `downloadDocument()`, `crawlPermissionsBatch()`, `getDeltaToken()`
2. **Dual-DB Model Injection** — Connector receives models from both `platform` and `searchaicontent` databases via constructor. Never import models directly.
3. **Distributed Locking** — Redis `SET NX PX` with 1-hour TTL per connector. One sync at a time, even across pods.
4. **Delta Tokens** — Full sync establishes them, delta sync consumes them. Per-resource (e.g., per-drive for SharePoint).
5. **Two-Level Filtering** — Scope filtering (cheap, skip entire containers) + document filtering (per-item: extension, path, size, date)
6. **Permission Graph** — Neo4j with 4-path query-time filtering. Crawling decoupled from sync.
7. **Checkpoint Pause/Resume** — Save pagination token + processed count every 100 docs. Resume from exact page on restart.

### BullMQ Queues

| Queue                        | Purpose                        | Concurrency            |
| ---------------------------- | ------------------------------ | ---------------------- |
| `connector-sync`             | Full and delta sync            | 1 per connector (lock) |
| `connector-discovery`        | Resource discovery + profiling | 1 per connector (lock) |
| `connector-permission-crawl` | Permission graph building      | 1 per connector        |

### REST API Surface

```
# Auth
POST   /connectors/:id/auth/initiate        Start OAuth flow
GET    /connectors/:id/auth/status           Poll OAuth progress
POST   /connectors/:id/auth/callback         Handle redirect
POST   /connectors/:id/auth/revoke           Revoke token

# Discovery
POST   /connectors/:id/discover              Start discovery
GET    /connectors/:id/discovery              Get results
POST   /connectors/:id/recommendations       Generate recommendations
POST   /connectors/:id/quick-setup           One-click setup

# Sync
POST   /connectors/:id/sync/start            Start full or delta sync
POST   /connectors/:id/sync/pause            Pause active sync
POST   /connectors/:id/sync/resume           Resume from checkpoint
POST   /connectors/:id/sync/restart          Start fresh (delete checkpoints)
GET    /connectors/:id/sync/status            Get progress

# Permissions
POST   /connectors/:id/permissions/crawl     Start permission crawl
GET    /connectors/:id/permissions/status     Get crawl progress
PUT    /connectors/:id/permissions/mode       Update mode (full/simplified/disabled)
POST   /connectors/:id/permissions/recrawl   Manual recrawl
```

---

## Phase 1: Research the External System

**Every connector depends on an external system we don't control.** Before writing code, you must answer these questions. Missing any one can cause a fundamental redesign later.

### 1.1 Authentication Research

| Question                                                                                           | Why It Matters                                            | Where to Document         |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------- |
| What OAuth grant types does the API support? (auth code, device code, client credentials, API key) | Determines which `IOAuthProvider` methods to implement    | `connectionConfig` schema |
| What scopes/permissions are needed for read-only sync? For permissions? For webhooks?              | Scope escalation — request minimum, expand per feature    | Scope table in design doc |
| How long do access tokens live? Is there a refresh token?                                          | TokenManager's refresh buffer depends on this             | Token TTL config          |
| Does the API support app-only (service account) access?                                            | Some enterprises require it — no human in the loop        | Auth flow matrix          |
| What's the token endpoint URL pattern? Per-tenant or global?                                       | Multi-tenant auth routing                                 | OAuthProvider config      |
| Are there consent/admin-approval requirements?                                                     | Affects onboarding UX — some APIs need admin pre-approval | Setup guide               |

### 1.2 Supported Objects & Content Research

| Question                                                                           | Why It Matters                                                               | Where to Document      |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------- |
| What object types does the API expose? (files, pages, issues, records, emails)     | Determines what becomes a `SearchDocument` and what's a container            | Object mapping table   |
| Which objects contain searchable content? Which are structural only?               | Structural objects (projects, spaces) become scope filters, not documents    | Object classification  |
| Are there object relationships? (parent-child, linked, embedded)                   | Affects whether you sync flat or preserve hierarchy in metadata              | Relationship model     |
| What content formats are returned? (HTML, markdown, binary files, structured JSON) | Routes to different extraction pipelines (Docling, text, structured)         | Content type matrix    |
| Are there attachments? How are they linked to parent objects?                      | Attachments may need separate API calls and separate SearchDocuments         | Attachment strategy    |
| Are there comments/discussions on objects? Sync them too?                          | Comments often contain valuable searchable content but add volume            | Content scope decision |
| What's the total expected volume? (objects, total size, growth rate)               | Determines if streaming is mandatory, checkpoint frequency, storage planning | Capacity planning      |

### 1.3 Metadata & Field Mapping Research

| Question                                                                                           | Why It Matters                                                          | Where to Document        |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------ |
| What metadata fields are available per object? (status, priority, labels, dates, author, assignee) | Maps to `sourceMetadata` — powers canonical field mapping and filtering | Metadata field inventory |
| Which fields are enums/picklists? What are the possible values?                                    | Enum coercion for canonical schema — needs value mapping                | Enum mapping table       |
| Which fields are user references? (author, assignee, reviewer)                                     | Need to resolve to email/name for display and permission filtering      | User field mapping       |
| Are there custom fields? How are they discovered?                                                  | Custom fields vary per tenant — need schema discovery                   | Schema discovery design  |
| What date fields exist? What timezone/format?                                                      | Date parsing for canonical `created_date`, `modified_date` etc.         | Date format handling     |
| Are field names stable across API versions?                                                        | Breaking field renames need migration handling                          | API version strategy     |

### 1.4 Resource Hierarchy & Data Model Research

| Question                                                                     | Why It Matters                                            | Where to Document                   |
| ---------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------- |
| What's the resource hierarchy? (e.g., tenant > project > space > page)       | Determines enumeration order in `fetchDocuments()`        | Design doc hierarchy section        |
| What's the unique identifier for each document? Is it stable across renames? | Deduplication and delta sync depend on stable IDs         | `SourceDocument.documentId` mapping |
| What metadata is available per document? (author, dates, labels, status)     | Maps to `sourceMetadata` — powers canonical field mapping | Metadata mapping table              |
| What file formats / content types are returned?                              | Determines extraction pipeline routing                    | Content type matrix                 |
| Is content returned inline or as a separate download?                        | Affects `downloadDocument()` — one API call or two?       | Client method design                |
| What's the maximum document/content size?                                    | Streaming vs buffered download, memory planning           | Size limits config                  |

### 1.5 Pagination & Enumeration Research

| Question                                                                     | Why It Matters                                              | Where to Document       |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------- |
| What pagination style? (cursor, offset, page token, link header)             | Determines checkpoint format and resume strategy            | Checkpoint schema       |
| What's the maximum page size?                                                | Batch size for `fetchDocuments()`                           | Client config           |
| Can you enumerate recursively or must you walk the hierarchy level by level? | Affects enumeration strategy (breadth-first vs depth-first) | Sync coordinator design |
| Is there a search/filter API for server-side filtering?                      | Can push Level 1 filters to the API instead of client-side  | Filter engine design    |
| Are results ordered deterministically?                                       | If not, cursor-based resume may miss or duplicate items     | Checkpoint reliability  |

### 1.6 Incremental Sync Research

| Question                                                                | Why It Matters                                                                 | Where to Document      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------- |
| Does the API have a delta/changes endpoint?                             | Determines if delta sync is possible at all                                    | Delta sync feasibility |
| What's the delta token format? (opaque URL, timestamp, sequence number) | Affects `DeltaTokenManager` storage                                            | Token model fields     |
| Is the delta per-resource, per-container, or per-tenant?                | Drives token granularity — one token per drive vs per site                     | Token manager design   |
| Does delta include deletions? How are they signaled?                    | Soft-delete logic depends on this (`@removed` flag, `deleted` status, absence) | Delta sync handler     |
| What's the delta token lifetime? Do they expire?                        | Stale token recovery strategy — fall back to full sync?                        | Error handling         |
| What happens if you use an expired/invalid token?                       | Error code to detect and trigger full re-sync                                  | Recovery logic         |

### 1.7 Webhook / Real-Time Research

| Question                                                            | Why It Matters                                                        | Where to Document      |
| ------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------- |
| Does the API support webhooks / change notifications?               | Determines if near-real-time sync is possible                         | Webhook feasibility    |
| What events are available? (created, updated, deleted, moved)       | Determines which changes trigger delta sync                           | Event mapping          |
| What's the subscription lifetime? Auto-renew or manual?             | Renewal job scheduling                                                | WebhookManager design  |
| How is the webhook validated? (signature, shared secret, challenge) | Security — prevent spoofed notifications                              | Validation logic       |
| What's in the webhook payload? Full resource or just ID?            | If just ID, webhook triggers delta sync. If full, can process inline. | Webhook handler design |
| Rate limits on subscription creation? Max subscriptions per app?    | May need to batch or prioritize which resources get webhooks          | Subscription strategy  |

### 1.8 Rate Limiting Research

| Question                                                                  | Why It Matters                                    | Where to Document          |
| ------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------- |
| What are the rate limits? (requests/second, requests/minute, daily quota) | Token bucket configuration                        | RateLimiter config         |
| Are limits per-app, per-user, or per-tenant?                              | Affects whether multiple connectors share a limit | Rate limit scoping         |
| How are limits communicated? (`429` + `Retry-After`? Headers? Docs only?) | Retry strategy depends on this                    | HttpClient retry config    |
| Are there different limits for different endpoints?                       | May need per-endpoint rate limiters               | Client design              |
| Are there batch/bulk endpoints that reduce call count?                    | Can dramatically reduce API usage                 | Optimization opportunities |
| Is there a way to check remaining quota programmatically?                 | Proactive throttling vs reactive retry            | Monitoring                 |

### 1.9 Permission Model Research

| Question                                                                    | Why It Matters                                                            | Where to Document      |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------- |
| What permission model does the system use? (ACL, RBAC, ABAC, sharing links) | Determines Neo4j graph structure                                          | Permission design      |
| Can permissions be inherited from containers? (folder, project, space)      | Inheritance affects crawl strategy — crawl containers or individual docs? | Crawl mode design      |
| Are there groups/teams? Can groups nest?                                    | Recursive group expansion (full vs simplified mode)                       | Group handling         |
| Is there a per-document permission API?                                     | Required for document-level permission crawling                           | Crawl implementation   |
| Are there public/anonymous sharing modes?                                   | `publicEveryone` / `publicInDomain` flags                                 | Public access handling |
| Can permissions change independently of content?                            | Determines if permission crawl needs its own schedule                     | Re-crawl triggers      |

### 1.10 Filter Capabilities Research

| Question                                                                           | Why It Matters                                           | Where to Document    |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------- |
| Does the API support server-side filtering? (query params, OData, GraphQL filters) | Push filters to API = fewer items to fetch = faster sync | Filter engine design |
| Can you filter by date range? (modified since, created after)                      | Critical for "sync only recent content" use case         | Date filter config   |
| Can you filter by object type or content type?                                     | Skip unwanted types at API level instead of client-side  | Type filter config   |
| Can you filter by container/path? (specific folders, projects, spaces)             | Maps to Level 1 scope filtering in `FilterEngine`        | Scope filter config  |
| Can you filter by file size on the server side?                                    | Avoid downloading huge files only to discard them        | Size filter config   |
| What label/tag/category systems exist? Can you filter by them?                     | Rich filtering for content-aware sync                    | Label filter config  |
| Does the API support exclude patterns? (e.g., archived, deleted, draft)            | Default exclusions to avoid syncing trash                | Exclusion defaults   |

### 1.11 Research Output Template

After research, create a design doc at `docs/searchai/design/<CONNECTOR-NAME>-CONNECTOR-DESIGN.md` with:

```markdown
# <Name> Connector — Design Document

## API Summary

- Base URL:
- Auth: (grant types, scopes, token lifetime)
- Rate limits: (requests/min, daily quota)
- API docs URL:

## Supported Objects

| Object Type        | Searchable Content? | Becomes                 | Notes                    |
| ------------------ | ------------------- | ----------------------- | ------------------------ |
| (e.g., Issue)      | Yes                 | SearchDocument          | Main searchable entity   |
| (e.g., Project)    | No — structural     | Scope filter            | Container for issues     |
| (e.g., Attachment) | Yes                 | SearchDocument (linked) | Separate download API    |
| (e.g., Comment)    | Yes                 | Embedded in parent      | Append to parent content |

## Resource Hierarchy

<diagram of tenant > project > space > document etc.>

## Metadata Fields

| Source Field     | Type     | Canonical Mapping | Enum Values                 | Notes                 |
| ---------------- | -------- | ----------------- | --------------------------- | --------------------- |
| (e.g., status)   | enum     | status            | Open, In Progress, Done     |                       |
| (e.g., priority) | enum     | priority          | Low, Medium, High, Critical |                       |
| (e.g., assignee) | user ref | assigned_to       | (user email)                | Needs user resolution |
| (e.g., labels)   | string[] | tags              | (free-form)                 | Multi-value           |
| (e.g., created)  | datetime | created_date      |                             | ISO 8601              |

Custom fields: (describe discovery mechanism)

## Authentication

| Flow | Supported | Scopes Required |
| ---- | --------- | --------------- |

## Filter Capabilities

| Filter Type                  | Server-Side? | Client-Side? | Notes                |
| ---------------------------- | ------------ | ------------ | -------------------- |
| By container (project/space) |              |              | Level 1 scope filter |
| By date range                |              |              |                      |
| By object type               |              |              |                      |
| By status/label              |              |              |                      |
| By file extension            |              |              |                      |
| By file size                 |              |              |                      |
| Exclude archived/deleted     |              |              |                      |

## Enumeration Strategy

- Hierarchy traversal order:
- Pagination style:
- Page size:
- Estimated API calls for 10K / 100K / 1M documents:

## Delta Sync

- Supported: yes/no
- Token type: (opaque URL / timestamp / sequence)
- Token scope: (per-resource / per-container / per-tenant)
- Includes deletions: yes/no
- Token lifetime:

## Webhooks

- Supported: yes/no
- Events:
- Subscription lifetime:
- Validation method:
- Payload: (full resource / ID only)

## Permission Model

- Type: (ACL / RBAC / sharing links)
- Permission hierarchy: (inherited from containers? overridable per-object?)
- Per-document API: yes/no
- Group nesting: yes/no
- Public sharing: yes/no
- Inheritance:

## Mapping to Platform Concepts

| Source Concept       | Platform Concept          | Notes |
| -------------------- | ------------------------- | ----- |
| (e.g., Jira Issue)   | SearchDocument            |       |
| (e.g., Jira Project) | SearchSource scope filter |       |
| (e.g., Jira Board)   | Not synced — UI only      |       |

## Estimated API Usage

| Operation                     | API Calls (10K docs) | API Calls (100K docs) |
| ----------------------------- | -------------------- | --------------------- |
| Full sync                     |                      |                       |
| Delta sync (1% changed)       |                      |                       |
| Permission crawl (full)       |                      |                       |
| Permission crawl (simplified) |                      |                       |

## Risks & Open Questions

1.
2.
```

---

## Phase 2: Scaffold a New Connector

### 2.1 Create the Package

```
packages/connectors/<name>/
  package.json
  tsconfig.json
  src/
    <name>-connector.ts           # IConnector implementation (main entry)
    auth/
      <name>-oauth-provider.ts    # IOAuthProvider implementation
    client/
      <name>-client.ts            # extends HttpClient, wraps external API
      <name>-types.ts             # TypeScript types for API responses
    sync/
      full-sync-coordinator.ts    # extends BaseSyncCoordinator
      delta-sync-coordinator.ts   # extends BaseSyncCoordinator (if delta supported)
    filters/
      <name>-filter-engine.ts     # extends BaseFilterEngine
    permissions/
      <name>-permission-crawler.ts  # (if permissions supported)
    discovery/
      <name>-resource-discovery.ts  # extends BaseResourceDiscovery (optional)
    webhooks/
      webhook-manager.ts           # (if webhooks supported)
    index.ts                       # barrel export
  __tests__/
    <name>-connector.test.ts
    <name>-filter-engine.test.ts
```

### 2.2 package.json

```json
{
  "name": "@agent-platform/connector-<name>",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" }
  },
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run"
  },
  "dependencies": {
    "@agent-platform/connectors-base": "workspace:*",
    "@agent-platform/database": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "vitest": "^1.0.0"
  }
}
```

### 2.3 tsconfig.json

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "composite": true
  },
  "include": ["src"],
  "references": [{ "path": "../base" }]
}
```

### 2.4 Connector Class Stub

```typescript
// src/<name>-connector.ts
import type {
  IConnector,
  IConnectorConfig,
  ValidationResult,
  ConnectionTestResult,
  SyncResult,
  PermissionCrawlResult,
  IResourceDiscovery,
  SyncCoordinatorModels,
} from '@agent-platform/connectors-base';
import type { Model } from 'mongoose';
import type { IEndUserOAuthToken } from '@agent-platform/database/models';

export class MyConnector implements IConnector {
  readonly connectorType = '<name>';
  readonly config: IConnectorConfig;

  private client: MyClient | null = null;
  private tokenManager: TokenManager | null = null;
  private fullSyncCoordinator: MyFullSyncCoordinator | null = null;

  constructor(
    config: IConnectorConfig,
    private readonly tokenModel?: Model<IEndUserOAuthToken>,
    private readonly syncModels?: SyncCoordinatorModels,
  ) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    // 1. Create OAuth provider
    // 2. Create TokenManager (wraps provider + handles refresh)
    // 3. Create API client (extends HttpClient, uses TokenManager)
    // 4. Create filter engine
    // 5. Create sync coordinators
  }

  async validateConfig(): Promise<ValidationResult> {
    const errors: Array<{ field: string; message: string }> = [];
    // Validate required fields from connectionConfig
    return { valid: errors.length === 0, errors };
  }

  async testConnection(): Promise<ConnectionTestResult> {
    // Make a lightweight API call to verify credentials work
    // e.g., fetch current user or list top-level resources
  }

  async performFullSync(checkpoint?: any): Promise<SyncResult> {
    if (!this.fullSyncCoordinator) throw new Error('Not initialized');
    return this.fullSyncCoordinator.performSync('full', checkpoint);
  }

  async performDeltaSync(): Promise<SyncResult> {
    // Delegate to delta sync coordinator (if supported)
  }

  async pauseSync(jobId: string): Promise<void> {
    /* set pause flag */
  }
  async resumeSync(jobId: string): Promise<void> {
    /* clear pause flag */
  }

  async crawlPermissions(mode: 'full' | 'simplified' | 'disabled'): Promise<PermissionCrawlResult> {
    // Create permission crawler and process documents
  }

  getResourceDiscovery(): IResourceDiscovery {
    // Return discovery implementation for this source
  }
}
```

### 2.5 Full Sync Coordinator Stub

```typescript
// src/sync/full-sync-coordinator.ts
import { BaseSyncCoordinator, type SourceDocument } from '@agent-platform/connectors-base';

export class MyFullSyncCoordinator extends BaseSyncCoordinator {
  // Required: enumerate all documents from source
  async fetchDocuments(checkpoint: any | null): Promise<SourceDocument[]> {
    // 1. List top-level containers (filtered by scope)
    // 2. For each container, stream documents in batches
    // 3. Map each to SourceDocument format
    // 4. If source supports delta: establish delta token after each container
    // IMPORTANT: Use async generator for large collections to avoid OOM
  }

  // Required: download document content
  async downloadDocument(doc: SourceDocument): Promise<Buffer> {
    // Call API to get file content
    // Return as Buffer for upload to S3
  }

  // Required: crawl permissions for a batch of documents
  protected async crawlPermissionsBatch(
    documents: Array<{ searchDocId: string; sourceMetadata: any }>,
  ): Promise<void> {
    // Create permission crawler, process batch
  }

  // Required: get delta token (return null if not applicable)
  async getDeltaToken(): Promise<string | null> {
    return null; // Override if source supports delta
  }
}
```

### 2.6 Registration Checklist

After building the connector:

- [ ] Add `@agent-platform/connector-<name>` to `pnpm-workspace.yaml` if not auto-detected
- [ ] Add to sync worker's connector factory (`apps/search-ai/src/workers/connector-sync-worker.ts`)
- [ ] Add to discovery worker's connector factory (`apps/search-ai/src/workers/connector-discovery-worker.ts`)
- [ ] Add `COPY packages/connectors/<name>/package.json packages/connectors/<name>/package.json` to **all** Dockerfiles:
  - `apps/search-ai/Dockerfile`
  - `apps/runtime/Dockerfile`
  - `apps/admin/Dockerfile`
  - `apps/studio/Dockerfile`
- [ ] Add connector type to `ConnectorConfig` model's `connectorType` enum
- [ ] Add Studio UI configuration panel (if applicable)
- [ ] Add tests: unit (coordinator logic), integration (API mocking), e2e (real API if possible)
- [ ] Create design doc from research template
- [ ] Update `apps/search-ai/docs/connectors/search-ai-connectors-framework.md`

---

## Migrating a Connector from Another Repo

When bringing an existing connector from an external repo into this platform:

### Step 1: Audit the Existing Code

| Check            | What to Look For                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------- |
| Auth mechanism   | Does it use its own OAuth? Must adapt to `IOAuthProvider` + `TokenManager`                   |
| Database access  | Does it import models directly? Must switch to constructor-injected models                   |
| HTTP client      | Does it use axios/got/node-fetch directly? Must use `HttpClient` (for rate limiting + retry) |
| Rate limiting    | Does it have its own? Must use `RateLimiter` from base package                               |
| Error handling   | Does it swallow errors? Must follow platform patterns (log + propagate)                      |
| Tenant isolation | Does every query include `tenantId`? Must add if missing                                     |
| Logging          | Does it use `console.log`? Must use `createLogger()`                                         |
| State management | Does it store sync state? Must use `SyncCheckpoint` model                                    |
| Tests            | What test patterns? Must adapt to vitest + platform fixtures                                 |

### Step 2: Adapt to Platform Interfaces

1. **Create connector class** implementing `IConnector` (see scaffold above)
2. **Wrap existing API client** in a class extending `HttpClient` — move auth headers, pagination, error mapping into the wrapper
3. **Extract sync logic** into a `BaseSyncCoordinator` subclass — the existing "fetch all documents" logic becomes `fetchDocuments()`
4. **Replace direct model imports** with constructor-injected models from `SyncCoordinatorModels`
5. **Replace direct DB queries** with tenant-scoped queries: `findOne({ _id, tenantId })` everywhere
6. **Replace logging** with `createLogger('<connector-name>')`
7. **Add rate limiter** config matching the source API's limits

### Step 3: Wire Into Platform

Follow the [Registration Checklist](#26-registration-checklist) above.

### Step 4: Verify Parity

- [ ] Run both old and new connectors against the same test tenant
- [ ] Compare document counts, metadata completeness, permission accuracy
- [ ] Verify delta sync produces same results as old incremental mechanism
- [ ] Load test at scale (k6 or equivalent) to verify rate limiting holds

---

## Debugging Runbook

### Sync Not Starting

```
Symptom: POST /sync/start returns success but no documents appear
```

1. **Check job in BullMQ:** `GET /connectors/:id/sync/status` — is `syncInProgress` true?
2. **Check Redis lock:** Look for `sync-lock:{indexId}:{connectorId}` in Redis. If it exists and the worker is dead, the lock is stale (wait for 1-hour TTL or delete manually).
3. **Check OAuth token:** Is `EndUserOAuthToken.revokedAt` set? Is `expiresAt` in the past with no refresh token?
4. **Check worker logs:** Search for `connector-sync-worker` + `connectorId` in logs.
5. **Check BullMQ queue:** Is the job stuck in `waiting` state? Workers may not be running.

### Sync Stuck / Never Completes

```
Symptom: Sync shows "syncing" for hours, progress not advancing
```

1. **Check checkpoint:** Load latest `SyncCheckpoint` for this connector. Is `processedCount` advancing?
2. **Check rate limiting:** If the source API is heavily throttled, sync slows to a crawl. Check `RateLimiter` token availability.
3. **Check for infinite pagination:** Does the API return the same `nextLink` repeatedly? Log the cursor values.
4. **Check memory:** Worker OOM? Check pod memory usage. Large documents or loading too many items into memory.
5. **Check pause flag:** Is `ConnectorConfig.errorState.isPaused` accidentally set to true?

### Delta Sync Misses Changes

```
Symptom: Documents changed in source but delta sync reports 0 changes
```

1. **Check delta token freshness:** `GET /connectors/:id/delta-tokens` — is `lastSyncAt` recent?
2. **Check token scope:** Delta tokens are per-resource (e.g., per-drive). If a new container was added after last full sync, it won't have a token. Run full sync to establish.
3. **Check token validity:** Some APIs expire delta tokens after N days. If expired, the API returns an error. Check for 410 Gone or similar in logs.
4. **Check filter config:** Did scope filters exclude the container where changes happened?
5. **Resolution:** Reset token via `DELETE /connectors/:id/delta-tokens/:resourceId` and run full sync for that resource.

### Permission Crawl Failing

```
Symptom: Permission crawl completes but users can't see documents they should access
```

1. **Check crawl mode:** `GET /connectors/:id/permissions/status` — is mode `simplified`? Simplified misses deeply nested groups.
2. **Check Neo4j connectivity:** Can the worker reach Neo4j? Check connection errors in logs.
3. **Check group resolution:** In full mode, recursive group expansion can hit API rate limits. Check for 429 errors during crawl.
4. **Check user identity mapping:** Does the user's email in the platform match their email in the source system? Case-sensitivity issues are common.
5. **Check cache:** Permission filter results are cached in Redis for 5 minutes. Wait or flush cache.
6. **Verify in Neo4j directly:** Run Cypher query: `MATCH (u:User {email: '<email>'})-[*..20]->(d:Document) RETURN d.documentId`

### Token Refresh Failing

```
Symptom: Sync fails with 401 Unauthorized after working previously
```

1. **Check refresh token:** Load `EndUserOAuthToken` — is `encryptedRefreshToken` present?
2. **Check token revocation:** Did someone revoke app access in the source system's admin console?
3. **Check client credentials:** Did the app registration (client ID/secret) expire or get rotated?
4. **Check scopes:** Did required scopes change? Some APIs add new required scopes over time.
5. **Resolution:** Re-initiate auth flow via `POST /connectors/:id/auth/initiate`.

### Rate Limit Errors (429)

```
Symptom: Intermittent 429 errors in sync worker logs
```

1. **Check rate limiter config:** Is `maxTokens` and `refillRate` configured correctly for this API?
2. **Check concurrent connectors:** Multiple connectors to the same API share the app-level rate limit.
3. **Check API documentation:** Did the provider change their rate limits?
4. **Adjust:** Reduce `refillRate` in `RateLimiter` config. The token bucket should be set conservatively below the actual limit.

### Documents Duplicated

```
Symptom: Same document appears multiple times in search results
```

1. **Check contentHash:** Is the deduplication hash `SHA256(documentId + modifiedAt)` producing different values for the same document?
2. **Check documentId stability:** Does the source API return different IDs for the same document in different contexts?
3. **Check modifiedAt precision:** If the source returns millisecond timestamps but comparisons lose precision, hashes differ.
4. **Resolution:** Fix the `mapToSourceDocument()` mapping to use a stable document identifier.

### Common Log Patterns to Search

```
# Find sync errors for a connector
grep "connectorId.*<id>" logs | grep -i "error\|fail\|429\|401\|timeout"

# Find lock contention
grep "sync-lock" logs | grep "<connectorId>"

# Find checkpoint saves
grep "checkpoint.*saved" logs | grep "<connectorId>"

# Find rate limiting waits
grep "rate.*limit\|throttl\|429" logs | grep "<connectorId>"

# Find token refresh
grep "token.*refresh\|token.*expired" logs | grep "<connectorId>"
```

---

## Anti-Patterns

| Don't                                        | Do                                                 | Why                                  |
| -------------------------------------------- | -------------------------------------------------- | ------------------------------------ |
| `findById(connectorId)`                      | `findOne({ _id: connectorId, tenantId })`          | Tenant isolation                     |
| `getModel('SearchDocument')`                 | `getLazyModel<ISearchDocument>('SearchDocument')`  | Type safety (union type bug)         |
| `console.log()` in server code               | `createLogger('module').info()`                    | Structured logging                   |
| `await connector.performFullSync()` in route | Queue via BullMQ                                   | Locks, checkpoints, crash recovery   |
| Load all items into memory                   | Async generator / streaming batches                | OOM prevention for large sources     |
| Hard-delete on delta sync                    | `isDeleted: true, deletedAt: now`                  | Audit trail                          |
| Fail entire sync on one doc error            | Log, increment failedDocuments, continue           | Error isolation                      |
| Fail sync on permission crawl error          | Let sync succeed, report crawl failure             | Decoupled concerns                   |
| Import models directly in connector          | Accept via constructor injection                   | Dual-DB support, testability         |
| Store credentials in Redis job data          | Pass connectorConfigId reference                   | M-3 security                         |
| Use `(err as Error).message`                 | `err instanceof Error ? err.message : String(err)` | Type safety                          |
| Hardcode API base URL                        | Config via `connectionConfig`                      | Multi-tenant, different environments |
| Skip rate limiter for "just one call"        | Always go through rate limiter                     | Shared quota, consistency            |
| Retry indefinitely on auth errors            | Fail fast on 401/403, trigger re-auth              | Don't waste quota on expired tokens  |

## Architecture Review Checklist

When reviewing connector code, verify all of these:

- [ ] Implements `IConnector` interface completely
- [ ] OAuth credentials stored encrypted (`EndUserOAuthToken`, AES pre-save hook)
- [ ] Token refresh with pre-expiry buffer via `TokenManager`
- [ ] Extends `BaseSyncCoordinator` (not custom sync loop)
- [ ] Distributed lock acquired before sync (Redis SET NX PX, 1hr TTL)
- [ ] Incremental sync uses delta tokens or equivalent (not full re-sync)
- [ ] Checkpoint saved every 100 docs, pause checked every 10 docs
- [ ] Streaming enumeration (async generator, not loading all into memory)
- [ ] Deduplication via contentHash
- [ ] Soft-delete on removal (isDeleted=true, never hard delete)
- [ ] Permission crawl decoupled from sync
- [ ] Two-level filtering: scope (cheap) + document (per-item)
- [ ] Rate limiting via token bucket matching source API limits
- [ ] Webhook validation (if webhooks supported)
- [ ] Models injected via constructor, never imported directly
- [ ] Every query scoped by tenantId
- [ ] Error handling: per-document isolation, no silent catches
- [ ] Logging via `createLogger()`, not console.log
- [ ] Dockerfile COPY line added for package.json
- [ ] Registered in worker connector factory

---

## Self-Updating Mechanism

### When to Update This Skill

**1. After building a new connector:**

- Add connector-specific gotchas to the Debugging Runbook
- Add new anti-patterns discovered during development
- Update the research template if new questions emerged
- Add the connector to the package structure diagram

**2. After finding a connector bug:**

- Add to Debugging Runbook with symptom, root cause, and fix
- Add anti-pattern if the bug came from a common mistake
- Document the log patterns that helped diagnose it

**3. After migrating a connector:**

- Update Migration Guide with new lessons learned
- Add any platform adapter patterns that were missing
- Document incompatibilities between source patterns and platform patterns

**4. After external API changes:**

- Update the research questions if new concerns surfaced
- Document the API change and how it affected the connector
- Add to debugging runbook if the change caused failures

**5. After architecture changes:**

- Update Architecture Overview section
- Update package structure diagram
- Update reference document paths
- Increment version number

### Update Process

```bash
# 1. Read current skill
cat .claude/skills/search-ai-connectors.md

# 2. Make changes (add sections, update patterns)
# Edit file directly or use Edit tool

# 3. Increment version in header
# Patch: 1.0.0 → 1.0.1 (bug fixes, small additions)
# Minor: 1.0.0 → 1.1.0 (new sections, new connector patterns)
# Major: 1.0.0 → 2.0.0 (architecture changes, restructuring)

# 4. Add entry to Version History below

# 5. Commit
git commit -m "[ABLP-2] docs(search-ai): update search-ai-connectors skill with X"
```

### What to Extract to Other Skills

After major connector work, propagate key facts to related skills:

**To `search-ai-architect`:**

- Update the Connector checklist if new review criteria discovered
- Add connector-specific architecture decisions

**To `search-ai-development`:**

- Update the Connector & Crawler Workers table if new workers added
- Add new models to the MongoDB Data Model section

**To `CLAUDE.md`:**

- Update skills table description if skill scope changes

---

## Version History

- **1.0.0** (2026-03-11): Initial release
  - Architecture overview with 7 key patterns
  - Phase 1 Research: 11 research categories with 70+ questions
  - Phase 2 Scaffold: full package setup, class stubs, registration checklist
  - Migration Guide: 4-step process
  - Debugging Runbook: 7 failure scenarios with fix steps
  - Anti-patterns catalog: 14 entries
  - Architecture review checklist: 20 items
  - Self-updating mechanism

---

**End of Skill**

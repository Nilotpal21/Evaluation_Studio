---
name: search-ai-architect
description: Use when the user asks to "review", "check", "validate", or "audit" any code, design document, RFC, or architecture proposal related to apps/search-ai/, apps/search-ai-runtime/, packages/search-ai-internal/, packages/database/src/models/, or docs/searchai/. Also use when the user says "review this", "is this correct", "check for issues", or "architecture review". Provides structured review across ingestion, query pipeline, database, vector store, knowledge graph, connector, security, and performance domains.
---

# Search-AI Architect

Unified architecture reviewer for the Search-AI platform. Reviews both **design documents** and **code changes** against platform principles and domain-specific patterns.

> **Domain knowledge lives in `search-ai-development` skill.** This skill adds the review framework on top.
> **Query pipeline & agent integration knowledge lives in `search-ai-query-engineer` skill.** Use it for query pipeline, discovery API, KB-as-tool, and agent integration reviews.
>
> **Key references:** `docs/searchai/DATABASE-SCHEMA.md` (models, indexes, plugins), `docs/searchai/SERVICES-INVENTORY.md` (workers, routes, services), `docs/searchai/00-START-HERE.md` (navigation), `docs/searchai/design/QUERY-PIPELINE-DESIGN.md` (query pipeline + agent integration)

## Review Modes

### Mode 1: Design Review

**Input:** RFC, architecture doc, or design proposal

**Process:**

1. Read the design document fully
2. Identify affected domains (see Domain Detection below)
3. Cross-reference against existing codebase (`Grep`, `Read` the relevant code)
4. Apply domain checklists
5. Run adversarial questions
6. Output structured review

### Mode 2: Code Review

**Input:** Changed files or PR diff

**Process:**

1. Read changed files
2. Identify affected domains from file paths
3. Apply domain checklists
4. Check anti-patterns (see `search-ai-development` skill)
5. Output structured review

### Mode 3: Cross-Reference

**Input:** Design doc + implementation comparison

**Process:**

1. Read design doc
2. Read relevant implementation files
3. Identify gaps: documented but not implemented, implemented but not documented
4. Flag conflicts between design and code
5. Output gap analysis

---

## Domain Detection

Detect affected domains from file paths or document content:

| Domain             | File Patterns                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| Ingestion          | `workers/*-worker.ts`, `services/extraction/`, `services/progressive-summarization/`                    |
| Query Pipeline     | `search-ai-runtime/src/services/query/`, `services/rerank/`, `services/cache/`                          |
| Database           | `database/src/models/`, `database/src/mongo/plugins/`, `db/index.ts`                                    |
| Vector Store       | `vector-store/`, `embedding/`, `embedding-worker.ts`                                                    |
| Knowledge Graph    | `knowledge-graph/`, `kg-enrichment-worker.ts`, `taxonomy-setup-worker.ts`                               |
| Connector          | `connector-sync-worker.ts`, `connector-permission-crawl-*`, `crawler-*`, `services/connectors/`         |
| IdP Sync           | `azuread-*-worker.ts`, `okta-*-worker.ts`, `google-*-worker.ts`, `services/idp/`, `routes/idp-sync.ts`  |
| Auth & Permissions | `middleware/permission-filter*.ts`, `services/query/permission-filter*.ts`, `services/cache/group-*.ts` |
| Security           | Any file touching `tenantId`, `encryption`, `auth`, `credential`, `permission`                          |
| Performance        | Any file touching `cache`, `batch`, `concurrency`, `timeout`, `circuit-breaker`                         |

**Security and Performance are always checked** regardless of domain.

---

## Domain Checklists

### Ingestion Pipeline

- [ ] Worker follows creation pattern (getLazyModel, withTenantContext, status updates)
- [ ] Pipeline stage ordering preserved (no skipped stages)
- [ ] DocumentStatus transitions follow state machine
- [ ] Config-gated features check `getConfig()` before running
- [ ] LLM-gated features check `resolveIndexLLMConfig()` with graceful skip
- [ ] BullMQ job has `jobId` for deduplication and `attempts: 3` with backoff
- [ ] Queue closed in `finally` block after enqueue
- [ ] Error sets `DocumentStatus.ERROR` with descriptive `processingError`

### BullMQ Flows (Pipeline Orchestration)

**Safety checks (non-negotiable — BullMQ bugs):**

- [ ] Every child job has `failParentOnFailure: true` (parent waits forever without this)
- [ ] Every child job has `removeOnComplete` and `removeOnFail` (parent settings do NOT cascade)
- [ ] `FlowProducer.add()` result validated (silent failures during Redis READONLY — Issue #3851)
- [ ] `useWorkerThreads: true` NOT used (memory leak — Issue #2610, unresolved)
- [ ] Redis `maxmemory-policy: noeviction` in deployment requirements

**Design requirement checks (implementation approach is flexible):**

- [ ] `lockDuration` tuned per worker type (evidence: measured against P95 job duration, not hardcoded)
- [ ] Graceful degradation when flow creation fails (circuit breaker, retry, fallback, or other mechanism)
- [ ] Duplicate flow prevention mechanism exists (contentHash, jobId, Redis lock, or equivalent)
- [ ] Queue depth bounded by some backpressure mechanism (threshold configurable, not hardcoded)
- [ ] Graceful shutdown period sufficient for longest-running worker
- [ ] Event stream memory bounded (`streams.events.maxLen` or equivalent trimming)
- [ ] Pipeline definition separated from flow construction logic (no hardcoded flow trees)
- [ ] Job data minimized (IDs not full documents — reduce Redis memory)

**Backward compatibility checks:**

- [ ] Legacy pipeline (direct enqueue) still works when flows disabled or no PipelineDefinition exists
- [ ] Both legacy and flow jobs tracked in same JobExecution collection
- [ ] Existing worker code unchanged (no flow-specific logic in processors)
- [ ] API response includes `flowJobId` when using flows, omitted when legacy

**Observability checks:**

- [ ] Flow creation, completion, and failure emit metrics or log events
- [ ] JobExecution records include flow context (`pipelineId`, `pipelineVersion`, `flowJobId`)
- [ ] `waiting-children` queue depth monitored (stuck flow detection)
- [ ] Per-tenant rate limiting at application level (BullMQ limiter is global per-queue)

**Reference:** `docs/searchai/BULLMQ-FLOWS-PRODUCTION-GUIDE.md` — known issues, scaling, troubleshooting

### Query Pipeline

> For implementation details, use `search-ai-query-engineer` skill. Reference: `docs/searchai/design/QUERY-PIPELINE-DESIGN.md`

- [ ] Total latency budget stays under 500ms p95
- [ ] Permission filter runs as Stage 0 (security gate, fails closed)
- [ ] Preprocessing skipped for agent flows (`skipPreprocessing`)
- [ ] Vocabulary resolution uses DynamicVocabularyResolver (LLM) when configured
- [ ] Static VocabularyResolver used as fallback when no LLM
- [ ] All 4 query types supported (structured, semantic, hybrid, aggregation)
- [ ] HybridSearchBuilder uses `buildQueryFromResolution()` (no double LLM call)
- [ ] Reranker uses batched mode (85% API call reduction target)
- [ ] Circuit breaker protects external API calls (reranker, embedding)
- [ ] Results filtered by tenant before returning
- [ ] Permission filtering applied for user mode (X-Auth-Mode: user)
- [ ] Discovery API returns correct capabilities for KB state
- [ ] KB tools auto-registered via `registerSearchAITool()` on index creation
- [ ] SearchAIClient SDK used for all HTTP calls (no raw fetch)

### Database

- [ ] Uses `getLazyModel()` — never direct model imports
- [ ] All queries include `{ tenantId }` filter
- [ ] No `findById()` — use `findOne({ _id, tenantId })`
- [ ] No `.lean()` on encrypted fields (LLMCredential)
- [ ] Wrapped in `withTenantContext()` for Search-AI workers
- [ ] Indexes support query patterns (compound tenant-first indexes)
- [ ] Soft deletion uses `isDeleted`/`deletedAt` pattern (SearchDocument)
- [ ] TTL indexes for expiring data (messages, sessions)
- [ ] Schema changes consistent with `docs/searchai/DATABASE-SCHEMA.md`

### Vector Store

- [ ] Embedding dimensions match index configuration
- [ ] Batch size appropriate (8 for CPU BGE-M3, 32 for GPU)
- [ ] 120s timeout for embedding API calls
- [ ] Index routing through IndexRegistry (shared vs dedicated)
- [ ] Tenant-aware index naming (no cross-tenant vectors)
- [ ] Graceful degradation on vector store unavailability

### Knowledge Graph

- [ ] Entity extraction uses hybrid mode (regex + Compromise NLP)
- [ ] Neo4j queries include tenant filter
- [ ] Batch node/relationship creation (not individual inserts)
- [ ] Taxonomy setup is idempotent (re-runnable without duplicates)
- [ ] Co-occurrence analysis uses configurable thresholds

### Connector

> **Detailed patterns:** Use `search-ai-connectors` skill. Design docs: `docs/searchai/design/SHAREPOINT-CONNECTOR-COMPLETE-REFERENCE.md` (narrative) and `SHAREPOINT-CONNECTOR-DIAGRAMS.md` (diagrams).

- [ ] OAuth credentials stored encrypted (EndUserOAuthToken, AES pre-save hook)
- [ ] Token refresh with 5-min pre-expiry buffer via TokenManager
- [ ] Extends BaseSyncCoordinator template method (fetchDocuments, downloadDocument, crawlPermissionsBatch)
- [ ] Distributed lock acquired before sync (Redis SET NX PX, 1hr TTL)
- [ ] Incremental sync uses per-drive delta tokens (not full re-sync)
- [ ] Checkpoint saved every 100 docs, pause checked every 10 docs
- [ ] Streaming enumeration (async generator, not loading all items into memory)
- [ ] Deduplication via SHA256(documentId + modifiedAt) contentHash
- [ ] Soft-delete on delta removal (isDeleted=true, never hard delete)
- [ ] Permission crawl decoupled from sync (can fail independently)
- [ ] Two-level filtering: scope (cheap, skip sites/libraries) + document (per-item)
- [ ] Rate limiting via token bucket respects source API quotas
- [ ] Webhook validation (encrypted clientState verification)
- [ ] Models injected via constructor (dual-DB support), never imported directly
- [ ] Every query scoped by tenantId (findOne({\_id, tenantId}), never findById)

### IdP Sync Workers

- [ ] Microsoft Graph / Okta / Google API client with proper authentication
- [ ] Delta query support for incremental sync (store deltaToken in LLMCredential.metadata)
- [ ] Pagination handles 10k+ users/groups (use nextLink/cursor)
- [ ] Batch upsert to Neo4j (100 users per batch)
- [ ] User nodes include: tenantId, email, idpUserId, idpProvider, displayName
- [ ] Group nodes prefixed by provider: `azuread:`, `okta:`, `google:`
- [ ] MEMBER_OF relationships include source field
- [ ] Nested group support (recursive up to 20 levels)
- [ ] Sync errors are non-fatal (log + continue with remaining items)
- [ ] Group membership cache invalidated after successful sync
- [ ] Sync scheduled via BullMQ repeat job (daily at 12:00 AM UTC)
- [ ] Sync status tracked in LLMCredential.metadata (lastSync, errors)
- [ ] API timeouts set (120s for Microsoft Graph, Okta, Google Directory)
- [ ] Failed API calls don't break entire sync (Promise.allSettled pattern)

### Security (Always Checked)

- [ ] Every DB query includes `{ tenantId }` — no exceptions
- [ ] Redis/cache keys prefixed with `tenant:${tenantId}:`
- [ ] OpenSearch queries scoped to tenant's index
- [ ] No `findById()` — always `findOne({ _id, tenantId })`
- [ ] Encrypted fields accessed via full Mongoose documents (no `.lean()`)
- [ ] `ENCRYPTION_MASTER_KEY` required for credential access
- [ ] No secrets in code (use env vars or LLMCredential)
- [ ] SSRF protection on outbound HTTP (tool calls, webhooks)
- [ ] Cross-tenant access returns 404 not 403 (don't leak existence)
- [ ] Audit logging for sensitive operations (credential access, deletion)
- [ ] IdP tokens validated via JWKS (never trust unsigned tokens)
- [ ] JWKS cache has expiry (1-hour max) and size limit
- [ ] X-Auth-Mode defaults to public (opt-in user mode)
- [ ] User identity extracted from standard claims (email, sub, upn)
- [ ] Group membership cache keys scoped to tenant AND user
- [ ] No IdP tokens logged (PII + security risk)
- [ ] Platform auth (Layer 1) + end-user auth (Layer 2) both validated
- [ ] Failed IdP validation degrades to public mode (no 401 on bad token)

### Performance (Always Checked)

- [ ] Batch operations where possible (`$in`, bulk inserts)
- [ ] No N+1 query patterns
- [ ] Large payloads compressed before storage (async gzip)
- [ ] Connection pooling for external services
- [ ] Timeouts on all external calls (LLM: 120s, embedding: 120s, HTTP tools: 30s)
- [ ] Circuit breakers for unreliable external APIs
- [ ] Pagination for large result sets
- [ ] Queue `close()` called in `finally` blocks (prevents connection leaks)

---

## Design Review Questions

Ask these when reviewing architecture docs or RFCs:

### Adversarial

- What are the top 5 ways this design could fail in production?
- What happens when [critical dependency] is unavailable for 30 minutes?
- Can tenant A access tenant B's data through this path?
- What's the blast radius if this component corrupts data?

### Scalability

- Will this work at 10x current document volume? 100x?
- What's the storage cost at 1M documents? 10M?
- Does this introduce a single point of failure?
- Can this be horizontally scaled (multiple pods)?

### Operability

- How do we monitor this in production?
- How do we debug failures (trace events, logs)?
- Can we roll back without data loss?
- What's the migration path from current state?

### Cost

- What's the LLM cost per document? Per query?
- Are there cheaper alternatives that achieve 80% of the quality?
- Does this use expensive models where cheap ones would suffice?

### Consistency

- Does this conflict with existing architecture patterns?
- Are there existing abstractions this should reuse?
- Does this introduce a new pattern where an existing one works?

---

## Severity Framework

| Severity     | Meaning                                          | Action            |
| ------------ | ------------------------------------------------ | ----------------- |
| **CRITICAL** | Security vulnerability, data leak, data loss     | Block until fixed |
| **HIGH**     | Tenant isolation gap, silent failure, wrong data | Block until fixed |
| **MEDIUM**   | Missing error handling, perf concern, no tests   | Fix before merge  |
| **LOW**      | Style, naming, minor optimization, docs missing  | Fix or track      |
| **INFO**     | Suggestion, alternative approach, future concern | Optional          |

---

## Review Output Template

```markdown
## Architecture Review: [Title]

**Reviewer:** search-ai-architect
**Mode:** [Design Review | Code Review | Cross-Reference]
**Domains:** [Ingestion, Query Pipeline, Security, ...]

### Summary

[1-2 sentence overall assessment]

### Findings

#### CRITICAL

- [Finding with file:line reference]
- **Impact:** [What could go wrong]
- **Fix:** [How to resolve]

#### HIGH

- ...

#### MEDIUM

- ...

### Cross-Cutting Concerns

- **Tenant Isolation:** [Pass/Fail with details]
- **Performance:** [Concerns or pass]
- **Error Handling:** [Concerns or pass]

### Recommendation

[Approve | Approve with changes | Block]
```

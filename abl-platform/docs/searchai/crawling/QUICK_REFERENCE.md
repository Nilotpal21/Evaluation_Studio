# Crawler Quick Reference Card

**Last Updated**: 2026-03-03
**Branch**: `develop`

---

## 🚨 Critical Issues (MUST FIX FIRST)

| Issue                     | Impact             | File to Check                                           | Estimated |
| ------------------------- | ------------------ | ------------------------------------------------------- | --------- |
| **Chunking: 0 chunks**    | Search broken      | `apps/search-ai/src/workers/canonical-mapper-worker.ts` | 2-3 days  |
| **Content: 8% preserved** | 92% data lost      | `apps/search-ai/src/services/readability/`              | 3-4 days  |
| **Indexing: 0% success**  | Nothing searchable | `apps/search-ai/src/workers/embedding-worker.ts`        | 3-5 days  |

**Debug Commands**:

```bash
# Check worker status
curl http://localhost:3113/api/admin/queues

# Check BullMQ queues
redis-cli LLEN bull:content-processing:wait
redis-cli LLEN bull:embedding:wait

# View worker logs
cd apps/search-ai && pnpm dev | grep -i "chunk\|embed\|index"
```

---

## 📦 What's Deployed

### Services

| Service                | Port | Purpose                   | Status     |
| ---------------------- | ---- | ------------------------- | ---------- |
| **crawler-go-worker**  | -    | Go static crawler (Colly) | ✅ Built   |
| **crawler-mcp-server** | -    | MCP browser automation    | ✅ Built   |
| **search-ai**          | 3113 | Ingestion API + workers   | ✅ Running |
| **runtime**            | 3112 | Agent execution           | ✅ Running |

### API Endpoints

```bash
# Crawler API
POST   /api/crawl/batch              # Start crawl
GET    /api/crawl/status             # Check status
POST   /api/crawler/ingest           # Ingest results
GET    /api/admin/queues             # Queue monitoring
WS     /api/admin/progress/subscribe # Live progress
```

### Database Models (6 new)

```
✅ CrawlJob, CrawlHistory, CrawlAuditEvent
✅ CrawlPattern, TenantCrawlPolicy, UserCrawlPreference
```

---

## 🎯 Task Priorities (RFC-001)

### TIER 1: CRITICAL (Start Here) 🔴

- **#20** Fix chunking (2-3d) → Blocks search
- **#19** Fix content preservation (3-4d) → Blocks quality
- **#21** Fix indexing (3-5d) → Blocks search results

### TIER 2: HIGH 🟡

- **#28** Design strategy API (3-4d) → Better UX
- **#24** Sitemap extraction (1-2d) → Multi-page crawling
- **#25** URL expansion (1d) → Auto-discovery

### TIER 3: MEDIUM 🟢

- **#22** State transitions (2-3d) → Better UX
- **#13** Dashboard API (1-2d) → Monitoring
- **#15** Error tracking (2-3d) → Reliability

---

## 🧠 Autonomous Intelligence Status

### Completed (89%) ✅

- ✅ **Week 1**: Site Profiling (40h)
- ✅ **Week 2**: Decision Engine (32h)
- ✅ **Week 3**: Progressive Disclosure (40h)
- ✅ **Week 4**: Transparency Service Backend (28h)

### Pending ⏳

- ⏳ **Week 4**: Transparency UI (12h) - `apps/studio/src/components/crawler/DecisionTimeline.tsx`
- ⏳ **Week 5**: Learning & Adaptation (40h)
- ⏳ **Week 6**: Policies & Governance (40h)

**Test Status**: 423/429 passing (98.6%)

---

## 📂 Key Files

### Infrastructure

```
apps/crawler-go-worker/cmd/worker/main.go         # Go crawler entry
apps/crawler-mcp-server/src/server.ts              # MCP server
apps/search-ai/src/routes/crawl.ts                 # Crawler API
apps/search-ai/src/workers/crawler-ingestion-worker.ts
```

### Autonomous Intelligence

```
packages/crawler/src/profiler/fast-profiler.ts     # Site detection
packages/crawler/src/decision/decision-engine.ts   # 5-level hierarchy
packages/crawler/src/disclosure/prompt-evaluator.ts
packages/crawler/src/transparency/transparency-service.ts
```

### Documentation

```
docs/rfcs/RFC-001-MASTER-TASK-LIST.md              # Complete roadmap
docs/searchai/crawling/RESUME.md                   # Autonomous Intelligence
CRAWLER-STATUS-SUMMARY.md                          # This summary (detailed)
```

---

## 🔧 Common Commands

### Development

```bash
# Build crawler packages
pnpm build --filter=@abl/crawler
pnpm build --filter=@agent-platform/search-ai

# Run tests
pnpm test --filter=@abl/crawler
pnpm test --filter=@agent-platform/search-ai

# Start services
pnpm --filter @agent-platform/search-ai dev
pnpm --filter @agent-platform/runtime dev
```

### Debugging

```bash
# Check crawler workers
curl http://localhost:3113/api/admin/queues

# Check crawl job status
curl http://localhost:3113/api/crawl/status?jobId=<ID>

# View Bull Board UI
open http://localhost:3113/admin/queues

# Check Redis queues
redis-cli KEYS "bull:*"
redis-cli LLEN bull:content-processing:wait

# View database
mongosh abl_platform --eval "db.crawlJobs.find().pretty()"
```

### Testing Crawler

```bash
# Test single URL
curl -X POST http://localhost:3113/api/crawl/batch \
  -H "Content-Type: application/json" \
  -d '{
    "urls": ["https://example.com"],
    "tenantId": "test-tenant",
    "indexId": "test-index",
    "sourceId": "test-source"
  }'

# Check results
curl http://localhost:3113/api/crawl/status?jobId=<JOB_ID>
```

---

## 🚀 Quick Start Paths

### Path A: Fix Search (2-3 weeks)

```bash
# 1. Investigate chunking
cd apps/search-ai/src/workers
code canonical-mapper-worker.ts

# 2. Test readability
cd apps/search-ai/src/services/readability
pnpm test

# 3. Check embedding worker
cd apps/search-ai/src/workers
code embedding-worker.ts
```

### Path B: Complete UI (2-3 days)

```bash
# 1. Create component
cd apps/studio/src/components/crawler
touch DecisionTimeline.tsx

# 2. Review design system
cat apps/studio/src/app/globals.css

# 3. Test WebSocket
cd packages/crawler
pnpm test websocket-feed.test.ts
```

### Path C: Multi-Page Crawl (1 week)

```bash
# 1. Design strategy API
code docs/rfcs/RFC-001-ISSUE-7-CRAWL-STRATEGY-UX.md

# 2. Implement sitemap extraction
cd packages/crawler/src/profiler
code fast-profiler.ts

# 3. Update API
cd apps/search-ai/src/routes
code crawl.ts
```

---

## 📊 Success Metrics

### Current State

| Metric            | Current | Target | Status |
| ----------------- | ------- | ------ | ------ |
| Pages Discovered  | 1       | 5+     | ❌     |
| Content Preserved | 8%      | 90%+   | ❌     |
| Chunks Created    | 0       | 10-50  | ❌     |
| Indexed Success   | 0%      | 85%+   | ❌     |
| Processing Time   | 300s    | <60s   | ❌     |

### After Fixes (Expected)

| Metric               | Expected |
| -------------------- | -------- |
| Content Preservation | 90%+     |
| Chunks per Page      | 10-50    |
| Indexing Success     | 85%+     |
| Processing Time      | <60s     |
| Multi-Page Discovery | 5+ pages |

---

## 🆘 Help

### Documentation

- **Complete Status**: `CRAWLER-STATUS-SUMMARY.md`
- **Task List**: `docs/rfcs/RFC-001-MASTER-TASK-LIST.md`
- **Resume Guide**: `docs/searchai/crawling/RESUME.md`
- **Architecture**: `docs/searchai/crawling/AUTONOMOUS_INTELLIGENCE_DESIGN.md`

### Key Contacts

- **RFC-001 Issues**: See `docs/rfcs/RFC-001-MASTER-TASK-LIST.md`
- **Autonomous Intelligence**: See `docs/searchai/crawling/RESUME.md`
- **Test Failures**: `packages/crawler/src/__tests__/` (6 pattern-store tests failing)

---

**Next Step**: Choose Path A (Fix Search), B (Complete UI), or C (Multi-Page) and start! 🎉

# SearchAI Document Pipeline E2E Tests

Comprehensive end-to-end tests for the SearchAI document processing pipeline using Playwright.

## Test Coverage

Tests the complete document lifecycle:

1. **File Upload** — PDF, Markdown, Text files via API and UI
2. **Extraction** — Docling service extracts text and metadata
3. **Chunking** — Text split into semantic chunks
4. **Embedding** — BGE-M3 generates 1024-dim vectors
5. **Indexing** — OpenSearch stores documents for search
6. **Search** — Query documents and retrieve results

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Playwright Test Suite                     │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
  ┌──────────┐         ┌──────────┐         ┌──────────┐
  │ API Tests│         │ UI Tests │         │ DB Tests │
  └──────────┘         └──────────┘         └──────────┘
        │                     │                     │
        ▼                     ▼                     ▼
  ┌──────────────────────────────────────────────────────┐
  │           Helper Utilities (Zero Assumptions)        │
  ├──────────────────────────────────────────────────────┤
  │ • api-client.ts      — Authenticated HTTP requests   │
  │ • db-helpers.ts      — MongoDB verification          │
  │ • file-helpers.ts    — Test file generation          │
  │ • service-health.ts  — Service health checks         │
  └──────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
  ┌──────────────────────────────────────────────────────┐
  │                  Real Services                        │
  ├──────────────────────────────────────────────────────┤
  │ • SearchAI (3113)    • Docling (8085)                │
  │ • Runtime (3112)     • BGE-M3 (8006)                 │
  │ • Studio (5173)      • MongoDB (27018)               │
  │ • SearchAI-RT (3114) • OpenSearch (9200)             │
  └──────────────────────────────────────────────────────┘
```

## Prerequisites

### 1. Start Docker Services

```bash
docker compose up -d
```

Verify all containers are running:

```bash
docker ps | grep abl-
```

Expected services:

- `abl-docling-service` (port 8085) — File extraction
- `abl-bge-m3` (port 8006) — Embeddings
- `abl-mongo` (port 27018) — Database
- `abl-opensearch` (port 9200) — Search index
- `abl-redis` (port 6380) — Job queue

### 2. Start PM2 Services

```bash
SKIP_SETUP=1 npx pm2 start ecosystem.config.js --only abl-runtime,abl-studio,abl-search-ai,abl-search-ai-runtime
```

Verify services are running:

```bash
npx pm2 list
```

### 3. Verify Service Health

```bash
curl http://localhost:3112/health   # Runtime
curl http://localhost:3113/health   # SearchAI
curl http://localhost:3114/health   # SearchAI Runtime
curl http://localhost:5173          # Studio
curl http://localhost:8085/health   # Docling
curl http://localhost:8006/health   # BGE-M3
```

All should return `200 OK` or healthy status.

## Running Tests

### Run All Tests

```bash
cd apps/studio
npx playwright test e2e/searchai/document-pipeline.spec.ts
```

### Run Specific Test

```bash
npx playwright test e2e/searchai/document-pipeline.spec.ts -g "should upload a single PDF"
```

### Run with UI (Headed Mode)

```bash
npx playwright test e2e/searchai/document-pipeline.spec.ts --headed
```

### Debug Mode

```bash
npx playwright test e2e/searchai/document-pipeline.spec.ts --debug
```

### View Test Report

```bash
npx playwright show-report
```

## Test Execution Flow

```
┌─────────────────────────────────────────────────────────────┐
│ 1. beforeAll: Setup                                          │
│    • Check all services healthy                              │
│    • Authenticate (dev-login)                                │
│    • Create test KB and index                                │
│    • Connect to MongoDB                                      │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. Test Execution (Serial)                                   │
│                                                              │
│    ┌─────────────────────────────────────────────────────┐ │
│    │ Test 1: Upload PDF                                   │ │
│    │  • Generate test PDF                                 │ │
│    │  • Upload via API                                    │ │
│    │  • Verify DB record created                          │ │
│    │  • Wait for status: ready                            │ │
│    │  • Verify extraction, chunks, embeddings             │ │
│    └─────────────────────────────────────────────────────┘ │
│                              │                               │
│    ┌─────────────────────────────────────────────────────┐ │
│    │ Test 2: Upload Markdown                              │ │
│    │  • Generate markdown with code blocks                │ │
│    │  • Upload and process                                │ │
│    │  • Verify structure preserved                        │ │
│    └─────────────────────────────────────────────────────┘ │
│                              │                               │
│    ┌─────────────────────────────────────────────────────┐ │
│    │ Test 3: Upload Text                                  │ │
│    │  • Generate plain text                               │ │
│    │  • Upload and verify                                 │ │
│    └─────────────────────────────────────────────────────┘ │
│                              │                               │
│    ┌─────────────────────────────────────────────────────┐ │
│    │ Test 4-10: Search, Delete, UI, Errors, Security     │ │
│    └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. afterAll: Cleanup                                         │
│    • Delete test KB (cascade)                                │
│    • Disconnect MongoDB                                      │
│    • Clean up test files                                     │
└─────────────────────────────────────────────────────────────┘
```

## Test Data

Generated in `/tmp/searchai-test-data/` during execution:

- `machine-learning-basics.pdf` — Technical document with multi-page content
- `code-examples.md` — Markdown with code blocks
- `simple.txt` — Plain text file
- `*.png` — Screenshots on failure

All test data is cleaned up after test completion.

## Zero Assumptions Policy

These tests follow strict verification rules:

1. ✅ **Every API response is inspected** — No trusting `{success: true}` blindly
2. ✅ **DB state verified after writes** — MongoDB queries confirm API operations
3. ✅ **Logs checked after failures** — PM2 logs examined for root causes
4. ✅ **No mocks for codebase components** — Real services only
5. ✅ **Bugs fixed immediately** — No deferring issues to "later"

## Environment Variables

Optional overrides (defaults shown):

```bash
export STUDIO_URL=http://localhost:5173
export SEARCHAI_URL=http://localhost:3113
export RUNTIME_URL=http://localhost:3112
export MONGODB_URI=mongodb://localhost:27018
export TEST_DATA_DIR=/tmp/searchai-test-data
```

## Common Issues

### Services Not Running

**Error:** `Services not ready: Runtime, Studio, SearchAI`

**Fix:**

```bash
# Start PM2 services
SKIP_SETUP=1 npx pm2 start ecosystem.config.js

# Verify
npx pm2 list
```

### Docling Service Unhealthy

**Error:** `Docling service unhealthy: Connection refused`

**Fix:**

```bash
# Check Docker logs
docker logs abl-docling-service

# Restart if needed
docker restart abl-docling-service
```

### BGE-M3 Slow First Request

**Symptom:** First embedding takes 5-10 seconds

**Explanation:** Model is loaded on first request (expected behavior)

**Fix:** Wait for initial warmup, subsequent requests are fast

### MongoDB Connection Refused

**Error:** `Connection refused: mongodb://localhost:27018`

**Fix:**

```bash
# Check MongoDB is running
docker ps | grep abl-mongo

# Check port mapping
docker port abl-mongo

# Verify connection
mongosh mongodb://localhost:27018/abl_platform
```

### Test Timeout

**Error:** `Timeout waiting for document status: ready`

**Causes:**

1. Worker not processing queue
2. Docling/BGE-M3 service down
3. BullMQ redis connection issue

**Debug:**

```bash
# Check PM2 logs
npx pm2 logs abl-search-ai --lines 50

# Check Redis
redis-cli -p 6380 ping

# Check job queue
redis-cli -p 6380 keys "bull:*"
```

## Debugging Tips

### View Real-Time Logs

```bash
# SearchAI service (ingestion)
npx pm2 logs abl-search-ai --lines 100 --nostream

# SearchAI Runtime (query)
npx pm2 logs abl-search-ai-runtime --lines 100

# Runtime (auth, projects)
npx pm2 logs abl-runtime --lines 100
```

### Inspect MongoDB State

```bash
mongosh mongodb://localhost:27018/abl_platform --eval "
  const indexId = 'YOUR_INDEX_ID';
  print('=== Documents ===');
  db.search_documents.find({indexId}).forEach(d => printjson(d));
  print('=== Chunks ===');
  db.search_chunks.find({indexId}).limit(5).forEach(c => printjson(c));
"
```

### Check OpenSearch Index

```bash
# List indices
curl -s http://localhost:9200/_cat/indices?v

# Query documents
curl -s http://localhost:9200/searchai-*/_search?pretty
```

### Screenshot on Failure

Failures automatically capture screenshots to:

```
/tmp/searchai-test-data/failure-<test-name>.png
```

## CI/CD Integration

For continuous integration:

```yaml
# .github/workflows/searchai-e2e.yml
name: SearchAI E2E Tests

on: [push, pull_request]

jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v3

      - name: Install dependencies
        run: pnpm install

      - name: Start Docker services
        run: docker compose up -d

      - name: Start PM2 services
        run: SKIP_SETUP=1 npx pm2 start ecosystem.config.js

      - name: Run E2E tests
        run: |
          cd apps/studio
          npx playwright test e2e/searchai/document-pipeline.spec.ts

      - name: Upload test report
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: playwright-report
          path: apps/studio/playwright-report/
```

## Adding New Tests

1. **Create test file** in `apps/studio/e2e/searchai/`
2. **Import helpers** from `./helpers/`
3. **Use shared setup** from `beforeAll` in main spec
4. **Follow zero-assumptions** — verify everything
5. **Update docs/testing/searchai-document-pipeline.md** after execution

## Related Documentation

- [Feature Test Guide](../../../docs/testing/searchai-document-pipeline.md) — Living test document
- [Testing Toolkit](../../../docs/skills/testing-toolkit.md) — Testing standards
- [SearchAI Architecture](../../../docs/architecture/searchai.md) — System design
- [Playwright Docs](https://playwright.dev/) — Official reference

## Support

For issues or questions:

1. Check logs: `npx pm2 logs abl-search-ai`
2. Verify services: `curl http://localhost:3113/health`
3. Read failure screenshots: `/tmp/searchai-test-data/*.png`
4. Review [Feature Test Guide](../../../docs/testing/searchai-document-pipeline.md)

# Unit/Integration Test Split Design

**Date:** 2026-03-02
**Status:** Approved

## Problem

The pre-push hook runs `pnpm turbo test:fast --filter="...[origin/develop]"`. In four packages (`apps/studio`, `apps/search-ai`, `apps/multimodal-service`, `apps/search-ai-runtime`), `test:fast` runs `vitest run` with no config — meaning it runs **all tests** including those requiring MongoDB, Redis, file servers, and ClamAV. This causes:

- Pre-push hangs for 40+ minutes
- 14 test failures on developer machines lacking services
- CI (`ci-build.yaml`) currently has `skip_build_test: 'true'` by default, so tests aren't running in CI at all

## Design

### Approach: Two-tier split (Option A)

Follow the pattern already established in `apps/runtime`:

- `test:fast` → unit-only tests, no external service dependencies, fast (< 60s per package)
- `test` → full suite including infra-dependent tests, runs in CI with services available

### Package Changes (4 packages)

For each of `apps/studio`, `apps/search-ai`, `apps/multimodal-service`, `apps/search-ai-runtime`:

1. **Add `vitest.unit.config.ts`** — excludes infra-dependent tests, uses `pool: 'threads'` for speed
2. **Update `test:fast` in `package.json`** — point to `vitest.unit.config.ts` instead of bare `vitest run`
3. **Existing `vitest.config.ts`** stays unchanged — used by the `test` script (full suite)

Infra boundary per package:

- **studio**: tests using `MongoMemoryServer`, real HTTP routes, MongoDB-backed API routes
- **search-ai**: tests using real MongoDB, Redis, BullMQ workers, external APIs, e2e tests
- **multimodal-service**: file server tests, ClamAV scanner tests, S3 integration tests
- **search-ai-runtime**: tests requiring MongoDB or OpenSearch connections

### CI Pipeline Changes (`ci-build.yaml`)

`skip_build_test` default remains `'true'` (manually triggered). When enabled:

1. **Add Background service steps** before build/test:
   - MongoDB 7: `mongo:7` with `--replSet rs0` init, port 27017
   - Redis 7: `redis:7`, port 6379

2. **Split the existing build+test command** into two sequential steps:
   - Step 1: `pnpm install --frozen-lockfile && pnpm turbo build test:fast --concurrency=4`
   - Step 2: `pnpm turbo test --filter=./apps/studio --filter=./apps/search-ai --filter=./apps/multimodal-service --filter=./apps/search-ai-runtime --concurrency=2`

   ClickHouse, OpenSearch, Neo4j not included in initial rollout — add as needed when those test failures surface in CI.

### turbo.json

No changes needed. `test` and `test:fast` are already declared tasks. `test:fast` depends only on `build`, not on sibling packages' tests.

## Success Criteria

- `git push origin develop` pre-push hook completes in < 3 minutes for typical changes
- No more infrastructure-related failures in the pre-push hook
- CI `Build and Test` stage (when enabled) runs the full suite including infra tests against real service containers
- The 14 previously-failing tests pass in CI with services available

---

## Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `test:fast` unit-only (no infra deps) in 4 packages so the pre-push hook never hangs, and wire MongoDB + Redis service containers into the CI pipeline so integration tests run there.

**Architecture:** Each of the 4 packages gets a `vitest.unit.config.ts` that excludes infra-dependent test files (same pattern as `apps/runtime/vitest.fast.config.ts`). `test:fast` is updated to use it. The CI pipeline gets Harness Background service steps for MongoDB and Redis, and its test command is split into `test:fast` (all packages) then `test` (infra packages only).

**Tech Stack:** Vitest 4, pnpm workspaces, Turbo, Harness CI YAML, MongoDB 7, Redis 7

**Reference:** See `apps/runtime/vitest.fast.config.ts` for the established pattern. See `.harness/pipelines/ci-build.yaml` for the CI structure.

---

### Task 1: Add `vitest.unit.config.ts` to `apps/multimodal-service`

**Context:** `test:fast` currently runs `vitest run` with no config — all 21 test files run including ClamAV scanner and file server tests that require a real ClamAV daemon and HTTP server.

**Infra-dependent tests to exclude:**

- `src/__tests__/attachment-routes.test.ts` — supertest HTTP server
- `src/__tests__/attachment-rate-limit.test.ts` — supertest HTTP server
- `src/__tests__/multimodal-service.test.ts` — ClamAV scanner
- `src/jobs/__tests__/scan-job.test.ts` — ClamAV scanner
- `src/jobs/__tests__/validate-job.test.ts` — file I/O + scanner chain
- `src/jobs/__tests__/process-job.test.ts` — file processing pipeline
- `src/jobs/__tests__/index-job.test.ts` — full job pipeline
- `src/processing/__tests__/document-parser-tika.test.ts` — Tika HTTP service
- `src/security/__tests__/clamav-scanner.test.ts` — ClamAV TCP socket
- `src/services/__tests__/attachment-search-producer.test.ts` — BullMQ + Redis

**Files:**

- Create: `apps/multimodal-service/vitest.unit.config.ts`
- Modify: `apps/multimodal-service/package.json`

**Step 1: Create `vitest.unit.config.ts`**

```typescript
/**
 * Vitest unit tier — pure unit tests only, no external service dependencies.
 *
 * Excludes tests requiring: ClamAV daemon, Tika HTTP service, BullMQ/Redis,
 * real file servers, or HTTP supertest app lifecycle.
 *
 * Run with: pnpm test:fast
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      'dist/**',
      'node_modules/**',

      // ── HTTP server / supertest ───────────────────────────────────────
      'src/__tests__/attachment-routes.test.ts',
      'src/__tests__/attachment-rate-limit.test.ts',

      // ── ClamAV / scanner (requires live daemon) ───────────────────────
      'src/__tests__/multimodal-service.test.ts',
      'src/jobs/__tests__/scan-job.test.ts',
      'src/security/__tests__/clamav-scanner.test.ts',

      // ── Full job pipeline (file I/O chain + scanner) ──────────────────
      'src/jobs/__tests__/validate-job.test.ts',
      'src/jobs/__tests__/process-job.test.ts',
      'src/jobs/__tests__/index-job.test.ts',

      // ── Tika HTTP service ─────────────────────────────────────────────
      'src/processing/__tests__/document-parser-tika.test.ts',

      // ── BullMQ / Redis ────────────────────────────────────────────────
      'src/services/__tests__/attachment-search-producer.test.ts',
    ],
    pool: 'threads',
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
```

**Step 2: Update `test:fast` in `package.json`**

In `apps/multimodal-service/package.json`, change:

```json
"test:fast": "vitest run"
```

to:

```json
"test:fast": "vitest run --config vitest.unit.config.ts"
```

**Step 3: Verify unit tests pass**

```bash
pnpm --filter @agent-platform/multimodal-service test:fast
```

Expected: all tests pass, no ClamAV/scanner/route tests appear.

**Step 4: Commit**

```bash
git add apps/multimodal-service/vitest.unit.config.ts apps/multimodal-service/package.json
git commit -m "[ABLP-2] fix(multimodal-service): add vitest.unit.config.ts, exclude infra tests from test:fast"
```

---

### Task 2: Add `vitest.unit.config.ts` to `apps/search-ai`

**Context:** `test:fast` runs all 43+ test files including MongoDB, Redis/BullMQ worker tests, supertest routes, and full e2e tests.

**Infra-dependent tests to exclude:**

- `src/__tests__/e2e/**` — full e2e requiring all services
- `src/__tests__/integration/**` — permission system integration
- `src/__tests__/routes/**` — supertest HTTP routes
- `src/__tests__/*-integration.test.ts` — integration tests (MongoDB + workers)
- `src/__tests__/*-e2e.test.ts` — e2e tests
- `src/__tests__/connector-permission-crawl-worker.test.ts` — BullMQ worker
- `src/__tests__/connector-sync-worker.test.ts` — BullMQ worker
- `src/__tests__/document-permissions-api.test.ts` — supertest + MongoDB
- `src/__tests__/llm-config-api.test.ts` — supertest + MongoDB
- `src/__tests__/search-ai-workers.test.ts` — BullMQ workers
- `src/__tests__/structured-data/ingest-api.test.ts` — HTTP + ClickHouse
- `src/__tests__/visual-enrichment-integration.test.ts` — MongoDB + workers
- `src/__tests__/kg-enrichment-integration.test.ts` — MongoDB + Neo4j
- `src/scheduler/__tests__/connector-delta-sync.test.ts` — MongoDB + scheduler
- `src/services/vision/__tests__/vision-service.test.ts` — external vision API

**Files:**

- Create: `apps/search-ai/vitest.unit.config.ts`
- Modify: `apps/search-ai/package.json`

**Step 1: Create `vitest.unit.config.ts`**

```typescript
/**
 * Vitest unit tier — pure unit tests only, no external service dependencies.
 *
 * Excludes tests requiring: MongoDB, Redis/BullMQ, OpenSearch, Neo4j,
 * ClickHouse, HTTP supertest, or external APIs.
 *
 * Run with: pnpm test:fast
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      'dist/**',
      'node_modules/**',

      // ── E2E / integration (full service stack) ────────────────────────
      'src/__tests__/e2e/**',
      'src/__tests__/integration/**',
      'src/__tests__/*e2e*.test.ts',
      'src/__tests__/*-integration.test.ts',

      // ── HTTP route tests (supertest + MongoDB) ────────────────────────
      'src/__tests__/routes/**',
      'src/__tests__/document-permissions-api.test.ts',
      'src/__tests__/llm-config-api.test.ts',
      'src/__tests__/structured-data/ingest-api.test.ts',

      // ── BullMQ worker tests (Redis required) ──────────────────────────
      'src/__tests__/connector-permission-crawl-worker.test.ts',
      'src/__tests__/connector-sync-worker.test.ts',
      'src/__tests__/search-ai-workers.test.ts',
      'src/__tests__/permission-recrawl-worker.test.ts',
      'src/__tests__/permission-recrawl-scheduler.test.ts',
      'src/__tests__/structured-data/structured-data-ingestion-worker.test.ts',
      'src/scheduler/__tests__/**',

      // ── MongoDB + external service tests ──────────────────────────────
      'src/__tests__/visual-enrichment-integration.test.ts',
      'src/__tests__/kg-enrichment-integration.test.ts',
      'src/__tests__/multimodal.test.ts',
      'src/services/vision/__tests__/vision-service.test.ts',
    ],
    pool: 'threads',
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
```

**Step 2: Update `test:fast` in `package.json`**

In `apps/search-ai/package.json`, change:

```json
"test:fast": "vitest run"
```

to:

```json
"test:fast": "vitest run --config vitest.unit.config.ts"
```

**Step 3: Verify unit tests pass**

```bash
pnpm --filter @agent-platform/search-ai test:fast
```

Expected: passes cleanly, no MongoDB/Redis/worker tests in output.

**Step 4: Commit**

```bash
git add apps/search-ai/vitest.unit.config.ts apps/search-ai/package.json
git commit -m "[ABLP-2] fix(search-ai): add vitest.unit.config.ts, exclude infra tests from test:fast"
```

---

### Task 3: Add `vitest.unit.config.ts` to `apps/search-ai-runtime`

**Context:** 8 test files, 3 require MongoDB or OpenSearch.

**Infra-dependent tests to exclude:**

- `src/__tests__/query-pipeline.test.ts` — MongoDB + OpenSearch
- `src/__tests__/search-ai-runtime-e2e.test.ts` — full service stack e2e
- `src/services/preprocessing/__tests__/preprocessing-client.test.ts` — HTTP preprocessing service
- `src/services/rerank/__tests__/batch-processor.test.ts` — check if needs infra
- `src/services/rerank/__tests__/batch-queue.test.ts` — check if needs infra

**Files:**

- Create: `apps/search-ai-runtime/vitest.unit.config.ts`
- Modify: `apps/search-ai-runtime/package.json`

**Step 1: Check rerank tests for infra deps**

```bash
grep -l "MongoMemoryServer\|mongodb\|redis\|IORedis\|OpenSearch\|supertest" \
  apps/search-ai-runtime/src/services/rerank/__tests__/*.test.ts 2>/dev/null
```

If they have no infra deps, do NOT exclude them.

**Step 2: Create `vitest.unit.config.ts`**

```typescript
/**
 * Vitest unit tier — pure unit tests only, no external service dependencies.
 *
 * Excludes tests requiring: MongoDB, OpenSearch, or external HTTP services.
 *
 * Run with: pnpm test:fast
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      'dist/**',
      'node_modules/**',

      // ── E2E (full service stack) ──────────────────────────────────────
      'src/__tests__/search-ai-runtime-e2e.test.ts',

      // ── MongoDB + OpenSearch dependent ───────────────────────────────
      'src/__tests__/query-pipeline.test.ts',

      // ── External HTTP service ─────────────────────────────────────────
      'src/services/preprocessing/__tests__/preprocessing-client.test.ts',
    ],
    pool: 'threads',
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
```

**Step 3: Update `test:fast` in `package.json`**

In `apps/search-ai-runtime/package.json`, change:

```json
"test:fast": "vitest run"
```

to:

```json
"test:fast": "vitest run --config vitest.unit.config.ts"
```

**Step 4: Verify**

```bash
pnpm --filter @agent-platform/search-ai-runtime test:fast
```

Expected: passes, only 4-5 unit test files run.

**Step 5: Commit**

```bash
git add apps/search-ai-runtime/vitest.unit.config.ts apps/search-ai-runtime/package.json
git commit -m "[ABLP-2] fix(search-ai-runtime): add vitest.unit.config.ts, exclude infra tests from test:fast"
```

---

### Task 4: Add `vitest.unit.config.ts` to `apps/studio`

**Context:** Studio has 67 test files. Most are pure React component / store / hook tests with `happy-dom`. The infra-dependent ones use MongoDB-backed API routes via supertest.

**Step 1: Find studio infra-dependent tests**

```bash
grep -rl "MongoMemoryServer\|supertest\|createServer\|app.listen\|request(app)\|mongoose.connect" \
  apps/studio/src/__tests__/ 2>/dev/null | sort
```

**Step 2: Create `vitest.unit.config.ts`**

Based on the audit result from Step 1, create `apps/studio/vitest.unit.config.ts`:

```typescript
/**
 * Vitest unit tier — pure unit tests only, no external service dependencies.
 *
 * Excludes API route tests that require a running MongoDB instance.
 * All React component, store, and hook tests are included.
 *
 * Run with: pnpm test:fast
 */
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    exclude: [
      'dist/**',
      'node_modules/**',
      '.next/**',
      'e2e/**',
      // Add MongoDB/supertest-dependent tests discovered in Step 1
      // e.g. 'src/__tests__/api-deployment-routes.test.ts',
    ],
    environment: 'happy-dom',
    setupFiles: ['./src/__tests__/setup.tsx'],
    css: false,
    pool: 'threads',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
```

**Step 3: Update `test:fast` in `package.json`**

In `apps/studio/package.json`, change:

```json
"test:fast": "vitest run"
```

to:

```json
"test:fast": "vitest run --config vitest.unit.config.ts"
```

**Step 4: Verify**

```bash
pnpm --filter @agent-platform/studio test:fast
```

Expected: completes in under 2 minutes, no MongoDB connection errors.

**Step 5: Commit**

```bash
git add apps/studio/vitest.unit.config.ts apps/studio/package.json
git commit -m "[ABLP-2] fix(studio): add vitest.unit.config.ts, exclude infra tests from test:fast"
```

---

### Task 5: Update CI pipeline to add services and split test command

**Context:** The `build_test` stage in `.harness/pipelines/ci-build.yaml` currently runs `pnpm turbo build test --concurrency=4` with no service containers. We need:

1. MongoDB 7 and Redis 7 as Background service steps
2. Split test command: `test:fast` for all packages first, then `test` for infra packages

**Files:**

- Modify: `.harness/pipelines/ci-build.yaml` (lines 106–131)

**Step 1: Add Background services and split test step**

Replace the `execution:` block (lines 106–131) with:

```yaml
serviceDependencies:
  - identifier: mongo
    name: MongoDB
    type: Service
    spec:
      connectorRef: Docker
      image: mongo:7
      envVariables:
        MONGO_INITDB_DATABASE: abl_platform
      portBindings:
        '27017': '27017'
      entrypoint:
        - /bin/bash
        - -c
        - |
          mongod --replSet rs0 --bind_ip_all &
          sleep 3
          mongosh --eval "rs.initiate({_id:'rs0',members:[{_id:0,host:'localhost:27017'}]})" || true
          wait
  - identifier: redis
    name: Redis
    type: Service
    spec:
      connectorRef: Docker
      image: redis:7
      portBindings:
        '6379': '6379'
execution:
  steps:
    - step:
        type: Run
        name: Install and Build
        identifier: install_build
        spec:
          connectorRef: Docker
          image: node:22-bookworm
          shell: Sh
          command: |
            corepack enable
            pnpm install --frozen-lockfile
            pnpm turbo build --concurrency=4
          envVariables:
            TURBO_TELEMETRY_DISABLED: '1'
            NODE_OPTIONS: '--max-old-space-size=6144'
          resources:
            limits:
              memory: 8Gi
              cpu: '4'
    - step:
        type: Run
        name: Unit Tests (all packages)
        identifier: test_unit
        spec:
          connectorRef: Docker
          image: node:22-bookworm
          shell: Sh
          command: |
            pnpm turbo test:fast --concurrency=4
          envVariables:
            TURBO_TELEMETRY_DISABLED: '1'
            NODE_OPTIONS: '--max-old-space-size=6144'
          resources:
            limits:
              memory: 8Gi
              cpu: '4'
          reports:
            type: JUnit
            spec:
              paths:
                - '**/junit-report.xml'
    - step:
        type: Run
        name: Integration Tests (infra packages)
        identifier: test_integration
        spec:
          connectorRef: Docker
          image: node:22-bookworm
          shell: Sh
          command: |
            pnpm turbo test \
              --filter=./apps/studio \
              --filter=./apps/search-ai \
              --filter=./apps/multimodal-service \
              --filter=./apps/search-ai-runtime \
              --concurrency=2
          envVariables:
            TURBO_TELEMETRY_DISABLED: '1'
            NODE_OPTIONS: '--max-old-space-size=6144'
            MONGODB_URL: 'mongodb://localhost:27017/abl_platform?directConnection=true&replicaSet=rs0'
            REDIS_URL: 'redis://localhost:6379'
          resources:
            limits:
              memory: 8Gi
              cpu: '4'
          reports:
            type: JUnit
            spec:
              paths:
                - '**/junit-report.xml'
```

**Step 2: Verify YAML is valid**

```bash
# Check for YAML syntax errors
python3 -c "import yaml; yaml.safe_load(open('.harness/pipelines/ci-build.yaml'))" && echo "YAML valid"
```

Expected: `YAML valid`

**Step 3: Commit**

```bash
git add .harness/pipelines/ci-build.yaml
git commit -m "[ABLP-2] fix(ci): add MongoDB+Redis service containers, split test:fast and test:integration steps"
```

---

### Task 6: End-to-end verification

**Step 1: Run test:fast across all changed packages**

```bash
pnpm turbo test:fast --filter=./apps/studio --filter=./apps/search-ai --filter=./apps/multimodal-service --filter=./apps/search-ai-runtime
```

Expected: all pass, no infra errors, completes in under 3 minutes total.

**Step 2: Simulate pre-push (dry run)**

```bash
REMOTE_REF=$(git rev-parse origin/develop)
pnpm turbo test:fast --filter="...[$REMOTE_REF]" --dry-run 2>&1 | grep "Tasks to run" -A 20
```

Expected: only unit test tasks listed, no hanging on infra tests.

**Step 3: Push**

```bash
git push origin develop
```

Expected: pre-push hook completes in under 3 minutes.

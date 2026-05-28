# agents.md — apps / multimodal-service

Agent learning journal for this package. Append-only log of architectural decisions, patterns, gotchas, and insights discovered during SDLC work.

Agents MUST read this file before modifying code in this package. Agents MUST append learnings after completing work.

---

<!-- Append new entries below this line. Format:
## <DATE> — <Feature/Context>
**Category**: architecture | testing | pattern | gotcha | process
**Learning**: <what was learned — specific and actionable>
**Files**: <key files involved>
**Impact**: <how this affects future work in this package>
-->

## 2026-03-23 — Logging Migration (attachments-gap-closure Phase 1)

**Category**: pattern | gotcha

**Learning**:

- All production files now use `createLogger('module-name')` from `@abl/compiler/platform`. Zero `console.*` calls remain.
- Logger signature is `log.error('message', { contextObj })` — NOT pino-style `log.error({ ctx }, 'msg')`. Verify at `packages/compiler/src/platform/logger.ts`.
- Test files that assert on log calls must use `vi.hoisted()` to declare mock functions BEFORE `vi.mock()` hoists. Plain `const mockFn = vi.fn()` causes temporal dead zone errors because vitest hoists `vi.mock()` above all `const` declarations.
- Standard test mock pattern:
  ```typescript
  const { mockLogError, mockLogWarn, mockLogInfo, mockLogDebug } = vi.hoisted(() => ({
    mockLogError: vi.fn(),
    mockLogWarn: vi.fn(),
    mockLogInfo: vi.fn(),
    mockLogDebug: vi.fn(),
  }));
  vi.mock('@abl/compiler/platform', () => ({
    createLogger: () => ({
      error: mockLogError,
      warn: mockLogWarn,
      info: mockLogInfo,
      debug: mockLogDebug,
    }),
  }));
  ```
- Package name for pnpm filter is `@agent-platform/multimodal-service` (not `multimodal-service`).
- Admin routes are mounted at `/admin` via `createAdminRouter(configService)`. TenantConfigService is stateless (no constructor deps).
- Route mount order in `server.ts`: attachment routes -> admin routes -> error handlers. The 404 handler must be last.

**Files**: All 15 production .ts files in src/, 3 test files in `__tests__/`

**Impact**: Any new production files in this package must use `createLogger`, not `console.*`. Any new test files asserting on log output should follow the `vi.hoisted()` pattern above.

## 2026-03-27 — PII Pipeline Integration Test Refactoring (vi.mock Removal)

**Category**: testing
**Learning**: `pii-pipeline-integration.test.ts` was rewritten to use real MongoDB (MongoMemoryServer) instead of `vi.mock('@agent-platform/database')`. The test seeds real `Attachment` documents, runs the process worker, then queries the DB to verify `hasPII`, `piiDetections`, and `processedContentHash` were persisted correctly. DI mocks for external services (StorageProvider, DocumentParser, TranscriptionProvider, VideoProcessor, ImageProcessor, BullMQ queue) are kept — these are external infrastructure, not codebase components.
**Files**: `src/__tests__/pii-pipeline-integration.test.ts`
**Impact**: Future tests in this package that need Mongoose models must use MongoMemoryServer. Only external infrastructure services may be mocked via DI.

**Category**: gotcha
**Learning**: The `@agent-platform/database` package uses `MongoConnectionManager` for connection lifecycle. When using MongoMemoryServer in tests, connect via `mongoose.connect()` directly (not `initMongoBackend` which is a runtime-specific wrapper). Import the Attachment model after the connection is established so Mongoose registers it on the active connection.
**Files**: `src/__tests__/pii-pipeline-integration.test.ts`
**Impact**: MongoMemoryServer setup in multimodal-service differs from runtime — runtime uses `initMongoBackend`, multimodal-service uses direct `mongoose.connect`.

## 2026-03-27 — Full-Suite Vitest Timeout for CI

**Category**: testing | gotcha
**Learning**: `apps/multimodal-service/vitest.config.ts` needs an explicit `testTimeout` and `hookTimeout` of `30_000` for the full suite. The default 5s Vitest timeout is too tight for this package because the normal `pnpm test` path includes real MongoMemoryServer and HTTP integration tests. `pii-pipeline-integration.test.ts` can finish in roughly 5s locally and exceed that budget in CI under load without any assertion failure.
**Files**: `vitest.config.ts`, `src/__tests__/pii-pipeline-integration.test.ts`
**Impact**: Future full-suite integration tests in multimodal-service should rely on the package-level 30s timeout budget rather than assuming Vitest defaults are sufficient.

## 2026-04-22 — Upload dedupe tests must mirror the Mongoose query chain

**Category**: testing
**Learning**: `upload-modes.test.ts` needs the `Attachment.find()` mock to match the real query chain shape exactly, including `.sort().limit().lean()`, and the default dedupe path should resolve to `[]` rather than `undefined` so upload-path tests truly exercise the “no duplicate candidate” branch.
**Files**: `apps/multimodal-service/src/__tests__/upload-modes.test.ts`
**Impact**: Future multimodal storage and dedupe tests should mirror production Mongoose chaining precisely; incomplete chain mocks can create false failures that look like business-logic regressions even when the real code path is fine.

## 2026-04-28 — Runtime/Arch Markdown and PDF Uploads

**Category**: pattern | testing
**Learning**: Attachment MIME allow-list semantics must mirror runtime config semantics: an empty `allowedMimeTypes` list means allow all, and wildcard entries like `text/*` or `application/*` must be honored by the service, not only by the Runtime gateway. Markdown/plain/csv extraction should stay local UTF-8 decoding instead of requiring Tika, while binary document types like PDF still go through Tika.
**Files**: `src/services/multimodal-service.ts`, `src/routes/attachments.ts`, `src/processing/document-parser-tika.ts`, `src/__tests__/multimodal-service.test.ts`, `src/processing/__tests__/document-parser-tika.test.ts`
**Impact**: Future attachment defaults or tenant-config changes need service-side regression coverage for empty allow lists, wildcard allow lists, and text-like document extraction so Runtime/Arch uploads do not diverge from multimodal enforcement.

## 2026-04-29 — Multimodal Vision Enhancement: Video Frame Upload & Cleanup

**Category**: architecture
**Learning**: `processVideo()` in `process-job.ts` now uploads extracted key frames to S3 as `image/png` using `Promise.allSettled` for resilience. Storage keys use `deriveStorageKey(storageKey, 'frame-{i}')`. The `STORAGE_KEY_SEGMENT_FRAME_PREFIX = 'frame-'` constant is exported for reuse. `deleteAttachment()` in `multimodal-service.ts` includes `frameStorageKeys` in best-effort storage cleanup via optional chaining.
**Files**: `src/jobs/process-job.ts`, `src/services/multimodal-service.ts`
**Impact**: Future frame-related features (serving frames via API, injecting into vision blocks) should use `frameStorageKeys` from the attachment record. The `deriveStorageKey` helper replaces the last path segment, so frame keys sit alongside `original`/`resized`/`thumbnail` in the same storage prefix.

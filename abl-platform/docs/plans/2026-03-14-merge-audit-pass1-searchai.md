# Merge Audit Pass 1: SearchAI Package

**Date:** 2026-03-14
**Merge:** `feature/trace-platform-infrastructure-v2` into `develop`
**Commit:** `c480b3438`

## Summary

| File                                   | Verdict | Detail                           |
| -------------------------------------- | ------- | -------------------------------- |
| `shared.ts`                            | PASS    | Both goals preserved             |
| `azuread-group-sync-worker.ts`         | FAIL    | `withTraceContext` wrapping lost |
| `azuread-user-sync-worker.ts`          | FAIL    | `withTraceContext` wrapping lost |
| `google-group-sync-worker.ts`          | FAIL    | `withTraceContext` wrapping lost |
| `google-user-sync-worker.ts`           | FAIL    | `withTraceContext` wrapping lost |
| `okta-group-sync-worker.ts`            | FAIL    | `withTraceContext` wrapping lost |
| `okta-user-sync-worker.ts`             | FAIL    | `withTraceContext` wrapping lost |
| `document-visual-enrichment-worker.ts` | PASS    | Auto-merged, consistent          |

**Overall: 6 FAIL, 2 PASS. Feature branch trace propagation was dropped from all 6 IdP sync workers.**

---

## File-by-File Analysis

### 1. `apps/search-ai/src/workers/shared.ts` -- PASS

**Develop goals (cached loggers):** Present.

- `getWorkerLogger()` with `workerLoggers` Map cache -- lines 67-76
- `workerLog()` and `workerError()` helper functions -- lines 78-86

**Feature branch goals (trace propagation):** Present.

- `import crypto from 'crypto'` -- line 9
- `import { extractTrace } from '@agent-platform/shared-observability/tracing'` -- line 18
- `import { runWithObservabilityContext } from '@abl/compiler/platform/observability'` -- line 19
- `withTraceContext()` exported function -- lines 101-107

Both sides fully merged. No issues.

---

### 2. `apps/search-ai/src/workers/azuread-group-sync-worker.ts` -- FAIL

**Develop goals (auth profile dual-read):** Present.

- `authProfileId` destructured from `job.data` (line 252)
- Full dual-read block with `isAuthProfileEnabled()` + `resolveAuthProfileCredential()` (lines 265-286)
- Fallback to legacy `LLMCredential` path (lines 292-304)

**Feature branch goals (trace context):** LOST.

- Feature branch imported `withTraceContext` from shared.ts (confirmed via `git show`)
- Feature branch wrapped the processor body: `await withTraceContext(job.data as unknown as Record<string, unknown>, () => ...)`
- Current file does NOT import `withTraceContext` (line 31 imports only `createWorkerOptions, workerLog, workerError, getRedisConnection`)
- Current file does NOT wrap `processAzureADGroupSync` in `withTraceContext`

**What's missing:** Add `withTraceContext` to the import on line 31, then wrap the body of `processAzureADGroupSync` (lines 253-444) inside `await withTraceContext(job.data as unknown as Record<string, unknown>, () => { ... })`.

---

### 3. `apps/search-ai/src/workers/azuread-user-sync-worker.ts` -- FAIL

**Develop goals (auth profile dual-read):** Present.

- `authProfileId` support with full dual-read block (lines 215-236)

**Feature branch goals (trace context):** LOST.

- Feature branch imported `withTraceContext` and wrapped `processAzureADUserSync` body
- Current file does NOT import `withTraceContext` (line 29)
- Current file does NOT wrap processor in `withTraceContext`

**What's missing:** Same pattern -- add `withTraceContext` to import, wrap processor body.

---

### 4. `apps/search-ai/src/workers/google-group-sync-worker.ts` -- FAIL

**Develop goals (auth profile dual-read):** Present.

- `authProfileId` support with full dual-read block (lines 277-298)

**Feature branch goals (trace context):** LOST.

- Feature branch imported `withTraceContext` and wrapped `processGoogleGroupSync` body
- Current file does NOT import `withTraceContext` (line 33)
- Current file does NOT wrap processor in `withTraceContext`

**What's missing:** Same pattern.

---

### 5. `apps/search-ai/src/workers/google-user-sync-worker.ts` -- FAIL

**Develop goals (auth profile dual-read):** Present.

- `authProfileId` support with full dual-read block (lines 238-259)

**Feature branch goals (trace context):** LOST.

- Feature branch imported `withTraceContext` and wrapped `processGoogleUserSync` body
- Current file does NOT import `withTraceContext` (line 31)
- Current file does NOT wrap processor in `withTraceContext`

**What's missing:** Same pattern.

---

### 6. `apps/search-ai/src/workers/okta-group-sync-worker.ts` -- FAIL

**Develop goals (auth profile dual-read):** Present.

- `authProfileId` support with full dual-read block (lines 291-312)

**Feature branch goals (trace context):** LOST.

- Feature branch imported `withTraceContext` and wrapped `processOktaGroupSync` body
- Current file does NOT import `withTraceContext` (line 31)
- Current file does NOT wrap processor in `withTraceContext`

**What's missing:** Same pattern.

---

### 7. `apps/search-ai/src/workers/okta-user-sync-worker.ts` -- FAIL

**Develop goals (auth profile dual-read):** Present.

- `authProfileId` support with full dual-read block (lines 238-259)

**Feature branch goals (trace context):** LOST.

- Feature branch imported `withTraceContext` and wrapped `processOktaUserSync` body
- Current file does NOT import `withTraceContext` (line 29)
- Current file does NOT wrap processor in `withTraceContext`

**What's missing:** Same pattern.

---

### 8. `apps/search-ai/src/workers/document-visual-enrichment-worker.ts` -- PASS

Auto-merged. Feature branch imported `withTraceContext` (line 16) but did not actually call it in the function body -- same in both branches. The import is technically unused but not a functional regression. The logger import was updated from `'../lib/logger.js'` (feature branch) to `'@abl/compiler/platform'` (develop) which is the correct modernization.

---

## Remediation Pattern

For each of the 6 FAIL workers, apply this two-part fix:

### Part A: Add `withTraceContext` to imports

Change:

```typescript
import { createWorkerOptions, workerLog, workerError, getRedisConnection } from './shared.js';
```

To:

```typescript
import {
  createWorkerOptions,
  workerLog,
  workerError,
  getRedisConnection,
  withTraceContext,
} from './shared.js';
```

### Part B: Wrap the processor function body

The feature branch pattern wrapped the entire processor body inside `withTraceContext`. For example, in `azuread-group-sync-worker.ts`, the processor should become:

```typescript
async function processAzureADGroupSync(job: Job<AzureADGroupSyncJobData>): Promise<void> {
  const { tenantId, credentialId, syncMode, deltaToken, authProfileId } = job.data;

  workerLog('azuread-group-sync', `Starting Azure AD group sync (${syncMode})`, {
    tenantId,
    credentialId,
    hasDeltaToken: !!deltaToken,
  });

  await withTraceContext(job.data as unknown as Record<string, unknown>, () =>
    withTenantContext({ tenantId }, async () => {
      // ... existing body with auth profile dual-read ...
    }),
  );
}
```

Note: `withTraceContext` wraps OUTSIDE `withTenantContext`, so trace context is available for all downstream operations including tenant-scoped ones.

Apply the same pattern to all 6 workers:

1. `azuread-group-sync-worker.ts` -- wrap `processAzureADGroupSync`
2. `azuread-user-sync-worker.ts` -- wrap `processAzureADUserSync`
3. `google-group-sync-worker.ts` -- wrap `processGoogleGroupSync`
4. `google-user-sync-worker.ts` -- wrap `processGoogleUserSync`
5. `okta-group-sync-worker.ts` -- wrap `processOktaGroupSync`
6. `okta-user-sync-worker.ts` -- wrap `processOktaUserSync`

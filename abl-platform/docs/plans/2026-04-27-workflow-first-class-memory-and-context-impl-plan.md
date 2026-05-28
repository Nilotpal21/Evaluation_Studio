# LLD: Workflow First-Class Memory, Agent Session, and Context

**Feature Spec**: [`docs/features/sub-features/workflow-first-class-memory-and-context.md`](../features/sub-features/workflow-first-class-memory-and-context.md)
**HLD**: [`docs/specs/workflow-first-class-memory-and-context.hld.md`](../specs/workflow-first-class-memory-and-context.hld.md)
**Test Spec**: [`docs/testing/sub-features/workflow-first-class-memory-and-context.md`](../testing/sub-features/workflow-first-class-memory-and-context.md)
**Status**: DONE — Phases 0-6 committed (final SHA `a2b4a44623`, branch `feat/workflow-agent-memory-context-spec`)
**Date**: 2026-04-27
**Last Updated**: 2026-04-28
**Author**: Pattabhi
**JIRA**: ABLP-643 (LLD); HLD ABLP-638; feature spec ABLP-634; test spec ABLP-642; impl ABLP-644 / 645 / 646 / 647 / 649 / 653 / 658 / 659

---

## 1. Design Decisions

### 1.1 Decision Log

| #    | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Rationale                                                                                                                                                                                                                                                         | Alternatives Rejected                                                                                                                                                                                                                                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1  | 7-phase order: prereq → fact-store → route → context reads → isolate writes → erasure → tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Stable foundation per phase; reads-before-writes; minimum blast radius                                                                                                                                                                                            | Mega-PR (violates 40-file/3-package limits); writes-first (couples to unproven `applySyncPromise`)                                                                                                                                                                                                                                                 |
| D-2  | `requireServiceAuth` tenantId cross-check ships as standalone Phase 0 commit (`fix(runtime):` type)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Closes a security gap that benefits ALL internal routes; one-concern-per-commit; independently revertible                                                                                                                                                         | Bundle with memory route (conflates auth-fix with feat; harder to revert auth fix in isolation)                                                                                                                                                                                                                                                    |
| D-3  | Commit-per-phase (~7 commits in one PR; possibly 2 PRs if Phase 0 lands separately)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Stays within 40-file/3-package commit limits; bisectable                                                                                                                                                                                                          | One mega-commit (unrevertable; fails commit-scope guard hook)                                                                                                                                                                                                                                                                                      |
| D-4  | Test-first for pure functions and gap assertions; prototype-first for `applySyncPromise`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Risk-gradient match; avoids TDD thrashing on unproven isolate pattern                                                                                                                                                                                             | Pure TDD (thrashes on novel isolate ↔ async pattern); pure test-after (skips gap-assertion benefit)                                                                                                                                                                                                                                                |
| D-5  | `__originAdapter` enforced via `protected _setInternal()` on `MongoDBFactStore`; `FactStoreWorkflowAdapter` **wraps** (composition) — does NOT extend, because `MongoDBFactStore` has private fields (`tenantId`, `userId`, `projectId`, `scope`, `ownerFilter()`) that block subclassing. Adapter holds an internal `MongoDBFactStore` instance scoped to the project's `__project__` userId and proxies through it. The reserved-prefix bypass is opt-in via a `protected _setInternal(params, options?: { __originAdapter?: 'workflow' })` method on `MongoDBFactStore` that the adapter calls via a friend-class pattern: the adapter lives in the same package and can `Object.create(MongoDBFactStore.prototype)` if needed, OR the protected method is exposed via a `(store as unknown as { _setInternal })._setInternal(...)` cast inside the adapter's source file (acceptable because the adapter is the platform's own code, not a third-party). | Minimum coupling; no break to `FactStore` abstract class or `InMemoryFactStore`/`tool-memory-bridge`. Composition avoids forcing visibility changes on `MongoDBFactStore`'s private fields, which would broaden the public API for an unrelated internal feature. | (a) Add field to `SetFactParams` (breaks `FactStore` abstract); (b) Change `MongoDBFactStore` private→protected on 4 fields + 1 method just to enable subclassing (broadens the public surface for one feature); (c) AsyncLocalStorage (over-engineered, hidden state); (d) separate `setWithMarker()` (leaks workflow concept into generic store) |
| D-6  | `Fact` model gets BOTH `deletedAt: Date \| undefined` AND `isDeleted: boolean \| undefined`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Index-friendly read filter + audit-reconstructible timestamp                                                                                                                                                                                                      | `deletedAt` only (read filter `{$exists: false}` less efficient); `isDeleted` only (loses audit timestamp)                                                                                                                                                                                                                                         |
| D-7  | Introduce `MAX_FACT_TTL_MS = 365d` constant; clamping enforced at runtime memory route layer (NOT fact-store)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Aligns with attachment retention precedent; fact-store stays ceiling-unaware                                                                                                                                                                                      | Per-tenant policy table (deferred to v1.1 per GAP-011); fact-store ceiling (couples generic store to feature concern)                                                                                                                                                                                                                              |
| D-8  | v1 ships contact-only erasure cascade; `customerId` / `anonymousId` / channel-artifact deferred to v1.1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | No existing cascade entry points for those types; separate design effort; updated GAP-007                                                                                                                                                                         | Build all four cascade entry points in v1 (3-package commit limit; timeline risk)                                                                                                                                                                                                                                                                  |
| D-9  | Prototype `applySyncPromise` in Phase 4 BEFORE writing INT-3 / INT-12                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Novel pattern, highest implementation risk; verify timeout / error propagation / libuv saturation                                                                                                                                                                 | Pure TDD (no behavior reference for tests); `ivm.Callback` only (rejected — cannot await async HTTP)                                                                                                                                                                                                                                               |
| D-10 | 6 metrics minimum before rollout: op duration p95, error rate, projection load latency, key count, audit volume, quota near-limit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Observable v1 without new monitoring infrastructure                                                                                                                                                                                                               | Full SLO dashboard (over-scoped for v1); zero metrics (rollout blind)                                                                                                                                                                                                                                                                              |
| D-11 | `UV_THREADPOOL_SIZE=8` as workflow-engine v1 default (env var on process)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Doubles libuv default of 4; accommodates concurrent `applySyncPromise` without starving DNS/fs                                                                                                                                                                    | Default 4 (saturates fast under concurrent memory ops); 16 (over-provisions, masks regressions)                                                                                                                                                                                                                                                    |

### 1.2 Key Interfaces & Types

```typescript
// apps/workflow-engine/src/context/expression-resolver.ts
export interface WorkflowContextData {
  trigger: TriggerContext;
  workflow: WorkflowContext;
  tenant: TenantContext;
  steps: Record<string, StepResult>;
  vars: Record<string, unknown>;
  // NEW
  agentSession?: Readonly<AgentSessionProjection>;
  agentContext?: Readonly<AgentContextProjection>;
  memoryProjection?: MemoryProjection; // optional — existing callers don't provide it; default `{ workflow: {}, project: {}, user: undefined }` applied in `buildWorkflowContext`
}

// NEW — positive-list, deep-frozen
export interface AgentSessionProjection {
  readonly sessionId: string;
  readonly agentName: string;
  readonly channel: string;
  readonly source: 'public' | 'channel' | 'studio-debug';
  readonly endUserId: string | undefined;
  readonly locale: string | undefined;
  readonly startedAt: string; // ISO 8601
  readonly lastActivityAt: string; // ISO 8601
}

export interface AgentContextProjection {
  readonly caller: { readonly type: string; readonly id: string };
  readonly invocation: { readonly tool: string; readonly args: Record<string, unknown> };
  readonly attachments: ReadonlyArray<{
    readonly id: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
    readonly name: string;
  }>;
  readonly messageMetadata: Record<string, unknown> | undefined;
}

export interface MemoryProjection {
  workflow: Record<string, unknown>;
  project: Record<string, unknown>;
  user: Record<string, unknown> | undefined; // undefined when endUserId not resolved
}

// apps/workflow-engine/src/clients/runtime-memory-client.ts (NEW)
export interface RuntimeMemoryClientOptions {
  baseUrl: string;
  // First positional argument to createServiceToken(secret, opts) — NOT a property of opts.
  // The client signs a fresh token per request with per-call tenantId/projectId.
  serviceTokenSecret: string;
  defaultTimeoutMs?: number; // default 5000
}

export interface MemoryProjectionRequest {
  tenantId: string;
  projectId: string;
  workflowId: string;
  endUserId?: string;
}

export interface MemoryOpRequest {
  tenantId: string;
  projectId: string;
  workflowId: string;
  runId: string;
  actor: { kind: 'workflow-author' | 'end-user'; endUserId?: string };
  scope: 'workflow' | 'project' | 'user';
  key: string;
  value?: unknown; // present on set
  ttl?: string; // duration string, present on set only
}

export class WorkflowMemoryError extends Error {
  constructor(
    public readonly code:
      | 'QUOTA_KEY_LENGTH'
      | 'QUOTA_VALUE_SIZE'
      | 'QUOTA_WRITE_COUNT'
      | 'RESERVED_PREFIX'
      | 'TTL_INVALID'
      | 'STORAGE_UNAVAILABLE'
      | 'UNAVAILABLE_SCOPE'
      | 'INVALID_TENANT'
      | 'INVALID_PROJECT'
      | 'INTERNAL',
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowMemoryError';
  }
}

export class RuntimeMemoryClient {
  loadProjection(req: MemoryProjectionRequest): Promise<MemoryProjection>;
  get(req: MemoryOpRequest): Promise<unknown>;
  set(req: MemoryOpRequest): Promise<void>;
  delete(req: Omit<MemoryOpRequest, 'value' | 'ttl'>): Promise<void>;
}

// apps/runtime/src/services/stores/fact-store-workflow-adapter.ts (NEW)
// COMPOSITION (not extends) — MongoDBFactStore has private fields that block subclassing.
// The adapter holds an inner project-scope MongoDBFactStore (constructed with userId='__project__')
// and is the only caller permitted to set `__originAdapter='workflow'`.
export class FactStoreWorkflowAdapter {
  private readonly inner: MongoDBFactStore;
  constructor(
    config: FactStoreConfig,
    public readonly tenantId: string,
    public readonly projectId: string,
    public readonly workflowId: string,
  ) {
    // Inner store is project-scoped with PROJECT_SCOPE_USER_ID='__project__' sentinel
    this.inner = new MongoDBFactStore(config, tenantId, '__project__', projectId, 'project');
  }
  // Translates ('foo') → 'wf:<workflowId>:foo' on set/get/delete; calls the protected
  // _setInternal on the inner store via a friend-class pattern (cast in adapter source) to bypass
  // the reserved-prefix guard with the __originAdapter='workflow' marker.
  setWorkflowKey(key: string, value: unknown, opts?: { ttlMs?: number }): Promise<Fact>;
  getWorkflowKey(key: string): Promise<Fact | null>;
  deleteWorkflowKey(key: string): Promise<boolean>;
}
```

### 1.3 Module Boundaries

| Module                                       | Responsibility                                                                                   | Depends On                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `runtime-memory-client.ts` (workflow-engine) | HTTP client for memory ops; signs service JWTs; throws `WorkflowMemoryError` on failure          | `@agent-platform/shared-auth` (`createServiceToken`), `node:fetch` |
| `internal-memory.ts` (runtime route)         | Validates tenant/project/scope, applies TTL clamp + quota + prefix guard, audit log, persistence | `requireServiceAuth`, `FactStoreWorkflowAdapter`, `createLogger`   |
| `FactStoreWorkflowAdapter` (runtime)         | `wf:<workflowId>:<key>` translation; only caller bypassing `__originAdapter` guard               | `MongoDBFactStore`                                                 |
| `MongoDBFactStore` (runtime, modified)       | Tombstone-aware reads; reserved-prefix guard on `set()` via protected `_setInternal()`           | `Fact` model                                                       |
| `expression-resolver.ts` (workflow-engine)   | First-class top-level keys (`memory`, `agentSession`, `agentContext`); single-pass interpolation | `WorkflowContextData`                                              |
| `function-executor.ts` (workflow-engine)     | Inject in-isolate globals; `applySyncPromise` callbacks for memory ops; deep-freeze enforcement  | `isolated-vm`, `runtime-memory-client.ts`                          |
| `workflow-tool-executor.ts` (runtime)        | Push-at-invoke `agentSession`/`agentContext` projection into `triggerMetadata`                   | `Session.source` resolver                                          |
| `cascade-delete-contact.ts` (runtime)        | Adds `factErasure` DI port for `memory.user.*` cascade                                           | `MongoDBFactStore`                                                 |

---

## 2. File-Level Change Map

### 2.1 New Files (21; `apps/workflow-engine/src/clients/` is a NEW directory)

| File                                                                              | Purpose                                                                                         | LOC Estimate |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------ |
| `apps/workflow-engine/src/clients/runtime-memory-client.ts`                       | HTTP client, error types, JWT signing (NEW directory `clients/`)                                | ~180         |
| `apps/workflow-engine/src/context/agent-projection.ts`                            | `materializeAgentSession` / `materializeAgentContext` positive-list + deep-freeze helpers       | ~80          |
| `apps/runtime/src/routes/internal-memory.ts`                                      | 4 endpoints (`/projection`, `/get`, `/set`, `/delete`); policy layer (clamp/quota/prefix/audit) | ~280         |
| `apps/runtime/src/services/stores/fact-store-workflow-adapter.ts`                 | `wf:` translation adapter (composition); `__originAdapter='workflow'` marker                    | ~120         |
| `apps/runtime/src/services/stores/workflow-memory-constants.ts`                   | `MAX_FACT_TTL_MS`, `MAX_VALUE_SIZE_BYTES`, `MAX_KEY_LENGTH`, `MAX_WRITES_PER_RUN`               | ~30          |
| `apps/runtime/src/contexts/contact/fact-erasure.ts`                               | Default `factErasure` port implementation for `CascadeDeleteContact`                            | ~40          |
| `apps/workflow-engine/src/__tests__/runtime-memory-client.test.ts`                | UT-3 (translation only — pure)                                                                  | ~150         |
| `apps/workflow-engine/src/__tests__/runtime-memory-client.integration.test.ts`    | INT-1, INT-3 partial                                                                            | ~250         |
| `apps/workflow-engine/src/__tests__/workflow-memory-isolate.integration.test.ts`  | INT-3, INT-12                                                                                   | ~200         |
| `apps/runtime/src/__tests__/internal-memory-route.integration.test.ts`            | INT-1, INT-2 (memory part), INT-4, INT-5, INT-6, INT-8, INT-11                                  | ~600         |
| `apps/runtime/src/__tests__/fact-store-workflow-adapter.test.ts`                  | UT-3, UT-5                                                                                      | ~140         |
| `apps/runtime/src/__tests__/mongodb-fact-store-prefix-guard.test.ts`              | INT-4 step 4-5; FR-10, FR-20                                                                    | ~120         |
| `apps/runtime/src/__tests__/cross-surface-fact-namespace.integration.test.ts`     | INT-7                                                                                           | ~140         |
| `apps/runtime/src/__tests__/internal-service-auth-tenant-cross-check.test.ts`     | INT-2 (PREREQUISITE)                                                                            | ~120         |
| `apps/runtime/src/__tests__/cascade-delete-contact-memory-erasure.test.ts`        | INT-9                                                                                           | ~150         |
| `apps/runtime/src/__tests__/workflow-tool-executor-projection.test.ts`            | INT-13                                                                                          | ~140         |
| `apps/runtime/src/__tests__/end-user-identity-matrix.integration.test.ts`         | INT-14, INT-15                                                                                  | ~280         |
| `apps/runtime/src/__tests__/workflow-scope-global-regression.integration.test.ts` | INT-16                                                                                          | ~150         |
| `apps/studio/e2e/workflows/workflow-first-class-memory.spec.ts`                   | E2E-1, E2E-2, E2E-3                                                                             | ~350         |
| `apps/studio/e2e/workflows/workflow-memory-erasure.spec.ts`                       | E2E-4                                                                                           | ~150         |
| `apps/studio/e2e/workflows/workflow-as-tool-nesting-memory.spec.ts`               | E2E-5                                                                                           | ~180         |

### 2.2 Modified Files (12)

| File                                                                                   | Change                                                                                                                                                                                                                                                                               | Risk |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| `apps/runtime/src/middleware/internal-service-auth.ts`                                 | Add tenantId body cross-check (lines after 73). Returns 403 `INVALID_TENANT` on mismatch.                                                                                                                                                                                            | Low  |
| `packages/database/src/models/fact.model.ts`                                           | Add optional `deletedAt: Date \| undefined` and `isDeleted: boolean \| undefined` fields                                                                                                                                                                                             | Low  |
| `apps/runtime/src/services/stores/mongodb-fact-store.ts`                               | (a) `{isDeleted: {$ne: true}}` on `get`/`getMany`; (b) `protected _setInternal()` with reserved-prefix guard; (c) tombstone path on `delete()`                                                                                                                                       | Med  |
| `apps/runtime/src/server.ts`                                                           | Mount `/api/internal/memory` route group with `requireServiceAuth` near existing `/api/internal/tools`                                                                                                                                                                               | Low  |
| `apps/workflow-engine/src/context/expression-resolver.ts`                              | Extend `KNOWN_TOP_LEVEL_KEYS` (line 157) with `memory`, `agentSession`, `agentContext`; extend `WorkflowContextData` (lines 32-49)                                                                                                                                                   | Low  |
| `apps/workflow-engine/src/handlers/workflow-handler.ts`                                | Extend `buildWorkflowContext` (lines 240-282) with projection load + agent-object materialization. New optional `WorkflowHandlerDeps.memoryClient`. Thread `memoryClient` into `StepDispatcherDeps` when calling `dispatchStep`.                                                     | Med  |
| `apps/workflow-engine/src/handlers/step-dispatcher.ts`                                 | Add `memoryClient?: RuntimeMemoryClient` to `StepDispatcherDeps` (line 129); update `case 'function'` block (line 279) to pass `{ memoryClient: deps.memoryClient }` to `executeFunctionStep`                                                                                        | Med  |
| `apps/workflow-engine/src/services/restate-endpoint.ts`                                | Add `memoryClient?: RuntimeMemoryClient` to `RestateEndpointDeps`; thread through to `WorkflowHandlerDeps`                                                                                                                                                                           | Low  |
| `apps/workflow-engine/src/index.ts` (entry point — workflow-engine has NO `server.ts`) | Construct `RuntimeMemoryClient` at composition root; pass into `RestateEndpointDeps`                                                                                                                                                                                                 | Low  |
| `apps/workflow-engine/src/executors/function-executor.ts`                              | (a) New optional 3rd param `deps?: FunctionExecutorDeps`; (b) Inject `memory`/`agentSession`/`agentContext` globals; (c) `ivm.Reference.applySyncPromise` callbacks (additive to existing `_contextWrite`); (d) deep-freeze materializer; (e) update `CONTEXT_READONLY_KEYS` line 27 | High |
| `apps/workflow-engine/src/constants.ts`                                                | Add `MEMORY_OP_TIMEOUT_MS = 5000`                                                                                                                                                                                                                                                    | Low  |
| `apps/runtime/src/services/workflow/workflow-tool-executor.ts`                         | Push positive-list `agentSession`/`agentContext` projection into `triggerMetadata` (after line 199)                                                                                                                                                                                  | Med  |
| `apps/runtime/src/contexts/contact/use-cases/cascade-delete-contact.ts`                | Add optional `factErasure` DI port; invoke as new step before `hardDelete`                                                                                                                                                                                                           | Med  |
| `apps/workflow-engine/src/__tests__/expression-resolver.test.ts`                       | Extend with UT-1 (first-class keys), UT-7 (single-pass)                                                                                                                                                                                                                              | Low  |
| `apps/workflow-engine/src/__tests__/function-executor.test.ts`                         | Extend with UT-4 (deep-freeze), UT-6 (global injection)                                                                                                                                                                                                                              | Low  |
| `apps/workflow-engine/agents.md`                                                       | Update stale 2026-03-24 entry: `WorkflowExecution.triggerMetadata` IS declared; document new agent-projection enrichment                                                                                                                                                             | Low  |
| `apps/runtime/agents.md`                                                               | Document `requireServiceAuth` tenantId cross-check; document `MongoDBFactStore` prefix guard                                                                                                                                                                                         | Low  |
| `packages/database/agents.md`                                                          | Document `Fact` model tombstone fields                                                                                                                                                                                                                                               | Low  |

### 2.3 Deleted Files

None. Feature is purely additive.

---

## 3. Implementation Phases

CRITICAL: Each phase must be independently deployable and testable. No phase leaves the system in a broken state.

### Phase 0 — `requireServiceAuth` tenantId body cross-check (PREREQUISITE)

**Goal**: Close the security gap where `requireServiceAuth` cross-checks `projectId` body→JWT but NOT `tenantId`. Benefits ALL internal route groups (tools, chat, callback, future memory).

**Tasks**:

- 0.1 Read existing logic at `apps/runtime/src/middleware/internal-service-auth.ts:59-73`. Identify the projectId cross-check block.
- 0.2 Write INT-2-style test FIRST: `apps/runtime/src/__tests__/internal-service-auth-tenant-cross-check.test.ts` — assert that `jwtA + body.tenantId='tB'` returns 200 today (gap), then 403 after fix.
- 0.3 Add tenantId cross-check after the existing projectId block (line 73). Use the exact same pattern: extract from `req.body?.tenantId ?? req.params?.tenantId ?? req.query?.tenantId`. If present and ≠ `serviceToken.tenantId`, return 403 with envelope. **Error code:** to keep consistency with the existing projectId check (which returns `code: 'FORBIDDEN'` per `internal-service-auth.ts:70`), use `code: 'FORBIDDEN'` with message `'Tenant ID mismatch with service token'`. The test spec INT-2 must reference `FORBIDDEN` (NOT `INVALID_TENANT`) — update the INT-2 expectations during Phase 0 implementation. Future migration to distinct codes (`INVALID_PROJECT`/`INVALID_TENANT`) is a separate refactor; this LLD does NOT change the project-mismatch code.
- 0.4 Run tests: gap-assertion fails (good); add fix; gap-assertion now passes; INT-2 covers projectId mismatch (still works) + tenantId mismatch (new) + missing JWT + tampered JWT.
- 0.5 Update `apps/runtime/agents.md` with the cross-check addition.

**Files Touched**:

- `apps/runtime/src/middleware/internal-service-auth.ts` — add cross-check block (~12 lines)
- `apps/runtime/src/__tests__/internal-service-auth-tenant-cross-check.test.ts` — NEW (~120 lines)
- `apps/runtime/agents.md` — append entry

**Exit Criteria**:

- [ ] `apps/runtime/src/__tests__/internal-service-auth-tenant-cross-check.test.ts` passes (covers tenantId mismatch → 403, projectId mismatch → 403, missing JWT → 401, expired JWT → 401)
- [ ] `pnpm build --filter=@agent-platform/runtime` succeeds with 0 errors
- [ ] All existing internal-route integration tests still pass (`pnpm test --filter=@agent-platform/runtime` — no regression on `internal-tools.ts`, `internal-chat.ts`, `internal-callback.ts`)
- [ ] `npx prettier --write` run on all changed files

**Test Strategy**:

- Unit/integration: real Express + supertest + real `createServiceToken` JWT. No mocks of platform components.

**Rollback**: `git revert` the single commit. No data changes.

**Commit**: `[ABLP-X] fix(runtime): add tenantId body cross-check to requireServiceAuth`

---

### Phase 1 — Fact-store foundation (`Fact` schema + prefix guard + adapter + ceiling)

**Goal**: Land the data-layer changes that subsequent phases consume. Tombstone semantics, reserved-prefix guard, `wf:<workflowId>:<key>` translation adapter, TTL ceiling constant.

**Tasks**:

- 1.1 Write UT-3 (translation pure function) and UT-5 (reserved-prefix validator) FIRST: `apps/runtime/src/__tests__/fact-store-workflow-adapter.test.ts` — assert translation rules, asser reserved-prefix throws.
- 1.2 Add `deletedAt: Date \| undefined` and `isDeleted: boolean \| undefined` to `IFact` and the Mongoose schema in `packages/database/src/models/fact.model.ts`. Both optional. Existing TTL index on `expiresAt` unchanged.
- 1.3 Modify `apps/runtime/src/services/stores/mongodb-fact-store.ts`:
  - `get()` (line 162) and `getMany()` (line 183): add `{isDeleted: {$ne: true}}` to the read filters
  - Refactor `set()` (line 122) to call new `protected async _setInternal(params, options?: { __originAdapter?: string })`
  - In `_setInternal`, if `params.key.startsWith('wf:')` and `options?.__originAdapter !== 'workflow'`, throw `WorkflowMemoryError('RESERVED_PREFIX', ...)` (or a generic `Error` with code field — choose one, see §4 wiring).
  - Modify `delete()` (line 202) to soft-delete: set `isDeleted=true`, `deletedAt=new Date()`, retain `value` for audit reconstruction. The TTL index auto-expires tombstones via `expiresAt`. Document this is a behavior change (refactor commit type). **Downstream effect:** `tool-memory-bridge.ts` `delete_content()` calls go through `MongoDBFactStore.delete()` (verified — `tool-memory-bridge.ts:140-160`) and will now produce tombstones rather than hard-deleting. This is acceptable: tombstones auto-expire via the existing `expiresAt` TTL index, and `MongoDBFactStore.get()` filters them via `{isDeleted: {$ne: true}}`. Document the behavior change in `apps/runtime/agents.md`.
- 1.4 Create `apps/runtime/src/services/stores/fact-store-workflow-adapter.ts`. `class FactStoreWorkflowAdapter` — **composition, NOT extends** (D-5 verified — `MongoDBFactStore` has private fields). Constructor takes `(config, tenantId, projectId, workflowId)` and instantiates `this.inner = new MongoDBFactStore(config, tenantId, '__project__', projectId, 'project')`. `setWorkflowKey(key, value, opts?)` translates `key → wf:<workflowId>:<key>` and calls `(this.inner as unknown as { _setInternal: (...) => Promise<Fact> })._setInternal({...}, { __originAdapter: 'workflow' })` — friend-class cast acceptable for in-package adapter. `getWorkflowKey`/`deleteWorkflowKey` translate keys then delegate to `this.inner.get(...)` / `this.inner.delete(...)` (no guard bypass needed for read/delete; deletion of an existing `wf:` key tombstones via the public `delete()` flow).
- 1.5 Create `apps/runtime/src/services/stores/workflow-memory-constants.ts` with `MAX_FACT_TTL_MS = 365 * 24 * 60 * 60 * 1000`, `MAX_VALUE_SIZE_BYTES = 64 * 1024`, `MAX_KEY_LENGTH = 256`, `MAX_WRITES_PER_RUN = 100`.
- 1.6 Write `apps/runtime/src/__tests__/mongodb-fact-store-prefix-guard.test.ts` — INT-4 step 4-5 deep guard verification. Direct call to `MongoDBFactStore.set()` with `wf:` key WITHOUT marker throws; `FactStoreWorkflowAdapter.setWorkflowKey()` succeeds.
- 1.7 Update `packages/database/agents.md` and `apps/runtime/agents.md`.

**Files Touched**:

- `packages/database/src/models/fact.model.ts` — add 2 fields (~10 lines)
- `apps/runtime/src/services/stores/mongodb-fact-store.ts` — refactor `set`/`get`/`getMany`/`delete` (~80 lines change)
- `apps/runtime/src/services/stores/fact-store-workflow-adapter.ts` — NEW (~120 lines)
- `apps/runtime/src/services/stores/workflow-memory-constants.ts` — NEW (~30 lines)
- `apps/runtime/src/__tests__/fact-store-workflow-adapter.test.ts` — NEW (~140 lines)
- `apps/runtime/src/__tests__/mongodb-fact-store-prefix-guard.test.ts` — NEW (~120 lines)
- `packages/database/agents.md`, `apps/runtime/agents.md` — append

**Exit Criteria**:

- [ ] `apps/runtime/src/__tests__/fact-store-workflow-adapter.test.ts` passes (UT-3 + UT-5 — translation correct, reserved prefixes rejected)
- [ ] `apps/runtime/src/__tests__/mongodb-fact-store-prefix-guard.test.ts` passes (INT-4 step 4-5)
- [ ] Existing fact-store tests pass — soft-delete change tested via INT-8 step 4 (tombstoned facts return undefined on `get`)
- [ ] `pnpm build --filter=@agent-platform/runtime --filter=@abl/database` succeeds with 0 errors
- [ ] `tool-memory-bridge.ts` still works for project/user-scope writes (no `wf:` keys, no `__originAdapter` needed) — verified by running existing tool-memory-bridge tests
- [ ] `npx prettier --write` run on all changed files

**Test Strategy**:

- Unit (UT-3, UT-5): pure function tests on adapter + validator
- Integration (INT-4 step 4-5): real MongoDB via `MongoMemoryServer`; direct fact-store calls

**Rollback**: Revert the commit. The `deletedAt`/`isDeleted` fields are optional — surviving documents after rollback ignore them. No data deletion.

**Commit (mixed type — mostly additive but with one behavioral change)**: Split into two commits if deletion ratio > 30%:

1. `[ABLP-X] feat(runtime): add FactStoreWorkflowAdapter + tombstone fields + reserved-prefix guard` (additive: schema, adapter, constants, route-route guard)
2. `[ABLP-X] refactor(runtime): convert MongoDBFactStore.delete to tombstone semantics` (behavioral change isolated)

---

### Phase 2 — `/api/internal/memory` route + service-auth wiring + audit logger

**Goal**: Stand up the runtime HTTP surface that workflow-engine will call. 4 endpoints, policy layer, audit emission. Uses Phase 0 cross-check + Phase 1 adapter.

**Tasks**:

- 2.1 Create `apps/runtime/src/routes/internal-memory.ts` following the **`internal-chat.ts` pattern** (router-per-file, default export, mount in `server.ts`, Zod safeParse body validation, top-level try/catch returning `{success: false, error: {code: 'INTERNAL', message}}` on unhandled exceptions). The four endpoints each declare a Zod schema at the top of the file. All ID fields use `z.string().min(1)` (NOT cuid/uuid/nanoid/ulid per CLAUDE.md zod-id-lint rule):
  - `projectionSchema`: tenantId, projectId, workflowId (all min(1)); optional endUserId
  - `getSchema`: same plus runId, scope enum (workflow/project/user), key min(1)
  - `setSchema`: extends getSchema with actor (kind enum + optional endUserId), value (unknown), optional ttl (string)
  - `deleteSchema`: setSchema omitting value and ttl
    Each handler:
  - Calls `schema.safeParse(req.body)`; on failure returns 400 `INVALID_BODY` envelope
  - Wraps business logic in try/catch — `WorkflowMemoryError` maps to 400/503 by code; unhandled errors log and return 500 `INTERNAL`
- 2.2 Implement `POST /projection`:
  - Read `tenantId`, `projectId`, `workflowId` from body
  - Use `FactStoreWorkflowAdapter` to load all `wf:<workflowId>:*` keys for project scope
  - Use a project-scope `MongoDBFactStore` to load all non-`wf:` project keys
  - If `endUserId` present, use a user-scope `MongoDBFactStore` to load user keys
  - Return `{success: true, data: {workflow, project, user}}`. Cap serialized payload at 256 KB (HLD Concern #9); over-cap returns 400 `PROJECTION_TOO_LARGE`.
  - Emit trace event `projection_load` with key counts per scope.
- 2.3 Implement `POST /get`:
  - Validate scope (`workflow` | `project` | `user`)
  - For `user` scope without `endUserId`, throw `UNAVAILABLE_SCOPE`
  - Single-key read; return `{success: true, data: { value }}` or `{success: true, data: { value: undefined }}` for missing
- 2.4 Implement `POST /set`:
  - Reserved-prefix guard at route layer (FIRST line of business logic — reject `wf:`/`_meta:`/`_system:`/`_audit:` from author)
  - Quota guards: key length ≤ 256; value size — call `JSON.stringify(value)` inside try/catch and check `.length ≤ 64 * 1024`. If `JSON.stringify` throws (circular references, BigInt, etc.), return 400 `INVALID_VALUE` with message `'Value is not JSON-serializable'`.
  - Per-run write count: increment a Redis counter keyed on `runId`; reject 101st write with `QUOTA_WRITE_COUNT`. (Counter TTL: 24h.) **Decision**: use existing `redisClient` already wired into runtime; if Redis unavailable, fall back to throwing `STORAGE_UNAVAILABLE` rather than skipping the cap.
  - TTL parser: invalid → throw `TTL_INVALID`; > `MAX_FACT_TTL_MS` → clamp to ceiling, emit warning trace `ttl_clamped`
  - Emit audit log: `createLogger('workflow-memory').info('memory_op', { tenantId, projectId, workflowId, runId, scope, key, actor, appliedTtlMs, op: 'set' })` (NO `value`)
  - Persist via `FactStoreWorkflowAdapter` (workflow scope) or scoped `MongoDBFactStore` (project/user scope)
  - Emit trace event `memory_op`
- 2.5 Implement `POST /delete`:
  - Same scope/prefix guards
  - Tombstone via `MongoDBFactStore.delete()` (Phase 1 behavior — soft-delete + audit-reconstructible)
  - Emit audit log with `op: 'delete', tombstone: true`
- 2.6 Mount route in `apps/runtime/src/server.ts` near line 965 (where `/api/internal/tools` is mounted): `app.use('/api/internal/memory', requireServiceAuth, internalMemoryRouter)`.
- 2.7 Write integration tests `apps/runtime/src/__tests__/internal-memory-route.integration.test.ts`:
  - INT-1 (round-trip), INT-2 (memory-route portion), INT-4 (route-layer guard), INT-5 (quotas), INT-6 (TTL clamp + warning), INT-8 (audit log + tombstone), INT-11 (concurrent last-write-wins)
  - **UT-2 (TTL clamping pure function) is co-located in this same file** (single file because the parser is internal to the route module). Tests: `'5d'` → `5d`; `'999d'` → ceiling + warning flag; `'banana'` → throws `TTL_INVALID`; `''`/`undefined` → fall through to `DEFAULT_FACT_TTL_MS = 90d`. The pure-function entry point is exported as `__test_only_parseAndClampTtl` (or test-imported via the route's exported helper).
- 2.8 Cross-surface integration test `cross-surface-fact-namespace.integration.test.ts` (INT-7).

**Files Touched**:

- `apps/runtime/src/routes/internal-memory.ts` — NEW (~280 lines)
- `apps/runtime/src/server.ts` — mount line (~3 lines)
- `apps/runtime/src/__tests__/internal-memory-route.integration.test.ts` — NEW (~600 lines)
- `apps/runtime/src/__tests__/cross-surface-fact-namespace.integration.test.ts` — NEW (~140 lines)

**Exit Criteria**:

- [ ] All 4 endpoints respond correctly to happy-path requests with real service JWT and real `MongoMemoryServer`
- [ ] INT-1 (round-trip), INT-4 (prefix guard route layer), INT-5 (3 quota classes), INT-6 (TTL clamp/invalid/default), INT-8 (audit + tombstone), INT-11 (last-write-wins) all pass
- [ ] INT-7 (cross-surface): tool-memory-bridge writes `memory.project.foo`, workflow client reads it (intentional sharing); workflow client writes `memory.workflow.bar` (under `wf:<id>:bar`), tool-memory-bridge cannot read it via its public API
- [ ] Audit log capture verifies NO `value` field (INT-8 step 1 negative assertion)
- [ ] `pnpm build --filter=@agent-platform/runtime` succeeds with 0 errors
- [ ] `npx prettier --write` run on all changed files

**Test Strategy**:

- Integration: real Express + supertest + real `createServiceToken` + real `MongoMemoryServer`. No mocks of platform components. Audit-log capture via DI of a structured-log sink (NOT a mocked logger module).

**Rollback**: Revert the commit. The route is unmounted; no other routes depend on it yet (Phase 3 hasn't shipped).

**Commit**: `[ABLP-X] feat(runtime): add /api/internal/memory route group with policy layer + audit`

---

### Phase 3 — Workflow-engine context expansion (READS) + push-at-invoke projection

**Goal**: Land the read-side: expression resolver knows about new top-level objects, agent-triggered runs get `agentSession`/`agentContext` populated. NO function-node memory writes yet (deferred to Phase 4).

**Tasks**:

- 3.1 Write UT-1 (first-class keys) and UT-7 (single-pass) FIRST in `apps/workflow-engine/src/__tests__/expression-resolver.test.ts` (extend existing). Assertions:
  - `{{agentSession.channel}}`, `{{memory.workflow.foo}}` resolve typed when context populated
  - `{{agentSession.foo}}` where `agentSession === undefined` resolves to `undefined`, NOT throw
  - Resolved values containing `{{...}}` are inert literals (single-pass interpolation regression — verify via direct call to `resolveExpressionTyped`)
- 3.2 Extend `apps/workflow-engine/src/context/expression-resolver.ts`:
  - `KNOWN_TOP_LEVEL_KEYS` (line 157) → add `'memory'`, `'agentSession'`, `'agentContext'`
  - `WorkflowContextData` interface (lines 32-49) → add 3 optional fields per §1.2
- 3.3 Extend `apps/workflow-engine/src/handlers/workflow-handler.ts`:
  - `WorkflowHandlerDeps` (lines 217-226) → add `memoryClient?: RuntimeMemoryClient` (optional; if absent, projection is empty)
  - `buildWorkflowContext` (lines 240-282):
    - Read `triggerMetadata.agentSession` and `triggerMetadata.agentContext`. If present, pass through `materializeAgentSession()` and `materializeAgentContext()` (positive-list filter + deep-freeze) and assign to context.
    - Call `memoryClient.loadProjection({tenantId, projectId, workflowId, endUserId})` if `memoryClient` is provided. Assign result to `context.memoryProjection`. On failure, throw — workflow run fails fast; do NOT swallow.
- 3.4 Add `materializeAgentSession()` / `materializeAgentContext()` in a new helper module `apps/workflow-engine/src/context/agent-projection.ts` (NEW, ~80 lines). These functions:
  - Build new objects with ONLY the §9 positive-list fields. Spread is forbidden (would let extras leak).
  - Recursively `Object.freeze` every nested object/array (not deep — depth 4 is sufficient for the schema).
- 3.5 Modify `apps/runtime/src/services/workflow/workflow-tool-executor.ts` (after line 199):
  - Resolve `Session.source` (or call existing helper for end-user identity resolution)
  - Build `agentSession` and `agentContext` projections via positive-list (NOT spread — explicit field-by-field)
  - Add to `triggerMetadata`: `agentSession`, `agentContext`
  - Update `WorkflowToolExecutorConfig` if needed for the new identity resolver dep
- 3.6 Write `apps/runtime/src/__tests__/workflow-tool-executor-projection.test.ts` — INT-13: positive-list verification. Drive synthetic session metadata with extra fields (`creditCardLast4`, `modelId`); assert NOT present on materialized `agentSession`.
- 3.7 Write UT-4 (deep-freeze) in `apps/workflow-engine/src/__tests__/function-executor.test.ts` (extend existing) — assert top-level + nested mutation throws in strict mode.
- 3.8 Write `apps/runtime/src/__tests__/end-user-identity-matrix.integration.test.ts` — INT-14 (all 6 §4a rows incl event conditional) + INT-15 (cookie-reset anonymousId) + INT-16 (workflow-global privacy regression).
  - **Deferred portion**: INT-16 needs Phase 4 (function-node `memory.workflow.set`). Mark INT-16 cases in this file as `.skip` or split them off — actually, INT-16 can use a route-direct test (skip the function-node) so it lands here. Confirm at write time.
- 3.9 Update `apps/workflow-engine/agents.md` (correct the stale entry).

**Files Touched**:

- `apps/workflow-engine/src/context/expression-resolver.ts` — modify (lines 32-49 + 157)
- `apps/workflow-engine/src/handlers/workflow-handler.ts` — modify (lines 217-282)
- `apps/workflow-engine/src/context/agent-projection.ts` — NEW (~80 lines)
- `apps/runtime/src/services/workflow/workflow-tool-executor.ts` — modify (after line 199)
- `apps/workflow-engine/src/__tests__/expression-resolver.test.ts` — extend
- `apps/workflow-engine/src/__tests__/function-executor.test.ts` — extend
- `apps/runtime/src/__tests__/workflow-tool-executor-projection.test.ts` — NEW
- `apps/runtime/src/__tests__/end-user-identity-matrix.integration.test.ts` — NEW
- `apps/runtime/src/__tests__/workflow-scope-global-regression.integration.test.ts` — NEW (INT-16, route-direct)
- `apps/workflow-engine/agents.md` — update stale entry

**Exit Criteria**:

- [ ] UT-1 (first-class keys), UT-4 (deep-freeze), UT-7 (single-pass) pass
- [ ] INT-13 (positive-list projection) passes — `creditCardLast4`/`modelId` NOT present on `agentSession`
- [ ] INT-14 passes for all 6 §4a trigger rows (incl. event-with-userId and event-without-userId)
- [ ] INT-15 (cookie-reset) passes
- [ ] INT-16 (workflow-global privacy regression) passes — alice's write visible to bob's read on the same workflow; `userId === '__project__'` sentinel
- [ ] Existing workflow tests pass — agent-less webhook/cron runs see `agentSession === undefined` (E2E-3 partial)
- [ ] `pnpm build --filter=@agent-platform/workflow-engine --filter=@agent-platform/runtime` succeeds with 0 errors
- [ ] `npx prettier --write` run on all changed files

**Test Strategy**:

- Unit (UT-1, UT-4, UT-7): pure function tests on resolver + materializer
- Integration (INT-13, INT-14, INT-15, INT-16): real services, real Mongo, real route mount

**Rollback**: Revert the commit. `KNOWN_TOP_LEVEL_KEYS` returns to old set; `WorkflowContextData` returns to old shape; `triggerMetadata` no longer carries projections (consumers ignored extras anyway). No data changes.

**Commit**: `[ABLP-X] feat(workflow-engine): expose agentSession/agentContext/memory as first-class context (read-side)`

---

### Phase 4 — Function-node isolate plumbing (WRITES) via `applySyncPromise`

**Goal**: Land the write-side. Function nodes get `memory.workflow.get/set/delete` callable from inside the V8 isolate via `ivm.Reference.applySyncPromise`. `agentSession`/`agentContext` injected as deep-frozen globals. THIS IS THE HIGHEST-RISK PHASE.

**Tasks**:

- 4.1 **Prototype FIRST (D-9).** Build a 50-line spike in a scratch file (`apps/workflow-engine/scratch/applysync-prototype.ts`, gitignored):
  - Create `ivm.Isolate`, `ivm.Reference` to a host async function that does an HTTP round-trip
  - Call from inside the script via `ref.applySyncPromise()`
  - Verify: (a) script blocks until promise resolves, (b) thrown errors propagate to script call site, (c) timeout interaction with `script.runSync({ timeout })`, (d) what happens if `UV_THREADPOOL_SIZE` is exceeded (start 10 concurrent calls with `UV_THREADPOOL_SIZE=4`)
  - Record findings as a comment in `function-executor.ts` for future reference
- 4.2 Create `apps/workflow-engine/src/clients/runtime-memory-client.ts`:
  - Class `RuntimeMemoryClient` per §1.2
  - Sign service JWT per request via `createServiceToken(this.options.serviceTokenSecret, { tenantId, projectId, serviceName: 'workflow-engine' })` (signature: `(secret: string, opts: { tenantId, projectId?, serviceName? }) => string`, source `packages/shared-auth/src/middleware/jwt-verify.ts:163`)
  - Use `node:fetch` (no axios — match workspace convention from `package.json` confirmation)
  - 5s default timeout (`MEMORY_OP_TIMEOUT_MS` from constants)
  - Map HTTP error codes to `WorkflowMemoryError` codes
- 4.3 Write UT-3 (translation), UT-5 (validator) in `runtime-memory-client.test.ts` — pure tests of the client's request shape, no HTTP.
- 4.4 Write `runtime-memory-client.integration.test.ts` — INT-1, INT-3 partial. Real HTTP server (the route from Phase 2), real client, real JWT.
- 4.5 Modify `apps/workflow-engine/src/executors/function-executor.ts`:
  - Today `executeFunctionStep` is a standalone exported function: `executeFunctionStep(step: FunctionStep, ctx: WorkflowContextData): Promise<FunctionResult>` (line 65). To inject the memory client without a class wrapper, **add an optional third parameter** `deps?: { memoryClient?: RuntimeMemoryClient }`. New signature: `executeFunctionStep(step: FunctionStep, ctx: WorkflowContextData, deps?: FunctionExecutorDeps): Promise<FunctionResult>`. The new param is optional so existing callers keep working; when absent, memory globals are still injected but every `set/get/delete` throws `STORAGE_UNAVAILABLE` (signaling a wiring miss).
  - **Wiring chain (4 hops, verified):** the production caller is **`step-dispatcher.ts:279`** (`case 'function': const result = await executeFunctionStep(step, ctx);`), NOT `workflow-handler.ts`. The chain is:
    1. `apps/workflow-engine/src/index.ts` (composition root) → constructs `RuntimeMemoryClient` and passes it into `RestateEndpointDeps`
    2. `apps/workflow-engine/src/services/restate-endpoint.ts` → threads `memoryClient` from `RestateEndpointDeps` into `WorkflowHandlerDeps`
    3. `apps/workflow-engine/src/handlers/workflow-handler.ts` → uses `deps.memoryClient` for `loadProjection()` AND threads it into `StepDispatcherDeps`
    4. `apps/workflow-engine/src/handlers/step-dispatcher.ts:129 (interface)` and `:279 (call site)` → adds `memoryClient?: RuntimeMemoryClient` to `StepDispatcherDeps` and updates `case 'function'` to call `executeFunctionStep(step, ctx, { memoryClient: deps.memoryClient })`

    All 4 files are listed in §2.2 Modified Files (added in round 3 fix).

  - **Existing isolate setup is ADDITIVE-preserved.** The current `_contextWrite` `ivm.Callback` (line 118) and console-capture `ivm.Callback` (lines 104-109) remain unchanged — they handle `context.x = "value"` writes and `console.log` capture respectively. Memory ops use a NEW pattern (`ivm.Reference` injected via `jail.setSync()` then called from the bootstrap script via `ref.applySyncPromise()`) layered alongside the existing callbacks. The Proxy wrapper script (lines 139-213) is extended with the memory globals; the existing context-proxy logic stays intact.
  - Build host functions: `_memoryGet(scope, key)`, `_memorySet(scope, key, value, ttl)`, `_memoryDelete(scope, key)` — each is `async`, calls `deps.memoryClient.<op>` with the run's `tenantId`/`projectId`/`workflowId`/`runId`/`actor`
  - Wrap each as `new ivm.Reference(hostFn)` and inject into the isolate
  - In the isolate's bootstrap script, build `memory.workflow.get/set/delete` (and `.project.*`, `.user.*`) that call `_memoryGetRef.applySyncPromise(scope, key)` etc.
  - On `set`, also update the in-run projection in `WorkflowContextData.memoryProjection` so subsequent expressions/nodes see the new value (FR-14). Use a host callback `_writeProjection(scope, key, value)` that mutates the host-side `memoryProjection` reference.
  - Inject `agentSession`/`agentContext` as `ivm.ExternalCopy(materializedProjection).copyInto({transferIn: true})` — already deep-frozen on the host; the in-isolate copy is a fresh object that we wrap with `Object.freeze` recursively in the bootstrap script.
  - Update `CONTEXT_READONLY_KEYS` (line 27) to include `'memory'`, `'agentSession'`, `'agentContext'`. Direct write to `memory = null` in the isolate throws (frozen).

- 4.6 Set `UV_THREADPOOL_SIZE=8` in workflow-engine deployment config:
  - `apps/workflow-engine/Dockerfile`: add `ENV UV_THREADPOOL_SIZE=8`
  - Local dev: documented in `apps/workflow-engine/README.md` if exists
- 4.7 Write `workflow-memory-isolate.integration.test.ts` — INT-3 (round-trip via real isolate), INT-12 (retry idempotency).
- 4.8 Write UT-6 (global injection) in `function-executor.test.ts` — assert `typeof memory === 'object'`, `typeof memory.workflow.get === 'function'`, mutation `memory.workflow = null` throws.

**Files Touched**:

- `apps/workflow-engine/src/clients/runtime-memory-client.ts` — NEW (~180 lines, NEW `clients/` directory)
- `apps/workflow-engine/src/executors/function-executor.ts` — modify (~150 LOC change; line 27 + lines 115-213 isolate setup; new optional 3rd `deps?` param at line 65)
- `apps/workflow-engine/src/handlers/step-dispatcher.ts` — modify (`StepDispatcherDeps` line 129 + `case 'function'` line 279) to thread `memoryClient`
- `apps/workflow-engine/src/services/restate-endpoint.ts` — modify (`RestateEndpointDeps` interface) to thread `memoryClient`
- `apps/workflow-engine/src/index.ts` — modify (composition root: instantiate `RuntimeMemoryClient`)
- `apps/workflow-engine/src/constants.ts` — add `MEMORY_OP_TIMEOUT_MS`
- `apps/workflow-engine/Dockerfile` — add ENV line
- `apps/workflow-engine/src/__tests__/runtime-memory-client.test.ts` — NEW
- `apps/workflow-engine/src/__tests__/runtime-memory-client.integration.test.ts` — NEW
- `apps/workflow-engine/src/__tests__/workflow-memory-isolate.integration.test.ts` — NEW
- `apps/workflow-engine/src/__tests__/function-executor.test.ts` — extend (UT-6)

**Exit Criteria**:

- [ ] Prototype scratch file demonstrates `applySyncPromise` blocks isolate → host → resolves; errors propagate
- [ ] UT-6 (global injection) passes
- [ ] INT-1 (round-trip), INT-3 (in-isolate sync-from-script), INT-12 (retry idempotency) pass
- [ ] INT-10 (no template re-interpolation) — covered as a 4th test case appended to `apps/workflow-engine/src/__tests__/expression-resolver.test.ts` (extending Phase 3's UT-7). The integration scenario uses memory-loaded values containing `{{...}}` syntax (`agentContext.attachments[0].name === '{{memory.project.secret}}'`) and asserts the resolver returns the literal — not the recursively-resolved secret value.
- [ ] In-run projection update verified: function-node body `memory.workflow.set('a', 1); return memory.workflow.get('a');` returns `1`
- [ ] Existing function-executor tests pass — function nodes WITHOUT memory ops still work unchanged (regression: spec §13.5)
- [ ] `pnpm build --filter=@agent-platform/workflow-engine` succeeds with 0 errors
- [ ] `UV_THREADPOOL_SIZE=8` set in Dockerfile
- [ ] `npx prettier --write` run on all changed files

**Test Strategy**:

- Prototype-first per D-9
- Integration: real isolate (no `vi.mock` of `isolated-vm`), real `RuntimeMemoryClient`, real route from Phase 2

**Rollback**: Revert the commit. `function-executor.ts` returns to its pre-Phase-4 isolate setup (no memory globals). The runtime memory route is unused but remains live — no harm.

**Commit**: `[ABLP-X] feat(workflow-engine): function-node memory globals via ivm.Reference.applySyncPromise`

---

### Phase 5 — Right-to-erasure cascade for `memory.user.*`

**Goal**: Wire `CascadeDeleteContact` to purge user-scoped facts when a contact is GDPR-deleted. Contact-only in v1 per D-8.

**Tasks**:

- 5.1 Write INT-9 FIRST: `apps/runtime/src/__tests__/cascade-delete-contact-memory-erasure.test.ts`. Seed contact `c1`; seed `memory.user.foo` keyed on `c1.id`, `memory.workflow.bar` (project scope), `memory.project.baz`. Trigger `CascadeDeleteContact(c1)`. Assert `memory.user.foo` purged; `memory.workflow.bar` and `memory.project.baz` intact. (Test will fail today — gap assertion.)
- 5.2 Modify `apps/runtime/src/contexts/contact/use-cases/cascade-delete-contact.ts`:
  - Add optional DI port `factErasure?: (tenantId: string, contactId: string) => Promise<{ erased: number }>` to constructor (lines 49-57)
  - In `execute()` (line 58), invoke `factErasure(tenantId, contactId)` AFTER `scrubMessages` and BEFORE `hardDelete` (per existing step ordering — see Phase 4 of `execute()`)
  - If `factErasure` throws, audit-log the failure but continue the cascade (existing pattern with `clickhouseCleanup` failures)
- 5.2a Modify `apps/runtime/src/contexts/contact/index.ts`:
  - Update `ContactContextDeps` interface (lines 80-97) — add optional field `factErasure?: (tenantId: string, contactId: string) => Promise<{erased: number}>`
  - Update `createContactContext` factory call at line 130-136 — pass `deps.factErasure` as the new optional positional arg in the existing constructor invocation
- 5.3 Provide a default `factErasure` implementation in a new module **`apps/runtime/src/contexts/contact/fact-erasure.ts`** (NEW, ~40 lines): direct `Fact.deleteMany({tenantId, userId: contactId, scope: 'user'})` import via the database package. **Note**: `projectId` is multi-tenant for facts — the cascade does not know which projects the contact is bound to, so `deleteMany` on `tenantId+userId+scope` is correct (workflow-scope facts use `userId='__project__'` sentinel — they are NOT touched). Verify this assertion in INT-9 step 3 by asserting `wf:abc:bar` (under `userId='__project__'`) is NOT deleted.
- 5.4 Wire the default `factErasure` into the `CascadeDeleteContact` composition site at **`apps/runtime/src/contexts/contact/index.ts:130`** (verified via `grep -rn 'new CascadeDeleteContact' apps/runtime/src/`). This is the only production composition site — test files instantiate the use-case directly with their own ports.
- 5.5 Update feature spec GAP table: (a) GAP-007 — acknowledge contact-only scope; (b) add GAP-016 — non-contact identity erasure (`customerId`, `anonymousId`, channel-artifact) deferred to v1.1 per D-8; (c) add GAP-017 — TraceStore integration for the workflow memory route deferred to v1.1 per LLD §5.5 (currently structured-log emission via `createLogger`). Doc-only edits accompanying the Phase 5 commit.

**Files Touched**:

- `apps/runtime/src/contexts/contact/use-cases/cascade-delete-contact.ts` — modify (add port + new step)
- `apps/runtime/src/contexts/contact/fact-erasure.ts` — NEW (~40 lines, default `factErasure` port implementation)
- `apps/runtime/src/contexts/contact/index.ts` — wire `factErasure` port at line 130 where `new CascadeDeleteContact(...)` is composed
- `apps/runtime/src/__tests__/cascade-delete-contact-memory-erasure.test.ts` — NEW (~150 lines)
- `docs/features/sub-features/workflow-first-class-memory-and-context.md` — update GAP-007, add GAP-016

**Exit Criteria**:

- [ ] INT-9 passes (user-scope facts purged; workflow- and project-scope unaffected)
- [ ] Existing `CascadeDeleteContact` tests pass (no regression on resolution-key cleanup, message scrub, ClickHouse cleanup, audit, hard-delete)
- [ ] `pnpm build --filter=@agent-platform/runtime` succeeds with 0 errors
- [ ] Feature spec GAP table updated
- [ ] `npx prettier --write` run on all changed files

**Test Strategy**:

- Test-first (D-4) — INT-9 written before the implementation
- Integration: real `MongoMemoryServer`, real `CascadeDeleteContact`, real fact-store; only external deps DI'd

**Rollback**: Revert the commit. `factErasure` port becomes unset; cascade ignores user-scope facts (back to pre-v1 behavior). No data corruption.

**Commit**: `[ABLP-X] feat(runtime): extend CascadeDeleteContact with memory.user.* fact erasure`

---

### Phase 6 — E2E test suite + final wiring verification

**Goal**: Cover E2E-1..E2E-5 against the real running stack (Studio + Runtime + Workflow Engine + Mongo + Redis). Verify nothing in Phase 0-5 was wired incorrectly.

**Tasks**:

- 6.1 Write `apps/studio/e2e/workflows/workflow-first-class-memory.spec.ts` — E2E-1 (agent-bound workflow reads agent objects + writes memory + persistence across runs), E2E-2 (cross-trigger continuity webhook→cron→agent), E2E-3 (non-agent triggers see `agentSession === undefined`).
  - Use existing helpers from `helpers.ts`: `loginAndSetup`, `createWorkflowViaUI`, `runWorkflow`
  - Use Zustand store helper `configureFunctionNode` from `workflow-function-node.spec.ts` pattern
  - Real running services — start Studio against real Runtime (`port: 0`)
  - NO `vi.mock` / `jest.mock` / direct Mongo (per CLAUDE.md E2E standards)
- 6.2 Write `apps/studio/e2e/workflows/workflow-memory-erasure.spec.ts` — E2E-4 (GDPR delete cascade).
- 6.3 Write `apps/studio/e2e/workflows/workflow-as-tool-nesting-memory.spec.ts` — E2E-5 (nesting propagates outermost agent context).
- 6.4 Update `apps/studio/e2e/workflows/agents.md` — add the 3 new specs to the testid registry, tier tracker (likely heavy / nightly given multi-service deps), coverage tables.
- 6.5 Run the keystone regression check (test spec §10): E2E-2 + INT-2 + INT-7 + INT-14 — if all four pass, the rest of the suite is enforcement detail.
- 6.6 Performance enforcement assertions (test spec §6) — verify INT-1 includes `t < 200ms` on warm Mongo.
- 6.7 Wire `RuntimeMemoryClient` instantiation at the workflow-engine composition root **`apps/workflow-engine/src/index.ts`** (verified — workflow-engine has NO `server.ts`). The full 4-hop chain (Phase 4 §4.5) must be live: `index.ts` → `RestateEndpointDeps` → `restate-endpoint.ts` → `WorkflowHandlerDeps` → `workflow-handler.ts` → `StepDispatcherDeps` → `step-dispatcher.ts` → `executeFunctionStep` deps. This is the wiring step that enables `memoryClient.loadProjection()` for real runs AND function-node memory ops. Verify by smoke test: run a real workflow with a function node calling `memory.workflow.set`; confirm both `projection_load` and `memory_op` trace events appear.

**Files Touched**:

- `apps/studio/e2e/workflows/workflow-first-class-memory.spec.ts` — NEW (~350 lines)
- `apps/studio/e2e/workflows/workflow-memory-erasure.spec.ts` — NEW (~150 lines)
- `apps/studio/e2e/workflows/workflow-as-tool-nesting-memory.spec.ts` — NEW (~180 lines)
- `apps/studio/e2e/workflows/agents.md` — update (~15 lines added)
- `apps/workflow-engine/src/index.ts` (composition root — workflow-engine has NO `server.ts`) — wire `RuntimeMemoryClient` instantiation, thread through `RestateEndpointDeps` (~10 lines)

**Exit Criteria**:

- [ ] E2E-1, E2E-2, E2E-3, E2E-4, E2E-5 all pass against real running services (`pnpm e2e:workflows`)
- [ ] Keystone regression — E2E-2 + INT-2 + INT-7 + INT-14 — all pass
- [ ] No Mongoose models imported in E2E specs; no `vi.mock`; no direct DB access (per CLAUDE.md hook check)
- [ ] Workflow-engine `memoryClient` wired into composition root; smoke test confirms `projection_load` trace fires for a real run
- [ ] `pnpm build` (full repo) succeeds with 0 errors
- [ ] `pnpm test:report` shows 0 failures across the integration + unit suites for `apps/workflow-engine` and `apps/runtime`
- [ ] `apps/studio/e2e/workflows/agents.md` registry updated
- [ ] `npx prettier --write` run on all changed files

**Test Strategy**:

- E2E (CLAUDE.md compliant): real HTTP API, real services, real auth chain. Only external 3rd-party services may be DI-mocked.

**Rollback**: Revert the commit. The 3 E2E specs are removed; existing E2E suite unaffected. No production code change.

**Commit**: `[ABLP-X] test(studio): add E2E coverage for workflow first-class memory + agent context`

---

## 4. Wiring Checklist

CRITICAL: Every new component must be wired into its callers. This section is the #1 failure mode for agent-written code.

- [ ] **Phase 0**: `requireServiceAuth` middleware modified (existing routes pick up the new tenantId cross-check automatically — no per-route mount changes)
- [ ] **Phase 1**: `Fact` model schema additions are picked up by Mongoose at startup; `MongoDBFactStore.delete()` behavioral change is automatic for all callers; new `FactStoreWorkflowAdapter` exported from `apps/runtime/src/services/stores/index.ts`
- [ ] **Phase 2**: `internalMemoryRouter` exported via `export default` from `internal-memory.ts`; mounted in `apps/runtime/src/server.ts` near line 965 with `app.use('/api/internal/memory', requireServiceAuth, internalMemoryRouter)`
- [ ] **Phase 3**: `expression-resolver.ts` `KNOWN_TOP_LEVEL_KEYS` updated; `WorkflowContextData` interface updated and consumers re-typed; `workflow-tool-executor.ts` enriches `triggerMetadata` (consumed by `workflow-handler.ts.buildWorkflowContext`); `agent-projection.ts` exported from `apps/workflow-engine/src/context/index.ts` (or directly imported by `workflow-handler.ts`)
- [ ] **Phase 4**: 4-hop wiring chain verified: `apps/workflow-engine/src/index.ts` (composition root, NOT `server.ts`) → `RestateEndpointDeps` → `restate-endpoint.ts` → `WorkflowHandlerDeps` → `workflow-handler.ts` → `StepDispatcherDeps` (`step-dispatcher.ts:129`) → `case 'function'` block (`step-dispatcher.ts:279`) → `executeFunctionStep(step, ctx, { memoryClient })`. Each hop adds an optional `memoryClient?: RuntimeMemoryClient` field. Wiring smoke test (Phase 6 §6.7) confirms both `projection_load` AND `memory_op` traces fire on a real run. `UV_THREADPOOL_SIZE=8` set in `apps/workflow-engine/Dockerfile`.
- [ ] **Phase 5**: `factErasure` port wired into `CascadeDeleteContact` factory; default implementation registered in DI container
- [ ] **Phase 6**: 3 new E2E specs picked up by `pnpm e2e:workflows` script (no manual registration; Playwright glob includes `apps/studio/e2e/**/*.spec.ts`)
- [ ] **Documentation**: `agents.md` updated for `apps/workflow-engine`, `apps/runtime`, `packages/database`, `apps/studio/e2e/workflows`
- [ ] **No new env vars exposed publicly**: `MAX_FACT_TTL_MS`/`MAX_VALUE_SIZE_BYTES`/`MAX_KEY_LENGTH`/`MAX_WRITES_PER_RUN` are constants, not env-driven in v1
- [ ] **Dockerfile package.json sync**: NO new packages added (no `packages/<name>/` worktree). No Dockerfile updates needed. Verified.
- [ ] **OpenAPI**: `/api/internal/memory` is internal-only (`requireServiceAuth`), not part of the public OpenAPI spec — no doc update required.

---

## 5. Cross-Phase Concerns

### 5.1 Database Migrations

**No migrations needed.** All schema changes are additive optional fields:

- `Fact.deletedAt: Date | undefined`
- `Fact.isDeleted: boolean | undefined`

Existing documents read with these fields as `undefined`; `{isDeleted: {$ne: true}}` correctly includes them. The TTL index on `expiresAt` is unchanged.

The unique compound index `{tenantId, userId, projectId, scope, key}` (fact.model.ts:63) is also unchanged — tombstones share the same compound key as live facts, which is correct (one tombstone OR one live fact per key, never both, because soft-delete preserves the document).

### 5.2 Feature Flags

**No flags.** Per D-S2/D-7 (HLD oracle), the feature is fully additive:

- Existing workflows that don't reference `memory`/`agentSession`/`agentContext` see zero behavior change
- The `KNOWN_TOP_LEVEL_KEYS` set expansion is opt-in
- Workflow-tool-executor's `triggerMetadata` enrichment is additive — old consumers ignore extras
- `MongoDBFactStore.delete()` behavior change (hard → soft) is the only meaningful runtime change; mitigated by HLD §11 rollback plan (tombstone cleanup script before code revert)

### 5.3 Configuration Changes

| Variable / Constant              | Value                                     | Where                                                           | Notes                                                              |
| -------------------------------- | ----------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------ |
| `UV_THREADPOOL_SIZE`             | `8`                                       | `apps/workflow-engine/Dockerfile`                               | Doubles libuv default; required for `applySyncPromise` concurrency |
| `MEMORY_OP_TIMEOUT_MS`           | `5000`                                    | `apps/workflow-engine/src/constants.ts`                         | Per-op HTTP timeout                                                |
| `MAX_FACT_TTL_MS`                | `365d`                                    | `apps/runtime/src/services/stores/workflow-memory-constants.ts` | TTL ceiling enforced at runtime memory route                       |
| `MAX_VALUE_SIZE_BYTES`           | `64 * 1024`                               | same                                                            | Per FR-20                                                          |
| `MAX_KEY_LENGTH`                 | `256`                                     | same                                                            | Per FR-20                                                          |
| `MAX_WRITES_PER_RUN`             | `100`                                     | same                                                            | Per FR-20; enforced via Redis counter keyed on `runId`             |
| `WORKFLOW_MEMORY_FACT_STORE_URL` | env var, defaults to internal runtime URL | workflow-engine env config                                      | Internal route base for `runtime-memory-client.ts`                 |

### 5.4 Audit Log Format (frozen v1 contract)

```jsonc
{
  "level": "info",
  "module": "workflow-memory",
  "event": "memory_op",
  "op": "set", // 'set' | 'delete'
  "tombstone": true, // present on 'delete' only
  "tenantId": "tA",
  "projectId": "pA",
  "workflowId": "wf-123",
  "runId": "run-abc",
  "scope": "workflow", // 'workflow' | 'project' | 'user'
  "key": "lastCursor",
  "actor": { "kind": "workflow-author" },
  "appliedTtlMs": 604800000, // 7d
  "ts": "2026-04-27T12:00:00Z",
  // NO "value" — never logged
}
```

### 5.5 Trace Event Schema

| Event               | Fields                                                                                                                                             | Emitted By                                                                                                                                                                                                                                                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projection_load`   | `tenantId, projectId, workflowId, endUserId?, keyCounts: {workflow, project, user}, durationMs, payloadBytes, result: 'ok' \| 'error', errorCode?` | runtime memory route `/projection` (success AND error paths)                                                                                                                                                                                                                                                                                             |
| `memory_op`         | `op, scope, key, ttlMs?, durationMs, result: 'ok' \| 'error', errorCode?`                                                                          | runtime memory route `/get`/`/set`/`/delete` — emits on **every** request, success or failure. Failure path covers: `RESERVED_PREFIX` (route layer + deep `_setInternal` guard), `QUOTA_KEY_LENGTH`, `QUOTA_VALUE_SIZE`, `QUOTA_WRITE_COUNT`, `TTL_INVALID`, `STORAGE_UNAVAILABLE`, `UNAVAILABLE_SCOPE`, `INVALID_TENANT`, `INVALID_PROJECT`, `INTERNAL` |
| `ttl_clamped`       | `requested, applied, key, scope`                                                                                                                   | runtime memory route `/set` on clamp (paired with the success `memory_op` event for the same request)                                                                                                                                                                                                                                                    |
| `applysync_timeout` | `runId, scope, key, op, elapsedMs`                                                                                                                 | workflow-engine `function-executor.ts` when an isolate-side `applySyncPromise` exceeds `MEMORY_OP_TIMEOUT_MS` (paired with the resulting `STORAGE_UNAVAILABLE` `memory_op` error trace from the route, when the route ultimately responds; covers the case where the client times out before the server responds)                                        |

CRITICAL: Every request to the memory route emits exactly one `memory_op` trace, regardless of outcome. Successful request → `result: 'ok'`. Any failure → `result: 'error'` + `errorCode`. This is required for Invariant 4 (Traceability) coverage of all error paths. Audit-log emission (FR-22) only fires for SUCCESSFUL `set` and `delete` (rejected writes never reach the persistence layer and produce no audit entry; the trace event covers them).

**Trace emission mechanism in v1**: `createLogger('workflow-memory').info('trace:<event>', { ...fields })`. The internal memory route does NOT have a session-level `TraceStore` context (internal routes are service-to-service, not user-session-bound). Structured logs are the trace sink. **GAP-017 (new)**: structured `TraceStore` integration for the workflow memory route is deferred to v1.1 if the runtime trace consumer needs richer correlation — feature spec gap table will add this entry in Phase 5 when GAPs are updated.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] Phases 0-6 committed and merged to `feat/workflow-agent-memory-context-spec`
- [ ] All 7 unit tests pass (UT-1..UT-7) — `pnpm test:fast --filter=apps/workflow-engine --filter=apps/runtime`
- [ ] All 16 integration tests pass (INT-1..INT-16) — `pnpm test --filter=apps/workflow-engine --filter=apps/runtime`
- [ ] All 5 E2E tests pass (E2E-1..E2E-5) — `pnpm e2e:workflows`
- [ ] Keystone regression — E2E-2 + INT-2 + INT-7 + INT-14 — all pass (test spec §10)
- [ ] Performance enforcement: INT-1 measures `t < 200ms` for single memory op on warm Mongo
- [ ] No regressions in existing tests (`pnpm build && pnpm test`)
- [ ] Feature spec status updated PLANNED → ALPHA per Feature Status Lifecycle
- [ ] Test spec coverage matrix updated NOT TESTED → COVERED for all 23 FRs
- [ ] Feature spec §17 row 4 (function-node memory test file) maps to actual files
- [ ] HLD status updated DRAFT → APPROVED → IMPLEMENTED
- [ ] Test spec status updated PLANNED → STABLE (after all 28 scenarios pass)
- [ ] LLD status updated DRAFT → IN PROGRESS → DONE
- [ ] Feature spec §17 row 2 (`workflow-integration.test.ts`) — reconcile during `/post-impl-sync`: row currently references a file that does not yet exist; map to the actual test file added by Phase 6 (`workflow-first-class-memory.spec.ts`) and the `runtime-memory-client.integration.test.ts` integration coverage
- [ ] `agents.md` files updated for `apps/workflow-engine`, `apps/runtime`, `packages/database`, `apps/studio/e2e/workflows`
- [ ] 6 metrics emitting before tenant rollout (per D-10)
- [ ] `UV_THREADPOOL_SIZE=8` in workflow-engine production deployment
- [ ] All commits formatted with `npx prettier --write` before commit
- [ ] All commits use real ABLP- JIRA keys (no placeholders)
- [ ] No commits exceed 40 non-doc files or 3 packages (per CLAUDE.md commit discipline)
- [ ] No commits trigger `deletion-ratio-guard` (feat commits stay additive)

---

## 7. Open Questions

1. **Per-run write counter storage** — the LLD specifies "Redis counter keyed on `runId`, TTL 24h". Runtime already has a Redis client wired into the route layer (used by other routes). **Decision (locked)**: Redis-only. If Redis is unavailable, the route MUST throw `STORAGE_UNAVAILABLE` and refuse the write — no in-process `Map<runId, count>` fallback. An in-process counter would break Core Invariant 3 (Stateless Distributed): two pods serving the same `runId` would each enforce 100 writes locally, allowing 200 total. The "fail closed when Redis is down" stance is consistent with the rest of the platform's distributed-state contract.
2. **Audit-log retention** — HLD §9 Open Q #1 unchanged. v1 = stdout-only. v1.1 adds `fact_audit` collection if compliance demands it. **No LLD action required.**
3. **Projection-load cardinality** — HLD §9 Open Q #2 unchanged. LLD adds `keyCounts` per scope to the `projection_load` trace event so we can measure typical projection size in production. Operational ceiling decision deferred to post-launch data. **Action: instrument in Phase 2; monitor first 30 days.**
4. **Non-contact identity erasure** — HLD §9 Open Q #4 + LLD D-8. v1 = contact only. Update GAP-007 (Phase 5); add new GAP-016 for `customerId`/`anonymousId`/channel-artifact erasure deferred to v1.1.
5. **Studio E2E timing tier** — test spec §9 Open Q #4. The 3 new E2E specs add ~15 min wall-clock to the nightly tier. **Action: confirm tier classification with Studio E2E owner during Phase 6 PR review.**
6. **Isolate-thread pool sizing** — test spec §9 Open Q #1. LLD locks at `UV_THREADPOOL_SIZE=8` (D-11). Add a deadlock-prevention regression test in Phase 4: 10 concurrent `applySyncPromise` calls all complete (none deadlock).

---

## 8. References

- Feature spec: `docs/features/sub-features/workflow-first-class-memory-and-context.md` (FR-1..FR-23, ABLP-634)
- HLD: `docs/specs/workflow-first-class-memory-and-context.hld.md` (12 concerns + prerequisite, ABLP-638)
- Test spec: `docs/testing/sub-features/workflow-first-class-memory-and-context.md` (5 E2E + 16 INT + 7 UT, ABLP-642)
- LLD oracle log: `docs/sdlc-logs/workflow-first-class-memory-and-context/lld.log.md`
- Pipeline: `docs/sdlc/pipeline.md`
- LLD playbook: `docs/sdlc/lld-playbook.md`
- CLAUDE.md sections: Commit Discipline, Test Architecture, E2E Test Standards, Type Safety
- Source seams (verified):
  - `apps/workflow-engine/src/context/expression-resolver.ts:32-49,57,84,157,176`
  - `apps/workflow-engine/src/handlers/workflow-handler.ts:64-89,217-226,240-282`
  - `apps/workflow-engine/src/executors/function-executor.ts:27,29,65,88,104,115-122,125-132,139-213,217,293-295`
  - `apps/runtime/src/middleware/internal-service-auth.ts:28,57,59-73`
  - `apps/runtime/src/services/stores/mongodb-fact-store.ts:39,86,88,94,122,162,183,202,331`
  - `apps/runtime/src/services/workflow/workflow-tool-executor.ts:7-21,136,190-199`
  - `apps/runtime/src/contexts/contact/use-cases/cascade-delete-contact.ts:49,58`
  - `packages/database/src/models/fact.model.ts:15-35,63,64`
  - `packages/database/src/cascade/cascade-delete.ts:109,365,438`
  - `packages/shared-auth/src/middleware/jwt-verify.ts:147-154,163,219`
  - `apps/runtime/src/routes/internal-tools.ts:32,34,187` (route pattern reference)
  - `apps/runtime/src/server.ts:965` (mount pattern)
  - `apps/studio/e2e/workflows/workflow-function-node.spec.ts` (E2E pattern)
  - `apps/studio/e2e/workflows/helpers.ts` (E2E helpers)

---

## Post-Implementation Notes (2026-04-28)

LLD landed across 8 implementation commits + 4 spec/plan commits on `feat/workflow-agent-memory-context-spec`. Final SHA: `a2b4a44623`. Feature is at status **ALPHA**.

### Architectural deviations from this LLD

1. **Phase 5 — `factErasure` default wired in `runtime-contact-context.ts` rather than `index.ts:130`.** The LLD specified the wiring point as the framework-agnostic factory (`createContactContext`). In practice, the production composition wrapper `runtime-contact-context.ts` is the only place that already knows about the `Contact` Mongoose model (loaded via dynamic import alongside `eraseUserScopedFacts`). Wiring the default there preserves the test-friendliness of the factory (test files can construct contexts without Mongo) and matches the same separation pattern used for `getEncryptionService()`. Documented in implementation log Phase 5 deviation note.

2. **Phase 6 — Agent-bound and cron-trigger E2Es are scaffolded as `test.skip` rather than fully implemented.** The LLD §Phase 6 §6.1 / §6.2 called for E2E-1 (agent-triggered workflow reads first-class agent objects), the agent leg of E2E-2, and E2E-5 (workflow-as-tool nesting agent context propagation). All three require a chat → agent → workflow-tool E2E harness that does not yet exist in `apps/studio/e2e/workflows/`. Rather than ship a brittle / partial E2E or a "looks-like-E2E-but-mocks-the-agent-runtime" spec, these are scaffolded with explicit `test.skip` + full file-level docstring, tracked in feature spec §16 as **GAP-018** (agent-bound chat E2E harness) and **GAP-019** (cron trigger E2E harness). Agent-context propagation is integration-covered today by `workflow-tool-executor-projection.test.ts` (INT-13). The skips will lift in v1.1 alongside the chat E2E harness work.

3. **Phase 6 §6.7 — Composition-root wiring smoke is a verification step, not new code.** The LLD called this out as a "wire `RuntimeMemoryClient` instantiation at the workflow-engine composition root". In practice, the wiring landed in Phase 4 (commit `8a80635fbf`) at `apps/workflow-engine/src/index.ts:1108-1132` — a single `runtimeMemoryClient` is shared between `RestateEndpointDeps.memoryClient` (used by `workflow-handler.loadMemoryProjection`) and `dispatcherDeps.memoryClient` (used by `step-dispatcher.case 'function'`). Phase 6 confirmed via the existing unit + integration suites (`runtime-memory-client*.test.ts`, `function-executor.test.ts`) that both `loadProjection` and `memory_op` trace emission paths exercise the shared client.

### Resolved gaps from feature spec §16

- GAP-007 (right-to-erasure cascade for `memory.user.*`) — Resolved Phase 5
- GAP-008 (per-write quotas + reserved-prefix guard) — Resolved Phase 1 + Phase 2
- GAP-009 (single-pass interpolation) — Resolved Phase 3
- GAP-010 (positive-list projection schemas for `agentSession`/`agentContext`) — Resolved Phase 3
- GAP-014 (workflow-engine ↔ runtime memory client) — Resolved Phase 4

### Open / deferred gaps (v1.1)

- GAP-011: Tenant-level governance controls (deferred)
- GAP-012: Atomic counters / CAS / read-your-writes (out of v1 scope)
- GAP-013: Write-once / exactly-once `memory.set` under retry (out of v1 scope)
- GAP-015: Field-level encryption for sensitive memory values (deferred)
- GAP-016: Right-to-erasure cascade for non-contact identities (deferred)
- GAP-017: TraceStore integration for `memory_op` / `projection_load` (deferred — structured logs cover today)
- GAP-018: Agent-bound chat → workflow-tool E2E harness (deferred)
- GAP-019: Cron trigger E2E harness (deferred)

### Acceptance status

- [x] Phases 0-6 committed and pushed to `feat/workflow-agent-memory-context-spec`
- [x] All required UTs / INTs landed and green per the test-spec coverage matrix (17 of 21 scenarios DONE; 2 PARTIAL on documented gaps; 2 NOT TESTED by design)
- [x] Workflow-engine `pnpm test` 965 / 965 non-skipped pass; runtime keystone (`internal-memory-route.test.ts` 24/24, `cascade-delete-contact-memory-erasure.test.ts` 4/4) green
- [x] Composition-root wiring smoke confirmed via Phase 4 commit `8a80635fbf`
- [ ] Promotion to BETA gated on closing GAP-018 + GAP-019 + 5 pr-reviewer rounds

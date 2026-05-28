# Platform Status Audit — 2026-03-25

> **Scope**: All 84 features across P0-P3 and NFR tiers
> **Method**: Automated codebase verification of specs, tests, routes, and LLD implementations
> **Prior Status**: 64 features at TBD (synced to actual 2026-03-24), then audited for accuracy

## Executive Summary

The audit found systematic over-promotion of feature statuses. Of 17 features claimed STABLE, only 3 actually meet criteria. Of 12 features claimed BETA, only 5 meet criteria. Key issues:

- **3 security vulnerabilities** in shipped features (alerts SQL injection, env vars CRITICAL bugs, eventstore cross-tenant)
- **3 broken Studio→Runtime proxies** (routes implemented but never mounted in server.ts)
- **7,222 lines of dead code** across 24 files (routes, services, repos never imported)
- **80% of features lack E2E tests** despite test specs claiming DONE
- **39% of E2E test files** violate standards by using vi.mock()

## Status Corrections

### Before vs After Audit

| Status  | Before Audit | After Audit | Delta |
| ------- | :----------: | :---------: | :---: |
| STABLE  |      17      |      3      |  -14  |
| BETA    |      12      |     19      |  +7   |
| ALPHA   |      28      |     35      |  +7   |
| PLANNED |      27      |     27      |   0   |

### Individual Feature Changes

#### STABLE → BETA (12 features)

| #   | Feature                   | Key Finding                                                          |
| --- | ------------------------- | -------------------------------------------------------------------- |
| 1   | Auth Profiles             | No real E2E tests; "E2E" mocks auth+DB                               |
| 2   | Memory & Sessions         | 2 HIGH gaps open (cross-tenant E2E untested)                         |
| 9   | EventStore                | HIGH cross-tenant wildcard; 0 E2E; 58 console.log violations         |
| 12  | Rate Limiting             | 2 HIGH gaps; Redis Lua production path has 0 tests                   |
| 17  | Model Hub                 | 0 E2E tests (spec marks E2E as OPEN)                                 |
| 19  | Tool Invocations          | Primary E2E file is phantom (referenced 6x, doesn't exist); HIGH gap |
| 21  | Multi-Agent Orchestration | E2E is env-gated (requires LLM key); 3 NOT TESTED scenarios          |
| 57  | Workspace Sharing         | "E2E" file mocks fetch; HIGH gap open                                |
| 73  | Filler Messages           | 0 E2E through WebSocket; only unit tests                             |
| 74  | Arch AI Assistant         | 0 E2E tests; no gaps/testing section in spec                         |

#### STABLE → ALPHA (2 features)

| #   | Feature                     | Key Finding                                                      |
| --- | --------------------------- | ---------------------------------------------------------------- |
| 8   | Pipeline Engine             | agents.md explicitly corrected to ALPHA on 03-23; no Restate E2E |
| 24  | NLU / Intent Classification | 2 HIGH gaps; 0 E2E via HTTP; all tests mock LLM+sidecar          |

#### BETA → ALPHA (7 features)

| #   | Feature               | Key Finding                                       |
| --- | --------------------- | ------------------------------------------------- |
| 6   | KMS                   | 0 E2E, 0 integration; unit-only with all mocked   |
| 7   | Audit Logging         | 0 E2E, 0 integration; core stores untested        |
| 28  | Environment Variables | 2 CRITICAL open bugs; "E2E" has 14 vi.mock calls  |
| 29  | Connectors            | "E2E" mocks auth middleware                       |
| 30  | MCP Support           | 0 real E2E; all tests mock heavily                |
| 50  | Device Auth           | 0 E2E, 0 integration; route test mocks 17 modules |
| 52  | Email Channel / SMTP  | Self-acknowledged fake E2E (mocks transport)      |

#### Confirmed at Current Status

| #   | Feature                    | Status | Reason                                         |
| --- | -------------------------- | ------ | ---------------------------------------------- |
| 13  | ABL Language               | STABLE | 3,947 tests, real E2E, gaps Low/Medium         |
| 14  | Agent Anatomy              | STABLE | Real E2E + integration, gaps Medium/Low        |
| 15  | Agent Development (Studio) | STABLE | 5 Playwright E2E, 5 integration suites         |
| 3   | Guardrails                 | BETA   | 100+ tests, no HTTP API E2E but borderline     |
| 4   | PII Detection              | BETA   | 1 real E2E (6 tests), 2 integration (40 tests) |
| 5   | Encryption at Rest         | BETA   | 3 E2E files (38 tests) with real Mongo         |
| 31  | A2A Integration            | BETA   | 35 real black-box E2E, 96 integration          |
| 56  | CORS                       | BETA   | Real integration test, simple feature          |

## Security Vulnerabilities

### ~~CRITICAL: Alerts SQL Injection~~ — RESOLVED

- **Fixed**: `isSafeIdentifier()` validates `metric` and `sourceTable` on create (line 189, 201), update (line 327-355), and test-fire (line 527-555) routes
- **Fixed**: Mass assignment prevented via `pickUpdatableFields()` allowlist (line 316); create route destructures explicit fields
- **Method**: Inline regex allowlist (`/^[a-zA-Z_][a-zA-Z0-9_.]*$/`) — the planned `clickhouse-allowlist.ts` was not needed as a separate file

### ~~CRITICAL: Environment Variables Base Value Bugs~~ — RESOLVED

- **GAP-001 Fixed** (commit `ea3668267`): Zod schema now has `.nullable()`, handler normalizes null → `'global'`
- **GAP-002 Fixed** (commit `6d2e86ed8`, PR #483): `findEnvVar()` in `llm-wiring.ts` falls back to `environment: 'global'` when exact match fails

### HIGH: EventStore Cross-Tenant Wildcard

- **File**: `packages/eventstore/src/evaluation-dispatcher.ts` line 193
- **Issue**: Queries with `tenantId: '*'` — potential cross-tenant data leakage
- **Also**: 58 console.log violations, in-memory Map without eviction

## Broken Studio → Runtime Proxies

| Feature            | Studio Route                            | Runtime Route File            | Lines | Problem                    |
| ------------------ | --------------------------------------- | ----------------------------- | ----- | -------------------------- |
| Omnichannel        | `/api/projects/[id]/omnichannel/`       | `routes/omnichannel.ts`       | 715   | Never mounted in server.ts |
| Attachment Config  | `/api/projects/[id]/attachment-config/` | `routes/attachment-config.ts` | 172   | Never mounted in server.ts |
| Insights Dashboard | `/api/runtime/insights/`                | `routes/insights.ts`          | 205   | Never mounted in server.ts |

## Dead Code Inventory

### Unmounted Route Files (16 files, 5,314 LOC)

**Runtime (11 files, 3,987 LOC):**

- `omnichannel.ts` (715), `auth-profiles.ts` (641), `platform-admin-traces.ts` (679)
- `variable-namespaces.ts` (376), `variable-namespace-members.ts` (419)
- `tenant-sdk-channels.ts` (358), `sdk-public-keys.ts` (237), `insights.ts` (205)
- `attachment-config.ts` (172), `evaluation-tags.ts` (162), `auth-profile-route-utils.ts` (23)

**Search-AI (5 files, 1,327 LOC):**

- `errors.ts` (363), `metrics.ts` (427), `search.ts` (191), `webhooks.ts` (179), `queue-monitoring.ts` (167)

### Dead Service/Infra Files (8 files, 1,908 LOC)

- `test-generator.ts` (378), `debug-integration.ts` (430), `clickhouse-observability-monitor.ts` (331)
- `alert-delivery.ts` (224), `credential-age-monitor.ts` (196)
- `trace-response.ts` (25), `cascade-repo.ts` (166), `session.repository.ts` (158)

### Dead Wiring Chains

- `auth-profile-rotation-scheduler.ts` → `runtime-maintenance-jobs.ts` → **never called from server.ts**
- `DebugRuntimeExecutor` in `debug-integration.ts` → **never imported by any file**

## Test Quality Issues

### E2E Violations (vi.mock in E2E tests) — RESOLVED

Originally 32 of ~82 E2E test files (39%) used vi.mock(). All have been reclassified:

**Batch 1 — 8 runtime tests** renamed `*.e2e.test.ts` → `*.integration.test.ts`:
module-preview, deployment-pipeline, livekit-voice, afg-abl-runtime, ai4hc-abl-runtime, agent-search, airlines-search, searchai-kb-agent.

**Batch 2 — 12 searchai tests** renamed:
10 under `integration/searchai/`, plus search-ai-e2e and search-ai-runtime-e2e.

**Batch 3 — 2 misc tests** renamed: connectors.e2e, email-channel-e2e.

**Batch 4 — 3 heavy-mock tests** renamed: env-vars-e2e (14 mocks), user-isolation-e2e (17 mocks), observatory-api-e2e (13 mocks). These need future rewrites using `startRuntimeServerHarness` for true E2E coverage.

**Result**: Zero E2E files (`*e2e*`) now contain vi.mock() violations. 2 Studio files mock only `server-only` (Next.js polyfill — acceptable). 3 omnichannel E2E files are clean (explicitly documented "NO vi.mock()").

### Permanently Skipped Tests

- 5 `describe.skip` (entire suites disabled)
- 33 `it.skip` / `test.skip` occurrences
- SharePoint connector: 16 tests skipped
- Search-AI SSE progress: 6/6 tests skipped (entire feature untested)
- CEL expression evaluation: 4 tests skipped (functional gap)

### Phantom Test Files (referenced but don't exist)

- `tool-invocations-api.e2e.test.ts` — referenced 6 times in spec
- `auth-profile-connector-setup.test.ts`, `auth-profile-oauth-flow.test.ts`, `auth-profile-token-refresh.test.ts`

### Trivial Assertions

10 occurrences of `expect(true).toBe(true)` — pass CI but test nothing

### Excluded from CI

33 runtime test files excluded via vitest.config.ts (marked "flaky" or infrastructure-dependent)

## LLD Implementation Gaps

### Missing Files from Executed LLDs (13 files)

- 8 E2E test files never created (auth-profiles, guardrails)
- 1 security fix file never created (`clickhouse-allowlist.ts`)
- 4 unit test files never created (auth-profiles addons)

### Stale Spec Content

| Feature                   | Stale Claim                | Reality                                 |
| ------------------------- | -------------------------- | --------------------------------------- |
| Auth Profiles GAP-2       | 12 test files don't exist  | All 12+ files exist                     |
| Auth Profiles GAP-3       | 7 source files don't exist | All 7 files exist                       |
| Memory Sessions GAP-007   | Skips ownership check      | Code always calls ensureWsSessionAccess |
| Workspace Sharing GAP-001 | Uses crypto.randomUUID()   | Uses randomBytes+SHA256                 |

## Priority Actions

### Immediate (Security)

1. ~~Fix alerts SQL injection~~ — RESOLVED (isSafeIdentifier on all paths)
2. ~~Fix alerts mass assignment~~ — RESOLVED (pickUpdatableFields allowlist)
3. ~~Fix env vars base value bugs~~ — RESOLVED (GAP-001: ea3668267, GAP-002: 6d2e86ed8)
4. Fix eventstore cross-tenant wildcard (`evaluation-dispatcher.ts:193`)

### Week 1 (Broken Wiring)

5. Mount omnichannel, attachment-config, insights routes in runtime server.ts
6. Wire auth-profile-rotation-scheduler into server.ts startup
7. Replace 58 console.log calls in eventstore with createLogger

### Week 2-4 (Test Quality)

8. Create real E2E tests for top BETA features (Auth Profiles, Memory, EventStore, Rate Limiting, Tool Invocations)
9. ~~Fix or remove 32 E2E files that use vi.mock()~~ — RESOLVED (reclassified to integration tier)
10. Fix or remove 33 permanently skipped tests
11. Un-exclude "flaky" runtime tests and fix root causes

### Ongoing

12. Update stale gap entries in feature specs
13. Delete confirmed dead code (7,222 LOC)
14. Create missing LLD files (13 from executed plans)

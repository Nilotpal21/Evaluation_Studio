# Agent SDK Automation Suite — Design Spec

**Date:** 2026-03-16
**Status:** Approved
**Approach:** Static Route Manifest + Claude Agent SDK Executor

---

## Overview

Three Claude Agent SDK-powered automation agents for the ABL platform:

- **Agent A — E2E Smoke Test Agent:** Exercises every Studio API route (327) and runtime route (85) within an isolated tenant sandbox, then tears down.
- **Agent B — Pre-Commit Audit Agent:** AI-powered upgrade of `tools/pre-review-audit.sh` that runs on staged diffs with context-aware analysis.
- **Agent C — Multi-Agent Review:** 10 parallel subagents that review commits against platform invariants.

---

## Agent A: E2E Smoke Test Agent

### Architecture

Three layers, each with a single responsibility:

```
Layer 1: Route Manifest Generator  (build-time, deterministic, no AI)
         ↓ route-manifest.json
Layer 2: Test Sandbox Manager      (creates/destroys isolated tenant)
         ↓ Sandbox { tenantId, projectId, agentId, sessionId, authToken }
Layer 3: E2E Executor Agent        (Claude Agent SDK — generates payloads, calls APIs, asserts)
         ↓ Structured test report
```

### Layer 1: Route Manifest Generator

A TypeScript script that statically analyzes `route.ts` files to produce a JSON manifest.

**Input:** All `route.ts` files under `apps/studio/src/app/api/` and `apps/runtime/src/routes/`.

**Output:** `tools/agents/e2e-smoke/route-manifest.json` (gitignored, regenerated via `pnpm manifest:generate`).

**Schema:**

```typescript
interface RouteManifest {
  generatedAt: string;
  studioRoutes: RouteEntry[];
  runtimeRoutes: RouteEntry[];
}

interface RouteEntry {
  path: string; // "/api/projects/[id]/agents/[agentId]/dsl"
  methods: string[]; // ["GET", "POST", "PUT", "DELETE"]
  auth: 'tenant' | 'project' | 'admin' | 'public' | 'unknown';
  pathParams: string[]; // ["id", "agentId"]
  queryParams?: string[];
  category: string; // "agents", "sessions", "connections", etc.
  dependencies: string[]; // routes that must run first
  source: string; // relative file path
}
```

**Auth detection:** Parses route files for `requireAuth`, `createUnifiedAuthMiddleware`, `requireProjectPermission`, `requirePlatformAdmin`, or public patterns. Falls back to `"unknown"` if ambiguous.

**Unknown auth handling:** Routes with `auth: "unknown"` are attempted with the tenant-scoped token. Failures on unknown-auth routes are recorded but not counted as hard failures in the pass/fail summary — they appear in a separate "Unknown Auth" section of the report.

**Dependency inference:** Derived from path params — if a route contains `[agentId]`, it depends on a route that creates agents (`POST /api/projects/[id]/agents`).

### Layer 2: Test Sandbox Manager

A TypeScript module that creates and destroys an isolated tenant workspace.

```typescript
interface SandboxConfig {
  studioUrl: string; // default: http://localhost:5173
  runtimeUrl: string; // default: http://localhost:3112
  adminToken: string; // platform admin JWT
}

interface Sandbox {
  tenantId: string;
  projectId: string;
  agentId: string;
  sessionId: string;
  authToken: string; // tenant-scoped JWT
  cleanup: () => Promise<void>;
}
```

**Setup sequence (dependency order):**

1. Create tenant directly via MongoDB (`Tenant.create()`) — slug: `e2e-smoke-{timestamp}`. Direct DB creation is used because no public tenant CRUD API exists yet; this is acceptable for test infrastructure that runs in dev/CI environments only.
2. Create user + get tenant-scoped auth token via `POST /api/auth` (dev login)
3. Create project via `POST /api/projects`
4. Create minimal agent with bare-bones DSL
5. Create session for session-dependent routes

**Prerequisite:** The sandbox manager imports Mongoose models from `@agent-platform/database/models` for tenant creation and cleanup. This means the sandbox script must run within the monorepo context (not as an isolated package).

**Teardown sequence (reverse order):**

1. Delete session → agent → project → tenant
2. Verify: GET on each returns 404 (cascade confirmed)

**Crash safety:**

```typescript
export async function withSandbox(
  config: SandboxConfig,
  fn: (sandbox: Sandbox) => Promise<void>,
): Promise<void> {
  const sandbox = await createSandbox(config);
  try {
    await fn(sandbox);
  } finally {
    await sandbox.cleanup();
  }
}
```

**Stale sandbox protection:** Tenants with slug prefix `e2e-smoke-` older than 1 hour are eligible for automatic cleanup via `pnpm e2e:cleanup-stale`.

### Layer 3: E2E Executor Agent

Claude Agent SDK agent that reads the manifest and executes each route.

**Configuration:**

- Model: `claude-sonnet-4-6` (cost-effective for payload generation + HTTP response interpretation)
- Tools: `Read`, `Bash`, `Glob`, `Grep`
- Permission mode: `bypassPermissions` with `allowDangerouslySkipPermissions: true` (automated, no human in loop — agent can run curl and read files but sandbox isolation limits blast radius)
- Max turns: 200
- Max budget: `maxBudgetUsd: 10.0` (prevents runaway costs during development)

**Per-route execution:**

1. Read route entry from manifest
2. Substitute path params with sandbox IDs
3. Generate realistic payload based on method + path context
4. Execute via curl
5. Assert: 2xx response (or expected 4xx for edge cases)
6. Record: route, method, status, latency, pass/fail, error detail

**Execution phases (following dependency graph):**

| Phase | Routes               | Purpose                                       |
| ----- | -------------------- | --------------------------------------------- |
| 1     | Tenant/Project       | Verify sandbox entities via GET               |
| 2     | Agent CRUD           | Create, read, update agent resources          |
| 3     | Session + Chat       | Session lifecycle, chat messaging             |
| 4     | Configuration        | Guardrails, models, channels, settings        |
| 5     | Read-only            | Analytics, usage, audit, topology             |
| 6     | Cleanup verification | Sandbox handles deletion, agent verifies 404s |

**Output — structured report:**

```
E2E Smoke Test Report — {timestamp}
Tenant: e2e-smoke-{id} | Project: e2e-proj-001

PASS: 298/327 Studio | 79/85 Runtime
FAIL: 29 Studio | 6 Runtime
SKIP: 0

Failures:
  FAIL  POST /api/projects/[id]/connections/oauth/initiate  → 500 (missing OAuth provider)
  FAIL  GET  /api/search-ai/indexes/[id]/vocabulary         → 404 (no search-ai running)

Coverage: 91.3% of manifest routes exercised
Duration: 4m 32s
```

---

## Agent B: Pre-Commit Audit Agent

### Purpose

AI-powered upgrade of the existing `tools/pre-review-audit.sh` (213 lines, 9 grep patterns). Runs on staged diff only for speed.

### What It Adds Over the Shell Script

| Shell script (existing)     | Agent (new)                                                                    |
| --------------------------- | ------------------------------------------------------------------------------ |
| Grep-based pattern matching | Context-aware analysis (understands test helpers, knows when findById is safe) |
| 9 fixed patterns            | Dynamic — can catch novel anti-patterns                                        |
| No cross-file reasoning     | Can read source files for context when a diff is ambiguous                     |
| Binary pass/fail            | Confidence-rated findings (high/medium/low)                                    |

### Checks

1. `findById()` without tenantId scoping
2. Prisma patterns where Mongoose is required
3. `console.log` in server code (should use `createLogger`)
4. Empty `.catch` blocks
5. Imports from non-existent exports
6. Missing `irSourceHash` propagation in session paths
7. `(err as Error).message` instead of safe `err instanceof Error` pattern
8. In-memory Maps without size/TTL limits
9. Direct DB calls in route handlers (should use repo/service layer)

### Configuration

- Model: `claude-haiku-4-5` (fast + cheap)
- Tools: `Read`, `Grep` (can read source for context, but no writes)
- Max turns: 8
- Target: <30 seconds (SDK cold start ~5-10s + Haiku inference)
- Input: `git diff --cached --unified=5`
- Fallback: If API is unreachable or times out at 30s, falls back to existing `pre-review-audit.sh`

**Why not the raw Claude API?** The Agent SDK's `Read` and `Grep` tools let the agent pull surrounding context when a diff is ambiguous (e.g., checking whether a `findById` is inside a test helper). A raw API call would require pre-bundling all context into the prompt, making it either incomplete or token-heavy. If the 30s target proves too tight in practice, we can revisit with a direct API approach.

### Integration

Can be wired as a git pre-commit hook or run manually via `pnpm audit:pre-commit`. Not blocking by default — outputs warnings alongside the existing shell script.

---

## Agent C: Multi-Agent Review

### Purpose

Automates the manual 5-pass audit workflow (expanded to 10 focused subagents). Runs post-commit on demand.

### Subagents

| #   | Name                       | Focus                    | Key Checks                                                                                                                                             |
| --- | -------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `runtime-logic`            | Service logic            | Race conditions, error handling, missing awaits, break conditions                                                                                      |
| 2   | `studio-react`             | React components         | Missing keys, stale closures, useEffect cleanup, incorrect prop types                                                                                  |
| 3   | `security`                 | Security vulnerabilities | SSRF, injection, credential exposure, stack trace leaks                                                                                                |
| 4   | `api-contracts`            | API consistency          | Response envelope `{ success, data, error }`, correct status codes, error shapes                                                                       |
| 5   | `db-models`                | Schema + data            | Index coverage, migration safety, field type changes, missing defaults                                                                                 |
| 6   | `performance`              | Performance              | N+1 queries, unbounded loops, missing pagination, large payload serialization, in-memory Map size/TTL limits                                           |
| 7   | `stateless-pod`            | Stateless enforcement    | In-memory Maps without Redis/Mongo backing, singleton state that breaks on pod restart, missing distributed locks, file-system writes in request paths |
| 8   | `tenant-project-isolation` | Resource isolation       | Every query scoped to tenantId/projectId, no findById without tenant, cross-tenant returns 404 not 403, project permission checks                      |
| 9   | `acl-permissions`          | Auth + RBAC              | requireAuth on every route, requireProjectPermission with correct operation, no custom JWT verification, permission escalation paths                   |
| 10  | `architecture-separation`  | Clean architecture       | Route files thin (<100 LOC), business logic in services not routes, no direct DB in routes, repo pattern, no domain coupling in engine                 |

### Configuration

- Orchestrator model: `claude-sonnet-4-6`
- Subagent model: `sonnet` (explicitly set — each subagent inherits Sonnet for consistent cost/quality)
- Orchestrator tools: `Read`, `Glob`, `Grep`, `Bash`, `Agent`
- Subagent tools: `Read`, `Glob`, `Grep` (read-only — no mutations)
- Max turns: 50 (orchestrator), subagents run to completion
- Max budget: `maxBudgetUsd: 5.0` (10 subagents on Sonnet)

### Orchestrator Responsibilities

1. Get the diff for the target commit(s)
2. Dispatch all 10 subagents in parallel
3. Collect findings from each
4. Deduplicate by file:line (multiple subagents may flag the same line)
5. Pick highest severity when duplicates found (severity ranking: security > isolation > acl > stateless > performance > architecture > api-contracts > db-models > runtime-logic > studio-react)
6. Filter: only surface high-confidence findings
7. Output unified markdown report

### Output Format

```markdown
# Multi-Agent Review Report — {commit_sha}

## Critical (must fix)

- **[security]** `apps/runtime/src/routes/sessions.ts:45` — findById without tenantId
- **[stateless-pod]** `apps/runtime/src/services/cache.ts:12` — in-memory Map with no TTL

## Warnings

- **[performance]** `apps/studio/src/hooks/useAgentList.ts:30` — unbounded fetch in useEffect
- **[architecture]** `apps/runtime/src/routes/agents.ts:180` — direct DB query in route handler

## Info

- **[api-contracts]** `apps/studio/src/app/api/projects/route.ts:55` — missing error envelope on 400

Reviewed by: 10 agents | Duration: 2m 15s | Findings: 3 critical, 5 warnings, 2 info
```

### Cost Estimate

~$0.50-1.50 per review run depending on diff size. Appropriate for post-commit or pre-PR, not for every save.

---

## Project Structure

```
tools/agents/
├── e2e-smoke/
│   ├── executor.ts              # Agent A — E2E executor
│   ├── sandbox.ts               # Tenant sandbox manager
│   ├── manifest-generator.ts    # Route manifest builder
│   ├── cleanup-stale.ts         # Stale sandbox cleanup
│   └── route-manifest.json      # Generated (gitignored)
├── pre-commit-audit.ts          # Agent B
├── multi-review.ts              # Agent C
├── prompts/
│   ├── e2e-executor.md          # System prompt for E2E agent
│   ├── pre-commit.md            # System prompt for audit agent
│   ├── runtime-reviewer.md      # Subagent prompt
│   ├── studio-reviewer.md
│   ├── security-reviewer.md
│   ├── api-reviewer.md
│   ├── db-reviewer.md
│   ├── performance-reviewer.md
│   ├── stateless-reviewer.md
│   ├── isolation-reviewer.md
│   ├── acl-reviewer.md
│   └── architecture-reviewer.md
└── package.json                 # standalone (not a workspace package — avoids Dockerfile churn)
```

**Root package.json scripts:**

```json
{
  "manifest:generate": "tsx tools/agents/e2e-smoke/manifest-generator.ts",
  "e2e:smoke": "tsx tools/agents/e2e-smoke/executor.ts",
  "e2e:cleanup-stale": "tsx tools/agents/e2e-smoke/cleanup-stale.ts",
  "audit:pre-commit": "tsx tools/agents/pre-commit-audit.ts",
  "review:multi": "tsx tools/agents/multi-review.ts"
}
```

---

## Dependencies

- `@anthropic-ai/claude-agent-sdk` — Agent SDK (TypeScript), installed in `tools/agents/package.json` (standalone, not a pnpm workspace package — avoids adding COPY lines to every Dockerfile)
- `tsx` — Already in root devDependencies for running TS scripts
- `ANTHROPIC_API_KEY` — Required env var for all agents
- `@agent-platform/database` — Used by sandbox manager for direct tenant creation (imported from monorepo)

**Standalone package approach:** `tools/agents/` has its own `package.json` with `@anthropic-ai/claude-agent-sdk` as a dependency. Run `cd tools/agents && npm install` separately. The scripts in root `package.json` invoke via `tsx` which resolves monorepo imports normally. This avoids adding the SDK to the monorepo dependency graph and prevents Dockerfile changes.

No new infrastructure required. All agents run locally against local dev services.

**CI integration:** For Harness CI, add `ANTHROPIC_API_KEY` as a pipeline secret. Agent C can run as a post-build step gated on the `develop` branch. Agent A requires running services (runtime + studio) so it's best suited for local dev or a dedicated CI environment with `docker-compose up`.

---

## Out of Scope (Future Work)

- Playwright browser-driven UI testing (Phase 2)
- Load/stress testing
- Continuous monitoring agent (codebase health)
- Migration script generator agent
- Environment config validator agent

These are candidates for future spec cycles.

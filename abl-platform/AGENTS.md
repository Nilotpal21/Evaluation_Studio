# AGENTS.md

CRITICAL: NEVER switch branches or run "git checkout" unless explicitly instructed by the user.
CRITICAL: Only work on the current branch. Do not create new branches without explicit user approval.
CRITICAL: NEVER add "Co-Authored-By" lines to commit messages.

Run `pnpm build` before `pnpm test` — Turbo enforces build order and tests will fail on stale compiled output.

CRITICAL: Always run `npx prettier --write <files>` on all changed files BEFORE `git commit`. The pre-commit hook runs lint-staged with `prettier --check`. If check fails, lint-staged's stash/restore cycle will **silently revert your uncommitted edits** to their pre-edit state, losing work. A PreToolUse hook (`.claude/hooks/prettier-before-commit.sh`) auto-formats staged files before commit as a safety net, but agents should STILL run prettier explicitly after editing — the hook is a backstop, not a replacement.

CRITICAL FOR AGENT/TEAM PROMPTS: When spawning agents (via Agent tool or TeamCreate), ALWAYS include these instructions in the prompt: "Run `npx prettier --write <files>` on ALL changed files before finishing your task. lint-staged WILL silently revert your work if files aren't formatted." and "If a commit is part of your task, use the JIRA key I provide. Never invent ticket IDs or auto-create a duplicate ticket."

## JIRA Workflow

CRITICAL: Every non-merge commit must start with a real JIRA key: `[ABLP-123] type(scope): description`. Never invent placeholder keys.

CRITICAL: If the user asks for a commit or PR and no ticket key is provided, first look for an existing relevant ticket. If none exists, create one before committing. Do not create JIRA tickets for pure exploration, debugging, or uncommitted local work unless the user explicitly asks or a commit/PR is required.

CRITICAL: Default to the `ABLP` Jira project unless the user, repo context, or existing work clearly points to a different project.

CRITICAL: Do NOT `source .env` to load Jira credentials. This repo's `.env` is not guaranteed to be shell-safe. Read only the needed keys (`JIRA_BASE_URL` or `ATLASSIAN_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` or `ATLASSIAN_API_KEY`, optional `JIRA_PROJECT_KEY`) and never print secrets.

CRITICAL: Prefer `pnpm jira:update -- <TICKET> ...` for Jira comments/description/label updates. It reuses Helix's ADF update path and loads only the allowed Jira keys from `.env` without sourcing the file.

CRITICAL: When you create a Jira ticket during the task, map the work back after commit by using the ticket key in the commit header and, when practical, adding the commit SHA or PR link back to the ticket.

## Quick Reference

- Monorepo: pnpm + Turbo. Docker for all infra (see `docker-compose.yml`).
- Runtime (3112), SearchAI (3005), SearchAI-Runtime (3004), Studio (5173), Admin (3003)
- Python services: Docling (8080), BGE-M3 (8000), Preprocessing (8003)
- Port constants: `packages/config/src/constants.ts`
- Three repos: abl-platform (source), abl-platform-deploy (helm/argocd), abl-platform-infra (terraform)

## Core Invariants

> Full details with examples and rules in the `platform-principles` skill.

1. **Resource Isolation**: Scope every query to the appropriate ownership level:
   - **Tenant**: Every query includes `tenantId`. Use `findOne({_id, tenantId})`, never `findById`.
   - **Project**: Use `requireProjectPermission(req, res, 'obj:op')`, verify `resource.projectId === req.params.projectId`. Routes under `/api/projects/:projectId/...`.
   - **User**: Filter by `createdBy`/`ownerId`. Users must not access other users' resources even within the same tenant/project.
   - **Session-derived resources**: Inherit the source session's owner via `Session.source`. Public/channel sessions scope to `tenantId` + end-user identity (`contactId`, `customerId`, `anonymousId`, or channel artifact). Studio debug sessions scope to `tenantId` + `projectId` + project-role permission; they are project-owned, not owned by the workspace user who created them.
   - Cross-scope access returns **404** (not 403) to avoid leaking existence.
2. **Centralized Auth**: Use `createUnifiedAuthMiddleware`/`requireAuth`. Never custom token verification. Permissions via `requirePermission()`. API keys/platform keys are machine principals: authorize them by explicit scopes and project scope only — never by creator membership or owner fallback.
3. **Stateless Distributed**: No pod-local state as truth. Redis/MongoDB for all shared state. Distributed locks via Redis `SET NX PX`.
4. **Traceability**: Every execution path emits `TraceEvent`s via shared `TraceStore`. No ad-hoc logging as substitute.
5. **Compliance**: Encryption at rest/transit, data minimization with TTLs, right to erasure cascades, audit logging.
6. **Performance**: Compress before storing (async gzip), validate payload size at boundaries, batch operations, conversation sliding windows.

## Model Resolution Contract

When changing runtime model selection, `AgentIR` hashing, or any LLM cache key, preserve this contract:

1. **Full model resolution is user-scoped.**
   `ModelResolutionService.resolve()` is credential-bearing and budget-aware. Its cache key must include `userId` because user-scoped credential policy can change success or failure for the same model snapshot.
2. **Reasoning settings resolution is settings-only.**
   `ModelResolutionService.resolveReasoningSettings()` exists for prompt-builder / thinking pre-resolution. It must stop before user-scoped credential policy and before per-call budget reservation.
3. **Reasoning-settings caches must not key on `userId`.**
   They should key on tenant/project/agent plus the versioned reasoning snapshot (`settingsVersionId`, deployment overrides, and resolution-relevant `AgentIR.execution` fields).
4. **Full `AgentIR` hashes are broader than model-resolution hashes.**
   `SessionService.computeIRHash()` and `session.configHash` represent whole-agent identity. Do not use them as model-resolution invalidation keys unless the resolution pipeline actually reads that field.
5. **Update the canonical guide and tests together.**
   When this contract changes, update `docs/guides/model-resolution-cache-versioning.md` and `apps/runtime/src/__tests__/model-resolution-versioning.test.ts` in the same change.

## Design Handoff Expectations

For critical isolation, auth, compliance, or encryption features, do not move to HLD with a thin feature/test spec. Before HLD, the feature and test specs should capture the operational contract clearly enough that architecture work is about solution design, not rediscovering missing requirements.

Minimum pre-HLD expectations for these features:

1. **Define the type/contract vocabulary up front.**
   Add a short terminology table when multiple related terms exist (for example `ExecutionScope` vs `SessionScope` vs concrete variants) so HLD is not forced to reverse-engineer the intended hierarchy.
2. **State the fail-closed contract explicitly.**
   For boundary validation or isolation work, include the expected response behavior (`400` vs `401` vs non-leaky `404`) and the stable error-envelope shape before HLD begins.
3. **Include a threat-model summary.**
   Summarize protected assets, abuse paths, and primary mitigations for critical security/isolation work. HLD should refine this, not invent it from scratch.
4. **Show rollout and rollback shape.**
   If the feature uses modes like `audit` / `warn` / `enforce`, the spec and test plan must cover both forward rollout and rollback safety.
5. **Distinguish current vs target coverage honestly.**
   In test mapping tables, use `Current Type` and `Target Type` when existing tests are unit-level today but are expected to become integration/E2E coverage later. Never present aspirational coverage as current reality.
6. **Resolve or explicitly escalate HLD-blocking questions.**
   Open questions that affect type shape, migration architecture, compatibility lanes, or rollback strategy must be decided before HLD or called out as explicit HLD blockers.
7. **Add split criteria when scope is broad.**
   If one feature spec spans multiple cross-cutting areas, state when it should split into sibling sub-features instead of allowing boundary-fix work to be blocked by reporting, Studio, or crypto follow-ons.
8. **Estimate migration magnitude early.**
   Features that require backfill, quarantine, re-encryption, or compatibility lanes should produce a migration volume estimate as an HLD input, not defer sizing entirely to implementation.

## User-Facing Runtime Error Sanitization

When surfacing runtime or model-configuration failures to users:

1. **Logs may keep raw context.** Tenant IDs, model IDs, provider names, and deep remediation details belong in server logs and traces.
2. **User-visible surfaces must be sanitized.** Chat banners, API errors, execution diagnostics, and session health/configuration messages must use shared sanitizer helpers and must not leak tenant IDs, model IDs, credential hints, or internal remediation text.
3. **Fix downstream formatters too.** Sanitizing the throw site alone is not enough if a later classifier or presenter reuses the raw message. Patch the downstream surface that renders the message and add regression coverage there.

## Type Safety — Read Before You Write

CRITICAL: Before using ANY existing component, function, type, or module in new or modified code, you MUST read its source to verify the actual signature. Never assume prop names, parameter types, or return types.

**Why:** Codex agents repeatedly generate code against _imagined_ APIs (e.g., `<KPICard label={...} icon={...}>` when the real signature is `<KPICard title={...}>`). This creates build errors that cascade across files.

**Rules:**

1. **Read the type/component source** before using it. If you're passing props to `<KPICard>`, read `KPICard`'s definition first.
2. **Read the logger signature** before logging. This project uses `log.error('message', { context })` — NOT pino-style `log.error({ context }, 'message')`.
3. **Read the import source** before importing. If you write `import { foo } from './bar'`, verify `foo` is actually exported from `bar`.
4. **Run `pnpm build --filter=<package>` after creating or modifying files** to catch type errors immediately — don't defer to the end.
5. **When spawning agents**, include: "BEFORE using any existing component/function/type, READ its source file to verify the actual signature. Never guess prop names or parameter types."

**A PreToolUse hook (`.claude/hooks/typecheck-before-commit.sh`) runs `tsc --noEmit` on affected packages before every commit. If it fails, the commit is blocked.**

## Studio Route Handler Gotchas

CRITICAL: Studio Next.js API routes do NOT have AsyncLocalStorage tenant injection.

1. **Always scope Studio queries explicitly.** Every Mongoose query in `apps/studio` route handlers must include `tenantId: user.tenantId`. Never rely on ALS/database plugins to auto-scope Studio requests.
2. **`validateBody()` consumes the request body.** Reject unknown fields with Zod `.strict()` instead of calling `request.clone().json()` after validation and assuming the body is still safe to read again.

## Key Rules

> Full coding standards, anti-patterns table, and detailed rules in the `code-standards` skill.

- Never `console.log` in server code — use `createLogger('module')` from `@abl/compiler/platform`
- Never `.catch(() => {})` — log or propagate every error
- `err instanceof Error ? err.message : String(err)` — never `(err as Error).message`
- `fs.promises` for all file I/O in server code — no sync I/O in async paths
- No `any` where structured types exist — use discriminated unions
- No inline magic numbers — named constants or config
- **Zod ID validation**: Use `z.string().min(1)` for ID fields (`projectId`, `tenantId`, `agentName`, etc.) — NEVER `.cuid()`, `.cuid2()`, `.nanoid()`, `.ulid()`. Our IDs are UUIDs or custom strings, not CUIDs. A PreToolUse hook (`.claude/hooks/zod-id-lint.sh`) blocks this pattern.
- Provider-neutral LLM types: `LLMToolDefinition`, `LLMToolCall`, `LLMToolResult`
- No domain-specific field names in engine code — use IR metadata
- Every in-memory `Map` needs max size, TTL, and eviction
- Return `{ success, data?, error?: { code, message } }` on failure — not `{}`
- **Project isolation in routes**: Every query in a project-scoped route (`/api/projects/:projectId/...`) MUST include `projectId` in the filter. A PreToolUse hook (`.claude/hooks/project-isolation-lint.sh`) warns on potential gaps.
- **User isolation**: User-owned resources (API keys, personal tokens, personal credentials) MUST filter by `userId`/`createdBy`. Session-derived resources MUST dispatch on `Session.source`: public/channel sessions use end-user identity; Studio sessions use project RBAC. A PreToolUse hook (`.claude/hooks/user-isolation-lint.sh`) warns on potential gaps.
- **Express route ordering**: Static routes (`/tab-stats`, `/review`, `/stats/:canonicalSchemaId`) MUST be registered BEFORE parameterized routes (`/:mappingId`). Express matches top-down — a `/:id` route will capture `/tab-stats` as `id="tab-stats"` if registered first.
- **Versioned protocol compatibility**: When changing runtime↔SDK/WebSocket contracts for separately published clients, keep rollout shims narrow, explicit, and outside the steady-state typed contract. Accept legacy payloads only in a compatibility branch and remove the shim only after older bundles are no longer expected.
- **Boundary metadata normalization**: Validate per-message or per-channel metadata at the entry point, forward canonical `messageMetadata` into execution, and keep reserved transport keys (for example `history` during A2A handoff) out of generic metadata forwarding.
- **Dockerfile package.json sync**: When adding a new `packages/<name>/` workspace package, add its `COPY packages/<name>/package.json packages/<name>/package.json` line to **every** Dockerfile under `apps/` that uses `pnpm install --frozen-lockfile`. Without this, pnpm cannot resolve the dependency graph and builds fail with missing modules. Check: `apps/runtime/Dockerfile`, `apps/search-ai/Dockerfile`, `apps/admin/Dockerfile`, `apps/studio/Dockerfile`.
- **Security scanning**: Run `./tools/run-semgrep.sh` before PRs touching security-sensitive code (auth, crypto, HTTP handlers, user input)
- **E2E test quality**: E2E tests must NOT mock codebase components (`vi.mock`, `jest.mock`), must NOT access the DB directly (Mongoose models), and must only interact via HTTP API. Prefer the architecturally correct solution over the easy path. A PreToolUse hook (`.claude/hooks/e2e-test-quality-lint.sh`) blocks violations.
- **Unused imports**: `noUnusedLocals` is NOT enabled in tsconfig — enable it in root `tsconfig.json` to catch stale imports via `tsc --noEmit`. Until then, manually verify imports are used when editing files.

## E2E Test Principles

CRITICAL: E2E tests validate the system as a black box through its public API surface. They exist to catch the bugs that unit tests with mocks will always miss — auth gaps, middleware ordering, serialization fidelity, race conditions under concurrency.

**Why this matters:** We had A2A tests pass 55/55 while auth was completely missing, session creation had a race condition, and history forwarding mangled structured content. Every test mocked the components that contained the bugs.

### Rules

1. **No mocking existing components.** E2E tests must NOT use `vi.mock()`, `jest.mock()`, or `vi.spyOn()` to replace modules that exist in the codebase. If a component is too hard to test without mocking, that's a design problem — fix the design, don't mock around it. The only acceptable test doubles are for **external services** (third-party APIs, LLM providers) injected via DI.

2. **API-only interaction.** E2E tests must interact exclusively through HTTP API endpoints (fetch, supertest). Never import Mongoose models, never query the DB directly, never call internal functions. Seed data via POST endpoints. Assert via GET responses. If there's no API to seed/assert what you need, that's a missing API — add it.

3. **Real servers, real middleware.** Start actual Express servers on random ports (`{ port: 0 }`). The test must exercise the full middleware chain: auth, rate limiting, tenant isolation, input validation. Stubbed infrastructure (`portA = 0; // TODO`) is not a test — it's a comment.

4. **Architecturally correct solutions.** Never take the easy path when it compromises test fidelity. If testing auth requires setting up encryption services and key generation, do that. If testing concurrency requires `Promise.all` with artificial delays, do that. A test that passes by avoiding the hard parts is worse than no test — it creates false confidence.

5. **Test the boundaries, not the internals.** E2E tests should verify:
   - Auth enforcement (valid/invalid/missing credentials)
   - Tenant and project isolation (cross-tenant returns 404, not data)
   - Concurrency safety (parallel requests, race conditions)
   - Serialization fidelity (structured data survives round-trips)
   - Error responses (correct status codes, no internal detail leaks)
   - Full middleware chain (routes mounted in correct order, middleware applied)

6. **No TODO stubs in committed tests.** A test file with commented-out infrastructure and hardcoded `port = 0` must not be committed. Either wire it up fully or don't create the file. `test.todo()` is acceptable for documenting planned coverage, but the surrounding infrastructure must be real.

### Anti-Patterns (BLOCKED by `.claude/hooks/e2e-test-quality-lint.sh`)

| Anti-Pattern                                                | Why It's Dangerous                            | Correct Approach                                                                        |
| ----------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------- |
| `vi.mock('@a2a-js/sdk/server')` in E2E test                 | Replaces the thing you're testing             | Start a real A2A server with the SDK                                                    |
| `const getConnection = vi.fn().mockResolvedValue(...)`      | Bypasses auth and connection middleware       | Hit the real `/a2a/:connectionId` endpoint                                              |
| `await ChannelConnection.create({...})` in test             | Bypasses API validation and auth              | `POST /api/projects/:pid/channel-connections`                                           |
| `portA = 0; // TODO: wire up`                               | Test never actually runs                      | `server.listen(0); port = server.address().port`                                        |
| Testing regex in isolation instead of through middleware    | Proves the regex works, not that it's applied | Send invalid input via HTTP, assert 400                                                 |
| `history: [{ role: 'user', content: 'plain string' }]` only | Misses `ContentBlock[]` serialization bugs    | Test with structured content: `[{ type: 'text', text: '...' }, { type: 'image', ... }]` |

**Workflow E2E tests** live in `apps/studio/e2e/workflows/`. Read `agents.md` in that folder BEFORE adding or modifying workflow tests. After completing work, update that `agents.md` so folder layout, coverage tables, testid registry, helper patterns, and learnings stay in sync.

## Debugging Runtime Issues

CRITICAL: When a user reports a runtime bug (empty response, agent error, unexpected behavior), use the MCP debug tools FIRST — before reading source code.

Quick diagnosis sequence:

1. `debug_connect` — connect to runtime (local: localhost:3112)
2. `debug_diagnose` — full diagnosis (config + execution + traces)
3. `debug_inspect` — agent config inspection (model chain, credentials, tools)
4. `debug_get_errors` — all errors and warnings from traces

Common symptoms and first tool to use:
| Symptom | First Tool | What to Look For |
| ------------------- | ------------------------- | -------------------------------------------------------------------- |
| Empty response | `debug_diagnose` | Model not configured, credential missing, all reasoning disabled |
| Agent init error | `debug_inspect` | Model chain resolution, credential availability |
| Wrong agent responds | `debug_analyze_session` | Handoff routing, decision logs |
| Session hangs | `debug_analyze_session` | Gather stalls, loop detection, tool timeouts |
| Tool call fails | `debug_get_errors` | Tool binding errors, HTTP failures, schema mismatches |

## Doc Sync & Wiring Verification

CRITICAL: During `/post-impl-sync` or manual doc refresh, verify production reachability — not just code existence.

1. **Verify file paths first.** Run `rg --files` for every implementation or test path before adding it to feature specs, test guides, inventories, or gap tables.
2. **Separate implemented from wired.** A route, component, or helper can exist in code and still be unreachable from the production entry point (`server.ts`, public SDK barrel, Studio route/build surface, etc.).
3. **Track production wiring explicitly.** Test guides should include a "Production Wiring Verification" section when reachability is a risk; this is distinct from E2E and integration coverage.
4. **Keep E2E claims honest.** A first deterministic public-API regression means the feature no longer has zero E2E coverage, but the overall testing index should stay `PARTIAL` until the broader scenario family is covered.
5. **Require wiring evidence.** LLD wiring checklist items need mount/import/caller traces or equivalent proof, not just "the file exists".

## Skills Reference

Detailed domain knowledge has been moved to on-demand skills to save context:

| Skill                            | Use When                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `platform-principles`            | Planning features, code review, architecture decisions                                                             |
| `code-standards`                 | Writing or reviewing any code                                                                                      |
| `studio-design-system`           | Working on `apps/studio/` UI (colors, typography, animations, components)                                          |
| `search-ai-development`          | Working on SearchAI ingestion pipeline, workers, or LLM credential resolution                                      |
| `infrastructure-guide`           | Debugging connections, Docker ports, service setup, cross-repo work                                                |
| `i18n-guide`                     | Adding user-facing strings, error messages, localization                                                           |
| `bullmq-flows-guide`             | Debugging BullMQ Flows, implementing PipelineFlowBuilder, Redis memory, stalled jobs, flow scaling                 |
| `analytics-pipeline-development` | Designing or implementing any analytics pipeline (intent, sentiment, quality eval, anomaly detection, etc.)        |
| `design-quality-gate`            | Writing design docs, RFCs, or implementation plans — ensures 12 architectural concerns are addressed               |
| `pre-review-checklist`           | Before submitting a PR — catches recurring review findings (isolation, auth, logging, error handling)              |
| `cross-cutting-concerns`         | Adding new endpoints, services, or workers — ensures security, isolation, observability built in                   |
| `architecture-simplification`    | Refactoring routes, extracting services, splitting packages, reducing codebase complexity                          |
| `refactoring-safety`             | Large refactors — strangler pattern, shadow mode, parity testing to prevent regressions                            |
| `search-ai-connectors`           | Working on connector packages, sync workers, OAuth, delta sync, permissions, discovery, or building new connectors |
| `coverage-ramp`                  | Adding tests, setting coverage targets, deciding what to test first for maximum impact                             |
| `devops-query`                   | Querying Harness CI/CD builds, Coroot service health, deployment failures, logs, compound debugging queries        |
| `testing-toolkit`                | Live E2E testing — API, UI browser automation, MongoDB, PM2 logs. Mandates writing results to `docs/testing/`      |
| `data-flow-audit`                | Generic framework for auditing field propagation across any multi-layer feature — catches omission bugs            |
| `data-propagation-audit`         | Auth-profile-specific audit — traces OAuth fields across schema, catalog, UI, OAuth, and refresh layers            |
| `runtime-debugging`              | Debugging runtime agent issues — empty responses, credential errors, model resolution, session hangs               |
| `load-test-analysis`             | Running k6 load tests on Grafana Cloud, fetching k6 + Coroot metrics, analyzing saturation results                 |
| `capacity-planner`               | Saturation testing, auto-scaling verification, capacity planning — step-wise k6 + kubectl polling with JSON output |
| `feature-spec`                   | Generating feature specs in `docs/features/` — asks clarifying questions, uses TEMPLATE.md                         |
| `test-spec`                      | Generating test specs in `docs/testing/` — mandates E2E + integration scenarios                                    |
| `hld`                            | Generating High-Level Design in `docs/specs/` — addresses 12 architectural concerns                                |
| `lld`                            | Generating LLD + implementation plan in `docs/plans/` — phased with exit criteria                                  |
| `implement`                      | Executing LLD phase-by-phase — preflight, exit criteria, pr-reviewer audit (5 rounds), wiring verification         |
| `post-impl-sync`                 | Syncing docs after implementation — updates feature spec, test matrix, design doc status                           |

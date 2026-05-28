# CLAUDE.md

CRITICAL: NEVER switch branches or run "git checkout" unless explicitly instructed by the user.
CRITICAL: Only work on the current branch. Do not create new branches without explicit user approval.
CRITICAL: NEVER add "Co-Authored-By" lines to commit messages.

Run `pnpm build` before `pnpm test` — Turbo enforces build order and tests will fail on stale compiled output.

**Structured test failure capture:** Use `pnpm test:report` instead of `pnpm test` to run all tests once and produce a structured failure log in `test-reports/` (gitignored). Fix from `test-reports/SUMMARY.md` instead of iterating run-fix-run cycles. See `tools/test-capture.ts` for flags (`--filter`, `--skip-build`, `--parallel`, `--tier`).

CRITICAL: Always run `npx prettier --write <files>` on all changed files BEFORE `git commit`. The pre-commit hook runs lint-staged with `prettier --check`. If check fails, lint-staged's stash/restore cycle will **silently revert your uncommitted edits** to their pre-edit state, losing work. A PreToolUse hook (`.claude/hooks/prettier-before-commit.sh`) auto-formats staged files before commit as a safety net, but agents should STILL run prettier explicitly after editing — the hook is a backstop, not a replacement.

CRITICAL FOR AGENT/TEAM PROMPTS: When spawning agents (via Agent tool or TeamCreate), include this block verbatim:

> Run `npx prettier --write <files>` on ALL changed files before finishing — lint-staged silently reverts unformatted edits. Use the JIRA key I provide; never invent ticket IDs or create duplicate tickets. Read existing component/function/type sources before using them — never guess prop names or signatures. Never mock platform components (`vi.mock` of `@agent-platform/*`, `@abl/*`, or relative imports); refactor the code if it's hard to test. E2E tests interact only via HTTP API, no DB access, no TODO stubs. Implement robust, architecturally sound solutions — fix root causes, no shortcuts. Commit often: one concern per commit, max 40 files, max 3 packages, feature commits additive (no deleting existing exports). Run `pnpm build --filter=<package>` after every file change.

## JIRA Workflow

CRITICAL — all of:

- Every non-merge commit starts with a real JIRA key: `[ABLP-123] type(scope): description`. Never invent placeholder keys.
- Default project is `ABLP` unless the user/repo clearly points elsewhere.
- If a commit/PR is needed and no ticket exists, reuse a relevant one first; create one only if none fits. Don't create tickets for pure exploration, debugging, or uncommitted local work.
- Never create duplicate tickets for the same task — one work item owns the commit trail.
- Don't `source .env` for Jira creds (not guaranteed shell-safe). Read only `JIRA_BASE_URL`/`ATLASSIAN_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`/`ATLASSIAN_API_KEY`, optional `JIRA_PROJECT_KEY`. Never print secrets.
- Prefer `pnpm jira:update -- <TICKET> ...` for comments, description updates, and labels (reuses Helix's ADF path; loads keys without sourcing `.env`).
- After commit/PR, map the SHA or PR link back to the ticket when practical.

## Quick Reference

- Monorepo: pnpm + Turbo. Docker for all infra (see `docker-compose.yml`).
- Runtime (3112), SearchAI (3005), SearchAI-Runtime (3004), Studio (5173), Admin (3003)
- Python services: Docling (8080), BGE-M3 (8000), Preprocessing (8003)
- Port constants: `packages/config/src/constants.ts`
- Three repos: abl-platform (source), abl-platform-deploy (helm/argocd), abl-platform-infra (terraform)

## Core Invariants

> Full details with examples and rules in the `platform-principles` skill.

1. **Resource Isolation** — scope every query to the right ownership level. Cross-scope access returns **404**, never 403.
   - **Tenant**: every query includes `tenantId` (use `findOne({_id, tenantId})`, never `findById`).
   - **Project**: routes under `/api/projects/:projectId/...` use `requireProjectPermission(req, res, 'obj:op')` and verify `resource.projectId === req.params.projectId`.
   - **User**: filter by `createdBy`/`ownerId` — users can't access each other's resources even within the same tenant/project.
   - **Session-derived**: dispatch on `Session.source`. Public/channel sessions = `tenantId` + end-user identity (`contactId` > `customerId` > `anonymousId` > channel artifact). Studio debug sessions = `tenantId` + `projectId` + project-role permission (project-owned, not user-owned).
2. **Centralized Auth**: Use `createUnifiedAuthMiddleware`/`requireAuth`. Never custom token verification. Permissions via `requirePermission()`. API keys/platform keys are machine principals: authorize them by explicit scopes and project scope only — never by creator membership or owner fallback.
3. **Stateless Distributed**: No pod-local state as truth. Redis/MongoDB for all shared state. Distributed locks via Redis `SET NX PX`.
4. **Stateless Agent Runtime**: Agent DSL execution (FLOWS, conversation runtime) stays stateless — each step input → output → advance. No in-memory timers, no held state across waits, no polling loops in the agent runtime layer. Durable async patterns (waits, polls, human approval, scheduled triggers, multi-hour orchestrations) belong in the **workflow engine** (`apps/workflow-engine` on Restate). Agents invoke workflows via `type: workflow` tool. PARALLEL in FLOWS is acceptable (synchronous fan-out + join, no state across time); POLL / long-wait constructs in FLOWS are NOT — push them to a workflow.
5. **Traceability**: Every execution path emits `TraceEvent`s via shared `TraceStore`. No ad-hoc logging as substitute.
6. **Compliance**: Encryption at rest/transit, data minimization with TTLs, right to erasure cascades, audit logging.
7. **Performance**: Compress before storing (async gzip), validate payload size at boundaries, batch operations, conversation sliding windows.

## Per-package rules (loaded only when touching the subtree)

- Runtime — model-resolution contract, user-facing error sanitization, MCP debug-tool flow → `apps/runtime/CLAUDE.md`
- Studio — route-handler gotchas (no ALS tenant injection), design-system tokens, workflow E2E layout → `apps/studio/CLAUDE.md`

## Type Safety — Read Before You Write

CRITICAL: Before using ANY existing component/function/type/module, read its source to verify the actual signature. Agents repeatedly generate code against imagined APIs (e.g. `<KPICard label=... icon=...>` when the real prop is `title`), causing cascading build errors.

1. Read the source before using a type/component (props, params, return types).
2. Logger usage: `log.error('message', { context })` — NOT pino-style `log.error({ context }, 'message')`.
3. Verify the import resolves: `import { foo } from './bar'` only if `foo` is actually exported from `bar`.
4. Run `pnpm build --filter=<package>` after every file change — don't accumulate type errors. (`incremental-typecheck.sh` runs `tsc --noEmit` post-write; `typecheck-before-commit.sh` blocks commits with type errors.)
5. Feature commits are additive: never delete exported symbols that have consumers. If a refactor needs removing exports, update consumers in separate edits first.

## Key Rules

Full coding standards in the `code-standards` skill. Hooks under `.claude/hooks/` enforce most of these — the bullets state the rule and name the hook so you know what's caught.

**Code style:**

- Errors: `err instanceof Error ? err.message : String(err)` — never the unchecked `as Error` cast.
- No `any` where structured types exist — use discriminated unions.
- No inline magic numbers — named constants or config.
- Provider-neutral LLM types: `LLMToolDefinition`, `LLMToolCall`, `LLMToolResult`.
- No domain-specific field names in engine code — use IR metadata.
- Every in-memory `Map` needs max size, TTL, and eviction.
- Server logger: `createLogger('module')` from `@abl/compiler/platform` (`console-log-lint.sh` blocks `console.*`).
- No swallowed catches — log or propagate every error (`swallowed-catch-lint.sh`).
- No sync I/O in server async paths — `fs.promises` only (`sync-io-lint.sh`).
- Zod IDs use `z.string().min(1)` — never CUID/CUID2/NanoID/ULID validators (`zod-id-lint.sh` blocks them).
- Unused imports: `noUnusedLocals` is NOT enabled in tsconfig — enable in root `tsconfig.json` for `tsc --noEmit` coverage. Until then, verify imports manually.

**API & wiring:**

- Express route ordering: static routes BEFORE parameterized (Express matches top-down — `/:id` would capture `/tab-stats`).
- Versioned protocol compatibility: keep runtime↔SDK/WS rollout shims narrow, explicit, and outside the steady-state typed contract. Remove only after older bundles are no longer expected.
- Boundary metadata: validate `messageMetadata` at the entry point; forward the canonical shape; keep reserved transport keys (e.g. `history`) out of generic forwarding.
- Dockerfile sync: when adding `packages/<name>/`, add the matching `COPY` line to every `apps/*/Dockerfile` that runs `pnpm install --frozen-lockfile`.
- Centralized auth only — `createUnifiedAuthMiddleware`/`requireAuth`. No custom `jwt.verify` or manual `Authorization` parsing outside `packages/shared-auth/` (`custom-auth-lint.sh`).
- Structured error responses: `{ success, data?, error?: { code, message } }` (`empty-response-lint.sh` blocks `res.json({})`).
- Project isolation: project-scoped routes (`/api/projects/:projectId/...`) filter by `projectId` (`project-isolation-lint.sh`).
- User isolation: user-owned resources filter by `userId`/`createdBy`; session-derived dispatch on `Session.source` (`user-isolation-lint.sh`).
- Cross-boundary field propagation: when adding fields to exported schemas/types or boundary-shaped types (`*Envelope`, `*Metadata`, `*AuthProfile`, `*TraceEvent`, `*ToolCall`, `*ContentBlock`, etc.), verify every consumer in the same change and add/extend parity or round-trip coverage (`field-propagation-lint.sh`, `tools/field-propagation-check.sh`).
- Security scanning: run `./tools/run-semgrep.sh` before PRs touching auth, crypto, HTTP handlers, or user input.

**Tests, exports, deletes, commits (mostly hook-enforced):**

- E2E tests don't mock codebase components, no direct DB, HTTP-only (`e2e-test-quality-lint.sh`; full rules in Test Architecture below).
- Feature commits are additive — no deleting exports that have consumers (`exported-symbol-guard.sh`).
- Don't `rm -rf packages/<name>`/`apps/<name>` (`package-deletion-guard.sh`).
- Signature changes update test mocks in the same change (`stale-mock-warn.sh` warns).
- Commit scope: max 40 files, max 3 packages per commit (`commit-scope-guard.sh`); feat() <30% deletions (`deletion-ratio-guard.sh`).
- Incremental typecheck runs post-`.ts`-write (`incremental-typecheck.sh`); fix errors immediately. Pre-commit typecheck (`typecheck-before-commit.sh`) blocks commits with type errors.
- Studio UI token rules → `apps/studio/CLAUDE.md` (also enforced by `design-token-lint.sh`/`accent-foreground-lint.sh`/`native-select-lint.sh`).

## Test Architecture — Fix the Code, Not the Test

CRITICAL: If code isn't testable without mocking platform components, **refactor the code**. Never paper over bad structure with mocks.

Two hooks enforce this: `.claude/hooks/platform-mock-lint.sh` BLOCKS `vi.mock`/`jest.mock` of `@agent-platform/*`/`@abl/*` (warns on relative-path mocks) in all test files. `.claude/hooks/e2e-test-quality-lint.sh` BLOCKS module mocks, direct DB access, and stubbed infrastructure in E2E test files (warns for integration).

**Universal rules (unit, integration, E2E):**

1. **No mocking internal/platform components.** `vi.mock`/`jest.mock` of `@agent-platform/*`, `@abl/*`, or relative imports is forbidden. Only external third-party packages (`ai`, `openai`, `stripe`) may be mocked, and only via dependency injection (pass as a constructor/function parameter; never replace module imports).
2. **Fix the code when testing is hard.** Extract pure functions, break dependency chains, use DI. The test should drive better architecture, not mask bad architecture. No `@internal` exports just to reach into module internals — if the test needs access, the module boundary is wrong.
3. **Prefer pure-function tests** for logic (budget enforcement, error classification, cache eviction). Pure functions need zero mocks.

**E2E-specific rules:**

4. **API-only interaction.** Seed via POST, assert via GET. Never import Mongoose models or query the DB directly.
5. **Real servers.** Start Express on random ports (`{ port: 0 }`). Full middleware chain must execute (auth, rate limiting, tenant isolation, validation).
6. **No TODO stubs.** `portA = 0; // TODO` is not a test. If setup needs encryption, key generation, or concurrency harnesses, do it properly.
7. **Cover all content types** in data round-trips (e.g. `ContentBlock[]`, not just plain strings).

**Why:** A2A tests passed 55/55 while auth was missing, sessions had race conditions, and history forwarding was broken — because every test mocked the components that contained the bugs. Separately, an `tenant-models-error-format.test.ts` with 11 `vi.mock` calls hid real integration issues until extracting `provider-cache.ts` from `session-llm-client.ts` made the cache testable mock-free.

**Workflow E2E tests** live in `apps/studio/e2e/workflows/`. Read `agents.md` in that folder BEFORE adding/modifying workflow tests; update it after completing work (folder layout, coverage tables, testid registry, learnings).

## Skills

Domain knowledge lives in on-demand skills (each skill's `description` frontmatter explains when to invoke it; the available-skills list at session start surfaces them). When in doubt, list available skills with `Skill` and pick by description.

**Mandatory-audit triggers** (proactively invoke without being asked):

- `data-flow-audit` (2 rounds) — any feature that introduces new sensitive data, a new serialization boundary, new dependency wiring, or parallel implementations of the same flow.
  Also run it when one commit crosses 2+ boundary categories (`schema`, `types`, `route`, `serializer`, `store`, `sdk`, `worker`, `ui`, `middleware`, `handler`) unless the change already includes parity/round-trip/propagation coverage or a `docs/sdlc-logs/<slug>/data-flow-audit.md` log.
- `phase-auditor` — after every SDLC phase artifact (feature spec, test spec, HLD, LLD, post-impl-sync).
- `pr-reviewer` (5 rounds) — after every implementation commit set.
- `data-propagation-audit` — every PR review that touches OAuth/auth-profile fields (gate `security` cannot PASS without it).

## SDLC Workflow — Behavioral Defaults

CRITICAL: These apply to EVERY conversation. Do NOT wait for the user to prompt them. Canonical reference: [`docs/sdlc/pipeline.md`](docs/sdlc/pipeline.md). Doc-sync workflow: [`docs/sdlc/post-impl-sync-playbook.md`](docs/sdlc/post-impl-sync-playbook.md).

- **Robust & architecturally sound.** Every implementation — bug fix, feature, refactor — fixes root causes, not symptoms. No quick hacks, no TODO stubs. If a test/error/integration is hard, the code's design is wrong; refactor the production code rather than working around it.
- **Clarifying questions before writing.** For ANY spec, design, or implementation plan, ask 3-5 clarifying questions per major section before generating content. Use the ANSWERED/INFERRED/DECIDED/AMBIGUOUS protocol; only AMBIGUOUS goes to the user.
- **Context management between phases.** Run `/compact` after each skill commits its artifact. Each skill reads inputs fresh from disk. Spawn every oracle/auditor as a separate Agent invocation. Summarize fixes in 3-5 bullets between audit rounds. For LLD (5 rounds): `/compact` after round 3.
- **E2E + integration tests are mandatory.** Minimum 5 E2E + 5 integration scenarios per feature. E2E exercises the real system via HTTP API (no mocks, no direct DB). Only external third-party services may be mocked, via DI. Unit tests alone are never sufficient.
- **Feature status lifecycle:** PLANNED → ALPHA → BETA → STABLE. Transitions gated by criteria in pipeline.md. `/post-impl-sync` enforces them. Never promote without verifying.
- **Doc sync after every feature commit.** Run `/post-impl-sync <feature>`. Verify every referenced path with `rg --files`. Feature-spec API tables must distinguish "implemented" from "wired/reachable" (mount/import/caller trace required, not just "file exists"). Test specs need a "Production Wiring Verification" section when reachability is a real risk. A first public-API regression test moves a feature off zero E2E coverage, but the testing index stays `PARTIAL` until the broader scenario family lands.

### SDLC Pipeline & Auditors

Phase order, artifacts, paths, auditor agents, and minimum audit rounds are defined in [`docs/sdlc/pipeline.md`](docs/sdlc/pipeline.md). For any non-trivial feature, the artifacts (feature spec → test spec → HLD → LLD → implementation → data-flow audit when triggered → doc sync) MUST exist in that order. Each phase has a mandatory auditor (`phase-auditor`, `lld-reviewer`, `pr-reviewer`, plus platform/industry/OSS audits for spec & LLD); CRITICAL findings block phase advancement.

**Audit round minimums** (skill enforces; this row is the at-load-time cheat sheet): Feature Spec 5 · Test Spec 2 · HLD 3 · LLD **8** (highest-risk) · Implementation 5 · Data-Flow Audit 2 · Doc Sync 1.

**Ralph-loop:** each loop iteration = one audit round. Do not run internal audit loops redundantly — findings flow into the next iteration automatically.

### Commit Discipline — Small, Focused, Additive

CRITICAL: Every commit must be small, focused, and additive. Canonical reference: [`docs/sdlc/pipeline.md` — Commit Conventions](docs/sdlc/pipeline.md#commit-conventions). Most rules below are enforced by hooks under `.claude/hooks/`; keep them present so the hooks aren't the only line of defense.

1. **One concern per commit.** Don't bundle feature + tests + refactoring + docs.
2. **Max 40 non-doc files, max 3 packages per commit** (`commit-scope-guard.sh`).
3. **Feature commits must be additive** — near-zero deletions (`deletion-ratio-guard.sh` blocks feat() >30% deletions). Restructure in a separate `refactor()` commit first.
4. **Never rewrite a function >200 lines in one pass.** Extract helpers first, then modify.
5. **Build after every file change** (`incremental-typecheck.sh` runs `tsc --noEmit` post-write). Don't accumulate type errors.
6. **Commit message format:** `[ABLP-123] <type>(<scope>): <description>` with a real Jira key. Types: `feat` (additive), `refactor` (restructure), `fix`, `test`, `docs`. If no ticket exists, reuse or create one — do not invent placeholder keys, do not create duplicate tickets.
7. **Map commit SHA/PR back to Jira** after creation (prefer `pnpm jira:update -- <TICKET> --comment ...`).
8. **Run `npx prettier --write <files>` before every commit.**

**Why this matters:** 443 commits over 4 days had a 2.8:1 fix:feat ratio driven by mega-commits (one was 165 files / 11 packages / 24K lines, unrevertable; another deleted ~20 type defs and caused 35 TS errors).

### Product Oracle, Logging & Package Learnings

SDLC skills use a **product-oracle agent** to autonomously resolve clarifying questions via ANSWERED/INFERRED/DECIDED/AMBIGUOUS classification (only AMBIGUOUS escalates). Decisions log to `docs/sdlc-logs/<feature>/` (one file per phase). Cross-cutting insights → `docs/sdlc-logs/agents.md`. Per-package learnings → `<package>/agents.md` — append-only, read before modifying, write after completing. Every SDLC phase updates `agents.md` for each package touched. Canonical detail: `docs/sdlc/pipeline.md`.

# Agent Learning Journal — Cross-Cutting

Cross-cutting learnings that span multiple packages or don't belong to a single package. For package-specific learnings, see `<package>/agents.md`.

## Distributed agents.md Locations

Each package/app has its own `agents.md` at the root:

- `apps/studio/agents.md`
- `apps/runtime/agents.md`
- `apps/search-ai/agents.md`
- `apps/admin/agents.md`
- `apps/workflow-engine/agents.md`
- `apps/multimodal-service/agents.md`
- `packages/database/agents.md`
- `packages/compiler/agents.md`
- `packages/shared-kernel/agents.md`
- `packages/shared/agents.md`
- `packages/project-io/agents.md`
- `packages/llm/agents.md`
- `packages/pipeline-engine/agents.md`

For any package not listed: create `<package>/agents.md` on first touch using the same format.

---

<!-- Cross-cutting entries below this line. Format:
## <DATE> — <Feature/Context>
**Packages**: <list of packages involved>
**Category**: architecture | testing | pattern | gotcha | process
**Learning**: <what was learned>
**Impact**: <how this affects future work>
-->

## 2026-05-10 — Stateless Agent Runtime Invariant

**Packages**: `packages/compiler` (FLOWS / IR), `apps/runtime` (conversation runtime), `apps/workflow-engine` (Restate)
**Category**: architecture
**Learning**: Agent DSL runtime execution must stay stateless. Each FLOW step takes input, produces output, advances — no in-memory timers, no held state across waits, no polling loops in the conversation runtime layer. Statelessness is a load-bearing invariant: it gives horizontal scale (any pod, any session), cheap pod restarts, simple cost guardrails, and trace reconstructability. Durable async patterns (waits, polling, human approval, scheduled triggers, multi-hour orchestrations) belong in the **workflow layer** — `apps/workflow-engine` on Restate, where durable suspension is a first-class capability. Agents invoke workflows via `type: workflow` tool; the agent's session is "waiting on a tool call" while the workflow holds the durable state. PARALLEL in FLOWS is acceptable — each branch runs to completion synchronously and joins, no state held across time.
**Impact**: Reject any future platform proposal that adds state-holding constructs to the agent runtime (POLL, long waits, durable suspension at the FLOW step level). When a FLOW needs "wait for X to complete," the answer is a workflow tool, not a runtime extension. Document this distinction in feature specs that involve durable async to keep design discipline across the platform.

## 2026-04-27 — ABLP-535 Forward-Looking PII Boundary Closure

**Packages**: `apps/runtime`, `apps/studio`, `packages/database`, `docs`
**Category**: process
**Learning**: When product explicitly does not care about legacy sessions, document that as a scope decision instead of leaving a backfill phase as an implied requirement. For PII reveal, the forward-looking invariant is enough when normal read APIs scrub historical payloads and reveal returns raw values only for durable vault tokens.
**Impact**: Future compliance fixes should distinguish "new invariant is enforced" from "old data migration is required." If legacy records lack durable provenance, represent them as unavailable/non-revealable unless product opens a separate cleanup feature.

## 2026-03-23 — Pipeline Engine Post-Impl-Sync Status Correction

**Packages**: `packages/pipeline-engine`, `apps/runtime`, `apps/studio`
**Category**: process
**Learning**: Document status ("STABLE" = doc finalized) and feature lifecycle status ("STABLE" = production-ready) are different concepts. The initial SDLC pipeline run for pipeline-engine incorrectly used feature lifecycle labels for document status, marking the HLD and LLD as "STABLE" when the feature had 0 E2E tests. Corrected vocabulary: HLD uses APPROVED/DRAFT, LLD uses DONE/IN PROGRESS, feature spec uses the lifecycle labels (PLANNED/ALPHA/BETA/STABLE).
**Impact**: Future post-impl-sync runs should verify document status labels match the correct vocabulary for each artifact type. When a feature has all SDLC artifacts but no E2E tests, the correct feature status is ALPHA, not STABLE.

## 2026-03-24 — Production Wiring Verification (Systemic SDLC Gap)

**Packages**: `apps/runtime`, `apps/studio`, `packages/web-sdk`
**Category**: process
**Learning**: Three systemic documentation issues were discovered during omnichannel-session-continuity post-implementation audit:

1. **Feature spec API tables conflate "code exists" with "production-reachable"**: The omnichannel router code exists in `omnichannel.ts` and all E2E tests pass, but the router is not mounted in `server.ts`. The API table said "Implemented (ALPHA)" for endpoints that are unreachable in production. **Fix**: API tables should include a "Wired" column with YES/NO/PARTIAL indicating whether the endpoint is reachable from the production entry point.

2. **Test specs have no category for production wiring verification**: E2E tests exercise code through test harnesses (which mount routes explicitly). A separate "Production Wiring Verification" section is needed to check that code is reachable from production entry points (`server.ts`, SDK production builds, Studio production builds). **Fix**: Add a "Production Wiring Verification" section with checks like "router mounted in server.ts" and "function has production callers".

3. **LLD wiring checklists mark items "done" based on code existence, not callability**: Wiring items like "routes registered in server.ts" were checked because the route file was created, not because the route was actually registered. **Fix**: LLD wiring verification should include evidence (grep output or import trace) proving the wiring is callable, not just that the target file exists.

**Impact**: All future `/post-impl-sync` runs should check production wiring as a separate concern from functional test coverage. All future `/lld` wiring checklists should include verification commands. All future feature spec API tables should include wiring status.

## 2026-04-01 — Targeted HTTP Regression vs Full E2E Matrix

**Packages**: `apps/runtime`, `docs`
**Category**: process
**Learning**: Post-implementation sync must distinguish "zero public-API E2E coverage" from "a first targeted public-API regression shipped." Once a deterministic HTTP regression exists, feature specs and HLDs must stop claiming zero E2E, but the testing index should still mark the feature `PARTIAL` until the broader scenario family is covered.
**Impact**: Future `/post-impl-sync` runs should update feature docs, HLDs, and the testing index together so targeted live regressions improve status accuracy without overstating overall E2E breadth.

## 2026-04-03 — Post-Impl Sync Path Verification

**Packages**: `apps/runtime`, `apps/studio`, `packages/web-sdk`, `packages/connectors`, `docs`
**Category**: process
**Learning**: The easiest way for post-implementation sync docs to drift is stale file paths, not stale intent. Recent auth-profile and SDK chat docs were wrong mainly because tests moved under new folders (`auth/**`, `api-routes/**`, Studio-hosted browser suites) after the first sync. The quickest prevention step is to verify every referenced file path with `rg --files` before updating status/gap tables.
**Impact**: Future `/post-impl-sync` runs should treat `rg --files` verification as a required step before writing inventories, coverage tables, or "missing file" gaps.

## 2026-04-12 — Platform Keys Phase 2 Scope Expansion + RBAC Boundary

**Packages**: `packages/shared-auth`, `apps/runtime`, `apps/search-ai`, `apps/search-ai-runtime`, `apps/workflow-engine`, `apps/studio`
**Category**: architecture
**Learning**: Platform-key correctness depends on two separate boundaries staying aligned: `resolveApiKey()` must expand dot scopes to RBAC permissions in every consuming app, and project RBAC must still treat API keys as machine principals rather than creator users. `createdBy` is provenance/audit metadata, not owner/member authority.
**Impact**: Future API-key or scope work should verify both halves together: scope expansion at auth resolution time and explicit exclusion of creator owner/member fallback in project-scoped authorization helpers.

## 2026-04-14 — Separately Versioned Protocol Rollouts

**Packages**: `apps/runtime`, `packages/web-sdk`, `packages/a2a`
**Category**: architecture
**Learning**: When client and server packages deploy or publish on different cadences, contract retirements need two layers: the steady-state typed contract and a narrow compatibility shim for older bundles. Legacy payload acceptance (for example retired heartbeat frames or older transport wrappers) should live in an explicit compatibility branch and must not leak back into the canonical typed contract.
**Impact**: Future websocket/transport/message-contract changes should update runtime, SDK, and boundary tests together, keep rollout shims isolated, and remove them only after older published bundles are no longer expected.

## 2026-04-14 — Metadata Boundary Normalization

**Packages**: `apps/runtime`, `packages/web-sdk`, `packages/a2a`
**Category**: pattern
**Learning**: Turn-scoped metadata is safest when validated at the channel boundary and forwarded into execution as one canonical `messageMetadata` field. Transport-reserved keys such as `history` must stay out of generic metadata forwarding so handoff/continuity protocols do not collide with user-provided message context.
**Impact**: Future channel or adapter work should normalize metadata at the boundary, keep execution-time access canonical, and update reserved-key exclusion lists whenever transport-specific metadata grows.

## 2026-04-14 — Workflow Versioning Feature Spec

**Packages**: `apps/workflow-engine`, `apps/runtime`, `apps/studio`, `packages/database`, `packages/connectors`, `packages/shared`
**Category**: architecture
**Learning**: The current workflow model has a broken status lifecycle: `draft` → `active` has no UI or API path (Zod schema at `apps/runtime/src/routes/workflows.ts:68` excludes `draft` from updates). The 4-status enum on `Workflow` and 5-status enum on `WorkflowVersion` are being replaced by: (1) no status on the Workflow container, (2) draft-as-version-identifier (always one, always mutable), (3) `active`/`inactive` states on published versions only. Key code evidence:

- `TriggerScheduler.processJob()` loads working copy, never does deployment/version lookup — cron always fires draft
- `WorkflowVersion` model has `definition.nodes/edges` but no `triggers` — triggers live on the Workflow document only
- `trigger-engine.ts:300-342` has webhook-only deployment resolution; cron and app-event paths skip it entirely
- Steps and flow are the same thing — `convertCanvasToSteps()` converts between visual (nodes/edges) and engine (steps) formats

**Impact**: HLD/LLD must address: (1) migrating triggers from Workflow to WorkflowVersion, (2) adding `workflowVersionId` to TriggerRegistration, (3) making TriggerScheduler resolve versions at fire time, (4) 2-phase migration (dual-write then cleanup).

## 2026-04-14 — Workflow Versioning HLD

**Packages**: `apps/runtime`, `apps/workflow-engine`, `apps/studio`, `packages/database`
**Category**: architecture
**Learning**: Key architectural decisions from the HLD:

- **Direct trigger-to-version binding** (Option C) eliminates fire-time resolution entirely — simpler than the prior deployment-only design (Option B). Triggers carry `workflowVersionId` at registration time, not at fire time.
- **TriggerRegistration status enum** needs `"inactive"` added to distinguish version-level deactivation from user-initiated per-trigger pause (`"paused"`).
- **`sourceHash` dedup index** must include `workflowId` for scoped lookups: `{ tenantId, workflowId, sourceHash }`, not just `{ tenantId, sourceHash }`.
- **`Workflow.deleted`/`deletedAt`** fields do not exist today — they are new additions, not existing fields.
- **`steps`** is a schemaless runtime-only field on Workflow (accessed dynamically but not in Mongoose schema).
- **Version names** use `v` prefix (`v0.1.0`), but existing `nextVersion()` returns `"0.1.0"` — needs update.
- **`definition.envVars`** on published versions are frozen (nested under `definition`). Mutable envVars would require extracting them to a top-level field.

**Impact**: LLD must implement all 3 decisions (D-1 envVars frozen, D-2 version prefix, D-3 status enum). The existing `{ tenantId: 1, projectId: 1, status: 1 }` index on workflows is removed in Phase 2 when `status` is dropped — replaced by `{ tenantId: 1, projectId: 1, deleted: 1 }`.

## 2026-04-15 — Workflow Versioning LLD

**Packages**: `apps/runtime`, `apps/workflow-engine`, `apps/studio`, `packages/database`, `packages/compiler`, `packages/shared`, `packages/i18n`
**Category**: architecture
**Learning**: Key findings from 5-round LLD audit:

- **Audit events are a route-layer concern**, not a service-layer concern. Existing patterns in `audit-helpers.ts` are called from route handlers with fire-and-forget `.catch()`. Service methods should not call audit functions. `AuditEventType` and `AuditLog.resourceType` are separate unions in `packages/compiler` — both must be updated when adding new event types.
- **createVersion() should set initial state "inactive"** — callers explicitly call `activate()` to register triggers. This centralizes trigger registration in one place and avoids a window where a version is "active" with no triggers. The HLD said "active" on create but the LLD diverges for architectural correctness (LD-13).
- **`trigger-engine.ts` has a `strategy` vs `triggerType` field name discrepancy** — model schema defines `triggerType` but `register()` stores as `strategy`. The migration script must rename existing documents. All readers must be updated to use the model schema field name.
- **`process-api.ts` uses a DI factory pattern** (`createProcessApiRouter(deps)`). Adding version resolution should use dynamic imports (matching existing `await import('@agent-platform/database')` at line 118), not extending `ProcessApiDeps`, to preserve backward compat with existing E2E test setup.
- **FR-17 environment routing** is strict equality: `eventEnv === triggerEnv` (including both-null). Draft triggers with `null` environment do NOT match events with a set environment. This contradicts the initial intuition that "null = unscoped" but aligns with feature spec, HLD, and test spec UT-2.
- **Studio auto-save** lives in `useWorkflowSave.ts` (not `workflow-canvas-store.ts`). The save chain is: `useAutoSave.ts` → `useWorkflowSave.ts` → `saveWorkflowCanvas()` in `api/workflows.ts`. Only the API client target changes.

**Impact**: Implementation must follow these patterns: audit at route layer, createVersion as inactive, dynamic imports for process-api, strict environment equality, correct auto-save file targets.

## 2026-04-19 — Durable History Uses One Envelope + One History API

**Packages**: `apps/runtime`, `apps/studio`, `packages/shared`, `packages/web-sdk`, `packages/database`
**Category**: architecture
**Learning**: Future-ready session history should not fork into separate Studio replay payloads and SDK hydration payloads. The durable contract works best when runtime persistence stamps one versioned `contentEnvelope` that carries structured content plus localization ownership, debug/session-resume paths forward that same envelope, and browser SDKs hydrate from the shared session-messages API rather than a parallel SDK-only history route.
**Impact**: Future transcript/replay/resume work should extend the durable envelope instead of adding transport-specific history shapes. If a hosted SDK surface needs transcript hydration, its bootstrap/session permissions should explicitly include `session:read` and reuse the shared messages endpoint.

## 2026-04-22 — Voice Runtime Semantics Need Three Separate Contracts

**Packages**: `apps/runtime`, `packages/compiler`, `packages/web-sdk`, `docs`
**Category**: architecture
**Learning**: Voice parity work is much easier to reason about when split into three explicit contracts: provider event normalization, prompt profile resolution, and canonical semantic turn execution. Pipeline voice already proves the semantic baseline through `executeMessage()` plus `buildExecutionOutcome()`. Realtime voice drifts mainly because `RealtimeVoiceExecutor` currently rebuilds a smaller local prompt/tool surface, while providers also expose genuinely different native event grammars and mid-call capabilities.
**Impact**: Future voice work should keep media transport and provider specifics in adapters, keep prompt packaging mode-aware rather than identical across pipeline and realtime, and make immutable-provider limits explicit partial capability profiles instead of silent behavior differences.

## 2026-04-26 — pr-review Worktrees Need Bottom-Up Build Bootstrap

**Packages**: tooling (`pr-review` skill, `apps/*`, `packages/*`)
**Category**: tooling
**Learning**: A fresh `.worktrees/pr-<n>` checkout reuses the parent repo's installed `node_modules` via pnpm hardlinks but does NOT inherit any `packages/*/dist` outputs. Running `pnpm --filter <app> build` against a fresh worktree fails with cascading `Cannot find module '@agent-platform/database'`-style errors that look like PR bugs but are really unhydrated upstream packages. `pnpm build` at the root sometimes still fails because turbo's per-worktree cache is empty and the topological order misses deep leaves. The reliable pattern is to build the leaves explicitly before the apps — for the studio/runtime stack the leaf set was: `@agent-platform/database`, `@agent-platform/shared-auth-profile`, `@abl/eventstore`, `@agent-platform/circuit-breaker`, `@abl/language-service`, `@agent-platform/a2a`, `@agent-platform/agent-transfer`, `@agent-platform/execution`, `@agent-platform/llm`, `@agent-platform/observatory`, `@agent-platform/pipeline-engine`, `@agent-platform/search-ai-sdk`, `@agent-platform/openapi`, `@abl/crawler` — then `@agent-platform/shared`, `@abl/compiler`, `@agent-platform/connectors`, then `@agent-platform/runtime`, `@agent-platform/workflow-engine`, `@agent-platform/studio`.
**Impact**: PR reviews and any cross-package work in worktrees should bootstrap the leaves before judging build attribution. The `pr-review` skill (`.claude/skills/pr-review/SKILL.md` step 4) should add a "bootstrap leaves" step between the worktree install and the targeted app builds so reviewers don't waste cycles whack-a-moling missing `dist/` outputs.

---

### 2026-05-06 — A2A Spec 1 (ABLP-162): Cross-Cutting Learnings

**Category**: SDLC / multi-package coordination

**Learning 1 — `field-propagation-lint` covers boundary types but not L2-card MDX→generated-TS pipelines.**
Spec 1 added `external_agent_card` to `ArchSSEEventSchema` discriminated union (`packages/arch-ai/src/types/sse-events.ts`). The PreToolUse hook caught it correctly and listed downstream consumers. But the parallel concern — MDX content edits flowing into auto-generated `cards/generated/*.ts` via `pnpm abl:docs:generate` — has no equivalent guard. A future docs reorg that breaks `CARD_FILE_COVERAGE` mappings would silently produce zero-byte cards. Consider extending field-propagation or adding a separate `mdx-card-source-check.sh` hook.

**Learning 2 — Latent test failures from prior phases require a Gate-1 broad sweep.**
Phase 3 committed `agent-card-sanity.test.ts > rejects card missing name` and `handoff-synthesizer.test.ts > does not emit user-supplied script-like content verbatim`. Both failed on first run — the Phase 3 implementer agent reported "all targeted tests passing" because its targeted set didn't include these specific cases. The Gate 1 acceptance broad sweep (`pnpm --filter @agent-platform/studio test -- src/__tests__/external-agent-ops/`) is what surfaced them. **Pattern**: every implement skill's phase exit criteria should run the FULL test suite for the touched directory, not just the new files. Targeted-only test runs miss latent failures from earlier phases. (Consider adding to `implement-playbook.md` Phase 2c.)

**Learning 3 — Branch-hygiene findings vs Spec scope: parallel ABLP-162 streams pre-existed Spec 1 phases.**
This branch (`zarch/newtools`) had two parallel ABLP-162 work streams active simultaneously: Spec 1 (external-agent CRUD/wiring/adaptiveness) and integration-suggestions (`computeIntegrationSuggestions`, `apps/studio/src/lib/arch-ai/processors/integration-suggestions.ts`, related tests). pr-reviewer found 1 CRITICAL (`vi.mock('@/lib/redis-client')`) and 2 HIGH (unbounded Map, missing fetch timeout) in the parallel-stream code. Per Spec 1 scope: deferred to follow-up tickets, NOT fixed in Spec 1 commits. **Pattern**: when a branch carries multiple work streams under one ticket, the review should flag scope at the start and the reviewer should distinguish in-scope-must-fix from same-branch-but-different-scope.

**Learning 4 — Five-round pr-reviewer loop catches different defect classes per round.**
For Spec 1: Round 1 (code quality) caught 4 LOWs in 5 minutes; Round 2 (HLD) APPROVED; Round 3 (tests) caught 4 HIGH gaps in span-event coverage, narration logic, render tests, SSRF failure modes; Round 4 (security) APPROVED with defense-in-depth MEDs; Round 5 (production-readiness) caught the most consequential issues — undocumented rollback flag (H-1) and DoS via unbounded streamed body (H-4). **Pattern**: production-readiness round consistently surfaces the highest-impact findings because by then the code is concrete enough to inspect for runtime/operational behavior. Don't skip Round 5.

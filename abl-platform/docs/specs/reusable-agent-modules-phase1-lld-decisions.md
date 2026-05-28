# Reusable Agent Modules — Phase 1 LLD Decision Register

**Status:** APPROVED
**Date:** 2026-03-21
**Input from:** HLD review findings, codebase pattern analysis, design decisions from 2026-03-21
**Feeds into:** `docs/specs/reusable-agent-modules-phase1.lld.md`

Each question below has a recommendation with rationale grounded in existing codebase patterns and platform principles. Decisions marked **[DECIDED]** were resolved in earlier review. Others need confirmation before LLD writing begins.

---

## 1. Data Model

### 1a. Should `ModuleRelease` use a Mongoose discriminator on `Project` or be a fully separate collection?

**Recommendation: Separate collection.**

**Rationale:** The codebase uses zero discriminators — every model (`Project`, `Deployment`, `Session`, `Workflow`) is a standalone collection with its own schema, interface, and index set. Discriminators add polymorphic query complexity and make the `tenantIsolationPlugin` harder to reason about per-type. `ModuleRelease` has fundamentally different fields from `Project` (artifact, contract, sourceHash, archivedAt) and different access patterns (immutable after creation, queried by version/pointer). A separate collection with its own compound indexes (`{ tenantId, moduleProjectId, version }`) is simpler, faster, and consistent with every other model in the codebase.

**Pattern reference:** `packages/database/src/models/deployment.model.ts` — separate from `Project` despite being project-scoped.

## **Prasanna's Decision:** Separate collection

### 1b. Should archived module projects appear in the project dashboard or be hidden?

**Recommendation: Show archived projects in listings with an "archived" badge, but exclude them from active-project queries by default.**

**Rationale:** The codebase already has two soft-delete patterns: `deletedAt` (auto-filtered by `BaseModel.applySoftDeleteFilter`) and `archivedAt` (explicitly filtered, used by `session.model.ts` and `workflow.model.ts`). Module projects should use the `archivedAt` pattern — not auto-filtered, so listing queries can include `{ archivedAt: null }` by default but expose an "include archived" toggle. This matches how sessions and workflows handle archival. Hiding archived projects entirely would make it hard for admins to understand why a consumer deployment still works (it's resolving releases from an archived module).

**Pattern reference:** `packages/database/src/models/session.model.ts:76` — `archivedAt: Date | null`, no auto-filter.

## **Prasanna's Decision:** show it in projects listings with archived badge, but also create a seperate section and UI filter for this

### 1c. Should `ProjectModuleDependency` denormalize the module contract at import time?

**Recommendation: Yes — store a denormalized `contractSnapshot` on the dependency record.**

**Rationale:** The dependency record is the primary surface for showing "what does this import require?" in Studio's dependency list and topology views. Fetching the contract live from `ModuleRelease` on every render adds a cross-collection join and creates a subtle coupling: if the release is later archived, the contract would become harder to resolve. A denormalized snapshot follows the same immutability-first principle as `DeploymentModuleSnapshot` — capture the truth at decision time, don't rely on live lookups. The contract is small (a list of provided agents/tools and required prerequisites), so the storage overhead is negligible.

**Pattern reference:** `packages/database/src/models/deployment.model.ts` — `agentVersionManifest` denormalizes which agent versions are in a deployment rather than joining live.

## **Prasanna's Decision:** Yes — store a denormalized `contractSnapshot` on the dependency record.

### 1d. Should consumer project deletion eagerly cascade `DeploymentModuleSnapshot` records or use background cleanup?

**Recommendation: Eager cascade in the same deletion flow.**

**Rationale:** The existing `cascade-delete.ts` deletes `DeploymentVariableSnapshots` eagerly before deleting `Deployments` (lines 200-210). Module snapshots should follow the same pattern — delete `DeploymentModuleSnapshot` where `{ projectId }` before deleting `Deployment` records. Background cleanup introduces eventual consistency and orphan risk. The snapshots are one-per-deployment, so the delete volume is bounded and fast. Lazy cleanup is appropriate for large-volume ephemeral data (messages, traces), not for structural metadata like deployment snapshots.

**Pattern reference:** `packages/database/src/cascade/cascade-delete.ts:200-210` — eager `DeploymentVariableSnapshot` deletion before `Deployment`.

## **Prasanna's Decision:** Yes, eager cascade in the same deletion flow

## 2. Module Release Builder

### 2a. Compile DSL at publish time (store DSL + IR) or defer compilation to consumer deployment?

**Recommendation: Compile at publish time. Store DSL in the artifact and pre-compiled IR in a separate `compiledIR` field.**

**Rationale:** Compile-at-publish catches errors early — a module author learns about broken DSL immediately, not when a consumer tries to deploy. The existing `version-service.ts` compiles DSL to IR during `createVersion` (lines 166-446) and stores both `dslContent` and `irContent` on `AgentVersion`. Module releases should follow the same pattern. Storing pre-compiled IR also enables the consumer deployment build to skip re-compilation when no consumer-specific config overrides affect the IR, making the common case faster. The alias rewriter operates on IR (not DSL), so having IR available at publish time is architecturally necessary for the deployment snapshot builder.

However, the consumer deployment build must still **re-compile** when config overrides or consumer-specific variable bindings change the IR. The pre-compiled IR serves as a fast path and a validation checkpoint, not a final artifact.

**Pattern reference:** `apps/runtime/src/services/version-service.ts:288-320` — compiles DSL to IR at version creation time.

**Prasanna's Decision:** compile at publish time.

---

### 2b. Should publish safety block on all issues or return a mix of errors and warnings?

**Recommendation: Two-tier response — blocking errors and non-blocking warnings.**

**Rationale:** The existing `prerequisite-validator.ts` already returns a structured `PrerequisiteResult` with both `blocking` issues (must fix before proceeding) and `warnings` (informational, non-fatal). Module publish should follow the same contract:

- **Blocking errors:** Inline secrets in auth config, source-project-only IDs in artifact, zero agents, DSL compilation failure
- **Non-blocking warnings:** Unsupported v1 constructs, `AgentModelConfig` DB-side overrides that won't travel, tools with no auth profile ref (may work but fragile)

This gives authors actionable feedback without forcing them to resolve cosmetic issues before shipping a working module.

**Pattern reference:** `packages/project-io/src/import/prerequisite-validator.ts` — `PrerequisiteResult` with `blocking` and `warnings` arrays.

## **Prasanna's Decision:** Agreed on the recommendation

### 2c. What should `sourceHash` cover?

**Recommendation: SHA-256 of canonical JSON (sorted keys) of `{ agents: Record<name, dslContent>, tools: Record<name, dslContent> }` — DSL content only, not project metadata.**

**Rationale:** The hash serves deduplication: "has anything changed since the last release?" Project metadata (name, description, entryAgentName) can change without affecting the module's runtime behavior. Including them would cause unnecessary version churn. The existing `version-service.ts` computes `sourceHash` from DSL content + config vars (lines 400-410) for the same reason — it captures what affects compiled output. Use `createHash('sha256')` consistent with `deployment-resolver.ts`.

**Pattern reference:** `apps/runtime/src/services/version-service.ts:400-410` — SHA-256 of DSL + config vars, truncated to 16 chars.

**Prasanna's Decision:** entry agent name is not project metadata - it changes the behavior. Agreed on the SHA-256 of canonical JSON.

## **Resolved:** sourceHash covers `{ entryAgentName, agents: Record<name, dslContent>, tools: Record<name, dslContent> }` — includes entryAgentName since it affects runtime behavior.

## 3. Alias Rewriter

### 3a. Alias validation pattern and length limits?

**Recommendation: Enforce `^[a-z][a-z0-9_]{1,24}$` — lowercase alphanumeric + underscore, 2-25 chars.**

**Rationale:** The mounted name pattern is `<alias>__<symbol>`. Agent names in the existing codebase are typically 10-40 chars. With a 25-char alias limit and `__` separator (2 chars), the worst case is `25 + 2 + 40 = 67 chars`, which is well within MongoDB index key limits (1024 bytes) and comfortable for trace display. Lowercase-only prevents case-sensitivity bugs across platforms. The `__` double-underscore separator is already uncommon in agent/tool names, making collisions unlikely. Reject aliases that start with `_` or contain `__` to avoid ambiguity with the separator.

**Additional check:** At import time, validate that no mounted name (`<alias>__<symbol>`) collides with any existing local agent or tool name in the consumer project.

**Prasanna's Decision:** Agree on recommendation.

---

### 3b. Should internal module references (agent→tool within the same module) be rewritten?

**Recommendation: Yes — rewrite ALL references uniformly, including module-internal ones.**

**Rationale:** Uniform rewriting is simpler and eliminates an entire category of bugs. If agent `lookup_agent` references tool `lookup_tool` and both are in the same module imported as `benefits`, the mounted names become `benefits__lookup_agent` and `benefits__lookup_tool`. The reference must also become `benefits__lookup_tool` or it will resolve against the consumer's local tool namespace and either fail or bind to the wrong tool. Selective rewriting (only cross-boundary) requires the rewriter to track which references are internal vs external — a distinction that doesn't exist in the IR and would be error-prone. Uniform rewriting matches how language-level module systems work (qualified names everywhere).

**Prasanna's Decision:** agree on recommendation

---

### 3c. Should the rewriter operate on DSL text or compiled IR?

**Recommendation: Operate on compiled IR (post-compilation tree walk).**

**Rationale:** DSL text rewriting is fragile — it requires regex or parser-level string replacement that can break on edge cases (agent names inside comments, string literals, multi-line constructs). The IR is a structured tree where agent names and tool references live in typed fields. Walking the IR tree and rewriting specific fields is deterministic, testable, and immune to formatting variations. The existing compiler pipeline already separates parsing from IR manipulation (e.g., `auth-requirement-collector.ts` walks IR to extract auth refs). The alias rewriter should follow the same post-compilation pass pattern.

**Exhaustive IR fields to rewrite** (determined from `routing-executor.ts`, `runtime-executor.ts`, and compiler constructs):

- `AgentIR.coordination.handoffs[].targetAgent`
- `AgentIR.coordination.delegates[].targetAgent`
- `AgentIR.coordination.fanOut[].targetAgents[]`
- `AgentIR.coordination.availableAgents[]`
- `AgentIR.coordination.escalation.targetAgent`
- `AgentIR.tools[].name` (tool references in agent tool sections)
- `AgentIR.completion.requiredCompletions[]` (if referencing agents)
- `AgentIR.guards[].references[]` (if referencing agent names by string)
- `AgentIR.flow.steps[].targetAgent` (flow step routing targets)
- `AgentIR.reasoning.delegateTo` (reasoning execution delegate targets)
- Tool definitions: `tool.name` in mounted tool records

**Pattern reference:** `packages/compiler/src/platform/ir/auth-requirement-collector.ts` — post-compilation IR tree walk.

## **Prasanna's Decision:** on the IR

## 4. Deployment Build

### 4a. Cache module IR by `(moduleReleaseId, consumerConfigHash)` or skip caching in Phase 1?

**Recommendation: Skip caching in Phase 1. Add it as a Phase 2 optimization if compile latency becomes a bottleneck.**

**Rationale:** Premature caching adds complexity (cache invalidation, storage management, TTL policy) without proven need. The existing `version-service.ts` doesn't cache cross-agent compilation — it compiles each agent independently. A module with 10 agents compiles 10 times, each taking ~50-200ms. For Phase 1's conservative limit of 5 modules × ~10 agents = ~50 compilations, the total time is ~5-10 seconds — acceptable for a deployment build that already takes seconds. If telemetry shows this is a bottleneck, Phase 2 can add a `(releaseId, configHash) → IR` cache in Redis with the release's immutability as a natural cache key.

**Principle:** YAGNI — don't optimize before measuring. The HLD already caps at 250 symbols, bounding worst-case latency.

**Prasanna's Decision:** Agreed, skip caching for phase 1.

---

### 4b. Should combined compile errors include full diagnostics or just a summary?

**Recommendation: Return structured diagnostics with per-agent/tool error details, truncated to the first 10 errors.**

**Rationale:** The existing `preflight-validation-service.ts` returns a `PreflightReport` with per-agent diagnostics (status, summary, details). Module compile errors should follow the same pattern — structured, actionable, and bounded. Full compiler output can be verbose for large modules; truncating to 10 errors prevents response bloat while giving enough context to diagnose. Include the mounted name (with alias prefix) in each diagnostic so the consumer knows which module caused the failure.

**Pattern reference:** `apps/runtime/src/services/preflight-validation-service.ts` — `PreflightReport` with per-agent diagnostics.

## **Prasanna's Decision:** Yes, recommendation is good.

### 4c. New standalone `deployment-build-service.ts` or extend `version-service.ts`?

**Recommendation: New standalone `deployment-build-service.ts` that orchestrates the combined flow and delegates to `version-service.ts` for individual agent compilation.**

**Rationale:** The existing `version-service.ts` is already 658 lines and handles a single-agent compile-dedup-cache lifecycle. Extending it with module-aware combined compilation would violate single responsibility and make the already-complex version lifecycle harder to test. A new `deployment-build-service.ts` should:

1. Load local agents (via existing `version-service.ts`)
2. Load module release artifacts
3. Call the alias rewriter
4. Compile imported agents (reusing `version-service.ts`'s compile logic but not its dedup/cache lifecycle)
5. Build the `DeploymentModuleSnapshot`
6. Persist everything atomically

This keeps `version-service.ts` unchanged for non-module projects (regression safety) and creates a clean extension point for future module complexity.

**Pattern reference:** `apps/runtime/src/services/snapshot-service.ts` — standalone service for deployment variable snapshots, separate from deployment creation.

## **Prasanna's Decision:** Yes, recommendation on new standalone impl is good.

## 5. Runtime Merge

### 5a. Module provenance in session state — top-level field or nested per-agent?

**Recommendation: Top-level `moduleProvenance` map on the session record, keyed by mounted agent name.**

**Rationale:** Session state must survive Redis serialization and cross-pod rehydration. The existing `SessionData` type (in `types.ts`) uses flat top-level fields for structural metadata (`agentName`, `irSourceHash`, `compilationHash`) and nested objects for runtime state (`state`, `conversationHistory`). Module provenance is structural metadata — it describes which agents came from which modules. A top-level `moduleProvenance: Record<string, { alias, moduleProjectId, moduleReleaseId, sourceAgentName }>` keyed by mounted name is:

- Easy to serialize (it's a JSON object)
- Easy to query in traces (flat lookup by current agent name)
- Easy to extend (add fields without restructuring nested agent state)
- Consistent with how `agentName` and `deploymentId` are stored at the session level

The map format handles multi-module sessions naturally — each mounted agent has its own provenance entry.

**Pattern reference:** `apps/runtime/src/services/session/types.ts:20-96` — flat structural metadata at session top level.

## **Prasanna's Decision:** Go with recommendation

### 5b. Should runtime log auth profile resolution scope (project vs tenant) for imported tools?

**Recommendation: Yes — emit a trace event with `authProfileScope: 'project' | 'tenant'` when resolving auth for imported tools.**

**Rationale:** The security review (HIGH-6) flagged that a consumer could accidentally bind to a tenant-scoped profile when they intended a project-scoped one. Logging the resolution scope in traces provides observability without changing the resolution behavior. This is a low-cost addition — the auth profile resolver (`auth-profile-resolver.ts:215-268`) already knows which candidate matched. Emitting a `TraceEvent` with `{ type: 'auth_resolution', agentName, toolName, profileName, scope, moduleAlias? }` gives operators the data to diagnose misresolution without requiring new UI.

**Pattern reference:** `apps/runtime/src/services/trace-store.ts` — existing trace event emission pattern.

## **Prasanna's Decision:** Yes, do it. Its important

### 5c. Load module snapshots lazily or eagerly at session bootstrap?

**Recommendation: Eagerly at session bootstrap.**

**Rationale:** The existing `DeploymentResolver` loads all agent versions eagerly when a session starts — it resolves the full `agentVersionManifest` from the deployment record before any message processing begins (lines 147-215). Module snapshots should follow the same pattern: load the `DeploymentModuleSnapshot` at bootstrap and merge mounted agents into the resolved agent set. Lazy loading would introduce mid-session latency spikes and require null checks throughout the execution path. The snapshot is frozen and immutable, so there's no staleness concern — loading it once per session is correct.

**Pattern reference:** `apps/runtime/src/services/deployment-resolver.ts:147-215` — eager agent resolution at session start.

## **Prasanna's Decision:** load it once per session.

## 6. Studio API

### 6a. Catalog route — full metadata inline or summary + detail endpoint?

**Recommendation: Summary-only catalog listing + separate detail endpoint per module.**

**Rationale:** The catalog browse is a list view — returning full contracts for every visible module would create large payloads and slow rendering. The security review (A-3) also flagged that artifact content (full DSL) must not be returned in catalog responses. A summary listing returns: `{ moduleProjectId, name, slug, description, latestVersion, pointers, providedAgentCount, providedToolCount }`. A detail endpoint returns the full contract (prerequisites, provided agents/tools) when the user selects a specific module for import. This matches the existing project list/detail pattern in Studio.

**Pattern reference:** `apps/studio/src/api/projects.ts` — `loadProjects()` returns summaries, `loadProject(id)` returns full detail.

## **Prasanna's Decision:** agreed on the recommendation

### 6b. Import flow — single POST or two-step preview/confirm?

**Recommendation: Two-step preview/confirm, reusing the existing import pattern.**

**Rationale:** The existing project import uses a two-step flow: `POST /import/preview` (dry-run showing what would change) → `POST /import/apply` (commit with rollback support). Module import should follow the same pattern:

1. `POST /module-dependencies/preview` — resolve the selector, validate prerequisites, show what would be mounted, identify missing config/env/auth
2. `POST /module-dependencies` — persist the dependency record with the `resolvedReleaseId` from the preview

This gives the user a chance to see and fix prerequisite issues before committing. It also mitigates the pointer-drift concern (MED-9) — the preview captures a `resolvedReleaseId`, and the confirm step pins that exact ID.

**Pattern reference:** `apps/studio/src/app/api/projects/[id]/import/preview/route.ts` and `apply/route.ts` — two-step import with dry-run.

## **Prasanna's Decision:** yes, two step

### 6c. Module routes under `/api/projects/[id]/` or dedicated `/api/modules/` surface?

**Recommendation: Keep under `/api/projects/[id]/` as the HLD specifies.**

**Rationale:** Module operations are always project-scoped — you publish from a module project, import into a consumer project, browse from a consumer project's context. A top-level `/api/modules/` surface would need its own project context resolution and would bypass the existing `withRouteHandler({ requireProject: true })` middleware chain that provides tenant isolation, permission checks, and audit context for free. Keeping routes under the project tree inherits all of this and follows the platform principle of project-scoped access patterns. The HLD's route structure is correct.

**Pattern reference:** Every existing resource route in Studio is project-scoped: `/api/projects/[id]/agents/`, `/api/projects/[id]/tools/`, `/api/projects/[id]/deployments/`.

## **Prasanna's Decision:** yes, keep it under projects

## 7. Studio UX

### 7a. Module state — dedicated `module-store.ts` or slices in `project-store.ts`?

**Recommendation: Dedicated `module-store.ts`.**

**Rationale:** The codebase has 27 separate Zustand stores, one per domain concern (`tool-store.ts`, `agent-detail-store.ts`, `version-store.ts`, etc.). Module state includes catalog browsing, dependency management, publish status, and release history — distinct from project CRUD. Adding module slices to the 128-line `project-store.ts` would bloat it and create coupling between project listing and module operations. A dedicated `module-store.ts` following the non-persisted pattern (like `tool-store.ts`) keeps concerns separated and is consistent with the codebase's one-store-per-domain convention.

**Pattern reference:** `apps/studio/src/store/tool-store.ts` — domain-specific, non-persisted, with computed counts.

**Prasanna's Decision:** Extend project-store with `kind` awareness + dedicated module-store for module-specific operations (Option C).

**Resolved:** project-store gains `kind: 'application' | 'module'` on the `Project` interface, a `moduleFilter` state, and a `selectModuleProjects` selector (~15 lines of change). A new `module-store.ts` manages module-specific state: releases, dependencies, catalog, publish status, environment pointers. This avoids divergent paths — the project listing layer is shared, module-specific views read from module-store. Analogous to how tool-store manages tool-specific operations without duplicating project-store.

---

### 7b. Imported symbols in ABLEditor — read-only decorations or completions-only?

**Recommendation: Both — read-only decorations in the symbol tree AND completions during typing.**

**Rationale:** Imported symbols need to be discoverable (so authors know what's available) and usable (so authors can reference them in DSL). The `ABLSymbolTree.tsx` already renders a collapsible tree of document symbols — imported symbols should appear in a separate "Imported Modules" group with provenance badges and a lock icon indicating read-only. Monaco completions should include imported agent/tool names so authors can reference `benefits__lookup_agent` in handoff targets without memorizing the exact mounted name. Both surfaces serve different workflows (browsing vs writing) and are complementary.

**Pattern reference:** `apps/studio/src/components/abl/ABLSymbolTree.tsx` — existing collapsible tree with section grouping.

## **Prasanna's Decision:** Yes, both

### 7c. `PublishModuleDialog` — stepper or single-page form?

**Recommendation: Single-page form with progressive disclosure.**

**Rationale:** The publish form has only three inputs (version, release notes, target pointer). A stepper adds navigation overhead for a simple operation. Instead, use a single dialog with the form fields at top, and a collapsible "Release Preview" section below showing exported agents, tools, prerequisites, and warnings. This mirrors the existing `NewProjectWizard` component which uses a single-page form with sections rather than a multi-step stepper for simple flows. Reserve steppers for complex multi-decision flows like the import dialog where prerequisite resolution happens between steps.

**Pattern reference:** `apps/studio/src/components/creation/NewProjectWizard.tsx` — single-page with sections for simple creation.

## **Prasanna's Decision:** Single page is fine

### 7d. i18n — `modules` key in existing `studio.json` or new file?

**Recommendation: `modules` key in the existing `studio.json`.**

**Rationale:** The codebase uses a single `studio.json` file with top-level domain keys (`common`, `nav`, `auth`, `sessions`, etc.). All 27 Studio stores and their components read from this single namespace. Adding a separate `modules.json` file would require a second `useTranslations` provider or a namespace merge — neither of which exists in the codebase today. Adding `"modules": { "publish": { ... }, "import": { ... }, "catalog": { ... } }` to `studio.json` is consistent and requires zero infrastructure changes.

**Pattern reference:** `packages/i18n/locales/en/studio.json` — single file, domain keys at top level.

## **Prasanna's Decision:** module key

## 8. Rollout

### 8a. Feature flag name?

**Recommendation: `reusable_modules`.**

**Rationale:** Matches the feature name used in the HLD and docs. The existing `PLAN_FEATURES` in `feature-gate.ts` uses snake_case keys (`knowledge_ai`, `advanced_analytics`, etc.). `reusable_modules` follows the same convention and is descriptive without being overly long.

## **Prasanna's Decision:** reusable_modules it is.

### 8b. Should the module feature gate fail closed (diverging from the current fail-open pattern)?

**Recommendation: Yes — fail closed for module operations.**

**Rationale:** The current feature gate fails open (`next()` on error, line 142 of `feature-gate.ts`) to avoid blocking latency-critical runtime paths. Module operations (publish, import, catalog browse) are user-initiated control-plane actions, not hot-path runtime requests. A transient DB failure that accidentally enables modules for an unpurchased tenant is worse than a transient denial of module access. The module gate middleware should catch gate-check errors and return 503 instead of calling `next()`. This can be implemented as a wrapper around the existing gate that overrides the error behavior for module-specific routes only, leaving all other routes fail-open.

## **Prasanna's Decision:** yes fail closed.

### 8c. Separate flags for Studio and Runtime, or single flag?

**Recommendation: Single flag (`reusable_modules`) read by both, but with different resolution paths.**

**Rationale:** A single flag avoids configuration drift where Studio enables modules but Runtime doesn't (or vice versa). However, Studio has no feature gate infrastructure today — it's a Next.js app, not Express. The resolution paths should be:

- **Runtime:** Use the existing `feature-gate.ts` middleware on module-related routes
- **Studio:** Add a server-side API route (`/api/features`) that calls the Runtime's feature resolution endpoint and caches the result per tenant for 60 seconds. Studio components read this via an SWR hook (`useFeatures()`). This avoids building a duplicate gate system in Studio.

If the runtime is unreachable, Studio should fail closed (hide module UI) consistent with 8b.

## **Prasanna's Decision:** single flag

## 9. Concurrency

### 9a. `dependencyVersion` counter — on `Project` document or separate `ProjectModuleMeta`?

**Recommendation: On the `Project` document itself.**

**Rationale:** The counter is incremented only on dependency mutations (create, delete, replace) — not on every project edit. The `Project` document is already updated during import/remove operations (audit trail, updatedAt). Adding a single integer field (`moduleDependencyVersion: { type: Number, default: 0 }`) to `Project` avoids creating a new collection for a single counter. The `Project` document is not a hot-write target — it's updated on project settings changes, which are infrequent. The deployment build reads the counter once, does its work, and verifies once — this is a classic optimistic lock with minimal contention.

**Pattern reference:** `packages/database/src/models/project.model.ts` — `_v` field already exists as a schema version counter, showing the pattern of integer counters on the project document.

## **Prasanna's Decision:** Project document

### 9b. Redis lock TTL for `project:{projectId}:deploy`?

**Recommendation: 60 seconds with 30-second renewal, using the platform's existing `SET NX PX` pattern.**

**Rationale:** The combined compile for a consumer with 5 modules × 10 agents = 50 compilations at ~100ms each = ~5 seconds. Add snapshot creation, persistence, and deployment record update — total ~10-15 seconds for a realistic worst case. A 60-second TTL provides 4x headroom for slow compilations or degraded DB performance. Renewal at 30 seconds prevents premature expiry during legitimate long-running builds. If the lock holder crashes, the 60-second TTL ensures the lock auto-releases without manual intervention.

The lock key should be `module:deploy:{tenantId}:{projectId}` (including tenantId for isolation). Acquisition failure should return 409 with `"A deployment build is already in progress for this project"`.

**Pattern reference:** CLAUDE.md platform principle — "Distributed locks via Redis `SET NX PX`".

**Prasanna's Decision:** go with recommendation

---

### 9c. Concurrent pointer promotions — `revision` counter or Redis lock?

**Recommendation: `revision` counter (optimistic concurrency) as already specified in the HLD.**

**Rationale:** Pointer promotions are lightweight single-field updates (`moduleReleaseId` on `ModuleEnvironmentPointer`). The HLD already includes a `revision` field on this entity. Using `findOneAndUpdate({ _id, revision: expectedRevision }, { $set: { moduleReleaseId, revision: expectedRevision + 1 } })` is atomic in MongoDB and produces a clean conflict response when two promotions race. A Redis lock would be overkill for a single-document atomic update. The version-service already uses this exact pattern for deployment promotion (lines 559-572 of `version-service.ts`).

**Pattern reference:** `apps/runtime/src/services/version-service.ts:559-572` — optimistic locking on promote via status/version check.

## **Prasanna's Decision:** go with recommendation

## Summary

| Section | Key Decision                                          | Pattern Source                             |
| ------- | ----------------------------------------------------- | ------------------------------------------ |
| 1a      | Separate collection (no discriminators)               | Every existing model                       |
| 1b      | `archivedAt` pattern, visible with badge              | `session.model.ts`, `workflow.model.ts`    |
| 1c      | Denormalized `contractSnapshot` on dependency         | `deployment.model.ts` agentVersionManifest |
| 1d      | Eager cascade (same as variable snapshots)            | `cascade-delete.ts:200-210`                |
| 2a      | Compile at publish, store DSL + IR                    | `version-service.ts:166-446`               |
| 2b      | Two-tier: blocking errors + non-blocking warnings     | `prerequisite-validator.ts`                |
| 2c      | SHA-256 of canonical JSON (DSL + entryAgentName)      | `version-service.ts:400-410`               |
| 3a      | `^[a-z][a-z0-9_]{1,24}$`, collision check at import   | —                                          |
| 3b      | Rewrite ALL references uniformly                      | Language module systems                    |
| 3c      | Post-compilation IR tree walk                         | `auth-requirement-collector.ts`            |
| 4a      | No caching in Phase 1 (YAGNI)                         | —                                          |
| 4b      | Structured per-agent diagnostics, truncated to 10     | `preflight-validation-service.ts`          |
| 4c      | New standalone service, delegates to version-service  | `snapshot-service.ts`                      |
| 5a      | Top-level `moduleProvenance` map on session           | `session/types.ts`                         |
| 5b      | Trace auth resolution scope for imported tools        | `trace-store.ts`                           |
| 5c      | Eager load at session bootstrap                       | `deployment-resolver.ts:147-215`           |
| 6a      | Summary catalog + separate detail endpoint            | `api/projects.ts` list/detail              |
| 6b      | Two-step preview/confirm                              | `import/preview` + `import/apply`          |
| 6c      | Under `/api/projects/[id]/` (project-scoped)          | Every existing resource route              |
| 7a      | Extend project-store + dedicated module-store         | project-store + tool-store analogy         |
| 7b      | Both decorations + completions                        | `ABLSymbolTree.tsx`                        |
| 7c      | Single-page form with progressive disclosure          | `NewProjectWizard.tsx`                     |
| 7d      | `modules` key in existing `studio.json`               | Single-file i18n convention                |
| 8a      | `reusable_modules`                                    | `PLAN_FEATURES` snake_case convention      |
| 8b      | Fail closed for module operations                     | Security review finding                    |
| 8c      | Single flag, Studio reads via runtime API + SWR cache | No existing Studio gate infra              |
| 9a      | Counter on `Project` document                         | `_v` pattern on Project                    |
| 9b      | 60s TTL with 30s renewal                              | Platform `SET NX PX` pattern               |
| 9c      | `revision` counter (optimistic concurrency)           | `version-service.ts:559-572`               |

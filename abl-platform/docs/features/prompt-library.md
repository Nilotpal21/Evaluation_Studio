# Feature: Prompt Library

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: ALPHA
**Feature Area(s)**: `agent lifecycle`, `project lifecycle`, `governance`
**Package(s)**: `apps/studio`, `apps/runtime`, `packages/compiler`, `packages/database`, `packages/shared-auth`
**Owner(s)**: Platform Team
**Testing Guide**: `../testing/prompt-library.md`
**Last Updated**: 2026-04-28

---

## 1. Introduction / Overview

### Problem Statement

Today, prompt iteration on ABL Platform is primitive. The only path to edit a system prompt is to modify the `SYSTEM_PROMPT:` directive in an agent's ABL DSL, recompile the agent, create a new agent version, and validate by chatting through the Studio debug panel. There is no way to A/B test two prompts against the same model, no way to compare a prompt across multiple models, no way to share or reuse a prompt across agents, and no version history for the prompt itself separate from the agent version. The platform-wide `PromptTemplate` model exists only as an internal seed catalog for runtime system-prompt scaffolding (`packages/database/src/models/prompt-template.model.ts`) — it is not user-editable, not tenant-scoped, and not surfaced in Studio. Prompt engineers and agent developers resort to side-channel comparison (multiple browser windows, manual spreadsheets) and ad-hoc deployment-to-test cycles that are slow, error-prone, and impossible to audit.

**Who it affects:** Prompt engineers, agent developers, project operators, and platform admins who own RBAC governance for prompt content.

**Current pain:** Editing a system prompt requires editing DSL, recompiling, deploying a new agent version, and chatting manually — a 5+ minute round trip per iteration. There is no isolated prompt-testing surface and no way to share prompts across agents.

### Goal Statement

Add a project-scoped Prompt Library under Studio's Resources area that lets users author, version, and reference prompts as first-class assets, with an integrated single-turn test harness for side-by-side comparison across models and across versions. Reduce prompt iteration cycle time from minutes to seconds, enable safe sharing of vetted prompts across agents via pinned-version references, and give operators visibility into which agents consume which prompt versions.

### Summary

Users open Studio → Resources → **Prompt Library** to create a prompt with a Handlebars-style template (`{{variable}}` placeholders), declared variables, description, and tags. They iterate on the template in a draft version, then promote a version to `active` when ready. From the agent IdentityEditor, they pick a library prompt + version as the agent's system prompt source — the compiler resolves the pinned content into the agent's IR at compile time, so runtime prompt resolution stays unchanged. From the Prompt Library detail page, they run a side-by-side test harness in two modes: (a) one prompt × N models (find the cheapest model that's good enough) or (b) N versions × one model (regression-test an edit). The test harness is single-turn (system + one user message → one response), executes through `ModelResolutionService.resolve()` for credential and budget governance, and runs up to 5 panes in parallel. The library shows reverse references ("3 agents using v2") and supports a one-click "extract this agent's system prompt to library" action for adoption. The lifecycle is a 3-state model (`draft` / `active` / `archived`) without the `testing`/`staged` gates that apply to compiled agent versions, because a prompt is content, not code.

---

## 2. Scope

### Goals

- **G1**: Provide CRUD + version management for project-scoped, tenant-isolated prompts with a 3-state lifecycle (`draft` / `active` / `archived`).
- **G2**: Allow agents to reference a library prompt by pinned version (`{ promptId, versionId, resolvedHash }`) so prompt edits never silently propagate to live agents.
- **G3**: Provide a single-turn side-by-side test harness with two comparison axes (prompt × N models, N versions × model) honoring `ModelResolutionService` credential and budget governance.
- **G4**: Surface reverse references ("N agents using v3") so operators can see prompt impact before archiving and offer in-place upgrade flows for consuming agents.
- **G5**: Enforce platform invariants — tenant/project isolation, RBAC permissions (`prompt:create|read|update|delete|test|promote`), audit logging on lifecycle transitions, sanitized error responses.

### Non-Goals (Out of Scope)

- **NG-1**: Multi-turn conversation testing — owned by `agent-testing-evals` (BETA).
- **NG-2**: Automated scoring / LLM-judge grading of prompt test results — humans compare visually in v1.
- **NG-3**: Cross-tenant prompt sharing or marketplace.
- **NG-4**: Prompt-as-tool templates (tool-specific prompt engineering is a separate concern).
- **NG-5**: CI/CD integration or automated regression detection on prompt changes.
- **NG-6**: Prompt chaining or composition (a single template per agent, no layering of multiple library prompts).
- **NG-7**: Prompt analytics dashboards beyond `usageCount` denormalized on the prompt item and per-version test history.
- **NG-8**: Full cross-product compare grid (N prompts × M models simultaneously) — only the two single-axis modes are supported in v1.
- **NG-9**: Live A/B traffic split between prompt versions — owned by `experiments` (PLANNED).
- **NG-10**: Encryption-at-rest for prompt content (templates are not credentials).

---

## 3. User Stories

| ID    | As a...          | I want to...                                                                                | So that...                                                           | Priority |
| ----- | ---------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------- |
| US-1  | Prompt Engineer  | Create a prompt with a Handlebars template, declared variables, description, and tags       | I can manage prompts as named, reusable assets                       | P0       |
| US-2  | Prompt Engineer  | Save iterations as draft versions and promote a chosen version to active                    | I can iterate safely without affecting live agents                   | P0       |
| US-3  | Prompt Engineer  | Compare the same prompt across up to 5 models side-by-side with a fixed user message        | I can pick the smallest model that meets quality bar for the prompt  | P0       |
| US-4  | Prompt Engineer  | Compare 2+ versions of the same prompt against one model                                    | I can regression-test a prompt edit before promoting                 | P0       |
| US-5  | Agent Developer  | Pick a library prompt + version as my agent's system prompt source from the Identity editor | I reuse vetted prompts and pin to a known-good version               | P0       |
| US-6  | Agent Developer  | One-click extract my agent's existing inline system prompt to the library                   | I can adopt the library on existing agents without manual copy/paste | P1       |
| US-7  | Project Operator | See which agents reference each prompt version and upgrade them in place                    | I can plan archival and roll out prompt updates with full visibility | P0       |
| US-8  | Project Operator | Archive an active prompt version, blocking new references but preserving existing pins      | I can deprecate stale prompts without breaking running agents        | P1       |
| US-9  | Tester           | Run prompt comparisons without create/promote permissions                                   | I can validate prompt quality without authoring rights               | P1       |
| US-10 | Platform Admin   | Assign `prompt:*` permissions to custom project roles                                       | I can govern who can author, test, and promote prompts               | P1       |

---

## 4. Functional Requirements

1. **FR-1**: The system must provide CRUD endpoints for `PromptLibraryItem` records scoped by `tenantId` + `projectId`, with a unique `name` constraint per project.
2. **FR-2**: The system must support versioned `PromptLibraryVersion` records storing `template` (Handlebars string), `variables` (string array), optional `description`, an immutable `sourceHash` (SHA-256 of `template` + sorted variables), and lifecycle `status`.
3. **FR-3**: The system must enforce a 3-state version lifecycle (`draft` → `active` → `archived`) with at most one `active` version per prompt at any time. Promoting a new version to `active` automatically demotes the previously active version.
4. **FR-4**: The system must provide a single-turn test endpoint that accepts a `promptVersionId`, a `variables` object, a `userMessage` string, and a `tenantModelId`, resolving credentials and enforcing budget via `ModelResolutionService.resolve()` and returning `{ output, usage, latencyMs, model, provider }`.
5. **FR-5**: The system must support comparison mode in the test endpoint: (a) one `promptVersionId` × up to 5 `tenantModelId` values executed in parallel, and (b) up to 5 `promptVersionId` values × one `tenantModelId` executed in parallel. Cross-product (N prompts × M models) is rejected with HTTP 400.
6. **FR-6**: The system must extend `SystemPromptConfig` in the compiler IR with an optional `libraryRef: { promptId, versionId, resolvedHash }` field. The compiler must resolve the referenced version's template into `system_prompt.template` and set `system_prompt.custom = true` at compile time. Runtime `buildSystemPrompt()` requires zero changes for the resolved-template path.
7. **FR-7**: The system must register `prompt:create`, `prompt:read`, `prompt:update`, `prompt:delete`, `prompt:test`, `prompt:promote` permissions in `PERMISSION_REGISTRY` and assign them to built-in project roles (`developer`: all six; `tester`: `read` + `test`; `viewer`: `read`).
8. **FR-8**: The system must provide a Studio resource page (CRUD list, prompt detail with template editor, version list, compare UI) reachable from a 4th entry in `resourceNavDefs` after Tools, Knowledge Bases, and Connections.
9. **FR-9**: The system must provide a prompt picker in the Studio agent IdentityEditor that lets users select a library prompt and pin a specific version, writing `libraryRef` into the agent's working copy.
10. **FR-10**: The system must support reverse-reference queries — given a `promptId` (and optionally `versionId`), return the count and list of agents whose latest IR contains a matching `libraryRef`.
11. **FR-11**: The system must emit audit log entries for state-changing prompt lifecycle events: `prompt.created`, `prompt.version_created`, `prompt.version_promoted`, and `prompt.version_archived` using the existing audit infrastructure pattern from `apps/runtime/src/routes/versions.ts`. Prompt test runs remain execution telemetry, not durable audit rows.
12. **FR-12**: The system must reject prompt templates larger than 32KB, more than 20 variables per template, individual variable values larger than 4KB, and more than 200 versions per prompt at the API boundary with structured error responses (`{ success: false, error: { code, message } }`).
13. **FR-13**: The system must strip Handlebars delimiters (`{{`, `}}`) from user-supplied variable values at the test endpoint to prevent nested-template-injection attacks.
14. **FR-14**: The system must return HTTP 404 for cross-project and cross-tenant access attempts on prompt resources, never 403, per the platform isolation invariant.
15. **FR-15**: The system must throw a configuration error (sanitized for user surfaces, detailed for logs) when an agent's `libraryRef` points to a deleted prompt or archived version at runtime, rather than silently substituting an empty system prompt.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                     |
| -------------------------- | ------------ | ----------------------------------------------------------------------------------------- |
| Project lifecycle          | PRIMARY      | New project-scoped resource type, registered in resource navigation                       |
| Agent lifecycle            | PRIMARY      | Agents reference prompts via `SystemPromptConfig.libraryRef`; affects compile and runtime |
| Customer experience        | NONE         | No direct end-user surface; affects authoring tools only                                  |
| Integrations / channels    | NONE         | Channel-agnostic feature                                                                  |
| Observability / tracing    | SECONDARY    | Test endpoint emits `TraceEvent`s; lifecycle transitions emit audit logs                  |
| Governance / controls      | PRIMARY      | New RBAC permissions, project/tenant isolation, version lifecycle gating                  |
| Enterprise / compliance    | SECONDARY    | Audit logging on promote/archive; retention follows project lifecycle                     |
| Admin / operator workflows | SECONDARY    | Reverse-reference visibility for upgrade planning                                         |

### Related Feature Integration Matrix

| Related Feature                                           | Relationship Type | Why It Matters                                                                                        | Key Touchpoints                                                       | Current State |
| --------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------- |
| [Agent Anatomy](agent-anatomy.md)                         | extends           | Adds optional `libraryRef` to `SystemPromptConfig` in the IR contract                                 | `packages/compiler/src/platform/ir/schema.ts`                         | STABLE        |
| [Agent Development (Studio)](agent-development-studio.md) | extends           | Adds prompt picker to IdentityEditor                                                                  | `apps/studio/src/components/agent-editor/sections/IdentityEditor.tsx` | STABLE        |
| [Agent Testing & Evals](agent-testing-evals.md)           | sibling, distinct | Both test prompts at different granularity — evals tests full agent flows; library tests prompts only | None — distinct data models                                           | BETA          |
| [Tool Lifecycle](arch-tool-lifecycle.md)                  | parity reference  | Mirrors versioned-resource CRUD + lifecycle pattern                                                   | Pattern only                                                          | STABLE        |
| [Model Hub](model-hub.md)                                 | depends on        | Test endpoint resolves credentials + budget via `ModelResolutionService` against tenant models        | `apps/runtime/src/services/llm/model-resolution.ts`                   | BETA          |
| [Deployments & Versioning](deployments-versioning.md)     | parity reference  | Mirrors version-service shape (sourceHash dedup, lifecycle transitions) but with simpler 3-state      | `apps/runtime/src/services/version-service.ts`                        | BETA          |
| [Audit Logs](arch-audit-logs.md)                          | emits into        | Lifecycle transitions and test invocations are audit events                                           | Audit emit pattern in `apps/runtime/src/routes/versions.ts`           | STABLE        |
| [Billing](billing.md)                                     | configured by     | Test invocations consume budget via `ModelResolutionService.checkAndRecordBudget()`                   | `apps/runtime/src/services/llm/model-resolution.ts:27-29`             | BETA          |

---

## 6. Design Considerations

- **Resource navigation slot**: Prompt Library lives as the 4th entry in `resourceNavDefs` (`apps/studio/src/config/navigation.ts:76-81`) alongside Tools, Knowledge Bases (search-ai), and Connections. Section label uses an existing translation key pattern (e.g., `t('section_resources')` followed by per-item labels).
- **Editor surface**: Prompt detail page with a template editor (monospace, syntax highlight on `{{...}}` tokens), variable list synthesized from template, description, and tags. Compare UI is a 2-column or up-to-5-column grid (Mode A: each column shows one model's response; Mode B: each column shows one version's response).
- **Picker integration**: IdentityEditor (`apps/studio/src/components/agent-editor/sections/IdentityEditor.tsx`) currently exposes goal/persona/limitations only — system prompt is implicit. Add a new "System Prompt Source" section with toggle between "Inline (DSL)" and "From Library" modes. "From Library" mode opens a modal picker showing prompts in the current project, with version dropdown.
- **Reverse-reference visibility**: Prompt detail shows "Used by N agents" with click-through to a list. Implementation requires either reverse-index maintenance on agent compile or query-time scan of `agent_versions.irContent`. Decided: query-time scan for v1 (acceptable for project-scoped reads), with denormalized `usageCount` updated on agent compile/decompile for fast list rendering.
- **Compare-mode UX**: Side-by-side panes show streaming responses (not strictly required for v1 — bulk responses acceptable), latency, token usage, and cost estimate per pane. Each pane has a "copy output" action.
- **Studio design system**: Use semantic tokens (`@agent-platform/design-tokens`) per `studio-design-system` skill — no hardcoded Tailwind palette colors.

---

## 7. Technical Considerations

- **No new external dependencies**. Vercel AI SDK (`ai`), Mongoose plugins, `crypto.createHash`, and the existing `renderTemplate()` from `packages/shared/src/prompts/template-engine.ts:101` cover all needs.
- **Tenant isolation pattern**: Both new models use `tenantIsolationPlugin` (matching `WorkflowVersion`, NOT `AgentVersion` — `AgentVersion` lacks the plugin and relies on parent agent for scoping; that pattern is wrong for a top-level resource).
- **Compile-time vs runtime resolution**: The compiler resolves `libraryRef` → `template` text once at agent compile time, sets `custom: true`, and stores `resolvedHash` for cache-key staleness detection. Runtime `buildSystemPrompt()` (`apps/runtime/src/services/execution/prompt-builder.ts:954-959`) sees the resolved text and works unchanged. This keeps `SessionService.computeIRHash()` clean — the IR hash naturally changes only when the pin changes.
- **Test endpoint location**: Owned by runtime (`apps/runtime/src/routes/prompt-library.ts`), proxied from Studio. Studio does NOT import `ModelResolutionService` directly — it issues an HTTP call to runtime, preserving the service boundary that runtime owns model resolution and credential/budget governance.
- **Cross-service authentication**: Studio → runtime calls go through the existing platform-key / inter-service auth path used by other Studio API routes; the resolved user identity is forwarded so `ModelResolutionService` user-scoping applies.
- **Sanitization**: User-facing test errors must use shared sanitizer helpers per CLAUDE.md "User-Facing Runtime Error Sanitization" — no leaking tenant IDs, model IDs, or credential hints in the test response error envelope.
- **Race condition on promote**: Two concurrent promotes must not leave two `active` versions. Use a Mongo transaction or `findOneAndUpdate` + version guard to atomically demote-old and promote-new, matching the `version-service.ts` transition pattern.
- **Audit log sequencing**: Audit emissions for promote/archive must happen after the DB transaction commits, never before, to avoid logging a non-event.

---

## 8. How to Consume

### Studio UI

| Surface                       | Route                                                             | Role / Permission                                                        | Purpose                                                            |
| ----------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Prompt Library list           | `/projects/:projectId/resources/prompt-library`                   | `prompt:read`                                                            | Inventory of prompts in the project                                |
| Prompt detail / editor        | `/projects/:projectId/resources/prompt-library/:promptId`         | `prompt:read` (view), `prompt:update` (edit), `prompt:promote` (promote) | Edit template, manage versions, see reverse references             |
| Compare mode                  | `/projects/:projectId/resources/prompt-library/:promptId/compare` | `prompt:test`                                                            | Side-by-side test harness (Mode A or Mode B)                       |
| Identity editor prompt picker | Modal launched from existing agent IdentityEditor                 | `agent:update` + `prompt:read`                                           | Pin a library prompt + version as the agent's system prompt source |
| Extract-to-library action     | Button in IdentityEditor when system prompt is inline             | `agent:update` + `prompt:create`                                         | One-click migrate inline DSL system prompt to a new library prompt |

### Surface Semantics Matrix

| Asset / Entity Type    | Source of Truth / Ownership  | Design-Time Surface(s)                       | Editable or Read-Only?                          | Consumer Reference / Binding Model                                    | Runtime Materialization / Resolution                                                                | Notes / Unsupported State                                                |
| ---------------------- | ---------------------------- | -------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `PromptLibraryItem`    | Project (tenant + projectId) | Studio Prompt Library page                   | Editable (CRUD)                                 | `agent_version.irContent.identity.system_prompt.libraryRef.promptId`  | Resolved at agent compile time into `system_prompt.template`; runtime sees only the resolved string | Cross-project reference is unsupported (404)                             |
| `PromptLibraryVersion` | Project (tenant + projectId) | Studio Prompt Library detail page (versions) | Editable while `draft`; immutable once `active` | `agent_version.irContent.identity.system_prompt.libraryRef.versionId` | Resolved at agent compile time; `resolvedHash` carried forward for staleness detection              | Archived versions remain readable but cannot be referenced by new agents |

### Design-Time vs Runtime Behavior

- **Design-time** (Studio): Authors create prompts and versions, run compare tests, pick prompts in IdentityEditor, see reverse references. Library lives entirely in the control plane; nothing is materialized in runtime caches until an agent that references it is compiled.
- **Compile-time** (compiler): When an agent with `libraryRef` is compiled, the compiler fetches the pinned version, copies `template` into `system_prompt.template`, sets `custom: true`, and records `resolvedHash`. The resulting agent IR is self-contained — runtime needs no library access to execute the agent.
- **Runtime** (executor): `buildSystemPrompt()` sees the resolved template (custom: true) and renders it through `renderTemplate()` exactly as it does today for inline custom prompts. The library is read at runtime ONLY by the prompt-library test endpoint, never by session execution.
- **Author-facing vs runtime names**: The author selects "Customer Onboarding Prompt v3"; the agent IR stores `libraryRef.promptId` (`pl_…`) and `libraryRef.versionId` (`plv_…`) plus the resolved `template` text. The author-facing label is reconstructed at design time from the resource ID; runtime never reads the library.

### API (Runtime)

| Method | Path                                                                                    | Purpose                                                            |
| ------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| POST   | `/api/projects/:projectId/prompt-library/prompts`                                       | Create a prompt (initial draft version optional)                   |
| GET    | `/api/projects/:projectId/prompt-library/prompts`                                       | List prompts (paginated, filter by tag/status)                     |
| GET    | `/api/projects/:projectId/prompt-library/prompts/:promptId`                             | Get a prompt with its versions metadata                            |
| PATCH  | `/api/projects/:projectId/prompt-library/prompts/:promptId`                             | Update prompt metadata (description, tags, name)                   |
| DELETE | `/api/projects/:projectId/prompt-library/prompts/:promptId`                             | Delete prompt (only if no versions are referenced)                 |
| POST   | `/api/projects/:projectId/prompt-library/prompts/:promptId/versions`                    | Create a draft version                                             |
| GET    | `/api/projects/:projectId/prompt-library/prompts/:promptId/versions`                    | List versions of a prompt                                          |
| GET    | `/api/projects/:projectId/prompt-library/prompts/:promptId/versions/:versionId`         | Get a specific version's full content                              |
| PATCH  | `/api/projects/:projectId/prompt-library/prompts/:promptId/versions/:versionId`         | Update a draft version (rejected if not `draft`)                   |
| POST   | `/api/projects/:projectId/prompt-library/prompts/:promptId/versions/:versionId/promote` | Promote draft → active (atomic demote-and-promote)                 |
| POST   | `/api/projects/:projectId/prompt-library/prompts/:promptId/versions/:versionId/archive` | Archive an active or draft version                                 |
| GET    | `/api/projects/:projectId/prompt-library/prompts/:promptId/references`                  | Reverse references — list agents using this prompt                 |
| POST   | `/api/projects/:projectId/prompt-library/test`                                          | Single-turn test (one prompt × N models OR N versions × one model) |

### API (Studio)

Studio API routes proxy to runtime endpoints above; they do not own data. Routes mirror the runtime paths under `/api/projects/:projectId/...` within Studio's Next.js App Router (`apps/studio/src/app/api/...`).

| Method | Path                                       | Purpose                                                |
| ------ | ------------------------------------------ | ------------------------------------------------------ |
| ALL    | Studio API mirrors of runtime routes above | Authenticated proxy to runtime; no DB access in Studio |

### Admin Portal

No admin-portal surface in v1. Tenant-wide prompt governance is handled via project RBAC. If platform-wide prompt galleries become a need, a future admin-portal surface can be added without breaking the project-scoped data model.

### Channel / SDK / Voice / A2A / MCP Integration

Not channel-aware. Prompts are consumed transitively through agents (which themselves are channel-aware). No SDK, voice, A2A, or MCP changes are required.

---

## 9. Data Model

### Collections / Tables

```text
Collection: prompt_library_items
Fields:
  - _id: string (pl_…)
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - name: string (required, unique within tenantId+projectId)
  - description: string (optional)
  - tags: string[] (optional, default [])
  - usageCount: number (denormalized, default 0; updated on agent compile/decompile)
  - status: 'active' | 'archived' (item-level lifecycle; default 'active')
  - createdBy: string (user ID)
  - createdAt: Date
  - updatedAt: Date
Indexes:
  - { tenantId: 1, projectId: 1, name: 1 } unique
  - { tenantId: 1, projectId: 1, status: 1 }
  - { tenantId: 1, projectId: 1, tags: 1 }

Collection: prompt_library_versions
Fields:
  - _id: string (plv_…)
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - promptId: string (required, FK to prompt_library_items._id)
  - versionNumber: number (monotonic per promptId)
  - template: string (required, max 32KB)
  - variables: string[] (required, max 20)
  - description: string (optional, version-level changelog)
  - status: 'draft' | 'active' | 'archived' (required)
  - sourceHash: string (sha256 of template + sorted variables JSON)
  - metadata: Record<string, unknown> (optional)
  - createdBy: string (user ID)
  - createdAt: Date
  - publishedAt: Date (set when status transitions to 'active')
  - publishedBy: string (set when status transitions to 'active')
Indexes:
  - { tenantId: 1, projectId: 1, promptId: 1, versionNumber: 1 } unique
  - { tenantId: 1, projectId: 1, promptId: 1, status: 1 } (fast active-version lookup)
  - { tenantId: 1, projectId: 1, sourceHash: 1 } (dedup detection)

Plugins: tenantIsolationPlugin on both collections (matches WorkflowVersion pattern).
```

### Modified Collections / Tables

- **`agent_versions.irContent.identity.system_prompt`** — adds optional `libraryRef: { promptId: string; versionId: string; resolvedHash: string }`. Existing documents without `libraryRef` are unaffected.

### Key Relationships

- `PromptLibraryVersion.promptId` → `PromptLibraryItem._id` (parent-child within the same project).
- `agent_versions.irContent.identity.system_prompt.libraryRef.{promptId, versionId}` → `prompt_library_versions._id` (resolved at compile time; reverse-reference query scans `agent_versions`).
- `usageCount` on `PromptLibraryItem` is a denormalization; it's updated by the agent-compile path when it sees a `libraryRef`. Source of truth is the reverse-reference query.

### Queried Existing Collections

- `agent_versions` — scanned by the reverse-reference query at `irContent.identity.system_prompt.libraryRef.promptId`. **No new index in v1** (acceptable up to ~1000 agents per project per GAP-003); a partial/sparse index on this dotted path may be added in a follow-up if performance regresses.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                      | Purpose                                                                       |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `packages/database/src/models/prompt-library-item.model.ts`               | NEW — `PromptLibraryItem` Mongoose model                                      |
| `packages/database/src/models/prompt-library-version.model.ts`            | NEW — `PromptLibraryVersion` Mongoose model                                   |
| `packages/compiler/src/platform/ir/schema.ts`                             | MODIFIED — add `libraryRef` to `SystemPromptConfig`                           |
| `packages/compiler/src/platform/ir/compiler.ts`                           | MODIFIED — resolve `libraryRef` to `template` at compile time                 |
| `apps/runtime/src/services/prompt-library/prompt-library-service.ts`      | NEW — CRUD + version lifecycle service                                        |
| `apps/runtime/src/services/prompt-library/prompt-library-test-service.ts` | NEW — single-turn test execution via `ModelResolutionService` + Vercel AI SDK |
| `packages/shared-auth/src/rbac/role-permissions.ts`                       | MODIFIED — register `prompt:*` permissions                                    |

### Routes / Handlers

| File                                                       | Purpose                                    |
| ---------------------------------------------------------- | ------------------------------------------ |
| `apps/runtime/src/routes/prompt-library.ts`                | NEW — runtime CRUD + version + test routes |
| `apps/runtime/src/server.ts`                               | MODIFIED — mount the new router            |
| `apps/studio/src/app/api/projects/[id]/prompt-library/...` | NEW — Studio proxy routes                  |

### UI Components

| File                                                                     | Purpose                                                                                      |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `apps/studio/src/config/navigation.ts`                                   | MODIFIED — add prompt-library entry to `resourceNavDefs`                                     |
| `apps/studio/src/store/navigation-store.ts`                              | MODIFIED — add `prompt-library` to `ProjectPage` union                                       |
| `apps/studio/src/components/navigation/ProjectSidebar.tsx`               | MODIFIED — render prompt-library nav entry                                                   |
| `apps/studio/src/components/navigation/AppShell.tsx`                     | MODIFIED — add `case 'prompt-library'` to `renderContent()` wiring list/detail/compare pages |
| `apps/studio/src/api/prompt-library.ts`                                  | NEW — Studio API client for prompt-library routes (unwraps `{success,data}` envelope)        |
| `apps/studio/src/components/prompt-library/PromptLibraryListPage.tsx`    | NEW — list page (SPA component, rendered via AppShell case 'prompt-library')                 |
| `apps/studio/src/components/prompt-library/PromptLibraryDetailPage.tsx`  | NEW — detail / editor page (SPA component)                                                   |
| `apps/studio/src/components/prompt-library/PromptLibraryComparePage.tsx` | NEW — compare-mode harness (SPA component)                                                   |
| `apps/studio/src/components/prompt-library/PromptEditor.tsx`             | NEW — template editor with variable extraction                                               |
| `apps/studio/src/components/prompt-library/PromptComparePanel.tsx`       | NEW — compare grid (Mode A and Mode B)                                                       |
| `apps/studio/src/components/prompt-library/PromptPickerModal.tsx`        | NEW — modal launched from IdentityEditor                                                     |
| `apps/studio/src/components/agent-editor/sections/IdentityEditor.tsx`    | MODIFIED — add System Prompt Source toggle and picker integration                            |

### Jobs / Workers / Background Processes

None in v1. `usageCount` is updated synchronously during agent compile.

### Tests

| File                                                                                     | Type        | Coverage Focus                                                                                                    |
| ---------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------- |
| `packages/database/src/__tests__/model-prompt-library-item.test.ts`                      | unit        | UT-1: schema, indexes, `tenantIsolationPlugin`                                                                    |
| `packages/database/src/__tests__/model-prompt-library-version.test.ts`                   | unit        | UT-2: schema + INT-2: sourceHash determinism                                                                      |
| `apps/runtime/src/services/prompt-library/__tests__/lifecycle.test.ts`                   | unit        | UT-3: lifecycle transition validation                                                                             |
| `apps/runtime/src/services/prompt-library/__tests__/extract-variables.test.ts`           | unit        | UT-4: `extractVariables()`                                                                                        |
| `apps/runtime/src/services/prompt-library/__tests__/validators.test.ts`                  | unit        | UT-7: boundary validators                                                                                         |
| `apps/runtime/src/services/prompt-library/__tests__/sanitize-variable-value.test.ts`     | unit        | UT-8: variable value sanitiser                                                                                    |
| `packages/shared-auth/src/__tests__/role-permissions-prompt-library.test.ts`             | unit        | UT-6: `PERMISSION_REGISTRY` + role maps                                                                           |
| `packages/compiler/src/__tests__/system-prompt-config-types.test.ts`                     | unit        | UT-5: `SystemPromptConfig` type extension                                                                         |
| `apps/runtime/src/services/prompt-library/__tests__/prompt-library-service.test.ts`      | integration | INT-1, INT-4, INT-6: atomic promote, archived-pin, boundary rejections                                            |
| `apps/runtime/src/services/prompt-library/__tests__/usage-count-denormalization.test.ts` | integration | INT-3: `usageCount` at service layer (compiler stays pure)                                                        |
| `apps/runtime/src/services/prompt-library/__tests__/prompt-library-test-service.test.ts` | integration | INT-5, INT-10: variable sanitisation, partial pane failure                                                        |
| `apps/runtime/src/services/prompt-library/__tests__/audit-emission.test.ts`              | integration | INT-7: audit log post-commit ordering                                                                             |
| `apps/runtime/src/services/agent-compile/__tests__/library-ref-resolution.test.ts`       | integration | INT-8: compile-orchestration resolves `libraryRef` → `template`, sets `custom: true` (compiler itself stays pure) |
| `apps/runtime/src/services/execution/__tests__/build-system-prompt-library-ref.test.ts`  | integration | INT-9: `buildSystemPrompt()` throws sanitised error on missing libraryRef                                         |
| `apps/runtime/src/routes/__tests__/prompt-library-references.test.ts`                    | integration | INT-11: reverse-reference query count + agent-list response shape                                                 |
| `apps/studio/src/app/api/projects/[id]/prompt-library/__tests__/proxy.test.ts`           | integration | INT-12: Studio proxy auth-context forwarding + error envelope passthrough                                         |
| `apps/runtime/src/__tests__/prompt-library-flow.e2e.test.ts`                             | e2e         | E2E-1: full create → promote → reference → session flow                                                           |
| `apps/runtime/src/__tests__/prompt-library-compare.e2e.test.ts`                          | e2e         | E2E-2, E2E-3, E2E-4: compare modes A + B + cross-product rejection                                                |
| `apps/runtime/src/__tests__/prompt-library-isolation.e2e.test.ts`                        | e2e         | E2E-5: cross-tenant + cross-project 404 across all routes                                                         |
| `apps/runtime/src/__tests__/prompt-library-rbac.e2e.test.ts`                             | e2e         | E2E-6: developer / tester / viewer role enforcement                                                               |
| `apps/studio/e2e/prompt-library/full-flow.spec.ts`                                       | e2e         | E2E-7: Studio UI create → compare → agent-pick flow (Playwright)                                                  |
| `apps/runtime/src/__tests__/helpers/prompt-library-helpers.ts`                           | helper      | Shared fixtures: `createPrompt()`, `promoteVersion()`, `mockLLMServer()`                                          |
| `apps/runtime/src/__tests__/prompt-library.perf.test.ts`                                 | perf        | §7 perf benchmarks (excluded from default CI; run via `--tier=perf`)                                              |

---

## 11. Configuration

### Environment Variables

| Variable                                  | Default | Description                                                                |
| ----------------------------------------- | ------- | -------------------------------------------------------------------------- |
| `PROMPT_LIBRARY_TEST_TIMEOUT_MS`          | `60000` | Max time for a single test pane invocation (mirrors `arch-llm.ts` pattern) |
| `PROMPT_LIBRARY_TEST_MAX_PARALLEL`        | `5`     | Max parallel comparison panes per request                                  |
| `PROMPT_LIBRARY_TEMPLATE_MAX_BYTES`       | `32768` | Max template size (32KB)                                                   |
| `PROMPT_LIBRARY_VARIABLE_VALUE_MAX_BYTES` | `4096`  | Max value length per variable at the test endpoint                         |
| `PROMPT_LIBRARY_MAX_VERSIONS_PER_PROMPT`  | `200`   | Hard limit on versions per prompt                                          |

### Runtime Configuration

No new tenant-level or per-project flags in v1. The feature is enabled by default for all tenants once shipped. RBAC is the gating mechanism.

### DSL / Agent IR / Schema

```ts
// packages/compiler/src/platform/ir/schema.ts (additive — only libraryRef is new)
export interface SystemPromptConfig {
  /** Core instruction template */
  template: string;

  /** Whether the template was explicitly provided by the user (SYSTEM_PROMPT: in DSL) */
  custom?: boolean;

  /** Dynamic sections to inject */
  sections: {
    context?: boolean;
    tools?: boolean;
    constraints?: boolean;
    history?: boolean;
  };

  /** NEW — pinned reference to a Prompt Library version (resolved at compile time into `template` + `custom: true`) */
  libraryRef?: {
    promptId: string;
    versionId: string;
    /** sha256 of the resolved template — staleness detection in agent-version sourceHash */
    resolvedHash: string;
  };
}
```

ABL DSL: prompt-library references are not exposed in the DSL surface in v1. The DSL `SYSTEM_PROMPT:` directive remains for inline prompts; library references are authored in Studio's IdentityEditor and stored in the IR layer above the DSL. (A future enhancement could add a `SYSTEM_PROMPT_REF:` DSL directive.)

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | Every prompt query must include `projectId`. Cross-project reads return 404. Cross-project pin attempts at compile time fail validation. |
| Tenant isolation  | `tenantIsolationPlugin` on both models; ALS-injected `tenantId` on every query. Cross-tenant reads return 404.                           |
| User isolation    | Prompts are project-scoped, not user-owned. RBAC governs who can author/test/promote within the project.                                 |

### Security & Compliance

- **Authn/Authz**: All routes use `createUnifiedAuthMiddleware` + `requireProjectPermission(req, res, 'prompt:<op>')` matching the pattern in `apps/runtime/src/routes/versions.ts`.
- **Input validation**: Zod schemas at the route boundary. Template size, variable count, and per-variable-value size enforced before persistence.
- **Prompt injection mitigation**: Variable values are stripped of `{{` and `}}` delimiters before rendering at the test endpoint to prevent nested-template injection. This does not protect against LLM-level prompt injection in user-controlled content — that remains the agent author's responsibility.
- **No `eval`/`new Function`**: `renderTemplate()` is regex-based string substitution; no JS execution path.
- **Audit logging**: `prompt.created`, `prompt.version_created`, `prompt.version_promoted`, and `prompt.version_archived` events emitted post-commit using the existing audit emitter pattern. Prompt test runs remain execution telemetry, not durable audit rows.
- **Error sanitization**: User-visible errors (test failures, configuration errors) routed through shared sanitizer helpers; tenant IDs, model IDs, and credential hints never leak to UI surfaces. Logs retain raw context.
- **No encryption-at-rest**: Templates are not credentials; field-level encryption is not required. Standard MongoDB encryption-at-rest applies via infrastructure.
- **Right-to-erasure**: Project deletion cascades delete prompts and versions via the existing project-deletion cascade path.

### Performance & Scalability

- **Test endpoint latency**: model latency + ≤500ms platform overhead (measured at p95). Overhead budget covers HTTP hop, credential resolution, budget check, template render, and trace emission.
- **Compare parallelism**: up to 5 panes executed in parallel via `Promise.all`. Each pane has its own timeout (`PROMPT_LIBRARY_TEST_TIMEOUT_MS`).
- **Read paths**: List queries paginated (default 50, max 200). Indexes cover all common query shapes: `{tenant,project,name}`, `{tenant,project,status}`, `{tenant,project,tags}`.
- **Template render**: O(n) per variable; 20-variable cap on a 32KB template renders in <10ms.
- **Reverse-reference query**: Scans `agent_versions.irContent` filtered to active/staged versions per project. For projects with >1000 agents, this should be acceptable (<200ms); if it becomes a hotspot, denormalize a `prompt_library_references` index in a follow-up.

### Reliability & Failure Modes

- **Atomic promote**: `findOneAndUpdate` with version guard ensures at most one `active` version per promptId, even under concurrent promotes. The losing concurrent promote receives a 409 Conflict.
- **Missing reference at runtime**: If `buildSystemPrompt()` runs against an agent IR with a `libraryRef` but `system_prompt.template` is empty (compile-time resolution failed and fallback was suppressed), throw a sanitized configuration error rather than executing with empty system prompt. (This should be unreachable in practice — compiler always resolves and copies before storing IR.)
- **Test endpoint partial failures**: If 1 of 5 panes fails (timeout, model error), the response returns 200 with the successful panes' results and a `failedPanes: [...]` array. The whole request is not failed because comparing 4-of-5 results is more useful than getting nothing.
- **Idempotency**: Create endpoints accept an optional `Idempotency-Key` header (existing platform pattern). Test endpoint is naturally non-idempotent (each call invokes a model).
- **Rollback**: This is a purely additive feature. Roll-back path is to disable the routes via feature flag (if needed) or revert the deployment; existing agents without `libraryRef` are unaffected.

### Observability

- **Trace events**: `prompt-library.test.start`, `prompt-library.test.pane.start`, `prompt-library.test.pane.complete`, `prompt-library.test.complete`. Event tags include `promptId`, `versionId`, `tenantModelId`, `latencyMs`, `tokens.input`, `tokens.output`. (Tags scrubbed by the existing tenant-scrubbing pipeline before reaching user-facing surfaces.)
- **Audit logs**: Lifecycle events (`prompt.*`) flow through the standard audit pipeline.
- **Metrics**: Test endpoint p95/p99 latency, compare-mode pane count distribution, version promotion rate, reverse-reference query duration.
- **Debug entry points**: Standard runtime debug session via the MCP debug tools; no library-specific debug tooling needed in v1.

### Data Lifecycle

- **Retention**: Prompts and versions persist for the lifetime of the project. No TTL.
- **Project deletion cascade**: Prompts and versions deleted with project (existing cascade pattern).
- **Archived versions**: Remain in storage indefinitely; not exposed as referenceable in the picker but readable for historical audit.
- **No PII**: Templates may contain instructions but should not contain end-user PII; no data minimization concerns in v1.

---

## 13. Delivery Plan / Work Breakdown

1. **Data layer & RBAC**
   1.1 Create `PromptLibraryItem` model (`packages/database`)
   1.2 Create `PromptLibraryVersion` model (`packages/database`)
   1.3 Register `prompt:*` permissions in `PERMISSION_REGISTRY` (`packages/shared-auth`)
   1.4 Assign permissions to built-in project roles (`developer`, `tester`, `viewer`)
   1.5 Unit tests: schema validation, sourceHash determinism, plugin coverage

2. **Runtime service & routes**
   2.1 Implement `PromptLibraryService` (CRUD + version lifecycle, atomic promote)
   2.2 Implement `PromptLibraryTestService` (single-turn execution via `ModelResolutionService` + Vercel AI SDK)
   2.3 Implement runtime routes (`apps/runtime/src/routes/prompt-library.ts`)
   2.4 Mount router in `server.ts`
   2.5 Audit emitter wiring for lifecycle events
   2.6 Integration tests: CRUD flow, atomic promote under concurrency, archived-pin error path
   2.7 E2E tests: HTTP CRUD, isolation 404s, compare-mode parallelism

3. **Compiler integration**
   3.1 Extend `SystemPromptConfig` schema with optional `libraryRef`
   3.2 Update compiler to fetch pinned version and resolve template at compile time
   3.3 Update `usageCount` denormalization on compile/decompile
   3.4 Integration tests: library-ref resolution, IR hash stability under pin changes
   3.5 Reverse-reference query implementation (`/references` endpoint)

4. **Studio UI — Library surface**
   4.1 Add prompt-library entry to `resourceNavDefs` and `ProjectPage` union
   4.2 List page (filter by tag/status, pagination)
   4.3 Detail page (template editor, variable extraction, version list, references)
   4.4 Compare page (Mode A and Mode B harness)
   4.5 Studio API proxy routes
   4.6 Storybook stories for new components
   4.7 Integration tests for Studio proxy routes (auth context forwarding, error envelope passthrough, isolation 404 propagation)

5. **Studio UI — Agent integration**
   5.1 Extend IdentityEditor with "System Prompt Source" toggle
   5.2 Implement PromptPickerModal with project-scoped search and version dropdown
   5.3 Implement "extract to library" one-click action
   5.4 Save path: write `libraryRef` into agent working copy; trigger compile on save
   5.5 E2E tests: agent picks library prompt, compiles, runs

6. **Validation & launch**
   6.1 Audit-log review for completeness across lifecycle events
   6.2 Performance validation (test latency, compare parallelism, reverse-reference query)
   6.3 Security review per `pre-review-checklist` and `cross-cutting-concerns` skills
   6.4 Documentation: `/post-impl-sync` to update feature spec, test spec, agents.md, plus update discovery indexes (`docs/features/README.md`, `docs/testing/README.md`)
   6.5 Internal dogfood with prompt engineers; gather feedback before promoting status

---

## 14. Success Metrics

| Metric                                              | Baseline                                         | Target                                                                                       | How Measured                                                                                        |
| --------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Prompt iteration cycle time (edit → compare)        | N/A (manual DSL edit + redeploy + chat ≈ 5+ min) | <60s from "Run Test" click to all panes rendered                                             | Studio instrumentation timestamping click-to-render                                                 |
| Library adoption among agents with custom prompts   | 0% (no library exists)                           | ≥50% of agents whose `system_prompt.custom = true` reference a library prompt within 90 days | Aggregate count over `agent_versions.irContent.identity.system_prompt.libraryRef` vs `custom: true` |
| Versions per active prompt (iteration depth)        | N/A                                              | Mean ≥3 versions per prompt with at least 1 active (signals real iteration, not 1-and-done)  | MongoDB aggregation on `PromptLibraryVersion`                                                       |
| Compare-mode usage                                  | N/A                                              | ≥2 comparison test calls per active prompt per week                                          | Count of `prompt:test` audit events with `mode=compare`                                             |
| Test endpoint p95 platform overhead (excluding LLM) | N/A                                              | ≤500ms                                                                                       | Runtime metric: end-to-end latency minus provider latency reported by Vercel AI SDK                 |

---

## 15. Open Questions

1. **Priority driver** — is this customer-driven, internal prompt-engineering pain relief, or competitive parity? Affects v1 scope prioritization (e.g., should "extract to library" be P0 or P1?). _[Oracle flagged AMBIGUOUS; assumed internal pain + parity for this spec.]_
2. **Reverse-reference indexing** — start with query-time scan of `agent_versions.irContent`, or build a denormalized `prompt_library_references` index from day one? Decision can defer until projects exceed ~1000 agents.
3. **DSL surface** — should a future `SYSTEM_PROMPT_REF: <prompt-id>:<version-id>` directive be added to ABL DSL for consistency with how other resources are referenced, or is the IdentityEditor-only surface sufficient long-term?
4. **Streaming responses in compare mode** — bulk responses are acceptable for v1; should streaming be added in v2 for perceived-latency improvement?
5. **Variable value templating from session** — v1 takes literal variable values at the test endpoint. Should we support binding test-mode variables to session/agent context (e.g., `{{contact.firstName}}`)? Likely v2.
6. **Cost estimation in compare mode** — should each pane display estimated cost (computed from model pricing × tokens)? Requires pricing reference data in `Model Hub`. Likely v1.5.

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                            | Severity | Status |
| ------- | ---------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | No multi-turn testing — users who need conversation-flow regression must use `agent-testing-evals`                     | Medium   | Open   |
| GAP-002 | No automated scoring/grading — comparison is human-visual-only in v1                                                   | Medium   | Open   |
| GAP-003 | Reverse-reference query scans `agent_versions.irContent`; may need denormalized index for projects with >1000 agents   | Medium   | Open   |
| GAP-004 | No DSL surface for prompt references; library references are IdentityEditor-only                                       | Low      | Open   |
| GAP-005 | Variable value injection mitigation strips `{{`/`}}`; does not protect against general LLM prompt injection in content | Low      | Open   |
| GAP-006 | Archived versions are read-only and unreferencable; no "restore to draft" action in v1                                 | Low      | Open   |
| GAP-007 | No A/B traffic-split between prompt versions in production — owned by `experiments` (PLANNED)                          | Low      | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                                                                | Coverage Type | Status  | Test File / Note                                                                                                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Create prompt with template + variables; SHA-256 sourceHash deterministic across reorderings                            | unit          | COVERED | `packages/database/src/__tests__/model-prompt-library-version.test.ts`                                                                                                       |
| 2   | Tenant + project isolation — cross-tenant and cross-project access return 404                                           | e2e           | COVERED | `apps/runtime/src/__tests__/prompt-library-isolation.e2e.test.ts`                                                                                                            |
| 3   | Atomic promote — concurrent promote of two draft versions, exactly one wins, other receives 409                         | integration   | COVERED | `apps/runtime/src/services/prompt-library/__tests__/prompt-library-service.test.ts`                                                                                          |
| 4   | RBAC — tester role can `read` + `test` but not `promote`; viewer can only `read`                                        | e2e           | PARTIAL | `apps/runtime/src/__tests__/prompt-library-rbac.e2e.test.ts` — role enforcement uses dev-login super-admins; per-role provisioning deferred to post-ALPHA                    |
| 5   | Compare Mode A — same prompt × 3 models executes in parallel and returns 3 panes with usage + latency                   | e2e           | COVERED | `apps/runtime/src/__tests__/prompt-library-compare.e2e.test.ts`                                                                                                              |
| 6   | Compare Mode B — 3 versions × 1 model executes in parallel and returns 3 panes                                          | e2e           | COVERED | `apps/runtime/src/__tests__/prompt-library-compare.e2e.test.ts`                                                                                                              |
| 7   | Cross-product compare (N prompts × M models) is rejected with HTTP 400                                                  | e2e           | COVERED | `apps/runtime/src/__tests__/prompt-library-compare.e2e.test.ts`                                                                                                              |
| 8   | Compile-orchestration resolves `libraryRef` → `template` and sets `custom: true`; agent IR is self-contained at runtime | integration   | COVERED | `apps/runtime/src/services/agent-compile/__tests__/library-ref-resolution.test.ts`                                                                                           |
| 9   | Runtime executes a session whose agent references a library prompt; output matches expected resolved prompt             | e2e           | PARTIAL | `apps/runtime/src/__tests__/prompt-library-flow.e2e.test.ts` — E2E-1 steps 1-2 (create/promote) covered; steps 3-7 (agent deploy + session execution) deferred to post-ALPHA |
| 10  | Variable injection mitigation — `{{` and `}}` stripped from user-supplied variable values                               | unit          | COVERED | `apps/runtime/src/services/prompt-library/__tests__/prompt-library-test-service.test.ts`                                                                                     |
| 11  | Archived version cannot be referenced by new agents; existing pins continue to work via resolved template               | integration   | COVERED | `apps/runtime/src/services/prompt-library/__tests__/prompt-library-service.test.ts`                                                                                          |
| 12  | Studio UI — create prompt, save draft, promote, verify in agent IdentityEditor picker                                   | e2e           | COVERED | `apps/studio/e2e/prompt-library/full-flow.spec.ts`                                                                                                                           |

### Testing Notes

This is a new feature with no existing tests. The test plan must include:

- **Unit**: schema validation, sourceHash determinism, plugin behaviour, sanitizer helpers
- **Integration**: real Express routes with full middleware chain (auth, RBAC, tenant isolation, validation), real MongoDB, no mocked codebase components
- **E2E**: HTTP-only interaction (no direct DB), real runtime, real `ModelResolutionService` with stubbed external LLM provider via DI (Vercel AI SDK supports `transport` injection for tests)

Per CLAUDE.md "Test Architecture": tests must NEVER mock platform components (`@agent-platform/*`, `@abl/*`, relative imports). LLM provider mocking must use dependency injection at the Vercel AI SDK boundary, not `vi.mock()`. E2E tests must hit real Express on random ports with the full middleware chain.

> Full testing details: `../testing/prompt-library.md`

---

## 18. References

- HLD: `docs/specs/prompt-library.hld.md`
- Test spec: `docs/testing/prompt-library.md`
- SDLC log: `docs/sdlc-logs/prompt-library/`
- Related feature docs:
  - [Agent Anatomy](agent-anatomy.md)
  - [Agent Development (Studio)](agent-development-studio.md)
  - [Agent Testing & Evals](agent-testing-evals.md)
  - [Tool Lifecycle](arch-tool-lifecycle.md)
  - [Model Hub](model-hub.md)
  - [Deployments & Versioning](deployments-versioning.md)
  - [Audit Logs](arch-audit-logs.md)
- Reference docs: `docs/feature-matrix.md`, `docs/enterprise-readiness.md`

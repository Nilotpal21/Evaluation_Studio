# Arch AI Project Capabilities Audit

Date: 2026-04-27

## Scope

This audit verifies the current Arch AI project-capability surface by tracing each capability from declaration to execution and user-facing update behavior.

Primary source of truth:

- Declared tool contract and specialist ownership:
  - `packages/arch-ai/src/types/tools.ts`
- Live turn planning and registry filtering:
  - `packages/arch-ai/src/engine/coordinator-bridge.ts`
  - `apps/studio/src/lib/arch-ai/engine-factory.ts`
- Direct in-project tool implementations:
  - `apps/studio/src/lib/arch-ai/tools/in-project-tools.ts`
- Main Arch message routing:
  - `apps/studio/src/app/api/arch-ai/message/route.ts`
  - `apps/studio/src/lib/arch-ai/processors/process-message.ts`
  - `apps/studio/src/lib/arch-ai/processors/process-in-project.ts`
- User-facing handoff and update surfaces:
  - `apps/studio/src/lib/arch-ai/components/arch/widgets/SecretInput.tsx`
  - `apps/studio/src/lib/arch-ai/components/arch/widgets/WidgetRenderer.tsx`
  - `apps/studio/src/lib/arch-ai/ui/proposal-artifacts.ts`
  - `apps/studio/src/store/arch-ai-store.ts`
- Project and memory API surfaces:
  - `apps/studio/src/app/api/arch-ai/projects/[projectId]/spec-document/route.ts`
  - `apps/studio/src/app/api/arch-ai/memories/learnings/route.ts`

Explicitly excluded:

- Runtime agent execution outside Arch AI.
- Product status claims not reachable from the Arch AI capability path.
- Features described only in docs without source-code wiring.

## Executive Summary

Arch AI has a rich declared in-project capability model and many direct in-project executors are implemented. The main risk is not absence of code; it is inconsistent wiring between the declared specialist maps, the live v4 ToolRegistry, compatibility refs, and Studio UI handoff.

The most important gap: `createProductionTurnEngine()` builds `buildOnboardingToolRegistry()` for the live engine. `resolveTurnPlan()` then filters by the declared in-project specialist maps, but only tools registered in that live registry can actually be surfaced. Several important project capabilities therefore exist in type maps and direct executors but are not live to the model.

## Verdict

Overall status: **PARTIAL / NEEDS WIRING FIXES**

| Area                          | Status                     | Notes                                                                                       |
| ----------------------------- | -------------------------- | ------------------------------------------------------------------------------------------- |
| Agent read/diagnosis/update   | Partial                    | Core tools are registered, but update UI reload signaling is missing.                       |
| Project configuration         | Not live                   | Declared and implemented, but not registered in the live ToolRegistry.                      |
| Knowledge base capabilities   | Not live                   | `kb_*` tools are declared and implemented, but not registered in the live ToolRegistry.     |
| Platform context in project   | Broken contract            | Registered implementation rejects project-scoped actions.                                   |
| Auth profile setup            | Broken interactive handoff | `collect_secret` schema differs between registry, `auth_ops`, and UI widget.                |
| Model configuration           | Partial / blocked apply    | Live schema is narrower than real executor and strips confirmation/config fields.           |
| Project memories              | Live with governance risk  | Project memory tool is live; learning-memory admin route can mutate global Arch memory.     |
| Spec/project metadata editing | Partial                    | Spec metadata route can false-conflict on current project name and does not rename Project. |

## Capability Chain

Arch in-project capability requires all of these layers to agree:

1. **Declaration**: tool name exists in `ToolName` and the specialist ownership map.
2. **Live registry**: tool is registered in the ToolRegistry used by `TurnEngine`.
3. **Planning**: `resolveTurnPlan()` includes it for the active mode/specialist.
4. **Execution**: the registered tool calls a real executor with project, tenant, user, permissions, and auth token context.
5. **UI handoff**: interactive tools and artifact updates match the schemas expected by Studio components.
6. **State refresh**: successful mutations notify the relevant Studio stores and views.

The audit findings are mostly layer mismatches.

## Findings

### F1 — Project and KB Tools Are Declared but Not Live

Severity: **P1**

`packages/arch-ai/src/types/tools.ts` declares `project_config`, `kb_manage`, `kb_ingest`, `kb_search`, `kb_health`, `kb_connector`, and `kb_documents`. The in-project specialist maps expose those tools to relevant specialists.

Direct implementations exist in `apps/studio/src/lib/arch-ai/tools/in-project-tools.ts`:

| Tool             | Direct implementation line |
| ---------------- | -------------------------- |
| `project_config` | `in-project-tools.ts:1593` |
| `kb_manage`      | `in-project-tools.ts:1808` |
| `kb_search`      | `in-project-tools.ts:1853` |
| `kb_health`      | `in-project-tools.ts:1924` |
| `kb_ingest`      | `in-project-tools.ts:1976` |
| `kb_connector`   | `in-project-tools.ts:2037` |
| `kb_documents`   | `in-project-tools.ts:2088` |

However, `createProductionTurnEngine()` builds only `buildOnboardingToolRegistry()` at `apps/studio/src/lib/arch-ai/engine-factory.ts:2021`. The live registry has no registrations for `project_config` or the `kb_*` tools. `resolveTurnPlan()` then runs `registry.listByNames(allowedNames)` at `packages/arch-ai/src/engine/coordinator-bridge.ts:342`, so missing tools silently drop from the model-visible surface.

Impact:

- Arch can route to specialists that believe they own project and KB capabilities, but the model cannot call those tools.
- User requests such as "create a knowledge base", "search this KB", or "update project settings" cannot be satisfied through the live v4 in-project path.
- The implementation creates false confidence because direct executors and compat refs exist.

Recommended fix:

- Build a mode-aware production registry, or register project tools into the existing registry with correct project-aware executors.
- Add a startup or unit invariant: every tool in `IN_PROJECT_TOOLS` must exist in the production ToolRegistry unless explicitly marked client-only or disabled.
- Add one in-project integration test that asserts `project_config` and each `kb_*` tool appears in `plan.allowedTools` for the intended specialist.

### F2 — `platform_context` Is Registered as Onboarding-Only

Severity: **P1**

The live registry registers `platform_context`, but the implementation is explicitly onboarding-only:

- `apps/studio/src/lib/arch-ai/engine-factory.ts:706-760`

It rejects these actions as `PROJECT_REQUIRED`:

- `get_summary`
- `list_agents`
- `list_tools`
- `list_channels`
- `list_auth_profiles`

The same tool is included in many in-project specialist maps, and a project-aware implementation exists at `apps/studio/src/lib/arch-ai/tools/in-project-tools.ts:1770-1802`.

Impact:

- In-project specialists are told they can query project context, but live calls fail for project-scoped actions.
- Integration setup cannot reliably populate real agents, tools, channels, and auth profiles.
- The model is more likely to ask the user for values it should have fetched.

Recommended fix:

- Register a single `platform_context` executor that branches by `ctx.projectId`, or register a project-aware implementation whenever the engine runs in `in-project` mode.
- Pass `projectId`, `sessionId`, `permissions`, `tenantId`, `userId`, `pageContext`, and `authToken` consistently.

### F3 — `collect_secret` Schema Does Not Match `auth_ops` or the UI

Severity: **P1**

The live registry schema is:

- `message`
- `secretType`

Source: `apps/studio/src/lib/arch-ai/engine-factory.ts:1450-1459`

The direct in-project tool schema is:

- `flowId`
- `field`
- `label`

Source: `apps/studio/src/lib/arch-ai/tools/in-project-tools.ts:1755-1768`

`auth_ops` tells the model to use the `flowId` returned from the `needsSecrets` response:

- `apps/studio/src/lib/arch-ai/tools/auth-ops.ts:226-234`

The UI also expects `{ flowId, field, label }`:

- `apps/studio/src/lib/arch-ai/components/arch/widgets/SecretInput.tsx:7-13`
- `apps/studio/src/lib/arch-ai/components/arch/widgets/WidgetRenderer.tsx:253-260`
- `packages/arch-ai/src/types/message-request.ts:43-48`

Impact:

- Credential setup can render a secret input without the flow and field data needed to store the submitted secret.
- Follow-up `auth_ops create/update` calls may fail because `flowId` is missing or invalid.
- The model receives a schema that contradicts the tool instructions.

Recommended fix:

- Make the live `collect_secret` registry schema match the direct in-project schema.
- Add a regression test for the full `auth_ops needsSecrets -> collect_secret -> tool_answer secrets -> auth_ops with flowId` path.

### F4 — `configure_model` Live Schema Strips Real Configuration Fields

Severity: **P2**

The direct in-project model configuration tool supports:

- `action`
- `agentName`
- `source`
- `modelId`
- `provider`
- `temperature`
- `maxTokens`
- `operationModels`
- `confirmed`

Source: `apps/studio/src/lib/arch-ai/tools/in-project-tools.ts:977-993`

The live registry accepts only:

- `agentName`
- `modelId`

Source: `apps/studio/src/lib/arch-ai/engine-factory.ts:1638-1655`

`ToolInvoker` validates and parses through the registered schema before execution:

- `packages/arch-ai/src/engine/tool-invoker.ts:129-145`

Impact:

- The model cannot express inspect/diff/apply variants through the live schema.
- Confirmation fields can be stripped before reaching `executeConfigureModel()`.
- Manual provider, temperature, max-token, and operation-level settings are not reliably configurable.

Recommended fix:

- Replace the live schema with the same schema used by the direct in-project executor.
- Add tests for `inspect`, `diff`, `apply` with confirmation, and manual model settings.

### F5 — Agent Edits Do Not Trigger Studio Reload or Eval Prompt

Severity: **P2**

The store includes an explicit reload signal:

- `apps/studio/src/store/arch-ai-store.ts:134-135`
- `apps/studio/src/store/arch-ai-store.ts:379`

Consumers use it to reload or suggest evals:

- `apps/studio/src/App.tsx:69-80`
- `apps/studio/src/components/agent-editor/AgentEditor.tsx:367-371`
- `apps/studio/src/components/agents/AgentDetailPage.tsx:258-262`

But no caller invokes `setLastAgentEdit()`. Accepted in-project mutations emit only artifact updates:

- `apps/studio/src/lib/arch-ai/processors/process-in-project.ts:305-314`
- `apps/studio/src/lib/arch-ai/ui/proposal-artifacts.ts:190-204`

Impact:

- Agent DSL updates may be applied in the database while open Studio views show stale data.
- Eval suggestions after Arch modifications may never appear.

Recommended fix:

- Call `setLastAgentEdit()` when a diff artifact transitions to `applied`.
- If new-agent creation changes project topology/list state, also invalidate the relevant project-agent list store.

### F6 — Any Tenant User Can Mutate Global Arch Learning Memory

Severity: **P1**

`ArchLearningMemory` is documented as Arch AI cross-project learning memory:

- `packages/arch-ai/src/models/arch-learning-memory.model.ts:4-17`
- `packages/arch-ai/src/models/arch-learning-memory.model.ts:57-58`

The learnings API returns tenant-scoped and global memories, which is reasonable for read:

- `apps/studio/src/app/api/arch-ai/memories/learnings/route.ts:23-28`

But `PATCH` and `DELETE` also match tenant-scoped or global memories with only tenant auth:

- `apps/studio/src/app/api/arch-ai/memories/learnings/route.ts:50-69`
- `apps/studio/src/app/api/arch-ai/memories/learnings/route.ts:93-110`

Impact:

- A low-privilege authenticated tenant user can modify or delete global Arch knowledge.
- This enables cross-tenant learning-memory poisoning or loss.

Recommended fix:

- Do not allow global writes through the tenant route.
- Require an admin/platform permission for global memory mutation.
- Preserve non-leaky `404` behavior when the user does not have permission to mutate a global record.

### F7 — Spec `projectName` Update Can False-Conflict the Current Project

Severity: **P2**

The spec-document route checks `projectExistsByName(name, auth.tenantId)` when updating `business.projectName`:

- `apps/studio/src/app/api/arch-ai/projects/[projectId]/spec-document/route.ts:80-97`

`projectExistsByName()` does not exclude the current project:

- `apps/studio/src/services/project-service.ts:220-222`

The route then updates only `ArchSpecDocument`, not the `Project`:

- `apps/studio/src/app/api/arch-ai/projects/[projectId]/spec-document/route.ts:117-120`

Impact:

- Saving the current project name can return `409 NAME_CONFLICT`.
- Successful edits update spec metadata, not the real project name, which may surprise users and Arch.

Recommended fix:

- If this field is only spec metadata, remove or soften the global project-name uniqueness check.
- If this is intended to rename the project, update the `Project` record transactionally and exclude the current project ID from uniqueness checks.

### F8 — Onboarding `platform_context list_models` Drops Auth Token

Severity: **P2**

The onboarding message route passes an auth token into `processMessage()`, but the processor only adds `pageContext` to the service bag:

- `apps/studio/src/lib/arch-ai/processors/process-message.ts:623-625`

The live `platform_context` executor passes `authToken: undefined`:

- `apps/studio/src/lib/arch-ai/engine-factory.ts:751-760`

`listModels()` requires an auth token:

- `apps/studio/src/lib/arch-ai/tools/platform-context.ts:639-650`

Impact:

- Onboarding `platform_context list_models` is declared in `PHASE_TOOL_MAP` but likely returns `AUTH_REQUIRED`.
- The model cannot reliably list tenant model options during onboarding.

Recommended fix:

- Put `authToken` into the onboarding service bag, matching the in-project processor.
- Pass `ctx.services?.authToken` into `executePlatformContext()`.

## Capability vs Feature Matrix

| Feature area                   | Declared to Arch | Direct executor exists | Live model-visible | UI/state complete | Status         |
| ------------------------------ | ---------------- | ---------------------- | ------------------ | ----------------- | -------------- |
| Agent read                     | Yes              | Yes                    | Yes                | Mostly            | Partial        |
| Agent validate/diagnose        | Yes              | Yes                    | Yes                | Mostly            | Partial        |
| Agent propose/apply update     | Yes              | Yes                    | Yes                | No reload signal  | Partial        |
| Topology read                  | Yes              | Yes                    | Yes                | Mostly            | Partial        |
| Project config/settings        | Yes              | Yes                    | No                 | Unknown           | Not live       |
| Platform project context       | Yes              | Yes                    | Wrong executor     | N/A               | Broken         |
| Auth profile operations        | Yes              | Yes                    | Yes                | Secret mismatch   | Broken         |
| Variable operations            | Yes              | Yes                    | Yes                | Unknown           | Needs tests    |
| Tool/integration operations    | Yes              | Yes                    | Yes                | Unknown           | Needs tests    |
| Model recommendations          | Yes              | Yes                    | Yes                | Unknown           | Partial        |
| Model configuration            | Yes              | Yes                    | Narrow schema      | Unknown           | Partial/broken |
| Knowledge base lifecycle       | Yes              | Yes                    | No                 | Cards implemented | Not live       |
| Knowledge base ingestion       | Yes              | Yes                    | No                 | Cards implemented | Not live       |
| Knowledge base search          | Yes              | Yes                    | No                 | Cards implemented | Not live       |
| Knowledge base health          | Yes              | Yes                    | No                 | Cards implemented | Not live       |
| Knowledge base connectors      | Yes              | Yes                    | No                 | Cards implemented | Not live       |
| Knowledge base documents       | Yes              | Yes                    | No                 | Unknown           | Not live       |
| Project memory                 | Yes              | Yes                    | Yes                | Unknown           | Partial        |
| Global learning memory editing | API-only         | Yes                    | N/A                | Unknown           | Governance gap |
| Spec project metadata          | API route        | Yes                    | N/A                | Unknown           | Partial        |

## Remediation Plan

### Phase 1 — Registry Contract Alignment

Goal: ensure declared in-project capabilities are visible to the model only when truly executable.

Tasks:

1. Build a production registry that includes all executable in-project tools.
2. Replace onboarding-only `platform_context` with a mode-aware executor.
3. Register `project_config` and all `kb_*` tools.
4. Add invariant coverage comparing `IN_PROJECT_TOOLS` to the production registry.

Exit criteria:

- Every tool in `IN_PROJECT_TOOLS` is either registered, explicitly client-side, or explicitly disabled with a documented reason.
- In-project `resolveTurnPlan()` for relevant specialists includes `project_config` and `kb_*` tools.

### Phase 2 — Schema and Interactive Handoff Repair

Goal: make model-visible schemas match the real executors and UI widgets.

Tasks:

1. Align `collect_secret` schema with `{ flowId, field, label }`.
2. Align `configure_model` schema with the direct in-project executor.
3. Pass onboarding `authToken` into `platform_context`.

Exit criteria:

- Secret collection round-trip works without the model seeing secret values.
- `configure_model apply` can complete with `confirmed: true`.
- Onboarding model listing works with an authenticated request.

### Phase 3 — User-Facing Refresh and Governance

Goal: close stale UI and security gaps after successful project mutations.

Tasks:

1. Trigger `setLastAgentEdit()` after applied agent diffs.
2. Invalidate project-agent list state for new-agent creation.
3. Restrict global Arch learning memory writes to platform/admin permissions.
4. Clarify whether `business.projectName` is spec-only metadata or project rename behavior.

Exit criteria:

- Agent Editor and Agent Detail reload automatically after Arch edits.
- Eval suggestion prompt fires after Arch agent mutation.
- Tenant users cannot update/delete global learning memory.
- Spec projectName behavior is documented and tested.

## Recommended Regression Tests

| Test area            | Type        | Scenario                                                                                                |
| -------------------- | ----------- | ------------------------------------------------------------------------------------------------------- |
| Registry contract    | Unit        | Every declared `IN_PROJECT_TOOLS` entry is registered or intentionally excluded.                        |
| Specialist planning  | Unit        | `abl-construct-expert` sees `project_config`; diagnostician sees KB tools; integration sees auth tools. |
| Platform context     | Integration | In-project `list_agents`, `list_tools`, and `get_summary` return project data.                          |
| Secret collection    | Integration | `auth_ops` returns `flowId`, `collect_secret` renders with field/label, tool answer stores secrets.     |
| Configure model      | Integration | `inspect`, `diff`, and confirmed `apply` preserve all input fields.                                     |
| Agent update refresh | UI/E2E      | Accepting an Arch proposal reloads Agent Editor/Detail and shows eval suggestion.                       |
| Learning memory auth | API         | Tenant user can read global learnings but cannot patch/delete them without admin permission.            |
| Project name update  | API         | Saving unchanged current project name does not false-conflict.                                          |

## Open Questions

1. Should `project_config` rename the actual Project, or only edit spec metadata?
2. Should global Arch learning memory be editable from Studio at all, or only from offline/admin tooling?
3. Should KB tools be visible to all in-project specialists or only a dedicated KB/integration specialist?
4. Should the production registry be split by mode or unified with explicit executor branching?

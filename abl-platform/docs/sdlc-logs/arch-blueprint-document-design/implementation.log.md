# Arch Blueprint Document Design — Autonomous Implementation Log

Source spec: `docs/superpowers/specs/2026-05-11-arch-blueprint-document-design.md`

Started: 2026-05-12

## Operating Notes

- No dedicated LLD exists under `docs/plans/` for this exact feature.
- The reviewed design spec is the source plan for this autonomous pass.
- Existing uncommitted/untracked arch-eval artifacts predate this pass and are treated as user/workspace artifacts unless directly needed.
- The full spec estimates 60-95 commits over 10-14 weeks; this pass implements a production-safe vertical slice instead of pretending the entire replacement can land in one uncontrolled patch.

## Audit Round 1 — Static Spec-to-Code Alignment

Findings:

- `packages/arch-ai/src/types/blueprint.ts` still exposes the old thin schema: topology, old `AgentSpec`, governance, integrations, buildOrder, specReference, approvedAt.
- `apps/studio/src/lib/arch-ai/blueprint-flow.ts` still works around the bare topology flow rather than a load-bearing blueprint document.
- `packages/arch-ai/src/prompts/specialists/in-project-architect.ts` aliases `IN_PROJECT_GENERALIST_PROMPT`, so canonical blueprint behavior is not taught to the in-project architect.
- `packages/arch-ai/src/types/tools.ts` does not include `read_blueprint`, `propose_blueprint_edit`, `lock_blueprint_version`, `fork_blueprint`, or `rebuild_agents_from_blueprint`.
- `apps/studio/src/lib/arch-ai/tools/in-project-tools.ts` does not register those blueprint tools.
- `apps/studio/src/lib/arch-ai/tools/agent-ops.ts` allows direct `create` / `modify` raw DSL writes after only the generic mutation guard.
- `createNewProjectAgent` and `applyProjectAgentModification` update `ProjectAgent.dslContent` but do not create `AgentVersion` rows.

## Audit Round 2 — Runtime Contract / IR Drift

Findings:

- Directly replacing the existing exported `BlueprintOutputSchema` would risk breaking current onboarding and tests because callers still expect the old shape.
- Safer path: add a v2 authoring schema/export alongside the current schema first, then migrate callers progressively.
- A deterministic renderer can be tested in isolation without touching the live LLM build loop yet.
- The renderer must output parser-valid conservative ABL before using richer constructs; invalid DSL would make the battle tests noisy and less useful.

## Audit Round 3 — Mutation / Interaction Risk

Findings:

- Users can mutate agents through reviewed proposals, direct `agent_ops`, tool-driven context changes, and project create flows.
- The highest-risk silent-drift path is direct raw DSL writes in canonical mode.
- Until `arch_blueprints` persistence is fully wired, the practical guard must be able to distinguish projects with no blueprint config from legacy projects.
- AgentVersion snapshots are required for every DSL write regardless of whether the source is legacy or blueprint-rendered.

## First Executable Vertical Slice

Implement:

- Add v2 blueprint schema, validation helpers, markdown renderer, deterministic ABL renderer, and 10 scenario fixtures in `@agent-platform/arch-ai`.
- Export v2 helpers without breaking the old `BlueprintOutputSchema`.
- Add blueprint tool names to type maps and in-project tool registration with read/propose/lock/fork/rebuild skeletons backed by session/project metadata where possible.
- Replace the in-project architect alias with a blueprint-aware prompt.
- Add AgentVersion snapshot creation to project agent create/apply paths and direct agent ops paths.
- Add canonical-mode checks to raw `agent_ops` create/modify writes.
- Add CLI battle-test command/script that renders and validates 10 successful blueprint projects.

## Audit Round 4 — Post-Implementation Drift Tests

Findings and fixes:

- Studio's copy of `IN_PROJECT_SPECIALIST_TOOL_MAP` had drifted from the package source for `diagnostician`, `abl-construct-expert`, `analyst`, and `testing-eval`; aligned missing `run_simulation` grants and kept the existing drift test as the guard.
- Unit tests that exercise project-agent mutations needed an explicit `AgentVersion` collaborator because DSL writes now create version snapshots. Added mocks and assertions so offline tests do not accidentally write to Mongo.
- `in-project-tools` had no dependency seam for `AgentVersion`, which made snapshot tests hit the real model. Added `agentVersionModel` to `__setInProjectToolTestDeps`.
- The new `arch_blueprints` unique indexes initially allowed `null` project/session collisions. Changed both unique indexes to partial indexes scoped only to string `projectId` / `sessionId`.
- Markdown rendering originally stopped at seven sections. Expanded it to the 17-section artifact shape expected by the design and added test coverage for the section count.

## Audit Round 5 — UI Flow Drift After Screenshot Review

Findings and fixes:

- Studio still treated the generated graph as the primary BLUEPRINT artifact, so live `artifact_updated: topology` events could reopen the old Topology tab and make the UI look unchanged.
- Added a client-side Blueprint document artifact generated from current session metadata plus the topology payload.
- During BLUEPRINT, page resume, preload, and durable topology event paths now create/update the Blueprint tab and keep it active by default while preserving Topology as a secondary graph view.
- Normalized legacy persisted widget payloads so old sessions render "draft blueprint" / "Accept blueprint" even when their stored payload still says "draft topology" / "Accept topology".
- Added focused regression coverage for the document artifact, widget copy compatibility, and the durable topology event path that previously stole focus.

## Implemented Surface

- `@agent-platform/arch-ai/blueprint`
  - v2 schema and validation helpers.
  - Deterministic DSL renderer.
  - 17-section markdown renderer.
  - 10 battle-test fixtures.
  - `BlueprintService` for latest/create/fork/lock/edit metadata operations.
- Studio in-project tools
  - `read_blueprint`
  - `propose_blueprint_edit`
  - `lock_blueprint_version`
  - `fork_blueprint`
  - `rebuild_agents_from_blueprint`
- Studio onboarding UI
  - Blueprint document tab with 17 rendered sections.
  - Blueprint-first default tab during BLUEPRINT.
  - Topology graph retained as a secondary diagnostic view.
  - Legacy widget copy compatibility for existing sessions.
- Mutation safety
  - Canonical blueprint mode blocks raw `agent_ops` create/modify/delete/propose paths.
  - `ProjectAgent` create/update and Arch AI apply paths create `AgentVersion` snapshots.
  - Blueprint rebuild detects local DSL conflicts and requires explicit overwrite confirmation.
- Data model
  - `ArchBlueprint` Mongo model with tenant-first indexes.
  - `Project.archConfig` for canonical mode, linked version, and manual-drift escape metadata.
- CLI battle test
  - `pnpm arch:blueprint:battle -- --run-id blueprint-battle-autonomous`
  - Writes rendered projects and summary under `docs/testing/arch-eval/blueprint-battle-autonomous/`.

## Verification Evidence

- `pnpm --filter @agent-platform/database build` — pass.
- `pnpm --filter @agent-platform/arch-ai build` — pass.
- `pnpm --filter @agent-platform/studio build` — pass, with pre-existing webpack dynamic-require warnings.
- `pnpm --filter @agent-platform/arch-ai test -- src/__tests__/blueprint/v2-renderer.test.ts src/__tests__/tools/in-project-schemas.test.ts` — pass, 4 tests.
- `pnpm --filter @agent-platform/studio test:fast -- src/__tests__/arch-ai/specialist-tool-map-drift.test.ts src/__tests__/arch-ai/agent-ops.test.ts src/__tests__/project-repo-draft-metadata.test.ts src/__tests__/arch-ai/apply-project-agent-modification.test.ts src/__tests__/arch-ai/propose-apply-modification-fixups.test.ts` — pass, 49 tests.
- `pnpm --filter @agent-platform/studio test:fast -- src/__tests__/arch-ai/blueprint-document.test.ts src/__tests__/arch-ai/blueprint-flow.test.ts src/__tests__/arch-ai/blueprint-topology-fallback.test.ts src/__tests__/arch-ai/widget-renderer.test.tsx src/__tests__/arch-ai/event-dispatcher.test.ts src/__tests__/artifact-panel-tabs.test.ts` — pass, 30 tests.
- `pnpm exec tsx tools/arch-eval/index.ts --studio http://localhost:5173 --email arch-cli-full-create-20260512@example.com --only s29-recipe-meal-plan --run-id cli-full-create-20260512-0805 --output-root docs/testing/arch-eval/cli-full-create-20260512-0805` — pass, project created, 7 agents, 0 harness errors.
- `pnpm exec tsx tools/arch-eval/score-projects.ts docs/testing/arch-eval/cli-full-create-20260512-0805` — pass, overall score 3.7/5; generated project health remains Critical / not deploy-ready.
- `pnpm arch:blueprint:battle -- --run-id blueprint-battle-autonomous` — pass, 10/10 projects successful.
- `git diff --check` — pass.

## Deferred From Full Target State

- The Blueprint document is now rendered in the v4 onboarding panel, but full section-level editing still needs the structured patch/merge engine.
- `propose_blueprint_edit` currently records section edit metadata; a full structured patch/merge engine is still needed before arbitrary user blueprint edits can mutate `output` safely.
- `rebuild_agents_from_blueprint` is implemented as an explicit in-project tool, not yet as the full BUILD phase replacement.
- Bulk/import raw DSL mutation paths need a follow-up pass to enforce canonical mode outside `agent_ops` and Arch AI apply paths.

# SDLC Log: Conversation Behavior — Implementation Phase

**Feature**: conversation-behavior
**Phase**: IMPLEMENTATION
**LLD**: `docs/plans/2026-04-21-conversation-behavior-impl-plan.md`
**Date Started**: 2026-04-22
**Date Completed**: IN PROGRESS
**Story Scope**:

- `ABLP-498` — schema, parser, compiler lowering, and IR wiring
- `ABLP-499` — runtime precedence resolution, effective config wiring, and prompt consumption
- `ABLP-500` — Studio authoring and project-io integration
- `ABLP-501` — diagnostics hardening and behavior-quality / integration coverage

---

## Preflight

- [x] LLD file paths verified for the `ABLP-498` slice
- [x] Current parser/compiler/type signatures inspected before modification
- [x] Recent git history checked for target files
- [x] Working tree confirmed clean before implementation
- Discrepancies:
  - The LLD file map for phases 1-2 does not currently list `packages/core/src/parser/yaml-parser.ts`, but the repo has an active YAML ABL parser that should stay in parity with the legacy parser for agent-scoped Conversation Behavior authoring. Proceeding with this scoped adjustment.
  - The feature-wide implementation plan covers phases 1-5; this story is intentionally scoped to the contract + parser/compiler portion of that plan (LLD phases 1-2 plus any minimal supporting parity changes required to ship them cleanly).

## Phase Execution

### LLD Phase 1: Contract, Ownership, and Validation Foundation

- **Status**: COMPLETED
- **Commit**: pending
- **Exit Criteria**:
  - `ConversationBehaviorAST` added at agent and behavior-profile scope
  - `ConversationBehaviorIR` and validator/lowering helpers added to compiler
  - Deferred fields and invalid combinations now fail closed in compiler validation
- **Deviations**: none yet
- **Files Changed**:
  - `packages/core/src/types/agent-based.ts`
  - `packages/core/src/types/index.ts`
  - `packages/compiler/src/platform/ir/schema.ts`
  - `packages/compiler/src/platform/ir/compile-conversation-behavior.ts`
  - `packages/compiler/src/platform/ir/validate-conversation-behavior.ts`
  - `packages/compiler/src/platform/ir/index.ts`

### LLD Phase 2: Parser and Compiler Lowering

- **Status**: IN PROGRESS
- **Commit**: pending
- **Exit Criteria**:
  - Legacy and YAML parsers accept agent-scoped `CONVERSATION`
  - Standalone behavior profiles accept `CONVERSATION`
  - Agent and behavior-profile compilers attach `conversation_behavior` when validation passes
  - Focused parser tests pass
- **Deviations**:
  - Package-wide `@abl/compiler` build/test verification is currently blocked by existing workspace issues unrelated to this change set:
    - missing internal package resolution for `@agent-platform/shared*` / `@agent-platform/i18n`
    - pre-existing `trace-store.ts` type errors about `timestamp`
- **Files Changed**:
  - `packages/core/src/parser/yaml-parser.ts`
  - `packages/core/src/parser/agent-based-parser.ts`
  - `packages/compiler/src/platform/ir/compiler.ts`
  - `packages/compiler/src/platform/ir/compile-behavior-profile.ts`
  - `packages/core/src/__tests__/conversation-behavior-parser.test.ts`
  - `packages/compiler/src/__tests__/ir/conversation-behavior-ir.test.ts`

### LLD Phase 3: Runtime Resolution and Prompt Consumption

- **Status**: IN PROGRESS
- **Commit**: pending
- **Exit Criteria**:
  - Runtime resolves one deterministic `ResolvedConversationBehavior`
  - Voice-only listening policies are gated by channel capability
  - Prompt building consumes resolved Conversation Behavior
  - Focused runtime tests pass for merge/gating/prompt behavior
- **Deviations**:
  - Package-wide `@agent-platform/runtime` build remains blocked by pre-existing workspace output gaps outside this story:
    - missing built outputs for several workspace packages under `@agent-platform/*`
    - longstanding package-wide module-resolution failures unrelated to Conversation Behavior
  - To restore focused runtime verification, the worktree needed targeted dependency builds for:
    - `@agent-platform/shared-auth`
    - `@agent-platform/database`
    - `@agent-platform/shared-auth-profile`
- **Files Changed**:
  - `apps/runtime/src/services/execution/conversation-behavior-resolver.ts`
  - `apps/runtime/src/services/execution/profile-resolver.ts`
  - `apps/runtime/src/services/execution/prompt-builder.ts`
  - `apps/runtime/src/services/execution/reasoning-executor.ts`
  - `apps/runtime/src/services/runtime-executor.ts`
  - `apps/runtime/src/__tests__/profile-resolver.test.ts`
  - `apps/runtime/src/__tests__/routing/prompt-builder.test.ts`

### LLD Phase 4: Studio + Project IO Authoring Integration

- **Status**: COMPLETED
- **Commit**: `b2faa98c8`
- **Exit Criteria**:
  - Studio structured editing and raw ABL save/load preserve `CONVERSATION:`
  - behavior-profile API parsing accepts profile-scoped `CONVERSATION:`
  - project import/export preserves agent + profile Conversation Behavior authoring
  - scoped Studio / project-io tests pass
- **Deviations**:
  - Package-wide Studio/project-io builds were kept scoped to the affected packages because the feature is still being implemented in the same worktree across multiple Jira stories.
- **Files Changed**:
  - `apps/studio/src/components/agent-detail/BehaviorSection.tsx`
  - `apps/studio/src/store/agent-detail-store.ts`
  - `apps/studio/src/lib/abl-serializers.ts`
  - `apps/studio/src/app/api/projects/[id]/behavior-profiles/_helpers.ts`
  - `apps/studio/src/__tests__/behavior-section.test.ts`
  - `apps/studio/src/__tests__/abl-serializers.test.ts`
  - `apps/studio/src/__tests__/integration/serializer-roundtrip.test.ts`
  - `packages/project-io/src/export/folder-builder.ts`
  - `packages/project-io/src/import/folder-reader.ts`
  - `packages/project-io/src/import/project-importer.ts`
  - `packages/project-io/src/__tests__/profile-roundtrip.test.ts`

### LLD Phase 5: Hardening, Diagnostics, and Advanced-Field Gating

- **Status**: COMPLETED
- **Commit**: pending
- **Exit Criteria**:
  - Diagnostics explain why Conversation Behavior resolved or was dropped
  - final runtime / Studio / project-io / compiler tests cover launch-scope behavior and gating
  - explicitly deferred fields remain fenced behind diagnostics
  - scoped hardening verification passes
- **Deviations**:
  - `@agent-platform/runtime` package-wide build still fails on pre-existing unrelated workspace issues in `project-io` route adapter typing and missing workspace outputs; the Conversation Behavior changes themselves are type-clean inside the scoped slices.
  - Helix `Oracle Analysis` did not complete because the oracle subprocesses hit their turn limit, but the completed `Deep Scan` findings were triaged manually and the valid ones were fixed before final verification.
- **Files Changed**:
  - `apps/runtime/src/services/runtime-executor.ts`
  - `apps/runtime/src/services/execution/reasoning-executor.ts`
  - `apps/runtime/src/services/execution/conversation-behavior-resolver.ts`
  - `apps/runtime/src/__tests__/behavior-profiles.e2e.test.ts`
  - `apps/runtime/src/__tests__/conversation-behavior-resolver.test.ts`
  - `apps/runtime/src/__tests__/channels/conversation-behavior-capability.test.ts`
  - `apps/runtime/src/__tests__/observability/trace-profile-resolution.test.ts`
  - `apps/runtime/src/__tests__/e2e/conversation-behavior.e2e.test.ts`
  - `apps/studio/src/__tests__/conversation-behavior-editor.test.tsx`
  - `packages/project-io/src/__tests__/conversation-behavior-roundtrip.test.ts`
  - `packages/compiler/src/__tests__/ir/conversation-behavior-ir.test.ts`

## Wiring Verification

- [x] `ConversationBehaviorAST` exported from core types
- [x] Parser paths for agent and behavior-profile `CONVERSATION:` blocks registered
- [x] `ConversationBehaviorIR` exported from compiler schema index
- [x] Agent compiler attaches base `conversation_behavior`
- [x] Behavior-profile compiler attaches profile `conversation_behavior`
- [x] Runtime effective config now carries resolved `conversationBehavior`
- [x] Runtime session creation preserves agent-scoped Conversation Behavior even with zero active profiles
- [x] Prompt builder consumes resolved Conversation Behavior with `InteractionContext`-aware language instructions
- [x] Non-voice channels fail closed for `listening` behavior and preserve capability-drop diagnostics

## Review Rounds

| Round | Verdict   | Critical | High | Medium | Low |
| ----- | --------- | -------- | ---- | ------ | --- |
| 1     | addressed | 0        | 1    | 1      | 0   |
| 2     | addressed | 0        | 1    | 1      | 0   |
| 3     | pending   | 0        | 0    | 0      | 0   |
| 4     | pending   | 0        | 0    | 0      | 0   |
| 5     | pending   | 0        | 0    | 0      | 0   |

Additional scoped review for `ABLP-500` / `ABLP-501` used one manual self-review pass plus one Helix holistic audit, with valid findings fixed before final verification.

## Acceptance Criteria

- [x] Stable `ConversationBehaviorAST` and `ConversationBehaviorIR` types are defined
- [x] Ownership conflicts produce deterministic validator errors
- [x] Deferred fields are explicitly recognized and gated, not silently accepted
- [x] Parser accepts canonical `CONVERSATION:` syntax on agents and behavior profiles
- [x] Compiler emits `conversation_behavior` in IR when authored
- [x] Unknown fields and invalid combinations fail deterministically
- [ ] `pnpm build --filter=@abl/core --filter=@abl/compiler` succeeds

## Verification Notes

- `pnpm install --ignore-scripts --frozen-lockfile` completed successfully in the worktree to restore local tooling.
- `pnpm --filter @abl/core build` passed.
- `pnpm --filter @abl/core exec vitest run src/__tests__/conversation-behavior-parser.test.ts` passed (`4` tests).
- Review follow-up fixes completed:
  - inline `BEHAVIOR_PROFILE` parsing now stops at non-inline sections instead of accidentally absorbing later agent-owned sections
  - profile-scoped `conversation_behavior` now participates in config/env placeholder resolution
- `pnpm --filter @abl/core exec vitest run src/__tests__/conversation-behavior-parser.test.ts` now passes with `5` tests after the inline-profile regression was added.
- `pnpm --filter @agent-platform/shared-kernel --filter @agent-platform/shared-observability --filter @agent-platform/i18n build` succeeded for the packages needed to run the focused compiler test.
- `pnpm --filter @abl/compiler exec vitest run src/__tests__/ir/conversation-behavior-ir.test.ts` passed (`6` tests).
- `pnpm build --filter=@abl/core --filter=@abl/compiler` remains blocked by pre-existing workspace issues outside this change set:
  - `@agent-platform/shared` has unresolved internal workspace dependencies / existing TS errors
  - `@abl/compiler` still has pre-existing `trace-store.ts` type errors when attempting the package-wide build
- Runtime follow-on (`ABLP-499`) verification:
  - `pnpm --filter @agent-platform/shared-auth build` passed
  - `pnpm --filter @agent-platform/database build` passed
  - `pnpm --filter @agent-platform/shared-auth-profile build` passed
  - `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/profile-resolver.test.ts src/__tests__/routing/prompt-builder.test.ts` passed (`192` tests)
  - `pnpm --filter @agent-platform/runtime build` still fails on unrelated package-wide module resolution gaps across existing runtime/database/auth dependencies
- Runtime review follow-up fixes completed:
  - flow gather re-prompts now consume `conversationBehavior.interaction.clarification.max_questions` and `repair.max_attempts`, switching from normal clarification prompts to repair/waiting prompts once the configured budget is exhausted
  - session-creation `profile_resolution` tracing now handles agent-level `conversation_behavior` without behavior profiles and preserves `effectiveSummary.hasConversationBehavior`
  - additional workspace builds completed to unblock focused runtime verification:
    - `pnpm --filter @agent-platform/llm build`
    - `pnpm --filter @agent-platform/agent-transfer build`
    - `pnpm --filter @abl/language-service build`
    - `pnpm --filter @agent-platform/circuit-breaker build`
    - `pnpm --filter @agent-platform/project-io build`
    - `pnpm --filter @agent-platform/a2a build`
    - `pnpm --filter @agent-platform/execution build`
    - `pnpm --filter @agent-platform/search-ai-sdk build`
  - `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/clarification-count.test.ts src/__tests__/observability/trace-profile-resolution.test.ts src/__tests__/execution/runtime-executor.test.ts` passed (`53` tests)
- Studio / project-io integration follow-on (`ABLP-500`) verification:
  - `pnpm --filter @agent-platform/studio build` passed
  - `pnpm --filter @agent-platform/project-io build` passed
  - `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/behavior-section.test.ts src/__tests__/abl-serializers.test.ts src/__tests__/integration/serializer-roundtrip.test.ts src/__tests__/api-routes/api-behavior-profile-routes.test.ts` passed (`67` tests)
  - `pnpm --filter @agent-platform/project-io exec vitest run src/__tests__/profile-roundtrip.test.ts src/__tests__/project-exporter.test.ts src/__tests__/import-validator-v2.test.ts` passed (`89` tests before the later ABLP-501 additions)
- Hardening / coverage follow-on (`ABLP-501`) verification:
  - `pnpm --filter @abl/compiler build` passed
  - `pnpm --filter @agent-platform/project-io build` passed
  - `pnpm --filter @agent-platform/runtime build` still fails on unrelated pre-existing workspace issues:
    - `apps/runtime/src/routes/project-io.ts` adapter is missing `createProfiles`, `updateProfiles`, and `deleteProfiles`
    - missing workspace outputs for packages such as `@abl/crawler` and `@abl/eventstore`
  - `pnpm --filter @abl/compiler exec vitest run src/__tests__/ir/conversation-behavior-ir.test.ts` passed (`7` tests)
  - `pnpm --filter @agent-platform/project-io exec vitest run src/__tests__/conversation-behavior-roundtrip.test.ts src/__tests__/profile-roundtrip.test.ts` passed (`14` tests)
  - `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/behavior-profiles.e2e.test.ts src/__tests__/conversation-behavior-resolver.test.ts src/__tests__/channels/conversation-behavior-capability.test.ts src/__tests__/observability/trace-profile-resolution.test.ts src/__tests__/e2e/conversation-behavior.e2e.test.ts` passed (`15` tests)
  - `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/conversation-behavior-resolver.test.ts src/__tests__/channels/conversation-behavior-capability.test.ts src/__tests__/profile-resolver.test.ts src/__tests__/routing/prompt-builder.test.ts src/__tests__/observability/trace-profile-resolution.test.ts src/__tests__/e2e/conversation-behavior.e2e.test.ts` had already passed earlier in the story (`207` tests)
  - Helix Deep Scan findings fixed for `ABLP-501`:
    - narrowed the new compiler gating assertion to fields explicitly deferred by the current phase docs
    - extended `behavior_profile_applied` E2E coverage to assert the new Conversation Behavior trace summary fields
    - strengthened `project-io` roundtrip coverage with `validateImport()` so the archived DSL proves importability, not just string preservation

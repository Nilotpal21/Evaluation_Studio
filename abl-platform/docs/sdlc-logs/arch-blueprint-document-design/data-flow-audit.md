# Data Flow Audit — Arch Blueprint Flow

Date: 2026-05-12
Scope: onboarding blueprint review, durable session restore, build/create continuation, CLI/eval output hygiene.

## Layer Map

| Layer                | Files                                                                                                                                                                         | Direction                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Session schema       | `packages/arch-ai/src/types/session.ts`, `packages/database/src/models/arch-session.model.ts`                                                                                 | Defines durable phase, topology, blueprint stage, build progress, pending widget state |
| Blueprint storage    | `packages/database/src/models/arch-blueprint.model.ts`, `packages/arch-ai/src/blueprint/service.ts`                                                                           | Stores structured blueprint versions for project-linked and session-linked use         |
| Blueprint generation | `apps/studio/src/lib/arch-ai/engine-factory.ts`, `apps/studio/src/lib/arch-ai/processors/process-message.ts`                                                                  | Writes draft topology and blueprint-stage metadata                                     |
| Artifact rendering   | `apps/studio/src/lib/arch-ai/blueprint-document.ts`, `apps/studio/src/lib/arch-ai/ui/event-dispatcher.ts`                                                                     | Converts durable metadata/topology into Blueprint and Topology tabs                    |
| Session restore      | `packages/arch-ai/src/session/resume-snapshot.ts`, `apps/studio/src/lib/arch-ai/ui/hook.ts`                                                                                   | Rehydrates chat, pending widget, build state, and artifact tabs after reload           |
| Build/create handoff | `apps/studio/src/lib/arch-ai/processors/process-message.ts`, `apps/studio/src/lib/arch-ai/processors/finalize-project.ts`, `apps/studio/src/app/api/arch-ai/message/route.ts` | Continues BUILD and finalizes CREATE via deterministic server path                     |
| CLI/eval             | `packages/kore-platform-cli/src/commands/arch.ts`, `tools/arch-eval/*`, `.gitignore`                                                                                          | Exercises HTTP/SSE Arch path without browser and keeps generated datasets local        |

## Propagation Matrix

| Field / State                               | Schema | Generation                  | Event Artifact | Restore | Build/Create                        | CLI/Eval              |
| ------------------------------------------- | ------ | --------------------------- | -------------- | ------- | ----------------------------------- | --------------------- |
| `metadata.phase`                            | Y      | Y                           | Y              | Y       | Y                                   | Y                     |
| `metadata.blueprintStage`                   | Y      | Y                           | Y              | Y       | Y                                   | observed              |
| `metadata.topology`                         | Y      | Y                           | Y              | Y       | Y                                   | observed              |
| `metadata.draftTopology`                    | Y      | Y                           | Y              | Y       | Y                                   | observed              |
| `metadata.lockedTopology`                   | Y      | Y                           | Y              | Y       | Y                                   | observed              |
| `metadata.topologyApproved`                 | Y      | Y                           | Y              | Y       | Y                                   | observed              |
| `metadata.pendingInteraction`               | Y      | Y                           | widget events  | Y       | Y                                   | observed              |
| `metadata.buildProgress`                    | Y      | Y                           | build events   | Y       | Y                                   | observed              |
| `Project.archConfig.canonicalBlueprintMode` | Y      | partial                     | -              | -       | GAP for onboarding-created projects | -                     |
| `ArchBlueprint.output`                      | Y      | partial via package service | -              | -       | GAP for onboarding-created projects | offline renderer only |
| generated `docs/testing/arch-eval/**`       | -      | -                           | -              | -       | -                                   | ignored               |

## Findings

1. Restore was missing artifact tab reconstruction from durable session metadata. Chat messages and build state were restored, but a reload could leave the right panel blank even when `metadata.topology` / `draftTopology` existed. Fixed in `apps/studio/src/lib/arch-ai/ui/hook.ts` by rebuilding Blueprint and Topology tabs from session metadata during `applySessionSnapshot`.
2. A stale `ACTIVE` session without a Redis turn lock could be rejected as `SESSION_BUSY` before the route checked lock state. Fixed in `apps/studio/src/app/api/arch-ai/message/route.ts` by recovering `ACTIVE -> IDLE` when no pending interaction exists and the turn lock is gone.
3. Generated eval datasets were untracked but visible in `git status`. Fixed with `.gitignore` entry for `docs/testing/arch-eval/`.
4. Canonical `ArchBlueprint` storage exists, but onboarding generation still primarily persists topology in session metadata. This is acceptable for the immediate no-regression restore/build path, but project-linked canonical blueprint persistence should be the next hardening slice.
5. `Project.archConfig.canonicalBlueprintMode` exists and defaults false. Onboarding-created projects are not yet guaranteed to flip this mode or link a blueprint version. Do not default it true until backfill/linking is complete.

## Risk Controls Added

- Reload parity test verifies Blueprint and Topology tabs restore from session metadata.
- Route lock-order test verifies stale `ACTIVE` recovery before the busy guard.
- Existing pending-widget lock-order test still protects against clearing pending interaction before acquiring the turn lock.

## Remaining Follow-Up

- Persist a session-linked `ArchBlueprint` draft when topology generation succeeds.
- Link the locked blueprint to the project during `finalizeProject`, then set `Project.archConfig.canonicalBlueprintMode=true` and `canonicalBlueprintVersion`.
- Add a project readback parity test once the canonical blueprint link is implemented.

# Post-Impl-Sync Log: Voice Runtime Semantics Unification

**Phase**: POST-IMPL-SYNC
**Date**: 2026-04-24
**Status**: Complete

---

## Scope

This sync reconciles the shipped voice-runtime convergence work with the SDLC artifacts that still described the feature as partially open in code and docs. The implementation now includes canonical prompt/profile resolution, coordinator-tool realtime adoption where supported, shared final voice-text shaping across pipeline and bridge delivery surfaces, and updated parity/contract evidence.

## Documents Updated

- `docs/features/sub-features/voice-runtime-semantics-unification.md`
- `docs/testing/sub-features/voice-runtime-semantics-unification.md`
- `docs/specs/voice-runtime-semantics-unification.hld.md`
- `docs/plans/2026-04-22-voice-runtime-semantics-unification-impl-plan.md`
- `docs/testing/README.md`
- `apps/runtime/agents.md`
- `docs/sdlc-logs/voice-runtime-semantics-unification/post-impl-sync.log.md`

## Accuracy Corrections

### Feature Spec

- Updated the implementation status from the 2026-04-22 partial snapshot to the 2026-04-24 shipped state.
- Replaced stale "planned/open" language for canonical prompt/tool resolution, parity-matrix visibility, and prompt-profile diagnostics with the actual implemented seams.
- Updated the key implementation file map to include the shipped coordinator, prompt-profile, parity, live bridge, and final-delivery files.
- Rewrote the gap table so only the still-real partials remain open: coordinator-tool public E2E coverage and operator shadow/enforce review.

### Test Spec

- Replaced the stale validation snapshot with the fresh scoped build, focused runtime regression suite, and bridge/public ingress E2E reruns.
- Updated bridge evidence to include final plain-text delivery regressions for VXML and AudioCodes.
- Fixed test file mapping drift for `provider-normalization.test.ts` and added the shipped delivery-surface regressions.

### HLD / LLD

- Added post-implementation notes describing the shipped final-delivery convergence path and the remaining accepted partials.
- Marked the completed phase exit criteria, wiring checklist items, and acceptance criteria that are now satisfied.
- Replaced planned-but-nonexistent realtime/bridge test file references with the actual files on disk.

### Runtime Learnings

- Recorded the adapter-boundary rule in `apps/runtime/agents.md`: spoken output must flow through `channel-adapter.ts`, not raw `outcome.responseText`.

## Coverage Delta

| Area                         | Before                                            | After                                                                                    |
| ---------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Focused runtime verification | stale 2026-04-22 snapshot                         | `18` files / `317` tests passing                                                         |
| Bridge/public ingress E2E    | partial stale references                          | `3` files / `13` tests passing                                                           |
| Final delivery regressions   | VXML/AudioCodes explicit plain-text proof missing | VXML, AudioCodes, LiveKit, and KoreVG final delivery covered in focused regression lanes |
| Plan/test inventories        | planned file names drifted from repo reality      | file maps aligned to shipped files on disk                                               |

## Remaining Open Gaps

- Dedicated public E2E coverage for the coordinator-tool SDK/Twilio realtime lanes is still missing; current closure evidence is integration-first.
- Shadow/enforce rollout review remains an operator-owned follow-up and is not recorded as complete in-repo.
- KoreVG custom S2S/realtime and already-streamed token paths remain accepted partials by design.

## Verification

- `pnpm build --filter=./packages/compiler --filter=./apps/runtime --filter=./packages/web-sdk`
- `pnpm --filter @agent-platform/runtime exec vitest run --maxWorkers=1 ...` (focused voice-runtime suite: `18` files / `317` tests)
- `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.e2e.config.ts --maxWorkers=1 src/__tests__/channels/channels-voice-ingress.e2e.test.ts src/__tests__/channels/audiocodes-interaction-context.e2e.test.ts src/__tests__/channels/voice-pipeline-orpheus.e2e.test.ts` (`3` files / `13` tests)
- A separate slow-config rerun of `livekit-voice.integration.test.ts` was not counted as closure evidence because it did not complete cleanly in local verification.

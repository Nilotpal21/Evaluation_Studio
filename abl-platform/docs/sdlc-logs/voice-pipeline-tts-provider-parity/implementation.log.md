# SDLC Log: voice-pipeline-tts-provider-parity — Implementation

**Feature**: `voice-pipeline-tts-provider-parity`
**Phase**: IMPLEMENTATION
**LLD**: `docs/plans/2026-04-23-voice-pipeline-tts-provider-parity-impl-plan.md`
**Date Started**: 2026-04-23
**Date Completed**: 2026-04-23

---

## Summary

- Expanded the shared voice-provider registry to cover the target pipeline TTS provider set.
- Added Studio provider-card metadata for the new TTS vendors and preserved shared preview-capability gating.
- Extended runtime speech-credential normalization and Jambonz provisioning for representative TTS providers.
- Kept dual-role speech providers aligned across shared registry metadata, channel filtering, and runtime provisioning.

## Verification

- [x] `pnpm --filter @agent-platform/config build`
- [x] `pnpm --filter @agent-platform/config test -- src/__tests__/voice-providers.test.ts`
- [x] `pnpm --dir apps/runtime exec vitest run src/__tests__/speech-credential-mapper.test.ts src/__tests__/jambonz-provisioning.service.test.ts`
- [x] `pnpm --dir apps/studio exec vitest run src/__tests__/speech-providers.test.ts`
- [ ] Runtime authz regression suite passes in this worktree
- [ ] Full Studio/runtime package-wide build clean

## Notable Fixes During Implementation

- Corrected the TTS capability model so runtime-managed channel TTS providers cannot advertise `useForTts: false`.
- Preserved TTS preview as a separate shared capability instead of widening preview support implicitly.
- Kept the TTS provider matrix aligned between shared config, Studio forms, and runtime provisioning.

## Verification Gaps

- The runtime authz regression suite is still blocked in this worktree by the pre-existing `@agent-platform/shared/rbac` resolution failure from shared test helpers.
- Studio/runtime package-wide builds still hit unrelated workspace module-resolution failures outside the touched files.

## Outcome

Implementation is complete for the story scope. Shared-config, Studio filtering, and runtime mapper/Jambonz verification are green; broader runtime/package-wide verification remains partially blocked by unrelated workspace issues.

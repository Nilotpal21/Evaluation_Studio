# SDLC Log: voice-pipeline-stt-provider-parity — Implementation

**Feature**: `voice-pipeline-stt-provider-parity`
**Phase**: IMPLEMENTATION
**LLD**: `docs/plans/2026-04-23-voice-pipeline-stt-provider-parity-impl-plan.md`
**Date Started**: 2026-04-23
**Date Completed**: 2026-04-23

---

## Summary

- Expanded the shared voice-provider registry to cover the target pipeline STT provider set
- Added Studio provider-card metadata and Voice Services form handling for the new STT vendors
- Added runtime speech-credential mapping and Jambonz payload support for representative new STT providers
- Hardened runtime service-instance CRUD to preserve secret config on partial updates and support auth-profile-backed sync
- Tightened Studio provider filtering so channel speech pickers only see active configured providers

## Verification

- [x] `pnpm --filter @agent-platform/config build`
- [x] `pnpm --filter @agent-platform/config test -- src/__tests__/voice-providers.test.ts`
- [x] `pnpm --dir apps/runtime exec vitest run src/__tests__/speech-credential-mapper.test.ts src/__tests__/jambonz-provisioning.service.test.ts`
- [x] `pnpm --dir apps/studio exec vitest run src/__tests__/speech-providers.test.ts src/__tests__/voice-services.test.ts src/__tests__/s2s-provider-selector.test.tsx`
- [ ] `pnpm --dir apps/runtime exec vitest run src/__tests__/auth/tenant-service-instances-authz.test.ts`
- [ ] Full Studio/runtime package-wide build clean

## Notable Fixes During Implementation

- Added a dedicated runtime mapper so vendor-specific speech provisioning is not encoded directly inside the CRUD route.
- Fixed the service-instance proxy/filter gap so inactive providers no longer leak into channel speech pickers.
- Fixed the partial-config update path so omitted secret fields are merged from stored config instead of being dropped.

## Verification Gaps

- The runtime authz regression suite is still blocked in this worktree by the pre-existing `@agent-platform/shared/rbac` resolution failure from shared test helpers.
- Studio/runtime package-wide builds still hit unrelated workspace module-resolution failures outside the touched files.

## Files Added

- `apps/runtime/src/services/voice/speech-credential-mapper.ts`
- `apps/runtime/src/__tests__/speech-credential-mapper.test.ts`
- `docs/features/sub-features/voice-pipeline-stt-provider-parity.md`
- `docs/testing/sub-features/voice-pipeline-stt-provider-parity.md`
- `docs/specs/voice-pipeline-stt-provider-parity.hld.md`
- `docs/plans/2026-04-23-voice-pipeline-stt-provider-parity-impl-plan.md`

## Outcome

Implementation is complete for the story scope. Shared-config, runtime mapper/Jambonz tests, and Studio filtering verification are green; route/package-wide runtime verification remains partially blocked by unrelated workspace issues.

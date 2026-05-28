# SDLC Log: voice-provider-registry — Implementation

**Feature**: `voice-provider-registry`
**Phase**: IMPLEMENTATION
**LLD**: `docs/plans/2026-04-22-voice-provider-registry-impl-plan.md`
**Date Started**: 2026-04-22
**Date Completed**: 2026-04-22

---

## Summary

- Added a canonical voice-provider registry in `packages/config`
- Refactored Studio voice-service cards, speech-provider filtering, and S2S provider surfaces to consume the registry
- Refactored runtime voice service-type validation helpers to consume the registry
- Added focused coverage for shared registry behavior, Studio selector/filtering behavior, and runtime route allowlist behavior

## Verification

- [x] `pnpm --filter @agent-platform/config build`
- [x] `pnpm --filter @agent-platform/config test -- src/__tests__/voice-providers.test.ts`
- [x] `pnpm --dir apps/studio exec vitest run src/__tests__/speech-providers.test.ts src/__tests__/s2s-provider-selector.test.tsx`
- [x] Filtered Studio `tsc --noEmit` reported no errors for the touched files after the `VoiceServiceCardConfig` cleanup
- [ ] Full runtime package build/test clean

## Notable Fixes During Implementation

- Fixed a runtime regression in `apps/runtime/src/services/voice/s2s/types.ts` where `S2SProviderType` had been re-exported without a local import, leaving the symbol unavailable to the file itself.
- Fixed a Studio regression in `VoiceServicesPage.tsx` caused by stale references to the old `ServiceCardConfig` type name after moving card metadata into the Studio registry wrapper.

## Verification Gaps

- Repo-root and package-wide runtime verification in this worktree still hit unrelated workspace module-resolution failures outside the touched files.
- The runtime authz regression file was updated, but direct execution remains blocked here by an existing `@agent-platform/shared/rbac` resolution failure from shared test helpers.

## Files Added

- `packages/config/src/constants/voice-providers.ts`
- `packages/config/src/__tests__/voice-providers.test.ts`
- `apps/studio/src/components/voice/voice-provider-registry.tsx`
- `apps/studio/src/__tests__/s2s-provider-selector.test.tsx`

## Outcome

Implementation is complete for the story scope. Shared-config and Studio verification are green; runtime verification is partially complete with blockers documented above.

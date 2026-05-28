# SDLC Log: voice-s2s-provider-parity — Implementation

**Feature**: `voice-s2s-provider-parity`
**Phase**: IMPLEMENTATION
**LLD**: `docs/plans/2026-04-23-voice-s2s-provider-parity-impl-plan.md`
**Date Started**: 2026-04-23
**Date Completed**: 2026-04-23

---

## Summary

- Added a dedicated provider-aware S2S adapter for payload building, tool envelopes, and event translation.
- Wired KoreVG runtime through the provider-aware adapter for the modeled non-OpenAI providers.
- Added Deepgram and Ultravox config fields in Studio/admin and kept the modeled S2S provider set centralized in shared config.
- Corrected the partial-provider warning copy so it reflects the actual remaining inline handoff limitation.

## Verification

- [x] `pnpm --filter @agent-platform/config build`
- [x] `pnpm --filter @agent-platform/config test -- src/__tests__/voice-providers.test.ts`
- [x] `pnpm --dir apps/studio exec vitest run src/__tests__/speech-providers.test.ts src/__tests__/voice-services.test.ts src/__tests__/s2s-provider-selector.test.tsx`
- [x] `pnpm --dir apps/runtime exec vitest run src/__tests__/s2s-provider-adapter.test.ts`
- [ ] `pnpm --dir apps/runtime exec vitest run --config vitest.integration.config.ts --maxWorkers=1 src/__tests__/channels/korevg-router.test.ts`
- [ ] `pnpm --dir apps/runtime exec vitest run src/__tests__/auth/tenant-service-instances-authz.test.ts`
- [ ] Full Studio/runtime package-wide build clean

## Notable Fixes During Implementation

- Added provider-native tool result and tool error envelopes instead of routing everything through an OpenAI-only message shape.
- Added provider-native event translation so non-OpenAI transcript/barge-in flows emit internal voice trace events consistently.
- Prevented non-OpenAI/non-Google providers from receiving invalid inline OpenAI `session.update` behavior during agent changes.
- Refined the shared partial-provider warning copy to reflect the actual remaining limitation after runtime parity work landed.

## Verification Gaps

- `korevg-router.test.ts` exists, but the correct integration-config lane is still blocked in this worktree by a pre-existing `@agent-platform/shared-observability` package-resolution failure.
- The runtime authz regression suite is still blocked in this worktree by the pre-existing `@agent-platform/shared/rbac` resolution failure from shared test helpers.
- Studio/runtime package-wide builds still hit unrelated workspace module-resolution failures outside the touched files.

## Outcome

Implementation is complete for the story scope. Shared-config, Studio selector/proxy coverage, and focused provider-adapter verification are green; router integration and broader runtime/package-wide verification remain partially blocked by unrelated workspace issues.

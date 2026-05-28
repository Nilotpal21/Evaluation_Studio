# ABLP-710 Voice Filler Delay Data-Flow Audit

Date: 2026-05-13

## Scope

Audit field propagation for `filler.voiceDelayMs` after changing the voice filler default to `500ms` and removing `0` as an unset sentinel.

## Layer Map

| Layer              | Path                                                                                                  | Handling                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Shared validation  | `packages/shared/src/validation/project-runtime-config.ts`                                            | Accepts optional `voiceDelayMs` with `1..60000` bounds and default `500`.                      |
| DB model           | `packages/database/src/models/project-runtime-config.model.ts`                                        | Persists optional `voiceDelayMs`; Mongoose default is `500`, min is `1`.                       |
| Migration          | `packages/database/src/migrations/scripts/20260513_034_backfill_voice_filler_delay.ts`                | Rewrites legacy stored `0` values to `500`; validation fails if legacy zeros remain.           |
| Migration registry | `packages/database/src/migrations/registry.ts`, `packages/database/src/change-management/manifest.ts` | Registers the backfill as a deploy-required pre-deploy migration for runtime and Studio.       |
| Compiler IR        | `packages/compiler/src/platform/ir/project-runtime-config.ts`                                         | Maps missing `voiceDelayMs` to `500` in `ProjectRuntimeConfigIR`.                              |
| Runtime resolver   | `apps/runtime/src/services/filler/config.ts`                                                          | Uses nullish fallback only; does not treat `0` as unset.                                       |
| Channel defaults   | `apps/runtime/src/services/filler/types.ts`, `apps/runtime/src/services/filler/config-resolver.ts`    | Defines voice pipeline default as `voiceDelayMs: 500`.                                         |
| Studio UI          | `apps/studio/src/components/settings/RuntimeConfigTab.tsx`                                            | Displays default `500` and prevents `0` through the number input minimum.                      |
| Tests              | Runtime filler tests and database migration tests                                                     | Cover resolver behavior, cross-layer parity, route defaults, prompt refs, and legacy backfill. |

## Propagation Matrix

| Field          | Shared Schema | DB Model | Migration | Compiler IR | Runtime Resolver | Studio UI | Tests |
| -------------- | ------------- | -------- | --------- | ----------- | ---------------- | --------- | ----- |
| `voiceDelayMs` | Y             | Y        | Y         | Y           | Y                | Y         | Y     |

## Findings

No open propagation gaps remain.

The review initially found that old persisted `voiceDelayMs: 0` records would become immediate voice fillers once runtime stopped treating `0` as unset. That gap is closed by migration `20260513_034_backfill_voice_filler_delay`, by schema/model/UI minimums that prevent new zero values, and by the parity test `apps/runtime/src/__tests__/extraction/filler-config-parity.test.ts`.

## Verification

- `pnpm --filter @agent-platform/runtime... build`
- `pnpm --filter @agent-platform/database exec vitest run src/__tests__/voice-filler-delay-migration.test.ts`
- `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/extraction/filler-config-resolver.test.ts src/__tests__/extraction/filler-config-propagation.test.ts src/__tests__/extraction/filler-config-parity.test.ts src/__tests__/project-runtime-config-route.test.ts src/routes/__tests__/prompt-library-references.test.ts src/services/prompt-library/__tests__/prompt-library-service.test.ts`
- `pnpm --filter @agent-platform/studio build`

# SDLC Log: Channels — Post-Implementation Sync

**Feature**: channels
**Phase**: POST-IMPL-SYNC
**Date**: 2026-04-03

## Documents Updated

- Feature spec: `docs/features/channels.md` — refreshed data model, added parity/identity/bounded-connection seams, corrected gaps, and updated testing summary
- Test spec: `docs/testing/channels.md` — replaced the old near-zero-coverage framing with the current representative runtime/studio coverage
- HLD: `docs/specs/channels.hld.md` — status and testing sections aligned with the implemented system
- LLD: `docs/plans/2026-03-22-channels-impl-plan.md` — current-state assessment updated from "zero E2E/integration" to a hardening backlog on top of an implemented feature

## Key Findings

- `apps/runtime/src/channels/channel-behavior-contract.ts` is now a central parity seam and should be documented alongside the manifest.
- Channel identity verification is now normalized through `apps/runtime/src/routes/channel-connection-identity-utils.ts`; Studio create/edit flows must send `identityVerification.providerVerificationStrength`, not the old top-level field.
- The old WebSocket OOM finding is mitigated: both SDK and debug handlers now use `WebSocketConnectionManager`.
- SDK channel `authProfileId` should no longer be described as an active stored/runtime-supported field. The repo layer strips stale input and the supported SDK auth controls are public API keys plus `hmacEnforcement`.

## Representative Coverage Called Out

- `apps/runtime/src/__tests__/channels/channels-control-plane.e2e.test.ts`
- `apps/runtime/src/__tests__/channels/http-async-identity-continuity.e2e.test.ts`
- `apps/runtime/src/__tests__/channels/channel-behavior-contract.test.ts`
- `apps/runtime/src/__tests__/channels/ws-sdk-handler.test.ts`
- `apps/runtime/src/__tests__/execution/channel-dispatcher.test.ts`
- `apps/runtime/src/__tests__/routes/channel-connection-identity-utils.test.ts`

## Remaining Gaps

- Channel health checks and connectivity probes are still not first-class control-plane features.
- Exhaustive webhook → delivery black-box E2E parity across every provider family is still broader in unit/integration coverage than in E2E coverage.
- Provider base-URL override SSRF validation remains an open hardening item.

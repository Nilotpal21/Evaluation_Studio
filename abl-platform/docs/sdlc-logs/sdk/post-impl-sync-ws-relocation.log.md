# SDLC Log: SDK — Post-Implementation Sync (WebSocket Relocation)

**Feature**: SDK (parent) + WebSocket Relocation (sub-feature)
**Phase**: POST-IMPL-SYNC
**Date**: 2026-04-14
**Trigger**: 7 commits under ABLP-333 implementing WS relocation, SDK heartbeat removal, and legacy ping compat

---

## Documents Updated

- [x] Feature spec: `docs/features/sdk.md` — Added FR-17/FR-18, WS relocation summary in intro, new implementation files, new test files, updated testing summary, updated references
- [x] Sub-feature spec: `docs/features/sub-features/ws-relocation.md` — Status PLANNED -> ALPHA, FR table updated with actual implementation status, implementation files updated to reflect reality, gaps section updated with GAP-007/008/009, testing section rewritten with actual coverage
- [x] Test spec (main): `docs/testing/sdk.md` — Last updated date, added WS relocation summary to current state, added remaining gaps
- [x] Test spec (sub): `docs/testing/sub-features/ws-relocation.md` — Status PLANNED -> IN PROGRESS, coverage matrix updated with actuals, test file mapping rewritten (existing/planned/cancelled sections), current state updated
- [x] Testing index: `docs/testing/README.md` — Updated WS relocation row to IN PROGRESS (ALPHA) 04-14
- [x] HLD: `docs/specs/ws-relocation.hld.md` — Status DRAFT -> APPROVED, added Post-Implementation Notes section documenting 5 deviations
- [x] LLD: `docs/plans/2026-04-13-ws-relocation-impl-plan.md` — Status DRAFT -> DONE

## Coverage Delta

| Type              | Before | After |
| ----------------- | ------ | ----- |
| Unit tests        | 0      | 8     |
| Integration tests | 0      | 0     |
| E2E tests         | 0      | 0     |

## Remaining Gaps

1. **L7 proxy idle timeout (GAP-007)**: The keepalive feature (FR-5/FR-6) was reverted during hardening. Internal Studio `/ws` connections are still subject to proxy-killed idle timeouts. The WS relocation reduces the number of affected connections but does not solve the timeout problem.
2. **No E2E/integration tests (GAP-008)**: All 7 planned E2E tests and 7 planned integration tests remain unwritten. The WS relocation is structural code that would benefit from browser E2E proof.
3. **CommandPalette partial decoupling (GAP-009)**: Uses `useOptionalWebSocketContext` instead of full WS independence. Session-dependent commands are hidden outside the provider tree, which is correct but not fully decoupled.

## Deviations from Plan

1. **Keepalive reverted**: The HLD planned application-level ping/pong keepalive. It was implemented then reverted in the hardening follow-up. The runtime protocol-level heartbeat remains the only keepalive mechanism.
2. **SDK heartbeat removed**: The browser SDK `SessionManager` JSON heartbeat timer was removed (not planned in the original WS relocation scope, but done as part of the same ABLP-333 work).
3. **Legacy SDK ping compat added**: A `sendLegacyPong()` shim was added to `sdk-handler.ts` for backward compatibility with older SDK bundles.
4. **Type changes were net-zero**: All planned type additions were added then removed. The `pong` member was removed from runtime `ServerMessage` union.
5. **New utility extractions**: `app-graph-loader.ts` and `useAvailableApps.ts` were created as standalone utilities during the WS decoupling work.

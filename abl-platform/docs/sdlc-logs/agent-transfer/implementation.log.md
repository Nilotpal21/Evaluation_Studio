# SDLC Log: Agent Transfer Boundary Hardening — Implementation Phase

**Feature**: agent-transfer-boundary-hardening
**Phase**: IMPLEMENTATION
**LLD**: `docs/plans/2026-04-17-agent-transfer-boundary-hardening.md`
**Date Started**: 2026-04-17
**Date Completed**: IN PROGRESS

---

## Preflight

- [x] LLD file paths verified — all Phase 1 targets exist on current `develop`; the runtime routing-context helper files are new by design
- [x] Function signatures current — reread `TransferSessionStore`, transfer payload/tool contracts, Kore/Five9 adapter session persistence, and runtime boot wiring from disk before editing
- [x] No conflicting recent changes — recent history on the Phase 1 files is compatible with the LLD; unrelated dirty worktree edits were kept out of this slice
- Discrepancies: none blocking. Current `develop` still matches the audited gap: transfer ownership and routing are not yet modeled as a canonical contract.

## Phase Execution

### LLD Phase 1: Canonical Routing Contract

- **Status**: DONE
- **Exit Criteria**: all met
  - [x] both legacy and new transfer sessions can be read
  - [x] new transfer sessions persist `routing.runtimeSessionId`
  - [x] new transfer sessions persist `routing.normalizedTransferChannel`
- **Files Changed**: 16
- **Deviations**:
  - Added explicit persisted `ownerId` so the Redis key owner can move to `runtimeSessionId` without overloading business `contactId`
  - Patched the runtime boot/provider lookup compatibility path in the same slice so inbound provider events reconstruct the new key shape correctly
  - Added the runtime transfer-routing-context helper and focused tests now because later slices need a reusable canonical builder

### LLD Phase 2: Unify Transfer Initiation

- **Status**: DONE (phase commit pending)
- **Exit Criteria**: all met
  - [x] both initiation paths produce the same owner/routing contract inputs
  - [x] both initiation paths persist canonical `routing` data
  - [x] tool-driven transfers now drive the same active runtime transfer flags needed by the forwarding path
- **Files Changed**: 8
- **Deviations**:
  - Introduced a runtime transfer-envelope builder that resolves contact identity, interaction context, return-route hints, and optional voice data from the live runtime session instead of duplicating partial assembly in each initiation path
  - Kept direct escalation on the existing adapter execution path for low-risk HITL fallback behavior, but moved its routing/contact/context construction onto the shared helper
  - Extended `TransferToolExecutor` with lazy per-call context resolution and an explicit transfer-result callback so `LLMWiringService` can synchronize `isEscalated` and `transferInitiated` without introducing runtime-specific logic into the shared package
  - Extended `TransferToAgentTool` to forward voice transfer data and synthesize `routing.voice` from the same context so tool-driven voice transfers use the canonical envelope too

### ABLP-511: Agent Transfer Platform Events (2026-05-16)

- **Status**: DONE
- **Branch**: `feature/ABLP-511-agent-transfer-platform-events`
- **Plan**: `docs/superpowers/plans/2026-05-16-agent-transfer-platform-events.md`
- **Exit Criteria**: all met
  - [x] `agent_transfer.transfer_initiated` emitted on escalation
  - [x] `agent_transfer.agent_connected` emitted with `agentName`
  - [x] `agent_transfer.agent_disconnected` emitted on first disconnect only (post_agent guard)
  - [x] `agent_transfer.transfer_completed` emitted alongside disconnect
  - [x] `agent_transfer.acw_completed` emitted from separate ACW data message
  - [x] All events visible in `abl_platform.platform_events` ClickHouse table
- **Architecture Corrections vs Plan**:
  - `acw_completed` moved from `agent:disconnected` handler to `agent:message` handler. SmartAssist sends ACW disposition data (disposition code, wrap-up notes, timeout flag) as a **separate `agent:message`** with `isACWEnabled: true` after the full disconnect sequence, not bundled in the disconnect signal itself.
  - `acwCompletedEmitted` Redis flag added to `TransferSessionData` / `UpdateTransferSessionFields` for exactly-once guard against SmartAssist's triple-disconnect pattern.
  - `agent_disconnected` enriched with selective SmartAssist fields: `originalType`, `syntheticDisconnect`, `isACWEnabled`, `acwStartTime` (ISO string from SmartAssist, not computed locally).
  - `acw_completed` gains `timestamp` field sourced from `event.data.timestamp` (SmartAssist ISO string).
- **Schema Updates**: `AgentTransferAgentDisconnectedDataSchema` and `AgentTransferAcwCompletedDataSchema` in `packages/eventstore/src/schema/events/agent-events.ts` extended with all new fields.
- **Verified in ClickHouse** (session `fbe9a0e2-58bb-4b27-a8b7-e5361fa05de1`, 2026-05-16):
  - `agent_disconnected.acwStartTime`: `"2026-05-16T11:51:51.804Z"`, `isACWEnabled: true`
  - `acw_completed.dispositionCode`: `"Resolved"`, `reason`: `"Submitted plan "`, `acwCloseReason`: `"agent_closed"`, gap from disconnect to ACW: 14 seconds

## Verification

- `pnpm build --filter=@agent-platform/agent-transfer --filter=@agent-platform/runtime`
- `pnpm --filter @agent-platform/agent-transfer exec vitest run src/__tests__/unit/parse-session-hash.test.ts src/__tests__/kore-adapter-key-fixes.test.ts src/adapters/five9/__tests__/five9-adapter.test.ts src/adapters/five9/__tests__/five9-adapter-cleanup.integration.test.ts`
- `pnpm --filter @agent-platform/runtime exec vitest run src/services/agent-transfer/__tests__/transfer-routing-context.test.ts src/__tests__/agent-transfer-boot.test.ts`
- `pnpm build --filter=@agent-platform/agent-transfer --filter=@agent-platform/runtime`
- `pnpm --filter @agent-platform/runtime exec vitest run src/services/agent-transfer/__tests__/transfer-routing-context.test.ts src/__tests__/transfer-tool-executor.test.ts src/__tests__/escalation-transfer-wiring.test.ts src/__tests__/llm-wiring.test.ts`
- `pnpm --filter @agent-platform/agent-transfer exec vitest run src/__tests__/integration/voice-transfer.test.ts src/__tests__/integration/backward-compat.test.ts src/__tests__/integration/kore-transfer-flow.test.ts`

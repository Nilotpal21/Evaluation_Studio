# LLD: Runtime Pipeline Filler Config

**Ticket**: ABLP-710
**Feature Spec**: `docs/features/filler-messages.md`
**HLD**: `docs/specs/filler-messages.hld.md`
**Test Spec**: `docs/testing/filler-messages.md`
**Prior Phase 2 Plan**: `docs/plans/2026-03-23-filler-messages-impl-plan.md` (Tasks 2.4–2.6)
**Status**: DONE
**Date**: 2026-04-29
**Completed**: 2026-04-29

---

## 1. Requirements Traceability

| FR    | Requirement                                                    | ABLP-710 Coverage                                                                                   |
| ----- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| FR-10 | Voice channels MUST emit fillers via TTS with barge-in support | **Out of scope** — voice handler wiring deferred to Task 2.3/2.6 follow-up                          |
| FR-11 | Agent DSL MUST support `CHANNEL_SETTINGS.status_messages`      | **Out of scope** (D-1) — DSL compiler deferred to follow-up ABLP-7xx                                |
| FR-12 | Config resolution: agent DSL > project settings > defaults     | **Partially addressed** — channel-type defaults layer only. DSL + project settings layers deferred. |

ABLP-710 implements the bottom layer of FR-12: the channel-type-aware defaults resolution. It also lays the manifest groundwork (`fillerMode` field) required by FR-10 and FR-12 higher layers.

---

## 2. Design Decisions

### Decision Log

| #   | Decision                                                                                                                                                    | Rationale                                                                                                                                                                                                                                                       | Alternatives Rejected                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| D-1 | DSL compiler (`CHANNEL_SETTINGS` parser, `FillerConfigIR` in IR schema) is **out of scope**                                                                 | ABLP-710 Jira description explicitly defers it to a follow-up. The runtime resolver works with channel-based defaults alone.                                                                                                                                    | Adding IR schema slot now — compiler package change with no consumer until DSL parser lands                |
| D-2 | `fillerMode: 'none'` **skips the entire filler block** — `FillerMessageService`, `StatusTagParser` `onChunk` wrapper, and pipeline-filler parallel LLM call | All three are inside the same `if (onTraceEvent)` block at `runtime-executor.ts:3062`. Skipping the block avoids unnecessary hot-path overhead for channels that cannot receive mid-flight injection.                                                           | Create service with `{ enabled: false }` — constructor is cheap but the full wiring block is not           |
| D-3 | Voice pipeline filler delay is **1200ms** (not 0ms)                                                                                                         | Aligns voice pipeline filler timing with the chat default while preserving voice-specific cooldown and maxPerTurn limits. Barge-in cancels filler when response arrives early.                                                                                  | 0ms delay — would cause TTS audio collision with first response chunk                                      |
| D-4 | **Keep `chatDelayMs`**, add `voiceDelayMs?: number` alongside it                                                                                            | `chatDelayMs` is exported from `filler/types.ts`, referenced in `filler-service.ts`, and used in 5 test files. Export removal guard + additive commit policy blocks renaming. `voiceDelayMs` overrides `chatDelayMs` for voice channels in the resolver output. | Rename to `delayMs` — blocked by `exported-symbol-guard.sh` hook                                           |
| D-5 | `resolveFillerConfig` signature for this ticket: **`(channelType: string \| undefined): FillerConfig`**                                                     | Accepts `undefined` so the call site passes `session.channelType` directly without a manual fallback chain. Resolver treats `undefined` as 'chat' fallback internally. No IR consumer yet. Future ABLP-7xx adds `(channelType, ir?: FillerConfigIR)`.           | Full `(agentIR, projectSettings, channelType)` signature — over-engineered for a function with no IR input |
| D-6 | `fillerMode` is a **required field** on `ChannelManifestEntry`                                                                                              | Grep confirms zero code outside `manifest.ts` constructs `ChannelManifestEntry` objects — safe to require. Required field prevents silent omissions when new channels are added.                                                                                | Optional with default — hides gaps in new channel registrations                                            |

### Key Interfaces & Types

```typescript
// EXTENDED — apps/runtime/src/channels/manifest.ts
export type ChannelFillerMode = 'chat' | 'voice_pipeline' | 'none';

export interface ChannelManifestEntry {
  // ... existing fields ...
  readonly fillerMode: ChannelFillerMode; // NEW — required
}

// EXTENDED — apps/runtime/src/services/filler/types.ts
export interface FillerConfig {
  enabled: boolean;
  chatDelayMs: number; // kept for backward compat — used by chat channels
  voiceDelayMs?: number; // NEW — used by voice_pipeline channels (default: 1200)
  cooldownMs: number;
  maxPerTurn: number;
}

export const DEFAULT_VOICE_PIPELINE_FILLER_CONFIG: FillerConfig = {
  enabled: true,
  chatDelayMs: 1200, // fallback, aligned with voiceDelayMs by default
  voiceDelayMs: 1200,
  cooldownMs: 5000,
  maxPerTurn: 3,
};

// NEW — apps/runtime/src/services/filler/config-resolver.ts
export function resolveFillerConfig(channelType: string | undefined): FillerConfig;
```

### Module Boundaries

| Module                      | Responsibility                                                                    | Depends On                       |
| --------------------------- | --------------------------------------------------------------------------------- | -------------------------------- |
| `channels/manifest.ts`      | Declares `fillerMode` per channel — single source of truth for channel capability | No new deps                      |
| `filler/types.ts`           | Extended `FillerConfig` + new `DEFAULT_VOICE_PIPELINE_FILLER_CONFIG` constant     | No new deps                      |
| `filler/config-resolver.ts` | Pure function: channel type → resolved `FillerConfig`                             | `manifest.ts`, `filler/types.ts` |
| `runtime-executor.ts`       | Consumes `resolveFillerConfig`; gates filler block on `fillerMode !== 'none'`     | `filler/config-resolver.ts`      |

---

## 3. File-Level Change Map

### New Files

| File                                                                   | Purpose                                                                                | LOC Estimate |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------ |
| `apps/runtime/src/services/filler/config-resolver.ts`                  | Pure `resolveFillerConfig(channelType)` — maps channel type to resolved `FillerConfig` | ~55          |
| `apps/runtime/src/__tests__/extraction/filler-config-resolver.test.ts` | Unit tests for resolver (pure function, zero infrastructure)                           | ~150         |

### Modified Files

| File                                            | Change Description                                                                                                                                    | Risk   |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `apps/runtime/src/channels/manifest.ts`         | Add `ChannelFillerMode` type + `fillerMode` required field to `ChannelManifestEntry`; populate all channel rows (currently 28)                        | Low    |
| `apps/runtime/src/services/filler/types.ts`     | Add `voiceDelayMs?: number` to `FillerConfig`; add `DEFAULT_VOICE_PIPELINE_FILLER_CONFIG` constant                                                    | Low    |
| `apps/runtime/src/services/filler/index.ts`     | Export `resolveFillerConfig`, `DEFAULT_VOICE_PIPELINE_FILLER_CONFIG`, `ChannelFillerMode`                                                             | Low    |
| `apps/runtime/src/services/runtime-executor.ts` | Import `resolveFillerConfig`; replace `DEFAULT_FILLER_CONFIG` at L3065 with resolver call; add `fillerMode !== 'none'` guard to filler creation block | Medium |

---

## 4. Implementation Phases

### Phase 1: Manifest `fillerMode` Field

**Goal**: Add `fillerMode` to `ChannelManifestEntry` as a required field and populate every channel row — establishing the single source of truth for filler capability.

**Tasks**:

1.1. Add `ChannelFillerMode = 'chat' | 'voice_pipeline' | 'none'` type to `manifest.ts`  
1.2. Add `readonly fillerMode: ChannelFillerMode` to `ChannelManifestEntry` interface  
1.3. Populate all entries in `CHANNEL_MANIFEST` (currently 28 rows; TypeScript enforces completeness as a required field):

| fillerMode         | Channels                                                                                                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `'none'`           | `voice_realtime` (model handles own audio), `voice_vxml` (sync response — no mid-flight injection)                                                                                                                                                           |
| `'voice_pipeline'` | `voice_pipeline`, `korevg`, `audiocodes`, `voice_twilio`, `voice_livekit`, `voice`                                                                                                                                                                           |
| `'chat'`           | `web_chat`, `sdk_websocket`, `slack`, `msteams`, `whatsapp`, `email`, `api`, `twilio_sms`, `messenger`, `instagram`, `telegram`, `zendesk`, `genesys`, `a2a`, `ag_ui`, `http_async`, `web_debug`, `line`, `http`, `ai4w` (all remaining registered channels) |

Notes:

- `'websocket'` is **not** a registered entry in `CHANNEL_MANIFEST`. These sessions hit the `undefined` → `'chat'` fallback.
- `genesys`, `api`, and `http` are sync-response channels that technically cannot inject mid-flight fillers. They are classified as `'chat'` for now (harmless — filler events fire but are ignored by the sync response path). A future optimization may classify them as `'none'`. Sessions with `channelType: undefined` or `channelType: 'websocket'` both hit the `getChannelManifest()` → `undefined` → `?? 'chat'` fallback path in the resolver, correctly returning `DEFAULT_FILLER_CONFIG`.

  1.4. Verify `getChannelManifest()` return type exposes `fillerMode` (no change needed — returns `ChannelManifestEntry`)

**Files Touched**:

- `apps/runtime/src/channels/manifest.ts` — type + interface + all data rows

**Exit Criteria**:

- [x] `pnpm build --filter=runtime` passes with zero TypeScript errors
- [x] TypeScript enforces `fillerMode` on every new channel added (required field)
- [x] `voice_realtime` and `voice_vxml` rows have `fillerMode: 'none'`
- [x] All 6 pipeline voice channels have `fillerMode: 'voice_pipeline'`
- [x] All non-voice channels have `fillerMode: 'chat'`

**Test Strategy**:

- Type system enforces completeness at compile time (required field)
- Config-resolver unit tests (Phase 2) validate correct manifest lookups

**Rollback**: Remove `fillerMode` field from interface + all data rows — additive change, zero behavior change at this phase.

---

### Phase 2: Extended `FillerConfig` + `DEFAULT_VOICE_PIPELINE_FILLER_CONFIG`

**Goal**: Extend `FillerConfig` to carry a voice-specific delay without breaking existing consumers.

**Tasks**:

2.1. Add `voiceDelayMs?: number` to `FillerConfig` interface in `types.ts`  
2.2. Add `DEFAULT_VOICE_PIPELINE_FILLER_CONFIG: FillerConfig` constant:

```ts
{
  enabled: true,
  chatDelayMs: 1200,   // fallback, aligned with voiceDelayMs by default
  voiceDelayMs: 1200,  // aligned with chat default
  cooldownMs: 5000,    // longer than chat (TTS utterances take longer to play)
  maxPerTurn: 3,       // voice users tolerate fewer fillers
}
```

2.3. Export `DEFAULT_VOICE_PIPELINE_FILLER_CONFIG` from `filler/index.ts`  
2.4. No changes to `DEFAULT_FILLER_CONFIG` or `filler-service.ts` — existing chat path is untouched

**Files Touched**:

- `apps/runtime/src/services/filler/types.ts`
- `apps/runtime/src/services/filler/index.ts`

**Exit Criteria**:

- [x] `pnpm build --filter=runtime` passes
- [x] `FillerConfig` interface has `voiceDelayMs?: number` (optional — backward compat preserved)
- [x] All existing `filler-service.test.ts` tests pass unchanged (no chatDelayMs references broken)
- [x] `DEFAULT_FILLER_CONFIG` is unchanged

**Test Strategy**:

- Build verification only for this phase — behavior change comes in Phase 4

**Rollback**: Remove `voiceDelayMs` field + `DEFAULT_VOICE_PIPELINE_FILLER_CONFIG` — additive, zero behavior change.

---

### Phase 3: `resolveFillerConfig` Pure Resolver

**Goal**: Implement and test the pure function that maps a channel type to the correct `FillerConfig` — the core testable contract for ABLP-710.

**Tasks**:

3.1. Create `apps/runtime/src/services/filler/config-resolver.ts`:

```typescript
import { getChannelManifest } from '../../channels/manifest.js';
import { DEFAULT_FILLER_CONFIG, DEFAULT_VOICE_PIPELINE_FILLER_CONFIG } from './types.js';
import type { FillerConfig } from './types.js';

/**
 * Resolves FillerConfig for a session based on channel type.
 * Returns { enabled: false } for channels that cannot receive mid-flight
 * filler injection (voice_realtime, voice_vxml).
 * Returns voice_pipeline defaults for pipeline voice channels.
 * Returns chat defaults for all other channels.
 */
export function resolveFillerConfig(channelType: string | undefined): FillerConfig {
  const manifest = channelType ? getChannelManifest(channelType) : undefined;
  const fillerMode = manifest?.fillerMode ?? 'chat';

  switch (fillerMode) {
    case 'none':
      return { ...DEFAULT_FILLER_CONFIG, enabled: false };
    case 'voice_pipeline':
      return DEFAULT_VOICE_PIPELINE_FILLER_CONFIG;
    default:
      return DEFAULT_FILLER_CONFIG;
  }
}
```

3.2. Export from `apps/runtime/src/services/filler/index.ts`:

- `export type { ChannelFillerMode } from '../../channels/manifest.js'` — type-only re-export directly from source (no intermediate stop in `types.ts`); matches pattern of other manifest-derived capability checks
- `export { resolveFillerConfig }` and `export { DEFAULT_VOICE_PIPELINE_FILLER_CONFIG }` — value exports from their respective source files  
  3.3. Create `apps/runtime/src/__tests__/extraction/filler-config-resolver.test.ts` with 15+ pure unit tests

**Test cases to cover**:

| Test                                                    | Input               | Expected                                       |
| ------------------------------------------------------- | ------------------- | ---------------------------------------------- |
| undefined → chat fallback (session.channelType not set) | `undefined`         | `deepEqual(DEFAULT_FILLER_CONFIG)`             |
| unregistered channel string → chat fallback             | `'unknown_channel'` | `deepEqual(DEFAULT_FILLER_CONFIG)`             |
| web_chat → chat defaults                                | `'web_chat'`        | `DEFAULT_FILLER_CONFIG`                        |
| voice_realtime → disabled                               | `'voice_realtime'`  | `{ ...DEFAULT_FILLER_CONFIG, enabled: false }` |
| voice_vxml → disabled                                   | `'voice_vxml'`      | `{ ...DEFAULT_FILLER_CONFIG, enabled: false }` |
| voice_pipeline → voice defaults                         | `'voice_pipeline'`  | `DEFAULT_VOICE_PIPELINE_FILLER_CONFIG`         |
| korevg → voice defaults                                 | `'korevg'`          | `DEFAULT_VOICE_PIPELINE_FILLER_CONFIG`         |
| audiocodes → voice defaults                             | `'audiocodes'`      | `DEFAULT_VOICE_PIPELINE_FILLER_CONFIG`         |
| voice_twilio → voice defaults                           | `'voice_twilio'`    | `DEFAULT_VOICE_PIPELINE_FILLER_CONFIG`         |
| voice_livekit → voice defaults                          | `'voice_livekit'`   | `DEFAULT_VOICE_PIPELINE_FILLER_CONFIG`         |
| voice (generic) → voice defaults                        | `'voice'`           | `DEFAULT_VOICE_PIPELINE_FILLER_CONFIG`         |
| voice defaults have voiceDelayMs:1200                   | `'voice_pipeline'`  | `.voiceDelayMs === 1200`                       |
| voice defaults have maxPerTurn:3                        | `'voice_pipeline'`  | `.maxPerTurn === 3`                            |
| chat channel returns exact DEFAULT_FILLER_CONFIG        | `'web_chat'`        | `deepEqual(DEFAULT_FILLER_CONFIG)`             |
| none mode always returns enabled:false                  | `'voice_realtime'`  | `.enabled === false`                           |
| slack → chat defaults (async channel)                   | `'slack'`           | `DEFAULT_FILLER_CONFIG`                        |

**Files Touched**:

- `apps/runtime/src/services/filler/config-resolver.ts` (new)
- `apps/runtime/src/services/filler/index.ts`
- `apps/runtime/src/__tests__/extraction/filler-config-resolver.test.ts` (new)

**Exit Criteria**:

- [x] `pnpm test --filter=runtime -- config-resolver` — all 15+ tests pass
- [x] Zero mocks, zero infrastructure — tests are pure input→output assertions
- [x] `pnpm build --filter=runtime` passes with no TypeScript errors
- [x] Resolver handles unknown channel type gracefully (fallback to 'chat' defaults)
- [x] `fillerMode: 'none'` always returns `enabled: false` regardless of other IR fields

**Test Strategy**:

- Pure unit tests only — no mocks, no servers, no DB
- Each test is a single function call with `assert.deepStrictEqual`

**Rollback**: Delete `config-resolver.ts` and its test file — nothing calls it yet.

---

### Phase 4: Runtime Wiring

**Goal**: Replace the hardcoded `DEFAULT_FILLER_CONFIG` in `runtime-executor.ts` with the resolver, and gate filler service creation on `fillerMode !== 'none'`.

**Tasks**:

4.1. Import `resolveFillerConfig` in `runtime-executor.ts`  
4.2. Before the filler block (around L3062), resolve filler config. Use the same two-step fallback that `isVoiceChannel()` uses — `session.channelType` first, then `session.data?.values?.session?.channel` — so filler mode is consistent with voice detection:

```typescript
const sessionChannelType: string | undefined =
  session.channelType ??
  ((session.data?.values?.session as Record<string, unknown> | undefined)?.channel as
    | string
    | undefined);
const resolvedFillerConfig = resolveFillerConfig(sessionChannelType);
```

4.3. Gate the entire filler creation block:

```diff
-if (onTraceEvent) {
+if (onTraceEvent && resolvedFillerConfig.enabled) {
   fillerService = new FillerMessageService(
     sessionId,
-    DEFAULT_FILLER_CONFIG,
+    resolvedFillerConfig,
```

4.4. Remove `DEFAULT_FILLER_CONFIG` import from `runtime-executor.ts` (it's now only needed by the resolver internally)

4.5. Write behavioral integration tests: `apps/runtime/src/__tests__/extraction/filler-config-propagation.test.ts`

Tests use `vi.useFakeTimers()` / `vi.useRealTimers()` — same timer harness pattern as `filler-integration.test.ts:31`. Tests verify actual `FillerMessageService` behavior with resolved configs (config field values are covered by `filler-config-resolver.test.ts`; these tests prove behavioral wiring):

- **disabled guard**: Given `resolveFillerConfig('voice_realtime')` (`enabled: false`), instantiate `FillerMessageService`, call `queueFiller('tool_call', 'text', 'static')`, advance 2000ms — verify zero `onEmit` calls (disabled guard at `filler-service.ts:52` fires)
- **chat delay gate**: Given `resolveFillerConfig('web_chat')`, instantiate service, call `queueFiller()`, advance 1100ms — verify no emission; advance 200ms more — verify one emission
- **voice config maxPerTurn cap**: Given `resolveFillerConfig('voice_pipeline')` (`maxPerTurn: 3`), queue 4 fillers sequentially (resetting cooldown between calls) — verify exactly 3 emitted
- **guard skips service entirely** (verified by code review — cannot be unit-tested without hooking into runtime-executor): Add comment in test file referencing the guard change at `runtime-executor.ts:3062`

  4.6. Update `agent-lifecycle.test.ts` mock factory for `resolveFillerConfig`. `apps/runtime/src/__tests__/agent-lifecycle.test.ts` uses `vi.mock('../services/filler/index.js')` which replaces the filler module barrel wholesale. Once `resolveFillerConfig` is imported by `runtime-executor.ts`, calling it inside the test will hit the mock — which currently has no `resolveFillerConfig` entry and will throw `TypeError: resolveFillerConfig is not a function`. Fix by adding to the mock factory at line ~219:

```typescript
resolveFillerConfig: vi.fn().mockReturnValue({
  enabled: true,
  chatDelayMs: 1200,
  cooldownMs: 3000,
  maxPerTurn: 5,
}),
```

Search for any other test files that mock `'../services/filler/index.js'` (or the barrel path) and apply the same addition.

**Implementation note**: `apps/runtime/src/__tests__/sessions/session-observability-boundaries.test.ts` was not listed in task 4.6 (the LLD noted "search for any other test file") but also required a mock factory update. Found and fixed during implementation. Logged in `apps/runtime/agents.md`.

**Files Touched**:

- `apps/runtime/src/services/runtime-executor.ts` — import swap + config resolution + guard
- `apps/runtime/src/__tests__/extraction/filler-config-propagation.test.ts` (new)
- `apps/runtime/src/__tests__/agent-lifecycle.test.ts` — add `resolveFillerConfig` to mock factory

**Exit Criteria**:

- [x] `pnpm build --filter=runtime` passes
- [x] `pnpm test --filter=runtime -- filler` — all 24 existing filler tests still pass (`filler-service.test.ts` + `filler-integration.test.ts` + `filler-message-pools.test.ts`)
- [x] `pnpm test --filter=runtime -- filler-config-propagation` — new integration tests pass
- [x] `DEFAULT_FILLER_CONFIG` is no longer imported in `runtime-executor.ts`
- [x] `fillerMode: 'none'` channels do not create a `FillerMessageService` instance — verified by code review of guard at `runtime-executor.ts:3062`
- [x] `agent-lifecycle.test.ts` mock factory updated with `resolveFillerConfig` (task 4.6) — verify no `TypeError: resolveFillerConfig is not a function` at test runtime

**Test Strategy**:

- Unit: `config-resolver` verifies correct config objects returned
- Integration: `filler-config-propagation` instantiates real `FillerMessageService` with resolved config, verifies config fields propagated
- Regression: full `pnpm test --filter=runtime` run to confirm no existing test broken

**Rollback**: Revert import swap in `runtime-executor.ts` — restore `DEFAULT_FILLER_CONFIG`. The `config-resolver.ts` can stay; it's unused without the wiring.

---

## 5. Wiring Checklist

- [x] `resolveFillerConfig` exported from `apps/runtime/src/services/filler/index.ts`
- [x] `DEFAULT_VOICE_PIPELINE_FILLER_CONFIG` exported from `filler/index.ts`
- [x] `ChannelFillerMode` type re-exported from `filler/index.ts` via `export type { ChannelFillerMode } from '../../channels/manifest.js'`
- [x] `resolveFillerConfig` imported and called in `runtime-executor.ts`
- [x] `ChannelManifestEntry.fillerMode` populated for all channel rows in `CHANNEL_MANIFEST` (TypeScript enforces this as a required field)
- [x] `getChannelManifest()` return value used in resolver (no channel list duplication)
- [x] `agent-lifecycle.test.ts` mock factory includes `resolveFillerConfig: vi.fn().mockReturnValue({...})` — prevents `TypeError` when runtime-executor calls the resolver during tests
- [x] Any other test file using `vi.mock('../services/filler/index.js')` also has `resolveFillerConfig` in its mock factory — search for all occurrences before closing phase 4

---

## 6. Cross-Phase Concerns

### No Database Migrations

All changes are in-memory runtime configuration. No schema changes.

### No Feature Flags

The config resolution is backward-compatible: unknown channels fall back to `DEFAULT_FILLER_CONFIG` (same as today). No rollout gating needed.

### Configuration Changes

No new env vars. `DEFAULT_VOICE_PIPELINE_FILLER_CONFIG` is a code constant.

### `filler-service.ts` — Voice Delay Applied

`FillerMessageService` now uses `this.config.voiceDelayMs ?? this.config.chatDelayMs` for the delay gate. For voice_pipeline sessions, `resolveFillerConfig` returns `DEFAULT_VOICE_PIPELINE_FILLER_CONFIG` with `chatDelayMs: 1200` as a fallback and `voiceDelayMs: 1200`, so the configured voice default is behaviorally effective and aligned with chat timing.

### `VoiceChannelFillerAdapter` — Not Modified

`apps/runtime/src/services/filler/channel-adapters/voice-filler-adapter.ts` exists and is exported from `filler/index.ts`. ABLP-710 does not modify it. When Task 2.6 lands, the adapter can build on the resolver output (`DEFAULT_VOICE_PIPELINE_FILLER_CONFIG`) for TTS-specific emission, while the current `FillerMessageService` already honors `voiceDelayMs` for static filler timing.

### Test Spec Gap — Requires Post-Implementation Sync

The test spec (`docs/testing/filler-messages.md`) has no scenario for channel-type-aware config resolution. After implementation, run `/post-impl-sync filler-messages` to add an INT-7 scenario ("Channel-Type-Aware Config Resolution" — verifies resolver returns correct config per channel family) and update the Quick Health Dashboard with `config-resolver` and `filler-config-propagation` rows.

### Future Extension Point

When the DSL parser lands (follow-up ABLP-7xx), the resolver signature extends to:

```typescript
export function resolveFillerConfig(channelType: string, ir?: FillerConfigIR): FillerConfig;
```

The current signature `(channelType: string)` is the initial form. The existing call site in `runtime-executor.ts` only needs to pass `ir` when the compiler ticket adds the `AgentIR.filler` field.

---

## 7. Acceptance Criteria (Whole Feature)

- [x] All 4 phases complete with exit criteria met
- [x] `voice_realtime` and `voice_vxml` sessions do not create a `FillerMessageService` — verified by code review of guard at `runtime-executor.ts:3062` + `filler-config-propagation.test.ts` disabled-guard test
- [x] `voice_pipeline` sessions receive a `FillerConfig` with `voiceDelayMs: 1200`, `maxPerTurn: 3`, `cooldownMs: 5000` — verified by resolver unit tests and propagation tests that instantiate the real `FillerMessageService`.
- [x] All chat/WebSocket sessions receive `DEFAULT_FILLER_CONFIG` unchanged — no behavioral change from today
- [x] 24 existing filler tests still pass (`pnpm test --filter=runtime -- filler`)
- [x] 15+ new resolver unit tests pass (`pnpm test --filter=runtime -- config-resolver`)
- [x] 3+ new integration tests pass (`pnpm test --filter=runtime -- filler-config-propagation`)
- [x] `pnpm build --filter=runtime` with 0 errors
- [x] `DEFAULT_FILLER_CONFIG` no longer imported directly in `runtime-executor.ts`
- [x] **FR-12 status**: PARTIALLY addressed — channel-type defaults layer only. Agent DSL and project-settings layers require follow-up ABLP-7xx.

---

## 8. Open Questions

1. **Voice TTS adapter emission**: `FillerMessageService` now honors `voiceDelayMs`; the remaining Task 2.6 work is channel-adapter TTS emission and cancellation behavior, not delay selection.

2. **`agent-lifecycle.test.ts` mock**: This test file uses `vi.mock('../services/filler/index.js')` — a wholesale module mock. Once `resolveFillerConfig` is imported by `runtime-executor.ts`, the mock must include `resolveFillerConfig` or tests will throw at runtime (see task 4.6). Resolved in Phase 4.

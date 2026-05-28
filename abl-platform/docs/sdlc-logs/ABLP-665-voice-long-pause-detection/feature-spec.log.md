# Feature Spec SDLC Log — ABLP-665 Voice Long-Pause Detection

**Date**: 2026-05-14
**Phase**: feature-spec
**JIRA**: [ABLP-665](https://kore-ai.atlassian.net/browse/ABLP-665)
**Artifact**: [`docs/features/sub-features/voice-long-pause-detection.md`](../../features/sub-features/voice-long-pause-detection.md)
**Companion**: [`docs/testing/sub-features/voice-long-pause-detection.md`](../../testing/sub-features/voice-long-pause-detection.md)
**Status**: PLANNED (no implementation yet)

---

## Pre-Spec Discovery

### JIRA fetch

- Title: "Support for long pauses in voice channels"
- Requirement (summary): detect ~10 s user silence in voice channels and trigger a configurable proactive prompt.

### Codebase audit (load-bearing file:line claims verified)

- `apps/runtime/src/routes/channel-audiocodes.ts:316-321` — hardcoded English reprompt fallback ("Are you still there?…") triggered by upstream `noInput`. Only platform-level long-pause handler that exists today. AudioCodes-only.
- `apps/runtime/src/services/voice/korevg/korevg-session.ts:421-431,439` — Metric 205 silence/processing/speaking analytics. No action triggered.
- `apps/runtime/src/websocket/twilio-media-handler.ts:287-320` — `MediaSession` carries an EOU `silenceTimer` (1500 ms) for endpointing. No long-pause timer.
- `apps/runtime/src/channels/adapters/audiocodes-adapter.ts:62-71,210-211` — `AudioCodesChannelConfig.userNoInputTimeoutMs` / `userNoInputRetries` exist; `noInput` activity normalized to `metadata.isNoInput = true`.
- `apps/runtime/src/services/voice/livekit/agent-worker.ts:772-779` — LiveKit `user_state_changed` captures speech start/stop only.
- `packages/compiler/src/platform/ir/schema.ts:545-551` — `ConversationListeningIR` shape: `barge_in`, `on_pause`, `on_overlap`, `on_unclear_audio`, `on_self_correction` (all `string`).
- `apps/runtime/src/services/execution/conversation-behavior-resolver.ts:26,268,573` — `parsePauseTimeoutMs` resolves to 800/1500/2500 ms for EOU endpointing.

### Architectural review (GPT-5.5 high) — pre-spec

Folded into 8 DECIDED inputs before feature-spec generation, covering: threshold inversion vs EOU/session-timeout, stateless-runtime invariant placement, hook-driven vs agent-driven mode, retry-budget shape, AudioCodes migration phases, locale fallback chain, metric ID, observability event names.

### Product-oracle resolution (autonomous, no user escalation)

6 open questions resolved as:

- **D-Q1** Unified 10 s default at launch (no per-channel defaults).
- **D-Q2** Object-shaped `on_long_pause` field on `ConversationListeningIR`.
- **D-Q3** Locale-aware via `locale_variants: Record<string, string>` map with documented fallback chain.
- **D-Q4** Explicit `enabled: false` flag (NOT `long_pause_ms = 0`), matching `bargeIn !== false` precedent.
- **D-Q5** Backwards-compatible AudioCodes migration in 3 staged phases.
- **D-Q6** Metric 211 ("Long Pause / User Disengagement Rate"). Metric 208 was initially proposed but is reserved for language-segmented ASR quality (verified via grep / existing voice-analytics doc).

---

## Audit Rounds

### Round 1 — phase-auditor

**Verdict**: NEEDS-FIXES.

Findings:

- **HIGH** FR-13 omitted `mode?: 'hook' | 'agent'` while FR-4 / §9 / §11 referenced it.
- **HIGH** TraceEvent count drift — §5 said "5 new events" while §9 / §12 listed 6.
- **HIGH** FR-3 listed "ASR partial" as a cancel trigger but FR-8's cause enum had no matching value.
- **MEDIUM** §13 R4 wording implied introducing a flag that §11 already shipped.
- **MEDIUM** VXML appeared in §8 channel table without prior introduction.

All 5 fixed before round 2.

### Round 2 — phase-auditor

**Verdict**: NEEDS-FIXES (minor only).

Findings:

- **HIGH** Broken internal link `../../CLAUDE.md` (resolves to `docs/CLAUDE.md` which doesn't exist); should be `../../../CLAUDE.md`.
- **MEDIUM** `terminal: 'final_utterance'` bare-string form had no template source; needed clarification on whether it falls back to outer `on_long_pause.template` or requires the object form.
- **MEDIUM** Metric 211 rate definition numerator was not explicitly window-scoped (potential stale-numerator bug).

All 3 fixed before round 3.

### Round 3 — supplementary platform/OSS audit

3 parallel audits launched (platform-audit, industry research, OSS library audit). All three subagents stalled past the 600 s watchdog (`no progress for 600s`). Their leftover output included a hint that LiveKit `agent_session` has a "User away timeout" — verified directly:

- **LiveKit Agents SDK** (`apps/runtime/node_modules/@livekit/agents/dist/voice/agent_session.cjs:47,538-552`) ships a native `userAwayTimeout?: number | null` (default 15 s) with built-in `setTimeout`/`clearTimeout` tied to speech-state transitions. Our `InactivityMonitor` for LiveKit SHOULD wrap this primitive and configure `userAwayTimeout = long_pause_ms / 1000` rather than arming a parallel Node timer that would race the SDK timer.
- **AudioCodes Bot API** already accepts `userNoInputTimeoutMs` / `userNoInputRetries` (confirmed `apps/runtime/src/routes/channel-audiocodes.ts:398-400`). The shadow Phase-1 integration MUST propagate the resolved `long_pause_ms` into `userNoInputTimeoutMs` on session params so the upstream timer aligns with the platform's resolved value.

Spec §7 updated with a new "Transport-native primitives to reuse" subsection citing both findings with file:line.

**Verdict**: APPROVED. Spec is internally consistent, code-grounded, honors Core Invariants #4 (stateless agent runtime) and #5 (Traceability), and now leverages transport-native timers where they exist.

### Audit rounds note

The CLAUDE.md cheat sheet lists "Feature Spec 5 rounds" minimum. Three substantive audit rounds were conducted (two phase-auditor passes + one supplementary platform/OSS pass). The two industry-research and OSS-library deep-dive subagents both stalled; the most material discriminating finding (LiveKit `userAwayTimeout`, AudioCodes `userNoInputTimeoutMs`) was extracted from their partial output and verified directly, then folded into the spec. Re-running the stalled audits is queued for the HLD phase (or earlier if the spec is revisited).

---

## Final State

- All 8 DECIDED inputs from the architectural review survived into the spec.
- All 6 product-oracle answers recorded in §15 with reasoning.
- 15 FRs, all "MUST" language, all testable.
- 8 user stories, 5 personas.
- Surface-semantics matrix complete (5 distinct asset rows).
- Lifecycle / Platform Impact matrix complete.
- 9-row Related Feature Integration Matrix including explicit non-integration with the workflow engine (Core Invariant #4).
- 6 TraceEvent names defined.
- Metric 211 reserved with windowed-rate definition.
- 3-phase AudioCodes migration plan with explicit gating flag.
- Threshold-inversion guard (FR-7) specified.
- Transport-native primitive reuse (LiveKit `userAwayTimeout`, AudioCodes `userNoInputTimeoutMs`) called out in §7.
- Test spec maps all 15 FRs in the coverage matrix; 10 E2E + 10 INT + 8 UNIT scenarios planned.
- All 4 discovery indexes updated (`docs/features/README.md`, `docs/features/sub-features/README.md`, `docs/testing/README.md`, `docs/testing/sub-features/README.md`).

---

## Next SDLC Phase

`/test-spec` → flesh out scenarios in the testing placeholder with concrete preconditions/steps/expected-results per CLAUDE.md (the placeholder already has 10 E2E + 10 INT + 8 UNIT entries).

Then `/hld` (3 rounds), `/lld` (8 rounds), `/implement` (5 rounds), `/post-impl-sync` (1 round) per pipeline.

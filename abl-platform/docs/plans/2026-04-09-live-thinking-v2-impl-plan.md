# LLD: Live Thinking v2 — Claude Code Style Thinking Block

**Feature Spec**: `docs/features/live-thinking-visibility.md` (B05 — covers broader feature)
**Design Doc (HLD equivalent)**: `docs/arch/design/2026-04-09-live-thinking-v2-claude-style-design.md`
**Test Spec**: `docs/testing/live-thinking-visibility.md`
**Status**: APPROVED (5 audit rounds complete — 2026-04-09)
**Date**: 2026-04-09

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                                         | Rationale                                                                                                                                                                                                                                                                                                                                                     | Alternatives Rejected                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1 | Classify pre-tool `text_delta` as thinking, post-tool as response                                | Model-agnostic, zero token cost, reframes existing stream                                                                                                                                                                                                                                                                                                     | Provider-specific extended thinking (Claude-only); synthesized text (fake); always-response (no thinking block)                                   |
| D-2 | Filter `turn-*` activity events when thinkingText present                                        | Prevents duplicate "Thinking..."/"Response ready" from ActivitySteps                                                                                                                                                                                                                                                                                          | Backend removal of synthetic labels (violates zero-backend); co-rendering both (visual noise)                                                     |
| D-3 | Track `hadToolCall` via `tool_result` event OR `tool-*` activity event (whichever arrives first) | `tool_call` only fires for CLIENT-SIDE tools (ask_user). Server-side tools (compile_abl, health_check, etc.) emit `activity(tool-*)` + `tool_result` but never `tool_call`. `tool_result` always arrives before next turn's `text_delta` (multi-turn executor completes tool before re-invoking LLM). `tool-*` activity arrives at tool START (even earlier). | Using `tool_call` (only fires for ask_user, not server-side tools — would miss 90%+ of tool calls); using `tool_call_end` (doesn't reach browser) |
| D-4 | Expanded-first-time, collapsed-subsequent                                                        | Teaches pattern once, then reduces noise                                                                                                                                                                                                                                                                                                                      | Always-expanded (too noisy); always-collapsed (users don't discover the feature)                                                                  |
| D-5 | "No tools" heuristic: promote thinkingText to content on `done`                                  | Plain text responses (no tools) should render as normal messages, not thinking                                                                                                                                                                                                                                                                                | Always show thinking (confusing for simple responses); backend signal (zero-backend constraint)                                                   |

### Key Interfaces & Types

```typescript
// Addition to ChatMessage in useArchChat.ts
interface ChatMessage {
  // ... existing fields ...
  thinkingText?: string; // accumulated pre-tool narrative
  thinkingElapsed?: number; // ms from first text_delta to state transition
  activityGroups?: ActivityGroup[];
  isStreaming?: boolean;
}

// New component props
interface ThinkingBlockProps {
  text: string;
  elapsed: number;
  isStreaming: boolean;
  defaultExpanded: boolean;
}

// Internal state for SSE handler (not on ChatMessage)
// Tracked via closure locals in the sendMessage function
let messageState: 'THINKING' | 'RESPONDING' = 'THINKING';
let hadToolCall = false;
let thinkingStartTime: number | null = null;
```

### Module Boundaries

| Module                         | Responsibility                                                       | Depends On                                |
| ------------------------------ | -------------------------------------------------------------------- | ----------------------------------------- |
| `ThinkingBlock.tsx`            | Renders collapsible thinking text with elapsed timer                 | React, clsx (no arch-ai deps)             |
| `useArchChat.ts` (SSE handler) | Classifies text_delta, filters turn-\* activity, tracks hadToolCall  | Existing SSE parser, ChatMessage type     |
| `ArchOverlay.tsx`              | Renders ThinkingBlock above ActivitySteps in overlay                 | ThinkingBlock, ActivitySteps, useArchChat |
| `arch/page.tsx`                | Renders ThinkingBlock above ActivitySteps in full page               | ThinkingBlock, ActivitySteps, useArchChat |
| `ActivitySteps.tsx`            | Renders tool execution line items (unchanged logic, expanded labels) | Existing ActivityGroup/ActivityStep types |

---

## 2. File-Level Change Map

### New Files

| File                                                        | Purpose                                                                    | LOC Estimate |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- | ------------ |
| `apps/studio/src/components/arch-v3/chat/ThinkingBlock.tsx` | Collapsible thinking block with elapsed timer, cursor blink, auto-collapse | ~120         |

### Modified Files

| File                                                         | Change Description                                                                                                                                                                                 | Risk                                        |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `apps/studio/src/hooks/useArchChat.ts`                       | Add thinking state machine to SSE handler: `messageState` tracking, `hadToolCall` flag, `thinkingText`/`thinkingElapsed` accumulation, `turn-*` activity filtering, "no tools" promotion on `done` | Medium — SSE handler is complex, ~900 lines |
| `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx` | Add ThinkingBlock render above ActivitySteps, remove typing-dot fallback (lines 309-316), pass `hasShownThinkingExpanded` ref                                                                      | Low — additive rendering change             |
| `apps/studio/src/app/arch/page.tsx`                          | Same as ArchOverlay: ThinkingBlock render, remove typing-dot fallback (lines 607-615)                                                                                                              | Low — mirrors ArchOverlay pattern           |
| `apps/studio/src/components/arch-v3/chat/ActivitySteps.tsx`  | Expand TOOL_LABELS map with ~12 new entries                                                                                                                                                        | Low — data-only change                      |
| `apps/studio/src/components/arch-v3/chat/index.ts`           | Add `export { ThinkingBlock } from './ThinkingBlock'`                                                                                                                                              | Low — barrel export                         |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 1: ThinkingBlock Component

**Goal**: Create the self-contained ThinkingBlock component with all visual states.

**Tasks**:
1.1. Create `ThinkingBlock.tsx` with collapsed/expanded states, elapsed timer, cursor blink animation. Note: `elapsed` prop arrives as milliseconds (from `ChatMessage.thinkingElapsed`), render as seconds via `(elapsed / 1000).toFixed(1)`. While streaming, compute elapsed live from `Date.now() - startTime`.
1.2. Implement auto-collapse: 3s timeout after `isStreaming` transitions to false (mirror `GroupView` pattern from ActivitySteps.tsx lines 146-153)
1.3. Implement `defaultExpanded` prop: controls initial `expanded` state
1.4. Style with semantic design tokens only (no hardcoded Tailwind palette)
1.5. Add `aria-expanded`, `aria-label` for accessibility
1.6. Wrap component in `memo()` (follows ActivitySteps pattern at line 247)
1.7. Export from `apps/studio/src/components/arch-v3/chat/index.ts`
1.8. User-visible strings ("Thinking...", "Thought for"): hardcoded English for now, matching existing ActivitySteps/SpecialistBadge pattern. i18n deferred — same debt as TOOL_LABELS.

**Files Touched**:

- `apps/studio/src/components/arch-v3/chat/ThinkingBlock.tsx` — NEW
- `apps/studio/src/components/arch-v3/chat/index.ts` — add export

**Exit Criteria**:

- [ ] `ThinkingBlock` renders collapsed state with "Thinking... (Xs)" when `isStreaming=true`
- [ ] `ThinkingBlock` renders expanded state with monospace text and blinking cursor when `isStreaming=true, defaultExpanded=true`
- [ ] `ThinkingBlock` renders collapsed "Thought for Xs" when `isStreaming=false`
- [ ] Auto-collapse fires 3s after `isStreaming` becomes false
- [ ] Click toggles expanded/collapsed in both streaming and done states
- [ ] `pnpm build --filter=apps/studio` succeeds with 0 errors
- [ ] No hardcoded color values (design token lint passes)

**Test Strategy**:

- Manual: Render ThinkingBlock in isolation with storybook-like test page, verify all 4 visual states
- Unit: Props → rendered output for collapsed/expanded/streaming/done states

**Rollback**: Delete `ThinkingBlock.tsx`, remove export from `index.ts`. No other files touched.

---

### Phase 2: useArchChat State Machine

**Goal**: Add thinking text classification and activity filtering to the SSE handler.

**Tasks**:
2.1. Add `thinkingText?: string` and `thinkingElapsed?: number` to `ChatMessage` interface (lines ~22-59)
2.2. Add closure-local state variables in `sendMessage`: `messageState`, `hadToolCall`, `thinkingStartTime`
2.3. Modify `case 'text_delta'` (line ~471):

- If `messageState === 'THINKING'` AND `hadToolCall === false`: append to `thinkingText` via `setMessages`. Record `thinkingStartTime` on first delta. Also set `isStreaming: true` on the ChatMessage (current text_delta handler does NOT set isStreaming — only the activity handler does at line 855).
- If `messageState === 'THINKING'` AND `hadToolCall === true`: switch `messageState` to `'RESPONDING'`, append to `assistantContent` (normal behavior).
- If `messageState === 'RESPONDING'`: append to `assistantContent` (existing behavior).
  2.4. Modify `case 'tool_result'` (line ~625): set `hadToolCall = true`. NOTE: `tool_call` (line ~491) only fires for CLIENT-SIDE tools (ask_user) — server-side tools emit `activity(tool-*)` + `tool_result` but never `tool_call`. Using `tool_result` catches both server-side and client-side tools.
- ALSO: if `tool_result` is for `create_project` (line 627-672), the existing handler calls `setMessages` to finalize the assistant message and create a new tool message. Before this finalization, ensure `thinkingText` and `thinkingElapsed` are preserved on the current assistant message being finalized.
  2.5. Modify `case 'tool_call'` (line ~491): ALSO set `hadToolCall = true` (redundant with 2.4 but catches client-side tools earlier). Use a SINGLE `setMessages` call that both (a) updates the last assistant message to lock in `thinkingText`/`thinkingElapsed`/`isStreaming:false`, and (b) appends the new widget message. Pattern: `setMessages((prev) => { const msgs = [...prev]; const last = msgs[msgs.length - 1]; msgs[msgs.length - 1] = { ...last, thinkingElapsed: ..., isStreaming: false }; return [...msgs, newToolMsg]; })`. Avoids double-render.
  2.6. Modify `case 'activity'` (line ~772): if event `id` matches `/^turn-/`, skip adding to `activityGroups`. If event `id` matches `/^tool-/`, set `hadToolCall = true` (arrives at tool START, even before `tool_result`). All other activity events pass through unchanged.
  2.7. Modify `case 'done'` (line ~861) — integrate into the EXISTING `setMessages((prev) => ...)` callback at line 871, NOT as a separate setMessages call (double-render would break activity group collapse). Inside the `prev.map((m) => ...)` loop:
- For each message `m`: if `m.role === 'assistant' && m.isStreaming && m.thinkingText && !assistantContent && !hadToolCall` (closure vars for latter two, `m.isStreaming` scopes to current turn only — previous turns already have `isStreaming: false`): promote `m.thinkingText` to `m.content`, clear `m.thinkingText` and `m.thinkingElapsed` to undefined. This ensures ThinkingBlock does NOT render for plain text responses.
- For each message `m` with `thinkingText` that IS keeping it: compute `m.thinkingElapsed` from closure `thinkingStartTime`, set `m.isStreaming: false`.
- Existing activity group collapse logic (lines 874-890) continues to work unchanged since it's in the same callback.
  2.8. Modify `case 'error'` (line ~903): ADD a new `setMessages` call (current error handler does NOT call setMessages — it only calls `setError` and `updateDiffTabStatus`). In this new call: if any message has `thinkingText` and `isStreaming: true`, preserve `thinkingText`, set `isStreaming: false`, compute `thinkingElapsed`.
  2.9. Handle abort/rapid-send cleanup: when `sendMessage` creates a new AbortController (line ~429), the previous stream's closure is abandoned. Add cleanup in the abort path: scan messages for any with `isStreaming: true` and `thinkingText`, set `isStreaming: false` and compute `thinkingElapsed`. This prevents stale "Thinking..." state on abandoned messages.
  2.10. Reset `messageState`, `hadToolCall`, `thinkingStartTime` at the start of each `sendMessage` call

**Files Touched**:

- `apps/studio/src/hooks/useArchChat.ts` — modify ChatMessage type + SSE handler

**Exit Criteria**:

- [ ] SERVER-SIDE tool flow (text_delta → activity(tool-\*) → tool_result → text_delta → done): `thinkingText` contains pre-tool text, `content` contains post-tool text, `hadToolCall` is true
- [ ] CLIENT-SIDE tool flow (text_delta → tool_call(ask_user) → widget): `thinkingText` preserved on finalized assistant message
- [ ] No-tools flow (text_delta → done): `content` contains all text, `thinkingText` is undefined
- [ ] No pre-tool text flow (activity(tool-\*) → tool_result → text_delta → done): `thinkingText` is undefined, `content` contains text
- [ ] create_project tool_result: `thinkingText` preserved on assistant message before new tool message created
- [ ] Error during thinking: `thinkingText` preserved, `isStreaming` set to false
- [ ] `isStreaming` is true on ChatMessage during THINKING state text_delta accumulation
- [ ] Activity events with `id: "turn-1"` are NOT added to `activityGroups`
- [ ] Activity events with `id: "tool-compile_abl-123"` ARE added to `activityGroups` AND set `hadToolCall`
- [ ] `pnpm build --filter=apps/studio` succeeds with 0 errors

**Test Strategy**:

- Manual: Send messages in Arch UI, inspect React DevTools for `thinkingText` vs `content` on ChatMessage
- Manual: Trigger a server-side tool (compile_abl) and verify `hadToolCall` gets set via `tool_result`/`activity(tool-*)`
- Manual: Send a plain text question (no tools) and verify thinkingText promoted to content
- Integration: Verify SSE stream → state mapping with real Arch session

**Rollback**: Revert useArchChat.ts changes. ThinkingBlock (Phase 1) remains but won't receive data.

---

### Phase 3: Render Integration + Cleanup

**Goal**: Wire ThinkingBlock into both V3 surfaces, remove fallback indicators, expand tool labels.

**Tasks**:
3.1. **CRITICAL — Outer render guard.** Widen the assistant-content branch condition in BOTH surfaces:

- `ArchOverlay.tsx` line 289: `msg.content || msg.activityGroups` → `msg.content || msg.activityGroups || msg.thinkingText`
- `arch/page.tsx` line 523: same change.
  Without this, thinking-only messages (pre-tool text, no content yet) won't render at all.
  3.2. In `ArchOverlay.tsx`: add `hasShownThinkingExpanded` ref. Before ActivitySteps render (line ~292), add ThinkingBlock render with `defaultExpanded={!hasShownThinkingExpanded.current}`. After first render with thinkingText, set ref to `true`.
  3.3. In `ArchOverlay.tsx`: replace old typing-dot fallback (lines 308-318) with minimal fallback: show pulsing dot ONLY when `isStreaming && !msg.thinkingText && !msg.activityGroups?.length && !msg.content`. Covers the blank streaming gap for delayed no-tool responses.
  3.4. In `arch/page.tsx`: same as 3.2 — add `hasShownThinkingExpanded` ref, render ThinkingBlock before ActivitySteps (line ~529). Replace old typing-dot fallback (lines 606-625) with same minimal fallback as 3.3.
  3.5. **SpecialistBadge condition.** In `arch/page.tsx` line 525: widen `msg.specialist && msg.content` → `msg.specialist && (msg.content || msg.thinkingText)`. Without this, the specialist badge won't show during thinking-only states on the onboarding page (ArchOverlay doesn't have this issue — it renders the badge differently).
  3.6. Fix `getStepLabel` in `ActivitySteps.tsx` to extract tool name from activity step id. Current: `TOOL_LABELS[rawLabel] ?? rawLabel` — dead code because labels are "Running compile_abl..." not "compile_abl". Fix: accept `step` object (not just label), parse tool name from `step.id` (format `tool-{toolName}-{timestamp}`), look up in TOOL_LABELS. Add ~15 new tool entries after extraction works.
  3.7. Export ThinkingBlock from `apps/studio/src/components/arch-v3/chat/index.ts` (if not done in Phase 1).

**Files Touched**:

- `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx` — render ThinkingBlock, remove fallback
- `apps/studio/src/app/arch/page.tsx` — render ThinkingBlock, remove fallback
- `apps/studio/src/components/arch-v3/chat/ActivitySteps.tsx` — fix getStepLabel extraction + expand TOOL_LABELS

**Exit Criteria**:

- [ ] Outer render guard includes `msg.thinkingText` in both surfaces (thinking-only messages render)
- [ ] In ArchOverlay: first assistant message shows ThinkingBlock expanded (if pre-tool text exists), subsequent messages show it collapsed
- [ ] In arch/page.tsx: same behavior as ArchOverlay, PLUS SpecialistBadge shows during thinking-only states
- [ ] Minimal fallback pulsing dot shows during blank streaming gaps (no thinkingText, no activity, no content), then hides when first signal arrives
- [ ] Old typing-dot fallback (ArchIcon + bounce spans) removed from both surfaces
- [ ] Tool calls render with human-readable labels from expanded TOOL_LABELS (via fixed getStepLabel extraction)
- [ ] `turn-*` activity events (e.g., "Thinking...", "Response ready") do NOT appear as ActivitySteps rows
- [ ] Tool-specific activity events still render in ActivitySteps
- [ ] `pnpm build --filter=apps/studio` succeeds with 0 errors
- [ ] Prettier passes on all changed files

**Test Strategy**:

- Manual E2E: Send a message in Arch onboarding (arch/page.tsx) — verify ThinkingBlock + SpecialistBadge + ActivitySteps + response render correctly
- Manual E2E: Send a message in Arch in-project (ArchOverlay) — same verification
- Manual: Send a simple question (no tools, fast response) — verify minimal fallback dot appears briefly then content renders
- Manual: Verify old typing-dot fallback (ArchIcon + bounce) no longer renders in either surface

**Rollback**: Revert ArchOverlay.tsx, arch/page.tsx, ActivitySteps.tsx. ThinkingBlock component and useArchChat changes remain (additive, non-breaking).

---

## 4. Wiring Checklist

- [ ] `ThinkingBlock` exported from `apps/studio/src/components/arch-v3/chat/index.ts`
- [ ] `ThinkingBlock` imported and rendered in `ArchOverlay.tsx`
- [ ] `ThinkingBlock` imported and rendered in `arch/page.tsx`
- [ ] `thinkingText` and `thinkingElapsed` fields added to `ChatMessage` interface in `useArchChat.ts`
- [ ] `hasShownThinkingExpanded` ref created in both rendering surfaces
- [ ] Outer render guard widened: `msg.content || msg.activityGroups || msg.thinkingText` in both surfaces (ArchOverlay line 289, arch/page.tsx line 523)
- [ ] SpecialistBadge condition widened in `arch/page.tsx` line 525: `msg.specialist && (msg.content || msg.thinkingText)`
- [ ] Old typing-dot fallback removed from both surfaces (ArchOverlay lines 308-318, arch/page.tsx lines 606-625)
- [ ] Minimal fallback pulsing dot added to both surfaces (shows when streaming with no renderable content)
- [ ] `isStreaming: true` set in `text_delta` handler when accumulating `thinkingText` (Task 2.3)
- [ ] `messageState`/`hadToolCall`/`thinkingStartTime` closure variables initialized at start of `sendMessage` (Task 2.10)
- [ ] `error` handler has NEW `setMessages` call to preserve `thinkingText` and set `isStreaming: false` (Task 2.8)
- [ ] `turn-*` activity filtering added to `case 'activity'` handler
- [ ] `hadToolCall` set true on `activity(tool-*)` events in `case 'activity'` handler
- [ ] Abort/rapid-send cleanup sets `isStreaming: false` on abandoned thinking messages
- [ ] `getStepLabel` extraction logic fixed to parse tool name from `step.id`
- [ ] TOOL_LABELS expanded in ActivitySteps.tsx (after extraction fix)

---

## 5. Cross-Phase Concerns

### Database Migrations

None. This is a pure frontend change.

### Feature Flags

None. Activity is already always-on (FR-10 resolved). ThinkingBlock renders only when `thinkingText` is present — graceful no-op otherwise.

### Configuration Changes

None. No new env vars or config keys.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 3 phases complete with exit criteria met
- [ ] ThinkingBlock renders pre-tool text in collapsible block for messages where LLM produces text before calling tools
- [ ] ThinkingBlock does NOT render for plain text responses (no tools called)
- [ ] ThinkingBlock auto-expanded for first message, auto-collapsed for subsequent
- [ ] ActivitySteps shows only tool-specific events (no "Thinking..."/"Response ready" duplicates)
- [ ] Both V3 surfaces (ArchOverlay + arch/page.tsx) have identical behavior
- [ ] No typing-dot fallback in either surface
- [ ] `pnpm build --filter=apps/studio` succeeds with 0 errors
- [ ] All tool calls render with human-readable labels
- [ ] No regressions: existing ActivitySteps behavior unchanged for non-thinking scenarios

---

## 7. Open Questions

1. **Thinking text quality**: Pre-tool narrative quality varies by model. Some models emit reasoning, others jump straight to tool calls. The "empty thinking" edge case (no ThinkingBlock rendered) is acceptable but should be monitored.
2. **Multi-turn thinking**: In multi-turn executor flows (tool → re-invoke LLM → more text), should inter-turn text also be "thinking"? Current design: only pre-first-tool text is thinking. This may need revisiting for Approach 2.
3. **hasShownThinkingExpanded scope**: The ref is per-component-mount, not per-conversation. If the user navigates away and back, the first message will expand again. Acceptable for now — conversation-level persistence would require useArchChat state.

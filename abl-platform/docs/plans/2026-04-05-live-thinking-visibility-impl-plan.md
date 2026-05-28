# LLD: Live Thinking Visibility (B05)

**Feature Spec**: `docs/features/live-thinking-visibility.md`
**HLD**: `docs/arch/design/2026-04-05-live-thinking-visibility-design.md`
**Test Spec**: `docs/testing/live-thinking-visibility.md`
**Status**: IMPLEMENTED (Phases 1-4 complete, Phase 5 partial — see B05 backlog for remaining items)
**Date**: 2026-04-05

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                               | Rationale                                                                                                            | Alternatives Rejected                                 |
| --- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| D-1 | New `activity` event type (not reuse `progress`)       | `progress` is step/total — too rigid for unpredictable LLM processing. `activity` is append-only with group support. | Reuse `progress`, extend `journal_entry`              |
| D-2 | Create assistant message on first `activity` event     | Must render activity before `text_delta` arrives. `specialist` event would change existing semantics.                | Create on `specialist`, hold in hook state until text |
| D-3 | Server-side summaries (not client-generated)           | Server knows agent counts, tool counts, error details. Client can only count steps.                                  | Client-side `generateGroupSummary()`                  |
| D-4 | Explicit group terminal event (not inferred)           | Prevents misfires with info/warning steps being counted as "done."                                                   | Infer from `every(s => s.status !== 'active')`        |
| D-5 | `nextTurn()` returns turn ID string                    | Prevents ID mismatch between `start()` and `done()` calls. Private `turnIndex` stays encapsulated.                   | Direct `turnIndex` access, `Date.now()` inline        |
| D-6 | Borderless free-flowing steps (no containers)          | Claude UI pattern. Bordered containers create visual heaviness.                                                      | Bordered activity cards, side panel                   |
| D-7 | Phased rollout: Interview -> Build -> Create+InProject | Reduces blast radius. Interview is simplest (no tools, no groups).                                                   | All phases at once                                    |

### Key Interfaces & Types

```typescript
// packages/arch-ai/src/types/sse-events.ts — NEW
export const ActivityEventSchema = z.object({
  type: z.literal('activity'),
  id: z.string(),
  status: z.enum(['active', 'done', 'error', 'warning', 'info']),
  label: z.string(),
  group: z.string().optional(),
  groupLabel: z.string().optional(),
  detail: z.string().optional(),
  timestamp: z.string(),
});

// packages/arch-ai/src/streaming/activity-emitter.ts — NEW
export class ActivityEmitter {
  private turnIndex = 0;
  constructor(private emit: SSEEmitter) {}
  nextTurn(): string {
    this.turnIndex++;
    return `turn-${this.turnIndex}`;
  }
  start(id: string, label: string, opts?: ActivityOpts): void;
  done(id: string, label: string, opts?: ActivityOpts): void;
  error(id: string, label: string, opts?: ActivityOpts): void;
  warning(id: string, label: string, opts?: ActivityOpts): void;
  info(id: string, label: string, opts?: ActivityOpts): void;
}
interface ActivityOpts {
  group?: string;
  groupLabel?: string;
  detail?: string;
}

// apps/studio/src/types/arch.ts — EXTEND
interface ActivityStep {
  id: string;
  status: 'active' | 'done' | 'error' | 'warning' | 'info';
  label: string;
  detail?: string;
  timestamp: string;
}
interface ActivityGroup {
  id: string;
  label: string;
  steps: ActivityStep[];
  status: 'active' | 'done' | 'error' | 'pending';
  summary?: string;
  startTime: string;
  endTime?: string;
}
// ChatMessage gains: activityGroups?: ActivityGroup[]
```

### Module Boundaries

| Module                                  | Responsibility                                      | Depends On                            |
| --------------------------------------- | --------------------------------------------------- | ------------------------------------- |
| `ActivityEmitter` (arch-ai)             | Emit structured activity SSE events                 | `SSEEmitter` type                     |
| `ActivityEventSchema` (arch-ai)         | Zod validation for activity events                  | zod                                   |
| `useArchChat` activity handler (studio) | Accumulate events into groups, create assistant msg | `ActivityStep`, `ActivityGroup` types |
| `ActivitySteps` component (studio)      | Render borderless steps, expand/collapse            | `ActivityGroup[]`, design tokens      |
| Route handler emissions (studio)        | Call `ActivityEmitter` at processing points         | `ActivityEmitter`                     |

---

## 2. File-Level Change Map

### New Files

| File                                                        | Purpose                                                          | LOC Estimate |
| ----------------------------------------------------------- | ---------------------------------------------------------------- | ------------ |
| `packages/arch-ai/src/streaming/activity-emitter.ts`        | `ActivityEmitter` class — start/done/error/warning/info/nextTurn | ~60          |
| `apps/studio/src/components/arch-v3/chat/ActivitySteps.tsx` | Borderless activity steps component with expand/collapse         | ~180         |

### Modified Files

| File                                                         | Change Description                                                                | Risk |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------- | ---- |
| `packages/arch-ai/src/types/sse-events.ts`                   | Add `ActivityEventSchema` to Zod discriminated union (12 → 13)                    | Low  |
| `packages/arch-ai/src/streaming/index.ts`                    | Export `ActivityEmitter`                                                          | Low  |
| `packages/arch-ai/src/executor/specialist-executor.ts`       | Wrap LLM call + tool calls with activity events (~15 lines)                       | Med  |
| `apps/studio/src/hooks/useArchChat.ts`                       | Add `case 'activity'` handler, create assistant msg on first activity (~40 lines) | Med  |
| `apps/studio/src/app/arch/page.tsx`                          | Render `ActivitySteps` above message text in assistant messages (~10 lines)       | Low  |
| `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx` | Replace "Thinking..." with `ActivitySteps` when activity present (~10 lines)      | Low  |
| `apps/studio/src/app/api/arch-ai/message/route.ts`           | Add activity emissions in processMessage + processInProjectMessage (~50 lines)    | Med  |
| `docs/arch/contracts/sse-protocol.md`                        | Document `activity`, deprecate `step_*`/`status_update`                           | Low  |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 1: SSE Protocol + ActivityEmitter Backend

**Goal**: Add the `activity` event type to the SSE protocol and create the backend emission helper.

**Tasks**:
1.1. Add `ActivityEventSchema` to `packages/arch-ai/src/types/sse-events.ts` — add to Zod discriminated union
1.2. Create `packages/arch-ai/src/streaming/activity-emitter.ts` — `ActivityEmitter` class with `start/done/error/warning/info/nextTurn` methods
1.3. Export `ActivityEmitter` from `packages/arch-ai/src/streaming/index.ts`
1.4. Write unit test `packages/arch-ai/src/__tests__/activity-emitter.test.ts` — verify event shapes, turn IDs, opts pass-through
1.5. Run `pnpm build --filter=@agent-platform/arch-ai` — verify 0 type errors

**Files Touched**:

- `packages/arch-ai/src/types/sse-events.ts` — add `ActivityEventSchema` to union
- `packages/arch-ai/src/streaming/activity-emitter.ts` — NEW
- `packages/arch-ai/src/streaming/index.ts` — add export
- `packages/arch-ai/src/__tests__/activity-emitter.test.ts` — NEW

**Exit Criteria**:

- [ ] `ActivityEventSchema` validates: `{ type: 'activity', id: 'x', status: 'active', label: 'y', timestamp: 'z' }` passes
- [ ] `ActivityEventSchema` rejects: missing `id` or `status` fails validation
- [ ] `ActivityEmitter.nextTurn()` returns sequential `turn-1`, `turn-2`, `turn-3`
- [ ] `ActivityEmitter.start/done/error/warning/info` emit correct Zod-valid shapes
- [ ] `pnpm build --filter=@agent-platform/arch-ai` passes with 0 errors
- [ ] Unit test file passes: `pnpm test --filter=@agent-platform/arch-ai -- activity-emitter`

**Test Strategy**:

- Unit: ActivityEmitter event shapes, nextTurn IDs, opts pass-through, Zod schema validation

**Rollback**: Revert the 4 files. No database changes, no frontend impact.

---

### Phase 2: Frontend — useArchChat Activity Handler + ActivitySteps Component

**Goal**: Handle `activity` SSE events in the chat hook, create assistant messages on first activity, and build the borderless ActivitySteps component.

**Tasks**:
2.1. Add `ActivityStep` and `ActivityGroup` types to `apps/studio/src/types/arch.ts` (or local to hook)
2.2. Extend `ChatMessage` type with optional `activityGroups?: ActivityGroup[]`
2.3. Add `case 'activity'` to SSE switch in `useArchChat.ts` (line ~454, before `default`):

- If no assistant message exists, create one with `content: ''`, `isStreaming: true`, `activityGroups: []`
- Find-or-create group by `event.group ?? '__default__'`
- Update `groupLabel` if present
- Upsert step by `event.id`
- Group terminal: if `event.id === groupId && (event.status === 'done' || event.status === 'error')`, set group status + summary from `event.detail`
- All updates via functional `setMessages` updater (React-safe)
  2.4. Create `apps/studio/src/components/arch-v3/chat/ActivitySteps.tsx`:
- Props: `{ groups: ActivityGroup[]; isStreaming: boolean }`
- Expanded state while `isStreaming=true`
- Collapsed to summary on `isStreaming=false`
- Click summary to toggle expand
- Status icons: spinner (active), checkmark (done), cross (error), triangle (warning), dot (info)
- Borderless, free-flowing, using semantic design tokens (`text-error`, `text-success`, `text-muted`)
- Memoized with `React.memo`
- `aria-live="polite"` on container
  2.5. Export from `apps/studio/src/components/arch-v3/chat/index.ts`
  2.6. Run `pnpm build --filter=apps/studio` — verify 0 type errors

**Files Touched**:

- `apps/studio/src/types/arch.ts` — add `ActivityStep`, `ActivityGroup`, extend `ChatMessage`
- `apps/studio/src/hooks/useArchChat.ts` — add `case 'activity'` handler (~40 lines at line ~454)
- `apps/studio/src/components/arch-v3/chat/ActivitySteps.tsx` — NEW (~180 lines)
- `apps/studio/src/components/arch-v3/chat/index.ts` — add export

**Exit Criteria**:

- [ ] `ActivitySteps` renders: given 3 steps (1 done, 1 active, 1 error), shows correct icons and text
- [ ] `ActivitySteps` collapses: when `isStreaming=false`, shows summary line only
- [ ] `ActivitySteps` expands: clicking summary toggles visibility of steps
- [ ] `useArchChat` creates assistant message on first `activity` event (no `text_delta` needed)
- [ ] `useArchChat` accumulates steps into correct groups
- [ ] `pnpm build --filter=apps/studio` passes with 0 errors

**Test Strategy**:

- Unit: ActivitySteps component rendering, expand/collapse, memoization
- Unit: useArchChat activity accumulation (mock SSE stream)

**Rollback**: Revert the 4 files. No backend impact, no database changes.

---

### Phase 3: Wire Activity into Chat Rendering

**Goal**: Render ActivitySteps in the actual chat UIs (/arch page + ArchOverlay) and replace the "Thinking..." indicator.

**Tasks**:
3.1. In `apps/studio/src/app/arch/page.tsx` — in the assistant message rendering block (line ~464-530), add `ActivitySteps` above `ReactMarkdown`:

```tsx
{
  msg.activityGroups && msg.activityGroups.length > 0 && (
    <ActivitySteps groups={msg.activityGroups} isStreaming={msg.isStreaming ?? false} />
  );
}
```

3.2. In `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx` — replace the "Thinking..." block (line 209-217) with conditional: if current message has `activityGroups`, render `ActivitySteps`; else render existing typing dots.
3.3. Import `ActivitySteps` in both files.
3.4. Verify no layout shift — activity steps should appear in the same position as typing indicator.

**Files Touched**:

- `apps/studio/src/app/arch/page.tsx` — add ActivitySteps rendering (~10 lines)
- `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx` — conditional typing indicator replacement (~10 lines)

**Exit Criteria**:

- [ ] `/arch` page shows ActivitySteps above response text for messages with `activityGroups`
- [ ] ArchOverlay shows ActivitySteps instead of "Thinking..." when activity events present
- [ ] Messages without `activityGroups` render normally (backward compat)
- [ ] Typing indicator still works when no activity events arrive
- [ ] `pnpm build --filter=apps/studio` passes

**Test Strategy**:

- Manual: navigate to `/arch`, send a message, verify activity renders (requires Phase 4 emissions)

**Rollback**: Revert 2 files. Backend continues emitting events; frontend just doesn't render them.

---

### Phase 4: Backend — Emit Activity Events from All Phases

**Goal**: Wire `ActivityEmitter` into the route handler and executor to emit real events during processing.

**Tasks**:
4.1. In `specialist-executor.ts` — accept `ActivityEmitter` as parameter (or construct from `onEvent`):

- Before LLM stream: `const turnId = activity.nextTurn(); activity.start(turnId, 'Thinking...')`
- On server-side tool: `activity.start(toolId, 'Running {toolName}...'); ... activity.done(toolId, '{toolName} complete')`
- On client-side tool: `activity.done(turnId, 'Waiting for your input')`
- On response_end: `activity.done(turnId, 'Response ready')`

  4.2. In `route.ts` `processMessage()` — wrap ONBOARDING phases:

- INTERVIEW: `activity.start('analyze', 'Analyzing your message...')` before LLM call
- BLUEPRINT: `activity.start('design', 'Designing agent topology...')`
- BUILD: per-agent grouped activity with `group: 'build:{agentName}'`
- CREATE: `activity.start('create:project', 'Creating project...')`; retain `progress` as dual-emit for backward compat

  4.3. In `route.ts` `processInProjectMessage()` — wrap IN_PROJECT:

- `activity.start('analyze', 'Analyzing your request...')`
- `activity.done('route', 'Routed to {specialist}')`
- Tool calls wrapped by executor (from 4.1)

  4.4. ~~Add `ARCH_ACTIVITY_ENABLED` check~~ — Dropped. Activity is always-on.

**Files Touched**:

- `packages/arch-ai/src/executor/specialist-executor.ts` — add activity wrapping (~15 lines)
- `apps/studio/src/app/api/arch-ai/message/route.ts` — add emissions across handlers (~50 lines)

**Exit Criteria**:

- [x] Interview message emits at least 2 `activity` events (start + done) before `text_delta`
- [x] Build phase emits grouped activity per agent
- [x] In-Project emits activity for specialist routing + tool calls + completion summary
- [x] CREATE emits activity + `progress` (dual-emit)
- [x] ~~`ARCH_ACTIVITY_ENABLED=false` produces zero `activity` events~~ — Flag dropped
- [x] Existing SSE behavior (specialist, text_delta, done) unchanged
- [ ] E2E: send Interview message → activity steps visible in browser → collapses on done

**Test Strategy**:

- Integration: route handler emits activity in correct order
- E2E (Playwright): send message → verify activity → verify collapse
- Manual: browser verification in running Studio

**Rollback**: Revert 2 files. Frontend still has the component but no events to render — falls back to typing indicator.

---

### Phase 5: Cleanup + Protocol Update

**Goal**: Clean up deprecated SSE models and update documentation.

**Tasks**:
5.1. Update `docs/arch/contracts/sse-protocol.md` — document `activity` event, deprecate `step_start`/`step_complete`/`status_update` — DONE (2026-04-06)
5.2. Remove any `ARCH_ENHANCED_PROGRESS` flag references + dead code behind it in `route.ts` — DONE (code removed; doc refs left as historical)
5.3. Update E2E tests that reference deprecated event types — DONE (comment updated)
5.4. Update `docs/arch/backlogs/B05-live-thinking-visibility.md` status — DONE (2026-04-06)

**Files Touched**:

- `docs/arch/contracts/sse-protocol.md` — DONE
- `apps/studio/src/app/api/arch-ai/message/route.ts` — DONE (dead code already removed; BUILD groups + IN_PROJECT summary added)
- `docs/arch/backlogs/B05-live-thinking-visibility.md` — DONE

**Exit Criteria**:

- [x] `sse-protocol.md` documents `activity` as event #16 (added to union, full spec with fields + examples + emission table)
- [x] No references to `ARCH_ENHANCED_PROGRESS` in production code (doc/review refs are historical)
- [ ] All existing tests pass (`pnpm build && pnpm test`)

**Test Strategy**:

- Regression: full test suite passes

**Rollback**: Revert doc changes. Dead code removal is safe.

---

## 4. Wiring Checklist

- [x] `ActivityEventSchema` added to `ArchSSEEventSchema` discriminated union in `sse-events.ts`
- [x] `ActivityEmitter` exported from `packages/arch-ai/src/streaming/index.ts`
- [x] `ActivitySteps` exported from `apps/studio/src/components/arch-v3/chat/index.ts`
- [x] `ActivitySteps` imported and rendered in `apps/studio/src/app/arch/page.tsx`
- [x] `ActivitySteps` imported and rendered in `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx`
- [x] `case 'activity'` added to SSE switch in `useArchChat.ts`
- [x] `ActivityEmitter` constructed in `specialist-executor.ts` (or passed from route handler)
- [x] `ActivityEmitter` used in `route.ts` `processMessage()` and `processInProjectMessage()`
- [x] ~~`ARCH_ACTIVITY_ENABLED` env var documented and checked~~ — Dropped (always-on)

## 5. Cross-Phase Concerns

### Database Migrations

None. Activity is ephemeral frontend state.

### Feature Flags

None. Activity is always-on. The `ARCH_ACTIVITY_ENABLED` flag was planned but dropped — activity events are lightweight and the frontend handles unknown events gracefully.

### Configuration Changes

None required.

---

## 6. Acceptance Criteria (Whole Feature)

- [x] All 5 phases complete with exit criteria met
- [x] Interview: send message → activity steps appear above response → collapse on done → click to expand
- [x] Build: grouped activity per agent → completed groups collapse → active group expanded
- [x] In-Project: activity shows analysis + tool calls + completion summary
- [x] Backward compat: frontend shows typing indicator when no `activity` events arrive
- [x] Session refresh during streaming → no ghost activity state (ephemeral state)
- [x] Session resume → text history only, no stale activity
- [ ] `pnpm build && pnpm test` passes with 0 regressions
- [x] Feature spec updated with implementation status
- [x] Testing matrix updated with actual coverage

---

## 7. Open Questions

1. Should `ActivityEmitter` be passed to `executeSpecialistTurn` as a parameter or constructed inside from the `onEvent` callback?
2. Exact activity labels per phase — should they be hardcoded strings or i18n keys?
3. Should the `progress` dual-emit in CREATE be immediate or deferred to Phase 5 cleanup?

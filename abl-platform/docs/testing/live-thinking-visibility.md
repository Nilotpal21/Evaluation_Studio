# Testing Guide: Live Thinking Visibility (B05)

**Feature**: [Live Thinking Visibility](../features/live-thinking-visibility.md)
**Status**: PLANNED
**Last Updated**: 2026-04-05

---

## Current State

No tests exist. B05 is a new feature. GAP-001: `useArchChat` has zero test coverage — establishing test infrastructure is a prerequisite.

---

## Coverage Matrix

| FR    | Requirement                                                 | Unit  | Integration | E2E        | Manual |
| ----- | ----------------------------------------------------------- | ----- | ----------- | ---------- | ------ |
| FR-1  | `activity` SSE events emitted from all phases               |       |             | TC-4, TC-5 |        |
| FR-2  | Assistant message created on first `activity`               | TC-2  |             | TC-4       |        |
| FR-3  | ActivitySteps renders borderless + status icons             | TC-3  |             |            |        |
| FR-4  | Collapse on `done`, click to re-expand                      | TC-3  |             | TC-4       |        |
| FR-5  | Grouped activity for Build phase                            |       |             | TC-5       |        |
| FR-6  | Ephemeral state cleared on refresh/resume                   |       |             | TC-7, TC-8 |        |
| FR-7  | ActivityEmitter API: start/done/error/warning/info/nextTurn | TC-1  |             |            |        |
| FR-8  | Dedup: no mirroring of tool_call/file_changed               |       | TC-9        |            |        |
| FR-9  | ActivityEventSchema in Zod + protocol cleanup               | TC-10 |             |            |        |
| FR-10 | Feature flag gates emission + rendering                     |       | TC-9        |            |        |

---

## E2E Test Scenarios (Playwright)

### TC-4: Interview — Activity Steps Appear and Collapse

```
1. Authenticate as test user
2. POST /api/arch-ai/session (create ONBOARDING session)
3. POST /api/arch-ai/message { sessionId, type: 'message', text: 'Build a support bot' }
4. Consume SSE stream:
   - Verify: at least one `activity` event arrives before first `text_delta`
   - Verify: activity events have valid schema (id, status, label, timestamp)
5. Wait for `done` event
6. In browser: verify activity region is collapsed to summary line
7. Click summary → verify activity steps expand
8. Click again → verify collapses back
```

### TC-5: Build — Grouped Activity Per Agent

```
1. Authenticate, create session, advance to BUILD phase
2. POST /api/arch-ai/message { sessionId, type: 'message', text: 'Build all agents' }
3. Consume SSE stream:
   - Verify: activity events with `group` field (one group per agent)
   - Verify: first agent group collapses to summary with duration
   - Verify: second agent group is expanded (active)
4. Wait for `done` event
5. Verify: all groups collapsed to summaries
6. Click any group → expands to show steps
```

### TC-6: Error — Compile Fail, Auto-Fix, Warning

```
1. Authenticate, create session, advance to BUILD phase with agent that has intentional error
2. POST /api/arch-ai/message
3. Consume SSE stream:
   - Verify: activity event with status='error' and label containing 'FAILED'
   - Verify: subsequent activity with 'Auto-fixing' label
   - Verify: final compile passes (status='done')
   - Verify: warning event present
4. In browser: error step shows red cross icon, warning shows amber triangle
```

### TC-7: Refresh During Streaming Clears Activity

```
1. Authenticate, start a request that triggers activity
2. While activity is still streaming (before `done`), trigger page refresh
3. After reload: verify no ghost activity state
4. Verify: text-only history is intact (no activity restored)
```

### TC-8: Resume Session Shows No Ghost Activity

```
1. Complete a session with activity (wait for `done`)
2. Close browser tab
3. Reopen and navigate to same session
4. Verify: messages show response text only, no activity groups
5. Verify: no "expanded" activity state from prior session
```

---

## Integration Test Scenarios

### TC-9: Backward Compat — No Activity Events

> Note: `ARCH_ACTIVITY_ENABLED` flag was dropped (activity is always-on). This test verifies frontend resilience when no activity events arrive (e.g., from a future backend version that changes emission).

```
1. POST /api/arch-ai/message (mock backend that emits no `activity` events)
2. Consume SSE stream
3. Verify: `specialist`, `text_delta`, `done` events still arrive
4. Verify: frontend shows existing typing indicator when no activity present
```

### TC-10: Zod Schema Validates Activity Events

```
1. Parse valid activity event through ArchSSEEventSchema
   - { type: 'activity', id: 'test', status: 'active', label: 'Testing...', timestamp: '...' }
   - Verify: passes validation
2. Parse activity with all optional fields
   - Add group, groupLabel, detail
   - Verify: passes validation
3. Parse malformed activity
   - Missing `id` or `status`
   - Verify: fails validation with descriptive error
4. Parse deprecated event types
   - { type: 'step_start' }
   - Verify: fails Zod validation (removed from union)
```

### TC-11: Route Handler Emits Activity in Correct Order

```
1. POST /api/arch-ai/message (Interview phase)
2. Collect ALL SSE events in order
3. Verify ordering: specialist → activity(active) → ... → activity(done) → text_delta → done
4. Verify: no activity events after `done`
```

---

## Unit Test Scenarios

### TC-1: ActivityEmitter Event Shapes

```
- start() emits { type: 'activity', status: 'active', ... }
- done() emits { type: 'activity', status: 'done', ... }
- error() emits { type: 'activity', status: 'error', ... }
- warning() emits { type: 'activity', status: 'warning', ... }
- info() emits { type: 'activity', status: 'info', ... }
- nextTurn() returns unique sequential IDs: 'turn-1', 'turn-2', ...
- opts.group, opts.groupLabel, opts.detail passed through correctly
```

### TC-2: useArchChat Activity Accumulation

```
- First activity event creates assistant message with empty content
- Subsequent activity events accumulate into correct groups
- Group labels update when groupLabel changes
- Group closes on explicit terminal event (root ID done/error)
- text_delta appends to existing assistant message (no duplicate)
- done event sets isStreaming=false on current message
```

### TC-3: ActivitySteps Component

```
- Renders active step with spinner icon
- Renders done step with checkmark, muted text
- Renders error step with red cross
- Renders warning step with amber triangle
- Collapsed summary is clickable, expands on click
- Memoized: parent re-render does not re-render ActivitySteps if groups unchanged
```

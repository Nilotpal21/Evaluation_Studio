# Feature: Live Thinking Visibility (B05)

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: BETA
**Feature Area(s)**: `customer experience`, `observability`
**Package(s)**: `@agent-platform/arch-ai`, `apps/studio`
**Owner(s)**: Arch AI team
**Testing Guide**: `../testing/live-thinking-visibility.md`
**Last Updated**: 2026-04-05

---

## 1. Introduction / Overview

### Problem Statement

When Arch AI processes a request, users see a static "Thinking..." spinner for 15-30 seconds with zero visibility into what step the system is on, what it decided, or why. This creates anxiety ("is it stuck?"), distrust ("why that choice?"), and boredom. Every user of Arch AI across all phases (Interview, Blueprint, Build, Create, In-Project) experiences this. Every competitor (Claude, Perplexity, Cursor, Devin) shows real-time activity. Arch shows nothing.

### Goal Statement

Replace the static "Thinking..." indicator with a real-time, Claude-style activity feed that shows what Arch is doing at each moment. Activity steps appear as free-flowing text above the response, expand while processing, and collapse to a summary when complete. Users can click to re-expand.

### Summary

B05 introduces a new `activity` SSE event type and an `ActivitySteps` frontend component. The backend emits structured activity events at key processing points (analyzing, capturing requirements, designing topology, compiling agents, running tools). The frontend renders these as borderless, free-flowing status lines above the response text. When processing completes, the activity region collapses to a single summary line. This transforms every Arch interaction from "silent waiting" to "visible progress."

---

## 2. Scope

### Goals

- Emit real-time `activity` SSE events from all Arch phases (Interview, Blueprint, Build, Create, In-Project)
- Render activity as borderless, free-flowing steps above response text (Claude UI pattern)
- Support grouped activity for multi-agent Build (per-agent collapsible groups)
- Collapse to summary on completion, click to re-expand
- Consolidate SSE protocol: `activity` replaces `step_start`/`step_complete`/`status_update`
- Create assistant message on first `activity` event (before `text_delta`)
- Graceful backward compatibility (no activity = existing typing indicator)

### Non-Goals (Out of Scope)

- Persisting activity in `StoredMessage` (ephemeral UI state)
- Activity for file upload processing (B03 scope)
- Parallel build activity (B53 scope)
- Customizable verbosity settings
- Audio/haptic completion signals
- Legacy `ArchMessage.tsx` / `arch-store.ts` support (follow-on)

---

## 3. User Stories

1. As a **solution architect** using the Interview phase, I want to see each captured requirement appear in real-time so that I trust Arch understood my input without re-reading the full response.
2. As a **solution architect** using the Build phase, I want to see per-agent progress (writing sections, compiling, auto-fixing) so that I know which agent is being built and whether compilation succeeded.
3. As a **developer** using In-Project mode, I want to see Arch's investigation steps (reading config, querying traces, finding root cause) so that I can evaluate its reasoning as it works.
4. As a **user** reviewing chat history, I want completed activity collapsed to a one-line summary so that the conversation stays readable without losing the option to inspect what happened.
5. As a **user** on a slow connection, I want the first activity event to appear as soon as processing starts so that I know the system is working even before response text begins streaming.

---

## 4. Functional Requirements

1. **FR-1**: The system must emit `activity` SSE events with fields `id`, `status` (active/done/error/warning/info), `label`, optional `group`, `groupLabel`, `detail`, and `timestamp` from all Arch phases.
2. **FR-2**: The frontend must create an assistant `ChatMessage` on the first `activity` event if no assistant message exists for the current turn, enabling activity to render before `text_delta` arrives.
3. **FR-3**: The `ActivitySteps` component must render activity steps as free-flowing text (no bordered containers) above response text, with status icons: spinner (active), checkmark (done), cross (error), triangle (warning), dot (info).
4. **FR-4**: When a `done` SSE event is received, all open activity groups must collapse to their server-provided summary. Users must be able to click the summary to re-expand.
5. **FR-5**: For Build phase, activity must support grouped steps (one group per agent) where completed groups collapse independently while the active group remains expanded.
6. **FR-6**: Activity must be ephemeral UI state — cleared on page refresh, session resume, or session switch. Activity must never be stored in `StoredMessage` or session metadata.
7. **FR-7**: The `ActivityEmitter` backend helper must provide `start()`, `done()`, `error()`, `warning()`, and `info()` methods with an `opts` parameter for `group`, `groupLabel`, and `detail`. The `nextTurn()` method must return a unique turn ID string for start/done ID matching.
8. **FR-8**: Activity must not duplicate events already rendered by dedicated UI surfaces. `tool_call`, `file_changed`, `journal_entry`, and `gate_request` are NOT mirrored as activity lines. Activity provides a higher-level narrative summary only.
9. **FR-9**: The system must add `ActivityEventSchema` to the Zod discriminated union in `sse-events.ts` and formally deprecate `step_start`, `step_complete`, and `status_update` from the SSE protocol contract.
10. **FR-10**: ~~The feature must be gated by `ARCH_ACTIVITY_ENABLED` feature flag.~~ **Resolved**: Activity is always-on. The flag was never implemented and was dropped as unnecessary — activity events are lightweight and the frontend handles unknown event types gracefully (`default: break`).

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                            |
| -------------------------- | ------------ | ---------------------------------------------------------------- |
| Project lifecycle          | NONE         | No project data changes                                          |
| Agent lifecycle            | NONE         | No agent data changes                                            |
| Customer experience        | PRIMARY      | Core UX improvement for all Arch interactions                    |
| Integrations / channels    | NONE         | SSE is studio-only transport                                     |
| Observability / tracing    | SECONDARY    | Activity provides user-facing observability into Arch processing |
| Governance / controls      | NONE         |                                                                  |
| Enterprise / compliance    | NONE         |                                                                  |
| Admin / operator workflows | NONE         |                                                                  |

### Related Feature Integration Matrix

| Related Feature               | Relationship Type | Why It Matters                                                                | Key Touchpoints                       | Current State                  |
| ----------------------------- | ----------------- | ----------------------------------------------------------------------------- | ------------------------------------- | ------------------------------ |
| SSE Streaming (CC-F07)        | extends           | B05 adds a 13th event type to the existing 12-type SSE protocol               | `sse-events.ts`, `sse-parser.ts`      | 12 events in Zod, parser works |
| B53 Advanced Build Experience | extends           | B05's grouping model is the foundation for B53's parallel build groups        | `ActivityGroup` type                  | PLANNED                        |
| B02 Page Context Awareness    | shares data with  | Page context enriches activity labels (e.g., "Analyzing billing_agent")       | `buildPageContext()`, activity labels | ALPHA (shipped)                |
| B03 File Upload + Multimodal  | emits into        | B03 will emit `file_processed`/`file_error`, not `activity` (separate events) | SSE protocol                          | PLANNED                        |
| Specialist Executor           | depends on        | Activity wraps the existing executor turn lifecycle                           | `specialist-executor.ts`              | STABLE                         |

---

## 6. Design Considerations

- **Wireframe**: `.claude/wireframes/b05-live-thinking.html` — interactive prototype with 7 scenarios
- **Design doc**: `docs/arch/design/2026-04-05-live-thinking-visibility-design.md` (Draft v2, reviewed)
- **External reviews**: GPT-5.4 Codex + Claude 4.6 Opus reviews in `docs/arch/review/`
- **Visual pattern**: Borderless, free-flowing steps under the Arch avatar — no cards, no bordered containers. Matches Claude's thinking-step UI pattern.
- **Accessibility**: `aria-live="polite"`, debounced announcements (max 1/sec), keyboard-navigable expand/collapse, server-controlled label templates (field names, not values) for data safety.
- **Design tokens**: All colors from semantic tokens (`text-error`, `text-success`, `text-muted`, `text-warning`). No hardcoded Tailwind palette.

---

## 7. Technical Considerations

- **SSE protocol consolidation**: `activity` is the canonical visibility event. `step_start`/`step_complete`/`status_update` deprecated in Arch SSE contract (retained for platform runtime compat). `ARCH_ENHANCED_PROGRESS` dead code removed from route.ts.
- **Message lifecycle change**: `useArchChat` currently creates assistant messages on first `text_delta`. B05 changes this to first `activity` event. State updates use React functional `setMessages` updaters (immutable, closure-safe).
- **Group terminal condition**: Groups close on explicit `done`/`error` event for the group root ID — NOT inferred from step statuses.
- **Server-side summaries**: Collapsed summary text generated server-side and sent as `detail` field on terminal group event. Frontend fallback: "{N} steps · {duration}s".
- **Proxy headers**: Add `X-Accel-Buffering: no` to SSE response headers to prevent nginx/CDN buffering.

---

## 8. How to Consume

### Studio UI

- **Onboarding chat** (`/arch`): Activity steps appear above response text during all phases (Interview, Blueprint, Build, Create). Collapses to summary after response completes.
- **In-Project overlay** (`ArchOverlay`): Same activity rendering during analysis, tool execution, and recompilation.
- **Chat history**: Completed messages show collapsed summary. Click to expand full activity log.

### API (Runtime)

N/A — B05 is a Studio-only UI feature. No Runtime API changes.

### API (Studio)

| Method | Path                   | Purpose                                            |
| ------ | ---------------------- | -------------------------------------------------- |
| POST   | `/api/arch-ai/message` | Existing endpoint. Now emits `activity` SSE events |

No new endpoints. The existing SSE stream gains a new event type.

### Admin Portal

N/A

### Channel / SDK / Voice / A2A / MCP Integration

N/A — Activity is Studio-specific. Other surfaces (MCP, CLI) would define their own visibility patterns if needed (B56 scope).

---

## 9. Data Model

### Collections / Tables

No new collections. No schema changes to existing collections. Activity is ephemeral frontend state.

### Key Relationships

- `ActivityEventSchema` added to `ArchSSEEventSchema` discriminated union in `packages/arch-ai/src/types/sse-events.ts`
- `ActivityStep` and `ActivityGroup` types added to `apps/studio/src/types/arch.ts` (or `useArchChat` local types)
- `ChatMessage` extended with optional `activityGroups?: ActivityGroup[]`

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                 | Purpose                                |
| ---------------------------------------------------- | -------------------------------------- |
| `packages/arch-ai/src/types/sse-events.ts`           | Add `ActivityEventSchema` to Zod union |
| `packages/arch-ai/src/streaming/activity-emitter.ts` | NEW: `ActivityEmitter` helper class    |
| `packages/arch-ai/src/streaming/index.ts`            | Export `ActivityEmitter`               |
| `packages/arch-ai/src/streaming/sse-parser.ts`       | Handle `activity` in parser            |

### Routes / Handlers

| File                                                   | Purpose                                        |
| ------------------------------------------------------ | ---------------------------------------------- |
| `apps/studio/src/app/api/arch-ai/message/route.ts`     | Emit activity events across all phase handlers |
| `packages/arch-ai/src/executor/specialist-executor.ts` | Wrap LLM calls + tool calls with activity      |

### UI Components

| File                                                         | Purpose                                        |
| ------------------------------------------------------------ | ---------------------------------------------- |
| `apps/studio/src/components/arch-v3/chat/ActivitySteps.tsx`  | NEW: Borderless activity steps component       |
| `apps/studio/src/hooks/useArchChat.ts`                       | Handle `activity` events, create assistant msg |
| `apps/studio/src/app/arch/page.tsx`                          | Render ActivitySteps in onboarding chat        |
| `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx` | Render ActivitySteps in in-project overlay     |

### Jobs / Workers / Background Processes

N/A

### Tests

| File                                                      | Type | Coverage Focus                                  |
| --------------------------------------------------------- | ---- | ----------------------------------------------- |
| `packages/arch-ai/src/__tests__/activity-emitter.test.ts` | unit | ActivityEmitter event shapes, turn IDs          |
| `apps/studio/src/__tests__/useArchChat.activity.test.ts`  | unit | SSE handler accumulation, message create        |
| `apps/studio/src/__tests__/ActivitySteps.test.tsx`        | unit | Expand/collapse, status icons, memoize          |
| `apps/studio/e2e/arch-b05-activity.spec.ts`               | e2e  | Full vertical slice: send → activity → collapse |

---

## 11. Configuration

### Environment Variables

No environment variables required. Activity events are always emitted (no feature flag). The `ARCH_ACTIVITY_ENABLED` flag was planned but never implemented — activity is lightweight and the frontend handles unknown events gracefully.

### Runtime Configuration

No runtime configuration needed.

### DSL / Agent IR / Schema

N/A

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| Project isolation | N/A — activity events flow through existing session-scoped SSE stream                           |
| Tenant isolation  | Activity events inherit the existing SSE auth context (session belongs to authenticated tenant) |
| User isolation    | Activity events inherit the existing SSE auth context (session belongs to authenticated user)   |

### Security & Compliance

- Activity labels must use server-controlled templates with field names, not field values, to prevent sensitive data leakage (e.g., "Captured: project name" not "Captured: Acme Corp Secret Project")
- No new API endpoints or auth flows introduced
- Activity events carry no PII — only processing step descriptions

### Performance & Scalability

- `ActivitySteps` component memoized to prevent message list re-render on each event
- Rapid events batched with `requestAnimationFrame` for single-render coalescing
- Screen reader announcements debounced to max 1 per second
- No database writes for activity (zero persistence overhead)
- For 20-agent Build: ~200 step objects in memory per message (negligible heap impact)

### Reliability & Failure Modes

- If activity emission fails, the SSE stream continues — activity is additive, never blocking
- If frontend receives malformed activity events, `default: break` handles gracefully
- Page refresh clears all activity state cleanly — no ghost state, no corruption
- Session resume restores text history only — activity is not reconstructed

### Observability

- Activity events visible in SSE stream (can be logged server-side for debugging)
- Future: optional `correlationId` field to link activity to platform traces (deferred, not in v1)

### Data Lifecycle

- Activity is ephemeral — exists only in the browser tab during active streaming
- No retention, no TTL, no archival, no deletion cascade
- Cleared on: page refresh, session switch, session resume, `done` event (collapses but not deleted)

---

## 13. Delivery Plan / Work Breakdown

1. **SSE Protocol Consolidation** (prerequisite commit)
   1.1 Add `ActivityEventSchema` to Zod discriminated union in `sse-events.ts`
   1.2 Update `sse-parser.ts` to handle `activity`
   1.3 Remove `step_start`/`step_complete`/`status_update` from `sse-protocol.md`
   1.4 Remove `ARCH_ENHANCED_PROGRESS` flag + dead code — DONE
   1.5 Update E2E tests that expect deprecated events — DONE

2. **Backend: ActivityEmitter + Executor Integration**
   2.1 Create `activity-emitter.ts` with `start/done/error/warning/info/nextTurn` methods — DONE
   2.2 Export from `streaming/index.ts` — DONE
   2.3 Wrap `specialist-executor.ts` with per-turn activity events — DONE
   2.4 ~~Add `ARCH_ACTIVITY_ENABLED` feature flag check~~ — Dropped (always-on)

3. **Frontend: useArchChat + ActivitySteps Component**
   3.1 Handle `activity` events in `useArchChat` SSE reducer
   3.2 Create assistant message on first `activity` event
   3.3 Build `ActivitySteps.tsx` (borderless, free-flowing, memoized)
   3.4 Integrate into `/arch/page.tsx` and `ArchOverlay.tsx`
   3.5 Replace typing indicator transition

4. **Phase 1 Emissions: Interview**
   4.1 Add 3-5 activity events to Interview handler in `route.ts`
   4.2 Verify end-to-end: send message → activity → collapse → refresh clears

5. **Phase 2 Emissions: Build (Grouped)**
   5.1 Add per-agent grouped activity to Build handler
   5.2 Server-side summary generation on group terminal events
   5.3 Verify multi-group collapse/expand

6. **Phase 3 Emissions: Create + In-Project**
   6.1 CREATE handler: dual-emit `activity` + `progress`
   6.2 IN_PROJECT: multi-turn activity with tool call wrapping
   6.3 `ArchOverlay.tsx` activity rendering

7. **Cleanup**
   7.1 Remove `progress` dual-emit from CREATE
   7.2 Full E2E test coverage
   7.3 Update `sse-protocol.md` contract

---

## 14. Success Metrics

| Metric                         | Baseline          | Target                 | How Measured                                  |
| ------------------------------ | ----------------- | ---------------------- | --------------------------------------------- |
| Perceived responsiveness       | 15-30s dead time  | First feedback <1s     | Time from message send to first activity step |
| User engagement during wait    | 0 (nothing shown) | Activity steps visible | Activity events rendered per session          |
| "Is it stuck?" support queries | Unknown           | Reduce to near-zero    | User feedback / session abandonment rate      |
| Activity coverage              | 0 phases          | 5 phases (all)         | Phase handlers with activity emissions        |

---

## 15. Open Questions

1. Should `journal_entry` events also render as `info` activity steps in the future (currently excluded by dedup policy)?
2. Should the `specialist` event become the activity group header (unified rendering) or stay as a separate badge?
3. Should activity support a `correlationId` for trace-linking from v1, or defer to post-launch?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                       | Severity | Status |
| ------- | --------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | No `useArchChat` test infrastructure exists — must be established as prerequisite | High     | Open   |
| GAP-002 | Proxy/CDN buffering may delay SSE events (need `X-Accel-Buffering: no` header)    | Medium   | Open   |
| GAP-003 | No trace correlation between activity events and platform TraceStore              | Low      | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                    | Coverage Type | Status     | Test File / Note               |
| --- | ------------------------------------------- | ------------- | ---------- | ------------------------------ |
| 1   | ActivityEmitter emits correct event shapes  | unit          | NOT TESTED | `activity-emitter.test.ts`     |
| 2   | useArchChat creates msg on first activity   | unit          | NOT TESTED | `useArchChat.activity.test.ts` |
| 3   | ActivitySteps renders expanded/collapsed    | unit          | NOT TESTED | `ActivitySteps.test.tsx`       |
| 4   | Interview: send msg → activity → collapse   | e2e           | NOT TESTED | `arch-b05-activity.spec.ts`    |
| 5   | Build: grouped activity per agent           | e2e           | NOT TESTED | `arch-b05-activity.spec.ts`    |
| 6   | Error: compile fail → error step → auto-fix | e2e           | NOT TESTED | `arch-b05-activity.spec.ts`    |
| 7   | Refresh during streaming clears activity    | e2e           | NOT TESTED | `arch-b05-activity.spec.ts`    |
| 8   | Resume session shows no ghost activity      | e2e           | NOT TESTED | `arch-b05-activity.spec.ts`    |
| 9   | No activity events → typing indicator works | integration   | NOT TESTED | Backward compat check          |
| 10  | SSE Zod schema validates activity events    | unit          | NOT TESTED | Schema validation test         |

### Testing Notes

B05 requires establishing `useArchChat` test infrastructure (GAP-001) as a prerequisite. The hook handles 12+ event types with complex state transitions and currently has zero test coverage. E2E tests must exercise the real SSE stream through `POST /api/arch-ai/message` with auth context — no mocking codebase components.

> Full testing details: `../testing/live-thinking-visibility.md`

---

## 18. References

- Design doc: `docs/arch/design/2026-04-05-live-thinking-visibility-design.md`
- Backlog item: `docs/arch/backlogs/B05-live-thinking-visibility.md`
- GPT-5.4 review: `docs/arch/review/2026-04-05-gpt-5.4-codex-live-thinking-visibility-review.md`
- Claude 4.6 review: `docs/arch/review/2026-04-05-claude-4.6-opus-live-thinking-visibility-review.md`
- Wireframe: `.claude/wireframes/b05-live-thinking.html`
- SSE protocol contract: `docs/arch/contracts/sse-protocol.md`

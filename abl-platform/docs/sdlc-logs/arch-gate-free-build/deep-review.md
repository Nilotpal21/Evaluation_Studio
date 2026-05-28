# Deep Review: Arch Conversational Flow — Gate-Free Onboarding

**Reviewer**: Claude (multi-perspective analysis)
**Date**: 2026-04-10
**Spec**: `docs/features/sub-features/arch-gate-free-build.md`
**Verdict**: NEEDS REVISION — 4 critical findings, 6 high findings, 5 medium findings

---

## 1. CRITICAL FINDINGS (must resolve before implementation)

### C1: `ask_user` Widget Non-Blocking Breaks the Multi-Turn Executor Contract

**Spec says** (FR-1.3): "ask_user widget tool calls must NOT transition the session to GATE_PENDING. The session transitions to IDLE when the stream ends."

**Actual code contract** (`specialist-executor.ts:133-148`):
When the LLM calls `ask_user` (a client-side tool), the executor returns `{ status: 'awaiting_tool_result', toolCallId }`. The multi-turn executor stops the loop. The route handler then:

1. Persists the pending interaction: `setPendingInteraction(ctx, session.id, { kind: 'widget', ... })` (route.ts:3081-3085)
2. Does NOT transition to IDLE — the session stays `ACTIVE`
3. The stream closes (SSE `done` event)

**The problem**: The spec says "session transitions to IDLE when stream ends" but currently the session stays `ACTIVE` after an `ask_user`. This is by design — if the session went to `IDLE`, a second browser tab could start a NEW LLM turn before the user answers the widget. The `ACTIVE` state acts as a mutex preventing concurrent LLM calls.

**Risk**: If we make the session go `IDLE` after `ask_user`, two concurrent requests could start LLM turns simultaneously, corrupting the conversation.

**Recommendation**: Session must stay `ACTIVE` after `ask_user` — do NOT transition to `IDLE`. Instead, remove `GATE_PENDING` but keep the pending interaction as a `PendingWidgetInteraction` while session stays `ACTIVE`. The client detects the widget from the SSE stream (tool_call event for `ask_user`) and from the resume snapshot's `pendingInteraction`. No state machine change needed — just stop using `GATE_PENDING` for gates, but keep `ACTIVE` as the state during widget-pending.

**Impact**: FR-1.2, FR-1.3, FR-1.4 need rewriting.

---

### C2: Proceed-Intent NLP Detection is Underspecified and Risky

**Spec says** (FR-4.3): "The coordinator must detect proceed-intent from common natural language patterns: 'continue', 'proceed', 'looks good', 'build it', 'create it', 'let's go', 'next'."

**Problems**:

1. **False positives**: User says "Can we continue the billing agent discussion?" — contains "continue" but is NOT a proceed-intent. User says "What's next for the Claims agent?" — contains "next" but is asking a question.

2. **Where does detection happen?** The spec doesn't specify. Three options:
   - **Client-side pattern match** (useArchChat hook) — fast but dumb, can't understand context
   - **Route handler pattern match** — same problem, slightly better position
   - **LLM classification** — the LLM already understands context. It can call a `proceed_to_next_phase` tool or emit a phase_transition event when it detects the user wants to advance.

3. **Conflation with the proceed button**: If the user has BOTH a proceed button AND NLP detection, which takes precedence? What if the NLP false-triggers while the user was just chatting?

**Recommendation**: Don't build separate NLP intent detection. Instead, let the **LLM decide**. Add a `proceed_to_next_phase` tool to each phase's tool set. When the user says "looks good" or "build it", the LLM calls this tool (same pattern as `generate_topology` or `create_project`). The coordinator handles the tool call by transitioning the phase. This is consistent with the existing tool-driven architecture and avoids false-positive risk entirely.

The proceed buttons on the client are just UI sugar — clicking them sends a predefined message like "Proceed to the next phase" which the LLM handles.

**Impact**: FR-4.1, FR-4.3 need rewriting. New tool definition needed.

---

### C3: `pendingInteraction` Field Keeps Both Widget and Gate Data — Can't Just Delete Gate Types

**Spec says** (FR-1.7): "The PendingGateInteraction type and all gate payload types must be removed from session types."

**Actual code**: `session.metadata.pendingInteraction` is typed as `PendingInteraction = PendingWidgetInteraction | PendingGateInteraction`. The field is used for BOTH widgets (ask_user) and gates. The route handler at line 3081-3085 writes widget interactions to this same field.

If we remove `PendingGateInteraction` from the union, the field becomes `PendingInteraction = PendingWidgetInteraction` which is fine — BUT:

1. The `setPendingInteraction` calls in the route for WIDGET must continue working
2. The resume snapshot reads `pendingInteraction.kind` to decide widget vs gate — removing the gate branch changes resume behavior
3. The route handler's GATE_PENDING bypass logic (line 537-543) checks `session.state === 'GATE_PENDING'` — if we remove the state, this code path disappears, but we need to handle the case where the user sends a message while a widget is pending

**Recommendation**: Keep `PendingWidgetInteraction` and `pendingInteraction` field. Remove `PendingGateInteraction` from the union type. Update resume snapshot to only handle `kind: 'widget'`. Keep the bypass logic for widget-pending (session ACTIVE + pendingInteraction exists + user sends message → clear pending, process message).

**Impact**: FR-1.7 is partially correct but needs to be more precise about what stays and what goes.

---

### C4: Removing `topology_approval` Gate Breaks the BLUEPRINT→BUILD Transition Logic

**Spec says** (FR-3.3): "No topology_approval gate must be emitted."

**Actual code**: The BLUEPRINT→BUILD phase transition currently happens INSIDE the `topology_approval` gate response handler (route.ts:3752-3912):

1. User accepts topology → gate handler sets `topologyApproved = true`
2. Gate handler updates `metadata.phase` to BUILD
3. Gate handler emits `phase_transition` SSE event
4. Gate handler diffs new topology against existing build state
5. Gate handler falls through to the BUILD specialist LLM call

If we remove the topology_approval gate, we need a NEW mechanism for:

- Setting `topologyApproved = true`
- Transitioning from BLUEPRINT to BUILD
- Emitting the phase_transition SSE event
- Running the topology diff if the user iterated

**Recommendation**: The `proceed_to_next_phase` tool (from C2) handles this. When the LLM calls `proceed_to_next_phase` during BLUEPRINT:

1. Check exit criteria (topology exists)
2. Set `topologyApproved = true`
3. Transition phase BLUEPRINT → BUILD
4. Emit `phase_transition` event
5. Run topology diff against existing build state
6. Fall through to BUILD specialist

This is a significant rewiring of the route handler — the spec needs to call it out explicitly in the delivery plan.

**Impact**: Delivery plan item 2 (Rewrite BUILD message route) must also cover BLUEPRINT→BUILD transition rewiring.

---

## 2. HIGH FINDINGS (should resolve)

### H1: Section 7 "Technical Considerations" Contradicts Section 4 FR-1.2

Section 7 says: "`GATE_PENDING` is still valid but only reachable during BLUEPRINT phase (topology_approval gate)"

But FR-1.2 says: "The `GATE_PENDING` session state must be removed from the session state machine entirely."

And FR-3.3 says: "No `topology_approval` gate must be emitted."

**These three statements are mutually contradictory.** The expanded scope (remove topology_approval) means Section 7 was not updated — it still describes the original plan where topology_approval was preserved.

**Fix**: Update Section 7 to match the expanded FR scope. `GATE_PENDING` is removed entirely, topology_approval is gone.

---

### H2: Session Data Model Says `pendingInteraction` Keeps `topology_approval` Gates

Section 9 (Data Model) says:

```
pendingInteraction: PendingInteraction | null  (only topology_approval gates)
```

This contradicts FR-3.3 (topology_approval removed) and FR-1.7 (gate types removed).

**Fix**: Update to: `pendingInteraction: PendingWidgetInteraction | null (widgets only, no gates)`

---

### H3: Section 10 Still References `gate-manager.ts` — Should Be Removed

The Key Implementation Files table says:

```
apps/studio/src/lib/arch-ai/gate-manager.ts — Gate lifecycle — simplify to topology_approval only
```

Since topology_approval is also removed, `gate-manager.ts` should be deleted entirely, not simplified.

**Fix**: Remove from table or mark as "DELETE entirely."

---

### H4: ApprovalGate Component Should Be Deleted, Not Simplified

Section 10 says:

```
ApprovalGate.tsx — Simplify — topology_approval only
```

But with ALL gates removed, `ApprovalGate.tsx` has no remaining use case.

**Fix**: Mark as "DELETE entirely." The `useArchChat` hook's `gate_request` handler becomes dead code too.

---

### H5: `topologyApproved` Metadata Field — What Sets It Now?

`session.metadata.topologyApproved` is used by the BUILD phase exit criteria indirectly (the phase machine checks it in the BLUEPRINT→BUILD transition path). Currently it's set by the topology_approval gate handler.

With the gate removed, the spec doesn't specify what sets `topologyApproved = true`. If nothing sets it, the phase transition from BLUEPRINT to BUILD will fail.

**Fix**: The `proceed_to_next_phase` tool call in BLUEPRINT should set `topologyApproved = true` before transitioning.

---

### H6: `gate_response` Message Type in MessageRequest Schema

The `MessageRequestSchema` (message-request.ts:42-48) has `gate_response` as a discriminated union variant:

```typescript
z.object({
  sessionId: z.string().min(1),
  type: z.literal('gate_response'),
  ...
})
```

The spec (FR-1.6) says to remove `gate_response` from onboarding flows, but doesn't specify whether to remove it from the schema entirely. If IN_PROJECT mode uses gates (it uses `pendingMutation` which is different), this schema change could break IN_PROJECT.

**Fix**: Verify whether IN_PROJECT mode sends `gate_response` messages. If not, remove from schema. If yes, keep in schema but don't process in onboarding route. Add explicit note to spec.

---

## 3. MEDIUM FINDINGS (should address or log)

### M1: Delivery Plan Missing BLUEPRINT Route Handler Changes

The delivery plan has 10 items but none explicitly cover the BLUEPRINT phase route handler changes. Item 2 says "Rewrite BUILD Message Route Handler" but the topology_approval gate removal and BLUEPRINT→BUILD transition rewiring are equally large changes. These need their own delivery item.

---

### M2: No Spec for "Freeform Answer to Widget" Behavior (FR-2.2)

FR-2.2 says users can type a freeform answer instead of clicking a widget. But the current `tool_answer` message type expects structured data matching the widget type (e.g., `{ value: 'Web Chat' }` for SingleSelect). If the user types "web and voice channels", who parses this into structured data?

Options: (a) The typed text is sent as a regular `message`, not a `tool_answer` — the LLM re-processes it. (b) The client converts freeform text into a `tool_answer` format. (c) The route handler detects "message during widget-pending" and injects the text as a tool result.

Option (a) is simplest — the message bypasses the widget entirely, clearing the pending interaction. The LLM sees the text in the conversation history and updates the spec accordingly. This is the existing bypass behavior (route.ts:556-558).

**Fix**: Add a note to FR-2.2 clarifying that typing freeform text sends a regular `message` (not `tool_answer`), which clears the pending widget and lets the LLM process the text naturally.

---

### M3: Resume Flow for Mid-BLUEPRINT Sessions

FR-13 covers resume for DISCOVER and BUILD but not BLUEPRINT. If the user closes the browser after the topology was generated but before clicking "Build This", what happens on resume?

The topology is already in `session.metadata.topology` and the phase is `BLUEPRINT`. The resume snapshot should detect this and offer "Continue to Build" or show the topology reveal stage.

**Fix**: Add FR-13.6 covering BLUEPRINT resume: if topology exists and phase is BLUEPRINT, resume should show topology reveal with proceed button.

---

### M4: Testing Coverage Matrix Doesn't Cover New FRs (FR-2, FR-3, FR-4)

Section 17 (Testing & Validation) only has 10 test scenarios from the original BUILD-only spec. The expanded scope adds FR-2 (DISCOVER), FR-3 (BLUEPRINT), and FR-4 (phase transitions) — none have test coverage listed.

**Fix**: Add test scenarios for:

- DISCOVER phase: widget renders, freeform text accepted, proceed button appears
- BLUEPRINT phase: topology generates without gate, conversational modification, proceed to BUILD
- Phase transitions: natural language proceed, button proceed, exit criteria enforcement

---

### M5: `forceArchiveStuck` Behavior After GATE_PENDING Removal

The spec mentions `forceArchiveStuck()` handles old sessions stuck in `GATE_PENDING`. But if `GATE_PENDING` is removed from the state machine, this function's filter `{ state: { $in: ['ACTIVE', 'GATE_PENDING'] } }` will still match ACTIVE sessions — which is fine. But any OLD sessions in the DB with `state: 'GATE_PENDING'` will no longer be matched by `RESUMABLE_STATES` (which currently includes `GATE_PENDING`).

This means old GATE_PENDING sessions become invisible — they can't be resumed, listed, or archived through normal flows. They'll sit in the DB forever.

**Fix**: Add a one-time cleanup step: either (a) a migration script that sets all `GATE_PENDING` sessions to `ARCHIVED`, or (b) add `GATE_PENDING` to `ARCHIVABLE_STATES` even if removed from the main state machine, so `forceArchiveStuck` can still clean them up. Or (c) handle at the MongoDB query level — find sessions with `state: 'GATE_PENDING'` and archive them in the deployment.

---

## 4. ARCHITECTURE SUMMARY

### What's Sound

- Eliminating `GATE_PENDING` removes the root cause of stuck sessions — this is the right fix
- Auto-generation + chat narration is the correct UX pattern
- The 4-phase onboarding (welcome → discover → build → create) is a clear improvement
- Tool-driven phase transitions (via `proceed_to_next_phase`) are consistent with existing architecture
- Keeping `ask_user` widgets as non-blocking rich chat elements preserves structured input UX

### What Needs Tightening

1. **Session state during widget-pending**: Must stay `ACTIVE` (mutex), not go to `IDLE`
2. **Phase transition mechanism**: Needs a `proceed_to_next_phase` tool, not NLP pattern matching
3. **BLUEPRINT route handler rewiring**: Delivery plan underestimates this
4. **Old GATE_PENDING sessions**: Need a cleanup strategy
5. **Multiple spec contradictions**: Section 7 and Section 9 don't match the expanded FR scope

### Suggested `proceed_to_next_phase` Tool Design

```typescript
const PROCEED_TO_NEXT_PHASE_TOOL: LLMToolDefinition = {
  name: 'proceed_to_next_phase',
  description:
    'Advance to the next onboarding phase when the user confirms they are ready. Only call this when the user explicitly indicates they want to proceed (e.g., "looks good", "build it", "continue", "create project").',
  input_schema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'Brief explanation of why the user is ready to proceed',
      },
    },
    required: ['reason'],
  },
};
```

Add to `PHASE_TOOL_MAP`: INTERVIEW, BLUEPRINT, BUILD all get this tool. The coordinator handles it by checking exit criteria and transitioning.

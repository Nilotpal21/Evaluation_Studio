# ABLP-986 — Reasoning step produces empty response when entered via auto-advance

> **Review update — 2026-05-17 (GPT-5.5 high review)** · Verdict: **CONCERN**
>
> - Root cause confirmed at `apps/runtime/src/services/execution/flow-step-executor.ts:8603,8618`.
> - **The unskipped test only re-asserts the boolean condition** instead of exercising `FlowStepExecutor`. The skipped test is the actual repro and needs unskipping — extract the gate to a pure function (the DI refactor noted in the doc) so it can be exercised without spinning up the monolithic executor.
> - **Missing "wrongly parked but with `PRESENT`" case**: a `PRESENT` step avoids the empty response but still parks and skips reasoning (`flow-step-executor.ts:8622`). Tests need both "no output" and "wrongly parked" cases.
> - Prefer an **explicit "entered by transition" input contract** over removing the guard — the guard also prevents reasoning-zone startup without tool schemas (`flow-step-executor.ts:8612`).
>
> Full review: [`codex-review.md`](codex-review.md)

> **Takeover update — 2026-05-17**
>
> - Extracted `resolveReasoningZoneEmptyMessageGate()` from `FlowStepExecutor`
>   and wired the existing guard through it without changing behavior.
> - Updated the repro to assert the target runtime decision:
>   `execute_reasoning_with_goal`.
> - Verified the test now fails for the intended reason: current behavior still
>   returns `park_without_output`.

## Symptom

When a scripted flow step (e.g., `collect_type` with ON_INPUT) matches user input and transitions to a REASONING step (e.g., `collect_dates`) via THEN, the reasoning step returns an empty response: "The agent returned an empty response." If the user sends the same message again, the reasoning step works correctly because it now has a non-empty `currentMessage`.

## Root Cause

**File:** `apps/runtime/src/services/execution/flow-step-executor.ts:8618-8629`

The flow step executor has an early-exit guard that prevents reasoning zones from executing when `currentMessage` is empty:

```typescript
if (step.reasoning_zone && !currentMessage) {
  // During init/auto-transition: emit PRESENT intro verbatim
  if (step.present) {
    const presentText = interpolateTemplate(step.present, session.data.values);
    emitProtectedAssistantText(session, presentText, onChunk);
  }
  // Park on this step and wait for user input.
  break;
}
```

The design intent is to prevent reasoning zones from executing without user input (avoiding crashes in jsonSchemaToZod for tools without input_schema). However, when auto-advancing from a scripted step via THEN:

1. The scripted step (`collect_type`) consumes the user message via ON_INPUT matching
2. It transitions to the next step (`collect_dates`) via THEN
3. `currentMessage` is now empty/undefined because the input was consumed by the prior step
4. The guard at line 8618 triggers — the reasoning zone never executes
5. If `step.present` is not defined, no text is emitted — the response is empty

This is purely a runtime-layer issue. The compiler-level `ReasoningExecutor` class does not have this gate; it receives pre-built messages and always calls the LLM.

## Reproduction Test

**Path:** `packages/compiler/src/platform/constructs/executors/__tests__/reasoning-executor-auto-advance.repro.test.ts`

**Status:** executable failing repro. The compiler-level executor assertion
confirms empty messages are acceptable once execution reaches
`ReasoningExecutor`; the runtime gate assertion fails because the extracted
`FlowStepExecutor` helper still parks without output on auto-advance.

## Future-Ready Solution

The fix should ensure auto-advanced reasoning steps produce meaningful output even without fresh user input:

### Option A: Synthesize an entry message from step context (recommended)

When entering a reasoning step via auto-advance with empty `currentMessage`, synthesize a context message from available state:

```typescript
if (step.reasoning_zone && !currentMessage) {
  // Synthesize entry context from prior step results + session values
  const entryContext = buildReasoningEntryContext(step, session);
  if (entryContext) {
    currentMessage = entryContext;
    // Fall through to normal reasoning execution
  } else if (step.present) {
    emitProtectedAssistantText(session, presentText, onChunk);
    break;
  } else {
    // Emit step GOAL as a prompt to the user
    const goalPrompt = step.reasoning_zone.goal || 'Please provide more information.';
    emitProtectedAssistantText(session, goalPrompt, onChunk);
    break;
  }
}
```

### Option B: Always emit GOAL text as fallback

When no `present` and no `currentMessage`, use the step's GOAL as the user-visible prompt rather than producing empty output. This is the minimal fix.

### Option C: Allow LLM call with empty user input

Remove the guard entirely and let the reasoning executor run with just the system prompt (GOAL) and conversation history. The LLM can generate a prompt for the user based on the GOAL. This changes semantics but matches the reporter's expectation.

All options should be guarded by the original concern (jsonSchemaToZod crash) being fixed at the tool schema level rather than the execution gate.

## Related

- **ABLP-1058** — separate root cause (reasoning/thinking blocks dropped from assistant message construction, causing provider API errors). Does NOT share root cause with this ticket.

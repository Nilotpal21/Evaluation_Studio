# Error Handling and Escalation

This document covers the ON_ERROR, ESCALATE, and COMPLETE constructs for managing errors and conversation lifecycle.

## Table of Contents

1. [ON_ERROR Construct](#1-on_error-construct)
2. [ESCALATE Construct](#2-escalate-construct)
3. [COMPLETE Construct](#3-complete-construct)
4. [Step-Level ON_ERROR](#4-step-level-on_error)
5. [Implementation Status](#5-implementation-status)
6. [Test Coverage](#6-test-coverage)

---

## 1. ON_ERROR Construct

ON_ERROR defines strategies for handling runtime errors.

### DSL Syntax

```dsl
ON_ERROR:
  tool_timeout:
    RESPOND: "The operation is taking longer than expected. Please wait..."
    RETRY: 2
    THEN: CONTINUE

  tool_failure:
    RESPOND: "I encountered an issue. Let me try a different approach."
    THEN: HANDOFF Fallback_Agent

  validation_error:
    RESPOND: "That doesn't look quite right. {{error.message}}"
    THEN: CONTINUE

  network_error:
    RESPOND: "I'm having trouble connecting. Let me try again."
    RETRY: 3
    THEN: ESCALATE

  DEFAULT:
    RESPOND: "I'm sorry, something went wrong. Let me connect you with support."
    THEN: ESCALATE
```

### Error Types

| Type               | Description                     | Typical Cause         |
| ------------------ | ------------------------------- | --------------------- |
| `tool_timeout`     | Tool execution exceeded timeout | Slow external service |
| `tool_failure`     | Tool returned error             | Service unavailable   |
| `validation_error` | Input validation failed         | Invalid user input    |
| `network_error`    | Network connectivity issue      | Connection problems   |
| `llm_error`        | LLM call failed                 | API error             |
| `DEFAULT`          | Any unhandled error             | Catch-all             |

### Handler Properties

| Property  | Required | Description              |
| --------- | -------- | ------------------------ |
| `RESPOND` | No       | Error message to user    |
| `RETRY`   | No       | Number of retry attempts |
| `THEN`    | Yes      | Action after handling    |

### THEN Actions

| Action          | Description             |
| --------------- | ----------------------- |
| `CONTINUE`      | Resume normal flow      |
| `ESCALATE`      | Transfer to human agent |
| `HANDOFF Agent` | Route to another agent  |
| `COMPLETE`      | End conversation        |

### IR Schema

```typescript
interface ErrorHandlingConfig {
  handlers: ErrorHandler[];
  default_handler: ErrorHandler;
}

interface ErrorHandler {
  type: string;
  respond?: string;
  retry?: number;
  retry_delay_ms?: number;
  then: 'continue' | 'escalate' | 'handoff' | 'complete';
  handoff_target?: string;
}
```

---

## 2. ESCALATE Construct

ESCALATE defines conditions for transferring to human agents.

### DSL Syntax

```dsl
ESCALATE:
  triggers:
    - WHEN: user.requests_human == true
      REASON: "User explicitly requested human agent"
      PRIORITY: high
      TAGS: [manual_request]

    - WHEN: frustration_detected == true
      REASON: "User appears frustrated"
      PRIORITY: medium
      TAGS: [sentiment]

    - WHEN: attempts > 3 AND issue.unresolved
      REASON: "Multiple failed resolution attempts"
      PRIORITY: high
      TAGS: [resolution_failure]

    - WHEN: intent.category == "complaint"
      REASON: "Customer complaint"
      PRIORITY: critical
      TAGS: [complaint]

  CONTEXT_FOR_HUMAN:
    - user_id
    - conversation_summary
    - booking_details
    - attempted_solutions

  ON_HUMAN_COMPLETE:
    - IF human.resolved == true: COMPLETE
    - IF human.needs_agent == true: HANDOFF to specified_agent
```

### Trigger Properties

| Property   | Required | Description                         |
| ---------- | -------- | ----------------------------------- |
| `WHEN`     | Yes      | Condition expression                |
| `REASON`   | Yes      | Human-readable reason               |
| `PRIORITY` | No       | `low`, `medium`, `high`, `critical` |
| `TAGS`     | No       | Routing/categorization tags         |

### Priority Levels

| Priority   | Response Time | Use Case                             |
| ---------- | ------------- | ------------------------------------ |
| `critical` | Immediate     | Safety issues, VIP customers         |
| `high`     | < 1 minute    | Frustrated customers, payment issues |
| `medium`   | < 5 minutes   | Standard issues                      |
| `low`      | Queue         | General inquiries                    |

### IR Schema

```typescript
interface EscalationConfig {
  triggers: EscalationTrigger[];
  context_for_human: string[];
  on_human_complete: OnHumanComplete[];
  routing?: EscalationRouting;
}

interface EscalationTrigger {
  when: string;
  reason: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  tags?: string[];
}

interface EscalationRouting {
  queue?: string;
  skill_tags?: string[];
  priority_boost?: number;
}
```

### Runtime Implementation

```typescript
private handleEscalate(
  session: RuntimeSession,
  input: Record<string, unknown>,
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void
): { success: boolean; message: string } {
  session.isEscalated = true;
  session.escalationReason = input.reason as string || 'User requested human agent';

  const priority = input.priority as string || 'medium';
  const message = `Escalated to human agent. Reason: ${session.escalationReason}. Priority: ${priority}`;

  if (onTraceEvent) {
    onTraceEvent({
      type: 'escalation',
      data: {
        reason: session.escalationReason,
        priority,
        agent: session.agentName,
        context: session.state.context,
      },
    });
  }

  return { success: true, message };
}
```

---

## 3. COMPLETE Construct

COMPLETE defines conditions for ending the conversation successfully.

### DSL Syntax

```dsl
COMPLETE:
  - WHEN: booking_confirmed == true
    RESPOND: "Your booking is confirmed! Reference: {{confirmation}}"
    STORE: confirmation -> user.last_booking

  - WHEN: all_fields_gathered == true
    RESPOND: "I have all the information I need. Thank you!"

  - WHEN: user_says_goodbye
    RESPOND: "Thank you for using our service. Have a great day!"

  - WHEN: handoff_successful == true
    RESPOND: "I've connected you with the right specialist."
```

### Condition Properties

| Property  | Required | Description                |
| --------- | -------- | -------------------------- |
| `WHEN`    | Yes      | Completion condition       |
| `RESPOND` | No       | Final message to user      |
| `STORE`   | No       | Memory storage on complete |

### IR Schema

```typescript
interface CompletionConfig {
  conditions: CompletionCondition[];
}

interface CompletionCondition {
  when: string;
  respond?: string;
  store?: string;
}
```

### Runtime Implementation

```typescript
private handleComplete(
  session: RuntimeSession,
  input: Record<string, unknown>,
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void
): { success: boolean; message: string } {
  session.isComplete = true;
  session.state.conversationPhase = 'complete';

  const message = input.message as string || 'Conversation completed.';

  if (onTraceEvent) {
    onTraceEvent({
      type: 'decision',
      data: { type: 'complete', message, agent: session.agentName },
    });
  }

  return { success: true, message };
}
```

---

## 4. Step-Level ON_ERROR

In addition to agent-level error handlers, individual flow steps can define their own `ON_ERROR` blocks for fine-grained error control.

### DSL Syntax

```dsl
FLOW:
  book_hotel:
    CALL: book_room(hotel_id, guest_info)
    ON_ERROR:
      - TYPE: tool_failure
        SUBTYPE: credit_card_declined
        RESPOND: "Your card was declined. Please try a different payment method."
        THEN: collect_payment
      - TYPE: tool_failure
        SUBTYPE: room_unavailable
        RESPOND: "That room is no longer available."
        BACKTRACK: search_step
      - TYPE: tool_timeout
        RETRY: 2
        RETRY_DELAY: 2000
        RETRY_BACKOFF: exponential
        THEN: continue
      - TYPE: DEFAULT
        RESPOND: "Something went wrong with the booking."
        THEN: escalate
```

### Error Handler Subtypes

Subtypes allow matching specific error codes within a broader error type. This enables different handling for different failure modes of the same tool.

| Type               | Subtype Examples                                             | Description               |
| ------------------ | ------------------------------------------------------------ | ------------------------- |
| `tool_failure`     | `credit_card_declined`, `room_unavailable`, `invalid_params` | Specific tool error codes |
| `tool_timeout`     | `connection_timeout`, `read_timeout`                         | Timeout variants          |
| `validation_error` | `format_invalid`, `range_exceeded`                           | Validation failure modes  |
| `llm_error`        | `rate_limited`, `context_too_long`                           | LLM-specific errors       |

### Retry Backoff Strategies

When `RETRY` is specified, the `RETRY_BACKOFF` property controls the delay progression between attempts.

| Strategy          | Formula                 | Example (delay=1000ms, 3 retries) |
| ----------------- | ----------------------- | --------------------------------- |
| `fixed` (default) | `delay` every time      | 1000ms, 1000ms, 1000ms            |
| `exponential`     | `delay * 2^attempt`     | 1000ms, 2000ms, 4000ms            |
| `linear`          | `delay * (attempt + 1)` | 1000ms, 2000ms, 3000ms            |

```dsl
ON_ERROR:
  - TYPE: tool_timeout
    RETRY: 3
    RETRY_DELAY: 1000
    RETRY_BACKOFF: exponential   # 1s, 2s, 4s
    THEN: continue
```

### Backtrack Action

The `BACKTRACK` directive sends execution to a different flow step instead of following the normal `THEN` path. This is useful for recovery scenarios where the agent needs to re-collect data or try an alternative approach.

```dsl
ON_ERROR:
  - TYPE: tool_failure
    SUBTYPE: invalid_dates
    RESPOND: "Those dates don't work. Let's pick new ones."
    BACKTRACK: collect_dates
```

### Error Handler Resolution Order

When an error occurs, handlers are resolved in the following priority order:

1. **Step-level handler by type + subtype**: Exact match on both `TYPE` and `SUBTYPE` at the current step
2. **Step-level handler by type**: Match on `TYPE` only at the current step
3. **Step-level DEFAULT**: The `DEFAULT` handler at the current step
4. **Agent-level handler by type + subtype**: Exact match in the agent's `ON_ERROR` block
5. **Agent-level handler by type**: Match on `TYPE` in the agent's `ON_ERROR` block
6. **Agent-level DEFAULT**: The agent's `DEFAULT` error handler

If no handler matches at any level, the runtime falls back to a built-in default that logs the error and responds with a generic message.

### Enhanced IR Schema

```typescript
interface ErrorHandler {
  type: string;
  subtype?: string; // Specific error code
  respond?: string;
  retry?: number;
  retry_delay_ms?: number;
  retry_backoff?: 'fixed' | 'exponential' | 'linear';
  then: 'continue' | 'escalate' | 'handoff' | 'complete';
  handoff_target?: string;
  backtrack?: string; // Target step name
  step_name?: string; // Step this handler is attached to (for step-level)
}
```

---

## 5. Implementation Status

### ON_ERROR

| Feature                | Parser | Compiler | Runtime | Status          |
| ---------------------- | ------ | -------- | ------- | --------------- |
| Error handlers parsing | ✅     | ✅       | -       | Complete        |
| RESPOND action         | -      | ✅       | 🔶      | Basic           |
| RETRY logic            | -      | ✅       | ❌      | Not implemented |
| THEN actions           | -      | ✅       | 🔶      | Basic           |
| Default handler        | -      | ✅       | ✅      | Complete        |

### ESCALATE

| Feature             | Parser | Compiler | Runtime | Status          |
| ------------------- | ------ | -------- | ------- | --------------- |
| Triggers parsing    | ✅     | ✅       | -       | Complete        |
| Priority levels     | ✅     | ✅       | ✅      | Complete        |
| Tags                | ✅     | ✅       | ✅      | Complete        |
| **escalate** tool   | -      | -        | ✅      | Complete        |
| Human agent routing | -      | -        | 🔶      | Echo mode       |
| ON_HUMAN_COMPLETE   | ✅     | ✅       | ❌      | Not implemented |

### COMPLETE

| Feature             | Parser | Compiler | Runtime | Status          |
| ------------------- | ------ | -------- | ------- | --------------- |
| Conditions parsing  | ✅     | ✅       | -       | Complete        |
| RESPOND action      | ✅     | ✅       | ✅      | Complete        |
| STORE action        | ✅     | ✅       | ❌      | Not implemented |
| **complete** tool   | -      | -        | ✅      | Complete        |
| Session termination | -      | -        | ✅      | Complete        |

**Legend**: ✅ Complete | 🔶 Partial | ❌ Not implemented

---

## 6. Test Coverage

### Escalation Tests

```typescript
describe('Escalation', () => {
  test('should handle __escalate__ tool call', () => {
    // Verifies session.isEscalated is set
    // Verifies escalationReason is captured
    // Verifies trace event is emitted
  });
});
```

### Complete Tests

```typescript
describe('Complete', () => {
  test('should handle __complete__ tool call', () => {
    // Verifies session.isComplete is set
    // Verifies final message is sent
    // Verifies trace event is emitted
  });
});
```

### E2E Tests

From `e2e.test.ts`:

- Escalation trigger scenarios
- Human transfer simulation
- Conversation completion flows

---

## File Locations

| Component              | Path                                                       |
| ---------------------- | ---------------------------------------------------------- |
| Error Handler Parser   | `packages/core/src/parser/agent-based-parser.ts`           |
| Error Handler Compiler | `packages/compiler/src/platform/ir/compiler.ts:377-414`    |
| Escalate Handler       | `apps/platform/src/services/runtime-executor.ts:1648-1672` |
| Complete Handler       | `apps/platform/src/services/runtime-executor.ts:1625-1643` |

---

## Best Practices

### Error Handling

1. **Always provide DEFAULT handler** - Catch unexpected errors
2. **Use appropriate retry counts** - Avoid infinite loops
3. **Include helpful RESPOND messages** - Keep user informed
4. **Log errors for monitoring** - Track failure patterns

### Escalation

1. **Define clear triggers** - Avoid over-escalation
2. **Set appropriate priorities** - Route critical issues fast
3. **Include relevant context** - Help human agents
4. **Handle edge cases** - What if human unavailable?

### Completion

1. **Provide clear confirmation** - User knows conversation ended
2. **Store important data** - Capture for future reference
3. **Offer next steps** - What can user do next?

---

_Last Updated: February 2026_

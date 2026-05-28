# Constraints and Guardrails

This document covers the CONSTRAINTS, GUARDRAILS, and LIMITATIONS constructs for prompt guidance, runtime checks, and safety.

## Table of Contents

1. [Overview](#1-overview)
2. [LIMITATIONS Construct](#2-limitations-construct)
3. [CONSTRAINTS Construct](#3-constraints-construct)
4. [GUARDRAILS Construct](#4-guardrails-construct)
5. [Enhanced ON_FAIL with Control Flow](#5-enhanced-on_fail-with-control-flow)
6. [Implementation Status](#6-implementation-status)
7. [Test Coverage](#7-test-coverage)

---

## 1. Overview

Agent Blueprint Language (ABL) provides three mechanisms for enforcing rules and safety:

| Mechanism       | Enforcement       | Purpose                                     |
| --------------- | ----------------- | ------------------------------------------- |
| **LIMITATIONS** | System prompt     | Prompt-level behavior and scope guidance    |
| **CONSTRAINTS** | Runtime check     | Deterministic business and checkpoint rules |
| **GUARDRAILS**  | Output validation | Quality and safety checks                   |

### Enforcement Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                      User Input                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              CONSTRAINTS / STEP CHECKS                           │
│        Check active rules, checkpoints, and inline guards        │
│                     ON_FAIL: respond/handoff/block               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    LLM Processing                                │
│              LIMITATIONS embedded in system prompt               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   GUARDRAILS (Output)                            │
│              Validate response quality/safety                    │
│                     ACTION: warn/ensure/block                    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Response to User                            │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. LIMITATIONS Construct

LIMITATIONS defines prompt-level boundaries embedded in the system prompt. It helps the model stay in scope, explain caveats, or refuse requests, but it is not deterministic runtime enforcement.

### DSL Syntax

```dsl
LIMITATIONS:
  - Cannot process payments directly
  - Cannot guarantee availability until confirmed
  - Must verify user identity before showing booking details
  - Cannot share personal information about other customers
  - Cannot override system policies or grant special exceptions
```

### How It Works

Limitations are included in the LLM system prompt as important boundaries and guidance:

```
LIMITATIONS (important boundaries for how you should respond):
- Cannot process payments directly
- Cannot guarantee availability until confirmed
- Must verify user identity before showing booking details
```

### IR Schema

```typescript
interface AgentIdentity {
  goal: string;
  persona: string;
  limitations: string[]; // Array of limitation strings
  system_prompt: SystemPromptConfig;
}
```

---

## 3. CONSTRAINTS Construct

CONSTRAINTS defines deterministic runtime checks. Named labels are retained for readability, but the current compiler flattens them into a single runtime list unless a constraint explicitly gates itself with `WHEN` or a structural checkpoint construct.

### DSL Syntax

```dsl
CONSTRAINTS:
  booking_rules:
    - REQUIRE user.authenticated == true
      WHEN: booking.intent == "create"
      ON_FAIL: "Please log in first to make a booking."

    - REQUIRE destination IS SET
      BEFORE calling search_hotels
      ON_FAIL: HANDOFF Destination_Collector

  payment_rules:
    - LIMIT clarification_count < 5
      WHEN: selected_hotel IS SET
      ON_FAIL: ESCALATE "Too many booking revisions"

    - REQUIRE user.payment_method IS SET
      BEFORE calling charge_card
      ON_FAIL: "Please add a payment method."

  policy:
    - RESTRICT destination_country IN ["CU", "IR", "KP", "SY"]
      ON_FAIL: BLOCK
```

### Constraint Labels

Labels such as `booking_rules`, `verification`, and `always` are retained as authoring labels. They do not currently create separate runtime execution phases by themselves.

Use:

- `WHEN` to gate a constraint to a specific context.
- `BEFORE calling <tool>` or `BEFORE returning results` for structural checkpoints.
- `LIMIT` to express caps or thresholds while using the normal constraint path.
- `RESTRICT` to express prohibited states while preserving distinct author intent.

For non-structural dependency logic, prefer `IMPLIES`. Compatibility-form `BEFORE` targets are still accepted, but they are warning-only and have no runtime effect.

### ON_FAIL Actions

| Action   | Syntax            | Description                                                                                  |
| -------- | ----------------- | -------------------------------------------------------------------------------------------- |
| Respond  | `"message"`       | Show error message to user                                                                   |
| Handoff  | `HANDOFF Agent`   | Route through the shared runtime violation handler on active flow/reasoning checkpoint paths |
| Escalate | `ESCALATE reason` | Transfer to human agent                                                                      |
| Block    | `BLOCK`           | Prevent the action                                                                           |

### IR Schema

```typescript
interface ConstraintConfig {
  constraints: Constraint[]; // flat list — checked every turn
  guardrails: Guardrail[];
}

interface Constraint {
  condition: string; // may include lowered WHEN/IMPLIES/BEFORE checkpoint guards
  on_fail: ConstraintAction;
  kind?: 'limit' | 'restrict';
  applies_when?: string;
  checkpoint?: { kind: 'tool_call' | 'response'; target?: string };
}

interface ConstraintAction {
  type: 'respond' | 'escalate' | 'handoff' | 'block';
  message?: string;
  target?: string;
  reason?: string;
}
```

> **Note**: The IR uses a flat constraint list (no executable phases). The parser still
> produces `ConstraintPhase[]` in the AST, but the compiler flattens them via `flatMap`.
> Reusable constraints are scoped with `WHEN` or structural `BEFORE` checkpoints, while
> flow-step `CHECK` expressions are evaluated separately as inline booleans. The compiler
> auto-guards ordinary constraints by prepending `X IS NOT SET OR` when appropriate, but
> checkpointed `BEFORE` constraints are left as written so they behave like real preconditions.

---

## 4. GUARDRAILS Construct

GUARDRAILS defines runtime validation rules for input, output, tool calls, and handoff payloads.

### DSL Syntax

```dsl
GUARDRAILS:
  no_pii_output:
    kind: output
    check: "contains_pii(content)"
    action: redact
    msg: "PII detected in response"

  tool_input_size:
    kind: tool_input
    check: "word_count(content) < 200"
    action: block
    msg: "Tool input payload is too large"

  empathetic_tone_review:
    kind: output
    llm_check: "Does the reply acknowledge frustration and remain policy-grounded?"
    action: warn
    msg: "Tone review warning"

  handoff_summary_clean:
    kind: handoff
    check: "NOT contains_url(content)"
    action: block
    msg: "Handoff summaries must not include raw URLs"
```

Use documented local CEL helpers such as `contains_pii`, `matches_pattern`, `not_matches_pattern`, `word_count`, `sentence_count`, `contains_url`, and `contains_email` for deterministic checks. Semantic checks like empathy, toxicity, or policy grounding should use `llm_check` or a provider-backed guardrail instead of undocumented pseudo-check names.

### Guardrail Properties

| Property    | Values                                                            | Description                               |
| ----------- | ----------------------------------------------------------------- | ----------------------------------------- |
| `kind`      | `input`, `output`, `tool_input`, `tool_output`, `handoff`, `both` | When to check                             |
| `check`     | string                                                            | Tier-1 local CEL/regex-style check        |
| `provider`  | string                                                            | Optional Tier-2 model/classifier provider |
| `llm_check` | string                                                            | Optional Tier-3 LLM-as-judge instruction  |
| `action`    | `warn`, `block`, `redact`, `fix`, `reask`, `filter`, `escalate`   | What to do on failure                     |
| `msg`       | string                                                            | Human-readable guidance                   |

### Action Types

| Action     | Behavior                                           |
| ---------- | -------------------------------------------------- |
| `warn`     | Log warning, continue                              |
| `block`    | Prevent processing / response from being sent      |
| `redact`   | Replace sensitive content, continue                |
| `fix`      | Apply an automatic repair strategy                 |
| `reask`    | Ask the model to regenerate                        |
| `filter`   | Remove violating portions while preserving content |
| `escalate` | Route to a human or escalation path                |

Legacy aliases like `ensure` and `recommend` are retained only for compatibility and currently compile down to `warn`.

### IR Schema

```typescript
interface Guardrail {
  name: string;
  kind: 'input' | 'output' | 'tool_input' | 'tool_output' | 'handoff' | 'both';
  check?: string;
  provider?: string;
  llm_check?: string;
  action: GuardrailAction;
  msg?: string;
}
```

---

> **Implementation Status (March 2026)**: GUARDRAILS are fully implemented. The runtime evaluates guardrails at their respective execution points based on `kind`. Input guardrails are checked before LLM processing. Output, tool_input, tool_output, and handoff guardrails are evaluated at their respective points in the execution pipeline. The 3-tier architecture (CEL/regex → model classifiers → LLM-as-judge) is operational. See `GUARDRAILS_SPEC.md` for the full specification.

## 5. Enhanced ON_FAIL with Control Flow

The `ON_FAIL` directive has been extended beyond simple string messages to support structured control flow, inline field collection, and step navigation.

### 5.1 Structured ON_FAIL Syntax

```dsl
CONSTRAINTS:
  booking_rules:
    - REQUIRE user.email IS SET
      ON_FAIL:
        COLLECT: [email]
        THEN: continue

    - REQUIRE rooms_available > 0
      ON_FAIL:
        RESPOND: "No rooms available. Let me find alternatives."
        GOTO: search_step

    - REQUIRE user.payment_verified == true
      ON_FAIL:
        RESPOND: "Payment verification is needed."
        RETRY: true

    - REQUIRE destination IS SET AND checkin IS SET
      ON_FAIL:
        COLLECT: [destination, checkin]
        RESPOND: "I need a few more details before we proceed."
        THEN: retry
```

### 5.2 ON_FAIL Directives

| Directive | Type                 | Description                                               |
| --------- | -------------------- | --------------------------------------------------------- |
| `COLLECT` | string[]             | List of GATHER fields to collect inline before proceeding |
| `GOTO`    | string               | Jump to a named flow step                                 |
| `RETRY`   | boolean              | Retry the current step after handling                     |
| `THEN`    | `continue` / `retry` | What to do after COLLECT completes                        |
| `RESPOND` | string               | Message to show the user                                  |

#### Directive Combinations

| Pattern                      | Behavior                                                 |
| ---------------------------- | -------------------------------------------------------- |
| `RESPOND` only               | Show message, block the action                           |
| `COLLECT` + `THEN: continue` | Collect missing fields, then proceed with normal flow    |
| `COLLECT` + `THEN: retry`    | Collect missing fields, then re-evaluate the constraint  |
| `GOTO`                       | Navigate to a different step (useful for recovery paths) |
| `RESPOND` + `GOTO`           | Show message, then navigate                              |
| `RESPOND` + `RETRY`          | Show message, then re-attempt the current step           |

### 5.3 Step-Level CHECK as an Inline Guard

Flow steps can use `CHECK` for a direct boolean guard evaluated against the current
session context. `CHECK` does not look up a named constraint label; if you want
reusable rules, keep them in `CONSTRAINTS` and scope them with `WHEN` or structural
`BEFORE` checkpoints.

```dsl
FLOW:
  confirm_booking:
    CHECK: selected_hotel IS SET AND guest_email IS SET
    ON_FAIL: collect_guest_details
    RESPOND: "Let me confirm your booking details."
    THEN: finalize
```

If the expression evaluates to `false`, the flow follows the step's normal failure
path (for example `ON_FAIL: <step>`). Structured `ON_FAIL` blocks remain a
`CONSTRAINTS` feature.

### 5.4 Mini-Collect State Machine

When `ON_FAIL` triggers a `COLLECT` directive, the runtime enters a mini-collect sub-state:

```
┌────────────────────┐
│  Evaluate          │
│  Constraint        │
└─────────┬──────────┘
          │ fails
          ▼
┌────────────────────┐
│  Enter mini-collect│
│  (prompt for       │
│   missing fields)  │
└─────────┬──────────┘
          │ fields collected
          ▼
┌────────────────────┐     ┌──────────────┐
│  THEN: continue    │────▶│  Next step   │
└────────────────────┘     └──────────────┘
          OR
┌────────────────────┐     ┌──────────────┐
│  THEN: retry       │────▶│  Re-evaluate │
└────────────────────┘     │  constraint  │
                           └──────────────┘
```

The mini-collect state reuses the same GATHER extraction pipeline (LLM, pattern, or hybrid) as regular flow step collection.

### 5.5 Backtrack Limits

To prevent infinite loops when constraints repeatedly fail and trigger GOTO or RETRY, a per-step backtrack limit is enforced:

```
MAX_BACKTRACKS_PER_STEP = 3
```

After 3 backtrack attempts to the same step in a single conversation turn, the runtime:

1. Logs a warning trace event
2. Falls back to the agent-level default error handler
3. If no default handler exists, escalates to a human agent

### 5.6 Enhanced IR Schema

```typescript
interface ConstraintAction {
  type: 'respond' | 'escalate' | 'handoff' | 'block';
  message?: string;
  target?: string;
  reason?: string;

  // Enhanced control flow
  collect?: string[]; // Fields to gather inline
  goto?: string; // Target step name
  retry?: boolean; // Re-attempt current step
  then?: 'continue' | 'retry'; // Post-collect behavior
}
```

---

## 6. Implementation Status

| Feature                 | Parser | Compiler | Runtime | Status                                                                                     |
| ----------------------- | ------ | -------- | ------- | ------------------------------------------------------------------------------------------ |
| LIMITATIONS parsing     | ✅     | ✅       | ✅      | Complete                                                                                   |
| System prompt inclusion | -      | ✅       | ✅      | Complete                                                                                   |
| CONSTRAINTS parsing     | ✅     | ✅       | ✅      | Complete                                                                                   |
| Phase detection         | -      | ✅       | ✅      | Complete                                                                                   |
| Condition evaluation    | -      | ✅       | ✅      | Complete (CEL + legacy dual evaluator)                                                     |
| ON_FAIL actions         | -      | ✅       | ✅      | Complete (respond, block, escalate, handoff, collect_field, goto_step, retry_step, redact) |
| Backtrack limits        | -      | -        | ✅      | Complete (MAX_BACKTRACKS_PER_STEP = 3)                                                     |
| Warning severity        | -      | ✅       | ✅      | Complete (non-blocking constraint warnings)                                                |
| GUARDRAILS parsing      | ✅     | ✅       | ✅      | Complete                                                                                   |
| Input guardrails        | -      | ✅       | ✅      | Complete (pre-message check, kind=input)                                                   |
| Output guardrails       | -      | ✅       | ✅      | Complete (post-response validation)                                                        |
| Tool guardrails         | -      | ✅       | ✅      | Complete (tool_input, tool_output kinds)                                                   |
| Handoff guardrails      | -      | ✅       | ✅      | Complete (handoff kind)                                                                    |
| Guardrail 3-tier eval   | -      | -        | ✅      | Complete (CEL/regex → model → LLM)                                                         |

**Legend**: ✅ Complete | 🔶 Partial | ❌ Not implemented

### Recent Improvements (March 2026)

1. **CEL Dual Evaluator**: Constraint conditions now use a dual evaluator — CEL (Common Expression Language) for structured expressions with automatic fallback to the legacy evaluator for backward compatibility.
2. **Full ON_FAIL Control Flow**: All ON_FAIL action types are now implemented: `respond`, `block`, `escalate`, `handoff`, `collect_field`, `goto_step`, `retry_step`, and `redact`.
3. **Guardrails Fully Implemented**: The GUARDRAILS system is now fully operational with 5 guardrail kinds (input, output, tool_input, tool_output, handoff) and 3-tier evaluation (local CEL/regex, model-based, LLM-based).
4. **Input Guardrails Filtering**: The runtime filters guardrails by `kind` — only `input` kind guardrails are evaluated at pre-message time; other kinds are evaluated at their respective execution points.
5. **Warning Constraints**: Use `WARN` in text ABL to emit non-blocking constraint warnings. The IR/runtime still records those as `severity: warning`.

---

## 7. Test Coverage

### Parser Tests

From `agent-based-parser.test.ts`:

```typescript
test('should parse GUARDRAILS section', () => {
  const dsl = `
AGENT: Support

GUARDRAILS:
  no_pii_output:
    kind: output
    check: "contains_pii(content)"
    action: redact
    msg: "Always remove PII from responses"

  empathetic_tone_review:
    kind: output
    llm_check: "Does the reply acknowledge frustration?"
    action: warn
    msg: "Add empathy when needed"
`;

  const result = parseAgentBasedDSL(dsl);
  expect(result.document?.guardrails).toHaveLength(2);
});
```

### E2E Tests

From `e2e.test.ts`:

- Constraint enforcement tests
- Guardrail scenarios
- Business rule validation

---

## File Locations

| Component             | Path                                                       |
| --------------------- | ---------------------------------------------------------- |
| Constraints Parser    | `packages/core/src/parser/agent-based-parser.ts`           |
| Constraints Compiler  | `packages/compiler/src/platform/ir/compiler.ts:253-313`    |
| System Prompt Builder | `apps/platform/src/services/runtime-executor.ts:1677-1795` |

---

## Best Practices

### LIMITATIONS

- Keep limitations clear and concrete
- Focus on what the agent should avoid, decline, or explain
- Avoid complex conditional statements; move stateful rules to `CONSTRAINTS`
- Test that the agent communicates limitations consistently

### CONSTRAINTS

- Use clear labels, and add explicit `WHEN` / `BEFORE` gating when execution scope matters
- Provide clear ON_FAIL messages
- Prefer HANDOFF over BLOCK when possible
- Group related constraints under the same label

### GUARDRAILS

- Use descriptive names
- Choose appropriate action levels
- Monitor warn logs for patterns
- Test edge cases for ensure/block

---

_Last Updated: March 2026_

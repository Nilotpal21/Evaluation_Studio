# Booking With Constraints - Flow Explained

> **Document Type**: Tutorial/Walkthrough
> **Implementation Status**: ✅ All features demonstrated are fully implemented
> **Related Tests**: `hotel-booking.e2e.test.ts` (65 tests)

## Why You Might Not See FLOW in Visualization

The static graph is extracted during **compilation** (line 574 in `compiler.ts`):

```typescript
flowConfig.staticGraph = extractStaticGraph(flowConfig);
```

If you don't see the flow, check:

1. **Is the agent loaded?** The graph is only available after loading
2. **Is it flow-mode?** `MODE: scripted` is required
3. **Check the observatory store** - does `staticGraph` exist in the IR?

---

## DSL → Runtime Execution Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              COMPILATION TIME                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  booking_with_constraints.agent.dsl                                          │
│           │                                                                  │
│           ▼                                                                  │
│  ┌─────────────────┐                                                         │
│  │ parseAgentBasedDSL│ → AST (Abstract Syntax Tree)                          │
│  └────────┬────────┘                                                         │
│           │                                                                  │
│           ▼                                                                  │
│  ┌─────────────────┐                                                         │
│  │ compileDSLtoIR  │ → AgentIR (includes flow, constraints, tools)           │
│  └────────┬────────┘                                                         │
│           │                                                                  │
│           ▼                                                                  │
│  ┌─────────────────────┐                                                     │
│  │ extractStaticGraph  │ → StaticGraph (for visualization)                   │
│  └─────────────────────┘                                                     │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                               RUNTIME                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  User message arrives via WebSocket                                          │
│           │                                                                  │
│           ▼                                                                  │
│  RuntimeExecutor.executeMessage()                                            │
│           │                                                                  │
│           ├──→ input/tool guardrail pipeline ──→ guardrails                  │
│           │                                                                  │
│           ├──→ checkFlatConstraintsAtCheckpoint() ──→ active constraints     │
│           │                                                                  │
│           └──→ FlowStepExecutor.executeFlowStep()                            │
│                ├──→ evaluateOnInput() / gather extraction / corrections      │
│                ├──→ executeToolWithGuardrails() ──→ CALL                     │
│                └──→ transitions / ON_SUCCESS / ON_FAIL / THEN                │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Step-by-Step Execution Trace

### 1. WELCOME Step

```yaml
welcome:
  PROMPT: 'Welcome to Hotel Booking! ... What destination?'
  COLLECT:
    - destination
  THEN: collect_trip_info
```

**Runtime behavior:**

```
1. Session starts, currentStep = "welcome"
2. No user input yet → show PROMPT
3. User says "Paris"
4. extractEntities() → LLM extracts { destination: "Paris" }
5. COLLECT satisfied → THEN: collect_trip_info
```

### 2. COLLECT_TRIP_INFO Step

```yaml
collect_trip_info:
  PROMPT: 'When would you like to stay, and how many guests?'
  GATHER:
    FIELDS:
      - checkin_date: required
      - checkout_date: required
      - num_guests: required
    STRATEGY: llm
  CHECK: destination != "" AND num_guests <= 10 # ← INLINE STEP CHECK!
  THEN: search_and_show
```

**Runtime behavior:**

```
1. Show PROMPT
2. User: "Feb 10-15, 3 guests"
3. GATHER with STRATEGY: llm
   └─→ LLM extracts { checkin_date: "2024-02-10", checkout_date: "2024-02-15", num_guests: 3 }
4. CHECK evaluates `destination != "" AND num_guests <= 10`
   └─→ destination != "" ✓ ("Paris" != "")
   └─→ num_guests <= 10  ✓ (3 <= 10)
5. The inline guard passes → THEN: search_and_show
```

### 3. SEARCH_AND_SHOW Step (CALL + ON_SUCCESS)

```yaml
search_and_show:
  CALL: search_hotels(destination, checkin_date, checkout_date, num_guests)
  ON_SUCCESS:
    RESPOND: |
      I found these hotels in {{destination}}:
      {{#each hotels}}
      {{add @index 1}}. {{name}} - ${{price}}/night
      {{/each}}
    THEN: select_hotel
  ON_FAIL:
    RESPOND: 'Sorry, no hotels found...'
    THEN: collect_trip_info
```

**Runtime behavior:**

```
1. CALL: search_hotels(...)
   │
   ├─→ Parse tool call: search_hotels(destination=Paris, checkin=..., ...)
   │
   ├─→ FlowStepExecutor.executeToolWithGuardrails(...)
   │   │
   │   └─→ Tool executor returns:
   │       {
   │         hotels: [
   │           { id: 'hotel-1', name: 'Grand Hotel Paris', price: 180, ... },
   │           { id: 'hotel-2', name: 'City Inn', price: 95, ... },
   │           { id: 'hotel-3', name: 'Comfort Suites', price: 120, ... }
   │         ],
   │         total: 3
   │       }
   │
   └─→ Result merged into session.data.values

2. ON_SUCCESS (because hotels.length > 0):
   │
   ├─→ RESPOND with Handlebars template interpolation:
   │   "I found these hotels in Paris:
   │    1. Grand Hotel Paris - $180/night
   │    2. City Inn - $95/night
   │    3. Comfort Suites - $120/night"
   │
   └─→ THEN: select_hotel
```

### 4. SELECT_HOTEL Step (ON_INPUT branching)

```yaml
select_hotel:
  COLLECT:
    - hotel_selection
  ON_INPUT:
    - IF: input is_number AND input >= 1 AND input <= hotels.length
      SET: selected_hotel = hotels[input - 1]
      SET: need_price_quote = true
      THEN: collect_guest_info
    - ELSE:
      RESPOND: "Please enter a valid hotel number."
```

**Runtime behavior:**

```
1. Wait for user input
2. User: "2"
3. ON_INPUT evaluation:
   │
   ├─→ Branch 1: IF: input is_number AND input >= 1 AND input <= hotels.length
   │   │
   │   ├─→ evaluateCondition("input is_number", { input: "2" }) → true (Number("2") is valid)
   │   ├─→ evaluateCondition("input >= 1", { input: 2 }) → true
   │   └─→ evaluateCondition("input <= hotels.length", { input: 2, hotels: [...] }) → true (2 <= 3)
   │
   │   All conditions true! Execute:
   │   ├─→ SET: selected_hotel = hotels[input - 1]  → hotels[1] = { name: "City Inn", ... }
   │   ├─→ SET: need_price_quote = true
   │   └─→ THEN: collect_guest_info
   │
   └─→ (ELSE branch not evaluated)
```

### 5. COLLECT_GUEST_INFO Step

```yaml
collect_guest_info:
  PROMPT: 'Please provide guest details (name, email):'
  GATHER:
    FIELDS:
      - guest_name: required
      - guest_email: required
  CHECK: selected_hotel != null AND estimated_total <= 5000 AND guest_name != ""
  THEN: review_and_book
```

**Runtime behavior:**

```
1. Show PROMPT
2. User: "John Doe, john@example.com"
3. GATHER extracts { guest_name: "John Doe", guest_email: "john@example.com" }
4. CHECK evaluates the inline expression:
   │
   ├─→ selected_hotel != null ✓ (City Inn is selected)
   ├─→ estimated_total <= 5000 ✓ (or fails if over $5000)
   └─→ guest_name != "" ✓ ("John Doe" != "")

5. All pass → THEN: review_and_book
```

### 6. REVIEW_AND_BOOK Step (Complex ON_INPUT)

```yaml
review_and_book:
  PRESENT: |
    Please review your booking:
    Hotel: {{selected_hotel.name}}
    ...
  ON_INPUT:
    - IF: input == "confirm" OR input == "yes"
      CALL: create_booking(...)
      ON_SUCCESS:
        SET: booking_confirmed = true
        THEN: COMPLETE
    - IF: input == "change"
      RESPOND: 'What would you like to change?'
      THEN: collect_trip_info
    - ELSE:
      RESPOND: "Please type 'confirm' to proceed..."
```

---

## CONSTRAINTS and CHECK Deep Dive

```yaml
CONSTRAINTS:
  search_rules:                  # Label for related search rules
    - REQUIRE num_guests <= 10
      ON_FAIL: RESPOND "Sorry, we cannot accommodate more than 10 guests..."
    - REQUIRE destination != ""
      ON_FAIL: RESPOND "Please provide a destination first."

  booking_rules:                 # Label for related booking rules
    - REQUIRE selected_hotel != null
      ON_FAIL: RESPOND "Please select a hotel..."
    - REQUIRE estimated_total <= 5000
      ON_FAIL: ESCALATE "Booking exceeds $5000 limit..."
```

Constraint labels are organizational only. Reusable constraints are scoped with
`WHEN` or structural `BEFORE`, while flow-step `CHECK` is a separate inline
boolean guard.

**How `CHECK` works in the flow runtime:**

```typescript
if (step.check) {
  const checkPassed = evaluateConditionDual(step.check, session.data.values);
  if (!checkPassed) {
    // Emit trace + follow the step's normal failure path
  }
}
```

The runtime:

1. Evaluates `step.check` directly against `session.data.values`
2. Emits a `constraint_check` trace for that inline expression
3. Follows the step's `ON_FAIL` branch if the expression is false
4. Continues to `THEN` when the expression is true

---

## Mock Tool Response Flow

```
┌────────────────────────────────────────────────────────────────────────────┐
│  CALL: search_hotels(destination, checkin_date, checkout_date, num_guests) │
└────────────────────────────────────────────┬───────────────────────────────┘
                                             │
                                             ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  runtime-executor.ts: executeToolCall()                                     │
│  │                                                                          │
│  ├─→ Parse tool name: "search_hotels"                                       │
│  ├─→ Parse params: { destination: "Paris", checkin: "...", ... }            │
│  │                                                                          │
│  └─→ Look up in mockToolResults:                                            │
│      mockToolResults['search_hotels'](params) → returns hotels array        │
└────────────────────────────────────────────┬───────────────────────────────┘
                                             │
                                             ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  Result stored in session.flowCollectedData:                                │
│  {                                                                          │
│    destination: "Paris",                                                    │
│    checkin_date: "2024-02-10",                                              │
│    hotels: [ {...}, {...}, {...} ],  ← Tool result merged in               │
│    total: 3                                                                 │
│  }                                                                          │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## ON_INPUT Evaluation Flow

```typescript
if (step.on_input?.length) {
  const branchResult = evaluateOnInput(step.on_input, userMessage, session.data.values);

  if (branchResult?.set) {
    Object.assign(session.data.values, branchResult.set);
  }

  if (branchResult?.call) {
    const callResult = await executeToolWithGuardrails(session, branchResult.call, params);
    Object.assign(session.data.values, callResult);
  }

  if (branchResult) {
    return { response: branchResult.respond, nextStep: branchResult.then };
  }
}
```

The current `evaluateOnInput()` flow:

1. Iterates through each IF/ELSE branch
2. Evaluates the condition (e.g., `input is_number AND input >= 1`)
3. Returns the first matching branch's actions (SET, RESPOND, THEN, CALL)
4. `FlowStepExecutor.executeFlowStep()` applies those actions against `session.data.values`

---

## Summary: Data Flow Through the System

```
User Message
     │
     ▼
┌─────────────┐
│ WebSocket   │
│ Handler     │
└─────┬───────┘
      │
      ▼
┌─────────────────────────────────────────────────────────────────┐
│             RuntimeExecutor + FlowStepExecutor                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ session.data.values = {                                    │ │
│  │   destination: "Paris",                                    │ │
│  │   checkin_date: "2024-02-10",                              │ │
│  │   num_guests: 3,                                           │ │
│  │   hotels: [...],           ← From CALL result              │ │
│  │   selected_hotel: {...},   ← From SET                      │ │
│  │   guest_name: "John Doe",  ← From GATHER                   │ │
│  │ }                                                          │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  Flow: welcome → collect_trip_info → search_and_show →          │
│        select_hotel → collect_guest_info → review_and_book →    │
│        COMPLETE                                                  │
└─────────────────────────────────────────────────────────────────┘
      │
      ▼
Response sent via WebSocket → UI renders
```

---

## Implementation Status

All features demonstrated in this document are **fully implemented**:

| Feature                   | Status      | Location                                                         |
| ------------------------- | ----------- | ---------------------------------------------------------------- |
| Flow step execution       | ✅ Complete | `apps/runtime/src/services/execution/flow-step-executor.ts`      |
| GATHER/COLLECT extraction | ✅ Complete | `apps/runtime/src/services/execution/flow-step-executor.ts`      |
| ON_INPUT branching        | ✅ Complete | `packages/compiler/src/platform/constructs/utils.ts`             |
| CALL tool execution       | ✅ Complete | `apps/runtime/src/services/execution/flow-step-executor.ts`      |
| Constraint checking       | ✅ Complete | `apps/runtime/src/services/execution/constraint-checker.ts`      |
| Template rendering        | ✅ Complete | `apps/runtime/src/services/execution/value-resolution.ts`        |
| Static graph extraction   | ✅ Complete | `packages/compiler/src/platform/constructs/flow-static-graph.ts` |

## Test Coverage

This flow is covered in the runtime test suite, including:

- `apps/runtime/src/__tests__/hotel-booking.e2e.test.ts`
- `apps/runtime/src/__tests__/flow-detect-intent-constraints.test.ts`
- `apps/runtime/src/__tests__/flow-constraint-minicollect.test.ts`
- `apps/runtime/src/__tests__/flow-on-result.test.ts`

## Related Files

- DSL: `examples/flow-test/booking_with_constraints.agent.dsl`
- Runtime: `apps/runtime/src/services/runtime-executor.ts`
- Flow execution: `apps/runtime/src/services/execution/flow-step-executor.ts`
- Tests: `apps/runtime/src/__tests__/hotel-booking.e2e.test.ts`

# Flow Control

> **Estimated time**: 35 minutes | **Prerequisites**: Basic ABL agent structure, GATHER fundamentals

## Learning Objectives

After completing this module, you will be able to:

- Build structured execution flows with steps, transitions, and entry points
- Understand why `REASONING` is required on every step and when to use `true` vs `false`
- Use the `CALL` action with `WITH` parameter mapping and `AS` result binding
- Define `WHEN` entry guards to conditionally skip steps
- Configure `global_digressions` for cross-step intent handling
- Use `TRANSFORM` with `INTO` to filter, reshape, and store array data

## Why Flow Control Matters

Reasoning agents are powerful -- they autonomously decide actions based on a goal. But some processes demand precision: compliance workflows, payment processing, identity verification, multi-step data collection. You cannot leave the order of operations to LLM judgment when regulations or business logic require a specific sequence.

The `FLOW:` section gives an agent a structured step graph. Each step declares actions (collect data, call tools, respond, branch) and transitions to other steps. The critical design choice in ABL is that reasoning and deterministic execution can coexist in the same agent: some steps let the LLM think freely, while others follow an exact script.

## Flow Structure

A flow defines an ordered list of steps, an entry point, and step definitions:

```abl
FLOW:
  entry_point: greeting

  steps:
    - greeting
    - collect_info
    - process
    - complete

  greeting:
    REASONING: false
    RESPOND: "Welcome! Let me help you get started."
    THEN: collect_info

  collect_info:
    REASONING: false
    GATHER:
      - name: required
        prompt: "What is your name?"
    THEN: process

  process:
    REASONING: false
    CALL: process_request
      WITH:
        name: name
      AS: result
    RESPOND: "Done! Your request has been processed."
    THEN: complete

  complete:
    REASONING: false
    RESPOND: "Thank you for using our service. Goodbye!"
```

The `entry_point` declares where execution begins. If omitted, execution starts at the first step in the `steps` array. The `steps` array establishes the canonical ordering, but steps can transition to any other step -- not just the next in sequence.

## REASONING: Required on Every Step

> **Key Concept**: Every step in a `FLOW:` section **must** declare `REASONING: true` or `REASONING: false`. This is not optional. This toggle controls whether the step uses LLM reasoning (autonomous decision-making) or deterministic execution (scripted actions).

This requirement exists because ABL agents are hybrid by design. A single agent can mix autonomous reasoning zones (where the LLM decides what to do) with scripted steps (where the flow dictates exactly what happens). The `REASONING` toggle makes this distinction explicit at every step.

### When to Use `REASONING: false`

Use deterministic execution for steps that must follow an exact sequence: data collection, tool calls with specific parameters, conditional branching based on known values, and compliance checks.

```abl
verify_identity:
  REASONING: false
  CALL: verify_account
    WITH:
      account_id: source_account
    AS: acctResult
  ON_RESULT:
    - IF: acctResult.status == "active"
      RESPOND: "Account verified."
      THEN: proceed
    - ELSE:
      RESPOND: "Account not found."
      THEN: collect_account
```

### When to Use `REASONING: true`

Use LLM reasoning for steps where the agent needs to analyze, interpret, or decide based on context:

```abl
analyze_request:
  REASONING: true
  GOAL: "Analyze the customer's request and determine the best course of action"
  AVAILABLE_TOOLS: [search_knowledge, classify_intent]
  EXIT_WHEN: intent_classified == true
  MAX_TURNS: 5
  THEN: route_request
```

When `REASONING: true`, additional properties become available:

| Property           | Purpose                                                  |
| ------------------ | -------------------------------------------------------- |
| `GOAL`             | Step-specific goal (overrides agent-level goal)          |
| `AVAILABLE_TOOLS`  | Subset of agent tools available in this step             |
| `EXIT_WHEN`        | Condition that ends the reasoning loop                   |
| `MAX_TURNS`        | Maximum reasoning turns before forced exit (default: 10) |
| `STEP_CONSTRAINTS` | Constraints specific to this reasoning zone              |

## The CALL Action with WITH and AS

`CALL` invokes a tool deterministically. `WITH` maps parameters, and `AS` binds the result to a variable:

```abl
calculate_fees:
  REASONING: false
  CALL: calculate_fees
    WITH:
      transfer_type: transfer_type
      amount: amount
      currency: currency
      destination_country: beneficiary_country
    AS: feeResult
  RESPOND: "The fee for this transfer is {{feeResult.fee}} {{feeResult.currency}}."
  THEN: confirm_transfer
```

> **Key Concept**: The `WITH` block maps tool parameter names to values. Values can be variable references (`amount` resolves to the session variable `amount`), literal strings (`"domestic"`), or expressions (`COALESCE(reference, "")`). The `AS` keyword binds the entire tool result to a named variable (`feeResult`) that you can reference in subsequent actions within the same step or later steps.

### Branching on Tool Results

Use `ON_RESULT` for multi-way branching based on what the tool returns:

```abl
check_stock:
  REASONING: false
  CALL: check_inventory
    WITH:
      product_id: product_id
    AS: stockResult
  ON_RESULT:
    - IF: stockResult.available == true
      SET:
        stock_quantity = stockResult.quantity
      RESPOND: "We have {{stock_quantity}} in stock."
      THEN: collect_quantity
    - ELSE:
      THEN: out_of_stock
```

For simpler success/failure branching, use `ON_SUCCESS` and `ON_FAILURE`:

```abl
place:
  REASONING: false
  CALL: place_order
    WITH:
      product_id: product_id
      quantity: quantity
    AS: orderResult
  ON_SUCCESS:
    RESPOND: "Order placed! ID: {{orderResult.order_id}}"
    THEN: done
  ON_FAILURE:
    RESPOND: "Failed to place order. Please try again."
    THEN: done
```

## WHEN Entry Guards

The `WHEN` property on a step defines a condition that must be true for the step to execute. If the condition is false, the step is skipped entirely and execution moves to the next transition:

```abl
international_details:
  REASONING: false
  WHEN: "transfer_type == 'international'"
  GATHER:
    - swift_code: required
      prompt: "What is the SWIFT/BIC code?"
    - iban: required
      prompt: "What is the IBAN?"
  THEN: validate_details

domestic_details:
  REASONING: false
  WHEN: "transfer_type == 'domestic'"
  GATHER:
    - routing_number: required
      prompt: "What is the routing number?"
  THEN: validate_details
```

> **Key Concept**: `WHEN` entry guards create conditional paths without explicit branching logic. The step simply does not execute if the condition is false. This is cleaner than wrapping every step in IF/ELSE blocks and makes the flow graph easier to read. Use entry guards when you have parallel paths that depend on a previously collected or computed value.

Entry guards evaluate against the current session state. Any session variable, gathered field, or tool result that has been set earlier in the flow is available for guard conditions.

## Global Digressions for Cross-Step Intent Handling

Digressions handle user intents that can occur at any point in the conversation, regardless of which step is active. Step-level digressions are scoped to a single step, but **global digressions** are available everywhere:

```abl
FLOW:
  steps:
    - welcome
    - collect_info
    - search
    - confirm

  global_digressions:
    - INTENT: "cancel"
      RESPOND: "Booking cancelled. Would you like to start over?"
      GOTO: welcome
    - INTENT: "help"
      RESPOND: "I can help you find and book hotels. Tell me your destination and dates."
      RESUME: true
    - INTENT: "speak to agent"
      RESPOND: "Connecting you with a live agent."
      DELEGATE: Live_Agent_Transfer
```

> **Key Concept**: `global_digressions` are declared at the flow level and are active in every step. When `RESUME: true`, the user returns to the interrupted step after the digression is handled -- perfect for "help" or "what is X?" questions. When `GOTO` is specified instead, the flow transitions permanently to that step. Without `RESUME`, the digression replaces the current step entirely.

### Step-Level Digressions vs. Sub-Intents

Within a single step, you can use either digressions or sub-intents:

```abl
collect_beneficiary:
  REASONING: false
  GATHER:
    FIELDS:
      - name: required
      - account: required
      - bank: required

  DIGRESSIONS:
    - INTENT: "what is swift"
      RESPOND: "A SWIFT code is an 8 or 11 character code identifying a bank."
      RESUME: true
    - INTENT: "cancel"
      GOTO: cleanup

  SUB_INTENTS:
    - INTENT: "change name"
      CLEAR: [name]
      RESPOND: "What is the correct name?"
    - INTENT: "change account"
      CLEAR: [account]
      RESPOND: "What is the correct account number?"
```

**Digressions** can leave the current step (`GOTO`) or return to it (`RESUME`). **Sub-intents** always stay in the current step (they default to `RESUME: true`) and are used for corrections -- clearing variables and re-collecting them.

## TRANSFORM with INTO

The `TRANSFORM` action filters, maps, sorts, and limits array data in a single pipeline, storing the result in a new variable via `INTO`:

```abl
filter_results:
  REASONING: false
  TRANSFORM:
    SOURCE: search_results
    AS: hotel
    INTO: filtered_hotels
    FILTER: "hotel.rating >= 4"
    MAP:
      name: hotel.name
      price: hotel.price_per_night
      rating: hotel.rating
    SORT_BY: price asc
    LIMIT: 5
  THEN: show_results
```

> **Key Concept**: The `TRANSFORM INTO` property specifies the output variable name. The transform creates a new variable (`filtered_hotels`) without modifying the source array (`search_results`). The pipeline applies in order: FILTER narrows the array, MAP reshapes each element, SORT_BY orders the result, and LIMIT caps the count.

| Property  | Required | Purpose                                          |
| --------- | -------- | ------------------------------------------------ |
| `SOURCE`  | Yes      | Dot-path to the source array                     |
| `AS`      | Yes      | Loop variable name for referencing elements      |
| `INTO`    | Yes      | Output variable name                             |
| `FILTER`  | No       | Condition expression to include/exclude elements |
| `MAP`     | No       | Field mapping to reshape elements                |
| `SORT_BY` | No       | Sort field and direction (`asc` or `desc`)       |
| `LIMIT`   | No       | Maximum number of items in the output            |

You can use TRANSFORM with only some of its properties. Filter-only:

```abl
TRANSFORM:
  SOURCE: all_bookings AS booking
  INTO: active_bookings
  FILTER: booking.status == "active"
```

Map-only (reshape without filtering):

```abl
TRANSFORM:
  SOURCE: raw_results AS item
  INTO: formatted_results
  MAP:
    title: item.name
    summary: item.description
```

## Other Step Actions

### SET: Assign Session Variables

```abl
init:
  REASONING: false
  SET:
    status = "pending"
    retry_count = 0
  THEN: next_step
```

SET supports arithmetic, dot-notation, and built-in functions: `FORMAT_CURRENCY(amount, "USD")`, `COALESCE(value, "default")`, `ADD(a, b)`, `NOW()`, `UNIQUE_ID(12)`.

### CHECK: Evaluate Conditions

```abl
check_limits:
  REASONING: false
  CHECK: amount <= available_balance
  ON_FAIL: over_limit
  THEN: proceed
```

### CLEAR: Remove Variables

```abl
restart_search:
  REASONING: false
  CLEAR: [destination, checkin_date, checkout_date]
  RESPOND: "Let's start fresh."
  THEN: collect_trip_info
```

### MAX_ATTEMPTS: Limit Step Re-entry

```abl
collect_pin:
  REASONING: false
  MAX_ATTEMPTS: 3
  ON_EXHAUSTED: lockout
  GATHER:
    - pin: required
      prompt: "Enter your PIN."
  THEN: verify_pin
```

## Interactive Actions

Steps can present buttons, dropdowns, and input fields:

```abl
choose_option:
  REASONING: false
  RESPOND: "How would you like to proceed?"
  ACTIONS:
    - id: "option_wire"
      type: button
      label: "Wire Transfer"
      value: "wire"
    - id: "option_ach"
      type: button
      label: "ACH Transfer"
      value: "ach"
  ON_ACTION:
    - ACTION: "option_wire"
      SET:
        transfer_method = "wire"
      THEN: wire_flow
    - ACTION: "option_ach"
      SET:
        transfer_method = "ach"
      THEN: ach_flow
```

## Putting It All Together

Here is a complete flow that demonstrates many of the concepts covered:

```abl
FLOW:
  entry_point: welcome
  steps:
    - welcome
    - collect_product
    - check_stock
    - collect_quantity
    - confirm
    - place
    - done

  global_digressions:
    - INTENT: "cancel"
      RESPOND: "Order cancelled."
      GOTO: done

  welcome:
    REASONING: false
    RESPOND: "Welcome! What product are you looking for?"
    THEN: collect_product

  collect_product:
    REASONING: false
    GATHER:
      - product_id: required
        prompt: "What is the product ID?"
    THEN: check_stock

  check_stock:
    REASONING: false
    CALL: check_inventory
      WITH:
        product_id: product_id
      AS: stockResult
    ON_RESULT:
      - IF: stockResult.available == true
        SET:
          stock_quantity = stockResult.quantity
        THEN: collect_quantity
      - ELSE:
        RESPOND: "Sorry, that product is out of stock."
        THEN: done

  collect_quantity:
    REASONING: false
    GATHER:
      - quantity: required
        type: number
        prompt: "How many would you like?"
    CHECK: quantity <= stock_quantity
    ON_FAIL: collect_quantity
    THEN: confirm

  confirm:
    REASONING: false
    RESPOND: "Order {{quantity}} of {{product_id}}. Confirm?"
    ACTIONS:
      - id: "yes"
        type: button
        label: "Confirm"
      - id: "no"
        type: button
        label: "Cancel"
    ON_ACTION:
      - ACTION: "yes"
        THEN: place
      - ACTION: "no"
        THEN: done

  place:
    REASONING: false
    CALL: place_order
      WITH:
        product_id: product_id
        quantity: quantity
      AS: orderResult
    ON_SUCCESS:
      RESPOND: "Order placed! ID: {{orderResult.order_id}}"
      THEN: done
    ON_FAILURE:
      RESPOND: "Failed to place order."
      THEN: done

  done:
    REASONING: false
    RESPOND: "Thank you!"
```

## Key Takeaways

- `REASONING` is required on every step -- `false` for deterministic execution, `true` for LLM-driven steps with goals and tool access
- `CALL` with `WITH` maps parameters to tool inputs and `AS` binds the result for downstream use
- `WHEN` entry guards skip steps conditionally without explicit IF/ELSE branching
- `global_digressions` handle cross-step intents like "cancel", "help", and "speak to agent" -- use `RESUME: true` to return to the interrupted step
- `TRANSFORM INTO` creates a new filtered/mapped/sorted array without modifying the source data

## What's Next

With flow control mastered, explore the **Memory & State** module to learn how session variables persist across steps and how persistent memory bridges sessions. Or dive into the **Tools & Integrations** module to learn about the tools your flows can call.

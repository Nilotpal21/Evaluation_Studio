# DSL Extensions: SET, CLEAR, CALL WITH/AS, ON_RESULT, TRANSFORM

> **Last Updated**: February 2026

These extensions enhance Flow mode (scripted agents) with data manipulation, explicit tool integration, and array processing capabilities. All extensions compile to the AgentIR `FlowStep` interface and execute via the FlowExecutor.

---

## Overview

| Extension        | Purpose                                                           | IR Fields                                              |
| ---------------- | ----------------------------------------------------------------- | ------------------------------------------------------ |
| **SET**          | Variable assignment with expressions                              | `set: SetAssignmentIR[]`                               |
| **CLEAR**        | Delete session variables                                          | `clear: string[]`                                      |
| **CALL WITH/AS** | Explicit tool params + result binding                             | `call_with: Record<string, string>`, `call_as: string` |
| **ON_RESULT**    | Multi-way branching on tool results or deterministic flow context | `on_result: InputBranch[]`                             |
| **TRANSFORM**    | Array pipeline (filter/map/sort/limit)                            | `transform: TransformConfigIR`                         |

---

## YAML Format Support

All DSL extensions work in both the traditional `.agent.abl` format (uppercase keywords) and the `.agent.yaml` format (lowercase keywords). Keywords are case-insensitive.

**Traditional format** (`.agent.abl`):

```dsl
FLOW:
  init:
    SET:
      currency = COALESCE(preferred_currency, "USD")
    THEN: next_step
```

**YAML format** (`.agent.yaml`):

```yaml
flow:
  init:
    set:
      currency: COALESCE(preferred_currency, "USD")
    then: next_step
```

The runtime auto-detects the format via `isYamlFormat()`. Export uses `serializeToYAML()` which outputs lowercase keywords.

---

## SET — Variable Assignment

Assign computed values to variables. Supports built-in functions, dot-path variable references, and nested function calls.

### Block Form (step-level, multiple assignments)

```dsl
init:
  SET:
    preferred_currency = COALESCE(preferred_currency, "USD")
    request_timestamp = NOW()
    transfer_id = UNIQUE_ID(10)
    account_count = LENGTH(accountsResult.accounts)
  THEN: next_step
```

### Inline Form (in ON_INPUT/ON_RESULT branches)

```dsl
ON_INPUT:
  - ELSE:
    SET:
      transfer_amount = TO_NUMBER(REPLACE(REPLACE(raw_amount, "$", ""), ",", ""))
    THEN: check_limits
```

### IR Representation

```typescript
interface SetAssignmentIR {
  variable: string; // e.g., "transfer_id"
  expression: string; // e.g., "UNIQUE_ID(10)"
}
```

---

## CLEAR — Variable Deletion

Remove one or more variables from the session context. Used to reset state when looping back to earlier steps.

```dsl
cleanup:
  CLEAR: transfer_amount, raw_amount, recipient_routing, recipient_account, recipientResult, limitsResult, feeResult, execResult
  RESPOND: "Is there anything else I can help you with?"
  THEN: COMPLETE
```

Within ON_INPUT branches:

```dsl
ON_INPUT:
  - IF: input contains "change"
    CLEAR: from_date, to_date, txnResult, filtered_transactions
    THEN: collect_date_range
```

---

## CALL WITH/AS — Explicit Tool Parameters and Result Binding

### WITH: Explicit Parameter Mapping

Maps named parameters to expressions instead of relying on positional arguments.

```dsl
fetch_accounts:
  CALL: get_accounts
    WITH:
      customer_id: customer_id
    AS: accountsResult
```

Parameter values can be:

- Session variables: `customer_id`
- Dot-path references: `selected_account.id`
- Built-in function calls: `MUL(page_size, 3)`
- String literals: `"USD"`

### AS: Result Variable Binding

Binds the tool's return value to a named variable for use in subsequent ON_RESULT branches, SET expressions, or RESPOND templates.

```dsl
CALL: get_balance
  WITH:
    account_id: selected_account.id
    currency: preferred_currency
  AS: balanceResult
ON_RESULT:
  - IF: balanceResult.available != null
    THEN: display_balance
  - ELSE:
    RESPOND: "Unable to retrieve balance."
    THEN: show_accounts
```

---

## ON_RESULT — Multi-Way Result Branching

Replaces the simple ON_SUCCESS/ON_FAIL pattern when a tool call can produce more than two distinct outcomes.

```dsl
validate_recipient_step:
  CALL: validate_recipient
    WITH:
      routing_number: recipient_routing
      account_number: recipient_account
    AS: recipientResult
  ON_RESULT:
    - IF: recipientResult.status == "valid"
      SET:
        recipient_bank = recipientResult.bank_name
        recipient_name = recipientResult.account_holder
      THEN: collect_amount
    - IF: recipientResult.status == "INVALID_ROUTING"
      RESPOND: "The routing number is invalid."
      THEN: collect_recipient
    - IF: recipientResult.status == "ACCOUNT_CLOSED"
      RESPOND: "That account appears to be closed."
      THEN: collect_recipient
    - ELSE:
      RESPOND: "We couldn't verify the recipient details."
      THEN: collect_recipient
```

Each ON_RESULT branch supports: `IF`/`ELSE`, `SET`, `CLEAR`, `RESPOND`, and `THEN`.

---

## TRANSFORM — Array Data Pipeline

Process arrays through a declarative pipeline with optional filter, map, sort, and limit stages.

```dsl
apply_filters:
  TRANSFORM: txnResult.transactions AS txn INTO filtered_transactions
    FILTER: filter_type == "all" OR txn.type == filter_type
    MAP:
      id: txn.id
      date: FORMAT_DATE(txn.date, "MMM DD")
      description: COALESCE(txn.merchant, txn.description)
      display_amount: FORMAT_CURRENCY(ABS(txn.amount), "USD")
      direction: UPPER(SUBSTRING(txn.type, 0, 1))
      category: UPPER(txn.category)
    SORT_BY: date DESC
    LIMIT: page_size
  SET:
    result_count = LENGTH(filtered_transactions)
  THEN: display_transactions
```

### Pipeline Stages

| Stage      | Required | Description                                                 |
| ---------- | -------- | ----------------------------------------------------------- |
| `FILTER:`  | No       | Boolean expression; keep items where condition is true      |
| `MAP:`     | No       | Object with field → expression mappings (executed per item) |
| `SORT_BY:` | No       | Field name with `ASC` or `DESC` (default: ASC)              |
| `LIMIT:`   | No       | Maximum number of items (expression or literal)             |

### IR Representation

```typescript
interface TransformConfigIR {
  source: string; // "txnResult.transactions"
  item_var: string; // "txn"
  target: string; // "filtered_transactions"
  filter?: string; // Boolean expression
  map?: Record<string, string>; // Field → expression
  sort_by?: { field: string; order: 'asc' | 'desc' };
  limit?: number;
}
```

---

## Built-in Functions (35)

All functions are available in SET expressions, TRANSFORM MAP/FILTER, CALL WITH values, and RESPOND templates. Functions can be nested: `FORMAT_CURRENCY(ABS(txn.amount), "USD")`.

### Math

| Function | Signature                      | Description                       |
| -------- | ------------------------------ | --------------------------------- |
| `ADD`    | `ADD(a, b) → number`           | Addition                          |
| `SUB`    | `SUB(a, b) → number`           | Subtraction                       |
| `MUL`    | `MUL(a, b) → number`           | Multiplication                    |
| `DIV`    | `DIV(a, b) → number\|null`     | Division (null on divide-by-zero) |
| `ROUND`  | `ROUND(n, decimals?) → number` | Round to N decimals (default: 0)  |
| `ABS`    | `ABS(n) → number`              | Absolute value                    |
| `MIN`    | `MIN(a, b) → number`           | Minimum of two values             |
| `MAX`    | `MAX(a, b) → number`           | Maximum of two values             |

### String

| Function    | Signature                                | Description             |
| ----------- | ---------------------------------------- | ----------------------- |
| `UPPER`     | `UPPER(s) → string`                      | Uppercase               |
| `LOWER`     | `LOWER(s) → string`                      | Lowercase               |
| `TRIM`      | `TRIM(s) → string`                       | Strip whitespace        |
| `SUBSTRING` | `SUBSTRING(s, start, end?) → string`     | Extract substring       |
| `REPLACE`   | `REPLACE(s, find, replacement) → string` | Replace all occurrences |
| `SPLIT`     | `SPLIT(s, delimiter) → array`            | Split to array          |
| `JOIN`      | `JOIN(arr, delimiter) → string`          | Join array to string    |
| `PAD_START` | `PAD_START(s, length, char?) → string`   | Pad start               |
| `PAD_END`   | `PAD_END(s, length, char?) → string`     | Pad end                 |
| `REPEAT`    | `REPEAT(s, count) → string`              | Repeat N times          |

### Formatting

| Function          | Signature                                        | Description                                |
| ----------------- | ------------------------------------------------ | ------------------------------------------ |
| `MASK`            | `MASK(s, pattern, char?) → string`               | Mask string (e.g., `"last4"` → `****1234`) |
| `FORMAT_CURRENCY` | `FORMAT_CURRENCY(n, currency, locale?) → string` | Format as currency (`$1,234.56`)           |
| `FORMAT_DATE`     | `FORMAT_DATE(d, format, tz?) → string`           | Format date (`"MMM DD, YYYY"`)             |
| `ORDINAL`         | `ORDINAL(n) → string`                            | Ordinal suffix (`1` → `"1st"`)             |

### Type

| Function    | Signature                     | Description                     |
| ----------- | ----------------------------- | ------------------------------- |
| `IS_ARRAY`  | `IS_ARRAY(x) → boolean`       | Check if array                  |
| `IS_NUMBER` | `IS_NUMBER(x) → boolean`      | Check if number                 |
| `IS_STRING` | `IS_STRING(x) → boolean`      | Check if string                 |
| `TO_NUMBER` | `TO_NUMBER(x) → number\|null` | Convert to number (null if NaN) |
| `TO_STRING` | `TO_STRING(x) → string`       | Convert to string               |

### Array

| Function           | Signature                                      | Description                       |
| ------------------ | ---------------------------------------------- | --------------------------------- |
| `LENGTH`           | `LENGTH(x) → number`                           | Array or string length            |
| `ARRAY_FIND`       | `ARRAY_FIND(arr, field, value) → object\|null` | Find first match                  |
| `ARRAY_FIND_INDEX` | `ARRAY_FIND_INDEX(arr, field, value) → number` | Index of first match (-1 if none) |

### Object

| Function        | Signature                        | Description                     |
| --------------- | -------------------------------- | ------------------------------- |
| `OBJECT_KEYS`   | `OBJECT_KEYS(obj) → array`       | Get keys                        |
| `OBJECT_VALUES` | `OBJECT_VALUES(obj) → array`     | Get values                      |
| `OBJECT_MERGE`  | `OBJECT_MERGE(...objs) → object` | Merge objects (later overrides) |

### Utility

| Function    | Signature                     | Description                |
| ----------- | ----------------------------- | -------------------------- |
| `COALESCE`  | `COALESCE(...args) → any`     | First non-null value       |
| `NOW`       | `NOW() → string`              | Current ISO 8601 timestamp |
| `UNIQUE_ID` | `UNIQUE_ID(length?) → string` | Random alphanumeric ID     |

---

## Example: BankNexus Agents

The `examples/banknexus/` project demonstrates all DSL extensions across 3 scripted agents:

| Agent                   | Extensions Used                                | Built-in Functions                                                                             |
| ----------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Get_Balance**         | SET, CLEAR, CALL WITH/AS, ON_RESULT            | COALESCE, NOW, LENGTH, UPPER, MASK, FORMAT_CURRENCY, FORMAT_DATE                               |
| **Fund_Transfer**       | SET, CLEAR, CALL WITH/AS, ON_RESULT            | UNIQUE_ID, COALESCE, NOW, TO_NUMBER, REPLACE, MASK, SUB, ROUND, FORMAT_CURRENCY, MIN, ABS      |
| **Transaction_History** | SET, CLEAR, CALL WITH/AS, ON_RESULT, TRANSFORM | COALESCE, FORMAT_DATE, FORMAT_CURRENCY, ABS, UPPER, SUBSTRING, LENGTH, ORDINAL, PAD_START, MUL |

See `packages/compiler/src/__tests__/e2e/banknexus-pipeline.test.ts` for 36 comprehensive tests.

---

## Per-Step REASONING Zones

> **New in March 2026**: The top-level `MODE:` declaration is deprecated. Instead, individual FLOW steps can opt into LLM reasoning:

```dsl
FLOW:
  collect_info:
    GATHER: destination, dates
    THEN: smart_search

  smart_search:
    REASONING: true
    # This step uses LLM reasoning to decide tool calls
    # and handle complex user interactions
    THEN: confirm

  confirm:
    RESPOND: "Ready to book?"
    ON_INPUT:
      - IF: yes
        THEN: complete
      - IF: no
        THEN: collect_info
```

When `REASONING: true` is set on a step, the runtime delegates that step to the LLM-driven reasoning executor instead of the deterministic flow executor. This allows mixing scripted precision with LLM flexibility within a single agent.

**IR Representation:**

```typescript
interface FlowStepIR {
  // ... existing fields ...
  reasoning?: boolean; // Per-step reasoning zone
}
```

# Data Collection with GATHER

> **Estimated time**: 30 minutes | **Prerequisites**: Basic ABL agent structure, familiarity with flow steps

## Learning Objectives

After completing this module, you will be able to:

- Define GATHER fields with types, validation, and prompts for structured data collection
- Use enum types and `validate: enum()` to constrain field values to a fixed set
- Configure `infer: true` with confidence thresholds for silent extraction from context
- Set up LOOKUP_TABLEs with `source: api` for dynamic validation against external data
- Use `prompt_mode: extract_only` for silent extraction and `sensitive: true` for PII marking

## Why Structured Data Collection Matters

Most agent conversations need structured data -- dates, account numbers, product choices, addresses. Without a structured approach, you rely on the LLM to extract values ad-hoc, leading to inconsistencies and missed validations. GATHER provides a declarative framework that handles multi-turn collection, validation, correction, and inference, all from a single configuration block.

The key insight is that GATHER does not force a rigid form-filling experience. When using the LLM strategy (the default), users can provide multiple values in a single message ("I want to fly from JFK to LAX on March 15th for 2 passengers"), and the agent extracts them all at once.

## Basic GATHER Syntax

At the agent level, GATHER defines fields as named blocks:

```abl
AGENT: Hotel_Search
GOAL: "Help users find hotels"

GATHER:
  destination:
    prompt: "Where would you like to stay?"
    type: string
    required: true
  checkin:
    prompt: "When is your check-in date?"
    type: date
    required: true
  guests:
    prompt: "How many guests?"
    type: number
    required: false
    default: 2
```

Within a flow step, GATHER uses a compact list syntax:

```abl
collect_trip_info:
  REASONING: false
  GATHER:
    - destination: required
      prompt: "Where would you like to stay?"
    - checkin_date: required
      type: date
      prompt: "Check-in date?"
    - num_guests
      type: number
      default: 2
  COMPLETE_WHEN: destination AND checkin_date
  THEN: search_hotels
```

`COMPLETE_WHEN` defines when the step has enough data to proceed -- even if optional fields are not yet filled.

### Field Types

| Type      | Description          | Example Values          |
| --------- | -------------------- | ----------------------- |
| `string`  | Free-text value      | `"John Smith"`, `"USD"` |
| `number`  | Numeric value        | `42`, `150.75`          |
| `boolean` | True/false           | `true`, `false`         |
| `date`    | Calendar date        | `"2026-03-15"`          |
| `email`   | Email address        | `"user@example.com"`    |
| `phone`   | Phone number         | `"+1-555-123-4567"`     |
| `enum`    | Fixed set of choices | See next section        |

## Enum Types and `validate: enum()` for Field Constraints

When a field should only accept a fixed set of values, you have two approaches:

**Approach 1: Use `type: enum` with `options`** (preferred when the field itself represents a closed set):

```abl
GATHER:
  cabin_class:
    prompt: "What cabin class would you like?"
    type: enum
    options: [economy, business, first]
    required: true
```

**Approach 2: Use `validate: enum()` on a string field:**

```abl
GATHER:
  priority:
    prompt: "Priority level?"
    type: string
    required: true
    validate: enum(low, medium, high)
```

> **Key Concept**: Both `type: enum` with `options` and `validate: enum()` constrain the LLM's extraction to the listed values. The compiler injects the allowed values into both the LLM extraction prompt and the JSON Schema, so the LLM maps natural language ("I'd like to fly premium") to the closest enum value (`business`). The `type: enum` approach is preferred when you want the field type itself to signal a closed set.

Enum validation works particularly well with `infer: true`. When combined, the LLM interprets conversational language and maps it to one of the allowed enum values:

```abl
GATHER:
  cancellation_scope:
    prompt: "Would you like to cancel the entire order or specific items?"
    type: string
    required: true
    validate: enum(full, partial)
    infer: true
    extraction_hints:
      - "If user says 'all', 'everything', or 'whole order', infer 'full'"
      - "If user mentions specific items or says 'some', infer 'partial'"
```

## LLM Inference with `infer: true`

Inference lets the agent extract field values from conversational context without explicitly asking. If the user already mentioned relevant information, the agent fills fields silently instead of re-asking.

```abl
GATHER:
  cancellation_reason:
    prompt: "May I ask the reason for the cancellation?"
    type: string
    required: false
    infer: true
```

With `infer: true`, if the user previously said "I don't need the order anymore," the agent fills `cancellation_reason` without asking again.

### The 0.8 Default Confidence Threshold

> **Key Concept**: When `infer: true` is enabled, the runtime uses a confidence threshold (default `0.8`) to decide whether to accept an inferred value. If the LLM's confidence falls below this threshold, the runtime falls back to asking the user directly using the `prompt`. You can adjust this per field with `infer_confidence`.

```abl
GATHER:
  destination:
    prompt: "Where would you like to travel?"
    type: string
    required: true
    infer: true
    infer_confidence: 0.9
    infer_confirm: true
```

| Property           | Default | Purpose                                        |
| ------------------ | ------- | ---------------------------------------------- |
| `infer`            | `false` | Enable LLM inference for the field             |
| `infer_confidence` | `0.8`   | Minimum confidence to accept an inferred value |
| `infer_confirm`    | `true`  | Ask user to confirm inferred values            |

When `infer_confirm: true`, the agent says something like "It sounds like you want to travel to Paris. Is that correct?" before accepting the value. Set `infer_confirm: false` for fields where the inferred value is obvious (e.g., language preference from the user's writing language), but use a high `infer_confidence` threshold to avoid silent mismatches.

### Extraction Hints

Guide the LLM on how to interpret ambiguous input:

```abl
GATHER:
  trip_type:
    prompt: "Is this a round trip or one way?"
    type: string
    required: true
    infer: true
    extraction_hints:
      - "If user mentions return date, infer 'round_trip'"
      - "If user says 'one way' or mentions only departure, infer 'one_way'"
```

## LOOKUP_TABLE with `source: api` for Dynamic Validation

Enum validation works for small, fixed sets. But what about product catalogs, airport codes, or category lists that change over time? That is where LOOKUP_TABLEs come in.

```abl
LOOKUP_TABLES:
  product_categories:
    source: api
    endpoint: https://api.store.example.com/categories/lookup
    field: name
    timeout_ms: 3000
    headers:
      Authorization: Bearer {{env.CATALOG_API_KEY}}
    fuzzy_match: true
    fuzzy_threshold: 0.8

GATHER:
  category:
    prompt: "What product category are you looking for?"
    type: string
    required: true
    semantics:
      lookup: product_categories
```

> **Key Concept**: A `LOOKUP_TABLE` with `source: api` validates field values against an external HTTP endpoint at runtime. With `fuzzy_match: true`, a user who types "eletronics" still matches "electronics" if the similarity exceeds the `fuzzy_threshold`. This combination of API-sourced validation and fuzzy matching handles typos gracefully without hardcoding every variant.

LOOKUP_TABLEs support three source types:

| Source       | When to Use                         | Example                           |
| ------------ | ----------------------------------- | --------------------------------- |
| `inline`     | Small, static lists (< 1000 values) | Shirt sizes, priority levels      |
| `collection` | Data in your MongoDB database       | Warehouse locations, SKUs         |
| `api`        | External catalogs, live data        | Product categories, airline codes |

```abl
LOOKUP_TABLES:
  shirt_sizes:
    source: inline
    values: [XS, S, M, L, XL, XXL]
    case_sensitive: false

  warehouse_locations:
    source: collection
    table_name: lookup_warehouses
    field: location_code
    fuzzy_match: true
    fuzzy_threshold: 0.9
```

Reference a lookup table from a GATHER field using `semantics.lookup`:

```abl
GATHER:
  airport_code:
    prompt: "Which airport?"
    type: string
    required: true
    semantics:
      lookup: iata_codes
```

## Silent Extraction with `prompt_mode: extract_only`

Sometimes you want to extract information from the conversation without asking the user a question. The `prompt_mode: extract_only` setting turns the `prompt` into an instruction for the LLM rather than a question shown to the user:

```abl
GATHER:
  sentiment:
    prompt: "Assess the customer's emotional state from the conversation"
    type: string
    required: false
    infer: true
    prompt_mode: extract_only
```

> **Key Concept**: `prompt_mode: extract_only` means the prompt is an instruction to the LLM, not a question displayed to the user. The agent silently extracts the value from conversational context. This is useful for metadata fields like sentiment analysis, intent classification, or urgency assessment that inform agent behavior without interrupting the conversation.

## Marking PII with `sensitive: true`

When collecting personally identifiable information, mark fields as `sensitive: true` to activate special handling:

```abl
GATHER:
  ssn_last4:
    prompt: "Last 4 digits of your Social Security Number?"
    type: string
    required: true
    sensitive: true
    sensitive_display: mask
    mask_config:
      showFirst: 0
      showLast: 4
      char: "*"
```

> **Key Concept**: Fields marked `sensitive: true` carry PII and receive special handling throughout the platform. The `sensitive_display` property controls how the value appears outside the gather context: `redact` replaces it entirely with `[REDACTED]`, `mask` shows partial values like `****1234`, and `replace` substitutes with a generic description like `[SSN]`.

For data that should not persist after use, combine `sensitive` with `transient`:

```abl
GATHER:
  card_number:
    prompt: "Card number for verification?"
    type: string
    required: true
    sensitive: true
    transient: true
```

`transient: true` automatically clears the value from the session after the gather phase completes. This is essential for payment data and other sensitive information that should not persist beyond its immediate use.

| Display Mode | Output       | Use Case                   |
| ------------ | ------------ | -------------------------- |
| `redact`     | `[REDACTED]` | Full replacement in logs   |
| `mask`       | `****1234`   | Show partial value to user |
| `replace`    | `[SSN]`      | Generic description        |

## Validation Beyond Enums

GATHER supports multiple validation approaches:

```abl
GATHER:
  email:
    prompt: "What is your email address?"
    type: email
    required: true
    validate: "value matches '^[\\w.+-]+@[\\w-]+\\.[\\w.-]+$'"

  age:
    prompt: "How old are you?"
    type: number
    required: true
    validate: "value >= 18 AND value <= 120"

  order_id:
    prompt: "What is your order number? (Format: ORD-XXXXX)"
    type: string
    required: true
    validation: "^ORD-[A-Z0-9]{5}$"
    validation_process: REGEX
    retry_prompt: "Please enter a valid order ID like ORD-AB123."
    max_retries: 3
```

The `validation_process` property controls how validation runs: `REGEX` for pattern matching, `CODE` for expression evaluation, or `LLM` for natural-language judgment (e.g., "Verify this is a valid US mailing address").

## Handling Corrections

Enable corrections so users can change previously provided values:

```abl
collect_trip_info:
  REASONING: false
  GATHER:
    - destination: required
    - checkin_date: required
      type: date
    - checkout_date: required
      type: date
  CORRECTIONS: true
  COMPLETE_WHEN: destination AND checkin_date AND checkout_date
  THEN: search_hotels
```

With `CORRECTIONS: true`, the user can say "actually, change the destination to London" at any point during collection. For more control, use `SUB_INTENTS`:

```abl
  SUB_INTENTS:
    - INTENT: "change destination"
      CLEAR: [destination]
      RESPOND: "Sure, what is the new destination?"
    - INTENT: "change dates"
      CLEAR: [checkin_date, checkout_date]
      RESPOND: "What are your new travel dates?"
```

## Key Takeaways

- Use `type: enum` with `options` or `validate: enum()` to constrain field values to a fixed set -- the LLM maps natural language to enum values automatically
- `infer: true` enables silent extraction from context with a default confidence threshold of `0.8` (adjustable via `infer_confidence`)
- LOOKUP_TABLEs with `source: api` validate against external data at runtime, with optional fuzzy matching for typo tolerance
- `prompt_mode: extract_only` extracts metadata silently without asking the user a question
- `sensitive: true` activates PII handling with configurable display modes (redact, mask, replace) and optional `transient: true` for auto-cleanup

## What's Next

Now that you can collect and validate data, learn how to orchestrate it into deterministic workflows in the **Flow Control** module, or see how collected values persist across sessions in the **Memory & State** module.

# Advanced ABL Language Features

> **Estimated time**: 40 minutes | **Prerequisites**: Basic ABL agent declaration, GATHER fields, FLOW steps

## Learning Objectives

After completing this module, you will be able to:

- Configure lifecycle hooks to run actions at precise points in agent execution
- Build NLU configurations with intents, entities, and synonym resolution
- Use rich content and expressions to deliver multi-channel responses
- Apply data types, lookup tables, and attachments for robust data handling
- Implement error handling strategies at both agent and step level

## Lifecycle Hooks: Controlling Agent Behavior at Every Stage

Every agent goes through a predictable lifecycle: it initializes, processes turns, and eventually ends. ABL gives you **hooks** to inject custom logic at each of these stages -- without cluttering your main conversation flow.

### The Hook Lifecycle

The runtime executes hooks in a strict order:

1. **`before_agent`** -- fires once when the agent activates (before ON_START)
2. **`ON_START`** -- greeting, initial tool calls, variable initialization
3. For each user message:
   - **`before_turn`** -- fires before the LLM processes the message
   - LLM reasoning / flow step execution
   - Output guardrails
   - **`after_turn`** -- fires after the response is finalized
4. **`after_agent`** -- fires once when the session ends

Understanding this order is essential. `before_agent` and `after_agent` are session-scoped (fire once each), while `before_turn` and `after_turn` fire on every conversation turn.

### Writing Hooks

```abl
HOOKS:
  before_agent:
    CALL: load_user_preferences()
    SET:
      session_start = NOW()

  before_turn:
    SET:
      turn_start_time = NOW()

  after_turn:
    CALL: log_audit_event()
    SET:
      turn_count = ADD(turn_count, 1)

  after_agent:
    CALL: save_session_summary()
```

Within a single hook, actions execute sequentially: **CALL** runs first, then **SET** applies variable assignments, then **RESPOND** pushes a message.

### Critical Hooks for Compliance

By default, hooks **fail open**: if a tool call throws or times out, the runtime logs a warning and continues. This prevents a broken audit logger from blocking customer conversations.

But what about compliance checks that _must_ succeed before the agent responds? Mark the hook as `critical: true`:

```abl
HOOKS:
  before_turn:
    critical: true
    CALL: compliance_pre_check()
```

> **Key Concept**: When `critical: true` is set on a `before_turn` hook, failure **aborts the entire turn**. The agent does not respond, and the runtime throws an error. Use this for regulatory workflows -- such as sanctions screening or PCI compliance checks -- where processing must not continue without a successful verification.

This is one of the most important patterns in regulated industries. A financial services agent might use a critical `before_turn` hook to run sanctions screening on every message, ensuring no transaction proceeds without clearance.

### Hook Trace Events

Every hook execution emits a `hook_executed` trace event with the hook type, actions executed, duration, and success status. Query these in the Observatory trace viewer to debug hook behavior and measure overhead.

## NLU: Understanding User Intent

Natural Language Understanding (NLU) configures how your agent classifies what the user wants and extracts structured data from their messages.

### Intent Classification

Intents represent categories of user messages. Define them with keyword patterns for fast matching and example utterances for model-based classification:

```abl
NLU:
  intents:
    - NAME: send_wire
      PATTERNS: ["wire transfer", "send money", "wire funds"]
      EXAMPLES:
        - "I need to wire $50,000 to Germany"
        - "Can I send a domestic wire?"
      ENTITIES: [currency_code, transfer_type]

    - NAME: check_status
      PATTERNS: ["wire status", "where is my wire", "tracking"]
```

Patterns are matched as case-insensitive substrings -- fast but imprecise. Examples enable semantic similarity matching for higher accuracy.

### The Six Entity Types

ABL supports six entity types for extracting structured values from user messages:

| Type        | Description                                | Example                       |
| ----------- | ------------------------------------------ | ----------------------------- |
| `enum`      | Fixed set of values with optional synonyms | Currency codes (USD, EUR)     |
| `pattern`   | Regular expression matching                | Phone numbers, account IDs    |
| `location`  | Geographic locations                       | Cities, countries, addresses  |
| `date`      | Date and time references                   | "next Tuesday", "March 15th"  |
| `number`    | Numeric values                             | Amounts, quantities           |
| `free_text` | Arbitrary text spans                       | Notes, descriptions, comments |

> **Key Concept**: The `free_text` entity type captures arbitrary text that does not fit structured categories. Use it for open-ended fields like "special requests," "additional notes," or "describe the issue." Unlike other entity types that match specific patterns or values, `free_text` captures whatever the user says in that slot.

```abl
NLU:
  entities:
    - NAME: currency_code
      TYPE: enum
      VALUES: [USD, EUR, GBP, JPY]
      SYNONYMS:
        USD: [dollars, usd, bucks, us dollars]
        EUR: [euros, eur]
        GBP: [pounds, sterling, quid]

    - NAME: phone_number
      TYPE: pattern
      PATTERN: "\\b\\d{3}[-.]?\\d{3}[-.]?\\d{4}\\b"

    - NAME: special_request
      TYPE: free_text
```

### Synonym Normalization to Canonical Form

Synonyms are a powerful feature for handling the many ways users refer to the same thing. When you define synonyms, the runtime **normalizes** user input to the canonical value before storing it:

```abl
SYNONYMS:
  USD: [dollars, usd, bucks, us dollars]
  EUR: [euros, eur]
  GBP: [pounds, sterling, gbp, quid]
```

> **Key Concept**: If the user says "100 bucks," the entity extraction yields `currency_code: "USD"` -- the canonical form. This means your downstream logic only needs to handle canonical values, not every possible variation. The normalization happens automatically at extraction time.

This eliminates the need for scattered `IF currency == "bucks" OR currency == "dollars"` checks throughout your flow.

### Embeddings-Based Matching

For more accurate semantic matching beyond keyword patterns, enable embeddings:

```abl
NLU:
  embeddings:
    enabled: true
    provider: "bge-m3"
    threshold: 0.75
    cache_ttl: 3600
```

The threshold (0.0--1.0) controls how similar a message must be to an intent example. Below the threshold, the match is rejected.

### Glossary for Domain Terminology

Inject domain-specific terms into the LLM context to improve understanding:

```abl
NLU:
  glossary:
    - "SWIFT/BIC -- Code identifying a bank globally"
    - "Fedwire -- Federal Reserve real-time settlement system"
    - "OFAC -- Office of Foreign Assets Control"
```

## Error Handling: Agent-Level and Step-Level

Error handling in ABL follows a layered resolution model. Understanding the precedence rules is critical for building resilient agents.

### Agent-Level Error Handlers

Define error handlers at the agent level to cover all error types:

```abl
ON_ERROR:
  tool_timeout:
    RESPOND: "That system is responding slowly. Let me retry."
    RETRY: 2
    THEN: CONTINUE

  llm_error:
    RESPOND: "I'm having trouble processing your request."
    RETRY: 1
    RETRY_BACKOFF: exponential
    RETRY_MAX_DELAY: 10000
    THEN: ESCALATE
```

The seven error types are: `tool_timeout`, `tool_error`, `validation_error`, `llm_error`, `routing_failure`, `agent_unavailable`, and `timeout`.

### Step-Level Error Handlers Override Agent-Level

This is where many builders make mistakes. When you define an `ON_ERROR` handler inside a flow step, it **takes precedence** over the agent-level handler for the same error type:

```abl
FLOW:
  steps:
    execute_payment:
      CALL: process_payment
      ON_ERROR:
        - TYPE: tool_error
          RESPOND: "Payment processing failed. Retrying..."
          RETRY: 3
          RETRY_BACKOFF: exponential
          THEN: HANDOFF Payment_Support
```

> **Key Concept**: Step-level error handlers take precedence over agent-level handlers for the same error type. The resolution order is: (1) step-level handlers, (2) agent-level handlers with subtype match, (3) agent-level handlers with type-only match, (4) default handler, (5) fallback error message. This means you can define conservative defaults at the agent level and override them for critical steps like payment processing.

Why does this matter? Consider a payment flow: the agent-level handler might retry once and continue, but the payment step needs three retries with exponential backoff and a handoff to payment support if all retries fail. Step-level overrides make this possible without affecting the rest of the agent.

### Retry Strategies

| Strategy      | Behavior                                            |
| ------------- | --------------------------------------------------- |
| `fixed`       | Same delay between each attempt                     |
| `exponential` | Double the delay each time, up to `RETRY_MAX_DELAY` |
| `linear`      | Increase delay by `RETRY_DELAY` each time           |

### Then Actions

After retries are exhausted, the `THEN` action determines what happens next: `CONTINUE` (skip the failed operation), `ESCALATE` (trigger human escalation), `HANDOFF` (transfer to a specific agent), `COMPLETE` (end the conversation), or `backtrack` (return to a previous step).

## Data Types and Lookup Tables

### The ABL Type System

ABL provides five primitive types and five complex types:

**Primitives**: `string`, `number`, `boolean`, `date`, `datetime`

**Complex types**: `array<T>`, `object<{...}>`, `enum<[...]>`, `union<[...]>`, `nullable<T>`

These appear in MEMORY declarations, GATHER fields, tool parameters, and tool return types:

```abl
MEMORY:
  session:
    - order_total
      TYPE: number
      INITIAL: 0
    - cart_items
      TYPE: array
      INITIAL: []

TOOLS:
  search_flights(origin: string, destination: string, date: date) ->
    {flights: {id: string, price: number}[], total: number}
```

### Lookup Tables for Validation

Lookup tables provide reference-based validation from three sources:

| Source       | When to Use                                                        |
| ------------ | ------------------------------------------------------------------ |
| `inline`     | Small, stable sets (< 100 values) with no external dependency      |
| `collection` | Large or frequently changing sets managed through admin interfaces |
| `api`        | Values from third-party systems requiring real-time accuracy       |

```abl
LOOKUP_TABLES:
  airport_codes:
    source: inline
    values: [JFK, LAX, ORD, SFO, MIA]
    case_sensitive: false
    fuzzy_match: true
    fuzzy_threshold: 0.85

  exchange_rates:
    source: api
    endpoint: "https://api.rates.example.com/v1/currencies"
    field: "currency_code"
    timeout_ms: 3000
    case_sensitive: true
    fuzzy_match: false
```

### API Lookup Table Timeout: Fail-Open Behavior

What happens when your API lookup table's external service is slow or unavailable? The runtime follows a **fail-open** pattern:

> **Key Concept**: If an API lookup table call times out or returns an error, the runtime (1) logs a warning, (2) falls back to accepting the user's input without validation, and (3) emits a trace event indicating the lookup failure. This fail-open behavior prevents an external service outage from blocking your entire conversation flow. Set `timeout_ms` appropriately -- a 3-second timeout is reasonable for most reference APIs.

This design philosophy -- fail open for non-critical operations, fail closed for critical ones (like compliance hooks) -- runs throughout ABL.

### Using Lookup Tables in GATHER Validation

Reference a lookup table in your gather field:

```abl
GATHER:
  destination_airport:
    prompt: "What's your destination airport code?"
    type: string
    required: true
    validate: lookup(airports)
```

Fuzzy matching handles typos: with `fuzzy_threshold: 0.8`, "SFP" matches "SFO" but "XYZ" does not.

## Rich Content and Expressions

### Multi-Channel Output

A single response can include plain text, voice configuration, rich content (Markdown, Adaptive Cards, Slack Block Kit), carousels, and interactive actions. The runtime selects the appropriate format based on the delivery channel:

```abl
RESPOND: "Your booking is confirmed."
  VOICE:
    ssml: |
      <speak>
        Your booking is confirmed for
        <say-as interpret-as="date" format="mdy">12/15/2025</say-as>.
      </speak>
    instructions: "Speak in a warm, congratulatory tone"
  RICH_CONTENT:
    markdown: |
      ## Booking Confirmed
      | Detail | Value |
      |--------|-------|
      | **Hotel** | {{hotel_name}} |
      | **Total** | ${{total}} |
```

### Templates for Reusable Content

Define named templates with format variants:

```abl
TEMPLATES:
  booking_summary:
    DEFAULT: "Booking: {{hotel_name}}, Total: ${{total}}"
    MARKDOWN: |
      ## Booking Confirmed
      **Hotel**: {{hotel_name}}
      **Total**: ${{total}}
    HTML: "<h2>Booking Confirmed</h2><p>{{hotel_name}}: ${{total}}</p>"
    VOICE INSTRUCTIONS: "Congratulate the user. Read the details clearly."
```

Reference templates with `RESPOND: TEMPLATE(booking_summary)`.

## Attachments

ABL supports four attachment categories for collecting files from users:

| Category   | Use Cases                              | Processing                         |
| ---------- | -------------------------------------- | ---------------------------------- |
| `document` | PDFs, Word docs, spreadsheets          | OCR, text extraction               |
| `image`    | Photos, screenshots, scanned IDs       | OCR, image analysis                |
| `audio`    | Voice recordings, audio messages       | Transcription                      |
| `video`    | Screen recordings, instructional clips | Keyframe extraction, transcription |

```abl
ATTACHMENTS:
  id_document:
    prompt: "Please upload a photo of your government-issued ID."
    category: image
    required: true
    max_file_size_mb: 10
    allowed_mime_types: [image/jpeg, image/png, image/webp]
    ocr_enabled: true
```

The extracted text is available in session context: `id_document.extracted_text`.

## Key Takeaways

- Hooks run at four lifecycle points; use `critical: true` on `before_turn` hooks for compliance gates that must succeed before the agent responds
- ABL supports six NLU entity types (`enum`, `pattern`, `location`, `date`, `number`, `free_text`); synonyms normalize user input to canonical values automatically
- Step-level `ON_ERROR` handlers take precedence over agent-level handlers for the same error type -- use this for critical operations like payment processing
- API lookup tables fail open on timeout: the runtime logs a warning and accepts the input without validation, preventing external outages from blocking conversations
- Rich content and templates enable multi-channel output from a single agent definition

## What's Next

Explore the **Production Deployment** module to learn how to publish agents with environment variables, manage deployment lifecycles, and connect channels. See the **Orchestration Patterns** module for advanced multi-agent error handling strategies.

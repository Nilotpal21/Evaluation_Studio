# GATHER Fields Guide — Collecting Information from Users in ABL

This guide explains how `GATHER` fields work in ABL — how agents collect
information from users, validate it, extract it from natural language, and
use it to drive decisions. Covers both top-level GATHER and FLOW-step
GATHER, inline vs. flow-based collection, and every field property with
real examples.

---

## Quick Reference

```yaml
GATHER:
  field_name:
    prompt: 'What is your email?'
    type: email
    required: true
    validate: 'Must be a valid corporate email'
```

The runtime turns this into either:

- A **system prompt instruction** telling the LLM to ask for this information
- An **`_extract_entities` tool** the LLM calls to extract values from user
  messages (when `inline_gather: true`)
- A **scripted prompt** in FLOW-based agents that asks one field at a time

---

## 1. Where GATHER Can Appear

GATHER can appear in two places, with slightly different behavior:

### Top-Level GATHER (Agent-Level)

Defined directly on the agent. These fields are collected across the entire
conversation. In reasoning agents with `inline_gather: true`, the LLM
extracts values opportunistically from any user message.

```yaml
AGENT: Sales_Agent

EXECUTION:
  inline_gather: true

GATHER:
  destination:
    prompt: 'Where would you like to travel to?'
    type: string
    required: true

  departure_date:
    prompt: 'When would you like to depart?'
    type: date
    required: true
```

### FLOW Step GATHER

Defined inside a FLOW step. These fields are collected only when that step
is active. The step blocks until all required fields are gathered.

```yaml
FLOW:
  entry_point: collect_info
  steps:
    - collect_info
    - process

  collect_info:
    GATHER:
      - name: required
        prompt: 'What is your name?'
        type: string
      - email: required
        prompt: 'What is your email address?'
        type: email
    THEN: process
```

### Key Difference

| Aspect          | Top-Level GATHER                          | FLOW Step GATHER                             |
| --------------- | ----------------------------------------- | -------------------------------------------- |
| Scope           | Entire conversation                       | Active step only                             |
| Collection mode | Inline (reasoning) or system prompt       | Step blocks until complete                   |
| Extraction      | `_extract_entities` tool or LLM inference | Entity extraction per step                   |
| Ordering        | LLM decides order                         | Fields asked in declaration order            |
| Strategy        | Controlled by `inline_gather`             | Can set `strategy: llm \| pattern \| hybrid` |

---

## 2. Field Properties — Complete Reference

Every property available on a GATHER field, verified against the parser and
runtime:

### Core Properties

| Property      | Type    | Default    | Description                               |
| ------------- | ------- | ---------- | ----------------------------------------- |
| `prompt`      | string  | field name | Question to ask the user                  |
| `type`        | string  | `string`   | Data type (see type table below)          |
| `required`    | boolean | `true`     | Whether the field must be collected       |
| `default`     | any     | —          | Default value if user doesn't provide one |
| `message_key` | string  | —          | Locale catalog key for i18n prompt        |

### Validation Properties

| Property             | Type   | Default | Description                                |
| -------------------- | ------ | ------- | ------------------------------------------ |
| `validate`           | string | —       | Validation expression or description       |
| `validation_process` | string | —       | How to validate: `REGEX`, `CODE`, or `LLM` |
| `retry_prompt`       | string | —       | Custom message when validation fails       |
| `max_retries`        | number | —       | Max validation retry attempts              |
| `options`            | list   | —       | Allowed values (creates enum constraint)   |

### Inference Properties

| Property           | Type    | Default | Description                                |
| ------------------ | ------- | ------- | ------------------------------------------ |
| `infer`            | boolean | —       | Allow LLM to infer value from context      |
| `infer_confidence` | float   | 0.8     | Minimum confidence for accepting inference |
| `infer_confirm`    | boolean | true    | Confirm inferred values with the user      |

### Collection Mode Properties

| Property      | Type          | Default    | Description                                              |
| ------------- | ------------- | ---------- | -------------------------------------------------------- |
| `activation`  | string/object | `required` | When field becomes active (see section 5)                |
| `depends_on`  | list          | —          | Fields that must be collected first                      |
| `prompt_mode` | string        | `ask`      | `ask` (ask user) or `extract_only` (LLM extraction only) |
| `range`       | boolean       | false      | Collect as `{low, high}` range                           |
| `list`        | boolean       | false      | Collect as array of values                               |
| `preferences` | boolean       | false      | Categorize into accept/desire/avoid/refuse               |

### Sensitive Data (PII) Properties

| Property            | Type    | Default | Description                                                                       |
| ------------------- | ------- | ------- | --------------------------------------------------------------------------------- |
| `sensitive`         | boolean | false   | Marks field as containing PII                                                     |
| `sensitive_display` | string  | —       | How to show after collection: `redact`, `mask`, `replace`                         |
| `mask_config`       | object  | —       | Masking config: `showFirst`, `showLast`, `char`                                   |
| `pii_type`          | string  | —       | PII category: `email`, `phone`, `ssn`, `credit_card`, `address`, `name`, `custom` |
| `transient`         | boolean | false   | Auto-clear PII after gather completes                                             |

### Entity & Extraction Properties

| Property             | Type   | Default | Description                                  |
| -------------------- | ------ | ------- | -------------------------------------------- |
| `entity_ref`         | string | —       | Reference to a named ENTITIES definition     |
| `extraction_pattern` | string | —       | Custom regex for value extraction            |
| `extraction_group`   | number | 0       | Capture group index for extraction_pattern   |
| `semantics`          | object | —       | Metadata about value meaning (see section 8) |

---

## 3. Supported Types

The `type` property determines how the runtime validates and extracts
values. Each type has intrinsic validation built in.

| Type        | Description           | Intrinsic Validation                                     |
| ----------- | --------------------- | -------------------------------------------------------- |
| `string`    | Free-form text        | None                                                     |
| `text`      | Multi-line text       | None                                                     |
| `free_text` | Unconstrained text    | None                                                     |
| `number`    | Any number            | Must parse as number                                     |
| `integer`   | Whole number          | Must parse as integer                                    |
| `float`     | Decimal number        | Must parse as float                                      |
| `currency`  | Monetary amount       | Accepts `$49`, `100 USD`, `€120`, or `{value, currency}` |
| `boolean`   | Yes/no value          | Accepts: true/false, yes/no, y/n, 1/0, on/off            |
| `date`      | Calendar date         | Accepts ISO format or natural language ("next Friday")   |
| `datetime`  | Date and time         | Accepts ISO format or natural language                   |
| `email`     | Email address         | Pattern: `user@domain.tld`                               |
| `phone`     | Phone number          | Accepts `+` prefix international or natural language     |
| `enum`      | One of allowed values | Must match `options` list                                |
| `pattern`   | Regex-matched string  | Must match `extraction_pattern`                          |
| `location`  | Geographic location   | Extracted via NLP                                        |

### Type Examples

```yaml
GATHER:
  age:
    prompt: 'How old are you?'
    type: integer
    required: true

  budget:
    prompt: 'What is your budget?'
    type: currency
    required: false

  travel_date:
    prompt: 'When would you like to travel?'
    type: date
    required: true

  contact_email:
    prompt: 'What is your email address?'
    type: email
    required: true

  wants_insurance:
    prompt: 'Would you like travel insurance?'
    type: boolean
    required: false
    default: false
```

---

## 4. Validation

Validation ensures extracted values meet your requirements. There are
multiple validation layers.

### 4a. Intrinsic Validation (Automatic)

Every typed field gets automatic validation based on its `type`. For
example, `type: email` automatically validates against the email pattern.
`type: phone` validates against phone number formats. `type: number`
ensures the value parses as a number. You get this for free — no `validate`
property needed.

### 4b. Validate Property (Custom Rules)

The `validate` property adds custom validation on top of intrinsic
validation. How it's interpreted depends on `validation_process`:

**Pattern validation (REGEX):**

```yaml
GATHER:
  zip_code:
    prompt: 'What is your ZIP code?'
    type: string
    required: true
    validate: "^\\d{5}(-\\d{4})?$"
    validation_process: REGEX
    retry_prompt: 'Please enter a valid 5-digit ZIP code (e.g., 90210)'
    max_retries: 3
```

**LLM validation:**

```yaml
GATHER:
  business_reason:
    prompt: 'What is the business reason for this request?'
    type: string
    required: true
    validate: 'Must be a specific business justification, not a generic statement'
    validation_process: LLM
```

**Range validation (built into the extraction tool schema):**

```yaml
GATHER:
  party_size:
    prompt: 'How many guests?'
    type: number
    required: true
    validate: '1-20'
```

The runtime parses `1-20` as a range and injects `minimum: 1, maximum: 20`
into the extraction tool's JSON Schema.

**Enum validation (via options):**

```yaml
GATHER:
  device_type:
    prompt: 'What type of device?'
    type: string
    required: true
    options: [iPhone, iPad, Mac, Apple Watch]
```

Options are injected as a JSON Schema `enum` constraint into the extraction
tool, guiding the LLM to normalize values (e.g., "MacBook Pro" → "Mac").

### 4c. Validation Retry Flow

When validation fails, the runtime:

1. Records the error in `_validation_errors` on the session
2. Surfaces the error to the LLM in the next turn's system prompt
3. Uses the `retry_prompt` if configured, or the default validation message
4. Decrements the retry counter (if `max_retries` is set)
5. If retries are exhausted, the field remains uncollected

```yaml
GATHER:
  provider_id:
    prompt: 'Please enter your Provider ID (9 digits)'
    type: string
    required: true
    validate: "^\\d{9}$"
    validation_process: REGEX
    retry_prompt: "That doesn't look right. A Provider ID is exactly 9 digits (e.g., 123456789)."
    max_retries: 3
```

---

## 5. Activation Modes

Activation controls **when** a field becomes part of the collection. This
enables progressive disclosure — don't ask for everything upfront.

### required (default)

The field is always needed. Collection won't complete until it's provided
(unless it has a `default`).

```yaml
name:
  prompt: 'What is your name?'
  type: string
  activation: required
```

### optional

The field is never required for completion. The LLM may collect it
opportunistically but won't block on it.

```yaml
dietary_restrictions:
  prompt: 'Any dietary restrictions?'
  type: string
  activation: optional
```

### progressive

The field only activates after its `depends_on` fields are all collected.
This creates natural conversation flow — ask follow-up questions only when
prior context exists.

```yaml
GATHER:
  travel_type:
    prompt: 'Are you looking for flights, hotels, or a package?'
    type: string
    required: true
    options: [flights, hotels, package]

  hotel_star_rating:
    prompt: 'What star rating do you prefer?'
    type: number
    activation: progressive
    depends_on: [travel_type]

  room_type:
    prompt: 'What type of room? (single, double, suite)'
    type: string
    activation: progressive
    depends_on: [travel_type, hotel_star_rating]
```

In this example:

- `travel_type` is asked first (always required)
- `hotel_star_rating` only appears after `travel_type` is collected
- `room_type` only appears after both `travel_type` and
  `hotel_star_rating` are collected

### Data-Driven Activation (WHEN)

The field only activates when a condition evaluates to true:

```yaml
GATHER:
  insurance_type:
    prompt: 'What type of insurance coverage?'
    type: string
    activation:
      WHEN: travel_type == "international"
    options: [basic, comprehensive, premium]

  visa_required:
    prompt: 'Do you need visa assistance?'
    type: boolean
    activation:
      WHEN: destination_country != "US"
```

The condition is evaluated using the same expression engine as `WHEN`
conditions in handoffs — supports `==`, `!=`, `>`, `<`, `>=`, `<=`, and
compound expressions.

---

## 6. Inline Gather vs. Flow Gather

### Inline Gather (Reasoning Agents)

When `inline_gather: true` is set in `EXECUTION`, the agent collects fields
conversationally during normal reasoning. The LLM receives an
`_extract_entities` tool it can call to extract values from any user message.

```yaml
AGENT: Sales_Agent

EXECUTION:
  inline_gather: true

GATHER:
  destination:
    prompt: 'Where would you like to travel to?'
    type: string
    required: true

  departure_date:
    prompt: 'When would you like to depart?'
    type: date
    required: true

  budget:
    prompt: 'What is your budget?'
    type: currency
    required: false
```

**How it works at runtime:**

1. The prompt builder generates an `_extract_entities` tool with typed
   properties for each uncollected field.
2. The system prompt includes an "Inline Gather Status" section showing
   which fields are collected and which are still needed.
3. The LLM can call `_extract_entities` at any point to save extracted
   values — it doesn't need to ask each question individually.
4. When the user says "I want to fly to Paris on March 15th for under
   $2000", the LLM can extract `destination`, `departure_date`, and
   `budget` all in one call.
5. Once all required fields are collected, `_extract_entities` is removed
   from the tool list.
6. If the LLM skips `_extract_entities` on a turn, the runtime runs a
   **fallback extraction** pass that attempts to extract values from the
   user's message anyway.

**Best for:** Conversational agents where users provide information
naturally, across multiple turns or all at once.

### Flow Gather (Scripted Collection)

In FLOW steps, GATHER blocks until all required fields are collected. The
step cannot proceed to THEN until completion.

```yaml
FLOW:
  entry_point: collect_booking_info
  steps:
    - collect_booking_info
    - search_flights

  collect_booking_info:
    GATHER:
      - origin: required
        prompt: 'Where are you flying from?'
        type: string
      - destination: required
        prompt: 'Where are you flying to?'
        type: string
      - date: required
        prompt: 'What date?'
        type: date
    STRATEGY: hybrid
    THEN: search_flights
```

**STRATEGY options for FLOW GATHER:**

| Strategy  | Description                                   |
| --------- | --------------------------------------------- |
| `llm`     | Use LLM for entity extraction (default)       |
| `pattern` | Use regex patterns only (faster, no LLM call) |
| `hybrid`  | Try pattern first, fall back to LLM           |

**Best for:** Agents with strict data collection requirements where field
ordering and completeness matter.

### Flow Gather with Custom Prompt

```yaml
collect_booking_info:
  GATHER:
    - origin: required
      type: string
    - destination: required
      type: string
    - date: required
      type: date
  PROMPT: |
    I need a few details to search for flights:
    {{#if _missing}}
    Still need: {{_missingList}}
    {{/if}}
  THEN: search_flights
```

The `PROMPT` template receives `_missing` (array) and `_missingList`
(comma-separated string) plus all collected values for interpolation.

---

## 7. Sensitive Data (PII Handling)

GATHER has built-in PII protection for sensitive fields.

### Basic Sensitive Field

```yaml
GATHER:
  ssn:
    prompt: 'What is your Social Security Number?'
    type: string
    required: true
    sensitive: true
    sensitive_display: mask
    pii_type: ssn
    transient: true
```

### Masking Configuration

```yaml
GATHER:
  credit_card:
    prompt: 'What is your credit card number?'
    type: string
    required: true
    sensitive: true
    sensitive_display: mask
    pii_type: credit_card
    mask_config:
      showFirst: 0
      showLast: 4
      char: '*'
    transient: true
```

After collection, the displayed value shows: `****-****-****-1234`

### PII Properties Explained

| Property                     | Effect                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| `sensitive: true`            | Marks field as PII — enables protection pipeline                                    |
| `sensitive_display: redact`  | Shows `[REDACTED]` after collection                                                 |
| `sensitive_display: mask`    | Shows partial value per `mask_config`                                               |
| `sensitive_display: replace` | Shows replacement text                                                              |
| `pii_type`                   | Helps the redactor produce shape-preserving masks (e.g., email keeps `@domain.com`) |
| `transient: true`            | Auto-clears the value from session after gather completes                           |

### Transient Fields

When `transient: true`, the runtime clears the field value after the agent's
gather phase completes. This ensures PII like SSNs and credit card numbers
don't persist in session storage beyond their immediate use.

---

## 8. Semantics — Rich Field Metadata

The `semantics` block provides additional metadata about what a field value
represents. This helps the extraction pipeline understand and convert
values.

```yaml
GATHER:
  temperature:
    prompt: 'What is the current temperature?'
    type: number
    required: true
    semantics:
      unit: fahrenheit
      convert_to: celsius

  address:
    prompt: 'What is your address?'
    type: string
    required: true
    semantics:
      format: 'street, city, state zip'
      components: [street, city, state, zip]

  appointment_date:
    prompt: 'When would you like your appointment?'
    type: date
    required: true
    semantics:
      locale: en-US
```

**Semantics properties:**

| Property     | Description                                                            |
| ------------ | ---------------------------------------------------------------------- |
| `format`     | Expected value format (hint for extraction)                            |
| `components` | Sub-parts of a compound value                                          |
| `unit`       | Unit of measurement                                                    |
| `convert_to` | Target unit for automatic conversion                                   |
| `locale`     | Locale for date/number parsing                                         |
| `lookup`     | Reference to a LOOKUP_TABLES entry for value normalization             |
| `enum_set`   | Alternative location for allowed values (merged into parent `options`) |

---

## 9. Entity References

Instead of duplicating type/validation/options across multiple agents, define
entities once and reference them in GATHER fields.

### Define Entity

```yaml
ENTITIES:
  - NAME: device_type
    TYPE: enum
    VALUES: [iPhone, iPad, Mac, Apple Watch, HomePod]
    SYNONYMS:
      iPhone: [iphone, mobile, cell]
      iPad: [ipad, tablet]
      Mac: [mac, macbook, laptop, desktop, imac]
      Apple Watch: [watch, apple watch]

  - NAME: order_id
    TYPE: pattern
    PATTERN: "^ORD-\\d{6}$"
    VALIDATION: 'Must be in format ORD-XXXXXX'
```

### Reference in GATHER

```yaml
GATHER:
  device:
    prompt: 'What device are you having trouble with?'
    entity_ref: device_type
    required: true

  order_number:
    prompt: 'What is your order number?'
    entity_ref: order_id
    required: true
```

The field inherits the entity's type, values, synonyms, and validation.
The extraction tool schema automatically includes the enum values and
synonym hints, so the LLM normalizes "MacBook Pro" → "Mac".

---

## 10. Range and List Collection

### Range — Collect Min/Max Pair

```yaml
GATHER:
  budget_range:
    prompt: 'What is your budget range?'
    type: currency
    required: true
    range: true
```

The extraction tool creates an object schema: `{low: number, high: number}`.
User says "between $500 and $1000" → `{low: 500, high: 1000}`.

### List — Collect Multiple Values

```yaml
GATHER:
  dietary_restrictions:
    prompt: 'Any dietary restrictions? (list all that apply)'
    type: string
    required: false
    list: true
    options: [vegetarian, vegan, gluten-free, nut-free, dairy-free, halal, kosher]
```

The extraction tool creates an array schema: `string[]`.
User says "I'm vegetarian and gluten-free" → `["vegetarian", "gluten-free"]`.

### Preferences — Categorized Collection

```yaml
GATHER:
  hotel_preferences:
    prompt: 'What are your hotel preferences?'
    type: string
    preferences: true
```

Collects into structured categories:
`{accept: [...], desire: [...], avoid: [...], refuse: [...]}`

---

## 11. Extraction Pattern — Custom Regex

For fields with very specific formats, use `extraction_pattern` to extract
values via regex before LLM processing:

```yaml
GATHER:
  ticket_id:
    prompt: 'What is your ticket number?'
    type: string
    required: true
    extraction_pattern: "INC-\\d{5,8}"
    extraction_group: 0

  phone:
    prompt: 'What is your phone number?'
    type: phone
    required: true
    extraction_pattern: "(\\+?\\d{1,3}[\\s-]?)?(\\(?\\d{3}\\)?[\\s-]?\\d{3}[\\s-]?\\d{4})"
    extraction_group: 0
```

The pattern is validated at compile time for safety (length limits, no
catastrophic backtracking patterns). At runtime, the regex runs against the
user's message text before LLM extraction.

---

## 12. Prompt Mode — Ask vs. Extract Only

```yaml
GATHER:
  user_intent:
    prompt: "Classify the user's intent from their message"
    type: string
    prompt_mode: extract_only
    required: true
    options: [billing, technical, account, general]

  customer_name:
    prompt: 'What is your name?'
    type: string
    prompt_mode: ask
    required: true
```

| Mode            | Behavior                                                         |
| --------------- | ---------------------------------------------------------------- |
| `ask` (default) | The LLM asks the user for the value                              |
| `extract_only`  | The LLM extracts from the user's existing message without asking |

`extract_only` is useful for classification fields, sentiment detection, or
extracting values the user already mentioned without redundantly asking.

---

## 13. Complete Scenarios

### Scenario 1: IT Ticket Creation Agent

```yaml
AGENT: Ticket_Creator

EXECUTION:
  inline_gather: true

GATHER:
  issue_title:
    prompt: 'Give a brief title for your issue'
    type: string
    required: true

  issue_description:
    prompt: 'Describe the issue in detail'
    type: text
    required: true

  category:
    prompt: 'What category does this fall under?'
    type: string
    required: true
    options: [Network, Software, Hardware, Access, Email, Other]

  priority:
    prompt: 'How urgent is this?'
    type: string
    required: true
    options: [Low, Medium, High, Critical]
    default: Medium

  affected_users:
    prompt: 'How many users are affected?'
    type: integer
    required: false
    activation: progressive
    depends_on: [category]

  device_type:
    prompt: 'What type of device?'
    type: string
    activation:
      WHEN: category == "Hardware" OR category == "Software"
    options: [Desktop, Laptop, Phone, Tablet, Printer, Other]

  error_message:
    prompt: 'Is there an error message? If so, what does it say?'
    type: string
    activation:
      WHEN: category == "Software"
    required: false
    prompt_mode: extract_only
```

**Conversation flow:**

```
User: "My laptop won't connect to WiFi and 5 other people on my floor
       have the same problem. It says 'No networks found'."

LLM extracts via _extract_entities:
  - issue_title: "WiFi connection failure"
  - issue_description: "Laptop won't connect to WiFi, shows 'No networks found'"
  - category: "Network"
  - affected_users: 6
  - error_message: "No networks found"

LLM: "I've captured the details. How urgent is this — Low, Medium, High,
      or Critical?"

User: "High — we can't work without WiFi"

LLM extracts: priority = "High"
All required fields collected → proceeds to ticket creation
```

### Scenario 2: Insurance Claim — Progressive Disclosure

```yaml
AGENT: Claims_Agent

EXECUTION:
  inline_gather: true

GATHER:
  claim_type:
    prompt: 'What type of claim are you filing?'
    type: string
    required: true
    options: [Auto, Home, Health, Life]

  # --- Auto-specific fields ---
  vehicle_year:
    prompt: 'What year is the vehicle?'
    type: integer
    activation:
      WHEN: claim_type == "Auto"

  vehicle_make:
    prompt: 'What make (manufacturer)?'
    type: string
    activation:
      WHEN: claim_type == "Auto"

  accident_date:
    prompt: 'When did the accident occur?'
    type: date
    activation:
      WHEN: claim_type == "Auto"

  police_report:
    prompt: 'Do you have a police report number?'
    type: string
    activation:
      WHEN: claim_type == "Auto"
    required: false

  # --- Home-specific fields ---
  property_address:
    prompt: 'What is the property address?'
    type: string
    activation:
      WHEN: claim_type == "Home"
    sensitive: true
    pii_type: address

  damage_type:
    prompt: 'What type of damage?'
    type: string
    activation:
      WHEN: claim_type == "Home"
    options: [Fire, Water, Storm, Theft, Other]

  # --- Common fields (always needed) ---
  incident_date:
    prompt: 'When did the incident occur?'
    type: date
    required: true

  description:
    prompt: 'Please describe what happened'
    type: text
    required: true

  estimated_damage:
    prompt: 'What is the estimated damage amount?'
    type: currency
    required: false
    range: true
```

When the user says "Auto", only auto-specific fields activate. Home fields
never appear. The LLM collects `claim_type` first, then the condition-gated
fields unlock for the next extraction round.

### Scenario 3: Authentication Agent — FLOW-Based Strict Collection

```yaml
AGENT: Auth_Agent

FLOW:
  entry_point: collect_id
  steps:
    - collect_id
    - validate_format
    - confirm
    - authenticate

  collect_id:
    GATHER:
      - identifier_value: required
        prompt: 'Please provide your NPI ID (10 digits) or Provider ID (9 digits).'
        type: string
    THEN: validate_format

  validate_format:
    ON_INPUT:
      - IF: identifier_value MATCHES "^\\d{9}$"
        SET: auth_method = "provider_id"
        THEN: confirm
      - IF: identifier_value MATCHES "^\\d{10}$"
        SET: auth_method = "npi_id"
        THEN: confirm
      - ELSE:
        RESPOND: "That doesn't look right. Please enter exactly 9 or 10 digits."
        THEN: collect_id

  confirm:
    GATHER:
      - confirmation: required
        prompt: 'I have your ID as {{identifier_value}}. Is this correct?'
        type: boolean
    ON_INPUT:
      - IF: confirmation == true
        THEN: authenticate
      - ELSE:
        RESPOND: "No problem, let's try again."
        THEN: collect_id
```

This uses FLOW-based GATHER for strict sequential collection. The step
blocks until the field is provided. Validation happens in the next step's
`ON_INPUT` rules, creating a clean collect → validate → confirm loop.

### Scenario 4: E-Commerce Order — Sensitive Data + Transient PII

```yaml
AGENT: Checkout_Agent

EXECUTION:
  inline_gather: true

GATHER:
  shipping_address:
    prompt: 'What is your shipping address?'
    type: string
    required: true
    sensitive: true
    pii_type: address
    semantics:
      format: 'street, city, state zip'
      components: [street, city, state, zip]

  card_number:
    prompt: 'What is your credit card number?'
    type: string
    required: true
    sensitive: true
    sensitive_display: mask
    pii_type: credit_card
    mask_config:
      showFirst: 0
      showLast: 4
      char: '*'
    transient: true

  card_expiry:
    prompt: 'Expiration date (MM/YY)?'
    type: string
    required: true
    validate: "^(0[1-9]|1[0-2])/\\d{2}$"
    validation_process: REGEX
    retry_prompt: 'Please enter expiration as MM/YY (e.g., 03/26)'
    sensitive: true
    transient: true

  card_cvv:
    prompt: 'CVV (3 or 4 digits on your card)?'
    type: string
    required: true
    validate: "^\\d{3,4}$"
    validation_process: REGEX
    sensitive: true
    sensitive_display: redact
    transient: true
```

After the payment processes:

- `card_number` displays as `****-****-****-1234` in session history
- `card_cvv` displays as `[REDACTED]`
- All three `transient: true` fields are auto-cleared from session storage

### Scenario 5: Travel Search — Range, List, and Preferences

```yaml
AGENT: Travel_Search

EXECUTION:
  inline_gather: true

GATHER:
  destination:
    prompt: 'Where do you want to go?'
    type: string
    required: true

  travel_dates:
    prompt: 'What dates are you looking at?'
    type: date
    required: true
    range: true

  budget:
    prompt: 'What is your budget range per person?'
    type: currency
    required: false
    range: true

  interests:
    prompt: 'What activities interest you?'
    type: string
    required: false
    list: true
    options: [Beach, Hiking, Culture, Food, Nightlife, Shopping, Adventure, Relaxation]

  hotel_preferences:
    prompt: 'Any hotel preferences?'
    type: string
    required: false
    preferences: true
```

**User says:** "We want to go to Bali from March 10 to March 20, budget
$1500-$3000, and we love beach and culture. We definitely want a pool but
no hostels."

**Extracted:**

```json
{
  "destination": "Bali",
  "travel_dates": { "low": "2026-03-10", "high": "2026-03-20" },
  "budget": { "low": 1500, "high": 3000 },
  "interests": ["Beach", "Culture"],
  "hotel_preferences": {
    "desire": ["pool"],
    "refuse": ["hostel"]
  }
}
```

---

## 14. Rules and Best Practices

### Do

1. **Set `inline_gather: true`** for reasoning agents where users provide
   information naturally. It allows multi-field extraction from a single
   message.

2. **Use `activation` for conditional fields** instead of asking for
   everything upfront. Progressive disclosure makes conversations feel
   natural.

3. **Set `default` for optional fields** that have a sensible fallback value.
   This prevents blocking on non-essential information.

4. **Use `options` for constrained fields.** They become JSON Schema `enum`
   constraints in the extraction tool, guiding the LLM to normalize values.

5. **Mark PII fields as `sensitive: true`** and use `transient: true` for
   data that should not persist (card numbers, SSNs).

6. **Use `entity_ref`** for types that are reused across multiple agents.
   Define once in `ENTITIES:`, reference everywhere.

7. **Use FLOW-based GATHER** when strict field ordering and sequential
   validation matter (authentication flows, multi-step forms).

8. **Provide `retry_prompt`** for fields with validation. The default
   validation error message is generic — a custom retry prompt guides
   the user much better.

### Don't

1. **Don't use `required: true` on every field.** Only fields truly needed
   to proceed should be required. Optional fields can be collected
   opportunistically.

2. **Don't rely on `validate` without `validation_process`.** Without
   specifying `REGEX`, `CODE`, or `LLM`, the validation string is ambiguous
   and may not be applied correctly.

3. **Don't mix `inline_gather: true` with FLOW-based GATHER** in the same
   agent unless you understand the interaction. FLOW-step GATHER takes
   precedence when a step is active.

4. **Don't use `extraction_pattern` for complex NLP tasks.** Regex works
   for structured formats (ticket IDs, ZIP codes, phone numbers) but not
   for fuzzy natural language. Use `type` + LLM extraction for those.

5. **Don't create gather fields for internal state.** Use `MEMORY.session`
   for values the LLM computes or infers. GATHER fields are specifically
   for user-provided information.

6. **Don't set `max_retries` too high.** Users get frustrated after 2-3
   failed attempts. Set `max_retries: 3` and provide an escape path
   (escalation or alternative flow).

---

## 15. How It Works at Runtime

### Reasoning Agent with Inline Gather

1. **System prompt injection** — The prompt builder adds an "Inline Gather
   Status" section listing collected and uncollected fields.

2. **Tool generation** — An `_extract_entities` tool is generated with
   typed properties for each uncollected field. Options become enum
   constraints, ranges become object schemas, lists become array schemas.

3. **LLM turn** — The LLM responds to the user and may call
   `_extract_entities` to save extracted values. All properties are
   optional (`required: []`) — the LLM only extracts what's present.

4. **Fallback extraction** — If the LLM doesn't call `_extract_entities`
   but the user's message likely contains extractable values, the runtime
   runs a fallback extraction pass after constraint checks.

5. **Validation** — Extracted values are validated against field rules
   (intrinsic type validation, pattern validation, range validation,
   enum validation). Failed values go into `_validation_errors`.

6. **Completion check** — `checkGatherComplete` evaluates which required
   fields are still missing, respecting activation modes and `depends_on`
   chains. When all required fields are collected, `_extract_entities`
   is removed from the tool list.

7. **PII cleanup** — After gather completes, `transient: true` fields are
   cleared from session storage.

### Flow Agent with Step Gather

1. **Step activation** — When a FLOW step with GATHER becomes active, the
   runtime checks which fields are already collected vs. missing.

2. **Prompt building** — `buildGatherPrompt` creates a prompt from the
   missing fields' individual prompts (or the step-level PROMPT template).

3. **Entity extraction** — The runtime runs entity extraction on the user's
   message using the configured strategy (llm, pattern, or hybrid).

4. **Validation** — Same as reasoning agents.

5. **Completeness check** — If required fields are still missing, the step
   loops (asks again). If all are collected, the step proceeds to its
   `THEN` target.

6. **Gather interrupts** — If the user says something unrelated to the
   gather fields (e.g., "I want to cancel" during data collection), the
   runtime can detect this as a **gather interrupt** and route to a
   supervisor or digression handler, depending on the agent's intent
   configuration.

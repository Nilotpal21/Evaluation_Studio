# Tools and Information Gathering

This document covers the TOOLS and GATHER constructs for external integrations and information collection.

## Table of Contents

1. [TOOLS Construct](#1-tools-construct)
2. [GATHER Construct](#2-gather-construct)
3. [Entity Extraction](#3-entity-extraction)
4. [Enhanced GATHER](#4-enhanced-gather)
5. [Implementation Status](#5-implementation-status-original)
6. [Test Coverage](#6-test-coverage)

---

## 1. TOOLS Construct

TOOLS defines external functions the agent can call to perform actions or retrieve information.

### DSL Syntax

```dsl
TOOLS:
  search_hotels(destination: string, checkin: date, checkout: date, guests: number) -> Hotel[]
  get_hotel_details(hotel_id: string) -> HotelDetails
  check_availability(hotel_id: string, dates: DateRange) -> {available: boolean, price: number}
  book_hotel(hotel_id: string, guest_info: GuestInfo) -> BookingConfirmation
  send_email(to: string, subject: string, body: string) -> {sent: boolean, messageId: string}
```

### Parameter Types

| Type         | Description   | Example              |
| ------------ | ------------- | -------------------- |
| `string`     | Text value    | `"Paris"`            |
| `number`     | Numeric value | `42`, `3.14`         |
| `date`       | Date value    | `"2026-03-15"`       |
| `boolean`    | True/false    | `true`               |
| `object`     | JSON object   | `{name: "John"}`     |
| `array`      | List of items | `["a", "b"]`         |
| `CustomType` | Named type    | `Hotel`, `GuestInfo` |
| `Type[]`     | Array of type | `Hotel[]`            |

### IR Schema

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameter[];
  returns: ToolReturnType;
  hints: ToolHints;
}

interface ToolParameter {
  name: string;
  type: string;
  description?: string;
  required: boolean;
  default?: unknown;
  validation?: string;
}

interface ToolHints {
  cacheable: boolean; // Can results be cached?
  latency: 'fast' | 'medium' | 'slow';
  parallelizable: boolean; // Can run with other tools?
  side_effects: boolean; // Does it modify state?
  requires_auth: boolean; // Needs authentication?
}
```

### Tool Generation (Anthropic Format)

```typescript
// Generated tool schema for LLM
{
  name: 'search_hotels',
  description: 'Search for available hotels',
  input_schema: {
    type: 'object',
    properties: {
      destination: { type: 'string', description: 'Destination city' },
      checkin: { type: 'string', description: 'Check-in date' },
      checkout: { type: 'string', description: 'Check-out date' },
      guests: { type: 'number', description: 'Number of guests' },
    },
    required: ['destination', 'checkin', 'checkout'],
  },
}
```

### Mock Tool Implementation

The test server includes mocks for 25+ tools:

| Category       | Tools                                                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Travel**     | search_hotels, get_hotel_details, check_availability, search_flights, book_hotel, book_flight, create_booking, get_deals, lookup_booking |
| **Healthcare** | check_symptoms, schedule_appointment, get_medication_info                                                                                |
| **Generic**    | greet_user, web_search, send_email, get_weather                                                                                          |
| **System**     | **handoff**, **delegate**, **complete**, **escalate**                                                                                    |

---

> **Note**: `web_search`, `send_email`, `get_weather`, and `greet_user` are **example tool names** used in test fixtures, not platform-provided built-in tools. Agents define their own tools via the `TOOLS` DSL section. Similarly, `code_interpreter` is not a platform tool — it would need to be defined as a custom tool with an appropriate executor.

## 2. GATHER Construct

GATHER defines information to collect from the user through conversation.

### DSL Syntax

```dsl
GATHER:
  destination:
    prompt: "Where would you like to stay?"
    type: string
    required: true

  checkin:
    prompt: "What's your check-in date?"
    type: date
    required: true

  guests:
    prompt: "How many guests?"
    type: number
    required: false
    default: 2
    validate: "1 <= value <= 10"
```

### Field Properties

| Property   | Required | Description                                    |
| ---------- | -------- | ---------------------------------------------- |
| `prompt`   | Yes      | Question to ask user                           |
| `type`     | Yes      | Data type (string, number, date, email, phone) |
| `required` | No       | Whether field is mandatory (default: false)    |
| `default`  | No       | Default value if not provided                  |
| `validate` | No       | Validation expression                          |

### IR Schema

```typescript
interface GatherConfig {
  fields: GatherField[];
  strategy: 'llm' | 'pattern' | 'hybrid';
}

interface GatherField {
  name: string;
  prompt: string;
  type: string;
  required: boolean;
  default?: unknown;
  validation?: ValidationRule;
  extraction_hints?: string[];
}
```

### Extraction Strategy

| Mode      | Strategy  | Description                             |
| --------- | --------- | --------------------------------------- |
| Reasoning | `llm`     | LLM extracts entities from conversation |
| Scripted  | `pattern` | Pattern-based extraction (regex, rules) |
| Hybrid    | `hybrid`  | Pattern first, LLM fallback             |

---

## 3. Entity Extraction

### Pattern-Based Extraction (Flow Mode)

The runtime executor includes pattern-based extraction for common types:

```typescript
private extractEntities(userMessage: string, fields: string[]): Record<string, unknown> {
  const extracted: Record<string, unknown> = {};
  const message = userMessage.trim();

  for (const field of fields) {
    const fieldLower = field.toLowerCase();

    // Date extraction
    if (fieldLower.includes('date') || fieldLower.includes('checkin')) {
      // ISO format: 2026-03-15
      // US format: 03/15/2026
      // Written: March 15, 2026
      // Relative: tomorrow, today, next week
    }

    // Number extraction
    if (fieldLower.includes('night') || fieldLower.includes('guest')) {
      // "3 nights" → 3
      // "2 guests" → 2
    }

    // Email extraction
    if (fieldLower.includes('email')) {
      // Pattern: /[\w.+-]+@[\w.-]+\.\w{2,}/
    }

    // Phone extraction
    if (fieldLower.includes('phone')) {
      // Pattern: /[\d\s\-\+\(\)]{10,}/
    }

    // Name extraction
    if (fieldLower.includes('name')) {
      // Capitalized words
    }
  }

  return extracted;
}
```

### Supported Extraction Patterns

| Type            | Patterns                   | Examples                                           |
| --------------- | -------------------------- | -------------------------------------------------- |
| **Date**        | ISO, US, Written, Relative | `2026-03-15`, `03/15/2026`, `March 15`, `tomorrow` |
| **Number**      | Plain, With unit           | `5`, `3 nights`, `2 guests`                        |
| **Email**       | Standard email format      | `user@example.com`                                 |
| **Phone**       | Various formats            | `+1-555-123-4567`, `(555) 123-4567`                |
| **Name**        | Capitalized words          | `John Smith`                                       |
| **Destination** | City names                 | `Paris`, `New York`                                |

---

## 4. Enhanced GATHER

The GATHER construct has been significantly extended to support semantic typing, range and list collection, preference detection, progressive activation, and advanced validation.

### 4.1 Semantics System

Each GATHER field can declare a `SEMANTICS` sub-block that provides supplemental metadata for entity extraction and validation.

```dsl
GATHER:
  destination:
    PROMPT: "Where would you like to go?"
    TYPE: string
    SEMANTICS:
      FORMAT: airport_code
      LOOKUP: iata_codes
      KORE_ENTITY_TYPE: Airport

  address:
    PROMPT: "What is your address?"
    TYPE: string
    SEMANTICS:
      COMPONENTS: [street, city, state, zip]

  temperature:
    PROMPT: "What temperature?"
    TYPE: number
    SEMANTICS:
      UNIT: fahrenheit
      CONVERT_TO: celsius
```

#### Semantics Properties

| Property           | Type     | Description                                                             |
| ------------------ | -------- | ----------------------------------------------------------------------- |
| `FORMAT`           | string   | Expected format (e.g., `airport_code`, `iso_date`, `phone_e164`)        |
| `LOOKUP`           | string   | Named lookup table for validation (e.g., `iata_codes`, `country_codes`) |
| `COMPONENTS`       | string[] | Sub-fields to decompose the value into                                  |
| `UNIT`             | string   | Unit of measurement (e.g., `fahrenheit`, `miles`, `usd`)                |
| `CONVERT_TO`       | string   | Target unit for automatic conversion                                    |
| `KORE_ENTITY_TYPE` | string   | Maps to a Kore.ai platform entity type (25+ supported)                  |

#### Supported Kore Entity Types

Airport, City, Country, Currency, Date, DateTime, Duration, Email, Location, Number, Percentage, PhoneNumber, Temperature, Time, URL, ZipCode, Address, Color, Company, Organization, Person, Quantity, String, Attachment, List, Description, Custom.

### 4.2 Range Support

Fields with `RANGE: true` collect values as `{low, high}` pairs.

```dsl
GATHER:
  budget:
    PROMPT: "What is your budget range?"
    TYPE: number
    RANGE: true
```

#### IR Value Shape

```typescript
interface RangeValue {
  low: number | null;
  high: number | null;
}
```

When the user says "between $100 and $500", the runtime extracts `{ low: 100, high: 500 }`. Partial ranges like "under $200" produce `{ low: null, high: 200 }`.

### 4.3 List and Preferences

Fields can collect arrays and categorize user preferences.

```dsl
GATHER:
  activities:
    PROMPT: "What activities interest you?"
    TYPE: string
    LIST: true
    PREFERENCES: true
```

#### List Mode (`LIST: true`)

Collects values as an array. The user can provide multiple values in a single message:

- "I like hiking, swimming, and kayaking" -> `["hiking", "swimming", "kayaking"]`

#### Preference Mode (`PREFERENCES: true`)

When combined with `LIST: true`, categorizes items into preference buckets:

```typescript
interface PreferenceValue {
  accept: string[]; // Items the user is OK with
  desire: string[]; // Items the user actively wants
  avoid: string[]; // Items the user prefers not to have
  refuse: string[]; // Items the user will not accept
}
```

User says: "I love hiking, swimming is fine, but definitely no skydiving" ->

```json
{
  "desire": ["hiking"],
  "accept": ["swimming"],
  "refuse": ["skydiving"],
  "avoid": []
}
```

### 4.4 Activation Modes

The `ACTIVATION` property controls when a field becomes active for collection.

```dsl
GATHER:
  destination:
    ACTIVATION: required      # Always active, must be collected

  special_requests:
    ACTIVATION: optional      # Active but not mandatory

  room_type:
    ACTIVATION: progressive   # Active only when dependencies are met
    DEPENDS_ON: [destination, budget]

  military_id:
    ACTIVATION:
      WHEN: "search_results contains 'Hale Koa'"  # Data-driven activation
```

#### Activation Types

| Type             | Behavior                                                          |
| ---------------- | ----------------------------------------------------------------- |
| `required`       | Field is always active and must be collected before proceeding    |
| `optional`       | Field is active but the agent can proceed without it              |
| `progressive`    | Field becomes active only after `DEPENDS_ON` fields are collected |
| `{ WHEN: expr }` | Field becomes active when the condition evaluates to true         |

#### DEPENDS_ON for Progressive Activation

Fields with `ACTIVATION: progressive` use `DEPENDS_ON` to list prerequisite fields. The runtime validates dependency references at compile time and detects cycles.

```dsl
GATHER:
  room_type:
    ACTIVATION: progressive
    DEPENDS_ON: [destination, budget]   # Only asked after destination and budget are filled
```

### 4.5 Prompt Mode

Controls whether the agent proactively asks for a field or only extracts it from user messages.

```dsl
GATHER:
  destination:
    PROMPT: "Where would you like to go?"
    PROMPT_MODE: ask            # Agent asks this question

  travel_purpose:
    PROMPT_MODE: extract_only   # Never asked, only extracted if mentioned
```

| Mode            | Behavior                                                           |
| --------------- | ------------------------------------------------------------------ |
| `ask` (default) | Agent actively prompts the user for this field                     |
| `extract_only`  | Agent never asks; value is only captured if the user volunteers it |

#### Default Value and Prompt Mode Interaction

| `DEFAULT` | `PROMPT_MODE`  | Behavior                                           |
| --------- | -------------- | -------------------------------------------------- |
| Not set   | `ask`          | Agent asks the user; field required per ACTIVATION |
| Set       | `ask`          | Agent asks the user; uses default if user skips    |
| Not set   | `extract_only` | Never asked; captured only if user volunteers      |
| Set       | `extract_only` | Never asked; default used unless user mentions it  |

### 4.6 Validation Types

Enhanced validation supports multiple strategies beyond simple expression validation.

```dsl
GATHER:
  email:
    TYPE: string
    VALIDATION: pattern
    VALIDATION_RULE: "/^[\\w.+-]+@[\\w.-]+\\.\\w{2,}$/"

  budget:
    TYPE: number
    VALIDATION: range
    VALIDATION_RULE: "100 <= value <= 10000"

  room_type:
    TYPE: string
    VALIDATION: enum
    VALIDATION_RULE: "standard, deluxe, suite, penthouse"

  travel_reason:
    TYPE: string
    VALIDATION_PROCESS: LLM
    VALIDATION_RULE: "Must be a legitimate travel reason"

  age:
    TYPE: number
    VALIDATION: custom
    VALIDATION_RULE: "value >= 18"
```

#### Validation Process Types

| Type      | Description                                        |
| --------- | -------------------------------------------------- |
| `pattern` | Regex pattern match                                |
| `range`   | Numeric range check                                |
| `enum`    | Value must be one of listed options                |
| `custom`  | Arbitrary boolean expression                       |
| `LLM`     | LLM evaluates whether the value satisfies the rule |

### 4.7 Retry Prompt and Max Retries

When validation fails, a custom retry prompt is shown and retry attempts are capped.

```dsl
GATHER:
  phone:
    PROMPT: "What is your phone number?"
    TYPE: string
    VALIDATION: pattern
    VALIDATION_RULE: "/^\\+?[\\d\\s\\-()]{10,}$/"
    RETRY_PROMPT: "That doesn't look like a valid phone number. Please enter a number with area code."
    MAX_RETRIES: 3
```

| Property       | Default                 | Description                                                 |
| -------------- | ----------------------- | ----------------------------------------------------------- |
| `RETRY_PROMPT` | Re-uses original PROMPT | Custom message shown when validation fails                  |
| `MAX_RETRIES`  | 3                       | Maximum validation retry attempts before escalation or skip |

### 4.8 Enhanced IR Schema

```typescript
interface GatherField {
  name: string;
  prompt: string;
  type: string;
  required: boolean;
  default?: unknown;
  validation?: ValidationRule;
  extraction_hints?: string[];

  // Enhanced properties
  semantics?: GatherFieldSemantics;
  range?: boolean;
  list?: boolean;
  preferences?: boolean;
  activation?: 'required' | 'optional' | 'progressive' | { when: string };
  depends_on?: string[];
  prompt_mode?: 'ask' | 'extract_only';
  validation_process?: 'pattern' | 'range' | 'enum' | 'custom' | 'llm';
  retry_prompt?: string;
  max_retries?: number;
}

interface GatherFieldSemantics {
  format?: string;
  lookup?: string;
  components?: string[];
  unit?: string;
  convert_to?: string;
  kore_entity_type?: string;
}

interface RangeValue {
  low: number | null;
  high: number | null;
}

interface PreferenceValue {
  accept: string[];
  desire: string[];
  avoid: string[];
  refuse: string[];
}
```

### 4.9 Lookup Tables

GATHER fields can reference lookup tables for value validation, fuzzy matching, and suggestions. Lookup tables support three source types.

#### DSL Syntax

```dsl
GATHER:
  destination:
    prompt: "Where would you like to go?"
    type: string
    LOOKUP:
      source: inline
      values:
        - code: LAX
          label: "Los Angeles"
          aliases: ["LA", "Los Angeles"]
        - code: JFK
          label: "New York JFK"
          aliases: ["New York", "NYC"]
      fuzzy_match: true
      fuzzy_threshold: 0.7

  country:
    prompt: "Which country?"
    type: string
    LOOKUP:
      source: collection
      collection: countries
      value_field: code
      label_field: name

  product:
    prompt: "Which product?"
    type: string
    LOOKUP:
      source: api
      url: "https://api.example.com/products"
      value_field: id
      label_field: name
      cache_ttl: 3600
```

#### Lookup Source Types

| Source       | Description                        | Configuration                                    |
| ------------ | ---------------------------------- | ------------------------------------------------ |
| `inline`     | Values defined directly in the DSL | `values: [{code, label, aliases?}]`              |
| `collection` | Values from a MongoDB collection   | `collection`, `value_field`, `label_field`       |
| `api`        | Values from an external HTTP API   | `url`, `value_field`, `label_field`, `cache_ttl` |

> **Note**: Source type names were redesigned in March 2026. The previous names `mongodb` and `http` are no longer used — use `collection` and `api` instead.

#### Fuzzy Matching

When `fuzzy_match: true`, the runtime performs approximate string matching against lookup values and their aliases. The `fuzzy_threshold` (0-1, default 0.7) controls match sensitivity. Fuzzy matches generate `lookup_fuzzy_confirmation_requested` trace events and prompt the user for confirmation before accepting.

#### IR Schema

```typescript
interface LookupConfig {
  source: 'inline' | 'collection' | 'api';
  values?: LookupValue[]; // For inline source
  collection?: string; // For collection source
  url?: string; // For api source
  value_field?: string;
  label_field?: string;
  cache_ttl?: number; // Cache duration in seconds
  fuzzy_match?: boolean;
  fuzzy_threshold?: number;
}

interface LookupValue {
  code: string;
  label: string;
  aliases?: string[];
}
```

#### Trace Events

| Event                                 | When                           | Data                                |
| ------------------------------------- | ------------------------------ | ----------------------------------- |
| `lookup_match`                        | Exact match found              | `{field, value, source}`            |
| `lookup_fuzzy_confirmation_requested` | Fuzzy match needs confirmation | `{field, value, match, confidence}` |
| `lookup_fuzzy_accepted`               | User confirmed fuzzy match     | `{field, value}`                    |
| `lookup_fuzzy_rejected`               | User rejected fuzzy match      | `{field, value}`                    |

---

## 5. Implementation Status (Original)

### TOOLS

| Feature                 | Parser | Compiler | Runtime | Status          |
| ----------------------- | ------ | -------- | ------- | --------------- |
| Tool definition parsing | ✅     | ✅       | -       | Complete        |
| Parameter parsing       | ✅     | ✅       | -       | Complete        |
| Return type parsing     | ✅     | ✅       | -       | Complete        |
| Tool schema generation  | -      | ✅       | ✅      | Complete        |
| Tool execution          | -      | -        | 🔶      | Mocked          |
| Real tool adapters      | -      | -        | ❌      | Not implemented |

### GATHER

| Feature            | Parser | Compiler | Runtime | Status                             |
| ------------------ | ------ | -------- | ------- | ---------------------------------- |
| Field definition   | ✅     | ✅       | ✅      | Complete                           |
| Prompt generation  | -      | ✅       | ✅      | Complete                           |
| LLM extraction     | -      | ✅       | ✅      | Complete                           |
| Pattern extraction | -      | -        | ✅      | Complete                           |
| Validation         | ✅     | ✅       | ✅      | Complete                           |
| Lookup tables      | ✅     | ✅       | ✅      | Complete (inline, collection, api) |
| Fuzzy matching     | -      | -        | ✅      | Complete                           |
| Field inference    | -      | -        | ✅      | Complete                           |
| NLU trace events   | -      | -        | ✅      | Complete (17 event types)          |

---

## 6. Test Coverage

### Entity Extraction Tests (17 tests)

```typescript
describe('Entity Extraction', () => {
  describe('Date Extraction', () => {
    test('should extract ISO date format'); // 2026-03-15
    test('should extract US date format'); // 03/15/2026
    test('should extract written date format'); // March 15, 2026
    test('should handle relative dates - tomorrow');
    test('should handle relative dates - today');
  });

  describe('Number Extraction', () => {
    test('should extract nights count'); // 3 nights → 3
    test('should extract guest count'); // 2 guests → 2
    test('should extract room count'); // 1 room → 1
    test('should extract plain number'); // 5 → 5
  });

  describe('Email Extraction', () => {
    test('should extract email address');
    test('should extract email from text');
  });

  describe('Phone Extraction', () => {
    test('should extract phone number');
  });

  describe('Name Extraction', () => {
    test('should extract name');
  });

  describe('Destination Extraction', () => {
    test('should extract destination');
    test('should extract city');
  });

  describe('Default Extraction', () => {
    test('should store raw input for unknown field types');
    test('should store raw input when single field');
  });
});
```

### Gather Executor Tests (20 tests)

From `packages/compiler/src/__tests__/constructs/gather-executor.test.ts`:

- LLM-based extraction
- Email/phone extraction
- Date/number extraction
- Multiple field extraction
- Validation and confidence

---

## File Locations

| Component         | Path                                                                     |
| ----------------- | ------------------------------------------------------------------------ |
| Tools Parser      | `packages/core/src/parser/agent-based-parser.ts`                         |
| Tools Compiler    | `packages/compiler/src/platform/ir/compiler.ts:173-208`                  |
| Gather Compiler   | `packages/compiler/src/platform/ir/compiler.ts:210-227`                  |
| Entity Extraction | `apps/runtime/src/services/runtime-executor.ts`                          |
| Gather Executor   | `packages/compiler/src/platform/constructs/executors/gather-executor.ts` |
| Mock Tools        | `apps/runtime/src/services/runtime-executor.ts`                          |

---

_Last Updated: March 2026_

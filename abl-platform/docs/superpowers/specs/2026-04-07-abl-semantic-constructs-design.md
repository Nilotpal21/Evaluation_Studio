# ABL Semantic Constructs Design

> Status: Draft (Updated with key design decisions 2026-04-07)
> Date: 2026-04-07
> Scope: semantic definitions, vocabulary, interpretation, collection, control, enforcement, memory, and tracing

## 1. Decision Summary

ABL should keep `NLU` and `GATHER` as separate constructs, but stop making them carry duplicate semantic definitions.

The recommended model is:

- `ENTITIES` defines reusable semantic types, extraction methods, and intrinsic validation rules.
- `VOCABULARY` defines domain language, aliases, jargon, and grounding terms.
- `NLU` consumes `ENTITIES` and `VOCABULARY` to interpret user messages.
- `GATHER` consumes `ENTITIES` to define which values the agent wants to collect, validate, protect, and commit into state.
- `LOOKUP_TABLES` provides shared reference data for validation, normalization, and suggestion.
- `MEMORY` defines what committed values become session state, persistent facts, and recalled context.
- `FLOW`, `ROUTING`, `CONSTRAINTS`, and `GUARDRAILS` consume the results of `NLU` and `GATHER`, but do not redefine their concerns.

This preserves an important distinction:

- `NLU` owns observation and interpretation.
- `GATHER` owns collection and commitment.

The language should add a first-class `ENTITIES` construct and a first-class `VOCABULARY` construct. In the transition period, existing `NLU.entities` and `NLU.glossary` should continue to work and lower into those canonical layers.

### 1.1 Key Design Decisions

The following decisions were made during design review and are binding for implementation:

1. **Scoping**: Entities are **utterance-scoped** — extracted from every user message, every turn, regardless of GATHER. GATHER fields are **session-scoped** — values persist in session state once committed. Without GATHER, extracted entities exist only for that turn (observations).

2. **Extraction method ownership**: The entity owns its extraction/recognition method (regex, enum match, LLM extraction, date parsing). GATHER does not define how to extract — only what to do after extraction.

3. **Validation split**: Entities own **intrinsic validation** (is this a valid email format? is this value in the allowed enum?). GATHER owns **business validation** (must be a corporate email, must be a future date, must differ from origin).

4. **GATHER inline types are syntactic sugar**: When a GATHER field defines `TYPE: email` without `ENTITY_REF`, the compiler decouples this at compile time into an anonymous entity definition plus a collection-policy reference. The developer writes it inline; the compiler separates concerns.

5. **`ENTITY_REF` exclusivity**: When a GATHER field uses `ENTITY_REF`, it must not redefine entity-level properties (TYPE, VALUES, SYNONYMS, PATTERN). It may only define collection-policy properties (PROMPT, REQUIRED, CONFIRM, MAX_RETRIES, VALIDATE for business rules, SENSITIVITY, etc.).

6. **Multi-value resolution — same entity type, multiple GATHER fields**: When multiple values of the same entity type are extracted and multiple GATHER fields reference that type, the runtime uses **LLM contextual disambiguation**. The LLM receives the original utterance, extracted values, and field names/prompts to assign values to the correct slots.

7. **Multi-value resolution — same entity type, one GATHER field**: When multiple values are extracted but only one GATHER field exists for that entity type, the runtime **always asks for clarification**. It presents the candidates and asks the user to choose.

8. **Unified type system**: GATHER field types and NLU entity types should converge into a single entity type system. Types like `email`, `phone`, and `boolean` are named entities with built-in patterns, not a separate type hierarchy.

## 2. Problem Statement

Today the language makes `NLU` and `GATHER` look more similar than they really are.

They both talk about:

- types
- extraction
- normalization
- validation
- hints
- correction

This is useful implementation-wise, but confusing authoring-wise. The constructs overlap in mechanics but diverge in purpose:

- `NLU` wants to understand what the user meant.
- `GATHER` wants to decide what the agent cares enough to ask for, store, validate, and act on.

That distinction is real, but the current surface does not teach it clearly. As a result, authors naturally ask:

- Why are there two different paths for entities?
- If both can extract and normalize values, why not merge them?
- If `GATHER` has optional fields, isn't it also just recognition?
- If everything should be traced, why distinguish observational values from stored values?

These are good questions. The answer is not "the two constructs are completely different." They are not. The answer is that they operate at different layers of commitment.

## 3. Goals

- Make the mental model of semantic constructs easy to explain.
- Eliminate duplicated semantic definitions where possible.
- Preserve a clear distinction between interpretation and committed conversational state.
- Support future custom entities, entity hierarchies, intent hierarchies, and reusable semantic libraries.
- Improve tracing by making the lifecycle of a value explicit.
- Keep the design compatible with current ABL authoring patterns.

## 4. Non-Goals

- This document does not redesign every ABL section.
- This document does not prescribe exact parser syntax for every future field.
- This document does not require immediate migration of all existing agents.
- This document does not make `GATHER` mandatory for all structured values.

## 5. Design Principles

### 5.1 Separate meaning from commitment

The system should distinguish between:

- what it observed
- what it accepted
- what it committed

A message can mention many meaningful things that should influence routing or reasoning without automatically becoming agent state.

### 5.2 Define semantics once

Reusable semantic concepts should not be redefined separately inside `NLU`, `GATHER`, tool hints, analytics, and documentation. Canonical definitions should live in one place.

### 5.3 Keep collection policy local

Prompts, requiredness, correction policy, sensitivity, defaults, confirmation rules, and completion semantics belong to the collection layer, not the semantic layer.

### 5.4 Preserve observability

Tracing should represent the full lifecycle of a value. That becomes easier when observation and commitment are explicit rather than blurred together.

### 5.5 Prefer additive compatibility

Existing agents should continue to compile. New constructs should be introducible through lowering and lint-guided migration, not a flag day rewrite.

## 6. Construct Model

### 6.1 `ENTITIES`: reusable semantic definitions

`ENTITIES` should become the canonical place to define extractable, structured semantic concepts.

An entity answers:

"What kind of thing can the system recognize and normalize?"

Examples:

- `currency_code`
- `booking_reference`
- `travel_date`
- `airport_code`
- `address`
- `incident_category`

An entity owns:

- type
- extraction method (how to recognize: regex, enum match, LLM extraction, date parsing)
- synonyms
- normalization rules
- patterns
- canonical value definitions
- hierarchy metadata
- locale behavior
- intrinsic validation (is this value valid for this kind of thing?)

Intrinsic validation examples by system entity type:

| Entity Type | Built-in Intrinsic Validation                      |
| ----------- | -------------------------------------------------- |
| email       | RFC-compliant format check                         |
| phone       | Digit count, optional country code format          |
| date        | Parseable to a real calendar date                  |
| enum        | Value is in the allowed set                        |
| number      | Parseable as numeric                               |
| pattern     | Matches the defined regex                          |
| currency    | Valid numeric amount with optional currency symbol |
| boolean     | Resolves to true/false (yes/no/true/false/1/0)     |

An entity does not own:

- whether the agent should ask for it
- whether it is required in this conversation
- how it should be phrased to the user
- whether it should be persisted in memory
- whether it should be confirmed before use
- business-specific validation rules (e.g., "must be a corporate email", "must be a future date")

**Scoping**: Entities are **utterance-scoped**. The runtime extracts all defined entities from every user message on every turn, regardless of whether GATHER fields exist. Extracted values live in the observation layer for that turn. They are available for routing, context passing, and trace logging. They do not persist to session state unless a GATHER field commits them.

This is the right home for custom entity libraries, domain ontologies, and future hierarchy support.

### 6.2 `VOCABULARY`: domain language and grounding

`VOCABULARY` should become the canonical place to define domain terms, aliases, abbreviations, jargon, and explanatory grounding.

A vocabulary term answers:

"What words and phrases matter in this domain, even when they are not structured slot values?"

Examples:

- `chargeback`
- `SWIFT`
- `Fedwire`
- `OFAC`
- `provisional credit`
- `premium economy`

Vocabulary owns:

- canonical term
- aliases
- definition
- optional category
- optional linked intents
- optional linked entities
- optional retrieval hints

Vocabulary does not own:

- conversational state
- requiredness
- prompting policy
- field validation

This is distinct from entities. Many important domain terms are not values that should be extracted into slots. They still matter for classification, retrieval, clarification, and response quality.

### 6.3 `NLU`: interpretation

`NLU` should own interpretation policy and behavior.

`NLU` answers:

"What did the user mean in this message?"

`NLU` should own:

- intents
- categories
- multi-intent configuration
- digression interpretation
- interpretation models
- thresholds
- model/language configuration
- interpretation strategies over `ENTITIES` and `VOCABULARY`

`NLU` should consume:

- `ENTITIES`
- `VOCABULARY`
- conversation context
- flow context
- recent state

`NLU` output should remain observational and confidence-bearing. It may influence routing or reasoning without mutating committed business state.

### 6.4 `GATHER`: collection and commitment

`GATHER` should own the conversational contract for state collection.

`GATHER` answers:

"What values does this agent want to collect, confirm, validate, and commit into session state?"

`GATHER` should own:

- prompt
- requiredness
- optionality
- defaults
- confirmation policy
- correction handling
- dependencies
- progressive activation
- sensitivity
- persistence/transience
- business validation (rules specific to this use case, layered on top of entity intrinsic validation)
- field-level display and masking rules

`GATHER` does not own:

- extraction method (entity concern)
- intrinsic validation (entity concern)
- type definition (entity concern)
- synonyms (entity concern)
- normalization rules (entity concern)

**Scoping**: GATHER fields are **session-scoped**. Once a value passes validation and is committed, it persists in session state for the duration of the conversation. This is what distinguishes GATHER from entity extraction — extraction is ephemeral per-turn observation; GATHER is durable session commitment.

#### `ENTITY_REF` mode

`GATHER` should preferably reference `ENTITIES` using `ENTITY_REF`. When `ENTITY_REF` is present:

- The field inherits all semantic properties (type, values, synonyms, pattern, intrinsic validation) from the referenced entity.
- The field **must not** redefine entity-level properties: `TYPE`, `VALUES`, `SYNONYMS`, `PATTERN`.
- The field **may** define collection-policy properties: `PROMPT`, `REQUIRED`, `CONFIRM`, `MAX_RETRIES`, `RETRY_PROMPT`, `SENSITIVITY`, `VALIDATE` (for business rules), `VALIDATION_PROCESS`, `DEFAULT`, `ACTIVATION`, `COMPLETE_WHEN`.
- Business validation via `VALIDATE` is layered on top of intrinsic validation. Both must pass.

```abl
GATHER:
  work_email:
    ENTITY_REF: email                          # inherits email format validation
    PROMPT: "Your work email?"
    REQUIRED: true
    VALIDATE: "must end with @company.com"     # business rule, layered on top
    VALIDATION_PROCESS: LLM                    # business rule uses LLM
```

#### Inline type mode (syntactic sugar)

`GATHER` must remain able to define local one-off fields with inline `TYPE`:

```abl
GATHER:
  proceed_confirmation:
    TYPE: boolean
    PROMPT: "Submit this transfer now?"
    REQUIRED: true
```

When a field uses inline `TYPE` without `ENTITY_REF`, the compiler decouples it at compile time into:

1. An anonymous entity definition (type, intrinsic validation) → stored in the canonical entity registry in IR
2. A collection-policy reference → stored in the GATHER IR

The developer writes it inline; the compiler separates concerns. This is backward-compatible with all existing ABL files.

#### Optional fields

Even optional gather fields are still part of the state model. "Optional" means:

- do not proactively ask unless useful
- accept if present
- store if accepted

It does not mean the field is merely observational.

### 6.5 `FLOW` and `ROUTING`: control

`FLOW` and `ROUTING` should remain control constructs.

`ROUTING` answers:

"Which agent or branch should handle this message?"

It should rely primarily on `NLU` outputs.

`FLOW` answers:

"What step should happen next?"

It should rely primarily on:

- committed gather state
- tool results
- explicit step conditions
- selected interpretation signals where needed

This keeps interpretation and collection as inputs to control, not control themselves.

### 6.6 `CONSTRAINTS` and `GUARDRAILS`: enforcement

`CONSTRAINTS` enforce business validity over accepted or committed state.

Examples:

- do not process refund before `order_id` is collected
- transfer amount must be below approval threshold without secondary auth
- destination must differ from origin

`GUARDRAILS` enforce safety and policy over input, output, and action surfaces.

Examples:

- redact credentials
- block disallowed financial advice
- enforce regulatory phrasing

Neither construct should redefine semantics. They should consume the outputs of `NLU`, `GATHER`, tools, and memory.

### 6.7 `MEMORY`: persistence policy

`MEMORY` should define what survives beyond the immediate turn or session.

This is distinct from `GATHER`. A value may be gathered and committed to session state without becoming durable long-term memory. Similarly, a memory system may summarize or persist facts derived from repeated gathered values.

`MEMORY` answers:

"What should be initialized, retained, recalled, and persisted after collection and action?"

`MEMORY` should own:

- session variables
- persistent facts
- remember triggers
- recall instructions
- ownership scope for durable data
- reset policy
- fact-store interaction policy

`MEMORY` should consume:

- committed gather state
- selected tool results
- selected interpretation outputs when they are promoted into facts

`MEMORY` should not be treated as a replacement for `GATHER`. The two constructs sit on different sides of the same boundary:

- `GATHER` decides what the agent wants to collect and commit now.
- `MEMORY` decides what the platform should retain and re-inject later.

This is already a fairly clean part of the language design today. The current `MEMORY` block is strongly aligned with the proposed model because it is policy-oriented rather than semantic-definition-oriented.

### 6.8 `LOOKUP_TABLES`: shared reference data

`LOOKUP_TABLES` should remain a separate construct.

`LOOKUP_TABLES` answers:

"What reference datasets should the runtime use to validate, normalize, and suggest canonical values?"

Lookup tables are not the same thing as entities.

An entity describes meaning:

- what kind of thing this is
- how it is normalized
- how it relates to other concepts

A lookup table describes an allowed or known set:

- valid values
- canonical spellings
- optional fuzzy matching
- external or tenant-specific sources of truth

Examples:

- `currency_code` is an entity.
- `iso_currency_codes` is a lookup table.
- `airport_code` is an entity.
- `iata_codes` is a lookup table.

`LOOKUP_TABLES` should be consumable by:

- `ENTITIES` for canonical value resolution
- `GATHER` for field validation and suggestion
- tools and expressions where reference validation matters

In other words, lookup is infrastructure for semantic and collection layers, not a substitute for either one.

## 7. Why `NLU` and `GATHER` Should Remain Separate

The strongest reason is that they represent different levels of commitment **and different scopes**.

An entity extraction (via `NLU` or direct entity recognition) means:

- the system believes it recognized something
- the belief has some confidence
- it is **utterance-scoped** — exists for this turn only
- it may be useful for routing, interpretation, clarification, or tool hints
- it does **not** persist unless a GATHER field commits it

A `GATHER` field means:

- the agent has a named place for this value in its state model
- the value is **session-scoped** — persists once committed
- the system may ask for it if missing
- the system may validate it (intrinsic + business rules)
- the system may protect it as sensitive data
- the system may use it in constraints, completion, tools, and memory

These are not the same statement.

If we merge them fully, we lose the ability to cleanly model:

- values recognized but never stored (utterance-scoped observations)
- values stored only after confirmation
- business fields that are not pure entities
- ephemeral observations versus durable commitments
- multiple extracted values of the same type that need disambiguation before commitment

The right simplification is not to merge the abstractions. The right simplification is to share the semantic substrate beneath them — a unified entity type system that both NLU and GATHER consume.

## 8. Why `ENTITIES` and `VOCABULARY` Should Be Separate

This distinction matters because not every domain term is a structured extractable value.

An entity is usually:

- typed
- normalized
- extractable as a value
- useful as a slot candidate

A vocabulary item is usually:

- lexical
- domain-specific
- useful for grounding, classification, retrieval, or explanation
- not necessarily something that becomes a field value

Examples:

- `USD` is an entity value.
- `SWIFT` is primarily vocabulary.
- `chargeback_reason` may be an entity.
- `chargeback` as a domain term is vocabulary.

Some concepts may participate in both layers, but the layers still serve different needs.

## 9. End-to-End Lifecycle

The runtime should model a value through explicit phases:

1. Observe (utterance-scoped)
2. Normalize (utterance-scoped)
3. Validate — intrinsic (utterance-scoped)
4. Slot Assignment (bridges utterance → session scope)
5. Validate — business (session-scoped)
6. Accept
7. Confirm
8. Commit (session-scoped)
9. Remember (persistent)

### 9.1 Observe

The system detects candidate intents, categories, and entities from the user input. Entity extraction runs on **every turn** for **all defined entities**, regardless of whether GATHER fields exist.

Entities are utterance-scoped — they exist as observations for this turn only. Multiple values of the same entity type may be extracted from a single utterance.

Output example:

```json
{
  "observed": {
    "intent": { "name": "book_flight", "confidence": 0.95 },
    "entities": {
      "airport_code": [
        { "value": "JFK", "confidence": 0.96, "span": "from JFK" },
        { "value": "LAX", "confidence": 0.94, "span": "to LAX" }
      ],
      "travel_date": [{ "value": "2026-03-15", "confidence": 0.91, "span": "on March 15th" }],
      "cabin_class": [{ "value": "business", "confidence": 0.89, "span": "business class" }]
    }
  }
}
```

### 9.2 Normalize

The system maps synonyms and surface forms into canonical values using entity definitions.

Examples:

- `"bucks"` -> `USD` (synonym resolution)
- `"next Tuesday"` -> `2026-04-14` (date parsing)
- `"biz class"` -> `business` (synonym resolution)
- `"wire fee"` -> normalized phrase under a fee inquiry intent family

### 9.3 Validate — Intrinsic

Entity-level validation runs against the intrinsic rules defined on the entity itself. This is the first validation gate and operates at the entity layer, not the collection layer.

Examples:

- `email` entity validates RFC-compliant format
- `phone` entity validates digit count and country code format
- `enum` entity validates value is in the allowed set
- `date` entity validates the value resolves to a real calendar date
- `pattern` entity validates against the defined regex

Values that fail intrinsic validation are rejected at this stage and do not proceed to slot assignment. Failed validations are emitted as trace events.

### 9.4 Slot Assignment

**Decision: LLM contextual disambiguation for multi-value, multi-slot cases.**

This phase bridges utterance-scoped observations into session-scoped GATHER fields. It only runs when GATHER fields exist.

The slot assignment phase handles three cases:

**Case A: Multiple values, multiple GATHER fields of the same entity type**

The runtime uses LLM contextual disambiguation. It sends the original utterance, extracted values, and GATHER field names/prompts to the LLM, which assigns values to the correct slots.

Example: User says "I want to fly from JFK to LAX."

- Extracted: `airport_code: [JFK, LAX]`
- GATHER fields: `origin` (entity_ref: airport_code), `destination` (entity_ref: airport_code)
- LLM assignment prompt: Given utterance "fly from JFK to LAX", assign airport codes to fields: origin ("Where are you flying from?") and destination ("Where are you flying to?")
- Result: `origin = JFK`, `destination = LAX`

**Case B: Multiple values, one GATHER field**

The runtime always asks for clarification. It presents the candidate values and asks the user to choose.

Example: User says "I'm interested in JFK or LAX."

- Extracted: `airport_code: [JFK, LAX]`
- GATHER field: `airport` (entity_ref: airport_code)
- Runtime response: "I found JFK and LAX. Which airport did you mean?"

**Case C: One value, one or more GATHER fields**

Direct assignment. No disambiguation needed.

**Case D: No GATHER fields defined**

Observations remain in the utterance-scoped observation layer. They are available for routing, WHEN conditions, HANDOFF/DELEGATE context, and tracing. They do not persist to session state.

### 9.5 Validate — Business

After slot assignment, GATHER-level business validation runs. This is separate from intrinsic validation and applies business-specific rules defined on the GATHER field.

Examples:

- `payout_currency` may additionally validate against a tenant allowlist
- `travel_date` may validate that the date is in the future and within 1 year
- `destination` may validate that it differs from `origin`

Business validation may use different validation processes: regex (VALIDATION_PROCESS: REGEX), LLM (VALIDATION_PROCESS: LLM), or code (VALIDATION_PROCESS: CODE).

### 9.6 Accept

The system decides whether the normalized, validated value is good enough to use provisionally.

Accepted values may still be uncommitted (pending confirmation).

### 9.7 Confirm

If slot policy requires it (`CONFIRM: true`), the system confirms the value with the user before committing.

### 9.8 Commit

The value enters session state as a named gather field. This is the transition from utterance scope to session scope. Committed values persist for the duration of the conversation.

### 9.9 Remember

If memory rules apply, the value or a derived fact may be persisted beyond the current conversation into long-term memory.

## 10. Alignment with Existing Design

The current ABL and runtime design is more aligned with this proposal than it may first appear.

### 10.1 What already aligns well

The following parts already fit the proposed model with only naming or factoring changes:

- `GATHER` already owns collection policy: prompts, requiredness, defaults, sensitivity, validation, correction handling, and commitment into session state.
- `NLU` already owns interpretation policy: intents, examples, categories, glossary, and entity extraction behavior.
- `MEMORY` is already separate and policy-oriented: session memory, persistent memory, remember triggers, and recall instructions are modeled independently from collection.
- `LOOKUP_TABLES` is already separate and shared: the runtime treats lookup as reference data used for validation and normalization, not as an NLU-only feature.
- the runtime already distinguishes several phases of handling even if they are not yet formalized under one canonical lifecycle name.

### 10.2 What is mostly a naming or factoring issue

These parts need relatively small conceptual adjustment:

- `NLU.entities` should become or lower into canonical `ENTITIES`.
- `NLU.glossary` should become or lower into canonical `VOCABULARY`.
- gather fields should be able to reference shared entities explicitly rather than silently duplicating their semantics inline.
- lookup should be described consistently as shared reference data rather than as a gather-only convenience feature.

### 10.3 What needs deeper evolution

These parts are not just renames:

- the runtime should more explicitly distinguish observed values from accepted values and committed values
- entity hierarchy and vocabulary hierarchy need first-class representation
- gather-to-memory promotion rules should be easier to trace end-to-end
- shared semantic libraries should be versionable and reusable across agents and projects

### 10.4 Overall assessment

Conceptually, the current system is already close.

The biggest gap is not that the platform has the wrong abstractions. The biggest gap is that the abstractions are introduced in the wrong places:

- shared semantics are currently nested under `NLU`
- some reference-data behavior is taught under `GATHER`
- authors therefore see duplication where the platform is actually expressing adjacent concerns

In practice, this means the migration can be evolutionary:

- preserve the existing runtime behavior
- introduce `ENTITIES` and `VOCABULARY` as first-class constructs
- lower existing `NLU.entities` and `NLU.glossary` into them
- add `entity_ref` from `GATHER`
- keep `LOOKUP_TABLES` and `MEMORY` largely as they are

### 10.5 Minimal-change adoption path

If the goal is to improve clarity without substantially changing runtime behavior, the platform can get most of the benefit from a small set of moves:

- add top-level `ENTITIES` and `VOCABULARY`
- keep current `NLU`, `GATHER`, `MEMORY`, and `LOOKUP_TABLES` behavior intact
- lower `NLU.entities` and `NLU.glossary` into the canonical shared layers
- allow `GATHER` to reference shared entities explicitly
- formalize trace phases without forcing every author to learn a new authoring model on day one

That is why this proposal should be viewed as a clarification and consolidation of the current design much more than as a ground-up redesign.

## 11. Examples

### 11.1 Current-style example in today's ABL

This is valid and should keep working:

```abl
AGENT: Wire_Transfer_Agent

GOAL: "Help customers send domestic and international wires safely."

NLU:
  intents:
    - NAME: send_wire
      PATTERNS: ["wire transfer", "send money", "wire funds"]
      EXAMPLES:
        - "I need to wire $5,000 to Germany"
        - "Can I send money internationally?"

  entities:
    - NAME: currency_code
      TYPE: enum
      VALUES: [USD, EUR, GBP]
      SYNONYMS:
        USD: [usd, dollars, bucks]
        EUR: [eur, euros]

  glossary:
    - "SWIFT -- International bank identifier code"
    - "OFAC -- Sanctions screening authority"

GATHER:
  payout_currency:
    prompt: "Which currency should I use?"
    type: string
    required: true
  beneficiary_country:
    prompt: "Which country is the beneficiary bank in?"
    type: string
    required: true
```

This works, but it duplicates semantic intent:

- the system knows what `currency_code` means in `NLU`
- the gather field `payout_currency` re-describes the same semantic concept as a plain string

### 11.2 Proposed future canonical model

```abl
AGENT: Wire_Transfer_Agent

GOAL: "Help customers send domestic and international wires safely."

ENTITIES:
  currency_code:
    TYPE: enum
    VALUES: [USD, EUR, GBP]
    SYNONYMS:
      USD: [usd, dollars, bucks]
      EUR: [eur, euros]

  country:
    TYPE: location

VOCABULARY:
  - TERM: SWIFT
    ALIASES: [BIC, swift code]
    DEFINITION: "International bank identifier code"
    CATEGORY: payments

  - TERM: OFAC
    DEFINITION: "Sanctions screening authority"
    CATEGORY: compliance

NLU:
  intents:
    - NAME: send_wire
      PATTERNS: ["wire transfer", "send money", "wire funds"]
      EXAMPLES:
        - "I need to wire $5,000 to Germany"
        - "Can I send money internationally?"
      ENTITIES: [currency_code, country]

GATHER:
  payout_currency:
    entity_ref: currency_code
    prompt: "Which currency should I use?"
    required: true
    confirm: true

  beneficiary_country:
    entity_ref: country
    prompt: "Which country is the beneficiary bank in?"
    required: true
```

This makes the construct boundaries much clearer:

- `ENTITIES` defines reusable semantics
- `VOCABULARY` defines domain language
- `NLU` defines interpretation behavior
- `GATHER` defines collection policy

### 11.3 Example where observation and commitment differ

User says:

> "I need to wire fifty thousand to Germany, maybe euros, actually make it dollars."

`NLU` may observe:

- intent: `send_wire`
- amount: `50000`
- country: `Germany`
- currency candidates: `EUR`, then correction to `USD`

But `GATHER` may commit only:

- `beneficiary_country = Germany`
- `payout_currency = USD`

and may decide to ask for:

- source account
- beneficiary name
- purpose of payment

The difference is important. Recognition is broader than the collection contract.

### 11.4 Example where vocabulary matters but no entity is stored

```abl
VOCABULARY:
  - TERM: chargeback
    ALIASES: [card dispute, dispute charge]
    DEFINITION: "A cardholder dispute that reverses a card transaction"
    CATEGORY: disputes

NLU:
  intents:
    - NAME: dispute_charge
      PATTERNS: ["chargeback", "dispute", "card dispute"]
```

This improves interpretation and explanation without forcing a gather field called `chargeback`.

### 11.5 Example of local gather field without shared entity

```abl
GATHER:
  proceed_confirmation:
    prompt: "Do you want me to submit this transfer now?"
    type: boolean
    required: true
```

This should remain valid without an `entity_ref`. Not every gather field deserves a reusable entity definition.

### 11.6 Example of future entity hierarchy

```abl
ENTITIES:
  location:
    TYPE: concept

  country:
    TYPE: location
    PARENT: location

  city:
    TYPE: location
    PARENT: location

  airport_code:
    TYPE: enum
    PARENT: location
    VALUES: [JFK, LHR, SFO]
```

This would let both `NLU` and `GATHER` reason over more structured semantic families without changing their responsibilities.

### 11.7 Example of inline GATHER type as syntactic sugar

The following two forms are semantically equivalent. The compiler produces the same IR for both.

**Inline form (syntactic sugar — backward compatible):**

```abl
GATHER:
  departure_date:
    TYPE: date
    PROMPT: "When do you want to fly?"
    REQUIRED: true
    VALIDATE: "must be in the future"
    VALIDATION_PROCESS: LLM
```

**Explicit form (canonical):**

```abl
ENTITIES:
  departure_date:
    TYPE: date

GATHER:
  departure_date:
    ENTITY_REF: departure_date
    PROMPT: "When do you want to fly?"
    REQUIRED: true
    VALIDATE: "must be in the future"
    VALIDATION_PROCESS: LLM
```

In the inline form, the compiler decouples at compile time:

1. Creates an anonymous entity `departure_date` with TYPE: date and built-in date validation → entity registry
2. Creates a GATHER field referencing that entity with collection policy → gather IR

### 11.8 Example of multi-value disambiguation (Case A — LLM)

```abl
ENTITIES:
  airport_code:
    TYPE: enum
    VALUES: [JFK, LAX, LHR, SFO, ORD]

GATHER:
  origin:
    ENTITY_REF: airport_code
    PROMPT: "Where are you flying from?"
    REQUIRED: true
  destination:
    ENTITY_REF: airport_code
    PROMPT: "Where are you flying to?"
    REQUIRED: true
```

User says: "I want to fly from JFK to LAX."

Runtime extraction: `airport_code: [JFK, LAX]`

Slot assignment sends to LLM:

```
Given the user message: "I want to fly from JFK to LAX"
Extracted airport_code values: JFK, LAX

Assign each value to one of these fields:
- origin: "Where are you flying from?"
- destination: "Where are you flying to?"
```

LLM responds: `{ "origin": "JFK", "destination": "LAX" }`

Both values are committed to session state.

### 11.9 Example of multi-value clarification (Case B — single slot)

```abl
ENTITIES:
  airport_code:
    TYPE: enum
    VALUES: [JFK, LAX, LHR, SFO, ORD]

GATHER:
  preferred_airport:
    ENTITY_REF: airport_code
    PROMPT: "Which airport do you prefer?"
    REQUIRED: true
```

User says: "I usually fly from JFK or LAX."

Runtime extraction: `airport_code: [JFK, LAX]`

One GATHER field, two values. Runtime asks for clarification:

> "I found JFK and LAX. Which airport do you prefer?"

User responds: "JFK"

`preferred_airport = JFK` is committed to session state.

### 11.10 Example of entity_ref exclusivity (compile error)

```abl
ENTITIES:
  cabin_class:
    TYPE: enum
    VALUES: [economy, business, first]

GATHER:
  cabin:
    ENTITY_REF: cabin_class
    TYPE: string              # COMPILE ERROR: cannot redefine TYPE with ENTITY_REF
    VALUES: [economy, first]  # COMPILE ERROR: cannot redefine VALUES with ENTITY_REF
    PROMPT: "What cabin?"     # OK: collection policy
    REQUIRED: true            # OK: collection policy
```

The compiler emits: `GATHER field "cabin" uses ENTITY_REF but also redefines entity property "TYPE". Remove TYPE or remove ENTITY_REF.`

### 11.11 Unified entity type system

Current GATHER types and NLU entity types converge into one system:

| Unified Entity Type  | Built-in Recognition   | Built-in Intrinsic Validation      | Notes                                       |
| -------------------- | ---------------------- | ---------------------------------- | ------------------------------------------- |
| `string`             | LLM extraction         | None (accepts any text)            | Generic text                                |
| `text` / `free_text` | LLM extraction         | None                               | Long-form text                              |
| `number`             | Regex + LLM            | Parseable as numeric               |                                             |
| `integer`            | Regex + LLM            | Parseable as integer, no decimals  | Subtype of number                           |
| `float`              | Regex + LLM            | Parseable as float                 | Subtype of number                           |
| `currency`           | Regex + LLM            | Valid numeric with optional symbol | Subtype of number                           |
| `boolean`            | Keyword match          | Resolves to true/false             | Named entity: values [true, false, yes, no] |
| `date`               | LLM date parsing       | Resolves to real calendar date     |                                             |
| `datetime`           | LLM date parsing       | Resolves to real date + time       |                                             |
| `email`              | Regex pattern          | RFC-compliant format               | Named entity with built-in pattern          |
| `phone`              | Regex pattern          | Digit count + country code format  | Named entity with built-in pattern          |
| `enum`               | Exact match + synonyms | Value is in allowed set            |                                             |
| `pattern`            | Regex match            | Matches defined regex              | Custom pattern entity                       |
| `location`           | LLM extraction         | Recognized geographic reference    |                                             |

GATHER fields using inline `TYPE: email` are syntactic sugar for referencing the built-in `email` entity.

## 12. Implementation Strategy

### 12.1 Language changes

Add:

- `ENTITIES:` as a top-level construct
- `VOCABULARY:` as a top-level construct
- `entity_ref` on gather fields

Keep:

- `NLU.entities` as a backward-compatible legacy form
- `NLU.glossary` as a backward-compatible legacy form

Preferred future authoring model:

- reusable semantics in `ENTITIES`
- reusable terminology in `VOCABULARY`
- interpretation behavior in `NLU`
- collection policy in `GATHER`

### 12.2 IR changes

Introduce canonical IR nodes for:

- `EntityDefinitionIR` — top-level, peer to `NLUIRConfig` and `GatherConfig`
- `VocabularyTermIR` — top-level

The IR agent structure should change from:

```typescript
// Current: entities nested under nlu
interface AgentIR {
  nlu?: NLUIRConfig; // contains entities[], intents[], glossary[]
  gather?: GatherConfig;
}

// Proposed: entities as top-level peer
interface AgentIR {
  entities?: EntityDefinitionIR[]; // canonical entity registry
  vocabulary?: VocabularyTermIR[]; // canonical vocabulary registry
  nlu?: NLUIRConfig; // intents, categories, interpretation config
  gather?: GatherConfig; // collection policy, references entities
}
```

Then lower:

- `ENTITIES` -> `ir.entities` (canonical entity registry)
- `NLU.entities` -> `ir.entities` (same registry, backward compatible)
- `NLU.glossary` -> `ir.vocabulary` (same registry)
- inline GATHER field `TYPE` -> synthetic anonymous entity in `ir.entities` + entity reference on GATHER field
- GATHER `ENTITY_REF` -> resolved reference to named entity in `ir.entities`

This lets compiler and runtime share one semantic model even before the DSL fully converges.

### 12.3 Compiler lowering rules

Recommended lowering rules:

1. If `ENTITIES` exists, compile it into the canonical entity registry (`ir.entities`).
2. If `NLU.entities` exists, lower those entries into the same registry.
3. If both define the same entity name, emit a compile-time conflict error unless they are byte-for-byte identical.
4. If `VOCABULARY` exists, compile it into the canonical vocabulary registry (`ir.vocabulary`).
5. If `NLU.glossary` exists, lower it into the same registry as unstructured vocabulary terms.
6. If a `GATHER` field has `ENTITY_REF`:
   a. Resolve the reference against the canonical entity registry. Emit compile error if not found.
   b. If the field also defines entity-level properties (TYPE, VALUES, SYNONYMS, PATTERN), emit compile error.
   c. Merge entity semantics (type, values, synonyms, intrinsic validation) with field-local collection policy (prompt, required, business validation).
7. If a `GATHER` field has no `ENTITY_REF` but has `TYPE`:
   a. Create a synthetic anonymous entity definition from the inline properties.
   b. Store it in the canonical entity registry.
   c. Create an implicit entity reference on the GATHER field.
8. System entity types (`email`, `phone`, `date`, `datetime`, `boolean`, `currency`) should have built-in entity definitions with intrinsic validation pre-registered in the entity registry. Inline `TYPE: email` resolves to the built-in email entity.

### 12.4 Runtime phases

Move the runtime toward a single shared extraction pipeline with explicit phases.

The runtime pipeline per turn:

1. **Extract** — Run entity extraction on the user utterance for all entities in `ir.entities`. Produce observations (utterance-scoped, multi-value per entity type).
2. **Normalize** — Apply synonym resolution and canonical mapping from entity definitions.
3. **Validate (intrinsic)** — Run entity-level validation. Reject values that fail intrinsic rules.
4. **Slot Assignment** — If GATHER fields exist, map observations to GATHER slots:
   - Multiple values + multiple slots of same entity type → LLM contextual disambiguation
   - Multiple values + one slot → ask user for clarification
   - One value + one or more slots → direct assignment
5. **Validate (business)** — Run GATHER-level business validation on assigned values.
6. **Accept** — Provisionally accept values that pass all validation.
7. **Confirm** — If GATHER field has `CONFIRM: true`, confirm with user.
8. **Commit** — Write accepted/confirmed values to session state.
9. **Remember** — If memory rules apply, persist to long-term memory.

Without GATHER, the pipeline stops after step 3. Observations are available for routing, conditions, and tracing but do not persist.

### 12.5 Session state model

The session model should distinguish three scopes:

- `observations`: utterance-scoped candidate interpretations (ephemeral, replaced each turn)
- `values`: session-scoped committed conversational state (persists until conversation ends)
- `memory`: persistent facts (survives across conversations)

```typescript
interface SessionState {
  // Utterance-scoped: replaced every turn
  observations: {
    intent: { name: string; confidence: number } | null;
    entities: Record<
      string,
      Array<{
        value: string;
        confidence: number;
        span?: string;
      }>
    >;
  };

  // Session-scoped: committed GATHER values
  values: Record<string, unknown>;

  // Persistent: MEMORY-promoted facts
  memory: Record<string, unknown>;
}
```

This gives clearer debugging and better safety semantics than a single flat bag of values.

### 12.6 Trace model

Tracing should emit separate events for each lifecycle phase:

- observation (entity extracted from utterance)
- normalization (synonym/surface form resolved)
- validation_intrinsic (entity-level validation pass/fail)
- slot_assignment (value mapped to GATHER field, including disambiguation method)
- slot_clarification (multiple values, user asked to choose)
- validation_business (GATHER-level business validation pass/fail)
- acceptance (value provisionally accepted)
- confirmation (user confirmed value)
- commitment (value written to session state)
- memory_write (value promoted to persistent memory)

That allows analytics and debugging questions such as:

- what did the classifier detect?
- what was rejected and why?
- how was a multi-value ambiguity resolved? (LLM disambiguation vs user clarification)
- what was committed into state?
- what changed because of a correction?
- which values were observed but never committed? (no GATHER field)

### 12.7 Studio authoring

Studio should support:

- shared entity library editor with unified type system
- shared vocabulary editor
- `GATHER` field picker with optional `entity_ref` — when entity_ref is selected, hide entity-level properties (TYPE, VALUES, etc.) and show only collection-policy fields
- inline warning when a gather field duplicates an existing shared entity (suggest entity_ref)
- compile error preview when entity_ref and TYPE are both set
- migration suggestions from `NLU.entities` and `NLU.glossary`
- visualization of the observation → commitment pipeline per GATHER field

This is where the design will either feel clear or remain confusing. The UI should teach the mental model directly:

- entities are reusable semantic types
- vocabulary is domain language
- gather fields are agent-owned slots

## 13. Alternatives Considered

### 13.1 Fully merge `NLU` and `GATHER`

Rejected.

Why:

- collapses observation and commitment into one concept
- makes routing and state management harder to reason about
- encourages accidental storage of values that should remain provisional
- makes tracing less precise
- fails to model non-slot interpretation cleanly

### 13.2 Define all entities inside `NLU` and always reference them from `GATHER`

Partially attractive, but not preferred.

Benefits:

- reduces duplication
- gives one place for shared entity definitions
- makes gather/entity linkage explicit

Why not make it the final model:

- it makes a general semantic concept live under a specific interpretation construct
- not all reusable semantics are only for `NLU`
- tools, search, analytics, and memory may also want the same semantic library
- some agents may want shared entities without elaborate `NLU` configuration

This is why `ENTITIES` should be a peer of `NLU`, not nested inside it.

### 13.3 Require every `GATHER` field to reference an entity

Rejected.

Why:

- too rigid for local one-off fields
- many gather fields are business slots or confirmations, not reusable semantic types
- increases authoring ceremony for small agents

Recommended instead:

- make `entity_ref` preferred when semantics are reusable
- keep inline fields valid for local and composite slots

### 13.4 Keep the current model unchanged

Rejected.

Why:

- duplicates semantics
- keeps construct boundaries muddy
- makes future hierarchy and reuse harder
- makes docs harder to teach

## 14. Future Considerations

### 14.1 Custom entity packages

Teams should eventually be able to publish reusable entity libraries by domain:

- payments
- healthcare
- travel
- insurance

### 14.2 Entity hierarchies and ontologies

The semantic layer should support:

- parent-child relationships
- aliases by locale
- concept families
- composite entities
- reusable subtype validation

### 14.3 Intent hierarchies

`NLU` should eventually support:

- parent intents
- sub-intents
- intent families
- disambiguation policies

This belongs in interpretation, not collection.

### 14.4 Composite and derived gather slots

Future `GATHER` should support slots derived from multiple entities:

- `travel_dates`
- `address`
- `amount_range`
- `customer_preferences`

These should remain collection-layer constructs even when powered by shared entities.

### 14.5 Multilingual vocabulary and entity resolution

`VOCABULARY` and `ENTITIES` should eventually support:

- locale-specific aliases
- region-specific canonicalization
- multilingual definitions
- transliteration behavior

### 14.6 Search and RAG integration

`VOCABULARY` should be consumable by retrieval and query-rewriting systems. Domain terms often matter more for search quality than for slot extraction.

### 14.7 Lookup-backed semantics

Future `ENTITIES` should be able to reference lookup tables directly.

Examples:

- `currency_code` -> `lookup: iso_currency_codes`
- `airport_code` -> `lookup: iata_codes`
- `product_sku` -> `lookup: tenant_product_catalog`

This keeps semantic definitions reusable while allowing the source of truth for values to remain dynamic, tenant-specific, or externally managed.

### 14.8 Policy-aware entity handling

Some entities will require:

- PII classification
- storage restrictions
- masking defaults
- tenant-specific allowlists
- compliance review

That should be modeled once in the semantic layer and then tightened locally in `GATHER`.

### 14.9 Versioning and migration

Shared semantic libraries will need:

- versioning
- deprecation rules
- migration tooling
- conflict detection

### 14.10 Analytics

Separating observation from commitment enables better metrics:

- extraction accuracy
- acceptance rate
- confirmation rate
- correction rate
- state completion rate
- memory retention quality

## 15. Recommended Direction

The recommended direction is:

1. Keep `NLU` and `GATHER` separate.
2. Add `ENTITIES` as the canonical shared semantic layer.
3. Add `VOCABULARY` as the canonical domain language layer.
4. Make `NLU` consume both for interpretation.
5. Make `GATHER` consume `ENTITIES` for slot policy and commitment.
6. Preserve inline gather fields for local and composite cases.
7. Move the runtime and trace model toward explicit observation -> acceptance -> commitment phases.

This gives ABL a cleaner mental model, a better growth path, and a stronger foundation for future features like custom entities, hierarchies, multilingual semantics, and reusable libraries.

## 16. Migration Plan

This proposal should be implemented as an additive migration, not a breaking redesign.

The practical goal is:

- improve the authoring model
- reduce duplicated semantic definitions
- preserve current runtime behavior wherever possible
- make room for deeper semantic features later

### 16.1 Phase 1: clarify the model in docs and Studio

The first phase is primarily conceptual and authoring-facing.

Add to the language model and documentation:

- top-level `ENTITIES`
- top-level `VOCABULARY`
- explicit explanation that `MEMORY` is retention policy, not semantic definition
- explicit explanation that `LOOKUP_TABLES` is shared reference data, not a second entity system

In Studio and docs, teach the constructs as:

- `ENTITIES` = reusable semantic types
- `VOCABULARY` = domain language and aliases
- `NLU` = interpretation behavior
- `GATHER` = collection and commitment
- `MEMORY` = retention and recall
- `LOOKUP_TABLES` = source-of-truth reference sets

This phase should not require breaking compiler or runtime changes.

### 16.2 Phase 2: add canonical shared semantic constructs

The second phase adds the new authoring surface while preserving compatibility.

Add:

- top-level `ENTITIES`
- top-level `VOCABULARY`
- `entity_ref` on `GATHER` fields

Keep working without change:

- `NLU.entities`
- `NLU.glossary`
- inline gather field definitions with no shared entity
- existing `MEMORY` syntax
- existing `LOOKUP_TABLES` syntax

Compiler behavior in this phase:

- lower `ENTITIES` into a canonical entity registry
- lower `VOCABULARY` into a canonical vocabulary registry
- lower legacy `NLU.entities` into the same entity registry
- lower legacy `NLU.glossary` into the same vocabulary registry
- resolve `entity_ref` from `GATHER` into merged semantic plus field-policy definitions

This phase creates the new mental model without forcing existing agents to migrate.

### 16.3 Phase 3: make reuse visible and encourage migration

Once the new constructs exist, the next step is to guide authors toward them.

Add non-breaking quality-of-life features:

- lints when a gather field duplicates a shared entity definition
- migration suggestions from `NLU.entities` to `ENTITIES`
- migration suggestions from `NLU.glossary` to `VOCABULARY`
- Studio affordances for choosing an `entity_ref` from a shared library

This is the point where the platform starts nudging authors toward the canonical structure while keeping old files valid.

### 16.4 Phase 4: tighten runtime lifecycle semantics

The runtime already behaves in a layered way, but the phases should become more explicit in tracing and state.

Add clearer runtime distinctions between:

- observed values
- accepted values
- committed values
- remembered values

This phase should improve:

- tracing
- debugging
- analytics
- safety review

It may require moderate runtime and IR changes, but it should still preserve authoring compatibility.

### 16.5 Phase 5: deeper semantic capabilities

Only after the canonical layers are in place should the platform add richer semantic features such as:

- entity hierarchy
- vocabulary hierarchy
- lookup-backed entities
- reusable semantic packages
- policy-aware semantic metadata
- richer gather roles over shared entity types

These are meaningful design extensions, but they should not block the earlier cleanup.

### 16.6 What changes now vs later

Changes that should happen now:

- add `ENTITIES`
- add `VOCABULARY`
- add `entity_ref`
- clarify the role of `MEMORY`
- clarify the role of `LOOKUP_TABLES`
- update docs, examples, and Studio language

Changes that should remain backward-compatible for a long time:

- `NLU.entities`
- `NLU.glossary`
- inline gather semantics
- current `MEMORY` structure
- current `LOOKUP_TABLES` structure

Changes that can wait:

- strict deprecation of legacy semantic definitions
- hierarchy support
- semantic package versioning
- deeper runtime state-model separation
- cross-construct semantic reuse in tools and analytics

### 16.7 Redesign scope summary

The amount of ABL that truly needs redesign is limited.

What needs real redesign:

- the semantic-definition surface
- the explanation of `NLU` vs `GATHER`
- the explanation of `MEMORY` vs committed state
- the explanation of `LOOKUP_TABLES` vs semantic types
- the execution lifecycle language in docs and traces

What mostly needs renaming, refactoring, or clearer factoring:

- where entity definitions live
- where glossary/vocabulary definitions live
- how gather fields reference shared semantics

What can remain substantially unchanged:

- agent identity and persona constructs
- tool definitions
- constraints and guardrails
- delegation, handoff, escalation, completion, and error handling
- most of `FLOW`
- attachments, templates, and interaction constructs

In short: this is a focused redesign of the semantic and state-model layer of ABL, not a rewrite of the whole language.

## 17. Resolved Decisions

The following open questions from the original draft have been resolved during design review:

| Question                                                                        | Decision                               | Rationale                                                                                                |
| ------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| How should multi-value same-type entities be assigned to GATHER slots?          | LLM contextual disambiguation (Case A) | LLM can use utterance context ("from X to Y") to infer roles without explicit ROLE declarations          |
| How should multi-value same-type entities be handled with a single GATHER slot? | Always ask for clarification (Case B)  | Deterministic behavior; user always chooses                                                              |
| Should extraction method live on entity or GATHER?                              | Entity                                 | Entity defines "how to recognize this kind of thing"; GATHER only defines "what to do after recognition" |
| Should validation live on entity or GATHER?                                     | Both — split by concern                | Intrinsic validation (format) on entity; business validation (rules) on GATHER                           |
| Should GATHER inline types still work?                                          | Yes — syntactic sugar                  | Compiler decouples at compile time; backward compatible                                                  |
| Can ENTITY_REF coexist with TYPE on a GATHER field?                             | No — compile error                     | Prevents conflicting definitions; entity_ref inherits all entity properties                              |

## 18. Open Questions

- Should `VOCABULARY` remain simple and glossary-like at first, or should it launch with aliases and categories immediately?
- Should `ENTITIES` allow composite/object entities from day one, or start with scalar and list/range semantics only?
- Should `entity_ref` be allowed on tool parameters as a future extension?
- How much of the observation lifecycle should be addressable from DSL versus exposed only through tracing and analytics?
- Should `GATHER` support an optional `ROLE` hint to improve LLM disambiguation for same-entity-type slots, or is the prompt text sufficient context?
- Should `LOOKUP_TABLES` remain a standalone top-level block, or should future entity libraries be able to package lookup-backed canonical value sets directly?
- What is the LLM prompt template for slot disambiguation? Should it be configurable per agent or use a platform default?
- How should the clarification UX work — should the runtime generate the clarification message automatically, or should the GATHER field support an `ON_MULTIPLE` prompt template?
- Should system entity types (email, phone, date, etc.) be pre-registered in every agent's entity registry, or only materialized when referenced by a GATHER field?

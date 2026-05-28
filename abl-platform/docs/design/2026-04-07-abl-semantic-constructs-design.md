# ABL Semantic Constructs Design

> Status: Draft
> Date: 2026-04-07
> Scope: semantic definitions, vocabulary, interpretation, collection, control, enforcement, memory, and tracing

## 1. Decision Summary

ABL should keep `NLU` and `GATHER` as separate constructs, but stop making them carry duplicate semantic definitions.

The recommended model is:

- `ENTITIES` defines reusable semantic types and normalization rules.
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
- synonyms
- normalization rules
- patterns
- canonical value definitions
- hierarchy metadata
- locale behavior
- optional validation that is intrinsic to the concept

An entity does not own:

- whether the agent should ask for it
- whether it is required in this conversation
- how it should be phrased to the user
- whether it should be persisted in memory
- whether it should be confirmed before use

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

The initial canonical model should not require or encourage intent-level links to entities such as `ENTITIES: [currency_code, country]` inside an intent definition. Shared entities are already available globally to `NLU`, and intent-scoped entity associations should be added only if the runtime gains a concrete need for them.

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
- field-level validation
- field-level display and masking rules

`GATHER` should preferably reference `ENTITIES`, but it must remain able to define local one-off fields.

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

The strongest reason is that they represent different levels of commitment.

An `NLU` entity means:

- the system believes it recognized something
- the belief has some confidence
- it may be useful for routing, interpretation, clarification, or tool hints

A `GATHER` field means:

- the agent has a named place for this value in its state model
- the system may ask for it
- the system may validate it
- the system may protect it as sensitive data
- the system may use it in constraints, completion, tools, and memory

These are not the same statement.

If we merge them fully, we lose the ability to cleanly model:

- values recognized but never stored
- values stored only after confirmation
- business fields that are not pure entities
- ephemeral observations versus durable commitments

The right simplification is not to merge the abstractions. The right simplification is to share the semantic substrate beneath them.

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

1. Observe
2. Normalize
3. Validate
4. Accept
5. Confirm
6. Commit
7. Remember

### 9.1 Observe

The system detects candidate intents, categories, and entities from the user input.

Output example:

```json
{
  "observed": {
    "intent": { "name": "send_wire", "confidence": 0.93 },
    "entities": {
      "currency_code": { "value": "USD", "confidence": 0.91 },
      "destination_country": { "value": "Germany", "confidence": 0.88 }
    }
  }
}
```

### 9.2 Normalize

The system maps synonyms and surface forms into canonical values.

Examples:

- `"bucks"` -> `USD`
- `"next Tuesday"` -> `2026-04-14`
- `"wire fee"` -> normalized phrase under a fee inquiry intent family

### 9.3 Validate

Validation happens at two levels:

- entity-level validation intrinsic to the concept
- field-level validation intrinsic to the business use

For example:

- `currency_code` may validate against a closed enum
- `payout_currency` may additionally validate against a tenant allowlist

### 9.4 Accept

The system decides whether the normalized value is good enough to use provisionally.

Accepted values may still be uncommitted.

### 9.5 Confirm

If slot policy requires it, the system confirms the value with the user before storing or acting on it.

### 9.6 Commit

The value enters conversational state as a named gather field.

### 9.7 Remember

If memory rules apply, the value or a derived fact may be persisted beyond the current conversation.

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

It also keeps the canonical model deliberately lean. Intent-level entity links are omitted here on purpose because they do not currently provide enough runtime value to justify extra syntax.

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

- `EntityDefinitionIR`
- `VocabularyTermIR`

Then lower:

- `NLU.entities` -> canonical entity registry
- `NLU.glossary` -> canonical vocabulary registry
- inline gather field semantics -> either direct field metadata or synthetic local entities

This lets compiler and runtime share one semantic model even before the DSL fully converges.

### 12.3 Compiler lowering rules

Recommended lowering rules:

1. If `ENTITIES` exists, compile it into the canonical entity registry.
2. If `NLU.entities` exists, lower those entries into the same registry.
3. If both define the same entity name, emit a compile-time conflict error unless they are byte-for-byte identical.
4. If `VOCABULARY` exists, compile it into the canonical vocabulary registry.
5. If `NLU.glossary` exists, lower it into the same registry as unstructured vocabulary terms.
6. If a `GATHER` field has `entity_ref`, merge the referenced entity semantics with field-local policy.
7. If a `GATHER` field has no `entity_ref`, compile it as a local anonymous semantic definition plus field policy.

### 12.4 Runtime phases

Move the runtime toward a single shared extraction pipeline with multiple consumers.

The runtime should produce:

- observations
- accepted values
- committed state

`NLU` should read and emit observations.

`GATHER` should decide whether an observed value becomes accepted and committed based on:

- field activation
- confirmation policy
- correction policy
- validation
- sensitivity rules

### 12.5 Session state model

The session model should distinguish:

- `observations`: ephemeral candidate interpretations
- `values`: committed conversational state
- `memory`: persisted or summarized facts

This gives clearer debugging and better safety semantics than a single flat bag of values.

### 12.6 Trace model

Tracing should emit separate events for:

- observation
- normalization
- validation
- acceptance
- confirmation
- commitment
- memory write

That allows analytics and debugging questions such as:

- what did the classifier detect?
- what was rejected and why?
- what was committed into state?
- what changed because of a correction?

### 12.7 Studio authoring

Studio should support:

- shared entity library editor
- shared vocabulary editor
- `GATHER` field picker with optional `entity_ref`
- inline warning when a gather field duplicates an existing shared entity
- migration suggestions from `NLU.entities` and `NLU.glossary`

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
- optional intent-scoped entity hints, if future runtime behavior proves they are useful

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

## 17. Open Questions

- Should `VOCABULARY` remain simple and glossary-like at first, or should it launch with aliases and categories immediately?
- Should `ENTITIES` allow composite/object entities from day one, or start with scalar and list/range semantics only?
- Should `entity_ref` be allowed on tool parameters as a future extension?
- How much of the observation lifecycle should be addressable from DSL versus exposed only through tracing and analytics?
- Should `GATHER` support field roles such as `ROLE: destination` over a shared entity type like `location`?
- Should `LOOKUP_TABLES` remain a standalone top-level block, or should future entity libraries be able to package lookup-backed canonical value sets directly?

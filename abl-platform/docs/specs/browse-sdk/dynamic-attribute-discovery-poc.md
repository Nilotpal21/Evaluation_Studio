# Dynamic Attribute Discovery — Three POC Approaches

**Date:** 2026-03-17
**Status:** Design / POC evaluation
**Problem Owner:** Browse SDK — the crux of faceted navigation

---

## The Core Problem

For the Browse SDK to work, users need to navigate documents through dynamic
attributes that come from **content**, not from a pre-defined schema. The banking
domain definition has ~30 attributes (`interest_rate`, `credit_limit`, `emi`,
`rewards_program`, `bluetooth`, `scanner`...), but:

1. **How are these attributes GENERATED?** They come from document content
   dynamically — not from a fixed schema
2. **How do we find RELATIONSHIPS between attributes?** "bluetooth" and "wifi"
   are both connectivity features; "APR" and "interest rate" are the same thing
3. **How do we stay CONSISTENT?** The same concept extracted from 1000 documents
   must resolve to ONE canonical attribute, not 50 variations

### Current State (What Exists)

```
Domain Definition (banking.md)  ──→  Pre-defined attributes
  30 attributes: interest_rate,       with regex patterns,
  credit_limit, emi, etc.             LLM hints, applicableTo
         │
         ▼
Org Profile (customer.md)  ──→  Customer-specific context
  Product aliases, typical              "APR = Annual Percentage Rate"
  ranges, disambiguation                "credit limit: $5k-$50k"
         │
         ▼
TaxonomyLoaderService.mergeTaxonomy()
         │
         ▼
IKnowledgeGraphTaxonomy (MongoDB)
         │
         ▼
EntityExtractorService.extractEntities(chunk, taxonomy, productType)
  ├── getApplicableAttributes()  ──→  Filter by applicableTo/notApplicableTo
  ├── extractWithRegex()         ──→  Fast, free, pattern-based
  └── extractWithLLM()           ──→  Fallback if regex finds nothing
         │
         ▼
Three stores:
  Neo4j:     EntityInstance nodes (queryable via Cypher)
  MongoDB:   SearchDocument.entityInstances[] + SearchChunk.metadata.entities[]
  OpenSearch: ❌ NOTHING — attributes never reach the search index
```

### Five Problems

| #   | Problem                      | Impact                                                       |
| --- | ---------------------------- | ------------------------------------------------------------ |
| 1   | **Closed world**             | Only finds attributes pre-defined in domain definition       |
| 2   | **Domain defs not loadable** | `parseDomainDefinition()` only handles JSON; all defs are MD |
| 3   | **No discovery**             | New attributes in content are invisible                      |
| 4   | **No relationships**         | Can't group "bluetooth"+"wifi" as "connectivity features"    |
| 5   | **No consistency**           | "APR", "annual rate", "interest" could be 3 different attrs  |

---

## POC A: Schema-Driven Extraction (Fix & Extend Current)

### Concept

Keep the current model — all attributes are pre-defined in domain definitions
and org profiles. Fix what's broken, add missing pieces.

### How Attributes Are Generated

```
Admin uploads:
  1. Domain Definition (JSON) ──→ Defines attribute taxonomy
     {
       attributes: [
         { id: "interest_rate", name: "Interest Rate",
           dataType: "percentage",
           applicableTo: ["credit_card", "housing_loan", "savings_account"],
           extraction: {
             method: "hybrid",
             patterns: ["\\d+\\.?\\d*\\s*%\\s*(APR|interest|rate)"],
             keywords: ["APR", "annual percentage rate", "interest"]
           }
         },
         { id: "has_bluetooth", name: "Bluetooth Support",
           dataType: "boolean",
           applicableTo: ["printer", "headset"],
           extraction: {
             method: "regex",
             patterns: ["bluetooth\\s*(\\d+\\.\\d+)?", "BT\\s*\\d+\\.\\d+"],
             keywords: ["bluetooth", "BT", "wireless"]
           }
         }
       ]
     }

  2. Org Profile (MD) ──→ LLM parses into customer-specific context
     "Our Platinum Card has APR of 18.9-24.9%"
     ──→ { interest_rate: { typicalRange: "18.9-24.9%", aliases: ["APR"] } }
```

### How Relationships Are Found

**Structural only** — defined in the domain definition:

```
Domain → Category → Product → Attribute
  Banking → Cards → Credit Card → [interest_rate, credit_limit, rewards_program]
                  → Debit Card  → [withdrawal_limit, transaction_fees]
           → Loans → Housing    → [interest_rate, loan_tenure, ltv_ratio]
```

- `interest_rate` is shared across Credit Card + Housing Loan (same attribute,
  different context via `applicableTo`)
- `credit_limit` applies ONLY to Credit Card (not Debit Card)
- Relationships are explicit in taxonomy: `applicableTo`/`notApplicableTo`

### How Consistency Is Maintained

- **Pre-defined IDs**: `interest_rate` is always `interest_rate` — no drift
- **Org profile aliases**: "APR" → resolves to `interest_rate` via `organizationContext.aliases`
- **Scoped extraction**: EntityExtractor only looks for attributes applicable to
  the document's classified product type
- **Regex + LLM**: Regex catches exact patterns; LLM catches paraphrases using
  keyword hints

### What Needs To Be Built

1. **Fix domain definition loading** — add MD parsing (like org profile already has)
2. **Create JSON domain definitions** — convert banking.md → banking.json
3. **Wire attributes to OpenSearch** — during KG enrichment, write to canonical
   custom slots or nested field

### Tradeoffs

| Aspect        | Rating | Notes                                                        |
| ------------- | ------ | ------------------------------------------------------------ |
| Accuracy      | ★★★★★  | High — admin curates every attribute                         |
| Consistency   | ★★★★★  | Perfect — pre-defined IDs, no drift                          |
| Discovery     | ★☆☆☆☆  | Zero — misses everything not in definition                   |
| Setup cost    | ★★☆☆☆  | High — admin must define 30-100 attributes per domain        |
| Relationships | ★★★★☆  | Structural — explicit in taxonomy, but no emergent discovery |
| Scalability   | ★★★★☆  | Bounded by admin effort — adding new domains = manual work   |

---

## POC B: Content-Driven Discovery (Open-World LLM Extraction)

### Concept

No pre-defined attributes at all. LLM reads every document and discovers
attributes dynamically. A reconciliation step normalizes names and groups
related attributes.

### How Attributes Are Generated

```
Document chunk:
  "The HP LaserJet Pro M428 features bluetooth 5.0 connectivity,
   a 50-page automatic document feeder, and 600x600 DPI scanner.
   Price starts at $399.99 with a 1-year warranty."
         │
         ▼
LLM Discovery Prompt (per chunk):
  "Extract all product attributes and their values from this text.
   For each attribute, provide:
   - attribute_name: lowercase_snake_case canonical name
   - display_name: Human-readable name
   - value: The extracted value
   - data_type: string|number|boolean|date|currency|percentage
   - confidence: 0.0-1.0
   Return JSON array."
         │
         ▼
Raw LLM Output:
  [
    { attribute_name: "bluetooth_version", display_name: "Bluetooth Version",
      value: "5.0", data_type: "string", confidence: 0.95 },
    { attribute_name: "adf_capacity", display_name: "Auto Document Feeder",
      value: 50, data_type: "number", confidence: 0.90 },
    { attribute_name: "scanner_resolution", display_name: "Scanner Resolution",
      value: "600x600", data_type: "string", confidence: 0.85 },
    { attribute_name: "price", display_name: "Price",
      value: 399.99, data_type: "currency", confidence: 0.95 },
    { attribute_name: "warranty_period", display_name: "Warranty Period",
      value: "1 year", data_type: "string", confidence: 0.80 }
  ]
         │
         ▼
Reconciliation Service (batch, periodic):
  Collects ALL discovered attributes across documents
  Groups by semantic similarity
  Elects canonical name per group

  Discovered across 500 documents:
    "bluetooth_version" (342 docs)
    "bt_version" (23 docs)
    "bluetooth_support" (89 docs)
    "wireless_bluetooth" (12 docs)
         │
         ▼
  Reconciled: canonical = "bluetooth_version"
    aliases: ["bt_version", "bluetooth_support", "wireless_bluetooth"]
    category: "connectivity"  (LLM-inferred)
    related: ["wifi_standard", "nfc_support"]  (co-occurrence)
```

### How Relationships Are Found

**Three methods, all automatic:**

1. **Co-occurrence**: Attributes that appear together in documents are related

   ```
   bluetooth_version + wifi_standard + nfc_support
     → appear together in 89% of documents
     → auto-group: "connectivity_features"
   ```

2. **LLM inference**: Ask LLM to categorize discovered attributes

   ```
   "Group these attributes into logical categories:
    bluetooth_version, wifi_standard, scanner_resolution,
    print_speed, paper_capacity, price, warranty..."
   → { connectivity: [bluetooth, wifi, nfc],
       scanning: [scanner_resolution, adf_capacity],
       printing: [print_speed, paper_capacity],
       commercial: [price, warranty] }
   ```

3. **Document-product association**: Attributes discovered in Credit Card docs
   are credit card attributes (same as current `applicableTo` but auto-derived)

### How Consistency Is Maintained

**Reconciliation pipeline** (runs after discovery batch):

```
Phase 1: Collect
  All unique attribute_name values across all chunks
  With frequency counts

Phase 2: Cluster
  Embed attribute names → vector similarity
  Group: ["interest_rate", "APR", "annual_rate", "int_rate"] → cluster

Phase 3: Elect canonical
  Highest-frequency name wins: "interest_rate" (2340 docs)
  Others become aliases

Phase 4: Remap
  Update all EntityInstances: "APR" → "interest_rate"
  Update all chunk metadata: same remapping
  Alias table for future extraction
```

### What Needs To Be Built

1. **Open-world LLM extraction prompt** — replace scoped extraction with
   open-ended discovery
2. **Reconciliation service** — batch job that clusters, normalizes, elects
3. **Attribute registry** — central store of canonical attributes + aliases
4. **Auto-categorizer** — LLM groups attributes into logical categories
5. **Re-extraction trigger** — when new canonical attributes are added, optionally
   re-scan existing documents

### Tradeoffs

| Aspect        | Rating | Notes                                                       |
| ------------- | ------ | ----------------------------------------------------------- |
| Accuracy      | ★★★☆☆  | LLM hallucinates attributes, noisy                          |
| Consistency   | ★★★☆☆  | Reconciliation helps but not perfect — drift across batches |
| Discovery     | ★★★★★  | Finds everything — even attributes admin never thought of   |
| Setup cost    | ★★★★★  | Zero — just ingest documents                                |
| Relationships | ★★★★☆  | Co-occurrence + LLM inference — emergent, sometimes wrong   |
| Scalability   | ★★★☆☆  | LLM cost per chunk (~$0.0002), reconciliation is O(n²)      |

---

## POC C: Hybrid — Schema Seeds + Content Discovers + Admin Approves

### Concept

Best of both worlds. Domain definition provides the **seed taxonomy** (known
attributes). LLM discovers **novel attributes** from content. A reconciliation
step merges discovered into known. Admin approves/rejects via UI.

### How Attributes Are Generated

```
                    ┌─────────────────────────┐
                    │   KNOWN ATTRIBUTES      │
                    │   (Domain Definition)    │
                    │                         │
                    │   interest_rate          │
                    │   credit_limit           │
                    │   rewards_program        │
                    │   ...28 more             │
                    └────────┬────────────────┘
                             │
         ┌───────────────────┼───────────────────┐
         ▼                   ▼                   ▼
    Regex Extract       LLM Scoped          LLM Open-World
    (known patterns)    (known attrs)       (discover new)
         │                   │                   │
         ▼                   ▼                   ▼
    "18.9% APR"         interest_rate:       "contactless_payment"
    → interest_rate:     0.189               "chip_technology"
      0.189             credit_limit:        "mobile_wallet_support"
                         50000               (NOT in domain def)
         │                   │                   │
         └───────────────────┼───────────────────┘
                             ▼
                    ┌─────────────────────────┐
                    │  RECONCILIATION ENGINE  │
                    │                         │
                    │  1. Match to known?     │
                    │     "APR" → interest_rate ✓ (alias match)
                    │     "contactless" → ??? ✗ (novel)
                    │                         │
                    │  2. Novel → Candidate   │
                    │     { name: "contactless_payment",
                    │       frequency: 234 docs,
                    │       confidence: 0.87,
                    │       suggested_category: "payment_features",
                    │       related_to: ["mobile_wallet", "nfc"],
                    │       status: "PENDING_REVIEW" }
                    │                         │
                    │  3. Auto-approve rules  │
                    │     frequency > 100     │
                    │     AND confidence > 0.8│
                    │     AND no name conflict│
                    │     → AUTO_APPROVED     │
                    │                         │
                    │  4. Admin review queue  │
                    │     Low-confidence or   │
                    │     conflicting attrs   │
                    │     → PENDING_REVIEW    │
                    └─────────────────────────┘
                             │
                     ┌───────┴───────┐
                     ▼               ▼
              CONFIRMED          REJECTED
              (becomes part       (blacklisted,
               of taxonomy)        never extract
                                   again)
```

### How Relationships Are Found

**Four layers:**

```
Layer 1: Structural (from domain definition)
  Domain → Category → Product → Attribute
  interest_rate.applicableTo = [credit_card, housing_loan]

Layer 2: Alias Resolution (from org profile + reconciliation)
  "APR" = "annual percentage rate" = "interest_rate"
  Maintained in attribute registry with canonical ID

Layer 3: Co-occurrence (from document analysis)
  bluetooth + wifi + nfc → co-occur in 89% of docs
  → auto-create: "connectivity_features" group
  interest_rate + credit_limit + rewards → co-occur in credit card docs
  → validates structural relationship

Layer 4: LLM-Inferred Hierarchy (periodic batch)
  "Given these attributes discovered from printer documents,
   organize them into a hierarchy:"
  → Printer
    ├── Connectivity: bluetooth, wifi, nfc, usb
    ├── Scanning: resolution, adf_capacity, scan_speed
    ├── Printing: print_speed, paper_capacity, duplex
    └── Commercial: price, warranty, support_plan

  This hierarchy becomes NAVIGABLE in the Browse SDK
```

### How Consistency Is Maintained

**Three-tier consistency model:**

```
Tier 1: Known Attributes (highest confidence)
  ┌──────────────────────────────────────────────┐
  │ Defined in domain definition                 │
  │ Canonical ID: interest_rate                  │
  │ Aliases: [APR, annual rate, int_rate]        │
  │ Patterns: [\d+\.?\d*\s*%\s*(APR|interest)]  │
  │ Status: PERMANENT                            │
  │ Consistency: regex + LLM with hints          │
  └──────────────────────────────────────────────┘

Tier 2: Discovered + Approved (high confidence)
  ┌──────────────────────────────────────────────┐
  │ Discovered from content, approved by admin   │
  │ Canonical ID: contactless_payment            │
  │ Aliases: [contactless, tap_to_pay, NFC_pay]  │
  │ Patterns: auto-generated from examples       │
  │ Status: APPROVED                             │
  │ Consistency: reconciliation + human review   │
  └──────────────────────────────────────────────┘

Tier 3: Discovered + Pending (uncertain)
  ┌──────────────────────────────────────────────┐
  │ Discovered from content, not yet reviewed    │
  │ Stored but NOT exposed in Browse SDK         │
  │ Status: PENDING_REVIEW                       │
  │ Consistency: LLM-only, may have duplicates   │
  │ Auto-promoted if frequency > threshold       │
  └──────────────────────────────────────────────┘
```

**Extraction pipeline with consistency:**

```
For each chunk:
  1. Run Tier 1 extraction (regex + scoped LLM)
     → Known attributes with known IDs — 100% consistent

  2. Run open-world LLM extraction
     → Discovers novel attribute candidates

  3. Match candidates against Tier 2 approved attributes
     → If alias match → use canonical ID (consistent)
     → If no match → create Tier 3 candidate

  4. Periodically: reconcile Tier 3 candidates
     → Cluster by semantic similarity
     → Promote high-frequency clusters to Tier 2 review queue
     → Admin approves/rejects
     → Approved → generate regex patterns from examples
     → Next extraction round uses new patterns (consistency improves)
```

### What Needs To Be Built

1. **Attribute Registry** — MongoDB collection for canonical attributes, aliases,
   status (PERMANENT/APPROVED/PENDING/REJECTED)
2. **Dual extraction mode** — EntityExtractor runs scoped (Tier 1) + open-world
   (discovery) in parallel
3. **Reconciliation service** — batch job: cluster, deduplicate, elect canonical,
   suggest categories
4. **Admin review UI** — queue of discovered attributes for approval/rejection
5. **Auto-pattern generator** — given 100 examples of "bluetooth 5.0", generate
   regex pattern automatically
6. **Attribute relationship graph** — store co-occurrence + hierarchy in Neo4j

### Tradeoffs

| Aspect        | Rating | Notes                                                        |
| ------------- | ------ | ------------------------------------------------------------ |
| Accuracy      | ★★★★☆  | High for Tier 1 (pre-defined), good for Tier 2 (approved)    |
| Consistency   | ★★★★☆  | Strong for known, improving over time for discovered         |
| Discovery     | ★★★★★  | Finds novel attributes, admin curates quality                |
| Setup cost    | ★★★★☆  | Low initial (domain def seeds), then auto-discovery kicks in |
| Relationships | ★★★★★  | Structural + co-occurrence + LLM-inferred + admin-curated    |
| Scalability   | ★★★★☆  | Controlled LLM cost, admin effort bounded by auto-approve    |

---

## Comparison Matrix

| Dimension                      | POC A: Schema-Driven   | POC B: Content-Driven    | POC C: Hybrid           |
| ------------------------------ | ---------------------- | ------------------------ | ----------------------- |
| **Attribute source**           | Admin-defined          | LLM-discovered           | Both                    |
| **Novel attribute discovery**  | ❌ Never               | ✅ Always                | ✅ Always               |
| **Consistency guarantee**      | ✅ Perfect             | ⚠️ Reconciliation-based  | ✅ Tiered               |
| **Setup cost**                 | High (manual curation) | Zero                     | Low (domain def seeds)  |
| **LLM cost per chunk**         | ~$0.0001 (scoped)      | ~$0.0004 (open-world)    | ~$0.0005 (both)         |
| **Relationship discovery**     | Structural only        | Emergent (co-occurrence) | All four layers         |
| **Admin involvement**          | Upfront (define all)   | None                     | Periodic (review queue) |
| **Time to first useful facet** | After full domain def  | After first batch        | After domain def (fast) |
| **Handles unknown domains**    | ❌ Need new domain def | ✅ Works on anything     | ✅ Degrades gracefully  |
| **Browse SDK compatibility**   | ✅ Fixed taxonomy      | ⚠️ Dynamic, may change   | ✅ Stable + evolving    |

---

## Recommendation

**POC C (Hybrid)** is the right answer, but we should **build all three as layers**:

```
Layer 1: Schema-driven extraction  (POC A — build first, works immediately)
Layer 2: Open-world discovery      (POC B — add on top, discovers novel attrs)
Layer 3: Reconciliation + approval (POC C — the glue that makes it consistent)
```

This is incremental — POC A works day one, POC B adds discovery, POC C adds quality.

---

## Concrete Example: Banking Domain

### POC A alone (Schema-Driven)

Admin defines 30 attributes in banking.json. Entity extraction finds:

- `interest_rate: 18.9%` in a credit card document ✅
- `credit_limit: $50,000` in a credit card document ✅
- `contactless payment available` — **MISSED** (not in definition)
- `Apple Pay supported` — **MISSED**
- `3% foreign transaction fee` — **MISSED** (no `foreign_transaction_fee` attribute)

**Browse SDK shows:** 30 known facets. Missing real-world attributes.

### POC B alone (Content-Driven)

LLM discovers from content:

- `interest_rate: 18.9%` ✅
- `credit_limit: $50,000` ✅
- `contactless_payment: true` ✅ (discovered!)
- `apple_pay_support: true` ✅ (discovered!)
- `foreign_transaction_fee: 3%` ✅ (discovered!)
- `annual_percentage_rate: 18.9%` ⚠️ (duplicate of interest_rate!)
- `apr: 18.9%` ⚠️ (another duplicate!)
- `card_color: platinum` ⚠️ (noise — not useful for navigation)

**Browse SDK shows:** 50+ facets, some duplicates, some noise.
Reconciliation fixes most but not all.

### POC C (Hybrid)

- Tier 1 finds 30 known attributes consistently ✅
- LLM discovers `contactless_payment`, `apple_pay_support`, `foreign_transaction_fee`
- Reconciliation matches "APR" → `interest_rate` (known alias)
- Reconciliation creates candidates for novel attributes
- `contactless_payment` appears in 500 docs → auto-approved
- `card_color` appears in 12 docs → stays pending, not shown in SDK
- Admin sees review queue: "foreign_transaction_fee (appeared in 234 docs)" → approves

**Browse SDK shows:** 30 known + 3 approved = 33 high-quality facets.
Growing over time as more attributes are discovered and approved.

---

## Next Steps

1. Pick POC approach (or confirm all-three-as-layers)
2. Design the Attribute Registry model
3. Build POC A extraction + OpenSearch bridge (immediate value)
4. Add POC B discovery mode (parallel LLM prompt)
5. Build POC C reconciliation + admin UI

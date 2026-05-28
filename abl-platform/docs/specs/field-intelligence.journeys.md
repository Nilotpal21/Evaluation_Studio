# Field Intelligence — Capabilities & User Journeys

## Current State

### What exists today

The SearchAI platform has a **three-layer field architecture** that is technically sound but experientially fragmented:

1. **Source Schema Discovery** — When a connector (currently SharePoint) is added, the system discovers fields from the source via API introspection or template-based rules. Fields are stored in `ConnectorSchema` with type, sample values, and enum detection.

2. **Canonical Schema & Field Mapping** — Discovered fields are mapped to a fixed set of 75 canonical slots (12 core + 26 common + 37 custom typed slots). A three-tier pipeline handles mapping: rule-based templates (~70%), LLM for ambiguous fields (~20%), and fallback to custom slots (~10%). Mappings are stored per-connector with confidence scores.

3. **Domain Vocabulary** — Business terms that resolve to canonical fields at query time. Generated once by LLM after initial field mapping. Powers both static resolution (exact/alias/fuzzy matching) and dynamic resolution (LLM-based intent classification).

### How users interact with it today

**SharePoint connector setup** (the only enterprise connector currently supported):

```
Connect (OAuth) → Auto-Proposal (health, permissions, schedule)
  → Scope & Filters (sites, file types, size, dates)
    → Field Mapping (table: source field → canonical slot, checkboxes)
      → Config Review → Approve & Sync
```

**Post-setup field management:**

- A "Fields" tab on the knowledge base shows canonical fields with expandable sources
- A separate "Vocabulary" tab shows domain vocabulary entries with test panel
- These are disconnected from each other and from the setup flow

**Search/Agent interaction:**

- Agent receives a discovery manifest with vocabulary terms at session start
- Agent can filter, sort, aggregate using vocabulary-resolved canonical fields
- Results return raw canonical field names (`custom_string_1`, not "Color")

### What the user actually experiences

**First-time setup:** The field mapping step presents a table of fields with type badges, confidence percentages, and "Map To" dropdowns. The user doesn't understand what canonical mapping means, why confidence is 62% vs 94%, or what embedding inclusion implies. They click through it. The system does reasonable work silently, but the user has no mental model of what happened.

**After setup:** Documents sync. The user goes to search. They type "show me high priority tickets." If vocabulary was generated correctly, this works. If it wasn't (mapping was pending review, no auto-apply happened), the query becomes semantic search instead of a precise filter. The user doesn't know why sometimes search is smart and sometimes it's dumb.

**Adding a second source:** No cross-source review happens. If both sources have a "priority" field with different value sets, the system maps both to `canonical.priority` but doesn't normalize values. "High" from Jira and "High" from Zendesk happen to match, but "Highest" from Jira and "Urgent" from Zendesk don't map to a common value. Cross-source filtering silently misses results.

**Correcting mistakes:** If the user notices a wrong mapping and fixes it in the Fields tab, vocabulary is NOT regenerated. The agent continues using stale vocabulary. The user's correction doesn't propagate to search quality. The only way to update vocabulary is to manually edit entries in the Vocabulary tab — a completely separate screen with no link to the field they just corrected.

---

## What's Missing / What Changes

### Structural gaps (root causes, not symptoms)

1. **No "data understanding" moment** — The user never sees a clear picture of "here's what's in your data and here's what we'll do with it." Field mapping is transactional (checkboxes) rather than educational (transparency + rationale).

2. **Three disconnected systems** — Field configuration, vocabulary, and search/agent operate as separate subsystems. Changes in one don't propagate to the others. The user must manually keep them in sync.

3. **One-shot vocabulary generation** — Vocabulary is generated once after initial field mapping and never automatically refreshed. Mapping edits, enum value changes, new fields from re-sync, and approved pending mappings all leave vocabulary stale.

4. **Output path has no intelligence** — The input path (query → filter) has full alias resolution and vocabulary matching. The output path (results → user) passes through raw canonical field names. The agent and API clients see `custom_string_1`, not "Status."

5. **No cross-source unification experience** — When multiple sources map to the same canonical field with different value vocabularies, there is no normalization review, no conflict detection UX, and no unified value set.

6. **No sort backing for enum fields** — Pick list fields like priority store string values. "Sort by priority" sorts alphabetically (Critical, High, Low, Medium) instead of by severity order. No integer sort-backing exists.

7. **No companion field awareness** — The system doesn't know that when filtering by "priority," it should also return ticket_id, title, and assignee for context. Results are either all fields or just title+content.

8. **Field configuration varies by source type** — SharePoint has `FieldMappingStep`, JSON upload has `JsonFieldSelectionDialog`, web crawl has nothing. Same concept, inconsistent experiences.

9. **No pre-loaded intelligence per connector type** — The system doesn't ship with knowledge of common questions for each connector type. A Jira connector should know users ask "show me open bugs" or "critical issues this sprint" — today it discovers this only if vocabulary LLM generation happens to produce it.

10. **No transparency in automated decisions** — Every auto-mapping, normalization, and type classification happens silently. Users can't see why the system chose a mapping, can't understand confidence scores, and can't learn from the system's reasoning.

---

## Design Decisions (capability-level)

### D-1: Live pipeline over one-shot generation

**Decision:** Field configuration, vocabulary, and search/agent form a live reactive pipeline. Any change to fields automatically regenerates affected vocabulary and updates agent capabilities.

**Why:** Users correct mistakes. Data evolves. New sources are added. A one-shot system forces users to manually propagate changes across three UIs. A live pipeline means "fix it once, fixed everywhere."

**What the user gains:** Correct a field mapping → vocabulary updates → next search uses the correction. No manual vocabulary editing needed for field-driven changes.

**What stays the same:** Users can still manually create vocabulary entries for business-specific terms the system can't discover (e.g., "fire drill" = Critical priority). Manual entries are preserved across regeneration.

### D-2: Transparency as a first-class feature

**Decision:** Every automated decision (type detection, mapping, normalization, sort order) includes a human-readable rationale visible to the user. The system explains what it did and why.

**Why:** Four different personas use this system — from non-technical customers to pro-code developers. Transparency teaches first-time users, builds trust for non-technical users, and gives technical users the information they need to override confidently.

**What the user gains:** Instead of a confidence percentage (62% — what does that mean?), users see: "Mapped 'urgency' → Priority because the values (Urgent, High, Normal, Low) match a severity scale. 3 of 4 values matched known priority terms."

**What stays the same:** The system still auto-maps by default. Transparency adds explanation, not friction.

### D-3: System does, user reviews

**Decision:** The system generates a complete field configuration proposal — type classifications, canonical mappings, normalization maps, sort orders, vocabulary terms — and presents it as a reviewable package. The user approves, overrides, or accepts defaults.

**Why:** Most users (especially non-technical customers and sales engineers doing demos) should never need to configure fields manually. The system should work out-of-the-box. But when it's wrong, the user needs clear affordance to correct it.

**What the user gains:** Zero-config default that's right 80%+ of the time. Clear override path for the 20%.

**What stays the same:** Pro-code users can still configure everything via API.

### D-4: Unified field experience across all source types

**Decision:** All source types (SharePoint, web crawl, file upload, future connectors) share the same field review experience. The discovery mechanism differs (API introspection vs. document sampling vs. template rules), but the user-facing review is identical.

**Why:** A user who sets up SharePoint and then adds a JSON upload should not encounter a completely different field experience. Consistency builds the mental model.

**What the user gains:** Learn once, apply everywhere.

**What stays the same:** Backend discovery adapters remain source-specific (different APIs, different schemas). Only the presentation is unified.

### D-5: Cross-source unification is an explicit user moment

**Decision:** When a user adds a second source that has overlapping fields with an existing source, the system triggers a cross-source review. This is not a silent background merge — it's a reviewable proposal showing value overlaps, conflicts, and suggested normalizations.

**Why:** Silent merging hides problems until search results are wrong. An explicit review moment ensures the user understands how their data sources relate and can correct normalization before it affects search quality.

**What the user gains:** Confidence that cross-source search works correctly. Understanding of how "Highest" (Jira) and "Urgent" (Zendesk) both map to "Critical."

**What stays the same:** Single-source users never see this. It's triggered only by actual field overlap.

### D-6: Agent-visible field intelligence

**Decision:** The agent's tool description includes not just vocabulary terms but also companion field declarations (displayWith, aggregateWith, sortWith), value synonyms, and pre-loaded question patterns per connector type. Results returned to the agent use aliased field names, not raw canonical storage names.

**Why:** The agent is the primary search interface for many users. If the agent doesn't understand the data, the user's natural language queries produce poor results regardless of how good the backend is.

**What the user gains:** "Show me urgent tickets sorted by priority" → agent filters by priority=Critical, sorts by priority descending (integer sort), returns results with ticket_id, title, assignee, status — all using human-readable field names.

**What stays the same:** Direct API consumers can opt into aliased or raw field names via a query parameter.

### D-7: Static rule engine for core logic, LLM for edge cases only

**Decision:** Type detection, mapping, normalization, and sort ordering use a deterministic rule engine. LLM is reserved for ambiguous semantic matching (low-confidence custom fields) and vocabulary enrichment (synonym generation). Core data pipeline never depends on LLM availability.

**Why:** Deterministic rules are fast, auditable, and reproducible. LLM is non-deterministic — same input can produce different mappings on retry. Data pipeline correctness should not depend on LLM quality.

**What the user gains:** Consistent, predictable behavior. Same source always produces the same field mapping.

**What stays the same:** LLM is already used for tier-2 mapping and vocabulary generation. That continues, but clearly scoped.

---

## Personas

### P1: Low-Code Builder

**Who:** A business analyst or citizen developer building a search-powered agent on the platform. Technically literate (understands APIs, data structures) but not a developer. Uses the Studio UI for everything.

**Goal:** Set up a knowledge base with 1-3 sources, configure it so their agent answers questions accurately, iterate on quality.

**Key need:** Clear guidance through setup. Understand what the system did. Override when it's wrong.

### P2: Pro-Code Developer

**Who:** A software engineer integrating SearchAI into their application via API. May not use the Studio UI at all. Interacts via SearchAI SDK, REST API, and configuration scripts.

**Goal:** Programmatically configure field mappings, normalization, vocabulary. Ensure their application gets clean, aliased search results.

**Key need:** Complete API coverage. Deterministic behavior. Raw control when needed.

### P3: Sales Engineer

**Who:** Demonstrates the platform to prospects. Sets up knowledge bases quickly with customer data. Needs things to "just work" impressively in 15 minutes.

**Goal:** Connect a customer's data source, show intelligent search working immediately. Handle the "what if I ask THIS?" moment during a demo.

**Key need:** Zero-config defaults that look smart. Fast setup. Transparent enough to explain to the prospect.

### P4: Non-Technical Customer

**Who:** A product manager, support lead, or operations person who manages their team's search instance. Understands their domain deeply but not the platform's internals.

**Goal:** Their team's search works well. When it doesn't, they can diagnose and fix without calling support.

**Key need:** Understand what the system is doing in business terms. Clear error messages. Obvious correction path.

---

## User Journeys

### Journey 1: First Source Setup — "Show Me My Data"

**Persona:** P1 (Low-Code Builder) setting up their first knowledge base

| Step | User Action                                                             | System Response                                                                                                                                                                                                                                                                         |
| ---- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Connects a data source (e.g., SharePoint via OAuth)                     | Authenticates, discovers available sites/resources                                                                                                                                                                                                                                      |
| 2    | Selects scope (which sites, file types, size limits)                    | Estimates document count and data size                                                                                                                                                                                                                                                  |
| 3    | Clicks "Continue" after scope selection                                 | System begins **field discovery**: analyzes source schema, samples data (if available), classifies every field by type                                                                                                                                                                  |
| 4    | Sees a "Data Discovery" summary screen                                  | System presents: "We found N fields in your data" with a breakdown by type (X text fields → search & AI, Y string fields → Z qualify as pick lists, N date fields, M numeric fields, K custom fields — analyzing). Each category has a one-line explanation of what it means for search |
| 5    | Expands any category to see individual fields                           | Each field shows: name, detected type, sample values, what the system will do with it (embed, filter, sort, display), and a one-sentence rationale ("'Priority' has 5 bounded values matching a severity scale → pick list, filterable, sortable")                                      |
| 6    | Overrides a decision (e.g., excludes a text field from embedding)       | System accepts the override, explains the consequence ("'Internal Notes' will not be searchable via semantic search. It will still appear in results if you choose to display it")                                                                                                      |
| 7    | Accepts the field configuration (or accepts defaults without reviewing) | System saves field mappings, generates vocabulary, and begins sync. Shows: "Your data is being indexed. Field intelligence is ready — here's what your agent now knows" with a summary of vocabulary terms created                                                                      |

**Key principle:** The user can skip straight from step 3 to step 7 (accept all defaults). Steps 4-6 are progressive disclosure for users who want to review. The system works correctly either way.

### Journey 2: Field Review & Teaching — "The System Got It Wrong"

**Persona:** P4 (Non-Technical Customer) who notices search isn't filtering correctly

| Step | User Action                                                                                        | System Response                                                                                                                                                                                                           |
| ---- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Searches for "high priority tickets" and gets irrelevant results                                   | Agent returns semantic search results instead of filtered results (vocabulary doesn't have "priority" mapped correctly)                                                                                                   |
| 2    | Navigates to the field intelligence dashboard                                                      | Sees unified view: their fields, how each is used (filtering, sorting, embedding), vocabulary terms derived from each field, and search quality indicators                                                                |
| 3    | Finds the "priority" field and sees it's mapped to the wrong canonical slot (or not mapped at all) | Field shows: current mapping, confidence, rationale. Also shows: "This field powers 0 vocabulary terms" (red indicator — no vocabulary = no smart filtering)                                                              |
| 4    | Corrects the mapping (selects the right canonical field from a guided picker)                      | System shows preview: "Changing this will: (1) update the canonical field for 1,247 documents, (2) generate vocabulary for priority filtering, (3) enable sort-by-priority for your agent"                                |
| 5    | Confirms the correction                                                                            | System re-maps affected documents, regenerates vocabulary for this field, updates agent capabilities. Shows: "Done. Your agent now understands 'priority' with values: Critical, High, Medium, Low. Try searching again." |
| 6    | Searches again for "high priority tickets"                                                         | Agent correctly filters by priority = High. Results include relevant companion fields (ticket title, assignee, status). User sees the correction took effect immediately.                                                 |

**Key principle:** Correction propagates through the entire pipeline automatically. The user fixes it in one place; the system updates everywhere.

### Journey 3: Cross-Source Unification — "My Sources Should Work Together"

**Persona:** P1 (Low-Code Builder) adding a second data source to an existing knowledge base

| Step | User Action                                                                                                                                         | System Response                                                                                                                                                                                                                                                                          |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Adds a second source (e.g., file upload with JSON data, or a second connector) to an existing knowledge base that already has one source configured | System discovers fields from the new source                                                                                                                                                                                                                                              |
| 2    | Sees the Data Discovery summary (same as J1, step 4) for the new source                                                                             | System presents new source's fields AND highlights overlaps: "We found N fields. M fields overlap with your existing source: priority, status, assignee. 2 fields are new: deal_amount, stage"                                                                                           |
| 3    | Clicks on an overlapping field (e.g., "priority")                                                                                                   | System shows the cross-source comparison: Source A values: ["Highest", "High", "Medium", "Low", "Lowest"]. Source B values: ["Urgent", "High", "Normal", "Low"]. System suggests normalization: Highest/Urgent → "Critical", High → "High", Medium/Normal → "Medium", Low/Lowest → "Low" |
| 4    | Reviews the normalization suggestion                                                                                                                | For each value mapping, the system shows the rationale ("Jira 'Highest' and Zendesk 'Urgent' both represent maximum severity. We suggest normalizing to 'Critical'")                                                                                                                     |
| 5    | Accepts or customizes the normalization (e.g., changes canonical value from "Critical" to "P0" to match their org's language)                       | System saves the normalization map. Both sources' values will be converted to the canonical set at ingestion time                                                                                                                                                                        |
| 6    | Sees a summary of all cross-source unification decisions                                                                                            | System shows: "Priority is now unified across 2 sources with 4 canonical values. Filtering by 'Critical' will match Jira 'Highest' and Zendesk 'Urgent'. Sorting will use severity order: Critical > High > Medium > Low"                                                                |
| 7    | Confirms and syncs                                                                                                                                  | System re-indexes affected documents with normalized values, updates vocabulary with value synonyms (urgent → Critical, highest → Critical), updates agent capabilities                                                                                                                  |

**Key principle:** Cross-source unification is a reviewable proposal, not a silent merge. The user sees exactly how values map across sources and can customize.

### Journey 4: Vocabulary Teaching — "My Agent Should Know Our Language"

**Persona:** P4 (Non-Technical Customer) whose team uses domain-specific terminology

| Step | User Action                                                                                   | System Response                                                                                                                                             |
| ---- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Navigates to the field intelligence dashboard, vocabulary section                             | Sees all auto-generated vocabulary: terms, aliases, which field they map to, what operations they enable (filter, sort, aggregate), whether they're active  |
| 2    | Notices the agent doesn't understand "fire drill" (their org's term for Critical priority)    | Searches vocabulary for "fire drill" — no match. Searches for "priority" — finds the entry but "fire drill" isn't listed as a synonym                       |
| 3    | Edits the "priority" vocabulary entry and adds "fire drill" as a value synonym for "Critical" | System accepts. Shows: "Added 'fire drill' as a synonym for Priority = Critical. Your agent will now interpret 'fire drill' as a Critical priority filter." |
| 4    | Tests the new synonym in the vocabulary test panel                                            | System shows resolution: "fire drill" → priority = Critical (manual synonym match). Shows what the search query would look like.                            |
| 5    | User's team member searches: "show me all fire drills from last week"                         | Agent resolves "fire drill" → priority=Critical, "last week" → date filter. Returns correctly filtered results with aliased field names                     |

**Additional path — bulk vocabulary from question sets:**

| Step | User Action                                       | System Response                                                                                                                                                                           |
| ---- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6    | Uploads a CSV of common questions their team asks | System parses questions, identifies field/value references, suggests new vocabulary entries and synonyms. Shows: "From 50 questions, we identified 12 new terms and 8 new value synonyms" |
| 7    | Reviews and accepts suggestions                   | Vocabulary updated. Agent immediately knows the new terms                                                                                                                                 |

**Key principle:** Vocabulary is a living system the user can teach. The system learns from corrections and explicit teaching, not just from initial LLM generation.

### Journey 5: Smart Search Results — "The Agent Understands My Data"

**Persona:** P4 (Non-Technical Customer) searching through their agent

| Step | User Action                                                   | System Response                                                                                                                                                                                                                                                                                                                                  |
| ---- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | Asks the agent: "what are the critical issues this sprint?"   | Agent resolves: "critical" → priority = Critical (value synonym), "this sprint" → sprint = current sprint (vocabulary), "issues" → source context: project management data                                                                                                                                                                       |
| 2    | Sees results with rich context                                | Each result shows: Priority: Critical, Title: "Login page crashes," Assignee: Alice, Status: Open, Sprint: Sprint 23. Field names are human-readable (not `custom_string_1`). Companion fields (title, assignee, status) are included automatically because the priority field declares them as "display-with"                                   |
| 3    | Asks: "sort these by when they were created"                  | Agent adds sort by created_date descending. Results re-order. Dates are formatted human-readably                                                                                                                                                                                                                                                 |
| 4    | Asks: "how many critical vs high priority issues do we have?" | Agent switches to aggregation mode. Returns: "23 Critical, 45 High — Critical issues are 34% of your backlog." Aggregation includes companion fields (count by status within each priority)                                                                                                                                                      |
| 5    | Asks: "show me all Nike products with high priority"          | Agent detects: "priority" → sources: [jira], "Nike products" → field from product catalog source. These fields don't co-exist on any document. Agent explains: "Priority and product brand come from different data sources and can't be combined in one filter. Showing separately: 12 high-priority tickets (Jira), 8 Nike products (catalog)" |

**Key principle:** The agent uses field intelligence (companion fields, value synonyms, source tracking, sort backing) to deliver precise, contextualized results. When a query is impossible, it explains why rather than returning empty results.

### Journey 6: API-First Configuration — "I Want Programmatic Control"

**Persona:** P2 (Pro-Code Developer) integrating SearchAI into their application

| Step | User Action                                                                          | System Response                                                                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Calls `GET /api/indexes/:id/field-intelligence`                                      | Returns the complete field intelligence state: all fields with types, mappings, normalization maps, vocabulary terms, companion field declarations, sort backing configuration                                    |
| 2    | Calls `PUT /api/indexes/:id/fields/:fieldId` to correct a mapping                    | System validates, applies the mapping change, triggers vocabulary regeneration. Returns updated field with new vocabulary terms that were generated                                                               |
| 3    | Calls `POST /api/indexes/:id/fields/normalize` with a cross-source normalization map | System saves normalization rules, re-indexes affected documents with normalized values, updates vocabulary with value synonyms                                                                                    |
| 4    | Calls `POST /api/search/:id/query` with `{ aliasedOutput: true }`                    | Search results return with aliased field names ("Status" instead of `custom_string_1`), formatted values (dates as ISO strings, enums as display values), hidden internal fields (sort backing integers excluded) |
| 5    | Calls `GET /api/indexes/:id/vocabulary` to inspect what the agent knows              | Returns all vocabulary entries with their provenance (auto-generated vs. manual), field linkage, and capabilities                                                                                                 |
| 6    | Calls `PUT /api/indexes/:id/vocabulary/:entryId` to add a custom synonym             | Vocabulary updated. Next query resolution uses the new synonym immediately                                                                                                                                        |

**Key principle:** Everything the UI can do, the API can do. Pro-code users get deterministic, programmatic control. The API is the single source of truth; the UI is a consumer.

### Journey 7: Sales Demo — "Show Intelligence in 15 Minutes"

**Persona:** P3 (Sales Engineer) demonstrating SearchAI to a prospect

| Step | User Action                                                                             | System Response                                                                                                                                                                                                                                                                                                             |
| ---- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Connects the prospect's SharePoint (or uploads sample data)                             | System authenticates, begins discovery                                                                                                                                                                                                                                                                                      |
| 2    | System auto-configures everything                                                       | Within 2-3 minutes: field discovery, type classification, canonical mapping, vocabulary generation all complete with zero user input. System shows a brief "intelligence summary": "Ready. We found 23 fields across 1,247 documents. Your agent can filter by 8 fields, sort by 5 fields, and understands 47 search terms" |
| 3    | Sales engineer demonstrates: "Show me all open high-priority tickets assigned to Sarah" | Agent resolves all three filters (status=Open, priority=High, assignee=Sarah), returns results with rich companion fields. Prospect is impressed                                                                                                                                                                            |
| 4    | Prospect asks: "What if we add our Zendesk data too?"                                   | Sales engineer explains the cross-source unification flow. Can show a mock/demo of the normalization review. No live setup needed — the concept is clear from the first source demo                                                                                                                                         |
| 5    | Sales engineer shows the field intelligence dashboard                                   | Prospect sees: "This is what the system learned about your data. You can correct anything. Changes take effect immediately." Transparency builds trust                                                                                                                                                                      |

**Key principle:** Zero-config setup produces impressive results. The system's intelligence is visible and demonstrable, not hidden behind the scenes.

---

## Edge Cases & Error States

### E-1: Wrong auto-mapping (high confidence but incorrect)

**Scenario:** System maps "Component" (meaning software component: Backend, Frontend, API) to canonical `component` with 94% confidence, but the user's "Component" actually means product component (Printer, Scanner, Fax).

**Expected behavior:** User sees the mapping with its rationale ("mapped by exact name match"). User overrides to a custom slot and renames it "Product Component." System regenerates vocabulary with the correct context. Previously indexed documents are re-mapped.

**Recovery path:** Field intelligence dashboard → find field → override mapping → system propagates

### E-2: Normalization value mismatch (lossy merge)

**Scenario:** Source A has priority values [P0, P1, P2, P3, P4]. Source B has [Critical, Major, Minor, Trivial]. The system suggests merging P0→Critical, P1→Major, but misses that the user considers P1 and P2 both "Major."

**Expected behavior:** Normalization review shows each value mapping. User can drag/reassign values. User moves P2 from "Minor" to "Major." System updates normalization map and re-indexes.

**Recovery path:** Cross-source unification step → edit normalization → confirm → re-index

### E-3: Stale vocabulary after field change

**Scenario:** User changes a field's enum values (adds a new priority level "Blocker"), but vocabulary still only knows Critical/High/Medium/Low.

**Expected behavior:** This should NOT happen (D-1: live pipeline). When enum values change, vocabulary regeneration is triggered automatically. If for any reason it doesn't (system error), the field intelligence dashboard shows a warning: "Vocabulary is out of sync with field configuration. 1 field has new values not reflected in vocabulary." One-click regeneration.

**Recovery path:** Dashboard warning → click "Sync vocabulary" → regeneration runs

### E-4: Conflicting fields from different sources

**Scenario:** Jira has "component" (software module names) and HubSpot has "component" (product SKU prefixes). Both map to canonical `component` by exact name match.

**Expected behavior:** System detects the conflict by comparing value distributions ("Backend, Frontend, API" vs. "SKU-100, SKU-200, SKU-300" — different domains). Flags it during cross-source unification: "Both sources have 'component' but the values don't overlap. We've separated them: Jira Component → 'Software Module', HubSpot Component → 'Product SKU' (different canonical slots)."

**Recovery path:** Cross-source review → system auto-detects → user confirms or merges

### E-5: Source with no discoverable schema

**Scenario:** User uploads a CSV with no headers, or web crawl produces documents with only content and no structured metadata.

**Expected behavior:** System detects minimal/no field metadata. Shows: "This source has rich text content but limited structured fields. We detected: title (from filename/URL), content, date, source URL. No filterable fields were found. Your agent will use semantic search for this source. To add structure, you can manually define fields."

**Recovery path:** User can manually add field definitions → vocabulary generates → search improves

### E-6: Agent query spans incompatible sources

**Scenario:** User asks "high priority Nike products" — priority exists only on Jira, product brand only on catalog data.

**Expected behavior:** Agent detects field-source incompatibility via source tracking. Instead of returning empty results silently, agent explains the disjunction and offers separate result sets (Journey 5, step 5).

**Recovery path:** No fix needed — agent behavior is correct. User learns about their data topology.

### E-7: Very large enum field (borderline pick list)

**Scenario:** "Assignee" field has 347 distinct values. System classifies it as non-pick-list (threshold: 100). User wants it filterable.

**Expected behavior:** System shows: "Assignee has 347 unique values — too many for a dropdown filter. We've classified it as open-text with autocomplete support. You can override this to treat it as a pick list, but filter dropdowns may be unwieldy." User can override. System respects the override.

**Recovery path:** Field review → override classification → system adapts

### E-8: Concurrent field edits (multi-user SaaS)

**Scenario:** Two admins edit the same field mapping simultaneously.

**Expected behavior:** Optimistic concurrency — second save shows a conflict notification with the other admin's changes. Options: merge (if non-conflicting), override, or cancel.

**Recovery path:** Conflict resolution dialog → choose action

---

## Data Requirements

### New data concepts needed

1. **Normalization Map** — Per canonical field, per source: a mapping from source enum values to canonical enum values. Conceptually: `{ canonicalField: "priority", sourceType: "jira", valueMap: { "Highest": "Critical", "High": "High", ... } }`. This does not exist today.

2. **Sort Backing** — Per canonical enum field: an integer mapping for each canonical value. Conceptually: `{ canonicalField: "priority", sortMap: { "Critical": 4, "High": 3, "Medium": 2, "Low": 1 } }`. Requires dual-field storage in OpenSearch (keyword + integer).

3. **Companion Field Declarations** — Per canonical field: which other fields to include in different operation contexts. Conceptually: `{ displayWith: ["ticket_id", "title", "assignee"], sortWith: [...], aggregateWith: [...] }`. Partially exists in DomainVocabulary (`relatedFields`) but not on the canonical field itself.

4. **Value Synonyms** — Per canonical field, per canonical value: natural language terms that map to that value. Conceptually: `{ field: "priority", value: "Critical", synonyms: ["urgent", "blocker", "P0", "fire drill"] }`. Does not exist as structured data today (vocabulary has term-level aliases but not value-level synonyms).

5. **Field Provenance** — Per canonical field: which sources contribute, how values were normalized, what the auto-detection rationale was. For transparency. Does not exist today.

6. **Pre-loaded Connector Knowledge** — Per connector type: common question patterns, expected field patterns, typical value vocabularies. Partially exists in connector-type-templates but limited to field patterns only (no questions, no value vocabularies beyond enum patterns).

### Existing data that needs extension

7. **CanonicalSchema.fields** — Needs: `sortBacking` (integer map), `companionFields` (displayWith/sortWith/aggregateWith), `sources[]` (array of source types contributing to this field), `normalizationMaps` (per-source value mapping), `provenance` (detection rationale).

8. **DomainVocabulary entries** — Needs: per-value synonyms (not just per-term aliases). Current `aliases` array is term-level; need value-level synonym mapping.

9. **OpenSearch index mapping** — Needs: additional `_sort` integer fields for each sortable enum canonical field (e.g., `metadata.canonical.priority_sort`). Current mapping is strict — new fields require mapping update + re-index.

---

## Backend Gaps

### G-1: No vocabulary regeneration triggers

When field mappings are edited, enum values change, or pending mappings are approved, vocabulary is not regenerated. Need event-driven triggers that fire vocabulary regeneration on any field intelligence change.

### G-2: No output alias resolution

The query pipeline resolves aliases on input (filter field names → canonical paths) but does NOT resolve on output (canonical paths → alias names). Need a reverse-resolution stage in the query pipeline that translates `custom_string_1` → "Status" in search results.

### G-3: No normalization model or ingestion-time value conversion

No model exists for per-source value normalization maps. The canonical-mapper-worker stores raw source values in canonical fields without value conversion. Need: normalization map model, ingestion-time value conversion, re-indexing capability when normalization changes.

### G-4: No sort-backing dual fields in OpenSearch

OpenSearch mapping has single fields per canonical slot (keyword type). Enum fields like priority need a companion `_sort` integer field. Need: mapping template update, dual-write at ingestion, sort-field resolution at query time.

### G-5: No companion field declarations at the schema level

Companion fields (`displayWith`, `aggregateWith`, `sortWith`) exist only in DomainVocabulary entries (generated by LLM, one-shot). Need: first-class companion field declarations on CanonicalSchema fields, auto-suggested by the rule engine based on connector-type templates.

### G-6: No cross-source conflict detection by value distribution

The field mapping pipeline detects name-level conflicts (two fields mapping to the same canonical slot) but not value-level conflicts (same canonical slot, different value domains). Need: value distribution comparison during cross-source unification.

### G-7: No pre-loaded question datasets per connector type

Connector-type templates define field patterns but not common question patterns. The vocabulary generation worker starts from scratch with LLM for every connector. Need: per-connector-type question dataset that seeds vocabulary immediately on connector setup.

### G-8: No unified field discovery experience across source types

SharePoint, JSON upload, and web crawl each have separate (or no) field configuration UIs. Need: a single field intelligence review experience that works regardless of source type, with source-specific discovery adapters feeding into a common presentation.

### G-9: No response field selection hints for the agent

Default `responseFields` is `['title', 'content']`. The agent doesn't receive companion field declarations in a format it can use to dynamically select which fields to include in results based on user intent. Need: companion field metadata in the discover manifest, agent-side field selection logic.

---

## Acceptance Criteria

### AC-1: Data Discovery Transparency (J1)

Given a user connects a new data source, when field discovery completes, then the system presents a categorized summary of discovered fields with type classifications, rationales, and recommended usage (embed, filter, sort, display) — without requiring any user input.

### AC-2: Zero-Config Defaults (J1, J7)

Given a user accepts all defaults without reviewing individual fields, when sync completes and vocabulary generates, then the agent can correctly resolve at least the core fields (title, status, priority, assignee, dates) for filtering and sorting from natural language queries.

### AC-3: Field Correction Propagation (J2)

Given a user corrects a field mapping in the field intelligence UI, when the correction is saved, then: (a) affected documents are re-mapped within a bounded time, (b) vocabulary entries for the affected field are regenerated, (c) the agent's next session uses the corrected field intelligence. No manual vocabulary editing required.

### AC-4: Cross-Source Normalization Review (J3)

Given a user adds a second source with overlapping enum fields, when the system detects value differences on the same canonical field, then a normalization review is presented showing: source A values, source B values, suggested canonical values, per-value mapping rationale. User can accept, customize, or keep values separate.

### AC-5: Live Vocabulary Pipeline (J2, J4)

Given any change to field configuration (mapping edit, enum value addition, normalization change, new field from re-sync), then vocabulary regeneration is triggered automatically within 60 seconds. Manual vocabulary entries are preserved across regeneration.

### AC-6: Value Synonym Resolution (J4, J5)

Given a user has configured "fire drill" as a synonym for priority=Critical, when any user searches "show me fire drills," then the agent resolves this to a precise filter (priority=Critical) rather than semantic search.

### AC-7: Aliased Output (J5, J6)

Given a search query returns results, when the client requests aliased output (default for agent path, opt-in for API), then field names in results use configured display names ("Status" not `custom_string_1`), internal fields (sort backing integers) are hidden, and dates/numbers are formatted.

### AC-8: Companion Field Context (J5)

Given a search query filters or sorts by a field with companion declarations, when results are returned, then companion fields are included automatically (e.g., filtering by priority includes ticket_id, title, assignee, status without the user or agent explicitly requesting them).

### AC-9: Sort Backing for Enum Fields (J5)

Given a canonical enum field has a defined sort order (e.g., Critical > High > Medium > Low), when a user requests "sort by priority," then results are sorted by the integer backing (severity order), not alphabetically.

### AC-10: Incompatible Query Explanation (J5)

Given a user query references fields from non-overlapping sources, when the agent detects the field-source incompatibility, then the agent explains the disjunction and offers separate result sets rather than returning empty or irrelevant results.

### AC-11: API Parity (J6)

Given any field intelligence operation available in the UI (field review, mapping correction, normalization, vocabulary editing, regeneration trigger), then the same operation is available via a documented REST API endpoint with equivalent functionality.

### AC-12: Demo-Ready Setup (J7)

Given a sales engineer connects a data source with no manual configuration, when auto-setup completes (target: under 3 minutes for < 5,000 documents), then the field intelligence summary shows the number of fields discovered, categorized, and made searchable — and the first demo query using a filterable field returns correct results.

---

_This document defines WHAT the system must do. It deliberately excludes: component names, file paths, architecture decisions, wireframes, layouts, and visual design. Those belong in the UX Spec (how it looks) and HLD (where the code goes)._

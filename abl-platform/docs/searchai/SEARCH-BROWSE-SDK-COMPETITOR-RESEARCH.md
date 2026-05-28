# Search Browse SDK — Competitor Research & Market Analysis

**Date:** 2026-03-17
**Purpose:** Inform the design of an end-user Search Results SDK with KG-driven faceted navigation

---

## Executive Summary

We analyzed 10 competitors and found a clear market gap: **no existing product combines knowledge graph taxonomy navigation, NL query decomposition into facet selections, and bidirectional sync between typed queries and clicked facets.** Every current solution either does flat/pre-structured faceted search OR graph visualization, never both integrated with document retrieval.

---

## The Use Case

An admin wants to find "payment details for an HP printer with bluetooth and scanner support." They don't know the document name. Two equivalent paths to the same result:

**Click path:** Browse by Brand → HP → Printers → Bluetooth + Scanner → 3 products → HP LaserJet → 12 payment documents

**Type path:** "payment docs for HP printer with bluetooth and scanner" → LLM decomposes → Brand=HP, ProductLine=Printer, Features=[bluetooth, scanner], Topic=payments → same 12 documents

Both paths stay in sync — clicking a facet updates the query bar, typing updates the facet selections.

---

## Competitor Analysis

### 1. Algolia InstantSearch

| Aspect                  | Details                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Deployment**          | npm (`react-instantsearch`), CDN, SSR                                                                        |
| **Frameworks**          | React, Vue, Angular, vanilla JS, iOS, Android                                                                |
| **Key components**      | SearchBox, Hits, RefinementList, HierarchicalMenu, RangeSlider, Pagination, Breadcrumb, DynamicWidgets       |
| **Hierarchical facets** | `HierarchicalMenu` widget — requires data indexed with `lvl0`, `lvl1`, `lvl2` attributes using `>` separator |
| **Drill-down**          | Click category → expand children; breadcrumb tracks path                                                     |
| **Pricing**             | Free (10k req/mo), Grow ($0.50/1k), Elevate ($50k+/yr for NeuralSearch)                                      |
| **AI/NLP**              | NeuralSearch (vector + keyword hybrid) — Elevate tier only. No NL→facet decomposition                        |
| **Gaps for us**         | Requires Algolia backend. Hierarchical facets need pre-flattened lvl0/1/2 — not dynamic KG traversal         |

### 2. Elasticsearch / OpenSearch (Searchkit, ReactiveSearch)

| Aspect                  | Details                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Deployment**          | npm (Searchkit, ReactiveSearch), self-hosted                                                                     |
| **Frameworks**          | React, Vue, Angular, vanilla JS. ReactiveSearch: + React Native, Flutter                                         |
| **Key components**      | SearchBox, Results, RefinementList, RangeFilter, Pagination. ReactiveSearch has 30+ components                   |
| **Hierarchical facets** | Via nested `terms` aggregations. Searchkit uses Algolia-compatible HierarchicalMenu                              |
| **Pricing**             | All open source (Apache-2.0)                                                                                     |
| **AI/NLP**              | None for query understanding. OpenSearch neural search plugin for vector search                                  |
| **Gaps for us**         | Facets are aggregation-driven (flat counts), not graph-traversal. No taxonomy drill-down. No query decomposition |

### 3. Apache Solr

| Aspect                  | Details                                                                     |
| ----------------------- | --------------------------------------------------------------------------- |
| **Deployment**          | Server-side only (Java). No official UI SDK                                 |
| **Hierarchical facets** | `facet.pivot` for nested hierarchies. PathHierarchyTokenizer for tree paths |
| **Pricing**             | Open source (Apache-2.0)                                                    |
| **AI/NLP**              | None. Basic synonyms/stemming                                               |
| **Gaps for us**         | No UI layer. Static hierarchy. Declining market share                       |

### 4. Coveo (Atomic + Headless)

| Aspect                  | Details                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| **Deployment**          | Coveo Atomic: web components (script tag, npm). Headless: npm (framework-agnostic)               |
| **Frameworks**          | Web components (universal), React, Angular, Vue, Salesforce LWC                                  |
| **Key components**      | 50+ components. `atomic-category-facet` for tree nav. Dynamic Navigation Experience (DNE)        |
| **Hierarchical facets** | Category facets + DNE ML model auto-reorders facets by user behavior                             |
| **Pricing**             | Enterprise-only ($50k-$200k+/yr). No free tier                                                   |
| **AI/NLP**              | DNE (ML facet reordering), Auto Relevance Tuning, NL understanding, RAG                          |
| **Gaps for us**         | Locked to Coveo backend. DNE is behavioral (needs training data), not structural. Very expensive |

### 5. Typesense InstantSearch

| Aspect                  | Details                                                                |
| ----------------------- | ---------------------------------------------------------------------- |
| **Deployment**          | npm adapter to Algolia InstantSearch                                   |
| **Frameworks**          | React, Vue, Angular, vanilla JS (via Algolia compat)                   |
| **Hierarchical facets** | Same lvl0/1/2 pattern as Algolia (via adapter)                         |
| **Pricing**             | Open source (GPLv3). Typesense Cloud: usage-based                      |
| **Gaps for us**         | Requires Typesense backend. Same flat-hierarchy limitations as Algolia |

### 6. Meilisearch

| Aspect                  | Details                                                                 |
| ----------------------- | ----------------------------------------------------------------------- |
| **Deployment**          | npm (`instant-meilisearch`), self-hosted or cloud                       |
| **Frameworks**          | React, Vue, Angular, vanilla JS                                         |
| **Hierarchical facets** | Native support with AND logic. Uses nested document structure           |
| **Pricing**             | Open source (MIT). Cloud: usage-based                                   |
| **Gaps for us**         | Requires Meilisearch backend. Hierarchy is index-time, not graph-driven |

### 7. Google Vertex AI Search

| Aspect                  | Details                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------- |
| **Deployment**          | API + embeddable widget. GCP-only                                                   |
| **Hierarchical facets** | Flat facets only                                                                    |
| **AI/NLP**              | NL filter extraction ("hotels in Paris under $200" → structured filters). Black-box |
| **Pricing**             | Pay-per-query GCP pricing                                                           |
| **Gaps for us**         | GCP lock-in. No self-hosted. No customization. No KG integration                    |

### 8. Graph-Based Navigation

| Tool           | Type       | Notes                                   |
| -------------- | ---------- | --------------------------------------- |
| Neo4j Bloom    | Viz app    | NL search over graph, no embeddable SDK |
| Neo4j NVL      | React lib  | Graph visualization, not faceted search |
| Graphiti (Zep) | KG builder | Builds KGs, no browse UI                |

**Gap:** No SDK combines KG traversal with faceted document discovery.

### 9. E-Commerce Patterns (Amazon, Best Buy)

| Pattern                  | How it works                                                                |
| ------------------------ | --------------------------------------------------------------------------- |
| Category tree            | Left-nav hierarchy (Dept > Category > Subcategory). Pre-curated taxonomy    |
| Facet sidebar            | Brand, Price, Rating, Features as checkboxes. Dynamic counts                |
| Breadcrumb trail         | Current drill-down path, each segment clickable                             |
| Zero dead-ends           | Facet counts prevent 0-result selections (Endeca's innovation)              |
| Cross-facet independence | Selecting "HP" still shows all values in other facets (post_filter pattern) |

Best Buy's taxonomy redesign (Earley Information Science) yielded 5-95% findability improvement.

### 10. Guided Navigation (Endeca/Oracle)

Endeca pioneered "guided navigation" — system always shows valid next-step refinements, preventing dead ends. Modern equivalent: Coveo DNE (ML-driven). Our approach: KG taxonomy structure determines valid refinements deterministically (no training data needed, works from day one).

---

## Comparison Matrix

| Solution              | OSS      | Self-Hosted | Hierarchical Facets | KG-Driven | NL→Facets    | Bidirectional Sync | Embeddable |
| --------------------- | -------- | ----------- | ------------------- | --------- | ------------ | ------------------ | ---------- |
| Algolia InstantSearch | UI only  | ❌          | Pre-flattened       | ❌        | ❌           | ❌                 | ✅         |
| Searchkit (ES/OS)     | ✅       | ✅          | Via InstantSearch   | ❌        | ❌           | ❌                 | ✅         |
| ReactiveSearch        | ✅       | ✅          | Partial             | ❌        | ❌           | ❌                 | ✅         |
| Coveo Atomic          | UI only  | ❌          | DNE ML              | ❌        | Partial      | ❌                 | ✅         |
| Typesense             | ✅       | ✅          | Via adapter         | ❌        | ❌           | ❌                 | ✅         |
| Meilisearch           | ✅       | ✅          | Native              | ❌        | ❌           | ❌                 | ✅         |
| Vertex AI Search      | ❌       | ❌          | Flat only           | ❌        | ✅           | ❌                 | Partial    |
| Neo4j Bloom/NVL       | NVL only | NVL         | N/A                 | ✅        | NL graph     | ❌                 | NVL only   |
| **Our Browse SDK**    | **✅**   | **✅**      | **KG taxonomy**     | **✅**    | **✅ (LLM)** | **✅**             | **✅**     |

---

## Query Decomposition Approaches

| Approach                    | Accuracy   | Cost                  | Latency   | Who uses it                   |
| --------------------------- | ---------- | --------------------- | --------- | ----------------------------- |
| LLM structured extraction   | 85-95%     | ~$0.001/query (Haiku) | 200-500ms | Custom, LlamaIndex, LangChain |
| Intent + slot filling (NER) | 70-85%     | Free                  | 10-50ms   | Rasa, spaCy                   |
| Hybrid rules + LLM fallback | 80-90%     | ~$0.0003/query avg    | 50-300ms  | spaCy-LLM                     |
| Vertex AI NL filters        | ~90%       | GCP pricing           | 100-300ms | Google only                   |
| Coveo DNE                   | Behavioral | $50k+/yr              | 50ms      | Coveo only                    |

**Our choice:** LLM structured extraction. Send query + taxonomy schema to Haiku, get structured facet JSON. Already have LLM infrastructure. ~$0.001/query.

---

## Our Unique Value Proposition

1. **KG-driven taxonomy** — facets come from a knowledge graph, not pre-flattened index fields. The taxonomy is structural, deterministic, and explainable (vs Coveo's behavioral ML)
2. **NL → facet decomposition** — type natural language, get structured facet selections. No competitor offers this except Vertex AI (GCP-locked) and Coveo (partial, $50k+/yr)
3. **Bidirectional sync** — type query ↔ click facets, always in sync. No shipping product has this
4. **Self-hosted, open source** — zero per-query cost at scale. Algolia charges $0.50/1k, Coveo is $50k+/yr
5. **Zero dead-ends from day one** — KG structure guarantees valid refinements without training data

---

## Pricing Advantage

| Solution    | Cost at 1M queries/month                                   |
| ----------- | ---------------------------------------------------------- |
| Algolia     | $500-$750/mo                                               |
| Coveo       | $4,000-$17,000/mo                                          |
| Vertex AI   | Variable (GCP compute)                                     |
| **Our SDK** | **$0 (self-hosted) + ~$1,000/mo LLM for NL decomposition** |

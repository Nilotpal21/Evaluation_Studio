# Feature Test Guide: SearchAI — Full User Journey E2E

**Feature**: SearchAI knowledge base — ingestion, intelligence, search, browse (complete flow)
**Target**: https://agents-dev.kore.ai/
**Branch**: develop
**First tested**: 2026-03-22
**Last updated**: 2026-03-22
**Overall status**: NOT STARTED

---

## Persona & Scenario

**Fresh user "Alex"** — a product engineer who wants to build a research document search tool. Alex has a collection of technical PDFs, markdown files, and web articles about AI/ML topics. Alex wants to:

1. Create a knowledge base for "AI Research Library"
2. Upload research documents (PDFs, markdown, text)
3. Crawl a few web pages for additional content
4. Configure LLM for intelligent processing
5. Review auto-detected fields and taxonomy
6. Search the knowledge base with natural language
7. Browse documents via taxonomy categories
8. Compare search quality WITH vs WITHOUT LLM

---

## Test Data — Sample Documents

### Batch 1: Manual Upload (5 files)

Create these locally before testing:

| File                             | Type     | Content                                                                                                | Purpose              |
| -------------------------------- | -------- | ------------------------------------------------------------------------------------------------------ | -------------------- |
| `transformer-architecture.md`    | Markdown | 2-page summary of transformer architecture (attention mechanism, encoder-decoder, positional encoding) | Core document        |
| `rag-patterns.txt`               | Text     | Overview of RAG patterns (naive, advanced, modular, agentic) with pros/cons                            | Core document        |
| `vector-databases-comparison.md` | Markdown | Comparison table of Pinecone, Weaviate, Qdrant, Milvus with features/pricing                           | Structured data      |
| `llm-fine-tuning-guide.txt`      | Text     | Step-by-step fine-tuning guide (LoRA, QLoRA, full fine-tuning) with code snippets                      | Technical how-to     |
| `ai-safety-principles.md`        | Markdown | RLHF, constitutional AI, red teaming, alignment research summary                                       | Different topic area |

### Batch 2: Web Crawl (2 URLs)

| URL                                                    | Purpose                                  |
| ------------------------------------------------------ | ---------------------------------------- |
| `https://lilianweng.github.io/posts/2023-06-23-agent/` | Real research blog post about LLM agents |
| `https://arxiv.org/abs/2005.11401`                     | RAG paper abstract page                  |

### Batch 3: Additional uploads after LLM config (2 files)

| File                               | Type     | Content                                                              | Purpose                        |
| ---------------------------------- | -------- | -------------------------------------------------------------------- | ------------------------------ |
| `prompt-engineering-techniques.md` | Markdown | Chain-of-thought, few-shot, zero-shot, tree-of-thought with examples | Verify LLM-enriched ingestion  |
| `embeddings-explained.txt`         | Text     | Word2Vec, GloVe, BERT embeddings, sentence transformers comparison   | Verify taxonomy classification |

---

## User Journeys (10 Journeys, 4 Phases)

### Phase 1: Setup & First Upload (No LLM)

#### Journey 1: Fresh Start — Create KB

**Goal**: Create a new knowledge base from scratch

| Step | Action                                                                              | Expected Result                                                      | Verify                 |
| ---- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------- |
| 1.1  | Navigate to https://agents-dev.kore.ai/                                             | Login page shows                                                     | Screenshot             |
| 1.2  | Login via Dev Login (or available auth)                                             | Lands on project dashboard                                           | Screenshot             |
| 1.3  | Navigate to SearchAI section                                                        | KB dashboard with existing KBs (if any)                              | Screenshot             |
| 1.4  | Click "Create" knowledge base                                                       | Create dialog opens                                                  | Screenshot             |
| 1.5  | Enter name "AI Research Library", description "Research documents for AI/ML topics" | Fields filled                                                        | -                      |
| 1.6  | Submit                                                                              | KB created, navigates to KB detail                                   | Screenshot + URL check |
| 1.7  | Verify SetupGuide state                                                             | Two cards: Upload Files + Connect Source. LLM warning banner visible | Screenshot             |
| 1.8  | Verify LLM warning message                                                          | Shows new message about pipeline dependencies                        | Read text              |

#### Journey 2: Upload Without LLM — Baseline

**Goal**: Upload research docs and observe processing WITHOUT LLM configured

| Step | Action                                           | Expected Result                                                | Verify              |
| ---- | ------------------------------------------------ | -------------------------------------------------------------- | ------------------- |
| 2.1  | On SetupGuide, drag-drop Batch 1 files (5 files) | FileUploadDialog opens with files listed                       | Screenshot          |
| 2.2  | Verify dialog stays open (A1/A2 fix)             | Dialog still visible, files shown, upload in progress or ready | Screenshot          |
| 2.3  | Upload completes                                 | Sources refresh, dialog closes                                 | Screenshot          |
| 2.4  | Verify transition to progress/operations         | Page shows processing status or operations dashboard           | Screenshot          |
| 2.5  | Wait for ingestion to complete                   | Documents listed in Data tab, chunks created                   | Data tab screenshot |
| 2.6  | Check document count                             | 5 documents shown                                              | Count check         |
| 2.7  | Check chunks                                     | Chunks created (basic splitting, no LLM summarization)         | Chunks tab          |
| 2.8  | Go to Intelligence tab                           | Shows LLM not configured state for most features               | Screenshot          |
| 2.9  | Check NeedsAttentionCard on Home tab             | "LLM not configured" warning present                           | Screenshot          |

#### Journey 3: Search Without LLM — Keyword Only

**Goal**: Test search quality with keyword matching only (no LLM reranking)

| Step | Action                                     | Expected Result                                                       | Verify                         |
| ---- | ------------------------------------------ | --------------------------------------------------------------------- | ------------------------------ |
| 3.1  | Go to Search tab                           | Query playground visible                                              | Screenshot                     |
| 3.2  | Search "how does attention mechanism work" | Results from transformer doc (keyword match on "attention mechanism") | Screenshot + results           |
| 3.3  | Search "compare vector databases"          | Results from comparison doc                                           | Screenshot + results           |
| 3.4  | Search "what is RAG"                       | Results from rag-patterns doc                                         | Screenshot + results           |
| 3.5  | Search "fine tuning llama"                 | May have poor/no results (semantic gap without LLM)                   | Screenshot — document baseline |
| 3.6  | Search "safety alignment"                  | Results from ai-safety doc                                            | Screenshot + results           |
| 3.7  | Note scores and rankings for each          | Record for later comparison                                           | Document in results            |

### Phase 2: Configure LLM & Re-Process

#### Journey 4: Configure LLM Models

**Goal**: Set up LLM for full pipeline activation

| Step | Action                                                                      | Expected Result                                        | Verify          |
| ---- | --------------------------------------------------------------------------- | ------------------------------------------------------ | --------------- |
| 4.1  | Go to Intelligence tab → LLM Models                                         | Settings view with query pipeline + ingestion sections | Screenshot      |
| 4.2  | Check available workspace models                                            | List of models (or "no models" state)                  | Screenshot      |
| 4.3  | If models available: enable auto-select for query pipeline                  | Model selected, status shows "active"                  | Screenshot      |
| 4.4  | Enable Core ingestion features: progressiveSummarization, questionSynthesis | Toggles on, model tier shown                           | Screenshot      |
| 4.5  | Enable Enrichment: knowledgeGraph, mapping_suggestion, vocabularyGeneration | Toggles on                                             | Screenshot      |
| 4.6  | Save/apply changes                                                          | LLM config saved                                       | Verify response |
| 4.7  | Return to Home tab                                                          | LLM warning gone from NeedsAttentionCard               | Screenshot      |
| 4.8  | Trigger rebuild/reindex (if needed)                                         | Processing starts for existing documents               | Progress state  |

#### Journey 5: Upload WITH LLM — Enhanced Processing

**Goal**: Upload Batch 3 files and verify LLM-enriched ingestion

| Step | Action                                  | Expected Result                                         | Verify                |
| ---- | --------------------------------------- | ------------------------------------------------------- | --------------------- |
| 5.1  | Go to Data tab → Upload files (Batch 3) | Upload dialog, 2 new files                              | Screenshot            |
| 5.2  | Upload completes                        | 7 total documents                                       | Count check           |
| 5.3  | Wait for LLM processing                 | Documents get summaries, questions generated            | Check document detail |
| 5.4  | Open a document detail                  | Should show: chunks WITH summaries, synthetic questions | Screenshot            |
| 5.5  | Compare chunk quality to pre-LLM chunks | LLM chunks should have summary field populated          | Side-by-side          |

#### Journey 6: Web Crawl Source

**Goal**: Add web content via crawler

| Step | Action                                    | Expected Result                  | Verify                |
| ---- | ----------------------------------------- | -------------------------------- | --------------------- |
| 6.1  | Go to Data tab → Add Source               | Source type picker shows         | Screenshot            |
| 6.2  | Select "Web Crawler"                      | Crawler config form              | Screenshot            |
| 6.3  | Enter URL from Batch 2                    | URL accepted                     | -                     |
| 6.4  | Configure crawl depth (1-2)               | Settings applied                 | -                     |
| 6.5  | Start crawl                               | Crawl job begins, progress shown | Screenshot            |
| 6.6  | Wait for crawl completion                 | Pages crawled, documents created | Data tab count update |
| 6.7  | Verify crawled documents in document list | New documents from web source    | Screenshot            |

### Phase 3: Intelligence Features

#### Journey 7: Field Mappings & Taxonomy

**Goal**: Review auto-detected fields and taxonomy generated by LLM

| Step | Action                               | Expected Result                                         | Verify     |
| ---- | ------------------------------------ | ------------------------------------------------------- | ---------- |
| 7.1  | Go to Intelligence → Fields          | FieldsTab with My Fields, Suggested, Unmapped sections  | Screenshot |
| 7.2  | Review suggested mappings            | LLM-generated field mapping suggestions with confidence | Screenshot |
| 7.3  | Confirm 2-3 suggested mappings       | Mapping confirmed, field appears in My Fields           | Screenshot |
| 7.4  | Reject 1 suggestion                  | Suggestion removed                                      | Screenshot |
| 7.5  | Go to Intelligence → Knowledge Graph | KG state (enabled or enable card)                       | Screenshot |
| 7.6  | If not enabled: enable KG            | Enable toggle, taxonomy setup option appears            | Screenshot |
| 7.7  | Setup taxonomy (if available)        | Taxonomy generation starts                              | Screenshot |
| 7.8  | Wait for taxonomy                    | Categories and products generated from documents        | Screenshot |
| 7.9  | Go to Intelligence → Vocabulary      | Vocabulary entries (auto-generated or empty)            | Screenshot |
| 7.10 | Review vocabulary terms              | Terms with aliases, descriptions (if LLM enriched)      | Screenshot |

### Phase 4: Search & Browse — Quality Comparison

#### Journey 8: Search WITH LLM — Enhanced

**Goal**: Re-run same searches and compare quality

| Step | Action                                     | Expected Result                                      | Verify                             |
| ---- | ------------------------------------------ | ---------------------------------------------------- | ---------------------------------- |
| 8.1  | Go to Search tab                           | Query playground                                     | -                                  |
| 8.2  | Search "how does attention mechanism work" | Better results (LLM reranking, question matching)    | Compare with J3.2                  |
| 8.3  | Search "compare vector databases"          | Structured results with better ranking               | Compare with J3.3                  |
| 8.4  | Search "what is RAG"                       | Richer results (summary-augmented)                   | Compare with J3.4                  |
| 8.5  | Search "fine tuning llama"                 | Should now find results (semantic match via LLM)     | Compare with J3.5 — KEY COMPARISON |
| 8.6  | Search "safety alignment"                  | Better ranked results                                | Compare with J3.6                  |
| 8.7  | Enable debug mode                          | See 7-stage pipeline resolution chain                | Screenshot                         |
| 8.8  | Search with debug                          | Vocabulary resolution, alias mapping, rerank visible | Screenshot of debug stages         |
| 8.9  | Try vocabulary resolution                  | Resolve "vector DB" → should map to vector databases | Screenshot                         |
| 8.10 | Compare query history                      | Side-by-side old vs new results                      | Screenshot                         |

#### Journey 9: Browse SDK Preview

**Goal**: Test the browse experience we just fixed (Sprint 8 bugs)

| Step | Action                                              | Expected Result                                                  | Verify               |
| ---- | --------------------------------------------------- | ---------------------------------------------------------------- | -------------------- |
| 9.1  | Navigate to Browse Preview page                     | Full browse layout (or empty taxonomy state if no taxonomy)      | Screenshot           |
| 9.2  | If taxonomy exists: verify category tree in sidebar | Categories with document counts                                  | Screenshot           |
| 9.3  | Click a category                                    | Facets load with spinner (C2 fix), checkboxes appear             | Screenshot           |
| 9.4  | Check a facet value                                 | Documents filtered (AND/OR logic from B3 fix)                    | Screenshot           |
| 9.5  | Check a second facet from different attribute       | Fewer docs (AND intersection)                                    | Screenshot           |
| 9.6  | Uncheck second facet                                | Back to single facet filter                                      | Verify count changes |
| 9.7  | Change sort to "Newest first"                       | Order changes (B1 fix)                                           | Screenshot           |
| 9.8  | Click page 2 (if enough docs)                       | Different documents shown (B2 fix)                               | Screenshot           |
| 9.9  | Type in search bar — verify no auto-fire            | No search happens while typing (B5 fix)                          | Observe              |
| 9.10 | Press Enter to search                               | Search results appear                                            | Screenshot           |
| 9.11 | Click X to clear search                             | State fully cleared (C3 fix)                                     | Verify empty         |
| 9.12 | Click category → deselect same category             | Facets cleared (C4 fix)                                          | Verify sidebar empty |
| 9.13 | If no taxonomy: verify EmptyState                   | "No taxonomy data yet" + "Go to Intelligence" button (D1/D2 fix) | Screenshot           |

#### Journey 10: Edge Cases & Error States

**Goal**: Test error handling, empty states, boundary conditions

| Step | Action                                          | Expected Result                                   | Verify           |
| ---- | ----------------------------------------------- | ------------------------------------------------- | ---------------- |
| 10.1 | Create a SECOND empty KB "Empty Test KB"        | SetupGuide with no sources                        | Screenshot       |
| 10.2 | Go to Search tab on empty KB                    | Empty state / "no data" message                   | Screenshot       |
| 10.3 | Go to Data tab on empty KB                      | Empty document list                               | Screenshot       |
| 10.4 | Go to Browse on empty KB                        | Empty taxonomy state                              | Screenshot       |
| 10.5 | Try uploading a 0-byte file                     | Error handling — should reject                    | Observe behavior |
| 10.6 | Try searching with very long query (500+ chars) | Graceful handling                                 | Observe          |
| 10.7 | Go back to "AI Research Library"                | All data intact, no state corruption              | Verify counts    |
| 10.8 | Delete "Empty Test KB"                          | Confirm dialog → deleted → removed from dashboard | Screenshot       |

---

## Quick Health Dashboard

| Area                       | Status | Last Verified | Notes                      |
| -------------------------- | ------ | ------------- | -------------------------- |
| KB Creation                | —      | Not tested    |                            |
| File Upload (no LLM)       | —      | Not tested    |                            |
| Search (no LLM)            | —      | Not tested    |                            |
| LLM Configuration          | —      | Not tested    |                            |
| File Upload (with LLM)     | —      | Not tested    |                            |
| Web Crawl                  | —      | Not tested    |                            |
| Field Mappings             | —      | Not tested    |                            |
| Knowledge Graph / Taxonomy | —      | Not tested    |                            |
| Vocabulary                 | —      | Not tested    |                            |
| Search (with LLM)          | —      | Not tested    |                            |
| Browse SDK                 | —      | Not tested    | Sprint 8 bugs specifically |
| Error States               | —      | Not tested    |                            |
| LLM Warning Message        | —      | Not tested    | Updated copy               |

---

## Execution Strategy

### Parallelism Plan

```
Phase 1 (Journeys 1-3):     Sequential — must create KB first
Phase 2 (Journeys 4-6):     J4 first, then J5 + J6 can overlap
Phase 3 (Journey 7):         Sequential — depends on LLM processing
Phase 4 (Journeys 8-10):    J8 + J9 + J10 can run in parallel
```

### Review Checkpoints

- **After Phase 1**: Review agent verifies baseline screenshots + search results documented
- **After Phase 2**: Review agent verifies LLM config took effect + processing completed
- **After Phase 4**: Review agent compares WITH vs WITHOUT LLM results, validates Sprint 8 fixes

### Test Data Creation

Before starting Phase 1, create all sample files in `/tmp/searchai-test-data/`.

---

## Iteration Log

### Iteration 1 — 2026-03-22

**Scope**: Full 10-journey flow, first pass
**Branch**: develop
**Tested by**: Claude Code (agent)

#### Results

_To be filled during execution_

---

## Test Environment

- URL: https://agents-dev.kore.ai/
- Auth: Dev Login (or as available)
- Test KB: "AI Research Library" (created during testing)
- Test files: `/tmp/searchai-test-data/`

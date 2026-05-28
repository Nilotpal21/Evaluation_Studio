# SearchAI UI Test Scenarios — Tab-by-Tab Detailed Checks

**Target**: https://agents-dev.kore.ai/
**Purpose**: Capture every UI issue across all tabs before fixing anything
**Mode**: OBSERVE AND DOCUMENT ONLY — no fixes during this pass
**Branch**: develop
**Date**: 2026-03-22

---

## Test Protocol

For every scenario:

1. Take screenshot
2. Check for console errors (`console_messages`)
3. Document: PASS / FAIL / PARTIAL with exact description
4. If FAIL: note what's wrong, expected vs actual, screenshot reference
5. **DO NOT FIX** — capture only

---

## 0. Authentication & Navigation

### 0.1 Login Flow

| #     | Scenario                                 | Check                                             | Status |
| ----- | ---------------------------------------- | ------------------------------------------------- | ------ |
| 0.1.1 | Navigate to https://agents-dev.kore.ai/  | Login page renders with logo, title, auth options |        |
| 0.1.2 | "Dev Login" button visible and clickable | Button exists, not disabled                       |        |
| 0.1.3 | Click Dev Login → authenticate           | Redirects to dashboard, no errors                 |        |
| 0.1.4 | Check console for errors on login page   | Zero JS errors                                    |        |
| 0.1.5 | Check console for errors after login     | Zero JS errors                                    |        |

### 0.2 Project Navigation

| #     | Scenario                                 | Check                                     | Status |
| ----- | ---------------------------------------- | ----------------------------------------- | ------ |
| 0.2.1 | Project dashboard loads                  | Projects listed, layout correct           |        |
| 0.2.2 | Navigate to SearchAI section             | KB dashboard visible                      |        |
| 0.2.3 | KB dashboard shows existing KBs (if any) | Cards render with name, doc count, status |        |
| 0.2.4 | Metric cards on KB dashboard             | Total KBs, total docs, etc. rendered      |        |
| 0.2.5 | Search/filter on KB dashboard            | Works, results update                     |        |

---

## 1. KB Creation Dialog

| #   | Scenario                                | Check                                | Status |
| --- | --------------------------------------- | ------------------------------------ | ------ |
| 1.1 | "Create" button on KB dashboard         | Opens dialog                         |        |
| 1.2 | Dialog has Name field (required)        | Text input, placeholder text         |        |
| 1.3 | Dialog has Description field (optional) | Textarea                             |        |
| 1.4 | Submit with empty name                  | Validation error shown               |        |
| 1.5 | Submit with valid name                  | Creates KB, navigates to detail page |        |
| 1.6 | New KB lands on Home tab                | SetupGuide visible (fresh KB)        |        |
| 1.7 | Console errors during creation          | Zero errors                          |        |

---

## 2. Home Tab — SetupGuide State (0 sources, 0 documents)

| #    | Scenario                                    | Check                                             | Status |
| ---- | ------------------------------------------- | ------------------------------------------------- | ------ |
| 2.1  | Header card with KB name                    | "Get started with [name]" text                    |        |
| 2.2  | Upload Files card                           | Title, description, drag-drop zone visible        |        |
| 2.3  | Connect Source card                         | Title, description, "Connect a source" button     |        |
| 2.4  | Auto-pipeline explainer card                | 3 steps listed (schema, processing, search)       |        |
| 2.5  | LLM warning banner                          | Shows updated message about pipeline dependencies |        |
| 2.6  | LLM warning "Configure LLM" button          | Navigates to Intelligence → LLM Models            |        |
| 2.7  | Drop zone hover state                       | Visual feedback on drag-over                      |        |
| 2.8  | Drop files → FileUploadDialog opens         | Dialog appears with files listed                  |        |
| 2.9  | Dialog stays open during upload (A1/A2 fix) | No premature close                                |        |
| 2.10 | Upload progress per file                    | Progress bar/status per file                      |        |
| 2.11 | Cancel upload                               | Works, dialog stays open for remaining            |        |
| 2.12 | Upload complete → dialog closes             | Sources refresh after close                       |        |
| 2.13 | Default source name                         | Shows "Default" not "Uploaded Files" (A4 fix)     |        |
| 2.14 | Connect Source button                       | Navigates to Data tab with auto-open              |        |
| 2.15 | Console errors throughout                   | Zero errors                                       |        |

---

## 3. Home Tab — WaitingForContent State (sources exist, 0 documents)

| #   | Scenario                                              | Check                                  | Status |
| --- | ----------------------------------------------------- | -------------------------------------- | ------ |
| 3.1 | Title shows "Sources connected — waiting for content" | Correct text                           |        |
| 3.2 | Source table renders                                  | Columns: Name, Type, Status, Documents |        |
| 3.3 | Source status shows correctly                         | pending/active/syncing                 |        |
| 3.4 | "Upload files" action button                          | Opens file upload                      |        |
| 3.5 | "Add another source" action button                    | Opens add source dialog                |        |
| 3.6 | Console errors                                        | Zero errors                            |        |

---

## 4. Home Tab — ProgressView State (processing in progress)

| #   | Scenario                     | Check                                  | Status |
| --- | ---------------------------- | -------------------------------------- | ------ |
| 4.1 | Progress indicator visible   | Spinner or progress bar                |        |
| 4.2 | Status label                 | "Processing documents..." or similar   |        |
| 4.3 | Document/chunk counts update | Numbers increment during processing    |        |
| 4.4 | Auto-update hint             | "This page will update automatically"  |        |
| 4.5 | Error state (if applicable)  | Error details + links to data/pipeline |        |
| 4.6 | Console errors               | Zero errors                            |        |

---

## 5. Home Tab — OperationsDashboard State (documents exist, normal)

| #    | Scenario                                   | Check                                      | Status |
| ---- | ------------------------------------------ | ------------------------------------------ | ------ |
| 5.1  | 4 stat cards render                        | Documents, Chunks, Sources, Last Indexed   |        |
| 5.2  | Stat card values are correct               | Match actual counts                        |        |
| 5.3  | NeedsAttentionCard                         | Shows relevant warnings (or "all healthy") |        |
| 5.4  | LLM not configured warning (if applicable) | Updated message text                       |        |
| 5.5  | Source sync errors (if applicable)         | Count and link to Data tab                 |        |
| 5.6  | Activity feed renders                      | Recent activity items with timestamps      |        |
| 5.7  | Activity feed "Load more"                  | Loads additional items                     |        |
| 5.8  | Document status summary                    | pie/bar showing indexed/errored/processing |        |
| 5.9  | Click stat card links                      | Navigate to correct section                |        |
| 5.10 | Console errors                             | Zero errors                                |        |

---

## 6. Data Tab — Documents View

| #    | Scenario                                       | Check                                     | Status |
| ---- | ---------------------------------------------- | ----------------------------------------- | ------ |
| 6.1  | SegmentedControl: Documents / Chunks / Sources | Three options, Documents default selected |        |
| 6.2  | Document table renders                         | Columns visible, data loaded              |        |
| 6.3  | Document table pagination                      | Page controls work, correct page sizes    |        |
| 6.4  | Source filter bar                              | Dropdown filters by source                |        |
| 6.5  | Status filter badges                           | Filter by status (indexed, error, etc.)   |        |
| 6.6  | Text search (debounced)                        | Search filters document list              |        |
| 6.7  | Document row shows correct info                | Name, source, status, date, chunk count   |        |
| 6.8  | Click document → detail view                   | Document detail opens with metadata       |        |
| 6.9  | Document detail: chunks list                   | Chunks shown with content preview         |        |
| 6.10 | Document detail: metadata JSON                 | Metadata displayed correctly              |        |
| 6.11 | Delete document                                | Confirm dialog → removed from list        |        |
| 6.12 | Bulk actions (retry, delete)                   | Checkbox selection + bulk action buttons  |        |
| 6.13 | Empty state (no documents)                     | Helpful message + upload CTA              |        |
| 6.14 | Console errors                                 | Zero errors                               |        |

---

## 7. Data Tab — Chunks View

| #   | Scenario              | Check                                     | Status |
| --- | --------------------- | ----------------------------------------- | ------ |
| 7.1 | Switch to Chunks view | Chunk table renders                       |        |
| 7.2 | Chunk table columns   | Content preview, document, status, tokens |        |
| 7.3 | Chunk content preview | Truncated text, expandable                |        |
| 7.4 | Pagination            | Works correctly                           |        |
| 7.5 | Console errors        | Zero errors                               |        |

---

## 8. Data Tab — Sources View

| #    | Scenario                       | Check                                  | Status |
| ---- | ------------------------------ | -------------------------------------- | ------ |
| 8.1  | Switch to Sources view         | Source table renders                   |        |
| 8.2  | Source list shows all sources  | Name, type, status, doc count          |        |
| 8.3  | Add Source button              | Opens source type picker               |        |
| 8.4  | Source type picker: 5 types    | File, Web, Database, API, Enterprise   |        |
| 8.5  | File source creation flow      | Config form → create → upload dialog   |        |
| 8.6  | Web Crawler source creation    | URL input, depth config, crawl options |        |
| 8.7  | Database source creation       | Connection string, collection, query   |        |
| 8.8  | API source creation            | URL, method, auth type config          |        |
| 8.9  | Enterprise (SharePoint) source | 5-step wizard opens                    |        |
| 8.10 | Delete source                  | Confirm dialog → removed               |        |
| 8.11 | Source detail panel            | Click source → detail slide-out        |        |
| 8.12 | Upload to existing source      | Upload button on source row            |        |
| 8.13 | Console errors                 | Zero errors                            |        |

---

## 9. Intelligence Tab — Hub View

| #   | Scenario                                       | Check                                     | Status |
| --- | ---------------------------------------------- | ----------------------------------------- | ------ |
| 9.1 | Intelligence hub loads                         | 5 cards visible                           |        |
| 9.2 | Pipeline card                                  | Status indicator, "Configure" action      |        |
| 9.3 | Fields card                                    | Count of mapped/unmapped, "Review" action |        |
| 9.4 | Vocabulary card                                | Entry count, "Manage" action              |        |
| 9.5 | Knowledge Graph card                           | Enable state + review queue badge         |        |
| 9.6 | LLM Models card                                | Config status, "Configure" action         |        |
| 9.7 | Each card clickable → navigates to sub-section | Correct routing                           |        |
| 9.8 | Console errors                                 | Zero errors                               |        |

---

## 10. Intelligence Tab — Pipeline Editor

| #     | Scenario                        | Check                               | Status |
| ----- | ------------------------------- | ----------------------------------- | ------ |
| 10.1  | Pipeline editor loads           | Sidebar (25%) + detail (75%) layout |        |
| 10.2  | Flows sidebar lists flows       | Flow names with status icons        |        |
| 10.3  | Click flow → detail view        | Stages rendered                     |        |
| 10.4  | Pipeline canvas renders         | Visual representation of stages     |        |
| 10.5  | Click stage → config slide-over | Stage settings form                 |        |
| 10.6  | Embedding config section        | Model selection, dimension display  |        |
| 10.7  | Save pipeline (Ctrl+S)          | Saves, shows success                |        |
| 10.8  | Test selection modal            | Select documents for pipeline test  |        |
| 10.9  | Reindex confirm dialog          | Shows before rebuild                |        |
| 10.10 | Console errors                  | Zero errors                         |        |

---

## 11. Intelligence Tab — Fields (FieldsTab)

| #     | Scenario                    | Check                                           | Status |
| ----- | --------------------------- | ----------------------------------------------- | ------ |
| 11.1  | FieldsTab loads             | 3 sections visible                              |        |
| 11.2  | My Fields section           | Mapped canonical fields with expandable sources |        |
| 11.3  | Suggested Mappings section  | LLM suggestions with confidence %               |        |
| 11.4  | Unmapped Fields section     | Fields without mappings                         |        |
| 11.5  | Confirm a suggested mapping | Moves to My Fields                              |        |
| 11.6  | Reject a suggested mapping  | Removed from suggestions                        |        |
| 11.7  | Edit a mapping              | Edit form opens, save works                     |        |
| 11.8  | Delete a mapping            | Confirm → removed                               |        |
| 11.9  | Create manual mapping       | Form → created                                  |        |
| 11.10 | Bulk actions                | Select multiple, confirm/reject bulk            |        |
| 11.11 | Empty state (no fields)     | Guidance message                                |        |
| 11.12 | Console errors              | Zero errors                                     |        |

---

## 12. Intelligence Tab — Vocabulary

| #     | Scenario                                    | Check                            | Status |
| ----- | ------------------------------------------- | -------------------------------- | ------ |
| 12.1  | Vocabulary tab loads                        | List of entries or empty state   |        |
| 12.2  | Entry list: term, aliases, fieldRef, status | Columns rendered                 |        |
| 12.3  | Pagination works                            | Navigate pages                   |        |
| 12.4  | Search/filter by text                       | Filters entries                  |        |
| 12.5  | Filter by status (active/inactive)          | Works correctly                  |        |
| 12.6  | Filter by generatedBy (auto/manual)         | Works correctly                  |        |
| 12.7  | Toggle entry enable/disable                 | Switch works, status updates     |        |
| 12.8  | Create vocabulary entry                     | Form → created                   |        |
| 12.9  | Edit vocabulary entry                       | Form → saved                     |        |
| 12.10 | Delete vocabulary entry                     | Confirm → removed                |        |
| 12.11 | Test vocabulary resolution                  | Input query → see resolved terms |        |
| 12.12 | Console errors                              | Zero errors                      |        |

---

## 13. Intelligence Tab — Knowledge Graph

| #     | Scenario                                    | Check                                    | Status |
| ----- | ------------------------------------------- | ---------------------------------------- | ------ |
| 13.1  | KG state 1: Not enabled                     | Enable card visible, no model configured |        |
| 13.2  | KG configuration wizard                     | Model selection flow                     |        |
| 13.3  | Enable KG toggle                            | Toggle on → state changes                |        |
| 13.4  | KG state 2: Enabled, no taxonomy            | Taxonomy setup card                      |        |
| 13.5  | Domain selection grid                       | Pre-built domains visible                |        |
| 13.6  | Custom domain generation                    | LLM generates domain                     |        |
| 13.7  | Org profile generation (URL/name/paragraph) | Profile generated                        |        |
| 13.8  | Taxonomy setup trigger                      | Setup starts, progress shown             |        |
| 13.9  | Taxonomy setup polling                      | Status updates automatically             |        |
| 13.10 | KG state 3: Taxonomy exists                 | Summary + 3 view tabs                    |        |
| 13.11 | Graph view tab                              | Graph visualization renders              |        |
| 13.12 | Statistics view tab                         | Stats cards render                       |        |
| 13.13 | Attributes view tab                         | Attribute manager with tiers             |        |
| 13.14 | Attribute review queue                      | Novel attributes needing review          |        |
| 13.15 | Approve/discard attribute                   | Action works                             |        |
| 13.16 | Merge attributes                            | Merge flow works                         |        |
| 13.17 | Enrichment trigger button                   | "Run Enrichment" starts job              |        |
| 13.18 | Enrichment progress                         | Status updates                           |        |
| 13.19 | Delete taxonomy                             | Confirm → deleted, back to state 2       |        |
| 13.20 | Console errors                              | Zero errors                              |        |

---

## 14. Intelligence Tab — LLM Models (SettingsTab)

| #     | Scenario                         | Check                                                  | Status |
| ----- | -------------------------------- | ------------------------------------------------------ | ------ |
| 14.1  | LLM settings loads               | Two sections: Query Pipeline + Ingestion               |        |
| 14.2  | Query Pipeline: available models | List or "no models" state                              |        |
| 14.3  | Auto-select toggle               | Works, shows selected model                            |        |
| 14.4  | Preferred tier selection         | Dropdown works                                         |        |
| 14.5  | Model selector dialog            | Opens, shows model list                                |        |
| 14.6  | Pin a model                      | Selected, shown as pinned                              |        |
| 14.7  | Ingestion: Core features         | progressiveSummarization, questionSynthesis toggles    |        |
| 14.8  | Ingestion: Enrichment features   | knowledgeGraph, mapping_suggestion, vocabulary toggles |        |
| 14.9  | Ingestion: Advanced features     | vision, multimodal toggles                             |        |
| 14.10 | Per-use-case model tier          | Tier dropdown per feature                              |        |
| 14.11 | Status indicators                | active/pending/fallback per use case                   |        |
| 14.12 | Save changes                     | Apply works, no errors                                 |        |
| 14.13 | Link to admin models             | Opens /admin/models                                    |        |
| 14.14 | Console errors                   | Zero errors                                            |        |

---

## 15. Search Tab — Query Playground

| #     | Scenario                        | Check                                      | Status |
| ----- | ------------------------------- | ------------------------------------------ | ------ |
| 15.1  | Search tab loads                | Two-column layout: playground + diagnostic |        |
| 15.2  | Query input field               | Text input with Enter-to-search            |        |
| 15.3  | Query type selector             | hybrid, vector, structured options         |        |
| 15.4  | Top-K parameter                 | Input, default value shown                 |        |
| 15.5  | Vocabulary mode selector        | exact, alias, fuzzy                        |        |
| 15.6  | Debug toggle                    | Checkbox/switch                            |        |
| 15.7  | Search button                   | Triggers search                            |        |
| 15.8  | Execute search → results render | Result cards with scores                   |        |
| 15.9  | Result card: score badge        | Visible, numeric                           |        |
| 15.10 | Result card: content preview    | Text content shown                         |        |
| 15.11 | Result card: metadata viewer    | JSON expandable                            |        |
| 15.12 | Result card: source reference   | Source name + link                         |        |
| 15.13 | Empty results state             | "No matches found" message                 |        |
| 15.14 | "No data" state (empty KB)      | Different from no matches                  |        |
| 15.15 | LLM not configured state        | Warning about limited search               |        |
| 15.16 | Latency breakdown bar           | Segments for vocab, search, rerank         |        |
| 15.17 | Debug mode: pipeline stages     | 7 stages with timings                      |        |
| 15.18 | Debug: vocabulary trace         | Resolved terms visualization               |        |
| 15.19 | Debug: stage detail cards       | Expandable per stage                       |        |
| 15.20 | Debug: score breakdown          | Per-result scoring detail                  |        |
| 15.21 | "Resolve Vocabulary" button     | Calls resolve endpoint, shows result       |        |
| 15.22 | "Copy API Call" button          | Copies to clipboard                        |        |
| 15.23 | "Copy cURL" button              | Copies curl command                        |        |
| 15.24 | Query Diagnostic Card (right)   | Renders diagnostic info                    |        |
| 15.25 | Query history section           | Past queries listed                        |        |
| 15.26 | Select 2 queries → compare      | Side-by-side comparison                    |        |
| 15.27 | Console errors                  | Zero errors                                |        |

---

## 16. Browse Preview Page

| #     | Scenario                               | Check                                              | Status |
| ----- | -------------------------------------- | -------------------------------------------------- | ------ |
| 16.1  | Navigate to browse preview             | Full page loads                                    |        |
| 16.2  | Header: KB name + doc count            | Correct values                                     |        |
| 16.3  | Header: search bar                     | Input visible, placeholder text                    |        |
| 16.4  | Header: category pills                 | Categories from taxonomy (if any)                  |        |
| 16.5  | Header: beta toggle                    | Show/hide beta attributes                          |        |
| 16.6  | Sidebar: taxonomy tree                 | Categories with chevrons, doc counts               |        |
| 16.7  | Sidebar: expand/collapse categories    | Chevron rotates, children show                     |        |
| 16.8  | Click category → facets load           | Spinner (C2) → checkboxes appear                   |        |
| 16.9  | Facet checkboxes with counts           | Attribute values with count badges                 |        |
| 16.10 | Check facet → documents load           | Spinner → document cards appear                    |        |
| 16.11 | Multi-facet AND logic (B3)             | Two attributes → intersection                      |        |
| 16.12 | Same-attribute OR logic (B3)           | Two values same attr → union                       |        |
| 16.13 | Category switch clears facets (C4)     | Old facets gone, new load                          |        |
| 16.14 | Deselect category → clears all         | Facets + active selections gone                    |        |
| 16.15 | Sort: relevance (default)              | API order preserved                                |        |
| 16.16 | Sort: newest first (B1)                | Date-sorted correctly                              |        |
| 16.17 | Sort: oldest first (B1)                | Reverse date sort                                  |        |
| 16.18 | Sort: title A-Z (B1)                   | Alphabetical                                       |        |
| 16.19 | Pagination: page 2 (B2)                | Different 12 docs                                  |        |
| 16.20 | Pagination hidden when ≤12 docs        | No pagination controls                             |        |
| 16.21 | Search: typing does NOT auto-fire (B5) | No search on keystroke                             |        |
| 16.22 | Search: Enter fires search             | Results appear                                     |        |
| 16.23 | Search: suggestion click fires search  | Single search fires                                |        |
| 16.24 | Search: clear (X) resets state (C3)    | Empty results, no stale data                       |        |
| 16.25 | Loading: facets spinner                | Loader2 below "Filters" heading                    |        |
| 16.26 | Loading: results spinner               | Centered Loader2 in grid area                      |        |
| 16.27 | Loading: divider visible during load   | Border line above Filters                          |        |
| 16.28 | Document card: title, summary, source  | All fields render                                  |        |
| 16.29 | Document card: click opens source URL  | New tab opens (if URL exists)                      |        |
| 16.30 | Empty taxonomy → EmptyState (D1/D2)    | "No taxonomy data yet" + CTA                       |        |
| 16.31 | EmptyState "Go to Intelligence" button | Navigates correctly                                |        |
| 16.32 | Taxonomy error → NOT empty state       | Main layout renders, sidebar shows "No categories" |        |
| 16.33 | Console errors throughout              | Zero errors                                        |        |

---

## 17. Settings Panel (Slide-Out)

| #    | Scenario                            | Check                                     | Status |
| ---- | ----------------------------------- | ----------------------------------------- | ------ |
| 17.1 | Open settings from gear icon        | Panel slides out                          |        |
| 17.2 | General section: name + description | Editable fields                           |        |
| 17.3 | General: read-only fields           | Status, searchIndexId, createdAt          |        |
| 17.4 | Edit name → save                    | Name updates in header                    |        |
| 17.5 | Index Config section                | Embedding model, dimensions, vector store |        |
| 17.6 | Danger Zone: rebuild index          | Button state (disabled/enabled)           |        |
| 17.7 | Danger Zone: delete KB              | Confirm dialog → deletes                  |        |
| 17.8 | Close panel                         | X or click outside                        |        |
| 17.9 | Console errors                      | Zero errors                               |        |

---

## 18. Web Crawler Features

| #    | Scenario                   | Check                                             | Status |
| ---- | -------------------------- | ------------------------------------------------- | ------ |
| 18.1 | Add web crawler source     | URL input, crawl options                          |        |
| 18.2 | Intelligent crawl analysis | 4-phase progress (map, understand, build, replay) |        |
| 18.3 | Manual crawl job           | Config form, start crawl                          |        |
| 18.4 | Crawl progress tracking    | Job progress updates                              |        |
| 18.5 | Crawl history              | Past jobs listed                                  |        |
| 18.6 | Crawled pages view         | Pages listed with content                         |        |
| 18.7 | Crawl preferences          | Settings persist                                  |        |
| 18.8 | Console errors             | Zero errors                                       |        |

---

## 19. Cross-Cutting Checks

| #     | Scenario                                             | Check                                                | Status |
| ----- | ---------------------------------------------------- | ---------------------------------------------------- | ------ |
| 19.1  | Tab navigation (Home ↔ Data ↔ Intelligence ↔ Search) | Smooth transitions, no flash                         |        |
| 19.2  | Browser back/forward                                 | Correct tab restores                                 |        |
| 19.3  | Direct URL to specific tab                           | Works (deep linking)                                 |        |
| 19.4  | Responsive layout at different widths                | No overflow, no truncation bugs                      |        |
| 19.5  | Loading states on slow network                       | Skeletons/spinners, no blank screens                 |        |
| 19.6  | Error recovery: API failure                          | Error messages, retry options                        |        |
| 19.7  | Multiple KB navigation                               | Switch KBs, data doesn't bleed                       |        |
| 19.8  | i18n: no raw keys visible                            | All text translated, no `search_ai.xxx` keys showing |        |
| 19.9  | Dark mode / theme consistency                        | If supported, renders correctly                      |        |
| 19.10 | Accessibility: keyboard navigation                   | Tab through interactive elements                     |        |

---

## Execution Plan

### Pass 1: Tab Walkthrough (capture issues)

Navigate every tab on an EXISTING KB with data, screenshotting each state.

- Estimated: 30-40 screenshots
- Focus: rendering, layout, data display

### Pass 2: Interaction Testing (capture issues)

Test all interactive elements (buttons, forms, toggles, search).

- Focus: state changes, loading, error handling

### Pass 3: Fresh KB Journey (capture issues)

Create new KB, upload files, watch state transitions.

- Focus: SetupGuide → WaitingForContent → Progress → Operations

### Pass 4: Search Quality (capture issues)

Run searches with/without LLM, compare results.

- Focus: search results, debug info, vocabulary resolution

### Pass 5: Browse SDK (capture issues)

Test all Sprint 8 bug fix areas specifically.

- Focus: facets, sort, pagination, loading, empty states

After ALL passes: compile issue list with severity, then fix in priority order.

---

## Issue Tracker

Issues found during testing — DO NOT FIX during capture pass.

| #     | Severity | Tab/Area              | Summary                                                                                                                                              | Status |
| ----- | -------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| UI-1  | HIGH     | Header counters       | Stale document/chunk/source counts                                                                                                                   | OPEN   |
| UI-2  | HIGH     | PDF ingestion         | Docling extraction fails on abl-dev                                                                                                                  | OPEN   |
| UI-3  | MEDIUM   | Data > Source column  | Documents show "—" instead of source name                                                                                                            | OPEN   |
| UI-4  | LOW      | Header Sources        | Counter stale until reload                                                                                                                           | OPEN   |
| UI-5  | MEDIUM   | Doc detail > Error    | No error message or retry on failed docs                                                                                                             | OPEN   |
| UI-6  | LOW      | Doc detail > Label    | "Crawled" label on uploaded files                                                                                                                    | OPEN   |
| UI-7  | LOW      | Breadcrumb            | Raw ID instead of KB name                                                                                                                            | OPEN   |
| UI-8  | HIGH     | Search                | Backend 500 on all queries                                                                                                                           | OPEN   |
| UI-9  | MEDIUM   | Search > Error UX     | "Request failed" with no details                                                                                                                     | OPEN   |
| UI-10 | LOW      | Diagnostics           | Documents: 0 (stale counter)                                                                                                                         | OPEN   |
| UI-11 | MEDIUM   | LLM warning           | "Not configured" but 6/10 active via fallback                                                                                                        | OPEN   |
| UI-12 | MEDIUM   | Query Pipeline LLM    | "Failed to load query LLM status"                                                                                                                    | OPEN   |
| UI-13 | HIGH     | Browse Preview        | Empty taxonomy shows wrong empty state message                                                                                                       | OPEN   |
| UI-14 | HIGH     | Data > Chunks         | All chunks show "Untitled" in Document column                                                                                                        | OPEN   |
| UI-15 | LOW      | Deep-linking          | URL `?tab=chunks` doesn't activate Chunks tab                                                                                                        | OPEN   |
| UI-16 | LOW      | Settings panel        | Panel title "LLM Features" should be "KB Settings"                                                                                                   | OPEN   |
| UI-17 | LOW      | Intelligence > Fields | "All suggestions reviewed" misleading on empty new KB                                                                                                | OPEN   |
| UI-18 | MEDIUM   | Intelligence > KG     | "Configure & Continue" hidden below fold when model already selected                                                                                 | OPEN   |
| UI-19 | LOW      | Intelligence > LLM    | Duplicate description text rendered twice in each feature card                                                                                       | OPEN   |
| UI-20 | CRITICAL | Home tab              | Shows "waiting for content" despite 5 chunks indexed; state never advances                                                                           | OPEN   |
| UI-21 | HIGH     | Backend API           | `GET /query-llm-status` returns 401 (auth error, not config error)                                                                                   | OPEN   |
| UI-22 | MEDIUM   | Backend API           | `GET /schemas/{indexId}` returns 404 — canonical schema not auto-created                                                                             | OPEN   |
| UI-23 | LOW      | Backend API           | `GET /kg-taxonomy` called 3× redundantly on each KG tab visit                                                                                        | OPEN   |
| UI-24 | MEDIUM   | Navigation            | Raw UUID shown in breadcrumb before project context resolves on direct URL load                                                                      | OPEN   |
| UI-25 | LOW      | Navigation            | "Llm Models" wrong breadcrumb casing — should be "LLM Models"                                                                                        | OPEN   |
| UI-26 | LOW      | Data > Sources        | "1 sources" grammatical error in Sources summary line                                                                                                | OPEN   |
| UI-27 | MEDIUM   | Navigation            | Browse Preview opens in new tab with no back-to-KB button                                                                                            | OPEN   |
| UI-28 | LOW      | Data > Chunks         | All chunks show "#: 0" — chunk sequence number is always 0                                                                                           | OPEN   |
| UI-29 | LOW      | Data > Chunks         | "(page counts)" text in Chunks summary line is cryptic/unexplained                                                                                   | OPEN   |
| UI-30 | MEDIUM   | Intelligence > LLM    | Feature names shown as raw camelCase/snake_case identifiers (`progressiveSummarization`, `mapping_suggestion`) instead of display labels             | OPEN   |
| UI-31 | MEDIUM   | Global                | No tooltips on technical parameters — "Top K", "Similarity threshold", "Dimensions", "Resolve Mode: Alias", "Tier: Fast" exposed with no explanation | OPEN   |
| UI-32 | LOW      | KB Header             | KB names with underscores (e.g. `AI_Research_Library`) displayed as-is in headings — underscores not stripped                                        | OPEN   |
| UI-33 | HIGH     | File Upload Dialog    | Source dropdown shows "Select a source..." — not auto-selected to "Default" despite dialog subtitle naming the source                                | OPEN   |
| UI-34 | CRITICAL | File Upload Dialog    | Closing upload dialog without uploading leaves document in persistent "pending" ghost state — stuck forever, no discard/cancel mechanism             | OPEN   |
| UI-35 | MEDIUM   | File Upload Dialog    | Drop zone stays full-size after files selected — looks like empty state; confuses "add files" vs "files queued"                                      | OPEN   |
| UI-36 | LOW      | File Upload Dialog    | `.md` and other non-MIME files show "Type: unknown" in Auto-detected panel — no extension-based fallback                                             | OPEN   |
| UI-37 | LOW      | File Upload Dialog    | Auto-detected title shows raw underscored filename (e.g. `comprehensive_rca_report`) — underscores not stripped, no title-casing applied             | OPEN   |

---

## Detailed Bug Reports

### UI-1: Header counters stale / incorrect [HIGH]

**URL**: `https://agents-dev.kore.ai/projects/019d169a-dee7-7a73-a480-113dcd2ab63e/search-ai/019d169b-e734-73d7-a793-658830c097f7/data`
**Repro**:

1. Upload 7 files via SetupGuide
2. Navigate to Data tab — 7 documents visible (5 Indexed, 2 Error)
3. Check header bar: `AI_Research_Library | 0 Documents | 5 Chunks | 1 Sources`

**Expected**: Header shows `7 Documents | N Chunks | 1 Sources` (where N is the actual chunk count)
**Actual**: `0 Documents` even after page reload. Chunks = 5 (seems low for 5 indexed docs with ~1KB each). Sources updated to 1 only after reload.
**Root cause hypothesis**: The `KnowledgeBase.documentCount` field in MongoDB isn't being updated by the ingestion workers, or the header component reads from a cached/stale endpoint. The Diagnostics panel shows the same "Documents: 0".
**Files to investigate**: `apps/search-ai/src/workers/` (document count update), KB detail API response, Studio KB header component

---

### UI-2: PDF extraction fails on abl-dev [HIGH]

**URL**: Same Data tab
**Repro**:

1. Upload `attention-is-all-you-need.pdf` (2.1 MB, arxiv paper) and `rag-paper-lewis-2020.pdf` (865 KB)
2. Text files (.txt) index successfully within seconds
3. PDFs go from "extracting" → "Error" within ~1 minute

**Expected**: PDFs extracted and indexed like text files
**Actual**: Status = "Error", 0 chunks, no extracted content. Document detail > Metadata tab shows only `file_upload` metadata, no error message.
**Root cause hypothesis**: Docling service (`localhost:8080` / `abl-platform-dev-docling`) not running or not reachable on abl-dev. The extraction worker calls Docling for PDF→text conversion and it times out or 500s.
**Files to investigate**: `apps/search-ai/src/workers/extraction-worker.ts`, Docling service health on abl-dev, docker-compose service config
**Environment note**: This may be abl-dev-specific (Docling container not deployed). Text files bypass Docling and work fine.

---

### UI-3: Documents show "—" in Source column [MEDIUM]

**URL**: Data tab > Documents view
**Repro**:

1. Upload files to "Default" source
2. View documents in Data tab
3. Source column shows "—" for all documents
4. Source filter shows "All 1 | Default 0"

**Expected**: Source column shows "Default", filter shows "Default 7"
**Actual**: Source = "—", filter count = 0
**Root cause hypothesis**: Documents are created without `sourceId` field, or the Source column lookup fails. Related to known bug where `connectorId` is never set on manually uploaded documents.
**Files to investigate**: `apps/search-ai/src/routes/documents/upload.ts` (does it set sourceId?), Studio document list component (source column rendering)

---

### UI-5: Error documents show no error details [MEDIUM]

**URL**: Data tab > click errored PDF > document detail viewer
**Repro**:

1. Click on "attention-is-all-you-need.pdf" (Error status)
2. View Extracted tab: "No extracted content available"
3. View Metadata tab: DOCUMENT INFO shows Status=Error, no error message

**Expected**: Error details visible — "Extraction failed: Docling service unavailable" or similar. Retry button present.
**Actual**: Just "Error" badge and empty content. No `errorMessage`, no `errorCode`, no retry action.
**Fix suggestion**:

- Store `errorMessage` on the Document model when extraction fails
- Display in document detail viewer
- Add "Retry" button that re-queues the extraction job
  **Files to investigate**: `apps/search-ai/src/workers/extraction-worker.ts` (error handling), Document model, Studio document detail component

---

### UI-8: Search returns 500 Internal Server Error [HIGH]

**URL**: `https://agents-dev.kore.ai/.../search`
**Repro**:

1. Go to Search & Test tab
2. Enter query: "how does attention mechanism work"
3. Click Search (Hybrid mode, Top K=10, Debug=ON)

**Request**: `POST /api/search-ai-runtime/search/019d169b-e723-705b-ae68-5c5beb911f08/query`
**Request body**: `{"query":"how does attention mechanism work","queryType":"hybrid","topK":10,"debug":true}`
**Response**: `500 {"error":"Internal server error"}`
**Proxied to**: `http://abl-platform-dev-search-ai-runtime/api/search/{indexId}/query`
**Headers sent**: Bearer token ✅, X-Tenant-Id ✅
**Console**: 2x "Failed to load resource: 500"

**Expected**: Search results with relevance scores
**Actual**: Generic 500 error
**Root cause hypothesis**: search-ai-runtime service either (a) can't reach OpenSearch/embedding model, (b) the index doesn't have kNN configured, or (c) the BGE-M3 embedding service is not running on abl-dev.
**Files to investigate**: `apps/search-ai-runtime/src/routes/search.ts`, OpenSearch index mapping, embedding service health
**Environment note**: The Intelligence > LLM Models page shows "Failed to load query LLM status" — the query pipeline LLM is not configured, but that shouldn't cause a 500 on basic keyword search within Hybrid mode.

---

### UI-9: Search error shows no actionable details [MEDIUM]

**URL**: Search & Test tab
**Repro**: Search fails (see UI-8)

**Expected**: Error banner shows HTTP status, error message, and retry button. E.g. "Search failed (500): Internal server error — the search runtime may be unavailable. [Retry]"
**Actual**: Pink banner with just "Request failed" text. No status code, no error body, no retry button.
**Fix suggestion**: In the search error handler, include `error.status` and `error.message` from the response. Add a Retry button.
**Files to investigate**: Studio Search tab component, `apiFetch` error handling

---

### UI-11: "LLM not configured" warning despite 6/10 active use cases [MEDIUM]

**URL**: Search & Test tab (warning banner) vs Intelligence > LLM Models (shows 6/10 active)
**Repro**:

1. Go to Search & Test tab: amber banner "LLM not configured — search results may be limited"
2. Go to Intelligence > LLM Models: shows "6 Using Fallback", GPT-4o via balanced tier
3. Intelligence hub overview card shows green dot + "6/10 Active Use Cases"

**Expected**: If LLM models are available via fallback, the warning should either not show, or say "Using fallback models" instead of "not configured"
**Actual**: Warning says "LLM not configured" which is misleading — 6 ingestion features ARE using GPT-4o
**Nuance**: The warning may specifically refer to the query pipeline LLM (which does show "Failed to load query LLM status"). But the copy is too generic — it should distinguish "Query pipeline LLM not configured" from "Ingestion LLM not configured".
**Files to investigate**: Studio Search tab warning logic, `useKnowledgeBase` hook or LLM config check

---

### UI-12: Query Pipeline LLM failed to load [MEDIUM]

**URL**: Intelligence > LLM Models tab
**Observation**: Red error banner at top: "Query Pipeline LLM — Failed to load query LLM status" with Retry button
**Note**: This is the root cause of UI-8 (search 500) and UI-11 (misleading warning). The query pipeline model is not configured, so search queries to the runtime fail. Ingestion models (via fallback) work fine.
**Fix**: Either auto-configure query pipeline from tenant fallback, or show a clear onboarding flow to set it up.

### Pass 1 — Execution Log (2026-03-22)

**Environment**: https://agents-dev.kore.ai/
**Project**: E2E-SearchAI-Tests (019d169a-dee7-7a73-a480-113dcd2ab63e)
**KB**: AI_Research_Library (019d169b-e734-73d7-a793-658830c097f7)
**Test data**: 5 .txt files (AI/ML topics) + 2 .pdf (arxiv papers)

#### Section 0: Auth & Navigation

| #     | Status  | Notes                                                                                      |
| ----- | ------- | ------------------------------------------------------------------------------------------ |
| 0.1.1 | ✅ PASS | Login page: logo, "Sign in", email field, Continue, 3 social providers, Dev Login, Sign Up |
| 0.1.2 | ✅ PASS | Dev Login button visible, clickable                                                        |
| 0.1.3 | ✅ PASS | Click → "Checking authentication..." spinner → redirect to /projects                       |
| 0.1.4 | ✅ PASS | Zero console errors on login page                                                          |
| 0.1.5 | ✅ PASS | Zero console errors after login                                                            |
| 0.2.1 | ✅ PASS | 123 workspaces, search bar, 2-col card grid, each card: icon, name, desc, agents, date     |
| 0.2.2 | ✅ PASS | Knowledge Bases sidebar link navigates to /search-ai                                       |
| 0.2.3 | ✅ PASS | KB cards: name, status badge, description, doc/source counts, last updated                 |
| 0.2.4 | ✅ PASS | 4 metric cards (TOTAL KBS, ACTIVE, INDEXING, ERRORS) — only shown when ≥1 KB               |
| 0.2.5 | ✅ PASS | Search bar + sort + status filter visible                                                  |

#### Section 1: KB Creation Dialog

| #   | Status  | Notes                                                     |
| --- | ------- | --------------------------------------------------------- |
| 1.1 | ✅ PASS | "New Knowledge Base" → dialog opens with backdrop         |
| 1.2 | ✅ PASS | Name field with placeholder "e.g. Product Catalog"        |
| 1.3 | ✅ PASS | Description field with placeholder "Optional description" |
| 1.4 | ✅ PASS | Empty name → "Name is required." validation error         |
| 1.5 | ✅ PASS | Valid submit → KB created, navigates to detail page       |
| 1.6 | ✅ PASS | Lands on Home tab with SetupGuide                         |
| 1.7 | ✅ PASS | Zero console errors                                       |

#### Section 2: Home Tab — SetupGuide (0 sources, 0 docs)

| #    | Status  | Notes                                                                     |
| ---- | ------- | ------------------------------------------------------------------------- |
| 2.1  | ✅ PASS | Header: `Get started with "AI_Research_Library"`                          |
| 2.2  | ✅ PASS | Upload card: drag-drop zone, file types listed, "Browse files" button     |
| 2.3  | ✅ PASS | Connect Source card: title, description, "Connect a source" button        |
| 2.4  | ✅ PASS | "WHAT HAPPENS AUTOMATICALLY": 3 steps listed                              |
| 2.5  | ✅ PASS | LLM warning banner (amber): keyword-only warning + "Configure LLM" button |
| 2.8  | ✅ PASS | Browse files → FileUploadDialog opens with file listed                    |
| 2.9  | ✅ PASS | Dialog stays open during upload (A1/A2 fix confirmed)                     |
| 2.10 | ✅ PASS | Per-file status: Pending → Uploading → Done                               |
| 2.12 | ✅ PASS | All done → dialog auto-closes                                             |
| 2.13 | ✅ PASS | Source name "Default" (not "Uploaded Files" — A4 fix confirmed)           |

#### Section 3: Home Tab — WaitingForContent

| #   | Status  | Notes                                                               |
| --- | ------- | ------------------------------------------------------------------- |
| 3.1 | ✅ PASS | "Sources connected — waiting for content"                           |
| 3.2 | ✅ PASS | Source table: Name, Type, Status, Documents                         |
| 3.3 | ⚠️ NOTE | Source status shows "pending" initially, then "active" after upload |
| 3.4 | ✅ PASS | "Upload files" button                                               |
| 3.5 | ✅ PASS | "Add another source" button                                         |

#### Section 6: Data Tab — Documents

| #    | Status  | Notes                                                |
| ---- | ------- | ---------------------------------------------------- |
| 6.1  | ✅ PASS | Documents / Chunks / Sources segmented control       |
| 6.2  | ✅ PASS | Document table: Title, Source, Status, Created, Size |
| 6.6  | ✅ PASS | Search bar visible                                   |
| 6.7  | ✅ PASS | Rows show filename, source, status badge, date, size |
| 6.8  | ✅ PASS | Click row → document detail viewer (slide-out modal) |
| 6.10 | ✅ PASS | Metadata tab: DOCUMENT INFO + SOURCE METADATA JSON   |

---

### UI-13: Browse Preview shows wrong empty state when taxonomy is absent [HIGH]

**URL**: `/projects/{projectId}/search-ai/{kbId}/browse-preview`
**Repro**:

1. Open a KB with no taxonomy generated (new KB, intelligence pipeline not run)
2. Navigate to Browse Preview
3. Observe main content area

**Expected**: Custom empty state — "No taxonomy data yet" headline + "Run the intelligence pipeline to generate categories and attributes for browsing." description + "Go to Intelligence" action button
**Actual**: Generic "No documents found — Try adjusting your search query or filters." message (this is the search-results empty state, not the taxonomy-missing state)
**Network**: `GET /api/search-ai-runtime/search/{indexId}/browse/taxonomy?include_beta=true` → **500**
**Root cause**: D1/D2 fix (from Sprint 8 bug plan) was not deployed to abl-dev, OR the taxonomy 500 is being handled with the wrong empty state. When `taxonomy` is empty/error, the component falls through to the search-results empty state instead of the taxonomy-absent empty state.
**Files**: `apps/studio/src/components/search-ai/browse-preview/BrowsePreviewPage.tsx` (taxonomy empty state logic)

---

### UI-14: Chunks view — all chunks show "Untitled" in Document column [HIGH]

**URL**: Data > Chunks tab
**Repro**:

1. Upload 5 .txt files, wait for indexing
2. Navigate to Data > Chunks
3. Observe "DOCUMENT" column for all 5 rows

**Expected**: Document column shows filename (e.g. "transformer-architecture.txt")
**Actual**: All show "Untitled"
**Root cause hypothesis**: Document.title is not set during upload — the ingestion worker either doesn't populate it from the filename or the Chunks query doesn't JOIN with the Document name. The docs table shows correct filenames, but chunks don't link back to their parent document name.
**Files**: Document ingestion worker (sets title?), chunks list query in `apps/search-ai/src/routes/`, `ChunksTab` component in Studio

---

### UI-15: URL `?tab=chunks` query param ignored — tab doesn't switch [LOW]

**URL**: `/data?tab=chunks`
**Repro**:

1. Navigate directly to `/data?tab=chunks`
2. Observe which tab is active

**Expected**: Chunks tab is active
**Actual**: Documents tab is active (default). URL param has no effect.
**Impact**: Browser back/forward navigation, deep links, and bookmark sharing for specific sub-tabs all broken.
**Files**: `KBDetailPage.tsx` or `DataTab.tsx` — tab state likely uses `useState` instead of reading from `searchParams`

---

### UI-16: Settings panel title "LLM Features" is misleading [LOW]

**URL**: KB header gear icon → settings panel
**Repro**: Click gear icon on KB detail header
**Expected**: Panel title "Knowledge Base Settings" or "Settings"
**Actual**: Panel title "LLM Features" — but panel shows General info, Index Config, and Danger Zone
**Note**: Could be a copy/title bug from a partial refactor. The LLM Features section is actually inside Intelligence > LLM Models, not here.
**Files**: `KBSettingsPanel.tsx` or similar settings drawer component

---

### UI-17: "All suggestions reviewed" shown on Suggested tab when there are 0 suggestions [LOW]

**URL**: Intelligence > Fields > Suggested tab
**Repro**: Open a new KB that has never had field suggestions generated
**Expected**: "No field mapping suggestions yet — run the intelligence pipeline to generate suggestions" or similar
**Actual**: "All suggestions reviewed. Check 'Unmapped Fields' for any remaining fields." — implies there were suggestions that got reviewed, but there were never any
**Impact**: Misleading for first-time users — they might think the pipeline already ran successfully
**Files**: `FieldsTab.tsx` — Suggested sub-tab empty state condition

---

### UI-18: KG "Configure & Continue" button hidden below fold [MEDIUM]

**URL**: Intelligence > Knowledge Graph
**Repro**:

1. Open Knowledge Graph tab
2. Claude Sonnet 4.5 is pre-selected (correct)
3. But "Configure & Continue" button is off-screen below

**Expected**: CTA visible without scrolling, or "sticky" footer button
**Actual**: Must scroll past 5 model cards to find the button. Claude Sonnet 4.5 is already selected — nothing visible indicates you can proceed.
**Impact**: Users may think the page is broken or there's nothing to do, since the action button is invisible on first render.
**Files**: KG configuration wizard component — button should be sticky or in the visible viewport

---

### UI-19: LLM feature cards render description text twice [LOW]

**URL**: Intelligence > LLM Models
**Repro**: Scroll through any enabled LLM feature card
**Expected**: Each card shows description once
**Actual**: Each enabled feature (e.g. `vocabularyGeneration`, `knowledgeGraph`) shows description as plain text AND again as a blue link-styled text. Disabled features (e.g. `vision`) show "Feature disabled by user" twice.
**Root cause**: Component is rendering two description elements — one from the base status message and one from an additional fallback/tooltip render.
**Files**: LLM feature card component in `apps/studio/src/components/search-ai/intelligence/llm-models/`

---

### UI-20: Home tab stuck on "waiting for content" after documents are indexed [CRITICAL]

**URL**: KB Home tab
**Repro**:

1. Upload 7 files to a new KB
2. Wait for indexing (5 .txt files successfully indexed, 5 chunks visible in Chunks tab)
3. Navigate to Home tab

**Expected**: Home tab transitions to OperationsDashboard state — shows stat cards (Documents, Chunks, Sources, Last Indexed), activity feed, etc.
**Actual**: Home tab remains on WaitingForContent state — "Sources connected — waiting for content" message, source table showing "Default | manual | active | 0 Documents", three action buttons (Upload files, Add another source, Configure)
**Note at bottom of page**: "Once documents are ingested, this page shows your operations dashboard." — but ingestion IS complete
**Root cause hypothesis**: Home tab state machine reads from a stale data source. Options:

1. `KnowledgeBase.documentCount = 0` is never updated after indexing (same root as UI-1)
2. The WaitingForContent → OperationsDashboard transition checks `documentCount > 0` but this field is stale
3. Home page doesn't subscribe to real-time updates; manual refresh not enough
   **Files**: `apps/studio/src/components/search-ai/home/` — state machine logic (`SetupGuide`, `WaitingForContent`, `OperationsDashboard` conditions), `useKnowledgeBase` hook data freshness

---

### UI-21: `GET /query-llm-status` returns 401 [HIGH]

**Network Request**: `GET /api/search-ai/indexes/{indexId}/query-llm-status` → 401
**Context**: Triggered when loading Intelligence > LLM Models tab
**Expected**: 200 with LLM status object
**Actual**: 401 Unauthorized
**Impact**: Results in "Failed to load query LLM status" error banner on LLM Models page. This is the root cause of search 500s — query pipeline can't determine LLM config.
**Note**: The auth token is valid (other requests on the same page return 200/304). This looks like the route has a different auth middleware or requires a different permission.
**Files**: `apps/search-ai/src/routes/indexes/query-llm-status.ts` or similar — check auth middleware on this specific route

---

### UI-22: `GET /schemas/{indexId}` returns 404 three times [MEDIUM]

**Network Requests**: `GET /api/search-ai/schemas/019d169b-e723-705b-ae68-5c5beb911f08` → 404 (repeated 3×)
**Context**: Triggered during Intelligence tab navigation (Fields + KG tabs)
**Expected**: Canonical schema auto-created when first document is indexed; 200 with schema object
**Actual**: 404 — schema never exists. Called 3× with no retry logic — all fail identically.
**Impact**: Field mapping suggestions, LLM prompts (which need schema context), and Browse facets all depend on the canonical schema. With 404, these features silently degrade.
**Root cause**: Canonical schema is not auto-created when a new KB is set up. It may require a manual trigger or connector creation.
**Files**: `apps/search-ai/src/workers/` or KB creation flow — schema auto-creation step missing. `ConnectorConfig` auto-creation for manual uploads needed (per `memory/canonical-mapping-pipeline-gaps.md`).

---

### UI-23: `GET /kg-taxonomy` called 3× redundantly per KG tab visit [LOW]

**Network Requests**: `GET /api/search-ai/indexes/{indexId}/kg-taxonomy` → 404 (3 identical calls)
**Context**: Single visit to Knowledge Graph tab triggers 3 identical requests
**Expected**: 1 request, cached on the client
**Actual**: 3 duplicate requests all returning 404
**Impact**: Unnecessary load on the backend; React Query/SWR deduplication may not be working for this endpoint.
**Files**: Studio KG component — check for multiple `useQuery`/`useSWR` hooks calling the same endpoint without shared cache keys

---

## Pass 2 — Execution Log (2026-03-23)

**Environment**: https://agents-dev.kore.ai/
**Project**: E2E-SearchAI-Tests
**KB**: AI_Research_Library (5 .txt indexed, 2 .pdf errored)

### Section 7: Data Tab — Chunks

| #   | Status     | Notes                                                                            |
| --- | ---------- | -------------------------------------------------------------------------------- |
| 7.1 | ✅ PASS    | Switch to Chunks via JS click; chunk table renders                               |
| 7.2 | ❌ FAIL    | Document column shows "Untitled" for all 5 chunks (UI-14)                        |
| 7.3 | ✅ PASS    | Content preview shows truncated text; full content visible on expand             |
| 7.4 | ✅ PASS    | Pagination shows 1-5 of 5 (no navigation needed)                                 |
| 7.5 | ✅ PASS    | Status filter: all statuses, pending, embedded, indexed, filtered, error         |
| 7.6 | ⚠️ PARTIAL | Chunk number "#" column all show "0" — each doc has 1 chunk so index is always 0 |

### Section 8: Data Tab — Sources

| #    | Status  | Notes                                                  |
| ---- | ------- | ------------------------------------------------------ |
| 8.1  | ✅ PASS | Sources tab loads                                      |
| 8.2  | ❌ FAIL | Source "Default" shows Docs: **0** (7 docs not linked) |
| 8.3  | ✅ PASS | Add Source button visible, type picker opens           |
| 8.10 | ✅ PASS | Delete icon visible per source row                     |
| 8.12 | ✅ PASS | Upload icon (upload more to this source) visible       |

### Section 9: Intelligence Tab — Overview

| #   | Status  | Notes                                                              |
| --- | ------- | ------------------------------------------------------------------ |
| 9.1 | ✅ PASS | 5 cards: Pipeline, Fields, Vocabulary, Knowledge Graph, LLM Models |
| 9.2 | ✅ PASS | Pipeline: green dot "Active", "Configure" button                   |
| 9.3 | ✅ PASS | Fields: "Set up Fields" button (not configured)                    |
| 9.4 | ✅ PASS | Vocabulary: "Set up Vocabulary" button (not configured)            |
| 9.5 | ✅ PASS | Knowledge Graph: green dot "Active" (enabled but no taxonomy)      |
| 9.6 | ✅ PASS | LLM Models: green dot, "6/10 Active Use Cases"                     |

### Section 10: Intelligence Tab — Pipeline

| #    | Status  | Notes                                                                                                               |
| ---- | ------- | ------------------------------------------------------------------------------------------------------------------- |
| 10.1 | ✅ PASS | Pipeline editor loads with 25/75 layout                                                                             |
| 10.2 | ✅ PASS | "Default Processing" flow listed (P0, System Default, 4 stages)                                                     |
| 10.3 | ✅ PASS | Flow detail shows: name, description, status toggle, pipeline diagram                                               |
| 10.4 | ✅ PASS | Pipeline diagram: EXTRACTION (docling) → CHUNKING (tree-builder) → ENRICHMENT (llm-enrichment) → EMBEDDING (bge-m3) |
| 10.5 | ✅ PASS | BGE-M3 embedding model shown with green dot (1024 dimensions)                                                       |
| 10.6 | ✅ PASS | Published v1 badge, Validate + Save Draft + Publish buttons                                                         |
| 10.7 | ✅ PASS | "+ Add Flow" CTA for custom flows                                                                                   |

### Section 11: Intelligence Tab — Fields

| #     | Status     | Notes                                                              |
| ----- | ---------- | ------------------------------------------------------------------ |
| 11.1  | ✅ PASS    | Fields tab loads with 3 sub-tabs: My Fields, Suggested, Unmapped   |
| 11.2  | ✅ PASS    | My Fields: empty state "No mapped fields yet"                      |
| 11.3  | ⚠️ PARTIAL | Suggested 0: shows "All suggestions reviewed" — misleading (UI-17) |
| 11.11 | ✅ PASS    | Unmapped 0: shows no items                                         |

### Section 12: Intelligence Tab — Vocabulary

| #    | Status  | Notes                                                               |
| ---- | ------- | ------------------------------------------------------------------- |
| 12.1 | ✅ PASS | Vocabulary tab loads with empty state                               |
| 12.2 | ✅ PASS | Empty state: "No vocabulary entries" + Add First Entry CTA          |
| 12.3 | ✅ PASS | Search bar, Filter button, Test Resolution button, Add Entry button |

### Section 13: Intelligence Tab — Knowledge Graph

| #    | Status     | Notes                                                                      |
| ---- | ---------- | -------------------------------------------------------------------------- |
| 13.1 | ✅ PASS    | KG tab shows model selection wizard                                        |
| 13.2 | ⚠️ PARTIAL | Claude Sonnet 4.5 pre-selected (good) but button hidden below fold (UI-18) |
| 13.3 | ✅ PASS    | 6 models listed with capability scores                                     |
| 13.4 | ❌ FAIL    | GPT-4.1 (Azure) shows grey dot — not configured/available                  |
| 13.5 | ✅ PASS    | "Configure & Continue" button visible after scrolling                      |

### Section 14: Intelligence Tab — LLM Models

| #     | Status     | Notes                                                                            |
| ----- | ---------- | -------------------------------------------------------------------------------- |
| 14.1  | ❌ FAIL    | Red error: "Query Pipeline LLM — Failed to load query LLM status" (UI-12, UI-21) |
| 14.2  | ✅ PASS    | Tenant Models card: "6 Using Fallback" + Configure Models link                   |
| 14.7  | ✅ PASS    | Core Features: progressiveSummarization enabled (GPT-4o fallback)                |
| 14.8  | ✅ PASS    | knowledgeGraph enabled, mapping_suggestion enabled                               |
| 14.9  | ⚠️ PARTIAL | vision disabled, multimodal disabled (expected for Advanced tier)                |
| 14.11 | ❌ FAIL    | Duplicate text rendered in each feature card description (UI-19)                 |
| 14.12 | ⚠️ NOTE    | scopeClassification is disabled — may affect search quality                      |

### Section 15: Search & Test Tab

| #     | Status  | Notes                                                                                                        |
| ----- | ------- | ------------------------------------------------------------------------------------------------------------ |
| 15.1  | ✅ PASS | Two-column layout: Query playground (left) + Diagnostics (right)                                             |
| 15.2  | ✅ PASS | Query input visible                                                                                          |
| 15.3  | ✅ PASS | Query Type: Hybrid dropdown                                                                                  |
| 15.4  | ✅ PASS | Top K: 10 (default)                                                                                          |
| 15.5  | ✅ PASS | Resolve Mode: Alias dropdown                                                                                 |
| 15.6  | ✅ PASS | Debug toggle (ON by default)                                                                                 |
| 15.7  | ❌ FAIL | Search button doesn't respond to JS-triggered click (React state issue in test; may work with real keyboard) |
| 15.15 | ✅ PASS | Yellow warning: "LLM not configured — search results may be limited"                                         |
| 15.24 | ✅ PASS | Diagnostics: Data & Indexing (Documents:0, Chunks:5), Enrichment, Pipeline Health                            |
| 15.25 | ✅ PASS | Query History: "No queries recorded yet" empty state                                                         |

### Section 16: Browse Preview

| #     | Status     | Notes                                                                                               |
| ----- | ---------- | --------------------------------------------------------------------------------------------------- |
| 16.1  | ✅ PASS    | Browse Preview page loads with SDK Preview header                                                   |
| 16.2  | ❌ FAIL    | Doc count shows "0 documents" (stale, same as UI-1)                                                 |
| 16.3  | ✅ PASS    | Search bar renders                                                                                  |
| 16.4  | ⚠️ PARTIAL | No category pills (no taxonomy)                                                                     |
| 16.6  | ❌ FAIL    | Sidebar: "No categories available" (taxonomy 500)                                                   |
| 16.30 | ❌ FAIL    | Empty taxonomy shows wrong message — generic "No documents found" instead of D1/D2 guidance (UI-13) |

### Section 17: Settings Panel

| #    | Status     | Notes                                                                           |
| ---- | ---------- | ------------------------------------------------------------------------------- |
| 17.1 | ✅ PASS    | Settings panel opens on gear icon click                                         |
| 17.2 | ✅ PASS    | Name (AI_Research_Library) + Description editable                               |
| 17.3 | ✅ PASS    | Status (active), Search Index ID, Created date (read-only)                      |
| 17.4 | NOT TESTED | Edit save not tested                                                            |
| 17.5 | ✅ PASS    | Index Config: bge-m3, 1024 dim, opensearch, collection, TopK=10, similarity=0.7 |
| 17.6 | ✅ PASS    | Rebuild Index: "Rebuild (Coming Soon)" — placeholder                            |
| 17.7 | ✅ PASS    | Delete KB: red Delete button with confirmation                                  |
| 17.8 | ✅ PASS    | Close via X button and Escape key                                               |
| ⚠️   | BUG        | Panel title "LLM Features" is wrong — should be "Settings" (UI-16)              |

### Section 19: Cross-cutting

| #    | Status     | Notes                                                           |
| ---- | ---------- | --------------------------------------------------------------- |
| 19.1 | ✅ PASS    | Tab transitions smooth; URL updates correctly                   |
| 19.2 | NOT TESTED |                                                                 |
| 19.3 | ❌ FAIL    | `?tab=chunks` deep link doesn't activate Chunks sub-tab (UI-15) |
| 19.8 | ✅ PASS    | No raw i18n keys visible                                        |
| 19.9 | ✅ PASS    | Dark mode available via moon icon — renders correctly           |

---

## Summary: All Bugs Found (Prioritized)

### CRITICAL

| ID    | Bug                                                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------------ |
| UI-20 | Home tab stuck on "waiting for content" after 5 chunks indexed — never advances                                    |
| UI-34 | Closing upload dialog without uploading leaves document in persistent "pending" ghost state — no discard mechanism |

### HIGH

| ID    | Bug                                                                                     |
| ----- | --------------------------------------------------------------------------------------- |
| UI-1  | Header shows "0 Documents" throughout (stale KnowledgeBase.documentCount)               |
| UI-8  | Search returns 500 (query pipeline LLM not configured)                                  |
| UI-13 | Browse Preview shows wrong empty state when taxonomy absent                             |
| UI-14 | Chunks tab — Document column shows "Untitled" for all chunks                            |
| UI-21 | `GET /query-llm-status` returns 401 (auth error on LLM status endpoint)                 |
| UI-2  | PDF extraction fails on abl-dev (Docling not deployed)                                  |
| UI-33 | Upload dialog source dropdown shows "Select a source…" — not auto-selected to "Default" |

### MEDIUM

| ID    | Bug                                                                             |
| ----- | ------------------------------------------------------------------------------- |
| UI-3  | Documents show "—" in Source column (sourceId not set during upload)            |
| UI-5  | Error documents show no error details or retry option                           |
| UI-9  | Search error shows "Request failed" with no actionable details                  |
| UI-11 | "Not configured" warning misleading — 6/10 LLM features ARE active via fallback |
| UI-12 | "Failed to load query LLM status" error banner on LLM Models tab                |
| UI-18 | KG "Configure & Continue" button hidden below fold                              |
| UI-22 | Canonical schema never auto-created (3× 404 on /schemas/{indexId})              |

### LOW

| ID    | Bug                                                                             |
| ----- | ------------------------------------------------------------------------------- |
| UI-4  | Header Sources counter stale                                                    |
| UI-6  | "Crawled" label on manually uploaded files                                      |
| UI-7  | Raw UUID in breadcrumb instead of KB name                                       |
| UI-10 | Diagnostics panel "Documents: 0" (same root as UI-1)                            |
| UI-15 | `?tab=chunks` URL param ignored; Chunks sub-tab doesn't activate via deep link  |
| UI-16 | Settings panel title "LLM Features" should be "Knowledge Base Settings"         |
| UI-17 | "All suggestions reviewed" misleading on new KB with no prior suggestions       |
| UI-19 | Duplicate description text in LLM feature cards                                 |
| UI-23 | `/kg-taxonomy` called 3× redundantly on each KG tab visit                       |
| UI-25 | "Llm Models" wrong breadcrumb casing                                            |
| UI-26 | "1 sources" grammatical error in Sources summary                                |
| UI-28 | All chunks show "#: 0" — sequence number always zero                            |
| UI-29 | "(page counts)" text in Chunks tab summary is cryptic                           |
| UI-32 | KB names with underscores displayed raw in headings                             |
| UI-36 | `.md` / unknown MIME files show "Type: unknown" in upload Auto-detected panel   |
| UI-37 | Auto-detected title shows raw underscored filename — no cleanup or title-casing |

### MEDIUM (UX Audit)

| ID    | Bug                                                                                     |
| ----- | --------------------------------------------------------------------------------------- |
| UI-24 | Raw UUID in breadcrumb before project context resolves                                  |
| UI-27 | Browse Preview opens in new tab with no back-to-KB navigation                           |
| UI-30 | LLM feature names shown as raw camelCase/snake_case identifiers                         |
| UI-31 | No tooltips on technical parameters (Top K, Similarity threshold, Resolve Mode…)        |
| UI-35 | Upload drop zone stays full-size after files selected — ambiguous "add vs queued" state |

---

## Root Cause Clusters

Most bugs trace to 4 root causes:

1. **Stale `KnowledgeBase.documentCount`** → UI-1, UI-10, UI-14 (header, diagnostics, home state machine all read this field)
   - Fix: Update `documentCount` in MongoDB whenever a document is indexed/de-indexed

2. **Documents not linked to source after upload** → UI-3, UI-14 (source "—", "0 docs" in source)
   - Fix: Set `sourceId` on documents during upload; ensure `connectorId` is populated for manual uploads

3. **Query Pipeline LLM not configured** → UI-8, UI-9, UI-12, UI-21
   - Fix: Auto-configure query LLM from tenant fallback for new KBs; fix 401 on `/query-llm-status`

4. **Missing canonical schema auto-creation** → UI-22, Fields/Vocabulary showing 0 suggestions
   - Fix: Auto-create `ConnectorConfig` + trigger schema creation when first document is uploaded

5. **Technical internals leaking into UI** → UI-25, UI-30, UI-31, UI-32
   - Fix: Add display name mapping for feature names; add tooltips for technical parameters; strip underscores from KB name display

6. **Upload dialog UX gaps** → UI-33, UI-34, UI-35, UI-36, UI-37
   - Fix: Auto-select default source; use optimistic-creation pattern only at upload-confirm; collapse drop zone after file selection; add MIME extension fallback; apply title-case cleanup to auto-detected filename

---

## Pass 3 — UX Audit Findings (2026-03-23)

New bugs discovered during the full UX Experience Audit (live browser walkthrough of all tabs).

### UI-24: Raw UUID in breadcrumb on direct URL load [MEDIUM]

**Steps to reproduce**: Open `https://agents-dev.kore.ai/projects/{projectId}/search-ai/{kbId}` directly (e.g., from bookmark)

**Observed**: Breadcrumb shows `Projects > Project > Search AI > 019d169b-e734-73d7-a793-658830c097f7` (raw UUID) while the project context is still loading

**Expected**: Either show a skeleton placeholder or defer rendering the breadcrumb until the project name resolves

**Root cause**: Project name is loaded asynchronously. Before resolution, the breadcrumb falls back to rendering the raw ID from the URL params.

---

### UI-25: "Llm Models" wrong casing in breadcrumb [LOW]

**Steps to reproduce**: Navigate to Intelligence → LLM Models sub-tab

**Observed**: Breadcrumb shows `... > AI_Research_Library > Llm Models`

**Expected**: `LLM Models`

**Root cause**: Breadcrumb auto-generates from route segment name using title-case conversion, which converts "LLM" to "Llm".

---

### UI-26: "1 sources" grammatical error in Sources tab summary [LOW]

**Steps to reproduce**: Navigate to Data → Sources tab

**Observed**: Summary line reads "Total: 1 sources"

**Expected**: "Total: 1 source" (singular when count === 1)

**Root cause**: Missing singular/plural i18n handling in summary line.

---

### UI-27: Browse Preview opens in new tab with no back-to-KB navigation [MEDIUM]

**Steps to reproduce**: Click "Preview SDK" button in the KB detail header

**Observed**: Opens `browse-preview` URL in a new browser tab. Page has no "← Back to KB" link. Users must use browser back or close the tab.

**Expected**: Include an explicit "← Back to [KB Name]" link in the SDK Preview header bar, or open in the same tab.

**UX impact**: First-time users feel stranded. The SDK Preview context banner is excellent but there's no escape hatch.

---

### UI-28: All chunks show "#: 0" (sequence number is always zero) [LOW]

**Steps to reproduce**: Navigate to Data → Chunks tab

**Observed**: The `#` column for all 5 chunks shows "0"

**Expected**: Chunks should have incrementing sequence numbers (0, 1, 2… or 1, 2, 3…) per document

**Root cause hypothesis**: `chunkIndex` or `sequenceNumber` not being set during indexing.

---

### UI-29: "(page counts)" text in Chunks tab summary is cryptic [LOW]

**Steps to reproduce**: Navigate to Data → Chunks tab

**Observed**: Summary reads "Total: 5 chunks (page counts) Indexed: 5"

**Expected**: Remove or replace with something meaningful: e.g., "Token counts shown per chunk"

---

### UI-30: LLM feature names shown as raw code identifiers [MEDIUM]

**Steps to reproduce**: Navigate to Intelligence → LLM Models; scroll through feature cards

**Observed**: Feature names: `progressiveSummarization`, `questionSynthesis`, `noiseDetection`, `scopeClassification`, `knowledgeGraph`, `mapping_suggestion` (the last one inconsistently uses snake_case)

**Expected**: Human-readable display names: "Progressive Summarization", "Question Synthesis", "Noise Detection", "Scope Classification", "Knowledge Graph", "Mapping Suggestion"

**Root cause**: Feature name rendered directly from API response field name without a display-name mapping.

---

### UI-31: No tooltips on technical search/index parameters [MEDIUM]

**Steps to reproduce**: Navigate to Search & Test and/or Settings panel

**Observed**: Parameters displayed with no explanation: "Top K: 10", "Similarity threshold: 0.7", "Dimensions: 1024", "Resolve Mode: Alias", "Query Type: Hybrid", "Tier: Fast/Balanced", "Capability Score: 70%"

**Expected**: Each parameter should have an `(i)` info icon or tooltip explaining what it controls and what valid values mean.

**UX impact**: Non-technical PMs and business users cannot meaningfully use these settings without external documentation.

---

### UI-32: KB names with underscores displayed raw in headings [LOW]

**Steps to reproduce**: View KB with underscores in name (e.g., `AI_Research_Library`)

**Observed**: Heading shows `AI_Research_Library` with literal underscores

**Expected**: Display with spaces: `AI Research Library`, or enforce spaces at creation time.

---

## Pass 4 — Upload Dialog UX Audit (2026-03-23)

User-reported bugs from live screenshot review of the file upload dialog (triggered by
clicking "Upload Files" in the Setup Guide after KB creation).

### UI-33: Source dropdown not auto-selected to "Default" [HIGH]

**Steps to reproduce**:

1. Create a new KB
2. Click "Upload Files" in the Setup Guide
3. Drop or select files — dialog opens with subtitle "Upload Files to 'Default'"
4. Observe the Source dropdown

**Observed**: Source dropdown shows "Select a source…" placeholder text — the user must
manually choose a source before uploading.

**Expected**: Since the dialog subtitle already says "Upload Files to 'Default'", the
dropdown should pre-select "Default" automatically. The user chose the source in the
Setup Guide step; the dialog should inherit that choice.

**Root cause hypothesis**: `FileUploadDialog.tsx` receives the source name (to build the
dialog title) but does not pass it as `defaultValue` / `value` to the source `<select>`
or controlled select component. Two separate props exist for title vs. pre-selection.

**Fix location**: `apps/studio/src/components/search-ai/home/FileUploadDialog.tsx` —
wire the `sourceName` / `sourceId` prop to the select's default value.

---

### UI-34: Closing dialog without uploading leaves "pending" ghost document [CRITICAL]

**Steps to reproduce**:

1. Create a new KB with no documents
2. Click "Upload Files" — dialog opens
3. Drop a file into the drop zone (file appears in queue)
4. Click × to close the dialog **without** clicking "Upload"
5. Navigate to Data tab

**Observed**: The document appears in the Documents list with status "pending". It stays
there permanently — there is no way to delete it or dismiss it. Page reload does not clear
it.

**Expected**: Closing the dialog without uploading should discard all queued files with
no side effects. No document record should exist until "Upload N Files" is confirmed.

**Root cause hypothesis**: The frontend creates a document record (or the upload begins)
at file-selection time rather than at upload-confirmation time. The dialog does not clean
up this record on close/cancel.

**UX impact**: Critical — first-time users who accidentally close the dialog are stuck
with a permanent pending document they cannot remove. This blocks the Setup Guide from
advancing (it waits for indexed documents).

**Fix location**:

- `apps/studio/src/components/search-ai/home/FileUploadDialog.tsx` — add `onCancel`
  handler that deletes any document records created during the session
- Or: defer document creation to upload-confirm click (preferred — avoids orphan cleanup)

---

### UI-35: Drop zone stays full-size after files are selected [MEDIUM]

**Steps to reproduce**:

1. Open upload dialog
2. Drop 3 files — they appear as rows in a file list (filename, size, × remove)
3. Observe the drop zone area

**Observed**: The large full-size drop zone area (dashed border, "Drop files here or click
to browse" text) remains exactly the same size as when no files were selected. The file
list rows appear below it, so the overall dialog becomes very tall.

**Expected**: After files are queued, the drop zone should collapse to a compact
"+ Add more files" affordance (small button or thin bar). This signals clearly that
files are already staged and the next action is "Upload", not "keep dropping".

**UX impact**: The current state is visually ambiguous — it looks like an empty state
(the drop zone dominates the view) even when files are ready. Users may be unsure if
their drop was registered.

**Fix location**: `apps/studio/src/components/search-ai/home/FileUploadDialog.tsx` —
conditionally render compact "+ Add more files" strip when `files.length > 0`.

---

### UI-36: "Type: unknown" for `.md` and other non-standard MIME files [LOW]

**Steps to reproduce**:

1. Open upload dialog
2. Drop a `.md` file (e.g., `README.md`)
3. Observe the "Auto-detected" metadata panel on the right

**Observed**: Panel shows `Type: unknown`

**Expected**: `Type: Markdown` (or at minimum the file extension: `Type: .md`)

**Root cause**: `file.type` returns `""` for `.md`, `.ts`, `.py`, and many other developer
file types. The frontend renders the raw MIME type without an extension-based fallback.

**Fix location**: `apps/studio/src/components/search-ai/home/FileUploadDialog.tsx` —
add a `getDisplayType(file)` helper: use `file.type || extensionToMimeLabel[ext] || ext.toUpperCase()`.

---

### UI-37: Auto-detected title shows raw underscored filename [LOW]

**Steps to reproduce**:

1. Upload a file named `comprehensive_rca_report.txt`
2. Observe "Auto-detected" panel → Title field

**Observed**: `Title: comprehensive_rca_report`

**Expected**: `Title: Comprehensive Rca Report` (or better: `Title: Comprehensive RCA Report`)

**Root cause**: Title is derived from `file.name` with extension stripped, but no
further cleanup is applied — underscores not replaced with spaces, no title-casing.

**Fix location**: Add a `sanitizeTitle(filename: string): string` utility:
`filename.replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())`

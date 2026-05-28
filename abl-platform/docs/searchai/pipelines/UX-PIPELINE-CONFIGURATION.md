# UX Design: Pipeline Configuration

**Version:** 1.0
**Status:** Draft (Pending Approval)
**Related Tasks:** Task #64, Task #65
**Last Updated:** 2026-03-07

---

## Table of Contents

1. [Overview](#overview)
2. [Design Principles](#design-principles)
3. [UI to Backend Communication](#ui-to-backend-communication)
4. [Wiremocks](#wiremocks)
5. [Component Hierarchy](#component-hierarchy)
6. [State Management](#state-management)
7. [API Specifications](#api-specifications)
8. [User Flows](#user-flows)
9. [Implementation References](#implementation-references)

---

## Overview

This document specifies the UX design for configuring pluggable ingestion pipelines in Studio. The interface allows users to:

- Create and edit pipeline definitions for knowledge bases
- Configure multiple flows with selection rules
- Set provider configurations for each stage
- Test flow selection with document previews
- Monitor pipeline execution

**Target Users:**

- **Non-technical users**: Can use default flows and basic configuration
- **Power users**: Can write CEL expressions and configure advanced options
- **Developers**: Can test custom providers and debug flows

---

## Design Principles

### 1. Progressive Disclosure

- **Basic → Advanced**: Show simple options first, advanced in collapsible sections
- **Defaults First**: Users start with 3 default flows (PDF, Office, Default)
- **Inline Help**: Descriptions and examples next to fields

### 2. Immediate Feedback

- **Inline Validation**: Errors shown below fields as you type
- **Cost Estimation**: Live preview of token costs per flow
- **Flow Simulation**: Test document → flow routing before publish

### 3. Visual Flow Representation

- **React Flow Canvas**: Drag-and-drop stage arrangement
- **Collapsible Cards**: Alternative list view for power users
- **Both Views Synced**: Changes in one reflected in other

### 4. Simple by Default, Powerful When Needed

- **No-Code Rule Builder**: Visual flow selection rules (click → CEL)
- **CEL Code Editor**: Monaco editor for advanced users
- **Provider Presets**: Common configurations as one-click options

---

## UI to Backend Communication

### Architecture Pattern

```
┌────────────────────────────────────────────────────────────────┐
│                         Studio Frontend                         │
├────────────────────────────────────────────────────────────────┤
│                                                                  │
│  PipelineEditor Component                                       │
│  ├─ usePipelineEditorStore (Zustand)                           │
│  │  ├─ currentDraft: PipelineDefinition | null                 │
│  │  ├─ lastPublished: PipelineDefinition | null                │
│  │  ├─ saveStatus: 'idle' | 'saving' | 'saved' | 'error'       │
│  │  └─ validationErrors: ValidationError[]                     │
│  │                                                               │
│  ├─ Actions                                                     │
│  │  ├─ loadPipeline(knowledgeBaseId)                           │
│  │  ├─ updateDraft(changes)                                     │
│  │  ├─ saveDraft() → PATCH /api/.../pipelines/:id              │
│  │  ├─ publishPipeline() → POST /api/.../pipelines/:id/publish│
│  │  └─ validatePipeline() → POST /api/.../pipelines/validate  │
│  │                                                               │
│  └─ UI Sections                                                 │
│     ├─ BasicSettings (name, description)                        │
│     ├─ FlowsSection (list of flows with rules)                 │
│     └─ ValidationPanel (errors/warnings)                        │
│                                                                  │
└──────────────────────────────────┬─────────────────────────────┘
                                   │
                      API Requests │ (Axios)
                                   │
┌──────────────────────────────────▼─────────────────────────────┐
│                      Backend API (Express)                      │
├────────────────────────────────────────────────────────────────┤
│                                                                  │
│  /api/projects/:projectId/knowledge-bases/:kbId/pipelines      │
│  ├─ GET    /          → Get pipeline definition                │
│  ├─ PATCH  /:id       → Update draft (status=draft)            │
│  ├─ POST   /:id/publish → Validate + set status=active         │
│  ├─ POST   /validate  → Run 18 validation rules                │
│  └─ POST   /simulate  → Test flow selection with doc           │
│                                                                  │
│  Services                                                       │
│  ├─ PipelineValidationService (18 rules)                       │
│  ├─ FlowSelectionService (CEL evaluation)                      │
│  └─ ProviderRegistry (schema discovery)                        │
│                                                                  │
└──────────────────────────────────┬─────────────────────────────┘
                                   │
                    Mongoose Save  │
                                   │
                    ┌──────────────▼──────────────┐
                    │     MongoDB (pipeline       │
                    │     _definitions collection)│
                    └─────────────────────────────┘
```

### Key Patterns

#### 1. Draft + Publish Model

- **Draft state**: Changes saved with `status: 'draft'` via PATCH
- **Published state**: Immutable, visible to ingestion pipeline
- **Autosave**: Debounced (2 seconds after last change) → PATCH request
- **Validation**: On publish only (not on draft save)

#### 2. Optimistic Updates

```typescript
// Immediate UI update
updateDraft({ flows: [...newFlows] });

// Async save in background
saveDraft().catch((err) => {
  // Revert UI + show error toast
  revertToDraft();
  toast.error('Save failed');
});
```

#### 3. Validation Timing

- **Client-side**: On blur (Zod validation) → instant feedback
- **Server-side**: On publish (full 18-rule validation) → block if errors

---

## Wiremocks

### Main Screen: Pipeline Editor

```
╔════════════════════════════════════════════════════════════════════════════════╗
║ Studio                                   [User Menu ▼]  [Settings ⚙]  [Help ?] ║
╠════════════════════════════════════════════════════════════════════════════════╣
║ Knowledge Bases > Enterprise KB > Pipeline Configuration                       ║
╠════════════════════════════════════════════════════════════════════════════════╣
║                                                                                 ║
║  ┌─────────────────────────────────────────────────────────────────────────┐  ║
║  │ Pipeline: Enterprise KB Pipeline                       [Draft] [Publish]│  ║
║  │                                                         [•••] More ▼     │  ║
║  ├─────────────────────────────────────────────────────────────────────────┤  ║
║  │                                                                           │  ║
║  │  ┌──────────────────────────────────────────────────────────────────┐   │  ║
║  │  │ 📋 Basic Settings                                         [Collapse]│  ║
║  │  ├──────────────────────────────────────────────────────────────────┤   │  ║
║  │  │                                                                    │   │  ║
║  │  │  Name *                                                            │   │  ║
║  │  │  [Enterprise KB Pipeline_________________________________]         │   │  ║
║  │  │                                                                    │   │  ║
║  │  │  Description                                                       │   │  ║
║  │  │  [Multi-flow pipeline with PDF and Office optimization___]        │   │  ║
║  │  │  [____________________________________________________________]   │   │  ║
║  │  │                                                                    │   │  ║
║  │  │  Status: 🟠 Draft  (last edited 2 minutes ago)                    │   │  ║
║  │  │                                                                    │   │  ║
║  │  └────────────────────────────────────────────────────────────────────┘  ║
║  │                                                                           │  ║
║  │  ┌──────────────────────────────────────────────────────────────────┐   │  ║
║  │  │ 🔀 Flows (3)                                              [Expand]│  ║
║  │  │                                                                    │   │  ║
║  │  │  When document is ingested, flows are evaluated by priority       │   │  ║
║  │  │  (lowest first). First matching flow processes the document.      │   │  ║
║  │  └──────────────────────────────────────────────────────────────────┘   │  ║
║  │                                                                           │  ║
║  │  ┌──────────────────────────────────────────────────────────────────┐   │  ║
║  │  │ ⚙️  Advanced Settings                                    [Expand]│  ║
║  │  │                                                                    │   │  ║
║  │  │  Provider Defaults, Shared Stages, Circuit Breakers...            │   │  ║
║  │  └──────────────────────────────────────────────────────────────────┘   │  ║
║  │                                                                           │  ║
║  └─────────────────────────────────────────────────────────────────────────┘  ║
║                                                                                 ║
║                                                          [Cancel] [Save Draft] ║
╚════════════════════════════════════════════════════════════════════════════════╝
```

### Flows Section (Expanded)

```
╔════════════════════════════════════════════════════════════════════════════════╗
║  🔀 Flows (3)                                                       [Collapse] ║
║                                                                                 ║
║  [+ Add Flow]  [📊 Test Selection]  [💰 Estimate Costs]                       ║
║                                                                                 ║
║  ┌──────────────────────────────────────────────────────────────────────────┐ ║
║  │ Flow 1: PDF Optimized                                   [Priority: 10 ▼] │ ║
║  │                                                          [⚙️ Configure]    │ ║
║  ├──────────────────────────────────────────────────────────────────────────┤ ║
║  │                                                                            │ ║
║  │  📐 Selection Rules                                                        │ ║
║  │  ┌────────────────────────────────────────────────────────────────────┐  │ ║
║  │  │ When should this flow be used?                                      │  │ ║
║  │  │                                                                      │  │ ║
║  │  │  [⚡ Visual Builder] [<> CEL Code]                                  │  │ ║
║  │  │                                                                      │  │ ║
║  │  │  ┌──────────────────────────────────────────────────────────────┐  │  │ ║
║  │  │  │ IF document.contentType == "application/pdf"                  │  │  │ ║
║  │  │  │ AND document.contentSizeBytes < 10485760 (10 MB)              │  │  │ ║
║  │  │  └──────────────────────────────────────────────────────────────┘  │  │ ║
║  │  │                                                                      │  │ ║
║  │  │  📋 CEL Expression (read-only preview):                             │  │ ║
║  │  │  ┌────────────────────────────────────────────────────────────────┐│  │ ║
║  │  │  │document.contentType == "application/pdf" &&                    ││  │ ║
║  │  │  │document.contentSizeBytes < 10485760                            ││  │ ║
║  │  │  └────────────────────────────────────────────────────────────────┘│  │ ║
║  │  │                                                                      │  │ ║
║  │  │  [+ Add Condition]                                                  │  │ ║
║  │  └────────────────────────────────────────────────────────────────────┘  │ ║
║  │                                                                            │ ║
║  │  🔧 Stages (5)                                                             │ ║
║  │  ┌────────────────────────────────────────────────────────────────────┐  │ ║
║  │  │ 1. Extraction → [Docling v2.5]                           [Edit ✏️] │  │ ║
║  │  │ 2. Chunking → [Recursive v2]                             [Edit ✏️] │  │ ║
║  │  │ 3. Embedding → [OpenAI text-embedding-3-large]           [Edit ✏️] │  │ ║
║  │  │ 4. Enrichment → [LLM Summary + Q&A]                      [Edit ✏️] │  │ ║
║  │  │ 5. Storage → [MongoDB + OpenSearch]                      [Edit ✏️] │  │ ║
║  │  └────────────────────────────────────────────────────────────────────┘  │ ║
║  │                                                                            │ ║
║  │  [⚠️ Add Fallback Provider] [🔄 Add Retry Logic]                         │ ║
║  │                                                                            │ ║
║  └──────────────────────────────────────────────────────────────────────────┘ ║
║                                                                                 ║
║  ┌──────────────────────────────────────────────────────────────────────────┐ ║
║  │ Flow 2: Office Documents                                [Priority: 20 ▼] │ ║
║  │                                                          [⚙️ Configure]    │ ║
║  ├──────────────────────────────────────────────────────────────────────────┤ ║
║  │                                                                            │ ║
║  │  📐 Selection Rules                                                        │ ║
║  │  ┌────────────────────────────────────────────────────────────────────┐  │ ║
║  │  │ IF document.contentType in ["application/vnd.openxmlformats-..."] │  │ ║
║  │  └────────────────────────────────────────────────────────────────────┘  │ ║
║  │                                                                            │ ║
║  │  🔧 Stages (5) — [Show Details ▼]                                         │ ║
║  │                                                                            │ ║
║  └──────────────────────────────────────────────────────────────────────────┘ ║
║                                                                                 ║
║  ┌──────────────────────────────────────────────────────────────────────────┐ ║
║  │ Flow 3: Default (Fallback)                              [Priority: 99 ▼] │ ║
║  │                                                          [⚙️ Configure]    │ ║
║  ├──────────────────────────────────────────────────────────────────────────┤ ║
║  │                                                                            │ ║
║  │  📐 Selection Rules                                                        │ ║
║  │  ┌────────────────────────────────────────────────────────────────────┐  │ ║
║  │  │ ✅ Always match (no rules)                                          │  │ ║
║  │  └────────────────────────────────────────────────────────────────────┘  │ ║
║  │                                                                            │ ║
║  │  🔧 Stages (4) — [Show Details ▼]                                         │ ║
║  │                                                                            │ ║
║  └──────────────────────────────────────────────────────────────────────────┘ ║
║                                                                                 ║
╚════════════════════════════════════════════════════════════════════════════════╝
```

### Visual Rule Builder (Slide-Over Panel)

```
╔════════════════════════════════════════════════════════════════════════════════╗
║                                                                      [Close ✕] ║
║  Configure Flow Selection Rules                                                ║
║  Specify when this flow should process documents                               ║
║                                                                                 ║
║  ─────────────────────────────────────────────────────────────────────────────║
║                                                                                 ║
║  Rule Builder                                                [⚡ Visual Mode]  ║
║                                                                                 ║
║  ┌──────────────────────────────────────────────────────────────────────────┐ ║
║  │ Condition 1                                                   [Remove ✕] │ ║
║  ├──────────────────────────────────────────────────────────────────────────┤ ║
║  │                                                                            │ ║
║  │  Field                                                                     │ ║
║  │  [document.contentType              ▼]                                    │ ║
║  │  ↓ contentType, contentSizeBytes, fileName, sourceType...                 │ ║
║  │                                                                            │ ║
║  │  Operator                                                                  │ ║
║  │  [equals (==)                       ▼]                                    │ ║
║  │  ↓ equals, not equals, in, not in, >, <, >=, <=, contains, startsWith... │ ║
║  │                                                                            │ ║
║  │  Value                                                                     │ ║
║  │  ["application/pdf"_________________________________________________]     │ ║
║  │                                                                            │ ║
║  └──────────────────────────────────────────────────────────────────────────┘ ║
║                                                                                 ║
║  ┌──────────────────────────────────────────────────────────────────────────┐ ║
║  │ Condition 2                                                   [Remove ✕] │ ║
║  ├──────────────────────────────────────────────────────────────────────────┤ ║
║  │                                                                            │ ║
║  │  Operator: [AND ▼] (between conditions)                                   │ ║
║  │                                                                            │ ║
║  │  Field                                                                     │ ║
║  │  [document.contentSizeBytes         ▼]                                    │ ║
║  │                                                                            │ ║
║  │  Operator                                                                  │ ║
║  │  [less than (<)                     ▼]                                    │ ║
║  │                                                                            │ ║
║  │  Value                                                                     │ ║
║  │  [10485760__________________________________________________________]     │ ║
║  │  (10 MB)                                                                   │ ║
║  │                                                                            │ ║
║  └──────────────────────────────────────────────────────────────────────────┘ ║
║                                                                                 ║
║  [+ Add Condition]                                                             ║
║                                                                                 ║
║  ─────────────────────────────────────────────────────────────────────────────║
║                                                                                 ║
║  📋 Generated CEL Expression                                 [Switch to Code] ║
║  ┌──────────────────────────────────────────────────────────────────────────┐ ║
║  │ document.contentType == "application/pdf" &&                             │ ║
║  │ document.contentSizeBytes < 10485760                                     │ ║
║  └──────────────────────────────────────────────────────────────────────────┘ ║
║                                                                                 ║
║  🧪 Test Expression                                                            ║
║  ┌──────────────────────────────────────────────────────────────────────────┐ ║
║  │ Sample Document:                                                          │ ║
║  │ [report.pdf ▼] (5.2 MB, application/pdf, S3)                             │ ║
║  │                                                                            │ ║
║  │ Result: ✅ MATCH (this flow will be used)                                 │ ║
║  └──────────────────────────────────────────────────────────────────────────┘ ║
║                                                                                 ║
║                                                      [Cancel] [Save Rules]     ║
║                                                                                 ║
╚════════════════════════════════════════════════════════════════════════════════╝
```

### Stage Configuration (Slide-Over Panel)

```
╔════════════════════════════════════════════════════════════════════════════════╗
║                                                                      [Close ✕] ║
║  Configure Stage: Extraction                                                   ║
║  Extract structured content from documents                                     ║
║                                                                                 ║
║  ─────────────────────────────────────────────────────────────────────────────║
║                                                                                 ║
║  Provider *                                                                    ║
║  [Docling v2.5                                              ▼]                ║
║  ↓ Docling v2.5, Docling v2.0, Apache Tika, PyMuPDF, Custom                  ║
║                                                                                 ║
║  Description: Fast PDF extraction with layout detection                        ║
║                                                                                 ║
║  ─────────────────────────────────────────────────────────────────────────────║
║                                                                                 ║
║  Configuration                                                                 ║
║                                                                                 ║
║  ┌──────────────────────────────────────────────────────────────────────────┐ ║
║  │ 🔑 Credentials                                                             │ ║
║  ├──────────────────────────────────────────────────────────────────────────┤ ║
║  │                                                                            │ ║
║  │  Credential Source                                                         │ ║
║  │  ● Pipeline Default (from pipeline settings)                              │ ║
║  │  ○ Override for this stage                                                │ ║
║  │                                                                            │ ║
║  └──────────────────────────────────────────────────────────────────────────┘ ║
║                                                                                 ║
║  ┌──────────────────────────────────────────────────────────────────────────┐ ║
║  │ ⚙️  Parameters                                                             │ ║
║  ├──────────────────────────────────────────────────────────────────────────┤ ║
║  │                                                                            │ ║
║  │  Extract Tables                                                            │ ║
║  │  [✓] Enabled                                                               │ ║
║  │                                                                            │ ║
║  │  Extract Images                                                            │ ║
║  │  [✓] Enabled                                                               │ ║
║  │                                                                            │ ║
║  │  OCR Mode                                                                  │ ║
║  │  [auto ▼] (auto, always, never)                                           │ ║
║  │                                                                            │ ║
║  │  Timeout (seconds)                                                         │ ║
║  │  [600_______________________________________________________________]     │ ║
║  │  Min: 60, Max: 1800                                                        │ ║
║  │                                                                            │ ║
║  └──────────────────────────────────────────────────────────────────────────┘ ║
║                                                                                 ║
║  ┌──────────────────────────────────────────────────────────────────────────┐ ║
║  │ 🔄 Resilience                                               [Show More ▼] │ ║
║  ├──────────────────────────────────────────────────────────────────────────┤ ║
║  │                                                                            │ ║
║  │  Retry Strategy                                                            │ ║
║  │  [✓] Enabled                                                               │ ║
║  │  Max Attempts: [3__]  Backoff: [exponential ▼]                            │ ║
║  │                                                                            │ ║
║  │  Fallback Provider                                                         │ ║
║  │  [Apache Tika ▼]  (if Docling fails)                                      │ ║
║  │                                                                            │ ║
║  │  Circuit Breaker                                                           │ ║
║  │  [✓] Enabled                                                               │ ║
║  │  Failure Threshold: [5__]  Timeout: [60000__] ms                          │ ║
║  │                                                                            │ ║
║  └──────────────────────────────────────────────────────────────────────────┘ ║
║                                                                                 ║
║  ─────────────────────────────────────────────────────────────────────────────║
║                                                                                 ║
║  💰 Cost Estimate: ~$0.015 per document (based on avg 100 pages)              ║
║                                                                                 ║
║                                                      [Cancel] [Save Stage]     ║
║                                                                                 ║
╚════════════════════════════════════════════════════════════════════════════════╝
```

### Test Flow Selection (Modal)

```
╔════════════════════════════════════════════════════════════════════════════════╗
║                                                                      [Close ✕] ║
║  🧪 Test Flow Selection                                                        ║
║                                                                                 ║
║  ─────────────────────────────────────────────────────────────────────────────║
║                                                                                 ║
║  Document Context                                                              ║
║                                                                                 ║
║  ┌──────────────────────────────────────────────────────────────────────────┐ ║
║  │ Sample from Knowledge Base                                                │ ║
║  │ [quarterly-report-q4-2025.pdf ▼]                                          │ ║
║  │ ↓ Last 10 ingested documents                                              │ ║
║  │                                                                            │ ║
║  │ OR Custom Test Document                                                   │ ║
║  │ ┌────────────────────────────────────────────────────────────────────┐   │ ║
║  │ │ Content Type: [application/pdf___________________________________] │   │ ║
║  │ │ Size (bytes):  [5242880_________________________________________] │   │ ║
║  │ │ File Name:     [report.pdf______________________________________] │   │ ║
║  │ │ Source Type:   [s3 ▼]                                              │   │ ║
║  │ │ Has Tables:    [✓]  Has Images: [✓]                                │   │ ║
║  │ └────────────────────────────────────────────────────────────────────┘   │ ║
║  └──────────────────────────────────────────────────────────────────────────┘ ║
║                                                                                 ║
║  [▶ Run Test]                                                                  ║
║                                                                                 ║
║  ─────────────────────────────────────────────────────────────────────────────║
║                                                                                 ║
║  Results                                                                       ║
║                                                                                 ║
║  ┌──────────────────────────────────────────────────────────────────────────┐ ║
║  │ ✅ Flow Selected: PDF Optimized (Priority 10)                             │ ║
║  │                                                                            │ ║
║  │ Evaluation Order:                                                          │ ║
║  │ 1. ✅ PDF Optimized (Priority 10)                                          │ ║
║  │    Rule: document.contentType == "application/pdf" &&                     │ ║
║  │          document.contentSizeBytes < 10485760                             │ ║
║  │    Result: MATCH ✓                                                         │ ║
║  │                                                                            │ ║
║  │ 2. ⏭️  Office Documents (Priority 20) — SKIPPED (earlier match)           │ ║
║  │                                                                            │ ║
║  │ 3. ⏭️  Default (Priority 99) — SKIPPED (earlier match)                    │ ║
║  │                                                                            │ ║
║  │ Stages to Execute:                                                         │ ║
║  │ 1. Extraction → Docling v2.5                                              │ ║
║  │ 2. Chunking → Recursive v2                                                │ ║
║  │ 3. Embedding → OpenAI text-embedding-3-large                              │ ║
║  │ 4. Enrichment → LLM Summary + Q&A                                         │ ║
║  │ 5. Storage → MongoDB + OpenSearch                                         │ ║
║  │                                                                            │ ║
║  │ 💰 Estimated Cost: $0.087 per document                                    │ ║
║  │    (Extraction: $0.015, Embedding: $0.012, Enrichment: $0.060)            │ ║
║  │                                                                            │ ║
║  └──────────────────────────────────────────────────────────────────────────┘ ║
║                                                                                 ║
║                                                                        [Close] ║
║                                                                                 ║
╚════════════════════════════════════════════════════════════════════════════════╝
```

### Validation Errors Display

```
╔════════════════════════════════════════════════════════════════════════════════╗
║  ⚠️  Validation Errors (2)                                                     ║
║                                                                                 ║
║  ┌──────────────────────────────────────────────────────────────────────────┐ ║
║  │ ❌ ERROR: Duplicate flow priorities                                       │ ║
║  │                                                                            │ ║
║  │ Flows "PDF Optimized" and "Office Documents" both have priority 10.      │ ║
║  │ Each flow must have a unique priority.                                    │ ║
║  │                                                                            │ ║
║  │ [Go to Flow 2 →]                                                          │ ║
║  └──────────────────────────────────────────────────────────────────────────┘ ║
║                                                                                 ║
║  ┌──────────────────────────────────────────────────────────────────────────┐ ║
║  │ ⚠️  WARNING: No fallback provider configured                              │ ║
║  │                                                                            │ ║
║  │ Stage "Extraction" in flow "PDF Optimized" has no fallback provider.     │ ║
║  │ If Docling v2.5 fails, the document will fail to process.                │ ║
║  │                                                                            │ ║
║  │ [Configure Fallback →]                                                    │ ║
║  └──────────────────────────────────────────────────────────────────────────┘ ║
║                                                                                 ║
╚════════════════════════════════════════════════════════════════════════════════╝
```

---

## Component Hierarchy

### File Structure

```
apps/studio/src/components/pipeline/
├── PipelineEditor.tsx                    (Main container)
│   ├── usePipelineEditorStore.ts        (Zustand store)
│   └── pipeline-api.ts                   (API client)
│
├── sections/
│   ├── BasicSettingsSection.tsx         (Name, description, status)
│   ├── FlowsSection.tsx                  (List of flows)
│   └── AdvancedSettingsSection.tsx      (Provider defaults, shared stages)
│
├── flow/
│   ├── FlowCard.tsx                      (Individual flow container)
│   ├── FlowSelectionRules.tsx           (Rules display + edit)
│   ├── FlowStagesList.tsx               (List of stages)
│   └── FlowTestModal.tsx                 (Test flow selection)
│
├── rules/
│   ├── RuleBuilder.tsx                   (Visual rule builder UI)
│   ├── RuleCondition.tsx                (Single condition row)
│   ├── CelCodeEditor.tsx                (Monaco editor for CEL)
│   └── RuleTestPanel.tsx                (Test expression with document)
│
├── stages/
│   ├── StageConfigPanel.tsx             (Slide-over for stage config)
│   ├── DynamicProviderForm.tsx          (JSON Schema → form fields)
│   ├── ResilienceSettings.tsx           (Retry, fallback, circuit breaker)
│   └── CostEstimator.tsx                (Per-stage cost calculation)
│
├── validation/
│   ├── ValidationPanel.tsx              (Error/warning display)
│   └── ValidationErrorCard.tsx          (Individual error card)
│
└── ui/
    ├── PriorityInput.tsx                (Number input with up/down)
    ├── ProviderSelect.tsx               (Dropdown with provider info)
    └── StatusBadge.tsx                  (Draft/Active/Archived badge)
```

### React Component Tree

```
PipelineEditor
├─ Breadcrumb (Knowledge Bases > KB Name > Pipeline)
├─ Header
│  ├─ Title + Status Badge
│  ├─ Actions: [Publish] [More Menu]
│  └─ Save Status: "Saving..." / "Saved" / "Error"
│
├─ SectionCard (Basic Settings)
│  ├─ Input: Name
│  ├─ Textarea: Description
│  └─ StatusBadge
│
├─ SectionCard (Flows)
│  ├─ Actions: [+ Add Flow] [Test Selection] [Estimate Costs]
│  ├─ FlowCard (for each flow)
│  │  ├─ Header
│  │  │  ├─ Name + Badge
│  │  │  ├─ PriorityInput
│  │  │  └─ Actions: [Configure] [Delete]
│  │  ├─ FlowSelectionRules
│  │  │  ├─ RuleDisplay (read-only CEL)
│  │  │  └─ Button: [Edit Rules] → opens RuleBuilder slide-over
│  │  └─ FlowStagesList
│  │     ├─ StageRow (for each stage)
│  │     │  ├─ Stage Type Icon
│  │     │  ├─ Provider Name
│  │     │  └─ Button: [Edit] → opens StageConfigPanel
│  │     └─ Button: [+ Add Stage]
│  │
│  └─ Button: [+ Add Flow] (dashed border)
│
├─ SectionCard (Advanced Settings)
│  ├─ ProviderDefaultsEditor (key-value pairs)
│  ├─ SharedStagesEditor (reusable stages)
│  └─ CircuitBreakerSettings (global thresholds)
│
├─ ValidationPanel (if errors/warnings)
│  └─ ValidationErrorCard (for each error)
│     ├─ Icon (❌ or ⚠️)
│     ├─ Message
│     └─ Action Button: [Go to Field]
│
└─ Footer
   ├─ Button: [Cancel]
   └─ Button: [Save Draft] or [Publish]

// Slide-Over Panels (overlays)
RuleBuilder (slide from right)
├─ Mode Toggle: [Visual] [Code]
├─ Visual Mode
│  ├─ RuleCondition (for each condition)
│  │  ├─ Select: Field
│  │  ├─ Select: Operator
│  │  ├─ Input: Value
│  │  └─ Button: [Remove]
│  └─ Button: [+ Add Condition]
├─ Code Mode
│  └─ CelCodeEditor (Monaco)
├─ CEL Preview (read-only)
├─ RuleTestPanel
│  ├─ Select: Sample Document
│  ├─ Button: [Run Test]
│  └─ Result Display
└─ Footer: [Cancel] [Save Rules]

StageConfigPanel (slide from right)
├─ ProviderSelect (dropdown)
├─ DynamicProviderForm (JSON Schema → fields)
├─ ResilienceSettings (collapsible)
│  ├─ Retry Strategy
│  ├─ Fallback Provider
│  └─ Circuit Breaker
├─ CostEstimator (per-stage)
└─ Footer: [Cancel] [Save Stage]

FlowTestModal (centered modal)
├─ DocumentContextForm
│  ├─ Select: Sample Document
│  └─ Custom Input Fields
├─ Button: [Run Test]
├─ ResultsPanel
│  ├─ Selected Flow
│  ├─ Evaluation Order
│  ├─ Stages to Execute
│  └─ Cost Estimate
└─ Footer: [Close]
```

---

## State Management

### Zustand Store Structure

```typescript
// File: apps/studio/src/components/pipeline/usePipelineEditorStore.ts

import { create } from 'zustand';
import { IPipelineDefinition, ValidationError } from '@abl/types';

interface PipelineEditorState {
  // Data
  currentDraft: IPipelineDefinition | null;
  lastPublished: IPipelineDefinition | null;

  // UI State
  expandedSections: Set<SectionId>;
  activeFlowId: string | null; // For slide-over context
  saveStatus: 'idle' | 'saving' | 'saved' | 'error';
  validationErrors: ValidationError[];
  isDirty: boolean; // Has unsaved changes

  // Actions
  loadPipeline: (knowledgeBaseId: string) => Promise<void>;
  updateDraft: (changes: Partial<IPipelineDefinition>) => void;
  saveDraft: () => Promise<void>;
  publishPipeline: () => Promise<void>;
  validatePipeline: () => Promise<ValidationError[]>;

  // Flow Actions
  addFlow: () => void;
  updateFlow: (flowId: string, changes: Partial<PipelineFlow>) => void;
  deleteFlow: (flowId: string) => void;
  reorderFlows: (flowId: string, newIndex: number) => void;

  // Stage Actions
  updateStage: (flowId: string, stageId: string, changes: Partial<PipelineStage>) => void;

  // UI Actions
  toggleSection: (sectionId: SectionId) => void;
  setActiveFlow: (flowId: string | null) => void;
  setSaveStatus: (status: SaveStatus) => void;
  setValidationErrors: (errors: ValidationError[]) => void;
}

export const usePipelineEditorStore = create<PipelineEditorState>((set, get) => ({
  currentDraft: null,
  lastPublished: null,
  expandedSections: new Set(['BASIC_SETTINGS', 'FLOWS']),
  activeFlowId: null,
  saveStatus: 'idle',
  validationErrors: [],
  isDirty: false,

  loadPipeline: async (knowledgeBaseId) => {
    const pipeline = await api.getPipeline(knowledgeBaseId);
    set({
      currentDraft: pipeline,
      lastPublished: pipeline.status === 'active' ? pipeline : null,
      isDirty: false,
    });
  },

  updateDraft: (changes) => {
    set((state) => ({
      currentDraft: { ...state.currentDraft, ...changes },
      isDirty: true,
    }));

    // Debounced autosave (2 seconds)
    const { saveDraft } = get();
    clearTimeout(get().autosaveTimer);
    set({ autosaveTimer: setTimeout(saveDraft, 2000) });
  },

  saveDraft: async () => {
    const { currentDraft } = get();
    if (!currentDraft) return;

    set({ saveStatus: 'saving' });
    try {
      const updated = await api.updatePipeline(currentDraft._id, currentDraft);
      set({
        currentDraft: updated,
        saveStatus: 'saved',
        isDirty: false,
      });

      // Clear saved status after 3 seconds
      setTimeout(() => set({ saveStatus: 'idle' }), 3000);
    } catch (error) {
      set({ saveStatus: 'error' });
      toast.error('Failed to save pipeline');
    }
  },

  publishPipeline: async () => {
    const { currentDraft, validatePipeline } = get();
    if (!currentDraft) return;

    // Validate first
    const errors = await validatePipeline();
    if (errors.some((e) => e.severity === 'error')) {
      toast.error('Cannot publish: validation errors must be fixed');
      return;
    }

    set({ saveStatus: 'saving' });
    try {
      const published = await api.publishPipeline(currentDraft._id);
      set({
        currentDraft: published,
        lastPublished: published,
        saveStatus: 'saved',
        isDirty: false,
      });
      toast.success('Pipeline published successfully');
    } catch (error) {
      set({ saveStatus: 'error' });
      toast.error('Failed to publish pipeline');
    }
  },

  validatePipeline: async () => {
    const { currentDraft } = get();
    if (!currentDraft) return [];

    const errors = await api.validatePipeline(currentDraft);
    set({ validationErrors: errors });
    return errors;
  },

  // ... other actions
}));
```

### Form State Management

- **Draft state** lives in Zustand store (single source of truth)
- **Form fields** use controlled components reading from store
- **Updates** flow: onChange → updateDraft() → debounced saveDraft()
- **No React Hook Form** needed for this editor (too much nested state)

---

## API Specifications

### Endpoints

#### 1. Get Pipeline Definition

```
GET /api/projects/:projectId/knowledge-bases/:kbId/pipelines
```

**Authentication:** Required (Bearer token)
**Permission:** `knowledge-base:read`

**Response:**

```json
{
  "success": true,
  "data": {
    "_id": "677c1a2b3d4e5f6a7b8c9d0e",
    "tenantId": "tenant_123",
    "knowledgeBaseId": "kb_456",
    "name": "Enterprise KB Pipeline",
    "version": 5,
    "status": "active",
    "flows": [
      {
        "id": "flow_1",
        "name": "PDF Optimized",
        "priority": 10,
        "selectionRules": {
          "type": "cel",
          "expression": "document.contentType == \"application/pdf\" && document.contentSizeBytes < 10485760"
        },
        "stages": [
          {
            "id": "stage_1",
            "type": "extraction",
            "providerId": "docling-v2.5",
            "config": {
              "extractTables": true,
              "extractImages": true,
              "ocrMode": "auto",
              "timeout": 600
            },
            "errorHandling": {
              "retryStrategy": {
                "maxAttempts": 3,
                "backoff": "exponential"
              },
              "fallbackProviderId": "apache-tika"
            }
          }
          // ... more stages
        ]
      }
      // ... more flows
    ],
    "createdAt": "2026-01-15T10:30:00Z",
    "updatedAt": "2026-03-07T14:22:00Z"
  }
}
```

**Error Responses:**

```json
// 401 Unauthorized
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authentication required. Please provide a valid bearer token."
  }
}

// 403 Forbidden
{
  "success": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "Insufficient permissions. Required permission: knowledge-base:read"
  }
}

// 404 Not Found
{
  "success": false,
  "error": {
    "code": "PIPELINE_NOT_FOUND",
    "message": "Pipeline not found for knowledge base"
  }
}

// 500 Internal Server Error
{
  "success": false,
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "An unexpected error occurred. Please try again later.",
    "traceId": "trace-12345"
  }
}
```

#### 2. Update Pipeline (Draft)

```
PATCH /api/projects/:projectId/knowledge-bases/:kbId/pipelines/:pipelineId
```

**Authentication:** Required (Bearer token)
**Permission:** `knowledge-base:update`

**Request:**

```json
{
  "name": "Updated Pipeline Name",
  "flows": [
    // ... updated flows array
  ]
}
```

**Response:**

```json
{
  "success": true,
  "data": {
    // ... updated pipeline definition
    "version": 6 // auto-incremented
  }
}
```

#### 3. Publish Pipeline

```
POST /api/projects/:projectId/knowledge-bases/:kbId/pipelines/:pipelineId/publish
```

**Authentication:** Required (Bearer token)
**Permission:** `knowledge-base:update`

**Request:** None (idempotent)

**Response:**

```json
{
  "success": true,
  "data": {
    // ... pipeline with status: "active"
    "validationResults": {
      "errors": [],
      "warnings": [
        {
          "code": "NO_FALLBACK_PROVIDER",
          "message": "Stage 'extraction' has no fallback provider",
          "path": "flows[0].stages[0]"
        }
      ]
    }
  }
}
```

**Error (validation failed):**

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Pipeline validation failed",
    "validationErrors": [
      {
        "code": "DUPLICATE_FLOW_PRIORITY",
        "severity": "error",
        "message": "Flows 'PDF Optimized' and 'Office Documents' have duplicate priority 10",
        "path": "flows[0].priority"
      }
    ]
  }
}
```

#### 4. Validate Pipeline

```
POST /api/projects/:projectId/knowledge-bases/:kbId/pipelines/validate
```

**Authentication:** Required (Bearer token)
**Permission:** `knowledge-base:read`

**Request:**

```json
{
  "pipeline": {
    // ... full pipeline definition to validate
  }
}
```

**Response:**

```json
{
  "success": true,
  "data": {
    "valid": false,
    "errors": [
      {
        "code": "DUPLICATE_FLOW_PRIORITY",
        "severity": "error",
        "message": "Flows have duplicate priorities",
        "path": "flows[0].priority"
      }
    ],
    "warnings": [
      {
        "code": "NO_FALLBACK_PROVIDER",
        "severity": "warning",
        "message": "No fallback provider configured",
        "path": "flows[0].stages[0]"
      }
    ]
  }
}
```

#### 5. Test Flow Selection

```
POST /api/projects/:projectId/knowledge-bases/:kbId/pipelines/:pipelineId/test-selection
```

**Authentication:** Required (Bearer token)
**Permission:** `knowledge-base:read`

**Request:**

```json
{
  "documentContext": {
    "contentType": "application/pdf",
    "contentSizeBytes": 5242880,
    "fileName": "report.pdf",
    "sourceType": "s3",
    "hasTables": true,
    "hasImages": true
  }
}
```

**Response:**

```json
{
  "success": true,
  "data": {
    "selectedFlow": {
      "id": "flow_1",
      "name": "PDF Optimized",
      "priority": 10
    },
    "evaluationOrder": [
      {
        "flowId": "flow_1",
        "flowName": "PDF Optimized",
        "priority": 10,
        "matched": true,
        "expression": "document.contentType == \"application/pdf\" && document.contentSizeBytes < 10485760"
      },
      {
        "flowId": "flow_2",
        "flowName": "Office Documents",
        "priority": 20,
        "matched": false,
        "skipped": true,
        "reason": "Earlier flow matched"
      }
    ],
    "stagesToExecute": [
      {
        "stageId": "stage_1",
        "type": "extraction",
        "providerId": "docling-v2.5"
      }
      // ... more stages
    ],
    "costEstimate": {
      "total": 0.087,
      "breakdown": [
        { "stage": "extraction", "cost": 0.015 },
        { "stage": "embedding", "cost": 0.012 },
        { "stage": "enrichment", "cost": 0.06 }
      ]
    }
  }
}
```

#### 6. Get Provider Schemas

```
GET /api/projects/:projectId/providers/:stageType/schemas
```

**Authentication:** Required (Bearer token)
**Permission:** `project:read`

**Response:**

```json
{
  "success": true,
  "data": {
    "providers": [
      {
        "id": "docling-v2.5",
        "name": "Docling v2.5",
        "description": "Fast PDF extraction with layout detection",
        "stageType": "extraction",
        "configSchema": {
          "type": "object",
          "properties": {
            "extractTables": {
              "type": "boolean",
              "default": true,
              "description": "Extract tables from documents"
            },
            "extractImages": {
              "type": "boolean",
              "default": true
            },
            "ocrMode": {
              "type": "string",
              "enum": ["auto", "always", "never"],
              "default": "auto"
            },
            "timeout": {
              "type": "number",
              "minimum": 60,
              "maximum": 1800,
              "default": 600
            }
          },
          "required": ["timeout"]
        },
        "costModel": {
          "type": "per_page",
          "baseRate": 0.0015,
          "unit": "page"
        }
      }
      // ... more providers
    ]
  }
}
```

---

## User Flows

### Flow 1: Create Pipeline with Default Flows

```
1. User navigates to Knowledge Base settings
2. Clicks "Pipeline Configuration" tab
3. System shows:
   - Pipeline editor with 3 default flows (PDF, Office, Default)
   - Each flow pre-configured with standard stages
4. User reviews defaults
5. Clicks "Publish"
6. System validates, shows warnings (no errors)
7. User confirms publish
8. Pipeline active, ingestion uses new flows
```

**Time:** ~2 minutes (no custom configuration needed)

### Flow 2: Add Custom Flow for Large PDFs

```
1. User opens pipeline editor (3 existing flows)
2. Clicks [+ Add Flow]
3. System creates "Flow 4" with empty stages
4. User enters:
   - Name: "Large PDF Processing"
   - Priority: 5 (lower than PDF Optimized priority 10)
5. Clicks [Edit Rules]
6. In Visual Rule Builder:
   - Field: document.contentType
   - Operator: equals
   - Value: "application/pdf"
   - [+ Add Condition]
   - Operator: AND
   - Field: document.contentSizeBytes
   - Operator: greater than or equal to
   - Value: 10485760 (10 MB)
7. Clicks [Save Rules]
8. Back in flow card, user adds stages:
   - [+ Add Stage] → Extraction → PyMuPDF (lighter than Docling)
   - [+ Add Stage] → Chunking → Recursive v2
   - [+ Add Stage] → Embedding → OpenAI text-embedding-3-small (cheaper)
   - [+ Add Stage] → Storage → MongoDB + OpenSearch
9. User clicks [Test Selection]
   - Selects sample large PDF (15 MB)
   - Clicks [Run Test]
   - System shows: ✅ Flow "Large PDF Processing" selected
10. User clicks [Save Draft] (autosaved already)
11. User clicks [Publish]
12. System validates → no errors
13. Pipeline published, ingestion routes large PDFs to new flow
```

**Time:** ~5-8 minutes (custom flow with testing)

### Flow 3: Configure Fallback Provider

```
1. User opens pipeline editor
2. Expands "Flow 1: PDF Optimized"
3. Clicks [Edit] on "Extraction" stage
4. Slide-over opens with stage config
5. User scrolls to "Resilience" section
6. Expands "Resilience" section
7. Enables "Fallback Provider"
8. Selects "Apache Tika" from dropdown
9. Clicks [Save Stage]
10. Slide-over closes, flow card updates
11. User clicks [Save Draft]
12. Warning clears: "No fallback provider configured"
```

**Time:** ~1 minute

### Flow 4: Debug Failed Document with Flow Test

```
1. User receives alert: "Document X failed to process"
2. User opens pipeline editor
3. Clicks [Test Selection]
4. Selects failed document from dropdown
5. Clicks [Run Test]
6. System shows:
   - ❌ No flow matched
   - Flow 1: Not matched (contentType is "text/html", expected PDF)
   - Flow 2: Not matched (contentType is "text/html", expected Office)
   - Flow 3 (Default): Should match (no rules)
7. User realizes: Flow 3 is missing Extraction stage
8. User clicks [Close]
9. Expands "Flow 3: Default"
10. Clicks [+ Add Stage] → Extraction → Apache Tika
11. Moves new stage to position 1 (before Chunking)
12. Clicks [Save Draft]
13. Clicks [Test Selection] again
14. System shows: ✅ Flow 3 matched, all stages present
15. User clicks [Publish]
16. Re-triggers failed document ingestion
```

**Time:** ~4 minutes (debugging + fix)

---

## Implementation References

### Existing Studio Patterns

| Pattern                       | Reference File                                               | Usage in Pipeline Editor                             |
| ----------------------------- | ------------------------------------------------------------ | ---------------------------------------------------- |
| **Dynamic JSON Schema Forms** | `apps/studio/src/components/tools/DynamicToolInputForm.tsx`  | Stage configuration forms (provider-specific fields) |
| **Rule Builder Cards**        | `apps/studio/src/components/agent-detail/RulesSection.tsx`   | Flow selection rules editor                          |
| **Slide-Over Panels**         | `apps/studio/src/components/ui/SlidePanel.tsx`               | Stage config, rule builder                           |
| **Collapsible Sections**      | `apps/studio/src/components/agent-detail/SectionCard.tsx`    | Flow cards, advanced settings                        |
| **Validation Display**        | `apps/studio/src/components/ui/Alert.tsx`                    | Validation error/warning panel                       |
| **Zustand Store**             | `apps/studio/src/store/spec-generation-store.ts`             | Pipeline editor state management                     |
| **Provider Select**           | `apps/studio/src/components/tools/LambdaConfigForm.tsx`      | Provider dropdown with dynamic forms                 |
| **Key-Value Editor**          | `apps/studio/src/components/test-context/VariableEditor.tsx` | Provider defaults editor                             |
| **Badge Status**              | `apps/studio/src/components/ui/Badge.tsx`                    | Draft/Active/Archived status                         |

### Studio Design Tokens

```typescript
// Colors (from Tailwind config)
colors: {
  background: 'hsl(240 10% 8%)',        // Main background
  'background-subtle': 'hsl(240 9% 11%)', // Cards, inputs
  'border-default': 'hsl(240 8% 20%)',   // Default borders
  accent: 'hsl(263 70% 60%)',            // Violet accent
  error: 'hsl(0 72% 51%)',               // Error red
  warning: 'hsl(38 92% 50%)',            // Warning orange
  success: 'hsl(142 72% 29%)',           // Success green
  muted: 'hsl(240 5% 45%)',              // Secondary text
}

// Typography
fontFamily: {
  sans: ['Inter', 'system-ui', 'sans-serif'],
  mono: ['JetBrains Mono', 'monospace'],
}

// Spacing (for consistent layout)
spacing: {
  section: '1.5rem',      // Between sections
  card: '0.75rem',        // Card padding
  input: '0.5rem',        // Input padding
}
```

---

## Next Steps

### Phase 1: Wiremock Approval (This Document)

- ✅ Review wiremocks with stakeholders
- ✅ Validate UI flow patterns
- ✅ Confirm API specifications
- [ ] Get approval to proceed

### Phase 2: Implementation Design (Task #65)

Once wiremocks approved, design:

- Component architecture (detailed props, types)
- API client implementation (axios, error handling)
- Validation logic (client + server)
- State management (Zustand stores)
- Form generation (JSON Schema → React components)
- CEL expression builder (Monaco integration)

### Phase 3: Development

- Build components following Studio design system
- Implement API endpoints with validation
- Integration testing
- E2E testing with real pipeline execution

---

## Open Questions

1. **Cost Estimation**: Should it be live (on every config change) or on-demand (click button)?
   - **Recommendation**: On-demand to avoid excessive API calls

2. **Draft Autosave**: 2-second debounce acceptable? Or longer?
   - **Recommendation**: 2 seconds (matches Google Docs pattern)

3. **Flow Simulation**: Should it show estimated execution time per stage?
   - **Recommendation**: Yes, add to cost estimate

4. **Rule Builder**: Support nested AND/OR groups, or flat list with AND/OR between conditions?
   - **Recommendation**: Start flat (simpler), add nesting in v2 if needed

5. **React Flow Canvas**: Required for MVP, or can we launch with card list view only?
   - **Recommendation**: Card list for MVP, canvas view in v2 (React Flow is 350KB)

---

**End of Document**

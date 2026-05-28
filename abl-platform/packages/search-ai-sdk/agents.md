# search-ai-sdk learnings

Append-only log of cross-cutting patterns and gotchas discovered while working in the search-ai-sdk package.

## 2026-05-15 — Workflow Docling Extraction Queue + Type (Phase 1) — ABLP-1073

**Category**: pattern
**Learning**: The SDK is the cross-app contract between the workflow-engine (producer of `workflow-docling-extraction` jobs) and the search-ai worker (consumer). Two new exports: `QUEUE_WORKFLOW_DOCLING_EXTRACTION` constant and `WorkflowDoclingExtractionJobData` type. Types live under `src/types/extraction.ts` (NOT `src/types.ts` — the actual layout is a `src/types/` directory with a barrel `src/types/index.ts`; do not author flat `types.ts` files in this package). The producer-side `DoclingExtractionJobData` (ingestion-path shape) is NOT re-exported from the SDK — it remains worker-local in `apps/search-ai/src/workers/docling-extraction-worker.ts` because only the workflow-path shape needs cross-app visibility. The runtime branch (`mode === 'extraction-only'`) is the discriminator for the worker's `processDoclingExtractionJob` dispatch.

**Files**: `src/types/extraction.ts`, `src/types/index.ts` (barrel), `src/index.ts` (re-export queue constant + type guard).

**Impact**: New worker types that cross app boundaries should follow the same "SDK owns the cross-app shape, worker owns the local shape" asymmetry. The SDK is a leaf package — never depend on apps from here.

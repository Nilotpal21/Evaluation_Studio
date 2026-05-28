# SDLC Log: Multimodal Processing - Phase 1 (Feature Spec)

> **Date:** 2026-03-22
> **Phase:** Feature Specification
> **Feature ID:** #40

## Summary

Generated comprehensive feature spec for the multimodal-processing feature covering the full spectrum of content processing (images, documents, audio, video) through specialized services (Docling, BGE-M3, preprocessing, vision, transcription).

## Codebase Analysis

### Existing Infrastructure Found

1. **Docling Service** (`services/docling-service/app.py`): FastAPI service for document extraction (PDF, DOCX, PPTX, HTML, images) with OCR, table extraction, image extraction, and page screenshots.
2. **BGE-M3 Service** (`services/bge-m3-service/app.py`): Flask service providing OpenAI-compatible embedding API with 1024-dim vectors.
3. **Preprocessing Service** (`services/preprocessing-service/app.py`): Flask service for multilingual query preprocessing with spell correction, synonym expansion, entity extraction.
4. **Multimodal Worker** (`apps/search-ai/src/workers/multimodal-worker.ts`): BullMQ worker processing chunks with images/tables via LLM Hub.
5. **Visual Enrichment Worker** (`apps/search-ai/src/workers/visual-enrichment-worker.ts`): Phase 3 page-by-page visual enrichment with progressive context.
6. **Document Visual Enrichment Worker** (`apps/search-ai/src/workers/document-visual-enrichment-worker.ts`): Document-level visual summary generation.
7. **Docling Extraction Worker** (`apps/search-ai/src/workers/docling-extraction-worker.ts`): Calls Docling service, uploads to S3, stores pages in MongoDB.
8. **Vision Service** (`apps/search-ai/src/services/vision/index.ts`): Provider-agnostic vision analysis with progressive context.
9. **MultiModal Enricher** (`apps/search-ai/src/services/multimodal/index.ts`): Image description and table summarization service.

### Data Models Found

- `Attachment` model with `image | document | audio | video` categories
- `TenantAttachmentConfig` with per-tenant processing toggles
- `DocumentPage` with page-level extraction results
- `SearchDocument` with content hash deduplication
- `SearchPipelineDefinition` with `multimodal` stage type
- `VisualAnalysisMetadata`, `ScreenshotAnalysis`, `VisualDocumentSummary` types

### Gaps Identified

1. **No audio transcription service** -- Attachment model supports `audio` category but no transcription worker exists.
2. **No video processing service** -- Attachment model supports `video` category but no video processing worker exists.
3. **No attachment-to-search bridge** -- Attachments from conversations are not routed to SearchAI pipeline.
4. **Fragmented multimodal workers** -- Three overlapping workers (multimodal, visual-enrichment, document-visual-enrichment).
5. **TenantAttachmentConfig not enforced** -- Config exists but worker enforcement is inconsistent.

## Decisions Made

| #   | Decision                                      | Classification | Rationale                                                        |
| --- | --------------------------------------------- | -------------- | ---------------------------------------------------------------- |
| 1   | Support both API and self-hosted Whisper      | DECIDED        | Flexibility for cost-sensitive vs. latency-sensitive deployments |
| 2   | Time-based key frame sampling (30s)           | DECIDED        | Simple, predictable, scene-change detection as P2                |
| 3   | Async attachment bridge via BullMQ            | DECIDED        | Aligns with existing pipeline architecture                       |
| 4   | Cost attribution per knowledge base           | DECIDED        | Matches existing per-index LLM config resolution                 |
| 5   | 30-minute max video length                    | DECIDED        | Balances utility vs. resource consumption                        |
| 6   | Refresh visual summary on incremental updates | INFERRED       | Consistent with progressive summarization pattern                |
| 7   | Skip unsupported formats gracefully           | DECIDED        | Better UX than hard failures                                     |

## Artifact

- **Location:** `docs/features/multimodal-processing.md`
- **Sections:** 18/18 (all template sections covered)
- **FRs:** 24 functional requirements
- **NFRs:** 10 non-functional requirements
- **User Stories:** 7

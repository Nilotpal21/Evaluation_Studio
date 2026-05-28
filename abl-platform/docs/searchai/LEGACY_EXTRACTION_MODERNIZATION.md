# Legacy Extraction Modernization - Task-Based Approach

> **Goal**: Replace legacy text extraction with modern frameworks for better quality and maintainability
> **Status**: Planning
> **Date**: 2026-02-23

---

## Problem Statement

### Current Issues with Legacy Extraction

1. **Quality**: Basic string splitting loses document structure
2. **Maintenance**: Frequent updates needed as formats evolve
3. **Missing Features**: No semantic chunking, no code-aware parsing, no structured data handling

### Current Legacy Path (6 MIME types)

```
TXT, MD, JSON, CSV, XML → Basic extraction → Fixed chunking → Poor quality
```

### Documents Going Through Legacy Path (~15% of uploads)

- `text/plain` - Plain text files
- `text/markdown` - Markdown documentation
- `application/json` - JSON data
- `text/csv` - CSV files
- `application/xml` / `text/xml` - XML documents

---

## Solution Architecture

### New Modernized Path

```
┌─────────────────────────────────────────────────────┐
│ Document Upload → Route by MIME Type                │
└──────────────┬──────────────────────────────────────┘
               │
    ┌──────────┴─────────────┐
    │                        │
    ▼                        ▼
┌────────────────┐    ┌──────────────────────┐
│ Docling Path   │    │ Smart Text Path NEW  │
│ (Python)       │    │ (LlamaIndex/Unified) │
└────────┬───────┘    └──────────┬───────────┘
         │                       │
         ▼                       ▼
    PDF, DOCX,           TXT, MD, JSON, CSV
    HTML, Images         XML, Code Files
         │                       │
         │                       ▼
         │              ┌────────────────────┐
         │              │ Format-Specific    │
         │              │ Loaders            │
         │              │ (LlamaIndex)       │
         │              └─────────┬──────────┘
         │                        │
         │                        ▼
         │              ┌────────────────────┐
         │              │ Semantic Chunking  │
         │              │ (Sentence-aware)   │
         │              └─────────┬──────────┘
         │                        │
         └────────────────────────┘
                      │
                      ▼
           ┌──────────────────────┐
           │ Markdown-Aware       │
           │ Chunking             │
           │ (Unified/Remark)     │
           └──────────┬───────────┘
                      │
                      ▼
              [Semantic Chunks]
                      │
                      ▼
           Embedding → OpenSearch
```

---

## Task Breakdown - Resumable Approach

### 🎯 Phase 1: Foundation (1-2 days)

#### Task 1.1: Setup LlamaIndex in Legacy Worker

**Status**: Not Started
**Files**: `apps/search-ai/src/workers/extraction-worker.ts`
**Dependencies**: None

**Subtasks**:

- [ ] Add LlamaIndex Python dependency to package.json
- [ ] Create Python service wrapper for LlamaIndex (similar to Docling service)
- [ ] Add health check endpoint
- [ ] Test basic text loading

**Acceptance Criteria**:

- Python service starts successfully
- Can load a TXT file and return parsed content
- Health check returns 200

**Resume Point**: If interrupted, service scaffold exists and can continue from loaders

---

#### Task 1.2: Implement Format Loaders

**Status**: Not Started
**Files**: `services/llamaindex-service/loaders.py` (new)
**Dependencies**: Task 1.1

**Subtasks**:

- [ ] TXT loader (SimpleDirectoryReader)
- [ ] Markdown loader (MarkdownReader)
- [ ] JSON loader (JSONReader)
- [ ] CSV loader (CSVReader)
- [ ] XML loader (XMLReader)

**Acceptance Criteria**:

- Each loader returns Document objects
- Metadata extracted (filename, type, size)
- All 5 formats tested with sample files

**Resume Point**: Loaders are independent - can implement one at a time

---

#### Task 1.3: Add Semantic Chunking

**Status**: Not Started
**Files**: `services/llamaindex-service/chunkers.py` (new)
**Dependencies**: Task 1.2

**Subtasks**:

- [ ] Implement SentenceSplitter (respects sentence boundaries)
- [ ] Configure chunk_size: 1024, overlap: 200
- [ ] Add metadata to chunks (position, parent_doc_id)
- [ ] Test with various text lengths

**Acceptance Criteria**:

- Chunks respect sentence boundaries (no mid-sentence cuts)
- Overlap works correctly
- Chunks include position metadata

**Resume Point**: Chunker is self-contained, can tune parameters separately

---

### 🎯 Phase 2: Markdown-Aware Chunking (2-3 days)

#### Task 2.1: Setup Unified/Remark Pipeline

**Status**: Not Started
**Files**: `packages/search-ai-internal/src/chunking/markdown-chunker.ts` (new)
**Dependencies**: Task 1.3

**Subtasks**:

- [ ] Add unified, remark-parse, remark-gfm dependencies
- [ ] Create markdown AST parser
- [ ] Extract heading hierarchy
- [ ] Test with sample markdown files

**Acceptance Criteria**:

- Can parse markdown to AST
- Identifies H1, H2, H3 headings
- Handles GFM (tables, code blocks, lists)

**Resume Point**: AST parser is independent, chunking logic comes next

---

#### Task 2.2: Implement Structure-Aware Chunking

**Status**: Not Started
**Files**: `packages/search-ai-internal/src/chunking/markdown-chunker.ts`
**Dependencies**: Task 2.1

**Subtasks**:

- [ ] Chunk by heading boundaries (H1, H2 = section breaks)
- [ ] Keep code blocks intact (don't split)
- [ ] Keep tables intact
- [ ] Keep lists together
- [ ] Add section hierarchy to chunk metadata

**Acceptance Criteria**:

- Chunks align with document structure
- Code blocks never split mid-block
- Chunk metadata includes heading path (h1 > h2 > h3)

**Resume Point**: Each chunking rule is independent (code blocks, tables, lists)

---

#### Task 2.3: Integrate Markdown Chunker into Pipeline

**Status**: Not Started
**Files**: `apps/search-ai/src/workers/canonical-mapper-worker.ts`
**Dependencies**: Task 2.2

**Subtasks**:

- [ ] Detect markdown content (from Docling or LlamaIndex)
- [ ] Route to markdown chunker instead of fixed/semantic
- [ ] Preserve existing behavior for non-markdown
- [ ] Add metrics for markdown vs non-markdown chunks

**Acceptance Criteria**:

- Markdown files use new chunker
- Non-markdown files use existing chunker
- Metrics show routing distribution

**Resume Point**: Router is separate from chunker logic

---

### 🎯 Phase 3: HTML → Markdown Pipeline (1 day)

#### Task 3.1: HTML Markdown Conversion (Already Done!)

**Status**: ✅ Complete
**Files**: `services/docling-service/app.py`
**Dependencies**: None

**Notes**:

- Docling already converts HTML → Markdown via `doc.export_to_markdown()`
- Tested and working (12/12 formats validated)
- HTML files already routed to Docling path

**No work needed** - HTML is handled!

---

### 🎯 Phase 4: Update Legacy Extraction Worker (2-3 days)

#### Task 4.1: Create LlamaIndex Service (FastAPI)

**Status**: Not Started
**Files**: `services/llamaindex-service/app.py` (new)
**Dependencies**: Tasks 1.1, 1.2, 1.3

**Subtasks**:

- [ ] FastAPI app structure
- [ ] POST /extract endpoint (similar to Docling service)
- [ ] Accept file upload + options
- [ ] Return chunked content with metadata
- [ ] Health check endpoint

**Acceptance Criteria**:

- Service starts on port 8081
- Can extract TXT, MD, JSON, CSV, XML
- Returns chunks with metadata
- Health check works

**Resume Point**: Endpoint structure independent of loader details

---

#### Task 4.2: Update Extraction Worker to Call LlamaIndex Service

**Status**: Not Started
**Files**: `apps/search-ai/src/workers/extraction-worker.ts`
**Dependencies**: Task 4.1

**Subtasks**:

- [ ] Add HTTP client for LlamaIndex service
- [ ] Download file from S3/local
- [ ] Call /extract endpoint
- [ ] Parse response and create chunks
- [ ] Store chunks in MongoDB

**Acceptance Criteria**:

- Worker calls LlamaIndex service for legacy formats
- Chunks stored correctly
- Error handling (service down, invalid file)

**Resume Point**: HTTP client is independent, storage logic comes next

---

#### Task 4.3: Add Fallback to Old Extraction

**Status**: Not Started
**Files**: `apps/search-ai/src/workers/extraction-worker.ts`
**Dependencies**: Task 4.2

**Subtasks**:

- [ ] Try LlamaIndex service first
- [ ] On failure, fall back to legacy extraction
- [ ] Log which path was used (metrics)
- [ ] Emit trace events for observability

**Acceptance Criteria**:

- Graceful degradation if service unavailable
- Metrics track new vs old extraction usage
- No document extraction failures

**Resume Point**: Fallback is independent, can tune retry logic separately

---

### 🎯 Phase 5: Code File Support (Optional, 2-3 days)

#### Task 5.1: Add Code File Loaders

**Status**: Not Started (Optional)
**Files**: `services/llamaindex-service/loaders.py`
**Dependencies**: Task 4.3

**Subtasks**:

- [ ] Python (.py) - AST-aware chunking
- [ ] JavaScript/TypeScript (.js, .ts) - AST-aware
- [ ] Java (.java)
- [ ] Go (.go)
- [ ] Detect syntax errors gracefully

**Acceptance Criteria**:

- Can parse source code files
- Preserves function/class boundaries
- Syntax errors don't crash extraction

**Resume Point**: Each language loader is independent

---

#### Task 5.2: AST-Aware Chunking for Code

**Status**: Not Started (Optional)
**Files**: `services/llamaindex-service/chunkers.py`
**Dependencies**: Task 5.1

**Subtasks**:

- [ ] Chunk by function boundaries
- [ ] Chunk by class boundaries
- [ ] Keep docstrings with functions
- [ ] Add metadata (function name, class name, imports)

**Acceptance Criteria**:

- Functions never split mid-function
- Chunk metadata includes function/class names
- Useful for code search

**Resume Point**: AST parsing is separate from chunking logic

---

### 🎯 Phase 6: Testing & Validation (2-3 days)

#### Task 6.1: Create Test Suite for Each Format

**Status**: Not Started
**Files**: `services/llamaindex-service/test_formats.py` (new)
**Dependencies**: Task 4.3

**Subtasks**:

- [ ] TXT extraction test
- [ ] Markdown extraction + chunking test
- [ ] JSON extraction test
- [ ] CSV extraction test
- [ ] XML extraction test
- [ ] Compare quality vs old extraction

**Acceptance Criteria**:

- All format tests pass
- Quality metrics show improvement
- No regressions

**Resume Point**: Tests are independent per format

---

#### Task 6.2: Integration Testing

**Status**: Not Started
**Files**: `apps/search-ai/src/__tests__/extraction-integration.test.ts` (new)
**Dependencies**: Task 6.1

**Subtasks**:

- [ ] End-to-end upload → extraction → chunking → embedding
- [ ] Test all 6 legacy formats
- [ ] Test error handling (bad files, service down)
- [ ] Test fallback mechanism

**Acceptance Criteria**:

- Full pipeline works for all formats
- Fallback works when service unavailable
- Error handling prevents data loss

**Resume Point**: Integration tests are independent from unit tests

---

#### Task 6.3: Performance Benchmarking

**Status**: Not Started
**Files**: `docs/searchai/LEGACY_EXTRACTION_BENCHMARK.md` (new)
**Dependencies**: Task 6.2

**Subtasks**:

- [ ] Measure processing time per format
- [ ] Compare memory usage (old vs new)
- [ ] Measure chunk quality (retrieval accuracy)
- [ ] Document results

**Acceptance Criteria**:

- Processing time acceptable (<5s per file)
- Memory usage reasonable
- Quality improvement documented

**Resume Point**: Benchmarking is observational, doesn't block deployment

---

### 🎯 Phase 7: Deployment & Monitoring (1-2 days)

#### Task 7.1: Docker Setup for LlamaIndex Service

**Status**: Not Started
**Files**: `services/llamaindex-service/Dockerfile` (new)
**Dependencies**: Task 4.1

**Subtasks**:

- [ ] Create Dockerfile
- [ ] Add to docker-compose.yml
- [ ] Test local deployment
- [ ] Add health checks

**Acceptance Criteria**:

- Service builds successfully
- Runs in Docker
- Health check works
- Can call from extraction worker

**Resume Point**: Docker setup is independent from service logic

---

#### Task 7.2: Add Monitoring & Metrics

**Status**: Not Started
**Files**: `apps/search-ai/src/workers/extraction-worker.ts`
**Dependencies**: Task 4.3

**Subtasks**:

- [ ] Metric: `extraction_route` (new vs old)
- [ ] Metric: `extraction_duration` by format
- [ ] Metric: `chunk_count` by format
- [ ] Metric: `extraction_failure` by format and reason
- [ ] Dashboard in Grafana

**Acceptance Criteria**:

- Metrics emitted for all extractions
- Can track new vs old usage
- Can detect quality issues

**Resume Point**: Metrics are additive, don't change behavior

---

#### Task 7.3: Gradual Rollout

**Status**: Not Started
**Files**: `apps/search-ai/src/routes/document-upload.ts`
**Dependencies**: Task 7.2

**Subtasks**:

- [ ] Add feature flag: `USE_LLAMAINDEX_EXTRACTION`
- [ ] Start with 10% traffic to new path
- [ ] Monitor metrics for 24h
- [ ] Increase to 50%, monitor
- [ ] Increase to 100% if no issues

**Acceptance Criteria**:

- Feature flag works
- Can roll back instantly if issues
- Metrics show no quality regression

**Resume Point**: Rollout is gradual, can pause at any percentage

---

## Progress Tracking

### Overall Status

| Phase                          | Tasks   | Status      | Progress |
| ------------------------------ | ------- | ----------- | -------- |
| Phase 1: Foundation            | 3 tasks | Not Started | 0%       |
| Phase 2: Markdown Chunking     | 3 tasks | Not Started | 0%       |
| Phase 3: HTML Pipeline         | 1 task  | ✅ Complete | 100%     |
| Phase 4: Worker Updates        | 3 tasks | Not Started | 0%       |
| Phase 5: Code Files (Optional) | 2 tasks | Not Started | 0%       |
| Phase 6: Testing               | 3 tasks | Not Started | 0%       |
| Phase 7: Deployment            | 3 tasks | Not Started | 0%       |

**Total**: 18 tasks (1 complete, 17 pending)

---

## Resume Strategy

### How to Resume from Any Point

Each task is:

1. **Independent**: Can be done separately
2. **Documented**: Acceptance criteria clear
3. **Testable**: Can verify completion
4. **Reversible**: Can roll back if needed

### Quick Resume Guide

**Starting Fresh?**
→ Begin with Task 1.1 (Setup LlamaIndex)

**Have LlamaIndex service?**
→ Continue with Task 2.1 (Markdown chunking)

**Have markdown chunker?**
→ Continue with Task 4.1 (Worker integration)

**Have worker integration?**
→ Continue with Task 6.1 (Testing)

**Ready for production?**
→ Continue with Task 7.1 (Deployment)

---

## Decision Points

### Should We Do Phase 5 (Code Files)?

**Pros**:

- Better code search
- Developers love it
- AST-aware chunking is unique

**Cons**:

- Adds 2-3 days
- Smaller user base
- Can add later

**Recommendation**: Skip for V1, add in V2 based on user demand

---

### LlamaIndex vs Langchain?

**LlamaIndex** ✅ Recommended:

- Python-native (matches Docling)
- Better chunking (semantic, sentence-aware)
- 50+ format loaders
- Active development

**Langchain**:

- Mature
- Good for chains/agents
- Less focused on pure document loading

**Decision**: Use LlamaIndex

---

### Separate Service vs In-Worker?

**Separate Service** ✅ Recommended:

- Matches Docling pattern
- Easier to scale independently
- Python-TypeScript boundary clear
- Can reuse for other services

**In-Worker**:

- Simpler deployment
- No HTTP overhead
- Requires Python in Node.js process

**Decision**: Separate service (consistency with Docling)

---

## Dependencies

### New Python Packages

```txt
# services/llamaindex-service/requirements.txt
llama-index>=0.9.0
llama-index-readers-file>=0.1.0
fastapi>=0.109.0
uvicorn>=0.27.0
python-multipart>=0.0.6
```

### New TypeScript Packages

```json
// packages/search-ai-internal/package.json
{
  "dependencies": {
    "unified": "^11.0.4",
    "remark-parse": "^11.0.0",
    "remark-gfm": "^4.0.0",
    "unist-util-visit": "^5.0.0"
  }
}
```

---

## Rollback Plan

If issues arise after deployment:

### Level 1: Feature Flag Rollback (Instant)

```typescript
// Set flag to 0% - all traffic to old path
USE_LLAMAINDEX_EXTRACTION = 0;
```

### Level 2: Service Disable (5 minutes)

```bash
# Stop LlamaIndex service
docker-compose stop llamaindex-service
# Worker auto-falls back to old extraction
```

### Level 3: Code Rollback (30 minutes)

```bash
git revert <commit-hash>
git push
# Redeploy
```

---

## Success Metrics

### Quality Metrics

- ✅ Chunk boundaries align with document structure (>90%)
- ✅ No mid-sentence chunk boundaries (<5%)
- ✅ Retrieval accuracy improvement (>10%)

### Performance Metrics

- ✅ Processing time <5s per file
- ✅ Memory usage <2GB
- ✅ Service uptime >99.9%

### Adoption Metrics

- ✅ 100% of legacy formats use new extraction
- ✅ Zero data loss during migration
- ✅ <1% fallback to old extraction

---

## Files to Create

```
services/llamaindex-service/
├── app.py                      # FastAPI service
├── loaders.py                  # Format-specific loaders
├── chunkers.py                 # Semantic chunking logic
├── requirements.txt            # Python dependencies
├── Dockerfile                  # Docker setup
├── test_formats.py             # Format tests
└── README.md                   # Service docs

packages/search-ai-internal/src/chunking/
├── markdown-chunker.ts         # Unified/remark chunking
└── __tests__/
    └── markdown-chunker.test.ts

apps/search-ai/src/workers/
└── extraction-worker.ts        # Updated worker

apps/search-ai/src/__tests__/
└── extraction-integration.test.ts  # E2E tests

docs/searchai/
├── LEGACY_EXTRACTION_MODERNIZATION.md  # This file
└── LEGACY_EXTRACTION_BENCHMARK.md      # Performance results
```

---

## Next Steps

**Immediate** (this session):

1. Review task breakdown
2. Confirm Phase 1-4 approach
3. Decide: Skip Phase 5 (code files) for V1?

**Next Session** (when resuming):

1. Start Task 1.1: Setup LlamaIndex service
2. Create service scaffold
3. Add TXT loader
4. Test basic extraction

**Long-term**:

1. Complete Phases 1-4
2. Test thoroughly (Phase 6)
3. Deploy with feature flag (Phase 7)
4. Monitor metrics
5. Consider Phase 5 (code files) for V2

---

**Questions?**

- Should we skip code files (Phase 5) for V1?
- Prefer LlamaIndex or different framework?
- Any specific formats to prioritize?
- Timeline expectations?

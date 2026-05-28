# Feature Test Guide: SearchAI File Mimetypes & Agent Tool Integration

**Feature**: Verify SearchAI ingestion pipeline processes all supported file mimetypes correctly (PDF, DOCX, PPTX, images, etc.) and agents can search the indexed content via the auto-registered `searchai` tool.
**Owner**: Platform team
**Branch**: develop
**First tested**: 2026-03-18
**Last updated**: 2026-03-18
**Overall status**: NOT STARTED

---

## Current State (as of 2026-03-18)

Initial test plan created. No tests executed yet. This document will track end-to-end verification of file mimetype handling from upload → ingestion → extraction → chunking → embedding → agent search.

### Quick Health Dashboard

| Area                          | Status | Last Verified | Notes |
| ----------------------------- | ------ | ------------- | ----- |
| PDF Upload & Processing       | —      | Not tested    |       |
| DOCX Upload & Processing      | —      | Not tested    |       |
| PPTX Upload & Processing      | —      | Not tested    |       |
| DOC (Legacy) Processing       | —      | Not tested    |       |
| PPT (Legacy) Processing       | —      | Not tested    |       |
| HTML Processing               | —      | Not tested    |       |
| Image Processing (PNG/JPEG)   | —      | Not tested    |       |
| Markdown/Plain Text           | —      | Not tested    |       |
| Unsupported Mimetype Handling | —      | Not tested    |       |
| Agent Search (Post-Ingestion) | —      | Not tested    |       |
| UI Document List              | —      | Not tested    |       |
| Pipeline Flow Selection       | —      | Not tested    |       |

Status values: PASS | FAIL | PARTIAL | REGRESSION | — (not tested)

---

## Test Coverage Map

### Supported Mimetypes (Docling Provider)

According to `default-pipeline-template.ts`, these are explicitly supported:

**Rich Formats (Docling extraction):**

- [x] `application/pdf` — `Not tested`
- [x] `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (DOCX) — `Not tested`
- [x] `application/msword` (DOC) — `Not tested`
- [x] `application/vnd.openxmlformats-officedocument.presentationml.presentation` (PPTX) — `Not tested`
- [x] `application/vnd.ms-powerpoint` (PPT) — `Not tested`
- [x] `text/html` — `Not tested`
- [x] `image/png` — `Not tested`
- [x] `image/jpeg` — `Not tested`
- [x] `image/tiff` — `Not tested`
- [x] `image/bmp` — `Not tested`
- [x] `image/webp` — `Not tested`

**Plain Text (Legacy/Llamaindex fallback):**

- [x] `text/plain` — `Not tested`
- [x] `text/markdown` — `Not tested`

### API Tests - Document Upload

- [ ] POST /indexes/{id}/sources/{sid}/documents (PDF) → 200, job_id returned
- [ ] POST /indexes/{id}/sources/{sid}/documents (DOCX) → 200
- [ ] POST /indexes/{id}/sources/{sid}/documents (PPTX) → 200
- [ ] POST /indexes/{id}/sources/{sid}/documents (HTML) → 200
- [ ] POST /indexes/{id}/sources/{sid}/documents (PNG image) → 200
- [ ] POST /indexes/{id}/sources/{sid}/documents (unsupported mimetype) → 400 with clear error
- [ ] GET /indexes/{id}/sources/{sid}/documents → list shows uploaded docs with correct metadata

### Pipeline Processing

- [ ] PDF: Docling extraction → tree chunking → embedding → OpenSearch
- [ ] DOCX: Docling extraction → markdown-aware chunking → embedding
- [ ] PPTX: Per-slide extraction → chunking → embedding
- [ ] Images: OCR + visual analysis → chunking → embedding
- [ ] Plain text/Markdown: Legacy provider → chunking → embedding
- [ ] Check BullMQ job status for each file type
- [ ] Verify no jobs stuck in "stalled" state
- [ ] Check PM2 logs for extraction errors

### DB State Verification

- [ ] `search_documents` record created with correct mimetype
- [ ] `search_document_chunks` records exist for each file
- [ ] Chunk count matches expected (PDF multi-page, PPTX per-slide, etc.)
- [ ] `chunkMetadata` has correct fields (pageNumber, sourceChunkId, etc.)
- [ ] OpenSearch index has embeddings for all chunks
- [ ] `processingStatus` = "completed" for successful ingestion

### Agent Search Tests

- [ ] Agent searches PDF content → returns relevant chunks with correct source
- [ ] Agent searches DOCX content → retrieves text from specific sections
- [ ] Agent searches PPTX content → returns slide-specific content
- [ ] Agent searches image content → OCR text searchable
- [ ] Hybrid search (vector + keyword) works across all mimetypes
- [ ] Filters by mimetype: `filters: [{field: "mimetype", operator: "eq", value: "application/pdf"}]`
- [ ] Cross-mimetype search: query spans PDF + DOCX + HTML

### UI Tests

- [ ] Upload dialog accepts all supported file types
- [ ] Upload dialog rejects unsupported types with helpful message
- [ ] Document list shows correct file icon per mimetype
- [ ] Document detail page shows mimetype and processing status
- [ ] Preview works for supported types (PDF, images)
- [ ] Processing status updates in real-time (pending → processing → completed)
- [ ] No console errors during upload or processing

### Error Handling

- [ ] Upload file with wrong extension but correct mimetype → processes correctly
- [ ] Upload file with correct extension but wrong mimetype → validation error
- [ ] Upload 0-byte file → 400 error with message
- [ ] Upload file exceeding size limit → 413 error
- [ ] Corrupt PDF → ingestion fails gracefully, status = "failed"
- [ ] Docling service down → fallback to legacy provider OR clear error

### Edge Cases

- [ ] Multi-page PDF (100+ pages) → chunks correctly
- [ ] PPTX with embedded images → images extracted
- [ ] HTML with external CSS/JS → only content extracted
- [ ] Password-protected PDF → clear error message
- [ ] Image with no text (blank) → still indexed with metadata
- [ ] Markdown with code blocks → code preserved in chunks

---

## Open Gaps

None yet — test execution has not started.

---

## Pending / Future Work

- [ ] Structured data mimetypes (CSV, Excel, JSON) — separate pipeline
- [ ] Video/Audio mimetypes — requires transcription pipeline
- [ ] Performance testing: 1000 documents across all mimetypes
- [ ] Concurrent uploads: stress test ingestion queue
- [ ] Connector-based ingestion (Google Drive, Slack) — different code path

---

## Enhancement Ideas

None yet — will capture as tests uncover opportunities.

---

## Iteration Log

### Iteration 1 — 2026-03-18 (Planned)

**Scope**: Core file types (PDF, DOCX, PPTX, images), upload API, pipeline verification, agent search
**Branch**: develop
**Duration**: TBD
**Tested by**: Claude Code (agent)

#### Test Plan

**Prerequisites:**

1. Services running: Runtime (3112), SearchAI (3113), Studio (5173)
2. MongoDB accessible (port 27018 or 27017 depending on setup)
3. Docling service running (port 8080)
4. BGE-M3 embedding service running (port 8000)
5. OpenSearch/vector store accessible
6. Test files prepared:
   - `test.pdf` (multi-page, text-heavy)
   - `test.docx` (with headings, tables)
   - `test.pptx` (10+ slides)
   - `test.png` (with text for OCR)
   - `test.md` (markdown with code blocks)

**Steps:**

**STEP 1: Setup Test Project & KB**

```bash
# Get auth token
STUDIO_RESP=$(curl -s -X POST http://localhost:5173/api/auth/dev-login \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@example.com","name":"Test User"}')
TOKEN=$(echo "$STUDIO_RESP" | jq -r '.accessToken')

# Verify token
echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | jq .

# Ensure tenant_members record exists
mongosh --quiet mongodb://localhost:27018/abl_platform --eval "
  if (!db.tenant_members.findOne({tenantId:'tenant-dev-001',userId:'test-user-001'})) {
    db.tenant_members.insertOne({
      tenantId:'tenant-dev-001',
      userId:'test-user-001',
      email:'test@example.com',
      role:'OWNER',
      status:'active',
      createdAt:new Date()
    });
  }
"

# Create test project (or use existing)
PROJECT_RESP=$(curl -s -X POST http://localhost:5173/api/projects \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"SearchAI Mimetype Test","description":"Testing file type ingestion"}')
PROJECT_ID=$(echo "$PROJECT_RESP" | jq -r '.data.id')
echo "Project ID: $PROJECT_ID"

# Create Knowledge Base via SearchAI API
KB_RESP=$(curl -s -X POST http://localhost:3113/api/knowledge-bases \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{
    \"tenantId\": \"tenant-dev-001\",
    \"projectId\": \"$PROJECT_ID\",
    \"name\": \"Mimetype Test KB\",
    \"slug\": \"mimetype_test_kb\",
    \"description\": \"Test KB for all file types\"
  }")
KB_ID=$(echo "$KB_RESP" | jq -r '.id')
INDEX_ID=$(echo "$KB_RESP" | jq -r '.indexId')
echo "KB ID: $KB_ID"
echo "Index ID: $INDEX_ID"

# VERIFY: searchai tool auto-registered
curl -s "http://localhost:5173/api/projects/$PROJECT_ID/tools" \
  -H "Authorization: Bearer $TOKEN" | jq '.data[] | select(.toolType=="searchai")'
```

**STEP 2: Create Source in KB**

```bash
SOURCE_RESP=$(curl -s -X POST "http://localhost:3113/api/indexes/$INDEX_ID/sources" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Manual Uploads",
    "connectorType": "manual",
    "config": {}
  }')
SOURCE_ID=$(echo "$SOURCE_RESP" | jq -r '.id')
echo "Source ID: $SOURCE_ID"
```

**STEP 3: Upload PDF Document**

```bash
# Prepare test PDF file (or use existing sample)
# For testing, create a simple PDF or use one from test fixtures

PDF_UPLOAD=$(curl -s -X POST \
  "http://localhost:3113/api/indexes/$INDEX_ID/sources/$SOURCE_ID/documents" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/path/to/test.pdf" \
  -F 'metadata={"title":"Test PDF Document"}')

echo "$PDF_UPLOAD" | jq .
PDF_JOB_ID=$(echo "$PDF_UPLOAD" | jq -r '.jobId')
PDF_DOC_ID=$(echo "$PDF_UPLOAD" | jq -r '.documentId')

# VERIFY: Job created
echo "PDF Job ID: $PDF_JOB_ID"
echo "PDF Document ID: $PDF_DOC_ID"

# Check BullMQ job status (may need to query Redis or logs)
# Wait for processing (polling or check PM2 logs)
sleep 5

# VERIFY: Document in MongoDB
mongosh --quiet mongodb://localhost:27018/abl_platform --eval "
  db.search_documents.findOne({_id: '$PDF_DOC_ID'}, {
    mimetype: 1,
    processingStatus: 1,
    metadata: 1
  })
" | jq .

# VERIFY: Chunks created
mongosh --quiet mongodb://localhost:27018/abl_platform --eval "
  db.search_document_chunks.countDocuments({documentId: '$PDF_DOC_ID'})
"
```

**STEP 4: Upload DOCX Document**

```bash
DOCX_UPLOAD=$(curl -s -X POST \
  "http://localhost:3113/api/indexes/$INDEX_ID/sources/$SOURCE_ID/documents" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/path/to/test.docx" \
  -F 'metadata={"title":"Test DOCX Document"}')

echo "$DOCX_UPLOAD" | jq .
DOCX_DOC_ID=$(echo "$DOCX_UPLOAD" | jq -r '.documentId')

# Wait and verify
sleep 5
mongosh --quiet mongodb://localhost:27018/abl_platform --eval "
  db.search_documents.findOne({_id: '$DOCX_DOC_ID'})
" | jq .
```

**STEP 5: Upload PPTX Document**

```bash
PPTX_UPLOAD=$(curl -s -X POST \
  "http://localhost:3113/api/indexes/$INDEX_ID/sources/$SOURCE_ID/documents" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/path/to/test.pptx" \
  -F 'metadata={"title":"Test PPTX Presentation"}')

echo "$PPTX_UPLOAD" | jq .
PPTX_DOC_ID=$(echo "$PPTX_UPLOAD" | jq -r '.documentId')

sleep 5
mongosh --quiet mongodb://localhost:27018/abl_platform --eval "
  db.search_document_chunks.aggregate([
    {\\$match: {documentId: '$PPTX_DOC_ID'}},
    {\\$group: {_id: '\\$chunkMetadata.pageNumber', count: {\\$sum: 1}}},
    {\\$sort: {_id: 1}}
  ])
"
# Should show one chunk per slide
```

**STEP 6: Upload Image (PNG)**

```bash
IMG_UPLOAD=$(curl -s -X POST \
  "http://localhost:3113/api/indexes/$INDEX_ID/sources/$SOURCE_ID/documents" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/path/to/test.png" \
  -F 'metadata={"title":"Test Image with Text"}')

echo "$IMG_UPLOAD" | jq .
IMG_DOC_ID=$(echo "$IMG_UPLOAD" | jq -r '.documentId')

sleep 5
# Check if OCR extracted text
mongosh --quiet mongodb://localhost:27018/abl_platform --eval "
  db.search_document_chunks.findOne({documentId: '$IMG_DOC_ID'}, {content: 1})
" | jq .
```

**STEP 7: Check PM2 Logs for Errors**

```bash
pm2 logs search-ai --lines 50 --nostream 2>&1 | grep -i error
pm2 logs search-ai --lines 50 --nostream 2>&1 | grep -i "processing.*complete"
```

**STEP 8: Create Agent with SearchAI Tool**

```bash
# Create agent that uses the auto-registered searchai tool
AGENT_DSL='
AGENT: Document_Search

GOAL: "Search indexed documents across all file types"

TOOLS:
  search_kb_mimetype_test_kb(query: string, queryType?: string, filters?: object[]) -> {results: object[], totalCount: number}

INSTRUCTIONS: |
  When the user asks to search documents, use the search_kb tool.
  Apply filters if they mention specific file types.
'

AGENT_RESP=$(curl -s -X POST "http://localhost:3112/api/projects/$PROJECT_ID/agents" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{
    \"name\": \"Document_Search\",
    \"description\": \"Searches across all indexed documents\",
    \"dslContent\": $(echo "$AGENT_DSL" | jq -Rs .)
  }")

echo "$AGENT_RESP" | jq .
AGENT_ID=$(echo "$AGENT_RESP" | jq -r '.data.id')

# VERIFY: Agent compiles without errors
curl -s "http://localhost:3112/api/projects/$PROJECT_ID/agents/$AGENT_ID" \
  -H "Authorization: Bearer $TOKEN" | jq '.data.compilationStatus'
```

**STEP 9: Test Agent Search - PDF Content**

```bash
# Create session and send message asking about PDF content
SESSION_RESP=$(curl -s -X POST "http://localhost:3112/api/sessions" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{
    \"agentId\": \"$AGENT_ID\",
    \"projectId\": \"$PROJECT_ID\"
  }")

SESSION_ID=$(echo "$SESSION_RESP" | jq -r '.data.id')
echo "Session ID: $SESSION_ID"

# Send message
curl -s -X POST "http://localhost:3112/api/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "content": "Search for information about [specific topic in your test PDF]"
  }' | jq .

# Check response includes PDF chunks
# (May need to poll or stream)
```

**STEP 10: Test Mimetype Filtering**

```bash
# Search only PDF documents
curl -s -X POST "http://localhost:3112/api/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "content": "Search only PDF files for [topic]",
    "toolArgs": {
      "filters": [{"field": "mimetype", "operator": "eq", "value": "application/pdf"}]
    }
  }' | jq .

# VERIFY: Results only from PDF documents
```

**STEP 11: UI Testing (Browser Automation)**

```bash
# Using next-devtools MCP (if available)
# Navigate to KB documents page
# Verify documents list shows correct icons per mimetype
# Verify upload button accepts all supported types
# Verify processing status indicators
```

#### Expected Results

| Test                | Expected Outcome                                     | Verification Method                         |
| ------------------- | ---------------------------------------------------- | ------------------------------------------- |
| PDF upload          | 200, jobId returned                                  | API response + DB record                    |
| PDF processing      | Chunks created with pageNumber metadata              | MongoDB search_document_chunks query        |
| DOCX processing     | Markdown-aware chunking on H1/H2                     | Chunk content inspection                    |
| PPTX processing     | One chunk per slide minimum                          | Aggregate by chunkMetadata.pageNumber       |
| Image OCR           | Text extracted and searchable                        | Chunk content has recognizable text         |
| Agent search (PDF)  | Returns chunks from PDF with correct source citation | Session messages API + trace events         |
| Mimetype filter     | Only requested file types in results                 | Result objects have correct mimetype field  |
| Unsupported file    | 400 error with "Unsupported file type" message       | API error response                          |
| Pipeline logs clean | No ERROR level logs during processing                | PM2 logs grep                               |
| OpenSearch index    | All chunks have embeddings (1024-dim for bge-m3)     | OpenSearch query or vector store inspection |

#### Bugs Fixed

None yet.

#### Gaps Resolved

None yet.

#### New Gaps Found

Will be documented as tests run.

---

## Test Environment

- **Runtime**: localhost:3112 (tsx watch or built)
- **SearchAI**: localhost:3113 (tsx watch or built)
- **Studio**: localhost:5173 (Next.js dev)
- **MongoDB**: localhost:27018 (Docker) or 27017 (local)
- **Docling Service**: localhost:8080 (Docker or standalone)
- **BGE-M3 Service**: localhost:8000 (Docker or standalone)
- **Test project**: Created fresh per iteration
- **Test KB**: `mimetype_test_kb` with auto-registered tool
- **Sample files**: Keep in `test-fixtures/` or specify paths in test execution

---

## Quick Reference

### Supported Mimetypes by Provider

**Docling (rich extraction):**

- PDF, DOCX, DOC, PPTX, PPT, HTML
- PNG, JPEG, TIFF, BMP, WebP

**Legacy/Llamaindex:**

- text/plain, text/markdown

### API Endpoints

| Method | Path                                                       | Purpose             |
| ------ | ---------------------------------------------------------- | ------------------- |
| POST   | `/api/knowledge-bases`                                     | Create KB           |
| POST   | `/api/indexes/:indexId/sources`                            | Create source       |
| POST   | `/api/indexes/:indexId/sources/:sourceId/documents`        | Upload document     |
| GET    | `/api/indexes/:indexId/sources/:sourceId/documents`        | List documents      |
| GET    | `/api/indexes/:indexId/sources/:sourceId/documents/:docId` | Get document detail |
| DELETE | `/api/indexes/:indexId/sources/:sourceId/documents/:docId` | Delete document     |

### MongoDB Collections

```bash
# Documents
db.search_documents.find({indexId: 'your-index-id'})

# Chunks
db.search_document_chunks.find({documentId: 'your-doc-id'})

# Count chunks by mimetype
db.search_document_chunks.aggregate([
  {$lookup: {from: 'search_documents', localField: 'documentId', foreignField: '_id', as: 'doc'}},
  {$unwind: '$doc'},
  {$group: {_id: '$doc.mimetype', count: {$sum: 1}}}
])
```

### Common Issues

| Issue                          | Symptom                              | Fix                                                            |
| ------------------------------ | ------------------------------------ | -------------------------------------------------------------- | -------------------------------- |
| Docling service not running    | Upload succeeds but processing hangs | Check `docker ps                                               | grep docling`, restart if needed |
| BGE-M3 service not running     | Chunks created but no embeddings     | Check port 8000, restart embedding service                     |
| Wrong MongoDB port             | Connection refused during DB checks  | Check `.env` — 27018 for Docker, 27017 for local               |
| File too large                 | 413 Payload Too Large                | Check nginx/express body-parser limits                         |
| Unsupported mimetype accepted  | Upload succeeds but processing fails | Bug in mimetype validation — file should be rejected at upload |
| SearchAI tool not auto-created | Agent compile error: tool not found  | Check KB creation logs, verify `registerSearchAITool()` called |

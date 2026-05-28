// Knowledge card: KB Operations — operational guide for ARC to manage knowledge bases.
// This card teaches ARC the tool-call sequences for the full KB lifecycle:
// create → upload → monitor → search, using the kb_* tool family.

export const KB_TOOL_SEQUENCES_CARD = `## Knowledge Base Operations — Tool Guide

### Available KB Tools

| Tool | Purpose |
|------|---------|
| \`kb_manage\` | Create, list, get, update, delete knowledge bases |
| \`kb_ingest\` | Upload files, add URLs, add text, list sources |
| \`kb_search\` | Semantic search, structured search, discover, vocabulary resolution |
| \`kb_health\` | Health summary, error list, retry failed, sync counters |
| \`kb_connector\` | Create/manage enterprise connectors (SharePoint, Confluence, etc.) |
| \`kb_documents\` | List documents, status summary, reprocess, delete |

### Complete Workflow: Create KB → Upload → Search

**Step 1: Create a Knowledge Base**
\`\`\`
kb_manage({ action: "create", kbName: "Product Docs", description: "Product documentation" })
\`\`\`
Returns \`{ knowledgeBase: { _id, name, searchIndexId } }\`. Save the \`_id\` for subsequent calls.

**Step 2: Upload Content**

For file uploads — TWO STEPS REQUIRED (collect_file does NOT upload to KB):
1. Call \`collect_file\` — shows upload widget, user picks a file
2. IMMEDIATELY call \`kb_ingest\` — the file is auto-resolved from collect_file:
\`\`\`
kb_ingest({ action: "upload_file", kbId: "<id>" })
\`\`\`
No need to pass fileContent or blobId — the tool auto-resolves the last collected file.
SearchAI handles extraction (Docling), chunking, embedding, and indexing.

CRITICAL: collect_file does NOT upload to the KB. You MUST call kb_ingest after it.
NEVER say "uploaded" or "ingestion started" until kb_ingest returns success.

For URLs (no collect_file needed):
\`\`\`
kb_ingest({ action: "add_url", kbId: "<id>", url: "https://docs.example.com/page" })
\`\`\`

For inline text:
\`\`\`
kb_ingest({ action: "add_text", kbId: "<id>", text: "Content here...", title: "My Note" })
\`\`\`

**Step 3: Monitor Ingestion Progress (MANDATORY after upload)**
After uploading a file, you MUST check the indexing status and notify the user:
1. Wait a few seconds for processing to start
2. Check status:
\`\`\`
kb_documents({ action: "status_summary", kbId: "<id>" })
\`\`\`
3. Report the result to the user:
   - If status shows "indexed"/"ready" → tell user "Your document is now indexed and searchable!"
   - If status shows "processing"/"pending" → tell user "Document is being processed, indexing in progress..."
   - If status shows "error" → tell user the error and suggest retry
4. If still processing, check again after a short wait:
\`\`\`
kb_health({ action: "summary", kbId: "<id>" })
\`\`\`

IMPORTANT: Never tell the user the upload is complete without verifying indexing status.
The user must know whether their document is searchable or not.

**Step 4: Search the Knowledge Base**
\`\`\`
kb_search({ action: "query", kbId: "<id>", query: "How do refunds work?" })
\`\`\`

### KB Resolution

You can reference a KB by \`kbId\` or \`kbName\`. If the project has only one KB, it is auto-selected. If multiple KBs exist and none is specified, the tool returns \`needsInput: true\` with a list of available KBs — ask the user which one to use.

### Search Actions

| Action | When to Use |
|--------|-------------|
| \`query\` | Default semantic search — finds conceptually related content |
| \`structured_query\` | Filter-driven search with metadata operators (eq, in, contains, etc.) |
| \`discover\` | Get KB capabilities (vocabulary, filters, query types) — use once per session |
| \`resolve_vocab\` | Resolve business terms to canonical field values before searching |

### Ingestion Actions

| Action | When to Use |
|--------|-------------|
| \`upload_file\` | Upload a file to KB — pass fileContent (base64) + fileName + fileMimeType directly from collect_file result. File goes straight to SearchAI for Docling extraction, chunking, embedding, and indexing. |
| \`add_url\` | Queue a URL or list of URLs for web crawl ingestion |
| \`add_text\` | Save inline text as a document (notes, snippets) |
| \`list_sources\` | See existing sources (upload buckets) in the KB |

### Health Actions

| Action | When to Use |
|--------|-------------|
| \`summary\` | Overall KB health status (sources, documents, pipeline) |
| \`errors\` | List ingestion errors |
| \`retry_failed\` | Reprocess failed documents |
| \`sync_counters\` | Document counts by status |
| \`check_operation\` | Check specific job or connector sync status |

### Connector Actions

| Action | When to Use |
|--------|-------------|
| \`list\` | List configured connectors |
| \`create\` | Create a new connector (SharePoint, Confluence, etc.) |
| \`auth\` | Initiate OAuth flow for connector authentication |
| \`sync_start\` | Trigger a sync |
| \`sync_status\` | Check sync progress |
| \`sync_pause\` | Pause or resume sync (use \`resume: true\` to resume) |

### Document Actions

| Action | When to Use |
|--------|-------------|
| \`list\` | List documents with optional status/pagination filters |
| \`status_summary\` | Counts by processing status (ready, processing, errored) |
| \`reprocess\` | Retry processing for specific document IDs |
| \`delete\` | Remove a document (requires \`confirmed: true\`) |

### Key Patterns

- **Always create before ingest**: A KB must exist before you can upload to it.
- **File upload flow for KB**: Use \`collect_file\` to get the file from the user, then pass \`fileContent\` (base64), \`fileName\`, and \`fileMimeType\` directly to \`kb_ingest upload_file\`. This sends the file straight to SearchAI — Docling handles extraction, chunking, embedding, and indexing automatically. Do NOT go through the multimodal service for KB uploads.
- **Sources are auto-created**: When you upload via \`kb_ingest\`, a source named "Arch AI Uploads" (or "Arch AI URLs"/"Arch AI Notes") is auto-created if it does not exist.
- **Check health after bulk ingestion**: Documents go through extract → chunk → embed → store. Use \`kb_health\` or \`kb_documents status_summary\` to confirm processing is complete.
- **Search filters use operators**: \`eq\`, \`neq\`, \`gt\`, \`gte\`, \`lt\`, \`lte\`, \`in\`, \`not_in\`, \`contains\`, \`not_contains\`, \`exists\`, \`not_exists\`.
- **Destructive actions need confirmation**: \`kb_manage delete\` and \`kb_documents delete\` require \`confirmed: true\`.

### Supported Upload Formats

| Category | Formats |
|----------|---------|
| Documents | PDF, DOCX, TXT, Markdown |
| Web content | HTML pages, web crawls (via add_url) |
| Structured data | JSON, CSV |
| Rich media | Images within documents (via visual enrichment) |
`;

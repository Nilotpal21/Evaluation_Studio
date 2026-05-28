// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: guides/knowledge-bases.mdx
// Regenerate: pnpm abl:docs:generate

export const KB_ADMINISTRATION_CARD = `## Knowledge Bases — Creation, Ingestion, Connectors, Search

# Knowledge Bases
- Knowledge bases give your agents access to your organization's information.
- This guide covers the full lifecycle: how documents are processed into searchable knowledge, how to create and populate a knowledge base, how to connect it to an agent, and how to tune search strategies and live data connectors.
## How Knowledge Bases Work
- When you upload a document or connect a data source, it goes through a multi-stage pipeline before it is searchable.
\`\`\`mermaid
flowchart LR
    A["Upload / Connect"] --> B["Ingest"]
    B --> C["Extract text"]
    C --> D["Chunk"]
    D --> E["Enrich"]
    E --> F["Embed"]
    F --> G["Store"]

    style A fill:#e8f4fd
    style G fill:#e8f4fd
\`\`\`
### The Ingestion Pipeline
- **1.
- **2.
| Format                | Extraction approach                                                  |
| --------------------- | -------------------------------------------------------------------- |
| Plain text, Markdown  | Used as-is                                                           |
| HTML                  | Tags stripped, structure preserved where meaningful                  |
| PDF                   | Text extracted from pages (layout-aware extraction for complex PDFs) |
| DOCX / Office formats | Document content extracted from the file structure                   |
| JSON                  | Values extracted and concatenated with structural context            |
- The extraction stage also captures document metadata (titles, headings, page numbers) that is used later for enrichment and search result context.
- **3.
- **Fixed-size chunking** -- Splits text into windows of a target token size with configurable overlap between chunks. Simple and predictable.
- **Semantic chunking** -- Splits on natural boundaries like paragraphs, sections, and topic shifts. Produces chunks that are more coherent but vary in size.
- **Sliding window** -- Creates overlapping windows that slide across the text, ensuring no information falls between chunk boundaries.
- Chunk overlap is important: it ensures that context at the edges of chunks is not lost.
**4. Enrich** -- The enrichment stage adds metadata to each chunk to improve search quality:
- **Entity detection** -- Identifies emails, URLs, dates, and monetary values
- **Summary generation** -- Creates a brief summary of each chunk's content
- **Language detection** -- Identifies the language of the content
- **Knowledge graph extraction** -- Extracts entities and relationships to build a knowledge graph
- Enrichment metadata is stored alongside the chunk and can be used for filtering and ranking search results.
- **5.
- **6.
### How Agents Query Knowledge at Runtime
- When an agent needs information from a knowledge base, the Runtime executes a search query against SearchAI.
\`\`\`mermaid
sequenceDiagram
    participant Agent
    participant Runtime
    participant SearchAI
    participant VectorDB as Vector Store

    Agent->>Runtime: "Search KB for: refund policy"
    Runtime->>SearchAI: Hybrid search query
    SearchAI->>SearchAI: Embed query text
    SearchAI->>VectorDB: Vector similarity search
    VectorDB-->>SearchAI: Top matching chunks
    SearchAI->>SearchAI: Re-rank results
    SearchAI->>SearchAI: Apply permission filters
    SearchAI-->>Runtime: Ranked, filtered results
    Runtime-->>Agent: Knowledge context
    Agent->>Agent: Use context to generate response
\`\`\`
Agent Platform 2.0 uses **hybrid search**, combining two complementary strategies:
- **Semantic search** -- Finds chunks whose vector embeddings are most similar to the query embedding. This catches conceptual matches ("How do I get my money back?" matches a chunk about "Refund policy and procedures").
- **Keyword search** -- Finds chunks containing the exact terms in the query. This catches specific names, product codes, or technical terms that semantic search might miss.
- Results from both strategies are merged and re-ranked to produce a single list of the most relevant chunks.
- **Permission-aware search** -- Search results are filtered based on the requesting user's permissions.
### Supported Formats
| Category            | Formats                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| **Documents**       | PDF, DOCX, TXT, Markdown                                                |
| **Web content**     | HTML pages, web crawls                                                  |
| **Structured data** | JSON, CSV (via structured data ingestion)                               |
| **Rich media**      | Images within documents (via visual enrichment for diagrams and charts) |
### What Affects Retrieval Quality
- **Document quality** -- Clean, well-structured content with clear headings and logical organization produces better chunks and more accurate retrieval.
- **Chunking configuration** -- Chunk size is a trade-off between precision and context.
- **Query quality** -- How the agent formulates its search query affects what it finds.
## Create a Knowledge Base
- Use a knowledge base to give your agent access to domain-specific documents so it can answer questions grounded in your content.
### Create an Index in Studio
- Open your project in Studio.
1. Enter a name for the knowledge base (e.g., \`product-docs\`).
2. Select the embedding model. The default (\`bge-m3\`) works well for most use cases.
3. Choose a chunking strategy:
   - **Semantic** -- splits on meaning boundaries (recommended for prose).
   - **Fixed-size** -- splits at a fixed token count (good for structured data).
   - **Hierarchical** -- builds a tree of progressively summarized chunks (best for large documents).
4. Select **Create**.
Studio creates the knowledge base and returns an index ID.
### Create an Index via the API
\`\`\`bash
curl -X POST https://your-platform/api/indexes \\
  -H "Authorization: Bearer \$TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "product-docs",
    "description": "Product documentation and FAQs",
    "embeddingModel": "bge-m3",
    "chunkingStrategy": "semantic"
  }'
\`\`\`
The response includes the \`indexId\` you need for ingestion and agent configuration.
### Knowledge Base with Custom Chunk Size
\`\`\`bash
curl -X POST https://your-platform/api/indexes \\
  -H "Authorization: Bearer \$TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "legal-contracts",
    "embeddingModel": "bge-m3",
    "chunkingStrategy": "fixed",
    "chunkingConfig": {
      "chunkSize": 512,
      "chunkOverlap": 64
    }
  }'
\`\`\`
### Knowledge Base with Hierarchical Chunking
- Hierarchical chunking builds a tree structure where parent nodes contain summaries of their children.
\`\`\`bash
curl -X POST https://your-platform/api/indexes \\
  -H "Authorization: Bearer \$TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "research-papers",
    "embeddingModel": "bge-m3",
    "chunkingStrategy": "hierarchical"
  }'
\`\`\`
### Troubleshooting
- **"Index already exists" error:** Index names must be unique within a tenant. Choose a different name or delete the existing index first.
- **Embedding model not available:** Verify that the BGE-M3 service is running. Check the SearchAI service health endpoint at \`/api/health\`.
## Ingest Documents
- Ingest documents into a knowledge base so your agent can search and retrieve relevant content at runtime.
### Add a Source and Upload Documents
Create a source within your knowledge base, then submit documents for ingestion.
\`\`\`bash
# 1. Create a source
curl -X POST https://your-platform/api/indexes/\$INDEX_ID/sources \\
  -H "Authorization: Bearer \$TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "product-manuals",
    "sourceType": "upload"
  }'

# 2. Upload a PDF
curl -X POST https://your-platform/api/indexes/\$INDEX_ID/ingest \\
  -H "Authorization: Bearer \$TOKEN" \\
  -F "file=@manual.pdf" \\
  -F "sourceId=\$SOURCE_ID"
\`\`\`
- The platform extracts text, splits it into chunks, generates embeddings, and indexes the content.
### Check Ingestion Status
\`\`\`bash
curl https://your-platform/api/indexes/\$INDEX_ID/jobs/\$JOB_ID \\
  -H "Authorization: Bearer \$TOKEN"
\`\`\`
The response includes \`status\` (\`queued\`, \`processing\`, \`completed\`, \`failed\`) and progress details.
### Ingest a DOCX File
- The same upload endpoint handles DOCX files.
\`\`\`bash
curl -X POST https://your-platform/api/indexes/\$INDEX_ID/ingest \\
  -H "Authorization: Bearer \$TOKEN" \\
  -F "file=@report.docx" \\
  -F "sourceId=\$SOURCE_ID"
\`\`\`
### Ingest from a URL
Submit a web page URL for the platform to crawl, extract content, and index.
\`\`\`bash
curl -X POST https://your-platform/api/indexes/\$INDEX_ID/ingest \\
  -H "Authorization: Bearer \$TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "sourceId": "'\$SOURCE_ID'",
    "url": "https://docs.example.com/getting-started",
    "extractionConfig": {
      "followLinks": false,
      "maxDepth": 0
    }
  }'
\`\`\`
### Ingest Structured Data (JSON/CSV)
- For structured datasets, the platform analyzes the schema, detects foreign keys, and indexes the data for both semantic and structured queries.
\`\`\`bash
curl -X POST https://your-platform/api/indexes/\$INDEX_ID/structured-data/ingest \\
  -H "Authorization: Bearer \$TOKEN" \\
  -F "file=@products.csv" \\
  -F "sourceId=\$SOURCE_ID" \\
  -F "tableName=products"
\`\`\`
### Batch Ingestion
Upload multiple files in a single request by submitting them as separate \`file\` fields.
\`\`\`bash
curl -X POST https://your-platform/api/indexes/\$INDEX_ID/ingest \\
  -H "Authorization: Bearer \$TOKEN" \\
  -F "file=@doc1.pdf" \\
  -F "file=@doc2.pdf" \\
  -F "file=@doc3.pdf" \\
  -F "sourceId=\$SOURCE_ID"
\`\`\`
### Troubleshooting
- **Ingestion stuck in "queued":** The ingestion worker may be at capacity. Check the job queue health at \`/api/indexes/\$INDEX_ID/jobs\`.`;

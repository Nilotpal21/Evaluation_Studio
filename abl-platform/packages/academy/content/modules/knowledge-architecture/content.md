# Knowledge Architecture

> **Estimated time**: 30 minutes | **Prerequisites**: Agent Configuration, Tools & Integrations

## Learning Objectives

After completing this module, you will be able to:

- Trace a document through the 6-stage ingestion pipeline and explain the role of the Embed stage
- Compare semantic, fixed-size, and sliding window chunking strategies and choose the right one for a given use case
- Configure permission-aware search for data sources with access controls
- Use the analytics API to retrieve cost-breakdown data for LLM usage
- Explain how delta sync works for incremental connector updates

## Why Knowledge Bases Matter

LLMs are trained on general data with a fixed cutoff date. Your agents need access to your organization's current, specific information -- product documentation, HR policies, customer records, technical specs. Knowledge bases bridge this gap by giving agents the ability to search your content at runtime and ground their responses in real, up-to-date information.

Without a knowledge base, your agent might hallucinate an answer about your refund policy. With one, it retrieves the actual policy text and synthesizes an accurate response.

## The 6-Stage Ingestion Pipeline

When you upload a document or connect a data source, it passes through six stages before becoming searchable. Understanding these stages helps you troubleshoot ingestion issues and tune retrieval quality.

```
Upload/Connect --> Ingest --> Extract Text --> Chunk --> Enrich --> Embed --> Store
```

### Stage 1: Ingest

The pipeline receives your content and prepares it for processing. For uploaded files, the ingester registers the document and checks for duplicates using content hashing -- identical files are not reprocessed. For connected data sources, the ingester discovers and tracks documents within the source.

### Stage 2: Extract Text

Raw file formats are converted to plain text. Different formats require different strategies:

| Format                | Extraction Approach                                       |
| --------------------- | --------------------------------------------------------- |
| Plain text, Markdown  | Used as-is                                                |
| HTML                  | Tags stripped, structure preserved where meaningful       |
| PDF                   | Text extracted from pages (layout-aware for complex PDFs) |
| DOCX / Office formats | Content extracted from file structure                     |
| JSON                  | Values extracted with structural context                  |

The extraction stage also captures metadata (titles, headings, page numbers) used later for enrichment and search result context.

### Stage 3: Chunk

Raw text is too long to embed as a single unit. Chunking splits text into smaller, meaningful segments that can be individually embedded and retrieved. Agent Platform supports three chunking strategies:

**Fixed-size chunking** splits text into windows of a target token size with configurable overlap. It is simple and predictable, making it a good choice for structured data, FAQ collections, and content with uniform formatting.

**Semantic chunking** splits on natural boundaries like paragraphs, sections, and topic shifts. It produces more coherent chunks that respect the document's logical structure, but chunk sizes vary. This is the recommended default for prose documents.

**Sliding window chunking** creates overlapping windows that slide across the text, ensuring no information falls between chunk boundaries. This maximizes recall but creates more chunks to index and search.

> **Key Concept**: The choice between semantic and fixed-size chunking significantly impacts retrieval quality. Semantic chunking produces chunks that preserve complete ideas -- a paragraph about refund policies stays together as one chunk. Fixed-size chunking may split that paragraph across two chunks, but it guarantees predictable chunk sizes, which matters for token-budget planning. Start with semantic chunking for general content and switch to fixed-size only when you need strict size control.

**Chunk overlap** is important regardless of strategy. A concept that spans the boundary between two chunks appears in both when overlap is configured. A 10-20% overlap is a reasonable starting point.

| Chunk Size Range | Best For                          | Trade-off                                     |
| ---------------- | --------------------------------- | --------------------------------------------- |
| 100-200 tokens   | FAQ-style content, short answers  | More precise matching, less context per chunk |
| 300-500 tokens   | General documentation             | Balanced precision and context                |
| 500-1000 tokens  | Narrative content, long-form docs | More context per chunk, less precise matching |

### Stage 4: Enrich

Enrichment adds metadata to each chunk to improve search quality:

- **Entity detection** -- Identifies emails, URLs, dates, and monetary values
- **Summary generation** -- Creates a brief summary of each chunk's content
- **Language detection** -- Identifies the content's language
- **Knowledge graph extraction** -- Extracts entities and relationships

This metadata is stored alongside the chunk and can be used for filtering and ranking search results.

### Stage 5: Embed

> **Key Concept**: The Embed stage is where text becomes searchable. Each chunk is converted into a vector representation -- a list of numbers that captures the chunk's semantic meaning. These vectors enable semantic search: finding content that is conceptually related to a query, even when the exact words differ. The query "How do I get my money back?" matches a chunk about "Refund policy and procedures" because their vector representations are similar, even though they share no words.

The platform uses the BGE-M3 embedding model by default, which works well for most use cases and supports multilingual content.

### Stage 6: Store

The final stage stores embedded chunks in a vector database. Each stored chunk includes:

- The original text content
- The vector embedding
- Metadata from enrichment
- Source information (document ID, source ID, page number)
- Permission metadata for access control

## How Agents Query Knowledge at Runtime

When an agent needs information, the Runtime executes a search against SearchAI using **hybrid search** -- combining two complementary strategies:

**Semantic search** finds chunks whose vector embeddings are most similar to the query embedding. It catches conceptual matches even when exact words differ.

**Keyword search** finds chunks containing the exact terms in the query. It catches specific names, product codes, or technical terms that semantic search might miss.

Results from both strategies are merged and re-ranked to produce a single list of the most relevant chunks.

### Connecting a Knowledge Base to an Agent

Add search tools to your agent definition:

```abl
AGENT: Support_Agent
GOAL: "Answer customer questions using product documentation"

TOOLS:
  - search_hybrid: Execute hybrid vector + keyword search
  - search_vector: Execute pure vector (semantic) search
  - vocabulary_resolve: Resolve business terms to metadata filters

INSTRUCTIONS: |
  1. When the user asks a question, search the knowledge base using search_hybrid
  2. If results are insufficient, retry with search_vector for broader semantic matching
  3. Synthesize an answer from retrieved chunks
  4. Include source attribution for transparency
```

The runtime automatically binds these tool names to the knowledge base configured for your project.

## Permission-Aware Search

> **Key Concept**: Permission-aware search ensures that search results respect the requesting user's access rights. When your knowledge base connects to a data source with access controls (like SharePoint or Confluence), only documents the user has permission to see are included in results. This means two users asking the same question may get different results based on their permissions. The permission metadata is stored alongside each chunk during ingestion and checked at query time.

This is critical for enterprise deployments where different teams, departments, or roles should only access certain documents. An HR agent searching a knowledge base that includes both public policies and confidential compensation documents will only surface the public policies to a general employee.

## Connectors and Delta Sync

Connectors automatically sync external data sources into your knowledge base, keeping content current without manual re-ingestion.

### Supported Connectors

| Connector   | What It Syncs                                |
| ----------- | -------------------------------------------- |
| SharePoint  | Documents and pages from sites and libraries |
| Jira        | Issues, comments, and attachments            |
| Confluence  | Pages and blog posts from spaces             |
| HubSpot     | Knowledge base articles                      |
| ServiceNow  | Knowledge articles and incident data         |
| Salesforce  | Knowledge articles, cases, custom objects    |
| Web Crawler | Any website with configurable crawl rules    |
| Database    | Records via SQL query                        |

### How Delta Sync Works

> **Key Concept**: Delta sync is the mechanism that keeps your knowledge base current without reprocessing everything. Instead of re-ingesting all documents on every sync cycle, the connector tracks what has changed since the last sync and only reprocesses modified or new documents. Deleted documents are removed from the knowledge base. This dramatically reduces processing time and cost for large data sources.

```
Connector --> polls for changes --> External System
                                       |
                              changed documents only
                                       |
                              Ingestion Pipeline
                                       |
                           Re-embed changed chunks
                                       |
                           Update vector store
```

Delta sync runs on a configurable schedule. You can also trigger it manually:

```bash
# Incremental sync (only changes since last sync)
curl -X POST https://your-platform/api/indexes/$INDEX_ID/connectors/$CONNECTOR_ID/sync \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode": "delta"}'

# Full re-sync (reprocess everything)
curl -X POST https://your-platform/api/indexes/$INDEX_ID/connectors/$CONNECTOR_ID/sync \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode": "full"}'
```

For database connectors, delta sync uses a configured `deltaColumn` (like `updated_at`) to detect changes. For platforms like SharePoint, it uses the platform's native change tracking APIs.

## Analytics: Cost Breakdown API

The analytics API provides visibility into your knowledge base and LLM usage costs. The cost-breakdown endpoint is particularly useful for understanding which models and providers are driving your spend.

> **Key Concept**: The cost-breakdown analytics API (`GET /api/projects/:projectId/analytics/cost-breakdown`) returns LLM cost data grouped by model and provider, letting you identify which agents and models are most expensive. This is project-scoped and requires authentication with `session:read` permission.

```bash
curl "https://api.ablplatform.com/api/projects/proj_abc/analytics/cost-breakdown?from=2026-03-01T00:00:00Z&to=2026-03-31T23:59:59Z" \
  -H "Authorization: Bearer abl_sk-your-api-key"
```

You can also query broader metrics:

```bash
curl "https://api.ablplatform.com/api/projects/proj_abc/analytics/metrics?groupBy=category,day&metrics=count,sum_cost" \
  -H "Authorization: Bearer abl_sk-your-api-key"
```

Available cost-related metrics include `sum_cost` (total cost in USD), `sum_tokens` (total tokens consumed), and `count` (number of events). Group by `category` to see costs broken down by LLM calls, search queries, tool executions, and more.

## Tuning Retrieval Quality

Several factors affect how well your knowledge base serves your agents:

**Document quality** -- Clean, well-structured content with clear headings and logical organization produces better chunks. Scanned images without OCR, heavily formatted tables, and mixed-language documents hurt quality.

**Chunking configuration** -- Start with semantic chunking and 10-20% overlap. Adjust chunk size based on your content type (smaller for FAQs, larger for narrative content).

**Search parameters** -- Configure `topK` (number of results) and `minScore` (minimum relevance threshold) at the project level:

```bash
curl -X PATCH https://your-platform/api/projects/$PROJECT_ID/settings \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "knowledgeBase": {
      "indexId": "your-index-id",
      "searchDefaults": {
        "topK": 5,
        "minScore": 0.7,
        "strategy": "hybrid"
      }
    }
  }'
```

**Query quality** -- Agents reasoning autonomously can reformulate queries if initial results are poor. Steps with `REASONING: false` use the query exactly as defined.

## Key Takeaways

- The 6-stage ingestion pipeline (Ingest, Extract, Chunk, Enrich, **Embed**, Store) transforms raw documents into searchable vector representations
- Semantic chunking preserves logical boundaries and is best for prose; fixed-size chunking gives predictable sizes for structured content
- Permission-aware search filters results based on user access rights, critical for enterprise data sources
- Delta sync only reprocesses changed documents, keeping knowledge bases current efficiently
- The cost-breakdown analytics API helps you monitor and optimize LLM spending by model and provider

## What's Next

Explore [Tools & Integrations](../tools-integrations/content.md) for more on connecting agents to external services, or see [API Fundamentals](../api-fundamentals/content.md) for the full analytics API reference.

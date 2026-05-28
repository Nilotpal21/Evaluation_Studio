# Multi-Modal Enrichment (ATLAS-KG Phase 4)

## Overview

The Multi-Modal Enrichment feature extracts and describes visual content (images, charts, tables) from documents using vision and language models via the platform's unified LLM Hub.

## Architecture

### Integration with LLM Hub

Unlike custom API clients, this implementation leverages the existing `@agent-platform/compiler` LLM Hub:

```typescript
┌─────────────────────────────────────────────────────────────┐
│                    LLM HUB (Platform)                       │
│  - Unified provider interface                               │
│  - Rate limiting & retry logic                              │
│  - Cost tracking via LLMUsageMetric                         │
│  - Prompt caching                                           │
│  - Error sanitization                                       │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│            Multi-Modal Enricher (SearchAI)                  │
│  - Image description via vision models                      │
│  - Table summarization via fast LLMs                        │
│  - Uses Message with DocumentImageContent blocks            │
└─────────────────────────────────────────────────────────────┘
                              ↓
                [Vision Models] + [Language Models]
         (OpenAI, Anthropic, Gemini - all via LLM Hub)
```

### Key Benefits

| Aspect             | Custom Clients          | LLM Hub Integration          |
| ------------------ | ----------------------- | ---------------------------- |
| Code Duplication   | Reimplements auth/retry | Reuses platform code         |
| Rate Limiting      | Per-service             | Centralized                  |
| Cost Tracking      | Scattered               | Unified via `LLMUsageMetric` |
| Prompt Caching     | None                    | Platform-level               |
| Error Handling     | Inconsistent            | Sanitized & unified          |
| API Keys           | SearchAI config         | Platform `LLMCredential`     |
| Provider Switching | Rewrite clients         | Change config                |
| Testing            | Mock each provider      | Mock one `LLMClient`         |

## Features

### 1. Image Description

Describes images, charts, and diagrams using vision-capable models:

**Supported Providers:**

- OpenAI (gpt-4-vision-preview) - $0.01/image
- Anthropic (claude-3-5-sonnet) - $0.008/image
- Gemini (gemini-2.5-pro-vision) - $0.0025/image

**Input Formats:**

- Base64-encoded images
- Image URLs (https://)
- MIME types: image/png, image/jpeg, image/gif, image/webp

**Example:**

```typescript
const enricher = new MultiModalEnricher(config);

const image = {
  data: 'iVBORw0KGgoAAAANS...', // base64
  format: 'base64',
  mimeType: 'image/png',
  context: 'Q3 revenue chart from financial report',
};

const result = await enricher.describeImage(image);
// result.description: "A bar chart showing Q3 revenue by region..."
```

### 2. Table Summarization

Generates semantic summaries of HTML tables, CSV data:

**Supported Providers:**

- Google Gemini Flash - $0.075/MTok (cheapest, recommended)
- OpenAI GPT-4o-mini - $0.15/MTok
- Anthropic Claude Haiku - $0.25/MTok

**Input Formats:**

- HTML tables (`<table>...</table>`)
- CSV data
- JSON arrays

**Example:**

```typescript
const table = {
  content: '<table><tr><th>Region</th><th>Revenue</th></tr>...</table>',
  format: 'html',
  rowCount: 12,
  columnCount: 4,
};

const result = await enricher.summarizeTable(table);
// result.summary: "Quarterly revenue by region showing North leading at $1.2M..."
```

### 3. Platform Integration

Uses the unified `LLMClient` from `@agent-platform/compiler`:

```typescript
import { LLMClient } from '@agent-platform/compiler/platform/llm';
import type { Message } from '@agent-platform/compiler/platform/llm/types';
import type { DocumentImageContent } from '../../types/document-image.js';
import { toImageContent } from '../../types/document-image.js';

// Document image content block (search-ai specific type)
const imageContent: DocumentImageContent = {
  type: 'document-image',
  source: {
    type: 'base64',
    media_type: 'image/png',
    data: '...',
  },
};

// Message with mixed text + image (converted to platform ImageContent)
const messages: Message[] = [
  {
    role: 'user',
    content: [{ type: 'text', text: 'Describe this image...' }, toImageContent(imageContent)],
  },
];

// Use platform's LLM client
const response = await llmClient.chat(systemPrompt, messages, options);
```

## Configuration

### Environment Variables

```bash
# Enable multi-modal enrichment
MULTIMODAL_ENABLED=true

# Vision provider (openai, anthropic, custom)
MULTIMODAL_VISION_PROVIDER=openai
MULTIMODAL_VISION_API_KEY=sk-...
MULTIMODAL_VISION_MODEL=gpt-4-vision-preview

# Table summarizer (google, openai, anthropic)
MULTIMODAL_TABLE_SUMMARIZER_PROVIDER=google
MULTIMODAL_TABLE_SUMMARIZER_API_KEY=...
MULTIMODAL_TABLE_SUMMARIZER_MODEL=gemini-1.5-flash

# Feature toggles
MULTIMODAL_ENABLE_IMAGE_DESCRIPTION=true
MULTIMODAL_ENABLE_TABLE_SUMMARIZATION=true
MULTIMODAL_ENABLE_CHART_ANALYSIS=true

# Limits
MULTIMODAL_MAX_IMAGE_SIZE_BYTES=20971520  # 20MB
MULTIMODAL_MAX_TABLE_SIZE_BYTES=102400    # 100KB
MULTIMODAL_RATE_LIMIT_PER_MINUTE=60
```

### Config Schema

```typescript
{
  enabled: boolean;                           // Default: false
  visionProvider: 'openai' | 'anthropic' | 'custom';
  visionApiKey?: string;                      // Optional (skip if not provided)
  customVisionEndpoint?: string;              // For custom provider
  visionModel: string;                        // Default: 'gpt-4-vision-preview'
  tableSummarizerProvider: 'openai' | 'anthropic' | 'google';
  tableSummarizerApiKey?: string;
  tableSummarizerModel: string;               // Default: 'gemini-1.5-flash'
  enableImageDescription: boolean;            // Default: true
  enableTableSummarization: boolean;          // Default: true
  enableChartAnalysis: boolean;               // Default: true
  maxImageSizeBytes: number;                  // Default: 20MB
  maxTableSizeBytes: number;                  // Default: 100KB
  rateLimitPerMinute: number;                 // Default: 60
}
```

## Pipeline Integration

### Worker Flow

```
ingest → extract → canonical-map → enrich
    ↓
    ├─→ [knowledge-graph worker]
    ├─→ [multimodal worker]     ← NEW
    └─→ [embedding worker]
    ↓
indexed
```

The multi-modal worker:

1. Runs **in parallel** with knowledge-graph and embedding
2. Triggered after enrichment
3. Processes only chunks with images/tables
4. Updates chunk metadata (non-blocking)
5. Gracefully handles errors (doesn't fail document)

### Chunk Metadata

Multi-modal results stored in chunk metadata:

```typescript
{
  metadata: {
    images: [
      {
        base64: '...',              // or url
        mimeType: 'image/png',
        width: 800,
        height: 600
      }
    ],
    imageDescriptions: [
      {
        description: 'A bar chart showing...',
        provider: 'openai',
        model: 'gpt-4-vision-preview'
      }
    ],
    tables: [
      {
        html: '<table>...</table>',
        rowCount: 12,
        columnCount: 4
      }
    ],
    tableSummaries: [
      {
        summary: 'Quarterly revenue by region...',
        provider: 'google',
        model: 'gemini-1.5-flash'
      }
    ],
    multiModalProcessed: true,
    multiModalCost: 0.08,
    multiModalTokens: 1500
  }
}
```

## Cost Analysis

**Per Document** (50 chunks, 10 with images, 5 with tables):

| Component           | Provider      | Unit Cost | Quantity | Total     |
| ------------------- | ------------- | --------- | -------- | --------- |
| Image Description   | OpenAI Vision | $0.01     | 10       | $0.10     |
| Table Summarization | Gemini Flash  | $0.0001   | 5        | $0.0005   |
| **Total**           |               |           |          | **$0.10** |

**Monthly at Scale** (100k documents):

- **With OpenAI Vision**: $10,000/month
- **With Claude Vision**: $8,000/month
- **With Gemini Vision**: $2,500/month

**Cost Optimizations:**

1. **Use cheapest models**: Gemini Flash for tables, Gemini Pro for vision
2. **Customer API keys**: Let customers provide their own keys (no cost to us)
3. **Selective processing**: Only process chunks flagged as having visual content
4. **Size limits**: Skip oversized images/tables
5. **Deduplication**: Hash-based caching for identical images
6. **Opt-in**: Disabled by default, enable per index

## Usage

### 1. Enable Multi-Modal

Set environment variables:

```bash
MULTIMODAL_ENABLED=true
MULTIMODAL_VISION_PROVIDER=openai
MULTIMODAL_VISION_API_KEY=sk-...
MULTIMODAL_TABLE_SUMMARIZER_PROVIDER=google
MULTIMODAL_TABLE_SUMMARIZER_API_KEY=...
```

### 2. Ingest Documents

The multi-modal worker runs automatically:

```bash
# Ingest a document with images/tables
curl -X POST http://localhost:3003/api/v1/ingest \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "indexId": "my-index",
    "documents": [
      {
        "url": "https://example.com/report.pdf",
        "metadata": { "type": "financial-report" }
      }
    ]
  }'
```

### 3. Query Results

Image descriptions and table summaries are embedded along with chunk text:

```bash
curl -X POST http://localhost:3003/api/v1/search \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "indexId": "my-index",
    "query": "What does the Q3 revenue chart show?",
    "topK": 5
  }'
```

Response includes chunks with visual content:

```json
{
  "results": [
    {
      "chunkId": "...",
      "content": "Q3 Performance Summary...",
      "metadata": {
        "imageDescriptions": [
          {
            "description": "A bar chart showing Q3 revenue by region: North $1.2M, South $900K, East $1.1M, West $800K. North leads with 32% growth YoY.",
            "provider": "openai",
            "model": "gpt-4-vision-preview"
          }
        ]
      },
      "score": 0.89
    }
  ]
}
```

## Testing

Run tests:

```bash
cd apps/search-ai
pnpm test multimodal
```

Test coverage:

- Image description (base64 & URL formats)
- Table summarization (HTML, CSV, JSON)
- Batch processing
- Size limit enforcement
- HTML extraction utilities
- Service availability checks

## Search-AI Type Extensions

Added `DocumentImageContent` for document extraction use cases:

```typescript
// apps/search-ai/src/types/document-image.ts

/**
 * DocumentImageContent - Image content for document extraction and vision analysis
 * Separate from platform's ImageContent (used for runtime user attachments)
 */
export interface DocumentImageContent {
  type: 'document-image';
  source: {
    type: 'base64' | 'url';
    media_type: string; // Always required - from docling metadata
    data?: string;
    url?: string;
  };
}

/**
 * Convert to platform ImageContent for LLM provider calls
 */
export function toImageContent(doc: DocumentImageContent): ImageContent;
```

The platform's `ImageContent` type (from `packages/compiler/src/platform/llm/types.ts`) is used for runtime user chat attachments. Search-AI uses `DocumentImageContent` for images extracted from documents via docling, then converts to `ImageContent` when sending to LLM providers.

All providers (OpenAI, Anthropic, Gemini, LiteLLM) already support vision via `supportsFeature('vision')`.

## Troubleshooting

### API Key Errors

**Error**: `Vision client not initialized`

**Solution**: Provide API key in config:

```bash
MULTIMODAL_VISION_API_KEY=sk-...
```

### Provider Not Supported

**Error**: `Provider does not support vision`

**Solution**: Use a vision-capable provider:

- OpenAI: gpt-4-vision-preview, gpt-4o
- Anthropic: claude-3-5-sonnet, claude-3-opus
- Google: gemini-2.5-pro, gemini-2.0-flash

### High Costs

**Issue**: Multi-modal processing too expensive

**Solution**:

1. Disable vision, keep only tables: `MULTIMODAL_ENABLE_IMAGE_DESCRIPTION=false`
2. Use cheaper provider: Switch to Gemini (`MULTIMODAL_VISION_PROVIDER=gemini`)
3. Customer keys: Have customers provide their own API keys
4. Selective processing: Only enable for specific indexes

### Images Not Processed

**Issue**: Images in document but no descriptions

**Solution**: Check that extraction worker is extracting images and storing them in chunk metadata. Images must be present in `chunk.metadata.images` array for multi-modal worker to process them.

## Future Enhancements

### Phase 4.1 (Current)

- ✅ Image description via vision models
- ✅ Table summarization via LLMs
- ✅ Integration with platform LLM Hub
- ✅ Cost optimization (customer keys, size limits)

### Phase 4.2 (Planned)

- Chart-specific analysis (detect chart type, extract data points)
- Diagram interpretation (flowcharts, architecture diagrams)
- OCR for text-in-images (supplement vision models)
- Video frame extraction and description

### Phase 4.3 (Future)

- Multi-modal embeddings (CLIP, ImageBind)
- Visual similarity search
- Image-to-image search
- Cross-modal retrieval (text query → find relevant images)

## References

- **Platform LLM Hub**: `packages/compiler/src/platform/llm/`
- **LLMClient API**: `packages/compiler/src/platform/llm/provider.ts`
- **Vision Pricing**: [OpenAI](https://openai.com/pricing), [Anthropic](https://anthropic.com/pricing), [Google](https://ai.google.dev/pricing)
- **ATLAS-KG Paper**: Multi-modal chunking research

## Support

For questions or issues, contact the SearchAI team or file an issue in the repository.

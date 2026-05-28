# Embedding Provider Guide

**Date**: 2026-02-21
**Status**: Production Ready
**Purpose**: Comprehensive guide for configuring and deploying embedding providers in the ABL Platform search-ai system

---

## Table of Contents

1. [Overview](#overview)
2. [Supported Providers](#supported-providers)
   - [BGE-M3 (In-House)](#1-bge-m3-in-house)
   - [OpenAI](#2-openai)
   - [Cohere](#3-cohere)
   - [Custom Endpoints](#4-custom-endpoints)
3. [Configuration Examples](#configuration-examples)
   - [Environment Variables](#environment-variables)
   - [Docker Compose](#docker-compose-examples)
   - [Kubernetes](#kubernetes-configuration)
   - [Helm Charts](#helm-chart-configuration)
   - [Per-Index Configuration](#per-index-configuration-api)
4. [Provider Comparison](#provider-comparison)
5. [Implementation Details](#implementation-details)
   - [Architecture](#architecture)
   - [Provider Interface](#provider-interface)
   - [Factory Pattern](#factory-pattern)
6. [Deployment](#deployment)
   - [BGE-M3 Deployment](#bge-m3-deployment)
   - [Production Recommendations](#recommended-defaults)
7. [Testing](#testing)
8. [Troubleshooting](#troubleshooting)
9. [Migration](#migration-between-providers)
10. [Cost Analysis](#cost-analysis)

---

## Overview

The ABL Platform search-ai system supports multiple embedding providers, allowing customers to choose the best option for their use case. The architecture is provider-agnostic, with a unified interface and factory pattern for creating providers.

### Key Features

- **Provider Flexibility**: Switch between OpenAI, Cohere, BGE-M3, or custom endpoints
- **Per-Index Configuration**: Different indexes can use different embedding providers
- **Cost Optimization**: Self-hosted options (BGE-M3) eliminate per-token costs
- **Standardized Interface**: All providers implement the same `EmbeddingProvider` interface
- **Batching Support**: Efficient batch processing with provider-specific limits
- **Health Monitoring**: Built-in health checks and latency tracking

### Architecture Components

**Location**: `packages/search-ai-internal/src/embedding/`

- **interface.ts**: Abstract `EmbeddingProvider` interface
- **factory.ts**: Factory pattern for creating providers
- **openai.ts**: OpenAI embeddings implementation
- **cohere.ts**: Cohere embeddings implementation
- **bge-m3.ts**: In-house BGE-M3 implementation
- **custom.ts**: Generic OpenAI-compatible custom endpoints

---

## Supported Providers

### 1. BGE-M3 (In-House)

**Model**: BAAI/bge-m3 (multilingual, 1024 dimensions)

**Deployment**: Self-hosted API (Docker, Kubernetes)

**Key Characteristics**:

- **Dimensions**: 1024 (fixed)
- **Max Context**: 512 tokens
- **Batch Size**: 32 texts/request (recommended)
- **Performance**: 0.3s/batch @ GPU
- **Cost**: $0 per token (compute only: ~$400/month GPU or $100/month CPU)
- **Languages**: 100+ languages supported
- **Break-even**: Pays for itself at >20M tokens/month vs OpenAI

**Use Cases**:

- Enterprise customers with high volume (>10M tokens/month)
- Cost-sensitive deployments
- Multilingual document collections
- Air-gapped or on-premise requirements

**Implementation**: `packages/search-ai-internal/src/embedding/bge-m3.ts`

```typescript
export class BGEm3EmbeddingProvider implements EmbeddingProvider {
  readonly name = 'bge-m3';
  readonly modelId = 'BAAI/bge-m3';
  readonly dimensions = 1024; // Fixed for BGE-M3
  readonly maxBatchSize: number;

  private readonly baseUrl: string;
  private readonly apiKey?: string; // Optional for self-hosted
  private readonly timeoutMs: number;

  constructor(config: EmbeddingProviderConfig) {
    this.apiKey = config.apiKey; // Optional
    this.baseUrl = (config.baseUrl ?? 'http://localhost:8001').replace(/\/$/, '');
    this.maxBatchSize = config.maxBatchSize ?? 32;
    this.timeoutMs = config.timeoutMs ?? 60_000;
  }

  async embed(text: string): Promise<number[]>;
  async embedBatch(texts: string[]): Promise<EmbeddingResult>;
  estimateTokens(text: string): number;
  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }>;
}
```

**API Format**: OpenAI-compatible

```bash
POST http://localhost:8001/v1/embeddings
{
  "input": ["text1", "text2"],
  "model": "bge-m3"
}
```

---

### 2. OpenAI

**Models**: text-embedding-3-small, text-embedding-3-large, ada-002

**Deployment**: Cloud API (OpenAI)

**Available Models**:

#### text-embedding-3-small (Recommended for Quick Start)

- **Dimensions**: 1536 (configurable)
- **Max Context**: 8191 tokens
- **Batch Size**: 100 texts/request
- **Performance**: <1s latency
- **Cost**: $0.02 per 1M tokens
- **Use Case**: Quick start, cloud-only deployments, testing

#### text-embedding-3-large (High Quality)

- **Dimensions**: 3072 (configurable)
- **Max Context**: 8191 tokens
- **Cost**: $0.13 per 1M tokens
- **Use Case**: High-quality search, complex documents

#### text-embedding-ada-002 (Legacy)

- **Dimensions**: 1536 (fixed)
- **Max Context**: 8191 tokens
- **Cost**: $0.10 per 1M tokens
- **Use Case**: Backwards compatibility with existing indexes

**Implementation**: `packages/search-ai-internal/src/embedding/openai.ts`

**Features**:

- Variable dimensions for embedding-3-\* models
- Automatic batching (up to 100 texts)
- Built-in rate limiting support
- Mature, production-ready API

**Use Cases**:

- Quick start and prototyping
- Low-volume deployments (<10M tokens/month)
- Cloud-only infrastructure
- Teams without ML infrastructure

---

### 3. Cohere

**Models**: embed-english-v3.0, embed-multilingual-v3.0

**Deployment**: Cloud API (Cohere)

**Key Characteristics**:

- **Dimensions**: 1024
- **Max Context**: 512 tokens
- **Batch Size**: 96 texts/request
- **Performance**: <1s latency
- **Cost**: $0.10 per 1M tokens
- **Input Types**: `search_document` (indexing), `search_query` (querying)

**Implementation**: `packages/search-ai-internal/src/embedding/cohere.ts`

**Unique Features**:

- Separate embeddings optimized for documents vs queries
- Semantic search optimization
- Multilingual v3 supports 100+ languages

**Use Cases**:

- Alternative to OpenAI
- Semantic search-specific optimization
- Multilingual document collections

---

### 4. Custom Endpoints

**Models**: Any OpenAI-compatible API

**Deployment**: Customer infrastructure

**Supported Models**:

- Sentence Transformers (all-MiniLM-L6-v2, all-mpnet-base-v2)
- Hugging Face models (E5, Instructor, multilingual-e5)
- Custom fine-tuned models
- Domain-specific embeddings

**Implementation**: `packages/search-ai-internal/src/embedding/custom.ts`

**Requirements**:

- Must provide `baseUrl` and `dimensions`
- Must implement OpenAI-compatible API format
- Optional authentication via `apiKey`

**Use Cases**:

- Air-gapped deployments
- Custom model requirements
- Fine-tuned domain-specific models
- Cost optimization with lightweight models

**Example Models**:

#### all-MiniLM-L6-v2 (Lightweight)

- **Dimensions**: 384
- **Performance**: Fast, lightweight
- **Use Case**: Cost-optimized, simple search

#### instructor-xl (Instruction-tuned)

- **Dimensions**: 768
- **Use Case**: Domain-specific retrieval with instructions

#### E5-Large-V2 (Multilingual)

- **Dimensions**: 1024
- **Use Case**: High-quality open source, multilingual

---

## Configuration Examples

### Environment Variables

#### OpenAI (Default)

```bash
EMBEDDING_PROVIDER=openai
EMBEDDING_API_KEY=sk-proj-...
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=1536
```

#### BGE-M3 (Recommended for Production)

```bash
EMBEDDING_PROVIDER=bge-m3
EMBEDDING_MODEL=BAAI/bge-m3
EMBEDDING_BASE_URL=http://bge-m3-api.internal:8001
EMBEDDING_DIMENSIONS=1024
EMBEDDING_MAX_BATCH_SIZE=32
EMBEDDING_TIMEOUT_MS=60000
# EMBEDDING_API_KEY optional for self-hosted
```

#### Cohere

```bash
EMBEDDING_PROVIDER=cohere
EMBEDDING_API_KEY=...
EMBEDDING_MODEL=embed-english-v3.0
EMBEDDING_DIMENSIONS=1024
EMBEDDING_MAX_BATCH_SIZE=96
```

#### Custom (Sentence Transformers)

```bash
EMBEDDING_PROVIDER=custom
EMBEDDING_MODEL=sentence-transformers/all-MiniLM-L6-v2
EMBEDDING_BASE_URL=http://custom-embeddings.example.com
EMBEDDING_API_KEY=optional-bearer-token
EMBEDDING_DIMENSIONS=384
EMBEDDING_MAX_BATCH_SIZE=50
```

---

### Docker Compose Examples

#### OpenAI (Simple)

```yaml
version: '3.8'

services:
  search-ai:
    image: agent-platform/search-ai:latest
    environment:
      - EMBEDDING_PROVIDER=openai
      - EMBEDDING_API_KEY=${OPENAI_API_KEY}
      - EMBEDDING_MODEL=text-embedding-3-small
      - EMBEDDING_DIMENSIONS=1536
```

#### Full Stack with BGE-M3

```yaml
version: '3.8'

services:
  # BGE-M3 Embedding Service
  bge-m3-api:
    image: ghcr.io/huggingface/text-embeddings-inference:1.2
    command: --model-id BAAI/bge-m3 --port 8000 --max-batch-tokens 16384
    ports:
      - '8000:8001'
    environment:
      - CUDA_VISIBLE_DEVICES=0 # GPU 0
    volumes:
      - bge-m3-models:/data
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    healthcheck:
      test: ['CMD', 'curl', '-f', 'http://localhost:8001/health']
      interval: 30s
      timeout: 10s
      retries: 3

  # Search-AI Service
  search-ai:
    image: agent-platform/search-ai:latest
    environment:
      - EMBEDDING_PROVIDER=bge-m3
      - EMBEDDING_BASE_URL=http://bge-m3-api:8001
      - EMBEDDING_MODEL=BAAI/bge-m3
      - EMBEDDING_DIMENSIONS=1024
      - VECTOR_STORE_PROVIDER=qdrant
      - VECTOR_STORE_URL=http://qdrant:6333
    depends_on:
      - bge-m3-api
      - qdrant

  # Qdrant Vector Store
  qdrant:
    image: qdrant/qdrant:latest
    ports:
      - '6333:6333'
    volumes:
      - qdrant-storage:/qdrant/storage

volumes:
  bge-m3-models:
  qdrant-storage:
```

#### Custom Sentence Transformers

```yaml
services:
  custom-embeddings:
    image: ghcr.io/huggingface/text-embeddings-inference:latest
    command: |
      --model-id sentence-transformers/all-MiniLM-L6-v2
      --port 8000
    ports:
      - '8000:8001'

  search-ai:
    image: agent-platform/search-ai:latest
    environment:
      - EMBEDDING_PROVIDER=custom
      - EMBEDDING_BASE_URL=http://custom-embeddings:8001
      - EMBEDDING_MODEL=sentence-transformers/all-MiniLM-L6-v2
      - EMBEDDING_DIMENSIONS=384
    depends_on:
      - custom-embeddings
```

---

### Kubernetes Configuration

#### BGE-M3 Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: bge-m3-api
  namespace: search-ai
spec:
  replicas: 2
  selector:
    matchLabels:
      app: bge-m3-api
  template:
    metadata:
      labels:
        app: bge-m3-api
    spec:
      containers:
        - name: bge-m3
          image: ghcr.io/huggingface/text-embeddings-inference:1.2
          args:
            - --model-id
            - BAAI/bge-m3
            - --port
            - '8000'
            - --max-batch-tokens
            - '16384'
          ports:
            - containerPort: 8000
          resources:
            limits:
              nvidia.com/gpu: 1
              memory: 8Gi
            requests:
              nvidia.com/gpu: 1
              memory: 4Gi
          livenessProbe:
            httpGet:
              path: /health
              port: 8000
            initialDelaySeconds: 60
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /health
              port: 8000
            initialDelaySeconds: 30
            periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: bge-m3-api
  namespace: search-ai
spec:
  selector:
    app: bge-m3-api
  ports:
    - port: 8000
      targetPort: 8000
  type: ClusterIP
```

#### Search-AI Deployment with BGE-M3

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: search-ai
  namespace: search-ai
spec:
  replicas: 3
  template:
    spec:
      containers:
        - name: search-ai
          image: agent-platform/search-ai:latest
          env:
            - name: EMBEDDING_PROVIDER
              value: 'bge-m3'
            - name: EMBEDDING_BASE_URL
              value: 'http://bge-m3-api.search-ai.svc.cluster.local:8001'
            - name: EMBEDDING_MODEL
              value: 'BAAI/bge-m3'
            - name: EMBEDDING_DIMENSIONS
              value: '1024'
```

---

### Helm Chart Configuration

#### OpenAI (values.yaml)

```yaml
searchAi:
  embedding:
    provider: openai
    apiKey: sk-proj-... # Or use existingSecret
    model: text-embedding-3-small
    dimensions: 1536

  # Use existing secret for API key
  embeddingApiKeySecret:
    name: openai-api-key
    key: api-key
```

#### BGE-M3 (values.yaml)

```yaml
# Deploy BGE-M3 service
bgeM3:
  enabled: true
  replicaCount: 2
  resources:
    limits:
      cpu: 4
      memory: 8Gi
      nvidia.com/gpu: 1
    requests:
      cpu: 2
      memory: 4Gi
      nvidia.com/gpu: 1
  autoscaling:
    enabled: true
    minReplicas: 2
    maxReplicas: 10
    targetCPUUtilizationPercentage: 70

# Configure search-ai to use BGE-M3
searchAi:
  embedding:
    provider: bge-m3
    baseUrl: http://bge-m3-api.search-ai.svc.cluster.local:8001
    model: BAAI/bge-m3
    dimensions: 1024
    maxBatchSize: 32
    timeoutMs: 60000
```

#### Custom (values.yaml)

```yaml
searchAi:
  embedding:
    provider: custom
    baseUrl: http://custom-embeddings.internal:8001
    apiKey: '' # Optional
    model: sentence-transformers/all-MiniLM-L6-v2
    dimensions: 384
    maxBatchSize: 50
```

---

### Per-Index Configuration (API)

Override embedding provider per index via REST API. This allows different indexes to use different embedding models.

#### Create Index with BGE-M3

```bash
curl -X POST http://localhost:3003/api/v1/indexes \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "contracts-bge-m3",
    "embeddingProvider": {
      "provider": "bge-m3",
      "baseUrl": "http://bge-m3-api:8001",
      "model": "BAAI/bge-m3",
      "dimensions": 1024
    },
    "vectorStore": {
      "provider": "qdrant",
      "collectionName": "contracts"
    }
  }'
```

#### Create Index with OpenAI Large

```bash
curl -X POST http://localhost:3003/api/v1/indexes \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "docs-openai-large",
    "embeddingProvider": {
      "provider": "openai",
      "apiKey": "sk-proj-...",
      "model": "text-embedding-3-large",
      "dimensions": 3072
    },
    "vectorStore": {
      "provider": "qdrant",
      "collectionName": "docs"
    }
  }'
```

#### Create Index with Custom Model

```bash
curl -X POST http://localhost:3003/api/v1/indexes \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "legal-custom",
    "embeddingProvider": {
      "provider": "custom",
      "baseUrl": "http://custom-embeddings.example.com",
      "apiKey": "optional-bearer-token",
      "model": "legal-bert-base",
      "dimensions": 768,
      "maxBatchSize": 50
    }
  }'
```

---

## Provider Comparison

### Feature Matrix

| Provider                           | Dimensions | Max Context | Batch Size | Cost (1M tokens)  | Latency    | Use Case                                 |
| ---------------------------------- | ---------- | ----------- | ---------- | ----------------- | ---------- | ---------------------------------------- |
| **BGE-M3** (in-house)              | 1024       | 512 tokens  | 32         | $0 (compute only) | 0.3s @ GPU | Enterprise, cost-sensitive, multilingual |
| **OpenAI text-embedding-3-small**  | 1536       | 8191 tokens | 100        | $20               | <1s        | Quick start, cloud-only                  |
| **OpenAI text-embedding-3-large**  | 3072       | 8191 tokens | 100        | $130              | <1s        | High quality, large context              |
| **OpenAI ada-002**                 | 1536       | 8191 tokens | 100        | $100              | <1s        | Legacy, backwards compat                 |
| **Cohere embed-english-v3**        | 1024       | 512 tokens  | 96         | $100              | <1s        | Semantic search, OpenAI alternative      |
| **Cohere embed-multilingual-v3**   | 1024       | 512 tokens  | 96         | $100              | <1s        | Multilingual documents                   |
| **Custom (Sentence Transformers)** | Variable   | Variable    | Variable   | $0 (compute only) | Variable   | Air-gapped, fine-tuned models            |

### Deployment Models

| Provider   | Deployment  | Infrastructure    | Scalability         | Availability        |
| ---------- | ----------- | ----------------- | ------------------- | ------------------- |
| **BGE-M3** | Self-hosted | K8s/Docker + GPU  | Horizontal pods     | Customer-controlled |
| **OpenAI** | Cloud API   | Managed by OpenAI | Auto-scaled         | 99.9% SLA           |
| **Cohere** | Cloud API   | Managed by Cohere | Auto-scaled         | 99.9% SLA           |
| **Custom** | Self-hosted | Customer choice   | Customer-controlled | Customer-controlled |

### Security & Compliance

| Provider   | Data Residency      | PII Handling         | Air-Gap Support | SOC 2                   |
| ---------- | ------------------- | -------------------- | --------------- | ----------------------- |
| **BGE-M3** | Customer-controlled | Never leaves network | Yes             | Customer responsibility |
| **OpenAI** | US/EU regions       | Sent to OpenAI       | No              | OpenAI SOC 2            |
| **Cohere** | US/EU regions       | Sent to Cohere       | No              | Cohere SOC 2            |
| **Custom** | Customer-controlled | Never leaves network | Yes             | Customer responsibility |

---

## Implementation Details

### Architecture

The embedding system uses a provider-agnostic architecture with a factory pattern and shared interface.

```
┌─────────────────────────────────────────────────────────────┐
│                    Search-AI Application                    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │          EmbeddingProvider Interface                 │  │
│  │  - embed(text: string): Promise<number[]>           │  │
│  │  - embedBatch(texts: string[]): EmbeddingResult     │  │
│  │  - estimateTokens(text: string): number             │  │
│  │  - healthCheck(): Promise<{ok, latencyMs}>          │  │
│  └──────────────────────────────────────────────────────┘  │
│                          ▲                                  │
│                          │                                  │
│          ┌───────────────┴────────────────┐                │
│          │                                │                │
│  ┌───────┴────────┐              ┌───────┴────────┐       │
│  │  OpenAI        │              │  Cohere        │       │
│  │  Provider      │              │  Provider      │       │
│  └────────────────┘              └────────────────┘       │
│  ┌────────────────┐              ┌────────────────┐       │
│  │  BGE-M3        │              │  Custom        │       │
│  │  Provider      │              │  Provider      │       │
│  └────────────────┘              └────────────────┘       │
└─────────────────────────────────────────────────────────────┘
```

### Provider Interface

**Location**: `packages/search-ai-internal/src/embedding/interface.ts`

```typescript
export interface EmbeddingProvider {
  readonly name: string;
  readonly modelId: string;
  readonly dimensions: number;
  readonly maxBatchSize: number;

  /**
   * Embed a single text string.
   * Returns a vector of length `dimensions`.
   */
  embed(text: string): Promise<number[]>;

  /**
   * Embed a batch of texts.
   * Automatically splits into chunks of `maxBatchSize` if needed.
   */
  embedBatch(texts: string[]): Promise<EmbeddingResult>;

  /**
   * Estimate token count for billing/rate limiting.
   * Used to prevent exceeding provider limits.
   */
  estimateTokens(text: string): number;

  /**
   * Check provider health and measure latency.
   * Used for monitoring and load balancing.
   */
  healthCheck(): Promise<{ ok: boolean; latencyMs: number }>;
}

export interface EmbeddingResult {
  embeddings: number[][];
  totalTokens: number;
  model: string;
  dimensions: number;
}

export interface EmbeddingProviderConfig {
  apiKey?: string;
  model: string;
  dimensions?: number;
  maxBatchSize?: number;
  timeoutMs?: number;
  baseUrl?: string;
}
```

### Factory Pattern

**Location**: `packages/search-ai-internal/src/embedding/factory.ts`

```typescript
export interface EmbeddingFactoryConfig {
  provider: 'openai' | 'cohere' | 'bge-m3' | 'custom';
  apiKey?: string;
  model: string;
  dimensions?: number;
  maxBatchSize?: number;
  timeoutMs?: number;
  baseUrl?: string;
}

/**
 * Create an embedding provider from configuration.
 * Supports: OpenAI, Cohere, BGE-M3 (in-house), Custom (customer-hosted)
 */
export function createEmbeddingProvider(config: EmbeddingFactoryConfig): EmbeddingProvider {
  const providerConfig: EmbeddingProviderConfig = {
    apiKey: config.apiKey ?? '',
    model: config.model,
    dimensions: config.dimensions,
    maxBatchSize: config.maxBatchSize,
    timeoutMs: config.timeoutMs,
    baseUrl: config.baseUrl,
  };

  switch (config.provider) {
    case 'openai':
      return new OpenAIEmbeddingProvider(providerConfig);

    case 'cohere':
      return new CohereEmbeddingProvider(providerConfig);

    case 'bge-m3':
      return new BGEm3EmbeddingProvider(providerConfig);

    case 'custom':
      return new CustomEmbeddingProvider(providerConfig);

    default:
      throw new Error(`Unknown embedding provider: ${config.provider}`);
  }
}
```

### Key Design Principles

1. **Provider Agnostic**: Application code depends only on the interface, never concrete implementations
2. **Configuration-Driven**: All provider selection happens via config, no code changes required
3. **Batching**: All providers support automatic batching with provider-specific limits
4. **Error Handling**: Structured errors with context (status code, error text, provider name)
5. **Observability**: All operations track latency, token usage, and success/failure
6. **Tenant Isolation**: Each provider instance can be scoped to a tenant or index

---

## Deployment

### BGE-M3 Deployment

#### Docker Deployment

**File**: `docker-compose.bge-m3.yml`

```yaml
version: '3.8'

services:
  bge-m3-api:
    image: ghcr.io/huggingface/text-embeddings-inference:1.2
    command: --model-id BAAI/bge-m3 --port 8000 --max-batch-tokens 16384
    ports:
      - '8000:8001'
    environment:
      - CUDA_VISIBLE_DEVICES=0 # GPU 0
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    healthcheck:
      test: ['CMD', 'curl', '-f', 'http://localhost:8001/health']
      interval: 30s
      timeout: 10s
      retries: 3
```

**Start Service**:

```bash
docker-compose -f docker-compose.bge-m3.yml up -d
```

#### Production Considerations

**GPU Requirements**:

- NVIDIA GPU with CUDA support
- Minimum 4GB VRAM (8GB recommended)
- T4, V100, A10G, or better

**CPU-Only Deployment** (slower but cheaper):

```yaml
services:
  bge-m3-api:
    image: ghcr.io/huggingface/text-embeddings-inference:1.2-cpu
    command: --model-id BAAI/bge-m3 --port 8000 --max-batch-tokens 8192
    # No GPU required
```

**Horizontal Scaling**:

```yaml
services:
  bge-m3-api:
    deploy:
      replicas: 3
      resources:
        limits:
          nvidia.com/gpu: 1
```

**Monitoring**:

```bash
# Health check endpoint
curl http://localhost:8001/health

# Metrics endpoint (Prometheus format)
curl http://localhost:8001/metrics
```

---

### Recommended Defaults

#### Enterprise Customers (>10M tokens/month)

```bash
EMBEDDING_PROVIDER=bge-m3
EMBEDDING_BASE_URL=http://bge-m3-api.internal:8001
EMBEDDING_MODEL=BAAI/bge-m3
EMBEDDING_DIMENSIONS=1024
EMBEDDING_MAX_BATCH_SIZE=32
EMBEDDING_TIMEOUT_MS=60000
```

**Rationale**: BGE-M3 pays for itself at >20M tokens/month, provides data residency, and eliminates per-token costs.

#### Cloud-Only / Quick Start (<10M tokens/month)

```bash
EMBEDDING_PROVIDER=openai
EMBEDDING_API_KEY=sk-proj-...
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=1536
```

**Rationale**: OpenAI is cheaper for low volumes, requires zero infrastructure, and provides instant availability.

#### Air-Gapped / Custom Models

```bash
EMBEDDING_PROVIDER=custom
EMBEDDING_BASE_URL=http://custom-api.internal:8001
EMBEDDING_MODEL=sentence-transformers/all-MiniLM-L6-v2
EMBEDDING_DIMENSIONS=384
EMBEDDING_MAX_BATCH_SIZE=50
```

**Rationale**: Custom models enable fine-tuning for domain-specific terminology, air-gapped deployments, and regulatory compliance.

---

## Testing

### Unit Tests

**Location**: `packages/search-ai-internal/src/embedding/__tests__/providers.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import {
  OpenAIEmbeddingProvider,
  CohereEmbeddingProvider,
  BGEm3EmbeddingProvider,
  CustomEmbeddingProvider,
  createEmbeddingProvider,
} from '../index.js';

describe('Embedding Providers', () => {
  describe('OpenAI', () => {
    it('should embed text', async () => {
      const provider = new OpenAIEmbeddingProvider({
        apiKey: process.env.OPENAI_API_KEY!,
        model: 'text-embedding-3-small',
      });

      const embedding = await provider.embed('hello world');
      expect(embedding).toHaveLength(1536);
    });

    it('should handle batch embedding', async () => {
      const provider = new OpenAIEmbeddingProvider({
        apiKey: process.env.OPENAI_API_KEY!,
        model: 'text-embedding-3-small',
      });

      const result = await provider.embedBatch(['text1', 'text2', 'text3']);

      expect(result.embeddings).toHaveLength(3);
      expect(result.totalTokens).toBeGreaterThan(0);
    });
  });

  describe('BGE-M3', () => {
    it('should embed batch', async () => {
      const provider = new BGEm3EmbeddingProvider({
        baseUrl: 'http://localhost:8001',
        model: 'bge-m3',
      });

      const result = await provider.embedBatch(['text1', 'text2']);
      expect(result.embeddings).toHaveLength(2);
      expect(result.embeddings[0]).toHaveLength(1024);
    });

    it('should perform health check', async () => {
      const provider = new BGEm3EmbeddingProvider({
        baseUrl: 'http://localhost:8001',
        model: 'bge-m3',
      });

      const health = await provider.healthCheck();
      expect(health.ok).toBe(true);
      expect(health.latencyMs).toBeGreaterThan(0);
    });
  });

  describe('Factory', () => {
    it('should create OpenAI provider', () => {
      const provider = createEmbeddingProvider({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'text-embedding-3-small',
      });

      expect(provider.name).toBe('openai');
      expect(provider.dimensions).toBe(1536);
    });

    it('should create BGE-M3 provider', () => {
      const provider = createEmbeddingProvider({
        provider: 'bge-m3',
        baseUrl: 'http://localhost:8001',
        model: 'bge-m3',
      });

      expect(provider.name).toBe('bge-m3');
      expect(provider.dimensions).toBe(1024);
    });

    it('should throw on unknown provider', () => {
      expect(() =>
        createEmbeddingProvider({
          provider: 'unknown' as any,
          model: 'test',
        }),
      ).toThrow('Unknown embedding provider');
    });
  });
});
```

### Integration Tests

**Location**: `apps/search-ai/src/__tests__/integration/embedding-providers.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { createEmbeddingProvider } from '@agent-platform/search-ai-internal';

describe('Embedding Providers - Integration', () => {
  it('should embed with all providers', async () => {
    const providers = [
      createEmbeddingProvider({
        provider: 'openai',
        apiKey: process.env.OPENAI_API_KEY!,
        model: 'text-embedding-3-small',
      }),
      createEmbeddingProvider({
        provider: 'bge-m3',
        baseUrl: process.env.BGE_M3_URL!,
        model: 'bge-m3',
      }),
    ];

    const text = 'This is a test document about machine learning.';

    for (const provider of providers) {
      const result = await provider.embedBatch([text]);

      expect(result.embeddings).toHaveLength(1);
      expect(result.embeddings[0].length).toBeGreaterThan(0);
      expect(result.model).toBeTruthy();
      expect(result.totalTokens).toBeGreaterThan(0);

      console.log(`${provider.name}: ${result.dimensions}D, ${result.totalTokens} tokens`);
    }
  });

  it('should have consistent dimensions', async () => {
    const provider = createEmbeddingProvider({
      provider: 'openai',
      apiKey: process.env.OPENAI_API_KEY!,
      model: 'text-embedding-3-small',
    });

    const texts = ['short', 'This is a longer text with more tokens'];
    const result = await provider.embedBatch(texts);

    // All embeddings should have same dimensions
    expect(result.embeddings[0].length).toBe(result.embeddings[1].length);
    expect(result.embeddings[0].length).toBe(provider.dimensions);
  });
});
```

### Manual Testing

#### Health Check

```bash
# OpenAI (via search-ai API)
curl http://localhost:3003/api/v1/embeddings/health

# BGE-M3 (direct)
curl http://localhost:8001/health
```

**Expected Response**:

```json
{
  "status": "healthy",
  "provider": "bge-m3",
  "model": "BAAI/bge-m3",
  "dimensions": 1024,
  "latencyMs": 123
}
```

#### Test Embedding

```bash
curl -X POST http://localhost:3003/api/v1/embeddings/test \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "This is a test document",
    "provider": "bge-m3"
  }'
```

**Expected Response**:

```json
{
  "embedding": [0.123, -0.456, ...],
  "dimensions": 1024,
  "model": "BAAI/bge-m3",
  "totalTokens": 6,
  "latencyMs": 234
}
```

---

## Troubleshooting

### Provider Not Available

**Symptoms**:

```
Error: Failed to connect to embedding provider
ECONNREFUSED http://localhost:8001
```

**Diagnosis**:

```bash
# Check provider health
curl http://localhost:8001/health

# Check search-ai logs
kubectl logs -n search-ai deployment/search-ai-worker | grep embedding

# Verify environment variables
env | grep EMBEDDING

# Check DNS resolution (K8s)
nslookup bge-m3-api.search-ai.svc.cluster.local
```

**Solutions**:

1. Ensure BGE-M3 service is running: `docker ps | grep bge-m3`
2. Verify `EMBEDDING_BASE_URL` matches actual endpoint
3. Check network connectivity between services
4. Review firewall/security group rules

---

### Dimension Mismatch

**Symptoms**:

```
Error: Vector dimension mismatch. Expected 1024, got 1536
```

**Root Cause**: Index was created with different dimensions than current provider.

**Solutions**:

**Option 1**: Update provider to match index

```bash
# If index uses 1536 dimensions (OpenAI)
EMBEDDING_PROVIDER=openai
EMBEDDING_DIMENSIONS=1536
```

**Option 2**: Create new index with correct dimensions

```bash
curl -X POST http://localhost:3003/api/v1/indexes \
  -d '{"name": "my-index-v2", "embeddingProvider": {"dimensions": 1024}}'
```

**Option 3**: Re-index documents

```bash
curl -X POST http://localhost:3003/api/v1/indexes/my-index/reindex
```

**Dimension Reference**:

- OpenAI text-embedding-3-small: 1536
- OpenAI text-embedding-3-large: 3072
- BGE-M3: 1024
- Cohere: 1024
- Sentence Transformers (MiniLM): 384

---

### Connection Timeout

**Symptoms**:

```
Error: Embedding request timed out after 30000ms
```

**Solutions**:

1. **Increase timeout for self-hosted models**:

```bash
EMBEDDING_TIMEOUT_MS=120000  # 2 minutes
```

2. **Check model loading time** (first request):

```bash
# BGE-M3 takes 30-60s to load model on first request
# Subsequent requests should be <1s

curl http://localhost:8001/health
# Wait for "ready" status before sending production traffic
```

3. **Add warm-up call** in application startup:

```typescript
// Warm up embedding provider on startup
await embeddingProvider.healthCheck();
await embeddingProvider.embed('warmup');
```

4. **Monitor resource usage**:

```bash
# CPU-bound (no GPU)
docker stats bge-m3-api

# GPU usage
nvidia-smi
```

---

### Rate Limiting (OpenAI)

**Symptoms**:

```
Error: Rate limit exceeded. 429 Too Many Requests
Retry-After: 20
```

**Solutions**:

1. **Reduce concurrency**:

```bash
EMBEDDING_WORKER_CONCURRENCY=2  # Reduce from 3
```

2. **Implement exponential backoff** (already built-in for OpenAI provider)

3. **Batch more efficiently**:

```bash
# OpenAI allows up to 100 texts per request
EMBEDDING_MAX_BATCH_SIZE=100
```

4. **Switch to BGE-M3** (no rate limits):

```bash
EMBEDDING_PROVIDER=bge-m3
EMBEDDING_BASE_URL=http://bge-m3-api:8001
```

5. **Request rate limit increase** from OpenAI (for production workloads)

---

### API Key Issues

**Symptoms**:

```
Error: Invalid API key. 401 Unauthorized
```

**Solutions**:

1. **Verify API key format**:

```bash
# OpenAI: starts with "sk-proj-" or "sk-"
# Cohere: alphanumeric string

echo $EMBEDDING_API_KEY
```

2. **Check key permissions**:

- OpenAI: Ensure key has "Embeddings" permission
- Cohere: Ensure key has "Embed" permission

3. **Rotate key if compromised**:

```bash
# Generate new key, update secret, restart pods
kubectl delete secret embedding-api-key
kubectl create secret generic embedding-api-key \
  --from-literal=api-key=sk-proj-NEW_KEY
kubectl rollout restart deployment/search-ai
```

4. **For self-hosted (BGE-M3)**: API key is optional

```bash
# Remove API key requirement
unset EMBEDDING_API_KEY
```

---

### Model Not Found

**Symptoms**:

```
Error: Model "BAAI/bge-m3" not found or failed to load
```

**Solutions**:

1. **Wait for model download** (first startup):

```bash
# BGE-M3 downloads ~2GB on first run
# Check logs:
docker logs bge-m3-api

# Expected: "Model BAAI/bge-m3 loaded successfully"
```

2. **Pre-download model**:

```bash
# Mount pre-downloaded model directory
docker run -v ./models:/data \
  ghcr.io/huggingface/text-embeddings-inference:1.2 \
  --model-id BAAI/bge-m3
```

3. **Verify disk space**:

```bash
df -h
# Model requires ~2-3GB free space
```

4. **Check model ID spelling**:

- BGE-M3: `BAAI/bge-m3` (case-sensitive)
- OpenAI: `text-embedding-3-small` (exact match)

---

## Migration Between Providers

### Scenario: Migrate from OpenAI to BGE-M3

**Reason**: Reduce costs for high-volume production workload (>20M tokens/month)

#### Step 1: Deploy BGE-M3 Service

```bash
# Kubernetes
kubectl apply -f deploy/k8s/bge-m3-deployment.yaml

# Wait for ready
kubectl wait --for=condition=ready pod -l app=bge-m3-api -n search-ai

# Verify health
kubectl exec -n search-ai deployment/search-ai -- \
  curl http://bge-m3-api:8001/health
```

#### Step 2: Create New Index with BGE-M3

```bash
curl -X POST http://localhost:3003/api/v1/indexes \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "contracts-v2",
    "embeddingProvider": {
      "provider": "bge-m3",
      "baseUrl": "http://bge-m3-api.search-ai.svc.cluster.local:8001",
      "model": "BAAI/bge-m3",
      "dimensions": 1024
    },
    "vectorStore": {
      "provider": "qdrant",
      "collectionName": "contracts-v2"
    }
  }'
```

#### Step 3: Re-index Documents

**Option A: API Re-index** (copies from existing index)

```bash
curl -X POST http://localhost:3003/api/v1/indexes/contracts-v2/reindex \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "sourceIndexId": "contracts-v1"
  }'
```

**Option B: Bulk Re-ingestion** (from original documents)

```bash
# Re-submit documents via bulk API
curl -X POST http://localhost:3003/api/v1/indexes/contracts-v2/documents/bulk \
  -H "Authorization: Bearer $TOKEN" \
  -d @documents.ndjson
```

#### Step 4: Validate New Index

```bash
# Test query on both indexes
curl -X POST http://localhost:3003/api/v1/indexes/contracts-v1/search \
  -d '{"query": "test query", "limit": 5}'

curl -X POST http://localhost:3003/api/v1/indexes/contracts-v2/search \
  -d '{"query": "test query", "limit": 5}'

# Compare results (quality, latency)
```

#### Step 5: Switch Traffic

**Blue-Green Deployment**:

```bash
# Update application config to use new index
INDEX_NAME=contracts-v2

# Or use feature flag for gradual rollout
FEATURE_BGE_M3_INDEX_ENABLED=true
FEATURE_BGE_M3_INDEX_ROLLOUT=50  # 50% traffic
```

**DNS/Alias Update** (if using index aliases):

```bash
curl -X PUT http://localhost:3003/api/v1/indexes/aliases/contracts \
  -d '{"targetIndex": "contracts-v2"}'
```

#### Step 6: Monitor

```bash
# Monitor query latency
kubectl logs -n search-ai deployment/search-ai | grep "query_duration"

# Monitor embedding latency
kubectl logs -n search-ai deployment/bge-m3-api | grep "embed_duration"

# Check error rates
kubectl logs -n search-ai deployment/search-ai | grep "ERROR"
```

#### Step 7: Clean Up Old Index

**After 30 days of stable operation**:

```bash
# Delete old index
curl -X DELETE http://localhost:3003/api/v1/indexes/contracts-v1 \
  -H "Authorization: Bearer $TOKEN"

# Remove OpenAI API key (if no longer needed)
kubectl delete secret openai-api-key
```

---

### Rollback Plan

If issues occur during migration:

```bash
# Rollback to old index
INDEX_NAME=contracts-v1

# Or disable feature flag
FEATURE_BGE_M3_INDEX_ENABLED=false

# Restore alias
curl -X PUT http://localhost:3003/api/v1/indexes/aliases/contracts \
  -d '{"targetIndex": "contracts-v1"}'
```

---

## Cost Analysis

### 1M Token Comparison

**Scenario**: Index 100-page documents (200 chunks/doc, 500 docs = 100K chunks)

| Provider              | Cost/1M tokens | Total Cost | Monthly (10M) | Monthly (100M) | Notes                     |
| --------------------- | -------------- | ---------- | ------------- | -------------- | ------------------------- |
| **BGE-M3** (in-house) | $0             | **$0**     | **$0**        | **$0**         | GPU: $400/mo fixed        |
| **OpenAI (small)**    | $0.02          | **$20**    | **$200**      | **$2,000**     | Best for <10M tokens/mo   |
| **OpenAI (large)**    | $0.13          | **$130**   | **$1,300**    | **$13,000**    | High quality, expensive   |
| **OpenAI (ada-002)**  | $0.10          | **$100**   | **$1,000**    | **$10,000**    | Legacy model              |
| **Cohere**            | $0.10          | **$100**   | **$1,000**    | **$10,000**    | Semantic search optimized |

### Break-Even Analysis

**BGE-M3 Infrastructure Costs**:

- GPU (T4): $400/month
- CPU-only: $100/month
- Storage: $20/month
- Monitoring: $30/month
- **Total**: $450-550/month

**Break-Even Points**:

- **vs OpenAI Small**: 22.5M tokens/month ($450 / $0.02)
- **vs OpenAI Large**: 3.5M tokens/month ($450 / $0.13)
- **vs Cohere**: 4.5M tokens/month ($450 / $0.10)

**Recommendation**:

- **<10M tokens/month**: Use OpenAI (simpler, no infrastructure)
- **10-20M tokens/month**: Evaluate based on team capacity
- **>20M tokens/month**: BGE-M3 strongly recommended

### Real-World Example

**Customer**: Enterprise with 50K documents, 10M tokens/month

**Option 1: OpenAI Small**

- Cost: $200/month
- Pros: No infrastructure, instant setup
- Cons: Ongoing per-token costs, data sent to OpenAI

**Option 2: BGE-M3**

- Cost: $450/month (infrastructure)
- Pros: Zero marginal cost, data never leaves network, scales to 100M+ tokens
- Cons: Requires GPU, infrastructure management
- **Savings after 1 year** (if growth to 50M tokens/month): $450 vs $1,000 = $550/mo saved

**Decision**: Deploy BGE-M3 if:

- Volume expected to grow beyond 20M tokens/month
- Data residency required (PCI, HIPAA, GDPR)
- Air-gapped deployment needed
- Cost predictability important

---

**Status**: Production Ready
**Last Updated**: 2026-02-21
**Maintainer**: ABL Platform Team

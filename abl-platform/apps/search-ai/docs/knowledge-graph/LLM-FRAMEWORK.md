# LLM Framework Architecture

## Overview

The platform uses a **provider-agnostic LLM framework** from `@abl/compiler/platform/llm`. This allows any service to use ANY LLM provider (Anthropic, OpenAI, Gemini, LiteLLM, Azure, Bedrock, Vertex, or custom) without hardcoding dependencies.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    LLMClient                             │
│          (Convenience wrapper with simple API)           │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                   LLMProvider Interface                  │
│   (Provider-agnostic interface for all LLM operations)  │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────┬────────────────┬──────────────────────┐
│  Anthropic       │    OpenAI      │    LiteLLM           │
│  Provider        │    Provider    │    Provider          │
├──────────────────┼────────────────┼──────────────────────┤
│  Gemini          │    Azure       │    Bedrock           │
│  Provider        │    Provider    │    Provider          │
├──────────────────┼────────────────┼──────────────────────┤
│  Vertex AI       │    Custom      │                      │
│  Provider        │    Provider    │                      │
└──────────────────┴────────────────┴──────────────────────┘
```

## Usage Pattern

### 1. Service Constructor (Dependency Injection)

```typescript
import { LLMClient } from '@abl/compiler/platform/llm';

export class MyService {
  private llmClient: LLMClient;

  constructor(llmClient: LLMClient, config?: MyServiceConfig) {
    this.llmClient = llmClient;
    this.config = config || {};
  }
}
```

### 2. Simple Chat Completion

```typescript
const response = await this.llmClient.chat(
  systemPrompt,
  [{ role: 'user', content: 'Your prompt here' }],
  {
    model: 'claude-3-5-haiku-20241022',
    maxTokens: 1024,
  },
);
// response is a string
```

### 3. Tool Use / Function Calling

```typescript
const result = await this.llmClient.chatWithTools(systemPrompt, messages, tools, {
  model: 'claude-3-5-sonnet-20241022',
  maxTokens: 2048,
});
// result.toolCalls contains tool invocations
```

### 4. Streaming Responses

```typescript
for await (const chunk of this.llmClient.streamChat(systemPrompt, messages, {
  model: 'gpt-4',
  maxTokens: 1024,
})) {
  console.log(chunk); // Incremental text
}
```

### 5. Structured JSON Extraction

```typescript
const jsonResult = await this.llmClient.extractJson(systemPrompt, messages, jsonSchema, {
  model: 'gemini-1.5-flash',
});
// Guaranteed structured output
```

## Model Selection

Services specify models as strings. The framework supports:

**Anthropic:**

- `claude-3-5-opus-20241022` (most powerful)
- `claude-3-5-sonnet-20241022` (balanced)
- `claude-3-5-haiku-20241022` (fast, cheap)

**OpenAI:**

- `gpt-4-turbo`
- `gpt-4`
- `gpt-3.5-turbo`

**Google:**

- `gemini-1.5-pro`
- `gemini-1.5-flash`

**Any LiteLLM-compatible model** (via LiteLLM proxy)

## Provider Configuration

The LLMClient is initialized with a provider config:

```typescript
import { LLMClient } from '@abl/compiler/platform/llm';

const llmClient = new LLMClient({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY,
});
```

Or use the default provider:

```typescript
import { setDefaultProvider, getDefaultProvider } from '@abl/compiler/platform/llm';

// Set once at app startup
setDefaultProvider({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Use anywhere
const llmClient = new LLMClient(); // Uses default provider
```

## Knowledge Graph Usage

For KG services, we follow the existing pattern:

```typescript
// TaxonomyLoader - uses LLMClient for parsing domain definitions
export class TaxonomyLoaderService {
  private llmClient: LLMClient;

  constructor(llmClient: LLMClient) {
    this.llmClient = llmClient;
  }

  async parseDomainWithLLM(text: string): Promise<DomainDefinition> {
    const response = await this.llmClient.chat(
      'You are a domain taxonomy parser...',
      [{ role: 'user', content: text }],
      { model: 'claude-3-5-sonnet-20241022', maxTokens: 4096 },
    );
    return JSON.parse(response);
  }
}
```

```typescript
// DocumentClassifier - uses document summary (already generated)
export class DocumentClassifierService {
  private llmClient: LLMClient;

  constructor(llmClient: LLMClient) {
    this.llmClient = llmClient;
  }

  async classifyDocument(
    document: { summary: string; title: string; entities: any[] },
    taxonomy: TaxonomyData,
  ): Promise<Classification> {
    const classificationPrompt = this.buildPrompt(document, taxonomy);

    // Try Haiku first (fast, cheap)
    const result = await this.llmClient.chat(
      'You are a product scope classifier...',
      [{ role: 'user', content: classificationPrompt }],
      { model: 'claude-3-5-haiku-20241022', maxTokens: 512 },
    );

    const classification = JSON.parse(result);

    // Escalate to Sonnet if confidence < 0.8
    if (classification.confidence < 0.8) {
      return await this.escalateToSonnet(document, taxonomy);
    }

    return classification;
  }
}
```

## Benefits

1. **Provider Agnostic**: Switch providers without changing service code
2. **Cost Optimization**: Use cheaper models (Haiku, Flash) with smart escalation
3. **Multi-Provider**: Different services can use different providers
4. **Testing**: Easy to mock for unit tests
5. **Consistent API**: Same interface across all providers

## Existing Services Using LLMClient

- `ProgressiveSummarizationService` - Document summaries (already exists!)
- `QuestionSynthesisService` - Chunk questions (already exists!)
- `VisionService` - Image analysis
- `ScopeClassifierService` - Document scope detection
- `NoiseDetectionService` - Content quality assessment
- `TreeBuilderService` - Hierarchical summaries

## KG Services Will Use LLMClient

- `TaxonomyLoaderService` - Parse domain definitions
- `DocumentClassifierService` - Classify documents by product scope
- `EntityExtractorService` - Extract scoped entities from chunks

---

**Key Principle**: Never import `anthropic` or `openai` directly. Always use `LLMClient` from `@abl/compiler/platform/llm`.

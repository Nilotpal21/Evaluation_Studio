# Vercel AI SDK Provider Parameters - Complete Reference

Comprehensive parameter specifications extracted from ai-sdk.dev documentation (as of February 2025).

---

## Table of Contents

1. [Common Parameters (All Providers)](#common-parameters-all-providers)
2. [Anthropic](#provider-anthropic)
3. [OpenAI](#provider-openai)
4. [Google Generative AI](#provider-google-generative-ai)
5. [Google Vertex AI](#provider-google-vertex-ai)
6. [Azure OpenAI](#provider-azure-openai)
7. [Mistral](#provider-mistral)
8. [Cohere](#provider-cohere)
9. [Groq](#provider-groq)
10. [Fireworks](#provider-fireworks)
11. [Together AI](#provider-together-ai)
12. [Perplexity](#provider-perplexity)
13. [DeepSeek](#provider-deepseek)
14. [xAI](#provider-xai)
15. [Amazon Bedrock](#provider-amazon-bedrock)

---

## Common Parameters (All Providers)

These parameters are part of the AI SDK core and apply across all providers (when supported by the provider).

| Parameter        | Type                   | Min                | Max                | Default            | Notes                                                                      | UI Control               |
| ---------------- | ---------------------- | ------------------ | ------------------ | ------------------ | -------------------------------------------------------------------------- | ------------------------ |
| temperature      | number                 | Provider-dependent | Provider-dependent | Provider-dependent | Controls randomness. Recommend using either temperature OR topP, not both. | Slider (0-2 typical)     |
| maxOutputTokens  | number                 | Provider-dependent | Provider-dependent | Provider-dependent | Maximum tokens to generate                                                 | Number input             |
| topP             | number                 | Provider-dependent | Provider-dependent | Provider-dependent | Nucleus sampling. Recommend using either temperature OR topP, not both.    | Slider (0-1)             |
| topK             | number                 | Provider-dependent | Provider-dependent | Provider-dependent | Sample from top K options. Advanced use case.                              | Number input             |
| frequencyPenalty | number                 | Provider-dependent | Provider-dependent | Provider-dependent | Reduces likelihood of repeating words/phrases                              | Slider (-2 to 2 typical) |
| presencePenalty  | number                 | Provider-dependent | Provider-dependent | Provider-dependent | Reduces likelihood of repeating information from prompt                    | Slider (-2 to 2 typical) |
| seed             | number (integer)       | -                  | -                  | None               | For deterministic generation (when supported)                              | Number input             |
| stopSequences    | string[]               | -                  | Provider limit     | None               | Sequences that stop generation                                             | Textarea (multi-line)    |
| maxRetries       | number                 | 0                  | -                  | 2                  | Maximum retry attempts                                                     | Number input             |
| timeout          | number or object       | -                  | -                  | None               | Call duration limit (ms) or {totalMs, stepMs, chunkMs}                     | Number input             |
| abortSignal      | AbortSignal            | -                  | -                  | None               | Signal to cancel call programmatically                                     | N/A (programmatic)       |
| headers          | Record<string, string> | -                  | -                  | None               | Additional HTTP headers                                                    | N/A (programmatic)       |

**Important Notes:**

- All ranges are provider-dependent; values are passed through to the provider
- Not all providers support all parameters
- Default value changed in AI SDK 5.0: temperature no longer defaults to 0
- Unsupported settings generate warnings in the result object

---

## Provider: Anthropic

**API Documentation:** https://ai-sdk.dev/providers/ai-sdk-providers/anthropic

### Common Parameters (All Models)

| Parameter       | Type     | Min               | Max               | Default           | Values/Constraint    | UI Control   | Notes                                      |
| --------------- | -------- | ----------------- | ----------------- | ----------------- | -------------------- | ------------ | ------------------------------------------ |
| temperature     | number   | Provider-specific | Provider-specific | Provider-specific | Standard parameter   | Slider       | Not explicitly documented                  |
| maxOutputTokens | number   | Model-specific    | Model-specific    | None              | See per-model limits | Number input | Varies by model                            |
| topP            | number   | Provider-specific | Provider-specific | None              | Standard parameter   | Slider (0-1) | Not explicitly documented                  |
| topK            | number   | Provider-specific | Provider-specific | None              | Standard parameter   | Number input | Available via additionalModelRequestFields |
| stopSequences   | string[] | -                 | Provider limit    | None              | Standard parameter   | Textarea     | Not explicitly documented                  |

### Provider-Specific Parameters

| Parameter              | Type    | Min  | Max               | Default              | Values/Constraint                  | Applies To                                                                   | UI Control   | Notes                                      |
| ---------------------- | ------- | ---- | ----------------- | -------------------- | ---------------------------------- | ---------------------------------------------------------------------------- | ------------ | ------------------------------------------ |
| thinking.type          | enum    | -    | -                 | undefined (disabled) | 'enabled'                          | claude-opus-4-20250514, claude-sonnet-4-20250514, claude-sonnet-4-5-20250929 | Toggle       | Enables reasoning                          |
| thinking.budgetTokens  | number  | 1024 | Provider-specific | None                 | Integer                            | Reasoning models                                                             | Number input | Required when thinking.type='enabled'      |
| effort                 | enum    | -    | -                 | 'high'               | 'high', 'medium', 'low'            | claude-opus-4-5 (claude-opus-4-20250514)                                     | Select       | Affects thinking, text, and function calls |
| speed                  | enum    | -    | -                 | 'standard'           | 'fast', 'standard'                 | claude-opus-4-6                                                              | Select       | 'fast' = ~2.5x faster output               |
| disableParallelToolUse | boolean | -    | -                 | false                | true/false                         | All models                                                                   | Toggle       | Disables parallel tool calling             |
| sendReasoning          | boolean | -    | -                 | true                 | true/false                         | All models                                                                   | Toggle       | Include reasoning in response              |
| toolStreaming          | boolean | -    | -                 | true                 | true/false                         | All models                                                                   | Toggle       | Stream tool use responses                  |
| structuredOutputMode   | enum    | -    | -                 | 'auto'               | 'outputFormat', 'jsonTool', 'auto' | All models                                                                   | Select       | Controls structured output method          |
| cacheControl.type      | enum    | -    | -                 | None                 | 'ephemeral'                        | All models                                                                   | Select       | Enables prompt caching                     |
| cacheControl.ttl       | enum    | -    | -                 | Standard             | '1h' (1 hour)                      | All models                                                                   | Select       | Cache duration (optional)                  |

### Context Management Parameters

**Clear Tool Uses:**

```typescript
contextManagement: {
  edits: [{
    type: 'clear_tool_uses_20250919',
    trigger: { type: 'input_tokens' | 'tool_uses', value: number },
    keep: { type: 'tool_uses', value: number },
    clearAtLeast: { type: 'input_tokens', value: number },
    clearToolInputs: boolean,
    excludeTools: string[]
  }]
}
```

**Clear Thinking:**

```typescript
contextManagement: {
  edits: [
    {
      type: 'clear_thinking_20251015',
      keep: { type: 'thinking_turns', value: number } | 'all',
    },
  ];
}
```

**Compaction:**

```typescript
contextManagement: {
  edits: [
    {
      type: 'compact_20260112',
      trigger: { type: 'input_tokens', value: number },
      instructions: string,
      pauseAfterCompaction: boolean, // default: false
    },
  ];
}
```

### Built-in Tools

**Web Search Tool:**

```typescript
anthropic.tools.webSearch_20250305({
  maxUses: number,
  allowedDomains?: string[],
  blockedDomains?: string[],
  userLocation?: {
    type: 'approximate',
    country: string,
    region: string,
    city: string,
    timezone: string
  }
})
```

**Web Fetch Tool:**

```typescript
anthropic.tools.webFetch_20250910({
  maxUses: number,
  allowedDomains?: string[],
  blockedDomains?: string[],
  citations?: { enabled: boolean },
  maxContentTokens?: number
})
```

**Computer Tool:**

```typescript
anthropic.tools.computer_20251124({
  displayWidthPx: number,
  displayHeightPx: number,
  displayNumber?: number,  // for X11 environments
  enableZoom?: boolean     // default: false, only in computer_20251124
})
```

### Agent Skills

```typescript
container: {
  skills: [{
    type: 'anthropic' | 'custom',
    skillId: 'pptx' | 'docx' | 'pdf' | 'xlsx' | string,
    version?: string  // e.g., 'latest', '1.0'
  }]
}
```

### MCP Servers

```typescript
mcpServers: [{
  type: 'url',
  name: string,
  url: string,
  authorizationToken?: string,
  toolConfiguration?: {
    enabled: boolean,
    allowedTools: string[]
  }
}]
```

### Per-Model Cache Requirements

| Model                                                             | Minimum Cacheable Tokens | Notes |
| ----------------------------------------------------------------- | ------------------------ | ----- |
| Claude Opus 4.5                                                   | 4096                     | -     |
| Claude Haiku 4.5                                                  | 4096                     | -     |
| Claude Opus 4.1, Opus 4, Sonnet 4.5, Sonnet 4, Sonnet 3.7, Opus 3 | 1024                     | -     |
| Claude Haiku 3.5, Haiku 3                                         | 2048                     | -     |

### Available Models

**Current Models:**

- claude-opus-4-6
- claude-sonnet-4-6
- claude-opus-4-5 / claude-opus-4-20250514
- claude-haiku-4-5
- claude-sonnet-4-5 / claude-sonnet-4-20250514
- claude-opus-4-1
- claude-opus-4-0
- claude-sonnet-4-0
- claude-3-5-haiku-latest / claude-3-5-haiku-20241022

**Note:** Claude 3 Haiku, Claude 3 Opus, and Claude 3.7 Sonnet have been retired and removed from the MODEL_REGISTRY.

**Note:** Full context window and max output token specifications not provided in documentation. See [Anthropic docs](https://docs.anthropic.com/en/docs/about-claude/models) for complete limits.

---

## Provider: OpenAI

**API Documentation:** https://ai-sdk.dev/providers/ai-sdk-providers/openai

### Common Parameters (All Models)

| Parameter           | Type                   | Min            | Max            | Default | Values/Constraint             | UI Control    | Notes                          |
| ------------------- | ---------------------- | -------------- | -------------- | ------- | ----------------------------- | ------------- | ------------------------------ |
| temperature         | number                 | 0              | 2              | 1       | Controls randomness           | Slider        | Higher = more random           |
| maxTokens           | number                 | Model-specific | Model-specific | None    | Standard output limit         | Number input  | -                              |
| maxCompletionTokens | number                 | Model-specific | Model-specific | None    | For reasoning models          | Number input  | Preferred for reasoning models |
| topP                | number                 | 0              | 1              | None    | Nucleus sampling              | Slider        | -                              |
| frequencyPenalty    | number                 | -2.0           | 2.0            | None    | Reduces repetition            | Slider        | -                              |
| presencePenalty     | number                 | -2.0           | 2.0            | None    | Encourages new topics         | Slider        | -                              |
| logitBias           | Record<number, number> | -100           | 100            | None    | Maps token IDs to bias values | Complex input | Example: {"50256": -100}       |
| user                | string                 | -              | -              | None    | Unique end-user identifier    | Text input    | For monitoring/abuse detection |

### Reasoning Model Parameters

| Parameter                       | Type | Min | Max | Default  | Values/Constraint                                   | Applies To       | UI Control | Notes                                                       |
| ------------------------------- | ---- | --- | --- | -------- | --------------------------------------------------- | ---------------- | ---------- | ----------------------------------------------------------- |
| reasoningEffort (Responses API) | enum | -   | -   | 'medium' | 'none', 'minimal', 'low', 'medium', 'high', 'xhigh' | Reasoning models | Select     | 'none' only for GPT-5.1; 'xhigh' only for GPT-5.1-Codex-Max |
| reasoningEffort (Chat API)      | enum | -   | -   | 'medium' | 'minimal', 'low', 'medium', 'high', 'xhigh'         | Reasoning models | Select     | No 'none' option in Chat API                                |

### Service & Performance Parameters

| Parameter     | Type | Min | Max | Default  | Values/Constraint                     | Applies To | UI Control | Notes                                                                   |
| ------------- | ---- | --- | --- | -------- | ------------------------------------- | ---------- | ---------- | ----------------------------------------------------------------------- |
| serviceTier   | enum | -   | -   | 'auto'   | 'auto', 'flex', 'priority', 'default' | Various    | Select     | 'flex' = 50% cheaper + higher latency; 'priority' = faster (Enterprise) |
| textVerbosity | enum | -   | -   | 'medium' | 'low', 'medium', 'high'               | All models | Select     | Controls response verbosity                                             |

### Caching Parameters

| Parameter            | Type   | Min | Max | Default     | Values/Constraint    | Applies To | UI Control | Notes                            |
| -------------------- | ------ | --- | --- | ----------- | -------------------- | ---------- | ---------- | -------------------------------- |
| promptCacheKey       | string | -   | -   | None        | Manual cache control | All models | Text input | Requires 1024+ token prompt      |
| promptCacheRetention | enum   | -   | -   | 'in_memory' | 'in_memory', '24h'   | All models | Select     | '24h' only for 5.1 series models |

### System Message Control

| Parameter         | Type | Min | Max | Default | Values/Constraint               | Applies To | UI Control | Notes                                    |
| ----------------- | ---- | --- | --- | ------- | ------------------------------- | ---------- | ---------- | ---------------------------------------- |
| systemMessageMode | enum | -   | -   | Auto    | 'system', 'developer', 'remove' | All models | Select     | 'developer' default for reasoning models |

### Tool & Feature Parameters

| Parameter         | Type                   | Min | Max | Default | Values/Constraint | Applies To    | UI Control    | Notes                            |
| ----------------- | ---------------------- | --- | --- | ------- | ----------------- | ------------- | ------------- | -------------------------------- |
| parallelToolCalls | boolean                | -   | -   | true    | true/false        | All models    | Toggle        | Enable parallel function calling |
| store             | boolean                | -   | -   | true    | true/false        | Responses API | Toggle        | Whether to store generation      |
| metadata          | Record<string, string> | -   | -   | None    | Key-value pairs   | Responses API | Complex input | Additional metadata to store     |
| safetyIdentifier  | string                 | -   | -   | None    | Stable identifier | All models    | Text input    | Helps detect policy violations   |
| strictJsonSchema  | boolean                | -   | -   | true    | true/false        | All models    | Toggle        | Strict JSON schema validation    |

### Log Probabilities

| Parameter | Type              | Min        | Max | Default | Values/Constraint | Applies To | UI Control       | Notes                           |
| --------- | ----------------- | ---------- | --- | ------- | ----------------- | ---------- | ---------------- | ------------------------------- |
| logprobs  | boolean or number | false or 1 | 20  | false   | true or 1-20      | All models | Toggle or Number | true = logprobs; number = top N |

### Truncation (Responses API)

| Parameter  | Type | Min | Max | Default    | Values/Constraint  | Applies To    | UI Control | Notes                                                      |
| ---------- | ---- | --- | --- | ---------- | ------------------ | ------------- | ---------- | ---------------------------------------------------------- |
| truncation | enum | -   | -   | 'disabled' | 'auto', 'disabled' | Responses API | Select     | 'auto' truncates from beginning; 'disabled' fails with 400 |

### Tool-Specific Parameters

**File Search Tool:**

- maxNumResults: integer

**Web Search Tool:**

- searchContextSize: 'low' | 'medium' | 'high'
- externalWebAccess: boolean (default true)

**Image Generation:**

- quality: 'low' | 'medium' | 'high'
- outputFormat: 'png' | 'webp' | 'jpeg'
- background: 'transparent' | 'opaque'

### Completion Models Only

| Parameter | Type    | Min | Max | Default | Values/Constraint | Applies To        | UI Control | Notes                            |
| --------- | ------- | --- | --- | ------- | ----------------- | ----------------- | ---------- | -------------------------------- |
| echo      | boolean | -   | -   | false   | true/false        | Completion models | Toggle     | Echo back prompt with completion |
| suffix    | string  | -   | -   | None    | Text              | Completion models | Text input | Text after completion            |

### Transcription Parameters

| Parameter              | Type     | Min | Max | Default | Values/Constraint              | Applies To    | UI Control   | Notes                  |
| ---------------------- | -------- | --- | --- | ------- | ------------------------------ | ------------- | ------------ | ---------------------- |
| language               | string   | -   | -   | None    | ISO-639-1 (e.g., 'en')         | Transcription | Text input   | Audio language         |
| timestampGranularities | string[] | -   | -   | None    | ['word'], ['segment'], or both | Transcription | Multi-select | Timestamp detail level |
| prompt                 | string   | -   | -   | None    | Text                           | Transcription | Text input   | Guides model style     |
| temperature            | number   | 0   | 1   | 0       | Controls sampling              | Transcription | Slider       | For transcription only |

### Speech Parameters

| Parameter    | Type   | Min  | Max | Default | Values/Constraint                                                           | Applies To                  | UI Control | Notes                      |
| ------------ | ------ | ---- | --- | ------- | --------------------------------------------------------------------------- | --------------------------- | ---------- | -------------------------- |
| voice        | enum   | -    | -   | None    | 'alloy', 'ash', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer' | Speech                      | Select     | Voice selection            |
| speed        | number | 0.25 | 4.0 | 1.0     | Playback speed                                                              | Speech                      | Slider     | -                          |
| instructions | string | -    | -   | None    | Text                                                                        | Speech (not tts-1/tts-1-hd) | Textarea   | Voice control instructions |

### Available Models

**GPT-5 Series:**

- gpt-5.2-pro, gpt-5.2-chat-latest, gpt-5.2, gpt-5-pro, gpt-5, gpt-5-mini, gpt-5-nano, gpt-5-codex, gpt-5-chat-latest

**GPT-5.1 Series:**

- gpt-5.1-codex-mini, gpt-5.1-codex, gpt-5.1-codex-max, gpt-5.1-chat-latest, gpt-5.1

**GPT-4.1 Series:**

- gpt-4.1, gpt-4.1-mini, gpt-4.1-nano

**GPT-4o Series:**

- gpt-4o, gpt-4o-mini, gpt-4o-audio-preview

**Reasoning Models:**

- o4-mini, o3, o3-mini, o1, codex-mini-latest, computer-use-preview

**Completion Models:**

- gpt-3.5-turbo-instruct

**Note:** Specific context window and max output token limits not provided in documentation. Prompt caching requires 1024+ tokens.

---

## Provider: Google Generative AI

**API Documentation:** https://ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai

### Common Parameters (All Models)

| Parameter       | Type     | Min           | Max            | Default       | Values/Constraint  | UI Control   | Notes                     |
| --------------- | -------- | ------------- | -------------- | ------------- | ------------------ | ------------ | ------------------------- |
| temperature     | number   | Not specified | Not specified  | Not specified | Standard parameter | Slider       | Follow Google API specs   |
| maxOutputTokens | number   | Not specified | Not specified  | Not specified | Standard parameter | Number input | Model-dependent           |
| topP            | number   | Not specified | Not specified  | Not specified | Standard parameter | Slider (0-1) | Not explicitly documented |
| topK            | number   | Not specified | Not specified  | Not specified | Standard parameter | Number input | Not explicitly documented |
| stopSequences   | string[] | -             | Provider limit | None          | Standard parameter | Textarea     | Not explicitly documented |

### Thinking Configuration

**For Gemini 2.5 Models:**

| Parameter                     | Type   | Min           | Max           | Default | Values/Constraint | Applies To        | UI Control   | Notes                        |
| ----------------------------- | ------ | ------------- | ------------- | ------- | ----------------- | ----------------- | ------------ | ---------------------------- |
| thinkingConfig.thinkingBudget | number | Not specified | Not specified | None    | Token count       | Gemini 2.5 models | Number input | Set to 0 to disable thinking |

**For Gemini 3 Models:**

| Parameter                      | Type    | Min | Max | Default | Values/Constraint                  | Applies To      | UI Control | Notes                                                               |
| ------------------------------ | ------- | --- | --- | ------- | ---------------------------------- | --------------- | ---------- | ------------------------------------------------------------------- |
| thinkingConfig.thinkingLevel   | enum    | -   | -   | None    | 'minimal', 'low', 'medium', 'high' | Gemini 3 models | Select     | Gemini 3.1 Pro: low/medium/high; Gemini 3 Pro: low/high; Flash: all |
| thinkingConfig.includeThoughts | boolean | -   | -   | false   | true/false                         | Gemini 3 models | Toggle     | Returns thought summaries                                           |

### Safety Settings

**Structure:**

```typescript
safetySettings: Array<{
  category: string;
  threshold: string;
}>;
```

**Categories:**

- HARM_CATEGORY_UNSPECIFIED
- HARM_CATEGORY_HATE_SPEECH
- HARM_CATEGORY_DANGEROUS_CONTENT
- HARM_CATEGORY_HARASSMENT
- HARM_CATEGORY_SEXUALLY_EXPLICIT
- HARM_CATEGORY_CIVIC_INTEGRITY

**Thresholds:**

- HARM_BLOCK_THRESHOLD_UNSPECIFIED
- BLOCK_LOW_AND_ABOVE
- BLOCK_MEDIUM_AND_ABOVE
- BLOCK_ONLY_HIGH
- BLOCK_NONE
- OFF

| Parameter      | Type             | Min | Max | Default | Values/Constraint      | Applies To | UI Control    | Notes                        |
| -------------- | ---------------- | --- | --- | ------- | ---------------------- | ---------- | ------------- | ---------------------------- |
| safetySettings | array of objects | -   | -   | None    | See structure above    | All models | Complex input | Content safety configuration |
| threshold      | string           | -   | -   | None    | Single threshold value | All models | Select        | Standalone safety threshold  |

### Image Model Configuration (Gemini Image Models)

| Parameter               | Type | Min | Max | Default                | Values/Constraint                                                               | Applies To   | UI Control | Notes               |
| ----------------------- | ---- | --- | --- | ---------------------- | ------------------------------------------------------------------------------- | ------------ | ---------- | ------------------- |
| imageConfig.aspectRatio | enum | -   | -   | '1:1' or matches input | '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '9:21' | Image models | Select     | Output aspect ratio |
| imageConfig.imageSize   | enum | -   | -   | '1K'                   | '1K', '2K', '4K'                                                                | Image models | Select     | Output resolution   |

### Other Provider Options

| Parameter          | Type     | Min | Max | Default     | Values/Constraint                                                                                          | Applies To   | UI Control   | Notes                           |
| ------------------ | -------- | --- | --- | ----------- | ---------------------------------------------------------------------------------------------------------- | ------------ | ------------ | ------------------------------- |
| cachedContent      | string   | -   | -   | None        | Format: cachedContents/{cachedContent}                                                                     | All models   | Text input   | Reference to cached content     |
| structuredOutputs  | boolean  | -   | -   | true        | true/false                                                                                                 | All models   | Toggle       | Enable structured outputs       |
| responseModalities | string[] | -   | -   | None        | 'TEXT', 'IMAGE'                                                                                            | All models   | Multi-select | Output modality selection       |
| audioTimestamp     | boolean  | -   | -   | false       | true/false                                                                                                 | Audio models | Toggle       | Enables timestamp understanding |
| mediaResolution    | enum     | -   | -   | UNSPECIFIED | 'MEDIA_RESOLUTION_UNSPECIFIED', 'MEDIA_RESOLUTION_LOW', 'MEDIA_RESOLUTION_MEDIUM', 'MEDIA_RESOLUTION_HIGH' | All models   | Select       | Media input resolution          |

### Embedding Model Options

| Parameter            | Type   | Min           | Max           | Default | Values/Constraint                                                                                                                                                 | Applies To       | UI Control   | Notes                  |
| -------------------- | ------ | ------------- | ------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------ | ---------------------- |
| outputDimensionality | number | Not specified | Not specified | None    | Reduced dimensions (e.g., 512)                                                                                                                                    | Embedding models | Number input | Dimension reduction    |
| taskType             | enum   | -             | -             | None    | 'SEMANTIC_SIMILARITY', 'CLASSIFICATION', 'CLUSTERING', 'RETRIEVAL_DOCUMENT', 'RETRIEVAL_QUERY', 'QUESTION_ANSWERING', 'FACT_VERIFICATION', 'CODE_RETRIEVAL_QUERY' | Embedding models | Select       | Task type optimization |

### Tool Configurations

**Google Search:**

```typescript
googleSearch: {
  mode: 'MODE_DYNAMIC' | 'MODE_UNSPECIFIED',  // Default: 'MODE_UNSPECIFIED'
  dynamicThreshold: number                      // Default: 1
}
```

**File Search:**

```typescript
fileSearch: {
  fileSearchStoreNames: string[],
  metadataFilter: string,
  topK: number                                  // Default: 8
}
```

**Vertex RAG Store:**

```typescript
vertexRagStore: {
  ragCorpus: string,                           // Required
  topK: number                                 // Optional
}
```

### Available Models

**Gemini 3 Series:**

- gemini-3.1-pro-preview
- gemini-3-pro-preview
- gemini-3-pro-image-preview
- gemini-3-flash-preview

**Gemini 2.5 Series:**

- gemini-2.5-pro
- gemini-2.5-flash
- gemini-2.5-flash-lite
- gemini-2.5-flash-lite-preview-06-17
- gemini-2.5-flash-image

**Gemini 2.0 Series:**

- gemini-2.0-flash

**Gemini 1.5 Series:**

- gemini-1.5-pro, gemini-1.5-pro-latest
- gemini-1.5-flash, gemini-1.5-flash-latest
- gemini-1.5-flash-8b, gemini-1.5-flash-8b-latest

**Gemma Models:**

- gemma-3-27b-it
- gemma-3-12b-it

**Embedding Models:**

- gemini-embedding-001 (3072 dimensions)
- text-embedding-004 (768 dimensions)

**Image Models (Imagen):**

- imagen-4.0-generate-001
- imagen-4.0-ultra-generate-001
- imagen-4.0-fast-generate-001

**Note:** Context window and max output token limits not specified in documentation. See [Google Generative AI docs](https://ai.google.dev/gemini-api/docs/models/gemini) for complete specifications.

---

## Provider: Google Vertex AI

**API Documentation:** https://ai-sdk.dev/providers/ai-sdk-providers/google-vertex

### Provider Configuration

**Node.js Runtime:**

| Parameter                        | Type                   | Default                    | Values/Constraint                | UI Control    | Notes                       |
| -------------------------------- | ---------------------- | -------------------------- | -------------------------------- | ------------- | --------------------------- |
| project                          | string                 | GOOGLE_VERTEX_PROJECT env  | GCP project ID                   | Text input    | Required                    |
| location                         | string                 | GOOGLE_VERTEX_LOCATION env | GCP region (e.g., 'us-central1') | Text input    | Required                    |
| googleAuthOptions.authClient     | object                 | None                       | Auth client instance             | N/A           | Programmatic                |
| googleAuthOptions.keyFilename    | string                 | None                       | Path to service account key      | Text input    | File path                   |
| googleAuthOptions.keyFile        | string                 | None                       | Key file path                    | Text input    | File path                   |
| googleAuthOptions.credentials    | object                 | None                       | {client_email, private_key}      | Complex input | Service account credentials |
| googleAuthOptions.clientOptions  | object                 | None                       | Client options                   | N/A           | Programmatic                |
| googleAuthOptions.scopes         | string or string[]     | None                       | OAuth scopes                     | Text input    | Auth scopes                 |
| googleAuthOptions.projectId      | string                 | None                       | Project ID                       | Text input    | Alternative project ID      |
| googleAuthOptions.universeDomain | string                 | None                       | Universe domain                  | Text input    | Custom domain               |
| headers                          | Record<string, string> | None                       | Custom headers                   | N/A           | Programmatic                |
| fetch                            | function               | global fetch               | Custom fetch                     | N/A           | Programmatic                |
| baseURL                          | string                 | None                       | Custom API endpoint              | Text input    | Override endpoint           |

**Edge Runtime (`/edge`):**

| Parameter                      | Type                   | Default                   | Values/Constraint           | UI Control | Notes        |
| ------------------------------ | ---------------------- | ------------------------- | --------------------------- | ---------- | ------------ |
| project                        | string                 | None                      | GCP project ID              | Text input | Required     |
| location                       | string                 | None                      | GCP region                  | Text input | Required     |
| googleCredentials.clientEmail  | string                 | GOOGLE_CLIENT_EMAIL env   | Service account email       | Text input | Required     |
| googleCredentials.privateKey   | string                 | GOOGLE_PRIVATE_KEY env    | Service account private key | Textarea   | Required     |
| googleCredentials.privateKeyId | string                 | GOOGLE_PRIVATE_KEY_ID env | Private key ID              | Text input | Optional     |
| headers                        | Record<string, string> | None                      | Custom headers              | N/A        | Programmatic |
| fetch                          | function               | global fetch              | Custom fetch                | N/A        | Programmatic |

**Express Mode:**

| Parameter | Type   | Default                   | Values/Constraint | UI Control | Notes                                          |
| --------- | ------ | ------------------------- | ----------------- | ---------- | ---------------------------------------------- |
| apiKey    | string | GOOGLE_VERTEX_API_KEY env | API key           | Text input | Simplified auth (no project/location required) |

### Language Model Options (providerOptions.vertex)

| Parameter                        | Type             | Min           | Max           | Default | Values/Constraint                                                   | Applies To      | UI Control    | Notes                        |
| -------------------------------- | ---------------- | ------------- | ------------- | ------- | ------------------------------------------------------------------- | --------------- | ------------- | ---------------------------- |
| cachedContent                    | string           | -             | -             | None    | Format: projects/{project}/locations/{location}/cachedContents/{id} | All models      | Text input    | Reference to cached content  |
| structuredOutputs                | boolean          | -             | -             | true    | true/false                                                          | All models      | Toggle        | Enable structured outputs    |
| safetySettings                   | array of objects | -             | -             | None    | Same as Google Generative AI                                        | All models      | Complex input | Content safety configuration |
| audioTimestamp                   | boolean          | -             | -             | false   | true/false                                                          | Audio models    | Toggle        | Timestamp understanding      |
| labels                           | object           | -             | -             | None    | Key-value pairs                                                     | All models      | Complex input | Billing labels               |
| thinkingConfig.includeThoughts   | boolean          | -             | -             | false   | true/false                                                          | Thinking models | Toggle        | Include thought summaries    |
| thinkingConfig.thinkingBudget    | number           | Not specified | Not specified | None    | Token budget                                                        | Thinking models | Number input  | Optional token budget        |
| retrievalConfig.latLng.latitude  | number           | -90           | 90            | None    | Latitude                                                            | Search models   | Number input  | Location for retrieval       |
| retrievalConfig.latLng.longitude | number           | -180          | 180           | None    | Longitude                                                           | Search models   | Number input  | Location for retrieval       |

### Embedding Model Options (providerOptions.vertex)

| Parameter            | Type    | Min           | Max           | Default | Values/Constraint                                                                                                                                                 | Applies To       | UI Control   | Notes                                         |
| -------------------- | ------- | ------------- | ------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------ | --------------------------------------------- |
| outputDimensionality | number  | Not specified | Not specified | None    | Reduced dimensions                                                                                                                                                | Embedding models | Number input | Dimension reduction                           |
| taskType             | enum    | -             | -             | None    | 'SEMANTIC_SIMILARITY', 'CLASSIFICATION', 'CLUSTERING', 'RETRIEVAL_DOCUMENT', 'RETRIEVAL_QUERY', 'QUESTION_ANSWERING', 'FACT_VERIFICATION', 'CODE_RETRIEVAL_QUERY' | Embedding models | Select       | Task type optimization                        |
| title                | string  | -             | -             | None    | Document title                                                                                                                                                    | Embedding models | Text input   | Only valid when taskType='RETRIEVAL_DOCUMENT' |
| autoTruncate         | boolean | -             | -             | true    | true/false                                                                                                                                                        | Embedding models | Toggle       | Auto-truncate long inputs                     |

### Image Model Options (Imagen)

| Parameter         | Type    | Min | Max | Default                  | Values/Constraint                                                                                                                                               | Applies To        | UI Control   | Notes                    |
| ----------------- | ------- | --- | --- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------ | ------------------------ |
| negativePrompt    | string  | -   | -   | None                     | Text                                                                                                                                                            | Image models      | Textarea     | What to avoid            |
| personGeneration  | enum    | -   | -   | 'allow_adult'            | 'allow_adult', 'allow_all', 'dont_allow'                                                                                                                        | Image models      | Select       | Person generation policy |
| safetySetting     | enum    | -   | -   | 'block_medium_and_above' | 'block_low_and_above', 'block_medium_and_above', 'block_only_high', 'block_none'                                                                                | Image models      | Select       | Safety filter level      |
| addWatermark      | boolean | -   | -   | true                     | true/false                                                                                                                                                      | Image models      | Toggle       | Add watermark to output  |
| storageUri        | string  | -   | -   | None                     | Cloud Storage URI                                                                                                                                               | Image models      | Text input   | Output location          |
| edit.baseSteps    | number  | 35  | 75  | None                     | Integer                                                                                                                                                         | Image edit models | Number input | Edit steps count         |
| edit.mode         | enum    | -   | -   | None                     | 'EDIT_MODE_INPAINT_INSERTION', 'EDIT_MODE_INPAINT_REMOVAL', 'EDIT_MODE_OUTPAINT', 'EDIT_MODE_CONTROLLED_EDITING', 'EDIT_MODE_PRODUCT_IMAGE', 'EDIT_MODE_BGSWAP' | Image edit models | Select       | Editing mode             |
| edit.maskMode     | enum    | -   | -   | None                     | 'MASK_MODE_USER_PROVIDED', 'MASK_MODE_DEFAULT', 'MASK_MODE_DETECTION_BOX', 'MASK_MODE_CLOTHING_AREA', 'MASK_MODE_PARSED_PERSON'                                 | Image edit models | Select       | Mask selection method    |
| edit.maskDilation | number  | 0   | 1   | None                     | Recommended: 0.01                                                                                                                                               | Image edit models | Slider       | Mask edge dilation       |

### Video Model Options (providerOptions.vertex)

| Parameter          | Type    | Min           | Max           | Default | Values/Constraint                        | Applies To   | UI Control    | Notes                     |
| ------------------ | ------- | ------------- | ------------- | ------- | ---------------------------------------- | ------------ | ------------- | ------------------------- |
| generateAudio      | boolean | -             | -             | false   | true/false                               | Video models | Toggle        | Generate audio track      |
| personGeneration   | enum    | -             | -             | None    | 'dont_allow', 'allow_adult', 'allow_all' | Video models | Select        | Person generation policy  |
| negativePrompt     | string  | -             | -             | None    | Text                                     | Video models | Textarea      | What to avoid             |
| gcsOutputDirectory | string  | -             | -             | None    | GCS path                                 | Video models | Text input    | Output location           |
| referenceImages    | array   | -             | -             | None    | [{bytesBase64Encoded?, gcsUri?}]         | Video models | Complex input | Reference images          |
| pollIntervalMs     | number  | Not specified | Not specified | None    | Milliseconds                             | Video models | Number input  | Polling interval          |
| pollTimeoutMs      | number  | Not specified | Not specified | None    | Recommended: 600000 (10 min)             | Video models | Number input  | Timeout for longer videos |

### Anthropic Provider (vertexAnthropic)

**Provider Configuration:** Same as Vertex

**Model Options (providerOptions.anthropic):**

| Parameter             | Type    | Min           | Max           | Default | Values/Constraint | Applies To    | UI Control   | Notes                         |
| --------------------- | ------- | ------------- | ------------- | ------- | ----------------- | ------------- | ------------ | ----------------------------- |
| sendReasoning         | boolean | -             | -             | true    | true/false        | Claude models | Toggle       | Include reasoning in response |
| thinking.type         | enum    | -             | -             | None    | 'enabled'         | Claude models | Select       | Enable thinking mode          |
| thinking.budgetTokens | number  | Not specified | Not specified | None    | Token budget      | Claude models | Number input | Thinking token budget         |
| cacheControl.type     | enum    | -             | -             | None    | 'ephemeral'       | Claude models | Select       | Pre-GA feature                |

### Key Differences from Google Generative AI

1. **Authentication**: Vertex uses Google Cloud project/location credentials; Generative AI uses API keys
2. **Endpoint**: Different base URLs (aiplatform.googleapis.com vs generativelanguage.googleapis.com)
3. **Edge Runtime**: Vertex has dedicated `/edge` sub-module with environment variable auth
4. **Express Mode**: Vertex-specific simplified authentication with API key
5. **Anthropic Integration**: Vertex includes Claude models via `/anthropic` sub-module
6. **Cache Format**: Vertex uses cachedContent with project path; Generative AI uses inline cache
7. **Video Support**: Vertex includes Veo video models; not in Generative AI provider
8. **Grounding**: Vertex has different grounding tool implementations

---

## Provider: Azure OpenAI

**API Documentation:** https://ai-sdk.dev/providers/ai-sdk-providers/azure

### Provider Instance Configuration

| Parameter              | Type                   | Default                 | Values/Constraint   | UI Control | Notes                        |
| ---------------------- | ---------------------- | ----------------------- | ------------------- | ---------- | ---------------------------- |
| resourceName           | string                 | AZURE_RESOURCE_NAME env | Azure resource name | Text input | Required                     |
| apiKey                 | string                 | AZURE_API_KEY env       | API key             | Text input | Sent via api-key header      |
| apiVersion             | string                 | v1                      | API version         | Text input | Custom API version           |
| baseURL                | string                 | None                    | URL prefix          | Text input | Alternative to resourceName  |
| useDeploymentBasedUrls | boolean                | false                   | true/false          | Toggle     | Use legacy deployment format |
| headers                | Record<string, string> | None                    | Custom headers      | N/A        | Programmatic                 |
| fetch                  | function               | global fetch            | Custom fetch        | N/A        | Programmatic                 |

### Chat Models (azure.chat()) - Provider Options (providerOptions.openai)

| Parameter         | Type                   | Min        | Max | Default | Values/Constraint          | Applies To  | UI Control       | Notes                            |
| ----------------- | ---------------------- | ---------- | --- | ------- | -------------------------- | ----------- | ---------------- | -------------------------------- |
| logitBias         | Record<number, number> | -100       | 100 | None    | Token likelihood modifier  | Chat models | Complex input    | Maps token IDs to bias values    |
| logprobs          | boolean or number      | false or 1 | 20  | false   | true or 1-20               | Chat models | Toggle or Number | Return log probabilities         |
| parallelToolCalls | boolean                | -          | -   | true    | true/false                 | Chat models | Toggle           | Enable parallel function calling |
| user              | string                 | -          | -   | None    | Unique end-user identifier | Chat models | Text input       | For monitoring                   |

### Responses Models (azure()) - Provider Options (providerOptions.azure)

| Parameter          | Type                   | Min | Max | Default  | Values/Constraint                     | Applies To       | UI Control    | Notes                               |
| ------------------ | ---------------------- | --- | --- | -------- | ------------------------------------- | ---------------- | ------------- | ----------------------------------- |
| parallelToolCalls  | boolean                | -   | -   | true     | true/false                            | Responses models | Toggle        | Parallel tool calls                 |
| store              | boolean                | -   | -   | true     | true/false                            | Responses models | Toggle        | Store generation                    |
| metadata           | Record<string, string> | -   | -   | None     | Key-value pairs                       | Responses models | Complex input | Additional storage metadata         |
| previousResponseId | string                 | -   | -   | None     | Response ID                           | Responses models | Text input    | Continue from previous              |
| instructions       | string                 | -   | -   | None     | Text                                  | Responses models | Textarea      | Model instructions for continuation |
| user               | string                 | -   | -   | None     | Unique end-user identifier            | Responses models | Text input    | For monitoring                      |
| reasoningEffort    | enum                   | -   | -   | 'medium' | 'low', 'medium', 'high'               | Reasoning models | Select        | Reasoning effort level              |
| strictJsonSchema   | boolean                | -   | -   | false    | true/false                            | Responses models | Toggle        | Strict JSON validation              |
| include            | string[]               | -   | -   | None     | e.g., ['reasoning.encrypted_content'] | Responses models | Multi-select  | Additional response info            |

### Built-in Tools

**Web Search Preview:**

```typescript
azure.tools.webSearchPreview({
  searchContextSize: 'low',
  userLocation?: { /* location object */ }
})
```

**File Search:**

```typescript
azure.tools.fileSearch({
  vectorStoreIds: string[],
  maxNumResults?: number,        // Default: 10
  ranking?: { /* ranking options */ }
})
```

**Image Generation:**

```typescript
azure.tools.imageGeneration({
  outputFormat?: 'png'            // Default
})
```

**Code Interpreter:**

```typescript
azure.tools.codeInterpreter({
  container?: {
    fileIds: string[]
  }
})
```

### Completion Models (azure.completion()) - Provider Options (providerOptions.openai)

| Parameter | Type                   | Min        | Max | Default | Values/Constraint          | Applies To        | UI Control       | Notes                         |
| --------- | ---------------------- | ---------- | --- | ------- | -------------------------- | ----------------- | ---------------- | ----------------------------- |
| echo      | boolean                | -          | -   | false   | true/false                 | Completion models | Toggle           | Echo prompt with completion   |
| logitBias | Record<number, number> | -100       | 100 | None    | Token likelihood modifier  | Completion models | Complex input    | Maps token IDs to bias values |
| logprobs  | boolean or number      | false or 1 | 20  | false   | true or 1-20               | Completion models | Toggle or Number | Return log probabilities      |
| suffix    | string                 | -          | -   | None    | Text                       | Completion models | Text input       | Text after completion         |
| user      | string                 | -          | -   | None    | Unique end-user identifier | Completion models | Text input       | For monitoring                |

### Embedding Models (azure.embedding()) - Provider Options (providerOptions.openai)

| Parameter  | Type   | Min           | Max           | Default | Values/Constraint                  | Applies To       | UI Control   | Notes             |
| ---------- | ------ | ------------- | ------------- | ------- | ---------------------------------- | ---------------- | ------------ | ----------------- |
| dimensions | number | Not specified | Not specified | None    | e.g., 512 (text-embedding-3+ only) | Embedding models | Number input | Output dimensions |
| user       | string | -             | -             | None    | Unique end-user identifier         | Embedding models | Text input   | For monitoring    |

### Image Models (azure.image())

| Parameter      | Type   | Min | Max | Default | Values/Constraint                                                                            | Applies To   | UI Control | Notes           |
| -------------- | ------ | --- | --- | ------- | -------------------------------------------------------------------------------------------- | ------------ | ---------- | --------------- |
| size           | enum   | -   | -   | None    | DALL-E 3: '1024x1024', '1792x1024', '1024x1792'; DALL-E 2: '256x256', '512x512', '1024x1024' | Image models | Select     | Output size     |
| user           | string | -   | -   | None    | Unique end-user identifier                                                                   | Image models | Text input | For monitoring  |
| responseFormat | enum   | -   | -   | 'url'   | 'url', 'b64_json'                                                                            | Image models | Select     | Response format |

### Transcription Models (azure.transcription()) - Provider Options (providerOptions.openai)

| Parameter              | Type     | Min | Max | Default     | Values/Constraint                          | Applies To           | UI Control   | Notes                    |
| ---------------------- | -------- | --- | --- | ----------- | ------------------------------------------ | -------------------- | ------------ | ------------------------ |
| timestampGranularities | string[] | -   | -   | ['segment'] | ['word'], ['segment'], ['word', 'segment'] | Transcription models | Multi-select | Timestamp detail         |
| language               | string   | -   | -   | None        | ISO-639-1 (e.g., 'en')                     | Transcription models | Text input   | Audio language           |
| prompt                 | string   | -   | -   | None        | Text                                       | Transcription models | Textarea     | Style guide              |
| temperature            | number   | 0   | 1   | 0           | Sampling temperature                       | Transcription models | Slider       | Transcription only       |
| include                | string[] | -   | -   | None        | Additional info                            | Transcription models | Multi-select | Additional response info |

### Speech Models (azure.speech()) - Provider Options (providerOptions.openai)

| Parameter    | Type   | Min  | Max | Default | Values/Constraint | Applies To                         | UI Control | Notes                      |
| ------------ | ------ | ---- | --- | ------- | ----------------- | ---------------------------------- | ---------- | -------------------------- |
| instructions | string | -    | -   | None    | Text              | Speech models (not tts-1/tts-1-hd) | Textarea   | Voice control instructions |
| speed        | number | 0.25 | 4.0 | 1.0     | Playback speed    | Speech models                      | Slider     | Audio speed                |

### Key Differences from OpenAI Provider

1. **Authentication**: Uses api-key header instead of Authorization: Bearer
2. **URL construction**: Azure-specific patterns with resource names or deployment-based URLs
3. **Responses API**: Default model factory azure() uses Responses API (not available in base OpenAI)
4. **Built-in tools**: Azure provider includes webSearchPreview, fileSearch, imageGeneration, codeInterpreter
5. **Provider options key**: Uses providerOptions.azure for Responses API (vs openai for chat/completion)
6. **PDF support**: Native PDF file reading in Responses API
7. **Deployment names**: Uses deployment names instead of model IDs

---

## Provider: Mistral

**API Documentation:** https://ai-sdk.dev/providers/ai-sdk-providers/mistral

### Provider Instance Configuration

| Parameter | Type                   | Default                   | Values/Constraint | UI Control | Notes           |
| --------- | ---------------------- | ------------------------- | ----------------- | ---------- | --------------- |
| baseURL   | string                 | https://api.mistral.ai/v1 | API endpoint      | Text input | Custom endpoint |
| apiKey    | string                 | MISTRAL_API_KEY env       | API key           | Text input | Required        |
| headers   | Record<string, string> | None                      | Custom headers    | N/A        | Programmatic    |
| fetch     | function               | global fetch              | Custom fetch      | N/A        | Programmatic    |

### Language Model Provider Options (providerOptions.mistral)

| Parameter          | Type    | Min           | Max           | Default | Values/Constraint | Applies To | UI Control   | Notes                                     |
| ------------------ | ------- | ------------- | ------------- | ------- | ----------------- | ---------- | ------------ | ----------------------------------------- |
| safePrompt         | boolean | -             | -             | false   | true/false        | All models | Toggle       | Inject safety prompt before conversations |
| documentImageLimit | number  | Not specified | Not specified | None    | Integer           | All models | Number input | Max images in document                    |
| documentPageLimit  | number  | Not specified | Not specified | None    | Integer           | All models | Number input | Max pages in document                     |
| strictJsonSchema   | boolean | -             | -             | false   | true/false        | All models | Toggle       | Strict JSON schema validation             |
| structuredOutputs  | boolean | -             | -             | true    | true/false        | All models | Toggle       | Enable structured outputs                 |
| parallelToolCalls  | boolean | -             | -             | true    | true/false        | All models | Toggle       | Enable parallel function calling          |

### Missing Parameters

The documentation does NOT specify:

- temperature range or default
- maxTokens per model
- topP values or range
- randomSeed availability or type
- frequencyPenalty
- presencePenalty

**Note:** These parameters may be available through standard AI SDK settings but are not documented in the Mistral-specific provider page.

---

## Provider: Cohere

**API Documentation:** https://ai-sdk.dev/providers/ai-sdk-providers/cohere

### Provider Instance Configuration

| Parameter  | Type                   | Default                   | Values/Constraint | UI Control | Notes           |
| ---------- | ---------------------- | ------------------------- | ----------------- | ---------- | --------------- |
| baseURL    | string                 | https://api.cohere.com/v2 | API endpoint      | Text input | Custom endpoint |
| apiKey     | string                 | COHERE_API_KEY env        | API key           | Text input | Required        |
| headers    | Record<string, string> | None                      | Custom headers    | N/A        | Programmatic    |
| fetch      | function               | global fetch              | Custom fetch      | N/A        | Programmatic    |
| generateId | function               | () => string              | ID generator      | N/A        | Programmatic    |

### Language Model Options (CohereLanguageModelOptions)

**Reasoning Parameters:**

| Parameter            | Type   | Min           | Max           | Default | Values/Constraint                    | Applies To       | UI Control   | Notes                 |
| -------------------- | ------ | ------------- | ------------- | ------- | ------------------------------------ | ---------------- | ------------ | --------------------- |
| thinking.type        | enum   | -             | -             | None    | 'enabled'                            | Reasoning models | Select       | Enable thinking mode  |
| thinking.tokenBudget | number | Not specified | Not specified | None    | Example: 100 (no min/max documented) | Reasoning models | Number input | Thinking token budget |

### Embedding Model Options (CohereEmbeddingModelOptions)

| Parameter | Type | Min | Max | Default        | Values/Constraint                                                 | Applies To       | UI Control | Notes                   |
| --------- | ---- | --- | --- | -------------- | ----------------------------------------------------------------- | ---------------- | ---------- | ----------------------- |
| inputType | enum | -   | -   | 'search_query' | 'search_document', 'search_query', 'classification', 'clustering' | Embedding models | Select     | Input type optimization |
| truncate  | enum | -   | -   | 'END'          | 'NONE', 'START', 'END'                                            | Embedding models | Select     | Truncation strategy     |

### Reranking Model Options (CohereRerankingModelOptions)

| Parameter       | Type   | Min           | Max           | Default | Values/Constraint | Applies To       | UI Control   | Notes                   |
| --------------- | ------ | ------------- | ------------- | ------- | ----------------- | ---------------- | ------------ | ----------------------- |
| maxTokensPerDoc | number | Not specified | Not specified | 4096    | Integer           | Reranking models | Number input | Max tokens per document |
| priority        | number | Not specified | Not specified | 0       | Integer           | Reranking models | Number input | Priority level          |

### Missing Parameters

The documentation does NOT specify:

- temperature range
- max tokens per model
- topP values
- topK values
- frequencyPenalty
- presencePenalty
- seed parameter
- tokenBudget min/max limits

**Note:** These parameters may be available but are not documented in the provider page.

---

## Provider: Groq

**API Documentation:** https://ai-sdk.dev/providers/ai-sdk-providers/groq

### Provider Instance Configuration

| Parameter | Type                   | Default                        | Values/Constraint | UI Control | Notes           |
| --------- | ---------------------- | ------------------------------ | ----------------- | ---------- | --------------- |
| baseURL   | string                 | https://api.groq.com/openai/v1 | API endpoint      | Text input | Custom endpoint |
| apiKey    | string                 | GROQ_API_KEY env               | API key           | Text input | Required        |
| headers   | Record<string, string> | None                           | Custom headers    | N/A        | Programmatic    |
| fetch     | function               | global fetch                   | Custom fetch      | N/A        | Programmatic    |

### Language Model Options (GroqLanguageModelOptions)

**Reasoning Configuration:**

| Parameter       | Type | Min | Max | Default                      | Values/Constraint                          | Applies To                                                            | UI Control | Notes                       |
| --------------- | ---- | --- | --- | ---------------------------- | ------------------------------------------ | --------------------------------------------------------------------- | ---------- | --------------------------- |
| reasoningFormat | enum | -   | -   | None                         | 'parsed', 'raw', 'hidden'                  | qwen-qwq-32b, deepseek-r1-distill-\*                                  | Select     | Controls reasoning exposure |
| reasoningEffort | enum | -   | -   | 'default' for qwen/qwen3-32b | 'low', 'medium', 'high', 'none', 'default' | qwen/qwen3-32b: none/default; gpt-oss20b/gpt-oss120b: low/medium/high | Select     | Controls reasoning effort   |

**Service Configuration:**

| Parameter   | Type | Min | Max | Default     | Values/Constraint           | Applies To | UI Control | Notes                                               |
| ----------- | ---- | --- | --- | ----------- | --------------------------- | ---------- | ---------- | --------------------------------------------------- |
| serviceTier | enum | -   | -   | 'on_demand' | 'on_demand', 'flex', 'auto' | All models | Select     | 'flex' = 10x rate limits; 'auto' = fallback to flex |

**Structured Outputs:**

| Parameter         | Type    | Min | Max | Default | Values/Constraint | Applies To | UI Control | Notes                                                      |
| ----------------- | ------- | --- | --- | ------- | ----------------- | ---------- | ---------- | ---------------------------------------------------------- |
| structuredOutputs | boolean | -   | -   | true    | true/false        | All models | Toggle     | Enables json_schema format                                 |
| strictJsonSchema  | boolean | -   | -   | true    | true/false        | All models | Toggle     | Constrained decoding (only when structuredOutputs enabled) |

**Tool & User Settings:**

| Parameter         | Type    | Min | Max | Default | Values/Constraint          | Applies To | UI Control | Notes                            |
| ----------------- | ------- | --- | --- | ------- | -------------------------- | ---------- | ---------- | -------------------------------- |
| parallelToolCalls | boolean | -   | -   | true    | true/false                 | All models | Toggle     | Enable parallel function calling |
| user              | string  | -   | -   | None    | Unique end-user identifier | All models | Text input | For monitoring                   |

### Transcription Model Options (GroqTranscriptionModelOptions)

| Parameter              | Type     | Min | Max | Default     | Values/Constraint                          | Applies To           | UI Control   | Notes                                   |
| ---------------------- | -------- | --- | --- | ----------- | ------------------------------------------ | -------------------- | ------------ | --------------------------------------- |
| language               | string   | -   | -   | None        | ISO-639-1 (e.g., 'en')                     | Transcription models | Text input   | Improves accuracy and latency           |
| timestampGranularities | string[] | -   | -   | ['segment'] | ['word'], ['segment'], ['word', 'segment'] | Transcription models | Multi-select | Requires responseFormat: 'verbose_json' |
| responseFormat         | string   | -   | -   | None        | 'verbose_json', 'text'                     | Transcription models | Select       | Output format                           |
| prompt                 | string   | -   | -   | None        | Text                                       | Transcription models | Textarea     | Style guide or continuation             |
| temperature            | number   | 0   | 1   | 0           | Sampling temperature                       | Transcription models | Slider       | Auto-adjusts using log probability at 0 |

### Missing Parameters

The documentation does NOT specify:

- Token limits per model
- topP range or default
- frequencyPenalty
- presencePenalty
- seed
- logitBias

**Note:** Model-specific capabilities vary. See Model Capabilities table in documentation.

---

## Provider: Fireworks

**API Documentation:** https://ai-sdk.dev/providers/ai-sdk-providers/fireworks

### Provider Instance Configuration

| Parameter | Type                   | Default                               | Values/Constraint | UI Control | Notes           |
| --------- | ---------------------- | ------------------------------------- | ----------------- | ---------- | --------------- |
| apiKey    | string                 | FIREWORKS_API_KEY env                 | API key           | Text input | Required        |
| baseURL   | string                 | https://api.fireworks.ai/inference/v1 | API endpoint      | Text input | Custom endpoint |
| headers   | Record<string, string> | None                                  | Custom headers    | N/A        | Programmatic    |
| fetch     | function               | global fetch                          | Custom fetch      | N/A        | Programmatic    |

### Language Model Provider Options

**Thinking Configuration (for reasoning models like Kimi K2.5):**

| Parameter             | Type   | Min  | Max           | Default | Values/Constraint     | Applies To       | UI Control   | Notes                   |
| --------------------- | ------ | ---- | ------------- | ------- | --------------------- | ---------------- | ------------ | ----------------------- |
| thinking.type         | enum   | -    | -             | None    | 'enabled', 'disabled' | Reasoning models | Select       | Enable/disable thinking |
| thinking.budgetTokens | number | 1024 | Not specified | None    | Integer               | Reasoning models | Number input | Minimum 1024 tokens     |

**Reasoning History:**

| Parameter        | Type | Min | Max | Default | Values/Constraint                      | Applies To       | UI Control | Notes                                                                                   |
| ---------------- | ---- | --- | --- | ------- | -------------------------------------- | ---------------- | ---------- | --------------------------------------------------------------------------------------- |
| reasoningHistory | enum | -   | -   | None    | 'disabled', 'interleaved', 'preserved' | Reasoning models | Select     | 'disabled' = remove; 'interleaved' = include between tool calls; 'preserved' = keep all |

### Image Model Options

**Output Format:**

| Parameter                               | Type | Min | Max | Default | Values/Constraint          | Applies To   | UI Control | Notes         |
| --------------------------------------- | ---- | --- | --- | ------- | -------------------------- | ------------ | ---------- | ------------- |
| providerOptions.fireworks.output_format | enum | -   | -   | None    | 'jpeg' (shown in examples) | Image models | Select     | Output format |

**Dimensions:**

**Aspect Ratio Support (FLUX models):**

- 1:1, 2:3, 3:2, 4:5, 5:4, 16:9, 9:16, 9:21, 21:9

**Size Support (Stable Diffusion models):**

- 640x1536, 768x1344, 832x1216, 896x1152, 1024x1024, 1152x896, 1216x832, 1344x768, 1536x640

### Missing Parameters

The documentation does NOT specify:

- temperature range
- max tokens per model
- topP
- topK
- frequencyPenalty
- presencePenalty

**Note:** These parameters may be available through standard AI SDK settings but are not documented in the Fireworks-specific provider page.

---

## Provider: Together AI

**API Documentation:** https://ai-sdk.dev/providers/ai-sdk-providers/togetherai

### Provider Instance Configuration

| Parameter | Type                   | Default                     | Values/Constraint | UI Control | Notes           |
| --------- | ---------------------- | --------------------------- | ----------------- | ---------- | --------------- |
| apiKey    | string                 | TOGETHER_AI_API_KEY env     | API key           | Text input | Required        |
| baseURL   | string                 | https://api.together.xyz/v1 | API endpoint      | Text input | Custom endpoint |
| headers   | Record<string, string> | None                        | Custom headers    | N/A        | Programmatic    |
| fetch     | function               | global fetch                | Custom fetch      | N/A        | Programmatic    |

### Image Model Parameters (providerOptions.togetherai)

| Parameter              | Type    | Min           | Max           | Default | Values/Constraint                        | Applies To                               | UI Control   | Notes                         |
| ---------------------- | ------- | ------------- | ------------- | ------- | ---------------------------------------- | ---------------------------------------- | ------------ | ----------------------------- |
| steps                  | number  | Not specified | Not specified | None    | Example: 28-40 (higher = better quality) | Image models                             | Number input | Generation steps              |
| guidance               | number  | Not specified | Not specified | None    | Guidance scale                           | Image models                             | Number input | Guidance scale for generation |
| negative_prompt        | string  | -             | -             | None    | Text                                     | Image models                             | Textarea     | What to avoid                 |
| disable_safety_checker | boolean | -             | -             | false   | true/false                               | Image models (not Flux Schnell Free/Pro) | Toggle       | Bypass NSFW filter            |

**Image Dimensions:**

- Varies by model
- Common: 512x512, 768x768, 1024x1024
- Some models support up to 1792x1792
- Default: 1024x1024

### Embedding Model Parameters

No configurable parameters documented. Models have:

- Fixed dimensions: 768-1024
- Max tokens: 512-32768

**Embedding Model Token Limits:**

- m2-bert-80M-2k-retrieval: 2048 tokens
- m2-bert-80M-8k-retrieval: 8192 tokens
- m2-bert-80M-32k-retrieval: 32768 tokens
- Others: 512 tokens

### Reranking Model Parameters (providerOptions.togetherai)

| Parameter  | Type     | Min           | Max           | Default    | Values/Constraint | Applies To       | UI Control   | Notes                           |
| ---------- | -------- | ------------- | ------------- | ---------- | ----------------- | ---------------- | ------------ | ------------------------------- |
| rankFields | string[] | -             | -             | All fields | Field names       | Reranking models | Multi-select | Fields for ranking JSON objects |
| topN       | number   | Not specified | Not specified | None       | Integer           | Reranking models | Number input | Number of top results           |

### Missing Parameters

The documentation does NOT specify:

- Language model parameters (temperature, topP, topK, etc.)
- Max tokens per language model
- frequencyPenalty
- presencePenalty
- repetitionPenalty
- logitBias

**Note:** Language models listed show capabilities but not parameter ranges.

---

## Provider: Perplexity

**API Documentation:** https://ai-sdk.dev/providers/ai-sdk-providers/perplexity

### Provider Instance Configuration

| Parameter | Type                   | Default                   | Values/Constraint | UI Control | Notes           |
| --------- | ---------------------- | ------------------------- | ----------------- | ---------- | --------------- |
| apiKey    | string                 | PERPLEXITY_API_KEY env    | API key           | Text input | Required        |
| baseURL   | string                 | https://api.perplexity.ai | API endpoint      | Text input | Custom endpoint |
| headers   | Record<string, string> | None                      | Custom headers    | N/A        | Programmatic    |
| fetch     | function               | global fetch              | Custom fetch      | N/A        | Programmatic    |

### Provider Options (providerOptions.perplexity)

| Parameter             | Type    | Min | Max | Default  | Values/Constraint              | Applies To | UI Control | Notes                         |
| --------------------- | ------- | --- | --- | -------- | ------------------------------ | ---------- | ---------- | ----------------------------- |
| return_images         | boolean | -   | -   | false    | true/false (Tier-2 users only) | All models | Toggle     | Enables image responses       |
| search_recency_filter | enum    | -   | -   | All time | 'hour', 'day', 'week', 'month' | All models | Select     | Filters search by time period |

### Provider Metadata (Response)

The response includes additional metadata:

- usage.citationTokens (number): Token count for citations
- usage.numSearchQueries (number): Number of search queries performed
- images (array): Image objects with imageUrl, originUrl, height, width

### Missing Parameters

The documentation states "Any other Perplexity API parameters can also be passed through providerOptions.perplexity" but doesn't list:

- temperature range or default
- max tokens per model
- topP values
- topK values
- frequencyPenalty
- presencePenalty
- return_related_questions (mentioned but not detailed)

**Note:** References external Perplexity API documentation for complete parameter details.

---

## Provider: DeepSeek

**API Documentation:** https://ai-sdk.dev/providers/ai-sdk-providers/deepseek

### Provider Instance Configuration

| Parameter | Type                   | Default                  | Values/Constraint | UI Control | Notes           |
| --------- | ---------------------- | ------------------------ | ----------------- | ---------- | --------------- |
| baseURL   | string                 | https://api.deepseek.com | API endpoint      | Text input | Custom endpoint |
| apiKey    | string                 | DEEPSEEK_API_KEY env     | API key           | Text input | Required        |
| headers   | Record<string, string> | None                     | Custom headers    | N/A        | Programmatic    |
| fetch     | function               | global fetch             | Custom fetch      | N/A        | Programmatic    |

### Model-Specific Options (providerOptions)

**Thinking Configuration:**

| Parameter     | Type | Min | Max | Default | Values/Constraint     | Applies To                                                 | UI Control | Notes                              |
| ------------- | ---- | --- | --- | ------- | --------------------- | ---------------------------------------------------------- | ---------- | ---------------------------------- |
| thinking.type | enum | -   | -   | None    | 'enabled', 'disabled' | deepseek-chat (optional); deepseek-reasoner (auto-enabled) | Select     | Chain-of-thought reasoning control |

### Response Metadata (providerMetadata.deepseek)

The response includes caching metadata:

- promptCacheHitTokens: Number of cached input tokens
- promptCacheMissTokens: Number of uncached input tokens

### Reasoning Support

Available via streaming for deepseek-reasoner model:

- Stream parts: type === 'reasoning' (reasoning text) or type === 'text' (final answer)

### Available Models

- deepseek-chat: Supports text generation, objects, tools, tool streaming
- deepseek-reasoner: Supports text generation, objects, tools, tool streaming

### Missing Parameters

The documentation does NOT specify:

- temperature range
- max tokens limits
- topP
- frequencyPenalty
- presencePenalty
- logitBias

**Note:** These may follow standard OpenAI-compatible defaults but are not explicitly documented.

---

## Provider: xAI

**API Documentation:** https://ai-sdk.dev/providers/ai-sdk-providers/xai

### Provider Instance Configuration

| Parameter | Type                   | Default             | Values/Constraint | UI Control | Notes           |
| --------- | ---------------------- | ------------------- | ----------------- | ---------- | --------------- |
| baseURL   | string                 | https://api.x.ai/v1 | API endpoint      | Text input | Custom endpoint |
| apiKey    | string                 | XAI_API_KEY env     | API key           | Text input | Required        |
| headers   | Record<string, string> | None                | Custom headers    | N/A        | Programmatic    |
| fetch     | function               | global fetch        | Custom fetch      | N/A        | Programmatic    |

### Chat Model Provider Options (XaiLanguageModelChatOptions)

**Reasoning Configuration:**

| Parameter       | Type | Min | Max | Default | Values/Constraint | Applies To       | UI Control | Notes                                 |
| --------------- | ---- | --- | --- | ------- | ----------------- | ---------------- | ---------- | ------------------------------------- |
| reasoningEffort | enum | -   | -   | None    | 'low', 'high'     | Reasoning models | Select     | Reasoning effort for reasoning models |

**Tool Configuration:**

| Parameter                 | Type    | Min | Max | Default | Values/Constraint | Applies To | UI Control | Notes                            |
| ------------------------- | ------- | --- | --- | ------- | ----------------- | ---------- | ---------- | -------------------------------- |
| parallel_function_calling | boolean | -   | -   | true    | true/false        | All models | Toggle     | Enable parallel function calling |

**Search Parameters:**

| Parameter                         | Type    | Min | Max | Default      | Values/Constraint       | Applies To | UI Control    | Notes                 |
| --------------------------------- | ------- | --- | --- | ------------ | ----------------------- | ---------- | ------------- | --------------------- |
| searchParameters.mode             | enum    | -   | -   | 'auto'       | 'auto', 'on', 'off'     | All models | Select        | Search mode control   |
| searchParameters.returnCitations  | boolean | -   | -   | true         | true/false              | All models | Toggle        | Include citations     |
| searchParameters.fromDate         | string  | -   | -   | None         | ISO8601 (YYYY-MM-DD)    | All models | Date input    | Start date for search |
| searchParameters.toDate           | string  | -   | -   | None         | ISO8601 (YYYY-MM-DD)    | All models | Date input    | End date for search   |
| searchParameters.maxSearchResults | number  | 1   | 50  | 20           | Integer                 | All models | Number input  | Max search results    |
| searchParameters.sources          | array   | -   | -   | ["web", "x"] | Array of source objects | All models | Complex input | Search sources        |

**Web Source Configuration:**

```typescript
{
  type: 'web',
  country: string,                    // ISO alpha-2
  allowedWebsites: string[],          // Max 5
  excludedWebsites: string[],         // Max 5
  safeSearch: boolean                 // Default: true
}
```

**X Source Configuration:**

```typescript
{
  type: 'x',
  includedXHandles: string[],
  excludedXHandles: string[],
  postFavoriteCount: number,
  postViewCount: number
}
```

**News Source Configuration:**

```typescript
{
  type: 'news',
  country: string,                    // ISO alpha-2
  excludedWebsites: string[],         // Max 5
  safeSearch: boolean                 // Default: true
}
```

**RSS Source Configuration:**

```typescript
{
  type: 'rss',
  links: string[]                     // Max 1 currently
}
```

### Responses API Provider Options (XaiLanguageModelResponsesOptions)

| Parameter          | Type    | Min | Max | Default | Values/Constraint            | Applies To       | UI Control   | Notes                              |
| ------------------ | ------- | --- | --- | ------- | ---------------------------- | ---------------- | ------------ | ---------------------------------- |
| reasoningEffort    | enum    | -   | -   | None    | 'low', 'medium', 'high'      | Reasoning models | Select       | Control reasoning effort           |
| include            | array   | -   | -   | None    | ['file_search_call.results'] | All models       | Multi-select | Include file search results        |
| store              | boolean | -   | -   | true    | true/false                   | All models       | Toggle       | Store messages for later retrieval |
| previousResponseId | string  | -   | -   | None    | Response ID                  | All models       | Text input   | Continue conversation              |

### Server-Side Tool Parameters

**Web Search Tool:**

```typescript
{
  allowedDomains: string[],           // Max 5
  excludedDomains: string[],          // Max 5
  enableImageUnderstanding: boolean
}
```

**X Search Tool:**

```typescript
{
  allowedXHandles: string[],          // Max 10
  excludedXHandles: string[],         // Max 10
  fromDate: string,                   // ISO8601
  toDate: string,                     // ISO8601
  enableImageUnderstanding: boolean,
  enableVideoUnderstanding: boolean
}
```

**File Search Tool:**

```typescript
{
  vectorStoreIds: string[],           // Required
  maxNumResults: number
}
```

**MCP Server Tool:**

```typescript
{
  serverUrl: string,                  // Required
  serverLabel: string,
  serverDescription: string,
  allowedTools: string[],
  headers: Record<string, string>,
  authorization: string
}
```

### Video Model Options (XaiVideoModelOptions)

| Parameter      | Type   | Min           | Max           | Default         | Values/Constraint | Applies To        | UI Control   | Notes             |
| -------------- | ------ | ------------- | ------------- | --------------- | ----------------- | ----------------- | ------------ | ----------------- |
| pollIntervalMs | number | Not specified | Not specified | 5000            | Milliseconds      | Video models      | Number input | Polling interval  |
| pollTimeoutMs  | number | Not specified | Not specified | 600000 (10 min) | Milliseconds      | Video models      | Number input | Polling timeout   |
| resolution     | enum   | -             | -             | None            | '480p', '720p'    | Video models      | Select       | Video resolution  |
| videoUrl       | string | -             | -             | None            | URL               | Video edit models | Text input   | For video editing |

### Image Model Parameters

| Parameter   | Type   | Min           | Max           | Default | Values/Constraint                                                                                           | Applies To   | UI Control   | Notes                        |
| ----------- | ------ | ------------- | ------------- | ------- | ----------------------------------------------------------------------------------------------------------- | ------------ | ------------ | ---------------------------- |
| aspectRatio | enum   | -             | -             | None    | '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2', '19.5:9', '9:19.5', '20:9', '9:20', 'auto' | Image models | Select       | Output aspect ratio          |
| n           | number | Not specified | Not specified | None    | Integer                                                                                                     | Image models | Number input | Number of images to generate |

### Missing Parameters

The documentation does NOT specify:

- temperature range or default
- topP
- maxTokens
- frequencyPenalty
- presencePenalty
- logitBias

**Note:** Standard parameters may follow OpenAI-compatible defaults but are not explicitly documented.

---

## Provider: Amazon Bedrock

**API Documentation:** https://ai-sdk.dev/providers/ai-sdk-providers/amazon-bedrock

### Provider Instance Configuration

| Parameter          | Type                   | Default                      | Values/Constraint   | UI Control            | Notes             |
| ------------------ | ---------------------- | ---------------------------- | ------------------- | --------------------- | ----------------- |
| region             | string                 | AWS_REGION env               | AWS region          | Text input            | Required          |
| accessKeyId        | string                 | AWS_ACCESS_KEY_ID env        | AWS access key      | Text input            | Required          |
| secretAccessKey    | string                 | AWS_SECRET_ACCESS_KEY env    | AWS secret key      | Text input (password) | Required          |
| sessionToken       | string                 | AWS_SESSION_TOKEN env        | AWS session token   | Text input            | Optional          |
| credentialProvider | function               | None                         | Returns credentials | N/A                   | Programmatic      |
| apiKey             | string                 | AWS_BEARER_TOKEN_BEDROCK env | Bearer token        | Text input            | Alternative auth  |
| baseURL            | string                 | None                         | Custom endpoint     | Text input            | Override endpoint |
| headers            | Record<string, string> | None                         | Custom headers      | N/A                   | Programmatic      |
| fetch              | function               | global fetch                 | Custom fetch        | N/A                   | Programmatic      |

### Guardrail Configuration (providerOptions.bedrock)

```typescript
guardrailConfig: {
  guardrailIdentifier: string,        // Required
  guardrailVersion: string,           // Required
  trace: 'enabled' | 'disabled',
  streamProcessingMode: 'sync' | 'async'
}
```

| Parameter            | Type   | Min | Max | Default | Values/Constraint     | Applies To | UI Control | Notes                   |
| -------------------- | ------ | --- | --- | ------- | --------------------- | ---------- | ---------- | ----------------------- |
| guardrailIdentifier  | string | -   | -   | None    | Guardrail ID          | All models | Text input | Required for guardrails |
| guardrailVersion     | string | -   | -   | None    | Version               | All models | Text input | Required for guardrails |
| trace                | enum   | -   | -   | None    | 'enabled', 'disabled' | All models | Select     | Guardrail tracing       |
| streamProcessingMode | enum   | -   | -   | None    | 'sync', 'async'       | All models | Select     | Processing mode         |

### Reasoning Configuration (providerOptions.bedrock)

**For Anthropic Models (Claude 3.7, Claude 4):**

```typescript
reasoningConfig: {
  type: 'enabled',
  budgetTokens: number                // Min: 1024, Max: 64000
}
```

| Parameter                    | Type   | Min  | Max   | Default | Values/Constraint | Applies To           | UI Control   | Notes                  |
| ---------------------------- | ------ | ---- | ----- | ------- | ----------------- | -------------------- | ------------ | ---------------------- |
| reasoningConfig.type         | enum   | -    | -     | None    | 'enabled'         | Claude 3.7, Claude 4 | Select       | Enable reasoning       |
| reasoningConfig.budgetTokens | number | 1024 | 64000 | None    | Integer           | Claude 3.7, Claude 4 | Number input | Reasoning token budget |

**For Amazon Models (Nova 2):**

```typescript
reasoningConfig: {
  type: 'enabled',
  maxReasoningEffort: 'low' | 'medium' | 'high'
}
```

| Parameter                          | Type | Min | Max | Default | Values/Constraint       | Applies To | UI Control | Notes                  |
| ---------------------------------- | ---- | --- | --- | ------- | ----------------------- | ---------- | ---------- | ---------------------- |
| reasoningConfig.type               | enum | -   | -   | None    | 'enabled'               | Nova 2     | Select     | Enable reasoning       |
| reasoningConfig.maxReasoningEffort | enum | -   | -   | None    | 'low', 'medium', 'high' | Nova 2     | Select     | Reasoning effort level |

### Cache Points (providerOptions.bedrock)

```typescript
cachePoint: {
  type: 'default',
  ttl?: '5m' | '1h'                   // Default: '5m'
}
```

| Parameter       | Type | Min | Max | Default | Values/Constraint | Applies To                             | UI Control | Notes            |
| --------------- | ---- | --- | --- | ------- | ----------------- | -------------------------------------- | ---------- | ---------------- |
| cachePoint.type | enum | -   | -   | None    | 'default'         | All models                             | Select     | Cache point type |
| cachePoint.ttl  | enum | -   | -   | '5m'    | '5m', '1h'        | Claude Opus/Haiku/Sonnet 4.5 (1h only) | Select     | Cache duration   |

**Requirements:**

- Minimum 1024 tokens before checkpoint
- Up to 4 cache points (Claude 3.5 Sonnet v2)

### Model-Specific Parameters

**Anthropic Additional Fields (providerOptions.anthropic):**

```typescript
additionalModelRequestFields: {
  top_k?: number                      // Example: 350
}
```

**Extended Context Window (Claude Sonnet 4):**

```typescript
providerOptions: {
  bedrock: {
    anthropicBeta: ['context-1m-2025-08-07']; // Up to 1M tokens
  }
}
```

### Embedding Model Parameters

**Titan v2 (providerOptions.bedrock):**

| Parameter  | Type    | Min | Max | Default | Values/Constraint | Applies To | UI Control | Notes                |
| ---------- | ------- | --- | --- | ------- | ----------------- | ---------- | ---------- | -------------------- |
| dimensions | enum    | -   | -   | 1024    | 256, 512, 1024    | Titan v2   | Select     | Output dimensions    |
| normalize  | boolean | -   | -   | true    | true/false        | Titan v2   | Toggle     | Normalize embeddings |

**Nova Embed (providerOptions.bedrock):**

| Parameter          | Type | Min | Max | Default | Values/Constraint                                                                                                                                                     | Applies To | UI Control | Notes               |
| ------------------ | ---- | --- | --- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------- | ------------------- |
| embeddingDimension | enum | -   | -   | 1024    | 256, 384, 1024, 3072                                                                                                                                                  | Nova Embed | Select     | Output dimensions   |
| embeddingPurpose   | enum | -   | -   | None    | 'GENERIC_INDEX', 'TEXT_RETRIEVAL', 'IMAGE_RETRIEVAL', 'VIDEO_RETRIEVAL', 'DOCUMENT_RETRIEVAL', 'AUDIO_RETRIEVAL', 'GENERIC_RETRIEVAL', 'CLASSIFICATION', 'CLUSTERING' | Nova Embed | Select     | Embedding purpose   |
| truncate           | enum | -   | -   | 'END'   | 'NONE', 'START', 'END'                                                                                                                                                | Nova Embed | Select     | Truncation strategy |

**Cohere Embedding (providerOptions.bedrock):**

| Parameter | Type | Min | Max | Default | Values/Constraint                                                 | Applies To    | UI Control | Notes               |
| --------- | ---- | --- | --- | ------- | ----------------------------------------------------------------- | ------------- | ---------- | ------------------- |
| inputType | enum | -   | -   | None    | 'search_document', 'search_query', 'classification', 'clustering' | Cohere models | Select     | Input type          |
| truncate  | enum | -   | -   | None    | 'NONE', 'START', 'END'                                            | Cohere models | Select     | Truncation strategy |

### Image Generation (Nova Canvas) (providerOptions.bedrock)

| Parameter          | Type   | Min           | Max           | Default | Values/Constraint                                                                                                                                                               | Applies To                           | UI Control   | Notes                |
| ------------------ | ------ | ------------- | ------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------ | -------------------- |
| quality            | enum   | -             | -             | None    | 'standard', 'premium'                                                                                                                                                           | Nova Canvas                          | Select       | Output quality       |
| negativeText       | string | -             | -             | None    | Text                                                                                                                                                                            | Nova Canvas                          | Textarea     | What to avoid        |
| cfgScale           | number | Not specified | Not specified | None    | Guidance scale                                                                                                                                                                  | Nova Canvas                          | Number input | Guidance scale       |
| style              | enum   | -             | -             | None    | '3D_ANIMATED_FAMILY_FILM', 'DESIGN_SKETCH', 'FLAT_VECTOR_ILLUSTRATION', 'GRAPHIC_NOVEL_ILLUSTRATION', 'MAXIMALISM', 'MIDCENTURY_RETRO', 'PHOTOREALISM', 'SOFT_DIGITAL_PAINTING' | Nova Canvas                          | Select       | Style preset         |
| taskType           | enum   | -             | -             | None    | 'TEXT_IMAGE', 'IMAGE_VARIATION', 'INPAINTING', 'OUTPAINTING', 'BACKGROUND_REMOVAL'                                                                                              | Nova Canvas                          | Select       | Generation task type |
| maskPrompt         | string | -             | -             | None    | Text                                                                                                                                                                            | Nova Canvas (INPAINTING/OUTPAINTING) | Text input   | Mask prompt          |
| similarityStrength | number | 0             | 1             | None    | Float                                                                                                                                                                           | Nova Canvas (IMAGE_VARIATION)        | Slider       | Similarity strength  |
| outPaintingMode    | enum   | -             | -             | None    | 'DEFAULT', 'PRECISE'                                                                                                                                                            | Nova Canvas (OUTPAINTING)            | Select       | Outpainting mode     |

**Size Constraints:**

- 320-4096px per side
- Divisible by 16
- Aspect ratio 1:4 to 4:1
- Max 4,194,304 pixels total

### File Input (Citations)

```typescript
{
  type: 'file',
  providerOptions: {
    bedrock: {
      citations: { enabled: boolean }
    }
  }
}
```

### Provider Metadata Response (providerMetadata.bedrock)

Response includes:

- trace: object (Guardrail tracing)
- performanceConfig: { latency: 'optimized' }
- serviceTier: { type: 'on-demand' }
- usage.cacheReadInputTokens: number
- usage.cacheWriteInputTokens: number
- usage.cacheDetails: object
- stopSequence: string | null

### Bedrock Anthropic Provider Settings

Same configuration as main Bedrock provider.

**Cache Control (Anthropic via Bedrock):**

```typescript
providerOptions: {
  anthropic: {
    cacheControl: {
      type: 'ephemeral';
    }
  }
}
```

**Requirement:** Minimum 1024 tokens before cache checkpoint

---

## UI Control Type Recommendations

Based on parameter types and constraints, here are recommended UI controls:

### Control Patterns

| Parameter Type         | Characteristics         | Recommended UI Control           |
| ---------------------- | ----------------------- | -------------------------------- |
| number (0-1 or 0-2)    | Small range, continuous | Slider with step increments      |
| number (1-1000000)     | Large range             | Number input with validation     |
| number (integer count) | Discrete values         | Number input (integer only)      |
| enum (2-4 values)      | Limited options         | Toggle group or Radio buttons    |
| enum (5+ values)       | Many options            | Select dropdown                  |
| boolean                | True/false              | Toggle switch                    |
| string (short)         | Single line text        | Text input                       |
| string (long)          | Multi-line text         | Textarea                         |
| string[]               | Multiple strings        | Tag input or Multi-line textarea |
| Record<string, string> | Key-value pairs         | Complex key-value editor         |
| Complex objects        | Nested structure        | Collapsible section or Modal     |

### Specific Parameter Control Mapping

| Parameter             | UI Control       | Implementation Notes                        |
| --------------------- | ---------------- | ------------------------------------------- |
| temperature           | Slider (0-2)     | Step: 0.1, show value label                 |
| maxOutputTokens       | Number input     | Min: 1, validation per model                |
| topP                  | Slider (0-1)     | Step: 0.01, show value label                |
| topK                  | Number input     | Integer only, min: 1                        |
| frequencyPenalty      | Slider (-2 to 2) | Step: 0.1, show value label                 |
| presencePenalty       | Slider (-2 to 2) | Step: 0.1, show value label                 |
| seed                  | Number input     | Integer only, optional                      |
| stopSequences         | Textarea         | Multi-line, one per line                    |
| reasoningEffort       | Select dropdown  | Show available values per model             |
| serviceTier           | Select dropdown  | Show descriptions for each tier             |
| thinking.budgetTokens | Number input     | Min: 1024, validation per model             |
| safetySettings        | Complex editor   | Nested array editor with category/threshold |
| searchParameters      | Complex editor   | Collapsible section with sub-fields         |

### Adaptive Controls

For model-specific parameters:

1. Show/hide controls based on selected model
2. Disable unavailable options with tooltip explaining why
3. Provide inline help text for complex parameters
4. Use validation to enforce min/max constraints
5. Show warnings when using conflicting parameters (temperature + topP)

---

## Notes

1. **Provider Dependency:** Most parameter ranges are explicitly noted as provider-dependent in the AI SDK core documentation.

2. **Model-Specific Limits:** Exact context window and max output token limits are not comprehensively documented in the AI SDK provider pages. Refer to each provider's official documentation for precise limits.

3. **Documentation Gaps:** Some providers (Mistral, Cohere, Together AI, Perplexity, DeepSeek) have minimal parameter documentation on ai-sdk.dev. Standard parameters may be available but not documented.

4. **Parameter Conflicts:** The AI SDK recommends using either `temperature` OR `topP`, not both simultaneously.

5. **Versioning:** This documentation reflects the state of ai-sdk.dev as of February 2025. Provider APIs and parameters may change.

6. **Programmatic Parameters:** Some parameters like `headers`, `fetch`, `abortSignal`, and complex objects are programmatic and not suitable for UI configuration.

7. **Warnings:** The AI SDK returns warnings in the result object when unsupported settings are passed to a provider.

---

## References

- AI SDK Core Documentation: https://ai-sdk.dev/docs/ai-sdk-core
- AI SDK Providers: https://ai-sdk.dev/providers/ai-sdk-providers
- Individual provider documentation linked in each section

---

**Document Version:** 1.0
**Last Updated:** February 25, 2026
**AI SDK Version:** 5.x

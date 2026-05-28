# ABL Guardrails System Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Comprehensive guardrails system with tiered execution pipeline, policy engine, model-based safety checks, tenant-level provider registry (including self-hosted open-source models), and project-level policy configuration.

**Architecture:** Hybrid Layered Pipeline (execution) + Policy Engine (configuration). Three-tier guardrail evaluation — local CEL, model-based, LLM-based — with parallel execution within tiers, graduated failure actions, severity levels, and project-scoped policy management in MongoDB.

**Tech Stack:** TypeScript, CEL (cel-js), MongoDB (policy store), Redis (caching + circuit breakers), BGE-M3 (semantic cache embeddings), external inference endpoints (Qwen3Guard, Granite Guardian, LlamaGuard, etc.)

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Industry Research Summary](#2-industry-research-summary)
3. [Architecture Overview](#3-architecture-overview)
4. [DSL Syntax](#4-dsl-syntax)
5. [IR Schema](#5-ir-schema)
6. [Policy Engine](#6-policy-engine)
7. [Execution Pipeline](#7-execution-pipeline)
8. [Provider Interface](#8-provider-interface)
9. [CEL Functions](#9-cel-functions)
10. [Action Semantics](#10-action-semantics)
11. [Severity Levels](#11-severity-levels)
12. [Tool Rails](#12-tool-rails)
13. [RAG-Specific Guardrails](#13-rag-specific-guardrails)
14. [Multi-Agent Handoff Guardrails](#14-multi-agent-handoff-guardrails)
15. [Streaming Guardrails](#15-streaming-guardrails)
16. [Semantic Caching](#16-semantic-caching)
17. [Constitution-as-Policy](#17-constitution-as-policy)
18. [Circuit Breakers](#18-circuit-breakers)
19. [Cost-Aware Guardrail Selection](#19-cost-aware-guardrail-selection)
20. [Guardrail Versioning](#20-guardrail-versioning)
21. [A/B Testing](#21-ab-testing)
22. [Compound False Positive Rate Management](#22-compound-false-positive-rate-management)
23. [Trace Events and Webhooks](#23-trace-events-and-webhooks)
24. [Admin UI](#24-admin-ui)
25. [Migration from Current Implementation](#25-migration-from-current-implementation)
26. [References](#26-references)

---

## 1. Problem Statement

ABL's guardrails are partially implemented with 7 critical gaps:

1. **Custom guardrail functions not implemented** — `not_matches_pattern()`, `toxicity_score()` referenced in examples but don't exist
2. **PII detection not wired** — `pii-detector.ts` exists standalone, not connected to guardrails
3. **Context variables not injected** — `input`, `output`, `response` not auto-populated for CEL expressions
4. **`kind` not respected** — Input vs output timing parsed but runtime doesn't differentiate
5. **Priority ordering not implemented** — `priority` parsed but guardrails execute in definition order
6. **`warn` action not handled** — Compiler's `mapGuardrailAction()` silently falls through on `warn`
7. **`redact` doesn't truly redact** — Action exists in IR but no content modification occurs

Beyond these bugs, the system lacks industry-standard capabilities: model-based safety checks, tool validation, streaming evaluation, policy management, and graduated failure handling.

### Current Implementation Inventory

| Layer                         | Status                   | Key Files                                                                            |
| ----------------------------- | ------------------------ | ------------------------------------------------------------------------------------ |
| Parser                        | Working                  | `packages/core/src/parser/agent-based-parser.ts:4473-4568`                           |
| Types                         | Working                  | `packages/core/src/types/agent-based.ts:649-662`                                     |
| Compiler                      | Working (gaps)           | `packages/compiler/src/platform/ir/compiler.ts:888-918`                              |
| IR Schema                     | Working                  | `packages/compiler/src/platform/ir/schema.ts:715-763`                                |
| Runtime (constraint executor) | Working (gaps)           | `packages/compiler/src/platform/constructs/executors/constraint-executor.ts:208-266` |
| Runtime (session-level)       | Working                  | `apps/runtime/src/services/execution/constraint-checker.ts:42-81`                    |
| CEL Functions                 | 37 functions             | `packages/compiler/src/platform/constructs/cel-functions.ts:75-462`                  |
| PII Detector                  | Standalone               | `packages/compiler/src/platform/security/pii-detector.ts:1-223`                      |
| Tests                         | Parsing/compilation only | `packages/compiler/src/__tests__/guardrails/guardrails-e2e.test.ts`                  |

---

## 2. Industry Research Summary

Research across 10 major frameworks and 8 guardrail models informed this design.

### Frameworks Evaluated

| Framework               | Architecture                                                  | Key Innovation                                                               |
| ----------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| NVIDIA NeMo Guardrails  | 5-stage pipeline (input → dialog → retrieval → output → tool) | Colang DSL, parallel rails execution                                         |
| Guardrails AI           | Validator pattern with Hub ecosystem                          | Graduated OnFail actions (NOOP → FIX → REASK → FILTER → REFRAIN → EXCEPTION) |
| OpenGuardrails          | Unified guard model + API                                     | Per-request policy customization, configurable tau thresholds                |
| LangChain/LangGraph     | 6-hook middleware (before/after at agent, model, tool levels) | Agent middleware pattern                                                     |
| Anthropic               | Constitutional Classifiers                                    | Natural language policy → compiled classifiers                               |
| AWS Bedrock Guardrails  | Parallel policy evaluation                                    | Guardrail versioning, contextual grounding checks                            |
| Azure AI Content Safety | Unified API with severity levels                              | 7-level severity scale, task adherence, groundedness                         |

### Guardrail Models Evaluated

| Model            | Size             | Key Strength                                                            | Weakness                                     |
| ---------------- | ---------------- | ----------------------------------------------------------------------- | -------------------------------------------- |
| Qwen3Guard-8B    | 0.6-8B           | 85.3% accuracy, 119 languages, 3-tier severity, streaming variant       | 57.2pp generalization gap on novel prompts   |
| Granite Guardian | 2-8B             | RAG-specific checks (groundedness, context relevance, answer relevance) | Text only                                    |
| WildGuard-7B     | 7B               | 82.8% accuracy, strong generalization                                   | No streaming                                 |
| Llama Guard 4    | 12B              | Multimodal (text + image), taxonomy-as-prompt                           | Too permissive (4.5-21.8% harmful detection) |
| ShieldGemma 2    | 4B               | Image safety classification                                             | Image only, no text moderation               |
| OpenGuardrails   | 3.3B (quantized) | 98% accuracy retained from 14B, Apache 2.0, P95=274ms                   | No streaming                                 |

### Critical Production Findings

1. **Compound false positive rate**: 5 guardrails at 90% individual accuracy = ~40% compound FPR. The #1 production problem.
2. **Generalization gap**: High benchmark scores may reflect overfitting. Qwen3Guard dropped from 85.3% to 33.8% on novel prompts.
3. **Tool call safety is unsolved**: Mozilla AI benchmark found no models reliable for function calling evaluation.
4. **Fail-closed for safety, fail-open for quality**: Universal production consensus on timeout handling.
5. **Microservices over monolith**: IBM found guardrails are best implemented as independent, composable services.

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Policy Resolution Layer                        │
│  Tenant policy → Project policy → Agent DSL → Merged + versioned │
└───────────────────────────┬─────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│                    Kind Filter                                    │
│  input | output | tool_input | tool_output | handoff              │
└───────────────────────────┬─────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│  Tier 1: Local (< 1ms)                                           │
│  ┌─────────┬──────────┬──────────┬────────────┐                  │
│  │ CEL     │ PII      │ Pattern  │ Length     │  ← parallel      │
│  │ checks  │ detect   │ match    │ checks    │                   │
│  └────┬────┴────┬─────┴────┬─────┴─────┬─────┘                  │
│       └─────────┴── merge by priority + severity ──┘             │
│       any block? → graduated response (fix → reask → block)      │
└───────────────────────────┬─────────────────────────────────────┘
                            ↓ (all pass)
┌─────────────────────────────────────────────────────────────────┐
│  Tier 2: Model-based (50-500ms)                                   │
│  ┌────────────┬───────────────┬──────────────┐                   │
│  │ Qwen3Guard │ Granite       │ Custom       │  ← parallel       │
│  │ (circuit   │ Guardian      │ provider     │                   │
│  │  breaker)  │ (RAG checks)  │              │                   │
│  └─────┬──────┴──────┬────────┴──────┬───────┘                   │
│        └─────────────┴── merge by priority + severity ──┘        │
└───────────────────────────┬─────────────────────────────────────┘
                            ↓ (all pass)
┌─────────────────────────────────────────────────────────────────┐
│  Tier 3: LLM-based (200-2000ms)                                   │
│  ┌──────────────────────────────────────────┐                    │
│  │ Contextual checks (on-topic, grounding,  │                    │
│  │ constitution principles)                  │                    │
│  └─────────────────────┬────────────────────┘                    │
└───────────────────────────┬─────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│  Result: pass | violations[]                                      │
│  + compound FPR metric + cost tracking                            │
│  + trace events + webhook + policy version ID                     │
└─────────────────────────────────────────────────────────────────┘
```

### Execution Points in Runtime

| Point     | Kind                 | When                                            | Location                      |
| --------- | -------------------- | ----------------------------------------------- | ----------------------------- |
| Pre-LLM   | `input`              | Before LLM call                                 | `runtime-executor.ts`         |
| Post-LLM  | `output`             | After LLM response, before delivery             | `runtime-executor.ts`         |
| Pre-tool  | `tool_input`         | Before tool execution                           | Tool execution loop           |
| Post-tool | `tool_output`        | After tool execution, before result reaches LLM | Tool execution loop           |
| Handoff   | `handoff`            | Before context transfer between agents          | `HandoffExecutor`             |
| Streaming | `output` (streaming) | During SSE token delivery                       | `StreamingGuardrailEvaluator` |

---

## 4. DSL Syntax

The existing `GUARDRAILS:` section extends with new fields for model-based, LLM-based, and specialized checks.

```yaml
GUARDRAILS:
  # ── Tier 1: Local CEL checks (< 1ms) ──────────────────────

  - name: pii_protection
    kind: both # input | output | both | tool_input | tool_output | handoff
    check: abl.contains_pii(input) # CEL expression → Tier 1
    action: redact
    message: 'PII detected and redacted'
    priority: 1 # Lower = higher priority

  - name: max_input_length
    kind: input
    check: abl.length(input) > 10000
    action: block
    message: 'Input exceeds maximum length'
    priority: 2

  - name: no_code_injection
    kind: input
    check: abl.matches_pattern(input, "<script|javascript:|eval\\(")
    action: block
    message: 'Potentially unsafe content detected'
    priority: 1

  # ── Tier 2: Model-based checks (50-500ms) ─────────────────

  - name: content_safety
    kind: both
    provider: qwen3guard # Named provider from registry
    category: content_safety # Safety taxonomy category
    threshold: 0.8 # Score threshold (0.0-1.0)
    action: block
    severity_actions: # Graduated actions by severity
      low: warn
      medium: reask
      high: block
    message: 'Content flagged as unsafe'
    priority: 3

  - name: grounding_check
    kind: output
    provider: granite_guardian
    category: groundedness # RAG-specific: is response grounded in context?
    threshold: 0.7
    action: reask
    message: 'Response not grounded in retrieved context'
    priority: 5

  # ── Tier 3: LLM-based checks (200-2000ms) ─────────────────

  - name: on_topic_check
    kind: output
    llm_check: | # Natural language check → Tier 3
      Is this response relevant to the agent's goal: {agent_goal}?
      Does it stay within the defined scope?
    threshold: 0.7
    action: warn
    message: 'Response may be off-topic'
    priority: 10

  # ── Tool rails ─────────────────────────────────────────────

  - name: no_destructive_tools
    kind: tool_input
    check: tool_name not in ["delete_account", "drop_table", "rm_rf"]
    action: block
    message: 'Destructive tool call blocked'
    priority: 1

  - name: tool_result_pii
    kind: tool_output
    check: abl.contains_pii(tool_result)
    action: redact
    message: 'PII in tool result redacted before LLM'
    priority: 2

  # ── Handoff rails ──────────────────────────────────────────

  - name: handoff_data_scope
    kind: handoff
    check: not abl.contains_pii(handoff_context) && abl.length(handoff_context) < 5000
    action: redact
    message: 'PII stripped from handoff context'
    priority: 1

  # ── Streaming ──────────────────────────────────────────────

  - name: streaming_pii_monitor
    kind: output
    check: abl.contains_pii(output)
    action: redact
    streaming: true # Evaluate during SSE streaming
    streaming_interval: sentence # token | sentence | chunk_size
    priority: 1
```

### Field Reference

| Field                | Type    | Required | Description                                                       |
| -------------------- | ------- | -------- | ----------------------------------------------------------------- |
| `name`               | string  | Yes      | Unique identifier for the guardrail                               |
| `kind`               | enum    | Yes      | `input`, `output`, `both`, `tool_input`, `tool_output`, `handoff` |
| `check`              | string  | Tier 1   | CEL expression                                                    |
| `provider`           | string  | Tier 2   | Named provider from registry                                      |
| `category`           | string  | Tier 2   | Safety taxonomy category                                          |
| `threshold`          | number  | Tier 2/3 | Score threshold (0.0-1.0)                                         |
| `llm_check`          | string  | Tier 3   | Natural language check prompt                                     |
| `action`             | enum    | Yes      | `block`, `warn`, `redact`, `escalate`, `fix`, `reask`, `filter`   |
| `severity_actions`   | object  | No       | Per-severity action overrides                                     |
| `message`            | string  | No       | User-facing message on violation                                  |
| `priority`           | number  | No       | Execution priority (lower = first). Default: 100                  |
| `streaming`          | boolean | No       | Enable mid-stream evaluation. Default: false                      |
| `streaming_interval` | enum    | No       | `token`, `sentence`, `chunk_size`. Default: `sentence`            |

### Tier Inference

Tier is automatically inferred at compile time:

- Has `check` (CEL expression) → **Tier 1** (local)
- Has `provider` → **Tier 2** (model-based)
- Has `llm_check` → **Tier 3** (LLM-based)

---

## 5. IR Schema

```typescript
// packages/compiler/src/platform/ir/schema.ts

interface Guardrail {
  /** Unique guardrail identifier */
  name: string;

  /** Human-readable description */
  description: string;

  /** When this guardrail fires */
  kind: 'input' | 'output' | 'both' | 'tool_input' | 'tool_output' | 'handoff';

  /** Execution priority (lower = first) */
  priority: number;

  /** Inferred execution tier */
  tier: 'local' | 'model' | 'llm';

  // ── Tier 1: Local CEL ──
  /** CEL expression to evaluate */
  check?: string;

  // ── Tier 2: Model-based ──
  /** Provider name from registry */
  provider?: string;
  /** Safety taxonomy category */
  category?: string;
  /** Score threshold (0.0-1.0) */
  threshold?: number;

  // ── Tier 3: LLM-based ──
  /** Natural language check prompt */
  llmCheck?: string;

  // ── Action ──
  /** Default action on violation */
  action: ConstraintAction;
  /** Per-severity action overrides */
  severityActions?: Record<SeverityLevel, ConstraintAction>;

  // ── Streaming ──
  /** Enable mid-stream evaluation */
  streaming?: boolean;
  /** Streaming evaluation interval */
  streamingInterval?: 'token' | 'sentence' | 'chunk_size';
}

type SeverityLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

interface ConstraintConfig {
  constraints: Constraint[];
  guardrails: Guardrail[];
}
```

### Changes from Current IR

| Field                 | Before                  | After                      |
| --------------------- | ----------------------- | -------------------------- |
| `kind`                | Lost during compilation | Preserved                  |
| `priority`            | Lost during compilation | Preserved                  |
| `tier`                | N/A                     | New — inferred from DSL    |
| `provider`            | N/A                     | New — model-based checks   |
| `category`            | N/A                     | New — safety taxonomy      |
| `threshold`           | N/A                     | New — score threshold      |
| `llmCheck`            | N/A                     | New — LLM-based checks     |
| `severityActions`     | N/A                     | New — graduated actions    |
| `streaming`           | N/A                     | New — streaming evaluation |
| `streamingInterval`   | N/A                     | New — streaming interval   |
| `action.type: 'warn'` | Falls through (bug)     | Properly mapped            |

---

## 6. Policy Engine

### 6.1 Tenant-Level Provider Registry

Providers are registered at **tenant level** — shared across all projects in the tenant. This is where admins configure their self-hosted open-source models, commercial API endpoints, and inference infrastructure.

```typescript
// New MongoDB collection: guardrail_provider_configs

interface TenantGuardrailProviderConfig {
  _id: ObjectId;
  tenantId: string;

  /** Provider name used in DSL and policy references */
  name: string;

  /** Human-readable display name */
  displayName: string;

  /** Provider adapter type — determines how to call the endpoint */
  adapterType:
    | 'openai_compatible' // vLLM, TGI, Ollama, any /v1/chat/completions
    | 'openai_moderation' // OpenAI Moderation API (/v1/moderations)
    | 'huggingface_inference' // HuggingFace Inference API
    | 'anthropic' // Claude API
    | 'google_cloud' // Google Cloud Text Moderation / Checks Guardrails API
    | 'vertex_ai' // Vertex AI Model Garden (VirtueGuard, ShieldGemma, etc.)
    | 'bedrock' // AWS Bedrock Guardrails API
    | 'azure_content_safety' // Azure AI Content Safety
    | 'lakera' // Lakera Guard API (prompt injection, data leakage)
    | 'aporia' // Aporia Guardrails API (20+ policies)
    | 'custom_http'; // Raw HTTP POST with configurable request/response mapping

  /** Inference endpoint URL */
  endpoint: string;

  /** Reference to LLMCredential for API authentication (encrypted at rest) */
  apiKeyCredentialId?: string;

  /** Model identifier on the endpoint (e.g., "qwen3guard-8b", "meta-llama/Llama-Guard-4-12B") */
  model: string;

  /** Hosting type — helps the UI show relevant configuration options */
  hosting:
    | 'self_hosted' // Customer's own infrastructure (vLLM, TGI, Ollama)
    | 'cloud_api' // Commercial API (HuggingFace, Anthropic, OpenAI)
    | 'managed_service'; // Managed guardrail service (Bedrock, Azure)

  /** For self-hosted: deployment details for observability */
  selfHostedConfig?: {
    runtime: 'vllm' | 'tgi' | 'ollama' | 'triton' | 'other';
    gpuType?: string; // e.g., "A100", "T4", "L4"
    quantization?: 'none' | 'gptq' | 'awq' | 'gguf' | 'fp8';
    maxBatchSize?: number;
    maxConcurrency?: number;
  };

  /** Default safety category this provider evaluates */
  defaultCategory: string;

  /** Default score threshold */
  defaultThreshold: number;

  /** Supported categories (for UI dropdowns and validation) */
  supportedCategories: string[];

  /** Request/response mapping for custom_http adapter */
  customMapping?: {
    requestTemplate: string; // Handlebars template for request body
    responseScorePath: string; // JSONPath to score in response (e.g., "$.results[0].score")
    responseLabelPath?: string; // JSONPath to label
    responseExplanationPath?: string; // JSONPath to explanation
  };

  /** Circuit breaker configuration */
  circuitBreaker: {
    failureThreshold: number;
    resetTimeoutMs: number;
    failMode: 'open' | 'closed';
  };

  /** Retry configuration */
  retry: {
    maxRetries: number;
    backoffBaseMs: number;
  };

  /** Cost per evaluation in USD */
  costPerEvalUsd: number;

  /** Provider status */
  isActive: boolean;

  /** Last health check result */
  lastHealthCheck?: {
    status: 'healthy' | 'unhealthy' | 'unknown';
    latencyMs: number;
    checkedAt: Date;
    error?: string;
  };

  createdAt: Date;
  updatedAt: Date;
}
```

#### Model Catalog (Pre-configured Templates)

The Admin UI offers a **model catalog** with pre-configured templates for open-source models, commercial APIs, and managed services. Selecting one pre-fills the adapter type, model ID, supported categories, request mapping, and recommended thresholds. The admin only needs to provide their endpoint URL and credentials.

**Open-Source Models (Self-Hosted)**

These run on customer infrastructure via vLLM, TGI, Ollama, or Triton. Customer provides the endpoint URL.

| Model               | Adapter             | Default Categories                                                           | Rec. Threshold | Notes                                                                                                               |
| ------------------- | ------------------- | ---------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------- |
| Qwen3Guard-8B       | `openai_compatible` | content_safety, pii, jailbreak, violence, sexual, self_harm, hate, copyright | 0.8            | Best overall accuracy (85.3%), 119 languages, streaming variant                                                     |
| Qwen3Guard-0.6B     | `openai_compatible` | Same as 8B                                                                   | 0.85           | Smaller, faster. Good for edge/sidecar.                                                                             |
| Granite Guardian 8B | `openai_compatible` | content_safety, groundedness, context_relevance, answer_relevance            | 0.7            | Best for RAG use cases. vLLM-optimized.                                                                             |
| Granite Guardian 2B | `openai_compatible` | Same as 8B                                                                   | 0.75           | Smaller variant, competitive accuracy.                                                                              |
| Llama Guard 4 12B   | `openai_compatible` | content_safety (MLCommons taxonomy)                                          | 0.5            | Multimodal (text + image). Taxonomy-as-prompt.                                                                      |
| WildGuard 7B        | `openai_compatible` | content_safety, prompt_harm, response_harm, refusal                          | 0.7            | Strong generalization on novel prompts.                                                                             |
| OpenGuardrails 3.3B | `openai_compatible` | content_safety, prompt_injection, jailbreak, data_leakage                    | 0.8            | Quantized from 14B (98% retained), Apache 2.0.                                                                      |
| ShieldGemma 2 4B    | `openai_compatible` | image_safety (dangerous, sexual, violence)                                   | 0.8            | Image moderation only — pair with text model.                                                                       |
| LlamaFirewall       | `custom_http`       | prompt_injection, agent_misalignment, insecure_code                          | N/A (binary)   | Meta's modular guardrail framework. Includes PromptGuard 2, AlignmentCheck, CodeShield. Self-hosted Python service. |

**Commercial API Providers**

These are hosted services with per-call pricing. Customer provides API key.

| Provider                                                                                                                                      | Adapter             | Default Categories                                                                       | Rec. Threshold    | Notes                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------- |
| [Virtue AI (VirtueGuard)](https://www.virtueai.com/)                                                                                          | `vertex_ai`         | 12 risk categories, code safety, multimodal (text, image, audio, video, code)            | 0.8               | Sub-10ms latency. Available on Vertex AI Model Garden. 100+ languages. Enterprise leader. |
| [OpenAI Moderation API](https://platform.openai.com/docs/guides/moderation)                                                                   | `openai_moderation` | hate, sexual, violence, self_harm, harassment, illicit (GPT-4o based)                    | Category-specific | Free. Multimodal (text + image). 40 languages. 95% accuracy.                              |
| [Google Checks Guardrails API](https://developers.google.com/checks/guide/ai-safety/guardrails)                                               | `google_cloud`      | Configurable harm categories + PII                                                       | Per-policy        | Configurable policies with custom thresholds.                                             |
| [Google Vertex AI Text Moderation](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/gemini-for-filtering-and-moderation) | `vertex_ai`         | hate, dangerous, sexual, harassment + CSAM, PII (non-configurable)                       | Configurable      | Gemini as Judge for prompt injection, jailbreak, agent misalignment.                      |
| [Lakera Guard](https://www.lakera.ai/lakera-guard)                                                                                            | `lakera`            | prompt_injection, data_leakage, toxicity, content_moderation, pii                        | Per-policy        | Now part of Check Point. Single API call. Free community tier.                            |
| [Aporia Guardrails](https://gr-docs.aporia.com/)                                                                                              | `aporia`            | 20+ pre-configured policies (hallucination, data leak, prompt injection, toxicity, etc.) | Per-policy        | 0.95 F1 score. 340ms avg latency. Dynamic block/override/rephrase actions.                |
| [Anthropic Claude](https://www.anthropic.com/research/constitutional-classifiers)                                                             | `anthropic`         | Custom (constitutional classifiers, any safety criteria)                                 | 0.7               | Best for nuanced/contextual checks. Constitutional approach.                              |

**Managed Cloud Services**

Fully managed guardrail infrastructure, no model hosting needed.

| Service                                                                                                | Adapter                | Default Categories                                                                 | Rec. Threshold | Notes                                                                    |
| ------------------------------------------------------------------------------------------------------ | ---------------------- | ---------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------ |
| [AWS Bedrock Guardrails](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails.html)         | `bedrock`              | Configurable content filters + PII + grounding + contextual grounding              | Per-filter     | Versioning built-in. Parallel policy evaluation. Streaming support.      |
| [Azure AI Content Safety](https://learn.microsoft.com/en-us/azure/ai-services/content-safety/overview) | `azure_content_safety` | hate, sexual, violence, self_harm (severity 0-6) + custom categories               | Severity ≥ 4   | 7-level severity scale. Task adherence. Groundedness detection.          |
| [F5 AI Guardrails (CalypsoAI)](https://www.f5.com/company/blog/what-are-ai-guardrails)                 | `custom_http`          | adversarial_threats, prompt_injection, jailbreak, data_security                    | Per-policy     | Enterprise runtime security. Adaptive threat protection. Cloud-agnostic. |
| [Robust Intelligence (Cisco)](https://www.lakera.ai/blog/llm-security-tools)                           | `custom_http`          | AI Firewall — validates models for vulnerabilities, enforces guardrails at runtime | Per-policy     | Two-part: AI Validation (pre-deploy) + AI Protection (runtime).          |

#### Provider Resolution Chain

Providers resolve from most specific to least specific:

```
1. Project-level provider override (same name as tenant provider, different config)
   ↓ fallback
2. Tenant-level provider (TenantGuardrailProviderConfig)
   ↓ fallback
3. Built-in providers (builtin_pii — always available, no config needed)
```

- **Tenant registers providers once** — all projects in the tenant can reference them by name
- **Projects can override** a tenant provider (e.g., different endpoint for a specific project's region)
- **Projects cannot create providers** that don't exist at tenant level (except built-ins)
- This mirrors how `TenantModel` and `LLMCredential` work today for LLM providers

### 6.2 Policy Data Model

```typescript
// New MongoDB collection: guardrail_policies

interface GuardrailPolicy {
  _id: ObjectId;
  tenantId: string;
  name: string;

  /** Scope: which agents/projects this policy applies to */
  scope: {
    type: 'tenant' | 'project' | 'agent';
    projectId?: string;
    agentDefId?: string;
  };

  /** Project-level provider overrides (references tenant providers by name) */
  providerOverrides: GuardrailProviderOverride[];

  /** Policy rules (merge with DSL-defined guardrails) */
  rules: PolicyRule[];

  /** Natural language constitution principles */
  constitution: ConstitutionPrinciple[];

  /** Global pipeline settings */
  settings: {
    /** On provider timeout: pass or block */
    failMode: 'open' | 'closed';

    /** Timeout per tier */
    timeouts: {
      local: number; // ms, default 10
      model: number; // ms, default 500
      llm: number; // ms, default 2000
    };

    /** Violation webhook */
    webhookUrl?: string;
    webhookSecret?: string; // Encrypted via LLMCredential pattern

    /** Streaming guardrail config */
    streaming: {
      enabled: boolean;
      defaultInterval: 'token' | 'sentence' | 'chunk_size';
      chunkSize: number; // For chunk_size interval
      maxLatencyMs: number; // Max time for mid-stream check
      earlyTermination: boolean; // Kill stream on violation
    };
  };

  /** Semantic caching config */
  caching: {
    enabled: boolean;
    exactMatch: boolean;
    semanticMatch: boolean;
    semanticThreshold: number; // Similarity threshold (default: 0.95)
    defaultTtlSeconds: number; // Default TTL (default: 3600)
  };

  /** Cost budget for guardrail inference */
  budget: {
    monthlyLimitUsd: number;
    currentSpendUsd: number;
    overspendAction: 'downgrade' | 'disable_model_checks' | 'alert_only';
  };

  /** A/B testing configuration */
  abTest?: GuardrailABTest;

  /** Version management */
  version: number;
  previousVersionId?: ObjectId;
  changelog?: string;
  status: 'draft' | 'active' | 'archived';

  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}
```

### 6.3 Project-Level Provider Overrides

Projects can override specific fields of tenant-level providers (e.g., different endpoint for a regional deployment, different threshold for a specific project's risk tolerance):

```typescript
interface GuardrailProviderOverride {
  /** References a tenant-level provider by name */
  providerName: string;

  /** Override fields (only specified fields are overridden, rest inherited) */
  endpoint?: string;
  apiKeyCredentialId?: string;
  defaultThreshold?: number;
  circuitBreaker?: Partial<CircuitBreakerConfig>;
  costPerEvalUsd?: number;
  isActive?: boolean; // Can disable a tenant provider for this project
}
```

### 6.4 Policy Rules

```typescript
interface PolicyRule {
  /** Matches DSL guardrail name */
  guardrailName: string;

  /** Override type */
  override: 'disable' | 'threshold' | 'action' | 'severity_actions';

  /** Override threshold */
  threshold?: number;

  /** Override action */
  action?: ConstraintAction;

  /** Override severity actions */
  severityActions?: Record<SeverityLevel, ConstraintAction>;
}
```

### 6.5 Resolution Order

**Providers** resolve tenant → project:

```
1. Project-level provider override (providerOverrides in project policy)
   ↓ fallback
2. Tenant-level provider (TenantGuardrailProviderConfig collection)
   ↓ fallback
3. Built-in providers (builtin_pii — always available)
```

**Policies** merge with clear precedence (most specific wins):

```
1. Agent-scoped policy (scope.agentDefId matches)
   ↓ fallback
2. Project-scoped policy (scope.projectId matches)  ← PRIMARY config surface
   ↓ fallback
3. Tenant-scoped policy (scope.type === 'tenant')
   ↓ fallback
4. DSL-defined guardrails (compiled into IR)
```

**Merge semantics:**

- Same `name` in policy and DSL → **policy overrides DSL** (admin intent beats developer default)
- Policy can **disable** a DSL guardrail (`override: 'disable'`)
- Policy can **add** guardrails not in DSL (project-wide rules)
- Agent DSL can **add** guardrails not in policy (agent-specific rules)
- Agent DSL **cannot disable** project/tenant policy guardrails (security invariant)
- Priority ordering spans all levels
- **Provider references in guardrail rules** are validated against resolved providers (tenant + built-in). A guardrail referencing a provider not registered at tenant level is a compile-time error.

---

## 7. Execution Pipeline

### 7.1 Pipeline Interface

```typescript
interface GuardrailPipeline {
  /**
   * Execute guardrail checks for the given content and kind.
   * Resolves policy, filters by kind, executes tiered pipeline.
   */
  execute(
    session: SessionState,
    content: string,
    kind: GuardrailKind,
    context: GuardrailContext,
    onTraceEvent?: TraceCallback,
  ): Promise<GuardrailPipelineResult>;
}

type GuardrailKind = 'input' | 'output' | 'tool_input' | 'tool_output' | 'handoff';

interface GuardrailContext {
  /** For tool_input/tool_output: tool metadata */
  toolName?: string;
  toolParameters?: Record<string, unknown>;
  toolResult?: unknown;

  /** For handoff: agent context */
  sourceAgent?: string;
  targetAgent?: string;
  handoffContext?: string;
  handoffReason?: string;

  /** For output + RAG: retrieval context */
  retrievedDocuments?: Array<{ content: string; source: string }>;

  /** For LLM-based checks: agent goal */
  agentGoal?: string;

  /** Conversation history for contextual checks */
  recentMessages?: Array<{ role: string; content: string }>;
}

interface GuardrailPipelineResult {
  /** Overall outcome */
  passed: boolean;

  /** All violations (empty if passed) */
  violations: GuardrailViolation[];

  /** Winning violation (highest priority) */
  primaryViolation?: GuardrailViolation;

  /** Modified content (after fix/redact actions) */
  modifiedContent?: string;

  /** Warnings (for warn actions — don't block, just log) */
  warnings: GuardrailViolation[];

  /** Pipeline metrics */
  metrics: {
    totalChecks: number;
    passed: number;
    failed: number;
    warnings: number;
    totalLatencyMs: number;
    tier1LatencyMs: number;
    tier2LatencyMs: number;
    tier3LatencyMs: number;
    compoundFPREstimate: number;
    costUsd: number;
    cacheHits: number;
    cacheMisses: number;
    policyVersion: number;
  };
}

interface GuardrailViolation {
  name: string;
  kind: GuardrailKind;
  tier: 'local' | 'model' | 'llm';
  action: string;
  severity: SeverityLevel;
  score?: number;
  threshold?: number;
  category?: string;
  label?: string;
  message: string;
  explanation?: string;
  priority: number;
  latencyMs: number;
  provider?: string;
}
```

### 7.2 Runtime Integration

```typescript
// runtime-executor.ts (reasoning mode)
async processMessage(session, message, onChunk, onTraceEvent) {
  // ── INPUT guardrails ── before LLM call
  const inputResult = await this.guardrailPipeline.execute(
    session, message, 'input',
    { agentGoal: agentIR.goal, recentMessages: session.messages },
    onTraceEvent,
  );

  if (!inputResult.passed) {
    return this.handleGuardrailViolation(session, inputResult, onChunk, onTraceEvent);
  }

  // Apply input modifications (redact/fix)
  const processedMessage = inputResult.modifiedContent ?? message;

  // Emit warnings (don't block)
  for (const warning of inputResult.warnings) {
    onTraceEvent?.({ type: 'guardrail_warning', ...warning });
  }

  // ... system prompt generation ...
  // ... LLM call ...

  const llmResponse = await this.callLLM(session, processedMessage);

  // ── OUTPUT guardrails ── after LLM response, before delivery
  const outputResult = await this.guardrailPipeline.execute(
    session, llmResponse, 'output',
    {
      agentGoal: agentIR.goal,
      recentMessages: session.messages,
      retrievedDocuments: session.lastRetrievedDocs,
    },
    onTraceEvent,
  );

  if (!outputResult.passed) {
    return this.handleGuardrailViolation(session, outputResult, onChunk, onTraceEvent);
  }

  // Apply output modifications
  const deliveredResponse = outputResult.modifiedContent ?? llmResponse;

  // Deliver response
  return { response: deliveredResponse };
}

// Tool execution loop
async executeTool(session, toolCall, onTraceEvent) {
  // ── TOOL_INPUT guardrails ── before tool execution
  const preToolResult = await this.guardrailPipeline.execute(
    session, JSON.stringify(toolCall.parameters), 'tool_input',
    { toolName: toolCall.name, toolParameters: toolCall.parameters },
    onTraceEvent,
  );

  if (!preToolResult.passed) {
    return { success: false, error: preToolResult.primaryViolation };
  }

  // Execute tool
  const toolResult = await this.toolExecutor.execute(toolCall);

  // ── TOOL_OUTPUT guardrails ── after tool, before LLM sees result
  const postToolResult = await this.guardrailPipeline.execute(
    session, JSON.stringify(toolResult), 'tool_output',
    { toolName: toolCall.name, toolResult },
    onTraceEvent,
  );

  return postToolResult.modifiedContent
    ? JSON.parse(postToolResult.modifiedContent)
    : toolResult;
}
```

### 7.3 Execution Algorithm

```
function executePipeline(guardrails, content, kind, context):
  1. RESOLVE merged policy (tenant → project → agent DSL)
  2. FILTER guardrails by kind (input, output, tool_input, etc.)
  3. CHECK cache (exact match first, then semantic if enabled)
  4. SORT remaining by tier, then by priority within tier
  5. CHECK budget (skip Tier 2/3 if budget exhausted and policy says 'downgrade')

  6. EXECUTE Tier 1 (local):
     - Run all Tier 1 guardrails in PARALLEL
     - For each: evaluate CEL expression with injected context variables
     - Merge results by priority
     - If any violation with action=block: return immediately (skip Tier 2/3)
     - If any violation with action=fix: apply fix, continue with modified content
     - If any violation with action=reask: mark for reask after all tiers

  7. EXECUTE Tier 2 (model):
     - Check circuit breaker for each provider
     - Run all Tier 2 guardrails in PARALLEL (one call per provider)
     - For each: call provider.evaluate(), compare score to threshold
     - Apply severity_actions if defined (low→warn, medium→reask, high→block)
     - Merge results by priority + severity
     - Track cost per provider
     - If any violation with action=block: return immediately (skip Tier 3)

  8. EXECUTE Tier 3 (LLM):
     - Run all Tier 3 guardrails in PARALLEL
     - For each: construct evaluation prompt, call LLM, parse score
     - Include constitution principles in evaluation prompt
     - Compare score to threshold
     - Merge results by priority + severity

  9. AGGREGATE results:
     - Collect all violations across tiers
     - Sort by priority (lowest = highest priority)
     - Calculate compound FPR estimate
     - Cache results (for stateless checks only)
     - Fire webhook (async, non-blocking) for any violations
     - Emit trace events
     - Return GuardrailPipelineResult
```

---

## 8. Provider Interface

### 8.1 Core Interface

```typescript
interface GuardrailModelProvider {
  /** Provider identifier */
  readonly name: string;

  /** Evaluate content against a safety category */
  evaluate(request: GuardrailEvalRequest): Promise<GuardrailEvalResult>;

  /** Check provider health / availability */
  isAvailable(): Promise<boolean>;

  /** Estimated cost per evaluation in USD */
  readonly costPerEvalUsd: number;
}

interface GuardrailEvalRequest {
  /** Text content to evaluate */
  content: string;

  /** Safety category to check */
  category: string;

  /** Optional conversation context (for contextual models) */
  context?: {
    systemPrompt?: string;
    recentMessages?: Array<{ role: string; content: string }>;
    retrievedDocuments?: Array<{ content: string; source: string }>;
  };

  /** Custom taxonomy/categories (for taxonomy-as-prompt models) */
  customTaxonomy?: string[];
}

interface GuardrailEvalResult {
  /** Safety score: 0.0 (safe) to 1.0 (unsafe) */
  score: number;

  /** Severity classification */
  severity: SeverityLevel;

  /** Safety category evaluated */
  category: string;

  /** Specific violation label (e.g., "harassment", "self_harm") */
  label?: string;

  /** Model's reasoning/explanation */
  explanation?: string;

  /** Evaluation latency */
  latencyMs: number;

  /** Provider-specific raw response (for debugging) */
  raw?: unknown;
}
```

### 8.2 Built-in Provider Adapters

**Open-Source Model Adapters** (self-hosted):

| Adapter                        | Target                                       | Input Format                                     | Output Format                              |
| ------------------------------ | -------------------------------------------- | ------------------------------------------------ | ------------------------------------------ |
| `OpenAICompatibleProvider`     | vLLM, TGI, Ollama, any OpenAI-compatible API | Chat completion with taxonomy prompt             | Parse `safe`/`unsafe` + categories + score |
| `HuggingFaceInferenceProvider` | HuggingFace Inference API                    | Text classification endpoint                     | Score from classification logits           |
| `GraniteGuardianProvider`      | Granite Guardian via vLLM                    | Safety instruction template with risk definition | Parse `Yes`/`No` + probability score       |
| `BuiltinPIIProvider`           | Internal `pii-detector.ts`                   | Raw text                                         | `containsPII()` result as binary score     |

**Commercial API Adapters** (cloud-hosted):

| Adapter                    | Target                                                  | Input Format                             | Output Format                                            |
| -------------------------- | ------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------- |
| `OpenAIModerationProvider` | OpenAI Moderation API (`/v1/moderations`)               | Text or image content                    | Per-category boolean flags + scores (0.0-1.0)            |
| `AnthropicProvider`        | Claude API                                              | System prompt with evaluation criteria   | Structured JSON with score + explanation                 |
| `GoogleCloudProvider`      | Google Checks Guardrails API + Text Moderation          | Text content with policy config          | Per-policy verdicts with confidence scores               |
| `VertexAIProvider`         | Vertex AI Model Garden (VirtueGuard, ShieldGemma, etc.) | Model-specific via Vertex AI Predict API | Model-specific output, normalized to score               |
| `LakeraProvider`           | Lakera Guard API (`/v2/guard`)                          | Text content with defense config         | Flagged categories + scores                              |
| `AporiaProvider`           | Aporia Guardrails API                                   | Text with activated policies             | Per-policy verdicts with block/override/rephrase actions |

**Managed Service Adapters** (fully managed infrastructure):

| Adapter                      | Target                  | Input Format                                          | Output Format                                        |
| ---------------------------- | ----------------------- | ----------------------------------------------------- | ---------------------------------------------------- |
| `BedrockProvider`            | AWS Bedrock Guardrails  | `ApplyGuardrail` SDK call with content + guardrail ID | Per-assessment outputs with action (NONE/BLOCKED)    |
| `AzureContentSafetyProvider` | Azure AI Content Safety | `POST /contentsafety/text:analyze` with categories    | Per-category severity (0-6) + boolean blocklistMatch |

**Extensible Adapter** (any API):

| Adapter              | Target                                              | Input Format                                 | Output Format                              |
| -------------------- | --------------------------------------------------- | -------------------------------------------- | ------------------------------------------ |
| `CustomHTTPProvider` | Any HTTP API (F5, Robust Intelligence, proprietary) | Configurable via Handlebars request template | Configurable via JSONPath response mapping |

### 8.3 Provider Registry

```typescript
class GuardrailProviderRegistry {
  private providers: Map<string, GuardrailModelProvider> = new Map();

  /**
   * Initialize registry for a tenant+project context.
   * Loads tenant-level providers, applies project overrides,
   * adds built-in providers.
   */
  async initialize(tenantId: string, projectId?: string): Promise<void>;

  /** Register a provider adapter (used internally during init) */
  register(name: string, provider: GuardrailModelProvider): void;

  /** Get provider by name */
  get(name: string): GuardrailModelProvider | undefined;

  /** List all available providers for this context */
  list(): Array<{ name: string; hosting: string; isActive: boolean }>;

  /** Health check all active providers */
  healthCheck(): Promise<Map<string, { status: string; latencyMs: number }>>;

  /** Create provider adapter from config (factory method) */
  private createAdapter(config: TenantGuardrailProviderConfig): GuardrailModelProvider;
}
```

**Initialization flow:**

1. Load all `TenantGuardrailProviderConfig` for the tenant (cached in Redis, TTL 5 min)
2. If project specified, load project's `GuardrailPolicy.providerOverrides` and merge
3. For each active provider config, create the appropriate adapter based on `adapterType`
4. Auto-register `builtin_pii` (always available, no external dependency)
5. Cache the initialized registry per `tenantId:projectId` (in-memory, TTL matches Redis)

**Adapter factory** creates the right adapter based on `adapterType`:

| `adapterType`           | Adapter Class                  | Endpoint Pattern                                                                                                     |
| ----------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `openai_compatible`     | `OpenAICompatibleProvider`     | `POST /v1/chat/completions` — works with vLLM, TGI, Ollama, and any OpenAI-compatible API                            |
| `openai_moderation`     | `OpenAIModerationProvider`     | `POST /v1/moderations` — OpenAI's free moderation endpoint, returns per-category scores                              |
| `huggingface_inference` | `HuggingFaceInferenceProvider` | `POST /models/{model}` — HuggingFace serverless or dedicated inference                                               |
| `anthropic`             | `AnthropicProvider`            | `POST /v1/messages` — Claude with structured safety evaluation prompt                                                |
| `google_cloud`          | `GoogleCloudProvider`          | Google Checks Guardrails API + Text Moderation Service                                                               |
| `vertex_ai`             | `VertexAIProvider`             | Vertex AI Model Garden — supports VirtueGuard, ShieldGemma, and any deployed model                                   |
| `bedrock`               | `BedrockProvider`              | AWS SDK `ApplyGuardrail` — native Bedrock guardrail invocation                                                       |
| `azure_content_safety`  | `AzureContentSafetyProvider`   | `POST /contentsafety/text:analyze` — severity 0-6, custom categories                                                 |
| `lakera`                | `LakeraProvider`               | `POST /v2/guard` — Lakera Guard API for prompt injection, data leakage, toxicity                                     |
| `aporia`                | `AporiaProvider`               | Aporia Guardrails API — 20+ pre-configured policies with block/override/rephrase                                     |
| `custom_http`           | `CustomHTTPProvider`           | Configurable request/response mapping via Handlebars templates — for F5, Robust Intelligence, or any proprietary API |

---

## 9. CEL Functions

### 9.1 New Guardrail-Specific Functions

Added to `packages/compiler/src/platform/constructs/cel-functions.ts`:

````typescript
// ── PII Functions (wrapping pii-detector.ts) ──
abl.contains_pii(text: string): boolean
  // Wraps containsPII() from pii-detector.ts

abl.detect_pii(text: string): { hasPII: boolean, types: string[] }
  // Wraps detectPII(), returns detection types

abl.redact_pii(text: string): string
  // Wraps redactPII(), returns redacted text

// ── Pattern Matching ──
abl.matches_pattern(text: string, regex: string): boolean
  // Safe regex evaluation with 100ms timeout
  // Prevents ReDoS via timeout

abl.not_matches_pattern(text: string, regex: string): boolean
  // Negation of matches_pattern

// ── Text Analysis ──
abl.word_count(text: string): number
  // Split by whitespace, count tokens

abl.sentence_count(text: string): number
  // Split by sentence terminators (.!?)

abl.contains_url(text: string): boolean
  // Detect URLs (http/https/www patterns)

abl.contains_code(text: string): boolean
  // Detect code blocks (``` markers, common language keywords)

abl.contains_email(text: string): boolean
  // Detect email addresses

abl.language_detect(text: string): string
  // Basic heuristic language detection, returns ISO 639-1 code
````

### 9.2 Context Variables Auto-Injected

The pipeline auto-injects these variables into the CEL evaluation context:

| Variable             | Available For                   | Description                   |
| -------------------- | ------------------------------- | ----------------------------- |
| `input`              | `kind: input`                   | The user's message            |
| `output`             | `kind: output`                  | The LLM's response            |
| `tool_name`          | `kind: tool_input, tool_output` | Name of the tool being called |
| `tool_parameters`    | `kind: tool_input`              | Tool call parameters (JSON)   |
| `tool_result`        | `kind: tool_output`             | Tool execution result (JSON)  |
| `handoff_context`    | `kind: handoff`                 | Context being transferred     |
| `source_agent`       | `kind: handoff`                 | Agent initiating handoff      |
| `target_agent`       | `kind: handoff`                 | Agent receiving handoff       |
| `handoff_reason`     | `kind: handoff`                 | Reason for handoff            |
| `source_agent_role`  | `kind: handoff`                 | Role of source agent          |
| `session_turn_count` | All kinds                       | Number of turns in session    |
| `agent_goal`         | All kinds                       | Agent's declared goal from IR |

All existing session values (`session.data.values`) remain available for backward compatibility.

---

## 10. Action Semantics

### 10.1 Action Types

| Action         | Terminal?   | Behavior                                                                                                                                               |
| -------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`block`**    | Yes         | Reject content. Return error message. Stop processing.                                                                                                 |
| **`warn`**     | No          | Log warning trace event + webhook. Continue execution. Content delivered with warning metadata.                                                        |
| **`redact`**   | No          | Replace sensitive content (PII → `[REDACTED_EMAIL]`). Continue with modified content.                                                                  |
| **`fix`**      | No          | Automatically fix the violation (truncate, strip HTML, normalize). Continue with modified content. No user-visible interruption.                       |
| **`reask`**    | Conditional | Send LLM a correction prompt: "Your response violated {guardrail}. Regenerate." Retry up to `maxReasks` (default: 2). If retries exhausted → escalate. |
| **`filter`**   | No          | Remove violating portions (strip unsafe sentences/paragraphs). Deliver remaining content. If nothing remains → block.                                  |
| **`escalate`** | Yes         | Route to human agent. Session marked escalated. Message queued for human review.                                                                       |

### 10.2 Graduated Response Chain

When multiple actions could apply, the pipeline follows a graduated chain:

```
fix (silent repair) → reask (ask LLM to retry) → filter (remove bad parts) → block (hard stop)
```

The `severity_actions` field on a guardrail enables automatic graduation:

```yaml
- name: content_safety
  provider: qwen3guard
  severity_actions:
    low: warn # Severity low → just log it
    medium: reask # Severity medium → ask LLM to retry
    high: block # Severity high → hard block
    critical: escalate # Severity critical → human handoff
```

### 10.3 Input vs Output Behavior

| Action     | Input Guardrail                                 | Output Guardrail                                 |
| ---------- | ----------------------------------------------- | ------------------------------------------------ |
| `block`    | Message not sent to LLM; error returned to user | Response not delivered; error returned to user   |
| `warn`     | Trace + webhook; LLM call proceeds              | Trace + webhook; response delivered with warning |
| `redact`   | PII redacted from input before LLM sees it      | PII redacted from response before user sees it   |
| `fix`      | Input auto-corrected before LLM                 | Response auto-corrected before delivery          |
| `reask`    | N/A (doesn't apply to input)                    | LLM asked to regenerate                          |
| `filter`   | Violating portions stripped from input          | Violating portions stripped from response        |
| `escalate` | Session escalated, input queued for human       | Session escalated, response held                 |

---

## 11. Severity Levels

Inspired by Qwen3Guard's 3-tier system and BingoGuard's severity prediction (ICLR 2025).

### 11.1 Scale

| Level      | Score Range | Meaning                                       | Typical Action |
| ---------- | ----------- | --------------------------------------------- | -------------- |
| `safe`     | 0.0 - 0.2   | No safety concern                             | pass           |
| `low`      | 0.2 - 0.4   | Minor concern, context-dependent              | warn           |
| `medium`   | 0.4 - 0.6   | Moderate concern, likely problematic          | reask / fix    |
| `high`     | 0.6 - 0.8   | Clear violation                               | block          |
| `critical` | 0.8 - 1.0   | Severe violation, potential legal/safety risk | escalate       |

### 11.2 Mapping

For Tier 1 (local CEL checks), severity is binary: `safe` if check passes, `high` if check fails (CEL expressions don't produce scores).

For Tier 2/3 (model/LLM checks), the provider returns a continuous score. Severity is mapped from the score using the ranges above.

The `severityActions` field on a guardrail allows different actions per severity level, enabling graduated responses from a single guardrail definition.

---

## 12. Tool Rails

### 12.1 Execution Points

Tool rails fire in the tool execution loop, wrapping every tool call:

```
Agent decides to call tool
  ↓
TOOL_INPUT guardrails
  - Evaluate tool name, parameters
  - Can block dangerous tools
  - Can redact PII from parameters
  ↓ (pass)
Tool executes
  ↓
TOOL_OUTPUT guardrails
  - Evaluate tool result
  - Can redact PII from results
  - Can filter sensitive data before LLM sees it
  ↓ (pass)
Result passed to LLM
```

### 12.2 Context Variables

```typescript
// Available in tool_input guardrails
{
  tool_name: string,          // "search_hotels", "send_email"
  tool_parameters: object,    // Full parameter object
  session_turn_count: number,
}

// Available in tool_output guardrails
{
  tool_name: string,
  tool_result: object,        // Full result object
  tool_success: boolean,      // Whether tool returned success
  tool_duration_ms: number,
}
```

### 12.3 Use Cases

| Guardrail               | Kind          | Check                                                     | Action |
| ----------------------- | ------------- | --------------------------------------------------------- | ------ |
| Block destructive tools | `tool_input`  | `tool_name in ["delete_account", "drop_table"]`           | block  |
| PII in tool params      | `tool_input`  | `abl.contains_pii(abl.to_string(tool_parameters))`        | redact |
| PII in tool results     | `tool_output` | `abl.contains_pii(abl.to_string(tool_result))`            | redact |
| Tool result size        | `tool_output` | `abl.length(abl.to_string(tool_result)) > 50000`          | filter |
| Sensitive tool auth     | `tool_input`  | `tool_name == "transfer_funds" && session_turn_count < 3` | block  |

---

## 13. RAG-Specific Guardrails

Based on Granite Guardian's 3-dimensional RAG evaluation and AWS Bedrock's contextual grounding.

### 13.1 Three RAG Dimensions

| Dimension             | What It Checks                                          | When                             |
| --------------------- | ------------------------------------------------------- | -------------------------------- |
| **Context Relevance** | Are retrieved documents relevant to the user's query?   | After retrieval, before LLM call |
| **Groundedness**      | Is the LLM response supported by the retrieved context? | After LLM response               |
| **Answer Relevance**  | Does the response actually address the user's question? | After LLM response               |

### 13.2 DSL Example

```yaml
GUARDRAILS:
  - name: context_relevance
    kind: tool_output # Fires after retrieval tool returns
    provider: granite_guardian
    category: context_relevance
    threshold: 0.6
    action: warn
    message: 'Retrieved documents may not be relevant'

  - name: groundedness
    kind: output
    provider: granite_guardian
    category: groundedness
    threshold: 0.7
    action: reask
    message: 'Response contains claims not supported by context'

  - name: answer_relevance
    kind: output
    provider: granite_guardian
    category: answer_relevance
    threshold: 0.6
    action: warn
    message: "Response may not address the user's question"
```

### 13.3 Context Passing

RAG guardrails need the retrieved documents as context. The pipeline passes these via `GuardrailContext.retrievedDocuments`:

```typescript
// After retrieval tool executes, store docs on session
session.lastRetrievedDocs = toolResult.documents;

// Output guardrails receive them
const outputResult = await pipeline.execute(session, llmResponse, 'output', {
  retrievedDocuments: session.lastRetrievedDocs,
});
```

The `GuardrailModelProvider.evaluate()` method receives these in `request.context.retrievedDocuments`.

---

## 14. Multi-Agent Handoff Guardrails

Novel to ABL — no existing framework addresses guardrails across agent boundaries.

### 14.1 Execution Point

Handoff guardrails fire in the `HandoffExecutor` when an agent routes to another agent:

```
Source agent decides to hand off
  ↓
HANDOFF guardrails
  - Evaluate handoff context, source/target agents
  - Can redact PII from context being transferred
  - Can block unauthorized handoffs
  - Can validate handoff reasons
  ↓ (pass)
Target agent receives context
```

### 14.2 Context Variables

```typescript
{
  source_agent: string,           // "booking_agent"
  target_agent: string,           // "support_agent"
  source_agent_role: string,      // "supervisor" | "peer" | "subordinate"
  handoff_context: string,        // Context being transferred
  handoff_reason: string,         // Reason for handoff
  session_turn_count: number,
}
```

### 14.3 Use Cases

| Guardrail                                 | Check                                | Action |
| ----------------------------------------- | ------------------------------------ | ------ |
| Strip PII from handoff context            | `abl.contains_pii(handoff_context)`  | redact |
| Context size limit                        | `abl.length(handoff_context) > 5000` | filter |
| Authorization (only supervisors escalate) | `source_agent_role != "supervisor"`  | block  |
| No circular handoffs                      | `target_agent == source_agent`       | block  |
| Require handoff reason                    | `abl.length(handoff_reason) < 5`     | block  |

---

## 15. Streaming Guardrails

Based on Qwen3Guard's Stream variant and NeMo v0.9+ streaming rails.

### 15.1 Architecture

```
LLM generates tokens via SSE stream
  ↓
┌─────────────────────────────────────────┐
│  StreamingGuardrailEvaluator             │
│                                          │
│  Token buffer: "The customer's SSN is"   │
│                                          │
│  On sentence boundary:                   │
│    → Run Tier 1 checks (< 1ms)          │
│    → If violation + earlyTermination:    │
│        kill stream, replace with message │
│    → If violation + !earlyTermination:   │
│        log warning, continue             │
│                                          │
│  On chunk_size threshold (50 tokens):    │
│    → Run Tier 2 model check (async)      │
│    → Buffer tokens while waiting         │
│    → If violation: terminate or warn     │
└─────────────────────────────────────────┘
  ↓
Tokens delivered to client
```

### 15.2 Interface

```typescript
interface StreamingGuardrailEvaluator {
  /** Called with accumulated tokens at configurable intervals */
  evaluateChunk(
    accumulated: string,
    latestChunk: string,
    config: StreamingGuardrailConfig,
  ): Promise<StreamingVerdict>;

  /** Final evaluation after stream completes */
  evaluateFinal(
    fullResponse: string,
    config: StreamingGuardrailConfig,
  ): Promise<GuardrailPipelineResult>;
}

interface StreamingGuardrailConfig {
  /** Evaluation trigger */
  evaluationInterval: 'token' | 'sentence' | 'chunk_size';

  /** For chunk_size: evaluate every N tokens */
  chunkSize: number;

  /** Max time for mid-stream check */
  maxLatencyMs: number;

  /** Kill stream on violation */
  earlyTermination: boolean;

  /** Which guardrails to evaluate mid-stream (Tier 1 only for speed) */
  streamingGuardrails: Guardrail[];
}

interface StreamingVerdict {
  /** continue: deliver tokens; terminate: kill stream; buffer: hold tokens */
  action: 'continue' | 'terminate' | 'buffer';

  /** If terminated: violation details */
  violation?: GuardrailViolation;

  /** If terminated: replacement message */
  replacementMessage?: string;
}
```

### 15.3 Tier Restrictions for Streaming

| Tier           | Mid-Stream                                      | Post-Stream                    |
| -------------- | ----------------------------------------------- | ------------------------------ |
| Tier 1 (local) | Yes — fast enough for token-level               | Yes                            |
| Tier 2 (model) | Sentence boundaries only — async with buffering | Yes                            |
| Tier 3 (LLM)   | No — too slow for mid-stream                    | Yes (full response evaluation) |

---

## 16. Semantic Caching

### 16.1 Architecture

```
Content arrives for guardrail check
  ↓
┌─────────────────────────────────────┐
│  1. Exact Match Cache (Redis)        │
│  Key: guardrail:{tenantId}:{name}:   │
│       {sha256(content)}              │
│  TTL: configurable per guardrail     │
│  → Hit? Return cached verdict        │
└──────────┬──────────────────────────┘
           ↓ miss
┌─────────────────────────────────────┐
│  2. Semantic Cache (optional)        │
│  Embedding: BGE-M3 (existing svc)   │
│  Similarity: cosine > 0.95          │
│  Store: Redis sorted set by sim     │
│  → Hit? Return cached verdict        │
│  → Quality control: never cache      │
│    reask/fix results or context-     │
│    dependent checks                  │
└──────────┬──────────────────────────┘
           ↓ miss
┌─────────────────────────────────────┐
│  3. Run Pipeline                     │
│  → Store result in both caches       │
└─────────────────────────────────────┘
```

### 16.2 Cacheable vs Non-Cacheable

| Cacheable                                           | Not Cacheable                                 |
| --------------------------------------------------- | --------------------------------------------- |
| PII detection (stateless, deterministic)            | LLM-based checks (context-dependent)          |
| Content safety model (deterministic for same input) | Groundedness (depends on retrieved docs)      |
| Pattern matching (deterministic)                    | Constitution checks (depends on conversation) |
| Length checks (deterministic)                       | Handoff checks (depends on agent state)       |

### 16.3 Cache Key Design

```
Exact: guardrail:{tenantId}:{guardrailName}:{sha256(content)}
Semantic: guardrail:semantic:{tenantId}:{guardrailName}:{embeddingVector}
```

TTL defaults:

- PII checks: 24 hours (patterns don't change)
- Content safety model: 1 hour (model may be updated)
- Pattern matching: 24 hours
- LLM-based: no caching

---

## 17. Constitution-as-Policy

Based on Anthropic's Constitutional Classifiers.

### 17.1 Data Model

```typescript
interface ConstitutionPrinciple {
  /** Natural language principle */
  text: string;

  /** Optional category tag */
  category?: string;

  /** Severity when violated */
  severity: SeverityLevel;

  /** Default action on violation */
  action: string;

  /** Auto-generated CEL rule (admin can review and promote to Tier 1) */
  compiledRule?: string;

  /** Whether this principle is active */
  isActive: boolean;
}
```

### 17.2 Example

Admin enters in the project guardrails UI:

```
1. "Never help with creating weapons or explosives"
2. "Always protect customer financial data"
3. "Responses must be in the same language as the user's query"
4. "Do not discuss competitors by name"
5. "Never provide medical advice or diagnoses"
```

### 17.3 Execution

Constitution principles are evaluated as Tier 3 (LLM-based) guardrails:

```
System: You are a safety evaluator. Evaluate the following response against these principles:

1. Never help with creating weapons or explosives
2. Always protect customer financial data
3. Responses must be in the same language as the user's query
4. Do not discuss competitors by name
5. Never provide medical advice or diagnoses

User message: {input}
Agent response: {output}

For each principle, score 0.0 (no violation) to 1.0 (clear violation).
Return JSON: { "violations": [{ "principle": 1, "score": 0.9, "explanation": "..." }] }
```

### 17.4 Promotion to Tier 1

When a constitution principle can be expressed as a CEL rule, the system suggests a `compiledRule`:

```
Principle: "Responses must be under 500 words"
Suggested CEL: abl.word_count(output) <= 500
```

Admin can review the suggestion, edit it, and promote it to a Tier 1 guardrail for faster evaluation. The constitution principle remains as a fallback for nuanced cases the CEL rule can't catch.

---

## 18. Circuit Breakers

### 18.1 State Machine

```
CLOSED (normal) ──[failure]──→ count++
       ↑                           │
       │                   count >= threshold?
       │                           │
       │                     yes   ↓
  [success]              OPEN (blocking/passing)
       │                           │
       ↑                   resetTimeout expires
       │                           │
       └──────────── HALF-OPEN ←───┘
                    (try one request)
                           │
                   success? → CLOSED
                   failure? → OPEN
```

### 18.2 Configuration

```typescript
interface CircuitBreakerConfig {
  /** Consecutive failures before opening circuit */
  failureThreshold: number; // Default: 5

  /** ms before trying again (half-open state) */
  resetTimeoutMs: number; // Default: 30000

  /** When circuit is open */
  failMode: 'open' | 'closed';
  // 'closed' = block content (fail-closed, safe default for safety checks)
  // 'open' = pass content through (fail-open, for quality/relevance checks)
}
```

### 18.3 Redis-Backed State

Circuit breaker state stored in Redis (distributed across pods):

```
Key: circuit:{tenantId}:{providerName}
Value: { state: 'closed'|'open'|'half-open', failures: number, lastFailure: timestamp }
TTL: resetTimeoutMs (auto-transitions from open to half-open on expiry)
```

### 18.4 Defaults

| Check Type      | Fail Mode        | Rationale                                                |
| --------------- | ---------------- | -------------------------------------------------------- |
| Content safety  | `closed` (block) | Safety-critical — if unsure, block                       |
| PII detection   | `closed` (block) | Compliance-critical — if unsure, block                   |
| Groundedness    | `open` (pass)    | Quality check — prefer delivering response over blocking |
| On-topic        | `open` (pass)    | Quality check — prefer delivering over blocking          |
| Tool validation | `closed` (block) | Security-critical — if unsure, don't execute tool        |

---

## 19. Cost-Aware Guardrail Selection

### 19.1 Budget Model

```typescript
interface GuardrailBudget {
  /** Monthly limit in USD */
  monthlyLimitUsd: number;

  /** Current month's spend (updated in real-time) */
  currentSpendUsd: number;

  /** What to do when budget is exceeded */
  overspendAction: 'downgrade' | 'disable_model_checks' | 'alert_only';
}
```

### 19.2 Behavior

| Budget State                             | Behavior                                               |
| ---------------------------------------- | ------------------------------------------------------ |
| < 80% consumed                           | Normal operation                                       |
| 80-100% consumed                         | Alert via webhook                                      |
| > 100% consumed (`downgrade`)            | Skip Tier 2/3, only run Tier 1 (CEL checks still free) |
| > 100% consumed (`disable_model_checks`) | Skip Tier 2 only, keep Tier 1 + Tier 3                 |
| > 100% consumed (`alert_only`)           | Continue all tiers, keep alerting                      |

### 19.3 Cost Tracking

Each `GuardrailModelProvider` declares `costPerEvalUsd`. The pipeline accumulates cost per evaluation and updates `currentSpendUsd` in Redis (atomic increment). Monthly reset via cron job.

```
Key: guardrail:cost:{tenantId}:{projectId}:{YYYY-MM}
Value: cumulative cost in USD (float)
```

### 19.4 Trace Event

```typescript
{
  type: 'guardrail_cost',
  provider: string,
  costUsd: number,
  cumulativeMonthUsd: number,
  budgetRemainingUsd: number,
  budgetAction?: 'downgrade' | 'disable_model_checks' | 'alert_only',
}
```

---

## 20. Guardrail Versioning

Based on AWS Bedrock's guardrail versioning model.

### 20.1 Version Lifecycle

```
draft → active → archived
  ↑        │
  └── new version created from active
```

### 20.2 Data Model

```typescript
interface GuardrailPolicy {
  // ... all fields from Section 6.1 ...

  /** Auto-incremented on save */
  version: number;

  /** Link to previous version */
  previousVersionId?: ObjectId;

  /** What changed in this version */
  changelog?: string;

  /** When this version went live */
  deployedAt?: Date;

  /** Version status */
  status: 'draft' | 'active' | 'archived';
}
```

### 20.3 Rules

- Only one version per scope can be `active` at a time
- Creating a new version from `active` → old becomes `archived`, new starts as `draft`
- `draft` → `active` promotion requires explicit admin action (or A/B test completion)
- Rollback: re-activate any `archived` version (current active becomes archived)
- All trace events include `policyVersion` for auditability

---

## 21. A/B Testing

### 21.1 Data Model

```typescript
interface GuardrailABTest {
  enabled: boolean;

  /** Current active policy version */
  controlVersionId: ObjectId;

  /** Candidate policy version to test */
  treatmentVersionId: ObjectId;

  /** Percentage of sessions getting treatment (0.0 - 1.0) */
  trafficSplit: number;

  /** Test start time */
  startedAt: Date;

  /** Test end time (null = ongoing) */
  endedAt?: Date;

  /** Collected metrics */
  metrics: {
    controlSessions: number;
    treatmentSessions: number;
    controlBlockRate: number;
    treatmentBlockRate: number;
    controlFPR: number; // False positive rate (from admin feedback)
    treatmentFPR: number;
    controlAvgLatencyMs: number;
    treatmentAvgLatencyMs: number;
    controlCostUsd: number;
    treatmentCostUsd: number;
  };
}
```

### 21.2 Execution Modes

| Mode                 | Behavior                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Shadow** (default) | Both policies run on treatment sessions. Control verdict is enforced. Treatment verdict is logged only. Measures treatment accuracy without risk. |
| **Split**            | Treatment sessions use treatment policy exclusively. Control sessions use control policy. Real A/B test with actual enforcement differences.      |

### 21.3 Session Assignment

Session assignment is deterministic (hash-based) to ensure consistency:

```typescript
const bucket = murmurhash(sessionId) % 100;
const useTreatment = bucket < trafficSplit * 100;
```

### 21.4 Admin UI

Observatory shows a comparison dashboard:

- Side-by-side metrics (block rate, FPR, latency, cost)
- Per-guardrail comparison
- "Promote treatment" / "Discard treatment" actions

---

## 22. Compound False Positive Rate Management

### 22.1 The Problem

With N independent guardrails each having false positive rate p:

```
Compound FPR = 1 - (1 - p)^N
```

| Guardrails | Individual FPR | Compound FPR |
| ---------- | -------------- | ------------ |
| 3          | 5%             | 14.3%        |
| 5          | 5%             | 22.6%        |
| 5          | 10%            | 40.9%        |
| 10         | 5%             | 40.1%        |

### 22.2 Mitigation Strategies

1. **Tracking**: Pipeline calculates estimated compound FPR from individual guardrail FPRs (initialized from benchmarks, updated from admin feedback).

2. **Warning threshold**: If estimated compound FPR exceeds 20%, warn admin in the UI.

3. **Correlation analysis**: Track which guardrails fire together. Correlated guardrails (e.g., toxicity + content safety) don't contribute independently to compound FPR.

4. **Admin feedback loop**: Admin marks blocked messages as "false positive" in Observatory. This updates the per-guardrail FPR estimate and adjusts compound FPR calculation.

5. **Auto-tuning**: When a guardrail's measured FPR exceeds a threshold, suggest raising its score threshold (e.g., from 0.7 to 0.8) to the admin.

### 22.3 Trace Event

```typescript
{
  type: 'guardrail_pipeline_complete',
  kind: 'input' | 'output',
  totalChecks: number,
  passed: number,
  failed: number,
  warnings: number,
  totalLatencyMs: number,
  compoundFPREstimate: number,  // Estimated compound FPR
  violations: Array<{ name: string; action: string; priority: number }>,
  policyVersion: number,
}
```

---

## 23. Trace Events and Webhooks

### 23.1 Trace Events

| Event Type                    | When                           | Key Fields                                                                                                     |
| ----------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `guardrail_check`             | Every guardrail evaluated      | `tier`, `kind`, `name`, `passed`, `score`, `severity`, `latencyMs`, `provider`, `cached`                       |
| `guardrail_violation`         | Guardrail blocks/warns/redacts | `tier`, `kind`, `name`, `action`, `severity`, `score`, `message`, `priority`, `explanation`                    |
| `guardrail_warning`           | Warn action (non-blocking)     | Same as violation                                                                                              |
| `guardrail_fix`               | Fix action applied             | `name`, `originalContent` (truncated), `fixedContent` (truncated), `fixType`                                   |
| `guardrail_reask`             | Reask action triggered         | `name`, `attempt`, `maxAttempts`, `correctionPrompt`                                                           |
| `guardrail_pipeline_complete` | Pipeline finished              | `kind`, `totalChecks`, `passed`, `failed`, `totalLatencyMs`, `compoundFPREstimate`, `policyVersion`, `costUsd` |
| `guardrail_cost`              | Cost tracked                   | `provider`, `costUsd`, `cumulativeMonthUsd`, `budgetRemainingUsd`                                              |
| `guardrail_circuit_breaker`   | Circuit state change           | `provider`, `state`, `failMode`, `failures`                                                                    |
| `guardrail_cache_hit`         | Cache returned result          | `name`, `cacheType` (`exact` or `semantic`), `similarity`                                                      |

### 23.2 Webhook Payload

Fires asynchronously on any violation (non-blocking). HMAC-signed with `webhookSecret`.

```json
{
  "event": "guardrail_violation",
  "timestamp": "2026-03-01T12:00:00Z",
  "tenantId": "tenant_123",
  "projectId": "project_456",
  "sessionId": "session_789",
  "agentName": "booking_agent",
  "policyVersion": 3,
  "violations": [
    {
      "name": "content_safety",
      "kind": "input",
      "tier": "model",
      "action": "block",
      "severity": "high",
      "score": 0.92,
      "category": "harassment",
      "label": "personal_attack",
      "message": "Content flagged as unsafe",
      "priority": 3,
      "latencyMs": 245,
      "provider": "qwen3guard"
    }
  ],
  "metrics": {
    "totalChecks": 5,
    "totalLatencyMs": 312,
    "costUsd": 0.002
  }
}
```

### 23.3 Webhook Delivery

- HMAC-SHA256 signature in `X-Guardrail-Signature` header
- 3 retries with exponential backoff (1s, 4s, 16s)
- 10-second timeout per delivery attempt
- Dead letter queue after 3 failures (stored in MongoDB for retry)

---

## 24. Admin UI

### 24.0 Tenant Settings > Guardrail Providers (Admin App)

Tenant-level provider management lives in the **Admin app** (port 3003), not in Studio. This is where platform admins configure the inference infrastructure shared across all projects.

```
┌──────────────────────────────────────────────────────────────────┐
│  Tenant Settings > Guardrail Providers                           │
│                                                                   │
│  Model Catalog                              [+ Add Custom]       │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ ★ Recommended Models                                         │ │
│  │                                                               │ │
│  │ [Qwen3Guard 8B]  [Granite Guardian 8B]  [WildGuard 7B]      │ │
│  │ Best overall      Best for RAG          Best generalization   │ │
│  │ 85.3% accuracy    3-dim RAG checks      82.8% accuracy       │ │
│  │ [Quick Setup]     [Quick Setup]         [Quick Setup]         │ │
│  │                                                               │ │
│  │ [Llama Guard 4]   [OpenGuardrails 3.3B] [ShieldGemma 2]     │ │
│  │ Multimodal         Quantized, fast       Image safety         │ │
│  │ [Quick Setup]     [Quick Setup]         [Quick Setup]         │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  Configured Providers                                             │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ Name            Model              Hosting      Status       │ │
│  │ ● builtin_pii   (built-in)         built-in     Always On    │ │
│  │ ● qwen3guard    qwen3guard-8b      self_hosted  ● Healthy    │ │
│  │   Endpoint: https://gpu-01.internal:8000/v1                   │ │
│  │   Runtime: vLLM  GPU: A100  Quant: GPTQ                      │ │
│  │   Latency: P50=89ms P95=142ms  Circuit: Closed ✓             │ │
│  │                                    [Test] [Edit] [Disable]    │ │
│  │ ● granite_gdn   granite-guardian-8b self_hosted  ● Healthy    │ │
│  │   Endpoint: https://gpu-02.internal:8000/v1                   │ │
│  │   Runtime: vLLM  GPU: T4  Quant: AWQ                         │ │
│  │   Latency: P50=112ms P95=198ms  Circuit: Closed ✓            │ │
│  │                                    [Test] [Edit] [Disable]    │ │
│  │ ○ azure_safety   (managed)         managed_svc  ○ Inactive   │ │
│  │   Endpoint: https://eastus.api.cognitive.microsoft.com/...    │ │
│  │                                    [Test] [Edit] [Enable]     │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  Quick Setup: Qwen3Guard 8B                                      │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ Provider Name:  [qwen3guard_____________]                     │ │
│  │ Endpoint URL:   [https://your-vllm-endpoint:8000/v1_______]  │ │
│  │ API Key:        [Select credential...  ▼] or [+ New]         │ │
│  │ Hosting:        ● Self-hosted  ○ Cloud API  ○ Managed         │ │
│  │ Runtime:        [vLLM ▼]  GPU: [A100 ▼]  Quant: [GPTQ ▼]   │ │
│  │                                                               │ │
│  │ Categories (pre-filled):                                      │ │
│  │  ☑ content_safety  ☑ pii  ☑ jailbreak  ☑ violence            │ │
│  │  ☑ sexual  ☑ self_harm  ☑ hate  ☑ copyright                  │ │
│  │                                                               │ │
│  │ Default Threshold: [0.8____]  Cost/eval: [$0.001___]         │ │
│  │ Circuit Breaker:   Failures: [5] Reset: [30s] Mode: [Closed] │ │
│  │                                                               │ │
│  │                          [Test Connection]  [Save Provider]   │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  Usage Across Projects                                            │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ qwen3guard:     Used by 3 projects (booking, support, hr)    │ │
│  │ granite_gdn:    Used by 1 project (support — RAG checks)     │ │
│  │ azure_safety:   Not used (inactive)                           │ │
│  │ builtin_pii:    Used by all 5 projects (auto-enabled)        │ │
│  └──────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

**Key features:**

- **Model catalog** with one-click setup templates for popular open-source models
- **Self-hosted config** captures runtime, GPU type, quantization for observability
- **Health monitoring** with P50/P95 latency and circuit breaker status
- **Credential management** via existing `LLMCredential` collection (encrypted at rest)
- **Usage tracking** shows which projects reference each provider
- **Test connection** button sends a sample safety check and verifies the response format

### 24.1 Project Settings > Guardrails Tab

```
┌──────────────────────────────────────────────────────────────────┐
│  Project Settings > Guardrails                          v3 Active│
│                                                                   │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ Pipeline Settings                                            │ │
│  │ Fail Mode:     ○ Open (pass on timeout)                      │ │
│  │                ● Closed (block on timeout)                    │ │
│  │ Webhook URL:   [https://hooks.example.com/guardrails ____]   │ │
│  │ Monthly Budget: [$500.00_____] Spent: $127.43 (25.5%)        │ │
│  │ Overspend:     ● Downgrade to Tier 1  ○ Alert only           │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  Available Providers (from Tenant)                   [Overrides] │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ Name            Model              Source    Status   Used    │ │
│  │ ● builtin_pii   (built-in)         built-in  Active  ✓ 2 rules│
│  │ ● qwen3guard    qwen3guard-8b      tenant    Active  ✓ 1 rule │
│  │ ● granite_gdn   granite-guardian-8b tenant    Active  ✓ 1 rule │
│  │ ○ azure_safety   (managed)          tenant    Inactive —      │
│  │                                                               │ │
│  │ Project Overrides:                                            │ │
│  │   qwen3guard: threshold overridden to 0.85 (tenant: 0.80)    │ │
│  │                                      [Edit Override] [Reset] │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  Guardrail Rules                                        [+ Add]  │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ P  Name              Kind     Tier   Action    Severity  On  │ │
│  │ 1  pii_protection    both     local  redact    —         ●   │ │
│  │ 1  no_destructive    tool_in  local  block     —         ●   │ │
│  │ 2  input_length      input    local  block     —         ●   │ │
│  │ 3  content_safety    both     model  graduated low→warn  ●   │ │
│  │                                                high→block     │ │
│  │ 5  groundedness      output   model  reask     —         ●   │ │
│  │ 10 on_topic_check    output   llm    warn      —         ●   │ │
│  │                                                               │ │
│  │ Estimated Compound FPR: ~18.2%  ⚠ Consider reducing checks   │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  Constitution                                           [+ Add]  │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ 1. "Never help with creating weapons or explosives"   ● On   │ │
│  │ 2. "Always protect customer financial data"           ● On   │ │
│  │ 3. "Do not discuss competitors by name"               ● On   │ │
│  │    → Suggested CEL: not abl.matches_pattern(output,   [Use]  │ │
│  │      "CompetitorA|CompetitorB")                               │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  Agent Overrides                                                  │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ booking_agent:  +2 rules (domain_check, booking_limit)       │ │
│  │ support_agent:  no overrides                                  │ │
│  │ triage_agent:   no overrides                                  │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  A/B Test                                               [Setup]  │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ Status: Running (v3 control vs v4 treatment, 10% split)      │ │
│  │                    Control (v3)    Treatment (v4)             │ │
│  │ Sessions:          4,521           503                        │ │
│  │ Block Rate:        3.2%            2.8%                       │ │
│  │ Est. FPR:          18.2%           12.1%  ↓                   │ │
│  │ Avg Latency:       142ms           189ms  ↑                   │ │
│  │ Cost:              $98.20          $14.30                      │ │
│  │                               [Promote v4] [Discard v4]       │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  [Test Guardrails]                    [Save as Draft] [Deploy]   │
└──────────────────────────────────────────────────────────────────┘
```

### 24.2 Test Panel

Modal that lets admins test the full pipeline:

```
┌──────────────────────────────────────────────────────────────┐
│  Test Guardrails                                        [×]  │
│                                                              │
│  Test Type:  ● Input  ○ Output  ○ Tool Call  ○ Handoff      │
│                                                              │
│  Sample Text:                                                │
│  ┌──────────────────────────────────────────────────────────┐│
│  │ My SSN is 123-45-6789 and I want to book a hotel       ││
│  └──────────────────────────────────────────────────────────┘│
│                                                              │
│  [Run Test]                                                  │
│                                                              │
│  Results:                                                    │
│  ┌──────────────────────────────────────────────────────────┐│
│  │ ✓ input_length      local   PASS    0.1ms               ││
│  │ ✗ pii_protection    local   FAIL    0.3ms  → redact     ││
│  │   Redacted: "My SSN is [REDACTED_SSN] and I want..."    ││
│  │ ✓ content_safety    model   PASS    142ms  score: 0.12  ││
│  │ — on_topic_check    llm     SKIP    (input guardrail)   ││
│  │                                                          ││
│  │ Overall: PASS (with redaction)  Total: 142ms  Cost: $0.001││
│  └──────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
```

### 24.3 Observatory Integration

The Observatory (existing trace viewer) gains a **Guardrails** tab:

- Timeline view of guardrail checks per session
- Per-guardrail FPR over time (chart)
- Compound FPR trend (chart)
- Recent violations with admin feedback buttons ("False Positive" / "Correct Block")
- Cost breakdown by provider
- Circuit breaker status per provider
- A/B test comparison dashboard

---

## 25. Migration from Current Implementation

### 25.1 Backward Compatibility

The existing `GUARDRAILS:` DSL syntax is a subset of the new syntax. All existing guardrail definitions will continue to work:

| Existing Field                       | New Behavior                                         |
| ------------------------------------ | ---------------------------------------------------- |
| `name`                               | Unchanged                                            |
| `kind: input/output/both`            | Now respected at runtime (was ignored)               |
| `check`                              | Unchanged (CEL expression, Tier 1)                   |
| `action: block/warn/redact/escalate` | `warn` now works correctly (was broken)              |
| `message`                            | Unchanged                                            |
| `priority`                           | Now respected (sorted before execution, was ignored) |

### 25.2 Migration Steps

1. **Fix existing bugs first**: Map `warn` action correctly, preserve `kind` and `priority` in IR
2. **Wire PII detector**: Add `abl.contains_pii()` etc. to CEL functions
3. **Inject context variables**: Auto-inject `input`, `output`, etc. into CEL context
4. **Add pipeline**: New `GuardrailPipeline` wraps existing `checkConstraintsCore()` for Tier 1
5. **Add policy model**: New MongoDB collection, admin API, resolution logic
6. **Add providers**: `GuardrailModelProvider` interface + built-in adapters
7. **Add admin UI**: Project settings guardrails tab
8. **Add streaming**: `StreamingGuardrailEvaluator` integration
9. **Add advanced features**: Caching, circuit breakers, versioning, A/B testing, constitution

### 25.3 Phased Rollout

| Phase       | Scope    | Features                                                                                       |
| ----------- | -------- | ---------------------------------------------------------------------------------------------- |
| **Phase 1** | Fix gaps | Kind/priority enforcement, warn action, PII wiring, context variables, new CEL functions       |
| **Phase 2** | Pipeline | GuardrailPipeline, tiered execution, provider interface, tool rails, handoff rails             |
| **Phase 3** | Policy   | MongoDB policy model, project-level config, admin UI, versioning                               |
| **Phase 4** | Models   | Provider adapters, Qwen3Guard/Granite Guardian integration, severity levels, graduated actions |
| **Phase 5** | Advanced | Streaming, caching, circuit breakers, cost tracking, A/B testing, constitution, FPR management |

---

## 26. References

### Frameworks

- [NVIDIA NeMo Guardrails](https://github.com/NVIDIA-NeMo/Guardrails) — 5-stage pipeline, Colang DSL
- [Guardrails AI](https://github.com/guardrails-ai/guardrails) — Validator pattern, graduated OnFail actions
- [OpenGuardrails](https://arxiv.org/html/2510.19169v2) — Per-request policy, configurable thresholds, quantized models
- [LangChain Agent Middleware](https://blog.langchain.com/agent-middleware/) — 6-hook interception model
- [AWS Bedrock Guardrails](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails.html) — Parallel evaluation, versioning, grounding
- [Azure AI Content Safety](https://learn.microsoft.com/en-us/azure/ai-services/content-safety/overview) — Severity levels, task adherence

### Guardrail Models (Open Source)

- [Qwen3Guard](https://arxiv.org/html/2510.14276v1) — 3-tier severity, streaming variant, 119 languages
- [Granite Guardian](https://arxiv.org/html/2412.07724v1) — RAG-specific checks, vLLM serving
- [Llama Guard 4](https://huggingface.co/meta-llama/Llama-Guard-4-12B) — Multimodal, taxonomy-as-prompt
- [LlamaFirewall](https://ai.meta.com/research/publications/llamafirewall-an-open-source-guardrail-system-for-building-secure-ai-agents/) — Meta's modular guardrail framework (PromptGuard 2, AlignmentCheck, CodeShield)
- [ShieldGemma 2](https://arxiv.org/abs/2504.01081) — Image safety classification
- [WildGuard](https://huggingface.co/datasets/allenai/wildguardmix) — Strong generalization, 82.8% accuracy

### Commercial Providers

- [Virtue AI (VirtueGuard)](https://www.virtueai.com/) — Sub-10ms latency, multimodal, 12 risk categories, available on Vertex AI Model Garden
- [OpenAI Moderation API](https://platform.openai.com/docs/guides/moderation) — Free, GPT-4o based, multimodal, 40 languages, 95% accuracy
- [Google Checks Guardrails API](https://developers.google.com/checks/guide/ai-safety/guardrails) — Configurable policies, pre-trained harm categories
- [Google Vertex AI Safety](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/gemini-for-filtering-and-moderation) — Gemini as Judge, text moderation service
- [Lakera Guard](https://www.lakera.ai/lakera-guard) — Prompt injection, data leakage, single API call (acquired by Check Point)
- [Aporia Guardrails](https://gr-docs.aporia.com/) — 20+ pre-configured policies, 0.95 F1, 340ms latency
- [F5 AI Guardrails (CalypsoAI)](https://www.f5.com/company/blog/what-are-ai-guardrails) — Enterprise runtime security, adaptive threat protection
- [Robust Intelligence (Cisco)](https://www.techtarget.com/searchSecurity/feature/LLM-firewalls-emerge-as-a-new-AI-security-layer) — AI Firewall, pre-deploy validation + runtime enforcement

### Research

- [BingoGuard (ICLR 2025)](https://proceedings.iclr.cc/paper_files/paper/2025/file/a07e87ecfa8a651d62257571669b0150-Paper-Conference.pdf) — Severity prediction
- [Mozilla AI Guardrail Benchmark](https://blog.mozilla.ai/can-open-source-guardrails-really-protect-ai-agents/) — Tool safety evaluation
- [Anthropic Constitutional Classifiers](https://www.anthropic.com/research/constitutional-classifiers) — NL policy → classifiers

### Production Patterns

- [Portkey Circuit Breakers](https://portkey.ai/blog/retries-fallbacks-and-circuit-breakers-in-llm-apps/)
- [Datadog LLM Guardrails](https://www.datadoghq.com/blog/llm-guardrails-best-practices/)
- [ZenML LLMOps Survey](https://www.zenml.io/blog/what-1200-production-deployments-reveal-about-llmops-in-2025) — A/B testing patterns
- [IBM Guardrails Components](https://research.ibm.com/publications/designing-and-implementing-llm-guardrails-components-in-production-environments) — Microservices architecture

---

## Appendix A: Design Review — Resolved Issues

This appendix documents issues found during design review and their resolutions. Each fix is authoritative and overrides any conflicting statement in the main sections.

---

### A.1 Action Type System (Critical — C1)

**Problem:** The design introduces new action types (`warn`, `fix`, `reask`, `filter`) but the existing `ConstraintAction` type in the IR only supports `respond | escalate | handoff | block | redact | retry_step | goto_step | collect_field`.

**Resolution:** Introduce a new `GuardrailAction` type separate from `ConstraintAction`. Guardrails use `GuardrailAction`; constraints continue using `ConstraintAction`. The IR schema in Section 5 is updated:

```typescript
/** Guardrail-specific action type (separate from ConstraintAction) */
type GuardrailActionType =
  | 'block' // Terminal: reject content, return error message
  | 'warn' // Non-terminal: log + webhook, continue execution
  | 'redact' // Non-terminal: replace sensitive content, continue
  | 'fix' // Non-terminal: auto-fix violation, continue
  | 'reask' // Conditional: ask LLM to regenerate (output only)
  | 'filter' // Non-terminal: remove violating portions, continue
  | 'escalate'; // Terminal: route to human agent

interface GuardrailAction {
  type: GuardrailActionType;
  message?: string;
  reason?: string;
  /** For reask: max retry attempts (default: 2) */
  maxReasks?: number;
  /** For fix: fix strategy */
  fixStrategy?: 'truncate' | 'strip_html' | 'redact_pii' | 'normalize' | 'custom';
  /** For fix with custom strategy: CEL expression that returns fixed content */
  fixExpression?: string;
  /** For filter: minimum content length after filtering (below = block) */
  filterMinLength?: number;
}

interface Guardrail {
  // ... all fields from Section 5 ...
  action: GuardrailAction; // NOT ConstraintAction
  severityActions?: Partial<Record<SeverityLevel, GuardrailAction>>;
}
```

**Migration:** The existing `mapGuardrailAction()` in the compiler is replaced with a new `mapGuardrailAction()` that produces `GuardrailAction` instead of `ConstraintAction`. The runtime's `checkConstraintsCore()` continues to use `ConstraintAction` for flat constraints; the new `GuardrailPipeline` uses `GuardrailAction` for guardrails.

---

### A.2 `both` Kind Expansion (Critical — C2)

**Problem:** `kind: 'both'` exists in the IR but `GuardrailKind` in the pipeline interface excludes it. No specification for how `both` guardrails run.

**Resolution:** `both` is expanded at **compile time** into two guardrail entries:

```typescript
// During compilation, a guardrail with kind: 'both' becomes:
// - One guardrail with kind: 'input' (same check, action, priority)
// - One guardrail with kind: 'output' (same check, action, priority)
//
// The IR stores the expanded form. The DSL 'both' is syntactic sugar.
// The pipeline's GuardrailKind type correctly excludes 'both'.
```

The compiler's `compileGuardrails()` function handles this expansion. The IR `kind` field type changes to `'input' | 'output' | 'tool_input' | 'tool_output' | 'handoff'` (no `both`). The DSL continues to support `both` as syntactic sugar.

---

### A.3 `reask` Validation on Input Guardrails (Critical — C3)

**Problem:** `reask` is meaningless for input guardrails (can't ask the LLM to regenerate a user's message) but nothing prevents its use.

**Resolution:** The **compiler** validates this at compile time:

```
Compile-time validation rules:
- kind: 'input'   → allowed actions: block, warn, redact, fix, filter, escalate
- kind: 'output'  → allowed actions: block, warn, redact, fix, reask, filter, escalate
- kind: 'tool_input'  → allowed actions: block, warn, redact, fix, filter, escalate
- kind: 'tool_output' → allowed actions: block, warn, redact, fix, filter, escalate
- kind: 'handoff'     → allowed actions: block, warn, redact, filter, escalate
```

`reask` is only valid on `output` guardrails. `fix` and `filter` are not valid on `handoff` (can't auto-modify handoff context — too risky). Violations emit `ValidationDiagnostic` at compile time.

---

### A.4 `custom_http` Template Security (Critical — C4)

**Problem:** Handlebars templates from MongoDB are a Server-Side Template Injection (SSTI) risk.

**Resolution:** The `CustomHTTPProvider` applies these security controls:

1. **Handlebars strict mode** (`strict: true`) — prevents access to prototype chain
2. **Disable prototype access** (`allowProtoPropertiesByDefault: false`, `allowProtoMethodsByDefault: false`)
3. **No custom helpers** — only built-in Handlebars block helpers (`#if`, `#each`, `#with`, `#unless`). No `registerHelper()`.
4. **Template size limit** — max 4KB per template. Validated at save time.
5. **SSRF protection** — the `endpoint` URL is validated against a blocklist of private IP ranges (10.x, 172.16-31.x, 192.168.x, 169.254.x, localhost, metadata endpoints) at save time AND at runtime. This matches CLAUDE.md's security requirement.
6. **Template validation at save time** — templates are compiled and validated when the admin saves the provider config, not at first use.
7. **Output sanitization** — response body is size-limited (max 1MB) and parsed in a try/catch. Malformed responses are treated as provider errors.

---

### A.5 Redact Action Mechanics (Critical — C5)

**Problem:** The `redact` action says "replace sensitive content" but never specifies how.

**Resolution:** Redaction is performed differently per tier:

```
Tier 1 (local CEL):
  - If the guardrail's check uses abl.contains_pii() or abl.detect_pii():
    → Pipeline calls abl.redact_pii(content) to produce modifiedContent
  - If the guardrail's check uses abl.matches_pattern():
    → Pipeline replaces matched patterns with [REDACTED]
  - For other CEL checks: redact is treated as block (can't auto-determine what to redact)

Tier 2 (model-based):
  - Model returns score + category + label (e.g., "pii", "email")
  - If category is "pii": pipeline uses builtin PII detector to redact
  - If category is non-PII (e.g., "toxicity"): redact is treated as filter
    (remove sentences with high toxicity score via sentence-level re-evaluation)

Tier 3 (LLM-based):
  - LLM returns score + explanation identifying the violating content
  - Pipeline uses the LLM's explanation to locate and redact specific spans
  - Fallback: if spans can't be identified, treat as block
```

**Multiple modifications:** When multiple guardrails modify content, modifications are applied in **priority order** (lowest priority number first). Each subsequent guardrail evaluates the already-modified content.

---

### A.6 Provider Error Handling (Critical — C6)

**Problem:** Non-timeout errors (4xx, 5xx, malformed responses) not specified.

**Resolution:** Provider errors are classified:

```
Error Classification:
  Transient (count toward circuit breaker):
    - 5xx responses
    - Network errors (ECONNREFUSED, ETIMEDOUT, ECONNRESET)
    - Timeout exceeded
    - Response body too large (> 1MB)

  Permanent (do NOT count toward circuit breaker):
    - 4xx responses (configuration error, not transient)
    - Malformed response (can't parse score)

  Behavior:
    - Transient: retry per retry config, then circuit breaker logic, then failMode
    - Permanent: log error trace event, skip this guardrail for this evaluation,
      do NOT trigger circuit breaker (it's a config issue, not an outage)
    - Both: emit 'guardrail_provider_error' trace event with error details

  Trace event (new):
    {
      type: 'guardrail_provider_error',
      provider: string,
      errorType: 'transient' | 'permanent',
      statusCode?: number,
      error: string,
      guardrailName: string,
      retriesAttempted: number,
      circuitBreakerTriggered: boolean,
    }
```

---

### A.7 Policy Resolution Caching (Critical — C7)

**Problem:** 3+ MongoDB queries per pipeline execution (6-12+ per message) for policy resolution.

**Resolution:** Policies are cached in Redis with a content-addressed key:

```
Cache key: guardrail:policy:{tenantId}:{projectId}:{agentDefId}
Cache value: Merged & resolved GuardrailPolicy (JSON)
TTL: 5 minutes (matches provider config cache)
Invalidation: On policy save via Admin API, delete the cache key(s) for affected scope

Resolution flow per message:
  1. Check Redis cache for merged policy → HIT? Use cached policy (0 MongoDB queries)
  2. MISS? Resolve from MongoDB (3 queries), merge, cache result in Redis
  3. Average case: 0 MongoDB queries per message (5-min TTL covers most sessions)
  4. Worst case (cold start or cache miss): 3 MongoDB queries, amortized over 5 min of traffic
```

Additionally, per suggestion S1: at **deploy time**, the merged policy is compiled into the IR alongside the agent definition. The runtime only falls back to MongoDB resolution if the IR doesn't contain a compiled policy (backward compatibility during migration).

---

### A.8 Reask Retry Tracking (Important — I1)

**Problem:** `maxReasks` is mentioned but never defined in any schema.

**Resolution:** `maxReasks` is defined on `GuardrailAction` (see A.1 above) with default value 2. Tracking:

```typescript
// Per-session, per-guardrail reask counter
// Stored on session state (not in Redis — session-scoped, not distributed)
session.guardrailReaskCounts: Record<string, number>; // guardrailName → count

// Algorithm:
// 1. Output guardrail fires with action: reask
// 2. Increment session.guardrailReaskCounts[guardrailName]
// 3. If count <= maxReasks: send correction prompt to LLM, re-evaluate output
// 4. If count > maxReasks: escalate (terminal)
// 5. On successful reask (guardrail passes): reset counter for that guardrail

// Correction prompt template:
// "Your previous response violated the safety guardrail '{guardrailName}':
//  {violation.message}. Please regenerate your response while avoiding
//  this violation."
```

---

### A.9 Fix Action Specification (Important — I2)

**Problem:** "Automatically fix" is too vague.

**Resolution:** The `fix` action requires a `fixStrategy` (see `GuardrailAction` in A.1):

| Strategy     | Behavior                                                            | Applicable To            |
| ------------ | ------------------------------------------------------------------- | ------------------------ |
| `truncate`   | Truncate content to the length limit from the guardrail's CEL check | Length-based guardrails  |
| `strip_html` | Remove HTML/script tags using DOMPurify-style sanitizer             | Injection guardrails     |
| `redact_pii` | Call `abl.redact_pii()` on the content                              | PII guardrails           |
| `normalize`  | Unicode normalize (NFKC), trim whitespace, collapse newlines        | Format guardrails        |
| `custom`     | Evaluate `fixExpression` (CEL) which returns the fixed string       | Any — author-defined fix |

Example DSL:

```yaml
- name: input_too_long
  kind: input
  check: abl.length(input) > 5000
  action: fix
  fix_strategy: truncate # Truncate to 5000 chars
  message: 'Input truncated to fit length limit'
```

If `fixStrategy` is not specified, the compiler emits a `ValidationDiagnostic` warning. At runtime, missing strategy → fall back to `block`.

---

### A.10 Streaming Partial Delivery (Important — I3)

**Problem:** What happens to content already delivered via SSE when a violation is found mid-stream?

**Resolution:**

```
Scenario: Tokens partially delivered, violation detected mid-stream

If earlyTermination: true:
  1. Send SSE event: { type: 'guardrail_retract', reason: violation.message }
  2. Send SSE event: { type: 'message_replace', content: violation.message }
  3. Close stream
  4. Client is responsible for handling 'guardrail_retract':
     - Replace displayed content with the replacement message
     - Show a visual indicator that content was retracted

If earlyTermination: false:
  1. Continue streaming tokens to client
  2. Send SSE metadata event: { type: 'guardrail_warning', name, severity, message }
  3. After stream completes, evaluateFinal() runs full pipeline
  4. If final check fails with terminal action:
     → Same retract behavior as earlyTermination: true
  5. If final check fails with non-terminal action:
     → Warning metadata appended to response

'buffer' action:
  - Holds tokens for up to maxLatencyMs (from StreamingGuardrailConfig)
  - If model check completes within timeout: deliver or retract
  - If model check times out: deliver buffered tokens (fail-open for streaming)
    and log the timeout
```

---

### A.11 Cost Tracking Precision (Important — I4)

**Problem:** Redis `INCRBYFLOAT` has IEEE 754 precision issues.

**Resolution:** Store costs in **integer microdollars** (1 USD = 1,000,000 microdollars):

```
Redis key: guardrail:cost:{tenantId}:{projectId}:{YYYY-MM}
Redis type: integer (INCRBY, not INCRBYFLOAT)
Value: cumulative cost in microdollars

Example: $0.001 per eval → INCRBY 1000
Monthly budget $500 → 500,000,000 microdollars

The UI converts to dollars for display: currentSpendUsd = value / 1_000_000
```

The `GuardrailPolicy.budget.currentSpendUsd` field in MongoDB is a **periodic snapshot** synced every 5 minutes from Redis (for the admin UI). Redis is the authoritative real-time source. This resolves issue I9 (dual source of truth).

---

### A.12 Semantic Cache Tier Restriction (Important — I5)

**Problem:** Semantic cache embedding generation (50-200ms) is slower than Tier 1 checks (<1ms).

**Resolution:** Caching is tier-aware:

```
Tier 1 (local CEL):
  - Exact match cache ONLY (Redis hash, <1ms lookup)
  - No semantic cache (embedding latency defeats the purpose)
  - TTL: 24 hours (deterministic checks)

Tier 2 (model-based):
  - Exact match cache (first check, <1ms)
  - Semantic cache (second check, only on exact miss, 50-200ms)
  - Net benefit: 50-200ms embedding lookup vs 50-500ms model call
  - TTL: 1 hour

Tier 3 (LLM-based):
  - No caching (context-dependent, non-deterministic)
```

---

### A.13 Multiple Violations with Mixed Actions (Important — I7)

**Problem:** What happens when guardrails return conflicting actions (one warns, another blocks)?

**Resolution:** Action precedence rules:

```
Terminal actions (stop execution):
  escalate > block > reask

Non-terminal actions (continue execution):
  redact > fix > filter > warn

Resolution algorithm:
  1. Collect all violations across all tiers
  2. Separate into terminal and non-terminal violations
  3. If ANY terminal violation exists:
     - primaryViolation = terminal violation with highest priority (lowest number)
     - passed = false
  4. If only non-terminal violations:
     - Apply all modifications in priority order (redact, fix, filter)
     - Collect all warnings
     - passed = true
     - modifiedContent = result of all modifications
     - warnings = all warn violations
  5. Edge case: reask is conditional-terminal
     - If reask succeeds (LLM regenerates without violation): passed = true
     - If reask exhausted: escalate (terminal)
```

---

### A.14 Constitution Principles Batching (Important — I8)

**Problem:** Are constitution principles 1 LLM call or N LLM calls?

**Resolution:** **Single batched LLM call** for all active constitution principles:

```
1. All active constitution principles are bundled into one evaluation prompt
2. The LLM returns per-principle scores in a single JSON response
3. Each principle violation maps to a separate GuardrailViolation with:
   - name: "constitution_{index}" (e.g., "constitution_1")
   - priority: from the principle's configured priority
   - severity: from the principle's configured severity
   - action: from the principle's configured action
4. These violations are merged with other Tier 3 results by priority

This means: 5 principles = 1 LLM call, not 5.
Max principles per batched call: 20 (prompt size constraint).
If > 20 principles: split into multiple batched calls (parallel).
```

---

### A.15 API Response Shape for Violations (Important — I10)

**Problem:** Client-facing response for guardrail violations not specified.

**Resolution:**

```typescript
// REST API response when guardrail blocks
{
  "type": "guardrail_violation",
  "message": "Content flagged as unsafe",  // User-facing message (from guardrail config)
  "guardrail": "content_safety",           // Guardrail name (for client-side handling)
  "action": "block",                       // Action taken
  "severity": "high"                       // Severity level
  // Note: NO score, provider, explanation exposed to end user (security)
}

// WebSocket/SSE event for guardrail block
{
  "event": "guardrail_violation",
  "data": {
    "message": "Content flagged as unsafe",
    "guardrail": "content_safety",
    "action": "block",
    "severity": "high"
  }
}

// WebSocket/SSE event for guardrail warning (non-blocking)
{
  "event": "guardrail_warning",
  "data": {
    "message": "Response may be off-topic",
    "guardrail": "on_topic_check",
    "action": "warn",
    "severity": "low"
  }
}

// Full violation details (score, provider, explanation) are available
// ONLY in trace events (Observatory) — never exposed to end users.
// This prevents information leakage about guardrail configuration.
```

---

### A.16 Multimodal Content (Important — I11)

**Problem:** `GuardrailEvalRequest.content` is `string` only, but several providers handle images/audio/video.

**Resolution:** Extend the eval request with an optional media field:

```typescript
interface GuardrailEvalRequest {
  /** Text content to evaluate */
  content: string;

  /** Optional media attachments for multimodal providers */
  media?: Array<{
    type: 'image' | 'audio' | 'video';
    /** Base64-encoded content or URL */
    data: string;
    /** MIME type */
    mimeType: string;
  }>;

  // ... rest of fields unchanged ...
}
```

**Scope for V1:** Text-only evaluation. The `media` field is defined but providers that require media (ShieldGemma, VirtueGuard multimodal) will return `{ score: 0, severity: 'safe' }` if no media is provided (fail-open for unsupported modalities). Full multimodal guardrail evaluation is **Phase 6** (post V1).

---

### A.17 Minor Fixes Summary

| #   | Issue                                                                 | Fix                                                                                                          |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| M1  | Section 20.2 references "Section 6.1"                                 | Should reference Section 6.2                                                                                 |
| M2  | `SeverityLevel` includes `safe` in `severityActions`                  | Type changed to `Partial<Record<Exclude<SeverityLevel, 'safe'>, GuardrailAction>>`                           |
| M3  | Provider registry Map has no max-size                                 | Bounded to 100 providers per tenant (far beyond realistic usage), LRU eviction on `tenantId:projectId` cache |
| M4  | `tool_success` and `tool_duration_ms` missing from `GuardrailContext` | Added to `GuardrailContext` interface                                                                        |
| M5  | DSL snake_case vs IR camelCase                                        | Documented as compiler transformation (standard pattern)                                                     |
| M6  | `abl.language_detect()` unreliable                                    | Added note: "Heuristic only. For production language matching, use a Tier 2 model provider."                 |
| M7  | `webhookSecret` stored as string, not credential reference            | Changed to `webhookSecretCredentialId?: string` referencing `LLMCredential`                                  |
| M8  | Duplicate `GuardrailPolicy` in Sections 6.2 and 20.2                  | Section 20.2 references Section 6.2 as canonical; only shows version-specific additions                      |

---

### A.18 Performance Budget

Worst-case and target latency analysis:

```
Worst case (all tiers, all cache miss, model timeout):
  Policy resolution:    0ms (Redis cache hit) or 15ms (MongoDB miss)
  Tier 1 (parallel):    < 1ms
  Tier 2 (parallel):    500ms (model timeout)
  Tier 3 (parallel):    2000ms (LLM timeout)
  Total worst case:     ~2500ms per pipeline run
  Per message (input + output): ~5000ms

Target P95 (cached policy, Tier 1 + Tier 2 only):
  Policy resolution:    < 1ms (Redis)
  Tier 1 (parallel):    < 1ms
  Tier 2 (parallel):    150ms (model P95)
  Total target P95:     ~150ms per pipeline run
  Per message (input + output): ~300ms

Optimization strategies:
  1. Most projects will only use Tier 1 + Tier 2 (no LLM checks) → P95 < 300ms
  2. Tier 3 is opt-in and should be gated behind a "premium safety" toggle
  3. Exact cache hits bypass all tiers → < 1ms
  4. warn-only guardrails can run async (suggestion S8) → don't block response
  5. Tool rails add latency per tool call — budget 150ms per tool call
  6. Rate limit: max 10 guardrail model calls per message (configurable)
```

---

### A.19 Additional Suggestions Incorporated

| Suggestion                        | Resolution                                                                                                                                                             |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S2: Rate limiting on model calls  | Added `maxModelCallsPerMessage: number` (default: 10) to policy settings. Enforced via in-memory counter per pipeline execution.                                       |
| S3: Cache interaction with redact | Exact cache stores `{ verdict, modifiedContent? }`. Cache key is hash of **original** content. On hit, both verdict and redacted content are returned.                 |
| S4: Provider error trace event    | Added `guardrail_provider_error` event (see A.6).                                                                                                                      |
| S7: ProjectId in cache keys       | All Redis cache keys now include `projectId`: `guardrail:{tenantId}:{projectId}:{guardrailName}:{hash}`                                                                |
| S8: Async warn-only guardrails    | If remaining guardrails are all `action: warn`, they run asynchronously after the response is delivered. Results are logged as trace events + webhook but don't block. |

---

## Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the ABL guardrails system with tiered execution pipeline, policy engine, provider adapters, and runtime integration — as specified in `docs/plans/2026-03-01-guardrails-system-design.md`.

**Architecture:** Hybrid Layered Pipeline (3-tier: local CEL → model-based → LLM-based) with parallel execution within tiers, graduated failure actions, severity levels, MongoDB policy engine, Redis caching/circuit breakers, and provider-agnostic adapter system.

**Tech Stack:** TypeScript, Vitest, CEL (cel-js), MongoDB/Mongoose, Redis, Handlebars (for custom_http templates)

**Design Doc:** `docs/plans/2026-03-01-guardrails-system-design.md` (26 sections + Appendix A)

---

## Phase Overview

| Phase       | Scope                | Tasks | Key Deliverable                                                                                    |
| ----------- | -------------------- | ----- | -------------------------------------------------------------------------------------------------- |
| **Phase 1** | Fix Existing Gaps    | 1–6   | Kind/priority enforcement, GuardrailAction type, CEL functions, context variables                  |
| **Phase 2** | Pipeline Core        | 7–12  | GuardrailPipeline with Tier 1 evaluator, result aggregation, runtime hooks                         |
| **Phase 3** | Provider System      | 13–18 | Provider interface, adapters (OpenAI-compatible, OpenAI Moderation, custom HTTP), circuit breakers |
| **Phase 4** | Policy Engine        | 19–23 | MongoDB models, policy resolution, Redis caching, Admin API                                        |
| **Phase 5** | Tool & Handoff Rails | 24–26 | Tool input/output guardrails, handoff guardrails, runtime integration                              |
| **Phase 6** | Advanced Features    | 27–32 | Streaming guardrails, cost tracking, semantic caching, A/B testing, constitution                   |

---

## Phase 1: Fix Existing Gaps

### Task 1: GuardrailAction Type System

Introduce a new `GuardrailAction` type separate from `ConstraintAction` (design doc Appendix A.1). The existing `ConstraintAction` stays unchanged for flat constraints. Guardrails get their own action type with `warn`, `fix`, `reask`, `filter` support.

**Files:**

- Create: `packages/compiler/src/platform/ir/guardrail-action.ts`
- Modify: `packages/compiler/src/platform/ir/schema.ts:775-779`
- Test: `packages/compiler/src/__tests__/guardrails/guardrail-action.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/compiler/src/__tests__/guardrails/guardrail-action.test.ts
import { describe, it, expect } from 'vitest';
import type {
  GuardrailActionType,
  GuardrailAction,
  SeverityLevel,
} from '../../platform/ir/guardrail-action';

describe('GuardrailAction type system', () => {
  it('should define all 7 action types', () => {
    const actions: GuardrailActionType[] = [
      'block',
      'warn',
      'redact',
      'fix',
      'reask',
      'filter',
      'escalate',
    ];
    expect(actions).toHaveLength(7);
  });

  it('should define severity levels', () => {
    const levels: SeverityLevel[] = ['safe', 'low', 'medium', 'high', 'critical'];
    expect(levels).toHaveLength(5);
  });

  it('should accept a minimal GuardrailAction', () => {
    const action: GuardrailAction = { type: 'block' };
    expect(action.type).toBe('block');
    expect(action.message).toBeUndefined();
  });

  it('should accept a reask action with maxReasks', () => {
    const action: GuardrailAction = {
      type: 'reask',
      maxReasks: 3,
      message: 'Please rephrase',
    };
    expect(action.maxReasks).toBe(3);
  });

  it('should accept a fix action with strategy', () => {
    const action: GuardrailAction = {
      type: 'fix',
      fixStrategy: 'truncate',
    };
    expect(action.fixStrategy).toBe('truncate');
  });

  it('should accept a fix action with custom strategy and expression', () => {
    const action: GuardrailAction = {
      type: 'fix',
      fixStrategy: 'custom',
      fixExpression: 'abl.replace(input, "bad", "good")',
    };
    expect(action.fixStrategy).toBe('custom');
    expect(action.fixExpression).toBeDefined();
  });

  it('should accept a filter action with min length', () => {
    const action: GuardrailAction = {
      type: 'filter',
      filterMinLength: 10,
    };
    expect(action.filterMinLength).toBe(10);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/compiler && pnpm vitest run src/__tests__/guardrails/guardrail-action.test.ts`
Expected: FAIL — module `../../platform/ir/guardrail-action` not found

**Step 3: Write minimal implementation**

```typescript
// packages/compiler/src/platform/ir/guardrail-action.ts

/**
 * Guardrail-specific action types.
 *
 * Separate from ConstraintAction — guardrails support graduated failure
 * actions (warn, fix, reask, filter) that don't apply to flat constraints.
 *
 * See design doc: docs/plans/2026-03-01-guardrails-system-design.md
 * Appendix A.1 and Section 10.
 */

export type GuardrailActionType =
  | 'block' // Terminal: reject content, return error message
  | 'warn' // Non-terminal: log + webhook, continue execution
  | 'redact' // Non-terminal: replace sensitive content, continue
  | 'fix' // Non-terminal: auto-fix violation, continue
  | 'reask' // Conditional: ask LLM to regenerate (output only)
  | 'filter' // Non-terminal: remove violating portions, continue
  | 'escalate'; // Terminal: route to human agent

export type SeverityLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

export type FixStrategy = 'truncate' | 'strip_html' | 'redact_pii' | 'normalize' | 'custom';

export interface GuardrailAction {
  type: GuardrailActionType;
  message?: string;
  reason?: string;
  /** For reask: max retry attempts (default: 2) */
  maxReasks?: number;
  /** For fix: fix strategy */
  fixStrategy?: FixStrategy;
  /** For fix with custom strategy: CEL expression that returns fixed content */
  fixExpression?: string;
  /** For filter: minimum content length after filtering (below this → block) */
  filterMinLength?: number;
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/compiler && pnpm vitest run src/__tests__/guardrails/guardrail-action.test.ts`
Expected: PASS (all 7 tests)

**Step 5: Commit**

```bash
git add packages/compiler/src/platform/ir/guardrail-action.ts packages/compiler/src/__tests__/guardrails/guardrail-action.test.ts
git commit -m "[ABLP-2] feat(compiler): add GuardrailAction type system separate from ConstraintAction"
```

---

### Task 2: Expand Guardrail IR Schema

Update the `Guardrail` interface in the IR schema to include all new fields: `kind`, `priority`, `tier`, `provider`, `category`, `threshold`, `llmCheck`, `severityActions`, `streaming`, `streamingInterval`. The existing 4-field Guardrail becomes the full schema from design doc Section 5.

**Files:**

- Modify: `packages/compiler/src/platform/ir/schema.ts:775-779`
- Test: `packages/compiler/src/__tests__/guardrails/guardrail-ir-schema.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/compiler/src/__tests__/guardrails/guardrail-ir-schema.test.ts
import { describe, it, expect } from 'vitest';
import type { Guardrail, ConstraintConfig } from '../../platform/ir/schema';
import type { GuardrailAction, SeverityLevel } from '../../platform/ir/guardrail-action';

describe('Guardrail IR schema', () => {
  it('should support kind field', () => {
    const g: Guardrail = {
      name: 'test',
      description: 'test guardrail',
      kind: 'input',
      priority: 1,
      tier: 'local',
      check: 'abl.length(input) > 1000',
      action: { type: 'block' },
    };
    expect(g.kind).toBe('input');
  });

  it('should support all 5 kind values (no "both" in IR)', () => {
    const kinds: Guardrail['kind'][] = ['input', 'output', 'tool_input', 'tool_output', 'handoff'];
    expect(kinds).toHaveLength(5);
  });

  it('should support tier field', () => {
    const g: Guardrail = {
      name: 'model_check',
      description: 'Model-based safety check',
      kind: 'output',
      priority: 3,
      tier: 'model',
      provider: 'qwen3guard',
      category: 'content_safety',
      threshold: 0.8,
      action: { type: 'block' },
    };
    expect(g.tier).toBe('model');
    expect(g.provider).toBe('qwen3guard');
  });

  it('should support llm tier fields', () => {
    const g: Guardrail = {
      name: 'on_topic',
      description: 'LLM-based topic check',
      kind: 'output',
      priority: 10,
      tier: 'llm',
      llmCheck: 'Is this response on topic?',
      threshold: 0.7,
      action: { type: 'warn' },
    };
    expect(g.tier).toBe('llm');
    expect(g.llmCheck).toBeDefined();
  });

  it('should support severityActions', () => {
    const g: Guardrail = {
      name: 'safety',
      description: 'Content safety',
      kind: 'output',
      priority: 3,
      tier: 'model',
      provider: 'qwen3guard',
      threshold: 0.8,
      action: { type: 'block' },
      severityActions: {
        low: { type: 'warn' },
        medium: { type: 'reask', maxReasks: 2 },
        high: { type: 'block' },
        critical: { type: 'escalate' },
      },
    };
    expect(g.severityActions?.low?.type).toBe('warn');
    expect(g.severityActions?.critical?.type).toBe('escalate');
  });

  it('should support streaming fields', () => {
    const g: Guardrail = {
      name: 'streaming_pii',
      description: 'PII in stream',
      kind: 'output',
      priority: 1,
      tier: 'local',
      check: 'abl.contains_pii(output)',
      action: { type: 'redact' },
      streaming: true,
      streamingInterval: 'sentence',
    };
    expect(g.streaming).toBe(true);
    expect(g.streamingInterval).toBe('sentence');
  });

  it('should be storable in ConstraintConfig.guardrails', () => {
    const config: ConstraintConfig = {
      constraints: [],
      guardrails: [
        {
          name: 'test',
          description: 'test',
          kind: 'input',
          priority: 1,
          tier: 'local',
          check: 'true',
          action: { type: 'block' },
        },
      ],
    };
    expect(config.guardrails).toHaveLength(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/compiler && pnpm vitest run src/__tests__/guardrails/guardrail-ir-schema.test.ts`
Expected: FAIL — `Guardrail` type missing new fields

**Step 3: Update the Guardrail interface in schema.ts**

Modify `packages/compiler/src/platform/ir/schema.ts:775-779`. Replace the existing `Guardrail` interface:

```typescript
// packages/compiler/src/platform/ir/schema.ts
// Replace the existing Guardrail interface (lines 775-779)

import type { GuardrailAction, SeverityLevel } from './guardrail-action';

export type GuardrailKind = 'input' | 'output' | 'tool_input' | 'tool_output' | 'handoff';
export type GuardrailTier = 'local' | 'model' | 'llm';

export interface Guardrail {
  /** Unique guardrail identifier */
  name: string;

  /** Human-readable description */
  description: string;

  /** When this guardrail fires — 'both' expanded at compile time */
  kind: GuardrailKind;

  /** Execution priority (lower = first) */
  priority: number;

  /** Inferred execution tier */
  tier: GuardrailTier;

  // ── Tier 1: Local CEL ──
  /** CEL expression to evaluate */
  check?: string;

  // ── Tier 2: Model-based ──
  /** Provider name from registry */
  provider?: string;
  /** Safety taxonomy category */
  category?: string;
  /** Score threshold (0.0-1.0) */
  threshold?: number;

  // ── Tier 3: LLM-based ──
  /** Natural language check prompt */
  llmCheck?: string;

  // ── Action ──
  /** Default action on violation */
  action: GuardrailAction;
  /** Per-severity action overrides (excludes 'safe') */
  severityActions?: Partial<Record<Exclude<SeverityLevel, 'safe'>, GuardrailAction>>;

  // ── Streaming ──
  /** Enable mid-stream evaluation */
  streaming?: boolean;
  /** Streaming evaluation interval */
  streamingInterval?: 'token' | 'sentence' | 'chunk_size';
}
```

Also re-export the types from guardrail-action.ts for convenience:

```typescript
// At the top of schema.ts, add:
export type {
  GuardrailAction,
  GuardrailActionType,
  SeverityLevel,
  FixStrategy,
} from './guardrail-action';
```

**Step 4: Run test to verify it passes**

Run: `cd packages/compiler && pnpm vitest run src/__tests__/guardrails/guardrail-ir-schema.test.ts`
Expected: PASS

**Step 5: Run existing guardrail tests to check backward compat**

Run: `cd packages/compiler && pnpm vitest run src/__tests__/guardrails/guardrails-e2e.test.ts`
Expected: FAIL — existing tests create Guardrail objects with old shape (missing `kind`, `priority`, `tier`). These will be fixed in Task 3.

**Step 6: Commit**

```bash
git add packages/compiler/src/platform/ir/schema.ts packages/compiler/src/platform/ir/guardrail-action.ts packages/compiler/src/__tests__/guardrails/guardrail-ir-schema.test.ts
git commit -m "[ABLP-2] feat(compiler): expand Guardrail IR with kind, priority, tier, provider, severity support"
```

---

### Task 3: Update Compiler — Guardrail Compilation

Update `compileConstraints()` and `mapGuardrailAction()` to produce the new Guardrail IR. Handle: `both` expansion, tier inference, kind/priority preservation, new action types. Fix the existing `warn` bug.

**Files:**

- Modify: `packages/compiler/src/platform/ir/compiler.ts:919-953` (compileConstraints)
- Modify: `packages/compiler/src/platform/ir/compiler.ts:1090-1105` (mapGuardrailAction)
- Modify: `packages/core/src/types/agent-based.ts:657-670` (GuardrailDefinition — add new fields)
- Modify: `packages/core/src/parser/agent-based-parser.ts:4505-4681` (parse new fields)
- Modify: `packages/compiler/src/__tests__/guardrails/guardrails-e2e.test.ts` (fix existing tests)
- Test: `packages/compiler/src/__tests__/guardrails/guardrail-compilation.test.ts`

**Step 1: Update GuardrailDefinition type to support new DSL fields**

Modify `packages/core/src/types/agent-based.ts:657-670`:

```typescript
export interface GuardrailDefinition {
  name: string;
  kind: 'input' | 'output' | 'both' | 'tool_input' | 'tool_output' | 'handoff';
  check?: string; // Tier 1: CEL expression
  action: 'block' | 'warn' | 'redact' | 'escalate' | 'fix' | 'reask' | 'filter';
  message?: string;
  priority?: number;
  // Tier 2: Model-based
  provider?: string;
  category?: string;
  threshold?: number;
  // Tier 3: LLM-based
  llm_check?: string;
  // Graduated actions
  severity_actions?: Record<string, string>;
  // Fix strategy
  fix_strategy?: string;
  fix_expression?: string;
  // Reask config
  max_reasks?: number;
  // Filter config
  filter_min_length?: number;
  // Streaming
  streaming?: boolean;
  streaming_interval?: string;
}
```

**Step 2: Write the failing test for compilation**

```typescript
// packages/compiler/src/__tests__/guardrails/guardrail-compilation.test.ts
import { describe, it, expect } from 'vitest';
import { compileABLtoIR } from '../../platform/ir/compiler';
import type { Guardrail, GuardrailKind } from '../../platform/ir/schema';

// Helper: minimal ABL with guardrails
function compileGuardrails(guardrailsDsl: string): Guardrail[] {
  const dsl = `
AGENT: test_agent
GOAL: Test agent for guardrail compilation
EXECUTION:
  mode: reasoning
${guardrailsDsl}
`;
  const result = compileABLtoIR(dsl);
  return result.constraints?.guardrails ?? [];
}

describe('Guardrail compilation', () => {
  describe('tier inference', () => {
    it('should infer tier=local for CEL check guardrails', () => {
      const guardrails = compileGuardrails(`
GUARDRAILS:
  - name: length_check
    kind: input
    check: abl.length(input) > 1000
    action: block
    message: Input too long
`);
      expect(guardrails[0].tier).toBe('local');
    });

    it('should infer tier=model for provider guardrails', () => {
      const guardrails = compileGuardrails(`
GUARDRAILS:
  - name: safety
    kind: output
    provider: qwen3guard
    category: content_safety
    threshold: 0.8
    action: block
`);
      expect(guardrails[0].tier).toBe('model');
      expect(guardrails[0].provider).toBe('qwen3guard');
    });

    it('should infer tier=llm for llm_check guardrails', () => {
      const guardrails = compileGuardrails(`
GUARDRAILS:
  - name: on_topic
    kind: output
    llm_check: Is this response relevant?
    threshold: 0.7
    action: warn
`);
      expect(guardrails[0].tier).toBe('llm');
      expect(guardrails[0].llmCheck).toBe('Is this response relevant?');
    });
  });

  describe('both expansion', () => {
    it('should expand kind=both into input + output guardrails', () => {
      const guardrails = compileGuardrails(`
GUARDRAILS:
  - name: pii_check
    kind: both
    check: abl.contains_pii(input)
    action: redact
    message: PII detected
    priority: 1
`);
      expect(guardrails).toHaveLength(2);
      const kinds = guardrails.map((g) => g.kind).sort();
      expect(kinds).toEqual(['input', 'output']);
      // Both should share the same name, priority, action
      expect(guardrails[0].name).toBe('pii_check');
      expect(guardrails[1].name).toBe('pii_check');
      expect(guardrails[0].priority).toBe(1);
    });
  });

  describe('kind preservation', () => {
    it('should preserve kind in IR', () => {
      const guardrails = compileGuardrails(`
GUARDRAILS:
  - name: tool_check
    kind: tool_input
    check: tool_name != "delete_all"
    action: block
`);
      expect(guardrails[0].kind).toBe('tool_input');
    });
  });

  describe('priority preservation', () => {
    it('should preserve priority in IR', () => {
      const guardrails = compileGuardrails(`
GUARDRAILS:
  - name: high_priority
    kind: input
    check: abl.length(input) > 1000
    action: block
    priority: 1
  - name: low_priority
    kind: input
    check: abl.length(input) > 5000
    action: warn
    priority: 10
`);
      expect(guardrails[0].priority).toBe(1);
      expect(guardrails[1].priority).toBe(10);
    });

    it('should default priority to 100 when not specified', () => {
      const guardrails = compileGuardrails(`
GUARDRAILS:
  - name: no_priority
    kind: input
    check: true
    action: warn
`);
      expect(guardrails[0].priority).toBe(100);
    });
  });

  describe('action mapping', () => {
    it('should map warn to GuardrailAction with type=warn', () => {
      const guardrails = compileGuardrails(`
GUARDRAILS:
  - name: soft_check
    kind: output
    check: true
    action: warn
    message: Just a warning
`);
      expect(guardrails[0].action.type).toBe('warn');
      expect(guardrails[0].action.message).toBe('Just a warning');
    });

    it('should map fix action with strategy', () => {
      const guardrails = compileGuardrails(`
GUARDRAILS:
  - name: truncate_check
    kind: input
    check: abl.length(input) > 5000
    action: fix
    fix_strategy: truncate
`);
      expect(guardrails[0].action.type).toBe('fix');
      expect(guardrails[0].action.fixStrategy).toBe('truncate');
    });

    it('should map reask action with max_reasks', () => {
      const guardrails = compileGuardrails(`
GUARDRAILS:
  - name: retry_check
    kind: output
    check: abl.length(output) < 10
    action: reask
    max_reasks: 3
`);
      expect(guardrails[0].action.type).toBe('reask');
      expect(guardrails[0].action.maxReasks).toBe(3);
    });
  });

  describe('severity actions', () => {
    it('should compile severity_actions to severityActions map', () => {
      const guardrails = compileGuardrails(`
GUARDRAILS:
  - name: graduated
    kind: output
    provider: qwen3guard
    threshold: 0.5
    action: block
    severity_actions:
      low: warn
      medium: reask
      high: block
      critical: escalate
`);
      const g = guardrails[0];
      expect(g.severityActions?.low?.type).toBe('warn');
      expect(g.severityActions?.medium?.type).toBe('reask');
      expect(g.severityActions?.high?.type).toBe('block');
      expect(g.severityActions?.critical?.type).toBe('escalate');
    });
  });

  describe('streaming fields', () => {
    it('should preserve streaming config', () => {
      const guardrails = compileGuardrails(`
GUARDRAILS:
  - name: stream_pii
    kind: output
    check: abl.contains_pii(output)
    action: redact
    streaming: true
    streaming_interval: sentence
`);
      expect(guardrails[0].streaming).toBe(true);
      expect(guardrails[0].streamingInterval).toBe('sentence');
    });
  });
});
```

**Step 3: Run test to verify it fails**

Run: `cd packages/compiler && pnpm vitest run src/__tests__/guardrails/guardrail-compilation.test.ts`
Expected: FAIL — compiler doesn't produce new fields yet

**Step 4: Update the parser to handle new DSL fields**

Modify `packages/core/src/parser/agent-based-parser.ts` in the `parseGuardrailDefinitions()` function (lines 4505-4681) to extract the new fields: `provider`, `category`, `threshold`, `llm_check`, `severity_actions`, `fix_strategy`, `fix_expression`, `max_reasks`, `filter_min_length`, `streaming`, `streaming_interval`.

For each guardrail entry, after extracting existing fields (name, kind, check, action, message, priority), add:

```typescript
// Inside parseGuardrailDefinitions, for each guardrail entry:
const provider = getStringField(guardrailNode, 'provider');
const category = getStringField(guardrailNode, 'category');
const threshold = getNumberField(guardrailNode, 'threshold');
const llmCheck = getStringField(guardrailNode, 'llm_check');
const fixStrategy = getStringField(guardrailNode, 'fix_strategy');
const fixExpression = getStringField(guardrailNode, 'fix_expression');
const maxReasks = getNumberField(guardrailNode, 'max_reasks');
const filterMinLength = getNumberField(guardrailNode, 'filter_min_length');
const streaming = getBooleanField(guardrailNode, 'streaming');
const streamingInterval = getStringField(guardrailNode, 'streaming_interval');
const severityActionsNode = getMapField(guardrailNode, 'severity_actions');
// Parse severity_actions map into Record<string, string>
```

**Step 5: Update compileConstraints in compiler.ts**

Modify `packages/compiler/src/platform/ir/compiler.ts:919-953`:

```typescript
function compileConstraints(doc: AgentBasedDocument): ConstraintConfig {
  const rawGuardrails: Guardrail[] = (doc.guardrails || []).map((g) => {
    // Infer tier
    const tier: GuardrailTier = g.provider ? 'model' : g.llm_check ? 'llm' : 'local';

    // Map action
    const action: GuardrailAction = {
      type: mapGuardrailActionType(g.action),
      message: g.message,
      ...(g.fix_strategy && { fixStrategy: g.fix_strategy as FixStrategy }),
      ...(g.fix_expression && { fixExpression: g.fix_expression }),
      ...(g.max_reasks != null && { maxReasks: g.max_reasks }),
      ...(g.filter_min_length != null && { filterMinLength: g.filter_min_length }),
    };

    // Map severity actions
    const severityActions = g.severity_actions
      ? Object.fromEntries(
          Object.entries(g.severity_actions).map(([level, act]) => [
            level,
            { type: mapGuardrailActionType(act) } as GuardrailAction,
          ]),
        )
      : undefined;

    return {
      name: g.name,
      description: g.message || `Guardrail: ${g.name}`,
      kind: g.kind as GuardrailKind, // 'both' still present at this point
      priority: g.priority ?? 100,
      tier,
      ...(g.check && { check: g.check }),
      ...(g.provider && { provider: g.provider }),
      ...(g.category && { category: g.category }),
      ...(g.threshold != null && { threshold: g.threshold }),
      ...(g.llm_check && { llmCheck: g.llm_check }),
      action,
      ...(severityActions && { severityActions }),
      ...(g.streaming != null && { streaming: g.streaming }),
      ...(g.streaming_interval && { streamingInterval: g.streaming_interval }),
    } as Guardrail;
  });

  // Expand 'both' into input + output (Appendix A.2)
  const guardrails: Guardrail[] = rawGuardrails.flatMap((g) => {
    if ((g as any).kind === 'both') {
      return [
        { ...g, kind: 'input' as GuardrailKind },
        { ...g, kind: 'output' as GuardrailKind },
      ];
    }
    return [g];
  });

  // Existing constraint compilation...
  const constraints =
    doc.constraints?.flatMap((phase) =>
      phase.requirements.map((req) => ({
        condition: autoGuardConstraint(req.condition),
        on_fail: parseOnFail(req.onFail),
      })),
    ) ?? [];

  return { constraints, guardrails };
}
```

**Step 6: Replace mapGuardrailAction**

Replace `packages/compiler/src/platform/ir/compiler.ts:1090-1105`:

```typescript
function mapGuardrailActionType(action: string): GuardrailActionType {
  switch (action) {
    case 'block':
      return 'block';
    case 'warn':
      return 'warn';
    case 'redact':
      return 'redact';
    case 'fix':
      return 'fix';
    case 'reask':
      return 'reask';
    case 'filter':
      return 'filter';
    case 'escalate':
      return 'escalate';
    default:
      return 'warn'; // Safe default
  }
}
```

**Step 7: Run tests**

Run: `cd packages/compiler && pnpm vitest run src/__tests__/guardrails/`
Expected: All new tests PASS, existing e2e tests may need minor shape adjustments.

**Step 8: Fix existing e2e tests**

Update `packages/compiler/src/__tests__/guardrails/guardrails-e2e.test.ts` to expect the new Guardrail shape (e.g., `action` is now `{ type: 'block' }` instead of `{ type: 'block', message: '...' }` — adjust assertions accordingly). The `kind: 'both'` tests should now expect 2 expanded guardrails.

**Step 9: Run all tests**

Run: `cd packages/compiler && pnpm vitest run src/__tests__/guardrails/`
Expected: ALL PASS

**Step 10: Commit**

```bash
git add packages/core/src/types/agent-based.ts packages/core/src/parser/agent-based-parser.ts packages/compiler/src/platform/ir/compiler.ts packages/compiler/src/__tests__/guardrails/
git commit -m "[ABLP-2] feat(compiler): update guardrail compilation with tier inference, both-expansion, new actions"
```

---

### Task 4: Compile-Time Validation for Action+Kind Combinations

Implement validation rules from Appendix A.3: `reask` only valid on output, `fix`/`filter` not valid on handoff, etc.

**Files:**

- Create: `packages/compiler/src/platform/ir/guardrail-validator.ts`
- Test: `packages/compiler/src/__tests__/guardrails/guardrail-validator.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/compiler/src/__tests__/guardrails/guardrail-validator.test.ts
import { describe, it, expect } from 'vitest';
import { validateGuardrails } from '../../platform/ir/guardrail-validator';
import type { Guardrail } from '../../platform/ir/schema';

function makeGuardrail(overrides: Partial<Guardrail>): Guardrail {
  return {
    name: 'test',
    description: 'test',
    kind: 'input',
    priority: 1,
    tier: 'local',
    check: 'true',
    action: { type: 'block' },
    ...overrides,
  };
}

describe('validateGuardrails', () => {
  it('should reject reask on input guardrails', () => {
    const diagnostics = validateGuardrails([
      makeGuardrail({ kind: 'input', action: { type: 'reask' } }),
    ]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe('error');
    expect(diagnostics[0].message).toContain('reask');
  });

  it('should allow reask on output guardrails', () => {
    const diagnostics = validateGuardrails([
      makeGuardrail({ kind: 'output', action: { type: 'reask' } }),
    ]);
    expect(diagnostics).toHaveLength(0);
  });

  it('should reject fix on handoff guardrails', () => {
    const diagnostics = validateGuardrails([
      makeGuardrail({ kind: 'handoff', action: { type: 'fix', fixStrategy: 'truncate' } }),
    ]);
    expect(diagnostics).toHaveLength(1);
  });

  it('should reject filter on handoff guardrails', () => {
    const diagnostics = validateGuardrails([
      makeGuardrail({ kind: 'handoff', action: { type: 'filter' } }),
    ]);
    expect(diagnostics).toHaveLength(1);
  });

  it('should warn on fix without fixStrategy', () => {
    const diagnostics = validateGuardrails([
      makeGuardrail({ kind: 'input', action: { type: 'fix' } }),
    ]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe('warning');
    expect(diagnostics[0].message).toContain('fixStrategy');
  });

  it('should validate severity_actions too', () => {
    const diagnostics = validateGuardrails([
      makeGuardrail({
        kind: 'input',
        severityActions: { high: { type: 'reask' } },
      }),
    ]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain('reask');
  });

  it('should accept valid guardrails with no diagnostics', () => {
    const diagnostics = validateGuardrails([
      makeGuardrail({ kind: 'input', action: { type: 'block' } }),
      makeGuardrail({ kind: 'output', action: { type: 'reask', maxReasks: 2 } }),
      makeGuardrail({ kind: 'tool_input', action: { type: 'redact' } }),
    ]);
    expect(diagnostics).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/compiler && pnpm vitest run src/__tests__/guardrails/guardrail-validator.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// packages/compiler/src/platform/ir/guardrail-validator.ts
import type { Guardrail, GuardrailKind } from './schema';
import type { GuardrailAction, GuardrailActionType } from './guardrail-action';

export interface ValidationDiagnostic {
  severity: 'error' | 'warning';
  guardrailName: string;
  message: string;
}

const ALLOWED_ACTIONS: Record<GuardrailKind, GuardrailActionType[]> = {
  input: ['block', 'warn', 'redact', 'fix', 'filter', 'escalate'],
  output: ['block', 'warn', 'redact', 'fix', 'reask', 'filter', 'escalate'],
  tool_input: ['block', 'warn', 'redact', 'fix', 'filter', 'escalate'],
  tool_output: ['block', 'warn', 'redact', 'fix', 'filter', 'escalate'],
  handoff: ['block', 'warn', 'redact', 'escalate'],
};

export function validateGuardrails(guardrails: Guardrail[]): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];

  for (const g of guardrails) {
    // Validate default action
    validateAction(g.name, g.kind, g.action, diagnostics);

    // Validate severity actions
    if (g.severityActions) {
      for (const [, action] of Object.entries(g.severityActions)) {
        if (action) {
          validateAction(g.name, g.kind, action, diagnostics);
        }
      }
    }
  }

  return diagnostics;
}

function validateAction(
  guardrailName: string,
  kind: GuardrailKind,
  action: GuardrailAction,
  diagnostics: ValidationDiagnostic[],
): void {
  const allowed = ALLOWED_ACTIONS[kind];
  if (!allowed.includes(action.type)) {
    diagnostics.push({
      severity: 'error',
      guardrailName,
      message: `Action '${action.type}' is not valid for kind '${kind}'. Allowed: ${allowed.join(', ')}`,
    });
  }

  // Warn on fix without strategy
  if (action.type === 'fix' && !action.fixStrategy) {
    diagnostics.push({
      severity: 'warning',
      guardrailName,
      message: `Action 'fix' should have a fixStrategy. Without one, it falls back to 'block' at runtime.`,
    });
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/compiler && pnpm vitest run src/__tests__/guardrails/guardrail-validator.test.ts`
Expected: PASS

**Step 5: Wire validator into compiler**

In `packages/compiler/src/platform/ir/compiler.ts`, call `validateGuardrails()` during compilation and collect diagnostics.

**Step 6: Commit**

```bash
git add packages/compiler/src/platform/ir/guardrail-validator.ts packages/compiler/src/__tests__/guardrails/guardrail-validator.test.ts packages/compiler/src/platform/ir/compiler.ts
git commit -m "[ABLP-2] feat(compiler): add compile-time validation for guardrail action+kind combinations"
```

---

### Task 5: New CEL Functions for Guardrails

Wire the PII detector into CEL and add the new functions from design doc Section 9.1: `abl.contains_pii()`, `abl.detect_pii()`, `abl.redact_pii()`, `abl.matches_pattern()`, `abl.not_matches_pattern()`, `abl.word_count()`, `abl.sentence_count()`, `abl.contains_url()`, `abl.contains_email()`, `abl.contains_code()`.

**Files:**

- Modify: `packages/compiler/src/platform/constructs/cel-functions.ts` (after line 434)
- Test: `packages/compiler/src/__tests__/guardrails/cel-guardrail-functions.test.ts`

**Step 1: Write the failing test**

````typescript
// packages/compiler/src/__tests__/guardrails/cel-guardrail-functions.test.ts
import { describe, it, expect } from 'vitest';
import { createAblCelEnvironment } from '../../platform/constructs/cel-functions';

describe('Guardrail CEL functions', () => {
  const env = createAblCelEnvironment();

  function celEval(expr: string, vars: Record<string, unknown> = {}): unknown {
    const ast = env.parse(expr);
    const prg = env.program(ast);
    return prg.eval(vars);
  }

  describe('abl.contains_pii', () => {
    it('should return true for text with email', () => {
      expect(celEval('abl.contains_pii(text)', { text: 'Contact john@example.com' })).toBe(true);
    });

    it('should return true for text with SSN', () => {
      expect(celEval('abl.contains_pii(text)', { text: 'SSN: 123-45-6789' })).toBe(true);
    });

    it('should return false for clean text', () => {
      expect(celEval('abl.contains_pii(text)', { text: 'Hello world' })).toBe(false);
    });
  });

  describe('abl.redact_pii', () => {
    it('should redact email addresses', () => {
      const result = celEval('abl.redact_pii(text)', { text: 'Email: john@example.com' });
      expect(result).not.toContain('john@example.com');
      expect(result).toContain('[REDACTED');
    });
  });

  describe('abl.matches_pattern', () => {
    it('should match a regex pattern', () => {
      expect(
        celEval('abl.matches_pattern(text, pattern)', {
          text: '<script>alert(1)</script>',
          pattern: '<script',
        }),
      ).toBe(true);
    });

    it('should not match a non-matching pattern', () => {
      expect(
        celEval('abl.matches_pattern(text, pattern)', {
          text: 'Hello world',
          pattern: '<script',
        }),
      ).toBe(false);
    });
  });

  describe('abl.not_matches_pattern', () => {
    it('should be negation of matches_pattern', () => {
      expect(
        celEval('abl.not_matches_pattern(text, pattern)', {
          text: 'Hello world',
          pattern: '<script',
        }),
      ).toBe(true);
    });
  });

  describe('abl.word_count', () => {
    it('should count words', () => {
      expect(celEval('abl.word_count(text)', { text: 'Hello beautiful world' })).toBe(3);
    });

    it('should handle empty string', () => {
      expect(celEval('abl.word_count(text)', { text: '' })).toBe(0);
    });
  });

  describe('abl.sentence_count', () => {
    it('should count sentences', () => {
      expect(celEval('abl.sentence_count(text)', { text: 'Hello. How are you? Fine!' })).toBe(3);
    });
  });

  describe('abl.contains_url', () => {
    it('should detect http URLs', () => {
      expect(celEval('abl.contains_url(text)', { text: 'Visit https://example.com' })).toBe(true);
    });

    it('should return false for no URLs', () => {
      expect(celEval('abl.contains_url(text)', { text: 'No links here' })).toBe(false);
    });
  });

  describe('abl.contains_email', () => {
    it('should detect email addresses', () => {
      expect(celEval('abl.contains_email(text)', { text: 'Mail me at test@example.com' })).toBe(
        true,
      );
    });
  });

  describe('abl.contains_code', () => {
    it('should detect code blocks', () => {
      expect(
        celEval('abl.contains_code(text)', { text: 'Here is code:\n```js\nconsole.log(1)\n```' }),
      ).toBe(true);
    });
  });
});
````

**Step 2: Run test to verify it fails**

Run: `cd packages/compiler && pnpm vitest run src/__tests__/guardrails/cel-guardrail-functions.test.ts`
Expected: FAIL — functions not registered

**Step 3: Add functions to cel-functions.ts**

Add after the last function registration (around line 434) in `packages/compiler/src/platform/constructs/cel-functions.ts`:

````typescript
// ── PII Functions (wrapping pii-detector.ts) ──
import { detectPII, containsPII, redactPII } from '../security/pii-detector';

env.registerFunction('abl.contains_pii', (text: string): boolean => {
  return containsPII(text);
});

env.registerFunction('abl.detect_pii', (text: string): { hasPII: boolean; types: string[] } => {
  const result = detectPII(text);
  return {
    hasPII: result.hasPII,
    types: result.detections.map((d) => d.type),
  };
});

env.registerFunction('abl.redact_pii', (text: string): string => {
  return redactPII(text);
});

// ── Pattern Matching ──
env.registerFunction('abl.matches_pattern', (text: string, pattern: string): boolean => {
  try {
    const regex = new RegExp(pattern);
    return regex.test(text);
  } catch {
    return false;
  }
});

env.registerFunction('abl.not_matches_pattern', (text: string, pattern: string): boolean => {
  try {
    const regex = new RegExp(pattern);
    return !regex.test(text);
  } catch {
    return true;
  }
});

// ── Text Analysis ──
env.registerFunction('abl.word_count', (text: string): number => {
  if (!text || !text.trim()) return 0;
  return text.trim().split(/\s+/).length;
});

env.registerFunction('abl.sentence_count', (text: string): number => {
  if (!text || !text.trim()) return 0;
  return text.split(/[.!?]+/).filter((s) => s.trim().length > 0).length;
});

env.registerFunction('abl.contains_url', (text: string): boolean => {
  return /https?:\/\/\S+|www\.\S+/.test(text);
});

env.registerFunction('abl.contains_email', (text: string): boolean => {
  return /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text);
});

env.registerFunction('abl.contains_code', (text: string): boolean => {
  return (
    /```[\s\S]*```/.test(text) || /\b(function|const|let|var|import|export|class|def)\b/.test(text)
  );
});
````

**Step 4: Run test to verify it passes**

Run: `cd packages/compiler && pnpm vitest run src/__tests__/guardrails/cel-guardrail-functions.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/compiler/src/platform/constructs/cel-functions.ts packages/compiler/src/__tests__/guardrails/cel-guardrail-functions.test.ts
git commit -m "[ABLP-2] feat(compiler): add 10 guardrail CEL functions (PII, pattern, text analysis)"
```

---

### Task 6: Context Variable Injection

The runtime must auto-inject `input`, `output`, `tool_name`, `tool_parameters`, `tool_result`, `handoff_context`, `source_agent`, `target_agent`, `session_turn_count`, `agent_goal` into the CEL evaluation context based on guardrail kind (design doc Section 9.2).

**Files:**

- Create: `packages/compiler/src/platform/constructs/guardrail-context.ts`
- Modify: `apps/runtime/src/services/execution/constraint-checker.ts:42-81`
- Test: `packages/compiler/src/__tests__/guardrails/guardrail-context.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/compiler/src/__tests__/guardrails/guardrail-context.test.ts
import { describe, it, expect } from 'vitest';
import { buildGuardrailCelContext } from '../../platform/constructs/guardrail-context';

describe('buildGuardrailCelContext', () => {
  it('should inject input variable for input kind', () => {
    const ctx = buildGuardrailCelContext('input', {
      content: 'Hello world',
      agentGoal: 'Help users',
      sessionTurnCount: 5,
    });
    expect(ctx.input).toBe('Hello world');
    expect(ctx.agent_goal).toBe('Help users');
    expect(ctx.session_turn_count).toBe(5);
  });

  it('should inject output variable for output kind', () => {
    const ctx = buildGuardrailCelContext('output', {
      content: 'Response text',
      agentGoal: 'Help users',
      sessionTurnCount: 3,
    });
    expect(ctx.output).toBe('Response text');
  });

  it('should inject tool variables for tool_input kind', () => {
    const ctx = buildGuardrailCelContext('tool_input', {
      content: '{"query": "test"}',
      toolName: 'search',
      toolParameters: { query: 'test' },
      sessionTurnCount: 2,
    });
    expect(ctx.tool_name).toBe('search');
    expect(ctx.tool_parameters).toEqual({ query: 'test' });
  });

  it('should inject handoff variables for handoff kind', () => {
    const ctx = buildGuardrailCelContext('handoff', {
      content: 'Context transfer',
      sourceAgent: 'booking',
      targetAgent: 'support',
      handoffContext: 'Customer needs help',
      handoffReason: 'Billing issue',
      sessionTurnCount: 4,
    });
    expect(ctx.source_agent).toBe('booking');
    expect(ctx.target_agent).toBe('support');
    expect(ctx.handoff_context).toBe('Customer needs help');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/compiler && pnpm vitest run src/__tests__/guardrails/guardrail-context.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// packages/compiler/src/platform/constructs/guardrail-context.ts
import type { GuardrailKind } from '../ir/schema';

export interface GuardrailContextInput {
  content: string;
  agentGoal?: string;
  sessionTurnCount?: number;
  // Tool context
  toolName?: string;
  toolParameters?: Record<string, unknown>;
  toolResult?: unknown;
  toolSuccess?: boolean;
  toolDurationMs?: number;
  // Handoff context
  sourceAgent?: string;
  targetAgent?: string;
  sourceAgentRole?: string;
  handoffContext?: string;
  handoffReason?: string;
  // Extra session values
  sessionValues?: Record<string, unknown>;
}

export function buildGuardrailCelContext(
  kind: GuardrailKind,
  input: GuardrailContextInput,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    agent_goal: input.agentGoal ?? '',
    session_turn_count: input.sessionTurnCount ?? 0,
    ...(input.sessionValues ?? {}),
  };

  switch (kind) {
    case 'input':
      return { ...base, input: input.content };
    case 'output':
      return { ...base, output: input.content };
    case 'tool_input':
      return {
        ...base,
        tool_name: input.toolName ?? '',
        tool_parameters: input.toolParameters ?? {},
      };
    case 'tool_output':
      return {
        ...base,
        tool_name: input.toolName ?? '',
        tool_result: input.toolResult ?? {},
        tool_success: input.toolSuccess ?? true,
        tool_duration_ms: input.toolDurationMs ?? 0,
      };
    case 'handoff':
      return {
        ...base,
        source_agent: input.sourceAgent ?? '',
        target_agent: input.targetAgent ?? '',
        source_agent_role: input.sourceAgentRole ?? '',
        handoff_context: input.handoffContext ?? '',
        handoff_reason: input.handoffReason ?? '',
      };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/compiler && pnpm vitest run src/__tests__/guardrails/guardrail-context.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/compiler/src/platform/constructs/guardrail-context.ts packages/compiler/src/__tests__/guardrails/guardrail-context.test.ts
git commit -m "[ABLP-2] feat(compiler): add guardrail CEL context builder with kind-specific variable injection"
```

---

## Phase 2: Pipeline Core

### Task 7: Guardrail Pipeline Types and Interfaces

Define the core pipeline types: `GuardrailPipeline`, `GuardrailPipelineResult`, `GuardrailViolation`, `GuardrailContext` (design doc Section 7.1).

**Files:**

- Create: `packages/compiler/src/platform/guardrails/types.ts`
- Test: `packages/compiler/src/__tests__/guardrails/pipeline-types.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/compiler/src/__tests__/guardrails/pipeline-types.test.ts
import { describe, it, expect } from 'vitest';
import type {
  GuardrailPipelineResult,
  GuardrailViolation,
  GuardrailContext,
} from '../../platform/guardrails/types';
import {
  createEmptyPipelineResult,
  addViolation,
  isTerminalAction,
} from '../../platform/guardrails/types';

describe('Pipeline types', () => {
  it('should create an empty passing result', () => {
    const result = createEmptyPipelineResult();
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('should add a violation and mark as failed', () => {
    const result = createEmptyPipelineResult();
    const violation: GuardrailViolation = {
      name: 'pii_check',
      kind: 'input',
      tier: 'local',
      action: 'block',
      severity: 'high',
      message: 'PII detected',
      priority: 1,
      latencyMs: 0.5,
    };
    addViolation(result, violation);
    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.primaryViolation).toBe(violation);
  });

  it('should add a warning without failing', () => {
    const result = createEmptyPipelineResult();
    const warning: GuardrailViolation = {
      name: 'soft_check',
      kind: 'output',
      tier: 'local',
      action: 'warn',
      severity: 'low',
      message: 'Might be off-topic',
      priority: 10,
      latencyMs: 0.1,
    };
    addViolation(result, warning);
    expect(result.passed).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.violations).toHaveLength(0);
  });

  it('should identify terminal actions', () => {
    expect(isTerminalAction('block')).toBe(true);
    expect(isTerminalAction('escalate')).toBe(true);
    expect(isTerminalAction('warn')).toBe(false);
    expect(isTerminalAction('redact')).toBe(false);
    expect(isTerminalAction('fix')).toBe(false);
    expect(isTerminalAction('filter')).toBe(false);
    expect(isTerminalAction('reask')).toBe(false); // conditional-terminal
  });

  it('should track primary violation by priority', () => {
    const result = createEmptyPipelineResult();
    addViolation(result, {
      name: 'low_pri',
      kind: 'input',
      tier: 'local',
      action: 'block',
      severity: 'high',
      message: 'Low pri',
      priority: 10,
      latencyMs: 0,
    });
    addViolation(result, {
      name: 'high_pri',
      kind: 'input',
      tier: 'local',
      action: 'block',
      severity: 'high',
      message: 'High pri',
      priority: 1,
      latencyMs: 0,
    });
    expect(result.primaryViolation?.name).toBe('high_pri');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/compiler && pnpm vitest run src/__tests__/guardrails/pipeline-types.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// packages/compiler/src/platform/guardrails/types.ts
import type {
  GuardrailKind,
  GuardrailTier,
  SeverityLevel,
  GuardrailActionType,
} from '../ir/schema';

export interface GuardrailContext {
  toolName?: string;
  toolParameters?: Record<string, unknown>;
  toolResult?: unknown;
  toolSuccess?: boolean;
  toolDurationMs?: number;
  sourceAgent?: string;
  targetAgent?: string;
  handoffContext?: string;
  handoffReason?: string;
  retrievedDocuments?: Array<{ content: string; source: string }>;
  agentGoal?: string;
  recentMessages?: Array<{ role: string; content: string }>;
}

export interface GuardrailViolation {
  name: string;
  kind: GuardrailKind;
  tier: GuardrailTier;
  action: string;
  severity: SeverityLevel;
  score?: number;
  threshold?: number;
  category?: string;
  label?: string;
  message: string;
  explanation?: string;
  priority: number;
  latencyMs: number;
  provider?: string;
}

export interface GuardrailPipelineResult {
  passed: boolean;
  violations: GuardrailViolation[];
  primaryViolation?: GuardrailViolation;
  modifiedContent?: string;
  warnings: GuardrailViolation[];
  metrics: PipelineMetrics;
}

export interface PipelineMetrics {
  totalChecks: number;
  passed: number;
  failed: number;
  warnings: number;
  totalLatencyMs: number;
  tier1LatencyMs: number;
  tier2LatencyMs: number;
  tier3LatencyMs: number;
  compoundFPREstimate: number;
  costUsd: number;
  cacheHits: number;
  cacheMisses: number;
  policyVersion: number;
}

const TERMINAL_ACTIONS = new Set<string>(['block', 'escalate']);

export function isTerminalAction(action: string): boolean {
  return TERMINAL_ACTIONS.has(action);
}

export function createEmptyPipelineResult(): GuardrailPipelineResult {
  return {
    passed: true,
    violations: [],
    warnings: [],
    metrics: {
      totalChecks: 0,
      passed: 0,
      failed: 0,
      warnings: 0,
      totalLatencyMs: 0,
      tier1LatencyMs: 0,
      tier2LatencyMs: 0,
      tier3LatencyMs: 0,
      compoundFPREstimate: 0,
      costUsd: 0,
      cacheHits: 0,
      cacheMisses: 0,
      policyVersion: 0,
    },
  };
}

export function addViolation(result: GuardrailPipelineResult, violation: GuardrailViolation): void {
  if (violation.action === 'warn') {
    result.warnings.push(violation);
    result.metrics.warnings++;
  } else {
    result.violations.push(violation);
    result.metrics.failed++;
    if (isTerminalAction(violation.action)) {
      result.passed = false;
    }
    // Track primary violation by priority (lowest number = highest priority)
    if (!result.primaryViolation || violation.priority < result.primaryViolation.priority) {
      result.primaryViolation = violation;
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/compiler && pnpm vitest run src/__tests__/guardrails/pipeline-types.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/compiler/src/platform/guardrails/types.ts packages/compiler/src/__tests__/guardrails/pipeline-types.test.ts
git commit -m "[ABLP-2] feat(compiler): add guardrail pipeline types, violation tracking, and action classification"
```

---

### Task 8: Tier 1 Local Evaluator

The core evaluation engine for local CEL-based guardrails. Takes a list of Tier 1 guardrails, content, and context, evaluates them in parallel, returns violations. This wraps the existing CEL environment.

**Files:**

- Create: `packages/compiler/src/platform/guardrails/tier1-evaluator.ts`
- Test: `packages/compiler/src/__tests__/guardrails/tier1-evaluator.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/compiler/src/__tests__/guardrails/tier1-evaluator.test.ts
import { describe, it, expect } from 'vitest';
import { Tier1Evaluator } from '../../platform/guardrails/tier1-evaluator';
import type { Guardrail } from '../../platform/ir/schema';

function localGuardrail(overrides: Partial<Guardrail>): Guardrail {
  return {
    name: 'test',
    description: 'test',
    kind: 'input',
    priority: 1,
    tier: 'local',
    check: 'true',
    action: { type: 'block' },
    ...overrides,
  };
}

describe('Tier1Evaluator', () => {
  const evaluator = new Tier1Evaluator();

  it('should pass when CEL check returns false (no violation)', async () => {
    const result = await evaluator.evaluate(
      [localGuardrail({ check: 'abl.length(input) > 1000' })],
      { input: 'short text' },
    );
    expect(result.violations).toHaveLength(0);
    expect(result.passed).toBe(true);
  });

  it('should fail when CEL check returns true (violation)', async () => {
    const result = await evaluator.evaluate(
      [
        localGuardrail({
          name: 'too_long',
          check: 'abl.length(input) > 5',
          action: { type: 'block', message: 'Too long' },
        }),
      ],
      { input: 'This is a very long input string' },
    );
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].name).toBe('too_long');
    expect(result.violations[0].action).toBe('block');
    expect(result.violations[0].tier).toBe('local');
  });

  it('should handle PII detection', async () => {
    const result = await evaluator.evaluate(
      [
        localGuardrail({
          name: 'pii',
          check: 'abl.contains_pii(input)',
          action: { type: 'redact' },
        }),
      ],
      { input: 'Email: john@example.com' },
    );
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].action).toBe('redact');
  });

  it('should evaluate multiple guardrails in parallel', async () => {
    const result = await evaluator.evaluate(
      [
        localGuardrail({ name: 'check1', check: 'false', action: { type: 'block' } }),
        localGuardrail({ name: 'check2', check: 'false', action: { type: 'warn' } }),
        localGuardrail({ name: 'check3', check: 'true', action: { type: 'warn' } }),
      ],
      { input: 'test' },
    );
    // check1 and check2 return false (no violation), check3 returns true (violation)
    expect(result.violations).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].name).toBe('check3');
  });

  it('should sort results by priority', async () => {
    const result = await evaluator.evaluate(
      [
        localGuardrail({ name: 'low', priority: 10, check: 'true', action: { type: 'block' } }),
        localGuardrail({ name: 'high', priority: 1, check: 'true', action: { type: 'block' } }),
      ],
      { input: 'test' },
    );
    expect(result.primaryViolation?.name).toBe('high');
  });

  it('should handle CEL evaluation errors gracefully', async () => {
    const result = await evaluator.evaluate([localGuardrail({ check: 'nonexistent_function()' })], {
      input: 'test',
    });
    // CEL error → treat as pass (fail-open for local checks with bad expressions)
    expect(result.passed).toBe(true);
  });

  it('should track latency per check', async () => {
    const result = await evaluator.evaluate(
      [localGuardrail({ check: 'true', action: { type: 'warn' } })],
      { input: 'test' },
    );
    expect(result.warnings[0].latencyMs).toBeGreaterThanOrEqual(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/compiler && pnpm vitest run src/__tests__/guardrails/tier1-evaluator.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// packages/compiler/src/platform/guardrails/tier1-evaluator.ts
import { createAblCelEnvironment } from '../constructs/cel-functions';
import type { Guardrail } from '../ir/schema';
import type { GuardrailViolation, GuardrailPipelineResult } from './types';
import { createEmptyPipelineResult, addViolation } from './types';

export class Tier1Evaluator {
  private env = createAblCelEnvironment();

  async evaluate(
    guardrails: Guardrail[],
    celContext: Record<string, unknown>,
  ): Promise<GuardrailPipelineResult> {
    const result = createEmptyPipelineResult();

    // Evaluate all Tier 1 guardrails in parallel
    const evaluations = guardrails.map(async (g) => {
      const start = performance.now();
      try {
        const ast = this.env.parse(g.check!);
        const prg = this.env.program(ast);
        const checkResult = prg.eval(celContext);
        const latencyMs = performance.now() - start;

        result.metrics.totalChecks++;

        if (checkResult === true) {
          // CEL check returned true → violation triggered
          const violation: GuardrailViolation = {
            name: g.name,
            kind: g.kind,
            tier: 'local',
            action: g.action.type,
            severity: 'high', // Binary for Tier 1: safe or high
            message: g.action.message ?? g.description,
            priority: g.priority,
            latencyMs,
          };
          addViolation(result, violation);
        } else {
          result.metrics.passed++;
        }
      } catch {
        // CEL evaluation error → treat as pass (fail-open for bad expressions)
        result.metrics.passed++;
      }
    });

    await Promise.all(evaluations);

    const latencies = result.violations
      .map((v) => v.latencyMs)
      .concat(result.warnings.map((w) => w.latencyMs));
    result.metrics.tier1LatencyMs =
      latencies.length > 0
        ? Math.max(...latencies) // Parallel → max latency
        : 0;
    result.metrics.totalLatencyMs = result.metrics.tier1LatencyMs;

    return result;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/compiler && pnpm vitest run src/__tests__/guardrails/tier1-evaluator.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/compiler/src/platform/guardrails/tier1-evaluator.ts packages/compiler/src/__tests__/guardrails/tier1-evaluator.test.ts
git commit -m "[ABLP-2] feat(compiler): add Tier 1 local CEL guardrail evaluator with parallel execution"
```

---

### Task 9: Guardrail Pipeline Orchestrator

The main pipeline that orchestrates tiered execution: filter by kind, sort by tier+priority, evaluate Tier 1 → Tier 2 → Tier 3 with early termination on blocks. Initially supports Tier 1 only; Tier 2/3 plugged in later.

**Files:**

- Create: `packages/compiler/src/platform/guardrails/pipeline.ts`
- Test: `packages/compiler/src/__tests__/guardrails/pipeline.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/compiler/src/__tests__/guardrails/pipeline.test.ts
import { describe, it, expect, vi } from 'vitest';
import { GuardrailPipelineImpl } from '../../platform/guardrails/pipeline';
import type { Guardrail } from '../../platform/ir/schema';

function guardrail(overrides: Partial<Guardrail>): Guardrail {
  return {
    name: 'test',
    description: 'test',
    kind: 'input',
    priority: 1,
    tier: 'local',
    check: 'true',
    action: { type: 'block' },
    ...overrides,
  };
}

describe('GuardrailPipelineImpl', () => {
  it('should filter guardrails by kind', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails = [
      guardrail({ name: 'input_check', kind: 'input', check: 'true', action: { type: 'warn' } }),
      guardrail({ name: 'output_check', kind: 'output', check: 'true', action: { type: 'warn' } }),
    ];

    const result = await pipeline.execute(guardrails, 'test', 'input', {});
    // Only input_check should fire
    expect(result.warnings.some((w) => w.name === 'input_check')).toBe(true);
    expect(result.warnings.some((w) => w.name === 'output_check')).toBe(false);
  });

  it('should execute Tier 1 guardrails and return result', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails = [
      guardrail({
        name: 'length_check',
        check: 'abl.length(input) > 5',
        action: { type: 'block', message: 'Too long' },
      }),
    ];

    const result = await pipeline.execute(guardrails, 'This is long enough', 'input', {});
    expect(result.passed).toBe(false);
    expect(result.primaryViolation?.name).toBe('length_check');
  });

  it('should pass when no violations', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails = [
      guardrail({
        check: 'abl.length(input) > 10000',
        action: { type: 'block' },
      }),
    ];

    const result = await pipeline.execute(guardrails, 'short', 'input', {});
    expect(result.passed).toBe(true);
  });

  it('should handle empty guardrails list', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const result = await pipeline.execute([], 'test', 'input', {});
    expect(result.passed).toBe(true);
    expect(result.metrics.totalChecks).toBe(0);
  });

  it('should early-terminate on Tier 1 block before Tier 2', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails = [
      guardrail({ name: 'blocker', tier: 'local', check: 'true', action: { type: 'block' } }),
      guardrail({
        name: 'model_check',
        tier: 'model',
        provider: 'qwen',
        action: { type: 'block' },
      }),
    ];

    const result = await pipeline.execute(guardrails, 'test', 'input', {});
    expect(result.passed).toBe(false);
    // model_check should not have been evaluated
    expect(result.metrics.totalChecks).toBe(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/compiler && pnpm vitest run src/__tests__/guardrails/pipeline.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// packages/compiler/src/platform/guardrails/pipeline.ts
import type { Guardrail, GuardrailKind } from '../ir/schema';
import { buildGuardrailCelContext } from '../constructs/guardrail-context';
import type { GuardrailContext, GuardrailPipelineResult } from './types';
import { createEmptyPipelineResult, isTerminalAction } from './types';
import { Tier1Evaluator } from './tier1-evaluator';

export class GuardrailPipelineImpl {
  private tier1 = new Tier1Evaluator();

  async execute(
    guardrails: Guardrail[],
    content: string,
    kind: GuardrailKind,
    context: GuardrailContext,
    onTraceEvent?: (event: unknown) => void,
  ): Promise<GuardrailPipelineResult> {
    // 1. Filter by kind
    const applicable = guardrails.filter((g) => g.kind === kind);
    if (applicable.length === 0) return createEmptyPipelineResult();

    // 2. Group by tier
    const tier1 = applicable
      .filter((g) => g.tier === 'local')
      .sort((a, b) => a.priority - b.priority);
    const tier2 = applicable
      .filter((g) => g.tier === 'model')
      .sort((a, b) => a.priority - b.priority);
    const tier3 = applicable
      .filter((g) => g.tier === 'llm')
      .sort((a, b) => a.priority - b.priority);

    // 3. Build CEL context
    const celContext = buildGuardrailCelContext(kind, {
      content,
      agentGoal: context.agentGoal,
      toolName: context.toolName,
      toolParameters: context.toolParameters,
      toolResult: context.toolResult,
      sourceAgent: context.sourceAgent,
      targetAgent: context.targetAgent,
      handoffContext: context.handoffContext,
      handoffReason: context.handoffReason,
    });

    // 4. Execute Tier 1 (local)
    const result = await this.tier1.evaluate(tier1, celContext);

    // 5. Early termination on Tier 1 block
    if (!result.passed && result.violations.some((v) => isTerminalAction(v.action))) {
      return result;
    }

    // 6. Tier 2 (model-based) — placeholder, implemented in Phase 3
    // TODO: Execute tier2 guardrails via provider registry

    // 7. Tier 3 (LLM-based) — placeholder, implemented in Phase 3
    // TODO: Execute tier3 guardrails via LLM provider

    return result;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/compiler && pnpm vitest run src/__tests__/guardrails/pipeline.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/compiler/src/platform/guardrails/pipeline.ts packages/compiler/src/__tests__/guardrails/pipeline.test.ts
git commit -m "[ABLP-2] feat(compiler): add guardrail pipeline orchestrator with kind filtering and tiered execution"
```

---

### Task 10: Redact and Fix Action Executors

Implement the content modification logic for `redact`, `fix`, and `filter` actions (design doc Appendix A.5 and A.9).

**Files:**

- Create: `packages/compiler/src/platform/guardrails/action-executors.ts`
- Test: `packages/compiler/src/__tests__/guardrails/action-executors.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/compiler/src/__tests__/guardrails/action-executors.test.ts
import { describe, it, expect } from 'vitest';
import {
  executeRedact,
  executeFix,
  executeFilter,
} from '../../platform/guardrails/action-executors';

describe('Action executors', () => {
  describe('executeRedact', () => {
    it('should redact PII from content', () => {
      const result = executeRedact('My email is john@example.com', 'pii');
      expect(result).not.toContain('john@example.com');
      expect(result).toContain('[REDACTED');
    });

    it('should redact matched patterns', () => {
      const result = executeRedact(
        '<script>alert(1)</script> Hello',
        'pattern',
        '<script[^>]*>.*?</script>',
      );
      expect(result).not.toContain('<script>');
      expect(result).toContain('[REDACTED]');
    });
  });

  describe('executeFix', () => {
    it('should truncate content with truncate strategy', () => {
      const result = executeFix('Hello World Extra', 'truncate', 11);
      expect(result.length).toBeLessThanOrEqual(11);
    });

    it('should strip HTML with strip_html strategy', () => {
      const result = executeFix('<b>Hello</b> <script>bad</script>', 'strip_html');
      expect(result).not.toContain('<script>');
      expect(result).toContain('Hello');
    });

    it('should normalize with normalize strategy', () => {
      const result = executeFix('  Hello   World  \n\n\n  ', 'normalize');
      expect(result).toBe('Hello World');
    });

    it('should redact PII with redact_pii strategy', () => {
      const result = executeFix('My SSN is 123-45-6789', 'redact_pii');
      expect(result).not.toContain('123-45-6789');
    });
  });

  describe('executeFilter', () => {
    it('should remove sentences containing violations', () => {
      const result = executeFilter(
        'This is safe. This contains badword and is not. This is also safe.',
        ['badword'],
        10, // minLength
      );
      expect(result).toContain('This is safe');
      expect(result).not.toContain('badword');
    });

    it('should return null when filtered content too short', () => {
      const result = executeFilter('Only bad content here.', ['bad'], 100);
      expect(result).toBeNull(); // Too short → caller should block
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/compiler && pnpm vitest run src/__tests__/guardrails/action-executors.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// packages/compiler/src/platform/guardrails/action-executors.ts
import { redactPII } from '../security/pii-detector';

export function executeRedact(content: string, mode: 'pii' | 'pattern', pattern?: string): string {
  if (mode === 'pii') {
    return redactPII(content);
  }
  if (mode === 'pattern' && pattern) {
    try {
      return content.replace(new RegExp(pattern, 'gi'), '[REDACTED]');
    } catch {
      return content;
    }
  }
  return content;
}

export function executeFix(content: string, strategy: string, maxLength?: number): string {
  switch (strategy) {
    case 'truncate':
      return maxLength ? content.slice(0, maxLength) : content;
    case 'strip_html':
      return content.replace(/<[^>]*>/g, '').trim();
    case 'normalize':
      return content.normalize('NFKC').replace(/\s+/g, ' ').trim();
    case 'redact_pii':
      return redactPII(content);
    default:
      return content;
  }
}

export function executeFilter(
  content: string,
  violationPatterns: string[],
  minLength: number,
): string | null {
  const sentences = content.split(/(?<=[.!?])\s+/);
  const filtered = sentences.filter(
    (sentence) => !violationPatterns.some((p) => sentence.toLowerCase().includes(p.toLowerCase())),
  );
  const result = filtered.join(' ').trim();
  return result.length >= minLength ? result : null;
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/compiler && pnpm vitest run src/__tests__/guardrails/action-executors.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/compiler/src/platform/guardrails/action-executors.ts packages/compiler/src/__tests__/guardrails/action-executors.test.ts
git commit -m "[ABLP-2] feat(compiler): add redact, fix, and filter action executors for guardrail pipeline"
```

---

### Task 11: Pipeline Result Aggregation with Action Precedence

Implement the action precedence logic from Appendix A.13: terminal actions (escalate > block > reask) win over non-terminal (redact > fix > filter > warn). Apply content modifications in priority order.

**Files:**

- Create: `packages/compiler/src/platform/guardrails/result-aggregator.ts`
- Test: `packages/compiler/src/__tests__/guardrails/result-aggregator.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/compiler/src/__tests__/guardrails/result-aggregator.test.ts
import { describe, it, expect } from 'vitest';
import { aggregateResults, ACTION_PRECEDENCE } from '../../platform/guardrails/result-aggregator';
import type { GuardrailViolation } from '../../platform/guardrails/types';

function violation(overrides: Partial<GuardrailViolation>): GuardrailViolation {
  return {
    name: 'test',
    kind: 'input',
    tier: 'local',
    action: 'block',
    severity: 'high',
    message: 'test',
    priority: 1,
    latencyMs: 0,
    ...overrides,
  };
}

describe('Result aggregation', () => {
  it('should return passed=true for empty violations', () => {
    const result = aggregateResults([], 'original');
    expect(result.passed).toBe(true);
  });

  it('should prioritize escalate over block', () => {
    const result = aggregateResults(
      [
        violation({ name: 'blocker', action: 'block', priority: 1 }),
        violation({ name: 'escalator', action: 'escalate', priority: 2 }),
      ],
      'original',
    );
    expect(result.passed).toBe(false);
    expect(result.primaryViolation?.name).toBe('escalator');
  });

  it('should separate warnings from violations', () => {
    const result = aggregateResults(
      [
        violation({ name: 'warning1', action: 'warn', priority: 1 }),
        violation({ name: 'blocker', action: 'block', priority: 2 }),
      ],
      'original',
    );
    expect(result.passed).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.violations).toHaveLength(1);
  });

  it('should return passed=true with only warn violations', () => {
    const result = aggregateResults([violation({ action: 'warn', priority: 1 })], 'original');
    expect(result.passed).toBe(true);
  });

  it('should apply redact before fix in priority order', () => {
    const result = aggregateResults(
      [
        violation({ name: 'fixer', action: 'fix', priority: 2 }),
        violation({ name: 'redactor', action: 'redact', priority: 1 }),
      ],
      'original',
    );
    // Both are non-terminal, so passed = true
    expect(result.passed).toBe(true);
    // Non-terminal violations are still tracked
    expect(result.violations).toHaveLength(2);
  });
});

describe('ACTION_PRECEDENCE', () => {
  it('should rank escalate highest among terminal', () => {
    expect(ACTION_PRECEDENCE.escalate).toBeGreaterThan(ACTION_PRECEDENCE.block);
  });

  it('should rank terminal above non-terminal', () => {
    expect(ACTION_PRECEDENCE.block).toBeGreaterThan(ACTION_PRECEDENCE.redact);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/compiler && pnpm vitest run src/__tests__/guardrails/result-aggregator.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// packages/compiler/src/platform/guardrails/result-aggregator.ts
import type { GuardrailViolation, GuardrailPipelineResult } from './types';
import { createEmptyPipelineResult, isTerminalAction } from './types';

export const ACTION_PRECEDENCE: Record<string, number> = {
  warn: 0,
  filter: 1,
  fix: 2,
  redact: 3,
  reask: 4,
  block: 5,
  escalate: 6,
};

export function aggregateResults(
  allViolations: GuardrailViolation[],
  originalContent: string,
): GuardrailPipelineResult {
  const result = createEmptyPipelineResult();

  const warnings: GuardrailViolation[] = [];
  const terminalViolations: GuardrailViolation[] = [];
  const nonTerminalViolations: GuardrailViolation[] = [];

  for (const v of allViolations) {
    if (v.action === 'warn') {
      warnings.push(v);
    } else if (isTerminalAction(v.action)) {
      terminalViolations.push(v);
    } else {
      nonTerminalViolations.push(v);
    }
  }

  result.warnings = warnings;
  result.metrics.warnings = warnings.length;

  if (terminalViolations.length > 0) {
    result.passed = false;
    result.violations = [...terminalViolations, ...nonTerminalViolations];
    result.metrics.failed = result.violations.length;
    // Primary = highest precedence terminal action
    result.primaryViolation = terminalViolations.sort(
      (a, b) => (ACTION_PRECEDENCE[b.action] ?? 0) - (ACTION_PRECEDENCE[a.action] ?? 0),
    )[0];
  } else {
    result.passed = true;
    result.violations = nonTerminalViolations;
    result.metrics.failed = nonTerminalViolations.length;
  }

  result.metrics.totalChecks = allViolations.length;
  result.metrics.passed =
    result.metrics.totalChecks - result.metrics.failed - result.metrics.warnings;

  return result;
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/compiler && pnpm vitest run src/__tests__/guardrails/result-aggregator.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/compiler/src/platform/guardrails/result-aggregator.ts packages/compiler/src/__tests__/guardrails/result-aggregator.test.ts
git commit -m "[ABLP-2] feat(compiler): add guardrail result aggregator with action precedence rules"
```

---

### Task 12: Runtime Integration — Input and Output Hooks

Wire the guardrail pipeline into `runtime-executor.ts` at the two critical execution points: before LLM call (input guardrails) and after LLM response (output guardrails).

**Files:**

- Modify: `apps/runtime/src/services/runtime-executor.ts` (input hook ~line 1337, output hook after LLM response)
- Modify: `apps/runtime/src/services/execution/constraint-checker.ts` (enhance to use pipeline)
- Test: `apps/runtime/src/__tests__/guardrails/runtime-integration.test.ts`

**Step 1: Write the failing test**

```typescript
// apps/runtime/src/__tests__/guardrails/runtime-integration.test.ts
import { describe, it, expect, vi } from 'vitest';
import { GuardrailPipelineImpl } from '@agent-platform/compiler/platform/guardrails/pipeline';
import type { Guardrail, GuardrailKind } from '@agent-platform/compiler/platform/ir/schema';

// Test that the pipeline can be invoked with runtime session data
describe('Runtime guardrail integration', () => {
  it('should evaluate input guardrails before LLM', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails: Guardrail[] = [
      {
        name: 'pii_block',
        description: 'Block PII',
        kind: 'input',
        priority: 1,
        tier: 'local',
        check: 'abl.contains_pii(input)',
        action: { type: 'block', message: 'PII not allowed' },
      },
    ];

    const result = await pipeline.execute(guardrails, 'My SSN is 123-45-6789', 'input', {
      agentGoal: 'Help users',
    });

    expect(result.passed).toBe(false);
    expect(result.primaryViolation?.name).toBe('pii_block');
  });

  it('should pass clean input', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails: Guardrail[] = [
      {
        name: 'pii_block',
        description: 'Block PII',
        kind: 'input',
        priority: 1,
        tier: 'local',
        check: 'abl.contains_pii(input)',
        action: { type: 'block', message: 'PII not allowed' },
      },
    ];

    const result = await pipeline.execute(guardrails, 'I want to book a hotel', 'input', {
      agentGoal: 'Help users book hotels',
    });

    expect(result.passed).toBe(true);
  });

  it('should evaluate output guardrails after LLM', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails: Guardrail[] = [
      {
        name: 'output_length',
        description: 'Output length check',
        kind: 'output',
        priority: 1,
        tier: 'local',
        check: 'abl.length(output) > 10',
        action: { type: 'warn', message: 'Long response' },
      },
    ];

    const result = await pipeline.execute(
      guardrails,
      'This is a moderately long response from the LLM',
      'output',
      {},
    );

    expect(result.passed).toBe(true);
    expect(result.warnings).toHaveLength(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/guardrails/runtime-integration.test.ts`
Expected: FAIL — test file doesn't exist yet, imports may need adjustment

**Step 3: Write integration code**

The runtime executor needs to:

1. After loading the agent IR, extract `agentIR.constraints.guardrails`
2. Before LLM call: `pipeline.execute(guardrails, userMessage, 'input', context)`
3. After LLM response: `pipeline.execute(guardrails, llmResponse, 'output', context)`
4. Handle violations (block → return error, redact → use modified content, warn → emit trace)

In `apps/runtime/src/services/runtime-executor.ts`, near line 1337 where `checkConstraints` is called:

```typescript
// Import at top of file
import { GuardrailPipelineImpl } from '@agent-platform/compiler/platform/guardrails/pipeline';

// In the executor class or near checkConstraints call:
const guardrailPipeline = new GuardrailPipelineImpl();

// Before LLM call (input guardrails):
const inputResult = await guardrailPipeline.execute(
  agentIR.constraints?.guardrails ?? [],
  userMessage,
  'input',
  { agentGoal: agentIR.goal },
  onTraceEvent,
);

if (!inputResult.passed) {
  // Return violation response to user
  return this.handleGuardrailViolation(session, inputResult, onChunk, onTraceEvent);
}
const processedInput = inputResult.modifiedContent ?? userMessage;

// After LLM response (output guardrails):
const outputResult = await guardrailPipeline.execute(
  agentIR.constraints?.guardrails ?? [],
  llmResponse,
  'output',
  { agentGoal: agentIR.goal },
  onTraceEvent,
);

if (!outputResult.passed) {
  return this.handleGuardrailViolation(session, outputResult, onChunk, onTraceEvent);
}
const deliveredResponse = outputResult.modifiedContent ?? llmResponse;
```

**Step 4: Run all tests**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/guardrails/`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/runtime/src/services/runtime-executor.ts apps/runtime/src/__tests__/guardrails/
git commit -m "[ABLP-2] feat(runtime): integrate guardrail pipeline at input/output execution points"
```

---

## Phase 3: Provider System

### Task 13: GuardrailModelProvider Interface

Define the provider interface and evaluation types (design doc Section 8.1).

**Files:**

- Create: `packages/compiler/src/platform/guardrails/provider.ts`
- Test: `packages/compiler/src/__tests__/guardrails/provider-interface.test.ts`

This defines: `GuardrailModelProvider`, `GuardrailEvalRequest`, `GuardrailEvalResult`. See design doc Section 8.1 for exact interface shapes. The test validates that adapters can implement the interface and return proper results.

---

### Task 14: Built-in PII Provider

Wrap the existing `pii-detector.ts` as a `GuardrailModelProvider` — always available, no external dependencies.

**Files:**

- Create: `packages/compiler/src/platform/guardrails/providers/builtin-pii.ts`
- Test: `packages/compiler/src/__tests__/guardrails/providers/builtin-pii.test.ts`

Implements `GuardrailModelProvider` interface. `evaluate()` calls `detectPII()` and returns a score (1.0 if PII found, 0.0 if not). `isAvailable()` always returns true. `costPerEvalUsd` is 0.

---

### Task 15: OpenAI-Compatible Provider Adapter

Adapter for vLLM, TGI, Ollama, and any OpenAI-compatible endpoint. Sends chat completion with taxonomy prompt, parses safe/unsafe + categories + score.

**Files:**

- Create: `packages/compiler/src/platform/guardrails/providers/openai-compatible.ts`
- Test: `packages/compiler/src/__tests__/guardrails/providers/openai-compatible.test.ts`

Uses `fetch()` to call `POST /v1/chat/completions`. Constructs a safety evaluation prompt including the category and content. Parses the model's response for safe/unsafe verdict and confidence score. Handles timeout, retry, and error classification per Appendix A.6.

---

### Task 16: OpenAI Moderation API Provider

Adapter for OpenAI's free Moderation API (`/v1/moderations`). Maps per-category boolean flags + scores.

**Files:**

- Create: `packages/compiler/src/platform/guardrails/providers/openai-moderation.ts`
- Test: `packages/compiler/src/__tests__/guardrails/providers/openai-moderation.test.ts`

Calls `POST /v1/moderations` with text content. Maps OpenAI's category scores (hate, sexual, violence, etc.) to our 0.0-1.0 scale. Returns the highest score for the requested category.

---

### Task 17: Custom HTTP Provider

Configurable adapter for arbitrary HTTP APIs using Handlebars templates and JSONPath response mapping. Includes SSRF protection and template security controls (Appendix A.4).

**Files:**

- Create: `packages/compiler/src/platform/guardrails/providers/custom-http.ts`
- Test: `packages/compiler/src/__tests__/guardrails/providers/custom-http.test.ts`

Key security controls:

- Handlebars strict mode
- No custom helpers
- Template size limit (4KB)
- SSRF protection (block private IP ranges, metadata endpoints)
- Response size limit (1MB)

---

### Task 18: Provider Registry and Circuit Breaker

Provider registry that initializes adapters from tenant config, applies project overrides, and manages circuit breaker state in Redis (design doc Section 8.3 and Section 18).

**Files:**

- Create: `packages/compiler/src/platform/guardrails/provider-registry.ts`
- Create: `packages/compiler/src/platform/guardrails/circuit-breaker.ts`
- Test: `packages/compiler/src/__tests__/guardrails/provider-registry.test.ts`
- Test: `packages/compiler/src/__tests__/guardrails/circuit-breaker.test.ts`

Circuit breaker implements CLOSED → OPEN → HALF-OPEN state machine with Redis-backed state. Provider registry loads configs from MongoDB, creates adapter instances via factory, caches per tenant+project.

---

## Phase 4: Policy Engine

### Task 19: MongoDB Models — GuardrailPolicy and TenantGuardrailProviderConfig

Create Mongoose models following existing patterns (tenantIsolationPlugin, timestamps, indexes).

**Files:**

- Create: `packages/database/src/models/guardrail-policy.model.ts`
- Create: `packages/database/src/models/guardrail-provider-config.model.ts`
- Modify: `packages/database/src/models/index.ts` (export new models)

Follow patterns from `packages/database/src/models/tenant-model.model.ts` and `packages/database/src/models/llm-credential.model.ts`. Use `tenantIsolationPlugin` for all queries, `encryptionPlugin` for `apiKeyCredentialId` references, `uuidv7` for `_id`.

---

### Task 20: Policy Resolution Service

Service that resolves merged guardrail policy for a tenant+project+agent scope, with Redis caching (design doc Section 6.5 and Appendix A.7).

**Files:**

- Create: `apps/runtime/src/services/guardrails/policy-resolver.ts`
- Test: `apps/runtime/src/__tests__/guardrails/policy-resolver.test.ts`

Resolution chain: Agent DSL → Project policy → Tenant policy. Redis cache key: `guardrail:policy:{tenantId}:{projectId}:{agentDefId}`, TTL 5 minutes. Invalidation on policy save.

---

### Task 21: Admin API — Guardrail Provider CRUD

REST API for managing tenant-level guardrail providers (design doc Section 24.0).

**Files:**

- Create: `apps/runtime/src/routes/guardrail-providers.ts`
- Test: `apps/runtime/src/__tests__/guardrails/provider-routes.test.ts`

Routes: `GET/POST /api/guardrail-providers`, `GET/PUT/DELETE /api/guardrail-providers/:id`, `POST /api/guardrail-providers/:id/test`. Requires tenant admin permission. Uses `requireAuth` + `requirePermission('guardrail_providers:manage')`.

---

### Task 22: Admin API — Guardrail Policy CRUD

REST API for managing project-level guardrail policies (design doc Section 24.1).

**Files:**

- Create: `apps/runtime/src/routes/guardrail-policies.ts`
- Test: `apps/runtime/src/__tests__/guardrails/policy-routes.test.ts`

Routes: `GET/POST /api/projects/:projectId/guardrail-policies`, `PUT /api/projects/:projectId/guardrail-policies/:id`, `POST /api/projects/:projectId/guardrail-policies/:id/activate`. Uses `requireProjectPermission(req, res, 'guardrail_policies:manage')`.

---

### Task 23: Wire Pipeline to Policy Resolution

Update the pipeline to resolve policies from the policy service instead of only using IR-compiled guardrails.

**Files:**

- Modify: `packages/compiler/src/platform/guardrails/pipeline.ts`
- Test: Update `packages/compiler/src/__tests__/guardrails/pipeline.test.ts`

The pipeline accepts an optional `PolicyResolver` that, when provided, merges policies from MongoDB with IR-compiled guardrails per the resolution rules in Section 6.5.

---

## Phase 5: Tool & Handoff Rails

### Task 24: Tool Input Guardrails

Wire guardrail pipeline into the tool execution loop — evaluate `tool_input` guardrails before tool execution.

**Files:**

- Modify: `apps/runtime/src/services/runtime-executor.ts` (tool execution section)
- Test: `apps/runtime/src/__tests__/guardrails/tool-rails.test.ts`

Before each tool call, run `pipeline.execute(guardrails, JSON.stringify(toolCall.parameters), 'tool_input', { toolName, toolParameters })`. If blocked, return tool error to LLM. If redacted, use modified parameters.

---

### Task 25: Tool Output Guardrails

Evaluate `tool_output` guardrails after tool execution, before results reach the LLM.

**Files:**

- Modify: Same as Task 24
- Test: Same as Task 24

After tool execution, run `pipeline.execute(guardrails, JSON.stringify(toolResult), 'tool_output', { toolName, toolResult })`. If redacted, pass modified result to LLM.

---

### Task 26: Handoff Guardrails

Evaluate `handoff` guardrails in the HandoffExecutor before context transfer between agents.

**Files:**

- Modify: `packages/compiler/src/platform/constructs/executors/handoff-executor.ts` (or equivalent in runtime)
- Test: `apps/runtime/src/__tests__/guardrails/handoff-rails.test.ts`

Before handoff context transfer, run `pipeline.execute(guardrails, handoffContext, 'handoff', { sourceAgent, targetAgent, handoffReason })`. If blocked, cancel handoff. If redacted, transfer modified context.

---

## Phase 6: Advanced Features

### Task 27: Tier 2 Evaluator — Model-Based Checks

Wire the provider registry into the pipeline for Tier 2 evaluation. Execute model-based guardrails in parallel, apply severity-based action mapping.

**Files:**

- Create: `packages/compiler/src/platform/guardrails/tier2-evaluator.ts`
- Test: `packages/compiler/src/__tests__/guardrails/tier2-evaluator.test.ts`

For each Tier 2 guardrail: check circuit breaker → call provider.evaluate() → compare score to threshold → map severity → apply severity_actions if defined. All guardrails run in parallel. Track cost per provider.

---

### Task 28: Tier 3 Evaluator — LLM-Based Checks

Wire LLM-based evaluation for Tier 3 guardrails, including constitution principle batching (Appendix A.14).

**Files:**

- Create: `packages/compiler/src/platform/guardrails/tier3-evaluator.ts`
- Test: `packages/compiler/src/__tests__/guardrails/tier3-evaluator.test.ts`

For `llm_check` guardrails: construct evaluation prompt with the check text, content, and context. Parse score from LLM response. For constitution principles: batch up to 20 per LLM call, parse per-principle scores from structured JSON response.

---

### Task 29: Exact Match Caching (Redis)

Implement exact-match guardrail result caching in Redis (design doc Section 16).

**Files:**

- Create: `apps/runtime/src/services/guardrails/cache.ts`
- Test: `apps/runtime/src/__tests__/guardrails/cache.test.ts`

Cache key: `guardrail:{tenantId}:{projectId}:{guardrailName}:{sha256(content)}`. Stores `{ verdict, modifiedContent? }`. TTL: 24h for Tier 1, 1h for Tier 2. No caching for Tier 3 (context-dependent). Cache stores hash of original content, returns both verdict and redacted content on hit.

---

### Task 30: Cost Tracking

Implement cost tracking with integer microdollars in Redis, budget enforcement, and tier downgrade (design doc Section 19 and Appendix A.11).

**Files:**

- Create: `apps/runtime/src/services/guardrails/cost-tracker.ts`
- Test: `apps/runtime/src/__tests__/guardrails/cost-tracker.test.ts`

Redis key: `guardrail:cost:{tenantId}:{projectId}:{YYYY-MM}`, value in microdollars (1 USD = 1,000,000). Uses `INCRBY` (not `INCRBYFLOAT`). Budget check before Tier 2/3: if exceeded and policy says 'downgrade', skip those tiers.

---

### Task 31: Streaming Guardrail Evaluator

Implement `StreamingGuardrailEvaluator` with sentence/chunk buffering, Tier 1 mid-stream checks, and SSE retract events (design doc Section 15).

**Files:**

- Create: `apps/runtime/src/services/guardrails/streaming-evaluator.ts`
- Test: `apps/runtime/src/__tests__/guardrails/streaming-evaluator.test.ts`

`evaluateChunk()`: on sentence boundary → run Tier 1 checks on accumulated text. If violation + earlyTermination → return 'terminate'. Tier 2 model checks run async on sentence boundaries with token buffering. `evaluateFinal()`: run full pipeline on complete response.

---

### Task 32: Trace Events and Webhook Delivery

Implement all guardrail trace events (Section 23.1) and async webhook delivery with HMAC-SHA256 signing and retry logic (Section 23.2-23.3).

**Files:**

- Create: `apps/runtime/src/services/guardrails/trace-events.ts`
- Create: `apps/runtime/src/services/guardrails/webhook.ts`
- Test: `apps/runtime/src/__tests__/guardrails/trace-events.test.ts`
- Test: `apps/runtime/src/__tests__/guardrails/webhook.test.ts`

Trace events: `guardrail_check`, `guardrail_violation`, `guardrail_warning`, `guardrail_fix`, `guardrail_reask`, `guardrail_pipeline_complete`, `guardrail_cost`, `guardrail_circuit_breaker`, `guardrail_cache_hit`, `guardrail_provider_error`.

Webhook: HMAC-SHA256 signature in `X-Guardrail-Signature` header. 3 retries with exponential backoff (1s, 4s, 16s). 10s timeout. Dead letter queue in MongoDB.

---

## Build and Test Commands

```bash
# Build (required before tests)
pnpm build

# Run all guardrail tests in compiler
cd packages/compiler && pnpm vitest run src/__tests__/guardrails/

# Run all guardrail tests in runtime
cd apps/runtime && pnpm vitest run src/__tests__/guardrails/

# Run full test suite
pnpm test

# Lint
pnpm lint
```

## Dependencies Between Tasks

```
Phase 1: 1 → 2 → 3, 4 → 5, 6 (Task 1 needed by 2; Tasks 4,5,6 can be parallel after 1)
Phase 2: 7 → 8 → 9 → 10 → 11 → 12 (sequential — each builds on previous)
Phase 3: 13 → 14, 15, 16, 17 (parallel adapters) → 18
Phase 4: 19 → 20 → 21, 22 (parallel APIs) → 23
Phase 5: 24, 25 → 26 (24+25 parallel, 26 depends on pipeline)
Phase 6: 27, 28, 29, 30, 31, 32 (mostly parallel)
```

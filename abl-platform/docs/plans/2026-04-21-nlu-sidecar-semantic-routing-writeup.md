# NLU Sidecar Semantic Routing Write-Up

**Date:** 2026-04-21  
**Status:** Draft architecture note  
**Scope:** gather interrupts, sub-intents, parent-supervisor reroute, semantic sidecar options

## Why this note exists

Today, flow-mode semantic routing for `GATHER` interruptions and parent-supervisor reroutes is implemented in the runtime pipeline classifier and depends on an LLM-backed intent-classification path. At the same time, the repo already contains an embedding-capable NLU engine and a separate NLU sidecar lane, but those pieces are not the active semantic-routing path for gather escapes.

This note documents:

- what semantic routing does today
- what the NLU sidecar actually provides today
- what semantic capabilities already exist elsewhere in the platform
- which small semantic models are good candidates for a sidecar
- what should be implemented next if we want semantic routing to be closer to a dedicated NLU subsystem and less dependent on the main LLM path

## Current state

### 1. Semantic routing in flow runtime today

The active flow runtime path uses the pipeline classifier, not embeddings, for semantic routing:

- `apps/runtime/src/services/execution/flow-step-executor.ts`
  - `detectFlowEscapeMatch()` handles `DIGRESSIONS` and `SUB_INTENTS`
  - `detectParentSupervisorRoute()` handles child-agent return-to-parent reroute
- `apps/runtime/src/services/pipeline/classifier.ts`
  - `classify()` performs LLM-backed intent classification
- `apps/runtime/src/services/pipeline/routing-resolver.ts`
  - `resolveRouting()` maps classified categories to routing targets

Behaviorally:

1. The runtime tries the pipeline classifier when pipeline is enabled, a model can be resolved, and the classifier is actionable.
2. If the classifier returns a valid routing match, the flow routes semantically.
3. If the classifier runs and effectively rejects the reroute, the current step is preserved.
4. If the classifier is unavailable or skipped, the runtime falls back to lexical matching.

This means the current semantic path is:

- fast LLM classifier first
- lexical fallback second

Embeddings are not consulted by `detectFlowEscapeMatch()` or `detectParentSupervisorRoute()` today.

### 2. What the NLU sidecar lane provides today

The runtime already has a sidecar integration surface:

- `apps/runtime/src/services/nlu/sidecar-client.ts`
  - `health()`
  - `extract()`
  - `detectCorrection()`
  - self-contained circuit breaker
- `apps/runtime/src/services/execution/flow-step-executor.ts`
  - Tier-2 entity extraction via `session._nluSidecarClient.extract(...)`
  - Tier-2 correction detection via `session._nluSidecarClient.detectCorrection(...)`
- `apps/runtime/src/routes/project-runtime-config.ts`
  - project config for `nlu_provider`, `advanced_sidecar_url`, timeout, circuit-breaker threshold
- `apps/runtime/src/services/config/project-runtime-config-resolver.ts`
  - resolves sidecar-related runtime config into project IR

The gather extraction path is already tiered:

1. JS libraries for typed extraction
2. NLU sidecar
3. LLM extraction
4. regex fallback

Correction detection is also tiered:

1. regex
2. NLU sidecar
3. LLM

### 3. What is missing in the sidecar today

The Python sidecar server is still a stub:

- `apps/nlu-sidecar/app.py`
  - `/health` returns OK
  - `/extract` returns empty entities
  - `/detect-correction` returns `is_correction: false`
  - no real semantic model is wired
  - no intent-ranking endpoint exists

So the current sidecar lane is operationally useful as a contract and fallback boundary, but not yet as a real semantic-NLU service.

### 4. What already exists in the compiler-side NLU engine

There is a richer NLU subsystem in `packages/compiler/src/platform/nlu/`:

- `engine.ts`
  - multi-layer NLU orchestration
  - plugins -> embeddings -> LLM -> fallback
- `embeddings/intent-index.ts`
  - in-memory intent embedding index
- `embeddings/entity-index.ts`
  - embedding-based entity index
- `embeddings/provider.ts`
  - OpenAI-compatible HTTP embedding provider
- `tasks/`
  - intent detection
  - sub-intent detection
  - digression detection
  - category classification
  - entity extraction
  - correction detection
  - language detection
  - combined analysis
- `types.ts`
  - plugin hooks
  - metrics interfaces
  - multi-intent support
  - embeddings configuration

Important point:

The compiler-side NLU engine already knows how to do embedding-first intent detection, but that engine is not the active path used by flow gather interrupts in `flow-step-executor.ts`.

## What the NLU sidecar can reasonably own

If we want routing to be closer to a dedicated NLU subsystem, the sidecar should own the semantic parts that are:

- finite-candidate
- low latency
- explainable
- independent of the main reasoning loop

That means the sidecar is a good fit for:

- gather digression ranking
- sub-intent ranking inside a step
- parent-supervisor reroute ranking
- correction classification
- typed entity extraction and normalization

It is not the right place for:

- arbitrary free-form reasoning
- open-ended dialog planning
- final agent response generation

## Why embeddings are a good fit here

For gather interrupts and supervisor reroutes, the candidate set is small and explicit. That is a strong fit for embedding-based ranking.

Benefits:

- works even when the main pipeline LLM is unavailable
- better paraphrase recall than exact lexical matching
- deterministic thresholding and top-k inspection
- fast enough for inline routing, including CPU-friendly deployment with small models
- can produce better traces than opaque regex fallback

Constraints:

- still needs explicit candidate surfaces
- threshold tuning matters
- English-only models are risky for multilingual projects
- embeddings alone are weak at hard negatives unless we add margin/gap rules

## Small semantic model options for the sidecar

The sidecar should treat the embedding model as a routing encoder, not as a general-purpose generation model. For this use case, small bi-encoders are the best fit.

### Recommended model set

| Model                                    | Best use                                                     | Why it fits                                                                                              | Caveats                                                    |
| ---------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `sentence-transformers/all-MiniLM-L6-v2` | English, smallest and fastest baseline                       | Very small footprint, simple CPU deployment, strong generic semantic similarity baseline                 | English only, shorter context window                       |
| `BAAI/bge-small-en-v1.5`                 | English retrieval-style routing                              | Strong retrieval behavior, no instruction required in v1.5, good default for intent/example ranking      | English only                                               |
| `intfloat/e5-small-v2`                   | English retrieval with disciplined query/document formatting | Strong retrieval-oriented encoder, compact output size                                                   | Requires `query:` / `passage:` formatting for best quality |
| `intfloat/multilingual-e5-small`         | Multilingual routing                                         | Best small multilingual option in this repo-aligned model class                                          | Larger than MiniLM-class English models                    |
| `jinaai/jina-embeddings-v2-small-en`     | English with longer utterances or long example payloads      | Small model with long-context support                                                                    | English only, custom-code serving considerations           |
| `BAAI/bge-m3`                            | Existing platform-aligned multilingual fallback              | Already familiar in the platform, multilingual, can support dense/sparse/multi-vector retrieval patterns | Not a "small" model; higher serving cost than the others   |

### Practical recommendation

If we want a sidecar that is simple and cheap:

- English-only, lowest-latency baseline: `BAAI/bge-small-en-v1.5`
- English-only, smallest footprint: `sentence-transformers/all-MiniLM-L6-v2`
- Multilingual default: `intfloat/multilingual-e5-small`
- Reuse existing platform embedding infra: `BAAI/bge-m3`

## Model decision criteria beyond raw accuracy

We should not choose a semantic routing model only from offline precision/recall. The sidecar or semantic service profile is part of the synchronous execution path, so operational characteristics belong in the decision matrix.

| Criterion               | Why it matters                                                                                  | What the platform should record per profile                     |
| ----------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Accuracy / recall       | Determines whether the profile catches true interrupts without over-routing normal gather input | Labeled interrupt precision/recall metrics by scenario family   |
| Multilingual support    | Projects may serve one language, many languages, or language-switching users                    | Supported locales/languages and multilingual validation results |
| Memory footprint        | Affects node sizing, pooling strategy, and whether CPU deployment is even feasible              | Peak RSS / VRAM and minimum memory reservation                  |
| Throughput              | Determines whether a profile can sustain live traffic at acceptable queue depth                 | Target QPS per replica at accepted latency                      |
| Concurrent requests     | Saturation often appears first as queueing under bursty load                                    | Max safe in-flight request envelope before SLO breach           |
| Latency                 | Gather interrupts sit on the critical path of interactive turns                                 | P50 / P95 / timeout rate by candidate-set size                  |
| CPU / GPU support       | Some profiles are viable on CPU, others need GPU to meet latency budgets                        | Supported hardware classes and recommended deployment mode      |
| Cold start / model load | Pool scaling and failover depend on startup behavior                                            | Warmup time, load time, minimum warm replica recommendation     |
| Batching behavior       | Some models need batching for throughput while others are optimized for single-request latency  | Supports batching, optimal batch size, latency tradeoffs        |
| Input tolerance         | Candidate-set size and utterance length affect semantic ranking quality                         | Max practical utterance size and candidate count                |

The selection contract should treat these as first-class profile metadata, not informal benchmark notes.

## Why a service pool is better than a project-side URL

The current `advanced_sidecar_url` field is fine as a bootstrap contract, but it pushes deployment topology into tenant/project configuration. That creates several problems:

- projects must know concrete endpoint topology rather than expressing an intent such as “use the multilingual balanced semantic router”
- it is hard to swap models, autoscale pools, or fail over between instances without rewriting config
- raw URLs do not express hardware class, capacity envelope, or multilingual capability
- tenant governance becomes awkward because the control plane cannot easily allowlist or deny model classes without managing raw endpoints

The better long-term contract is:

- tenant or project selects a **logical service profile**
- the platform resolves that profile to a **healthy container pool**
- runtime dispatch uses service discovery, not hard-coded URLs, to reach a replica

## Proposed service-pool architecture

### Service types

The platform should manage semantic services by logical type, for example:

- `semantic-router`
- `memory-compactor`
- `memory-store`
- `entity-extractor`
- `correction-detector`
- `summary`

Each service type can have multiple service profiles.

### Service profiles

Example semantic-router profile ids:

- `english-fast-cpu`
- `multilingual-balanced`
- `multilingual-high-recall-gpu`

Example memory-compactor profile ids:

- `chat-compact-fast`
- `chat-compact-balanced`
- `chat-compact-high-fidelity`

Each profile should publish:

- model family
- language coverage
- hardware class
- memory requirement
- target QPS per replica
- max concurrent requests
- target p95 latency
- batching support
- accuracy / precision / recall tier
- token-budget behavior when the service type is `memory-compactor`
- structured-output capability when the service type is `memory-compactor`
- fidelity tier when the service type is `memory-compactor`

### Tenant and project choice

The policy split should be:

- **tenant policy**
  - allowed service profiles per service type
  - default service profile per service type
  - allowed hardware classes
  - concurrency or cost guardrails
- **project choice**
  - inherit tenant default, or
  - select an allowed service profile override
  - optionally express objective: low latency, balanced, high recall, multilingual, or state fidelity

This keeps platform control and tenant governance intact while still letting projects make product-specific tradeoffs.

### Runtime resolution flow

The runtime path should become:

1. Read tenant policy and project service choice for the requested service type.
2. Resolve the selected logical service profile.
3. Discover a healthy pool for that profile.
4. Dispatch the ranking request to a replica in that pool.
5. Apply service-specific policy.
   - For `semantic-router`: threshold / margin policy, then continue to lexical fallback or optional LLM adjudication if needed.
   - For `memory-compactor`: target token-budget and fidelity policy, then return a structured compaction result.

This is a better fit than storing a raw URL in project config for every semantic feature.

## Where compaction fits

Compaction should be treated as an internal memory-management primitive, not as a user-facing summary feature.

- `semantic-router` answers: "Did the user change intent right now?"
- `memory-compactor` answers: "How do we preserve enough conversation state for later turns within a target token budget?"
- `summary` answers: "What concise output should the user or operator read?"
- `memory-store` answers: "What durable facts should survive across sessions?"

That distinction matters because compaction quality is not the same thing as summary quality. A readable paragraph can still be a bad compaction artifact if it drops open tasks, preferences, auth state, or important carry-forward facts.

Recommended compaction result shape:

```text
MemoryCompactionResult:
  - summaryText: string
  - mustKeepFacts: string[]
  - openTasks: string[]
  - userPreferences: string[]
  - authOrSessionState: string[]
  - sourceMessageRange:
      - startIndex: number
      - endIndex: number
  - targetTokenBudget: number
  - estimatedOutputTokens: number
```

## Hosted equivalents and managed-provider mapping

If we want managed equivalents instead of only self-hosted containers, the service-profile contract should map to provider-native capabilities where they exist.

| Provider          | `semantic-router` equivalent                                           | `memory-compactor` equivalent                            | `summary` equivalent                          | Planning note                                                                                           |
| ----------------- | ---------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Amazon Bedrock    | Managed embedding + reranker stack                                     | Native Claude compaction                                 | Chat-model summarization                      | Strongest native compaction fit                                                                         |
| Azure Foundry     | Managed embedding / rerank models                                      | Foundry memory stores plus app-managed compactor         | Foundry models or Azure Language summary flow | Strong memory primitives, but compaction still needs a platform contract                                |
| Vertex AI         | Google embeddings plus Ranking API                                     | Context caching plus app-managed compactor               | Gemini summarization                          | Context caching is useful but should not be confused with compaction                                    |
| OCI Generative AI | Managed embeddings, rerank, and chat                                   | Chat-model or summarization-backed app-managed compactor | OCI summarization or chat models              | Keep compaction as a platform layer above provider APIs                                                 |
| Databricks        | Hosted embedding APIs including Qwen-style semantic retrieval profiles | App-managed compactor on top of hosted chat models       | Chat-model summarization                      | Useful as a managed semantic lane; compaction remains a logical service type rather than a raw endpoint |

These should be treated as profile mappings, not as direct product-facing configuration keys.

## What the sidecar supports today

Today the sidecar contract supports:

- health checks
- entity extraction request/response
- correction detection request/response
- runtime circuit breaker
- project-scoped configuration
- graceful fallback to non-sidecar tiers

That means the sidecar lane is already suitable for adding more semantic endpoints without redesigning the runtime contract.

## What should be implemented next

### 1. Add a semantic intent-ranking endpoint

Add a sidecar endpoint for ranking finite candidate sets:

`POST /semantic-match`

Suggested request:

```json
{
  "text": "get atms near me",
  "locale": "en",
  "task": "flow_escape",
  "top_k": 3,
  "threshold": 0.76,
  "candidates": [
    {
      "id": "atm_locator",
      "phrases": ["find ATM", "ATM locator", "nearby ATM"],
      "examples": ["Find an ATM near me", "Where is the nearest cash machine?"],
      "keywords": ["atm", "branch", "cash machine"]
    }
  ]
}
```

Suggested response:

```json
{
  "selected": {
    "id": "atm_locator",
    "score": 0.84,
    "matched_text": "Find an ATM near me"
  },
  "top_k": [
    { "id": "atm_locator", "score": 0.84 },
    { "id": "speak_to_agent", "score": 0.29 }
  ],
  "threshold": 0.76,
  "accepted": true
}
```

### 2. Add a compaction contract alongside semantic ranking

If we introduce a shared service-pool control plane, compaction should be a first-class service type from the beginning rather than an afterthought.

Suggested project config shape:

```json
{
  "memory_compaction": {
    "provider": "service_pool",
    "service_type": "memory-compactor",
    "service_profile": "chat-compact-balanced",
    "hardware_preference": "auto",
    "objective": "state_fidelity",
    "latency_budget_ms": 250,
    "target_token_budget": 1200,
    "structured_output": true,
    "fallback_policy": "preserve_recent_messages"
  }
}
```

Suggested response contract:

```json
{
  "summary_text": "The user wants to find a nearby ATM after checking balance.",
  "must_keep_facts": ["User asked for account balance", "User then switched to ATM lookup"],
  "open_tasks": ["Continue branch or ATM lookup if the user returns to that flow"],
  "user_preferences": [],
  "auth_or_session_state": ["Authentication not yet completed"],
  "target_token_budget": 1200,
  "estimated_output_tokens": 215
}
```

### 3. Replace raw sidecar URL selection with logical service-profile selection

Instead of making semantic routing choose a literal sidecar URL, introduce:

- a tenant-level allowlist and default profile per service type
- a project-level selected profile per service type
- a platform-managed registry that maps profile ids to container pools

That means the future control-plane contract should look more like:

```json
{
  "semantic_routing": {
    "provider": "service_pool",
    "service_type": "semantic-router",
    "service_profile": "multilingual-balanced",
    "hardware_preference": "auto",
    "objective": "balanced",
    "latency_budget_ms": 80
  },
  "memory_compaction": {
    "provider": "service_pool",
    "service_type": "memory-compactor",
    "service_profile": "chat-compact-balanced",
    "hardware_preference": "auto",
    "objective": "state_fidelity",
    "latency_budget_ms": 250
  }
}
```

and less like:

```json
{
  "extraction": {
    "advanced_sidecar_url": "http://specific-host:8090"
  }
}
```

The URL shape can remain for local development or platform-admin overrides, but it should not be the primary product contract.

### 4. Compile an explicit semantic surface for routing

Do not rely on tokenized descriptions as the semantic source of truth.

Instead, compile routing candidates from:

- `INTENTS`
- `DIGRESSIONS`
- `SUB_INTENTS`
- explicit examples
- explicit lexical hints
- normalized keywords

This compiled surface should be the input to both:

- deterministic exact matching
- semantic embedding ranking

### 5. Make routing policy explicit

Introduce an execution policy like:

- `semantic_provider: llm_pipeline | embedding_sidecar | hybrid`

Suggested behavior:

- `llm_pipeline`
  - current behavior
- `embedding_sidecar`
  - exact deterministic -> embedding sidecar -> stop
- `hybrid`
  - exact deterministic -> embedding sidecar -> optional LLM only for ambiguous cases

For gather interrupts and parent reroutes, `embedding_sidecar` or `hybrid` is a better long-term default than "LLM first, lexical second."

### 6. Add observability for sidecar decisions

Every semantic routing decision should emit:

- candidate count
- top-k candidates
- selected score
- threshold
- score gap to runner-up
- matched example or phrase
- decision source: `exact` | `normalized` | `embedding_sidecar` | `llm_pipeline`

This is especially important for debugging false positives and false negatives.

Compaction decisions should also emit:

- target token budget
- estimated output tokens
- fidelity tier
- structured-output flag
- decision source: `provider_native` | `app_managed`

### 7. Implement real sidecar extraction models

The sidecar can also become the home for:

- NER for `location`, `person`, `organization`
- email / phone / account / routing-number normalization
- date normalization support around locale and timezone
- correction classification
- lookup-aware canonicalization

That keeps the runtime flow executor focused on orchestration instead of ML serving.

## Recommended target architecture

### Routing path

Recommended future flow for gather interrupts:

1. Deterministic exact match against compiled surface
2. Deterministic normalized match against compiled surface
3. Embedding sidecar ranking against examples and hints
4. Optional ambiguity resolver only when score is in a gray zone
5. Preserve current step if nothing clears threshold

### Memory path

Recommended future flow for active-conversation memory handling:

1. Keep recent turns verbatim while under budget
2. Trigger `memory-compactor` when the configured threshold is crossed
3. Store structured compaction output back into session state
4. Preserve critical session facts outside the compacted prose block
5. Optionally sync durable memories into `memory-store` on inactivity or session close

### Why this is better than LLM-first

- no dependence on pipeline model resolution for common interrupt cases
- cheaper than LLM classification
- more explainable than "classifier said no"
- better recall than exact lexical matching
- easier to keep consistent across `DIGRESSIONS`, `SUB_INTENTS`, and supervisor reroute

## Phased implementation plan

### Phase 1: semantic ranking for flow escapes

- add `/semantic-match` to `apps/nlu-sidecar/app.py`
- add `matchIntent()` or `semanticMatch()` to the runtime sidecar client
- compile candidate examples/hints for `DIGRESSIONS`, `SUB_INTENTS`, and supervisor categories
- wire `detectFlowEscapeMatch()` to the sidecar path
- wire `detectParentSupervisorRoute()` to the sidecar path
- add traces for score, threshold, and top-k

### Phase 2: model-backed sidecar

- start with one English model and one multilingual model
- add at least one `memory-compactor` profile alongside semantic-router profiles
- keep per-project service-profile config explicit
- add in-memory index cache keyed by agent/supervisor hash
- add TTL / version invalidation

### Phase 3: ambiguity handling

- add gap-threshold logic
- only escalate ambiguous cases to the pipeline LLM when policy allows
- keep the default fail-closed if ambiguity remains unresolved

### Phase 4: expand sidecar scope

- real correction classifier
- richer entity extraction
- normalization services
- optional reranker for top-2 or top-3 candidate disambiguation
- structured compaction and memory-store integration

## Recommended first decision

The cleanest next step is:

1. Keep `detectIntent()` exact and shared.
2. Do not broaden the global lexical primitive again.
3. Add a sidecar semantic-ranking path specifically for gather interrupts and parent reroutes.
4. Define `memory-compactor` now as a first-class service type in the shared control plane.
5. Treat the LLM pipeline as optional enhancement, not the only semantic path.

This gets semantic routing closer to a real NLU subsystem while preserving current runtime safety and fallback behavior.

## References

- Runtime semantic routing:
  - `apps/runtime/src/services/execution/flow-step-executor.ts`
  - `apps/runtime/src/services/pipeline/classifier.ts`
  - `apps/runtime/src/services/pipeline/routing-resolver.ts`
- Runtime sidecar lane:
  - `apps/runtime/src/services/nlu/sidecar-client.ts`
  - `apps/nlu-sidecar/app.py`
- Compiler-side NLU engine:
  - `packages/compiler/src/platform/nlu/engine.ts`
  - `packages/compiler/src/platform/nlu/embeddings/intent-index.ts`
  - `packages/compiler/src/platform/nlu/embeddings/entity-index.ts`
  - `packages/compiler/src/platform/nlu/embeddings/provider.ts`
- Existing docs:
  - `docs/features/nlu.md`
  - `docs/specs/nlu.hld.md`
  - `docs/testing/nlu.md`

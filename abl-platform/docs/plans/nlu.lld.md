# NLU / Intent Classification & Entity Extraction — Low-Level Design

**Feature**: NLU (routing / classifier umbrella)
**Status**: Updated during post-implementation sync on 2026-04-15
**Related Child LLD**: [docs/plans/entity-extraction.lld.md](./entity-extraction.lld.md)

> Canonical split (2026-04-15): detailed semantic entity registry, `ENTITIES` / `ENTITY_REF`, and runtime observation-pipeline implementation notes now live in [docs/plans/entity-extraction.lld.md](./entity-extraction.lld.md). This document remains the intent-classification and routing reference.

## Implementation Structure

### Core Files

| File                                                                  | Purpose                                                                                       |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/pipeline/classifier.ts`                    | LLM-based intent classifier: prompt building, JSON parsing, short-circuit check, keyword veto |
| `apps/runtime/src/services/pipeline/intent-bridge.ts`                 | Maps ClassifierResult to PipelineIntentState and MultiIntentResult                            |
| `apps/runtime/src/services/pipeline/tiered-resolver.ts`               | Resolves TieredAction (Tier 1/2/3) from PipelineResult + IntentBridgeConfig                   |
| `apps/runtime/src/services/pipeline/types.ts`                         | All pipeline types: PipelineConfig, ClassifierResult, TieredAction, GuidedHints, trace events |
| `apps/runtime/src/services/pipeline/merge.ts`                         | Multi-intent tool set merging                                                                 |
| `apps/runtime/src/services/pipeline/index.ts`                         | Pipeline orchestrator (classifier + tool filter in parallel/sequential)                       |
| `apps/runtime/src/services/nlu/sidecar-client.ts`                     | NLUSidecarClient: HTTP + circuit breaker for entity extraction and correction detection       |
| `apps/runtime/src/services/nlu/currency-rate-client.ts`               | CurrencyRateClient: live exchange rates with in-memory cache + static fallback                |
| `apps/runtime/src/services/execution/multi-intent-strategy.ts`        | resolveMultiIntentStrategy: auto/parallel/sequential/disambiguate based on agent type         |
| `apps/runtime/src/services/execution/intent-queue.ts`                 | IntentQueue: enqueue, dequeue, peek, expire, max size, deduplication                          |
| `apps/runtime/src/services/execution/routing-executor.ts`             | Agent routing with multi-intent dispatch (fan-out, sequential handoff)                        |
| `apps/runtime/src/services/config/project-runtime-config-resolver.ts` | Load project NLU config from MongoDB, map to ProjectRuntimeConfigIR                           |
| `apps/runtime/src/routes/project-runtime-config.ts`                   | REST endpoints for project runtime config CRUD                                                |
| `packages/nl-parser/src/extractor.ts`                                 | NLExtractor: Anthropic API calls for agent/supervisor extraction from NL SOPs                 |
| `packages/nl-parser/src/generator.ts`                                 | ABLGenerator: converts AgentExtraction/SupervisorExtraction to ABL DSL strings                |
| `packages/nl-parser/src/types.ts`                                     | Zod schemas: AgentExtractionSchema, SupervisorExtractionSchema, ExtractedStep, InferredTool   |
| `packages/nl-parser/src/prompts/agent.ts`                             | Agent extraction system prompt and prompt builder                                             |
| `packages/nl-parser/src/prompts/supervisor.ts`                        | Supervisor extraction system prompt and prompt builder                                        |

### Test Files

| File                                                                   | Type        | Focus                                         |
| ---------------------------------------------------------------------- | ----------- | --------------------------------------------- |
| `apps/runtime/src/__tests__/nlu-sidecar-client.test.ts`                | unit        | Extract, correction, circuit breaker, timeout |
| `apps/runtime/src/__tests__/nlu-sidecar-half-open-probe.test.ts`       | unit        | Half-open probe edge cases                    |
| `apps/runtime/src/__tests__/nlu-sidecar-per-session.test.ts`           | unit        | Config-driven client creation                 |
| `apps/runtime/src/__tests__/nlu-sidecar-wiring.test.ts`                | unit        | Sidecar wiring in runtime executor            |
| `apps/runtime/src/__tests__/nlu-provider-gating.test.ts`               | unit        | Enterprise plan enforcement                   |
| `apps/runtime/src/__tests__/tenant-config-advanced-nlu.test.ts`        | unit        | Tenant plan NLU flags                         |
| `apps/runtime/src/__tests__/project-runtime-config-route-nlu.test.ts`  | unit        | NLU config route validation                   |
| `apps/runtime/src/__tests__/pipeline-intent-bridge.test.ts`            | unit        | Intent bridge mapping                         |
| `apps/runtime/src/__tests__/pipeline-tiered-resolver.test.ts`          | unit        | Tiered resolver                               |
| `apps/runtime/src/__tests__/multi-intent-strategy.test.ts`             | unit        | Strategy resolution                           |
| `apps/runtime/src/__tests__/intent-queue.test.ts`                      | unit        | Queue operations                              |
| `apps/runtime/src/__tests__/intent-queue-expanded.test.ts`             | unit        | Queue edge cases                              |
| `apps/runtime/src/__tests__/intent-queue-max-intents.test.ts`          | unit        | Max size                                      |
| `apps/runtime/src/__tests__/multi-intent-integration.test.ts`          | integration | Multi-intent dispatch                         |
| `apps/runtime/src/__tests__/multi-intent-executor-integration.test.ts` | integration | Executor integration                          |
| `apps/runtime/src/__tests__/routing-executor-multi-intent.test.ts`     | unit        | Routing + multi-intent                        |
| `apps/runtime/src/__tests__/extraction-pipeline.test.ts`               | unit        | Extraction flow                               |
| `apps/runtime/src/__tests__/extraction-strategy.test.ts`               | unit        | Strategy selection                            |
| `apps/runtime/src/__tests__/extraction-tool-call.test.ts`              | unit        | Tool-call extraction                          |
| `apps/runtime/src/__tests__/currency-rate-client.test.ts`              | unit        | Currency conversion                           |
| `packages/nl-parser/src/__tests__/generator.test.ts`                   | unit        | ABL generation                                |

## Module T-1: Pipeline Classifier

### Key Functions

```typescript
// Build classification prompt with available targets, tools, and routing descriptions
function buildClassifierPrompt(
  userMessage: string,
  targets: string[],
  toolNames: string[],
  routingDescriptions?: Map<string, string>,
): string;

// Parse JSON classifier response with markdown fence stripping and fallback
function parseClassifierResponse(text: string): ClassifierResult;

// Check keyword veto — tool-name-derived and config keywords matched against user message
function checkKeywordVeto(
  userMessage: string,
  toolNames: string[],
  configKeywords: string[],
): string[];

// Run classification via fast LLM call (10s timeout, temperature 0, 300 max tokens)
async function classify(
  model: LanguageModel,
  userMessage: string,
  targets: string[],
  toolNames: string[],
  config: PipelineConfig,
  onTraceEvent?: OnTraceEvent,
  routingDescriptions?: Map<string, string>,
): Promise<ClassifierResult>;

// Determine short-circuit eligibility: single intent + high confidence + target + no veto
function shouldShortCircuit(
  result: ClassifierResult,
  userMessage: string,
  toolNames: string[],
  config: PipelineConfig,
): { shortCircuit: boolean; vetoKeywords?: string[] };
```

### Classification Prompt Structure

The prompt includes:

1. Available agent targets (from routing rules/handoff configs)
2. Routing rules with descriptions (from agent IR)
3. Available tool names
4. Instructions for null-target (out-of-scope), multi-intent per-agent splitting
5. JSON output format: `{"intents":[{target, confidence, summary}], "should_execute_in_agent", "matched_tools"}`

## Module T-2: Intent Bridge

### Key Functions

```typescript
// Build reverse map: target agent name -> intent categories (from WHEN conditions)
function buildTargetCategoryMap(ir: AgentIR): Map<string, string[]>;

// Map classifier output to PipelineIntentState for session.data.values.intent
function bridgeIntentsToSessionState(
  classifierResult: ClassifierResult,
  agentIR: AgentIR,
): PipelineIntentState;

// Map to MultiIntentResult for routing-executor.handleMultiIntent()
// Returns null for single-intent results
function bridgeToMultiIntentResult(
  classifierResult: ClassifierResult,
  agentIR: AgentIR,
): MultiIntentResult | null;
```

### Category Resolution

The intent bridge parses `WHEN` conditions from routing rules and handoff configs to build a reverse map from target agent names to intent categories. Pattern: `intent.category == "product_search"`.

## Module T-3: Tiered Resolver

### Tier Definitions

| Tier | Confidence                      | Actions                                              |
| ---- | ------------------------------- | ---------------------------------------------------- |
| 1    | >= 0.85 (programmaticThreshold) | short_circuit, fan_out, decline_out_of_scope         |
| 2    | >= 0.5 (guidedThreshold)        | guided (hiddenTools, routingHint, multiIntentSignal) |
| 3    | < 0.5                           | autonomous (full reasoning, no pipeline guidance)    |

### TieredAction Discriminated Union

```typescript
type TieredAction =
  | { tier: 1; action: 'short_circuit'; target: string; message: string }
  | { tier: 1; action: 'fan_out'; targets: Array<{ target: string; intent: string }> }
  | { tier: 1; action: 'decline_out_of_scope'; message: string }
  | { tier: 2; action: 'guided'; hints: GuidedHints }
  | { tier: 3; action: 'autonomous'; reason: string };
```

## Module T-4: NLU Sidecar Client

### Circuit Breaker State Machine

```
CLOSED --[N consecutive failures]--> OPEN
OPEN   --[resetMs elapsed]--------> HALF_OPEN
HALF_OPEN --[probe success]-------> CLOSED
HALF_OPEN --[probe failure]-------> OPEN
```

Defaults: threshold=5, resetMs=30000, timeoutMs=3000.

### Endpoints

| Endpoint             | Method | Request                    | Response                                        |
| -------------------- | ------ | -------------------------- | ----------------------------------------------- |
| `/extract`           | POST   | `{text, fields[], locale}` | `{entities: Record, confidence: Record}`        |
| `/detect-correction` | POST   | `{text, context, locale}`  | `{is_correction, field, new_value, confidence}` |
| `/health`            | GET    | -                          | 200 OK / error                                  |

## Module T-5: Multi-Intent System

### Strategy Resolution Rules

| Declared     | Agent Type         | Relationship | Effective               |
| ------------ | ------------------ | ------------ | ----------------------- |
| auto         | supervisor         | independent  | parallel                |
| auto         | supervisor         | dependent    | sequential              |
| auto         | supervisor         | ambiguous    | disambiguate            |
| auto         | scripted/reasoning | any          | sequential              |
| parallel     | supervisor         | any          | parallel                |
| parallel     | scripted/reasoning | any          | sequential (downgraded) |
| sequential   | any                | any          | sequential              |
| disambiguate | any                | any          | disambiguate            |

### Intent Queue Operations

- `createIntentQueue()`: Empty queue
- `enqueueIntents(queue, intents[], maxSize?)`: Merge duplicates (higher confidence wins), sort by confidence descending
- `dequeueNext(queue)`: Remove and return highest-confidence entry
- `peekNext(queue)`: Read without removing
- `expireStale(queue, maxAgeMs)`: Remove entries older than maxAge
- `queueSize(queue)`: Return count

## Module T-6: nl-parser Package

### NLExtractor

Uses Anthropic API (claude-sonnet-4-20250514) with structured prompts to extract:

- **AgentExtraction**: agent_name, identity, steps (with action types), guardrails, inferred_tools
- **SupervisorExtraction**: name, state_variables, routing_rules, intent_mappings, policies

### ABLGenerator

Converts extraction results to ABL DSL strings:

- `generateAgentABL(extraction)`: Produces `AGENT: name\nIDENTITY:\n...` format
- `generateSupervisorABL(extraction)`: Produces `SUPERVISOR: name\nROUTING:\n...` format

## Known Gaps

| ID      | Description                                                                                     | Severity | Status   |
| ------- | ----------------------------------------------------------------------------------------------- | -------- | -------- |
| GAP-001 | Multi-intent divergence between flow and reasoning was closed by the shared router              | N/A      | Resolved |
| GAP-002 | Guided multi-intent has one public HTTP regression, but the broader E2E matrix is still partial | High     | Partial  |
| GAP-003 | No real sidecar integration tests (all mock fetch)                                              | High     | Open     |
| GAP-004 | nl-parser hardcoded to Anthropic (no provider-neutral fallback)                                 | Low      | Open     |
| GAP-005 | Keyword veto uses simple word-boundary regex (no NLP-based matching)                            | Low      | Open     |
| GAP-006 | Pipeline classifier prompt does not include conversation history (single-turn only)             | Medium   | Open     |
| GAP-007 | NLU sidecar server is a stub — returns empty, TODO: wire ML models + spaCy                      | High     | Open     |

## Dependencies

- `ai` package (Vercel AI SDK) — for `generateText` in classifier
- `@anthropic-ai/sdk` — for nl-parser extraction
- `@abl/compiler` — IR types, model registry, default messages
- `@agent-platform/database` — ProjectRuntimeConfig model
- Python NLU sidecar service (external) — for advanced entity extraction
- Exchange rate API (external) — for live currency conversion

## Exit Criteria

- All unit and integration tests pass: sidecar, classifier, bridge, tiered resolver, multi-intent, extraction
- Circuit breaker correctly transitions through all states
- Enterprise plan gating enforced for advanced NLU
- Pipeline classifier falls through gracefully on LLM error
- Intent queue operations are idempotent and handle duplicates

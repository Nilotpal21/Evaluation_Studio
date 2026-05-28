# Circuit Breaker Algorithms for Pipeline Flow Failure Handling

**Task:** Research #36 - Circuit breaker algorithms for flow failure handling
**Status:** Complete
**Date:** 2026-03-07

---

## Executive Summary

This research document explores circuit breaker strategies for protecting SearchAI's pluggable pipeline flows from cascading failures. It builds on the existing Redis circuit breaker infrastructure (`@agent-platform/circuit-breaker`) and addresses BullMQ Flows-specific failure modes.

**Key Findings:**

1. **Three-Level Circuit Breaker Strategy:** Provider-level (for LLM/extraction services), stage-type level (for entire stage categories), and flow-level (for entire flow patterns)
2. **Existing Infrastructure is Reusable:** The Redis circuit breaker package can be extended with a new `pipeline_provider` level without architectural changes
3. **BullMQ-Specific Failure Handling:** Must combine circuit breaker with `failParentOnFailure: true` and flow validation wrapper
4. **Fallback Hierarchy:** Provider fallback → stage skip → alternative flow → manual intervention
5. **Fail-Fast for Critical Stages:** Extraction failures should fail the entire flow (no fallback), enrichment failures should skip (continue processing)

---

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Circuit Breaker Fundamentals](#circuit-breaker-fundamentals)
3. [Three-Level Strategy](#three-level-strategy)
4. [Existing Infrastructure Review](#existing-infrastructure-review)
5. [Pipeline-Specific Circuit Breaker Design](#pipeline-specific-circuit-breaker-design)
6. [BullMQ Flows Integration](#bullmq-flows-integration)
7. [Failure Detection](#failure-detection)
8. [Fallback Strategies](#fallback-strategies)
9. [Recovery Strategies](#recovery-strategies)
10. [Configuration Recommendations](#configuration-recommendations)
11. [Monitoring & Alerting](#monitoring--alerting)
12. [Implementation Checklist](#implementation-checklist)

---

## Problem Statement

### Failure Scenarios in Pipeline Flows

**Scenario 1: Provider Outage (Docling Service Down)**

```
Document Upload → Flow Selection → Extraction Stage (Docling)
                                          ↓
                                    Service Timeout (30s)
                                          ↓
                                    Retry 3 times (90s total)
                                          ↓
                                    Flow fails, document stuck
```

**Impact:** All PDF documents fail extraction, users see error state, no fallback mechanism.

**Scenario 2: LLM Provider Rate Limit (OpenAI 429)**

```
100 documents → Enrichment Stage (LLM Entity Extraction)
                      ↓
                OpenAI returns 429 (Rate Limit)
                      ↓
                100 retries, each waits exponential backoff
                      ↓
                Redis queue grows unbounded, memory exhaustion
```

**Impact:** Cascading failures, Redis OOM, all enrichment jobs blocked.

**Scenario 3: Transient Embedding Service Failure**

```
10 documents → Embedding Stage (BGE-M3)
                      ↓
                Service returns 503 (Temporary Unavailable)
                      ↓
                Retries succeed after 2 attempts
                      ↓
                Document processed successfully
```

**Impact:** No circuit breaker → unnecessary retries on every request, increased latency.

### Why Circuit Breakers Are Needed

**1. Prevent Cascading Failures**

Without circuit breaker:

```
Docling service slow (30s timeout)
→ 100 documents in queue
→ 100 workers waiting 30s each
→ Redis locks held for 3000s total
→ New documents time out waiting for workers
→ Entire pipeline blocked
```

With circuit breaker:

```
Docling service slow (30s timeout)
→ Circuit breaker detects 5 failures in 30s
→ Opens circuit (OPEN state)
→ New requests fail immediately with CircuitOpenError
→ Workers freed, can process other flows
→ After 60s, circuit tries HALF_OPEN (probe)
→ If successful, resumes normal operation
```

**2. Enable Fallback Strategies**

```typescript
try {
  const result = await breaker.execute('docling', async () => {
    return await extractWithDocling(document);
  });
} catch (error) {
  if (error instanceof CircuitOpenError) {
    // Docling circuit open, use fallback
    return await extractWithLlamaIndex(document);
  }
  throw error;
}
```

**3. Protect Downstream Services**

When Docling is overwhelmed:

- Circuit breaker stops sending new requests
- Gives service time to recover
- Prevents "thundering herd" when service comes back online

**4. Fast Failure Detection**

Without circuit breaker: Each request waits full timeout (30s) before failing
With circuit breaker: Immediate rejection (< 1ms) when circuit is OPEN

---

## Circuit Breaker Fundamentals

### State Machine

The existing Redis circuit breaker implements a standard three-state machine:

```
┌─────────────────────────────────────────────────────────────┐
│                         CLOSED                               │
│  Normal operation, tracking failures                         │
│  ┌────────────────────────────────────┐                     │
│  │ Failure count within window         │                     │
│  │ If >= failureThreshold → OPEN      │                     │
│  └────────────────────────────────────┘                     │
└─────────────────┬───────────────────────────────────────────┘
                  │
                  ↓ Threshold exceeded
┌─────────────────▼───────────────────────────────────────────┐
│                          OPEN                                │
│  Reject all requests immediately                             │
│  ┌────────────────────────────────────┐                     │
│  │ Wait resetTimeout (e.g., 60s)      │                     │
│  │ After timeout → HALF_OPEN          │                     │
│  └────────────────────────────────────┘                     │
└─────────────────┬───────────────────────────────────────────┘
                  │
                  ↓ Reset timeout elapsed
┌─────────────────▼───────────────────────────────────────────┐
│                       HALF_OPEN                              │
│  Allow limited probes (halfOpenMaxConcurrent)                │
│  ┌────────────────────────────────────┐                     │
│  │ If success >= successThreshold:    │                     │
│  │   → CLOSED (resume normal)         │                     │
│  │ If any failure:                    │                     │
│  │   → OPEN (back to rejection)       │                     │
│  └────────────────────────────────────┘                     │
└──────────────────────────────────────────────────────────────┘
```

### Key Metrics

**1. Failure Threshold**

- Number of failures before opening circuit
- Lower threshold = more sensitive, faster failure detection
- Higher threshold = more tolerant, fewer false positives

**2. Reset Timeout**

- Time to wait in OPEN state before attempting HALF_OPEN
- Longer timeout = more conservative, gives service more recovery time
- Shorter timeout = more aggressive, faster recovery detection

**3. Success Threshold (Half-Open)**

- Number of successful probes needed to close circuit
- Higher threshold = more confident recovery validation
- Lower threshold = faster recovery, but riskier

**4. Monitor Window**

- Rolling time window for failure rate calculation
- Larger window = smoother failure rate, less sensitive to spikes
- Smaller window = more reactive to recent failures

**5. Failure Rate Threshold**

- Percentage of failures in monitor window that triggers OPEN
- Example: 50% failure rate over 60s window
- Prevents opening circuit on single failure bursts

**6. Minimum Request Count**

- Minimum requests in window before failure rate applies
- Prevents opening circuit on low traffic (e.g., 1 failure out of 1 request = 100%)

### Atomic State Transitions (Lua)

The existing implementation uses Redis Lua scripts for atomic state transitions. This is critical in distributed environments where multiple workers check circuit state simultaneously.

**check-state.lua** (simplified):

```lua
-- Atomically check state and auto-transition OPEN → HALF_OPEN
local state = redis.call('GET', stateKey)

if state == 'OPEN' then
  local openedAt = redis.call('GET', openedAtKey)
  local elapsed = currentTime - openedAt

  if elapsed >= resetTimeout then
    -- Auto-transition to HALF_OPEN
    redis.call('SET', stateKey, 'HALF_OPEN')
    redis.call('SET', halfOpenCountKey, '0')
    return {'HALF_OPEN', true, 0}
  else
    -- Still in OPEN, reject
    local retryAfterMs = resetTimeout - elapsed
    return {'OPEN', false, retryAfterMs}
  end
end

-- CLOSED or HALF_OPEN logic...
```

**record-result.lua** (simplified):

```lua
-- Atomically record success/failure and check thresholds
local state = redis.call('GET', stateKey)

if result == 'failure' then
  -- Add failure to sorted set (score = timestamp)
  redis.call('ZADD', failuresKey, currentTime, uuid)

  -- Remove failures outside monitor window
  redis.call('ZREMRANGEBYSCORE', failuresKey, 0, currentTime - monitorWindow)

  -- Count failures in window
  local failureCount = redis.call('ZCARD', failuresKey)

  -- If threshold exceeded, open circuit
  if failureCount >= failureThreshold then
    redis.call('SET', stateKey, 'OPEN')
    redis.call('SET', openedAtKey, currentTime)
    return 'OPEN'
  end
end

-- Success logic (HALF_OPEN → CLOSED)...
```

---

## Three-Level Strategy

Based on the pipeline architecture analysis, we need circuit breakers at three levels:

### Level 1: Provider-Level Circuit Breaker

**Scope:** Individual external service (Docling, OpenAI, Anthropic, BGE-M3, Neo4j, etc.)

**Granularity:** `tenant:provider` (e.g., `tenant-123:docling`, `tenant-123:openai`)

**Purpose:** Protect against provider-specific outages or rate limits

**Example:**

```typescript
// Provider-level breaker
const doclingBreaker = new RedisCircuitBreaker(redis, 'pipeline_provider', {
  failureThreshold: 10,
  resetTimeout: 60_000, // 1 minute
  successThreshold: 2,
  monitorWindow: 30_000,
  halfOpenMaxConcurrent: 1,
  failureRateThreshold: 40,
  minimumRequestCount: 5,
});

// Usage in stage executor
async function executeDoclingExtraction(document: ISearchDocument): Promise<ExtractionResult> {
  const breakerKey = `${document.tenantId}:docling`;

  try {
    return await doclingBreaker.execute(breakerKey, async () => {
      return await doclingService.extract(document);
    });
  } catch (error) {
    if (error instanceof CircuitOpenError) {
      // Provider circuit open, try fallback
      logger.warn('Docling circuit open, using fallback extractor', {
        tenantId: document.tenantId,
        retryAfterMs: error.retryAfterMs,
      });
      return await llamaIndexService.extract(document);
    }
    throw error;
  }
}
```

**Configuration:**

| Provider Type                   | Failure Threshold | Reset Timeout | Success Threshold | Notes                                 |
| ------------------------------- | ----------------- | ------------- | ----------------- | ------------------------------------- |
| LLM (OpenAI, Anthropic, Gemini) | 5                 | 120s          | 3                 | Long reset timeout for rate limits    |
| Extraction (Docling)            | 10                | 60s           | 2                 | Moderate timeout for service restarts |
| Embedding (BGE-M3, OpenAI)      | 10                | 60s           | 2                 | Moderate timeout                      |
| Knowledge Graph (Neo4j)         | 15                | 30s           | 2                 | Short timeout, self-hosted            |

### Level 2: Stage-Type Circuit Breaker

**Scope:** Entire category of stages (all extraction stages, all enrichment stages, etc.)

**Granularity:** `tenant:stage_type` (e.g., `tenant-123:extraction`, `tenant-123:enrichment`)

**Purpose:** Protect against systemic failures affecting an entire stage type across multiple providers

**Example:**

```typescript
// Stage-type breaker
const extractionBreaker = new RedisCircuitBreaker(redis, 'pipeline_stage', {
  failureThreshold: 20,
  resetTimeout: 120_000, // 2 minutes
  successThreshold: 5,
  monitorWindow: 60_000,
  halfOpenMaxConcurrent: 3,
  failureRateThreshold: 50,
  minimumRequestCount: 10,
});

// Usage in pipeline orchestrator
async function executeExtractionStages(
  flow: PipelineFlow,
  document: ISearchDocument,
): Promise<ExtractionResult> {
  const breakerKey = `${document.tenantId}:extraction`;

  // Check if extraction stage type is healthy
  const checkResult = await extractionBreaker.checkState(breakerKey);
  if (!checkResult.canExecute) {
    throw new StageTypeCircuitOpenError(
      `Extraction stage type circuit is open for tenant ${document.tenantId}`,
      { retryAfterMs: checkResult.retryAfterMs },
    );
  }

  // Execute extraction stages...
  try {
    const result = await executeStage(flow.stages[0], document);
    await extractionBreaker.recordSuccess(breakerKey);
    return result;
  } catch (error) {
    await extractionBreaker.recordFailure(breakerKey);
    throw error;
  }
}
```

**Why Stage-Type Breakers?**

- **Cross-Provider Failures:** If Docling, LlamaIndex, AND custom extraction API all fail, it indicates a systemic problem (network partition, MongoDB down, etc.)
- **Tenant-Level Protection:** Prevents a single tenant's failing extractions from consuming all worker capacity
- **Early Detection:** Catches upstream failures (source fetching, MongoDB writes) that affect all extraction providers

**Configuration:**

| Stage Type      | Failure Threshold | Reset Timeout | Success Threshold | Notes                                   |
| --------------- | ----------------- | ------------- | ----------------- | --------------------------------------- |
| Extraction      | 20                | 120s          | 5                 | Critical stage, long reset timeout      |
| Chunking        | 15                | 60s           | 3                 | Moderate threshold                      |
| Enrichment      | 30                | 90s           | 5                 | Non-critical, high threshold (can skip) |
| Embedding       | 20                | 120s          | 5                 | Critical for searchability              |
| Knowledge Graph | 30                | 90s           | 3                 | Non-critical, can skip                  |

### Level 3: Flow-Level Circuit Breaker

**Scope:** Entire flow pattern (e.g., "PDF via Docling" flow)

**Granularity:** `tenant:flow_id` (e.g., `tenant-123:flow-pdf-docling`)

**Purpose:** Protect against flow-specific issues (incompatible stages, configuration bugs, document format problems)

**Example:**

```typescript
// Flow-level breaker
const flowBreaker = new RedisCircuitBreaker(redis, 'pipeline_flow', {
  failureThreshold: 25,
  resetTimeout: 180_000, // 3 minutes
  successThreshold: 10,
  monitorWindow: 120_000,
  halfOpenMaxConcurrent: 5,
  failureRateThreshold: 60,
  minimumRequestCount: 15,
});

// Usage in flow selector
async function selectAndExecuteFlow(
  pipeline: PipelineDefinition,
  document: ISearchDocument,
): Promise<void> {
  const selectedFlow = selectFlow(pipeline, document);
  const breakerKey = `${document.tenantId}:${selectedFlow.id}`;

  // Check if flow is healthy
  const checkResult = await flowBreaker.checkState(breakerKey);
  if (!checkResult.canExecute) {
    // Flow circuit open, try alternative flow or fail
    logger.error('Flow circuit is open, attempting alternative flow', {
      tenantId: document.tenantId,
      flowId: selectedFlow.id,
      retryAfterMs: checkResult.retryAfterMs,
    });

    // Try next priority flow
    const alternativeFlow = await findAlternativeFlow(pipeline, document, selectedFlow);
    if (alternativeFlow) {
      return await executeFlow(alternativeFlow, document);
    }

    throw new FlowCircuitOpenError(
      `Flow ${selectedFlow.id} circuit is open and no alternative flow available`,
      { retryAfterMs: checkResult.retryAfterMs },
    );
  }

  // Execute flow...
  try {
    await executeFlow(selectedFlow, document);
    await flowBreaker.recordSuccess(breakerKey);
  } catch (error) {
    await flowBreaker.recordFailure(breakerKey);
    throw error;
  }
}
```

**Why Flow-Level Breakers?**

- **Configuration Issues:** A misconfigured flow (e.g., invalid provider config, incompatible stage sequence) will fail repeatedly
- **Document Format Problems:** A flow designed for PDFs but receiving corrupted PDFs will consistently fail
- **Alternative Flow Selection:** When a preferred flow is broken, automatically route documents to alternative flows

**Configuration:**

| Flow Criticality       | Failure Threshold | Reset Timeout | Success Threshold | Notes                                     |
| ---------------------- | ----------------- | ------------- | ----------------- | ----------------------------------------- |
| High (no alternatives) | 15                | 180s          | 10                | Conservative, long recovery validation    |
| Medium (1 alternative) | 25                | 120s          | 5                 | Moderate, allow quick alternative routing |
| Low (2+ alternatives)  | 30                | 90s           | 3                 | Aggressive, fast alternative selection    |

### Hierarchy Visualization

```
Document Upload
       ↓
┌──────▼──────────────────────────────────────────────────┐
│ Level 3: Flow-Level Breaker                             │
│ Key: tenant-123:flow-pdf-docling                        │
│ Check: Is this flow pattern healthy?                    │
└──────┬──────────────────────────────────────────────────┘
       ↓ CLOSED (proceed)
┌──────▼──────────────────────────────────────────────────┐
│ Level 2: Stage-Type Breaker                             │
│ Key: tenant-123:extraction                              │
│ Check: Are extraction stages healthy?                   │
└──────┬──────────────────────────────────────────────────┘
       ↓ CLOSED (proceed)
┌──────▼──────────────────────────────────────────────────┐
│ Level 1: Provider-Level Breaker                         │
│ Key: tenant-123:docling                                 │
│ Check: Is Docling provider healthy?                     │
└──────┬──────────────────────────────────────────────────┘
       ↓ CLOSED (proceed)
┌──────▼──────────────────────────────────────────────────┐
│ Execute Stage: Docling Extraction                       │
└─────────────────────────────────────────────────────────┘
```

**Failure Propagation:**

```
Provider Breaker OPEN (Docling down)
       ↓
Try provider fallback (LlamaIndex)
       ↓
If fallback succeeds → Stage breaker stays CLOSED
If fallback fails → Stage breaker records failure
       ↓
Stage Breaker OPEN (all extraction providers failing)
       ↓
Flow breaker records failure (extraction is critical)
       ↓
Flow Breaker OPEN (entire flow unhealthy)
       ↓
Try alternative flow (if available)
If no alternative → Document fails with error
```

---

## Existing Infrastructure Review

### Redis Circuit Breaker Package

**Location:** `packages/circuit-breaker/src/redis-circuit-breaker.ts`

**Current Levels:**

- `tenant` - Tenant-wide failures (e.g., tenant quota exceeded)
- `app` - Application-level failures (e.g., database connection lost)
- `llm_provider` - LLM provider failures (e.g., OpenAI rate limit)
- `tool_service` - External tool failures (e.g., web search API down)

**API:**

```typescript
class RedisCircuitBreaker {
  constructor(redis: Redis, level: BreakerLevel, config: CircuitBreakerConfig);

  // Execute function with circuit breaker protection
  async execute<T>(key: string, fn: () => Promise<T>): Promise<T>;

  // Check if circuit can execute (without running function)
  async checkState(
    key: string,
  ): Promise<{ canExecute: boolean; state: CircuitState; retryAfterMs: number }>;

  // Manually record success/failure
  async recordSuccess(key: string): Promise<void>;
  async recordFailure(key: string): Promise<void>;

  // Get metrics for monitoring
  async getMetrics(key: string): Promise<CircuitMetrics>;

  // Manually reset circuit (admin operation)
  async reset(key: string): Promise<void>;
}
```

**Extension for Pipelines:**

Add new breaker levels:

```typescript
export type BreakerLevel =
  | 'tenant'
  | 'app'
  | 'llm_provider'
  | 'tool_service'
  | 'pipeline_provider' // NEW: For pipeline external services
  | 'pipeline_stage' // NEW: For pipeline stage types
  | 'pipeline_flow'; // NEW: For pipeline flows
```

**Configuration Defaults:**

```typescript
export const BREAKER_DEFAULTS: Record<BreakerLevel, CircuitBreakerConfig> = {
  // ... existing levels ...

  pipeline_provider: {
    failureThreshold: 10,
    successThreshold: 2,
    resetTimeout: 60_000, // 1 min
    monitorWindow: 30_000, // 30s
    halfOpenMaxConcurrent: 1,
    failureRateThreshold: 40,
    minimumRequestCount: 5,
  },

  pipeline_stage: {
    failureThreshold: 20,
    successThreshold: 5,
    resetTimeout: 120_000, // 2 min
    monitorWindow: 60_000, // 1 min
    halfOpenMaxConcurrent: 3,
    failureRateThreshold: 50,
    minimumRequestCount: 10,
  },

  pipeline_flow: {
    failureThreshold: 25,
    successThreshold: 10,
    resetTimeout: 180_000, // 3 min
    monitorWindow: 120_000, // 2 min
    halfOpenMaxConcurrent: 5,
    failureRateThreshold: 60,
    minimumRequestCount: 15,
  },
};
```

**No Infrastructure Changes Required:**

The existing Redis circuit breaker is generic and works with any breaker level. Adding new levels only requires:

1. Add level to `BreakerLevel` type
2. Add defaults to `BREAKER_DEFAULTS`
3. Instantiate breakers in pipeline code

---

## Pipeline-Specific Circuit Breaker Design

### Architecture

```
┌───────────────────────────────────────────────────────────────┐
│                    PipelineCircuitBreakerManager              │
│  Manages all pipeline-related circuit breakers                │
│  ┌─────────────────┬─────────────────┬────────────────────┐  │
│  │ Provider Breakers│ Stage Breakers  │ Flow Breakers      │  │
│  │ (Level 1)        │ (Level 2)       │ (Level 3)          │  │
│  └─────────────────┴─────────────────┴────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        ↓                  ↓                  ↓
┌───────────────┐  ┌──────────────┐  ┌──────────────────┐
│ Stage         │  │ Stage Type   │  │ Flow             │
│ Executor      │  │ Executor     │  │ Orchestrator     │
│               │  │              │  │                  │
│ Wraps provider│  │ Checks stage │  │ Selects & checks │
│ calls with    │  │ type health  │  │ flow health      │
│ provider      │  │ before       │  │ before execution │
│ breaker       │  │ executing    │  │                  │
└───────────────┘  └──────────────┘  └──────────────────┘
```

### Manager Interface

```typescript
import { Redis } from 'ioredis';
import { RedisCircuitBreaker } from '@agent-platform/circuit-breaker';

export class PipelineCircuitBreakerManager {
  private providerBreakers: Map<string, RedisCircuitBreaker> = new Map();
  private stageBreakers: Map<string, RedisCircuitBreaker> = new Map();
  private flowBreakers: Map<string, RedisCircuitBreaker> = new Map();

  constructor(private redis: Redis) {
    // Initialize breakers lazily on first use
  }

  // Provider-level breaker
  getProviderBreaker(providerId: string): RedisCircuitBreaker {
    if (!this.providerBreakers.has(providerId)) {
      this.providerBreakers.set(
        providerId,
        new RedisCircuitBreaker(
          this.redis,
          'pipeline_provider',
          BREAKER_DEFAULTS.pipeline_provider,
        ),
      );
    }
    return this.providerBreakers.get(providerId)!;
  }

  // Stage-type breaker
  getStageBreaker(stageType: PipelineStageType): RedisCircuitBreaker {
    if (!this.stageBreakers.has(stageType)) {
      this.stageBreakers.set(
        stageType,
        new RedisCircuitBreaker(this.redis, 'pipeline_stage', BREAKER_DEFAULTS.pipeline_stage),
      );
    }
    return this.stageBreakers.get(stageType)!;
  }

  // Flow-level breaker
  getFlowBreaker(flowId: string): RedisCircuitBreaker {
    if (!this.flowBreakers.has(flowId)) {
      this.flowBreakers.set(
        flowId,
        new RedisCircuitBreaker(this.redis, 'pipeline_flow', BREAKER_DEFAULTS.pipeline_flow),
      );
    }
    return this.flowBreakers.get(flowId)!;
  }

  // Health check for monitoring
  async getHealthStatus(tenantId: string): Promise<PipelineHealthStatus> {
    // Aggregate health across all breakers for a tenant
    const providerHealth = await this.getProviderHealth(tenantId);
    const stageHealth = await this.getStageHealth(tenantId);
    const flowHealth = await this.getFlowHealth(tenantId);

    return {
      tenantId,
      providerHealth,
      stageHealth,
      flowHealth,
      overallHealthy: providerHealth.healthy && stageHealth.healthy && flowHealth.healthy,
    };
  }

  // Admin reset (for manual intervention)
  async resetAll(tenantId: string): Promise<void> {
    // Reset all breakers for a tenant
  }
}
```

### Stage Executor Integration

```typescript
export class StageExecutor {
  constructor(
    private breakerManager: PipelineCircuitBreakerManager,
    private providerRegistry: ProviderRegistry,
  ) {}

  async executeStage(
    stage: PipelineStage,
    input: StageInput,
    context: ExecutionContext,
  ): Promise<StageOutput> {
    const { tenantId, documentId } = context;

    // Level 1: Check provider breaker
    const providerBreaker = this.breakerManager.getProviderBreaker(stage.provider);
    const providerBreakerKey = `${tenantId}:${stage.provider}`;

    const providerCheck = await providerBreaker.checkState(providerBreakerKey);
    if (!providerCheck.canExecute) {
      // Provider circuit open, try fallback
      const fallbackResult = await this.tryProviderFallback(stage, input, context);
      if (fallbackResult) {
        return fallbackResult;
      }

      throw new ProviderCircuitOpenError(`Provider ${stage.provider} circuit is open`, {
        retryAfterMs: providerCheck.retryAfterMs,
      });
    }

    // Level 2: Check stage-type breaker
    const stageBreaker = this.breakerManager.getStageBreaker(stage.type);
    const stageBreakerKey = `${tenantId}:${stage.type}`;

    const stageCheck = await stageBreaker.checkState(stageBreakerKey);
    if (!stageCheck.canExecute) {
      // Stage type circuit open
      if (stage.onError === 'continue') {
        // Skip this stage
        logger.warn('Stage type circuit open, skipping stage', {
          tenantId,
          documentId,
          stageType: stage.type,
          stageName: stage.name,
        });
        return { skipped: true };
      }

      throw new StageCircuitOpenError(`Stage type ${stage.type} circuit is open`, {
        retryAfterMs: stageCheck.retryAfterMs,
      });
    }

    // Execute provider
    try {
      const provider = this.providerRegistry.get(stage.provider);
      const result = await providerBreaker.execute(providerBreakerKey, async () => {
        return await provider.execute(input, stage.providerConfig);
      });

      // Record success for stage-type breaker
      await stageBreaker.recordSuccess(stageBreakerKey);

      return result;
    } catch (error) {
      // Record failure for stage-type breaker
      await stageBreaker.recordFailure(stageBreakerKey);

      // Handle based on stage onError policy
      if (stage.onError === 'continue') {
        logger.error('Stage execution failed, continuing per onError policy', {
          tenantId,
          documentId,
          stageType: stage.type,
          stageName: stage.name,
          error: error.message,
        });
        return { skipped: true, error: error.message };
      }

      throw error;
    }
  }

  private async tryProviderFallback(
    stage: PipelineStage,
    input: StageInput,
    context: ExecutionContext,
  ): Promise<StageOutput | null> {
    // Check if stage has fallback provider
    if (!stage.fallbackProvider) {
      return null;
    }

    const fallbackBreaker = this.breakerManager.getProviderBreaker(stage.fallbackProvider);
    const fallbackKey = `${context.tenantId}:${stage.fallbackProvider}`;

    // Check if fallback provider is healthy
    const fallbackCheck = await fallbackBreaker.checkState(fallbackKey);
    if (!fallbackCheck.canExecute) {
      return null; // Fallback also unhealthy
    }

    // Execute fallback
    try {
      const fallbackProvider = this.providerRegistry.get(stage.fallbackProvider);
      return await fallbackBreaker.execute(fallbackKey, async () => {
        return await fallbackProvider.execute(input, stage.fallbackConfig || stage.providerConfig);
      });
    } catch (error) {
      logger.error('Fallback provider also failed', {
        tenantId: context.tenantId,
        documentId: context.documentId,
        primaryProvider: stage.provider,
        fallbackProvider: stage.fallbackProvider,
        error: error.message,
      });
      return null;
    }
  }
}
```

### Flow Orchestrator Integration

```typescript
export class FlowOrchestrator {
  constructor(
    private breakerManager: PipelineCircuitBreakerManager,
    private stageExecutor: StageExecutor,
    private flowBuilder: PipelineFlowBuilder,
  ) {}

  async executeFlow(
    pipeline: PipelineDefinition,
    document: ISearchDocument,
  ): Promise<FlowExecutionResult> {
    const { tenantId } = document;

    // Select flow based on document metadata
    const selectedFlow = this.selectFlow(pipeline, document);

    // Level 3: Check flow breaker
    const flowBreaker = this.breakerManager.getFlowBreaker(selectedFlow.id);
    const flowBreakerKey = `${tenantId}:${selectedFlow.id}`;

    const flowCheck = await flowBreaker.checkState(flowBreakerKey);
    if (!flowCheck.canExecute) {
      // Flow circuit open, try alternative flow
      logger.warn('Flow circuit is open, attempting alternative flow', {
        tenantId,
        documentId: document._id,
        flowId: selectedFlow.id,
        retryAfterMs: flowCheck.retryAfterMs,
      });

      const alternativeFlow = await this.findAlternativeFlow(pipeline, document, selectedFlow);
      if (alternativeFlow) {
        // Recursively execute alternative flow
        return await this.executeFlowInternal(alternativeFlow, document, pipeline);
      }

      throw new FlowCircuitOpenError(
        `Flow ${selectedFlow.id} circuit is open and no alternative flow available`,
        { retryAfterMs: flowCheck.retryAfterMs },
      );
    }

    // Execute flow
    try {
      const result = await this.executeFlowInternal(selectedFlow, document, pipeline);

      // Record success for flow breaker
      await flowBreaker.recordSuccess(flowBreakerKey);

      return result;
    } catch (error) {
      // Record failure for flow breaker
      await flowBreaker.recordFailure(flowBreakerKey);

      throw error;
    }
  }

  private async executeFlowInternal(
    flow: PipelineFlow,
    document: ISearchDocument,
    pipeline: PipelineDefinition,
  ): Promise<FlowExecutionResult> {
    // Build BullMQ flow structure
    const flowJob = await this.flowBuilder.buildFlow(flow, document, pipeline);

    // Execute stages sequentially via BullMQ Flows
    // (actual execution happens in workers, this just creates the flow)
    return await this.flowProducer.add(flowJob);
  }

  private async findAlternativeFlow(
    pipeline: PipelineDefinition,
    document: ISearchDocument,
    excludeFlow: PipelineFlow,
  ): Promise<PipelineFlow | null> {
    // Get enabled flows, sorted by priority
    const enabledFlows = pipeline.flows
      .filter((f) => f.enabled && f.id !== excludeFlow.id)
      .sort((a, b) => b.priority - a.priority);

    // Find next matching flow
    for (const flow of enabledFlows) {
      if (this.evaluateSelectionRules(flow.selectionRules, document)) {
        return flow;
      }
    }

    // No alternative found
    return null;
  }
}
```

---

## BullMQ Flows Integration

### Challenge: BullMQ Parent-Child Failure Handling

**Problem:** By default, BullMQ flow parents wait indefinitely for failed children.

**Solution:** Combine circuit breaker with `failParentOnFailure: true`

### Flow Builder with Circuit Breaker Integration

```typescript
export class PipelineFlowBuilder {
  async buildFlow(
    flow: PipelineFlow,
    document: ISearchDocument,
    pipeline: PipelineDefinition,
  ): Promise<FlowJob> {
    const stages = this.resolveStages(flow, pipeline);

    // Build nested flow structure
    const flowJob: FlowJob = {
      name: `${document._id}-${flow.id}`,
      queueName: this.getQueueForStage(stages[0]),
      data: {
        documentId: document._id.toString(),
        tenantId: document.tenantId,
        flowId: flow.id,
        pipelineId: pipeline._id.toString(),
        pipelineVersion: pipeline.version,
      },
      opts: {
        // CRITICAL: Fail parent if any child fails
        failParentOnFailure: true,

        // Clean up completed/failed jobs
        removeOnComplete: { age: 3600, count: 200 },
        removeOnFail: { age: 86400, count: 1000 },
      },
      children: this.buildStageChildren(stages, document),
    };

    return flowJob;
  }

  private buildStageChildren(stages: PipelineStage[], document: ISearchDocument): FlowChildJob[] {
    return stages.map((stage, index) => ({
      name: `${stage.id}-${document._id}`,
      queueName: this.getQueueForStage(stage),
      data: {
        documentId: document._id.toString(),
        tenantId: document.tenantId,
        stageId: stage.id,
        stageName: stage.name,
        stageType: stage.type,
        provider: stage.provider,
        providerConfig: stage.providerConfig,
        onError: stage.onError,
      },
      opts: {
        // CRITICAL: Fail parent if stage fails
        failParentOnFailure: stage.onError === 'fail',

        // Continue parent if stage fails (for onError: 'continue')
        ignoreDependencyOnFailure: stage.onError === 'continue',

        // Per-worker lock duration (prevent stalled jobs)
        lockDuration: this.getLockDuration(stage.type),
        stalledInterval: this.getLockDuration(stage.type) / 2,

        // Retry with exponential backoff
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },

        // Clean up
        removeOnComplete: { age: 3600, count: 200 },
        removeOnFail: { age: 86400, count: 1000 },
      },
    }));
  }

  private getLockDuration(stageType: PipelineStageType): number {
    const LOCK_DURATIONS: Record<PipelineStageType, number> = {
      extraction: 600_000, // 10 min (large PDFs)
      chunking: 120_000, // 2 min
      enrichment: 120_000, // 2 min (LLM calls)
      embedding: 180_000, // 3 min
      'knowledge-graph': 300_000, // 5 min (Neo4j writes)
      multimodal: 180_000, // 3 min (vision API)
    };
    return LOCK_DURATIONS[stageType] || 60_000;
  }
}
```

### Safe Flow Creation with Validation

**Problem:** FlowProducer.add() can fail silently (Issue #3851)

**Solution:** Wrap with validation check

```typescript
export class SafeFlowProducer {
  constructor(
    private flowProducer: FlowProducer,
    private redis: Redis,
  ) {}

  async addFlow(flow: FlowJob, parentQueueName: string): Promise<JobNode> {
    // Create flow
    const result = await this.flowProducer.add(flow);

    // CRITICAL: Verify parent job actually exists in Redis
    const parentQueue = new Queue(parentQueueName, { connection: this.redis });
    const parentJob = await parentQueue.getJob(result.job.id);

    if (!parentJob) {
      throw new FlowCreationError(
        `Flow creation failed silently for ${flow.name}. Redis may be in READONLY mode or experiencing issues.`,
      );
    }

    // Verify at least one child was created
    const children = await parentJob.getChildrenValues();
    if (Object.keys(children).length === 0) {
      throw new FlowCreationError(
        `Flow ${flow.name} created parent but no children. Flow definition may be invalid.`,
      );
    }

    return result;
  }
}
```

### Worker Error Handling

```typescript
export class PipelineWorker {
  async processJob(job: Job<StageJobData>): Promise<StageOutput> {
    const {
      tenantId,
      documentId,
      stageId,
      stageName,
      stageType,
      provider,
      providerConfig,
      onError,
    } = job.data;

    const logger = createLogger('pipeline-worker');
    const breakerManager = new PipelineCircuitBreakerManager(redis);
    const stageExecutor = new StageExecutor(breakerManager, providerRegistry);

    try {
      // Execute stage with circuit breaker protection
      const result = await stageExecutor.executeStage(
        {
          id: stageId,
          name: stageName,
          type: stageType,
          provider,
          providerConfig,
          onError,
        },
        { documentId },
        { tenantId, documentId },
      );

      // Record success in job tracking
      await this.jobTracker.recordSuccess(job.id, result);

      return result;
    } catch (error) {
      // Record failure in job tracking
      await this.jobTracker.recordFailure(job.id, error);

      // Check error type
      if (error instanceof CircuitOpenError) {
        // Circuit open, don't retry (will fail immediately)
        logger.error('Circuit breaker open, not retrying', {
          tenantId,
          documentId,
          stageType,
          provider,
          retryAfterMs: error.retryAfterMs,
        });

        // Mark job as failed (don't retry)
        throw new UnrecoverableError(`Circuit breaker open for ${provider}: ${error.message}`);
      }

      // Handle based on onError policy
      if (onError === 'continue') {
        // Log error but don't throw (parent will continue)
        logger.warn('Stage failed but onError=continue, parent will proceed', {
          tenantId,
          documentId,
          stageType,
          stageName,
          error: error.message,
        });
        return { skipped: true, error: error.message };
      }

      // onError === 'fail', throw to fail parent
      throw error;
    }
  }
}
```

---

## Failure Detection

### Failure Criteria by Stage Type

**1. Extraction Stages**

Failures that should open circuit breaker:

- Service timeout (> lockDuration)
- Service returns 5xx error
- Service returns malformed response
- Network connection refused/timeout

Failures that should NOT open circuit breaker:

- Document format unsupported (400 Bad Request) - document-specific issue
- Document corrupted (400 Bad Request) - document-specific issue

```typescript
function shouldRecordFailure(error: Error, stage: PipelineStage): boolean {
  // Network/infrastructure errors → record failure
  if (error instanceof NetworkError || error instanceof TimeoutError) {
    return true;
  }

  // HTTP 5xx errors → record failure
  if (error instanceof HttpError && error.statusCode >= 500) {
    return true;
  }

  // HTTP 429 (rate limit) → record failure
  if (error instanceof HttpError && error.statusCode === 429) {
    return true;
  }

  // HTTP 4xx (except 429) → do NOT record failure (document-specific)
  if (error instanceof HttpError && error.statusCode >= 400 && error.statusCode < 500) {
    return false;
  }

  // All other errors → record failure
  return true;
}
```

**2. Enrichment Stages (LLM)**

Failures that should open circuit breaker:

- LLM provider returns 429 (rate limit)
- LLM provider returns 5xx error
- LLM provider timeout
- LLM provider connection refused

Failures that should NOT open circuit breaker:

- LLM returns invalid JSON (prompt issue, not service issue)
- LLM refuses request due to content policy (document-specific)

**3. Embedding Stages**

Failures that should open circuit breaker:

- Embedding service timeout
- Embedding service 5xx error
- Embedding service rate limit (429)

Failures that should NOT open circuit breaker:

- Text too long (413) - document-specific
- Invalid input format (400) - document-specific

**4. Knowledge Graph Stages**

Failures that should open circuit breaker:

- Neo4j connection lost
- Neo4j transaction timeout
- Neo4j cluster unreachable

Failures that should NOT open circuit breaker:

- Constraint violation (duplicate entity) - data issue
- Invalid Cypher query (configuration issue, not service issue)

### Error Classification Helper

```typescript
export enum FailureType {
  INFRASTRUCTURE = 'infrastructure', // Record failure, open circuit
  SERVICE = 'service', // Record failure, open circuit
  RATE_LIMIT = 'rate_limit', // Record failure, open circuit
  DOCUMENT = 'document', // Do NOT record failure
  CONFIGURATION = 'configuration', // Do NOT record failure (pipeline config issue)
}

export function classifyError(error: Error, stage: PipelineStage): FailureType {
  // Network errors
  if (error instanceof NetworkError || error instanceof TimeoutError) {
    return FailureType.INFRASTRUCTURE;
  }

  // HTTP errors
  if (error instanceof HttpError) {
    if (error.statusCode === 429) return FailureType.RATE_LIMIT;
    if (error.statusCode >= 500) return FailureType.SERVICE;
    if (error.statusCode >= 400) return FailureType.DOCUMENT;
  }

  // Database errors
  if (error instanceof DatabaseError) {
    if (error.code === 'ECONNREFUSED') return FailureType.INFRASTRUCTURE;
    if (error.code === 'ETIMEDOUT') return FailureType.INFRASTRUCTURE;
    return FailureType.SERVICE;
  }

  // Configuration errors
  if (error instanceof ValidationError || error instanceof ConfigurationError) {
    return FailureType.CONFIGURATION;
  }

  // Default to service failure
  return FailureType.SERVICE;
}
```

---

## Fallback Strategies

### Fallback Hierarchy

```
┌─────────────────────────────────────────────────────────────────┐
│ Level 1: Provider Fallback                                      │
│ Primary provider fails → Try alternative provider               │
│ Example: Docling fails → Try LlamaIndex                         │
└────────────────┬────────────────────────────────────────────────┘
                 │ (if provider fallback fails)
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ Level 2: Stage Skip                                             │
│ Stage marked onError: 'continue' → Skip stage, continue flow    │
│ Example: Entity extraction fails → Skip, continue to embedding  │
└────────────────┬────────────────────────────────────────────────┘
                 │ (if stage is critical, onError: 'fail')
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ Level 3: Alternative Flow                                       │
│ Entire flow fails → Try next priority flow                      │
│ Example: PDF Docling flow fails → Try PDF LlamaIndex flow       │
└────────────────┬────────────────────────────────────────────────┘
                 │ (if no alternative flow)
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ Level 4: Manual Intervention                                    │
│ All fallbacks exhausted → Mark document as failed               │
│ User can manually retry or assign different flow                │
└─────────────────────────────────────────────────────────────────┘
```

### Provider Fallback Examples

**Extraction Fallback: Docling → LlamaIndex**

```typescript
const extractionStage: PipelineStage = {
  id: 'extract-1',
  type: 'extraction',
  name: 'Document Extraction',
  provider: 'docling',
  providerConfig: {
    extractTables: true,
    extractImages: true,
  },
  fallbackProvider: 'llamaindex',
  fallbackConfig: {
    chunkSize: 512,
  },
  onError: 'fail',
};
```

**Embedding Fallback: OpenAI → BGE-M3**

```typescript
const embeddingStage: PipelineStage = {
  id: 'embed-1',
  type: 'embedding',
  name: 'Generate Embeddings',
  provider: 'openai',
  providerConfig: {
    model: 'text-embedding-3-small',
    dimensions: 1536,
  },
  fallbackProvider: 'bge-m3',
  fallbackConfig: {
    dimensions: 1024,
  },
  onError: 'fail',
};
```

**LLM Fallback: OpenAI → Anthropic**

```typescript
const enrichmentStage: PipelineStage = {
  id: 'enrich-1',
  type: 'enrichment',
  name: 'Entity Extraction',
  provider: 'openai',
  providerConfig: {
    model: 'gpt-4',
    temperature: 0,
    useCase: 'entityExtraction',
  },
  fallbackProvider: 'anthropic',
  fallbackConfig: {
    model: 'claude-3-sonnet-20240229',
    temperature: 0,
    useCase: 'entityExtraction',
  },
  onError: 'continue', // Non-critical, can skip
};
```

### Stage Skip Strategy

**Critical vs Non-Critical Stages:**

```typescript
const flow: PipelineFlow = {
  id: 'flow-pdf-docling',
  name: 'PDF via Docling',
  priority: 40,
  stages: [
    // CRITICAL: Extraction must succeed
    {
      id: 'extract-1',
      type: 'extraction',
      name: 'Docling Extraction',
      provider: 'docling',
      onError: 'fail', // Fail entire flow if extraction fails
    },

    // CRITICAL: Chunking must succeed
    {
      id: 'chunk-1',
      type: 'chunking',
      name: 'Semantic Chunking',
      provider: 'tree-builder',
      onError: 'fail', // Fail entire flow if chunking fails
    },

    // CRITICAL: Embedding must succeed (required for search)
    {
      id: 'embed-1',
      type: 'embedding',
      name: 'Generate Embeddings',
      provider: 'openai',
      onError: 'fail', // Fail entire flow if embedding fails
    },

    // NON-CRITICAL: Enrichment can be skipped
    {
      id: 'enrich-1',
      type: 'enrichment',
      name: 'Entity Extraction',
      provider: 'openai',
      onError: 'continue', // Skip if fails, document still searchable
    },

    // NON-CRITICAL: Knowledge graph can be skipped
    {
      id: 'kg-1',
      type: 'knowledge-graph',
      name: 'Build Knowledge Graph',
      provider: 'llm',
      onError: 'continue', // Skip if fails
    },
  ],
};
```

**Why Skip Non-Critical Stages?**

- **Document still valuable:** A document with embeddings but no entity extraction is still searchable
- **Cost optimization:** Failing the entire flow means re-processing from extraction (expensive)
- **Graceful degradation:** Better to have partial functionality than total failure

### Alternative Flow Strategy

**Multiple Flows for Same Document Type:**

```typescript
const pipeline: PipelineDefinition = {
  flows: [
    // High priority: PDF with Docling (best quality)
    {
      id: 'flow-pdf-docling',
      name: 'PDF via Docling',
      priority: 50,
      selectionRules: [{ type: 'simple', field: 'doc.fileType', operator: 'eq', value: 'pdf' }],
      stages: [
        { type: 'extraction', provider: 'docling', onError: 'fail' },
        // ... rest of stages
      ],
    },

    // Medium priority: PDF with LlamaIndex (fallback)
    {
      id: 'flow-pdf-llamaindex',
      name: 'PDF via LlamaIndex',
      priority: 40,
      selectionRules: [{ type: 'simple', field: 'doc.fileType', operator: 'eq', value: 'pdf' }],
      stages: [
        { type: 'extraction', provider: 'llamaindex', onError: 'fail' },
        // ... rest of stages
      ],
    },

    // Low priority: PDF with basic text extraction (last resort)
    {
      id: 'flow-pdf-basic',
      name: 'PDF Basic Text Extraction',
      priority: 30,
      selectionRules: [{ type: 'simple', field: 'doc.fileType', operator: 'eq', value: 'pdf' }],
      stages: [
        { type: 'extraction', provider: 'pypdf', onError: 'fail' },
        // ... rest of stages
      ],
    },
  ],
};
```

**Automatic Alternative Flow Selection:**

```typescript
async function executeFlowWithFallback(
  pipeline: PipelineDefinition,
  document: ISearchDocument,
): Promise<FlowExecutionResult> {
  const matchingFlows = pipeline.flows
    .filter((f) => f.enabled && evaluateSelectionRules(f.selectionRules, document))
    .sort((a, b) => b.priority - a.priority);

  if (matchingFlows.length === 0) {
    throw new Error('No matching flow found for document');
  }

  // Try flows in priority order
  for (const flow of matchingFlows) {
    try {
      // Check flow circuit breaker
      const flowBreaker = breakerManager.getFlowBreaker(flow.id);
      const flowBreakerKey = `${document.tenantId}:${flow.id}`;

      const checkResult = await flowBreaker.checkState(flowBreakerKey);
      if (!checkResult.canExecute) {
        logger.info('Flow circuit open, trying next flow', {
          tenantId: document.tenantId,
          documentId: document._id,
          flowId: flow.id,
          priority: flow.priority,
        });
        continue; // Try next flow
      }

      // Execute flow
      const result = await executeFlow(flow, document);
      await flowBreaker.recordSuccess(flowBreakerKey);
      return result;
    } catch (error) {
      // Record failure
      const flowBreaker = breakerManager.getFlowBreaker(flow.id);
      await flowBreaker.recordFailure(`${document.tenantId}:${flow.id}`);

      logger.error('Flow execution failed, trying next flow', {
        tenantId: document.tenantId,
        documentId: document._id,
        flowId: flow.id,
        priority: flow.priority,
        error: error.message,
      });

      // Continue to next flow
    }
  }

  // All flows failed
  throw new Error('All flows failed for document');
}
```

---

## Recovery Strategies

### Automatic Recovery (Circuit Breaker HALF_OPEN)

**How It Works:**

1. Circuit opens after threshold failures (OPEN state)
2. After reset timeout, circuit transitions to HALF_OPEN
3. HALF_OPEN allows limited probes (e.g., 3 concurrent requests)
4. If probes succeed → Circuit closes (CLOSED state), normal operation resumes
5. If any probe fails → Circuit reopens (OPEN state), wait another reset timeout

**Example Timeline:**

```
00:00 - Docling service healthy, circuit CLOSED
00:05 - Docling service starts failing
00:06 - 10 failures in 30s window → Circuit opens (OPEN state)
00:06 - New extraction requests fail immediately with CircuitOpenError
00:07 - (1 min reset timeout)
01:06 - Circuit auto-transitions to HALF_OPEN
01:06 - 1st probe request sent to Docling
01:07 - Probe succeeds
01:07 - 2nd probe request sent (need 2 successes)
01:08 - 2nd probe succeeds → Circuit closes (CLOSED state)
01:08 - Normal operation resumes, all requests processed
```

**No Manual Intervention Required:** Circuit breaker automatically detects service recovery.

### Manual Recovery (Admin Operations)

**Scenario:** Circuit breaker opened due to configuration issue (not service issue), admin fixes config and wants to immediately reset circuit.

**Admin API:**

```typescript
// Reset circuit breaker (admin only)
async function resetCircuitBreaker(
  tenantId: string,
  level: 'provider' | 'stage' | 'flow',
  key: string,
): Promise<void> {
  const breaker = getBreakerByLevel(level);
  const breakerKey = `${tenantId}:${key}`;

  await breaker.reset(breakerKey);

  logger.info('Circuit breaker manually reset', {
    tenantId,
    level,
    key,
  });
}

// Example usage
await resetCircuitBreaker('tenant-123', 'provider', 'docling');
await resetCircuitBreaker('tenant-123', 'flow', 'flow-pdf-docling');
```

**When to Use Manual Reset:**

- Configuration bug fixed (e.g., invalid API key corrected)
- Service incident resolved (confirmed by monitoring)
- Testing after deployment

**When NOT to Use Manual Reset:**

- Service still unhealthy (circuit will immediately reopen)
- Frequent resets needed (indicates underlying issue not resolved)

### Document Retry Strategies

**1. Immediate Retry (Circuit Still Open)**

```typescript
// Retry fails immediately if circuit is still open
try {
  await retryDocument(documentId);
} catch (error) {
  if (error instanceof CircuitOpenError) {
    // Circuit still open, cannot retry
    return {
      success: false,
      message: `Circuit breaker open for ${error.provider}, retry after ${error.retryAfterMs}ms`,
    };
  }
}
```

**2. Delayed Retry (After Circuit Recovers)**

```typescript
// Schedule retry after circuit reset timeout
async function scheduleRetryAfterCircuitRecovery(
  documentId: string,
  flowId: string,
  tenantId: string,
): Promise<void> {
  const flowBreaker = breakerManager.getFlowBreaker(flowId);
  const breakerKey = `${tenantId}:${flowId}`;

  const checkResult = await flowBreaker.checkState(breakerKey);
  if (!checkResult.canExecute) {
    // Schedule retry after retryAfterMs
    await scheduledJobQueue.add(
      'retry-document',
      { documentId, flowId, tenantId },
      { delay: checkResult.retryAfterMs },
    );

    logger.info('Scheduled document retry after circuit recovery', {
      documentId,
      flowId,
      tenantId,
      retryAfterMs: checkResult.retryAfterMs,
    });
  } else {
    // Circuit already recovered, retry immediately
    await retryDocument(documentId);
  }
}
```

**3. Manual Flow Assignment**

```typescript
// Admin manually assigns alternative flow to document
async function assignFlowToDocument(documentId: string, newFlowId: string): Promise<void> {
  const document = await SearchDocument.findById(documentId);
  if (!document) {
    throw new Error('Document not found');
  }

  const pipeline = await PipelineDefinition.findOne({ knowledgeBaseId: document.knowledgeBaseId });
  const flow = pipeline.flows.find((f) => f.id === newFlowId);
  if (!flow) {
    throw new Error('Flow not found');
  }

  // Execute document with specific flow
  await flowOrchestrator.executeFlowInternal(flow, document, pipeline);
}
```

### Bulk Retry (After Service Recovery)

**Scenario:** Docling service was down for 30 minutes, 500 documents failed. Service is now recovered, need to retry all failed documents.

**Bulk Retry Job:**

```typescript
async function retryFailedDocuments(
  tenantId: string,
  flowId: string,
  failedAfterTimestamp: Date,
): Promise<BulkRetryResult> {
  // Find all documents that failed for this flow
  const failedDocuments = await SearchDocument.find({
    tenantId,
    flowId,
    status: 'error',
    updatedAt: { $gte: failedAfterTimestamp },
  });

  logger.info('Starting bulk retry', {
    tenantId,
    flowId,
    documentCount: failedDocuments.length,
  });

  // Check circuit breaker health
  const flowBreaker = breakerManager.getFlowBreaker(flowId);
  const breakerKey = `${tenantId}:${flowId}`;
  const checkResult = await flowBreaker.checkState(breakerKey);

  if (!checkResult.canExecute) {
    throw new Error(
      `Cannot retry, circuit breaker still open. Retry after ${checkResult.retryAfterMs}ms`,
    );
  }

  // Retry documents with backpressure control
  let successCount = 0;
  let failCount = 0;

  for (const document of failedDocuments) {
    // Check backpressure
    await checkBackpressure('search-extraction');

    try {
      await flowOrchestrator.executeFlow(pipeline, document);
      successCount++;
    } catch (error) {
      logger.error('Bulk retry failed for document', {
        documentId: document._id,
        error: error.message,
      });
      failCount++;
    }

    // Rate limit bulk retries
    await sleep(100);
  }

  return {
    totalDocuments: failedDocuments.length,
    successCount,
    failCount,
  };
}
```

---

## Configuration Recommendations

### Provider-Level Configuration

| Provider                | Failure Threshold | Reset Timeout | Success Threshold | Rationale                                                           |
| ----------------------- | ----------------- | ------------- | ----------------- | ------------------------------------------------------------------- |
| **LLM Providers**       |                   |               |                   |                                                                     |
| OpenAI                  | 5                 | 120s          | 3                 | Rate limits common, long recovery time                              |
| Anthropic               | 5                 | 120s          | 3                 | Rate limits common, long recovery time                              |
| Google Gemini           | 5                 | 120s          | 3                 | Rate limits common, long recovery time                              |
| **Extraction Services** |                   |               |                   |                                                                     |
| Docling                 | 10                | 60s           | 2                 | Self-hosted, moderate recovery time                                 |
| LlamaIndex              | 10                | 60s           | 2                 | Self-hosted, moderate recovery time                                 |
| **Embedding Services**  |                   |               |                   |                                                                     |
| BGE-M3                  | 10                | 60s           | 2                 | Self-hosted, moderate recovery time                                 |
| OpenAI Embeddings       | 5                 | 120s          | 3                 | Rate limits, long recovery time                                     |
| **Database Services**   |                   |               |                   |                                                                     |
| MongoDB                 | 20                | 30s           | 5                 | Self-hosted, quick recovery, high threshold (avoid false positives) |
| Neo4j                   | 15                | 30s           | 3                 | Self-hosted, quick recovery                                         |
| OpenSearch              | 15                | 30s           | 3                 | Managed service, quick recovery                                     |

### Stage-Type Configuration

| Stage Type      | Failure Threshold | Reset Timeout | Success Threshold | Rationale                                     |
| --------------- | ----------------- | ------------- | ----------------- | --------------------------------------------- |
| Extraction      | 20                | 120s          | 5                 | Critical stage, conservative thresholds       |
| Chunking        | 15                | 60s           | 3                 | Moderate, less dependent on external services |
| Enrichment      | 30                | 90s           | 5                 | Non-critical, can skip, high threshold        |
| Embedding       | 20                | 120s          | 5                 | Critical for search, conservative             |
| Knowledge Graph | 30                | 90s           | 3                 | Non-critical, can skip                        |

### Flow-Level Configuration

| Flow Criticality       | Failure Threshold | Reset Timeout | Success Threshold | Rationale                                 |
| ---------------------- | ----------------- | ------------- | ----------------- | ----------------------------------------- |
| High (no alternatives) | 15                | 180s          | 10                | Conservative, long recovery validation    |
| Medium (1 alternative) | 25                | 120s          | 5                 | Moderate, allow quick alternative routing |
| Low (2+ alternatives)  | 30                | 90s           | 3                 | Aggressive, fast alternative selection    |

### Tuning Guidelines

**Increase Failure Threshold When:**

- Service has frequent transient failures (spiky)
- Service has high traffic volume (avoid false positives from single failures)
- Stage is non-critical (can tolerate more failures before opening circuit)

**Decrease Failure Threshold When:**

- Service failures are expensive (LLM API calls)
- Service failures are slow (long timeouts)
- Fast failure detection is important

**Increase Reset Timeout When:**

- Service recovery is slow (cold starts, cache warming)
- Service has rate limits (need time for limits to reset)
- External managed service (less control over recovery)

**Decrease Reset Timeout When:**

- Service recovery is fast (self-hosted, simple restart)
- Quick recovery detection is important
- Testing/development environment

**Increase Success Threshold When:**

- High confidence needed before resuming (production)
- Service has flaky recovery (intermittent failures)
- Critical stage (extraction, embedding)

**Decrease Success Threshold When:**

- Fast recovery is important
- Service is reliable
- Non-critical stage (enrichment, knowledge graph)

---

## Monitoring & Alerting

### Metrics to Track

**1. Circuit Breaker State Changes**

Track when circuits open/close for all levels:

```typescript
// Event emitted by circuit breaker
circuitBreaker.on('stateChange', (event: CircuitBreakerStateChangeEvent) => {
  metrics.increment('circuit_breaker.state_change', {
    level: event.level,
    key: event.key,
    from: event.fromState,
    to: event.toState,
    tenant_id: event.tenantId,
  });

  // Alert on CLOSED → OPEN
  if (event.fromState === 'CLOSED' && event.toState === 'OPEN') {
    alerting.send({
      severity: 'high',
      title: `Circuit breaker opened: ${event.level}:${event.key}`,
      message: `Failure threshold exceeded, circuit is now rejecting requests`,
      tenantId: event.tenantId,
    });
  }
});
```

**2. Failure Rate by Provider**

Track failure rate for each provider:

```typescript
// Record failure rate metrics
await metrics.gauge('pipeline.provider.failure_rate', failureRate, {
  tenant_id: tenantId,
  provider: providerId,
  stage_type: stageType,
});
```

**3. Circuit Breaker Rejections**

Track how many requests are rejected due to open circuit:

```typescript
try {
  await breaker.execute(key, fn);
} catch (error) {
  if (error instanceof CircuitOpenError) {
    metrics.increment('circuit_breaker.rejection', {
      level: breaker.level,
      key,
      tenant_id: tenantId,
    });
  }
}
```

**4. Fallback Success Rate**

Track how often fallbacks succeed:

```typescript
// Primary provider failed, trying fallback
metrics.increment('pipeline.fallback.attempt', {
  tenant_id: tenantId,
  primary_provider: stage.provider,
  fallback_provider: stage.fallbackProvider,
});

// Fallback succeeded
metrics.increment('pipeline.fallback.success', {
  tenant_id: tenantId,
  primary_provider: stage.provider,
  fallback_provider: stage.fallbackProvider,
});
```

**5. Alternative Flow Usage**

Track when alternative flows are used:

```typescript
metrics.increment('pipeline.flow.alternative', {
  tenant_id: tenantId,
  primary_flow_id: primaryFlow.id,
  alternative_flow_id: alternativeFlow.id,
});
```

### Dashboards

**Circuit Breaker Health Dashboard:**

- Circuit breaker state by level (provider, stage, flow)
- Open circuit count by tenant
- Circuit breaker rejections per minute
- Time in OPEN state histogram
- Recovery success rate (HALF_OPEN → CLOSED transitions)

**Pipeline Failure Dashboard:**

- Failure rate by stage type
- Failure rate by provider
- Top 10 failing flows
- Fallback usage rate
- Alternative flow routing rate
- Documents stuck in error state

### Alerts

**Critical Alerts:**

1. **Circuit Breaker Opened (Flow-Level)**
   - Severity: High
   - Condition: Flow circuit breaker transitions to OPEN
   - Action: Investigate flow configuration, check provider health

2. **Circuit Breaker Opened (Provider-Level)**
   - Severity: High
   - Condition: Provider circuit breaker transitions to OPEN
   - Action: Check provider service health, API key validity, rate limits

3. **All Flows Failing for Tenant**
   - Severity: Critical
   - Condition: All flows for a tenant have open circuit breakers
   - Action: Immediate investigation, tenant cannot process documents

**Warning Alerts:**

1. **Circuit Breaker in HALF_OPEN for Extended Period**
   - Severity: Medium
   - Condition: Circuit in HALF_OPEN for > 5 minutes (repeated failures)
   - Action: Service is unstable, may need manual intervention

2. **High Fallback Usage Rate**
   - Severity: Medium
   - Condition: Fallback provider used for > 30% of requests
   - Action: Primary provider degraded, investigate

3. **Alternative Flow Routing Increase**
   - Severity: Medium
   - Condition: Alternative flow usage increased by > 50%
   - Action: Primary flow unhealthy, investigate

---

## Implementation Checklist

### Phase 1: Infrastructure (Week 1)

- [ ] Extend `@agent-platform/circuit-breaker` package with new levels
  - [ ] Add `pipeline_provider` level
  - [ ] Add `pipeline_stage` level
  - [ ] Add `pipeline_flow` level
  - [ ] Add configuration defaults
  - [ ] Add unit tests

- [ ] Create `PipelineCircuitBreakerManager` class
  - [ ] Provider breaker getter
  - [ ] Stage breaker getter
  - [ ] Flow breaker getter
  - [ ] Health status aggregation
  - [ ] Admin reset operations

- [ ] Error classification helper
  - [ ] `FailureType` enum
  - [ ] `classifyError()` function
  - [ ] `shouldRecordFailure()` function

### Phase 2: Stage Executor Integration (Week 2)

- [ ] Update `StageExecutor` class
  - [ ] Provider-level breaker check before execution
  - [ ] Stage-type breaker check before execution
  - [ ] Error classification on failure
  - [ ] Conditional breaker failure recording
  - [ ] Provider fallback logic

- [ ] Update `PipelineWorker` class
  - [ ] Wrap stage execution with circuit breaker
  - [ ] Handle `CircuitOpenError` (don't retry)
  - [ ] Handle `onError: 'continue'` policy

- [ ] Provider fallback configuration
  - [ ] Add `fallbackProvider` field to `PipelineStage` schema
  - [ ] Add `fallbackConfig` field to `PipelineStage` schema
  - [ ] Update Studio UI to configure fallbacks

### Phase 3: Flow Orchestrator Integration (Week 3)

- [ ] Update `FlowOrchestrator` class
  - [ ] Flow-level breaker check before execution
  - [ ] Alternative flow selection on circuit open
  - [ ] Record success/failure for flow breaker

- [ ] Update `PipelineFlowBuilder` class
  - [ ] Set `failParentOnFailure: true` on all children
  - [ ] Set `ignoreDependencyOnFailure` based on `onError` policy
  - [ ] Per-stage lock duration configuration

- [ ] Create `SafeFlowProducer` wrapper
  - [ ] Validate flow creation (Issue #3851 mitigation)
  - [ ] Verify parent job exists in Redis
  - [ ] Verify children exist

### Phase 4: Recovery & Admin Operations (Week 4)

- [ ] Admin API endpoints
  - [ ] `POST /api/admin/circuit-breaker/reset` - Manually reset circuit
  - [ ] `GET /api/admin/circuit-breaker/status` - Get health status
  - [ ] `POST /api/admin/documents/:id/retry` - Retry failed document
  - [ ] `POST /api/admin/documents/bulk-retry` - Bulk retry

- [ ] Document retry logic
  - [ ] Immediate retry (checks circuit state)
  - [ ] Scheduled retry (after circuit recovery)
  - [ ] Manual flow assignment

- [ ] Bulk retry job
  - [ ] Query failed documents
  - [ ] Check circuit breaker health
  - [ ] Retry with backpressure control

### Phase 5: Monitoring & Alerting (Week 5)

- [ ] Metrics instrumentation
  - [ ] Circuit breaker state change events
  - [ ] Failure rate by provider
  - [ ] Circuit breaker rejections
  - [ ] Fallback success rate
  - [ ] Alternative flow usage

- [ ] Dashboards (Grafana/Datadog)
  - [ ] Circuit breaker health dashboard
  - [ ] Pipeline failure dashboard

- [ ] Alerts (PagerDuty/Slack)
  - [ ] Critical: Flow circuit opened
  - [ ] Critical: Provider circuit opened
  - [ ] Critical: All flows failing for tenant
  - [ ] Warning: Circuit in HALF_OPEN extended
  - [ ] Warning: High fallback usage
  - [ ] Warning: Alternative flow routing increase

### Phase 6: Testing & Documentation (Week 6)

- [ ] Unit tests
  - [ ] Circuit breaker manager
  - [ ] Error classification
  - [ ] Provider fallback logic
  - [ ] Alternative flow selection

- [ ] Integration tests
  - [ ] Full flow with circuit breaker
  - [ ] Provider failure → fallback
  - [ ] Stage failure → alternative flow
  - [ ] Bulk retry after recovery

- [ ] Load tests
  - [ ] Circuit breaker under high load
  - [ ] Memory usage (circuit breaker state in Redis)
  - [ ] Latency impact (checkState calls)

- [ ] Documentation
  - [ ] Circuit breaker configuration guide
  - [ ] Runbook for circuit breaker incidents
  - [ ] Dashboard/alert reference

---

## Appendix: Code Examples

### Complete Stage Executor with Circuit Breaker

```typescript
import { Redis } from 'ioredis';
import { RedisCircuitBreaker, CircuitOpenError } from '@agent-platform/circuit-breaker';
import { createLogger } from '@abl/compiler/platform';

export class StageExecutor {
  private logger = createLogger('stage-executor');

  constructor(
    private breakerManager: PipelineCircuitBreakerManager,
    private providerRegistry: ProviderRegistry,
  ) {}

  async executeStage(
    stage: PipelineStage,
    input: StageInput,
    context: ExecutionContext,
  ): Promise<StageOutput> {
    const { tenantId, documentId } = context;

    // Level 2: Check stage-type breaker
    const stageBreaker = this.breakerManager.getStageBreaker(stage.type);
    const stageBreakerKey = `${tenantId}:${stage.type}`;

    const stageCheck = await stageBreaker.checkState(stageBreakerKey);
    if (!stageCheck.canExecute) {
      if (stage.onError === 'continue') {
        this.logger.warn('Stage type circuit open, skipping stage', {
          tenantId,
          documentId,
          stageType: stage.type,
          stageName: stage.name,
        });
        return { skipped: true, reason: 'circuit_open' };
      }

      throw new StageCircuitOpenError(`Stage type ${stage.type} circuit is open`, {
        retryAfterMs: stageCheck.retryAfterMs,
      });
    }

    // Level 1: Execute with provider breaker
    const providerBreaker = this.breakerManager.getProviderBreaker(stage.provider);
    const providerBreakerKey = `${tenantId}:${stage.provider}`;

    try {
      const result = await providerBreaker.execute(providerBreakerKey, async () => {
        const provider = this.providerRegistry.get(stage.provider);
        return await provider.execute(input, stage.providerConfig);
      });

      // Record success for stage-type breaker
      await stageBreaker.recordSuccess(stageBreakerKey);

      return result;
    } catch (error) {
      // Classify error
      const failureType = classifyError(error, stage);

      // Record failure only for infrastructure/service errors
      if (
        failureType === FailureType.INFRASTRUCTURE ||
        failureType === FailureType.SERVICE ||
        failureType === FailureType.RATE_LIMIT
      ) {
        await stageBreaker.recordFailure(stageBreakerKey);
      }

      // Try provider fallback if circuit open
      if (error instanceof CircuitOpenError) {
        const fallbackResult = await this.tryProviderFallback(stage, input, context);
        if (fallbackResult) {
          return fallbackResult;
        }
      }

      // Handle based on stage onError policy
      if (stage.onError === 'continue') {
        this.logger.error('Stage execution failed, continuing per onError policy', {
          tenantId,
          documentId,
          stageType: stage.type,
          stageName: stage.name,
          error: error.message,
        });
        return { skipped: true, error: error.message };
      }

      throw error;
    }
  }

  private async tryProviderFallback(
    stage: PipelineStage,
    input: StageInput,
    context: ExecutionContext,
  ): Promise<StageOutput | null> {
    if (!stage.fallbackProvider) {
      return null;
    }

    const fallbackBreaker = this.breakerManager.getProviderBreaker(stage.fallbackProvider);
    const fallbackKey = `${context.tenantId}:${stage.fallbackProvider}`;

    const fallbackCheck = await fallbackBreaker.checkState(fallbackKey);
    if (!fallbackCheck.canExecute) {
      return null;
    }

    try {
      const fallbackProvider = this.providerRegistry.get(stage.fallbackProvider);
      return await fallbackBreaker.execute(fallbackKey, async () => {
        return await fallbackProvider.execute(input, stage.fallbackConfig || stage.providerConfig);
      });
    } catch (error) {
      this.logger.error('Fallback provider also failed', {
        tenantId: context.tenantId,
        documentId: context.documentId,
        primaryProvider: stage.provider,
        fallbackProvider: stage.fallbackProvider,
        error: error.message,
      });
      return null;
    }
  }
}
```

---

## Summary

This research establishes a comprehensive circuit breaker strategy for SearchAI's pluggable pipeline flows:

1. **Three-Level Protection:** Provider → Stage-Type → Flow breakers provide defense in depth
2. **Reuse Existing Infrastructure:** The `@agent-platform/circuit-breaker` package requires only configuration, not architectural changes
3. **BullMQ Integration:** Combine circuit breaker with `failParentOnFailure: true` and flow validation
4. **Fallback Hierarchy:** Provider fallback → Stage skip → Alternative flow → Manual intervention
5. **Smart Failure Detection:** Classify errors to avoid opening circuits on document-specific issues
6. **Automatic Recovery:** HALF_OPEN probes detect service recovery without manual intervention
7. **Comprehensive Monitoring:** Track circuit state changes, failure rates, and fallback usage

**Next Steps:** Proceed to design phase (Tasks #39-46) to design the actual implementation.

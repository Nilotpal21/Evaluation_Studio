# Circuit Breaker Implementation Design

**Task:** Backend Design - Circuit breaker implementation for flows (CRITICAL)
**Status:** Complete
**Date:** 2026-03-07
**Related:** RESEARCH-circuit-breaker-flow-failures.md, Task #67, Task #44

---

## Executive Summary

This document specifies the complete circuit breaker implementation for flow execution to enable graceful degradation when providers fail. The design uses provider-level circuit breakers with system defaults.

**Key Decision:** Provider-level circuit breakers only

- ✅ Protects against provider failures (e.g., Docling, OpenAI down)
- ✅ Simple to implement and maintain
- ✅ Reuses existing `@agent-platform/circuit-breaker` package
- ✅ No UI configuration needed (system defaults)

**Scope:** First iteration implements provider-level only. Stage-type and flow-level breakers can be added in v2 if needed.

---

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Design Decision](#design-decision)
3. [Circuit Breaker Architecture](#circuit-breaker-architecture)
4. [Provider Registry Integration](#provider-registry-integration)
5. [Configuration Specification](#configuration-specification)
6. [Fallback Behavior](#fallback-behavior)
7. [Monitoring & Alerts](#monitoring--alerts)
8. [Testing Strategy](#testing-strategy)

---

## Problem Statement

### Current State

**Without Circuit Breakers:**

```typescript
// Current flow execution
async function executeStage(stage: PipelineStage) {
  try {
    const provider = await providerRegistry.get(stage.provider);
    const result = await provider.execute(stage.config);
    return result;
  } catch (error) {
    // Retry 3 times with exponential backoff
    // If all retries fail, fail the entire flow
    throw error;
  }
}
```

**Problems:**

1. **Cascading Failures:**
   - If Docling is down, every PDF extraction attempt retries 3 times
   - 1000 PDFs in queue → 3000 failed requests → 5+ minute delay
   - Worker threads blocked, queue backs up

2. **No Fast Fail:**
   - Each job waits for timeout (e.g., 10 minutes) before failing
   - Wastes resources on known-failing provider

3. **No Fallback:**
   - Even if fallback provider configured, primary always tried first
   - No way to skip failing provider and go straight to fallback

### Requirements

1. **Fast Fail** - Stop calling failing provider immediately
2. **Automatic Recovery** - Try provider again after cooldown period
3. **Fallback Support** - Use fallback provider when circuit is open
4. **Tenant Isolation** - Circuit state per tenant (optional, for fairness)
5. **Observable** - Expose circuit state via metrics and logs

---

## Design Decision

### Selected Approach: Provider-Level Circuit Breakers

**Rationale:**

✅ **Protects Critical Path:**

- Provider failures are most common (API downtime, rate limits)
- Single provider failure affects multiple flows
- Provider-level breaker prevents cascading failures

✅ **Simple to Implement:**

- One breaker per provider ID (e.g., 'docling', 'openai')
- Reuse existing `@agent-platform/circuit-breaker` package
- No complex hierarchical logic

✅ **Automatic Fallback:**

- When circuit opens → immediately use fallback provider
- No wasted retries on known-failing provider

✅ **No UI Needed:**

- System defaults sufficient for most cases
- Platform admins can tune via environment variables if needed
- No per-pipeline configuration complexity

**Trade-offs:**

❌ **No Fine-Grained Control:**

- Can't disable circuit breaker for specific flow
- Can't set different thresholds per pipeline
- Acceptable: System defaults work for 95% of cases

❌ **No Stage-Type or Flow-Level:**

- Stage-type breakers (e.g., all 'extraction' stages) not in v1
- Flow-level breakers not in v1
- Mitigation: Can add in v2 if needed (YAGNI principle)

---

## Circuit Breaker Architecture

### Three-State FSM

```
┌─────────────────────────────────────────────────────────────────┐
│                    Circuit Breaker States                        │
└─────────────────────────────────────────────────────────────────┘

    ┌─────────┐
    │ CLOSED  │ ◄─────────────────┐
    │ (Normal)│                    │
    └────┬────┘                    │
         │                         │
         │ Failure threshold       │ Success threshold
         │ exceeded                │ met in half-open
         │                         │
         ▼                         │
    ┌─────────┐                    │
    │  OPEN   │                    │
    │(Failing)│                    │
    └────┬────┘                    │
         │                         │
         │ Timeout elapsed         │
         │                         │
         ▼                         │
    ┌──────────┐                   │
    │HALF-OPEN │───────────────────┘
    │(Testing) │
    └──────────┘
```

**State Descriptions:**

1. **CLOSED (Normal):**
   - All requests go through
   - Track failure rate
   - If failures exceed threshold → OPEN

2. **OPEN (Failing):**
   - All requests fail immediately (fast fail)
   - No calls to provider
   - Use fallback provider if configured
   - After timeout → HALF-OPEN

3. **HALF-OPEN (Testing):**
   - Allow limited test requests through
   - If test requests succeed → CLOSED
   - If test requests fail → OPEN

### Circuit Breaker Flow

```typescript
┌──────────────────────────────────────────────────────────────────┐
│ Execute Stage with Circuit Breaker                               │
└──────────────────────────────────────────────────────────────────┘

┌─────────────────┐
│ Load Provider   │
│ Circuit Breaker │
└────────┬────────┘
         │
         ▼
    ┌─────────┐
    │ Closed? │
    └────┬────┘
         │
    Yes  │  No
    ┌────▼────┐                    ┌──────────┐
    │ Execute │                    │   OPEN   │
    │ Provider│                    │          │
    └────┬────┘                    └────┬─────┘
         │                              │
         │                              ▼
    ┌────▼──────┐              ┌────────────────┐
    │ Success?  │              │ Use Fallback   │
    └────┬──────┘              │ Provider?      │
         │                     └────┬───────────┘
    Yes  │  No                      │
    ┌────▼────┐              ┌──────▼──────┐
    │ Return  │              │ Execute     │
    │ Result  │              │ Fallback    │
    └─────────┘              └──────┬──────┘
                                    │
                             ┌──────▼──────┐
                             │ Success?    │
                             └──────┬──────┘
                                    │
                               Yes  │  No
                             ┌──────▼────┐    ┌──────────┐
                             │ Return    │    │ Fail Flow│
                             │ Result    │    └──────────┘
                             └───────────┘
```

---

## Provider Registry Integration

### Existing Circuit Breaker Package

**Package:** `@agent-platform/circuit-breaker`

**Already in Production:**

```typescript
// packages/circuit-breaker/src/redis-circuit-breaker.ts

export class RedisCircuitBreaker {
  constructor(
    private readonly redis: Redis,
    private readonly config: CircuitBreakerConfig,
  ) {}

  async execute<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const state = await this.getState(key);

    if (state === 'OPEN') {
      throw new CircuitBreakerOpenError(`Circuit breaker ${key} is OPEN`);
    }

    if (state === 'HALF_OPEN') {
      // Allow test request
      try {
        const result = await fn();
        await this.recordSuccess(key);
        return result;
      } catch (error) {
        await this.recordFailure(key);
        throw error;
      }
    }

    // CLOSED state
    try {
      const result = await fn();
      await this.recordSuccess(key);
      return result;
    } catch (error) {
      await this.recordFailure(key);
      throw error;
    }
  }

  private async getState(key: string): Promise<CircuitState> {
    // Check Redis for circuit state
    const failures = await this.redis.get(`cb:${key}:failures`);
    const openUntil = await this.redis.get(`cb:${key}:open_until`);

    if (openUntil && Date.now() < parseInt(openUntil)) {
      return 'OPEN';
    }

    if (openUntil && Date.now() >= parseInt(openUntil)) {
      return 'HALF_OPEN';
    }

    return 'CLOSED';
  }

  private async recordFailure(key: string): Promise<void> {
    const failures = await this.redis.incr(`cb:${key}:failures`);
    await this.redis.expire(`cb:${key}:failures`, this.config.windowMs / 1000);

    if (failures >= this.config.failureThreshold) {
      const openUntil = Date.now() + this.config.openTimeoutMs;
      await this.redis.set(`cb:${key}:open_until`, openUntil);
      await this.redis.expire(`cb:${key}:open_until`, this.config.openTimeoutMs / 1000);
    }
  }

  private async recordSuccess(key: string): Promise<void> {
    await this.redis.del(`cb:${key}:failures`);
    await this.redis.del(`cb:${key}:open_until`);
  }
}
```

### Provider Registry Wrapper

```typescript
// apps/search-ai/src/services/pipeline/provider-registry.ts

import { RedisCircuitBreaker } from '@agent-platform/circuit-breaker';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('pipeline:provider-registry');

export interface PipelineStageProvider<TInput, TOutput, TConfig> {
  id: string;
  name: string;
  type: PipelineStageType;
  execute(input: TInput, config: TConfig): Promise<TOutput>;
  validateConfig(config: unknown): config is TConfig;
  getSchema(): JSONSchema;
}

export class ProviderRegistryWithCircuitBreaker {
  private providers = new Map<string, PipelineStageProvider<any, any, any>>();
  private circuitBreaker: RedisCircuitBreaker;

  constructor(redis: Redis) {
    this.circuitBreaker = new RedisCircuitBreaker(redis, {
      failureThreshold: 5, // Open after 5 failures
      windowMs: 60000, // 1-minute window
      openTimeoutMs: 30000, // 30-second timeout
      halfOpenMaxRequests: 3, // Allow 3 test requests in half-open
    });
  }

  register<TInput, TOutput, TConfig>(
    provider: PipelineStageProvider<TInput, TOutput, TConfig>,
  ): void {
    this.providers.set(provider.id, provider);
    logger.info('Registered provider with circuit breaker', {
      providerId: provider.id,
      providerType: provider.type,
    });
  }

  async execute<TInput, TOutput, TConfig>(
    providerId: string,
    input: TInput,
    config: TConfig,
    options?: {
      fallbackProviderId?: string;
      fallbackConfig?: unknown;
      tenantId?: string;
    },
  ): Promise<TOutput> {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Provider not found: ${providerId}`);
    }

    // Circuit breaker key: provider ID (global) OR provider ID + tenant ID (isolated)
    const circuitKey = options?.tenantId ? `${providerId}:${options.tenantId}` : providerId;

    try {
      // Execute with circuit breaker
      const result = await this.circuitBreaker.execute(circuitKey, async () => {
        return await provider.execute(input, config);
      });

      return result;
    } catch (error) {
      // If circuit is OPEN, try fallback
      if (error instanceof CircuitBreakerOpenError && options?.fallbackProviderId) {
        logger.warn('Circuit breaker OPEN, using fallback provider', {
          providerId,
          fallbackProviderId: options.fallbackProviderId,
          circuitKey,
        });

        const fallbackProvider = this.providers.get(options.fallbackProviderId);
        if (!fallbackProvider) {
          throw new Error(`Fallback provider not found: ${options.fallbackProviderId}`);
        }

        // Execute fallback WITHOUT circuit breaker (fallback is independent)
        return await fallbackProvider.execute(input, options.fallbackConfig);
      }

      // No fallback or circuit not open, rethrow
      throw error;
    }
  }

  async getCircuitState(providerId: string, tenantId?: string): Promise<CircuitState> {
    const circuitKey = tenantId ? `${providerId}:${tenantId}` : providerId;
    return await this.circuitBreaker.getState(circuitKey);
  }
}
```

### Stage Execution with Circuit Breaker

```typescript
// apps/search-ai/src/services/pipeline/stage-executor.ts

export class StageExecutor {
  constructor(
    private readonly providerRegistry: ProviderRegistryWithCircuitBreaker,
    private readonly logger: Logger,
  ) {}

  async executeStage(
    stage: IPipelineStage,
    input: unknown,
    context: ExecutionContext,
  ): Promise<unknown> {
    this.logger.info('Executing stage', {
      stageId: stage.id,
      stageName: stage.name,
      stageType: stage.type,
      providerId: stage.provider,
      tenantId: context.tenantId,
    });

    try {
      const result = await this.providerRegistry.execute(
        stage.provider,
        input,
        stage.providerConfig,
        {
          fallbackProviderId: stage.fallbackProvider,
          fallbackConfig: stage.fallbackConfig,
          tenantId: context.tenantId, // Optional: tenant-isolated circuit breakers
        },
      );

      this.logger.info('Stage execution succeeded', {
        stageId: stage.id,
        providerId: stage.provider,
      });

      return result;
    } catch (error) {
      this.logger.error('Stage execution failed', {
        stageId: stage.id,
        providerId: stage.provider,
        error: error instanceof Error ? error.message : String(error),
      });

      // Check if onError is 'continue' (skip stage)
      if (stage.onError === 'continue') {
        this.logger.warn('Stage failed but onError=continue, skipping stage', {
          stageId: stage.id,
        });
        return input; // Return input unchanged
      }

      // onError is 'fail', throw to fail entire flow
      throw error;
    }
  }
}
```

---

## Configuration Specification

### System Defaults

```typescript
// packages/config/src/circuit-breaker.ts

export interface CircuitBreakerConfig {
  // Failure threshold: Open circuit after N failures
  failureThreshold: number;

  // Time window: Count failures within this window (ms)
  windowMs: number;

  // Open timeout: How long to stay OPEN before testing (ms)
  openTimeoutMs: number;

  // Half-open max requests: How many test requests in HALF-OPEN
  halfOpenMaxRequests: number;
}

export const CIRCUIT_BREAKER_DEFAULTS: CircuitBreakerConfig = {
  failureThreshold: 5, // Open after 5 failures
  windowMs: 60000, // 1-minute window
  openTimeoutMs: 30000, // 30-second timeout (test after 30s)
  halfOpenMaxRequests: 3, // Allow 3 test requests
};

// Provider-specific overrides (if needed)
export const CIRCUIT_BREAKER_PROVIDER_OVERRIDES: Record<string, Partial<CircuitBreakerConfig>> = {
  // Docling: More lenient (extraction can be slow/flaky)
  docling: {
    failureThreshold: 10, // Open after 10 failures
    openTimeoutMs: 60000, // 1-minute timeout
  },

  // OpenAI: Strict (API is reliable, failures are real issues)
  openai: {
    failureThreshold: 3, // Open after 3 failures
    openTimeoutMs: 20000, // 20-second timeout
  },

  // BGE-M3: Lenient (self-hosted, can have hiccups)
  'bge-m3': {
    failureThreshold: 15, // Open after 15 failures
    openTimeoutMs: 120000, // 2-minute timeout
  },
};

export function getCircuitBreakerConfig(providerId: string): CircuitBreakerConfig {
  const overrides = CIRCUIT_BREAKER_PROVIDER_OVERRIDES[providerId] || {};
  return { ...CIRCUIT_BREAKER_DEFAULTS, ...overrides };
}
```

### Environment Variables

```bash
# Global circuit breaker settings (optional overrides)
CIRCUIT_BREAKER_FAILURE_THRESHOLD=5
CIRCUIT_BREAKER_WINDOW_MS=60000
CIRCUIT_BREAKER_OPEN_TIMEOUT_MS=30000
CIRCUIT_BREAKER_HALF_OPEN_MAX_REQUESTS=3

# Per-provider overrides (optional)
CIRCUIT_BREAKER_DOCLING_FAILURE_THRESHOLD=10
CIRCUIT_BREAKER_OPENAI_FAILURE_THRESHOLD=3
```

---

## Fallback Behavior

### Fallback Decision Tree

```typescript
┌────────────────────────────────────────────────────────────┐
│ Circuit Breaker OPEN - How to Handle?                      │
└────────────────────────────────────────────────────────────┘

┌─────────────────────────┐
│ Circuit is OPEN         │
└────────┬────────────────┘
         │
         ▼
    ┌─────────────────┐
    │ Fallback        │
    │ Provider        │
    │ Configured?     │
    └────┬────────────┘
         │
    Yes  │  No
    ┌────▼────┐       ┌───────────┐
    │ Execute │       │ onError=  │
    │ Fallback│       │ continue? │
    └────┬────┘       └─────┬─────┘
         │                  │
    ┌────▼──────┐      Yes  │  No
    │ Fallback  │      ┌────▼────┐    ┌──────────┐
    │ Success?  │      │ Skip    │    │ Fail Flow│
    └────┬──────┘      │ Stage   │    └──────────┘
         │             └─────────┘
    Yes  │  No
    ┌────▼────┐       ┌──────────┐
    │ Return  │       │ onError= │
    │ Result  │       │continue? │
    └─────────┘       └─────┬────┘
                            │
                       Yes  │  No
                       ┌────▼────┐    ┌──────────┐
                       │ Skip    │    │ Fail Flow│
                       │ Stage   │    └──────────┘
                       └─────────┘
```

### Fallback Examples

**Example 1: Docling → Apache Tika Fallback**

```typescript
// Pipeline stage configuration
{
  id: 'stage-extract-1',
  type: 'extraction',
  provider: 'docling',
  providerConfig: {
    extractTables: true,
    extractImages: true,
  },
  fallbackProvider: 'apache-tika',
  fallbackConfig: {
    extractTables: false, // Tika doesn't extract tables well
  },
  onError: 'fail', // If fallback also fails, fail flow
}
```

**Behavior:**

1. Try Docling → Circuit OPEN
2. Use Apache Tika fallback → Success
3. Continue flow with Tika output

**Example 2: OpenAI → Anthropic Fallback**

```typescript
{
  id: 'stage-enrich-1',
  type: 'enrichment',
  provider: 'openai',
  providerConfig: {
    model: 'gpt-4',
    temperature: 0,
  },
  fallbackProvider: 'anthropic',
  fallbackConfig: {
    model: 'claude-3-sonnet-20240229',
    temperature: 0,
  },
  onError: 'continue', // If both fail, skip enrichment
}
```

**Behavior:**

1. Try OpenAI → Circuit OPEN
2. Use Anthropic fallback → Also fails
3. Skip enrichment (onError=continue)
4. Continue flow without enrichment

**Example 3: No Fallback, Fail Flow**

```typescript
{
  id: 'stage-embed-1',
  type: 'embedding',
  provider: 'openai',
  providerConfig: {
    model: 'text-embedding-3-large',
  },
  // NO fallbackProvider
  onError: 'fail',
}
```

**Behavior:**

1. Try OpenAI → Circuit OPEN
2. No fallback configured
3. Throw CircuitBreakerOpenError
4. Fail entire flow

---

## Monitoring & Alerts

### CloudWatch Metrics

```typescript
// apps/search-ai/src/services/pipeline/circuit-breaker-metrics.ts

export class CircuitBreakerMetrics {
  constructor(private readonly cloudwatch: CloudWatch) {}

  async publishCircuitBreakerState(providerId: string, state: CircuitState): Promise<void> {
    await this.cloudwatch
      .putMetricData({
        Namespace: 'SearchAI/CircuitBreaker',
        MetricData: [
          {
            MetricName: 'CircuitState',
            Dimensions: [
              { Name: 'Provider', Value: providerId },
              { Name: 'State', Value: state },
            ],
            Value: state === 'OPEN' ? 1 : 0,
            Unit: 'Count',
            Timestamp: new Date(),
          },
        ],
      })
      .promise();
  }

  async publishFallbackUsage(providerId: string, fallbackProviderId: string): Promise<void> {
    await this.cloudwatch
      .putMetricData({
        Namespace: 'SearchAI/CircuitBreaker',
        MetricData: [
          {
            MetricName: 'FallbackUsed',
            Dimensions: [
              { Name: 'Provider', Value: providerId },
              { Name: 'FallbackProvider', Value: fallbackProviderId },
            ],
            Value: 1,
            Unit: 'Count',
            Timestamp: new Date(),
          },
        ],
      })
      .promise();
  }
}
```

### CloudWatch Alarms

```yaml
# infrastructure/cloudwatch/alarms/circuit-breaker.yaml

CircuitBreakerOpenAlarm:
  Type: AWS::CloudWatch::Alarm
  Properties:
    AlarmName: Provider-Circuit-Breaker-Open
    AlarmDescription: Provider circuit breaker is OPEN (provider is failing)
    MetricName: CircuitState
    Namespace: SearchAI/CircuitBreaker
    Statistic: Maximum
    Period: 60
    EvaluationPeriods: 1
    Threshold: 1
    ComparisonOperator: GreaterThanOrEqualToThreshold
    Dimensions:
      - Name: Provider
        Value: !Ref ProviderName
      - Name: State
        Value: OPEN
    AlarmActions:
      - !Ref DevOpsAlertTopic
    TreatMissingData: notBreaching
```

### Logs

```typescript
// Example log output
{
  "timestamp": "2026-03-07T10:30:00Z",
  "level": "WARN",
  "message": "Circuit breaker OPEN, using fallback provider",
  "providerId": "docling",
  "fallbackProviderId": "apache-tika",
  "circuitKey": "docling:tenant-123",
  "tenantId": "tenant-123",
  "documentId": "doc-456",
  "stageId": "stage-extract-1"
}
```

---

## Testing Strategy

### Unit Tests

```typescript
// apps/search-ai/src/services/pipeline/__tests__/circuit-breaker.test.ts

import { RedisCircuitBreaker } from '@agent-platform/circuit-breaker';
import Redis from 'ioredis';

describe('Provider Circuit Breaker', () => {
  let redis: Redis;
  let circuitBreaker: RedisCircuitBreaker;

  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_TEST_URL);
    circuitBreaker = new RedisCircuitBreaker(redis, {
      failureThreshold: 3,
      windowMs: 60000,
      openTimeoutMs: 30000,
      halfOpenMaxRequests: 2,
    });
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  it('should remain CLOSED on successful executions', async () => {
    const result = await circuitBreaker.execute('test-provider', async () => {
      return 'success';
    });

    expect(result).toBe('success');

    const state = await circuitBreaker.getState('test-provider');
    expect(state).toBe('CLOSED');
  });

  it('should open circuit after threshold failures', async () => {
    // Fail 3 times
    for (let i = 0; i < 3; i++) {
      try {
        await circuitBreaker.execute('test-provider', async () => {
          throw new Error('Provider failed');
        });
      } catch (error) {
        // Expected
      }
    }

    const state = await circuitBreaker.getState('test-provider');
    expect(state).toBe('OPEN');
  });

  it('should use fallback when circuit is OPEN', async () => {
    const providerRegistry = new ProviderRegistryWithCircuitBreaker(redis);

    // Register primary and fallback providers
    providerRegistry.register({
      id: 'primary',
      execute: async () => {
        throw new Error('Primary failed');
      },
    });

    providerRegistry.register({
      id: 'fallback',
      execute: async () => {
        return 'fallback-result';
      },
    });

    // Fail primary 5 times to open circuit
    for (let i = 0; i < 5; i++) {
      try {
        await providerRegistry.execute('primary', {}, {});
      } catch (error) {
        // Expected
      }
    }

    // Next execution should use fallback
    const result = await providerRegistry.execute(
      'primary',
      {},
      {},
      {
        fallbackProviderId: 'fallback',
      },
    );

    expect(result).toBe('fallback-result');
  });

  it('should transition to HALF-OPEN after timeout', async () => {
    // Open circuit
    for (let i = 0; i < 3; i++) {
      try {
        await circuitBreaker.execute('test-provider', async () => {
          throw new Error('Provider failed');
        });
      } catch (error) {
        // Expected
      }
    }

    // Wait for timeout (30 seconds)
    await new Promise((resolve) => setTimeout(resolve, 31000));

    const state = await circuitBreaker.getState('test-provider');
    expect(state).toBe('HALF_OPEN');
  });
});
```

### Integration Tests

```typescript
// apps/search-ai/src/__tests__/integration/circuit-breaker-flow.test.ts

describe('Flow Execution with Circuit Breaker', () => {
  it('should execute fallback provider when primary circuit is OPEN', async () => {
    // Create pipeline with fallback
    const pipeline = await PipelineDefinition.create({
      tenantId: 'test-tenant',
      knowledgeBaseId: 'test-kb',
      name: 'Test Pipeline',
      flows: [
        {
          id: 'flow-1',
          name: 'Test Flow',
          priority: 10,
          stages: [
            {
              id: 'stage-1',
              type: 'extraction',
              provider: 'docling',
              providerConfig: {},
              fallbackProvider: 'apache-tika',
              fallbackConfig: {},
              onError: 'fail',
            },
          ],
        },
      ],
    });

    // Mock Docling to fail
    jest.spyOn(doclingProvider, 'execute').mockRejectedValue(new Error('Docling down'));

    // Execute flow 5 times to open circuit
    for (let i = 0; i < 5; i++) {
      try {
        await flowExecutor.execute(pipeline.flows[0], testDocument);
      } catch (error) {
        // Expected
      }
    }

    // Mock Apache Tika to succeed
    jest.spyOn(apacheTikaProvider, 'execute').mockResolvedValue(extractedContent);

    // Next execution should use Tika
    const result = await flowExecutor.execute(pipeline.flows[0], testDocument);

    expect(result).toBeDefined();
    expect(apacheTikaProvider.execute).toHaveBeenCalled();
    expect(doclingProvider.execute).not.toHaveBeenCalledTimes(6); // Not called again
  });
});
```

---

## Summary

**Design Complete:**

- ✅ Circuit breaker architecture specified
- ✅ Provider registry integration designed
- ✅ Configuration defaults defined
- ✅ Fallback behavior documented
- ✅ Monitoring & alerts specified
- ✅ Testing strategy provided

**Implementation Scope:**

- ✅ Provider-level circuit breakers only (v1)
- ✅ System defaults only (no UI configuration)
- ✅ Reuse existing `@agent-platform/circuit-breaker` package
- 🔜 Stage-type and flow-level breakers (v2, if needed)

**Next Steps:**

1. Review and approve this design
2. Implement ProviderRegistryWithCircuitBreaker
3. Integrate with StageExecutor
4. Add monitoring metrics
5. Test in staging with simulated failures
6. Deploy to production

**Benefits:**

- Fast fail on provider failures
- Automatic fallback support
- No wasted retries on known-failing providers
- Observable circuit state
- Zero UI configuration needed

---

**End of Document**

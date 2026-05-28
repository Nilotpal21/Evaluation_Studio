import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  traceGuardrailCheck,
  traceGuardrailViolation,
  traceGuardrailWarning,
  traceGuardrailFix,
  traceGuardrailReask,
  tracePipelineComplete,
  traceGuardrailCost,
  traceCircuitBreaker,
  traceCacheHit,
  traceCacheMiss,
  traceProviderError,
  traceToolBlocked,
  traceToolOutputBlocked,
  traceHandoffBlocked,
  tracePipelineError,
  type GuardrailTraceEvent,
  type GuardrailTraceEventType,
} from '../../../services/guardrails/trace-events';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const FIXED_NOW = 1709337600000; // 2024-03-02T00:00:00.000Z

function assertTraceEvent(event: GuardrailTraceEvent, expectedType: GuardrailTraceEventType): void {
  expect(event.type).toBe(expectedType);
  expect(event.timestamp).toBe(FIXED_NOW);
  expect(event.data).toBeDefined();
  expect(typeof event.data).toBe('object');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GuardrailTraceEvents', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // 1. traceGuardrailCheck — creates a guardrail_check event
  // -----------------------------------------------------------------------
  it('should create a guardrail_check event with all fields', () => {
    const data = {
      guardrailName: 'pii_check',
      kind: 'input',
      tier: 'local',
      passed: true,
      score: 0.95,
      threshold: 0.8,
      latencyMs: 12,
      agent: 'booking_agent',
    };

    const event = traceGuardrailCheck(data);

    assertTraceEvent(event, 'guardrail_check');
    expect(event.data).toEqual(data);
  });

  it('should create a guardrail_check event without optional fields', () => {
    const data = {
      guardrailName: 'toxicity',
      kind: 'output',
      tier: 'model',
      passed: false,
      latencyMs: 45,
    };

    const event = traceGuardrailCheck(data);

    assertTraceEvent(event, 'guardrail_check');
    expect(event.data).toEqual(data);
    expect(event.data.score).toBeUndefined();
    expect(event.data.threshold).toBeUndefined();
    expect(event.data.agent).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // 2. traceGuardrailViolation — creates a guardrail_violation event
  // -----------------------------------------------------------------------
  it('should create a guardrail_violation event', () => {
    const data = {
      guardrailName: 'toxicity',
      kind: 'output',
      tier: 'model',
      action: 'block',
      severity: 'critical',
      message: 'Toxic content detected',
      score: 0.92,
      provider: 'openai-moderation',
      agent: 'support_agent',
    };

    const event = traceGuardrailViolation(data);

    assertTraceEvent(event, 'guardrail_violation');
    expect(event.data).toEqual(data);
  });

  it('should create a guardrail_violation event without optional fields', () => {
    const data = {
      guardrailName: 'pii_check',
      kind: 'input',
      tier: 'local',
      action: 'warn',
      severity: 'medium',
      message: 'PII detected in input',
    };

    const event = traceGuardrailViolation(data);

    assertTraceEvent(event, 'guardrail_violation');
    expect(event.data.score).toBeUndefined();
    expect(event.data.provider).toBeUndefined();
    expect(event.data.agent).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // 3. traceGuardrailWarning — creates a guardrail_warning event
  // -----------------------------------------------------------------------
  it('should create a guardrail_warning event', () => {
    const data = {
      guardrailName: 'sentiment_check',
      kind: 'output',
      message: 'Response may appear dismissive',
      agent: 'support_agent',
    };

    const event = traceGuardrailWarning(data);

    assertTraceEvent(event, 'guardrail_warning');
    expect(event.data).toEqual(data);
  });

  // -----------------------------------------------------------------------
  // 4. traceGuardrailFix — creates a guardrail_fix event
  // -----------------------------------------------------------------------
  it('should create a guardrail_fix event', () => {
    const data = {
      guardrailName: 'pii_redaction',
      kind: 'output',
      strategy: 'redact',
      originalLength: 150,
      modifiedLength: 130,
      agent: 'booking_agent',
    };

    const event = traceGuardrailFix(data);

    assertTraceEvent(event, 'guardrail_fix');
    expect(event.data).toEqual(data);
  });

  // -----------------------------------------------------------------------
  // 5. traceGuardrailReask — creates a guardrail_reask event
  // -----------------------------------------------------------------------
  it('should create a guardrail_reask event', () => {
    const data = {
      guardrailName: 'hallucination_check',
      kind: 'output',
      reaskCount: 2,
      maxReasks: 3,
      agent: 'faq_agent',
    };

    const event = traceGuardrailReask(data);

    assertTraceEvent(event, 'guardrail_reask');
    expect(event.data).toEqual(data);
  });

  // -----------------------------------------------------------------------
  // 6. tracePipelineComplete — creates a guardrail_pipeline_complete event
  // -----------------------------------------------------------------------
  it('should create a guardrail_pipeline_complete event', () => {
    const data = {
      kind: 'input',
      totalChecks: 5,
      passed: 4,
      failed: 1,
      warnings: 0,
      totalLatencyMs: 120,
      costUsd: 0.003,
      cacheHits: 2,
      cacheMisses: 3,
      agent: 'booking_agent',
    };

    const event = tracePipelineComplete(data);

    assertTraceEvent(event, 'guardrail_pipeline_complete');
    expect(event.data).toEqual(data);
  });

  // -----------------------------------------------------------------------
  // 7. traceGuardrailCost — creates a guardrail_cost event
  // -----------------------------------------------------------------------
  it('should create a guardrail_cost event', () => {
    const data = {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      costUsd: 0.005,
      currentSpendUsd: 12.5,
      budgetUsd: 100,
      budgetExceeded: false,
    };

    const event = traceGuardrailCost(data);

    assertTraceEvent(event, 'guardrail_cost');
    expect(event.data).toEqual(data);
  });

  it('should create a guardrail_cost event without optional budget', () => {
    const data = {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      costUsd: 0.001,
      currentSpendUsd: 5.0,
      budgetExceeded: false,
    };

    const event = traceGuardrailCost(data);

    assertTraceEvent(event, 'guardrail_cost');
    expect(event.data.budgetUsd).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // 8. traceCircuitBreaker — creates a guardrail_circuit_breaker event
  // -----------------------------------------------------------------------
  it('should create a guardrail_circuit_breaker event', () => {
    const data = {
      provider: 'openai-moderation',
      state: 'open',
      consecutiveFailures: 5,
    };

    const event = traceCircuitBreaker(data);

    assertTraceEvent(event, 'guardrail_circuit_breaker');
    expect(event.data).toEqual(data);
  });

  // -----------------------------------------------------------------------
  // 9. traceCacheHit — creates a guardrail_cache_hit event
  // -----------------------------------------------------------------------
  it('should create a guardrail_cache_hit event', () => {
    const data = {
      guardrailName: 'pii_check',
      tier: 'local',
      key: 'guardrail:tenant-1:project-1:pii_check:abc123',
    };

    const event = traceCacheHit(data);

    assertTraceEvent(event, 'guardrail_cache_hit');
    expect(event.data).toEqual(data);
  });

  // -----------------------------------------------------------------------
  // 10. traceCacheMiss — creates a guardrail_cache_miss event
  // -----------------------------------------------------------------------
  it('should create a guardrail_cache_miss event', () => {
    const data = {
      guardrailName: 'toxicity',
      tier: 'model',
      key: 'guardrail:tenant-1:project-1:toxicity:def456',
    };

    const event = traceCacheMiss(data);

    assertTraceEvent(event, 'guardrail_cache_miss');
    expect(event.data).toEqual(data);
  });

  // -----------------------------------------------------------------------
  // 11. traceProviderError — creates a guardrail_provider_error event
  // -----------------------------------------------------------------------
  it('should create a guardrail_provider_error event', () => {
    const data = {
      provider: 'openai-moderation',
      error: 'Rate limit exceeded',
      guardrailName: 'toxicity',
    };

    const event = traceProviderError(data);

    assertTraceEvent(event, 'guardrail_provider_error');
    expect(event.data).toEqual(data);
  });

  // -----------------------------------------------------------------------
  // 12. traceToolBlocked — creates a guardrail_tool_blocked event
  // -----------------------------------------------------------------------
  it('should create a guardrail_tool_blocked event', () => {
    const data = {
      toolName: 'transfer_funds',
      guardrailName: 'tool_input_validation',
      reason: 'Amount exceeds limit',
      agent: 'banking_agent',
    };

    const event = traceToolBlocked(data);

    assertTraceEvent(event, 'guardrail_tool_blocked');
    expect(event.data).toEqual(data);
  });

  // -----------------------------------------------------------------------
  // 13. traceToolOutputBlocked — creates a guardrail_tool_output_blocked event
  // -----------------------------------------------------------------------
  it('should create a guardrail_tool_output_blocked event', () => {
    const data = {
      toolName: 'search_database',
      guardrailName: 'pii_output_filter',
      reason: 'Tool output contains PII',
      agent: 'search_agent',
    };

    const event = traceToolOutputBlocked(data);

    assertTraceEvent(event, 'guardrail_tool_output_blocked');
    expect(event.data).toEqual(data);
  });

  // -----------------------------------------------------------------------
  // 14. traceHandoffBlocked — creates a guardrail_handoff_blocked event
  // -----------------------------------------------------------------------
  it('should create a guardrail_handoff_blocked event', () => {
    const data = {
      fromAgent: 'triage_agent',
      toAgent: 'billing_agent',
      guardrailName: 'handoff_validation',
      reason: 'Missing required context',
    };

    const event = traceHandoffBlocked(data);

    assertTraceEvent(event, 'guardrail_handoff_blocked');
    expect(event.data).toEqual(data);
  });

  // -----------------------------------------------------------------------
  // 15. tracePipelineError — creates a guardrail_pipeline_error event
  // -----------------------------------------------------------------------
  it('should create a guardrail_pipeline_error event', () => {
    const data = {
      kind: 'input',
      error: 'Pipeline evaluation timed out',
      guardrailName: 'toxicity',
      agent: 'support_agent',
    };

    const event = tracePipelineError(data);

    assertTraceEvent(event, 'guardrail_pipeline_error');
    expect(event.data).toEqual(data);
  });

  // -----------------------------------------------------------------------
  // 16. All events include a numeric timestamp from Date.now()
  // -----------------------------------------------------------------------
  it('should set timestamp from Date.now() for all factory functions', () => {
    const factories = [
      () =>
        traceGuardrailCheck({
          guardrailName: 'x',
          kind: 'input',
          tier: 'local',
          passed: true,
          latencyMs: 1,
        }),
      () =>
        traceGuardrailViolation({
          guardrailName: 'x',
          kind: 'input',
          tier: 'local',
          action: 'block',
          severity: 'critical',
          message: 'test',
        }),
      () => traceGuardrailWarning({ guardrailName: 'x', kind: 'input', message: 'test' }),
      () =>
        traceGuardrailFix({
          guardrailName: 'x',
          kind: 'input',
          strategy: 'redact',
          originalLength: 10,
          modifiedLength: 8,
        }),
      () =>
        traceGuardrailReask({
          guardrailName: 'x',
          kind: 'input',
          reaskCount: 1,
          maxReasks: 3,
        }),
      () =>
        tracePipelineComplete({
          kind: 'input',
          totalChecks: 1,
          passed: 1,
          failed: 0,
          warnings: 0,
          totalLatencyMs: 10,
          costUsd: 0,
          cacheHits: 0,
          cacheMisses: 1,
        }),
      () =>
        traceGuardrailCost({
          tenantId: 't',
          projectId: 'p',
          costUsd: 0,
          currentSpendUsd: 0,
          budgetExceeded: false,
        }),
      () => traceCircuitBreaker({ provider: 'x', state: 'closed' }),
      () => traceCacheHit({ guardrailName: 'x', tier: 'local', key: 'k' }),
      () => traceCacheMiss({ guardrailName: 'x', tier: 'local', key: 'k' }),
      () => traceProviderError({ provider: 'x', error: 'err', guardrailName: 'x' }),
      () => traceToolBlocked({ toolName: 't', guardrailName: 'g', reason: 'r' }),
      () => traceToolOutputBlocked({ toolName: 't', guardrailName: 'g', reason: 'r' }),
      () =>
        traceHandoffBlocked({
          fromAgent: 'a',
          toAgent: 'b',
          guardrailName: 'g',
          reason: 'r',
        }),
      () => tracePipelineError({ kind: 'input', error: 'err', guardrailName: 'x' }),
    ];

    for (const factory of factories) {
      const event = factory();
      expect(typeof event.timestamp).toBe('number');
      expect(event.timestamp).toBe(FIXED_NOW);
    }
  });

  // -----------------------------------------------------------------------
  // 17. All event type strings are unique and match declared type
  // -----------------------------------------------------------------------
  it('should produce unique event type strings for each factory', () => {
    const events: GuardrailTraceEvent[] = [
      traceGuardrailCheck({
        guardrailName: 'x',
        kind: 'input',
        tier: 'local',
        passed: true,
        latencyMs: 1,
      }),
      traceGuardrailViolation({
        guardrailName: 'x',
        kind: 'input',
        tier: 'local',
        action: 'block',
        severity: 'critical',
        message: 'test',
      }),
      traceGuardrailWarning({ guardrailName: 'x', kind: 'input', message: 'test' }),
      traceGuardrailFix({
        guardrailName: 'x',
        kind: 'input',
        strategy: 'redact',
        originalLength: 10,
        modifiedLength: 8,
      }),
      traceGuardrailReask({
        guardrailName: 'x',
        kind: 'input',
        reaskCount: 1,
        maxReasks: 3,
      }),
      tracePipelineComplete({
        kind: 'input',
        totalChecks: 1,
        passed: 1,
        failed: 0,
        warnings: 0,
        totalLatencyMs: 10,
        costUsd: 0,
        cacheHits: 0,
        cacheMisses: 1,
      }),
      traceGuardrailCost({
        tenantId: 't',
        projectId: 'p',
        costUsd: 0,
        currentSpendUsd: 0,
        budgetExceeded: false,
      }),
      traceCircuitBreaker({ provider: 'x', state: 'closed' }),
      traceCacheHit({ guardrailName: 'x', tier: 'local', key: 'k' }),
      traceCacheMiss({ guardrailName: 'x', tier: 'local', key: 'k' }),
      traceProviderError({ provider: 'x', error: 'err', guardrailName: 'x' }),
      traceToolBlocked({ toolName: 't', guardrailName: 'g', reason: 'r' }),
      traceToolOutputBlocked({ toolName: 't', guardrailName: 'g', reason: 'r' }),
      traceHandoffBlocked({
        fromAgent: 'a',
        toAgent: 'b',
        guardrailName: 'g',
        reason: 'r',
      }),
      tracePipelineError({ kind: 'input', error: 'err', guardrailName: 'x' }),
    ];

    const types = events.map((e) => e.type);
    const uniqueTypes = new Set(types);

    // All 15 event types should be unique
    expect(uniqueTypes.size).toBe(15);

    // Verify all types match the union
    const validTypes: GuardrailTraceEventType[] = [
      'guardrail_check',
      'guardrail_violation',
      'guardrail_warning',
      'guardrail_fix',
      'guardrail_reask',
      'guardrail_pipeline_complete',
      'guardrail_cost',
      'guardrail_circuit_breaker',
      'guardrail_cache_hit',
      'guardrail_cache_miss',
      'guardrail_provider_error',
      'guardrail_tool_blocked',
      'guardrail_tool_output_blocked',
      'guardrail_handoff_blocked',
      'guardrail_pipeline_error',
    ];

    for (const type of types) {
      expect(validTypes).toContain(type);
    }
  });
});

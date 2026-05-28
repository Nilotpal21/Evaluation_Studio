/**
 * INT-6 — Telemetry tag clean cutover (FR-4.1)
 *
 * Integration test verifying that guardrail block trace events carry
 * `presetKey: 'sensitive_data_block'` when fired by an SDB-preset rule,
 * and that no PII content leaks into the event payload (T7 threat).
 *
 * Boundary: GuardrailPipeline (Tier2 BuiltinPIIProvider) → violation → trace event shape.
 * Zero vi.mock calls — uses real BuiltinPIIProvider via GuardrailProviderRegistry + PIIRecognizerRegistry.
 *
 * The trace event shape validated here mirrors what reasoning-executor.ts emits
 * for `guardrail_input_blocked` and `guardrail_output_blocked`.
 */

import { describe, test, expect } from 'vitest';
import { GuardrailPipelineImpl } from '@abl/compiler';
import { GuardrailProviderRegistry } from '@abl/compiler/platform/guardrails/provider-registry.js';
import {
  PIIRecognizerRegistry,
  registerBuiltInRecognizers,
} from '@abl/compiler/platform/security/index.js';
import type { Guardrail } from '@abl/compiler';

// ---------------------------------------------------------------------------
// Shared infrastructure
// ---------------------------------------------------------------------------

const piiRegistry = new PIIRecognizerRegistry();
registerBuiltInRecognizers(piiRegistry);

const providerRegistry = new GuardrailProviderRegistry();

const SSN_CONTENT = 'My SSN is 123-45-6789 please protect it';
const SSN_RAW = '123-45-6789';

/**
 * Construct a Guardrail object matching an SDB-preset input rule
 * with `presetKey: 'sensitive_data_block'` and `entities: ['ssn']`.
 */
function makeSdbGuardrail(kind: 'input' | 'output'): Guardrail {
  return {
    name: 'sdb_ssn_blocker',
    description: 'Sensitive Data Block: SSN detection',
    kind,
    priority: 10,
    tier: 'model',
    provider: 'builtin-pii',
    category: 'pii',
    threshold: 0.5,
    action: {
      type: 'block',
      message: 'Sensitive data detected. This content has been blocked.',
    },
    entities: ['ssn'],
    presetKey: 'sensitive_data_block',
  };
}

/**
 * Simulate the trace event shape that reasoning-executor.ts emits
 * for guardrail_input_blocked / guardrail_output_blocked.
 *
 * See: reasoning-executor.ts lines ~1903-1914 and ~3484-3497.
 */
function buildTraceEventData(
  type: 'guardrail_input_blocked' | 'guardrail_output_blocked',
  violation: {
    name: string;
    action: string;
    message: string;
    presetKey?: string;
  },
  agentName: string,
  kind: 'input' | 'output',
): { type: string; data: Record<string, unknown> } {
  return {
    type,
    data: {
      agentName,
      kind,
      guardrailName: violation.name,
      action: violation.action,
      message: violation.message,
      presetKey: violation.presetKey,
      passed: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('INT-6 — Telemetry tag clean cutover (FR-4.1)', () => {
  test('input guardrail_input_blocked carries presetKey: sensitive_data_block', async () => {
    const guardrail = makeSdbGuardrail('input');
    const pipeline = new GuardrailPipelineImpl(providerRegistry, undefined, {
      piiRecognizerRegistry: piiRegistry,
    });

    const result = await pipeline.execute([guardrail], SSN_CONTENT, 'input', {});

    // The pipeline should detect SSN and trigger a violation
    expect(result.passed).toBe(false);
    expect(result.primaryViolation).toBeDefined();
    expect(result.primaryViolation?.presetKey).toBe('sensitive_data_block');
    expect(result.primaryViolation?.name).toBe('sdb_ssn_blocker');

    // Build the trace event shape from the violation (same as reasoning-executor)
    const traceEvent = buildTraceEventData(
      'guardrail_input_blocked',
      {
        name: result.primaryViolation!.name,
        action: result.primaryViolation!.action,
        message: result.primaryViolation!.message,
        presetKey: result.primaryViolation!.presetKey,
      },
      'test_agent',
      'input',
    );

    // Assert: presetKey present in trace event data
    expect(traceEvent.data.presetKey).toBe('sensitive_data_block');

    // Assert: no PII (SSN) leaks into the trace event data fields
    const serialized = JSON.stringify(traceEvent.data);
    expect(serialized).not.toContain(SSN_RAW);
  });

  test('output guardrail_output_blocked carries presetKey: sensitive_data_block', async () => {
    const guardrail = makeSdbGuardrail('output');
    const pipeline = new GuardrailPipelineImpl(providerRegistry, undefined, {
      piiRecognizerRegistry: piiRegistry,
    });

    const result = await pipeline.execute([guardrail], SSN_CONTENT, 'output', {});

    expect(result.passed).toBe(false);
    expect(result.primaryViolation).toBeDefined();
    expect(result.primaryViolation?.presetKey).toBe('sensitive_data_block');

    // Build output-side trace event shape
    const traceEvent = buildTraceEventData(
      'guardrail_output_blocked',
      {
        name: result.primaryViolation!.name,
        action: result.primaryViolation!.action,
        message: result.primaryViolation!.message,
        presetKey: result.primaryViolation!.presetKey,
      },
      'test_agent',
      'output',
    );

    // Assert: presetKey present
    expect(traceEvent.data.presetKey).toBe('sensitive_data_block');

    // Assert: no PII leak
    const serialized = JSON.stringify(traceEvent.data);
    expect(serialized).not.toContain(SSN_RAW);
  });

  test('trace event message field does not contain matched PII content', async () => {
    const guardrail = makeSdbGuardrail('input');
    const pipeline = new GuardrailPipelineImpl(providerRegistry, undefined, {
      piiRecognizerRegistry: piiRegistry,
    });

    const result = await pipeline.execute([guardrail], SSN_CONTENT, 'input', {});

    expect(result.passed).toBe(false);
    const violation = result.primaryViolation;
    expect(violation).toBeDefined();

    // The violation message should be the action message, NOT contain PII
    expect(violation?.message).not.toContain(SSN_RAW);

    // Verify the full data payload is PII-free
    const tracePayload = {
      agentName: 'test_agent',
      kind: 'input',
      guardrailName: violation?.name,
      action: violation?.action,
      message: violation?.message,
      presetKey: violation?.presetKey,
      passed: false,
    };

    const payloadStr = JSON.stringify(tracePayload);
    expect(payloadStr).not.toContain(SSN_RAW);
    expect(payloadStr).not.toContain('123456789'); // undashed SSN variant
  });

  test('no dual-emit: zero events carry legacy ruleCategory:pii tag', async () => {
    // This verifies the clean cutover: the new tag is `presetKey: 'sensitive_data_block'`
    // and no legacy `ruleCategory: 'pii'` tag co-exists at the trace event level.
    const guardrail = makeSdbGuardrail('input');
    const pipeline = new GuardrailPipelineImpl(providerRegistry, undefined, {
      piiRecognizerRegistry: piiRegistry,
    });

    const traceEvents: unknown[] = [];
    const onTraceEvent = (event: unknown): void => {
      traceEvents.push(event);
    };

    await pipeline.execute([guardrail], SSN_CONTENT, 'input', {}, onTraceEvent);

    // The pipeline emits its own trace events (check, violation, pipeline_complete, etc.)
    // None of them should contain `ruleCategory: 'pii'` — that's the legacy tag.
    for (const event of traceEvents) {
      const eventData = (event as { data?: Record<string, unknown> }).data ?? {};
      expect(eventData).not.toHaveProperty('ruleCategory');
    }
  });
});

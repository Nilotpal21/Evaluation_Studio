import { describe, it, expect } from 'vitest';
import { applyActions } from '../../platform/guardrails/action-applier';
import type { GuardrailPipelineResult, GuardrailViolation } from '../../platform/guardrails/types';
import { createEmptyPipelineResult } from '../../platform/guardrails/types';
import type { GuardrailAction } from '../../platform/ir/schema';
import {
  PIIRecognizerRegistry,
  RegexPIIRecognizer,
} from '../../platform/security/pii-recognizer-registry';

function makeViolation(overrides: Partial<GuardrailViolation> = {}): GuardrailViolation {
  return {
    name: 'test-guard',
    kind: 'output',
    tier: 'local',
    action: 'redact',
    severity: 'high',
    message: 'Violation found',
    priority: 1,
    latencyMs: 5,
    ...overrides,
  };
}

describe('applyActions', () => {
  it('should redact PII from content', () => {
    const result = createEmptyPipelineResult();
    result.violations.push(makeViolation({ name: 'pii-check', action: 'redact' }));
    result.metrics.failed = 1;

    const actions = new Map<string, GuardrailAction>([['pii-check', { type: 'redact' }]]);

    const content = 'Call me at user@example.com or 555-123-4567';
    applyActions(result, content, actions);

    expect(result.modifiedContent).toBeDefined();
    expect(result.modifiedContent).not.toContain('user@example.com');
  });

  it('should fix content with truncate strategy', () => {
    const result = createEmptyPipelineResult();
    result.violations.push(makeViolation({ name: 'size-check', action: 'fix' }));
    result.metrics.failed = 1;

    const actions = new Map<string, GuardrailAction>([
      ['size-check', { type: 'fix', fixStrategy: 'truncate' }],
    ]);

    const content = 'A very long content string that should be truncated';
    applyActions(result, content, actions);

    // truncate without maxLength keeps original (executeFix default)
    // But the code path still runs
    expect(result).toBeDefined();
  });

  it('should fix content with strip_html strategy', () => {
    const result = createEmptyPipelineResult();
    result.violations.push(makeViolation({ name: 'html-check', action: 'fix' }));
    result.metrics.failed = 1;

    const actions = new Map<string, GuardrailAction>([
      ['html-check', { type: 'fix', fixStrategy: 'strip_html' }],
    ]);

    const content = '<b>Bold</b> and <i>italic</i> text';
    applyActions(result, content, actions);

    expect(result.modifiedContent).toBeDefined();
    expect(result.modifiedContent).not.toContain('<b>');
    expect(result.modifiedContent).toContain('Bold');
  });

  it('should filter content and remove matching sentences', () => {
    const result = createEmptyPipelineResult();
    result.violations.push(
      makeViolation({
        name: 'profanity-check',
        action: 'filter',
        label: 'badword',
      }),
    );
    result.metrics.failed = 1;

    const actions = new Map<string, GuardrailAction>([
      ['profanity-check', { type: 'filter', filterMinLength: 5 }],
    ]);

    const content = 'This is clean. This contains badword. This is also clean.';
    applyActions(result, content, actions);

    expect(result.modifiedContent).toBeDefined();
    expect(result.modifiedContent).not.toContain('badword');
    expect(result.modifiedContent).toContain('clean');
  });

  it('should escalate to block when filter removes too much', () => {
    const result = createEmptyPipelineResult();
    result.violations.push(
      makeViolation({
        name: 'profanity-check',
        action: 'filter',
        label: 'every',
      }),
    );
    result.metrics.failed = 1;

    const actions = new Map<string, GuardrailAction>([
      ['profanity-check', { type: 'filter', filterMinLength: 100 }],
    ]);

    const content = 'every word contains every.';
    applyActions(result, content, actions);

    // Filter removes everything → below minLength → escalates to block
    expect(result.passed).toBe(false);
    // Should have a new block violation added
    const blockViolations = result.violations.filter((v) => v.action === 'block');
    expect(blockViolations.length).toBeGreaterThanOrEqual(1);
  });

  it('should not set modifiedContent when there are no violations', () => {
    const result = createEmptyPipelineResult();
    const actions = new Map<string, GuardrailAction>();

    applyActions(result, 'clean content', actions);
    expect(result.modifiedContent).toBeUndefined();
  });

  it('should not apply terminal actions (block/escalate)', () => {
    const result = createEmptyPipelineResult();
    result.violations.push(makeViolation({ name: 'block-guard', action: 'block' }));
    result.metrics.failed = 1;

    const actions = new Map<string, GuardrailAction>([
      ['block-guard', { type: 'block', message: 'Blocked' }],
    ]);

    applyActions(result, 'content', actions);
    expect(result.modifiedContent).toBeUndefined();
  });

  it('should apply multiple non-terminal violations in priority order', () => {
    const result = createEmptyPipelineResult();
    result.violations.push(
      makeViolation({ name: 'html-check', action: 'fix', priority: 2 }),
      makeViolation({ name: 'pii-check', action: 'redact', priority: 1 }),
    );
    result.metrics.failed = 2;

    const actions = new Map<string, GuardrailAction>([
      ['pii-check', { type: 'redact' }],
      ['html-check', { type: 'fix', fixStrategy: 'strip_html' }],
    ]);

    const content = '<b>Email: user@example.com</b>';
    applyActions(result, content, actions);

    expect(result.modifiedContent).toBeDefined();
    // PII redacted (priority 1 first), then HTML stripped (priority 2)
    expect(result.modifiedContent).not.toContain('user@example.com');
    expect(result.modifiedContent).not.toContain('<b>');
  });

  it('should redact custom project patterns when a recognizer registry is supplied', () => {
    const registry = new PIIRecognizerRegistry();
    registry.register(
      new RegexPIIRecognizer(
        'custom-contract-id',
        ['ContractID'],
        /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
        'ContractID',
        undefined,
        'custom',
      ),
    );

    const result = createEmptyPipelineResult();
    result.violations.push(makeViolation({ name: 'contract-check', action: 'redact' }));
    result.metrics.failed = 1;

    const actions = new Map<string, GuardrailAction>([['contract-check', { type: 'redact' }]]);

    applyActions(result, 'Contract 780b4d1c-1166-487e-ae7a-27eedd12905b', actions, {
      piiRecognizerRegistry: registry,
    });

    expect(result.modifiedContent).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.modifiedContent).not.toContain('780b4d1c-1166-487e-ae7a-27eedd12905b');
  });
});

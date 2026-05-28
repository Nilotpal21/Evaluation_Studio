/**
 * Workflow Step Normalization Tests
 *
 * Tests the normalize/denormalize round-trip that converts between
 * DB shape (flat fields) and UI shape (nested config object).
 *
 * This was the root cause of B8: Mongoose stripped the nested `config`
 * object because it wasn't in the schema. denormalizeStep() flattens
 * config back to top-level fields before saving.
 */

import { describe, test, expect } from 'vitest';
import { denormalizeStep, normalizeStep } from '../hooks/useWorkflowDetail';
import type { WorkflowStep } from '../api/workflows';

// =============================================================================
// normalizeStep
// =============================================================================

describe('normalizeStep', () => {
  describe('when step already has a config object (UI shape)', () => {
    test('passes through with id, name, type, config, position', () => {
      const raw = {
        id: 'step-1',
        name: 'Send Email',
        type: 'connector_action',
        config: { connector: 'gmail', action: 'send' },
        position: 0,
      };

      const result = normalizeStep(raw, 0);

      expect(result).toEqual({
        id: 'step-1',
        name: 'Send Email',
        type: 'connector_action',
        config: { connector: 'gmail', action: 'send' },
        position: 0,
      });
    });

    test('stringifies params object inside config', () => {
      const raw = {
        id: 'step-1',
        name: 'Call API',
        type: 'http',
        config: {
          url: 'https://api.example.com',
          params: { key: 'value', nested: { a: 1 } },
        },
        position: 0,
      };

      const result = normalizeStep(raw, 0);

      expect(typeof result.config.params).toBe('string');
      expect(JSON.parse(result.config.params as string)).toEqual({
        key: 'value',
        nested: { a: 1 },
      });
    });

    test('does not stringify params if already a string', () => {
      const raw = {
        id: 'step-1',
        name: 'Test',
        type: 'http',
        config: { params: '{"already": "string"}' },
        position: 0,
      };

      const result = normalizeStep(raw, 0);

      expect(result.config.params).toBe('{"already": "string"}');
    });

    test('does not mutate the original config object', () => {
      const originalConfig = { connector: 'salesforce', params: { key: 'val' } };
      const raw = {
        id: 'step-1',
        name: 'Test',
        type: 'connector_action',
        config: originalConfig,
        position: 0,
      };

      normalizeStep(raw, 0);

      // Original should still have params as object
      expect(typeof originalConfig.params).toBe('object');
    });
  });

  describe('when step is in DB shape (flat fields)', () => {
    test('extracts non-top-level fields into config', () => {
      const raw = {
        id: 'step-1',
        name: 'HTTP Call',
        type: 'http',
        position: 2,
        method: 'POST',
        url: 'https://api.example.com/data',
        headers: { Authorization: 'Bearer token' },
      };

      const result = normalizeStep(raw, 2);

      expect(result).toEqual({
        id: 'step-1',
        name: 'HTTP Call',
        type: 'http',
        config: {
          method: 'POST',
          url: 'https://api.example.com/data',
          headers: { Authorization: 'Bearer token' },
        },
        position: 2,
      });
    });

    test('stringifies params object in DB shape', () => {
      const raw = {
        id: 'step-1',
        type: 'connector_action',
        connector: 'salesforce',
        action: 'create_lead',
        params: { firstName: 'John', lastName: 'Doe' },
      };

      const result = normalizeStep(raw, 0);

      expect(result.config.connector).toBe('salesforce');
      expect(result.config.action).toBe('create_lead');
      expect(typeof result.config.params).toBe('string');
      expect(JSON.parse(result.config.params as string)).toEqual({
        firstName: 'John',
        lastName: 'Doe',
      });
    });

    test('skips undefined and null values in DB shape', () => {
      const raw = {
        id: 'step-1',
        type: 'http',
        url: 'https://example.com',
        headers: undefined,
        body: null,
        method: 'GET',
      };

      const result = normalizeStep(raw, 0);

      expect(result.config).toEqual({
        url: 'https://example.com',
        method: 'GET',
      });
      expect('headers' in result.config).toBe(false);
      expect('body' in result.config).toBe(false);
    });
  });

  describe('defaults', () => {
    test('generates step ID from index when missing', () => {
      const raw = { type: 'delay' };
      const result = normalizeStep(raw, 3);

      expect(result.id).toBe('step-3');
    });

    test('defaults name to empty string when missing', () => {
      const raw = { type: 'delay' };
      const result = normalizeStep(raw, 0);

      expect(result.name).toBe('');
    });

    test('defaults type to connector_action when missing', () => {
      const raw = { id: 'step-1' };
      const result = normalizeStep(raw, 0);

      expect(result.type).toBe('connector_action');
    });

    test('defaults position to index when missing', () => {
      const raw = { id: 'step-1', type: 'http' };
      const result = normalizeStep(raw, 5);

      expect(result.position).toBe(5);
    });
  });
});

// =============================================================================
// denormalizeStep
// =============================================================================

describe('denormalizeStep', () => {
  test('flattens config fields to top level', () => {
    const step: WorkflowStep = {
      id: 'step-1',
      name: 'HTTP Call',
      type: 'http',
      config: {
        method: 'POST',
        url: 'https://api.example.com',
        headers: { 'Content-Type': 'application/json' },
      },
      position: 0,
    };

    const result = denormalizeStep(step);

    expect(result).toEqual({
      id: 'step-1',
      name: 'HTTP Call',
      type: 'http',
      position: 0,
      method: 'POST',
      url: 'https://api.example.com',
      headers: { 'Content-Type': 'application/json' },
    });
  });

  test('preserves id, name, type, position without config wrapper', () => {
    const step: WorkflowStep = {
      id: 'step-abc',
      name: 'My Step',
      type: 'connector_action',
      config: { connector: 'hubspot' },
      position: 3,
    };

    const result = denormalizeStep(step);

    expect(result.id).toBe('step-abc');
    expect(result.name).toBe('My Step');
    expect(result.type).toBe('connector_action');
    expect(result.position).toBe(3);
    expect(result.connector).toBe('hubspot');
    expect(result.config).toBeUndefined();
  });

  test('handles empty config', () => {
    const step: WorkflowStep = {
      id: 'step-1',
      name: 'Empty',
      type: 'delay',
      config: {},
      position: 0,
    };

    const result = denormalizeStep(step);

    expect(result).toEqual({
      id: 'step-1',
      name: 'Empty',
      type: 'delay',
      position: 0,
    });
  });

  test('handles connector_action with all fields', () => {
    const step: WorkflowStep = {
      id: 'step-1',
      name: 'Salesforce Create',
      type: 'connector_action',
      config: {
        connector: 'salesforce',
        action: 'create_lead',
        connectionId: 'conn-123',
        params: '{"firstName":"John"}',
      },
      position: 1,
    };

    const result = denormalizeStep(step);

    expect(result.connector).toBe('salesforce');
    expect(result.action).toBe('create_lead');
    expect(result.connectionId).toBe('conn-123');
    expect(result.params).toBe('{"firstName":"John"}');
  });
});

// =============================================================================
// Round-trip: normalize → denormalize
// =============================================================================

describe('normalize ↔ denormalize round-trip', () => {
  test('DB shape → normalize → denormalize preserves all fields', () => {
    const dbStep = {
      id: 'step-1',
      name: 'Send Email',
      type: 'connector_action',
      position: 0,
      connector: 'gmail',
      action: 'send_email',
      connectionId: 'conn-abc',
    };

    const normalized = normalizeStep(dbStep, 0);
    const denormalized = denormalizeStep(normalized);

    expect(denormalized).toEqual({
      id: 'step-1',
      name: 'Send Email',
      type: 'connector_action',
      position: 0,
      connector: 'gmail',
      action: 'send_email',
      connectionId: 'conn-abc',
    });
  });

  test('UI shape → denormalize → normalize preserves all fields', () => {
    const uiStep: WorkflowStep = {
      id: 'step-2',
      name: 'HTTP Request',
      type: 'http',
      config: {
        method: 'GET',
        url: 'https://example.com',
        timeout: 5000,
      },
      position: 1,
    };

    const denormalized = denormalizeStep(uiStep);
    const renormalized = normalizeStep(denormalized as Record<string, unknown>, 1);

    expect(renormalized).toEqual({
      id: 'step-2',
      name: 'HTTP Request',
      type: 'http',
      config: {
        method: 'GET',
        url: 'https://example.com',
        timeout: 5000,
      },
      position: 1,
    });
  });

  test('round-trip preserves condition step with branches', () => {
    const dbStep = {
      id: 'step-cond',
      name: 'Check Status',
      type: 'condition',
      position: 2,
      expression: '{{ steps.step-1.output.status }} === "active"',
      thenSteps: [{ id: 'then-1', type: 'delay', duration: '5m' }],
      elseSteps: [{ id: 'else-1', type: 'http', url: 'https://fallback.com' }],
    };

    const normalized = normalizeStep(dbStep, 2);
    expect(normalized.config.expression).toBe('{{ steps.step-1.output.status }} === "active"');
    expect(normalized.config.thenSteps).toEqual([{ id: 'then-1', type: 'delay', duration: '5m' }]);

    const denormalized = denormalizeStep(normalized);
    expect(denormalized.expression).toBe(dbStep.expression);
    expect(denormalized.thenSteps).toEqual(dbStep.thenSteps);
    expect(denormalized.elseSteps).toEqual(dbStep.elseSteps);
  });

  test('round-trip preserves approval step fields', () => {
    const dbStep = {
      id: 'step-approve',
      name: 'Manager Approval',
      type: 'approval',
      position: 3,
      assignee: 'manager@example.com',
      assigneeId: 'user-123',
      title: 'Approve refund over $500',
      timeoutMs: 86400000,
      timeoutAction: 'reject',
    };

    const normalized = normalizeStep(dbStep, 3);
    const denormalized = denormalizeStep(normalized);

    expect(denormalized).toEqual(dbStep);
  });

  test('round-trip preserves parallel step with branches', () => {
    const dbStep = {
      id: 'step-parallel',
      name: 'Parallel Fetch',
      type: 'parallel',
      position: 0,
      branches: [
        { id: 'b1', steps: [{ id: 's1', type: 'http', url: 'https://a.com' }] },
        { id: 'b2', steps: [{ id: 's2', type: 'http', url: 'https://b.com' }] },
      ],
      failureStrategy: 'fail_fast',
      maxConcurrency: 2,
    };

    const normalized = normalizeStep(dbStep, 0);
    const denormalized = denormalizeStep(normalized);

    expect(denormalized).toEqual(dbStep);
  });
});

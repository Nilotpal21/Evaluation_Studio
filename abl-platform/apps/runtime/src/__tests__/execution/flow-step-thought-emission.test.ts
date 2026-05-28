/**
 * Flow Step Thought Emission Tests
 *
 * Tests for ST-3.4: Scripted agent thoughts (step_thought trace events)
 *
 * - 3-U25: RESPOND step emits step_thought with summary "Sending response"
 * - 3-U26: COLLECT/GATHER step emits step_thought listing field names
 * - 3-U27: SET step emits step_thought listing variable names
 * - 3-U28: CALL step emits step_thought with tool name
 * - 3-U29: CHECK step emits step_thought with condition preview
 * - 3-U30: step_thought NOT emitted when show_step_thoughts: false
 * - 3-U31: buildStepSummary returns generic summary for unknown step types
 */

import { describe, test, expect } from 'vitest';
import { buildStepSummary } from '../../services/execution/step-thought.js';

describe('buildStepSummary', () => {
  test('3-U25: RESPOND step returns "Sending response" (no content leak)', () => {
    const summary = buildStepSummary({
      name: 'greet_user',
      respond: 'Hello {{name}}, welcome!',
    });
    expect(summary).toBe('Sending response');
    // Must NOT contain the template content
    expect(summary).not.toContain('Hello');
    expect(summary).not.toContain('{{name}}');
  });

  test('3-U26: GATHER step lists field names', () => {
    const summary = buildStepSummary({
      name: 'collect_info',
      gather: {
        fields: [
          { name: 'email', type: 'string' },
          { name: 'phone', type: 'string' },
        ],
      },
    });
    expect(summary).toContain('email');
    expect(summary).toContain('phone');
    expect(summary).toMatch(/^Collecting:/);
  });

  test('3-U27: SET step lists variable names', () => {
    const summary = buildStepSummary({
      name: 'compute',
      set: [
        { variable: 'total', expression: 'a + b' },
        { variable: 'status', expression: '"done"' },
      ],
    });
    expect(summary).toContain('total');
    expect(summary).toContain('status');
    expect(summary).toMatch(/^Setting/);
  });

  test('3-U28: CALL step shows tool name', () => {
    const summary = buildStepSummary({
      name: 'lookup',
      call: 'search_database',
    });
    expect(summary).toContain('search_database');
    expect(summary).toMatch(/^Calling/);
  });

  test('3-U29: CHECK step shows condition preview', () => {
    const summary = buildStepSummary({
      name: 'validate',
      check: 'user.authenticated == true',
    });
    expect(summary).toContain('user.authenticated == true');
    expect(summary).toMatch(/^Evaluating:/);
  });

  test('3-U31: Unknown step type returns generic summary with step name', () => {
    const summary = buildStepSummary({
      name: 'mystery_step',
    });
    expect(summary).toContain('mystery_step');
    expect(summary).toMatch(/^Processing/);
  });

  test('CLEAR step lists variable names', () => {
    const summary = buildStepSummary({
      name: 'cleanup',
      clear: ['temp_a', 'temp_b'],
    });
    expect(summary).toContain('temp_a');
    expect(summary).toContain('temp_b');
    expect(summary).toMatch(/^Clearing:/);
  });

  test('TRANSFORM step returns generic summary', () => {
    const summary = buildStepSummary({
      name: 'filter',
      transform: { pipeline: [] },
    });
    expect(summary).toMatch(/^Transforming/);
  });

  test('CALL step with function syntax extracts tool name', () => {
    const summary = buildStepSummary({
      name: 'lookup',
      call: 'search_database(query, limit)',
    });
    expect(summary).toContain('search_database');
  });

  test('GATHER with no fields returns generic collecting summary', () => {
    const summary = buildStepSummary({
      name: 'collect_info',
      gather: { fields: [] },
    });
    expect(summary).toMatch(/^Collecting/);
  });
});

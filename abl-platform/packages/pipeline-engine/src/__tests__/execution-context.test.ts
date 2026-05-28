import { describe, test, expect } from 'vitest';
import {
  deriveContextKey,
  resolveContextInput,
  buildExecutionContext,
} from '../pipeline/execution-context.js';
import type { PipelineStepContext, StepOutput } from '../pipeline/types.js';

describe('deriveContextKey', () => {
  test('strips read- prefix', () => {
    expect(deriveContextKey('read-conversation')).toBe('conversation');
  });

  test('strips compute- prefix', () => {
    expect(deriveContextKey('compute-sentiment')).toBe('sentiment');
  });

  test('converts kebab-case to camelCase', () => {
    expect(deriveContextKey('read-message-window')).toBe('messageWindow');
    expect(deriveContextKey('conversation-analyzer')).toBe(null);
    expect(deriveContextKey('compute-tool-effectiveness')).toBe('toolEffectiveness');
    expect(deriveContextKey('compute-predictive-features')).toBe('predictiveFeatures');
  });

  test('returns null for non-producer types', () => {
    expect(deriveContextKey('store-results')).toBeNull();
    expect(deriveContextKey('node-group')).toBeNull();
    expect(deriveContextKey('send-notification')).toBeNull();
    expect(deriveContextKey('wait-for-event')).toBeNull();
    expect(deriveContextKey('delay')).toBeNull();
  });
});

describe('resolveContextInput', () => {
  const makeInput = (overrides: Partial<PipelineStepContext> = {}): PipelineStepContext => ({
    tenantId: 't-1',
    config: {},
    previousSteps: {},
    pipelineInput: {},
    ...overrides,
  });

  test('reads from executionContext when available', () => {
    const input = makeInput({
      executionContext: {
        conversation: { messages: [{ role: 'user', content: 'hello' }] },
      },
    });

    const result = resolveContextInput(input, 'conversation');
    expect(result).toEqual({ messages: [{ role: 'user', content: 'hello' }] });
  });

  test('falls back to previousSteps with sourceStep config for linear pipelines', () => {
    const input = makeInput({
      config: { sourceStep: 'read-conv' },
      previousSteps: {
        'read-conv': {
          status: 'success',
          data: { messages: [{ role: 'user', content: 'hi' }] },
        },
      },
    });

    const result = resolveContextInput(input, 'conversation');
    expect(result).toEqual({ messages: [{ role: 'user', content: 'hi' }] });
  });

  test('falls back to default read-conversation step when no sourceStep config', () => {
    const input = makeInput({
      previousSteps: {
        'read-conversation': {
          status: 'success',
          data: { messages: [{ role: 'user', content: 'default' }] },
        },
      },
    });

    const result = resolveContextInput(input, 'conversation');
    expect(result).toEqual({ messages: [{ role: 'user', content: 'default' }] });
  });

  test('returns undefined when nothing available', () => {
    const input = makeInput();
    expect(resolveContextInput(input, 'conversation')).toBeUndefined();
  });

  test('returns undefined when previousStep has failed status', () => {
    const input = makeInput({
      previousSteps: {
        'read-conversation': {
          status: 'fail',
          data: { error: 'failed' },
        },
      },
    });

    expect(resolveContextInput(input, 'conversation')).toBeUndefined();
  });

  test('reads from executionContext even when value is empty object', () => {
    const input = makeInput({
      executionContext: { conversation: {} },
      previousSteps: {
        'read-conversation': {
          status: 'success',
          data: { messages: [{ role: 'user', content: 'should not reach' }] },
        },
      },
    });
    const result = resolveContextInput(input, 'conversation');
    expect(result).toEqual({});
  });

  test('executionContext takes priority over previousSteps', () => {
    const input = makeInput({
      executionContext: {
        conversation: { messages: [{ role: 'user', content: 'from context' }] },
      },
      config: { sourceStep: 'read-conv' },
      previousSteps: {
        'read-conv': {
          status: 'success',
          data: { messages: [{ role: 'user', content: 'from previous' }] },
        },
      },
    });

    const result = resolveContextInput(input, 'conversation');
    expect(result).toEqual({ messages: [{ role: 'user', content: 'from context' }] });
  });
});

describe('buildExecutionContext', () => {
  test('writes result.data under contextKey', () => {
    const context: Record<string, Record<string, any>> = {};
    const result: StepOutput = {
      status: 'success',
      data: { messages: [{ role: 'user', content: 'hello' }], sessionId: 'sess-1' },
    };

    buildExecutionContext(context, 'read-conversation', result, 'conversation');
    expect(context.conversation).toEqual(result.data);
  });

  test('skips when result status is not success', () => {
    const context: Record<string, Record<string, any>> = {};
    const result: StepOutput = { status: 'fail', data: { error: 'oops' } };

    buildExecutionContext(context, 'compute-sentiment', result, 'sentiment');
    expect(context.sentiment).toBeUndefined();
  });

  test('skips when contextKey is null', () => {
    const context: Record<string, Record<string, any>> = {};
    const result: StepOutput = { status: 'success', data: { stored: true } };

    buildExecutionContext(context, 'store-results', result, null);
    expect(Object.keys(context)).toHaveLength(0);
  });

  test('uses explicit contextKey over derived', () => {
    const context: Record<string, Record<string, any>> = {};
    const result: StepOutput = { status: 'success', data: { output: 'text' } };

    buildExecutionContext(context, 'call-llm', result, 'llmResult');
    expect(context.llmResult).toEqual(result.data);
    expect(context.llm).toBeUndefined();
  });

  test('extracts node-group child outputs into context', () => {
    const context: Record<string, Record<string, any>> = {};
    const groupResult: StepOutput = {
      status: 'success',
      data: {
        children: {
          'sentiment-node': { status: 'success', data: { score: 0.8 } },
          'intent-node': { status: 'success', data: { intent: 'billing' } },
        },
      },
    };
    const children = [
      { id: 'sentiment-node', type: 'compute-sentiment', config: {} },
      { id: 'intent-node', type: 'compute-intent', config: {} },
    ];

    buildExecutionContext(context, 'node-group', groupResult, null, children);
    expect(context.sentiment).toEqual({ score: 0.8 });
    expect(context.intent).toEqual({ intent: 'billing' });
  });

  test('skips failed children in node-group', () => {
    const context: Record<string, Record<string, any>> = {};
    const groupResult: StepOutput = {
      status: 'success',
      data: {
        children: {
          'sentiment-node': { status: 'success', data: { score: 0.8 } },
          'intent-node': { status: 'fail', data: { error: 'timeout' } },
        },
      },
    };
    const children = [
      { id: 'sentiment-node', type: 'compute-sentiment', config: {} },
      { id: 'intent-node', type: 'compute-intent', config: {} },
    ];

    buildExecutionContext(context, 'node-group', groupResult, null, children);
    expect(context.sentiment).toEqual({ score: 0.8 });
    expect(context.intent).toBeUndefined();
  });
});

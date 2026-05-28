import { describe, test, expect } from 'vitest';
import { validatePipeline } from '../pipeline/validation.js';
import { evaluateExpression } from '../pipeline/expression-evaluator.js';
import {
  ACTIVITY_TYPES,
  listActivityTypes,
  getActivityMetadata,
} from '../pipeline/activity-metadata.js';
import type { PipelineDefinition, StepOutput } from '../pipeline/types.js';

// ---------------------------------------------------------------------------
// Full pipeline definition from the design doc "Custom Safety Evaluation" example
// ---------------------------------------------------------------------------

const safetyPipeline: PipelineDefinition = {
  _id: 'pip-safety-1',
  tenantId: 'tenant-1',
  name: 'Custom Safety Evaluation',
  description: 'Evaluate safety and quality metrics in parallel, check policy, alert on failure',
  version: 1,
  status: 'active',
  trigger: {
    type: 'kafka',
    kafkaTopic: 'abl.session.ended',
    eventFilter: { field: 'projectId', equals: 'proj-1' },
  },
  inputSchema: {
    required: ['tenantId', 'projectId', 'sessionId'],
    properties: {
      tenantId: { type: 'string' },
      projectId: { type: 'string' },
      sessionId: { type: 'string' },
    },
  },
  steps: [
    {
      id: 'eval-safety',
      name: 'Evaluate Safety Metrics',
      type: 'evaluate-metrics',
      config: { metrics: ['toxicity', 'bias', 'pii-detection'] },
    },
    {
      id: 'eval-quality',
      name: 'Evaluate Quality Metrics',
      type: 'evaluate-metrics',
      parallel: 'eval-group',
      config: { metrics: ['coherence', 'relevance'] },
    },
    {
      id: 'eval-cost',
      name: 'Evaluate Cost Metrics',
      type: 'evaluate-metrics',
      parallel: 'eval-group',
      config: { metrics: ['token-cost', 'latency'] },
    },
    {
      id: 'check-policy',
      name: 'Run Safety Policy',
      type: 'evaluate-policy',
      config: { policyId: 'pol-safety-001' },
    },
    {
      id: 'alert',
      name: 'Send Slack Alert',
      type: 'send-notification',
      condition: { expression: "steps.check-policy.output.status == 'FAIL'" },
      config: {
        channel: 'slack',
        webhookUrl: 'https://hooks.slack.com/services/T00/B00/xxx',
      },
    },
    {
      id: 'store',
      name: 'Store All Results',
      type: 'store-results',
      config: { destination: 'clickhouse', table: 'trace_metrics' },
    },
  ],
  createdBy: 'user-1',
  createdAt: new Date(),
  updatedAt: new Date(),
};

// ---------------------------------------------------------------------------
// Pipeline Integration Tests
// ---------------------------------------------------------------------------

describe('Pipeline Integration', () => {
  test('full pipeline definition validates without errors', () => {
    const errors = validatePipeline(safetyPipeline);
    expect(errors).toEqual([]);
  });

  test('condition evaluates to true when policy fails', () => {
    const stepOutputs: Record<string, StepOutput> = {
      'eval-safety': {
        status: 'success',
        data: {
          scores: { toxicity: 0.9, bias: 0.3, 'pii-detection': 0.1 },
        },
      },
      'eval-quality': {
        status: 'success',
        data: { scores: { coherence: 0.8, relevance: 0.7 } },
      },
      'eval-cost': {
        status: 'success',
        data: { scores: { 'token-cost': 0.5, latency: 0.3 } },
      },
      'check-policy': {
        status: 'success',
        data: { status: 'FAIL', summary: { passed: 2, failed: 1 } },
      },
    };

    const shouldAlert = evaluateExpression(
      "steps.check-policy.output.status == 'FAIL'",
      stepOutputs,
    );
    expect(shouldAlert).toBe(true);
  });

  test('condition evaluates to false when policy passes', () => {
    const stepOutputs: Record<string, StepOutput> = {
      'check-policy': {
        status: 'success',
        data: { status: 'PASS', summary: { passed: 3, failed: 0 } },
      },
    };

    const shouldAlert = evaluateExpression(
      "steps.check-policy.output.status == 'FAIL'",
      stepOutputs,
    );
    expect(shouldAlert).toBe(false);
  });

  test('pipelineShouldStop flag is detectable in step output', () => {
    const output: StepOutput = {
      status: 'success',
      data: { pipelineShouldStop: true, reason: 'Critical failure detected' },
    };
    expect(output.data.pipelineShouldStop).toBe(true);
  });

  test('pipelineShouldStop is absent when step succeeds normally', () => {
    const output: StepOutput = {
      status: 'success',
      data: { scores: { toxicity: 0.1 } },
    };
    expect(output.data.pipelineShouldStop).toBeUndefined();
  });

  test('complex condition with numeric comparison', () => {
    const stepOutputs: Record<string, StepOutput> = {
      'eval-safety': {
        status: 'success',
        data: { scores: { toxicity: 0.9, bias: 0.3 } },
      },
      'check-policy': {
        status: 'success',
        data: { status: 'FAIL' },
      },
    };

    // Toxicity > threshold AND policy failed
    const result = evaluateExpression(
      "steps.eval-safety.output.scores.toxicity > 0.7 && steps.check-policy.output.status == 'FAIL'",
      stepOutputs,
    );
    expect(result).toBe(true);
  });

  test('parallel steps do not affect condition evaluation order', () => {
    // eval-quality and eval-cost are parallel — their outputs should both be
    // available for conditions on later steps
    const stepOutputs: Record<string, StepOutput> = {
      'eval-quality': {
        status: 'success',
        data: { scores: { coherence: 0.8 } },
      },
      'eval-cost': {
        status: 'success',
        data: { scores: { latency: 0.3 } },
      },
    };

    expect(
      evaluateExpression('steps.eval-quality.output.scores.coherence > 0.5', stepOutputs),
    ).toBe(true);
    expect(evaluateExpression('steps.eval-cost.output.scores.latency < 1.0', stepOutputs)).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Activity Metadata Tests
// ---------------------------------------------------------------------------

describe('Activity Metadata', () => {
  const expectedTypes = [
    'aggregate-eval-run',
    'llm-evaluate',
    'compute-goal-completion',
    'compute-intent',
    'evaluate-resolution',
    'conversation-analyzer',
    'compute-mentions',
    'compute-predictive-features',
    'compute-quality',
    'compute-sentiment',
    'compute-statistical',
    'compute-tool-effectiveness',
    'compute-toxicity',
    'evaluate-metrics',
    'evaluate-policy',
    'execute-agent-turn',
    'http-request',
    'inspect-output',
    'judge-conversation',
    'read-conversation',
    'read-message-window',
    'run-eval-conversation',
    'run-legacy-workflow',
    'send-notification',
    'simulate-persona',
    'store-insight',
    'store-results',
    'transform',
    // Extended node types
    'sub-pipeline',
    'db-query',
    'filter',
    'aggregate',
    'send-email',
    'send-slack',
    'publish-kafka',
    // Control-flow types (handled inline by ActivityRouter)
    'node-group',
    'wait-for-event',
    'delay',
  ];

  test('all 38 activity types are registered', () => {
    expect(Object.keys(ACTIVITY_TYPES).sort()).toEqual(expectedTypes.sort());
  });

  test('listActivityTypes returns all types', () => {
    expect(listActivityTypes()).toHaveLength(38);
  });

  test.each(expectedTypes)('activity type "%s" has required metadata fields', (type) => {
    const meta = getActivityMetadata(type);
    expect(meta).toBeDefined();
    expect(meta!.name).toBeTruthy();
    expect(meta!.description).toBeTruthy();
    expect(meta!.configSchema).toBeDefined();
    expect(meta!.configSchema.required).toBeInstanceOf(Array);
    expect(meta!.defaultTimeout).toBeGreaterThan(0);
    expect(typeof meta!.defaultRetries).toBe('number');
  });

  test('unknown type returns undefined', () => {
    expect(getActivityMetadata('nonexistent')).toBeUndefined();
  });
});

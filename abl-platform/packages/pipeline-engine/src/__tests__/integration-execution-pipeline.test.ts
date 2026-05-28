/**
 * Integration test: Full Execution Pipeline
 *
 * Bridges the graph walker with real activity service handlers and execution
 * context propagation — the full data flow that runGraphMode orchestrates in
 * production, minus Restate durable state.
 *
 * Uses:
 *   - walkGraph()             for graph traversal + transition resolution
 *   - buildExecutionContext()  for inter-node data propagation
 *   - Real EvaluateMetrics, EvaluatePolicy, Transform service handlers
 *   - Minimal Restate ctx (ctx.run passthrough — same as integration-toxicity-pipeline)
 */
import { describe, test, expect } from 'vitest';
import { walkGraph } from '../pipeline/graph-walker.js';
import { buildExecutionContext } from '../pipeline/execution-context.js';
import { evaluateMetricsService } from '../pipeline/services/evaluate-metrics.service.js';
import { evaluatePolicyService } from '../pipeline/services/evaluate-policy.service.js';
import { transformService } from '../pipeline/services/transform.service.js';
import type { PipelineNode, PipelineStepContext, StepOutput } from '../pipeline/types.js';

// ---------------------------------------------------------------------------
// Minimal Restate context — ctx.run() just calls the function directly.
// In production Restate adds journal durability; the business logic is identical.
// ---------------------------------------------------------------------------
function createRestateCtx(): any {
  return {
    run: async (_label: string, fn: () => any) => fn(),
    console: { log: (..._args: any[]) => {} },
  };
}

// Extract raw handler from Restate service definition
function handler(svc: any): (ctx: any, input: PipelineStepContext) => Promise<StepOutput> {
  return svc.service.execute;
}

// Real handlers, keyed by node type
const REAL_HANDLERS: Record<string, (ctx: any, input: PipelineStepContext) => Promise<StepOutput>> =
  {
    'evaluate-metrics': handler(evaluateMetricsService),
    'evaluate-policy': handler(evaluatePolicyService),
    transform: handler(transformService),
  };

// ---------------------------------------------------------------------------
// Test helper: creates an executor that dispatches to real handlers for known
// types and returns mock data for unknown types. Accumulates nodeOutputs and
// executionContext exactly as runGraphMode does in production.
// ---------------------------------------------------------------------------
function createRealExecutor(pipelineInput: Record<string, any>) {
  const nodeOutputs: Record<string, StepOutput> = {};
  const executionContext: Record<string, Record<string, any>> = {};
  const ctx = createRestateCtx();

  const executor = async (
    nodeId: string,
    nodeType: string,
    config: Record<string, any>,
  ): Promise<StepOutput> => {
    const handlerFn = REAL_HANDLERS[nodeType];
    let result: StepOutput;

    if (handlerFn) {
      // Build PipelineStepContext — mirrors what ActivityRouter receives
      const stepContext: PipelineStepContext = {
        tenantId: pipelineInput.tenantId,
        projectId: pipelineInput.projectId,
        sessionId: pipelineInput.sessionId,
        config,
        previousSteps: { ...nodeOutputs },
        pipelineInput,
        executionContext: { ...executionContext },
      };
      result = await handlerFn(ctx, stepContext);
    } else {
      // Mock node: return config as data (same pattern as integration-graph-pipeline tests)
      result = { status: 'success', data: { ...config, nodeId } };
    }

    // Accumulate state — mirrors runGraphMode
    nodeOutputs[nodeId] = result;
    buildExecutionContext(executionContext, nodeType, result, undefined);

    return result;
  };

  return { executor, nodeOutputs, executionContext };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const PIPELINE_INPUT = {
  tenantId: 'test-tenant',
  projectId: 'test-project',
  sessionId: 'test-session-exec',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Integration: Execution Pipeline (walkGraph → buildExecutionContext → real handlers)', () => {
  test('linear: scorer → evaluate-metrics → evaluate-policy (data flows through real handlers)', async () => {
    // Graph: mock scorer produces toxicity data → real evaluateMetrics → real evaluatePolicy
    const nodes: PipelineNode[] = [
      {
        id: 'scorer',
        type: 'mock-scorer',
        config: {
          messages: {
            msg1: { text: 'Hello, can you help?', toxicity: 0.05 },
            msg2: { text: 'You are terrible!', toxicity: 0.92 },
          },
        },
        transitions: [{ target: 'metrics' }],
      },
      {
        id: 'metrics',
        type: 'evaluate-metrics',
        config: {
          metrics: [
            {
              name: 'msg1-toxicity',
              field: 'steps.scorer.output.messages.msg1.toxicity',
              operator: 'lte',
              threshold: 0.7,
            },
            {
              name: 'msg2-toxicity',
              field: 'steps.scorer.output.messages.msg2.toxicity',
              operator: 'lte',
              threshold: 0.7,
            },
          ],
        },
        transitions: [{ target: 'policy' }],
      },
      {
        id: 'policy',
        type: 'evaluate-policy',
        config: {
          policyId: 'safety-v1',
          rules: [
            {
              name: 'overall-score',
              condition: 'steps.metrics.output.overallScore',
              operator: 'gte',
              expected: 0.8,
              severity: 'critical',
            },
            {
              name: 'no-toxic-msg2',
              condition: 'steps.metrics.output.scores.msg2-toxicity.passed',
              operator: 'eq',
              expected: true,
              severity: 'critical',
            },
          ],
        },
        transitions: [],
      },
    ];

    const { executor, nodeOutputs } = createRealExecutor(PIPELINE_INPUT);
    const result = await walkGraph(nodes, 'scorer', PIPELINE_INPUT, executor);

    // Graph completed all 3 nodes
    expect(result.status).toBe('completed');
    expect(Object.keys(result.nodeOutputs)).toEqual(['scorer', 'metrics', 'policy']);

    // Verify real evaluateMetrics output
    const metricsOutput = nodeOutputs['metrics'];
    expect(metricsOutput.status).toBe('success');
    expect(metricsOutput.data.scores['msg1-toxicity'].passed).toBe(true);
    expect(metricsOutput.data.scores['msg1-toxicity'].value).toBe(0.05);
    expect(metricsOutput.data.scores['msg2-toxicity'].passed).toBe(false);
    expect(metricsOutput.data.scores['msg2-toxicity'].value).toBe(0.92);
    expect(metricsOutput.data.overallScore).toBe(0.5);

    // Verify real evaluatePolicy output — should FAIL due to toxic msg2
    const policyOutput = nodeOutputs['policy'];
    expect(policyOutput.status).toBe('success');
    expect(policyOutput.data.status).toBe('FAIL');
    expect(policyOutput.data.policyId).toBe('safety-v1');
    expect(policyOutput.data.violations).toHaveLength(2);
  });

  test('conditional branching: metrics pass → store, metrics fail → alert', async () => {
    // Graph: scorer → evaluate-metrics → conditional: if overallScore >= 0.8 → store, else → alert
    const nodes: PipelineNode[] = [
      {
        id: 'scorer',
        type: 'mock-scorer',
        config: {
          messages: {
            msg1: { text: 'Great service', toxicity: 0.02 },
            msg2: { text: 'Very helpful', toxicity: 0.01 },
          },
        },
        transitions: [{ target: 'metrics' }],
      },
      {
        id: 'metrics',
        type: 'evaluate-metrics',
        config: {
          metrics: [
            {
              name: 'msg1-toxicity',
              field: 'steps.scorer.output.messages.msg1.toxicity',
              operator: 'lte',
              threshold: 0.7,
            },
            {
              name: 'msg2-toxicity',
              field: 'steps.scorer.output.messages.msg2.toxicity',
              operator: 'lte',
              threshold: 0.7,
            },
          ],
        },
        transitions: [
          {
            target: 'store',
            condition: 'output.overallScore >= 0.8',
            order: 1,
          },
          { target: 'alert', order: 2 },
        ],
      },
      {
        id: 'store',
        type: 'mock-store',
        config: { destination: 'clickhouse' },
        transitions: [],
      },
      {
        id: 'alert',
        type: 'mock-alert',
        config: { channel: 'slack' },
        transitions: [],
      },
    ];

    const { executor, nodeOutputs } = createRealExecutor(PIPELINE_INPUT);
    const result = await walkGraph(nodes, 'scorer', PIPELINE_INPUT, executor);

    expect(result.status).toBe('completed');
    // Both messages are safe → overallScore = 1.0 ≥ 0.8 → takes 'store' path
    expect(result.nodeOutputs['store']).toBeDefined();
    expect(result.nodeOutputs['alert']).toBeUndefined();
    expect(nodeOutputs['metrics'].data.overallScore).toBe(1.0);
  });

  test('conditional branching: toxic input takes alert path', async () => {
    const nodes: PipelineNode[] = [
      {
        id: 'scorer',
        type: 'mock-scorer',
        config: {
          messages: {
            msg1: { text: 'Terrible!', toxicity: 0.95 },
          },
        },
        transitions: [{ target: 'metrics' }],
      },
      {
        id: 'metrics',
        type: 'evaluate-metrics',
        config: {
          metrics: [
            {
              name: 'msg1-toxicity',
              field: 'steps.scorer.output.messages.msg1.toxicity',
              operator: 'lte',
              threshold: 0.7,
            },
          ],
        },
        transitions: [
          {
            target: 'store',
            condition: 'output.overallScore >= 0.8',
            order: 1,
          },
          { target: 'alert', order: 2 },
        ],
      },
      {
        id: 'store',
        type: 'mock-store',
        config: { destination: 'clickhouse' },
        transitions: [],
      },
      {
        id: 'alert',
        type: 'mock-alert',
        config: { channel: 'slack' },
        transitions: [],
      },
    ];

    const { executor, nodeOutputs } = createRealExecutor(PIPELINE_INPUT);
    const result = await walkGraph(nodes, 'scorer', PIPELINE_INPUT, executor);

    expect(result.status).toBe('completed');
    // Toxic message → overallScore = 0.0 < 0.8 → takes 'alert' path
    expect(result.nodeOutputs['alert']).toBeDefined();
    expect(result.nodeOutputs['store']).toBeUndefined();
    expect(nodeOutputs['metrics'].data.overallScore).toBe(0);
  });

  test('transform → evaluate-metrics: data reshaping feeds into threshold evaluation', async () => {
    // Graph: mock-input → transform (reshapes data) → evaluate-metrics (uses transformed data)
    const nodes: PipelineNode[] = [
      {
        id: 'raw-input',
        type: 'mock-source',
        config: {
          scores: { overall: 0.42, detail: { precision: 0.8, recall: 0.6 } },
        },
        transitions: [{ target: 'reshape' }],
      },
      {
        id: 'reshape',
        type: 'transform',
        config: {
          mapping: {
            overallScore: 'steps.raw-input.output.scores.overall',
            precision: 'steps.raw-input.output.scores.detail.precision',
            recall: 'steps.raw-input.output.scores.detail.recall',
          },
        },
        transitions: [{ target: 'eval' }],
      },
      {
        id: 'eval',
        type: 'evaluate-metrics',
        config: {
          metrics: [
            {
              name: 'precision-check',
              field: 'steps.reshape.output.precision',
              operator: 'gte',
              threshold: 0.7,
            },
            {
              name: 'recall-check',
              field: 'steps.reshape.output.recall',
              operator: 'gte',
              threshold: 0.7,
            },
          ],
        },
        transitions: [],
      },
    ];

    const { executor, nodeOutputs } = createRealExecutor(PIPELINE_INPUT);
    const result = await walkGraph(nodes, 'raw-input', PIPELINE_INPUT, executor);

    expect(result.status).toBe('completed');
    expect(Object.keys(result.nodeOutputs)).toEqual(['raw-input', 'reshape', 'eval']);

    // Transform correctly reshapes the data
    const transformOutput = nodeOutputs['reshape'];
    expect(transformOutput.status).toBe('success');
    expect(transformOutput.data.overallScore).toBe(0.42);
    expect(transformOutput.data.precision).toBe(0.8);
    expect(transformOutput.data.recall).toBe(0.6);

    // EvaluateMetrics consumes transformed data
    const evalOutput = nodeOutputs['eval'];
    expect(evalOutput.status).toBe('success');
    expect(evalOutput.data.scores['precision-check'].value).toBe(0.8);
    expect(evalOutput.data.scores['precision-check'].passed).toBe(true);
    expect(evalOutput.data.scores['recall-check'].value).toBe(0.6);
    expect(evalOutput.data.scores['recall-check'].passed).toBe(false);
  });

  test('execution context propagation via buildExecutionContext', async () => {
    // Verifies that buildExecutionContext correctly writes outputs under contextKey
    // and downstream handlers can access them
    const nodes: PipelineNode[] = [
      {
        id: 'scorer',
        type: 'mock-scorer',
        config: {
          messages: { msg1: { toxicity: 0.1 } },
        },
        transitions: [{ target: 'metrics' }],
      },
      {
        id: 'metrics',
        type: 'evaluate-metrics',
        config: {
          metrics: [
            {
              name: 'tox',
              field: 'steps.scorer.output.messages.msg1.toxicity',
              operator: 'lte',
              threshold: 0.5,
            },
          ],
        },
        transitions: [],
      },
    ];

    const { executor, nodeOutputs, executionContext } = createRealExecutor(PIPELINE_INPUT);
    await walkGraph(nodes, 'scorer', PIPELINE_INPUT, executor);

    // nodeOutputs accumulated both nodes (mirrors runGraphMode)
    expect(nodeOutputs['scorer']).toBeDefined();
    expect(nodeOutputs['metrics']).toBeDefined();

    // evaluate-metrics produces 'metrics' context key
    // (deriveContextKey('evaluate-metrics') → 'metrics')
    expect(executionContext['metrics']).toBeDefined();
    expect(executionContext['metrics'].overallScore).toBe(1.0);
    expect(executionContext['metrics'].scores['tox'].passed).toBe(true);
  });
});

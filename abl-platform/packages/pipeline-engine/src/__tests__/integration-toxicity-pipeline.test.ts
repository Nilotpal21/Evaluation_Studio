/**
 * Integration test: Toxicity evaluation pipeline
 *
 * Tests the REAL implementations of EvaluateMetrics and EvaluatePolicy
 * chained together — no mocks, no stubs.
 *
 * Scenario: An upstream scoring service has analyzed 2 consecutive user
 * messages and produced per-message toxicity scores. We run:
 *   1. EvaluateMetrics — threshold-based scoring of each message
 *   2. EvaluatePolicy — safety policy compliance check on the results
 */
import { describe, test, expect } from 'vitest';
import { evaluateMetricsService } from '../pipeline/services/evaluate-metrics.service.js';
import { evaluatePolicyService } from '../pipeline/services/evaluate-policy.service.js';
import type { PipelineStepContext, StepOutput } from '../pipeline/types.js';

// ---------------------------------------------------------------------------
// Restate context — NOT a mock. ctx.run() is Restate's journal durability
// wrapper; the real handler code inside runs as-is. In production Restate
// manages replay, but the business logic is identical.
// ---------------------------------------------------------------------------
function createRestateContext(): any {
  return {
    run: async (_label: string, fn: () => any) => fn(),
    console: { log: (...args: any[]) => console.log('[Restate]', ...args) },
  };
}

// Extract raw handler from Restate service definition
function handler(svc: any): (ctx: any, input: PipelineStepContext) => Promise<StepOutput> {
  return svc.service.execute;
}

// ---------------------------------------------------------------------------
// Pipeline constants — simulating a real project configuration
// ---------------------------------------------------------------------------
const TENANT_ID = 'demo-tenant';
const PROJECT_ID = 'demo-project';
const SESSION_ID = 'session-toxicity-eval';

const TOXICITY_THRESHOLD = 0.7;
const POLICY_OVERALL_SCORE_MIN = 0.8;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Integration: Toxicity pipeline — EvaluateMetrics → EvaluatePolicy', () => {
  const evaluateMetrics = handler(evaluateMetricsService);
  const evaluatePolicy = handler(evaluatePolicyService);

  test('2 safe messages → metrics PASS → policy PASS', async () => {
    const ctx = createRestateContext();

    // Upstream: toxicity scorer analyzed 2 user messages
    const scorerOutput: Record<string, StepOutput> = {
      'toxicity-scorer': {
        status: 'success',
        data: {
          messages: {
            msg1: { text: 'Hello, can you help me with my account?', toxicity: 0.05 },
            msg2: { text: 'Thank you for the quick response!', toxicity: 0.02 },
          },
        },
      },
    };

    // --- Step 1: EvaluateMetrics ---
    const metricsResult = await evaluateMetrics(ctx, {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      config: {
        metrics: [
          {
            name: 'msg1-toxicity',
            field: 'steps.toxicity-scorer.output.messages.msg1.toxicity',
            operator: 'lte',
            threshold: TOXICITY_THRESHOLD,
          },
          {
            name: 'msg2-toxicity',
            field: 'steps.toxicity-scorer.output.messages.msg2.toxicity',
            operator: 'lte',
            threshold: TOXICITY_THRESHOLD,
          },
        ],
      },
      previousSteps: scorerOutput,
      pipelineInput: {
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
      },
    });

    console.log('\n--- EvaluateMetrics Result (safe messages) ---');
    console.log(JSON.stringify(metricsResult, null, 2));

    expect(metricsResult.status).toBe('success');
    expect(metricsResult.data.scores['msg1-toxicity'].value).toBe(0.05);
    expect(metricsResult.data.scores['msg1-toxicity'].passed).toBe(true);
    expect(metricsResult.data.scores['msg2-toxicity'].value).toBe(0.02);
    expect(metricsResult.data.scores['msg2-toxicity'].passed).toBe(true);
    expect(metricsResult.data.overallScore).toBe(1.0);

    // --- Step 2: EvaluatePolicy ---
    const policyResult = await evaluatePolicy(ctx, {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      config: {
        policyId: 'content-safety-v1',
        rules: [
          {
            name: 'overall-score-acceptable',
            condition: 'steps.evaluate-metrics.output.overallScore',
            operator: 'gte',
            expected: POLICY_OVERALL_SCORE_MIN,
            severity: 'critical',
          },
          {
            name: 'msg1-passed',
            condition: 'steps.evaluate-metrics.output.scores.msg1-toxicity.passed',
            operator: 'eq',
            expected: true,
            severity: 'critical',
          },
          {
            name: 'msg2-passed',
            condition: 'steps.evaluate-metrics.output.scores.msg2-toxicity.passed',
            operator: 'eq',
            expected: true,
            severity: 'critical',
          },
        ],
      },
      previousSteps: {
        ...scorerOutput,
        'evaluate-metrics': metricsResult,
      },
      pipelineInput: {
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
      },
    });

    console.log('\n--- EvaluatePolicy Result (safe messages) ---');
    console.log(JSON.stringify(policyResult, null, 2));

    expect(policyResult.status).toBe('success');
    expect(policyResult.data.status).toBe('PASS');
    expect(policyResult.data.policyId).toBe('content-safety-v1');
    expect(policyResult.data.summary).toEqual({ passed: 3, failed: 0, warnings: 0, total: 3 });
    expect(policyResult.data.violations).toEqual([]);
  });

  test('1 safe + 1 toxic message → metrics partial fail → policy FAIL', async () => {
    const ctx = createRestateContext();

    const scorerOutput: Record<string, StepOutput> = {
      'toxicity-scorer': {
        status: 'success',
        data: {
          messages: {
            msg1: { text: 'What is your return policy?', toxicity: 0.08 },
            msg2: { text: 'You people are completely incompetent!', toxicity: 0.92 },
          },
        },
      },
    };

    // --- Step 1: EvaluateMetrics ---
    const metricsResult = await evaluateMetrics(ctx, {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      config: {
        metrics: [
          {
            name: 'msg1-toxicity',
            field: 'steps.toxicity-scorer.output.messages.msg1.toxicity',
            operator: 'lte',
            threshold: TOXICITY_THRESHOLD,
          },
          {
            name: 'msg2-toxicity',
            field: 'steps.toxicity-scorer.output.messages.msg2.toxicity',
            operator: 'lte',
            threshold: TOXICITY_THRESHOLD,
          },
        ],
      },
      previousSteps: scorerOutput,
      pipelineInput: {
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
      },
    });

    console.log('\n--- EvaluateMetrics Result (1 toxic message) ---');
    console.log(JSON.stringify(metricsResult, null, 2));

    expect(metricsResult.status).toBe('success');
    expect(metricsResult.data.scores['msg1-toxicity'].passed).toBe(true);
    expect(metricsResult.data.scores['msg1-toxicity'].value).toBe(0.08);
    expect(metricsResult.data.scores['msg2-toxicity'].passed).toBe(false);
    expect(metricsResult.data.scores['msg2-toxicity'].value).toBe(0.92);
    expect(metricsResult.data.overallScore).toBe(0.5);

    // --- Step 2: EvaluatePolicy ---
    const policyResult = await evaluatePolicy(ctx, {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      config: {
        policyId: 'content-safety-v1',
        rules: [
          {
            name: 'overall-score-acceptable',
            condition: 'steps.evaluate-metrics.output.overallScore',
            operator: 'gte',
            expected: POLICY_OVERALL_SCORE_MIN,
            severity: 'critical',
          },
          {
            name: 'no-toxic-messages-msg1',
            condition: 'steps.evaluate-metrics.output.scores.msg1-toxicity.passed',
            operator: 'eq',
            expected: true,
            severity: 'critical',
          },
          {
            name: 'no-toxic-messages-msg2',
            condition: 'steps.evaluate-metrics.output.scores.msg2-toxicity.passed',
            operator: 'eq',
            expected: true,
            severity: 'critical',
          },
        ],
      },
      previousSteps: {
        ...scorerOutput,
        'evaluate-metrics': metricsResult,
      },
      pipelineInput: {
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
      },
    });

    console.log('\n--- EvaluatePolicy Result (1 toxic message) ---');
    console.log(JSON.stringify(policyResult, null, 2));

    expect(policyResult.status).toBe('success');
    expect(policyResult.data.status).toBe('FAIL');
    expect(policyResult.data.summary.passed).toBe(1); // msg1-passed
    expect(policyResult.data.summary.failed).toBe(2); // overall score + msg2

    // Verify violation details
    const violations = policyResult.data.violations;
    expect(violations).toHaveLength(2);

    const overallViolation = violations.find((v: any) => v.rule === 'overall-score-acceptable');
    expect(overallViolation).toBeDefined();
    expect(overallViolation.actual).toBe(0.5);
    expect(overallViolation.expected).toBe(0.8);
    expect(overallViolation.severity).toBe('critical');

    const msg2Violation = violations.find((v: any) => v.rule === 'no-toxic-messages-msg2');
    expect(msg2Violation).toBeDefined();
    expect(msg2Violation.actual).toBe(false);
    expect(msg2Violation.expected).toBe(true);
    expect(msg2Violation.severity).toBe('critical');
  });

  test('escalating toxicity across messages with weighted scoring', async () => {
    const ctx = createRestateContext();

    // Scenario: user starts polite but escalates — second message gets higher weight
    const scorerOutput: Record<string, StepOutput> = {
      'toxicity-scorer': {
        status: 'success',
        data: {
          messages: {
            msg1: { text: 'I have been waiting for 30 minutes', toxicity: 0.35 },
            msg2: {
              text: 'This is unacceptable, I want to speak to a manager NOW',
              toxicity: 0.65,
            },
          },
        },
      },
    };

    // --- Step 1: EvaluateMetrics with weighted rules ---
    // Recent message (msg2) gets 2x weight because escalation patterns matter more
    const metricsResult = await evaluateMetrics(ctx, {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      config: {
        metrics: [
          {
            name: 'msg1-toxicity',
            field: 'steps.toxicity-scorer.output.messages.msg1.toxicity',
            operator: 'lte',
            threshold: TOXICITY_THRESHOLD,
            weight: 1.0,
          },
          {
            name: 'msg2-toxicity',
            field: 'steps.toxicity-scorer.output.messages.msg2.toxicity',
            operator: 'lte',
            threshold: TOXICITY_THRESHOLD,
            weight: 2.0,
          },
        ],
      },
      previousSteps: scorerOutput,
      pipelineInput: {
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
      },
    });

    console.log('\n--- EvaluateMetrics Result (escalating, weighted) ---');
    console.log(JSON.stringify(metricsResult, null, 2));

    // Both pass the threshold (0.35 <= 0.7, 0.65 <= 0.7)
    expect(metricsResult.status).toBe('success');
    expect(metricsResult.data.scores['msg1-toxicity'].passed).toBe(true);
    expect(metricsResult.data.scores['msg2-toxicity'].passed).toBe(true);
    expect(metricsResult.data.overallScore).toBe(1.0);

    // --- Step 2: EvaluatePolicy with tiered rules ---
    // Critical: overall must pass. Warning: raw toxicity values should be < 0.3
    const policyResult = await evaluatePolicy(ctx, {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      config: {
        policyId: 'content-safety-v1',
        rules: [
          {
            name: 'metrics-overall-pass',
            condition: 'steps.evaluate-metrics.output.overallScore',
            operator: 'gte',
            expected: POLICY_OVERALL_SCORE_MIN,
            severity: 'critical',
          },
          {
            name: 'msg1-low-toxicity',
            condition: 'steps.toxicity-scorer.output.messages.msg1.toxicity',
            operator: 'lte',
            expected: 0.3,
            severity: 'warning',
          },
          {
            name: 'msg2-low-toxicity',
            condition: 'steps.toxicity-scorer.output.messages.msg2.toxicity',
            operator: 'lte',
            expected: 0.3,
            severity: 'warning',
          },
        ],
      },
      previousSteps: {
        ...scorerOutput,
        'evaluate-metrics': metricsResult,
      },
      pipelineInput: {
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
      },
    });

    console.log('\n--- EvaluatePolicy Result (escalating, weighted) ---');
    console.log(JSON.stringify(policyResult, null, 2));

    // Critical rule passes (overallScore 1.0 >= 0.8)
    // Warning rules fail (0.35 > 0.3, 0.65 > 0.3)
    expect(policyResult.status).toBe('success');
    expect(policyResult.data.status).toBe('WARN');
    expect(policyResult.data.summary).toEqual({ passed: 1, failed: 2, warnings: 2, total: 3 });

    // Both warning violations present — escalation detected but not critical
    const violations = policyResult.data.violations;
    expect(violations).toHaveLength(2);
    expect(violations.every((v: any) => v.severity === 'warning')).toBe(true);
    expect(violations.find((v: any) => v.rule === 'msg1-low-toxicity').actual).toBe(0.35);
    expect(violations.find((v: any) => v.rule === 'msg2-low-toxicity').actual).toBe(0.65);
  });

  test('toxicity from pipelineInput (direct event data, no upstream step)', async () => {
    const ctx = createRestateContext();

    // Scenario: toxicity scores come directly in the pipeline trigger event,
    // not from a previous step — tests pipelineInput.* expression resolution
    const metricsResult = await evaluateMetrics(ctx, {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      config: {
        metrics: [
          {
            name: 'msg1-toxicity',
            field: 'pipelineInput.payload.messages.msg1.toxicity',
            operator: 'lte',
            threshold: TOXICITY_THRESHOLD,
          },
          {
            name: 'msg2-toxicity',
            field: 'pipelineInput.payload.messages.msg2.toxicity',
            operator: 'lte',
            threshold: TOXICITY_THRESHOLD,
          },
        ],
      },
      previousSteps: {},
      pipelineInput: {
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        payload: {
          messages: {
            msg1: { text: 'First message', toxicity: 0.1 },
            msg2: { text: 'Second message', toxicity: 0.9 },
          },
        },
      },
    });

    console.log('\n--- EvaluateMetrics Result (from pipelineInput) ---');
    console.log(JSON.stringify(metricsResult, null, 2));

    expect(metricsResult.status).toBe('success');
    expect(metricsResult.data.scores['msg1-toxicity'].value).toBe(0.1);
    expect(metricsResult.data.scores['msg1-toxicity'].passed).toBe(true);
    expect(metricsResult.data.scores['msg2-toxicity'].value).toBe(0.9);
    expect(metricsResult.data.scores['msg2-toxicity'].passed).toBe(false);
    expect(metricsResult.data.overallScore).toBe(0.5);
  });
});

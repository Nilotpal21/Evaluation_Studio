import { describe, expect, it } from 'vitest';
import {
  buildEvalRuntimeAgentChatBody,
  isEvalRuntimeSessionEnded,
} from '../pipeline/services/eval/eval-runtime-request.js';

describe('buildEvalRuntimeAgentChatBody', () => {
  it('passes persona session variables on the first runtime turn', () => {
    const body = buildEvalRuntimeAgentChatBody({
      projectId: 'project-1',
      message: 'Start',
      entryAgent: 'Supervisor',
      sessionVariables: {
        consumer_id: 'consumer-123',
        contract_id: 'contract-456',
      },
    });

    expect(body).toEqual({
      projectId: 'project-1',
      message: 'Start',
      agentId: 'Supervisor',
      knownSource: 'eval',
      testContext: {
        skipOnStart: false,
        sessionVariables: {
          consumer_id: 'consumer-123',
          contract_id: 'contract-456',
        },
      },
    });
  });

  it('does not reapply persona session variables on resumed turns', () => {
    const body = buildEvalRuntimeAgentChatBody({
      projectId: 'project-1',
      message: 'Continue',
      sessionId: 'session-1',
      entryAgent: 'Supervisor',
      sessionVariables: {
        consumer_id: 'consumer-123',
      },
    });

    expect(body).toEqual({
      projectId: 'project-1',
      message: 'Continue',
      sessionId: 'session-1',
      knownSource: 'eval',
      testContext: { skipOnStart: false },
    });
  });

  it('emits callerContext when runId is provided', () => {
    const body = buildEvalRuntimeAgentChatBody({
      projectId: 'project-1',
      message: 'Start',
      runId: 'run-abc',
    });

    expect(body.callerContext).toEqual({
      source: 'pipeline-engine',
      workflowExecutionId: 'run-abc',
    });
  });

  it('omits callerContext when runId is not provided', () => {
    const body = buildEvalRuntimeAgentChatBody({
      projectId: 'project-1',
      message: 'Start',
    });

    expect(body).not.toHaveProperty('callerContext');
  });

  it('omits agentId on resumed turns even when entryAgent is provided', () => {
    const body = buildEvalRuntimeAgentChatBody({
      projectId: 'project-1',
      message: 'Continue',
      sessionId: 'session-1',
      entryAgent: 'Supervisor',
    });

    expect(body).not.toHaveProperty('agentId');
  });

  it('emits agentId on the first turn when entryAgent is provided', () => {
    const body = buildEvalRuntimeAgentChatBody({
      projectId: 'project-1',
      message: 'Start',
      entryAgent: 'Supervisor',
    });

    expect(body.agentId).toBe('Supervisor');
  });

  it('defaults knownSource to eval for billing/analytics exclusion', () => {
    const body = buildEvalRuntimeAgentChatBody({
      projectId: 'project-1',
      message: 'Start',
    });

    expect(body.knownSource).toBe('eval');
  });

  it('propagates synthetic knownSource across the eval runtime boundary', () => {
    const body = buildEvalRuntimeAgentChatBody({
      projectId: 'project-1',
      message: 'Start',
      knownSource: 'synthetic',
    });

    expect(body.knownSource).toBe('synthetic');
  });

  it('does not propagate production knownSource from eval runs', () => {
    const body = buildEvalRuntimeAgentChatBody({
      projectId: 'project-1',
      message: 'Start',
      knownSource: 'production',
    });

    expect(body.knownSource).toBe('eval');
  });

  it('treats explicit non-terminal actions as non-terminal even with stale sessionEnded flags', () => {
    expect(isEvalRuntimeSessionEnded({ action: 'continue', sessionEnded: true })).toBe(false);
    expect(isEvalRuntimeSessionEnded({ action: { type: 'continue' }, sessionEnded: true })).toBe(
      false,
    );
    expect(isEvalRuntimeSessionEnded({ action: 'handoff', sessionEnded: true })).toBe(false);
    expect(isEvalRuntimeSessionEnded({ action: 'respond', sessionEnded: true })).toBe(false);
  });

  it('treats complete and escalate actions as terminal', () => {
    expect(isEvalRuntimeSessionEnded({ action: 'complete', sessionEnded: false })).toBe(true);
    expect(isEvalRuntimeSessionEnded({ action: 'escalate', sessionEnded: false })).toBe(true);
  });

  it('falls back to sessionEnded when no runtime action is provided', () => {
    expect(isEvalRuntimeSessionEnded({ sessionEnded: true })).toBe(true);
    expect(isEvalRuntimeSessionEnded({ sessionEnded: false })).toBe(false);
  });
});

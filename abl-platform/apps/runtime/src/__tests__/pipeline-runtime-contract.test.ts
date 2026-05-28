import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLASSIFIER_SIDECAR_RESPONSE_FIXTURE,
  isClassifierSidecarRequest,
} from '@agent-platform/shared-kernel';

vi.mock('ai', () => ({
  generateText: vi.fn(),
}));

import { generateText } from 'ai';
import {
  buildClassifierSidecarRequest,
  buildKnownCategorySet,
  classify,
  parseClassifierSidecarResponse,
} from '../services/pipeline/classifier.js';
import { DEFAULT_PIPELINE_CONFIG } from '../services/pipeline/types.js';
import {
  canDeriveRouteFromIntentText,
  isSupervisorToolCallRouteIntent,
  MAX_CLASSIFIER_CONTEXT_MESSAGES,
  resolveClassifierRuntimeContext,
  shouldRunPipelineClassifier,
} from '../services/pipeline/runtime-contract.js';

const mockGenerateText = vi.mocked(generateText);

describe('shouldRunPipelineClassifier', () => {
  it('runs when routing rules can consume classifier output', () => {
    expect(
      shouldRunPipelineClassifier({
        categories: [{ name: 'billing' }],
        routingRules: [{ to: 'BillingAgent', when: 'intent.category == "billing"' }],
        intentBridgeEnabled: false,
      }),
    ).toEqual({
      shouldRun: true,
      reason: 'actionable',
    });
  });

  it('skips when no intent categories are declared', () => {
    expect(
      shouldRunPipelineClassifier({
        categories: [],
        routingRules: [{ to: 'BillingAgent', when: 'intent.category == "billing"' }],
        intentBridgeEnabled: true,
      }),
    ).toEqual({
      shouldRun: false,
      reason: 'no_categories',
    });
  });

  it('runs when intent bridge can consume classifier output even without routing rules', () => {
    expect(
      shouldRunPipelineClassifier({
        categories: [{ name: 'billing' }],
        routingRules: [],
        intentBridgeEnabled: true,
      }),
    ).toEqual({
      shouldRun: true,
      reason: 'actionable',
    });
  });

  it('skips when no pipeline control-flow consumer can use classifier output', () => {
    expect(
      shouldRunPipelineClassifier({
        categories: [{ name: 'billing' }],
        routingRules: [],
        intentBridgeEnabled: false,
      }),
    ).toEqual({
      shouldRun: false,
      reason: 'no_control_flow_consumers',
    });
  });

  it('skips source=tool_call intents because the supervisor already selected the route', () => {
    expect(
      shouldRunPipelineClassifier({
        categories: [{ name: 'billing' }],
        routingRules: [{ to: 'BillingAgent', when: 'intent.category == "billing"' }],
        intentBridgeEnabled: true,
        currentIntent: { source: 'tool_call' },
      }),
    ).toEqual({
      shouldRun: false,
      reason: 'supervisor_tool_call',
    });
  });
});

describe('route intent source guards', () => {
  it('blocks keyword-derived routing for supervisor tool-call intents', () => {
    const intent = { source: 'tool_call', summary: 'Transfer user to agent Wrong_Agent' };

    expect(isSupervisorToolCallRouteIntent(intent)).toBe(true);
    expect(canDeriveRouteFromIntentText(intent)).toBe(false);
  });

  it('blocks sibling keyword reroutes for supervisor leave-application tool calls', () => {
    const intent = {
      source: 'tool_call',
      category: null,
      summary: 'Transfer user to agent LeaveApplication for leave',
    };

    expect(canDeriveRouteFromIntentText(intent)).toBe(false);
    expect(
      shouldRunPipelineClassifier({
        categories: [{ name: 'leave_application' }, { name: 'leave_balance' }],
        routingRules: [
          { to: 'LeaveApplication', when: 'intent.category == "leave_application"' },
          { to: 'LeaveBalance', when: 'intent.category == "leave_balance"' },
        ],
        intentBridgeEnabled: true,
        currentIntent: intent,
      }),
    ).toEqual({
      shouldRun: false,
      reason: 'supervisor_tool_call',
    });
  });

  it('still allows the same leave text to be classified when it is not a supervisor tool call', () => {
    const intent = {
      source: 'pipeline',
      category: null,
      summary: 'I want to apply for leave and not check leave balance',
    };

    expect(canDeriveRouteFromIntentText(intent)).toBe(true);
    expect(
      shouldRunPipelineClassifier({
        categories: [{ name: 'leave_application' }, { name: 'leave_balance' }],
        routingRules: [
          { to: 'LeaveApplication', when: 'intent.category == "leave_application"' },
          { to: 'LeaveBalance', when: 'intent.category == "leave_balance"' },
        ],
        intentBridgeEnabled: true,
        currentIntent: intent,
      }),
    ).toEqual({
      shouldRun: true,
      reason: 'actionable',
    });
  });

  it('allows text-derived routing checks for non-tool-call intents', () => {
    const intent = { source: 'pipeline', summary: 'billing help' };

    expect(isSupervisorToolCallRouteIntent(intent)).toBe(false);
    expect(canDeriveRouteFromIntentText(intent)).toBe(true);
  });
});

describe('resolveClassifierRuntimeContext', () => {
  it('prefers stamped current input over raw handoff input for the current message', () => {
    const context = resolveClassifierRuntimeContext({
      conversationHistory: [
        { role: 'user', content: 'Too old: hello' },
        { role: 'assistant', content: 'Too old: hi there' },
        { role: 'user', content: 'I need help with a transfer' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'What part of the transfer failed?' }],
        },
        { role: 'user', content: 'It failed during approval' },
        { role: 'assistant', content: 'What error did you see?' },
        { role: 'user', content: 'User wants transfer help' },
      ],
      currentInput: 'Actually, the transfer failed for [REDACTED_EMAIL].',
      rawInput: 'Actually, the transfer failed for user@example.com.',
      handoffFrom: 'SupervisorAgent',
    });

    expect(context.currentMessage).toBe('Actually, the transfer failed for [REDACTED_EMAIL].');
    expect(context.recentConversation).toEqual([
      { role: 'user', text: 'I need help with a transfer' },
      { role: 'assistant', text: 'What part of the transfer failed?' },
      { role: 'user', text: 'It failed during approval' },
      { role: 'assistant', text: 'What error did you see?' },
    ]);
    expect(context.recentConversation).toHaveLength(MAX_CLASSIFIER_CONTEXT_MESSAGES);
  });

  it('uses raw handoff input as the current message and excludes the handoff summary', () => {
    const context = resolveClassifierRuntimeContext({
      conversationHistory: [
        { role: 'user', content: 'Too old: hello' },
        { role: 'assistant', content: 'Too old: hi there' },
        { role: 'user', content: 'I need help with a transfer' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'What part of the transfer failed?' }],
        },
        { role: 'user', content: 'It failed during approval' },
        { role: 'assistant', content: 'What error did you see?' },
        { role: 'user', content: 'User wants transfer help' },
      ],
      rawInput: 'Actually, the transfer failed yesterday.',
      handoffFrom: 'SupervisorAgent',
    });

    expect(context.currentMessage).toBe('Actually, the transfer failed yesterday.');
    expect(context.recentConversation).toEqual([
      { role: 'user', text: 'I need help with a transfer' },
      { role: 'assistant', text: 'What part of the transfer failed?' },
      { role: 'user', text: 'It failed during approval' },
      { role: 'assistant', text: 'What error did you see?' },
    ]);
    expect(context.recentConversation).toHaveLength(MAX_CLASSIFIER_CONTEXT_MESSAGES);
  });

  it('uses the latest real user turn when there is no handoff raw input', () => {
    const context = resolveClassifierRuntimeContext({
      conversationHistory: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
        { role: 'user', content: 'What are your store hours?' },
      ],
    });

    expect(context.currentMessage).toBe('What are your store hours?');
    expect(context.recentConversation).toEqual([
      { role: 'user', text: 'Hello' },
      { role: 'assistant', text: 'Hi there' },
    ]);
  });
});

describe('classifier prompt contract', () => {
  beforeEach(() => {
    mockGenerateText.mockReset();
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        intents: [{ category: 'billing', confidence: 0.4, summary: 'billing issue' }],
      }),
      finishReason: 'stop',
      usage: {
        inputTokens: 42,
        outputTokens: 8,
      },
    } as any);
  });

  it('includes bounded recent conversation before the current message', async () => {
    await classify({ modelId: 'pipeline-model' } as any, {
      mode: 'global',
      userMessage: 'It was charged twice.',
      categories: [{ name: 'billing' }],
      config: DEFAULT_PIPELINE_CONFIG,
      recentConversation: [
        { role: 'user', text: 'I need help with my bill' },
        { role: 'assistant', text: 'Sure, which charge looks wrong?' },
        { role: 'user', text: 'The late fee' },
        { role: 'assistant', text: 'What about the late fee looks incorrect?' },
      ],
    });

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const prompt = (mockGenerateText.mock.calls[0]?.[0] as { prompt?: string } | undefined)?.prompt;

    expect(prompt).toContain('Recent conversation context (oldest to newest):');
    expect(prompt).toContain('- user: "I need help with my bill"');
    expect(prompt).toContain('- assistant: "Sure, which charge looks wrong?"');
    expect(prompt).toContain('- user: "The late fee"');
    expect(prompt).toContain('- assistant: "What about the late fee looks incorrect?"');
    expect(prompt).toContain('Current user message: "It was charged twice."');
  });

  it('30.0 Context-free classifier regression uses bounded history for follow-up turns', async () => {
    await classify({ modelId: 'pipeline-model' } as any, {
      mode: 'global',
      userMessage: 'What about that one?',
      categories: [{ name: 'billing' }],
      config: DEFAULT_PIPELINE_CONFIG,
      recentConversation: [
        { role: 'user', text: 'I need help with my bill' },
        { role: 'assistant', text: 'Sure, which charge looks wrong?' },
        { role: 'user', text: 'The late fee' },
        { role: 'assistant', text: 'What about the late fee looks incorrect?' },
      ],
    });

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const prompt = (mockGenerateText.mock.calls[0]?.[0] as { prompt?: string } | undefined)?.prompt;

    expect(prompt).toContain('Recent conversation context (oldest to newest):');
    expect(prompt).toContain('- user: "I need help with my bill"');
    expect(prompt).toContain('- assistant: "Sure, which charge looks wrong?"');
    expect(prompt).toContain('- user: "The late fee"');
    expect(prompt).toContain('- assistant: "What about the late fee looks incorrect?"');
    expect(prompt).toContain('Current user message: "What about that one?"');
  });

  it('builds a gather-scoped sidecar request that satisfies the shared contract', () => {
    const request = buildClassifierSidecarRequest(
      {
        mode: 'gather_scoped',
        userMessage: 'get atms near me',
        categories: [
          {
            name: 'atm_locator',
            description: 'Users asking for ATM or branch locations',
          },
          {
            name: 'speak_to_agent',
            description: 'Users asking to reach support',
          },
        ],
        candidateSurface: {
          kind: 'parent_supervisor_route',
          size: 2,
          candidates: ['atm_locator', 'speak_to_agent'],
        },
        config: DEFAULT_PIPELINE_CONFIG,
      },
      {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        locale: 'en',
        threshold: 0.76,
        topK: 3,
      },
    );

    expect(isClassifierSidecarRequest(request)).toBe(true);
    expect(request).toMatchObject({
      text: 'get atms near me',
      locale: 'en',
      task: 'flow_escape',
      top_k: 2,
      threshold: 0.76,
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sessionId: 'session-1',
    });
  });

  it('replays the shared sidecar response fixture into classifier output', () => {
    const knownCategories = buildKnownCategorySet([
      { name: 'atm_locator' },
      { name: 'speak_to_agent' },
    ]);

    expect(
      parseClassifierSidecarResponse(CLASSIFIER_SIDECAR_RESPONSE_FIXTURE, knownCategories),
    ).toEqual({
      intents: [
        {
          category: 'atm_locator',
          confidence: 0.84,
          summary: 'Find an ATM near me',
        },
      ],
    });
  });
});

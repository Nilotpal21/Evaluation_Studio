import { describe, expect, it, vi } from 'vitest';
import type { LanguageModel } from 'ai';
import type { RuntimeSession } from '../../services/execution/types.js';
import type { RoutingExecutor } from '../../services/execution/routing-executor.js';
import type { ResolvedMultiIntentPlan } from '../../services/execution/multi-intent/multi-intent-types.js';
import {
  buildSequentialMultiIntentTasks,
  executeSequentialMultiIntentPlan,
} from '../../services/execution/multi-intent/sequential-executor.js';

function buildSession(): RuntimeSession {
  return {
    id: 'session-sequential-test',
    tenantId: 'tenant-sequential-test',
    projectId: 'project-sequential-test',
    agentName: 'AFGSupervisor',
    compilationOutput: null,
    conversationHistory: [],
    state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
    data: { values: {}, gatheredKeys: new Set<string>() },
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    initialized: true,
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    createdAt: new Date(),
    lastActivityAt: new Date(),
    storeVersion: 0,
  } as unknown as RuntimeSession;
}

function buildPlan(): ResolvedMultiIntentPlan {
  return {
    strategy: 'sequential',
    primary: {
      intent: 'product search',
      target: { kind: 'agent', ref: 'ProductAgent', label: 'ProductAgent' },
      category: 'product_search',
      summary: 'show me red dresses',
      confidence: 0.96,
      source: 'pipeline',
    },
    alternatives: [
      {
        intent: 'return policy',
        target: { kind: 'agent', ref: 'FAQAgent', label: 'FAQAgent' },
        category: 'faq',
        summary: 'return policy for the cheapest one',
        confidence: 0.91,
        source: 'pipeline',
      },
    ],
    relationship: {
      type: 'dependent',
      reasoning: 'The second intent refers to the product found by the first intent.',
    },
    source: 'pipeline',
    maxIntents: 3,
  };
}

describe('sequential multi-intent executor', () => {
  it('builds ordered executable tasks from the resolved plan', () => {
    expect(buildSequentialMultiIntentTasks(buildPlan())).toEqual([
      { target: 'ProductAgent', intent: 'show me red dresses' },
      { target: 'FAQAgent', intent: 'return policy for the cheapest one' },
    ]);
  });

  it('passes prior specialist results to dependent follow-up tasks', async () => {
    const session = buildSession();
    const tasks = buildSequentialMultiIntentTasks(buildPlan());
    const handleFanOut = vi.fn(async (_session: RuntimeSession, input: { tasks: typeof tasks }) => {
      const task = input.tasks[0];
      return {
        success: true,
        failedCount: 0,
        results: [
          {
            target: task.target,
            status: 'completed' as const,
            response:
              task.target === 'ProductAgent'
                ? 'Cheapest red dress: Ted Baker Jalenda, 1019 AED.'
                : 'Ted Baker Jalenda can be returned within 14 days.',
          },
        ],
      };
    });
    const routing = { handleFanOut } as unknown as RoutingExecutor;
    const mergeSequentialResponses = vi.fn(async (_model, _message, agentResults) => {
      expect(agentResults).toEqual([
        {
          target: 'ProductAgent',
          intent: 'show me red dresses',
          response: 'Cheapest red dress: Ted Baker Jalenda, 1019 AED.',
          status: 'completed',
        },
        {
          target: 'FAQAgent',
          intent: 'return policy for the cheapest one',
          response: 'Ted Baker Jalenda can be returned within 14 days.',
          status: 'completed',
        },
      ]);
      return 'The cheapest red dress is Ted Baker Jalenda, and it can be returned within 14 days.';
    });

    const result = await executeSequentialMultiIntentPlan(
      routing,
      session,
      { modelId: 'test-model' } as LanguageModel,
      'show me red dresses and the return policy for the cheapest one',
      tasks,
      'pipeline',
      buildPlan().relationship,
      undefined,
      undefined,
      mergeSequentialResponses,
    );

    expect(handleFanOut).toHaveBeenCalledTimes(2);
    expect(handleFanOut.mock.calls[1][1].tasks[0].context).toMatchObject({
      multiIntentOriginalMessage: 'show me red dresses and the return policy for the cheapest one',
      multiIntentRelationship: 'dependent',
      multiIntentPreviousResults: [
        {
          target: 'ProductAgent',
          status: 'completed',
          response: 'Cheapest red dress: Ted Baker Jalenda, 1019 AED.',
        },
      ],
    });
    expect(result).toMatchObject({
      response:
        'The cheapest red dress is Ted Baker Jalenda, and it can be returned within 14 days.',
      action: {
        type: 'sequential_multi_intent',
        taskCount: 2,
        failedCount: 0,
      },
    });
    expect(mergeSequentialResponses).toHaveBeenCalledTimes(1);
  });
});

import type { LanguageModel } from 'ai';
import type { IntentRelationship } from '@abl/compiler/platform/nlu/types.js';
import type { RoutingExecutor } from '../routing-executor.js';
import { mergeResponses } from '../../pipeline/merge.js';
import type { ExecutionResult, FanOutTask, RuntimeSession, SubTaskResult } from '../types.js';
import type { OnTraceEvent } from '../../pipeline/types.js';
import type { ResolvedMultiIntentPlan } from './multi-intent-types.js';

const MAX_PREVIOUS_RESULTS_IN_CONTEXT = 5;

interface SequentialMergeAgentResult {
  target: string;
  intent: string;
  response: string;
  status: 'completed' | 'failed';
  error?: string;
}

export type MergeSequentialMultiIntentResponses = (
  model: LanguageModel,
  userMessage: string,
  agentResults: SequentialMergeAgentResult[],
  onChunk?: (chunk: string) => void,
  onTraceEvent?: OnTraceEvent,
) => Promise<string>;

interface CompactSequentialResult {
  target: string;
  status: SubTaskResult['status'];
  response?: string;
  error?: string;
}

function toMergeStatus(status: SubTaskResult['status']): 'completed' | 'failed' {
  return status === 'completed' ? 'completed' : 'failed';
}

function compactPreviousResults(results: SubTaskResult[]): CompactSequentialResult[] {
  return results.slice(-MAX_PREVIOUS_RESULTS_IN_CONTEXT).map((result) => ({
    target: result.target,
    status: result.status,
    ...(result.response ? { response: result.response } : {}),
    ...(result.error ? { error: result.error } : {}),
  }));
}

function buildSequentialStateUpdates(session: RuntimeSession): ExecutionResult['stateUpdates'] {
  return {
    gatherProgress: Object.fromEntries(
      [...session.data.gatheredKeys].map((key) => [key, session.data.values[key]]),
    ),
    context: { ...session.data.values },
    conversationPhase: session.state.conversationPhase,
    activeAgent: session.state.activeAgent,
  };
}

function buildSequentialTaskContext(params: {
  task: FanOutTask;
  userMessage: string;
  relationship: IntentRelationship;
  previousResults: SubTaskResult[];
}): Record<string, unknown> {
  const compactResults = compactPreviousResults(params.previousResults);
  return {
    ...params.task.context,
    multiIntentOriginalMessage: params.userMessage,
    multiIntentRelationship: params.relationship.type,
    multiIntentRelationshipReasoning: params.relationship.reasoning,
    multiIntentPreviousResults: compactResults,
  };
}

function toTask(target: string | undefined, intent: string | undefined): FanOutTask | null {
  if (!target || !intent) {
    return null;
  }

  return { target, intent };
}

export function buildSequentialMultiIntentTasks(plan: ResolvedMultiIntentPlan): FanOutTask[] {
  const tasks: FanOutTask[] = [];
  const primaryTask = toTask(plan.primary.target?.ref ?? plan.primary.intent, plan.primary.summary);

  if (primaryTask) {
    tasks.push(primaryTask);
  }

  for (const alternative of plan.alternatives) {
    const task = toTask(alternative.target?.ref ?? alternative.intent, alternative.summary);
    if (task) {
      tasks.push(task);
    }
  }

  return tasks;
}

export async function executeSequentialMultiIntentPlan(
  routing: RoutingExecutor,
  session: RuntimeSession,
  pipelineModel: LanguageModel,
  userMessage: string,
  tasks: FanOutTask[],
  source: 'pipeline' | 'guided' | 'tool_call',
  relationship: IntentRelationship,
  onChunk?: (chunk: string) => void,
  onTraceEvent?: OnTraceEvent,
  mergeSequentialResponses: MergeSequentialMultiIntentResponses = mergeResponses,
): Promise<ExecutionResult> {
  const orderedResults: SubTaskResult[] = [];

  for (const task of tasks) {
    onTraceEvent?.({
      type: 'decision',
      data: {
        type: 'multi_intent_sequential_task_start',
        sessionId: session.id,
        agentName: session.agentName,
        source,
        target: task.target,
        intent: task.intent,
        previousResultCount: orderedResults.length,
      },
    });

    const fanOutResult = await routing.handleFanOut(
      session,
      {
        tasks: [
          {
            ...task,
            context: buildSequentialTaskContext({
              task,
              userMessage,
              relationship,
              previousResults: orderedResults,
            }),
          },
        ],
      },
      undefined,
      onTraceEvent,
    );

    const taskResults =
      fanOutResult.results.length > 0
        ? fanOutResult.results
        : [
            {
              target: task.target,
              status: 'error' as const,
              error: `No result returned for ${task.target}`,
            },
          ];

    orderedResults.push(...taskResults);

    onTraceEvent?.({
      type: 'decision',
      data: {
        type: 'multi_intent_sequential_task_complete',
        sessionId: session.id,
        agentName: session.agentName,
        source,
        target: task.target,
        resultCount: taskResults.length,
        failedCount: taskResults.filter((result) => result.status === 'error').length,
      },
    });
  }

  const agentResults = orderedResults.map((result, index) => ({
    target: result.target,
    intent: tasks[index]?.intent ?? userMessage,
    response: result.response ?? '',
    status: toMergeStatus(result.status),
    ...(result.error ? { error: result.error } : {}),
  }));

  const mergedResponse = await mergeSequentialResponses(
    pipelineModel,
    userMessage,
    agentResults,
    onChunk,
    onTraceEvent,
  );

  onTraceEvent?.({
    type: 'decision',
    data: {
      type: 'multi_intent_sequential_executed',
      sessionId: session.id,
      agentName: session.agentName,
      source,
      relationship: relationship.type,
      taskCount: tasks.length,
      resultCount: orderedResults.length,
      failedCount: orderedResults.filter((result) => result.status === 'error').length,
      targets: tasks.map((task) => task.target),
    },
  });

  return {
    response: mergedResponse,
    action: {
      type: 'sequential_multi_intent',
      taskCount: tasks.length,
      failedCount: orderedResults.filter((result) => result.status === 'error').length,
    },
    stateUpdates: buildSequentialStateUpdates(session),
  };
}

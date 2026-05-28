import type { AgentIR } from '@abl/compiler';
import { buildTools } from '../../execution/prompt-builder.js';
import { getActiveThread, type RuntimeSession } from '../../execution/types.js';
import type { RealtimeLlmToolDefinition } from './realtime-llm-payload.js';

export function toRealtimeToolDefinitions(
  tools: Array<{
    name: string;
    description?: string;
    input_schema?: {
      type?: 'object';
      properties?: Record<string, unknown>;
      required?: string[];
    };
  }>,
): RealtimeLlmToolDefinition[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description || '',
    parameters: {
      type: 'object',
      properties: tool.input_schema?.properties || {},
      required: tool.input_schema?.required || [],
    },
  }));
}

function buildRealtimeToolDefinitionsForAgent(
  session: RuntimeSession,
  agentName: string,
  agentIR: AgentIR | null,
): RealtimeLlmToolDefinition[] {
  const activeThread = getActiveThread(session);
  const isActiveAgent = activeThread.agentName === agentName;
  const tempThread = {
    ...activeThread,
    agentName,
    agentIR,
    handoffFrom: isActiveAgent ? activeThread.handoffFrom : undefined,
    returnExpected: isActiveAgent ? activeThread.returnExpected : false,
    status: 'active' as const,
  };
  const tempSession = {
    ...session,
    agentName,
    agentIR,
    threads: [tempThread],
    activeThreadIndex: 0,
    conversationHistory: tempThread.conversationHistory,
    data: tempThread.data,
    state: tempThread.state,
    currentFlowStep: tempThread.currentFlowStep,
    waitingForInput: tempThread.waitingForInput,
    pendingResponse: tempThread.pendingResponse,
    pendingRichContent: tempThread.pendingRichContent,
    threadStack: isActiveAgent ? session.threadStack : [],
    _preTurnView: undefined,
  } as RuntimeSession;

  return toRealtimeToolDefinitions(buildTools(tempSession));
}

/**
 * Google/Gemini tool declarations are effectively static for the live realtime
 * session, so include a stable superset of reachable agent tools up front.
 * Runtime still validates tool calls against the currently active agent IR.
 */
export function buildGoogleRealtimeToolDefinitions(
  session: RuntimeSession,
): RealtimeLlmToolDefinition[] {
  const currentAgentName = session.agentName;
  const compilationAgents = session.compilationOutput?.agents;
  const orderedEntries = compilationAgents
    ? Object.entries(compilationAgents).sort(([left], [right]) => {
        if (left === currentAgentName && right !== currentAgentName) return -1;
        if (right === currentAgentName && left !== currentAgentName) return 1;
        return 0;
      })
    : [[currentAgentName, session.agentIR] as [string, AgentIR | null]];

  const seen = new Set<string>();
  const definitions: RealtimeLlmToolDefinition[] = [];

  for (const [agentName, agentIR] of orderedEntries) {
    if (!agentIR) {
      continue;
    }

    for (const definition of buildRealtimeToolDefinitionsForAgent(session, agentName, agentIR)) {
      if (seen.has(definition.name)) {
        continue;
      }
      seen.add(definition.name);
      definitions.push(definition);
    }
  }

  return definitions.length > 0 ? definitions : toRealtimeToolDefinitions(buildTools(session));
}

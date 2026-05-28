import { getActiveThread, type RuntimeSession } from '../../execution/types.js';

function isGoogleRealtimeSession(session: RuntimeSession): boolean {
  const sessionNamespace = session.data.values.session;
  return (
    !!sessionNamespace &&
    typeof sessionNamespace === 'object' &&
    (sessionNamespace as Record<string, unknown>).s2sProvider === 's2s:google'
  );
}

function isRealtimeActionToolName(toolName: string): boolean {
  return (
    toolName.startsWith('__') ||
    toolName.startsWith('handoff_to_') ||
    toolName.startsWith('delegate_to_')
  );
}

export function findGoogleRealtimeDeclaringThreadIndex(
  session: RuntimeSession,
  toolName: string,
): number | null {
  if (!isGoogleRealtimeSession(session) || isRealtimeActionToolName(toolName)) {
    return null;
  }

  const activeThread = getActiveThread(session);
  const activeDeclaresTool = activeThread?.agentIR?.tools?.some((tool) => tool.name === toolName);
  if (activeDeclaresTool) {
    return null;
  }

  const prioritizedCandidates: number[] = [];
  const visited = new Set<number>([session.activeThreadIndex]);

  let ancestorIndex = activeThread?.parentThreadIndex;
  while (typeof ancestorIndex === 'number' && ancestorIndex >= 0 && !visited.has(ancestorIndex)) {
    prioritizedCandidates.push(ancestorIndex);
    visited.add(ancestorIndex);
    ancestorIndex = session.threads[ancestorIndex]?.parentThreadIndex;
  }

  for (const index of [...session.threadStack].reverse()) {
    if (!visited.has(index)) {
      prioritizedCandidates.push(index);
      visited.add(index);
    }
  }

  for (const index of prioritizedCandidates) {
    const thread = session.threads[index];
    const declaresTool = thread?.agentIR?.tools?.some((tool) => tool.name === toolName);
    if (declaresTool) {
      return index;
    }
  }

  return null;
}

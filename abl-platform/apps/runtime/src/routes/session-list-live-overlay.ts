import { createLogger } from '@abl/compiler/platform';
import { buildProductionSessionLocator } from '../services/session/execution-scope.js';
import { peekSessionService } from '../services/session/session-service.js';
import type { SessionData } from '../services/session/types.js';

const log = createLogger('session-list-live-overlay');

export type RuntimeSessionListSnapshot = {
  agentName: string;
  messageCount: number;
  createdAt: string;
  createdAtMs: number;
  lastActivityAt: string;
  lastActivityAtMs: number;
  channel?: string;
  activeAgent?: string;
  threadCount?: number;
};

export function countSharedSessionMessages(session: SessionData): number {
  if (session.threads.length === 0) {
    return session.conversationHistory.length;
  }

  let totalMessages = 0;
  for (const thread of session.threads) {
    totalMessages += thread.conversationHistory.length;
  }

  return totalMessages;
}

export function buildSharedRuntimeSessionSnapshot(
  session: SessionData,
): RuntimeSessionListSnapshot | null {
  if (!session.tenantId || !session.projectId) {
    return null;
  }

  const activeThread = session.threads[session.activeThreadIndex];
  const activeAgent =
    activeThread?.agentName ?? session.state.activeAgent?.name ?? session.agentName;
  const entryAgentName = session.threads[0]?.agentName ?? session.agentName;

  return {
    agentName: entryAgentName,
    messageCount: countSharedSessionMessages(session),
    createdAt: new Date(session.createdAt).toISOString(),
    createdAtMs: session.createdAt,
    lastActivityAt: new Date(session.lastActivityAt).toISOString(),
    lastActivityAtMs: session.lastActivityAt,
    activeAgent,
    threadCount: session.threads.length,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function loadSharedRuntimeSessionMap(params: {
  sessionIds: string[];
  tenantId: string;
  projectId: string;
}): Promise<Map<string, RuntimeSessionListSnapshot>> {
  const sessionService = peekSessionService();
  if (!sessionService?.isDistributed() || params.sessionIds.length === 0) {
    return new Map();
  }

  const liveEntries = await Promise.all(
    params.sessionIds.map(async (sessionId) => {
      const locator = buildProductionSessionLocator({
        tenantId: params.tenantId,
        projectId: params.projectId,
        sessionId,
      });
      if (!locator) {
        return null;
      }

      try {
        // Use metadata-only load to avoid IR cache lookups and "IR not found" log spam
        const session = await sessionService.loadSessionMetadataScoped(locator);
        if (!session) {
          return null;
        }

        const snapshot = buildSharedRuntimeSessionSnapshot(session);
        if (!snapshot) {
          return null;
        }

        return [sessionId, snapshot] as const;
      } catch (error) {
        log.debug('Shared session store lookup failed while listing sessions', {
          sessionId,
          error: getErrorMessage(error),
        });
        return null;
      }
    }),
  );

  const runtimeSessionMap = new Map<string, RuntimeSessionListSnapshot>();
  for (const entry of liveEntries) {
    if (entry) {
      runtimeSessionMap.set(entry[0], entry[1]);
    }
  }

  return runtimeSessionMap;
}

import { createLogger } from '@abl/compiler/platform';
import { isDatabaseAvailable } from '../db/index.js';
import { updateSession } from '../repos/session-repo.js';
import { getStores } from './stores/index.js';
import { getTraceStore } from './trace-store.js';
import { flushMessageQueue } from './message-persistence-queue.js';
import {
  getExecutionCoordinator,
  isCoordinatorAvailable,
} from './execution/coordinator-singleton.js';

const log = createLogger('session-reset');

const RESET_SUMMARY_ZERO_FIELDS = {
  messageCount: 0,
  tokenCount: 0,
  estimatedCost: 0,
  errorCount: 0,
  handoffCount: 0,
  traceEventCount: 0,
  status: 'active',
  disposition: null,
  endedAt: null,
};
const WAIT_FOR_LOCAL_MUTATION_SETTING = 'SETTINGS mutations_sync = 1';

let clickHouseModulePromise:
  | Promise<typeof import('@agent-platform/database/clickhouse')>
  | undefined;

function loadClickHouseModule() {
  if (!clickHouseModulePromise) {
    clickHouseModulePromise = import('@agent-platform/database/clickhouse');
  }
  return clickHouseModulePromise;
}

async function deletePersistedPlatformEvents(sessionId: string, tenantId: string): Promise<void> {
  try {
    const { getClickHouseClient } = await loadClickHouseModule();
    const client = getClickHouseClient();
    if (!client) return;

    await Promise.all([
      client.command({
        query: `
          ALTER TABLE abl_platform.platform_events DELETE
          WHERE tenant_id = {tenantId:String} AND session_id = {sessionId:String}
          ${WAIT_FOR_LOCAL_MUTATION_SETTING}
        `,
        query_params: { tenantId, sessionId },
      }),
      client.command({
        query: `
          ALTER TABLE abl_platform.platform_events_by_session DELETE
          WHERE tenant_id = {tenantId:String} AND session_id = {sessionId:String}
          ${WAIT_FOR_LOCAL_MUTATION_SETTING}
        `,
        query_params: { tenantId, sessionId },
      }),
    ]);
  } catch (error) {
    log.warn('Failed to delete persisted platform events during session reset', {
      sessionId,
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function deleteClickHouseMessages(sessionId: string, tenantId: string): Promise<void> {
  if (process.env.USE_MONGO_CLICKHOUSE !== 'true') {
    return;
  }

  try {
    const { getClickHouseClient } = await loadClickHouseModule();
    const client = getClickHouseClient();
    if (!client) return;

    await client.command({
      query: `
        ALTER TABLE abl_platform.messages DELETE
        WHERE tenant_id = {tenantId:String} AND session_id = {sessionId:String}
        ${WAIT_FOR_LOCAL_MUTATION_SETTING}
      `,
      query_params: { tenantId, sessionId },
    });
  } catch (error) {
    log.warn('Failed to delete ClickHouse messages during session reset', {
      sessionId,
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function clearLiveTraceArtifacts(sessionId: string): Promise<void> {
  try {
    const traceStore = getTraceStore();
    traceStore.clearSession?.(sessionId);
    await Promise.resolve(traceStore.removeSession(sessionId));
  } catch (error) {
    log.warn('Failed to clear live trace artifacts during session reset', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function finalizeSessionReset(params: {
  sessionId: string;
  tenantId: string;
  resetAt?: Date;
  persistRuntimeSession?: () => Promise<void>;
}): Promise<void> {
  const { sessionId, tenantId, persistRuntimeSession } = params;
  const resetAt = params.resetAt ?? new Date();

  if (isCoordinatorAvailable()) {
    try {
      await getExecutionCoordinator().cancelSession(sessionId);
    } catch (error) {
      log.warn('Failed to cancel active executions before session reset', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    await flushMessageQueue(sessionId);
  } catch (error) {
    log.warn('Failed to flush queued message persistence before session reset', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (persistRuntimeSession) {
    await persistRuntimeSession();
  }

  if (isDatabaseAvailable()) {
    const messageStore = getStores().message as {
      deleteBySession: (sessionId: string) => Promise<number>;
    };
    await Promise.all([
      messageStore.deleteBySession(sessionId),
      updateSession(
        sessionId,
        {
          ...RESET_SUMMARY_ZERO_FIELDS,
          startedAt: resetAt,
          lastActivityAt: resetAt,
        },
        tenantId,
      ),
    ]);
  }

  await clearLiveTraceArtifacts(sessionId);
  await deleteClickHouseMessages(sessionId, tenantId);
  await deletePersistedPlatformEvents(sessionId, tenantId);
}

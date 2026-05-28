/**
 * Tool Audit Logger (Runtime Implementation)
 *
 * Implements ToolAuditLogger backed by AuditStore interface.
 * Routes through the shared audit store singleton.
 * Action format: `tool:<toolName>`
 */

import type { ToolAuditLogger, ToolAuditEntry } from '@abl/compiler/platform';
import type { AuditStore } from '@abl/compiler/platform/stores/audit-store.js';
import { redactEndpoint } from '@abl/compiler/platform';
import { createLogger } from '@abl/compiler/platform';
import { getRuntimeAuditEnvironment } from './audit-environment.js';

const log = createLogger('tool-audit-logger');
const NON_CREDENTIAL_AUTH_TYPES = new Set(['none', 'anonymous', 'public']);

function shouldWriteToolAudit(entry: ToolAuditEntry): boolean {
  if (entry.source === 'test') {
    return false;
  }

  const authType = entry.authType?.toLowerCase();
  const usesCredential = Boolean(authType && !NON_CREDENTIAL_AUTH_TYPES.has(authType));
  const callsExternalEndpoint = Boolean(entry.endpoint);

  return usesCredential || callsExternalEndpoint || !entry.success;
}

/**
 * AuditStore-backed tool audit logger.
 * Writes structured audit events via AuditStore.log() for credentialed,
 * external-endpoint, or failed tool calls.
 */
export class ToolAuditLoggerImpl implements ToolAuditLogger {
  constructor(private store: AuditStore) {}

  async logToolAudit(entry: ToolAuditEntry): Promise<void> {
    if (!shouldWriteToolAudit(entry)) {
      return;
    }

    try {
      await this.store.log({
        eventType: 'tool.executed',
        actor: entry.userId ?? 'system',
        actorType: entry.userId ? 'user' : 'system',
        resourceType: 'tool',
        resourceId: entry.toolName,
        environment: getRuntimeAuditEnvironment(),
        action: `tool:${entry.toolName}`,
        metadata: {
          toolType: entry.toolType,
          success: entry.success,
          latencyMs: entry.latencyMs,
          inputHash: entry.inputHash,
          authType: entry.authType,
          sessionId: entry.sessionId,
          tenantId: entry.tenantId,
          source: entry.source,
          callerContext: entry.callerContext,
          workflowId: entry.workflowId,
          workflowVersionId: entry.workflowVersionId,
          workflowVersion: entry.workflowVersion,
          endpoint: entry.endpoint ? redactEndpoint(entry.endpoint) : undefined,
          errorMessage: entry.errorMessage,
        },
      });
    } catch (error) {
      log.error('Failed to persist tool audit log', {
        toolName: entry.toolName,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}

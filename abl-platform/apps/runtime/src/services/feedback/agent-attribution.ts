/**
 * Agent attribution lookup for feedback.
 *
 * Reads `agentName` off the persisted message row resolved through the
 * abstract `MessageStore` — feedback never reaches into Mongo or CH directly,
 * so the service stays storage-agnostic (and unit-testable against the
 * in-memory store).
 *
 * Phase 2 (ABLP-1068) made `agentName` a first-class column on
 * `abl_platform.messages` and a top-level Mongo schema field, so this lookup
 * is reliable post-deploy. Pre-Phase-2 rows fall back to `metadata.agentName`
 * before defaulting to ''.
 */

import type { MessageStore } from '@abl/compiler/platform/stores/message-store.js';
import type { Message } from '@abl/compiler/platform/core/types';

export interface ResolvedTarget {
  message: Message;
  agentName: string;
}

export async function resolveTarget(
  messageStore: MessageStore,
  tenantId: string,
  projectId: string,
  sessionId: string,
  messageId: string,
): Promise<ResolvedTarget | null> {
  const message = await messageStore.getMessageById(tenantId, projectId, sessionId, messageId);
  if (!message) return null;
  const agentName = extractAgentName(message);
  return { message, agentName };
}

function extractAgentName(message: Message): string {
  const fromMetadata = message.metadata?.agentName;
  if (typeof fromMetadata === 'string' && fromMetadata.length > 0) {
    return fromMetadata;
  }
  return '';
}

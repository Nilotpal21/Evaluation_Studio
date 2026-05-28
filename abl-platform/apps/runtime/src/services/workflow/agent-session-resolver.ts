/**
 * Agent session resolver — bridges RuntimeSession into the AgentSession
 * projection emitted to workflows. Two responsibilities:
 *
 *  1. Translate `Session.source` (resolved via the stored-session helper)
 *     into the workflow projection enum (`public | channel | studio-debug`).
 *     The stored helper returns `studio` for in-Studio debug sessions; the
 *     workflow projection uses `studio-debug` to make it unambiguous to
 *     workflow authors that they are NOT seeing a real end-user session.
 *
 *  2. Derive `endUserId` from the resolved source. `customerId`/`anonymousId`
 *     fall through to `endUserId` per `buildStoredSessionAccessSource`'s
 *     existing precedence rules; we don't reimplement those here.
 *
 * The `startedAt` / `lastActivityAt` ISO strings are passed through from the
 * runtime — typically the session-creation timestamp and "now" at executor
 * construction. This is a snapshot, not a live tap, so workflows that want
 * fresher activity timestamps must take them from the per-call params.
 */

import { buildStoredSessionAccessSource } from '../identity/stored-session-access-source.js';
import type { CallerContext } from '@agent-platform/shared-kernel';

import type { AgentSessionProjectionInput } from './workflow-tool-executor.js';

export interface ResolveAgentSessionInput {
  sessionId: string;
  agentName: string;
  callerContext?: CallerContext;
  /** Falls back to callerContext.channel when omitted. */
  channelType?: string;
  /** Optional locale (e.g., en-US). Pulled from callerData where available. */
  locale?: string;
  startedAt: string;
  lastActivityAt: string;
}

/**
 * Build an AgentSession projection input from a RuntimeSession-like shape.
 * Returns undefined when the input lacks the minimum identifiers — workflows
 * triggered without a recognizable agent context shouldn't emit a projection.
 */
export function resolveAgentSessionProjection(
  input: ResolveAgentSessionInput,
): AgentSessionProjectionInput | undefined {
  const channel = input.channelType ?? input.callerContext?.channel;
  if (!input.sessionId || !input.agentName || !channel) return undefined;
  const stored = buildStoredSessionAccessSource({
    channel: input.callerContext?.channel,
    initiatedById: input.callerContext?.initiatedById,
    contactId: input.callerContext?.contactId,
    customerId: input.callerContext?.customerId,
    anonymousId: input.callerContext?.anonymousId,
    channelId: input.callerContext?.channelId,
  });
  let source: 'public' | 'channel' | 'studio-debug';
  let endUserId: string | undefined;
  if (stored.type === 'studio') {
    source = 'studio-debug';
    endUserId = undefined;
  } else if (stored.type === 'channel') {
    source = 'channel';
    endUserId = typeof stored.endUserId === 'string' ? stored.endUserId : undefined;
  } else {
    source = 'public';
    endUserId = typeof stored.endUserId === 'string' ? stored.endUserId : undefined;
  }
  return {
    sessionId: input.sessionId,
    agentName: input.agentName,
    channel,
    source,
    ...(endUserId ? { endUserId } : {}),
    ...(input.locale ? { locale: input.locale } : {}),
    startedAt: input.startedAt,
    lastActivityAt: input.lastActivityAt,
  };
}

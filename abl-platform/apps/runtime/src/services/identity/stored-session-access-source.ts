import type { SessionAccessSource } from '@agent-platform/shared-auth';

export interface StoredSessionAccessSourceCandidate {
  source?: unknown;
  channel?: unknown;
  initiatedById?: unknown;
  contactId?: unknown;
  customerId?: unknown;
  anonymousId?: unknown;
  channelId?: unknown;
}

function normalizeStoredSource(source: unknown): SessionAccessSource | undefined {
  if (!source || typeof source !== 'object') {
    return undefined;
  }

  const candidate = source as Record<string, unknown>;
  if (candidate.type === 'studio') {
    return {
      type: 'studio',
      workspaceUserId:
        typeof candidate.workspaceUserId === 'string' ? candidate.workspaceUserId : undefined,
    };
  }

  if (candidate.type === 'channel') {
    return {
      type: 'channel',
      channelId: typeof candidate.channelId === 'string' ? candidate.channelId : undefined,
      contactId: typeof candidate.contactId === 'string' ? candidate.contactId : undefined,
      endUserId: typeof candidate.endUserId === 'string' ? candidate.endUserId : undefined,
    };
  }

  if (candidate.type === 'public') {
    return {
      type: 'public',
      contactId: typeof candidate.contactId === 'string' ? candidate.contactId : undefined,
      endUserId: typeof candidate.endUserId === 'string' ? candidate.endUserId : undefined,
    };
  }

  return undefined;
}

export function buildStoredSessionAccessSource(
  session: StoredSessionAccessSourceCandidate,
): SessionAccessSource {
  const normalized = normalizeStoredSource(session.source);
  if (normalized) {
    return normalized;
  }

  if (session.channel === 'web_debug') {
    return {
      type: 'studio',
      workspaceUserId:
        typeof session.initiatedById === 'string' ? session.initiatedById : undefined,
    };
  }

  const endUserId =
    typeof session.customerId === 'string'
      ? session.customerId
      : typeof session.anonymousId === 'string'
        ? session.anonymousId
        : undefined;

  if (typeof session.channelId === 'string') {
    return {
      type: 'channel',
      channelId: session.channelId,
      contactId: typeof session.contactId === 'string' ? session.contactId : undefined,
      endUserId,
    };
  }

  return {
    type: 'public',
    contactId: typeof session.contactId === 'string' ? session.contactId : undefined,
    endUserId,
  };
}

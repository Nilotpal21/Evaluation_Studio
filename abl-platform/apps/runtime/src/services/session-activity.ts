type DateLike = Date | string | null | undefined;

type PersistedSessionActivitySnapshot = {
  messageCount?: number | null;
  traceEventCount?: number | null;
  tokenCount?: number | null;
  errorCount?: number | null;
  handoffCount?: number | null;
  hasAttachment?: boolean;
  hasPersistedMessage?: boolean;
};

export const ACTIVE_OR_IDLE_SESSION_STATUSES = ['active', 'idle'];
export const RECENTLY_TERMINATED_SESSION_STATUSES = [
  'ended',
  'abandoned',
  'completed',
  'error',
  'escalated',
];
export const SESSION_ACTIVITY_GRACE_MS = 5 * 60 * 1000;

function isPositiveCount(value: number | null | undefined): boolean {
  return typeof value === 'number' && value > 0;
}

function toDate(value: DateLike): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

export function getSessionActivityGraceCutoff(nowMs = Date.now()): Date {
  return new Date(nowMs - SESSION_ACTIVITY_GRACE_MS);
}

export function isWithinSessionActivityGraceWindow(value: DateLike, nowMs = Date.now()): boolean {
  const date = toDate(value);
  if (!date) {
    return false;
  }

  return date.getTime() >= nowMs - SESSION_ACTIVITY_GRACE_MS;
}

export function hasPersistedSessionActivity(session: PersistedSessionActivitySnapshot): boolean {
  return (
    Boolean(session.hasPersistedMessage) ||
    Boolean(session.hasAttachment) ||
    isPositiveCount(session.messageCount) ||
    isPositiveCount(session.traceEventCount) ||
    isPositiveCount(session.tokenCount) ||
    isPositiveCount(session.errorCount) ||
    isPositiveCount(session.handoffCount)
  );
}

export function buildLiveSessionVisibilityFilter(nowMs: number): Record<string, unknown> {
  const recentTerminationCutoff = getSessionActivityGraceCutoff(nowMs);

  return {
    $or: [
      { status: { $in: ACTIVE_OR_IDLE_SESSION_STATUSES } },
      { messageCount: { $gt: 0 } },
      { traceEventCount: { $gt: 0 } },
      {
        $and: [
          { status: { $in: RECENTLY_TERMINATED_SESSION_STATUSES } },
          { endedAt: { $gte: recentTerminationCutoff } },
        ],
      },
    ],
  };
}

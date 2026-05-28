export interface JournalMutationEntry {
  id: string;
  timestamp: string;
  agentName: string;
  from: string;
  to: string;
}

export interface UndoPayload {
  agentName: string;
  code: string;
}

export const DEFAULT_UNDO_WINDOW_MS = 5 * 60 * 1000;

export function canUndo(
  entry: JournalMutationEntry,
  windowMs = DEFAULT_UNDO_WINDOW_MS,
  nowMs = Date.now(),
): boolean {
  const timestampMs = Date.parse(entry.timestamp);
  if (!Number.isFinite(timestampMs)) {
    return false;
  }

  const ageMs = nowMs - timestampMs;
  return ageMs >= 0 && ageMs <= windowMs;
}

export function computeUndoPayload(entry: JournalMutationEntry): UndoPayload {
  return {
    agentName: entry.agentName,
    code: entry.from,
  };
}

export function conflictsWithSubsequent(
  target: JournalMutationEntry,
  journal: JournalMutationEntry[],
): boolean {
  const targetTimestampMs = Date.parse(target.timestamp);
  if (!Number.isFinite(targetTimestampMs)) {
    return true;
  }

  return journal.some((entry) => {
    if (entry.id === target.id || entry.agentName !== target.agentName) {
      return false;
    }

    const entryTimestampMs = Date.parse(entry.timestamp);
    return Number.isFinite(entryTimestampMs) && entryTimestampMs > targetTimestampMs;
  });
}

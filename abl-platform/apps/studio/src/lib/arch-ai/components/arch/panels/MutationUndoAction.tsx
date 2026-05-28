'use client';

import { useEffect, useMemo, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { authHeaders } from '@/lib/api-client';
import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';
import type { ModificationProposal } from '@/lib/arch-ai/types/arch';
import {
  canUndo,
  computeUndoPayload,
  conflictsWithSubsequent,
  DEFAULT_UNDO_WINDOW_MS,
  type JournalMutationEntry,
} from '@/lib/arch-ai/journal/undo';
import {
  getAppliedMutationHistory,
  recordAppliedMutationForUndo,
  recordUndoMutation,
} from '@/lib/arch-ai/ui/proposal-artifacts';

interface MutationUndoActionProps {
  projectId?: string;
  proposal: ModificationProposal;
}

type UndoState = 'idle' | 'applying' | 'applied' | 'failed';

export function MutationUndoAction({ projectId, proposal }: MutationUndoActionProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [state, setState] = useState<UndoState>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timerId = window.setInterval(() => setNowMs(Date.now()), 15_000);
    return () => window.clearInterval(timerId);
  }, []);

  const undoEntry = useMemo(() => resolveUndoEntry(proposal), [proposal]);
  if (!undoEntry) {
    return null;
  }

  const history = getAppliedMutationHistory();
  const isExpired = !canUndo(undoEntry, DEFAULT_UNDO_WINDOW_MS, nowMs);
  const hasConflict = conflictsWithSubsequent(undoEntry, history);
  const disabled =
    !projectId || isExpired || hasConflict || state === 'applying' || state === 'applied';
  const disabledReason = !projectId
    ? 'Project context is unavailable.'
    : isExpired
      ? 'Undo window expired.'
      : hasConflict
        ? 'A later edit touched this agent.'
        : null;

  const handleUndo = async () => {
    if (disabled || !projectId) {
      return;
    }

    setState('applying');
    setError(null);
    try {
      const payload = computeUndoPayload(undoEntry);
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(payload.agentName)}/dsl`,
        {
          method: 'PUT',
          headers: {
            ...authHeaders(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ dslContent: payload.code }),
        },
      );

      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }

      recordUndoMutation(undoEntry);
      useArchAIStore.getState().setLastAgentEdit();
      setState('applied');
    } catch (err) {
      setState('failed');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <button
        type="button"
        data-testid="arch-undo-button"
        disabled={disabled}
        onClick={() => void handleUndo()}
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 font-medium text-foreground-muted transition-colors hover:border-accent/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        title={disabledReason ?? 'Undo this applied agent change'}
      >
        <RotateCcw className="h-3.5 w-3.5" />
        {state === 'applying' ? 'Undoing' : state === 'applied' ? 'Undone' : 'Undo'}
      </button>
      {disabledReason && state !== 'applied' && (
        <span className="text-[11px] text-foreground-subtle">{disabledReason}</span>
      )}
      {error && <span className="text-[11px] text-error">{error}</span>}
    </div>
  );
}

function resolveUndoEntry(proposal: ModificationProposal): JournalMutationEntry | null {
  const historyEntry = getAppliedMutationHistory().find(
    (entry) =>
      entry.agentName === proposal.agentName &&
      entry.from === proposal.currentCode &&
      entry.to === proposal.proposedCode,
  );
  if (historyEntry) {
    return historyEntry;
  }

  return recordAppliedMutationForUndo(proposal);
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string | { message?: string } };
    if (typeof body.error === 'string') {
      return body.error;
    }
    if (body.error?.message) {
      return body.error.message;
    }
  } catch {
    // fall through to status text
  }

  return `Undo failed (${response.status})`;
}

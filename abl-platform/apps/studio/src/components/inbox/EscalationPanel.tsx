'use client';

/**
 * EscalationPanel Component
 *
 * Shows escalation context (conversation transcript, reason) and provides
 * a quick resolve action for the assigned human reviewer.
 */

import { useState, useCallback } from 'react';
import clsx from 'clsx';
import type { HumanTask } from '../../api/human-tasks';
import { Button } from '../ui/Button';

interface EscalationPanelProps {
  task: HumanTask;
  onResolve: (notes: string) => void;
  resolving?: boolean;
}

export function EscalationPanel({ task, onResolve, resolving }: EscalationPanelProps) {
  const [notes, setNotes] = useState('');

  const handleQuickResolve = useCallback(() => {
    if (!notes.trim()) return;
    onResolve(notes.trim());
  }, [notes, onResolve]);

  return (
    <div className="space-y-4">
      {/* Context */}
      <div className="rounded-lg border border-default bg-background-muted p-3">
        <p className="text-xs font-medium text-muted mb-1">Escalation Reason</p>
        <p className="text-sm text-foreground">
          {(task.context.escalationReason as string) ?? task.description ?? 'No reason provided'}
        </p>
        {task.context.agentName ? (
          <p className="text-xs text-muted mt-2">
            Agent: <span className="text-foreground">{String(task.context.agentName)}</span>
          </p>
        ) : null}
      </div>

      <div className="space-y-3">
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={4}
          placeholder="Enter your response to resolve this escalation..."
          className={clsx(
            'w-full px-3 py-2 text-sm rounded-lg border border-default',
            'bg-background-muted text-foreground placeholder:text-muted',
            'focus:outline-none focus:ring-2 focus:ring-border-focus/40 resize-none',
          )}
        />
        <Button
          variant="primary"
          size="sm"
          onClick={handleQuickResolve}
          loading={resolving}
          disabled={!notes.trim()}
        >
          Resolve Escalation
        </Button>
      </div>
    </div>
  );
}

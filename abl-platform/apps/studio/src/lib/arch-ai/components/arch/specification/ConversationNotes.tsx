'use client';

import type { ConversationNote } from '@agent-platform/arch-ai';

interface ConversationNotesProps {
  notes: ConversationNote[];
}

/**
 * ConversationNotes — displays structured notes extracted from chat.
 * S1-F12 req 6-9: icon, label, detail, category.
 * Contract 3: conversationNotes[] in specification.
 */
export function ConversationNotes({ notes }: ConversationNotesProps) {
  if (notes.length === 0) return null;

  return (
    <div>
      <label className="text-xs font-medium text-foreground-muted">Notes from conversation</label>
      <div className="mt-1 flex flex-col gap-1.5">
        {notes.map((note, i) => (
          <div
            key={`${note.label}-${i}`}
            className="flex items-start gap-2 rounded-lg border border-border/50 bg-background-muted/20 px-3 py-2 text-sm"
          >
            <span className="flex-shrink-0">{note.icon}</span>
            <div className="min-w-0">
              <span className="font-medium text-foreground">{note.label}</span>
              <span className="text-foreground-muted"> — {note.detail}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

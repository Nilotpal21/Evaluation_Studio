'use client';

/**
 * BehaviorEditor
 *
 * Reuses the structured Conversation Behavior editor for the unified
 * agent editor. This is the live authoring surface routed from AppShell,
 * so the editor must round-trip the baseline `CONVERSATION:` block and
 * attached `USE BEHAVIOR_PROFILE:` refs through the section save adapter.
 */

import { BehaviorSection } from '../../agent-detail/BehaviorSection';
import type { SectionEditorProps } from '../types';

export function BehaviorEditor({ data, onChange, onArchClick }: SectionEditorProps<'behavior'>) {
  return (
    <div className="h-full overflow-y-auto p-4">
      <BehaviorSection
        data={data}
        isExpanded
        onToggle={() => {}}
        onChange={onChange}
        onArchClick={onArchClick}
      />
    </div>
  );
}

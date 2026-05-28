'use client';

/**
 * OnStartEditor -- section editor for agent on_start lifecycle hook.
 *
 * Renders: enable/disable toggle, respond message, call action, hooks display.
 * Variable sets are shown as info text (editable in Definition tab).
 */

import { useCallback } from 'react';
import { Play, Webhook, Zap } from 'lucide-react';
import { Toggle } from '../../ui/Toggle';
import type { SectionEditorProps } from '../types';
import { SectionHeader } from './SectionHeader';
import { SubSection, Field, textareaClasses } from './FieldPrimitives';

export function OnStartEditor({
  data,
  onChange,
  readOnly,
  onArchClick,
}: SectionEditorProps<'onStart'>) {
  const handleRespondChange = useCallback(
    (value: string) => {
      onChange({ ...data, respond: value || undefined });
    },
    [data, onChange],
  );

  const handleCallChange = useCallback(
    (value: string) => {
      onChange({ ...data, onStartCall: value || undefined });
    },
    [data, onChange],
  );

  const handleToggle = useCallback(() => {
    onChange({ ...data, hasOnStart: !data.hasOnStart });
  }, [data, onChange]);

  return (
    <div className="p-5 overflow-y-auto h-full">
      <SectionHeader onArchClick={onArchClick} />

      {/* Enable/Disable toggle */}
      <SubSection title="On Start" first>
        <Field label="Enable ON_START">
          <div className="flex items-center gap-3">
            <Toggle checked={data.hasOnStart} onChange={handleToggle} disabled={readOnly} />
            <span className="text-xs text-foreground-muted">
              {data.hasOnStart ? 'Agent sends initial message on start' : 'No startup action'}
            </span>
          </div>
        </Field>

        {data.hasOnStart && (
          <>
            {/* Respond message */}
            <Field label="Initial Message">
              <div className="flex items-start gap-2">
                <Play className="w-3.5 h-3.5 mt-2 text-foreground-muted shrink-0" />
                <textarea
                  value={data.respond ?? ''}
                  onChange={(e) => handleRespondChange(e.target.value)}
                  readOnly={readOnly}
                  rows={3}
                  placeholder="Message to send when the agent starts..."
                  className={textareaClasses}
                />
              </div>
            </Field>

            {/* Call action */}
            <Field label="Tool Call on Start">
              <div className="flex items-center gap-2">
                <Zap className="w-3.5 h-3.5 text-foreground-muted shrink-0" />
                {readOnly ? (
                  <span className="font-mono text-sm text-foreground">
                    {data.onStartCall || (
                      <span className="text-foreground-subtle italic">None</span>
                    )}
                  </span>
                ) : (
                  <input
                    type="text"
                    value={data.onStartCall ?? ''}
                    onChange={(e) => handleCallChange(e.target.value)}
                    placeholder="tool_name"
                    className="w-full text-sm text-foreground bg-transparent placeholder:text-foreground-subtle focus:outline-none font-mono border-b border-default/50 pb-1"
                  />
                )}
              </div>
            </Field>
          </>
        )}
      </SubSection>

      {/* Variable sets info */}
      {data.sets.length > 0 && (
        <p className="text-xs text-foreground-subtle italic mt-4">
          This agent also has {data.sets.length} variable set{data.sets.length > 1 ? 's' : ''} on
          start — edit in the Definition tab.
        </p>
      )}

      {/* Hooks display (read-only) */}
      {data.hooks.length > 0 && (
        <SubSection title="Hooks">
          <div className="flex items-center gap-2 mb-2">
            <Webhook className="w-4 h-4 text-accent" />
            <span className="text-xs text-foreground-muted">{data.hooks.length} configured</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {data.hooks.map((hook) => (
              <span
                key={hook}
                className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-medium bg-accent-subtle text-accent"
              >
                {hook}
              </span>
            ))}
          </div>
        </SubSection>
      )}
    </div>
  );
}

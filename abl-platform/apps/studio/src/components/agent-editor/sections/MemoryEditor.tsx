'use client';

/**
 * MemoryEditor -- section editor for agent memory configuration.
 *
 * Renders session variables, persistent paths, remember triggers,
 * and recall instructions. No accordion wrapper.
 */

import React, { useState, useCallback, type KeyboardEvent } from 'react';
import { X, Plus, Database, Brain, BookOpen, HardDrive } from 'lucide-react';
import clsx from 'clsx';
import type { SectionEditorProps, MemorySectionData } from '../types';
import { SectionHeader } from './SectionHeader';

// =============================================================================
// SHARED STYLES
// =============================================================================

const inputClasses =
  'w-full px-2 py-1.5 text-xs rounded-md bg-background border border-default text-foreground placeholder:text-foreground-subtle focus:outline-none focus:ring-2 focus:ring-border-focus/40 focus:border-border-focus transition-default';

const textareaClasses = clsx(inputClasses, 'resize-y');

const addBtnClasses =
  'inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-accent hover:bg-accent-subtle border border-accent/30 transition-default';

const removeBtnClasses =
  'p-1 rounded hover:bg-error-subtle text-foreground-muted hover:text-error transition-default';

const cardClasses =
  'rounded-lg border border-default bg-background-muted overflow-hidden shadow-sm';

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

function SubSectionHeader({ title }: { title: string }) {
  return (
    <h4 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider mb-2">
      {title}
    </h4>
  );
}

function Tag({
  text,
  onRemove,
  readOnly,
}: {
  text: string;
  onRemove: () => void;
  readOnly?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-background border border-default">
      <span className="font-mono">{text}</span>
      {!readOnly && (
        <button
          type="button"
          aria-label={`Remove: ${text}`}
          onClick={onRemove}
          className="p-0.5 rounded hover:bg-error/10 hover:text-error transition-fast"
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </span>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function MemoryEditor({
  data,
  onChange,
  readOnly,
  onArchClick,
}: SectionEditorProps<'memory'>) {
  const [newPath, setNewPath] = useState('');

  // ---------------------------------------------------------------------------
  // Session Variables
  // ---------------------------------------------------------------------------

  const addSessionVar = useCallback(() => {
    onChange({
      ...data,
      sessionVars: [...data.sessionVars, { name: '', type: 'string', description: '' }],
    });
  }, [data, onChange]);

  const updateSessionVar = useCallback(
    (index: number, field: keyof MemorySectionData['sessionVars'][number], value: string) => {
      const updated = data.sessionVars.map((sv, i) =>
        i === index ? { ...sv, [field]: value } : sv,
      );
      onChange({ ...data, sessionVars: updated });
    },
    [data, onChange],
  );

  const removeSessionVar = useCallback(
    (index: number) => {
      onChange({
        ...data,
        sessionVars: data.sessionVars.filter((_, i) => i !== index),
      });
    },
    [data, onChange],
  );

  // ---------------------------------------------------------------------------
  // Persistent Paths
  // ---------------------------------------------------------------------------

  const addPath = useCallback(() => {
    const trimmed = newPath.trim();
    if (trimmed && !data.persistentPaths.includes(trimmed)) {
      onChange({
        ...data,
        persistentPaths: [...data.persistentPaths, trimmed],
      });
      setNewPath('');
    }
  }, [newPath, data, onChange]);

  const handlePathKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addPath();
      }
    },
    [addPath],
  );

  const removePath = useCallback(
    (index: number) => {
      onChange({
        ...data,
        persistentPaths: data.persistentPaths.filter((_, i) => i !== index),
      });
    },
    [data, onChange],
  );

  // ---------------------------------------------------------------------------
  // Remember Triggers
  // ---------------------------------------------------------------------------

  const addRememberTrigger = useCallback(() => {
    onChange({
      ...data,
      rememberTriggers: [...data.rememberTriggers, { when: '', store: { value: '', target: '' } }],
    });
  }, [data, onChange]);

  const updateRememberTrigger = useCallback(
    (index: number, update: Partial<MemorySectionData['rememberTriggers'][number]>) => {
      const updated = data.rememberTriggers.map((rt, i) =>
        i === index ? { ...rt, ...update } : rt,
      );
      onChange({ ...data, rememberTriggers: updated });
    },
    [data, onChange],
  );

  const removeRememberTrigger = useCallback(
    (index: number) => {
      onChange({
        ...data,
        rememberTriggers: data.rememberTriggers.filter((_, i) => i !== index),
      });
    },
    [data, onChange],
  );

  // ---------------------------------------------------------------------------
  // Recall Instructions
  // ---------------------------------------------------------------------------

  const addRecallInstruction = useCallback(() => {
    onChange({
      ...data,
      recallInstructions: [...data.recallInstructions, { event: '', instruction: '' }],
    });
  }, [data, onChange]);

  const updateRecallInstruction = useCallback(
    (
      index: number,
      field: keyof MemorySectionData['recallInstructions'][number],
      value: string,
    ) => {
      const updated = data.recallInstructions.map((ri, i) =>
        i === index ? { ...ri, [field]: value } : ri,
      );
      onChange({ ...data, recallInstructions: updated });
    },
    [data, onChange],
  );

  const removeRecallInstruction = useCallback(
    (index: number) => {
      onChange({
        ...data,
        recallInstructions: data.recallInstructions.filter((_, i) => i !== index),
      });
    },
    [data, onChange],
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full">
      <SectionHeader onArchClick={onArchClick} />
      {/* Session Variables */}
      <section>
        <SubSectionHeader title="Session Variables" />
        <div className="space-y-2">
          {data.sessionVars.map((sv, index) => (
            <div key={index} className={clsx(cardClasses, 'p-3')}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 space-y-2">
                  <input
                    type="text"
                    value={sv.name}
                    onChange={(e) => updateSessionVar(index, 'name', e.target.value)}
                    readOnly={readOnly}
                    placeholder="Variable name"
                    className={clsx(inputClasses, 'font-mono')}
                  />
                  <input
                    type="text"
                    value={sv.type ?? ''}
                    onChange={(e) => updateSessionVar(index, 'type', e.target.value)}
                    readOnly={readOnly}
                    placeholder="Type (optional)"
                    className={inputClasses}
                  />
                  <input
                    type="text"
                    value={sv.description ?? ''}
                    onChange={(e) => updateSessionVar(index, 'description', e.target.value)}
                    readOnly={readOnly}
                    placeholder="Description (optional)"
                    className={inputClasses}
                  />
                </div>
                {!readOnly && (
                  <button
                    type="button"
                    aria-label="Remove variable"
                    onClick={() => removeSessionVar(index)}
                    className={removeBtnClasses}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))}

          {data.sessionVars.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Database className="w-5 h-5 text-foreground-muted/40 mb-2" />
              <p className="text-xs text-foreground-subtle">No session variables defined</p>
              <p className="text-xs text-foreground-subtle mt-0.5">
                Variables stored for the duration of a session
              </p>
              {!readOnly && (
                <button
                  type="button"
                  onClick={addSessionVar}
                  className="inline-flex items-center gap-1.5 mt-3 px-3 py-1.5 rounded-md text-xs font-medium text-accent border border-accent/30 hover:bg-accent-subtle transition-default"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add Variable
                </button>
              )}
            </div>
          ) : (
            !readOnly && (
              <button type="button" onClick={addSessionVar} className={addBtnClasses}>
                <Plus className="w-3 h-3" />
                Add Variable
              </button>
            )
          )}
        </div>
      </section>

      {/* Persistent Paths */}
      <section>
        <SubSectionHeader title="Persistent Paths" />
        <div className="space-y-2">
          {data.persistentPaths.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {data.persistentPaths.map((path, index) => (
                <Tag
                  key={`${path}-${index}`}
                  text={path}
                  onRemove={() => removePath(index)}
                  readOnly={readOnly}
                />
              ))}
            </div>
          )}

          {data.persistentPaths.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <HardDrive className="w-5 h-5 text-foreground-muted/40 mb-2" />
              <p className="text-xs text-foreground-subtle">No persistent paths defined</p>
              <p className="text-xs text-foreground-subtle mt-0.5">
                Dotted paths that persist across sessions
              </p>
              {!readOnly && (
                <div className="flex items-center gap-2 mt-3 w-full max-w-xs">
                  <input
                    type="text"
                    value={newPath}
                    onChange={(e) => setNewPath(e.target.value)}
                    onKeyDown={handlePathKeyDown}
                    placeholder="Add a dotted path (e.g. user.preferences)"
                    className={clsx(inputClasses, 'flex-1 font-mono')}
                  />
                  <button
                    type="button"
                    onClick={addPath}
                    disabled={!newPath.trim()}
                    className={clsx(
                      addBtnClasses,
                      !newPath.trim() && 'opacity-40 cursor-not-allowed',
                    )}
                  >
                    <Plus className="w-3 h-3" />
                    Add
                  </button>
                </div>
              )}
            </div>
          ) : (
            !readOnly && (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={newPath}
                  onChange={(e) => setNewPath(e.target.value)}
                  onKeyDown={handlePathKeyDown}
                  placeholder="Add a dotted path (e.g. user.preferences)"
                  className={clsx(inputClasses, 'flex-1 font-mono')}
                />
                <button
                  type="button"
                  onClick={addPath}
                  disabled={!newPath.trim()}
                  className={clsx(
                    addBtnClasses,
                    !newPath.trim() && 'opacity-40 cursor-not-allowed',
                  )}
                >
                  <Plus className="w-3 h-3" />
                  Add
                </button>
              </div>
            )
          )}
        </div>
      </section>

      {/* Remember Triggers */}
      <section>
        <SubSectionHeader title="Remember Triggers" />
        <div className="space-y-2">
          {data.rememberTriggers.map((rt, index) => (
            <div key={index} className={clsx(cardClasses, 'p-3')}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 space-y-2">
                  <input
                    type="text"
                    value={rt.when}
                    onChange={(e) => updateRememberTrigger(index, { when: e.target.value })}
                    readOnly={readOnly}
                    placeholder="When condition"
                    className={inputClasses}
                  />
                  <input
                    type="text"
                    value={rt.store.value}
                    onChange={(e) =>
                      updateRememberTrigger(index, {
                        store: { ...rt.store, value: e.target.value },
                      })
                    }
                    readOnly={readOnly}
                    placeholder="Store value"
                    className={inputClasses}
                  />
                  <input
                    type="text"
                    value={rt.store.target}
                    onChange={(e) =>
                      updateRememberTrigger(index, {
                        store: { ...rt.store, target: e.target.value },
                      })
                    }
                    readOnly={readOnly}
                    placeholder="Store target"
                    className={clsx(inputClasses, 'font-mono')}
                  />
                  <input
                    type="text"
                    value={rt.ttl ?? ''}
                    onChange={(e) =>
                      updateRememberTrigger(index, {
                        ttl: e.target.value || undefined,
                      })
                    }
                    readOnly={readOnly}
                    placeholder="TTL (optional, e.g. 24h)"
                    className={inputClasses}
                  />
                </div>
                {!readOnly && (
                  <button
                    type="button"
                    aria-label="Remove trigger"
                    onClick={() => removeRememberTrigger(index)}
                    className={removeBtnClasses}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))}

          {data.rememberTriggers.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Brain className="w-5 h-5 text-foreground-muted/40 mb-2" />
              <p className="text-xs text-foreground-subtle">No remember triggers defined</p>
              <p className="text-xs text-foreground-subtle mt-0.5">
                Triggers that store data to long-term memory
              </p>
              {!readOnly && (
                <button
                  type="button"
                  onClick={addRememberTrigger}
                  className="inline-flex items-center gap-1.5 mt-3 px-3 py-1.5 rounded-md text-xs font-medium text-accent border border-accent/30 hover:bg-accent-subtle transition-default"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add Trigger
                </button>
              )}
            </div>
          ) : (
            !readOnly && (
              <button type="button" onClick={addRememberTrigger} className={addBtnClasses}>
                <Plus className="w-3 h-3" />
                Add Trigger
              </button>
            )
          )}
        </div>
      </section>

      {/* Recall Instructions */}
      <section>
        <SubSectionHeader title="Recall Instructions" />
        <div className="space-y-2">
          {data.recallInstructions.map((ri, index) => (
            <div key={index} className={clsx(cardClasses, 'p-3')}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 space-y-2">
                  <input
                    type="text"
                    value={ri.event}
                    onChange={(e) => updateRecallInstruction(index, 'event', e.target.value)}
                    readOnly={readOnly}
                    placeholder="Event (e.g. ON_START)"
                    className={clsx(inputClasses, 'font-mono')}
                  />
                  <textarea
                    value={ri.instruction}
                    onChange={(e) => updateRecallInstruction(index, 'instruction', e.target.value)}
                    readOnly={readOnly}
                    rows={2}
                    placeholder="Recall instruction..."
                    className={textareaClasses}
                  />
                </div>
                {!readOnly && (
                  <button
                    type="button"
                    aria-label="Remove instruction"
                    onClick={() => removeRecallInstruction(index)}
                    className={removeBtnClasses}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))}

          {data.recallInstructions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <BookOpen className="w-5 h-5 text-foreground-muted/40 mb-2" />
              <p className="text-xs text-foreground-subtle">No recall instructions defined</p>
              <p className="text-xs text-foreground-subtle mt-0.5">
                Instructions for retrieving data from long-term memory
              </p>
              {!readOnly && (
                <button
                  type="button"
                  onClick={addRecallInstruction}
                  className="inline-flex items-center gap-1.5 mt-3 px-3 py-1.5 rounded-md text-xs font-medium text-accent border border-accent/30 hover:bg-accent-subtle transition-default"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add Instruction
                </button>
              )}
            </div>
          ) : (
            !readOnly && (
              <button type="button" onClick={addRecallInstruction} className={addBtnClasses}>
                <Plus className="w-3 h-3" />
                Add Instruction
              </button>
            )
          )}
        </div>
      </section>
    </div>
  );
}

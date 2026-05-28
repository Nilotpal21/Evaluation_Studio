'use client';

/**
 * DefinitionEditor -- section editor for raw DSL content.
 *
 * Wraps the existing ABLEditor component. Syncs changes from the
 * editor store back to the AgentEditorStore via onChange, so that
 * the save button properly reflects unsaved DSL edits.
 */

import { useEffect, useRef } from 'react';
import ABLEditor from '../../abl/ABLEditor';
import { useEditorStore } from '../../../store/editor-store';
import type { SectionEditorProps } from '../types';
import { SectionHeader } from './SectionHeader';

export function DefinitionEditor({ onChange, onArchClick }: SectionEditorProps<'definition'>) {
  const editorDslContent = useEditorStore((s) => s.dslContent);
  const editorIsDirty = useEditorStore((s) => s.isDirty);

  // Sync editor store changes back to AgentEditorStore via onChange.
  // Use a ref to avoid calling onChange on initial mount (which would
  // immediately mark the section dirty before any user edit).
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    if (editorIsDirty) {
      onChange(editorDslContent);
    }
  }, [editorDslContent, editorIsDirty, onChange]);

  return (
    <div className="h-full flex flex-col">
      <SectionHeader onArchClick={onArchClick} />
      <ABLEditor className="flex-1" />
    </div>
  );
}

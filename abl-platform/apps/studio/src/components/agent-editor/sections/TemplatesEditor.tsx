'use client';

/**
 * TemplatesEditor -- section editor for agent response templates.
 *
 * Renders named template cards, each with format tabs for
 * Default, Markdown, HTML, and Voice output formats. No accordion wrapper.
 */

import React, { useState, useCallback } from 'react';
import { X, Plus, FileText, ChevronDown, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import type { SectionEditorProps, TemplateSectionData } from '../types';
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
// CONSTANTS
// =============================================================================

type FormatKey = 'default' | 'markdown' | 'html' | 'voiceInstructions';

const FORMAT_TABS: Array<{ key: FormatKey; label: string }> = [
  { key: 'default', label: 'Default' },
  { key: 'markdown', label: 'Markdown' },
  { key: 'html', label: 'HTML' },
  { key: 'voiceInstructions', label: 'Voice' },
];

// =============================================================================
// TEMPLATE CARD
// =============================================================================

function TemplateCard({
  template,
  index,
  onUpdate,
  onRemove,
  readOnly,
}: {
  template: TemplateSectionData;
  index: number;
  onUpdate: (index: number, updated: TemplateSectionData) => void;
  onRemove: (index: number) => void;
  readOnly?: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const [activeTab, setActiveTab] = useState<FormatKey>('default');

  return (
    <div className={cardClasses}>
      {/* Card header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-default">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 text-xs font-medium text-foreground hover:text-accent transition-default"
        >
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
          <span className="font-mono">{template.name || `Template ${index + 1}`}</span>
        </button>
        {!readOnly && (
          <button
            type="button"
            aria-label="Remove template"
            onClick={() => onRemove(index)}
            className={removeBtnClasses}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Card body */}
      {expanded && (
        <div className="p-3 space-y-2">
          {/* Template name */}
          <input
            type="text"
            value={template.name}
            onChange={(e) => onUpdate(index, { ...template, name: e.target.value })}
            readOnly={readOnly}
            placeholder="Template name"
            className={clsx(inputClasses, 'font-mono')}
          />

          {/* Format tabs */}
          <div className="flex gap-0.5 border-b border-default">
            {FORMAT_TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                className={clsx(
                  'px-2.5 py-1.5 text-xs font-medium rounded-t-md transition-default',
                  activeTab === tab.key
                    ? 'text-accent bg-accent-subtle border-b-2 border-accent'
                    : 'text-foreground-muted hover:text-foreground hover:bg-background',
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Format textarea */}
          <textarea
            value={template.formats[activeTab] ?? ''}
            onChange={(e) =>
              onUpdate(index, {
                ...template,
                formats: {
                  ...template.formats,
                  [activeTab]: e.target.value || undefined,
                },
              })
            }
            readOnly={readOnly}
            rows={5}
            placeholder={`${FORMAT_TABS.find((t) => t.key === activeTab)?.label ?? 'Template'} content...`}
            className={textareaClasses}
          />
        </div>
      )}
    </div>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function TemplatesEditor({
  data,
  onChange,
  readOnly,
  onArchClick,
}: SectionEditorProps<'templates'>) {
  const addTemplate = useCallback(() => {
    onChange([
      ...data,
      {
        name: '',
        formats: {},
      },
    ]);
  }, [data, onChange]);

  const updateTemplate = useCallback(
    (index: number, updated: TemplateSectionData) => {
      const newData = data.map((t, i) => (i === index ? updated : t));
      onChange(newData);
    },
    [data, onChange],
  );

  const removeTemplate = useCallback(
    (index: number) => {
      onChange(data.filter((_, i) => i !== index));
    },
    [data, onChange],
  );

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full">
      <SectionHeader onArchClick={onArchClick} />
      <div className="space-y-2 stagger-children">
        {data.map((template, index) => (
          <TemplateCard
            key={index}
            template={template}
            index={index}
            onUpdate={updateTemplate}
            onRemove={removeTemplate}
            readOnly={readOnly}
          />
        ))}

        {data.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <FileText className="w-5 h-5 text-foreground-muted/40 mb-2" />
            <p className="text-xs text-foreground-subtle">No templates defined</p>
            <p className="text-xs text-foreground-subtle mt-0.5">
              Response templates for consistent agent output formatting
            </p>
            {!readOnly && (
              <button
                type="button"
                onClick={addTemplate}
                className="inline-flex items-center gap-1.5 mt-3 px-3 py-1.5 rounded-md text-xs font-medium text-accent border border-accent/30 hover:bg-accent-subtle transition-default"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Template
              </button>
            )}
          </div>
        ) : (
          !readOnly && (
            <button type="button" onClick={addTemplate} className={addBtnClasses}>
              <Plus className="w-3 h-3" />
              Add Template
            </button>
          )
        )}
      </div>
    </div>
  );
}

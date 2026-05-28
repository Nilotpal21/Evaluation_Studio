/**
 * LLM Stage Config — form for LLM enrichment stages.
 *
 * i18n keys used:
 * v2_llm_model, v2_llm_model_placeholder, v2_llm_prompt_template,
 * v2_llm_prompt_placeholder, v2_llm_available_fields, v2_llm_input_fields,
 * v2_llm_input_fields_desc, v2_llm_output_field, v2_llm_output_placeholder,
 * v2_llm_advanced, v2_llm_temperature, v2_llm_max_tokens,
 * v2_llm_core_fields, v2_llm_common_fields
 */

'use client';

import { useCallback, useRef, useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Input } from '../../../../ui/Input';
import { Textarea } from '../../../../ui/Textarea';
import { Select } from '../../../../ui/Select';

interface LlmStageConfigProps {
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
}

interface CanonicalField {
  name: string;
  label: string;
  group: 'core' | 'common';
}

const CANONICAL_FIELDS: CanonicalField[] = [
  // Core
  { name: 'title', label: 'Title', group: 'core' },
  { name: 'content_summary', label: 'Content Summary', group: 'core' },
  { name: 'source_type', label: 'Source Type', group: 'core' },
  { name: 'source_url', label: 'Source URL', group: 'core' },
  { name: 'created_date', label: 'Created Date', group: 'core' },
  { name: 'modified_date', label: 'Modified Date', group: 'core' },
  { name: 'author', label: 'Author', group: 'core' },
  { name: 'language', label: 'Language', group: 'core' },
  { name: 'status', label: 'Status', group: 'core' },
  { name: 'category', label: 'Category', group: 'core' },
  // Common
  { name: 'description', label: 'Description', group: 'common' },
  { name: 'tags', label: 'Tags', group: 'common' },
  { name: 'priority', label: 'Priority', group: 'common' },
  { name: 'assignee', label: 'Assignee', group: 'common' },
  { name: 'department', label: 'Department', group: 'common' },
  { name: 'project', label: 'Project', group: 'common' },
];

export function LlmStageConfig({ config, onChange }: LlmStageConfigProps) {
  const t = useTranslations('search_ai.pipeline');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const update = useCallback(
    (key: string, value: unknown) => {
      onChange({ ...config, [key]: value });
    },
    [config, onChange],
  );

  const inputFields = useMemo(() => {
    const raw = config.inputFields;
    return Array.isArray(raw) ? (raw as string[]) : [];
  }, [config.inputFields]);

  const outputFieldOptions = useMemo(
    () => CANONICAL_FIELDS.map((f) => ({ value: f.name, label: f.label })),
    [],
  );

  const handleChipClick = useCallback(
    (fieldName: string) => {
      const el = textareaRef.current;
      const insertion = `{{${fieldName}}}`;
      if (el) {
        const start = el.selectionStart;
        const end = el.selectionEnd;
        const current = (config.promptTemplate as string) ?? '';
        const next = current.slice(0, start) + insertion + current.slice(end);
        update('promptTemplate', next);
        // Restore cursor position after insertion
        requestAnimationFrame(() => {
          el.focus();
          const pos = start + insertion.length;
          el.setSelectionRange(pos, pos);
        });
      } else {
        const current = (config.promptTemplate as string) ?? '';
        update('promptTemplate', current + insertion);
      }
    },
    [config.promptTemplate, update],
  );

  const toggleInputField = useCallback(
    (fieldName: string) => {
      const current = inputFields;
      const next = current.includes(fieldName)
        ? current.filter((f) => f !== fieldName)
        : [...current, fieldName];
      update('inputFields', next);
    },
    [inputFields, update],
  );

  const coreFields = CANONICAL_FIELDS.filter((f) => f.group === 'core');
  const commonFields = CANONICAL_FIELDS.filter((f) => f.group === 'common');

  const temperature = typeof config.temperature === 'number' ? config.temperature : 0.7;
  const maxTokens = typeof config.maxTokens === 'number' ? config.maxTokens : 1024;

  return (
    <div className="space-y-4">
      {/* Model */}
      <Input
        label={t('v2_llm_model')}
        type="text"
        value={(config.model as string) ?? ''}
        onChange={(e) => update('model', e.target.value)}
        placeholder={t('v2_llm_model_placeholder')}
      />

      {/* Prompt Template */}
      <div className="space-y-1.5">
        <label className="block text-sm font-medium text-foreground">
          {t('v2_llm_prompt_template')}
        </label>
        <div className="space-y-1.5">
          <p className="text-xs text-muted">{t('v2_llm_available_fields')}</p>
          <div className="flex flex-wrap gap-1.5">
            {CANONICAL_FIELDS.map((field) => (
              <button
                key={field.name}
                type="button"
                onClick={() => handleChipClick(field.name)}
                className="px-2 py-0.5 rounded-full bg-accent/10 text-accent text-xs cursor-pointer hover:bg-accent/20 transition-colors"
              >
                {field.label}
              </button>
            ))}
          </div>
        </div>
        <Textarea
          ref={textareaRef}
          value={(config.promptTemplate as string) ?? ''}
          onChange={(e) => update('promptTemplate', e.target.value)}
          rows={8}
          placeholder={t('v2_llm_prompt_placeholder')}
          className="font-mono text-xs"
        />
      </div>

      {/* Input Fields */}
      <div className="space-y-1.5">
        <label className="block text-sm font-medium text-foreground">
          {t('v2_llm_input_fields')}
        </label>
        <p className="text-xs text-muted">{t('v2_llm_input_fields_desc')}</p>
        <div className="max-h-48 overflow-y-auto rounded-lg border border-default bg-background-subtle p-2 space-y-2">
          {/* Core group */}
          <div>
            <p className="text-xs font-medium text-muted mb-1">{t('v2_llm_core_fields')}</p>
            <div className="space-y-1">
              {coreFields.map((field) => (
                <label
                  key={field.name}
                  className={`flex items-center gap-2 px-2 py-1 rounded text-sm cursor-pointer transition-colors ${
                    inputFields.includes(field.name)
                      ? 'bg-accent/10 text-foreground'
                      : 'text-foreground-muted hover:bg-background-muted'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={inputFields.includes(field.name)}
                    onChange={() => toggleInputField(field.name)}
                    className="accent-accent rounded"
                  />
                  {field.label}
                </label>
              ))}
            </div>
          </div>
          {/* Common group */}
          <div>
            <p className="text-xs font-medium text-muted mb-1">{t('v2_llm_common_fields')}</p>
            <div className="space-y-1">
              {commonFields.map((field) => (
                <label
                  key={field.name}
                  className={`flex items-center gap-2 px-2 py-1 rounded text-sm cursor-pointer transition-colors ${
                    inputFields.includes(field.name)
                      ? 'bg-accent/10 text-foreground'
                      : 'text-foreground-muted hover:bg-background-muted'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={inputFields.includes(field.name)}
                    onChange={() => toggleInputField(field.name)}
                    className="accent-accent rounded"
                  />
                  {field.label}
                </label>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Output Field */}
      <Select
        label={t('v2_llm_output_field')}
        options={outputFieldOptions}
        value={(config.outputField as string) ?? ''}
        onChange={(v) => update('outputField', v)}
        placeholder={t('v2_llm_output_placeholder')}
      />

      {/* Advanced Section */}
      <div className="border border-default rounded-lg">
        <button
          type="button"
          onClick={() => setAdvancedOpen((o) => !o)}
          className="flex items-center gap-2 w-full px-3 py-2 text-sm font-medium text-foreground hover:bg-background-muted rounded-lg transition-colors"
        >
          {advancedOpen ? (
            <ChevronDown className="w-4 h-4 text-muted" />
          ) : (
            <ChevronRight className="w-4 h-4 text-muted" />
          )}
          {t('v2_llm_advanced')}
        </button>
        {advancedOpen && (
          <div className="px-3 pb-3 space-y-3">
            {/* Temperature */}
            <div className="space-y-1.5">
              <label className="flex items-center justify-between text-sm font-medium text-foreground">
                <span>{t('v2_llm_temperature')}</span>
                <span className="text-xs text-muted tabular-nums">{temperature.toFixed(1)}</span>
              </label>
              <input
                type="range"
                min={0}
                max={2}
                step={0.1}
                value={temperature}
                onChange={(e) => update('temperature', parseFloat(e.target.value))}
                className="w-full accent-accent"
              />
            </div>

            {/* Max Tokens */}
            <Input
              label={t('v2_llm_max_tokens')}
              type="number"
              value={String(maxTokens)}
              onChange={(e) => update('maxTokens', Number(e.target.value))}
              min={1}
              max={128000}
            />
          </div>
        )}
      </div>
    </div>
  );
}

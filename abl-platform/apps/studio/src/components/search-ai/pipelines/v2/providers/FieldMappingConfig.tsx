/**
 * Field Mapping Config — inline form for defining conditional field mapping rules.
 *
 * i18n keys used (search_ai.pipeline namespace):
 *   v2_mapping_if, v2_mapping_then, v2_mapping_set, v2_mapping_to,
 *   v2_mapping_add_rule, v2_mapping_remove_rule, v2_mapping_visual, v2_mapping_cel,
 *   v2_mapping_cel_placeholder, v2_mapping_cel_info,
 *   v2_mapping_field_placeholder, v2_mapping_value_placeholder, v2_mapping_new_value_placeholder,
 *   v2_mapping_target_placeholder,
 *   v2_mapping_op_equals, v2_mapping_op_contains, v2_mapping_op_starts_with,
 *   v2_mapping_op_ends_with, v2_mapping_op_matches, v2_mapping_op_is_empty, v2_mapping_op_is_not_empty
 */

'use client';

import { useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Trash2, Plus } from 'lucide-react';
import { Select } from '../../../../ui/Select';
import { Input } from '../../../../ui/Input';
import { Button } from '../../../../ui/Button';
import { Textarea } from '../../../../ui/Textarea';

interface MappingRule {
  id: string;
  mode: 'visual' | 'cel';
  condition: {
    field: string;
    operator: string;
    value: string;
  };
  target: {
    field: string;
    newValue: string;
  };
  celExpression?: string;
}

interface FieldMappingConfigProps {
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
}

const CANONICAL_FIELD_OPTIONS = [
  { value: 'title', label: 'Title' },
  { value: 'content_summary', label: 'Content Summary' },
  { value: 'source_type', label: 'Source Type' },
  { value: 'source_url', label: 'Source URL' },
  { value: 'author', label: 'Author' },
  { value: 'category', label: 'Category' },
  { value: 'status', label: 'Status' },
  { value: 'tags', label: 'Tags' },
  { value: 'priority', label: 'Priority' },
  { value: 'department', label: 'Department' },
  { value: 'project', label: 'Project' },
  { value: 'language', label: 'Language' },
  { value: 'mime_type', label: 'MIME Type' },
  { value: 'description', label: 'Description' },
  { value: 'assignee', label: 'Assignee' },
  { value: 'reporter', label: 'Reporter' },
];

function createEmptyRule(): MappingRule {
  return {
    id: crypto.randomUUID(),
    mode: 'visual',
    condition: { field: '', operator: 'equals', value: '' },
    target: { field: '', newValue: '' },
    celExpression: '',
  };
}

export function FieldMappingConfig({ config, onChange }: FieldMappingConfigProps) {
  const t = useTranslations('search_ai.pipeline');

  const rules: MappingRule[] = Array.isArray(config.rules) ? (config.rules as MappingRule[]) : [];

  const operatorOptions = useMemo(
    () => [
      { value: 'equals', label: t('v2_mapping_op_equals') },
      { value: 'contains', label: t('v2_mapping_op_contains') },
      { value: 'starts_with', label: t('v2_mapping_op_starts_with') },
      { value: 'ends_with', label: t('v2_mapping_op_ends_with') },
      { value: 'matches', label: t('v2_mapping_op_matches') },
      { value: 'is_empty', label: t('v2_mapping_op_is_empty') },
      { value: 'is_not_empty', label: t('v2_mapping_op_is_not_empty') },
    ],
    [t],
  );

  const modeOptions = useMemo(
    () => [
      { value: 'visual', label: t('v2_mapping_visual') },
      { value: 'cel', label: t('v2_mapping_cel') },
    ],
    [t],
  );

  const updateRules = useCallback(
    (updated: MappingRule[]) => {
      onChange({ ...config, rules: updated });
    },
    [config, onChange],
  );

  const handleAddRule = useCallback(() => {
    updateRules([...rules, createEmptyRule()]);
  }, [rules, updateRules]);

  const handleRemoveRule = useCallback(
    (id: string) => {
      updateRules(rules.filter((r) => r.id !== id));
    },
    [rules, updateRules],
  );

  const handleRuleChange = useCallback(
    (id: string, patch: Partial<MappingRule>) => {
      updateRules(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    },
    [rules, updateRules],
  );

  const handleConditionChange = useCallback(
    (id: string, patch: Partial<MappingRule['condition']>) => {
      const rule = rules.find((r) => r.id === id);
      if (!rule) return;
      handleRuleChange(id, { condition: { ...rule.condition, ...patch } });
    },
    [rules, handleRuleChange],
  );

  const handleTargetChange = useCallback(
    (id: string, patch: Partial<MappingRule['target']>) => {
      const rule = rules.find((r) => r.id === id);
      if (!rule) return;
      handleRuleChange(id, { target: { ...rule.target, ...patch } });
    },
    [rules, handleRuleChange],
  );

  return (
    <div className="space-y-3">
      {rules.map((rule, idx) => (
        <div
          key={rule.id}
          className="rounded-lg border border-default bg-background-subtle p-3 space-y-3"
        >
          {/* Header: mode toggle + remove */}
          <div className="flex items-center justify-between">
            <Select
              value={rule.mode}
              onChange={(v) => handleRuleChange(rule.id, { mode: v as 'visual' | 'cel' })}
              options={modeOptions}
              className="w-28"
            />
            <Button
              variant="ghost"
              size="xs"
              icon={<Trash2 className="w-3.5 h-3.5" />}
              aria-label={t('v2_mapping_remove_rule')}
              onClick={() => handleRemoveRule(rule.id)}
            />
          </div>

          {rule.mode === 'visual' ? (
            <>
              {/* IF section */}
              <div className="space-y-2">
                <span className="text-xs font-semibold uppercase text-muted">
                  {t('v2_mapping_if')}
                </span>
                <Select
                  value={rule.condition.field}
                  onChange={(v) => handleConditionChange(rule.id, { field: v })}
                  options={CANONICAL_FIELD_OPTIONS}
                  placeholder={t('v2_mapping_field_placeholder')}
                />
                <Select
                  value={rule.condition.operator}
                  onChange={(v) => handleConditionChange(rule.id, { operator: v })}
                  options={operatorOptions}
                />
                {rule.condition.operator !== 'is_empty' &&
                  rule.condition.operator !== 'is_not_empty' && (
                    <Input
                      value={rule.condition.value}
                      onChange={(e) => handleConditionChange(rule.id, { value: e.target.value })}
                      placeholder={t('v2_mapping_value_placeholder')}
                    />
                  )}
              </div>

              {/* THEN section */}
              <div className="space-y-2">
                <span className="text-xs font-semibold uppercase text-muted">
                  {t('v2_mapping_then')}
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted shrink-0">{t('v2_mapping_set')}</span>
                  <Select
                    value={rule.target.field}
                    onChange={(v) => handleTargetChange(rule.id, { field: v })}
                    options={CANONICAL_FIELD_OPTIONS}
                    placeholder={t('v2_mapping_target_placeholder')}
                    className="flex-1"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted shrink-0">{t('v2_mapping_to')}</span>
                  <Input
                    value={rule.target.newValue}
                    onChange={(e) => handleTargetChange(rule.id, { newValue: e.target.value })}
                    placeholder={t('v2_mapping_new_value_placeholder')}
                    className="flex-1"
                  />
                </div>
              </div>
            </>
          ) : (
            /* CEL mode */
            <div className="space-y-2">
              <Textarea
                value={rule.celExpression ?? ''}
                onChange={(e) => handleRuleChange(rule.id, { celExpression: e.target.value })}
                placeholder={t('v2_mapping_cel_placeholder')}
                rows={4}
              />
              <p className="text-xs text-muted">{t('v2_mapping_cel_info')}</p>
            </div>
          )}
        </div>
      ))}

      <Button
        variant="ghost"
        size="sm"
        icon={<Plus className="w-3.5 h-3.5" />}
        onClick={handleAddRule}
      >
        {t('v2_mapping_add_rule')}
      </Button>
    </div>
  );
}

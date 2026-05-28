/**
 * Rule Builder Slide-Over Panel
 *
 * Visual builder for flow selection rules. Supports:
 * - Simple rules (field + operator + value)
 * - Compound rules (AND/OR with nested conditions)
 * - CEL expression editor (advanced mode)
 * - Live CEL preview from visual rules
 *
 * Reference: docs/searchai/pipelines/design/frontend/UX-PIPELINE-CONFIGURATION.md
 */

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { usePipelineStore } from '../../../store/pipeline-store';
import type { RuleCondition } from '../../../api/pipelines';

export function RuleBuilderPanel() {
  const { draft, selectedFlowId, closeRuleBuilder, updateFlow } = usePipelineStore();
  const t = useTranslations('search_ai.pipeline');
  const [mode, setMode] = useState<'visual' | 'cel'>('visual');

  const FIELD_OPTIONS = useMemo(
    () => [
      { value: 'document.extension', label: t('rule_field_extension') },
      { value: 'document.mimeType', label: t('rule_field_mime') },
      { value: 'document.size', label: t('rule_field_size') },
      { value: 'document.name', label: t('rule_field_name') },
      { value: 'document.language', label: t('rule_field_language') },
      { value: 'source.connector', label: t('rule_field_connector') },
      { value: 'metadata.category', label: t('rule_field_category') },
    ],
    [t],
  );

  const OPERATOR_OPTIONS = useMemo(
    () => [
      { value: 'eq', label: t('rule_op_equals') },
      { value: 'ne', label: t('rule_op_not_equals') },
      { value: 'gt', label: t('rule_op_greater') },
      { value: 'lt', label: t('rule_op_less') },
      { value: 'gte', label: t('rule_op_greater_equal') },
      { value: 'lte', label: t('rule_op_less_equal') },
      { value: 'contains', label: t('rule_op_contains') },
      { value: 'in', label: t('rule_op_in_list') },
      { value: 'matches', label: t('rule_op_matches') },
    ],
    [t],
  );

  const flow = draft?.flows.find((f) => f.id === selectedFlowId);
  if (!flow) return null;

  const [rules, setRules] = useState<RuleCondition[]>([...flow.selectionRules]);
  const [celExpression, setCelExpression] = useState(
    flow.selectionRules.find((r) => r.type === 'cel')?.celExpression || '',
  );

  const handleAddCondition = () => {
    setRules([
      ...rules,
      {
        type: 'simple',
        field: 'document.extension',
        operator: 'eq',
        value: '',
      },
    ]);
  };

  const handleUpdateCondition = (index: number, updates: Partial<RuleCondition>) => {
    const updated = [...rules];
    updated[index] = { ...updated[index], ...updates };
    setRules(updated);
  };

  const handleRemoveCondition = (index: number) => {
    setRules(rules.filter((_, i) => i !== index));
  };

  const handleSave = () => {
    if (mode === 'cel' && celExpression.trim()) {
      updateFlow(flow.id, {
        selectionRules: [{ type: 'cel', celExpression: celExpression.trim() }],
      });
    } else {
      updateFlow(flow.id, { selectionRules: rules });
    }
    closeRuleBuilder();
  };

  const handleMakeDefault = () => {
    updateFlow(flow.id, { selectionRules: [] });
    closeRuleBuilder();
  };

  // Generate CEL preview from visual rules
  const celPreview = rules
    .filter((r) => r.type === 'simple' && r.field && r.operator && r.value !== undefined)
    .map((r) => {
      const op = r.operator === 'eq' ? '==' : r.operator === 'ne' ? '!=' : r.operator;
      const val = typeof r.value === 'string' ? `"${r.value}"` : r.value;
      return `${r.field} ${op} ${val}`;
    })
    .join(' && ');

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-overlay backdrop-blur-sm" onClick={closeRuleBuilder} />

      {/* Panel */}
      <div className="relative w-full max-w-lg bg-background border-l border-default shadow-xl overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-background z-10 px-6 py-4 border-b border-default">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-foreground">{t('rule_title')}</h3>
              <p className="text-xs text-muted mt-0.5">{t('rule_description')}</p>
            </div>
            <button
              className="p-1 text-muted hover:text-foreground rounded"
              onClick={closeRuleBuilder}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Mode toggle */}
          <div className="flex gap-1 p-0.5 bg-background-muted rounded-md w-fit">
            <button
              className={`px-3 py-1 text-xs rounded ${mode === 'visual' ? 'bg-background-elevated text-foreground shadow-sm' : 'text-muted'}`}
              onClick={() => setMode('visual')}
            >
              {t('rule_mode_visual')}
            </button>
            <button
              className={`px-3 py-1 text-xs rounded ${mode === 'cel' ? 'bg-background-elevated text-foreground shadow-sm' : 'text-muted'}`}
              onClick={() => setMode('cel')}
            >
              {t('rule_mode_cel')}
            </button>
          </div>

          {mode === 'visual' ? (
            <>
              {/* Visual rule builder */}
              <div className="space-y-3">
                {rules.map((rule, index) => (
                  <div
                    key={index}
                    className="p-4 rounded-md border border-default bg-background-elevated space-y-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-muted">
                        {t('rule_condition_label', { number: index + 1 })}
                      </span>
                      <button
                        className="text-xs text-error hover:text-error/80"
                        onClick={() => handleRemoveCondition(index)}
                      >
                        {t('rule_remove')}
                      </button>
                    </div>

                    {index > 0 && (
                      <div className="text-xs text-muted font-medium">{t('rule_and')}</div>
                    )}

                    <div>
                      <label className="block text-xs text-muted mb-1">
                        {t('rule_label_field')}
                      </label>
                      <select
                        value={rule.field || ''}
                        onChange={(e) => handleUpdateCondition(index, { field: e.target.value })}
                        className="w-full px-2 py-1.5 text-sm border border-default rounded bg-background text-foreground"
                      >
                        {FIELD_OPTIONS.map((f) => (
                          <option key={f.value} value={f.value}>
                            {f.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs text-muted mb-1">
                        {t('rule_label_operator')}
                      </label>
                      <select
                        value={rule.operator || 'eq'}
                        onChange={(e) => handleUpdateCondition(index, { operator: e.target.value })}
                        className="w-full px-2 py-1.5 text-sm border border-default rounded bg-background text-foreground"
                      >
                        {OPERATOR_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs text-muted mb-1">
                        {t('rule_label_value')}
                      </label>
                      <input
                        type="text"
                        value={String(rule.value ?? '')}
                        onChange={(e) => handleUpdateCondition(index, { value: e.target.value })}
                        className="w-full px-2 py-1.5 text-sm border border-default rounded bg-background text-foreground"
                        placeholder={t('rule_value_placeholder')}
                      />
                    </div>
                  </div>
                ))}
              </div>

              <button
                className="px-3 py-2 text-sm border border-dashed border-default rounded-md text-muted hover:text-foreground"
                onClick={handleAddCondition}
              >
                {t('rule_add_condition')}
              </button>

              {/* CEL preview */}
              {celPreview && (
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">
                    {t('rule_cel_preview_label')}
                  </label>
                  <code className="block p-3 text-xs bg-background-muted rounded-md text-foreground font-mono whitespace-pre-wrap">
                    {celPreview}
                  </code>
                </div>
              )}
            </>
          ) : (
            /* CEL editor */
            <div>
              <label className="block text-xs font-medium text-muted mb-1">
                {t('rule_cel_expression_label')}
              </label>
              <textarea
                value={celExpression}
                onChange={(e) => setCelExpression(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-default rounded-md bg-background-elevated text-foreground font-mono"
                rows={6}
                placeholder='document.contentType == "application/pdf" && document.size < 10485760'
              />
              <p className="text-xs text-muted mt-1">{t('rule_cel_available_fields')}</p>
            </div>
          )}

          {/* Make default option */}
          <div className="pt-4 border-t border-default">
            <button
              className="text-xs text-muted hover:text-foreground"
              onClick={handleMakeDefault}
            >
              {t('rule_make_default')}
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-background px-6 py-4 border-t border-default">
          <div className="flex justify-end gap-2">
            <button
              className="px-4 py-2 text-sm text-muted hover:text-foreground"
              onClick={closeRuleBuilder}
            >
              {t('rule_cancel')}
            </button>
            <button
              className="px-4 py-2 text-sm bg-foreground text-background rounded-md hover:opacity-90"
              onClick={handleSave}
            >
              {t('rule_save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

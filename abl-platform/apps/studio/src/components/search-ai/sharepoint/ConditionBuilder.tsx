'use client';

/**
 * Condition Builder
 *
 * Visual field/operator/value interface for building filter conditions.
 * Supports 15 operators, AND/OR grouping, and one level of nesting.
 */

import { useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';

// ─── Types ──────────────────────────────────────────────────────────────

export type Operator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'greater_than'
  | 'less_than'
  | 'in_list'
  | 'not_in_list'
  | 'exists'
  | 'not_exists'
  | 'regex_match'
  | 'between'
  | 'is_empty';

export interface Condition {
  field: string;
  operator: Operator;
  value: string;
}

export interface ConditionGroup {
  logic: 'AND' | 'OR';
  conditions: Condition[];
}

interface ConditionBuilderProps {
  groups: ConditionGroup[];
  onChange: (groups: ConditionGroup[]) => void;
  fields: Array<{ name: string; type: string }>;
  disabled?: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────

const MAX_CONDITIONS_PER_GROUP = 10;
const MAX_GROUPS = 5;

const ALL_OPERATORS: Operator[] = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'greater_than',
  'less_than',
  'in_list',
  'not_in_list',
  'exists',
  'not_exists',
  'regex_match',
  'between',
  'is_empty',
];

/** Operators that do not require a value input */
const NO_VALUE_OPERATORS: Operator[] = ['exists', 'not_exists', 'is_empty'];

// ─── Sub-components ─────────────────────────────────────────────────────

function NativeSelect({
  value,
  onChange,
  options,
  disabled,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      aria-label={ariaLabel}
      className="w-full rounded-lg border border-default bg-background-subtle text-foreground text-sm py-2 px-3 transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

// ─── Component ──────────────────────────────────────────────────────────

export function ConditionBuilder({
  groups,
  onChange,
  fields,
  disabled = false,
}: ConditionBuilderProps) {
  const t = useTranslations('search_ai.sharepoint');

  const fieldOptions = useMemo(
    () => [
      { value: '', label: t('condition_select_field') },
      ...fields.map((f) => ({ value: f.name, label: f.name })),
    ],
    [fields, t],
  );

  const operatorOptions = useMemo(
    () =>
      ALL_OPERATORS.map((op) => ({
        value: op,
        label: t(`condition_op_${op}`),
      })),
    [t],
  );

  // ─── Group operations ───────────────────────────────────────────────

  const updateGroup = useCallback(
    (groupIndex: number, updater: (group: ConditionGroup) => ConditionGroup) => {
      const newGroups = groups.map((g, i) => (i === groupIndex ? updater(g) : g));
      onChange(newGroups);
    },
    [groups, onChange],
  );

  const addGroup = useCallback(() => {
    if (groups.length >= MAX_GROUPS) return;
    onChange([
      ...groups,
      { logic: 'AND', conditions: [{ field: '', operator: 'equals', value: '' }] },
    ]);
  }, [groups, onChange]);

  const removeGroup = useCallback(
    (groupIndex: number) => {
      if (groups.length <= 1) return;
      onChange(groups.filter((_, i) => i !== groupIndex));
    },
    [groups, onChange],
  );

  const toggleLogic = useCallback(
    (groupIndex: number) => {
      updateGroup(groupIndex, (g) => ({
        ...g,
        logic: g.logic === 'AND' ? 'OR' : 'AND',
      }));
    },
    [updateGroup],
  );

  // ─── Condition operations ───────────────────────────────────────────

  const addCondition = useCallback(
    (groupIndex: number) => {
      updateGroup(groupIndex, (g) => {
        if (g.conditions.length >= MAX_CONDITIONS_PER_GROUP) return g;
        return {
          ...g,
          conditions: [...g.conditions, { field: '', operator: 'equals', value: '' }],
        };
      });
    },
    [updateGroup],
  );

  const removeCondition = useCallback(
    (groupIndex: number, conditionIndex: number) => {
      updateGroup(groupIndex, (g) => {
        if (g.conditions.length <= 1) return g;
        return {
          ...g,
          conditions: g.conditions.filter((_, i) => i !== conditionIndex),
        };
      });
    },
    [updateGroup],
  );

  const updateCondition = useCallback(
    (groupIndex: number, conditionIndex: number, updates: Partial<Condition>) => {
      updateGroup(groupIndex, (g) => ({
        ...g,
        conditions: g.conditions.map((c, i) => (i === conditionIndex ? { ...c, ...updates } : c)),
      }));
    },
    [updateGroup],
  );

  return (
    <div className="space-y-4">
      {groups.map((group, groupIndex) => (
        <div
          key={groupIndex}
          className="rounded-lg border border-default p-4 space-y-3 bg-background-subtle"
        >
          {/* Group header: logic toggle + remove */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-muted uppercase">
                {t('condition_group_label', { index: groupIndex + 1 })}
              </span>
              <div className="flex rounded-md border border-default overflow-hidden">
                <button
                  type="button"
                  onClick={() => {
                    if (group.logic !== 'AND') toggleLogic(groupIndex);
                  }}
                  disabled={disabled}
                  className={`px-3 py-1 text-xs font-medium transition-default ${
                    group.logic === 'AND'
                      ? 'bg-accent text-accent-foreground'
                      : 'bg-background-subtle text-muted hover:text-foreground'
                  }`}
                >
                  AND
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (group.logic !== 'OR') toggleLogic(groupIndex);
                  }}
                  disabled={disabled}
                  className={`px-3 py-1 text-xs font-medium transition-default ${
                    group.logic === 'OR'
                      ? 'bg-accent text-accent-foreground'
                      : 'bg-background-subtle text-muted hover:text-foreground'
                  }`}
                >
                  OR
                </button>
              </div>
            </div>
            {groups.length > 1 && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => removeGroup(groupIndex)}
                disabled={disabled}
                aria-label={t('condition_remove_group')}
              >
                {t('condition_remove')}
              </Button>
            )}
          </div>

          {/* Condition rows */}
          {group.conditions.map((condition, conditionIndex) => {
            const needsValue = !NO_VALUE_OPERATORS.includes(condition.operator);
            return (
              <div key={conditionIndex} className="flex items-start gap-2">
                {/* Field select */}
                <div className="flex-1 min-w-0">
                  <NativeSelect
                    value={condition.field}
                    onChange={(val) => updateCondition(groupIndex, conditionIndex, { field: val })}
                    options={fieldOptions}
                    disabled={disabled}
                    ariaLabel={t('condition_field_label')}
                  />
                </div>

                {/* Operator select */}
                <div className="flex-1 min-w-0">
                  <NativeSelect
                    value={condition.operator}
                    onChange={(val) =>
                      updateCondition(groupIndex, conditionIndex, {
                        operator: val as Operator,
                        // Clear value when switching to a no-value operator
                        ...(NO_VALUE_OPERATORS.includes(val as Operator) ? { value: '' } : {}),
                      })
                    }
                    options={operatorOptions}
                    disabled={disabled}
                    ariaLabel={t('condition_operator_label')}
                  />
                </div>

                {/* Value input */}
                {needsValue && (
                  <div className="flex-1 min-w-0">
                    <Input
                      value={condition.value}
                      onChange={(e) =>
                        updateCondition(groupIndex, conditionIndex, { value: e.target.value })
                      }
                      disabled={disabled}
                      placeholder={
                        condition.operator === 'in_list' || condition.operator === 'not_in_list'
                          ? t('condition_comma_separated')
                          : condition.operator === 'between'
                            ? t('condition_between_placeholder')
                            : t('condition_value_placeholder')
                      }
                      aria-label={t('condition_value_label')}
                    />
                  </div>
                )}

                {/* Remove condition */}
                {group.conditions.length > 1 && (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => removeCondition(groupIndex, conditionIndex)}
                    disabled={disabled}
                    aria-label={t('condition_remove_condition')}
                  >
                    X
                  </Button>
                )}
              </div>
            );
          })}

          {/* Add condition button */}
          {group.conditions.length < MAX_CONDITIONS_PER_GROUP && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => addCondition(groupIndex)}
              disabled={disabled}
            >
              {t('condition_add_condition')}
            </Button>
          )}
        </div>
      ))}

      {/* Add group button */}
      {groups.length < MAX_GROUPS && (
        <Button variant="secondary" size="sm" onClick={addGroup} disabled={disabled}>
          {t('condition_add_group')}
        </Button>
      )}
    </div>
  );
}

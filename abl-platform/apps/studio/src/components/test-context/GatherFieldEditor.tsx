/**
 * GatherFieldEditor — Per-field typed input based on agent IR type/validation.
 * Auto-populated from agent IR's gather.fields when available.
 */

import { useTranslations } from 'next-intl';
import { useSessionStore } from '../../store/session-store';
import { useTestContextStore } from '../../store/test-context-store';
import { VariableEditor } from './VariableEditor';

interface GatherField {
  name: string;
  type: string;
  description?: string;
  required?: boolean;
  validation?: unknown;
  enum_values?: string[];
}

function extractGatherFields(ir: unknown): GatherField[] {
  if (!ir || typeof ir !== 'object') return [];
  const agentIR = ir as Record<string, unknown>;

  // Check gather section
  const gather = agentIR.gather as Record<string, unknown> | undefined;
  if (!gather?.fields) return [];

  const fields = gather.fields as Record<string, unknown>;
  return Object.entries(fields).map(([name, fieldDef]) => {
    const def = fieldDef as Record<string, unknown>;
    return {
      name,
      type: (def.type as string) || 'string',
      description: def.description as string | undefined,
      required: def.required as boolean | undefined,
      enum_values: def.enum_values as string[] | undefined,
    };
  });
}

export function GatherFieldEditor() {
  const t = useTranslations('test_context.gather_field');
  const agent = useSessionStore((s) => s.agent);
  const gatherValues = useTestContextStore((s) => s.gatherValues);
  const updateGatherValue = useTestContextStore((s) => s.updateGatherValue);
  const removeGatherValue = useTestContextStore((s) => s.removeGatherValue);

  const fields = agent?.ir ? extractGatherFields(agent.ir) : [];

  if (fields.length === 0) {
    // Fallback to generic key-value editor
    return (
      <VariableEditor
        values={gatherValues}
        onUpdate={updateGatherValue}
        onRemove={removeGatherValue}
        placeholder="value"
      />
    );
  }

  return (
    <div className="space-y-2">
      {fields.map((field) => (
        <div key={field.name} className="space-y-0.5">
          <label className="flex items-center gap-1 text-xs text-muted">
            <span className="font-mono text-accent">{field.name}</span>
            <span className="text-subtle">({field.type})</span>
            {field.required && <span className="text-error">*</span>}
          </label>
          {field.description && <p className="text-xs text-subtle">{field.description}</p>}
          {field.enum_values ? (
            <select
              value={(gatherValues[field.name] as string) ?? ''}
              onChange={(e) => {
                if (e.target.value) {
                  updateGatherValue(field.name, e.target.value);
                } else {
                  removeGatherValue(field.name);
                }
              }}
              className="w-full px-2 py-1 text-xs bg-background-elevated border border-default rounded text-foreground"
            >
              <option value="">{t('select_placeholder')}</option>
              {field.enum_values.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          ) : (
            <input
              type={field.type === 'number' || field.type === 'integer' ? 'number' : 'text'}
              value={gatherValues[field.name] !== undefined ? String(gatherValues[field.name]) : ''}
              onChange={(e) => {
                const raw = e.target.value;
                if (!raw) {
                  removeGatherValue(field.name);
                  return;
                }
                if (field.type === 'number' || field.type === 'integer') {
                  updateGatherValue(field.name, Number(raw));
                } else if (field.type === 'boolean') {
                  updateGatherValue(field.name, raw === 'true');
                } else {
                  updateGatherValue(field.name, raw);
                }
              }}
              placeholder={field.description || field.name}
              className="w-full px-2 py-1 text-xs bg-background-elevated border border-default rounded text-foreground font-mono placeholder:text-subtle"
            />
          )}
        </div>
      ))}
    </div>
  );
}

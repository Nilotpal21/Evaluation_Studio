/**
 * Provider Configuration Form
 *
 * Renders provider-specific configuration forms based on JSON Schema
 * returned by the provider registry API.
 *
 * Field type mapping:
 * - string + enum → <select> dropdown
 * - string (name=code) → <textarea> code editor with monospace font
 * - string (default) → <input type="text">
 * - number → <input type="number"> with min/max
 * - boolean → checkbox toggle
 * - array → comma-separated text input
 * - object → JSON textarea (for complex nested like headers)
 *
 * RFC-004: "Provider-specific configuration form (dynamic based on provider)"
 */

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';

interface SchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  items?: SchemaProperty;
}

interface ProviderSchema {
  type: 'object';
  title?: string;
  description?: string;
  properties?: Record<string, SchemaProperty>;
  required?: string[];
}

interface ProviderConfigFormProps {
  schema: ProviderSchema;
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  providerId: string;
}

export function ProviderConfigForm({
  schema,
  config,
  onChange,
  providerId,
}: ProviderConfigFormProps) {
  const t = useTranslations('search_ai.pipeline');

  const updateField = useCallback(
    (field: string, value: unknown) => {
      const newConfig = { ...config };
      if (value === '' || value === undefined || value === null) {
        delete newConfig[field];
      } else {
        newConfig[field] = value;
      }
      onChange(newConfig);
    },
    [config, onChange],
  );

  if (!schema.properties || Object.keys(schema.properties).length === 0) {
    return (
      <div className="p-3 rounded-md border border-default bg-background-elevated">
        <p className="text-sm text-muted">{t('provider_config_no_fields')}</p>
      </div>
    );
  }

  const required = new Set(schema.required ?? []);

  return (
    <div className="space-y-4">
      {/* Schema title/description */}
      {schema.description && <p className="text-xs text-muted">{schema.description}</p>}

      {Object.entries(schema.properties).map(([fieldName, fieldSchema]) => (
        <FieldRenderer
          key={fieldName}
          fieldName={fieldName}
          schema={fieldSchema}
          value={config[fieldName]}
          isRequired={required.has(fieldName)}
          providerId={providerId}
          onChange={(value) => updateField(fieldName, value)}
        />
      ))}
    </div>
  );
}

// ─── Field Renderer ─────────────────────────────────────────────────────

interface FieldRendererProps {
  fieldName: string;
  schema: SchemaProperty;
  value: unknown;
  isRequired: boolean;
  providerId: string;
  onChange: (value: unknown) => void;
}

function FieldRenderer({
  fieldName,
  schema,
  value,
  isRequired,
  providerId,
  onChange,
}: FieldRendererProps) {
  const label = formatLabel(fieldName);

  // Code field — dedicated textarea with monospace
  if (fieldName === 'code' && schema.type === 'string') {
    return (
      <CodeField
        label={label}
        description={schema.description}
        value={(value as string) ?? (schema.default as string) ?? ''}
        isRequired={isRequired}
        providerId={providerId}
        onChange={onChange}
      />
    );
  }

  // String with enum → dropdown
  if (schema.type === 'string' && schema.enum) {
    return (
      <div>
        <FieldLabel label={label} isRequired={isRequired} />
        <select
          value={(value as string) ?? (schema.default as string) ?? ''}
          onChange={(e) => onChange(e.target.value || undefined)}
          className="w-full px-3 py-2 text-sm border border-default rounded-md bg-background-elevated text-foreground"
        >
          <option value="">— Select —</option>
          {schema.enum.map((opt) => (
            <option key={String(opt)} value={String(opt)}>
              {String(opt)}
            </option>
          ))}
        </select>
        {schema.description && <FieldHint text={schema.description} />}
      </div>
    );
  }

  // String → text input
  if (schema.type === 'string') {
    return (
      <div>
        <FieldLabel label={label} isRequired={isRequired} />
        <input
          type="text"
          value={(value as string) ?? (schema.default as string) ?? ''}
          onChange={(e) => onChange(e.target.value || undefined)}
          className="w-full px-3 py-2 text-sm border border-default rounded-md bg-background-elevated text-foreground"
          placeholder={schema.description ?? ''}
        />
        {schema.description && <FieldHint text={schema.description} />}
      </div>
    );
  }

  // Number → number input
  if (schema.type === 'number') {
    return (
      <div>
        <FieldLabel label={label} isRequired={isRequired} />
        <input
          type="number"
          value={(value as number) ?? (schema.default as number) ?? ''}
          onChange={(e) => {
            const num = e.target.value ? Number(e.target.value) : undefined;
            onChange(num);
          }}
          min={schema.minimum}
          max={schema.maximum}
          className="w-full px-3 py-2 text-sm border border-default rounded-md bg-background-elevated text-foreground"
        />
        {schema.description && <FieldHint text={schema.description} />}
        {(schema.minimum !== undefined || schema.maximum !== undefined) && (
          <p className="text-[10px] text-muted mt-0.5">
            {schema.minimum !== undefined && `Min: ${schema.minimum}`}
            {schema.minimum !== undefined && schema.maximum !== undefined && ' · '}
            {schema.maximum !== undefined && `Max: ${schema.maximum}`}
            {schema.default !== undefined && ` · Default: ${schema.default}`}
          </p>
        )}
      </div>
    );
  }

  // Boolean → checkbox
  if (schema.type === 'boolean') {
    return (
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={(value as boolean) ?? (schema.default as boolean) ?? false}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-1 h-4 w-4 rounded border-default text-accent"
        />
        <div>
          <span className="text-sm font-medium text-foreground">{label}</span>
          {schema.description && <FieldHint text={schema.description} />}
        </div>
      </div>
    );
  }

  // Array → comma-separated input or JSON
  if (schema.type === 'array') {
    const arrayValue = Array.isArray(value) ? value : [];
    return (
      <div>
        <FieldLabel label={label} isRequired={isRequired} />
        <textarea
          value={arrayValue.join('\n')}
          onChange={(e) => {
            const items = e.target.value
              .split('\n')
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            onChange(items.length > 0 ? items : undefined);
          }}
          className="w-full px-3 py-2 text-sm border border-default rounded-md bg-background-elevated text-foreground font-mono"
          rows={4}
          placeholder="One item per line"
        />
        {schema.description && <FieldHint text={schema.description} />}
      </div>
    );
  }

  // Object → JSON textarea
  if (schema.type === 'object') {
    return (
      <div>
        <FieldLabel label={label} isRequired={isRequired} />
        <textarea
          value={value ? JSON.stringify(value, null, 2) : ''}
          onChange={(e) => {
            try {
              const parsed = JSON.parse(e.target.value);
              onChange(parsed);
            } catch {
              // Don't update on invalid JSON — but keep the textarea editable
            }
          }}
          className="w-full px-3 py-2 text-sm border border-default rounded-md bg-background-elevated text-foreground font-mono"
          rows={4}
          placeholder="{}"
        />
        {schema.description && <FieldHint text={schema.description} />}
      </div>
    );
  }

  // Unknown type — JSON fallback
  return (
    <div>
      <FieldLabel label={label} isRequired={isRequired} />
      <input
        type="text"
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value || undefined)}
        className="w-full px-3 py-2 text-sm border border-default rounded-md bg-background-elevated text-foreground"
      />
      {schema.description && <FieldHint text={schema.description} />}
    </div>
  );
}

// ─── Code Field (Special) ───────────────────────────────────────────────

interface CodeFieldProps {
  label: string;
  description?: string;
  value: string;
  isRequired: boolean;
  providerId: string;
  onChange: (value: unknown) => void;
}

function CodeField({ label, description, value, isRequired, onChange }: CodeFieldProps) {
  const t = useTranslations('search_ai.pipeline');

  return (
    <div>
      <FieldLabel label={label} isRequired={isRequired} />
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value || undefined)}
        className="w-full px-3 py-2 text-sm border border-default rounded-md bg-background-elevated text-foreground font-mono leading-relaxed"
        rows={12}
        spellCheck={false}
        placeholder={t('provider_config_code_placeholder')}
      />
      {description && <FieldHint text={description} />}
      <div className="mt-2 p-3 rounded-md border border-default bg-background-muted">
        <p className="text-xs font-medium text-foreground mb-1">
          {t('provider_config_code_variables_title')}
        </p>
        <ul className="text-[11px] text-muted space-y-0.5 font-mono">
          <li>
            <strong>content</strong> — {t('provider_config_code_var_content')}
          </li>
          <li>
            <strong>metadata</strong> — {t('provider_config_code_var_metadata')}
          </li>
          <li>
            <strong>documentId</strong> — {t('provider_config_code_var_document_id')}
          </li>
          <li>
            <strong>contentType</strong> — {t('provider_config_code_var_content_type')}
          </li>
        </ul>
        <p className="text-xs font-medium text-foreground mt-2 mb-1">
          {t('provider_config_code_return_title')}
        </p>
        <ul className="text-[11px] text-muted space-y-0.5 font-mono">
          <li>
            {'return { content: "modified text" }'} — {t('provider_config_code_return_content')}
          </li>
          <li>
            {'return { chunks: ["chunk1", "chunk2"] }'} — {t('provider_config_code_return_chunks')}
          </li>
          <li>
            {'return { content, metadata: { key: "val" } }'} —{' '}
            {t('provider_config_code_return_metadata')}
          </li>
        </ul>
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────

function FieldLabel({ label, isRequired }: { label: string; isRequired: boolean }) {
  return (
    <label className="block text-sm font-medium text-foreground mb-1">
      {label}
      {isRequired && <span className="text-error ml-0.5">*</span>}
    </label>
  );
}

function FieldHint({ text }: { text: string }) {
  return <p className="text-xs text-muted mt-1">{text}</p>;
}

/** Convert camelCase/snake_case field names to Title Case labels */
function formatLabel(fieldName: string): string {
  return fieldName
    .replace(/([A-Z])/g, ' $1')
    .replace(/[_-]/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase())
    .trim();
}

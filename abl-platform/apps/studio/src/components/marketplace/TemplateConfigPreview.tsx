'use client';

import { useTranslations } from 'next-intl';

interface ConfigField {
  name?: string;
  type?: string;
  default?: unknown;
  description?: string;
}

interface TemplateConfigPreviewProps {
  schema: Record<string, unknown> | null;
}

function extractFields(schema: Record<string, unknown>): ConfigField[] {
  // Support JSON Schema-style properties or a flat key-value map
  const properties = (schema.properties ?? schema) as Record<string, unknown>;
  if (!properties || typeof properties !== 'object') return [];

  return Object.entries(properties).map(([key, value]) => {
    if (typeof value === 'object' && value !== null) {
      const field = value as Record<string, unknown>;
      return {
        name: key,
        type: typeof field.type === 'string' ? field.type : 'string',
        default: field.default,
        description: typeof field.description === 'string' ? field.description : undefined,
      };
    }
    return { name: key, type: typeof value, default: value };
  });
}

export function TemplateConfigPreview({ schema }: TemplateConfigPreviewProps) {
  const t = useTranslations('marketplace');

  if (!schema) {
    return <p className="text-sm text-muted">{t('configPreview.noConfig')}</p>;
  }

  const fields = extractFields(schema);

  if (fields.length === 0) {
    return <p className="text-sm text-muted">{t('configPreview.noConfig')}</p>;
  }

  return (
    <div className="rounded-xl border border-default bg-background-elevated overflow-hidden">
      <div className="px-4 py-3 border-b border-default">
        <h3 className="text-sm font-medium text-foreground">{t('configPreview.title')}</h3>
        <p className="text-xs text-muted mt-0.5">{t('configPreview.description')}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-default">
              <th className="text-left px-4 py-2 text-xs font-medium text-subtle uppercase tracking-wider">
                {t('configPreview.columnVariable')}
              </th>
              <th className="text-left px-4 py-2 text-xs font-medium text-subtle uppercase tracking-wider">
                {t('configPreview.columnType')}
              </th>
              <th className="text-left px-4 py-2 text-xs font-medium text-subtle uppercase tracking-wider">
                {t('configPreview.columnDefault')}
              </th>
              <th className="text-left px-4 py-2 text-xs font-medium text-subtle uppercase tracking-wider">
                {t('configPreview.columnDescription')}
              </th>
            </tr>
          </thead>
          <tbody>
            {fields.map((field) => (
              <tr key={field.name} className="border-b border-default last:border-0">
                <td className="px-4 py-2 text-foreground font-mono text-xs">{field.name}</td>
                <td className="px-4 py-2 text-muted">{field.type}</td>
                <td className="px-4 py-2 text-muted font-mono text-xs">
                  {field.default !== undefined ? String(field.default) : '—'}
                </td>
                <td className="px-4 py-2 text-muted">{field.description ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

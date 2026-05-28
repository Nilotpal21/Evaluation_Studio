/**
 * McpConfigForm Component
 *
 * Config form for MCP tool type: server reference, transport, headers, and tool name.
 * The server field displays the registered MCP server name (resolved to its URL).
 * Authentication is configured at the MCP server level, not per-tool.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, Trash2, ExternalLink } from 'lucide-react';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Button } from '../ui/Button';
import { useMcpServerStore } from '../../store/mcp-server-store';
import type { HeaderEntry, McpConfig } from './shared-types';

export type { McpConfig } from './shared-types';

interface McpConfigFormProps {
  config: McpConfig;
  onChange: (config: McpConfig) => void;
  readOnly?: boolean;
}

/** Validate full MCP config — returns map of field→error */
export function validateMcpConfig(config: McpConfig): Record<string, string> {
  const errors: Record<string, string> = {};

  if (!config.serverUrl?.trim()) {
    errors.serverUrl = 'MCP Server is required';
  }

  return errors;
}

export function McpConfigForm({ config, onChange, readOnly }: McpConfigFormProps) {
  const t = useTranslations('tools.mcp_config');
  const { servers } = useMcpServerStore();

  // Resolve the MCP server by name to get its URL
  const resolvedServer = useMemo(() => {
    if (!config.serverUrl) return null;
    return servers.find((s) => s.name === config.serverUrl) ?? null;
  }, [config.serverUrl, servers]);

  const TRANSPORT_OPTIONS = useMemo(
    () => [
      { value: 'sse', label: t('transport_sse_full') },
      { value: 'http', label: t('transport_http_full') },
    ],
    [t],
  );

  const update = (field: string, value: unknown) => {
    onChange({ ...config, [field]: value });
  };

  const headers: HeaderEntry[] = config.headers || [];

  const addHeader = () => {
    update('headers', [...headers, { key: '', value: '' }]);
  };

  const removeHeader = (index: number) => {
    update(
      'headers',
      headers.filter((_, i) => i !== index),
    );
  };

  const updateHeader = (index: number, field: 'key' | 'value', value: string) => {
    const updated = headers.map((h, i) => (i === index ? { ...h, [field]: value } : h));
    update('headers', updated);
  };

  const touched = (val: string | undefined) => !!val && val.length > 0;
  const errors = validateMcpConfig(config);

  return (
    <div className="space-y-4">
      {/* MCP Server Reference */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-1.5">
          {t('server_label')}
        </label>
        <div className="flex items-center gap-2 rounded-lg border border-default bg-background-subtle px-3 py-2">
          <span className="text-sm text-foreground font-medium">{config.serverUrl || '—'}</span>
          {resolvedServer?.url && (
            <span className="text-xs text-muted truncate ml-auto flex items-center gap-1">
              <ExternalLink className="w-3 h-3 flex-shrink-0" />
              {resolvedServer.url}
            </span>
          )}
        </div>
        {!resolvedServer && config.serverUrl && (
          <p className="text-xs text-warning mt-1">{t('server_not_found')}</p>
        )}
      </div>

      {/* Transport Type */}
      <Select
        label={t('transport_type_label')}
        options={TRANSPORT_OPTIONS}
        value={config.transportType || 'sse'}
        onChange={(v) => update('transportType', v)}
        disabled={readOnly}
      />

      {/* Headers */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block text-sm font-medium text-foreground">{t('headers_label')}</label>
          {!readOnly && (
            <Button
              variant="ghost"
              size="sm"
              icon={<Plus className="w-3.5 h-3.5" />}
              onClick={addHeader}
            >
              {t('add')}
            </Button>
          )}
        </div>
        {headers.length === 0 ? (
          <p className="text-xs text-muted">
            {t('no_custom_headers')}
            <br />
            {t.rich('headers_hint', {
              code: (chunks) => (
                <code className="font-mono text-xs bg-background-muted px-1 rounded">{chunks}</code>
              ),
            })}
          </p>
        ) : (
          <div className="space-y-2">
            {headers.map((header, index) => (
              <div key={index} className="flex items-center gap-2">
                <input
                  placeholder={t('header_name_placeholder')}
                  value={header.key}
                  onChange={(e) => updateHeader(index, 'key', e.target.value)}
                  disabled={readOnly}
                  className="flex-1 rounded-lg border border-default bg-background-subtle text-foreground text-sm px-3 py-1.5 transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus disabled:opacity-70 disabled:cursor-default"
                />
                <input
                  placeholder={t('header_value_placeholder')}
                  value={header.value}
                  onChange={(e) => updateHeader(index, 'value', e.target.value)}
                  disabled={readOnly}
                  className="flex-1 rounded-lg border border-default bg-background-subtle text-foreground text-sm px-3 py-1.5 transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus disabled:opacity-70 disabled:cursor-default"
                />
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => removeHeader(index)}
                    className="p-1.5 text-muted hover:text-error transition-default"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {headers.length > 0 && (
          <div className="text-xs text-muted space-y-1 mt-2">
            <p>
              <strong>{t('template_variables')}</strong>
            </p>
            <ul className="list-disc list-inside space-y-0.5 ml-2">
              <li>
                <code className="font-mono bg-background-muted px-1 rounded">
                  {'{{secrets.KEY_NAME}}'}
                </code>{' '}
                — {t('template_project_secrets')}
              </li>
              <li>
                <code className="font-mono bg-background-muted px-1 rounded">
                  {'{{session._metadata.key}}'}
                </code>{' '}
                — {t('template_session_vars')}
              </li>
              <li>
                <code className="font-mono bg-background-muted px-1 rounded">
                  {'{{_context.userId}}'}
                </code>{' '}
                — {t('template_context_vars')}
              </li>
              <li>
                <code className="font-mono bg-background-muted px-1 rounded">
                  {'{{env.KEY_NAME}}'}
                </code>{' '}
                — {t('template_env_vars')}
              </li>
            </ul>
            <p className="mt-1">{t('template_resolved_at_runtime')}</p>
          </div>
        )}
      </div>

      {/* Advanced Settings */}
      <details className="group">
        <summary className="text-sm font-medium text-muted cursor-pointer hover:text-foreground transition-default select-none flex items-center gap-1.5">
          <span className="group-open:rotate-90 transition-transform inline-block">&#9654;</span>
          Advanced Settings
        </summary>
        <div className="mt-3 space-y-4">
          {/* Remote Tool Name (Optional Override) */}
          <Input
            label={t('remote_tool_name_label')}
            placeholder={t('remote_tool_name_placeholder')}
            value={config.serverToolName || ''}
            onChange={(e) => update('serverToolName', e.target.value)}
            error={touched(config.serverToolName) ? errors.serverToolName : undefined}
            disabled={readOnly}
          />
          <p className="text-xs text-muted -mt-3">{t('remote_tool_name_hint')}</p>
        </div>
      </details>
    </div>
  );
}

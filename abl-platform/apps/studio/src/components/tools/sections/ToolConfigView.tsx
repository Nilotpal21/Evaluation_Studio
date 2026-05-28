/**
 * ToolConfigView Component
 *
 * Read-only structured display of tool configuration.
 * Replaces the raw DSL textarea in view mode on ToolDetailPage.
 * Shows parsed form data in a structured layout with an [Edit] button.
 *
 * Falls back to raw DSL display when parsing fails.
 */

import { useTranslations } from 'next-intl';
import { Pencil, AlertTriangle, Code, Globe, Server } from 'lucide-react';
import clsx from 'clsx';
import { Button } from '../../ui/Button';
import type { ToolWithVersion } from '../../../store/tool-store';
import { maskRawDslForDisplay } from '../../../utils/mask-sensitive-data';
import type {
  ProjectToolFormData,
  HttpToolFormData,
  SandboxToolFormData,
  McpToolFormData,
} from '@agent-platform/shared/types';

interface ToolConfigViewProps {
  tool: ToolWithVersion;
  formData: ProjectToolFormData | null;
  dslContent: string;
  onEdit: () => void;
}

export function ToolConfigView({ tool, formData, dslContent, onEdit }: ToolConfigViewProps) {
  const t = useTranslations('tools.detail');
  const maskedDslContent = maskRawDslForDisplay(dslContent);

  // ─── Parse failure fallback ─────────────────────────────────────────
  if (!formData) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-warning">
            <AlertTriangle className="w-4 h-4" />
            <span className="text-sm font-medium">{t('parse_failed_fallback')}</span>
          </div>
          <Button
            variant="secondary"
            size="sm"
            icon={<Pencil className="w-3.5 h-3.5" />}
            onClick={onEdit}
          >
            {t('edit_configuration')}
          </Button>
        </div>
        <pre className="p-4 rounded-lg bg-background-muted border border-default text-sm font-mono overflow-x-auto whitespace-pre-wrap">
          {maskedDslContent}
        </pre>
      </div>
    );
  }

  // ─── Structured view ────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header with Edit button */}
      <div className="flex items-center justify-end">
        <Button
          variant="secondary"
          size="sm"
          icon={<Pencil className="w-3.5 h-3.5" />}
          onClick={onEdit}
        >
          {t('edit_configuration')}
        </Button>
      </div>

      {/* Parameters table */}
      <ConfigSection title={t('parameters_section')}>
        {formData.parameters.length === 0 ? (
          <p className="text-sm text-muted">{t('no_parameters')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-default">
                  <th className="text-left py-2 pr-4 font-medium text-muted">Name</th>
                  <th className="text-left py-2 pr-4 font-medium text-muted">Type</th>
                  <th className="text-left py-2 font-medium text-muted">Required</th>
                </tr>
              </thead>
              <tbody>
                {formData.parameters.map((p: { name: string; type: string; required: boolean }) => (
                  <tr key={p.name} className="border-b border-default/50">
                    <td className="py-2 pr-4 font-mono text-foreground">{p.name}</td>
                    <td className="py-2 pr-4">
                      <span className="px-1.5 py-0.5 rounded bg-background-muted text-xs font-mono text-foreground">
                        {p.type}
                      </span>
                    </td>
                    <td className="py-2">
                      {p.required ? (
                        <span className="px-1.5 py-0.5 rounded bg-accent-subtle text-accent text-xs font-medium">
                          required
                        </span>
                      ) : (
                        <span className="text-xs text-muted">optional</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ConfigSection>

      {/* Type-specific configuration */}
      {formData.toolType === 'http' && <HttpConfigView form={formData} />}
      {formData.toolType === 'sandbox' && <SandboxConfigView form={formData} />}
      {formData.toolType === 'mcp' && <McpConfigView form={formData} />}

      {/* Collapsible DSL preview */}
      <details className="group">
        <summary className="text-xs font-medium text-muted cursor-pointer hover:text-foreground transition-default select-none flex items-center gap-1">
          <span className="group-open:rotate-90 transition-transform inline-block">&#9654;</span>
          {t('view_raw_dsl')}
        </summary>
        <pre className="mt-2 p-3 rounded-lg bg-background-muted border border-default text-xs font-mono overflow-x-auto whitespace-pre-wrap max-h-64 overflow-y-auto">
          {maskedDslContent}
        </pre>
      </details>
    </div>
  );
}

// ─── Section wrapper ──────────────────────────────────────────────────────────

function ConfigSection({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
        {icon}
        {title}
      </h3>
      {children}
    </div>
  );
}

// ─── Config row ───────────────────────────────────────────────────────────────

function ConfigRow({
  label,
  value,
  badge,
  mono,
}: {
  label: string;
  value?: string | number | null;
  badge?: boolean;
  mono?: boolean;
}) {
  if (value == null || value === '') return null;
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="text-sm text-muted w-28 shrink-0">{label}</span>
      {badge ? (
        <span className="px-2 py-0.5 rounded bg-background-muted text-xs font-medium text-foreground uppercase">
          {value}
        </span>
      ) : (
        <span className={clsx('text-sm text-foreground break-all', mono && 'font-mono')}>
          {String(value)}
        </span>
      )}
    </div>
  );
}

// ─── HTTP View ────────────────────────────────────────────────────────────────

function HttpConfigView({ form }: { form: HttpToolFormData }) {
  const t = useTranslations('tools.detail');

  return (
    <ConfigSection title="HTTP Configuration" icon={<Globe className="w-4 h-4 text-accent" />}>
      <div className="space-y-1">
        <ConfigRow label={t('endpoint_label')} value={form.endpoint} mono />
        <ConfigRow label={t('method_label')} value={form.method} badge />
        <ConfigRow label={t('auth_label')} value={form.auth} badge />
        {form.bodyType && <ConfigRow label={t('body_type_label')} value={form.bodyType} badge />}
        {form.timeout != null && (
          <ConfigRow label={t('timeout_label')} value={`${form.timeout}ms`} />
        )}
        {form.retry != null && (typeof form.retry === 'string' || form.retry > 0) && (
          <ConfigRow label={t('retry_label')} value={form.retry} />
        )}
        {form.retryDelay != null && form.retryDelay !== 1000 && (
          <ConfigRow label={t('retry_delay_label')} value={`${form.retryDelay}ms`} />
        )}
        {form.rateLimit != null && (
          <ConfigRow label={t('rate_limit_label')} value={`${form.rateLimit}/min`} />
        )}
        {form.circuitBreaker && (
          <ConfigRow
            label={t('circuit_breaker_label')}
            value={`threshold: ${form.circuitBreaker.threshold}, reset: ${form.circuitBreaker.resetMs}ms`}
          />
        )}
      </div>

      {/* Headers */}
      {form.headers && form.headers.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium text-muted mb-1.5">{t('headers_label')}</p>
          <div className="space-y-1">
            {form.headers.map((h: { key: string; value: string }, i: number) => (
              <div key={i} className="flex items-center gap-2 text-xs font-mono">
                <span className="text-foreground">{h.key}:</span>
                <span className="text-muted">{h.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Query Params */}
      {form.queryParams && form.queryParams.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium text-muted mb-1.5">{t('query_params_label')}</p>
          <div className="space-y-1">
            {form.queryParams.map((q: { key: string; value: string }, i: number) => (
              <div key={i} className="flex items-center gap-2 text-xs font-mono">
                <span className="text-foreground">{q.key}=</span>
                <span className="text-muted">{q.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </ConfigSection>
  );
}

// ─── Sandbox View ─────────────────────────────────────────────────────────────

function SandboxConfigView({ form }: { form: SandboxToolFormData }) {
  const t = useTranslations('tools.detail');
  const codeLines = form.code.split('\n').length;
  const codePreview = form.code.length > 500 ? form.code.slice(0, 500) + '\n...' : form.code;

  return (
    <ConfigSection title="Code Configuration" icon={<Code className="w-4 h-4 text-accent" />}>
      <div className="space-y-1">
        <ConfigRow label={t('runtime_label')} value={form.runtime} badge />
        {form.memoryMb != null && (
          <ConfigRow label={t('memory_label')} value={`${form.memoryMb} MB`} />
        )}
        {form.timeout != null && (
          <ConfigRow label={t('timeout_label')} value={`${form.timeout}ms`} />
        )}
      </div>

      {/* Code preview */}
      <div className="mt-3">
        <p className="text-xs font-medium text-muted mb-1.5">
          {t('code_label')} ({codeLines} lines)
        </p>
        <pre className="p-3 rounded-lg bg-background-muted border border-default text-xs font-mono overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto">
          {codePreview}
        </pre>
      </div>
    </ConfigSection>
  );
}

// ─── MCP View ─────────────────────────────────────────────────────────────────

function McpConfigView({ form }: { form: McpToolFormData }) {
  const t = useTranslations('tools.detail');

  return (
    <ConfigSection title="MCP Configuration" icon={<Server className="w-4 h-4 text-accent" />}>
      <div className="space-y-1">
        <ConfigRow label={t('server_label')} value={form.server} mono />
        {form.serverTool && (
          <ConfigRow label={t('server_tool_label')} value={form.serverTool} mono />
        )}
        {form.transportType && (
          <ConfigRow label={t('transport_type_label')} value={form.transportType} badge />
        )}
      </div>

      {/* Headers */}
      {form.headers && form.headers.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium text-muted mb-1.5">{t('headers_label')}</p>
          <div className="space-y-1">
            {form.headers.map((h: { key: string; value: string }, i: number) => (
              <div key={i} className="flex items-center gap-2 text-xs font-mono">
                <span className="text-foreground">{h.key}:</span>
                <span className="text-muted">{h.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </ConfigSection>
  );
}

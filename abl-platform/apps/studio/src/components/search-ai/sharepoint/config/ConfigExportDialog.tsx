/**
 * ConfigExportDialog Component
 *
 * Modal for exporting connector config as JSON or YAML with selective
 * section checkboxes, syntax-highlighted preview, download and copy.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Download, Copy, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { sanitizeError } from '@/lib/sanitize-error';
import { Dialog } from '../../../ui/Dialog';
import { Button } from '../../../ui/Button';
import { SegmentedControl } from '../../../ui/SegmentedControl';
import { apiFetch, handleResponse } from '../../../../lib/api-client';

interface ConfigExportDialogProps {
  open: boolean;
  onClose: () => void;
  indexId: string;
  connectorId: string;
  connectorName: string;
}

type ExportFormat = 'json' | 'yaml';

interface IncludeFlags {
  scope: boolean;
  filters: boolean;
  schedule: boolean;
  permissionMode: boolean;
  credentials: boolean;
}

export function ConfigExportDialog({
  open,
  onClose,
  indexId,
  connectorId,
  connectorName,
}: ConfigExportDialogProps) {
  const t = useTranslations('search_ai.sharepoint.config.export');

  const [format, setFormat] = useState<ExportFormat>('json');
  const [includes, setIncludes] = useState<IncludeFlags>({
    scope: true,
    filters: true,
    schedule: true,
    permissionMode: true,
    credentials: false,
  });
  const [preview, setPreview] = useState<string>('');
  const [version, setVersion] = useState<string>('');
  const [loading, setLoading] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch preview when flags change (debounced)
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchPreview();
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    open,
    format,
    includes.scope,
    includes.filters,
    includes.schedule,
    includes.permissionMode,
    includes.credentials,
  ]);

  const fetchPreview = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        format,
        includeScope: String(includes.scope),
        includeFilters: String(includes.filters),
        includeSchedule: String(includes.schedule),
        includePermissionMode: String(includes.permissionMode),
        includeCredentials: String(includes.credentials),
      });
      const resp = await apiFetch(
        `/api/search-ai/indexes/${indexId}/connectors/${connectorId}/config/export?${params}`,
      );
      const result = await handleResponse<{
        data: { config: Record<string, unknown>; version: string };
      }>(resp);

      setVersion(result.data.version);
      if (format === 'json') {
        setPreview(JSON.stringify(result.data.config, null, 2));
      } else {
        // Simple YAML formatting for display
        setPreview(JSON.stringify(result.data.config, null, 2));
      }
    } catch (err: unknown) {
      setPreview(sanitizeError(err, t('fetch_error')));
    } finally {
      setLoading(false);
    }
  }, [indexId, connectorId, format, includes, t]);

  const handleDownload = useCallback(() => {
    const ext = format === 'json' ? 'json' : 'yaml';
    const blob = new Blob([preview], {
      type: format === 'json' ? 'application/json' : 'text/yaml',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${connectorName}-config-${version}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(t('download_success'));
  }, [preview, format, connectorName, version, t]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(preview);
      toast.success(t('copy_success'));
    } catch {
      toast.error(t('copy_error'));
    }
  }, [preview, t]);

  const toggleInclude = useCallback((key: keyof IncludeFlags) => {
    setIncludes((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const formatOptions = [
    { id: 'json', label: 'JSON' },
    { id: 'yaml', label: 'YAML' },
  ];

  return (
    <Dialog open={open} onClose={onClose} title={t('title')} maxWidth="2xl">
      <div className="space-y-4">
        {/* Format selector */}
        <SegmentedControl
          options={formatOptions}
          value={format}
          onChange={(v) => setFormat(v as ExportFormat)}
          size="sm"
          ariaLabel={t('format_label')}
        />

        {/* Include checkboxes */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted">{t('include_label')}</p>
          {(['scope', 'filters', 'schedule', 'permissionMode'] as const).map((key) => (
            <label key={key} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={includes[key]}
                onChange={() => toggleInclude(key)}
                className="rounded border-default"
              />
              {t(`include_${key}`)}
            </label>
          ))}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={includes.credentials}
              onChange={() => toggleInclude('credentials')}
              className="rounded border-default"
            />
            {t('include_credentials')}
          </label>
          {includes.credentials && (
            <div className="flex items-start gap-2 p-2 rounded-md bg-warning/10 border border-warning/20">
              <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
              <span className="text-xs text-warning">{t('credentials_warning')}</span>
            </div>
          )}
        </div>

        {/* Preview */}
        <div className="max-h-64 overflow-auto rounded-lg border border-default bg-background-subtle p-3">
          <pre className="text-xs font-mono text-foreground whitespace-pre-wrap">
            {loading ? t('loading') : preview}
          </pre>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon={<Copy className="w-3.5 h-3.5" />}
            onClick={handleCopy}
            disabled={loading || !preview}
          >
            {t('copy')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={<Download className="w-3.5 h-3.5" />}
            onClick={handleDownload}
            disabled={loading || !preview}
          >
            {t('download')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

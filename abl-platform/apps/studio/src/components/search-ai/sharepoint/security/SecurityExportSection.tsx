/**
 * SecurityExportSection Component
 *
 * Export security review as JSON, YAML, or Markdown.
 */

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Download, Copy, FileJson } from 'lucide-react';
import { toast } from 'sonner';
import { sanitizeError } from '@/lib/sanitize-error';
import { Button } from '../../../ui/Button';
import { apiFetch, handleResponse } from '../../../../lib/api-client';

interface SecurityExportSectionProps {
  indexId: string;
  connectorId: string;
}

export function SecurityExportSection({ indexId, connectorId }: SecurityExportSectionProps) {
  const t = useTranslations('search_ai.sharepoint.security');
  const [exporting, setExporting] = useState(false);

  const handleExport = useCallback(
    async (format: 'json' | 'yaml' | 'markdown') => {
      setExporting(true);
      try {
        const resp = await apiFetch(
          `/api/search-ai/indexes/${indexId}/connectors/${connectorId}/security/export?format=${format}`,
        );
        const result = await handleResponse<{
          data: { contentType: string; data: string; filename: string };
        }>(resp);

        const blob = new Blob([result.data.data], { type: result.data.contentType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = result.data.filename;
        a.click();
        URL.revokeObjectURL(url);
        toast.success(t('export_success'));
      } catch (err: unknown) {
        toast.error(sanitizeError(err, t('export_error')));
      } finally {
        setExporting(false);
      }
    },
    [indexId, connectorId, t],
  );

  const handleCopyMarkdown = useCallback(async () => {
    try {
      const resp = await apiFetch(
        `/api/search-ai/indexes/${indexId}/connectors/${connectorId}/security/export?format=markdown`,
      );
      const result = await handleResponse<{
        data: { data: string };
      }>(resp);
      await navigator.clipboard.writeText(result.data.data);
      toast.success(t('export_copied'));
    } catch (err: unknown) {
      toast.error(sanitizeError(err, t('export_error')));
    }
  }, [indexId, connectorId, t]);

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
        <FileJson className="w-4 h-4 text-muted" />
        {t('export_title')}
      </h3>
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon={<Download className="w-3.5 h-3.5" />}
          onClick={() => handleExport('json')}
          disabled={exporting}
        >
          JSON
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon={<Download className="w-3.5 h-3.5" />}
          onClick={() => handleExport('yaml')}
          disabled={exporting}
        >
          YAML
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon={<Copy className="w-3.5 h-3.5" />}
          onClick={handleCopyMarkdown}
          disabled={exporting}
        >
          {t('export_copy_md')}
        </Button>
      </div>
    </div>
  );
}

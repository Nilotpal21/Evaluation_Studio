'use client';

/**
 * CsvExport Component
 *
 * Button that calls an async onExport callback to retrieve a CSV blob,
 * then triggers a browser download.
 */

import { useState, useCallback } from 'react';
import { Download, Loader2, AlertCircle } from 'lucide-react';
import { clsx } from 'clsx';
import { useTranslations } from 'next-intl';

interface CsvExportProps {
  /** Async function that resolves to a Blob (text/csv) */
  onExport: () => Promise<Blob>;
  /** Downloaded file name (default: "export.csv") */
  filename?: string;
  /** Button label override */
  label?: string;
  className?: string;
  disabled?: boolean;
}

export function CsvExport({
  onExport,
  filename = 'export.csv',
  label,
  className,
  disabled,
}: CsvExportProps) {
  const t = useTranslations('observability');
  const resolvedLabel = label ?? t('export.button');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClick = useCallback(async () => {
    if (loading || disabled) return;
    setLoading(true);
    setError(null);
    try {
      const blob = await onExport();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      // Cleanup
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message || 'Export failed');
    } finally {
      setLoading(false);
    }
  }, [onExport, filename, loading, disabled]);

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        onClick={handleClick}
        disabled={loading || disabled}
        className={clsx(
          'inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium',
          'border-default bg-background-subtle text-muted shadow-sm transition-default',
          'hover:text-foreground hover:bg-background-muted',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          className,
        )}
      >
        {loading ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Download className="w-3.5 h-3.5" />
        )}
        {resolvedLabel}
      </button>
      {error && (
        <span className="inline-flex items-center gap-1 text-xs text-error">
          <AlertCircle className="w-3 h-3" />
          {error}
        </span>
      )}
    </div>
  );
}

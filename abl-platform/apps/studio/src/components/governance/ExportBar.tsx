'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { FileText, FileDown } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../ui/Button';
import { apiFetch } from '../../lib/api-client';

interface ExportBarProps {
  projectId: string;
  period: string;
}

async function downloadBlob(
  projectId: string,
  period: string,
  format: 'csv' | 'pdf',
): Promise<void> {
  const ext = format;
  const url = `/api/runtime/governance/report.${ext}?projectId=${encodeURIComponent(projectId)}&period=${encodeURIComponent(period)}`;
  const res = await apiFetch(url);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      (err as { error?: { message?: string } })?.error?.message ?? `Export failed (${res.status})`,
    );
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = `governance-report-${period}.${ext}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(objectUrl);
}

export function ExportBar({ projectId, period }: ExportBarProps) {
  const t = useTranslations('governance');
  const [loadingCsv, setLoadingCsv] = useState(false);
  const [loadingPdf, setLoadingPdf] = useState(false);

  const handleCsv = async () => {
    setLoadingCsv(true);
    try {
      await downloadBlob(projectId, period, 'csv');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('export.csv_failed'));
    } finally {
      setLoadingCsv(false);
    }
  };

  const handlePdf = async () => {
    setLoadingPdf(true);
    try {
      await downloadBlob(projectId, period, 'pdf');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('export.pdf_failed'));
    } finally {
      setLoadingPdf(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="secondary"
        size="sm"
        icon={<FileText className="w-3.5 h-3.5" />}
        loading={loadingCsv}
        onClick={handleCsv}
      >
        {t('export.csv')}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        icon={<FileDown className="w-3.5 h-3.5" />}
        loading={loadingPdf}
        onClick={handlePdf}
      >
        {t('export.pdf')}
      </Button>
    </div>
  );
}

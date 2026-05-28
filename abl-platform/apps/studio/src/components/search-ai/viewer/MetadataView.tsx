'use client';

import { useTranslations } from 'next-intl';

interface MetadataViewProps {
  sourceMetadata: Record<string, unknown>;
  status: string;
  createdAt: string;
  updatedAt?: string;
  contentSizeBytes: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function MetadataView({
  sourceMetadata,
  status,
  createdAt,
  updatedAt,
  contentSizeBytes,
}: MetadataViewProps) {
  const t = useTranslations('search_ai.viewer');
  return (
    <div className="h-full overflow-y-auto p-5 space-y-6">
      {/* Document info */}
      <section>
        <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-3">
          {t('document_info')}
        </h3>
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted">{t('status')}</dt>
            <dd className="text-foreground capitalize">{status}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">{t('size')}</dt>
            <dd className="text-foreground">{formatBytes(contentSizeBytes)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">{t('crawled')}</dt>
            <dd className="text-foreground">{new Date(createdAt).toLocaleString()}</dd>
          </div>
          {updatedAt && (
            <div className="flex justify-between">
              <dt className="text-muted">{t('updated')}</dt>
              <dd className="text-foreground">{new Date(updatedAt).toLocaleString()}</dd>
            </div>
          )}
        </dl>
      </section>

      {/* Source metadata */}
      <section>
        <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-3">
          {t('source_metadata')}
        </h3>
        <pre className="text-xs bg-surface-elevated rounded-lg p-4 overflow-x-auto text-foreground-subtle">
          {JSON.stringify(sourceMetadata, null, 2)}
        </pre>
      </section>
    </div>
  );
}

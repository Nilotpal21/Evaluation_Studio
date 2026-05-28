'use client';

import { useTranslations } from 'next-intl';

interface OriginalPageViewProps {
  rawHtmlUrl: string | null;
  fallbackHtml: string | null;
}

export function OriginalPageView({ rawHtmlUrl, fallbackHtml }: OriginalPageViewProps) {
  const t = useTranslations('search_ai.viewer');
  if (!rawHtmlUrl && !fallbackHtml) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted">
        {t('no_original_html')}
      </div>
    );
  }

  // Use sandboxed iframe for both URL and inline HTML to prevent XSS
  const src =
    rawHtmlUrl ?? `data:text/html;charset=utf-8,${encodeURIComponent(fallbackHtml ?? '')}`;

  return (
    <iframe
      src={src}
      className="w-full h-full border-0"
      title={t('original_page_title')}
      sandbox="allow-same-origin"
    />
  );
}

/**
 * DefaultPipelineBanner — Info banner shown when the default pipeline view is active.
 *
 * Displays a message explaining that stages are locked and can be extended
 * using the + buttons. Dismissable via a small close button.
 */

'use client';

import { useState } from 'react';
import { Lock, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

export function DefaultPipelineBanner() {
  const t = useTranslations('search_ai.pipeline');
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-info-subtle text-info text-sm">
      <Lock className="w-4 h-4 shrink-0" />
      <span className="flex-1">{t('v2_banner_default')}</span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="shrink-0 p-0.5 rounded hover:bg-info/10 transition-default"
        aria-label={t('v2_banner_dismiss')}
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

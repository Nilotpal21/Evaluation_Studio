/**
 * AccessSummarySection Component
 *
 * Two-column display of what the connector accesses and does not access.
 */

import { useTranslations } from 'next-intl';
import { CheckCircle2, XCircle } from 'lucide-react';

interface AccessSummarySectionProps {
  accesses: string[];
  doesNotAccess: string[];
}

export function AccessSummarySection({ accesses, doesNotAccess }: AccessSummarySectionProps) {
  const t = useTranslations('search_ai.sharepoint.security');

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground">{t('access_title')}</h3>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <p className="text-xs font-medium text-success">{t('access_can')}</p>
          {accesses.map((item) => (
            <div key={item} className="flex items-center gap-2">
              <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0" />
              <span className="text-sm text-foreground">{item}</span>
            </div>
          ))}
        </div>
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted">{t('access_cannot')}</p>
          {doesNotAccess.map((item) => (
            <div key={item} className="flex items-center gap-2">
              <XCircle className="w-3.5 h-3.5 text-muted shrink-0" />
              <span className="text-sm text-muted">{item}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

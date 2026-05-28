/**
 * SavePreferenceDialog Component
 *
 * Dialog for saving the current crawl configuration as a reusable preference.
 * Extracts a default domain pattern from the URL and lets users adjust it.
 */

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import useSWRMutation from 'swr/mutation';
import { mutate } from 'swr';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { saveCrawlPreference } from '@/api/crawl';

interface SavePreferenceDialogProps {
  open: boolean;
  onClose: () => void;
  url: string;
  suggestedStrategy?: string;
}

/**
 * Extract a sensible domain pattern from a URL.
 * "https://docs.example.com/foo" -> "*.docs.example.com"
 */
function derivePattern(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    // If subdomain exists, wildcard at top; otherwise wildcard sub
    const parts = hostname.split('.');
    if (parts.length > 2) {
      return `*.${parts.slice(1).join('.')}`;
    }
    return `*.${hostname}`;
  } catch {
    return '';
  }
}

export function SavePreferenceDialog({
  open,
  onClose,
  url,
  suggestedStrategy,
}: SavePreferenceDialogProps) {
  const t = useTranslations('search_ai.save_pref_dialog');
  const defaultPattern = useMemo(() => derivePattern(url), [url]);

  const strategyOptions = useMemo(
    () => [
      { value: 'hybrid', label: t('strategy_hybrid') },
      { value: 'bulk', label: t('strategy_bulk') },
      { value: 'browser', label: t('strategy_browser') },
    ],
    [t],
  );

  const [domainPattern, setDomainPattern] = useState(defaultPattern);
  const [strategy, setStrategy] = useState<'browser' | 'bulk' | 'hybrid'>(
    (suggestedStrategy as 'browser' | 'bulk' | 'hybrid') || 'hybrid',
  );
  const [autoDecide, setAutoDecide] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { trigger, isMutating } = useSWRMutation(
    'save-crawl-preference',
    async () =>
      saveCrawlPreference({
        domainPattern: domainPattern.toLowerCase().trim(),
        strategy,
        autoDecide,
      }),
    {
      onSuccess: () => {
        mutate('crawl-preferences');
        onClose();
      },
      onError: (err) => {
        setError(err instanceof Error ? err.message : t('save_failed'));
      },
    },
  );

  const handleSave = () => {
    if (!domainPattern.trim()) {
      setError(t('domain_required'));
      return;
    }
    setError(null);
    trigger();
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('title')} maxWidth="sm">
      <div className="space-y-4">
        <Input
          label={t('domain_pattern_label')}
          value={domainPattern}
          onChange={(e) => setDomainPattern(e.target.value)}
          placeholder="*.example.com"
          error={!domainPattern.trim() ? t('required') : undefined}
        />
        <p className="text-xs text-muted -mt-2">{t('domain_pattern_hint')}</p>

        <Select
          label={t('strategy_label')}
          options={strategyOptions}
          value={strategy}
          onChange={(v) => setStrategy(v as 'browser' | 'bulk' | 'hybrid')}
        />

        <Checkbox
          checked={autoDecide}
          onChange={setAutoDecide}
          label={t('auto_start_label')}
          description={t('auto_start_description')}
        />

        {error && <Alert variant="error">{error}</Alert>}

        <div className="flex items-center justify-end gap-3 pt-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={handleSave}
            loading={isMutating}
            disabled={!domainPattern.trim()}
          >
            {t('save')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

'use client';

/**
 * ApiKeysPanel Component
 *
 * Slide-out panel for managing personal API keys.
 * Wraps the ApiKeysPage content in a SlidePanel.
 */

import { useTranslations } from 'next-intl';
import { SlidePanel } from '../ui/SlidePanel';
import { ApiKeysPage } from './ApiKeysPage';

interface ApiKeysPanelProps {
  open: boolean;
  onClose: () => void;
}

export function ApiKeysPanel({ open, onClose }: ApiKeysPanelProps) {
  const t = useTranslations('settings.personal_api_keys');
  return (
    <SlidePanel
      open={open}
      onClose={onClose}
      title={t('title')}
      description={t('description')}
      width="md"
    >
      <ApiKeysPageInline />
    </SlidePanel>
  );
}

/**
 * Inline version of ApiKeysPage without the outer header
 * (the SlidePanel provides its own header).
 */
function ApiKeysPageInline() {
  return (
    <div className="-mx-6 -mt-6">
      <ApiKeysPage hideHeader />
    </div>
  );
}

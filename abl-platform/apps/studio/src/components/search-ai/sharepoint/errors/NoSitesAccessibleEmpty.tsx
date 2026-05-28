'use client';

/**
 * NoSitesAccessibleEmpty (EM3)
 *
 * Shown when Sites.Selected scope has 0 approved sites.
 * Three options: enter URL manually, request admin access, upgrade scope.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Globe } from 'lucide-react';
import { EmptyState } from '../../../ui/EmptyState';
import { Input } from '../../../ui/Input';
import { Button } from '../../../ui/Button';

interface NoSitesAccessibleEmptyProps {
  currentPermissionScope: string;
  onCheckAccess: (siteUrl: string) => void;
  onSendRequestToAdmin: () => void;
  onUpgradeScope: () => void;
}

export function NoSitesAccessibleEmpty({
  currentPermissionScope,
  onCheckAccess,
  onSendRequestToAdmin,
  onUpgradeScope,
}: NoSitesAccessibleEmptyProps) {
  const t = useTranslations('search_ai.sharepoint.empty');
  const [siteUrl, setSiteUrl] = useState('');

  return (
    <div className="space-y-4">
      <EmptyState
        icon={<Globe className="w-6 h-6" />}
        title={t('no_sites_title')}
        description={t('no_sites_description')}
      />

      <div className="px-6 space-y-6">
        <p className="text-xs text-muted">{t('no_sites_count', { count: 0 })}</p>

        {/* Option 1: Enter URL */}
        <div className="space-y-2">
          <p className="text-sm text-foreground">1. {t('no_sites_option1')}</p>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Input
                placeholder={t('no_sites_url_placeholder')}
                value={siteUrl}
                onChange={(e) => setSiteUrl(e.target.value)}
                aria-label={t('btn_check_access')}
              />
            </div>
            <Button
              variant="secondary"
              size="sm"
              disabled={!siteUrl}
              onClick={() => onCheckAccess(siteUrl)}
            >
              {t('btn_check_access')}
            </Button>
          </div>
        </div>

        {/* Option 2: Request admin */}
        <div className="space-y-2">
          <p className="text-sm text-foreground">2. {t('no_sites_option2')}</p>
          <p className="text-xs text-muted">{t('no_sites_admin_note')}</p>
          <Button variant="secondary" size="sm" onClick={onSendRequestToAdmin}>
            {t('btn_send_request_admin')}
          </Button>
        </div>

        {/* Option 3: Upgrade scope */}
        <div className="space-y-2">
          <p className="text-sm text-foreground">3. {t('no_sites_option3')}</p>
          <p className="text-xs text-muted">{t('no_sites_upgrade_note')}</p>
          <Button variant="secondary" size="sm" onClick={onUpgradeScope}>
            {t('btn_upgrade_to_read_all')}
            <span className="text-xs text-muted ml-1">({t('no_sites_upgrade_consent')})</span>
          </Button>
        </div>
      </div>
    </div>
  );
}

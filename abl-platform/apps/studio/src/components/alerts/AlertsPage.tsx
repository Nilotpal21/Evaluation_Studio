'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Bell, CheckCircle } from 'lucide-react';
import { UnifiedInboxPage } from '../inbox/UnifiedInboxPage';
import { PageHeader } from '../ui/PageHeader';
import { Tabs } from '../ui/Tabs';
import { EmptyState } from '../ui/EmptyState';

type AlertTab = 'approvals' | 'alerts';

export function AlertsPage() {
  const t = useTranslations('alerts');
  const [activeTab, setActiveTab] = useState<AlertTab>('approvals');

  return (
    <div className="h-full overflow-y-auto bg-noise">
      <div className="max-w-5xl mx-auto px-6 py-8">
        <PageHeader title={t('title')} description={t('subtitle')} />

        <Tabs
          tabs={[
            {
              id: 'approvals',
              label: t('tab.approvals'),
              icon: <CheckCircle className="w-3.5 h-3.5" />,
            },
            { id: 'alerts', label: t('tab.alert_rules'), icon: <Bell className="w-3.5 h-3.5" /> },
          ]}
          activeTab={activeTab}
          onTabChange={(id) => setActiveTab(id as AlertTab)}
          layoutId="alerts-tabs"
          className="mt-6"
        />

        {/* Tab content */}
        <div className="mt-6">
          {activeTab === 'approvals' ? (
            <UnifiedInboxPage />
          ) : (
            <EmptyState
              icon={<Bell className="w-6 h-6" />}
              title={t('empty_rules.title')}
              description={t('empty_rules.description')}
            />
          )}
        </div>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Key, Settings, Shield } from 'lucide-react';
import { PageHeader } from '../ui/PageHeader';
import { Tabs } from '../ui/Tabs';
import { KMSConfigForm } from './KMSConfigForm';
import { KMSAuditTab } from './KMSAuditTab';
import { KMSKeysTab } from './KMSKeysTab';
import { KMSHealthBar } from './KMSHealthBar';

export function KMSPage() {
  const t = useTranslations('admin');
  const [activeTab, setActiveTab] = useState('config');

  const tabs = [
    { id: 'config', label: t('kms.tabs.config'), icon: <Settings className="h-4 w-4" /> },
    { id: 'keys', label: t('kms.tabs.keys'), icon: <Key className="h-4 w-4" /> },
    { id: 'audit', label: t('kms.tabs.audit'), icon: <Shield className="h-4 w-4" /> },
  ];

  return (
    <div className="h-full overflow-y-auto bg-noise">
      <div className="mx-auto max-w-5xl px-6 py-8">
        <PageHeader title={t('kms.title')} description={t('kms.description')} />

        <div className="mt-6">
          <KMSHealthBar />
        </div>

        <div>
          <Tabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} layoutId="kms-tabs" />
        </div>

        <div className="mt-6">
          {activeTab === 'config' && <KMSConfigForm />}
          {activeTab === 'keys' && <KMSKeysTab />}
          {activeTab === 'audit' && <KMSAuditTab />}
        </div>
      </div>
    </div>
  );
}

/**
 * DeploymentsPage Component
 *
 * Tabbed page for the deployment pipeline:
 * - Environments: environment cards with active deployments
 * - Channels: SDK channel management
 * - API Keys: Public API key CRUD
 */

import { useState, useCallback } from 'react';
import { Rocket, Radio, Key } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useNavigationStore } from '../../store/navigation-store';
import { ListPageShell } from '../ui/ListPageShell';
import { EmptyState } from '../ui/EmptyState';
import { Tabs } from '../ui/Tabs';
import { EnvironmentsTab } from './EnvironmentsTab';
import { ChannelsTab } from './ChannelsTab';
import { ApiKeysTab } from '../settings/ApiKeysTab';

export function DeploymentsPage() {
  const t = useTranslations('deployments');
  const { projectId } = useNavigationStore();
  const [activeTab, setActiveTab] = useState('environments');
  const [channelExpanded, setChannelExpanded] = useState(false);

  const TABS = [
    { id: 'environments', label: t('tabs.environments'), icon: <Rocket className="w-3.5 h-3.5" /> },
    { id: 'channels', label: t('tabs.channels'), icon: <Radio className="w-3.5 h-3.5" /> },
    { id: 'keys', label: t('tabs.api_keys'), icon: <Key className="w-3.5 h-3.5" /> },
  ];

  const handleChannelExpanded = useCallback((expanded: boolean) => {
    setChannelExpanded(expanded);
  }, []);

  if (!projectId) {
    return (
      <ListPageShell title={t('title')}>
        <div className="mt-8">
          <EmptyState
            icon={<Rocket className="w-6 h-6" />}
            title={t('no_project')}
            description={t('no_project_description')}
          />
        </div>
      </ListPageShell>
    );
  }

  return (
    <ListPageShell title={t('title')} description={t('description')}>
      <Tabs
        tabs={TABS}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        layoutId="deployments-tabs"
      />

      <div className="mt-6">
        {activeTab === 'environments' && <EnvironmentsTab projectId={projectId} />}
        {activeTab === 'channels' && (
          <ChannelsTab projectId={projectId} onExpanded={handleChannelExpanded} />
        )}
        {activeTab === 'keys' && <ApiKeysTab />}
      </div>
    </ListPageShell>
  );
}

/**
 * ProjectSettingsPage Component
 *
 * Shell wrapper for project settings sub-pages (left-nav driven).
 * Provides title + layout via DetailPageShell; sidebar handles navigation.
 */

import { useTranslations } from 'next-intl';
import { useNavigationStore } from '../../store/navigation-store';
import { DetailPageShell } from '../ui/DetailPageShell';
import { ProjectMembersTab } from './ProjectMembersTab';
import { ApiKeysTab } from './ApiKeysTab';
import { ModelConfigTab } from './ModelConfigTab';
import { ConfigVariablesTab } from './ConfigVariablesTab';
import { LocalizationSettingsPage } from './LocalizationSettingsPage';
import { GitIntegrationTab } from './GitIntegrationTab';
import { AdvancedSettingsTab } from './AdvancedSettingsTab';
import { RuntimeConfigTab } from './RuntimeConfigTab';
import { TraceDimensionsTab } from './TraceDimensionsTab';
import { AgentTransferSettingsPage } from './AgentTransferSettingsPage';
import { AgentAssistSettingsPage } from './AgentAssistSettingsPage';
import { PIIProtectionTab } from './PIIProtectionTab';
import { PublicApiAccessTab } from './PublicApiAccessTab';

export function ProjectSettingsPage() {
  const t = useTranslations('settings');
  const { page } = useNavigationStore();

  // Derive active sub-page from sidebar page ID (e.g. 'settings-members' → 'members')
  const active = page?.startsWith('settings-') ? page.replace('settings-', '') : 'members';

  return (
    <DetailPageShell title={t('title')} maxWidth="md">
      {active === 'members' && <ProjectMembersTab />}
      {active === 'api-keys' && <ApiKeysTab />}
      {active === 'models' && <ModelConfigTab />}
      {active === 'config-vars' && <ConfigVariablesTab />}
      {active === 'localization' && <LocalizationSettingsPage />}
      {active === 'git' && <GitIntegrationTab />}
      {active === 'advanced' && <AdvancedSettingsTab />}
      {active === 'runtime-config' && <RuntimeConfigTab />}
      {active === 'trace-dimensions' && <TraceDimensionsTab />}
      {active === 'agent-transfer' && <AgentTransferSettingsPage />}
      {active === 'agent-assist' && <AgentAssistSettingsPage />}
      {active === 'pii-protection' && <PIIProtectionTab />}
      {active === 'public-api' && <PublicApiAccessTab />}
    </DetailPageShell>
  );
}

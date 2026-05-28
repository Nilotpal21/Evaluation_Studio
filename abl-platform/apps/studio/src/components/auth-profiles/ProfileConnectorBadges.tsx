/**
 * Connector and usage-mode badge strip rendered per profile row in
 * AuthProfilesPage. Extracted as a pure component so the rendering
 * logic for FR-11 can be tested without mounting the full page.
 */

import { Badge } from '../ui/Badge';
import { AUTH_PROFILE_USAGE_MODE_OPTIONS } from './auth-type-metadata';
import type { AuthProfileUsageMode } from '@/api/auth-profiles';

interface Props {
  connector: string | undefined;
  authType: string;
  usageMode: AuthProfileUsageMode | undefined;
  t: (key: string) => string;
}

export function ProfileConnectorBadges({ connector, authType, usageMode, t }: Props) {
  return (
    <>
      <Badge variant="default">{connector || t('integrations.custom_badge')}</Badge>
      {authType === 'oauth2_app' && usageMode && (
        <Badge variant="default">
          {AUTH_PROFILE_USAGE_MODE_OPTIONS[usageMode]?.label ?? usageMode}
        </Badge>
      )}
    </>
  );
}

/**
 * TemplateSecurityGate Component
 *
 * Permission acknowledgment gate shown when cloning/applying a template
 * that has permission-aware search enabled.
 */

import { useTranslations } from 'next-intl';
import { Shield } from 'lucide-react';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { TypeToConfirmInput } from '../../ui/TypeToConfirmInput';
import { useState } from 'react';

interface TemplateSecurityGateProps {
  sourceName: string;
  sourcePermissionMode: 'enabled' | 'public_access';
  requiredScopes: string[];
  onContinueWithPermissions: () => void;
  onDisablePermissions: (confirmPhrase: string) => void;
  onCancel: () => void;
}

export function TemplateSecurityGate({
  sourceName,
  sourcePermissionMode,
  requiredScopes,
  onContinueWithPermissions,
  onDisablePermissions,
  onCancel,
}: TemplateSecurityGateProps) {
  const t = useTranslations('search_ai.sharepoint.multi_connector');
  const [showDisableConfirm, setShowDisableConfirm] = useState(false);

  if (sourcePermissionMode !== 'enabled') {
    // No gate needed for public access
    return null;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Shield className="w-5 h-5 text-warning" />
        <h3 className="text-sm font-semibold text-foreground">{t('security_gate_title')}</h3>
      </div>

      <div className="p-3 rounded-lg bg-warning/5 border border-warning/20 space-y-2">
        <p className="text-sm text-foreground">{t('security_gate_source', { name: sourceName })}</p>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">{t('security_gate_mode')}:</span>
          <Badge variant="warning">{t('security_gate_enabled')}</Badge>
        </div>
        {requiredScopes.length > 0 && (
          <div className="space-y-1 mt-2">
            <p className="text-xs font-medium text-muted">{t('security_gate_scopes')}:</p>
            {requiredScopes.map((scope) => (
              <Badge key={scope} variant="info" className="mr-1">
                {scope}
              </Badge>
            ))}
          </div>
        )}
      </div>

      {!showDisableConfirm ? (
        <div className="flex items-center gap-2">
          <Button variant="primary" size="sm" onClick={onContinueWithPermissions}>
            {t('security_gate_continue')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setShowDisableConfirm(true)}>
            {t('security_gate_disable')}
          </Button>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t('security_gate_cancel')}
          </Button>
        </div>
      ) : (
        <TypeToConfirmInput
          confirmText="DISABLE"
          onConfirm={() => onDisablePermissions('DISABLE')}
          onCancel={() => setShowDisableConfirm(false)}
          warningMessage={t('security_gate_disable_warning')}
          consequences={[
            t('security_gate_disable_consequence_1'),
            t('security_gate_disable_consequence_2'),
          ]}
          confirmLabel={t('security_gate_disable_confirm')}
          variant="danger"
        />
      )}
    </div>
  );
}

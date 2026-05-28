'use client';

/**
 * ProposalPermissionsSection
 *
 * Displays permission configuration: mode, permission-aware status,
 * reduced accuracy warning, and type-to-confirm disable flow.
 */

import { useState } from 'react';
import { Shield, AlertTriangle } from 'lucide-react';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { TypeToConfirmInput } from '../../ui/TypeToConfirmInput';

interface ProposalPermissionsSectionProps {
  mode: string;
  permissionAwareEnabled: boolean;
  reducedAccuracy: boolean;
  warning: string | null;
  onDisablePermissions?: (confirmationText: string) => void;
  disableLoading?: boolean;
  labels: {
    mode_label: string;
    mode_enabled: string;
    mode_disabled: string;
    permission_aware_label: string;
    enabled: string;
    disabled: string;
    reduced_accuracy_warning: string;
    disable_link: string;
    disable_warning: string;
    disable_confirm_text: string;
    disable_consequences: string[];
    cancel: string;
    confirm_disable: string;
    trust_note: string;
  };
}

export function ProposalPermissionsSection({
  mode,
  permissionAwareEnabled,
  reducedAccuracy,
  warning,
  onDisablePermissions,
  disableLoading,
  labels,
}: ProposalPermissionsSectionProps) {
  const [showDisableFlow, setShowDisableFlow] = useState(false);

  return (
    <div className="space-y-3">
      {/* Mode */}
      <div className="flex items-center gap-2">
        <Shield className="w-4 h-4 text-accent flex-shrink-0" />
        <span className="text-sm text-muted">{labels.mode_label}:</span>
        <Badge variant={mode === 'enabled' ? 'success' : 'warning'}>
          {mode === 'enabled' ? labels.mode_enabled : labels.mode_disabled}
        </Badge>
      </div>

      {/* Permission-aware status */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted">{labels.permission_aware_label}:</span>
        <Badge variant={permissionAwareEnabled ? 'success' : 'error'}>
          {permissionAwareEnabled ? labels.enabled : labels.disabled}
        </Badge>
      </div>

      {/* Reduced accuracy warning */}
      {reducedAccuracy && warning && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-warning-subtle">
          <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
          <span className="text-xs text-warning">{warning}</span>
        </div>
      )}

      {/* Trust note */}
      <p className="text-xs text-muted">{labels.trust_note}</p>

      {/* Disable flow */}
      {permissionAwareEnabled && onDisablePermissions && (
        <>
          {!showDisableFlow ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setShowDisableFlow(true)}
              className="text-warning hover:text-warning/80"
            >
              <Shield className="w-3 h-3" />
              {labels.disable_link}
            </Button>
          ) : (
            <TypeToConfirmInput
              confirmText={labels.disable_confirm_text}
              onConfirm={() => onDisablePermissions(labels.disable_confirm_text)}
              onCancel={() => setShowDisableFlow(false)}
              warningMessage={labels.disable_warning}
              consequences={labels.disable_consequences}
              confirmLabel={labels.confirm_disable}
              cancelLabel={labels.cancel}
              variant="danger"
              loading={disableLoading}
            />
          )}
        </>
      )}
    </div>
  );
}

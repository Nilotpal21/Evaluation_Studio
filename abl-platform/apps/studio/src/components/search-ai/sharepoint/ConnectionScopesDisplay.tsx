'use client';

/**
 * ConnectionScopesDisplay
 *
 * Read-only scopes checklist with optional type-to-confirm disable flow
 * for permission-aware search. Reusable in Connect tab and Proposal tab.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle2, Shield, ChevronDown, ChevronRight, Info } from 'lucide-react';
import { clsx } from 'clsx';
import { TypeToConfirmInput } from '../../ui/TypeToConfirmInput';
import { Button } from '../../ui/Button';

interface ConnectionScopesDisplayProps {
  permissionAwareEnabled: boolean;
  onDisablePermissionAware: () => void;
  disabledBy?: { email: string; date: string } | null;
  /** Compact mode for inline display within other sections */
  compact?: boolean;
}

const BASE_SCOPES = [
  'scopes_base_sites_read',
  'scopes_base_files_read',
  'scopes_base_user_read',
] as const;

const PERMISSION_SCOPES = [
  'scopes_permission_group_read',
  'scopes_permission_directory_read',
] as const;

export function ConnectionScopesDisplay({
  permissionAwareEnabled,
  onDisablePermissionAware,
  disabledBy,
  compact = false,
}: ConnectionScopesDisplayProps) {
  const t = useTranslations('search_ai.sharepoint.connect');
  const [showDisableFlow, setShowDisableFlow] = useState(false);

  return (
    <div className={clsx('space-y-4', compact && 'space-y-3')}>
      {/* Base scopes */}
      <div>
        <h4
          className={clsx(
            'font-medium text-foreground',
            compact ? 'text-xs mb-1.5' : 'text-sm mb-2',
          )}
        >
          {t('scopes_base_title')}
        </h4>
        <ul className={clsx('space-y-1.5', compact && 'space-y-1')}>
          {BASE_SCOPES.map((key) => (
            <li key={key} className="flex items-center gap-2">
              <CheckCircle2
                className={clsx('text-success shrink-0', compact ? 'w-3.5 h-3.5' : 'w-4 h-4')}
              />
              <span className={clsx('text-muted', compact ? 'text-xs' : 'text-sm')}>{t(key)}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Permission-aware scopes */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Shield className={clsx('text-accent shrink-0', compact ? 'w-3.5 h-3.5' : 'w-4 h-4')} />
          <h4 className={clsx('font-medium text-foreground', compact ? 'text-xs' : 'text-sm')}>
            {t('scopes_permission_aware_title')}
          </h4>
        </div>
        <p className={clsx('text-muted mb-2', compact ? 'text-xs' : 'text-sm')}>
          {t('scopes_permission_aware_description')}
        </p>

        {permissionAwareEnabled ? (
          <>
            <ul className={clsx('space-y-1.5 mb-3', compact && 'space-y-1')}>
              {PERMISSION_SCOPES.map((key) => (
                <li key={key} className="flex items-center gap-2">
                  <CheckCircle2
                    className={clsx('text-success shrink-0', compact ? 'w-3.5 h-3.5' : 'w-4 h-4')}
                  />
                  <span className={clsx('text-muted', compact ? 'text-xs' : 'text-sm')}>
                    {t(key)}
                  </span>
                </li>
              ))}
            </ul>

            {/* Disable permission-aware search */}
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setShowDisableFlow(!showDisableFlow)}
              className="text-warning hover:text-warning/80"
            >
              <Shield className="w-3 h-3" />
              {showDisableFlow ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
              {t('scopes_disable_link')}
            </Button>

            {showDisableFlow && (
              <div className="mt-3 p-3 rounded-lg border border-warning/30 bg-warning/5">
                <TypeToConfirmInput
                  confirmText="public access"
                  onConfirm={() => {
                    onDisablePermissionAware();
                    setShowDisableFlow(false);
                  }}
                  onCancel={() => setShowDisableFlow(false)}
                  warningMessage={t('scopes_disabled_warning')}
                  confirmLabel={t('scopes_confirm_disable')}
                  variant="warning"
                />
              </div>
            )}
          </>
        ) : (
          <div
            className={clsx(
              'rounded-lg border border-warning bg-warning-subtle px-3 py-2',
              compact ? 'text-xs' : 'text-sm',
            )}
          >
            <p className="text-foreground">{t('scopes_disabled_warning')}</p>
            {disabledBy && (
              <p className="text-muted mt-1">
                {t('scopes_disabled_by', { email: disabledBy.email, date: disabledBy.date })}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Trust note */}
      <div
        className={clsx(
          'flex items-start gap-2 rounded-lg bg-info-subtle px-3 py-2',
          compact ? 'text-xs' : 'text-sm',
        )}
      >
        <Info className="w-3.5 h-3.5 text-info shrink-0 mt-0.5" />
        <p className="text-muted">{t('scopes_trust_note')}</p>
      </div>
    </div>
  );
}

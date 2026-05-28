'use client';

/**
 * AuthMethodSelector
 *
 * Two-step auth selection:
 * Step 1: Two big cards — "Azure App Registration" or "Sign in with Microsoft"
 * Step 2: When "Azure App Registration" is selected, show 3 specific auth methods
 *         (Device Code, Browser Login, Client Credentials) as radio options.
 *         When "Sign in with Microsoft" is selected, automatically use authorization_code.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Building2, LogIn, MonitorSmartphone, Globe, Key } from 'lucide-react';
import { clsx } from 'clsx';

export type AuthMethod = 'device_code' | 'authorization_code' | 'client_credentials';
type ApproachCard = 'app_registration' | 'microsoft_signin';

interface AuthMethodSelectorProps {
  selectedMethod: AuthMethod | null;
  onMethodChange: (method: AuthMethod) => void;
}

const SPECIFIC_AUTH_OPTIONS: {
  value: AuthMethod;
  titleKey: string;
  descKey: string;
  requiresSecret: boolean;
  icon: React.ReactNode;
}[] = [
  {
    value: 'device_code',
    titleKey: 'auth_device_code_title',
    descKey: 'auth_device_code_desc',
    requiresSecret: false,
    icon: <MonitorSmartphone className="w-4 h-4" />,
  },
  {
    value: 'authorization_code',
    titleKey: 'auth_browser_login_title',
    descKey: 'auth_browser_login_desc',
    requiresSecret: true,
    icon: <Globe className="w-4 h-4" />,
  },
  {
    value: 'client_credentials',
    titleKey: 'auth_client_credentials_title',
    descKey: 'auth_client_credentials_desc',
    requiresSecret: true,
    icon: <Key className="w-4 h-4" />,
  },
];

export function AuthMethodSelector({ selectedMethod, onMethodChange }: AuthMethodSelectorProps) {
  const t = useTranslations('search_ai.sharepoint.connect');
  const [selectedApproach, setSelectedApproach] = useState<ApproachCard | null>(() => {
    // Infer approach from existing method
    if (!selectedMethod) return null;
    if (selectedMethod === 'authorization_code') return null; // could be either
    return 'app_registration';
  });

  const handleApproachSelect = (approach: ApproachCard) => {
    setSelectedApproach(approach);
    if (approach === 'microsoft_signin') {
      // Sign in with Microsoft → directly use authorization_code
      onMethodChange('authorization_code');
    }
  };

  return (
    <div className="space-y-4">
      {/* Step 1: Two big cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* Azure App Registration */}
        <button
          type="button"
          onClick={() => handleApproachSelect('app_registration')}
          className={clsx(
            'flex flex-col items-center text-center gap-3 p-5 rounded-xl border-2 transition-default',
            selectedApproach === 'app_registration'
              ? 'border-accent bg-accent/5'
              : 'border-default hover:border-accent/40',
          )}
        >
          <Building2
            className={clsx(
              'w-7 h-7',
              selectedApproach === 'app_registration' ? 'text-accent' : 'text-muted',
            )}
          />
          <div>
            <p className="text-sm font-semibold text-foreground">
              {t('auth_app_registration_title')}
            </p>
            <p className="text-xs text-muted mt-1">{t('auth_app_registration_subtitle')}</p>
          </div>
        </button>

        {/* Sign in with Microsoft */}
        <button
          type="button"
          onClick={() => handleApproachSelect('microsoft_signin')}
          className={clsx(
            'flex flex-col items-center text-center gap-3 p-5 rounded-xl border-2 transition-default',
            selectedApproach === 'microsoft_signin'
              ? 'border-accent bg-accent/5'
              : 'border-default hover:border-accent/40',
          )}
        >
          <LogIn
            className={clsx(
              'w-7 h-7',
              selectedApproach === 'microsoft_signin' ? 'text-accent' : 'text-muted',
            )}
          />
          <div>
            <p className="text-sm font-semibold text-foreground">
              {t('auth_microsoft_signin_title')}
            </p>
            <p className="text-xs text-muted mt-1">{t('auth_microsoft_signin_subtitle')}</p>
          </div>
        </button>
      </div>

      {/* Step 2: When Azure App Registration is selected, show specific auth methods */}
      {selectedApproach === 'app_registration' && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted">{t('step_auth_method')}</p>
          {SPECIFIC_AUTH_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => onMethodChange(opt.value)}
              className={clsx(
                'w-full flex items-start gap-3 px-4 py-3 rounded-lg border text-left transition-default text-sm',
                selectedMethod === opt.value
                  ? 'border-accent bg-accent/5 text-foreground'
                  : 'border-default bg-background-subtle text-muted hover:text-foreground hover:bg-background-elevated',
              )}
            >
              <span
                className={clsx(
                  'w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5',
                  selectedMethod === opt.value ? 'border-accent' : 'border-default',
                )}
              >
                {selectedMethod === opt.value && (
                  <span className="w-2 h-2 rounded-full bg-accent" />
                )}
              </span>
              <span
                className={clsx(
                  'shrink-0 mt-0.5',
                  selectedMethod === opt.value ? 'text-accent' : 'text-muted',
                )}
              >
                {opt.icon}
              </span>
              <div className="flex-1 min-w-0">
                <div className="font-medium">{t(opt.titleKey)}</div>
                <div className="text-xs text-muted mt-0.5">{t(opt.descKey)}</div>
                {!opt.requiresSecret && (
                  <span className="inline-block text-[10px] text-success bg-success/10 px-1.5 py-0.5 rounded mt-1">
                    {t('auth_no_secret_needed')}
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

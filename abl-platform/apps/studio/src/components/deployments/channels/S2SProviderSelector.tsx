/**
 * S2S Provider Selector
 *
 * Displays configured S2S providers for channel selection.
 * Only shows providers that have been configured in Voice Services.
 */

'use client';

import { useState, useEffect } from 'react';
import { Info, AlertCircle, Loader2 } from 'lucide-react';
import {
  getS2STelephonySupport,
  getS2STelephonySupportMessage,
  getVoiceProviderLabel,
} from '@agent-platform/config/constants/voice-providers';
import { listVoiceServices, type VoiceServiceInstance } from '../../../api/voice-services';
import { useAuthStore } from '../../../store/auth-store';
import { sanitizeError } from '../../../lib/sanitize-error';
import { isSupportedStudioS2SProvider } from './s2s-provider-config';

interface S2SProviderSelectorProps {
  value: string | undefined;
  onChange: (provider: string) => void;
}

function getSelectableProviders(services: VoiceServiceInstance[]): VoiceServiceInstance[] {
  const providersByType = new Map<string, VoiceServiceInstance>();

  for (const service of services) {
    if (!service.isActive || !isSupportedStudioS2SProvider(service.serviceType)) {
      continue;
    }

    const existing = providersByType.get(service.serviceType);
    if (!existing || (!existing.isDefault && service.isDefault)) {
      providersByType.set(service.serviceType, service);
    }
  }

  return Array.from(providersByType.values());
}

export function S2SProviderSelector({ value, onChange }: S2SProviderSelectorProps) {
  const tenantId = useAuthStore((s) => s.tenantId);
  const [providers, setProviders] = useState<VoiceServiceInstance[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const selectedSupportMessage = value ? getS2STelephonySupportMessage(value) : null;

  useEffect(() => {
    if (!tenantId) return;

    setIsLoading(true);
    setError(null);

    listVoiceServices(tenantId)
      .then((services) => {
        const selectableServices = getSelectableProviders(services);
        setProviders(selectableServices);

        // Auto-select first provider if none selected
        if (!value && selectableServices.length > 0) {
          onChange(selectableServices[0].serviceType);
        }
      })
      .catch((err) => {
        console.error('Failed to load S2S providers:', err);
        setError(sanitizeError(err, 'Failed to load S2S providers'));
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [tenantId, value, onChange]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 p-3 rounded-lg border border-default bg-background-muted">
        <Loader2 className="w-4 h-4 animate-spin text-muted" />
        <p className="text-sm text-muted">Loading S2S providers...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-start gap-2.5 p-3 rounded-lg bg-error-subtle border border-error/30">
        <AlertCircle className="w-4 h-4 text-error shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-medium text-error">Failed to load S2S providers</p>
          <p className="text-xs text-error-foreground mt-0.5">{error}</p>
        </div>
      </div>
    );
  }

  if (providers.length === 0) {
    return (
      <div className="flex items-start gap-2.5 p-3 rounded-lg bg-warning/5 border border-warning/30">
        <Info className="w-4 h-4 text-warning shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-medium text-foreground">No S2S providers configured</p>
          <p className="text-xs text-muted mt-0.5">
            Configure S2S providers in <span className="font-medium">Admin → Voice Services</span>{' '}
            to enable realtime voice channels.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-sm font-medium text-foreground mb-2">S2S Provider</label>
        <div className="space-y-2">
          {providers.map((provider) => (
            <label
              key={provider.id}
              className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-default ${
                value === provider.serviceType
                  ? 'border-accent bg-accent-subtle'
                  : 'border-default bg-background hover:bg-background-muted'
              }`}
            >
              <input
                type="radio"
                name="s2s-provider"
                value={provider.serviceType}
                checked={value === provider.serviceType}
                onChange={() => onChange(provider.serviceType)}
                className="mt-0.5 accent-accent"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">
                    {getVoiceProviderLabel(provider.serviceType)}
                  </span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-info-subtle text-info border border-info/30">
                    Uses tenant credentials
                  </span>
                  {getS2STelephonySupport(provider.serviceType) === 'partial' && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-warning/10 text-warning border border-warning/30">
                      Partial telephony support
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted mt-0.5">{provider.displayName}</p>
              </div>
            </label>
          ))}
        </div>
      </div>
      {selectedSupportMessage && (
        <div className="flex items-start gap-2.5 p-3 rounded-lg bg-warning/5 border border-warning/30">
          <Info className="w-4 h-4 text-warning shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-foreground">Provider parity note</p>
            <p className="text-xs text-muted mt-0.5">{selectedSupportMessage}</p>
          </div>
        </div>
      )}
    </div>
  );
}

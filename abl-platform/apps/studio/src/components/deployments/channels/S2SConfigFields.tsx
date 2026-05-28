/**
 * S2S Config Fields Dispatcher
 *
 * Routes to provider-specific configuration components based on selected provider.
 */

'use client';

import { AlertTriangle } from 'lucide-react';
import { isS2SProviderType } from '@agent-platform/config/constants/voice-providers';
import {
  getS2SFieldComponent,
  getS2SProviderSupportMessage,
} from '../../voice/voice-provider-registry';

interface S2SConfigFieldsProps {
  provider: string;
  config: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}

export function S2SConfigFields({ provider, config, onChange }: S2SConfigFieldsProps) {
  if (!isS2SProviderType(provider)) {
    return (
      <div className="p-3 rounded-lg bg-background-muted border border-default">
        <p className="text-sm text-muted">No configuration fields for provider: {provider}</p>
      </div>
    );
  }

  const Component = getS2SFieldComponent(provider);
  const supportMessage = getS2SProviderSupportMessage(provider);

  if (!Component) {
    return (
      <div className="p-3 rounded-lg bg-background-muted border border-default">
        <p className="text-sm text-muted">No configuration fields for provider: {provider}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {supportMessage && (
        <div className="flex items-start gap-2.5 p-3 rounded-lg bg-warning/5 border border-warning/30">
          <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-foreground">Runtime parity warning</p>
            <p className="text-xs text-muted mt-0.5">{supportMessage}</p>
          </div>
        </div>
      )}
      <Component config={config} onChange={onChange} />
    </div>
  );
}

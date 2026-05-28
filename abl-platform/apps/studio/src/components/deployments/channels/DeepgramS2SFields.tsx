/**
 * Deepgram Voice Agent S2S Configuration Fields
 */

'use client';

import { Select } from '../../ui/Select';
import { Input } from '../../ui/Input';

interface DeepgramS2SFieldsProps {
  config: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}

const DEEPGRAM_MODELS = [
  { value: 'aura-asteria-en', label: 'Aura Asteria (Neutral, Clear)' },
  { value: 'aura-luna-en', label: 'Aura Luna (Warm, Friendly)' },
  { value: 'aura-stella-en', label: 'Aura Stella (Professional)' },
  { value: 'aura-athena-en', label: 'Aura Athena (Conversational)' },
  { value: 'aura-hera-en', label: 'Aura Hera (Energetic)' },
  { value: 'aura-orion-en', label: 'Aura Orion (Deep, Masculine)' },
  { value: 'aura-arcas-en', label: 'Aura Arcas (Young, Upbeat)' },
  { value: 'aura-perseus-en', label: 'Aura Perseus (Confident)' },
  { value: 'aura-angus-en', label: 'Aura Angus (Authoritative)' },
];

const THINK_PROVIDER_TYPES = [
  { value: 'open_ai', label: 'OpenAI-compatible (Recommended)' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'google', label: 'Google' },
  { value: 'groq', label: 'Groq' },
];

export function DeepgramS2SFields({ config, onChange }: DeepgramS2SFieldsProps) {
  return (
    <div className="space-y-4 p-4 rounded-lg border border-default bg-background-muted">
      <h5 className="text-xs font-semibold text-foreground uppercase tracking-wider">
        Deepgram Voice Agent Configuration
      </h5>

      <Select
        label="Voice Model"
        options={DEEPGRAM_MODELS}
        value={(config.s2sModel as string) || 'aura-asteria-en'}
        onChange={(value) => onChange('s2sModel', value)}
      />

      <Select
        label="Think Provider"
        options={THINK_PROVIDER_TYPES}
        value={(config.s2sThinkProviderType as string) || 'open_ai'}
        onChange={(value) => onChange('s2sThinkProviderType', value)}
      />

      <Input
        label="Think Model"
        placeholder="gpt-4o-mini"
        value={(config.s2sThinkModel as string) || 'gpt-4o-mini'}
        onChange={(e) => onChange('s2sThinkModel', e.target.value)}
      />

      <Input
        label="Listen Model"
        placeholder="nova-3"
        value={(config.s2sListenModel as string) || 'nova-3'}
        onChange={(e) => onChange('s2sListenModel', e.target.value)}
      />

      <div className="pt-2 border-t border-default">
        <p className="text-xs text-muted">
          Deepgram Voice Agent combines a managed think model with Deepgram listen/speak providers.{' '}
          <a
            href="https://developers.deepgram.com/docs/configure-voice-agent"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline"
          >
            View documentation →
          </a>
        </p>
      </div>
    </div>
  );
}

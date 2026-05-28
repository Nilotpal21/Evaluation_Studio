/**
 * Azure OpenAI Realtime S2S Configuration Fields
 */

'use client';

import { useEffect } from 'react';
import { Select } from '../../ui/Select';
import { Input } from '../../ui/Input';
import {
  OPENAI_REALTIME_TEMPERATURE_MAX,
  OPENAI_REALTIME_TEMPERATURE_MIN,
  normalizeOpenAIRealtimeTemperature,
} from './openai-realtime-temperature';

interface AzureOpenAIS2SFieldsProps {
  config: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}

function parseNumberInput(value: string, defaultValue: number): number {
  if (value.trim() === '') {
    return defaultValue;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

const AZURE_OPENAI_VOICES = [
  { value: 'marin', label: 'Marin (recommended)' },
  { value: 'cedar', label: 'Cedar' },
  { value: 'alloy', label: 'Alloy' },
  { value: 'ash', label: 'Ash' },
  { value: 'ballad', label: 'Ballad' },
  { value: 'coral', label: 'Coral' },
  { value: 'echo', label: 'Echo' },
  { value: 'sage', label: 'Sage' },
  { value: 'shimmer', label: 'Shimmer' },
  { value: 'verse', label: 'Verse' },
];

export function AzureOpenAIS2SFields({ config, onChange }: AzureOpenAIS2SFieldsProps) {
  const configuredTemperature = config.s2sTemperature;
  const temperature = normalizeOpenAIRealtimeTemperature(configuredTemperature);
  const threshold = (config.s2sThreshold as number | undefined) ?? 0.5;
  const silenceDuration = (config.s2sSilenceDuration as number | undefined) ?? '';
  const prefixPadding = (config.s2sPrefixPadding as number | undefined) ?? '';

  useEffect(() => {
    if (typeof configuredTemperature !== 'number' || configuredTemperature === temperature) {
      return;
    }

    onChange('s2sTemperature', temperature);
  }, [configuredTemperature, onChange, temperature]);

  return (
    <div className="space-y-4 p-4 rounded-lg border border-default bg-background-muted">
      <h5 className="text-xs font-semibold text-foreground uppercase tracking-wider">
        Azure OpenAI Realtime Configuration
      </h5>

      <Select
        label="Voice"
        options={AZURE_OPENAI_VOICES}
        value={(config.s2sVoice as string) || 'marin'}
        onChange={(value) => onChange('s2sVoice', value)}
      />

      <div>
        <label
          htmlFor="azure-openai-temperature"
          className="block text-sm font-medium text-foreground mb-2"
        >
          Temperature: {temperature}
        </label>
        <input
          type="range"
          id="azure-openai-temperature"
          min={OPENAI_REALTIME_TEMPERATURE_MIN}
          max={OPENAI_REALTIME_TEMPERATURE_MAX}
          step="0.1"
          value={temperature}
          onChange={(e) => onChange('s2sTemperature', parseFloat(e.target.value))}
          className="w-full accent-accent"
        />
        <div className="flex justify-between text-xs text-muted mt-1">
          <span>Focused ({OPENAI_REALTIME_TEMPERATURE_MIN.toFixed(1)})</span>
          <span>Creative ({OPENAI_REALTIME_TEMPERATURE_MAX.toFixed(1)})</span>
        </div>
      </div>

      <div className="space-y-4 rounded-lg border border-default bg-background-subtle p-4">
        <h6 className="text-xs font-semibold text-foreground uppercase tracking-wider">
          Turn Detection
        </h6>

        <div>
          <label
            htmlFor="azure-openai-speech-detection-sensitivity"
            className="block text-sm font-medium text-foreground mb-2"
          >
            Speech detection sensitivity: {threshold}
          </label>
          <input
            type="range"
            id="azure-openai-speech-detection-sensitivity"
            min="0"
            max="1"
            step="0.05"
            value={threshold}
            onChange={(e) => onChange('s2sThreshold', parseFloat(e.target.value))}
            className="w-full accent-accent"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Input
            id="azure-openai-silence-duration"
            label="Silence Duration (ms)"
            type="number"
            placeholder="700"
            value={String(silenceDuration)}
            onChange={(e) => onChange('s2sSilenceDuration', parseNumberInput(e.target.value, 700))}
          />
          <Input
            id="azure-openai-prefix-padding"
            label="Prefix Padding (ms)"
            type="number"
            placeholder="300"
            value={String(prefixPadding)}
            onChange={(e) => onChange('s2sPrefixPadding', parseNumberInput(e.target.value, 300))}
          />
        </div>
      </div>
    </div>
  );
}

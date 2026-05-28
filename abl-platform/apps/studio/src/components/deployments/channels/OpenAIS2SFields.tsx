/**
 * OpenAI Realtime S2S Configuration Fields
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

interface OpenAIS2SFieldsProps {
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

const OPENAI_MODELS = [
  { value: 'gpt-realtime-1.5', label: 'gpt-realtime-1.5 (recommended)' },
  { value: 'gpt-realtime', label: 'gpt-realtime' },
  { value: 'gpt-realtime-mini', label: 'gpt-realtime-mini' },
  { value: 'gpt-4o-realtime-preview', label: 'gpt-4o-realtime-preview (legacy)' },
  {
    value: 'gpt-4o-realtime-preview-2024-12-17',
    label: 'gpt-4o-realtime-preview-2024-12-17 (legacy)',
  },
];

const OPENAI_VOICES = [
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

export function OpenAIS2SFields({ config, onChange }: OpenAIS2SFieldsProps) {
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
        OpenAI Realtime Configuration
      </h5>

      <Select
        label="Model"
        options={OPENAI_MODELS}
        value={(config.s2sModel as string) || 'gpt-realtime-1.5'}
        onChange={(value) => onChange('s2sModel', value)}
      />

      <Select
        label="Voice"
        options={OPENAI_VOICES}
        value={(config.s2sVoice as string) || 'marin'}
        onChange={(value) => onChange('s2sVoice', value)}
      />

      <div>
        <label htmlFor="temperature" className="block text-sm font-medium text-foreground mb-2">
          Temperature: {temperature}
        </label>
        <input
          type="range"
          id="temperature"
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
        <div>
          <h6 className="text-xs font-semibold text-foreground uppercase tracking-wider">
            Turn Detection
          </h6>
          <p className="mt-1 text-xs text-muted">
            Tune how OpenAI detects speech starts and decides when the caller has finished speaking.
          </p>
        </div>

        <div>
          <label
            htmlFor="speech-detection-sensitivity"
            className="block text-sm font-medium text-foreground mb-2"
          >
            Speech detection sensitivity: {threshold}
          </label>
          <input
            type="range"
            id="speech-detection-sensitivity"
            min="0"
            max="1"
            step="0.05"
            value={threshold}
            aria-describedby="openai-threshold-help"
            onChange={(e) => onChange('s2sThreshold', parseFloat(e.target.value))}
            className="w-full accent-accent"
          />
          <div className="flex justify-between text-xs text-muted mt-1">
            <span>More sensitive (0.0)</span>
            <span>More conservative (1.0)</span>
          </div>
          <p id="openai-threshold-help" className="text-xs text-muted mt-1">
            Lower values pick up quieter speech; higher values reduce background-noise triggers.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <Input
              id="silence-duration"
              label="Silence Duration (ms)"
              type="number"
              placeholder="700"
              value={String(silenceDuration)}
              aria-describedby="openai-silence-duration-help"
              onChange={(e) =>
                onChange('s2sSilenceDuration', parseNumberInput(e.target.value, 700))
              }
            />
            <p id="openai-silence-duration-help" className="text-xs text-muted mt-1">
              Quiet time before OpenAI treats the caller turn as complete.
            </p>
          </div>
          <div>
            <Input
              id="prefix-padding"
              label="Prefix Padding (ms)"
              type="number"
              placeholder="300"
              value={String(prefixPadding)}
              aria-describedby="openai-prefix-padding-help"
              onChange={(e) => onChange('s2sPrefixPadding', parseNumberInput(e.target.value, 300))}
            />
            <p id="openai-prefix-padding-help" className="text-xs text-muted mt-1">
              Audio kept before detected speech so the beginning of the caller utterance is
              preserved.
            </p>
          </div>
        </div>
      </div>

      <div className="pt-2 border-t border-default">
        <p className="text-xs text-muted">
          OpenAI Realtime API provides low-latency voice conversations with function calling
          support.{' '}
          <a
            href="https://platform.openai.com/docs/guides/realtime"
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

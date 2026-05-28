/**
 * Grok Realtime S2S Configuration Fields
 */

'use client';

import { Select } from '../../ui/Select';
import { Input } from '../../ui/Input';

interface GrokS2SFieldsProps {
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

const GROK_MODELS = [
  { value: 'grok-2-1212', label: 'grok-2-1212 (recommended)' },
  { value: 'grok-2', label: 'grok-2' },
];

const GROK_VOICES = [
  { value: 'ara', label: 'Ara (default)' },
  { value: 'eve', label: 'Eve' },
  { value: 'leo', label: 'Leo' },
  { value: 'rex', label: 'Rex' },
  { value: 'sal', label: 'Sal' },
];

export function GrokS2SFields({ config, onChange }: GrokS2SFieldsProps) {
  const threshold = (config.s2sThreshold as number | undefined) ?? 0.5;
  const silenceDuration = (config.s2sSilenceDuration as number | undefined) ?? '';
  const prefixPadding = (config.s2sPrefixPadding as number | undefined) ?? '';

  return (
    <div className="space-y-4 p-4 rounded-lg border border-default bg-background-muted">
      <h5 className="text-xs font-semibold text-foreground uppercase tracking-wider">
        Grok Realtime Configuration
      </h5>

      <Select
        label="Model"
        options={GROK_MODELS}
        value={(config.s2sModel as string) || 'grok-2-1212'}
        onChange={(value) => onChange('s2sModel', value)}
      />

      <Select
        label="Voice"
        options={GROK_VOICES}
        value={(config.s2sVoice as string) || 'ara'}
        onChange={(value) => onChange('s2sVoice', value)}
      />

      <div>
        <label htmlFor="temperature" className="block text-sm font-medium text-foreground mb-2">
          Temperature: {(config.s2sTemperature as number) ?? 1.0}
        </label>
        <input
          type="range"
          id="temperature"
          min="0"
          max="2"
          step="0.1"
          value={(config.s2sTemperature as number) ?? 1.0}
          onChange={(e) => onChange('s2sTemperature', parseFloat(e.target.value))}
          className="w-full accent-accent"
        />
        <div className="flex justify-between text-xs text-muted mt-1">
          <span>Focused (0.0)</span>
          <span>Creative (2.0)</span>
        </div>
      </div>

      <div className="space-y-3 pl-4 border-l-2 border-accent/30">
        <div>
          <label htmlFor="threshold" className="block text-sm font-medium text-foreground mb-2">
            Threshold: {threshold}
          </label>
          <input
            type="range"
            id="threshold"
            min="0"
            max="1"
            step="0.05"
            value={threshold}
            onChange={(e) => onChange('s2sThreshold', parseFloat(e.target.value))}
            className="w-full accent-accent"
          />
          <div className="flex justify-between text-xs text-muted mt-1">
            <span>Sensitive (0.0)</span>
            <span>Conservative (1.0)</span>
          </div>
        </div>
        <Input
          label="Silence Duration (ms)"
          type="number"
          placeholder="500"
          value={String(silenceDuration)}
          onChange={(e) => onChange('s2sSilenceDuration', parseNumberInput(e.target.value, 500))}
        />
        <Input
          label="Prefix Padding (ms)"
          type="number"
          placeholder="300"
          value={String(prefixPadding)}
          onChange={(e) => onChange('s2sPrefixPadding', parseNumberInput(e.target.value, 300))}
        />
      </div>

      <div className="pt-2 border-t border-default">
        <p className="text-xs text-muted">
          xAI Grok Realtime API provides low-latency voice conversations with function calling
          support.{' '}
          <a
            href="https://docs.x.ai/docs/guides/realtime"
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

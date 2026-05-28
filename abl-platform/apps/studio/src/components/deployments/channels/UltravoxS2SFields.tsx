/**
 * Ultravox S2S Configuration Fields
 */

'use client';

import { Select } from '../../ui/Select';
import { Input } from '../../ui/Input';

interface UltravoxS2SFieldsProps {
  config: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}

const ULTRAVOX_MODELS = [
  { value: 'fixie-ai/ultravox-v0.2', label: 'Ultravox v0.2 (Latest)' },
  { value: 'fixie-ai/ultravox-v0.1', label: 'Ultravox v0.1' },
];

export function UltravoxS2SFields({ config, onChange }: UltravoxS2SFieldsProps) {
  return (
    <div className="space-y-4 p-4 rounded-lg border border-default bg-background-muted">
      <h5 className="text-xs font-semibold text-foreground uppercase tracking-wider">
        Ultravox Configuration
      </h5>

      <Select
        label="Model"
        options={ULTRAVOX_MODELS}
        value={(config.s2sModel as string) || 'fixie-ai/ultravox-v0.2'}
        onChange={(value) => onChange('s2sModel', value)}
      />

      <Input
        label="Agent ID (Optional)"
        placeholder="agent_abc123xyz"
        value={(config.s2sAgentId as string) || ''}
        onChange={(e) => onChange('s2sAgentId', e.target.value)}
      />

      <div>
        <label
          htmlFor="ultravox-temperature"
          className="block text-sm font-medium text-foreground mb-2"
        >
          Temperature: {(config.s2sTemperature as number) || 0.8}
        </label>
        <input
          type="range"
          id="ultravox-temperature"
          min="0"
          max="1"
          step="0.1"
          value={(config.s2sTemperature as number) || 0.8}
          onChange={(e) => onChange('s2sTemperature', parseFloat(e.target.value))}
          className="w-full accent-accent"
        />
        <div className="flex justify-between text-xs text-muted mt-1">
          <span>Focused (0.0)</span>
          <span>Creative (1.0)</span>
        </div>
      </div>

      <div className="pt-2 border-t border-default">
        <p className="text-xs text-muted">
          Ultravox provides speech-to-speech with function calling support.{' '}
          <a
            href="https://docs.ultravox.ai/"
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

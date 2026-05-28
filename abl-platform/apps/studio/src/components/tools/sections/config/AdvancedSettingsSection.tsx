/**
 * AdvancedSettingsSection Component
 *
 * Collapsible advanced settings with a global enable/disable toggle.
 * When disabled: uses defaults (timeoutMs=30000).
 * When enabled: user can customize timeout and input schema.
 *
 * Only shows fields that are actually wired to the runtime:
 * - timeoutMs → effectiveTimeout in all executors
 * - inputSchema → LLM function calling parameters
 */

import { Settings2 } from 'lucide-react';
import { Section } from '../../../ui/Section';
import { Input } from '../../../ui/Input';
import { Toggle } from '../../../ui/Toggle';
import type { ToolType } from '../../../../store/tool-store';

interface AdvancedSettingsSectionProps {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  timeoutMs: number;
  inputSchema?: string;
  toolType: ToolType;
  onTimeoutChange: (value: number) => void;
  onInputSchemaChange?: (value: string) => void;
}

export function AdvancedSettingsSection({
  enabled,
  onEnabledChange,
  timeoutMs,
  inputSchema,
  toolType,
  onTimeoutChange,
  onInputSchemaChange,
}: AdvancedSettingsSectionProps) {
  return (
    <Section
      title="Advanced"
      description={enabled ? 'Custom timeout and execution settings' : 'Using default settings'}
      icon={<Settings2 className="w-4 h-4" />}
      variant="default"
      actions={
        <div onClick={(e) => e.stopPropagation()}>
          <Toggle checked={enabled} onChange={onEnabledChange} />
        </div>
      }
    >
      {enabled ? (
        <div className="space-y-4">
          <div>
            <Input
              label="Timeout (ms)"
              type="number"
              min={1000}
              max={300000}
              value={timeoutMs}
              onChange={(e) => onTimeoutChange(parseInt(e.target.value) || 30000)}
            />
            <p className="text-xs text-muted mt-1.5">Maximum execution time (1–300 seconds)</p>
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted">
          Toggle on to customize timeout and other execution settings. Defaults: 30s timeout.
        </p>
      )}
    </Section>
  );
}

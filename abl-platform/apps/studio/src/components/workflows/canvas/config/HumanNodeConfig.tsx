'use client';

import { useCallback } from 'react';
import { Input } from '../../../ui/Input';
import { Select } from '../../../ui/Select';
import { ExpressionInput } from './ExpressionInput';
import { UserAssigneePicker } from './UserAssigneePicker';
import { useNodeExpressionContext } from './NodeExpressionContext';

interface NodeConfigProps {
  nodeId: string;
  config: Record<string, unknown>;
  onUpdate: (config: Record<string, unknown>) => void;
}

const TIMEOUT_UNIT_OPTIONS = [
  { value: 'seconds', label: 'Seconds' },
  { value: 'minutes', label: 'Minutes' },
  { value: 'hours', label: 'Hours' },
  { value: 'days', label: 'Days' },
];

export function HumanNodeConfig({ nodeId, config, onUpdate }: NodeConfigProps) {
  const { triggers, previousSteps } = useNodeExpressionContext();
  const subject = (config.subject as string) ?? '';
  const message = (config.message as string) ?? '';
  const assignTo = (config.assignTo as string) ?? 'everyone';
  const assignees = (config.assignees as string[]) ?? [];
  const timeoutConfig = config.timeout as { duration: number; unit: string } | undefined;
  const timeoutEnabled = timeoutConfig !== undefined;
  const onTimeout = (config.onTimeout as string) ?? 'terminate';

  const update = useCallback(
    (field: string, value: unknown) => {
      onUpdate({ ...config, [field]: value });
    },
    [config, onUpdate],
  );

  return (
    <div className="space-y-4" data-testid="human-config">
      <ExpressionInput
        label="Subject"
        value={subject}
        onChange={(v) => update('subject', v)}
        placeholder="Enter subject"
        triggers={triggers}
        previousSteps={previousSteps}
        testId="config-subject"
      />

      <ExpressionInput
        label="Message"
        value={message}
        onChange={(v) => update('message', v)}
        placeholder="Enter message"
        multiline
        rows={4}
        triggers={triggers}
        previousSteps={previousSteps}
        testId="config-message"
      />

      {/* Assign To */}
      <div className="space-y-1.5" data-testid="config-assign-to">
        <label className="block text-sm font-medium text-foreground">Assign To</label>
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="radio"
              name="assignTo"
              value="everyone"
              checked={assignTo === 'everyone'}
              onChange={() => update('assignTo', 'everyone')}
              className="text-foreground"
            />
            Everyone
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="radio"
              name="assignTo"
              value="specific"
              checked={assignTo === 'specific'}
              onChange={() => update('assignTo', 'specific')}
              className="text-foreground"
            />
            Specific people
          </label>
        </div>
      </div>

      {assignTo === 'specific' && (
        <div data-testid="config-assignees">
          <UserAssigneePicker value={assignees} onChange={(ids) => update('assignees', ids)} />
        </div>
      )}

      {/* Timeout */}
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={timeoutEnabled}
            onChange={(e) => {
              if (e.target.checked) {
                update('timeout', { duration: 60, unit: 'minutes' });
              } else {
                const next = { ...config };
                delete next.timeout;
                onUpdate(next);
              }
            }}
            className="rounded border-default"
          />
          Enable timeout
        </label>

        {timeoutEnabled && (
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Input
                label="Duration"
                type="number"
                min={1}
                value={timeoutConfig.duration}
                onChange={(e) => {
                  const raw = e.target.value;
                  const parsed = parseInt(raw, 10);
                  update('timeout', {
                    ...timeoutConfig,
                    duration: raw === '' || isNaN(parsed) ? ('' as unknown as number) : parsed,
                  });
                }}
                onBlur={() => {
                  if (!timeoutConfig.duration || timeoutConfig.duration < 1) {
                    update('timeout', { ...timeoutConfig, duration: 1 });
                  }
                }}
              />
            </div>
            <div className="flex-1">
              <Select
                label="Unit"
                options={TIMEOUT_UNIT_OPTIONS}
                value={timeoutConfig.unit}
                onChange={(val) => update('timeout', { ...timeoutConfig, unit: val })}
              />
            </div>
          </div>
        )}

        {timeoutEnabled && (
          <div className="space-y-1">
            <label className="block text-sm font-medium text-foreground">On Timeout</label>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="radio"
                name="onTimeout"
                value="terminate"
                checked={onTimeout === 'terminate'}
                onChange={() => update('onTimeout', 'terminate')}
                className="text-foreground"
              />
              Terminate workflow
            </label>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="radio"
                name="onTimeout"
                value="skip"
                checked={onTimeout === 'skip'}
                onChange={() => update('onTimeout', 'skip')}
                className="text-foreground"
              />
              Skip this step
            </label>
          </div>
        )}
      </div>
    </div>
  );
}

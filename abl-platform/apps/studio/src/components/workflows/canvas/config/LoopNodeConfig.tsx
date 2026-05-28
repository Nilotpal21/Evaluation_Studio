'use client';

import { useCallback } from 'react';
import { Info } from 'lucide-react';
import { Input } from '../../../ui/Input';
import { Select } from '../../../ui/Select';
import { OutputMappingEditor } from './EndNodeConfig';
import { ExpressionInput } from './ExpressionInput';
import { useNodeExpressionContext } from './NodeExpressionContext';

interface NodeConfigProps {
  nodeId: string;
  config: Record<string, unknown>;
  onUpdate: (config: Record<string, unknown>) => void;
}

const MODE_OPTIONS = [
  { value: 'sequential', label: 'Sequential (Loop)' },
  { value: 'parallel', label: 'Parallel (Batch)' },
];

const ON_ERROR_SEQ_OPTIONS = [
  { value: 'continue', label: 'Continue' },
  { value: 'terminate', label: 'Terminate' },
];

const ON_ERROR_PAR_OPTIONS = [
  { value: 'continue', label: 'Continue' },
  { value: 'terminate', label: 'Terminate' },
];

export function LoopNodeConfig({ nodeId, config, onUpdate }: NodeConfigProps) {
  const { triggers, previousSteps } = useNodeExpressionContext();
  const mode = (config.mode as string) ?? 'sequential';
  const source = (config.source as string) ?? '';
  const itemAlias = (config.itemAlias as string) ?? 'currentItem';
  const outputField = (config.outputField as string) ?? '';
  const onError = (config.onError as string) ?? 'continue';
  const maxIterations = (config.maxIterations as number) ?? 1000;
  const concurrencyLimit = (config.concurrencyLimit as number) ?? 5;
  const stagger = (config.stagger as number) ?? 0;
  const preserveOrder = (config.preserveOrder as boolean) ?? true;
  const isParallel = mode === 'parallel';
  const rawBodyOutputMapping =
    (config.bodyOutputMapping as
      | Record<string, string | { expression?: string; type?: string; description?: string }>
      | undefined) ?? {};

  const update = useCallback(
    (field: string, value: unknown) => {
      onUpdate({ ...config, [field]: value });
    },
    [config, onUpdate],
  );

  return (
    <div className="space-y-4" data-testid="loop-config">
      <Select
        label="Execution Mode"
        id="config-mode"
        options={MODE_OPTIONS}
        value={mode}
        onChange={(val) => update('mode', val)}
      />

      {/* Context variable hint box */}
      <div className="rounded-lg border border-default bg-background-muted/50 px-3 py-2.5">
        <div className="flex items-center gap-1.5 mb-2">
          <Info className="w-3 h-3 text-foreground-muted shrink-0" />
          <span className="text-[11px] font-semibold text-foreground-muted uppercase tracking-wider">
            Context Variables
          </span>
        </div>
        <div className="space-y-0.5">
          {[
            `{{${itemAlias || 'currentItem'}}}`,
            '{{currentIndex}}',
            '{{currentOutput}}',
            '{{cache.get("key")}}',
          ].map((v) => (
            <code key={v} className="block text-[11px] text-foreground-muted font-mono">
              {v}
            </code>
          ))}
        </div>
      </div>

      <ExpressionInput
        label="Source"
        value={source}
        onChange={(v) => update('source', v)}
        placeholder="{{context.steps.NodeName.output.items}}"
        triggers={triggers}
        previousSteps={previousSteps}
        testId="config-source"
      />

      <Input
        label="Item Alias"
        data-testid="config-item-alias"
        value={itemAlias}
        onChange={(e) => update('itemAlias', e.target.value)}
        placeholder="currentItem"
      />

      <Input
        label="Output Variable"
        data-testid="config-output-field"
        value={outputField}
        onChange={(e) => update('outputField', e.target.value)}
        placeholder="context.loopResults"
      />

      <div className="border-t border-default pt-4">
        <OutputMappingEditor
          rawMapping={rawBodyOutputMapping}
          onChange={(bodyOutputMapping) => update('bodyOutputMapping', bodyOutputMapping)}
          title="Iteration Output"
          variant="rows"
          addLabel="Add output field"
          description={
            <>
              Captures the mapped value for each loop iteration. Use loop body step outputs such as{' '}
              <code>{'{{context.steps.API0002.output}}'}</code>.
            </>
          }
          testId="loop-body-output-config"
        />
      </div>

      {/* Mode-specific options */}
      <div className="border-t border-default pt-4 space-y-4">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-foreground-muted">
          {isParallel ? 'Parallel Options' : 'Loop Options'}
        </div>

        {isParallel ? (
          <>
            <Input
              label="Concurrency Limit"
              type="number"
              min={1}
              max={50}
              value={concurrencyLimit}
              onChange={(e) => update('concurrencyLimit', parseInt(e.target.value, 10) || 5)}
            />
            <Input
              label="Stagger (ms)"
              type="number"
              min={0}
              value={stagger}
              onChange={(e) => update('stagger', parseInt(e.target.value, 10) || 0)}
            />
            <Select
              label="On Error"
              id="config-on-error"
              options={ON_ERROR_PAR_OPTIONS}
              value={onError}
              onChange={(val) => update('onError', val)}
            />
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={preserveOrder}
                onChange={(e) => update('preserveOrder', e.target.checked)}
                className="rounded border-default w-4 h-4 accent-accent"
              />
              <span className="text-sm text-foreground">Preserve item order</span>
            </label>
          </>
        ) : (
          <>
            <Input
              label="Max Iterations"
              type="number"
              min={1}
              value={maxIterations}
              onChange={(e) => update('maxIterations', parseInt(e.target.value, 10) || 1000)}
            />
            <Select
              label="On Error"
              id="config-on-error"
              options={ON_ERROR_SEQ_OPTIONS}
              value={onError}
              onChange={(val) => update('onError', val)}
            />
          </>
        )}
      </div>
    </div>
  );
}

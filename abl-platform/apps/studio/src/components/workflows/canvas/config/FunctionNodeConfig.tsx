'use client';

import { useCallback, useState } from 'react';
import { Maximize2 } from 'lucide-react';
import clsx from 'clsx';
import { Input } from '../../../ui/Input';
import { Textarea } from '../../../ui/Textarea';
import { FunctionEditorOverlay } from './FunctionEditorOverlay';
import { useNodeExpressionContext } from './NodeExpressionContext';

interface NodeConfigProps {
  nodeId: string;
  config: Record<string, unknown>;
  onUpdate: (config: Record<string, unknown>) => void;
}

export function FunctionNodeConfig({ config, onUpdate }: NodeConfigProps) {
  const code = (config.code as string) ?? '';
  const timeout = (config.timeout as number) ?? 10;
  const [editorOpen, setEditorOpen] = useState(false);
  const { triggers, previousSteps, executionContext } = useNodeExpressionContext();
  // Merge payloads from every registered trigger so IntelliSense reflects the
  // full set of fields the workflow can receive — picking only `triggers[0]`
  // hid suggestions for workflows wired to multiple triggers.
  const triggerPayload = triggers.reduce<Record<string, unknown>>(
    (acc, t) => ({ ...acc, ...(t.payload ?? {}) }),
    {},
  );

  const update = useCallback(
    (field: string, value: unknown) => {
      onUpdate({ ...config, [field]: value });
    },
    [config, onUpdate],
  );

  return (
    <div className="space-y-4" data-testid="function-config">
      {/* Context API help */}
      <div className="rounded-lg border border-default bg-background-subtle p-3">
        <h4 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider mb-2">
          Context Object
        </h4>
        <ul className="space-y-1.5">
          <li className="flex gap-2 text-xs text-foreground-muted">
            <span className="shrink-0 mt-0.5 text-subtle">•</span>
            <span>
              <strong className="text-foreground font-medium">Read trigger input</strong>
              {' — '}
              <code className="text-foreground">context.trigger.payload.fieldName</code>
            </span>
          </li>
          <li className="flex gap-2 text-xs text-foreground-muted">
            <span className="shrink-0 mt-0.5 text-subtle">•</span>
            <span>
              <strong className="text-foreground font-medium">Read step output</strong>
              {' — '}
              <code className="text-foreground">context.steps.StepName.output.field</code>
            </span>
          </li>
          <li className="flex gap-2 text-xs text-foreground-muted">
            <span className="shrink-0 mt-0.5 text-subtle">•</span>
            <span>
              <strong className="text-foreground font-medium">Write for downstream steps</strong>
              {' — '}
              <code className="text-foreground">{'context.x = value'}</code>
              {' → usable as '}
              <code className="text-foreground">{'{{context.x}}'}</code>
            </span>
          </li>
          <li className="flex gap-2 text-xs text-foreground-muted">
            <span className="shrink-0 mt-0.5 text-subtle">•</span>
            <span>
              <strong className="text-foreground font-medium">Persist across runs</strong>
              {' — '}
              <code className="text-foreground">memory.workflow.set(key, val)</code>
              {' / '}
              <code className="text-foreground">.get(key)</code>
            </span>
          </li>
        </ul>
      </div>

      {/* Code editor with expand icon */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-sm font-medium text-foreground">JavaScript</label>
          <button
            type="button"
            data-testid="open-full-editor"
            onClick={() => setEditorOpen(true)}
            aria-label="Expand editor"
            className={clsx(
              'p-1 rounded-md transition-fast',
              'text-foreground-muted hover:text-foreground hover:bg-background-muted',
            )}
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        </div>
        <Textarea
          data-testid="config-code"
          value={code}
          onChange={(e) => update('code', e.target.value)}
          placeholder={`// Read upstream data\nconst items = context.trigger.payload.items ?? [];\n\n// Transform and write for downstream steps\nconst filtered = items.filter(i => i.active);\ncontext.filtered = filtered;\ncontext.count = filtered.length;`}
          rows={12}
          className="font-mono text-xs"
        />
      </div>

      {/* Timeout */}
      <Input
        label="Timeout (seconds)"
        type="number"
        min={5}
        max={60}
        value={timeout}
        onChange={(e) => update('timeout', parseInt(e.target.value, 10) || 10)}
      />

      {/* Full-screen Monaco editor overlay */}
      <FunctionEditorOverlay
        isOpen={editorOpen}
        onClose={() => setEditorOpen(false)}
        code={code}
        onUpdate={(newCode) => update('code', newCode)}
        triggerPayload={triggerPayload}
        previousSteps={previousSteps}
        executionContext={executionContext}
      />
    </div>
  );
}

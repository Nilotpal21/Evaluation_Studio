'use client';

import { useCallback, useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { Input } from '../../../ui/Input';
import { Select } from '../../../ui/Select';
import { Textarea } from '../../../ui/Textarea';
import { ExpressionInput } from './ExpressionInput';
import { apiFetch } from '../../../../lib/api-client';
import { useNavigationStore } from '../../../../store/navigation-store';
import { useNodeExpressionContext } from './NodeExpressionContext';
import { formatModelOptionLabel } from '../../../../lib/model-display';

interface NodeConfigProps {
  nodeId: string;
  config: Record<string, unknown>;
  onUpdate: (config: Record<string, unknown>) => void;
}

interface ModelConfig {
  id: string;
  name: string;
  modelId: string;
  provider: string;
}

export function TextToTextNodeConfig({ nodeId, config, onUpdate }: NodeConfigProps) {
  const projectId = useNavigationStore((s) => s.projectId);
  const { triggers, previousSteps } = useNodeExpressionContext();
  const modelId = (config.modelId as string) ?? '';
  const connectionId = (config.connectionId as string) ?? '';
  const systemPrompt = (config.systemPrompt as string) ?? '';
  const humanPrompt = (config.humanPrompt as string) ?? '';
  const temperature = (config.temperature as number) ?? 0.7;
  const maxTokens = config.maxTokens as number | undefined;
  const timeout = (config.timeout as number) ?? 60;
  const outputSchema = config.outputSchema as Record<string, unknown> | undefined;
  const structuredOutputEnabled = outputSchema !== undefined;

  const [models, setModels] = useState<ModelConfig[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    setLoadingModels(true);
    apiFetch(`/api/models?projectId=${projectId}`)
      .then((res) => res.json())
      .then((json) => {
        const items = (json?.models ?? json?.data?.models ?? []) as ModelConfig[];
        setModels(items);
      })
      .catch(() => {
        setModels([]);
      })
      .finally(() => setLoadingModels(false));
  }, [projectId]);

  const update = useCallback(
    (field: string, value: unknown) => {
      onUpdate({ ...config, [field]: value });
    },
    [config, onUpdate],
  );

  const handleModelSelect = useCallback(
    (selectedId: string) => {
      const model = models.find((m) => m.id === selectedId);
      if (model) {
        onUpdate({
          ...config,
          modelId: model.modelId,
          connectionId: model.id,
          _modelName: model.name,
          _provider: model.provider,
        });
      } else {
        onUpdate({ ...config, connectionId: selectedId });
      }
    },
    [config, onUpdate, models],
  );

  const modelOptions = models.map((m) => ({
    value: m.id,
    label: formatModelOptionLabel(m),
  }));

  const settingsUrl = projectId ? `/?page=settings-models&projectId=${projectId}` : '#';

  return (
    <div className="space-y-4" data-testid="text-to-text-config">
      {/* Connection / Model selector */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="block text-sm font-medium text-foreground">Model Connection</label>
          <a
            href={settingsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs text-accent hover:underline"
            data-testid="config-settings-link"
          >
            Configure models
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
        {loadingModels ? (
          <p className="text-xs text-foreground-muted animate-pulse">Loading models...</p>
        ) : modelOptions.length > 0 ? (
          <Select
            options={modelOptions}
            value={connectionId}
            onChange={handleModelSelect}
            placeholder="Select a model connection"
            data-testid="config-connection-select"
          />
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-foreground-muted">
              No models configured.{' '}
              <a
                href={settingsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                Add one in Settings → Models
              </a>
            </p>
            <Input
              label="Model ID (manual)"
              data-testid="config-model-id"
              value={modelId}
              onChange={(e) => update('modelId', e.target.value)}
              placeholder="e.g. gpt-4o"
            />
            <Input
              label="Connection ID (manual)"
              value={connectionId}
              onChange={(e) => update('connectionId', e.target.value)}
              placeholder="Optional"
            />
          </div>
        )}
      </div>

      {/* Show selected model info */}
      {connectionId && models.length > 0 && (
        <div className="text-xs text-foreground-muted bg-background-subtle rounded-md px-3 py-2 border border-default">
          <span className="font-medium">Model:</span> {modelId || 'N/A'} &middot;{' '}
          <span className="font-medium">Provider:</span> {(config._provider as string) || 'N/A'}
        </div>
      )}

      <ExpressionInput
        label="System Prompt"
        value={systemPrompt}
        onChange={(v) => update('systemPrompt', v)}
        placeholder="You are a helpful assistant..."
        multiline
        rows={4}
        triggers={triggers}
        previousSteps={previousSteps}
        testId="config-system-prompt"
      />

      <ExpressionInput
        label="Human Prompt"
        value={humanPrompt}
        onChange={(v) => update('humanPrompt', v)}
        placeholder="{{context.trigger.payload.message}}"
        multiline
        rows={4}
        triggers={triggers}
        previousSteps={previousSteps}
        testId="config-human-prompt"
      />

      <div className="space-y-1.5">
        <label className="block text-sm font-medium text-foreground">
          Temperature: {temperature.toFixed(1)}
        </label>
        <input
          type="range"
          data-testid="config-temperature"
          min={0}
          max={2}
          step={0.1}
          value={temperature}
          onChange={(e) => update('temperature', parseFloat(e.target.value))}
          className="w-full accent-foreground"
        />
        <div className="flex justify-between text-xs text-foreground-muted">
          <span>0</span>
          <span>2</span>
        </div>
      </div>

      <Input
        label="Max Tokens"
        type="number"
        value={maxTokens ?? ''}
        onChange={(e) =>
          update('maxTokens', e.target.value ? parseInt(e.target.value, 10) : undefined)
        }
        placeholder="Optional"
      />

      <Input
        label="Timeout (seconds)"
        type="number"
        min={30}
        max={180}
        value={timeout}
        onChange={(e) => update('timeout', parseInt(e.target.value, 10) || 60)}
      />

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={structuredOutputEnabled}
            onChange={(e) => {
              if (e.target.checked) {
                update('outputSchema', {});
              } else {
                const next = { ...config };
                delete next.outputSchema;
                onUpdate(next);
              }
            }}
            className="rounded border-default"
          />
          Structured Output (JSON Schema)
        </label>
        {structuredOutputEnabled && (
          <Textarea
            value={JSON.stringify(outputSchema, null, 2)}
            onChange={(e) => {
              try {
                const parsed = JSON.parse(e.target.value) as Record<string, unknown>;
                update('outputSchema', parsed);
              } catch {
                // Allow invalid JSON while typing
              }
            }}
            placeholder='{"type": "object", "properties": {...}}'
            rows={6}
            className="font-mono text-xs"
          />
        )}
      </div>
    </div>
  );
}

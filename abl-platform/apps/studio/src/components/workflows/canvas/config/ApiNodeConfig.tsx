'use client';

import { useCallback } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Input } from '../../../ui/Input';
import { Select } from '../../../ui/Select';
import { ExpressionInput } from './ExpressionInput';

import { useNodeExpressionContext } from './NodeExpressionContext';

interface NodeConfigProps {
  nodeId: string;
  config: Record<string, unknown>;
  onUpdate: (config: Record<string, unknown>) => void;
}

interface HeaderEntry {
  key: string;
  value: string;
}

const METHOD_OPTIONS = [
  { value: 'GET', label: 'GET' },
  { value: 'POST', label: 'POST' },
  { value: 'PUT', label: 'PUT' },
  { value: 'PATCH', label: 'PATCH' },
  { value: 'DELETE', label: 'DELETE' },
];

const BODY_TYPE_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'json', label: 'JSON' },
  { value: 'form', label: 'Form' },
  { value: 'xml', label: 'XML' },
  { value: 'custom', label: 'Custom' },
];

const AUTH_TYPE_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'pre_authorized', label: 'Pre-authorized' },
  { value: 'user_level', label: 'User Level' },
];

const MODE_OPTIONS = [
  { value: 'sync', label: 'Synchronous' },
  { value: 'async', label: 'Asynchronous' },
];

export function ApiNodeConfig({ nodeId, config, onUpdate }: NodeConfigProps) {
  const { triggers, previousSteps } = useNodeExpressionContext();
  const method = (config.method as string) ?? 'GET';
  const url = (config.url as string) ?? '';
  const headers = (config.headers as HeaderEntry[]) ?? [];
  const body = (config.body as { type: string; content?: string }) ?? {
    type: 'none',
  };
  const auth = (config.auth as { type: string; profileId?: string }) ?? {
    type: 'none',
  };
  const mode = (config.mode as string) ?? 'sync';
  const timeout = (config.timeout as number) ?? 60;

  const update = useCallback(
    (field: string, value: unknown) => {
      onUpdate({ ...config, [field]: value });
    },
    [config, onUpdate],
  );

  const updateHeader = useCallback(
    (index: number, field: 'key' | 'value', val: string) => {
      const updated = headers.map((h, i) => (i === index ? { ...h, [field]: val } : h));
      update('headers', updated);
    },
    [headers, update],
  );

  const addHeader = useCallback(() => {
    update('headers', [...headers, { key: '', value: '' }]);
  }, [headers, update]);

  const removeHeader = useCallback(
    (index: number) => {
      update(
        'headers',
        headers.filter((_, i) => i !== index),
      );
    },
    [headers, update],
  );

  return (
    <div className="space-y-4" data-testid="api-config">
      <Select
        label="Method"
        id="config-method"
        options={METHOD_OPTIONS}
        value={method}
        onChange={(val) => update('method', val)}
      />

      <ExpressionInput
        label="URL"
        value={url}
        onChange={(v) => update('url', v)}
        placeholder="https://api.example.com/endpoint"
        triggers={triggers}
        previousSteps={previousSteps}
        testId="config-url"
      />

      {/* Headers */}
      <div className="space-y-2" data-testid="config-headers">
        <h4 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider">
          Headers
        </h4>
        {headers.map((header, index) => (
          <div key={index} className="flex items-center gap-2">
            <div className="flex-1">
              <Input
                value={header.key}
                onChange={(e) => updateHeader(index, 'key', e.target.value)}
                onBlur={(e) => updateHeader(index, 'key', e.target.value.trim())}
                placeholder="Header name"
              />
            </div>
            <div className="flex-1">
              <ExpressionInput
                value={header.value}
                onChange={(v) => updateHeader(index, 'value', v)}
                placeholder="Value"
                triggers={triggers}
                previousSteps={previousSteps}
              />
            </div>
            <button
              type="button"
              onClick={() => removeHeader(index)}
              className="p-1 text-foreground-muted hover:text-error transition-colors"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={addHeader}
          className="flex items-center gap-1.5 text-sm text-foreground-muted hover:text-foreground transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add header
        </button>
      </div>

      {/* Body */}
      <Select
        label="Body Type"
        options={BODY_TYPE_OPTIONS}
        value={body.type}
        onChange={(val) => update('body', { ...body, type: val })}
      />
      {body.type !== 'none' && (
        <ExpressionInput
          label="Body Content"
          value={body.content ?? ''}
          onChange={(v) => update('body', { ...body, content: v })}
          placeholder={body.type === 'json' ? '{"key": "value"}' : 'Body content...'}
          multiline
          rows={6}
          triggers={triggers}
          previousSteps={previousSteps}
        />
      )}

      {/* Auth */}
      <Select
        label="Auth Type"
        options={AUTH_TYPE_OPTIONS}
        value={auth.type}
        onChange={(val) => update('auth', { ...auth, type: val })}
      />
      {auth.type === 'pre_authorized' && (
        <Input
          label="Auth Profile ID"
          value={auth.profileId ?? ''}
          onChange={(e) => update('auth', { ...auth, profileId: e.target.value })}
          onBlur={(e) => update('auth', { ...auth, profileId: e.target.value.trim() })}
          placeholder="Profile ID"
        />
      )}

      {/* Mode */}
      <Select
        label="Mode"
        options={MODE_OPTIONS}
        value={mode}
        onChange={(val) => update('mode', val)}
      />

      {/* Timeout */}
      <Input
        label="Timeout (seconds)"
        type="number"
        min={5}
        max={300}
        value={timeout}
        onChange={(e) => update('timeout', parseInt(e.target.value, 10) || 60)}
      />
    </div>
  );
}

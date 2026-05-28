'use client';

/**
 * ExecutionEditor — Model, generation, thinking settings, and full
 * hyperparameter configuration via AgentModelTab.
 *
 * DSL-backed fields: model, temperature, maxTokens, enableThinking.
 * API-backed fields (via AgentModelTab): frequency_penalty, presence_penalty,
 * top_p, Responses API, Streaming mode. These persist to the model-config API.
 */

import { useCallback, useMemo, useState, type ChangeEvent } from 'react';
import type { SectionEditorProps } from '../types';
import { useAgentEditorStore } from '../hooks/useAgentEditorStore';
import { SectionHeader } from './SectionHeader';
import { SubSection, Field, SelectField, numberInputClasses } from './FieldPrimitives';
import { AgentModelTab } from '../../agents/AgentModelTab';
import { useProjectModelOptions } from '@/hooks/useProjectModelOptions';

const THINKING_OPTIONS = [
  { value: 'inherit', label: 'Inherit from project' },
  { value: 'enabled', label: 'Enabled' },
  { value: 'disabled', label: 'Disabled' },
] as const;

export function ExecutionEditor({
  data,
  onChange,
  readOnly,
  onArchClick,
}: SectionEditorProps<'execution'>) {
  const agentName = useAgentEditorStore((s) => s.agentName);
  const projectId = useAgentEditorStore((s) => s.projectId);
  const [showAdvancedOverrides, setShowAdvancedOverrides] = useState(false);
  const {
    options: projectModelOptions,
    unavailableOptions: unavailableProjectModelOptions = [],
    isLoading: isLoadingProjectModels,
    error: projectModelError,
  } = useProjectModelOptions(projectId);

  const update = useCallback(
    <K extends keyof typeof data>(field: K, value: (typeof data)[K]) => {
      onChange({ ...data, [field]: value });
    },
    [data, onChange],
  );

  const selectedUnavailableModel = useMemo(() => {
    if (!data.model) return undefined;
    return unavailableProjectModelOptions.find((option) => option.value === data.model);
  }, [data.model, unavailableProjectModelOptions]);

  const primaryModelOptions = useMemo(() => {
    const options = [{ value: '', label: 'Default' }, ...projectModelOptions];

    if (data.model && !options.some((option) => option.value === data.model)) {
      options.push({
        value: data.model,
        label: selectedUnavailableModel
          ? `${selectedUnavailableModel.name} (no credentials)`
          : `${data.model} (not in project models)`,
      });
    }

    return options;
  }, [data.model, projectModelOptions, selectedUnavailableModel]);

  const thinkingValue = useMemo(() => {
    if (data.enableThinking === true) return 'enabled';
    if (data.enableThinking === false) return 'disabled';
    return 'inherit';
  }, [data.enableThinking]);

  return (
    <div className="p-5 overflow-y-auto h-full">
      <SectionHeader onArchClick={onArchClick} />

      <SubSection title="Model" first>
        <Field label="Primary Model">
          <SelectField
            value={data.model ?? ''}
            onChange={(v) => update('model', v || undefined)}
            options={primaryModelOptions}
            disabled={readOnly || isLoadingProjectModels}
          />
          {projectId &&
            projectModelOptions.length === 0 &&
            unavailableProjectModelOptions.length === 0 &&
            !isLoadingProjectModels &&
            !projectModelError && (
              <p className="mt-2 text-xs text-muted">
                No project-specific models are configured yet. Leave this on Default or add models
                in Project Settings.
              </p>
            )}
          {projectModelError && (
            <p className="mt-2 text-xs text-warning">
              Project models could not be loaded. Only the Default selection is guaranteed to be
              current.
            </p>
          )}
          {unavailableProjectModelOptions.length > 0 && !selectedUnavailableModel && (
            <p className="mt-2 text-xs text-muted">
              {unavailableProjectModelOptions.length} project model
              {unavailableProjectModelOptions.length === 1 ? '' : 's'} without active credentials
              {unavailableProjectModelOptions.length === 1 ? ' is' : ' are'} hidden from this list.
            </p>
          )}
          {selectedUnavailableModel ? (
            <p className="mt-2 text-xs text-warning">
              This agent references {selectedUnavailableModel.name}, but that model has no active
              credentials configured.
            </p>
          ) : data.model && !projectModelOptions.some((option) => option.value === data.model) ? (
            <p className="mt-2 text-xs text-warning">
              This agent references a model that is not currently configured for the project.
            </p>
          ) : null}
        </Field>
      </SubSection>

      <SubSection title="Generation">
        <Field label="Temperature">
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={0}
              max={2}
              step={0.1}
              value={data.temperature ?? 0.7}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                update('temperature', parseFloat(e.target.value))
              }
              disabled={readOnly}
              className="flex-1 h-1.5 rounded-full accent-accent"
            />
            <span className="text-sm text-foreground tabular-nums w-8 text-right font-mono">
              {(data.temperature ?? 0.7).toFixed(1)}
            </span>
          </div>
        </Field>
        <Field label="Max Tokens">
          <input
            type="number"
            value={data.maxTokens ?? ''}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              const raw = e.target.value;
              update('maxTokens', raw === '' ? undefined : parseInt(raw, 10) || undefined);
            }}
            placeholder="Default"
            className={numberInputClasses}
            readOnly={readOnly}
          />
        </Field>
      </SubSection>

      <SubSection title="Thinking">
        <Field label="Enable Thinking">
          <SelectField
            value={thinkingValue}
            onChange={(v) => {
              const mapped = v === 'enabled' ? true : v === 'disabled' ? false : null;
              update('enableThinking', mapped);
            }}
            options={[...THINKING_OPTIONS]}
            disabled={readOnly}
          />
        </Field>
      </SubSection>

      {agentName && projectId && (
        <SubSection title="Advanced Runtime Overrides">
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => setShowAdvancedOverrides((current) => !current)}
              aria-expanded={showAdvancedOverrides}
              className="flex w-full items-center justify-between rounded-xl border border-default bg-background-subtle px-3 py-2 text-left transition-default hover:border-border-focus hover:bg-background-muted"
            >
              <div>
                <div className="text-sm font-medium text-foreground">
                  Runtime-only model overrides
                </div>
                <div className="mt-1 text-xs text-muted">
                  Use these only when you need a runtime override that does not change the ABL
                  primary model above.
                </div>
              </div>
              <span className="text-xs font-medium text-accent">
                {showAdvancedOverrides ? 'Hide' : 'Show'}
              </span>
            </button>

            {showAdvancedOverrides ? (
              <div className="rounded-xl border border-default bg-background px-4 py-4">
                <p className="mb-4 text-xs text-muted">
                  Changes in this panel save separately from the ABL editor and apply as runtime
                  overrides.
                </p>
                <AgentModelTab
                  projectId={projectId}
                  agentName={agentName}
                  embedded
                  modelLabel="Runtime Override Model"
                  modelDescription="Optional runtime-only override. Leave this empty to follow the ABL primary model above."
                />
              </div>
            ) : null}
          </div>
        </SubSection>
      )}
    </div>
  );
}

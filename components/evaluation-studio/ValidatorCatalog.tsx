'use client';

import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronDown, X } from 'lucide-react';
import { type ProjectValidator } from '@/lib/mock-data';
import { useModeHubStore } from '@/lib/mode-hub';
import { StatusPill } from './shared';
import { PickerSelect } from '@/components/ui/PickerSelect';
import { cn } from '@/lib/utils';

export function ValidatorCatalog({ validators }: { validators: ProjectValidator[] }) {
  const [selectedValidatorId, setSelectedValidatorId] = useState<string | null>(null);
  const selectedValidator = useMemo(
    () => validators.find((validator) => validator.id === selectedValidatorId) ?? null,
    [selectedValidatorId, validators],
  );

  return (
    <>
      <div className="rounded-lg border border-border-muted bg-background-subtle overflow-hidden">
        <div className="grid grid-cols-[1.4fr_.8fr_.8fr_.8fr_1fr_1fr_.8fr] gap-3 border-b border-border-muted px-4 py-2.5 text-[10px] uppercase tracking-wide text-foreground-meta">
          <div>Validator</div>
          <div>Type</div>
          <div>Scope</div>
          <div>Environments</div>
          <div>Benchmark</div>
          <div>Linked assets</div>
          <div>Last used</div>
        </div>
        {validators.map((validator) => (
          <button
            key={validator.id}
            type="button"
            onClick={() => setSelectedValidatorId(validator.id)}
            className={cn(
              'grid w-full grid-cols-[1.4fr_.8fr_.8fr_.8fr_1fr_1fr_.8fr] gap-3 border-b border-border-muted px-4 py-3 text-left text-sm transition-colors last:border-b-0',
              selectedValidatorId === validator.id ? 'bg-background-muted/35' : 'hover:bg-background-muted/20',
            )}
          >
            <div>
              <div className="font-medium text-foreground">{validator.name}</div>
              <div className="mt-0.5 text-[11px] text-foreground-subtle">{validator.description}</div>
            </div>
            <div className="text-xs text-foreground-muted">{validator.kind === 'built_in' ? 'Built-in' : 'Custom'}</div>
            <div className="text-xs text-foreground-muted">
              {validator.appliesTo === 'all_agents' ? 'All agents' : `${validator.appliesTo.length} agents`}
            </div>
            <div className="text-xs text-foreground-muted">
              {validator.environments.map((environment) => environment.replace('_', '-')).join(', ')}
            </div>
            <div className="flex items-start">
              <StatusPill tone={benchmarkTone(validator.benchmarkOrigin)}>
                {validator.benchmarkOrigin === 'project_override' ? 'Project override' : 'Platform default'}
              </StatusPill>
            </div>
            <div className="text-xs text-foreground-muted">
              {validator.linkedGoldens.length + validator.linkedKnowledgeBases.length} linked
            </div>
            <div className="text-xs text-foreground-subtle">{validator.lastUsed}</div>
          </button>
        ))}
      </div>

      {selectedValidator ? (
        <ValidatorConfigDrawer
          validator={selectedValidator}
          onClose={() => setSelectedValidatorId(null)}
        />
      ) : null}
    </>
  );
}

function ValidatorConfigDrawer({
  validator,
  onClose,
}: {
  validator: ProjectValidator;
  onClose: () => void;
}) {
  const models = useModeHubStore((state) => state.models);
  const modelOptions = useMemo(
    () =>
      models
        .filter((model) => model.enabled)
        .map((model) => ({
          value: model.modelLabel,
          label: `${model.modelLabel} · ${model.provider}`,
        })),
    [models],
  );
  const [model, setModel] = useState(defaultModelForValidator(validator));
  const [temperature, setTemperature] = useState(defaultTemperatureForValidator(validator));
  const [tokenLimit, setTokenLimit] = useState(defaultTokenLimitForValidator(validator));
  const [topP, setTopP] = useState(defaultTopPForValidator(validator));
  const [referenceState, setReferenceState] = useState(referenceStateForValidator(validator));
  const [prompt, setPrompt] = useState(promptForValidator(validator));

  return (
    <div className="fixed inset-0 z-40 bg-background/35 backdrop-blur-[2px]">
      <div className="absolute inset-y-0 right-0 w-[min(760px,64vw)] border-l border-border bg-background shadow-2xl">
        <div className="flex h-full flex-col">
          <div className="flex items-start justify-between border-b border-border-muted px-5 py-4">
            <div className="flex items-start gap-3">
              <button
                type="button"
                onClick={onClose}
                className="inline-flex size-10 items-center justify-center rounded-lg border border-border-muted text-foreground-muted transition-colors hover:bg-background-muted hover:text-foreground"
              >
                <ChevronLeft className="size-4.5" />
              </button>
              <div>
                <h2 className="text-xl font-semibold tracking-tight">{validator.name}</h2>
                <p className="mt-1 text-xs leading-5 text-foreground-muted">
                  Configure benchmark behavior, prompt logic, and reference state for this validator.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full p-2 text-foreground-subtle transition-colors hover:bg-background-muted hover:text-foreground"
            >
              <X className="size-5" />
            </button>
          </div>

          <div className="flex-1 overflow-auto px-5 py-4">
            <div className="space-y-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-foreground">Model</label>
                <PickerSelect
                  value={model}
                  onChange={setModel}
                  options={modelOptions.length > 0 ? modelOptions : [{ value: model, label: model }]}
                  triggerClassName="h-11 rounded-lg bg-background text-sm"
                  contentClassName="z-[110]"
                />
              </div>

              <section className="rounded-lg border border-border-muted bg-background-subtle p-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-semibold">Model configurations</h3>
                  <ChevronDown className="size-4 text-foreground-muted" />
                </div>

                <div className="mt-4 space-y-5">
                  <SliderField
                    label="Temperature"
                    value={temperature}
                    onChange={setTemperature}
                  />
                  <SliderField
                    label="Output token limit"
                    value={tokenLimit}
                    onChange={setTokenLimit}
                  />
                  <SliderField
                    label="Top P"
                    value={topP}
                    onChange={setTopP}
                  />
                </div>
              </section>

              <button
                type="button"
                className="flex w-full items-center justify-between rounded-lg border border-border-muted bg-background-subtle px-4 py-3 text-left"
              >
                <span className="text-base font-semibold">Prompt</span>
                <span className="text-lg leading-none text-foreground-muted">↗</span>
              </button>

              <div className="rounded-lg border border-border-muted bg-background p-4">
                <label className="mb-1.5 block text-sm font-medium text-foreground">Prompt</label>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  className="min-h-[120px] w-full rounded-lg border border-border-muted bg-background px-3.5 py-2.5 text-sm text-foreground outline-none transition-colors focus:border-border-focus/60"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-foreground">Reference state (JSON)</label>
                <textarea
                  value={referenceState}
                  onChange={(event) => setReferenceState(event.target.value)}
                  className="min-h-[140px] w-full rounded-lg border border-border-muted bg-background px-3.5 py-2.5 text-sm text-foreground outline-none transition-colors focus:border-border-focus/60"
                  placeholder="Please provide the reference state in JSON format"
                />
              </div>

              <div className="rounded-lg border border-border-muted bg-background p-4">
                <div className="text-sm font-medium text-foreground">Linked assets</div>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {validator.linkedGoldens.map((asset) => (
                    <StatusPill key={asset} tone="info">
                      {asset}
                    </StatusPill>
                  ))}
                  {validator.linkedKnowledgeBases.map((asset) => (
                    <StatusPill key={asset} tone="muted">
                      {asset}
                    </StatusPill>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 border-t border-border-muted px-5 py-3">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-10 items-center rounded-lg border border-border-muted px-4 text-sm text-foreground-muted transition-colors hover:bg-background-elevated hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              className="inline-flex h-10 items-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-muted"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SliderField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <label className="text-sm font-medium text-foreground">{label}</label>
        <span className="text-sm text-foreground-muted">{value.toFixed(1)}</span>
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-[#2563eb]"
      />
    </div>
  );
}

function benchmarkTone(origin: ProjectValidator['benchmarkOrigin']) {
  return origin === 'project_override' ? 'warning' : 'info';
}

function defaultModelForValidator(validator: ProjectValidator) {
  if (validator.method === 'llm_judge' || validator.method === 'hybrid') return 'gpt-4';
  if (validator.method === 'rule_based') return 'Rules engine';
  return 'Deterministic runner';
}

function defaultTemperatureForValidator(validator: ProjectValidator) {
  return validator.method === 'programmatic' ? 0 : 0.7;
}

function defaultTokenLimitForValidator(validator: ProjectValidator) {
  return validator.kind === 'custom' ? 0.8 : 0.6;
}

function defaultTopPForValidator(validator: ProjectValidator) {
  return validator.method === 'llm_judge' ? 0.7 : 0.4;
}

function promptForValidator(validator: ProjectValidator) {
  return `Validator: ${validator.name}\nMethod: ${validator.method}\n\nGoal:\n${validator.description}\n\nBenchmark:\n${validator.benchmarkLabel}\n\nIf the validator cannot confidently confirm compliance, mark the outcome as failed or advisory based on severity.`;
}

function referenceStateForValidator(validator: ProjectValidator) {
  return JSON.stringify(
    {
      validator_id: validator.id,
      severity: validator.severity,
      benchmark_origin: validator.benchmarkOrigin,
      benchmark_label: validator.benchmarkLabel,
      environments: validator.environments,
      linked_goldens: validator.linkedGoldens,
      linked_knowledge_bases: validator.linkedKnowledgeBases,
      blocking_in_pre_prod: validator.blockingInPreProd,
    },
    null,
    2,
  );
}

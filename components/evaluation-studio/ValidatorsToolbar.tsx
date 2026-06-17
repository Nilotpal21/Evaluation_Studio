'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, Plus, X } from 'lucide-react';
import { PickerSelect } from '@/components/ui/PickerSelect';
import { useModeHubStore } from '@/lib/mode-hub';
import { cn } from '@/lib/utils';

export function ValidatorsToolbar() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-muted"
        >
          <Plus className="size-4" />
          New custom validator
        </button>
      </div>

      {open ? <CustomValidatorDrawer onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function CustomValidatorDrawer({ onClose }: { onClose: () => void }) {
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

  const [name, setName] = useState('Custom evaluator');
  const [description, setDescription] = useState('');
  const [model, setModel] = useState(modelOptions[0]?.value ?? 'gpt-4');
  const [temperature, setTemperature] = useState(0.7);
  const [tokenLimit, setTokenLimit] = useState(0.7);
  const [topP, setTopP] = useState(0.7);
  const [prompt, setPrompt] = useState(`An instruction, a response to evaluate, a reference answer that got a score of 5, and a scoring rubric representing evaluation criteria are given.

1. Write detailed feedback that assesses the quality of the response relative to the given score.
2. After writing feedback, write a score that is an integer between 1 and 5.
3. You should write the scoring rubric.

(Input, {Output1}, {Output2})`);

  return (
    <div className="fixed inset-0 z-50 bg-background/35 backdrop-blur-[2px]">
      <div className="absolute inset-y-0 right-0 w-[min(760px,64vw)] border-l border-border bg-background shadow-2xl">
        <div className="flex h-full flex-col">
          <div className="flex items-start justify-between border-b border-border-muted px-5 py-4">
            <div>
              <h2 className="text-xl font-semibold tracking-tight">Custom evaluator</h2>
              <p className="mt-1 text-xs leading-5 text-foreground-muted">
                Configure a reusable custom validator for this project.
              </p>
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
              <Field label="Evaluator name">
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="h-11 w-full rounded-lg border border-border-muted bg-background px-3.5 text-sm text-foreground outline-none transition-colors focus:border-border-focus/60"
                />
              </Field>

              <Field label="Description">
                <textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Checks outputs for harmful, abusive, or offensive content."
                  className="min-h-[88px] w-full rounded-lg border border-border-muted bg-background px-3.5 py-2.5 text-sm text-foreground outline-none transition-colors focus:border-border-focus/60"
                />
              </Field>

              <Field label="Model">
                <PickerSelect
                  value={model}
                  onChange={setModel}
                  options={modelOptions.length > 0 ? modelOptions : [{ value: model, label: model }]}
                  triggerClassName="h-11 rounded-lg bg-background text-sm"
                  contentClassName="z-[110]"
                />
              </Field>

              <section className="rounded-lg border border-border-muted bg-background-subtle p-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Model configurations</h3>
                  <ChevronDown className="size-4 text-foreground-muted" />
                </div>
                <div className="mt-4 space-y-5">
                  <SliderField label="Temperature" value={temperature} onChange={setTemperature} />
                  <SliderField label="Output token limit" value={tokenLimit} onChange={setTokenLimit} />
                  <SliderField label="Top P" value={topP} onChange={setTopP} />
                </div>
              </section>

              <div className="rounded-lg border border-border-muted bg-background p-4">
                <label className="mb-2 block text-sm font-medium text-foreground">Prompt</label>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  className="min-h-[150px] w-full rounded-lg border border-border-muted bg-background px-3.5 py-2.5 text-sm text-foreground outline-none transition-colors focus:border-border-focus/60"
                />
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

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-foreground">
        {label}
      </label>
      {children}
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

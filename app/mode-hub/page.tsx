'use client';

import { useMemo, useState } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { Cpu, EyeOff, Pencil, PlugZap, Plus, Search, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Footer } from '@/components/shell/Footer';
import { PickerSelect } from '@/components/ui/PickerSelect';
import { useModeHubStore, type IntegrationModelConfig } from '@/lib/mode-hub';
import { cn } from '@/lib/utils';

type EditorState = {
  open: boolean;
  model?: IntegrationModelConfig;
};

type DeleteState = {
  open: boolean;
  model?: IntegrationModelConfig;
};

const PROVIDERS = ['Anthropic', 'OpenAI', 'Azure OpenAI', 'AWS Bedrock', 'Google Vertex AI', 'Custom OpenAI-compatible'];
const MODELS_BY_PROVIDER: Record<string, string[]> = {
  Anthropic: ['Claude Haiku 4.5', 'Claude Sonnet 4.6', 'Claude Opus 4.8'],
  OpenAI: ['GPT-4.1 mini', 'GPT-4.1', 'o4-mini'],
  'Azure OpenAI': ['GPT-4o', 'GPT-4.1', 'text-embedding-3-large'],
  'AWS Bedrock': ['Claude Sonnet 4.6 (Bedrock)', 'Claude Haiku 4.5 (Bedrock)', 'Llama 3.1 70B'],
  'Google Vertex AI': ['Gemini 2.5 Flash', 'Gemini 2.5 Pro'],
  'Custom OpenAI-compatible': ['Llama 3.1 70B Instruct', 'Mistral Large', 'Qwen 2.5 72B'],
};

export default function ModeHubPage() {
  const models = useModeHubStore((state) => state.models);
  const toggleEnabled = useModeHubStore((state) => state.toggleEnabled);
  const upsertModel = useModeHubStore((state) => state.upsertModel);
  const deleteModel = useModeHubStore((state) => state.deleteModel);
  const testModel = useModeHubStore((state) => state.testModel);

  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState('All');
  const [editor, setEditor] = useState<EditorState>({ open: false });
  const [pendingDelete, setPendingDelete] = useState<DeleteState>({ open: false });

  const providers = useMemo(
    () => ['All', ...Array.from(new Set(models.map((model) => model.provider)))],
    [models],
  );

  const filteredModels = useMemo(() => {
    return models.filter((model) => {
      const matchesProvider = provider === 'All' || model.provider === provider;
      const q = query.trim().toLowerCase();
      const matchesQuery =
        !q ||
        model.modelLabel.toLowerCase().includes(q) ||
        model.endpointName.toLowerCase().includes(q) ||
        model.provider.toLowerCase().includes(q);

      return matchesProvider && matchesQuery;
    });
  }, [models, provider, query]);

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight text-foreground">
            Commercial models
          </h1>
          <p className="mt-1 max-w-3xl text-[14px] leading-6 text-foreground-muted">
            Configure API-key-backed model endpoints exposed in connector setup, which drive provider and model choices during parsing and generation.
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="ml-auto flex items-center gap-2">
          <label className="relative block w-[260px]">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-foreground-subtle" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search models"
              className="h-11 w-full rounded-xl border border-border bg-background-subtle pl-10 pr-4 text-[14px] text-foreground outline-none transition focus:border-accent/40"
            />
          </label>

          <div className="w-[210px]">
            <PickerSelect
              value={provider}
              onChange={setProvider}
              options={providers.map((option) => ({ value: option, label: option }))}
              triggerClassName="h-11 rounded-xl bg-background-subtle text-[14px]"
              contentClassName="z-[110]"
            />
          </div>
          <button
            type="button"
            onClick={() => setEditor({ open: true })}
            className="inline-flex h-11 items-center gap-2 rounded-xl bg-accent px-3.5 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-muted"
          >
            <Plus className="size-4" />
            Add model
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        {filteredModels.map((model) => (
          <section
            key={model.id}
            className="rounded-[16px] border border-border bg-background-subtle p-4 transition hover:border-accent/20 hover:shadow-[0_8px_18px_rgba(15,23,42,0.05)]"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex size-9 items-center justify-center rounded-[18px] bg-background-muted">
                <Cpu className="size-4.5 text-accent" />
              </div>
              <div className="flex items-center gap-2">
                {model.defaultForParsing ? <Badge tone="blue">Parsing</Badge> : null}
                {model.defaultForGeneration ? <Badge tone="green">Generation</Badge> : null}
                <Toggle enabled={model.enabled} onClick={() => toggleEnabled(model.id)} />
              </div>
            </div>

            <div className="mt-4">
              <div className="text-[15px] font-semibold tracking-tight text-foreground">
                {model.modelLabel}
              </div>
              <div className="mt-0.5 text-[12px] text-foreground-muted">{model.endpointName}</div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-border px-3 py-1 text-[12px] text-foreground-muted">
                {model.provider}
              </span>
              <StatusBadge status={model.status} />
            </div>

            <div className="mt-4 flex items-center gap-2 border-t border-border-muted pt-3.5">
              <ActionButton
                icon={PlugZap}
                label="Test"
                onClick={() => {
                  testModel(model.id);
                  toast.success(`${model.modelLabel} tested successfully`);
                }}
              />
              <ActionButton icon={Pencil} label="Edit" onClick={() => setEditor({ open: true, model })} />
              <ActionButton icon={Trash2} label="Delete" onClick={() => setPendingDelete({ open: true, model })} />
            </div>
          </section>
        ))}
      </div>

      <Footer />

      {editor.open ? (
        <ModelEditorDialog
          model={editor.model}
          onClose={() => setEditor({ open: false })}
          onSave={(payload) => {
            const id = upsertModel(payload);
            setEditor({ open: false });
            toast.success(payload.id ? 'Model updated' : 'Model added', {
              description: `${payload.endpointName} is now available in Mode hub.`,
            });
            return id;
          }}
        />
      ) : null}

      {pendingDelete.open && pendingDelete.model ? (
        <DeleteDialog
          model={pendingDelete.model}
          onClose={() => setPendingDelete({ open: false })}
          onConfirm={() => {
            deleteModel(pendingDelete.model!.id);
            setPendingDelete({ open: false });
            toast.success(`${pendingDelete.model!.modelLabel} removed`);
          }}
        />
      ) : null}
    </div>
  );
}

function Badge({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: 'blue' | 'green';
}) {
  const classes =
    tone === 'blue'
      ? 'border-[#9fbfff] bg-[#eef4ff] text-[#2d6cdf]'
      : 'border-[#9de8b9] bg-[#ecfff3] text-[#1f9d60]';

  return <span className={cn('rounded-full border px-2.5 py-0.5 text-[11px] font-medium', classes)}>{children}</span>;
}

function StatusBadge({ status }: { status: IntegrationModelConfig['status'] }) {
  const config =
    status === 'connected'
      ? 'border-[#9de8b9] bg-[#ecfff3] text-[#1f9d60]'
      : status === 'attention'
        ? 'border-[#f5b44c] bg-[#fff7ea] text-[#df7d14]'
        : 'border-border bg-background-muted text-foreground-muted';
  const label = status === 'connected' ? 'Connected' : status === 'attention' ? 'Needs attention' : 'Untested';
  return <span className={cn('rounded-full border px-2.5 py-0.5 text-[11px] font-medium', config)}>{label}</span>;
}

function Toggle({ enabled, onClick }: { enabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'relative h-5.5 w-10 rounded-full transition-colors',
        enabled ? 'bg-accent' : 'border border-border-muted bg-background',
      )}
      aria-label="Toggle model"
    >
      <span
        className={cn(
          'absolute top-0.5 size-4.5 rounded-full bg-white transition-all',
          enabled ? 'left-[20px]' : 'left-0.5',
        )}
      />
    </button>
  );
}

function ActionButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <Tooltip.Provider delayDuration={180}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            onClick={onClick}
            aria-label={label}
            className="inline-flex size-10 items-center justify-center rounded-lg border border-border text-foreground-muted transition hover:bg-background hover:text-foreground"
          >
            <Icon className="size-4" />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="top"
            sideOffset={8}
            className="z-[160] rounded-md bg-foreground px-2.5 py-1 text-[11px] font-medium text-background shadow-lg"
          >
            {label}
            <Tooltip.Arrow className="fill-foreground" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

function ModelEditorDialog({
  model,
  onClose,
  onSave,
}: {
  model?: IntegrationModelConfig;
  onClose: () => void;
  onSave: (payload: {
    id?: string;
    provider: string;
    endpointName: string;
    modelLabel: string;
    apiKey: string;
    enabled: boolean;
  }) => string;
}) {
  const [provider, setProvider] = useState(model?.provider ?? PROVIDERS[0]);
  const [endpointName, setEndpointName] = useState(model?.endpointName ?? '');
  const [modelLabel, setModelLabel] = useState(model?.modelLabel ?? MODELS_BY_PROVIDER[provider][0]);
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(model?.enabled ?? true);
  const modelOptions = MODELS_BY_PROVIDER[provider] ?? [];
  const canConfirm = endpointName.trim().length > 0 && modelLabel.trim().length > 0 && (model ? true : apiKey.trim().length > 0);

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-[rgba(15,23,42,0.42)] p-4">
      <div className="w-full max-w-[720px] rounded-[22px] border border-border bg-background-subtle shadow-[0_24px_72px_rgba(15,23,42,0.22)]">
        <div className="flex items-start justify-between px-6 py-5">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex size-10 items-center justify-center rounded-[16px] bg-background-muted">
              <Cpu className="size-4.5 text-foreground" />
            </div>
            <div>
              <h2 className="text-[16px] font-semibold text-foreground">{provider}</h2>
              <p className="mt-1 text-[12px] text-foreground-muted">
                Configure a provider endpoint and API key for integration setup.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-foreground-subtle transition hover:bg-background-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="size-6" />
          </button>
        </div>

        <div className="border-t border-border-muted px-6 py-6">
          <PickerSelect
            label="Provider"
            value={provider}
            onChange={(value) => {
              setProvider(value);
              setModelLabel(MODELS_BY_PROVIDER[value][0] ?? '');
            }}
            options={PROVIDERS.map((option) => ({
              value: option,
              label: option,
            }))}
            triggerClassName="h-11 rounded-[14px] bg-background px-4 text-[14px] hover:bg-background"
            labelClassName="text-[14px] font-medium text-foreground"
          />

          <div className="mt-5">
            <PickerSelect
              label="Model"
              value={modelLabel}
              onChange={setModelLabel}
              options={modelOptions.map((option) => ({
                value: option,
                label: option,
              }))}
              triggerClassName="h-11 rounded-[14px] bg-background px-4 text-[14px] hover:bg-background"
              labelClassName="text-[14px] font-medium text-foreground"
            />
          </div>

          <label className="mt-5 block space-y-2">
            <span className="text-[14px] font-medium text-foreground">Connection name</span>
            <input
              value={endpointName}
              onChange={(event) => setEndpointName(event.target.value)}
              placeholder="Enter name"
              className="h-11 w-full rounded-[14px] border border-border bg-background px-4 text-[14px] text-foreground outline-none transition focus:border-accent/40"
            />
          </label>

          <label className="mt-5 block space-y-2">
            <span className="text-[14px] font-medium text-foreground">Enter API key</span>
            <div className="text-[12px] text-foreground-muted">
              Found at View API keys &gt; Secret key
            </div>
            <div className="relative">
              <input
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={model ? 'Leave blank to keep existing secret reference' : ''}
                className="h-11 w-full rounded-[14px] border border-border bg-background px-4 pr-11 text-[14px] text-foreground outline-none transition focus:border-accent/40"
              />
              <EyeOff className="pointer-events-none absolute right-3.5 top-1/2 size-4.5 -translate-y-1/2 text-foreground-subtle" />
            </div>
          </label>

          <label className="mt-5 flex items-center gap-3 text-[14px] text-foreground">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
              className="size-4 rounded border-border"
            />
            Expose this model in integration setup
          </label>
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-border-muted px-6 py-5">
          <button
            type="button"
            onClick={onClose}
            className="min-w-[150px] rounded-[14px] border border-border px-5 py-2.5 text-[14px] text-foreground transition hover:bg-background"
          >
            Back
          </button>
          <button
            type="button"
            onClick={() =>
              onSave({
                id: model?.id,
                provider,
                endpointName,
                modelLabel,
                apiKey: apiKey || model?.apiKeyMasked || '',
                enabled,
              })
            }
            disabled={!canConfirm}
            className="min-w-[150px] rounded-[14px] bg-accent px-5 py-2.5 text-[14px] font-medium text-accent-foreground transition hover:bg-accent-muted disabled:cursor-not-allowed disabled:bg-background-elevated disabled:text-foreground-subtle"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteDialog({
  model,
  onClose,
  onConfirm,
}: {
  model: IntegrationModelConfig;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-[rgba(15,23,42,0.42)] p-6">
      <div className="w-full max-w-md rounded-[24px] border border-border bg-background-subtle shadow-[0_30px_100px_rgba(15,23,42,0.24)]">
        <div className="px-6 py-5">
          <h2 className="text-lg font-semibold text-foreground">Delete model</h2>
          <p className="mt-2 text-sm leading-6 text-foreground-muted">
            Remove <span className="font-medium text-foreground">{model.modelLabel}</span> from Mode hub? This will remove it from future integration setup selections.
          </p>
        </div>
        <div className="flex items-center justify-end gap-3 border-t border-border-muted px-6 py-5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-border px-4 py-2.5 text-sm text-foreground-muted transition hover:bg-background"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-xl bg-[#dc2626] px-4 py-2.5 text-sm font-medium text-white transition hover:bg-[#b91c1c]"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

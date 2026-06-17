'use client';

import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  X,
  ArrowLeft,
  ArrowRight,
  Check,
  Upload,
  Plug,
  Globe,
  PenLine,
  Database,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  ingestionModes,
  connectorProviders,
  type KnowledgeMode,
} from '@/lib/mock-data';
import { cn } from '@/lib/utils';

type Step = 1 | 2 | 3 | 4 | 5;

const modeIcon: Record<KnowledgeMode, LucideIcon> = {
  upload: Upload,
  connector: Plug,
  crawl: Globe,
  authored: PenLine,
  api: Database,
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddSourceDialog({ open, onOpenChange }: Props) {
  const [step, setStep] = useState<Step>(1);
  const [mode, setMode] = useState<KnowledgeMode | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [provider, setProvider] = useState('Confluence');
  const [crawlUrl, setCrawlUrl] = useState('');
  const [scope, setScope] = useState<'tenant' | 'project'>('tenant');
  const [refreshCadence, setRefreshCadence] = useState('Every 1 hour');
  const [tags, setTags] = useState('');

  const reset = () => {
    setStep(1);
    setMode(null);
    setName('');
    setDescription('');
    setProvider('Confluence');
    setCrawlUrl('');
    setScope('tenant');
    setRefreshCadence('Every 1 hour');
    setTags('');
  };

  const handleClose = (next: boolean) => {
    if (!next) {
      setTimeout(reset, 200);
    }
    onOpenChange(next);
  };

  const handleConfirm = () => {
    handleClose(false);
    toast.success(`Added "${name || 'new source'}" to the Knowledge Library`);
  };

  const canAdvance = () => {
    if (step === 1) return name.trim().length > 0;
    if (step === 2) return mode !== null;
    if (step === 3) {
      if (mode === 'crawl') return crawlUrl.trim().length > 0;
      return true;
    }
    if (step === 4) return true;
    return true;
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleClose}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-background/40 backdrop-blur-[2px] animate-fade-in" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[600px] max-w-[100vw] rounded-2xl border border-border bg-background-elevated shadow-2xl flex flex-col max-h-[90vh] animate-fade-in">
          <header className="flex items-start justify-between gap-2 px-6 py-4 border-b border-border-muted shrink-0">
            <div>
              <Dialog.Title className="text-base font-semibold tracking-tight">
                Add knowledge source
              </Dialog.Title>
              <p className="text-[11px] text-foreground-muted mt-0.5">
                Step {step} of 5 · {labelForStep(step)}
              </p>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="size-7 rounded-md text-foreground-muted hover:text-foreground hover:bg-background-muted transition-colors flex items-center justify-center"
                aria-label="Close"
              >
                <X className="size-4" />
              </button>
            </Dialog.Close>
          </header>

          <div className="flex-1 overflow-y-auto scrollbar-thin px-6 py-5">
            {step === 1 && (
              <div className="space-y-4">
                <div>
                  <label className="block text-[10px] uppercase tracking-wide text-foreground-meta font-medium mb-1.5">
                    Knowledge base name
                  </label>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g., Card Services FAQ"
                    className="w-full h-9 bg-background-muted/60 border border-border-muted rounded-md px-3 text-sm focus:outline-none focus:ring-1 focus:ring-border-focus/40"
                  />
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-wide text-foreground-meta font-medium mb-1.5">
                    Description
                  </label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Optional description"
                    rows={4}
                    className="w-full resize-none rounded-md border border-border-muted bg-background-muted/60 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-border-focus/40"
                  />
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {ingestionModes.map((m) => {
                  const Icon = modeIcon[m.id];
                  const selected = mode === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setMode(m.id)}
                      className={cn(
                        'text-left rounded-lg border p-3 transition-colors',
                        selected
                          ? 'border-accent bg-background-muted'
                          : 'border-border-muted bg-background-subtle hover:border-border hover:bg-background-muted/40',
                      )}
                    >
                      <div className="flex items-center gap-2 mb-1.5">
                        <div
                          className={cn(
                            'size-7 rounded-md flex items-center justify-center shrink-0',
                            selected
                              ? 'bg-accent text-accent-foreground'
                              : 'bg-background-elevated text-foreground-muted',
                          )}
                        >
                          <Icon className="size-3.5" />
                        </div>
                        <div className="text-sm font-medium">{m.label}</div>
                      </div>
                      <p className="text-[11px] text-foreground-muted leading-relaxed">
                        {m.description}
                      </p>
                    </button>
                  );
                })}
              </div>
            )}

            {step === 3 && mode === 'upload' && (
              <div className="space-y-3">
                <p className="text-xs text-foreground-muted">
                  Drop files or browse. Supported: PDF, DOCX, MD, HTML, TXT, XLSX, PPTX.
                </p>
                <div className="rounded-lg border-2 border-dashed border-border-muted bg-background-muted/30 p-8 text-center">
                  <Upload className="size-8 text-foreground-subtle mx-auto mb-2" />
                  <div className="text-sm text-foreground">Drop files here</div>
                  <div className="text-[11px] text-foreground-subtle mt-1">
                    or click to browse · multiple files supported
                  </div>
                </div>
                <p className="text-[11px] text-foreground-subtle">
                  Prototype: skip ahead and pretend the files were uploaded.
                </p>
              </div>
            )}

            {step === 3 && mode === 'connector' && (
              <div className="space-y-3">
                <div>
                  <label className="block text-[10px] uppercase tracking-wide text-foreground-meta font-medium mb-1.5">
                    Provider
                  </label>
                  <div className="grid grid-cols-3 gap-1.5">
                    {connectorProviders.map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setProvider(p)}
                        className={cn(
                          'px-2 py-1.5 rounded-md text-[11px] font-medium border transition-colors text-left',
                          provider === p
                            ? 'border-accent bg-background-muted text-foreground'
                            : 'border-border-muted text-foreground-muted hover:text-foreground hover:bg-background-muted/40',
                        )}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-wide text-foreground-meta font-medium mb-1.5">
                    Authentication
                  </label>
                  <select className="w-full h-9 bg-background-muted/60 border border-border-muted rounded-md px-2 text-sm focus:outline-none focus:ring-1 focus:ring-border-focus/40">
                    <option>OAuth (recommended)</option>
                    <option>API token</option>
                    <option>SSO-federated identity</option>
                  </select>
                </div>
                <p className="text-[11px] text-foreground-subtle">
                  Prototype: connection step is decorative. Click Continue to proceed.
                </p>
              </div>
            )}

            {step === 3 && mode === 'crawl' && (
              <div className="space-y-3">
                <div>
                  <label className="block text-[10px] uppercase tracking-wide text-foreground-meta font-medium mb-1.5">
                    URL or sitemap
                  </label>
                  <input
                    value={crawlUrl}
                    onChange={(e) => setCrawlUrl(e.target.value)}
                    placeholder="https://your-cu.org/help/sitemap.xml"
                    className="w-full h-9 bg-background-muted/60 border border-border-muted rounded-md px-3 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-border-focus/40"
                  />
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-wide text-foreground-meta font-medium mb-1.5">
                    Scope rules
                  </label>
                  <select className="w-full h-9 bg-background-muted/60 border border-border-muted rounded-md px-2 text-sm focus:outline-none focus:ring-1 focus:ring-border-focus/40">
                    <option>Crawl the entire domain</option>
                    <option>Sitemap pages only</option>
                    <option>Single page only</option>
                  </select>
                </div>
                <label className="flex items-center gap-2 text-xs cursor-pointer">
                  <input type="checkbox" defaultChecked className="size-3.5" />
                  Respect robots.txt
                </label>
              </div>
            )}

            {step === 3 && mode === 'authored' && (
              <div className="space-y-3">
                <p className="text-xs text-foreground-muted">
                  Author FAQ entries, glossary terms, or policy snippets directly.
                </p>
                <div className="space-y-2">
                  <input
                    placeholder="Title"
                    className="w-full h-9 bg-background-muted/60 border border-border-muted rounded-md px-3 text-sm focus:outline-none focus:ring-1 focus:ring-border-focus/40"
                  />
                  <textarea
                    placeholder="Body"
                    rows={6}
                    className="w-full bg-background-muted/60 border border-border-muted rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-border-focus/40 resize-none"
                  />
                </div>
                <p className="text-[11px] text-foreground-subtle">
                  You can add more entries after creating the source.
                </p>
              </div>
            )}

            {step === 3 && mode === 'api' && (
              <div className="space-y-3">
                <p className="text-xs text-foreground-muted">
                  Generate an API key for your CU IT team to push documents from custom systems.
                </p>
                <div className="rounded-md bg-background-muted/40 border border-border-muted p-3">
                  <div className="text-[10px] uppercase tracking-wide text-foreground-meta font-medium mb-1.5">
                    API endpoint
                  </div>
                  <code className="text-xs font-mono text-foreground break-all block">
                    https://eltropy.cornerstone.cu/api/v1/knowledge/sources/&lt;source-id&gt;/upsert
                  </code>
                </div>
                <p className="text-[11px] text-foreground-subtle">
                  Idempotent upserts keyed by external ID. See the docs for full schema.
                </p>
              </div>
            )}

            {step === 4 && (
              <div className="space-y-4">
                <div>
                  <label className="block text-[10px] uppercase tracking-wide text-foreground-meta font-medium mb-1.5">
                    Scope
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setScope('tenant')}
                      className={cn(
                        'rounded-md border p-3 text-left transition-colors',
                        scope === 'tenant'
                          ? 'border-accent bg-background-muted'
                          : 'border-border-muted bg-background-subtle hover:bg-background-muted/40',
                      )}
                    >
                      <div className="text-sm font-medium mb-0.5">Tenant-wide</div>
                      <div className="text-[11px] text-foreground-muted leading-relaxed">
                        Available to all projects&apos; apps
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setScope('project')}
                      className={cn(
                        'rounded-md border p-3 text-left transition-colors',
                        scope === 'project'
                          ? 'border-accent bg-background-muted'
                          : 'border-border-muted bg-background-subtle hover:bg-background-muted/40',
                      )}
                    >
                      <div className="text-sm font-medium mb-0.5">Project-scoped</div>
                      <div className="text-[11px] text-foreground-muted leading-relaxed">
                        Visible only within the chosen project
                      </div>
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-wide text-foreground-meta font-medium mb-1.5">
                    Tags (comma-separated)
                  </label>
                  <input
                    value={tags}
                    onChange={(e) => setTags(e.target.value)}
                    placeholder="reg-e, card-services, disclosures"
                    className="w-full h-9 bg-background-muted/60 border border-border-muted rounded-md px-3 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-border-focus/40"
                  />
                </div>
                {mode !== 'upload' && mode !== 'authored' && (
                  <div>
                    <label className="block text-[10px] uppercase tracking-wide text-foreground-meta font-medium mb-1.5">
                      Refresh cadence
                    </label>
                    <select
                      value={refreshCadence}
                      onChange={(e) => setRefreshCadence(e.target.value)}
                      className="w-full h-9 bg-background-muted/60 border border-border-muted rounded-md px-2 text-sm focus:outline-none focus:ring-1 focus:ring-border-focus/40"
                    >
                      <option>Every 5 min</option>
                      <option>Every 15 min</option>
                      <option>Every 1 hour</option>
                      <option>Every 6 hours</option>
                      <option>Daily</option>
                      <option>Manual</option>
                    </select>
                  </div>
                )}
              </div>
            )}

            {step === 5 && (
              <div className="space-y-3">
                <div className="rounded-md border border-border-muted bg-background-muted/40 p-4 space-y-2 text-xs">
                  <Summary label="Mode" value={mode ? ingestionModes.find((m) => m.id === mode)?.label ?? '' : '—'} />
                  <Summary label="Name" value={name || '—'} />
                  {description && <Summary label="Description" value={description} />}
                  {mode === 'connector' && <Summary label="Provider" value={provider} />}
                  {mode === 'crawl' && <Summary label="URL" value={crawlUrl || '—'} mono />}
                  <Summary label="Scope" value={scope === 'tenant' ? 'Tenant-wide' : 'Project-scoped'} />
                  <Summary label="Refresh" value={refreshCadence} />
                  {tags && <Summary label="Tags" value={tags} mono />}
                </div>
                <p className="text-[11px] text-foreground-muted">
                  Click <strong>Add to Knowledge Library</strong> to confirm. You can refine
                  permissions, sensitive-data tags, and per-app scope after creation.
                </p>
              </div>
            )}
          </div>

          <footer className="px-6 py-3 border-t border-border-muted flex items-center justify-between shrink-0">
            <button
              type="button"
              onClick={() => step > 1 && setStep((s) => (s - 1) as Step)}
              disabled={step === 1}
              className="h-8 px-3 rounded-md text-xs font-medium text-foreground-muted hover:text-foreground hover:bg-background-muted transition-colors flex items-center gap-1.5 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ArrowLeft className="size-3.5" />
              Back
            </button>
            {step < 5 ? (
              <button
                type="button"
                onClick={() => canAdvance() && setStep((s) => (s + 1) as Step)}
                disabled={!canAdvance()}
                className="h-8 px-3.5 rounded-md text-xs font-medium bg-accent text-accent-foreground hover:bg-accent-muted transition-colors flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Continue
                <ArrowRight className="size-3.5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleConfirm}
                className="h-8 px-3.5 rounded-md text-xs font-medium bg-accent text-accent-foreground hover:bg-accent-muted transition-colors flex items-center gap-1.5"
              >
                <Check className="size-3.5" />
                Add to Knowledge Library
              </button>
            )}
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function labelForStep(step: Step): string {
  if (step === 1) return 'General Settings';
  if (step === 2) return 'Choose how to ingest';
  if (step === 3) return 'Configure source';
  if (step === 4) return 'Tag and route';
  return 'Confirm';
}

function Summary({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[100px_1fr] gap-3">
      <div className="text-[10px] uppercase tracking-wide text-foreground-meta font-medium">
        {label}
      </div>
      <div className={cn(mono && 'font-mono break-all')}>{value}</div>
    </div>
  );
}

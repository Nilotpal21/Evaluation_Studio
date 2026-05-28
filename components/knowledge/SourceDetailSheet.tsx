'use client';

import { useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  X,
  RefreshCw,
  Lock,
  AlertOctagon,
  AlertTriangle,
  Lightbulb,
  Sparkles,
  FileText,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  apps,
  type KnowledgeSource,
  type KnowledgeMode,
} from '@/lib/mock-data';
import { useHelper } from '@/lib/helper-state';
import { cn } from '@/lib/utils';

const modeLabel: Record<KnowledgeMode, string> = {
  upload: 'Manual upload',
  connector: 'Connector',
  crawl: 'Web crawl',
  authored: 'In-platform authored',
  api: 'API push',
};

export function SourceDetailSheet({
  source,
  open,
  onOpenChange,
}: {
  source: KnowledgeSource | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [retrievalQuery, setRetrievalQuery] = useState('');
  const [retrievalResults, setRetrievalResults] = useState<
    { source: string; snippet: string; relevance: number }[] | null
  >(null);
  const openHelper = useHelper((s) => s.open);

  if (!source) return null;

  const runRetrieval = () => {
    if (!retrievalQuery.trim()) return;
    setRetrievalResults([
      {
        source: source.documentsPreview?.[0]?.title ?? source.name,
        snippet:
          'Member must be notified of provisional credit decision within 10 business days of receiving the dispute claim, per Reg E §1005.11(c).',
        relevance: 0.93,
      },
      {
        source: source.documentsPreview?.[1]?.title ?? source.name,
        snippet:
          'For joint accounts, both account holders must receive the dispute resolution disclosure unless one is identified as the disputing party.',
        relevance: 0.81,
      },
      {
        source: source.documentsPreview?.[2]?.title ?? source.name,
        snippet:
          'If the dispute involves a card-not-present transaction, the merchant has 60 days to provide compelling evidence before chargeback is finalized.',
        relevance: 0.72,
      },
    ]);
  };

  const consumingApps = apps.filter((a) => source.appsConsumingIds.includes(a.id));

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-background/40 backdrop-blur-[2px] animate-fade-in" />
        <Dialog.Content className="fixed top-0 right-0 z-50 h-screen w-[600px] max-w-[100vw] bg-background-elevated border-l border-border shadow-2xl flex flex-col animate-fade-in">
          <header className="flex items-start justify-between gap-2 px-5 py-4 border-b border-border-muted shrink-0">
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <Dialog.Title className="text-base font-semibold tracking-tight truncate">
                  {source.name}
                </Dialog.Title>
                <span
                  className={cn(
                    'inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide font-medium whitespace-nowrap',
                    source.status === 'active' && 'bg-success-subtle text-success',
                    source.status === 'syncing' && 'bg-info-subtle text-info',
                    source.status === 'stale' && 'bg-warning-subtle text-warning',
                    source.status === 'deprecated' && 'bg-background-muted text-foreground-muted',
                    source.status === 'error' && 'bg-error-subtle text-error',
                  )}
                >
                  {source.status}
                </span>
              </div>
              <p className="text-[11px] text-foreground-muted font-mono truncate">
                {source.provider ?? modeLabel[source.mode]} ·{' '}
                {source.scope === 'project' ? 'project-scoped' : 'tenant-wide'}
                {source.region && ` · ${source.region}`}
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

          <div className="flex-1 overflow-y-auto scrollbar-thin px-5 py-4 space-y-5">
            {source.flags && source.flags.length > 0 && (
              <Panel title="Quality check">
                <ul className="space-y-2">
                  {source.flags.map((f, i) => {
                    const Icon =
                      f.severity === 'blocker'
                        ? AlertOctagon
                        : f.severity === 'warning'
                          ? AlertTriangle
                          : Lightbulb;
                    const cls =
                      f.severity === 'blocker'
                        ? 'text-error'
                        : f.severity === 'warning'
                          ? 'text-warning'
                          : 'text-info';
                    return (
                      <li
                        key={i}
                        className="flex items-start gap-2.5 px-3 py-2 rounded-md bg-background-muted/40 border border-border-muted"
                      >
                        <Icon className={cn('size-3.5 shrink-0 mt-0.5', cls)} />
                        <div className="min-w-0">
                          <div className="text-xs text-foreground">{f.title}</div>
                          {f.detail && (
                            <div className="text-[11px] text-foreground-muted mt-0.5">
                              {f.detail}
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </Panel>
            )}

            <Panel title="Identity">
              <dl className="space-y-2 text-xs">
                <Row label="Source name">
                  <input
                    defaultValue={source.name}
                    className="w-full bg-background-muted/60 border border-border-muted rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-border-focus/40"
                  />
                </Row>
                <Row label="Mode">{modeLabel[source.mode]}</Row>
                <Row label="Provider">{source.provider ?? '—'}</Row>
                <Row label="Source reference">
                  <span className="font-mono text-foreground-muted break-all">
                    {source.sourceRef}
                  </span>
                </Row>
                <Row label="Owner">{source.ownerName}</Row>
                <Row label="Tags">
                  <div className="flex items-center flex-wrap gap-1">
                    {source.tags.map((t) => (
                      <span
                        key={t}
                        className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-background-elevated border border-border-muted font-mono"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </Row>
                {source.sensitiveTags.length > 0 && (
                  <Row label="Sensitive data">
                    <div className="flex items-center flex-wrap gap-1">
                      {source.sensitiveTags.map((t) => (
                        <span
                          key={t}
                          className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-warning-subtle text-warning border border-warning/30 font-mono"
                        >
                          <Lock className="size-2.5" />
                          {t}
                        </span>
                      ))}
                    </div>
                  </Row>
                )}
              </dl>
            </Panel>

            <Panel title="Sync">
              <dl className="space-y-2 text-xs">
                <Row label="Refresh mode">{source.refresh}</Row>
                {source.refreshCadence && <Row label="Cadence">{source.refreshCadence}</Row>}
                <Row label="Last sync">{source.lastSyncedAgo}</Row>
                {source.nextScheduledSync && (
                  <Row label="Next sync">{source.nextScheduledSync}</Row>
                )}
              </dl>
              <button
                type="button"
                onClick={() => toast.success(`Sync triggered for ${source.name}`)}
                className="mt-3 h-7 px-2.5 rounded-md text-[11px] font-medium border border-border-muted text-foreground-muted hover:text-foreground hover:bg-background-elevated transition-colors flex items-center gap-1"
              >
                <RefreshCw className="size-3" />
                Sync now
              </button>
            </Panel>

            {source.documentsPreview && source.documentsPreview.length > 0 && (
              <Panel title="Documents indexed">
                <ul className="space-y-1.5">
                  {source.documentsPreview.map((d, i) => (
                    <li
                      key={i}
                      className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md bg-background-muted/40 border border-border-muted text-xs"
                    >
                      <FileText className="size-3.5 text-foreground-muted shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-foreground truncate">{d.title}</div>
                        <div className="text-[11px] text-foreground-subtle font-mono">
                          {d.pages ? `${d.pages} pages · ` : ''}updated {d.lastUpdated}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </Panel>
            )}

            {consumingApps.length > 0 && (
              <Panel title={`Apps consuming this source (${consumingApps.length})`}>
                <div className="space-y-1.5">
                  {consumingApps.map((a) => (
                    <div
                      key={a.id}
                      className="flex items-center justify-between px-2.5 py-1.5 rounded-md bg-background-muted/40 border border-border-muted text-xs"
                    >
                      <span className="font-mono text-foreground-muted">{a.name}</span>
                      <span className="text-[11px] text-foreground-subtle font-mono">
                        {Math.floor(Math.random() * 400 + 100)} uses · last 24h
                      </span>
                    </div>
                  ))}
                </div>
              </Panel>
            )}

            <Panel title="Test retrieval">
              <p className="text-xs text-foreground-muted mb-2">
                Type a question to see what this source would return.
              </p>
              <div className="flex items-center gap-2">
                <input
                  value={retrievalQuery}
                  onChange={(e) => setRetrievalQuery(e.target.value)}
                  placeholder="What would this source return for…"
                  className="flex-1 h-9 bg-background-muted/60 border border-border-muted rounded-md px-3 text-sm focus:outline-none focus:ring-1 focus:ring-border-focus/40"
                />
                <button
                  type="button"
                  onClick={runRetrieval}
                  disabled={!retrievalQuery.trim()}
                  className="h-9 px-3 rounded-md text-xs font-medium bg-accent text-accent-foreground hover:bg-accent-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Test
                </button>
              </div>
              {retrievalResults && (
                <ul className="mt-3 space-y-2">
                  {retrievalResults.map((r, i) => (
                    <li
                      key={i}
                      className="rounded-md bg-background-muted/40 border border-border-muted p-3"
                    >
                      <div className="flex items-center justify-between text-[11px] mb-1.5">
                        <span className="font-mono text-foreground-muted truncate">{r.source}</span>
                        <span className="font-mono text-success tabular-nums">
                          {(r.relevance * 100).toFixed(0)}% match
                        </span>
                      </div>
                      <p className="text-xs text-foreground leading-relaxed">{r.snippet}</p>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <button
              type="button"
              onClick={() => {
                openHelper({
                  kind: 'mission-control',
                  label: `Knowledge · ${source.name}`,
                });
                setTimeout(() => {
                  useHelper.getState().ask(`Tell me about the ${source.name} source.`);
                }, 50);
              }}
              className="w-full h-9 rounded-md text-xs font-medium bg-purple/15 text-purple hover:bg-purple/20 transition-colors flex items-center justify-center gap-1.5"
            >
              <Sparkles className="size-3.5" />
              Discuss this source with the Helper
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-md border border-border-muted bg-background-subtle p-3">
      <div className="text-[10px] uppercase tracking-wide text-foreground-meta font-medium mb-2">
        {title}
      </div>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 items-start">
      <dt className="text-[10px] uppercase tracking-wide text-foreground-meta font-medium pt-1">
        {label}
      </dt>
      <dd className="text-foreground text-xs min-w-0">{children}</dd>
    </div>
  );
}

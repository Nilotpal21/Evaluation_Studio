'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { notFound, useParams } from 'next/navigation';
import {
  ArrowRight,
  Bot,
  Check,
  Copy,
  Download,
  ExternalLink,
  Search,
  X,
} from 'lucide-react';
import { Footer } from '@/components/shell/Footer';
import { SyncActiveProject } from '@/components/projects/SyncActiveProject';
import { StatusPill } from '@/components/evaluation-studio/shared';
import { apps } from '@/lib/mock-data/apps';
import { getPreProdWorkspace, type PreProdTraceRecord } from '@/lib/mock-data/evaluation-studio';
import { useBackingProjectId, useProjectContext, useResolvedProject } from '@/lib/project-state';
import { cn } from '@/lib/utils';

type ActiveTab = 'sessions' | 'traces';
type SessionDrawerTab = 'evaluation' | 'transcript';
type TraceDrawerTab = 'evaluators' | 'io';
type TraceIOFormat = 'pretty' | 'json';

export default function SessionEvaluationPage() {
  const params = useParams<{ projectId: string }>();
  const project = useResolvedProject(params.projectId);
  const backingProjectId = useBackingProjectId(params.projectId);
  const projectContext = useProjectContext(params.projectId);
  const workspace = getPreProdWorkspace(backingProjectId);
  const [activeTab, setActiveTab] = useState<ActiveTab>('sessions');
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  if (!project || !workspace) notFound();

  if (projectContext?.environment === 'pre_prod' && !projectContext.sessionEvaluationEnabled) {
    return (
      <div className="space-y-6">
        <SyncActiveProject projectId={project.id} />

        <nav className="flex items-center gap-2 text-xs text-foreground-muted">
          <Link href="/projects" className="transition-colors hover:text-foreground">
            Projects
          </Link>
          <span>/</span>
          <Link href={`/projects/${project.id}/evaluations`} className="transition-colors hover:text-foreground">
            Evaluations
          </Link>
          <span>/</span>
          <span className="text-foreground">Session evaluation</span>
        </nav>

        <section className="rounded-lg border border-border-muted bg-background-subtle p-8">
          <div className="max-w-2xl">
            <h1 className="text-2xl font-semibold tracking-tight">Session evaluation is locked</h1>
            <p className="mt-2 text-sm leading-6 text-foreground-muted">
              Run the pre-prod evaluation first. Session traces and evaluator drill-down become
              available only after the pre-prod run starts.
            </p>
            <div className="mt-5">
              <Link
                href={`/projects/${project.id}/evaluations/new?mode=pre_prod&agentId=${projectContext.selectedAgentId}${projectContext.selectedVersionId ? `&versionId=${projectContext.selectedVersionId}` : ''}`}
                className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-muted"
              >
                Run Pre-prod Evaluation
                <ArrowRight className="size-4" />
              </Link>
            </div>
          </div>
        </section>

        <Footer />
      </div>
    );
  }

  const scopedAgent = projectContext
    ? apps.find((app) => app.id === projectContext.selectedAgentId)
    : null;

  useEffect(() => {
    if (activeTab === 'sessions') {
      setSelectedTraceId(null);
    } else {
      setSelectedSessionId(null);
    }
  }, [activeTab]);

  const selectedTrace =
    workspace.traceRows.find((trace) => trace.id === selectedTraceId) ?? null;
  const selectedDetail = selectedTrace
    ? getTraceDetailForRow(workspace, selectedTrace)
    : null;
  const selectedSession = selectedSessionId
    ? getSessionDetailForRow(workspace, selectedSessionId)
    : null;

  return (
    <div className="space-y-3">
      <SyncActiveProject projectId={project.id} />

      <nav className="flex items-center gap-2 text-xs text-foreground-muted">
        <Link href="/projects" className="transition-colors hover:text-foreground">
          Projects
        </Link>
        <span>/</span>
        <Link href={`/projects/${project.id}`} className="transition-colors hover:text-foreground">
          {project.name}
        </Link>
        <span>/</span>
        <span className="text-foreground">Session evaluation</span>
      </nav>

      {scopedAgent ? (
        <div className="text-xs text-foreground-muted">
          Active agent: <span className="text-foreground">{scopedAgent.name}</span>
        </div>
      ) : null}

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div className="inline-flex rounded-xl border border-border-muted bg-background-subtle p-1">
            <TabButton active={activeTab === 'sessions'} onClick={() => setActiveTab('sessions')}>
              Sessions
            </TabButton>
            <TabButton active={activeTab === 'traces'} onClick={() => setActiveTab('traces')}>
              Traces
            </TabButton>
          </div>

          <div className="relative w-full max-w-[260px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-foreground-subtle" />
            <input
              placeholder={activeTab === 'sessions' ? 'Search' : 'Search'}
              className="h-8.5 w-full rounded-md border border-border-muted bg-background pl-9 pr-3 text-sm text-foreground placeholder:text-foreground-subtle focus:outline-none focus:ring-1 focus:ring-border-focus/40"
            />
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border border-border-muted bg-background">
          {activeTab === 'sessions' ? (
            <SessionsTable rows={workspace.sessionRows} selectedSessionId={selectedSessionId} onSelect={setSelectedSessionId} />
          ) : (
            <TraceTable rows={workspace.traceRows} selectedTraceId={selectedTraceId} onSelect={setSelectedTraceId} />
          )}
        </div>
      </section>

      {selectedSession ? (
        <SessionDrawer
          session={selectedSession}
          onClose={() => setSelectedSessionId(null)}
          onShowTraces={() => {
            setSelectedSessionId(null);
            setActiveTab('traces');
          }}
        />
      ) : null}
      {selectedDetail ? <TraceDrawer detail={selectedDetail} onClose={() => setSelectedTraceId(null)} /> : null}

      <Footer />
    </div>
  );
}

function getTraceDetailForRow(
  workspace: NonNullable<ReturnType<typeof getPreProdWorkspace>>,
  trace: PreProdTraceRecord,
) {
  const exact = workspace.traceDetails.find((detail) => detail.traceId === trace.id);
  if (exact) return exact;

  const seed = workspace.traceDetails[0];
  if (!seed) return null;

  return {
    ...seed,
    traceId: trace.id,
    duration: trace.latency,
    inspectors: seed.inspectors.map((inspector) => ({
      ...inspector,
      breadcrumbs: inspector.breadcrumbs.map((crumb, index) =>
        index === 0 ? 'Netomi trace' : crumb,
      ),
    })),
  };
}

function getSessionDetailForRow(
  workspace: NonNullable<ReturnType<typeof getPreProdWorkspace>>,
  sessionId: string,
) {
  const exact = workspace.sessionDetails.find((session) => session.sessionId === sessionId);
  if (exact) return exact;

  const seed = workspace.sessionDetails[0];
  const row = workspace.sessionRows.find((session) => session.id === sessionId);
  if (!seed || !row) return null;

  return {
    ...seed,
    sessionId: row.id,
    duration: row.duration,
    evaluationSummary: {
      ...seed.evaluationSummary,
      workflowSteps: seed.evaluationSummary.workflowSteps.map((step) => ({ ...step })),
    },
    transcript: seed.transcript.map((turn) => ({ ...turn })),
  };
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-md px-3 py-1 text-sm font-medium transition-colors',
        active ? 'bg-background-elevated text-foreground shadow-sm' : 'text-foreground-muted hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function SessionsTable({
  rows,
  selectedSessionId,
  onSelect,
}: {
  rows: Array<{
    id: string;
    traceCount: number;
    createdAt: string;
    duration: string;
    trajectoryCompletion: string;
  }>;
  selectedSessionId: string | null;
  onSelect: (sessionId: string | null) => void;
}) {
  return (
    <div>
      <div className="grid grid-cols-[1.35fr_.65fr_.95fr_.65fr_.7fr] gap-3 border-b border-border-muted bg-background-muted/30 px-3.5 py-2 text-[10px] uppercase tracking-wide text-foreground-meta">
        <div>Session ID</div>
        <div>Traces</div>
        <div>Created at</div>
        <div>Duration</div>
        <div>Completion</div>
      </div>
      {rows.map((row) => (
        <button
          key={row.id}
          type="button"
          onClick={() => onSelect(row.id)}
          className={cn(
            'grid w-full grid-cols-[1.35fr_.65fr_.95fr_.65fr_.7fr] gap-3 border-b border-border-muted px-3.5 py-2 text-left text-sm transition-colors last:border-b-0',
            row.id === selectedSessionId ? 'bg-background-muted/40' : 'hover:bg-background-muted/20',
          )}
        >
          <div>
            <span className="inline-flex rounded-md bg-[rgba(110,94,255,0.14)] px-2 py-1 font-medium text-[#4f46e5]">
              {row.id}
            </span>
          </div>
          <div className="text-foreground-muted">{row.traceCount}</div>
          <div className="text-foreground-muted">{row.createdAt}</div>
          <div className="text-foreground-muted">{row.duration}</div>
          <div>
            <StatusPill tone="info">{row.trajectoryCompletion}</StatusPill>
          </div>
        </button>
      ))}
    </div>
  );
}

function SessionDrawer({
  session,
  onClose,
  onShowTraces,
}: {
  session: NonNullable<ReturnType<typeof getPreProdWorkspace>>['sessionDetails'][number];
  onClose: () => void;
  onShowTraces: () => void;
}) {
  const [activeTab, setActiveTab] = useState<SessionDrawerTab>('transcript');

  return (
    <div className="fixed inset-0 z-40 bg-background/35 backdrop-blur-[2px]">
      <div className="absolute inset-y-0 right-0 w-[min(820px,68vw)] border-l border-border bg-background shadow-2xl">
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between border-b border-border-muted px-4 py-3">
            <div className="flex items-center gap-3">
              <div className="text-sm font-semibold">Session details ({session.duration})</div>
              <div className="text-xs text-foreground-muted">{session.sessionId}</div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full p-2 text-foreground-subtle transition-colors hover:bg-background-muted hover:text-foreground"
            >
              <X className="size-5" />
            </button>
          </div>

          <div className="overflow-auto px-4 py-4">
            <div className="inline-flex rounded-md border border-border-muted bg-background-subtle p-1">
              <button
                type="button"
                onClick={() => setActiveTab('evaluation')}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  activeTab === 'evaluation'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-foreground-muted',
                )}
              >
                Evaluation
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('transcript')}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  activeTab === 'transcript'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-foreground-muted',
                )}
              >
                Transcript
              </button>
            </div>

            {activeTab === 'evaluation' ? (
              <div className="mt-4 space-y-4">
                <div>
                  <h3 className="text-base font-semibold text-foreground">Trajectory completion</h3>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <h4 className="text-base font-semibold text-foreground">Evaluation</h4>
                    <StatusPill tone={session.evaluationSummary.status === 'Pass' ? 'success' : 'error'}>
                      {session.evaluationSummary.status}
                    </StatusPill>
                  </div>

                  <div className="flex items-center gap-3">
                    <h4 className="text-base font-semibold text-foreground">Final goal achieved</h4>
                    <StatusPill tone={session.evaluationSummary.finalGoalAchieved === 'Yes' ? 'success' : 'error'}>
                      {session.evaluationSummary.finalGoalAchieved}
                    </StatusPill>
                  </div>

                  <p className="max-w-2xl text-sm leading-6 text-foreground-muted">
                    {session.evaluationSummary.narrative}
                  </p>
                </div>

                <div>
                  <h4 className="text-base font-semibold text-foreground">Workflow adherence</h4>
                  <div className="mt-3 grid gap-2.5 md:grid-cols-2">
                    {session.evaluationSummary.workflowSteps.map((step) => (
                      <div
                        key={step.id}
                        className="flex items-center justify-between rounded-lg border border-border-muted bg-background p-3"
                      >
                        <span className="text-sm font-medium text-foreground">{step.label}</span>
                        <span
                          className={cn(
                            'inline-flex size-5 items-center justify-center rounded-full',
                            step.status === 'pass'
                              ? 'bg-success-subtle text-success'
                              : 'bg-error-subtle text-error',
                          )}
                        >
                          {step.status === 'pass' ? (
                            <Check className="size-4" />
                          ) : (
                            <X className="size-4" />
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex justify-end border-t border-border-muted pt-3">
                  <button
                    type="button"
                    onClick={onShowTraces}
                    className="inline-flex items-center gap-2 rounded-md bg-accent px-3.5 py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-muted"
                  >
                    Show traces
                    <ExternalLink className="size-4" />
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                {session.transcript.map((turn) => (
                  <TranscriptBubble key={turn.id} turn={turn} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TraceTable({
  rows,
  selectedTraceId,
  onSelect,
}: {
  rows: PreProdTraceRecord[];
  selectedTraceId: string | null;
  onSelect: (traceId: string | null) => void;
}) {
  return (
    <div>
      <div className="grid grid-cols-[1.2fr_.95fr_1.2fr_.65fr] gap-3 border-b border-border-muted bg-background-muted/30 px-4 py-2.5 text-[10px] uppercase tracking-wide text-foreground-meta">
        <div>Trace ID</div>
        <div>Created at</div>
        <div>Session ID</div>
        <div>Latency</div>
      </div>
      {rows.map((row) => (
        <button
          key={row.id}
          type="button"
          onClick={() => onSelect(row.id)}
          className={cn(
            'grid w-full grid-cols-[1.2fr_.95fr_1.2fr_.65fr] gap-3 border-b border-border-muted px-4 py-2.5 text-left text-sm transition-colors last:border-b-0',
            row.id === selectedTraceId ? 'bg-background-muted/40' : 'hover:bg-background-muted/20',
          )}
        >
          <div>
            <span
              className={cn(
                'inline-flex rounded-md border px-2.5 py-1 font-medium text-[#2563eb]',
                row.id === selectedTraceId
                  ? 'border-[#93c5fd] bg-[#eff6ff]'
                  : 'border-[#bfdbfe] bg-[rgba(59,130,246,0.08)]',
              )}
            >
              {row.id}
            </span>
          </div>
          <div className="text-foreground-muted">{row.createdAt}</div>
          <div>
            <span className="inline-flex rounded-md bg-[rgba(110,94,255,0.14)] px-2.5 py-1 font-medium text-[#4f46e5]">
              {row.sessionId}
            </span>
          </div>
          <div className="text-foreground-muted">{row.latency}</div>
        </button>
      ))}
    </div>
  );
}

function TraceDrawer({
  detail,
  onClose,
}: {
  detail: NonNullable<ReturnType<typeof getPreProdWorkspace>>['traceDetails'][number];
  onClose: () => void;
}) {
  const [activeTab, setActiveTab] = useState<TraceDrawerTab>('evaluators');
  const [ioFormat, setIOFormat] = useState<TraceIOFormat>('pretty');
  const [selectedInspectorId, setSelectedInspectorId] = useState<string>(
    detail.inspectors[1]?.nodeId ?? detail.inspectors[0]?.nodeId ?? '',
  );
  const selectedInspector =
    detail.inspectors.find((item) => item.nodeId === selectedInspectorId) ??
    detail.inspectors[0];

  const openInspector = (nodeId: string) => {
    setSelectedInspectorId(nodeId);
    setActiveTab('io');
    setIOFormat('pretty');
  };

  useEffect(() => {
    setSelectedInspectorId(detail.inspectors[1]?.nodeId ?? detail.inspectors[0]?.nodeId ?? '');
    setActiveTab('evaluators');
    setIOFormat('pretty');
  }, [detail.traceId]);

  return (
    <div className="fixed inset-0 z-40 bg-background/35 backdrop-blur-[2px]">
      <div className="absolute inset-y-0 right-0 w-[min(980px,76vw)] border-l border-border bg-background shadow-2xl">
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between border-b border-border-muted px-5 py-3.5">
            <div>
              <div className="text-base font-semibold">Trace details</div>
              <div className="mt-1 text-xs text-foreground-muted">{detail.traceId}</div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full p-2 text-foreground-subtle transition-colors hover:bg-background-muted hover:text-foreground"
            >
              <X className="size-5" />
            </button>
          </div>

          <div className="border-b border-border-muted px-5 py-2.5 text-xs text-foreground-muted">
            {selectedInspector.breadcrumbs.map((crumb, index) => (
              <span key={`${crumb}-${index}`}>
                {index > 0 ? <span className="mx-2">›</span> : null}
                <span>{crumb}</span>
              </span>
            ))}
          </div>

          <div className="grid flex-1 grid-cols-[1fr_.92fr] divide-x divide-border-muted overflow-hidden">
            <div className="overflow-auto px-5 py-5">
              <div className="flex items-center gap-3">
                <h3 className="text-lg font-semibold">Trace details</h3>
                <span className="text-sm font-semibold text-foreground-muted">{detail.traceId}</span>
              </div>

              <div className="mt-4 rounded-lg border border-border-muted bg-background-muted/30 p-4">
                <div className="text-base font-semibold">{detail.header}</div>
                <div className="mt-1 text-sm text-error">
                  {detail.duration} {detail.cost}
                </div>
              </div>

              <div className="mt-4 space-y-3">
                {detail.tree.map((node) => (
                  <TraceTree
                    key={node.id}
                    node={node}
                    selectedNodeId={selectedInspectorId}
                    onSelect={openInspector}
                  />
                ))}
              </div>
            </div>

            <div className="overflow-auto px-5 py-5">
              <div className="inline-flex rounded-lg border border-border-muted bg-background-subtle p-1">
                <button
                  type="button"
                  onClick={() => setActiveTab('evaluators')}
                  className={cn(
                    'rounded-md px-4 py-2 text-sm font-medium transition-colors',
                    activeTab === 'evaluators'
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-foreground-muted',
                  )}
                >
                  Evaluators
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('io')}
                  className={cn(
                    'rounded-md px-4 py-2 text-sm font-medium transition-colors',
                    activeTab === 'io'
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-foreground-muted',
                  )}
                >
                  Input / output
                </button>
              </div>

              <div className="mt-5">
                {activeTab === 'io' ? (
                  <div className="rounded-lg border border-border-muted bg-background p-4">
                    <div className="inline-flex rounded-md border border-border-muted bg-background-subtle p-1">
                      <button
                        type="button"
                        onClick={() => setIOFormat('pretty')}
                        className={cn(
                          'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                          ioFormat === 'pretty'
                            ? 'bg-background text-foreground shadow-sm'
                            : 'text-foreground-muted',
                        )}
                      >
                        Pretty
                      </button>
                      <button
                        type="button"
                        onClick={() => setIOFormat('json')}
                        className={cn(
                          'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                          ioFormat === 'json'
                            ? 'bg-background text-foreground shadow-sm'
                            : 'text-foreground-muted',
                        )}
                      >
                        JSON
                      </button>
                    </div>

                    <div className="mt-4 space-y-4">
                      <IOBlock
                        label="Input"
                        value={formatTraceIO(selectedInspector.input, ioFormat, 'input')}
                        tone="neutral"
                      />
                      <IOBlock
                        label="Output"
                        value={formatTraceIO(selectedInspector.output, ioFormat, 'output')}
                        tone="success"
                      />
                    </div>
                  </div>
                ) : (
                  <div className="mt-5 space-y-5">
                    <div>
                      <div className="flex items-center gap-3">
                        <h4 className="text-base font-semibold">Supervisor’s agent call accuracy</h4>
                        <StatusPill tone="success">{detail.supervisorAccuracy}</StatusPill>
                      </div>
                      <div className="mt-3 space-y-3">
                        {detail.supervisorEvaluators.map((card) => (
                          <EvaluatorCard
                            key={card.id}
                            card={card}
                            onClick={() => {
                              const nodeId = getInspectorNodeIdFromCardTitle(card.title);
                              if (nodeId) openInspector(nodeId);
                            }}
                          />
                        ))}
                      </div>
                    </div>

                    <div>
                      <div className="flex items-center gap-3">
                        <h4 className="text-base font-semibold">Agent’s tool call accuracy</h4>
                        <StatusPill tone="success">{detail.agentToolAccuracy}</StatusPill>
                      </div>
                      <div className="mt-3 space-y-3">
                        {detail.toolEvaluators.map((card) => (
                          <EvaluatorCard
                            key={card.id}
                            card={card}
                            onClick={() => {
                              const nodeId = getInspectorNodeIdFromCardTitle(card.title);
                              if (nodeId) openInspector(nodeId);
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TraceTree({
  node,
  selectedNodeId,
  onSelect,
}: {
  node: NonNullable<ReturnType<typeof getPreProdWorkspace>>['traceDetails'][number]['tree'][number];
  selectedNodeId: string;
  onSelect: (nodeId: string) => void;
}) {
  const isSelected = node.id === selectedNodeId;
  const isTool = node.kind === 'tool';

  return (
    <div
      className={cn(
        'rounded-lg border p-3.5 transition-colors',
        isSelected
          ? 'border-border-focus/60 bg-background-muted/35'
          : 'border-border-muted bg-background',
      )}
    >
      <button
        type="button"
        onClick={() => onSelect(node.id)}
        className="flex w-full items-start justify-between gap-4 text-left"
      >
        <div className="flex items-start gap-3">
          <div
            className={cn(
              'mt-0.5 flex size-7 items-center justify-center rounded-full border bg-background',
              isSelected ? 'border-border-focus/60' : 'border-border-muted',
            )}
          >
            <Bot className="size-3.5 text-foreground-subtle" />
          </div>
          <div>
            <div className={cn('text-sm font-medium', isSelected ? 'text-foreground' : 'text-foreground')}>
              {node.label}
            </div>
            <div className="mt-0.5 text-xs text-foreground-muted">
              {node.duration} {node.cost ? node.cost : ''}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {node.status ? <span className="text-xs font-semibold text-[#2563eb]">{node.status}</span> : null}
          {node.children?.length ? (
            <span className="text-base text-foreground-muted">{node.expanded ? '−' : '+'}</span>
          ) : isTool ? (
            <ArrowRight className="size-4 text-foreground-subtle" />
          ) : null}
        </div>
      </button>
      {node.children?.length ? (
        <div className="mt-3 space-y-2.5 border-l border-border-muted pl-4">
          {node.children.map((child) => (
            <TraceTree
              key={child.id}
              node={child}
              selectedNodeId={selectedNodeId}
              onSelect={onSelect}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function EvaluatorCard({
  card,
  onClick,
}: {
  card: NonNullable<ReturnType<typeof getPreProdWorkspace>>['traceDetails'][number]['supervisorEvaluators'][number];
  onClick?: () => void;
}) {
  const tone = card.status === 'pass' ? 'success' : card.status === 'fail' ? 'error' : 'warning';

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-lg border border-border-muted bg-background p-3.5 text-left transition-colors hover:bg-background-muted/20"
    >
      <div className="flex items-center gap-3">
        <div className="text-sm font-semibold">{card.title}</div>
        <StatusPill tone={tone}>{card.scoreLabel}</StatusPill>
      </div>
      <p className="mt-2 text-xs leading-5 text-foreground-muted">
        {card.body}
      </p>
    </button>
  );
}

function TraceMetric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-lg border border-border-muted bg-background p-3.5">
      <div className="text-[10px] uppercase tracking-wide text-foreground-meta">{label}</div>
      <div className="mt-1.5 text-sm font-semibold text-foreground">{value}</div>
      <div className="mt-1 text-xs text-foreground-muted">{detail}</div>
    </div>
  );
}

function IOBlock({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'neutral' | 'success';
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-semibold text-foreground">{label}</div>
        <div className="flex items-center gap-1 text-foreground-subtle">
          <button
            type="button"
            className="inline-flex size-7 items-center justify-center rounded-md transition-colors hover:bg-background-muted hover:text-foreground"
          >
            <Download className="size-4" />
          </button>
          <button
            type="button"
            className="inline-flex size-7 items-center justify-center rounded-md transition-colors hover:bg-background-muted hover:text-foreground"
          >
            <Copy className="size-4" />
          </button>
        </div>
      </div>
      <div
        className={cn(
          'whitespace-pre-wrap rounded-lg border p-4 text-sm leading-7',
          tone === 'success'
            ? 'border-success/20 bg-success-subtle/40 text-foreground'
            : 'border-border-muted bg-background-muted/20 text-foreground',
        )}
      >
        {value}
      </div>
    </div>
  );
}

function formatTraceIO(value: string, format: TraceIOFormat, kind: 'input' | 'output') {
  if (format === 'pretty') return value;

  return JSON.stringify(
    kind === 'input'
      ? { messages: value }
      : { response: value },
    null,
    2,
  );
}

function getInspectorNodeIdFromCardTitle(title: string) {
  const normalized = title.trim().toLowerCase();

  if (normalized === 'transaction_manager') return 'agent_1';
  if (normalized === 'fund_transfer') return 'tool_2';
  if (normalized === 'check_balance') return 'tool_1';

  return null;
}

function TranscriptBubble({
  turn,
}: {
  turn: NonNullable<ReturnType<typeof getPreProdWorkspace>>['sessionDetails'][number]['transcript'][number];
}) {
  const isPersona = turn.speaker === 'persona';

  return (
    <div className={cn('flex items-start gap-3', isPersona ? '' : '')}>
      <div
        className={cn(
          'mt-1 flex size-9 items-center justify-center rounded-full text-xs font-semibold text-white',
          isPersona ? 'bg-gradient-to-br from-pink-400 via-fuchsia-400 to-purple-500' : 'bg-gradient-to-br from-violet-400 via-fuchsia-400 to-sky-400',
        )}
      >
        {isPersona ? 'P' : 'B'}
      </div>
      <div
        className={cn(
          'max-w-[88%] rounded-xl border px-3.5 py-3',
          isPersona
            ? 'bg-background-muted/40 border-border-muted'
            : 'bg-background border-border-muted',
        )}
      >
        <div className="text-xs font-medium text-foreground-muted">
          {turn.label} <span className="mx-1">•</span> {turn.timestamp}
        </div>
        <p className="mt-1.5 text-sm leading-6 text-foreground">{turn.message}</p>
      </div>
    </div>
  );
}

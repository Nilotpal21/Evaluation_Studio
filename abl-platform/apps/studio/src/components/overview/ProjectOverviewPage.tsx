/**
 * ProjectOverviewPage
 *
 * Adaptive overview page that changes based on project maturity:
 * - Empty: no agents → get-started hero
 * - Building: agents exist, no deployments → metric cards + agent list + CTAs
 * - Live: deployments active → real metrics + activity timeline + dashboard
 */

import { useMemo, useState } from 'react';
import { useRegisterPageHeader } from '../../contexts/PageHeaderContext';
import useSWR from 'swr';
import { useTranslations } from 'next-intl';
import { motion } from 'framer-motion';
import {
  Bot,
  Rocket,
  MessageSquare,
  ArrowRight,
  Zap,
  DollarSign,
  BarChart3,
  Upload,
  Download,
  Wrench,
  BookOpen,
  Workflow,
} from 'lucide-react';
import { useNavigationStore } from '../../store/navigation-store';
import type { RuntimeAgent, RuntimeAgentListResponse } from '../../api/runtime-agents';
import { fetchDeployments, type Deployment } from '../../api/deployments';
import { computeUsageMetrics } from '../../api/usage';
import { useSessionList } from '../../hooks/useSessionList';
import { DetailPageShell } from '../ui/DetailPageShell';
import { EmptyState } from '../ui/EmptyState';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { MetricCard } from '../ui/MetricCard';
import { ActivityTimeline, type ActivityItem } from '../ui/ActivityTimeline';
import { ExportDialog } from '../projects/ExportDialog';
import { ImportDialog } from '../projects/ImportDialog';

type ProjectPhase = 'loading' | 'empty' | 'building' | 'live';

/** Matches DSL `SUPERVISOR:` declaration — keep in sync with AgentListPage.isSupervisor */
const SUPERVISOR_RE = /^\s*SUPERVISOR\s*:/m;

interface ResourceCardProps {
  icon: React.ReactNode;
  iconBg: string;
  label: string;
  href: string;
  navigate: (path: string) => void;
}

function ResourceCard({ icon, iconBg, label, href, navigate }: ResourceCardProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => navigate(href)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') navigate(href);
      }}
      className="flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-background-muted transition-default cursor-pointer group"
    >
      <div className="flex items-center gap-3">
        <div className={`w-7 h-7 rounded-md ${iconBg} flex items-center justify-center shrink-0`}>
          {icon}
        </div>
        <span className="text-sm font-medium text-foreground">{label}</span>
      </div>
      <ArrowRight className="w-3.5 h-3.5 text-subtle opacity-0 group-hover:opacity-100 transition-default" />
    </div>
  );
}

export function ProjectOverviewPage() {
  const t = useTranslations('overview');
  const { projectId, navigate } = useNavigationStore();
  const { sessions } = useSessionList(projectId);
  const [showExport, setShowExport] = useState(false);
  const [showImport, setShowImport] = useState(false);

  const timeAgo = (dateStr: string): string => {
    const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (seconds < 60) return t('time_just_now');
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return t('time_minutes_ago', { minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('time_hours_ago', { hours });
    const days = Math.floor(hours / 24);
    return t('time_days_ago', { days });
  };

  // Fetch agents
  const agentKey = projectId ? `/api/projects/${projectId}/agents` : null;
  const {
    data: agentData,
    isLoading: agentsLoading,
    mutate: mutateAgents,
  } = useSWR<RuntimeAgentListResponse>(agentKey);
  const agents = agentData?.agents ?? [];

  // Fetch deployments (uses custom fetcher since it goes direct to runtime)
  const { data: deployData, isLoading: deploymentsLoading } = useSWR(
    projectId ? ['deployments', projectId] : null,
    () =>
      fetchDeployments(projectId!).catch(() => ({
        success: false,
        deployments: [] as Deployment[],
      })),
  );
  const deployments = useMemo(
    () => (deployData?.deployments ?? []).filter((d) => d.status === 'active'),
    [deployData],
  );

  // Fetch tools count
  const { data: toolsData } = useSWR(
    projectId ? `/api/projects/${encodeURIComponent(projectId)}/tools` : null,
  );
  const toolsCount = (() => {
    if (!toolsData) return 0;
    const td = toolsData as Record<string, unknown>;
    if (Array.isArray(td.tools)) return td.tools.length;
    if (Array.isArray(td.data)) return td.data.length;
    return 0;
  })();

  // Fetch workflows count
  const { data: workflowsData } = useSWR(
    projectId ? `/api/projects/${encodeURIComponent(projectId)}/workflows` : null,
  );
  const workflowsCount = (() => {
    if (!workflowsData) return 0;
    const wd = workflowsData as Record<string, unknown>;
    if (Array.isArray(wd.workflows)) return wd.workflows.length;
    if (Array.isArray(wd.data)) return wd.data.length;
    return 0;
  })();

  // Fetch knowledge bases count (goes to SearchAI engine, may not be available)
  const { data: kbData } = useSWR(
    projectId ? `/api/search-ai/knowledge-bases?projectId=${projectId}` : null,
    { shouldRetryOnError: false, errorRetryCount: 0 },
  );
  const kbCount = (() => {
    if (!kbData) return 0;
    if (Array.isArray(kbData)) return kbData.length;
    const kb = kbData as Record<string, unknown>;
    if (Array.isArray(kb.knowledgeBases)) return kb.knowledgeBases.length;
    if (Array.isArray(kb.data)) return kb.data.length;
    return 0;
  })();

  // Find the best entry agent for chat (supervisor > "start" in name > first)
  const chatAgent = useMemo(() => {
    if (agents.length === 0) return null;
    const supervisor = agents.find((a) => SUPERVISOR_RE.test(a.dslContent ?? ''));
    if (supervisor) return supervisor;
    const startAgent = agents.find((a) => a.name.toLowerCase().includes('start'));
    if (startAgent) return startAgent;
    return agents[0];
  }, [agents]);

  // Compute metrics from already-loaded sessions (no extra fetch)
  const metrics = useMemo(
    () => (sessions.length > 0 ? computeUsageMetrics(sessions) : null),
    [sessions],
  );

  // Derive phase from data
  const phase: ProjectPhase =
    agentsLoading || deploymentsLoading
      ? 'loading'
      : agents.length === 0
        ? 'empty'
        : deployments.length === 0
          ? 'building'
          : 'live';

  // Memoized — stable reference required by useRegisterPageHeader to avoid re-render loops.
  // MUST be declared before any early return to satisfy Rules of Hooks.
  const importExportActions = useMemo(
    () => (
      <div className="flex gap-2">
        <Button
          variant="secondary"
          icon={<Upload className="w-4 h-4" />}
          onClick={() => setShowImport(true)}
        >
          {t('import')}
        </Button>
        <Button
          variant="secondary"
          icon={<Download className="w-4 h-4" />}
          onClick={() => setShowExport(true)}
        >
          {t('export')}
        </Button>
      </div>
    ),
    // setShowImport/setShowExport are stable useState setters; t is stable from next-intl
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Hoist page title + Import/Export actions into the AppShell content header bar.
  // Called unconditionally (before early returns) to satisfy Rules of Hooks.
  useRegisterPageHeader(t('heading'), importExportActions);

  if (phase === 'loading') {
    return <OverviewSkeleton />;
  }

  // Shared dialogs — rendered outside phase-conditional blocks so they
  // survive phase transitions (e.g. empty → building after import).
  const dialogs = projectId && (
    <>
      <ExportDialog open={showExport} onClose={() => setShowExport(false)} projectId={projectId} />
      <ImportDialog
        open={showImport}
        onClose={() => setShowImport(false)}
        projectId={projectId}
        onImported={() => mutateAgents()}
      />
    </>
  );

  if (phase === 'empty') {
    return (
      <>
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            icon={<Bot className="w-7 h-7" />}
            title={t('empty_title')}
            description={t('empty_description')}
            action={
              <div className="flex flex-col items-center gap-2">
                <Button
                  variant="primary"
                  icon={<ArrowRight className="w-4 h-4" />}
                  onClick={() => navigate(`/projects/${projectId}/agents`)}
                >
                  {t('empty_go_to_agents')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Upload className="w-3.5 h-3.5" />}
                  onClick={() => setShowImport(true)}
                >
                  {t('empty_import_agents')}
                </Button>
              </div>
            }
          />
        </div>
        {dialogs}
      </>
    );
  }

  if (phase === 'building') {
    return (
      <DetailPageShell
        title={t('heading')}
        hideTitle
        maxWidth="full"
        className="bg-noise relative overflow-hidden"
      >
        {/* Ambient gradient blobs */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 0.3, scale: 1 }}
            transition={{ duration: 1.5, ease: 'easeOut' }}
            className="absolute -top-32 -right-32 w-80 h-80 bg-accent/10 rounded-full blur-3xl"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 0.15, scale: 1 }}
            transition={{ duration: 1.5, delay: 0.3, ease: 'easeOut' }}
            className="absolute -bottom-40 -left-40 w-96 h-96 bg-accent/5 rounded-full blur-3xl"
          />
        </div>
        {/* Metric cards row */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 -mt-2 mb-6">
          {[
            { label: t('metric_agents'), value: agents.length, icon: <Bot className="w-4 h-4" /> },
            {
              label: t('metric_sessions'),
              value: sessions.length || '—',
              icon: <MessageSquare className="w-4 h-4" />,
            },
            {
              label: t('metric_deployed'),
              value: `0 / ${agents.length}`,
              icon: <Rocket className="w-4 h-4" />,
            },
          ].map((m, i) => (
            <motion.div
              key={m.label}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: i * 0.07, ease: [0.22, 1, 0.36, 1] }}
            >
              <MetricCard label={m.label} value={m.value} icon={m.icon} />
            </motion.div>
          ))}
        </div>

        {/* 60/40 split: Agents + Resources & Actions */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* Agents section (3/5 = 60%) */}
          <div className="lg:col-span-3">
            <h2 className="text-xs font-medium text-subtle uppercase tracking-wider mb-3">
              {t('agents_count', { count: agents.length })}
            </h2>
            <div className="space-y-1">
              {agents.map((agent, i) => (
                <motion.div
                  key={agent.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.25, delay: 0.2 + i * 0.04, ease: [0.22, 1, 0.36, 1] }}
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(`/projects/${projectId}/agents/${agent.name}`)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') navigate(`/projects/${projectId}/agents/${agent.name}`);
                  }}
                  className="flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-background-muted transition-default cursor-pointer group"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-7 h-7 rounded-md bg-accent-subtle flex items-center justify-center shrink-0">
                      <Bot className="w-3.5 h-3.5 text-accent" />
                    </div>
                    <span className="text-sm font-medium text-foreground truncate">
                      {agent.name.replace(/_/g, ' ')}
                    </span>
                    <span className="w-1.5 h-1.5 rounded-full bg-foreground-subtle/30 shrink-0" />
                  </div>
                  <div className="flex items-center gap-2 text-xs text-subtle opacity-0 group-hover:opacity-100 transition-default">
                    <ArrowRight className="w-3.5 h-3.5" />
                  </div>
                </motion.div>
              ))}
            </div>
          </div>

          {/* Right side (2/5 = 40%) */}
          <div className="lg:col-span-2 space-y-6">
            {/* Resources */}
            {(toolsCount > 0 || workflowsCount > 0 || kbCount > 0) && (
              <div>
                <h2 className="text-xs font-medium text-subtle uppercase tracking-wider mb-3">
                  {t('resources')}
                </h2>
                <div className="space-y-1">
                  {toolsCount > 0 && (
                    <ResourceCard
                      icon={<Wrench className="w-3.5 h-3.5 text-success" />}
                      iconBg="bg-success-subtle"
                      label={t('resource_tools', { count: toolsCount })}
                      href={`/projects/${projectId}/tools`}
                      navigate={navigate}
                    />
                  )}
                  {kbCount > 0 && (
                    <ResourceCard
                      icon={<BookOpen className="w-3.5 h-3.5 text-info" />}
                      iconBg="bg-info-subtle"
                      label={t('resource_knowledge', { count: kbCount })}
                      href={`/projects/${projectId}/search-ai`}
                      navigate={navigate}
                    />
                  )}
                  {workflowsCount > 0 && (
                    <ResourceCard
                      icon={<Workflow className="w-3.5 h-3.5 text-purple" />}
                      iconBg="bg-purple-subtle"
                      label={t('resource_workflows', { count: workflowsCount })}
                      href={`/projects/${projectId}/workflows`}
                      navigate={navigate}
                    />
                  )}
                </div>
              </div>
            )}

            {/* Quick Actions */}
            <div>
              <h2 className="text-xs font-medium text-subtle uppercase tracking-wider mb-3">
                {t('quick_actions')}
              </h2>
              <div className="space-y-2">
                <Card
                  hoverable
                  onClick={() => {
                    if (chatAgent) navigate(`/projects/${projectId}/agents/${chatAgent.name}/chat`);
                  }}
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-info-subtle flex items-center justify-center shrink-0">
                      <MessageSquare className="w-4 h-4 text-info" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        {t('test_agents_title')}
                      </p>
                      <p className="text-xs text-muted">{t('test_agents_description')}</p>
                    </div>
                  </div>
                </Card>
                <Card hoverable onClick={() => navigate(`/projects/${projectId}/deployments`)}>
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-success-subtle flex items-center justify-center shrink-0">
                      <Rocket className="w-4 h-4 text-success" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-foreground">{t('deploy_title')}</p>
                      <p className="text-xs text-muted">{t('deploy_description')}</p>
                    </div>
                  </div>
                </Card>
              </div>
            </div>
          </div>
        </div>

        {dialogs}
      </DetailPageShell>
    );
  }

  // Live state
  const recentSessions = sessions.slice(0, 5);
  const deployedAgentNames = new Set(deployments.map((d) => d.entryAgentName));

  const activityItems: ActivityItem[] = recentSessions.map((s) => ({
    id: s.id,
    icon: <MessageSquare className="w-3.5 h-3.5" />,
    description: `${s.agentName} — ${s.id.slice(0, 8)} — ${t('message_count', { count: s.messageCount })}`,
    timestamp: timeAgo(s.lastActivityAt),
    onClick: () => navigate(`/projects/${projectId}/sessions/${s.id}`),
  }));

  return (
    <DetailPageShell
      title={t('heading')}
      hideTitle
      maxWidth="full"
      className="bg-noise relative overflow-hidden"
    >
      {/* Ambient gradient blobs */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 0.3, scale: 1 }}
          transition={{ duration: 1.5, ease: 'easeOut' }}
          className="absolute -top-32 -right-32 w-80 h-80 bg-accent/10 rounded-full blur-3xl"
        />
        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 0.15, scale: 1 }}
          transition={{ duration: 1.5, delay: 0.3, ease: 'easeOut' }}
          className="absolute -bottom-40 -left-40 w-96 h-96 bg-accent/5 rounded-full blur-3xl"
        />
      </div>

      {/* Metric cards row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 -mt-2 mb-6">
        {[
          {
            label: t('metric_sessions'),
            value: metrics?.totalSessions ?? '—',
            icon: <MessageSquare className="w-4 h-4" />,
          },
          {
            label: t('stat_messages'),
            value: metrics ? formatNumber(metrics.totalMessages) : '—',
            icon: <BarChart3 className="w-4 h-4" />,
          },
          {
            label: t('stat_tokens'),
            value: metrics ? formatNumber(metrics.totalTokens) : '—',
            icon: <Zap className="w-4 h-4" />,
          },
          {
            label: t('stat_cost'),
            value: metrics ? `$${metrics.estimatedCost.toFixed(2)}` : '—',
            icon: <DollarSign className="w-4 h-4" />,
          },
          {
            label: t('metric_deployed'),
            value: `${deployments.length} / ${agents.length}`,
            icon: <Rocket className="w-4 h-4" />,
          },
        ].map((m, i) => (
          <motion.div
            key={m.label}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: i * 0.07, ease: [0.22, 1, 0.36, 1] }}
          >
            <MetricCard label={m.label} value={m.value} icon={m.icon} />
          </motion.div>
        ))}
      </div>

      {/* 60/40 split: Agents + Activity/Quick Actions */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Agents section (3/5 = 60%) */}
        <div className="lg:col-span-3">
          <h2 className="text-xs font-medium text-subtle uppercase tracking-wider mb-3">
            {t('agents_count', { count: agents.length })}
          </h2>
          <div className="space-y-1">
            {agents.map((agent, i) => {
              const isDeployed = deployedAgentNames.has(agent.name);
              const agentSessionCount = sessions.filter((s) => s.agentName === agent.name).length;
              return (
                <motion.div
                  key={agent.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.25, delay: 0.2 + i * 0.04, ease: [0.22, 1, 0.36, 1] }}
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(`/projects/${projectId}/agents/${agent.name}`)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') navigate(`/projects/${projectId}/agents/${agent.name}`);
                  }}
                  className="flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-background-muted transition-default cursor-pointer group"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-7 h-7 rounded-md bg-accent-subtle flex items-center justify-center shrink-0">
                      <Bot className="w-3.5 h-3.5 text-accent" />
                    </div>
                    <span className="text-sm font-medium text-foreground truncate">
                      {agent.name.replace(/_/g, ' ')}
                    </span>
                    <span
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${isDeployed ? 'bg-success' : 'bg-foreground-subtle/30'}`}
                    />
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {agentSessionCount > 0 && (
                      <span className="text-xs text-subtle">
                        {t('session_count', { count: agentSessionCount })}
                      </span>
                    )}
                    <ArrowRight className="w-3.5 h-3.5 text-subtle opacity-0 group-hover:opacity-100 transition-default" />
                  </div>
                </motion.div>
              );
            })}
          </div>
        </div>

        {/* Right side (2/5 = 40%) */}
        <div className="lg:col-span-2 space-y-6">
          {/* Resources */}
          {(toolsCount > 0 || workflowsCount > 0 || kbCount > 0) && (
            <div>
              <h2 className="text-xs font-medium text-subtle uppercase tracking-wider mb-3">
                {t('resources')}
              </h2>
              <div className="space-y-1">
                {toolsCount > 0 && (
                  <ResourceCard
                    icon={<Wrench className="w-3.5 h-3.5 text-success" />}
                    iconBg="bg-success-subtle"
                    label={t('resource_tools', { count: toolsCount })}
                    href={`/projects/${projectId}/tools`}
                    navigate={navigate}
                  />
                )}
                {kbCount > 0 && (
                  <ResourceCard
                    icon={<BookOpen className="w-3.5 h-3.5 text-info" />}
                    iconBg="bg-info-subtle"
                    label={t('resource_knowledge', { count: kbCount })}
                    href={`/projects/${projectId}/search-ai`}
                    navigate={navigate}
                  />
                )}
                {workflowsCount > 0 && (
                  <ResourceCard
                    icon={<Workflow className="w-3.5 h-3.5 text-purple" />}
                    iconBg="bg-purple-subtle"
                    label={t('resource_workflows', { count: workflowsCount })}
                    href={`/projects/${projectId}/workflows`}
                    navigate={navigate}
                  />
                )}
              </div>
            </div>
          )}

          {/* Active Deployments */}
          {deployments.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-xs font-medium text-subtle uppercase tracking-wider">
                  {t('active_deployments')}
                </h2>
                <button
                  onClick={() => navigate(`/projects/${projectId}/deployments`)}
                  className="text-xs text-info hover:underline"
                >
                  {t('view_all')}
                </button>
              </div>
              <div className="space-y-1">
                {deployments.map((d) => (
                  <div
                    key={d.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => navigate(`/projects/${projectId}/deployments`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') navigate(`/projects/${projectId}/deployments`);
                    }}
                    className="flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-background-muted transition-default cursor-pointer group"
                  >
                    <div className="flex items-center gap-3">
                      <Badge variant={envBadgeVariant(d.environment)} dot>
                        {d.environment}
                      </Badge>
                      <span className="text-sm font-medium text-foreground">
                        {d.entryAgentName}
                      </span>
                    </div>
                    <span className="text-xs text-subtle">{timeAgo(d.createdAt)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Activity Timeline */}
          {activityItems.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-xs font-medium text-subtle uppercase tracking-wider">
                  {t('recent_activity')}
                </h2>
                <button
                  onClick={() => navigate(`/projects/${projectId}/sessions`)}
                  className="text-xs text-info hover:underline"
                >
                  {t('view_all')}
                </button>
              </div>
              <ActivityTimeline items={activityItems} maxItems={5} />
            </div>
          )}

          {/* Quick Actions */}
          <div>
            <h2 className="text-xs font-medium text-subtle uppercase tracking-wider mb-3">
              {t('quick_actions')}
            </h2>
            <div className="space-y-2">
              <Card
                hoverable
                onClick={() => {
                  if (chatAgent) navigate(`/projects/${projectId}/agents/${chatAgent.name}/chat`);
                }}
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-info-subtle flex items-center justify-center shrink-0">
                    <MessageSquare className="w-4 h-4 text-info" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">{t('test_agents_title')}</p>
                    <p className="text-xs text-muted">{t('test_agents_description')}</p>
                  </div>
                </div>
              </Card>
              <Card hoverable onClick={() => navigate(`/projects/${projectId}/deployments`)}>
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-success-subtle flex items-center justify-center shrink-0">
                    <Rocket className="w-4 h-4 text-success" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">{t('deploy_title')}</p>
                    <p className="text-xs text-muted">{t('deploy_description')}</p>
                  </div>
                </div>
              </Card>
            </div>
          </div>
        </div>
      </div>

      {dialogs}
    </DetailPageShell>
  );
}

// Skeletons

function OverviewSkeleton() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto px-6 py-6 max-w-full animate-fade-in bg-noise">
        {/* Title placeholder */}
        <div className="w-32 h-7 rounded skeleton mb-6" />

        {/* 5 Metric card skeletons */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="bg-background-elevated border border-default rounded-xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-4 h-4 rounded skeleton" />
                <div className="w-16 h-3 rounded skeleton" />
              </div>
              <div className="w-12 h-7 rounded skeleton mb-1" />
              <div className="w-20 h-3 rounded skeleton" />
            </div>
          ))}
        </div>

        {/* 60/40 split */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* Agents section (3/5) */}
          <div className="lg:col-span-3">
            <div className="w-24 h-3 rounded skeleton mb-4" />
            <div className="space-y-1">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-3 py-2.5 rounded-lg">
                  <div className="w-7 h-7 rounded-md skeleton shrink-0" />
                  <div className="w-32 h-4 rounded skeleton" />
                  <div className="w-1.5 h-1.5 rounded-full skeleton ml-1" />
                </div>
              ))}
            </div>
          </div>

          {/* Right side (2/5) */}
          <div className="lg:col-span-2 space-y-6">
            <div>
              <div className="w-28 h-3 rounded skeleton mb-4" />
              <div className="space-y-2">
                {Array.from({ length: 2 }).map((_, i) => (
                  <div
                    key={i}
                    className="bg-background-elevated border border-default rounded-lg p-4"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg skeleton shrink-0" />
                      <div>
                        <div className="w-28 h-4 rounded skeleton mb-1" />
                        <div className="w-40 h-3 rounded skeleton" />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Helpers

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function envBadgeVariant(env: string) {
  switch (env) {
    case 'production':
      return 'success' as const;
    case 'staging':
      return 'warning' as const;
    default:
      return 'info' as const;
  }
}

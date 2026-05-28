/**
 * CreateDeploymentDialog Component
 *
 * Dialog for creating a new deployment with environment selection,
 * version manifest picker, and entry agent selection.
 *
 * Design:
 * - "Latest active" vs "Customize per agent" card-style strategy toggle
 * - All agents always included (no "skip" — every agent deploys)
 * - Domain-grouped, collapsible agent list with search filter
 * - Inline model overrides per agent via gear icon
 * - Wide 2xl dialog with spacious layout
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Search,
  Settings,
  Layers,
  Zap,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { toast } from 'sonner';
import { sanitizeError } from '../../lib/sanitize-error';
import { createDeployment, type ModelOverride } from '../../api/deployments';
import { apiFetch } from '../../lib/api-client';
import { validateEnvVars, createEnvironmentVariable } from '../../api/environment-variables';
import { getRuntimeUrl } from '../../config/runtime';
import { formatModelOptionLabel } from '../../lib/model-display';

interface Agent {
  id: string;
  name: string;
  domain?: string;
  versionCount: number;
}

interface VersionRecord {
  version: string;
  status: string;
}

interface ProjectModelOption {
  modelId: string;
  name?: string | null;
  displayName?: string | null;
  provider?: string | null;
  isDefault?: boolean;
}

interface CreateDeploymentDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  defaultEnvironment?: string;
  onCreated: () => void;
}

const statusVariants: Record<string, 'success' | 'info' | 'warning' | 'default' | 'error'> = {
  active: 'success',
  staged: 'info',
  testing: 'warning',
  draft: 'default',
  deprecated: 'error',
};

function getBestVersion(versions: VersionRecord[]): VersionRecord | undefined {
  return (
    versions.find((v) => v.status === 'active') ||
    versions.find((v) => v.status === 'staged') ||
    versions.find((v) => v.status === 'testing') ||
    versions[0]
  );
}

export function CreateDeploymentDialog({
  open,
  onClose,
  projectId,
  defaultEnvironment,
  onCreated,
}: CreateDeploymentDialogProps) {
  const t = useTranslations('deployments');
  const [environment, setEnvironment] = useState(defaultEnvironment || 'dev');
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentVersions, setAgentVersions] = useState<Record<string, VersionRecord[]>>({});
  const [manifest, setManifest] = useState<Record<string, string>>({});
  const [entryAgent, setEntryAgent] = useState('');
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [modelOverrides, setModelOverrides] = useState<Record<string, ModelOverride>>({});
  const [projectModels, setProjectModels] = useState<ProjectModelOption[]>([]);

  const [strategy, setStrategy] = useState<'latest' | 'custom'>('latest');
  const [filter, setFilter] = useState('');
  const [expandedOverride, setExpandedOverride] = useState<string | null>(null);

  // Env var validation
  const [missingEnvVars, setMissingEnvVars] = useState<string[]>([]);
  const [definedEnvVars, setDefinedEnvVars] = useState<string[]>([]);
  const [envVarValues, setEnvVarValues] = useState<Record<string, string>>({});
  const [definingEnvVars, setDefiningEnvVars] = useState(false);

  // Filter agents by search query
  const filteredAgents = useMemo(() => {
    if (!filter.trim()) return agents;
    const q = filter.toLowerCase();
    return agents.filter((a) => a.name.toLowerCase().includes(q));
  }, [agents, filter]);

  // Count customized agents (version differs from best-available)
  const customizedCount = useMemo(() => {
    let count = 0;
    for (const agent of agents) {
      const versions = agentVersions[agent.name] || [];
      const best = getBestVersion(versions);
      const bestVersion = best?.version || 'auto';
      if (manifest[agent.name] && manifest[agent.name] !== bestVersion) {
        count++;
      }
    }
    return count;
  }, [agents, agentVersions, manifest]);

  // Summary text
  const summaryText = useMemo(() => {
    const n = agents.length;
    if (n === 0) return '';
    if (strategy === 'latest' || customizedCount === 0) {
      return t('create_dialog.summary_all_latest', { count: n, domainPart: '' });
    }
    return t('create_dialog.summary_customized', {
      count: n,
      domainPart: '',
      customized: customizedCount,
    });
  }, [agents.length, strategy, customizedCount, t]);

  // Auto versions count
  const autoVersionCount = useMemo(() => {
    return agents.filter((a) => manifest[a.name] === 'auto').length;
  }, [agents, manifest]);

  // Load agents and their versions
  const loadAgentData = useCallback(async () => {
    if (!open || !projectId) return;
    setLoading(true);
    try {
      const agentsRes = await apiFetch(`${getRuntimeUrl()}/api/projects/${projectId}/agents`, {
        headers: { 'Content-Type': 'application/json' },
      });
      const agentsData = await agentsRes.json();
      const agentList: Agent[] = agentsData.agents || [];
      setAgents(agentList);

      const versionsMap: Record<string, VersionRecord[]> = {};
      const defaultManifest: Record<string, string> = {};

      const versionResults = await Promise.all(
        agentList.map(async (agent) => {
          try {
            const versionsRes = await apiFetch(
              `${getRuntimeUrl()}/api/projects/${projectId}/agents/${agent.name}/versions?limit=50`,
              { headers: { 'Content-Type': 'application/json' } },
            );
            const versionsData = await versionsRes.json();
            return { name: agent.name, versions: (versionsData.versions || []) as VersionRecord[] };
          } catch {
            return { name: agent.name, versions: [] as VersionRecord[] };
          }
        }),
      );

      for (const { name, versions: rawVersions } of versionResults) {
        const versions = rawVersions.filter((v: VersionRecord) => v.status !== 'deprecated');
        versionsMap[name] = versions;
        const preferred = getBestVersion(versions);
        defaultManifest[name] = preferred ? preferred.version : 'auto';
      }

      setAgentVersions(versionsMap);
      setManifest(defaultManifest);

      if (agentList.length > 0 && !entryAgent) {
        setEntryAgent(agentList[0].name);
      }

      try {
        const modelsRes = await apiFetch(`/api/models?projectId=${projectId}`);
        const modelsData = await modelsRes.json();
        setProjectModels(
          (modelsData.models || []).map((m: any) => ({
            modelId: m.modelId,
            name: m.name,
            displayName: m.displayName,
            provider: m.provider,
            isDefault: m.isDefault,
          })),
        );
      } catch {
        // Non-critical
      }
    } catch {
      toast.error(t('create_dialog.error_agents_load'));
    } finally {
      setLoading(false);
    }
  }, [open, projectId]);

  useEffect(() => {
    loadAgentData();
  }, [loadAgentData]);

  // Reset on close
  useEffect(() => {
    if (!open) {
      setLabel('');
      setDescription('');
      setManifest({});
      setEntryAgent('');
      setModelOverrides({});
      setStrategy('latest');
      setFilter('');
      setExpandedOverride(null);
      setMissingEnvVars([]);
      setDefinedEnvVars([]);
      setEnvVarValues({});
    }
  }, [open]);

  useEffect(() => {
    if (defaultEnvironment) setEnvironment(defaultEnvironment);
  }, [defaultEnvironment]);

  // Validate env vars when environment or agents change
  useEffect(() => {
    if (!open || agents.length === 0) return;
    const agentNames = agents.map((a) => a.name);
    validateEnvVars(projectId, environment, agentNames)
      .then((result) => {
        setMissingEnvVars(result.missing || []);
        setDefinedEnvVars(result.defined || []);
      })
      .catch(() => {
        // Non-critical — don't block deployment
      });
  }, [open, projectId, environment, agents]);

  const handleVersionChange = (agentName: string, version: string) => {
    setManifest((prev) => ({ ...prev, [agentName]: version }));
  };

  const handleSubmit = async () => {
    if (!entryAgent || !manifest[entryAgent]) {
      toast.error(t('create_dialog.error_no_version'));
      return;
    }

    setCreating(true);
    try {
      const finalOverrides: Record<string, ModelOverride> = {};
      for (const [name, override] of Object.entries(modelOverrides)) {
        if (
          manifest[name] &&
          (override.model || override.temperature != null || override.maxTokens != null)
        ) {
          finalOverrides[name] = override;
        }
      }

      await createDeployment(projectId, {
        environment,
        agentVersionManifest: manifest,
        entryAgentName: entryAgent,
        label: label || undefined,
        description: description || undefined,
        modelOverrides: Object.keys(finalOverrides).length > 0 ? finalOverrides : undefined,
      });
      toast.success(t('create_dialog.success'));
      onCreated();
      onClose();
    } catch (err) {
      toast.error(sanitizeError(err, t('create_dialog.error_create_failed')));
    } finally {
      setCreating(false);
    }
  };

  // Version warnings
  const warnings: string[] = [];
  for (const [agentName, version] of Object.entries(manifest)) {
    if (version === 'auto') continue;
    const versions = agentVersions[agentName] || [];
    const selected = versions.find((v) => v.version === version);
    if (selected && selected.status !== 'staged' && selected.status !== 'active') {
      warnings.push(
        t('create_dialog.version_warning', { agent: agentName, version, status: selected.status }),
      );
    }
  }

  // ── Agent row renderer ──

  const renderAgentRow = (agent: Agent) => {
    const versions = agentVersions[agent.name] || [];
    const selectedVersion = manifest[agent.name] || 'auto';
    const selectedRecord = versions.find((v) => v.version === selectedVersion);
    const isAuto = selectedVersion === 'auto';
    const isOverrideOpen = expandedOverride === agent.name;
    const override = modelOverrides[agent.name] || {};
    const hasOverride = !!(
      override.model ||
      override.temperature != null ||
      override.maxTokens != null
    );

    return (
      <div key={agent.name} className="group">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-default hover:bg-background-muted/30 transition-default">
          {/* Agent name */}
          <div className="flex-[3] min-w-0">
            <span className="text-sm font-medium text-foreground truncate block">{agent.name}</span>
          </div>

          {/* Version select */}
          <div className="flex-[3]">
            {versions.length > 0 ? (
              <select
                value={selectedVersion}
                onChange={(e) => handleVersionChange(agent.name, e.target.value)}
                className="w-full text-sm bg-background-subtle border border-default rounded-lg px-3 py-1.5 text-foreground focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus transition-default"
              >
                {versions.map((v) => (
                  <option key={v.version} value={v.version}>
                    {v.version}
                  </option>
                ))}
                <option value="auto">{t('create_dialog.auto_create_option')}</option>
              </select>
            ) : (
              <div className="text-sm text-muted bg-background-muted/50 rounded-lg px-3 py-1.5 border border-default border-dashed">
                {t('create_dialog.auto_create_option')}
              </div>
            )}
          </div>

          {/* Status badge */}
          <div className="flex-[2] flex items-center justify-center">
            {isAuto ? (
              <Badge variant="info" dot>
                {t('create_dialog.will_create')}
              </Badge>
            ) : selectedRecord ? (
              <Badge variant={statusVariants[selectedRecord.status] || 'default'} dot>
                {selectedRecord.status}
              </Badge>
            ) : null}
          </div>

          {/* Model override gear */}
          {projectModels.length > 0 && (
            <button
              type="button"
              onClick={() => setExpandedOverride(isOverrideOpen ? null : agent.name)}
              className={`p-1.5 rounded-lg transition-default ${
                isOverrideOpen
                  ? 'bg-accent/10 text-accent'
                  : hasOverride
                    ? 'text-accent hover:bg-accent/10'
                    : 'text-subtle hover:text-foreground hover:bg-background-muted'
              }`}
              title={t('create_dialog.model_overrides_label')}
            >
              <Settings className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Inline model override panel */}
        {isOverrideOpen && (
          <div className="px-4 py-3 bg-background-muted/40 border-b border-default">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-muted mb-1.5">
                  {t('create_dialog.model_override_label')}
                </label>
                <select
                  value={override.model || ''}
                  onChange={(e) =>
                    setModelOverrides((prev) => ({
                      ...prev,
                      [agent.name]: { ...prev[agent.name], model: e.target.value || undefined },
                    }))
                  }
                  className="w-full text-sm bg-background-subtle border border-default rounded-lg px-3 py-1.5 text-foreground focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
                >
                  <option value="">{t('create_dialog.use_version_default')}</option>
                  {projectModels.map((m) => (
                    <option key={m.modelId} value={m.modelId}>
                      {formatModelOptionLabel(m)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1.5">
                  {t('create_dialog.temperature_label')}
                </label>
                <input
                  type="number"
                  min="0"
                  max="2"
                  step="0.1"
                  placeholder="Default"
                  value={override.temperature ?? ''}
                  onChange={(e) =>
                    setModelOverrides((prev) => ({
                      ...prev,
                      [agent.name]: {
                        ...prev[agent.name],
                        temperature: e.target.value ? parseFloat(e.target.value) : undefined,
                      },
                    }))
                  }
                  className="w-full text-sm bg-background-subtle border border-default rounded-lg px-3 py-1.5 text-foreground placeholder:text-subtle focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1.5">
                  {t('create_dialog.max_tokens_label')}
                </label>
                <input
                  type="number"
                  min="1"
                  placeholder="Default"
                  value={override.maxTokens ?? ''}
                  onChange={(e) =>
                    setModelOverrides((prev) => ({
                      ...prev,
                      [agent.name]: {
                        ...prev[agent.name],
                        maxTokens: e.target.value ? parseInt(e.target.value, 10) : undefined,
                      },
                    }))
                  }
                  className="w-full text-sm bg-background-subtle border border-default rounded-lg px-3 py-1.5 text-foreground placeholder:text-subtle focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
                />
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  // ── Model overrides table for "latest" mode ──

  const renderGlobalModelOverrides = () => (
    <div className="mt-3 border border-default rounded-xl overflow-hidden">
      {/* Header */}
      <div className="grid grid-cols-[2fr_2fr_1fr_1fr] gap-3 px-4 py-2.5 bg-background-muted border-b border-default text-xs font-medium text-muted uppercase tracking-wider">
        <span>{t('create_dialog.agent_column')}</span>
        <span>{t('create_dialog.model_column')}</span>
        <span>{t('create_dialog.temp_column')}</span>
        <span>{t('create_dialog.max_tokens_label')}</span>
      </div>
      <div className="max-h-[240px] overflow-y-auto">
        {agents.map((agent) => {
          const override = modelOverrides[agent.name] || {};
          return (
            <div
              key={agent.name}
              className="grid grid-cols-[2fr_2fr_1fr_1fr] gap-3 items-center px-4 py-2.5 border-b border-default last:border-0 hover:bg-background-muted/30 transition-default"
            >
              <span className="text-sm font-medium text-foreground truncate">{agent.name}</span>
              <select
                value={override.model || ''}
                onChange={(e) =>
                  setModelOverrides((prev) => ({
                    ...prev,
                    [agent.name]: { ...prev[agent.name], model: e.target.value || undefined },
                  }))
                }
                className="text-sm bg-background-subtle border border-default rounded-lg px-2.5 py-1.5 text-foreground focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
              >
                <option value="">{t('create_dialog.version_default')}</option>
                {projectModels.map((m) => (
                  <option key={m.modelId} value={m.modelId}>
                    {formatModelOptionLabel(m)}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min="0"
                max="2"
                step="0.1"
                placeholder="—"
                value={override.temperature ?? ''}
                onChange={(e) =>
                  setModelOverrides((prev) => ({
                    ...prev,
                    [agent.name]: {
                      ...prev[agent.name],
                      temperature: e.target.value ? parseFloat(e.target.value) : undefined,
                    },
                  }))
                }
                className="text-sm bg-background-subtle border border-default rounded-lg px-2.5 py-1.5 text-foreground placeholder:text-subtle focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
              />
              <input
                type="number"
                min="1"
                placeholder="—"
                value={override.maxTokens ?? ''}
                onChange={(e) =>
                  setModelOverrides((prev) => ({
                    ...prev,
                    [agent.name]: {
                      ...prev[agent.name],
                      maxTokens: e.target.value ? parseInt(e.target.value, 10) : undefined,
                    },
                  }))
                }
                className="text-sm bg-background-subtle border border-default rounded-lg px-2.5 py-1.5 text-foreground placeholder:text-subtle focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
              />
            </div>
          );
        })}
      </div>
    </div>
  );

  // ── Render ──

  return (
    <Dialog open={open} onClose={onClose} title={t('create_dialog.title')} maxWidth="2xl">
      <div className="space-y-6">
        {/* ── Environment & Label ── */}
        <div className="grid grid-cols-2 gap-4">
          <Select
            label={t('create_dialog.environment_label')}
            value={environment}
            onChange={setEnvironment}
            options={[
              { value: 'dev', label: t('env_labels.dev') },
              { value: 'staging', label: t('env_labels.staging') },
              { value: 'production', label: t('env_labels.production') },
            ]}
          />
          <Input
            label={t('create_dialog.label_label')}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t('create_dialog.label_placeholder')}
          />
        </div>

        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-foreground">
            {t('create_dialog.description_label')}
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('create_dialog.notes_placeholder')}
            rows={3}
            className="w-full rounded-lg border border-default bg-background-subtle text-foreground placeholder:text-subtle transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus text-sm py-2 px-3 resize-y min-h-[4.5rem]"
          />
        </div>

        {/* ── Version Strategy (card-style radio) ── */}
        {!loading && agents.length > 0 && (
          <div>
            <label className="block text-sm font-medium text-foreground mb-3">
              {t('create_dialog.version_strategy_label')}
            </label>
            <div className="grid grid-cols-2 gap-3">
              {/* Latest card */}
              <button
                type="button"
                onClick={() => setStrategy('latest')}
                className={`relative flex items-start gap-3 p-4 rounded-xl border-2 text-left transition-all ${
                  strategy === 'latest'
                    ? 'border-accent bg-accent/5 shadow-sm'
                    : 'border-default hover:border-muted bg-background-subtle'
                }`}
              >
                <div
                  className={`mt-0.5 flex items-center justify-center w-5 h-5 rounded-full border-2 shrink-0 transition-default ${
                    strategy === 'latest' ? 'border-accent' : 'border-muted'
                  }`}
                >
                  {strategy === 'latest' && <div className="w-2.5 h-2.5 rounded-full bg-accent" />}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Zap
                      className={`w-4 h-4 shrink-0 ${strategy === 'latest' ? 'text-accent' : 'text-muted'}`}
                    />
                    <span className="text-sm font-semibold text-foreground">
                      {t('create_dialog.strategy_latest_title')}
                    </span>
                  </div>
                  <p className="text-xs text-muted mt-1 leading-relaxed">
                    {t('create_dialog.strategy_latest_description')}
                  </p>
                </div>
              </button>

              {/* Custom card */}
              <button
                type="button"
                onClick={() => setStrategy('custom')}
                className={`relative flex items-start gap-3 p-4 rounded-xl border-2 text-left transition-all ${
                  strategy === 'custom'
                    ? 'border-accent bg-accent/5 shadow-sm'
                    : 'border-default hover:border-muted bg-background-subtle'
                }`}
              >
                <div
                  className={`mt-0.5 flex items-center justify-center w-5 h-5 rounded-full border-2 shrink-0 transition-default ${
                    strategy === 'custom' ? 'border-accent' : 'border-muted'
                  }`}
                >
                  {strategy === 'custom' && <div className="w-2.5 h-2.5 rounded-full bg-accent" />}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Layers
                      className={`w-4 h-4 shrink-0 ${strategy === 'custom' ? 'text-accent' : 'text-muted'}`}
                    />
                    <span className="text-sm font-semibold text-foreground">
                      {t('create_dialog.strategy_custom_title')}
                    </span>
                  </div>
                  <p className="text-xs text-muted mt-1 leading-relaxed">
                    {t('create_dialog.strategy_custom_description')}
                  </p>
                </div>
              </button>
            </div>
          </div>
        )}

        {/* ── Summary line ── */}
        {!loading && summaryText && (
          <div className="flex items-center gap-3 text-sm text-muted">
            <span>{summaryText}</span>
            {autoVersionCount > 0 && (
              <Badge variant="info">
                {t('create_dialog.auto_create_badge', { count: autoVersionCount })}
              </Badge>
            )}
          </div>
        )}

        {/* ── Loading / Empty ── */}
        {loading && (
          <div className="py-10 text-center text-muted text-sm">
            <div className="inline-block w-5 h-5 border-2 border-muted border-t-accent rounded-full animate-spin mb-3" />
            <div>{t('create_dialog.loading_agents')}</div>
          </div>
        )}
        {!loading && agents.length === 0 && (
          <div className="py-10 text-center text-muted text-sm">
            {t('create_dialog.no_agents_found')}
          </div>
        )}

        {/* ── Agent Version Manifest (custom mode) ── */}
        {!loading && agents.length > 0 && strategy === 'custom' && (
          <div className="border border-default rounded-xl overflow-hidden">
            {/* Search filter (>8 agents) */}
            {agents.length > 8 && (
              <div className="px-4 py-3 border-b border-default bg-background-muted/30">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
                  <input
                    type="text"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder={t('create_dialog.agent_search_placeholder')}
                    className="w-full text-sm bg-background-subtle border border-default rounded-lg pl-9 pr-3 py-2 text-foreground placeholder:text-subtle focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus transition-default"
                  />
                </div>
              </div>
            )}

            {/* Column header */}
            <div className="flex items-center gap-3 px-4 py-2.5 bg-background-muted border-b border-default text-xs font-medium text-muted uppercase tracking-wider">
              <span className="flex-[3]">{t('create_dialog.agent_column')}</span>
              <span className="flex-[3]">{t('create_dialog.version_column')}</span>
              <span className="flex-[2] text-center">{t('create_dialog.status_column')}</span>
              {projectModels.length > 0 && <span className="w-9" />}
            </div>

            {/* Scrollable agent list */}
            <div className="max-h-[360px] overflow-y-auto">
              {filteredAgents.map(renderAgentRow)}

              {filteredAgents.length === 0 && filter.trim() && (
                <div className="py-8 text-center text-muted text-sm">
                  {t('create_dialog.no_agents_matching', { filter })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Entry Agent ── */}
        {agents.length > 0 && (
          <Select
            label={t('create_dialog.entry_agent_label')}
            value={entryAgent}
            onChange={setEntryAgent}
            options={agents.map((a) => ({ value: a.name, label: a.name }))}
          />
        )}

        {/* ── Model Overrides (latest mode — collapsible table) ── */}
        {strategy === 'latest' && agents.length > 0 && projectModels.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() =>
                setExpandedOverride(expandedOverride === '__global__' ? null : '__global__')
              }
              className="flex items-center gap-2 text-sm font-medium text-muted hover:text-foreground transition-default"
            >
              {expandedOverride === '__global__' ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
              <Settings className="w-4 h-4" />
              {t('create_dialog.model_overrides_label')}
              <span className="text-xs font-normal">
                {t('create_dialog.model_overrides_optional')}
              </span>
            </button>
            {expandedOverride === '__global__' && renderGlobalModelOverrides()}
          </div>
        )}

        {/* ── Missing Env Vars Warning ── */}
        {missingEnvVars.length > 0 && (
          <div className="p-4 rounded-xl bg-warning/10 border border-warning/30 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium text-warning">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              {t('create_dialog.missing_env_vars_title', { environment })}
            </div>
            <div className="space-y-2">
              {missingEnvVars.map((key) => (
                <div key={key} className="flex items-center gap-2">
                  <code className="text-xs font-mono bg-warning/10 px-1.5 py-0.5 rounded">
                    {'{{env.' + key + '}}'}
                  </code>
                  <input
                    type="text"
                    value={envVarValues[key] || ''}
                    onChange={(e) =>
                      setEnvVarValues((prev) => ({ ...prev, [key]: e.target.value }))
                    }
                    placeholder={t('create_dialog.value_for_key', { key })}
                    className="flex-1 text-sm bg-background-subtle border border-default rounded px-2 py-1 text-foreground placeholder:text-subtle focus:outline-none focus:border-border-focus"
                  />
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={definingEnvVars || missingEnvVars.every((k) => !envVarValues[k]?.trim())}
                loading={definingEnvVars}
                onClick={async () => {
                  setDefiningEnvVars(true);
                  try {
                    const toCreate = missingEnvVars.filter((k) => envVarValues[k]?.trim());
                    for (const key of toCreate) {
                      await createEnvironmentVariable(projectId, {
                        environment,
                        key,
                        value: envVarValues[key],
                      });
                    }
                    toast.success(t('create_dialog.created_variables', { count: toCreate.length }));
                    setMissingEnvVars((prev) => prev.filter((k) => !envVarValues[k]?.trim()));
                    setEnvVarValues({});
                  } catch (err) {
                    toast.error(sanitizeError(err, t('create_dialog.error_create_variables')));
                  } finally {
                    setDefiningEnvVars(false);
                  }
                }}
              >
                {t('create_dialog.define_now')}
              </Button>
            </div>
          </div>
        )}

        {/* ── Warnings ── */}
        {warnings.length > 0 && (
          <div className="p-4 rounded-xl bg-warning/10 border border-warning/30 space-y-1.5">
            {warnings.map((w, i) => (
              <div key={i} className="flex items-center gap-2 text-sm text-warning">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                {w}
              </div>
            ))}
          </div>
        )}

        {/* ── Actions ── */}
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" onClick={onClose} className="flex-1">
            {t('promote_dialog.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={creating}
            disabled={loading || agents.length === 0}
            className="flex-1"
          >
            {agents.length > 0
              ? t('create_dialog.deploy_button', {
                  agents: t('create_dialog.agents_count', { count: agents.length }),
                })
              : t('create', { defaultValue: 'Create Deployment' })}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

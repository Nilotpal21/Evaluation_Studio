/**
 * AgentListPage Component
 *
 * Compact topology mini-map + 2-column grid of rich agent cards.
 * Default view when selecting a project.
 */

import { useRef, useState, useCallback, useMemo, useEffect } from 'react';
import useSWR from 'swr';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Bot, Plus, Search, Upload, LayoutGrid, Network, Package } from 'lucide-react';
import { clsx } from 'clsx';
import { useNavigationStore } from '../../store/navigation-store';
import { useProjectStore } from '../../store/project-store';
import {
  type RuntimeAgent,
  type RuntimeAgentListResponse,
  parseActiveVersions,
} from '../../api/runtime-agents';
import { updateProject } from '../../api/projects';
import { ListPageShell } from '../ui/ListPageShell';
import { Button } from '../ui/Button';
import { FilterSelect } from '../ui/FilterSelect';
import { EmptyState } from '../ui/EmptyState';
import { CreateAgentDialog } from './CreateAgentDialog';
import { ImportDialog } from '../projects/ImportDialog';
import { AgentCard, type AgentSummary } from './AgentCard';
import { AgentMiniTopology, type MiniTopologyData } from './AgentMiniTopology';
import { TopologySkeleton } from './TopologySkeleton';
import { AgentCardSkeletonGrid } from './AgentCardSkeleton';
import { ProjectCanvas } from '../canvas/ProjectCanvas';
import { addHandoff, addDelegate } from '../../lib/agent-canvas/dsl-updater';
import { AgentEditorSlider } from '../agent-editor';
import { AGENT_EDITOR_CONFIG } from '../agent-editor/agent-editor-config';
import type { AddHandoffConfig, AddDelegateConfig } from '../../lib/agent-canvas/dsl-updater';
import type { ConnectionFormData } from '../canvas/ConnectionTypePicker';
import { saveDslWorkingCopy } from '../../api/runtime-agents';
import { extractRoutingEdgesFromDslFallback } from '../../lib/arch-ai/routing-edge-extraction';
import type { TopologyData, TopologyNode, TopologyEdge } from '../../types/arch';
import { useSessionList } from '../../hooks/useSessionList';
import { useImportedSymbols } from '../../hooks/useImportedSymbols';
import { ImportedAgentCard } from './ImportedAgentCard';

// =============================================================================
// TYPES
// =============================================================================

interface ErrorSummary {
  failedAgentCount: number;
  totalErrorCount: number;
}

interface TopologyResponse {
  topology: MiniTopologyData;
  agentSummaries: Record<string, AgentSummary>;
  errors?: string[];
  errorSummary?: ErrorSummary;
}

// =============================================================================
// DSL PARSING HELPERS
// =============================================================================

function isSupervisor(agent: RuntimeAgent): boolean {
  if (!agent.dslContent) return false;
  return /^\s*SUPERVISOR\s*:/m.test(agent.dslContent);
}

function getAgentStatus(
  agent: RuntimeAgent,
  failedAgentNames: Set<string>,
): 'live' | 'draft' | 'error' {
  // Check if agent has compile errors (from topology response)
  if (failedAgentNames.has(agent.name)) return 'error';
  // Check for active deployments
  const versions = parseActiveVersions(agent.activeVersions);
  if (versions.production || versions.staging) return 'live';
  return 'draft';
}

/**
 * Extract a GOAL: section value from raw DSL content.
 * Handles both single-line (`GOAL: "text"`) and multi-line (`GOAL: |\n  text`) forms.
 */
function extractGoalFromDSL(dsl: string): string | null {
  // Single-line: GOAL: "text" or GOAL: text
  const singleLine = dsl.match(/^\s*GOAL\s*:\s*["']?(.+?)["']?\s*$/m);
  if (singleLine && !singleLine[1].startsWith('|')) {
    return singleLine[1].trim();
  }

  // Multi-line: GOAL: |\n  text\n  text
  const multiLine = dsl.match(/^\s*GOAL\s*:\s*\|?\s*\n((?:[ \t]+.+\n?)+)/m);
  if (multiLine) {
    const lines = multiLine[1]
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    return lines.join(' ').trim() || null;
  }

  return null;
}

/**
 * Detect execution mode from DSL content.
 * No FLOW → 'reasoning'. FLOW with REASONING: true → 'hybrid'. FLOW only → 'scripted'.
 */
function extractExecutionMode(dsl: string): 'reasoning' | 'scripted' | 'hybrid' {
  if (!/^\s*FLOW\s*:/m.test(dsl)) return 'reasoning';
  // Has FLOW — check if any step has REASONING: true
  if (/^\s*REASONING\s*:\s*true/im.test(dsl)) return 'hybrid';
  return 'scripted';
}

/**
 * Count tool definitions from DSL TOOLS: section.
 * Matches lines like: tool_name(param: type, ...) -> return_type
 */
function countToolsFromDSL(dsl: string): number {
  const toolsSection = dsl.match(/^\s*TOOLS\s*:\s*\n((?:[ \t]+.+\n?)+)/m);
  if (!toolsSection) return 0;
  const toolLines = toolsSection[1].match(/^\s+\w+\s*\(/gm);
  return toolLines?.length ?? 0;
}

/** Extract the AGENT/SUPERVISOR declared name from DSL content */
function extractDeclaredName(dsl: string): string | null {
  const match = dsl.match(/^\s*(?:AGENT|SUPERVISOR)\s*:\s*(\S+)/m);
  return match ? match[1] : null;
}

/**
 * Build bidirectional name map between DSL-declared names and DB agent names.
 * Topology API uses DSL-declared names; canvas nodes use DB names.
 */
function buildDslNameMap(
  agents: RuntimeAgent[],
  topoNodes?: Array<{ id: string; name: string }>,
): { dslToDb: Map<string, string>; dbToDsl: Map<string, string> } {
  const dslToDb = new Map<string, string>();
  const dbToDsl = new Map<string, string>();

  for (const agent of agents) {
    if (!agent.dslContent) continue;
    const declaredName = extractDeclaredName(agent.dslContent);
    if (declaredName && declaredName !== agent.name) {
      dslToDb.set(declaredName, agent.name);
      dbToDsl.set(agent.name, declaredName);
    }
  }

  if (topoNodes) {
    const dbNameLower = new Map(agents.map((a) => [a.name.toLowerCase(), a.name]));
    const matchedDbNames = new Set(dslToDb.values());
    for (const agent of agents) {
      if (topoNodes.some((n) => n.name === agent.name)) {
        matchedDbNames.add(agent.name);
      }
    }

    for (const node of topoNodes) {
      if (dslToDb.has(node.name)) continue;
      if (agents.some((a) => a.name === node.name)) continue;

      const dbName = dbNameLower.get(node.name.toLowerCase());
      if (dbName && !matchedDbNames.has(dbName)) {
        dslToDb.set(node.name, dbName);
        dbToDsl.set(dbName, node.name);
        matchedDbNames.add(dbName);
      }
    }
  }

  return { dslToDb, dbToDsl };
}

function resolveToDbName(name: string, dslToDb: Map<string, string>): string {
  return dslToDb.get(name) ?? name;
}

/**
 * Build a client-side AgentSummary from raw DSL content.
 * Used as fallback when server-side IR compilation fails.
 */
function buildClientSummary(agent: RuntimeAgent): AgentSummary | null {
  if (!agent.dslContent) return null;
  const goal = extractGoalFromDSL(agent.dslContent);
  const executionMode = extractExecutionMode(agent.dslContent);
  const toolsCount = countToolsFromDSL(agent.dslContent);
  return {
    toolsCount,
    gatherFieldsCount: 0,
    executionMode,
    goal,
    description: goal,
  };
}

/**
 * Build a client-side topology from DSL content as fallback
 * when the server-side IR compilation fails for some agents.
 * Uses lightweight DSL extraction for top-level and inline action-handler
 * handoff / delegate routes without pulling the full parser into the client.
 */
function buildClientTopology(agents: RuntimeAgent[]): MiniTopologyData {
  const { dslToDb } = buildDslNameMap(agents);

  const agentDbNames = new Set(agents.map((a) => a.name));
  const entryAgent = agents.find(isSupervisor) ?? agents[0];

  // Build a case-insensitive lookup: DSL name or DB name → DB name
  const nameToDbName = new Map<string, string>();
  for (const agent of agents) {
    nameToDbName.set(agent.name, agent.name);
    nameToDbName.set(agent.name.toLowerCase(), agent.name);
    if (agent.dslContent) {
      const declared = extractDeclaredName(agent.dslContent);
      if (declared) {
        nameToDbName.set(declared, agent.name);
        nameToDbName.set(declared.toLowerCase(), agent.name);
      }
    }
  }
  for (const [dslName, dbName] of dslToDb.entries()) {
    nameToDbName.set(dslName, dbName);
    nameToDbName.set(dslName.toLowerCase(), dbName);
  }

  const nodes: MiniTopologyData['nodes'] = agents.map((a) => ({
    id: a.name,
    name: a.name,
    type: isSupervisor(a) ? ('supervisor' as const) : ('agent' as const),
    isEntry: a.name === entryAgent?.name,
    executionMode: a.dslContent ? extractExecutionMode(a.dslContent) : ('reasoning' as const),
  }));

  const edges: MiniTopologyData['edges'] = [];
  const edgeSet = new Set<string>();

  for (const agent of agents) {
    if (!agent.dslContent) continue;

    const routingEdges = extractRoutingEdgesFromDslFallback(agent.dslContent, agent.name);
    for (const edge of routingEdges) {
      if (edge.type === 'escalate') {
        continue;
      }

      const resolved = nameToDbName.get(edge.to) ?? nameToDbName.get(edge.to.toLowerCase());
      if (resolved && agentDbNames.has(resolved) && resolved !== agent.name) {
        const key = `${agent.name}->${edge.type}->${resolved}`;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          edges.push({ from: agent.name, to: resolved, type: edge.type });
        }
      }
    }
  }

  return { nodes, edges };
}

// =============================================================================
// TOPOLOGY CONVERSION (MiniTopologyData → TopologyData for canvas)
// =============================================================================

type ViewMode = 'list' | 'canvas';

function miniTopoToCanvasTopology(
  mini: MiniTopologyData,
  agents: RuntimeAgent[],
  summaries: Record<string, AgentSummary>,
): TopologyData {
  const { dslToDb } = buildDslNameMap(agents, mini.nodes);
  const agentMap = new Map(agents.map((a) => [a.name, a]));
  const nodeIdSet = new Set(mini.nodes.map((n) => n.id));

  const nodes: TopologyNode[] = mini.nodes.map((n) => {
    const dbName = resolveToDbName(n.name, dslToDb);
    const agent = agentMap.get(dbName) ?? agentMap.get(n.name);
    const summary = summaries[dbName] ?? summaries[n.name];
    const toolCount = summary?.toolsCount ?? 0;
    return {
      id: n.id,
      name: n.name,
      type: n.type,
      isEntry: n.isEntry,
      executionMode: (summary?.executionMode ?? n.executionMode) as TopologyNode['executionMode'],
      tools: Array.from({ length: toolCount }, (_, i) => `tool_${i}`),
      gatherFields: [],
      flowStepCount: 0,
      constraintCount: 0,
      healthStatus: 'healthy' as const,
      description: summary?.goal ?? summary?.description ?? agent?.description ?? '',
    };
  });

  const edges: TopologyEdge[] = mini.edges
    .map((e) => ({
      from: e.from,
      to: e.to,
      type: e.type,
      condition: e.condition ?? e.label,
      experienceMode: e.experienceMode,
      returns: e.returns,
    }))
    .filter((e) => nodeIdSet.has(e.from) && nodeIdSet.has(e.to));

  return { nodes, edges };
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Determine the start agent:
 * Only returns an agent when explicitly set via entryAgentName.
 * When set to "Auto Detect" (null), returns null so no badge is shown.
 */
function findStartAgentId(agents: RuntimeAgent[], entryAgentName?: string | null): string | null {
  if (agents.length === 0 || !entryAgentName) return null;

  const explicit = agents.find((a) => a.name === entryAgentName);
  return explicit?.id ?? null;
}

// Highlight duration when scrolling to a card from topology click
const CARD_HIGHLIGHT_MS = 1500;

// =============================================================================
// COMPONENT
// =============================================================================

export function AgentListPage() {
  const t = useTranslations('agents');
  const tCommon = useTranslations('common');
  const projectId = useNavigationStore((s) => s.projectId);
  const navigate = useNavigationStore((s) => s.navigate);
  const sidebarCollapsed = useNavigationStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useNavigationStore((s) => s.setSidebarCollapsed);
  const currentProject = useProjectStore((s) => s.currentProject);
  const updateProjectStore = useProjectStore((s) => s.updateProject);
  const { sessionsByAgent } = useSessionList(projectId);
  const { agents: importedAgents } = useImportedSymbols();
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [sliderAgentName, setSliderAgentName] = useState<string | null>(null);
  const [focusNewAgent, setFocusNewAgent] = useState<string | null>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const sidebarWasCollapsed = useRef(false);

  // Auto-collapse sidebar when slider opens, restore when it closes
  useEffect(() => {
    if (sliderAgentName) {
      sidebarWasCollapsed.current = sidebarCollapsed;
      if (!sidebarCollapsed) {
        setSidebarCollapsed(true);
      }
    } else if (sidebarWasCollapsed.current === false) {
      setSidebarCollapsed(false);
    }
  }, [sliderAgentName]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch agents
  const agentsKey = projectId ? `/api/projects/${projectId}/agents` : null;
  const {
    data: agentsData,
    error: swrError,
    isLoading: agentsLoading,
    mutate,
  } = useSWR<RuntimeAgentListResponse>(agentsKey);
  const agents = agentsData?.agents ?? [];
  const error = swrError ? String(swrError) : null;

  // Fetch topology in parallel with agents (independent SWR call — fails gracefully)
  const topoKey = projectId ? `/api/projects/${projectId}/topology` : null;
  const { data: topoData, isLoading: topoLoading } = useSWR<TopologyResponse>(topoKey);

  // Extract agent names that have compile errors from topology error strings
  // Error format: "agentName: Line N: message" or "agentName: message"
  const failedAgentNames = useMemo(() => {
    const names = new Set<string>();
    if (topoData?.errors) {
      for (const err of topoData.errors) {
        const match = err.match(/^([^:]+):/);
        if (match) names.add(match[1].trim());
      }
    }
    return names;
  }, [topoData?.errors]);

  // Merge server topology with client-extracted edges, resolving name mismatches
  const effectiveTopology = useMemo(() => {
    if (agents.length < 2) return topoData?.topology ?? null;

    const clientTopo = buildClientTopology(agents);

    if (!topoData) return clientTopo;

    const serverTopo = topoData.topology;
    const { dslToDb } = buildDslNameMap(agents, serverTopo.nodes);

    // Resolve server edge from/to DSL names to DB names for client-side matching
    const resolvedServerEdges = serverTopo.edges.map((e) => ({
      ...e,
      from: resolveToDbName(e.from, dslToDb),
      to: resolveToDbName(e.to, dslToDb),
    }));

    // Resolve server nodes to DB names
    const resolvedServerNodes = serverTopo.nodes.map((n) => ({
      ...n,
      id: resolveToDbName(n.name, dslToDb),
      name: resolveToDbName(n.name, dslToDb),
    }));

    const serverEdgeKeys = new Set(resolvedServerEdges.map((e) => `${e.from}->${e.to}`));
    const mergedEdges = [
      ...resolvedServerEdges,
      ...clientTopo.edges.filter((e) => !serverEdgeKeys.has(`${e.from}->${e.to}`)),
    ];

    const serverNodeIds = new Set(resolvedServerNodes.map((n) => n.id));
    const mergedNodes = [
      ...resolvedServerNodes,
      ...clientTopo.nodes.filter((n) => !serverNodeIds.has(n.id)),
    ];

    return { nodes: mergedNodes, edges: mergedEdges };
  }, [topoData, agents]);

  // Merge server summaries with client-side DSL-extracted fallbacks
  const mergedSummaries = useMemo(() => {
    const result: Record<string, AgentSummary> = {};
    for (const agent of agents) {
      const serverSummary = topoData?.agentSummaries?.[agent.name];
      if (serverSummary) {
        result[agent.name] = serverSummary;
      } else {
        const clientSummary = buildClientSummary(agent);
        if (clientSummary) result[agent.name] = clientSummary;
      }
    }
    return result;
  }, [agents, topoData]);

  const canvasTopology = useMemo(() => {
    if (!effectiveTopology || agents.length < 2) return null;
    return miniTopoToCanvasTopology(effectiveTopology, agents, mergedSummaries);
  }, [effectiveTopology, agents, mergedSummaries]);

  const startAgentId = findStartAgentId(agents, currentProject?.entryAgentName);

  const searchFiltered = agents.filter(
    (a) =>
      a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      a.description?.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const filtered = searchFiltered
    .filter((agent) => {
      if (statusFilter !== 'all' && getAgentStatus(agent, failedAgentNames) !== statusFilter)
        return false;
      if (typeFilter !== 'all') {
        const isSup = isSupervisor(agent);
        if (typeFilter === 'supervisor' && !isSup) return false;
        if (typeFilter !== 'supervisor' && isSup) return false;
        // For reasoning/flow, check execution mode from summary if available
      }
      return true;
    })
    .sort((a, b) => {
      // Start agent always first
      if (a.id === startAgentId) return -1;
      if (b.id === startAgentId) return 1;
      // Supervisors next
      const aSup = isSupervisor(a);
      const bSup = isSupervisor(b);
      if (aSup && !bSup) return -1;
      if (!aSup && bSup) return 1;
      // Errors last
      const aErr = getAgentStatus(a, failedAgentNames) === 'error';
      const bErr = getAgentStatus(b, failedAgentNames) === 'error';
      if (aErr && !bErr) return 1;
      if (!aErr && bErr) return -1;
      return 0;
    });

  const listMode = AGENT_EDITOR_CONFIG.listViewMode ?? AGENT_EDITOR_CONFIG.containerMode;

  const handleOpenAgent = (agent: RuntimeAgent) => {
    if (listMode === 'page') {
      navigate(`/projects/${projectId}/agents/${agent.name}`);
    } else {
      setSliderAgentName(agent.name);
    }
  };

  const handleChatAgent = (agent: RuntimeAgent) => {
    navigate(`/projects/${projectId}/agents/${agent.name}/chat`);
  };

  const handleAgentCreated = (agentName: string) => {
    setShowCreateDialog(false);
    mutate();
    if (isCanvas) {
      // Stay in canvas — signal ProjectCanvas to focus the new node
      setFocusNewAgent(agentName);
    } else if (listMode === 'page') {
      navigate(`/projects/${projectId}/agents/${agentName}`);
    } else {
      setSliderAgentName(agentName);
    }
  };

  const handleStartAgentChange = async (value: string) => {
    if (!projectId) return;
    const entryAgentName = value || null;
    try {
      await updateProject(projectId, { entryAgentName });
      updateProjectStore(projectId, { entryAgentName });
      toast.success(
        entryAgentName
          ? t('list.start_agent_set', { name: entryAgentName })
          : t('list.start_agent_auto'),
      );
    } catch (err) {
      console.error('Failed to update start agent:', err);
      toast.error(t('list.start_agent_failed'));
    }
  };

  const handleTopologySelect = useCallback((agentName: string) => {
    const el = cardRefs.current.get(agentName);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('ring-2', 'ring-accent/40');
      setTimeout(() => el.classList.remove('ring-2', 'ring-accent/40'), CARD_HIGHLIGHT_MS);
    }
  }, []);

  const handleCanvasConnect = useCallback(
    async (sourceAgent: string, targetAgent: string, data: ConnectionFormData) => {
      if (!projectId) return;
      const agent = agents.find((a) => a.name === sourceAgent);
      if (!agent?.dslContent) {
        toast.error(`Agent "${sourceAgent}" has no ABL definition`);
        return;
      }

      let updatedDsl: string | null = null;
      if (data.type === 'handoff') {
        const passArr = data.pass
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        updatedDsl = addHandoff(agent.dslContent, targetAgent, {
          when: data.when,
          return: data.return,
          summary: data.summary || undefined,
          pass: passArr.length > 0 ? passArr : undefined,
          history: data.history,
          priority: data.priority ? parseInt(data.priority, 10) : undefined,
        });
      } else {
        const inputMap: Record<string, string> = {};
        for (const { key, value } of data.input) {
          if (key.trim() && value.trim()) inputMap[key.trim()] = value.trim();
        }
        const returnsMap: Record<string, string> = {};
        for (const { key, value } of data.returns) {
          if (key.trim() && value.trim()) returnsMap[key.trim()] = value.trim();
        }
        updatedDsl = addDelegate(agent.dslContent, targetAgent, {
          when: data.when,
          purpose: data.purpose,
          input: Object.keys(inputMap).length > 0 ? inputMap : undefined,
          returns: Object.keys(returnsMap).length > 0 ? returnsMap : undefined,
          timeout: data.timeout || undefined,
        });
      }

      if (!updatedDsl) {
        toast.error('Failed to update agent definition');
        return;
      }

      try {
        await saveDslWorkingCopy(projectId, sourceAgent, updatedDsl);
        toast.success(
          `${data.type === 'handoff' ? 'Handoff' : 'Delegate'} to ${targetAgent} created`,
        );
        mutate();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Save failed';
        toast.error(message);
      }
    },
    [projectId, agents, mutate],
  );

  const startAgentOptions = [
    { value: '', label: t('list.auto_detect') },
    ...agents.map((a) => ({ value: a.name, label: a.name.replace(/_/g, ' ') })),
  ];

  const renderStartAgentControl = (testId: string, labelClassName: string) =>
    agents.length > 1 ? (
      <div className="flex items-center gap-2 shrink-0" data-testid={testId}>
        <span className={labelClassName}>{t('list.start_agent_label')}</span>
        <FilterSelect
          options={startAgentOptions}
          value={currentProject?.entryAgentName ?? ''}
          onChange={handleStartAgentChange}
        />
      </div>
    ) : null;

  // Show topology when 2+ agents exist (mini-map renders null if no edges)
  const showTopology = !agentsLoading && agents.length > 1;

  const isCanvas = viewMode === 'canvas';

  // --- VIEW TOGGLE (shared between both layouts) ---
  const viewToggle =
    agents.length > 1 ? (
      <div className="flex items-center bg-background-muted rounded-md p-0.5">
        <button
          onClick={() => setViewMode('list')}
          className={clsx(
            'flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-default',
            viewMode === 'list'
              ? 'bg-background-elevated text-foreground shadow-sm'
              : 'text-foreground-muted hover:text-foreground',
          )}
        >
          <LayoutGrid className="w-3.5 h-3.5" />
          List
        </button>
        <button
          onClick={() => {
            setSliderAgentName(null);
            setViewMode('canvas');
          }}
          className={clsx(
            'flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-default',
            viewMode === 'canvas'
              ? 'bg-background-elevated text-foreground shadow-sm'
              : 'text-foreground-muted hover:text-foreground',
          )}
        >
          <Network className="w-3.5 h-3.5" />
          Canvas
        </button>
      </div>
    ) : null;

  // =========================================================================
  // UNIFIED VIEW — single ListPageShell for both list and canvas modes
  // =========================================================================
  const isEmptyStateShown = !agentsLoading && !error && filtered.length === 0;

  return (
    <ListPageShell
      title={t('title')}
      description={
        !isCanvas && currentProject
          ? t('list.project_agent_count', { name: currentProject.name, count: agents.length })
          : undefined
      }
      hidePrimaryAction={isEmptyStateShown}
      primaryAction={
        <Button icon={<Plus className="w-4 h-4" />} onClick={() => setShowCreateDialog(true)}>
          {t('create')}
        </Button>
      }
      secondaryActions={
        <>
          {renderStartAgentControl(
            'entry-agent-list-toolbar',
            'text-sm font-medium text-foreground-muted whitespace-nowrap',
          )}
          {viewToggle}
          <Button
            variant="secondary"
            icon={<Upload className="w-4 h-4" />}
            onClick={() => setShowImport(true)}
          >
            {t('list.import')}
          </Button>
        </>
      }
      searchPlaceholder={!isCanvas ? t('search_placeholder') : undefined}
      searchValue={!isCanvas ? searchQuery : undefined}
      onSearchChange={!isCanvas ? setSearchQuery : undefined}
      filterBar={
        !isCanvas ? (
          <>
            <FilterSelect
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: 'all', label: 'All Status' },
                { value: 'live', label: 'Live' },
                { value: 'draft', label: 'Draft' },
                { value: 'error', label: 'Error' },
              ]}
            />
            <FilterSelect
              value={typeFilter}
              onChange={setTypeFilter}
              options={[
                { value: 'all', label: 'All Types' },
                { value: 'supervisor', label: 'Supervisor' },
                { value: 'reasoning', label: 'Reasoning' },
                { value: 'flow', label: 'Flow' },
              ]}
            />
          </>
        ) : undefined
      }
      fullBleedContent={isCanvas}
      className="bg-noise"
    >
      {/* ------------------------------------------------------------------ */}
      {/* CANVAS VIEW — full-bleed, no padding (fullBleedContent=true)      */}
      {/* ------------------------------------------------------------------ */}
      {isCanvas && projectId && (
        <div className="flex-1 min-h-0 relative">
          {topoLoading ? (
            <TopologySkeleton className="h-full" />
          ) : canvasTopology && canvasTopology.nodes.length > 0 ? (
            <ProjectCanvas
              topology={canvasTopology}
              projectId={projectId}
              agents={agents}
              onSaved={() => mutate()}
              onConnect={handleCanvasConnect}
              focusNewAgent={focusNewAgent}
              onFocusHandled={() => setFocusNewAgent(null)}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-foreground-muted">
              <EmptyState
                icon={<Network className="w-6 h-6" />}
                title="No topology available"
                description="Add at least 2 agents with relationships to see the canvas view"
              />
            </div>
          )}
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* LIST VIEW                                                           */}
      {/* ------------------------------------------------------------------ */}
      {!isCanvas && (
        <div>
          {/* Topology Mini-Map */}
          {showTopology &&
            (topoLoading ? (
              <TopologySkeleton className="mb-6" />
            ) : effectiveTopology && effectiveTopology.edges.length > 0 ? (
              <div className="mb-6 animate-fade-in">
                <AgentMiniTopology
                  topology={effectiveTopology}
                  onSelectAgent={handleTopologySelect}
                />
              </div>
            ) : null)}

          {/* Topology compilation warnings */}
          {topoData?.errors && topoData.errors.length > 0 && (
            <div className="mb-6 rounded-xl border border-warning/30 bg-warning-subtle/30 px-4 py-3 text-xs text-warning">
              {topoData.errorSummary
                ? t('list.topology_incomplete_with_details', {
                    agentCount: topoData.errorSummary.failedAgentCount,
                    errorCount: topoData.errorSummary.totalErrorCount,
                  })
                : t('list.topology_incomplete', { count: topoData.errors.length })}
            </div>
          )}

          {/* Agent Cards */}
          {agentsLoading ? (
            <AgentCardSkeletonGrid />
          ) : error ? (
            <EmptyState
              icon={<Bot className="w-6 h-6" />}
              title={t('load_failed')}
              description={error}
              action={
                <Button variant="secondary" onClick={() => mutate()}>
                  {tCommon('retry')}
                </Button>
              }
            />
          ) : filtered.length === 0 ? (
            searchQuery || statusFilter !== 'all' || typeFilter !== 'all' ? (
              <EmptyState
                icon={<Search className="w-6 h-6" />}
                title={t('list.no_matching_title')}
                description={
                  searchQuery
                    ? t('list.no_matching_description', { query: searchQuery })
                    : t('list.no_filter_results')
                }
              />
            ) : (
              <EmptyState
                icon={<Bot className="w-6 h-6" />}
                title={t('list_empty_title')}
                description={t('list_empty_description')}
                action={
                  <Button
                    icon={<Plus className="w-4 h-4" />}
                    onClick={() => setShowCreateDialog(true)}
                  >
                    {t('create')}
                  </Button>
                }
              />
            )
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filtered.map((agent, i) => (
                <motion.div
                  key={agent.id}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, delay: i * 0.05, ease: [0.22, 1, 0.36, 1] }}
                  ref={(el) => {
                    if (el) cardRefs.current.set(agent.name, el);
                    else cardRefs.current.delete(agent.name);
                  }}
                >
                  <AgentCard
                    agent={agent}
                    summary={mergedSummaries[agent.name] ?? null}
                    isStart={agent.id === startAgentId}
                    supervisor={isSupervisor(agent)}
                    status={getAgentStatus(agent, failedAgentNames)}
                    sessionActivity={[]}
                    sessionCount={sessionsByAgent[agent.name]?.length ?? 0}
                    handoffCount={0}
                    onOpen={() => handleOpenAgent(agent)}
                    onChat={() => handleChatAgent(agent)}
                  />
                </motion.div>
              ))}
            </div>
          )}

          {/* Imported Agents (read-only, from module dependencies) */}
          {importedAgents.length > 0 && (
            <div className="mt-8 border-t border-default pt-6">
              <h3 className="text-sm font-medium text-foreground-muted mb-4 flex items-center gap-2">
                <Package className="h-4 w-4" />
                {t('list.imported_agents', { count: importedAgents.length })}
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {importedAgents.map((agent) => (
                  <ImportedAgentCard
                    key={`${agent.alias}.${agent.name}`}
                    agent={agent}
                    onClick={() =>
                      navigate(
                        `/projects/${projectId}/agents/imported/${agent.alias}/${agent.name}`,
                      )
                    }
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {projectId && (
        <CreateAgentDialog
          open={showCreateDialog}
          onClose={() => setShowCreateDialog(false)}
          projectId={projectId}
          onCreated={handleAgentCreated}
        />
      )}
      {projectId && (
        <ImportDialog
          open={showImport}
          onClose={() => setShowImport(false)}
          projectId={projectId}
          onImported={() => mutate()}
        />
      )}

      {/* Unified agent editor slider */}
      {projectId && (
        <AgentEditorSlider
          projectId={projectId}
          agentName={sliderAgentName}
          agents={agents?.map((a) => ({ name: a.name }))}
          onClose={() => setSliderAgentName(null)}
          onSaved={() => mutate()}
        />
      )}
    </ListPageShell>
  );
}

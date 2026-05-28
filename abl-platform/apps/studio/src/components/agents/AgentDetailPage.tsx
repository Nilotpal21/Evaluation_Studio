'use client';

/**
 * AgentDetailPage Component (Redesigned)
 *
 * Single scrollable page that renders all agent sections as collapsible cards.
 * Replaces the previous 5-tab layout (Overview | Versions | DSL Editor | Model | Chat).
 *
 * Structure:
 * - Header: back button, agent name, mode badge, model, action buttons
 * - Scrollable main area: section cards rendered based on visibleSections
 *
 * Data flow:
 * - useAgentIR() fetches DSL, compiles to IR, and loads agent-detail-store
 * - useAgentDetailStore provides parsed sections, visibleSections, expandedSection
 * - Each section card receives data + expand/collapse + onChange callbacks
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import {
  Bot,
  Brain,
  Loader2,
  ArrowLeft,
  GitBranch,
  Code,
  MessageCircle,
  AlertTriangle,
  Lock,
  ChevronDown,
  ChevronUp,
  Trash2,
  Package,
} from 'lucide-react';
import clsx from 'clsx';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { DetailPageShell } from '../ui/DetailPageShell';
import { useNavigationStore } from '../../store/navigation-store';
import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';
import { useProjectStore } from '../../store/project-store';
import { useAgentDetailStore } from '../../store/agent-detail-store';
import type {
  SectionId,
  IdentitySectionData,
  ToolSectionData,
  GatherFieldData,
  FlowSectionData,
  RulesSectionData,
  CoordinationSectionData,
  BehaviorSectionData,
  LifecycleSectionData,
} from '../../store/agent-detail-store';
import { useAgentIR } from '../../hooks/useAgentIR';
import { useSectionEdit } from '../../hooks/useSectionEdit';
import { useStaleToolCheck } from '../../hooks/useStaleToolCheck';
import { useAgentVersions } from '../../hooks/useAgentVersions';
import {
  serializeIdentityToABL,
  serializeToolsToABL,
  serializeGatherToABL,
  serializeFlowToABL,
  serializeRulesToABL,
  serializeCoordinationToABL,
  serializeConversationBehaviorToABL,
  serializeBehaviorRefsToABL,
  serializeLifecycleDiffToABL,
} from '../../lib/abl-serializers';
import {
  analyzeFlowVisualEditorCompatibility,
  getFlowVisualEditorSaveBlockReason,
} from '../../lib/abl/flow-visual-editor-compat';
import {
  analyzeLifecycleVisualEditorCompatibility,
  getLifecycleVisualEditorSaveBlockReason,
} from '../../lib/abl/lifecycle-visual-editor-compat';
import { apiFetch } from '../../lib/api-client';
import { sanitizeError } from '../../lib/sanitize-error';
import { fetchRuntimeAgent } from '../../api/runtime-agents';
import { removeAgentFromProject, updateProjectAgent } from '../../api/projects';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState } from '../ui/EmptyState';
import { Input } from '../ui/Input';
import {
  IdentitySection,
  ToolsSection,
  GatherSection,
  FlowSection,
  RulesSection,
  CoordinationSection,
  BehaviorSection,
  LifecycleSection,
  VersionsSlideOver,
  DslEditorOverlay,
  StaleToolBanner,
} from '../agent-detail';
import { AgentModelTab } from './AgentModelTab';

// =============================================================================
// CONSTANTS
// =============================================================================

const MODE_BADGE_VARIANT: Record<string, 'accent' | 'info'> = {
  reasoning: 'accent',
  scripted: 'info',
};

type AgentDependencyType = 'handoff' | 'delegate';

interface AgentTopologyResponse {
  topology: {
    nodes: Array<{
      id: string;
      name: string;
      isEntry: boolean;
    }>;
    edges: Array<{
      from: string;
      to: string;
      type: AgentDependencyType;
    }>;
  };
}

interface DeleteImpactReference {
  source: string;
  types: AgentDependencyType[];
}

function extractDeclaredAgentName(dslContent: string | null | undefined): string | null {
  if (!dslContent) return null;
  const match = dslContent.match(/^\s*(?:AGENT|SUPERVISOR)\s*:\s*(\S+)/m);
  return match?.[1] ?? null;
}

async function fetchProjectTopology(url: string): Promise<AgentTopologyResponse> {
  const response = await apiFetch(url);
  if (!response.ok) {
    throw new Error('Failed to load topology');
  }

  return response.json() as Promise<AgentTopologyResponse>;
}

// =============================================================================
// COMPONENT
// =============================================================================

interface AgentDetailPageProps {
  readOnly?: boolean;
  moduleProvenance?: { alias: string; moduleProjectName: string; version: string };
}

export function AgentDetailPage({ readOnly, moduleProvenance }: AgentDetailPageProps = {}) {
  const t = useTranslations('agents');
  const tCommon = useTranslations('common');
  const projectId = useNavigationStore((s) => s.projectId);
  const agentName = useNavigationStore((s) => s.subPage);
  const navigate = useNavigationStore((s) => s.navigate);
  const currentProject = useProjectStore((s) => s.currentProject);
  const openOverlay = useArchAIStore((s) => s.openOverlay);
  const { mutate: globalMutate } = useSWRConfig();

  // Fetch + compile DSL, auto-loads into agent-detail-store
  const { ir, dsl, compileErrors, compileWarnings, isLoading, error, reload } = useAgentIR(
    projectId,
    agentName,
  );

  const metadataKey =
    projectId && agentName ? (['agent-metadata', projectId, agentName] as const) : null;
  const { data: metadataData, mutate: mutateMetadata } = useSWR(
    metadataKey,
    () => fetchRuntimeAgent(projectId!, agentName!),
    {
      revalidateOnFocus: false,
    },
  );
  const agentMetadata = metadataData?.agent;

  const topologyKey = projectId ? `/api/projects/${projectId}/topology` : null;
  const { data: topologyData } = useSWR<AgentTopologyResponse>(topologyKey, fetchProjectTopology, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });

  // Debounced auto-save via surgical edit API.
  // NOTE: We intentionally do NOT pass `reload` as onSaved. Reloading after
  // every auto-save refetches the IR and overwrites the store, which causes
  // the expanded accordion to collapse and character loss while typing.
  // The store already holds the latest section data via updateSection(),
  // and the DSL is persisted by the edit API. The IR recompiles on next
  // page load or explicit reload (e.g. version creation).
  const { editSections } = useSectionEdit(projectId, agentName);

  // Stale tool check — compare active version snapshot vs current published versions
  const { staleTools, deletedTools, newTools } = useStaleToolCheck(projectId, agentName);

  // Agent versions — used for recompile action from stale tool banner
  const { create: createVersion } = useAgentVersions(projectId, agentName);
  const [isRecompiling, setIsRecompiling] = useState(false);

  const handleRecompile = useCallback(async () => {
    setIsRecompiling(true);
    try {
      await createVersion();
      await reload();
    } catch {
      // Error already toasted by useAgentVersions
    } finally {
      setIsRecompiling(false);
    }
  }, [createVersion, reload]);

  // Overlay state
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [dslOpen, setDslOpen] = useState(false);
  const [modelSectionExpanded, setModelSectionExpanded] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [metadataAgentPath, setMetadataAgentPath] = useState('');
  const [metadataDescription, setMetadataDescription] = useState('');
  const [isSavingMetadata, setIsSavingMetadata] = useState(false);

  useEffect(() => {
    if (!agentMetadata) return;
    setMetadataAgentPath(agentMetadata.agentPath);
    setMetadataDescription(agentMetadata.description ?? '');
  }, [agentMetadata?.agentPath, agentMetadata?.description, agentMetadata?.id]);

  // Edit locking
  const [lockError, setLockError] = useState<string | null>(null);
  useEffect(() => {
    if (!projectId || !agentName) return;

    const acquireLock = async () => {
      try {
        const res = await apiFetch(`/api/projects/${projectId}/agents/${agentName}/lock`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lockType: 'edit', agentName }),
        });
        if (res.status === 409) {
          const data = await res.json();
          setLockError(data.error ?? 'Agent is locked by another user');
        }
      } catch (err) {
        console.warn('[AgentDetail] Lock acquisition failed (best-effort):', err);
      }
    };
    acquireLock();

    return () => {
      apiFetch(`/api/projects/${projectId}/agents/${agentName}/lock?lockType=edit`, {
        method: 'DELETE',
      }).catch((err) => console.warn('[AgentDetail] Lock release failed:', err));
    };
  }, [projectId, agentName]);

  // Read parsed data from the store
  const sections = useAgentDetailStore((s) => s.sections);
  const visibleSections = useAgentDetailStore((s) => s.visibleSections);
  const expandedSection = useAgentDetailStore((s) => s.expandedSection);
  const saveStatus = useAgentDetailStore((s) => s.saveStatus);
  const setSaveStatus = useAgentDetailStore((s) => s.setSaveStatus);
  const updateSection = useAgentDetailStore((s) => s.updateSection);
  const expandSection = useAgentDetailStore((s) => s.expandSection);
  const collapseSection = useAgentDetailStore((s) => s.collapseSection);

  // Reload agent data when Arch modifies the DSL
  const lastAgentEdit = useArchAIStore((s) => s.lastAgentEditTimestamp);
  useEffect(() => {
    if (lastAgentEdit) reload();
  }, [lastAgentEdit, reload]);

  const flowCompatibilityIssues = useMemo(() => analyzeFlowVisualEditorCompatibility(ir), [ir]);
  const lifecycleCompatibilityIssues = useMemo(
    () => analyzeLifecycleVisualEditorCompatibility(ir),
    [ir],
  );

  // Arch v0.3 — context is auto-detected via buildPageContext() from nav store.
  // No manual context sync needed.

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleBack = useCallback(() => {
    navigate(`/projects/${projectId}/agents`);
  }, [navigate, projectId]);

  const handleDelete = useCallback(async () => {
    if (!projectId || !agentName) return;

    setIsDeleting(true);
    try {
      await removeAgentFromProject(projectId, agentName);
      toast.success(t('delete_success'));
      navigate(`/projects/${projectId}/agents`);
    } catch (err) {
      toast.error(sanitizeError(err, t('delete_failed')));
    } finally {
      setIsDeleting(false);
      setDeleteConfirmOpen(false);
    }
  }, [agentName, navigate, projectId, t]);

  const hasMetadataChanges =
    agentMetadata != null && metadataDescription !== (agentMetadata.description ?? '');

  const topologyAgentName = useMemo(
    () => extractDeclaredAgentName(dsl) ?? agentName ?? null,
    [agentName, dsl],
  );

  const deleteImpact = useMemo(() => {
    const targetNames = new Set(
      [agentName, topologyAgentName].filter((value): value is string => Boolean(value)),
    );

    const fallbackEntry =
      currentProject?.entryAgentName != null && targetNames.has(currentProject.entryAgentName);
    if (!topologyData) {
      return { isEntryAgent: fallbackEntry, incomingReferences: [] as DeleteImpactReference[] };
    }

    const isEntryFromTopology = topologyData.topology.nodes.some(
      (node) => node.isEntry && (targetNames.has(node.id) || targetNames.has(node.name)),
    );

    const incomingBySource = new Map<string, Set<AgentDependencyType>>();
    for (const edge of topologyData.topology.edges) {
      if (!targetNames.has(edge.to)) continue;

      const sourceTypes = incomingBySource.get(edge.from) ?? new Set<AgentDependencyType>();
      sourceTypes.add(edge.type);
      incomingBySource.set(edge.from, sourceTypes);
    }

    const incomingReferences = Array.from(incomingBySource.entries())
      .map(([source, types]) => ({
        source,
        types: Array.from(types).sort(),
      }))
      .sort((left, right) => left.source.localeCompare(right.source));

    return {
      isEntryAgent: fallbackEntry || isEntryFromTopology,
      incomingReferences,
    };
  }, [agentName, currentProject?.entryAgentName, topologyAgentName, topologyData]);

  const handleResetMetadata = useCallback(() => {
    if (!agentMetadata) return;
    setMetadataAgentPath(agentMetadata.agentPath);
    setMetadataDescription(agentMetadata.description ?? '');
  }, [agentMetadata]);

  const handleMetadataSave = useCallback(async () => {
    if (!projectId || !agentName || !agentMetadata) return;

    const nextDescription = metadataDescription.trim();

    setMetadataDescription(nextDescription);
    setIsSavingMetadata(true);

    try {
      await updateProjectAgent(projectId, agentName, {
        description: nextDescription,
      });
      await Promise.all([mutateMetadata(), globalMutate(`/api/projects/${projectId}/agents`)]);
      toast.success(t('update_success'));
    } catch (err) {
      toast.error(sanitizeError(err, t('update_failed')));
    } finally {
      setIsSavingMetadata(false);
    }
  }, [agentMetadata, agentName, globalMutate, metadataDescription, mutateMetadata, projectId, t]);

  const handleToggleSection = useCallback(
    (sectionId: SectionId) => {
      if (expandedSection === sectionId) {
        collapseSection();
      } else {
        expandSection(sectionId);
      }
    },
    [expandedSection, expandSection, collapseSection],
  );

  const handleArchClick = useCallback(
    (sectionId: SectionId) => {
      expandSection(sectionId);
      const message = `Help me with the "${sectionId.toLowerCase()}" section of agent "${agentName}".`;
      useArchAIStore.getState().setPrefillMessage(message);
      openOverlay();
    },
    [expandSection, openOverlay, agentName],
  );

  // onChange handlers — update store + serialize to ABL + debounced save
  const handleIdentityChange = useCallback(
    (data: IdentitySectionData) => {
      updateSection('identity', data);
      editSections(serializeIdentityToABL(data));
    },
    [updateSection, editSections],
  );
  const handleToolsChange = useCallback(
    (data: ToolSectionData[]) => {
      updateSection('tools', data);
      editSections(serializeToolsToABL(data));
    },
    [updateSection, editSections],
  );
  const handleGatherChange = useCallback(
    (data: GatherFieldData[]) => {
      updateSection('gather', data);
      editSections(serializeGatherToABL(data));
    },
    [updateSection, editSections],
  );
  const handleFlowChange = useCallback(
    (data: FlowSectionData | null) => {
      const blockedReason = getFlowVisualEditorSaveBlockReason(
        new Set(['flow']),
        flowCompatibilityIssues,
      );
      if (blockedReason) {
        setSaveStatus('error', blockedReason);
        return;
      }

      updateSection('flow', data);
      editSections(serializeFlowToABL(data));
    },
    [editSections, flowCompatibilityIssues, setSaveStatus, updateSection],
  );
  const handleRulesChange = useCallback(
    (data: RulesSectionData) => {
      updateSection('rules', data);
      editSections(serializeRulesToABL(data));
    },
    [updateSection, editSections],
  );
  const handleCoordinationChange = useCallback(
    (data: CoordinationSectionData) => {
      updateSection('coordination', data);
      editSections(serializeCoordinationToABL(data));
    },
    [updateSection, editSections],
  );
  const handleLifecycleChange = useCallback(
    (data: LifecycleSectionData) => {
      const dirtyLifecycleSections = new Set<'onStart' | 'errorHandling' | 'completion'>();

      if (
        JSON.stringify({
          hasOnStart: sections.lifecycle.hasOnStart,
          onStartRespond: sections.lifecycle.onStartRespond,
          onStartCall: sections.lifecycle.onStartCall,
          onStartCallSpec: sections.lifecycle.onStartCallSpec,
          onStartSets: sections.lifecycle.onStartSets,
        }) !==
        JSON.stringify({
          hasOnStart: data.hasOnStart,
          onStartRespond: data.onStartRespond,
          onStartCall: data.onStartCall,
          onStartCallSpec: data.onStartCallSpec,
          onStartSets: data.onStartSets,
        })
      ) {
        dirtyLifecycleSections.add('onStart');
      }

      if (JSON.stringify(sections.lifecycle.errorHandlers) !== JSON.stringify(data.errorHandlers)) {
        dirtyLifecycleSections.add('errorHandling');
      }

      if (
        JSON.stringify(sections.lifecycle.completionConditions) !==
        JSON.stringify(data.completionConditions)
      ) {
        dirtyLifecycleSections.add('completion');
      }

      const blockedReason = getLifecycleVisualEditorSaveBlockReason(
        dirtyLifecycleSections,
        lifecycleCompatibilityIssues,
      );
      if (blockedReason) {
        setSaveStatus('error', blockedReason);
        return;
      }

      updateSection('lifecycle', data);
      const edits = serializeLifecycleDiffToABL(sections.lifecycle, data);
      if (edits.length > 0) {
        editSections(edits);
      }
    },
    [editSections, lifecycleCompatibilityIssues, sections.lifecycle, setSaveStatus, updateSection],
  );
  const handleBehaviorChange = useCallback(
    (data: BehaviorSectionData) => {
      updateSection('behavior', data);
      editSections([
        ...serializeConversationBehaviorToABL(data.conversationBehavior),
        ...serializeBehaviorRefsToABL(data.profiles.map((profile) => profile.name)),
      ]);
    },
    [updateSection, editSections],
  );

  // ---------------------------------------------------------------------------
  // Loading state
  // ---------------------------------------------------------------------------

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 text-muted animate-spin" />
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Error state — fetch error with no DSL loaded
  // ---------------------------------------------------------------------------

  if (error && !dsl) {
    const isTransient = /rate limit|timeout|network|fetch|ECONNREFUSED|503|429/i.test(error);
    return (
      <div className="max-w-3xl mx-auto px-6 py-8">
        <EmptyState
          icon={<Bot className="w-6 h-6" />}
          title={isTransient ? t('detail.load_error_title') : t('not_found')}
          description={isTransient ? error : error || t('detail.could_not_load')}
          action={
            <div className="flex gap-2">
              <Button variant="secondary" onClick={handleBack}>
                {t('detail.back_to_agents')}
              </Button>
              <Button variant="secondary" onClick={() => reload()}>
                {tCommon('retry')}
              </Button>
            </div>
          }
        />
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Compilation failed — agent exists with DSL but IR could not be produced
  // ---------------------------------------------------------------------------

  if (!ir && dsl) {
    return (
      <div className="h-full flex flex-col">
        <div className="px-6 pt-6 pb-4 shrink-0 border-b border-default">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={handleBack}
              className="flex items-center gap-1.5 text-muted hover:text-foreground text-sm transition-default"
              aria-label="Back to agents"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>{t('title')}</span>
            </button>
            <span className="text-border-default">/</span>
            <h1 className="text-2xl font-semibold text-foreground truncate tracking-tight">
              {agentName}
            </h1>
          </div>
        </div>
        <div className="px-6 py-3 bg-destructive-subtle border-b border-destructive/30">
          <div className="flex items-start gap-2 text-sm text-destructive">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-medium">{t('detail.compilation_failed_title')}</p>
              {compileErrors.length > 0 && (
                <ul className="mt-1 list-disc list-inside text-xs">
                  {compileErrors.map((err, i) => (
                    <li key={i}>{err}</li>
                  ))}
                </ul>
              )}
            </div>
            <button
              onClick={() => setDslOpen(true)}
              className="shrink-0 px-2.5 py-1 text-xs font-medium rounded-md bg-destructive/20 text-destructive hover:bg-destructive/30 transition-fast"
            >
              {t('detail.open_dsl_editor')}
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0 flex items-center justify-center">
          <EmptyState
            icon={<Code className="w-6 h-6" />}
            title={t('detail.compilation_failed_title')}
            description={t('detail.compilation_failed_description')}
            action={
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setDslOpen(true)}>
                  <Code className="w-4 h-4 mr-1.5" />
                  {t('detail.dsl_button')}
                </Button>
                <Button variant="secondary" onClick={() => reload()}>
                  {tCommon('retry')}
                </Button>
              </div>
            }
          />
        </div>
        <DslEditorOverlay
          isOpen={dslOpen}
          onClose={() => setDslOpen(false)}
          projectId={projectId!}
          agentName={agentName!}
          dsl={dsl || ''}
          onSaved={reload}
        />
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // No DSL content at all — agent exists but is empty
  // ---------------------------------------------------------------------------

  if (!ir) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-8">
        <EmptyState
          icon={<Bot className="w-6 h-6" />}
          title={t('not_found')}
          description={error || t('detail.could_not_load')}
          action={
            <div className="flex gap-2">
              <Button variant="secondary" onClick={handleBack}>
                {t('detail.back_to_agents')}
              </Button>
              <Button variant="secondary" onClick={() => reload()}>
                {tCommon('retry')}
              </Button>
            </div>
          }
        />
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Compile error banner
  // ---------------------------------------------------------------------------

  const hasCompileWarnings = compileWarnings.length > 0;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="h-full flex flex-col">
      <DetailPageShell
        title={agentName || ''}
        backTo={{
          label: t('title'),
          onClick: handleBack,
        }}
        actions={
          <>
            <Badge
              variant={
                sections.identity.mode
                  ? (MODE_BADGE_VARIANT[sections.identity.mode] ?? 'accent')
                  : 'accent'
              }
            >
              {sections.identity.mode ?? 'reasoning'}
            </Badge>
            {!readOnly && (
              <button
                onClick={() => setVersionsOpen(true)}
                className={clsx(
                  'px-3 py-1.5 rounded-lg text-sm font-medium',
                  'bg-background-muted text-foreground border border-default',
                  'hover:bg-background-elevated transition-default',
                )}
              >
                <span className="flex items-center gap-1.5">
                  <GitBranch className="w-3.5 h-3.5" />
                  {t('detail.versions_button')}
                </span>
              </button>
            )}
            <button
              onClick={() => setDslOpen(true)}
              className={clsx(
                'px-3 py-1.5 rounded-lg text-sm font-medium',
                'bg-background-muted text-foreground border border-default',
                'hover:bg-background-elevated transition-default',
              )}
            >
              <span className="flex items-center gap-1.5">
                <Code className="w-3.5 h-3.5" />
                {t('detail.dsl_button')}
              </span>
            </button>
            <button
              onClick={() => navigate(`/projects/${projectId}/agents/${agentName}/chat`)}
              className={clsx(
                'px-3 py-1.5 rounded-lg text-sm font-medium',
                'bg-accent text-accent-foreground',
                'hover:opacity-90 transition-default',
              )}
            >
              <span className="flex items-center gap-1.5">
                <MessageCircle className="w-3.5 h-3.5" />
                {t('detail.chat_button')}
              </span>
            </button>
            {!readOnly && (
              <Button
                variant="danger"
                size="sm"
                icon={<Trash2 className="w-3.5 h-3.5" />}
                onClick={() => setDeleteConfirmOpen(true)}
              >
                {tCommon('delete')}
              </Button>
            )}
          </>
        }
        maxWidth="md"
        className="flex-1 min-h-0"
      >
        {/* Metadata line */}
        <div className="-mt-4 mb-4 flex items-center gap-3 text-xs text-muted">
          {sections.identity.model && (
            <span>{t('detail.model_label', { model: sections.identity.model })}</span>
          )}
          {sections.identity.goal && (
            <span className="truncate max-w-md">{sections.identity.goal}</span>
          )}
        </div>

        {/* Module provenance banner */}
        {readOnly && moduleProvenance && (
          <div className="mb-4 rounded-lg border border-accent/30 bg-accent/10 p-3 flex items-center gap-2">
            <Package className="w-4 h-4 text-accent" />
            <span className="text-sm">
              Imported from <strong>{moduleProvenance.moduleProjectName}</strong> (
              {moduleProvenance.alias}) v{moduleProvenance.version}
            </span>
            <Lock className="w-3.5 h-3.5 text-muted-foreground ml-auto" />
            <span className="text-xs text-muted-foreground">Read-only</span>
          </div>
        )}

        {agentMetadata && (
          <div className="mb-4 rounded-xl border border-default bg-background-elevated p-4 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 className="text-sm font-semibold text-foreground">
                  {t('detail.metadata_title')}
                </h2>
                <p className="mt-1 text-xs text-muted">{t('detail.metadata_description')}</p>
              </div>
              {hasMetadataChanges && !readOnly && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={isSavingMetadata}
                    onClick={handleResetMetadata}
                  >
                    {tCommon('cancel')}
                  </Button>
                  <Button size="sm" loading={isSavingMetadata} onClick={handleMetadataSave}>
                    {tCommon('save')}
                  </Button>
                </div>
              )}
            </div>

            <div className="mt-4 grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
              <Input label={t('detail.path_label')} value={metadataAgentPath} disabled readOnly />

              <div className="space-y-1.5">
                <label
                  htmlFor="agent-description"
                  className="block text-sm font-medium text-foreground"
                >
                  {tCommon('description')}
                </label>
                <textarea
                  id="agent-description"
                  className="w-full rounded-lg border border-default bg-background-subtle px-3 py-2 text-sm text-foreground placeholder:text-subtle transition-default focus:border-border-focus focus:outline-none focus:ring-1 focus:ring-border-focus resize-none"
                  rows={3}
                  value={metadataDescription}
                  disabled={isSavingMetadata}
                  onChange={(e) => setMetadataDescription(e.target.value)}
                  placeholder={t('create_dialog.description_placeholder')}
                />
              </div>
            </div>
          </div>
        )}

        {/* Lock warning banner */}
        {lockError && (
          <div className="mb-4 px-4 py-3 rounded-lg bg-warning-subtle border border-warning/30">
            <div className="flex items-center gap-2 text-sm text-warning">
              <Lock className="w-4 h-4 shrink-0" />
              <span>{t('detail.lock_read_only', { error: lockError })}</span>
            </div>
          </div>
        )}

        {/* Compile error banner */}
        {hasCompileWarnings && (
          <div className="mb-4 px-4 py-3 rounded-lg bg-warning-subtle border border-warning/30">
            <div className="flex items-start gap-2 text-sm text-warning">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="font-medium">{t('detail.compilation_warnings_title')}</p>
                <ul className="mt-1 list-disc list-inside text-xs">
                  {compileWarnings.map((err, i) => (
                    <li key={i}>{err}</li>
                  ))}
                </ul>
              </div>
              <button
                onClick={() => setDslOpen(true)}
                className="shrink-0 px-2.5 py-1 text-xs font-medium rounded-md bg-warning/20 text-warning hover:bg-warning/30 transition-fast"
              >
                {t('detail.open_dsl_editor')}
              </button>
            </div>
          </div>
        )}

        {/* Stale tool warning banner */}
        {(staleTools.length > 0 || deletedTools.length > 0) && (
          <div className="mb-4">
            <StaleToolBanner
              staleTools={staleTools}
              deletedTools={deletedTools}
              newTools={newTools}
              onRecompile={handleRecompile}
              isRecompiling={isRecompiling}
            />
          </div>
        )}

        {/* Section cards */}
        <div className="space-y-4">
          {/* Identity — always visible */}
          {visibleSections.includes('IDENTITY') && (
            <IdentitySection
              data={sections.identity}
              isExpanded={expandedSection === 'IDENTITY'}
              onToggle={() => handleToggleSection('IDENTITY')}
              onChange={handleIdentityChange}
              onArchClick={() => handleArchClick('IDENTITY')}
              saveStatus={expandedSection === 'IDENTITY' ? saveStatus : undefined}
            />
          )}

          {/* Tools */}
          {visibleSections.includes('TOOLS') && (
            <ToolsSection
              data={sections.tools}
              isExpanded={expandedSection === 'TOOLS'}
              onToggle={() => handleToggleSection('TOOLS')}
              onChange={handleToolsChange}
              onArchClick={() => handleArchClick('TOOLS')}
              saveStatus={expandedSection === 'TOOLS' ? saveStatus : undefined}
              projectId={projectId || undefined}
            />
          )}

          {/* Gather */}
          {visibleSections.includes('GATHER') && (
            <GatherSection
              data={sections.gather}
              isExpanded={expandedSection === 'GATHER'}
              onToggle={() => handleToggleSection('GATHER')}
              onChange={handleGatherChange}
              onArchClick={() => handleArchClick('GATHER')}
              saveStatus={expandedSection === 'GATHER' ? saveStatus : undefined}
            />
          )}

          {/* Flow (scripted agents only) */}
          {visibleSections.includes('FLOW') && sections.flow && (
            <FlowSection
              data={sections.flow}
              isExpanded={expandedSection === 'FLOW'}
              onToggle={() => handleToggleSection('FLOW')}
              onChange={handleFlowChange}
              onArchClick={() => handleArchClick('FLOW')}
              saveStatus={expandedSection === 'FLOW' ? saveStatus : undefined}
            />
          )}

          {/* Rules */}
          {visibleSections.includes('RULES') && (
            <RulesSection
              data={sections.rules}
              isExpanded={expandedSection === 'RULES'}
              onToggle={() => handleToggleSection('RULES')}
              onChange={handleRulesChange}
              onArchClick={() => handleArchClick('RULES')}
              saveStatus={expandedSection === 'RULES' ? saveStatus : undefined}
            />
          )}

          {/* Coordination */}
          {visibleSections.includes('COORDINATION') && (
            <CoordinationSection
              data={sections.coordination}
              isExpanded={expandedSection === 'COORDINATION'}
              onToggle={() => handleToggleSection('COORDINATION')}
              onChange={handleCoordinationChange}
              onArchClick={() => handleArchClick('COORDINATION')}
              saveStatus={expandedSection === 'COORDINATION' ? saveStatus : undefined}
            />
          )}

          {/* Behavior */}
          {visibleSections.includes('BEHAVIOR') && (
            <BehaviorSection
              data={sections.behavior}
              isExpanded={expandedSection === 'BEHAVIOR'}
              onToggle={() => handleToggleSection('BEHAVIOR')}
              onChange={handleBehaviorChange}
              onArchClick={() => handleArchClick('BEHAVIOR')}
              saveStatus={expandedSection === 'BEHAVIOR' ? saveStatus : undefined}
            />
          )}

          {/* Lifecycle */}
          {visibleSections.includes('LIFECYCLE') && (
            <LifecycleSection
              data={sections.lifecycle}
              isExpanded={expandedSection === 'LIFECYCLE'}
              onToggle={() => handleToggleSection('LIFECYCLE')}
              onChange={handleLifecycleChange}
              onArchClick={() => handleArchClick('LIFECYCLE')}
              saveStatus={expandedSection === 'LIFECYCLE' ? saveStatus : undefined}
            />
          )}

          {/* Model & Hyperparameters — standalone card (own data fetch + save) */}
          {projectId && agentName && (
            <div
              className={clsx(
                'rounded-xl border bg-background-elevated shadow-sm',
                modelSectionExpanded ? 'border-accent/30 shadow-md' : 'border-default',
              )}
            >
              <button
                type="button"
                onClick={() => setModelSectionExpanded((v) => !v)}
                className="w-full flex items-center justify-between px-4 py-3 transition-fast cursor-pointer focus-ring rounded-xl"
              >
                <div className="flex items-center gap-2">
                  <Brain className="w-4 h-4 text-muted" />
                  <span className="text-sm font-semibold text-foreground">
                    {t('model_tab_title')}
                  </span>
                </div>
                {modelSectionExpanded ? (
                  <ChevronUp className="w-4 h-4 text-muted" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-muted" />
                )}
              </button>
              {modelSectionExpanded && (
                <div className="px-4 pb-4 pt-1 border-t border-default/50">
                  <AgentModelTab projectId={projectId} agentName={agentName} />
                </div>
              )}
            </div>
          )}
        </div>
      </DetailPageShell>

      {/* Overlays */}
      <VersionsSlideOver
        isOpen={versionsOpen}
        onClose={() => setVersionsOpen(false)}
        projectId={projectId!}
        agentName={agentName!}
      />
      <DslEditorOverlay
        isOpen={dslOpen}
        onClose={() => setDslOpen(false)}
        projectId={projectId!}
        agentName={agentName!}
        dsl={dsl || ''}
        onSaved={reload}
      />
      <ConfirmDialog
        open={deleteConfirmOpen}
        onClose={() => setDeleteConfirmOpen(false)}
        onConfirm={handleDelete}
        title={t('delete_confirm')}
        description={t('delete_confirm_description')}
        confirmLabel={tCommon('delete')}
        loading={isDeleting}
      >
        {(deleteImpact.isEntryAgent || deleteImpact.incomingReferences.length > 0) && (
          <div className="mb-6 flex w-full flex-col gap-3 text-left">
            {deleteImpact.isEntryAgent && (
              <div className="rounded-lg border border-warning/30 bg-warning-subtle/30 p-3">
                <p className="text-xs font-medium uppercase tracking-wide text-warning">
                  {t('detail.delete_entry_warning_title')}
                </p>
                <p className="mt-1 text-sm text-foreground">
                  {t('detail.delete_entry_warning_description')}
                </p>
              </div>
            )}

            {deleteImpact.incomingReferences.length > 0 && (
              <div className="rounded-lg border border-warning/30 bg-warning-subtle/30 p-3">
                <p className="text-xs font-medium uppercase tracking-wide text-warning">
                  {t('detail.delete_dependency_warning_title')}
                </p>
                <p className="mt-1 text-sm text-foreground">
                  {t('detail.delete_dependency_warning_description', {
                    count: deleteImpact.incomingReferences.length,
                  })}
                </p>
                <ul className="mt-3 space-y-1.5 text-sm text-foreground">
                  {deleteImpact.incomingReferences.map((reference) => (
                    <li key={reference.source} className="flex items-center justify-between gap-3">
                      <span className="font-mono">{reference.source}</span>
                      <span className="text-xs uppercase tracking-wide text-muted">
                        {reference.types
                          .map((type) =>
                            type === 'handoff'
                              ? t('detail.delete_dependency_type_handoff')
                              : t('detail.delete_dependency_type_delegate'),
                          )
                          .join(', ')}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}

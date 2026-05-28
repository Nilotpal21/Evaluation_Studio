'use client';

/**
 * AgentEditor Component
 *
 * Core layout for the unified agent editor. Fetches agent IR,
 * populates the editor store, and renders the header + menu + content layout.
 *
 * Section editors are routed via the left menu — clicking a section
 * renders the corresponding editor component in the content area.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import { useTranslations } from 'next-intl';
import { Loader2, Code, MessageSquare, Check, MoreHorizontal, History, Trash2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from '../ui/DropdownMenu';
import { motion, AnimatePresence } from 'framer-motion';
import clsx from 'clsx';
import { toast } from 'sonner';
import { useAgentIR } from '../../hooks/useAgentIR';
import { useAgentVersions } from '../../hooks/useAgentVersions';
import { useSectionEdit } from '../../hooks/useSectionEdit';
import { useNavigationStore } from '../../store/navigation-store';
import { useProjectStore } from '../../store/project-store';
import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';
import {
  analyzeGatherVisualEditorCompatibility,
  getGatherVisualEditorSaveBlockReason,
} from '../../lib/abl/gather-visual-editor-compat';
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
import { removeAgentFromProject } from '../../api/projects';
import { useAgentEditorStore } from './hooks/useAgentEditorStore';
import { useEditorStore } from '../../store/editor-store';
import { useRegisterPageHeader } from '../../contexts/PageHeaderContext';
import { AgentEditorMenu } from './AgentEditorMenu';
import { AgentEditorHeader } from './AgentEditorHeader';
import { AgentEditorBanners } from './AgentEditorBanners';
import { VersionsSlideOver, DslEditorOverlay } from '../agent-detail';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { serializeEditorSections } from './hooks/useEditorSave';
import type { EditorSection, SectionDataMap } from './types';
import {
  IdentityEditor,
  ExecutionEditor,
  ToolsEditor,
  GatherEditor,
  FlowEditor,
  ConstraintsEditor,
  GuardrailsEditor,
  HandoffsEditor,
  DelegatesEditor,
  EscalationEditor,
  MemoryEditor,
  BehaviorEditor,
  OnStartEditor,
  ErrorHandlingEditor,
  CompletionEditor,
  TemplatesEditor,
  DefinitionEditor,
} from './sections';

// =============================================================================
// PROPS
// =============================================================================

interface AgentEditorProps {
  projectId: string;
  agentName: string;
  agents?: Array<{ name: string }>;
  onClose?: () => void;
  onBack?: () => void;
  onSaved?: () => void;
}

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
// SECTION ROUTER
// =============================================================================

/** Map from EditorSection to its key in SectionDataMap (they match by name) */
const SECTION_EDITORS: Record<
  EditorSection,
  React.ComponentType<{
    data: unknown;
    onChange: (data: unknown) => void;
    readOnly?: boolean;
    onArchClick?: () => void;
  }>
> = {
  identity: IdentityEditor as never,
  execution: ExecutionEditor as never,
  tools: ToolsEditor as never,
  gather: GatherEditor as never,
  memory: MemoryEditor as never,
  flow: FlowEditor as never,
  constraints: ConstraintsEditor as never,
  guardrails: GuardrailsEditor as never,
  behavior: BehaviorEditor as never,
  handoffs: HandoffsEditor as never,
  delegates: DelegatesEditor as never,
  escalation: EscalationEditor as never,
  onStart: OnStartEditor as never,
  errorHandling: ErrorHandlingEditor as never,
  completion: CompletionEditor as never,
  templates: TemplatesEditor as never,
  definition: DefinitionEditor as never,
};

/** Sections that need more horizontal space than the default max-w-3xl */
const WIDE_SECTIONS: Partial<Record<EditorSection, string>> = {
  definition: 'max-w-full min-h-full',
  flow: 'max-w-4xl',
  tools: 'max-w-4xl',
};

function getHashSection(visibleSections: EditorSection[]): EditorSection | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const hash = window.location.hash.slice(1);
  return hash && visibleSections.includes(hash as EditorSection) ? (hash as EditorSection) : null;
}

function clearLocationHash() {
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
}

// =============================================================================
// SECTION RENDERER
// =============================================================================

function renderActiveSection(
  section: EditorSection,
  sections: SectionDataMap,
  updateSection: <S extends EditorSection>(s: S, data: SectionDataMap[S]) => void,
  onArchClick?: () => void,
  extraProps?: {
    lookupTableNames?: string[];
    gatherCompatibilityWarnings?: string[];
    gatherReadOnly?: boolean;
    flowCompatibilityWarnings?: string[];
    flowReadOnly?: boolean;
    onOpenDsl?: () => void;
  },
) {
  const data = sections[section];
  const handleChange = (newData: unknown) => {
    updateSection(section, newData as SectionDataMap[typeof section]);
  };
  if (section === 'gather') {
    return (
      <GatherEditor
        data={data as SectionDataMap['gather']}
        onChange={handleChange as (data: SectionDataMap['gather']) => void}
        readOnly={extraProps?.gatherReadOnly}
        onArchClick={onArchClick}
        lookupTableNames={extraProps?.lookupTableNames}
        compatibilityWarnings={extraProps?.gatherCompatibilityWarnings}
        onOpenDsl={extraProps?.onOpenDsl}
      />
    );
  }
  if (section === 'flow') {
    return (
      <FlowEditor
        data={data as SectionDataMap['flow']}
        onChange={handleChange as (data: SectionDataMap['flow']) => void}
        readOnly={extraProps?.flowReadOnly}
        onArchClick={onArchClick}
      />
    );
  }
  const Editor = SECTION_EDITORS[section];
  return <Editor data={data} onChange={handleChange} onArchClick={onArchClick} readOnly={false} />;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function AgentEditor({
  projectId,
  agentName,
  agents,
  onClose,
  onBack,
  onSaved,
}: AgentEditorProps) {
  const t = useTranslations('agent_editor.editor');
  const tAgents = useTranslations('agents');
  const tCommon = useTranslations('common');
  const tHeader = useTranslations('agent_editor.header');
  const currentProject = useProjectStore((s) => s.currentProject);
  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------
  const { ir, dsl, compileErrors, compileWarnings, isLoading, error, reload } = useAgentIR(
    projectId,
    agentName,
  );
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

  // ---------------------------------------------------------------------------
  // Lookup table names (for GatherEditor dropdown)
  // ---------------------------------------------------------------------------
  const [lookupTableNames, setLookupTableNames] = useState<string[]>([]);

  useEffect(() => {
    if (!projectId) return;
    apiFetch(`/api/projects/${projectId}/runtime-config`)
      .then((res) => res.json())
      .then((body) => {
        const tables = body?.data?.lookup_tables ?? [];
        setLookupTableNames(tables.map((t: { name: string }) => t.name));
      })
      .catch((_err: unknown) => {
        // Best-effort fetch — dropdown just won't show if it fails
      });
  }, [projectId]);

  // ---------------------------------------------------------------------------
  // Overlay state
  // ---------------------------------------------------------------------------
  const [showVersions, setShowVersions] = useState(false);
  const [showDslOverlay, setShowDslOverlay] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const navigate = useNavigationStore((s) => s.navigate);

  const handleChat = useCallback(() => {
    navigate(`/projects/${projectId}/agents/${agentName}/chat`);
  }, [navigate, projectId, agentName]);

  const handleAgentSwitch = useCallback(
    (name: string) => {
      navigate(`/projects/${projectId}/agents/${name}`);
    },
    [navigate, projectId],
  );

  const topologyKey = projectId ? `/api/projects/${projectId}/topology` : null;
  const { data: topologyData } = useSWR<AgentTopologyResponse>(topologyKey, fetchProjectTopology, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });

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

  const handleDelete = useCallback(async () => {
    if (!projectId || !agentName) return;

    setIsDeleting(true);
    try {
      await removeAgentFromProject(projectId, agentName);
      toast.success(tAgents('delete_success'));
      navigate(`/projects/${projectId}/agents`);
    } catch (err) {
      toast.error(sanitizeError(err, tAgents('delete_failed')));
    } finally {
      setIsDeleting(false);
      setDeleteConfirmOpen(false);
    }
  }, [agentName, navigate, projectId, tAgents]);

  // ---------------------------------------------------------------------------
  // Edit locking — acquire on mount, release on unmount
  // ---------------------------------------------------------------------------
  const [lockError, setLockError] = useState<string | null>(null);
  useEffect(() => {
    if (!projectId || !agentName) return;
    let released = false;
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
      } catch {
        /* lock acquisition is best-effort */
      }
    };
    acquireLock();
    return () => {
      if (released) return;
      released = true;
      apiFetch(`/api/projects/${projectId}/agents/${agentName}/lock`, {
        method: 'DELETE',
      }).catch((_err: unknown) => {
        // Lock release is best-effort — no user action needed on failure
      });
    };
  }, [projectId, agentName]);

  // ---------------------------------------------------------------------------
  // Arch v0.3 — context is auto-detected via buildPageContext() from nav store.
  // Reload when Arch modifies the DSL externally.
  // ---------------------------------------------------------------------------
  const lastAgentEdit = useArchAIStore((s) => s.lastAgentEditTimestamp);

  useEffect(() => {
    if (lastAgentEdit) reload();
  }, [lastAgentEdit, reload]);

  // ---------------------------------------------------------------------------
  // Store
  // ---------------------------------------------------------------------------
  const loadAgent = useAgentEditorStore((s) => s.loadAgent);
  const reset = useAgentEditorStore((s) => s.reset);
  const activeSection = useAgentEditorStore((s) => s.activeSection);
  const setActiveSection = useAgentEditorStore((s) => s.setActiveSection);
  const sections = useAgentEditorStore((s) => s.sections);
  const visibleSections = useAgentEditorStore((s) => s.visibleSections);
  const dirtySections = useAgentEditorStore((s) => s.dirtySections);
  const menuCollapsed = useAgentEditorStore((s) => s.menuCollapsed);
  const setMenuCollapsed = useAgentEditorStore((s) => s.setMenuCollapsed);
  const saveStatus = useAgentEditorStore((s) => s.saveStatus);
  const markAllClean = useAgentEditorStore((s) => s.markAllClean);
  const setSaveStatus = useAgentEditorStore((s) => s.setSaveStatus);
  const updateSection = useAgentEditorStore((s) => s.updateSection);

  // ---------------------------------------------------------------------------
  // Arch AI assistant — opens v0.3 overlay with section context as prefill
  // ---------------------------------------------------------------------------
  const handleArchClick = useCallback(() => {
    const sectionLabel = activeSection
      .replace(/([A-Z])/g, ' $1')
      .toLowerCase()
      .trim();
    const message = `Help me with the "${sectionLabel}" section of agent "${agentName}".`;
    useArchAIStore.getState().setPrefillMessage(message);
    useArchAIStore.getState().openOverlay();
  }, [activeSection, agentName]);

  // ---------------------------------------------------------------------------
  // Save mechanism — route status updates to the editor store
  // ---------------------------------------------------------------------------
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorStatusCallback = useCallback(
    (status: 'saving' | 'saved' | 'error', error?: string) => {
      if (savedTimerRef.current) {
        clearTimeout(savedTimerRef.current);
        savedTimerRef.current = null;
      }
      if (status === 'error') {
        setSaveStatus('error', error);
      } else {
        setSaveStatus(status);
      }
      // Auto-reset 'saved' to 'idle' after a brief flash
      if (status === 'saved') {
        savedTimerRef.current = setTimeout(() => setSaveStatus('idle'), 1500);
      }
    },
    [setSaveStatus],
  );

  const { saveEditsNow } = useSectionEdit(projectId, agentName, onSaved, editorStatusCallback);

  // ---------------------------------------------------------------------------
  // Load agent IR into the editor store when data arrives
  // ---------------------------------------------------------------------------
  // Sync DSL to useEditorStore so ABLEditor (in DefinitionEditor) has content
  const setOriginalContent = useEditorStore((s) => s.setOriginalContent);
  useEffect(() => {
    if (dsl) setOriginalContent(dsl);
  }, [dsl, setOriginalContent]);

  useEffect(() => {
    if (ir && dsl) {
      loadAgent(agentName, projectId, ir, dsl);
      const hashSection = getHashSection(useAgentEditorStore.getState().visibleSections);
      if (hashSection) {
        setActiveSection(hashSection);
        clearLocationHash();
      }
    }
  }, [ir, dsl, agentName, projectId, loadAgent, setActiveSection]);

  // ---------------------------------------------------------------------------
  // Handle URL hash navigation to sections (from universal search)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const handleHashChange = () => {
      const hashSection = getHashSection(visibleSections);
      if (hashSection) {
        setActiveSection(hashSection);
        if (ir && dsl) {
          clearLocationHash();
        }
      }
    };

    // Check hash on mount
    handleHashChange();

    // Listen for hash changes
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [visibleSections, setActiveSection, ir, dsl]);

  const gatherCompatibilityIssues = useMemo(() => analyzeGatherVisualEditorCompatibility(ir), [ir]);
  const gatherCompatibilityWarnings = useMemo(
    () => gatherCompatibilityIssues.map((issue) => issue.message),
    [gatherCompatibilityIssues],
  );
  const flowCompatibilityIssues = useMemo(() => analyzeFlowVisualEditorCompatibility(ir), [ir]);
  const flowCompatibilityWarnings = useMemo(
    () => flowCompatibilityIssues.map((issue) => issue.message),
    [flowCompatibilityIssues],
  );
  const lifecycleCompatibilityIssues = useMemo(
    () => analyzeLifecycleVisualEditorCompatibility(ir),
    [ir],
  );

  // ---------------------------------------------------------------------------
  // Save handler — iterate dirty sections, serialize, and send
  // ---------------------------------------------------------------------------
  const handleSave = useCallback(async () => {
    if (dirtySections.size === 0) return;

    const blockedReason = getGatherVisualEditorSaveBlockReason(
      dirtySections,
      gatherCompatibilityIssues,
    );
    const flowBlockedReason = getFlowVisualEditorSaveBlockReason(
      dirtySections,
      flowCompatibilityIssues,
    );
    const lifecycleBlockedReason = getLifecycleVisualEditorSaveBlockReason(
      dirtySections,
      lifecycleCompatibilityIssues,
    );
    if (blockedReason || flowBlockedReason || lifecycleBlockedReason) {
      const reason = blockedReason ?? flowBlockedReason ?? lifecycleBlockedReason ?? 'Save failed';
      setSaveStatus('error', reason);
      return;
    }

    const edits = serializeEditorSections(dirtySections, sections);

    // saveEditsNow flushes immediately (no debounce) and updates status
    // via editorStatusCallback → editor store's setSaveStatus
    const saved = await saveEditsNow(edits);

    // After a successful save, reload fresh DSL + recompile IR so that
    // all section views (visual and DSL) stay in sync bidirectionally.
    if (saved) {
      markAllClean();
      reloadRef.current();
    }
  }, [
    dirtySections,
    gatherCompatibilityIssues,
    flowCompatibilityIssues,
    lifecycleCompatibilityIssues,
    markAllClean,
    saveEditsNow,
    sections,
    setSaveStatus,
  ]);

  // ---------------------------------------------------------------------------
  // Discard handler — reset store and re-fetch
  // ---------------------------------------------------------------------------
  // useAgentIR returns `reload` as a fresh closure each render. Capture latest
  // in a ref so handleDiscard stays stable and doesn't invalidate downstream
  // memos (headerActions → useRegisterPageHeader effect → infinite loop).
  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  }, [reload]);
  const handleDiscard = useCallback(() => {
    reset();
    reloadRef.current();
  }, [reset]);

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts
  // ---------------------------------------------------------------------------
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Ctrl/Cmd + S → Save
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (dirtySections.size > 0 && saveStatus !== 'saving') handleSave();
      }
      // Escape → Close (slider/modal only)
      if (e.key === 'Escape' && onClose) {
        onClose();
      }
      // Ctrl/Cmd + Shift + [ → Previous section
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === '[') {
        e.preventDefault();
        const idx = visibleSections.indexOf(activeSection);
        if (idx > 0) setActiveSection(visibleSections[idx - 1]);
      }
      // Ctrl/Cmd + Shift + ] → Next section
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === ']') {
        e.preventDefault();
        const idx = visibleSections.indexOf(activeSection);
        if (idx < visibleSections.length - 1) setActiveSection(visibleSections[idx + 1]);
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [
    dirtySections,
    saveStatus,
    handleSave,
    onClose,
    activeSection,
    visibleSections,
    setActiveSection,
  ]);

  // ---------------------------------------------------------------------------
  // Reduced motion — disable Framer Motion transitions when user prefers
  // ---------------------------------------------------------------------------
  const prefersReducedMotion = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  const sectionTransition = prefersReducedMotion
    ? { duration: 0 }
    : { duration: 0.1, ease: 'easeOut' as const };

  // ---------------------------------------------------------------------------
  // Track visited sections — suppress stagger animation on revisit
  // ---------------------------------------------------------------------------
  const visitedSectionsRef = useRef<Set<EditorSection>>(new Set());
  useEffect(() => {
    visitedSectionsRef.current.add(activeSection);
  }, [activeSection]);

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------
  const isDirty = dirtySections.size > 0;
  const isSaving = saveStatus === 'saving';
  const isSaved = saveStatus === 'saved';
  const saveError = useAgentEditorStore((s) => s.saveError);

  // ---------------------------------------------------------------------------
  // Register page header — title, breadcrumbs, action buttons
  // ---------------------------------------------------------------------------
  const headerActions = useMemo(
    () => (
      <div className="flex items-center gap-2">
        {/* Left group: view / navigate actions */}
        <Button
          variant="secondary"
          size="sm"
          icon={<MessageSquare className="w-4 h-4" />}
          onClick={handleChat}
        >
          {tHeader('chat_with_agent')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon={<Code className="w-4 h-4" />}
          onClick={() => setShowDslOverlay(true)}
        >
          {tHeader('dsl')}
        </Button>
        <DropdownMenu
          trigger={
            <button
              type="button"
              className="inline-flex items-center justify-center w-8 h-8 rounded-md text-foreground-muted hover:text-foreground hover:bg-background-muted transition-default"
              aria-label="More actions"
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>
          }
          align="end"
        >
          <DropdownMenuItem
            icon={<History className="w-4 h-4" />}
            onSelect={() => setShowVersions(true)}
          >
            {tHeader('history')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            icon={<Trash2 className="w-4 h-4" />}
            variant="danger"
            onSelect={() => setDeleteConfirmOpen(true)}
          >
            {tHeader('delete')}
          </DropdownMenuItem>
        </DropdownMenu>

        {/* Separator */}
        <div className="w-px h-4 bg-border mx-0.5" aria-hidden="true" />

        {/* Right group: edit actions */}
        {isDirty && (
          <Button variant="secondary" size="sm" onClick={handleDiscard} disabled={isSaving}>
            {tHeader('discard')}
          </Button>
        )}
        <Button
          variant="primary"
          size="sm"
          icon={
            isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />
          }
          onClick={handleSave}
          disabled={!isDirty || isSaving}
        >
          {isSaving ? tHeader('saving') : tHeader('save')}
        </Button>
      </div>
    ),
    [
      isDirty,
      isSaving,
      handleChat,
      handleSave,
      handleDiscard,
      setShowDslOverlay,
      setShowVersions,
      setDeleteConfirmOpen,
      tHeader,
    ],
  );

  const headerBreadcrumbs = useMemo(
    () =>
      agentName
        ? [{ label: 'Agents', href: `/projects/${projectId}/agents` }, { label: agentName }]
        : [],
    [projectId, agentName],
  );

  useRegisterPageHeader(agentName ?? '', headerActions, undefined, headerBreadcrumbs);
  const hasFlow = sections.flow !== null && (sections.flow?.steps?.length ?? 0) > 0;
  const hasReasoningSteps = sections.flow?.steps?.some((s) => s.reasoning) ?? false;
  const mode = !hasFlow ? 'Reasoning' : hasReasoningSteps ? 'Mixed' : 'Flow';
  const model = sections.execution.model;
  const deleteConfirmDialog = (
    <ConfirmDialog
      open={deleteConfirmOpen}
      onClose={() => setDeleteConfirmOpen(false)}
      onConfirm={handleDelete}
      title={tAgents('delete_confirm')}
      description={tAgents('delete_confirm_description')}
      confirmLabel={tCommon('delete')}
      loading={isDeleting}
    >
      {(deleteImpact.isEntryAgent || deleteImpact.incomingReferences.length > 0) && (
        <div className="mb-6 flex w-full flex-col gap-3 text-left">
          {deleteImpact.isEntryAgent && (
            <div className="rounded-lg border border-warning/30 bg-warning-subtle/30 p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-warning">
                {tAgents('detail.delete_entry_warning_title')}
              </p>
              <p className="mt-1 text-sm text-foreground">
                {tAgents('detail.delete_entry_warning_description')}
              </p>
            </div>
          )}

          {deleteImpact.incomingReferences.length > 0 && (
            <div className="rounded-lg border border-warning/30 bg-warning-subtle/30 p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-warning">
                {tAgents('detail.delete_dependency_warning_title')}
              </p>
              <p className="mt-1 text-sm text-foreground">
                {tAgents('detail.delete_dependency_warning_description', {
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
                            ? tAgents('detail.delete_dependency_type_handoff')
                            : tAgents('detail.delete_dependency_type_delegate'),
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
  );

  // ---------------------------------------------------------------------------
  // Loading state
  // ---------------------------------------------------------------------------
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-5 h-5 animate-spin text-foreground-muted" />
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Error state — fetch error or compilation failure with existing DSL
  // ---------------------------------------------------------------------------
  if (error && !dsl) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-3">
          <p className="text-sm font-medium text-error">{t('failed_to_load')}</p>
          <p className="text-xs text-foreground-muted">{error}</p>
          <div className="flex gap-2 justify-center">
            {onBack && (
              <button
                onClick={onBack}
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-background-muted text-foreground-muted hover:text-foreground transition-default"
              >
                {t('back')}
              </button>
            )}
            <button
              onClick={reload}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-accent text-accent-foreground hover:opacity-90 transition-default"
            >
              {t('retry')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Compilation failed but DSL exists — show editor so user can fix syntax
  if (!ir && dsl) {
    return (
      <div className="flex flex-col h-full">
        {!onBack && (
          <AgentEditorHeader
            agentName={agentName}
            mode="reasoning"
            isDirty={isDirty}
            isSaving={isSaving}
            onSave={handleSave}
            onDiscard={handleDiscard}
            onClose={onClose}
            onBack={onBack}
            onDslOverlay={() => setShowDslOverlay(true)}
            onDelete={() => setDeleteConfirmOpen(true)}
          />
        )}
        <AgentEditorBanners
          compileErrors={compileErrors}
          compileWarnings={compileWarnings}
          gatherCompatibilityWarnings={gatherCompatibilityWarnings}
          flowCompatibilityWarnings={flowCompatibilityWarnings}
          agentName={agentName}
          projectId={projectId}
          onRecompile={handleRecompile}
          onOpenDsl={() => setShowDslOverlay(true)}
        />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-3">
            <p className="text-sm font-medium text-warning">{t('compilation_errors')}</p>
            <p className="text-xs text-foreground-muted">{t('compilation_errors_hint')}</p>
            <button
              onClick={() => setShowDslOverlay(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-accent text-accent-foreground hover:opacity-90 transition-default"
            >
              <Code className="w-3 h-3" />
              {t('open_dsl_editor')}
            </button>
          </div>
        </div>
        {showDslOverlay && (
          <DslEditorOverlay
            isOpen={showDslOverlay}
            onClose={() => setShowDslOverlay(false)}
            projectId={projectId}
            agentName={agentName}
            dsl={dsl}
            onSaved={reload}
          />
        )}
        {deleteConfirmDialog}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  // Page mode = menu starts from top (full height alongside header+content)
  // Slider mode = header on top, menu below (compact layout)
  const isPageMode = !!onBack;

  const menuElement = (
    <AgentEditorMenu
      activeSection={activeSection}
      onSectionChange={setActiveSection}
      sectionData={sections}
      visibleSections={visibleSections}
      collapsed={menuCollapsed}
      onToggleCollapse={() => setMenuCollapsed(!menuCollapsed)}
      dirtySections={dirtySections}
      agentName={isPageMode ? agentName : undefined}
      agents={isPageMode ? agents : undefined}
      onAgentSwitch={isPageMode ? handleAgentSwitch : undefined}
      onBack={isPageMode ? onBack : undefined}
    />
  );

  const headerElement = (
    <AgentEditorHeader
      agentName={agentName}
      mode={mode}
      model={model}
      isDirty={isDirty}
      isSaving={isSaving}
      isSaved={isSaved}
      saveError={saveError}
      onSave={handleSave}
      onDiscard={handleDiscard}
      onClose={onClose}
      onBack={onBack}
      onChat={handleChat}
      onVersions={() => setShowVersions(true)}
      onDslOverlay={() => setShowDslOverlay(true)}
      onDelete={() => setDeleteConfirmOpen(true)}
    />
  );

  const bannersElement = (
    <AgentEditorBanners
      compileErrors={compileErrors}
      compileWarnings={compileWarnings}
      gatherCompatibilityWarnings={gatherCompatibilityWarnings}
      flowCompatibilityWarnings={flowCompatibilityWarnings}
      agentName={agentName}
      projectId={projectId}
      onRecompile={handleRecompile}
      onOpenDsl={() => setShowDslOverlay(true)}
      lockedBy={lockError ?? undefined}
    />
  );

  const overlays = (
    <>
      {showVersions && (
        <VersionsSlideOver
          isOpen={showVersions}
          onClose={() => setShowVersions(false)}
          projectId={projectId}
          agentName={agentName}
        />
      )}
      {showDslOverlay && (
        <DslEditorOverlay
          isOpen={showDslOverlay}
          onClose={() => setShowDslOverlay(false)}
          projectId={projectId}
          agentName={agentName}
          dsl={dsl || ''}
          onSaved={reload}
        />
      )}
      {deleteConfirmDialog}
    </>
  );

  // Page mode: menu full-height on left, header+content on right
  if (isPageMode) {
    return (
      <div className="flex h-full">
        {menuElement}
        <div className="flex flex-col flex-1 min-w-0">
          {headerElement}
          {bannersElement}
          <div className="flex-1 min-h-0 overflow-y-auto bg-noise">
            <AnimatePresence mode="wait">
              <motion.div
                key={activeSection}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={sectionTransition}
                className={clsx('mx-auto', WIDE_SECTIONS[activeSection] ?? 'max-w-3xl')}
              >
                {renderActiveSection(activeSection, sections, updateSection, handleArchClick, {
                  lookupTableNames,
                  gatherCompatibilityWarnings,
                  gatherReadOnly: gatherCompatibilityWarnings.length > 0,
                  flowCompatibilityWarnings,
                  flowReadOnly: flowCompatibilityWarnings.length > 0,
                  onOpenDsl: () => setShowDslOverlay(true),
                })}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
        {overlays}
      </div>
    );
  }

  // Slider/modal mode: header on top, menu+content below
  return (
    <div className="flex flex-col h-full">
      {headerElement}
      {bannersElement}
      <div className="flex flex-1 min-h-0">
        {menuElement}
        <div className="flex-1 min-w-0 overflow-y-auto bg-noise">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeSection}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.1, ease: 'easeOut' }}
              className={clsx('mx-auto', WIDE_SECTIONS[activeSection] ?? 'max-w-3xl')}
            >
              {renderActiveSection(activeSection, sections, updateSection, handleArchClick, {
                lookupTableNames,
                gatherCompatibilityWarnings,
                gatherReadOnly: gatherCompatibilityWarnings.length > 0,
                flowCompatibilityWarnings,
                flowReadOnly: flowCompatibilityWarnings.length > 0,
                onOpenDsl: () => setShowDslOverlay(true),
              })}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
      {overlays}
    </div>
  );
}

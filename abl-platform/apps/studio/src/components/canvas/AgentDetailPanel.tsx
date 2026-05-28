'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { clsx } from 'clsx';
import {
  X,
  Code,
  Info,
  ArrowRightLeft,
  Wrench,
  Check,
  Loader2,
  RotateCcw,
  Network,
  Bot,
  Brain,
  GitBranch,
  ShieldAlert,
  Star,
  Cpu,
  ChevronDown,
  ChevronRight,
  ArrowRight,
  ArrowLeft,
  Braces,
  ArrowRightFromLine,
  Plus,
  Trash2,
  AlertTriangle,
} from 'lucide-react';
import { toast } from 'sonner';
import { springs, transitions } from '../../lib/animation';
import { useEditorStore } from '../../store/editor-store';
import { useCanvasSelectionStore } from '../../store/canvas-store';
import ABLEditor from '../abl/ABLEditor';
import { saveDslWorkingCopy, type RuntimeAgent } from '../../api/runtime-agents';
import {
  parseSummary,
  updateGoal,
  updatePersona,
  parseTools,
  parseRelationships,
  addHandoff,
  removeHandoff,
  updateHandoffField,
  addDelegate,
  removeDelegate,
  updateDelegateField,
} from '../../lib/agent-canvas/dsl-updater';
import type { AgentTool, ToolParam } from '@abl/core';
import { EDGE_COLORS, EDGE_LABELS, type RelationshipType } from './edges/RelationshipEdge';

type PanelTab = 'summary' | 'code' | 'tools' | 'relationships';

const TABS: { id: PanelTab; label: string; Icon: typeof Code }[] = [
  { id: 'summary', label: 'Summary', Icon: Info },
  { id: 'code', label: 'Definition', Icon: Code },
  { id: 'tools', label: 'Tools', Icon: Wrench },
  { id: 'relationships', label: 'Relationships', Icon: ArrowRightLeft },
];

interface AgentDetailPanelProps {
  projectId: string;
  agents: RuntimeAgent[];
  topologyEdges?: Array<{ id: string; source: string; target: string; data?: unknown }>;
  onSaved: () => void;
}

export function AgentDetailPanel({
  projectId,
  agents,
  topologyEdges,
  onSaved,
}: AgentDetailPanelProps) {
  const { sidePanelContent, closeSidePanel } = useCanvasSelectionStore();
  const [panelTab, setPanelTab] = useState<PanelTab>('summary');

  const setOriginalContent = useEditorStore((s) => s.setOriginalContent);
  const dslContent = useEditorStore((s) => s.dslContent);
  const isDirty = useEditorStore((s) => s.isDirty);
  const isSaving = useEditorStore((s) => s.isSaving);
  const setIsSaving = useEditorStore((s) => s.setIsSaving);
  const resetToOriginal = useEditorStore((s) => s.resetToOriginal);

  const isPanelOpen = sidePanelContent?.type === 'node';
  const selectedAgentName = isPanelOpen ? (sidePanelContent.data.name as string) : null;

  const agent = useMemo(
    () => agents.find((a) => a.name === selectedAgentName) ?? null,
    [agents, selectedAgentName],
  );

  useEffect(() => {
    if (isPanelOpen && agent) {
      setOriginalContent(agent.dslContent ?? '');
      setPanelTab('summary');
    }
  }, [isPanelOpen, agent?.name, agent?.dslContent, setOriginalContent]);

  const handleSave = useCallback(async () => {
    if (!agent || !projectId) return;
    const content = useEditorStore.getState().dslContent;
    setIsSaving(true);
    try {
      await saveDslWorkingCopy(projectId, agent.name, content);
      useEditorStore.getState().markSaved();
      toast.success('Agent saved');
      onSaved();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Save failed';
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  }, [agent, projectId, onSaved, setIsSaving]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!isPanelOpen) return;
      if (e.key === 'Escape') closeSidePanel();
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (isDirty && !isSaving) handleSave();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isPanelOpen, closeSidePanel, isDirty, isSaving, handleSave]);

  return (
    <AnimatePresence>
      {isPanelOpen && agent && (
        <>
          <motion.div
            key="panel-backdrop"
            className="fixed inset-0 z-40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={transitions.backdrop}
            onClick={closeSidePanel}
          />

          <motion.div
            key="agent-detail-panel"
            className={clsx(
              'fixed top-0 right-0 h-full z-50',
              'w-[520px]',
              'bg-background-subtle border-l border-default shadow-xl',
              'flex flex-col',
            )}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={springs.gentle}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-default shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-sm font-semibold text-foreground truncate">{agent.name}</span>
                {isDirty && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-warning-subtle text-warning font-medium">
                    Unsaved
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                {isDirty && (
                  <button
                    onClick={resetToOriginal}
                    className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md text-xs font-medium text-foreground-muted hover:text-foreground hover:bg-background-muted transition-default"
                    title="Discard changes"
                  >
                    <RotateCcw className="w-3 h-3" />
                    Discard
                  </button>
                )}
                <button
                  onClick={handleSave}
                  disabled={!isDirty || isSaving}
                  className={clsx(
                    'inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium transition-default',
                    isDirty
                      ? 'bg-accent text-accent-foreground hover:opacity-90'
                      : 'bg-background-muted text-foreground-muted cursor-not-allowed',
                  )}
                >
                  {isSaving ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Check className="w-3.5 h-3.5" />
                  )}
                  Save
                </button>
                <button
                  onClick={closeSidePanel}
                  className="p-1.5 rounded-md text-foreground-muted hover:text-foreground hover:bg-background-muted transition-default"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Tab bar */}
            <div className="flex border-b border-default shrink-0">
              {TABS.map(({ id, label, Icon }) => (
                <button
                  key={id}
                  onClick={() => setPanelTab(id)}
                  className={clsx(
                    'flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium transition-default',
                    panelTab === id
                      ? 'text-accent border-b-2 border-accent'
                      : 'text-foreground-muted hover:text-foreground',
                  )}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {label}
                </button>
              ))}
            </div>

            {/* Tab content */}
            <div className="flex-1 min-h-0 overflow-hidden">
              {panelTab === 'summary' && <SummaryTab dslContent={dslContent} />}

              {panelTab === 'code' && (
                <div className="h-full flex flex-col">
                  {!agent.dslContent && (
                    <div className="px-4 py-2.5 border-b border-default bg-warning-subtle">
                      <p className="text-xs text-warning font-medium">
                        No ABL definition yet. Write your agent definition here.
                      </p>
                    </div>
                  )}
                  <ABLEditor className="flex-1" onSave={handleSave} />
                </div>
              )}

              {panelTab === 'tools' && <ToolsTab dslContent={dslContent} />}

              {panelTab === 'relationships' && selectedAgentName && (
                <RelationshipsTab
                  dslContent={dslContent}
                  agents={agents}
                  selectedAgentName={selectedAgentName}
                  topologyEdges={topologyEdges}
                />
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

// =============================================================================
// SUMMARY TAB (editable Goal, Persona, Mode)
// =============================================================================

function SummaryTab({ dslContent }: { dslContent: string }) {
  const setDslContent = useEditorStore((s) => s.setDslContent);
  const summary = parseSummary(dslContent);

  const [localGoal, setLocalGoal] = useState(summary?.goal ?? '');
  const [localPersona, setLocalPersona] = useState(summary?.persona ?? '');
  const goalFocusedRef = useRef(false);
  const personaFocusedRef = useRef(false);

  useEffect(() => {
    const s = parseSummary(dslContent);
    if (s && !goalFocusedRef.current) setLocalGoal(s.goal ?? '');
    if (s && !personaFocusedRef.current) setLocalPersona(s.persona ?? '');
  }, [dslContent]);

  const handleGoalBlur = useCallback(() => {
    goalFocusedRef.current = false;
    const current = useEditorStore.getState().dslContent;
    const currentSummary = parseSummary(current);
    if (currentSummary && localGoal !== (currentSummary.goal ?? '')) {
      const updated = updateGoal(current, localGoal);
      if (updated) setDslContent(updated);
    }
  }, [localGoal, setDslContent]);

  const handlePersonaBlur = useCallback(() => {
    personaFocusedRef.current = false;
    const current = useEditorStore.getState().dslContent;
    const currentSummary = parseSummary(current);
    if (currentSummary && localPersona !== (currentSummary.persona ?? '')) {
      const updated = updatePersona(current, localPersona);
      if (updated) setDslContent(updated);
    }
  }, [localPersona, setDslContent]);

  // Mode is derived from flow presence per unified agent type design
  const derivedMode = summary?.hasFlow ? 'Flow-based' : 'Reasoning-only';

  if (!summary) {
    return (
      <div className="p-4 h-full overflow-y-auto">
        <ParseErrorBanner />
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3 overflow-y-auto h-full">
      <div className="flex gap-3">
        <FieldCard label="Type">
          <span className="text-sm text-foreground">
            {summary.isSupervisor ? 'Supervisor' : 'Agent'}
          </span>
        </FieldCard>
        <FieldCard label="Mode">
          <span className="text-sm text-foreground">{derivedMode}</span>
        </FieldCard>
      </div>

      <EditableField label="Goal">
        <textarea
          value={localGoal}
          onChange={(e) => setLocalGoal(e.target.value)}
          onFocus={() => {
            goalFocusedRef.current = true;
          }}
          onBlur={handleGoalBlur}
          rows={3}
          placeholder="Describe the agent's goal..."
          className="w-full text-sm text-foreground bg-transparent resize-y placeholder:text-foreground-subtle focus:outline-none leading-relaxed"
        />
      </EditableField>

      <EditableField label="Persona">
        <textarea
          value={localPersona}
          onChange={(e) => setLocalPersona(e.target.value)}
          onFocus={() => {
            personaFocusedRef.current = true;
          }}
          onBlur={handlePersonaBlur}
          rows={4}
          placeholder="Describe the agent's persona..."
          className="w-full text-sm text-foreground bg-transparent resize-y placeholder:text-foreground-subtle focus:outline-none leading-relaxed"
        />
      </EditableField>

      <div className="flex flex-wrap gap-2 pt-1">
        {summary.hasFlow && (
          <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-accent-subtle text-accent font-medium">
            <GitBranch className="w-3 h-3" />
            Flow-based
          </span>
        )}
        {summary.hasEscalation && (
          <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-warning-subtle text-warning font-medium">
            <ShieldAlert className="w-3 h-3" />
            Escalation defined
          </span>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// TOOLS TAB (read-only)
// =============================================================================

function ToolsTab({ dslContent }: { dslContent: string }) {
  const tools = parseTools(dslContent);

  if (!tools)
    return (
      <div className="p-4 h-full overflow-y-auto">
        <ParseErrorBanner />
      </div>
    );

  if (tools.length === 0) {
    return (
      <div className="p-4 h-full overflow-y-auto">
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Wrench className="w-8 h-8 text-foreground-muted/40 mb-3" />
          <p className="text-sm text-foreground-muted">No tools defined</p>
          <p className="text-xs text-foreground-subtle mt-1">Add tools in the Definition tab.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-2 overflow-y-auto h-full">
      <p className="text-xs text-foreground-muted mb-1">
        {tools.length} tool{tools.length !== 1 ? 's' : ''} defined
      </p>
      {tools.map((tool) => (
        <ToolCard key={tool.name} tool={tool} />
      ))}
    </div>
  );
}

function ToolCard({ tool }: { tool: AgentTool }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = tool.parameters.length > 0 || tool.returns;

  return (
    <div className="rounded-lg border border-default bg-background-muted overflow-hidden">
      <button
        onClick={() => hasDetails && setExpanded((v) => !v)}
        className={clsx(
          'w-full flex items-center gap-2 px-3 py-2.5 text-left transition-default',
          hasDetails && 'hover:bg-background-elevated cursor-pointer',
          !hasDetails && 'cursor-default',
        )}
      >
        {hasDetails &&
          (expanded ? (
            <ChevronDown className="w-3 h-3 text-foreground-muted shrink-0" />
          ) : (
            <ChevronRight className="w-3 h-3 text-foreground-muted shrink-0" />
          ))}
        <Wrench className="w-3.5 h-3.5 text-accent shrink-0" />
        <span className="text-sm font-medium text-foreground font-mono truncate">{tool.name}</span>
        {tool.parameters.length > 0 && (
          <span className="text-xs text-foreground-muted ml-auto shrink-0">
            {tool.parameters.length} params
          </span>
        )}
      </button>
      {tool.description && (
        <div className="px-3 pb-2.5 -mt-0.5">
          <p className="text-xs text-foreground-muted leading-relaxed pl-5">{tool.description}</p>
        </div>
      )}
      {expanded && (
        <div className="border-t border-default px-3 py-2.5 space-y-3">
          {tool.parameters.length > 0 && (
            <div>
              <h5 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider mb-1.5 flex items-center gap-1">
                <Braces className="w-3 h-3" />
                Parameters
              </h5>
              <div className="space-y-1">
                {tool.parameters.map((p) => (
                  <div
                    key={p.name}
                    className="flex items-baseline gap-2 rounded-md bg-background px-2.5 py-1.5"
                  >
                    <code className="text-xs font-mono text-accent font-medium shrink-0">
                      {p.name}
                    </code>
                    <span className="text-xs text-foreground-muted font-mono">{p.type}</span>
                    {p.required && (
                      <span className="text-xs text-error font-semibold uppercase">req</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {tool.returns && (
            <div>
              <h5 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider mb-1.5 flex items-center gap-1">
                <ArrowRightFromLine className="w-3 h-3" />
                Returns
              </h5>
              <div className="rounded-md bg-background px-2.5 py-1.5">
                <code className="text-xs font-mono text-foreground/80">{tool.returns.type}</code>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// RELATIONSHIPS TAB (editable handoffs + delegates, read-only incoming)
// =============================================================================

function RelationshipsTab({
  dslContent,
  agents,
  selectedAgentName,
  topologyEdges,
}: {
  dslContent: string;
  agents: RuntimeAgent[];
  selectedAgentName: string;
  topologyEdges?: Array<{ id: string; source: string; target: string; data?: unknown }>;
}) {
  const { selectNode, openSidePanel } = useCanvasSelectionStore();
  const setDslContent = useEditorStore((s) => s.setDslContent);
  const rels = parseRelationships(dslContent);

  const incomingRels = useMemo(() => {
    if (!topologyEdges) return [];
    return topologyEdges
      .filter((e) => e.target === selectedAgentName && e.source !== selectedAgentName)
      .map((e) => ({
        type:
          ((e.data as Record<string, unknown>)?.relationshipType as RelationshipType) ?? 'handoff',
        sourceAgent: e.source,
        label: (e.data as Record<string, unknown>)?.label as string | undefined,
      }));
  }, [topologyEdges, selectedAgentName]);

  const availableAgents = useMemo(
    () => agents.filter((a) => a.name !== selectedAgentName).map((a) => a.name),
    [agents, selectedAgentName],
  );

  const handleAddHandoff = useCallback(
    (to: string) => {
      const current = useEditorStore.getState().dslContent;
      const updated = addHandoff(current, to);
      if (updated) setDslContent(updated);
    },
    [setDslContent],
  );

  const handleRemoveHandoff = useCallback(
    (index: number) => {
      const current = useEditorStore.getState().dslContent;
      const updated = removeHandoff(current, index);
      if (updated) setDslContent(updated);
    },
    [setDslContent],
  );

  const handleUpdateHandoff = useCallback(
    (index: number, field: 'to' | 'when' | 'summary' | 'return', value: string | boolean) => {
      const current = useEditorStore.getState().dslContent;
      const updated = updateHandoffField(current, index, field, value);
      if (updated) setDslContent(updated);
    },
    [setDslContent],
  );

  const handleAddDelegate = useCallback(
    (agent: string) => {
      const current = useEditorStore.getState().dslContent;
      const updated = addDelegate(current, agent);
      if (updated) setDslContent(updated);
    },
    [setDslContent],
  );

  const handleRemoveDelegate = useCallback(
    (index: number) => {
      const current = useEditorStore.getState().dslContent;
      const updated = removeDelegate(current, index);
      if (updated) setDslContent(updated);
    },
    [setDslContent],
  );

  const handleUpdateDelegate = useCallback(
    (index: number, field: 'agent' | 'when' | 'purpose', value: string) => {
      const current = useEditorStore.getState().dslContent;
      const updated = updateDelegateField(current, index, field, value);
      if (updated) setDslContent(updated);
    },
    [setDslContent],
  );

  if (!rels)
    return (
      <div className="p-4 h-full overflow-y-auto">
        <ParseErrorBanner />
      </div>
    );

  return (
    <div className="p-4 space-y-5 overflow-y-auto h-full">
      {/* Handoffs */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider">
            Handoffs
          </h4>
          <AddAgentDropdown
            agents={availableAgents}
            onSelect={handleAddHandoff}
            label="Add Handoff"
          />
        </div>
        {rels.handoffs.length === 0 ? (
          <p className="text-xs text-foreground-muted py-2">No outgoing handoffs defined.</p>
        ) : (
          <div className="space-y-2">
            {rels.handoffs.map((h, i) => (
              <RelCard
                key={`h-${i}`}
                type="handoff"
                target={h.to}
                index={i}
                agents={availableAgents}
                fields={[
                  { label: 'When', value: h.when, field: 'when' },
                  { label: 'Summary', value: h.context.summary, field: 'summary' },
                ]}
                onUpdate={(idx, field, val) =>
                  handleUpdateHandoff(idx, field as 'to' | 'when' | 'summary' | 'return', val)
                }
                onTargetChange={(idx, val) => handleUpdateHandoff(idx, 'to', val)}
                onRemove={handleRemoveHandoff}
              />
            ))}
          </div>
        )}
      </section>

      {/* Delegates */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider">
            Delegates
          </h4>
          <AddAgentDropdown
            agents={availableAgents}
            onSelect={handleAddDelegate}
            label="Add Delegate"
          />
        </div>
        {rels.delegates.length === 0 ? (
          <p className="text-xs text-foreground-muted py-2">No outgoing delegates defined.</p>
        ) : (
          <div className="space-y-2">
            {rels.delegates.map((d, i) => (
              <RelCard
                key={`d-${i}`}
                type="delegate"
                target={d.agent}
                index={i}
                agents={availableAgents}
                fields={[
                  { label: 'When', value: d.when, field: 'when' },
                  { label: 'Purpose', value: d.purpose, field: 'purpose' },
                ]}
                onUpdate={(idx, field, val) =>
                  handleUpdateDelegate(idx, field as 'agent' | 'when' | 'purpose', val)
                }
                onTargetChange={(idx, val) => handleUpdateDelegate(idx, 'agent', val)}
                onRemove={handleRemoveDelegate}
              />
            ))}
          </div>
        )}
      </section>

      {/* Incoming */}
      {incomingRels.length > 0 && (
        <section>
          <h4 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider mb-2">
            Incoming
          </h4>
          <div className="space-y-2">
            {incomingRels.map((rel, i) => (
              <IncomingRelCard
                key={`in-${i}`}
                type={rel.type}
                sourceAgent={rel.sourceAgent}
                label={rel.label}
                onNavigate={(agentName) => {
                  selectNode(agentName);
                  const agent = agents.find((a) => a.name === agentName);
                  if (agent) {
                    openSidePanel({
                      type: 'node',
                      id: agentName,
                      data: { name: agentName },
                    });
                  }
                }}
              />
            ))}
          </div>
        </section>
      )}

      {rels.handoffs.length === 0 && rels.delegates.length === 0 && incomingRels.length === 0 && (
        <p className="text-sm text-foreground-muted text-center py-8">
          No relationships defined. Use the buttons above to add handoffs or delegates.
        </p>
      )}
    </div>
  );
}

// =============================================================================
// SHARED SUB-COMPONENTS
// =============================================================================

function RelCard({
  type,
  target,
  index,
  agents,
  fields,
  onUpdate,
  onTargetChange,
  onRemove,
}: {
  type: RelationshipType;
  target: string;
  index: number;
  agents: string[];
  fields: { label: string; value: string; field: string }[];
  onUpdate: (index: number, field: string, value: string) => void;
  onTargetChange: (index: number, value: string) => void;
  onRemove: (index: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const color = EDGE_COLORS[type];

  return (
    <div className="rounded-lg border border-default bg-background-muted overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="p-0.5 rounded hover:bg-background-elevated transition-default shrink-0"
        >
          {expanded ? (
            <ChevronDown className="w-3 h-3 text-foreground-muted" />
          ) : (
            <ChevronRight className="w-3 h-3 text-foreground-muted" />
          )}
        </button>
        <ArrowRight className="w-3.5 h-3.5 shrink-0" style={{ color }} />
        <span
          className="text-xs px-1.5 py-0.5 rounded font-medium shrink-0"
          style={{ backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)`, color }}
        >
          {EDGE_LABELS[type]}
        </span>
        <select
          value={target}
          onChange={(e) => onTargetChange(index, e.target.value)}
          className="flex-1 text-sm font-medium text-foreground bg-transparent border-none focus:outline-none cursor-pointer truncate"
        >
          {!agents.includes(target) && <option value={target}>{target}</option>}
          {agents.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <button
          onClick={() => onRemove(index)}
          className="p-1 rounded hover:bg-error-subtle text-foreground-muted hover:text-error transition-default shrink-0"
          title="Remove"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
      {expanded && (
        <div className="px-3 pb-3 space-y-2 border-t border-default pt-2">
          {fields.map(({ label, value, field }) => (
            <FieldRow key={field} label={label}>
              <input
                type="text"
                defaultValue={value}
                onBlur={(e) => {
                  if (e.target.value !== value) onUpdate(index, field, e.target.value);
                }}
                placeholder={`${label}...`}
                className="w-full px-2 py-1.5 text-xs rounded-md bg-background border border-default text-foreground placeholder:text-foreground-subtle focus:outline-none focus:ring-2 focus:ring-border-focus/40 focus:border-border-focus transition-default"
              />
            </FieldRow>
          ))}
        </div>
      )}
    </div>
  );
}

function AddAgentDropdown({
  agents,
  onSelect,
  label,
}: {
  agents: string[];
  onSelect: (agent: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-accent hover:bg-accent-subtle border border-accent/30 transition-default"
      >
        <Plus className="w-3 h-3" />
        {label}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-10 w-48 rounded-lg border border-default bg-background-elevated shadow-lg py-1 max-h-48 overflow-y-auto">
          {agents.length === 0 ? (
            <p className="px-3 py-2 text-xs text-foreground-muted">No other agents</p>
          ) : (
            agents.map((a) => (
              <button
                key={a}
                onClick={() => {
                  onSelect(a);
                  setOpen(false);
                }}
                className="w-full text-left px-3 py-1.5 text-xs text-foreground hover:bg-background-muted transition-default truncate"
              >
                {a}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function FieldCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex-1 rounded-lg border border-default bg-background-muted px-3 py-2.5">
      <dt className="text-xs font-semibold text-foreground-muted uppercase tracking-wider mb-1">
        {label}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

function EditableField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-default bg-background-muted px-3 py-2.5 focus-within:border-accent/50 focus-within:ring-1 focus-within:ring-accent/20 transition-default">
      <dt className="text-xs font-semibold text-foreground-muted uppercase tracking-wider mb-1.5">
        {label}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-semibold text-foreground-muted uppercase tracking-wider block mb-1">
        {label}
      </label>
      {children}
    </div>
  );
}

function IncomingRelCard({
  type,
  sourceAgent,
  label,
  onNavigate,
}: {
  type: RelationshipType;
  sourceAgent: string;
  label?: string;
  onNavigate: (agentName: string) => void;
}) {
  const color = EDGE_COLORS[type];
  return (
    <div className="rounded-lg border border-default bg-background-muted overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2">
        <ArrowLeft className="w-3.5 h-3.5 shrink-0" style={{ color }} />
        <span
          className="text-xs px-1.5 py-0.5 rounded font-medium shrink-0"
          style={{
            backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)`,
            color,
          }}
        >
          {EDGE_LABELS[type]}
        </span>
        <button
          onClick={() => onNavigate(sourceAgent)}
          className="text-sm font-medium text-info hover:underline truncate text-left"
        >
          {sourceAgent}
        </button>
        {label && <span className="text-xs text-foreground-subtle ml-auto truncate">{label}</span>}
      </div>
    </div>
  );
}

function ParseErrorBanner() {
  return (
    <div className="rounded-lg border border-warning/30 bg-warning-subtle px-3 py-3 flex items-start gap-2">
      <AlertTriangle className="w-4 h-4 text-warning mt-0.5 shrink-0" />
      <div>
        <p className="text-sm font-medium text-warning">Unable to parse ABL</p>
        <p className="text-xs text-foreground-muted mt-1">
          Fix syntax errors in the Definition tab to enable visual editing.
        </p>
      </div>
    </div>
  );
}

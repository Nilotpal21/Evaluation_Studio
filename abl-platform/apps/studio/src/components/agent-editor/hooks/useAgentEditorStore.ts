/**
 * Agent Editor Store
 *
 * Zustand store for the unified agent editor. Single source of truth for:
 * - Parsed section data (17 fine-grained sections from IR)
 * - Active section navigation
 * - Dirty tracking per section
 * - Save status
 * - Visible section derivation
 *
 * Uses the existing `parseIRToSections` from agent-detail-store to parse IR
 * into 8 grouped `SectionModels`, then splits those into the 17-section
 * `SectionDataMap` used by the editor UI.
 */

import { create } from 'zustand';

import {
  parseIRToSections,
  parseBehavior,
  type SectionModels,
  type IdentitySectionData,
} from '@/store/agent-detail-store';
import type {
  EditorSection,
  SectionDataMap,
  ExecutionSectionData,
  MemorySectionData,
  EscalationSectionData,
  OnStartSectionData,
  TemplateSectionData,
} from '../types';

// =============================================================================
// SAVE STATUS TYPE
// =============================================================================

export type EditorSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

// =============================================================================
// HELPERS
// =============================================================================

/** Safely coerce an IR value to an array. Handles null, undefined, objects, and strings. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asArray(val: unknown): any[] {
  if (Array.isArray(val)) return val;
  if (val == null) return [];
  if (typeof val === 'object') return Object.values(val);
  return [];
}

// =============================================================================
// DEFAULT EMPTY STATE
// =============================================================================

const EMPTY_SECTIONS: SectionDataMap = {
  identity: { goal: '', persona: '', limitations: [], mode: 'reasoning' },
  execution: {},
  tools: [],
  gather: [],
  memory: {
    sessionVars: [],
    persistentPaths: [],
    rememberTriggers: [],
    recallInstructions: [],
  },
  flow: null,
  constraints: [],
  guardrails: [],
  behavior: { conversationBehavior: undefined, profiles: [] },
  handoffs: [],
  delegates: [],
  escalation: { triggers: [], contextForHuman: [], onHumanComplete: [] },
  onStart: { calls: [], sets: [], hooks: [], hasOnStart: false },
  errorHandling: [],
  completion: [],
  templates: [],
  definition: '',
};

// =============================================================================
// ADAPTATION: SectionModels -> SectionDataMap
// =============================================================================

/**
 * Split the identity section into identity + execution.
 * model/temperature/maxTokens/enableThinking go into execution;
 * goal/persona/limitations/mode stay in identity.
 */
function splitIdentity(identity: IdentitySectionData): {
  identity: SectionDataMap['identity'];
  execution: ExecutionSectionData;
} {
  const identityData: SectionDataMap['identity'] = {
    goal: identity.goal,
    persona: identity.persona,
    limitations: identity.limitations,
    mode: identity.mode,
  };

  const execution: ExecutionSectionData = {};
  if (identity.model !== undefined) execution.model = identity.model;
  if (identity.temperature !== undefined) execution.temperature = identity.temperature;
  if (identity.maxTokens !== undefined) execution.maxTokens = identity.maxTokens;
  if (identity.enableThinking !== undefined) execution.enableThinking = identity.enableThinking;

  return { identity: identityData, execution };
}

/**
 * Adapt the lifecycle section into fine-grained editor sections:
 * onStart, errorHandling, completion, memory.
 */
function splitLifecycle(
  lifecycle: SectionModels['lifecycle'],
  ir: Record<string, unknown>,
): {
  onStart: OnStartSectionData;
  errorHandling: SectionDataMap['errorHandling'];
  completion: SectionDataMap['completion'];
  memory: MemorySectionData;
  templates: TemplateSectionData[];
} {
  // on_start: parse directly from IR for richer data than summary
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const irOnStart = (ir as any)?.on_start;
  // hooks: parse from IR or lifecycle
  const irHooks = (ir as any)?.hooks;
  const hookNames: string[] = irHooks
    ? Object.keys(typeof irHooks === 'object' ? irHooks : {})
    : (lifecycle.hooks ?? []);

  const onStart: OnStartSectionData = {
    respond: irOnStart?.respond,
    calls: (irOnStart?.call
      ? [{ tool: irOnStart.call as string, args: undefined as string | undefined }]
      : ([] as Array<{ tool: string; args?: string }>)
    ).concat(
      asArray(irOnStart?.calls).map((c: any) => ({
        tool: (c.tool ?? c) as string,
        args: c.args ? JSON.stringify(c.args) : undefined,
      })),
    ),
    sets: asArray(irOnStart?.set).map((s: any) => ({
      variable: s.variable ?? s.name ?? '',
      value: typeof s.value === 'string' ? s.value : JSON.stringify(s.value ?? ''),
    })),
    hooks: hookNames,
    hasOnStart: lifecycle.hasOnStart,
    onStartCall: lifecycle.onStartCall,
    onStartCallSpec: lifecycle.onStartCallSpec,
  };

  // error handling: reuse parsed data
  const errorHandling = lifecycle.errorHandlers;

  // completion: reuse parsed data
  const completion = lifecycle.completionConditions;

  // memory: parse from IR for richer data than the summary counts
  const irMemory = (ir as any)?.memory;
  const memory: MemorySectionData = {
    sessionVars: asArray(irMemory?.session).map((s: any) => ({
      name: s.name,
      type: s.type,
      description: s.description,
      initialValue: s.initial,
    })),
    persistentPaths: asArray(irMemory?.persistent).map((p: any) =>
      typeof p === 'string' ? p : (p.path ?? p),
    ),
    reads: irMemory?.reads,
    writes: irMemory?.writes,
    rememberTriggers: asArray(irMemory?.remember).map((r: any) => ({
      when: r.when ?? '',
      store: {
        value: r.store?.value ?? '',
        target: r.store?.target ?? '',
      },
      ttl: r.ttl,
    })),
    recallInstructions: asArray(irMemory?.recall).map((r: any) => ({
      event: r.event ?? '',
      instruction: r.instruction ?? '',
    })),
  };

  // templates: parse from IR (may be array or object keyed by name)
  const irTemplatesRaw = (ir as any)?.templates;
  const irTemplatesArr: any[] = Array.isArray(irTemplatesRaw)
    ? irTemplatesRaw
    : irTemplatesRaw && typeof irTemplatesRaw === 'object'
      ? Object.entries(irTemplatesRaw).map(([name, val]: [string, any]) => ({
          name,
          ...(typeof val === 'object' ? val : {}),
        }))
      : [];
  const templates: TemplateSectionData[] = irTemplatesArr.map((t: any) => ({
    name: t.name ?? '',
    formats: {
      default: t.formats?.default ?? t.default ?? t.content,
      markdown: t.formats?.markdown ?? t.markdown,
      html: t.formats?.html ?? t.html,
      voiceInstructions: t.formats?.voice_instructions ?? t.voice_instructions,
    },
  }));
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return { onStart, errorHandling, completion, memory, templates };
}

/**
 * Parse escalation from IR (the existing parseCoordination only gives a boolean).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
function parseEscalation(ir: Record<string, unknown>): EscalationSectionData {
  const esc = (ir as any)?.coordination?.escalation;
  const defaultPriority = 'medium';
  if (!esc) {
    return { triggers: [], contextForHuman: [], onHumanComplete: [] };
  }

  return {
    triggers: asArray(esc.triggers).map((t: any) => ({
      when: t.when ?? '',
      reason: t.reason ?? '',
      priority: t.priority ?? defaultPriority,
      tags: t.tags,
    })),
    contextForHuman: asArray(esc.context_for_human),
    onHumanComplete: asArray(esc.on_human_complete).map((h: any) => ({
      condition: h.condition ?? '',
      action: h.action ?? '',
    })),
  };
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Convert the 8-group SectionModels to the 17-section SectionDataMap.
 * Uses the raw IR for sections that need richer data than the summaries.
 */
export function sectionModelsToEditorSections(
  models: SectionModels,
  ir: Record<string, unknown>,
  dsl: string,
): SectionDataMap {
  const { identity, execution } = splitIdentity(models.identity);
  const { onStart, errorHandling, completion, memory, templates } = splitLifecycle(
    models.lifecycle,
    ir,
  );

  // Enrich execution with additional fields from IR that splitIdentity doesn't carry
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const irExec = (ir as any)?.execution;
  if (irExec) {
    if (irExec.thinking_budget !== undefined) execution.thinkingBudget = irExec.thinking_budget;
    if (irExec.tool_timeout !== undefined) execution.toolTimeout = irExec.tool_timeout;
    if (irExec.llm_timeout !== undefined) execution.llmTimeout = irExec.llm_timeout;
    if (irExec.session_idle_timeout !== undefined)
      execution.sessionIdleTimeout = irExec.session_idle_timeout;
    if (irExec.max_reasoning_iterations !== undefined)
      execution.maxReasoningIterations = irExec.max_reasoning_iterations;
    if (irExec.max_flow_iterations !== undefined)
      execution.maxFlowIterations = irExec.max_flow_iterations;
    if (irExec.voice_latency_target !== undefined)
      execution.voiceLatencyTarget = irExec.voice_latency_target;
    if (irExec.fallback_model) execution.fallbackModel = irExec.fallback_model;
    if (irExec.operation_models && Object.keys(irExec.operation_models).length > 0)
      execution.operationModels = irExec.operation_models;
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return {
    identity,
    execution,
    tools: models.tools,
    gather: models.gather,
    memory,
    flow: models.flow,
    constraints: models.rules.constraints,
    guardrails: models.rules.guardrails,
    behavior: parseBehavior(ir),
    handoffs: models.coordination.handoffs,
    delegates: models.coordination.delegates,
    escalation: parseEscalation(ir),
    onStart,
    errorHandling,
    completion,
    templates,
    definition: dsl,
  };
}

// =============================================================================
// VISIBLE SECTIONS
// =============================================================================

/** Ordered list of all possible sections (order = menu order) */
const SECTION_ORDER: EditorSection[] = [
  'identity',
  'execution',
  'tools',
  'gather',
  'memory',
  'flow',
  'constraints',
  'guardrails',
  'behavior',
  'handoffs',
  'delegates',
  'escalation',
  'onStart',
  'errorHandling',
  'completion',
  'templates',
  'definition',
];

/**
 * Sections hidden until backend serializer support is added.
 * The editors exist and work, but saving would silently lose data.
 * Re-enable each as its serializer is implemented.
 */
const HIDDEN_UNTIL_SERIALIZER: Set<EditorSection> = new Set([
  'memory', // serializeLifecycleToABL only saves var names, not rich details
  'escalation', // serializeCoordinationToABL uses hardcoded placeholder
  'templates', // no serializeTemplatesToABL exists
]);

/**
 * Derive which sections should be visible in the menu.
 * - flow: always visible (users can enable flow on any agent)
 * - hidden sections: excluded until serializer support lands
 * - definition: always last
 */
export function deriveVisibleSections(data: SectionDataMap): EditorSection[] {
  return SECTION_ORDER.filter((section) => {
    if (HIDDEN_UNTIL_SERIALIZER.has(section)) return false;
    return true;
  });
}

// =============================================================================
// STORE INTERFACE
// =============================================================================

interface AgentEditorState {
  // Agent identity
  agentName: string | null;
  projectId: string | null;
  rawDsl: string;

  // Parsed section data
  sections: SectionDataMap;

  // UI state
  activeSection: EditorSection;
  dirtySections: Set<EditorSection>;
  saveStatus: EditorSaveStatus;
  saveError: string | null;
  compileErrors: string[];
  visibleSections: EditorSection[];
  menuCollapsed: boolean;

  // Actions
  loadAgent: (
    agentName: string,
    projectId: string,
    ir: Record<string, unknown>,
    dsl: string,
  ) => void;
  updateSection: <S extends EditorSection>(section: S, data: SectionDataMap[S]) => void;
  setActiveSection: (section: EditorSection) => void;
  setSaveStatus: (status: EditorSaveStatus, error?: string) => void;
  markSectionClean: (section: EditorSection) => void;
  markAllClean: () => void;
  setMenuCollapsed: (collapsed: boolean) => void;
  setCompileErrors: (errors: string[]) => void;
  updateDsl: (dsl: string) => void;
  reset: () => void;
}

// =============================================================================
// INITIAL STATE
// =============================================================================

const INITIAL_STATE: Omit<AgentEditorState, keyof AgentEditorActions> = {
  agentName: null,
  projectId: null,
  rawDsl: '',
  sections: { ...EMPTY_SECTIONS },
  activeSection: 'identity',
  dirtySections: new Set(),
  saveStatus: 'idle',
  saveError: null,
  compileErrors: [],
  visibleSections: deriveVisibleSections(EMPTY_SECTIONS),
  menuCollapsed: false,
};

/** Action signatures extracted for the Omit helper */
type AgentEditorActions = {
  loadAgent: AgentEditorState['loadAgent'];
  updateSection: AgentEditorState['updateSection'];
  setActiveSection: AgentEditorState['setActiveSection'];
  setSaveStatus: AgentEditorState['setSaveStatus'];
  markSectionClean: AgentEditorState['markSectionClean'];
  markAllClean: AgentEditorState['markAllClean'];
  setMenuCollapsed: AgentEditorState['setMenuCollapsed'];
  setCompileErrors: AgentEditorState['setCompileErrors'];
  updateDsl: AgentEditorState['updateDsl'];
  reset: AgentEditorState['reset'];
};

// =============================================================================
// STORE
// =============================================================================

export const useAgentEditorStore = create<AgentEditorState>((set, get) => ({
  ...INITIAL_STATE,

  loadAgent: (agentName, projectId, ir, dsl) => {
    const models = parseIRToSections(ir);
    const sections = sectionModelsToEditorSections(models, ir, dsl);
    const visibleSections = deriveVisibleSections(sections);
    const previous = get();
    const shouldPreserveActiveSection =
      previous.agentName === agentName &&
      previous.projectId === projectId &&
      visibleSections.includes(previous.activeSection);

    set({
      agentName,
      projectId,
      rawDsl: dsl,
      sections,
      visibleSections,
      activeSection: shouldPreserveActiveSection ? previous.activeSection : 'identity',
      dirtySections: new Set(),
      saveStatus: 'idle',
      saveError: null,
      compileErrors: [],
    });
  },

  updateSection: (section, data) =>
    set((state) => {
      const sections = { ...state.sections, [section]: data };
      const dirtySections = new Set(state.dirtySections);
      dirtySections.add(section);
      return {
        sections,
        dirtySections,
        visibleSections: deriveVisibleSections(sections),
      };
    }),

  setActiveSection: (section) => set({ activeSection: section }),

  setSaveStatus: (status, error) =>
    set({
      saveStatus: status,
      saveError: error ?? null,
    }),

  markSectionClean: (section) =>
    set((state) => {
      const dirtySections = new Set(state.dirtySections);
      dirtySections.delete(section);
      return { dirtySections };
    }),

  markAllClean: () => set({ dirtySections: new Set() }),

  setMenuCollapsed: (collapsed) => set({ menuCollapsed: collapsed }),

  setCompileErrors: (errors) => set({ compileErrors: errors }),

  updateDsl: (dsl) =>
    set((state) => ({
      rawDsl: dsl,
      sections: { ...state.sections, definition: dsl },
    })),

  reset: () =>
    set({
      ...INITIAL_STATE,
      sections: { ...EMPTY_SECTIONS },
      dirtySections: new Set(),
      visibleSections: deriveVisibleSections(EMPTY_SECTIONS),
    }),
}));

// =============================================================================
// SELECTORS
// =============================================================================

export const selectSectionData =
  <S extends EditorSection>(section: S) =>
  (state: AgentEditorState): SectionDataMap[S] =>
    state.sections[section];

export const selectIsSectionDirty = (section: EditorSection) => (state: AgentEditorState) =>
  state.dirtySections.has(section);

export const selectHasDirtyChanges = (state: AgentEditorState) => state.dirtySections.size > 0;

export const selectIsActiveSection = (section: EditorSection) => (state: AgentEditorState) =>
  state.activeSection === section;

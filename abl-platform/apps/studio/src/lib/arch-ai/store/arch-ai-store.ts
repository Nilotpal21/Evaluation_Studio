import { create } from 'zustand';
import type { OverlayState } from '@/lib/arch-ai/types/arch';

export interface ArtifactVersion {
  version: number;
  data: unknown;
  toolCallId: string;
  timestamp: string;
}

export type ArtifactTabType =
  | 'agent_code'
  | 'diff'
  | 'plan'
  | 'blueprint-document'
  | 'topology'
  // Onboarding tabs (v0.3 project creation flow)
  | 'spec-document'
  | 'journal'
  | 'summary'
  // In-project tabs
  | 'search-ai'
  | 'health'
  | 'integration';

/**
 * Structured handoff payload for cross-page actions (e.g. resuming an
 * integration draft or starting a new integration with a specific provider).
 * Richer than the free-text `prefillMessage` channel.
 */
export type PrefillMetadata =
  | { kind: 'start_integration'; providerKey?: string; targetAgentNames?: string[] }
  | { kind: 'resume_integration'; draftId: string; intent: 'resume' | 'fix' | 'manage' }
  | { kind: 'manage_integration'; connectionId?: string; providerKey?: string; draftId?: string }
  | { kind: 'manage_tool'; toolId: string; toolName: string }
  | { kind: 'diagnose'; evalId?: string; sessionId?: string };

export interface ArtifactTab {
  id: string;
  type: ArtifactTabType;
  label: string;
  data: unknown;
  version: number;
  toolCallId: string;
  /** Briefly true after creation — drives highlight animation in the tab bar */
  isNew?: boolean;
}

/** Moves the journal tab to index 0 without creating one if absent. Idempotent. */
export function ensureJournalFirst(tabs: ArtifactTab[]): ArtifactTab[] {
  const journalIdx = tabs.findIndex((t) => t.type === 'journal');
  if (journalIdx <= 0) return tabs; // already first (or absent)
  const reordered = [...tabs];
  const [journal] = reordered.splice(journalIdx, 1);
  reordered.unshift(journal);
  return reordered;
}

const MAX_TABS = 16;
const MAX_JOURNAL_ENTRIES = 200;
const MAX_VERSIONS = 50;
const MAX_BUILD_LOG_ENTRIES = 500;

export interface FilePanelFileUpload {
  blobId: string;
  mediaType: string;
  size: number;
  tokenCost: number;
  inContext: boolean;
}

export interface FilePanelFile {
  content: string;
  /** Partial content being streamed in via file_content_delta events.
   *  When present, the UI shows this (with a streaming indicator) instead of `content`. */
  streamingContent?: string;
  compileStatus?: 'pending' | 'compiling' | 'success' | 'warning' | 'error' | 'fixing';
  compileWarnings?: string[];
  /** File type: 'agent' (default), 'mock' for mock server files, 'upload' for user uploads */
  fileType?: 'agent' | 'mock' | 'upload';
  /** File extension for display (default: .abl.yaml) */
  displayName?: string;
  /** Upload metadata — present when fileType === 'upload' */
  upload?: FilePanelFileUpload;
}

export type StageStatus = 'pending' | 'active' | 'complete' | 'error';

export interface AgentBuildStages {
  gen: StageStatus;
  comp: StageStatus;
  enrich: StageStatus;
  done: StageStatus;
}

// ---------------------------------------------------------------------------
// Unified BUILD state — single source of truth for BUILD phase UI
// ---------------------------------------------------------------------------

export type BuildAgentUIStatus =
  | 'queued'
  | 'generating'
  | 'parsed'
  | 'fixing'
  | 'validated'
  | 'compiled'
  | 'warning'
  | 'error';

export interface BuildAgentState {
  status: BuildAgentUIStatus;
  errors: string[];
  warnings: string[];
  toolCount: number;
  handoffCount: number;
  elapsed?: number;
  fixRounds?: number;
}

export interface BuildLogEntry {
  timestamp: string;
  eventType: string;
  agent?: string;
  stage?: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface BuildState {
  phase: 'idle' | 'ready' | 'generating' | 'validating' | 'complete';
  agents: Record<string, BuildAgentState>;
  summary: { total: number; compiled: number; warnings: number; errors: number } | null;
  log: BuildLogEntry[];
}

interface ArchAIState {
  // Artifact panel
  showArtifactPanel: boolean;
  activeArtifactTab: 'topology' | 'agents' | 'api' | 'mocks';
  artifactVersions: {
    topology: ArtifactVersion[];
    agents: ArtifactVersion[];
  };

  // Dynamic tabs (in-project mode + onboarding)
  artifactTabs: ArtifactTab[];
  activeTabId: string | null;

  // IDE file panel (BUILD phase)
  filePanelVisible: boolean;
  filePanelFiles: Record<string, FilePanelFile>;
  filePanelSelectedFile: string | null;

  // BUILD phase: agents the user has approved via the agent_review gate.
  approvedAgents: string[];
  // Currently-reviewing agent name (active agent_review gate target).
  currentReviewAgent: string | null;

  // Journal entries (populated via SSE journal_entry events)
  journalEntries: Array<{ type: string; summary: string; description?: string; phase?: string }>;

  // Prefill from ArchBar
  prefillMessage: string | null;

  // Structured handoff for cross-page actions (resume integration, start_integration, etc.)
  prefillMetadata: PrefillMetadata | null;

  // Project creation
  createdProjectId: string | null;

  // In-project overlay expansion state (independent from showArtifactPanel which is onboarding-only)
  overlayState: OverlayState;

  // Timestamp updated when Arch modifies an agent — used to trigger data reload
  lastAgentEditTimestamp: number | null;

  // Session preservation (slider → full-view transition)
  preserveSession: boolean;
  preservedMessages: unknown[] | null;

  // BUILD phase: per-agent 4-stage progress (legacy — prefer buildState)
  buildStages: Record<string, AgentBuildStages>;
  agentElapsed: Record<string, number>;
  agentUsage: Record<string, { inputTokens: number; outputTokens: number; totalTokens: number }>;

  // Unified BUILD state — single source of truth for BUILD phase UI
  buildState: BuildState;

  // Spec document (spec-document panel — unified spec doc from backend)
  specDocument: Record<string, unknown> | null;
  specDocumentVersion: number;

  // Actions — home mode
  setShowArtifactPanel: (show: boolean) => void;
  setActiveArtifactTab: (tab: ArchAIState['activeArtifactTab']) => void;
  addArtifactVersion: (type: 'topology' | 'agents', data: unknown, toolCallId: string) => void;
  setPrefillMessage: (msg: string | null) => void;
  setPrefillMetadata: (md: PrefillMetadata | null) => void;
  setCreatedProjectId: (id: string | null) => void;

  // Actions — dynamic tabs (in-project + onboarding)
  addTab: (tab: Omit<ArtifactTab, 'id' | 'version'>) => string;
  updateTab: (tabId: string, data: unknown) => void;
  removeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;

  // Actions — BUILD phase approved agents
  setApprovedAgents: (names: string[]) => void;
  approveAgent: (name: string) => void;
  unapproveAgent: (name: string) => void;
  setCurrentReviewAgent: (name: string | null) => void;

  // Actions — IDE file panel (BUILD phase)
  showFilePanel: () => void;
  hideFilePanel: () => void;
  addFile: (
    name: string,
    content: string,
    opts?: {
      fileType?: 'agent' | 'mock' | 'upload';
      displayName?: string;
      upload?: FilePanelFileUpload;
    },
  ) => void;
  /** Append a streaming delta to a file's streamingContent. Creates the file entry if needed. */
  appendFileContent: (agentName: string, delta: string) => void;
  updateFileStatus: (
    name: string,
    status: FilePanelFile['compileStatus'],
    warnings?: string[],
  ) => void;
  removeFile: (name: string) => void;
  selectFile: (name: string) => void;

  // Actions — journal
  addJournalEntry: (entry: {
    type: string;
    summary: string;
    description?: string;
    phase?: string;
  }) => void;

  // Actions — in-project overlay
  openOverlay: () => void;
  closeOverlay: () => void;
  setOverlayState: (state: OverlayState) => void;

  // Actions — agent edit signal
  setLastAgentEdit: () => void;

  setPreserveSession: (preserve: boolean) => void;
  setPreservedMessages: (messages: unknown[] | null) => void;

  // Actions — BUILD stage tracking
  setBuildStage: (agent: string, stage: keyof AgentBuildStages, status: StageStatus) => void;
  clearBuildStages: () => void;
  setAgentElapsed: (agent: string, ms: number) => void;
  setAgentUsage: (
    agent: string,
    usage: { inputTokens: number; outputTokens: number; totalTokens: number },
  ) => void;

  // Actions — spec document
  setSpecDocument: (doc: Record<string, unknown>) => void;
  updateSpecDocument: (path: string, value: unknown, version: number) => void;
  setSpecDocumentVersion: (version: number) => void;

  // Actions — unified BUILD state
  setBuildPhase: (phase: BuildState['phase']) => void;
  setBuildState: (buildState: BuildState) => void;
  setBuildAgentStatus: (
    agent: string,
    status: BuildAgentUIStatus,
    data?: Partial<Omit<BuildAgentState, 'status'>>,
  ) => void;
  setBuildReconciled: (
    agents: Record<
      string,
      { status: 'compiled' | 'warning' | 'error'; errors: string[]; warnings: string[] }
    >,
    summary: BuildState['summary'],
  ) => void;
  appendBuildLog: (entry: Omit<BuildLogEntry, 'timestamp'> & { timestamp?: string }) => void;
  clearBuildLog: () => void;
  resetBuildState: () => void;

  /** Clear session-scoped project UI state while keeping the overlay open in chat mode */
  clearProjectWorkspace: () => void;
  /** Clear project-scoped state and return the project overlay to its closed baseline */
  resetProjectState: () => void;
  reset: () => void;
}

function generateTabId(): string {
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const initialState = {
  showArtifactPanel: false,
  activeArtifactTab: 'topology' as const,
  artifactVersions: {
    topology: [] as ArtifactVersion[],
    agents: [] as ArtifactVersion[],
  },
  artifactTabs: [] as ArtifactTab[],
  activeTabId: null as string | null,
  filePanelVisible: false,
  filePanelFiles: {} as Record<string, FilePanelFile>,
  filePanelSelectedFile: null as string | null,
  approvedAgents: [] as string[],
  currentReviewAgent: null as string | null,
  journalEntries: [] as Array<{ type: string; summary: string; phase?: string }>,
  prefillMessage: null as string | null,
  prefillMetadata: null as PrefillMetadata | null,
  createdProjectId: null as string | null,
  lastAgentEditTimestamp: null as number | null,
  overlayState: 'closed' as OverlayState,
  preserveSession: false,
  preservedMessages: null as unknown[] | null,
  buildStages: {} as Record<string, AgentBuildStages>,
  agentElapsed: {} as Record<string, number>,
  agentUsage: {} as Record<
    string,
    { inputTokens: number; outputTokens: number; totalTokens: number }
  >,
  buildState: { phase: 'idle', agents: {}, summary: null, log: [] } as BuildState,
  specDocument: null as Record<string, unknown> | null,
  specDocumentVersion: 0,
};

export const useArchAIStore = create<ArchAIState>((set) => ({
  ...initialState,

  setShowArtifactPanel: (show) => set({ showArtifactPanel: show }),
  setActiveArtifactTab: (tab) => set({ activeArtifactTab: tab }),

  addArtifactVersion: (type, data, toolCallId) =>
    set((state) => {
      const versions = state.artifactVersions[type];
      const newVersion: ArtifactVersion = {
        version: versions.length + 1,
        data,
        toolCallId,
        timestamp: new Date().toISOString(),
      };
      return {
        artifactVersions: {
          ...state.artifactVersions,
          [type]:
            versions.length >= MAX_VERSIONS
              ? [...versions.slice(-MAX_VERSIONS + 1), newVersion]
              : [...versions, newVersion],
        },
        showArtifactPanel: true,
        activeArtifactTab: type,
      };
    }),

  addTab: (tab) => {
    const id = generateTabId();
    let resolvedId = id;
    set((state) => {
      // Replace existing tab of same type+label instead of creating duplicates
      const existingIdx = state.artifactTabs.findIndex(
        (t) => t.type === tab.type && t.label === tab.label,
      );
      if (existingIdx >= 0) {
        const existing = state.artifactTabs[existingIdx];
        resolvedId = existing.id;
        const updated = {
          ...existing,
          data: tab.data,
          toolCallId: tab.toolCallId,
          version: existing.version + 1,
        };
        const tabs = [...state.artifactTabs];
        tabs[existingIdx] = updated;
        return {
          artifactTabs: ensureJournalFirst(tabs),
          activeTabId: state.activeTabId ?? existing.id,
          showArtifactPanel: true,
        };
      }
      const newTab: ArtifactTab = { ...tab, id, version: 1, isNew: true };
      let tabs = [...state.artifactTabs, newTab];
      // Evict oldest agent_code tabs if over max — never evict pinned artifact tabs
      if (tabs.length > MAX_TABS) {
        const pinned = tabs.filter((t) => t.type !== 'agent_code');
        const agentTabs = tabs.filter((t) => t.type === 'agent_code');
        const maxAgentTabs = Math.max(MAX_TABS - pinned.length, 1);
        tabs = [...pinned, ...agentTabs.slice(agentTabs.length - maxAgentTabs)];
      }
      return {
        artifactTabs: ensureJournalFirst(tabs),
        activeTabId: id,
        showArtifactPanel: true,
      };
    });
    return resolvedId;
  },

  updateTab: (tabId, data) =>
    set((state) => ({
      artifactTabs: state.artifactTabs.map((t) =>
        t.id === tabId ? { ...t, data, version: t.version + 1 } : t,
      ),
    })),

  removeTab: (tabId) =>
    set((state) => {
      const tabs = state.artifactTabs.filter((t) => t.id !== tabId);
      let activeTabId = state.activeTabId;
      if (activeTabId === tabId) {
        activeTabId = tabs.length > 0 ? tabs[tabs.length - 1].id : null;
      }
      return {
        artifactTabs: tabs,
        activeTabId,
        showArtifactPanel: tabs.length > 0 ? state.showArtifactPanel : false,
      };
    }),

  setActiveTab: (tabId) => set({ activeTabId: tabId }),

  setPrefillMessage: (msg) => set({ prefillMessage: msg }),
  setPrefillMetadata: (md) => set({ prefillMetadata: md }),
  setCreatedProjectId: (id) => set({ createdProjectId: id }),
  setLastAgentEdit: () => set({ lastAgentEditTimestamp: Date.now() }),

  // Approved agents actions
  setApprovedAgents: (names) => set({ approvedAgents: names }),
  approveAgent: (name) =>
    set((state) => {
      if (state.approvedAgents.includes(name)) return state;
      return { approvedAgents: [...state.approvedAgents, name] };
    }),
  unapproveAgent: (name) =>
    set((state) => ({
      approvedAgents: state.approvedAgents.filter((n) => n !== name),
    })),
  setCurrentReviewAgent: (name) => set({ currentReviewAgent: name }),

  // IDE file panel actions
  showFilePanel: () => set({ filePanelVisible: true }),
  hideFilePanel: () => set({ filePanelVisible: false }),
  addFile: (name, content, opts) =>
    set((state) => ({
      filePanelFiles: {
        ...state.filePanelFiles,
        [name]: {
          content,
          // Clear streaming content once canonical content arrives
          streamingContent: undefined,
          compileStatus: 'pending',
          fileType: opts?.fileType,
          displayName: opts?.displayName,
          upload: opts?.upload,
        },
      },
      filePanelSelectedFile: name,
    })),
  appendFileContent: (agentName, delta) =>
    set((state) => {
      const existing = state.filePanelFiles[agentName];
      if (existing) {
        return {
          filePanelFiles: {
            ...state.filePanelFiles,
            [agentName]: {
              ...existing,
              streamingContent: (existing.streamingContent ?? '') + delta,
            },
          },
        };
      }
      // File entry doesn't exist yet — create it with streaming content
      return {
        filePanelFiles: {
          ...state.filePanelFiles,
          [agentName]: {
            content: '',
            streamingContent: delta,
            compileStatus: 'compiling',
          },
        },
      };
    }),
  updateFileStatus: (name, status, warnings) =>
    set((state) => {
      const existing = state.filePanelFiles[name];
      if (!existing) return state;
      return {
        filePanelFiles: {
          ...state.filePanelFiles,
          [name]: { ...existing, compileStatus: status, compileWarnings: warnings },
        },
      };
    }),
  removeFile: (name) =>
    set((state) => {
      const { [name]: _, ...rest } = state.filePanelFiles;
      return { filePanelFiles: rest };
    }),
  selectFile: (name) => set({ filePanelSelectedFile: name }),

  addJournalEntry: (entry) =>
    set((state) => {
      const entries = [...state.journalEntries, entry];
      return {
        journalEntries:
          entries.length > MAX_JOURNAL_ENTRIES ? entries.slice(-MAX_JOURNAL_ENTRIES) : entries,
      };
    }),

  openOverlay: () => set({ overlayState: 'chat' as OverlayState }),
  closeOverlay: () =>
    set({
      overlayState: 'closed' as OverlayState,
      artifactTabs: [],
      activeTabId: null,
      journalEntries: [],
      specDocument: null,
      specDocumentVersion: 0,
    }),
  setOverlayState: (overlayState) => set({ overlayState }),

  setPreserveSession: (preserve) => set({ preserveSession: preserve }),
  setPreservedMessages: (messages) => set({ preservedMessages: messages }),

  setBuildStage: (agent, stage, status) =>
    set((state) => {
      const existing = state.buildStages[agent] ?? {
        gen: 'pending' as StageStatus,
        comp: 'pending' as StageStatus,
        enrich: 'pending' as StageStatus,
        done: 'pending' as StageStatus,
      };
      return {
        buildStages: {
          ...state.buildStages,
          [agent]: { ...existing, [stage]: status },
        },
      };
    }),

  clearBuildStages: () => set({ buildStages: {}, agentElapsed: {}, agentUsage: {} }),

  setAgentElapsed: (agent, ms) =>
    set((state) => ({
      agentElapsed: { ...state.agentElapsed, [agent]: ms },
    })),

  setAgentUsage: (agent, usage) =>
    set((state) => ({
      agentUsage: { ...state.agentUsage, [agent]: usage },
    })),

  setSpecDocument: (doc) =>
    set({ specDocument: doc, specDocumentVersion: (doc?.version as number) ?? 0 }),
  updateSpecDocument: (path, value, version) =>
    set((state) => {
      const doc = state.specDocument;
      if (!doc) return state;
      const updated = { ...doc };
      const parts = path.split('.');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let current: any = updated;
      for (let i = 0; i < parts.length - 1; i++) {
        const node = current[parts[i]];
        current[parts[i]] = Array.isArray(node) ? [...node] : { ...node };
        current = current[parts[i]];
      }
      current[parts[parts.length - 1]] = value;
      return { specDocument: updated, specDocumentVersion: version };
    }),
  setSpecDocumentVersion: (version) => set({ specDocumentVersion: version }),

  setBuildPhase: (phase) =>
    set((state) => ({
      buildState: { ...state.buildState, phase },
    })),

  setBuildState: (buildState) =>
    set(() => ({
      buildState,
    })),

  setBuildAgentStatus: (agent, status, data) =>
    set((state) => ({
      buildState: {
        ...state.buildState,
        agents: {
          ...state.buildState.agents,
          [agent]: {
            status,
            errors: data?.errors ?? state.buildState.agents[agent]?.errors ?? [],
            warnings: data?.warnings ?? state.buildState.agents[agent]?.warnings ?? [],
            toolCount: data?.toolCount ?? state.buildState.agents[agent]?.toolCount ?? 0,
            handoffCount: data?.handoffCount ?? state.buildState.agents[agent]?.handoffCount ?? 0,
            elapsed: data?.elapsed ?? state.buildState.agents[agent]?.elapsed,
            fixRounds: data?.fixRounds ?? state.buildState.agents[agent]?.fixRounds,
          },
        },
      },
    })),

  setBuildReconciled: (agents, summary) =>
    set((state) => {
      const updated = { ...state.buildState.agents };
      for (const [name, data] of Object.entries(agents)) {
        updated[name] = {
          ...updated[name],
          status: data.status,
          errors: data.errors,
          warnings: data.warnings,
          toolCount: updated[name]?.toolCount ?? 0,
          handoffCount: updated[name]?.handoffCount ?? 0,
        };
      }
      return {
        buildState: { ...state.buildState, phase: 'complete', agents: updated, summary },
      };
    }),

  appendBuildLog: (entry) =>
    set((state) => {
      const nextEntry: BuildLogEntry = {
        timestamp: entry.timestamp ?? new Date().toISOString(),
        eventType: entry.eventType,
        agent: entry.agent,
        stage: entry.stage,
        message: entry.message,
        data: entry.data,
      };
      const log = [...state.buildState.log, nextEntry];
      return {
        buildState: {
          ...state.buildState,
          log: log.length > MAX_BUILD_LOG_ENTRIES ? log.slice(-MAX_BUILD_LOG_ENTRIES) : log,
        },
      };
    }),

  clearBuildLog: () => set((state) => ({ buildState: { ...state.buildState, log: [] } })),

  resetBuildState: () => set({ buildState: { phase: 'idle', agents: {}, summary: null, log: [] } }),

  clearProjectWorkspace: () =>
    set((state) => ({
      showArtifactPanel: false,
      activeArtifactTab: 'topology',
      artifactVersions: {
        topology: [],
        agents: [],
      },
      artifactTabs: [],
      activeTabId: null,
      journalEntries: [],
      filePanelVisible: false,
      filePanelFiles: {},
      filePanelSelectedFile: null,
      buildStages: {},
      agentElapsed: {},
      agentUsage: {},
      approvedAgents: [],
      currentReviewAgent: null,
      buildState: { phase: 'idle', agents: {}, summary: null, log: [] },
      specDocument: null,
      specDocumentVersion: 0,
      overlayState: state.overlayState === 'closed' ? ('closed' as OverlayState) : 'chat',
    })),

  resetProjectState: () =>
    set({
      artifactTabs: [],
      activeTabId: null,
      journalEntries: [],
      filePanelVisible: false,
      filePanelFiles: {},
      filePanelSelectedFile: null,
      buildStages: {},
      agentElapsed: {},
      agentUsage: {},
      approvedAgents: [],
      currentReviewAgent: null,
      buildState: { phase: 'idle', agents: {}, summary: null, log: [] },
      specDocument: null,
      specDocumentVersion: 0,
      overlayState: 'closed' as OverlayState,
    }),
  reset: () => set(initialState),
}));

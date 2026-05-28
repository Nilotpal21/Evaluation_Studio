/**
 * Tool Store
 *
 * Manages tool state with Zustand for the unified tool system.
 */

import { create } from 'zustand';

// =============================================================================
// TYPES — flat IProjectTool shape (no Tool+Version model)
// =============================================================================

/** Tool type discriminator */
export type ToolType = 'http' | 'sandbox' | 'mcp' | 'searchai' | 'workflow';

/** Flat project tool as returned by the API (single-document model) */
export interface ToolWithVersion {
  id: string;
  name: string;
  slug: string;
  toolType: ToolType;
  description: string | null;
  dslContent: string;
  sourceHash: string;
  runtimeMetadataHash?: string;
  variableNamespaceIds: string[];
  projectId: string;
  createdBy: string;
  lastEditedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ToolListResponse {
  success: boolean;
  data: ToolWithVersion[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    hasMore: boolean;
  };
}

export interface ToolDetailResponse {
  success: boolean;
  tool: ToolWithVersion;
}

export interface ToolTestResult {
  output: unknown;
  latencyMs: number;
  logs?: string[];
  error?: string;
  errorCode?: string;
  retryable?: boolean;
  /** True when the tool executed but received a non-2xx HTTP response */
  httpError?: boolean;
  oauthReauth?: {
    authProfileId: string;
    profileName: string;
    connectorName: string;
    scope: 'project' | 'workspace';
  };
  /** Input parameters provided for this test execution */
  params?: Record<string, unknown>;
  // HTTP tool inspection (optional)
  request?: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
  };
  response?: {
    status: number;
    statusText?: string;
    headers?: Record<string, string>;
    body?: unknown;
  };
  // Sandbox tool inspection (optional)
  sandbox?: {
    runtime: string;
    timeoutMs: number;
    memoryMb: number;
  };
  /** SOAP debug envelope preview (when ?debug=true) */
  renderedRequest?: {
    body: string;
    headers?: Record<string, string>;
  };
  // MCP tool inspection (optional)
  mcp?: {
    server: string;
    tool: string;
    transport?: string;
  };
}

// =============================================================================
// STORE
// =============================================================================

interface ToolState {
  tools: ToolWithVersion[];
  currentTool: ToolWithVersion | null;
  isLoading: boolean;
  error: string | string[] | null;
  pagination: { page: number; limit: number; total: number; hasMore: boolean };

  // Filters
  searchQuery: string;
  filterType: ToolType | null;

  // Computed counts per type
  httpCount: number;
  sandboxCount: number;
  mcpCount: number;
  searchaiCount: number;
  workflowCount: number;

  // Actions
  setTools: (tools: ToolWithVersion[], pagination: ToolState['pagination']) => void;
  setCurrentTool: (tool: ToolWithVersion | null) => void;
  addTool: (tool: ToolWithVersion) => void;
  updateToolInList: (id: string, updates: Partial<ToolWithVersion>) => void;
  removeTool: (id: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | string[] | null) => void;
  setSearchQuery: (query: string) => void;
  setFilterType: (type: ToolType | null) => void;
}

function computeTypeCounts(tools: ToolWithVersion[]): {
  httpCount: number;
  sandboxCount: number;
  mcpCount: number;
  searchaiCount: number;
  workflowCount: number;
} {
  return tools.reduce(
    (acc, t) => {
      if (t.toolType === 'http') acc.httpCount++;
      else if (t.toolType === 'sandbox') acc.sandboxCount++;
      else if (t.toolType === 'mcp') acc.mcpCount++;
      else if (t.toolType === 'searchai') acc.searchaiCount++;
      else if (t.toolType === 'workflow') acc.workflowCount++;
      return acc;
    },
    { httpCount: 0, sandboxCount: 0, mcpCount: 0, searchaiCount: 0, workflowCount: 0 },
  );
}

export const useToolStore = create<ToolState>((set) => ({
  tools: [],
  currentTool: null,
  isLoading: false,
  error: null,
  pagination: { page: 1, limit: 50, total: 0, hasMore: false },
  searchQuery: '',
  filterType: null,
  httpCount: 0,
  sandboxCount: 0,
  mcpCount: 0,
  searchaiCount: 0,
  workflowCount: 0,

  setTools: (tools, pagination) => {
    set({ tools, pagination, ...computeTypeCounts(tools) });
  },

  setCurrentTool: (tool) => set({ currentTool: tool }),

  addTool: (tool) =>
    set((state) => {
      const tools = [tool, ...state.tools];
      return {
        tools,
        pagination: { ...state.pagination, total: state.pagination.total + 1 },
        ...computeTypeCounts(tools),
      };
    }),

  updateToolInList: (id, updates) =>
    set((state) => ({
      tools: state.tools.map((t) => (t.id === id ? { ...t, ...updates } : t)),
      currentTool:
        state.currentTool?.id === id ? { ...state.currentTool, ...updates } : state.currentTool,
    })),

  removeTool: (id) =>
    set((state) => {
      const tools = state.tools.filter((t) => t.id !== id);
      return {
        tools,
        currentTool: state.currentTool?.id === id ? null : state.currentTool,
        pagination: { ...state.pagination, total: Math.max(0, state.pagination.total - 1) },
        ...computeTypeCounts(tools),
      };
    }),

  setLoading: (isLoading) => set({ isLoading }),

  setError: (error) => set({ error }),

  setSearchQuery: (searchQuery) => set({ searchQuery }),

  setFilterType: (filterType) => set({ filterType }),
}));

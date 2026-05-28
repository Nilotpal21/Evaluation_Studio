/**
 * MCP Server Store
 *
 * Manages MCP server state and tool discovery flow.
 */

import { create } from 'zustand';
import type {
  McpServer,
  DiscoveredToolPreview,
  TestConnectionResult,
  ServerTool,
} from '../api/mcp-servers';

export type { McpServer, DiscoveredToolPreview, TestConnectionResult, ServerTool };

interface McpServerState {
  servers: McpServer[];
  currentServer: McpServer | null;
  isLoading: boolean;
  error: string | string[] | null;

  // Server tools (already imported)
  serverTools: ServerTool[];

  // Discovery state
  discoveredTools: DiscoveredToolPreview[];
  selectedToolNames: string[];
  isDiscovering: boolean;
  isImporting: boolean;

  // Test connection state
  testResult: TestConnectionResult | null;
  isTesting: boolean;

  // Actions
  setServers: (servers: McpServer[]) => void;
  setCurrentServer: (server: McpServer | null) => void;
  addServer: (server: McpServer) => void;
  updateServerInList: (id: string, updates: Partial<McpServer>) => void;
  removeServer: (id: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | string[] | null) => void;

  setServerTools: (tools: ServerTool[]) => void;

  setDiscoveredTools: (tools: DiscoveredToolPreview[]) => void;
  toggleToolSelection: (name: string) => void;
  selectAllTools: () => void;
  deselectAllTools: () => void;
  setDiscovering: (discovering: boolean) => void;
  setImporting: (importing: boolean) => void;

  setTestResult: (result: TestConnectionResult | null) => void;
  setTesting: (testing: boolean) => void;

  resetDiscovery: () => void;
}

export const useMcpServerStore = create<McpServerState>((set, get) => ({
  servers: [],
  currentServer: null,
  isLoading: false,
  error: null,

  serverTools: [],

  discoveredTools: [],
  selectedToolNames: [],
  isDiscovering: false,
  isImporting: false,

  testResult: null,
  isTesting: false,

  setServers: (servers) => set({ servers }),

  setCurrentServer: (currentServer) => set({ currentServer }),

  addServer: (server) => set((state) => ({ servers: [server, ...state.servers] })),

  updateServerInList: (id, updates) =>
    set((state) => ({
      servers: state.servers.map((s) => (s.id === id ? { ...s, ...updates } : s)),
      currentServer:
        state.currentServer?.id === id
          ? { ...state.currentServer, ...updates }
          : state.currentServer,
    })),

  removeServer: (id) =>
    set((state) => ({
      servers: state.servers.filter((s) => s.id !== id),
      currentServer: state.currentServer?.id === id ? null : state.currentServer,
    })),

  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),

  setServerTools: (serverTools) => set({ serverTools }),

  setDiscoveredTools: (discoveredTools) => {
    set({ discoveredTools, selectedToolNames: discoveredTools.map((t) => t.name) });
  },

  toggleToolSelection: (name) =>
    set((state) => {
      const selected = state.selectedToolNames;
      return {
        selectedToolNames: selected.includes(name)
          ? selected.filter((n) => n !== name)
          : [...selected, name],
      };
    }),

  selectAllTools: () =>
    set((state) => ({
      selectedToolNames: state.discoveredTools.map((t) => t.name),
    })),

  deselectAllTools: () => set({ selectedToolNames: [] }),

  setDiscovering: (isDiscovering) => set({ isDiscovering }),
  setImporting: (isImporting) => set({ isImporting }),

  setTestResult: (testResult) => set({ testResult }),
  setTesting: (isTesting) => set({ isTesting }),

  resetDiscovery: () =>
    set({
      discoveredTools: [],
      selectedToolNames: [],
      isDiscovering: false,
      isImporting: false,
    }),
}));

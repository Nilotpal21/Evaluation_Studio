/**
 * Connector Store
 *
 * Client-side state for connector panel navigation, view preferences,
 * and expand state. localStorage persistence for simplifiedView toggle.
 *
 * Advisory: Use atomic selectors to avoid unnecessary re-renders.
 * Good:  const panelOpen = useConnectorStore(s => s.panelOpen);
 * Bad:   const { panelOpen, activeTab } = useConnectorStore(s => ({ panelOpen: s.panelOpen, activeTab: s.activeTab }));
 * If you need multiple fields, use useShallow() from zustand/react/shallow.
 */

import { create } from 'zustand';

export type ConnectorTab =
  | 'connect'
  | 'proposal'
  | 'scope-filters'
  | 'field-mapping'
  | 'preview'
  | 'security'
  | 'history'
  | 'overview';

interface ConnectorStoreState {
  // Panel state
  panelOpen: boolean;
  activeConnectorId: string | null;
  activeTab: ConnectorTab;
  isNewConnector: boolean;

  // View preferences (simplifiedView persisted to localStorage)
  simplifiedView: boolean;
  expandedPanel: boolean;

  // Actions
  openPanel: (connectorId: string, options?: { isNew?: boolean; tab?: ConnectorTab }) => void;
  closePanel: () => void;
  setActiveTab: (tab: ConnectorTab) => void;
  setSimplifiedView: (enabled: boolean) => void;
  setExpandedPanel: (expanded: boolean) => void;
  resetStore: () => void;
}

const SIMPLIFIED_VIEW_KEY = 'sp-simplified-view';

function getPersistedSimplifiedView(): boolean {
  if (typeof window === 'undefined') return true; // Default ON for SSR
  const stored = localStorage.getItem(SIMPLIFIED_VIEW_KEY);
  return stored === null ? true : stored === 'true'; // Absence = first-time = ON
}

export const useConnectorStore = create<ConnectorStoreState>((set) => ({
  panelOpen: false,
  activeConnectorId: null,
  activeTab: 'connect',
  isNewConnector: false,
  simplifiedView: getPersistedSimplifiedView(),
  expandedPanel: false,

  openPanel: (connectorId, options) =>
    set({
      panelOpen: true,
      activeConnectorId: connectorId,
      activeTab: options?.tab ?? 'connect',
      isNewConnector: options?.isNew ?? false,
      expandedPanel: false, // Reset on open
    }),

  closePanel: () =>
    set({
      panelOpen: false,
      activeConnectorId: null,
      activeTab: 'connect',
      isNewConnector: false,
      expandedPanel: false,
    }),

  setActiveTab: (tab) => set({ activeTab: tab }),

  setSimplifiedView: (enabled) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(SIMPLIFIED_VIEW_KEY, String(enabled));
    }
    set({ simplifiedView: enabled });
  },

  setExpandedPanel: (expanded) => set({ expandedPanel: expanded }),

  resetStore: () =>
    set({
      panelOpen: false,
      activeConnectorId: null,
      activeTab: 'connect',
      isNewConnector: false,
      simplifiedView: getPersistedSimplifiedView(),
      expandedPanel: false,
    }),
}));

/**
 * Tests for connector-store — panel state, tab management, simplified view persistence.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { useConnectorStore } from '../../store/connector-store';

// The store guards localStorage access with `typeof window !== 'undefined'`.
// In Node test environment window is undefined, so define it so the store's
// browser-detection check passes (setup-light.ts already provides a mock
// localStorage on globalThis).
const hadWindow = 'window' in globalThis;
const previousWindow = (globalThis as Record<string, unknown>).window;
(globalThis as Record<string, unknown>).window = globalThis;

describe('useConnectorStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useConnectorStore.getState().resetStore();
  });

  afterAll(() => {
    // Restore original window state
    if (hadWindow) {
      (globalThis as Record<string, unknown>).window = previousWindow;
    } else {
      delete (globalThis as Record<string, unknown>).window;
    }
  });

  // ─── Initial state ───────────────────────────────────────────────────

  it('has correct initial state', () => {
    const state = useConnectorStore.getState();
    expect(state.panelOpen).toBe(false);
    expect(state.activeConnectorId).toBeNull();
    expect(state.activeTab).toBe('connect');
    expect(state.isNewConnector).toBe(false);
    expect(state.simplifiedView).toBe(true); // default ON
    expect(state.expandedPanel).toBe(false);
  });

  // ─── openPanel ───────────────────────────────────────────────────────

  it('openPanel sets panelOpen, activeConnectorId, and defaults', () => {
    useConnectorStore.getState().openPanel('conn-123');

    const state = useConnectorStore.getState();
    expect(state.panelOpen).toBe(true);
    expect(state.activeConnectorId).toBe('conn-123');
    expect(state.activeTab).toBe('connect');
    expect(state.isNewConnector).toBe(false);
    expect(state.expandedPanel).toBe(false);
  });

  it('openPanel accepts options for tab and isNew', () => {
    useConnectorStore.getState().openPanel('conn-456', { isNew: true, tab: 'overview' });

    const state = useConnectorStore.getState();
    expect(state.panelOpen).toBe(true);
    expect(state.activeConnectorId).toBe('conn-456');
    expect(state.activeTab).toBe('overview');
    expect(state.isNewConnector).toBe(true);
  });

  it('openPanel resets expandedPanel even if it was true', () => {
    useConnectorStore.getState().setExpandedPanel(true);
    expect(useConnectorStore.getState().expandedPanel).toBe(true);

    useConnectorStore.getState().openPanel('conn-789');
    expect(useConnectorStore.getState().expandedPanel).toBe(false);
  });

  // ─── closePanel ──────────────────────────────────────────────────────

  it('closePanel resets all panel state', () => {
    useConnectorStore.getState().openPanel('conn-123', { isNew: true, tab: 'overview' });
    useConnectorStore.getState().setExpandedPanel(true);

    useConnectorStore.getState().closePanel();

    const state = useConnectorStore.getState();
    expect(state.panelOpen).toBe(false);
    expect(state.activeConnectorId).toBeNull();
    expect(state.activeTab).toBe('connect');
    expect(state.isNewConnector).toBe(false);
    expect(state.expandedPanel).toBe(false);
  });

  // ─── setActiveTab ────────────────────────────────────────────────────

  it('setActiveTab updates the active tab', () => {
    useConnectorStore.getState().setActiveTab('scope-filters');
    expect(useConnectorStore.getState().activeTab).toBe('scope-filters');

    useConnectorStore.getState().setActiveTab('security');
    expect(useConnectorStore.getState().activeTab).toBe('security');
  });

  it('setActiveTab does not affect other state', () => {
    useConnectorStore.getState().openPanel('conn-123');
    useConnectorStore.getState().setActiveTab('preview');

    const state = useConnectorStore.getState();
    expect(state.panelOpen).toBe(true);
    expect(state.activeConnectorId).toBe('conn-123');
    expect(state.activeTab).toBe('preview');
  });

  // ─── simplifiedView ─────────────────────────────────────────────────

  it('simplifiedView defaults to ON (true)', () => {
    expect(useConnectorStore.getState().simplifiedView).toBe(true);
  });

  it('setSimplifiedView persists to localStorage', () => {
    useConnectorStore.getState().setSimplifiedView(false);
    expect(useConnectorStore.getState().simplifiedView).toBe(false);
    expect(localStorage.getItem('sp-simplified-view')).toBe('false');

    useConnectorStore.getState().setSimplifiedView(true);
    expect(useConnectorStore.getState().simplifiedView).toBe(true);
    expect(localStorage.getItem('sp-simplified-view')).toBe('true');
  });

  it('simplifiedView reads from localStorage on reset', () => {
    localStorage.setItem('sp-simplified-view', 'false');
    useConnectorStore.getState().resetStore();

    expect(useConnectorStore.getState().simplifiedView).toBe(false);
  });

  // ─── setExpandedPanel ────────────────────────────────────────────────

  it('setExpandedPanel updates expand state', () => {
    useConnectorStore.getState().setExpandedPanel(true);
    expect(useConnectorStore.getState().expandedPanel).toBe(true);

    useConnectorStore.getState().setExpandedPanel(false);
    expect(useConnectorStore.getState().expandedPanel).toBe(false);
  });

  // ─── resetStore ──────────────────────────────────────────────────────

  it('resetStore restores all defaults', () => {
    const store = useConnectorStore.getState();
    store.openPanel('conn-123', { isNew: true, tab: 'overview' });
    store.setExpandedPanel(true);
    store.setSimplifiedView(false);

    store.resetStore();

    const state = useConnectorStore.getState();
    expect(state.panelOpen).toBe(false);
    expect(state.activeConnectorId).toBeNull();
    expect(state.activeTab).toBe('connect');
    expect(state.isNewConnector).toBe(false);
    // simplifiedView reads from localStorage which was set to 'false'
    expect(state.simplifiedView).toBe(false);
    expect(state.expandedPanel).toBe(false);
  });
});

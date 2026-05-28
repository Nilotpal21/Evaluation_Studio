import { describe, test, expect, beforeEach } from 'vitest';
import { useArchAIStore, type ArtifactTab } from '../lib/arch-ai/store/arch-ai-store';

describe('Dynamic artifact tabs', () => {
  beforeEach(() => {
    useArchAIStore.getState().reset();
  });

  test('initial state has no tabs', () => {
    const state = useArchAIStore.getState();
    expect(state.artifactTabs).toEqual([]);
    expect(state.activeTabId).toBeNull();
  });

  test('addTab creates first tab and shows panel', () => {
    useArchAIStore.getState().addTab({
      type: 'agent_code',
      label: 'Booking_Agent',
      data: { ablContent: 'AGENT: Booking' },
      toolCallId: 'tc-1',
    });

    const state = useArchAIStore.getState();
    expect(state.artifactTabs).toHaveLength(1);
    expect(state.artifactTabs[0].type).toBe('agent_code');
    expect(state.artifactTabs[0].label).toBe('Booking_Agent');
    expect(state.artifactTabs[0].version).toBe(1);
    expect(state.activeTabId).toBe(state.artifactTabs[0].id);
    expect(state.showArtifactPanel).toBe(true);
  });

  test('multiple tabs render in order', () => {
    const { addTab } = useArchAIStore.getState();
    addTab({ type: 'agent_code', label: 'Agent A', data: {}, toolCallId: 'tc-1' });
    addTab({ type: 'diff', label: 'Diff', data: {}, toolCallId: 'tc-2' });
    addTab({ type: 'summary', label: 'Summary', data: {}, toolCallId: 'tc-3' });

    const { artifactTabs } = useArchAIStore.getState();
    expect(artifactTabs).toHaveLength(3);
    expect(artifactTabs.map((t) => t.label)).toEqual(['Agent A', 'Diff', 'Summary']);
  });

  test('setActiveTab changes the active tab', () => {
    const { addTab } = useArchAIStore.getState();
    addTab({ type: 'agent_code', label: 'A', data: {}, toolCallId: 'tc-1' });
    addTab({ type: 'diff', label: 'B', data: {}, toolCallId: 'tc-2' });

    const tabs = useArchAIStore.getState().artifactTabs;
    useArchAIStore.getState().setActiveTab(tabs[0].id);

    expect(useArchAIStore.getState().activeTabId).toBe(tabs[0].id);
  });

  test('removeTab removes a tab', () => {
    const { addTab } = useArchAIStore.getState();
    addTab({ type: 'agent_code', label: 'A', data: {}, toolCallId: 'tc-1' });
    addTab({ type: 'diff', label: 'B', data: {}, toolCallId: 'tc-2' });

    const tabs = useArchAIStore.getState().artifactTabs;
    useArchAIStore.getState().removeTab(tabs[0].id);

    const state = useArchAIStore.getState();
    expect(state.artifactTabs).toHaveLength(1);
    expect(state.artifactTabs[0].label).toBe('B');
  });

  test('removing last tab hides panel', () => {
    const { addTab } = useArchAIStore.getState();
    addTab({ type: 'agent_code', label: 'Only', data: {}, toolCallId: 'tc-1' });

    const tabs = useArchAIStore.getState().artifactTabs;
    useArchAIStore.getState().removeTab(tabs[0].id);

    const state = useArchAIStore.getState();
    expect(state.artifactTabs).toHaveLength(0);
    expect(state.activeTabId).toBeNull();
    expect(state.showArtifactPanel).toBe(false);
  });

  test('evicts the oldest agent tab when capacity is exceeded', () => {
    const { addTab } = useArchAIStore.getState();
    for (let i = 0; i < 18; i++) {
      addTab({ type: 'agent_code', label: `Tab ${i}`, data: {}, toolCallId: `tc-${i}` });
    }

    const state = useArchAIStore.getState();
    expect(state.artifactTabs.length).toBeLessThan(18);
    expect(state.artifactTabs.map((tab) => tab.label)).not.toContain('Tab 0');
    expect(state.artifactTabs.map((tab) => tab.label)).toContain('Tab 17');
  });

  test('updateTab increments version on existing tab', () => {
    const { addTab } = useArchAIStore.getState();
    addTab({ type: 'agent_code', label: 'Agent', data: { v: 1 }, toolCallId: 'tc-1' });

    const tabId = useArchAIStore.getState().artifactTabs[0].id;
    useArchAIStore.getState().updateTab(tabId, { v: 2 });

    const tab = useArchAIStore.getState().artifactTabs[0];
    expect(tab.version).toBe(2);
    expect(tab.data).toEqual({ v: 2 });
  });

  test('retains non-agent tabs such as Search AI when capacity is exceeded', () => {
    const { addTab } = useArchAIStore.getState();
    addTab({
      type: 'search-ai',
      label: 'Search AI',
      data: { entries: [] },
      toolCallId: 'search-1',
    });

    for (let i = 0; i < 20; i += 1) {
      addTab({ type: 'agent_code', label: `Agent ${i}`, data: {}, toolCallId: `tc-${i}` });
    }

    const state = useArchAIStore.getState();
    expect(state.artifactTabs.some((tab) => tab.type === 'search-ai')).toBe(true);
  });
});

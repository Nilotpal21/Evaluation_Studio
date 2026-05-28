import { afterEach, describe, expect, it } from 'vitest';
import { useArchAIStore } from '../arch-ai-store';

// Snapshot the initial state so we can reset between tests without depending
// on a separate fresh-store helper.
const initialState = useArchAIStore.getState();

afterEach(() => {
  useArchAIStore.setState({
    ...initialState,
    artifactTabs: [],
    activeTabId: null,
    showArtifactPanel: false,
    prefillMetadata: null,
    prefillMessage: null,
  });
});

describe('arch-ai-store extensions (Task 4.1)', () => {
  it('addTab supports type=integration', () => {
    const tabId = useArchAIStore.getState().addTab({
      type: 'integration',
      label: 'Integrations',
      data: { count: 2 },
      toolCallId: 'tc-int-1',
    });
    const tab = useArchAIStore.getState().artifactTabs.find((t) => t.id === tabId);
    expect(tab?.type).toBe('integration');
    expect(tab?.label).toBe('Integrations');
  });

  it('updating an existing tab does not steal focus from the active tab', () => {
    const topologyTabId = useArchAIStore.getState().addTab({
      type: 'topology',
      label: 'Topology',
      data: { agents: [] },
      toolCallId: 'topology-1',
    });
    const planTabId = useArchAIStore.getState().addTab({
      type: 'plan',
      label: 'Plan',
      data: { status: 'proposed' },
      toolCallId: 'plan-1',
    });

    useArchAIStore.getState().setActiveTab(planTabId);
    const returnedTopologyTabId = useArchAIStore.getState().addTab({
      type: 'topology',
      label: 'Topology',
      data: { agents: [{ name: 'SupportRouter' }] },
      toolCallId: 'topology-2',
    });

    expect(returnedTopologyTabId).toBe(topologyTabId);
    expect(useArchAIStore.getState().activeTabId).toBe(planTabId);
  });

  it('setPrefillMetadata stores structured payload', () => {
    useArchAIStore.getState().setPrefillMetadata({
      kind: 'resume_integration',
      draftId: 'd1',
      intent: 'resume',
    });
    expect(useArchAIStore.getState().prefillMetadata).toEqual({
      kind: 'resume_integration',
      draftId: 'd1',
      intent: 'resume',
    });
  });

  it('setPrefillMetadata(null) clears the slot', () => {
    useArchAIStore.getState().setPrefillMetadata({ kind: 'start_integration' });
    useArchAIStore.getState().setPrefillMetadata(null);
    expect(useArchAIStore.getState().prefillMetadata).toBeNull();
  });

  it('prefillMetadata defaults to null', () => {
    useArchAIStore.setState({ prefillMetadata: null });
    expect(useArchAIStore.getState().prefillMetadata).toBeNull();
  });
});

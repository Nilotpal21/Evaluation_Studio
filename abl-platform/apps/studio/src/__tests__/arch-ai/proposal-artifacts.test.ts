import { beforeEach, describe, expect, it } from 'vitest';
import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';
import {
  clearPendingDiffTabIfUnbacked,
  markDiffResolutionInFlight,
  restorePendingMutationDiffTab,
  syncDiffArtifact,
} from '@/lib/arch-ai/ui/proposal-artifacts';

describe('proposal artifact helpers', () => {
  beforeEach(() => {
    useArchAIStore.getState().reset();
  });

  it('rehydrates a diff tab from pendingMutation session metadata', () => {
    const impact = {
      runtimeReady: true,
      impactedAgents: ['LeadIntake', 'DemoScheduler'],
      nextActions: ['Run run_test against LeadIntake.'],
    };
    const restored = restorePendingMutationDiffTab({
      target: 'LeadIntake',
      before: 'AGENT: LeadIntake\nGOAL: "Capture leads"',
      after: 'AGENT: LeadIntake\nGOAL: "Qualify leads quickly"',
      changeSummary: 'Tighten the goal language.',
      reviewStatus: 'pending',
      impact,
    });

    expect(restored).toBe(true);

    const diffTab = useArchAIStore.getState().artifactTabs.find((tab) => tab.type === 'diff');
    expect(diffTab?.label).toBe('Changes');
    expect(useArchAIStore.getState().overlayState).toBe('artifacts');
    expect(
      (diffTab?.data as { agentName?: string; reviewStatus?: string } | undefined)?.agentName,
    ).toBe('LeadIntake');
    expect(
      (
        diffTab?.data as
          | { agentName?: string; reviewStatus?: string; impact?: typeof impact }
          | undefined
      )?.reviewStatus,
    ).toBe('pending');
    expect(
      (
        diffTab?.data as
          | { agentName?: string; reviewStatus?: string; impact?: typeof impact }
          | undefined
      )?.impact,
    ).toEqual(impact);
  });

  it('clears only stale pending diff tabs when no backing mutation remains', () => {
    restorePendingMutationDiffTab({
      target: 'LeadIntake',
      before: 'AGENT: LeadIntake\nGOAL: "Capture leads"',
      after: 'AGENT: LeadIntake\nGOAL: "Qualify leads quickly"',
      reviewStatus: 'pending',
    });

    clearPendingDiffTabIfUnbacked();
    expect(useArchAIStore.getState().artifactTabs.some((tab) => tab.type === 'diff')).toBe(false);

    const tabId = useArchAIStore.getState().addTab({
      type: 'diff',
      label: 'Changes',
      toolCallId: 'proposal-1',
      data: {
        agentName: 'LeadIntake',
        changes: [],
        reviewStatus: 'applied',
      },
    });
    useArchAIStore.getState().setActiveTab(tabId);

    clearPendingDiffTabIfUnbacked();
    expect(useArchAIStore.getState().artifactTabs.some((tab) => tab.type === 'diff')).toBe(true);
  });

  it('preserves an in-flight resolving diff tab during snapshot cleanup', () => {
    restorePendingMutationDiffTab({
      target: 'LeadIntake',
      before: 'AGENT: LeadIntake\nGOAL: "Capture leads"',
      after: 'AGENT: LeadIntake\nGOAL: "Qualify leads quickly"',
      reviewStatus: 'pending',
    });

    markDiffResolutionInFlight('tool-accept-1');
    clearPendingDiffTabIfUnbacked();

    const diffTab = useArchAIStore.getState().artifactTabs.find((tab) => tab.type === 'diff');
    expect(diffTab).toBeDefined();
    expect(
      (
        diffTab?.data as
          | {
              reviewStatus?: string;
              clientResolution?: { state?: string; toolCallId?: string };
            }
          | undefined
      )?.reviewStatus,
    ).toBe('applying');
    expect(
      (
        diffTab?.data as
          | {
              reviewStatus?: string;
              clientResolution?: { state?: string; toolCallId?: string };
            }
          | undefined
      )?.clientResolution,
    ).toMatchObject({ state: 'in_flight', toolCallId: 'tool-accept-1' });
  });

  it('clears an expired in-flight resolving diff tab when no backing mutation remains', () => {
    restorePendingMutationDiffTab({
      target: 'LeadIntake',
      before: 'AGENT: LeadIntake\nGOAL: "Capture leads"',
      after: 'AGENT: LeadIntake\nGOAL: "Qualify leads quickly"',
      reviewStatus: 'pending',
    });

    markDiffResolutionInFlight('tool-accept-1');

    const diffTab = useArchAIStore.getState().artifactTabs.find((tab) => tab.type === 'diff');
    expect(diffTab).toBeDefined();
    if (diffTab) {
      useArchAIStore.getState().updateTab(diffTab.id, {
        ...(diffTab.data as Record<string, unknown>),
        clientResolution: {
          state: 'in_flight',
          startedAt: 1,
          expiresAt: 1,
          toolCallId: 'tool-accept-1',
        },
      });
    }

    clearPendingDiffTabIfUnbacked();
    expect(useArchAIStore.getState().artifactTabs.some((tab) => tab.type === 'diff')).toBe(false);
  });

  it('closes plan and changes tabs when a proposal is applied', () => {
    useArchAIStore.getState().addTab({
      type: 'plan',
      label: 'Plan',
      toolCallId: 'plan-1',
      data: {
        id: 'plan-1',
        status: 'approved',
        title: 'Add FeedbackAgent',
      },
    });
    useArchAIStore.getState().addTab({
      type: 'diff',
      label: 'Changes',
      toolCallId: 'proposal-1',
      data: {
        agentName: 'FeedbackAgent',
        changes: [],
        reviewStatus: 'applying',
      },
    });

    syncDiffArtifact(
      {
        diffId: 'proposal-1',
        status: 'applied',
        payload: {
          agentName: 'FeedbackAgent',
          changes: [
            {
              construct: 'FULL',
              before: 'AGENT: FeedbackAgent\nGOAL: "Old"',
              after: 'AGENT: FeedbackAgent\nGOAL: "New"',
              rationale: 'Apply the approved change.',
            },
          ],
          currentCode: 'AGENT: FeedbackAgent\nGOAL: "Old"',
          proposedCode: 'AGENT: FeedbackAgent\nGOAL: "New"',
          reviewStatus: 'applied',
        },
      },
      'event-apply-1',
    );

    const tabs = useArchAIStore.getState().artifactTabs;
    expect(tabs.some((tab) => tab.type === 'plan')).toBe(false);
    expect(tabs.some((tab) => tab.type === 'diff')).toBe(false);
    expect(useArchAIStore.getState().lastAgentEditTimestamp).not.toBeNull();
  });
});

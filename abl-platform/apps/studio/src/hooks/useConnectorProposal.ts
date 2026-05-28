/**
 * useConnectorProposal Hook
 *
 * SWR hook for connector proposal data with automatic polling
 * during generation (refreshInterval = 2000ms when status === 'generating').
 */

import { useMemo } from 'react';
import useSWR from 'swr';

export interface ProposalGenerationStep {
  id: string;
  label: string;
  status: 'pending' | 'in_progress' | 'done' | 'waiting' | 'failed';
  statusText: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ProposalSectionData {
  status: 'pending' | 'accepted' | 'modified' | 'skipped';
  data: Record<string, unknown>;
  reviewedAt?: string;
  reviewedBy?: string;
}

export interface ProposalDecision {
  timestamp: string;
  user: string;
  section: string;
  decision: string;
  detail?: string;
}

export interface ProposalState {
  _id: string;
  connectorId: string;
  tenantId: string;
  status: 'generating' | 'ready' | 'approved' | 'abandoned' | 'failed';
  generationSteps: ProposalGenerationStep[];
  sections: Record<string, ProposalSectionData>;
  decisions: ProposalDecision[];
  generatedAt?: string;
  approvedAt?: string;
  approvedBy?: string;
  createdAt: string;
  updatedAt: string;
}

const POLL_INTERVAL_GENERATING = 2000;

export interface UseConnectorProposalReturn {
  proposal: ProposalState | null;
  isLoading: boolean;
  error: string | null;
  mutate: () => void;
}

export function useConnectorProposal(
  indexId: string | null,
  connectorId: string | null,
  options?: { pollWhileGenerating?: boolean },
): UseConnectorProposalReturn {
  const key =
    indexId && connectorId
      ? `/api/search-ai/indexes/${indexId}/connectors/${connectorId}/proposal`
      : null;

  const pollWhileGenerating = options?.pollWhileGenerating ?? true;

  const {
    data: rawData,
    error,
    isLoading,
    mutate,
  } = useSWR<{ success: boolean; data: ProposalState }>(key, {
    revalidateOnFocus: true,
    revalidateOnMount: true,
    refreshInterval: (latestData: { success: boolean; data: ProposalState } | undefined) => {
      if (!pollWhileGenerating) return 0;
      // Poll while generating
      if (latestData?.data?.status === 'generating') return POLL_INTERVAL_GENERATING;
      // Also poll if proposal doesn't exist yet (may still be creating)
      if (!latestData?.data) return POLL_INTERVAL_GENERATING;
      return 0;
    },
  });

  const proposal = useMemo(() => rawData?.data ?? null, [rawData]);

  return {
    proposal,
    isLoading,
    error: error ? String(error) : null,
    mutate: () => {
      void mutate();
    },
  };
}

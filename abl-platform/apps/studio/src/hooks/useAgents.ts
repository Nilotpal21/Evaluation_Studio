/**
 * Agents Hook
 *
 * Fetches and manages agent list from the API.
 * Uses SWR for dedup, stale-while-revalidate, and background refresh.
 */

import { useMemo } from 'react';
import useSWR from 'swr';
import type { AgentInfo } from '../types';

interface AgentsByDomain {
  [domain: string]: AgentInfo[];
}

interface AgentsResponse {
  success: boolean;
  agents: AgentsByDomain;
  domains: string[];
}

interface UseAgentsReturn {
  agents: AgentsByDomain;
  domains: string[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useAgents(): UseAgentsReturn {
  const { data, error, isLoading, mutate } = useSWR<AgentsResponse>('/api/agents');

  const agents = useMemo(() => data?.agents ?? {}, [data]);
  const domains = useMemo(() => data?.domains ?? [], [data]);

  return {
    agents,
    domains,
    isLoading,
    error: error ? String(error) : null,
    refresh: () => mutate(),
  };
}

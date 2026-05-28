/**
 * useAgentTransferSettings Hook
 *
 * Fetches and manages agent transfer settings for the current project.
 * Uses SWR for dedup, stale-while-revalidate, and background refresh.
 */

'use client';

import useSWR from 'swr';
import {
  getAgentTransferSettings,
  updateAgentTransferSettings,
  type AgentTransferSettings,
  type AgentTransferSettingsWritePayload,
  DEFAULT_AGENT_TRANSFER_SETTINGS,
} from '../api/agent-transfer';
import { useNavigationStore } from '../store/navigation-store';

/** Convert TTL values from backend seconds to UI minutes */
function backendToUI(settings: AgentTransferSettings): AgentTransferSettings {
  const ttl = settings.session.ttl;
  return {
    ...settings,
    session: {
      ...settings.session,
      ttl: {
        chat: ttl.chat / 60,
        email: ttl.email / 60,
        voice: ttl.voice / 60,
        messaging: ttl.messaging / 60,
        campaign: ttl.campaign / 60,
      },
    },
  };
}

/** Convert TTL values from UI minutes to backend seconds */
function uiToBackend(settings: AgentTransferSettings): AgentTransferSettings {
  const ttl = settings.session.ttl;
  return {
    ...settings,
    session: {
      ...settings.session,
      ttl: {
        chat: ttl.chat * 60,
        email: ttl.email * 60,
        voice: ttl.voice * 60,
        messaging: ttl.messaging * 60,
        campaign: ttl.campaign * 60,
      },
    },
  };
}

function stripLifecycleOwnedTtl(
  settings: AgentTransferSettings,
): AgentTransferSettingsWritePayload {
  return {
    ...settings,
    session: {
      maxConcurrentPerContact: settings.session.maxConcurrentPerContact,
    },
  };
}

export function useAgentTransferSettings() {
  const { projectId } = useNavigationStore();

  const { data, error, isLoading, mutate } = useSWR(
    projectId ? ['agent-transfer-settings', projectId] : null,
    async () => {
      const raw = await getAgentTransferSettings(projectId!);
      return backendToUI(raw);
    },
    { keepPreviousData: true },
  );

  const save = async (settings: AgentTransferSettings) => {
    await updateAgentTransferSettings(projectId!, stripLifecycleOwnedTtl(uiToBackend(settings)));
    await mutate();
  };

  return {
    settings: data ?? DEFAULT_AGENT_TRANSFER_SETTINGS,
    isLoading,
    error: error ? String(error) : null,
    save,
    refresh: () => mutate(),
  };
}

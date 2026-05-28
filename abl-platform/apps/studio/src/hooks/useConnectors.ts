/**
 * useConnectors Hooks
 *
 * SWR hooks for channel connections and SDK channels management.
 * Both are tenant-scoped resources.
 */

import useSWR from 'swr';
import { useAuthStore } from '../store/auth-store';
import { apiFetch } from '../lib/api-client';
import type { DeleteConnectionResponse } from '../api/channel-connections';

// =============================================================================
// TYPES
// =============================================================================

export interface ChannelConnection {
  id: string;
  name: string;
  type: string;
  status: 'active' | 'inactive' | 'error';
  config: Record<string, unknown>;
  projectId?: string;
  lastActiveAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelConnectionsResponse {
  success: boolean;
  data: ChannelConnection[];
}

export interface DeleteChannelConnectionResponse {
  success: boolean;
  outcome: DeleteConnectionResponse['outcome'];
}

export interface CreateChannelConnectionInput {
  name: string;
  type: string;
  config: Record<string, unknown>;
  projectId?: string;
}

export interface SDKChannel {
  id: string;
  name: string;
  apiKey: string | null;
  projectId: string;
  environment: string | null;
  enabled: boolean;
  rateLimitRpm?: number;
  allowedOrigins?: string[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface SDKChannelsResponse {
  success: boolean;
  data: SDKChannel[];
}

export interface UpdateChannelConnectionInput {
  name?: string;
  config?: Record<string, unknown>;
}

export interface CreateSDKChannelInput {
  name: string;
  projectId: string;
  environment?: string | null;
  enabled?: boolean;
  rateLimitRpm?: number | null;
  allowedOrigins?: string[] | null;
}

export interface UpdateSDKChannelInput {
  name?: string;
  environment?: string | null;
  enabled?: boolean;
  rateLimitRpm?: number | null;
  allowedOrigins?: string[] | null;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const SWR_OPTIONS = {
  refreshInterval: 30_000,
  keepPreviousData: true,
};

// =============================================================================
// CHANNEL CONNECTIONS HOOK
// =============================================================================

export function useChannelConnections() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const key = isAuthenticated ? '/api/admin/channel-connections' : null;

  const { data, error, isLoading, mutate } = useSWR<ChannelConnectionsResponse>(key, SWR_OPTIONS);

  const createConnection = async (input: CreateChannelConnectionInput): Promise<void> => {
    const res = await apiFetch('/api/admin/channel-connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { error?: string }).error || 'Failed to create channel connection');
    }
    await mutate();
  };

  const updateConnection = async (
    connectionId: string,
    input: UpdateChannelConnectionInput,
  ): Promise<void> => {
    const res = await apiFetch(
      `/api/admin/channel-connections?connectionId=${encodeURIComponent(connectionId)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { error?: string }).error || 'Failed to update channel connection');
    }
    await mutate();
  };

  const deleteConnection = async (
    connectionId: string,
  ): Promise<DeleteChannelConnectionResponse> => {
    const res = await apiFetch(
      `/api/admin/channel-connections?connectionId=${encodeURIComponent(connectionId)}`,
      { method: 'DELETE' },
    );
    const data = (await res.json().catch(() => ({}))) as Partial<
      DeleteConnectionResponse & { error?: string }
    >;
    if (!res.ok) {
      throw new Error(data.error || 'Failed to delete channel connection');
    }
    await mutate();
    return {
      success: data.success ?? true,
      outcome: data.outcome ?? 'deleted',
    };
  };

  return {
    connections: data?.data ?? [],
    isLoading,
    error: error ? String(error) : null,
    mutate,
    createConnection,
    updateConnection,
    deleteConnection,
  };
}

// =============================================================================
// SDK CHANNELS HOOK
// =============================================================================

export function useSDKChannels() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const key = isAuthenticated ? '/api/admin/sdk-channels' : null;

  const { data, error, isLoading, mutate } = useSWR<SDKChannelsResponse>(key, SWR_OPTIONS);

  const createChannel = async (input: CreateSDKChannelInput): Promise<void> => {
    const res = await apiFetch('/api/admin/sdk-channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { error?: string }).error || 'Failed to create SDK channel');
    }
    await mutate();
  };

  const updateChannel = async (channelId: string, input: UpdateSDKChannelInput): Promise<void> => {
    const res = await apiFetch(
      `/api/admin/sdk-channels?channelId=${encodeURIComponent(channelId)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { error?: string }).error || 'Failed to update SDK channel');
    }
    await mutate();
  };

  const deleteChannel = async (channelId: string): Promise<void> => {
    const res = await apiFetch(
      `/api/admin/sdk-channels?channelId=${encodeURIComponent(channelId)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { error?: string }).error || 'Failed to delete SDK channel');
    }
    await mutate();
  };

  return {
    channels: data?.data ?? [],
    isLoading,
    error: error ? String(error) : null,
    mutate,
    createChannel,
    updateChannel,
    deleteChannel,
  };
}

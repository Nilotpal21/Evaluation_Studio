import { apiFetch, handleResponse } from '../lib/api-client';

export type SessionLifecycleChannel =
  | 'voice'
  | 'web_chat'
  | 'web_debug'
  | 'whatsapp'
  | 'sms'
  | 'email'
  | 'api'
  | 'http_async';

export type SessionLifecycleDisposition =
  | 'completed'
  | 'abandoned'
  | 'agent_hangup'
  | 'transferred'
  | 'failed'
  | 'timeout'
  | 'unengaged';

export type SessionDisconnectBehavior = 'end' | 'detach';

export type TransferTtlChannel = 'chat' | 'email' | 'voice' | 'messaging' | 'campaign';

export type SessionEndHookConfig = { mode: 'ignore' } | { mode: 'respond'; message: string };

export interface SessionLifecycleChannelSettings {
  defaultDisposition?: SessionLifecycleDisposition;
  disconnectBehavior?: SessionDisconnectBehavior;
  endHook?: SessionEndHookConfig;
}

export interface ProjectSessionLifecycleSettings {
  runtime: {
    idleSeconds?: number;
    maxAgeSeconds?: number;
  };
  endHook: SessionEndHookConfig;
  channels: Partial<Record<SessionLifecycleChannel, SessionLifecycleChannelSettings>>;
  agentTransfer: {
    ttl: Partial<Record<TransferTtlChannel, number>>;
  };
}

export interface ProjectSessionLifecyclePatch {
  runtime?: {
    idleSeconds?: number;
    maxAgeSeconds?: number;
  };
  endHook?: SessionEndHookConfig;
  channels?: Partial<Record<SessionLifecycleChannel, SessionLifecycleChannelSettings>>;
  agentTransfer?: {
    ttl?: Partial<Record<TransferTtlChannel, number>>;
  };
}

export const DEFAULT_PROJECT_SESSION_LIFECYCLE_SETTINGS: ProjectSessionLifecycleSettings = {
  runtime: {},
  endHook: { mode: 'ignore' },
  channels: {},
  agentTransfer: {
    ttl: {},
  },
};

export async function getProjectSessionLifecycleSettings(
  projectId: string,
): Promise<ProjectSessionLifecycleSettings> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/session-lifecycle`,
  );
  const result = await handleResponse<{
    success: boolean;
    data?: ProjectSessionLifecycleSettings;
  }>(response);
  return result.data ?? DEFAULT_PROJECT_SESSION_LIFECYCLE_SETTINGS;
}

export async function patchProjectSessionLifecycleSettings(
  projectId: string,
  patch: ProjectSessionLifecyclePatch,
): Promise<ProjectSessionLifecycleSettings> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/session-lifecycle`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    },
  );
  const result = await handleResponse<{
    success: boolean;
    data?: ProjectSessionLifecycleSettings;
  }>(response);
  return result.data ?? DEFAULT_PROJECT_SESSION_LIFECYCLE_SETTINGS;
}

export async function replaceProjectSessionLifecycleSettings(
  projectId: string,
  settings: ProjectSessionLifecycleSettings,
): Promise<ProjectSessionLifecycleSettings> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/session-lifecycle`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    },
  );
  const result = await handleResponse<{
    success: boolean;
    data?: ProjectSessionLifecycleSettings;
  }>(response);
  return result.data ?? DEFAULT_PROJECT_SESSION_LIFECYCLE_SETTINGS;
}

/**
 * Agent Transfer Settings API Client
 *
 * Functions for managing project-level agent transfer configuration.
 * Settings are stored via the dedicated agent-transfer settings route at
 * /api/projects/:projectId/agent-transfer/settings.
 */

import { apiFetch, handleResponse } from '../lib/api-client';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

export interface AgentTransferSettings {
  session: {
    ttl: { chat: number; email: number; voice: number; messaging: number; campaign: number };
    maxConcurrentPerContact: number;
  };
  defaultRouting: {
    connectionId?: string;
    queue?: string;
    priority?: number;
    postAgentAction: 'return' | 'end';
  };
  voice: {
    type: 'korevg' | 'audiocodes' | 'jambonz';
    transferMethod: 'invite' | 'refer' | 'bye';
    headerPassthrough: boolean;
    recordingEnabled: boolean;
  };
  pii: {
    deTokenizeBeforeTransfer: boolean;
    detectionPattern: string;
  };
}

export interface AgentTransferSettingsWritePayload {
  session?: {
    ttl?: { chat?: number; email?: number; voice?: number; messaging?: number; campaign?: number };
    maxConcurrentPerContact?: number;
  };
  defaultRouting?: {
    connectionId?: string;
    queue?: string;
    priority?: number;
    postAgentAction?: 'return' | 'end';
  };
  voice?: {
    type?: 'korevg' | 'audiocodes' | 'jambonz';
    transferMethod?: 'invite' | 'refer' | 'bye';
    headerPassthrough?: boolean;
    recordingEnabled?: boolean;
  };
  pii?: {
    deTokenizeBeforeTransfer?: boolean;
    detectionPattern?: string;
  };
}

interface BackendAgentTransferConnectionRef {
  connectionId?: string;
  authProfileId?: string;
  connectorName?: string;
  [key: string]: unknown;
}

interface BackendAgentTransferSettings {
  session?: AgentTransferSettingsWritePayload['session'];
  defaultRouting?: {
    connection?: BackendAgentTransferConnectionRef;
    connectionId?: string;
    queue?: string;
    priority?: number;
    postAgentAction?: 'return' | 'end';
    [key: string]: unknown;
  };
  voice?: AgentTransferSettingsWritePayload['voice'];
  pii?: AgentTransferSettingsWritePayload['pii'];
  [key: string]: unknown;
}

interface BackendAgentTransferSettingsWritePayload {
  session?: AgentTransferSettingsWritePayload['session'];
  defaultRouting?: {
    connection?: BackendAgentTransferConnectionRef;
    queue?: string;
    priority?: number;
    postAgentAction?: 'return' | 'end';
  };
  voice?: AgentTransferSettingsWritePayload['voice'];
  pii?: AgentTransferSettingsWritePayload['pii'];
}

export const DEFAULT_AGENT_TRANSFER_SETTINGS: AgentTransferSettings = {
  session: {
    ttl: { chat: 30, email: 240, voice: 0, messaging: 30, campaign: 60 },
    maxConcurrentPerContact: 1,
  },
  defaultRouting: { priority: 5, postAgentAction: 'return' },
  voice: {
    type: 'korevg',
    transferMethod: 'refer',
    headerPassthrough: true,
    recordingEnabled: false,
  },
  pii: { deTokenizeBeforeTransfer: true, detectionPattern: '\\{\\{pii\\..*?\\}\\}' },
};

function isNonEmptyObject(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0;
}

function normalizeConnectionId(
  connection?: BackendAgentTransferConnectionRef,
  legacyConnectionId?: string,
): string | undefined {
  const canonicalId = connection?.connectionId?.trim();
  if (canonicalId) {
    return canonicalId;
  }

  const legacyId = legacyConnectionId?.trim();
  return legacyId ? legacyId : undefined;
}

export function normalizeAgentTransferSettingsResponse(
  settings: BackendAgentTransferSettings | null | undefined,
): AgentTransferSettings {
  if (!settings) {
    return DEFAULT_AGENT_TRANSFER_SETTINGS;
  }

  const connectionId = normalizeConnectionId(
    settings.defaultRouting?.connection,
    settings.defaultRouting?.connectionId,
  );

  return {
    session: {
      ttl: {
        ...DEFAULT_AGENT_TRANSFER_SETTINGS.session.ttl,
        ...(settings.session?.ttl ?? {}),
      },
      maxConcurrentPerContact:
        settings.session?.maxConcurrentPerContact ??
        DEFAULT_AGENT_TRANSFER_SETTINGS.session.maxConcurrentPerContact,
    },
    defaultRouting: {
      ...DEFAULT_AGENT_TRANSFER_SETTINGS.defaultRouting,
      ...(connectionId ? { connectionId } : {}),
      ...(settings.defaultRouting?.queue !== undefined
        ? { queue: settings.defaultRouting.queue }
        : {}),
      ...(settings.defaultRouting?.priority !== undefined
        ? { priority: settings.defaultRouting.priority }
        : {}),
      ...(settings.defaultRouting?.postAgentAction
        ? { postAgentAction: settings.defaultRouting.postAgentAction }
        : {}),
    },
    voice: {
      ...DEFAULT_AGENT_TRANSFER_SETTINGS.voice,
      ...(settings.voice ?? {}),
    },
    pii: {
      ...DEFAULT_AGENT_TRANSFER_SETTINGS.pii,
      ...(settings.pii ?? {}),
    },
  };
}

export function serializeAgentTransferSettingsPayload(
  settings: AgentTransferSettingsWritePayload,
): BackendAgentTransferSettingsWritePayload {
  const session = settings.session
    ? {
        ...(settings.session.ttl ? { ttl: { ...settings.session.ttl } } : {}),
        ...(settings.session.maxConcurrentPerContact !== undefined
          ? { maxConcurrentPerContact: settings.session.maxConcurrentPerContact }
          : {}),
      }
    : undefined;

  const trimmedConnectionId = settings.defaultRouting?.connectionId?.trim();
  const defaultRouting = settings.defaultRouting
    ? {
        ...(trimmedConnectionId ? { connection: { connectionId: trimmedConnectionId } } : {}),
        ...(settings.defaultRouting.queue !== undefined
          ? { queue: settings.defaultRouting.queue }
          : {}),
        ...(settings.defaultRouting.priority !== undefined
          ? { priority: settings.defaultRouting.priority }
          : {}),
        ...(settings.defaultRouting.postAgentAction
          ? { postAgentAction: settings.defaultRouting.postAgentAction }
          : {}),
      }
    : undefined;

  const voice = settings.voice ? { ...settings.voice } : undefined;
  const pii = settings.pii ? { ...settings.pii } : undefined;

  return {
    ...(session && isNonEmptyObject(session) ? { session } : {}),
    ...(defaultRouting && isNonEmptyObject(defaultRouting) ? { defaultRouting } : {}),
    ...(voice && isNonEmptyObject(voice) ? { voice } : {}),
    ...(pii && isNonEmptyObject(pii) ? { pii } : {}),
  };
}

// =============================================================================
// API FUNCTIONS
// =============================================================================

export async function getAgentTransferSettings(projectId: string): Promise<AgentTransferSettings> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/agent-transfer/settings`,
  );
  const result = await handleResponse<{
    success: boolean;
    data?: BackendAgentTransferSettings | null;
  }>(response);
  return normalizeAgentTransferSettingsResponse(result.data);
}

export async function updateAgentTransferSettings(
  projectId: string,
  settings: AgentTransferSettingsWritePayload,
): Promise<void> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/agent-transfer/settings`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(serializeAgentTransferSettingsPayload(settings)),
    },
  );
  await handleResponse(response);
}

// =============================================================================
// TRANSFER SESSION TYPES
// =============================================================================

export interface TransferSession {
  id: string;
  contactId: string;
  agentId: string;
  agentName?: string;
  provider: string;
  state: 'pending' | 'queued' | 'active' | 'post_agent' | 'ended';
  channel: string;
  queue?: string;
  skills?: string[];
  priority?: number;
  metadata?: Record<string, unknown>;
  providerSessionId?: string;
  providerData?: Record<string, unknown>;
  csatSurveyType?: string;
  csatDialogId?: string;
  dispositionCode?: string;
  wrapUpNotes?: string;
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// TRANSFER SESSION API FUNCTIONS
// =============================================================================

export async function listTransferSessions(
  projectId: string,
  filters?: { provider?: string; state?: string; channel?: string },
): Promise<TransferSession[]> {
  const params = new URLSearchParams();
  if (filters?.provider) params.set('provider', filters.provider);
  if (filters?.state) params.set('state', filters.state);
  if (filters?.channel) params.set('channel', filters.channel);
  const qs = params.toString();
  const encodedId = encodeURIComponent(projectId);
  const response = await apiFetch(
    `/api/projects/${encodedId}/agent-transfer/sessions${qs ? `?${qs}` : ''}`,
  );
  const result = await handleResponse<{ success: boolean; data?: TransferSession[] }>(response);
  return result.data ?? [];
}

export async function endTransferSession(projectId: string, sessionId: string): Promise<void> {
  const encodedId = encodeURIComponent(projectId);
  const encodedSessionId = encodeURIComponent(sessionId);
  const response = await apiFetch(
    `/api/projects/${encodedId}/agent-transfer/sessions/${encodedSessionId}/end`,
    { method: 'POST' },
  );
  await handleResponse(response);
}

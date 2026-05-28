import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockApiFetch = vi.fn();
const mockHandleResponse = vi.fn();

vi.mock('../lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  handleResponse: (...args: unknown[]) => mockHandleResponse(...args),
}));

import {
  getAgentTransferSettings,
  updateAgentTransferSettings,
  normalizeAgentTransferSettingsResponse,
  serializeAgentTransferSettingsPayload,
  DEFAULT_AGENT_TRANSFER_SETTINGS,
} from '../api/agent-transfer';

describe('agent-transfer API client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('normalizes canonical routing references into the Studio flat connectionId shape', () => {
    const normalized = normalizeAgentTransferSettingsResponse({
      defaultRouting: {
        connection: {
          connectionId: 'conn-123',
          authProfileId: 'auth-456',
          connectorName: 'salesforce',
        },
        queue: 'vip-support',
        postAgentAction: 'end',
      },
    });

    expect(normalized.defaultRouting).toEqual({
      ...DEFAULT_AGENT_TRANSFER_SETTINGS.defaultRouting,
      connectionId: 'conn-123',
      queue: 'vip-support',
      postAgentAction: 'end',
    });
  });

  it('serializes Studio writes into the canonical routing connection payload', () => {
    const serialized = serializeAgentTransferSettingsPayload({
      session: {
        maxConcurrentPerContact: 4,
      },
      defaultRouting: {
        connectionId: 'conn-123',
        queue: 'vip-support',
        postAgentAction: 'return',
      },
    });

    expect(serialized).toEqual({
      session: {
        maxConcurrentPerContact: 4,
      },
      defaultRouting: {
        connection: {
          connectionId: 'conn-123',
        },
        queue: 'vip-support',
        postAgentAction: 'return',
      },
    });
  });

  it('getAgentTransferSettings reads the canonical response and returns the Studio-compatible shape', async () => {
    mockApiFetch.mockResolvedValue({ ok: true });
    mockHandleResponse.mockResolvedValue({
      success: true,
      data: {
        defaultRouting: {
          connection: {
            connectionId: 'conn-123',
          },
          queue: 'vip-support',
        },
      },
    });

    await expect(getAgentTransferSettings('project-123')).resolves.toMatchObject({
      defaultRouting: {
        connectionId: 'conn-123',
        queue: 'vip-support',
      },
    });
  });

  it('updateAgentTransferSettings sends the canonical routing reference to the API route', async () => {
    mockApiFetch.mockResolvedValue({ ok: true });
    mockHandleResponse.mockResolvedValue({ success: true });

    await updateAgentTransferSettings('project-123', {
      defaultRouting: {
        connectionId: 'conn-123',
        queue: 'vip-support',
      },
    });

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/projects/project-123/agent-transfer/settings',
      expect.objectContaining({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          defaultRouting: {
            connection: {
              connectionId: 'conn-123',
            },
            queue: 'vip-support',
          },
        }),
      }),
    );
  });
});

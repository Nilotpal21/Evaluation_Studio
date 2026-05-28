import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AgentTransferSettings } from '@/api/agent-transfer';
import type { ConnectionSummary } from '@/api/connections';
import type { ProjectSessionLifecycleSettings } from '@/api/session-lifecycle';

const {
  saveMock,
  refreshMock,
  saveLifecyclePatchMock,
  refreshLifecycleMock,
  refreshConnectionsMock,
  toastSuccessMock,
  toastErrorMock,
  agentTransferHookState,
  sessionLifecycleHookState,
  connectionsHookState,
} = vi.hoisted(() => ({
  saveMock: vi.fn(),
  refreshMock: vi.fn(),
  saveLifecyclePatchMock: vi.fn(),
  refreshLifecycleMock: vi.fn(),
  refreshConnectionsMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  toastErrorMock: vi.fn(),
  agentTransferHookState: {
    settings: null as AgentTransferSettings | null,
    isLoading: false,
    error: null as string | null,
    save: vi.fn(),
    refresh: vi.fn(),
  },
  sessionLifecycleHookState: {
    settings: null as ProjectSessionLifecycleSettings | null,
    isLoading: false,
    error: null as string | null,
    savePatch: vi.fn(),
    refresh: vi.fn(),
  },
  connectionsHookState: {
    connections: [] as ConnectionSummary[],
    refresh: vi.fn(),
  },
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

vi.mock('@/hooks/useAgentTransferSettings', () => ({
  useAgentTransferSettings: () => agentTransferHookState,
}));

vi.mock('@/hooks/useSessionLifecycleSettings', () => ({
  useSessionLifecycleSettings: () => sessionLifecycleHookState,
}));

vi.mock('@/hooks/useConnections', () => ({
  useConnections: () => connectionsHookState,
}));

vi.mock('@/store/navigation-store', () => ({
  useNavigationStore: () => ({ projectId: 'proj-1' }),
}));

vi.mock('@/components/ui/ConfirmDialog', () => ({
  ConfirmDialog: () => null,
}));

vi.mock('@/components/connections/AgentDesktopConnectionDialog', () => ({
  AgentDesktopConnectionDialog: () => null,
}));

vi.mock('@/components/connections/EditConnectionDialog', () => ({
  EditConnectionDialog: () => null,
}));

import { AgentTransferSettingsPage } from '@/components/settings/AgentTransferSettingsPage';

const BASE_SETTINGS: AgentTransferSettings = {
  session: {
    ttl: { chat: 30, email: 240, voice: 0, messaging: 30, campaign: 60 },
    maxConcurrentPerContact: 1,
  },
  defaultRouting: {
    connectionId: 'conn-active',
    priority: 5,
    postAgentAction: 'return',
  },
  voice: {
    type: 'korevg',
    transferMethod: 'refer',
    headerPassthrough: true,
    recordingEnabled: false,
  },
  pii: {
    deTokenizeBeforeTransfer: true,
    detectionPattern: '\\{\\{pii\\..*?\\}\\}',
  },
};

const BASE_LIFECYCLE_SETTINGS: ProjectSessionLifecycleSettings = {
  runtime: {},
  endHook: { mode: 'ignore' },
  channels: {},
  agentTransfer: {
    ttl: {},
  },
};

function makeConnection(overrides: Partial<ConnectionSummary> = {}): ConnectionSummary {
  return {
    id: 'conn-active',
    connectorName: 'smartassist',
    displayName: 'SmartAssist Default',
    scope: 'tenant',
    authProfileId: 'auth-1',
    status: 'active',
    createdAt: '2026-04-19T10:00:00.000Z',
    updatedAt: '2026-04-19T10:00:00.000Z',
    category: 'agent_desktop',
    ...overrides,
  };
}

function renderPage() {
  render(<AgentTransferSettingsPage />);
}

function dirtyQueueField(value = 'priority-queue') {
  fireEvent.change(screen.getByPlaceholderText('default'), {
    target: { value },
  });
}

describe('AgentTransferSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    saveMock.mockResolvedValue(undefined);
    refreshMock.mockResolvedValue(undefined);
    saveLifecyclePatchMock.mockResolvedValue(undefined);
    refreshLifecycleMock.mockResolvedValue(undefined);
    refreshConnectionsMock.mockResolvedValue(undefined);

    agentTransferHookState.settings = {
      ...BASE_SETTINGS,
      defaultRouting: { ...BASE_SETTINGS.defaultRouting },
      session: {
        ...BASE_SETTINGS.session,
        ttl: { ...BASE_SETTINGS.session.ttl },
      },
      voice: { ...BASE_SETTINGS.voice },
      pii: { ...BASE_SETTINGS.pii },
    };
    agentTransferHookState.isLoading = false;
    agentTransferHookState.error = null;
    agentTransferHookState.save = saveMock;
    agentTransferHookState.refresh = refreshMock;

    sessionLifecycleHookState.settings = {
      ...BASE_LIFECYCLE_SETTINGS,
      runtime: { ...BASE_LIFECYCLE_SETTINGS.runtime },
      channels: { ...BASE_LIFECYCLE_SETTINGS.channels },
      agentTransfer: {
        ttl: { ...BASE_LIFECYCLE_SETTINGS.agentTransfer.ttl },
      },
    };
    sessionLifecycleHookState.isLoading = false;
    sessionLifecycleHookState.error = null;
    sessionLifecycleHookState.savePatch = saveLifecyclePatchMock;
    sessionLifecycleHookState.refresh = refreshLifecycleMock;

    connectionsHookState.connections = [makeConnection()];
    connectionsHookState.refresh = refreshConnectionsMock;
  });

  it('blocks saving when the stored connection reference no longer resolves', () => {
    agentTransferHookState.settings = {
      ...agentTransferHookState.settings!,
      defaultRouting: {
        ...agentTransferHookState.settings!.defaultRouting,
        connectionId: 'conn-missing',
      },
    };
    connectionsHookState.connections = [];

    renderPage();

    expect(screen.getByText('connection_missing_title')).toBeInTheDocument();
    expect(screen.getByText('save_blocked_title')).toBeInTheDocument();
    expect(screen.getByText('save_blocked_missing_reason')).toBeInTheDocument();

    dirtyQueueField();

    const saveButton = screen.getByRole('button', { name: /save/i });
    expect(saveButton).toBeDisabled();

    fireEvent.click(saveButton);
    expect(saveMock).not.toHaveBeenCalled();
    expect(saveLifecyclePatchMock).not.toHaveBeenCalled();
  });

  it('blocks saving when the selected routing connection is inactive', () => {
    connectionsHookState.connections = [
      makeConnection({
        id: 'conn-expired',
        status: 'expired',
      }),
    ];
    agentTransferHookState.settings = {
      ...agentTransferHookState.settings!,
      defaultRouting: {
        ...agentTransferHookState.settings!.defaultRouting,
        connectionId: 'conn-expired',
      },
    };

    renderPage();

    expect(screen.getByText('connection_inactive_title')).toBeInTheDocument();
    expect(screen.getByText('save_blocked_title')).toBeInTheDocument();
    expect(screen.getByText('save_blocked_inactive_reason')).toBeInTheDocument();

    dirtyQueueField();

    const saveButton = screen.getByRole('button', { name: /save/i });
    expect(saveButton).toBeDisabled();

    fireEvent.click(saveButton);
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('keeps save available when the selected routing connection is valid', async () => {
    renderPage();

    dirtyQueueField();

    const saveButton = screen.getByRole('button', { name: /save/i });
    expect(saveButton).toBeEnabled();

    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(saveMock).toHaveBeenCalledTimes(1);
      expect(saveLifecyclePatchMock).toHaveBeenCalledTimes(1);
    });

    expect(saveMock.mock.calls[0]?.[0]).toMatchObject({
      defaultRouting: {
        connectionId: 'conn-active',
        queue: 'priority-queue',
      },
    });
    expect(toastSuccessMock).toHaveBeenCalledWith('saved');
    expect(toastErrorMock).not.toHaveBeenCalled();
  });
});

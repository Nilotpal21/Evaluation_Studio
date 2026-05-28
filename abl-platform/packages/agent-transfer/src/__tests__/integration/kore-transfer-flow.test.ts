/**
 * Integration test: KoreAdapter transfer flow with mocks
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdapterRegistry } from '../../adapters/registry.js';
import { TransferToAgentTool, type TransferToolContext } from '../../tools/transfer-to-agent.js';
import type { AgentDesktopAdapter, AdapterCapabilities } from '../../adapters/interface.js';
import type { TransferResult, TransferPayload } from '../../types.js';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function createMockAdapter(name: string, executeResult: TransferResult): AgentDesktopAdapter {
  return {
    name,
    capabilities: {
      supportsPreChecks: true,
      supportsPostAgentDialog: true,
      supportsFileUpload: false,
      supportsTranslation: false,
      transportType: 'polling',
      authType: 'internal_key',
    } satisfies AdapterCapabilities,
    initialize: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockResolvedValue(executeResult),
    sendUserMessage: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    onAgentMessage: vi.fn(),
    onSessionEvent: vi.fn(),
  };
}

const CONTEXT: TransferToolContext = {
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  agentId: 'agent-1',
  contactId: 'contact-1',
  sessionId: 'sess-1',
  channel: 'chat',
};

describe('Kore transfer flow integration', () => {
  let registry: AdapterRegistry;
  let tool: TransferToAgentTool;

  beforeEach(() => {
    registry = new AdapterRegistry();
  });

  it('register adapter, execute transfer, verify session creation', async () => {
    const adapter = createMockAdapter('kore', {
      success: true,
      status: 'transferred',
      providerSessionId: 'kore-conv-123',
    });
    registry.register('kore', adapter);
    tool = new TransferToAgentTool(registry);

    const result = await tool.execute({ provider: 'kore' }, CONTEXT);

    expect(result.success).toBe(true);
    expect(result.status).toBe('transferred');
    expect(result.conversationId).toBe('kore-conv-123');
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        contactId: 'contact-1',
        channel: 'chat',
      }),
    );
  });

  it('pre-check failure returns appropriate status', async () => {
    const adapter = createMockAdapter('kore', {
      success: false,
      status: 'no_agents',
      error: { code: 'NO_AGENTS', message: 'No agents available' },
    });
    registry.register('kore', adapter);
    tool = new TransferToAgentTool(registry);

    const result = await tool.execute({ provider: 'kore' }, CONTEXT);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NO_AGENTS');
  });

  it('voice channel returns waiting status', async () => {
    const adapter = createMockAdapter('kore', {
      success: true,
      status: 'transferred',
      providerSessionId: 'kore-voice-123',
    });
    registry.register('kore', adapter);
    tool = new TransferToAgentTool(registry);

    const voiceContext: TransferToolContext = { ...CONTEXT, channel: 'voice' };
    const result = await tool.execute({ provider: 'kore' }, voiceContext);

    expect(result.success).toBe(true);
    expect(result.status).toBe('waiting');
  });

  it('unregistered provider returns error', async () => {
    tool = new TransferToAgentTool(registry);

    const result = await tool.execute({ provider: 'unknown' }, CONTEXT);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PROVIDER_NOT_FOUND');
  });

  it('adapter exception returns transfer error', async () => {
    const adapter = createMockAdapter('kore', {
      success: true,
      status: 'transferred',
    });
    (adapter.execute as any).mockRejectedValue(new Error('Network timeout'));
    registry.register('kore', adapter);
    tool = new TransferToAgentTool(registry);

    const result = await tool.execute({ provider: 'kore' }, CONTEXT);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('TRANSFER_ERROR');
    expect(result.error?.message).toContain('Network timeout');
  });
});

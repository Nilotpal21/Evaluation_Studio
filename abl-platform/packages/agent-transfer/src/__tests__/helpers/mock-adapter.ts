/**
 * Reusable mock AgentDesktopAdapter factory for agent-transfer tests.
 */
import { vi } from 'vitest';
import type { AgentDesktopAdapter, AdapterCapabilities } from '../../adapters/interface.js';

const DEFAULT_CAPABILITIES: AdapterCapabilities = {
  supportsPreChecks: true,
  supportsPostAgentDialog: false,
  supportsFileUpload: false,
  supportsTranslation: false,
  transportType: 'webhook',
  authType: 'bearer',
};

export function createMockAdapter(overrides?: Partial<AgentDesktopAdapter>): AgentDesktopAdapter {
  return {
    name: 'mock-adapter',
    capabilities: { ...DEFAULT_CAPABILITIES },
    initialize: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockResolvedValue({
      success: true,
      status: 'transferred' as const,
      providerSessionId: 'mock-provider-session-1',
    }),
    sendUserMessage: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    onAgentMessage: vi.fn(),
    onSessionEvent: vi.fn(),
    checkHealth: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

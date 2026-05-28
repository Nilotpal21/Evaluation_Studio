/**
 * Reusable mock SmartAssistClient factory for agent-transfer tests.
 *
 * Returns a plain object with the same method signatures as SmartAssistClient
 * so it can be used as a stand-in without constructing an actual HTTP pool.
 */
import { vi } from 'vitest';
import type { OperationResult, TransferResult } from '../../types.js';

export interface MockSmartAssistClient {
  checkBusinessHours: ReturnType<typeof vi.fn>;
  checkAgentAvailability: ReturnType<typeof vi.fn>;
  validateQueue: ReturnType<typeof vi.fn>;
  initTransfer: ReturnType<typeof vi.fn>;
  updateTransfer: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

export interface MockSmartAssistOptions {
  availability?: boolean;
  businessHours?: boolean;
  queueValid?: boolean;
  transferResult?: TransferResult;
}

const DEFAULT_TRANSFER_RESULT: TransferResult = {
  success: true,
  status: 'transferred',
  providerSessionId: 'mock-conv-123',
};

export function createMockSmartAssistClient(
  opts: MockSmartAssistOptions = {},
): MockSmartAssistClient {
  const {
    availability = true,
    businessHours = true,
    queueValid = true,
    transferResult = DEFAULT_TRANSFER_RESULT,
  } = opts;

  const okResult = <T>(data: T): OperationResult<T> => ({ success: true, data });

  return {
    checkBusinessHours: vi.fn().mockResolvedValue(okResult(businessHours)),
    checkAgentAvailability: vi.fn().mockResolvedValue(okResult(availability)),
    validateQueue: vi.fn().mockResolvedValue(okResult(queueValid)),
    initTransfer: vi.fn().mockResolvedValue(transferResult),
    updateTransfer: vi.fn().mockResolvedValue({ success: true }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

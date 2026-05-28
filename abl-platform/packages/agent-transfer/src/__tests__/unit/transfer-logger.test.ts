import { describe, it, expect, vi } from 'vitest';
import {
  createTransferLogger,
  type TransferLogContext,
} from '../../observability/transfer-logger.js';

const mockInfo = vi.fn();
const mockWarn = vi.fn();
const mockError = vi.fn();
const mockDebug = vi.fn();

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: mockInfo,
    warn: mockWarn,
    error: mockError,
    debug: mockDebug,
  }),
}));

describe('createTransferLogger', () => {
  const context: TransferLogContext = {
    tenantId: 'tenant-1',
    contactId: 'contact-1',
    channel: 'chat',
    provider: 'kore',
    sessionKey: 'sess-1',
  };

  it('logger includes context in all log calls', () => {
    const logger = createTransferLogger(context);
    logger.info('test message');
    expect(mockInfo).toHaveBeenCalledWith('test message', expect.objectContaining(context));
  });

  it('merges additional data with context', () => {
    const logger = createTransferLogger(context);
    logger.info('test', { extra: 'data' });
    expect(mockInfo).toHaveBeenCalledWith(
      'test',
      expect.objectContaining({
        ...context,
        extra: 'data',
      }),
    );
  });

  it('supports all log levels', () => {
    const logger = createTransferLogger(context);

    logger.info('info msg');
    expect(mockInfo).toHaveBeenCalled();

    logger.warn('warn msg');
    expect(mockWarn).toHaveBeenCalled();

    logger.error('error msg');
    expect(mockError).toHaveBeenCalled();

    logger.debug('debug msg');
    expect(mockDebug).toHaveBeenCalled();
  });
});

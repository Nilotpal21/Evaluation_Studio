import { createLogger } from '@abl/compiler/platform';

export interface TransferLogContext {
  tenantId: string;
  contactId: string;
  channel: string;
  provider?: string;
  sessionKey?: string;
}

export function createTransferLogger(context: TransferLogContext) {
  const base = createLogger('@agent-transfer');
  return {
    info: (msg: string, data?: Record<string, unknown>) => base.info(msg, { ...context, ...data }),
    warn: (msg: string, data?: Record<string, unknown>) => base.warn(msg, { ...context, ...data }),
    error: (msg: string, data?: Record<string, unknown>) =>
      base.error(msg, { ...context, ...data }),
    debug: (msg: string, data?: Record<string, unknown>) =>
      base.debug(msg, { ...context, ...data }),
  };
}

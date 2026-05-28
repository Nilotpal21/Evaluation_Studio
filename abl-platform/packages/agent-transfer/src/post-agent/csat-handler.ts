import { createLogger } from '@abl/compiler/platform';
import type { PostAgentConfig, CsatEventHandler, CsatSessionEvent } from './types.js';

const log = createLogger('csat-handler');
const MAX_HANDLERS = 10;

export interface SessionStoreHandle {
  get(key: string): Promise<Record<string, string> | null>;
  update(key: string, fields: Record<string, unknown>): Promise<void>;
  end(key: string): Promise<void>;
}

export class CsatHandler {
  private readonly store: SessionStoreHandle;
  private readonly handlers: CsatEventHandler[] = [];

  constructor(store: SessionStoreHandle) {
    this.store = store;
  }

  async handleAgentClosed(
    sessionKey: string,
    sessionData: { tenantId: string; contactId: string; channel: string },
    config: PostAgentConfig,
  ): Promise<void> {
    switch (config.action) {
      case 'end':
        await this.store.end(sessionKey);
        log.info('Session ended after agent close', { sessionKey });
        break;

      case 'return':
        await this.store.update(sessionKey, { state: 'ended' });
        await this.emit({
          type: 'csat_skipped',
          sessionKey,
          ...sessionData,
          timestamp: Date.now(),
          data: { reason: 'return_to_agent' },
        });
        log.info('Session returned to bot after agent close', { sessionKey });
        break;

      case 'csat':
        await this.store.update(sessionKey, {
          state: 'post_agent',
          csatSurveyType: config.surveyType ?? 'inline',
          csatDialogId: config.dialogId ?? '',
          csatStartedAt: Date.now().toString(),
        });
        await this.emit({
          type: 'csat_started',
          sessionKey,
          ...sessionData,
          timestamp: Date.now(),
          data: {
            surveyType: config.surveyType,
            dialogId: config.dialogId,
          },
        });
        log.info('CSAT survey started', {
          sessionKey,
          surveyType: config.surveyType,
        });
        break;

      default:
        log.warn('Unknown post-agent action, ending session', {
          sessionKey,
          action: (config as unknown as Record<string, unknown>).action,
        });
        await this.store.end(sessionKey);
    }
  }

  /**
   * Complete CSAT — emit the event then end the session.
   * No intermediate store.update() to avoid double session end.
   */
  async completeCsat(
    sessionKey: string,
    sessionData: { tenantId: string; contactId: string; channel: string },
    score?: number,
    feedback?: string,
  ): Promise<void> {
    await this.emit({
      type: 'csat_completed',
      sessionKey,
      ...sessionData,
      timestamp: Date.now(),
      data: { score, feedback },
    });
    await this.store.end(sessionKey);
    log.info('CSAT completed', { sessionKey, score });
  }

  async skipCsat(
    sessionKey: string,
    sessionData: { tenantId: string; contactId: string; channel: string },
    reason?: string,
  ): Promise<void> {
    await this.emit({
      type: 'csat_skipped',
      sessionKey,
      ...sessionData,
      timestamp: Date.now(),
      data: { reason: reason ?? 'user_skipped' },
    });
    await this.store.end(sessionKey);
    log.info('CSAT skipped', { sessionKey, reason });
  }

  onCsatEvent(handler: CsatEventHandler): void {
    if (this.handlers.length >= MAX_HANDLERS) {
      log.warn('Max CSAT event handlers reached', { max: MAX_HANDLERS });
      return;
    }
    this.handlers.push(handler);
  }

  clearHandlers(): void {
    this.handlers.length = 0;
  }

  private async emit(event: CsatSessionEvent): Promise<void> {
    for (const handler of this.handlers) {
      try {
        await handler(event);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('CSAT event handler error', {
          type: event.type,
          error: message,
        });
      }
    }
  }
}

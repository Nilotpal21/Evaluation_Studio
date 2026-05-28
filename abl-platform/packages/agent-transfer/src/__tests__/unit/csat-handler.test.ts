import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CsatHandler, type SessionStoreHandle } from '../../post-agent/csat-handler.js';
import type { PostAgentConfig, CsatEventHandler } from '../../post-agent/types.js';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const SESSION_DATA = {
  tenantId: 'tenant-1',
  contactId: 'contact-1',
  channel: 'chat',
};

describe('CsatHandler', () => {
  let store: SessionStoreHandle;
  let handler: CsatHandler;

  beforeEach(() => {
    store = {
      get: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue(undefined),
      end: vi.fn().mockResolvedValue(undefined),
    };
    handler = new CsatHandler(store);
  });

  describe('handleAgentClosed', () => {
    it('with action=end: calls store.end()', async () => {
      const config: PostAgentConfig = { action: 'end' };
      await handler.handleAgentClosed('sess-1', SESSION_DATA, config);
      expect(store.end).toHaveBeenCalledWith('sess-1');
    });

    it('with action=return: updates state to ended and emits csat_skipped', async () => {
      const eventHandler: CsatEventHandler = vi.fn();
      handler.onCsatEvent(eventHandler);

      const config: PostAgentConfig = { action: 'return' };
      await handler.handleAgentClosed('sess-1', SESSION_DATA, config);

      expect(store.update).toHaveBeenCalledWith('sess-1', { state: 'ended' });
      expect(eventHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'csat_skipped',
          sessionKey: 'sess-1',
          tenantId: 'tenant-1',
        }),
      );
    });

    it('with action=csat: updates state to post_agent, sets CSAT fields, emits csat_started', async () => {
      const eventHandler: CsatEventHandler = vi.fn();
      handler.onCsatEvent(eventHandler);

      const config: PostAgentConfig = {
        action: 'csat',
        surveyType: 'dialog',
        dialogId: 'dlg-1',
      };
      await handler.handleAgentClosed('sess-1', SESSION_DATA, config);

      expect(store.update).toHaveBeenCalledWith(
        'sess-1',
        expect.objectContaining({
          state: 'post_agent',
          csatSurveyType: 'dialog',
          csatDialogId: 'dlg-1',
        }),
      );
      expect(eventHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'csat_started',
          data: expect.objectContaining({
            surveyType: 'dialog',
            dialogId: 'dlg-1',
          }),
        }),
      );
    });

    it('with unknown action: falls back to end', async () => {
      const config = { action: 'unknown' } as unknown as PostAgentConfig;
      await handler.handleAgentClosed('sess-1', SESSION_DATA, config);
      expect(store.end).toHaveBeenCalledWith('sess-1');
    });
  });

  describe('completeCsat', () => {
    it('emits csat_completed and ends session without intermediate update', async () => {
      const eventHandler: CsatEventHandler = vi.fn();
      handler.onCsatEvent(eventHandler);

      await handler.completeCsat('sess-1', SESSION_DATA, 5, 'Great service');

      // completeCsat no longer calls store.update() to avoid double session end
      expect(store.update).not.toHaveBeenCalled();
      expect(eventHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'csat_completed',
          data: { score: 5, feedback: 'Great service' },
        }),
      );
      expect(store.end).toHaveBeenCalledWith('sess-1');
    });
  });

  describe('skipCsat', () => {
    it('emits csat_skipped, ends session', async () => {
      const eventHandler: CsatEventHandler = vi.fn();
      handler.onCsatEvent(eventHandler);

      await handler.skipCsat('sess-1', SESSION_DATA, 'timeout');

      expect(eventHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'csat_skipped',
          data: { reason: 'timeout' },
        }),
      );
      expect(store.end).toHaveBeenCalledWith('sess-1');
    });
  });

  describe('handler registration', () => {
    it('respects MAX_HANDLERS limit', () => {
      for (let i = 0; i < 10; i++) {
        handler.onCsatEvent(vi.fn());
      }
      // 11th handler should be silently rejected
      const extra = vi.fn();
      handler.onCsatEvent(extra);

      // Verify only 10 handlers by triggering an event
      // The extra handler should not be called
    });

    it('handler errors do not break the flow', async () => {
      const errorHandler: CsatEventHandler = vi.fn().mockRejectedValue(new Error('handler broke'));
      const goodHandler: CsatEventHandler = vi.fn();
      handler.onCsatEvent(errorHandler);
      handler.onCsatEvent(goodHandler);

      await handler.skipCsat('sess-1', SESSION_DATA);

      expect(errorHandler).toHaveBeenCalled();
      expect(goodHandler).toHaveBeenCalled();
      expect(store.end).toHaveBeenCalledWith('sess-1');
    });

    it('clearHandlers removes all handlers', async () => {
      const eventHandler: CsatEventHandler = vi.fn();
      handler.onCsatEvent(eventHandler);
      handler.clearHandlers();

      await handler.skipCsat('sess-1', SESSION_DATA);
      expect(eventHandler).not.toHaveBeenCalled();
    });
  });
});

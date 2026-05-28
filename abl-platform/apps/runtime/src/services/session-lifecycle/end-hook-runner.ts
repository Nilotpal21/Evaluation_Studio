import { createLogger } from '@abl/compiler/platform';
import type {
  CanonicalSessionDisposition,
  SessionEndHookConfig,
  SessionTerminalSource,
} from '@abl/compiler/platform/core/types';

const log = createLogger('session-end-hook-runner');

export interface SessionEndHookRunInput {
  config: SessionEndHookConfig;
  sessionId: string;
  channel?: string;
  disposition: CanonicalSessionDisposition;
  source: SessionTerminalSource;
  sendResponse?: (message: string) => Promise<void>;
}

export interface SessionEndHookRunResult {
  attempted: boolean;
  mode?: 'ignore' | 'respond';
  outcome?: 'ignored' | 'sent' | 'skipped' | 'failed';
  error?: string;
}

export class SessionEndHookRunner {
  async run(input: SessionEndHookRunInput): Promise<SessionEndHookRunResult> {
    if (input.config.mode === 'ignore') {
      return {
        attempted: true,
        mode: 'ignore',
        outcome: 'ignored',
      };
    }

    if (!input.sendResponse) {
      return {
        attempted: true,
        mode: 'respond',
        outcome: 'skipped',
      };
    }

    try {
      await input.sendResponse(input.config.message);
      return {
        attempted: true,
        mode: 'respond',
        outcome: 'sent',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('Session end hook response delivery failed', {
        sessionId: input.sessionId,
        channel: input.channel,
        disposition: input.disposition,
        source: input.source,
        error: message,
      });
      return {
        attempted: true,
        mode: 'respond',
        outcome: 'failed',
        error: message,
      };
    }
  }
}

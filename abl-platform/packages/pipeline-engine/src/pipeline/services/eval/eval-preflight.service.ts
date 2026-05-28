/**
 * EvalPreflight — Restate service that exposes eval preflight checks
 * via Restate ingress so Studio can call it over HTTP.
 */
import * as restate from '@restatedev/restate-sdk';
import { createLogger } from '@abl/compiler/platform';
import { runEvalPreflight } from './eval-preflight.js';
import type { PreflightResult } from './eval-preflight.js';

const log = createLogger('eval-preflight-service');

interface PreflightInput {
  tenantId: string;
  projectId?: string;
}

export const evalPreflightService = restate.service({
  name: 'EvalPreflight',
  handlers: {
    check: async (ctx: restate.Context, input: PreflightInput): Promise<PreflightResult> => {
      return ctx.run('run-preflight', async () => {
        try {
          return await runEvalPreflight(input.tenantId, input.projectId);
        } catch (err) {
          // Log the original error with stack before wrapping in TerminalError —
          // restate.TerminalError accepts only `message`, so the underlying stack
          // would otherwise be lost in service logs.
          log.error('Preflight handler failed; wrapping in TerminalError', {
            tenantId: input.tenantId,
            projectId: input.projectId,
            err: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          });
          throw new restate.TerminalError(err instanceof Error ? err.message : String(err));
        }
      });
    },
  },
});

export type EvalPreflightServiceType = typeof evalPreflightService;

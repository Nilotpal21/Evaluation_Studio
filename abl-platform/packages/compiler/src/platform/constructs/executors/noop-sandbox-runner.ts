/**
 * No-Op Sandbox Runner
 *
 * Returns an error for every tool call instead of executing mock data.
 * Used in production when SANDBOX_BACKEND=mock is misconfigured — prevents
 * accidental mock data leaking into real conversations.
 */

import type { SandboxRunner } from './sandbox-tool-executor.js';
import { createLogger } from '../../logger.js';

const log = createLogger('noop-sandbox-runner');

export class NoOpSandboxRunner implements SandboxRunner {
  async run(config: {
    functionName: string;
    runtime: 'javascript' | 'python';
    codeContent: string;
    params: unknown;
    limits: { timeoutMs: number; memoryMb: number };
    globals?: Record<string, unknown>;
  }): Promise<unknown> {
    log.error('NoOpSandboxRunner invoked — no sandbox backend configured', {
      tool: config.functionName,
      runtime: config.runtime,
    });

    return {
      error: 'No sandbox backend configured. Set SANDBOX_BACKEND to gvisor or lambda.',
      tool: config.functionName,
    };
  }
}

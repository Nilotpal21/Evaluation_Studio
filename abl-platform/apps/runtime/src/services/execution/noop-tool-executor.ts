/**
 * No-op tool executor for production use when no real sandbox backend is configured.
 * Returns a descriptive error instead of mock data — ensures no fake responses
 * leak into production conversations.
 */

import type { ToolExecutor } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('noop-tool-executor');

const NO_EXECUTOR_ERROR = 'No tool executor configured — tools are unavailable in this session';

export class NoOpToolExecutor implements ToolExecutor {
  async execute(
    toolName: string,
    _params: Record<string, unknown>,
    _timeoutMs: number,
  ): Promise<unknown> {
    log.warn('Tool call received but no executor is configured', { toolName });
    return { error: NO_EXECUTOR_ERROR, toolName };
  }

  async executeParallel(
    calls: Array<{ name: string; params: Record<string, unknown> }>,
    _timeoutMs: number,
  ): Promise<Array<{ name: string; result?: unknown; error?: string }>> {
    log.warn('Parallel tool call received but no executor is configured', {
      toolCount: calls.length,
      toolNames: calls.map((c) => c.name),
    });
    return calls.map((call) => ({
      name: call.name,
      error: NO_EXECUTOR_ERROR,
    }));
  }
}

/**
 * MockToolExecutor — Decorator pattern for tool mock injection.
 *
 * Wraps a real ToolExecutor. When a tool call matches a configured mock,
 * returns the mocked response (with optional delay). Otherwise delegates
 * to the real executor. Only used for debug/test sessions.
 */

import type { ToolExecutor } from '@abl/compiler';
import type { ToolMockConfig } from '../../types/test-context.js';

const MOCK_DELAY_MAX_MS = 30_000; // Cap mock delay to 30s

/**
 * Check if tool params shallow-match the mock's matchParams.
 * All keys in matchParams must be present and strictly equal in actual params.
 */
function paramsMatch(
  actualParams: Record<string, unknown>,
  matchParams: Record<string, unknown>,
): boolean {
  for (const [key, expected] of Object.entries(matchParams)) {
    if (actualParams[key] !== expected) return false;
  }
  return true;
}

/**
 * Find a matching mock for a tool call.
 */
function findMock(
  toolName: string,
  params: Record<string, unknown>,
  mocks: ToolMockConfig[],
): ToolMockConfig | undefined {
  return mocks.find((m) => {
    if (m.toolName !== toolName) return false;
    if (m.matchParams && Object.keys(m.matchParams).length > 0) {
      return paramsMatch(params, m.matchParams);
    }
    return true;
  });
}

/**
 * Build the mock result for a matched ToolMockConfig.
 */
function buildMockResult(mock: ToolMockConfig): unknown {
  if (mock.success === false) {
    return {
      success: false,
      error: mock.error || { code: 'MOCK_ERROR', message: 'Mocked tool error' },
    };
  }
  return mock.response ?? { success: true, data: null };
}

/**
 * Delay helper.
 */
function delay(ms: number): Promise<void> {
  const capped = Math.min(Math.max(0, ms), MOCK_DELAY_MAX_MS);
  return new Promise((resolve) => setTimeout(resolve, capped));
}

export class MockToolExecutor implements ToolExecutor {
  private readonly realExecutor: ToolExecutor;
  private mocks: ToolMockConfig[];
  private readonly onMockHit?: (
    toolName: string,
    params: Record<string, unknown>,
    mock: ToolMockConfig,
  ) => void;

  constructor(
    realExecutor: ToolExecutor,
    mocks: ToolMockConfig[],
    onMockHit?: (toolName: string, params: Record<string, unknown>, mock: ToolMockConfig) => void,
  ) {
    this.realExecutor = realExecutor;
    this.mocks = mocks;
    this.onMockHit = onMockHit;
  }

  /** Update the mock list (e.g., from inject_context) */
  setMocks(mocks: ToolMockConfig[]): void {
    this.mocks = mocks;
  }

  /** Get current mock count */
  getMockCount(): number {
    return this.mocks.length;
  }

  async execute(
    toolName: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    const mock = findMock(toolName, params, this.mocks);

    if (mock) {
      this.onMockHit?.(toolName, params, mock);

      if (mock.delayMs && mock.delayMs > 0) {
        await delay(mock.delayMs);
      }

      return buildMockResult(mock);
    }

    return this.realExecutor.execute(toolName, params, timeoutMs);
  }

  async executeParallel(
    calls: Array<{ name: string; params: Record<string, unknown> }>,
    timeoutMs: number,
  ): Promise<Array<{ name: string; result?: unknown; error?: string }>> {
    // Split calls into mocked and real
    const results: Array<{ name: string; result?: unknown; error?: string }> = [];
    const realCalls: Array<{ name: string; params: Record<string, unknown>; index: number }> = [];

    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      const mock = findMock(call.name, call.params, this.mocks);

      if (mock) {
        this.onMockHit?.(call.name, call.params, mock);

        if (mock.delayMs && mock.delayMs > 0) {
          await delay(mock.delayMs);
        }

        const mockResult = buildMockResult(mock);
        results[i] = { name: call.name, result: mockResult };
      } else {
        realCalls.push({ ...call, index: i });
      }
    }

    // Execute non-mocked calls through real executor
    if (realCalls.length > 0) {
      const realResults = await this.realExecutor.executeParallel(
        realCalls.map((c) => ({ name: c.name, params: c.params })),
        timeoutMs,
      );

      for (let j = 0; j < realCalls.length; j++) {
        results[realCalls[j].index] = realResults[j];
      }
    }

    return results;
  }
}

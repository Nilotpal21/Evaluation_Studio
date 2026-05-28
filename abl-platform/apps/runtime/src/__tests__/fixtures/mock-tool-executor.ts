/**
 * MockToolExecutor class and helper for testing.
 * Moved from apps/runtime/src/services/adapters/tool-executor-adapter.ts
 */
import type { ToolExecutor } from '@abl/compiler';
import { MOCK_TOOL_RESPONSES } from './mock-tool-responses.js';

export class MockToolExecutor implements ToolExecutor {
  private customResponses: Record<string, (params: Record<string, unknown>) => unknown>;
  private onToolCall?: (toolName: string, params: Record<string, unknown>, result: unknown) => void;

  constructor(
    customResponses: Record<string, (params: Record<string, unknown>) => unknown> = {},
    onToolCall?: (toolName: string, params: Record<string, unknown>, result: unknown) => void,
  ) {
    this.customResponses = customResponses;
    this.onToolCall = onToolCall;
  }

  /**
   * Execute a single tool
   */
  async execute(
    toolName: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    // Check custom responses first
    const customFn = this.customResponses[toolName];
    if (customFn) {
      const result = customFn(params);
      this.onToolCall?.(toolName, params, result);
      return result;
    }

    // Check default mock responses
    const mockFn = MOCK_TOOL_RESPONSES[toolName];
    if (mockFn) {
      const result = mockFn(params);
      this.onToolCall?.(toolName, params, result);
      return result;
    }

    // Unknown tool - return empty result
    console.warn(`[MockToolExecutor] No mock for tool: ${toolName}`);
    const result = { _warning: `No mock implementation for tool: ${toolName}` };
    this.onToolCall?.(toolName, params, result);
    return result;
  }

  /**
   * Execute multiple tools in parallel
   */
  async executeParallel(
    calls: Array<{ name: string; params: Record<string, unknown> }>,
    timeoutMs: number,
  ): Promise<Array<{ name: string; result?: unknown; error?: string }>> {
    const results = await Promise.all(
      calls.map(async (call) => {
        try {
          const result = await this.execute(call.name, call.params, timeoutMs);
          return { name: call.name, result };
        } catch (error) {
          return {
            name: call.name,
            error: error instanceof Error ? error.message : 'Unknown error',
          };
        }
      }),
    );

    return results;
  }

  /**
   * Register a custom mock response for a tool
   */
  registerMock(toolName: string, handler: (params: Record<string, unknown>) => unknown): void {
    this.customResponses[toolName] = handler;
  }

  /**
   * Get all available mock tool names
   */
  getAvailableTools(): string[] {
    return [...Object.keys(MOCK_TOOL_RESPONSES), ...Object.keys(this.customResponses)];
  }
}

/**
 * Get the default mock tool responses
 */
export function getDefaultMockResponses(): Record<
  string,
  (params: Record<string, unknown>) => unknown
> {
  return { ...MOCK_TOOL_RESPONSES };
}

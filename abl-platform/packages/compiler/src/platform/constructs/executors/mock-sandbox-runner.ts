/**
 * Mock Sandbox Runner
 *
 * Lightweight SandboxRunner for local development without infrastructure
 * (no K8s pods or AWS Lambda). Activated via SANDBOX_BACKEND=mock.
 *
 * Resolution order:
 * 1. Dynamic mock: if params contain `mockResponse`, return it directly
 * 2. Static registry: if tool name exists in MOCK_RESPONSES, return it
 * 3. JS code eval: evaluate seeded JS code via `new Function()`
 * 4. Python fallback: extract return values from Python code via regex
 *
 * SECURITY: Uses `new Function()` (own scope) — not `eval()`.
 * The `validateCodeContent` check in SandboxToolExecutor already runs
 * before the runner, blocking path traversal / null bytes.
 */

import type { SandboxRunner } from './sandbox-tool-executor.js';
import type { GvisorSessionContext } from './gvisor-sandbox-runner.js';
import { createLogger } from '../../logger.js';

const log = createLogger('mock-sandbox-runner');

/**
 * Execute JavaScript code_content from seeded mock tools.
 *
 * Seeded code is typically `return { ... };` — wrap in a Function and call it.
 * Passes params as individual $-prefixed args (matching Gvisor convention).
 */
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as typeof Function;

async function executeJsMockCode(
  codeContent: string,
  params: unknown,
  timeoutMs: number,
  globals?: Record<string, unknown>,
): Promise<unknown> {
  const code = codeContent.trim();
  if (!code) {
    return { success: true, message: 'mock executed (empty code)' };
  }

  const paramObj = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
  const argNames = Object.keys(paramObj).map((k) => `$${k}`);
  const argValues = Object.values(paramObj);

  // Inject globals: params (whole object), fetch, plus any from globals map
  const globalNames = ['params', 'fetch'];
  const globalValues: unknown[] = [paramObj, globalThis.fetch];
  if (globals) {
    for (const [key, value] of Object.entries(globals)) {
      if (!globalNames.includes(key)) {
        globalNames.push(key);
        globalValues.push(value);
      }
    }
  }

  const allArgNames = [...globalNames, ...argNames];
  const allArgValues = [...globalValues, ...argValues];

  const executionPromise = (async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const fn = new AsyncFunction(...allArgNames, code);
      return await fn(...allArgValues);
    } catch (err: unknown) {
      throw new Error(
        `Mock JS execution failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();

  if (timeoutMs > 0) {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`Sandbox execution timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    return Promise.race([executionPromise, timeoutPromise]);
  }

  return executionPromise;
}

/**
 * Extract a return value from Python code_content.
 *
 * Python can't be eval'd in Node. Try to extract JSON from `return {...}` or
 * `return [...]` patterns via regex. If that fails, return a generic success response.
 */
function executePyMockCode(codeContent: string, functionName: string): unknown {
  const code = codeContent.trim();
  if (!code) {
    return { success: true, message: `${functionName} executed (mock)` };
  }

  // Try to extract return value: `return { ... }` or `return [ ... ]`
  const returnMatch = code.match(/return\s+(\{[\s\S]*\}|\[[\s\S]*\])\s*$/m);
  if (returnMatch) {
    try {
      // Attempt to parse the extracted value as JSON
      // Python dicts use single quotes — replace them for JSON compatibility
      const jsonStr = returnMatch[1]
        .replace(/'/g, '"')
        .replace(/True/g, 'true')
        .replace(/False/g, 'false')
        .replace(/None/g, 'null');
      return JSON.parse(jsonStr);
    } catch {
      // Could not parse — fall through to generic response
    }
  }

  return { success: true, message: `${functionName} executed (mock)` };
}

export class MockSandboxRunner implements SandboxRunner {
  private staticResponses: Record<string, unknown>;

  constructor(
    private sessionContext?: GvisorSessionContext,
    staticResponses?: Record<string, unknown>,
  ) {
    this.staticResponses = staticResponses ?? {};
  }

  async run(config: {
    functionName: string;
    runtime: 'javascript' | 'python';
    codeContent: string;
    params: unknown;
    limits: { timeoutMs: number; memoryMb: number };
    globals?: Record<string, unknown>;
  }): Promise<unknown> {
    const { functionName, runtime, codeContent, params, limits, globals } = config;

    const start = Date.now();

    log.info('Mock sandbox execute', {
      tool: functionName,
      runtime,
      codeSize: codeContent?.length ?? 0,
      tenantId: this.sessionContext?.tenantId,
      sessionId: this.sessionContext?.sessionId,
    });

    // 1. Dynamic mock: if params has `mockResponse`, return it directly
    const p = params as Record<string, unknown> | undefined;
    if (p && typeof p === 'object' && 'mockResponse' in p) {
      log.info('Mock sandbox returning dynamic mockResponse', {
        tool: functionName,
        path: 'dynamic-mock',
        durationMs: Date.now() - start,
      });
      return p.mockResponse;
    }

    // 2. Static registry: known seeded tool → return pre-defined response
    if (functionName in this.staticResponses) {
      log.info('Mock sandbox returning static response', {
        tool: functionName,
        path: 'static-registry',
        durationMs: Date.now() - start,
      });
      return this.staticResponses[functionName];
    }

    // 3. Execute code based on runtime
    if (runtime === 'javascript') {
      const result = await executeJsMockCode(codeContent, params, limits.timeoutMs, globals);
      log.info('Mock sandbox JS execution complete', {
        tool: functionName,
        path: 'js-eval',
        durationMs: Date.now() - start,
        resultType: typeof result,
      });
      return result;
    }

    // 4. Python: attempt static extraction, else generic success
    const result = executePyMockCode(codeContent, functionName);
    log.info('Mock sandbox Python fallback complete', {
      tool: functionName,
      path: 'python-fallback',
      durationMs: Date.now() - start,
      resultType: typeof result,
    });
    return result;
  }
}

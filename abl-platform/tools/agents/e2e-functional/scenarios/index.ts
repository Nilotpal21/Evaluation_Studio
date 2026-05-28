/**
 * Scenario registry and runner utilities.
 */

import type { ScenarioResult, ScenarioContext, ScenarioFn } from '../types.js';

export interface RegisteredScenario {
  id: number;
  name: string;
  fn: ScenarioFn;
  method: 'fetch' | 'agent-sdk';
}

const registry: RegisteredScenario[] = [];

export function registerScenario(
  id: number,
  name: string,
  fn: ScenarioFn,
  method: 'fetch' | 'agent-sdk' = 'fetch',
): void {
  registry.push({ id, name, fn, method });
}

export function getScenarios(filter?: number[]): RegisteredScenario[] {
  const sorted = [...registry].sort((a, b) => a.id - b.id);
  if (!filter || filter.length === 0) return sorted;
  return sorted.filter((s) => filter.includes(s.id));
}

export async function runScenario(
  scenario: RegisteredScenario,
  ctx: ScenarioContext,
): Promise<ScenarioResult> {
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      scenario.fn(ctx),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`Scenario ${scenario.id} timed out after ${ctx.scenarioTimeoutMs}ms`)),
          ctx.scenarioTimeoutMs,
        );
      }),
    ]);
    clearTimeout(timer);
    return result;
  } catch (err) {
    clearTimeout(timer);
    return {
      id: scenario.id,
      name: scenario.name,
      passed: false,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Helper for direct fetch calls to Runtime/Studio APIs.
 */
export async function fetchJson<T>(
  url: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; data: T; headers: Headers }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.headers,
  };
  if (options.token) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }

  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const data = (await response.json().catch(() => null)) as T;
  return { status: response.status, data, headers: response.headers };
}

/**
 * Helper to read SSE events from a streaming response.
 */
export async function readSSEEvents(
  url: string,
  options: { body: unknown; token: string },
): Promise<{
  status: number;
  contentType: string;
  events: Array<{ event: string; data: unknown }>;
}> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.token}`,
    },
    body: JSON.stringify(options.body),
  });

  const contentType = response.headers.get('content-type') ?? '';
  const events: Array<{ event: string; data: unknown }> = [];

  if (!response.body) {
    return { status: response.status, contentType, events };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        const raw = line.slice(6).trim();
        let data: unknown;
        try {
          data = JSON.parse(raw);
        } catch {
          data = raw;
        }
        events.push({ event: currentEvent || 'message', data });
        currentEvent = '';
      }
    }
  }

  return { status: response.status, contentType, events };
}

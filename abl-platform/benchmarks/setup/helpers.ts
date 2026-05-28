// benchmarks/setup/helpers.ts
import http from 'k6/http';
import { sleep } from 'k6';

/**
 * Poll a URL until a condition is met or timeout.
 * @returns The final response body parsed as JSON, or null on timeout.
 */
export function pollUntil(
  url: string,
  headers: Record<string, string>,
  condition: (body: Record<string, unknown>) => boolean,
  opts: { intervalSec?: number; timeoutSec?: number; label?: string } = {},
): Record<string, unknown> | null {
  const interval = opts.intervalSec ?? 10;
  const timeout = opts.timeoutSec ?? 600;
  const label = opts.label ?? 'poll';
  const maxAttempts = Math.ceil(timeout / interval);

  for (let i = 0; i < maxAttempts; i++) {
    const res = http.get(url, { headers });
    if (res.status === 200) {
      const body = res.json() as Record<string, unknown>;
      if (condition(body)) {
        console.log(`[${label}] Condition met after ${i * interval}s`);
        return body;
      }
    }
    sleep(interval);
  }
  console.error(`[${label}] Timed out after ${timeout}s`);
  return null;
}

/**
 * Make an HTTP request with retry on 5xx errors.
 */
export function httpWithRetry(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  body: string | null,
  headers: Record<string, string>,
  opts: { maxRetries?: number; label?: string } = {},
) {
  const maxRetries = opts.maxRetries ?? 3;
  const label = opts.label ?? url;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res =
      method === 'GET'
        ? http.get(url, { headers })
        : method === 'POST'
          ? http.post(url, body, { headers })
          : http.del(url, body, { headers });

    if (res.status < 500) {
      return res;
    }
    console.warn(`[${label}] Attempt ${attempt + 1} got ${res.status}, retrying...`);
    if (attempt < maxRetries) {
      sleep(2 * (attempt + 1));
    }
  }
  // Return last response even on failure
  return method === 'GET'
    ? http.get(url, { headers })
    : method === 'POST'
      ? http.post(url, body, { headers })
      : http.del(url, body, { headers });
}

/**
 * Assert a response status and log on failure.
 */
export function assertStatus(
  res: { status: number; body: string | ArrayBuffer | null },
  expectedStatuses: number[],
  label: string,
): boolean {
  const ok = expectedStatuses.includes(res.status);
  if (!ok) {
    console.error(
      `[${label}] Expected ${expectedStatuses.join('|')}, got ${res.status}: ${res.body}`,
    );
  }
  return ok;
}

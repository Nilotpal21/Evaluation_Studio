export const BROWSER_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const BROWSER_IDLE_TIMEOUT_SECONDS = Math.floor(BROWSER_IDLE_TIMEOUT_MS / 1000);

const DEFAULT_DURATION_SECONDS = 15 * 60;

export interface ResolvedTimeoutValue {
  value?: number;
  source?: string;
}

export interface StudioSessionTimeoutDiagnostics {
  browserIdle: {
    valueMs: number;
    valueSeconds: number;
    source: 'studio_client_idle';
  };
  authToken: {
    accessExpiry: string;
    accessTtlSeconds: number;
    source: 'studio_jwt';
  };
  runtime: {
    idleSeconds: ResolvedTimeoutValue;
    maxAgeSeconds: ResolvedTimeoutValue;
  };
}

function decodeBase64Url(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');

  if (typeof atob === 'function') {
    return atob(padded);
  }

  return Buffer.from(padded, 'base64').toString('utf8');
}

export function parseDurationToSeconds(
  value: string | null | undefined,
  fallbackSeconds = DEFAULT_DURATION_SECONDS,
): number {
  if (!value) {
    return fallbackSeconds;
  }

  const match = value.match(/^(\d+)([smhd])$/);
  if (!match) {
    return fallbackSeconds;
  }

  const amount = Number.parseInt(match[1], 10);
  switch (match[2]) {
    case 's':
      return amount;
    case 'm':
      return amount * 60;
    case 'h':
      return amount * 60 * 60;
    case 'd':
      return amount * 24 * 60 * 60;
    default:
      return fallbackSeconds;
  }
}

export function getTokenRemainingLifetimeSeconds(
  accessToken: string | null | undefined,
  nowMs = Date.now(),
): number | null {
  if (!accessToken) {
    return null;
  }

  try {
    const parts = accessToken.split('.');
    if (parts.length < 2) {
      return null;
    }

    const payload = JSON.parse(decodeBase64Url(parts[1] ?? '')) as { exp?: number };
    if (typeof payload.exp !== 'number') {
      return null;
    }

    return Math.max(payload.exp - Math.floor(nowMs / 1000), 0);
  } catch {
    return null;
  }
}

export function formatDurationFromSeconds(seconds?: number): string {
  if (seconds === undefined) {
    return '--';
  }

  if (seconds < 60) {
    return `${seconds}s`;
  }

  if (seconds < 60 * 60) {
    const minutes = seconds / 60;
    return Number.isInteger(minutes) ? `${minutes}m` : `${minutes.toFixed(1)}m`;
  }

  const hours = seconds / (60 * 60);
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

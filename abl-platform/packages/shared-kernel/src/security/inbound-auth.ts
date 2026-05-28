/**
 * Inbound Channel Authentication Helpers
 *
 * Shared utilities for authenticating inbound channel traffic using
 * pre-shared tokens from headers, bearer auth, or query params.
 */

import crypto from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export const QUERY_TOKEN_TRANSPORT_ALLOWLIST = {
  audiocodes_http: {
    surface: 'AudioCodes HTTP ingress',
    migrationTarget: 'Move provider requests to ingress secret headers once available.',
  },
  audiocodes_ws: {
    surface: 'AudioCodes WebSocket ingress',
    migrationTarget: 'Move provider WebSocket auth off URL tokens when the upstream supports it.',
  },
  korevg_ws: {
    surface: 'Korevg/Jambonz WebSocket ingress',
    migrationTarget: 'Replace URL tokens with provider-supported headers or signed session setup.',
  },
  twilio_ws: {
    surface: 'Twilio Media Stream WebSocket ingress',
    migrationTarget: 'Replace URL HMAC token with Twilio signature verification once available.',
  },
  vxml_http: {
    surface: 'VXML HTTP ingress',
    migrationTarget: 'Move telephony webhook auth to ingress secret headers.',
  },
} as const;

export type QueryTokenTransport = keyof typeof QUERY_TOKEN_TRANSPORT_ALLOWLIST;

export interface ExtractIngressTokenOptions {
  allowQueryTokenFor?: QueryTokenTransport;
}

function normalizeToken(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return normalizeToken(value[0]);
  }
  return normalizeToken(value);
}

export function extractIngressToken(
  headers: IncomingHttpHeaders,
  queryToken?: string | null,
  options: ExtractIngressTokenOptions = {},
): string | null {
  const explicitHeader =
    normalizeHeaderValue(headers['x-channel-secret']) ||
    normalizeHeaderValue(headers['x-ingress-secret']) ||
    normalizeHeaderValue(headers['x-webhook-secret']);
  if (explicitHeader) return explicitHeader;

  const authHeader = normalizeHeaderValue(headers.authorization);
  if (authHeader?.startsWith('Bearer ')) {
    return normalizeToken(authHeader.slice('Bearer '.length));
  }

  if (!options.allowQueryTokenFor) {
    return null;
  }

  return normalizeToken(queryToken);
}

export function tokensMatch(providedToken: string | null, expectedToken: string | null): boolean {
  if (!providedToken || !expectedToken) return false;

  const provided = Buffer.from(providedToken);
  const expected = Buffer.from(expectedToken);
  if (provided.length !== expected.length) return false;

  return crypto.timingSafeEqual(provided, expected);
}

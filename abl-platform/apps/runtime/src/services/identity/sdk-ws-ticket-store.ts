import { createHash, randomBytes } from 'node:crypto';
import type { SDKSessionTokenPayload, SDKTokenEnvelopeMode } from '@agent-platform/shared-auth';
import { createLogger } from '@abl/compiler/platform';
import { getRedisClient } from '../redis/redis-client.js';

const log = createLogger('sdk-ws-ticket-store');

export const SDK_WS_TICKET_TTL_SECONDS = 60;

export interface RedisTicketClient {
  set(
    key: string,
    value: string,
    mode: 'EX',
    ttlSeconds: number,
    condition: 'NX',
  ): Promise<'OK' | null>;
  getdel(key: string): Promise<string | null>;
}

let testRedisTicketClient: RedisTicketClient | null = null;

export interface SdkWsTicketRecord {
  payload: SDKSessionTokenPayload;
  envelope: SDKTokenEnvelopeMode;
  issuedAtMs: number;
  expiresAtMs: number;
}

export type SdkWsTicketIssueResult =
  | { success: true; ticket: string; expiresIn: number }
  | { success: false; reason: 'unavailable' };

export type SdkWsTicketConsumeResult =
  | { success: true; record: SdkWsTicketRecord }
  | { success: false; reason: 'missing' | 'expired' | 'invalid' | 'unavailable' };

function getRedisTicketClient(): RedisTicketClient | null {
  if (testRedisTicketClient) {
    return testRedisTicketClient;
  }

  const client = getRedisClient();
  return client ? (client as unknown as RedisTicketClient) : null;
}

export function setSdkWsTicketRedisClientForTesting(client: RedisTicketClient | null): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('setSdkWsTicketRedisClientForTesting is only available in test environments');
  }

  testRedisTicketClient = client;
}

function ticketKey(ticket: string): string {
  const digest = createHash('sha256').update(ticket).digest('hex');
  return `sdk:ws-ticket:${digest}`;
}

function issueRawTicket(): string {
  return randomBytes(32).toString('base64url');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isSdkSessionTokenPayload(value: unknown): value is SDKSessionTokenPayload {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.type === 'sdk_session' &&
    typeof value.tenantId === 'string' &&
    value.tenantId.trim().length > 0 &&
    typeof value.projectId === 'string' &&
    value.projectId.trim().length > 0 &&
    typeof value.channelId === 'string' &&
    value.channelId.trim().length > 0 &&
    typeof value.sessionId === 'string' &&
    value.sessionId.trim().length > 0 &&
    typeof value.sessionPrincipal === 'string' &&
    value.sessionPrincipal.trim().length > 0 &&
    isStringArray(value.permissions) &&
    typeof value.iat === 'number' &&
    Number.isFinite(value.iat) &&
    typeof value.exp === 'number' &&
    Number.isFinite(value.exp)
  );
}

function minimizeTicketPayload(payload: SDKSessionTokenPayload): SDKSessionTokenPayload {
  return {
    type: payload.type,
    tenantId: payload.tenantId,
    projectId: payload.projectId,
    channelId: payload.channelId,
    permissions: [...payload.permissions],
    iat: payload.iat,
    exp: payload.exp,
    ...(payload.deploymentId ? { deploymentId: payload.deploymentId } : {}),
    ...(payload.environment ? { environment: payload.environment } : {}),
    ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
    ...(payload.sessionPrincipal ? { sessionPrincipal: payload.sessionPrincipal } : {}),
    ...(payload.userContext ? { userContext: payload.userContext } : {}),
    ...(payload.verifiedUserId ? { verifiedUserId: payload.verifiedUserId } : {}),
    ...(typeof payload.identityTier === 'number' ? { identityTier: payload.identityTier } : {}),
    ...(payload.verificationMethod ? { verificationMethod: payload.verificationMethod } : {}),
    ...(payload.authScope ? { authScope: payload.authScope } : {}),
    ...(payload.channelArtifact ? { channelArtifact: payload.channelArtifact } : {}),
    ...(payload.bootstrapType ? { bootstrapType: payload.bootstrapType } : {}),
    ...(payload.bootstrapKeyId ? { bootstrapKeyId: payload.bootstrapKeyId } : {}),
    ...(typeof payload.bootstrapExpiresAt === 'number'
      ? { bootstrapExpiresAt: payload.bootstrapExpiresAt }
      : {}),
  };
}

function parseTicketRecord(raw: string): SdkWsTicketRecord | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    const { payload, envelope, issuedAtMs, expiresAtMs } = parsed;
    if (
      !isSdkSessionTokenPayload(payload) ||
      (envelope !== 'signed' && envelope !== 'jwe') ||
      typeof issuedAtMs !== 'number' ||
      !Number.isFinite(issuedAtMs) ||
      typeof expiresAtMs !== 'number' ||
      !Number.isFinite(expiresAtMs)
    ) {
      return null;
    }

    return { payload, envelope, issuedAtMs, expiresAtMs };
  } catch {
    return null;
  }
}

export async function issueSdkWsTicket(
  payload: SDKSessionTokenPayload,
  envelope: SDKTokenEnvelopeMode,
): Promise<SdkWsTicketIssueResult> {
  const redis = getRedisTicketClient();
  if (!redis) {
    return { success: false, reason: 'unavailable' };
  }

  const now = Date.now();
  const record: SdkWsTicketRecord = {
    payload: minimizeTicketPayload(payload),
    envelope,
    issuedAtMs: now,
    expiresAtMs: now + SDK_WS_TICKET_TTL_SECONDS * 1000,
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const ticket = issueRawTicket();
    try {
      const result = await redis.set(
        ticketKey(ticket),
        JSON.stringify(record),
        'EX',
        SDK_WS_TICKET_TTL_SECONDS,
        'NX',
      );
      if (result === 'OK') {
        return { success: true, ticket, expiresIn: SDK_WS_TICKET_TTL_SECONDS };
      }
    } catch (error) {
      log.warn('Failed to issue SDK WebSocket ticket', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { success: false, reason: 'unavailable' };
    }
  }

  log.warn('Failed to issue SDK WebSocket ticket after collision retries');
  return { success: false, reason: 'unavailable' };
}

export async function consumeSdkWsTicket(ticket: string): Promise<SdkWsTicketConsumeResult> {
  const redis = getRedisTicketClient();
  if (!redis) {
    return { success: false, reason: 'unavailable' };
  }

  try {
    const raw = await redis.getdel(ticketKey(ticket));
    if (!raw) {
      return { success: false, reason: 'missing' };
    }

    const record = parseTicketRecord(raw);
    if (!record) {
      return { success: false, reason: 'invalid' };
    }

    if (record.expiresAtMs <= Date.now()) {
      return { success: false, reason: 'expired' };
    }

    return { success: true, record };
  } catch (error) {
    log.warn('Failed to consume SDK WebSocket ticket', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { success: false, reason: 'unavailable' };
  }
}

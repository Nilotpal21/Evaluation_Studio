import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { JWTPayload, SDKSessionTokenPayload, SDKSessionSource } from './types/index.js';

export const PLATFORM_JWT_ISSUER = 'abl-platform' as const;
export const PLATFORM_ACCESS_TOKEN_AUDIENCE = 'platform-access' as const;
export const SDK_SESSION_TOKEN_AUDIENCE = 'sdk-session' as const;
export const STUDIO_SESSION_TOKEN_AUDIENCE = 'studio-session' as const;
export const FEEDBACK_TOKEN_AUDIENCE = 'feedback' as const;
export const GUPSHUP_WEBHOOK_TOKEN_AUDIENCE = 'gupshup-webhook' as const;

export const FEEDBACK_TOKEN_PURPOSE = 'email_csat' as const;
export const GUPSHUP_WEBHOOK_TOKEN_PURPOSE = 'gupshup_webhook' as const;

export type AuthErrorCode =
  | 'INVALID_TOKEN'
  | 'EXPIRED_TOKEN'
  | 'WRONG_AUDIENCE'
  | 'WRONG_ISSUER'
  | 'WRONG_PURPOSE'
  | 'WRONG_SOURCE'
  | 'INVALID_PAYLOAD';

export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

export interface FeedbackTokenPayload {
  tenantId: string;
  projectId: string;
  sessionId: string;
  messageId: string;
  connectionId: string;
}

export type GupshupWebhookTokenPayload = Record<string, unknown>;

type JwtRecord = jwt.JwtPayload & Record<string, unknown>;

type ExpiresIn = jwt.SignOptions['expiresIn'];

const END_USER_SDK_SOURCES = new Set<SDKSessionSource>(['sdk', 'channel', 'public']);

function classifyJwtError(error: unknown): AuthError {
  if (error instanceof AuthError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof jwt.TokenExpiredError) {
    return new AuthError('EXPIRED_TOKEN', message);
  }
  if (message.toLowerCase().includes('audience')) {
    return new AuthError('WRONG_AUDIENCE', message);
  }
  if (message.toLowerCase().includes('issuer')) {
    return new AuthError('WRONG_ISSUER', message);
  }
  return new AuthError('INVALID_TOKEN', message);
}

function verifyPurposeJwt(
  token: string,
  secret: string,
  audience: string,
  options: { algorithms?: jwt.Algorithm[] } = {},
): JwtRecord {
  try {
    const decoded = jwt.verify(token, secret, {
      issuer: PLATFORM_JWT_ISSUER,
      audience,
      ...(options.algorithms ? { algorithms: options.algorithms } : {}),
    });

    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw new AuthError('INVALID_PAYLOAD', 'JWT payload must be an object');
    }

    return decoded as JwtRecord;
  } catch (error) {
    throw classifyJwtError(error);
  }
}

function buildSignOptions(audience: string, expiresIn?: ExpiresIn): jwt.SignOptions {
  return {
    issuer: PLATFORM_JWT_ISSUER,
    audience,
    ...(expiresIn !== undefined ? { expiresIn } : {}),
  };
}

function requireStringClaim(payload: JwtRecord, claim: string): string {
  const value = payload[claim];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AuthError('INVALID_PAYLOAD', `Token missing ${claim} claim`);
  }
  return value;
}

function assertSdkSource(payload: JwtRecord): void {
  const source = payload.source;
  if (source === undefined) {
    return;
  }

  if (typeof source !== 'string' || !END_USER_SDK_SOURCES.has(source as SDKSessionSource)) {
    throw new AuthError('WRONG_SOURCE', 'SDK session token has an invalid source');
  }
}

export function signPlatformAccessToken(
  payload: Record<string, unknown>,
  secret: string,
  options: { expiresIn?: ExpiresIn } = {},
): string {
  return jwt.sign(
    payload,
    secret,
    buildSignOptions(PLATFORM_ACCESS_TOKEN_AUDIENCE, options.expiresIn),
  );
}

export function verifyPlatformAccessToken(token: string, secret: string): JWTPayload {
  const payload = verifyPurposeJwt(token, secret, PLATFORM_ACCESS_TOKEN_AUDIENCE);
  if (payload.type !== 'access' && payload.type !== 'mfa_pending') {
    throw new AuthError('WRONG_PURPOSE', 'Token is not a platform access token');
  }
  requireStringClaim(payload, 'sub');
  return payload as unknown as JWTPayload;
}

export function signSDKSessionToken(
  payload: Omit<SDKSessionTokenPayload, 'iat' | 'exp'>,
  secret: string,
  options: { expiresIn?: ExpiresIn } = {},
): string {
  const source = payload.source ?? 'sdk';
  if (!END_USER_SDK_SOURCES.has(source)) {
    throw new AuthError('WRONG_SOURCE', 'SDK session token source must be end-user scoped');
  }

  return jwt.sign(
    { ...payload, source },
    secret,
    buildSignOptions(SDK_SESSION_TOKEN_AUDIENCE, options.expiresIn),
  );
}

export function verifySDKSessionToken(token: string, secret: string): SDKSessionTokenPayload {
  const payload = verifyPurposeJwt(token, secret, SDK_SESSION_TOKEN_AUDIENCE);
  if (payload.type !== 'sdk_session') {
    throw new AuthError('WRONG_PURPOSE', 'Token is not an SDK session token');
  }
  assertSdkSource(payload);
  requireStringClaim(payload, 'tenantId');
  requireStringClaim(payload, 'projectId');
  requireStringClaim(payload, 'channelId');
  return payload as unknown as SDKSessionTokenPayload;
}

export function verifyStudioSessionToken(token: string, secret: string): JwtRecord {
  const payload = verifyPurposeJwt(token, secret, STUDIO_SESSION_TOKEN_AUDIENCE);
  if (payload.source !== 'studio') {
    throw new AuthError('WRONG_SOURCE', 'Studio session token source must be studio');
  }
  return payload;
}

export function signFeedbackToken(
  payload: FeedbackTokenPayload,
  secret: string,
  options: { expiresIn?: ExpiresIn } = {},
): string {
  return jwt.sign(
    { purpose: FEEDBACK_TOKEN_PURPOSE, ...payload },
    secret,
    buildSignOptions(FEEDBACK_TOKEN_AUDIENCE, options.expiresIn),
  );
}

export function verifyFeedbackToken(token: string, secret: string): FeedbackTokenPayload {
  const payload = verifyPurposeJwt(token, secret, FEEDBACK_TOKEN_AUDIENCE);
  if (payload.purpose !== FEEDBACK_TOKEN_PURPOSE) {
    throw new AuthError('WRONG_PURPOSE', 'Token is not a feedback token');
  }

  return {
    tenantId: requireStringClaim(payload, 'tenantId'),
    projectId: requireStringClaim(payload, 'projectId'),
    sessionId: requireStringClaim(payload, 'sessionId'),
    messageId: requireStringClaim(payload, 'messageId'),
    connectionId: requireStringClaim(payload, 'connectionId'),
  };
}

export function signGupshupWebhookToken(
  payload: GupshupWebhookTokenPayload,
  secret: string,
  options: { expiresIn?: ExpiresIn; algorithm?: jwt.Algorithm } = {},
): string {
  return jwt.sign({ purpose: GUPSHUP_WEBHOOK_TOKEN_PURPOSE, ...payload }, secret, {
    ...buildSignOptions(GUPSHUP_WEBHOOK_TOKEN_AUDIENCE, options.expiresIn),
    algorithm: options.algorithm ?? 'HS256',
  });
}

export function verifyGupshupWebhookToken(
  token: string,
  secret: string,
  options: { algorithms?: jwt.Algorithm[] } = {},
): GupshupWebhookTokenPayload {
  const payload = verifyPurposeJwt(token, secret, GUPSHUP_WEBHOOK_TOKEN_AUDIENCE, {
    algorithms: options.algorithms ?? ['HS256'],
  });
  if (payload.purpose !== GUPSHUP_WEBHOOK_TOKEN_PURPOSE) {
    throw new AuthError('WRONG_PURPOSE', 'Token is not a Gupshup webhook token');
  }
  return payload;
}

// ─── Citation Tokens ─────────────────────────────────────────────────
export const CITATION_TOKEN_AUDIENCE = 'citation-download' as const;
export const CITATION_TOKEN_PURPOSE = 'document_download' as const;

export interface CitationTokenPayload {
  tenantId: string;
  indexId: string;
  documentId: string;
  /** S3 key (NOT full s3:// URL). Extracted by CitationTokenService.extractS3Key() */
  sourceKey: string;
  /** Link mode from citationConfig at sign time */
  linkMode: 'direct' | 'time_limited' | 'click_limited';
  /** Max clicks (only relevant for click_limited mode) */
  maxClicks?: number;
}

export function signCitationToken(
  payload: CitationTokenPayload,
  secret: string,
  options: { expiresIn?: ExpiresIn } = {},
): string {
  return jwt.sign(
    { purpose: CITATION_TOKEN_PURPOSE, jti: crypto.randomUUID(), ...payload },
    secret,
    buildSignOptions(CITATION_TOKEN_AUDIENCE, options.expiresIn),
  );
}

export function verifyCitationToken(
  token: string,
  secret: string,
): CitationTokenPayload & { jti: string; exp?: number } {
  const payload = verifyPurposeJwt(token, secret, CITATION_TOKEN_AUDIENCE);
  if (payload.purpose !== CITATION_TOKEN_PURPOSE) {
    throw new AuthError('WRONG_PURPOSE', 'Token is not a citation download token');
  }

  const linkMode = payload.linkMode as string;
  if (!['direct', 'time_limited', 'click_limited'].includes(linkMode)) {
    throw new AuthError('INVALID_PAYLOAD', `Invalid citation link mode: ${linkMode}`);
  }

  return {
    tenantId: requireStringClaim(payload, 'tenantId'),
    indexId: requireStringClaim(payload, 'indexId'),
    documentId: requireStringClaim(payload, 'documentId'),
    sourceKey: requireStringClaim(payload, 'sourceKey'),
    linkMode: linkMode as CitationTokenPayload['linkMode'],
    maxClicks: typeof payload.maxClicks === 'number' ? payload.maxClicks : undefined,
    jti: requireStringClaim(payload, 'jti'),
    exp: typeof payload.exp === 'number' ? payload.exp : undefined,
  };
}

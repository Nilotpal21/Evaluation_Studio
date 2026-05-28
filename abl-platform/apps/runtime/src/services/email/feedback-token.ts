/**
 * Feedback Token
 *
 * Signs and verifies JWT tokens for email CSAT feedback links.
 * Tokens encode the message context so the feedback endpoint can
 * record ratings without requiring authentication.
 */

import {
  signFeedbackToken as signSharedFeedbackToken,
  verifyFeedbackToken as verifySharedFeedbackToken,
} from '@agent-platform/shared-auth';

const FEEDBACK_TOKEN_TTL_SECONDS = 30 * 24 * 3600; // 30 days

export interface FeedbackTokenPayload {
  tenantId: string;
  projectId: string;
  sessionId: string;
  messageId: string;
  connectionId: string;
}

function getSecret(): string {
  const secret =
    process.env.FEEDBACK_JWT_SECRET?.trim() ||
    process.env.AUTH_FEEDBACK_SIGNING_SECRET?.trim() ||
    (process.env.NODE_ENV === 'test' ? process.env.JWT_SECRET?.trim() : undefined);
  if (!secret) throw new Error('FEEDBACK_JWT_SECRET environment variable is required');
  return secret;
}

export function signFeedbackToken(payload: FeedbackTokenPayload): string {
  return signSharedFeedbackToken(payload, getSecret(), {
    expiresIn: FEEDBACK_TOKEN_TTL_SECONDS,
  });
}

export function verifyFeedbackToken(token: string): FeedbackTokenPayload | null {
  try {
    return verifySharedFeedbackToken(token, getSecret());
  } catch {
    return null;
  }
}

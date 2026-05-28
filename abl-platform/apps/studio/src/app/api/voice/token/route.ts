/**
 * POST /api/voice/token - Get Twilio access token for Voice SDK
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rate-limit';
import { getConfig, isConfigLoaded } from '@/config';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('voice');

export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const rl = await checkRateLimit(`voice-token:${user.id}`, 10, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    );
  }

  const cfg = isConfigLoaded() ? getConfig() : null;
  const accountSid = cfg?.voice.twilio.accountSid || process.env.TWILIO_ACCOUNT_SID;
  const apiKeySid = cfg?.voice.twilio.apiKeySid || process.env.TWILIO_API_KEY_SID;
  const apiKeySecret = cfg?.voice.twilio.apiKeySecret || process.env.TWILIO_API_KEY_SECRET;
  const twimlAppSid = cfg?.voice.twilio.twimlAppSid || process.env.TWILIO_TWIML_APP_SID;

  if (!accountSid || !apiKeySid || !apiKeySecret || !twimlAppSid) {
    return NextResponse.json({ error: 'Voice service not configured' }, { status: 503 });
  }

  try {
    // Dynamically import twilio to avoid errors when not installed
    // @ts-ignore - twilio types may not be available in studio
    const twilio: any = await import(/* webpackIgnore: true */ 'twilio');
    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: twimlAppSid,
      incomingAllow: true,
    });

    const token = new AccessToken(accountSid, apiKeySid, apiKeySecret, {
      identity: user.id,
      ttl: 3600,
    });
    token.addGrant(voiceGrant);

    return NextResponse.json({
      token: token.toJwt(),
      identity: user.id,
      expiresIn: 3600,
    });
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as any).code === 'MODULE_NOT_FOUND') {
      return NextResponse.json(
        { error: 'Voice service dependencies not installed' },
        { status: 503 },
      );
    }
    log.error('Token generation error', { err: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to generate voice token' }, { status: 500 });
  }
}

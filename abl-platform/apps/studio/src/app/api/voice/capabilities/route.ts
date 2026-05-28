/**
 * GET /api/voice/capabilities - Check voice service capabilities
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { getConfig, isConfigLoaded } from '@/config';

export async function GET(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const cfg = isConfigLoaded() ? getConfig() : null;
  const twilio = cfg?.voice.twilio;

  const twilioConfigured = !!(
    (twilio?.accountSid || process.env.TWILIO_ACCOUNT_SID) &&
    (twilio?.apiKeySid || process.env.TWILIO_API_KEY_SID) &&
    (twilio?.apiKeySecret || process.env.TWILIO_API_KEY_SECRET) &&
    (twilio?.twimlAppSid || process.env.TWILIO_TWIML_APP_SID)
  );

  return NextResponse.json({
    voice: {
      enabled: twilioConfigured,
      twilio: twilioConfigured,
      stt: {
        provider: 'deepgram',
        configured: !!(cfg?.voice.deepgram.apiKey || process.env.DEEPGRAM_API_KEY),
      },
      tts: {
        provider: 'elevenlabs',
        configured: !!(cfg?.voice.elevenLabs.apiKey || process.env.ELEVENLABS_API_KEY),
      },
    },
  });
}

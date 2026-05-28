import { createLogger } from '@abl/compiler/platform';
import type { VoiceGatewaySession } from '@agent-platform/agent-transfer';

const log = createLogger('voice-csat');

export interface VoiceCsatData {
  userId: string;
  conversationId: string;
  channel: string;
  surveyType: 'csat' | 'nps' | 'likeDislike';
  botId?: string;
  orgId?: string;
}

export interface VoiceCsatOptions {
  sessionId: string;
  voiceSession: VoiceGatewaySession;
  csatData: VoiceCsatData;
  prompt: string;
  thankYouMessage: string;
  submitRating: (score: number, surveyType: string) => Promise<unknown>;
  onComplete: (score: number) => void;
  onSkip: (reason: string) => void;
}

const CSAT_SCORES: Record<string, number> = {
  '1': 1,
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
};

const LIKE_DISLIKE_SCORES: Record<string, number> = {
  '0': 0,
  '1': 1,
};

function resolveVoiceCsatScore(
  digits: string,
  surveyType: VoiceCsatData['surveyType'],
): number | undefined {
  if (surveyType === 'likeDislike') {
    return LIKE_DISLIKE_SCORES[digits];
  }

  return CSAT_SCORES[digits];
}

export async function runVoiceCsatFlow(opts: VoiceCsatOptions): Promise<void> {
  const {
    sessionId,
    voiceSession,
    csatData,
    prompt,
    thankYouMessage,
    submitRating,
    onComplete,
    onSkip,
  } = opts;

  if (!voiceSession.gatherDTMF) {
    log.warn('[VOICE-CSAT] gatherDTMF not available on voice session', {
      sessionId,
    });
    voiceSession.hangup?.('csat_unavailable');
    onSkip('no_gather_support');
    return;
  }

  // NPS requires a 0-10 scale that cannot be collected via single DTMF digit.
  // Skip voice CSAT for NPS and let the caller handle the hangup path.
  if (csatData.surveyType === 'nps') {
    log.info('[VOICE-CSAT] Skipping voice CSAT — NPS scale not supported via single DTMF', {
      sessionId,
    });
    voiceSession.hangup?.('csat_nps_unsupported');
    onSkip('nps_not_supported');
    return;
  }

  log.info('[VOICE-CSAT] Starting voice CSAT flow', {
    sessionId,
    surveyType: csatData.surveyType,
  });

  let digits: string | null = null;
  try {
    digits = await voiceSession.gatherDTMF(prompt, {
      timeout: 10,
      numDigits: 1,
    });
  } catch (err) {
    log.error('[VOICE-CSAT] gatherDTMF threw unexpectedly', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (digits === null) {
    log.info('[VOICE-CSAT] No input received (timeout)', { sessionId });
    voiceSession.hangup?.('csat_timeout');
    onSkip('timeout');
    return;
  }

  const score = resolveVoiceCsatScore(digits, csatData.surveyType);
  if (score === undefined) {
    log.info('[VOICE-CSAT] Invalid or skip digit received', {
      sessionId,
      digits,
    });
    voiceSession.hangup?.('csat_skipped');
    onSkip(csatData.surveyType === 'csat' && digits === '0' ? 'user_skipped' : 'invalid_input');
    return;
  }

  try {
    await submitRating(score, csatData.surveyType);
    log.info('[VOICE-CSAT] Rating submitted', { sessionId, score });
  } catch (err) {
    log.error('[VOICE-CSAT] Rating submission failed', {
      sessionId,
      score,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    if (voiceSession.playThenHangup) {
      await voiceSession.playThenHangup(thankYouMessage, 'csat_complete');
    } else {
      voiceSession.playMessage?.(thankYouMessage);
      voiceSession.hangup?.('csat_complete');
    }
  } catch (err) {
    log.error('[VOICE-CSAT] Final thank-you playback failed', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    voiceSession.hangup?.('csat_complete');
  }

  onComplete(score);
}

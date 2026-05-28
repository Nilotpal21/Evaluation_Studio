import { describe, it, expect, vi } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import {
  runVoiceCsatFlow,
  type VoiceCsatOptions,
} from '../../services/agent-transfer/voice-csat.js';
import type { VoiceGatewaySession } from '@agent-platform/agent-transfer';

function makeSession(overrides: Partial<VoiceGatewaySession> = {}): VoiceGatewaySession {
  return {
    sessionId: 'call-123',
    isActive: () => true,
    sendAgentMessage: vi.fn(),
    playMessage: vi.fn(),
    hangup: vi.fn(),
    gatherDTMF: vi.fn(),
    ...overrides,
  };
}

const baseOptions = (): VoiceCsatOptions => ({
  sessionId: 'session-abc',
  voiceSession: makeSession(),
  csatData: {
    userId: 'user-1',
    conversationId: 'conv-1',
    channel: 'voice',
    surveyType: 'csat',
    botId: 'bot-1',
    orgId: 'org-1',
  },
  prompt: 'Rate 1 to 5.',
  thankYouMessage: 'Thank you.',
  submitRating: vi.fn().mockResolvedValue({ success: true }),
  onComplete: vi.fn(),
  onSkip: vi.fn(),
});

describe('runVoiceCsatFlow', () => {
  it('uses playThenHangup when the voice gateway supports a combined final prompt + hangup', async () => {
    const opts = baseOptions();
    const playThenHangup = vi.fn().mockResolvedValue(undefined);
    opts.voiceSession = makeSession({
      gatherDTMF: vi.fn().mockResolvedValue('4'),
      playThenHangup,
    });

    await runVoiceCsatFlow(opts);

    expect(opts.voiceSession.gatherDTMF).toHaveBeenCalledWith('Rate 1 to 5.', {
      timeout: 10,
      numDigits: 1,
    });
    expect(opts.submitRating).toHaveBeenCalledWith(4, 'csat');
    expect(playThenHangup).toHaveBeenCalledWith('Thank you.', 'csat_complete');
    expect(opts.voiceSession.playMessage).not.toHaveBeenCalled();
    expect(opts.voiceSession.hangup).not.toHaveBeenCalled();
    expect(opts.onComplete).toHaveBeenCalledWith(4);
    expect(opts.onSkip).not.toHaveBeenCalled();
  });

  it('falls back to separate playMessage + hangup when playThenHangup is unavailable', async () => {
    const opts = baseOptions();
    (opts.voiceSession.gatherDTMF as ReturnType<typeof vi.fn>).mockResolvedValue('4');

    await runVoiceCsatFlow(opts);

    expect(opts.submitRating).toHaveBeenCalledWith(4, 'csat');
    expect(opts.voiceSession.playMessage).toHaveBeenCalledWith('Thank you.');
    expect(opts.voiceSession.hangup).toHaveBeenCalledWith('csat_complete');
  });

  it('skips CSAT when user presses 0', async () => {
    const opts = baseOptions();
    (opts.voiceSession.gatherDTMF as ReturnType<typeof vi.fn>).mockResolvedValue('0');

    await runVoiceCsatFlow(opts);

    expect(opts.submitRating).not.toHaveBeenCalled();
    expect(opts.voiceSession.hangup).toHaveBeenCalledWith('csat_skipped');
    expect(opts.onSkip).toHaveBeenCalledWith('user_skipped');
  });

  it('skips CSAT on timeout (null digits)', async () => {
    const opts = baseOptions();
    (opts.voiceSession.gatherDTMF as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await runVoiceCsatFlow(opts);

    expect(opts.submitRating).not.toHaveBeenCalled();
    expect(opts.voiceSession.hangup).toHaveBeenCalledWith('csat_timeout');
    expect(opts.onSkip).toHaveBeenCalledWith('timeout');
  });

  it('skips CSAT on invalid digit (not 1-5)', async () => {
    const opts = baseOptions();
    (opts.voiceSession.gatherDTMF as ReturnType<typeof vi.fn>).mockResolvedValue('9');

    await runVoiceCsatFlow(opts);

    expect(opts.submitRating).not.toHaveBeenCalled();
    expect(opts.voiceSession.hangup).toHaveBeenCalledWith('csat_skipped');
    expect(opts.onSkip).toHaveBeenCalledWith('invalid_input');
  });

  it('supports likeDislike surveys with 0 as the negative rating', async () => {
    const opts = baseOptions();
    opts.csatData.surveyType = 'likeDislike';
    (opts.voiceSession.gatherDTMF as ReturnType<typeof vi.fn>).mockResolvedValue('0');

    await runVoiceCsatFlow(opts);

    expect(opts.submitRating).toHaveBeenCalledWith(0, 'likeDislike');
    expect(opts.voiceSession.hangup).toHaveBeenCalledWith('csat_complete');
    expect(opts.onComplete).toHaveBeenCalledWith(0);
    expect(opts.onSkip).not.toHaveBeenCalled();
  });

  it('skips voice CSAT for NPS because the 0-10 scale is not supported over one DTMF digit', async () => {
    const opts = baseOptions();
    opts.csatData.surveyType = 'nps';

    await runVoiceCsatFlow(opts);

    expect(opts.voiceSession.gatherDTMF).not.toHaveBeenCalled();
    expect(opts.submitRating).not.toHaveBeenCalled();
    expect(opts.voiceSession.hangup).toHaveBeenCalledWith('csat_nps_unsupported');
    expect(opts.onSkip).toHaveBeenCalledWith('nps_not_supported');
  });

  it('still hangs up even if submitRating throws', async () => {
    const opts = baseOptions();
    (opts.voiceSession.gatherDTMF as ReturnType<typeof vi.fn>).mockResolvedValue('3');
    (opts.submitRating as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network error'));

    await runVoiceCsatFlow(opts);

    expect(opts.voiceSession.hangup).toHaveBeenCalledWith('csat_complete');
  });

  it('falls back to hangup when gatherDTMF not available on session', async () => {
    const opts = baseOptions();
    opts.voiceSession = makeSession({ gatherDTMF: undefined });

    await runVoiceCsatFlow(opts);

    expect(opts.submitRating).not.toHaveBeenCalled();
    expect(opts.voiceSession.hangup).toHaveBeenCalledWith('csat_unavailable');
    expect(opts.onSkip).toHaveBeenCalledWith('no_gather_support');
  });
});

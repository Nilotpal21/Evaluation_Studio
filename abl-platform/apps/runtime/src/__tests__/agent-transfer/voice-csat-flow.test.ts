import { describe, it, expect, vi } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { runVoiceCsatFlow } from '../../services/agent-transfer/voice-csat.js';
import type { VoiceGatewaySession } from '@agent-platform/agent-transfer';

/**
 * Integration-style tests: verify full interaction sequence from gatherDTMF → submit → hangup.
 * All I/O injected via options — no mocking of platform internals.
 */
describe('voice CSAT integration flow', () => {
  it('full happy path: gather=3, submit succeeds, then the gateway plays the thank-you and hangs up in one step', async () => {
    const playThenHangup = vi.fn().mockResolvedValue(undefined);
    const submitRating = vi.fn().mockResolvedValue({ success: true, data: {} });
    const onComplete = vi.fn();
    const onSkip = vi.fn();

    const session: VoiceGatewaySession = {
      sessionId: 'call-abc',
      isActive: () => true,
      sendAgentMessage: vi.fn(),
      playThenHangup,
      gatherDTMF: vi.fn().mockResolvedValue('3'),
    };

    await runVoiceCsatFlow({
      sessionId: 'transfer-session-1',
      voiceSession: session,
      csatData: {
        userId: 'u1',
        conversationId: 'c1',
        channel: 'voice',
        surveyType: 'csat',
        botId: 'bot1',
        orgId: 'org1',
      },
      prompt: 'Rate 1 to 5.',
      thankYouMessage: 'Thanks!',
      submitRating,
      onComplete,
      onSkip,
    });

    expect(submitRating).toHaveBeenCalledWith(3, 'csat');
    expect(playThenHangup).toHaveBeenCalledWith('Thanks!', 'csat_complete');
    expect(onComplete).toHaveBeenCalledWith(3);
    expect(onSkip).not.toHaveBeenCalled();
  });

  it('timeout path: no digits → skip → hangup csat_timeout', async () => {
    const hangup = vi.fn();
    const onSkip = vi.fn();

    const session: VoiceGatewaySession = {
      sessionId: 'call-timeout',
      isActive: () => true,
      sendAgentMessage: vi.fn(),
      hangup,
      gatherDTMF: vi.fn().mockResolvedValue(null),
    };

    await runVoiceCsatFlow({
      sessionId: 'ts-2',
      voiceSession: session,
      csatData: {
        userId: 'u2',
        conversationId: 'c2',
        channel: 'voice',
        surveyType: 'csat',
      },
      prompt: 'Rate.',
      thankYouMessage: 'Thanks.',
      submitRating: vi.fn(),
      onComplete: vi.fn(),
      onSkip,
    });

    expect(hangup).toHaveBeenCalledWith('csat_timeout');
    expect(onSkip).toHaveBeenCalledWith('timeout');
  });

  it('submit error path: hangup still fires even when submitRating rejects', async () => {
    const hangup = vi.fn();
    const session: VoiceGatewaySession = {
      sessionId: 'call-err',
      isActive: () => true,
      sendAgentMessage: vi.fn(),
      playMessage: vi.fn(),
      hangup,
      gatherDTMF: vi.fn().mockResolvedValue('5'),
    };

    await runVoiceCsatFlow({
      sessionId: 'ts-3',
      voiceSession: session,
      csatData: {
        userId: 'u3',
        conversationId: 'c3',
        channel: 'voice',
        surveyType: 'csat',
      },
      prompt: 'Rate.',
      thankYouMessage: 'Thanks.',
      submitRating: vi.fn().mockRejectedValue(new Error('SmartAssist down')),
      onComplete: vi.fn(),
      onSkip: vi.fn(),
    });

    expect(hangup).toHaveBeenCalledWith('csat_complete');
  });

  it('NPS survey type: flow is skipped because single-digit DTMF cannot capture 0-10', async () => {
    const submitRating = vi.fn().mockResolvedValue({ success: true });
    const hangup = vi.fn();
    const onSkip = vi.fn();

    const session: VoiceGatewaySession = {
      sessionId: 'call-nps',
      isActive: () => true,
      sendAgentMessage: vi.fn(),
      playMessage: vi.fn(),
      hangup,
      gatherDTMF: vi.fn().mockResolvedValue('5'),
    };

    await runVoiceCsatFlow({
      sessionId: 'ts-4',
      voiceSession: session,
      csatData: {
        userId: 'u4',
        conversationId: 'c4',
        channel: 'voice',
        surveyType: 'nps',
      },
      prompt: 'Rate.',
      thankYouMessage: 'Thanks.',
      submitRating,
      onComplete: vi.fn(),
      onSkip,
    });

    expect(submitRating).not.toHaveBeenCalled();
    expect(hangup).toHaveBeenCalledWith('csat_nps_unsupported');
    expect(onSkip).toHaveBeenCalledWith('nps_not_supported');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockSendMail = vi.fn();
const mockVerify = vi.fn();

vi.mock('nodemailer', () => ({
  createTransport: vi.fn(() => ({
    sendMail: mockSendMail,
    verify: mockVerify,
  })),
}));

// ── Import after mocks ───────────────────────────────────────────────────────

import { SmtpTransport } from '../../../services/email/transports/smtp-transport.js';

const DEFAULT_CONFIG = {
  host: 'smtp.example.com',
  port: 587,
  user: 'bot@example.com',
  pass: 'secret',
};

describe('SmtpTransport', () => {
  let transport: SmtpTransport;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMail.mockResolvedValue({ messageId: '<sent-001@example.com>' });
    mockVerify.mockResolvedValue(true);
    transport = new SmtpTransport(DEFAULT_CONFIG);
  });

  it('sends email via nodemailer with correct fields', async () => {
    const result = await transport.sendReply({
      from: '"Agent" <agent@example.com>',
      to: 'user@test.com',
      subject: 'Re: Hello',
      text: 'Reply body here.',
    });

    expect(result.messageId).toBe('<sent-001@example.com>');
    expect(mockSendMail).toHaveBeenCalledOnce();
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '"Agent" <agent@example.com>',
        to: 'user@test.com',
        subject: 'Re: Hello',
        text: 'Reply body here.',
      }),
    );
  });

  it('includes threading headers when inReplyTo is provided', async () => {
    await transport.sendReply({
      from: '"Agent" <agent@example.com>',
      to: 'user@test.com',
      subject: 'Re: Thread',
      text: 'Threaded reply.',
      inReplyTo: '<orig-msg@test.com>',
      references: '<prev-msg@test.com>',
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        inReplyTo: '<orig-msg@test.com>',
        references: '<prev-msg@test.com>',
      }),
    );
  });

  it('includes CC and BCC recipients', async () => {
    await transport.sendReply({
      from: '"Agent" <agent@example.com>',
      to: 'user@test.com',
      subject: 'Re: CC Test',
      text: 'Body with CC.',
      cc: ['cc1@test.com', 'cc2@test.com'],
      bcc: ['bcc@test.com'],
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        cc: ['cc1@test.com', 'cc2@test.com'],
        bcc: ['bcc@test.com'],
      }),
    );
  });

  it('includes custom headers including X-ABL-Source', async () => {
    await transport.sendReply({
      from: '"Agent" <agent@example.com>',
      to: 'user@test.com',
      subject: 'Header Test',
      text: 'Check headers.',
      headers: { 'X-Custom': 'custom-value' },
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-ABL-Source': 'agent-platform',
          'X-Custom': 'custom-value',
        }),
      }),
    );
  });

  it('checkHealth returns healthy when SMTP server is reachable', async () => {
    const health = await transport.checkHealth();

    expect(health.healthy).toBe(true);
    expect(typeof health.latencyMs).toBe('number');
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    expect(mockVerify).toHaveBeenCalledOnce();
  });

  it('checkHealth returns unhealthy when SMTP server is unreachable', async () => {
    mockVerify.mockRejectedValueOnce(new Error('Connection refused'));

    const health = await transport.checkHealth();

    expect(health.healthy).toBe(false);
    expect(typeof health.latencyMs).toBe('number');
  });
});

import { describe, test, expect, vi, beforeEach, afterAll } from 'vitest';

// Mock the SES client before importing the service
const mockSend = vi.fn().mockResolvedValue({});
vi.mock('@aws-sdk/client-ses', () => {
  return {
    SESClient: class MockSESClient {
      send = mockSend;
    },
    SendEmailCommand: class MockSendEmailCommand {
      input: unknown;
      constructor(input: unknown) {
        this.input = input;
      }
    },
  };
});

// Mock nodemailer
const mockSendMail = vi.fn().mockResolvedValue({ messageId: 'test-id' });
vi.mock('nodemailer', () => ({
  createTransport: vi.fn(() => ({ sendMail: mockSendMail })),
}));

import {
  SESEmailService,
  ConsoleEmailService,
  ResendEmailService,
  SmtpEmailService,
  createEmailService,
  resetEmailService,
} from '../services/email-service.js';

describe('SESEmailService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('sends email with correct SES params', async () => {
    const service = new SESEmailService('us-east-1', 'noreply@example.com');
    await service.sendEmail('user@test.com', 'Test Subject', '<p>Hello</p>');

    expect(mockSend).toHaveBeenCalledOnce();
    const command = mockSend.mock.calls[0][0];
    expect(command.input).toEqual({
      Source: 'noreply@example.com',
      Destination: { ToAddresses: ['user@test.com'] },
      Message: {
        Subject: { Data: 'Test Subject' },
        Body: { Html: { Data: '<p>Hello</p>' } },
      },
    });
  });

  test('propagates SES errors', async () => {
    mockSend.mockRejectedValueOnce(new Error('SES: Email address not verified'));
    const service = new SESEmailService('us-east-1', 'noreply@example.com');

    await expect(service.sendEmail('user@test.com', 'Subject', '<p>Body</p>')).rejects.toThrow(
      'SES: Email address not verified',
    );
  });
});

describe('ConsoleEmailService', () => {
  test('logs email to console', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const service = new ConsoleEmailService();
    await service.sendEmail('user@test.com', 'Subject', '<p>Body</p>');

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('user@test.com'));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('Subject'));
    spy.mockRestore();
  });
});

describe('ResendEmailService', () => {
  test('sends email via Resend API', async () => {
    const mockFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'msg_123' }), { status: 200 }));

    const service = new ResendEmailService('re_test_key', 'noreply@example.com');
    await service.sendEmail('user@test.com', 'Subject', '<p>Body</p>');

    expect(mockFetch).toHaveBeenCalledWith('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer re_test_key',
      },
      body: JSON.stringify({
        from: 'noreply@example.com',
        to: 'user@test.com',
        subject: 'Subject',
        html: '<p>Body</p>',
      }),
    });
    mockFetch.mockRestore();
  });

  test('throws on Resend API error', async () => {
    const mockFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

    const service = new ResendEmailService('bad_key', 'noreply@example.com');
    await expect(service.sendEmail('user@test.com', 'Subject', '<p>Body</p>')).rejects.toThrow(
      'Email send failed: 401',
    );

    mockFetch.mockRestore();
  });
});

describe('SmtpEmailService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('sends email via nodemailer transporter', async () => {
    const service = new SmtpEmailService({
      host: 'smtp.example.com',
      port: 587,
      user: 'user',
      pass: 'pass',
      from: 'noreply@example.com',
    });
    await service.sendEmail('user@test.com', 'Subject', '<p>Body</p>');

    expect(mockSendMail).toHaveBeenCalledWith({
      from: 'noreply@example.com',
      to: 'user@test.com',
      subject: 'Subject',
      html: '<p>Body</p>',
    });
  });

  test('propagates SMTP errors', async () => {
    mockSendMail.mockRejectedValueOnce(new Error('SMTP connection refused'));
    const service = new SmtpEmailService({
      host: 'smtp.example.com',
      port: 587,
      from: 'noreply@example.com',
    });

    await expect(service.sendEmail('user@test.com', 'Subject', '<p>Body</p>')).rejects.toThrow(
      'SMTP connection refused',
    );
  });

  test('creates transport with user/pass auth when user is provided', async () => {
    const { createTransport } = await import('nodemailer');
    const service = new SmtpEmailService({
      host: 'smtp.example.com',
      port: 465,
      user: 'myuser',
      pass: 'mypass',
      from: 'noreply@example.com',
    });
    await service.sendEmail('user@test.com', 'Subject', '<p>Body</p>');

    // Verify createTransport was called with auth and secure=true (port 465)
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.example.com',
        port: 465,
        secure: true,
        auth: { user: 'myuser', pass: 'mypass' },
      }),
    );
  });

  test('creates transport without auth when user is not provided', async () => {
    const { createTransport } = await import('nodemailer');
    (createTransport as any).mockClear();
    const service = new SmtpEmailService({
      host: 'smtp.example.com',
      port: 587,
      from: 'noreply@example.com',
    });
    await service.sendEmail('user@test.com', 'Subject', '<p>Body</p>');

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.example.com',
        port: 587,
        secure: false,
      }),
    );
    // Should NOT have auth property
    const callArg = (createTransport as any).mock.calls[0][0];
    expect(callArg.auth).toBeUndefined();
  });
});

describe('createEmailService factory', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    resetEmailService();
    process.env = { ...originalEnv };
    delete process.env.AWS_SES_REGION;
    delete process.env.RESEND_API_KEY;
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.EMAIL_FROM;
  });

  afterAll(() => {
    process.env = originalEnv;
    resetEmailService();
  });

  test('returns SESEmailService when AWS_SES_REGION is set', () => {
    process.env.AWS_SES_REGION = 'us-east-1';
    const service = createEmailService();
    expect(service).toBeInstanceOf(SESEmailService);
  });

  test('returns ResendEmailService when RESEND_API_KEY is set', () => {
    process.env.RESEND_API_KEY = 're_test_key';
    const service = createEmailService();
    expect(service).toBeInstanceOf(ResendEmailService);
  });

  test('returns ConsoleEmailService when no provider env vars set', () => {
    const service = createEmailService();
    expect(service).toBeInstanceOf(ConsoleEmailService);
  });

  test('returns SmtpEmailService when SMTP_HOST is set', () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    const service = createEmailService();
    expect(service).toBeInstanceOf(SmtpEmailService);
  });

  test('SES takes priority over Resend', () => {
    process.env.AWS_SES_REGION = 'us-east-1';
    process.env.RESEND_API_KEY = 're_test_key';
    const service = createEmailService();
    expect(service).toBeInstanceOf(SESEmailService);
  });

  test('Resend takes priority over SMTP', () => {
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.SMTP_HOST = 'smtp.example.com';
    const service = createEmailService();
    expect(service).toBeInstanceOf(ResendEmailService);
  });

  test('SES takes priority over SMTP', () => {
    process.env.AWS_SES_REGION = 'us-east-1';
    process.env.SMTP_HOST = 'smtp.example.com';
    const service = createEmailService();
    expect(service).toBeInstanceOf(SESEmailService);
  });

  test('returns singleton on repeated calls', () => {
    const first = createEmailService();
    const second = createEmailService();
    expect(first).toBe(second);
  });
});

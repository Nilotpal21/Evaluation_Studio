/**
 * Email Sender Tests
 *
 * Unit tests for the EmailSender service.
 * Tests threading headers, reply subject formatting, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmailSender, createEmailSenderFromEnv } from '../../services/email/email-sender.js';

// Mock nodemailer
vi.mock('nodemailer', () => {
  const mockSendMail = vi.fn();
  return {
    createTransport: vi.fn(() => ({
      sendMail: mockSendMail,
    })),
    __mockSendMail: mockSendMail,
  };
});

import { createTransport } from 'nodemailer';

// Access the mock sendMail through the module
const getMockSendMail = () => {
  return (createTransport as any)().sendMail;
};

describe('EmailSender', () => {
  let sender: EmailSender;
  let mockSendMail: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.restoreAllMocks();

    // Recreate mock for each test
    mockSendMail = vi.fn().mockResolvedValue({ messageId: '<reply-001@example.com>' });
    (createTransport as any).mockReturnValue({ sendMail: mockSendMail });

    sender = new EmailSender({
      host: 'smtp.example.com',
      port: 587,
      user: 'bot@example.com',
      pass: 'secret',
      fromAddress: 'agent@example.com',
      fromName: 'Agent',
    });
  });

  // ===========================================================================
  // CONSTRUCTOR
  // ===========================================================================

  describe('constructor', () => {
    it('should create a nodemailer transporter with correct config', () => {
      expect(createTransport).toHaveBeenCalledWith({
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        auth: {
          user: 'bot@example.com',
          pass: 'secret',
        },
      });
    });

    it('should use secure=true for port 465', () => {
      new EmailSender({
        host: 'smtp.example.com',
        port: 465,
        user: 'bot@example.com',
        pass: 'secret',
        fromAddress: 'agent@example.com',
        fromName: 'Agent',
      });

      expect(createTransport).toHaveBeenCalledWith(
        expect.objectContaining({ secure: true, port: 465 }),
      );
    });
  });

  // ===========================================================================
  // sendReply
  // ===========================================================================

  describe('sendReply', () => {
    it('should send email with correct from/to/subject/text', async () => {
      const result = await sender.sendReply({
        to: 'user@test.com',
        subject: 'Hello Agent',
        text: 'Here is my response.',
      });

      expect(result.messageId).toBe('<reply-001@example.com>');
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: '"Agent" <agent@example.com>',
          to: 'user@test.com',
          subject: 'Re: Hello Agent',
          text: 'Here is my response.',
        }),
      );
    });

    it('should not double-prefix Re: in subject', async () => {
      await sender.sendReply({
        to: 'user@test.com',
        subject: 'Re: Hello Agent',
        text: 'Follow up response.',
      });

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({ subject: 'Re: Hello Agent' }),
      );
    });

    it('should include In-Reply-To header when inReplyTo is provided', async () => {
      await sender.sendReply({
        to: 'user@test.com',
        subject: 'Test',
        text: 'Reply body',
        inReplyTo: '<original-msg@test.com>',
      });

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          inReplyTo: '<original-msg@test.com>',
        }),
      );
    });

    it('should build References chain from existing references + inReplyTo', async () => {
      await sender.sendReply({
        to: 'user@test.com',
        subject: 'Test',
        text: 'Reply body',
        inReplyTo: '<msg-2@test.com>',
        references: '<msg-1@test.com>',
      });

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          references: '<msg-1@test.com> <msg-2@test.com>',
        }),
      );
    });

    it('should set References to just inReplyTo when no prior references', async () => {
      await sender.sendReply({
        to: 'user@test.com',
        subject: 'Test',
        text: 'First reply',
        inReplyTo: '<original@test.com>',
      });

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          references: '<original@test.com>',
        }),
      );
    });

    it('should omit In-Reply-To and References when not provided', async () => {
      await sender.sendReply({
        to: 'user@test.com',
        subject: 'Brand new conversation',
        text: 'No threading.',
      });

      const callArgs = mockSendMail.mock.calls[0][0];
      expect(callArgs.inReplyTo).toBeUndefined();
      expect(callArgs.references).toBeUndefined();
    });

    it('should propagate transporter errors', async () => {
      mockSendMail.mockRejectedValue(new Error('Connection timeout'));

      await expect(
        sender.sendReply({
          to: 'user@test.com',
          subject: 'Test',
          text: 'This will fail',
        }),
      ).rejects.toThrow('Connection timeout');
    });
  });

  // ===========================================================================
  // createEmailSenderFromEnv
  // ===========================================================================

  describe('createEmailSenderFromEnv', () => {
    it('should create sender from env vars', () => {
      const originalEnv = { ...process.env };

      process.env.SMTP_RELAY_HOST = 'smtp.gmail.com';
      process.env.SMTP_RELAY_PORT = '465';
      process.env.SMTP_RELAY_USER = 'mybot@gmail.com';
      process.env.SMTP_RELAY_PASS = 'app-password';
      process.env.EMAIL_FROM_ADDRESS = 'mybot@gmail.com';
      process.env.EMAIL_FROM_NAME = 'My Bot';

      const envSender = createEmailSenderFromEnv();
      expect(envSender).toBeInstanceOf(EmailSender);

      expect(createTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'smtp.gmail.com',
          port: 465,
          secure: true,
        }),
      );

      // Restore env
      Object.assign(process.env, originalEnv);
    });

    it('should use defaults when env vars are missing', () => {
      const originalEnv = { ...process.env };

      delete process.env.SMTP_RELAY_HOST;
      delete process.env.SMTP_RELAY_PORT;
      delete process.env.SMTP_RELAY_USER;
      delete process.env.SMTP_RELAY_PASS;
      delete process.env.EMAIL_FROM_ADDRESS;
      delete process.env.EMAIL_FROM_NAME;

      const envSender = createEmailSenderFromEnv();
      expect(envSender).toBeInstanceOf(EmailSender);

      expect(createTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'localhost',
          port: 587,
        }),
      );

      Object.assign(process.env, originalEnv);
    });
  });
});

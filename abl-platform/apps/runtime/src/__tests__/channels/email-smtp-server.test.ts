/**
 * Email SMTP Server — Integration Tests
 *
 * Spins up the real embedded SMTP server on a test port,
 * sends actual emails via nodemailer, and verifies the full
 * inbound flow: receive → parse → resolve connection → enqueue to BullMQ.
 *
 * Only downstream dependencies (DB connection resolver, BullMQ queue) are mocked.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTransport, type Transporter } from 'nodemailer';

// =============================================================================
// MOCK only downstream services (DB + queue), NOT the SMTP server itself
// =============================================================================

const mocks = vi.hoisted(() => ({
  resolveChannelConnection: vi.fn(),
  getInboundQueue: vi.fn(),
  queueAdd: vi.fn(),
}));

vi.mock('../../channels/connection-resolver.js', () => ({
  resolveChannelConnection: mocks.resolveChannelConnection,
}));

vi.mock('../../services/queues/channel-queues.js', () => ({
  getInboundQueue: mocks.getInboundQueue,
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { startSmtpServer, stopSmtpServer } from '../../services/email/smtp-server.js';

// =============================================================================
// TEST CONFIG
// =============================================================================

const TEST_SMTP_PORT = 12525; // High port to avoid conflicts
let mailer: Transporter;

function makeConnection() {
  return {
    id: 'conn-email-test',
    tenantId: 'tenant-test',
    projectId: 'project-test',
    agentId: null,
    channelType: 'email',
    externalIdentifier: 'agent@testdomain.com',
    credentials: null,
    config: {},
    status: 'active',
  };
}

describe('Email SMTP Server — Integration', { timeout: 15_000 }, () => {
  beforeAll(async () => {
    // Start real SMTP server on test port
    process.env.SMTP_LISTEN_PORT = String(TEST_SMTP_PORT);
    await startSmtpServer();

    // Create a nodemailer transport pointing at our test SMTP server
    mailer = createTransport({
      host: '127.0.0.1',
      port: TEST_SMTP_PORT,
      secure: false,
      tls: { rejectUnauthorized: false },
    });

    // Verify transport connectivity
    await mailer.verify();
  });

  afterAll(async () => {
    await stopSmtpServer();
    delete process.env.SMTP_LISTEN_PORT;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queueAdd.mockResolvedValue(undefined);
    mocks.getInboundQueue.mockReturnValue({ add: mocks.queueAdd });
    mocks.resolveChannelConnection.mockResolvedValue(makeConnection());
  });

  // ===========================================================================
  // BASIC INBOUND EMAIL
  // ===========================================================================

  it('should receive an email and enqueue it to BullMQ', async () => {
    await mailer.sendMail({
      from: 'customer@gmail.com',
      to: 'agent@testdomain.com',
      subject: 'Hello Agent',
      text: 'I need help with my account.',
    });

    // Give async processing a moment
    await new Promise((r) => setTimeout(r, 200));

    // Connection resolver should be called with the recipient address
    expect(mocks.resolveChannelConnection).toHaveBeenCalledWith('email', 'agent@testdomain.com');

    // Queue should have received the job
    expect(mocks.queueAdd).toHaveBeenCalledTimes(1);

    const [jobName, payload, opts] = mocks.queueAdd.mock.calls[0];
    expect(jobName).toBe('email-inbound');

    // Verify payload structure
    expect(payload.connectionId).toBe('conn-email-test');
    expect(payload.tenantId).toBe('tenant-test');
    expect(payload.channelType).toBe('email');

    // Verify parsed message (mailparser may add trailing newline)
    expect(payload.message.text.trim()).toBe('I need help with my account.');
    // New email (no Re: prefix, no threading headers) gets message-ID-based key
    expect(payload.message.externalSessionKey).toMatch(/^email:conn-email-test:msg:</);
    expect(payload.message.metadata.from).toBe('customer@gmail.com');
    expect(payload.message.metadata.to).toBe('agent@testdomain.com');
    expect(payload.message.metadata.subject).toBe('Hello Agent');
    expect(payload.message.externalMessageId).toBeTruthy();

    // Metadata should include threading info
    expect(payload.message.metadata.hasThreadingHeaders).toBe(false);
    expect(payload.message.metadata.subjectBasedKey).toBe(
      'email:conn-email-test:customer@gmail.com:hello agent',
    );

    // Job should have idempotency key
    expect(opts.jobId).toContain('email-');
  });

  // ===========================================================================
  // SESSION KEY: New emails get unique keys
  // ===========================================================================

  it('should create unique session keys for new emails with same subject', async () => {
    // Two brand new emails with same subject from same sender
    await mailer.sendMail({
      from: 'customer@gmail.com',
      to: 'agent@testdomain.com',
      subject: 'Hello Agent',
      text: 'First email.',
    });
    await new Promise((r) => setTimeout(r, 200));

    await mailer.sendMail({
      from: 'customer@gmail.com',
      to: 'agent@testdomain.com',
      subject: 'Hello Agent',
      text: 'Second email, same subject.',
    });
    await new Promise((r) => setTimeout(r, 200));

    expect(mocks.queueAdd).toHaveBeenCalledTimes(2);
    const key1 = mocks.queueAdd.mock.calls[0][1].message.externalSessionKey;
    const key2 = mocks.queueAdd.mock.calls[1][1].message.externalSessionKey;

    // Each new email gets a unique message-ID-based key
    expect(key1).not.toBe(key2);
    expect(key1).toMatch(/^email:conn-email-test:msg:</);
    expect(key2).toMatch(/^email:conn-email-test:msg:</);
  });

  // ===========================================================================
  // THREADING: Re:/Fwd: WITHOUT threading headers (subject-based fallback)
  // ===========================================================================

  it('should use subject-based key for Re: without threading headers', async () => {
    // Email with Re: prefix but no In-Reply-To/References (unusual client).
    // nodemailer will NOT add In-Reply-To/References by default.
    await mailer.sendMail({
      from: 'customer@gmail.com',
      to: 'agent@testdomain.com',
      subject: 'Re: Hello Agent',
      text: 'Reply without threading headers.',
    });

    await new Promise((r) => setTimeout(r, 200));

    const payload = mocks.queueAdd.mock.calls[0][1];
    // Re: without threading headers → subject-based fallback
    expect(payload.message.externalSessionKey).toBe(
      'email:conn-email-test:customer@gmail.com:hello agent',
    );
    // Original subject preserved in metadata
    expect(payload.message.metadata.subject).toBe('Re: Hello Agent');
  });

  it('should normalize Fwd: subject to subject-based key when no threading headers', async () => {
    await mailer.sendMail({
      from: 'customer@gmail.com',
      to: 'agent@testdomain.com',
      subject: 'Fwd: Hello Agent',
      text: 'Forwarding this conversation.',
    });

    await new Promise((r) => setTimeout(r, 200));

    const payload = mocks.queueAdd.mock.calls[0][1];
    expect(payload.message.externalSessionKey).toBe(
      'email:conn-email-test:customer@gmail.com:hello agent',
    );
  });

  it('should normalize nested Re: Re: Fwd: to subject-based key when no threading headers', async () => {
    await mailer.sendMail({
      from: 'customer@gmail.com',
      to: 'agent@testdomain.com',
      subject: 'Re: Re: Fwd: Hello Agent',
      text: 'Deep thread.',
    });

    await new Promise((r) => setTimeout(r, 200));

    const payload = mocks.queueAdd.mock.calls[0][1];
    expect(payload.message.externalSessionKey).toBe(
      'email:conn-email-test:customer@gmail.com:hello agent',
    );
  });

  // ===========================================================================
  // THREADING: Re: WITH threading headers (message-ID-based key)
  // ===========================================================================

  it('should use message-ID-based key for reply with threading headers', async () => {
    await mailer.sendMail({
      from: 'customer@gmail.com',
      to: 'agent@testdomain.com',
      subject: 'Re: Hello Agent',
      text: 'Follow up message.',
      inReplyTo: '<original-msg-id@testdomain.com>',
      references: '<original-msg-id@testdomain.com>',
    });

    await new Promise((r) => setTimeout(r, 200));

    const payload = mocks.queueAdd.mock.calls[0][1];
    // Reply with threading headers gets message-ID-based key
    expect(payload.message.externalSessionKey).toMatch(/^email:conn-email-test:msg:</);
    // Threading headers preserved in metadata
    expect(payload.message.metadata.inReplyTo).toBe('<original-msg-id@testdomain.com>');
    expect(payload.message.metadata.references).toContain('<original-msg-id@testdomain.com>');
    expect(payload.message.metadata.hasThreadingHeaders).toBe(true);
    // Subject-based key still available as fallback
    expect(payload.message.metadata.subjectBasedKey).toBe(
      'email:conn-email-test:customer@gmail.com:hello agent',
    );
  });

  // ===========================================================================
  // DIFFERENT SENDERS = DIFFERENT SESSIONS
  // ===========================================================================

  it('should create different sessions for different senders with same subject', async () => {
    // Send from alice
    await mailer.sendMail({
      from: 'alice@gmail.com',
      to: 'agent@testdomain.com',
      subject: 'Hello Agent',
      text: 'From Alice.',
    });

    await new Promise((r) => setTimeout(r, 200));

    // Send from bob
    await mailer.sendMail({
      from: 'bob@gmail.com',
      to: 'agent@testdomain.com',
      subject: 'Hello Agent',
      text: 'From Bob.',
    });

    await new Promise((r) => setTimeout(r, 200));

    expect(mocks.queueAdd).toHaveBeenCalledTimes(2);

    const alicePayload = mocks.queueAdd.mock.calls[0][1];
    const bobPayload = mocks.queueAdd.mock.calls[1][1];

    // Both are new emails — each gets a unique message-ID-based key
    expect(alicePayload.message.externalSessionKey).toMatch(/^email:conn-email-test:msg:</);
    expect(bobPayload.message.externalSessionKey).toMatch(/^email:conn-email-test:msg:</);
    expect(alicePayload.message.externalSessionKey).not.toBe(bobPayload.message.externalSessionKey);
  });

  // ===========================================================================
  // NO CONNECTION FOUND
  // ===========================================================================

  it('should skip enqueue when no channel connection matches', async () => {
    mocks.resolveChannelConnection.mockResolvedValue(null);

    // RCPT TO rejects unknown recipients at SMTP level (550),
    // so sendMail should throw with a rejection error.
    await expect(
      mailer.sendMail({
        from: 'customer@gmail.com',
        to: 'unknown@testdomain.com',
        subject: 'Hello?',
        text: 'No one home?',
      }),
    ).rejects.toThrow(/rejected/i);

    expect(mocks.resolveChannelConnection).toHaveBeenCalled();
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  // ===========================================================================
  // NO QUEUE AVAILABLE
  // ===========================================================================

  it('should skip enqueue when BullMQ queue is not available', async () => {
    mocks.getInboundQueue.mockReturnValue(null);

    await mailer.sendMail({
      from: 'customer@gmail.com',
      to: 'agent@testdomain.com',
      subject: 'Queue down test',
      text: 'This should not be enqueued.',
    });

    await new Promise((r) => setTimeout(r, 200));

    expect(mocks.resolveChannelConnection).toHaveBeenCalled();
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  // ===========================================================================
  // HTML EMAIL (text extraction)
  // ===========================================================================

  it('should extract plain text from email with both text and HTML', async () => {
    await mailer.sendMail({
      from: 'customer@gmail.com',
      to: 'agent@testdomain.com',
      subject: 'HTML email test',
      text: 'Plain text version',
      html: '<h1>HTML version</h1><p>With formatting.</p>',
    });

    await new Promise((r) => setTimeout(r, 200));

    const payload = mocks.queueAdd.mock.calls[0][1];
    // Should prefer plain text version
    expect(payload.message.text).toBe('Plain text version');
  });

  // ===========================================================================
  // MULTIPLE EMAILS IN SEQUENCE
  // ===========================================================================

  it('should handle multiple emails in quick succession', async () => {
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(
        mailer.sendMail({
          from: `user${i}@gmail.com`,
          to: 'agent@testdomain.com',
          subject: `Message ${i}`,
          text: `Body of message ${i}`,
        }),
      );
    }
    await Promise.all(promises);

    await new Promise((r) => setTimeout(r, 500));

    expect(mocks.queueAdd).toHaveBeenCalledTimes(5);

    // Each should have a unique session key (new emails get message-ID-based keys)
    const sessionKeys = mocks.queueAdd.mock.calls.map(
      ([, payload]: [string, any]) => payload.message.externalSessionKey,
    );
    const unique = new Set(sessionKeys);
    expect(unique.size).toBe(5);
  });
});

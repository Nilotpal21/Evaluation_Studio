import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'stream';

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock the channel connection resolver
const mockResolveChannelConnection = vi.fn();
vi.mock('../../../channels/connection-resolver.js', () => ({
  resolveChannelConnection: (...args: any[]) => mockResolveChannelConnection(...args),
}));

// Mock the inbound queue
const mockQueueAdd = vi.fn();
const mockGetInboundQueue = vi.fn(() => ({ add: mockQueueAdd }));
vi.mock('../../../services/queues/channel-queues.js', () => ({
  getInboundQueue: () => mockGetInboundQueue(),
}));

// Mock the email attachment processor
const mockProcessEmailAttachments = vi.fn();
vi.mock('../../../channels/adapters/email-attachment-processor.js', () => ({
  processEmailAttachments: (...args: any[]) => mockProcessEmailAttachments(...args),
}));

// Mock MultimodalServiceClient
vi.mock('../../../attachments/multimodal-service-client.js', () => ({
  MultimodalServiceClient: class MockMultimodalServiceClient {
    upload = vi.fn();
  },
}));

// Mock the email reply parser
const mockExtractReplyText = vi.fn((text: string) => text);
vi.mock('../../../services/email/email-reply-parser.js', () => ({
  extractReplyText: (...args: any[]) => mockExtractReplyText(...args),
}));

// Mock mailparser — simpleParser returns parsed email data
const mockSimpleParser = vi.fn();
vi.mock('mailparser', () => ({
  simpleParser: (...args: any[]) => mockSimpleParser(...args),
}));

// Mock smtp-server to avoid actually opening ports
vi.mock('smtp-server', () => {
  return {
    SMTPServer: class MockSMTPServer {
      constructor(opts: any) {
        MockSMTPServer.lastOpts = opts;
      }
      listen(_port: number, cb: () => void) {
        cb();
      }
      close(cb: () => void) {
        cb();
      }
      on() {}
      static lastOpts: any = null;
    },
  };
});

// Mock uuid
vi.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeParsedMail(overrides: Record<string, any> = {}) {
  return {
    from: { value: [{ address: 'sender@example.com' }] },
    to: { value: [{ address: 'bot@company.com' }] },
    subject: 'Test Subject',
    text: 'Hello from email',
    messageId: '<msg-001@example.com>',
    inReplyTo: undefined,
    references: undefined,
    date: new Date('2026-02-28'),
    attachments: [],
    headers: new Map(),
    ...overrides,
  };
}

const MOCK_CONNECTION = {
  id: 'conn-1',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  agentId: 'agent-1',
};

function makeSession(id = 'smtp-session-1') {
  return { id };
}

// ── Tests ────────────────────────────────────────────────────────────────────

import { startSmtpServer, stopSmtpServer } from '../../../services/email/smtp-server.js';
import { SMTPServer } from 'smtp-server';

describe('Email SMTP Server - Attachment Processing', () => {
  let onRcptToHandler: (
    address: { address: string },
    session: any,
    callback: (err?: Error) => void,
  ) => void;
  let onDataHandler: (stream: Readable, session: any, callback: () => void) => void;
  let onCloseHandler: (session: any, callback: () => void) => void;

  /** Simulate the RCPT TO → DATA flow with a shared session object. */
  async function simulateEmail(
    stream: Readable,
    session: { id: string } = makeSession(),
  ): Promise<void> {
    // Step 1: RCPT TO — resolve connection
    await new Promise<void>((resolve, reject) => {
      onRcptToHandler({ address: 'bot@company.com' }, session, (err?: Error) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Step 2: DATA — parse and enqueue
    await new Promise<void>((resolve) => {
      onDataHandler(stream, session, () => resolve());
    });
  }

  beforeEach(async () => {
    vi.resetAllMocks();

    mockResolveChannelConnection.mockResolvedValue(MOCK_CONNECTION);
    mockGetInboundQueue.mockReturnValue({ add: mockQueueAdd });
    mockQueueAdd.mockResolvedValue({});

    await startSmtpServer();

    // Capture handlers from the mock constructor
    const MockClass = SMTPServer as any;
    onRcptToHandler = MockClass.lastOpts.onRcptTo;
    onDataHandler = MockClass.lastOpts.onData;
    onCloseHandler = MockClass.lastOpts.onClose;
  });

  afterEach(async () => {
    await stopSmtpServer();
  });

  it('enqueues email without attachments — no emailAttachmentIds in metadata', async () => {
    mockSimpleParser.mockResolvedValueOnce(makeParsedMail());

    await simulateEmail(Readable.from(['fake email stream']));

    expect(mockProcessEmailAttachments).not.toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalledOnce();
    const payload = mockQueueAdd.mock.calls[0][1];
    expect(payload.message.metadata).not.toHaveProperty('emailAttachmentIds');
  });

  it('uploads attachments and includes emailAttachmentIds in enqueued metadata', async () => {
    const attachmentBuffer = Buffer.from('PDF file content');
    mockSimpleParser.mockResolvedValueOnce(
      makeParsedMail({
        attachments: [
          {
            filename: 'invoice.pdf',
            contentType: 'application/pdf',
            size: attachmentBuffer.length,
            content: attachmentBuffer,
          },
        ],
      }),
    );
    mockProcessEmailAttachments.mockResolvedValueOnce(['att-001']);

    await simulateEmail(Readable.from(['fake email stream']));

    // Verify processEmailAttachments was called with correct refs
    expect(mockProcessEmailAttachments).toHaveBeenCalledOnce();
    const [refs, opts] = mockProcessEmailAttachments.mock.calls[0];
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      filename: 'invoice.pdf',
      mimeType: 'application/pdf',
      sizeBytes: attachmentBuffer.length,
    });
    expect(opts.tenantId).toBe('tenant-1');
    expect(opts.projectId).toBe('proj-1');
    expect(opts.channel).toBe('email');

    // Verify enqueued payload includes attachment IDs
    expect(mockQueueAdd).toHaveBeenCalledOnce();
    const payload = mockQueueAdd.mock.calls[0][1];
    expect(payload.message.metadata.emailAttachmentIds).toEqual(['att-001']);
  });

  it('handles multiple attachments', async () => {
    mockSimpleParser.mockResolvedValueOnce(
      makeParsedMail({
        attachments: [
          {
            filename: 'doc.pdf',
            contentType: 'application/pdf',
            size: 100,
            content: Buffer.from('pdf'),
          },
          {
            filename: 'photo.jpg',
            contentType: 'image/jpeg',
            size: 200,
            content: Buffer.from('jpg'),
          },
        ],
      }),
    );
    mockProcessEmailAttachments.mockResolvedValueOnce(['att-001', 'att-002']);

    await simulateEmail(Readable.from(['fake']));

    const [refs] = mockProcessEmailAttachments.mock.calls[0];
    expect(refs).toHaveLength(2);

    const payload = mockQueueAdd.mock.calls[0][1];
    expect(payload.message.metadata.emailAttachmentIds).toEqual(['att-001', 'att-002']);
  });

  it('continues without attachments when processing fails', async () => {
    mockSimpleParser.mockResolvedValueOnce(
      makeParsedMail({
        attachments: [
          {
            filename: 'bad.pdf',
            contentType: 'application/pdf',
            size: 50,
            content: Buffer.from('bad'),
          },
        ],
      }),
    );
    mockProcessEmailAttachments.mockRejectedValueOnce(new Error('Service unavailable'));

    await simulateEmail(Readable.from(['fake']));

    // Message should still be enqueued without attachment IDs
    expect(mockQueueAdd).toHaveBeenCalledOnce();
    const payload = mockQueueAdd.mock.calls[0][1];
    expect(payload.message.metadata).not.toHaveProperty('emailAttachmentIds');
    expect(payload.message.text).toBe('Hello from email');
  });

  it('uses fallback values for missing filename and contentType', async () => {
    mockSimpleParser.mockResolvedValueOnce(
      makeParsedMail({
        attachments: [
          {
            filename: undefined,
            contentType: undefined,
            size: 64,
            content: Buffer.from('mystery'),
          },
        ],
      }),
    );
    mockProcessEmailAttachments.mockResolvedValueOnce(['att-fallback']);

    await simulateEmail(Readable.from(['fake']));

    const [refs] = mockProcessEmailAttachments.mock.calls[0];
    expect(refs[0].filename).toBe('attachment');
    expect(refs[0].mimeType).toBe('application/octet-stream');
  });

  it('excludes emailAttachmentIds from metadata when all uploads fail (empty result)', async () => {
    mockSimpleParser.mockResolvedValueOnce(
      makeParsedMail({
        attachments: [
          {
            filename: 'fail.pdf',
            contentType: 'application/pdf',
            size: 100,
            content: Buffer.from('data'),
          },
        ],
      }),
    );
    mockProcessEmailAttachments.mockResolvedValueOnce([]); // all uploads failed

    await simulateEmail(Readable.from(['fake']));

    expect(mockQueueAdd).toHaveBeenCalledOnce();
    const payload = mockQueueAdd.mock.calls[0][1];
    expect(payload.message.metadata).not.toHaveProperty('emailAttachmentIds');
  });

  // ── onRcptTo tests ──────────────────────────────────────────────────────

  it('rejects unknown recipients at RCPT TO before email body is sent', async () => {
    mockResolveChannelConnection.mockResolvedValueOnce(null);

    const err = await new Promise<Error | undefined>((resolve) => {
      onRcptToHandler({ address: 'unknown@company.com' }, makeSession(), (e?: Error) => resolve(e));
    });

    expect(err).toBeDefined();
    expect(err!.message).toContain('550');
    expect(mockSimpleParser).not.toHaveBeenCalled(); // body never parsed
  });

  it('returns 451 on transient DB errors during RCPT TO', async () => {
    mockResolveChannelConnection.mockRejectedValueOnce(new Error('DB connection lost'));

    const err = await new Promise<Error | undefined>((resolve) => {
      onRcptToHandler({ address: 'bot@company.com' }, makeSession(), (e?: Error) => resolve(e));
    });

    expect(err).toBeDefined();
    expect(err!.message).toContain('451');
  });

  it('cleans up pending connection on session close without DATA', async () => {
    // RCPT TO succeeds — connection stored
    await new Promise<void>((resolve, reject) => {
      onRcptToHandler({ address: 'bot@company.com' }, makeSession('sess-close'), (err?: Error) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Client disconnects — onClose fires instead of onData
    await new Promise<void>((resolve) => {
      onCloseHandler(makeSession('sess-close'), () => resolve());
    });

    // Verify no leak: a subsequent onData with the same session ID won't find a stale connection
    mockSimpleParser.mockResolvedValueOnce(makeParsedMail());
    await new Promise<void>((resolve) => {
      onDataHandler(Readable.from(['fake']), makeSession('sess-close'), () => resolve());
    });

    // handleIncomingEmail should bail early (no connection) — nothing enqueued
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});

describe('Email SMTP Server - Loop Prevention', () => {
  let onRcptToHandler: (
    address: { address: string },
    session: any,
    callback: (err?: Error) => void,
  ) => void;
  let onDataHandler: (stream: Readable, session: any, callback: () => void) => void;

  /** Simulate the RCPT TO → DATA flow with a shared session object. */
  async function simulateEmail(
    stream: Readable,
    session: { id: string } = makeSession(),
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      onRcptToHandler({ address: 'bot@company.com' }, session, (err?: Error) => {
        if (err) reject(err);
        else resolve();
      });
    });
    await new Promise<void>((resolve) => {
      onDataHandler(stream, session, () => resolve());
    });
  }

  beforeEach(async () => {
    vi.resetAllMocks();

    mockResolveChannelConnection.mockResolvedValue(MOCK_CONNECTION);
    mockGetInboundQueue.mockReturnValue({ add: mockQueueAdd });
    mockQueueAdd.mockResolvedValue({});

    await startSmtpServer();

    const MockClass = SMTPServer as any;
    onRcptToHandler = MockClass.lastOpts.onRcptTo;
    onDataHandler = MockClass.lastOpts.onData;
  });

  afterEach(async () => {
    await stopSmtpServer();
  });

  it('drops emails with X-ABL-Source header (self-sent loop prevention)', async () => {
    mockSimpleParser.mockResolvedValueOnce(
      makeParsedMail({
        headers: new Map([['x-abl-source', 'agent-platform']]),
      }),
    );

    await simulateEmail(Readable.from(['fake email stream']));

    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('drops emails with Auto-Submitted header (auto-reply loop prevention)', async () => {
    mockSimpleParser.mockResolvedValueOnce(
      makeParsedMail({
        headers: new Map([['auto-submitted', 'auto-replied']]),
      }),
    );

    await simulateEmail(Readable.from(['fake email stream']));

    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('drops emails with Auto-Submitted: auto-generated (DSN/bounce)', async () => {
    mockSimpleParser.mockResolvedValueOnce(
      makeParsedMail({
        headers: new Map([['auto-submitted', 'auto-generated']]),
      }),
    );

    await simulateEmail(Readable.from(['fake email stream']));

    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('allows emails with Auto-Submitted: no (manual send)', async () => {
    mockSimpleParser.mockResolvedValueOnce(
      makeParsedMail({
        headers: new Map([['auto-submitted', 'no']]),
      }),
    );

    await simulateEmail(Readable.from(['fake email stream']));

    expect(mockQueueAdd).toHaveBeenCalledOnce();
  });

  it('allows emails with Auto-Submitted: No (mixed case, RFC 3834 case-insensitive)', async () => {
    mockSimpleParser.mockResolvedValueOnce(
      makeParsedMail({
        headers: new Map([['auto-submitted', 'No']]),
      }),
    );

    await simulateEmail(Readable.from(['fake email stream']));

    expect(mockQueueAdd).toHaveBeenCalledOnce();
  });

  it('allows normal emails without loop headers', async () => {
    mockSimpleParser.mockResolvedValueOnce(
      makeParsedMail({
        headers: new Map(),
      }),
    );

    await simulateEmail(Readable.from(['fake email stream']));

    expect(mockQueueAdd).toHaveBeenCalledOnce();
  });
});

describe('Email SMTP Server - CC/BCC Extraction', () => {
  let onRcptToHandler: (
    address: { address: string },
    session: any,
    callback: (err?: Error) => void,
  ) => void;
  let onDataHandler: (stream: Readable, session: any, callback: () => void) => void;

  /** Simulate the RCPT TO → DATA flow with a shared session object. */
  async function simulateEmail(
    stream: Readable,
    session: { id: string } = makeSession(),
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      onRcptToHandler({ address: 'bot@company.com' }, session, (err?: Error) => {
        if (err) reject(err);
        else resolve();
      });
    });
    await new Promise<void>((resolve) => {
      onDataHandler(stream, session, () => resolve());
    });
  }

  beforeEach(async () => {
    vi.resetAllMocks();

    mockResolveChannelConnection.mockResolvedValue(MOCK_CONNECTION);
    mockGetInboundQueue.mockReturnValue({ add: mockQueueAdd });
    mockQueueAdd.mockResolvedValue({});

    await startSmtpServer();

    const MockClass = SMTPServer as any;
    onRcptToHandler = MockClass.lastOpts.onRcptTo;
    onDataHandler = MockClass.lastOpts.onData;
  });

  afterEach(async () => {
    await stopSmtpServer();
  });

  it('extracts CC addresses into metadata', async () => {
    mockSimpleParser.mockResolvedValueOnce(
      makeParsedMail({
        cc: { value: [{ address: 'cc1@example.com' }, { address: 'cc2@example.com' }] },
      }),
    );

    await simulateEmail(Readable.from(['fake email stream']));

    expect(mockQueueAdd).toHaveBeenCalledOnce();
    const payload = mockQueueAdd.mock.calls[0][1];
    expect(payload.message.metadata.cc).toEqual(['cc1@example.com', 'cc2@example.com']);
  });

  it('extracts BCC addresses into metadata', async () => {
    mockSimpleParser.mockResolvedValueOnce(
      makeParsedMail({
        bcc: { value: [{ address: 'bcc@example.com' }] },
      }),
    );

    await simulateEmail(Readable.from(['fake email stream']));

    expect(mockQueueAdd).toHaveBeenCalledOnce();
    const payload = mockQueueAdd.mock.calls[0][1];
    expect(payload.message.metadata.bcc).toEqual(['bcc@example.com']);
  });

  it('omits cc/bcc from metadata when not present', async () => {
    mockSimpleParser.mockResolvedValueOnce(makeParsedMail());

    await simulateEmail(Readable.from(['fake email stream']));

    expect(mockQueueAdd).toHaveBeenCalledOnce();
    const payload = mockQueueAdd.mock.calls[0][1];
    expect(payload.message.metadata).not.toHaveProperty('cc');
    expect(payload.message.metadata).not.toHaveProperty('bcc');
  });
});

describe('Email SMTP Server - Reply Parsing', () => {
  let onRcptToHandler: (
    address: { address: string },
    session: any,
    callback: (err?: Error) => void,
  ) => void;
  let onDataHandler: (stream: Readable, session: any, callback: () => void) => void;

  /** Simulate the RCPT TO → DATA flow with a shared session object. */
  async function simulateEmail(
    stream: Readable,
    session: { id: string } = makeSession(),
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      onRcptToHandler({ address: 'bot@company.com' }, session, (err?: Error) => {
        if (err) reject(err);
        else resolve();
      });
    });
    await new Promise<void>((resolve) => {
      onDataHandler(stream, session, () => resolve());
    });
  }

  beforeEach(async () => {
    vi.resetAllMocks();

    mockResolveChannelConnection.mockResolvedValue(MOCK_CONNECTION);
    mockGetInboundQueue.mockReturnValue({ add: mockQueueAdd });
    mockQueueAdd.mockResolvedValue({});

    await startSmtpServer();

    const MockClass = SMTPServer as any;
    onRcptToHandler = MockClass.lastOpts.onRcptTo;
    onDataHandler = MockClass.lastOpts.onData;
  });

  afterEach(async () => {
    await stopSmtpServer();
  });

  it('strips quoted text from reply emails before enqueuing', async () => {
    mockExtractReplyText.mockImplementationOnce(() => 'My account is 12345.');
    mockSimpleParser.mockResolvedValueOnce(
      makeParsedMail({
        text: 'My account is 12345.\n\nOn Mon, Jun 1 at 9:00 AM Agent wrote:\n> How can I help?',
      }),
    );

    await simulateEmail(Readable.from(['fake']));

    expect(mockQueueAdd).toHaveBeenCalledOnce();
    const payload = mockQueueAdd.mock.calls[0][1];
    expect(payload.message.text).toBe('My account is 12345.');
    expect(payload.message.metadata.fullText).toBe(
      'My account is 12345.\n\nOn Mon, Jun 1 at 9:00 AM Agent wrote:\n> How can I help?',
    );
  });

  it('does not store fullText when reply text matches raw text', async () => {
    mockExtractReplyText.mockImplementationOnce((text: string) => text);
    mockSimpleParser.mockResolvedValueOnce(
      makeParsedMail({
        text: 'Simple message with no quoted content',
      }),
    );

    await simulateEmail(Readable.from(['fake']));

    expect(mockQueueAdd).toHaveBeenCalledOnce();
    const payload = mockQueueAdd.mock.calls[0][1];
    expect(payload.message.text).toBe('Simple message with no quoted content');
    expect(payload.message.metadata).not.toHaveProperty('fullText');
  });
});

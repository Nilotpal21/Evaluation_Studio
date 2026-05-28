/**
 * Embedded SMTP Server
 *
 * Receives inbound email on a configurable port (default 2525),
 * parses the email, resolves the channel connection, and enqueues
 * the message to the channel-inbound BullMQ queue.
 *
 * For local dev: works out of the box on port 2525.
 * For production: point MX records to the server, open port 25.
 */

import { SMTPServer } from 'smtp-server';
import { simpleParser, type ParsedMail, type AddressObject } from 'mailparser';
import { createLogger } from '@abl/compiler/platform';
import { getCurrentTraceId, getObservabilityContext } from '@abl/compiler/platform/observability';
import { injectTrace } from '@agent-platform/shared-observability/tracing';
import { v4 as uuidv4 } from 'uuid';
import type { Readable } from 'node:stream';
import type {
  NormalizedIncomingMessage,
  InboundJobPayload,
  ResolvedConnection,
} from '../../channels/types.js';
import { resolveChannelConnection } from '../../channels/connection-resolver.js';
import { getInboundQueue } from '../queues/channel-queues.js';
import {
  processEmailAttachments,
  type EmailAttachmentRef,
} from '../../channels/adapters/email-attachment-processor.js';
import { MultimodalServiceClient } from '../../attachments/multimodal-service-client.js';
import { extractReplyText } from './email-reply-parser.js';

const log = createLogger('smtp-server');

/** Maximum email size accepted at SMTP level (25 MB, matching common provider limits). */
const MAX_EMAIL_SIZE_BYTES = 25 * 1024 * 1024;

let smtpServer: SMTPServer | null = null;

/**
 * Connections resolved during RCPT TO, keyed by SMTP session ID.
 * Set in onRcptTo, consumed (and deleted) in onData, cleaned up in onClose.
 */
const pendingConnections = new Map<string, ResolvedConnection>();

/**
 * Normalize an email subject by stripping Re:/Fwd:/Fw: prefixes.
 */
function normalizeSubject(subject: string): string {
  let s = subject;
  // Iteratively strip Re:/Fwd:/Fw: prefixes (handles "Re: Re: Fwd: ...")
  while (/^(Re|Fwd|Fw):\s*/i.test(s)) {
    s = s.replace(/^(Re|Fwd|Fw):\s*/i, '');
  }
  return s.trim();
}

/**
 * Extract the first email address from a mailparser AddressObject.
 */
function extractAddress(addr: AddressObject | AddressObject[] | undefined): string | null {
  if (!addr) return null;
  const obj = Array.isArray(addr) ? addr[0] : addr;
  return obj?.value?.[0]?.address || null;
}

/**
 * Extract all email addresses from a mailparser AddressObject (for CC/BCC).
 */
function extractAddresses(addr: AddressObject | AddressObject[] | undefined): string[] {
  if (!addr) return [];
  const obj = Array.isArray(addr) ? addr[0] : addr;
  if (!obj?.value) return [];
  return obj.value.map((v) => v.address).filter((a): a is string => !!a);
}

/**
 * Start the embedded SMTP server.
 */
export async function startSmtpServer(): Promise<void> {
  if (smtpServer) return;

  const port = parseInt(process.env.SMTP_LISTEN_PORT || '2525', 10);

  smtpServer = new SMTPServer({
    // No auth required for inbound MX server
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    size: MAX_EMAIL_SIZE_BYTES,
    logger: false,

    onRcptTo(address, session, callback) {
      resolveChannelConnection('email', address.address)
        .then((conn) => {
          if (!conn) {
            log.debug('RCPT TO rejected: no active connection', { to: address.address });
            callback(new Error('550 No such recipient'));
            return;
          }
          pendingConnections.set(session.id, conn);
          callback();
        })
        .catch((err) => {
          log.error('RCPT TO lookup failed', {
            to: address.address,
            error: err instanceof Error ? err.message : String(err),
          });
          callback(new Error('451 Temporary lookup failure'));
        });
    },

    onData(stream, session, callback) {
      const connection = pendingConnections.get(session.id);
      pendingConnections.delete(session.id);
      handleIncomingEmail(stream as unknown as Readable, connection ?? null)
        .then(() => callback())
        .catch((err) => {
          log.error('Failed to process incoming email', {
            error: err instanceof Error ? err.message : 'Unknown error',
          });
          callback();
        });
    },

    onClose(session, callback) {
      pendingConnections.delete(session.id);
      if (callback) callback();
    },
  });

  return new Promise((resolve, reject) => {
    smtpServer!.listen(port, () => {
      log.info('SMTP server listening', { port });
      resolve();
    });
    smtpServer!.on('error', (err) => {
      log.error('SMTP server error', { error: err.message });
      reject(err);
    });
  });
}

/**
 * Stop the SMTP server gracefully.
 */
export async function stopSmtpServer(): Promise<void> {
  if (!smtpServer) return;

  return new Promise((resolve) => {
    smtpServer!.close(() => {
      smtpServer = null;
      log.info('SMTP server stopped');
      resolve();
    });
  });
}

/**
 * Parse an incoming email stream and enqueue to the channel-inbound queue.
 * The connection is pre-resolved in onRcptTo to reject unknown recipients
 * before the email body is transmitted.
 */
async function handleIncomingEmail(
  stream: Readable,
  connection: ResolvedConnection | null,
): Promise<void> {
  if (!connection) {
    log.warn('No connection resolved for email, skipping');
    return;
  }

  const parsed: ParsedMail = (await simpleParser(stream)) as ParsedMail;

  const from = extractAddress(parsed.from);
  const messageId = parsed.messageId || `<${uuidv4()}@local>`;

  // ── Loop prevention ──────────────────────────────────────────────────────
  const headers = parsed.headers;
  if (headers.get('x-abl-source')) {
    log.info('Email dropped: self-sent (X-ABL-Source header)', { from, messageId });
    return;
  }
  const autoSubmitted = headers.get('auto-submitted');
  if (autoSubmitted && String(autoSubmitted).toLowerCase() !== 'no') {
    log.info('Email dropped: auto-reply (Auto-Submitted header)', {
      from,
      messageId,
      autoSubmitted,
    });
    return;
  }

  const to = extractAddress(parsed.to as AddressObject | AddressObject[] | undefined);
  const cc = extractAddresses(parsed.cc as AddressObject | AddressObject[] | undefined);
  const bcc = extractAddresses(parsed.bcc as AddressObject | AddressObject[] | undefined);
  const subject = parsed.subject || '(no subject)';
  const rawText = parsed.text || '';
  const text = extractReplyText(rawText);
  const inReplyTo = parsed.inReplyTo;
  const references = Array.isArray(parsed.references)
    ? parsed.references.join(' ')
    : parsed.references || '';

  if (!from || !to) {
    log.warn('Email missing from/to address, skipping', { from, to });
    return;
  }

  log.info('Email received', { from, to, subject, messageId });

  // ── Process email attachments (upload before enqueuing) ──────────────
  let emailAttachmentIds: string[] = [];
  if (parsed.attachments && parsed.attachments.length > 0) {
    const attachmentRefs: EmailAttachmentRef[] = parsed.attachments.map((att) => ({
      filename: att.filename || 'attachment',
      mimeType: att.contentType || 'application/octet-stream',
      sizeBytes: att.size,
      content: att.content,
    }));

    try {
      const mmClient = new MultimodalServiceClient();
      emailAttachmentIds = await processEmailAttachments(attachmentRefs, {
        tenantId: connection.tenantId,
        projectId: connection.projectId,
        sessionId: messageId, // Temp: real session resolved in inbound-worker; attachment retrieved by ID
        channel: 'email',
        uploadFn: (params) => mmClient.upload(params),
      });

      if (emailAttachmentIds.length > 0) {
        log.info('Email attachments uploaded', {
          messageId,
          count: emailAttachmentIds.length,
          attachmentIds: emailAttachmentIds,
        });
      }
    } catch (err) {
      log.error('Email attachment processing failed (non-blocking)', {
        messageId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Continue without attachments — don't block the text message
    }
  }

  // Build normalized message with RFC 5322 Message-ID based session key.
  //
  // Threading strategy:
  // - New email (no Re: prefix, no In-Reply-To/References): unique key per message
  //   → always creates a new session
  // - Reply with threading headers (In-Reply-To/References present): unique key per message
  //   → session resolver finds existing session via emailMessageIds lookup
  // - Reply with Re: prefix but no threading headers (unusual client): subject-based key
  //   → backward-compatible fallback for clients that strip headers
  const normalizedSubject = normalizeSubject(subject);
  const subjectBasedKey = `email:${connection.id}:${from.toLowerCase()}:${normalizedSubject.toLowerCase()}`;
  const hasThreadingHeaders = !!((inReplyTo || '').toString().trim() || references.trim());
  const hasReplyPrefix = /^(Re|Fwd|Fw):\s/i.test(subject);

  let externalSessionKey: string;
  if (hasReplyPrefix && !hasThreadingHeaders) {
    // Re:/Fwd: prefix but no threading headers — unusual client.
    // Fall back to subject-based matching for backward compatibility.
    externalSessionKey = subjectBasedKey;
  } else {
    // New email OR reply with proper threading headers.
    // Use message-ID-based unique key. For replies, the session resolver
    // will find the existing session via In-Reply-To/References lookup.
    externalSessionKey = `email:${connection.id}:msg:${messageId}`;
  }

  const message: NormalizedIncomingMessage = {
    externalMessageId: messageId,
    externalSessionKey,
    text,
    metadata: {
      from,
      to,
      subject,
      messageId,
      inReplyTo,
      references,
      subjectBasedKey,
      hasThreadingHeaders,
      ...(cc.length > 0 && { cc }),
      ...(bcc.length > 0 && { bcc }),
      ...(rawText !== text && { fullText: rawText }),
      ...(emailAttachmentIds.length > 0 && { emailAttachmentIds }),
    },
    timestamp: parsed.date || new Date(),
  };

  // Enqueue to channel-inbound queue
  const queue = getInboundQueue();

  if (!queue) {
    log.warn('Inbound queue not available, email will not be processed', { messageId });
    return;
  }

  const idempotencyKey = `email-${messageId.replace(/[:<>@]/g, '_')}`;
  const jobPayload: InboundJobPayload = {
    connectionId: connection.id,
    tenantId: connection.tenantId,
    projectId: connection.projectId,
    agentId: connection.agentId,
    channelType: 'email',
    message,
    subscriptionId: connection.id, // Use connection ID as subscription for email
    idempotencyKey,
    traceId: getCurrentTraceId(),
  };

  // Inject full span context for cross-boundary propagation
  const obsCtx = getObservabilityContext();
  if (obsCtx) {
    injectTrace(jobPayload as unknown as Record<string, unknown>, {
      traceId: obsCtx.traceId,
      spanId: obsCtx.spanId,
    });
  }

  await queue.add('email-inbound', jobPayload, {
    jobId: idempotencyKey,
  });

  log.info('Email enqueued for processing', {
    messageId,
    connectionId: connection.id,
    sessionKey: message.externalSessionKey,
  });
}

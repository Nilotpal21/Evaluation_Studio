# Feature: Email Channel / SMTP

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: BETA
**Feature Area(s)**: `integrations`, `customer experience`
**Package(s)**: `apps/runtime`
**Owner(s)**: Platform team
**Testing Guide**: `../testing/email-channel.md`
**Last Updated**: 2026-03-23

---

## 1. Introduction / Overview

### Problem Statement

Enterprise customers need to interact with agents via email -- a channel that remains dominant in B2B communications (ticketing, support, procurement). Without an email channel, the ABL platform is limited to web/SDK, voice, and messaging channels, excluding a significant enterprise communication pathway. Operators who deploy agents for internal helpdesks or customer support cannot reach users who prefer asynchronous email-based interaction.

### Goal Statement

Provide a fully integrated email channel with inbound SMTP reception, outbound multi-transport delivery (SMTP and Microsoft Graph API), email threading, reply text extraction, attachment processing, and loop prevention -- enabling agents to participate in email conversations as naturally as a human agent would.

### Summary

The Email Channel consists of an embedded SMTP server (`smtp-server` package) for inbound email reception and a pluggable transport layer for outbound delivery. Inbound emails are parsed via `mailparser`, normalized, and enqueued to the `channel-inbound` BullMQ queue. Outbound replies support SMTP (via `nodemailer`) and Microsoft Graph API transports with email threading (In-Reply-To/References headers), HTML/text dual delivery, and CSAT feedback token generation. The feature integrates with the platform's channel adapter pattern, attachment processing pipeline, and observability infrastructure.

---

## 2. Scope

### Goals

- Embedded SMTP server for inbound email on configurable port (default 2525, env `SMTP_PORT`)
- Email parsing with reply text extraction (strip quotes, signatures, forwarded headers) via `email-reply-parser`
- Session threading via RFC 5322 Message-ID, In-Reply-To, and References headers with subject-based fallback
- Pluggable outbound transports: SMTP (nodemailer) and Microsoft Graph API (OAuth2 client credentials)
- Email attachment processing with multimodal service upload (non-blocking: text enqueued even if attachments fail)
- Loop prevention via `X-ABL-Source` header injection and `Auto-Submitted` header detection
- HTML email rendering with markdown conversion (`marked`) and XSS protection (no `javascript:` links, no `<img>` tags)
- Header/footer template injection from channel connection config
- CSAT feedback token generation (JWT-based, 30-day TTL) for email replies
- CC forwarding with self-address filtering; BCC suppressed on replies

### Non-Goals (Out of Scope)

- IMAP/POP3 inbound polling (only SMTP push reception)
- Email template editor UI in Studio
- Bounce handling and delivery status notifications (DSN)
- SPF/DKIM/DMARC verification of inbound email
- Graph API inbound (inbox polling via delta sync / change notifications)
- Email-specific analytics dashboards
- Plus-addressing normalization (user+tag@example.com treated as distinct address)

---

## 3. User Stories

1. As a **customer**, I want to email my agent and receive a threaded reply so that I can interact naturally via email without leaving my inbox.
2. As a **platform operator**, I want to configure email channels with either SMTP or Microsoft Graph outbound so that I can use my organization's email infrastructure (including Microsoft 365 environments that block SMTP relay).
3. As a **customer**, I want email attachments forwarded to the agent so that I can share documents, screenshots, and files via email.
4. As a **platform operator**, I want loop prevention so that agent replies do not trigger infinite email loops with auto-responders or mailing lists.
5. As a **platform operator**, I want CSAT feedback links in agent replies so that customers can rate the response directly from the email.
6. As a **security engineer**, I want HTML email output sanitized against XSS so that agent replies do not introduce security vulnerabilities.
7. As a **customer**, I want my CC recipients included in agent replies so that the full conversation thread is visible to all participants.

---

## 4. Functional Requirements

1. **FR-1**: The system must accept inbound email on a configurable SMTP port (default 2525), resolve the channel connection from the RCPT TO address via `resolveChannelConnection('email', address)`, and reject unknown recipients with SMTP 550 before body transmission.
2. **FR-2**: The system must extract only the latest reply text from inbound emails using `email-reply-parser`, stripping quoted text, signatures, and forwarded headers. If the parser strips everything, the original text must be preserved as fallback.
3. **FR-3**: The system must thread email sessions using three strategies: (a) Message-ID-based unique key for new emails, (b) In-Reply-To/References header lookup for replies with threading headers, (c) subject-based key fallback (`email:{connId}:{from}:{normalizedSubject}`) for clients that strip threading headers but include Re:/Fwd: prefix.
4. **FR-4**: The system must support SMTP and Microsoft Graph API outbound transports, selected per channel connection via `connection.config.outbound.transport` (default: `smtp`). Transport instances must be cached per connection ID with config fingerprint (SHA-256), 30-min TTL, and max 100 entries with LRU eviction.
5. **FR-5**: The system must prevent email loops by: (a) dropping inbound emails with `X-ABL-Source` header, (b) dropping emails with `Auto-Submitted` header value other than `no`, (c) injecting `X-ABL-Source: agent-platform` header on all outbound emails.
6. **FR-6**: The system must process email attachments by uploading them to the multimodal service before enqueuing, with 20 MB per-attachment limit, 5-concurrent upload limit, and non-blocking failure (text message enqueued even if attachment processing fails).
7. **FR-7**: The system must limit inbound email size to 25 MB at the SMTP level (`size: 25 * 1024 * 1024`).
8. **FR-8**: The system must render outbound HTML email by converting agent text (markdown) to HTML via `marked` with XSS protection: escape raw HTML entities, neutralize `javascript:`/`vbscript:`/`data:` URI schemes in links, render `<img>` tags as text links to prevent tracking pixels.
9. **FR-9**: The system must support header/footer template injection from `connection.config.emailHeader` and `connection.config.emailFooter` into outbound HTML.
10. **FR-10**: The system must generate JWT-based CSAT feedback tokens (30-day TTL, signed with `JWT_SECRET`) containing `tenantId`, `projectId`, `sessionId`, `messageId`, and `connectionId`, and render clickable rating links (1-5 scale) in outbound email when `connection.config.csatEnabled` is true.
11. **FR-11**: The system must forward CC recipients on outbound replies (excluding the agent's own address to prevent self-echo) and suppress BCC recipients on replies.
12. **FR-12**: The Graph API transport must use a draft-then-send flow to retrieve the RFC 5322 `internetMessageId` for threading, cache OAuth2 tokens with 5-min expiry buffer, deduplicate concurrent token requests, retry on 401 with token refresh (once), and propagate 429 with `Retry-After` for BullMQ retry.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                            |
| -------------------------- | ------------ | ---------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Email channels configured per project                            |
| Agent lifecycle            | SECONDARY    | Agents receive/send via email when channel is configured         |
| Customer experience        | PRIMARY      | Core interaction channel for email-preferring customers          |
| Integrations / channels    | PRIMARY      | Adds email as a first-class channel type in the adapter registry |
| Observability / tracing    | SECONDARY    | Trace context propagated from SMTP session to BullMQ job         |
| Governance / controls      | NONE         | No guardrail-specific integration                                |
| Enterprise / compliance    | SECONDARY    | JWT-signed feedback tokens, XSS protection, loop prevention      |
| Admin / operator workflows | SECONDARY    | Channel connection configuration via Studio                      |

### Related Feature Integration Matrix

| Related Feature        | Relationship Type | Why It Matters                                                                                                        |
| ---------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| Channel Infrastructure | depends on        | Uses channel connection resolution (`resolveChannelConnection`), adapter registry, and `channel-inbound` BullMQ queue |
| Attachments            | shares data with  | Email attachments uploaded via `MultimodalServiceClient` before enqueuing                                             |
| Observability          | emits into        | Trace context propagated from SMTP session to inbound worker                                                          |
| Session Management     | depends on        | Email sessions keyed by `externalSessionKey` resolved via session manager                                             |
| CSAT / Feedback        | extends           | JWT-signed feedback tokens embedded in email HTML for rating collection                                               |

---

## 6. Design Considerations

- **Embedded SMTP server** (`smtp-server` package) rather than external MTA -- simplifies dev/test deployment; production uses MX record pointing to runtime port 25
- **Pluggable transport interface** decouples outbound delivery from inbound reception, allowing SMTP and Graph API transports to coexist
- **Graph API draft-then-send** flow retrieves `internetMessageId` for RFC 5322 threading (single-step send does not return this ID)
- **Three-tier session threading** strategy handles both well-behaved and header-stripping email clients
- **Non-blocking attachment processing** -- attachment failure does not prevent text message from being enqueued
- **Connection resolution in `onRcptTo`** rejects unknown recipients before email body transmission, saving bandwidth
- **`pendingConnections` Map** keyed by SMTP session ID bridges the resolved connection between `onRcptTo` and `onData` callbacks

---

## 7. Technical Considerations

- `pendingConnections` Map keyed by SMTP session ID stores resolved connections between `onRcptTo` and `onData` phases. **GAP**: This Map has no max size or TTL -- under connection storms it could grow unbounded (see GAP-004).
- Connection resolution in `onRcptTo` allows rejecting unknown recipients before body transmission (saves bandwidth).
- Graph API token cached with 5-min expiry buffer; concurrent token acquisitions deduplicated via `pendingTokenRequest` promise pattern.
- Transport instances cached per connection ID with config fingerprint (SHA-256 of `tenantId:clientId:sender:secret`), 30-min TTL, max 100 entries.
- HTML output sanitized: no `javascript:`/`vbscript:`/`data:` links, no `<img>` tags (rendered as text links to prevent remote tracking pixels).
- `safeMarked` renderer overrides `html()`, `link()`, and `image()` methods via `marked` library for safe HTML generation.
- Email idempotency key derived from Message-ID: `email-{messageId.replace(/[:<>@]/g, '_')}`.
- STARTTLS disabled on the embedded SMTP server (`disabledCommands: ['STARTTLS']`) -- intended for internal/MX use behind TLS-terminating load balancer.

---

## 8. How to Consume

### Studio UI

Email channel connections are configured in Studio under project settings. Operators configure:

- Inbound email address (used for RCPT TO matching)
- Outbound transport type (`smtp` or `graph`)
- SMTP relay credentials (host, port, user, pass) via environment variables
- Graph API credentials (tenantId, clientId, clientSecret, senderAddress) via connection config + credentials
- Optional: `emailHeader`, `emailFooter` templates, `csatEnabled` flag, `fromName` display name

### API (Runtime)

The email channel is not consumed via REST API directly. It operates through:

- **SMTP port**: Inbound emails received on configurable port (default 2525)
- **BullMQ queue**: Inbound emails enqueued to `channel-inbound` for processing
- **Channel adapter**: `EmailAdapter.sendResponse()` sends outbound replies via resolved transport

| Method | Path                      | Purpose                                   |
| ------ | ------------------------- | ----------------------------------------- |
| GET    | `/api/v1/feedback/:token` | CSAT feedback rating endpoint (JWT token) |

### API (Studio)

Channel connection CRUD is managed through the standard Studio channel connection API (not email-specific).

### Admin Portal

No email-specific admin UI. Email channels are managed per-project in Studio.

### Channel / SDK / Voice / A2A / MCP Integration

The email channel follows the standard `ChannelAdapter` interface. It does not support streaming (`supportsStreaming: false`), supports async delivery (`supportsAsync: true`), supports media (`supportsMedia: true`), and supports threading (`supportsThreading: true`). The `verifyRequest()` method always returns `true` since SMTP handles its own authentication/verification.

---

## 9. Data Model

The email channel does not introduce its own MongoDB collections. It relies on existing collections:

### Collections Used

- **`channel_connections`** -- Stores email channel configs (inbound address, outbound transport type, Graph API credentials, header/footer templates, CSAT flag)
- **`sessions`** -- Email sessions keyed by `externalSessionKey`
- **`messages`** -- Email messages stored as standard conversation messages

### Email-Specific Metadata

```text
NormalizedIncomingMessage.metadata:
  - from: string (sender email)
  - to: string (recipient email)
  - subject: string
  - messageId: string (RFC 5322 Message-ID)
  - inReplyTo: string (for threading)
  - references: string (for threading)
  - subjectBasedKey: string (fallback threading key)
  - hasThreadingHeaders: boolean
  - cc: string[] (optional)
  - bcc: string[] (optional)
  - fullText: string (optional, when reply extraction differs from raw)
  - emailAttachmentIds: string[] (optional, uploaded attachment IDs)
```

### Key Relationships

- `channel_connections` stores the email configuration (inbound address, outbound transport, Graph credentials)
- `sessions` are keyed by `externalSessionKey` derived from email threading headers or subject
- Email attachments are uploaded to the multimodal service and referenced by `emailAttachmentIds` in message metadata
- CSAT feedback tokens reference `tenantId`, `projectId`, `sessionId`, `messageId`, `connectionId`

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                | Purpose                                                    |
| ------------------------------------------------------------------- | ---------------------------------------------------------- |
| `apps/runtime/src/services/email/smtp-server.ts`                    | Embedded SMTP server (inbound reception, 322 LOC)          |
| `apps/runtime/src/services/email/email-reply-parser.ts`             | Reply text extraction via `email-reply-parser` (30 LOC)    |
| `apps/runtime/src/services/email/email-sender.ts`                   | Legacy SMTP sender (deprecated, wrapper around nodemailer) |
| `apps/runtime/src/services/email/feedback-token.ts`                 | CSAT feedback JWT generation/verification (49 LOC)         |
| `apps/runtime/src/services/email/transports/transport-interface.ts` | Pluggable transport interface definition (24 LOC)          |
| `apps/runtime/src/services/email/transports/smtp-transport.ts`      | SMTP outbound via nodemailer (67 LOC)                      |
| `apps/runtime/src/services/email/transports/graph-transport.ts`     | Microsoft Graph API outbound (211 LOC)                     |
| `apps/runtime/src/services/email/transports/resolve-transport.ts`   | Transport factory + cache (108 LOC)                        |
| `apps/runtime/src/channels/adapters/email-adapter.ts`               | Channel adapter for email (223 LOC)                        |
| `apps/runtime/src/channels/adapters/email-attachment-processor.ts`  | Email attachment upload processor (112 LOC)                |

### Tests

| File                                                                     | Type        | Coverage Focus                                       |
| ------------------------------------------------------------------------ | ----------- | ---------------------------------------------------- |
| `apps/runtime/src/__tests__/email-channel-e2e.test.ts`                   | e2e         | Full inbound-outbound flow, threading, CC/BCC, HTML  |
| `apps/runtime/src/__tests__/email-smtp-server.test.ts`                   | unit        | SMTP server lifecycle                                |
| `apps/runtime/src/__tests__/email-sender.test.ts`                        | unit        | Legacy email sender                                  |
| `apps/runtime/src/__tests__/email-adapter.test.ts`                       | unit        | Email adapter normalization                          |
| `apps/runtime/src/__tests__/email/smtp-transport.test.ts`                | unit        | SMTP transport send + health check                   |
| `apps/runtime/src/__tests__/email/resolve-transport.test.ts`             | unit        | Transport resolution + caching                       |
| `apps/runtime/src/__tests__/email/email-adapter-transport.test.ts`       | integration | Adapter with transport layer                         |
| `apps/runtime/src/__tests__/email/email-smtp-server.test.ts`             | unit        | SMTP server parse + enqueue                          |
| `apps/runtime/src/__tests__/email/email-reply-parser.test.ts`            | unit        | Reply text extraction                                |
| `apps/runtime/src/__tests__/email/feedback-token.test.ts`                | unit        | CSAT feedback JWT sign/verify                        |
| `apps/runtime/src/__tests__/email/feedback-endpoint.test.ts`             | unit        | Feedback HTTP endpoint handling                      |
| `apps/runtime/src/__tests__/email/graph-transport.test.ts`               | unit        | Graph API transport send + token caching + 401 + 429 |
| `apps/runtime/src/__tests__/adapters/email-attachment-processor.test.ts` | unit        | Attachment upload + size limit + concurrency         |

---

## 11. Configuration

### Environment Variables

| Variable                  | Default                 | Description                              |
| ------------------------- | ----------------------- | ---------------------------------------- |
| `SMTP_PORT`               | `2525`                  | Inbound SMTP server port                 |
| `SMTP_RELAY_HOST`         | `localhost`             | Outbound SMTP relay host                 |
| `SMTP_RELAY_PORT`         | `587`                   | Outbound SMTP relay port                 |
| `SMTP_RELAY_USER`         | (empty)                 | SMTP relay username                      |
| `SMTP_RELAY_PASS`         | (empty)                 | SMTP relay password                      |
| `EMAIL_FROM_ADDRESS`      | `agent@localhost`       | Default sender address                   |
| `EMAIL_FROM_NAME`         | `Agent`                 | Default sender display name              |
| `JWT_SECRET`              | (required)              | Required for CSAT feedback token signing |
| `RUNTIME_PUBLIC_BASE_URL` | `http://localhost:3112` | Base URL for CSAT feedback links         |

### Connection Config Fields

| Field                                 | Type    | Description                               |
| ------------------------------------- | ------- | ----------------------------------------- |
| `config.outbound.transport`           | string  | `smtp` (default) or `graph`               |
| `config.outbound.graph.tenantId`      | string  | Azure AD tenant ID for Graph API          |
| `config.outbound.graph.clientId`      | string  | Azure AD application client ID            |
| `config.outbound.graph.senderAddress` | string  | Graph API sender email address            |
| `credentials.graph_client_secret`     | string  | Azure AD client secret (stored encrypted) |
| `config.emailHeader`                  | string  | HTML header injected before email body    |
| `config.emailFooter`                  | string  | HTML footer injected after email body     |
| `config.csatEnabled`                  | boolean | Enable CSAT feedback links in replies     |
| `config.fromName`                     | string  | Display name for outbound "From" header   |

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement                                                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation  | Channel connections are tenant-scoped; email sessions inherit tenant context from connection. Connection resolution maps RCPT TO address to a specific tenant's connection. |
| Project isolation | Email sessions are scoped to the project associated with the channel connection. `InboundJobPayload` carries `projectId` from the resolved connection.                      |
| User isolation    | Email sessions keyed by sender email address within the channel connection scope. Different senders get different sessions.                                                 |

### Security & Compliance

- Loop prevention via `X-ABL-Source` and `Auto-Submitted` headers (FR-5)
- 25 MB email size limit at SMTP level (FR-7)
- 20 MB per-attachment limit in attachment processor
- HTML output sanitized: no `javascript:`/`vbscript:`/`data:` links, no `<img>` tags (FR-8)
- CSAT feedback tokens are JWT-signed with `JWT_SECRET`, 30-day configurable TTL
- Graph API client secret stored in connection credentials (intended for encrypted storage)
- STARTTLS disabled on embedded SMTP server -- production deployments should use TLS termination at load balancer
- **Gap**: No SPF/DKIM/DMARC verification on inbound email (see GAP-001)

### Performance & Scalability

- Transport instances cached per connection ID with config fingerprint (SHA-256), 30-min TTL, max 100 entries, LRU eviction
- Graph API OAuth2 token cached with 5-min expiry buffer, concurrent token acquisitions deduplicated via `pendingTokenRequest` promise pattern
- Email attachment uploads limited to 5 concurrent per email
- Idempotency key from Message-ID prevents duplicate processing via BullMQ `jobId`

### Reliability & Failure Modes

- Attachment processing failure is non-blocking: email text still enqueued (FR-6)
- Graph API 401 triggers token refresh + single retry (FR-12)
- Graph API 429 propagated with `Retry-After` for BullMQ automatic retry scheduling
- Unknown RCPT TO address rejected with SMTP 550 before body transmission
- Empty reply parser output falls back to original email text
- Missing `from`/`to` addresses cause email skip with warning log

### Observability

- `createLogger('smtp-server')`, `createLogger('email-adapter')`, `createLogger('smtp-transport')`, `createLogger('graph-transport')`, `createLogger('email-transport-resolver')`, `createLogger('email-attachment-processor')` for structured logging
- Key events logged: email received, email enqueued, email sent, loop dropped, attachment upload, transport creation
- BullMQ job metadata carries trace context from SMTP session

### Data Lifecycle

- Transport cache entries expire after 30 minutes (TTL)
- Graph API tokens expire based on Azure AD token lifetime minus 5-minute buffer
- CSAT feedback tokens expire after 30 days
- `pendingConnections` Map entries cleaned up in `onClose` callback
- **Gap**: `pendingConnections` Map has no max size -- could grow under connection storms (see GAP-004)

---

## 13. Delivery Plan / Work Breakdown

1. **Inbound SMTP Server**
   1.1 Embedded SMTP server with configurable port and 25 MB size limit
   1.2 Connection resolution from RCPT TO address (reject unknown before body)
   1.3 Loop prevention (X-ABL-Source, Auto-Submitted header detection)
   1.4 Email parsing via `mailparser` (from, to, cc, bcc, subject, messageId, inReplyTo, references)
2. **Reply Text Extraction**
   2.1 Integration with `email-reply-parser` library
   2.2 Fallback to original text when parser strips everything
3. **Transport Layer**
   3.1 `EmailTransport` interface definition (`sendReply`, optional `checkHealth`)
   3.2 SMTP transport via `nodemailer` (extracted from legacy `EmailSender`)
   3.3 Graph API transport (OAuth2 client credentials, draft-then-send flow)
   3.4 Transport resolution factory with config-fingerprint cache (30-min TTL, max 100)
4. **Email Threading**
   4.1 Message-ID-based session keys for new emails
   4.2 In-Reply-To/References header lookup for replies
   4.3 Subject-based fallback for header-stripping clients
5. **Email Adapter**
   5.1 `EmailAdapter` implementing `ChannelAdapter` interface
   5.2 HTML rendering with markdown conversion and XSS protection via `safeMarked`
   5.3 Header/footer template injection from connection config
   5.4 CC forwarding with self-address filtering; BCC suppression
6. **Attachment Processing**
   6.1 Upload to multimodal service (20 MB per-file limit, 5 concurrent uploads)
   6.2 Non-blocking failure handling
7. **CSAT Feedback Tokens**
   7.1 JWT-based token generation (`signFeedbackToken`) and verification (`verifyFeedbackToken`)
   7.2 Rating HTML block with 5-point scale links
   7.3 Feedback HTTP endpoint (`/api/v1/feedback/:token`)

---

## 14. Success Metrics

| Metric                    | Baseline | Target | How Measured                                    |
| ------------------------- | -------- | ------ | ----------------------------------------------- |
| Email delivery rate       | N/A      | >99%   | Outbound send success/failure ratio in logs     |
| Threading accuracy        | N/A      | >95%   | Sessions correctly threaded vs new session      |
| Inbound processing time   | N/A      | <2s    | SMTP receipt to BullMQ enqueue latency          |
| Transport cache hit rate  | N/A      | >90%   | Cached transport reuse vs new instance creation |
| Attachment upload success | N/A      | >98%   | Attachment IDs returned vs total attempted      |

---

## 15. Open Questions

1. Should SPF/DKIM/DMARC verification be added for inbound email authenticity? (Would prevent spoofed sender addresses)
2. Should bounce handling and delivery status notifications (DSN) be implemented? (Would enable retry logic and sender notification)
3. Should STARTTLS be enabled on the embedded SMTP server for production use, or should TLS always be handled at the load balancer?
4. Should `pendingConnections` Map have a max size and TTL to prevent unbounded growth under connection storms?
5. Should the deprecated `EmailSender` class be fully removed now that the transport layer is complete?
6. Should plus-addressing normalization (`user+tag@example.com` -> `user@example.com`) be added for CC self-filtering?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                | Severity | Status |
| ------- | ------------------------------------------------------------------------------------------ | -------- | ------ |
| GAP-001 | No SPF/DKIM/DMARC verification on inbound email                                            | Medium   | Open   |
| GAP-002 | No bounce handling or delivery status tracking                                             | Medium   | Open   |
| GAP-003 | STARTTLS disabled on inbound SMTP server                                                   | Low      | Open   |
| GAP-004 | `pendingConnections` Map has no max size / TTL                                             | Low      | Open   |
| GAP-005 | `EmailSender` class deprecated but still imported by tests                                 | Low      | Open   |
| GAP-006 | E2E test uses `vi.mock()` for transport resolver and feedback token -- not a true E2E test | Medium   | Open   |
| GAP-007 | No E2E test for email attachment processing                                                | Medium   | Open   |
| GAP-008 | No live E2E test for Graph API transport                                                   | Medium   | Open   |
| GAP-009 | Plus-addressing not handled in CC self-filtering                                           | Low      | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                    | Coverage Type | FR    | Status     |
| --- | ------------------------------------------- | ------------- | ----- | ---------- |
| 1   | Inbound email parsing + enqueue             | e2e           | FR-1  | PASS       |
| 2   | Email threading (In-Reply-To session reuse) | e2e           | FR-3  | PASS       |
| 3   | CC/BCC handling (forward CC, suppress BCC)  | e2e           | FR-11 | PASS       |
| 4   | HTML email rendering + XSS protection       | e2e           | FR-8  | PASS       |
| 5   | Header/footer templates                     | e2e           | FR-9  | PASS       |
| 6   | Loop prevention (X-ABL-Source)              | unit          | FR-5  | PARTIAL    |
| 7   | Reply text extraction                       | unit          | FR-2  | PASS       |
| 8   | SMTP transport send + health                | unit          | FR-4  | PASS       |
| 9   | Transport resolution + caching              | unit          | FR-4  | PASS       |
| 10  | Graph API transport + token + 401 + 429     | unit          | FR-12 | PASS       |
| 11  | CSAT feedback tokens                        | unit          | FR-10 | PASS       |
| 12  | Email attachment processing                 | unit          | FR-6  | PASS       |
| 13  | Feedback HTTP endpoint                      | unit          | FR-10 | PASS       |
| 14  | Error scenarios (SMTP send failure)         | e2e           | FR-4  | PASS       |
| 15  | Cross-tenant email isolation                | e2e           | -     | NOT TESTED |
| 16  | Real SMTP server E2E                        | e2e           | FR-1  | NOT TESTED |
| 17  | Live Graph API E2E                          | e2e           | FR-12 | NOT TESTED |

### E2E Test Scenarios (minimum 5)

1. **Inbound-to-outbound flow**: Send an email to the SMTP server, verify it is parsed, connection resolved, message enqueued, and agent reply sent with correct threading headers via the adapter.
2. **Session threading**: Send a follow-up email with In-Reply-To/References headers, verify it reuses the existing session (same externalSessionKey resolution).
3. **CC/BCC routing**: Send an email with CC and BCC recipients, verify outbound reply includes CC (minus self) and excludes BCC.
4. **Cross-tenant isolation**: Configure two tenant email connections, send emails to each, verify messages route to correct tenant context and cannot cross tenant boundaries.
5. **Attachment upload flow**: Send an email with attachments, verify attachments are uploaded to multimodal service and IDs are included in message metadata.

### Integration Test Scenarios (minimum 5)

1. **Transport resolution**: Verify SMTP default and Graph selection based on connection config, cache hit/miss, and fingerprint invalidation.
2. **Reply text extraction**: Verify quoted text, signatures, and forwarded headers are stripped across different email client formats.
3. **HTML rendering with XSS**: Verify `javascript:` links are neutralized, `<img>` tags rendered as text links, raw HTML is escaped.
4. **Graph API token lifecycle**: Verify token caching, 5-min buffer expiry, concurrent deduplication, 401 retry, and 429 propagation.
5. **CSAT feedback token**: Verify JWT sign/verify round-trip, expiry, and invalid token rejection.

> Full testing details: `../testing/email-channel.md`

---

## 18. References

- `apps/runtime/src/services/email/` -- Email service directory
- `apps/runtime/src/channels/adapters/email-adapter.ts` -- Channel adapter
- `apps/runtime/src/channels/adapters/email-attachment-processor.ts` -- Attachment processor
- `docs/plans/2026-03-09-email-graph-api-design.md` -- Graph API transport design doc
- `docs/plans/2026-03-09-email-graph-api-impl.md` -- Graph API implementation plan
- `docs/features/channels.md` -- Parent channel infrastructure feature spec

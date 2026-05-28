# HLD: Email Channel / SMTP

**Feature Spec**: `docs/features/email-channel.md`
**Test Spec**: `docs/testing/email-channel.md`
**Status**: APPROVED
**Author**: Platform team
**Date**: 2026-03-23

---

## 1. Problem Statement

Enterprise customers need to interact with agents via email -- a channel that remains dominant in B2B communications. Without an email channel, the ABL platform is limited to web/SDK, voice, and messaging channels. Operators deploying agents for internal helpdesks or customer support cannot reach users who prefer asynchronous email-based interaction. The email channel must handle inbound SMTP reception, outbound multi-transport delivery (SMTP and Microsoft Graph API), email threading, reply text extraction, attachment processing, and loop prevention.

---

## 2. Alternatives Considered

### Option A: External MTA + Webhook Relay

- **Description**: Use an external Mail Transfer Agent (e.g., Postfix, Amazon SES) to receive inbound email and relay parsed messages to the runtime via HTTP webhook.
- **Pros**: Battle-tested SMTP handling, TLS/DKIM built-in, scales independently, no SMTP library dependency in runtime.
- **Cons**: Additional infrastructure to manage, increased deployment complexity, higher latency (external hop), webhook endpoint must be exposed publicly, additional Docker service to orchestrate.
- **Effort**: L

### Option B: Embedded SMTP Server with Pluggable Transports (Chosen)

- **Description**: Embed a lightweight SMTP server (`smtp-server` npm package) directly in the runtime process. Parse inbound emails with `mailparser`, enqueue via BullMQ. Outbound via pluggable transports: SMTP (nodemailer) or Microsoft Graph API.
- **Pros**: Zero additional infrastructure for dev/test, single deployment unit, transport interface allows easy extension (e.g., future Amazon SES transport), direct access to BullMQ queue, adapter pattern matches existing channel architecture.
- **Cons**: Runtime process handles SMTP protocol (minor CPU overhead), no built-in TLS/DKIM (rely on load balancer), `pendingConnections` Map is process-local state, limited to single runtime instance for SMTP (load balancer can distribute).
- **Effort**: M

### Option C: Third-Party Email API (SendGrid/Mailgun)

- **Description**: Use a third-party email API for both inbound (webhook parse) and outbound delivery.
- **Pros**: Managed infrastructure, deliverability optimization, analytics, bounce handling built-in.
- **Cons**: Vendor lock-in, cost per email, data sovereignty concerns (email content leaves platform), not all enterprises allow third-party email processing, additional latency.
- **Effort**: S

### Recommendation: Option B (Embedded SMTP + Pluggable Transports)

**Rationale**: Option B matches the platform's channel adapter pattern, requires zero additional infrastructure for development and testing, and supports the enterprise requirement for Microsoft Graph API (which Option C does not address). The embedded approach keeps email processing within the runtime's existing BullMQ and observability infrastructure. The pluggable transport interface future-proofs for additional transports (SES, SendGrid) without architectural changes. Option A would be the production hardening path if SMTP volume exceeds single-instance capacity.

---

## 3. Architecture

### System Context Diagram

```
                                    ABL Platform
                    ┌─────────────────────────────────────────────┐
                    │                                             │
    ┌─────────┐     │  ┌──────────┐   ┌──────────┐   ┌────────┐ │
    │ Customer │──SMTP──│  SMTP    │──►│ BullMQ   │──►│ Agent  │ │
    │  Inbox   │     │  │  Server  │   │ Inbound  │   │ Engine │ │
    │          │◄────│──│          │   │ Queue    │   │        │ │
    └─────────┘     │  └──────────┘   └──────────┘   └───┬────┘ │
         ▲          │                                     │      │
         │          │  ┌──────────┐   ┌──────────────┐    │      │
         │          │  │ Email    │◄──│ Channel      │◄───┘      │
         └──────────│──│ Adapter  │   │ Dispatcher   │           │
                    │  └────┬─────┘   └──────────────┘           │
                    │       │                                     │
                    │  ┌────▼─────────────────────┐              │
                    │  │ Transport Resolver        │              │
                    │  │ ┌────────┐  ┌──────────┐ │              │
                    │  │ │  SMTP  │  │  Graph   │ │              │
                    │  │ │  Txp   │  │  API Txp │ │              │
                    │  │ └────────┘  └──────────┘ │              │
                    │  └──────────────────────────┘              │
                    │                                             │
                    │  ┌──────────────┐  ┌──────────────────┐    │
                    │  │ Multimodal   │  │ Feedback Token   │    │
                    │  │ Service      │  │ (JWT CSAT)       │    │
                    │  └──────────────┘  └──────────────────┘    │
                    └─────────────────────────────────────────────┘
```

### Component Diagram

```
apps/runtime/src/
├── services/email/
│   ├── smtp-server.ts           # Inbound SMTP reception
│   │   ├── startSmtpServer()    # Listen on SMTP_PORT
│   │   ├── onRcptTo()           # Resolve connection, reject unknown
│   │   ├── onData()             # Parse email, process attachments, enqueue
│   │   └── pendingConnections   # Map<sessionId, ResolvedConnection>
│   ├── email-reply-parser.ts    # Strip quoted text, sigs, fwd headers
│   ├── feedback-token.ts        # JWT sign/verify for CSAT
│   └── transports/
│       ├── transport-interface.ts  # EmailTransport interface
│       ├── smtp-transport.ts       # nodemailer-based SMTP send
│       ├── graph-transport.ts      # Microsoft Graph API send
│       └── resolve-transport.ts    # Factory + cache (100 max, 30min TTL)
├── channels/adapters/
│   ├── email-adapter.ts         # ChannelAdapter impl for email
│   │   ├── parseIncoming()      # Pass-through (already normalized)
│   │   ├── sendResponse()       # HTML render, threading, CC/BCC, CSAT
│   │   └── safeMarked           # XSS-safe markdown renderer
│   └── email-attachment-processor.ts  # Upload attachments to multimodal svc
```

### Data Flow

#### Inbound Path

```
1. Customer sends email
   → SMTP Server receives on port 2525

2. onRcptTo(address)
   → resolveChannelConnection('email', address)
   → If no connection: reject 550
   → If found: store in pendingConnections[sessionId]

3. onData(stream)
   → Retrieve connection from pendingConnections
   → simpleParser(stream) → ParsedMail

4. Loop Prevention
   → Check X-ABL-Source header → drop if present
   → Check Auto-Submitted header → drop if != "no"

5. Reply Text Extraction
   → extractReplyText(rawText) → strip quotes, sigs

6. Attachment Processing (non-blocking)
   → processEmailAttachments(attachments, options)
   → Upload each to MultimodalServiceClient (5 concurrent max, 20 MB limit)

7. Session Key Resolution
   → New email: email:{connId}:msg:{messageId}
   → Reply with headers: same format (session resolver uses In-Reply-To)
   → Reply without headers: email:{connId}:{from}:{normalizedSubject}

8. Enqueue to BullMQ
   → channel-inbound queue with idempotency key
   → Job payload: connectionId, tenantId, projectId, agentId, message
```

#### Outbound Path

```
1. Agent generates response text
   → Channel Dispatcher routes to EmailAdapter

2. EmailAdapter.sendResponse()
   → Build CC list (filter self-address)
   → Inject header/footer from connection config
   → Convert markdown → HTML via safeMarked
   → Generate CSAT block if csatEnabled
   → Build Re: subject, In-Reply-To, References

3. resolveEmailTransport(connection)
   → Check config.outbound.transport (smtp | graph)
   → Check cache (key = transport:{connId}:{fingerprint})
   → If miss: create SmtpTransport or GraphTransport

4. transport.sendReply(params)
   → SMTP: nodemailer.sendMail() with X-ABL-Source header
   → Graph: draft-then-send (POST /messages → POST /send)
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                      |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Tenant Isolation**    | Connection resolution in `onRcptTo` maps email address to a specific tenant's connection. `InboundJobPayload` carries `tenantId` from the resolved connection. Sessions scoped by tenant.                                                                                                                                            |
| 2   | **Data Access Pattern** | No direct DB access in email services. Uses `resolveChannelConnection()` for connection lookup, BullMQ for async processing, and existing session/message stores via the inbound worker. Transport cache is in-memory with TTL (30 min) and max size (100).                                                                          |
| 3   | **API Contract**        | Inbound: SMTP protocol (RFC 5321). Outbound: `EmailTransport.sendReply(EmailSendParams)` returns `{ messageId: string }`. CSAT feedback: `GET /api/v1/feedback/:token?rating=N`. Error envelope: `{ success, error: { code, message } }`.                                                                                            |
| 4   | **Security Surface**    | XSS protection via `safeMarked` (no javascript:/vbscript:/data: links, no `<img>` tags). Loop prevention via X-ABL-Source and Auto-Submitted headers. 25 MB inbound limit. 20 MB per-attachment limit. JWT-signed feedback tokens. Graph API client_secret in encrypted credentials store. STARTTLS disabled (TLS at load balancer). |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                |
| --- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | Unknown recipient: SMTP 550. Temporary lookup failure: SMTP 451. Attachment upload failure: non-blocking (text enqueued). Transport send failure: logged, `{ success: false, error }` returned. Missing from/to: email skipped with warning.                                                                   |
| 6   | **Failure Modes** | Graph API 401: clear token, retry once with fresh token. Graph API 429: propagate Retry-After for BullMQ retry scheduling. SMTP relay down: send failure returned to caller. Redis/BullMQ down: email accepted but not enqueued (data loss risk).                                                              |
| 7   | **Idempotency**   | Inbound: BullMQ job ID = `email-{messageId}` (RFC 5322 Message-ID based). Duplicate emails with same Message-ID are deduplicated by BullMQ. Transport cache keyed by connection ID + config fingerprint.                                                                                                       |
| 8   | **Observability** | Six dedicated loggers: `smtp-server`, `email-adapter`, `smtp-transport`, `graph-transport`, `email-transport-resolver`, `email-attachment-processor`. Key events: email received, email enqueued, email sent, loop dropped, attachment uploaded, transport created. BullMQ job metadata carries trace context. |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | Inbound processing: < 2s from SMTP receipt to BullMQ enqueue. Transport cache hit rate: > 90%. Attachment upload: 5 concurrent per email. Graph API token cached with 5-min buffer. Max email size: 25 MB. Max attachment size: 20 MB per file.                                                                                                                                   |
| 10  | **Migration Path**     | No data migration required. Email channel integrates with existing channel_connections, sessions, and messages collections. Legacy `EmailSender` class deprecated but still present -- transport layer replaces it. No schema changes needed.                                                                                                                                     |
| 11  | **Rollback Plan**      | Email channel is opt-in per project (requires channel connection configuration). Disable by removing email connections. SMTP server can be disabled by not setting `SMTP_PORT`. No data to rollback -- email sessions use existing session model.                                                                                                                                 |
| 12  | **Test Strategy**      | Unit tests for each component (transport, reply parser, feedback token, attachment processor). Integration tests for transport resolution, HTML rendering, Graph API token lifecycle. E2E tests for full inbound-outbound flow, threading, cross-tenant isolation, CC/BCC, attachments. Currently 13 test files, all passing. Gap: E2E uses `vi.mock()` -- planned real SMTP E2E. |

---

## 5. Data Model

### New Collections/Tables

No new MongoDB collections introduced. The email channel reuses existing collections.

### Modified Collections/Tables

No schema modifications required. Email-specific data is stored in existing fields:

- **`channel_connections`**: Email config stored in `config` field (outbound transport, Graph credentials, header/footer, CSAT). Graph client_secret stored in `credentials` field.
- **`sessions`**: Email sessions use `externalSessionKey` field for threading. No new fields.
- **`messages`**: Email metadata stored in `metadata` field of `NormalizedIncomingMessage` (from, to, subject, messageId, inReplyTo, references, cc, bcc, emailAttachmentIds).

### Key Relationships

```
channel_connections (email type)
  ├── 1:N sessions (via externalSessionKey resolution)
  │     └── 1:N messages (standard conversation model)
  └── config.outbound → transport selection (smtp | graph)
       └── credentials.graph_client_secret → Graph API OAuth2
```

---

## 6. API Design

### New Endpoints

| Method | Path                      | Purpose                                     | Auth              |
| ------ | ------------------------- | ------------------------------------------- | ----------------- |
| GET    | `/api/v1/feedback/:token` | Record CSAT rating from email feedback link | JWT token in path |

### SMTP Protocol (Non-HTTP)

| SMTP Command | Handler    | Behavior                                           |
| ------------ | ---------- | -------------------------------------------------- |
| RCPT TO      | `onRcptTo` | Resolve connection, reject unknown (550)           |
| DATA         | `onData`   | Parse, extract reply, process attachments, enqueue |
| MAIL FROM    | (default)  | Accept any sender                                  |

### Modified Endpoints

None. Channel connection CRUD uses existing Studio channel API.

### Error Responses

| Scenario                  | Response                                                     |
| ------------------------- | ------------------------------------------------------------ |
| Unknown RCPT TO address   | SMTP 550 "No such recipient"                                 |
| Temporary lookup failure  | SMTP 451 "Temporary lookup failure"                          |
| Email send failure        | `{ success: false, error: "Failed to send email response" }` |
| Invalid feedback token    | HTTP 400/401                                                 |
| Missing Graph credentials | Throw "Graph transport requires..."                          |

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: Not currently implemented for email-specific events. Standard structured logging via `createLogger`. Future: emit audit events for email sent/received.
- **Rate Limiting**: No email-specific rate limiting. SMTP server accepts all connections. Future: connection-level rate limiting to prevent abuse.
- **Caching**: Transport instances cached per connection + config fingerprint (30-min TTL, max 100, LRU eviction). Graph API OAuth2 tokens cached with 5-min expiry buffer, concurrent requests deduplicated.
- **Encryption**: Graph API client_secret stored in connection credentials (intended for encrypted credentials store). Email content not encrypted at rest beyond standard MongoDB encryption. STARTTLS disabled on embedded SMTP (TLS at load balancer).

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                  | Type     | Risk                                                  |
| --------------------------- | -------- | ----------------------------------------------------- |
| `smtp-server` npm package   | External | Low -- stable, well-maintained                        |
| `mailparser` npm package    | External | Low -- standard email parsing                         |
| `nodemailer` npm package    | External | Low -- de facto Node.js email sending                 |
| `email-reply-parser` npm    | External | Medium -- limited to known reply formats              |
| `marked` npm package        | External | Low -- standard markdown parser                       |
| `jsonwebtoken` npm package  | External | Low -- standard JWT library                           |
| Channel connection resolver | Internal | Low -- established pattern across all channels        |
| BullMQ inbound queue        | Internal | Low -- core infrastructure, used by all channels      |
| Multimodal service          | Internal | Medium -- attachment upload depends on service health |
| Microsoft Graph API         | External | Medium -- Azure AD OAuth2, rate limits, outages       |

### Downstream (depends on this feature)

| Consumer         | Impact                                           |
| ---------------- | ------------------------------------------------ |
| Inbound worker   | Processes email jobs from BullMQ channel-inbound |
| Session resolver | Resolves email sessions via externalSessionKey   |
| CSAT analytics   | Consumes feedback ratings from feedback endpoint |

---

## 9. Open Questions & Decisions Needed

1. **SPF/DKIM/DMARC**: Should inbound email verification be added? Risk of spoofed sender addresses creating sessions under false identity.
2. **Bounce handling**: Should DSN/bounce handling be implemented for outbound delivery monitoring?
3. **STARTTLS**: Should the embedded SMTP server support STARTTLS for direct-to-internet deployments?
4. **pendingConnections Map**: Should max size and TTL be added to prevent unbounded growth under connection storms?
5. **Legacy EmailSender**: Should the deprecated class be fully removed now that the transport layer is complete?
6. **Multi-instance SMTP**: How should inbound SMTP be distributed across multiple runtime pods? (Currently single-instance)
7. **Email-specific rate limiting**: Should per-connection or per-sender rate limits be added to prevent abuse?

---

## 10. References

- Feature spec: `docs/features/email-channel.md`
- Test spec: `docs/testing/email-channel.md`
- Graph API design doc: `docs/plans/2026-03-09-email-graph-api-design.md`
- Graph API impl plan: `docs/plans/2026-03-09-email-graph-api-impl.md`
- Channel infrastructure: `docs/features/channels.md`
- RFC 5321 (SMTP): https://www.rfc-editor.org/rfc/rfc5321
- RFC 5322 (Internet Message Format): https://www.rfc-editor.org/rfc/rfc5322

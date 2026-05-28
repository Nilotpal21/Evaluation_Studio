# Email Channel / SMTP — Low-Level Design

## Task T-1: Embedded SMTP Server

### Files

- `apps/runtime/src/services/email/smtp-server.ts` — SMTP server with `smtp-server` package

### Key Functions

- `startSmtpServer()` — Start SMTP on configurable port (default 2525, env `SMTP_PORT`)
- `stopSmtpServer()` — Graceful shutdown
- `handleIncomingEmail(stream, connection)` — Parse email, extract reply, process attachments, enqueue

### Design Notes

- `authOptional: true` — No SMTP authentication (inbound MX server)
- `disabledCommands: ['STARTTLS']` — TLS not required (intended for internal/MX use)
- `size: 25 * 1024 * 1024` — 25 MB max email size
- `pendingConnections` Map keyed by SMTP session ID stores resolved connections between onRcptTo and onData
- Connection resolution happens in `onRcptTo` to reject unknown recipients before body transmission
- `onClose` cleans up pending connections

### Session Key Strategy

- New email (no Re: prefix, no In-Reply-To): `email:{connId}:msg:{messageId}` (unique per message)
- Reply with threading headers: same format (session resolver finds existing via In-Reply-To lookup)
- Reply with Re: prefix but no threading headers: `email:{connId}:{from}:{normalizedSubject}` (fallback)

### Loop Prevention

- `X-ABL-Source` header: drops self-sent emails
- `Auto-Submitted` header: drops auto-replies (value != "no")

---

## Task T-2: Reply Text Extraction

### Files

- `apps/runtime/src/services/email/email-reply-parser.ts` — Wrapper around `email-reply-parser` package

### Function

- `extractReplyText(text)` — Extract visible reply, strip quoted text/signatures/forwarded headers
- Falls back to original text if parser yields empty result or throws

---

## Task T-3: Transport Interface

### Files

- `apps/runtime/src/services/email/transports/transport-interface.ts` — Interface definition

### Interface

```typescript
interface EmailTransport {
  sendReply(params: EmailSendParams): Promise<{ messageId: string }>;
  checkHealth?(): Promise<{ healthy: boolean; latencyMs: number }>;
}
```

---

## Task T-4: SMTP Transport

### Files

- `apps/runtime/src/services/email/transports/smtp-transport.ts` — nodemailer-based transport

### Key Design Notes

- Creates `nodemailer.createTransport` with host/port/auth from config
- Port 465 uses `secure: true`
- Adds `X-ABL-Source: agent-platform` header to prevent loops
- Health check via `transporter.verify()`

---

## Task T-5: Graph API Transport

### Files

- `apps/runtime/src/services/email/transports/graph-transport.ts` — Microsoft Graph API transport

### Key Design Notes

- Uses draft-then-send flow: `POST /users/{sender}/messages` → `POST .../send`
- Draft creation returns `internetMessageId` for threading
- Token cached with 5-min expiry buffer, concurrent requests deduplicated
- 401: clears token, retries once with fresh token
- 429: throws with `retryAfterMs` for BullMQ retry
- Threading via `internetMessageHeaders` array (In-Reply-To, References)
- Config: `{ tenantId, clientId, clientSecret, senderAddress }`

---

## Task T-6: Transport Resolution

### Files

- `apps/runtime/src/services/email/transports/resolve-transport.ts` — Factory + cache

### Key Design Notes

- Reads `connection.config.outbound.transport` (default: `smtp`)
- Graph transport requires `graph_client_secret` in connection credentials
- Cache key includes config fingerprint (SHA-256 of tenantId:clientId:sender:secret)
- Cache: max 100 entries, 30-min TTL, LRU eviction

---

## Task T-7: Feedback Token

### Files

- `apps/runtime/src/services/email/feedback-token.ts` — JWT-based CSAT feedback tokens

### Functions

- `signFeedbackToken(payload)` — Signs JWT with `{ tenantId, projectId, sessionId, messageId, connectionId }`
- `verifyFeedbackToken(token)` — Verifies and extracts payload
- TTL: 30 days
- Requires `JWT_SECRET` environment variable

---

## Known Gaps

| Gap                                             | Severity | Notes                                                              |
| ----------------------------------------------- | -------- | ------------------------------------------------------------------ |
| pendingConnections Map has no max size / TTL    | Low      | Could grow unbounded under SMTP connection storms                  |
| STARTTLS disabled                               | Low      | OK for internal/MX use; production should use TLS at load balancer |
| EmailSender class deprecated but still imported | Low      | Should complete migration to transport layer                       |
| No SPF/DKIM/DMARC verification                  | Medium   | Inbound emails not verified for sender authenticity                |

## Exit Criteria

- Inbound emails parsed and enqueued correctly (verified by E2E test)
- Email threading works with both In-Reply-To and subject-based fallback
- CC/BCC handled correctly (CC forwarded, BCC suppressed, self filtered)
- HTML rendering sanitizes XSS vectors
- Loop prevention blocks self-sent and auto-reply emails
- Graph transport handles 401 retry and 429 back-pressure

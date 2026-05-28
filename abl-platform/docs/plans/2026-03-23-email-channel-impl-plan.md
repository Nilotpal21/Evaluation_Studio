# LLD: Email Channel / SMTP

**Feature Spec**: `docs/features/email-channel.md`
**HLD**: `docs/specs/email-channel.hld.md`
**Test Spec**: `docs/testing/email-channel.md`
**Status**: DONE
**Date**: 2026-03-23

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                        | Rationale                                                                                            | Alternatives Rejected                            |
| --- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| D-1 | Embedded SMTP via `smtp-server` package         | Zero infrastructure for dev/test; matches adapter pattern; direct BullMQ access                      | External MTA (Postfix), third-party API (SES)    |
| D-2 | Pluggable transport interface                   | Decouples outbound from inbound; supports SMTP + Graph + future transports                           | Single SMTP-only sender                          |
| D-3 | Graph API draft-then-send flow                  | Required to retrieve `internetMessageId` for RFC 5322 threading                                      | Single-step send (no threading headers returned) |
| D-4 | Three-tier session threading                    | Handles well-behaved clients (In-Reply-To), header-stripping clients (subject fallback), new emails  | Single strategy (Message-ID only)                |
| D-5 | Non-blocking attachment processing              | Text message always enqueued even if attachment upload fails                                         | Blocking (all-or-nothing)                        |
| D-6 | Transport cache with config fingerprint         | Reuses Graph API token cache while invalidating on credential rotation                               | No cache, per-request transport creation         |
| D-7 | `safeMarked` custom renderer for XSS protection | Neutralizes javascript:/vbscript:/data: URIs, prevents tracking pixels via img->text link conversion | Generic DOMPurify sanitization                   |
| D-8 | JWT-based CSAT feedback tokens (30-day TTL)     | No auth required for feedback endpoint; tokens are self-contained and verifiable                     | Session-based auth for feedback                  |

### Key Interfaces & Types

```typescript
// Transport interface (transport-interface.ts)
interface EmailTransport {
  sendReply(params: EmailSendParams): Promise<{ messageId: string }>;
  checkHealth?(): Promise<{ healthy: boolean; latencyMs: number }>;
}

interface EmailSendParams {
  to: string;
  from: string;
  subject: string;
  text: string;
  html?: string;
  cc?: string[];
  bcc?: string[];
  inReplyTo?: string;
  references?: string;
  headers?: Record<string, string>;
}

// Feedback token payload (feedback-token.ts)
interface FeedbackTokenPayload {
  tenantId: string;
  projectId: string;
  sessionId: string;
  messageId: string;
  connectionId: string;
}

// Attachment ref (email-attachment-processor.ts)
interface EmailAttachmentRef {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  content: Buffer;
}
```

### Module Boundaries

| Module                     | Responsibility                           | Depends On                                                      |
| -------------------------- | ---------------------------------------- | --------------------------------------------------------------- |
| smtp-server                | Inbound SMTP reception, parse, enqueue   | connection-resolver, BullMQ, reply-parser, attachment-processor |
| email-reply-parser         | Extract latest reply text                | email-reply-parser (npm)                                        |
| transport-interface        | Transport contract definition            | (none)                                                          |
| smtp-transport             | SMTP outbound via nodemailer             | transport-interface, nodemailer                                 |
| graph-transport            | Graph API outbound via OAuth2            | transport-interface, Azure AD                                   |
| resolve-transport          | Transport factory + cache                | smtp-transport, graph-transport                                 |
| email-adapter              | ChannelAdapter for email                 | resolve-transport, feedback-token, marked                       |
| email-attachment-processor | Upload attachments to multimodal service | multimodal-service-client                                       |
| feedback-token             | JWT CSAT token sign/verify               | jsonwebtoken                                                    |

---

## 2. File-Level Change Map

### Existing Files (Already Implemented)

| File                                                                | Purpose                    | LOC | Status     |
| ------------------------------------------------------------------- | -------------------------- | --- | ---------- |
| `apps/runtime/src/services/email/smtp-server.ts`                    | SMTP inbound reception     | 322 | Done       |
| `apps/runtime/src/services/email/email-reply-parser.ts`             | Reply text extraction      | 30  | Done       |
| `apps/runtime/src/services/email/feedback-token.ts`                 | CSAT JWT tokens            | 49  | Done       |
| `apps/runtime/src/services/email/transports/transport-interface.ts` | Transport interface        | 24  | Done       |
| `apps/runtime/src/services/email/transports/smtp-transport.ts`      | SMTP outbound              | 67  | Done       |
| `apps/runtime/src/services/email/transports/graph-transport.ts`     | Graph API outbound         | 211 | Done       |
| `apps/runtime/src/services/email/transports/resolve-transport.ts`   | Transport factory + cache  | 108 | Done       |
| `apps/runtime/src/channels/adapters/email-adapter.ts`               | Channel adapter            | 223 | Done       |
| `apps/runtime/src/channels/adapters/email-attachment-processor.ts`  | Attachment upload          | 112 | Done       |
| `apps/runtime/src/services/email/email-sender.ts`                   | Legacy sender (deprecated) | ~80 | Deprecated |

### Files Needing Modification (Hardening Phase)

| File                                                   | Change Description                                              | Risk   |
| ------------------------------------------------------ | --------------------------------------------------------------- | ------ |
| `apps/runtime/src/services/email/smtp-server.ts`       | Add max size + TTL to `pendingConnections` Map (GAP-004)        | Low    |
| `apps/runtime/src/__tests__/email-channel-e2e.test.ts` | Refactor to remove `vi.mock()` -- use real transports (GAP-006) | Medium |

### New Files (Hardening Phase)

| File                                                              | Purpose                       | LOC Estimate |
| ----------------------------------------------------------------- | ----------------------------- | ------------ |
| `apps/runtime/src/__tests__/email/email-channel-real-e2e.test.ts` | Real SMTP E2E test (no mocks) | ~200         |
| `apps/runtime/src/__tests__/email/email-isolation-e2e.test.ts`    | Cross-tenant isolation test   | ~150         |

### Deleted Files

| File                                              | Reason                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/email/email-sender.ts` | Deprecated; replaced by transport layer. Deferred to avoid breaking existing imports. |

---

## 3. Implementation Phases

### Phase 1: Core Infrastructure (DONE)

**Goal**: Establish the inbound SMTP server and email parsing pipeline.

**Tasks**:
1.1. Implement `startSmtpServer()` and `stopSmtpServer()` in `smtp-server.ts`
1.2. Implement `onRcptTo` with `resolveChannelConnection('email', address)` and 550 rejection
1.3. Implement `onData` with `simpleParser`, reply text extraction, and BullMQ enqueue
1.4. Implement loop prevention (X-ABL-Source and Auto-Submitted header checks)
1.5. Implement `normalizeSubject()`, `extractAddress()`, `extractAddresses()` helpers
1.6. Implement three-tier session key strategy (Message-ID, In-Reply-To, subject fallback)

**Files Touched**:

- `apps/runtime/src/services/email/smtp-server.ts` -- created
- `apps/runtime/src/services/email/email-reply-parser.ts` -- created

**Exit Criteria**:

- [x] SMTP server starts on configurable port and accepts connections
- [x] Unknown RCPT TO addresses rejected with 550
- [x] Parsed emails enqueued to BullMQ with correct metadata
- [x] Loop prevention drops X-ABL-Source and Auto-Submitted emails
- [x] Reply text extracted correctly from quoted email formats
- [x] `pnpm build --filter=runtime` succeeds with 0 errors
- [x] Unit tests for SMTP server pass: `email-smtp-server.test.ts`
- [x] Unit tests for reply parser pass: `email-reply-parser.test.ts`

**Test Strategy**:

- Unit: SMTP server lifecycle, email parsing, loop prevention, subject normalization
- Unit: Reply parser extraction, fallback behavior, null handling

**Rollback**: Remove SMTP server import from runtime startup; email channel simply not available.

---

### Phase 2: Transport Layer (DONE)

**Goal**: Implement pluggable outbound transport with SMTP and Graph API support.

**Tasks**:
2.1. Define `EmailTransport` interface and `EmailSendParams` in `transport-interface.ts`
2.2. Implement `SmtpTransport` in `smtp-transport.ts` (nodemailer, X-ABL-Source header, health check)
2.3. Implement `GraphTransport` in `graph-transport.ts` (OAuth2 client credentials, draft-then-send, token cache, 401 retry, 429 propagation)
2.4. Implement `resolveEmailTransport()` in `resolve-transport.ts` (factory + cache with SHA-256 fingerprint, 30-min TTL, max 100, LRU eviction)

**Files Touched**:

- `apps/runtime/src/services/email/transports/transport-interface.ts` -- created
- `apps/runtime/src/services/email/transports/smtp-transport.ts` -- created
- `apps/runtime/src/services/email/transports/graph-transport.ts` -- created
- `apps/runtime/src/services/email/transports/resolve-transport.ts` -- created

**Exit Criteria**:

- [x] `EmailTransport` interface supports `sendReply` and optional `checkHealth`
- [x] SMTP transport sends via nodemailer with X-ABL-Source header
- [x] Graph transport uses draft-then-send flow, returns `internetMessageId`
- [x] Graph token cached with 5-min buffer, concurrent requests deduplicated
- [x] Graph 401 retries once with fresh token; 429 propagates with Retry-After
- [x] Transport resolver selects SMTP (default) or Graph based on connection config
- [x] Cache respects max 100 entries and 30-min TTL with fingerprint invalidation
- [x] `pnpm build --filter=runtime` succeeds with 0 errors
- [x] All transport unit tests pass: `smtp-transport.test.ts`, `graph-transport.test.ts`, `resolve-transport.test.ts`

**Test Strategy**:

- Unit: SMTP transport send + health check
- Unit: Graph transport send, token lifecycle, 401/429 handling
- Unit: Transport resolution, cache behavior, fingerprint invalidation

**Rollback**: Revert transport files; email adapter falls back to legacy EmailSender.

---

### Phase 3: Email Adapter + HTML Rendering (DONE)

**Goal**: Implement the channel adapter for email with HTML rendering, CC/BCC, CSAT.

**Tasks**:
3.1. Implement `EmailAdapter` class implementing `ChannelAdapter` interface
3.2. Implement `sendResponse()` with transport resolution, threading headers (In-Reply-To, References, Re: prefix)
3.3. Implement `safeMarked` renderer: escape raw HTML, neutralize javascript:/vbscript:/data: URIs, convert `<img>` to text links
3.4. Implement CC forwarding with self-address filtering and BCC suppression
3.5. Implement header/footer template injection from `connection.config`
3.6. Implement CSAT block generation: `buildCsatBlock()` with 5-point rating scale links
3.7. Implement `signFeedbackToken()` and `verifyFeedbackToken()` in `feedback-token.ts`

**Files Touched**:

- `apps/runtime/src/channels/adapters/email-adapter.ts` -- created
- `apps/runtime/src/services/email/feedback-token.ts` -- created

**Exit Criteria**:

- [x] EmailAdapter registered in channel registry as 'email'
- [x] Outbound emails include correct threading headers
- [x] HTML rendering neutralizes XSS vectors (javascript:, vbscript:, data:, <img>)
- [x] CC forwarded minus self-address; BCC suppressed on replies
- [x] Header/footer templates injected from connection config
- [x] CSAT block rendered when `csatEnabled = true` with valid JWT token
- [x] Feedback tokens sign/verify round-trip correctly
- [x] `pnpm build --filter=runtime` succeeds with 0 errors
- [x] E2E test passes: `email-channel-e2e.test.ts`
- [x] Unit tests pass: `email-adapter.test.ts`, `feedback-token.test.ts`, `feedback-endpoint.test.ts`

**Test Strategy**:

- E2E (mock-based): Full inbound-outbound flow, threading, CC/BCC, HTML, header/footer, CSAT, errors
- Unit: Adapter normalization, feedback JWT sign/verify
- Integration: Adapter + transport integration (`email-adapter-transport.test.ts`)

**Rollback**: Unregister email adapter from channel registry; emails accepted by SMTP but not delivered.

---

### Phase 4: Attachment Processing (DONE)

**Goal**: Implement email attachment upload to multimodal service.

**Tasks**:
4.1. Implement `processEmailAttachments()` in `email-attachment-processor.ts`
4.2. Add 20 MB per-attachment size limit check
4.3. Add 5-concurrent upload batching
4.4. Add non-blocking failure handling (log + skip failed attachments)
4.5. Wire attachment processor into `handleIncomingEmail()` in `smtp-server.ts`

**Files Touched**:

- `apps/runtime/src/channels/adapters/email-attachment-processor.ts` -- created
- `apps/runtime/src/services/email/smtp-server.ts` -- modified (attachment integration)

**Exit Criteria**:

- [x] Attachments uploaded to multimodal service with correct metadata
- [x] Attachments over 20 MB skipped with warning log
- [x] Concurrent uploads limited to 5 per email
- [x] Individual attachment failure does not block text message enqueue
- [x] Attachment IDs included in `emailAttachmentIds` metadata
- [x] `pnpm build --filter=runtime` succeeds with 0 errors
- [x] Unit test passes: `email-attachment-processor.test.ts`

**Test Strategy**:

- Unit: Attachment upload, size limit, concurrency batching, failure handling, empty input

**Rollback**: Remove attachment processing call from smtp-server.ts; emails enqueued without attachments.

---

### Phase 5: Hardening -- pendingConnections Map Safety (PLANNED)

**Goal**: Add max size and TTL to the `pendingConnections` Map to prevent unbounded growth (GAP-004).

**Tasks**:
5.1. Add `MAX_PENDING_CONNECTIONS = 1000` constant
5.2. Add `PENDING_CONNECTION_TTL_MS = 60_000` (1 minute) constant
5.3. Track `createdAt` timestamp in pending connection entries
5.4. Evict expired entries before adding new ones in `onRcptTo`
5.5. Reject with SMTP 451 if Map is at capacity after eviction

**Files Touched**:

- `apps/runtime/src/services/email/smtp-server.ts` -- modify `pendingConnections` to include TTL/max size

**Exit Criteria**:

- [ ] `pendingConnections` Map never exceeds 1000 entries
- [ ] Entries older than 60 seconds are evicted
- [ ] SMTP 451 returned when Map is at capacity
- [ ] Existing SMTP server tests still pass
- [ ] New unit test verifies eviction and capacity limit
- [ ] `pnpm build --filter=runtime` succeeds with 0 errors

**Test Strategy**:

- Unit: Map capacity limit, TTL eviction, 451 response on capacity

**Rollback**: Revert to unbounded Map (existing behavior).

---

### Phase 6: Hardening -- Real SMTP E2E Test (PLANNED)

**Goal**: Replace mock-based E2E with a real SMTP server E2E test that starts an actual SMTP server and sends real emails (GAP-006).

**Tasks**:
6.1. Create `email-channel-real-e2e.test.ts` that starts real SMTP server on random port
6.2. Use `nodemailer` as SMTP test client to send inbound emails
6.3. Test full flow: SMTP send -> parse -> BullMQ enqueue -> session creation
6.4. Test session threading via In-Reply-To headers
6.5. Test loop prevention with real X-ABL-Source and Auto-Submitted headers
6.6. Test CC/BCC routing through the full pipeline

**Files Touched**:

- `apps/runtime/src/__tests__/email/email-channel-real-e2e.test.ts` -- new

**Exit Criteria**:

- [ ] Real SMTP server started on random port in test setup
- [ ] nodemailer sends test emails to real SMTP server
- [ ] Inbound emails parsed and enqueued to BullMQ (verified via job completion)
- [ ] Session threading verified via session lookup API
- [ ] Loop prevention verified (self-sent emails dropped)
- [ ] CC/BCC routing verified in outbound parameters
- [ ] No `vi.mock()` used in this test file
- [ ] `pnpm test --filter=runtime -- email-channel-real-e2e` passes

**Test Strategy**:

- E2E: Real SMTP server, real email parsing, real BullMQ, mock only external services (multimodal)

**Rollback**: Delete test file; existing mock-based E2E remains as backup.

---

### Phase 7: Hardening -- Cross-Tenant Isolation E2E (PLANNED)

**Goal**: Add E2E test verifying cross-tenant email isolation (test spec E2E-3).

**Tasks**:
7.1. Create `email-isolation-e2e.test.ts` with two tenant configurations
7.2. Seed two channel connections (Tenant-A with `agentA@corp-a.com`, Tenant-B with `agentB@corp-b.com`)
7.3. Send email to Tenant-A, verify `tenantId = tenant-a` in session
7.4. Send email to Tenant-B, verify `tenantId = tenant-b` in session
7.5. Send cross-tenant email (In-Reply-To referencing Tenant-B from Tenant-A address), verify new session

**Files Touched**:

- `apps/runtime/src/__tests__/email/email-isolation-e2e.test.ts` -- new

**Exit Criteria**:

- [ ] Two tenant email connections configured in test setup
- [ ] Emails for Tenant-A resolve to Tenant-A context
- [ ] Emails for Tenant-B resolve to Tenant-B context
- [ ] Cross-tenant message-id reference does not leak across boundaries
- [ ] No `vi.mock()` used
- [ ] `pnpm test --filter=runtime -- email-isolation-e2e` passes

**Test Strategy**:

- E2E: Multi-tenant setup, real connection resolution, real session isolation

**Rollback**: Delete test file.

---

## 4. Wiring Checklist

- [x] SMTP server registered in runtime startup (calls `startSmtpServer()`)
- [x] Email adapter registered in channel registry (`registry.set('email', new EmailAdapter())`)
- [x] Transport resolver imported by email adapter (`resolveEmailTransport`)
- [x] Feedback token imported by email adapter (`signFeedbackToken`)
- [x] Attachment processor imported by SMTP server (`processEmailAttachments`)
- [x] Reply parser imported by SMTP server (`extractReplyText`)
- [x] Feedback endpoint registered in routes (`/api/v1/feedback/:token`)
- [x] BullMQ inbound queue accessed via `getInboundQueue()`
- [x] Connection resolver used in SMTP server (`resolveChannelConnection`)
- [ ] New env vars documented in `.env.example` (SMTP_PORT, JWT_SECRET, etc.) -- verify
- [ ] Dockerfile exposes SMTP port if needed

---

## 5. Cross-Phase Concerns

### Database Migrations

No database migrations required. Email channel uses existing `channel_connections`, `sessions`, and `messages` collections without schema changes. Email-specific data stored in existing schemaless `config`, `credentials`, and `metadata` fields.

### Feature Flags

Not applicable. Email channel is activated by creating a channel connection with `channelType: 'email'` and deactivated by removing it. No global feature flag needed.

### Configuration Changes

| Variable                  | Default                 | Required       | Phase |
| ------------------------- | ----------------------- | -------------- | ----- |
| `SMTP_PORT`               | `2525`                  | No             | 1     |
| `JWT_SECRET`              | (none)                  | Yes (for CSAT) | 3     |
| `SMTP_RELAY_HOST`         | `localhost`             | No             | 2     |
| `SMTP_RELAY_PORT`         | `587`                   | No             | 2     |
| `SMTP_RELAY_USER`         | (empty)                 | No             | 2     |
| `SMTP_RELAY_PASS`         | (empty)                 | No             | 2     |
| `RUNTIME_PUBLIC_BASE_URL` | `http://localhost:3112` | No (for CSAT)  | 3     |

---

## 6. Acceptance Criteria (Whole Feature)

- [x] Phases 1-4 complete with all exit criteria met (core feature)
- [ ] Phase 5 complete: pendingConnections Map hardened with max size/TTL
- [ ] Phase 6 complete: Real SMTP E2E test passing (no vi.mock)
- [ ] Phase 7 complete: Cross-tenant isolation E2E test passing
- [x] Existing unit tests pass (13 test files, all passing)
- [x] `pnpm build --filter=runtime` succeeds
- [ ] E2E tests from test spec (E2E-1 through E2E-7) all passing
- [ ] Integration tests from test spec (INT-1 through INT-7) all passing
- [ ] Feature spec updated with implementation details
- [ ] Testing matrix updated with actual coverage
- [ ] No regressions in existing runtime tests (`pnpm test --filter=runtime`)

---

## 7. Open Questions

1. Should Phase 5 (pendingConnections hardening) be a priority given the low traffic volume for email? Or defer until production load data is available?
2. Should Phase 6 (real SMTP E2E) require MongoMemoryServer for session storage, or can it verify at the BullMQ enqueue level?
3. Should the deprecated `EmailSender` class be removed in a separate cleanup phase, or left until all test file imports are migrated?
4. Should Graph API E2E tests be gated behind `GRAPH_API_E2E=true` since they require Azure AD credentials not available in standard CI?
5. What is the priority ordering between Phase 6 (real E2E) and Phase 7 (isolation E2E)?

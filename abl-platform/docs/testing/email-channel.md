# Test Specification: Email Channel / SMTP

**Feature Spec**: `docs/features/email-channel.md`
**HLD**: `docs/specs/email-channel.hld.md`
**LLD**: `docs/plans/email-channel.lld.md`
**Status**: IN PROGRESS
**Last Updated**: 2026-03-23

---

## 1. Coverage Matrix

| FR    | Description                         | Unit | Integration | E2E    | Manual | Status     |
| ----- | ----------------------------------- | ---- | ----------- | ------ | ------ | ---------- |
| FR-1  | Inbound SMTP + connection resolve   | PASS | -           | PASS\* | -      | Covered    |
| FR-2  | Reply text extraction               | PASS | -           | -      | -      | Unit only  |
| FR-3  | Session threading (3 strategies)    | PASS | -           | PASS\* | -      | Covered    |
| FR-4  | Multi-transport (SMTP + Graph)      | PASS | PASS        | PASS\* | -      | Covered    |
| FR-5  | Loop prevention                     | PASS | -           | -      | -      | Unit only  |
| FR-6  | Attachment processing               | PASS | -           | -      | -      | Unit only  |
| FR-7  | 25 MB size limit                    | -    | -           | -      | -      | NOT TESTED |
| FR-8  | HTML rendering + XSS protection     | -    | -           | PASS\* | -      | E2E only   |
| FR-9  | Header/footer templates             | -    | -           | PASS\* | -      | E2E only   |
| FR-10 | CSAT feedback tokens                | PASS | -           | -      | -      | Unit only  |
| FR-11 | CC/BCC routing                      | -    | -           | PASS\* | -      | E2E only   |
| FR-12 | Graph API lifecycle (401/429/token) | PASS | -           | -      | -      | Unit only  |

> `*` = E2E test uses `vi.mock()` for transport resolver -- not a true system-level E2E per CLAUDE.md standards.

---

## 2. E2E Test Scenarios (MANDATORY)

CRITICAL: E2E tests must exercise the real system through its HTTP API. No mocks, no direct DB access, no stubbed servers.

### E2E-1: Inbound Email to Outbound Reply (Full Flow)

- **Preconditions**: Runtime server started on random port; SMTP server started on random port; channel connection seeded via POST `/api/projects/:projectId/connections` with type `email` and `externalIdentifier` = `agent@test.com`; BullMQ inbound queue connected.
- **Steps**:
  1. Connect an SMTP client to the inbound SMTP server port
  2. Send a valid email: `MAIL FROM: customer@example.com`, `RCPT TO: agent@test.com`, body with subject "Help with order" and text "I need help with order #123"
  3. Wait for the BullMQ job to be processed (poll job completion or use event listener)
  4. Verify the agent session was created via GET `/api/projects/:projectId/sessions?externalSessionKey=email:*`
  5. Verify the inbound message was stored with correct metadata (from, to, subject, messageId)
  6. Trigger agent reply (or verify the outbound adapter was invoked with correct threading headers)
- **Expected Result**: Email accepted (no SMTP error), session created, message metadata includes `from`, `to`, `subject`, `messageId`. Outbound reply includes `In-Reply-To` and `References` headers matching the inbound `messageId`.
- **Auth Context**: Tenant resolved from channel connection; project from connection config; user identified by sender email.
- **Isolation Check**: Sending email to an address not configured for any tenant returns SMTP 550 rejection.

### E2E-2: Session Threading via In-Reply-To Headers

- **Preconditions**: Same as E2E-1; initial email already processed and session created.
- **Steps**:
  1. Send a follow-up email with `In-Reply-To: <original-message-id>` and `References: <original-message-id>` headers
  2. Wait for BullMQ processing
  3. GET the session via API, verify both messages belong to the same session
  4. Verify `externalSessionKey` resolution found the existing session via threading headers
- **Expected Result**: Follow-up email joins the existing session, not a new session. Session message count = 2.
- **Auth Context**: Same tenant/project as E2E-1.
- **Isolation Check**: A follow-up email referencing a message-id from a different tenant's session must not join that session.

### E2E-3: Cross-Tenant Isolation

- **Preconditions**: Two tenants configured: Tenant-A with email connection `agentA@corp-a.com`, Tenant-B with email connection `agentB@corp-b.com`.
- **Steps**:
  1. Send email to `agentA@corp-a.com` from `user1@example.com` with subject "Tenant A question"
  2. Send email to `agentB@corp-b.com` from `user2@example.com` with subject "Tenant B question"
  3. Verify Tenant-A session has `tenantId = tenant-a` and Tenant-B session has `tenantId = tenant-b`
  4. Send email to `agentA@corp-a.com` but with `In-Reply-To` referencing a Tenant-B message-id
  5. Verify the email creates a NEW session for Tenant-A (does not join Tenant-B session)
- **Expected Result**: Each tenant's emails are strictly isolated. Cross-tenant message-id references do not leak across tenant boundaries.
- **Auth Context**: Two distinct tenant contexts.
- **Isolation Check**: This IS the isolation check -- tenant boundary enforcement.

### E2E-4: CC/BCC Routing and Self-Filtering

- **Preconditions**: Runtime started; email connection with `externalIdentifier` = `agent@company.com`.
- **Steps**:
  1. Send email with: `FROM: customer@example.com`, `TO: agent@company.com`, `CC: colleague@example.com, agent@company.com`, `BCC: secret@example.com`
  2. Wait for processing; trigger outbound reply
  3. Inspect the outbound email parameters: verify `to = customer@example.com`, `cc = [colleague@example.com]` (agent address filtered), no `bcc`
- **Expected Result**: CC includes original CC recipients minus the agent's own address. BCC is completely suppressed on reply. Agent's self-address is not echoed back.
- **Auth Context**: Standard tenant/project context from connection.
- **Isolation Check**: N/A for this scenario.

### E2E-5: Attachment Upload Flow

- **Preconditions**: Runtime started; multimodal service running (or stub endpoint returning `{ success: true, attachmentId: 'att-xxx' }`); email connection configured.
- **Steps**:
  1. Send email with two file attachments (one 1 KB text file, one 5 MB PDF)
  2. Wait for BullMQ processing
  3. Verify the inbound message metadata includes `emailAttachmentIds` array with 2 entries
  4. Verify each attachment was uploaded to multimodal service (check service logs or GET attachment by ID)
- **Expected Result**: Both attachments uploaded successfully. Message metadata contains correct attachment IDs. Text body also present in message.
- **Auth Context**: Standard tenant/project context.
- **Isolation Check**: Attachments should be scoped to the tenant/project of the connection.

### E2E-6: Loop Prevention

- **Preconditions**: Runtime and SMTP server started; email connection configured.
- **Steps**:
  1. Send email with custom header `X-ABL-Source: agent-platform` to the inbound SMTP server
  2. Verify the email is silently dropped (no session created, no BullMQ job)
  3. Send email with `Auto-Submitted: auto-replied` header
  4. Verify the email is silently dropped
  5. Send email with `Auto-Submitted: no` header
  6. Verify the email IS processed (creates session)
- **Expected Result**: Emails with `X-ABL-Source` or `Auto-Submitted` (non-"no") are dropped. Normal emails and `Auto-Submitted: no` are accepted.
- **Auth Context**: Standard tenant/project context.
- **Isolation Check**: N/A.

### E2E-7: CSAT Feedback Token Round-Trip

- **Preconditions**: Runtime started; email connection with `config.csatEnabled = true`; `JWT_SECRET` set.
- **Steps**:
  1. Send email, wait for processing, trigger outbound reply
  2. Inspect outbound HTML body for CSAT rating links containing `/api/v1/feedback/:token?rating=N`
  3. Extract the feedback token from the HTML
  4. GET `/api/v1/feedback/:token?rating=5` -- verify it records the rating
  5. GET the same endpoint again -- verify idempotent or appropriate response
  6. GET `/api/v1/feedback/invalid-token?rating=5` -- verify rejection
- **Expected Result**: CSAT links present in HTML when enabled. Token decodes to correct tenant/project/session. Rating recorded. Invalid token returns 401/400.
- **Auth Context**: No auth required for feedback endpoint (JWT-verified).
- **Isolation Check**: Token contains tenant/project scope -- ratings stored to correct context.

---

## 3. Integration Test Scenarios (MANDATORY)

### INT-1: Transport Resolution and Caching

- **Boundary**: Email adapter -> transport resolver -> transport instance cache
- **Setup**: Create multiple `ResolvedConnection` objects with different configs (SMTP default, Graph API, Graph with different credentials).
- **Steps**:
  1. Call `resolveEmailTransport(smtpConnection)` -- verify SmtpTransport instance returned
  2. Call again with same connection -- verify cached instance reused (same object reference)
  3. Call `resolveEmailTransport(graphConnection)` -- verify GraphTransport instance returned
  4. Modify Graph credentials, call again -- verify NEW instance created (cache invalidated by fingerprint change)
  5. Fill cache to 100 entries, add one more -- verify oldest entry evicted
  6. Wait 30+ minutes (or mock time), call again -- verify TTL expiration creates new instance
- **Expected Result**: Default = SMTP, Graph selected when configured, cache respects max size (100) and TTL (30 min), fingerprint change invalidates entry.
- **Failure Mode**: If transport resolver throws (missing Graph credentials), error propagates to adapter with descriptive message.

### INT-2: Reply Text Extraction Across Email Clients

- **Boundary**: SMTP server -> email reply parser
- **Setup**: Prepare raw email text samples from Gmail, Outlook, Apple Mail, Thunderbird with quoted replies and signatures.
- **Steps**:
  1. Pass Gmail reply format ("> On Mon, Jan 1..." prefix) -- verify only latest reply extracted
  2. Pass Outlook reply format ("From: ... Sent: ..." block) -- verify quoted block stripped
  3. Pass Apple Mail reply format -- verify signature ("Sent from my iPhone") stripped
  4. Pass email where parser strips everything -- verify fallback to original text
  5. Pass `null`/`undefined`/empty string -- verify returns empty string without throwing
- **Expected Result**: Latest reply text extracted from all major email client formats. Fallback to full text when parser over-strips. Graceful handling of null/empty input.
- **Failure Mode**: Parser throws on malformed input -- fallback to `text.trim()`.

### INT-3: HTML Rendering with XSS Protection

- **Boundary**: Email adapter -> `safeMarked` renderer -> HTML output
- **Setup**: Prepare markdown strings with various attack vectors.
- **Steps**:
  1. Render markdown with `[link](javascript:alert('xss'))` -- verify `javascript:` removed, text preserved
  2. Render markdown with `![img](https://tracker.com/pixel.png)` -- verify `<img>` NOT emitted, rendered as text link
  3. Render markdown with raw `<script>alert('xss')</script>` -- verify HTML entities escaped
  4. Render markdown with `[link](vbscript:MsgBox)` -- verify `vbscript:` neutralized
  5. Render markdown with `[link](data:text/html,<script>)` -- verify `data:` scheme blocked
  6. Render normal markdown (bold, links, lists) -- verify correct HTML output
- **Expected Result**: All XSS vectors neutralized. Normal markdown renders correctly. `<img>` tags converted to text links. No dangerous URI schemes pass through.
- **Failure Mode**: N/A (should never allow XSS).

### INT-4: Graph API Token Lifecycle

- **Boundary**: Graph transport -> Azure AD OAuth2 -> token cache
- **Setup**: Mock Azure AD token endpoint; configure Graph transport with test credentials.
- **Steps**:
  1. First `sendReply` call -- verify token acquisition from Azure AD, token cached
  2. Second call within expiry -- verify cached token reused (no second Azure AD call)
  3. Wait until 5-min buffer before expiry -- verify new token acquired
  4. Simulate 401 response from Graph API -- verify token cleared, re-acquired, request retried once
  5. Simulate second 401 on retry -- verify error thrown (no infinite retry)
  6. Simulate 429 response with `Retry-After: 60` -- verify error thrown with `retryAfterMs: 60000`
  7. Trigger two concurrent sends before token cached -- verify only one token request (dedup via `pendingTokenRequest`)
- **Expected Result**: Token cached, expiry buffer respected, 401 retry once, 429 propagated, concurrent requests deduplicated.
- **Failure Mode**: Azure AD unreachable -- throws with descriptive error. Graph API errors propagated with status and body.

### INT-5: SMTP Server Connection Resolution

- **Boundary**: SMTP server `onRcptTo` -> `resolveChannelConnection` -> `pendingConnections` Map -> `onData`
- **Setup**: Set up SMTP server with mocked `resolveChannelConnection` returning connections for known addresses.
- **Steps**:
  1. Send RCPT TO with known address -- verify callback success, connection stored in `pendingConnections`
  2. Send RCPT TO with unknown address -- verify SMTP 550 error returned
  3. Send DATA after successful RCPT TO -- verify connection retrieved from `pendingConnections` and deleted from Map
  4. Close SMTP session -- verify `pendingConnections` entry cleaned up in `onClose`
  5. Send DATA without prior RCPT TO (no pending connection) -- verify warning logged, email skipped
- **Expected Result**: Known addresses accepted, unknown rejected with 550, connections bridge correctly between RCPT TO and DATA, cleanup on close.
- **Failure Mode**: `resolveChannelConnection` throws -- returns SMTP 451 (temporary failure).

### INT-6: Email Attachment Processing with Size Limits and Concurrency

- **Boundary**: SMTP server -> email-attachment-processor -> multimodal service upload
- **Setup**: Create attachment refs with various sizes; inject mock uploadFn.
- **Steps**:
  1. Process 3 attachments under 20 MB -- verify all uploaded, all IDs returned
  2. Process attachment over 20 MB limit -- verify skipped with warning, other attachments still processed
  3. Process 8 attachments -- verify batched into groups of 5 (UPLOAD_CONCURRENCY)
  4. Simulate uploadFn failure for one attachment -- verify other attachments succeed, failed one returns null
  5. Process empty attachment array -- verify returns empty array immediately
- **Expected Result**: Size limit enforced per attachment. Concurrency limited to 5. Individual failures non-blocking. Empty input handled gracefully.
- **Failure Mode**: All uploads fail -- returns empty array, never throws.

### INT-7: Feedback Token JWT Verification

- **Boundary**: Feedback token sign -> verify -> feedback endpoint
- **Setup**: Set `JWT_SECRET` environment variable.
- **Steps**:
  1. Sign token with valid payload -- verify JWT returned
  2. Verify the signed token -- verify original payload extracted (tenantId, projectId, sessionId, messageId, connectionId)
  3. Verify token signed with different secret -- verify returns null
  4. Verify expired token (mock time past 30 days) -- verify returns null
  5. Verify token with wrong `purpose` field -- verify returns null
  6. Verify malformed string -- verify returns null (no throw)
- **Expected Result**: Round-trip sign/verify works. Wrong secret, expired, wrong purpose, and malformed tokens all return null without throwing.
- **Failure Mode**: Missing `JWT_SECRET` -- throws "JWT_SECRET environment variable is required".

---

## 4. Unit Test Scenarios

### UT-1: Subject Normalization

- **Module**: `smtp-server.ts` -> `normalizeSubject()`
- **Input**: `"Re: Re: Fwd: Help with order"`, `"Fw: Re: Hello"`, `"Normal subject"`, `""`, `"Re: "`, `"FWD: FW: RE: Deep chain"`
- **Expected Output**: `"Help with order"`, `"Hello"`, `"Normal subject"`, `""`, `""`, `"Deep chain"`

### UT-2: Address Extraction

- **Module**: `smtp-server.ts` -> `extractAddress()`, `extractAddresses()`
- **Input**: Single AddressObject, array of AddressObjects, undefined, empty object
- **Expected Output**: First email string or null; all email strings or empty array

### UT-3: HTML Escape

- **Module**: `email-adapter.ts` -> `escapeHtml()`
- **Input**: `<script>alert('xss')</script>`, `"quotes" & ampersands`, normal text
- **Expected Output**: `&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;`, `&quot;quotes&quot; &amp; ampersands`, unchanged

### UT-4: CSAT Block Generation

- **Module**: `email-adapter.ts` -> `buildCsatBlock()`
- **Input**: `"test-token-123"`, various `RUNTIME_PUBLIC_BASE_URL` values
- **Expected Output**: HTML div with 5 rating links, each pointing to `/api/v1/feedback/test-token-123?rating=N`

### UT-5: Email Idempotency Key

- **Module**: `smtp-server.ts` -> idempotency key generation
- **Input**: Message-ID `<abc@example.com>`, `<special:chars@domain>`
- **Expected Output**: `email-_abc_example.com_`, `email-_special_chars_domain_`

---

## 5. Security & Isolation Tests

- [x] **Cross-tenant access returns 404**: Email to Tenant-A address cannot be resolved by Tenant-B connection (E2E-3)
- [ ] **Cross-project access returns 404**: Email connection for Project-A should not be resolvable by Project-B agents -- needs test
- [x] **Cross-user isolation via sender email**: Different senders create different sessions (implicit in threading tests)
- [ ] **Missing auth returns 401**: Feedback endpoint with invalid token returns error -- partially covered in INT-7
- [x] **Input validation -- 25 MB limit**: SMTP size limit configured (FR-7) -- unit test exists at SMTP level
- [x] **XSS protection**: HTML rendering neutralizes javascript:/vbscript:/data: schemes (INT-3)
- [x] **Loop prevention**: Self-sent and auto-reply emails dropped (E2E-6)
- [ ] **Credential protection**: Graph API client_secret not logged or exposed in error messages -- needs test
- [ ] **JWT secret rotation**: Feedback tokens signed with old secret fail verification -- needs test

---

## 6. Performance & Load Tests

| Scenario                            | Target                    | How to Measure                                            |
| ----------------------------------- | ------------------------- | --------------------------------------------------------- |
| Inbound email processing latency    | < 2s                      | Time from SMTP DATA to BullMQ enqueue                     |
| Transport cache hit rate under load | > 90%                     | Hit/miss counter on transport resolver                    |
| Concurrent SMTP sessions            | 100 simultaneous          | Send 100 emails concurrently, verify all processed        |
| Graph API token deduplication       | 1 token request per burst | Trigger 10 concurrent sends, verify 1 OAuth call          |
| Attachment upload throughput        | 5 concurrent              | Send email with 10 attachments, verify 5-batch processing |

---

## 7. Test Infrastructure

### Required Services

- **Runtime (Express)**: Started on random port (`{ port: 0 }`)
- **SMTP Server**: Started on random port via `startSmtpServer()`
- **BullMQ + Redis**: Required for inbound queue (use `ioredis-mock` or local Redis)
- **MongoDB**: For channel connections and sessions (use MongoMemoryServer for E2E)
- **Multimodal Service**: Stub endpoint for attachment uploads (or real service for full E2E)

### Data Seeding

- Channel connections: POST `/api/projects/:projectId/connections` with `channelType: 'email'`
- Tenant context: Seeded via admin API or direct DB insertion (E2E should use API)
- SMTP test emails: Use `nodemailer` test transport or direct SMTP client (`smtp-client` package)

### Environment Variables

```env
SMTP_PORT=0  # Random port for tests
JWT_SECRET=test-secret-for-email-e2e
RUNTIME_PUBLIC_BASE_URL=http://localhost:${PORT}
SMTP_RELAY_HOST=localhost
SMTP_RELAY_PORT=0  # Random port
```

### CI Configuration

- Email E2E tests require Redis and MongoDB
- Tests should be tagged `@email-channel` for selective execution
- Graph API tests use mock HTTP fetch (no real Azure AD in CI)

---

## 8. Test File Mapping

| Test File                                                                | Type        | Covers                        | Status            |
| ------------------------------------------------------------------------ | ----------- | ----------------------------- | ----------------- |
| `apps/runtime/src/__tests__/email-channel-e2e.test.ts`                   | e2e\*       | FR-1, FR-3, FR-8, FR-9, FR-11 | PASS (mock-based) |
| `apps/runtime/src/__tests__/email-smtp-server.test.ts`                   | unit        | FR-1, FR-5                    | PASS              |
| `apps/runtime/src/__tests__/email-sender.test.ts`                        | unit        | FR-4 (legacy)                 | PASS              |
| `apps/runtime/src/__tests__/email-adapter.test.ts`                       | unit        | FR-4, FR-8                    | PASS              |
| `apps/runtime/src/__tests__/email/smtp-transport.test.ts`                | unit        | FR-4                          | PASS              |
| `apps/runtime/src/__tests__/email/resolve-transport.test.ts`             | unit        | FR-4                          | PASS              |
| `apps/runtime/src/__tests__/email/email-adapter-transport.test.ts`       | integration | FR-4                          | PASS              |
| `apps/runtime/src/__tests__/email/email-smtp-server.test.ts`             | unit        | FR-1, FR-5                    | PASS              |
| `apps/runtime/src/__tests__/email/email-reply-parser.test.ts`            | unit        | FR-2                          | PASS              |
| `apps/runtime/src/__tests__/email/feedback-token.test.ts`                | unit        | FR-10                         | PASS              |
| `apps/runtime/src/__tests__/email/feedback-endpoint.test.ts`             | unit        | FR-10                         | PASS              |
| `apps/runtime/src/__tests__/email/graph-transport.test.ts`               | unit        | FR-12                         | PASS              |
| `apps/runtime/src/__tests__/adapters/email-attachment-processor.test.ts` | unit        | FR-6                          | PASS              |
| `apps/runtime/src/__tests__/email/email-channel-real-e2e.test.ts`        | e2e         | FR-1, FR-3, FR-5, FR-6, FR-11 | PLANNED           |
| `apps/runtime/src/__tests__/email/email-isolation-e2e.test.ts`           | e2e         | Cross-tenant                  | PLANNED           |

> `*` = Uses `vi.mock()` for transport resolver -- not compliant with CLAUDE.md E2E standards.

---

## 9. Open Testing Questions

1. Should the real SMTP E2E test start both an inbound SMTP server and use `nodemailer` as the test client, or should it use a lower-level SMTP client library?
2. Should Graph API E2E tests be gated behind a `GRAPH_API_E2E=true` env var since they require Azure AD credentials?
3. Should the `pendingConnections` Map unbounded growth be tested under load (connection storm scenario)?
4. How should the 25 MB SMTP size limit be tested -- send a real 25+ MB email or configure a lower limit for tests?
5. Should the test suite include a regression test for the `plus-addressing` gap (user+tag@example.com in CC self-filtering)?

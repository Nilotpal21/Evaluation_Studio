# Feedback System -- Low-Level Design

## Task T-1: Feedback Token Service

### Files

- `apps/runtime/src/services/email/feedback-token.ts`

### Key Types

- `FeedbackTokenPayload`: `{ tenantId, projectId, sessionId, messageId, connectionId }`

### Key Signatures

- `signFeedbackToken(payload: FeedbackTokenPayload) -> string` -- JWT with 30-day TTL, `purpose: 'email_csat'`
- `verifyFeedbackToken(token: string) -> FeedbackTokenPayload | null` -- Returns null for invalid/expired/wrong-purpose tokens

### Design Notes

- Requires `JWT_SECRET` environment variable
- Token TTL: 30 days (matching Redis dedup TTL)
- Purpose field (`email_csat`) prevents token reuse from other JWT contexts

---

## Task T-2: Feedback Route

### Files

- `apps/runtime/src/routes/feedback.ts` -- Factory function `createFeedbackRouter()`

### Key Endpoints

- `GET /:token` -- Collect feedback. Query param: `rating=1-5`

### Flow

1. Verify JWT token -> 404 HTML if invalid
2. Validate rating (integer 1-5) -> 400 HTML if invalid
3. Redis dedup check (`feedback:csat:{tenantId}:{messageId}`) -> "Already recorded" HTML if duplicate
4. Redis dedup set (30-day TTL)
5. Emit `feedback.submitted` trace event: `{ rating_type: 'star', rating_value, target_message_id }`
6. Log feedback
7. Return "Thank you!" HTML page

### Design Notes

- No auth middleware -- public endpoint
- Redis dedup is best-effort (fail-open on Redis errors)
- HTML pages use inline CSS (no external assets)
- `htmlPage(title, message)` utility for consistent HTML rendering
- Uses `randomUUID()` for trace event IDs

---

## Task T-3: Email Adapter Integration

### Files

- `apps/runtime/src/channels/adapters/email-adapter.ts` -- Generates feedback links in outgoing emails

### Design Notes

- Email adapter calls `signFeedbackToken()` with session/message context
- Rating links are embedded as HTML buttons/links in the email body
- Each rating value (1-5) gets its own URL with `?rating=N`

---

## Known Gaps

- No E2E test for full email -> feedback flow
- No fail-open Redis unavailability test
- No feedback for non-email channels

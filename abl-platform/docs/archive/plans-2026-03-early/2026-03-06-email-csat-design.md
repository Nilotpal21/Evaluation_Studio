# Email CSAT Feedback Design

**Date:** 2026-03-06
**Branch:** `feat/email-channel-enhancements`
**Scope:** Per-response CSAT (Customer Satisfaction) feedback for the email channel

---

## Context

The email channel now supports HTML outbound with configurable header/footer templates. The channel gap analysis identified CSAT forms in email as a missing feature from koreserver. This design adds per-response feedback collection without requiring session closure.

**Reference:** koreserver supports three feedback types: CSAT (5-point smiley scale), NPS (0-10), and Thumbs (binary). We implement CSAT 5-point to match.

---

## Architecture

Per-response feedback embedded in every outbound email (when enabled). No session closure required.

**Flow:**

1. `email-adapter.sendResponse()` checks `connection.config.csatEnabled`
2. If enabled, generates a signed JWT token encoding message context
3. Builds CSAT HTML block with 5 clickable rating links
4. Inserts between body and footer: `header + body + csatBlock + footer`
5. User clicks a rating link -> `GET /api/v1/feedback/:token?rating=3`
6. Endpoint verifies token, stores rating as a `feedback.submitted` trace event
7. Returns a simple "Thank you" HTML page

**No new database models.** Feedback stored as trace events via the existing `FeedbackSubmittedDataSchema` in the eventstore (`rating_type: 'star'`, `rating_value: 1-5`).

---

## Components

### 1. Feedback Token (JWT)

Signed with the existing `JWT_SECRET` env var. 30-day TTL (email replies can be opened late).

Payload:

```typescript
{
  tenantId: string;
  projectId: string;
  sessionId: string;
  messageId: string;
  connectionId: string;
  iat: number;
  exp: number;
}
```

### 2. CSAT HTML Block

Appended in `email-adapter.ts` between the response body and the footer template. Five inline-styled links with emoji labels matching koreserver's smiley scale:

```
How was this response?
[1] [2] [3] [4] [5]
```

Each is an `<a href>` pointing to the feedback endpoint. All inline-styled for email client compatibility.

### 3. Feedback Endpoint

New route: `GET /api/v1/feedback/:token` with `?rating=1..5`

- Verifies JWT signature + expiry
- Extracts tenant/session/message from token
- Checks for duplicate (idempotent -- show "already recorded")
- Emits `feedback.submitted` trace event
- Returns a minimal HTML page: "Thank you for your feedback!"

Public endpoint -- no auth middleware. The signed token IS the auth.

### 4. Studio Config

`csatEnabled` boolean toggle on the email channel config in `ConfigurationTab.tsx`, next to the existing header/footer fields.

```typescript
config: {
  emailHeader?: string;
  emailFooter?: string;
  csatEnabled?: boolean;
}
```

---

## Error Handling

- **Expired token** (>30 days): "This feedback link has expired" page
- **Invalid/tampered token**: 404 (don't leak info)
- **Missing or out-of-range rating**: "Invalid rating" page
- **Duplicate submission**: "Thank you" page (idempotent, don't re-record)

## Deduplication

Store submitted feedback token hashes in a Redis set with 30-day TTL (matches token expiry). Check before recording.

---

## Files

- `apps/runtime/src/channels/adapters/email-adapter.ts` -- generate token, build CSAT block, insert into HTML
- `apps/runtime/src/routes/feedback.ts` -- NEW: GET endpoint for feedback collection
- `apps/runtime/src/services/email/feedback-token.ts` -- NEW: JWT sign/verify for feedback tokens
- `apps/studio/src/components/deployments/channels/tabs/ConfigurationTab.tsx` -- add csatEnabled toggle

---

## Testing

- **Token generation:** JWT contains correct payload, expires in 30 days
- **CSAT HTML block:** 5 links present, correct URLs, not present when disabled
- **Feedback endpoint:** Valid token records rating, expired returns error, duplicate is idempotent, invalid rating rejected
- **E2E:** Send email with CSAT enabled, verify HTML contains rating links

---

## What We're NOT Building

- NPS (0-10) or thumbs -- just CSAT 5-point for now
- Feedback analytics dashboard -- stored as trace events, queryable later
- Custom CSAT question text -- hardcoded "How was this response?"
- Follow-up text feedback -- just the numeric rating
- Session closure trigger -- feedback is per-response, not per-session

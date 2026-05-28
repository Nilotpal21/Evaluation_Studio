# Email Graph API Transport — Design Document

**Date:** 2026-03-09
**Branch:** `feat/email-graph-api`
**Scope:** Add Microsoft Graph API as a pluggable outbound email transport alongside existing SMTP/nodemailer

---

## 1. Context

The email channel currently sends replies exclusively via SMTP (nodemailer). Many enterprise customers on Microsoft 365 restrict or block SMTP relay, requiring OAuth2-based Graph API access instead. The existing email adapter already supports HTML rendering, CC/BCC, header/footer templates, CSAT, threading, and attachment processing — all of which remain unchanged.

**What we're building:** A pluggable `EmailTransport` interface with two implementations (SMTP and Graph), selectable per channel connection.

**What we're NOT building:** Graph API inbound (change notifications / delta sync for inbox polling). SMTP inbound stays as-is.

---

## 2. Transport Abstraction

### Interface

```typescript
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
```

### File Layout

```
apps/runtime/src/services/email/
├── email-sender.ts              # Refactored — delegates to transport
├── transports/
│   ├── transport-interface.ts   # EmailTransport + EmailSendParams
│   ├── smtp-transport.ts        # Extracted from current email-sender.ts
│   └── graph-transport.ts       # New — OAuth2 + Graph sendMail
```

### Transport Selection

`connection.config.outbound.transport` determines which transport to use. Defaults to `'smtp'` for backward compatibility (existing connections have no `outbound.transport` field).

---

## 3. Graph Transport Implementation

### OAuth2 Client Credentials Flow

```
GraphTransport.sendReply()
  -> getAccessToken()
      -> check in-memory cache (token + expiresAt)
      -> if expired/missing:
           POST https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token
             grant_type=client_credentials
             scope=https://graph.microsoft.com/.default
      -> cache token (expiresAt minus 5-minute buffer)
  -> POST https://graph.microsoft.com/v1.0/users/{senderAddress}/sendMail
       Authorization: Bearer {token}
       Body: { message: { subject, body, toRecipients, ccRecipients, ... } }
```

### Design Decisions

- **Raw `fetch`, no Graph SDK.** For a single `sendMail` call, raw HTTP is simpler and avoids SDK version churn. Two HTTP calls total (token + sendMail).
- **In-memory token cache** per `GraphTransport` instance. Tokens are typically valid for 3600s; we cache with a 5-minute safety buffer. No Redis needed — tokens are cheap to re-acquire.
- **Threading** via `internetMessageHeaders` on the Graph sendMail payload for `In-Reply-To` and `References` (same RFC 5322 threading as SMTP).
- **Error handling:**
  - 401 (token expired) → clear cache, retry once with fresh token
  - 429 (rate limited) → respect `Retry-After` header, let BullMQ retry
  - 5xx → let BullMQ retry with backoff

### Graph sendMail Payload Shape

```json
{
  "message": {
    "subject": "Re: Original subject",
    "body": { "contentType": "HTML", "content": "<html>...</html>" },
    "toRecipients": [{ "emailAddress": { "address": "user@example.com" } }],
    "ccRecipients": [{ "emailAddress": { "address": "cc@example.com" } }],
    "bccRecipients": [{ "emailAddress": { "address": "bcc@example.com" } }],
    "internetMessageHeaders": [
      { "name": "In-Reply-To", "value": "<original-message-id>" },
      { "name": "References", "value": "<msg-1> <msg-2>" },
      { "name": "X-ABL-Source", "value": "abl-platform" }
    ]
  },
  "saveToSentItems": true
}
```

---

## 4. Connection Config Schema

### Graph Connection

```typescript
{
  outbound: {
    transport: 'graph',
    graph: {
      tenantId: string,        // Azure AD tenant ID
      clientId: string,        // App registration client ID
      senderAddress: string,   // Mailbox to send from (e.g., support@company.com)
    }
  }
}
```

`clientSecret` is stored in `encryptedCredentials` (existing tenant-scoped AES encryption), not in plaintext config.

### SMTP Connection (unchanged)

Existing connections with no `outbound.transport` field default to SMTP. SMTP config comes from environment variables (existing behavior).

---

## 5. Adapter Integration

### Transport Resolution

```typescript
function resolveTransport(connection: ResolvedConnection): EmailTransport {
  const transportType = connection.config?.outbound?.transport ?? 'smtp';

  if (transportType === 'graph') {
    return getCachedTransport(
      connection._id,
      () =>
        new GraphTransport({
          tenantId: connection.config.outbound.graph.tenantId,
          clientId: connection.config.outbound.graph.clientId,
          clientSecret: connection.decryptedCredentials.graph_client_secret,
          senderAddress: connection.config.outbound.graph.senderAddress,
        }),
    );
  }

  return getCachedTransport('smtp-default', () => new SmtpTransport(getSmtpConfigFromEnv()));
}
```

### Transport Instance Caching

`Map<string, { transport: EmailTransport; createdAt: number }>` with:

- Max size: 100 entries
- TTL: 30 minutes
- LRU eviction when full

### Health Check

Adapter `checkHealth()` delegates to transport:

- SMTP: `transporter.verify()` (nodemailer built-in)
- Graph: `GET /v1.0/users/{senderAddress}` with cached token — validates credentials + mailbox existence

---

## 6. Backward Compatibility

- Existing email connections have no `outbound.transport` field -> defaults to `'smtp'`
- No database migration needed
- SMTP transport behavior is unchanged (extracted, not rewritten)
- All existing 90+ tests continue to pass against SmtpTransport

---

## 7. Test Plan

| Test                                                    | Validates                                          |
| ------------------------------------------------------- | -------------------------------------------------- |
| `SmtpTransport: sends via nodemailer`                   | Extracted SMTP logic works identically             |
| `GraphTransport: acquires token via client credentials` | OAuth2 token request with correct params           |
| `GraphTransport: caches token until expiry`             | Second send reuses cached token                    |
| `GraphTransport: refreshes expired token`               | Expired token triggers new token request           |
| `GraphTransport: sends via Graph sendMail`              | Correct payload shape, auth header                 |
| `GraphTransport: includes threading headers`            | In-Reply-To + References in internetMessageHeaders |
| `GraphTransport: includes CC/BCC`                       | ccRecipients + bccRecipients in payload            |
| `GraphTransport: retries on 401`                        | Clears token cache, retries once                   |
| `GraphTransport: respects 429 Retry-After`              | Throws retryable error with delay                  |
| `GraphTransport: health check validates mailbox`        | GET /users/{address} succeeds                      |
| `resolveTransport: defaults to SMTP`                    | No config -> SmtpTransport                         |
| `resolveTransport: selects Graph from config`           | transport='graph' -> GraphTransport                |
| `transport cache: evicts after TTL`                     | Stale entries replaced                             |
| `email-adapter: existing tests pass unchanged`          | No regression                                      |

---

_End of Design Document_

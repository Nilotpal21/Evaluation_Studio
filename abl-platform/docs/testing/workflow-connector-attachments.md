# Testing Spec: Workflow Connector Attachments

**Feature:** `workflow-connector-attachments`
**Ticket:** ABLP-1055
**Status:** STABLE

## Scope

Tests for the attachment upload/download pipeline introduced in PR #1063:

- Connector actions emit attachments via `fileWriterFactory` → `FileStorage.upload()`
- Download served by `GET /attachments/:id?token=...` via `createAttachmentsRouter`
- HMAC-signed token is the sole bearer credential (no auth middleware)

## Test Files

| File                                        | Type        | Coverage                                                                               |
| ------------------------------------------- | ----------- | -------------------------------------------------------------------------------------- |
| `src/__tests__/attachment-token.test.ts`    | Unit        | HMAC sign/verify, expiry, tampering, cross-tenant mismatch, missing secret             |
| `src/__tests__/attachment-key.test.ts`      | Unit        | `buildAttachmentKey` sanitization                                                      |
| `src/__tests__/attachment-download.test.ts` | Integration | HTTP route: 401/403/404 paths, MIME allowlist, filename sanitization, response headers |

## Integration Test Coverage (`attachment-download.test.ts`)

Real Express app + real `LocalFileStorage` backed by a per-test temp directory. No mocks of platform components.

### Security

| Scenario                          | Expected                 |
| --------------------------------- | ------------------------ |
| No token supplied                 | 401                      |
| Token with invalid signature      | 403                      |
| Token where key prefix ≠ tenantId | 403 (cross-tenant guard) |
| File deleted after token issued   | 404                      |

### MIME Sanitization

| MIME in query     | Delivered as                    |
| ----------------- | ------------------------------- |
| `text/html`       | `application/octet-stream`      |
| `image/svg+xml`   | `application/octet-stream`      |
| `application/pdf` | `application/pdf` (passthrough) |
| `image/png`       | `image/png` (passthrough)       |

### Response Headers

| Header                   | Value                                                       |
| ------------------------ | ----------------------------------------------------------- |
| `Content-Length`         | exact file size                                             |
| `Cache-Control`          | `private, max-age=3600`                                     |
| `X-Content-Type-Options` | `nosniff`                                                   |
| `Content-Disposition`    | `inline; filename="<url-encoded-name>"` with CR/LF stripped |

## Production Wiring Verification

The download route is mounted unconditionally in `apps/workflow-engine/src/index.ts`:

```
app.use('/attachments', createAttachmentsRouter(attachmentStorage));
```

Mount point is **outside** any Redis or feature-flag guard. `attachmentStorage` is created at startup from `getStorageConfig()` before any conditional blocks.

The `fileWriterFactory` (used by polling worker + connector-tool executor) writes to the same `attachmentStorage` instance, ensuring upload and download share a storage backend.

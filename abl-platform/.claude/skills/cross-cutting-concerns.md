---
name: cross-cutting-concerns
description: Use when adding a new API endpoint, route, service, controller, or wiring up a new feature path. Ensures tenant isolation, auth, observability, and security are built in from the start rather than patched in review.
---

# Cross-Cutting Concerns

## Overview

Mandatory checklist when adding any new endpoint, service, or execution path. These concerns are systematically missed during initial implementation and caught during review, causing multi-round fix cycles.

## When to Use

- Adding a new route or API endpoint
- Creating a new service or worker
- Wiring a new feature into the runtime
- Adding a new channel/provider integration
- Creating a new BullMQ job processor

## Concern Matrix

Every new endpoint or service must address ALL rows:

| Concern                | Requirement                                                               | How to Verify                                          |
| ---------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------ |
| **Tenant isolation**   | Query-level `tenantId` scoping on every DB query                          | Grep for `findById` — must be zero in new code         |
| **Project isolation**  | `requireProjectPermission(req, res, 'obj:op')` on project-scoped routes   | Check route middleware chain                           |
| **Auth middleware**    | `createUnifiedAuthMiddleware` or `requireAuth` — never custom token logic | Grep for `jwt.verify` or `jsonwebtoken` in new code    |
| **Rate limiting**      | `rate-limiter-flexible` on public-facing or webhook endpoints             | Check route has rate limiter middleware                |
| **Input validation**   | Zod schema at request boundary, validated before service call             | Check route has `.parse()` or `.safeParse()`           |
| **Error envelope**     | Return `{ success, data?, error?: { code, message } }` on failure         | Check error responses in catch blocks                  |
| **Structured logging** | `createLogger('module-name')` — no `console.log`                          | Grep for `console.log` in new files                    |
| **Trace events**       | `TraceEvent` emission for key execution points                            | Check service emits to `TraceStore`                    |
| **Idempotency**        | Idempotency key for mutation endpoints that may be retried                | Check if endpoint is idempotent or has idempotency key |
| **Compression**        | Large payloads (>1KB) compressed before storage                           | Check storage calls use gzip                           |
| **Encryption**         | Sensitive fields (tokens, secrets, PII) encrypted at rest                 | Check field uses encryption helper                     |
| **SSRF protection**    | URLs from user input validated against allowlist                          | Check URL validation before external fetch             |

## New Endpoint Template

```typescript
// 1. Auth middleware
router.use(requireAuth);

// 2. Rate limiting (for public endpoints)
router.use(rateLimiter);

// 3. Route handler
router.post(
  '/:projectId/resource',
  requireProjectPermission(req, res, 'resource:create'),
  async (req, res) => {
    // 4. Input validation
    const body = CreateResourceSchema.parse(req.body);

    // 5. Service call (not direct DB)
    const result = await resourceService.create({
      ...body,
      tenantId: req.tenantId,
      projectId: req.params.projectId,
    });

    // 6. Standard response
    res.json({ success: true, data: result });
  },
);
```

## New Channel Provider Checklist

Channel providers (Instagram, Gupshup, Netcore, LINE) follow a repeated pattern:

- [ ] Type definitions added to core (`ChannelType` enum, `ChannelOutput` union)
- [ ] Channel added to manifest (`channel-manifest.ts`)
- [ ] Adapter implements `ChannelAdapter` interface with tests
- [ ] Media downloader implements `MediaDownloader` with logger injection and tests
- [ ] Media processor implements `MediaProcessor` with tests
- [ ] Provider registered in channel registry
- [ ] Webhook route with JWT verification and algorithm allowlist
- [ ] Connection API wired (create, update, delete, test)
- [ ] Studio UI option added to channel selector
- [ ] Integration tests for webhook routing

## New Worker/Job Processor Checklist

- [ ] Worker uses `createLogger('worker-name')`
- [ ] Job has `tenantId` in job data, scoped in all queries
- [ ] Failed jobs logged with structured error (not swallowed)
- [ ] Stalled job handler configured
- [ ] Idempotent processing (safe to retry)
- [ ] Concurrency limit set appropriately

## Anti-Pattern: "I'll Add It Later"

| Excuse                         | Reality                                                     |
| ------------------------------ | ----------------------------------------------------------- |
| "I'll add auth in a follow-up" | Unauthenticated endpoints in production = security incident |
| "Tenant scoping can wait"      | Data leak between tenants = critical compliance violation   |
| "Logging isn't urgent"         | Unobservable code = impossible to debug in production       |
| "Tests slow me down"           | Missing authz tests = review rejection guaranteed           |

## Key Files

| File                                                        | Purpose                                          |
| ----------------------------------------------------------- | ------------------------------------------------ |
| `packages/shared/src/middleware/unified-auth.middleware.ts` | Auth middleware implementation                   |
| `packages/shared/src/middleware/require-permission.ts`      | Permission checking                              |
| `packages/database/src/models/`                             | Mongoose models (check for tenant scoping)       |
| `apps/runtime/src/__tests__/*-authz.test.ts`                | Reference authz test patterns                    |
| `tools/pre-review-audit.sh`                                 | Automated verification of cross-cutting concerns |

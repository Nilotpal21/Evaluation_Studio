# SDLC Log: Webhook System — Feature Spec

**Phase:** Feature Spec
**Date:** 2026-03-22
**Status:** Complete

## Sources Explored

1. `packages/database/src/models/webhook-subscription.model.ts` — Subscription schema with tenant isolation, encryption plugin, events validation
2. `packages/database/src/models/webhook-delivery.model.ts` — Delivery tracking with TTL retention, idempotency index
3. `packages/database/src/models/webhook-subscription-connector.model.ts` — SharePoint/Graph webhook subscriptions (separate concern)
4. `apps/runtime/src/routes/http-async-channel.ts` — Full subscription CRUD, message ingestion, delivery listing (709 LOC)
5. `apps/runtime/src/routes/channel-webhooks.ts` — Inbound channel webhook handling (561 LOC)
6. `apps/runtime/src/routes/agent-transfer-webhooks.ts` — Agent transfer webhook receiver
7. `apps/runtime/src/services/queues/delivery-worker.ts` — Outbound webhook delivery with HMAC signing, retry, SSRF checks (396 LOC)
8. `apps/runtime/src/services/queues/inbound-worker.ts` — Inbound message processing with dedup
9. `apps/runtime/src/services/queues/channel-queues.ts` — BullMQ queue initialization
10. `apps/runtime/src/services/alert-delivery.ts` — Alert webhook delivery (separate system)
11. `apps/runtime/src/services/guardrails/webhook.ts` — Guardrail webhook delivery (separate system)
12. `apps/runtime/src/services/execution/channel-dispatcher.ts` — Multi-tier delivery routing
13. `apps/runtime/src/channels/types.ts` — Channel types, WebhookEventType union, job payloads
14. `apps/runtime/src/channels/security/callback-url-policy.ts` — SSRF protection
15. `packages/shared-kernel/src/security/webhook-signature.ts` — HMAC signing/verification
16. `apps/runtime/src/__tests__/http-async-events.test.ts` — Event type contract test

## Key Findings

- **Substantial existing implementation**: The webhook system is fully implemented across 3 database models, 2 BullMQ workers, full CRUD routes, and security infrastructure
- **Four webhook surfaces**: HTTP Async (outbound delivery), channel webhooks (inbound from Slack/WhatsApp), agent transfer webhooks, guardrail webhooks, alert webhooks — all separate but share security patterns
- **Event type contract**: `WebhookEventType` union defines 4 types but only `agent.response` is currently wired for subscription creation
- **Auth profile dual-read**: Delivery worker supports both auth profile credentials and legacy encrypted secrets
- **SSRF defense-in-depth**: URL validated at registration AND delivery time, DNS resolution checks, redirect blocking

## Decisions Made

| ID  | Classification | Decision                                                                                          |
| --- | -------------- | ------------------------------------------------------------------------------------------------- |
| D1  | ANSWERED       | Webhook system is scoped to HTTP Async outbound delivery (not inbound channel webhooks)           |
| D2  | ANSWERED       | BullMQ is the delivery queue (already implemented)                                                |
| D3  | ANSWERED       | HMAC-SHA256 with timestamp is the signing algorithm (already implemented)                         |
| D4  | INFERRED       | Circuit breaker / auto-disable is listed as open question (failureCount tracked but no threshold) |
| D5  | INFERRED       | DLQ for permanently failed deliveries is out of scope for initial spec                            |

## Output

- `docs/features/webhook-system.md` — 18-section feature spec, code-grounded from codebase exploration

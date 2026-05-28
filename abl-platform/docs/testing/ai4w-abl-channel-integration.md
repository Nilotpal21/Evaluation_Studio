# Testing Guide: AI4W-ABL Channel Integration

**Feature**: [AI4W-ABL Channel Integration](../features/ai4w-abl-channel-integration.md)
**Status**: PLANNED
**Last Updated**: 2026-04-16

---

## Feature Metadata

- **Feature Area**: Integrations / Channels
- **Package(s)**: `apps/runtime`, `packages/database`, `apps/studio`
- **Primary Surfaces**: Runtime API, Studio UI (channel catalog)
- **Cross-Platform**: AI4W (KoreServer) integration — requires both platforms for full E2E

---

## Current State

No tests exist yet. Feature is in PLANNED status. All scenarios below are NOT TESTED.

---

## Coverage Matrix

| FR    | Description                         | Unit | Integration | E2E     | Manual |
| ----- | ----------------------------------- | ---- | ----------- | ------- | ------ |
| FR-1  | ai4w manifest entry                 | -    | -           | -       | -      |
| FR-2  | JWT/JWKS verification               | -    | PLANNED     | -       | -      |
| FR-3  | Three response modes                | -    | -           | PLANNED | -      |
| FR-4  | Session with composite key          | -    | -           | PLANNED | -      |
| FR-5  | ablAgent type in AI4W               | -    | -           | -       | -      |
| FR-6  | ABLGatewayService                   | -    | -           | -       | -      |
| FR-7  | SSE streaming to liveUpdates        | -    | -           | PLANNED | -      |
| FR-8  | Proactive notifications             | -    | -           | PLANNED | -      |
| FR-9  | Agent discovery API                 | -    | -           | PLANNED | -      |
| FR-10 | 1-click provisioning                | -    | -           | PLANNED | -      |
| FR-11 | File exchange via signed URLs       | -    | -           | PLANNED | -      |
| FR-12 | Auth challenge flow                 | -    | -           | PLANNED | -      |
| FR-13 | Notification dedup                  | -    | PLANNED     | -       | -      |
| FR-14 | Circuit breaker on outbound         | -    | PLANNED     | -       | -      |
| FR-15 | Per-connection rate limiting        | -    | PLANNED     | -       | -      |
| FR-16 | SSRF allowlist for same-VPC         | -    | PLANNED     | -       | -      |
| FR-17 | Cross-env OAuth2 client-credentials | -    | -           | PLANNED | -      |
| FR-18 | Offline user notification fallback  | -    | PLANNED     | -       | -      |

---

## E2E Test Scenarios (Minimum 5)

### E2E-1: Sync Message Round-Trip

- **Setup**: Start ABL runtime on random port. Configure ai4w channel connection. Generate valid AI4W JWT.
- **Steps**: POST message to `/api/v1/channels/ai4w/message` with JWT auth, `X-Response-Mode: sync`.
- **Assertions**: Response body contains agent output. Session created with composite key. Tenant isolation enforced.
- **Auth context**: Valid AI4W JWT with `iss: "ai4w"`, `sub: accountId`, `email: user@test.com`.
- **Isolation checks**: Repeat with different accountId — must get separate session. Cross-tenant JWT returns 401.

### E2E-2: SSE Streaming Delivery

- **Setup**: Same as E2E-1 but with `X-Response-Mode: stream`.
- **Steps**: POST message, consume SSE stream.
- **Assertions**: Receives `event: chunk` events followed by `event: done`. Each chunk contains partial agent output. Final event contains complete response.

### E2E-3: Async Callback Round-Trip

- **Setup**: Start ABL runtime + lightweight callback receiver server. Configure ai4w connection with callback URL.
- **Steps**: POST message with `X-Response-Mode: async`. Wait for callback POST to receiver.
- **Assertions**: Initial response is 202 Accepted. Callback arrives with HMAC signature. Callback body contains full agent response. Signature verification passes.

### E2E-4: Proactive Notification + Human Approval

- **Setup**: Start ABL runtime. Configure ai4w connection with notification URL. Start notification receiver server.
- **Steps**: Trigger an ABL agent that suspends for human approval. Wait for notification POST to receiver. POST approval result to ABL callback.
- **Assertions**: Notification arrives with approval task details, callbackId, and target user email. Approval callback resumes execution. Final result delivered to notification URL.
- **Dedup check**: Re-send same notification — should be silently dropped (Redis SET NX).

### E2E-5: Project Discovery with RBAC Filtering

- **Setup**: Create ABL tenant with two projects. Configure user with `ProjectMember` access to only one of them.
- **Steps**: `GET /api/internal/v1/tenants/:tenantId/projects/discoverable` with service-token + JWT.
- **Assertions**: Only the accessible project is returned (per-project `agentCount` is live). The other project is not listed. `nextCursor` present when paginated.
- **Isolation checks**: A user whose `ProjectMember` rows live under a different tenantId sees an empty list for this tenant (cross-tenant leak fixed in 8f3e11f8).

### E2E-6: Session Isolation (Cross-Account, Cross-User)

- **Setup**: Start ABL runtime. Create ai4w channel connection.
- **Steps**: Send message from accountA/userA. Send message from accountA/userB. Send message from accountB/userA (same email, different account).
- **Assertions**: Three separate sessions created. Each session's history is independent. Cross-session access returns 404.

---

## Integration Test Scenarios (Minimum 5)

### INT-1: JWT/JWKS Verification

- **Test**: Validate JWT verification against JWKS endpoint. Test valid token, expired token, wrong issuer, wrong signing key, malformed token.
- **Assertions**: Valid token passes. All invalid tokens return 401 with appropriate error code.

### INT-2: Circuit Breaker Activation

- **Test**: Configure ai4w connection with unreachable callback URL. Send 10+ async messages to trigger circuit breaker.
- **Assertions**: First 10 attempts fail (5 BullMQ retries × 2 messages). Circuit breaker opens. Subsequent attempts fast-fail without HTTP call. After 30s reset, half-open probe sent.

### INT-3: SSRF Allowlist Enforcement

- **Test**: Configure ai4w connection with allowed callback base URL. Attempt delivery to: (a) allowed URL, (b) URL outside allowlist, (c) private IP, (d) cloud metadata URL.
- **Assertions**: (a) succeeds. (b), (c), (d) blocked with appropriate error.

### INT-4: Rate Limiting Per Connection

- **Test**: Configure tenant rate limit at 10 req/min. Send 15 requests from AI4W in quick succession.
- **Assertions**: First 10 succeed. Remaining 5 return 429 with `Retry-After` header.

### INT-5: Notification Dedup via Redis SET NX

- **Test**: Send same proactive notification (same notificationId) twice.
- **Assertions**: First delivery succeeds. Second is silently dropped. Redis key exists with TTL.

### INT-6: Offline User Notification Fallback

- **Test**: Send async response when target user has no active WebSocket connection.
- **Assertions**: Message persisted to history. Push notification sent via KANotificationService with push+bell channels.

---

## Production Wiring Verification

When the feature reaches ALPHA, verify:

- [ ] `ai4w` channel type registered in `CHANNEL_MANIFEST` and derived sets update automatically
- [ ] `ai4w` adapter loaded by `getChannelRegistry()` at runtime startup
- [ ] `ai4w` routes mounted in `server.ts` before parameterized routes (Express route ordering)
- [ ] Internal discovery/provisioning routes guarded by internal-only middleware (not publicly accessible)
- [ ] Studio channel catalog shows `ai4w` entry with correct setup wizard
- [ ] Circuit breaker wired to Redis-backed implementation (not in-memory fallback)

---

## Notes

- Cross-platform E2E tests require both ABL runtime and a simulated AI4W server. Use lightweight Express servers for the AI4W side — do NOT mock ABL platform components.
- AI4W-side tests (ablAgent, ABLGatewayService) live in the KoreServer repo and follow its testing conventions.
- All ABL-side tests follow CLAUDE.md rules: no `vi.mock` of platform packages, API-only interaction, real servers on random ports.

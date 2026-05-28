# LLD: Web SDK Implementation Plan

**Feature Spec**: `../features/sdk.md`
**Test Spec**: `../testing/sdk.md`
**HLD**: `../specs/sdk.hld.md`
**Status**: ALPHA -> BETA transition plan
**Date**: 2026-03-22

---

## Executive Summary

This implementation plan addresses the gaps identified in the SDLC pipeline for the Web SDK feature. The SDK (`packages/web-sdk`) and its server-side handler (`apps/runtime/src/websocket/sdk-handler.ts`) are functionally complete at ALPHA level. The primary gaps are: (1) zero E2E and integration tests, (2) missing security controls (origin validation, message size limits), (3) code quality issues (`.catch(() => {})`), and (4) missing CDN distribution. This plan is organized into 5 phases with clear exit criteria for each.

---

## Phase 1: Foundation — Unit & Integration Tests (Priority: P0)

**Goal**: Establish test infrastructure and cover core client-side behavior with integration tests.

### Tasks

| ID   | Task                                                         | Package | Effort | FR Coverage |
| ---- | ------------------------------------------------------------ | ------- | ------ | ----------- |
| 1.1  | Create mock SessionManager test helper                       | web-sdk | 2h     | Test infra  |
| 1.2  | Add TypedEventEmitter unit tests (on/off/emit/removeAll)     | web-sdk | 1h     | Test infra  |
| 1.3  | Add AudioCapture.float32ToPCM16 and pcm16ToBase64 unit tests | web-sdk | 1h     | FR-8        |
| 1.4  | Add IT-1: ChatClient sends message through SessionManager    | web-sdk | 2h     | FR-4        |
| 1.5  | Add IT-2: ChatClient receives streaming response chunks      | web-sdk | 2h     | FR-4, FR-6  |
| 1.6  | Add IT-5: VoiceClient state machine transitions              | web-sdk | 3h     | FR-7, FR-8  |
| 1.7  | Add IT-9: SessionManager reconnect with exponential backoff  | web-sdk | 2h     | FR-2        |
| 1.8  | Add IT-12: ManualVADAdapter push-to-talk events              | web-sdk | 1h     | FR-12       |
| 1.9  | Add IT-6: VoiceClient barge-in behavior                      | web-sdk | 2h     | FR-10       |
| 1.10 | Add IT-11: ChatClient.uploadAttachment HTTP request          | web-sdk | 2h     | FR-5        |

### Implementation Details

#### 1.1 Mock SessionManager

Create `packages/web-sdk/src/__tests__/helpers/mock-session-manager.ts`:

```typescript
// NOT a vi.mock — this is a test double implementing the SessionManager interface
class MockSessionManager extends TypedEventEmitter<SessionEvents> {
  private connected = true;
  private sessionId = 'mock-session-1';
  private sentMessages: WSClientMessage[] = [];

  isConnected(): boolean {
    return this.connected;
  }
  getSessionId(): string | null {
    return this.sessionId;
  }
  getApiKey(): string {
    return 'pk_test_key';
  }
  getEndpoint(): string {
    return 'http://localhost:3112';
  }

  send(message: WSClientMessage): void {
    this.sentMessages.push(message);
  }

  // Test helpers
  getSentMessages(): WSClientMessage[] {
    return [...this.sentMessages];
  }
  injectMessage(message: WSServerMessage): void {
    this.emit('message', message);
  }
  simulateDisconnect(): void {
    this.connected = false;
    this.emit('disconnected', undefined);
  }
}
```

#### 1.3 Audio Encoding Tests

```typescript
describe('AudioCapture static helpers', () => {
  test('float32ToPCM16 clamps to [-1, 1]', () => {
    const input = new Float32Array([0.0, 0.5, -0.5, 1.0, -1.0, 1.5, -1.5]);
    const output = AudioCapture.float32ToPCM16(input);
    expect(output[0]).toBe(0); // 0.0 -> 0
    expect(output[3]).toBe(0x7fff); // 1.0 -> max positive
    expect(output[4]).toBe(-0x8000); // -1.0 -> max negative
    expect(output[5]).toBe(0x7fff); // 1.5 clamped to 1.0
  });

  test('pcm16ToBase64 round-trips', () => {
    const pcm16 = new Int16Array([0, 100, -100, 32767, -32768]);
    const base64 = AudioCapture.pcm16ToBase64(pcm16);
    expect(typeof base64).toBe('string');
    // Decode and verify
    const decoded = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const restored = new Int16Array(decoded.buffer);
    expect(restored[0]).toBe(0);
    expect(restored[1]).toBe(100);
  });
});
```

### Exit Criteria

- [ ] All 10 tasks completed with tests passing
- [ ] `pnpm test --filter=web-sdk` passes with 0 failures
- [ ] Integration tests cover ChatClient, VoiceClient, SessionManager core paths
- [ ] Mock SessionManager is reusable for future tests
- [ ] Test count: 14 existing + ~25 new = ~39 total

---

## Phase 2: E2E Test Suite (Priority: P0)

**Goal**: Establish E2E tests exercising real WebSocket connections to a running runtime.

### Tasks

| ID  | Task                                                      | Package | Effort | E2E Coverage |
| --- | --------------------------------------------------------- | ------- | ------ | ------------ |
| 2.1 | Create E2E test infrastructure (runtime startup, seeding) | runtime | 4h     | Test infra   |
| 2.2 | E2E-1: WebSocket connection with valid API key            | runtime | 3h     | FR-1, FR-16  |
| 2.3 | E2E-2: Chat message round-trip with streaming             | runtime | 3h     | FR-4, FR-16  |
| 2.4 | E2E-3: Invalid API key rejection                          | runtime | 2h     | FR-16        |
| 2.5 | E2E-4: Rate limit enforcement                             | runtime | 2h     | FR-17        |
| 2.6 | E2E-5: Voice session initialization                       | runtime | 3h     | FR-7, FR-16  |

### Implementation Details

#### 2.1 E2E Test Infrastructure

Create `apps/runtime/src/__tests__/e2e/sdk-e2e-setup.ts`:

```typescript
// Start runtime on random port
// Seed test project with agent
// Generate public API key
// Return { baseUrl, projectId, apiKey, cleanup }
```

Key requirements:

- Start Express server on port 0 (random)
- Use MongoMemoryServer or real MongoDB
- Seed a minimal project with a test agent definition
- Generate a valid public API key for the project
- Create a reusable `connectSDK(baseUrl, projectId, apiKey)` helper that opens WebSocket and waits for `session_start`

#### 2.2 E2E-1: WebSocket Connection

```typescript
test('SDK connects via WebSocket with valid API key', async () => {
  const { baseUrl, projectId, apiKey } = testEnv;
  const wsUrl = `${baseUrl.replace('http', 'ws')}/ws/sdk?apiKey=${apiKey}&projectId=${projectId}`;
  const ws = new WebSocket(wsUrl);

  const sessionStart = await waitForMessage(ws, 'session_start', 10000);
  expect(sessionStart.sessionId).toBeTruthy();

  ws.send(JSON.stringify({ type: 'ping' }));
  const pong = await waitForMessage(ws, 'pong', 5000);
  expect(pong).toBeDefined();

  ws.close(1000);
});
```

### Exit Criteria

- [ ] 5 E2E tests passing against real runtime
- [ ] No vi.mock() or jest.mock() in E2E test files
- [ ] Tests interact only via WebSocket and HTTP API
- [ ] Test cleanup: connections closed, test data dropped
- [ ] CI-compatible: tests can run in headless environment

---

## Phase 3: Security Hardening (Priority: P0)

**Goal**: Address missing security controls identified in the HLD.

### Tasks

| ID  | Task                                                      | Package | Effort | Security Gap |
| --- | --------------------------------------------------------- | ------- | ------ | ------------ |
| 3.1 | Add Origin header validation on WebSocket upgrade         | runtime | 3h     | HLD A1-1     |
| 3.2 | Add configurable allowed origins list                     | runtime | 2h     | HLD A1-1     |
| 3.3 | Add maximum WebSocket message size enforcement            | runtime | 2h     | HLD A1-2     |
| 3.4 | Fix `.catch(() => {})` in SessionManager.attemptReconnect | web-sdk | 1h     | HLD A1-3     |
| 3.5 | Add max listener warning to TypedEventEmitter             | web-sdk | 1h     | HLD A1-4     |
| 3.6 | E2E test for origin validation                            | runtime | 2h     | Verification |
| 3.7 | E2E test for oversized message rejection                  | runtime | 1h     | Verification |

### Implementation Details

#### 3.1 Origin Validation

In `sdk-handler.ts` WebSocket upgrade handler:

```typescript
function validateOrigin(req: IncomingMessage, allowedOrigins: string[]): boolean {
  const origin = req.headers.origin;
  if (!origin) return false; // Reject requests without Origin
  if (allowedOrigins.includes('*')) return true; // Development mode
  return allowedOrigins.some(
    (allowed) =>
      allowed === origin || (allowed.startsWith('*.') && origin.endsWith(allowed.slice(1))),
  );
}
```

Configuration via project settings: `project.sdkSettings.allowedOrigins: string[]`.

#### 3.3 Message Size Limits

```typescript
const MAX_WS_MESSAGE_SIZE = 64 * 1024; // 64KB

ws.on('message', (data: Buffer) => {
  if (data.length > MAX_WS_MESSAGE_SIZE) {
    sendError(ws, 'MESSAGE_TOO_LARGE', `Message exceeds ${MAX_WS_MESSAGE_SIZE} byte limit`);
    return;
  }
  // ... normal processing
});
```

#### 3.4 Fix reconnect catch

In `SessionManager.ts`, change:

```typescript
// Before (code quality violation)
this.connect().catch(() => {});

// After
this.connect().catch((error) => {
  this.log('Reconnect attempt failed:', error instanceof Error ? error.message : String(error));
});
```

### Exit Criteria

- [ ] Origin validation rejects connections from unlisted origins
- [ ] Message size limit rejects messages > 64KB with error frame
- [ ] No `.catch(() => {})` in SDK codebase
- [ ] TypedEventEmitter warns at > 50 listeners per event
- [ ] E2E tests verify both security controls
- [ ] `pnpm build --filter=web-sdk` passes
- [ ] `pnpm build --filter=runtime` passes

---

## Phase 4: Code Quality & Remaining Integration Tests (Priority: P1)

**Goal**: Complete integration test coverage and fix remaining code quality issues.

### Tasks

| ID   | Task                                         | Package | Effort | Coverage      |
| ---- | -------------------------------------------- | ------- | ------ | ------------- |
| 4.1  | IT-3: ChatClient maintains message history   | web-sdk | 1h     | FR-4          |
| 4.2  | IT-4: ChatClient typing indicator            | web-sdk | 1h     | FR-4          |
| 4.3  | IT-7: AgentSDK connects and creates clients  | web-sdk | 2h     | FR-1          |
| 4.4  | IT-8: AgentSDK event forwarding              | web-sdk | 1h     | FR-1          |
| 4.5  | IT-10: SessionManager heartbeat              | web-sdk | 1h     | FR-3          |
| 4.6  | E2E-6: Attachment upload                     | runtime | 2h     | FR-5          |
| 4.7  | E2E-9: Lazy DB session creation              | runtime | 2h     | FR-16         |
| 4.8  | E2E-10: Concurrent WebSocket sessions        | runtime | 2h     | NFR-5         |
| 4.9  | Add SDKConfig validation with Zod schema     | web-sdk | 1h     | FR-1          |
| 4.10 | Add JSDoc comments to all public API methods | web-sdk | 2h     | Documentation |

### Exit Criteria

- [ ] All 12 integration tests passing
- [ ] 8 E2E tests passing (5 from Phase 2 + 3 new)
- [ ] All public API methods have JSDoc comments
- [ ] SDKConfig validates projectId and apiKey at construction time
- [ ] `pnpm test --filter=web-sdk` passes with 0 failures

---

## Phase 5: Distribution & BETA Readiness (Priority: P1)

**Goal**: Prepare for npm publish and CDN distribution.

### Tasks

| ID   | Task                                                | Package | Effort | Deliverable        |
| ---- | --------------------------------------------------- | ------- | ------ | ------------------ |
| 5.1  | Configure Vite for production UMD + ESM build       | web-sdk | 2h     | Optimized bundles  |
| 5.2  | Verify bundle size < 50KB gzipped (core only)       | web-sdk | 1h     | NFR-4              |
| 5.3  | Add CDN upload step to CI/CD pipeline               | infra   | 3h     | CDN distribution   |
| 5.4  | Add versioned URL scheme (/sdk/v1/agent-sdk.umd.js) | infra   | 1h     | Version management |
| 5.5  | Verify React 19 peer dependency compatibility       | web-sdk | 2h     | Backward compat    |
| 5.6  | Add CHANGELOG.md with ALPHA -> BETA release notes   | web-sdk | 1h     | Release notes      |
| 5.7  | E2E-7: Reconnect after server disconnect            | runtime | 2h     | FR-2               |
| 5.8  | E2E-8: Deployment-aware agent resolution            | runtime | 2h     | FR-18              |
| 5.9  | Update feature spec status to BETA                  | docs    | 0.5h   | Doc sync           |
| 5.10 | Run /post-impl-sync                                 | docs    | 1h     | SDLC compliance    |

### Exit Criteria

- [ ] UMD bundle < 50KB gzipped
- [ ] ESM bundle tree-shakeable
- [ ] CDN distribution configured and tested
- [ ] React 19 compatibility verified
- [ ] All 10 E2E tests passing
- [ ] All 12 integration tests passing
- [ ] Feature status updated to BETA in all docs
- [ ] CHANGELOG.md with version history

---

## Wiring Checklist

| Component          | Wired Into                | Verification                             |
| ------------------ | ------------------------- | ---------------------------------------- |
| MockSessionManager | All integration tests     | Tests use shared helper, not vi.mock     |
| Origin validation  | sdk-handler.ts upgrade    | E2E test rejects unlisted origin         |
| Message size limit | sdk-handler.ts on.message | E2E test rejects oversized message       |
| Reconnect logging  | SessionManager.ts         | Debug logs show reconnect failure reason |
| Max listener warn  | EventEmitter.ts           | Console.warn at > 50 listeners           |
| SDKConfig Zod      | AgentSDK constructor      | Throws on missing projectId/apiKey       |
| CDN upload         | CI/CD pipeline            | UMD bundle accessible at versioned URL   |

---

## Risk Register

| Risk                                     | Probability | Impact | Mitigation                                             |
| ---------------------------------------- | ----------- | ------ | ------------------------------------------------------ |
| E2E tests flaky due to timing            | HIGH        | MEDIUM | Use explicit waits, not setTimeout; increase timeouts  |
| MongoMemoryServer issues in CI           | MEDIUM      | HIGH   | Provide fallback to real MongoDB in CI environment     |
| Voice E2E requires configured provider   | HIGH        | HIGH   | E2E-5 tests only handshake, not full voice pipeline    |
| Bundle size exceeds 50KB with voice deps | LOW         | MEDIUM | Voice deps are peer + dynamic import; core stays small |
| React 19 breaks AgentProvider            | MEDIUM      | MEDIUM | Test early; useContext/useState APIs are stable        |

---

## Timeline Estimate

| Phase | Duration | Dependencies                 | Cumulative |
| ----- | -------- | ---------------------------- | ---------- |
| 1     | 3 days   | None                         | 3 days     |
| 2     | 3 days   | Phase 1 (mock helpers)       | 6 days     |
| 3     | 2 days   | None (parallel with Phase 2) | 6 days     |
| 4     | 2 days   | Phase 1, Phase 2             | 8 days     |
| 5     | 2 days   | Phase 2, Phase 3             | 10 days    |

**Total**: ~10 working days (2 calendar weeks) for ALPHA -> BETA transition.

Phases 2 and 3 can execute in parallel since they touch different files (E2E tests in `apps/runtime/src/__tests__/e2e/` vs. security fixes in `sdk-handler.ts` and `web-sdk/src/`).

---

## Summary

| Metric                  | Value                              |
| ----------------------- | ---------------------------------- |
| Total phases            | 5                                  |
| Total tasks             | 47                                 |
| FRs covered             | 18/18                              |
| NFRs covered            | 6/8                                |
| E2E scenarios           | 10 (5 in Phase 2, 5 in Phases 4-5) |
| Integration scenarios   | 12 (7 in Phase 1, 5 in Phase 4)    |
| Security gaps addressed | 3 (origin, message size, catch)    |
| Estimated effort        | ~10 working days                   |

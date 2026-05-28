# Test Specification: Voice TTS Preview

**Feature Spec**: `docs/features/sub-features/voice-tts-preview.md`
**HLD**: `docs/specs/voice-tts-preview.hld.md`
**LLD**: `docs/plans/2026-04-11-voice-tts-preview-impl-plan.md`
**Status**: IN PROGRESS
**Last Updated**: 2026-04-11

---

## 1. Coverage Matrix

| FR    | Description                                   | Unit | Integration | E2E   | Manual | Status      |
| ----- | --------------------------------------------- | ---- | ----------- | ----- | ------ | ----------- |
| FR-1  | Preview control in VoiceFields                | UT-1 | —           | E7    | M1     | UNIT TESTED |
| FR-2  | Accept sample text, synthesize via provider   | UT-2 | INT-1,2,3   | E1    | —      | UNIT TESTED |
| FR-3  | POST /api/v1/voice/tts-preview endpoint       | —    | INT-4,5     | E1    | —      | UNIT TESTED |
| FR-4  | Credential resolution via VoiceServiceFactory | —    | INT-6,7     | E3    | —      | NOT TESTED  |
| FR-5  | ElevenLabs + Orpheus provider support         | —    | INT-4,5     | E1,E2 | M2     | UNIT TESTED |
| FR-6  | Display synthesis latency                     | UT-4 | INT-8       | E1    | M2     | UNIT TESTED |
| FR-7  | Rate limiting (5 req/min/tenant)              | —    | INT-9       | E5    | —      | NOT TESTED  |
| FR-8  | Auth via requireAuth middleware               | —    | —           | E4    | —      | NOT TESTED  |
| FR-9  | Structured error responses                    | —    | INT-10,11   | E6    | —      | UNIT TESTED |
| FR-10 | Default sample text                           | UT-1 | —           | —     | M1     | UNIT TESTED |

---

## 2. E2E Test Scenarios (MANDATORY)

CRITICAL: E2E tests must exercise the real system through its HTTP API. No mocks, no direct DB access, no stubbed servers. External provider APIs (ElevenLabs, Groq) are mocked via dependency injection — these are third-party services, not codebase components.

### E2E-1: Successful ElevenLabs TTS Preview

- **Preconditions**: Tenant exists, ElevenLabs TTS service instance configured with valid (DI-injected stub) credentials, auth token for tenant user
- **Steps**:
  1. POST `/api/v1/voice/tts-preview` with `{ text: "Hello, how can I help you?", serviceInstanceId: "<elevenlabs-instance>", provider: "elevenlabs", voice: "EXAVITQu4vr4xnSDxMaL", model: "eleven_multilingual_v2" }` + Bearer token
  2. Assert response status 200
  3. Assert `Content-Type` header is `audio/mpeg`
  4. Assert response body is non-empty binary data (length > 0)
  5. Assert `X-Synthesis-Latency-Ms` header is present and numeric
- **Expected Result**: 200 with MP3 audio body and latency header
- **Auth Context**: Tenant OWNER user with valid JWT
- **Isolation Check**: Request succeeds only for the tenant that owns the service instance
- **Covers**: FR-3, FR-5, FR-6

### E2E-2: Successful Orpheus TTS Preview

- **Preconditions**: Tenant exists, Orpheus (custom:orpheus) TTS service instance configured with valid (DI-injected stub) Groq credentials
- **Steps**:
  1. POST `/api/v1/voice/tts-preview` with `{ text: "Welcome to our service.", serviceInstanceId: "<orpheus-instance>", provider: "custom:orpheus" }` + Bearer token
  2. Assert response status 200
  3. Assert `Content-Type` header is `audio/wav`
  4. Assert response body is non-empty and starts with WAV header bytes (`RIFF....WAVE`)
  5. Assert `X-Synthesis-Latency-Ms` header is present
- **Expected Result**: 200 with WAV audio body
- **Auth Context**: Tenant OWNER user with valid JWT
- **Covers**: FR-3, FR-5

### E2E-3: Cross-Tenant Isolation

- **Preconditions**: Tenant A has an ElevenLabs service instance. Tenant B is a separate tenant with its own auth.
- **Steps**:
  1. As Tenant A user, POST `/api/v1/voice/tts-preview` with Tenant A's `serviceInstanceId` → assert 200 success
  2. As Tenant B user, POST `/api/v1/voice/tts-preview` with Tenant A's `serviceInstanceId`
  3. Assert response is 404 with `{ success: false, error: { code: "SERVICE_NOT_CONFIGURED" } }`
- **Expected Result**: Tenant B cannot access Tenant A's service instance; returns 404 (not 403, per core invariant)
- **Auth Context**: Both tenants have valid OWNER JWTs
- **Isolation Check**: Cross-tenant returns 404
- **Covers**: FR-4, FR-8

### E2E-4: Unauthenticated Request Rejected

- **Preconditions**: TTS service instance exists
- **Steps**:
  1. POST `/api/v1/voice/tts-preview` with valid body but NO Authorization header
  2. Assert response status 401
  3. POST with an expired/invalid JWT token
  4. Assert response status 401
- **Expected Result**: 401 Unauthorized for missing or invalid auth
- **Auth Context**: No auth / invalid auth
- **Covers**: FR-8

### E2E-5: Rate Limit Enforcement

- **Preconditions**: Tenant with ElevenLabs service instance configured. Rate limit: 5 req/min/tenant.
- **Steps**:
  1. Send 5 POST `/api/v1/voice/tts-preview` requests in rapid succession from the same tenant
  2. Assert all 5 return 200
  3. Send a 6th request immediately
  4. Assert response status 429
  5. Assert response body: `{ success: false, error: { code: "RATE_LIMITED", message: "..." } }`
  6. Assert `Retry-After` header is present
- **Expected Result**: First 5 requests succeed, 6th is rate-limited with 429
- **Auth Context**: Same tenant user for all 6 requests
- **Covers**: FR-7, FR-9

### E2E-6: Invalid Credentials Return Structured Error

- **Preconditions**: Tenant has an ElevenLabs service instance with an intentionally invalid/expired API key stored (encrypted)
- **Steps**:
  1. POST `/api/v1/voice/tts-preview` with the invalid-credential service instance
  2. Assert response status is 4xx or 5xx (provider-dependent)
  3. Assert body matches: `{ success: false, error: { code: "PROVIDER_ERROR", message: "..." } }`
  4. Assert error message mentions credentials/API key (not raw stack trace)
  5. Assert API key is NOT present anywhere in the response body
- **Expected Result**: Structured error without credential exposure
- **Auth Context**: Tenant OWNER
- **Covers**: FR-4, FR-9

### E2E-7: Admin Voice Services Test Button Flow

- **Preconditions**: Tenant with configured ElevenLabs service instance accessible from admin context
- **Steps**:
  1. POST `/api/v1/voice/tts-preview` with `{ text: "Testing voice quality.", serviceInstanceId: "<admin-configured-instance>", provider: "elevenlabs", voice: "<override-voice-id>" }`
  2. Assert 200 with audio/mpeg
  3. Verify the voice override was used (the request specifies a different voice than the instance default)
- **Expected Result**: Preview synthesizes using the overridden voice, not the instance default
- **Auth Context**: Tenant ADMIN or OWNER
- **Covers**: FR-3, FR-5

---

## 3. Integration Test Scenarios (MANDATORY)

Integration tests verify service boundaries. External provider APIs (ElevenLabs, Groq) are the only mocked dependencies, injected via constructor/factory parameters — NOT via `vi.mock`.

### INT-1: Request Validation — Empty Text

- **Boundary**: HTTP request → Zod validation middleware
- **Setup**: Start Express app on random port with full middleware chain
- **Steps**:
  1. POST `/api/v1/voice/tts-preview` with `{ text: "", serviceInstanceId: "svc1", provider: "elevenlabs" }`
  2. Assert 400 response
  3. Assert body contains Zod validation error indicating `text` must be at least 1 character
- **Expected Result**: 400 with structured validation error
- **Failure Mode**: If Zod schema allows empty text, synthesis will be called with empty input → wasted provider API call
- **Covers**: FR-2, FR-9

### INT-2: Request Validation — Text Exceeds 500 Characters

- **Boundary**: HTTP request → Zod validation middleware
- **Setup**: Start Express app on random port
- **Steps**:
  1. POST with `text` field of 501 characters + valid serviceInstanceId/provider
  2. Assert 400 response
  3. Assert body mentions character limit
- **Expected Result**: 400 with max-length validation error
- **Covers**: FR-2, FR-9

### INT-3: Request Validation — Missing Required Fields

- **Boundary**: HTTP request → Zod validation middleware
- **Steps**:
  1. POST with `{}` (empty body) → assert 400
  2. POST with `{ text: "hello" }` (missing serviceInstanceId, provider) → assert 400
  3. POST with `{ text: "hello", serviceInstanceId: "svc1" }` (missing provider) → assert 400
- **Expected Result**: 400 for each case with field-specific error messages
- **Covers**: FR-2, FR-9

### INT-4: Provider Dispatch — ElevenLabs Path

- **Boundary**: Route handler → ElevenLabsService (with DI-injected provider stub)
- **Setup**: Inject a stub ElevenLabsService that returns a known MP3 buffer. Start Express with DI.
- **Steps**:
  1. POST with `provider: "elevenlabs"`, valid serviceInstanceId
  2. Assert the stub's `synthesize` method was called with the correct text, voiceId, and model
  3. Assert response is the MP3 buffer from the stub
  4. Assert `Content-Type: audio/mpeg`
- **Expected Result**: Correct delegation to ElevenLabsService with resolved credentials
- **Covers**: FR-3, FR-5

### INT-5: Provider Dispatch — Orpheus Path

- **Boundary**: Route handler → Orpheus synthesizer (with DI-injected Groq API stub)
- **Setup**: Inject a stub that returns known PCM data wrapped in WAV format
- **Steps**:
  1. POST with `provider: "custom:orpheus"`, valid serviceInstanceId
  2. Assert the Groq stub was called with correct text and voice parameters
  3. Assert response has WAV format (check RIFF header)
  4. Assert `Content-Type: audio/wav`
- **Expected Result**: Correct delegation to Orpheus synthesizer
- **Covers**: FR-3, FR-5

### INT-6: Credential Resolution — Valid Service Instance

- **Boundary**: Route handler → VoiceServiceFactory.resolveServiceCredentials
- **Setup**: Real VoiceServiceFactory with test MongoDB containing a TenantServiceInstance document (encrypted API key). Test encryption key in env.
- **Steps**:
  1. POST with the seeded serviceInstanceId for the authenticated tenant
  2. Assert VoiceServiceFactory resolves and decrypts the API key
  3. Assert the decrypted key is passed to the provider stub (not exposed in response)
- **Expected Result**: Credential resolution succeeds transparently; key never in HTTP response
- **Covers**: FR-4

### INT-7: Credential Resolution — Service Instance Not Found

- **Boundary**: Route handler → VoiceServiceFactory
- **Setup**: No service instance seeded for the given ID / tenant combination
- **Steps**:
  1. POST with `serviceInstanceId: "nonexistent-id"`
  2. Assert 404 response
  3. Assert body: `{ success: false, error: { code: "SERVICE_NOT_CONFIGURED", message: "..." } }`
- **Expected Result**: 404 with structured error
- **Failure Mode**: Without this check, the handler could throw an unstructured 500
- **Covers**: FR-4, FR-9

### INT-8: Latency Header Presence

- **Boundary**: Route handler → response headers
- **Setup**: DI-injected provider stub with artificial delay (50ms)
- **Steps**:
  1. POST valid request
  2. Assert `X-Synthesis-Latency-Ms` header exists in response
  3. Assert value is a positive integer >= 50
- **Expected Result**: Latency header reflects actual synthesis time
- **Covers**: FR-6

### INT-9: Rate Limit Middleware Integration

- **Boundary**: Rate limit middleware → route handler
- **Setup**: Configure rate limit to 3 req/min for test speed. Start Express with real rate limiter.
- **Steps**:
  1. Send 3 requests → all return 200
  2. Send 4th request → returns 429
  3. Assert 429 body: `{ success: false, error: { code: "RATE_LIMITED" } }`
  4. Assert `Retry-After` header
  5. Verify a different tenant is NOT rate-limited (separate counter)
- **Expected Result**: Per-tenant rate limiting enforced, cross-tenant isolation maintained
- **Covers**: FR-7

### INT-10: Unsupported Provider Returns 400

- **Boundary**: Route handler → provider dispatch
- **Steps**:
  1. POST with `provider: "cartesia"` (not supported)
  2. Assert 400 response
  3. Assert body: `{ success: false, error: { code: "UNSUPPORTED_PROVIDER" } }`
- **Expected Result**: Clean 400 for unsupported providers
- **Covers**: FR-9

### INT-11: Provider API Failure Returns Structured Error

- **Boundary**: Route handler → provider (DI stub configured to throw)
- **Setup**: Inject provider stub that throws `Error("API rate limit exceeded")`
- **Steps**:
  1. POST valid request
  2. Assert response is 502 or 503
  3. Assert body: `{ success: false, error: { code: "PROVIDER_ERROR", message: "..." } }`
  4. Assert the raw error details are NOT leaked to client
- **Expected Result**: Provider failures are caught and returned as structured errors
- **Covers**: FR-9

---

## 4. Unit Test Scenarios

### UT-1: TTSPreview Component Renders with Default Text

- **Module**: `apps/studio/src/components/voice/TTSPreview.tsx`
- **Input**: Render `<TTSPreview provider="elevenlabs" serviceInstanceId="svc1" />`
- **Expected Output**: Textarea contains "Hello, how can I help you today?", Play button visible, character count shows "38 / 500 characters"
- **Covers**: FR-1, FR-10

### UT-2: Play Button Triggers API Call

- **Module**: `<TTSPreview>`
- **Input**: User types custom text, clicks Play
- **Expected Output**: API client `synthesizeTTSPreview()` called with `{ text, serviceInstanceId, provider, voice, model }`. Button enters loading state.
- **Covers**: FR-2

### UT-3: Loading State While Synthesizing

- **Module**: `<TTSPreview>`
- **Input**: API call in flight
- **Expected Output**: Play button shows spinner/loading indicator, button is disabled, text input remains editable
- **Covers**: FR-1

### UT-4: Latency Display After Playback

- **Module**: `<TTSPreview>`
- **Input**: API returns audio successfully in 340ms
- **Expected Output**: Shows "Generated in 340ms" below the audio player
- **Covers**: FR-6

### UT-5: Error State on API Failure

- **Module**: `<TTSPreview>`
- **Input**: API returns `{ success: false, error: { code: "PROVIDER_ERROR", message: "ElevenLabs API returned 401" } }`
- **Expected Output**: Error message displayed to user, Play button re-enabled, no audio player shown
- **Covers**: FR-9

### UT-6: Character Count Updates Dynamically

- **Module**: `<TTSPreview>`
- **Input**: User types 120 characters
- **Expected Output**: Counter shows "120 / 500 characters". Play button enabled.
- **Covers**: FR-2

### UT-7: Text Input Enforces 500-Character Max

- **Module**: `<TTSPreview>`
- **Input**: User attempts to type beyond 500 characters
- **Expected Output**: Input truncated or prevented at 500. Counter shows "500 / 500 characters". No client-side error needed (just maxLength).
- **Covers**: FR-2

### UT-8: Voice Override Selector

- **Module**: `<TTSPreview>` with `allowVoiceOverride: true`
- **Input**: Render with `allowVoiceOverride={true}`
- **Expected Output**: Voice selector dropdown is visible. Render with `allowVoiceOverride={false}` → no dropdown.
- **Covers**: FR-1

### UT-9: Audio Object URL Cleanup

- **Module**: `<TTSPreview>`
- **Input**: Play audio, then play again (new synthesis)
- **Expected Output**: Previous object URL is revoked via `URL.revokeObjectURL` before creating new one (no memory leak)
- **Covers**: FR-1

---

## 5. Security & Isolation Tests

### SEC-1: Cross-Tenant Access Returns 404

- Tenant B's request with Tenant A's serviceInstanceId returns 404 (not 403)
- The 404 response must NOT reveal whether the service instance exists for another tenant
- **Covered by**: E2E-3

### SEC-2: Missing Auth Returns 401

- Request without Authorization header returns 401
- Request with malformed JWT returns 401
- Request with expired JWT returns 401
- **Covered by**: E2E-4

### SEC-3: API Key Never Exposed

- Successful responses contain only binary audio — no API keys in headers or body
- Error responses reference "credentials" generically — never include the actual API key
- VoiceServiceFactory decrypts server-side; the decrypted key never reaches the HTTP response
- **Covered by**: E2E-6, INT-6

### SEC-4: Input Validation Prevents Injection

- Text field validated via Zod: string, min 1, max 500
- serviceInstanceId validated as non-empty string
- provider validated against enum: `['elevenlabs', 'custom:orpheus']`
- No shell command construction from user input
- **Covered by**: INT-1, INT-2, INT-3

### SEC-5: Rate Limiting Prevents Cost Abuse

- Per-tenant rate limiting (5 req/min) prevents a single tenant from running up provider costs
- Different tenants have independent rate limit counters
- **Covered by**: E2E-5, INT-9

---

## 6. Performance & Load Tests

### PERF-1: Synthesis Latency Measurement Accuracy

- Verify `X-Synthesis-Latency-Ms` header reflects actual wall-clock time spent in provider synthesis
- Does not include request parsing or response serialization time
- **Approach**: Inject a DI stub with known artificial delay, verify header matches ± 50ms

### PERF-2: Concurrent Tenant Requests

- 3 different tenants each send a preview request simultaneously
- All 3 succeed without interference
- Rate limits are per-tenant, not global
- **Approach**: Use `Promise.all` with requests from 3 different auth contexts

### PERF-3: Large Text Response Size

- Send maximum-length text (500 characters) to verify the endpoint handles larger audio responses
- Assert response completes within 10 seconds (generous timeout for test stability)
- Assert response body size is reasonable (< 5MB for 500 chars)

---

## 7. Test Infrastructure

### Required Services

| Service | Purpose                                         | Required For       |
| ------- | ----------------------------------------------- | ------------------ |
| Express | Real HTTP server on random port (`{ port: 0 }`) | All E2E, INT tests |
| MongoDB | TenantServiceInstance documents (test fixtures) | INT-6,7, all E2E   |
| Redis   | Rate limiting counters                          | INT-9, E2E-5       |

### External Dependencies (Mocked via DI)

| Dependency     | Mock Strategy                                           |
| -------------- | ------------------------------------------------------- |
| ElevenLabs API | DI-injected stub returning fixed MP3 buffer             |
| Groq API       | DI-injected stub returning fixed PCM data (WAV-wrapped) |

### Data Seeding

For E2E and integration tests:

```text
Tenant A:
  - ElevenLabs service instance (active, encrypted API key: "test-el-key-a")
  - Orpheus service instance (active, encrypted API key: "test-groq-key-a")

Tenant B:
  - ElevenLabs service instance (active, encrypted API key: "test-el-key-b")

Tenant C (for cross-tenant isolation):
  - No service instances
```

Seeding must happen via the service instance CRUD API (POST), NOT via direct MongoDB insertion.

### Environment Variables

| Variable                 | Test Value                             | Purpose                           |
| ------------------------ | -------------------------------------- | --------------------------------- |
| `TTS_PREVIEW_RATE_LIMIT` | `5` (or `3` for fast rate-limit tests) | Rate limit threshold              |
| `TTS_PREVIEW_MAX_CHARS`  | `500`                                  | Max character count               |
| `ENCRYPTION_KEY`         | Test key                               | Decrypt service instance API keys |

### CI Configuration

- Tests run in the `apps/runtime` package: `pnpm test --filter=@agent-platform/runtime`
- Requires MongoDB and Redis containers (Docker Compose or CI service containers)
- No external network calls — all provider APIs are DI-stubbed

---

## 8. Test File Mapping

| Test File                                                        | Type | Covers                        | Status      |
| ---------------------------------------------------------------- | ---- | ----------------------------- | ----------- |
| `apps/runtime/src/__tests__/routes/tts-preview.test.ts`          | unit | Schema validation, config     | IMPLEMENTED |
| `apps/studio/src/__tests__/components/voice/TTSPreview.test.tsx` | unit | UT-1,2,4,5,6,8 (11 tests)     | IMPLEMENTED |
| `apps/runtime/src/__tests__/routes/tts-preview.e2e.test.ts`      | e2e  | E2E-1 through E2E-7           | PLANNED     |
| `apps/runtime/src/__tests__/routes/tts-preview-security.test.ts` | int  | SEC-1 through SEC-5, INT-6..9 | PLANNED     |

---

## 9. Manual Testing Scenarios

### M1: Visual UI Verification

- Navigate to voice pipeline channel connection configuration
- Verify TTSPreview control appears below Speech Synthesis voice selection
- Verify default text is pre-filled
- Verify character counter updates as user types
- Navigate to Admin > Voice Services, verify "Test" button on TTS provider cards

### M2: Audio Quality Verification

- Play ElevenLabs preview → verify audio is clear, correct voice
- Play Orpheus preview → verify audio is clear, WAV format plays correctly
- Try different voices via admin override → verify voice actually changes
- Evaluate latency display accuracy subjectively

### M3: Error UX Verification

- Configure invalid API key → trigger preview → verify user-friendly error message
- Rapidly click Play 6+ times → verify rate limit error message
- Test with very short text ("Hi") and maximum text (500 chars)

---

## 10. Open Testing Questions

1. Should we test with real ElevenLabs/Groq API keys in a separate "live integration" test suite (gitignored credentials), or is DI-stubbed provider testing sufficient for CI?
2. How should rate-limit tests handle timing sensitivity? Use `vi.useFakeTimers()` for window advancement or real-time waits?
3. Should the E2E tests verify audio content (e.g., WAV header structure, MP3 frame validity) or just binary non-emptiness?
4. Should there be a browser-based E2E test (Playwright) for the full UI flow (E2E-7, M1), or is HTTP API E2E + manual verification sufficient?
5. How should the test seed encrypted API keys — use the real encryption service with a test key, or a simplified test encryption?

# Device Authorization -- Low-Level Design

## Task T-1: DeviceAuthRequest Model

### Files

- `packages/database/src/models/device-auth-request.model.ts`

### Key Types

- `IDeviceAuthRequest`: `{ _id, deviceCode, userCode, scopes, expiresAt, userId, authorizedAt, consumedAt, _v }`

### Design Notes

- `_id` uses UUIDv7
- Unique indexes on `deviceCode` and `userCode`
- TTL index on `expiresAt` with `expireAfterSeconds: 0` for automatic cleanup
- No `tenantIsolationPlugin` (device codes are not tenant-scoped; tenant is resolved at token issuance)

---

## Task T-2: Device Auth Service

### Files

- `apps/runtime/src/services/device-auth-service.ts`

### Key Signatures

- `hashToken(token: string) -> string` -- SHA-256 hash for secure storage
- `generateUserCode() -> string` -- XXXX-XXXX format (chars: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`)
- `createDeviceAuthRequest(scopes) -> { deviceCode (raw), userCode, expiresAt }` -- Creates DB entry with hashed deviceCode
- `getDeviceAuthByUserCode(userCode) -> DeviceAuthRequest | null` -- Lookup for browser display
- `authorizeDeviceRequest(userCode, userId) -> boolean` -- Atomic update: sets userId + authorizedAt on un-authorized, un-expired, un-consumed entry
- `pollDeviceToken(deviceCode) -> { status, userId?, scopes? }` -- Returns: pending, authorized (marks consumed), expired, consumed
- `createDeviceTokenPair(userId) -> { accessToken, refreshToken, expiresIn }` -- Resolves membership, builds JWT payload, signs tokens

### Design Notes

- Raw device code (64 bytes random hex) returned to CLI only at creation time
- Hashed device code stored in DB -- compromise of DB does not expose valid codes
- `pollDeviceToken` atomically marks as consumed on first successful poll
- `createDeviceTokenPair` resolves tenant from user's first membership via `resolveFirstMembership`
- Access token TTL: 24 hours

---

## Task T-3: Device Auth Routes

### Files

- `apps/runtime/src/routes/device-auth.ts` -- 4 endpoints at `/api/auth/device`

### Key Endpoints

- `POST /` -- Initiate flow. Body: `{ scopes? }`. Returns RFC 8628 response with `device_code`, `user_code`, `verification_uri`, `verification_uri_complete`, `expires_in`, `interval`.
- `GET /lookup` -- Query: `?code=XXXX-XXXX`. Returns `{ userCode, scopes, expiresAt }`. Checks expired (410), already authorized (409).
- `POST /authorize` -- Body: `{ user_code, allow }`. Requires `authMiddleware`. Uses `req.user?.id` for userId.
- `POST /token` -- Body: `{ device_code, grant_type? }`. Rate-limited (12/min per IP). Returns tokens or error status.

### Rate Limiter

- In-memory `Map<string, { count, resetAt }>` keyed by IP
- 12 requests per 60-second window
- Cleanup interval: every 5 minutes (`setInterval.unref()`)
- Returns 429 `slow_down` on exceeding limit

### Design Notes

- `POST /` and `GET /lookup` and `POST /token` require no authentication
- `POST /authorize` requires `authMiddleware` (JWT)
- Verification URI: `${STUDIO_URL}/auth/device`
- Default scopes: `['read_traces', 'read_state', 'subscribe']`

---

## Task T-4: Studio DeviceAuth Page

### Files

- `apps/studio/src/components/DeviceAuth.tsx`

### Design Notes

- Status states: `input | loading | confirm | success | error | denied`
- Supports `?code=XXXX-XXXX` URL param for auto-fill from `verification_uri_complete`
- Redirects to login if not authenticated (preserves return URL with code)
- Displays scope descriptions with i18n support (`auth.device_page` namespace)
- Calls runtime API: lookup -> display scopes -> authorize on user approval
- Uses auth store access token for authorize API call

---

## Known Gaps

- Rate limiter not distributed (in-memory Map, per-pod)
- `req.user?.id` vs `req.user?.sub` potential mismatch in authorize endpoint
- Device auth routes use `console.error` instead of `createLogger`
- Scopes stored but not enforced at resource level

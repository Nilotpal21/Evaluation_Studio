# Studio & Web SDK Preview Refactoring Plan

> **Status**: ARCHIVED — Most items in this plan have been completed.
> Key changes implemented: preview token system (`apps/studio/src/lib/preview-token.ts`),
> SDK share route (`apps/studio/src/app/api/sdk/share/route.ts`), session detail page,
> unified auth middleware (replacing hardcoded `pk_demo_preview`).
> Remaining items have been folded into `ENTERPRISE_ROADMAP.md`.

## Executive Summary

The studio and web SDK preview have **13 critical architectural issues** causing recurring breakage. This plan provides a systematic approach to fix them in priority order.

---

## Priority 1: CRITICAL - Fix Immediately

### 1.1 Remove Hardcoded Demo API Key

**Problem**: Both preview pages use hardcoded `pk_demo_preview` key, creating security and isolation issues.

**Files to Modify**:

- `apps/studio/src/app/preview/page.tsx` (Line 151)
- `apps/studio/src/app/preview/[projectId]/page.tsx` (Line 91)
- `apps/runtime/src/websocket/sdk-handler.ts` (Lines 198-208)

**Solution**:

```typescript
// NEW: apps/studio/src/lib/preview-token.ts
import { createHmac } from 'crypto';

const PREVIEW_SECRET = process.env.PREVIEW_TOKEN_SECRET || process.env.JWT_SECRET;

export interface PreviewTokenPayload {
  projectId: string;
  userId: string;
  permissions: { chat: boolean; voice: boolean };
  exp: number;
}

export function generatePreviewToken(payload: Omit<PreviewTokenPayload, 'exp'>): string {
  const fullPayload: PreviewTokenPayload = {
    ...payload,
    exp: Date.now() + 60 * 60 * 1000, // 1 hour
  };
  const data = JSON.stringify(fullPayload);
  const signature = createHmac('sha256', PREVIEW_SECRET!).update(data).digest('base64url');
  return `${Buffer.from(data).toString('base64url')}.${signature}`;
}

export function verifyPreviewToken(token: string): PreviewTokenPayload | null {
  try {
    const [encodedPayload, signature] = token.split('.');
    if (!encodedPayload || !signature) return null;

    const data = Buffer.from(encodedPayload, 'base64url').toString();
    const expectedSignature = createHmac('sha256', PREVIEW_SECRET!)
      .update(data)
      .digest('base64url');

    if (signature !== expectedSignature) return null;

    const payload = JSON.parse(data) as PreviewTokenPayload;
    if (payload.exp < Date.now()) return null;

    return payload;
  } catch {
    return null;
  }
}
```

**Changes to preview/page.tsx**:

```typescript
// REMOVE this:
const apiKey = 'pk_demo_preview';

// REPLACE with preview token from share link validation:
// The share token already contains projectId, we need to generate a session-specific preview token
const previewToken = searchParams.get('previewToken'); // Pass from share validation
```

**Changes to sdk-handler.ts**:

```typescript
// REMOVE the dev mode bypass:
// if (isDev && apiKey.startsWith('pk_demo')) { ... }

// REPLACE with explicit preview token validation:
async function validateApiKeyOrPreviewToken(
  apiKey: string,
  projectId: string,
): Promise<ValidationResult> {
  // 1. Check if it's a preview token (starts with eyJ - base64 JSON)
  if (apiKey.startsWith('eyJ')) {
    const payload = verifyPreviewToken(apiKey);
    if (payload && payload.projectId === projectId) {
      return {
        valid: true,
        keyId: `preview:${payload.userId}`,
        permissions: payload.permissions,
        isPreview: true,
      };
    }
    return { valid: false, reason: 'Invalid preview token' };
  }

  // 2. Validate as regular API key (existing logic)
  return validatePublicApiKey(apiKey, projectId);
}
```

---

### 1.2 Fix Environment Variable Configuration

**Problem**: Multiple env vars with different names, empty values, and inconsistent handling.

**Solution - Create Unified Config**:

```typescript
// NEW: apps/studio/src/config/runtime.ts
export interface RuntimeConfig {
  apiUrl: string; // HTTP API base URL
  wsUrl: string; // WebSocket base URL
  sdkWsUrl: string; // SDK WebSocket endpoint
}

export function getRuntimeConfig(): RuntimeConfig {
  const baseUrl = process.env.NEXT_PUBLIC_RUNTIME_URL || 'http://localhost:3112';
  const wsProtocol = baseUrl.startsWith('https') ? 'wss' : 'ws';
  const wsHost = baseUrl.replace(/^https?:\/\//, '');

  return {
    apiUrl: baseUrl,
    wsUrl: `${wsProtocol}://${wsHost}/ws`,
    sdkWsUrl: `${wsProtocol}://${wsHost}/ws/sdk`,
  };
}

// Validate at startup
export function validateRuntimeConfig(): void {
  const config = getRuntimeConfig();

  if (!config.apiUrl) {
    throw new Error('NEXT_PUBLIC_RUNTIME_URL is required');
  }

  // Validate URL format
  try {
    new URL(config.apiUrl);
  } catch {
    throw new Error(`Invalid NEXT_PUBLIC_RUNTIME_URL: ${config.apiUrl}`);
  }
}
```

**Update .env.example**:

```bash
# Runtime Connection (REQUIRED)
# Only set the base URL - SDK derives WebSocket URLs automatically
NEXT_PUBLIC_RUNTIME_URL=http://localhost:3112

# REMOVE these confusing alternatives:
# NEXT_PUBLIC_API_URL=          # DELETE - use NEXT_PUBLIC_RUNTIME_URL
# NEXT_PUBLIC_RUNTIME_WS_URL=   # DELETE - derived from RUNTIME_URL
# RUNTIME_URL=                  # DELETE - use NEXT_PUBLIC_RUNTIME_URL
```

**Update preview pages to use unified config**:

```typescript
// apps/studio/src/app/preview/page.tsx
import { getRuntimeConfig } from '@/config/runtime';

// REPLACE lines 148-153 with:
const { sdkWsUrl } = getRuntimeConfig();
const url = `${sdkWsUrl}?projectId=${encodeURIComponent(validation.projectId)}&token=${encodeURIComponent(previewToken)}`;
```

---

### 1.3 Remove Secrets from .env Files

**Problem**: API keys, JWT secrets, and credentials committed to git.

**Solution**:

1. **Create .env.example with placeholder values**:

```bash
# apps/studio/.env.example
JWT_SECRET=generate-with-openssl-rand-base64-64
ENCRYPTION_MASTER_KEY=generate-with-openssl-rand-base64-32
NEXTAUTH_SECRET=generate-with-openssl-rand-base64-32

# External Services (get from provider dashboards)
ANTHROPIC_API_KEY=sk-ant-...
DEEPGRAM_API_KEY=...
ELEVENLABS_API_KEY=...
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
```

2. **Add .env to .gitignore** (if not already):

```gitignore
# Environment files with secrets
.env
.env.local
.env.*.local
```

3. **Rotate all exposed credentials**:

- Generate new JWT_SECRET: `openssl rand -base64 64`
- Rotate Anthropic API key in dashboard
- Rotate Twilio credentials in dashboard
- Rotate any other exposed keys

---

## Priority 2: HIGH - Fix This Week

### 2.1 Fix Database Initialization Race Condition

**Problem**: `getDB()` is not properly async, causing race conditions.

**Solution**:

```typescript
// apps/studio/src/lib/db.ts - REWRITE
import { PrismaClient } from '@prisma/client';

let prisma: PrismaClient | null = null;
let initPromise: Promise<PrismaClient> | null = null;

async function initializeDatabase(): Promise<PrismaClient> {
  if (prisma) return prisma;

  prisma = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

  // Test connection
  await prisma.$connect();

  return prisma;
}

export async function getDB(): Promise<PrismaClient> {
  // Use singleton promise to prevent race conditions
  if (!initPromise) {
    initPromise = initializeDatabase().catch((err) => {
      initPromise = null; // Reset on failure to allow retry
      throw err;
    });
  }
  return initPromise;
}

// For cleanup on shutdown
export async function disconnectDB(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
    initPromise = null;
  }
}
```

**Update all API routes to await getDB()**:

```typescript
// apps/studio/src/app/api/auth/me/route.ts
export async function GET(request: NextRequest) {
  await getDB(); // Now properly async
  const result = await requireAuth(request);
  // ...
}
```

---

### 2.2 Add Access Token Revocation

**Problem**: Access tokens cannot be revoked; deleted/logged-out users remain authenticated.

**Solution - Add Token Blacklist**:

```typescript
// apps/studio/src/services/token-blacklist.ts
import { getDB } from '@/lib/db';

// In-memory cache with TTL (for performance)
const blacklistCache = new Map<string, number>(); // token -> expiry timestamp
const CACHE_CLEANUP_INTERVAL = 60000; // 1 minute

// Cleanup expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [token, expiry] of blacklistCache) {
    if (expiry < now) {
      blacklistCache.delete(token);
    }
  }
}, CACHE_CLEANUP_INTERVAL);

export async function revokeAccessToken(tokenOrJti: string): Promise<void> {
  const db = await getDB();

  // Store in database for persistence
  await db.revokedToken.create({
    data: {
      token: tokenOrJti,
      revokedAt: new Date(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000), // Access token TTL
    },
  });

  // Also cache in memory
  blacklistCache.set(tokenOrJti, Date.now() + 15 * 60 * 1000);
}

export async function isTokenRevoked(tokenOrJti: string): Promise<boolean> {
  // Check memory cache first
  const cachedExpiry = blacklistCache.get(tokenOrJti);
  if (cachedExpiry) {
    return cachedExpiry > Date.now();
  }

  // Check database
  const db = await getDB();
  const revoked = await db.revokedToken.findUnique({
    where: { token: tokenOrJti },
  });

  if (revoked && revoked.expiresAt > new Date()) {
    // Cache for future lookups
    blacklistCache.set(tokenOrJti, revoked.expiresAt.getTime());
    return true;
  }

  return false;
}
```

**Add to Prisma schema**:

```prisma
model RevokedToken {
  id        String   @id @default(cuid())
  token     String   @unique
  revokedAt DateTime @default(now())
  expiresAt DateTime

  @@index([expiresAt])
}
```

**Update auth verification**:

```typescript
// apps/studio/src/services/auth-service.ts
export async function verifyAccessToken(token: string): Promise<JWTPayload | null> {
  const { secret } = getJWTConfig();
  try {
    const payload = jwt.verify(token, secret) as JWTPayload;
    if (payload.type !== 'access') return null;

    // NEW: Check if token is revoked
    const jti = payload.jti || token.slice(-16); // Use jti or last 16 chars
    if (await isTokenRevoked(jti)) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
```

---

### 2.3 Use Relative Database Paths

**Problem**: Absolute paths in DATABASE_URL won't work across machines or in containers.

**Solution**:

```bash
# apps/studio/.env
DATABASE_URL=file:../data/agent-platform.db

# apps/runtime/.env
DATABASE_URL=file:../data/agent-platform.db
```

**Or better - use environment-specific paths**:

```typescript
// packages/database/src/index.ts
export function getDatabaseUrl(): string {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  // Default based on environment
  const env = process.env.NODE_ENV || 'development';
  const dataDir = process.env.DATA_DIR || './data';

  switch (env) {
    case 'production':
      return process.env.DATABASE_URL!; // Required in prod
    case 'test':
      return `file:${dataDir}/test.db`;
    default:
      return `file:${dataDir}/dev.db`;
  }
}
```

---

## Priority 3: MEDIUM - Fix This Sprint

### 3.1 Improve Error Handling in Preview Pages

**Problem**: Errors are swallowed silently, users don't know why things fail.

**Solution - Add Error States**:

```typescript
// apps/studio/src/app/preview/page.tsx

// Add error state
const [connectionError, setConnectionError] = useState<{
  code: string;
  message: string;
  recoverable: boolean;
} | null>(null);

// Update config fetch error handling
useEffect(() => {
  const fetchConfig = async () => {
    try {
      const res = await fetch(`/api/sdk/share?token=${token}`);
      if (!res.ok) {
        const error = await res.json();
        setConnectionError({
          code: 'CONFIG_FETCH_FAILED',
          message: error.error || 'Failed to load configuration',
          recoverable: false,
        });
        return;
      }
      // ...
    } catch (err) {
      setConnectionError({
        code: 'NETWORK_ERROR',
        message: 'Cannot connect to server. Check if the runtime is running.',
        recoverable: true,
      });
    }
  };
  fetchConfig();
}, [token]);

// Update WebSocket error handling
ws.onerror = (event) => {
  setConnectionError({
    code: 'WEBSOCKET_ERROR',
    message: 'Lost connection to agent. Attempting to reconnect...',
    recoverable: true,
  });
  setIsConnected(false);
};

ws.onclose = (event) => {
  if (event.code !== 1000) { // Not a normal close
    setConnectionError({
      code: `WS_CLOSE_${event.code}`,
      message: event.reason || 'Connection closed unexpectedly',
      recoverable: event.code !== 1008, // Policy violation not recoverable
    });
  }
  setIsConnected(false);
};

// Render error state
if (connectionError) {
  return (
    <div className="...error-styles...">
      <AlertCircle className="w-8 h-8 text-red-400" />
      <h2>Connection Error</h2>
      <p>{connectionError.message}</p>
      <code className="text-xs text-gray-500">{connectionError.code}</code>
      {connectionError.recoverable && (
        <button onClick={() => window.location.reload()}>
          Retry
        </button>
      )}
    </div>
  );
}
```

---

### 3.2 Unify SDK Validation Logic

**Problem**: Three different validation paths in sdk-handler.ts create inconsistent behavior.

**Solution - Single Validation Function**:

```typescript
// apps/runtime/src/websocket/sdk-validation.ts

export interface ValidationResult {
  valid: boolean;
  keyId?: string;
  permissions?: { chat: boolean; voice: boolean };
  reason?: string;
  source?: 'api_key' | 'preview_token' | 'dev_mode';
}

export async function validateSDKAccess(
  credential: string,
  projectId: string,
  options: {
    allowDevMode?: boolean;
    requireDatabase?: boolean;
  } = {},
): Promise<ValidationResult> {
  const { allowDevMode = false, requireDatabase = true } = options;

  // 1. Preview token (base64 JSON format)
  if (credential.startsWith('eyJ')) {
    const payload = verifyPreviewToken(credential);
    if (!payload) {
      return { valid: false, reason: 'Invalid or expired preview token' };
    }
    if (payload.projectId !== projectId) {
      return { valid: false, reason: 'Preview token project mismatch' };
    }
    return {
      valid: true,
      keyId: `preview:${payload.userId}`,
      permissions: payload.permissions,
      source: 'preview_token',
    };
  }

  // 2. Public API key (pk_ prefix)
  if (!credential.startsWith('pk_')) {
    return { valid: false, reason: 'Invalid credential format' };
  }

  // 3. Check database
  if (!isDatabaseAvailable()) {
    if (requireDatabase) {
      return { valid: false, reason: 'Database unavailable' };
    }
    // Dev fallback only if explicitly allowed
    if (allowDevMode && process.env.NODE_ENV === 'development') {
      log.warn('Using dev mode API key validation - database unavailable');
      return {
        valid: true,
        keyId: 'dev-fallback',
        permissions: { chat: true, voice: true },
        source: 'dev_mode',
      };
    }
    return { valid: false, reason: 'Database required for API key validation' };
  }

  // 4. Validate against database
  try {
    const prisma = requirePrisma();
    const keyHash = createHash('sha256').update(credential).digest('hex');

    const publicKey = await prisma.publicApiKey.findFirst({
      where: {
        keyHash,
        projectId,
        isActive: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });

    if (!publicKey) {
      return { valid: false, reason: 'API key not found or expired' };
    }

    // Update last used timestamp (fire and forget)
    prisma.publicApiKey
      .update({
        where: { id: publicKey.id },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => {}); // Ignore errors

    return {
      valid: true,
      keyId: publicKey.id,
      permissions: publicKey.permissions as { chat: boolean; voice: boolean },
      source: 'api_key',
    };
  } catch (err) {
    log.error('API key validation error', { err });
    return { valid: false, reason: 'Validation error' };
  }
}
```

---

### 3.3 Add Startup Validation

**Problem**: Misconfigurations only discovered at runtime when things fail.

**Solution - Validate on Startup**:

```typescript
// apps/studio/src/lib/startup-checks.ts

export async function runStartupChecks(): Promise<void> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Required environment variables
  const requiredEnvVars = ['DATABASE_URL', 'JWT_SECRET', 'NEXT_PUBLIC_RUNTIME_URL'];

  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      errors.push(`Missing required environment variable: ${envVar}`);
    }
  }

  // 2. Validate URL formats
  const urlEnvVars = ['NEXT_PUBLIC_RUNTIME_URL', 'NEXT_PUBLIC_API_URL'];
  for (const envVar of urlEnvVars) {
    const value = process.env[envVar];
    if (value) {
      try {
        new URL(value);
      } catch {
        errors.push(`Invalid URL in ${envVar}: ${value}`);
      }
    }
  }

  // 3. Check database connection
  try {
    const db = await getDB();
    await db.$queryRaw`SELECT 1`;
  } catch (err) {
    errors.push(`Database connection failed: ${err}`);
  }

  // 4. Check runtime connectivity (warning only)
  try {
    const runtimeUrl = process.env.NEXT_PUBLIC_RUNTIME_URL || 'http://localhost:3112';
    const res = await fetch(`${runtimeUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      warnings.push(`Runtime health check failed: ${res.status}`);
    }
  } catch {
    warnings.push('Runtime not reachable (may be normal if starting separately)');
  }

  // 5. Check for dev secrets in production
  if (process.env.NODE_ENV === 'production') {
    if (process.env.JWT_SECRET?.includes('dev-jwt-secret')) {
      errors.push('Using dev JWT secret in production!');
    }
  }

  // Report results
  if (warnings.length > 0) {
    console.warn('Startup warnings:', warnings);
  }

  if (errors.length > 0) {
    console.error('Startup errors:', errors);
    throw new Error(`Startup checks failed:\n${errors.join('\n')}`);
  }

  console.log('All startup checks passed');
}
```

**Add to instrumentation.ts (Next.js)**:

```typescript
// apps/studio/src/instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { runStartupChecks } = await import('./lib/startup-checks');
    await runStartupChecks();
  }
}
```

---

## Priority 4: LOW - Backlog

### 4.1 Replace Custom Share Token with Standard JWT

Use `jsonwebtoken` library instead of custom HMAC implementation.

### 4.2 Add Structured Logging

Replace `console.log` with structured logger (pino/winston) for better debugging.

### 4.3 Add Health Check Endpoints

Add `/health` and `/ready` endpoints to studio for orchestration.

### 4.4 Add Integration Tests

Test preview flow end-to-end with mocked runtime.

---

## Migration Checklist

### Phase 1: Critical Fixes (Day 1-2)

- [ ] Generate new secrets, update .env files
- [ ] Add .env to .gitignore
- [ ] Rotate all exposed API keys
- [ ] Create unified runtime config module
- [ ] Update preview pages to use unified config

### Phase 2: High Priority (Day 3-5)

- [ ] Rewrite db.ts with proper async init
- [ ] Add RevokedToken model to schema
- [ ] Implement token blacklist service
- [ ] Update all API routes to await getDB()
- [ ] Switch to relative database paths

### Phase 3: Medium Priority (Week 2)

- [ ] Add error states to preview pages
- [ ] Unify SDK validation logic
- [ ] Add startup validation checks
- [ ] Remove hardcoded demo API key
- [ ] Implement preview token system

### Phase 4: Polish (Week 3)

- [ ] Add structured logging
- [ ] Add health check endpoints
- [ ] Write integration tests
- [ ] Update documentation

---

## Testing the Fixes

After each phase, run these verification steps:

```bash
# 1. Start fresh (clean state)
rm -rf apps/data/*.db
pnpm prisma:push

# 2. Start services
pnpm --filter @agent-platform/runtime dev &
pnpm --filter @agent-platform/studio dev &

# 3. Test auth flow
curl http://localhost:5173/api/auth/me  # Should return 401

# 4. Test preview flow
# Login via UI, create project, generate share link, open in incognito

# 5. Test error handling
# Stop runtime, try preview - should show clear error
# Start runtime - should recover

# 6. Test token revocation
# Login, get token, logout, use old token - should fail
```

---

## Summary

The root causes of recurring breakage are:

1. **Configuration fragility** - Multiple env vars, hardcoded values, no validation
2. **Silent failures** - Errors swallowed, fallbacks hide problems
3. **Inconsistent validation** - Multiple code paths for same logic
4. **Missing lifecycle management** - No startup checks, no graceful degradation

This refactoring plan addresses all 13 identified issues systematically, with clear priority ordering and migration steps.

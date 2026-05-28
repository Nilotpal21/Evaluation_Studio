# User Identity & Session Management Across Channels

> Design specification for end-user identity resolution, cross-channel session continuity, impersonation prevention, and storage architecture at scale.

---

## 1. Problem Statement

The platform needs to handle conversations with end-users (customers) across multiple channels — web chat, voice, SMS, WhatsApp, email, Facebook Messenger, MS Teams, API. These users may be anonymous, partially identified, or fully authenticated. The system must:

- Resolve whether an inbound message belongs to an existing session or requires a new one
- Do so without requiring authentication (most customer service volume is anonymous)
- Prevent impersonation when identity claims are made
- Support identity linking when a user appears on multiple channels
- Scale to hundreds of millions of sessions per day

### Key Constraint

In customer service deployments, anonymous users are the **majority**, not the exception. A caller dials a number. A visitor opens a chat widget. No login, no account, no identity. The system must treat this as the default fast path, not a degraded fallback.

---

## 2. Current State

### What Exists

**Session model** (`packages/database/src/models/session.model.ts`) has the right fields but incomplete wiring:

| Field            | DB Session     | Runtime Session      | Reliably Set?                   |
| ---------------- | -------------- | -------------------- | ------------------------------- |
| `tenantId`       | Yes            | Yes                  | Yes — enforced on every query   |
| `customerId`     | Yes (nullable) | No                   | No — rarely populated           |
| `anonymousId`    | Yes (nullable) | No                   | No — rarely populated           |
| `initiatedById`  | Yes (nullable) | No                   | Partially — studio users only   |
| `contactId`      | Yes (nullable) | No                   | No — never written              |
| `callerNumber`   | Yes (nullable) | No                   | No — voice only, partial        |
| `channel`        | Yes (enum)     | No (in `dataValues`) | Yes at creation, not propagated |
| `channelHistory` | Yes (array)    | No                   | No — never written              |

**Channel system** — channels are configuration objects (deployment binding, widget config), not identity containers. SDK channels support `web`, `mobile_ios`, `mobile_android`, `voice`, `api`. Messaging channels (`email`, `sms`, `whatsapp`, `facebook`, `ms_teams`) exist in lifecycle config but not as SDK channel types.

**Authentication** — three separate flows with no unified identity:

| Path                    | Identity Source                 | Verified?                             |
| ----------------------- | ------------------------------- | ------------------------------------- |
| User JWT (studio/debug) | `userId` from DB                | Yes                                   |
| SDK session token       | `userContext.userId` (optional) | **No — caller-supplied, unvalidated** |
| API key                 | `apiKeyId` + `clientId`         | Yes                                   |
| A2A protocol            | None                            | **No auth enforced**                  |

**Tenant isolation** — strong. Every DB query filters by `tenantId`. Cross-tenant access blocked at middleware.

### What's Missing

1. **No end-user entity.** No `Contact` or `EndUser` model. The platform knows who built the agent (`User`) but not who talks to it.
2. **No session continuity.** Every SDK connection creates a new session. No "find existing session for this user on this channel."
3. **No impersonation prevention for SDK.** `userContext.userId` is trust-the-client. Anyone with the public API key can claim any identity.
4. **No identity linking.** No mechanism to connect the same person across `email`, `phone`, `facebookId`, `msTeamsId`.
5. **No unified CallerContext.** Identity fields scattered across session model, runtime session, and request context.
6. **Redis won't hold at target scale.** Current per-session Redis footprint (~400-500 KB including traces and conversation history) makes 10M+ concurrent sessions infeasible without architectural changes.

---

## 3. Identity Model: Three Tiers

The system uses a tiered identity model. Anonymous users stay in the cheapest tier. Identity upgrades happen non-blocking within a conversation or across conversations.

```
Tier 0: Ephemeral
  No identity artifact. Session-scoped only. No resume possible.
  Widget opens with blocked cookies, suppressed caller ID.
  Nothing stored beyond the session itself.

        │ user returns with same cookie / calls from same number
        ▼

Tier 1: Channel-Bound
  Identified by channel artifact (caller ID, cookie, device fingerprint).
  Session resume within same channel. No Contact record.
  Artifact stored directly on the session.
  Bulk of customer service volume lives here.

        │ user provides account number / authenticates / clicks verify link
        ▼

Tier 2: Contact-Linked
  Verified identity (HMAC, OTP, provider-verified).
  Contact record created or linked on demand.
  Cross-channel session history available.
  Contact merge triggered if identities overlap.
```

### Why Not Contact-First

If every inbound interaction creates a Contact record:

- 200M sessions/day generates 200M Contact records, 90%+ single-use
- Session resolution requires a DB join on every message (contact → active session)
- Contact merge becomes intractable at scale
- Storage and index bloat on a table that's mostly garbage

**The design is session-first, contact-optional.** Contact records are created only when a verified identity exists — keeping the Contact table small and high-value.

---

## 4. Channel Artifacts

Each channel has a natural "return visitor" signal that doesn't require a Contact record:

| Channel      | Artifact                             | Artifact Type  | Durability | Trust Level |
| ------------ | ------------------------------------ | -------------- | ---------- | ----------- |
| Web chat     | Session cookie / SDK token           | `cookie`       | Hours–days | Low         |
| Mobile app   | Device ID                            | `device_id`    | Permanent  | Medium      |
| Voice (PSTN) | Caller ID (ANI)                      | `caller_id`    | Permanent  | Medium      |
| Voice (SIP)  | SIP URI                              | `sip_uri`      | Permanent  | Medium      |
| SMS          | Phone number (from provider webhook) | `phone`        | Permanent  | High        |
| WhatsApp     | Phone number (from webhook)          | `phone`        | Permanent  | High        |
| Facebook     | PSID (page-scoped user ID)           | `psid`         | Permanent  | High        |
| MS Teams     | AAD object ID (from Bot Framework)   | `aad_id`       | Permanent  | High        |
| Email        | From address + thread ID             | `email_thread` | Per-thread | Medium      |
| API          | API key client ID                    | `api_client`   | Permanent  | High        |

### Artifact Rules

- Artifacts are **hashed before storage** (SHA-256) — no raw phone numbers or emails in session indexes
- Artifact source is always the **platform or provider**, never the end-user (except web cookies)
- Web cookies are the weakest artifact — treated as a hint, not a guarantee
- Provider-sourced artifacts (carrier phone number, Facebook PSID) carry inherent verification

---

## 5. Session Resolution

### Resolution Flow

When a message arrives at any channel entry point:

```
Inbound message
  │
  ├─ Has explicit sessionId? ──────────────→ Resume session (fastest path)
  │   (cookie, header, query param)          Redis GET sess:{id} → O(1)
  │
  ├─ Has channel artifact? ────────────────→ Channel-scoped session lookup
  │   (caller ID, cookie hash, PSID)         Redis GET resolve:{tenant}:{channel}:{hash}
  │   │                                       → O(1), no Contact table hit
  │   ├─ Active session found?
  │   │   ├─ Within resume window? ────────→ Resume session
  │   │   └─ Expired? ────────────────────→ Create new session, same artifact
  │   └─ No session found? ───────────────→ Create new session (tier 1)
  │
  ├─ Has verified identity? ───────────────→ Contact lookup → session lookup
  │   (HMAC userId, OAuth, provider token)    MongoDB: Contact by identity
  │   │                                       Redis: resolve by contactId
  │   ├─ Contact + active session? ────────→ Resume session
  │   └─ No Contact? ─────────────────────→ Create Contact + new session (tier 2)
  │
  └─ Nothing? ─────────────────────────────→ New ephemeral session (tier 0)
```

### Resolution Configuration

Configurable per channel via `SDKChannel.config.sessionResolution`:

```typescript
interface SessionResolutionConfig {
  /** How to resolve returning users */
  strategy: 'channel_artifact' | 'contact_required' | 'always_new';

  /** Channel-specific artifact type */
  artifactType:
    | 'caller_id'
    | 'cookie'
    | 'device_id'
    | 'psid'
    | 'aad_id'
    | 'phone'
    | 'email_thread'
    | 'api_client';

  /** How long an idle session can be resumed */
  resumeWindowSeconds: number; // e.g., 7200 for voice, 86400 for web

  /** Max concurrent active sessions per artifact per channel */
  maxActiveSessions: number; // typically 1

  /** When to promote identity tier */
  promotionTrigger: 'manual' | 'auto_on_gather' | 'disabled';
}
```

Example configurations:

| Use Case                       | Strategy           | Resume Window | Why                                |
| ------------------------------ | ------------------ | ------------- | ---------------------------------- |
| Voice IVR                      | `channel_artifact` | 2 hours       | Caller hangs up, calls back        |
| Web chat (anonymous)           | `channel_artifact` | 24 hours      | User refreshes page                |
| Web chat (logged-in customers) | `contact_required` | 7 days        | Known users, cross-session history |
| Marketing landing page         | `always_new`       | N/A           | Every visit is independent         |
| SMS support                    | `channel_artifact` | 72 hours      | Async conversation, long gaps      |
| API integration                | `always_new`       | N/A           | Each API call is stateless         |

---

## 6. Session Schema Changes

### New Fields on Session (MongoDB)

```typescript
// Added to ISession interface
interface ISession {
  // ... existing fields ...

  /** Hashed channel artifact for session resolution (SHA-256) */
  channelArtifact?: string;

  /** Type of artifact: 'caller_id' | 'cookie' | 'psid' | 'aad_id' | 'phone' | ... */
  channelArtifactType?: string;

  /** Identity tier: 0 = ephemeral, 1 = channel-bound, 2 = contact-linked */
  identityTier: 0 | 1 | 2;

  /** Contact record ID (null for tier 0 & 1, set on tier 2) */
  contactId?: string;

  /** How the identity was verified */
  verificationMethod?: 'none' | 'cookie' | 'caller_id' | 'hmac' | 'otp' | 'oauth' | 'provider';

  /** SDK channel config ID (already partially wired) */
  channelId?: string;
}
```

### New Index

```
// Session resolution: find active session by channel artifact
{ tenantId: 1, channelId: 1, channelArtifact: 1, status: 1 }
  WHERE status IN ['active', 'idle']

// Contact session history: find sessions for a contact
{ tenantId: 1, contactId: 1, startedAt: -1 }
  WHERE contactId IS NOT NULL
```

### CallerContext (Runtime)

A unified type carried on every runtime session:

```typescript
interface CallerContext {
  tenantId: string;
  contactId?: string; // Resolved Contact (tier 2 only)
  channelArtifact?: string; // Hashed artifact
  channelArtifactType?: string; // Type of artifact
  anonymousId?: string; // Fingerprint/cookie hash for unidentified
  customerId?: string; // Customer-supplied external ID (HMAC-verified)
  channel: ChannelType; // Current channel
  channelId: string; // SDK channel config ID
  initiatedById?: string; // Platform user who started (studio/debug only)
  identityTier: 0 | 1 | 2;
  verificationMethod: string;
  sourceIp?: string;
  userAgent?: string;
}
```

Set at session creation from the edge layer (WebSocket auth, SDK auth, REST auth). Stored on both runtime and DB sessions. Propagated to tool execution and trace events.

---

## 7. Contact Model

Created only for tier 2 (verified identity) users. Kept small and high-value.

```typescript
interface IContact {
  _id: string; // UUID v7
  tenantId: string; // Tenant scope
  projectId?: string; // Optional project scope (or tenant-global)

  /** Verified identities from different channels */
  identities: ContactIdentity[];

  /** Merged profile */
  displayName?: string;
  avatarUrl?: string;
  customAttributes: Record<string, unknown>;

  /** Lifecycle */
  firstSeenAt: Date;
  lastSeenAt: Date;
  sessionCount: number;
  tags: string[];

  /** Merge tracking */
  mergedFrom?: string[]; // IDs of contacts merged into this one
  mergedInto?: string; // If this contact was merged away
}

interface ContactIdentity {
  provider: string; // 'email' | 'phone' | 'facebook' | 'ms_teams' | 'custom' | ...
  value: string; // Hashed for PII-sensitive providers
  valuePlain?: string; // Encrypted original (for display only, optional)
  verified: boolean;
  verifiedAt?: Date;
  verifiedVia: string; // 'hmac' | 'otp' | 'provider' | 'email_link' | 'manual'
  channelId?: string; // Channel where identity was first seen
  lastSeenAt: Date;
}
```

### Indexes

```
// Identity lookup: find contact by provider+value within tenant
{ tenantId: 1, 'identities.provider': 1, 'identities.value': 1 }
  UNIQUE

// Merge target resolution
{ mergedInto: 1 }
  WHERE mergedInto IS NOT NULL
```

### Volume Estimate

At 200M sessions/day with 10% tier 2 promotion:

- ~20M contact lookups/day (on promotion)
- ~5M new contacts/day (deduplicated by identity)
- Contact table grows ~150M/month, stabilizes as returning users dominate
- Small compared to session volume — standard MongoDB handles this

---

## 8. Impersonation Prevention

### SDK HMAC Verification

The critical vulnerability: SDK `userContext.userId` is caller-supplied and unvalidated. Anyone with the public API key (visible in browser source) can claim any identity.

**Solution: HMAC-based identity verification.**

The customer's backend (which holds a secret key) signs identity claims. The platform verifies the signature before trusting the identity.

```
Customer's Backend                   Platform SDK Init
─────────────────                    ──────────────────

1. User authenticates
   to customer's app

2. Generate HMAC:
   payload = userId + timestamp
   hmac = HMAC-SHA256(payload,
     channel_secret_key)

3. Pass to frontend:                 4. POST /api/v1/sdk/init
   { userId, hmac, timestamp }          X-Public-Key: pk_*
                                        {
                                          userContext: {
                                            userId: "user_123",
                                            hmac: "a1b2c3...",
                                            timestamp: 1708000000
                                          }
                                        }

                                     5. Platform verifies:
                                        expected = HMAC-SHA256(
                                          userId + timestamp,
                                          stored_secret_key
                                        )
                                        if hmac !== expected → 401
                                        if now - timestamp > 300s → 401

                                     6. Token issued with
                                        verificationMethod: 'hmac'
                                        identityTier: 2
```

### Enforcement Modes

Configured per channel:

| Mode       | Behavior                                          | Use Case                            |
| ---------- | ------------------------------------------------- | ----------------------------------- |
| `disabled` | Accept any `userId` claim (current behavior)      | Development, internal tools         |
| `optional` | Verify HMAC if present, accept unsigned as tier 1 | Gradual rollout                     |
| `required` | Reject unsigned `userId` claims                   | Production with authenticated users |

When a channel has a `secretKey` configured and mode is `required`:

- Unsigned `userContext.userId` → rejected with error
- Missing `userContext` entirely → allowed as anonymous (tier 0/1)
- Valid HMAC → tier 2 with `verificationMethod: 'hmac'`

### Session Ownership Enforcement

Once a session is bound to an identity:

- **Tier 1**: Only the same `channelArtifact` can resume the session
- **Tier 2**: Only the same `contactId` can resume the session (regardless of channel artifact)
- **Tier 0**: Only the holder of the `sessionId` token can continue

Cross-tier escalation (anonymous → HMAC) is allowed within a session. Downgrade (HMAC → anonymous) is not.

### Rate Limiting

Per-identity protections against enumeration and abuse:

```
Rate limit: session creation per channel artifact
  - Max 10 new sessions per artifact per hour
  - Prevents rapid session creation to probe for data

Rate limit: identity verification attempts
  - Max 5 verification attempts per session
  - Prevents brute-forcing HMAC or OTP codes

Rate limit: SDK init per public key
  - Max 1000 inits per minute per key
  - Prevents key abuse at scale
```

---

## 9. Identity Verification Flows

### 9a. Email Verification

The agent collects an email address, the platform sends a verification link, and the user clicks it — possibly on a different device, possibly after the session ends.

```
Chat Session                     Email Provider              Verify Endpoint
────────────                     ──────────────              ───────────────
     │
Agent: "What's your email?"
     │
User: "alice@example.com"
     │
┌────┴──────────────────┐
│ on_set hook fires      │
│                        │
│ Generate token:        │
│  JWT({                 │
│    sessionId,          │
│    tenantId,           │
│    email,              │
│    purpose: 'verify',  │
│    exp: 24h            │
│  })                    │
│                        │
│ Store in Redis:        │
│  vtoken:{hash}         │
│  → { sessionId,        │────────► Send email via
│    email,              │          configured provider
│    status: 'pending' } │          (SendGrid, SES, etc.)
│  TTL: 24h              │
└────┬──────────────────┘
     │                            │
Agent: "I've sent a               │   Email body:
 verification link to             │   "Click to verify"
 alice@example.com"               │   https://platform/verify/{token}
     │                            │
(session continues                │
 or user disconnects)             │
     ·                            ·
     ·                            ·
     │                            │  User clicks link
     │                            │        │
     │                            │        ▼
     │                            │  GET /verify/{token}
     │                            │
     │                            │  1. Decode JWT, check sig + expiry
     │                            │  2. Redis GET vtoken:{hash}
     │                            │     - Not found → "Link expired"
     │                            │     - status != pending → "Already used"
     │                            │     - attempts > 5 → "Too many attempts"
     │                            │  3. SET status = 'verified'
     │                            │  4. Find/create Contact by email
     │                            │  5. Update session:
     │                            │     contactId, identityTier = 2
     │                            │  6. PUBLISH identity_verified event
     │                            │  7. Render confirmation page
     │                            │
     │◄─────────────────────────────── (if session still connected)
     │  WebSocket push: identity_verified
     │
Agent: "Your email is verified.
 Let me pull up your account."
```

**Redis state for verification tokens:**

```
Key:    vtoken:{sha256(jwt)}
Value:  {
          sessionId: "sess_abc123",
          tenantId: "tenant_xyz",
          identityType: "email",
          identityValue: "sha256(alice@example.com)",
          status: "pending",
          attempts: 0,
          createdAt: 1708000000000
        }
TTL:    86400 (24h)
```

No MongoDB write for pending verifications. If the user never clicks, the Redis key expires silently. Contact record created only on successful verification.

### 9b. Phone/SMS OTP Verification

For voice and SMS channels, OTP is simpler because the user stays in-channel:

```
Agent: "To verify your identity, I'll send a code to your phone."

Platform sends SMS: "Your code is 483921"

Agent: "What's the 6-digit code?"
User: "483921"

Platform: verify OTP → promote to tier 2
Agent: "Verified. Let me pull up your account."
```

**OTP Redis state:**

```
Key:    otp:{sessionId}:{identityType}
Value:  { code: "483921", identityValue: "sha256(+1234567890)", attempts: 0 }
TTL:    300 (5 minutes)
```

Max 3 attempts. On failure, generate new code. On success, delete key and promote tier.

### 9c. Provider-Verified Identities

For channels where the provider guarantees identity (Facebook, MS Teams, WhatsApp, SMS inbound):

```
WhatsApp webhook delivers message:
  from: "+1234567890" (carrier-verified)
  message: "Hi, I need help with my order"

Platform:
  artifact = sha256("+1234567890")
  artifactType = "phone"
  verificationMethod = "provider"

  → Automatically tier 1 (channel-bound, provider-verified artifact)
  → Optionally auto-promote to tier 2 if Contact with this phone exists
```

No verification flow needed — the provider already verified the identity. The `verificationMethod: 'provider'` distinguishes this from self-claimed identities.

### 9d. ABL DSL Integration

Verification is exposed as a platform-provided action in the agent DSL:

```yaml
collect:
  email:
    type: email
    prompt: "What's your email address?"
    on_set:
      - verify_identity:
          type: email
          value: $email
          method: link # 'link' or 'otp'
          on_verified:
            - set: identity_verified = true
            - transition: authenticated_flow
          on_timeout: # optional: if not verified within window
            - respond: "I haven't received your verification yet."

  phone:
    type: phone
    prompt: "What's your phone number?"
    on_set:
      - verify_identity:
          type: phone
          value: $phone
          method: otp
          on_verified:
            - set: phone_verified = true
```

The runtime handles `verify_identity` as a platform action — generating tokens, sending emails/SMS, registering callbacks. The agent DSL declares intent; the platform handles mechanics.

---

## 10. Tier Promotion & Contact Linking

### Promotion Within a Session

When an anonymous user identifies themselves mid-conversation:

```
1. User is chatting (tier 0 or 1, no Contact)
2. Agent collects email/phone/account number
3. Verification succeeds (HMAC, OTP, email link, or provider)
4. Platform promotes session:
   a. identityTier → 2
   b. verificationMethod → 'hmac' | 'otp' | 'email_link' | 'provider'
   c. Find or create Contact by (tenantId, identityType, identityValue)
   d. Set contactId on session
   e. Emit trace event: identity_promoted { from: 1, to: 2, method: 'otp' }
5. Back-link previous sessions with same channelArtifact to Contact (async)
```

Step 5 is **non-blocking and background** — the conversation doesn't pause. A BullMQ job scans for recent sessions with the same `channelArtifact` and links them to the newly created Contact.

### Contact Merge Across Channels

When a verified identity matches an existing Contact:

```
Scenario:
  Contact A: { identities: [{ provider: 'phone', value: '+1234567890' }] }
  Contact B: { identities: [{ provider: 'email', value: 'alice@example.com' }] }

User provides email in a phone call → both identities now known for same person.

Merge rules:
  1. Both identities must be verified (no merging unverified claims)
  2. Both contacts must be in the same tenant
  3. Keep the older Contact as primary (lower _id)
  4. Move all identities from secondary to primary
  5. Update all sessions with secondary contactId → primary contactId
  6. Set secondary.mergedInto = primary._id
  7. Emit audit event: contact_merged { primary, secondary, trigger }
```

Merge is triggered by **identity overlap detection** — when a tier 2 promotion would create a Contact with an identity that already exists on a different Contact. This is an async background operation, not on the message hot path.

### Merge Conflict Resolution

| Conflict                                           | Resolution                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| Same identity on two contacts (both verified)      | Auto-merge (same person, different channels)                       |
| Same identity on two contacts (one unverified)     | Link to verified contact, discard unverified                       |
| Same identity on two contacts in different tenants | No merge — tenants are isolated                                    |
| Custom attributes conflict                         | Keep primary's attributes, store secondary's as `mergedAttributes` |
| Active sessions on both contacts                   | Both sessions continue; contactId updated on next message          |

---

## 11. Storage Architecture at Scale

### The Current Problem

Current Redis footprint per active session:

| Component                 | Size                              | TTL    |
| ------------------------- | --------------------------------- | ------ |
| Session state HASH        | 10–50 KB                          | 30 min |
| Conversation history LIST | 50–200 KB                         | 30 min |
| Trace stream              | up to 250 KB (500 events, MAXLEN) | 15 min |
| Tenant reverse lookup     | ~200 B                            | 30 min |
| Agent registry            | 5–20 KB                           | 30 min |
| Execution lock            | ~100 B                            | 5 sec  |
| **Total per session**     | **~400–500 KB**                   |        |

At scale:

| Concurrent Sessions | Redis Memory (Current) | Feasible?                |
| ------------------- | ---------------------- | ------------------------ |
| 1,000               | ~500 MB                | Single node              |
| 100,000             | ~50 GB                 | Large instance           |
| 1,000,000           | ~500 GB                | Redis Cluster, expensive |
| 10,000,000          | ~5 TB                  | **Not feasible**         |
| 40,000,000          | ~20 TB                 | **Not feasible**         |

### Where the Bytes Go

At 10M concurrent sessions:

| Component                     | Per Session | Total at 10M | % of Redis |
| ----------------------------- | ----------- | ------------ | ---------- |
| Trace streams                 | ~250 KB     | 2.5 TB       | **62%**    |
| Conversation history          | ~100 KB     | 1.0 TB       | **25%**    |
| Session state HASH            | ~30 KB      | 300 GB       | 8%         |
| Agent registry                | ~10 KB      | 100 GB       | 3%         |
| IR/Comp cache                 | shared      | ~10 GB       | <1%        |
| Session resolution keys (new) | ~150 B      | ~1.5 GB      | **<0.05%** |

Traces are 62% of the cost. Conversation history is 25%. The proposed session resolution keys are noise at <0.05%.

### Tiered Storage Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  HOT TIER — Redis Cluster                                           │
│  Access pattern: every message, sub-millisecond                     │
│                                                                     │
│  What stays:                                                        │
│  ├─ Session state HASH (~30 KB/session)                             │
│  ├─ Session resolution keys (~150 B/session)                 [NEW]  │
│  ├─ Execution locks (~100 B, 5s TTL)                                │
│  ├─ Rate limiters (per-tenant, ~1 KB)                               │
│  ├─ Circuit breakers (per-provider, ~1 KB)                          │
│  ├─ DEK cache L2 (per-scope, ~1 KB)                                │
│  ├─ Verification tokens (per-session, ~500 B, 24h TTL)      [NEW]  │
│  └─ BullMQ queues (shared, ~10 GB)                                  │
│                                                                     │
│  Budget: ~35 KB/session                                             │
│  At 10M concurrent: ~350 GB                                         │
│  Cluster: 8 nodes × 48 GB (with replication)                       │
│                                                                     │
│  What moves out:                                                    │
│  ├─ Trace streams (250 KB/session)          → Direct pub/sub + cold │
│  ├─ Conversation history (100 KB/session)   → Pod-local + warm tier │
│  └─ Agent registry (10 KB/session)          → Pod-local L1 cache    │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  WARM TIER — Pod-Local Memory + Write-Behind                        │
│  Access pattern: per-session (not per-message from external store)  │
│                                                                     │
│  What lives here:                                                   │
│  ├─ Conversation history (loaded on session init, updated in-place) │
│  ├─ Agent registry (for handoff resolution)                         │
│  ├─ IR L1 cache (LRU, max 50 entries, already exists)              │
│  └─ DEK L1 cache (LRU, max 100 entries, already exists)            │
│                                                                     │
│  Write-behind: conversation snapshots to warm store on flush        │
│  Rehydration: on pod restart, load from warm store                  │
│                                                                     │
│  Warm store options:                                                │
│  ├─ DynamoDB (partition: tenantId, sort: sessionId) — preferred     │
│  ├─ ScyllaDB (same partitioning, self-hosted)                       │
│  └─ MongoDB separate collection (simpler, lower throughput)         │
│                                                                     │
│  Budget: ~160 KB/session (only materialized on owning pod)          │
│  Per pod with 10K sessions: ~1.6 GB (fits in pod memory)           │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  COLD TIER — ClickHouse / S3                                        │
│  Access pattern: analytics, history, compliance                     │
│                                                                     │
│  What lives here:                                                   │
│  ├─ Completed sessions (200M/day)                                   │
│  ├─ All messages (1B/day at 5 msg/session)                          │
│  ├─ Trace events (5B/day at 25 events/session)                      │
│  ├─ Contact activity history                                        │
│  └─ Billing & audit records                                         │
│                                                                     │
│  Partitioned by: tenant + day                                       │
│  Retention: configurable per tenant (30d–7y)                        │
│  Query latency: seconds (acceptable for dashboards and exports)     │
└─────────────────────────────────────────────────────────────────────┘
```

### Trace Architecture Change

Current: Agent → `XADD` to Redis Stream → `PUBLISH` to channel → debug UI receives.
250 KB/session sitting in Redis as a replay buffer for 15 minutes.

Proposed:

```
Agent executes
  │
  ├─ PUBLISH to Redis Pub/Sub channel (fire-and-forget, zero storage)
  │   → Connected debug UI receives in real-time
  │
  └─ Async append to ClickHouse via BullMQ batch
      → Permanent storage for replay, analytics, audit

Debug UI reconnects after disconnect:
  → Replay from ClickHouse (query by sessionId + timestamp range)
  → Not from Redis (no stream stored)
```

Savings: eliminates the `trace:stream:{tenant}:{sessionId}` keys entirely. At 10M concurrent sessions, this removes ~2.5 TB from Redis.

### Conversation History Change

Current: Stored as Redis LIST (`sess:{tenant}:{id}:conv`), up to 40 messages. Read on every LLM call.

Proposed:

```
Session active on pod:
  → Conversation history in pod-local memory (on RuntimeSession object)
  → Already loaded — no Redis read needed per message

Write-behind:
  → On every N messages or on flush interval, snapshot to warm store
  → On session end, final snapshot to warm store + cold tier

Pod restart (session rehydration):
  → Load SessionData HASH from Redis (30 KB, fast)
  → Load conversation from warm store (100 KB, <10ms)
  → Resume execution
```

This requires **sticky routing** — the load balancer routes messages for a `sessionId` to the same pod. If the pod dies, session rehydrates from Redis (state) + warm store (conversation). This is a rare event, and the 10ms penalty is acceptable.

### Redis Memory Budget After Restructuring

At 10M concurrent sessions:

| Component           | Per Session | Total       | Notes               |
| ------------------- | ----------- | ----------- | ------------------- |
| Session state HASH  | ~30 KB      | 300 GB      | Existing, unchanged |
| Resolution keys     | ~150 B      | 1.5 GB      | New                 |
| Execution locks     | ~100 B      | 1 GB        | Existing, short TTL |
| Verification tokens | ~500 B      | 5 GB        | New, 24h TTL        |
| Rate limiters       | shared      | ~1 GB       | Per-tenant          |
| Circuit breakers    | shared      | ~100 MB     | Per-provider        |
| DEK cache L2        | shared      | ~500 MB     | Per-scope           |
| IR/Comp cache       | shared      | ~10 GB      | Per-hash            |
| BullMQ queues       | shared      | ~10 GB      | In-flight jobs      |
| **Total**           |             | **~330 GB** |                     |

Cluster sizing: 8 nodes × 48 GB each = 384 GB usable. Fits with headroom.

Compare to current architecture at the same scale: ~5 TB (not feasible without restructuring).

### Sticky Routing

Required for pod-local conversation history. Implementation:

```
Load Balancer (ALB/NLB/Envoy)
  │
  ├─ WebSocket connections: already sticky (persistent connection)
  │
  ├─ HTTP with sessionId:
  │   Route header: X-Session-Id → consistent hash → pod
  │   Fallback: any pod (session rehydrated from Redis + warm store)
  │
  └─ New sessions (no sessionId):
      Round-robin → assigned to pod → pod sets sessionId cookie
```

For WebSocket (the primary path), stickiness is free — the connection is persistent. For HTTP, consistent hashing by `sessionId` routes to the owning pod. On pod failure, any pod can rehydrate from external stores.

---

## 12. Key Design Principles

| Principle                                    | Rationale                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| **Session-first, Contact-optional**          | Anonymous is the majority. Don't pay Contact overhead for every session. |
| **Channel artifact for session resume**      | O(1) Redis lookup. No joins, no Contact table on the hot path.           |
| **Identity tiers, not binary auth**          | Graceful progression from anonymous → channel-bound → verified.          |
| **HMAC for SDK identity claims**             | Only the customer's backend can issue valid identity claims.             |
| **Verification is async and non-blocking**   | Conversation continues while email link / OTP is pending.                |
| **Contact records are small and high-value** | Created only on verified identity. ~10% of session volume.               |
| **Traces out of Redis**                      | Biggest memory consumer (62%). Pub/sub + ClickHouse replaces streams.    |
| **Conversation history pod-local**           | Second biggest (25%). Sticky routing + write-behind to warm store.       |
| **Redis for coordination, not storage**      | Session state, locks, resolution keys, rate limits. Not bulk data.       |

---

## 13. Implementation Phases

### Phase 0: Foundation (Prerequisites)

**CallerContext type and propagation**

- Define `CallerContext` interface in `packages/shared/src/types/`
- Set on session creation from edge layer (SDK auth, WebSocket auth, REST auth)
- Store on RuntimeSession, propagate to tool execution and trace events
- Wire existing scattered fields (`tenantId`, `userId`, `channel`) into unified type

**Session schema additions**

- Add `channelArtifact`, `channelArtifactType`, `identityTier`, `contactId`, `verificationMethod`, `channelId` to session model
- Add compound index for session resolution
- Backfill `identityTier: 0` on existing sessions

### Phase 1: Session Resolution & Impersonation Prevention

**Channel artifact extraction**

- Extract artifact from each channel entry point (SDK init, WebSocket connect, webhook)
- Hash with SHA-256 before storage
- Store on session at creation

**Session resolution logic**

- Redis resolution key: `resolve:{tenant}:{channel}:{artifactHash}` → `sessionId`
- Set on session creation, delete on session close
- TTL matches channel's `resumeWindowSeconds`
- Resolution flow in SDK init and WebSocket handler

**HMAC verification on SDK init**

- Add `secretKey` to SDK channel config (encrypted at rest)
- Verify HMAC on `userContext.userId` when `secretKey` is configured
- Enforcement modes: `disabled` | `optional` | `required`
- Rate limit verification attempts

### Phase 2: Contact Model & Tier Promotion

**Contact model**

- Create `Contact` schema in `packages/database/src/models/`
- Identity lookup index: `(tenantId, identities.provider, identities.value)` unique
- CRUD operations in contact repository

**Tier promotion**

- `verify_identity` platform action in runtime executor
- Email verification: token generation, email send, verification endpoint
- OTP verification: code generation, SMS send, in-session verification
- Provider-verified: auto-promote on provider-sourced identity

**Back-linking**

- BullMQ job: on tier 2 promotion, find recent sessions with same `channelArtifact`, set `contactId`
- Non-blocking, async

### Phase 3: Cross-Channel & Contact Merge

**Cross-channel session continuity**

- When Contact has active session on different channel, option to continue or start fresh
- `channelHistory` populated as user moves across channels
- Agent context (`dataValues`) carries over; conversation formatting adapts to new channel

**Contact merge**

- Identity overlap detection on tier 2 promotion
- Merge rules: both verified, same tenant, keep older as primary
- Async merge job: update sessions, move identities, set `mergedInto`
- Audit trail: `contact_merged` event

### Phase 4: Storage Restructuring (Scale)

**Traces out of Redis**

- Replace `RedisTraceStore` STREAM + PUBLISH with PUBLISH-only (zero storage)
- Add ClickHouse append for permanent trace storage
- Replay from ClickHouse on debug UI reconnect

**Conversation history to pod-local**

- Remove Redis LIST for conversation
- Conversation lives in-memory on owning pod
- Write-behind to warm store (DynamoDB or separate MongoDB collection)
- Rehydration from warm store on pod restart

**Sticky routing**

- Consistent hash by `sessionId` for HTTP requests
- WebSocket already sticky (persistent connection)
- Health-check-aware failover with rehydration fallback

---

## 14. Redis Key Reference (Complete)

After all phases, the full set of Redis keys:

```
EXISTING (unchanged):
  sess:{tenantId}:{sessionId}              HASH      ~30 KB    30 min    Session state
  sess-tid:{sessionId}                     STRING    ~200 B    30 min    Reverse tenant lookup
  lock:exec:{tenantId}:{sessionId}         STRING    ~100 B    5 sec     Execution mutex
  ir:{hash}                                STRING    100-500KB 2 hr      AgentIR (gzipped)
  comp:{hash}                              STRING    50-300KB  2 hr      Compilation (gzipped)
  rl:{tenantId}:{operation}                ZSET      1-10 KB   ~70 sec   Rate limiter
  {breaker}:state                          STRING    ~50 B     variable  Circuit breaker
  {breaker}:failures                       ZSET      1-5 KB    variable  Circuit breaker
  dek:wrapped:{scope}                      HASH      ~1 KB     30 min    Wrapped DEK cache
  bull:message-persistence:*               BullMQ    variable  variable  Message queue
  bull:llm-requests:*                      BullMQ    variable  variable  LLM queue

REMOVED (Phase 4):
  sess:{tenantId}:{sessionId}:conv         LIST      ← moved to pod-local
  trace:stream:{tenantId}:{sessionId}      STREAM    ← replaced by pub/sub only
  registry:{tenantId}:{sessionId}          HASH      ← moved to pod-local

NEW:
  resolve:{tenantId}:{channelId}:{hash}    STRING    ~150 B    variable  Session resolution
  vtoken:{tokenHash}                       STRING    ~500 B    24 hr     Email verification
  otp:{sessionId}:{identityType}           STRING    ~200 B    5 min     OTP code
```

---

## 15. API Surface

### New Endpoints

```
POST   /api/verify/{token}                    Email verification landing
POST   /api/v1/sdk/init                       (modified) HMAC verification, artifact extraction
GET    /api/projects/:id/contacts             List contacts for project
GET    /api/projects/:id/contacts/:contactId  Contact detail with session history
POST   /api/projects/:id/contacts/merge       Manual contact merge trigger
```

### Modified Endpoints

```
POST   /api/v1/sdk/init
  Added: HMAC verification on userContext
  Added: Channel artifact extraction
  Added: Session resolution (find existing vs create new)
  Added: identityTier in token payload

WS     /ws/sdk
  Added: Session resolution on connect
  Added: identity_verified event push
  Added: Tier promotion handling

POST   /api/chat/agent
  Added: CallerContext on session creation
  Added: channelArtifact from request context
```

### WebSocket Events (New)

```
Server → Client:
  identity_verified    { email, contactId, identityTier }
  identity_promoted    { from: tier, to: tier, method }
  verification_sent    { type: 'email' | 'sms', destination: masked }

Client → Server:
  verify_otp           { code: string }
```

---

## 16. Security Considerations

| Concern                           | Mitigation                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------------- |
| HMAC secret key exposure          | Stored encrypted at rest (tenant DEK). Never sent to client. Rotatable.                       |
| Verification token theft          | JWT with short expiry (24h). Single-use (status check in Redis). Rate-limited attempts.       |
| OTP brute force                   | Max 3 attempts per code. New code generated after 3 failures. 5-minute expiry.                |
| Channel artifact spoofing (web)   | Cookies are low-trust (tier 1 only). HMAC required for tier 2.                                |
| Channel artifact spoofing (voice) | Caller ID set by carrier, not end-user. Medium trust.                                         |
| Cross-tenant contact access       | All queries filtered by `tenantId`. Contact identities scoped to tenant.                      |
| PII in Redis                      | Artifacts hashed (SHA-256). Email/phone stored as hashes in resolution keys.                  |
| Contact enumeration               | No public API for contact search by identity. Lookup only via authenticated session.          |
| Session hijacking                 | Session token bound to channel artifact. Artifact mismatch → new session.                     |
| Merge abuse                       | Both identities must be verified. Merge is async with audit trail. Manual override available. |

---

## 17. Observability

### Trace Events (New)

```
identity_tier_set        { tier, method, artifactType }           On session creation
identity_promoted        { fromTier, toTier, method, trigger }    On tier upgrade
identity_verified        { identityType, method }                 On verification success
identity_verification_sent { identityType, method, destination }  On verification initiated
identity_verification_failed { identityType, reason, attempts }   On verification failure
contact_created          { contactId, identityType }              On new contact
contact_linked           { contactId, sessionId }                 On session → contact link
contact_merged           { primaryId, secondaryId, trigger }      On contact merge
session_resolved         { method: 'sessionId' | 'artifact' | 'contact' | 'new' } On resolution
hmac_verification_failed { userId, reason }                       On HMAC rejection
```

### Metrics

```
session_resolution_method    counter    { method, channel, tier }
session_resolution_latency   histogram  { method, channel }
identity_tier_distribution   gauge      { tier, channel }
verification_sent            counter    { type, method }
verification_completed       counter    { type, method, success }
contact_created              counter    { trigger }
contact_merged               counter    { trigger }
hmac_rejected                counter    { reason }
```

---

## 18. Implementation Status and Audit Findings (2026-03-20)

The 2026-03-20 five-auditor review assessed the current implementation against this design specification. The following sections document what has been implemented, what integrates with the design, and what audit findings affect the design's security properties.

### Access-Denied Auditing Integration

The platform now implements the `AccessDeniedReporter` pattern for centralized access-denial auditing. This integrates with the session ownership design as follows:

- When a session ownership check fails at any tier, the denial is reported through `AccessDeniedReporter` with structured context (denied principal, target session, denial reason)
- The reporter is wired into `shared-auth` middleware, so all session access checks (REST API, WebSocket, attachment routes) generate audit events on denial
- Denial events include enough context for security monitoring without leaking the existence of the denied resource to the caller (404 response, structured audit event internally)

### Session Ownership: Tiered Identity Matching (Implemented)

The tiered identity matching system described in Section 8 is now implemented in the session ownership middleware:

| Tier   | Implementation                                                                                                   | Status      |
| ------ | ---------------------------------------------------------------------------------------------------------------- | ----------- |
| Tier 0 | SDK session principal match -- session token holder is verified against the session's bound principal            | Implemented |
| Tier 1 | Channel artifact match -- hashed artifact from the caller's channel is compared to the session's stored artifact | Implemented |
| Tier 2 | Contact-linked identity -- verified identity match allows cross-channel session access                           | Planned     |

Tier 0 and Tier 1 are active in production. Tier 2 depends on the Contact model (Phase 2 of this design), which is not yet implemented.

### Fail-Closed Session Ownership Validation

The audit confirmed that session ownership validation follows a fail-closed design:

- If the ownership check encounters a system error (Redis unavailable, decryption failure), access is denied
- If the caller's identity cannot be determined from the request context, access is denied
- If no tier matches the caller, the session is treated as inaccessible and returns 404 (not 403)
- The `evaluateSessionOwnershipAccess` function returns a typed result that must be explicitly checked -- there is no default-allow path

### WebSocket Pre-Auth Buffering Design

The WebSocket handlers now implement pre-auth message buffering as described in the design's security considerations:

- Messages received before the WebSocket auth handshake completes are buffered in memory
- Buffering enforces two limits: maximum message count and maximum total byte size
- Messages exceeding either limit are silently dropped
- On successful auth, buffered messages are replayed in order
- On auth failure or timeout, all buffered messages are discarded and the connection is closed

This prevents unauthenticated senders from consuming unbounded memory on the server while still supporting the legitimate case where a client sends a message before the auth response arrives.

### Known Issues from Audit Affecting This Design

| ID  | Finding                                                                         | Design Impact                                                                                       | Severity |
| --- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------- |
| H1  | `getAuthorizedRuntimeSession` skips ownership check when `messageType` is falsy | Violates fail-closed principle -- allows session access without ownership validation for some paths | High     |
| M1  | Redis Pub/Sub cross-pod delivery has no `tenantId` in channel key               | Violates tenant isolation for real-time session events in shared Redis deployments                  | Medium   |
| C1  | `clients` Map in `websocket/handler.ts` has no max-size bound                   | Pre-auth buffering protects per-connection, but connection count itself is unbounded                | Critical |
| C3  | Share exchange legacy fallback uses tenant-less `Project.findById`              | Stale share tokens could resolve sessions in the wrong tenant, bypassing Tier 0 ownership isolation | Critical |

---

## Appendix A: Volume Estimates at Target Scale

Assuming 200M sessions/day, 5 messages/session average:

| Metric                             | Value                                  |
| ---------------------------------- | -------------------------------------- |
| Sessions created/sec (avg)         | ~2,300                                 |
| Sessions created/sec (peak 3x)     | ~7,000                                 |
| Messages/sec (peak)                | ~35,000                                |
| Session resolutions/sec (peak)     | ~35,000                                |
| Concurrent active sessions (5%)    | ~10,000,000                            |
| Tier 0 sessions/day                | ~40M (20%)                             |
| Tier 1 sessions/day                | ~140M (70%)                            |
| Tier 2 sessions/day                | ~20M (10%)                             |
| Contacts created/day               | ~5M (deduplicated)                     |
| Contacts total (steady state)      | ~150M/month, stabilizes                |
| Redis memory (after restructuring) | ~330 GB                                |
| Redis ops/sec (peak)               | ~70K (resolution reads + state writes) |
| MongoDB writes/sec (batched)       | ~50K                                   |
| ClickHouse inserts/sec (traces)    | ~200K (batched)                        |

## Appendix B: Migration Path for Existing Sessions

Existing sessions have no `channelArtifact`, `identityTier`, or `contactId`. Migration:

1. **Schema migration**: Add fields with defaults (`identityTier: 0`, others nullable)
2. **No backfill required**: Existing sessions are tier 0 by definition
3. **New sessions**: Populated at creation per new logic
4. **Existing active sessions**: Upgraded on next interaction (lazy migration)
5. **Resolution keys**: Only created for new sessions. No backfill for existing Redis sessions.

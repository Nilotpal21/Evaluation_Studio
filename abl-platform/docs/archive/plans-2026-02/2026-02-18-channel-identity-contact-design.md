# Channel-Level End User Identity & Contact Management

**Date**: 2026-02-18
**Status**: Design approved
**Scope**: Phase 1 (finish wiring) + Phase 2 (contacts + verification) + Phase 3 (cross-channel + merge)
**Related**: [Centralized Auth Design](2026-02-22-centralized-auth-design.md) — extends CallerContext into discriminated AuthContext with session ownership enforcement for user-level data isolation

---

## 1. Problem Statement

The platform has strong type definitions and partial implementations for end-user identity, but the wiring is incomplete. Key gaps:

- CallerContext identity fields are not propagated to all session creation paths
- No Contact auto-creation on verified identity (tier 2)
- No identity verification beyond HMAC (no OTP, email link, OAuth, provider-verified)
- No cross-channel session continuity
- No contact merge (self-merge, admin, or system-suggested)
- Channel adapter contract undefined — no uniform handling of messages, streaming, actions, delivery
- PII stored in plaintext on Contact records (no encryption at rest, no blind indexes)
- No GDPR cascade delete

## 2. Architecture: Bounded Contexts

Four bounded contexts following Clean Architecture + DDD. Each context has `domain/` (zero infra imports), `use-cases/` (import domain only, infra injected via ports), and `infrastructure/` (implements domain interfaces).

### 2.1 Channel Context

Normalizes inbound/outbound messages across channel types. No identity logic.

**Domain entities**:

- `ChannelMessage` — normalized inbound (text, media, metadata, sender artifact)
- `OutboundEnvelope` — normalized outbound (text/streaming/rich/action), channel-agnostic
- `DeliveryReceipt` — delivery status callback (sent, delivered, read, failed)
- `ChannelConfig` — per-channel settings

**Use cases**:

- `ReceiveInboundMessage` — webhook/WS -> normalize -> emit to orchestration
- `SendOutboundMessage` — envelope -> channel-specific format -> provider API
- `StreamResponse` — streaming chunks -> channel-specific streaming protocol
- `HandleDeliveryStatus` — provider callback -> update delivery state

### 2.2 Identity Context

Verifies who the end user is. Artifact hashing, session resolution, all verification methods.

**Domain entities**:

- `IdentityArtifact` — value object: raw value + type + hashed value
- `IdentityTier` — enum (0/1/2) with promotion rules
- `VerificationAttempt` — tracks a verification flow (pending -> verified/expired)
- `SessionResolutionKey` — tenant + channel + artifact hash -> session ID

**Use cases**:

- `VerifyIdentity` — dispatch to correct verifier
- `ResolveSession` — artifact -> find existing session or signal "create new"
- `RegisterResolutionKey` — store artifact -> session mapping in Redis
- `PromoteTier` — upgrade session identity tier with verification proof

### 2.3 Contact Context

Persistent end-user records that span sessions and channels.

**Domain entities**:

- `Contact` — aggregate root: verified identities, metadata, tags, channel history
- `ContactIdentity` — value object: type + encrypted value + blind index + verified flag
- `MergeSuggestion` — two contacts with overlapping identities, confidence, status
- `MergeExecution` — primary absorbs secondary, tracks what moved

**Use cases**:

- `ResolveOrCreateContact` — on tier 2, find by identity or create new
- `LinkSessionToContact` — bidirectional link
- `DetectMergeCandidates` — check blind indexes for overlap after contact creation
- `ExecuteMerge` — admin-confirmed merge
- `SelfMerge` — end user claims additional identity, verifies, then merges
- `CascadeDeleteContact` — GDPR right to erasure

### 2.4 Orchestration Context

Coordinates across the three domain contexts.

**Use cases**:

- `InitializeSession` — channel receives message -> identity resolves/creates session -> contact linked if tier 2
- `PromoteAndLink` — verification succeeds -> tier promoted -> contact resolved -> back-link sessions
- `SwitchChannel` — tier 2 user arrives on new channel -> contact found -> session resumed or linked

---

## 3. Directory Structure

```
apps/runtime/src/
  contexts/
    channel/
      domain/
        channel-message.ts
        channel-adapter.ts          # ChannelAdapter interface (port)
        channel-types.ts            # ChannelType, StreamChunk, ActionPayload, etc.
      use-cases/
        receive-inbound-message.ts
        send-outbound-message.ts
        stream-response.ts
        handle-delivery-status.ts
      infrastructure/
        adapters/
          web-adapter.ts
          voice-adapter.ts
          sms-adapter.ts            # placeholder
          whatsapp-adapter.ts       # placeholder
          email-adapter.ts          # placeholder
          facebook-adapter.ts       # placeholder
          ms-teams-adapter.ts       # placeholder
          api-adapter.ts
        webhook-router.ts
        adapter-registry.ts
      index.ts

    identity/
      domain/
        identity-artifact.ts
        identity-tier.ts
        verification-attempt.ts
        session-resolution-key.ts
        identity-verifier.ts        # IdentityVerifier interface (port)
      use-cases/
        verify-identity.ts
        resolve-session.ts
        register-resolution-key.ts
        promote-tier.ts
      infrastructure/
        verifiers/
          hmac-verifier.ts          # existing code, relocated
          otp-verifier.ts           # otplib v13
          email-link-verifier.ts    # @oslojs/crypto + custom token store
          oauth-verifier.ts         # Arctic v3
          provider-verifier.ts      # WhatsApp/FB auto-verify
          webhook-verifier.ts       # customer webhook callback
        resolution-key-store.ts     # Redis
        verification-token-store.ts # Redis
      index.ts

    contact/
      domain/
        contact.ts                  # Contact aggregate root
        contact-identity.ts         # ContactIdentity value object
        merge-suggestion.ts
        merge-execution.ts
        contact-repository.ts       # ContactRepository interface (port)
      use-cases/
        resolve-or-create-contact.ts
        link-session-to-contact.ts
        detect-merge-candidates.ts
        execute-merge.ts
        self-merge.ts
        cascade-delete-contact.ts
      infrastructure/
        contact-mongo-repository.ts
        contact-encryptor.ts        # wraps EncryptionService + HKDF blind indexes
        merge-suggestion-store.ts
      index.ts

    orchestration/
      use-cases/
        initialize-session.ts
        promote-and-link.ts
        switch-channel.ts
      jobs/
        back-link-sessions.ts       # BullMQ
        detect-merge-candidates.ts  # BullMQ
      index.ts
```

**Rules**:

- `domain/` has zero imports from `infrastructure/` or external packages
- `use-cases/` import from `domain/` only; infrastructure injected via constructor
- `infrastructure/` implements domain interfaces
- Each `index.ts` is the public API; other contexts import through it only
- Cross-context communication goes through orchestration, never direct

---

## 4. Channel Adapter Contract

### 4.1 ChannelAdapter Interface

```typescript
// contexts/channel/domain/channel-adapter.ts

export interface ChannelAdapter {
  readonly channelType: ChannelType;

  // -- Inbound --
  normalizeInbound(raw: unknown, headers: Record<string, string>): InboundResult;
  extractArtifact(raw: unknown): ArtifactExtraction | null;
  verifyWebhookSignature(raw: unknown, headers: Record<string, string>, secret: string): boolean;

  // -- Outbound --
  sendMessage(envelope: OutboundEnvelope, config: ChannelConfig): Promise<SendResult>;
  openStream(sessionRef: SessionRef, config: ChannelConfig): StreamHandle;
  sendStreamChunk(handle: StreamHandle, chunk: StreamChunk): Promise<void>;
  closeStream(handle: StreamHandle): Promise<void>;

  // -- Actions --
  sendAction(action: ActionPayload, config: ChannelConfig): Promise<SendResult>;
  sendPresence(type: PresenceType, ref: SessionRef, config: ChannelConfig): Promise<void>;

  // -- Delivery --
  parseDeliveryStatus(raw: unknown, headers: Record<string, string>): DeliveryReceipt | null;

  // -- Lifecycle --
  initialize(config: ChannelConfig): Promise<void>;
  shutdown(): Promise<void>;
}
```

### 4.2 Channel Types

```typescript
// contexts/channel/domain/channel-types.ts

export type ChannelType =
  | 'web'
  | 'mobile_ios'
  | 'mobile_android'
  | 'voice'
  | 'sms'
  | 'whatsapp'
  | 'email'
  | 'facebook'
  | 'ms_teams'
  | 'api';

export interface ChannelMessage {
  channelType: ChannelType;
  text: string | null;
  media: MediaAttachment[];
  metadata: Record<string, unknown>;
  senderArtifact: ArtifactExtraction | null;
  timestamp: Date;
  providerMessageId: string | null;
  rawRef?: unknown;
}

export interface OutboundEnvelope {
  recipientArtifact: string;
  text: string | null;
  richContent: RichContent | null;
  media: MediaAttachment[];
  metadata: Record<string, unknown>;
  replyToMessageId: string | null;
}

export interface StreamChunk {
  type: 'text_delta' | 'tool_start' | 'tool_result' | 'metadata' | 'done';
  content: string;
  toolName?: string;
  toolCallId?: string;
}

export interface ActionPayload {
  type: 'buttons' | 'card' | 'carousel' | 'form' | 'quick_replies' | 'list';
  data: Record<string, unknown>;
}

export type PresenceType = 'typing_on' | 'typing_off' | 'read' | 'online' | 'offline';

export interface ArtifactExtraction {
  rawValue: string;
  artifactType: ChannelArtifactType;
  providerVerified: boolean;
}

export interface DeliveryReceipt {
  providerMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: Date;
  errorCode?: string;
  errorMessage?: string;
}

export interface SendResult {
  success: boolean;
  providerMessageId?: string;
  error?: { code: string; message: string };
}

export interface StreamHandle {
  sessionRef: SessionRef;
  channelType: ChannelType;
  handle: unknown;
}

export interface SessionRef {
  sessionId: string;
  tenantId: string;
  channelId: string;
}

export interface MediaAttachment {
  type: 'image' | 'audio' | 'video' | 'document' | 'location';
  url: string;
  mimeType?: string;
  filename?: string;
  size?: number;
  caption?: string;
}

export interface RichContent {
  format: 'markdown' | 'html' | 'structured';
  body: string;
}

export interface InboundResult {
  success: boolean;
  message?: ChannelMessage;
  error?: { code: string; message: string };
}
```

### 4.3 Adapter Registry

```typescript
// contexts/channel/infrastructure/adapter-registry.ts

export class AdapterRegistry {
  private adapters: Map<ChannelType, ChannelAdapter>;

  register(adapter: ChannelAdapter): void;
  get(type: ChannelType): ChannelAdapter;
  has(type: ChannelType): boolean;
  all(): ChannelAdapter[];
}
```

### 4.4 Webhook Router

```typescript
// contexts/channel/infrastructure/webhook-router.ts
// Express router: POST /webhooks/:channelType/:channelId
// 1. Lookup adapter by channelType
// 2. Verify webhook signature
// 3. adapter.normalizeInbound(body, headers) -> ChannelMessage
// 4. adapter.extractArtifact(body) -> ArtifactExtraction
// 5. Forward to orchestration.initializeSession()
```

---

## 5. Identity Verifier Contract

### 5.1 IdentityVerifier Interface

```typescript
// contexts/identity/domain/identity-verifier.ts

export interface IdentityVerifier {
  readonly method: VerificationMethod;

  initiate(input: VerificationInput): Promise<VerificationInitResult>;
  complete(attemptId: string, proof: VerificationProof): Promise<VerificationResult>;
  supports(input: VerificationInput): boolean;
}

export interface VerificationInput {
  tenantId: string;
  sessionId: string;
  identityValue: string; // email, phone, external ID
  identityType: 'email' | 'phone' | 'external';
  channelType: ChannelType;
  channelConfig: ChannelConfig;
}

export interface VerificationInitResult {
  success: boolean;
  attemptId?: string;
  /** For sync methods (HMAC), result is immediate */
  immediateResult?: VerificationResult;
  /** For async methods, what the user should do next */
  userAction?: 'enter_otp' | 'check_email' | 'redirect' | 'wait';
  redirectUrl?: string;
  error?: { code: string; message: string };
}

export interface VerificationProof {
  type:
    | 'otp_code'
    | 'link_token'
    | 'oauth_callback'
    | 'hmac_signature'
    | 'provider_artifact'
    | 'webhook_response';
  value: string;
  metadata?: Record<string, unknown>;
}

export interface VerificationResult {
  verified: boolean;
  identityValue: string;
  identityType: 'email' | 'phone' | 'external';
  method: VerificationMethod;
  error?: { code: string; message: string };
}
```

### 5.2 Verifier Implementations

| Verifier            | Library                     | Sync/Async | Proof                       | Provider-Verified |
| ------------------- | --------------------------- | ---------- | --------------------------- | ----------------- |
| `HmacVerifier`      | Node.js `crypto` (existing) | Sync       | HMAC signature + timestamp  | No                |
| `OtpVerifier`       | **otplib v13**              | Async      | 6-digit code (SMS or email) | No                |
| `EmailLinkVerifier` | **@oslojs/crypto** + custom | Async      | Token in URL                | No                |
| `OAuthVerifier`     | **Arctic v3**               | Async      | OAuth callback code         | Yes               |
| `ProviderVerifier`  | Custom                      | Sync       | Channel artifact itself     | Yes               |
| `WebhookVerifier`   | Custom                      | Async      | Customer webhook response   | Depends           |

### 5.3 Verification Token Storage (Redis)

```
Key:   verification:{tenantId}:{attemptId}
Value: {
  method: VerificationMethod,
  identityValue: string,        // encrypted
  identityType: string,
  hashedCode: string,           // HMAC of OTP code or link token
  sessionId: string,
  status: 'pending' | 'verified' | 'expired' | 'failed',
  attempts: number,
  maxAttempts: 5,
  expiresAt: number
}
TTL: 300s (OTP), 3600s (email link), 600s (OAuth state)
```

Single-use enforcement: Lua script atomically checks `status === 'pending'` and transitions to `verified`. Second attempt sees non-pending status and rejects.

Rate limiting: Max 5 verification attempts per session per 15 minutes (Redis ZSET sliding window).

---

## 6. Contact Model & Encryption

### 6.1 Contact Aggregate

```typescript
// contexts/contact/domain/contact.ts

export interface Contact {
  id: string; // UUID v7
  tenantId: string;
  identities: ContactIdentity[];
  displayName: string | null;
  type: 'customer' | 'employee';
  metadata: Record<string, unknown>;
  tags: string[];
  channelHistory: ChannelHistoryEntry[];
  sessionCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  mergedInto: string | null;
  deletedAt: Date | null;
}

export interface ContactIdentity {
  type: 'email' | 'phone' | 'external';
  encryptedValue: string; // AES-256-GCM(DEK[tenantId], plaintext)
  blindIndex: string; // HMAC-SHA256(blindKey[tenantId], normalize(value))
  verified: boolean;
  verifiedAt: Date | null;
  verifiedVia: VerificationMethod | null;
  channel: string | null;
}

export interface ChannelHistoryEntry {
  channelType: ChannelType;
  channelId: string;
  firstSessionAt: Date;
  lastSessionAt: Date;
  sessionCount: number;
}
```

### 6.2 ContactRepository Port

```typescript
// contexts/contact/domain/contact-repository.ts

export interface ContactRepository {
  findById(tenantId: string, contactId: string): Promise<Contact | null>;
  findByBlindIndex(tenantId: string, blindIndex: string): Promise<Contact | null>;
  findByBlindIndexes(tenantId: string, blindIndexes: string[]): Promise<Contact[]>;
  create(contact: Contact): Promise<Contact>;
  update(contact: Contact): Promise<Contact>;
  addIdentity(tenantId: string, contactId: string, identity: ContactIdentity): Promise<void>;
  linkSession(
    tenantId: string,
    contactId: string,
    sessionId: string,
    channelType: ChannelType,
    channelId: string,
  ): Promise<void>;
  softDelete(tenantId: string, contactId: string): Promise<void>;
  hardDelete(tenantId: string, contactId: string): Promise<void>;
  findMergeCandidates(tenantId: string, blindIndexes: string[]): Promise<Contact[]>;
}
```

### 6.3 Encryption Scheme

```
Encrypt:  AES-256-GCM(DEK[tenantId], plaintext) -> ciphertext
          DEK derived via HKDF(masterKey, salt="contact:{tenantId}")

Blind:    HMAC-SHA256(blindKey[tenantId], normalize(plaintext)) -> hex index
          blindKey derived via HKDF(masterKey, salt="blind:{tenantId}")

Normalize:
  email  -> lowercase, trim
  phone  -> E.164 format (strip formatting, ensure +country)
  external -> as-is (case-sensitive)

Lookup:   db.contacts.find({
            tenantId,
            'identities.blindIndex': hmac(normalize(value))
          })
```

Uses existing `EncryptionService` with HKDF extension for per-field key derivation. No new crypto library needed.

### 6.4 MongoDB Indexes

```
{ tenantId: 1, 'identities.blindIndex': 1 }     // Identity lookup (unique per tenant)
{ tenantId: 1, mergedInto: 1 }                   // Find merged contacts
{ tenantId: 1, lastSeenAt: -1 }                  // Recency sort
{ tenantId: 1, deletedAt: 1 }                    // Soft-delete filter
{ tenantId: 1, type: 1 }                         // Filter by type
```

---

## 7. Contact Merge: Three Paths

### 7.1 End-User Self-Merge

User on WhatsApp says "I also use email john@example.com":

1. `VerifyIdentity` initiated for email (OTP or email link)
2. User verifies
3. `SelfMerge` use case:
   a. Compute `blindIndex(john@example.com)`
   b. Find existing Contact with that blind index
   c. If found: merge current Contact into existing (or vice versa by recency)
   d. If not found: add email identity to current Contact
4. `BackLinkSessions` job: update all sessions from both artifacts to unified Contact

### 7.2 System Suggestion

After any contact creation or identity addition:

1. `DetectMergeCandidates` BullMQ job runs
2. Check all blind indexes on new Contact against other Contacts in same tenant
3. If overlap found: create `MergeSuggestion`

```typescript
export interface MergeSuggestion {
  id: string;
  tenantId: string;
  primaryContactId: string;
  secondaryContactId: string;
  overlapIdentities: { type: string; blindIndex: string }[];
  confidence: 'high' | 'medium' | 'low';
  status: 'pending' | 'accepted' | 'rejected' | 'auto_merged';
  suggestedAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null; // userId, 'system', or 'self'
}
```

Surfaced via admin API: `GET /api/contacts/merge-suggestions`.

### 7.3 Admin Merge

`POST /api/contacts/merge` with `{ primaryId, secondaryId }`:

1. Validate both contacts exist, same tenant
2. Move all identities from secondary -> primary (deduplicate by blindIndex)
3. Update all sessions where `contactId = secondary` -> primary
4. Merge channel history entries
5. Merge metadata (primary wins on conflict, secondary stored as `mergedAttributes`)
6. Set `secondary.mergedInto = primary.id`
7. Soft-delete secondary
8. Emit audit trace event

---

## 8. Orchestration Flows

### 8.1 InitializeSession (hot path)

```
Inbound (webhook/WS)
  |
  v
ChannelAdapter.normalizeInbound()       -- Channel Context
  |  -> ChannelMessage
  v
ChannelAdapter.extractArtifact()        -- Channel Context
  |  -> ArtifactExtraction { rawValue, type, providerVerified }
  v
IdentityArtifact.hash(raw)             -- Identity Context
  |  -> hashed artifact
  v
ResolveSession(tenant, channel, hash)   -- Identity Context
  |
  +-- Found active session -> resume
  |     -> verify tenant ownership
  |     -> update lastActivityAt
  |
  +-- No match -> create new session
        -> buildCallerContext(artifact, tier, method)
        -> store session with CallerContext
        -> RegisterResolutionKey(tenant, channel, hash -> sessionId)
        |
        v
        If providerVerified || identityTier === 2:
          -> ResolveOrCreateContact()    -- Contact Context
          -> LinkSessionToContact()
          -> enqueue DetectMergeCandidates job
```

### 8.2 PromoteAndLink (mid-session verification)

```
VerificationAttempt completes
  |
  v
PromoteTier(session, newTier=2, proof)   -- Identity Context
  |  -> update session.identityTier = 2
  |  -> update session.verificationMethod
  |  -> update session.customerId
  v
ResolveOrCreateContact(tenantId, identity)  -- Contact Context
  |  -> lookup by blindIndex
  |  -> create if not found
  v
LinkSessionToContact(session, contact)
  |
  v
BackLinkSessions job (BullMQ)            -- Orchestration
  |  -> find sessions with same channelArtifact + tenant
  |  -> update contactId on each
  v
DetectMergeCandidates job (BullMQ)
  -> check for identity overlap
```

### 8.3 SwitchChannel (cross-channel continuity)

```
Inbound on Channel B (e.g., WhatsApp, provider-verified phone)
  |
  v
ResolveSession(tenant, channelB, hash)
  |  -> no existing session on this channel
  v
Identity is provider-verified -> identityTier = 2
  |
  v
ResolveOrCreateContact(tenantId, phone)
  |  -> found existing Contact (from Channel A)
  v
Check channelConfig.resumeCrossChannel
  |
  +-- true:  load Channel A session context -> create session B with carried context -> link to Contact
  +-- false: create fresh session on Channel B -> link to same Contact
```

---

## 9. Compliance

### 9.1 GDPR Cascade Delete

`DELETE /api/contacts/:id/gdpr`:

1. Load Contact + all linked session IDs
2. For each session:
   a. Delete messages (MongoDB)
   b. Delete trace events (ClickHouse: `DELETE WHERE sessionId IN (...)`)
   c. Delete resolution keys (Redis: `DEL resolve:{tenant}:{channel}:{artifact}`)
   d. Delete session record (MongoDB)
3. Hard-delete Contact record
4. Delete merge suggestions referencing this contact
5. Emit audit event: `{ actor, contactId, timestamp, cascadedSessionCount, cascadedMessageCount }`

### 9.2 Audit Events

Every contact operation emits an audit trace:

```typescript
export type ContactAuditAction =
  | 'contact.created'
  | 'contact.viewed'
  | 'contact.updated'
  | 'contact.deleted'
  | 'contact.gdpr_erased'
  | 'contact.merged'
  | 'contact.identity_added'
  | 'contact.identity_verified'
  | 'contact.session_linked';
```

Stored via existing `TraceStore` with `eventType: 'audit'`, includes `tenantId`, actor identity, timestamp, and action-specific data.

### 9.3 PII Handling

- Contact identity values encrypted at rest (application-level AES-256-GCM)
- Blind indexes for search without decryption
- Verification tokens in Redis with TTL (auto-expire)
- No raw PII in trace events (use hashed artifact, never raw email/phone)
- Contact data has configurable retention TTL (default 90 days idle)

---

## 10. Library Decisions

### Reuse (already in codebase)

| Concern    | Library                                | Location                     |
| ---------- | -------------------------------------- | ---------------------------- |
| Job queues | BullMQ 5.0                             | `apps/runtime`               |
| Redis      | ioredis 5.7                            | `apps/runtime`               |
| Encryption | Node.js `crypto` + `EncryptionService` | `apps/runtime/src/services/` |
| KMS        | Local/AWS/GCP/Azure                    | `packages/database/src/kms/` |
| JWT        | jsonwebtoken 9.0                       | runtime, studio, shared      |
| Voice      | Twilio 5.3 + LiveKit                   | `apps/runtime`               |

### New libraries

| Concern           | Library            | Why                                                             |
| ----------------- | ------------------ | --------------------------------------------------------------- |
| OAuth providers   | **Arctic v3**      | Client-only, 50+ providers, no middleware opinions, fully typed |
| OTP generation    | **otplib v13**     | Pluggable crypto backend, stateless, TypeScript-native          |
| Crypto primitives | **@oslojs/crypto** | Audited, zero-dep utilities for magic link tokens               |

### Custom implementations

| Concern                             | Why                                                     |
| ----------------------------------- | ------------------------------------------------------- |
| Contact merge / identity resolution | No viable library; tightly coupled to data model        |
| Blind index encryption              | Existing `EncryptionService` + HKDF covers this         |
| Channel adapters                    | Domain-specific; placeholders for porting existing code |
| Magic link tokens                   | Simple pattern (random -> HMAC -> store -> verify)      |
| Webhook signature verification      | Per-provider, part of each adapter                      |

---

## 11. API Surface

### New endpoints

```
POST   /api/identity/verify/initiate    # Start verification (any method)
POST   /api/identity/verify/complete     # Complete verification (OTP code, link token, etc.)
GET    /api/identity/verify/:attemptId   # Check verification status

POST   /api/contacts/merge              # Admin merge two contacts
GET    /api/contacts/merge-suggestions  # List pending merge suggestions
PUT    /api/contacts/merge-suggestions/:id  # Accept/reject suggestion

POST   /api/contacts/:id/self-merge     # End-user self-merge (triggers verification)
DELETE /api/contacts/:id/gdpr           # GDPR cascade delete

POST   /webhooks/:channelType/:channelId  # Inbound provider webhooks
```

### Modified endpoints

```
POST   /api/sdk/init                    # Add channelArtifact to token payload
POST   /api/chat/agent                  # Wire CallerContext from auth, use session resolution
WS     /ws/sdk                          # Ensure CallerContext flows to all session creation paths
```

---

## 12. Key Design Decisions

1. **Four bounded contexts** (Channel, Identity, Contact, Orchestration) with Clean Architecture layers
2. **ChannelAdapter interface** with full event coverage (messages, streaming, actions, delivery, presence)
3. **Placeholder adapter implementations** for messaging channels (SMS, WhatsApp, Email, Facebook, MS Teams) — existing code to be ported in
4. **Six identity verifiers** behind a common `IdentityVerifier` port
5. **Application-level encryption** with HKDF-derived per-tenant blind indexes for Contact PII
6. **Three merge paths** — end-user self-merge (with verification), system suggestions, admin API
7. **Three orchestration flows** — session init (hot path), tier promotion + back-link, cross-channel switch
8. **GDPR cascade delete** with full audit trail via existing TraceStore
9. **Arctic v3** for OAuth, **otplib v13** for OTP, **@oslojs/crypto** for magic link tokens
10. **BullMQ** for async jobs (back-linking sessions, merge candidate detection)

---

## Implementation Plan

_Merged from `2026-02-18-channel-identity-contact-plan.md`._

## Phase 1: Channel Context Domain + Adapters

### Task 1: Channel Domain Types

**Files:**

- Create: `apps/runtime/src/contexts/channel/domain/channel-types.ts`
- Test: `apps/runtime/src/__tests__/contexts/channel/channel-types.test.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect } from 'vitest';
import type {
  ChannelType,
  ChannelMessage,
  OutboundEnvelope,
  StreamChunk,
  ActionPayload,
  DeliveryReceipt,
  SendResult,
  ArtifactExtraction,
  MediaAttachment,
  SessionRef,
  StreamHandle,
  InboundResult,
  RichContent,
  PresenceType,
} from '../../../contexts/channel/domain/channel-types.js';

describe('Channel Domain Types', () => {
  it('ChannelMessage satisfies shape', () => {
    const msg: ChannelMessage = {
      channelType: 'web',
      text: 'hello',
      media: [],
      metadata: {},
      senderArtifact: null,
      timestamp: new Date(),
      providerMessageId: null,
    };
    expect(msg.channelType).toBe('web');
    expect(msg.text).toBe('hello');
  });

  it('OutboundEnvelope satisfies shape', () => {
    const env: OutboundEnvelope = {
      recipientArtifact: 'abc123',
      text: 'response',
      richContent: null,
      media: [],
      metadata: {},
      replyToMessageId: null,
    };
    expect(env.recipientArtifact).toBe('abc123');
  });

  it('StreamChunk covers all types', () => {
    const chunks: StreamChunk[] = [
      { type: 'text_delta', content: 'hi' },
      { type: 'tool_start', content: '', toolName: 'search', toolCallId: 'tc_1' },
      { type: 'tool_result', content: '{"data":1}', toolName: 'search', toolCallId: 'tc_1' },
      { type: 'metadata', content: '{}' },
      { type: 'done', content: '' },
    ];
    expect(chunks).toHaveLength(5);
  });

  it('ActionPayload covers all action types', () => {
    const types: ActionPayload['type'][] = [
      'buttons',
      'card',
      'carousel',
      'form',
      'quick_replies',
      'list',
    ];
    types.forEach((t) => {
      const action: ActionPayload = { type: t, data: {} };
      expect(action.type).toBe(t);
    });
  });

  it('ArtifactExtraction marks provider verification', () => {
    const verified: ArtifactExtraction = {
      rawValue: '+15551234567',
      artifactType: 'phone',
      providerVerified: true,
    };
    const unverified: ArtifactExtraction = {
      rawValue: 'cookie_abc',
      artifactType: 'cookie',
      providerVerified: false,
    };
    expect(verified.providerVerified).toBe(true);
    expect(unverified.providerVerified).toBe(false);
  });

  it('DeliveryReceipt includes error fields only on failure', () => {
    const success: DeliveryReceipt = {
      providerMessageId: 'msg_1',
      status: 'delivered',
      timestamp: new Date(),
    };
    const failure: DeliveryReceipt = {
      providerMessageId: 'msg_2',
      status: 'failed',
      timestamp: new Date(),
      errorCode: 'INVALID_RECIPIENT',
      errorMessage: 'Phone not registered',
    };
    expect(success.errorCode).toBeUndefined();
    expect(failure.errorCode).toBe('INVALID_RECIPIENT');
  });

  it('all ChannelType values are valid', () => {
    const allTypes: ChannelType[] = [
      'web',
      'mobile_ios',
      'mobile_android',
      'voice',
      'sms',
      'whatsapp',
      'email',
      'facebook',
      'ms_teams',
      'api',
    ];
    expect(allTypes).toHaveLength(10);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/runtime && npx vitest run src/__tests__/contexts/channel/channel-types.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `apps/runtime/src/contexts/channel/domain/channel-types.ts` with all types from design doc Section 4.2. This is a types-only file — copy verbatim from the design doc.

**Step 4: Run test to verify it passes**

Run: `cd apps/runtime && npx vitest run src/__tests__/contexts/channel/channel-types.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/runtime/src/contexts/channel/domain/channel-types.ts apps/runtime/src/__tests__/contexts/channel/channel-types.test.ts
git commit -m "feat(channel): add channel domain types"
```

---

### Task 2: ChannelAdapter Port Interface

**Files:**

- Create: `apps/runtime/src/contexts/channel/domain/channel-adapter.ts`
- Test: `apps/runtime/src/__tests__/contexts/channel/channel-adapter.test.ts`

**Step 1: Write the test**

Test that a mock adapter implementing the interface can be instantiated and called. Test each method group (inbound, outbound, streaming, actions, delivery, lifecycle).

```typescript
import { describe, it, expect, vi } from 'vitest';
import type { ChannelAdapter } from '../../../contexts/channel/domain/channel-adapter.js';
import type {
  ChannelType,
  OutboundEnvelope,
  StreamChunk,
  SessionRef,
} from '../../../contexts/channel/domain/channel-types.js';

const createMockAdapter = (type: ChannelType): ChannelAdapter => ({
  channelType: type,
  normalizeInbound: vi.fn().mockReturnValue({
    success: true,
    message: {
      channelType: type,
      text: 'hi',
      media: [],
      metadata: {},
      senderArtifact: null,
      timestamp: new Date(),
      providerMessageId: null,
    },
  }),
  extractArtifact: vi.fn().mockReturnValue(null),
  verifyWebhookSignature: vi.fn().mockReturnValue(true),
  sendMessage: vi.fn().mockResolvedValue({ success: true, providerMessageId: 'pm_1' }),
  openStream: vi.fn().mockReturnValue({
    sessionRef: { sessionId: 's1', tenantId: 't1', channelId: 'c1' },
    channelType: type,
    handle: {},
  }),
  sendStreamChunk: vi.fn().mockResolvedValue(undefined),
  closeStream: vi.fn().mockResolvedValue(undefined),
  sendAction: vi.fn().mockResolvedValue({ success: true }),
  sendPresence: vi.fn().mockResolvedValue(undefined),
  parseDeliveryStatus: vi.fn().mockReturnValue(null),
  initialize: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
});

describe('ChannelAdapter interface', () => {
  it('normalizeInbound returns InboundResult', () => {
    const adapter = createMockAdapter('web');
    const result = adapter.normalizeInbound({}, {});
    expect(result.success).toBe(true);
    expect(result.message?.channelType).toBe('web');
  });

  it('sendMessage returns SendResult', async () => {
    const adapter = createMockAdapter('sms');
    const envelope: OutboundEnvelope = {
      recipientArtifact: 'hash',
      text: 'hi',
      richContent: null,
      media: [],
      metadata: {},
      replyToMessageId: null,
    };
    const result = await adapter.sendMessage(envelope, {} as any);
    expect(result.success).toBe(true);
  });

  it('streaming lifecycle: open -> chunk -> close', async () => {
    const adapter = createMockAdapter('web');
    const ref: SessionRef = { sessionId: 's1', tenantId: 't1', channelId: 'c1' };
    const handle = adapter.openStream(ref, {} as any);
    expect(handle.channelType).toBe('web');
    const chunk: StreamChunk = { type: 'text_delta', content: 'hello' };
    await adapter.sendStreamChunk(handle, chunk);
    await adapter.closeStream(handle);
    expect(adapter.sendStreamChunk).toHaveBeenCalledWith(handle, chunk);
    expect(adapter.closeStream).toHaveBeenCalledWith(handle);
  });

  it('lifecycle: initialize and shutdown', async () => {
    const adapter = createMockAdapter('whatsapp');
    await adapter.initialize({} as any);
    await adapter.shutdown();
    expect(adapter.initialize).toHaveBeenCalled();
    expect(adapter.shutdown).toHaveBeenCalled();
  });
});
```

**Step 2: Run test — expect FAIL** (module not found)

**Step 3: Write `channel-adapter.ts`** — the interface from design doc Section 4.1. Import types from `./channel-types.js`. Also add `ChannelConfig` interface:

```typescript
export interface ChannelConfig {
  channelId: string;
  tenantId: string;
  projectId: string;
  providerConfig: Record<string, unknown>;
  secretKey: string | null;
  hmacEnforcement: 'disabled' | 'optional' | 'required';
}
```

**Step 4: Run test — expect PASS**

**Step 5: Commit**

```bash
git add apps/runtime/src/contexts/channel/domain/channel-adapter.ts apps/runtime/src/__tests__/contexts/channel/channel-adapter.test.ts
git commit -m "feat(channel): add ChannelAdapter port interface"
```

---

### Task 3: AdapterRegistry + Placeholder Adapters

**Files:**

- Create: `apps/runtime/src/contexts/channel/infrastructure/adapter-registry.ts`
- Create: `apps/runtime/src/contexts/channel/infrastructure/adapters/base-adapter.ts`
- Create: `apps/runtime/src/contexts/channel/infrastructure/adapters/web-adapter.ts`
- Create: `apps/runtime/src/contexts/channel/infrastructure/adapters/sms-adapter.ts`
- Create: `apps/runtime/src/contexts/channel/infrastructure/adapters/whatsapp-adapter.ts`
- Create: `apps/runtime/src/contexts/channel/infrastructure/adapters/email-adapter.ts`
- Create: `apps/runtime/src/contexts/channel/infrastructure/adapters/facebook-adapter.ts`
- Create: `apps/runtime/src/contexts/channel/infrastructure/adapters/ms-teams-adapter.ts`
- Create: `apps/runtime/src/contexts/channel/infrastructure/adapters/voice-adapter.ts`
- Create: `apps/runtime/src/contexts/channel/infrastructure/adapters/api-adapter.ts`
- Test: `apps/runtime/src/__tests__/contexts/channel/adapter-registry.test.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect } from 'vitest';
import { AdapterRegistry } from '../../../contexts/channel/infrastructure/adapter-registry.js';
import type { ChannelAdapter } from '../../../contexts/channel/domain/channel-adapter.js';

describe('AdapterRegistry', () => {
  it('registers and retrieves an adapter', () => {
    const registry = new AdapterRegistry();
    const adapter = { channelType: 'web' } as ChannelAdapter;
    registry.register(adapter);
    expect(registry.get('web')).toBe(adapter);
  });

  it('has() returns false for unregistered type', () => {
    const registry = new AdapterRegistry();
    expect(registry.has('sms')).toBe(false);
  });

  it('get() throws for unregistered type', () => {
    const registry = new AdapterRegistry();
    expect(() => registry.get('sms')).toThrow();
  });

  it('all() returns every registered adapter', () => {
    const registry = new AdapterRegistry();
    const a1 = { channelType: 'web' } as ChannelAdapter;
    const a2 = { channelType: 'sms' } as ChannelAdapter;
    registry.register(a1);
    registry.register(a2);
    expect(registry.all()).toHaveLength(2);
  });
});
```

**Step 2: Run test — expect FAIL**

**Step 3: Implement AdapterRegistry**

```typescript
import type { ChannelAdapter } from '../domain/channel-adapter.js';
import type { ChannelType } from '../domain/channel-types.js';

export class AdapterRegistry {
  private adapters = new Map<ChannelType, ChannelAdapter>();

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.channelType, adapter);
  }

  get(type: ChannelType): ChannelAdapter {
    const adapter = this.adapters.get(type);
    if (!adapter) {
      throw new Error(`No adapter registered for channel type: ${type}`);
    }
    return adapter;
  }

  has(type: ChannelType): boolean {
    return this.adapters.has(type);
  }

  all(): ChannelAdapter[] {
    return Array.from(this.adapters.values());
  }
}
```

**Step 3b: Create `base-adapter.ts`** — abstract class with NotImplemented defaults for placeholder adapters:

```typescript
import type { ChannelAdapter, ChannelConfig } from '../domain/channel-adapter.js';
import type {
  ChannelType,
  InboundResult,
  ArtifactExtraction,
  OutboundEnvelope,
  SendResult,
  SessionRef,
  StreamHandle,
  StreamChunk,
  ActionPayload,
  PresenceType,
  DeliveryReceipt,
} from '../domain/channel-types.js';

export abstract class BaseAdapter implements ChannelAdapter {
  abstract readonly channelType: ChannelType;

  normalizeInbound(_raw: unknown, _headers: Record<string, string>): InboundResult {
    return {
      success: false,
      error: { code: 'NOT_IMPLEMENTED', message: `${this.channelType} inbound not implemented` },
    };
  }

  extractArtifact(_raw: unknown): ArtifactExtraction | null {
    return null;
  }

  verifyWebhookSignature(
    _raw: unknown,
    _headers: Record<string, string>,
    _secret: string,
  ): boolean {
    return false;
  }

  async sendMessage(_envelope: OutboundEnvelope, _config: ChannelConfig): Promise<SendResult> {
    return {
      success: false,
      error: {
        code: 'NOT_IMPLEMENTED',
        message: `${this.channelType} sendMessage not implemented`,
      },
    };
  }

  openStream(sessionRef: SessionRef, _config: ChannelConfig): StreamHandle {
    return { sessionRef, channelType: this.channelType, handle: null };
  }

  async sendStreamChunk(_handle: StreamHandle, _chunk: StreamChunk): Promise<void> {}

  async closeStream(_handle: StreamHandle): Promise<void> {}

  async sendAction(_action: ActionPayload, _config: ChannelConfig): Promise<SendResult> {
    return {
      success: false,
      error: { code: 'NOT_IMPLEMENTED', message: `${this.channelType} sendAction not implemented` },
    };
  }

  async sendPresence(
    _type: PresenceType,
    _ref: SessionRef,
    _config: ChannelConfig,
  ): Promise<void> {}

  parseDeliveryStatus(_raw: unknown, _headers: Record<string, string>): DeliveryReceipt | null {
    return null;
  }

  async initialize(_config: ChannelConfig): Promise<void> {}

  async shutdown(): Promise<void> {}
}
```

**Step 3c: Create each adapter file** — each extends `BaseAdapter` with just `channelType` set. Example for `sms-adapter.ts`:

```typescript
import { BaseAdapter } from './base-adapter.js';
import type { ChannelType } from '../../domain/channel-types.js';

export class SmsAdapter extends BaseAdapter {
  readonly channelType: ChannelType = 'sms';
}
```

Create the same for: `WhatsappAdapter`, `EmailAdapter`, `FacebookAdapter`, `MsTeamsAdapter`, `VoiceAdapter`, `ApiAdapter`, `WebAdapter`. Each is ~5 lines.

**Step 4: Run test — expect PASS**

**Step 5: Commit**

```bash
git add apps/runtime/src/contexts/channel/
git commit -m "feat(channel): add AdapterRegistry + placeholder adapters for all channel types"
```

---

### Task 4: Channel Use Cases + Webhook Router

**Files:**

- Create: `apps/runtime/src/contexts/channel/use-cases/receive-inbound-message.ts`
- Create: `apps/runtime/src/contexts/channel/use-cases/send-outbound-message.ts`
- Create: `apps/runtime/src/contexts/channel/use-cases/stream-response.ts`
- Create: `apps/runtime/src/contexts/channel/use-cases/handle-delivery-status.ts`
- Create: `apps/runtime/src/contexts/channel/infrastructure/webhook-router.ts`
- Create: `apps/runtime/src/contexts/channel/index.ts`
- Test: `apps/runtime/src/__tests__/contexts/channel/receive-inbound-message.test.ts`
- Test: `apps/runtime/src/__tests__/contexts/channel/webhook-router.test.ts`

**Step 1: Write tests**

Test `ReceiveInboundMessage` — accepts adapter + raw payload, returns normalized `ChannelMessage` + extracted artifact. Use mock adapter from Task 2 pattern.

Test `WebhookRouter` — Express router that dispatches `POST /webhooks/:channelType/:channelId` to the correct adapter. Use supertest or mock req/res.

**Step 2: Run tests — expect FAIL**

**Step 3: Implement**

`ReceiveInboundMessage`: ~30 lines. Takes `AdapterRegistry` in constructor. Method `execute(channelType, raw, headers)` calls `adapter.normalizeInbound()` + `adapter.extractArtifact()`, returns both.

`SendOutboundMessage`: ~20 lines. Takes `AdapterRegistry`. Method `execute(channelType, envelope, config)` calls `adapter.sendMessage()`.

`StreamResponse`: ~30 lines. Wraps open/chunk/close lifecycle.

`HandleDeliveryStatus`: ~15 lines. Takes `AdapterRegistry`. Calls `adapter.parseDeliveryStatus()`.

`WebhookRouter`: Express `Router`. Route `POST /webhooks/:channelType/:channelId`. Loads channel config from DB (via `channel-repo.ts:findSDKChannelById`), verifies webhook signature, calls `ReceiveInboundMessage`, returns 200.

`index.ts`: Re-exports all public types and classes.

**Step 4: Run tests — expect PASS**

**Step 5: Commit**

```bash
git add apps/runtime/src/contexts/channel/ apps/runtime/src/__tests__/contexts/channel/
git commit -m "feat(channel): add use cases, webhook router, and context index"
```

---

## Phase 2: Identity Context Domain + Verifiers

### Task 5: Identity Domain Types

**Files:**

- Create: `apps/runtime/src/contexts/identity/domain/identity-artifact.ts`
- Create: `apps/runtime/src/contexts/identity/domain/identity-tier.ts`
- Create: `apps/runtime/src/contexts/identity/domain/verification-attempt.ts`
- Create: `apps/runtime/src/contexts/identity/domain/session-resolution-key.ts`
- Create: `apps/runtime/src/contexts/identity/domain/identity-verifier.ts`
- Test: `apps/runtime/src/__tests__/contexts/identity/identity-domain.test.ts`

**Step 1: Write the test**

Test `IdentityArtifact.hash()` produces a consistent SHA-256 hex string. Test `IdentityTier.canPromoteTo()` rules (0->1, 0->2, 1->2 allowed; 2->1 not). Test `VerificationAttempt` status transitions.

**Step 2: Run — FAIL**

**Step 3: Implement**

`identity-artifact.ts`: Value object with `rawValue`, `artifactType`, `hashedValue`. Static `hash(raw: string): string` using existing `hashArtifact` from `services/identity/artifact-hasher.ts` — but as a pure function (import `crypto` directly, no infra dependency). ~25 lines.

`identity-tier.ts`: `IdentityTier` type (0|1|2), `canPromoteTo(current, target)` function, `tierFromVerification(method)` function. ~30 lines.

`verification-attempt.ts`: Interface + factory. Status enum: `pending | verified | expired | failed`. ~40 lines.

`session-resolution-key.ts`: Value object: `tenantId + channelId + artifactHash -> sessionId`. ~15 lines.

`identity-verifier.ts`: The `IdentityVerifier` port interface from design doc Section 5.1. Types only. ~50 lines.

**Step 4: Run — PASS**

**Step 5: Commit**

```bash
git add apps/runtime/src/contexts/identity/domain/ apps/runtime/src/__tests__/contexts/identity/
git commit -m "feat(identity): add identity domain types and verifier port"
```

---

### Task 6: Identity Use Cases (Verify, Resolve, Promote)

**Files:**

- Create: `apps/runtime/src/contexts/identity/use-cases/verify-identity.ts`
- Create: `apps/runtime/src/contexts/identity/use-cases/resolve-session.ts`
- Create: `apps/runtime/src/contexts/identity/use-cases/register-resolution-key.ts`
- Create: `apps/runtime/src/contexts/identity/use-cases/promote-tier.ts`
- Test: `apps/runtime/src/__tests__/contexts/identity/verify-identity.test.ts`
- Test: `apps/runtime/src/__tests__/contexts/identity/resolve-session.test.ts`
- Test: `apps/runtime/src/__tests__/contexts/identity/promote-tier.test.ts`

**Step 1: Write tests**

`verify-identity.test.ts`: Mock verifier registry (Map<VerificationMethod, IdentityVerifier>). Test dispatch to correct verifier. Test fallback when no verifier supports input.

`resolve-session.test.ts`: Wraps existing `resolveSession` from `services/identity/session-resolver.ts` but accepts ports instead of concrete store. Test: artifact found -> returns existing session. Test: no match -> returns create-new signal.

`promote-tier.test.ts`: Test tier 1->2 with valid proof. Test tier 2->2 (no-op). Test tier 2->1 (rejected).

**Step 2: Run — FAIL**

**Step 3: Implement**

`verify-identity.ts`: Takes `Map<VerificationMethod, IdentityVerifier>` in constructor. `execute(input)` finds verifier via `supports()`, calls `initiate()`. ~35 lines.

`resolve-session.ts`: Thin wrapper around existing `resolveSession()` from `apps/runtime/src/services/identity/session-resolver.ts`. Accepts a `SessionResolutionStore` port (matches existing `SessionStore` interface). ~20 lines.

`register-resolution-key.ts`: Wraps existing `registerResolutionKey()`. ~15 lines.

`promote-tier.ts`: Pure domain logic. Validates promotion rules, returns updated session fields. ~30 lines.

**Step 4: Run — PASS**

**Step 5: Commit**

```bash
git add apps/runtime/src/contexts/identity/use-cases/ apps/runtime/src/__tests__/contexts/identity/
git commit -m "feat(identity): add verify, resolve, promote use cases"
```

---

### Task 7: HMAC Verifier (relocate existing code)

**Files:**

- Create: `apps/runtime/src/contexts/identity/infrastructure/verifiers/hmac-verifier.ts`
- Test: `apps/runtime/src/__tests__/contexts/identity/hmac-verifier.test.ts`

**Step 1: Write the test**

Test `HmacVerifier.initiate()` with valid HMAC -> returns immediate verified result. Test with invalid HMAC -> returns immediate rejected. Test with expired timestamp -> rejected. Test `supports()` returns true for hmac method.

**Reference:** Existing tests at `apps/runtime/src/__tests__/session-identity-integration.test.ts` (HMAC Enforcement Modes section) — adapt those patterns.

**Step 2: Run — FAIL**

**Step 3: Implement**

Relocate logic from `apps/runtime/src/services/identity/artifact-hasher.ts` (the `verifyHMAC` function) into `HmacVerifier` class implementing `IdentityVerifier`. The original function stays for backward compat; `HmacVerifier` calls it internally. ~50 lines.

**Step 4: Run — PASS**

**Step 5: Commit**

```bash
git add apps/runtime/src/contexts/identity/infrastructure/verifiers/hmac-verifier.ts apps/runtime/src/__tests__/contexts/identity/hmac-verifier.test.ts
git commit -m "feat(identity): add HmacVerifier wrapping existing HMAC logic"
```

---

### Task 8: Install new libraries + OTP Verifier

**Files:**

- Modify: `apps/runtime/package.json` (add otplib, @oslojs/crypto, arctic)
- Create: `apps/runtime/src/contexts/identity/infrastructure/verifiers/otp-verifier.ts`
- Create: `apps/runtime/src/contexts/identity/infrastructure/verification-token-store.ts`
- Test: `apps/runtime/src/__tests__/contexts/identity/otp-verifier.test.ts`

**Step 1: Install dependencies**

```bash
cd apps/runtime && pnpm add otplib @oslojs/crypto arctic
```

**Step 2: Write the test**

Test `OtpVerifier.initiate()` -> creates verification attempt in token store, returns `userAction: 'enter_otp'`. Test `OtpVerifier.complete()` with correct code -> verified. Test with wrong code -> failed. Test with expired attempt -> expired. Test rate limiting (>5 attempts -> rejected).

Mock the `VerificationTokenStore` (Redis) as an in-memory Map for tests.

**Step 3: Run — FAIL**

**Step 4: Implement**

`verification-token-store.ts`: Redis-backed store. Methods: `create(attempt)`, `get(tenantId, attemptId)`, `atomicVerify(tenantId, attemptId, hashedCode)` (Lua script for single-use), `incrementAttempts(tenantId, attemptId)`. Key pattern: `verification:{tenantId}:{attemptId}`. TTL per method. ~80 lines.

`otp-verifier.ts`: Uses `otplib.hotp` to generate 6-digit codes. `initiate()` generates secret + code, hashes code with HMAC, stores in token store, returns attemptId. `complete()` hashes submitted code, calls `atomicVerify()`. ~60 lines.

**Note:** The actual sending of OTP (SMS/email) is NOT this verifier's job — it returns the code to the orchestration layer which dispatches via channel adapter. This keeps the verifier infrastructure-light.

**Step 5: Run — PASS**

**Step 6: Commit**

```bash
git add apps/runtime/package.json pnpm-lock.yaml apps/runtime/src/contexts/identity/infrastructure/ apps/runtime/src/__tests__/contexts/identity/
git commit -m "feat(identity): add OTP verifier with otplib + verification token store"
```

---

### Task 9: Email Link Verifier

**Files:**

- Create: `apps/runtime/src/contexts/identity/infrastructure/verifiers/email-link-verifier.ts`
- Test: `apps/runtime/src/__tests__/contexts/identity/email-link-verifier.test.ts`

**Step 1: Write the test**

Test `initiate()` -> generates token, stores hashed version, returns `userAction: 'check_email'`. Test `complete()` with valid token -> verified. Test with already-used token -> rejected. Test with expired token -> expired.

**Step 2: Run — FAIL**

**Step 3: Implement**

Uses `crypto.randomBytes(32)` for token generation, HMAC-SHA256 for hashing (via `@oslojs/crypto` or native `crypto`). Stores hash in `VerificationTokenStore` with 1-hour TTL. ~50 lines.

**Step 4: Run — PASS**

**Step 5: Commit**

```bash
git add apps/runtime/src/contexts/identity/infrastructure/verifiers/email-link-verifier.ts apps/runtime/src/__tests__/contexts/identity/
git commit -m "feat(identity): add email link verifier"
```

---

### Task 10: OAuth Verifier (Arctic v3)

**Files:**

- Create: `apps/runtime/src/contexts/identity/infrastructure/verifiers/oauth-verifier.ts`
- Test: `apps/runtime/src/__tests__/contexts/identity/oauth-verifier.test.ts`

**Step 1: Write the test**

Test `initiate()` -> returns `userAction: 'redirect'` + `redirectUrl`. Test `complete()` with valid OAuth callback code -> exchanges for token, extracts email, returns verified. Test with invalid code -> rejected. Mock Arctic provider.

**Step 2: Run — FAIL**

**Step 3: Implement**

Uses Arctic v3 provider instances (Google, Microsoft, GitHub). `initiate()` generates state + PKCE, stores in token store, returns authorization URL. `complete()` exchanges code for tokens, calls userinfo endpoint, extracts verified email. ~70 lines.

Provider instances created per-tenant (credentials from channel config).

**Step 4: Run — PASS**

**Step 5: Commit**

```bash
git add apps/runtime/src/contexts/identity/infrastructure/verifiers/oauth-verifier.ts apps/runtime/src/__tests__/contexts/identity/
git commit -m "feat(identity): add OAuth verifier with Arctic v3"
```

---

### Task 11: Provider Verifier + Webhook Verifier

**Files:**

- Create: `apps/runtime/src/contexts/identity/infrastructure/verifiers/provider-verifier.ts`
- Create: `apps/runtime/src/contexts/identity/infrastructure/verifiers/webhook-verifier.ts`
- Test: `apps/runtime/src/__tests__/contexts/identity/provider-verifier.test.ts`

**Step 1: Write the test**

`ProviderVerifier`: Test that WhatsApp phone artifact with `providerVerified: true` -> immediate verified result. Test with `providerVerified: false` -> rejected.

`WebhookVerifier`: Test `initiate()` -> calls customer webhook URL with challenge, stores attempt. Test `complete()` -> verifies webhook response.

**Step 2: Run — FAIL**

**Step 3: Implement**

`provider-verifier.ts`: Sync verifier. If `ArtifactExtraction.providerVerified === true`, the artifact itself IS the proof. ~25 lines.

`webhook-verifier.ts`: Async verifier. `initiate()` POSTs to customer-configured webhook URL. `complete()` verifies response token. ~40 lines.

**Step 4: Run — PASS**

**Step 5: Commit**

```bash
git add apps/runtime/src/contexts/identity/infrastructure/verifiers/ apps/runtime/src/__tests__/contexts/identity/
git commit -m "feat(identity): add provider + webhook verifiers"
```

---

### Task 12: Resolution Key Store (Redis) + Identity Index

**Files:**

- Create: `apps/runtime/src/contexts/identity/infrastructure/resolution-key-store.ts`
- Create: `apps/runtime/src/contexts/identity/index.ts`
- Test: `apps/runtime/src/__tests__/contexts/identity/resolution-key-store.test.ts`

**Step 1: Write test** — mock Redis client. Test `register()` sets key with TTL. Test `resolve()` returns sessionId. Test `remove()` deletes key.

**Step 2: Run — FAIL**

**Step 3: Implement**

Wraps existing pattern from `session-resolver.ts`. Key: `session_resolution:{tenantId}:{channelId}:{artifactHash}`. Uses `getRedisClient()` singleton. ~50 lines.

`index.ts`: Re-exports all domain types, use cases, and creates a `createIdentityContext(deps)` factory function that wires verifiers + stores.

**Step 4: Run — PASS**

**Step 5: Commit**

```bash
git add apps/runtime/src/contexts/identity/ apps/runtime/src/__tests__/contexts/identity/
git commit -m "feat(identity): add resolution key store, context index"
```

---

## Phase 3: Contact Context

### Task 13: Contact Encryptor (HKDF + Blind Indexes)

**Files:**

- Create: `apps/runtime/src/contexts/contact/infrastructure/contact-encryptor.ts`
- Test: `apps/runtime/src/__tests__/contexts/contact/contact-encryptor.test.ts`

**Step 1: Write the test**

Test `encrypt(tenantId, plaintext)` -> returns ciphertext. Test `decrypt(tenantId, ciphertext)` -> returns original. Test `blindIndex(tenantId, value)` -> consistent hash. Test different tenants produce different blind indexes for same value. Test email normalization (case, whitespace). Test phone normalization (E.164).

**Step 2: Run — FAIL**

**Step 3: Implement**

```typescript
import { getEncryptionService } from '../../../services/encryption-service.js';
import crypto from 'node:crypto';

const BLIND_KEY_INFO = 'blind-index-key';

export class ContactEncryptor {
  encrypt(tenantId: string, plaintext: string): string {
    return getEncryptionService().encryptForTenant(plaintext, tenantId);
  }

  decrypt(tenantId: string, ciphertext: string): string {
    return getEncryptionService().decryptForTenant(ciphertext, tenantId);
  }

  blindIndex(tenantId: string, value: string): string {
    const key = this.deriveBlindKey(tenantId);
    return crypto.createHmac('sha256', key).update(value).digest('hex');
  }

  normalizeIdentity(type: 'email' | 'phone' | 'external', value: string): string {
    if (type === 'email') return value.toLowerCase().trim();
    if (type === 'phone') return this.toE164(value);
    return value;
  }

  private deriveBlindKey(tenantId: string): Buffer {
    // HKDF: derive a separate key for blind indexes (not the encryption key)
    return crypto.hkdfSync(
      'sha256',
      getEncryptionService().getMasterKeyBuffer(),
      `blind:${tenantId}`,
      BLIND_KEY_INFO,
      32,
    );
  }

  private toE164(phone: string): string {
    const digits = phone.replace(/[^\d+]/g, '');
    return digits.startsWith('+') ? digits : `+${digits}`;
  }
}
```

**Note:** This requires adding `getMasterKeyBuffer()` as a public method on `EncryptionService` (returns the raw master key buffer for HKDF derivation). Alternatively, use a separate HKDF master passed via config. Prefer the config approach to avoid exposing master key.

**Step 4: Run — PASS**

**Step 5: Commit**

```bash
git add apps/runtime/src/contexts/contact/infrastructure/contact-encryptor.ts apps/runtime/src/__tests__/contexts/contact/
git commit -m "feat(contact): add ContactEncryptor with HKDF blind indexes"
```

---

### Task 14: Contact Domain + Repository Port

**Files:**

- Create: `apps/runtime/src/contexts/contact/domain/contact.ts`
- Create: `apps/runtime/src/contexts/contact/domain/contact-identity.ts`
- Create: `apps/runtime/src/contexts/contact/domain/contact-repository.ts`
- Create: `apps/runtime/src/contexts/contact/domain/merge-suggestion.ts`
- Create: `apps/runtime/src/contexts/contact/domain/merge-execution.ts`
- Test: `apps/runtime/src/__tests__/contexts/contact/contact-domain.test.ts`

**Step 1: Write test** — type satisfaction tests for all domain interfaces. Test `ContactIdentity` value object creation.

**Step 2: Run — FAIL**

**Step 3: Implement** — all interfaces from design doc Section 6.1, 6.2, 7.2.

**Step 4: Run — PASS**

**Step 5: Commit**

```bash
git add apps/runtime/src/contexts/contact/domain/ apps/runtime/src/__tests__/contexts/contact/
git commit -m "feat(contact): add contact domain types and repository port"
```

---

### Task 15: Contact MongoDB Repository

**Files:**

- Modify: `packages/database/src/models/contact.model.ts` (update schema for encrypted identities)
- Create: `apps/runtime/src/contexts/contact/infrastructure/contact-mongo-repository.ts`
- Test: `apps/runtime/src/__tests__/contexts/contact/contact-mongo-repository.test.ts`

**Step 1: Write test** — mock Mongoose model (chainable pattern from `repos.test.ts`). Test `findByBlindIndex` queries correctly. Test `create` sets all fields. Test `addIdentity` uses `$push`. Test `linkSession` updates channel history.

**Step 2: Run — FAIL**

**Step 3: Implement**

Update `contact.model.ts`: Replace flat `identity`/`identityType` with `identities` array subdocument containing `{ type, encryptedValue, blindIndex, verified, verifiedAt, verifiedVia, channel }`. Add `channelHistory`, `mergedInto`, `sessionCount` fields. Add indexes from design doc Section 6.4.

Implement `ContactMongoRepository` implementing `ContactRepository` port. Uses Mongoose `Contact` model. All queries include `tenantId` filter (tenant isolation). ~120 lines.

**Step 4: Run — PASS**

**Step 5: Commit**

```bash
git add packages/database/src/models/contact.model.ts apps/runtime/src/contexts/contact/infrastructure/contact-mongo-repository.ts apps/runtime/src/__tests__/contexts/contact/
git commit -m "feat(contact): update Contact schema, add MongoDB repository"
```

---

### Task 16: Contact Use Cases

**Files:**

- Create: `apps/runtime/src/contexts/contact/use-cases/resolve-or-create-contact.ts`
- Create: `apps/runtime/src/contexts/contact/use-cases/link-session-to-contact.ts`
- Create: `apps/runtime/src/contexts/contact/use-cases/detect-merge-candidates.ts`
- Create: `apps/runtime/src/contexts/contact/use-cases/execute-merge.ts`
- Create: `apps/runtime/src/contexts/contact/use-cases/self-merge.ts`
- Create: `apps/runtime/src/contexts/contact/use-cases/cascade-delete-contact.ts`
- Create: `apps/runtime/src/contexts/contact/index.ts`
- Test: `apps/runtime/src/__tests__/contexts/contact/resolve-or-create-contact.test.ts`
- Test: `apps/runtime/src/__tests__/contexts/contact/execute-merge.test.ts`
- Test: `apps/runtime/src/__tests__/contexts/contact/cascade-delete-contact.test.ts`

**Step 1: Write tests**

`resolve-or-create-contact.test.ts`: Mock `ContactRepository` + `ContactEncryptor`. Test: blind index matches existing contact -> returns it. Test: no match -> creates new contact with encrypted identity. Test: tenant isolation (different tenant same identity -> different contacts).

`execute-merge.test.ts`: Test: identities moved from secondary -> primary. Test: sessions updated. Test: secondary marked `mergedInto`. Test: duplicate blind indexes deduplicated.

`cascade-delete-contact.test.ts`: Test: all sessions deleted. Test: contact hard-deleted. Test: audit event emitted.

**Step 2: Run — FAIL**

**Step 3: Implement**

Each use case takes ports in constructor (`ContactRepository`, `ContactEncryptor`, `SessionRepository` where needed). Follow design doc Sections 7.1-7.3 and 9.1.

`resolve-or-create-contact.ts`: ~40 lines. Normalize -> blind index -> lookup -> create if missing.

`link-session-to-contact.ts`: ~25 lines. Update session.contactId + contact.channelHistory.

`detect-merge-candidates.ts`: ~30 lines. For each identity on contact, search other contacts by blind index.

`execute-merge.ts`: ~60 lines. Move identities, update sessions, merge metadata, soft-delete secondary.

`self-merge.ts`: ~35 lines. Verify identity -> find existing contact by blind index -> merge or add identity.

`cascade-delete-contact.ts`: ~50 lines. Load sessions -> delete messages/traces/resolution keys -> hard-delete contact.

`index.ts`: Re-export + `createContactContext(deps)` factory.

**Step 4: Run — PASS**

**Step 5: Commit**

```bash
git add apps/runtime/src/contexts/contact/ apps/runtime/src/__tests__/contexts/contact/
git commit -m "feat(contact): add all contact use cases + context index"
```

---

## Phase 4: Orchestration + Jobs

### Task 17: InitializeSession Orchestrator

**Files:**

- Create: `apps/runtime/src/contexts/orchestration/use-cases/initialize-session.ts`
- Test: `apps/runtime/src/__tests__/contexts/orchestration/initialize-session.test.ts`

**Step 1: Write the test**

Test the full hot path: channel adapter extracts artifact -> identity resolves session (new) -> CallerContext built -> session created -> resolution key registered. Test: tier 2 -> contact resolved/created + linked. Test: tier 0 -> no contact created.

Mock all dependencies (adapter, identity use cases, contact use cases).

**Step 2: Run — FAIL**

**Step 3: Implement**

Composes `ReceiveInboundMessage`, `ResolveSession`, `RegisterResolutionKey`, `ResolveOrCreateContact`, `LinkSessionToContact`. Flow from design doc Section 8.1. ~60 lines.

**Step 4: Run — PASS**

**Step 5: Commit**

```bash
git add apps/runtime/src/contexts/orchestration/ apps/runtime/src/__tests__/contexts/orchestration/
git commit -m "feat(orchestration): add InitializeSession use case"
```

---

### Task 18: PromoteAndLink Orchestrator

**Files:**

- Create: `apps/runtime/src/contexts/orchestration/use-cases/promote-and-link.ts`
- Test: `apps/runtime/src/__tests__/contexts/orchestration/promote-and-link.test.ts`

**Step 1: Write test** — verification completes -> tier promoted -> contact created -> session linked -> back-link job enqueued.

**Step 2: Run — FAIL**

**Step 3: Implement** — composes `PromoteTier`, `ResolveOrCreateContact`, `LinkSessionToContact`, enqueues BullMQ back-link job. ~40 lines.

**Step 4: Run — PASS**

**Step 5: Commit**

```bash
git add apps/runtime/src/contexts/orchestration/ apps/runtime/src/__tests__/contexts/orchestration/
git commit -m "feat(orchestration): add PromoteAndLink use case"
```

---

### Task 19: SwitchChannel Orchestrator

**Files:**

- Create: `apps/runtime/src/contexts/orchestration/use-cases/switch-channel.ts`
- Test: `apps/runtime/src/__tests__/contexts/orchestration/switch-channel.test.ts`

**Step 1: Write test** — tier 2 user on new channel -> contact found -> session created + linked. Test `resumeCrossChannel: true` carries context. Test `resumeCrossChannel: false` creates fresh.

**Step 2: Run — FAIL**

**Step 3: Implement** — flow from design doc Section 8.3. ~50 lines.

**Step 4: Run — PASS**

**Step 5: Commit**

```bash
git add apps/runtime/src/contexts/orchestration/ apps/runtime/src/__tests__/contexts/orchestration/
git commit -m "feat(orchestration): add SwitchChannel use case"
```

---

### Task 20: BullMQ Jobs (BackLink + MergeDetection)

**Files:**

- Create: `apps/runtime/src/contexts/orchestration/jobs/back-link-sessions.ts`
- Create: `apps/runtime/src/contexts/orchestration/jobs/detect-merge-candidates.ts`
- Create: `apps/runtime/src/contexts/orchestration/index.ts`
- Test: `apps/runtime/src/__tests__/contexts/orchestration/back-link-sessions.test.ts`

**Step 1: Write test** — mock BullMQ Queue/Worker. Test back-link job: finds sessions by artifact -> updates contactId on each. Test merge detection: finds overlapping contacts -> creates MergeSuggestion.

**Step 2: Run — FAIL**

**Step 3: Implement**

Follow existing BullMQ pattern from `llm-queue.ts`:

- Lazy init with `getRedisClient().duplicate()`
- Queue name: `identity-back-link`, `merge-detection`
- Job data: `{ tenantId, contactId, channelArtifact }` for back-link; `{ tenantId, contactId }` for merge detection
- Worker concurrency: 3 (low priority background work)
- Retry: 3 attempts with exponential backoff
- `removeOnComplete: { count: 500 }`

`index.ts`: Re-export + `createOrchestrationContext(deps)` factory.

**Step 4: Run — PASS**

**Step 5: Commit**

```bash
git add apps/runtime/src/contexts/orchestration/ apps/runtime/src/__tests__/contexts/orchestration/
git commit -m "feat(orchestration): add BullMQ back-link + merge detection jobs"
```

---

## Phase 5: API Routes + Wiring

### Task 21: Identity Verification API Routes

**Files:**

- Create: `apps/runtime/src/routes/identity-verification.ts`
- Modify: `apps/runtime/src/routes/index.ts` (register new routes)
- Test: `apps/runtime/src/__tests__/contexts/identity/verification-routes.test.ts`

**Step 1: Write test** — mock auth middleware + use cases. Test `POST /api/identity/verify/initiate` -> 200 with attemptId. Test `POST /api/identity/verify/complete` -> 200 with verified=true. Test `GET /api/identity/verify/:attemptId` -> 200 with status.

**Step 2: Run — FAIL**

**Step 3: Implement**

Express router. Uses `requireAuth` middleware (SDK session or API key). Calls `VerifyIdentity` use case. ~60 lines.

**Step 4: Run — PASS**

**Step 5: Commit**

```bash
git add apps/runtime/src/routes/identity-verification.ts apps/runtime/src/routes/index.ts apps/runtime/src/__tests__/contexts/identity/
git commit -m "feat(api): add identity verification routes"
```

---

### Task 22: Contact Merge + GDPR API Routes

**Files:**

- Modify: `apps/runtime/src/routes/contacts.ts` (add merge, self-merge, GDPR endpoints)
- Create: `apps/runtime/src/routes/merge-suggestions.ts`
- Test: `apps/runtime/src/__tests__/contexts/contact/merge-routes.test.ts`

**Step 1: Write test** — Test `POST /api/contacts/merge` with admin auth -> 200. Test `GET /api/contacts/merge-suggestions` -> returns suggestions. Test `DELETE /api/contacts/:id/gdpr` -> cascades + 200. Test auth (non-admin rejected).

**Step 2: Run — FAIL**

**Step 3: Implement**

Add to existing `contacts.ts`:

- `POST /api/contacts/merge` — calls `ExecuteMerge` use case. Requires ADMIN.
- `POST /api/contacts/:id/self-merge` — calls `SelfMerge` use case. Requires SDK session.
- `DELETE /api/contacts/:id/gdpr` — calls `CascadeDeleteContact`. Requires ADMIN.

New `merge-suggestions.ts`:

- `GET /api/contacts/merge-suggestions` — query by tenantId, status.
- `PUT /api/contacts/merge-suggestions/:id` — accept/reject.

~80 lines total.

**Step 4: Run — PASS**

**Step 5: Commit**

```bash
git add apps/runtime/src/routes/contacts.ts apps/runtime/src/routes/merge-suggestions.ts apps/runtime/src/__tests__/contexts/contact/
git commit -m "feat(api): add contact merge, self-merge, GDPR cascade routes"
```

---

### Task 23: Wire CallerContext into HTTP Chat Route

**Files:**

- Modify: `apps/runtime/src/routes/chat.ts` (~lines 668-675)
- Test: `apps/runtime/src/__tests__/contexts/orchestration/chat-identity-wiring.test.ts`

**Step 1: Write test**

Test: when SDK session token has identityTier=2, the CallerContext on the created session reflects tier 2 + verificationMethod. Test: when token has channelArtifact, session resolution is attempted before creating new session. Test: HTTP with user JWT still works (identityTier=0, initiatedById set).

**Step 2: Run — FAIL**

**Step 3: Modify `chat.ts`**

In the deployment-aware path (~line 668-675), replace the hardcoded `identityTier: 0`:

```typescript
// Before:
const callerCtx = buildCallerContext({
  tenantId,
  channel: 'api',
  initiatedById: req.tenantContext?.userId,
  identityTier: 0,
  verificationMethod: 'none',
});

// After:
const sdkPayload = req.tenantContext?.authType === 'sdk_session' ? req.tenantContext : null;
const callerCtx = buildCallerContext({
  tenantId,
  channel: sdkPayload ? 'sdk_http' : 'api',
  channelId: sdkPayload?.channelId,
  customerId: sdkPayload?.identityTier === 2 ? sdkPayload?.userContext?.userId : undefined,
  anonymousId: sdkPayload?.identityTier !== 2 ? sdkPayload?.userContext?.userId : undefined,
  initiatedById: req.tenantContext?.userId,
  identityTier: sdkPayload?.identityTier ?? 0,
  verificationMethod: sdkPayload?.verificationMethod ?? 'none',
});
```

Also add session resolution before creating new session — call `ResolveSession` with the artifact if present.

**Step 4: Run — PASS**

**Step 5: Commit**

```bash
git add apps/runtime/src/routes/chat.ts apps/runtime/src/__tests__/contexts/orchestration/
git commit -m "fix(chat): wire CallerContext from SDK token into HTTP chat route"
```

---

### Task 24: Wire Orchestration into SDK WebSocket Handler

**Files:**

- Modify: `apps/runtime/src/websocket/sdk-handler.ts` (~lines 600-710)
- Test: `apps/runtime/src/__tests__/contexts/orchestration/sdk-handler-wiring.test.ts`

**Step 1: Write test**

Test: on first message from SDK client, `InitializeSession` orchestrator is called. Test: tier 2 client -> contact created + linked. Test: returning client (same artifact) -> session resumed.

**Step 2: Run — FAIL**

**Step 3: Modify `sdk-handler.ts`**

In `initializeProjectAgent()`, after deployment resolution and before session creation, call the `InitializeSession` orchestrator. This replaces the current ad-hoc session creation for the contact-linking path. The existing session creation path stays for backward compat; the orchestrator wraps it.

Key changes:

1. Import orchestration context
2. After `buildCallerContext()` (line ~288), if `callerContext.identityTier === 2`, call `ResolveOrCreateContact` + `LinkSessionToContact`
3. After session creation (line ~701), call `RegisterResolutionKey`

**Step 4: Run — PASS**

**Step 5: Commit**

```bash
git add apps/runtime/src/websocket/sdk-handler.ts apps/runtime/src/__tests__/contexts/orchestration/
git commit -m "feat(ws): wire orchestration into SDK WebSocket handler"
```

---

### Task 25: Webhook Route Registration

**Files:**

- Modify: `apps/runtime/src/routes/index.ts` (mount webhook router)
- Modify: `apps/runtime/src/server.ts` or equivalent (register webhook routes)
- Test: `apps/runtime/src/__tests__/contexts/channel/webhook-integration.test.ts`

**Step 1: Write test** — supertest or mock. Test `POST /webhooks/whatsapp/:channelId` dispatches to WhatsApp adapter. Test unknown channel type -> 404.

**Step 2: Run — FAIL**

**Step 3: Implement** — mount the webhook router from Task 4 at `/webhooks` prefix.

**Step 4: Run — PASS**

**Step 5: Commit**

```bash
git add apps/runtime/src/routes/ apps/runtime/src/server.ts apps/runtime/src/__tests__/contexts/channel/
git commit -m "feat(api): mount webhook router for inbound channel messages"
```

---

## Phase 6: Compliance + Audit

### Task 26: Audit Trail for Contact Operations

**Files:**

- Create: `apps/runtime/src/contexts/contact/infrastructure/contact-audit.ts`
- Modify: each contact use case to emit audit events
- Test: `apps/runtime/src/__tests__/contexts/contact/contact-audit.test.ts`

**Step 1: Write test** — test that `ResolveOrCreateContact` emits `contact.created` audit event. Test that `ExecuteMerge` emits `contact.merged`. Test that `CascadeDeleteContact` emits `contact.gdpr_erased`.

**Step 2: Run — FAIL**

**Step 3: Implement**

`contact-audit.ts`: Thin wrapper around existing `TraceStore`. Emits `TraceEvent` with `eventType: 'audit'`, `action: ContactAuditAction`, and structured data (tenantId, actor, contactId, timestamp). ~30 lines.

Inject `ContactAuditEmitter` into each use case constructor. Add `emit()` calls at appropriate points.

**Step 4: Run — PASS**

**Step 5: Commit**

```bash
git add apps/runtime/src/contexts/contact/ apps/runtime/src/__tests__/contexts/contact/
git commit -m "feat(compliance): add audit trail for all contact operations"
```

---

### Task 27: Merge Suggestion MongoDB Model

**Files:**

- Create: `packages/database/src/models/merge-suggestion.model.ts`
- Create: `apps/runtime/src/contexts/contact/infrastructure/merge-suggestion-store.ts`
- Test: `apps/runtime/src/__tests__/contexts/contact/merge-suggestion-store.test.ts`

**Step 1: Write test** — mock Mongoose. Test `create()`, `findPending()`, `accept()`, `reject()`.

**Step 2: Run — FAIL**

**Step 3: Implement**

Mongoose model matching `MergeSuggestion` interface from design doc Section 7.2. Indexes: `{ tenantId: 1, status: 1 }`, `{ tenantId: 1, primaryContactId: 1 }`.

Store implements query methods used by `DetectMergeCandidates` job and merge suggestion API routes.

**Step 4: Run — PASS**

**Step 5: Commit**

```bash
git add packages/database/src/models/merge-suggestion.model.ts apps/runtime/src/contexts/contact/infrastructure/merge-suggestion-store.ts apps/runtime/src/__tests__/contexts/contact/
git commit -m "feat(contact): add MergeSuggestion model + store"
```

---

## Phase 7: Integration Testing + Final Wiring

### Task 28: End-to-End Identity Flow Integration Test

**Files:**

- Create: `apps/runtime/src/__tests__/contexts/integration/identity.e2e.test.ts`

**Step 1: Write the test**

Full flow: SDK init with HMAC -> WS connect -> first message -> session created with CallerContext (tier 2) -> contact auto-created -> resolution key registered -> second connection with same artifact -> session resumed.

Uses in-memory stores (no real Redis/Mongo). Mocks at the port boundary.

**Step 2: Run — expect PASS** (all components wired)

**Step 3: Fix any failures**

**Step 4: Commit**

```bash
git add apps/runtime/src/__tests__/contexts/integration/
git commit -m "test: add end-to-end identity flow integration test"
```

---

### Task 29: Cross-Channel Continuity Integration Test

**Files:**

- Create: `apps/runtime/src/__tests__/contexts/integration/cross-channel.test.ts`

**Step 1: Write the test**

Flow: User starts on web (tier 2 via HMAC) -> Contact created -> user arrives on WhatsApp (provider-verified phone, same contact via phone identity) -> Contact found -> session linked. Verify both sessions share same contactId.

**Step 2: Run — expect PASS**

**Step 3: Fix any failures**

**Step 4: Commit**

```bash
git add apps/runtime/src/__tests__/contexts/integration/
git commit -m "test: add cross-channel continuity integration test"
```

---

### Task 30: Contact Merge Integration Test

**Files:**

- Create: `apps/runtime/src/__tests__/contexts/integration/contact-merge.test.ts`

**Step 1: Write the test**

Flow: Two contacts created (web + WhatsApp). Add overlapping email identity to both. MergeDetection job finds overlap -> creates suggestion. Admin accepts -> ExecuteMerge consolidates. Verify: unified contact has both identities, all sessions point to primary, secondary is soft-deleted.

**Step 2: Run — expect PASS**

**Step 3: Fix any failures**

**Step 4: Commit**

```bash
git add apps/runtime/src/__tests__/contexts/integration/
git commit -m "test: add contact merge integration test"
```

---

### Task 31: Build + Full Test Suite

**Step 1: Build**

```bash
cd /Users/prasannaarikala/projects/agent-platform && pnpm build
```

Expected: Clean build, no type errors.

**Step 2: Run all tests**

```bash
cd /Users/prasannaarikala/projects/agent-platform && pnpm test
```

Expected: All tests pass.

**Step 3: Fix any failures**

**Step 4: Final commit**

```bash
git add -A
git commit -m "chore: fix build issues from identity + contact implementation"
```

---

## Task Dependency Graph

```
Phase 1 (Channel):     T1 → T2 → T3 → T4
Phase 2 (Identity):    T5 → T6 → T7
                              ↘ T8 → T9 → T10 → T11
                        T6 → T12
Phase 3 (Contact):     T13 → T14 → T15 → T16
Phase 4 (Orchestration): T17, T18, T19 (depend on T6 + T16)
                         T20 (depends on T16)
Phase 5 (API):         T21 (depends on T6)
                       T22 (depends on T16)
                       T23 (depends on T6, T17)
                       T24 (depends on T17)
                       T25 (depends on T4)
Phase 6 (Compliance):  T26 (depends on T16)
                       T27 (depends on T14)
Phase 7 (Integration): T28, T29, T30 (depend on all above)
                       T31 (final)
```

## Summary

| Phase | Tasks   | What it delivers                                                             |
| ----- | ------- | ---------------------------------------------------------------------------- |
| 1     | T1-T4   | Channel domain types, adapter contract, placeholder adapters, webhook router |
| 2     | T5-T12  | Identity domain, all 6 verifiers, resolution key store                       |
| 3     | T13-T16 | Contact encryptor, domain, MongoDB repo, all use cases                       |
| 4     | T17-T20 | Orchestration use cases (init, promote, switch), BullMQ jobs                 |
| 5     | T21-T25 | API routes (verification, merge, GDPR), chat/WS wiring                       |
| 6     | T26-T27 | Audit trail, merge suggestion persistence                                    |
| 7     | T28-T31 | Integration tests, build validation                                          |

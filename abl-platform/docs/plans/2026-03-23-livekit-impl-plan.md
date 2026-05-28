# LLD + Implementation Plan: LiveKit Voice Integration

**Feature:** LiveKit Voice Integration
**Status:** ALPHA
**Created:** 2026-03-23
**Last Updated:** 2026-03-23
**HLD Reference:** `docs/specs/livekit.hld.md`
**RFC Reference:** `docs/rfcs/RFC_LIVEKIT_SIP_TELEPHONY.md`

---

## 1. Implementation Context

### 1.1 What Already Exists

The WebRTC voice pipeline (P0) is **fully implemented and in production**. This LLD focuses on the remaining work: SIP telephony (P1), DTMF handling (P1), phone number management (P1), and test coverage for the entire voice feature.

**Existing production code** (see HLD Section 6 for full file map):

- RuntimeLLMAdapter with deployment-aware and legacy DSL paths
- Agent worker with in-process model, RuntimeBridgeAgent, and plugin initialization
- Worker entry with lifecycle management, concurrency tracking, and graceful shutdown
- Voice Service Factory with tenant-scoped credential resolution and caching
- Trace hooks with per-turn phase timing
- Studio voice preview page with animated orb and transcript panel
- Web SDK VoiceClient with pipeline and realtime modes

### 1.2 What Needs to Be Built

| Phase   | Components                                | Priority |
| ------- | ----------------------------------------- | -------- |
| Phase 1 | Database models + telephony service layer | P1       |
| Phase 2 | Telephony REST API routes                 | P1       |
| Phase 3 | SIP call lifecycle + agent greeting       | P1       |
| Phase 4 | DTMF handling                             | P1       |
| Phase 5 | Studio telephony UI                       | P1       |
| Phase 6 | Test coverage (unit + integration + E2E)  | P0       |

---

## 2. Phase 1: Database Models + Telephony Service Layer

### 2.1 Exit Criteria

- [ ] SIPTrunk, PhoneNumber, CallRecord Mongoose models defined with tenant + project isolation
- [ ] SIPTrunkService with CRUD operations and LiveKit SIP API synchronization
- [ ] PhoneNumberService with Twilio provisioning integration
- [ ] CallRecordService with query, pagination, and session trace linking
- [ ] All models use `z.string().min(1)` for ID fields (never `.cuid()`)
- [ ] `pnpm build --filter=@agent-platform/database` passes

### 2.2 SIPTrunk Model

**File:** `packages/database/src/models/sip-trunk.model.ts`

```typescript
// Schema fields:
{
  _id: String,                    // UUID
  tenantId: String,               // required, indexed
  projectId: String,              // required, indexed
  name: String,                   // display name
  provider: 'twilio' | 'telnyx' | 'plivo',
  direction: 'inbound' | 'outbound' | 'both',
  livekitTrunkId: String,         // LiveKit's trunk ID after creation
  livekitDispatchRuleId: String,  // LiveKit's dispatch rule ID
  sipDomain: String,              // outbound SIP domain
  authUsername: String,            // outbound auth
  authPasswordEnc: String,        // encrypted via EncryptionService
  transport: 'udp' | 'tcp' | 'tls',  // default: 'tls'
  mediaEncryption: 'off' | 'allow' | 'require',  // default: 'require'
  ipAllowlist: [String],          // inbound IP whitelist
  status: 'active' | 'inactive' | 'error',
  statusMessage: String,          // error details
  createdAt: Date,
  updatedAt: Date,
}

// Indexes:
{ tenantId: 1 }
{ tenantId: 1, projectId: 1 }
{ livekitTrunkId: 1 }
```

**Tenant isolation:** Every query includes `tenantId`. Use `findOne({ _id, tenantId })`, never `findById`.

### 2.3 PhoneNumber Model

**File:** `packages/database/src/models/phone-number.model.ts`

```typescript
{
  _id: String,                    // UUID
  tenantId: String,               // required, indexed
  projectId: String,              // required, indexed
  number: String,                 // E.164 format, unique
  provider: 'twilio' | 'telnyx',
  providerSid: String,            // provider's number SID
  trunkId: String,                // FK to SIPTrunk (optional)
  livekitDispatchRuleId: String,  // LiveKit dispatch rule for this number
  deploymentId: String,           // deployment for call routing
  entryAgentName: String,         // agent to handle calls
  greeting: String,               // greeting text for inbound calls
  features: {
    dtmfEnabled: Boolean,         // default: true
    recordingEnabled: Boolean,    // default: false
    krispEnabled: Boolean,        // default: false
  },
  fallbackNumber: String,         // E.164, used if agent unavailable
  status: 'active' | 'inactive' | 'pending',
  capabilities: 'voice' | 'sms' | 'voice+sms',
  region: String,                 // geographic region
  monthlyRate: Number,            // provider billing rate
  createdAt: Date,
  updatedAt: Date,
}

// Indexes:
{ number: 1 }  // unique
{ tenantId: 1 }
{ tenantId: 1, projectId: 1 }
```

### 2.4 CallRecord Model

**File:** `packages/database/src/models/call-record.model.ts`

```typescript
{
  _id: String,                    // UUID
  tenantId: String,               // required, indexed
  projectId: String,              // required, indexed
  sessionId: String,              // FK to ConversationSession
  trunkId: String,                // FK to SIPTrunk
  phoneNumberId: String,          // FK to PhoneNumber
  direction: 'inbound' | 'outbound',
  callerNumber: String,           // E.164
  calledNumber: String,           // E.164
  status: 'ringing' | 'active' | 'completed' | 'failed' | 'transferred' | 'missed',
  startedAt: Date,
  answeredAt: Date,
  endedAt: Date,
  durationMs: Number,
  endReason: 'caller_hangup' | 'agent_hangup' | 'transfer' | 'timeout' | 'error',
  transferTarget: String,         // E.164, if transferred
  recordingUrl: String,           // S3 URL if recorded
  metadata: Object,               // additional SIP metadata
  metrics: {
    totalTurns: Number,
    avgLatencyMs: Number,
    bargeInCount: Number,
    dtmfTurnCount: Number,
  },
  createdAt: Date,
}

// Indexes:
{ tenantId: 1, projectId: 1 }
{ sessionId: 1 }
{ startedAt: -1 }
{ tenantId: 1, startedAt: -1 }
{ callerNumber: 1 }
{ calledNumber: 1 }
```

### 2.5 SIPTrunkService

**File:** `apps/runtime/src/services/telephony/sip-trunk-service.ts`

```typescript
class SIPTrunkService {
  constructor(
    private encryption: EncryptionService,
    private livekitApiKey: string,
    private livekitApiSecret: string,
    private livekitUrl: string,
  ) {}

  // CRUD
  async createTrunk(
    tenantId: string,
    projectId: string,
    config: CreateTrunkInput,
  ): Promise<SIPTrunk>;
  async getTrunk(tenantId: string, trunkId: string): Promise<SIPTrunk | null>;
  async listTrunks(tenantId: string, projectId: string): Promise<SIPTrunk[]>;
  async updateTrunk(
    tenantId: string,
    trunkId: string,
    updates: UpdateTrunkInput,
  ): Promise<SIPTrunk>;
  async deleteTrunk(tenantId: string, trunkId: string): Promise<void>;
  async testTrunkConnectivity(tenantId: string, trunkId: string): Promise<TrunkTestResult>;

  // LiveKit SIP API sync
  private async syncInboundTrunk(trunk: SIPTrunk): Promise<string>; // returns livekitTrunkId
  private async syncDispatchRule(trunk: SIPTrunk): Promise<string>; // returns livekitDispatchRuleId
  private async deleteLiveKitTrunk(livekitTrunkId: string): Promise<void>;
  private async deleteLiveKitDispatchRule(livekitDispatchRuleId: string): Promise<void>;
}
```

**Key behaviors:**

- `createTrunk`: Encrypts auth password, creates DB record, syncs with LiveKit SIP API
- `deleteTrunk`: Deletes LiveKit resources first, then DB record (cleanup on failure)
- `testTrunkConnectivity`: Attempts SIP OPTIONS to verify trunk reachability
- All operations tenant-guarded: `{ _id: trunkId, tenantId }`

### 2.6 Zod Validation Schemas

**File:** `apps/runtime/src/services/telephony/telephony-schemas.ts`

```typescript
const CreateTrunkSchema = z.object({
  name: z.string().min(1).max(256),
  provider: z.enum(['twilio', 'telnyx', 'plivo']),
  direction: z.enum(['inbound', 'outbound', 'both']),
  sipDomain: z.string().optional(),
  authUsername: z.string().optional(),
  authPassword: z.string().optional(),
  transport: z.enum(['udp', 'tcp', 'tls']).default('tls'),
  mediaEncryption: z.enum(['off', 'allow', 'require']).default('require'),
  ipAllowlist: z.array(z.string().ip()).optional(),
});

const ProvisionNumberSchema = z.object({
  number: z.string().regex(/^\+[1-9]\d{1,14}$/), // E.164
  provider: z.enum(['twilio', 'telnyx']),
  trunkId: z.string().min(1).optional(),
  deploymentId: z.string().min(1).optional(),
  entryAgentName: z.string().min(1).optional(),
  greeting: z.string().max(500).optional(),
});

const CallQuerySchema = z.object({
  direction: z.enum(['inbound', 'outbound']).optional(),
  status: z.enum(['ringing', 'active', 'completed', 'failed', 'transferred', 'missed']).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});
```

---

## 3. Phase 2: Telephony REST API Routes

### 3.1 Exit Criteria

- [ ] All telephony routes registered under `/api/projects/:projectId/telephony/*`
- [ ] Auth middleware + project permission checks on all routes
- [ ] Zod validation on all request bodies and query parameters
- [ ] Error envelope format: `{ success: false, error: { code, message } }`
- [ ] Static routes registered BEFORE parameterized routes
- [ ] `pnpm build --filter=runtime` passes

### 3.2 Route Implementation

**File:** `apps/runtime/src/routes/telephony.ts`

```typescript
// Registration order matters — static before parameterized
router.post('/trunks', requireProjectPermission('telephony:write'), createTrunk);
router.get('/trunks', requireProjectPermission('telephony:read'), listTrunks);
router.get('/trunks/:trunkId', requireProjectPermission('telephony:read'), getTrunk);
router.patch('/trunks/:trunkId', requireProjectPermission('telephony:write'), updateTrunk);
router.delete('/trunks/:trunkId', requireProjectPermission('telephony:write'), deleteTrunk);
router.post('/trunks/:trunkId/test', requireProjectPermission('telephony:write'), testTrunk);

router.post('/numbers/search', requireProjectPermission('telephony:write'), searchNumbers);
router.post('/numbers', requireProjectPermission('telephony:write'), provisionNumber);
router.get('/numbers', requireProjectPermission('telephony:read'), listNumbers);
router.patch('/numbers/:numberId', requireProjectPermission('telephony:write'), updateNumber);
router.delete('/numbers/:numberId', requireProjectPermission('telephony:write'), deleteNumber);

router.get('/calls', requireProjectPermission('telephony:read'), listCalls);
router.get('/calls/:callId', requireProjectPermission('telephony:read'), getCall);
router.post('/calls/outbound', requireProjectPermission('telephony:write'), initiateOutboundCall);
```

**Route wiring in server.ts:**

```typescript
import { telephonyRouter } from './routes/telephony.js';
app.use('/api/projects/:projectId/telephony', authMiddleware, telephonyRouter);
```

### 3.3 Error Response Format

All telephony routes return the standard error envelope:

```typescript
// Success
{ success: true, data: { ... } }

// Error
{ success: false, error: { code: 'TRUNK_NOT_FOUND', message: 'SIP trunk not found' } }
```

---

## 4. Phase 3: SIP Call Lifecycle + Agent Greeting

### 4.1 Exit Criteria

- [ ] SIP call handler processes LiveKit room webhooks for SIP-initiated rooms
- [ ] DID number -> tenant -> project -> deployment -> agent resolution working
- [ ] Agent delivers immediate greeting when SIP participant joins
- [ ] CallerContext enriched with SIP metadata (phone number, trunk ID)
- [ ] CallRecord created and updated throughout call lifecycle
- [ ] Voice trace events include telephony context

### 4.2 SIP Call Lifecycle Handler

**File:** `apps/runtime/src/services/telephony/sip-call-handler.ts`

```typescript
class SIPCallHandler {
  /**
   * Handle LiveKit webhook: room_started (SIP dispatch created room)
   *
   * Resolution chain:
   * 1. Extract room name -> parse for SIP room prefix
   * 2. Look up dispatch rule -> get trunkId
   * 3. Look up trunk -> get tenantId, projectId
   * 4. Look up phone number config -> get deploymentId, entryAgentName, greeting
   * 5. Spawn agent with enriched metadata
   * 6. Create CallRecord
   */
  async handleRoomStarted(event: LiveKitWebhookEvent): Promise<void>;

  /**
   * Handle LiveKit webhook: participant_joined (SIP participant)
   *
   * Extract SIP metadata from participant attributes:
   * - sip.phoneNumber -> callerNumber
   * - sip.trunkID -> trunkId
   * - sip.callStatus -> callStatus
   * - sip.callID -> sipCallId
   */
  async handleParticipantJoined(event: LiveKitWebhookEvent): Promise<void>;

  /**
   * Handle LiveKit webhook: participant_left (SIP participant disconnected)
   *
   * Update CallRecord with endedAt, durationMs, endReason.
   */
  async handleParticipantLeft(event: LiveKitWebhookEvent): Promise<void>;

  /**
   * Resolve inbound call routing:
   * DID number -> PhoneNumber record -> { tenantId, projectId, deploymentId, agentName, greeting }
   */
  private async resolveDIDRouting(calledNumber: string): Promise<DIDRoutingResult>;
}
```

### 4.3 Agent Greeting on SIP Join

**Modification to:** `apps/runtime/src/services/voice/livekit/agent-worker.ts`

When a SIP participant is detected (via `sip.*` attributes), the agent must:

1. Set `CallerContext.channel = 'sip'`
2. Extract caller metadata: phone number, trunk ID
3. Generate immediate greeting (from phone number config or agent IR `telephony.greeting`)
4. Send greeting text through TTS pipeline without waiting for user speech

```typescript
// In startAgentInRoom(), after pipeline start:
if (metadata.channel === 'sip' && metadata.greeting) {
  // Immediately speak greeting — phone callers expect it
  const greetingStream = createTextStream(metadata.greeting);
  await session.say(greetingStream); // or equivalent TTS immediate play
}
```

### 4.4 Webhook Route

**File:** `apps/runtime/src/routes/livekit-webhooks.ts`

```typescript
router.post(
  '/api/v1/livekit/webhook',
  express.raw({ type: 'application/webhook+json' }),
  async (req, res) => {
    // Verify webhook signature using LiveKit API secret
    const event = verifyWebhookEvent(req.body, req.headers, apiSecret);
    if (!event) return res.status(401).json({ error: 'Invalid signature' });

    switch (event.event) {
      case 'room_started':
        await sipCallHandler.handleRoomStarted(event);
        break;
      case 'participant_joined':
        await sipCallHandler.handleParticipantJoined(event);
        break;
      case 'participant_left':
        await sipCallHandler.handleParticipantLeft(event);
        break;
    }

    res.status(200).json({ received: true });
  },
);
```

---

## 5. Phase 4: DTMF Handling

### 5.1 Exit Criteria

- [ ] DTMF digits received from SIP participants via LiveKit data channel events
- [ ] Digit collection with configurable timeout and max digits
- [ ] DTMF digits can be sent from agent to SIP participant
- [ ] Platform tools registered: `sip.collect_digits`, `sip.send_dtmf`
- [ ] DTMF turns recorded in voice trace events

### 5.2 DTMF Handler

**File:** `apps/runtime/src/services/telephony/dtmf-handler.ts`

```typescript
class DTMFHandler {
  private pendingCollection: {
    resolve: (digits: string) => void;
    reject: (error: Error) => void;
    buffer: string;
    maxDigits: number;
    timeout: ReturnType<typeof setTimeout>;
    interDigitTimeout: ReturnType<typeof setTimeout> | null;
  } | null = null;

  /**
   * Handle incoming DTMF digit event from LiveKit room.
   */
  handleDigitReceived(digit: string, participantId: string): void;

  /**
   * Collect N digits from the caller with timeout.
   * Returns collected digits when maxDigits reached or timeout expires.
   */
  async collectDigits(opts: {
    maxDigits: number;
    timeoutMs?: number; // default: 5000
    interDigitTimeoutMs?: number; // default: 3000
    terminatingDigit?: string; // e.g., '#'
  }): Promise<string>;

  /**
   * Send DTMF digits to a SIP participant.
   */
  async sendDigits(participantId: string, digits: string): Promise<void>;

  /**
   * Cancel any pending digit collection.
   */
  cancelCollection(): void;
}
```

### 5.3 Platform Tools

```typescript
// Registered as runtime tools when telephony is enabled
const sipCollectDigitsTool: LLMToolDefinition = {
  type: 'function',
  function: {
    name: 'sip.collect_digits',
    description: 'Collect DTMF digits from the phone caller',
    parameters: {
      type: 'object',
      properties: {
        max_digits: { type: 'number', description: 'Maximum digits to collect' },
        timeout_ms: { type: 'number', description: 'Timeout in milliseconds' },
        prompt: { type: 'string', description: 'Message to speak before collecting' },
      },
      required: ['max_digits'],
    },
  },
};

const sipSendDtmfTool: LLMToolDefinition = {
  type: 'function',
  function: {
    name: 'sip.send_dtmf',
    description: 'Send DTMF digits to the phone caller',
    parameters: {
      type: 'object',
      properties: {
        digits: { type: 'string', description: 'Digits to send (0-9, *, #)' },
      },
      required: ['digits'],
    },
  },
};
```

---

## 6. Phase 5: Studio Telephony UI

### 6.1 Exit Criteria

- [ ] Telephony page at `/projects/:projectId/telephony` with 3 tabs
- [ ] Phone Numbers tab: list, provision, configure routing
- [ ] SIP Trunks tab: list, create, update, delete, test
- [ ] Call History tab: list, filter, detail with session trace link
- [ ] Navigation: "Telephony" item in project sidebar
- [ ] API client with SWR hooks for all telephony endpoints
- [ ] `pnpm build --filter=studio` passes

### 6.2 Components

**File:** `apps/studio/src/components/telephony/TelephonyPage.tsx`

- Tab layout: Phone Numbers | SIP Trunks | Call History
- Conditional rendering based on telephony feature availability

**File:** `apps/studio/src/components/telephony/PhoneNumbersTab.tsx`

- Number list with provider, status, assigned agent columns
- Provision number dialog (search -> select -> configure routing)
- Number detail panel (routing config, features, fallback)

**File:** `apps/studio/src/components/telephony/SIPTrunksTab.tsx`

- Inbound and outbound trunk sections
- Create trunk dialog with provider, direction, auth config
- Test connectivity action with result display

**File:** `apps/studio/src/components/telephony/CallHistoryTab.tsx`

- Paginated call list with filters (direction, status, date range)
- Click to view call detail with session trace link

**File:** `apps/studio/src/api/telephony.ts`

```typescript
// SWR hooks + fetch functions
export function useSIPTrunks(projectId: string);
export function usePhoneNumbers(projectId: string);
export function useCallHistory(projectId: string, filters: CallFilters);
export async function createSIPTrunk(projectId: string, config: CreateTrunkInput);
export async function provisionPhoneNumber(projectId: string, opts: ProvisionOpts);
// ... etc
```

---

## 7. Phase 6: Test Coverage

### 7.1 Exit Criteria

- [ ] Unit tests for RuntimeLLMAdapter, Agent Worker, Worker Entry, Trace Hooks (>=85% coverage)
- [ ] Integration tests for Voice Service Factory, Token Route, Worker lifecycle (>=75% coverage)
- [ ] E2E tests for token generation, credential pre-flight, concurrency limit, auth, cross-tenant isolation
- [ ] E2E tests for telephony CRUD (SIP trunks, phone numbers, call history)
- [ ] All tests pass: `pnpm test --filter=runtime`
- [ ] No mocked codebase components in E2E tests

### 7.2 Test File Locations

```
apps/runtime/src/__tests__/
  voice/
    runtime-llm-adapter.test.ts       (unit)
    agent-worker.test.ts              (unit)
    worker-entry.test.ts              (unit)
    trace-hooks.test.ts               (unit)
    voice-service-factory.int.test.ts (integration)
  routes/
    livekit-token.e2e.test.ts         (e2e)
    livekit-capabilities.e2e.test.ts  (e2e)
    telephony-trunks.e2e.test.ts      (e2e)
    telephony-numbers.e2e.test.ts     (e2e)
    telephony-calls.e2e.test.ts       (e2e)
  telephony/
    sip-trunk-service.test.ts         (unit)
    sip-call-handler.int.test.ts      (integration)
    dtmf-handler.test.ts              (unit)
```

### 7.3 E2E Test Setup

```typescript
// Shared E2E test setup — real server, no mocks
async function setupVoiceE2ETest() {
  const app = express();
  // Full middleware chain: auth, rate limiting, tenant isolation, validation
  configureMiddleware(app);
  configureRoutes(app);

  const server = app.listen(0); // random port
  const port = (server.address() as AddressInfo).port;

  // Seed test data via API
  const tenant = await seedTenantViaAPI(port);
  const project = await seedProjectViaAPI(port, tenant.id);
  const credentials = await seedVoiceCredentialsViaAPI(port, tenant.id);

  return { server, port, tenant, project, credentials, cleanup: () => server.close() };
}
```

---

## 8. Wiring Checklist

### 8.1 Database Models

- [ ] SIPTrunk model registered in `packages/database/src/models/index.ts`
- [ ] PhoneNumber model registered in `packages/database/src/models/index.ts`
- [ ] CallRecord model registered in `packages/database/src/models/index.ts`
- [ ] Model imports added to `packages/database/src/index.ts` barrel export

### 8.2 Routes

- [ ] Telephony router imported and mounted in `apps/runtime/src/server.ts`
- [ ] Webhook route registered in `apps/runtime/src/server.ts`
- [ ] Route order verified: static routes before parameterized

### 8.3 Services

- [ ] SIPTrunkService instantiated in server startup
- [ ] SIPCallHandler instantiated with dependencies
- [ ] DTMFHandler instantiated per voice session
- [ ] Platform tools registered when telephony enabled

### 8.4 Studio

- [ ] Telephony page route added in `app/projects/[projectId]/telephony/page.tsx`
- [ ] Navigation item added to `ProjectSidebar.tsx` or equivalent
- [ ] API proxy routes for telephony endpoints (if Studio proxies to runtime)
- [ ] `'telephony'` added to `ProjectPage` type in `navigation-store.ts`

### 8.5 Configuration

- [ ] Voice config schema extended with SIP block in `packages/config/src/schemas/voice.schema.ts`
- [ ] Environment variables documented: `SIP_ENABLED`, `LIVEKIT_SIP_URL`
- [ ] Docker compose updated with LiveKit SIP service (optional)
- [ ] Dockerfile `COPY` lines for any new packages

### 8.6 Feature Flag

- [ ] `FEATURE_LIVEKIT_ENABLED` gates WebRTC voice pipeline
- [ ] `SIP_ENABLED` gates telephony features (independent flag)
- [ ] Capabilities endpoint reports telephony status

---

## 9. Implementation Priorities

### Immediate (P0 — existing, already production)

1. WebRTC voice pipeline — complete
2. Token generation API — complete
3. Voice credential management — complete
4. Studio voice preview — complete
5. Web SDK voice support — complete

### Next Sprint (P1 — telephony foundation)

1. Phase 1: Database models (3 days)
2. Phase 2: Telephony routes (2 days)
3. Phase 3: SIP call lifecycle + greeting (5 days)
4. Phase 6: Test coverage for existing WebRTC pipeline (3 days)

### Following Sprint (P1 — telephony features)

1. Phase 4: DTMF handling (3 days)
2. Phase 5: Studio telephony UI (5 days)
3. Phase 6: Test coverage for telephony (3 days)

### Deferred (P2)

1. Outbound call tool and routes
2. Call transfer (SIP REFER)
3. Call recording (LiveKit Egress)
4. Multi-language STT
5. DSL TELEPHONY block in compiler

---

## 10. Risk Register

| Risk                                       | Probability | Impact | Mitigation                                                        |
| ------------------------------------------ | ----------- | ------ | ----------------------------------------------------------------- |
| LiveKit SIP API changes (pre-stable)       | Medium      | Medium | Pin @livekit/server-sdk version, monitor changelog                |
| Twilio number provisioning API rate limits | Low         | Low    | Batch operations, cache available numbers                         |
| SIP trunk test connectivity unreliable     | Medium      | Low    | Multiple test methods (OPTIONS, INVITE to echo), timeout handling |
| WebRTC pipeline has no test coverage       | High        | High   | Phase 6 prioritizes existing pipeline tests first                 |
| LiveKit optional deps break build          | Low         | Medium | Dynamic imports, build-time type isolation (existing pattern)     |
| Call recording storage costs               | Medium      | Medium | S3 lifecycle policies, per-tenant quotas                          |

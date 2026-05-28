# LLD & Implementation Plan: Proactive Messaging (#36)

> **Status**: PLANNED
> **Created**: 2026-03-22
> **Feature Spec**: `docs/features/proactive-messaging.md`
> **Test Spec**: `docs/testing/proactive-messaging.md`
> **HLD**: `docs/specs/proactive-messaging.hld.md`

---

## Overview

This LLD breaks the proactive messaging feature into 5 implementation phases with strict exit criteria. Each phase is independently deployable behind the `PROACTIVE_MESSAGING_ENABLED` feature flag.

---

## Phase 1: Data Layer & Core Types (Foundation)

**Goal**: Establish MongoDB models, repository layer, core TypeScript types, and Zod validation schemas.

### Tasks

#### 1.1 ProactiveMessage Model

**File**: `apps/runtime/src/db/proactive-message.ts`

```typescript
import mongoose, { Schema, Document } from 'mongoose';

export interface ProactiveMessageDoc extends Document {
  tenantId: string;
  projectId: string;
  agentName: string;
  contactId: string;
  sessionId?: string;
  channelType: string;
  channelAddress: string;
  content: {
    text: string;
    richContent?: Record<string, unknown>;
    templateId?: string;
  };
  trigger: {
    type: 'api' | 'schedule' | 'event';
    triggerId?: string;
    eventData?: Record<string, unknown>;
  };
  delivery: {
    status: 'pending' | 'delivering' | 'delivered' | 'failed' | 'bounced' | 'cancelled';
    attempts: number;
    lastAttemptAt?: Date;
    deliveredAt?: Date;
    failureReason?: string;
    externalMessageId?: string;
  };
  metadata?: Record<string, unknown>;
  expiresAt: Date;
}

// Indexes: { tenantId, projectId, status, createdAt }, { tenantId, contactId, createdAt },
// { delivery.status, createdAt }, TTL on expiresAt
```

#### 1.2 ProactiveSchedule Model

**File**: `apps/runtime/src/db/proactive-schedule.ts`

Schema mirrors the HLD `ProactiveSchedule` type. Indexes on `{ tenantId, projectId, status }`.

#### 1.3 ProactiveTrigger Model

**File**: `apps/runtime/src/db/proactive-trigger.ts`

Schema mirrors the HLD `ProactiveTrigger` type. Indexes on `{ tenantId, projectId, eventType, status }`.

#### 1.4 ContactConsent Model

**File**: `apps/runtime/src/db/contact-consent.ts`

Schema mirrors the HLD `ContactConsent` type. Unique index on `{ tenantId, projectId, contactId, channelType }`.

#### 1.5 Repository Layer

**Files**:

- `apps/runtime/src/repos/proactive-message-repo.ts`
- `apps/runtime/src/repos/proactive-schedule-repo.ts`
- `apps/runtime/src/repos/proactive-trigger-repo.ts`
- `apps/runtime/src/repos/contact-consent-repo.ts`

Each repository:

- Requires `tenantId` and `projectId` as mandatory parameters on every method
- Uses `findOne({ _id, tenantId, projectId })`, never `findById()`
- Returns `null` for cross-tenant/project access (not 403)
- Follows existing repo patterns in `apps/runtime/src/repos/`

#### 1.6 Zod Validation Schemas

**File**: `apps/runtime/src/validation/proactive-schemas.ts`

```typescript
import { z } from 'zod';

export const createProactiveMessageSchema = z.object({
  agentName: z.string().min(1),
  contactId: z.string().min(1),
  message: z.string().min(1).max(10_000),
  channelPreference: z.string().optional(),
  templateId: z.string().min(1).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const createProactiveScheduleSchema = z.object({
  agentName: z.string().min(1),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  schedule: z.object({
    cron: z.string().min(1), // validated via cron-parser
    timezone: z.string().min(1),
  }),
  contactFilter: z.object({
    tags: z.array(z.string()).optional(),
    segments: z.array(z.string()).optional(),
    customFilter: z.record(z.unknown()).optional(),
  }),
  messageTemplate: z.object({
    text: z.string().min(1).max(10_000),
    richContent: z.record(z.unknown()).optional(),
    variables: z.record(z.string()).optional(),
  }),
  channelPreference: z.string().optional(),
  rateLimit: z
    .object({
      maxPerExecution: z.number().int().positive().max(10_000).optional(),
      maxPerDay: z.number().int().positive().max(100_000).optional(),
    })
    .optional(),
});

export const createProactiveTriggerSchema = z.object({
  agentName: z.string().min(1),
  name: z.string().min(1).max(200),
  eventType: z.string().min(1),
  conditions: z.string().optional(),
  contactResolver: z.string().min(1),
  messageTemplate: z.object({
    text: z.string().min(1).max(10_000),
    richContent: z.record(z.unknown()).optional(),
    variables: z.record(z.string()).optional(),
  }),
  channelPreference: z.string().optional(),
});

export const updateConsentSchema = z.object({
  status: z.enum(['opted_in', 'opted_out']),
  reason: z.string().max(500).optional(),
});
```

Note: All ID fields use `z.string().min(1)` per platform convention (never `.cuid()`, `.cuid2()`, etc.).

#### 1.7 Core Types

**File**: `apps/runtime/src/types/proactive.ts`

TypeScript interfaces matching the Zod schemas, plus:

- `ProactiveDeliveryStatus` union type
- `ProactiveTriggerType` union type
- `ConsentStatus` union type
- `ChannelPriority` array constant

### Exit Criteria — Phase 1

- [ ] All 4 Mongoose models created with correct indexes
- [ ] All 4 repository classes implemented with tenant/project isolation
- [ ] All Zod schemas validate correctly (unit tests)
- [ ] `pnpm build --filter=runtime` passes with zero type errors
- [ ] Unit tests for repository isolation (cross-tenant returns null)

---

## Phase 2: Core Services (Business Logic)

**Goal**: Implement the core service layer — message creation, consent enforcement, rate limiting, contact resolution.

### Tasks

#### 2.1 ConsentService

**File**: `apps/runtime/src/services/proactive/consent-service.ts`

```typescript
export class ConsentService {
  constructor(
    private readonly consentRepo: ContactConsentRepo,
    private readonly traceStore: TraceStorePort,
  ) {}

  async checkConsent(
    tenantId: string,
    projectId: string,
    contactId: string,
    channelType: string,
  ): Promise<{ allowed: boolean; status: ConsentStatus; reason?: string }>;

  async updateConsent(
    tenantId: string,
    projectId: string,
    contactId: string,
    channelType: string,
    status: ConsentStatus,
    source: string,
    reason?: string,
  ): Promise<void>;

  async getContactConsent(
    tenantId: string,
    projectId: string,
    contactId: string,
  ): Promise<ContactConsent[]>;

  async deleteContactConsent(tenantId: string, projectId: string, contactId: string): Promise<void>; // GDPR erasure cascade
}
```

**Key Rules**:

- If no consent record exists: returns `{ allowed: false, status: 'pending' }`
- Every status change appends to `auditTrail` via `$push` (never `$set`)
- Emits `proactive.consent.changed` trace event

#### 2.2 ProactiveRateLimiter

**File**: `apps/runtime/src/services/proactive/rate-limiter.ts`

```typescript
export class ProactiveRateLimiter {
  constructor(private readonly redis: Redis) {}

  async check(params: {
    tenantId: string;
    contactId: string;
    channelType: string;
    messageId: string;
  }): Promise<{ allowed: boolean; retryAfterMs?: number; level?: string }>;
}
```

**Implementation**: Redis Lua script for atomic sliding window:

```lua
-- rate-limit.lua
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retryAfter = oldest[2] + window - now
  return {0, retryAfter}
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)
return {1, 0}
```

**Levels** (checked in order, first rejection wins):

1. Per-contact daily: `ratelimit:{tenantId}:{contactId}:daily` — 5/day
2. Per-channel per-minute: `ratelimit:{tenantId}:{channelType}:minute` — 100/min
3. Per-tenant hourly: `ratelimit:{tenantId}:hourly` — 10,000/hour

#### 2.3 ContactChannelResolver

**File**: `apps/runtime/src/services/proactive/contact-channel-resolver.ts`

```typescript
export class ContactChannelResolver {
  constructor(
    private readonly contactRepo: ContactRepositoryPort,
    private readonly consentService: ConsentService,
  ) {}

  async resolve(
    tenantId: string,
    projectId: string,
    contactId: string,
    channelPreference?: string,
  ): Promise<{ channelType: string; channelAddress: string } | { error: string }>;
}
```

**Resolution Algorithm**:

1. Load contact from repo (with tenant/project isolation)
2. If `channelPreference` and contact has that channel: check consent, return if opted_in
3. If contact has `preferredChannel`: check consent, return if opted_in
4. Iterate channel priority list `['email', 'slack', 'msteams', 'whatsapp', 'http_async', 'web_chat']`
5. For each: check if contact has address + consent is opted_in
6. If none found: return `{ error: 'CONTACT_UNREACHABLE' }`

#### 2.4 ProactiveMessageService

**File**: `apps/runtime/src/services/proactive/message-service.ts`

```typescript
export class ProactiveMessageService {
  constructor(
    private readonly messageRepo: ProactiveMessageRepo,
    private readonly channelResolver: ContactChannelResolver,
    private readonly consentService: ConsentService,
    private readonly rateLimiter: ProactiveRateLimiter,
    private readonly deliveryQueue: ProactiveDeliveryQueue,
    private readonly sessionManager: ProactiveSessionManager,
    private readonly traceStore: TraceStorePort,
  ) {}

  async create(params: CreateProactiveMessageParams): Promise<ProactiveMessage>;
  async getById(
    tenantId: string,
    projectId: string,
    messageId: string,
  ): Promise<ProactiveMessage | null>;
  async list(
    tenantId: string,
    projectId: string,
    filters: ListFilters,
  ): Promise<PaginatedResult<ProactiveMessage>>;
  async cancel(tenantId: string, projectId: string, messageId: string): Promise<void>;
}
```

**`create()` Flow**:

1. Validate agent exists in project
2. Resolve contact channel (`ContactChannelResolver`)
3. Check consent (fail-fast if blocked)
4. Check rate limits (fail-fast if exceeded)
5. Create/resume session (`ProactiveSessionManager`)
6. Save `ProactiveMessage` to MongoDB (status: `pending`)
7. Enqueue BullMQ delivery job
8. Emit `proactive.message.created` trace event
9. Return message with `deliveryStatus: 'pending'`

#### 2.5 ProactiveSessionManager

**File**: `apps/runtime/src/services/proactive/session-manager.ts`

```typescript
export class ProactiveSessionManager {
  constructor(private readonly sessionStore: SessionStorePort) {}

  async getOrCreateSession(params: {
    tenantId: string;
    projectId: string;
    agentName: string;
    contactId: string;
    trigger: { type: string; triggerId?: string };
  }): Promise<{ sessionId: string; isNew: boolean }>;
}
```

**Logic**:

1. Query for active session: `{ tenantId, projectId, agentName, contactId, status: 'active' }`
2. If found: return `{ sessionId, isNew: false }`
3. If not found (or expired): create new session with:
   - `initiator: 'agent'`
   - `trigger` metadata
   - Standard session defaults (TTL, memory policy)
   - Return `{ sessionId, isNew: true }`

### Exit Criteria — Phase 2

- [ ] ConsentService: check, update, delete with audit trail (unit tests)
- [ ] ProactiveRateLimiter: sliding window accuracy, concurrent access (integration tests with real Redis)
- [ ] ContactChannelResolver: priority ordering, consent integration (unit tests)
- [ ] ProactiveMessageService: create flow with all checks (unit + integration tests)
- [ ] ProactiveSessionManager: new vs resume logic (unit tests)
- [ ] `pnpm build --filter=runtime` passes with zero type errors
- [ ] Integration tests: INT-1, INT-2, INT-3, INT-5, INT-11

---

## Phase 3: Delivery Pipeline & API Routes

**Goal**: Implement the BullMQ delivery worker, API routes with auth, and the feature flag gate.

### Tasks

#### 3.1 ProactiveDeliveryQueue

**File**: `apps/runtime/src/services/proactive/delivery-queue.ts`

```typescript
export class ProactiveDeliveryQueue {
  private readonly queue: Queue;

  constructor(redis: Redis) {
    this.queue = new Queue('proactive-delivery', {
      connection: redis,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: { age: 86400, count: 10000 },
        removeOnFail: { age: 604800 },
      },
    });
  }

  async enqueue(messageId: string, tenantId: string, projectId: string): Promise<void>;
  async enqueueBatch(
    messages: Array<{ messageId: string; tenantId: string; projectId: string }>,
  ): Promise<void>;
}
```

#### 3.2 ProactiveDeliveryWorker

**File**: `apps/runtime/src/services/proactive/delivery-worker.ts`

```typescript
export class ProactiveDeliveryWorker {
  private worker: Worker;

  constructor(
    private readonly redis: Redis,
    private readonly messageRepo: ProactiveMessageRepo,
    private readonly channelAdapterRegistry: ChannelAdapterRegistryPort,
    private readonly outputGuardrails: OutputGuardrailsPort,
    private readonly templateEngine: TemplateEnginePort,
    private readonly traceStore: TraceStorePort,
  ) {}

  start(): void;
  stop(): Promise<void>;
}
```

**Worker Processing Flow**:

1. Load `ProactiveMessage` by ID
2. If `delivery.status` not `pending` or `delivering`: skip (idempotency)
3. Update status to `delivering`
4. Render message template: `templateEngine.render(content.text, variables)`
5. Run output guardrails: `outputGuardrails.filter(renderedContent)`
6. Resolve channel adapter: `channelAdapterRegistry.get(channelType)`
7. Call `adapter.sendOutbound(channelAddress, formattedMessage)`
8. On success: update status to `delivered`, set `deliveredAt`, `externalMessageId`
9. On failure: throw to trigger BullMQ retry
10. On final failure (after 3 attempts): update status to `failed`, set `failureReason`
11. Emit appropriate trace event

#### 3.3 Channel Adapter Outbound Interface

**File**: `apps/runtime/src/channels/types.ts` (extend existing)

```typescript
export interface ChannelOutboundAdapter {
  sendOutbound(params: {
    channelAddress: string;
    content: { text: string; richContent?: RichContentIR };
    tenantId: string;
    connectionConfig: Record<string, unknown>;
  }): Promise<{ externalMessageId?: string }>;
}
```

Implement `sendOutbound()` on existing adapters:

- `apps/runtime/src/channels/adapters/email-adapter.ts`
- `apps/runtime/src/channels/adapters/slack-adapter.ts`
- `apps/runtime/src/channels/adapters/msteams-adapter.ts`
- `apps/runtime/src/channels/adapters/http-async-adapter.ts`

For Phase 1: email and slack adapters only. Others added in Phase 2.

#### 3.4 API Routes — Proactive Messages

**File**: `apps/runtime/src/routes/proactive-messages.ts`

```typescript
const router = Router();

// Feature flag gate
router.use(requireFeatureFlag('PROACTIVE_MESSAGING_ENABLED'));

// Auth + project permission
router.use(createUnifiedAuthMiddleware());

router.post('/', requireProjectPermission('proactive:write'), async (req, res) => {
  const { tenantId } = req.auth;
  const { projectId } = req.params;
  const body = createProactiveMessageSchema.parse(req.body);
  const result = await proactiveMessageService.create({ tenantId, projectId, ...body });
  res.status(201).json({ success: true, data: result });
});

router.get('/', requireProjectPermission('proactive:read'), async (req, res) => {
  /* list */
});
router.get('/:messageId', requireProjectPermission('proactive:read'), async (req, res) => {
  /* get by id */
});
router.delete('/:messageId', requireProjectPermission('proactive:write'), async (req, res) => {
  /* cancel */
});
```

#### 3.5 API Routes — Contact Consent

**File**: `apps/runtime/src/routes/contact-consent.ts`

Routes for GET/PUT consent under `/api/projects/:projectId/contacts/:contactId/consent`.

#### 3.6 Feature Flag Middleware

**File**: `apps/runtime/src/middleware/feature-flag.ts`

```typescript
export function requireFeatureFlag(flag: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!process.env[flag] || process.env[flag] !== 'true') {
      return res
        .status(404)
        .json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
    }
    next();
  };
}
```

#### 3.7 Route Registration

**File**: `apps/runtime/src/routes/index.ts` (modify)

Register proactive routes under the project-scoped router, AFTER existing parameterized routes (Express route ordering rule).

### Exit Criteria — Phase 3

- [ ] DeliveryWorker processes jobs with retry and DLQ
- [ ] API routes: POST/GET/DELETE proactive messages with auth and validation
- [ ] Consent routes: GET/PUT with audit trail
- [ ] Feature flag gates all proactive routes (404 when disabled)
- [ ] E2E tests pass: E2E-1, E2E-2, E2E-4, E2E-5
- [ ] Integration tests pass: INT-4, INT-10, INT-12
- [ ] `pnpm build --filter=runtime` passes with zero type errors

---

## Phase 4: Schedules & Event Triggers

**Goal**: Implement cron-based schedules and event-driven triggers.

### Tasks

#### 4.1 ProactiveScheduleService

**File**: `apps/runtime/src/services/proactive/schedule-service.ts`

```typescript
export class ProactiveScheduleService {
  constructor(
    private readonly scheduleRepo: ProactiveScheduleRepo,
    private readonly messageService: ProactiveMessageService,
    private readonly contactRepo: ContactRepositoryPort,
    private readonly deliveryQueue: ProactiveDeliveryQueue,
    private readonly traceStore: TraceStorePort,
    private readonly redis: Redis,
  ) {}

  async create(params: CreateScheduleParams): Promise<ProactiveSchedule>;
  async update(
    tenantId: string,
    projectId: string,
    scheduleId: string,
    params: UpdateScheduleParams,
  ): Promise<ProactiveSchedule>;
  async delete(tenantId: string, projectId: string, scheduleId: string): Promise<void>;
  async pause(tenantId: string, projectId: string, scheduleId: string): Promise<void>;
  async resume(tenantId: string, projectId: string, scheduleId: string): Promise<void>;
  async executeSchedule(scheduleId: string): Promise<{ messageCount: number }>;
}
```

**BullMQ Repeatable Jobs**:

```typescript
// On create:
await queue.add(
  'schedule-execute',
  { scheduleId },
  {
    repeat: { pattern: schedule.cron, tz: schedule.timezone },
    jobId: `schedule:${scheduleId}`,
  },
);

// On delete/pause:
await queue.removeRepeatableByKey(`schedule-execute:${scheduleId}:::${cron}`);
```

**Schedule Execution** (`executeSchedule()`):

1. Load schedule from MongoDB
2. Resolve contacts matching `contactFilter` (batched by 100)
3. For each batch: acquire distributed lock `proactive:schedule:${scheduleId}:${batchIndex}`
4. For each contact in batch:
   a. Dedup check: Redis SET NX `proactive:dedup:${scheduleId}:${contactId}:${executionDate}` (TTL 24h)
   b. If not dedup'd: call `messageService.create()` (which handles consent + rate limits)
5. Update `lastExecutedAt`, `executionCount`, `nextExecutionAt`
6. Emit `proactive.schedule.executed` trace event

#### 4.2 ProactiveTriggerService

**File**: `apps/runtime/src/services/proactive/trigger-service.ts`

```typescript
export class ProactiveTriggerService {
  private triggerRegistry: Map<string, ProactiveTrigger[]>; // eventType → triggers[]
  private maxRegistrySize = 10_000;

  constructor(
    private readonly triggerRepo: ProactiveTriggerRepo,
    private readonly messageService: ProactiveMessageService,
    private readonly contactRepo: ContactRepositoryPort,
    private readonly expressionEvaluator: ExpressionEvaluatorPort,
    private readonly traceStore: TraceStorePort,
    private readonly redis: Redis,
  ) {}

  async initialize(): Promise<void>; // Load all active triggers into registry
  async create(params: CreateTriggerParams): Promise<ProactiveTrigger>;
  async update(
    tenantId: string,
    projectId: string,
    triggerId: string,
    params: UpdateTriggerParams,
  ): Promise<ProactiveTrigger>;
  async delete(tenantId: string, projectId: string, triggerId: string): Promise<void>;
  async onEvent(event: PlatformEvent): Promise<void>; // Event handler
}
```

**Event Handler** (`onEvent()`):

1. Look up triggers for `event.type` in in-memory registry
2. For each matching trigger:
   a. Evaluate condition expression: `expressionEvaluator.evaluate(trigger.conditions, event.data)`
   b. If condition false: emit `proactive.trigger.skipped`, continue
   c. Resolve contact: `expressionEvaluator.evaluate(trigger.contactResolver, event.data)` → contactId
   d. Create proactive message: `messageService.create({ ...trigger.messageTemplate, contactId })`
   e. Emit `proactive.trigger.fired` trace event
   f. Increment `fireCount` and `lastFiredAt`

**Registry Hot Reload**:

- On trigger CRUD: update local registry + publish to Redis Pub/Sub `proactive:trigger:reload`
- All pods subscribe to `proactive:trigger:reload` channel
- On message: reload triggers for the affected tenant/project
- Registry has max size (10,000) with LRU eviction per platform invariant (every in-memory Map needs max size, TTL, eviction)

#### 4.3 API Routes — Schedules

**File**: `apps/runtime/src/routes/proactive-schedules.ts`

CRUD routes for schedules with pause/resume actions.

#### 4.4 API Routes — Triggers

**File**: `apps/runtime/src/routes/proactive-triggers.ts`

CRUD routes for event triggers.

#### 4.5 Event Bus Integration

**File**: `apps/runtime/src/services/proactive/event-bus-integration.ts`

Subscribe to the eventstore event bus on runtime startup:

```typescript
export function registerProactiveTriggerListener(
  triggerService: ProactiveTriggerService,
  eventBus: EventBusPort,
): void {
  eventBus.subscribe('*', async (event) => {
    await triggerService.onEvent(event);
  });
}
```

### Exit Criteria — Phase 4

- [ ] Schedule CRUD with BullMQ repeatable job management
- [ ] Schedule execution resolves contacts, creates messages (batched)
- [ ] Schedule deduplication prevents duplicate messages
- [ ] Trigger CRUD with in-memory registry
- [ ] Trigger fires on matching events with condition evaluation
- [ ] Trigger registry hot reload across pods
- [ ] E2E tests pass: E2E-7, E2E-8
- [ ] Integration tests pass: INT-6, INT-7, INT-8, INT-9
- [ ] `pnpm build --filter=runtime` passes with zero type errors

---

## Phase 5: DSL Extension, Observability & Polish

**Goal**: Add DSL parser support, Prometheus metrics, trace event registration, and Studio wiring.

### Tasks

#### 5.1 DSL Parser — PROACTIVE Block

**File**: `packages/core/src/parser/agent-based-parser.ts` (modify)

Add `parseProactiveBlock()`:

1. Detect `PROACTIVE:` keyword at agent level
2. Parse `TEMPLATES:` section: named template defs with TEXT, FORMATS, ACTIONS
3. Parse `TRIGGERS:` section: EVENT, CONDITION, CONTACT_RESOLVER, TEMPLATE ref
4. Parse `RATE_LIMIT:` section: PER_CONTACT, PER_CHANNEL with rate expressions
5. Parse `CHANNEL_PREFERENCE:` section: ordered list of channel identifiers

**AST Type**: Add `ProactiveConfigAST` to `packages/core/src/types/agent-based.ts`

#### 5.2 IR Compiler — ProactiveConfigIR

**File**: `packages/compiler/src/platform/ir/compiler.ts` (modify)

Add `compileProactiveConfig()`:

1. Convert AST to IR (camelCase → snake_case)
2. Validate template references in triggers
3. Validate event types against known registry (warning, not error)
4. Validate rate limit expressions

**IR Type**: Add `ProactiveConfigIR` to `packages/compiler/src/platform/ir/schema.ts`

#### 5.3 Eventstore — Proactive Event Registration

**File**: `packages/eventstore/src/schema/events/proactive-events.ts` (new)

Register all `proactive.*` events with the event registry:

- `proactive.message.created`
- `proactive.message.delivered`
- `proactive.message.failed`
- `proactive.schedule.executed`
- `proactive.trigger.fired`
- `proactive.trigger.skipped`
- `proactive.consent.changed`

#### 5.4 Prometheus Metrics

**File**: `apps/runtime/src/services/proactive/metrics.ts`

Register counters and histograms:

```typescript
export const proactiveMetrics = {
  messagesTotal: new Counter({
    name: 'proactive_messages_total',
    labelNames: ['status', 'channel', 'trigger_type'],
  }),
  deliveryDuration: new Histogram({
    name: 'proactive_delivery_duration_ms',
    labelNames: ['channel', 'status'],
  }),
  deliveryRetries: new Counter({
    name: 'proactive_delivery_retries_total',
    labelNames: ['channel'],
  }),
  rateLimitHits: new Counter({
    name: 'proactive_rate_limit_hits_total',
    labelNames: ['granularity'],
  }),
  scheduleExecutions: new Counter({
    name: 'proactive_schedule_executions_total',
    labelNames: ['status'],
  }),
  triggerFires: new Counter({ name: 'proactive_trigger_fires_total', labelNames: ['event_type'] }),
  consentChanges: new Counter({
    name: 'proactive_consent_changes_total',
    labelNames: ['channel', 'action'],
  }),
  queueDepth: new Gauge({ name: 'proactive_queue_depth' }),
};
```

#### 5.5 Service Wiring

**File**: `apps/runtime/src/services/proactive/index.ts` (new)

Wire all proactive services together with DI:

```typescript
export function createProactiveServices(deps: {
  redis: Redis;
  db: Connection;
  channelAdapterRegistry: ChannelAdapterRegistryPort;
  outputGuardrails: OutputGuardrailsPort;
  templateEngine: TemplateEnginePort;
  traceStore: TraceStorePort;
  sessionStore: SessionStorePort;
  contactRepo: ContactRepositoryPort;
  eventBus: EventBusPort;
}): ProactiveServices;
```

#### 5.6 Runtime Startup Integration

**File**: `apps/runtime/src/server.ts` (modify)

On startup, if `PROACTIVE_MESSAGING_ENABLED`:

1. Create proactive services
2. Register proactive routes
3. Start delivery worker
4. Initialize trigger service (load registry)
5. Register event bus listener

#### 5.7 Unit Tests for DSL/IR

**Files**:

- `packages/core/src/__tests__/parser/proactive-block.test.ts`
- `packages/compiler/src/__tests__/proactive-compilation.test.ts`

Cover all 16 unit test scenarios (U-39 through U-54) from the test spec.

### Exit Criteria — Phase 5

- [ ] DSL parser handles `PROACTIVE:` block with all sub-sections
- [ ] IR compiler produces correct `ProactiveConfigIR`
- [ ] All proactive trace events registered in eventstore
- [ ] Prometheus metrics emitted for all operations
- [ ] Service wiring works end-to-end
- [ ] E2E tests pass: E2E-6, E2E-9, E2E-10
- [ ] Integration test pass: INT-13
- [ ] All 16 DSL/IR unit tests pass
- [ ] `pnpm build --filter=runtime --filter=@abl/compiler --filter=@abl/core` passes
- [ ] Full E2E suite (all 10 scenarios) passes

---

## Wiring Checklist

Every new component must be wired into its callers. This checklist prevents the "component exists but nobody calls it" pattern.

| Component                | Wired Into                      | Verification                                               |
| ------------------------ | ------------------------------- | ---------------------------------------------------------- |
| ProactiveMessage model   | ProactiveMessageRepo            | Repo can create/query records                              |
| ProactiveMessageRepo     | ProactiveMessageService         | Service calls repo.create, repo.findOne, repo.updateStatus |
| ProactiveMessageService  | `routes/proactive-messages.ts`  | POST handler calls service.create()                        |
| ProactiveDeliveryQueue   | ProactiveMessageService         | service.create() calls queue.enqueue()                     |
| ProactiveDeliveryWorker  | `server.ts` startup             | Worker started on PROACTIVE_MESSAGING_ENABLED              |
| ConsentService           | ProactiveMessageService         | service.create() calls consent.checkConsent()              |
| ConsentService           | `routes/contact-consent.ts`     | PUT handler calls consent.updateConsent()                  |
| ProactiveRateLimiter     | ProactiveMessageService         | service.create() calls rateLimiter.check()                 |
| ContactChannelResolver   | ProactiveMessageService         | service.create() calls resolver.resolve()                  |
| ProactiveScheduleService | `routes/proactive-schedules.ts` | CRUD handlers call schedule service                        |
| Schedule BullMQ worker   | `server.ts` startup             | Worker started on PROACTIVE_MESSAGING_ENABLED              |
| ProactiveTriggerService  | `routes/proactive-triggers.ts`  | CRUD handlers call trigger service                         |
| ProactiveTriggerService  | Event bus listener              | `registerProactiveTriggerListener()` called on startup     |
| Output guardrails        | ProactiveDeliveryWorker         | Worker calls guardrails.filter() before delivery           |
| Channel adapter registry | ProactiveDeliveryWorker         | Worker calls registry.get(channelType)                     |
| Feature flag middleware  | All proactive route files       | `router.use(requireFeatureFlag(...))`                      |
| Proactive routes         | `routes/index.ts`               | Routes registered in project-scoped router                 |

---

## File Index

### New Files (27)

| #   | File                                                              | Phase |
| --- | ----------------------------------------------------------------- | ----- |
| 1   | `apps/runtime/src/db/proactive-message.ts`                        | 1     |
| 2   | `apps/runtime/src/db/proactive-schedule.ts`                       | 1     |
| 3   | `apps/runtime/src/db/proactive-trigger.ts`                        | 1     |
| 4   | `apps/runtime/src/db/contact-consent.ts`                          | 1     |
| 5   | `apps/runtime/src/repos/proactive-message-repo.ts`                | 1     |
| 6   | `apps/runtime/src/repos/proactive-schedule-repo.ts`               | 1     |
| 7   | `apps/runtime/src/repos/proactive-trigger-repo.ts`                | 1     |
| 8   | `apps/runtime/src/repos/contact-consent-repo.ts`                  | 1     |
| 9   | `apps/runtime/src/validation/proactive-schemas.ts`                | 1     |
| 10  | `apps/runtime/src/types/proactive.ts`                             | 1     |
| 11  | `apps/runtime/src/services/proactive/consent-service.ts`          | 2     |
| 12  | `apps/runtime/src/services/proactive/rate-limiter.ts`             | 2     |
| 13  | `apps/runtime/src/services/proactive/contact-channel-resolver.ts` | 2     |
| 14  | `apps/runtime/src/services/proactive/message-service.ts`          | 2     |
| 15  | `apps/runtime/src/services/proactive/session-manager.ts`          | 2     |
| 16  | `apps/runtime/src/services/proactive/delivery-queue.ts`           | 3     |
| 17  | `apps/runtime/src/services/proactive/delivery-worker.ts`          | 3     |
| 18  | `apps/runtime/src/routes/proactive-messages.ts`                   | 3     |
| 19  | `apps/runtime/src/routes/contact-consent.ts`                      | 3     |
| 20  | `apps/runtime/src/middleware/feature-flag.ts`                     | 3     |
| 21  | `apps/runtime/src/services/proactive/schedule-service.ts`         | 4     |
| 22  | `apps/runtime/src/services/proactive/trigger-service.ts`          | 4     |
| 23  | `apps/runtime/src/routes/proactive-schedules.ts`                  | 4     |
| 24  | `apps/runtime/src/routes/proactive-triggers.ts`                   | 4     |
| 25  | `apps/runtime/src/services/proactive/event-bus-integration.ts`    | 4     |
| 26  | `packages/eventstore/src/schema/events/proactive-events.ts`       | 5     |
| 27  | `apps/runtime/src/services/proactive/metrics.ts`                  | 5     |
| 28  | `apps/runtime/src/services/proactive/index.ts`                    | 5     |

### Modified Files (8)

| #   | File                                                  | Phase | Change                                 |
| --- | ----------------------------------------------------- | ----- | -------------------------------------- |
| 1   | `apps/runtime/src/channels/types.ts`                  | 3     | Add `ChannelOutboundAdapter` interface |
| 2   | `apps/runtime/src/channels/adapters/email-adapter.ts` | 3     | Implement `sendOutbound()`             |
| 3   | `apps/runtime/src/channels/adapters/slack-adapter.ts` | 3     | Implement `sendOutbound()`             |
| 4   | `apps/runtime/src/routes/index.ts`                    | 3     | Register proactive routes              |
| 5   | `apps/runtime/src/server.ts`                          | 5     | Startup: init proactive services       |
| 6   | `packages/core/src/parser/agent-based-parser.ts`      | 5     | Add `parseProactiveBlock()`            |
| 7   | `packages/core/src/types/agent-based.ts`              | 5     | Add `ProactiveConfigAST`               |
| 8   | `packages/compiler/src/platform/ir/schema.ts`         | 5     | Add `ProactiveConfigIR`                |

---

## Risk Mitigations Per Phase

| Phase | Key Risk                               | Mitigation                                                               |
| ----- | -------------------------------------- | ------------------------------------------------------------------------ |
| 1     | Schema drift between models and types  | Zod schemas are source of truth; TS types derived                        |
| 2     | Rate limiter race conditions           | Redis Lua script for atomicity; integration tests with concurrent access |
| 3     | Channel adapter outbound not supported | Audit adapters before implementing; start with email+slack only          |
| 4     | Schedule drift / duplicate execution   | BullMQ repeatable job dedup + Redis SET NX for contact dedup             |
| 5     | DSL parser breaking existing tests     | PROACTIVE block is isolated; no changes to existing parser logic         |

---

## Estimated Effort

| Phase                         | Effort        | Dependencies                     |
| ----------------------------- | ------------- | -------------------------------- |
| Phase 1: Data Layer           | 1-2 days      | None                             |
| Phase 2: Core Services        | 2-3 days      | Phase 1                          |
| Phase 3: Delivery & API       | 2-3 days      | Phase 2                          |
| Phase 4: Schedules & Triggers | 2-3 days      | Phase 3                          |
| Phase 5: DSL & Polish         | 2-3 days      | Phase 4 (DSL), Phase 3 (metrics) |
| **Total**                     | **9-14 days** |                                  |

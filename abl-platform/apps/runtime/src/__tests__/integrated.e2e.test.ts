/**
 * Integrated E2E Tests
 *
 * End-to-end conversation tests that exercise:
 * - MongoConversationStore for session lifecycle and persistence
 * - MongoMessageStore for message recording and retrieval
 * - MongoAgentRegistry for agent versioning and promotion
 * - Model capability lookup and cost calculation (pure functions)
 *
 * Uses mongodb-memory-server for real Mongoose integration tests.
 * Dynamic imports prevent @agent-platform/database/models from
 * auto-connecting before the in-memory server is ready.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { initDEKFacade } from '@agent-platform/database/kms';
import { setupTestMongo, teardownTestMongo, clearCollections } from './helpers/setup-mongo.js';
import { getModelCapabilities, calculateCost } from '../services/llm/model-router.js';
import { runWithTenantContext } from '@agent-platform/shared';

function withTestTenant<T>(tenantId: string, fn: () => T): T {
  return runWithTenantContext(
    {
      tenantId,
      userId: 'test-user',
      role: 'ADMIN',
      permissions: ['read', 'write'],
      authType: 'user' as const,
      isSuperAdmin: false,
    },
    fn,
  );
}

// Lazy-imported store instances — initialised in beforeAll after Mongo is up.
let MongoConversationStore: typeof import('../services/stores/mongo-conversation-store.js').MongoConversationStore;
let MongoMessageStore: typeof import('../services/stores/mongo-message-store.js').MongoMessageStore;
let MongoAgentRegistry: typeof import('../services/stores/mongo-agent-registry.js').MongoAgentRegistry;

beforeAll(async () => {
  // Start in-memory MongoDB BEFORE any model registration.
  await setupTestMongo();

  const models = await import('@agent-platform/database/models');
  models.setMasterKey('ab'.repeat(32));
  await initDEKFacade({ masterKeyHex: 'ab'.repeat(32) });

  // Dynamic imports so Mongoose models register on the already-connected instance.
  const convMod = await import('../services/stores/mongo-conversation-store.js');
  MongoConversationStore = convMod.MongoConversationStore;

  const msgMod = await import('../services/stores/mongo-message-store.js');
  MongoMessageStore = msgMod.MongoMessageStore;

  const regMod = await import('../services/stores/mongo-agent-registry.js');
  MongoAgentRegistry = regMod.MongoAgentRegistry;
}, 60_000);

afterEach(async () => {
  await clearCollections();
});

afterAll(async () => {
  await teardownTestMongo();
});

// =============================================================================
// CONVERSATION STORE: SESSION LIFECYCLE
// =============================================================================

describe('Integrated E2E: Conversation Store with Runtime', () => {
  function createConvStore() {
    return new MongoConversationStore({ type: 'mongodb' });
  }

  function createMsgStore() {
    return new MongoMessageStore({ type: 'mongodb' });
  }

  test('should create session and track conversation through flow', async () => {
    const convStore = createConvStore();
    const msgStore = createMsgStore();

    // 1. Create a new session
    const session = await convStore.createSession({
      tenantId: 'tenant-e2e',
      projectId: 'proj-e2e',
      customerId: 'customer-1',
      channel: 'web_chat',
      environment: 'dev',
      agentName: 'booking_agent',
      agentVersion: '1.0.0',
      metadata: { source: 'e2e-test' },
    });

    expect(session.id).toBeDefined();
    expect(session.status).toBe('active');
    expect(session.currentAgent).toBe('booking_agent');
    expect(session.channel).toBe('web_chat');
    expect(session.environment).toBe('dev');
    expect(session.startedAt).toBeInstanceOf(Date);
    expect(session.lastActivityAt).toBeInstanceOf(Date);

    await withTestTenant('tenant-e2e', async () => {
      // 2. Add user message
      const userMsg = await msgStore.addMessage({
        sessionId: session.id,
        role: 'user',
        content: 'I want to book a hotel in Paris',
        channel: 'web_chat',
        traceId: 'trace-1',
      });

      expect(userMsg.id).toBeDefined();
      expect(userMsg.role).toBe('user');
      expect(userMsg.content).toBe('I want to book a hotel in Paris');
      expect(userMsg.sessionId).toBe(session.id);

      // 3. Add assistant response
      const assistantMsg = await msgStore.addMessage({
        sessionId: session.id,
        role: 'assistant',
        content: 'I can help you book a hotel in Paris. What dates are you looking at?',
        channel: 'web_chat',
        traceId: 'trace-1',
      });

      expect(assistantMsg.role).toBe('assistant');

      // 4. Verify message history
      const messages = await msgStore.getMessages({
        sessionId: session.id,
        tenantId: 'tenant-e2e',
      });
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('user');
      expect(messages[1].role).toBe('assistant');

      // 5. Update session context (simulating agent collecting data)
      const updatedSession = await convStore.updateSession(session.id, {
        context: { destination: 'Paris', step: 'collect_dates' },
      });

      expect(updatedSession.context).toEqual({ destination: 'Paris', step: 'collect_dates' });
      expect(updatedSession.lastActivityAt.getTime()).toBeGreaterThanOrEqual(
        session.lastActivityAt.getTime(),
      );

      // 6. End session
      const endedSession = await convStore.endSession(session.id, 'completed');
      expect(endedSession.status).toBe('ended');
      expect(endedSession.disposition).toBe('completed');
      expect(endedSession.endedAt).toBeInstanceOf(Date);
    });
  });

  test('should resume session and continue conversation', async () => {
    const convStore = createConvStore();
    const msgStore = createMsgStore();

    // Create initial session
    const session = await convStore.createSession({
      tenantId: 'tenant-e2e',
      projectId: 'proj-e2e',
      customerId: 'customer-resume',
      channel: 'web_chat',
      environment: 'dev',
      agentName: 'support_agent',
      agentVersion: '1.0.0',
    });

    await withTestTenant('tenant-e2e', async () => {
      // Add initial message
      await msgStore.addMessage({
        sessionId: session.id,
        role: 'user',
        content: 'My order is delayed',
        channel: 'web_chat',
        traceId: 'trace-r-1',
      });

      // Resume the session by the same customer on the same channel
      const resumed = await convStore.resumeSession({
        customerId: 'customer-resume',
        channel: 'web_chat',
        maxAgeMs: 60_000,
      });

      expect(resumed).not.toBeNull();
      expect(resumed!.id).toBe(session.id);
      expect(resumed!.status).toBe('active');
      expect(resumed!.currentAgent).toBe('support_agent');

      // Continue conversation on the resumed session
      await msgStore.addMessage({
        sessionId: resumed!.id,
        role: 'user',
        content: 'Order number is 12345',
        channel: 'web_chat',
        traceId: 'trace-r-2',
      });

      const messages = await msgStore.getMessages({
        sessionId: resumed!.id,
        tenantId: 'tenant-e2e',
      });
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('My order is delayed');
      expect(messages[1].content).toBe('Order number is 12345');
    });
  });

  test('should track voice session with metadata', async () => {
    const convStore = createConvStore();

    // Create a voice session
    const session = await convStore.createSession({
      tenantId: 'tenant-voice',
      projectId: 'proj-voice',
      channel: 'voice',
      environment: 'production',
      agentName: 'voice_agent',
      agentVersion: '2.0.0',
      callerNumber: '+1-555-123-4567',
      metadata: { source: 'ivr-inbound' },
    });

    expect(session.id).toBeDefined();
    expect(session.channel).toBe('voice');
    expect(session.callerNumber).toBe('+1-555-123-4567');

    await withTestTenant('tenant-voice', async () => {
      // Record voice metadata (telephony info)
      await convStore.recordVoiceMetadata(session.id, {
        callerNumber: '+1-555-123-4567',
        calledNumber: '+1-800-SUPPORT',
        callSid: 'CA-test-sid-001',
        provider: 'twilio',
      });

      // Verify the metadata was persisted
      const fetched = await convStore.getSession(session.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.metadata?.voice?.callSid).toBe('CA-test-sid-001');
      expect(fetched!.metadata?.voice?.provider).toBe('twilio');

      // Simulate an abandoned call
      await convStore.captureAbandonedCall(
        session.id,
        'I need to talk to someone about my...',
        'caller_hangup',
      );

      const abandoned = await convStore.getSession(session.id);
      expect(abandoned).not.toBeNull();
      expect(abandoned!.status).toBe('ended');
      expect(abandoned!.disposition).toBe('abandoned');
      expect(abandoned!.metadata?.abandonReason).toBe('caller_hangup');
    });
  });
});

// =============================================================================
// AGENT REGISTRY: VERSIONING & PROMOTION
// =============================================================================

describe('Integrated E2E: Agent Registry with Runtime', () => {
  const TENANT_ID = 'test-tenant';
  const PROJECT_ID = 'proj-registry-e2e';
  const SAMPLE_DSL = 'AGENT booking_agent\n  GOAL: Help users book hotels';
  const SAMPLE_IR = JSON.stringify({
    name: 'booking_agent',
    type: 'reasoning',
    goal: 'Help users book hotels',
  });
  const SAMPLE_HASH = 'abc123def456';

  function createRegistry() {
    return new MongoAgentRegistry(
      { type: 'mongodb' },
      { tenantId: TENANT_ID, projectId: PROJECT_ID },
    );
  }

  /** Helper: pre-seed a ProjectAgent document so version CRUD uses an existing parent record. */
  async function seedProjectAgent(name: string) {
    const { ProjectAgent } = await import('@agent-platform/database/models');
    await ProjectAgent.create({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      name,
      agentPath: `default/${name}`,
      dslContent: null,
      activeVersions: {},
    });
  }

  test('should register new agent version', async () => {
    const registry = createRegistry();

    // Pre-seed the ProjectAgent so saveVersion finds it
    await seedProjectAgent('booking_agent');

    // Save a new agent version directly (bypassing DSL compilation)
    await registry.saveVersion({
      agentName: 'booking_agent',
      version: '1.0.0',
      status: 'draft',
      dslContent: SAMPLE_DSL,
      irContent: SAMPLE_IR,
      sourceHash: SAMPLE_HASH,
      createdAt: new Date(),
      createdBy: 'developer-1',
      changelog: 'Initial version',
    });

    // Retrieve the version
    const version = await registry.getVersion('booking_agent', '1.0.0');
    expect(version).not.toBeNull();
    expect(version!.agentName).toBe('booking_agent');
    expect(version!.version).toBe('1.0.0');
    expect(version!.status).toBe('draft');
    expect(version!.dslContent).toBe(SAMPLE_DSL);
    expect(version!.irContent).toBe(SAMPLE_IR);
    expect(version!.sourceHash).toBe(SAMPLE_HASH);
    expect(version!.createdBy).toBe('developer-1');
    expect(version!.changelog).toBe('Initial version');

    // Agent should appear in agent list
    const agents = await registry.listAgents();
    expect(agents).toContain('booking_agent');

    // Latest version should be this one
    const latest = await registry.getLatestVersion('booking_agent');
    expect(latest).not.toBeNull();
    expect(latest!.version).toBe('1.0.0');
  });

  test('should create new version with changes', async () => {
    const registry = createRegistry();

    // Pre-seed the ProjectAgent
    await seedProjectAgent('booking_agent');

    // Save initial version
    await registry.saveVersion({
      agentName: 'booking_agent',
      version: '1.0.0',
      status: 'active',
      dslContent: SAMPLE_DSL,
      irContent: SAMPLE_IR,
      sourceHash: SAMPLE_HASH,
      createdAt: new Date(Date.now() - 60_000),
      createdBy: 'developer-1',
      changelog: 'Initial version',
    });

    // Save a new version with updated DSL
    const updatedDSL = 'AGENT booking_agent\n  GOAL: Help users book hotels and flights';
    const updatedIR = JSON.stringify({
      name: 'booking_agent',
      type: 'reasoning',
      goal: 'Help users book hotels and flights',
    });

    await registry.saveVersion({
      agentName: 'booking_agent',
      version: '1.0.1',
      status: 'draft',
      dslContent: updatedDSL,
      irContent: updatedIR,
      sourceHash: 'xyz789updated',
      createdAt: new Date(),
      createdBy: 'developer-2',
      changelog: 'Added flight booking capability',
    });

    // Both versions should exist
    const v1 = await registry.getVersion('booking_agent', '1.0.0');
    const v2 = await registry.getVersion('booking_agent', '1.0.1');

    expect(v1).not.toBeNull();
    expect(v2).not.toBeNull();
    expect(v1!.status).toBe('active');
    expect(v2!.status).toBe('draft');
    expect(v2!.changelog).toBe('Added flight booking capability');

    // Latest version should be the newer one
    const latest = await registry.getLatestVersion('booking_agent');
    expect(latest).not.toBeNull();
    expect(latest!.version).toBe('1.0.1');

    // Version history should show both, newest first
    const history = await registry.getVersionHistory('booking_agent');
    expect(history).toHaveLength(2);
    expect(history[0].version).toBe('1.0.1');
    expect(history[1].version).toBe('1.0.0');
  });

  test('should promote version to staging environment', async () => {
    const registry = createRegistry();

    // Pre-seed the ProjectAgent
    await seedProjectAgent('booking_agent');

    // Save a draft version
    await registry.saveVersion({
      agentName: 'booking_agent',
      version: '1.0.0',
      status: 'draft',
      dslContent: SAMPLE_DSL,
      irContent: SAMPLE_IR,
      sourceHash: SAMPLE_HASH,
      createdAt: new Date(),
      createdBy: 'developer-1',
      changelog: 'Initial version',
    });

    // Promote to staging by setting the active version
    await registry.setActiveVersion('booking_agent', '1.0.0', 'staging');

    // Update the version status to staged
    await registry.saveVersion({
      agentName: 'booking_agent',
      version: '1.0.0',
      status: 'staged',
      dslContent: SAMPLE_DSL,
      irContent: SAMPLE_IR,
      sourceHash: SAMPLE_HASH,
      createdAt: new Date(),
      createdBy: 'developer-1',
      changelog: 'Initial version',
      promotedAt: new Date(),
      promotedBy: 'lead-dev',
    });

    // Verify active version in staging
    const activeInStaging = await registry.getActiveVersion('booking_agent', 'staging');
    expect(activeInStaging).toBe('1.0.0');

    // No active version in production yet
    const activeInProd = await registry.getActiveVersion('booking_agent', 'production');
    expect(activeInProd).toBeNull();

    // Check getActiveVersions returns the staging mapping
    const allActive = await registry.getActiveVersions('booking_agent');
    expect(allActive.staging).toBe('1.0.0');
    expect(allActive.prod).toBeUndefined();

    // Verify the version document reflects promotion
    const version = await registry.getVersion('booking_agent', '1.0.0');
    expect(version).not.toBeNull();
    expect(version!.status).toBe('staged');
    expect(version!.promotedBy).toBe('lead-dev');
    expect(version!.promotedAt).toBeInstanceOf(Date);
  });
});

// =============================================================================
// MODEL CAPABILITIES & COST CALCULATION E2E TESTS
// (These tests are pure functions — no DB dependency, kept as-is)
// =============================================================================

describe('Integrated E2E: Model Capabilities & Cost', () => {
  describe('Model Capabilities Lookup', () => {
    test('should return capabilities for fast tier model', () => {
      const caps = getModelCapabilities('anthropic/claude-haiku-4-5');
      expect(caps.supportsTools).toBe(true);
      expect(caps.supportsVision).toBe(true);
      expect(caps.contextWindow).toBe(200000);
    });

    test('should return capabilities for balanced tier model', () => {
      const caps = getModelCapabilities('anthropic/claude-sonnet-4');
      expect(caps.supportsTools).toBe(true);
      expect(caps.supportsVision).toBe(true);
      expect(caps.inputCostPer1k).toBe(0.003);
    });

    test('should return capabilities for powerful tier model', () => {
      const caps = getModelCapabilities('anthropic/claude-opus-4');
      expect(caps.supportsTools).toBe(true);
      expect(caps.inputCostPer1k).toBe(0.015);
      expect(caps.outputCostPer1k).toBe(0.075);
    });
  });

  describe('Cost Calculation', () => {
    test('should calculate cost based on token usage', () => {
      const cost = calculateCost(0.003, 0.015, 1000, 500);
      expect(cost).toBeCloseTo(0.003 + 0.0075, 5);
    });

    test('should handle zero costs', () => {
      const cost = calculateCost(0, 0, 1000, 500);
      expect(cost).toBe(0);
    });
  });
});

// =============================================================================
// FULL CONVERSATION FLOW
// =============================================================================

describe('Integrated E2E: Full Conversation Flow', () => {
  test('should complete full hotel booking conversation with store persistence', async () => {
    const convStore = new MongoConversationStore({ type: 'mongodb' });
    const msgStore = new MongoMessageStore({ type: 'mongodb' });
    const tenantId = 'tenant-full';
    const fullFlowProjectId = 'proj-full-flow';
    const registry = new MongoAgentRegistry(
      { type: 'mongodb' },
      { tenantId, projectId: fullFlowProjectId },
    );

    // Pre-seed the ProjectAgent (agentPath is required by the model)
    const { ProjectAgent } = await import('@agent-platform/database/models');
    await ProjectAgent.create({
      tenantId,
      projectId: fullFlowProjectId,
      name: 'hotel_booking',
      agentPath: 'default/hotel_booking',
      dslContent: null,
      activeVersions: {},
    });

    // 1. Register the agent
    await registry.saveVersion({
      agentName: 'hotel_booking',
      version: '1.0.0',
      status: 'active',
      dslContent: 'AGENT hotel_booking\n  GOAL: Book hotels',
      irContent: JSON.stringify({ name: 'hotel_booking', type: 'scripted' }),
      sourceHash: 'full-flow-hash',
      createdAt: new Date(),
      createdBy: 'admin',
      changelog: 'Production ready',
    });
    await registry.setActiveVersion('hotel_booking', '1.0.0', 'dev');

    // Verify the agent is registered and active
    const activeVersion = await registry.getActiveVersion('hotel_booking', 'dev');
    expect(activeVersion).toBe('1.0.0');

    // 2. Create a session for the conversation
    const session = await convStore.createSession({
      tenantId,
      projectId: 'proj-full-flow',
      customerId: 'customer-full',
      channel: 'web_chat',
      environment: 'dev',
      agentName: 'hotel_booking',
      agentVersion: '1.0.0',
    });
    expect(session.status).toBe('active');

    await withTestTenant('tenant-full', async () => {
      // 3. Simulate multi-turn conversation
      // Turn 1: User greeting
      await msgStore.addMessage({
        sessionId: session.id,
        role: 'user',
        content: 'Hi, I want to book a hotel in Tokyo',
        channel: 'web_chat',
        traceId: 'trace-full-1',
      });
      await msgStore.addMessage({
        sessionId: session.id,
        role: 'assistant',
        content: 'Great! I can help you book a hotel in Tokyo. What dates are you looking at?',
        channel: 'web_chat',
        traceId: 'trace-full-1',
      });

      // Update session context with collected destination
      await convStore.updateSession(session.id, {
        context: { destination: 'Tokyo' },
      });

      // Turn 2: Dates
      await msgStore.addMessage({
        sessionId: session.id,
        role: 'user',
        content: 'March 15 to March 20',
        channel: 'web_chat',
        traceId: 'trace-full-2',
      });
      await msgStore.addMessage({
        sessionId: session.id,
        role: 'assistant',
        content:
          'I found several options for March 15-20 in Tokyo. Would you prefer luxury or budget?',
        channel: 'web_chat',
        traceId: 'trace-full-2',
      });

      // Update context with dates
      await convStore.updateSession(session.id, {
        context: { destination: 'Tokyo', checkIn: '2026-03-15', checkOut: '2026-03-20' },
      });

      // Turn 3: Confirmation
      await msgStore.addMessage({
        sessionId: session.id,
        role: 'user',
        content: 'Budget please',
        channel: 'web_chat',
        traceId: 'trace-full-3',
      });
      await msgStore.addMessage({
        sessionId: session.id,
        role: 'assistant',
        content: 'Your hotel has been booked! Confirmation #TKY-2026-001.',
        channel: 'web_chat',
        traceId: 'trace-full-3',
      });

      // 4. Verify full message history
      const allMessages = await msgStore.getMessages({
        sessionId: session.id,
        tenantId: 'tenant-full',
      });
      expect(allMessages).toHaveLength(6);
      expect(allMessages[0].role).toBe('user');
      expect(allMessages[5].content).toContain('Confirmation #TKY-2026-001');

      // Verify message count
      const count = await msgStore.getMessageCount(session.id);
      expect(count).toBe(6);

      // 5. Link a contact to the session
      await convStore.linkContact(session.id, 'contact-tokyo-guest');

      const linkedSession = await convStore.getSession(session.id);
      expect(linkedSession!.contactId).toBe('contact-tokyo-guest');

      // 6. End the session successfully
      const ended = await convStore.endSession(session.id, 'completed');
      expect(ended.status).toBe('ended');
      expect(ended.disposition).toBe('completed');
      expect(ended.endedAt).toBeInstanceOf(Date);

      // 7. Query sessions to verify it shows up
      const { sessions, total } = await convStore.querySessions({
        customerId: 'customer-full',
      });
      expect(total).toBe(1);
      expect(sessions[0].id).toBe(session.id);
    });
  });

  test('should handle back navigation with store persistence', async () => {
    const convStore = new MongoConversationStore({ type: 'mongodb' });
    const msgStore = new MongoMessageStore({ type: 'mongodb' });

    // Create session
    const session = await convStore.createSession({
      tenantId: 'tenant-nav',
      projectId: 'proj-nav',
      customerId: 'customer-nav',
      channel: 'web_chat',
      environment: 'dev',
      agentName: 'multi_step_agent',
      agentVersion: '1.0.0',
    });

    await withTestTenant('tenant-nav', async () => {
      // Step 1: Collect name
      await msgStore.addMessage({
        sessionId: session.id,
        role: 'assistant',
        content: 'What is your name?',
        channel: 'web_chat',
        traceId: 'trace-nav-1',
      });
      await msgStore.addMessage({
        sessionId: session.id,
        role: 'user',
        content: 'Alice',
        channel: 'web_chat',
        traceId: 'trace-nav-1',
      });

      await convStore.updateSession(session.id, {
        context: { name: 'Alice', currentStep: 'collect_email' },
      });

      // Step 2: Collect email
      await msgStore.addMessage({
        sessionId: session.id,
        role: 'assistant',
        content: 'What is your email?',
        channel: 'web_chat',
        traceId: 'trace-nav-2',
      });
      await msgStore.addMessage({
        sessionId: session.id,
        role: 'user',
        content: 'Wait, I want to change my name',
        channel: 'web_chat',
        traceId: 'trace-nav-2',
      });

      // Simulate back navigation: reset context to previous step
      await convStore.updateSession(session.id, {
        context: { name: null, currentStep: 'collect_name' },
      });

      // Verify context was rolled back
      const rolledBack = await convStore.getSession(session.id);
      expect(rolledBack!.context).toEqual({ name: null, currentStep: 'collect_name' });

      // Step 1 again: Re-collect name
      await msgStore.addMessage({
        sessionId: session.id,
        role: 'assistant',
        content: 'Sure! What name would you like to use?',
        channel: 'web_chat',
        traceId: 'trace-nav-3',
      });
      await msgStore.addMessage({
        sessionId: session.id,
        role: 'user',
        content: 'Bob',
        channel: 'web_chat',
        traceId: 'trace-nav-3',
      });

      await convStore.updateSession(session.id, {
        context: { name: 'Bob', currentStep: 'collect_email' },
      });

      // Verify the corrected context
      const corrected = await convStore.getSession(session.id);
      expect(corrected!.context).toEqual({ name: 'Bob', currentStep: 'collect_email' });

      // Verify full message history is preserved (no messages lost during back-nav)
      const allMessages = await msgStore.getMessages({
        sessionId: session.id,
        tenantId: 'tenant-nav',
      });
      expect(allMessages).toHaveLength(6);
      expect(allMessages.map((m) => m.role)).toEqual([
        'assistant',
        'user',
        'assistant',
        'user',
        'assistant',
        'user',
      ]);
    });
  });
});

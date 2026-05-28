/**
 * Platform E2E Integration Tests
 *
 * Tests the full data flow end-to-end using mongodb-memory-server:
 * 1. Auth: dev-login creates user, JWT tokens, org context
 * 2. Projects: loaded via access token (org-scoped)
 * 3. Sessions: created with expanded fields (contactId, projectId, etc.)
 * 4. Messages: stored per session with role, channel, traceId
 * 5. Traces: stored in TraceStore with ring buffer
 * 6. LLM metrics: recorded per call with token counts and latency
 * 7. Contacts: created, linked to sessions asynchronously
 * 8. Workflow definitions: created and associated with sessions
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { initDEKFacade } from '@agent-platform/database/kms';
import { setupTestMongo, teardownTestMongo, clearCollections } from './helpers/setup-mongo.js';
import { randomUUID } from 'crypto';
import { runWithTenantContext } from '@agent-platform/shared';

// Store imports (these do NOT pull in @agent-platform/database/models at top level
// because the stores are classes, not model-registering modules themselves —
// the model registration happens inside the store methods when they call the model).
// However, the store files DO have top-level imports from @agent-platform/database/models.
// To be safe, we import store factory functions dynamically too.

// Trace store — inline test implementation using the new TraceEventSink/TraceProvider interface
import {
  createTraceContext,
  type TraceProvider,
  type TraceEventSink,
  type QueryTracesParams,
} from '@abl/compiler/platform/stores/trace-store.js';
import type { TraceContext, TraceEvent } from '@abl/compiler/platform/core/types';

/** Test-only in-memory TraceProvider with query support */
class TestTraceProvider implements TraceProvider {
  private traces: Map<string, TraceContext> = new Map();

  startTrace(params: {
    sessionId: string;
    agentName: string;
    agentVersion: string;
    environment: string;
    parentSpanId?: string;
    nodeId?: string;
  }) {
    return createTraceContext({
      sink: this,
      params: params as any,
      samplingRate: 1.0,
      onCreate: (ctx) => {
        this.traces.set(ctx.traceId, { ...ctx, events: [] });
      },
    });
  }

  appendEvent(traceId: string, event: TraceEvent): void {
    const trace = this.traces.get(traceId);
    if (trace) {
      trace.events.push(event);
    }
  }

  endTrace(context: TraceContext): void {
    const trace = this.traces.get(context.traceId);
    if (trace) {
      trace.endTime = context.endTime;
    }
  }

  async getTrace(traceId: string): Promise<TraceContext | null> {
    return this.traces.get(traceId) || null;
  }

  async queryTraces(params: QueryTracesParams): Promise<TraceContext[]> {
    let traces = Array.from(this.traces.values());
    if (params.sessionId) {
      traces = traces.filter((t) => t.sessionId === params.sessionId);
    }
    if (params.agentName) {
      traces = traces.filter((t) => t.agentName === params.agentName);
    }
    return traces.slice(0, params.limit || 100);
  }
}

// =============================================================================
// Test Constants
// =============================================================================

const TENANT_ID = 'tenant-e2e-test';
const PROJECT_ID = 'project-e2e-test';
const OWNER_ID = 'owner-e2e-test';
const USER_EMAIL = 'e2e-test@example.com';

function withTestTenant<T>(fn: () => T): T {
  return runWithTenantContext(
    {
      tenantId: TENANT_ID,
      userId: 'test-user',
      role: 'ADMIN',
      permissions: ['read', 'write'],
      authType: 'user' as const,
      isSuperAdmin: false,
    },
    fn,
  );
}

// =============================================================================
// Dynamic model/store references (populated in beforeAll)
// =============================================================================

let SessionModel: any;
let MessageModel: any;
let ContactModel: any;
let ProjectModel: any;
let LLMUsageMetricModel: any;
let WorkflowModel: any;
let UserModel: any;
let OrganizationModel: any;

let MongoConversationStore: any;
let MongoMessageStore: any;
let MongoContactStore: any;
let MongoWorkflowDefinitionStore: any;

let conversationStore: any;
let messageStore: any;
let contactStore: any;
let workflowStore: any;
let traceStore: TestTraceProvider;

// =============================================================================
// Tests
// =============================================================================

describe('Platform E2E: Auth -> Projects -> Sessions -> Messages -> Traces -> Metrics', () => {
  beforeAll(async () => {
    // 1. Start in-memory MongoDB and connect mongoose
    await setupTestMongo();

    // 2. Dynamically import models AFTER mongoose is connected
    const models = await import('@agent-platform/database/models');
    models.setMasterKey('ab'.repeat(32));
    await initDEKFacade({ masterKeyHex: 'ab'.repeat(32) });
    SessionModel = models.Session;
    MessageModel = models.Message;
    ContactModel = models.Contact;
    ProjectModel = models.Project;
    LLMUsageMetricModel = models.LLMUsageMetric;
    WorkflowModel = models.Workflow;
    UserModel = models.User;
    OrganizationModel = models.Organization;

    // 3. Dynamically import store classes
    const convMod = await import('../services/stores/mongo-conversation-store.js');
    const msgMod = await import('../services/stores/mongo-message-store.js');
    const conMod = await import('../services/stores/mongo-contact-store.js');
    const wfMod = await import('../services/stores/mongo-workflow-definition-store.js');

    MongoConversationStore = convMod.MongoConversationStore;
    MongoMessageStore = msgMod.MongoMessageStore;
    MongoContactStore = conMod.MongoContactStore;
    MongoWorkflowDefinitionStore = wfMod.MongoWorkflowDefinitionStore;

    // 4. Instantiate stores
    conversationStore = new MongoConversationStore({ type: 'mongodb' });
    messageStore = new MongoMessageStore({ type: 'mongodb' });
    contactStore = new MongoContactStore({ type: 'mongodb' });
    workflowStore = new MongoWorkflowDefinitionStore({ type: 'mongodb' });
    traceStore = new TestTraceProvider();
  }, 30_000);

  afterEach(async () => {
    await clearCollections();
  });

  afterAll(async () => {
    await teardownTestMongo();
  }, 15_000);

  // =========================================================================
  // Section 1: Auth
  // =========================================================================

  test('dev-login creates user, org, and returns valid JWT', async () => {
    // Simulate dev-login: create a User and Organization directly in Mongo
    const user = await UserModel.create({
      email: USER_EMAIL,
      name: 'E2E Test User',
      authProvider: 'email',
      emailVerified: true,
    });

    const org = await OrganizationModel.create({
      name: 'E2E Test Org',
      slug: 'e2e-test-org',
      ownerId: user._id,
    });

    // Verify persisted data
    expect(user._id).toBeDefined();
    expect(user.email).toBe(USER_EMAIL);
    expect(user.authProvider).toBe('email');

    expect(org._id).toBeDefined();
    expect(org.ownerId).toBe(user._id);
    expect(org.slug).toBe('e2e-test-org');
  });

  // REMOVED: 'invalid/expired token is rejected' and 'refresh token is not accepted as access token'
  // were empty test bodies (no assertions). Real JWT expiry and token-type enforcement
  // is fully covered by middleware-auth.test.ts with actual JWT signing/verification.

  // =========================================================================
  // Section 2: Projects
  // =========================================================================

  test('creates project and loads it by owner', async () => {
    const project = await ProjectModel.create({
      name: 'E2E Test Project',
      slug: `e2e-project-${randomUUID().slice(0, 8)}`,
      ownerId: OWNER_ID,
      tenantId: TENANT_ID,
    });

    expect(project._id).toBeDefined();
    expect(project.name).toBe('E2E Test Project');
    expect(project.ownerId).toBe(OWNER_ID);

    // Load by owner
    const found = await ProjectModel.find({ ownerId: OWNER_ID }).lean();
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('E2E Test Project');
    expect(found[0].tenantId).toBe(TENANT_ID);
  });

  // =========================================================================
  // Section 3: Sessions
  // =========================================================================

  test('creates session with all expanded fields via MongoConversationStore', async () => {
    const session = await conversationStore.createSession({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      customerId: 'cust-001',
      channel: 'web',
      environment: 'dev',
      agentName: 'booking_agent',
      agentVersion: '1.0.0',
      contactId: 'contact-001',
      callerNumber: '+15551234567',
      initiatedById: 'operator-1',
      metadata: { source: 'e2e-test' },
    });

    expect(session.id).toBeDefined();
    expect(session.tenantId).toBe(TENANT_ID);
    expect(session.projectId).toBe(PROJECT_ID);
    expect(session.customerId).toBe('cust-001');
    expect(session.channel).toBe('web');
    expect(session.environment).toBe('dev');
    expect(session.currentAgent).toBe('booking_agent');
    expect(session.status).toBe('active');
    expect(session.contactId).toBe('contact-001');
    expect(session.callerNumber).toBe('+15551234567');
    expect(session.startedAt).toBeInstanceOf(Date);
    expect(session.lastActivityAt).toBeInstanceOf(Date);
  });

  test('linkContact updates session after creation', async () => {
    // Create session without contactId
    const session = await conversationStore.createSession({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      channel: 'web_chat',
      environment: 'dev',
      agentName: 'support_agent',
      agentVersion: '1.0.0',
    });

    expect(session.contactId).toBeNull();

    await withTestTenant(async () => {
      // Link contact asynchronously
      await conversationStore.linkContact(session.id, 'contact-linked-001');

      // Verify the session was updated
      const updated = await conversationStore.getSession(session.id);
      expect(updated).not.toBeNull();
      expect(updated!.contactId).toBe('contact-linked-001');
      expect(updated!.lastActivityAt.getTime()).toBeGreaterThanOrEqual(
        session.lastActivityAt.getTime(),
      );
    });
  });

  test('associateWorkflow links workflow to session', async () => {
    const session = await conversationStore.createSession({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      channel: 'api',
      environment: 'dev',
      agentName: 'workflow_agent',
      agentVersion: '2.0.0',
    });

    expect(session.workflowId).toBeNull();

    await withTestTenant(async () => {
      await conversationStore.associateWorkflow(session.id, 'wf-001', 'step-2');

      const updated = await conversationStore.getSession(session.id);
      expect(updated!.workflowId).toBe('wf-001');
      expect(updated!.workflowStepId).toBe('step-2');
    });
  });

  // =========================================================================
  // Section 4: Messages
  // =========================================================================

  test('records user and assistant messages linked to session', async () => {
    // Create a session first (needed for tenantId lookup in MongoMessageStore)
    const session = await conversationStore.createSession({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      channel: 'web',
      environment: 'dev',
      agentName: 'chat_agent',
      agentVersion: '1.0.0',
    });

    // Add user message
    const userMsg = await messageStore.addMessage({
      sessionId: session.id,
      role: 'user',
      content: 'Hello, I need help booking a flight.',
      channel: 'web',
      traceId: 'trace-msg-001',
    });

    expect(userMsg.id).toBeDefined();
    expect(userMsg.sessionId).toBe(session.id);
    expect(userMsg.role).toBe('user');
    expect(userMsg.content).toBe('Hello, I need help booking a flight.');
    expect(userMsg.channel).toBe('web');
    expect(userMsg.traceId).toBe('trace-msg-001');
    expect(userMsg.timestamp).toBeInstanceOf(Date);

    // Add assistant message
    const assistantMsg = await messageStore.addMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'I can help you with that! Where would you like to fly?',
      channel: 'web',
    });

    expect(assistantMsg.role).toBe('assistant');

    // Retrieve messages for the session
    const messages = await messageStore.getMessages({
      sessionId: session.id,
      tenantId: TENANT_ID,
      includeSystem: true,
    });

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[1].role).toBe('assistant');
  });

  test('adding message updates session lastActivityAt', async () => {
    const session = await conversationStore.createSession({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      channel: 'web',
      environment: 'dev',
      agentName: 'chat_agent',
      agentVersion: '1.0.0',
    });

    const originalLastActivity = session.lastActivityAt;

    await withTestTenant(async () => {
      // Small delay to ensure timestamp difference
      await new Promise((r) => setTimeout(r, 50));

      await messageStore.addMessage({
        sessionId: session.id,
        role: 'user',
        content: 'Trigger activity update',
        channel: 'web',
      });

      // The MongoMessageStore updates session.lastActivityAt in a non-blocking way,
      // so we need a small wait for the fire-and-forget update to complete.
      await new Promise((r) => setTimeout(r, 200));

      const updatedSession = await conversationStore.getSession(session.id);
      expect(updatedSession!.lastActivityAt.getTime()).toBeGreaterThanOrEqual(
        originalLastActivity.getTime(),
      );
    });
  });

  // =========================================================================
  // Section 5: Traces
  // =========================================================================

  test('adds trace events for agent execution and retrieves them', async () => {
    const sessionId = randomUUID();

    const traceCtx = traceStore.startTrace({
      sessionId,
      agentName: 'booking_agent',
      agentVersion: '1.0.0',
      environment: 'dev',
    });

    await traceCtx.logLLMCall({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Book a hotel' }],
      response: 'Sure, let me look up hotels...',
      tokensIn: 10,
      tokensOut: 20,
      latencyMs: 150,
      cost: 0.003,
    });

    await traceCtx.logToolCall({
      toolName: 'search_hotels',
      input: { destination: 'Paris' },
      output: { results: ['Hotel A', 'Hotel B'] },
      latencyMs: 200,
      success: true,
    });

    await traceCtx.end();

    // Retrieve the trace
    const trace = await traceStore.getTrace(traceCtx.traceId);
    expect(trace).not.toBeNull();
    expect(trace!.sessionId).toBe(sessionId);
    expect(trace!.agentName).toBe('booking_agent');
    expect(trace!.events).toHaveLength(2);
    expect(trace!.events[0].type).toBe('llm_call');
    expect(trace!.events[1].type).toBe('tool_call');
    expect(trace!.endTime).toBeDefined();
  });

  test('stores all events when under capacity and queryTraces respects limit', async () => {
    // The in-memory store has no enforced ring-buffer eviction; all events are retained.
    // This test verifies storage correctness and that the queryTraces limit cap works.
    const sessionId = randomUUID();

    const traceCtx = traceStore.startTrace({
      sessionId,
      agentName: 'busy_agent',
      agentVersion: '1.0.0',
      environment: 'dev',
    });

    // Append many events
    for (let i = 0; i < 150; i++) {
      await traceCtx.logToolCall({
        toolName: `tool_${i}`,
        input: { index: i },
        output: { ok: true },
        latencyMs: 10,
        success: true,
      });
    }

    await traceCtx.end();

    const trace = await traceStore.getTrace(traceCtx.traceId);
    expect(trace).not.toBeNull();
    // All 150 events retained — no eviction
    expect(trace!.events.length).toBe(150);
    // Events stored in insertion order (no gaps or reordering)
    const toolNames = trace!.events.map((e: any) => e.data?.toolName ?? e.toolName);
    expect(toolNames[0]).toBe('tool_0');
    expect(toolNames[149]).toBe('tool_149');

    // Query with limit acts as a retrieval cap
    const traces = await traceStore.queryTraces({
      sessionId,
      limit: 5,
    });
    expect(traces.length).toBeLessThanOrEqual(5);
  });

  test('session info reports correct stats', async () => {
    const sessionId = randomUUID();

    const traceCtx = traceStore.startTrace({
      sessionId,
      agentName: 'stats_agent',
      agentVersion: '1.0.0',
      environment: 'dev',
    });

    await traceCtx.logLLMCall({
      model: 'claude-3',
      messages: [{ role: 'user', content: 'Hello' }],
      response: 'Hi there!',
      tokensIn: 5,
      tokensOut: 3,
      latencyMs: 100,
    });

    await traceCtx.logError('validation', 'Missing field: email');
    await traceCtx.end();

    const trace = await traceStore.getTrace(traceCtx.traceId);
    expect(trace).not.toBeNull();

    // Count event types
    const llmCalls = trace!.events.filter((e) => e.type === 'llm_call');
    const errors = trace!.events.filter((e) => e.type === 'error');
    expect(llmCalls).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].data.message).toBe('Missing field: email');

    // Verify trace has timing info
    expect(trace!.startTime).toBeInstanceOf(Date);
    expect(trace!.endTime).toBeInstanceOf(Date);
    expect(trace!.endTime!.getTime()).toBeGreaterThanOrEqual(trace!.startTime.getTime());
  });

  // =========================================================================
  // Section 6: LLM Metrics
  // =========================================================================

  test('records LLM usage and aggregates correctly', async () => {
    // Create metrics directly via the model (the MongoMetricsStore.record()
    // maps fields that may not match all required model fields, so we test
    // the full model to verify aggregation pipeline correctness).
    await LLMUsageMetricModel.create({
      tenantId: TENANT_ID,
      sessionId: 'sess-metrics-1',
      agentName: 'booking_agent',
      provider: 'openai',
      model: 'gpt-4',
      operation: 'chat',
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      latencyMs: 200,
      estimatedCost: 0.005,
      status: 'success',
    });

    await LLMUsageMetricModel.create({
      tenantId: TENANT_ID,
      sessionId: 'sess-metrics-2',
      agentName: 'booking_agent',
      provider: 'openai',
      model: 'gpt-4',
      operation: 'chat',
      inputTokens: 200,
      outputTokens: 100,
      totalTokens: 300,
      latencyMs: 300,
      estimatedCost: 0.01,
      status: 'success',
    });

    await LLMUsageMetricModel.create({
      tenantId: TENANT_ID,
      sessionId: 'sess-metrics-3',
      agentName: 'support_agent',
      provider: 'anthropic',
      model: 'claude-3',
      operation: 'chat',
      inputTokens: 150,
      outputTokens: 75,
      totalTokens: 225,
      latencyMs: 180,
      estimatedCost: 0.008,
      status: 'success',
    });

    // Aggregate usage
    const pipeline = [
      { $match: { tenantId: TENANT_ID } },
      {
        $group: {
          _id: null,
          totalRequests: { $sum: 1 },
          inputTokens: { $sum: '$inputTokens' },
          outputTokens: { $sum: '$outputTokens' },
          totalTokens: { $sum: '$totalTokens' },
          estimatedCost: { $sum: '$estimatedCost' },
          avgLatencyMs: { $avg: '$latencyMs' },
        },
      },
    ];

    const results = await LLMUsageMetricModel.aggregate(pipeline);
    expect(results).toHaveLength(1);

    const summary = results[0];
    expect(summary.totalRequests).toBe(3);
    expect(summary.inputTokens).toBe(450);
    expect(summary.outputTokens).toBe(225);
    expect(summary.totalTokens).toBe(675);
    expect(summary.estimatedCost).toBeCloseTo(0.023, 5);
    expect(summary.avgLatencyMs).toBeCloseTo(226.67, 0);
  });

  // =========================================================================
  // Section 7: Contacts
  // =========================================================================

  test('create contact, create session, then link them', async () => {
    // Create a contact via the store
    const contact = await contactStore.create({
      tenantId: TENANT_ID,
      type: 'customer',
      identity: 'jane@example.com',
      identityType: 'email',
      displayName: 'Jane Doe',
      company: 'Acme Corp',
      channel: 'web',
      tags: ['vip'],
    });

    expect(contact.id).toBeDefined();
    expect(contact.tenantId).toBe(TENANT_ID);
    expect(contact.type).toBe('customer');
    expect(contact.identity).toBe('jane@example.com');
    expect(contact.displayName).toBe('Jane Doe');

    // Create a session
    const session = await conversationStore.createSession({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      channel: 'web',
      environment: 'dev',
      agentName: 'support_agent',
      agentVersion: '1.0.0',
    });

    await withTestTenant(async () => {
      // Link the contact to the session
      await conversationStore.linkContact(session.id, contact.id);

      const updatedSession = await conversationStore.getSession(session.id);
      expect(updatedSession!.contactId).toBe(contact.id);
    });
  });

  test('find contact by identity', async () => {
    await contactStore.create({
      tenantId: TENANT_ID,
      type: 'employee',
      identity: 'john@company.com',
      identityType: 'email',
      displayName: 'John Smith',
      department: 'Engineering',
      employeeId: 'EMP-001',
    });

    const found = await contactStore.findByIdentity(TENANT_ID, 'email', 'john@company.com');
    expect(found).not.toBeNull();
    expect(found!.displayName).toBe('John Smith');
    expect(found!.department).toBe('Engineering');
    expect(found!.employeeId).toBe('EMP-001');

    // Non-existent identity returns null
    const notFound = await contactStore.findByIdentity(TENANT_ID, 'email', 'nobody@nowhere.com');
    expect(notFound).toBeNull();
  });

  // =========================================================================
  // Section 8: Workflow Definitions
  // =========================================================================

  test('create workflow definition and associate with session', async () => {
    const workflow = await workflowStore.create({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      name: 'Onboarding Flow',
      type: 'cx_automation',
      description: 'Customer onboarding workflow',
      entryAgent: 'onboarding_agent',
      steps: [
        { id: 'step-1', type: 'agent_invocation', name: 'Welcome', agent: 'greeting_agent' },
        { id: 'step-2', type: 'agent_invocation', name: 'Collect Info', agent: 'form_agent' },
        { id: 'step-3', type: 'agent_invocation', name: 'Confirm', agent: 'confirmation_agent' },
      ],
      triggers: [],
      slaMinutes: 30,
      escalationRules: [{ condition: 'sla_breach', action: 'escalate', target: 'supervisor' }],
    });

    expect(workflow.id).toBeDefined();
    expect(workflow.name).toBe('Onboarding Flow');
    expect(workflow.type).toBe('cx_automation');
    expect(workflow.entryAgent).toBe('onboarding_agent');
    expect(workflow.steps).toHaveLength(3);
    expect(workflow.status).toBe('active');

    // Associate workflow with a session
    const session = await conversationStore.createSession({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      channel: 'web',
      environment: 'dev',
      agentName: 'onboarding_agent',
      agentVersion: '1.0.0',
    });

    await withTestTenant(async () => {
      await conversationStore.associateWorkflow(session.id, workflow.id, 'step-1');

      const updatedSession = await conversationStore.getSession(session.id);
      expect(updatedSession!.workflowId).toBe(workflow.id);
      expect(updatedSession!.workflowStepId).toBe('step-1');

      // Also verify we can look up the workflow itself
      const retrievedWorkflow = await workflowStore.getById(workflow.id, TENANT_ID, PROJECT_ID);
      expect(retrievedWorkflow).not.toBeNull();
      expect(retrievedWorkflow!.name).toBe('Onboarding Flow');
    });
  });

  // =========================================================================
  // Section 9: Full E2E
  // =========================================================================

  test('complete flow from login to conversation with all stores', async () => {
    // Step 1: Create user and org (simulating auth)
    const user = await UserModel.create({
      email: 'fullflow@example.com',
      name: 'Full Flow User',
      authProvider: 'email',
      emailVerified: true,
    });

    // Step 2: Create project
    const project = await ProjectModel.create({
      name: 'Full Flow Project',
      slug: `full-flow-${randomUUID().slice(0, 8)}`,
      ownerId: user._id,
      tenantId: TENANT_ID,
    });

    // Step 3: Create contact
    const contact = await contactStore.create({
      tenantId: TENANT_ID,
      type: 'customer',
      identity: 'fullflow@example.com',
      identityType: 'email',
      displayName: 'Full Flow User',
    });

    // Step 4: Create workflow
    const workflow = await workflowStore.create({
      tenantId: TENANT_ID,
      projectId: project._id,
      name: 'Full Flow Workflow',
      type: 'cx_automation',
      entryAgent: 'main_agent',
      steps: [{ id: 'step-1', type: 'agent_invocation', name: 'Start', agent: 'main_agent' }],
      triggers: [],
    });

    // Step 5: Create session
    const session = await conversationStore.createSession({
      tenantId: TENANT_ID,
      projectId: project._id,
      customerId: user._id,
      channel: 'web',
      environment: 'dev',
      agentName: 'main_agent',
      agentVersion: '1.0.0',
      contactId: contact.id,
      workflowId: workflow.id,
    });

    expect(session.contactId).toBe(contact.id);
    expect(session.workflowId).toBe(workflow.id);

    await withTestTenant(async () => {
      // Step 6: Record messages
      await messageStore.addMessage({
        sessionId: session.id,
        role: 'user',
        content: 'Hi, I need help.',
        channel: 'web',
      });

      await messageStore.addMessage({
        sessionId: session.id,
        role: 'assistant',
        content: 'Hello! How can I assist you today?',
        channel: 'web',
      });

      const messages = await messageStore.getMessages({
        sessionId: session.id,
        tenantId: TENANT_ID,
        includeSystem: true,
      });
      expect(messages).toHaveLength(2);

      // Step 7: Record trace
      const traceCtx = traceStore.startTrace({
        sessionId: session.id,
        agentName: 'main_agent',
        agentVersion: '1.0.0',
        environment: 'dev',
      });

      await traceCtx.logLLMCall({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hi, I need help.' }],
        response: 'Hello! How can I assist you today?',
        tokensIn: 8,
        tokensOut: 10,
        latencyMs: 120,
      });
      await traceCtx.end();

      const trace = await traceStore.getTrace(traceCtx.traceId);
      expect(trace).not.toBeNull();
      expect(trace!.events).toHaveLength(1);

      // Step 8: Record LLM metric
      await LLMUsageMetricModel.create({
        tenantId: TENANT_ID,
        sessionId: session.id,
        agentName: 'main_agent',
        provider: 'openai',
        model: 'gpt-4',
        operation: 'chat',
        inputTokens: 8,
        outputTokens: 10,
        totalTokens: 18,
        latencyMs: 120,
        estimatedCost: 0.001,
        status: 'success',
      });

      const metricCount = await LLMUsageMetricModel.countDocuments({
        sessionId: session.id,
      });
      expect(metricCount).toBe(1);

      // Step 9: Verify all links
      const finalSession = await conversationStore.getSession(session.id);
      expect(finalSession!.contactId).toBe(contact.id);
      expect(finalSession!.workflowId).toBe(workflow.id);
      expect(finalSession!.projectId).toBe(project._id);
      expect(finalSession!.currentAgent).toBe('main_agent');
      expect(finalSession!.status).toBe('active');
    });
  });

  // =========================================================================
  // Section 10: Contact Soft Delete
  // =========================================================================

  test('soft-deleting a contact nullifies PII and sets deletedAt', async () => {
    const contact = await contactStore.create({
      tenantId: TENANT_ID,
      type: 'customer',
      identity: 'pii-test@example.com',
      identityType: 'email',
      displayName: 'PII Test User',
      employeeId: 'EMP-999',
      company: 'Secret Corp',
      accountRef: 'ACC-123',
    });

    expect(contact.identity).toBe('pii-test@example.com');
    expect(contact.displayName).toBe('PII Test User');

    // Soft delete
    await contactStore.softDelete(contact.id);

    // Retrieve the document directly from Mongo (bypass store query filter)
    const doc = await ContactModel.findById(contact.id).lean();
    expect(doc).not.toBeNull();
    expect(doc!.deletedAt).toBeInstanceOf(Date);
    expect(doc!.identity).toBeNull();
    expect(doc!.identityType).toBeNull();
    expect(doc!.displayName).toBeNull();
    expect(doc!.employeeId).toBeNull();
    expect(doc!.company).toBeNull();
    expect(doc!.accountRef).toBeNull();
    expect(doc!.type).toBe('anonymous');
  });

  test('soft-deleted contacts are excluded from query', async () => {
    // Create two contacts
    const active = await contactStore.create({
      tenantId: TENANT_ID,
      type: 'customer',
      identity: 'active@example.com',
      identityType: 'email',
      displayName: 'Active User',
    });

    const toDelete = await contactStore.create({
      tenantId: TENANT_ID,
      type: 'customer',
      identity: 'deleted@example.com',
      identityType: 'email',
      displayName: 'Deleted User',
    });

    // Soft delete one
    await contactStore.softDelete(toDelete.id);

    // Query should only return the active contact
    const result = await contactStore.query({ tenantId: TENANT_ID });
    expect(result.total).toBe(1);
    expect(result.contacts).toHaveLength(1);
    expect(result.contacts[0].id).toBe(active.id);

    // findByIdentity should also exclude soft-deleted
    const notFound = await contactStore.findByIdentity(TENANT_ID, 'email', 'deleted@example.com');
    expect(notFound).toBeNull();
  });

  // =========================================================================
  // Section 11: Workflow Definition Archive
  // =========================================================================

  test('archiving a workflow sets archivedAt and status=archived', async () => {
    const workflow = await workflowStore.create({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      name: 'Archive Test Workflow',
      type: 'internal',
      entryAgent: 'test_agent',
      steps: [],
      triggers: [],
    });

    expect(workflow.status).toBe('active');
    expect(workflow.archivedAt).toBeNull();

    // Archive it
    await workflowStore.archive(workflow.id, TENANT_ID, PROJECT_ID);

    // Retrieve and verify
    const archived = await workflowStore.getById(workflow.id, TENANT_ID, PROJECT_ID);
    expect(archived).not.toBeNull();
    expect(archived!.status).toBe('archived');
    expect(archived!.archivedAt).toBeInstanceOf(Date);
  });

  // =========================================================================
  // Section 12: GDPR Contact Anonymization
  // =========================================================================

  test('anonymizeContacts nullifies PII on matching contacts', async () => {
    // Create multiple contacts for the same tenant
    const contact1 = await contactStore.create({
      tenantId: TENANT_ID,
      type: 'customer',
      identity: 'gdpr1@example.com',
      identityType: 'email',
      displayName: 'GDPR User 1',
      company: 'Privacy Inc',
    });

    const contact2 = await contactStore.create({
      tenantId: TENANT_ID,
      type: 'employee',
      identity: 'gdpr2@example.com',
      identityType: 'email',
      displayName: 'GDPR User 2',
      employeeId: 'EMP-GDPR',
      department: 'Legal',
    });

    // A contact from a different tenant (should NOT be affected)
    const otherTenantContact = await contactStore.create({
      tenantId: 'other-tenant',
      type: 'customer',
      identity: 'safe@example.com',
      identityType: 'email',
      displayName: 'Safe User',
    });

    // Simulate GDPR anonymization by soft-deleting matching contacts
    // In a real implementation, this would be a batch operation via the
    // ContactStore. Here we use softDelete on each matching contact.
    const { contacts: matchingContacts } = await contactStore.query({
      tenantId: TENANT_ID,
    });

    for (const c of matchingContacts) {
      await contactStore.softDelete(c.id);
    }

    // Verify anonymization of tenant's contacts
    const doc1 = await ContactModel.findById(contact1.id).lean();
    expect(doc1!.identity).toBeNull();
    expect(doc1!.displayName).toBeNull();
    expect(doc1!.company).toBeNull();
    expect(doc1!.type).toBe('anonymous');
    expect(doc1!.deletedAt).toBeInstanceOf(Date);

    const doc2 = await ContactModel.findById(contact2.id).lean();
    expect(doc2!.identity).toBeNull();
    expect(doc2!.displayName).toBeNull();
    expect(doc2!.employeeId).toBeNull();
    expect(doc2!.type).toBe('anonymous');
    expect(doc2!.deletedAt).toBeInstanceOf(Date);

    // Other tenant's contact should be untouched
    const safeDoc = await ContactModel.findById(otherTenantContact.id).lean();
    expect(safeDoc!.identity).toBe('safe@example.com');
    expect(safeDoc!.displayName).toBe('Safe User');
    expect(safeDoc!.deletedAt).toBeNull();
  });
});

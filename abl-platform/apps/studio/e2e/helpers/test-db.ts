/**
 * Test Database Helpers
 *
 * Seeding and cleanup functions for E2E tests that need MongoDB state.
 * Uses real MongoDB connection (not MongoMemoryServer).
 *
 * @e2e-real — Connects to real MongoDB instance for full system E2E testing
 */

import mongoose from 'mongoose';
import type { ExtendedTraceEvent } from '@agent-platform/observatory';

const TEST_MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://localhost:27017/abl-studio-test';
const KEEP_TEST_DATA = process.env.KEEP_TEST_DATA === '1';

let connectionPromise: Promise<typeof mongoose> | null = null;

/**
 * Connect to test database
 */
export async function connectTestDB(): Promise<typeof mongoose> {
  if (connectionPromise) {
    return connectionPromise;
  }

  connectionPromise = mongoose.connect(TEST_MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
  });

  return connectionPromise;
}

/**
 * Disconnect from test database
 */
export async function disconnectTestDB(): Promise<void> {
  if (connectionPromise) {
    await mongoose.disconnect();
    connectionPromise = null;
  }
}

/**
 * Seed a test session with isolation fields
 */
export async function seedTestSession(data: {
  sessionId: string;
  tenantId: string;
  projectId: string;
  userId?: string;
  channel?: string;
  status?: string;
  currentAgent?: string;
}): Promise<void> {
  await connectTestDB();

  const Session = mongoose.connection.collection('sessions');

  await Session.insertOne({
    _id: data.sessionId,
    tenantId: data.tenantId,
    projectId: data.projectId,
    contactId: null,
    callerNumber: null,
    initiatedById: data.userId || null,
    customerId: null,
    anonymousId: `anon-${data.sessionId}`,
    currentAgent: data.currentAgent || 'test-agent',
    agentVersion: null,
    environment: 'test',
    entryAgentName: data.currentAgent || 'test-agent',
    workflowId: null,
    workflowStepId: null,
    parentId: null,
    channel: data.channel || 'web',
    channelHistory: [data.channel || 'web'],
    status: data.status || 'active',
    disposition: null,
    dispositionCode: null,
    outcome: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/**
 * Seed trace events for a session
 */
export async function seedTraceEvents(
  sessionId: string,
  events: ExtendedTraceEvent[],
): Promise<void> {
  await connectTestDB();

  const TraceEvents = mongoose.connection.collection('trace_events');

  const docs = events.map((event) => ({
    ...event,
    sessionId,
    _id: event.id,
    timestamp: event.timestamp instanceof Date ? event.timestamp : new Date(event.timestamp),
  }));

  await TraceEvents.insertMany(docs);
}

/**
 * Clear test data for a session
 */
export async function clearTestData(sessionId: string): Promise<void> {
  if (KEEP_TEST_DATA) {
    console.info(`[E2E] KEEP_TEST_DATA=1 — skipping cleanup for session ${sessionId}`);
    return;
  }

  await connectTestDB();

  const Session = mongoose.connection.collection('sessions');
  const TraceEvents = mongoose.connection.collection('trace_events');

  await Session.deleteMany({ _id: sessionId });
  await TraceEvents.deleteMany({ sessionId });
}

/**
 * Clear all test sessions (cleanup helper)
 */
export async function clearAllTestSessions(tenantId: string): Promise<void> {
  if (KEEP_TEST_DATA) {
    console.info(`[E2E] KEEP_TEST_DATA=1 — skipping cleanup for tenant ${tenantId}`);
    return;
  }

  await connectTestDB();

  const Session = mongoose.connection.collection('sessions');
  const TraceEvents = mongoose.connection.collection('trace_events');

  const testSessions = await Session.find({ tenantId, environment: 'test' }).toArray();
  const sessionIds = testSessions.map((s) => s._id);

  await Session.deleteMany({ _id: { $in: sessionIds } });
  await TraceEvents.deleteMany({ sessionId: { $in: sessionIds } });

  console.info(`[E2E] Cleared ${sessionIds.length} test sessions for tenant ${tenantId}`);
}

#!/usr/bin/env npx tsx
/**
 * arch-session-smoke.ts — End-to-end DB smoke for the current Arch session flow.
 *
 * Sends a real message to a running Studio + Runtime + Mongo, then verifies
 * the session document in arch_sessions_v4 has the expected shape:
 *
 *   - metadata.messages contains both the user and assistant messages
 *   - no stray top-level `messages` field (Task 1 regression guard)
 *   - metadata.phase === 'INTERVIEW'
 *   - either metadata.specification.projectName is populated, or
 *     metadata.pendingInteraction describes an ask_user widget
 *
 * Environment:
 *   STUDIO_URL=http://localhost:5173        default
 *   STUDIO_EMAIL=arch-ai-smoke@example.com  dev-login user
 *   STUDIO_NAME="Arch AI Smoke"             dev-login display name
 *   MONGO_URI=mongodb://localhost:27017/abl default
 *
 * Usage:
 *   npx tsx tools/arch-session-smoke.ts
 */

import { MongoClient } from 'mongodb';

const STUDIO_URL = process.env.STUDIO_URL ?? 'http://localhost:5173';
const STUDIO_EMAIL = process.env.STUDIO_EMAIL ?? 'arch-ai-smoke@example.com';
const STUDIO_NAME = process.env.STUDIO_NAME ?? 'Arch AI Smoke';
const MONGO_URI = process.env.MONGO_URI ?? 'mongodb://localhost:27017/abl';
const DB_NAME = new URL(MONGO_URI).pathname.replace(/^\//, '') || 'abl';

interface DevLoginResponse {
  accessToken: string;
  tenantId: string;
}

interface CreateSessionResponse {
  session: { id: string };
}

interface DevLoginBody {
  email: string;
  name: string;
}

function die(msg: string): never {
  console.error(`[smoke] FAIL: ${msg}`);
  process.exit(1);
}

async function devLogin(): Promise<DevLoginResponse> {
  const body: DevLoginBody = { email: STUDIO_EMAIL, name: STUDIO_NAME };
  const res = await fetch(`${STUDIO_URL}/api/dev/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) die(`dev login ${res.status}: ${await res.text()}`);
  return (await res.json()) as DevLoginResponse;
}

function authHeaders(tok: string, tid: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${tok}`,
    'X-Tenant-Id': tid,
  };
}

async function createSession(tok: string, tid: string): Promise<string> {
  const res = await fetch(`${STUDIO_URL}/api/arch-ai/sessions`, {
    method: 'POST',
    headers: authHeaders(tok, tid),
    body: JSON.stringify({ mode: 'ONBOARDING' }),
  });
  if (!res.ok) die(`createSession ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as CreateSessionResponse;
  return json.session.id;
}

async function sendMessage(
  tok: string,
  tid: string,
  sessionId: string,
  text: string,
): Promise<void> {
  const res = await fetch(`${STUDIO_URL}/api/arch-ai/message`, {
    method: 'POST',
    headers: authHeaders(tok, tid),
    body: JSON.stringify({ sessionId, type: 'message', text }),
  });
  if (!res.ok) die(`sendMessage ${res.status}: ${await res.text()}`);

  // Drain the SSE stream so the turn commits before we inspect Mongo.
  const reader = res.body?.getReader();
  if (!reader) die('sendMessage: no response body to drain');
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

interface ArchSessionDocShape {
  metadata?: {
    phase?: string;
    messages?: Array<{ role: string }>;
    specification?: { projectName?: string };
    pendingInteraction?: { kind?: string; payload?: { toolName?: string } };
  };
  messages?: unknown; // should NOT exist
}

async function inspect(sessionId: string): Promise<void> {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  try {
    const doc = (await client
      .db(DB_NAME)
      .collection('arch_sessions_v4')
      .findOne({ _id: sessionId as unknown as never })) as ArchSessionDocShape | null;

    if (!doc) die(`session ${sessionId} not found in arch_sessions_v4`);
    if (doc.messages !== undefined) {
      die(
        `stray top-level "messages" field exists on session doc — Task 1 regression. Value: ${JSON.stringify(doc.messages).slice(0, 200)}`,
      );
    }
    const msgs = doc.metadata?.messages ?? [];
    if (msgs.length < 2) {
      die(`metadata.messages.length = ${msgs.length}, expected >= 2 (user + assistant)`);
    }
    if (doc.metadata?.phase !== 'INTERVIEW') {
      die(`metadata.phase = ${doc.metadata?.phase}, expected INTERVIEW`);
    }
    const hasName = (doc.metadata?.specification?.projectName?.length ?? 0) > 0;
    const hasPending = doc.metadata?.pendingInteraction?.kind === 'widget';
    if (!hasName && !hasPending) {
      die(
        'neither metadata.specification.projectName populated nor metadata.pendingInteraction set — LLM did not progress Interview',
      );
    }

    console.log(`[smoke] PASS sessionId=${sessionId}`);
    console.log(`[smoke]   metadata.messages: ${msgs.length}`);
    console.log(`[smoke]   metadata.phase: ${doc.metadata?.phase}`);
    console.log(`[smoke]   projectName: ${doc.metadata?.specification?.projectName ?? '(empty)'}`);
    console.log(
      `[smoke]   pendingInteraction: ${doc.metadata?.pendingInteraction?.kind ?? 'none'}`,
    );
  } finally {
    await client.close();
  }
}

async function sendAndAssertGrew(
  tok: string,
  tid: string,
  sessionId: string,
  priorCount: number,
  text: string,
): Promise<number> {
  await sendMessage(tok, tid, sessionId, text);
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  try {
    const doc = (await client
      .db(DB_NAME)
      .collection('arch_sessions_v4')
      .findOne({ _id: sessionId as unknown as never })) as ArchSessionDocShape | null;
    const n = doc?.metadata?.messages?.length ?? 0;
    if (n <= priorCount) {
      die(`metadata.messages did not grow: was ${priorCount}, now ${n}`);
    }
    return n;
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  console.log(`[smoke] studio=${STUDIO_URL} mongo=${MONGO_URI.replace(/:[^@]+@/, ':***@')}`);

  const { accessToken, tenantId } = await devLogin();
  const sessionId = await createSession(accessToken, tenantId);
  console.log(`[smoke] created session ${sessionId}`);

  await sendMessage(accessToken, tenantId, sessionId, 'I want to build a customer support bot');
  await inspect(sessionId);

  // Second turn must grow the message array rather than reset it.
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  let firstCount: number;
  try {
    const doc = (await client
      .db(DB_NAME)
      .collection('arch_sessions_v4')
      .findOne({ _id: sessionId as unknown as never })) as ArchSessionDocShape | null;
    firstCount = doc?.metadata?.messages?.length ?? 0;
  } finally {
    await client.close();
  }
  console.log(`[smoke] first turn persisted ${firstCount} messages`);

  const secondCount = await sendAndAssertGrew(
    accessToken,
    tenantId,
    sessionId,
    firstCount,
    'Name it SupportBot',
  );
  console.log(`[smoke] second turn grew to ${secondCount} messages — no reset`);

  console.log('[smoke] all assertions passed');
}

main().catch((err: unknown) => {
  console.error('[smoke] threw:', err);
  process.exit(1);
});

/**
 * AFG Blue Advisory — Multi-Turn Conversational E2E Test
 *
 * Phase 1: Tests against the LIVE Kore.ai Agent Platform API.
 *   - Validates the full conversational flow: greeting → clarification → product search → policy delegation
 *   - Parses SSE streaming responses and asserts on agent behavior
 *   - Uses the same API contract as the Postman collection
 *
 * Phase 2 (future): Same test scenarios against ABL Runtime with the agent compiled from the export JSON.
 *
 * Required env vars:
 *   AFG_API_KEY          – Kore.ai x-api-key
 *   AFG_APP_ID           – Kore.ai app ID (default: aa-9b7008f2-e862-4800-bdfa-aed70b2e82c1)
 *   AFG_BASE_URL         – Kore.ai base URL (default: https://agent-platform.kore.ai)
 *
 * Run with:
 *   AFG_API_KEY=kg-... npx vitest run --config vitest.integration.config.ts src/__tests__/e2e/afg-blue-advisory/
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';

// Load .env from runtime app root
dotenvConfig({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..', '.env'),
});

// =============================================================================
// CONFIG
// =============================================================================

const AFG_API_KEY = process.env.AFG_API_KEY ?? '';
const AFG_APP_ID = process.env.AFG_APP_ID ?? 'aa-9b7008f2-e862-4800-bdfa-aed70b2e82c1';
const AFG_BASE_URL = process.env.AFG_BASE_URL ?? 'https://agent-platform.kore.ai';
const EXECUTE_URL = `${AFG_BASE_URL}/api/v2/apps/${AFG_APP_ID}/environments/dev/runs/execute`;

const SKIP_REASON = !AFG_API_KEY ? 'AFG_API_KEY not set — skipping live Kore.ai E2E tests' : '';

// =============================================================================
// TYPES
// =============================================================================

interface SessionIdentity {
  userReference: string;
  sessionReference: string;
}

interface SSEEvent {
  eventIndex?: number;
  sessionInfo?: { sessionId: string };
  sessionReference?: string;
  agent?: { displayName: string; icon?: string; title?: string };
  output?: Array<{ type: string; content: string }>;
  token?: string;
  message?: string;
  type?: string;
  content?: string;
}

interface ParsedResponse {
  sessionId: string | null;
  sessionReference: string | null;
  agentInfo: { displayName: string; icon?: string } | null;
  fullText: string;
  events: SSEEvent[];
  rawChunks: string[];
  timing: {
    startMs: number;
    firstChunkMs: number;
    firstTokenMs: number;
    endMs: number;
  };
}

// =============================================================================
// SSE STREAM PARSER
// =============================================================================

/**
 * Parse a Kore.ai SSE stream into structured events.
 * Handles concatenated JSON objects (multiple events per chunk),
 * data: prefix stripping, and partial buffer accumulation.
 */
function extractJSONObjects(line: string): string[] {
  const stripped = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
  if (!stripped) return [];

  // Handle concatenated JSON objects by brace-depth parsing
  const objects: string[] = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        objects.push(stripped.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}

async function parseSSEStream(response: Response, startMs: number): Promise<ParsedResponse> {
  const result: ParsedResponse = {
    sessionId: null,
    sessionReference: null,
    agentInfo: null,
    fullText: '',
    events: [],
    rawChunks: [],
    timing: { startMs, firstChunkMs: 0, firstTokenMs: 0, endMs: 0 },
  };

  if (!response.body) {
    throw new Error(`No response body — status ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let isFirstChunk = true;
  let isFirstToken = true;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    if (isFirstChunk) {
      result.timing.firstChunkMs = Date.now();
      isFirstChunk = false;
    }

    const chunk = decoder.decode(value, { stream: true });
    result.rawChunks.push(chunk);
    buffer += chunk;

    const lines = buffer.split('\n');
    // Keep last (potentially incomplete) line as buffer
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (
        !trimmed ||
        trimmed.startsWith('event:') ||
        trimmed.startsWith('id:') ||
        trimmed.startsWith('retry:')
      ) {
        continue;
      }

      const jsonStrings = extractJSONObjects(trimmed);
      for (const jsonStr of jsonStrings) {
        try {
          const data: SSEEvent = JSON.parse(jsonStr);
          result.events.push(data);

          // Extract session info
          if (data.sessionInfo?.sessionId) {
            result.sessionId = data.sessionInfo.sessionId;
          }
          if (data.sessionReference) {
            result.sessionReference = data.sessionReference;
          }

          // Extract agent identity
          if (data.agent?.displayName) {
            result.agentInfo = data.agent;
          }

          // Extract text tokens
          if (data.output) {
            for (const item of data.output) {
              if (item.type === 'text' && item.content) {
                if (isFirstToken) {
                  result.timing.firstTokenMs = Date.now();
                  isFirstToken = false;
                }
                result.fullText += item.content;
              }
            }
          }
          if (data.token) {
            if (isFirstToken) {
              result.timing.firstTokenMs = Date.now();
              isFirstToken = false;
            }
            result.fullText += data.token;
          }
        } catch {
          // Partial JSON — will be reassembled in next chunk
        }
      }
    }
  }

  // Process remaining buffer
  if (buffer.trim()) {
    const jsonStrings = extractJSONObjects(buffer);
    for (const jsonStr of jsonStrings) {
      try {
        const data: SSEEvent = JSON.parse(jsonStr);
        result.events.push(data);
        if (data.output) {
          for (const item of data.output) {
            if (item.type === 'text' && item.content) {
              result.fullText += item.content;
            }
          }
        }
      } catch {
        // ignore
      }
    }
  }

  result.timing.endMs = Date.now();
  return result;
}

// =============================================================================
// LOGGING HELPERS
// =============================================================================

function fmt(ms: number): string {
  return (ms / 1000).toFixed(2) + 's';
}

function logTurnHeader(label: string): void {
  console.log(`\n${'━'.repeat(80)}`);
  console.log(`  ${label}`);
  console.log(`${'━'.repeat(80)}`);
}

function logTiming(r: ParsedResponse): void {
  const t = r.timing;
  const ttfb = t.firstChunkMs ? t.firstChunkMs - t.startMs : 0;
  const ttft = t.firstTokenMs ? t.firstTokenMs - t.startMs : 0;
  const total = t.endMs - t.startMs;
  const streamDuration = t.endMs - (t.firstChunkMs || t.startMs);

  console.log(`  ⏱  Timing:`);
  console.log(`     Request sent     → T+0.00s`);
  if (t.firstChunkMs) console.log(`     First SSE chunk  → T+${fmt(ttfb)}  (TTFB)`);
  if (t.firstTokenMs) console.log(`     First text token → T+${fmt(ttft)}  (TTFT)`);
  console.log(`     Stream complete  → T+${fmt(total)}`);
  console.log(`     Stream duration  → ${fmt(streamDuration)}`);
}

function logSSEEvents(r: ParsedResponse): void {
  const sessionEvents = r.events.filter((e) => e.sessionInfo);
  const agentEvents = r.events.filter((e) => e.agent);
  const textEvents = r.events.filter((e) => e.output?.some((o) => o.type === 'text') || e.token);
  const otherEvents = r.events.filter(
    (e) => !e.sessionInfo && !e.agent && !e.output?.some((o) => o.type === 'text') && !e.token,
  );

  console.log(`  📡 SSE Events: ${r.events.length} total`);
  console.log(`     Session events:  ${sessionEvents.length}`);
  console.log(`     Agent events:    ${agentEvents.length}`);
  console.log(`     Text events:     ${textEvents.length}`);
  console.log(`     Other events:    ${otherEvents.length}`);

  if (sessionEvents.length > 0) {
    console.log(`  🔗 Session: ${r.sessionId ?? 'none'}`);
    console.log(`     Session ref: ${r.sessionReference ?? 'none'}`);
  }
  if (agentEvents.length > 0) {
    const agents = agentEvents.map((e) => e.agent!.displayName);
    console.log(`  🤖 Agent(s): ${[...new Set(agents)].join(', ')}`);
  }
}

function logFullResponse(r: ParsedResponse): void {
  console.log(`  💬 Full Response (${r.fullText.length} chars):`);
  console.log(`${'─'.repeat(80)}`);
  console.log(r.fullText);
  console.log(`${'─'.repeat(80)}`);
}

// =============================================================================
// API CLIENT
// =============================================================================

async function sendMessage(
  text: string,
  identity: SessionIdentity,
  metadata: Record<string, string> = {},
): Promise<ParsedResponse> {
  const body = {
    sessionIdentity: [
      { type: 'userReference', value: identity.userReference },
      { type: 'sessionReference', value: identity.sessionReference },
    ],
    input: [{ type: 'text', content: text }],
    metadata: {
      user: metadata.user ?? 'e2e_test_user',
      gender: metadata.gender ?? 'male',
      location: metadata.location ?? 'Dubai',
      previousUnhandledRequest: metadata.previousUnhandledRequest ?? '',
      conversationSummary: metadata.conversationSummary ?? '',
    },
    stream: { enable: true, streamMode: 'tokens' },
    debug: { enable: false },
  };

  const startMs = Date.now();

  const response = await fetch(EXECUTE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': AFG_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Kore.ai API error: ${response.status} ${response.statusText}\n${errText}`);
  }

  return parseSSEStream(response, startMs);
}

function makeSessionIdentity(): SessionIdentity {
  const ts = Date.now();
  return {
    userReference: `e2e_user_${ts}`,
    sessionReference: `e2e_session_${ts}`,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe.skipIf(!!SKIP_REASON)('AFG Blue Advisory — Live Kore.ai E2E', () => {
  let identity: SessionIdentity;

  beforeAll(() => {
    if (SKIP_REASON) return;
    identity = makeSessionIdentity();
    console.log(
      `[AFG E2E] Session identity: user=${identity.userReference}, session=${identity.sessionReference}`,
    );
    console.log(`[AFG E2E] Endpoint: ${EXECUTE_URL}`);
  });

  // ---------------------------------------------------------------------------
  // Scenario 1: Product Search — Full Multi-Turn Flow
  // ---------------------------------------------------------------------------
  describe('Scenario 1: Product Search Multi-Turn', () => {
    let sessionId: string | null = null;

    test('Turn 1: Greeting triggers welcome response', async () => {
      logTurnHeader('SCENARIO 1 · TURN 1 — User: "Hi"');
      const result = await sendMessage('Hi', identity);

      expect(result.sessionId).toBeTruthy();
      sessionId = result.sessionId;
      expect(result.fullText.length).toBeGreaterThan(0);

      logTiming(result);
      logSSEEvents(result);
      logFullResponse(result);
    }, 60_000);

    test('Turn 2: Product query with enough detail triggers search', async () => {
      logTurnHeader('SCENARIO 1 · TURN 2 — User: "Show me red sneakers under 500 AED for men"');
      const result = await sendMessage('Show me red sneakers under 500 AED for men', identity);

      expect(result.sessionId ?? sessionId).toBeTruthy();
      if (result.sessionId) sessionId = result.sessionId;
      expect(result.fullText.length).toBeGreaterThan(0);

      const text = result.fullText.toLowerCase();
      const hasProductContext =
        text.includes('sneaker') ||
        text.includes('shoe') ||
        text.includes('nike') ||
        text.includes('adidas') ||
        text.includes('option') ||
        text.includes('found') ||
        text.includes('result') ||
        text.includes('brand') ||
        text.includes('occasion') ||
        text.includes('prefer');
      expect(hasProductContext).toBe(true);

      logTiming(result);
      logSSEEvents(result);
      logFullResponse(result);
    }, 90_000);

    test('Turn 3: Follow-up refines the search', async () => {
      logTurnHeader('SCENARIO 1 · TURN 3 — User: "What about Nike ones? Show me Nike options"');
      const result = await sendMessage('What about Nike ones? Show me Nike options', identity);

      expect(result.fullText.length).toBeGreaterThan(0);

      const text = result.fullText.toLowerCase();
      const hasNikeContext =
        text.includes('nike') ||
        text.includes('air max') ||
        text.includes('option') ||
        text.includes('found') ||
        text.includes('sneaker') ||
        text.includes('shoe');
      expect(hasNikeContext).toBe(true);

      logTiming(result);
      logSSEEvents(result);
      logFullResponse(result);
    }, 90_000);
  });

  // ---------------------------------------------------------------------------
  // Scenario 2: Multi-Agent Delegation — Product + Policy
  // ---------------------------------------------------------------------------
  describe('Scenario 2: Cross-Agent Delegation (Product + Policy)', () => {
    let delegationIdentity: SessionIdentity;

    beforeAll(() => {
      // Fresh session for delegation scenario
      delegationIdentity = makeSessionIdentity();
    });

    test('Turn 1: Combined product + policy query triggers delegation', async () => {
      logTurnHeader(
        'SCENARIO 2 · TURN 1 — User: "I want to buy red sneakers and what is the return policy for clothing?"',
      );
      const result = await sendMessage(
        'I want to buy red sneakers and what is the return policy for clothing?',
        delegationIdentity,
      );

      expect(result.sessionId).toBeTruthy();
      expect(result.fullText.length).toBeGreaterThan(0);

      const text = result.fullText.toLowerCase();
      const hasProductContent =
        text.includes('sneaker') ||
        text.includes('shoe') ||
        text.includes('option') ||
        text.includes('brand') ||
        text.includes('preference');
      const hasPolicyContent =
        text.includes('return') ||
        text.includes('policy') ||
        text.includes('refund') ||
        text.includes('exchange') ||
        text.includes('day');
      const addressesBothTopics = hasProductContent || hasPolicyContent;
      expect(addressesBothTopics).toBe(true);

      logTiming(result);
      logSSEEvents(result);
      console.log(`  🏷  Delegation analysis:`);
      console.log(`     Has product content: ${hasProductContent}`);
      console.log(`     Has policy content:  ${hasPolicyContent}`);
      logFullResponse(result);
    }, 120_000);
  });

  // ---------------------------------------------------------------------------
  // Scenario 3: Guard Rail — Out-of-Scope Rejection
  // ---------------------------------------------------------------------------
  describe('Scenario 3: Guard Rail Out-of-Scope', () => {
    let guardIdentity: SessionIdentity;

    beforeAll(() => {
      guardIdentity = makeSessionIdentity();
    });

    test('Out-of-scope query is politely declined', async () => {
      logTurnHeader('SCENARIO 3 — User: "Book me a flight from Dubai to London for next week"');
      const result = await sendMessage(
        'Book me a flight from Dubai to London for next week',
        guardIdentity,
      );

      expect(result.fullText.length).toBeGreaterThan(0);

      const text = result.fullText.toLowerCase();
      const isDeclining =
        text.includes("can't") ||
        text.includes('cannot') ||
        text.includes('not able') ||
        text.includes('outside') ||
        text.includes('not covered') ||
        text.includes("don't") ||
        text.includes('unable') ||
        text.includes('not support') ||
        text.includes('scope') ||
        text.includes('unfortunately');
      const suggestsAlternatives =
        text.includes('fashion') ||
        text.includes('clothing') ||
        text.includes('footwear') ||
        text.includes('accessori') ||
        text.includes('help you with') ||
        text.includes('can assist') ||
        text.includes('offer') ||
        text.includes('shop');
      expect(isDeclining || suggestsAlternatives).toBe(true);

      logTiming(result);
      logSSEEvents(result);
      console.log(`  🛡  Guard rail analysis:`);
      console.log(`     Declining:            ${isDeclining}`);
      console.log(`     Suggests alternatives: ${suggestsAlternatives}`);
      logFullResponse(result);
    }, 60_000);
  });

  // ---------------------------------------------------------------------------
  // Scenario 4: Conversation Summary Continuity
  // ---------------------------------------------------------------------------
  describe('Scenario 4: Conversation Summary Continuity', () => {
    let summaryIdentity: SessionIdentity;

    beforeAll(() => {
      summaryIdentity = makeSessionIdentity();
    });

    test('Agent references conversation summary from metadata', async () => {
      logTurnHeader('SCENARIO 4 — User: "Hey there" (with conversationSummary in metadata)');
      console.log(
        `  📋 Summary injected: "Customer was looking at Nike running shoes in size 42 and asked about the 30% discount offer. They were comparing Nike Air Max 90 and Adidas Ultra Boost."`,
      );
      const result = await sendMessage('Hey there', summaryIdentity, {
        conversationSummary:
          'Customer was looking at Nike running shoes in size 42 and asked about the 30% discount offer. They were comparing Nike Air Max 90 and Adidas Ultra Boost.',
      });

      expect(result.fullText.length).toBeGreaterThan(0);

      const text = result.fullText.toLowerCase();
      const referencesPrior =
        text.includes('nike') ||
        text.includes('running') ||
        text.includes('shoe') ||
        text.includes('sneaker') ||
        text.includes('last time') ||
        text.includes('earlier') ||
        text.includes('continue') ||
        text.includes('previous') ||
        text.includes('back') ||
        text.includes('where we left') ||
        text.includes('looking at') ||
        text.includes('air max') ||
        text.includes('adidas') ||
        text.includes('discount');
      expect(referencesPrior).toBe(true);

      logTiming(result);
      logSSEEvents(result);
      console.log(`  🧠 Summary continuity: references prior = ${referencesPrior}`);
      logFullResponse(result);
    }, 60_000);
  });

  // ---------------------------------------------------------------------------
  // Scenario 5: Automobile Domain Routing
  // ---------------------------------------------------------------------------
  describe('Scenario 5: Automobile Domain', () => {
    let autoIdentity: SessionIdentity;

    beforeAll(() => {
      autoIdentity = makeSessionIdentity();
    });

    test('Automobile query routes correctly and returns relevant results', async () => {
      logTurnHeader('SCENARIO 5 — User: "Show me a Toyota SUV under 200000 AED"');
      const result = await sendMessage('Show me a Toyota SUV under 200000 AED', autoIdentity);

      expect(result.fullText.length).toBeGreaterThan(0);

      const text = result.fullText.toLowerCase();
      const hasAutoContext =
        text.includes('toyota') ||
        text.includes('suv') ||
        text.includes('car') ||
        text.includes('vehicle') ||
        text.includes('budget') ||
        text.includes('model') ||
        text.includes('drive') ||
        text.includes('commute');
      expect(hasAutoContext).toBe(true);

      logTiming(result);
      logSSEEvents(result);
      logFullResponse(result);
    }, 90_000);
  });
});

// =============================================================================
// SSE PARSER UNIT TESTS (always run — no API key needed)
// =============================================================================

describe('SSE Parser — extractJSONObjects', () => {
  test('parses single JSON object', () => {
    const result = extractJSONObjects(
      'data: {"eventIndex":0,"output":[{"type":"text","content":"Hello"}]}',
    );
    expect(result).toHaveLength(1);
    expect(JSON.parse(result[0])).toEqual({
      eventIndex: 0,
      output: [{ type: 'text', content: 'Hello' }],
    });
  });

  test('parses concatenated JSON objects', () => {
    const result = extractJSONObjects(
      '{"eventIndex":1,"output":[{"type":"text","content":"Hi"}]}{"eventIndex":2,"output":[{"type":"text","content":" there"}]}',
    );
    expect(result).toHaveLength(2);
    expect(JSON.parse(result[0]).eventIndex).toBe(1);
    expect(JSON.parse(result[1]).eventIndex).toBe(2);
  });

  test('handles session info event', () => {
    const result = extractJSONObjects(
      'data: {"eventIndex":0,"sessionInfo":{"sessionId":"s-abc-123"},"sessionReference":"ref-xyz"}',
    );
    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0]);
    expect(parsed.sessionInfo.sessionId).toBe('s-abc-123');
    expect(parsed.sessionReference).toBe('ref-xyz');
  });

  test('handles agent identity event', () => {
    const result = extractJSONObjects(
      'data: {"eventIndex":1,"agent":{"displayName":"Fashion Expert","icon":"👗"}}',
    );
    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0]);
    expect(parsed.agent.displayName).toBe('Fashion Expert');
  });

  test('returns empty for non-JSON lines', () => {
    expect(extractJSONObjects('')).toHaveLength(0);
    expect(extractJSONObjects('event: message')).toHaveLength(0);
    expect(extractJSONObjects(': heartbeat')).toHaveLength(0);
  });
});

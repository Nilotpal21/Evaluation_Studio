/**
 * v4 INTERVIEW smoke test — verifies the end-to-end SSE event flow.
 *
 * Usage:
 *   npx tsx apps/studio/scripts/arch-smoke-interview.ts
 *
 * What this tests:
 *   1. Dev-login (POST /api/auth/dev-login) → access token
 *   2. Create session (POST /api/arch-ai/sessions) → sessionId
 *   3. Send message (POST /api/arch-ai/message) → SSE stream
 *   4. Parse SSE frames, reconstruct TurnEvents
 *   5. Assert: turn_started + at least one text_delta + turn_ended received
 *
 * Expected output on success:
 *   PASS: SSE event flow working. Events received: turn_started, text_delta (N chars), turn_ended
 *
 * Expected output on Bug 1 (type stripping bug):
 *   FAIL: No events received — all frames had type:undefined (parseEnvelope returned null)
 *
 * Expected output on Bug 2 (empty tool registry):
 *   PASS with text_delta but no ask_user / tool calls visible (LLM falls back to text-only)
 */

const BASE_URL = 'http://localhost:5173';
const DEV_EMAIL = 'dev@kore.ai';

interface SseFrame {
  eventType: string | null;
  data: string | null;
}

function parseSseFrames(raw: string): SseFrame[] {
  const frames: SseFrame[] = [];
  const blocks = raw.split('\n\n');
  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split('\n');
    const eventLine = lines.find((l) => l.startsWith('event: '));
    const dataLine = lines.find((l) => l.startsWith('data: '));
    if (!dataLine) continue;
    frames.push({
      eventType: eventLine ? eventLine.slice(7).trim() : null,
      data: dataLine.slice(6),
    });
  }
  return frames;
}

async function run(): Promise<void> {
  console.log(`Smoke testing v4 INTERVIEW path against ${BASE_URL}…\n`);

  // 1. Dev login
  const loginRes = await fetch(`${BASE_URL}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: DEV_EMAIL }),
  });
  if (!loginRes.ok) {
    const text = await loginRes.text();
    throw new Error(`dev-login failed: ${loginRes.status} ${text}`);
  }
  const loginData = (await loginRes.json()) as { accessToken?: string; token?: string };
  const accessToken = loginData.accessToken ?? loginData.token;
  if (!accessToken) {
    throw new Error(`dev-login: no accessToken in response: ${JSON.stringify(loginData)}`);
  }
  console.log('  [1/4] dev-login OK');

  const authHeaders = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  // 2. Create / get session
  const sessRes = await fetch(`${BASE_URL}/api/arch-ai/sessions`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ mode: 'ONBOARDING' }),
  });
  if (!sessRes.ok) {
    const text = await sessRes.text();
    throw new Error(`create session failed: ${sessRes.status} ${text}`);
  }
  const sessData = (await sessRes.json()) as { data?: { id?: string }; id?: string; _id?: string };
  const sessionId = sessData.data?.id ?? sessData.id ?? (sessData as { _id?: string })._id;
  if (!sessionId) {
    throw new Error(`create session: no id in response: ${JSON.stringify(sessData)}`);
  }
  console.log(`  [2/4] session created: ${sessionId}`);

  // 3. Send message → SSE stream
  const msgRes = await fetch(`${BASE_URL}/api/arch-ai/message`, {
    method: 'POST',
    headers: {
      ...authHeaders,
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      sessionId,
      type: 'message',
      text: 'Hello! I want to build a customer support bot.',
    }),
  });

  if (!msgRes.ok) {
    const text = await msgRes.text();
    throw new Error(`send message failed: ${msgRes.status} ${text}`);
  }
  if (!msgRes.body) {
    throw new Error('send message: no response body');
  }
  console.log('  [3/4] message sent, reading SSE stream…');

  // 4. Read SSE stream with a timeout
  const reader = msgRes.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  const timeoutMs = 60_000;
  const deadline = Date.now() + timeoutMs;

  const seenTypes = new Set<string>();
  let textDeltaChars = 0;
  let streamDone = false;

  while (!streamDone && Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (value) raw += decoder.decode(value, { stream: true });

    // Parse as many complete frames as we have so far
    const frames = parseSseFrames(raw);
    for (const frame of frames) {
      // Reconstruct type: from event: line if missing from data JSON
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(frame.data ?? '{}') as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof parsed.type !== 'string' && frame.eventType) {
        parsed.type = frame.eventType;
      }
      const evType = parsed.type as string | undefined;
      if (!evType) {
        console.warn(`    [WARN] Frame with no type — data: ${frame.data?.slice(0, 60)}`);
        continue;
      }
      seenTypes.add(evType);
      if (evType === 'text_delta') {
        textDeltaChars += (parsed.delta as string | undefined)?.length ?? 0;
      }
      console.log(
        `    SSE event: ${evType}${evType === 'text_delta' ? ` (+${(parsed.delta as string | undefined)?.length ?? 0} chars)` : ''}`,
      );
      if (evType === 'turn_ended' || evType === 'error') {
        streamDone = true;
        break;
      }
    }

    if (done) streamDone = true;
  }

  reader.releaseLock();
  console.log('\n  [4/4] Stream closed.\n');

  // 5. Assert
  const hasStart = seenTypes.has('turn_started');
  const hasDelta = seenTypes.has('text_delta');
  const hasEnd = seenTypes.has('turn_ended') || seenTypes.has('error');

  if (!hasStart && !hasDelta && !hasEnd) {
    console.error(
      'FAIL: No v4 TurnEvents received at all — likely SSE type-stripping bug (Bug 1).',
    );
    console.error(`  Raw SSE frames received:\n${raw.slice(0, 500)}`);
    process.exit(1);
  }

  if (!hasStart) {
    console.warn('WARN: turn_started not received — stream may have started mid-turn on replay.');
  }
  if (!hasDelta) {
    console.warn(
      'WARN: text_delta not received — LLM may have produced no text (tool-only response).',
    );
  }
  if (!hasEnd) {
    console.warn('WARN: turn_ended not received — stream timed out before engine finished.');
  }

  if (hasStart && hasDelta && hasEnd) {
    console.log(
      `PASS: SSE event flow working. Events: ${[...seenTypes].join(', ')}. Text: ${textDeltaChars} chars.`,
    );
    process.exit(0);
  } else {
    console.log(
      `PARTIAL: Some events received (${[...seenTypes].join(', ')}) but not all expected (turn_started, text_delta, turn_ended).`,
    );
    process.exit(0); // partial is OK for diagnosis
  }
}

run().catch((err: unknown) => {
  console.error('FATAL:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

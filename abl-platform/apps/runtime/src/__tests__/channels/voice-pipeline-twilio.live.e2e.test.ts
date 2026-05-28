/**
 * Voice Pipeline — Twilio Live Audio E2E
 *
 * This is an opt-in live integration test for the real phone-call path:
 *
 *   Twilio outbound call -> pipeline phone number -> Jambonz/KoreVG ->
 *   STT (Deepgram) -> Runtime agent -> TTS (ElevenLabs/Jambonz)
 *
 * Required env vars:
 *   VOICE_E2E_RUNTIME_BASE_URL
 *   VOICE_E2E_PROJECT_ID
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *
 * Auth to runtime:
 *   Either VOICE_E2E_RUNTIME_BEARER_TOKEN
 *   or VOICE_E2E_DEV_LOGIN_EMAIL (defaults to dev@kore.ai for local/dev-login enabled runtimes)
 *
 * Optional:
 *   VOICE_E2E_DEV_LOGIN_NAME
 *   VOICE_E2E_TO_NUMBER
 *   VOICE_E2E_FROM_NUMBER
 *   VOICE_E2E_AUDIO_URL
 *   VOICE_E2E_CALLER_TEXT
 *   VOICE_E2E_CALLER_PROJECT_ID
 *   VOICE_E2E_CALLER_AGENT_ID
 *   VOICE_E2E_CALLER_VOICE_PROJECT_ID
 *   VOICE_E2E_CALLER_TO_NUMBER
 *   VOICE_E2E_CALLER_SEED_MESSAGE
 *   VOICE_E2E_DUAL_CALL_MODE
 *   VOICE_E2E_TWILIO_BRIDGE_MODE
 *   VOICE_E2E_DUAL_SEED_TEXT
 *   VOICE_E2E_TWILIO_SAY_VOICE
 *   VOICE_E2E_EXPECTED_TRANSCRIPT_FRAGMENT
 *   VOICE_E2E_EXPECTED_RESPONSE_FRAGMENT
 *   VOICE_E2E_MAX_TOTAL_LATENCY_MS
 *   VOICE_E2E_MAX_STT_LATENCY_MS
 *   VOICE_E2E_MAX_LLM_LATENCY_MS
 *   VOICE_E2E_MAX_TTS_LATENCY_MS
 *   VOICE_E2E_MAX_E2E_LATENCY_MS
 *   VOICE_E2E_MAX_TURNS
 *   VOICE_E2E_MAX_WAIT_MS
 *   VOICE_E2E_POST_CALL_GRACE_MS
 *   VOICE_E2E_CALL_TIME_LIMIT_SECONDS
 *   VOICE_E2E_TWIML_POST_PLAY_PAUSE_SECONDS
 */

import { setTimeout as sleep } from 'node:timers/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
import { describe, test, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenvConfig({
  path: path.resolve(__dirname, '../..', '.env'),
});
dotenvConfig({
  path: path.resolve(__dirname, '../../../..', '.env'),
  override: false,
});

const RUNTIME_BASE_URL = (
  process.env.VOICE_E2E_RUNTIME_BASE_URL ||
  process.env.RUNTIME_PUBLIC_BASE_URL ||
  process.env.RUNTIME_BASE_URL ||
  ''
).replace(/\/+$/, '');
const RUNTIME_PUBLIC_BASE_URL = (
  process.env.VOICE_E2E_PUBLIC_BASE_URL ||
  process.env.RUNTIME_PUBLIC_BASE_URL ||
  ''
).replace(/\/+$/, '');
const PROJECT_ID = process.env.VOICE_E2E_PROJECT_ID || '';
const EXPLICIT_TO_NUMBER = process.env.VOICE_E2E_TO_NUMBER || '';
const FROM_NUMBER = process.env.VOICE_E2E_FROM_NUMBER || '';
const EXPLICIT_AUDIO_URL = process.env.VOICE_E2E_AUDIO_URL || '';
const FALLBACK_CALLER_TEXT =
  process.env.VOICE_E2E_CALLER_TEXT ||
  'Hello. Please tell me who you are and what you can help me with today.';
const CALLER_PROJECT_ID = process.env.VOICE_E2E_CALLER_PROJECT_ID || '';
const CALLER_AGENT_ID = process.env.VOICE_E2E_CALLER_AGENT_ID || '';
const CALLER_VOICE_PROJECT_ID =
  process.env.VOICE_E2E_CALLER_VOICE_PROJECT_ID || CALLER_PROJECT_ID || '';
const EXPLICIT_CALLER_TO_NUMBER = process.env.VOICE_E2E_CALLER_TO_NUMBER || '';
const CALLER_SEED_MESSAGE =
  process.env.VOICE_E2E_CALLER_SEED_MESSAGE ||
  'Reply with only the exact words to speak aloud on the phone, in plain conversational English, under two short sentences. Introduce yourself briefly as Project A and ask one clear question about how the other agent can help. Do not use XML, tags, status blocks, markdown, actions, destinations, tool syntax, or explanations.';
const DUAL_CALL_MODE = parseBoolean(process.env.VOICE_E2E_DUAL_CALL_MODE);
const TWILIO_BRIDGE_MODE = (process.env.VOICE_E2E_TWILIO_BRIDGE_MODE || 'relay').trim();
const DUAL_SEED_TEXT =
  process.env.VOICE_E2E_DUAL_SEED_TEXT ||
  'Hello. Please introduce yourself briefly as Project A and ask what kind of help you can offer today.';
const TWILIO_SAY_VOICE = process.env.VOICE_E2E_TWILIO_SAY_VOICE || 'alice';
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';

const EXPECTED_TRANSCRIPT_FRAGMENT = process.env.VOICE_E2E_EXPECTED_TRANSCRIPT_FRAGMENT || '';
const EXPECTED_RESPONSE_FRAGMENT = process.env.VOICE_E2E_EXPECTED_RESPONSE_FRAGMENT || '';
const MAX_TOTAL_LATENCY_MS = parseOptionalPositiveInt(process.env.VOICE_E2E_MAX_TOTAL_LATENCY_MS);
const MAX_STT_LATENCY_MS = parseOptionalPositiveInt(process.env.VOICE_E2E_MAX_STT_LATENCY_MS);
const MAX_LLM_LATENCY_MS = parseOptionalPositiveInt(process.env.VOICE_E2E_MAX_LLM_LATENCY_MS);
const MAX_TTS_LATENCY_MS = parseOptionalPositiveInt(process.env.VOICE_E2E_MAX_TTS_LATENCY_MS);
const MAX_E2E_LATENCY_MS = parseOptionalPositiveInt(process.env.VOICE_E2E_MAX_E2E_LATENCY_MS);

const MAX_TURNS = parsePositiveInt(process.env.VOICE_E2E_MAX_TURNS, CALLER_PROJECT_ID ? 12 : 1);
const MIN_CONFERENCE_TURNS = parsePositiveInt(process.env.VOICE_E2E_MIN_CONFERENCE_TURNS, 4);
const CONFERENCE_COMPLETION_IDLE_MS = parsePositiveInt(
  process.env.VOICE_E2E_CONFERENCE_COMPLETION_IDLE_MS,
  8_000,
);
const REQUIRE_CONFERENCE_COMPLETION = parseBoolean(
  process.env.VOICE_E2E_REQUIRE_CONFERENCE_COMPLETION,
);
const MAX_WAIT_MS = parsePositiveInt(process.env.VOICE_E2E_MAX_WAIT_MS, 180_000);
const POST_CALL_GRACE_MS = parsePositiveInt(process.env.VOICE_E2E_POST_CALL_GRACE_MS, 30_000);
const DEV_LOGIN_EMAIL = process.env.VOICE_E2E_DEV_LOGIN_EMAIL || 'dev@kore.ai';
const USE_STUDIO_PROXY = parseBoolean(process.env.VOICE_E2E_USE_STUDIO_PROXY);
const ENABLE_TWILIO_RECORDING = !/^(0|false|no|off)$/i.test(
  process.env.VOICE_E2E_ENABLE_RECORDING || 'true',
);
const CALL_TIME_LIMIT_SECONDS = parsePositiveInt(
  process.env.VOICE_E2E_CALL_TIME_LIMIT_SECONDS,
  DUAL_CALL_MODE ? 300 : 120,
);
const TWIML_POST_PLAY_PAUSE_SECONDS = parsePositiveInt(
  process.env.VOICE_E2E_TWIML_POST_PLAY_PAUSE_SECONDS,
  MAX_TURNS > 1 ? 60 : 5,
);
const POLL_INTERVAL_MS = 2_000;

const REQUIRED_ENV_MISSING = [
  !RUNTIME_BASE_URL && 'VOICE_E2E_RUNTIME_BASE_URL',
  !PROJECT_ID && 'VOICE_E2E_PROJECT_ID',
  !EXPLICIT_AUDIO_URL &&
    !RUNTIME_PUBLIC_BASE_URL &&
    !FALLBACK_CALLER_TEXT &&
    'VOICE_E2E_AUDIO_URL or VOICE_E2E_PUBLIC_BASE_URL/RUNTIME_PUBLIC_BASE_URL or VOICE_E2E_CALLER_TEXT',
  !TWILIO_ACCOUNT_SID && 'TWILIO_ACCOUNT_SID',
  !TWILIO_AUTH_TOKEN && 'TWILIO_AUTH_TOKEN',
  DUAL_CALL_MODE &&
    !CALLER_VOICE_PROJECT_ID &&
    'VOICE_E2E_CALLER_VOICE_PROJECT_ID or VOICE_E2E_CALLER_PROJECT_ID',
].filter(Boolean);

const SKIP_REASON =
  REQUIRED_ENV_MISSING.length > 0
    ? `Missing required live E2E env: ${REQUIRED_ENV_MISSING.join(', ')}`
    : '';

type SessionListItem = {
  id: string;
  createdAt: string;
  channel?: string;
  status?: string;
  messageCount?: number;
};

type SessionDetailResponse = {
  success?: boolean;
  session: {
    id: string;
    agentName: string;
    status?: string;
    channel?: string;
    createdAt: string;
    lastActivityAt: string;
    messages: Array<{
      id: string;
      role: string;
      content: string;
      timestamp: string;
    }>;
    traceEvents: unknown[];
  };
};

type SessionListResponse = {
  success?: boolean;
  sessions: SessionListItem[];
};

type AgentChatResponse = {
  sessionId: string;
  response: string;
};

type TwilioCallRecord = {
  sid: string;
  status: string;
  duration?: string | null;
};

type TwilioRecordingRecord = {
  sid: string;
  status: string;
  duration?: string | null;
  channels?: number | null;
  mediaUrl: string;
};

type ConferenceTurnWaitResult = {
  projectASession: SessionDetailResponse['session'];
  projectBSession: SessionDetailResponse['session'];
  turnSummaries: TurnSummary[];
  completionReason: 'natural_completion' | 'hard_turn_cap';
};

type VoiceTurnSnapshot = {
  event: unknown;
  timestamp?: string;
  utterance: string;
  response: string;
  timing: Record<string, unknown>;
  sttModel?: string;
};

type TurnSummary = {
  projectLabel: 'Project A' | 'Project B';
  projectId: string;
  sessionId: string;
  turn: number;
  callerText: string;
  utterance: string;
  response: string;
  timestamp?: string;
  offsetFromCallStartMs?: number;
  gapFromPreviousProjectTurnMs?: number;
  gapFromPreviousConversationTurnMs?: number;
  timing: Record<string, unknown>;
  sttModel?: string;
};

type TimingField = 'total' | 'stt' | 'llm' | 'tts' | 'ttsFirstChunk' | 'e2e';

type TurnTimingSnapshot = {
  total?: number;
  stt?: number;
  llm?: number;
  tts?: number;
  ttsFirstChunk?: number;
  e2e?: number;
};

type ChannelConnectionRecord = {
  id: string;
  channelType: string;
  status: string;
  displayName?: string | null;
  config?: Record<string, unknown>;
};

type ChannelConnectionsResponse = {
  success: boolean;
  connections: ChannelConnectionRecord[];
};

type TwilioPhoneNumbersResponse = {
  phoneNumbers: Array<{
    sid: string;
    phoneNumber: string;
    friendlyName?: string;
  }>;
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalPositiveInt(value: string | undefined): number | null {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseBoolean(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value || '');
}

function buildPlaybackTwiml(audioUrl: string | null, callerText: string): string {
  if (audioUrl) {
    const escapedUrl = escapeXml(audioUrl);
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${escapedUrl}</Play>
  <Pause length="${TWIML_POST_PLAY_PAUSE_SECONDS}"/>
</Response>`;
  }

  const escapedText = escapeXml(callerText);
  const escapedVoice = escapeXml(TWILIO_SAY_VOICE);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${escapedVoice}">${escapedText}</Say>
  <Pause length="${TWIML_POST_PLAY_PAUSE_SECONDS}"/>
</Response>`;
}

function buildConferenceTwiml(
  conferenceName: string,
  options?: {
    startConferenceOnEnter?: boolean;
    endConferenceOnExit?: boolean;
    waitUrl?: string;
  },
): string {
  const startConferenceOnEnter = options?.startConferenceOnEnter ?? true;
  const endConferenceOnExit = options?.endConferenceOnExit ?? true;
  const attributes = [
    'beep="false"',
    `startConferenceOnEnter="${startConferenceOnEnter}"`,
    `endConferenceOnExit="${endConferenceOnExit}"`,
  ];
  if (typeof options?.waitUrl === 'string') {
    attributes.push(`waitUrl="${escapeXml(options.waitUrl)}"`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Conference ${attributes.join(' ')}>${escapeXml(conferenceName)}</Conference>
  </Dial>
</Response>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function fetchJson<T>(
  url: string,
  options?: RequestInit,
): Promise<{ status: number; body: T; text: string }> {
  const response = await fetch(url, options);
  const text = await response.text();
  const body = text.length > 0 ? (JSON.parse(text) as T) : ({} as T);
  return {
    status: response.status,
    body,
    text,
  };
}

async function getRuntimeBearerToken(): Promise<string> {
  const explicitToken = process.env.VOICE_E2E_RUNTIME_BEARER_TOKEN;
  if (explicitToken) {
    return explicitToken;
  }

  const email = DEV_LOGIN_EMAIL;
  if (!email) {
    throw new Error(
      'Missing runtime auth. Set VOICE_E2E_RUNTIME_BEARER_TOKEN or VOICE_E2E_DEV_LOGIN_EMAIL.',
    );
  }

  const response = await fetchJson<{
    accessToken?: string;
    error?: string;
  }>(`${RUNTIME_BASE_URL}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      name: process.env.VOICE_E2E_DEV_LOGIN_NAME || 'Voice E2E',
    }),
  });

  if (response.status !== 200 || !response.body.accessToken) {
    throw new Error(`dev-login failed (${response.status}): ${response.text}`);
  }

  return response.body.accessToken;
}

async function createTwilioClient() {
  const twilioModule = await import('twilio');
  return twilioModule.default(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

async function listChannelConnections(
  token: string,
  projectId: string,
): Promise<ChannelConnectionRecord[]> {
  const response = await fetchJson<ChannelConnectionsResponse>(
    `${RUNTIME_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/channel-connections`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );

  if (response.status !== 200 || !response.body.success) {
    throw new Error(`Failed to list channel connections (${response.status}): ${response.text}`);
  }

  return response.body.connections;
}

function getDefaultRuntimeAudioFixtureUrl(callerText: string): string | null {
  if (!RUNTIME_PUBLIC_BASE_URL) {
    return null;
  }

  const fixture = new URL(`${RUNTIME_PUBLIC_BASE_URL}/api/v1/voice/e2e/caller-audio`);
  fixture.searchParams.set('text', callerText);
  return fixture.toString();
}

async function resolvePlaybackAudioUrl(callerText: string): Promise<string | null> {
  if (EXPLICIT_AUDIO_URL) {
    return EXPLICIT_AUDIO_URL;
  }

  const runtimeFixtureUrl = getDefaultRuntimeAudioFixtureUrl(callerText);
  if (!runtimeFixtureUrl) {
    return null;
  }

  const prewarmUrl = new URL(`${RUNTIME_BASE_URL}/api/v1/voice/e2e/caller-audio`);
  prewarmUrl.searchParams.set('text', callerText);

  const response = await fetch(prewarmUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to prewarm runtime caller audio fixture (${response.status} ${response.statusText})`,
    );
  }

  return runtimeFixtureUrl;
}

async function resolvePipelineTargetNumber(
  token: string,
  projectId: string,
  explicitToNumber?: string,
): Promise<string> {
  if (explicitToNumber) {
    return explicitToNumber;
  }

  const connections = await listChannelConnections(token, projectId);
  const activeVoicePipeline = connections.find((connection) => {
    if (connection.channelType !== 'voice_pipeline' || connection.status !== 'active') {
      return false;
    }
    const phoneNumber = connection.config?.phoneNumber;
    return typeof phoneNumber === 'string' && phoneNumber.trim().length > 0;
  });

  if (!activeVoicePipeline) {
    throw new Error(
      `No active voice_pipeline channel with a phoneNumber was found for project ${projectId}. ` +
        'Set VOICE_E2E_TO_NUMBER explicitly or activate a pipeline voice connection first.',
    );
  }

  return String(activeVoicePipeline.config?.phoneNumber);
}

async function listTwilioPhoneNumbers(token: string): Promise<string[]> {
  const response = await fetchJson<TwilioPhoneNumbersResponse>(
    `${RUNTIME_BASE_URL}/api/v1/voice/twilio/phone-numbers`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );

  if (response.status !== 200 || !Array.isArray(response.body.phoneNumbers)) {
    throw new Error(`Failed to list Twilio phone numbers (${response.status}): ${response.text}`);
  }

  return response.body.phoneNumbers
    .map((entry) => entry.phoneNumber)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

async function resolveCallerNumber(token: string, excludedNumbers: string[]): Promise<string> {
  if (FROM_NUMBER) {
    return FROM_NUMBER;
  }

  const availableNumbers = await listTwilioPhoneNumbers(token);
  const excludedSet = new Set(excludedNumbers);
  const preferredNumber =
    availableNumbers.find((phoneNumber) => !excludedSet.has(phoneNumber)) || availableNumbers[0];

  if (!preferredNumber) {
    throw new Error(
      'No Twilio caller number is available. Set VOICE_E2E_FROM_NUMBER explicitly or add a Twilio number first.',
    );
  }

  return preferredNumber;
}

async function placePlaybackCall(
  fromNumber: string,
  toNumber: string,
  audioUrl: string | null,
  callerText: string,
): Promise<TwilioCallRecord> {
  const client = await createTwilioClient();
  const call = await client.calls.create({
    from: fromNumber,
    to: toNumber,
    twiml: buildPlaybackTwiml(audioUrl, callerText),
    timeLimit: CALL_TIME_LIMIT_SECONDS,
    record: ENABLE_TWILIO_RECORDING,
  });

  return {
    sid: String(call.sid),
    status: String(call.status || 'queued'),
    duration: call.duration ?? null,
  };
}

async function placeConferenceCall(
  fromNumber: string,
  toNumber: string,
  conferenceName: string,
  options?: {
    startConferenceOnEnter?: boolean;
    endConferenceOnExit?: boolean;
    waitUrl?: string;
  },
): Promise<TwilioCallRecord> {
  const client = await createTwilioClient();
  const call = await client.calls.create({
    from: fromNumber,
    to: toNumber,
    twiml: buildConferenceTwiml(conferenceName, options),
    timeLimit: CALL_TIME_LIMIT_SECONDS,
    record: ENABLE_TWILIO_RECORDING,
  });

  return {
    sid: String(call.sid),
    status: String(call.status || 'queued'),
    duration: call.duration ?? null,
  };
}

async function updatePlaybackCall(
  callSid: string,
  audioUrl: string | null,
  callerText: string,
): Promise<TwilioCallRecord> {
  const client = await createTwilioClient();
  const call = await client.calls(callSid).update({
    twiml: buildPlaybackTwiml(audioUrl, callerText),
  });

  return {
    sid: String(call.sid),
    status: String(call.status || 'unknown'),
    duration: call.duration ?? null,
  };
}

async function completeCall(callSid: string): Promise<TwilioCallRecord> {
  const client = await createTwilioClient();
  const call = await client.calls(callSid).update({ status: 'completed' });

  return {
    sid: String(call.sid),
    status: String(call.status || 'completed'),
    duration: call.duration ?? null,
  };
}

async function fetchTwilioCall(callSid: string): Promise<TwilioCallRecord> {
  const client = await createTwilioClient();
  const call = await client.calls(callSid).fetch();
  return {
    sid: String(call.sid),
    status: String(call.status || 'unknown'),
    duration: call.duration ?? null,
  };
}

async function waitForCallTerminal(callSid: string): Promise<TwilioCallRecord> {
  const terminalStatuses = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);

  const startedAt = Date.now();
  let latest = await fetchTwilioCall(callSid);
  let lastLoggedStatus = '';

  while (!terminalStatuses.has(latest.status)) {
    if (latest.status !== lastLoggedStatus) {
      console.log('[Voice Twilio Live E2E] Twilio call status', {
        callSid,
        status: latest.status,
      });
      lastLoggedStatus = latest.status;
    }
    if (Date.now() - startedAt > MAX_WAIT_MS) {
      throw new Error(
        `Timed out waiting for Twilio call ${callSid} to finish. Last status=${latest.status}`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
    latest = await fetchTwilioCall(callSid);
  }

  console.log('[Voice Twilio Live E2E] Twilio call terminal', {
    callSid,
    status: latest.status,
    duration: latest.duration,
  });

  return latest;
}

function buildTwilioRecordingMediaUrl(uri: string): string {
  const normalizedUri = uri.endsWith('.json') ? uri.slice(0, -5) : uri;
  return `https://api.twilio.com${normalizedUri}.mp3`;
}

async function listTwilioRecordings(callSid: string): Promise<TwilioRecordingRecord[]> {
  const client = await createTwilioClient();
  const recordings = await client.recordings.list({ callSid, limit: 20 });
  return recordings.map(
    (recording: {
      sid: string;
      status?: string;
      duration?: string | null;
      channels?: number | null;
      uri: string;
    }) => ({
      sid: String(recording.sid),
      status: String(recording.status || 'unknown'),
      duration: recording.duration ?? null,
      channels: recording.channels ?? null,
      mediaUrl: buildTwilioRecordingMediaUrl(recording.uri),
    }),
  );
}

async function waitForTwilioRecordings(callSid: string): Promise<TwilioRecordingRecord[]> {
  if (!ENABLE_TWILIO_RECORDING) {
    return [];
  }

  const startedAt = Date.now();

  while (Date.now() - startedAt <= POST_CALL_GRACE_MS) {
    const recordings = await listTwilioRecordings(callSid);
    const completedRecordings = recordings.filter((recording) => recording.status === 'completed');
    if (completedRecordings.length > 0) {
      return completedRecordings;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  const recordings = await listTwilioRecordings(callSid);
  return recordings;
}

async function listRecentSessions(token: string, projectId: string): Promise<SessionListItem[]> {
  const url = USE_STUDIO_PROXY
    ? `${RUNTIME_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/sessions?limit=20&offset=0`
    : `${RUNTIME_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/sessions?limit=20&offset=0`;
  const response = await fetchJson<SessionListResponse>(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (response.status !== 200 || !Array.isArray(response.body.sessions)) {
    throw new Error(`Failed to list sessions (${response.status}): ${response.text}`);
  }

  return response.body.sessions;
}

async function getSessionDetail(
  token: string,
  projectId: string,
  sessionId: string,
): Promise<SessionDetailResponse> {
  const url = USE_STUDIO_PROXY
    ? `${RUNTIME_BASE_URL}/api/runtime/sessions/${encodeURIComponent(sessionId)}?projectId=${encodeURIComponent(projectId)}&includeTraces=true`
    : `${RUNTIME_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(
        sessionId,
      )}?includeTraces=true`;
  const response = await fetchJson<SessionDetailResponse>(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (response.status !== 200 || !response.body.session) {
    throw new Error(`Failed to fetch session ${sessionId} (${response.status}): ${response.text}`);
  }

  return response.body;
}

function getTraceData(event: unknown): Record<string, unknown> {
  if (!event || typeof event !== 'object') return {};
  const candidate = (event as Record<string, unknown>).data;
  return candidate && typeof candidate === 'object' ? (candidate as Record<string, unknown>) : {};
}

function getTraceType(event: unknown): string {
  if (!event || typeof event !== 'object') return '';
  const type = (event as Record<string, unknown>).type;
  return typeof type === 'string' ? type : '';
}

function getTraceTimestamp(event: unknown): string | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const timestamp = (event as Record<string, unknown>).timestamp;
  if (typeof timestamp === 'string' && timestamp.trim().length > 0) {
    return timestamp;
  }
  if (timestamp instanceof Date && !Number.isNaN(timestamp.getTime())) {
    return timestamp.toISOString();
  }
  return undefined;
}

function parseIsoTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeNormalized(value: string): string[] {
  return normalizeForMatch(value)
    .split(' ')
    .map((token) => token.trim())
    .filter(Boolean);
}

function hasStrongTokenOverlap(left: string, right: string): boolean {
  const leftTokens = new Set(tokenizeNormalized(left));
  const rightTokens = new Set(tokenizeNormalized(right));

  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return false;
  }

  let sharedCount = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      sharedCount += 1;
    }
  }

  const overlapRatio = sharedCount / Math.min(leftTokens.size, rightTokens.size);
  return overlapRatio >= 0.8;
}

function toSpokenText(value: string, fallback: string = FALLBACK_CALLER_TEXT): string {
  const withoutTags = value.replace(/<[^>]+>/g, ' ');
  const cleaned = withoutTags
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(destination|context|status)\b/i.test(line))
    .join(' ')
    .replace(/\+\d[\d\s-]{5,}/g, ' ')
    .replace(/\b(initiate[_\s]?call|destination|context|status)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return fallback;
  }

  const looksStructured =
    /[<>]/.test(value) || /\b(initiate[_\s]?call|destination|context)\b/i.test(cleaned);
  if (looksStructured) {
    return fallback;
  }

  return cleaned;
}

function sessionMatchesCallerPrompt(
  session: SessionDetailResponse['session'],
  callerText: string,
): boolean {
  const expected = normalizeForMatch(callerText);
  if (!expected) return false;

  const userMessageText = session.messages
    .filter((message) => message.role === 'user')
    .map((message) => normalizeForMatch(message.content))
    .join(' ');
  if (userMessageText.includes(expected) || expected.includes(userMessageText)) {
    return true;
  }
  if (hasStrongTokenOverlap(userMessageText, expected)) {
    return true;
  }

  return session.traceEvents.some((event) => {
    if (getTraceType(event) !== 'voice_turn') return false;
    const utterance = getTraceData(event).utterance;
    return (
      typeof utterance === 'string' &&
      (normalizeForMatch(utterance).includes(expected) ||
        expected.includes(normalizeForMatch(utterance)) ||
        hasStrongTokenOverlap(utterance, expected))
    );
  });
}

async function findSessionIdByCallSid(
  token: string,
  projectId: string,
  callSid: string,
  callStartedAtMs: number,
  callerText: string,
): Promise<string> {
  const startedAt = Date.now();
  const fallbackWindowMs = 15_000;

  while (Date.now() - startedAt < MAX_WAIT_MS) {
    const sessions = await listRecentSessions(token, projectId);
    const recentVoiceCandidates: string[] = [];

    for (const session of sessions) {
      if (session.channel && session.channel !== 'voice') {
        continue;
      }

      const createdAtMs = Date.parse(session.createdAt);
      if (Number.isFinite(createdAtMs) && createdAtMs + fallbackWindowMs < callStartedAtMs) {
        continue;
      }

      recentVoiceCandidates.push(session.id);
      const detail = await getSessionDetail(token, projectId, session.id);
      const matchesCallSid = detail.session.traceEvents.some((event) => {
        return getTraceData(event).callSid === callSid;
      });

      if (matchesCallSid) {
        return session.id;
      }

      if (sessionMatchesCallerPrompt(detail.session, callerText)) {
        return session.id;
      }
    }

    if (recentVoiceCandidates.length === 1) {
      return recentVoiceCandidates[0];
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for runtime session linked to callSid=${callSid}`);
}

async function generateCallerPrompt(
  token: string,
  message: string,
  callerSessionId?: string,
): Promise<{ callerText: string; callerSessionId?: string }> {
  if (!CALLER_PROJECT_ID) {
    return { callerText: FALLBACK_CALLER_TEXT };
  }

  const response = await fetchJson<AgentChatResponse | { error?: string }>(
    `${RUNTIME_BASE_URL}/api/v1/chat/agent`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        projectId: CALLER_PROJECT_ID,
        message,
        ...(callerSessionId ? { sessionId: callerSessionId } : {}),
        ...(CALLER_AGENT_ID ? { agentId: CALLER_AGENT_ID } : {}),
      }),
    },
  );

  if (response.status !== 200) {
    throw new Error(`Project A caller generation failed (${response.status}): ${response.text}`);
  }

  const body = response.body;
  if (
    !('response' in body) ||
    typeof body.response !== 'string' ||
    body.response.trim().length === 0
  ) {
    throw new Error(`Project A caller generation returned no response text: ${response.text}`);
  }

  return {
    callerText: toSpokenText(body.response),
    callerSessionId:
      'sessionId' in body && typeof body.sessionId === 'string' ? body.sessionId : undefined,
  };
}

function getVoiceTurnSnapshots(session: SessionDetailResponse['session']): VoiceTurnSnapshot[] {
  return session.traceEvents
    .filter((event) => getTraceType(event) === 'voice_turn')
    .map((event) => {
      const data = getTraceData(event);
      return {
        event,
        timestamp: getTraceTimestamp(event),
        utterance: typeof data.utterance === 'string' ? data.utterance : '',
        response: typeof data.response === 'string' ? data.response : '',
        timing:
          data.timing && typeof data.timing === 'object'
            ? (data.timing as Record<string, unknown>)
            : {},
        sttModel: typeof data.sttModel === 'string' ? data.sttModel : undefined,
      };
    });
}

function lastAssistantMessage(session: SessionDetailResponse['session']): string {
  const latest = [...session.messages]
    .reverse()
    .find((message) => message.role === 'assistant' && message.content.trim().length > 0);
  return latest?.content.trim() || '';
}

function computeOffsetFromCallStart(
  timestamp: string | undefined,
  startedAtMs: number,
): number | undefined {
  const eventTimeMs = parseIsoTimestamp(timestamp);
  if (eventTimeMs == null) {
    return undefined;
  }
  return Math.max(0, eventTimeMs - startedAtMs);
}

function addConversationGapMetrics(turnSummaries: TurnSummary[]): TurnSummary[] {
  const sortedByTimestamp = [...turnSummaries].sort((left, right) => {
    const leftTime = parseIsoTimestamp(left.timestamp) ?? Number.MAX_SAFE_INTEGER;
    const rightTime = parseIsoTimestamp(right.timestamp) ?? Number.MAX_SAFE_INTEGER;
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return left.projectLabel.localeCompare(right.projectLabel) || left.turn - right.turn;
  });

  const previousProjectTurn = new Map<'Project A' | 'Project B', number>();
  let previousConversationTurnAtMs: number | undefined;

  for (const turn of sortedByTimestamp) {
    const currentTurnAtMs = parseIsoTimestamp(turn.timestamp);
    if (currentTurnAtMs == null) {
      continue;
    }

    const previousProjectTurnAtMs = previousProjectTurn.get(turn.projectLabel);
    if (previousProjectTurnAtMs != null) {
      turn.gapFromPreviousProjectTurnMs = currentTurnAtMs - previousProjectTurnAtMs;
    }

    if (previousConversationTurnAtMs != null) {
      turn.gapFromPreviousConversationTurnMs = currentTurnAtMs - previousConversationTurnAtMs;
    }

    previousProjectTurn.set(turn.projectLabel, currentTurnAtMs);
    previousConversationTurnAtMs = currentTurnAtMs;
  }

  return turnSummaries;
}

function buildConferenceTurnSummaries(
  projectASession: SessionDetailResponse['session'],
  projectBSession: SessionDetailResponse['session'],
  callStarts: { projectAStartedAtMs: number; projectBStartedAtMs: number },
): TurnSummary[] {
  const projectATurns = getVoiceTurnSnapshots(projectASession).map((turn, index) => ({
    projectLabel: 'Project A' as const,
    projectId: CALLER_VOICE_PROJECT_ID,
    sessionId: projectASession.id,
    turn: index + 1,
    callerText: '[conference bridge]',
    utterance: turn.utterance,
    response: turn.response,
    timestamp: turn.timestamp,
    offsetFromCallStartMs: computeOffsetFromCallStart(
      turn.timestamp,
      callStarts.projectAStartedAtMs,
    ),
    timing: turn.timing,
    sttModel: turn.sttModel,
  }));

  const projectBTurns = getVoiceTurnSnapshots(projectBSession).map((turn, index) => ({
    projectLabel: 'Project B' as const,
    projectId: PROJECT_ID,
    sessionId: projectBSession.id,
    turn: index + 1,
    callerText: '[conference bridge]',
    utterance: turn.utterance,
    response: turn.response,
    timestamp: turn.timestamp,
    offsetFromCallStartMs: computeOffsetFromCallStart(
      turn.timestamp,
      callStarts.projectBStartedAtMs,
    ),
    timing: turn.timing,
    sttModel: turn.sttModel,
  }));

  return addConversationGapMetrics([...projectATurns, ...projectBTurns]);
}

function normalizeConversationText(value: string): string {
  return value
    .replace(/<status>.*?<\/status>/gi, ' ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function textContainsAny(value: string, phrases: string[]): boolean {
  const normalized = normalizeConversationText(value);
  return phrases.some((phrase) => normalized.includes(phrase));
}

function getLatestProjectTurn(
  turnSummaries: TurnSummary[],
  projectLabel: 'Project A' | 'Project B',
): TurnSummary | null {
  const turns = turnSummaries.filter((turn) => turn.projectLabel === projectLabel);
  return turns.length > 0 ? turns[turns.length - 1] : null;
}

function conferenceConversationLooksComplete(turnSummaries: TurnSummary[]): boolean {
  const latestProjectATurn = getLatestProjectTurn(turnSummaries, 'Project A');
  const latestProjectBTurn = getLatestProjectTurn(turnSummaries, 'Project B');

  if (!latestProjectATurn || !latestProjectBTurn) {
    return false;
  }

  const projectAClosingPhrases = [
    'thanks',
    'thank you',
    'that helps',
    'that is all',
    'thats all',
    'no that is all',
    'no thats all',
    'appreciate it',
    'have a good day',
    'have a great day',
    'bye',
    'goodbye',
  ];
  const projectBStatusPhrases = [
    'status',
    'processing',
    'shipped',
    'ship tomorrow',
    'ship today',
    'on the way',
    'arrive',
    'delivery',
    'expected',
    'found your order',
    'pulled up that order',
    'look up that order',
    'looked up that order',
    'located your order',
  ];
  const projectBClosingPhrases = [
    'you are welcome',
    'youre welcome',
    'anything else',
    'have a good day',
    'have a great day',
    'bye',
    'goodbye',
    'glad i could help',
  ];

  const latestProjectAText = `${latestProjectATurn.utterance} ${latestProjectATurn.response}`;
  const latestProjectBText = `${latestProjectBTurn.utterance} ${latestProjectBTurn.response}`;

  const projectAClosed = textContainsAny(latestProjectAText, projectAClosingPhrases);
  const projectBProvidedStatus = textContainsAny(latestProjectBText, projectBStatusPhrases);
  const projectBClosed = textContainsAny(latestProjectBText, projectBClosingPhrases);

  return (projectAClosed && projectBProvidedStatus) || (projectAClosed && projectBClosed);
}

function buildCallerFollowUpMessage(projectBReply: string, nextTurn: number): string {
  const sanitizedReply = projectBReply.replace(/\s+/g, ' ').trim();
  return [
    `You are on turn ${nextTurn} of a phone conversation with another voice agent.`,
    `The other voice agent just said: "${sanitizedReply}"`,
    'Reply with only the exact words to speak aloud next on the phone, in plain conversational English, under two short sentences.',
    'Continue naturally from what they said and ask at most one clear follow-up question.',
    'Do not use XML, tags, markdown, actions, destinations, tool syntax, or explanations.',
  ].join(' ');
}

async function waitForVoiceTurn(
  token: string,
  projectId: string,
  sessionId: string,
  expectedTurnCount: number,
): Promise<{ session: SessionDetailResponse['session']; turn: VoiceTurnSnapshot }> {
  const startedAt = Date.now();
  let latest = (await getSessionDetail(token, projectId, sessionId)).session;

  while (Date.now() - startedAt < MAX_WAIT_MS) {
    const turns = getVoiceTurnSnapshots(latest);
    const targetTurn = turns[expectedTurnCount - 1];
    if (targetTurn && targetTurn.response.trim().length > 0) {
      return { session: latest, turn: targetTurn };
    }

    await sleep(POLL_INTERVAL_MS);
    latest = (await getSessionDetail(token, projectId, sessionId)).session;
  }

  throw new Error(`Timed out waiting for voice turn ${expectedTurnCount} in session ${sessionId}`);
}

async function waitForConferenceConversation(
  token: string,
  projectASessionId: string,
  projectBSessionId: string,
  callStarts: { projectAStartedAtMs: number; projectBStartedAtMs: number },
): Promise<ConferenceTurnWaitResult> {
  const startedAt = Date.now();
  let projectASession = (await getSessionDetail(token, CALLER_VOICE_PROJECT_ID, projectASessionId))
    .session;
  let projectBSession = (await getSessionDetail(token, PROJECT_ID, projectBSessionId)).session;
  let lastProgressAt = Date.now();
  let lastTurnCount = 0;

  while (Date.now() - startedAt < MAX_WAIT_MS) {
    const turnSummaries = buildConferenceTurnSummaries(
      projectASession,
      projectBSession,
      callStarts,
    );
    const projectATurns = turnSummaries.filter((turn) => turn.projectLabel === 'Project A');
    const projectBTurns = turnSummaries.filter((turn) => turn.projectLabel === 'Project B');
    const allTurnsComplete = turnSummaries.every(
      (turn) => turn.utterance.trim().length > 0 && turn.response.trim().length > 0,
    );

    if (turnSummaries.length !== lastTurnCount) {
      lastTurnCount = turnSummaries.length;
      lastProgressAt = Date.now();
    }

    if (projectATurns.length > 0 && projectBTurns.length > 0 && allTurnsComplete) {
      if (turnSummaries.length >= MAX_TURNS && !REQUIRE_CONFERENCE_COMPLETION) {
        return {
          projectASession,
          projectBSession,
          turnSummaries,
          completionReason: 'hard_turn_cap',
        };
      }

      if (!REQUIRE_CONFERENCE_COMPLETION) {
        await sleep(POLL_INTERVAL_MS);
        projectASession = (
          await getSessionDetail(token, CALLER_VOICE_PROJECT_ID, projectASessionId)
        ).session;
        projectBSession = (await getSessionDetail(token, PROJECT_ID, projectBSessionId)).session;
        continue;
      }

      if (turnSummaries.length >= MAX_TURNS) {
        return {
          projectASession,
          projectBSession,
          turnSummaries,
          completionReason: 'hard_turn_cap',
        };
      }

      const idleForMs = Date.now() - lastProgressAt;
      if (
        turnSummaries.length >= MIN_CONFERENCE_TURNS &&
        idleForMs >= CONFERENCE_COMPLETION_IDLE_MS &&
        conferenceConversationLooksComplete(turnSummaries)
      ) {
        return {
          projectASession,
          projectBSession,
          turnSummaries,
          completionReason: 'natural_completion',
        };
      }
    }

    await sleep(POLL_INTERVAL_MS);
    projectASession = (await getSessionDetail(token, CALLER_VOICE_PROJECT_ID, projectASessionId))
      .session;
    projectBSession = (await getSessionDetail(token, PROJECT_ID, projectBSessionId)).session;
  }

  throw new Error(
    `Timed out waiting for conference conversation. projectASession=${projectASessionId} projectBSession=${projectBSessionId}`,
  );
}

function lastTraceOfType(session: SessionDetailResponse['session'], type: string): unknown {
  return [...session.traceEvents].reverse().find((event) => getTraceType(event) === type);
}

function readNumberField(
  record: Record<string, unknown>,
  key: string,
): number | string | undefined | null {
  const value = record[key];
  return typeof value === 'number' || typeof value === 'string' || value == null
    ? value
    : undefined;
}

function readTimingMetric(record: Record<string, unknown>, key: TimingField): number | undefined {
  const value = readNumberField(record, key);
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function extractTimingSnapshot(record: Record<string, unknown>): TurnTimingSnapshot {
  return {
    total: readTimingMetric(record, 'total'),
    stt: readTimingMetric(record, 'stt'),
    llm: readTimingMetric(record, 'llm'),
    tts: readTimingMetric(record, 'tts'),
    ttsFirstChunk: readTimingMetric(record, 'ttsFirstChunk'),
    e2e: readTimingMetric(record, 'e2e'),
  };
}

function roundMetric(value: number | undefined): number | undefined {
  return typeof value === 'number' ? Math.round(value) : undefined;
}

function summarizeMetric(values: Array<number | undefined>): {
  count: number;
  avg?: number;
  min?: number;
  max?: number;
} {
  const numbers = values.filter((value): value is number => typeof value === 'number');
  if (numbers.length === 0) {
    return { count: 0 };
  }

  const sum = numbers.reduce((total, value) => total + value, 0);
  return {
    count: numbers.length,
    avg: roundMetric(sum / numbers.length),
    min: roundMetric(Math.min(...numbers)),
    max: roundMetric(Math.max(...numbers)),
  };
}

function buildTimingSummary(turnSummaries: TurnSummary[]) {
  const buildForTurns = (turns: TurnSummary[]) => {
    const metricSnapshots = turns.map((turn) => extractTimingSnapshot(turn.timing));
    const slowestTurn = turns.reduce<TurnSummary | null>((slowest, current) => {
      const currentTotal = readTimingMetric(current.timing, 'total') ?? -1;
      const slowestTotal = slowest ? (readTimingMetric(slowest.timing, 'total') ?? -1) : -1;
      return currentTotal > slowestTotal ? current : slowest;
    }, null);

    return {
      turnCount: turns.length,
      total: summarizeMetric(metricSnapshots.map((snapshot) => snapshot.total)),
      stt: summarizeMetric(metricSnapshots.map((snapshot) => snapshot.stt)),
      llm: summarizeMetric(metricSnapshots.map((snapshot) => snapshot.llm)),
      tts: summarizeMetric(metricSnapshots.map((snapshot) => snapshot.tts)),
      ttsFirstChunk: summarizeMetric(metricSnapshots.map((snapshot) => snapshot.ttsFirstChunk)),
      e2e: summarizeMetric(metricSnapshots.map((snapshot) => snapshot.e2e)),
      slowestTurn: slowestTurn
        ? {
            project: slowestTurn.projectLabel,
            turn: slowestTurn.turn,
            total: roundMetric(readTimingMetric(slowestTurn.timing, 'total')),
            utterance: slowestTurn.utterance,
            response: slowestTurn.response,
          }
        : null,
    };
  };

  const projectATurns = turnSummaries.filter((turn) => turn.projectLabel === 'Project A');
  const projectBTurns = turnSummaries.filter((turn) => turn.projectLabel === 'Project B');

  return {
    all: buildForTurns(turnSummaries),
    projectA: buildForTurns(projectATurns),
    projectB: buildForTurns(projectBTurns),
  };
}

function buildDelayAnalysis(turnSummaries: TurnSummary[]) {
  const timeline = [...turnSummaries]
    .sort((left, right) => {
      const leftTime = parseIsoTimestamp(left.timestamp) ?? Number.MAX_SAFE_INTEGER;
      const rightTime = parseIsoTimestamp(right.timestamp) ?? Number.MAX_SAFE_INTEGER;
      if (leftTime !== rightTime) {
        return leftTime - rightTime;
      }
      return left.projectLabel.localeCompare(right.projectLabel) || left.turn - right.turn;
    })
    .map((turnSummary) => {
      const timing = extractTimingSnapshot(turnSummary.timing);
      const total = timing.total;
      const gapFromPreviousConversationMs = turnSummary.gapFromPreviousConversationTurnMs;
      const outsideRuntimeGapMs =
        gapFromPreviousConversationMs != null && total != null
          ? Math.max(0, gapFromPreviousConversationMs - total)
          : undefined;

      return {
        project: turnSummary.projectLabel,
        turn: turnSummary.turn,
        timestamp: turnSummary.timestamp,
        offsetFromCallStartMs: roundMetric(turnSummary.offsetFromCallStartMs),
        gapFromPreviousConversationMs: roundMetric(gapFromPreviousConversationMs),
        gapFromPreviousProjectTurnMs: roundMetric(turnSummary.gapFromPreviousProjectTurnMs),
        totalMs: roundMetric(total),
        sttMs: roundMetric(timing.stt),
        llmMs: roundMetric(timing.llm),
        ttsMs: roundMetric(timing.tts),
        outsideRuntimeGapMs: roundMetric(outsideRuntimeGapMs),
        utterance: turnSummary.utterance,
        response: turnSummary.response,
      };
    });

  const slowestConversationGap = timeline.reduce<(typeof timeline)[number] | null>(
    (slowest, turn) => {
      const currentGap = turn.gapFromPreviousConversationMs ?? -1;
      const slowestGap = slowest?.gapFromPreviousConversationMs ?? -1;
      return currentGap > slowestGap ? turn : slowest;
    },
    null,
  );

  const largestOutsideRuntimeGap = timeline.reduce<(typeof timeline)[number] | null>(
    (slowest, turn) => {
      const currentGap = turn.outsideRuntimeGapMs ?? -1;
      const slowestGap = slowest?.outsideRuntimeGapMs ?? -1;
      return currentGap > slowestGap ? turn : slowest;
    },
    null,
  );

  return {
    timeline,
    slowestConversationGap,
    largestOutsideRuntimeGap,
  };
}

function logStructuredSummary(label: string, payload: unknown): void {
  console.log(`${label}\n${JSON.stringify(payload, null, 2)}`);
}

function assertTurnSummaryHealth(turnSummary: TurnSummary): void {
  expect(turnSummary.utterance.trim().length).toBeGreaterThan(0);
  expect(turnSummary.response.trim().length).toBeGreaterThan(0);

  const timing = extractTimingSnapshot(turnSummary.timing);
  expect(timing.total).toBeDefined();
  expect(timing.stt).toBeDefined();
  expect(timing.llm).toBeDefined();
  expect(timing.tts).toBeDefined();

  if (MAX_TOTAL_LATENCY_MS != null && timing.total != null) {
    expect(
      timing.total,
      `${turnSummary.projectLabel} turn ${turnSummary.turn} total latency ${timing.total}ms exceeded budget ${MAX_TOTAL_LATENCY_MS}ms`,
    ).toBeLessThanOrEqual(MAX_TOTAL_LATENCY_MS);
  }

  if (MAX_STT_LATENCY_MS != null && timing.stt != null) {
    expect(
      timing.stt,
      `${turnSummary.projectLabel} turn ${turnSummary.turn} STT latency ${timing.stt}ms exceeded budget ${MAX_STT_LATENCY_MS}ms`,
    ).toBeLessThanOrEqual(MAX_STT_LATENCY_MS);
  }

  if (MAX_LLM_LATENCY_MS != null && timing.llm != null) {
    expect(
      timing.llm,
      `${turnSummary.projectLabel} turn ${turnSummary.turn} LLM latency ${timing.llm}ms exceeded budget ${MAX_LLM_LATENCY_MS}ms`,
    ).toBeLessThanOrEqual(MAX_LLM_LATENCY_MS);
  }

  if (MAX_TTS_LATENCY_MS != null && timing.tts != null) {
    expect(
      timing.tts,
      `${turnSummary.projectLabel} turn ${turnSummary.turn} TTS latency ${timing.tts}ms exceeded budget ${MAX_TTS_LATENCY_MS}ms`,
    ).toBeLessThanOrEqual(MAX_TTS_LATENCY_MS);
  }

  if (MAX_E2E_LATENCY_MS != null && timing.e2e != null) {
    expect(
      timing.e2e,
      `${turnSummary.projectLabel} turn ${turnSummary.turn} E2E latency ${timing.e2e}ms exceeded budget ${MAX_E2E_LATENCY_MS}ms`,
    ).toBeLessThanOrEqual(MAX_E2E_LATENCY_MS);
  }
}

describe.skipIf(!!SKIP_REASON)('Voice Pipeline — Twilio Live Audio E2E', () => {
  if (!DUAL_CALL_MODE) {
    test(
      'places a real Twilio call into the pipeline and captures runtime voice traces',
      async () => {
        const token = await getRuntimeBearerToken();
        let callerPrompt = await generateCallerPrompt(token, CALLER_SEED_MESSAGE);
        const targetNumber = await resolvePipelineTargetNumber(
          token,
          PROJECT_ID,
          EXPLICIT_TO_NUMBER,
        );
        const callerNumber = await resolveCallerNumber(token, [targetNumber]);
        let playbackAudioUrl = await resolvePlaybackAudioUrl(callerPrompt.callerText);
        const callStartedAtMs = Date.now();
        let createdCall: TwilioCallRecord | null = null;

        try {
          createdCall = await placePlaybackCall(
            callerNumber,
            targetNumber,
            playbackAudioUrl,
            callerPrompt.callerText,
          );
          console.log('[Voice Twilio Live E2E] Call created', {
            callSid: createdCall.sid,
            fromNumber: callerNumber,
            toNumber: targetNumber,
            callerProjectId: CALLER_PROJECT_ID || undefined,
            callerProjectSessionId: callerPrompt.callerSessionId,
            callerText: callerPrompt.callerText,
            callerPromptMode: playbackAudioUrl ? 'play' : 'say',
            playbackAudioUrl,
            maxTurns: MAX_TURNS,
          });

          const sessionId = await findSessionIdByCallSid(
            token,
            PROJECT_ID,
            createdCall.sid,
            callStartedAtMs,
            callerPrompt.callerText,
          );
          console.log('[Voice Twilio Live E2E] Runtime session linked', {
            callSid: createdCall.sid,
            sessionId,
          });

          let latestSession: SessionDetailResponse['session'] | null = null;
          const turnSummaries: Array<{
            turn: number;
            callerText: string;
            utterance: string;
            response: string;
            timing: Record<string, unknown>;
            sttModel?: string;
          }> = [];

          for (let turnNumber = 1; turnNumber <= MAX_TURNS; turnNumber += 1) {
            const turnResult = await waitForVoiceTurn(token, PROJECT_ID, sessionId, turnNumber);
            latestSession = turnResult.session;
            turnSummaries.push({
              turn: turnNumber,
              callerText: callerPrompt.callerText,
              utterance: turnResult.turn.utterance,
              response: turnResult.turn.response,
              timing: turnResult.turn.timing,
              sttModel: turnResult.turn.sttModel,
            });
            console.log('[Voice Twilio Live E2E] Project B turn complete', {
              callSid: createdCall.sid,
              sessionId,
              turn: turnNumber,
              utterance: turnResult.turn.utterance,
              response: turnResult.turn.response,
              sttModel: turnResult.turn.sttModel,
              timing: {
                total: readNumberField(turnResult.turn.timing, 'total'),
                stt: readNumberField(turnResult.turn.timing, 'stt'),
                llm: readNumberField(turnResult.turn.timing, 'llm'),
                tts: readNumberField(turnResult.turn.timing, 'tts'),
                ttsFirstChunk: readNumberField(turnResult.turn.timing, 'ttsFirstChunk'),
                e2e: readNumberField(turnResult.turn.timing, 'e2e'),
              },
            });

            if (turnNumber === MAX_TURNS) {
              break;
            }

            const projectBReply =
              turnResult.turn.response || lastAssistantMessage(turnResult.session);
            callerPrompt = await generateCallerPrompt(
              token,
              buildCallerFollowUpMessage(projectBReply, turnNumber + 1),
              callerPrompt.callerSessionId,
            );
            playbackAudioUrl = await resolvePlaybackAudioUrl(callerPrompt.callerText);
            const updatedCall = await updatePlaybackCall(
              createdCall.sid,
              playbackAudioUrl,
              callerPrompt.callerText,
            );
            console.log('[Voice Twilio Live E2E] Injected next Project A turn', {
              callSid: createdCall.sid,
              sessionId,
              turn: turnNumber + 1,
              callerProjectSessionId: callerPrompt.callerSessionId,
              callerText: callerPrompt.callerText,
              updateStatus: updatedCall.status,
              playbackAudioUrl,
            });
          }

          await completeCall(createdCall.sid);
          const terminalCall = await waitForCallTerminal(createdCall.sid);
          const recordings = await waitForTwilioRecordings(createdCall.sid);

          expect(terminalCall.status).toBe('completed');
          expect(latestSession).toBeTruthy();

          const session = latestSession as SessionDetailResponse['session'];
          const callLinkedTrace = session.traceEvents.find(
            (event) => getTraceData(event).callSid === createdCall.sid,
          );
          const voiceTurn = lastTraceOfType(session, 'voice_turn');
          const voiceTts =
            lastTraceOfType(session, 'voice_tts') || lastTraceOfType(session, 'voice_tts_quality');

          expect(
            callLinkedTrace ||
              sessionMatchesCallerPrompt(session, turnSummaries[0]?.callerText || ''),
          ).toBeTruthy();
          expect(voiceTurn).toBeTruthy();
          expect(voiceTts).toBeTruthy();
          expect(getVoiceTurnSnapshots(session).length).toBeGreaterThanOrEqual(MAX_TURNS);

          const voiceTurnData = getTraceData(voiceTurn);
          const voiceTurnTiming =
            voiceTurnData.timing && typeof voiceTurnData.timing === 'object'
              ? (voiceTurnData.timing as Record<string, unknown>)
              : {};

          expect(
            session.messages.filter(
              (message) => message.role === 'user' && message.content.trim().length > 0,
            ).length,
          ).toBeGreaterThanOrEqual(MAX_TURNS);
          expect(
            session.messages.filter(
              (message) => message.role === 'assistant' && message.content.trim().length > 0,
            ).length,
          ).toBeGreaterThanOrEqual(MAX_TURNS);
          expect(readNumberField(voiceTurnTiming, 'total')).toBeTruthy();
          expect(readNumberField(voiceTurnTiming, 'stt')).not.toBeUndefined();
          expect(readNumberField(voiceTurnTiming, 'llm')).not.toBeUndefined();
          expect(readNumberField(voiceTurnTiming, 'tts')).not.toBeUndefined();
          turnSummaries.forEach(assertTurnSummaryHealth);

          const timingSummary = buildTimingSummary(
            turnSummaries.map((turnSummary) => ({
              ...turnSummary,
              projectLabel: 'Project B',
              projectId: PROJECT_ID,
              sessionId,
            })),
          );

          if (EXPECTED_TRANSCRIPT_FRAGMENT) {
            const allUtterances = turnSummaries
              .map((turnSummary) => turnSummary.utterance)
              .join('\n')
              .toLowerCase();
            expect(allUtterances).toContain(EXPECTED_TRANSCRIPT_FRAGMENT.toLowerCase());
          }

          if (EXPECTED_RESPONSE_FRAGMENT) {
            const assistantText = turnSummaries
              .map((turnSummary) => turnSummary.response)
              .join('\n')
              .toLowerCase();
            expect(assistantText).toContain(EXPECTED_RESPONSE_FRAGMENT.toLowerCase());
          }

          logStructuredSummary('[Voice Twilio Live E2E] Summary', {
            callSid: createdCall.sid,
            sessionId,
            fromNumber: callerNumber,
            toNumber: targetNumber,
            callerProjectId: CALLER_PROJECT_ID || undefined,
            callerProjectSessionId: callerPrompt.callerSessionId,
            callStatus: terminalCall.status,
            callDuration: terminalCall.duration,
            recordingEnabled: ENABLE_TWILIO_RECORDING,
            recordings,
            maxTurns: MAX_TURNS,
            latencyBudgets: {
              total: MAX_TOTAL_LATENCY_MS,
              stt: MAX_STT_LATENCY_MS,
              llm: MAX_LLM_LATENCY_MS,
              tts: MAX_TTS_LATENCY_MS,
              e2e: MAX_E2E_LATENCY_MS,
            },
            timingSummary,
            turns: turnSummaries.map((turnSummary) => ({
              turn: turnSummary.turn,
              callerText: turnSummary.callerText,
              utterance: turnSummary.utterance,
              response: turnSummary.response,
              sttModel: turnSummary.sttModel,
              timing: {
                total: readNumberField(turnSummary.timing, 'total'),
                stt: readNumberField(turnSummary.timing, 'stt'),
                llm: readNumberField(turnSummary.timing, 'llm'),
                tts: readNumberField(turnSummary.timing, 'tts'),
                ttsFirstChunk: readNumberField(turnSummary.timing, 'ttsFirstChunk'),
                e2e: readNumberField(turnSummary.timing, 'e2e'),
              },
            })),
          });
        } finally {
          if (createdCall) {
            const currentCall = await fetchTwilioCall(createdCall.sid).catch(() => null);
            if (
              currentCall &&
              !['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(currentCall.status)
            ) {
              await completeCall(createdCall.sid).catch(() => undefined);
            }
          }
        }
      },
      MAX_WAIT_MS + POST_CALL_GRACE_MS + 30_000,
    );
  }

  if (DUAL_CALL_MODE) {
    test(
      'bridges two real voice pipeline projects over paired Twilio calls',
      async () => {
        const token = await getRuntimeBearerToken();
        const projectATargetNumber = await resolvePipelineTargetNumber(
          token,
          CALLER_VOICE_PROJECT_ID,
          EXPLICIT_CALLER_TO_NUMBER,
        );
        const projectBTargetNumber = await resolvePipelineTargetNumber(
          token,
          PROJECT_ID,
          EXPLICIT_TO_NUMBER,
        );
        const callerNumber = await resolveCallerNumber(token, [
          projectATargetNumber,
          projectBTargetNumber,
        ]);

        const turnSummaries: TurnSummary[] = [];
        let projectACall: TwilioCallRecord | null = null;
        let projectBCall: TwilioCallRecord | null = null;

        try {
          if (TWILIO_BRIDGE_MODE === 'conference') {
            const conferenceName = `voice-e2e-${Date.now()}`;
            const projectBCallStartedAtMs = Date.now();
            projectBCall = await placeConferenceCall(
              callerNumber,
              projectBTargetNumber,
              conferenceName,
              {
                startConferenceOnEnter: true,
                endConferenceOnExit: true,
              },
            );
            console.log('[Voice Twilio Live E2E] Project B conference call created', {
              callSid: projectBCall.sid,
              fromNumber: callerNumber,
              toNumber: projectBTargetNumber,
              projectId: PROJECT_ID,
              conferenceName,
              bridgeMode: TWILIO_BRIDGE_MODE,
            });

            const projectBSessionId = await findSessionIdByCallSid(
              token,
              PROJECT_ID,
              projectBCall.sid,
              projectBCallStartedAtMs,
              DUAL_SEED_TEXT,
            );
            console.log('[Voice Twilio Live E2E] Project B runtime session linked', {
              callSid: projectBCall.sid,
              projectId: PROJECT_ID,
              sessionId: projectBSessionId,
            });

            const projectACallStartedAtMs = Date.now();
            projectACall = await placeConferenceCall(
              callerNumber,
              projectATargetNumber,
              conferenceName,
              {
                startConferenceOnEnter: true,
                endConferenceOnExit: true,
              },
            );
            console.log('[Voice Twilio Live E2E] Project A conference call created', {
              callSid: projectACall.sid,
              fromNumber: callerNumber,
              toNumber: projectATargetNumber,
              projectId: CALLER_VOICE_PROJECT_ID,
              conferenceName,
              bridgeMode: TWILIO_BRIDGE_MODE,
            });

            const projectASessionId = await findSessionIdByCallSid(
              token,
              CALLER_VOICE_PROJECT_ID,
              projectACall.sid,
              projectACallStartedAtMs,
              DUAL_SEED_TEXT,
            );
            console.log('[Voice Twilio Live E2E] Project A runtime session linked', {
              callSid: projectACall.sid,
              projectId: CALLER_VOICE_PROJECT_ID,
              sessionId: projectASessionId,
            });

            const conversationResult = await waitForConferenceConversation(
              token,
              projectASessionId,
              projectBSessionId,
              {
                projectAStartedAtMs: projectACallStartedAtMs,
                projectBStartedAtMs: projectBCallStartedAtMs,
              },
            );

            const latestProjectASession = conversationResult.projectASession;
            const latestProjectBSession = conversationResult.projectBSession;
            const turnSummaries = conversationResult.turnSummaries;
            const completionReason = conversationResult.completionReason;

            await Promise.all([completeCall(projectACall.sid), completeCall(projectBCall.sid)]);

            const [projectACallTerminal, projectBCallTerminal] = await Promise.all([
              waitForCallTerminal(projectACall.sid),
              waitForCallTerminal(projectBCall.sid),
            ]);
            const [projectARecordings, projectBRecordings] = await Promise.all([
              waitForTwilioRecordings(projectACall.sid),
              waitForTwilioRecordings(projectBCall.sid),
            ]);

            expect(projectACallTerminal.status).toBe('completed');
            expect(projectBCallTerminal.status).toBe('completed');

            const projectATurns = turnSummaries.filter(
              (turnSummary) => turnSummary.projectLabel === 'Project A',
            );
            const projectBTurns = turnSummaries.filter(
              (turnSummary) => turnSummary.projectLabel === 'Project B',
            );

            expect(projectATurns.length).toBeGreaterThan(0);
            expect(projectBTurns.length).toBeGreaterThan(0);
            expect(turnSummaries.length).toBeGreaterThanOrEqual(MIN_CONFERENCE_TURNS);
            turnSummaries.forEach(assertTurnSummaryHealth);

            const timingSummary = buildTimingSummary(turnSummaries);
            const delayAnalysis = buildDelayAnalysis(turnSummaries);

            logStructuredSummary('[Voice Twilio Live E2E] Dual voice conference summary', {
              bridgeMode: TWILIO_BRIDGE_MODE,
              conferenceName,
              projectACallSid: projectACall.sid,
              projectASessionId,
              projectAProjectId: CALLER_VOICE_PROJECT_ID,
              projectANumber: projectATargetNumber,
              projectACallStatus: projectACallTerminal.status,
              projectACallDuration: projectACallTerminal.duration,
              projectARecordings,
              projectBCallSid: projectBCall.sid,
              projectBSessionId,
              projectBProjectId: PROJECT_ID,
              projectBNumber: projectBTargetNumber,
              projectBCallStatus: projectBCallTerminal.status,
              projectBCallDuration: projectBCallTerminal.duration,
              projectBRecordings,
              recordingEnabled: ENABLE_TWILIO_RECORDING,
              hardMaxTurns: MAX_TURNS,
              minConferenceTurns: MIN_CONFERENCE_TURNS,
              requireConferenceCompletion: REQUIRE_CONFERENCE_COMPLETION,
              completionReason,
              latencyBudgets: {
                total: MAX_TOTAL_LATENCY_MS,
                stt: MAX_STT_LATENCY_MS,
                llm: MAX_LLM_LATENCY_MS,
                tts: MAX_TTS_LATENCY_MS,
                e2e: MAX_E2E_LATENCY_MS,
              },
              timingSummary,
              delayAnalysis,
              turns: turnSummaries.map((turnSummary) => ({
                project: turnSummary.projectLabel,
                turn: turnSummary.turn,
                timestamp: turnSummary.timestamp,
                offsetFromCallStartMs: roundMetric(turnSummary.offsetFromCallStartMs),
                gapFromPreviousConversationMs: roundMetric(
                  turnSummary.gapFromPreviousConversationTurnMs,
                ),
                gapFromPreviousProjectTurnMs: roundMetric(turnSummary.gapFromPreviousProjectTurnMs),
                callerText: turnSummary.callerText,
                utterance: turnSummary.utterance,
                response: turnSummary.response,
                sttModel: turnSummary.sttModel,
                timing: {
                  total: readNumberField(turnSummary.timing, 'total'),
                  stt: readNumberField(turnSummary.timing, 'stt'),
                  llm: readNumberField(turnSummary.timing, 'llm'),
                  tts: readNumberField(turnSummary.timing, 'tts'),
                  ttsFirstChunk: readNumberField(turnSummary.timing, 'ttsFirstChunk'),
                  e2e: readNumberField(turnSummary.timing, 'e2e'),
                },
              })),
            });

            return;
          }

          const seedPlaybackText = DUAL_SEED_TEXT;
          const seedAudioUrl = await resolvePlaybackAudioUrl(seedPlaybackText);
          const projectACallStartedAtMs = Date.now();
          projectACall = await placePlaybackCall(
            callerNumber,
            projectATargetNumber,
            seedAudioUrl,
            seedPlaybackText,
          );
          console.log('[Voice Twilio Live E2E] Project A voice call created', {
            callSid: projectACall.sid,
            fromNumber: callerNumber,
            toNumber: projectATargetNumber,
            projectId: CALLER_VOICE_PROJECT_ID,
            seedPlaybackText,
            playbackAudioUrl: seedAudioUrl,
            maxTurns: MAX_TURNS,
          });

          const projectASessionId = await findSessionIdByCallSid(
            token,
            CALLER_VOICE_PROJECT_ID,
            projectACall.sid,
            projectACallStartedAtMs,
            seedPlaybackText,
          );
          console.log('[Voice Twilio Live E2E] Project A runtime session linked', {
            callSid: projectACall.sid,
            projectId: CALLER_VOICE_PROJECT_ID,
            sessionId: projectASessionId,
          });

          let projectATurnResult = await waitForVoiceTurn(
            token,
            CALLER_VOICE_PROJECT_ID,
            projectASessionId,
            1,
          );
          turnSummaries.push({
            projectLabel: 'Project A',
            projectId: CALLER_VOICE_PROJECT_ID,
            sessionId: projectASessionId,
            turn: 1,
            callerText: seedPlaybackText,
            utterance: projectATurnResult.turn.utterance,
            response: projectATurnResult.turn.response,
            timing: projectATurnResult.turn.timing,
            sttModel: projectATurnResult.turn.sttModel,
          });
          console.log('[Voice Twilio Live E2E] Project A turn complete', {
            callSid: projectACall.sid,
            sessionId: projectASessionId,
            turn: 1,
            utterance: projectATurnResult.turn.utterance,
            response: projectATurnResult.turn.response,
            sttModel: projectATurnResult.turn.sttModel,
            timing: {
              total: readNumberField(projectATurnResult.turn.timing, 'total'),
              stt: readNumberField(projectATurnResult.turn.timing, 'stt'),
              llm: readNumberField(projectATurnResult.turn.timing, 'llm'),
              tts: readNumberField(projectATurnResult.turn.timing, 'tts'),
              ttsFirstChunk: readNumberField(projectATurnResult.turn.timing, 'ttsFirstChunk'),
              e2e: readNumberField(projectATurnResult.turn.timing, 'e2e'),
            },
          });

          let projectATurnCount = 1;
          let projectBTurnCount = 0;
          let projectBSessionId = '';
          let latestProjectASession = projectATurnResult.session;
          let latestProjectBSession: SessionDetailResponse['session'] | null = null;

          while (turnSummaries.length < MAX_TURNS) {
            const projectATextForPlayback = toSpokenText(
              projectATurnResult.turn.response || lastAssistantMessage(projectATurnResult.session),
              DUAL_SEED_TEXT,
            );

            if (!projectBCall) {
              const projectBAudioUrl = await resolvePlaybackAudioUrl(projectATextForPlayback);
              const projectBCallStartedAtMs = Date.now();
              projectBCall = await placePlaybackCall(
                callerNumber,
                projectBTargetNumber,
                projectBAudioUrl,
                projectATextForPlayback,
              );
              console.log('[Voice Twilio Live E2E] Project B voice call created', {
                callSid: projectBCall.sid,
                fromNumber: callerNumber,
                toNumber: projectBTargetNumber,
                projectId: PROJECT_ID,
                callerText: projectATextForPlayback,
                playbackAudioUrl: projectBAudioUrl,
              });

              projectBSessionId = await findSessionIdByCallSid(
                token,
                PROJECT_ID,
                projectBCall.sid,
                projectBCallStartedAtMs,
                projectATextForPlayback,
              );
              console.log('[Voice Twilio Live E2E] Project B runtime session linked', {
                callSid: projectBCall.sid,
                projectId: PROJECT_ID,
                sessionId: projectBSessionId,
              });
            } else {
              const projectBAudioUrl = await resolvePlaybackAudioUrl(projectATextForPlayback);
              const updatedCall = await updatePlaybackCall(
                projectBCall.sid,
                projectBAudioUrl,
                projectATextForPlayback,
              );
              console.log('[Voice Twilio Live E2E] Relayed Project A response into Project B', {
                callSid: projectBCall.sid,
                sessionId: projectBSessionId,
                nextTurn: projectBTurnCount + 1,
                callerText: projectATextForPlayback,
                updateStatus: updatedCall.status,
                playbackAudioUrl: projectBAudioUrl,
              });
            }

            if (!projectBCall) {
              throw new Error('Project B call was not created before waiting for Project B turn');
            }

            projectBTurnCount += 1;
            const projectBTurnResult = await waitForVoiceTurn(
              token,
              PROJECT_ID,
              projectBSessionId,
              projectBTurnCount,
            );
            latestProjectBSession = projectBTurnResult.session;
            turnSummaries.push({
              projectLabel: 'Project B',
              projectId: PROJECT_ID,
              sessionId: projectBSessionId,
              turn: projectBTurnCount,
              callerText: projectATextForPlayback,
              utterance: projectBTurnResult.turn.utterance,
              response: projectBTurnResult.turn.response,
              timing: projectBTurnResult.turn.timing,
              sttModel: projectBTurnResult.turn.sttModel,
            });
            console.log('[Voice Twilio Live E2E] Project B turn complete', {
              callSid: projectBCall.sid,
              sessionId: projectBSessionId,
              turn: projectBTurnCount,
              utterance: projectBTurnResult.turn.utterance,
              response: projectBTurnResult.turn.response,
              sttModel: projectBTurnResult.turn.sttModel,
              timing: {
                total: readNumberField(projectBTurnResult.turn.timing, 'total'),
                stt: readNumberField(projectBTurnResult.turn.timing, 'stt'),
                llm: readNumberField(projectBTurnResult.turn.timing, 'llm'),
                tts: readNumberField(projectBTurnResult.turn.timing, 'tts'),
                ttsFirstChunk: readNumberField(projectBTurnResult.turn.timing, 'ttsFirstChunk'),
                e2e: readNumberField(projectBTurnResult.turn.timing, 'e2e'),
              },
            });

            if (turnSummaries.length >= MAX_TURNS) {
              break;
            }

            const projectBTextForPlayback = toSpokenText(
              projectBTurnResult.turn.response || lastAssistantMessage(projectBTurnResult.session),
              FALLBACK_CALLER_TEXT,
            );
            const projectAAudioUrl = await resolvePlaybackAudioUrl(projectBTextForPlayback);
            const updatedProjectACall = await updatePlaybackCall(
              projectACall.sid,
              projectAAudioUrl,
              projectBTextForPlayback,
            );
            console.log('[Voice Twilio Live E2E] Relayed Project B response into Project A', {
              callSid: projectACall.sid,
              sessionId: projectASessionId,
              nextTurn: projectATurnCount + 1,
              callerText: projectBTextForPlayback,
              updateStatus: updatedProjectACall.status,
              playbackAudioUrl: projectAAudioUrl,
            });

            projectATurnCount += 1;
            projectATurnResult = await waitForVoiceTurn(
              token,
              CALLER_VOICE_PROJECT_ID,
              projectASessionId,
              projectATurnCount,
            );
            latestProjectASession = projectATurnResult.session;
            turnSummaries.push({
              projectLabel: 'Project A',
              projectId: CALLER_VOICE_PROJECT_ID,
              sessionId: projectASessionId,
              turn: projectATurnCount,
              callerText: projectBTextForPlayback,
              utterance: projectATurnResult.turn.utterance,
              response: projectATurnResult.turn.response,
              timing: projectATurnResult.turn.timing,
              sttModel: projectATurnResult.turn.sttModel,
            });
            console.log('[Voice Twilio Live E2E] Project A turn complete', {
              callSid: projectACall.sid,
              sessionId: projectASessionId,
              turn: projectATurnCount,
              utterance: projectATurnResult.turn.utterance,
              response: projectATurnResult.turn.response,
              sttModel: projectATurnResult.turn.sttModel,
              timing: {
                total: readNumberField(projectATurnResult.turn.timing, 'total'),
                stt: readNumberField(projectATurnResult.turn.timing, 'stt'),
                llm: readNumberField(projectATurnResult.turn.timing, 'llm'),
                tts: readNumberField(projectATurnResult.turn.timing, 'tts'),
                ttsFirstChunk: readNumberField(projectATurnResult.turn.timing, 'ttsFirstChunk'),
                e2e: readNumberField(projectATurnResult.turn.timing, 'e2e'),
              },
            });
          }

          await Promise.all([
            completeCall(projectACall.sid),
            projectBCall ? completeCall(projectBCall.sid) : Promise.resolve(null),
          ]);

          const [projectACallTerminal, projectBCallTerminal] = await Promise.all([
            waitForCallTerminal(projectACall.sid),
            projectBCall ? waitForCallTerminal(projectBCall.sid) : Promise.resolve(null),
          ]);
          const [projectARecordings, projectBRecordings] = await Promise.all([
            waitForTwilioRecordings(projectACall.sid),
            projectBCall ? waitForTwilioRecordings(projectBCall.sid) : Promise.resolve([]),
          ]);

          expect(projectACallTerminal.status).toBe('completed');
          expect(projectBCallTerminal?.status).toBe('completed');
          expect(latestProjectASession).toBeTruthy();
          expect(latestProjectBSession).toBeTruthy();

          const projectATurns = turnSummaries.filter(
            (turnSummary) => turnSummary.projectLabel === 'Project A',
          );
          const projectBTurns = turnSummaries.filter(
            (turnSummary) => turnSummary.projectLabel === 'Project B',
          );

          expect(projectATurns.length).toBeGreaterThan(0);
          expect(projectBTurns.length).toBeGreaterThan(0);
          expect(turnSummaries.length).toBeGreaterThanOrEqual(MAX_TURNS);
          turnSummaries.forEach(assertTurnSummaryHealth);

          expect(getVoiceTurnSnapshots(latestProjectASession).length).toBeGreaterThanOrEqual(
            projectATurnCount,
          );
          expect(
            getVoiceTurnSnapshots(latestProjectBSession as SessionDetailResponse['session']).length,
          ).toBeGreaterThanOrEqual(projectBTurnCount);

          const timingSummary = buildTimingSummary(turnSummaries);

          logStructuredSummary('[Voice Twilio Live E2E] Dual voice bridge summary', {
            projectACallSid: projectACall.sid,
            projectASessionId,
            projectAProjectId: CALLER_VOICE_PROJECT_ID,
            projectANumber: projectATargetNumber,
            projectACallStatus: projectACallTerminal.status,
            projectACallDuration: projectACallTerminal.duration,
            projectARecordings,
            projectBCallSid: projectBCall?.sid,
            projectBSessionId,
            projectBProjectId: PROJECT_ID,
            projectBNumber: projectBTargetNumber,
            projectBCallStatus: projectBCallTerminal?.status,
            projectBCallDuration: projectBCallTerminal?.duration,
            projectBRecordings,
            recordingEnabled: ENABLE_TWILIO_RECORDING,
            maxTurns: MAX_TURNS,
            latencyBudgets: {
              total: MAX_TOTAL_LATENCY_MS,
              stt: MAX_STT_LATENCY_MS,
              llm: MAX_LLM_LATENCY_MS,
              tts: MAX_TTS_LATENCY_MS,
              e2e: MAX_E2E_LATENCY_MS,
            },
            timingSummary,
            turns: turnSummaries.map((turnSummary) => ({
              project: turnSummary.projectLabel,
              turn: turnSummary.turn,
              callerText: turnSummary.callerText,
              utterance: turnSummary.utterance,
              response: turnSummary.response,
              sttModel: turnSummary.sttModel,
              timing: {
                total: readNumberField(turnSummary.timing, 'total'),
                stt: readNumberField(turnSummary.timing, 'stt'),
                llm: readNumberField(turnSummary.timing, 'llm'),
                tts: readNumberField(turnSummary.timing, 'tts'),
                ttsFirstChunk: readNumberField(turnSummary.timing, 'ttsFirstChunk'),
                e2e: readNumberField(turnSummary.timing, 'e2e'),
              },
            })),
          });
        } finally {
          const calls = [projectACall, projectBCall].filter((call): call is TwilioCallRecord =>
            Boolean(call),
          );

          for (const call of calls) {
            const currentCall = await fetchTwilioCall(call.sid).catch(() => null);
            if (
              currentCall &&
              !['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(currentCall.status)
            ) {
              await completeCall(call.sid).catch(() => undefined);
            }
          }
        }
      },
      MAX_WAIT_MS * 2 + POST_CALL_GRACE_MS + 60_000,
    );
  }
});

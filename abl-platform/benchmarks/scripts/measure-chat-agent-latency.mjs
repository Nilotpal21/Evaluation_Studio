import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
const outputPath = path.resolve(
  repoRoot,
  'benchmarks/config/theoretical-math/local-chat-agent-latency-breakdown.json',
);

const config = {
  studioUrl: process.env.STUDIO_URL || 'http://localhost:5173',
  runtimeUrl: process.env.RUNTIME_URL || 'http://localhost:3112',
  tenantId: process.env.TENANT_ID || 'tenant-dev-001',
  projectName: process.env.PROJECT_NAME || 'chat-agent-qps-baseline',
  projectId: process.env.PROJECT_ID || '019d9005-af19-7f21-9bca-2df019e8ff97',
  agentName: process.env.AGENT_NAME || 'benchmark_agent',
  modelId: process.env.MODEL_ID || 'mock-model',
  credentialName: process.env.CREDENTIAL_NAME || 'bench-mock-cred',
  devLoginEmail: process.env.DEV_LOGIN_EMAIL || 'bench@loadtest.internal',
  loadTestKey: process.env.LOAD_TEST_KEY || 'benchmark-bypass',
  followUpTurns: Number(process.env.FOLLOW_UP_TURNS || '15'),
  postResponseDrainMs: Number(process.env.POST_RESPONSE_DRAIN_MS || '1500'),
  interRequestPauseMs: Number(process.env.INTER_REQUEST_PAUSE_MS || '200'),
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function average(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sum(values) {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0);
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function round(value, digits = 2) {
  if (value == null || Number.isNaN(value)) return null;
  return Number(value.toFixed(digits));
}

async function login() {
  const response = await fetch(`${config.studioUrl}/api/auth/dev-login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: config.devLoginEmail,
    }),
  });

  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }

  if (!response.ok || !body?.accessToken) {
    throw new Error(
      `Dev login failed (${response.status}): ${text.slice(0, 500) || 'empty response'}`,
    );
  }

  return body.accessToken;
}

async function readTraceEvents({ token, sessionId, seenTraceIds }) {
  const traceUrl = `${config.runtimeUrl}/api/projects/${config.projectId}/sessions/${sessionId}?includeTraces=true`;
  const response = await fetch(traceUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  const text = await response.text();

  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }

  if (!response.ok || !body?.success || !body?.session) {
    throw new Error(
      `Failed to fetch session detail for ${sessionId} (${response.status}): ${text.slice(0, 500) || 'empty response'}`,
    );
  }

  const traceEvents = Array.isArray(body.session.traceEvents) ? body.session.traceEvents : [];
  const newEvents = [];

  for (const traceEvent of traceEvents) {
    if (!traceEvent || typeof traceEvent !== 'object' || typeof traceEvent.id !== 'string') {
      continue;
    }

    if (seenTraceIds.has(traceEvent.id)) {
      continue;
    }

    seenTraceIds.add(traceEvent.id);
    const timestampMs = Date.parse(traceEvent.timestamp);
    newEvents.push({
      streamId: traceEvent.id,
      payload: traceEvent,
      timestampMs: Number.isFinite(timestampMs) ? timestampMs : null,
    });
  }

  return {
    traceUrl,
    totalTraceCount: traceEvents.length,
    events: newEvents,
  };
}

function countBy(items, keySelector) {
  return items.reduce((acc, item) => {
    const key = keySelector(item);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function summarizeDurations(events) {
  const summary = {};

  for (const event of events) {
    const data = event.payload?.data || {};
    const durationMs =
      typeof data.durationMs === 'number'
        ? data.durationMs
        : typeof data.latencyMs === 'number'
          ? data.latencyMs
          : null;

    if (durationMs == null) {
      continue;
    }

    if (!summary[event.payload.type]) {
      summary[event.payload.type] = {
        count: 0,
        totalMs: 0,
        maxMs: 0,
        averageMs: 0,
      };
    }

    const bucket = summary[event.payload.type];
    bucket.count += 1;
    bucket.totalMs += durationMs;
    bucket.maxMs = Math.max(bucket.maxMs, durationMs);
  }

  for (const bucket of Object.values(summary)) {
    bucket.totalMs = round(bucket.totalMs);
    bucket.maxMs = round(bucket.maxMs);
    bucket.averageMs = round(bucket.totalMs / bucket.count);
  }

  return summary;
}

function pickFirstEvent(events, type) {
  return events.find((event) => event.payload.type === type) || null;
}

function pickTerminalExecutionEvent(events) {
  return (
    events.find((event) =>
      ['execution.completed', 'execution.failed', 'execution.cancelled'].includes(
        event.payload.type,
      ),
    ) || null
  );
}

function extractLlmCalls(events) {
  return events
    .filter((event) => event.payload.type === 'llm_call')
    .map((event) => {
      const data = event.payload.data || {};
      const durationMs =
        typeof data.durationMs === 'number'
          ? data.durationMs
          : typeof data.latencyMs === 'number'
            ? data.latencyMs
            : null;
      return {
        timestamp: event.payload.timestamp,
        relativeToRequestStartMs: round(event.timestampMs - event.requestStartMs),
        model: typeof data.model === 'string' ? data.model : null,
        provider: typeof data.provider === 'string' ? data.provider : null,
        durationMs: durationMs == null ? null : round(durationMs),
        tokensIn: typeof data.tokensIn === 'number' ? data.tokensIn : null,
        tokensOut: typeof data.tokensOut === 'number' ? data.tokensOut : null,
        cost: typeof data.cost === 'number' ? data.cost : null,
      };
    });
}

function buildTurnRecord({
  turnNumber,
  turnKind,
  requestStartMs,
  requestEndMs,
  requestBody,
  responseStatus,
  responseBody,
  streamKey,
  streamEvents,
  totalTraceCount,
  previousStreamId,
}) {
  const events = streamEvents.map((event) => ({
    ...event,
    requestStartMs,
  }));

  const firstTrace = events[0] || null;
  const lastTrace = events.at(-1) || null;
  const userMessage = pickFirstEvent(events, 'user_message');
  const agentEnter = pickFirstEvent(events, 'agent_enter');
  const statusUpdate = pickFirstEvent(events, 'status_update');
  const llmCall = pickFirstEvent(events, 'llm_call');
  const agentExit = pickFirstEvent(events, 'agent_exit');
  const executionQueued = pickFirstEvent(events, 'execution.queued');
  const executionStarted = pickFirstEvent(events, 'execution.started');
  const executionTerminal = pickTerminalExecutionEvent(events);
  const llmCalls = extractLlmCalls(events);
  const llmDurationMs =
    typeof llmCall?.payload?.data?.durationMs === 'number'
      ? llmCall.payload.data.durationMs
      : typeof llmCall?.payload?.data?.latencyMs === 'number'
        ? llmCall.payload.data.latencyMs
        : null;
  const estimatedLlmStartMs =
    llmCall?.timestampMs == null || llmDurationMs == null
      ? null
      : llmCall.timestampMs - llmDurationMs;
  const agentReportedDurationMs =
    typeof agentExit?.payload?.data?.durationMs === 'number'
      ? agentExit.payload.data.durationMs
      : null;

  const eventTimeline = events.map((event) => {
    const data = event.payload?.data || {};
    const durationMs =
      typeof data.durationMs === 'number'
        ? data.durationMs
        : typeof data.latencyMs === 'number'
          ? data.latencyMs
          : null;

    return {
      streamId: event.streamId,
      traceEventId: event.payload.id,
      type: event.payload.type,
      timestamp: event.payload.timestamp,
      relativeToRequestStartMs:
        event.timestampMs == null ? null : round(event.timestampMs - requestStartMs),
      durationMs: durationMs == null ? null : round(durationMs),
      data,
    };
  });

  const eventTypeCounts = countBy(events, (event) => event.payload.type);
  const durationSummaryByType = summarizeDurations(events);

  const phaseBreakdown = {
    clientRequestMs: round(requestEndMs - requestStartMs),
    traceStartDelayMs:
      firstTrace?.timestampMs == null ? null : round(firstTrace.timestampMs - requestStartMs),
    userMessageDelayMs:
      userMessage?.timestampMs == null ? null : round(userMessage.timestampMs - requestStartMs),
    agentEnterDelayMs:
      agentEnter?.timestampMs == null ? null : round(agentEnter.timestampMs - requestStartMs),
    preLlmPlatformMs:
      estimatedLlmStartMs == null ? null : round(estimatedLlmStartMs - requestStartMs),
    llmDurationMs: llmDurationMs == null ? null : round(llmDurationMs),
    statusUpdateDelayMs:
      statusUpdate?.timestampMs == null ? null : round(statusUpdate.timestampMs - requestStartMs),
    statusToLlmGapMs:
      statusUpdate?.timestampMs == null || llmCall?.timestampMs == null
        ? null
        : round(llmCall.timestampMs - statusUpdate.timestampMs),
    postLlmResponseTailMs:
      llmCall?.timestampMs == null ? null : round(requestEndMs - llmCall.timestampMs),
    agentObservedWindowMs:
      agentEnter?.timestampMs == null || agentExit?.timestampMs == null
        ? null
        : round(agentExit.timestampMs - agentEnter.timestampMs),
    agentReportedDurationMs:
      agentReportedDurationMs == null ? null : round(agentReportedDurationMs),
    responseTailAfterAgentExitMs:
      agentExit?.timestampMs == null ? null : round(requestEndMs - agentExit.timestampMs),
    estimatedPlatformOverheadMs:
      llmDurationMs == null ? null : round(requestEndMs - requestStartMs - llmDurationMs),
    preExecutionLeadInMs:
      executionQueued?.timestampMs == null
        ? null
        : round(executionQueued.timestampMs - requestStartMs),
    queueWaitMs:
      executionQueued?.timestampMs == null || executionStarted?.timestampMs == null
        ? null
        : round(executionStarted.timestampMs - executionQueued.timestampMs),
    executionRunMs:
      executionTerminal?.payload?.data?.durationMs != null
        ? round(executionTerminal.payload.data.durationMs)
        : executionStarted?.timestampMs == null || executionTerminal?.timestampMs == null
          ? null
          : round(executionTerminal.timestampMs - executionStarted.timestampMs),
    responseTailAfterExecutionMs:
      executionTerminal?.timestampMs == null
        ? null
        : round(requestEndMs - executionTerminal.timestampMs),
    traceTailAfterResponseMs:
      lastTrace?.timestampMs == null ? null : round(lastTrace.timestampMs - requestEndMs),
    traceCoverageMs:
      firstTrace?.timestampMs == null || lastTrace?.timestampMs == null
        ? null
        : round(lastTrace.timestampMs - firstTrace.timestampMs),
  };

  return {
    turnNumber,
    turnKind,
    request: {
      startedAt: new Date(requestStartMs).toISOString(),
      endedAt: new Date(requestEndMs).toISOString(),
      durationMs: round(requestEndMs - requestStartMs),
      status: responseStatus,
      sessionId: typeof responseBody?.sessionId === 'string' ? responseBody.sessionId : null,
      responseLength:
        typeof responseBody?.response === 'string' ? responseBody.response.length : null,
      inlineTraceEventCount: Array.isArray(responseBody?.traceEvents)
        ? responseBody.traceEvents.length
        : 0,
      requestBody,
    },
    phaseBreakdown,
    trace: {
      streamKey,
      totalTraceCount,
      previousStreamId: previousStreamId || null,
      lastStreamId: lastTrace?.streamId || previousStreamId || null,
      eventCount: events.length,
      firstTraceAt: firstTrace?.payload.timestamp || null,
      lastTraceAt: lastTrace?.payload.timestamp || null,
      eventTypeCounts,
      durationSummaryByType,
      llmCallSummary: {
        count: llmCalls.length,
        totalLatencyMs: round(sum(llmCalls.map((call) => call.durationMs || 0))),
        averageLatencyMs: round(
          average(llmCalls.map((call) => call.durationMs).filter((value) => value != null)),
        ),
        models: [...new Set(llmCalls.map((call) => call.model).filter(Boolean))],
        providers: [...new Set(llmCalls.map((call) => call.provider).filter(Boolean))],
      },
      executionMarkers: {
        queued: executionQueued
          ? {
              timestamp: executionQueued.payload.timestamp,
              relativeToRequestStartMs: round(executionQueued.timestampMs - requestStartMs),
              queuePosition:
                typeof executionQueued.payload.data?.queuePosition === 'number'
                  ? executionQueued.payload.data.queuePosition
                  : null,
              estimatedWaitMs:
                typeof executionQueued.payload.data?.estimatedWaitMs === 'number'
                  ? executionQueued.payload.data.estimatedWaitMs
                  : null,
            }
          : null,
        started: executionStarted
          ? {
              timestamp: executionStarted.payload.timestamp,
              relativeToRequestStartMs: round(executionStarted.timestampMs - requestStartMs),
            }
          : null,
        terminal: executionTerminal
          ? {
              type: executionTerminal.payload.type,
              timestamp: executionTerminal.payload.timestamp,
              relativeToRequestStartMs: round(executionTerminal.timestampMs - requestStartMs),
              durationMs:
                typeof executionTerminal.payload.data?.durationMs === 'number'
                  ? round(executionTerminal.payload.data.durationMs)
                  : null,
            }
          : null,
      },
      llmCalls,
      eventTimeline,
    },
  };
}

function summarizeTurns(turns) {
  const metrics = {
    clientRequestMs: [],
    traceStartDelayMs: [],
    userMessageDelayMs: [],
    agentEnterDelayMs: [],
    preLlmPlatformMs: [],
    llmDurationMs: [],
    statusUpdateDelayMs: [],
    statusToLlmGapMs: [],
    postLlmResponseTailMs: [],
    agentObservedWindowMs: [],
    agentReportedDurationMs: [],
    responseTailAfterAgentExitMs: [],
    estimatedPlatformOverheadMs: [],
    preExecutionLeadInMs: [],
    queueWaitMs: [],
    executionRunMs: [],
    responseTailAfterExecutionMs: [],
    traceTailAfterResponseMs: [],
    traceCoverageMs: [],
    eventCount: [],
    llmLatencyMs: [],
  };

  for (const turn of turns) {
    metrics.clientRequestMs.push(turn.phaseBreakdown.clientRequestMs);
    metrics.eventCount.push(turn.trace.eventCount);
    if (turn.phaseBreakdown.traceStartDelayMs != null) {
      metrics.traceStartDelayMs.push(turn.phaseBreakdown.traceStartDelayMs);
    }
    if (turn.phaseBreakdown.userMessageDelayMs != null) {
      metrics.userMessageDelayMs.push(turn.phaseBreakdown.userMessageDelayMs);
    }
    if (turn.phaseBreakdown.agentEnterDelayMs != null) {
      metrics.agentEnterDelayMs.push(turn.phaseBreakdown.agentEnterDelayMs);
    }
    if (turn.phaseBreakdown.preLlmPlatformMs != null) {
      metrics.preLlmPlatformMs.push(turn.phaseBreakdown.preLlmPlatformMs);
    }
    if (turn.phaseBreakdown.llmDurationMs != null) {
      metrics.llmDurationMs.push(turn.phaseBreakdown.llmDurationMs);
    }
    if (turn.phaseBreakdown.statusUpdateDelayMs != null) {
      metrics.statusUpdateDelayMs.push(turn.phaseBreakdown.statusUpdateDelayMs);
    }
    if (turn.phaseBreakdown.statusToLlmGapMs != null) {
      metrics.statusToLlmGapMs.push(turn.phaseBreakdown.statusToLlmGapMs);
    }
    if (turn.phaseBreakdown.postLlmResponseTailMs != null) {
      metrics.postLlmResponseTailMs.push(turn.phaseBreakdown.postLlmResponseTailMs);
    }
    if (turn.phaseBreakdown.agentObservedWindowMs != null) {
      metrics.agentObservedWindowMs.push(turn.phaseBreakdown.agentObservedWindowMs);
    }
    if (turn.phaseBreakdown.agentReportedDurationMs != null) {
      metrics.agentReportedDurationMs.push(turn.phaseBreakdown.agentReportedDurationMs);
    }
    if (turn.phaseBreakdown.responseTailAfterAgentExitMs != null) {
      metrics.responseTailAfterAgentExitMs.push(turn.phaseBreakdown.responseTailAfterAgentExitMs);
    }
    if (turn.phaseBreakdown.estimatedPlatformOverheadMs != null) {
      metrics.estimatedPlatformOverheadMs.push(turn.phaseBreakdown.estimatedPlatformOverheadMs);
    }
    if (turn.phaseBreakdown.preExecutionLeadInMs != null) {
      metrics.preExecutionLeadInMs.push(turn.phaseBreakdown.preExecutionLeadInMs);
    }
    if (turn.phaseBreakdown.queueWaitMs != null) {
      metrics.queueWaitMs.push(turn.phaseBreakdown.queueWaitMs);
    }
    if (turn.phaseBreakdown.executionRunMs != null) {
      metrics.executionRunMs.push(turn.phaseBreakdown.executionRunMs);
    }
    if (turn.phaseBreakdown.responseTailAfterExecutionMs != null) {
      metrics.responseTailAfterExecutionMs.push(turn.phaseBreakdown.responseTailAfterExecutionMs);
    }
    if (turn.phaseBreakdown.traceTailAfterResponseMs != null) {
      metrics.traceTailAfterResponseMs.push(turn.phaseBreakdown.traceTailAfterResponseMs);
    }
    if (turn.phaseBreakdown.traceCoverageMs != null) {
      metrics.traceCoverageMs.push(turn.phaseBreakdown.traceCoverageMs);
    }
    if (turn.trace.llmCallSummary.totalLatencyMs != null) {
      metrics.llmLatencyMs.push(turn.trace.llmCallSummary.totalLatencyMs);
    }
  }

  const summary = {};
  for (const [metricName, values] of Object.entries(metrics)) {
    const numericValues = values.filter((value) => value != null);
    summary[metricName] = {
      averageMs: round(average(numericValues)),
      minMs: round(numericValues.length > 0 ? Math.min(...numericValues) : null),
      p50Ms: round(percentile(numericValues, 50)),
      p95Ms: round(percentile(numericValues, 95)),
      maxMs: round(numericValues.length > 0 ? Math.max(...numericValues) : null),
    };
  }

  return summary;
}

async function sendChatTurn({ token, sessionId, turnNumber }) {
  const isFirstTurn = turnNumber === 1;
  const requestBody = isFirstTurn
    ? {
        projectId: config.projectId,
        agentId: config.agentName,
        message: 'Start the session with a short hello.',
      }
    : {
        projectId: config.projectId,
        agentId: config.agentName,
        sessionId,
        message: `Turn ${turnNumber - 1}: respond briefly.`,
      };

  const requestStartMs = Date.now();
  const response = await fetch(`${config.runtimeUrl}/api/v1/chat/agent`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Load-Test': config.loadTestKey,
    },
    body: JSON.stringify(requestBody),
  });
  const responseText = await response.text();
  const requestEndMs = Date.now();

  let responseBody = null;
  try {
    responseBody = JSON.parse(responseText);
  } catch {
    responseBody = {
      raw: responseText,
    };
  }

  if (!response.ok) {
    throw new Error(
      `Chat turn ${turnNumber} failed (${response.status}): ${responseText.slice(0, 500) || 'empty response'}`,
    );
  }

  if (!responseBody?.sessionId) {
    throw new Error(`Chat turn ${turnNumber} did not return a sessionId.`);
  }

  return {
    requestBody,
    requestStartMs,
    requestEndMs,
    responseStatus: response.status,
    responseBody,
  };
}

async function main() {
  const token = await login();
  const totalRequests = config.followUpTurns + 1;
  const turns = [];

  let sessionId = null;
  let lastStreamId = null;
  const seenTraceIds = new Set();

  for (let turnNumber = 1; turnNumber <= totalRequests; turnNumber += 1) {
    const requestResult = await sendChatTurn({ token, sessionId, turnNumber });
    sessionId = requestResult.responseBody.sessionId;

    await sleep(config.postResponseDrainMs);

    const traceResult = await readTraceEvents({
      token,
      sessionId,
      seenTraceIds,
    });
    const turnKind = turnNumber === 1 ? 'create' : 'followup';
    const turnRecord = buildTurnRecord({
      turnNumber,
      turnKind,
      requestStartMs: requestResult.requestStartMs,
      requestEndMs: requestResult.requestEndMs,
      requestBody: requestResult.requestBody,
      responseStatus: requestResult.responseStatus,
      responseBody: requestResult.responseBody,
      streamKey: traceResult.traceUrl,
      streamEvents: traceResult.events,
      totalTraceCount: traceResult.totalTraceCount,
      previousStreamId: turnNumber === 1 ? null : lastStreamId,
    });

    lastStreamId = turnRecord.trace.lastStreamId;
    turns.push(turnRecord);

    if (turnNumber < totalRequests) {
      await sleep(config.interRequestPauseMs);
    }
  }

  const firstTurn = turns[0];
  const followUpTurns = turns.slice(1);

  const report = {
    environment: 'local-dev',
    capturedAt: new Date().toISOString(),
    purpose:
      'Empirical local /api/v1/chat/agent latency breakdown captured from client timings plus timestamped session trace events.',
    sourceOfTruth: {
      studioUrl: config.studioUrl,
      runtimeUrl: config.runtimeUrl,
      endpoint: 'POST /api/v1/chat/agent',
      projectName: config.projectName,
      projectId: config.projectId,
      agentName: config.agentName,
      tenantId: config.tenantId,
      modelId: config.modelId,
      credentialName: config.credentialName,
      devLoginEmail: config.devLoginEmail,
    },
    measurementMethod: {
      scenario: {
        sessionCreateRequests: 1,
        followUpTurns: config.followUpTurns,
        totalRequests,
      },
      captureWindow: {
        postResponseDrainMs: config.postResponseDrainMs,
        interRequestPauseMs: config.interRequestPauseMs,
      },
      timingSources: {
        client: 'Node fetch Date.now() before request and after full response body read',
        traces:
          'GET /api/projects/:projectId/sessions/:id?includeTraces=true, diffing newly appended trace event ids after each turn',
        clockAssumption: 'client and runtime clocks are on the same local host',
      },
      phaseDefinitions: {
        traceStartDelayMs: 'request start -> first captured trace event',
        preLlmPlatformMs:
          'request start -> estimated LLM start, where estimated start = llm_call.timestamp - llm_call.durationMs',
        llmDurationMs: 'durationMs reported on llm_call',
        postLlmResponseTailMs: 'llm_call.timestamp -> client response end',
        estimatedPlatformOverheadMs: 'clientRequestMs - llmDurationMs',
        traceTailAfterResponseMs:
          'client response end -> last captured trace event in the drain window',
      },
    },
    summary: {
      firstTurn: summarizeTurns([firstTurn]),
      followUpAverage: summarizeTurns(followUpTurns),
      overallAverage: summarizeTurns(turns),
      slowestTurn: {
        turnNumber: turns.reduce((slowest, turn) =>
          turn.phaseBreakdown.clientRequestMs > slowest.phaseBreakdown.clientRequestMs
            ? turn
            : slowest,
        ).turnNumber,
      },
    },
    turns,
    limitations: [
      'Trace-tail measurements only include events captured within the configured post-response drain window.',
      'Async Mongo or Redis work that does not emit trace events will not appear in the event timeline.',
      'Request-phase boundaries before execution.queued are inferred from the gap between client request start and the first queued marker.',
    ],
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(JSON.stringify({ outputPath, turnCount: turns.length, sessionId }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

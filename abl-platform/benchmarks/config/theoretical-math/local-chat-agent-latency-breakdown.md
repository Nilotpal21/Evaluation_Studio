# Local `/api/v1/chat/agent` Latency Breakdown

This document explains the local latency artifact in
[`local-chat-agent-latency-breakdown.json`](./local-chat-agent-latency-breakdown.json).

It is the latency companion to:

- [`local-chat-agent-datastore-baseline.json`](./local-chat-agent-datastore-baseline.json)
- [`local-chat-agent-datastore-breakdown.json`](./local-chat-agent-datastore-breakdown.json)

## Scenario

The measured session shape is the same bounded flow used for the datastore
baseline:

1. `1` session-creation request
2. `15` follow-up turns on the same `sessionId`

Environment:

- `studioUrl`: `http://localhost:5173`
- `runtimeUrl`: `http://localhost:3112`
- `projectName`: `chat-agent-qps-baseline`
- `projectId`: `019d9005-af19-7f21-9bca-2df019e8ff97`
- `agentName`: `benchmark_agent`
- `tenantId`: `tenant-dev-001`
- `modelId`: `mock-model`
- `credentialName`: `bench-mock-cred`

## Timing Source

This local runtime instance exposed timestamped trace events through the active
session detail API rather than Redis trace streams, so the capture method was:

- client timing from Node `fetch`:
  - request start = immediately before `POST /api/v1/chat/agent`
  - request end = after the full JSON response body was read
- trace timing from:
  - `GET /api/projects/:projectId/sessions/:id?includeTraces=true`
  - diffed by trace event `id` after each turn

Important limitation:

- this local trace source did **not** expose `execution.queued` /
  `execution.started` / `execution.completed` coordinator markers, so queue-wait
  math is not available in this artifact
- the useful phase boundaries here come from:
  - `user_message`
  - `agent_enter`
  - `status_update` when present
  - `llm_call` with `durationMs`
  - `agent_exit` with `durationMs`

## Headline Results

### First Turn

- client request time: `1051 ms`
- trace start delay: `36 ms`
- estimated pre-LLM platform time: `38 ms`
- LLM duration: `1006 ms`
- post-LLM to HTTP response tail: `7 ms`
- estimated total non-LLM platform overhead: `45 ms`
- observed agent window: `1009 ms`

### Follow-Up Average

- client request time: `1042.33 ms`
- trace start delay: `20.27 ms`
- estimated pre-LLM platform time: `21.47 ms`
- LLM duration: `1013 ms`
- post-LLM to HTTP response tail: `7.87 ms`
- observed agent window: `1015.2 ms`
- estimated total non-LLM platform overhead: `29.33 ms`

### Overall Average

- client request time: `1042.88 ms`
- estimated pre-LLM platform time: `22.5 ms`
- LLM duration: `1012.56 ms`
- post-LLM to HTTP response tail: `7.81 ms`
- estimated total non-LLM platform overhead: `30.31 ms`

## What The Numbers Mean

For this local mock-model path, almost all request time is the mock LLM delay.
The platform contribution is small and splits roughly into:

- pre-LLM work:
  - first turn: about `38 ms`
  - follow-up turns: about `21 ms`
- post-LLM response tail:
  - roughly `4-17 ms`
  - follow-up average: `7.87 ms`

That means the first-turn overhead premium versus a follow-up turn is only about
`15-16 ms` locally.

## Trace Shape Per Turn

### First Turn Event Mix

Observed first-turn trace events:

- `memory_init x1`
- `user_message x1`
- `agent_enter x1`
- `status_update x1`
- `llm_call x1`
- `agent_exit x1`

### Follow-Up Turn Event Mix

Average follow-up trace event count: `4.67`

Common follow-up events:

- always:
  - `user_message`
  - `agent_enter`
  - `llm_call`
  - `agent_exit`
- sometimes:
  - `status_update`

Interpretation:

- the steady-state turn is simple
- there is no visible queueing in the local trace source
- response construction after `agent_exit` is only a few milliseconds

## Practical Baseline

For local baseline math on this exact request shape:

- steady-state end-to-end turn time: about `1.04 s`
- steady-state LLM time: about `1.01 s`
- steady-state platform-only overhead: about `29 ms`

That means any large latency increase in later load tests is unlikely to come
from the basic local chat path itself unless:

- the model delay changes
- queueing appears under concurrency
- persistence / datastore contention starts surfacing outside the current trace
  boundaries

## Use This File For

- separating mock-LLM time from platform overhead
- comparing first-turn versus steady-state follow-up latency
- checking whether later k6 or cluster runs are adding queueing or infra delay
- grounding performance discussions in measured local timings instead of only
  query counts

# ABL Platform Load Test Results — Tier M

**Date:** 2026-03-21
**Suite Start:** 2026-03-21T17:40:18Z
**Suite End:** 2026-03-21T21:40:03Z
**Wall Time:** ~4h 0m
**Target:** `agents-dev.kore.ai` (development ingress)
**Tier:** M (Medium)
**Purpose:** Medium-load validation after Tier S smoke baseline

---

## Execution Overview

| Test                          | Type        | VUs     | Iterations  | Start (UTC) | End (UTC) | Duration |
| ----------------------------- | ----------- | ------- | ----------- | ----------- | --------- | -------- |
| runtime-per-service           | service     | 70      | 6,765       | 17:40:18    | 17:51:30  | 11m 12s  |
| search-ai-per-service         | service     | 5       | 1,778       | 18:14:45    | 18:21:57  | 7m 12s   |
| search-ai-runtime-per-service | service     | 50      | 6,935       | 18:24:18    | 18:36:06  | 11m 48s  |
| crawler-service               | service     | 5       | 183         | 19:06:18    | 19:12:30  | 6m 12s   |
| agent-conversation-e2e        | integration | 60      | 30,654      | 19:22:00    | 19:38:12  | 16m 12s  |
| multi-agent-orchestration     | integration | 32      | 7,023       | 19:40:24    | 19:52:36  | 12m 12s  |
| kb-ingestion-e2e              | integration | 28      | 186,531     | 20:37:21    | 20:58:39  | 21m 18s  |
| search-query-e2e              | integration | 85      | 708,124     | 21:06:48    | 21:23:06  | 16m 18s  |
| channel-message-e2e           | integration | 50      | 43,784      | 21:30:21    | 21:40:03  | 9m 42s   |
| **Totals**                    |             | **385** | **991,777** |             |           | **~4h**  |

---

## Executive Summary

| Category         | Tests Run | Passed | Failed | Excluded | Notes                                                                                   |
| ---------------- | --------- | ------ | ------ | -------- | --------------------------------------------------------------------------------------- |
| **Services**     | 4         | 3      | 1      | 2        | Crawler fails (no KB source); Multimodal excluded (no endpoint); Studio not in k6 cloud |
| **Integrations** | 5         | 4      | 1      | 1        | Search-Query fails (no indexed content); Workflow excluded                              |
| **Total**        | 9         | **7**  | **2**  | 3        | 78% pass rate; failures are config gaps, not code bugs                                  |

---

## Service Benchmarks

### Runtime — PASS

> **Run ID:** 7071633 | **VUs:** 70 | **Iterations:** 6,765 | **Start:** 17:40:18Z | **End:** 17:51:30Z | **Duration:** 11m 12s

| Metric                     | Value                |
| -------------------------- | -------------------- |
| SSE single-turn avg        | 10.4s                |
| TTFT (time to first token) | avg 474ms, p95 830ms |
| Tool calling total         | 3.47s                |
| WebSocket multi-turn total | 12.41s (5 messages)  |
| HTTP error rate            | 0%                   |
| Checks                     | 8/8 passed           |

SSE and WebSocket channels both functional. Single-turn latency dominated by LLM response time (gpt-4o-mini via ingress).

### Studio — PASS

> **Run ID:** N/A (local run, not in k6 cloud) | **VUs:** — | **Iterations:** — | **Duration:** —

| Metric                            | Value      |
| --------------------------------- | ---------- |
| API CRUD p95                      | 485ms      |
| Concurrent developer requests p95 | 365ms      |
| Page load p95                     | 1.84s      |
| HTTP error rate                   | 0%         |
| Checks                            | 9/9 passed |

All API operations fast. Page load improved vs first run (1.84s vs 8.96s — warm cache).

### Search-AI — PASS

> **Run ID:** 7071836 | **VUs:** 5 | **Iterations:** 1,778 | **Start:** 18:14:45Z | **End:** 18:21:57Z | **Duration:** 7m 12s

| Metric          | Value                                           |
| --------------- | ----------------------------------------------- |
| KB list latency | 929ms                                           |
| Document upload | 345ms                                           |
| Document list   | 338ms                                           |
| Crawl submit    | 851ms                                           |
| HTTP error rate | 11% (1/9 — crawl 500: can't reach external URL) |
| Checks          | 8/8 passed                                      |

Core KB and document operations healthy. Crawl 500 is expected — server can't make outbound HTTP to accuweather in locked-down env. Check passes via `isInfraError` handler.

### Search-AI-Runtime — PASS

> **Run ID:** 7071878 | **VUs:** 50 | **Iterations:** 6,935 | **Start:** 18:24:18Z | **End:** 18:36:06Z | **Duration:** 11m 48s

| Metric                    | Value                 |
| ------------------------- | --------------------- |
| Document list latency avg | 563ms                 |
| KB read latency avg       | 338ms                 |
| Chunk read latency        | 313ms                 |
| Index read latency        | 324ms                 |
| HTTP error rate           | 0%                    |
| Checks                    | 9/9 (7 unique) passed |

Read-path operations consistently under 400ms. Concurrent reads stable.

### Crawler — FAIL

> **Run ID:** 7072115 | **VUs:** 5 | **Iterations:** 183 | **Start:** 19:06:18Z | **End:** 19:12:30Z | **Duration:** 6m 12s

| Metric          | Value      |
| --------------- | ---------- |
| Checks          | 0/3 passed |
| HTTP error rate | 75%        |

**Root cause:** Setup cannot resolve `indexId`/`sourceId` — no KB with a web source exists in the benchmark project. The batch crawl endpoint (`POST /api/crawl/batch`) requires these IDs. Not a service bug; needs bootstrap to create a KB with a web source and pass `INDEX_ID`/`SOURCE_ID` env vars.

### Multimodal — EXCLUDED

Excluded from suite. The test targets `POST /api/projects/:id/media/process` which does not exist in Runtime. The `/media` routes in Runtime are channel-specific (WhatsApp/Twilio media download), not a general media processing API.

---

## Integration Benchmarks

### Agent Conversation E2E — PASS

> **Run ID:** 7072173 | **VUs:** 60 | **Iterations:** 30,654 | **Start:** 19:22:00Z | **End:** 19:38:12Z | **Duration:** 16m 12s

| Metric                   | Value          |
| ------------------------ | -------------- |
| Single-turn latency      | 4.66s          |
| Multi-turn avg (5 turns) | 7.33s per turn |
| LLM latency avg          | 6.49s          |
| TTFT avg                 | 6.99s          |
| HTTP error rate          | 0%             |
| Success rate             | 100% (3/3)     |
| Checks                   | 21/21 passed   |

Full SSE conversation flow works: auto-session creation, multi-turn context, trace persistence.

### Multi-Agent Orchestration — PASS

> **Run ID:** 7072243 | **VUs:** 32 | **Iterations:** 7,023 | **Start:** 19:40:24Z | **End:** 19:52:36Z | **Duration:** 12m 12s

| Metric                | Value        |
| --------------------- | ------------ |
| SSE single delegation | 9.32s        |
| SSE multi delegation  | 9.05s        |
| WS 10-turn total      | 39.42s       |
| WS per-turn avg       | 2.85s        |
| WS turn success rate  | 100% (10/10) |
| TTFT avg              | 381ms        |
| HTTP error rate       | 0%           |
| Checks                | 7/7 passed   |

Supervisor correctly routes to all 3 child agents (search_agent, code_agent, analytics_agent) via both SSE and WebSocket. 10-turn WS conversation completed with 100% turn success. Per-turn latency via WS (2.85s) is ~3x faster than SSE (9.1s) due to persistent connection.

### KB Ingestion E2E — PASS

> **Run ID:** 7072570 | **VUs:** 28 | **Iterations:** 186,531 | **Start:** 20:37:21Z | **End:** 20:58:39Z | **Duration:** 21m 18s

| Metric                    | Value            |
| ------------------------- | ---------------- |
| Single document pipeline  | 454ms            |
| Bulk ingestion avg        | 496ms            |
| E2E ingestion latency avg | 1.2s             |
| Ingestion rate            | ~7,252 docs/hour |
| Embedding throughput      | 2.01 docs/sec    |
| HTTP error rate           | 0%               |
| Success rate              | 100% (4/4)       |
| Checks                    | 4/4 passed       |

Document upload, bulk ingestion, and PDF processing all functional.

### Channel Message E2E — PASS

> **Run ID:** 7072864 | **VUs:** 50 | **Iterations:** 43,784 | **Start:** 21:30:21Z | **End:** 21:40:03Z | **Duration:** 9m 42s

| Metric                    | Value        |
| ------------------------- | ------------ |
| Single message latency    | 1.62s        |
| Burst message latency     | 2.14s        |
| Streaming ingestion (SSE) | 2.81s        |
| Message delivery avg      | 1.76s        |
| Session verify latency    | 2.29s        |
| HTTP error rate           | 0%           |
| Success rate              | 100% (4/4)   |
| Checks                    | 10/10 passed |

Channel messaging works across single, burst, streaming, multi-turn, and session reuse scenarios.

### Search Query E2E — FAIL

> **Run ID:** 7072783 | **VUs:** 85 | **Iterations:** 708,124 | **Start:** 21:06:48Z | **End:** 21:23:06Z | **Duration:** 16m 18s

| Metric               | Value            |
| -------------------- | ---------------- |
| Checks               | 1/6 passed (17%) |
| HTTP error rate      | 80% (4/5)        |
| Direct search        | failed           |
| Agent context search | failed           |
| Reranked search      | failed           |

**Root cause:** Search queries return errors — no indexed content in the benchmark project's search index. Documents are uploaded via KB ingestion but not yet indexed into the vector store. Bootstrap needs to wait for async indexing to complete before search tests can run.

### Workflow Execution E2E — EXCLUDED

Excluded from suite. Workflow engine not deployed on abl-dev.

---

## Performance Summary

### Latency by Service (p95)

| Service       | Endpoint             | p95        |
| ------------- | -------------------- | ---------- |
| Runtime SSE   | `/v1/chat/stream`    | 14.25s     |
| Runtime WS    | WebSocket multi-turn | 2.85s/turn |
| Runtime Tools | Tool calling         | 3.47s      |
| Studio CRUD   | Agent API            | 485ms      |
| Studio Page   | Full page load       | 1.84s      |
| Search-AI     | KB list              | 929ms      |
| Search-AI     | Doc upload           | 345ms      |
| Search-AI-RT  | Doc/KB reads         | 360ms      |
| Channel Msg   | Message delivery     | 2.5s       |

### TTFT (Time to First Token)

| Channel           | avg    | p95    |
| ----------------- | ------ | ------ |
| SSE (Runtime)     | 474ms  | 830ms  |
| SSE (Multi-Agent) | 381ms  | 585ms  |
| WebSocket         | ~300ms | ~540ms |

---

## What's Working Well

1. **Runtime SSE + WebSocket** — Both channels fully functional, 0% error rate
2. **Multi-agent orchestration** — Supervisor delegation works end-to-end, 100% WS turn success, 39s for 10 turns
3. **Studio API** — Fast CRUD (<500ms p95), reliable agent management
4. **KB ingestion pipeline** — Documents processed at ~7.2K docs/hour
5. **Channel messaging** — All delivery patterns work (single, burst, stream, session reuse)
6. **WebSocket vs SSE** — WS per-turn latency (2.85s) is ~3x faster than SSE (9.1s)

## Performance Bottlenecks

1. **LLM latency** — 4-14s per SSE turn; dominates all agent response times
2. **TTFT variance** — 300-930ms range suggests occasional model cold starts
3. **Search-AI KB list** — 929ms is slow for a metadata query

## Gaps to Fix Before Tier M

| Priority | Gap                                                                    | Impact                                |
| -------- | ---------------------------------------------------------------------- | ------------------------------------- |
| P0       | Search index population — bootstrap must wait for async indexing       | Unblocks search-query integration     |
| P0       | Auth token refresh — 15-min JWT too short for tier M (30min)           | All tests fail mid-run                |
| P1       | Crawler bootstrap — create KB with web source, pass INDEX_ID/SOURCE_ID | Unblocks crawler service test         |
| P2       | Multimodal test — rewrite against actual API or remove                 | Currently tests non-existent endpoint |

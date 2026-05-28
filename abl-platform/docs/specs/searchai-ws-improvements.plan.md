# SearchAI Real-Time Infrastructure — Improvement Plan

## Context and Scope

The SearchAI service (port 3005) streams real-time progress events from backend workers to the
Studio frontend. Crawl jobs, intelligence analysis, and connector syncs all push live updates so
users can watch what's happening as it happens. The system was built quickly as a purpose-built
pipe and works correctly for single-pod deployments with low concurrency.

The problem is that it was built in isolation. The Runtime service (port 3112) already has a
mature, production-tested WebSocket infrastructure designed for thousands of concurrent agent
conversations. It has proper heartbeat detection, connection lifecycle management, dead-client
cleanup, stale sweeps, and structured capacity handling. SearchAI's progress system has none of
this. The two systems were built independently and neither learns from the other.

This plan identifies concrete problems across three areas — infrastructure, security, and
architecture — and proposes solutions grounded in what the platform already has. The philosophy
is simple: adopt proven patterns rather than inventing new ones.

### Platform Real-Time Strategy

Before diving into problems and solutions, it's important to understand how the platform already
handles real-time communication, because this informs every recommendation in this document.

The platform uses two real-time transports, each chosen for a specific purpose:

**Server-Sent Events (SSE)** are used for short-lived, ephemeral streaming. The primary example
is LLM chat streaming in Runtime's `POST /stream` endpoint. A user sends a message, the server
opens an SSE stream, tokens arrive over 5-60 seconds, and the stream closes. The connection is
transient — it exists only for the duration of one response. Agent Assist and AI4W channels use
the same pattern. SSE works well here because there's no need for bidirectional communication,
connections are short-lived enough that HTTP/1.1 connection limits don't matter, and the browser's
native `EventSource` API handles reconnection automatically.

**WebSocket** is used for long-lived, persistent connections. Runtime runs six separate WebSocket
servers for agent conversations, voice channels, debug tools, and SDK communication. These
connections stay open for minutes to hours. Runtime's `ConnectionManager` handles up to 10,000
concurrent connections with stale sweeps, heartbeat detection, and cross-pod coordination via
Redis pub/sub through the `ConnectionRegistry`.

The pattern is clear: **SSE for short streams, WebSocket for long connections.** Crawl progress
monitoring is a long-lived connection — a user watches a crawl run for 5-60 minutes while
hundreds of URLs are processed. This makes WebSocket the right transport for progress. The
current choice of WebSocket is correct. What needs fixing is the implementation quality.

The platform runs HTTP/1.1 (`http.createServer()`), which means browsers enforce a 6-connection-
per-origin limit. Long-lived SSE connections would compete with API calls for those 6 slots. This
is not a problem for chat streaming (connections last seconds) but would be a real problem for
progress monitoring (connections last minutes). WebSocket connections are upgraded and don't count
against the HTTP connection limit, which is another reason they're the right choice for long-lived
progress monitoring.

---

# Part 1: Infrastructure Problems

Eight problems in the progress WebSocket implementation, ordered by how we recommend fixing them.

---

## Problem 1: Dead Clients Are Never Detected

When a browser tab crashes, the OS kills a process, or a network drops without sending a clean
TCP FIN, the WebSocket connection stays open on the server side. The server doesn't know the
client is gone. It keeps a Redis subscriber alive for that phantom client, keeps sending pings
into the void, and counts it against the 500-connection capacity cap.

The code does send pings every 30 seconds and has a `pong` handler — but the pong handler is an
empty callback. It literally does nothing. There's no flag, no timestamp, no liveness tracking.
The ping goes out, and if a pong comes back... nothing happens. If it doesn't come back...
nothing happens either.

Over time, ghost connections accumulate. In a long-running deployment, you silently lose capacity
as dead subscriptions pile up. You wouldn't know until you hit the 500-connection cap and wonder
why you're at capacity with far fewer real users.

**Where the platform already solves this:** Runtime's `heartbeat.ts` is 55 lines long and
implements the standard WebSocket liveness protocol. It uses a WeakMap to track per-client
liveness: on each ping cycle, every client is marked `alive = false`. When a pong arrives, the
client is marked `alive = true`. On the next cycle, any client still marked `false` is terminated
with `ws.terminate()` (a hard kill, not a graceful close). The WeakMap means garbage collection
handles cleanup automatically — no manual bookkeeping.

**Recommendation:** Adopt Runtime's heartbeat pattern. Replace the per-client `setInterval` with
a single shared interval that iterates `wss.clients`. Add the liveness WeakMap. When a client
fails the liveness check, terminate it and clean up its Redis subscriber and `activeSubscriptions`
entry. This is a small, self-contained change to `progress.ts` that immediately stops the ghost
connection problem.

| Reference                | File                                      | Line    |
| ------------------------ | ----------------------------------------- | ------- |
| Empty pong handler       | `apps/search-ai/src/routes/progress.ts`   | 390-392 |
| Per-client ping interval | `apps/search-ai/src/routes/progress.ts`   | 395-401 |
| Runtime's heartbeat      | `apps/runtime/src/websocket/heartbeat.ts` | 16-51   |

---

## Problem 2: One Redis Connection Per Client

Every WebSocket client that connects creates its own dedicated Redis subscriber connection. This
is the single most expensive design problem in the system.

If 200 users are watching crawl progress, that's 200 Redis connections from one SearchAI pod —
just for the progress feature. If 50 of those users are all watching the same crawl job, that's
50 separate Redis subscribers on the same channel `progress:{jobId}`. Each one receives the
identical message independently. Redis delivers the message 50 times to 50 connections when it
could deliver it once.

Redis has a default maximum of 10,000 client connections. With multiple SearchAI pods, this
becomes a real bottleneck. At full capacity (500 connections per pod x N pods), the progress
feature alone can consume a significant fraction of Redis's connection pool, competing with
BullMQ workers, session storage, and every other Redis consumer in the system.

**What should happen:** The server should maintain one Redis subscriber per unique job channel,
and fan out messages to all WebSocket clients watching that job in-process. This changes the
connection model from O(clients) to O(active-jobs). For a typical scenario of 200 clients
watching 15 active jobs, this reduces Redis connections from 200 to 15.

**Recommendation:** Introduce a `ChannelSubscriptionPool` — a Map from channel name to
`{ subscriber: RedisType, clients: Set<WebSocket> }`. When the first client subscribes to a
job, create one Redis subscriber for that channel. When additional clients subscribe to the same
job, add them to the in-memory fan-out set. When a message arrives from Redis, iterate the set
and send to each client. When the last client unsubscribes, close that one Redis connection.

This is the same pattern that the discovery SSE system already uses (`crawl-discover.ts` line 40
stores listeners in a `Set<Response>` and fans out from a single source), just adapted for
WebSocket + Redis pub/sub.

**Why not SSE instead?** An earlier version of this plan recommended replacing WebSocket with
SSE to solve this problem. That was wrong. The per-client Redis subscriber problem is an
architectural issue (1:1 subscriber-to-client mapping), not a transport issue. You'd have the
exact same problem with SSE if you created one Redis subscriber per SSE response. The fix is
the shared subscriber pool, and that works equally well with WebSocket. Switching transport would
add migration cost and complexity without solving the root cause.

| Reference                               | File                                          | Line        |
| --------------------------------------- | --------------------------------------------- | ----------- |
| Per-client Redis subscriber creation    | `apps/search-ai/src/routes/progress.ts`       | 280-281     |
| Subscriber message handler (per-client) | `apps/search-ai/src/routes/progress.ts`       | 328-341     |
| Per-client quit on disconnect           | `apps/search-ai/src/routes/progress.ts`       | 365-370     |
| Discovery fan-out pattern (reference)   | `apps/search-ai/src/routes/crawl-discover.ts` | 40, 497-504 |

---

## Problem 3: Per-Client Timer Proliferation

Each WebSocket client creates its own `setInterval` for sending pings at 30-second intervals.
At 500 connections, that's 500 independent timers ticking in the Node.js event loop. Node.js
handles timers efficiently via a priority queue, so this isn't a CPU bottleneck, but it's
needlessly wasteful when one timer can do the same work.

There's also a cleanup gap: the `clearInterval(pingInterval)` call exists only inside the
interval's own readyState check. Neither the `ws.on('close')` nor `ws.on('error')` handler
clears the interval. When a client disconnects, the interval keeps firing for up to 30 seconds
until it detects `readyState !== OPEN` and self-clears. It's not a permanent leak — the interval
does eventually clean itself up — but during that 30-second window, you have orphan timers firing
for dead sockets.

**Recommendation:** Replace all per-client intervals with a single shared heartbeat interval that
iterates `wss.clients` (the built-in Set that the `ws` library maintains). This is exactly what
Runtime does — one timer, all clients, every 30 seconds. The single timer also naturally
incorporates the liveness check from Problem 1, so both problems are solved by one piece of code.

| Reference                            | File                                      | Line    |
| ------------------------------------ | ----------------------------------------- | ------- |
| Per-client interval creation         | `apps/search-ai/src/routes/progress.ts`   | 395-401 |
| Missing clearInterval in close/error | `apps/search-ai/src/routes/progress.ts`   | 363-387 |
| Runtime's single shared interval     | `apps/runtime/src/websocket/heartbeat.ts` | 20-36   |

---

## Problem 4: No Stale Connection Sweep

The `activeSubscriptions` Map tracks connected clients. Entries are added on connection and
removed in `ws.on('close')` and `ws.on('error')` handlers. If both events fire, cleanup happens
correctly.

But sometimes neither event fires. Zombie TCP connections, half-open sockets, and load balancer
timeout edge cases can leave a socket in CLOSING or CLOSED state without triggering the event
handlers. When that happens, the subscription entry lives in the Map forever — its Redis
subscriber stays connected, and it counts against capacity.

Combined with Problem 1 (no dead-client detection), this creates a compounding failure: dead
clients aren't detected (P1), and even if the socket eventually transitions to CLOSED state, no
sweep exists to clean it up (P4). The only way these entries get removed is if the server
restarts.

**Where the platform already solves this:** Runtime's `ConnectionManager` runs a sweep every 60
seconds. It iterates all entries, checks `ws.readyState > 1` (CLOSING or CLOSED), and cleans up
anything stale. It also tracks `lastActivity` timestamps and sweeps connections idle beyond a
configurable TTL (default 5 minutes).

**Recommendation:** Add a stale-sweep interval (60 seconds) that iterates `activeSubscriptions`.
For each entry, check `ws.readyState`. If it's not `WebSocket.OPEN`, clean up the Redis
subscriber and remove the entry. Optionally track `lastActivity` per subscription and sweep
connections idle beyond 10 minutes (a reasonable TTL for a progress monitoring connection that
should be receiving periodic events).

| Reference                        | File                                               | Line     |
| -------------------------------- | -------------------------------------------------- | -------- |
| Only event-driven cleanup exists | `apps/search-ai/src/routes/progress.ts`            | 362-387  |
| No periodic sweep anywhere       | `apps/search-ai/src/routes/progress.ts`            | (absent) |
| Runtime's stale sweep            | `apps/runtime/src/websocket/connection-manager.ts` | 104-125  |

---

## Problem 5: No Maximum Payload Size

The WebSocket server is created with `new WebSocketServer({ noServer: true })` — no
`maxPayload` option. The `ws` library's default maximum payload is 100MB. A malicious or buggy
client could send a single 100MB frame, which Node.js would buffer entirely in memory before the
message handler fires.

The progress WebSocket is designed to be unidirectional (server pushes to client). Clients should
never send meaningful data. But without `maxPayload`, there's no enforcement of that expectation.

Runtime sets `maxPayload: 512 * 1024` (512KB) on all its WebSocket servers, and even uses a
tighter 64KB limit for Twilio media streams where payloads are known to be small audio chunks.

**Recommendation:** Add `maxPayload: 64 * 1024` (64KB) to the WebSocketServer constructor.
Progress events are small JSON objects — typically 200-500 bytes. 64KB provides 100x headroom
and prevents memory abuse. This is a one-line change.

| Reference                 | File                                    | Line      |
| ------------------------- | --------------------------------------- | --------- |
| No maxPayload set         | `apps/search-ai/src/routes/progress.ts` | 134       |
| Runtime's 512KB default   | `apps/runtime/src/server.ts`            | 1972-1975 |
| Runtime's 64KB for Twilio | `apps/runtime/src/server.ts`            | 1973      |

---

## Problem 6: Capacity Check Happens After Resource Allocation

The maximum subscription check (`activeSubscriptions.size >= MAX_SUBSCRIPTIONS`) runs at line 344,
but by that point the code has already created a new Redis connection (line 280), established a
Redis subscription (line 285), set up a message handler (line 328), and replayed a cached event
(line 312). If the server is at capacity, all of that work is thrown away — the subscriber is
quit, the WebSocket is closed, and the resources are wasted.

Additionally, the capacity rejection happens after the WebSocket upgrade has already completed.
The client briefly sees a successful connection before being kicked. From the user's perspective,
the progress monitor connects and immediately disconnects with no clear reason.

**Recommendation:** Move the capacity check to the HTTP upgrade handler, before `wss.handleUpgrade`.
If the server is at capacity, reject with `HTTP/1.1 503 Service Unavailable` before the WebSocket
handshake even starts. The client never gets a connection, never sees a confusing disconnect, and
the server never allocates a Redis connection it's going to throw away.

Runtime's `ConnectionManager.add()` returns `false` when at capacity. The caller uses this to
close with WS code 1013 (Try Again Later). The same pattern should be adopted here.

| Reference                              | File                                               | Line    |
| -------------------------------------- | -------------------------------------------------- | ------- |
| Late capacity check                    | `apps/search-ai/src/routes/progress.ts`            | 344-356 |
| Redis subscriber already created above | `apps/search-ai/src/routes/progress.ts`            | 280-285 |
| Upgrade handler (where check belongs)  | `apps/search-ai/src/routes/progress.ts`            | 137-258 |
| Runtime's capacity rejection           | `apps/runtime/src/websocket/connection-manager.ts` | 41-49   |

---

## Problem 7: Connector Sync Worker Bypasses the Centralized Publisher

Every crawl worker, intelligence worker, and pipeline worker publishes progress events through
`publishProgressEvent()` in `progress.ts`. This centralized function manages a singleton Redis
publisher connection, handles error recovery with auto-reconnect, and caches the last event per
job (`SETEX progress:last:{jobId}`) so that late-joining clients see the latest state immediately.

The connector sync worker doesn't use any of this. It has its own `SyncProgressPublisher` class
that creates its own Redis connection, publishes events directly to the same `progress:{jobId}`
channel, and has its own event format. This parallel implementation has four consequences:

1. **No late-joiner replay.** Because `SyncProgressPublisher` doesn't write to
   `progress:last:{jobId}`, clients that connect after a sync is already running see nothing
   until the next event arrives. For long-running syncs, this can mean minutes of blank screen.

2. **No error recovery.** The centralized publisher detects Redis errors and recreates the
   connection on the next publish call. The `SyncProgressPublisher` creates a connection at sync
   start and uses it for the entire duration. If it drops, events are silently lost.

3. **Extra Redis connections.** Every active sync job holds an independent Redis connection on
   top of the singleton publisher. This adds to the connection pool pressure described in Problem 2.

4. **Maintenance burden.** Any change to the progress protocol (new fields, format changes,
   caching strategy) must be applied in two separate places.

**Recommendation:** Replace `SyncProgressPublisher` with calls to `publishProgressEvent()`. The
`ProgressEvent` type already includes connector-specific fields (`currentSite`, `currentDocument`,
`rate`, `eta`, `documents_processed` event type). The `SyncProgressPublisher` should become a thin
adapter that maps connector progress callbacks to `publishProgressEvent()` calls rather than being
an independent Redis publisher.

Note that `connector-sync-worker` also calls `job.updateProgress(100)` for BullMQ's built-in
progress tracking. That's fine — it's complementary. The pub/sub events are for real-time UI
streaming; `job.updateProgress()` is for BullMQ's stored state, which survives pod restarts.

| Reference                              | File                                                  | Line      |
| -------------------------------------- | ----------------------------------------------------- | --------- |
| `SyncProgressPublisher` class          | `apps/search-ai/src/workers/connector-sync-worker.ts` | 79-153    |
| Instantiation during sync              | `apps/search-ai/src/workers/connector-sync-worker.ts` | 335       |
| Centralized `publishProgressEvent()`   | `apps/search-ai/src/routes/progress.ts`               | 425-446   |
| Connector event fields already defined | `apps/search-ai/src/routes/progress.ts`               | 27, 57-60 |

---

## Problem 8: Discovery Is Not Horizontally Scalable

The HTTP discovery system streams progress via SSE and stores all crawl state in an in-memory
`Map<string, CrawlState>`. This is the last piece of pod-local state in the real-time pipeline,
and it has three consequences:

1. **Load balancer routing breaks reconnects.** If the browser's `EventSource` reconnects (which
   it does automatically on network glitches) and the load balancer routes the reconnect to a
   different pod, the discovery state doesn't exist there. The client gets a 404.

2. **Pod restarts lose all state.** If the pod restarts, all active discoveries are gone. There's
   no recovery mechanism. The user has to start over.

3. **Fixed per-pod capacity.** `MAX_CRAWLS = 50` is a per-pod limit with no way to distribute
   across pods. Total discovery capacity is 50 x 1 pod.

The code itself acknowledges this — comments reference moving state to Redis for multi-pod
deployment. The crawl progress system (WebSocket + Redis pub/sub) is already horizontally
scalable. Discovery is the holdout.

**Possible approaches:**

**Option A: Redis state + keep SSE transport.** Move `CrawlState` from the in-memory Map to a
Redis hash. Publish SSE events via Redis pub/sub. The SSE endpoint becomes a stateless relay,
just like the WebSocket progress endpoint. This preserves the current SSE transport and frontend
code while solving the scaling problem.

**Option B: BullMQ worker + WebSocket progress.** Move the discovery crawl loop to a BullMQ
worker. State moves to Redis. Progress events go through `publishProgressEvent()` and the
existing WebSocket infrastructure. The frontend uses `useCrawlProgress` (or a similar hook)
instead of `EventSource`. This fully unifies discovery and crawl progress into one streaming
system.

**Option C: BullMQ worker + keep SSE relay.** The discovery crawl runs as a BullMQ worker for
multi-pod resilience, but the frontend still uses SSE via a stateless relay that reads from
Redis. This is a hybrid — BullMQ for durability, SSE for simplicity.

**Recommendation: Option B** — full unification with the WebSocket progress system. The reasoning
is that once Problems 1-6 are fixed, the WebSocket infrastructure will be production-grade. Having
two separate real-time transports (SSE for discovery, WS for crawl) doubles the maintenance
surface for no user-visible benefit. Unifying onto one system means one set of heartbeat logic,
one connection pool, one capacity management strategy, and one set of frontend hooks.

The main cost is migrating the discovery frontend from `EventSource` to WebSocket, which means
changes to `crawl-discover.ts` (backend) and `crawl.ts` API layer + hooks (frontend). This is
not trivial but aligns with the broader goal of eliminating pod-local state.

The real technical cost of Option B is **state serialization complexity.** The discovery frontier
is a complex in-memory data structure (PriorityFrontier with scored URLs, visited sets, pattern
matchers). Serializing this to Redis on every URL check is the actual bottleneck — not Redis
round-trip latency (which is sub-millisecond for co-located instances). The design needs a
coarse-grained state sync strategy (e.g., batch frontier updates every N URLs) rather than
per-operation Redis calls.

| Reference                            | File                                          | Line    |
| ------------------------------------ | --------------------------------------------- | ------- |
| In-memory Map                        | `apps/search-ai/src/routes/crawl-discover.ts` | 58      |
| MAX_CRAWLS = 50                      | `apps/search-ai/src/routes/crawl-discover.ts` | 59      |
| TTL cleanup                          | `apps/search-ai/src/routes/crawl-discover.ts` | 60-79   |
| WebSocket progress as target pattern | `apps/search-ai/src/routes/progress.ts`       | 425-446 |

---

## Dead Code to Clean Up

During analysis, we found three dead components related to the progress system. None are bugs,
but they add confusion for anyone reading the codebase and should be removed:

1. **`useIntelligenceProgress` hook** in `apps/studio/src/hooks/useIntelligenceProgress.ts` has
   zero imports anywhere. It was superseded by `useMultiPageProgress` when intelligence crawl
   moved from single-page to multi-page analysis.

2. **`SyncProgress.tsx` component** in `apps/studio/src/components/search-ai/SyncProgress.tsx`
   has zero imports. The active connector sync UI uses `SyncProgressView.tsx` with SWR HTTP
   polling via the `useConnectorSync` hook, not WebSocket.

3. **`connectToSyncProgress()` function** in `apps/studio/src/api/connector-extensions.ts`
   (line 165) is only consumed by the dead `SyncProgress.tsx`. It also has an auth bug — it
   creates a WebSocket connection without passing a JWT token, so it would be rejected with 401
   in production. Since nobody calls it, this is harmless but confusing.

---

## Infrastructure Priority and Sequencing

| Priority | Problem                         | Effort | Impact              | What Happens If Not Fixed                                       |
| -------- | ------------------------------- | ------ | ------------------- | --------------------------------------------------------------- |
| 1        | P5: No maxPayload               | 1 line | Memory safety       | 100MB frames accepted from any client                           |
| 2        | P6: Late capacity check         | Small  | Resource waste      | Redis connections created and immediately discarded at capacity |
| 3        | P1: No dead-client detection    | Small  | Connection leak     | Ghost connections accumulate silently                           |
| 4        | P3: Timer proliferation         | Small  | Event loop hygiene  | 500 timers instead of 1                                         |
| 5        | P4: No stale sweep              | Small  | Zombie cleanup      | Phantom subscriptions survive indefinitely                      |
| 6        | P2: Per-client Redis subscriber | Medium | 13x Redis reduction | Redis connection exhaustion at scale                            |
| 7        | P7: Connector publisher bypass  | Medium | Consistency         | Late-joining connector viewers see nothing                      |
| 8        | P8: Discovery not scalable      | Large  | Multi-pod readiness | Cannot horizontally scale SearchAI                              |

**Suggested waves:**

- **Wave 1** (1-2 hours): P5, P6, P1, P3, P4 — all changes are in `progress.ts` only. P1, P3,
  and P4 are really one change: replace per-client intervals with a single shared heartbeat + sweep.
- **Wave 2** (half day): P2 — the `ChannelSubscriptionPool` redesign within `progress.ts`.
- **Wave 3** (half day): P7 — refactor `connector-sync-worker.ts` to use `publishProgressEvent()`.
- **Wave 4** (1-2 days): P8 — architectural migration of discovery to BullMQ + WebSocket.
- **Cleanup** (any time): Dead code removal — 3 files.

**Success criteria after all waves:**

1. Zero ghost connections after 2 heartbeat cycles (60 seconds)
2. Redis connections for progress = O(active-jobs), not O(connected-clients)
3. One heartbeat timer regardless of connection count
4. Stale sweep runs every 60 seconds, cleaning up zombie entries
5. Capacity rejection at HTTP upgrade time (503), before any Redis allocation
6. All workers publish through `publishProgressEvent()` — no parallel publishers
7. Discovery works correctly across multiple pods
8. `maxPayload` set to 64KB

---

# Part 2: Security Review

A full security audit of the crawl system's authentication, tenant isolation, data boundaries,
and external interactions. Each finding is severity-rated, with the full reasoning for the rating.

---

## S1 [HIGH]: SSRF Redirect Bypass in HttpAdapter

The `HttpAdapter` class in the crawler package is the primary HTTP fetch path for the bulk-crawl
worker. It does implement SSRF protection for the initial request — it resolves DNS, validates the
IP isn't private/cloud-metadata, and pins the resolved IP into the request URL with the original
`Host` header. This initial protection is well-done.

The problem is what happens after the initial request. The axios config sets `maxRedirects: 5`,
and axios follows those redirects internally, resolving the new hostname for each hop without
calling the SSRF validation. An attacker sets up `http://public.example.com` that 301-redirects to
`http://169.254.169.254/latest/meta-data/`. The initial SSRF check passes because
`public.example.com` resolves to a public IP. But the redirect goes to the AWS metadata endpoint,
and axios follows it without any validation.

This is a real cloud metadata exfiltration vulnerability. It's the classic SSRF-via-redirect
pattern.

**The platform already has the fix.** The `safe-fetch.ts` module in `packages/shared-kernel`
implements per-hop SSRF validation — every redirect is validated against the same rules as the
initial request. The HttpAdapter doesn't use it.

**Recommendation:** Either replace axios with `safe-fetch` for the redirect-following path, or
set `maxRedirects: 0` on axios and implement manual redirect following with per-hop SSRF checks.
The first option is simpler because it reuses existing, tested code.

| Reference                                    | File                                                           | Line    |
| -------------------------------------------- | -------------------------------------------------------------- | ------- |
| Axios maxRedirects: 5                        | `packages/crawler/src/intelligence/algorithms/http-adapter.ts` | 45      |
| Initial SSRF check (per-hop missing)         | `packages/crawler/src/intelligence/algorithms/http-adapter.ts` | 206-218 |
| Platform safe-fetch with redirect validation | `packages/shared-kernel/src/security/safe-fetch.ts`            | 168-211 |

---

## S2 [LOW — Correction]: Batch Endpoint Rate Limiting

The original version of this plan rated this as HIGH, claiming the batch submit endpoint has no
rate limiting. **That was incorrect.** The SearchAI server applies a global rate limiter at
`server.ts` line 229: `app.use('/api', searchAiRateLimit())`. This middleware applies to all
`/api` routes at 120 requests per minute per tenant, including the batch endpoint.

What IS true is that the batch endpoint doesn't have a stricter per-endpoint limit, unlike the
crawl preview endpoint which has a tighter 10 requests per minute. Given that each batch
submission can include up to 50,000 URLs, a per-endpoint limit stricter than the global 120/min
would be reasonable — perhaps 5-10 batch submissions per minute per tenant.

This is an enhancement, not a security vulnerability. The global rate limit prevents the
queue-flooding scenario described in the original finding.

**Recommendation:** Consider adding a per-endpoint rate limit of 5-10 req/min on the batch
endpoint, similar to what the preview endpoint has. This is a nice-to-have, not urgent.

| Reference                           | File                                         | Line |
| ----------------------------------- | -------------------------------------------- | ---- |
| Global rate limit (covers all /api) | `apps/search-ai/src/server.ts`               | 229  |
| Preview endpoint stricter limit     | `apps/search-ai/src/routes/crawl-preview.ts` | 32   |

---

## S3 [MEDIUM]: Discovery Endpoint Missing SSRF Protection

The HTTP discovery endpoint (`POST /api/crawl/discover`) accepts `baseUrl` and `sampleUrls` from
the request body and passes them directly to `runDiscoverCrawl()` without SSRF validation. The
server-side crawler will fetch these URLs and follow links from them.

Meanwhile, the browser-based discovery endpoint (`POST /api/crawl/discover/browser`) has explicit
SSRF checks via `isPrivateOrUnsafeUrl()` for all submitted URLs. Similarly, the deepen endpoint
(`POST /api/crawl/discover/deepen`) accepts `warmUrls` and `apiUrls` without SSRF validation.

The inconsistency is the problem — browser-discover protects against SSRF, HTTP-discover doesn't.
This means an attacker can use the HTTP discovery path to trigger server-side requests to internal
infrastructure.

**Recommendation:** Add `isPrivateOrUnsafeUrl()` checks to the HTTP discover and deepen
endpoints, matching what browser-discover already does. The validation function exists and is
already imported in the adjacent file.

| Reference                         | File                                                    | Line    |
| --------------------------------- | ------------------------------------------------------- | ------- |
| Discover — no SSRF check          | `apps/search-ai/src/routes/crawl-discover.ts`           | 83-128  |
| Deepen — no SSRF check            | `apps/search-ai/src/routes/crawl-discover.ts`           | 209-265 |
| Browser discover — HAS SSRF check | `apps/search-ai/src/routes/crawl-browser-discover.ts`   | 229-241 |
| Platform SSRF validator           | `packages/shared-kernel/src/security/ssrf-validator.ts` | 1-460   |

---

## S4 [MEDIUM]: Discovery Endpoint Missing Input Validation

The discovery endpoint uses `req.body as { ... }` — a TypeScript type assertion that provides
zero runtime validation. There are no bounds on `maxPages`, `maxDepth`, `concurrency`, or array
sizes for `sampleUrls`. A client could send `maxPages: 999999` or `concurrency: 1000` and the
server would accept it.

The only runtime checks are `typeof baseUrl !== 'string'` and `Array.isArray(sampleUrls)`. Fields
like `maxPages`, `maxDepth`, and `concurrency` aren't validated at all — a string value for
`maxPages` would pass through silently and fall back to the default via `??`.

All other crawl endpoints (drafts, preview, batch) use Zod schemas for request validation. The
discovery endpoint is the only exception.

**Recommendation:** Add a Zod schema matching what the other endpoints do. Enforce `maxPages`
bounds (e.g., 1-10000), `maxDepth` bounds (e.g., 1-10), `concurrency` bounds (e.g., 1-20), and
`sampleUrls` array length limits.

| Reference                       | File                                          | Line   |
| ------------------------------- | --------------------------------------------- | ------ |
| Discover — no Zod, just `as {}` | `apps/search-ai/src/routes/crawl-discover.ts` | 94-100 |
| Drafts — proper Zod validation  | `apps/search-ai/src/routes/crawl-drafts.ts`   | 66-133 |
| Preview — proper Zod validation | `apps/search-ai/src/routes/crawl-preview.ts`  | 24     |

---

## S5 [MEDIUM]: Stored HTML Without Sanitization (XSS Time Bomb)

Crawled HTML is stored to S3 in two forms: raw and cleaned. The "cleaned" version goes through
Readability and cheerio extraction, which strips `<script>` and `<style>` tags as noise. But this
is content extraction, not security sanitization. XSS vectors like `<img onerror="...">`,
`<a href="javascript:...">`, SVG event handlers, and CSS-based injection all survive the
extraction pipeline.

No DOMPurify, `escapeHtml`, or any HTML sanitization library is used anywhere in the ingestion
pipeline.

Currently the frontend does NOT render raw HTML — there's no `dangerouslySetInnerHTML` in any
crawl component. So this is not exploitable today. But the raw HTML is permanently stored in S3,
and it becomes a stored XSS vulnerability the moment any future feature decides to render it
(preview pane, HTML diff viewer, content inspector, etc.).

**Recommendation:** Add DOMPurify sanitization to the ingestion pipeline before S3 upload. This
doesn't affect the raw backup (keep that as-is for debugging), but the "cleaned" version that
downstream consumers read should be sanitized. Also consider adding a lint rule or code review
gate that blocks `dangerouslySetInnerHTML` in crawl-related components without a sanitization step.

| Reference                                  | File                                                         | Line             |
| ------------------------------------------ | ------------------------------------------------------------ | ---------------- |
| Raw HTML upload to S3                      | `apps/search-ai/src/services/ingestion/crawler-ingestion.ts` | 410-414          |
| Extraction cascade (content, not security) | `apps/search-ai/src/services/crawler/extraction-cascade.ts`  | 1-80             |
| No dangerouslySetInnerHTML in crawl UI     | `apps/studio/src/components/search-ai/crawl-flow/`           | confirmed absent |

---

## S6 [LOW — Adjusted]: MCP Server Connection Without Authentication

The bulk-crawl worker connects to the MCP server (Playwright browser automation) at
`CRAWLER_MCP_URL` (default `http://localhost:3100`) without any authentication. No API key, no
mTLS, no token. The MCP client is initialized with `ssrfOptions: { allowLocalhost: true }`,
explicitly relaxing SSRF protections for this connection.

Content returned by MCP flows directly into the ingestion pipeline without integrity validation.

The severity of this depends on the deployment model. In production Kubernetes, MCP is designed to
run as a pod-internal sidecar — `localhost` communication within a pod is inherently isolated by
the pod network boundary. An attacker would need to compromise the pod itself to intercept or
inject content, at which point they already have full access anyway.

However, in non-Kubernetes environments (development, testing, standalone deployment), MCP might
be accessible on a shared network, making the lack of authentication more meaningful.

**Recommendation:** Add a shared secret or API key header to the MCP connection. The
`MCPClientConfig` interface already supports a `headers` field — it just isn't used. This is
defense-in-depth and costs almost nothing. But it's LOW priority, not MEDIUM, because the primary
deployment model (K8s sidecar) provides network-level isolation.

| Reference                        | File                                              | Line    |
| -------------------------------- | ------------------------------------------------- | ------- |
| MCP connection — no auth         | `apps/search-ai/src/workers/bulk-crawl-worker.ts` | 428-436 |
| MCP content used directly        | `apps/search-ai/src/workers/bulk-crawl-worker.ts` | 240-250 |
| MCPClientConfig supports headers | `packages/compiler/src/platform/mcp/client.ts`    | 149     |

---

## S7 [MEDIUM]: Error Messages Leak Internal Details

Seven locations in `crawl.ts` include `error.message` directly in HTTP 500 responses. If the
error originates from MongoDB, Redis, or an unexpected exception, the raw message — which may
contain connection strings, internal hostnames, or stack traces — is sent to the client.

The original version of this plan identified 4 locations. A thorough re-audit found 7:

| Line | Context                         |
| ---- | ------------------------------- |
| 942  | Failed to process crawl request |
| 1250 | Failed to process response      |
| 2588 | Failed to fetch history         |
| 2624 | Failed to fetch preferences     |
| 2692 | Failed to save preference       |
| 2731 | Failed to delete preference     |
| 2868 | Failed to get crawled pages     |

Other crawl route files (drafts, preview, intelligence) consistently use generic messages like
"An unexpected error occurred" — the batch endpoint is inconsistent.

**Recommendation:** Replace all `error.message` in 500 responses with a generic message. Log the
full error server-side with `createLogger` (which already exists in the file). The client gets a
stable, non-leaking error; the operations team gets the real details in logs.

| Reference                         | File                                        | Line                                    |
| --------------------------------- | ------------------------------------------- | --------------------------------------- |
| 7 locations leaking error.message | `apps/search-ai/src/routes/crawl.ts`        | 942, 1250, 2588, 2624, 2692, 2731, 2868 |
| Clean pattern (generic message)   | `apps/search-ai/src/routes/crawl-drafts.ts` | throughout                              |

---

## S8 [MEDIUM]: 50MB Express JSON Body Limit

The SearchAI server sets `express.json({ limit: '50mb' })`. The comment says this is "for file
uploads," but file uploads typically use multipart form data, not JSON. The largest legitimate
JSON payload is HTML ingestion at 10MB (enforced by `MAX_HTML_SIZE` in the ingestion service).

A 50MB body limit means Express will parse up to 50MB of JSON into a JavaScript object before
any route-level validation runs. Repeated large POST requests to any route could pressure the
Node.js heap. This is disproportionate to the API's actual needs.

**Recommendation:** Reduce to `12mb` (giving ~20% headroom over the 10MB HTML limit). If
specific endpoints need larger payloads in the future, use per-route body limits via middleware
rather than a global 50MB.

| Reference          | File                                                         | Line |
| ------------------ | ------------------------------------------------------------ | ---- |
| 50MB body limit    | `apps/search-ai/src/server.ts`                               | 164  |
| Max HTML size 10MB | `apps/search-ai/src/services/ingestion/crawler-ingestion.ts` | 129  |

---

## S9 [MEDIUM]: Unvalidated Fields via Zod `.passthrough()`

Two Zod schemas use `.passthrough()`, which lets arbitrary fields beyond the defined schema pass
through validation and flow into MongoDB:

1. **`discoveryState` in crawl-drafts** — a 5MB size limit is enforced on the overall payload,
   but arbitrary field names and values pass through. The code has an explicit CAUTION comment:
   "Do NOT change to .strict() without adding these fields to the schema first." This is a
   known tech debt, not an oversight.

2. **`metadata` in crawler-ingestion** — allows arbitrary metadata fields from the ingestion
   pipeline.

While `.passthrough()` doesn't cause immediate harm (MongoDB stores arbitrary documents), it
means the validation layer is lying about its guarantees. Downstream consumers that assume a
known schema could encounter unexpected fields or types. It also means untrusted client input
can write arbitrary field names into the database — a potential vector for NoSQL injection
patterns in some edge cases.

**Recommendation:** Define explicit schemas for the known fields (the crawl-drafts comment
acknowledges `tree`, `discoveredUrls`, `objectives`, `navStructure`, `coverage`, `savedAt` as
passthrough fields). Add these to the schema definition and switch to `.strict()`. For metadata,
add a `z.record(z.string(), z.unknown())` with a maximum key count if truly arbitrary metadata
is needed.

| Reference                                 | File                                             | Line    |
| ----------------------------------------- | ------------------------------------------------ | ------- |
| discoveryState passthrough (with CAUTION) | `apps/search-ai/src/routes/crawl-drafts.ts`      | 113-116 |
| metadata passthrough                      | `apps/search-ai/src/routes/crawler-ingestion.ts` | 58      |

---

## S10 [LOW]: WebSocket JWT Not Re-Validated After Upgrade

The progress WebSocket verifies the JWT during the HTTP upgrade handshake. Once the connection is
open, the token is never checked again. If the user's session is revoked or the token expires
while a progress connection is active, the connection stays alive until the client disconnects.

For progress streaming, this is low risk. The connection is read-only (the client only receives
events, never sends commands). The connection duration is bounded by crawl job length (typically
5-60 minutes). The exposure is limited to seeing progress events for a job the user was already
authorized to see when they connected.

**Recommendation:** This is a nice-to-have, not urgent. If addressed, check the token expiry
timestamp on each heartbeat cycle. If expired, close the connection with WS code 1008 (Policy
Violation). This piggybacks on the heartbeat interval from Problem 1 and adds minimal overhead.

| Reference                    | File                                    | Line     |
| ---------------------------- | --------------------------------------- | -------- |
| JWT verified once at upgrade | `apps/search-ai/src/routes/progress.ts` | 158-167  |
| No subsequent validation     | `apps/search-ai/src/routes/progress.ts` | (absent) |

---

## S11 [INFORMATIONAL — Reclassified]: Team-Level Job Cancellation

The cancel endpoint checks tenant ownership but not user ownership. Any authenticated user in
a tenant can cancel any crawl job belonging to that tenant, even if they didn't submit it.

The original version of this plan classified this as a LOW security finding. On review, this is
better understood as a **design decision**, not a security gap. In most enterprise SaaS products,
team members can manage shared resources — cancelling a teammate's long-running job is a
collaboration feature, not a vulnerability. The draft model's stricter `createdBy` check makes
sense for personal drafts (private work-in-progress), but jobs are shared team resources.

If there's a future requirement for job-level access control (e.g., only admins can cancel), it
should be implemented as a feature with proper permission checks, not as a security fix.

**Recommendation:** No change needed. If desired, add a permission check so only the job creator
or users with an admin role can cancel. But this is a product decision, not a security one.

| Reference                                  | File                                        | Line    |
| ------------------------------------------ | ------------------------------------------- | ------- |
| Cancel — tenant check only                 | `apps/search-ai/src/routes/crawl.ts`        | 2887    |
| Drafts — user check enforced (intentional) | `apps/search-ai/src/routes/crawl-drafts.ts` | 618-671 |

---

## What's Clean (Audited and Properly Secured)

These areas were thoroughly audited and found to be correctly implemented:

- **Route authentication**: Global `authMiddleware` at the `/api` mount point plus per-route
  `req.tenantContext` checks. No routes are missing auth.
- **Tenant isolation in queries**: Every MongoDB query includes `tenantId`. No use of `findById()`
  without a tenant scope. This is exactly what the platform invariants require.
- **Draft ownership**: Write operations enforce `createdBy: userId`. Cross-user reads are
  intentional and limited to status information.
- **S3 path construction**: Uses content hashes and MongoDB ObjectIds. No user-controlled path
  components, so path traversal is not possible.
- **Cookie/credential forwarding**: No mechanism exists for forwarding user credentials to
  downstream services. This is correct — workers operate on enqueued job data, not on behalf of
  live user sessions.
- **Cross-scope response**: Returns 404 (not 403) for cross-tenant access attempts. This follows
  the platform convention of not leaking resource existence.
- **BullMQ job data**: Jobs are only enqueued through authenticated routes with JWT-verified
  tenantId. The job data itself carries the tenantId for worker-side authorization.

---

## Security Priority Matrix

| #   | Finding                                   | Severity | Effort | Recommendation                                         |
| --- | ----------------------------------------- | -------- | ------ | ------------------------------------------------------ |
| S1  | SSRF redirect bypass in HttpAdapter       | **HIGH** | Medium | Replace with safe-fetch or per-hop redirect validation |
| S3  | Discovery endpoint missing SSRF           | MEDIUM   | Small  | Add `isPrivateOrUnsafeUrl()` checks                    |
| S4  | Discovery endpoint missing Zod validation | MEDIUM   | Small  | Add Zod schema with bounded fields                     |
| S7  | Error message leakage (7 locations)       | MEDIUM   | Small  | Generic messages in responses, full errors in logs     |
| S8  | 50MB Express body limit                   | MEDIUM   | 1 line | Reduce to 12MB                                         |
| S5  | Stored HTML without XSS sanitization      | MEDIUM   | Medium | Add DOMPurify to cleaned HTML path                     |
| S9  | Zod .passthrough() in 2 schemas           | MEDIUM   | Medium | Define explicit schemas, switch to .strict()           |
| S2  | Batch endpoint rate limit (enhancement)   | LOW      | Small  | Optional: add per-endpoint stricter limit              |
| S6  | MCP no authentication                     | LOW      | Small  | Add shared secret via headers field                    |
| S10 | WS JWT not re-validated                   | LOW      | Small  | Check expiry on heartbeat cycle                        |
| S11 | Team-level cancel (design decision)       | INFO     | —      | No change needed; product decision if restricted       |

---

# Part 3: Architecture Alternatives

This section evaluates the current architectural patterns against alternatives. For each area:
what we do now, what else could be done, what the pros and cons are, and what we recommend.

---

## The Progress Transport Question: Why WebSocket Is Correct

An earlier version of this plan recommended replacing WebSocket with SSE for crawl progress
streaming. After deeper analysis, that recommendation was wrong. Here's why, and what we
actually recommend.

### The Case That Was Made for SSE

The argument went: progress is unidirectional (server→client), SSE has built-in browser
reconnection, SSE works through proxies without upgrade negotiation, and the code is simpler.
These points are all true.

### Why It Falls Apart

**SSE doesn't solve the core problems.** Every infrastructure issue (P1-P6) is about the
fan-out architecture and connection lifecycle management, not the transport. Switching to SSE
would still require a shared subscriber pool (P2), capacity management (P6), dead connection
detection (P1), and stale sweeps (P4). You'd solve the same problems with different syntax.

**HTTP/1.1 connection limits.** The platform runs `http.createServer()` — plain HTTP/1.1.
Browsers enforce a limit of 6 concurrent connections per origin on HTTP/1.1. Each SSE connection
holds one of those 6 slots for the entire duration of the crawl (5-60 minutes). A user watching
crawl progress with SSE + making normal API calls + loading Studio assets could exhaust their
connection budget. New API requests would queue behind the SSE connection. WebSocket connections
are upgraded and don't count against the HTTP/1.1 limit.

**The platform's own architecture disagrees.** Runtime uses SSE for LLM chat streaming (short-
lived, seconds) and WebSocket for agent conversations (long-lived, minutes-hours). The pattern
is SSE for ephemeral streams, WebSocket for persistent connections. Crawl progress is a
persistent connection. Following the platform pattern means using WebSocket.

**Migration cost for no benefit.** Replacing WebSocket with SSE requires rewriting the server
endpoint, changing the frontend hooks (`useCrawlProgress`, `useMultiPageProgress`), updating
the Studio API layer, and testing the new transport end-to-end. All of this effort goes toward
changing the transport, which isn't the source of any of the real problems.

### Recommendation

**Keep WebSocket. Fix Problems 1-6 using patterns from Runtime.** The WebSocket transport is
correct for this use case. The problems are all in the connection lifecycle and fan-out
architecture, which are independent of transport choice. After applying the fixes:

- Dead clients are detected and terminated (Problem 1, via Runtime heartbeat pattern)
- Redis connections scale with jobs, not clients (Problem 2, via shared subscriber pool)
- One timer manages all connections (Problem 3, via shared heartbeat interval)
- Stale connections are swept periodically (Problem 4, via Runtime sweep pattern)
- Payload size is bounded (Problem 5, via maxPayload)
- Capacity is checked before resource allocation (Problem 6, via upgrade-time rejection)

The result is a WebSocket server that matches Runtime's quality, using proven platform patterns.

---

## BullMQ `job.updateProgress()` as a Complementary Mechanism

### What It Is

BullMQ workers can call `job.updateProgress(data)` to store progress state on the job's Redis
hash key. This is stored state — it persists in Redis and can be read by polling
`GET /api/crawl/status`. 21 other workers in the codebase already use it. The bulk-crawl worker
is the notable exception.

### Why It's Complementary, Not a Replacement

`job.updateProgress()` is poll-based, not push-based. The frontend would need to poll the status
endpoint every few seconds to see updated progress. For a crawl that processes hundreds of URLs,
this creates a tradeoff: poll too frequently and you waste bandwidth; poll too slowly and the UI
feels laggy. Redis pub/sub + WebSocket delivers events the instant they happen, with zero polling
overhead.

### What It Adds That Pub/Sub Doesn't

**Crash recovery.** If a pod restarts, the pub/sub channel is gone and the WebSocket connection
drops. With `job.updateProgress()`, the last-known progress is stored in Redis as part of the
job's data structure. When the frontend reconnects, it can poll the status endpoint to get the
most recent progress before resubscribing to the WebSocket for live events. This eliminates the
"blank progress bar after reconnect" problem.

**Coarse-grained state for dashboards.** If a future admin dashboard shows all active crawl
jobs across tenants, polling `job.updateProgress()` data is more efficient than maintaining
WebSocket connections to every active job.

### Recommendation

Add `job.updateProgress()` calls to the bulk-crawl worker for coarse percentage updates (e.g.,
`{ completed: 45, total: 200, percentage: 22 }`). Keep the pub/sub events for fine-grained
per-URL progress. The two mechanisms serve different purposes and work well together — 21 other
workers already prove this pattern works.

---

## Discovery: Moving from In-Process to Worker

### The Current Situation

Discovery runs as an in-process async operation within the Express request lifecycle. State is
stored in a `Map<string, CrawlState>` in server memory. Progress is streamed via SSE. This works
on a single pod but can't scale horizontally (see Problem 8).

### What Moving to a BullMQ Worker Solves

1. **Multi-pod deployment.** State lives in Redis, not pod memory. Any pod can check discovery
   progress or resume after a restart.
2. **Resilience.** BullMQ automatically retries failed jobs. If a pod crashes during discovery,
   the job is re-queued.
3. **Unified infrastructure.** Discovery and crawl use the same worker infrastructure, the same
   progress publishing, and the same monitoring.

### What It Costs

**State serialization complexity.** The discovery frontier is an in-memory data structure with
scored URLs, visited sets, and pattern matchers. Moving this to Redis means serializing the
frontier state on every batch of URL checks. The Redis round-trip itself is fast (sub-millisecond
for a co-located instance), but serializing and deserializing a complex data structure on every
operation adds overhead. The design should use coarse-grained state syncs (e.g., checkpoint the
frontier every 10-20 URLs, not on every single URL check) to keep this manageable.

**Operational complexity.** A new queue, a new worker, new Redis keys to manage, new monitoring
to add. Discovery is currently simple — one function, one Map, one SSE stream. Making it a
distributed system adds moving parts.

### Alternatives Considered

**Redis state + keep SSE transport.** This solves the scaling problem but keeps two streaming
transports (SSE for discovery, WebSocket for crawl). Maintenance cost of two systems.

**BullMQ worker + WebSocket progress.** Full unification. Discovery events go through
`publishProgressEvent()` and the existing WebSocket infrastructure. One streaming system for
everything. Higher migration cost but lower ongoing maintenance.

### Recommendation

BullMQ worker + WebSocket progress (full unification). Once Problems 1-6 are fixed, the WebSocket
infrastructure will be production-grade. Having two real-time transports doubles the maintenance
surface. One system means one heartbeat implementation, one connection pool, one capacity strategy,
and one set of frontend hooks. The migration cost is a one-time investment; the simplification
pays off permanently.

---

## Per-Section BullMQ Flows for Crawl Jobs

### The Current Situation

A crawl job is one monolith BullMQ job that processes all URLs across all sections with an
internal sliding window of 5 concurrent URL fetches. If one section fails, the entire job fails.
There's no way to retry a single section. All processing happens on one worker on one pod.

### What Per-Section Flows Would Solve

BullMQ Flows allow parent-child job relationships. The parent job represents the crawl, and each
section becomes a child job. Each child processes its own URL list with its own sliding window.

1. **Section-level retry.** If one section fails, only that child retries. The other sections'
   results are preserved.
2. **Natural parallelism.** Child jobs can run on different workers on different pods. A 5-section
   crawl with 10,000 URLs becomes 5 jobs of 2,000 URLs, potentially running on 5 different pods.
3. **Clean alignment with data model.** The `sectionMapping` in job data already partitions URLs
   by section. Flows would make this partition explicit at the job level.

### What It Costs

**Progress aggregation.** The parent needs to combine progress from multiple children. Currently
one job publishes one stream of events. With flows, each child publishes its own events, and the
frontend (or a parent aggregator) needs to merge them into a unified progress view.

**New usage pattern.** The codebase uses `FlowProducer` in 3 production files, but not for
parent-child DAG orchestration. The ingestion pipeline uses FlowProducer as a validated job
creator — workers chain independently by enqueuing the next stage, not through Flow child
dependencies. Per-section Flows would be the first real use of BullMQ's DAG capabilities. This
is a new pattern to establish and maintain.

**More Redis operations.** Job creation, state tracking, and progress updates per child instead
of one flat job. For a typical crawl with 3-20 sections, this is moderate overhead.

### Recommendation

Worth implementing when the worker is refactored, but not urgent. The current monolith worker
works correctly. The per-section model becomes important when: (a) section-level retry is a user
need (currently it isn't — a failed crawl is simply re-run), or (b) multi-pod parallelism is
needed to meet throughput requirements. Queue this behind Problems 1-8 and the security fixes.

| Reference                    | File                                                                 | Line    |
| ---------------------------- | -------------------------------------------------------------------- | ------- |
| FlowProducer usage (current) | `apps/search-ai/src/services/pipeline-orchestration/flow-builder.ts` | 18, 482 |
| sectionMapping in job data   | `apps/search-ai/src/workers/shared.ts`                               | 587-593 |
| BullMQ Flows guide           | `docs/searchai/BULLMQ-FLOWS-PRODUCTION-GUIDE.md`                     | —       |

---

## AbortController for Cooperative Cancellation

### The Current Situation

The bulk-crawl worker checks for cancellation by polling a Redis key (`crawl:cancel:{jobId}`)
once per sliding window iteration. The window size is 5 URLs, meaning up to 5 URLs are dispatched
concurrently and must all complete before the next cancel check. If each URL takes 10 seconds,
the worst-case cancellation latency is ~50 seconds (5 URLs x 10 seconds each). The typical case
is less dramatic but still noticeable — the user clicks cancel and waits several seconds before
anything happens.

### What AbortController Solves

`AbortController` is the standard Node.js pattern for cooperative cancellation. You create a
controller, pass its `signal` to every HTTP request (`fetch`, `axios`), and call
`controller.abort()` when cancellation is requested. In-flight HTTP requests are immediately
cancelled — the TCP connection is torn down and the pending promise rejects with `AbortError`.

This changes worst-case cancellation from "wait for N URLs to complete" to "immediate" — the
cancel happens mid-request, not at the next batch boundary.

### What It Doesn't Solve

**MCP/Playwright operations.** The MCP client that drives Playwright browser rendering doesn't
support `AbortSignal`. Pages being rendered via Playwright will still complete before
cancellation takes effect. For crawls that use Playwright heavily, the improvement is partial.

### Pros and Cons

**Pros:** Near-instant cancellation for HTTP-fetched pages. Standard Node.js pattern. Both axios
and native fetch support it natively. Low implementation effort — thread the signal through
`processUrl()` to every fetch call.

**Cons:** Need to handle `AbortError` gracefully in every catch block (don't log it as a failure,
it's intentional). The signal must be plumbed through the entire call chain, which touches
several functions. Playwright pages aren't cancellable via this mechanism.

### Recommendation

Implement this. It's low effort, improves user experience meaningfully, and uses the standard
platform pattern. Handle the MCP limitation by documenting it — Playwright pages complete their
current operation before the worker stops processing new URLs.

| Reference                 | File                                              | Line    |
| ------------------------- | ------------------------------------------------- | ------- |
| Cancel check per window   | `apps/search-ai/src/workers/bulk-crawl-worker.ts` | 459-464 |
| WINDOW_SIZE = 5           | `apps/search-ai/src/workers/bulk-crawl-worker.ts` | 60      |
| isCancelled() Redis check | `apps/search-ai/src/workers/bulk-crawl-worker.ts` | 183-186 |

---

## Sorted Set Semaphore for Tenant Concurrency

### The Current Situation

The per-tenant concurrency semaphore uses a Redis INCR/DECR pattern with a Lua script. To
acquire a slot, the script INCRs the counter and checks if it exceeds the maximum (20). If so,
it DECRs and returns failure. The key has a 120-second TTL.

The problem is crash recovery. If a worker crashes between INCR (acquire) and DECR (release), the
counter stays inflated. The TTL is supposed to handle this — after 120 seconds of no activity, the
key expires and the counter resets. But there's a subtlety the plan originally understated: the
EXPIRE command runs on every INCR, including concurrent acquires from other jobs. If the tenant
has multiple active crawls, each acquire refreshes the TTL. The counter stays inflated as long as
ANY crawl is actively acquiring slots, which could be hours for a tenant running continuous crawls.
The 120-second recovery window only starts when all crawling stops.

### What a Sorted Set Semaphore Solves

Instead of a single counter, each acquired slot is a ZADD entry in a sorted set, with
`score = expiry timestamp` and `member = {jobId}:{urlIndex}`. Before checking capacity, a
cleanup function runs `ZREMRANGEBYSCORE` to remove entries whose score (expiry) is in the past.
Then it checks `ZCARD` against the maximum.

1. **Per-slot expiry.** Each slot expires independently. A crashed job's slots expire after their
   individual TTL (e.g., 120 seconds) regardless of what other jobs are doing.
2. **Debuggability.** You can `ZRANGE` the set to see exactly which slots are held, by which job,
   with what expiry. The INCR/DECR counter tells you nothing about who's holding slots.
3. **No TTL refresh problem.** Each entry has its own fixed expiry score. Other jobs' acquires
   don't reset existing entries' expiry.

### Pros and Cons

**Pros:** Self-healing per slot. Full visibility into who holds what. No cascading TTL refresh
problem. Standard distributed semaphore pattern.

**Cons:** More Redis operations per acquire/release (ZADD + ZREMRANGEBYSCORE + ZCARD vs INCR +
EXPIRE). Slightly more complex Lua script. The existing INCR/DECR pattern works correctly in the
normal case — this matters only for crash recovery and debugging.

### Recommendation

Medium priority. Implement when the semaphore is next touched. The INCR/DECR pattern works day-
to-day but fails ungracefully on crashes, especially for tenants with continuous crawl activity.
The sorted set pattern is a strict upgrade in reliability and debuggability.

| Reference            | File                                              | Line   |
| -------------------- | ------------------------------------------------- | ------ |
| INCR/DECR Lua script | `apps/search-ai/src/workers/bulk-crawl-worker.ts` | 93-104 |
| SEMAPHORE_MAX = 20   | `apps/search-ai/src/workers/bulk-crawl-worker.ts` | 78     |
| SEMAPHORE_TTL = 120  | `apps/search-ai/src/workers/bulk-crawl-worker.ts` | 81     |

---

## URL Bucket Storage Pattern — No Change Needed

The current URL storage uses a MongoDB bucket pattern: URLs are stored in documents of 500 URLs
each (`CrawlDraftUrlBucket` model, `URL_BUCKET_SIZE = 500`). This was evaluated against storing
URLs directly in the `CrawlDraft` document, using Redis sorted sets, and using a standalone URLs
collection.

The bucket pattern is the right choice. It avoids MongoDB's 16MB BSON limit (a 50,000-URL crawl
would be ~5MB in a single document — close to the limit with metadata). It provides O(1)
pagination via bucket index math. It supports efficient bulk writes. And it's durable across
restarts, unlike Redis-based alternatives.

No change recommended.

| Reference              | File                                                           | Line      |
| ---------------------- | -------------------------------------------------------------- | --------- |
| URL_BUCKET_SIZE = 500  | `packages/database/src/models/crawl-draft-url-bucket.model.ts` | 21        |
| Bucket write in drafts | `apps/search-ai/src/routes/crawl-drafts.ts`                    | 757-758   |
| Bucket read in crawl   | `apps/search-ai/src/routes/crawl.ts`                           | 1681-1682 |

---

# Consolidated Roadmap

Everything across all three parts, in recommended implementation order.

## Immediate (1-2 days): Security Hardening

These are code-level fixes that don't change architecture:

- **S1** — Replace HttpAdapter's axios redirect following with per-hop SSRF validation
- **S3** — Add SSRF checks to discovery and deepen endpoints
- **S4** — Add Zod schema to discovery endpoint
- **S7** — Replace 7 error.message leaks with generic messages
- **S8** — Reduce Express body limit from 50MB to 12MB
- **P5** — Add maxPayload: 64KB to WebSocket server

## Short-term (1-2 days): WebSocket Infrastructure

Fix the progress WebSocket using patterns from Runtime:

- **P6** — Move capacity check to upgrade handler
- **P1 + P3 + P4** — Single shared heartbeat with liveness detection and stale sweep
- **P2** — ChannelSubscriptionPool (shared Redis subscriber per channel)
- **P7** — Migrate connector SyncProgressPublisher to publishProgressEvent()
- **Dead code** — Remove 3 dead files

## Medium-term (2-3 days): Security Depth

Defense-in-depth improvements:

- **S5** — Add DOMPurify to cleaned HTML in ingestion pipeline
- **S9** — Replace .passthrough() with explicit Zod schemas
- **S6** — Add shared secret to MCP connection
- **AbortController** — Thread abort signal through processUrl() for instant cancellation
- **job.updateProgress()** — Add coarse progress tracking to bulk-crawl worker

## Strategic (1-2 weeks): Architecture Evolution

Larger changes that require design work:

- **P8** — Migrate discovery from in-process SSE to BullMQ worker + WebSocket
- **Per-section Flows** — When worker refactoring is needed
- **Sorted set semaphore** — When semaphore is next touched

---

## Review History

| Date       | Change                  | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-05-06 | Initial plan            | 8 infra problems, 11 security findings, 7 architecture alternatives                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2026-05-06 | Full independent review | S2 downgraded HIGH→LOW (global rate limit exists). S6 downgraded MEDIUM→LOW (K8s sidecar). S7 updated 4→7 locations. S11 reclassified as design decision. A1 (SSE recommendation) reversed — WebSocket is correct transport for long-lived progress. A3 latency claim corrected. A4 FlowProducer usage clarified. A5 MCP/Playwright limitation added. A6 TTL refresh cascading issue documented. Platform real-time strategy section added. All sections rewritten for natural language with problem/solution/recommendation structure. |

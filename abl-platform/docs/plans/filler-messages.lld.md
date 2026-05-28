# Filler Messages — Low-Level Design

## Task T-1: Core FillerMessageService

### Files Modified

- `apps/runtime/src/services/filler/filler-service.ts` — Per-session filler queue
- `apps/runtime/src/services/filler/types.ts` — StatusEvent, FillerConfig, QueuedFiller
- `apps/runtime/src/services/filler/message-pools.ts` — Static operation and tool-specific pools
- `apps/runtime/src/services/filler/index.ts` — Barrel exports

### Function Signatures

- `FillerMessageService(sessionId: string, config: FillerConfig, onEmit: (event: StatusEvent) => void)` — constructor
- `queueFiller(operation: StatusOperation, text: string, source: 'pipeline' | 'piggybacked' | 'static'): void` — queue with delay gate
- `setPipelineFiller(text: string): void` — set pipeline-generated filler for next operation
- `consumePipelineFiller(): string | null` — get-and-consume pipeline filler
- `cancel(): void` — cancel pending filler
- `resetTurn(): void` — reset per-turn counters
- `destroy(): void` — cleanup all timers
- `getFillerMessage(operation: StatusOperation, recentHistory?: string[], toolName?: string): string` — select from static pool

### Subtasks

1. ST-1.1: Define types (StatusEvent, StatusOperation, FillerConfig, QueuedFiller, DEFAULT_FILLER_CONFIG)
2. ST-1.2: Implement FillerMessageService with delay gate, cooldown, per-turn cap
3. ST-1.3: Implement static message pools with tool-specific overrides
4. ST-1.4: Add pipeline filler priority (pipeline/piggybacked bypass delay)

### Acceptance Criteria

- AC-1: Given a `tool_call` operation and no pipeline filler, When 1.2s passes, Then a static filler is emitted
  - Verify: `pnpm test --filter=runtime -- filler-service`
- AC-2: Given a pipeline filler set, When a tool_call event fires, Then the pipeline filler is emitted immediately (0 delay)
- AC-3: Given 5 fillers already emitted in a turn, When a 6th is queued, Then it is silently dropped

---

## Task T-2: Pipeline Filler Generation

### Files Modified

- `apps/runtime/src/services/filler/pipeline-filler.ts` — LLM-based contextual filler

### Function Signatures

- `generatePipelineFiller(model: LanguageModel, userMessage: string): Promise<string | null>` — generate filler or null on failure

### Subtasks

1. ST-2.1: Build prompt template with under-12-word constraint
2. ST-2.2: Implement generateText call with 2s AbortSignal timeout
3. ST-2.3: Handle NONE response (simple greetings), quote stripping, ellipsis normalization
4. ST-2.4: Graceful fallback on timeout/error (return null)

### Acceptance Criteria

- AC-1: Given "I need to find running shoes under $100", When generatePipelineFiller is called, Then a contextual filler like "Searching for running shoes..." is returned
  - Verify: `pnpm test --filter=runtime -- pipeline-filler`
- AC-2: Given "hello", When generatePipelineFiller is called, Then null is returned (NONE response)

---

## Task T-3: StatusTagParser

### Files Modified

- `apps/runtime/src/services/filler/status-tag-parser.ts` — Streaming `<status>` tag interceptor

### Function Signatures

- `StatusTagParser.processChunk(chunk: string): StatusTagParserResult` — process chunk, return cleaned output and extracted status
- `StatusTagParser.flush(): string` — flush buffered content at end of stream

### Subtasks

1. ST-3.1: Implement streaming parser with open/close tag detection
2. ST-3.2: Handle tags split across multiple chunks via buffer
3. ST-3.3: Implement partial opening tag detection (`findPartialOpenTag`)
4. ST-3.4: Buffer overflow protection (256 bytes max, flush as text)
5. ST-3.5: End-of-stream flush for incomplete tags

### Acceptance Criteria

- AC-1: Given chunks `["<status>Searching", "...</status>Hello"]`, When processed, Then outputChunk is "Hello" and statusText is "Searching..."
  - Verify: `pnpm test --filter=runtime -- status-tag-parser`

---

## Task T-4: Voice Channel Adapter

### Files Modified

- `apps/runtime/src/services/filler/channel-adapters/voice-filler-adapter.ts` — Voice bridge

### Function Signatures

- `VoiceChannelFillerAdapter(config: VoiceFillerAdapterConfig)` — constructor
- `handleStatusEvent(event: StatusEvent): void` — route to TTS or Jambonz
- `getFillerText(operation: StatusOperation): string` — get filler from pool
- `destroy(): void` — prevent further emissions

### Subtasks

1. ST-4.1: Implement realtime mode (sendAudio with UTF-8 buffer)
2. ST-4.2: Implement pipeline mode (Jambonz `say` verb)
3. ST-4.3: Barge-in and response-imminent suppression
4. ST-4.4: Recent message tracking for repetition avoidance

### Acceptance Criteria

- AC-1: Given realtime mode and a StatusEvent, When handleStatusEvent is called, Then session.sendAudio is called with the filler text
  - Verify: `pnpm test --filter=runtime -- voice-filler-adapter`
- AC-2: Given barge-in is active, When handleStatusEvent is called, Then the filler is suppressed

---

## Dependencies

- `ai` package (Vercel AI SDK) — for `generateText` in pipeline filler
- Pipeline model resolution — for obtaining the LanguageModel instance
- WebSocket message infrastructure — for delivering StatusEvents to clients
- Voice subsystem (Jambonz, realtime TTS) — for voice adapter integration

## Exit Criteria

- All unit and integration tests pass: `pnpm test --filter=runtime -- filler`
- No timer leaks on session destroy (verified by destroy test)
- Pipeline filler never blocks the primary response path (2s hard timeout)
- Static fillers never repeat within a turn when the pool is large enough

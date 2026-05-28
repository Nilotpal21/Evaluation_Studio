# packages/web-sdk — Agent Learnings

## 2026-05-03 — ABLP-612 React ActionHandler Form Submit Parity

- The exported React `ActionHandler` is a public renderer surface and must preserve the same submit envelope as the template renderer: `actionId`, JSON string value, `renderId`, and structured `formData`.
- When `submit_id` is present, input/select controls should defer to the submit button instead of emitting partial per-control actions.
- Keep React component regressions in `src/__tests__/react-components.test.tsx` aligned with template renderer form regressions.

## Build & Test

- Package name is `@agent-platform/web-sdk`. Use `pnpm test --filter=@agent-platform/web-sdk` or `pnpm build --filter=@agent-platform/web-sdk`.
- Build: `vite build && tsc --emitDeclarationOnly`. Typecheck: `tsc --noEmit -p packages/web-sdk/tsconfig.json`.
- Tests use `vitest` with `happy-dom` environment (configured in `vitest.config.ts`).
- Tests pass with `--passWithNoTests` flag.

## Testing Patterns

- **MockTransport pattern (preferred for ChatClient tests)**: Since Phase 1, ChatClient takes SDKTransport as first constructor arg. Tests should create a `MockTransport` extending `TypedEventEmitter<{ message: TransportServerMessage; ... }>` with `isConnected()`, `getSessionId()`, `send = vi.fn()`, and `simulateMessage()`. Messages must be in `TransportServerMessage` format (e.g., `content` not `fullText`, `response_start` needs `messageId`).
- **MockSessionManager (legacy — still used by SessionManager tests and omnichannel)**: Tests create a `MockSessionManager` extending `TypedEventEmitter<SessionEvents>` with stubbed `isConnected()`, `getSessionId()`, `send()`, and a `simulateMessage()` helper that emits on the 'message' event. Used by VoiceClient and SessionManager tests. For ChatClient omnichannel tests, pass as 4th constructor arg.
- **Widget tests**: Access private state via `(widget as any).fieldName` pattern. Set `isMinimized = false` and call `render()` to test DOM output. Query shadow DOM via `widget.shadowRoot!.querySelector()`.
- **SessionManager omnichannel self-listener**: Omnichannel message dispatch (transcript_item, participant events) is triggered via a self-listener in the constructor (`this.on('message', ...)`), NOT in the private `handleMessage` method. This ensures handlers fire both for real WS messages and test-emitted messages.

## Gotchas

- `SessionManager.handleMessage()` is private and only called from the WebSocket `onmessage` handler. To test message handling, emit 'message' directly on the SessionManager instance.
- `TypedEventEmitter.on()` returns an unsubscribe function. Use this pattern for cleanup.
- WebSocket constructor is resolved from config or globalThis. Tests must provide a mock via `webSocketConstructor` in SDKConfig.
- The `Message` interface has optional `sourceChannel` and `inputMode` fields (added for omnichannel). Existing code that doesn't set these fields remains compatible.
- `AgentSDK.getSessionManager()` is public — used by widgets and advanced integrations that need direct session-level APIs.
- **ChatClient constructor changed (Phase 1)**: `ChatClient(transport, uploadConfig?, debug?, sessionManager?)`. Old tests using `(sessionManager as any, false)` need updating to `(transport as any, undefined, false, sessionManager as any)`.
- **TransportServerMessage uses `content` not `fullText`**: DefaultTransport maps `fullText ?? text` to `content`. Tests simulating messages to ChatClient must use TransportServerMessage format.
- **unbounded-collections hook**: The `.claude/hooks/unbounded-collections.sh` hook blocks writes with `new Set(` or `new Map(` in packages/\*/src/\*.ts unless the file contains `MAX_SIZE`, `.delete()`, `.clear()`, `evict`, or similar patterns. ChatClient uses `MAX_MESSAGES` + `evictOldMessages()` to satisfy this.
- **DefaultTransport overload `on()` method**: TypeScript overload implementation must use `any` params to be compatible with all overload signatures. This is the pattern used for SDKTransport interface compliance.

## Patterns That Work Well

- **Self-listener pattern for cross-concern dispatch**: Instead of calling omnichannel handlers inline in `handleMessage`, subscribing to the own class's events ensures all emission paths (WS handler, test helpers, etc.) trigger the handlers.
- **Unsubscribe function pattern**: `onTranscriptItem()` and `onParticipantChange()` return `() => void` unsubscribe functions, matching the existing `EventEmitter.on()` pattern.
- **Safe parsers with defaults**: `parseTranscriptItems()` and `parseParticipants()` handle malformed data gracefully with fallback values.
- **Transport abstraction pattern**: SDKTransport is the clean messaging interface. HTTP upload concerns are separated into ChatUploadConfig. SessionManager is only needed for omnichannel (subscribeLiveTranscript). This separation allows transport-only callers (e.g., Studio) to use ChatClient without creating a full AgentSDK.
- **DefaultTransport translateMessage null return**: Unknown/internal message types (session_start, pong) return null from translateMessage and are silently dropped. Only the 9 TransportServerMessage types propagate to consumers.
- **React component testing with providers**: Components using `useStrings()` must be wrapped in `StringsProvider` in tests. Use a `withStrings(element)` helper to avoid boilerplate.
- **CSS custom properties for theming**: All SDK components use `var(--sdk-*, fallback)` — works without SDKThemeProvider wrapping (falls back to defaults). SDKThemeProvider sets the vars on a wrapper div.
- **AgentProvider Path A / Path B pattern**: `transport` prop determines path. Path B (transport-only) creates ChatClient directly, no AgentSDK. Voice returns safe defaults. Theme/strings providers wrap children when props are provided.
- **children? optional in provider props**: React.createElement passes children as 3rd positional arg, but TypeScript checks the props object against the interface. Making `children?: React.ReactNode` optional avoids needing to include children in the props object.
- **exported-symbol-guard hook**: When rewriting a file that previously had `export function/interface/type` declarations into a re-export file, ensure the symbol names still appear in the new content (even as re-export names). The hook grep-checks for word matches. Re-export syntax like `export { RichContent }` satisfies the check.
- **EchoTransport test pattern**: The `echo-transport.test.ts` file demonstrates how third-party consumers implement SDKTransport. It validates the full interface contract (connect, disconnect, isConnected, send, on with all 4 event types, getSessionId, capabilities). Use it as a reference for testing custom transport implementations.
- **Studio integration via transport adapter**: Studio uses `useStudioTransport()` hook (in Studio repo) that implements SDKTransport backed by Studio's WebSocketContext. The hook translates Studio's ServerMessage to TransportServerMessage and filters out non-chat messages. This is the canonical example of AgentProvider Path B usage.

## 2026-04-03 — Post-Cutover Regression Guards

- `packages/web-sdk/src/__tests__/chat-client-session-switch.test.ts` is the regression guard for session carryover after Studio session switches. Keep it when touching `ChatClient` lifecycle subscriptions or `useStudioTransport` reconnect behavior.
- `packages/web-sdk/src/__tests__/strings-provider-nesting.test.tsx` protects the double-wrap localization bug where an inner `StringsProvider` with `strings={undefined}` clobbers outer localized strings.
- Browser coverage for the consolidated chat now lives in `apps/studio/e2e/sdk-chat-consolidation-e2e.spec.ts` and `apps/studio/e2e/sdk-chat-performance.spec.ts`, not inside this package.

**Impact**: Future web-sdk chat work should update package-local unit/integration tests and the Studio-hosted browser suites together. Package-only test passes are no longer enough to claim the chat consolidation is covered.

## 2026-04-05 — Vanilla Widget XSS Hardening

- Use `escapeHtml()` for any vanilla-widget value interpolated into text or attribute contexts (`placeholder`, transcripts, status text, fallback response text). `sanitizeHtml()` is for HTML fragment contexts (`welcome-message`, thought panel, rich HTML, and markdown after `renderMarkdown()`).
- `renderMarkdown()` must reject unsafe link/image URLs itself, not only rely on downstream `sanitizeHtml()`, because `renderMarkdown()` is exported and some consumers may insert its output directly.
- Keep the widget XSS regression coverage in `src/__tests__/sanitize-html.test.ts`; it now exercises real `ChatWidget`, `UnifiedWidget`, and `VoiceWidget` shadow-DOM renders for the known sink points.

**Impact**: Future widget or renderer changes should preserve the split between escaped text/attributes and sanitized HTML fragments, and they should update the widget regression tests when new innerHTML sinks are introduced.

## 2026-04-06 — VoiceClient Lifecycle Teardown

- `VoiceClient` now owns the `SessionManager` message subscription explicitly: `start()` must call `setupMessageHandlers()` before the voice handshake, and `stop()`/`dispose()` must tear it down so idle or discarded clients do not keep reacting to session traffic.
- `VoiceClient.stop()` is async because realtime teardown must await `RealtimeAudioPlayer.destroy()`. Provider/widget callers may intentionally fire-and-forget, but cleanup paths such as `AgentProvider` should use `void voiceClient.dispose()` rather than `removeAllListeners()`.
- The most stable lifecycle tests use realtime mode with stubbed `AudioContext` and `navigator.mediaDevices.getUserMedia`, which exercises the real `start()`/`stop()` path without bringing `AudioCapture` or optional VAD dependencies into the test.

**Impact**: Future voice lifecycle work should preserve attach-on-start / detach-on-stop symmetry, keep blob URL revocation centralized in `stopPipelineAudio()`, and extend the realtime lifecycle tests when changing teardown behavior.

## 2026-04-06 — VoiceClient Fire-and-Forget Stop Contract

- `VoiceClient.stop()` must perform its user-visible teardown synchronously before awaiting `RealtimeAudioPlayer.destroy()`: detach the session listener, stop pipeline/Twilio resources, send `voice_stop`, reset mode/transcript, and emit `idle` state before `AudioContext.close()` resolves.
- `RealtimeAudioPlayer.destroy()` should suppress final `onSpeakingChange(false)` callbacks during terminal teardown. Otherwise a realtime session that was mid-speech can flip `VoiceClient` back to `ready` after `stop()` has already transitioned it to `idle`.
- Keep a regression that calls `voiceClient.stop()` without `await` and asserts `idle` state plus `listenerCount('message') === 0` immediately. Multiple SDK and widget callers intentionally fire-and-forget stop/disconnect.

**Impact**: Future voice teardown changes must preserve the synchronous stop contract for `AgentSDK`, `VoiceWidget`, `UnifiedWidget`, and React provider cleanup paths even when the underlying audio backend closes asynchronously.

## 2026-04-06 — VoiceClient Lazy Session Wiring Tests

- `VoiceClient` must stay detached from `SessionManager` until `start()` (or an explicit test-only `setupMessageHandlers()` call) so idle clients do not keep consuming shared session traffic.
- Unit tests that inject raw `sessionManager.simulateMessage(...)` events without exercising `start()` should opt into that wiring explicitly and keep a regression that `listenerCount('message') === 0` immediately after construction.

**Impact**: Future VoiceClient tests should choose deliberately between the real start/stop lifecycle path and explicit low-level handler attachment; do not assume constructor-time session wiring exists.

## 2026-04-06 — Template Registry Match Errors & Chat Session Reset

- `TemplateRegistry.match()` should stay best-effort: when a renderer `extract()` throws, normalize the thrown value to `Error`, log a warning that includes the renderer type plus error message/stack, emit a typed `matchError` event, and continue matching later renderers.
- `ChatClient` transport disconnects are session-boundary cleanup points for transport-only consumers: clear local message history, cancel any pending auth-challenge auto-cancel timer, and emit `typing=false` if a response was mid-stream.
- Keep the regression coverage in `src/__tests__/template-registry.test.ts` and `src/__tests__/chat-client-session-switch.test.ts`; they now protect the new registry observability hook and the disconnect-driven typing reset.

**Impact**: Future template/transport debugging can subscribe to `matchError` instead of scraping console output, and any session-switch work must preserve disconnect-driven cleanup for both messages and transient UI state.

## 2026-04-06 — Omnichannel SessionManager Contract Tolerance

- `SessionManager` should treat the flattened runtime omnichannel payloads as canonical: `live_session_discovered` is top-level, `live_session_joined` carries `backfill`, and `transcript_item` is a flat item. Keep lightweight compatibility parsing for legacy wrappers (`data`, `item`, separate `transcript_backfill`, legacy participant `id/joinedAt/surface`) so mixed-version rollouts do not lose live-sync behavior.
- Omnichannel live-session messages remain outside `TransportServerMessage`; they flow through raw `WSServerMessage` and the session-level helpers (`discoverLiveSession`, `joinLiveSession`, `onTranscriptItem`, `onParticipantChange`).
- The regression coverage lives in `src/__tests__/session-manager-omnichannel.test.ts` and `src/__tests__/transport-types.test.ts`; update both whenever the runtime websocket contract or transport/session boundary changes.

**Impact**: Future SDK omnichannel fixes should update `core/types.ts` and `SessionManager.ts` together, preserve the compatibility shims unless the rollout explicitly drops old runtimes, and avoid leaking session-only omnichannel events into the transport abstraction.

## 2026-04-06 — Canonical Participant Shape

- The SDK `Participant` contract should stay aligned with the runtime canonical shape: `participantId`, `sessionId`, `contactId`, `surface`, `channel`, `mode`, `interactive`, and `attachedAt` are all required on the parsed object, even when legacy payloads omitted some of them on the wire.
- `SessionManager.parseParticipants()` should infer `surface` from the canonical channel fallback (`voice` -> `voice`, everything else -> `web`) and default missing `sessionId`/`contactId` to empty strings instead of returning a partial participant object.
- Keep regression coverage in `src/__tests__/session-manager-omnichannel.test.ts` for legacy discovery payloads so contract-tightening does not reintroduce the old `surface`/identity drift.

**Impact**: Future omnichannel SDK work should tighten exported types first, then make the compatibility parser satisfy that stricter contract rather than weakening the exported types.

## 2026-04-06 — Typed Interrupt Targeting & Widget Discovery

- `ChatClient.sendTypedInterrupt()` should resolve its session target from omnichannel state first: prefer `SessionManager.getTypedInterruptTargetSessionId()`, then a transport-level `getActiveLiveSessionId()`, and only fall back to the primary SDK session when no live session is joined.
- `UnifiedWidget` needs a best-effort discovery trigger in the real lifecycle. `open()` and reconnect-after-config-change should call a public `refreshLiveSessionDiscovery()` method that updates `discoveredSession` and the join prompt without surfacing discovery failures as chat errors.
- Keep the regressions in `src/__tests__/chat-client-transport.test.ts`, `src/__tests__/session-manager-omnichannel.test.ts`, and `src/__tests__/unified-widget-live-sync.test.ts`; they now guard the shared typed-interrupt target seam and the previously unreachable join prompt path.

**Impact**: Future web-sdk omnichannel work should centralize session-target resolution instead of re-deriving it in widgets or host apps, and widget UX changes should preserve the explicit discovery refresh seam so hosts can re-run discovery without rebuilding the SDK connection.

## 2026-04-06 — Omnichannel Helper Backward Compatibility

- `ChatClient` must treat `SessionManager` omnichannel helpers as optional at runtime. Test doubles and older host integrations may provide `onTranscriptItem()` without `getTypedInterruptTargetSessionId()`, so the typed-interrupt target resolution path should use optional-call guards and fall back to transport/session IDs instead of throwing.
- `UnifiedWidget.refreshLiveSessionDiscovery()` must fail closed when the injected `AgentSDK` mock lacks omnichannel helpers like `getActiveLiveSessionId()` or `discoverLiveSession()`. Discovery is a best-effort enhancement, not a bootstrap prerequisite.
- Keep the regression coverage in `src/__tests__/chat-backfill.test.ts` and `src/__tests__/widget-bootstrap-retry.test.ts`; they protect transport-only and widget bootstrap flows that use partial SDK mocks.

**Impact**: Future omnichannel API additions should preserve runtime duck-typing tolerance for package tests and host app mocks unless the public contract is explicitly versioned and migrated everywhere.

## 2026-04-06 — Omnichannel Contract Fixture Coverage

- Keep runtime websocket contract fixtures local to `packages/web-sdk/src/__tests__` instead of importing runtime app code into the package tests. The stable pattern is canonical SDK-side objects plus a JSON round-trip helper so `Date` fields become the same flattened ISO-string wire shape that `ServerMessages` emits.
- `session-manager-omnichannel.test.ts` should use those shared fixtures for canonical `live_session_discovered`, `live_session_joined`, `transcript_item`, and participant event coverage, while keeping legacy wrapper cases (`data`, legacy participant fields, standalone `transcript_backfill`) explicit in separate tests.
- `unified-widget-live-sync.test.ts` is most valuable when it attaches a real `UnifiedWidget` to the DOM, primes mocked SDK/chat/voice clients through `open()`, clicks the actual join button, and asserts live transcript rendering plus typed-interrupt routing. Pure private-state mutation is not enough for this seam.

**Impact**: Future omnichannel contract changes should update the shared web-sdk fixture module and the widget/session-manager boundary tests together so wire-shape drift is caught without introducing cross-package test imports.

## 2026-04-08 — Chat Send Options and Transport Must Evolve Together

- `ChatClient.send()`, `SendMessageOptions`, and the `TransportClientMessage` `chat_message` union need to change together when adding client-side message capabilities like per-message metadata. If any one of those seams lags, the SDK can still compile while silently dropping fields before they reach the wire.
- Keep the regression coverage in `src/__tests__/chat-client-transport.test.ts` and `src/__tests__/transport-types.test.ts`; they now prove metadata survives both local message creation and transport serialization.

**Impact**: Future chat-message option additions should update core option types, transport message types, `ChatClient` forwarding, and transport contract tests in the same change so new fields are not lost between the public API and websocket payload.

## 2026-04-06 — AgentProvider Cached ChatClient Ownership

- `AgentProvider` Path A must treat `sdk.chat()` as an SDK-owned cached client. On transient disconnect/reconnect, unsubscribe the provider's own `message` and `typing` listeners and reset provider state, but do not call `chatClient.dispose()`.
- Keep the reconnect regressions in `src/__tests__/agent-provider-transport.test.tsx`, `src/__tests__/chat-client-transport.test.ts`, and `src/__tests__/chat-client-integration.test.ts` together. They prove the provider reconnect path and the underlying live ChatClient transport/status behavior stay aligned.

**Impact**: Future React integrations that reuse `AgentSDK.chat()` should clean up only their local subscriptions during effect teardown. Disposing the cached chat client is reserved for permanent ownership teardown, not reconnect handling.

## 2026-04-06 — VoiceClient Canonical Trace Payload Parsing

- `VoiceClient` must parse `trace_event` payloads with the same helper rules as `DefaultTransport`: resolve the event from `msg.event` or legacy `eventType`, then read user-visible fields from `event.data` first and fall back to flattened legacy properties.
- Keep the voice trace regressions centered on canonical nested fixtures in `src/__tests__/voice-client-thoughts.test.ts` and `src/__tests__/voice-client-integration.test.ts`, but retain one explicit flattened legacy payload test so the compatibility shim stays exercised.

**Impact**: Future voice/chat trace changes should update the shared parser once instead of duplicating field-extraction logic across transport and voice code paths.

## 2026-04-06 — Shared Trace Event Parser Module

- The canonical `trace_event` parser should live in `src/transport/trace-event-utils.ts`, not inside `DefaultTransport.ts`. `VoiceClient` and `DefaultTransport` both depend on the same seam, but neither should import utility code from the other’s concrete implementation file.
- Keep `getTraceEventPayload()` and `getTraceEventData()` internal to the transport layer unless an external consumer appears. The public SDK barrels do not need to expose them just because multiple internal modules share them.

**Impact**: Future chat/voice trace changes should update `trace-event-utils.ts` once and avoid recreating `VoiceClient -> DefaultTransport` or other sibling-to-sibling utility dependencies.

## 2026-04-06 — AgentProvider Path B Chat Ownership Split

- In `AgentProvider` transport mode, keep `ChatClient` construction/disposal in a transport-ownership effect keyed by `transport`/`debug`, and keep React state subscriptions (`chat.on(...)`, `transport.on(...)`) in a separate effect that only captures unsubscribe handles.
- The provider should dispose the transport-owned `ChatClient` only on real ownership changes (transport replacement or unmount), not during transient connection-state churn. New transport-mode subscriptions such as `messageChunk` belong in the subscription effect, not in the ownership effect cleanup.

**Impact**: Future Path B lifecycle changes can safely add connection-derived dependencies to the subscription effect without accidentally tearing down the owned `ChatClient`, while real transport swaps still clean up the abandoned instance.

## 2026-04-06 — Verify Slice Findings Against HEAD

- Before acting on an `AgentProvider` lifecycle finding, inspect the actual Path A and Path B cleanup code in `src/react/AgentProvider.tsx`. The reported Path A "`sdk.chat()` is disposed on disconnect" bug was stale at HEAD; Path A already unsubscribed local listeners only.
- When a slice plan claims `ChatClient.ts` or `AgentSDK.ts` need lifecycle changes, verify the existing ownership contract first. In this seam, `AgentSDK.chat()` already documented SDK-owned cached-client reuse and `ChatClient.dispose()` was already permanent ownership teardown.

**Impact**: Future slice work should close or rewrite stale finding metadata instead of forcing duplicate runtime patches into code paths that are already correct.

## 2026-04-06 — DefaultTransport Trace Status Events

- `DefaultTransport.translateMessage()` must map canonical `trace_event` envelopes for `status_update` and `status_clear`, not just raw websocket message types. Chat transports can receive runtime UX status inside trace envelopes even when voice already handles them correctly.
- Before patching sibling consumers such as `VoiceClient`, verify whether they already share `trace-event-utils.ts`. In this slice, the remaining bug was transport-only; voice canonical parsing and regressions were already correct at `HEAD`.
- Keep the regression in `src/__tests__/default-transport.test.ts` focused on nested canonical envelopes so the chat-side seam stays covered without duplicating the voice tests.

**Impact**: Future runtime trace-event changes should update both chat and voice consumers only when the shared seam actually differs, and `DefaultTransport` tests should guard canonical envelope handling for any new user-visible trace subtype.

## 2026-04-06 — DefaultTransport Legacy Trace Status Coverage

- While canonical nested `event.data` is the primary trace-event contract, `DefaultTransport` still preserves flattened legacy `trace_event` payloads via `eventType` fallbacks.
- Keep one flattened regression for each user-visible trace subtype in `src/__tests__/default-transport.test.ts`, including `status_update` and `status_clear`, so subtype-specific legacy parsing regressions are caught where the compatibility shim is exercised.

**Impact**: Future cleanup of legacy flattened trace payload support should remove the compatibility code and these paired regressions together; until then, canonical-only tests are not enough for this transport seam.

## 2026-04-07 — React Subpath Template Registration

- `src/react/index.ts` must side-effect import `../templates/index.js` so the public `@agent-platform/web-sdk/react` bundle registers the same default template renderers as the root SDK entry.
- `src/react/components/RichContent.tsx` should read `defaultRegistry` from `../../templates/index.js`, not `../../templates/registry.js`, so direct React rich-content imports cannot bypass renderer registration.
- Keep both regressions: `src/__tests__/template-registry.test.ts` should prove a fresh React-entry import seeds `defaultRegistry`, and `src/__tests__/react-components.test.tsx` should prove rich markdown renders through the React barrel.

**Impact**: Future React entry or rich-content refactors must preserve renderer registration at the public React import boundary, not assume consumers also import the root SDK barrel.

## 2026-04-06 — TranscriptItem Must Reuse MessageRole

- `TranscriptItem.role` should reuse the shared `MessageRole` type instead of a narrower local union. Session history hydration can legitimately carry `'thought'`, and narrowing the transcript contract forces downstream callers to coerce that role to `'system'` and lose fidelity.
- Keep the regression in `src/__tests__/chat-backfill.test.ts` focused on hydrating a `TranscriptItem` with `role: 'thought'` so future role-contract edits fail at the shared seam before React or Studio adapters are patched around it.

**Impact**: Future message-role additions should flow through transcript hydration by updating `MessageRole` once, not by widening duplicate unions across backfill and UI adapters.

## 2026-04-14 — SessionManager Heartbeat Ownership

- `SessionManager` connection readiness and reconnect behavior are driven by `session_start` plus socket lifecycle, not by JSON `pong` responses. Removing the SDK-side heartbeat timer does not change readiness semantics as long as the runtime keeps the protocol-level websocket heartbeat.
- Keep the regression in `src/__tests__/session-manager-connect.test.ts` that advances fake timers after `session_start` and asserts no heartbeat frames are sent. That is the guard against reintroducing client-owned ping loops.
- `DefaultTransport` should continue dropping internal websocket messages instead of surfacing them to chat consumers. After heartbeat removal, `session_start` remains internal and `pong` is no longer part of the SDK-visible contract.

**Impact**: Future SDK transport changes should keep liveness ownership on the server websocket layer and only add new client-side timers or internal message passthrough when a concrete consumer depends on them.

## 2026-04-16 — Rich Content Parity Remediation

- Assistant message rendering should stay on the registry-backed `RichContent` path whenever `actions` are present. Letting `MessageList` append a separate `ActionHandler` creates duplicate controls and drifts away from `submit_id` / `submit_label` behavior implemented in `templates/renderers/actions.ts`.
- When adding or auditing `RichContent` fields, update `src/templates/support.ts` and `hasRenderableRichContentPayload()` together. The DOM `hasRichContent()` gate and the React renderer need the same source of truth or fallback-capable payloads can survive transport and still render as blank bubbles.
- React deferred-submit behavior for template renderers should reuse the same validation helpers as the DOM path. The current parity guards live in `src/__tests__/react-components.test.tsx` for ActionSet and form required-field submission.

**Impact**: Future template or message-list work should preserve a single assistant render path, treat `templates/support.ts` as the compatibility matrix, and update the parity regressions whenever a new shared rich-content field is introduced.

## 2026-04-16 — Legacy DOM Structured Prompt Text

- The legacy DOM/UMD rich renderer must still emit the assistant text body for non-text structured payloads such as ActionSet messages. If `renderRichMessage()` only renders matched structured blocks, the widget can show buttons/selects without the assistant prompt text. Only markdown/html renderers should suppress the plain-text fallback because they already own the message body.
- Keep the regression in `src/__tests__/rich-renderer-dom.test.ts` when touching `ui/rich-renderer.ts`; it protects the widget path that `ChatWidget`/`UnifiedWidget` still use outside the React renderer.

**Impact**: Future DOM renderer or widget changes should preserve prompt-text + structured-control co-rendering for non-text payloads and update the DOM regression tests whenever new text-owning renderers are added.

## 2026-04-16 — Structured Preview Extraction

- `extractStructuredTextPreview()` should only harvest values under whitelisted human-text keys (for example `text`, `title`, `label`, `subtitle`, `name`, `value`). Walking arbitrary JSON keys leaks structural protocol strings like Slack block `type` / `mrkdwn` markers into user-visible fallback summaries.
- The runtime also synthesizes fallback text from channel-native payloads, so behavior here must stay aligned with the runtime-side extractor in `apps/runtime/src/services/channel/outcome.ts`.

**Impact**: Future fallback-summary tuning should update the SDK and runtime extractors together and keep the regression focused on human-readable summary text rather than raw JSON structure.

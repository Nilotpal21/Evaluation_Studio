# Weekend Sprint Summary (Feb 13-15, 2026)

**48 commits | ~430 files changed | ~30,000+ lines touched**

---

## Database & Storage Migration (MongoDB + ClickHouse)

- **Complete Prisma removal** — migrated all Studio routes to MongoDB, fixed dual-instance connection issues
- **DB_AND_CLICKHOUSE branch merged** into develop with post-merge fixups
- **MongoDB `_id` to `id` mapping** fixed across all repos with `leanIdPlugin` registered at base-document level for Mongoose 8 ESM compat
- **Removed incorrect `tenantIsolationPlugin`** from models (ProjectAgent, ModelConfig, ServiceNode) that enforce tenant isolation via join, not direct field
- **Cascade delete helpers** added for MongoDB document cleanup
- **MongoDB integration test infrastructure** with new test suites

## Session & Trace Persistence Streamlining

- **Batched message + counter persistence queue** — consolidated all writes through a single queue to reduce DB hammering
- **Unified session creation** — collapsed `createSession()` and `createSessionFromMultipleDSLs()` into single `createSessionFromResolved()` entry point
- **Centralized session initialization** with lazy `ON_START` evaluation
- **Centralized trace event storage** in RuntimeExecutor — single authority for trace writes
- **Awaited session DB updates** instead of fire-and-forget (prevents race conditions)
- **Session correlation fields** set at creation time, not deferred
- **ZSTD graceful fallback** for compression with message ordering fixes
- **AuditStore singleton** — all audit writes routed through one path, including PrismaAuditStore with extended schema

## Chat History & Session Bug Fixes

- **Message ordering fix** — corrected out-of-order messages in chat history
- **Empty debug panels** wired up with proper data flow
- **Session delete zombie bug** fixed (sessions were lingering after delete)
- **Auto-session creation removed** — was causing ghost sessions
- **Empty traces in session detail** fixed by using `runtimeSessionId` for trace store lookups (ID mismatch between DB `_id` and runtime session IDs)
- **Session lifecycle management** — proper delete, close, and channel-aware config
- **Ghost session prevention** with centralized session metrics
- **Session resume** added to WebSocket context

## Tenant Isolation & Security Hardening

- **Hardened tenant isolation** in agent listing and session queries
- **Scoped session listing** to current project (prevented cross-project leakage)
- **Sanitized error messages** across 33 files to prevent leaking internal details to users
- **Encryption init** fixed at startup

## Voice & Realtime Streaming (LiveKit + TTS/STT)

- **Realtime voice provider abstractions** in compiler — OpenAI Realtime API + Gemini Live with provider factory
- **Tenant-scoped voice credentials** — voice stack no longer reads API keys from env vars, resolves per-tenant via `VoiceServiceFactory`
- **Voice mode resolver** — determines STT/TTS pipeline vs realtime voice path with feature-flag gating
- **LiveKit voice pipeline fixed** with pre-flight credential checks (422 if missing)
- **VoiceClient audio pipeline + streaming TTS** in web SDK
- **RealtimeAudioPlayer** added (with stack overflow fix in playback loop)
- **Twilio media handler** updated for tenant-scoped credentials
- **OTEL tracing + metrics** wired into realtime voice executor
- **Voice session hardening** — deferred creation, orphan cleanup, schema fixes
- **VAD ONNX model loading** — CSP `connect-src` updated for unpkg.com

## Deployments & Channels

- **Channel-type-specific UI** — ChannelCard shows "(Realtime)" for realtime voice pipelines
- **Channel detail** improvements
- **Deployment environment validation** added
- **Channel-aware voice warnings** for realtime voice models
- **`voiceConfig`** field added to Deployment model

## Model Resolution

- **`realtime_voice` operation type** added to tenant model resolution pipeline
- **TenantModel** gained `capabilities`, `realtimeConfig`, `connectionType` fields
- **`defaultVoiceModel`** field on TenantLLMPolicy
- **Realtime voice capability toggle** in model settings UI
- **`isDefault` toggle** for tenant models

## Studio UI

- **Voice Services admin page** — manage Deepgram/ElevenLabs/Twilio credentials at workspace level
- **Secrets UI fixed** — infinite spinner + tab switch remount
- **Design token system** — Tailwind overhauled to CSS-variable-backed semantic tokens
- **Light theme contrast** improvements
- **Shared `runtime-proxy` utility** to deduplicate Studio API proxy routes
- **LiveKit preview page** polish with realtime voice mode
- **Full workspace UI** for Chat, Debug, and theme in spec-mock

## Testing & Documentation

- **86 test stubs rewritten** with real implementations
- **OpenAPI/Swagger docs** added for all Runtime and Studio API routes
- **New test suites**: MongoDB integration, deployment routes, tenant model routes, voice mode resolver, realtime voice executor/traces
- **Test alignment** across session, trace, and voice modules

---

## Key Architectural Wins

- Single session creation path (`compileToResolvedAgent` + `createSessionFromResolved`)
- Centralized trace storage with single write authority
- Tenant-scoped voice credentials (no more env var API keys)
- MongoDB as primary store with Prisma fully removed
- Clean realtime voice abstraction layer from compiler IR through to the web SDK

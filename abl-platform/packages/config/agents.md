# agents.md — packages / config

Agent learning journal for this package. Append-only log of architectural decisions, patterns, gotchas, and insights discovered during SDLC work.

Agents MUST read this file before modifying code in this package. Agents MUST append learnings after completing work.

---

<!-- Append new entries below this line. Format:
## <DATE> — <Feature/Context>
**Category**: architecture | testing | pattern | gotcha | process
**Learning**: <what was learned — specific and actionable>
**Files**: <key files involved>
**Impact**: <how this affects future work in this package>
-->

## 2026-04-22 — Voice Provider Registry

**Category**: architecture
**Learning**: Static cross-app catalog data such as voice provider capabilities belongs in `packages/config` when both Studio and runtime need the same classification logic. Keep the shared layer limited to canonical IDs, labels, descriptions, and capability flags; app-specific JSX, icons, and component references should stay out of this package.
**Files**: `src/constants/voice-providers.ts`, `src/index.ts`, `src/__tests__/voice-providers.test.ts`
**Impact**: Future voice-provider additions or capability changes should start in this package first so Studio/runtime do not drift back into separate hardcoded lists.

## 2026-04-23 — Voice Pipeline STT Provider Parity

**Category**: architecture
**Learning**: The shared voice-provider registry needs secret-key metadata in addition to membership and capability flags because runtime public responses must return provider config for UX while stripping secret fields. Treat secret-key lists as part of the canonical provider definition, not as route-local knowledge.
**Files**: `src/constants/voice-providers.ts`, `src/__tests__/voice-providers.test.ts`
**Impact**: Future voice-provider expansion stories should add sanitization metadata here up front so runtime read paths and Studio detail views stay safe by default.

## 2026-04-23 — Voice Pipeline TTS + S2S Provider Parity

**Category**: architecture
**Learning**: The shared voice-provider registry has to encode more than provider membership. Preview capability, speech-role alignment, runtime CRUD eligibility, channel allowlists, and S2S telephony-support messaging are all part of the product contract. Keeping those flags centralized lets Studio and runtime move together without reintroducing local hardcoded provider lists.
**Files**: `src/constants/voice-providers.ts`, `src/__tests__/voice-providers.test.ts`, `src/index.ts`
**Impact**: Future voice-provider work should update the registry tests whenever any support flag changes. A provider should never gain or lose preview, channel, runtime, or S2S support semantics in one app without the shared registry changing first.

**Category**: gotcha
**Learning**: `partial` S2S support does not mean “not usable.” After the provider-aware KoreVG adapter work, `s2s:elevenlabs`, `s2s:deepgram`, and `s2s:ultravox` needed to remain `partial`, but the support message had to change to name the remaining inline handoff/prompt-swap limitation rather than claiming the whole telephony path was still pending.
**Files**: `src/constants/voice-providers.ts`, `src/__tests__/voice-providers.test.ts`
**Impact**: Future support-state changes should treat the wording itself as part of the shared contract. If runtime support gets broader without reaching full parity, update both the enum/flags and the human-facing support message together.

### 2026-05-10 — `coerceValue` must NOT split scalar URL/URI envs on commas

**Category**: pattern
**Learning**: `mapEnvToConfig` runs every value through `coerceValue`, which split any comma-containing value into a `string[]`. That is correct for `CORS_ORIGINS` / `CORS_METHODS`, but a cluster-mode `REDIS_URL=redis://h1:6379,redis://h2:6379` is a **single string seed list**, not an array — and Zod's `redis.url: z.string()` rejects arrays at config validation. Same shape for `MONGODB_URI` replica-set lists. Fix: a `STRING_VALUED_ENV_KEYS = {REDIS_URL, MONGODB_URI}` set, and `coerceValue(value, envKey?)` skips the comma-split for those keys. `mapEnvToConfig` now passes the `envKey` through. Also: there are inlined Turbopack-workaround copies of `coerceValue` in `apps/admin/src/app/api/config/{route,diff/route}.ts` — when this rule changes, both must be updated in lock-step (a "keep in sync" comment is in place at each copy).
**Files**: `src/env-mapping.ts`, `src/__tests__/env-mapping.test.ts`, `apps/admin/src/app/api/config/route.ts`, `apps/admin/src/app/api/config/diff/route.ts`
**Impact**: When adding a new env var that is a single scalar with internal commas (cluster URLs, replica-set URIs, free-form CSV-in-a-string), append it to `STRING_VALUED_ENV_KEYS` here AND in the two admin copies. When adding a new env var that is genuinely an array (CSV of independent values), nothing to do — comma-split remains the default.

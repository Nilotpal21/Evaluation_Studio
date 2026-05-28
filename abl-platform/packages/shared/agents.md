# agents.md — packages / shared

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

## 2026-04-28 — Authorize at Creation (ABLP-619, FR-9)

**Category**: pattern
**Learning**: ABLP-619 added two error codes to `AuthProfileErrorCode`: `AUTH_PROFILE_NOT_AUTHORIZED` (HTTP 403) and `AUTH_PROFILE_AUTHORIZE_FAILED` (HTTP 400). The canonical export path for trace events and error codes is `packages/shared-auth-profile/src/`, re-exported via the shared barrel. There is a parallel local file at `packages/shared/src/services/auth-profile/trace-events.ts` — keep them consistent because some callers reach the local file directly and others go through the barrel. The new `AUTHORIZED` (`auth_profile.authorized`) and `AUTHORIZE_FAILED` (`auth_profile.authorize_failed`) trace events are emitted from both project and admin OAuth callback handlers and the inline client_credentials grant flow; the failure event metadata always carries `metric: 'auth_profile_authorize_failed_total'` so structured logs surface the LLD-mandated counter name even though Studio has no in-process Prometheus registry.
**Files**: `src/services/auth-profile/auth-profile.schema.ts`, `src/services/auth-profile/trace-events.ts` (parallel to canonical `packages/shared-auth-profile/src/trace-events.ts`)
**Impact**: When adding new auth-profile error codes or trace events, update BOTH the canonical file (`packages/shared-auth-profile/src/`) AND the parallel `packages/shared/src/services/auth-profile/` files in the same change. Future cleanup work could merge the parallels — that is currently logged as deferred.

## 2026-03-26 — DEK Encryption Convenience Functions

### encryptForTenantAuto / decryptForTenantAuto

- Located in `packages/shared/src/encryption/index.ts` (re-exports from shared-encryption)
- `encryptForTenantAuto` always uses the DEK facade
- `decryptForTenantAuto` expects DEK envelope ciphertext and fails closed otherwise
- These are the primary entry points for direct call sites outside the Mongoose plugin

## 2026-04-15 — Workflow Versioning: Version-Aware Tool Binding Validation

**Category**: architecture
**Learning**: `validateWorkflowToolBinding()` in `src/tools/validate-workflow-tool-binding.ts` now uses a version-aware dual check: (1) version-first — if `workflowVersionsRepo` is provided, look for an active WorkflowVersion with matching `workflowId`, `tenantId`, and `projectId`; (2) legacy fallback — check `workflow.status === 'active'`. The `workflowVersionsRepo` parameter is optional for backward compatibility. All queries include both `tenantId` and `projectId` for full isolation.
**Files**: `src/tools/validate-workflow-tool-binding.ts`, `src/tools/__tests__/validate-workflow-tool-binding-version.test.ts`
**Impact**: Future callers of `validateWorkflowToolBinding` should pass `workflowVersionsRepo` to enable version-first validation. Tests use DI test doubles (in-memory repos) — no `vi.mock` needed.

## 2026-04-17 — Source Subpath Shims

**Category**: gotcha
**Learning**: When root TypeScript path aliases map `@agent-platform/shared/*` directly into `packages/shared/src/*`, every package export subpath that application code imports needs a matching source file, not just a `package.json` export to a built dist file. Without a tiny source shim such as `src/tools/resolve.ts`, source-based test/build flows can resolve the package subpath differently from published-dist consumers.
**Files**: `src/tools/resolve.ts`, `package.json`
**Impact**: When adding or renaming shared package subpath exports, add the source-level shim in the same change so repo-local path-alias consumers and published package consumers keep the same import surface.

## 2026-04-18 — Workflow Webhook Versioning Phase 3 (DSL parser lockstep)

**Category**: pattern
**Learning**: `WorkflowBindingLocal` in `dsl-property-parser.ts` is the 2nd lockstep site for new DSL binding fields. The parser reads snake_case DSL props (e.g., `props.workflow_version`) and maps to camelCase TypeScript fields (e.g., `workflowVersion`). Optional fields should only be included in the returned object when the prop is a non-empty trimmed string — use conditional spread `...(value !== undefined && { field: value })` to avoid serializing `undefined` keys.
**Files**: `src/tools/dsl-property-parser.ts`, `src/tools/__tests__/dsl-property-parser-workflow-version.test.ts`
**Impact**: Follow this pattern for any new optional DSL binding property. The 3rd lockstep site (`resolve-tool-implementations.ts:571`) passes `resolved.workflowBinding` as the whole object — no change needed there unless the passthrough is ever refactored to destructure.

## 2026-04-19 — ABL Contract Hardening Phase 3 (projected system-prompt sections)

**Category**: architecture
**Learning**: Projected runtime sections such as session memory, granted memory, gather progress, and active policy belong in the shared prompt templates themselves, not as ad hoc runtime string concatenation after template render. Once the sections are part of `prompt-catalog.ts`, standard prompts, custom `SYSTEM_PROMPT` paths, and downstream mirrored docs can all rely on one heading order and avoid duplicate `Current Context` blocks.
**Files**: `src/prompts/prompt-catalog.ts`
**Impact**: Any future user-visible system-prompt section that should appear across agent types should be added in the shared prompt catalog first; runtime should only decide whether the section has content, not hand-assemble duplicate headings later.

## 2026-04-24 — Auth Profile Phase 2 Core Auth Types (Post-Impl Sync)

**Category**: architecture
**Learning**: Cross-app compatibility contracts that must run in both Studio client code and Runtime services belong in `packages/shared/src/validation/`, not in server-oriented packages. The Phase 2 core auth support matrix is intentionally bundle-safe so authoring, picker messaging, and fail-closed runtime checks all read the same decision table.
**Files**: `src/validation/auth-profile-support-matrix.ts`, `src/validation/index.ts`
**Impact**: When a future feature needs a shared "supported vs attach-only vs unsupported" contract across client and server, start with a validation-layer module in `packages/shared` before adding per-app copies.

## 2026-04-27 — SOAP Tool Support Phase 1a (DSL pipeline + validation)

**Category**: pattern
**Learning**: When adding new optional fields to the HTTP tool DSL pipeline, 4 lockstep sites need updating: (1) `HttpBindingIRLocal` in `dsl-property-parser.ts` for IR types, (2) `buildHttpBindingFromProps()` for DSL→IR parsing, (3) `serializeHttpProperties()` in `serialize-tool-form-to-dsl.ts` for form→DSL emission, (4) `parseHttpForm()` in `parse-dsl-to-tool-form.ts` for DSL→form parsing. Fields use snake_case in DSL/IR and camelCase in form types. The `inlineQuote()` helper wraps values with colons/spaces in double quotes, and `unquote()` reverses this — round-trip tests must account for quoting. `parseDslProperties()` is a flat parser that doesn't understand nesting, so `description:` inside `params:` blocks overwrites the tool-level `description` — avoid parameter descriptions in round-trip tests.
**Files**: `src/tools/dsl-property-parser.ts`, `src/tools/serialize-tool-form-to-dsl.ts`, `src/tools/parse-dsl-to-tool-form.ts`, `src/validation/project-tool-schemas.ts`
**Impact**: Follow this 4-site lockstep pattern for any new optional HTTP DSL binding fields. Zod cross-field validation uses `.superRefine` on the discriminated union level, not on individual schemas.

## 2026-04-27 — SOAP Tool Support Phase 4 (E2E Round-Trip Verification)

**Category**: testing | pattern
**Learning**: The full SOAP DSL round-trip (form → DSL → parse → build) was verified in INT-7d. `serializeToolFormToDsl` emits `protocol: soap`, `soap_version: 1.1`, `soap_action: <value>`, and conditionally `on_soap_fault: data` (only when not the default `'error'`). `parseDslProperties` reads these back as flat key-value pairs, and `buildHttpBindingFromProps` maps them into the `HttpBindingIRLocal` object. All 4 SOAP fields survive the round-trip. The barrel export `@agent-platform/shared/tools` is the correct import path for all three functions — sub-path imports are not exposed in the package.json exports map.
**Files**: `src/tools/dsl-property-parser.ts`, `src/tools/serialize-tool-form-to-dsl.ts`, `src/tools/parse-dsl-to-tool-form.ts`, `src/validation/project-tool-schemas.ts`
**Impact**: When extending the SOAP DSL pipeline with new fields, update all 4 lockstep sites and add a round-trip assertion in the INT-7 test group. Use `@agent-platform/shared/tools` barrel import, not individual file sub-paths.

## 2026-04-28 — External Agent Registry: Repo with DI for A2A

**Category**: pattern | gotcha
**Learning**: `@agent-platform/a2a` depends on `@agent-platform/shared`, so `shared` cannot import from `a2a` (circular dependency). The `testExternalAgentConnection` function uses dependency injection (`TestConnectionDeps` interface) instead of importing a2a directly. The runtime route handler supplies the actual a2a imports. All other repo functions follow the standard MCP repo pattern (module-level async functions, dynamic model import, normalizeDocument). Types are in `src/types/external-agent.ts` following the `mcp-server.ts` pattern.
**Files**: `src/repos/external-agent-config-repo.ts`, `src/types/external-agent.ts`, `src/repos/index.ts`
**Impact**: When a repo function needs a package that depends on `@agent-platform/shared`, use dependency injection — define a deps interface and let the caller inject. Never add a circular workspace dependency.

## 2026-05-06 — MCP auth resolver mode fallback and rate/refresh safety

**Category**: architecture
**Learning**: MCP/runtime auth resolution must treat `connection_mode` as optional input and fall back to profile-level mode to preserve backward compatibility with older tool definitions. Cache and rate-limit logic should remain keyed by tenant+profile context to keep isolation guarantees.
**Files**: `src/services/mcp-auth-resolver.ts`, `src/services/mcp-server-registry.ts`, `src/__tests__/mcp-auth-resolver.test.ts`, `src/__tests__/mcp-server-registry.test.ts`
**Impact**: For future auth-profile schema evolution, preserve explicit fallback order (`tool -> profile -> safe default`) and codify it in regression tests before removing compatibility shims.

## 2026-05-06 — HTTP Tool Template URL Validation

**Category**: security | pattern
**Learning**: HTTP tool validators should not blanket-skip SSRF validation just because an endpoint contains `{{...}}`. Treat unresolved runtime placeholders as safe only when there is no literal absolute URL prefix; if a literal prefix exists, replace placeholders with a benign segment and validate the resulting URL. This allows `{{env.TOOL_BASE_URL}}/events` while still blocking `http://169.254.169.254/{{env.METADATA_PATH}}`.
**Files**: `src/validation/project-tool-schemas.ts`, `src/tools/project-tool-validator.ts`, `src/__tests__/project-tool-schemas-soap.test.ts`, `src/__tests__/project-tool-validator.test.ts`
**Impact**: Future tool DSL or form validation changes should preserve runtime env/secrets placeholder authoring without creating an SSRF bypass for unsafe literal hosts.

## 2026-05-09 — PII Detection Tiered Recognizers (Dep direction discovery)

**Category**: gotcha
**Learning**: `@abl/compiler` depends on `@agent-platform/shared` (verified in `packages/compiler/package.json`). The reverse edge (shared depending on compiler) does NOT exist and must NOT be introduced — it would create a circular dep through any package that imports both (e.g., `apps/runtime`). For ABLP-921 (PII tiered recognizers), this constraint forced `PACK_NAMES` to be declared in `packages/shared/src/validation/pii-pack-names.ts` (NEW) and imported FROM there into `@abl/compiler`'s `recognizer-packs/index.ts`, even though the original HLD §3.3 component diagram placed `PACK_NAMES` inside the compiler. The compiler-side `recognizer-packs/` dispatcher imports `PACK_NAMES` and `PackName` from `@agent-platform/shared/validation`, and the same constant is reused by the runtime-config Zod schema's `z.array(z.enum([...PACK_NAMES]))` constraint.
**Files**: `src/validation/project-runtime-config.ts`, `src/validation/index.ts`, `src/validation/pii-pack-names.ts` (new)
**Impact**: Whenever a Zod schema in `@agent-platform/shared/validation` needs to enumerate string literals that other domain packages (compiler, database, etc.) also consume, declare those literals in `@agent-platform/shared` and let the domain packages import them. Never re-export from a domain package back into shared.

## 2026-05-09 — PACK_NAMES placement avoids circular dep (ABLP-921 Phase 1b-prep)

`PACK_NAMES` and `PackName` live in `@agent-platform/shared/validation/pii-pack-names.ts`. Verified at LLD-time that `@abl/compiler` already depends on `@agent-platform/shared` (not the reverse). The compiler-side recognizer-packs dispatcher imports from shared; declaring the names in compiler and re-exporting back to shared would create a circular dep.

When extending `piiRedactionConfigSchema` (line 36 of `project-runtime-config.ts`), THREE places must move together: the schema itself, `runtimeConfigResponseSchema.pii_redaction` (~line 274), and `PROJECT_RUNTIME_CONFIG_DEFAULTS.pii_redaction` (~line 224). Without the response-schema extension, the runtime API silently strips new fields from GET/PATCH responses.

## 2026-05-05 — Redis Dual-Mode: Cluster-Safe Type Widening

**Category**: architecture
**Learning**: `DistributedLockManager` now accepts `RedisClient` (= `Redis | Cluster`) instead of `Redis`. All lock operations (SET NX PX, GET, DEL, PEXPIRE, Lua eval) are single-key and cluster-safe. The `shared-observability` copy was already updated; the `shared` copy was the stale one.
**Files**: `src/redis/distributed-lock.ts`
**Impact**: Both copies (shared and shared-observability) now accept `RedisClient`. Callers no longer need `as Redis` casts.

**Category**: architecture
**Learning**: `ResolveToolImplDeps.redis` interface changed from `{ mget(keys[]): ...; mset(entries[], ttl): ... }` to `{ get(key): ...; setex(key, seconds, value): ... }`. The old `mget`/`mset` caused CROSSSLOT errors in cluster mode when keys spanned hash slots. The new interface uses individual `get`/`setex` wrapped in `Promise.all`, which is cluster-safe. Both methods are natively available on ioredis `Redis` and `Cluster` clients, so callers can pass the client directly.
**Files**: `src/tools/resolve-tool-implementations.ts`, `src/tools/__tests__/resolve-tool-implementations-cache.test.ts`
**Impact**: Any future DI redis interface should prefer individual operations over multi-key commands. If batch performance is critical, use `pipeline()` (cluster-safe with auto-routing) instead of `mget`/`mset`.

## 2026-05-06 — Redis Dual-Mode Phase B: distributed-lock.ts LuaScript fix

**Category**: gotcha | architecture
**Learning**: `distributed-lock.ts` `release()` and `extend()` use `runLuaScript` from `@agent-platform/redis`. The `script` parameter must be a `LuaScript = { name, body, numberOfKeys }` object, NOT a raw Lua string. Initially the scripts were passed as raw strings which fails TypeScript. Declare named module-level constants at the top of the file.
**Files**: `src/redis/distributed-lock.ts`
**Impact**: Any new Lua operation added to this file must use the `LuaScript` type. The `runLuaScript` signature enforces this at compile time.

---

**Category**: architecture | pattern
**Learning**: `getAllowedConfigKeys(authType)` in `validation/auth-profile.schema.ts` is the single source of truth for what config keys may be sent to the auth-profile API. The studio slide-over projects its `config` state through this helper before save so the strict Zod schemas never see foreign keys (no more "Unrecognized key(s) in object" leaks). Implementation walks through up to 6 ZodEffects layers (`.superRefine()` / `.transform()`) to find the underlying ZodObject `.shape` — required because OAuth2AppConfigSchema is wrapped in both.
**Files**: `src/validation/auth-profile.schema.ts` (`getAllowedConfigKeys`), `src/__tests__/validation/get-allowed-config-keys.test.ts`
**Impact**: Adding a new auth type → register its schema in `AUTH_TYPE_CONFIG_SCHEMAS`. The slide-over picks it up automatically — no UI code changes needed for the projection to work. Adding a new ZodEffects wrapper depth → bump the loop bound in the helper.

---

**Category**: bug | architecture
**Learning**: `toToolDefinition()` in `resolve-tool-implementations.ts` builds `ToolDefinitionLocal` for the compiler's `resolvedToolImplementations` option. Before ABLP-655, it silently dropped `auth_profile_ref`, `jit_auth`, `connection_mode`, and `consent_mode` from the project tool DSL. This caused agent IR tools to lack `auth_profile_ref`, so the runtime auth-profile middleware skipped them entirely. Any time a new runtime-resolution field is added to the tool IR (e.g. a new DSL directive like `rate_limit_profile`), `toToolDefinition()` MUST be updated to propagate it from `props` or it will silently fail at runtime.
**Files**: `src/tools/resolve-tool-implementations.ts`
**Impact**: The `props` object from `parseDslProperties` is the authoritative source for all tool DSL fields. Every IR field that drives runtime behavior must be explicitly mapped in `toToolDefinition()`. Missing fields fail silently — no compile error, no runtime error, just the feature not working.

## 2026-05-15 — Workflow Integration Node Timeout Widened (Phase 1) — ABLP-1073

**Category**: pattern
**Learning**: `IntegrationNodeConfigSchema.timeout` was widened from `.max(300)` to `.max(1800)` to accommodate document-extraction step durations (Docling + Azure DI both run beyond the 5-minute default for large PDFs). Backward-compatible — existing workflows with `timeout: 60` still validate. The connector `extract_document` action defaults to a 1800 s timeout when none is set.
**Files**: `src/validation/workflow-schemas.ts`.
**Impact**: Future long-running integration steps can rely on the 1800 s cap. Anything beyond that should be reconsidered — workflows should not park forever on a single step; the engine's `STEP_TIMEOUT` is the safety net.

---

## 2026-05-18 — Guardrails validateRule UT-1 (ABLP-723)

**Category**: testing | gotcha
**Learning**: `validateRule()` in `src/validation/guardrail-rule-validation.ts` has a narrower scope than the test spec anticipated. It does NOT validate `category`, `action`, or `severityThreshold` as required fields. It does NOT require `entities` when the field is `undefined` (only validates bounds when present). The `actionMessage` requirement gate is `enabled !== false && presetKey === 'sensitive_data_block'` — non-SDB rules never require actionMessage. `sanitize-html` with `allowedTags: []` strips `<script>` tags AND their content entirely (result is `''`, not the text inside the tags). The `sanitizeActionMessage` helper does not re-check for empty after HTML stripping, so `<script>alert(1)</script>` passes validation as valid with `sanitized.actionMessage === ''`.
**Files**: `src/__tests__/validation/guardrail-rule-validation.test.ts`, `src/validation/guardrail-rule-validation.ts`
**Impact**: Future test authors must read the actual source before trusting test-spec case expectations. If the empty-after-sanitization behavior is a bug, a follow-up fix to `sanitizeActionMessage` should add a post-strip empty check.

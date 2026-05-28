# Data-Flow & Dependency-Wiring Audit: Reusable Agent Modules (ABLP-51)

**Date**: 2026-05-13
**Auditor**: Claude (data-flow-audit skill)
**Round**: 1 (extended scope)
**Scope**: Studio export → publish → tenant catalog → consumer import (POST + preview + DELETE) → deployment-time snapshot (CREATE + PROMOTE-clone fallback) → runtime resolve → runtime tool-dispatch (auth resolution under consumer scope) → trace provenance
**Primary feature spec**: `docs/features/reusable-agent-modules.md` (BETA)
**Referenced ABLP-51 hardening commits**: `f72c22349d`, `2bbe199554`, `68142d0610`, `1b21c89583`, `0773d56fb9`

## Audit Anchor

The audit follows **one primary value** — the **module release payload** (`artifact` + `compiledIR` + `contract`) — as it flows:

```
ProjectAgent.dslContent + ProjectTool.dslContent + MCP/connector resolutions
  → buildModuleRelease() (publish)
  → module_releases.{artifact, compiledIR, contract}
  → module-catalog visibility / module-dependencies/preview
  → project_module_dependencies.{resolvedReleaseId, contractSnapshot, configOverrides}
  → buildDeploymentModuleSnapshot() (deploy)
  → deployment_module_snapshots.compressedPayload {mountedAgents, mountedTools}
  → DeploymentResolver.mergeModuleSnapshot() (runtime)
  → session.agentIR / resolvedTools (with _moduleProvenance)
  → trace events enriched with moduleAlias/moduleProjectId/moduleReleaseId
```

Secondary values (treated as contaminants checked along the trace): inline secrets, `variableNamespaceIds`, source-project `_id`/`projectId`/`tenantId` literals, encrypted MCP env/auth blobs, tenant/project execution context, alias-rewritten symbol identity.

## Per-Value Path Trace

```
VALUE: module release payload (artifact + compiledIR + contract)
  DATA CLASS: BUSINESS (artifact is intended-portable); the compiledIR variant
              indirectly carries SOURCE-PROJECT secrets via MCP server_config and
              tool-implementation resolution. (Effective class: INTERNAL / CREDENTIAL.)
  APPROVED CONSUMERS:
    - same-tenant module owners (via Studio MODULE_READ on the module project)
    - same-tenant consumer projects (via project-scoped catalog and import)
    - consumer-project runtime (via deployment snapshot, executed under
      consumer tenantId/projectId)

  1. Source:
     - Publish: apps/studio/src/app/api/projects/[id]/module/releases/route.ts:114
       Inputs: ProjectAgent.dslContent + ProjectTool.dslContent + ProjectConfigVariable
               + ProjectRuntimeConfig + ProjectLLMConfig + (via buildStudioCompilerOptions)
               MCP server configs and connector tool implementations from the SOURCE
               project (apps/studio/src/lib/abl/studio-compiler-options.ts:106).
     - Entry validation: Zod PublishReleaseSchema (line 36), MODULE_PUBLISH permission,
       requireFeature='reusable_modules'.

  2. Writes:
     - ModuleRelease.{artifact, compiledIR, contract, sourceHash} (route line 461-471)
       NOTE: compiledIR is a full agent IR including baked tool definitions and
       resolved MCP server_config (with encrypted_env / encrypted_auth_config).
     - ModuleEnvironmentPointer (route line 493) on promoteToEnvironment.
     - ProjectModuleDependency.{contractSnapshot, configOverrides, resolvedReleaseId}
       on consumer import.
     - DeploymentModuleSnapshot.{compressedPayload (gzip), moduleReleaseIds}
       at deploy time (deployment-build-service.ts:1677).
     - AuditEvent: MODULE_PUBLISHED on success only (route line 526) — see F-7.

  3. Serialization boundaries:
     - REST publish response (artifact NOT returned; only contract+warnings) ✓
     - Mongo persistence of full artifact + compiledIR.
     - gzip-compressed snapshot payload (8 MB cap, 50 MB decompression cap) — opaque
       Buffer in deployment_module_snapshots.compressedPayload.
     - WebSocket trace_event frames carry moduleAlias/moduleProjectId/moduleReleaseId
       provenance (trace-emitter.ts:138-143).
     - SDK session state rehydration (session-state-repo.ts:231) persists
       moduleProvenance map.

  4. Read paths:
     - GET /api/projects/:id/module/releases (list) — returns contract+sourceHash,
       NOT artifact. ✓
     - GET /api/projects/:id/module/releases/:releaseId (detail) — returns
       artifact + contract + sourceHash but NOT compiledIR (route line 58-71).
       Audience: tenant members with MODULE_READ on the module project. See F-2.
     - GET /api/projects/:id/module-catalog and module-catalog/:moduleProjectId
       (consumer-facing) — returns contract only, NEVER artifact or compiledIR. ✓
     - DeploymentResolver.mergeModuleSnapshot (deployment-resolver.ts:835) — loads
       gzip payload into session IR map (consumer-tenant-scoped query).
     - Trace store / session store reads via runtime-executor.

  5. Policy boundary verdicts (consumer-class × policy gate):
     - Cross-tenant (different tenantId): blocked at every read (
       Project/ModuleRelease/Catalog/Snapshot all filter by tenantId).
       Cross-tenant module-catalog detail returns 404 (route line 49). ✓
     - Cross-project, same tenant, no MODULE_READ on source: blocked from
       /module/releases/:releaseId (requireProject targets the module project
       id; permission MODULE_READ enforced). Consumers reach contracts via
       project-scoped catalog which doesn't include artifact. ✓
     - Private-visibility modules: filtered out of catalog regardless of caller
       project. Stricter than spec wording ("unless caller owns") but safer.
     - Runtime mounted execution: consumer tenant/project/user always — see
       runtime-executor scope resolution at runtime-executor.ts:738-797 and
       agent-registry isolation tests at __tests__/agent-registry-isolation.test.ts.

  6. Consumers / Sinks:
     - Imported agents execute in consumer-project LLM context (model resolution
       uses consumer tenantId/projectId).
     - Imported tools call out (HTTP / MCP / sandbox / workflow / searchai)
       under the consumer's auth-profile / env-var / connector / mcp-server-config
       bindings. Auth-profile preflight enforces this at deploy (F-6 caveat).
     - Trace events emitted to consumer's TraceStore and ClickHouse — provenance
       fields are added but the OWNER row is consumer.
     - Audit events MODULE_PUBLISHED / MODULE_PROMOTED / MODULE_IMPORTED /
       MODULE_REMOVED / MODULE_UPGRADED / MODULE_RELEASE_ARCHIVED — only success
       paths audited.

  7. Wiring:
     DEPENDENCY: buildDeploymentModuleSnapshot
       Constructed at: services/modules/deployment-build-service.ts:1039
       Consumer 1: routes/deployments.ts:784 (deployment CREATE) — WIRED ✓
       Consumer 2: routes/deployments.ts:1282 (deployment PROMOTE fallback) — WIRED ✓
       Null-handling: returns null when no module deps; caller treats null as OK ✓

     DEPENDENCY: cloneDeploymentModuleSnapshot
       Constructed at: services/modules/deployment-build-service.ts:1714
       Consumer: routes/deployments.ts:1272 (deployment PROMOTE primary) — WIRED ✓
       Env guard: clones only when sourceEnv === targetEnv (build-service:1721-1731) ✓

     DEPENDENCY: validateContractAuthProfiles / validateAuthProfileChecks
       Constructed at: services/modules/contract-auth-validator.ts
       Consumer 1: buildDeploymentModuleSnapshot._buildWithLock line 1307 — WIRED ✓
       Consumer 2: buildDeploymentModuleSnapshot._buildWithLock line 1493 — WIRED ✓
       Consumer 3: cloneDeploymentModuleSnapshot — NOT WIRED ✗ (see F-3)

     DEPENDENCY: validatePublishSafety
       Constructed at: packages/project-io/src/module-release/module-publish-safety.ts:113
       Consumer: build-module-release.ts:261 — WIRED ✓
       Scope of scan: input.agents[].dslContent, input.tools[].dslContent,
                      input.profiles[].dslContent only. compiledIR, agentCompanions,
                      and parsed tool 'definition' objects are NOT scanned. (F-1, F-4)

     DEPENDENCY: stripVariableNamespaceIds
       Constructed at: build-module-release.ts:346 (recursive)
       Consumer: applied to compiledIR (line 184-186). NOT applied to
                 artifact.tools[].definition or to MCP server_config.
       Verdict: PARTIAL ✗ — see F-4.

     DEPENDENCY: moduleProvenance map
       Constructed at: runtime-executor.ts:1746-1764 from resolved IR _moduleProvenance.
       Consumer: trace-emitter.ts:119 (moduleProvenanceMap config field).
       Wiring sites: websocket/handler.ts:2315, :2766, :4022 — WIRED ✓
       Persistence: session-state-repo.ts:231 — WIRED ✓

     DEPENDENCY: existingSymbols (collision detector)
       Constructed at: routes/deployments.ts:783 + :1270 via loadProjectLocalSymbolSet
       Consumer: rewriteModuleIR — WIRED ✓ (tenant+project-scoped lookup)

  8. Parallel paths:
     - Deployment CREATE path (route line 760) vs PROMOTE path (route line 1265):
       both call buildDeploymentModuleSnapshot when no clone is available; both
       run the same preflight chain. ✓
     - PROMOTE-with-clone path skips preflight (relies on source deployment's
       preflight being still valid) — see F-3.
     - Recompile-from-DSL (`recompileArtifactRelease`) vs legacy `compiledIR`
       fallback: NOT identical. Legacy carries source-baked tool implementations;
       recompile resolves under consumer config. See F-5.
     - Live vs preview/test session: preview uses module's own runtime;
       deployed snapshot uses consumer runtime — different contexts by design.
     - Channel SDK vs Studio debug session: both go through DeploymentResolver
       which loads the same snapshot and applies provenance enrichment. ✓

  9. Boundary tests present (good):
     - module-alias-rewriter.test.ts (53 tests) — IR field coverage
     - module-runtime-isolation.e2e.test.ts (5) — cross-project/tenant isolation
     - module-runtime-provenance.e2e.test.ts (4) — provenance propagation
     - module-cutover-safety.e2e.test.ts (5) — source mutation post-deploy
     - module-upgrade-lifecycle.e2e.test.ts (4) — PATCH upgrade snapshot freshness
     - module-publish-safety.test.ts (20) — pattern coverage (gaps in F-1)
     - contract-auth-validator.test.ts (12) — auth profile preflight
     - agent-registry-isolation.test.ts — cross-project/version name collisions

  9. Boundary tests MISSING (see findings for details):
     - No test asserts compiledIR (after publish) does not contain encrypted MCP
       server_config or baked source-project resolved bindings (F-5).
     - No test asserts validatePublishSafety scans agentCompanions and tool
       'definition' objects, not just dslContent (F-1, F-4).
     - No test asserts MODULE_PUBLISH rejection audits — only successful
       publish audits exist (F-7).
     - No test asserts cloneDeploymentModuleSnapshot re-validates auth profiles
       when same-env clone hits a deleted profile (F-3).
     - No test asserts publish rejects on AWS / GitHub / Slack / Stripe-non-sk
       secret formats (F-1).
```

## Findings

### F-1 — Publish safety pattern set misses common secret formats

```
SEVERITY: HIGH
DIMENSION: Source / Policy Boundary
PATH: ProjectAgent.dslContent (or ProjectTool.dslContent)
      → buildModuleRelease → scanForSecretPatterns
      → module_releases.artifact.{agents,tools}[].dslContent
      → consumer DeploymentModuleSnapshot.compressedPayload
      → runtime LLM/tool call

EVIDENCE: packages/project-io/src/module-release/module-publish-safety.ts:69-70
  SECRET_PREFIX_RE matches only Bearer / Basic / sk- / pk_ prefixes.
  Real-world secrets that PASS as blocking:
    - AWS access keys (AKIA...20chars)
    - GitHub PATs (ghp_*, gho_*, ghs_*, ghu_*)
    - Slack tokens (xoxb-, xoxa-, xoxs-, xoxp-)
    - Google API keys (AIza...)
    - JWTs without "Bearer " prefix (eyJ...)
    - Stripe live keys with sk_live_ DO match sk- prefix; sk_test_ also matches;
      BUT rk_live_, whsec_, anonymous service keys, etc. do not.
  Base64 fallback is severity:'warning' only and uses a 50%-printable-byte
  heuristic that misses opaque/raw-byte secrets.

IMPACT: A module author commits a DSL string containing a real production
        AWS key / GitHub PAT / Slack token; publish succeeds; the value
        ships verbatim in artifact.agents[].dslContent and artifact.tools[].
        dslContent. Same-tenant consumers (and their runtime traces / DB
        snapshots / log lines) now hold the credential. Spec FR-4 promises
        "reject publish when the artifact contains inline secrets" — current
        implementation does not enforce this for the most common enterprise
        secret formats.

FIX:    Extend SECRET_PREFIX_RE (and add a dedicated "blocking" KNOWN_TOKENS_RE)
        to cover AKIA, ASIA, ghp_/gho_/ghs_/ghu_, xox[abps]-, AIza, eyJ at
        line start (JWT), rk_live_, whsec_, ya29., Stripe non-sk live, npm_,
        glpat-. Promote BASE64_RE detection from 'warning' to 'blocking' for
        strings >32 chars in fields named auth/headers/api/token/key. Add
        entropy threshold check (Shannon ≥ 4.0) as a supplementary signal.

TEST:   Extend packages/project-io/src/__tests__/module-publish-safety.test.ts
        with a `secret-format-coverage` block. Assert each of {AKIA, ghp_,
        xoxb-, AIza, JWT, rk_live_, whsec_} produces a blocking issue.
```

### F-2 — GET release detail returns full DSL — "compiledIR excluded for security" claim is misleading

```
SEVERITY: MEDIUM
DIMENSION: Read paths / Policy Boundary
PATH: ModuleRelease.artifact
      → GET /api/projects/:id/module/releases/:releaseId response.data.artifact

EVIDENCE: apps/studio/src/app/api/projects/[id]/module/releases/[releaseId]/route.ts:57-72
  Comment line 57: "Return release fields excluding compiledIR (security — don't
  leak full IR)". But the response returns `artifact: r.artifact` which contains
  the full DSL source (`agents[name].dslContent`, `tools[name].dslContent`,
  `profiles[name].dslContent`). The "compiledIR is hidden" claim is therefore
  inaccurate as a security boundary — semantic equivalence: DSL ≈ IR.

INVARIANT (intended):
  - Tenant members WITH MODULE_READ on the SOURCE module project see the full
    artifact (DSL source). This is by design — they are the module's owning
    audience.
  - Consumer-project members (different project, same tenant) without MODULE_READ
    on the source project see only the contract (symbol manifest + prerequisites)
    via /module-catalog and /module-dependencies/preview, NEVER the artifact.
  - Cross-tenant callers see 404 at every entry point.

  The current implementation enforces this invariant: GET /module/releases/:id
  requires permission MODULE_READ resolved against the URL :id (the module
  project). The catalog routes return contract only. What is misleading is the
  in-code comment, which suggests compiledIR exclusion is a confidentiality
  control — it is not (DSL ≈ IR).

IMPACT: Documentation drift, not a present-day leak. Risk: a future engineer
        relying on the literal comment might add a "let's also return the
        compiledIR for performance" change believing the route already exposes
        less than it does.

FIX:    (a) Rewrite the line-57 comment to state the actual invariant verbatim
            (see INVARIANT above). The artifact IS returned to module-owners
            and that is intentional; compiledIR is omitted because it is a
            redundant derived view.
        (b) Add the invariant to the feature spec API table for
            /module/releases/:releaseId.

TEST:   Boundary regression — extend api-module-routes.test.ts:
        - tenant member of module project with MODULE_READ → 200 + artifact present
        - tenant member of consumer project (no MODULE_READ on source) → 403 / 404
        - cross-tenant caller → 404
        These tests should be co-located with the comment in the route file so
        the invariant and tests evolve together.
```

### F-3 — `cloneDeploymentModuleSnapshot` (promotion path) skips auth-profile preflight

```
SEVERITY: MEDIUM
DIMENSION: Wiring / Parallel Paths
PATH: deployment PROMOTE (routes/deployments.ts:1265)
      → cloneDeploymentModuleSnapshot (build-service:1714)
      → DeploymentModuleSnapshot.create(... compressedPayload from source ...)
      runtime later attempts auth-profile resolution → fails at execution time

EVIDENCE: apps/runtime/src/services/modules/deployment-build-service.ts:1714-1799
  The clone path copies snapshot bytes verbatim into a new deployment. It does
  not call validateContractAuthProfiles or validateAuthProfileChecks. The
  build path (line 1307, 1493) does call them.

IMPACT: FR-25 promises "validate all requiredAuthProfiles ... at deployment
        time, failing closed". When a same-env promotion clones an existing
        snapshot AFTER an auth profile referenced by the snapshot has been
        deleted, the promotion succeeds but runtime fails. This is fail-LOUD
        rather than fail-CLOSED at deploy. Risk surface is narrow (intra-
        project, intra-env, between snapshot build and re-promote) but the
        promise is unmet.

FIX:    Add a pre-clone validation step that re-resolves the snapshot's
        embedded auth-profile names and the auth-profile checks gathered
        from mounted-tool / mounted-agent definitions (use the existing
        collectResolvedAuthProfileChecks helper after gunzipping the source
        payload). On any failure, return diagnostics analogous to the build
        path and require the caller to re-build (or to recreate the missing
        auth profile).

TEST:   Add to module-upgrade-lifecycle.e2e.test.ts (or a new test): create
        a deployment with auth-profile dependency, delete the auth profile,
        attempt to promote within the same environment — assert 422 with
        AUTH_PROFILE_PREFLIGHT_FAILED, NOT a runtime-level decryption error.
```

### F-4 — Publish-safety scanner blind to `agentCompanions` and tool `definition`; namespace-stripper blind to materialized tool definition

```
SEVERITY: MEDIUM
DIMENSION: Source / Writes
PATH: ProjectAgent.systemPromptLibraryRef.resolvedSystemPrompt + ProjectTool
      → buildModuleRelease.{normalizedCompanion, materializeModuleToolDefinition}
      → ModuleRelease.artifact.agents[].companion + artifact.tools[].definition
      → consumer snapshot

EVIDENCE: packages/project-io/src/module-release/build-module-release.ts:248-260
  validatePublishSafetyFn is called with safetyAgents/safetyTools/safetyProfiles
  built ONLY from dslContent strings. The route resolves prompt-library refs
  (releases/route.ts:291-325) and stores resolvedSystemPrompt in
  agentCompanions[storedAgentName], which then flows into
  artifactAgents[name].companion (build-module-release.ts:198-200). This
  content is never scanned for secrets.
  Similarly, materializeModuleToolDefinition (tool-definition.ts:38) returns
  a structured definition stored in artifactTools[name].definition (build-
  module-release.ts:235). The scanner sees dslContent (which is the source),
  so a regex match on raw DSL would still catch most secrets there — but the
  materialized definition can contain values transformed by JSON.parse of
  paramMeta.schema (tool-definition.ts:61), which could pull in fields like
  `default` or `description` that bypass dslContent-only scanning if the
  source DSL embeds them in a way that the scanner's regex misses (e.g.,
  embedded JSON-quoted strings whose Bearer/sk- token is broken across
  formatting). Also: stripVariableNamespaceIds runs on compiledIR (line
  185) but NOT on artifact.tools[].definition.

IMPACT: A future change to the publish flow that injects resolved values into
        agentCompanions or that materializes structured fields from non-DSL
        sources (e.g., a "resolvedConnectorBinding") could ship secrets
        unscanned. Today's risk is mostly latent — current materializers only
        read DSL — but the scanner's contract (`dslContent only`) does not
        match the artifact's actual content surface.

FIX:    Refactor validatePublishSafety to accept the FINAL artifact shape
        (post-stripping, post-materialization) and recursively walk all
        string values. Reuse the same regex set against the recursive
        string-collector. Apply stripVariableNamespaceIds (and a parallel
        stripDeep call) to artifact.tools[].definition for consistency
        with compiledIR.

TEST:   Add to module-publish-safety.test.ts: assert that a project whose
        agent companion `resolvedSystemPrompt` contains a known secret
        format produces a blocking issue. Add a test that asserts
        artifact.tools[].definition has variableNamespaceIds stripped.
```

### F-5 — Legacy `compiledIR` fallback path carries source-project-baked MCP server_config (with `encrypted_env` / `encrypted_auth_config`) into consumer snapshots

```
SEVERITY: HIGH (verified end-to-end on 2026-05-13)
DIMENSION: Source / Policy Boundary / Parallel Paths
PATH: publish flow (resolveToolImplementations with mcpServerConfigRawLoader)
      → buildMcpBindingFromProps(props, name, { mcpConfigMap }) bakes server_config
      → compileABLtoIR merges resolvedToolImplementations into ir.tools (replace
        non-system tools with the same name) at compiler.ts:383
      → ModuleRelease.compiledIR.<agent>.tools[].mcp_binding.server_config.{
          encrypted_env, encrypted_auth_config, auth_profile_id, env_profile_id }
      → buildDeploymentModuleSnapshot legacy-fallback branch (build-service:1384-1487)
      → DeploymentModuleSnapshot payload mountedAgents[].ir
      → runtime MCP tool dispatch attempts to decrypt encrypted_env under
        the CONSUMER tenant key

EVIDENCE (chain fully traced):
  1. apps/studio/src/lib/abl/studio-compiler-options.ts:99-109 passes
     mcpServerConfigRawLoader=findMcpServerConfigsRaw(tenantId, projectId)
     of the SOURCE module project to resolveToolImplementations.
  2. packages/shared/src/tools/resolve-tool-implementations.ts:320,327 builds
     `mcpConfigMap = new Map(configs.map(c => [c.name, c]))` where configs are
     the source project's mcp_server_configs rows (with encryptedEnv /
     encryptedAuthConfig fields).
  3. packages/shared/src/tools/resolve-tool-implementations.ts:609-614 calls
     `buildMcpBindingFromProps(props, tool.name, { mcpConfigMap, dslContent })`
     for each MCP tool.
  4. packages/shared/src/tools/dsl-property-parser.ts:621-633 sets
     `binding.server_config = { name, transport, url, encrypted_env,
        encrypted_auth_config, auth_type, auth_profile_id, env_profile_id, ... }`
     pulled directly from the source project's MCP config row.
  5. packages/compiler/src/platform/ir/compiler.ts:383 sets
     `ir.tools = [...nonSystemTools, ...safeResolvedTools, ...systemTools]`,
     promoting the resolved-tool object (with baked server_config) into the
     final per-agent IR returned by compileABLtoIR.
  6. The publish route (apps/studio/src/app/api/projects/[id]/module/releases/route.ts:404)
     stores this IR as `precompiledIR[storedAgentName]`, then
     `ModuleRelease.compiledIR: buildResult.compiledIR` at line 467.
  7. Build-service recompile path (build-service:474-498) re-materializes tool
     definitions WITHOUT mcpConfigMap (tool-definition.ts:118 omits
     mcpConfigMap), so the recompile path is safe.
  8. Build-service legacy-fallback branch (build-service:1384-1487) uses
     `compiledIR[agentName]` verbatim. resolveConfigVariables only resolves
     {{config.*}} templates; it does NOT strip baked server_config.

IMPACT: Two failure modes:
  (a) If MCP encryption key is tenant-scoped (most plausible), the consumer
      project's runtime decrypts the source project's credentials and
      transparently calls upstream APIs under those credentials. The module
      now exports CREDENTIALS — a direct FR-4 / FR-12 violation.
  (b) If MCP encryption key is project-scoped, decryption fails and the
      mounted MCP tool errors at runtime — feature broken on this path.
  When is legacy fallback taken? When canRecompileArtifactAgents() returns
  false (currently rare — only when an artifact agent has systemPromptLibraryRef
  but no resolvedSystemPrompt, which the publish route should prevent) OR when
  parseArtifactDocument fails OR when fresh compileABLtoIR returns errors
  (e.g., compiler version drift). Real but exception-class.

FIX:    Defense-in-depth at publish time:
        1. After `compileFn` produces compiledIR (build-module-release.ts:172),
           run a `stripBakedSourceProjectFields(ir)` pass that removes
           `tools[].mcp_binding.server_config`, `tools[].connector_binding`
           authoritative resolution, and any other "resolved at compile-time
           from source project DB" sub-trees. Keep only fields that are safe
           to re-resolve at deploy time in the consumer project.
        2. Add a publish-safety check: scan compiledIR for the literal keys
           {encrypted_env, encrypted_auth_config, auth_profile_id,
           env_profile_id} — block publish if present.
        3. (Optional) Remove the legacy-fallback branch entirely once the
           recompile path is verified always-callable, OR re-resolve MCP
           server_config from the CONSUMER project before mounting.

TEST:   Add to deployment-build-service.test.ts: publish a module whose tool
        DSL references an MCP server, snapshot it as a release, then load
        the release and call buildDeploymentModuleSnapshot in a consumer
        project that lacks the same MCP server config. Assert: (i) recompile
        path produces tool defs whose mcp_binding has NO server_config baked;
        (ii) legacy-fallback path (force via spy / mock canRecompile=false)
        either re-resolves under consumer config OR fails closed — never
        copies source `encrypted_env`.
```

### F-6 — Module-visibility default is fail-OPEN for legacy rows missing `moduleVisibility`

```
SEVERITY: LOW
DIMENSION: Read paths / Policy Boundary
PATH: catalog list / detail
      → Project.find({ $or: [moduleVisibility:'tenant', moduleVisibility:{$in:[null,undefined]}, moduleVisibility:{$exists:false}] })

EVIDENCE: apps/studio/src/app/api/projects/[id]/module-catalog/route.ts:36-41 and
          apps/studio/src/app/api/projects/[id]/module-catalog/[moduleProjectId]/route.ts:41-45
  Modules with no moduleVisibility set are returned to all tenant members
  ("backward compat"). For a feature whose principle is fail-closed, this is
  the wrong default. Current schema-time default is `private`, so new modules
  are safe; the risk is legacy / migrated rows or any future code path that
  forgets to set the field.

IMPACT: A module created before the visibility field landed (or via a code
        path that omits it) appears in every consumer-project catalog.
        Tenant-isolated, so leakage is intra-tenant only — but spec FR-2 says
        "default 'private'".

FIX:    Run a one-shot migration to set `moduleVisibility='private'` on all
        Project rows with kind='module' and missing/null moduleVisibility.
        Then change the catalog $or filter to only match `'tenant'`.

TEST:   Add to api-module-catalog-routes.test.ts: a module with explicit
        moduleVisibility=null is NOT returned by the catalog list/detail.
```

### F-7 — Failed module-publish and module-import attempts are not audited (all 422 branches)

```
SEVERITY: MEDIUM
DIMENSION: Writes (audit log)
PATH: (a) module/releases POST → buildModuleRelease returns success=false → 422
      (b) module/releases POST → readiness-issues 422 (route:177)
      (c) module/releases POST → DSL parse / compile errors 422 (route:267, :359)
      (d) module-dependencies POST → validateConfigOverrides blocks 400/422
          (route:336)
      (e) module-dependencies POST → prereq validation 422
      → no audit emitted on any of (a)..(e)

EVIDENCE:
  - apps/studio/src/app/api/projects/[id]/module/releases/route.ts logAuditEvent
    is invoked only at line 526 (MODULE_PUBLISHED success branch). The failure
    branches at lines 177 (readiness), 232 (profile parse), 268 (agent parse),
    341 (compiler-options), 360 (compile errors), 447 (publish-safety / build)
    return 422 with no audit call.
  - apps/studio/src/app/api/projects/[id]/module-dependencies/route.ts
    logAuditEvent fires only on success at line 378 (MODULE_IMPORTED). The
    rejection branches (collisions, override validation failures, missing
    prereqs) return 4xx with no audit call.

IMPACT: Security and compliance teams cannot see attempts that breach the
        publish-safety scanner or that attempt to inject secrets via config
        overrides. Repeated rejections (probing) leave no trail. The SOC2 /
        ISO27001 expectation for "audit of access control violations" is unmet
        for the module surface.

FIX:    Add two audit actions:
        - AuditActions.MODULE_PUBLISH_BLOCKED with metadata = {
            projectId, version, blockingCodes: errors.map(e => e.code),
            stage: 'readiness' | 'parse' | 'compile' | 'safety' | 'build'
          }
          emit from EVERY 4xx branch in module/releases POST.
        - AuditActions.MODULE_IMPORT_BLOCKED with metadata = {
            projectId, moduleProjectId, alias, blockingCodes,
            stage: 'selector' | 'permission' | 'collision' | 'overrides' | 'prereq'
          }
          emit from EVERY 4xx branch in module-dependencies POST (including
          the cross-tenant 404 — log even when we deliberately hide existence,
          for forensic purposes).

TEST:   Extend apps/studio/src/__tests__/module-audit-events.test.ts:
        - Publish with `Authorization: Bearer abc...` → MODULE_PUBLISH_BLOCKED
          with blockingCodes containing LITERAL_AUTH_VALUE
        - Publish with empty project (no agents) → MODULE_PUBLISH_BLOCKED
          with stage='build' and code at-least-one-agent
        - Import with override targeting a secret-flagged config key →
          MODULE_IMPORT_BLOCKED with stage='overrides'
        - Cross-tenant catalog probe (404 path) → MODULE_IMPORT_BLOCKED
          with stage='selector' or permission, recording the moduleProjectId
          attempted
```

### F-8 — `cloneDeploymentModuleSnapshot` reports `mountedAgentCount: 0` even when bytes are preserved

```
SEVERITY: LOW
DIMENSION: Wiring (consumer-visible metadata)
PATH: cloneDeploymentModuleSnapshot return value → callers using counts for
      logging/UI

EVIDENCE: build-service.ts:1776-1783 — returns
  `{ success: true, mountedAgentCount: 0, mountedToolCount: 0, ... }` even
  when the underlying payload may have many mounted agents/tools.

IMPACT: Cosmetic / observability. Deployment promotion logs and UI surfaces
        showing "0 mounted symbols" after a successful clone can mislead
        operators investigating an issue.

FIX:    Gunzip-and-count once after a successful clone, or extend the
        snapshot doc with the redundant counts at build time and read them
        back during clone.

TEST:   Add to module-cutover-safety.e2e.test.ts: assert that
        cloneDeploymentModuleSnapshot result reports the same
        mountedAgentCount/mountedToolCount as the source build.
```

### F-9 — Import `configOverrides` values are not scanned for inline secret patterns

```
SEVERITY: MEDIUM
DIMENSION: Source / Policy Boundary
PATH: consumer Studio UI / API
      → POST /api/projects/:id/module-dependencies { configOverrides: {...} }
      → validateConfigOverrides (config-overrides-validator.ts:47)
      → ProjectModuleDependency.configOverrides (DB write, route:343)
      → deployment-build mergedConfigVars = { ...projectConfigVars, ...configOverrides }
      → resolveConfigTemplatesInValue substitutes into mounted tool definitions
      → tools may emit the value into HTTP request headers / bodies / LLM prompts

EVIDENCE: packages/project-io/src/module-release/config-overrides-validator.ts:47-112
  validateConfigOverrides checks:
   (1) max key count
   (2) key is declared in contract
   (3) key not marked isSecret in contract
   (4) value size <= MAX_VALUE_BYTES
   (5) value has no {{...}} template injection
   (6) value has no control characters
  It does NOT scan the VALUE for inline secret patterns (Bearer / AWS / GitHub
  / Slack / Stripe / JWT). A consumer dev can therefore stash a real
  production credential into a non-secret config override (e.g.,
  override LOG_PREFIX = "Bearer ghp_realtoken..."). This is now persisted in
  the consumer DB (and audit metadata if any) and substituted into mounted
  module tool definitions at deploy time.

IMPACT: Two failure modes:
  (a) The credential becomes recoverable via any read path that returns the
      consumer dependency record (e.g., a Studio "edit override" UI).
  (b) The credential leaks into outbound HTTP requests if the override
      substitutes into a tool's URL/header — but that's the consumer's
      intentional configuration, so the leak surface is the cleartext-at-
      rest persistence in MongoDB and any audit metadata.
  Lower severity than F-1 because (i) the consumer is acting against their
  own project and (ii) the contract's isSecret flag already routes real
  secret keys through the dedicated secrets channel. But the defense-in-depth
  expectation is still failed.

FIX:    In validateConfigOverrides, run the same secret-pattern scanner used
        at publish (after F-1's extended pattern set lands) against each
        override value. Treat matches as blocking with code
        SECRET_PATTERN_IN_OVERRIDE.

TEST:   Add to packages/project-io/src/__tests__/config-overrides-validator.test.ts:
        - Override value containing "Bearer eyJ..." → blocking
        - Override value containing "ghp_..." → blocking
        - Override value containing "AKIA..." → blocking
        Add to api-module-dependencies.test.ts: integration test that the
        POST route returns 400/422 with SECRET_PATTERN_IN_OVERRIDE.
```

### F-10 — Audit gap: DELETE of module-dependency emits audit but does not strip the cleartext snapshot reference; ARCHIVE guard race window

```
SEVERITY: LOW
DIMENSION: Reads (audit) / Parallel paths
PATH: DELETE /api/projects/:id/module-dependencies/:dependencyId
      → reference check (mounted-symbol presence in working copy)
      → ProjectModuleDependency.deleteOne
      → DOES NOT TOUCH existing DeploymentModuleSnapshot rows (intentional —
        live deployments must keep their frozen mounts)
      ARCHIVE /api/projects/:id/module/releases/:releaseId
      → three-layer guard (pointers / active deployments / dependencies)
      → ModuleRelease.findOneAndUpdate({...}, { archivedAt, archivedBy })
      → audit MODULE_RELEASE_ARCHIVED

EVIDENCE:
  - The archive guard at module/releases/[releaseId]/route.ts:135-215 reads
    three signals (env pointers, snapshots+active deployments, dependency
    records) before flipping archivedAt. There is no transaction or version
    pin — between the reads at line 135-176 and the update at line 219, a
    concurrent deployment could promote a previously-draining deployment
    back to active or create a new dependency record. The window is small
    but real.
  - DELETE of a dependency does not cascade to any past snapshot; that is
    intentional and matches the freeze-at-deploy semantics.

IMPACT: For ARCHIVE: a race could allow archiving a release that, at the
        moment of the write, is referenced by an active deployment (created
        between the guard read and write). Spec FR-24 promises "blocked by
        409 if release is in use" — narrow race violates the promise.
        For DELETE: behaviour matches spec; calling out only because the
        audit's DEPENDENT-data-cleanup dimension required verification.

FIX:    Tighten the archive guard with optimistic concurrency: include the
        release's current `__v` (or a sentinel like `archivedAt: null`) in
        the findOneAndUpdate filter. Re-run the three-layer guard reads
        AFTER the write and, on detected new reference, roll back archivedAt
        (or fail the call and emit a corrective audit event).

TEST:   Add to deployment-promotion / archive integration test: simulate
        a concurrent deployment.create racing the archive — assert exactly
        one wins, and the loser returns 409.
```

### Positive findings (no action required) — runtime tool-dispatch and trace propagation are consumer-scoped

The following surfaces were audited and behave correctly per FR-12 / FR-13:

- **Runtime tool dispatch (`auth-profile-tool-middleware.ts:135`)** — resolves
  the tool's `auth_profile_ref` against the **consumer's** `tenantId` /
  `projectId` (passed in via the middleware config). `_moduleProvenance.alias`
  is read at line 168 ONLY for trace-event enrichment; it does NOT redirect
  the auth lookup. Mounted-module tools therefore run with consumer credentials,
  matching FR-12.
- **Trace emitter (`trace-emitter.ts:124-144`)** — every event emitted by a
  mounted-module agent is automatically enriched with `moduleAlias`,
  `moduleProjectId`, `moduleReleaseId`, `sourceAgentName` based on the
  `moduleProvenanceMap` keyed by aliased agent name. Owner tenant/project on
  the trace row is the consumer (from session context).
- **Deployment resolver (`deployment-resolver.ts:835-898`)** — `mergeModuleSnapshot`
  queries `DeploymentModuleSnapshot` filtered by **consumer** `tenantId` and
  `deploymentId`. Decompression cap is 50 MB. Tenant-match asserted at
  `assertTenantMatch` (line 903).
- **Agent registry isolation** — `agent-registry-isolation.test.ts` asserts
  cross-project (and cross-tenant) name collisions cannot leak: a session
  scoped to `(tenant-a, shared-project)` never resolves entries registered
  under `(tenant-b, shared-project)`.

## Findings Summary

| ID   | Severity | Dimension(s)               | Finding (one-liner)                                                                        |
| ---- | -------- | -------------------------- | ------------------------------------------------------------------------------------------ |
| F-1  | HIGH     | Source / Policy            | Publish safety regex set misses AWS/GitHub/Slack/Google/JWT secret formats                 |
| F-2  | MEDIUM   | Read paths                 | "compiledIR excluded for security" is misleading — artifact (DSL) is still returned        |
| F-3  | MEDIUM   | Wiring / Parallel paths    | Snapshot CLONE on promotion skips auth-profile preflight                                   |
| F-4  | MEDIUM   | Source / Writes            | Safety scanner blind to companions / tool `definition`; namespace strip not applied there  |
| F-5  | HIGH     | Source / Policy / Parallel | Legacy fallback path carries baked source-project MCP server_config (with encrypted blobs) |
| F-6  | LOW      | Read paths / Policy        | Catalog visibility filter defaults to fail-OPEN for null/missing moduleVisibility          |
| F-7  | MEDIUM   | Writes (audit)             | Failed/blocked publish AND import attempts are not audit-logged (all 4xx branches)         |
| F-8  | LOW      | Wiring / observability     | cloneDeploymentModuleSnapshot reports mountedAgentCount/mountedToolCount as 0              |
| F-9  | MEDIUM   | Source / Policy            | Import `configOverrides` VALUES not scanned for inline secret patterns                     |
| F-10 | LOW      | Reads / Parallel paths     | Archive three-layer guard has a TOCTOU race window (no optimistic concurrency)             |

## Round 1 Verdict

- **2 HIGH** findings (F-1, F-5) — both relate to inline-secret defense at publish
  time and source-project secret residue in compiledIR fallback paths. Both gate
  the FR-4 promise ("module releases never export secrets") and FR-12 promise
  ("imported execution stays within consumer project boundaries"). F-5 chain
  has been verified end-to-end through the publish flow (chain step 1–8 in F-5).
- **5 MEDIUM** findings (F-2, F-3, F-4, F-7, F-9) — boundary tests / audit gaps
  / parallel-path drift / defense-in-depth secret scanning on import overrides.
- **3 LOW** findings (F-6, F-8, F-10) — backward-compat default + observability +
  archive TOCTOU race.

**Phase advancement (BETA → STABLE) is blocked** until F-1 and F-5 are fixed
or explicitly accepted with documented compensating controls.

## Surfaces NOT Audited (out of scope)

The following are explicitly NOT covered by Round 1 and should be picked up in a
follow-up audit if BETA→STABLE promotion is requested with broader assurances:

- DSL parser and IR validator for module artifacts (assumed correct; covered by
  compiler-level tests).
- Project I/O cascade delete for module projects (`packages/database/src/cascade/
cascade-delete.ts`) — only the dependency cleanup half was reasoned about.
- The Studio UI surfaces themselves (read-only badges, ImportModuleDialog,
  UpgradeModuleDialog) — relevant to UX but not data-flow.
- Search-AI binding (`buildSearchAIBindingFromProps`) and Workflow binding
  (`buildWorkflowBindingFromProps`) baking behaviors — they likely have the
  same source-project resolution shape as MCP (F-5) but were not chased; the
  `searchai_binding` / `workflow_binding` keys ARE in the deployment-build
  service's DEPLOYMENT_RUNTIME_TOOL_KEYS list, suggesting they need the same
  defense-in-depth strip pass.
- Channel adapters (SDK, voice, A2A) that hand off into a mounted module agent
  — verified at the resolver layer (mergeModuleSnapshot) but not per-channel.
- LLM prompt construction with mounted-module agents — verified by inference
  (consumer config + provenance) but not by direct path-trace.

## Round 1b — UI Workflow Findings (appended 2026-05-14)

### F-11 — LOW: External report "tools never mount" diagnosis is incorrect

**Source:** External bug report claimed `confirmImport` never increments
`Project.moduleDependencyVersion` and that `buildDeploymentModuleSnapshot` then
hits a `countDocuments` fast-path returning null.

**Trace:**

- `apps/studio/src/app/api/projects/[id]/module-dependencies/route.ts:371-375`
  DOES `$inc: { moduleDependencyVersion: 1 }` (added in commit `4e5606a215`).
  Same increment runs in upgrade/remove handlers at
  `[dependencyId]/route.ts:186, 284`.
- `apps/runtime/src/services/modules/deployment-build-service.ts:1061-1069`
  fast-path gates on `ProjectModuleDependency.countDocuments`, NOT on
  `moduleDependencyVersion`. If any dep row exists, the fast-path does not fire.
- `moduleDependencyVersion` is consumed only as the optimistic-concurrency
  token for "did deps change during build?" (lines 1171, 1645).
  `apps/runtime/src/routes/deployments.ts:76` coerces missing→0 so deploys
  proceed regardless.

**Verdict:** Reporter's causal chain is wrong. The observed symptom (LLM has
no tools at runtime) is real but is caused by F-12, not by the increment
chain. Logged so triage doesn't chase the wrong cause.

**Action:** No code change. Misdiagnosis note recorded.

### F-12 — HIGH: "Insert Tool Signature" lands at line 1 with no `TOOLS:` wrapper

**Source:** External bug report (ABLP-990, referenced).

**Trace:**

1. `apps/studio/src/components/abl/ToolPickerDialog.tsx:91` —
   `handleInsertImported` calls `onInsert(buildImportedToolReferenceSnippet(...))`.
2. `apps/studio/src/components/abl/tool-snippets.ts:27` —
   `buildImportedToolReferenceSnippet` returns `  alias__name()` with no
   section header.
3. `apps/studio/src/components/abl/ABLEditor.tsx:125-159` (pre-fix) —
   `handleToolInsert` forwarded `lastCommandId` to `insertSnippetIntelligently`.
4. Toolbar "Insert Tool Reference" Wrench button (line 614 pre-fix) opens the
   legacy `ToolPickerDialog` WITHOUT stamping `setLastCommandId('tool')`. So
   `lastCommandId` is `''` (initial state) for this flow.
5. `IntelligentInsertion.ts:244-269` lookup of `CONSTRUCT_TO_SECTION['']` is
   undefined → falls through to the "insert at cursor as-is" branch → writes
   to `position.lineNumber`. On a freshly opened editor the cursor is at line
   1, so the snippet lands BEFORE `AGENT:`, producing "Unknown section"
   compile errors on every insert.

**Why F-12 explains F-11's symptom:** the agent DSL never gets a tool
reference inside a valid `TOOLS:` section, so `compileABLtoIR` emits an
agent IR with no tool entries, so the LLM call carries `tools: []`. The
module deployment snapshot may be perfectly built and still go unused.

**Fix (this commit):**

- `IntelligentInsertion.ts`: added `detectSectionFromSnippet` heuristic that
  routes identifier-with-parens snippets to `'tools'` when commandId is
  absent/unrecognized.
- `ABLEditor.tsx`: extended `handleToolInsert` with an optional
  `commandIdOverride`; added `handleToolPickerInsert` that forces
  `commandId='tool'` for both `ToolPickerDialog` and `ToolPickerModal`;
  Wrench button now also stamps `setLastCommandId('tool')` as defense in
  depth. GuardrailPickerModal, TemplatePickerModal, and TemplateInsertPanel
  wiring is unchanged (out of scope; rich-content panel routes inserts at
  cursor by design).
- Added `apps/studio/src/__tests__/components/intelligent-insertion.test.ts`
  with 6 scenarios: explicit `'tool'`, append-into-existing-TOOLS,
  empty-commandId regression, unknown-commandId regression, full signature
  snippet, non-tool-no-section.

**End-to-end verification note:** the unit tests prove the snippet lands in
`TOOLS:`. The downstream chain (DSL save → compile → IR → runtime tool list)
is reasoned, not measured in this commit; a live end-to-end smoke remains a
follow-up.

## Round 2 (Fix Verification) — Not Yet Started

| Finding | Fix Committed | Boundary Test Added | Verified |
| ------- | ------------- | ------------------- | -------- |
| F-1     | —             | —                   | —        |
| F-2     | —             | —                   | —        |
| F-3     | —             | —                   | —        |
| F-4     | —             | —                   | —        |
| F-5     | —             | —                   | —        |
| F-6     | —             | —                   | —        |
| F-7     | —             | —                   | —        |
| F-8     | —             | —                   | —        |
| F-9     | —             | —                   | —        |
| F-10    | —             | —                   | —        |

## Final Verdict (Round 1 Only)

- [ ] No CRITICAL findings open (no CRITICAL severity assigned; 2 HIGH instead)
- [x] All boundary tests inventoried; gaps enumerated in each finding's TEST line
- [x] Parallel paths verified — recompile vs legacy-fallback identified as the
      principal divergence; F-5 documents the asymmetry
- [x] Audit log complete for Round 1

Round 2 must verify F-1 and F-5 fixes before STABLE promotion. Round 2 must
also re-trace the publish → compiledIR boundary specifically for any newly
introduced strip steps to confirm they cover all "resolved-at-publish" fields
(MCP, connectors, workflows, searchai).

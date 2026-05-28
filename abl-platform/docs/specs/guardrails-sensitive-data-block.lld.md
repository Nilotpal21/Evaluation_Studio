# Guardrails — Sensitive Data Block — Low-Level Design (LLD)

**Status**: DONE (implementation landed 2026-05-18; 12 commits on `discuss/guardrails-pii-consolidation`)
**Date**: 2026-05-18
**JIRA**: ABLP-723
**Branch**: `discuss/guardrails-pii-consolidation`
**Owner**: Platform / Guardrails

**Related artifacts:**

- Feature Spec: [`docs/features/sub-features/guardrails-sensitive-data-block.md`](../features/sub-features/guardrails-sensitive-data-block.md)
- Test Spec: [`docs/testing/sub-features/guardrails-sensitive-data-block.md`](../testing/sub-features/guardrails-sensitive-data-block.md)
- HLD: [`docs/specs/guardrails-sensitive-data-block.hld.md`](./guardrails-sensitive-data-block.hld.md)
- Phase log: [`docs/sdlc-logs/guardrails-sensitive-data-block/`](../sdlc-logs/guardrails-sensitive-data-block/)
- Clarifying decisions: [`docs/sdlc-logs/guardrails-sensitive-data-block/clarifying-questions.md`](../sdlc-logs/guardrails-sensitive-data-block/clarifying-questions.md)

---

## 1. Scope

This LLD is the **file-level, line-numbered implementation companion** to the HLD. It answers:

- Which files change, and how (additive vs. modification vs. new).
- Exact type / schema diffs and their precise insertion points.
- Task decomposition with acceptance criteria and test mapping.
- Risks with concrete mitigations and validation steps.

The LLD does **not** re-state the problem, alternatives, or architectural rationale — those live in the HLD. The LLD does **not** include narrative API design — it lists the request/response shapes and routes that the HLD already approved.

**Out of scope** (deferred):

- `guardrail:activate` lifecycle permission split (HLD §4 concern #4 — 6-step runbook captured for future PR).
- Audit-logging beyond trace events (GAP-002 — post-v1).
- Third-party PII provider UI (Microsoft Presidio / AWS Comprehend Medical).

---

## 2. Non-Negotiable Invariants

These come from the platform principles + the HLD's locked decisions. Every task in §6 must preserve them.

1. **Tenant isolation**: every new query path scopes by `tenantId` (uses `tenantIsolationPlugin` or explicit filter). **Authenticated** cross-tenant access returns 404 (no filter match — `buildScopedPolicyFilter` ensures `tenantId` is always in the query); never 403. The 403 response is reserved for **missing auth context** (`getTenantId(req)` returns null, i.e., no tenant attached to the request) — this is a distinct case from cross-tenant access (R7-F2).
2. **Project isolation**: project-scoped routes (`/api/projects/:projectId/guardrail-policies`) filter by `projectId` AND use `requireRouteScopePermission(req, res, 'guardrail:<op>')`. Tenant-scoped routes (`/api/guardrail-policies`) use `requirePermissionInline('guardrail:<op>')`.
3. **Centralized auth**: no custom JWT verification. All routes mount under the existing `createUnifiedAuthMiddleware` chain.
4. **Additive feature commit**: zero deletions of exported symbols. `kind` enum is **unchanged** (`'both'` is form-only convenience, never persisted).
5. **Stateless runtime**: no pod-local timers / polling. The 5-second undo toast lives in the Studio client; the server-side route is fully stateless.
6. **Field-propagation lint**: every cross-boundary field (`entities`, `enabled`, `presetKey`, `actionMessage`) must propagate through schema → resolver IR → provider request → trace event in the same change, with round-trip test coverage.
7. **No `vi.mock` of platform components**: all tests use DI via the existing `request.context.piiRecognizerRegistry` seam.
8. **HTTP-only E2E**: trace assertions go through `GET /api/projects/:projectId/sessions/:id/traces`; no direct trace-store reads in E2E.
9. **Permission model frozen for v1**: `guardrail:read` / `guardrail:write` / `pii-pattern:read` only. No new RBAC permission strings added.

---

## 3. Resolved Open Questions (Oracle Pass)

| #       | Question                        | Verdict  | Resolution                                                                                                                                                               |
| ------- | ------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q-LLD-1 | HTTP status for guardrail block | ANSWERED | **200 OK** with `{response, action: {type: 'respond'}}` — matches `reasoning-executor.ts:1925-1928`. Block decision IS the response, not an error.                       |
| Q-LLD-2 | Faulty-recognizer fixture       | DECIDED  | Inject custom `PIIRecognizerRegistry` via `request.context.piiRecognizerRegistry` (already a DI seam at `builtin-pii.ts:25`). Zero `vi.mock`.                            |
| Q-LLD-3 | Trace store query API for tests | DECIDED  | E2E uses production `GET /api/projects/:projectId/sessions/:id/traces?types=guardrail_input_blocked`. Integration tests may use `getTraceStore().getEvents()` directly.  |
| Q-LLD-4 | Undo HTTP shape                 | DECIDED  | `POST /:id/reactivate` with `{ ruleId }` body — atomic single-doc `findOneAndUpdate` (matches `deployments/:id/rollback` precedent).                                     |
| Q-LLD-5 | Tenant-scoped route path        | ANSWERED | `POST /api/guardrail-policies` (top-level mount at `server.ts:1249`). Same router, scope inferred from `req.params.projectId` presence at `guardrail-policies.ts:57-60`. |

---

## 4. Data Model — Schema Diffs

### 4.1 `IGuardrailRule` (additive)

**File**: `packages/database/src/models/guardrail-policy.model.ts:35-50` (interface), `L139-165` (schema)

```diff
 export interface IGuardrailRule {
   guardrailName: string;
   override: 'disable' | 'threshold' | 'action' | 'severity_actions' | 'define';
   threshold?: number;
   action?: Record<string, unknown>;
   severityActions?: Record<string, unknown>;
   kind?: 'input' | 'output' | 'tool_input' | 'tool_output' | 'handoff';
   tier?: 'local' | 'model' | 'llm';
   provider?: string;
   category?: string;
   check?: string;
   llmCheck?: string;
   description?: string;
   priority?: number;
   message?: string;
+  // ─── Sensitive Data Block additions (ABLP-723) ───────────────────────
+  /** Restricts builtin-pii recognizer set; absent ⇒ all enabled entities. */
+  entities?: string[];
+  /** Per-rule enable flag; absent ⇒ enabled. Auto-deactivation may flip to false. */
+  enabled?: boolean;
+  /** Identifies the preset that produced this rule (e.g. `sensitive_data_block`). */
+  presetKey?: string;
+  /** User-visible block message (top-level, distinct from legacy `action.message`). */
+  actionMessage?: string;
 }
```

**Schema additions at L139-165:**

```diff
 const GuardrailRuleSchema = new Schema<IGuardrailRule>(
   {
     guardrailName: { type: String, required: true },
     // … unchanged fields …
     message: { type: String, default: undefined },
+    entities: { type: [String], default: undefined },
+    enabled: { type: Boolean, default: undefined },
+    presetKey: { type: String, default: undefined },
+    actionMessage: { type: String, default: undefined },
   },
   { _id: false },
 );
```

**`kind` enum: UNCHANGED.** L150-154 retains `['input', 'output', 'tool_input', 'tool_output', 'handoff']`. The `'both'` value is a Studio-form convenience expanded to two rules in `serializeRule()` (`GuardrailPolicyForm.tsx:504-508`) and `normalizeRules()` (`guardrail-policies.ts:538-543`) before persistence.

**Indexes at L270-282: UNCHANGED.** No new index added — the new fields are filter targets only inside loaded documents, not query keys.

**`enabled` default = `undefined` (HLD §10 correction).** HLD §10 states `enabled` Mongoose default is `false`. **This LLD overrides that to `default: undefined`** for backward compatibility — legacy rules persisted before this feature lack the `enabled` field, and a `default: false` would cause Mongoose hydration to silently mark them disabled, breaking every existing policy. The `rule.enabled !== false` predicates in §5.2 (resolver skip) and §5.4 (activation gate) deliberately treat `undefined` as "enabled" — only explicit `false` disables a rule. The HLD §10 statement will be amended in the cross-phase R5 round.

### 4.2 `failMode` default flip — THREE sites

The flip is **not a single-site change**. Three independent default sources must be aligned, or the new schema default is dead code (the route-layer normalizer always overrides it on POST/PUT).

| Site                              | File                                                     | Line                             | Current                                                                              | New                |
| --------------------------------- | -------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------ | ------------------ |
| **(a) Mongoose schema default**   | `packages/database/src/models/guardrail-policy.model.ts` | L194                             | `default: 'closed'`                                                                  | `default: 'open'`  |
| **(b) Route normalizer fallback** | `apps/runtime/src/routes/guardrail-policies.ts`          | L206                             | `raw.failMode === 'open' ? 'open' : raw.failMode === 'closed' ? 'closed' : 'closed'` | `... : 'open'`     |
| **(c) Route default constant**    | `apps/runtime/src/routes/guardrail-policies.ts`          | L141 (`DEFAULT_POLICY_SETTINGS`) | `failMode: 'closed'`                                                                 | `failMode: 'open'` |

**Schema:**

```diff
-failMode: { type: String, required: true, enum: ['open', 'closed'], default: 'closed' },
+failMode: { type: String, required: true, enum: ['open', 'closed'], default: 'open' },
```

**Route normalizer at L206:**

```diff
-failMode: raw.failMode === 'open' ? 'open' : raw.failMode === 'closed' ? 'closed' : 'closed',
+failMode: raw.failMode === 'open' ? 'open' : raw.failMode === 'closed' ? 'closed' : 'open',
```

**Route default constant at L141:**

```diff
 const DEFAULT_POLICY_SETTINGS: NormalizedSettings = {
-  failMode: 'closed',
+  failMode: 'open',
   timeouts: { … },
```

**Cross-reference**: `apps/runtime/src/services/guardrails/policy-resolver.ts:117-120` already has `DEFAULT_SETTINGS.failMode = 'open'` — no change required there. After this flip, **all four** default sources agree on `'open'`.

**INT-10 must cover** (per F-4 R1 finding): a PUT body that omits `failMode` entirely — confirms the new `'open'` default is observable in the persisted document. Without this case, the test would only exercise the schema default, which the route normalizer would silently re-override.

**Migration**: NONE. Pre-launch posture, no production records carry the old default. **Risk-R-3** is mitigated by §6 task `T-DB-2` which audits test fixtures for hard-coded `'closed'` and updates them in the same commit.

### 4.3 `PolicyRule` (resolver mirror)

**File**: `apps/runtime/src/services/guardrails/policy-resolver.ts:11-27`

```diff
 export interface PolicyRule {
   guardrailName: string;
   override: 'disable' | 'threshold' | 'action' | 'severity_actions' | 'define';
   // … unchanged fields …
   message?: string;
+  entities?: string[];
+  enabled?: boolean;
+  presetKey?: string;
+  actionMessage?: string;
 }
```

### 4.4 `Guardrail` IR interface (compiler)

**File**: `packages/compiler/src/platform/ir/schema.ts:1603-1637`

```diff
 export interface Guardrail {
   name: string;
   description?: string;
   kind: 'input' | 'output' | 'tool_input' | 'tool_output' | 'handoff';
   priority?: number;
   tier?: 'local' | 'model' | 'llm';
   provider?: string;
   category?: string;
   threshold?: number;
   check?: string;
   llmCheck?: string;
   action: GuardrailAction;
   severityActions?: { … };
+  /** Recognizer-set restriction for builtin-pii. Sensitive Data Block preset. */
+  entities?: string[];
+  /** Preset identifier propagated into trace events. */
+  presetKey?: string;
 }
```

`enabled` and `actionMessage` are runtime-only routing concerns; they do not enter the IR. The resolver skips disabled rules (§5.2) and renders `actionMessage` via the existing `action.message` slot when producing the IR action object.

### 4.5 `GuardrailEvalRequest.context` — propagation slot

**File**: `packages/compiler/src/platform/guardrails/provider.ts:4-21`

The provider receives the entity allowlist **via the request `context` bag**, not via the `guardrail` field. This matches the HLD §3.6 hop 3-4 contract and aligns with how `piiRecognizerRegistry` is already propagated.

```diff
 export interface GuardrailEvalRequest {
   content: string;
   category?: string;
   context?: {
     piiRecognizerRegistry?: PIIRecognizerRegistry;
+    /** Restricts builtin-pii to the named recognizer entities; absent ⇒ all enabled. */
+    allowedEntityTypes?: string[];
     // … existing context fields …
   };
 }
```

The `entities` field added to `Guardrail` IR (§4.4) is the **source of truth on the IR side**; `allowedEntityTypes` in the request context is the **provider-side projection**. The mapping happens in `tier2-evaluator.ts:172-179` (§5.3b below).

---

## 5. Behavior Diffs (Runtime + Compiler)

### 5.1 `toSyntheticGuardrail()` — propagation

**File**: `apps/runtime/src/services/guardrails/policy-resolver.ts:126-152`

```diff
 function toSyntheticGuardrail(rule: PolicyRule): Guardrail {
   const provider = rule.provider?.trim();
   const llmCheck = rule.llmCheck?.trim();
   const check = rule.check?.trim();
   const action: GuardrailAction =
     rule.action && typeof rule.action === 'object' && 'type' in rule.action
       ? (rule.action as unknown as GuardrailAction)
       : {
           type: 'block',
-          message: rule.message ?? formatErrorSync('GUARDRAIL_POLICY_BLOCKED').message,
+          message:
+            rule.actionMessage ??
+            rule.message ??
+            formatErrorSync('GUARDRAIL_POLICY_BLOCKED').message,
         };

   return {
     name: rule.guardrailName,
     description: rule.description ?? `Policy-defined: ${rule.guardrailName}`,
     kind: rule.kind ?? 'output',
     priority: rule.priority ?? 50,
     tier: rule.tier ?? (provider ? 'model' : llmCheck ? 'llm' : 'local'),
     provider,
     category: rule.category,
     threshold: rule.threshold,
     check,
     llmCheck,
     action,
     severityActions: rule.severityActions as Guardrail['severityActions'],
+    entities: rule.entities,
+    presetKey: rule.presetKey,
   };
 }
```

**Precedence rule** (resolves feature-spec R4 M-1 finding): `actionMessage` takes priority over legacy `action.message` for SDB rules. For non-SDB rules where `actionMessage` is undefined, the existing fallback chain stays intact.

### 5.2 `enabled: false` skipping in policy resolver

**File**: `apps/runtime/src/services/guardrails/policy-resolver.ts` — in the `applyOverrides()` / rule iteration block (around L180-260; exact location at implementation time).

```diff
 for (const rule of policy.rules) {
+  if (rule.enabled === false) {
+    // Auto-deactivated or explicitly disabled by user; skip without warning.
+    continue;
+  }
   // … existing override switch …
 }
```

A disabled rule is **silently** skipped — no warning log. Activation gating (§5.4) ensures a policy with zero enabled rules never reaches the resolver in active state.

### 5.3 `BuiltinPIIProvider` — entity filter

**File**: `packages/compiler/src/platform/guardrails/providers/builtin-pii.ts:23-42`

The filter reads `allowedEntityTypes` from the **request context** (the canonical propagation slot per HLD §3.6 + §4.5 above), **not** from a hypothetical `request.guardrail.entities` (which does not exist on `GuardrailEvalRequest`).

```diff
 export class BuiltinPIIProvider implements GuardrailProvider {
   async evaluate(request: GuardrailEvalRequest): Promise<GuardrailEvalResult> {
-    const result = await detectPII(
-      request.content,
-      request.context?.piiRecognizerRegistry,
-    );
-    // existing decision logic reads `result.detections`
+    const result = await detectPII(
+      request.content,
+      request.context?.piiRecognizerRegistry,
+    );
+
+    // Sensitive Data Block: filter detections to the rule's allowlisted entities.
+    // CRITICAL: each detection's entity field is `type` (typed `PIIType`), NOT
+    // `entityType`. Field-name confusion here would silently pass every detection
+    // through the filter — the R-1 highest-risk failure mode.
+    // Use Set for O(1) membership lookup; bounded at ~37 entities today but
+    // forward-compatible if the pack catalog grows.
+    const allow = request.context?.allowedEntityTypes;
+    const allowSet = allow && allow.length > 0 ? new Set(allow) : null;
+    const filteredDetections = allowSet
+      ? result.detections.filter((d) => allowSet.has(d.type))
+      : result.detections;
+
+    // Decision logic reads `filteredDetections` instead of `result.detections`.
+    // Score / hasViolations derived from filteredDetections.length > 0.
   }
 }
```

**Filter semantics** (HLD §3.6, oracle D-9 for risk R-1):

- The detection element field is **`type`** (`PIIType`, defined at `pii-detector.ts:20-28`). A typo of `entityType` would compile (it would be `undefined` on every detection) and silently pass every PII finding through — this is the R-1 highest-risk failure mode. Implementers MUST use `d.type`.
- Membership check uses strict `Set.has` on the recognizer's canonical entity ID string (no `startsWith`, no case-folding, no normalization).
- Empty / undefined `allowedEntityTypes` = all entities (backwards-compatible).
- Filter happens **post-detection**, **pre-decision**. Recognizers always run on full content.
- INT-2's 8-case matrix is the primary safety net; INT-2 MUST include a case where the rule allowlist contains an entity ID that has no matching detection to verify the filter is exercised, not bypassed.

### 5.3b `tier2-evaluator.ts` — request construction (projects `Guardrail.entities` → `context.allowedEntityTypes`)

**File**: `packages/compiler/src/platform/guardrails/tier2-evaluator.ts:172-179`

```diff
 const request: GuardrailEvalRequest = {
   content,
   category: guardrail.category,
   context: {
     ...existingContext,
     piiRecognizerRegistry,
+    allowedEntityTypes: guardrail.entities,
   },
 };
```

This is the **hop-3 projection point** in the 4-hop reachability chain (Schema → resolver → **tier2-evaluator** → provider). The provider stays decoupled from `Guardrail.entities` — it only knows about `context.allowedEntityTypes`. This separation enables future per-call overrides (e.g., a Studio "debug" surface that injects a one-off allowlist without mutating the IR).

### 5.4 Activation gate — `POST /:id/activate`

**File**: `apps/runtime/src/routes/guardrail-policies.ts:1339-1398` (existing activate handler)

The block lands **after** the existing tenant+scope fetch at `L1355-1357` and **before** `deactivateSiblingPolicies()` at `L1372`.

```diff
   const context = getRouteScopeContext(req);
   if (!(await requireRouteScopePermission(req, res, context, 'guardrail:write'))) return;

   const existing = await GuardrailPolicy.findOne(
     buildScopedPolicyFilter(tenantId, context, req.params.id),
   ).lean();
   if (!existing) {
     res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Guardrail policy not found' } });
     return;
   }

+  // ABLP-723: refuse activation if no rules are enabled.
+  const hasEnabled =
+    Array.isArray(existing.rules) && existing.rules.some((r) => r.enabled !== false);
+  if (!hasEnabled) {
+    writeAuditLog({
+      action: 'guardrail-policy:activation-blocked',
+      tenantId,
+      userId: req.tenantContext?.userId,
+      metadata: {
+        policyId: existing._id,
+        // projectId is null for tenant-scoped policies — intentional;
+        // audit queries use tenantId as the primary partition key.
+        projectId: (existing.scope as GuardrailPolicyScope | undefined)?.projectId ?? null,
+        reason: 'no_enabled_rules',
+        requestId,
+      },
+    });
+    res.status(400).json({
+      success: false,
+      error: { code: 'NO_ENABLED_RULES', message: 'Cannot activate a policy with zero enabled rules.' },
+    });
+    return;
+  }

   // existing: deactivateSiblingPolicies + findOneAndUpdate + audit log …
```

**Trace event emission**: in the runtime's executor (where the `TraceStore` is in scope), the registered event `guardrail_activation_blocked` may also be emitted from any consumer that needs session-correlated tracing. For the **route handler**, we use the existing `writeAuditLog` infrastructure (consistent with the file's existing `writeAuditLog({ action: 'guardrail-policy:update', ... })` calls at L1298, L1388, L1451) — this is the established server-side observability path for route-lifecycle events. The `GUARDRAIL_TRACE_EVENT_TYPES` registry entries (§T-TR-1) remain useful for executor-side trace correlation when these events fire in chat session contexts.

**Future flip point** (HLD §4 concern #4): the `requireRouteScopePermission(req, res, context, 'guardrail:write')` line at `L1352` is the single-line edit when `guardrail:activate` is later split out. The 6-step runbook is in the HLD; no code lives here for the future split.

### 5.5 Auto-deactivation — PUT handler

**File**: `apps/runtime/src/routes/guardrail-policies.ts:1132` (PUT `/:id`)

**Code-grounded correction (R3-F8 + R3-F9)**: today's PUT handler computes `sanitized = sanitizeBody(req.body)`, then `sanitized.rules = normalizeRules(sanitized.rules)`, then computes `lifecycleUpdate` separately, then writes `{ $set: { ...sanitized, ...scopeUpdate, ...(lifecycleUpdate ?? {}) } }` in one `findOneAndUpdate` expression. Auto-deactivation must therefore be expressed as the **last spread** in the `$set` object so it overrides any prior `isActive`/`status` value from `lifecycleUpdate`.

```diff
 // existing: sanitized.rules = normalizeRules(sanitized.rules) at L1183-1185
 // existing: lifecycleUpdate computation at L1253-1254

+// ABLP-723: if every rule is now disabled and the policy was active, the PUT
+// must atomically auto-deactivate. Built as a separate object so it can spread
+// LAST in the $set, overriding any client-supplied status:'active' that would
+// otherwise leak through lifecycleUpdate.
+const sanitizedRules = Array.isArray(sanitized.rules) ? sanitized.rules : [];
+const allDisabled =
+  sanitizedRules.length > 0 && sanitizedRules.every((r: any) => r?.enabled === false);
+const autoDeactivated = allDisabled && existing.isActive === true;
+const autoDeactivationUpdate = autoDeactivated
+  ? { isActive: false, status: 'draft' as const }
+  : {};

 const updated = await GuardrailPolicy.findOneAndUpdate(
   buildScopedPolicyFilter(tenantId, context, req.params.id),
-  { $set: { ...sanitized, ...scopeUpdate, ...(lifecycleUpdate ?? {}) } },
+  {
+    $set: {
+      ...sanitized,
+      ...scopeUpdate,
+      ...(lifecycleUpdate ?? {}),
+      ...autoDeactivationUpdate, // MUST be last spread to override lifecycle
+    },
+  },
   { new: true, runValidators: true },
 );

+if (autoDeactivated) {
+  writeAuditLog({
+    action: 'guardrail-policy:auto-deactivated',
+    tenantId,
+    userId: req.tenantContext?.userId,
+    metadata: {
+      policyId: updated?._id,
+      projectId: (updated?.scope as GuardrailPolicyScope | undefined)?.projectId ?? null,
+      reason: 'all_rules_disabled',
+      undone: false,
+      requestId,
+    },
+  });
+}

 return res.json({
   success: true,
   data: await normalizePolicyForResponse(updated),
+  autoDeactivated,
 });
```

**Atomicity scope** (refined per HLD §3.4): the `findOneAndUpdate` write is per-document atomic, applying both the rules array and the `isActive: false / status: 'draft'` fields in one operation. The `allDisabled` predicate is computed from the **request body** (`normalized`), not from the live DB state, so this is **not** a strict atomic conditional — under concurrent PUTs, the last writer wins on the rule contents AND on the lifecycle state simultaneously. The HLD §3.4 race diagram captures this correctly; INT-4's `Promise.all` race test verifies the **only acceptable interleaving**: both writes apply their full payload, and `autoDeactivated: true` reflects the writer's own predicate evaluation. There is no scenario where one writer's rules apply but the other's lifecycle flag wins — they are written together.

**Lifecycle precedence**: client-supplied `status: 'active'` in the PUT body is **overridden** by auto-deactivation when `allDisabled === true`. INT-12 covers this case (added to test spec).

### 5.6 `POST /:id/reactivate` — new sugar route

**File**: `apps/runtime/src/routes/guardrail-policies.ts` — insert after the `/:id/activate` block (after `L1395`).

```typescript
import { z } from 'zod';

const ReactivateBodySchema = z
  .object({
    guardrailName: z.string().min(1),
  })
  .strict();

router.post('/:id/reactivate', async (req: any, res) => {
  const requestId = getCurrentRequestId();
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) {
      res.status(403).json({
        success: false,
        error: { code: 'TENANT_ACCESS_DENIED', message: 'Tenant access denied' },
      });
      return;
    }

    const context = getRouteScopeContext(req);
    if (!(await requireRouteScopePermission(req, res, context, 'guardrail:write'))) return;

    const parsed = ReactivateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_BODY', message: parsed.error.message },
      });
      return;
    }
    const { guardrailName } = parsed.data;

    // Atomically re-enable the named rule AND reactivate the policy.
    // NOTE: `rules.guardrailName` is the match key because `GuardrailRuleSchema`
    // has `_id: false` — rules are addressed by their guardrailName, not an _id.
    // Mongo's `$` positional updates the FIRST matching rule; if `kind: 'both'`
    // produced two persisted rules with the same guardrailName, callers must
    // issue two reactivate calls (one per kind). T-UI-3 handles this in the
    // undo handler by mapping the disabled-rule set, not a single name.
    const updated = await GuardrailPolicy.findOneAndUpdate(
      {
        ...buildScopedPolicyFilter(tenantId, context, req.params.id),
        'rules.guardrailName': guardrailName,
      },
      {
        $set: {
          'rules.$.enabled': true,
          isActive: true,
          status: 'active',
        },
      },
      { new: true, runValidators: true },
    ).lean();

    if (!updated) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Guardrail policy or rule not found' },
      });
      return;
    }

    // CRITICAL: mirror the `/:id/activate` post-write contract — without these
    // calls, two policies could be active in the same scope after an undo,
    // and the runtime would keep serving the stale (deactivated) policy until
    // an unrelated cache flush.
    const updatedScope =
      updated.scope && typeof updated.scope === 'object'
        ? (updated.scope as GuardrailPolicyScope)
        : ({ type: 'tenant' } satisfies GuardrailPolicyScope);
    await deactivateSiblingPolicies(tenantId, updatedScope, req.params.id);
    await bumpAffectedPolicyEpochs(tenantId, updatedScope);
    invalidateGuardrailEvalCache(tenantId);
    invalidateTenantProviderCache(tenantId);

    writeAuditLog({
      action: 'guardrail-policy:reactivated',
      tenantId,
      userId: req.tenantContext?.userId,
      metadata: {
        policyId: updated._id,
        projectId: updatedScope.projectId ?? null,
        guardrailName,
        undone: true,
        requestId,
      },
    });

    res.json({ success: true, data: await normalizePolicyForResponse(updated) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to reactivate guardrail policy', { error: message, requestId });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to reactivate guardrail policy' },
    });
  }
});
```

**Permission**: `guardrail:write` (same as activate). **Atomic shape**: single `findOneAndUpdate` with `$.` positional update — no read-modify-write race for the rule-flip + lifecycle pair. **Trace contract**: emits via `writeAuditLog` with `undone: true` so the metric pipeline can count undo conversions. **Body param**: `guardrailName` (renamed from `ruleId` for clarity — it maps to `IGuardrailRule.guardrailName`, the only addressable rule identifier given `_id: false` on the embedded schema).

**`kind: 'both'` interaction**: when a Studio-form `kind: 'both'` rule auto-deactivated, `serializeRule()` (§T-UI-1 amendment below) persisted both halves with the same `guardrailName` and `enabled: false`. T-UI-3's undo handler issues **two** sequential POSTs (one for each `kind`-half) by reading the prior rule snapshot held in the toast component state — the server route stays scoped to a single positional update per call to preserve atomicity simplicity.

### 5.7 New route — `GET /api/projects/:projectId/pii-entities`

**File**: new file `apps/runtime/src/routes/pii-entities.ts`; mount at `apps/runtime/src/server.ts:1248-1250` (sibling of `guardrail-policies` mount).

**Helper extraction prerequisite (F-3 fix)**: `requireRouteScopePermission` is currently file-local (not exported) at `guardrail-policies.ts:96-106`. T-RT-3 extracts it to a new shared helper `apps/runtime/src/routes/guardrail-helpers.ts` (with `getRouteScopeContext`, `buildScopedPolicyFilter`) and re-imports it from `guardrail-policies.ts`. **Extraction note (R7-F3)**: `requireRouteScopePermission` is declared `async` because the project-scope branch calls `requireProjectPermission()` (async). The tenant-scope branch calls `requirePermissionInline()` which is synchronous — `await` on a non-Promise resolves immediately, so the dual-branch async signature is harmless. Add a JSDoc comment to the extracted helper: `/** Note: tenant-scope branch calls synchronous requirePermissionInline; await is a no-op for that path. */`. The new `pii-entities` route imports from that helper file directly:

```typescript
// apps/runtime/src/routes/pii-entities.ts
import { Router } from 'express';
import { z } from 'zod';
import { getRouteScopeContext, requireRouteScopePermission } from './guardrail-helpers.js';
import { listEnabledPIIEntities } from '@abl/compiler/platform';
import { getProjectPIIConfig } from '../services/pii/project-pii-config.js';
import { getTenantId } from '../middleware/tenant-context.js';

const ParamsSchema = z.object({ projectId: z.string().min(1) });

const router = Router({ mergeParams: true });

router.get('/', async (req: any, res) => {
  const tenantId = getTenantId(req);
  if (!tenantId) {
    res.status(403).json({
      success: false,
      error: { code: 'TENANT_ACCESS_DENIED', message: 'Tenant access denied' },
    });
    return;
  }

  const params = ParamsSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({
      success: false,
      error: { code: 'INVALID_PARAMS', message: params.error.message },
    });
    return;
  }

  const context = getRouteScopeContext(req);
  if (!(await requireRouteScopePermission(req, res, context, 'pii-pattern:read'))) return;

  const cfg = await getProjectPIIConfig({ tenantId, projectId: params.data.projectId });
  const entities = listEnabledPIIEntities(cfg.enabledPacks, cfg.customRecognizers);
  res.json({ success: true, data: { entities } });
});

export default router;
```

**Server mount diff** at `apps/runtime/src/server.ts:1250` (insert):

```diff
 app.use('/api/projects/:projectId/guardrail-policies', guardrailPoliciesRouter);
 app.use('/api/guardrail-policies', guardrailPoliciesRouter);
+app.use('/api/projects/:projectId/pii-entities', piiEntitiesRouter);
```

**Response shape**:

```json
{
  "success": true,
  "data": {
    "entities": [
      {
        "id": "US_SSN",
        "label": "US Social Security Number",
        "pack": "us",
        "category": "government_id"
      },
      {
        "id": "CREDIT_CARD",
        "label": "Credit Card Number",
        "pack": "financial",
        "category": "financial"
      }
    ]
  }
}
```

**Express ordering**: route is mounted at a unique prefix, no collision with `:projectId` parameterized routes elsewhere.

### 5.8 Block emission — `presetKey` extension

**Critical correction (R3-F2)**: The HLD's claim that "the evaluator's outcome type already passes the source guardrail reference through" is **false**. Both `GuardrailViolation` (at `packages/compiler/src/platform/guardrails/types.ts:27-49`) and `OutputGuardrailResult.violation` (at `apps/runtime/src/services/execution/output-guardrails.ts:27-38, :97-101`) strip down to `{ guardrailName, action, message }` — `presetKey` does **not** survive the projection without explicit propagation. Four additional code-site changes are required.

#### 5.8a — `GuardrailViolation` type extension

**File**: `packages/compiler/src/platform/guardrails/types.ts:27-49`

```diff
 export interface GuardrailViolation {
   name: string;                       // (NOT `guardrailName` — the actual field is `name`)
   action: GuardrailActionType;        // (NOT `GuardrailAction` — the action TYPE; `resolvedAction?` carries the full action object)
   resolvedAction?: GuardrailAction;
   message?: string;
   // … existing fields …
+  /** Forwarded from `Guardrail.presetKey` for trace-event correlation. */
+  presetKey?: string;
 }
```

**R8-F1 clarification**: the surrounding field names above are documented from `packages/compiler/src/platform/guardrails/types.ts:27-49`. Implementers MUST read the source per CLAUDE.md "Read Before You Write" — the `presetKey` addition is the only change introduced by this LLD; other fields are shown for diff context only.

#### 5.8b — `tier2-evaluator.ts` violation construction

**File**: `packages/compiler/src/platform/guardrails/tier2-evaluator.ts:136-152` (violation construction within the evaluator)

```diff
 const violation: GuardrailViolation = {
   guardrailName: guardrail.name,
   action: guardrail.action,
   message: ...,
+  presetKey: guardrail.presetKey,
 };
```

This is the **single source of truth** for `presetKey` on a violation — the IR's `Guardrail.presetKey` (added in §4.4) is read once and propagated into every downstream consumer.

#### 5.8c — `OutputGuardrailResult.violation` shape extension

**File**: `apps/runtime/src/services/execution/output-guardrails.ts:27-38` (type) and `:97-101` (projection)

```diff
 export interface OutputGuardrailResult {
   blocked: boolean;
   violation?: {
     guardrailName: string;
     action: GuardrailAction;
     message?: string;
+    presetKey?: string;
   };
 }

 // …projection at :97-101:
 return {
   blocked: true,
   violation: {
     guardrailName: primary.guardrailName,
     action: primary.action,
     message: primary.message,
+    presetKey: primary.presetKey,
   },
 };
```

#### 5.8d — Executor trace event emission

**File**: `apps/runtime/src/services/execution/reasoning-executor.ts:1904` (input block) and `:3485` (output block).

```diff
 // Input block site (L1904 area):
 emitTraceEvent('guardrail_input_blocked', {
   sessionId,
   tenantId,
   projectId,
   guardrailName: primary.guardrailName,
   message: primary.message,
+  presetKey: primary.presetKey,
 });
```

```diff
 // Output block site (L3485 area):
 emitTraceEvent('guardrail_output_blocked', {
   sessionId,
   tenantId,
   projectId,
   guardrailName: guardrailResult.violation.guardrailName,
   message: guardrailResult.violation.message,
+  presetKey: guardrailResult.violation.presetKey,
 });
```

**Sanitization survival** (R7-F4): the `message` field in the emitted trace event is the **sanitized** `actionMessage` — `validateRule()` (T-SH-1) strips HTML / null bytes / > 500 chars **at persistence time**, so the value flowing through `Guardrail.action.message` → `GuardrailViolation.message` → `OutputGuardrailResult.violation.message` → trace event `data.message` is always already-sanitized. **INT-6 (telemetry leak)** MUST assert that `<script>` tags in the original admin-supplied `actionMessage` do NOT appear in the emitted trace event payload — this is the contract that the persistence-time sanitization extends to telemetry. There is no separate sanitization step at trace emission; the chain depends on T-SH-1 being correct.

**Field-propagation lint** (`field-propagation-lint.sh`) will flag the 4 cross-boundary changes (`GuardrailViolation`, `OutputGuardrailResult.violation`, input trace, output trace) as expected. The lint is satisfied by:

- Schema: §4.1 adds `presetKey` to `IGuardrailRule`.
- Resolver: §4.3 + §5.1 propagate to `PolicyRule` → `Guardrail`.
- Violation: §5.8a + §5.8b propagate `Guardrail.presetKey` → `GuardrailViolation.presetKey`.
- Output projection: §5.8c propagates through `OutputGuardrailResult.violation`.
- Trace event: §5.8d emits at both block sites.
- Round-trip test: `INT-7` (trace event shape) covers all six hops — must be expanded to assert `presetKey` survives the full chain end-to-end.

---

## 6. Task Decomposition

Tasks are ordered for additive landing. Each task is a single PR-sized commit unless noted. Acceptance criteria reference test IDs from the test spec.

### T-DB — Database layer (Track A: foundations)

| ID         | Subject                                                                                                                                                                                                                                              | Files                                                                                    | Acceptance                                                                                                                                                | Tests                                                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **T-DB-1** | Add `entities`, `enabled`, `presetKey`, `actionMessage` to `IGuardrailRule` + schema                                                                                                                                                                 | `packages/database/src/models/guardrail-policy.model.ts:35-50, :139-165`                 | TypeScript builds; existing rules unchanged in serialization; legacy rules without new fields hydrate as enabled (since `enabled` default is `undefined`) | E2E-8 (schema-additive backward compat), E2E-1 (end-to-end SSN with new fields), INT-1 (round-trip via validateRule) |
| **T-DB-2** | Flip `failMode` default `'closed'` → `'open'` at **3 sites**: schema (`guardrail-policy.model.ts:194`), route normalizer (`guardrail-policies.ts:206`), route constant (`guardrail-policies.ts:141`). Audit test fixtures for hard-coded `'closed'`. | `guardrail-policy.model.ts:194` + `guardrail-policies.ts:141, :206` + grep test fixtures | All 3 sites flipped; all test fixtures updated; INT-10 asserts new default via PUT body that **omits** `failMode` (proves normalizer no longer overrides) | INT-10, UT                                                                                                           |
| **T-DB-3** | Add `rules.enabled` Mongoose path validation: must be boolean if present                                                                                                                                                                             | Inline in `GuardrailRuleSchema`                                                          | Invalid types rejected at save()                                                                                                                          | UT-1 group E (boundary types, cases E1-E10)                                                                          |

### T-RT — Runtime layer (Track B: resolver + routes)

| ID         | Subject                                                                                                                                                                                                                                                                                                                                                                                                                                 | Files                                                                                        | Acceptance                                                                                                                            | Tests                                                                       |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **T-RT-1** | Add new fields to `PolicyRule`; propagate `entities` + `presetKey` in `toSyntheticGuardrail()`; precedence chain `actionMessage` → `message` → fallback                                                                                                                                                                                                                                                                                 | `policy-resolver.ts:11-27, :126-152`                                                         | Resolver IR reflects new fields end-to-end                                                                                            | UT (synthetic guardrail mapping), INT-1                                     |
| **T-RT-2** | Skip `enabled: false` rules in resolver iteration                                                                                                                                                                                                                                                                                                                                                                                       | `policy-resolver.ts` (rule iteration block)                                                  | Disabled rules never reach pipeline                                                                                                   | INT-1, INT-3                                                                |
| **T-RT-3** | Activation gate — refuse activate with zero enabled rules; emit `guardrail_activation_blocked` via `writeAuditLog`. **Also extracts** `requireRouteScopePermission`, `getRouteScopeContext`, `buildScopedPolicyFilter` to new `apps/runtime/src/routes/guardrail-helpers.ts` (needed by T-API-1 — `pii-entities` cannot import file-local helpers).                                                                                     | `guardrail-policies.ts:1339-1398` + new `guardrail-helpers.ts`                               | 400 NO_ENABLED_RULES; audit log entry; helpers exported and re-imported in `guardrail-policies.ts` (no behavior change for that file) | E2E-3, INT-5                                                                |
| **T-RT-4** | Auto-deactivation in PUT — atomic findOneAndUpdate with `autoDeactivated: true` in response                                                                                                                                                                                                                                                                                                                                             | `guardrail-policies.ts:1132`                                                                 | Race-safe (INT-4 passes); response carries flag                                                                                       | E2E-4, INT-4                                                                |
| **T-RT-5** | `POST /:id/reactivate` route with atomic `$.` positional rule re-enable. **MUST also call** `deactivateSiblingPolicies()`, `bumpAffectedPolicyEpochs()`, `invalidateGuardrailEvalCache()`, `invalidateTenantProviderCache()` (R2-F1) to preserve single-active-policy invariant and avoid stale runtime cache.                                                                                                                          | `guardrail-policies.ts` insert after L1395                                                   | Single-call atomic undo; permission gated; sibling policies deactivated; eval cache flushed; audit log records `undone: true`         | E2E-4, INT-13 (R2-F1 — sibling-deactivation), INT-6 (telemetry tag cutover) |
| **T-RT-6** | Propagate `presetKey` through the **full violation chain** (R3-F2): (a) `GuardrailViolation.presetKey` in `packages/compiler/src/platform/guardrails/types.ts:27-49`; (b) tier2-evaluator violation construction at `tier2-evaluator.ts:136-152`; (c) `OutputGuardrailResult.violation.presetKey` at `output-guardrails.ts:27-38, :97-101`; (d) executor trace events at `reasoning-executor.ts:1904, :3485`. Four code sites, not one. | 4 files (compiler/types.ts, tier2-evaluator.ts, output-guardrails.ts, reasoning-executor.ts) | `presetKey` survives full IR → violation → output projection → trace event chain; INT-7 asserts the round-trip end-to-end             | INT-7 (expanded), E2E-2, E2E-6                                              |

### T-PII — Provider + recognizer layer (Track C: detection filter)

| ID          | Subject                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Files                                                                                                                        | Acceptance                                                                                                                                                                                                                                                              | Tests                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **T-PII-1** | Add post-detection filter to `BuiltinPIIProvider.evaluate()` reading from `request.context.allowedEntityTypes` (NOT from `request.guardrail.entities`)                                                                                                                                                                                                                                                                                                                                                                                                                                               | `packages/compiler/src/platform/guardrails/providers/builtin-pii.ts:23-42`                                                   | Filter uses strict `Set.has` (constructed once per evaluation from `context.allowedEntityTypes`); absent/empty `allowedEntityTypes` = pass-through; filter operates on `result.detections.filter(d => allowSet.has(d.type))` — uses `d.type` not `d.entityType` (R3-F1) | UT (9-case matrix incl. INT-2 case 9 allowlist-no-match), INT-2 |
| **T-PII-2** | Add `entities` to `Guardrail` IR interface                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `packages/compiler/src/platform/ir/schema.ts:1603-1637`                                                                      | IR carries field through; downstream consumers unaffected                                                                                                                                                                                                               | UT IR, INT-1                                                    |
| **T-PII-3** | Forward `allowedEntityTypes` from request construction in `tier2-evaluator.ts:172-179`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `packages/compiler/src/platform/guardrails/tier2-evaluator.ts:172-179`                                                       | Provider receives entity list                                                                                                                                                                                                                                           | INT-2, E2E-1                                                    |
| **T-PII-4** | Extract entity metadata from each recognizer pack (8 packs) into exported `ENTITIES` constants; aggregate in new `catalog.ts`; add `listEnabledPIIEntities()`. **Refactoring scope** (R3-F6): each pack file currently hardcodes entity names inside `register()` closure literals. T-PII-4 extracts those names into top-level `export const ENTITIES = [...]` arrays without changing recognizer behavior. **Re-export chain** (R3-F4): `listEnabledPIIEntities` must be re-exported from `packages/compiler/src/platform/security/index.ts` AND verified to resolve via `@abl/compiler/platform`. | `packages/compiler/src/platform/security/recognizer-packs/*.ts` (8 files) + new `catalog.ts` + `security/index.ts` re-export | All 8 packs export typed `ENTITIES` list with stable IDs; aggregator exposes `listEnabledPIIEntities()`; import path `@abl/compiler/platform` resolves it; no behavior change to recognizers                                                                            | UT (per-pack snapshot), CT-1, INT-8                             |

### T-API — New endpoint (Track D)

| ID          | Subject                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Files                                                                                                                                             | Acceptance                                                                                                                                                                                       | Tests                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| **T-API-1** | `GET /api/projects/:projectId/pii-entities` route + service. **Explicit deliverables (R3-F5)**: (a) new file `apps/runtime/src/routes/pii-entities.ts`; (b) new file `apps/runtime/src/services/pii/project-pii-config.ts` exporting `getProjectPIIConfig({ tenantId, projectId })` that reads `project_runtime_configs` (indexed by `{tenantId:1, projectId:1}`) **with an in-process LRU cache** (max 500 entries, 60s TTL, key `${tenantId}:${projectId}`) — modeled on the `tenantProviderLoadCache` pattern at `pipeline-factory.ts`. Invalidate on `project_runtime_configs` write. **R6-F1 reason**: Studio's SWR calls this endpoint on page load and every entity multi-select interaction; uncached DB round-trips would dominate the response time budget. (c) mount at `server.ts:1250` between guardrail-policies (L1249) and pii-patterns mounts. | new `apps/runtime/src/routes/pii-entities.ts`, new `apps/runtime/src/services/pii/project-pii-config.ts` (with LRU cache), `server.ts:1250` mount | Both files created; LRU cache in place with TTL + invalidation; route returns enabled entities for project; `pii-pattern:read` enforced via extracted `guardrail-helpers.ts` (depends on T-RT-3) | E2E-5, E2E-7, INT-3 (cache invalidation), INT-5, INT-8 |

### T-UI — Studio surface (Track E)

| ID         | Subject                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Files                                                                                                     | Acceptance                                                                                                                                                                                                       | Tests                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **T-UI-1** | New "Sensitive Data Block" preset card in policy editor; pre-fills SSN-only default. **Includes serializer behavioral change**: `serializeRule()` at `GuardrailPolicyForm.tsx:459-462` currently returns `[]` for `enabled: false` rules (excluded from payload). For SDB-preset rules, the serializer must instead emit `{ ..., enabled: false }` — disabled rules MUST persist so auto-deactivation can track them. Add a `presetKey === 'sensitive_data_block'` branch that bypasses the early-return and emits the disabled rule. | `apps/studio/src/components/guardrails/GuardrailPolicyForm.tsx` (preset block + `serializeRule` L459-462) | Preset visible; selection populates `presetKey`, `entities`, `kind: 'both'`, `action.type: 'block'`, `actionMessage`. Disabled SDB rules round-trip through serialize/normalize with `enabled: false` preserved. | CT-1, CT-1b, CT-1c (new — disabled-rule round-trip) |
| **T-UI-2** | Entity multi-select fetches from `GET /pii-entities`; UI groups by pack/category                                                                                                                                                                                                                                                                                                                                                                                                                                                      | same file                                                                                                 | Selector renders; min 1 entity required for activation                                                                                                                                                           | CT-2, CT-3                                          |
| **T-UI-3** | Auto-deactivation modal on activate response carrying `autoDeactivated: true`; 5s undo toast with hard-coded TTL                                                                                                                                                                                                                                                                                                                                                                                                                      | same file + toast component                                                                               | Modal opens; undo calls `POST /:id/reactivate`; toast auto-dismisses at 5s                                                                                                                                       | CT-4, CT-5, E2E-10                                  |
| **T-UI-4** | `failMode: 'open'` voice-channel warning banner; compliance copy from copy-deck                                                                                                                                                                                                                                                                                                                                                                                                                                                       | same file                                                                                                 | Banner renders only when `kind` includes `output`/`tool_output` AND `failMode: 'open'`                                                                                                                           | CT-6                                                |

### T-SH — Shared validation (Track F)

| ID         | Subject                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Files                                                                                    | Acceptance                                                                                                                                                                                                                                                                                                                           | Tests                                                                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T-SH-1** | `validateRule()` in `packages/shared/src/validation/guardrail-rule-validation.ts`; used by both Studio + Runtime. **`actionMessage` sanitization (HLD §4 concern #4)**: reject null bytes (`/\x00/`), reject length > 500 chars, strip HTML tags. **Dependency (R7-F1)**: add `sanitize-html` (MIT, pure Node, no DOM required) to `packages/shared/package.json` dependencies. Use `import sanitize from 'sanitize-html'; sanitize(msg, { allowedTags: [], allowedAttributes: {} })`. **Do NOT use** `isomorphic-dompurify` — it requires `jsdom` server-side and is not the project's standard. `entities` array bounds: 1 ≤ length ≤ 37 (current catalog max); each entry must match a known entity ID from the catalog. | new file, modeled on `pii-pack-names.ts` + `packages/shared/package.json` dependency add | Pure function; accepts Studio-form vocabulary; runtime maps via `normalizeRules()` before calling. Sanitization runs **inside** `validateRule()` and returns the sanitized value (callers never see raw input). The persisted `actionMessage` is the sanitized output — see §5.8d note about trace events emitting sanitized values. | UT-1 (5 `test.each` groups A-E), UT-1f (new: actionMessage sanitization 6-case matrix — null byte, > 500 chars, `<script>`, plain text, empty, undefined), INT-9 |
| **T-SH-2** | `normalizeRules()` enhancement — map Mongoose-vocab to validation-vocab before calling `validateRule()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `guardrail-policies.ts:515-563`                                                          | Round-trip identity; new fields preserved                                                                                                                                                                                                                                                                                            | INT-9                                                                                                                                                            |

### T-TR — Trace event registry (Track G)

| ID         | Subject                                                                                                                                                                                                             | Files                                                                                                             | Acceptance                                                                      | Tests                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------- |
| **T-TR-1** | Add `guardrail_activation_blocked` + `guardrail_auto_deactivation` to `GUARDRAIL_TRACE_EVENT_TYPES`. Update `packages/shared-kernel/src/__tests__/trace-event-contract.test.ts` snapshot to include the new events. | `packages/shared-kernel/src/constants/trace-event-registry.ts:167-188` + `__tests__/trace-event-contract.test.ts` | Registry size 20 → 22; typed; contract test snapshot updated; consumers compile | UT (registry coverage), INT-7 |

### T-CL — Cleanup script (Track H)

| ID         | Subject                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Files                                                 | Acceptance                                                                                                                                   | Tests                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **T-CL-1** | 90-day TTL job: archive `guardrail_input_blocked` + `guardrail_output_blocked` trace events with `presetKey: 'sensitive_data_block'`. **Backing store (R6-F2)**: targets the **ClickHouse** `trace_events` table (partitioned by `toYYYYMM(timestamp)`), NOT the in-process ring-buffer `TraceStore` (which expires by `maxAgeMinutes`). Query: `ALTER TABLE trace_events DELETE WHERE type IN ('guardrail_input_blocked','guardrail_output_blocked') AND data.presetKey = 'sensitive_data_block' AND timestamp < now() - INTERVAL 90 DAY`. Include `--store` flag defaulting to `clickhouse`; no-op with warning if ClickHouse unavailable (local dev). | new `tools/cleanup-guardrail-traces.ts` + cron config | Targets ClickHouse persistent store; idempotent; respects tenant boundaries (per-tenant partition scoping); dry-run mode default in non-prod | CL-1 through CL-4 (require ClickHouse test infra OR mock adapter — note in §11 Test Infrastructure) |

### Task ordering & parallelism

Tracks A, C, F, G can land in parallel after T-DB-1. Track B depends on T-RT-1 internally (T-SH-2 follows T-RT-1 because both touch `guardrail-policies.ts`). Tracks D, E, H depend on Track B + Track C completing. Recommended sequence:

```
T-DB-1 → [T-PII-1, T-PII-2, T-PII-3, T-PII-4, T-TR-1, T-SH-1] (parallel)
       → [T-RT-1] (precedes other RT tasks; touches policy-resolver.ts)
       → [T-RT-3] (extracts guardrail-helpers.ts; precedes T-RT-4, T-RT-5, T-API-1)
       → [T-DB-2, T-DB-3, T-RT-2, T-RT-4, T-RT-5, T-RT-6, T-SH-2] (sequential within guardrail-policies.ts edits to avoid merge churn)
       → [T-API-1] (depends on T-PII-4 + T-RT-3)
       → [T-UI-1, T-UI-2, T-UI-3, T-UI-4] (depend on T-API-1 + T-RT-3/4/5)
       → [T-CL-1] (last)
```

**File-collision matrix** (informs ordering):

| File                        | Tasks                                               |
| --------------------------- | --------------------------------------------------- |
| `guardrail-policy.model.ts` | T-DB-1, T-DB-2, T-DB-3 — sequential                 |
| `guardrail-policies.ts`     | T-RT-3, T-RT-4, T-RT-5, T-SH-2, T-DB-2 — sequential |
| `policy-resolver.ts`        | T-RT-1, T-RT-2 — sequential                         |
| `GuardrailPolicyForm.tsx`   | T-UI-1, T-UI-2, T-UI-3, T-UI-4 — sequential         |

Each track's tasks ship as separate commits to honor the 40-file / 3-package commit-scope guard.

---

## 7. Test Mapping

**Rebuilt R4 against canonical test spec IDs** (R4-F1 fix). Every row uses the test spec's exact section header text; every task in §6 has ≥ 1 test ID; every test ID maps to ≥ 1 task.

### 7.1 Canonical 45-row coverage matrix (test spec → LLD tasks)

**E2E scenarios** (14 executable + 1 cross-ref):

| Test ID | Test spec title (canonical)                                | LLD task(s)                               |
| ------- | ---------------------------------------------------------- | ----------------------------------------- |
| E2E-1   | Compliance lead blocks SSN-only messages (Journey E)       | T-DB-1, T-RT-1, T-PII-1, T-PII-2, T-PII-3 |
| E2E-2   | Empty policy activation rejection (FR-7.3)                 | T-RT-3                                    |
| E2E-3   | Incomplete rule rejection (FR-8.4)                         | T-SH-1, T-SH-2                            |
| E2E-4   | Auto-deactivation on last rule disable + Undo (FR-7.4)     | T-RT-4, T-RT-5                            |
| E2E-5   | Entity catalog endpoint filters by enabled packs (FR-10.1) | T-API-1, T-PII-4                          |
| E2E-6   | Cross-project entity catalog isolation (FR-10.3)           | T-API-1                                   |
| E2E-7   | failMode opt-in fail-closed behavior (FR-5.4, FR-6.7)      | T-DB-2, T-PII-1                           |
| E2E-8   | Schema-additive backward compatibility (FR-5.3)            | T-DB-1                                    |
| E2E-9   | Tenant-scoped policy inheritance with SDB                  | T-RT-3, T-RT-4                            |
| E2E-10  | Studio Create Policy via UI (Playwright EP-1)              | T-UI-1, T-UI-2, T-UI-3, T-UI-4            |
| E2E-11  | Direct API bypass — invalid rule enable (T4 threat)        | T-SH-1, T-RT-3                            |
| E2E-12  | Direct API bypass — XSS in actionMessage (T3 threat)       | T-SH-1                                    |
| E2E-13  | Auto-deactivation race (T6) — **cross-reference → INT-4**  | T-RT-4                                    |
| E2E-14  | Telemetry tag rename (FR-4.1)                              | T-RT-6, T-TR-1                            |
| E2E-15  | Catalog rate-limit middleware integration (T8 threat)      | T-API-1                                   |

**Integration scenarios** (11):

| Test ID | Test spec title (canonical)                                                                  | LLD task(s)                     |
| ------- | -------------------------------------------------------------------------------------------- | ------------------------------- |
| INT-1   | Route handler uses shared `validateRule()` (FR-8.2 symmetry)                                 | T-SH-1, T-SH-2                  |
| INT-2   | Post-detection entity filter (FR-6.4) — **8-case matrix incl. allowlist-no-match** (R3-F1)   | T-PII-1, T-PII-3                |
| INT-3   | Entity catalog pack-enable state cache invalidation                                          | T-API-1, T-PII-4                |
| INT-4   | Auto-deactivation race condition (T6, FR-7.4)                                                | T-RT-4                          |
| INT-5   | Entity catalog reads from recognizer registry (FR-10.1)                                      | T-API-1, T-PII-4                |
| INT-6   | Telemetry tag clean cutover (FR-4.1) — **expanded: `presetKey` survives full chain** (R3-F2) | T-RT-6, T-TR-1                  |
| INT-7   | Activation gate trace events (FR-7.5)                                                        | T-RT-3, T-TR-1                  |
| INT-8   | Cross-tenant policy isolation (Core Invariant 1)                                             | T-RT-3, T-RT-4, T-RT-5, T-API-1 |
| INT-9   | Action message HTML strip + length + null-byte rejection (FR-6.9)                            | T-SH-1                          |
| INT-10  | `failMode` schema default flip (FR-5.4) — **PUT with omitted `failMode` field** (R2-F4)      | T-DB-2                          |
| INT-11  | SDB-specific RBAC matrix (Section 7)                                                         | T-RT-3, T-RT-4, T-RT-5, T-API-1 |

**Unit tests** (5):

| Test ID | Test spec title (canonical)                                     | LLD task(s)    |
| ------- | --------------------------------------------------------------- | -------------- |
| UT-1    | `validateRule()` per-checkType matrix (~35 cases, 5 groups A-E) | T-SH-1, T-DB-3 |
| UT-2    | `validateRule()` is exported from `packages/shared`             | T-SH-1         |
| UT-3    | 90-day TTL banner logic (FR-2.3)                                | T-UI-3         |
| UT-4    | SSN-only default entity preset (FR-6.2)                         | T-UI-1         |
| UT-5    | Default action message copy (FR-6.6)                            | T-UI-1         |

**Component tests** (10):

| Test ID | Test spec title (canonical)                                           | LLD task(s) |
| ------- | --------------------------------------------------------------------- | ----------- |
| CT-1    | `EntityMultiselect` — quick-preset radio behavior (FR-6.1-6.3)        | T-UI-2      |
| CT-1b   | `GuardrailPolicyForm` — `kind: 'both'` expands to two rules on save   | T-UI-1      |
| CT-2    | `EntityMultiselect` — pack-disabled entity warning (FR-10.4)          | T-UI-2      |
| CT-3    | `DecisionMatrixModal` — WCAG APG dialog pattern (FR-3.3)              | T-UI-3      |
| CT-4    | `DecisionMatrixModal` — first-run auto-open via localStorage (FR-3.1) | T-UI-3      |
| CT-5    | `FailModeSelector` (FR-6.7)                                           | T-UI-4      |
| CT-6    | `RuleCard` — enable toggle disabled when rule incomplete (FR-8.3)     | T-UI-1      |
| CT-7    | `GuardrailsConfigPage` — policy list chips (FR-9.1–9.6)               | T-UI-4      |
| CT-8    | `PIIProtectionTab` — cross-link banner (FR-2.1, FR-2.3)               | T-UI-4      |
| CT-9    | `EntityMultiselect` — catalog endpoint failure (FR-10.4)              | T-UI-2      |

**Cleanup-script tests** (4):

| Test ID | Test spec title (canonical) | LLD task(s) |
| ------- | --------------------------- | ----------- |
| CL-1    | Dry-run mode                | T-CL-1      |
| CL-2    | Confirmed run               | T-CL-1      |
| CL-3    | Idempotency                 | T-CL-1      |
| CL-4    | Safety guard                | T-CL-1      |

### 7.2 Addendum — tests introduced by R1-R3 (require test-spec backfill in R5)

| Test ID    | Origin | Description                                                                                                                                         | LLD task | Test spec backfill required?                    |
| ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------- |
| **CT-1c**  | R1-F7  | Serializer round-trip with `enabled: false` for SDB-preset rules (proves disabled rules persist, are not filtered to `[]`)                          | T-UI-1   | YES — add to test spec §5 alongside CT-1, CT-1b |
| **INT-12** | R1-F9  | PUT lifecycle precedence: `status: 'active'` body + all `enabled: false` rules → auto-deactivation wins over lifecycleUpdate spread                 | T-RT-4   | YES — add to test spec §3 alongside INT-4       |
| **INT-13** | R2-F1  | Reactivate sibling-deactivation: create policy A, deactivate, activate policy B, reactivate A → assert B is now inactive AND eval cache invalidated | T-RT-5   | YES — new INT scenario; add to test spec §3     |
| **UT-1f**  | R2-F3  | `actionMessage` sanitization 6-case matrix (null byte, > 500 chars, `<script>`, plain text, empty, undefined)                                       | T-SH-1   | YES — add to test spec §4 UT-1 group            |

### 7.3 Forward coverage (task → tests)

Updates from R4 fixes:

| Task   | Test IDs                                     | Coverage gap closed? |
| ------ | -------------------------------------------- | -------------------- |
| T-DB-1 | E2E-1, E2E-8, INT-1 (schema round-trip path) | YES (R4-F3)          |
| T-DB-3 | UT-1 group E (boundary types)                | YES (R4-F3)          |

All other tasks already had formal test IDs in §6; R4-F1's fix above also corrects the task mappings.

### 7.4 Summary

- **45 canonical test IDs** in the test spec, all mapped to ≥ 1 LLD task.
- **4 R1-R3 addendum tests** (CT-1c, INT-12, INT-13, UT-1f) introduced by audit findings; test-spec backfill scheduled for R5 cross-phase consistency round.
- **No orphan tests.** No tasks without formal test ID coverage.

---

## 8. Risks & Mitigations

| ID       | Risk                                                                                                                                                                                                                                                | Likelihood                            | Impact           | Mitigation                                                                                                                                                                                     | Validation                                                                                |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **R-1**  | Entity filter false negative (silent compliance violation)                                                                                                                                                                                          | Low                                   | **Catastrophic** | Strict `Array.includes` on canonical `entityType`; reject `startsWith`/case-folding in code review                                                                                             | INT-2's 8-case matrix; semgrep rule (post-impl)                                           |
| **R-2**  | Auto-deactivation race                                                                                                                                                                                                                              | Low                                   | High             | Single-doc `findOneAndUpdate`; no read-modify-write                                                                                                                                            | INT-4 `Promise.all` race test                                                             |
| **R-3**  | `failMode` default flip breaks test fixtures                                                                                                                                                                                                        | Medium                                | Low              | T-DB-2 grep + same-commit fixture updates; pre-launch posture means no prod records                                                                                                            | INT-10 + full test suite pass                                                             |
| **R-4**  | 4-hop reachability missing one hop                                                                                                                                                                                                                  | Medium                                | High             | LLD §5.1-5.3 + field-propagation lint; INT-1 + INT-2 cover all hops                                                                                                                            | `field-propagation-lint.sh` + E2E-1 step 4                                                |
| **R-5**  | Field-propagation lint blocks merge (expected behavior)                                                                                                                                                                                             | High (will trigger)                   | Low (intended)   | Co-locate schema + resolver + provider + trace + test changes in same PR series; reference R-5 in PR description                                                                               | Lint passes when all 5 changes present                                                    |
| **R-6**  | `actionMessage` vs `action.message` precedence inverted in some code path                                                                                                                                                                           | Low                                   | Medium           | Single precedence chain encoded in `toSyntheticGuardrail()` (§5.1) — only one site reads it                                                                                                    | UT (synthetic guardrail mapping)                                                          |
| **R-7**  | Tenant route mount accepts unintended scope type                                                                                                                                                                                                    | Low                                   | High             | `buildScope()` at L340-347 explicitly rejects non-tenant scope on top-level mount                                                                                                              | E2E-9 + RBAC suite                                                                        |
| **R-8**  | Faulty recognizer crashes evaluator                                                                                                                                                                                                                 | Medium                                | Medium           | `BuiltinPIIProvider.evaluate()` already wraps `detectPII` in try/catch (verified at impl); INT-3 covers graceful path                                                                          | INT-3 + E2E-12                                                                            |
| **R-9**  | Cleanup script over-deletes (cross-tenant)                                                                                                                                                                                                          | Low                                   | High             | Tenant-scoped query; dry-run mode default in non-prod                                                                                                                                          | CL-1 through CL-4; staging dry-run before prod cron enabled                               |
| **R-10** | Tenant-scoped reactivate fan-out via `bumpAffectedPolicyEpochs` (R6-F3) — for tenant-scoped policies, function does `Project.find({tenantId})` then `Promise.all(...)` per project. A tenant with 200 projects triggers 200 sequential epoch bumps. | Low (pre-launch, small tenant counts) | Medium           | Existing pattern; not introduced by this feature but reactivate adds another call site. Post-launch, recommend project-scoped policies (the SDB default) over tenant-scoped for large tenants. | Manual smoke test with N=50 projects before tenant-scope GA; tracked as post-v1 follow-up |

---

## 9. External Dependencies (Outside LLD Scope)

These are documented in HLD §9 and remain unresolved at LLD-write time:

1. **Compliance sign-off on `failMode: 'open'`** for voice / 911-adjacent channels (FR-6.7). Blocks code commit on T-DB-2. **Owner**: compliance team. **ETA**: pending.
2. **Audit-logging beyond trace events** (GAP-002). Post-v1. **Owner**: platform. **ETA**: deferred to ABLP-9xx (TBD).
3. **Future third-party PII provider UI** (Presidio / Comprehend Medical). Post-v1. Not gated by this feature.
4. **`guardrail:activate` permission split** (HLD §4 concern #4). Future PR; runbook captured.

---

## 10. Implementation Sequencing (Recommended Branch Plan)

For the `discuss/guardrails-pii-consolidation` branch, recommended commit series (each commit ≤ 40 files, ≤ 3 packages, additive):

1. `[ABLP-723] feat(database): add Sensitive Data Block fields to IGuardrailRule + failMode default flip` — T-DB-1, T-DB-2, T-DB-3
2. `[ABLP-723] feat(shared-kernel): register guardrail activation + auto-deactivation trace event types` — T-TR-1
3. `[ABLP-723] feat(compiler): add entities filter to BuiltinPIIProvider + IR plumbing` — T-PII-1, T-PII-2, T-PII-3, T-PII-4
4. `[ABLP-723] feat(shared): add guardrail-rule-validation shared module` — T-SH-1
5. `[ABLP-723] feat(runtime): propagate entities + presetKey + actionMessage through policy resolver` — T-RT-1, T-RT-2, T-SH-2
6. `[ABLP-723] feat(runtime): activation gate + auto-deactivation + reactivate route` — T-RT-3, T-RT-4, T-RT-5
7. `[ABLP-723] feat(runtime): emit presetKey on guardrail block trace events` — T-RT-6
8. `[ABLP-723] feat(runtime): GET /api/projects/:projectId/pii-entities` — T-API-1
9. `[ABLP-723] feat(studio): Sensitive Data Block preset UI + entity selector + undo flow` — T-UI-1, T-UI-2, T-UI-3, T-UI-4
10. `[ABLP-723] feat(tools): cleanup-guardrail-traces 90-day TTL job` — T-CL-1
    11a. `[ABLP-723] test(...): unit + integration coverage for ABLP-723` — unit and integration test suites
    11b. `[ABLP-723] test(...): e2e coverage for ABLP-723` — e2e test suites (split from 11 to respect 40-file commit-scope guard)

Each commit:

- Builds clean (`pnpm build --filter=<package>`)
- Has tests passing
- Includes `prettier --write` of all changed files
- References ABLP-723 in commit message
- Reports SHA back to Jira via `pnpm jira:update`

---

## 11. Acceptance Criteria for "LLD Done"

The LLD is implementer-ready when:

- [x] All 5 LLD-scoped open questions resolved (§3 — done).
- [x] All schema diffs precise with file:line citations (§4).
- [x] Every behavior diff has before/after with line numbers (§5).
- [x] Every test ID maps to ≥ 1 task; no orphan tests (§7).
- [x] Every task has acceptance criteria.
- [x] Risks include validation steps.
- [x] Implementation sequence respects commit-scope guards (§10).
- [x] 8 audit rounds passed (implementation landed).

---

## 12. Phase Handoff (to Phase 5: Implementation)

**Status**: DONE — implementation complete (2026-05-18).

Implementation landed as a 12-commit series. Test commit #11 was split into 11a (unit+integration) and 11b (e2e) to respect the 40-file commit-scope guard. All other commits followed the §10 plan as designed. ~215 assertions across ~20 test files. 8 `it.todo` markers remain for deferred JIRA sub-tasks; feature status is ALPHA pending their resolution.

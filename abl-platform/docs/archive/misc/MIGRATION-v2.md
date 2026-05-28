# Migration Guide: develop → main

This document covers the 4 breaking changes in the `develop` branch that require action before upgrading.

---

## 1. Filesystem DSL Loading Removed — Database-Only Agent Resolution

**Commit:** `17fee08`
**Priority:** HIGH — requires data migration

### What Changed

All agent loading now happens via Prisma queries against the `ProjectAgent` table. The `AgentLoader` service that scanned `.agent.abl` files from the filesystem has been deleted from both the runtime and studio.

**Removed:**

- `apps/runtime/src/services/agent-loader.ts`
- `apps/studio/src/services/agent-loader.ts`
- `POST /api/abl/save` (filesystem write route)
- `EXAMPLES_DIR` environment variable support

**Required:**

- Database must be available before starting the runtime
- All agents must exist as `ProjectAgent` records with `dslContent` populated

### Migration Steps

1. **Seed agents into the database:**

   ```sql
   INSERT INTO ProjectAgent (id, projectId, name, domain, dslContent, agentPath)
   VALUES (
     'agent-uuid',
     'project-uuid',
     'Booking_Agent',
     'travel',
     '... full DSL content ...',
     'travel/Booking_Agent'
   );
   ```

2. **For supervisors:** ensure all child agents are in the same `projectId`. The runtime will warn if a supervisor references agents not found in the database.

3. **Update agent creation workflows:** use Studio UI or `POST /api/projects/:projectId/agents` instead of writing files to disk.

4. **Remove `EXAMPLES_DIR`** from any environment configuration.

---

## 2. Completion Tool Removed from LLM — Runtime-Evaluated

**Commit:** `964a9e2`
**Priority:** MEDIUM — DSL rewrites may be needed

### What Changed

The `__complete_conversation__` tool is no longer offered to LLMs in the tool list. Completion is now evaluated server-side after each reasoning turn by checking `COMPLETE` conditions against actual session state.

**Before:** LLMs could call `__complete_conversation__` to end a session, often based on semantic guesses about phantom variables (e.g., `handoff_successful`) that were never actually set.

**After:** The runtime evaluates `COMPLETE` conditions using `compilerEvaluateCondition()` against `session.data.values` after every turn. The tool handler is kept as a safety net but is not advertised to LLMs.

### What Breaks

- Agents relying on the LLM's judgment to call the completion tool will never self-complete
- Semantic conditions like `all_fields_gathered == true` won't work (the variable is never set in state)
- Cached tool schemas on the client side will have a stale `__complete_conversation__` entry

### Migration Steps

1. **Rewrite COMPLETE conditions to use actual state variables:**

   ```
   # Before (semantic — won't work):
   COMPLETE:
     - WHEN: all_fields_gathered == true

   # After (evaluable against real state):
   COMPLETE:
     - WHEN: destination IS SET AND checkin IS SET AND checkout IS SET
   ```

2. **Remove phantom variable references.** Only reference variables that are explicitly set via `GATHER`, `SET`, or tool return values.

3. **Verify completion behavior** by checking for `completion_check` trace events with `source: 'post_turn_eval'` in the observatory.

### New Trace Events

```json
{
  "type": "completion_check",
  "data": {
    "condition": "destination IS SET AND checkin IS SET",
    "result": true,
    "agent": "Booking_Agent",
    "source": "post_turn_eval"
  }
}
```

```json
{
  "type": "decision",
  "data": {
    "type": "auto_complete",
    "condition": "destination IS SET AND checkin IS SET",
    "stored": null,
    "agent": "Booking_Agent"
  }
}
```

---

## 3. Environment-Key Model Fallbacks Removed — DB-Backed Only

**Commit:** `89e3ec6`
**Priority:** HIGH — requires TenantModel setup

### What Changed

All LLM credentials now come from the database via `ModelResolutionService`. The silent fallback to environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) for session execution has been removed.

**Removed:**

- `createDirectSessionLLMClient()` function
- `DEFAULT_FALLBACK_MODEL` constant (replaced with `TRACE_MODEL_UNKNOWN` for trace metadata only)
- `directLLMConfig` fields on `SessionLLMClient`
- Silent env-key fallback path

### What Breaks

- Dev setups that only set `ANTHROPIC_API_KEY` in `.env` will get: `"LLM client not configured. Ensure a TenantModel with credentials is configured for this tenant."`
- Any code calling `createDirectSessionLLMClient()` will fail at import time
- Sessions without a configured `TenantModel` + `TenantModelConnection` will error

### Migration Steps

1. **Create a TenantModel for each LLM provider you use:**
   Use Studio UI: **Workspace Settings > LLM Providers > Add Model**

   Or via API:

   ```sql
   INSERT INTO TenantModel (id, tenantId, displayName, modelId, provider, tier, isDefault)
   VALUES ('tm-1', 'tenant-id', 'Claude Sonnet 4.5', 'claude-sonnet-4-5-20250929', 'anthropic', 'STANDARD', true);
   ```

2. **Create a TenantModelConnection with encrypted credentials:**

   ```sql
   INSERT INTO TenantModelConnection (id, tenantModelId, tenantId, encryptedApiKey, isActive)
   VALUES ('tmc-1', 'tm-1', 'tenant-id', '<encrypted-key>', true);
   ```

3. **Link projects to models via ProjectModelConfig** (or rely on the tenant default).

4. **Remove env-key dependencies** from session execution paths. Environment variables can still be used for platform-level operations (e.g., admin tools) but not for user sessions.

### Environment Variables Affected

| Variable            | Status                                                              |
| ------------------- | ------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | No longer used for session execution. Keep for platform admin only. |
| `OPENAI_API_KEY`    | Same — DB-backed only for sessions.                                 |
| `GEMINI_API_KEY`    | Same.                                                               |

---

## 4. Super Admin Scoped to Platform-Only

**Commit:** `4b501f1`
**Priority:** MEDIUM — permission model changes

### What Changed

The `isSuperAdmin` flag no longer bypasses tenant data isolation. Super-admins must be explicit members of a tenant to access its data. A new `requirePlatformAdmin()` guard restricts platform-configuration routes to super-admins.

**Before:** Super-admins could:

- Access any tenant's data (bypassed RLS)
- Skip all permission checks
- Skip project/environment scope checks
- See unmasked proxy URLs

**After:** Super-admins:

- Must be members of a tenant to access its data
- Must have explicit permissions within each tenant
- Cannot bypass project/environment scope
- See masked proxy URLs like everyone else
- Can still access platform-config routes via `requirePlatformAdmin()`

### What Breaks

- Super-admin accounts that accessed data across tenants without explicit membership
- Admin dashboards or scripts that relied on super-admin bypassing tenant isolation
- Seeded admin users (`superadmin@platform.internal`, etc.) are no longer added to tenants in the seed script
- Seeded model configs (`model-claude-sonnet`, etc.) are no longer created by the seed script

### Migration Steps

1. **Add super-admin users as tenant members** for each tenant they need to access:

   ```sql
   INSERT INTO TenantMember (id, tenantId, userId, role)
   VALUES ('mem-1', 'tenant-id', 'superadmin-user-id', 'OWNER');
   ```

2. **Update platform-only routes** to use `requirePlatformAdmin()` instead of checking `isSuperAdmin`:

   ```typescript
   // Before:
   if (req.user?.isSuperAdmin) { ... }

   // After:
   router.get('/api/platform/health', requirePlatformAdmin(), handler);
   ```

3. **Create model configs via Studio UI** — they are no longer seeded automatically.

4. **Update tests** that expect super-admin to bypass tenant isolation:

   ```typescript
   // Before:
   expect(superAdminCanAccessAnyTenant).toBe(true);

   // After — must be a tenant member:
   await prisma.tenantMember.create({
     data: { tenantId, userId: superAdminId, role: 'OWNER' },
   });
   ```

---

## Summary

| #   | Breaking Change                     | Priority | Action Required                               |
| --- | ----------------------------------- | -------- | --------------------------------------------- |
| 1   | Filesystem DSL loading removed      | HIGH     | Seed agents into DB                           |
| 2   | Completion tool removed from LLM    | MEDIUM   | Rewrite COMPLETE conditions to use real state |
| 3   | Env-key model fallbacks removed     | HIGH     | Create TenantModel + connections in DB        |
| 4   | Super admin scoped to platform-only | MEDIUM   | Add admin users as explicit tenant members    |

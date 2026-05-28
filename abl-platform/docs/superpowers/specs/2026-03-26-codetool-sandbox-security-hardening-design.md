# Codetool Sandbox Security Hardening & Tenant Feature Gate

**Date:** 2026-03-26
**Status:** Draft
**Scope:** Security vulnerability fix + tenant-level feature control

## Problem

### Security Vulnerability: JS Sandbox Escape Leading to RCE

The JavaScript sandbox runtime (`services/codetool-sandbox/runtime_js/utils.js`) uses `require.cache` poisoning to block `fs` and `child_process` modules. This approach is incomplete and can be bypassed through:

1. **`node:` prefix bypass:** `require('node:fs')` and `require('node:child_process')` resolve separately from the poisoned cache entries, granting full filesystem and shell access.
2. **`process.binding()` bypass:** `process.binding('fs')` exposes low-level filesystem operations (`open`, `read`, `close`) without loading the `fs` module, circumventing the cache poisoning entirely.
3. **`process.dlopen()` bypass:** Can load native addons or shared libraries directly.
4. **Writable `/tmp` + interpreter execution:** The sandbox filesystem includes a world-writable `/tmp`. An attacker can write a script to `/tmp` and execute it using an interpreter shipped in the rootfs (e.g., `python3`).

**Impact:** Full read access to the runtime source, `/etc/passwd`, `/proc/self/environ`, and arbitrary shell command execution via `execSync`.

**Note:** The outer gVisor layer provides kernel-level sandboxing with seccomp and a read-only rootfs, which mitigates these attacks in production. However, the application-level sandbox must be hardened as defense-in-depth, and the local dev environment (`docker-compose.yml` with `seccomp:unconfined`) is fully vulnerable.

### Missing Tenant Feature Gate

Code tools (sandbox execution) are currently available to all tenants with no mechanism to disable them. There is no admin control to enable/disable this capability per tenant, and no UI enforcement at design-time to prevent creation or editing of code tools when the feature is disabled.

## Design

### 1. Tenant Feature Gate — Per-Tenant Admin Toggle

#### Data Model

Add `codeToolsEnabled` to the existing `ITenantSettings` interface in `packages/database/src/models/tenant.model.ts`:

```typescript
export interface ITenantSettings {
  // ... existing fields ...
  codeToolsEnabled?: boolean; // default: false (disabled when absent)
}
```

The `tenants` collection is the natural home because:

- Settings are already scoped per tenant — no joins needed
- Already cached via `tenant-config.ts` (Redis, 5min TTL) — zero extra DB calls
- Follows existing patterns (`enableAuditLogging`, `enableClickHouse`)
- Admin already manages tenants via `platform-admin-tenants.ts`

#### Layer 1: Admin API & UI

- **Endpoint:** `PATCH /api/platform-admin/tenants/:tenantId/settings` to toggle `codeToolsEnabled`
- **Cache invalidation:** Invalidate Redis key `cfg:{tenantId}` on update
- **Admin UI:** Toggle on tenant settings page with confirmation dialog
- **Shows current state** with clear enabled/disabled indicator

#### Layer 2: Studio UI (Design-time)

A shared hook `useCodeToolsEnabled()` fetches the tenant setting and is consumed by all affected components:

| Component                                     | Behavior When Disabled                                      |
| --------------------------------------------- | ----------------------------------------------------------- |
| `NewToolDropdown.tsx`                         | Hide/disable sandbox tool option                            |
| `ToolCreateDialog.tsx` / `ToolCreatePage.tsx` | Block creation of sandbox tools                             |
| `SandboxToolWizard.tsx`                       | Show disabled state with "Contact your admin" message       |
| `ToolsListPage.tsx` / `ToolDetailPage.tsx`    | Existing sandbox tools show disabled badge (data preserved) |
| `ToolPickerModal.tsx`                         | Sandbox tools grayed out in agent builder                   |
| `ToolsEditor.tsx` / `ToolsSection.tsx`        | Sandbox tools show disabled indicator                       |
| `TestToolDialog.tsx`                          | Disable "Test" button for sandbox tools                     |

**Key principle:** Existing code tools are never deleted — they show a disabled badge but remain visible. Users can still view and delete them.

#### Layer 3: Studio API (CRUD)

| Operation                                      | Behavior When Disabled              |
| ---------------------------------------------- | ----------------------------------- |
| `POST /api/projects/:id/tools` (create)        | Reject with 403 if sandbox tool     |
| `PUT /api/projects/:id/tools/:toolId` (update) | Reject with 403 if sandbox tool     |
| `POST /api/projects/:id/tools/import` (import) | Reject with 403 if sandbox tool     |
| `GET` (list/detail)                            | Allowed — users can see what exists |
| `DELETE`                                       | Allowed — users can clean up        |

#### Layer 4: Runtime Execution (Fail-Closed)

- `SandboxToolExecutor` checks `tenant.settings.codeToolsEnabled` before dispatching to `SandboxRunnerFactory`
- If `false`, `undefined`, or lookup fails: return error "Code tool execution is disabled for this workspace"
- This is **fail-closed** — any failure in checking the setting blocks execution

### 2. JS Sandbox Escape Fix — Allowlist `require`

Replace the vulnerable `require.cache` poisoning in `services/codetool-sandbox/runtime_js/utils.js` with a strict allowlist-based approach.

#### Allowed Modules

```
axios, http, https, node-fetch, buffer, url, querystring,
string_decoder, events, util, stream, zlib, punycode, path
```

These support the intended use case: HTTP calls + data transformation.

#### Implementation: `createSafeRequire(originalRequire)`

A wrapper function that:

1. Strips `node:` prefix from module names before checking
2. Checks if the resolved module name is in the allowlist
3. Throws `Error("Module '<name>' is not permitted in sandbox")` for anything not allowlisted
4. Replaces both the `require.cache` poisoning AND the proxy-based require wrapper

#### Neutralize Dangerous `process` Properties

Before user code runs:

- `delete process.binding`
- `delete process.dlopen`
- `delete process._linkedBinding`
- `delete process.mainModule`
- `process.env = {}` (already done)
- `Object.freeze(process)` after deletions to prevent re-assignment

#### Restrict Global Scope

- Pass `safeRequire` instead of raw `require` to `new Function()`
- Set `global.require = safeRequire`
- `global.eval = undefined`
- Override `Function.prototype.constructor` to throw — prevents user code from creating `new Function()` to escape the wrapper

#### Attack Vector Coverage

| Attack Vector                      | How It's Blocked                                       |
| ---------------------------------- | ------------------------------------------------------ |
| `require('node:fs')`               | Allowlist strips `node:` prefix, `fs` not in allowlist |
| `require('node:child_process')`    | Same — `child_process` not in allowlist                |
| `process.binding('fs')`            | `process.binding` deleted + frozen                     |
| `process.dlopen()`                 | `process.dlopen` deleted + frozen                      |
| Write to `/tmp` + exec Python      | `/tmp` not mounted (Section 3)                         |
| `new Function('return process')()` | Function constructor overridden                        |
| `eval('require("fs")')`            | `global.eval` set to `undefined`                       |

### 3. OCI / Container Hardening

#### `config_template.json` — Remove Writable Surfaces

- **Remove `/tmp` mount entirely** — the path won't exist inside the sandbox. Nothing to read, write, or execute.
- **Remove `/dev/shm` mount entirely** — no shared memory surface.
- **Root filesystem** remains `"readonly": true` (already configured).

**Result:** The only mounted writable surface is `/dev` (tmpfs for device nodes, required by OCI spec). `/proc` and `/sys` are mounted read-only. Everything else is the read-only rootfs.

**Risk:** If Node.js or Python needs `/tmp` for internal operations (V8 code cache, pip temp files), this could break. Since the sandbox executes pre-installed code with pre-installed deps, this is unlikely. Verified during implementation testing.

#### `docker-compose.yml` — Replace `seccomp:unconfined`

Replace:

```yaml
security_opt:
  - seccomp:unconfined
```

With a custom seccomp profile (`services/codetool-sandbox/seccomp-profile.json`) that mirrors the OCI `config_template.json` syscall allowlist. This ensures local dev has comparable protection to production.

## What's NOT Changing

- **Python runtime** — already robust with AST-based validation + inner seccomp + sys.modules poisoning
- **gVisor architecture** — stays as-is (kernel-level sandboxing)
- **Memory bridge / JWT auth** — stays as-is
- **Plan-based features** (`plan-features.ts`) — this design uses DB-driven per-tenant toggle, not plan tiers
- **Network isolation** — CNI bridge, nginx sidecar, DNS isolation all stay as-is

## Files Changed

### Data Model

- `packages/database/src/models/tenant.model.ts` — add `codeToolsEnabled` to `ITenantSettings`

### Admin

- `apps/runtime/src/routes/platform-admin-tenants.ts` — PATCH endpoint for toggle
- Admin UI — toggle component on tenant settings page

### Studio UI

- `apps/studio/src/hooks/useCodeToolsEnabled.ts` — new shared hook
- `apps/studio/src/components/tools/NewToolDropdown.tsx`
- `apps/studio/src/components/tools/ToolCreateDialog.tsx`
- `apps/studio/src/components/tools/ToolCreatePage.tsx`
- `apps/studio/src/components/tools/wizard/SandboxToolWizard.tsx`
- `apps/studio/src/components/tools/ToolsListPage.tsx`
- `apps/studio/src/components/tools/ToolDetailPage.tsx`
- `apps/studio/src/components/abl/pickers/ToolPickerModal.tsx`
- `apps/studio/src/components/agent-editor/sections/ToolsEditor.tsx`
- `apps/studio/src/components/agent-detail/ToolsSection.tsx`
- `apps/studio/src/components/tools/TestToolDialog.tsx`

### Studio API

- `apps/studio/src/app/api/projects/[id]/tools/route.ts`
- `apps/studio/src/app/api/projects/[id]/tools/[toolId]/route.ts`
- `apps/studio/src/app/api/projects/[id]/tools/import/route.ts`

### Runtime

- `packages/compiler/src/platform/constructs/executors/sandbox-tool-executor.ts` (or equivalent) — fail-closed check

### JS Sandbox

- `services/codetool-sandbox/runtime_js/utils.js` — allowlist require, process hardening, global scope restrictions

### OCI / Container

- `services/codetool-sandbox/src/config_template.json` — remove `/tmp` and `/dev/shm` mounts
- `services/codetool-sandbox/seccomp-profile.json` — new file, mirrors OCI allowlist
- `docker-compose.yml` — reference custom seccomp profile

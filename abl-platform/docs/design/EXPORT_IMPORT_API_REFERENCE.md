# Export / Import / Git API Reference

All endpoints require JWT authentication. Project-scoped endpoints use `requireProject` middleware which verifies tenant isolation.

## Export Endpoints

### `GET /api/projects/:id/export`

Export a project as a file map.

**Auth**: JWT
**Permission**: `PROJECT_EXPORT`
**Rate limit**: 10/min per tenant

**Query parameters**:

| Param                 | Type                                | Default   | Description                  |
| --------------------- | ----------------------------------- | --------- | ---------------------------- |
| `version`             | `"1"` \| `"2"`                      | `"1"`     | Export format version        |
| `format`              | `"folder"` \| `"zip"` \| `"tar.gz"` | `"zip"`   | Output format                |
| `include_deployments` | `"true"` \| `"false"`               | `"false"` | Include deployment manifests |
| `dsl_format`          | `"yaml"` \| `"legacy"`              | `"yaml"`  | DSL output format            |
| `layers`              | comma-separated                     | defaults  | v2 only: layers to include   |

**Response 200** (v1):

```json
{
  "success": true,
  "manifest": {
    /* ProjectManifest */
  },
  "lockfile": {
    /* LockFile v1 */
  },
  "files": {
    "agents/supervisor.agent.abl": "AGENT: supervisor\n...",
    "project.json": "{...}",
    "abl.lock": "{...}"
  },
  "warnings": []
}
```

**Response 200** (v2):

```json
{
  "success": true,
  "version": 2,
  "manifest": {
    /* ProjectManifestV2 */
  },
  "lockfile": {
    /* LockFileV2 */
  },
  "files": {
    /* same structure */
  },
  "warnings": []
}
```

**Error responses**:

| Status | Code                  | Cause                                   |
| ------ | --------------------- | --------------------------------------- |
| 400    | `NO_AGENTS`           | Project has no agents                   |
| 400    | `SIZE_LIMIT_EXCEEDED` | Layer entity count exceeds max          |
| 400    | —                     | Too many agents (>1000) or tools (>500) |

---

### `POST /api/projects/:id/export/async`

Queue an async export job for large projects.

**Auth**: JWT
**Permission**: `PROJECT_EXPORT`
**Rate limit**: 5/min per tenant

**Request body**:

```json
{
  "version": "2",
  "format": "zip",
  "layers": ["core", "connections"],
  "dslFormat": "yaml",
  "includeDeployments": false,
  "forceAsync": true
}
```

All fields optional. `forceAsync: true` bypasses the auto-async threshold.

**Response 200** (async accepted):

```json
{
  "async": true,
  "jobId": "export-job-123",
  "statusUrl": "/api/projects/proj_abc/export/async?jobId=export-job-123"
}
```

**Response 200** (below threshold):

```json
{
  "async": false,
  "message": "Project has 5 agents -- use the sync export endpoint instead"
}
```

---

### `GET /api/projects/:id/export/async?jobId=xxx`

Poll async export job status.

**Auth**: JWT
**Permission**: `PROJECT_EXPORT`
**Rate limit**: 30/min per user

**Query parameters**:

| Param   | Required | Description               |
| ------- | -------- | ------------------------- |
| `jobId` | yes      | Job ID from POST response |

**Response 200**:

```json
{
  "jobId": "export-job-123",
  "status": "completed",
  "projectId": "proj_abc",
  "tenantId": "tenant_xyz",
  "result": {
    /* ExportResultV2 */
  }
}
```

**Error responses**:

| Status | Cause                                                          |
| ------ | -------------------------------------------------------------- |
| 400    | Missing `jobId`                                                |
| 404    | Job not found, expired, or belongs to different tenant/project |

---

## Import Endpoints

### `POST /api/projects/:id/import/preview`

Upload files and get an import preview without applying changes.

**Auth**: JWT
**Permission**: `PROJECT_READ`
**Rate limit**: 10/min per tenant

**Request body**:

```json
{
  "files": {
    "agents/supervisor.agent.abl": "AGENT: supervisor\n...",
    "project.json": "{...}"
  }
}
```

**Limits**:

| Limit          | Value         |
| -------------- | ------------- |
| Max file count | 500           |
| Max file size  | 1 MB per file |
| Max total size | 50 MB         |
| Max body size  | 60 MB         |

**Response 200**:

```json
{
  "success": true,
  "preview": {
    "valid": true,
    "changes": {
      "agents": {
        "added": ["new_agent"],
        "modified": [
          {
            "name": "supervisor",
            "diff": {
              /* ABLDiffResult */
            }
          }
        ],
        "removed": ["old_agent"],
        "unchanged": ["stable_agent"]
      },
      "tools": { "added": [], "modified": [], "removed": [] },
      "locales": { "added": [], "modified": [], "removed": [] },
      "profiles": { "added": [], "modified": [], "removed": [] }
    },
    "dependencyValidation": { "valid": true, "missing": [], "circular": [] },
    "syntaxErrors": [],
    "warnings": []
  }
}
```

**Validation**:

- Path traversal blocked: `..`, leading `/`, null bytes
- File content must be strings
- Size limits enforced before processing

---

### `POST /api/projects/:id/import/apply`

Apply an import. Supports legacy and staged modes.

**Auth**: JWT
**Permission**: `PROJECT_IMPORT`
**Rate limit**: 5/min per tenant

**Query parameters**:

| Param    | Type     | Default | Description                     |
| -------- | -------- | ------- | ------------------------------- |
| `staged` | `"true"` | —       | Use staged import with rollback |

**Request body**: Same as preview (`{ files: Record<string, string> }`)

**Response 200** (legacy):

```json
{
  "success": true,
  "applied": { "created": 2, "updated": 1, "deleted": 0 }
}
```

**Response 200** (staged):

```json
{
  "success": true,
  "operationId": "op_abc123",
  "phase": "completed",
  "layers": ["core", "connections"]
}
```

**Error responses**:

| Status | Code                  | Cause                                       |
| ------ | --------------------- | ------------------------------------------- |
| 400    | `INVALID_FOLDER`      | Folder validation failed                    |
| 413    | —                     | Body too large (>60 MB)                     |
| 500    | `IMPORT_APPLY_FAILED` | DB write failed, created agents rolled back |

---

### `GET /api/projects/:id/import/status?operationId=xxx`

Poll staged import operation status.

**Auth**: JWT
**Permission**: `PROJECT_READ`
**Rate limit**: 30/min per user

**Response 200**:

```json
{
  "success": true,
  "data": {
    "operationId": "op_abc123",
    "status": "completed",
    "layers": { "core": { "status": "activated" }, "connections": { "status": "activated" } },
    "error": null,
    "createdAt": "2026-03-08T12:00:00Z",
    "updatedAt": "2026-03-08T12:00:05Z"
  }
}
```

**Error responses**:

| Status | Code            | Cause                                       |
| ------ | --------------- | ------------------------------------------- |
| 400    | `MISSING_PARAM` | Missing `operationId`                       |
| 404    | `NOT_FOUND`     | Operation not found for this project/tenant |

---

### `GET /api/projects/:id/import/doctor`

Post-import validation and provisioning report.

**Auth**: JWT
**Rate limit**: 10/min per user

**Response 200**:

```json
{
  "success": true,
  "data": {
    "status": "action_required",
    "provisioning_required": {
      "env_vars": ["HOTEL_API_KEY"],
      "connectors_needing_credentials": ["salesforce"],
      "mcp_servers_needing_auth": ["weather_api"]
    },
    "warnings": ["Guardrail 'pii_filter' references unconfigured provider 'openai'"],
    "layer_summary": {}
  }
}
```

---

## Git Endpoints

### `POST /api/projects/:id/git`

Set up git integration.

**Auth**: JWT (project access required)

**Request body**:

```json
{
  "provider": "github",
  "repositoryUrl": "https://github.com/org/repo",
  "defaultBranch": "main",
  "syncPath": "/",
  "credentials": { "type": "token", "secretId": "encrypted-ref" },
  "syncConfig": { "autoSync": false, "conflictStrategy": "manual" }
}
```

**Response 201**: `{ "integration": { ... } }`

**Error responses**:

| Status | Cause                                    |
| ------ | ---------------------------------------- |
| 400    | Missing required fields                  |
| 400    | Invalid repository URL (SSRF protection) |
| 400    | Invalid credentials (validation failed)  |
| 409    | Integration already exists               |

---

### `GET /api/projects/:id/git`

Get current git integration. Sensitive credential fields are redacted (`***REDACTED***`).

**Auth**: JWT (project access required)

**Response 200**: `{ "integration": { ... } }` or `{ "integration": null }`

---

### `PATCH /api/projects/:id/git`

Update git integration settings.

**Auth**: JWT (project access required)

**Allowed fields**: `defaultBranch`, `syncPath`, `syncConfig`

**Request body**:

```json
{ "defaultBranch": "develop", "syncConfig": { "autoSync": true } }
```

**Response 200**: `{ "integration": { ... } }`

**Error responses**:

| Status | Cause                     |
| ------ | ------------------------- |
| 400    | No valid fields to update |
| 404    | No git integration found  |

---

### `DELETE /api/projects/:id/git`

Disconnect git integration. Removes the `GitIntegration` document and clears `project.gitIntegrationId`.

**Auth**: JWT (project access required)

**Response 200**: `{ "success": true }`

---

### `POST /api/projects/:id/git/push`

Push project state to git.

**Auth**: JWT
**Permission**: `PROJECT_GIT`
**Rate limit**: 10/min per tenant

**Request body**:

```json
{
  "commitMessage": "sync: update agents",
  "branch": "main",
  "createPR": {
    "title": "Update agents",
    "description": "Changes from Studio",
    "targetBranch": "main"
  }
}
```

All fields optional. `createPR` pushes to a temporary branch and creates a PR.

**Response 200**:

```json
{
  "success": true,
  "branch": "main",
  "commitSha": "abc123def456...",
  "changes": { "added": ["agents/new.agent.abl"], "modified": [], "deleted": [] },
  "agentsCount": 5
}
```

**Response 409** (conflicts):

```json
{
  "error": "Conflicts detected",
  "conflicts": [
    {
      "agentName": "booking",
      "file": "agents/booking.agent.abl",
      "baseContent": null,
      "localContent": "AGENT: booking\n...",
      "remoteContent": "AGENT: booking\n..."
    }
  ],
  "changes": { "added": [], "modified": [], "deleted": [] }
}
```

---

### `POST /api/projects/:id/git/pull`

Pull from git into project.

**Auth**: JWT
**Permission**: `PROJECT_GIT`
**Rate limit**: 10/min per tenant

**Request body**:

```json
{ "branch": "main", "dryRun": true }
```

**Response 200** (dry run):

```json
{
  "success": true,
  "dryRun": true,
  "branch": "main",
  "commitSha": "abc123...",
  "changes": { "added": ["new_agent"], "modified": [], "deleted": [] },
  "preview": {
    /* ImportResult */
  }
}
```

**Response 200** (apply):

```json
{
  "success": true,
  "branch": "main",
  "commitSha": "abc123...",
  "changes": { "added": ["new_agent"], "modified": [], "deleted": [] },
  "preview": {
    /* ImportResult */
  }
}
```

---

### `GET /api/projects/:id/git/history`

Get sync history.

**Auth**: JWT
**Permission**: `PROJECT_READ`
**Rate limit**: 30/min per user

**Query parameters**:

| Param       | Type                 | Default | Description                 |
| ----------- | -------------------- | ------- | --------------------------- |
| `limit`     | number               | 25      | Max entries (capped at 100) |
| `direction` | `"push"` \| `"pull"` | —       | Filter by direction         |

**Response 200**:

```json
{
  "history": [
    {
      "direction": "push",
      "commitSha": "abc123...",
      "branch": "main",
      "status": "success",
      "agentsAffected": ["supervisor"],
      "changesSummary": { "added": [], "modified": ["agents/supervisor.agent.abl"], "deleted": [] },
      "triggeredBy": "user_123",
      "createdAt": "2026-03-08T12:00:00Z"
    }
  ],
  "total": 1
}
```

---

### `GET /api/projects/:id/git/status`

Get local vs remote status.

**Auth**: JWT
**Permission**: `PROJECT_READ`
**Rate limit**: 30/min per user

**Response 200**:

```json
{
  "integration": {
    "provider": "github",
    "repositoryUrl": "https://github.com/org/repo",
    "defaultBranch": "main",
    "lastSyncAt": "2026-03-08T12:00:00Z",
    "lastSyncCommit": "abc123...",
    "lastSyncStatus": "success"
  },
  "localAgents": [
    { "name": "supervisor", "sourceHash": "a1b2c3d4...", "lastEditedAt": "2026-03-08T11:00:00Z" }
  ],
  "message": "Status shows local state. Use git provider tools to compare with remote."
}
```

---

### `POST /api/projects/:id/git/promote`

Promote changes between environment branches.

**Auth**: JWT
**Permission**: `PROJECT_DEPLOY`
**Rate limit**: 5/min per tenant

**Request body**:

```json
{ "from": "main", "to": "staging" }
```

**Response 200**:

```json
{
  "success": true,
  "data": { "fromBranch": "main", "toBranch": "staging", "commitSha": null }
}
```

`commitSha` is null because promotion creates a PR (not auto-merged).

**Error responses**:

| Status | Code                 | Cause                            |
| ------ | -------------------- | -------------------------------- |
| 400    | `MISSING_PARAMS`     | `from` or `to` missing           |
| 400    | `INVALID_TARGET`     | Target not an environment branch |
| 400    | `SAME_BRANCH`        | Source equals target             |
| 400    | `GIT_NOT_CONFIGURED` | No git integration               |
| 500    | `PROMOTION_FAILED`   | PR creation failed               |

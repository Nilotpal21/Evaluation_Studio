# Git Integration Guide

## Overview

The git integration syncs ABL projects with external git repositories. It supports GitHub, GitLab, Bitbucket, and generic git hosts via provider-specific API implementations.

Source: `packages/project-io/src/git/`, `apps/studio/src/app/api/projects/[id]/git/`

## Setup Flow

### 1. Select Provider and Repository

```
POST /api/projects/:id/git
{
  "provider": "github",                    // github | gitlab | bitbucket | generic
  "repositoryUrl": "https://github.com/org/repo",
  "defaultBranch": "main",                 // optional, defaults to "main"
  "syncPath": "/",                         // optional, defaults to "/"
  "credentials": {
    "type": "token",                       // oauth | token | app
    "secretId": "encrypted-token-ref"      // encrypted credential ID
  },
  "syncConfig": {
    "autoSync": false,                     // optional
    "conflictStrategy": "manual"           // manual | local_wins | remote_wins
  }
}
```

### 2. Credential Validation

Before persisting, the route:

1. Resolves the encrypted `secretId` via `resolveGitCredentials()`
2. Creates a provider instance via `createGitProvider()`
3. Calls `provider.validateConnection()` to verify access
4. Returns 400 if validation fails

### 3. Repository URL Validation

The setup route validates the URL to prevent SSRF:

- Only `https:` and `http:` schemes allowed
- Blocks private/internal IPs: `localhost`, `127.0.0.1`, `10.*`, `172.*`, `192.168.*`, `*.local`, `*.internal`

### 4. Persistence

On success, creates a `GitIntegration` document and links it to the project via `gitIntegrationId`. Duplicate setup returns 409 (unique index on `projectId`).

## Credential Resolution

Credentials are stored as encrypted references (`secretId`). Resolution flow:

```
secretId → isEncryptionAvailable()?
  yes → encryptionService.decryptForTenant(secretId, tenantId)
  no  → use secretId as raw token (dev mode only, logged as warning)
```

For Bitbucket, the decrypted value may be `"username:token"` or `"email:api_token"`:

| Format                 | Auth Mode   | Description                                |
| ---------------------- | ----------- | ------------------------------------------ |
| `email@host:token`     | `api_token` | Atlassian API token (recommended)          |
| `username:appPassword` | `basic`     | Legacy app password (deprecated June 2026) |
| `raw-token`            | `token`     | Repository/Workspace Access Token (Bearer) |

In production, decryption failure throws — no fallback. In dev/test, falls back to raw value.

Source: `apps/studio/src/lib/git-credentials.ts`

## Push Workflow

```
POST /api/projects/:id/git/push
{
  "commitMessage": "sync: update booking agent",  // optional
  "branch": "main",                                // optional, uses defaultBranch
  "createPR": {                                    // optional
    "title": "Update booking agent",
    "description": "Changes from ABL Studio",
    "targetBranch": "main"
  }
}
```

Flow:

1. Load `GitIntegration` config from DB
2. Load all project agents and tools
3. Export project to file map via `exportProject()`
4. Pull current remote state for conflict detection
5. If `lastSyncCommit` exists + remote files differ from local → three-way conflict check
6. If conflicts → return 409 with conflict details
7. If `createPR` → create a branch `abl-sync/<timestamp>`, push there, create PR
8. Otherwise → push directly to branch
9. Record sync history and update `lastSyncCommit`

## Pull Workflow

```
POST /api/projects/:id/git/pull
{
  "branch": "main",      // optional, uses defaultBranch
  "dryRun": true          // optional, preview without applying
}
```

Flow:

1. Load `GitIntegration` config
2. Pull all files from remote branch via provider
3. Run import pipeline: `readFolder` → `validateManifest` → `validateImport` → `computeApplyOperations`
4. If `dryRun` → return preview (diffs, operations) without applying
5. Otherwise → apply operations (create/update/delete agents)
6. Record sync history

Branch names are validated: alphanumeric with `/`, `-`, `.`, `_`; no `..` or leading `/`; max 256 chars.

## Conflict Detection

Three-way comparison using base (last sync), local (export), and remote (pull):

| Condition         | Resolution                                |
| ----------------- | ----------------------------------------- |
| `base === ours`   | Accept remote (no local changes)          |
| `base === theirs` | Keep local (no remote changes)            |
| `ours === theirs` | Identical changes, no conflict            |
| All differ        | **CONFLICT** — requires manual resolution |

Conflict strategies:

- `manual` — return conflicts to user, block push
- `local_wins` — auto-resolve by keeping local version
- `remote_wins` — auto-resolve by keeping remote version

Source: `packages/project-io/src/git/conflict-resolver.ts`

## Webhook Setup

### GitHub

1. Register via `provider.registerWebhook(callbackUrl, secret)`
2. Signature verification: `sha256=` + HMAC-SHA256 of payload body
3. Header: `X-Hub-Signature-256`
4. Payload: push event with `ref`, `head_commit`, `commits[].{added,modified,removed}`

### GitLab

1. Register webhook in GitLab project settings
2. Signature verification: constant-time comparison of `X-Gitlab-Token` header against secret
3. Payload: push event with `object_kind: "push"`, `ref`, `commits[].{added,modified,removed}`

### Bitbucket

1. Register webhook via Bitbucket API
2. Signature verification: HMAC-SHA256 of payload body
3. Header: `X-Hub-Signature`
4. Payload: `push.changes[0].new.{name, target.hash}`
5. Note: Bitbucket push payloads don't always include file lists — all pushes treated as relevant

### Relevance Filtering

Only pushes containing ABL-relevant files trigger sync:

```typescript
const ABL_RELEVANT_PATTERNS = [
  /\.agent\.abl$/,
  /\.tools\.abl$/,
  /^project\.json$/,
  /^config\//,
  /^deployments\//,
];
```

Source: `packages/project-io/src/git/webhook-handler.ts`

## Branch Management and Promotion

Environment-based branch strategy:

```
main       ← source of truth (dev work)
staging    ← tracks staging deployment
production ← tracks production deployment
```

Promotion creates a PR from source to target branch, providing an audit trail:

```
POST /api/projects/:id/git/promote
{ "from": "main", "to": "staging" }
```

- Target must be one of `main`, `staging`, `production`
- Source and target must differ
- Auto-creates target branch from source if it doesn't exist
- Returns PR details (not auto-merged — requires manual approval)

Source: `packages/project-io/src/git/branch-manager.ts`

## Provider Implementations

### URL Parsing

| Provider  | URL Pattern                               | Parsed Fields           |
| --------- | ----------------------------------------- | ----------------------- |
| GitHub    | `github.com/owner/repo(.git)`             | `owner`, `repo`         |
| GitLab    | `gitlab.com/group/subgroup/project(.git)` | `projectPath`           |
| Bitbucket | `bitbucket.org/workspace/repo(.git)`      | `workspace`, `repoSlug` |

### Provider Interface

All providers implement:

```typescript
interface GitProvider {
  validateConnection(): Promise<{ valid: boolean; error?: string }>;
  listFiles(branch: string, path?: string): Promise<GitFile[]>;
  getFile(branch: string, path: string): Promise<GitFile | null>;
  pullProject(branch: string, syncPath: string): Promise<PullResult>;
  pushFiles(
    branch: string,
    files: GitFile[],
    message: string,
    committer: Committer,
  ): Promise<PushResult>;
  createBranch(name: string, fromBranch: string): Promise<GitBranch>;
  createPullRequest(params: PRParams): Promise<CreatePRResult>;
  listCommits(branch: string, limit?: number): Promise<GitCommit[]>;
  registerWebhook(callbackUrl: string, secret: string): Promise<string>;
  removeWebhook(webhookId: string): Promise<void>;
  getDiff(baseCommit: string, headCommit: string): Promise<PullResult>;
}
```

Source: `packages/project-io/src/git/git-provider.ts`

## Rate Limits

| Endpoint            | Limit  | Window | Scope  |
| ------------------- | ------ | ------ | ------ |
| `POST /git` (setup) | N/A    | N/A    | N/A    |
| `POST /git/push`    | 10/min | 60s    | tenant |
| `POST /git/pull`    | 10/min | 60s    | tenant |
| `GET /git/history`  | 30/min | 60s    | user   |
| `GET /git/status`   | 30/min | 60s    | user   |
| `POST /git/promote` | 5/min  | 60s    | tenant |

## Error Codes

| Code                 | HTTP | Description                                         |
| -------------------- | ---- | --------------------------------------------------- |
| `SYNC_CONFLICT`      | 409  | Push conflicts detected, manual resolution required |
| `PROMOTION_FAILED`   | 500  | Branch promotion PR creation failed                 |
| `GIT_NOT_CONFIGURED` | 400  | No git integration for this project                 |
| `MISSING_PARAMS`     | 400  | Required parameters missing                         |
| `INVALID_TARGET`     | 400  | Promote target must be environment branch           |
| `SAME_BRANCH`        | 400  | Source and target branches must differ              |
| 404                  | 404  | No git integration found                            |
| 409                  | 409  | Git integration already exists (duplicate setup)    |
| 500                  | 500  | Provider API failure                                |

## Sync History

Every push/pull operation (success, failure, or conflict) creates a `GitSyncHistory` record:

```json
{
  "projectId": "...",
  "tenantId": "...",
  "direction": "push",
  "commitSha": "abc123...",
  "branch": "main",
  "status": "success",
  "agentsAffected": ["supervisor", "booking"],
  "changesSummary": { "added": [], "modified": ["agents/booking.agent.abl"], "deleted": [] },
  "triggeredBy": "user_123"
}
```

Query via `GET /api/projects/:id/git/history?limit=25&direction=push`.

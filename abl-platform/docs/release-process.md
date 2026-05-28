# Release Management

Comprehensive guide for managing ABL Platform releases, including Bitbucket branch strategy, Jira integration, and the `apx` CLI automation.

## Table of Contents

- [Version Scheme](#version-scheme)
- [Repository Architecture](#repository-architecture)
- [Branch Strategy](#branch-strategy)
- [Release Flow](#release-flow)
- [Hotfix Flow](#hotfix-flow)
- [apx CLI Reference](#apx-cli-reference)
- [Jira Integration](#jira-integration)
- [Bitbucket Configuration](#bitbucket-configuration)
- [Harness CI/CD Integration](#harness-cicd-integration)
- [CHANGELOG](#changelog)
- [Environment Variables](#environment-variables)
- [Troubleshooting](#troubleshooting)

---

## Version Scheme

We use **CalVer** (Calendar Versioning): `YYYY.MM.patch`

| Component | Description                                      | Example    |
| --------- | ------------------------------------------------ | ---------- |
| `YYYY`    | 4-digit year                                     | 2026       |
| `MM`      | 2-digit month (zero-padded)                      | 03         |
| `patch`   | Incrementing integer, resets to 0 each new month | 0, 1, 2... |

**Examples:** `2026.03.0`, `2026.03.1` (hotfix), `2026.04.0` (next month)

**Git tags** are prefixed with `v`: `v2026.03.0`

**Jira fix versions** use the bare version: `2026.03.0`

**Why CalVer?** This is a private platform (not published to npm). CalVer communicates deployment timeline naturally and maps cleanly to Jira fix versions and sprint boundaries.

---

## Repository Architecture

The platform spans three repositories:

| Repository            | Purpose                       | Versioning                     |
| --------------------- | ----------------------------- | ------------------------------ |
| `abl-platform`        | Source code (this repo)       | CalVer tags on `main`          |
| `abl-platform-deploy` | Helm charts, ArgoCD manifests | References `abl-platform` tags |
| `abl-platform-infra`  | Terraform infrastructure      | Independent versioning         |

Release tags on `abl-platform` drive deployments in `abl-platform-deploy` via ArgoCD.

---

## Branch Strategy

```
main              Always deployable. Tagged releases only.
  ↑
develop           Integration branch. All feature PRs merge here.
  ↑
feature/ABLP-123  Feature work. Short-lived, branched from develop.
  ↑
release/2026.03.0 Cut from develop. QA and stabilization only.
  ↑
hotfix/2026.03.1  Cut from main. Urgent production fixes.
```

### Branch Lifecycle

| Branch      | Created from | Merges to                  | Deleted after     |
| ----------- | ------------ | -------------------------- | ----------------- |
| `feature/*` | `develop`    | `develop` (via PR)         | PR merge          |
| `release/*` | `develop`    | `main` + back to `develop` | Release finalized |
| `hotfix/*`  | `main`       | `main` + back to `develop` | Hotfix finalized  |

### Naming Conventions

| Branch type | Pattern                           | Example                       |
| ----------- | --------------------------------- | ----------------------------- |
| Feature     | `feature/ABLP-{id}-{description}` | `feature/ABLP-123-add-search` |
| Bugfix      | `fix/ABLP-{id}-{description}`     | `fix/ABLP-456-session-leak`   |
| Release     | `release/{version}`               | `release/2026.03.0`           |
| Hotfix      | `hotfix/{version}`                | `hotfix/2026.03.1`            |

---

## Release Flow

```
  develop              release/2026.03.0              main
    |                                                   |
    |---- apx release cut ------>|                      |
    |                            |                      |
    |                    (QA, bug fixes only)            |
    |                            |                      |
    |                            |-- apx release -----> |
    |                            |   finalize      tag v2026.03.0
    |<------ merge back ---------|                      |
    |                        (branch deleted)           |
    |                                                   |
```

### Step 1: Cut the release

From `develop` with a clean working tree:

```bash
apx release cut
```

**What happens:**

1. Computes next CalVer version from current date and last tag
2. Creates branch `release/YYYY.MM.patch` from `develop`
3. Bumps `package.json` version at workspace root
4. Commits: `[ABLP-0] chore(ci): bump version to YYYY.MM.patch`
5. Pushes the release branch to Bitbucket
6. Creates a Jira fix version (if configured)
7. Sets fix version on all Jira tickets found in commits since last tag

### Step 2: QA and stabilize

On the release branch:

- Run full test suite: `pnpm build && pnpm turbo test:fast --concurrency=2`
- Only bug fixes and release-related changes allowed
- No new features — those go to `develop` for the next release

### Step 3: Finalize the release

From the `release/*` branch:

```bash
apx release finalize
```

**What happens:**

1. Merges release branch → `main` (`--no-ff`)
2. Creates annotated tag `vYYYY.MM.patch`
3. Merges `main` → `develop` (carries version bump + any release fixes)
4. Deletes release branch (local + remote)
5. Generates CHANGELOG.md entry
6. Pushes `main`, `develop`, and the tag to Bitbucket
7. Marks the Jira fix version as released

---

## Hotfix Flow

For urgent production fixes that can't wait for the next release.

```
  develop                  hotfix/2026.03.1                main
    |                                                        |
    |                                    apx hotfix create --|
    |                                            |           |
    |                                     (apply fix)        |
    |                                            |           |
    |                      apx hotfix finalize --|---------> |
    |<------ merge back ---------|          tag v2026.03.1   |
    |                        (branch deleted)                |
```

### Step 1: Create hotfix

From `main`:

```bash
apx hotfix create
```

Increments the patch number from the latest tag (e.g., `v2026.03.0` → `2026.03.1`).

### Step 2: Apply fix

Commit the fix on the hotfix branch. Keep changes minimal.

### Step 3: Finalize hotfix

From the `hotfix/*` branch:

```bash
apx hotfix finalize
```

Same as release finalize — merges to `main`, tags, merges back to `develop`, updates Jira.

---

## apx CLI Reference

All release commands are subcommands of `apx`:

### Release Commands

| Command                 | Branch      | Description                               |
| ----------------------- | ----------- | ----------------------------------------- |
| `apx release cut`       | `develop`   | Create release branch, bump version, push |
| `apx release finalize`  | `release/*` | Merge to main, tag, merge back, cleanup   |
| `apx release status`    | any         | Show current release state dashboard      |
| `apx release changelog` | any         | Generate CHANGELOG from git history       |

### Hotfix Commands

| Command               | Branch     | Description                           |
| --------------------- | ---------- | ------------------------------------- |
| `apx hotfix create`   | `main`     | Create hotfix branch from main        |
| `apx hotfix finalize` | `hotfix/*` | Merge to main + develop, tag, cleanup |

### Global Flags

| Flag          | Description                              |
| ------------- | ---------------------------------------- |
| `--dry-run`   | Print all actions without executing them |
| `--skip-jira` | Skip all Jira API calls                  |

### Examples

```bash
# Preview what a release cut would do
apx release cut --dry-run

# Cut a release without Jira integration
apx release cut --skip-jira

# Check the current state
apx release status

# Generate CHANGELOG from a specific tag
apx release changelog --from v2026.02.0

# Create and finalize a hotfix
apx hotfix create
# ... apply fix, commit ...
apx hotfix finalize
```

---

## Jira Integration

### How It Works

The release tooling integrates with Jira via REST API v3:

| When                    | What happens in Jira                                            |
| ----------------------- | --------------------------------------------------------------- |
| `apx release cut`       | Creates fix version `2026.03.0` in the ABLP project             |
| `apx release cut`       | Sets fix version on all tickets found in commits since last tag |
| `apx release finalize`  | Marks the fix version as "Released" with today's date           |
| `apx hotfix create`     | Creates fix version for the hotfix                              |
| `apx hotfix finalize`   | Marks the hotfix fix version as "Released"                      |
| `apx release changelog` | Fetches ticket summaries for CHANGELOG entries                  |

### Ticket Detection

Tickets are extracted from commit messages using the enforced format:

```
[ABLP-123] feat(studio): add new dashboard widget
 ^^^^^^^^
 Extracted automatically
```

The commitlint config enforces this format on every commit via the `commit-msg` hook.

### Day-to-Day Development Workflow

For normal development work outside the release CLI:

1. Reuse the existing Jira ticket for the task when one already exists.
2. If a commit or PR is required and no ticket exists yet, create one before committing.
3. Do not create Jira tickets for pure local exploration or uncommitted debugging unless the user explicitly asks.
4. Use the ticket in every commit header: `[ABLP-123] type(scope): description`.
5. After commit or PR creation, add the commit SHA or PR link back to the ticket when practical.

Automation note: if a script or agent reads credentials from `.env`, do not `source .env` directly. Read only the needed keys so shell-unsafe values cannot break the session.

### Fix Version Naming

Jira fix versions match the CalVer version exactly:

| Git Tag      | Jira Fix Version |
| ------------ | ---------------- |
| `v2026.03.0` | `2026.03.0`      |
| `v2026.03.1` | `2026.03.1`      |
| `v2026.04.0` | `2026.04.0`      |

### Setup

1. Generate a Jira API token at https://id.atlassian.com/manage-profile/security/api-tokens
2. Set environment variables (see [Environment Variables](#environment-variables))
3. Test with: `apx release status` (should show "Jira: configured" or "Jira: not configured")

### Graceful Degradation

All Jira operations are **optional**. If env vars are missing or the API fails:

- The release proceeds normally
- A warning is printed
- No release is blocked by Jira issues

Use `--skip-jira` to explicitly disable Jira integration for a command.

---

## Bitbucket Configuration

### Branch Permissions

Configure in **Repository settings → Branch permissions**:

#### `main` branch

| Setting                | Value                                |
| ---------------------- | ------------------------------------ |
| Prevent direct pushes  | Yes                                  |
| Require pull request   | Yes                                  |
| Minimum approvals      | 1                                    |
| Require passing builds | Yes (Harness CI)                     |
| Allowed push exception | Release automation (service account) |

#### `release/*` branches

| Setting                | Value                                 |
| ---------------------- | ------------------------------------- |
| Prevent force push     | Yes                                   |
| Require passing builds | Yes                                   |
| Allow push             | Release automation + release managers |

#### `develop` branch

| Setting                | Value |
| ---------------------- | ----- |
| Prevent direct pushes  | Yes   |
| Require pull request   | Yes   |
| Minimum approvals      | 1     |
| Require passing builds | Yes   |

### Pull Request Settings

Configure in **Repository settings → Pull requests**:

- **Merge strategy**: Merge commit (no fast-forward) — preserves release branch history
- **Auto-merge**: Disabled for `main` (releases are explicit)
- **Branch deletion**: Auto-delete merged feature branches

### Webhooks

Configure a webhook to notify Harness CI on:

- Push to `release/*` branches → triggers release CI pipeline
- Push to `main` → triggers production deployment pipeline
- Tag creation `v*` → triggers ArgoCD sync in `abl-platform-deploy`

---

## Harness CI/CD Integration

### Pipeline Triggers

| Event               | Pipeline   | Action                                    |
| ------------------- | ---------- | ----------------------------------------- |
| Push to `develop`   | CI Build   | Build + test:fast                         |
| Push to `release/*` | CI Release | Build + full test suite                   |
| Push to `main`      | CI Deploy  | Build + tag Docker images with version    |
| Tag `v*`            | Deploy     | Update `abl-platform-deploy` with new tag |

### Docker Image Tagging

| Branch          | Image Tag                                  |
| --------------- | ------------------------------------------ |
| `develop`       | `dev-{short-sha}`                          |
| `release/*`     | `rc-{version}` (e.g., `rc-2026.03.0`)      |
| `main` (tagged) | `{version}` + `latest` (e.g., `2026.03.0`) |

### ArgoCD Sync

When a tag is pushed to `main`, the deploy pipeline:

1. Updates image tags in `abl-platform-deploy` Helm values
2. Creates a commit in `abl-platform-deploy`
3. ArgoCD detects the change and syncs the environment

---

## CHANGELOG

### Format

Auto-generated from git commits, grouped by type:

```markdown
## 2026.03.0 (2026-03-15)

### Features

- [ABLP-123] **studio:** Add new dashboard widget (abc1234)
  > Jira: Implement real-time KPI dashboard for agent monitoring

### Bug Fixes

- [ABLP-456] **runtime:** Fix memory leak in session store (def5678)
  > Jira: Session memory grows unbounded after 24h

### Refactoring

- [ABLP-789] **compiler:** Extract validation into separate module (ghi9012)
```

### Generation

```bash
# Auto-generate from latest tag (default)
apx release changelog

# From a specific starting point
apx release changelog --from v2026.02.0
```

The CHANGELOG is written to `CHANGELOG.md` at the repository root. New entries are prepended.

---

## Environment Variables

| Variable             | Required | Description                                               | Example                        |
| -------------------- | -------- | --------------------------------------------------------- | ------------------------------ |
| `JIRA_BASE_URL`      | For Jira | Jira/Atlassian instance URL                               | `https://myteam.atlassian.net` |
| `ATLASSIAN_BASE_URL` | For Jira | Alternative to JIRA_BASE_URL                              | `https://myteam.atlassian.net` |
| `JIRA_EMAIL`         | For Jira | Jira account email                                        | `user@company.com`             |
| `JIRA_API_TOKEN`     | For Jira | Jira API token (preferred variable name)                  | `ATATT3xFfGF0...`              |
| `ATLASSIAN_API_KEY`  | For Jira | Supported alias for the Jira API token in local `.env`    | `ATATT3xFfGF0...`              |
| `JIRA_PROJECT_KEY`   | No       | Jira project key (default: `ABLP`)                        | `ABLP`                         |
| `ABL_RELEASE`        | No       | Set to `1` by release scripts to bypass branch protection | (auto-set)                     |

### Setup

Add to your shell profile (`~/.bashrc`, `~/.zshrc`) or `.env`:

```bash
export JIRA_BASE_URL=https://yourteam.atlassian.net
export JIRA_EMAIL=your@email.com
export JIRA_API_TOKEN=your-api-token
# or: export ATLASSIAN_API_KEY=your-api-token
# export JIRA_PROJECT_KEY=ABLP  # optional, defaults to ABLP
```

Or create a `.env.local` file at the repository root (gitignored).

---

## Troubleshooting

### "Working tree is not clean"

All release commands require a clean working tree. Commit or stash changes:

```bash
git stash push -m "pre-release"
apx release cut
git stash pop
```

### "Expected branch X, but on Y"

Each command requires a specific branch:

| Command                | Required branch |
| ---------------------- | --------------- |
| `apx release cut`      | `develop`       |
| `apx release finalize` | `release/*`     |
| `apx hotfix create`    | `main`          |
| `apx hotfix finalize`  | `hotfix/*`      |

### "Direct push to main is blocked"

The `.husky/pre-push` hook blocks direct pushes to protected branches. Use the release CLI which sets `ABL_RELEASE=1` automatically.

### Merge conflicts during finalize

If a merge conflict occurs during `apx release finalize`:

1. The script will abort with an error
2. Resolve the conflict manually: `git merge --continue`
3. Complete remaining steps manually:
   ```bash
   git tag -a v2026.03.0 -m "Release 2026.03.0"
   git checkout develop
   git merge --no-ff main -m "Merge main back to develop after release 2026.03.0"
   ABL_RELEASE=1 git push origin main develop --tags
   git branch -D release/2026.03.0
   git push origin --delete release/2026.03.0
   ```

### Jira operations fail

Jira failures are warnings, not errors. The release completes even if Jira is unreachable.

Check:

- `JIRA_BASE_URL` / `ATLASSIAN_BASE_URL` is set and reachable
- `JIRA_EMAIL` matches your Atlassian account
- `JIRA_API_TOKEN` or `ATLASSIAN_API_KEY` is valid (not expired)
- `JIRA_PROJECT_KEY` matches your Jira project (default: `ABLP`)

### Pre-push hook runs full test suite

The pre-push hook runs `pnpm turbo test:fast` on affected packages. If it takes too long or fails on unrelated tests, you can skip it for release pushes:

```bash
ABL_RELEASE=1 git push origin release/2026.03.0
```

The release CLI does this automatically.

### Release branch already exists

If `release/2026.03.0` already exists (from a failed attempt):

```bash
git branch -D release/2026.03.0           # delete local
git push origin --delete release/2026.03.0 # delete remote
apx release cut                            # try again
```

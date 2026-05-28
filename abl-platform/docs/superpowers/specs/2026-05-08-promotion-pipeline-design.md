# Promotion Pipeline — Harness Design Spec

**Date:** 2026-05-08
**Status:** Draft
**Location:** `.harness/pipelines/promote-release.yaml` (app repo)

---

## 1. Problem

CI auto-deploys to dev via ArgoCD, but promotion to staging/SIT/prod is fully manual:
operators run `prepare-release.sh` and `promote-release.sh` locally, commit, and push.
There are no approval gates, no automated post-deploy validation, and no built-in
rollback mechanism tied to the promotion context.

## 2. Goals

- Automate the full promotion lifecycle in a single Harness pipeline.
- Require human approval before each promotion.
- Run post-deploy validation automatically after ArgoCD syncs.
- Provide one-click rollback from the same pipeline execution.
- Keep the pipeline flexible: operator picks source env, target env(s), and release name at runtime.

## 3. Non-Goals

- QA promotion (QA uses a separate `QA` branch in the deploy repo — stays manual).
- Chart version bumps (`bump-chart.sh` / `package-chart.sh` / `promote-chart.sh` remain a separate workflow).
- Auto-triggering from CI (pipeline is manual-only).
- Slack/Jira notifications (ArgoCD already sends Slack notifications via its configmap).

## 4. Pipeline Inputs

| Variable             | Type      | Default        | Description                                                                                          |
| -------------------- | --------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| `source_env`         | SelectOne | `dev`          | Environment to snapshot the release from. Allowed: `dev`, `staging`.                                 |
| `target_envs`        | String    | `staging`      | Comma-separated target envs (e.g. `staging`, `staging,sit`). Must be `main`-branch envs only.        |
| `release_name`       | String    | auto-generated | Release name. Default: `release-YYYY-MM-DD-<source_env>`. Must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`. |
| `skip_validation`    | Boolean   | `false`        | Skip post-deploy validation (emergency hotfix mode).                                                 |
| `approval_timeout`   | String    | `4h`           | How long to wait for approval before auto-rejecting.                                                 |
| ~~`approver_group`~~ | —         | —              | Removed. Hardcoded to `platform-leads` in the approval stage.                                        |

## 5. Stage Flow

```
┌─────────────────────────┐
│  1. Prepare Release     │  Clone deploy repo, run prepare-release.sh
│     (automated)         │  Capture: release content, previous lock per target env
└───────────┬─────────────┘
            │
            v
┌─────────────────────────┐
│  2. Approval Gate       │  Harness approval stage
│     (manual)            │  Shows: release name, source, targets, tag diff
└───────────┬─────────────┘
            │
            v
┌─────────────────────────┐
│  3. Promote & Push      │  Run promote-release.sh, commit, push to main
│     (automated)         │  Save previous release locks as output
└───────────┬─────────────┘
            │
            v
┌─────────────────────────┐
│  4. Wait for Sync       │  Poll health endpoints per target env
│     (automated)         │  Timeout: 10 minutes, poll every 30s
└───────────┬─────────────┘
            │
            v
┌─────────────────────────┐
│  5. Post-Deploy         │  Trigger post_deploy_validation pipeline
│    Validation           │  with target env URLs
│    (conditional)        │  Skipped if skip_validation=true
└───────────┬─────────────┘
            │
            v
┌─────────────────────────┐
│  6. Rollback            │  Manual-trigger only (never auto-executes)
│    (manual trigger)     │  Re-promotes previous release from step 3 output
│                         │  Commits, pushes, waits for sync
└─────────────────────────┘
```

## 6. Stage Details

### 6.1 Prepare Release

**Image:** Python 3.12 slim (needs `ruamel.yaml`, `jsonschema`, `helm`, `yq`, `git`)

**Steps:**

1. **Clone deploy repo** — `GitClone` step, `abl-platform-deploy`, branch `main`, into `/harness/deploy`.

2. **Install dependencies** — `pip install ruamel.yaml jsonschema` + install `helm` and `yq` binaries.

3. **Auto-generate release name** (if not provided) — Format: `release-YYYY-MM-DD-<source_env>`. If that name already exists in `releases/`, append a counter suffix (`-2`, `-3`, etc.) since releases are immutable.

4. **Run `prepare-release.sh`** — `scripts/prepare-release.sh <release_name> <source_env>`. This:
   - Reads chart version + image tags from `environments/<source_env>/`
   - Verifies chart tarball integrity (sha256)
   - Writes immutable `releases/<release_name>.yaml`
   - Schema-validates the output

5. **Capture previous release locks** — For each target env, read `environments/<env>/release.lock.yaml` and extract `metadata.release` (the previous release name). Export as output variables:
   - `RELEASE_NAME` — the release being promoted
   - `PREV_RELEASE_<env>` — previous release name per target env (e.g. `PREV_RELEASE_staging`)
   - `TAG_DIFF` — human-readable summary of what changes (parsed from release YAML vs current env values)

6. **Commit release artifact** — `git add releases/<release_name>.yaml && git commit`. This must be committed before `promote-release.sh` can reference it.

**Failure:** Pipeline aborts. No env is modified.

### 6.2 Approval Gate

**Type:** `HarnessApproval`

**Approval message:**

```
Promoting release '<release_name>' from <source_env> to <target_envs>.

Tag changes:
<TAG_DIFF from stage 1>

Previous release(s):
<PREV_RELEASE per env from stage 1>

Approve to proceed with promotion.
```

**Configuration:**

- Approver group: `platform-leads` (hardcoded)
- Minimum approvals: 1
- Timeout: `<approval_timeout>` pipeline variable (default 4h)
- Auto-reject on timeout

**Failure:** Pipeline stops. No env is modified.

### 6.3 Promote & Push

**Steps:**

1. **Run `promote-release.sh`** — `scripts/promote-release.sh <release_name> <target_envs...>`. This:
   - Pre-flight validates all target envs atomically
   - Stages mutations in temp dirs, validates via `helm template`
   - Atomically swaps Chart.yaml, charts/\*.tgz, values.yaml
   - Writes `release.lock.yaml` per env

2. **Commit and push** — Commit message format:

   ```
   deploy(<target_envs>): promote <release_name>

   Source: <source_env>
   Pipeline: <execution_url>
   [skip ci]
   ```

   Push to `main` with retry logic (3 attempts with `git pull --rebase` between retries).

3. **Export rollback data** — For each target env, export `PREV_RELEASE_<env>` as stage output variables (already captured in stage 1, re-exported here for the rollback stage to reference).

**Failure:** If `promote-release.sh` fails on env N, envs 1..N-1 are already promoted (by design — the script is sequential). The push is skipped. Operator can fix and re-run; already-promoted envs no-op cleanly.

### 6.4 Wait for ArgoCD Sync

**Environment URL registry** (maintained as a case statement in the pipeline):

| Env       | Domain                   | Health endpoint                             |
| --------- | ------------------------ | ------------------------------------------- |
| `dev`     | `agents-dev.kore.ai`     | `https://agents-dev.kore.ai/api/health`     |
| `staging` | `agents-staging.kore.ai` | `https://agents-staging.kore.ai/api/health` |

New envs are added by extending this mapping.

**Behavior:**

- For each target env, poll the health endpoint every 30 seconds.
- Success: HTTP 200 response.
- Timeout: 10 minutes. If any env doesn't respond healthy within 10 minutes, the stage fails.
- The stage iterates over all target envs sequentially.

**Failure:** Stage fails, but promotion is already applied. Operator investigates via ArgoCD UI. Rollback stage is available.

### 6.5 Post-Deploy Validation

**Type:** Pipeline chaining — triggers `post_deploy_validation` pipeline.

**Condition:** `skip_validation != "true"`

**Input mapping per env:**

| Validation input        | Value                                    |
| ----------------------- | ---------------------------------------- |
| `environment_name`      | target env name                          |
| `studio_url`            | `https://<domain>`                       |
| `runtime_api_url`       | `https://<domain>`                       |
| `search_ai_url`         | `https://<domain>/api/search-ai`         |
| `search_ai_runtime_url` | `https://<domain>/api/search-ai-runtime` |
| `admin_url`             | `https://<domain>`                       |
| `login_email`           | `developer@kore.ai`                      |
| `run_deep_integration`  | `true`                                   |
| `run_studio_live_e2e`   | `true`                                   |
| `run_admin_playwright`  | `false`                                  |

**Multi-env behavior:** When multiple target envs are specified, validation runs against each target env sequentially. Each triggers a separate `post_deploy_validation` run. If validation fails on env N, subsequent env validations are skipped (but all envs are already promoted — validation is observational, not a gate to promotion).

**Failure:** Stage fails, pipeline reports validation failure. Does NOT auto-rollback. Operator decides whether to rollback or investigate.

### 6.6 Rollback (Manual Trigger)

**Execution condition:** `when: condition: "false"` — never auto-executes. Operator triggers this stage manually from the Harness pipeline execution UI using "Run Selected Stage."

**Steps:**

1. **Resolve previous release** — Read `PREV_RELEASE_<env>` output variables from stage 3. If no previous release exists (first-ever promotion to this env), fail with a clear message.

2. **Clone deploy repo** — Fresh clone of `main`.

3. **Run `promote-release.sh`** — `scripts/promote-release.sh <prev_release> <target_envs...>`. Re-promotes the previous release.

4. **Commit and push** — Commit message:

   ```
   rollback(<target_envs>): revert to <prev_release> from <release_name>

   Pipeline: <execution_url>
   [skip ci]
   ```

5. **Wait for sync** — Same health endpoint polling as stage 4.

**Failure:** Operator must investigate manually. The previous release artifact is immutable and known-good (it was deployed before), so `promote-release.sh` failure here would indicate an infrastructure issue.

## 7. Infrastructure

All stages run on the existing CI Kubernetes cluster:

| Setting       | Value                    |
| ------------- | ------------------------ |
| Connector     | `ABL_AKS_Dev`            |
| Namespace     | `default`                |
| Node selector | `workload: ci`           |
| Toleration    | `workload=ci:NoSchedule` |
| OS            | Linux                    |

**Container images:**

- Stages 1, 3, 6 (git + scripts): `alpine/git:2.45.2` with `python3`, `py3-pip`, `helm`, `yq`, `openssh-client` installed at runtime. Alternatively, a pre-built CI image with these tools.
- Stage 4 (health polling): `alpine:3.19` with `curl`.
- Stage 5 (validation): N/A — triggers another pipeline.

**Secrets:**

- `abl-platform-ssh-file-key` — SSH key for pushing to `abl-platform-deploy` (same secret used by ci-build.yaml's "Update Dev Deploy" stage).

## 8. Git Operations

The pipeline clones the deploy repo, modifies files, and pushes. Key behaviors:

- **Branch:** Always `main`. QA (`QA` branch) is excluded.
- **Commit author:** `Harness CI <ci@kore.ai>` (matches existing CI convention).
- **Push retry:** 3 attempts with `git pull --rebase` between retries (matches existing CI pattern).
- **`[skip ci]` tag:** Prevents the deploy repo push from triggering any CI loops.
- **Atomic safety:** `prepare-release.sh` and `promote-release.sh` both use temp-file-rename patterns for atomic writes. A crash mid-script leaves files untouched.

## 9. Extending to New Environments

To add a new environment (e.g. `sit`, `prod-us`):

1. Scaffold the env in the deploy repo: `scripts/scaffold-env.sh`.
2. Add the env's ArgoCD ApplicationSet pointing at `main`.
3. Add the env's domain to the URL registry in the pipeline YAML (the case statement in stages 4 and 6).
4. The env is immediately available as a `target_envs` value.

No pipeline structural changes needed — the stages iterate over whatever `target_envs` the operator provides.

## 10. Security Considerations

- SSH key for deploy repo push is stored in Harness secrets (not in pipeline YAML).
- Approval gate prevents unauthorized promotions.
- `prepare-release.sh` validates chart tarball integrity via sha256 digest.
- `promote-release.sh` validates via `helm template` before applying.
- `release.lock.yaml` provides a per-env audit trail.
- Commit messages include pipeline execution URL for traceability.

## 11. Failure Modes

| Failure point                       | Impact                                         | Recovery                                        |
| ----------------------------------- | ---------------------------------------------- | ----------------------------------------------- |
| `prepare-release.sh` fails          | No release created, no env modified            | Fix source env, re-run pipeline                 |
| Approval rejected/timeout           | Pipeline stops, no env modified                | Re-run pipeline                                 |
| `promote-release.sh` fails on env N | Envs 1..N-1 promoted, env N untouched          | Fix env N's values, re-run (earlier envs no-op) |
| Push to main fails after 3 retries  | Promotion applied locally but not pushed       | Manual push or re-run                           |
| Health check timeout                | Promotion applied, ArgoCD may still be syncing | Check ArgoCD UI, rollback if needed             |
| Validation fails                    | Promotion applied, tests failed                | Operator decides: investigate or rollback       |
| Rollback fails                      | Previous release is known-good                 | Infrastructure issue — manual investigation     |

## 12. Relationship to Existing Pipelines

| Pipeline                      | Role                               | Interaction                                                                 |
| ----------------------------- | ---------------------------------- | --------------------------------------------------------------------------- |
| `ci-build.yaml`               | Builds images, auto-deploys to dev | No interaction. Promotion pipeline reads dev's state after CI has deployed. |
| `post-deploy-validation.yaml` | Deep integration + E2E tests       | Triggered as child pipeline by stage 5.                                     |
| `ci-pr-auto.yaml`             | PR automation                      | No interaction.                                                             |
| `ci-pr-cancel.yaml`           | Cancel stale PRs                   | No interaction.                                                             |

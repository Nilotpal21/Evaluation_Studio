# Promotion Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a Harness pipeline YAML that automates release promotion from lower to higher environments with approval gates, post-deploy validation, and one-click rollback.

**Architecture:** Single pipeline file (`.harness/pipelines/promote-release.yaml`) with 6 sequential stages. The pipeline clones the deploy repo (`abl-platform-deploy`), runs existing bash scripts (`prepare-release.sh`, `promote-release.sh`), and pushes results to the deploy repo's `main` branch. No new scripts or code — purely pipeline orchestration of existing tooling.

**Tech Stack:** Harness CI pipeline YAML, shell scripts, existing deploy repo scripts (Python + ruamel.yaml + jsonschema + helm)

---

## File Map

| Action | File                                      | Responsibility                |
| ------ | ----------------------------------------- | ----------------------------- |
| Create | `.harness/pipelines/promote-release.yaml` | The entire promotion pipeline |

This is a single-file implementation. All logic lives in the pipeline YAML's inline shell commands.

---

### Task 1: Pipeline Skeleton — Header, Variables, Infrastructure

**Files:**

- Create: `.harness/pipelines/promote-release.yaml`

This task creates the pipeline file with the header metadata, all 5 input variables, tags, and the shared infrastructure block pattern. No stages yet — just the skeleton that every stage will follow.

- [ ] **Step 1: Create the pipeline file with header + variables**

Create `.harness/pipelines/promote-release.yaml` with:

```yaml
pipeline:
  name: Promote Release
  identifier: promote_release
  projectIdentifier: ABLPlatform
  orgIdentifier: default
  description: |
    Promotes an immutable release artifact from a source environment to one or
    more target environments. Orchestrates prepare-release.sh and
    promote-release.sh from the deploy repo, with approval gates, post-deploy
    validation, and one-click rollback.

    Usage: trigger manually, select source env, target env(s), and release name.
  tags:
    pipeline_type: promotion
    trigger: manual
  variables:
    - name: source_env
      type: String
      description: 'Environment to snapshot the release from.'
      required: false
      default: 'dev'
      value: <+input>.default(dev).allowedValues(dev,staging)
    - name: target_envs
      type: String
      description: 'Comma-separated target envs (main-branch only, e.g. staging, staging,sit).'
      required: true
      default: 'staging'
      value: <+input>.default(staging)
    - name: release_name
      type: String
      description: 'Release name. Leave empty to auto-generate as release-YYYY-MM-DD-<source_env>.'
      required: false
      default: ''
      value: <+input>.default()
    - name: skip_validation
      type: String
      description: 'Set to true to skip post-deploy validation (emergency hotfix mode).'
      required: false
      default: 'false'
      value: <+input>.default(false).allowedValues(true,false)
    - name: approval_timeout
      type: String
      description: 'How long to wait for approval before auto-rejecting (e.g. 4h, 1h, 30m).'
      required: false
      default: '4h'
      value: <+input>.default(4h)
  properties:
    ci:
      codebase:
        connectorRef: ablplatformconnector
        repoName: abl-platform
        build: <+input>
  stages: []

  allowStageExecutions: true
```

- [ ] **Step 2: Verify the file is valid YAML**

Run: `python3 -c "import yaml; yaml.safe_load(open('.harness/pipelines/promote-release.yaml'))" && echo "Valid YAML"`
Expected: `Valid YAML`

- [ ] **Step 3: Commit**

```bash
git add .harness/pipelines/promote-release.yaml
git commit -m "[ABLP-XXX] feat(ci): add promote-release pipeline skeleton"
```

---

### Task 2: Stage 1 — Prepare Release

**Files:**

- Modify: `.harness/pipelines/promote-release.yaml`

This stage clones the deploy repo, auto-generates a release name if needed, runs `prepare-release.sh`, captures previous release locks for each target env, builds a human-readable tag diff, commits the release artifact, and exports output variables for downstream stages.

- [ ] **Step 1: Add the Prepare Release stage**

Replace the `stages: []` line with the full stage definition. The stage has two steps: a GitClone step and a Run step.

```yaml
stages:
  # ── Stage 1: Prepare Release ───────────────────────────────────────
  - stage:
      name: Prepare Release
      identifier: prepare_release
      type: CI
      spec:
        cloneCodebase: false
        infrastructure:
          type: KubernetesDirect
          spec:
            connectorRef: ABL_AKS_Dev
            namespace: default
            automountServiceAccountToken: true
            nodeSelector:
              workload: ci
            tolerations:
              - key: workload
                operator: Equal
                value: ci
                effect: NoSchedule
            os: Linux
        execution:
          steps:
            - step:
                type: GitClone
                name: Clone Deploy Repo
                identifier: clone_deploy_repo
                timeout: 5m
                spec:
                  connectorRef: ablplatformconnector
                  repoName: abl-platform-deploy
                  build:
                    type: branch
                    spec:
                      branch: main
                  cloneDirectory: /harness/deploy
            - step:
                type: Run
                name: Prepare Release Artifact
                identifier: prepare_release_artifact
                timeout: 10m
                spec:
                  connectorRef: Docker
                  image: alpine/git:2.45.2
                  shell: Sh
                  command: |
                    set -eu
                    (set -o pipefail) 2>/dev/null && set -o pipefail

                    # ── Install dependencies ──
                    apk add --no-cache python3 py3-pip py3-ruamel.yaml py3-jsonschema yq openssh-client curl
                    # Install helm
                    curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | sh

                    SOURCE_ENV="<+pipeline.variables.source_env>"
                    TARGET_ENVS="<+pipeline.variables.target_envs>"
                    RELEASE_NAME="<+pipeline.variables.release_name>"

                    cd /harness/deploy

                    # ── Auto-generate release name if empty ──
                    if [ -z "$RELEASE_NAME" ] || [ "$RELEASE_NAME" = "null" ]; then
                      BASE="release-$(date -u +%Y-%m-%d)-${SOURCE_ENV}"
                      RELEASE_NAME="$BASE"
                      COUNTER=2
                      while [ -f "releases/${RELEASE_NAME}.yaml" ]; do
                        RELEASE_NAME="${BASE}-${COUNTER}"
                        COUNTER=$((COUNTER + 1))
                      done
                      echo "Auto-generated release name: ${RELEASE_NAME}"
                    fi

                    # ── Validate release name format ──
                    if ! echo "$RELEASE_NAME" | grep -qE '^[A-Za-z0-9][A-Za-z0-9._-]*$'; then
                      echo "ERROR: Invalid release name: '${RELEASE_NAME}'"
                      echo "Must match: ^[A-Za-z0-9][A-Za-z0-9._-]*$"
                      exit 1
                    fi

                    # ── Capture previous release locks before any changes ──
                    PREV_RELEASES=""
                    for env in $(echo "$TARGET_ENVS" | tr ',' ' '); do
                      LOCK_FILE="environments/${env}/release.lock.yaml"
                      if [ -f "$LOCK_FILE" ]; then
                        PREV=$(yq '.metadata.release' "$LOCK_FILE")
                        echo "Previous release for ${env}: ${PREV}"
                      else
                        PREV="none"
                        echo "No previous release lock for ${env}"
                      fi
                      PREV_RELEASES="${PREV_RELEASES}${env}=${PREV},"
                    done
                    PREV_RELEASES="${PREV_RELEASES%,}"

                    # ── Run prepare-release.sh ──
                    echo ""
                    echo "=== Preparing release '${RELEASE_NAME}' from '${SOURCE_ENV}' ==="
                    scripts/prepare-release.sh "$RELEASE_NAME" "$SOURCE_ENV"

                    # ── Build tag diff summary ──
                    echo ""
                    echo "=== Tag diff summary ==="
                    TAG_DIFF=""
                    # Extract image tags from the new release
                    RELEASE_FILE="releases/${RELEASE_NAME}.yaml"
                    IMAGE_COUNT=$(yq '.spec.images | length' "$RELEASE_FILE")
                    for env in $(echo "$TARGET_ENVS" | tr ',' ' '); do
                      TAG_DIFF="${TAG_DIFF}--- ${env} ---\n"
                      i=0
                      while [ "$i" -lt "$IMAGE_COUNT" ]; do
                        IMG_NAME=$(yq ".spec.images[${i}].name" "$RELEASE_FILE")
                        IMG_TAG=$(yq ".spec.images[${i}].tag" "$RELEASE_FILE")
                        # Get current tag in target env (if exists)
                        VALUES_FILE="environments/${env}/values.yaml"
                        PREFIX='"abl-platform-stack"."abl-platform"'
                        # Convert dotted name to yq path
                        YQ_PATH=$(echo "$IMG_NAME" | sed 's/\./"."/g')
                        CUR_TAG=$(yq ".${PREFIX}.\"${YQ_PATH}\".image.tag // \"(unset)\"" "$VALUES_FILE" 2>/dev/null || echo "(unset)")
                        if [ "$CUR_TAG" != "$IMG_TAG" ]; then
                          TAG_DIFF="${TAG_DIFF}  ${IMG_NAME}: ${CUR_TAG} -> ${IMG_TAG}\n"
                        fi
                        i=$((i + 1))
                      done
                    done
                    echo -e "$TAG_DIFF"

                    # ── Commit the release artifact ──
                    git config user.name "Harness CI"
                    git config user.email "ci@kore.ai"

                    # Setup SSH for push
                    mkdir -p ~/.ssh && chmod 700 ~/.ssh
                    trap 'rm -f ~/.ssh/id_rsa' EXIT
                    echo '<+secrets.getValue("abl-platform-ssh-file-key")>' > ~/.ssh/id_rsa
                    chmod 600 ~/.ssh/id_rsa
                    ssh-keyscan -H bitbucket.org >> ~/.ssh/known_hosts 2>/dev/null

                    git add "releases/${RELEASE_NAME}.yaml"
                    git commit -m "release: prepare ${RELEASE_NAME} from ${SOURCE_ENV}

                    Pipeline: <+pipeline.executionUrl>
                    [skip ci]"

                    # Push with retry
                    MAX_RETRIES=3
                    for attempt in $(seq 1 $MAX_RETRIES); do
                      if git push origin main; then
                        echo "Release artifact pushed"
                        break
                      fi
                      if [ "$attempt" -eq "$MAX_RETRIES" ]; then
                        echo "ERROR: Push failed after $MAX_RETRIES attempts"
                        exit 1
                      fi
                      echo "Push failed — pulling and retrying ($attempt/$MAX_RETRIES)..."
                      git pull --rebase origin main
                    done

                    # ── Export output variables ──
                    # Harness output variable syntax
                    echo "RELEASE_NAME=${RELEASE_NAME}" > /harness/deploy/.promote_outputs
                    echo "PREV_RELEASES=${PREV_RELEASES}" >> /harness/deploy/.promote_outputs
                    # Escape newlines for Harness output
                    TAG_DIFF_ESCAPED=$(echo -e "$TAG_DIFF" | tr '\n' '|')
                    echo "TAG_DIFF=${TAG_DIFF_ESCAPED}" >> /harness/deploy/.promote_outputs
                  outputVariables:
                    - name: RELEASE_NAME
                      type: String
                      value: RELEASE_NAME
                    - name: PREV_RELEASES
                      type: String
                      value: PREV_RELEASES
                    - name: TAG_DIFF
                      type: String
                      value: TAG_DIFF
                  envVariables:
                    HOME: /root
                  resources:
                    limits:
                      memory: 2Gi
                      cpu: '1'
      failureStrategies:
        - onFailure:
            errors:
              - AllErrors
            action:
              type: Abort
```

**Key design decisions:**

- The release artifact is committed and pushed in this stage (not stage 3) because `promote-release.sh` needs the release file to exist with a git SHA for the lock file's `releaseFileGitSha` field.
- Previous release locks are captured _before_ any mutation so the rollback stage has context.
- Tag diff is computed by comparing the release YAML against each target env's current values.
- Output variables use Harness's `outputVariables` mechanism so downstream stages can reference them via `<+pipeline.stages.prepare_release.spec.execution.steps.prepare_release_artifact.output.outputVariables.RELEASE_NAME>`.

- [ ] **Step 2: Verify YAML is valid**

Run: `python3 -c "import yaml; yaml.safe_load(open('.harness/pipelines/promote-release.yaml'))" && echo "Valid YAML"`
Expected: `Valid YAML`

- [ ] **Step 3: Commit**

```bash
git add .harness/pipelines/promote-release.yaml
git commit -m "[ABLP-XXX] feat(ci): add prepare-release stage to promotion pipeline"
```

---

### Task 3: Stage 2 — Approval Gate

**Files:**

- Modify: `.harness/pipelines/promote-release.yaml`

Add the Harness approval stage after the Prepare Release stage. This shows the operator what's about to be promoted and requires explicit approval.

- [ ] **Step 1: Add the Approval stage**

Append after the `prepare_release` stage in the `stages` array:

```yaml
# ── Stage 2: Approval Gate ─────────────────────────────────────────
- stage:
    name: Approval Gate
    identifier: approval_gate
    type: Approval
    spec:
      execution:
        steps:
          - step:
              type: HarnessApproval
              name: Approve Promotion
              identifier: approve_promotion
              timeout: <+pipeline.variables.approval_timeout>
              spec:
                approverInputs: []
                approvers:
                  userGroups:
                    - platform-leads
                  minimumCount: 1
                  disallowPipelineExecutor: false
                approvalMessage: |-
                  Promoting release '<+pipeline.stages.prepare_release.spec.execution.steps.prepare_release_artifact.output.outputVariables.RELEASE_NAME>' from <+pipeline.variables.source_env> to <+pipeline.variables.target_envs>.

                  Previous releases: <+pipeline.stages.prepare_release.spec.execution.steps.prepare_release_artifact.output.outputVariables.PREV_RELEASES>

                  Approve to proceed with promotion.
                includePipelineExecutionHistory: true
    failureStrategies:
      - onFailure:
          errors:
            - AllErrors
          action:
            type: Abort
```

**Notes:**

- `timeout` uses the pipeline variable `approval_timeout` (default `4h`). On timeout, the step fails and the Abort failure strategy stops the pipeline.
- `disallowPipelineExecutor: false` — the person who triggered the pipeline CAN also approve it. Set to `true` if you want four-eyes separation.
- `platform-leads` is the Harness user group ID. This must match an existing user group in the Harness project.

- [ ] **Step 2: Verify YAML is valid**

Run: `python3 -c "import yaml; yaml.safe_load(open('.harness/pipelines/promote-release.yaml'))" && echo "Valid YAML"`
Expected: `Valid YAML`

- [ ] **Step 3: Commit**

```bash
git add .harness/pipelines/promote-release.yaml
git commit -m "[ABLP-XXX] feat(ci): add approval gate stage to promotion pipeline"
```

---

### Task 4: Stage 3 — Promote & Push

**Files:**

- Modify: `.harness/pipelines/promote-release.yaml`

This stage clones the deploy repo fresh (post-approval, so it has the latest `main` including the release artifact committed in stage 1), runs `promote-release.sh`, commits the promoted env files, and pushes.

- [ ] **Step 1: Add the Promote & Push stage**

Append after the `approval_gate` stage:

```yaml
# ── Stage 3: Promote & Push ────────────────────────────────────────
- stage:
    name: Promote and Push
    identifier: promote_and_push
    type: CI
    spec:
      cloneCodebase: false
      infrastructure:
        type: KubernetesDirect
        spec:
          connectorRef: ABL_AKS_Dev
          namespace: default
          automountServiceAccountToken: true
          nodeSelector:
            workload: ci
          tolerations:
            - key: workload
              operator: Equal
              value: ci
              effect: NoSchedule
          os: Linux
      execution:
        steps:
          - step:
              type: GitClone
              name: Clone Deploy Repo
              identifier: clone_deploy_repo_promote
              timeout: 5m
              spec:
                connectorRef: ablplatformconnector
                repoName: abl-platform-deploy
                build:
                  type: branch
                  spec:
                    branch: main
                cloneDirectory: /harness/deploy
          - step:
              type: Run
              name: Run Promote Release
              identifier: run_promote_release
              timeout: 15m
              spec:
                connectorRef: Docker
                image: alpine/git:2.45.2
                shell: Sh
                command: |
                  set -eu
                  (set -o pipefail) 2>/dev/null && set -o pipefail

                  # ── Install dependencies ──
                  apk add --no-cache python3 py3-pip py3-ruamel.yaml py3-jsonschema yq openssh-client curl
                  curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | sh

                  RELEASE_NAME="<+pipeline.stages.prepare_release.spec.execution.steps.prepare_release_artifact.output.outputVariables.RELEASE_NAME>"
                  SOURCE_ENV="<+pipeline.variables.source_env>"
                  TARGET_ENVS="<+pipeline.variables.target_envs>"

                  cd /harness/deploy

                  # ── Validate inputs ──
                  if [ -z "$RELEASE_NAME" ] || [ "$RELEASE_NAME" = "null" ]; then
                    echo "ERROR: RELEASE_NAME is empty or null"
                    exit 1
                  fi
                  if [ -z "$TARGET_ENVS" ] || [ "$TARGET_ENVS" = "null" ]; then
                    echo "ERROR: TARGET_ENVS is empty or null"
                    exit 1
                  fi

                  # Verify release file exists (was pushed in stage 1)
                  if [ ! -f "releases/${RELEASE_NAME}.yaml" ]; then
                    echo "ERROR: Release file not found: releases/${RELEASE_NAME}.yaml"
                    echo "This should have been created and pushed in the Prepare Release stage."
                    exit 1
                  fi

                  # ── Run promote-release.sh ──
                  echo ""
                  echo "=== Promoting ${RELEASE_NAME} to ${TARGET_ENVS} ==="
                  # Convert comma-separated to space-separated args
                  TARGET_ARGS=$(echo "$TARGET_ENVS" | tr ',' ' ')
                  scripts/promote-release.sh "$RELEASE_NAME" $TARGET_ARGS

                  # ── Commit and push ──
                  git config user.name "Harness CI"
                  git config user.email "ci@kore.ai"

                  # Setup SSH
                  mkdir -p ~/.ssh && chmod 700 ~/.ssh
                  trap 'rm -f ~/.ssh/id_rsa' EXIT
                  echo '<+secrets.getValue("abl-platform-ssh-file-key")>' > ~/.ssh/id_rsa
                  chmod 600 ~/.ssh/id_rsa
                  ssh-keyscan -H bitbucket.org >> ~/.ssh/known_hosts 2>/dev/null

                  # Stage all modified env files
                  for env in $TARGET_ARGS; do
                    git add "environments/${env}/"
                  done

                  CHANGED=$(git diff --cached --name-only)
                  if [ -z "$CHANGED" ]; then
                    echo "No changes — environments already at this release (no-op)"
                    exit 0
                  fi

                  echo "Files to commit:"
                  echo "$CHANGED"

                  git commit -m "deploy(${TARGET_ENVS}): promote ${RELEASE_NAME}

                  Source: ${SOURCE_ENV}
                  Pipeline: <+pipeline.executionUrl>
                  [skip ci]"

                  # Push with retry
                  MAX_RETRIES=3
                  for attempt in $(seq 1 $MAX_RETRIES); do
                    if git push origin main; then
                      echo "Push succeeded"
                      break
                    fi
                    if [ "$attempt" -eq "$MAX_RETRIES" ]; then
                      echo "ERROR: Push failed after $MAX_RETRIES attempts"
                      exit 1
                    fi
                    echo "Push failed — pulling and retrying ($attempt/$MAX_RETRIES)..."
                    git pull --rebase origin main
                  done
                envVariables:
                  HOME: /root
                resources:
                  limits:
                    memory: 2Gi
                    cpu: '1'
    failureStrategies:
      - onFailure:
          errors:
            - AllErrors
          action:
            type: Abort
```

- [ ] **Step 2: Verify YAML is valid**

Run: `python3 -c "import yaml; yaml.safe_load(open('.harness/pipelines/promote-release.yaml'))" && echo "Valid YAML"`
Expected: `Valid YAML`

- [ ] **Step 3: Commit**

```bash
git add .harness/pipelines/promote-release.yaml
git commit -m "[ABLP-XXX] feat(ci): add promote-and-push stage to promotion pipeline"
```

---

### Task 5: Stage 4 — Wait for ArgoCD Sync

**Files:**

- Modify: `.harness/pipelines/promote-release.yaml`

Polls health endpoints for each target env until pods are live after ArgoCD syncs.

- [ ] **Step 1: Add the Wait for Sync stage**

Append after the `promote_and_push` stage:

```yaml
# ── Stage 4: Wait for ArgoCD Sync ──────────────────────────────────
- stage:
    name: Wait for ArgoCD Sync
    identifier: wait_for_sync
    type: CI
    spec:
      cloneCodebase: false
      infrastructure:
        type: KubernetesDirect
        spec:
          connectorRef: ABL_AKS_Dev
          namespace: default
          automountServiceAccountToken: true
          nodeSelector:
            workload: ci
          tolerations:
            - key: workload
              operator: Equal
              value: ci
              effect: NoSchedule
          os: Linux
      execution:
        steps:
          - step:
              type: Run
              name: Poll Health Endpoints
              identifier: poll_health_endpoints
              timeout: 15m
              spec:
                connectorRef: Docker
                image: alpine:3.19
                shell: Sh
                command: |
                  set -eu
                  apk add --no-cache curl

                  TARGET_ENVS="<+pipeline.variables.target_envs>"
                  MAX_WAIT=600    # 10 minutes
                  POLL_INTERVAL=30

                  # ── Environment URL registry ──
                  get_domain() {
                    case "$1" in
                      dev)     echo "agents-dev.kore.ai" ;;
                      staging) echo "agents-staging.kore.ai" ;;
                      # Add new envs here:
                      # sit)     echo "agents-sit.kore.ai" ;;
                      # prod)    echo "agents-prod.kore.ai" ;;
                      *)
                        echo "ERROR: Unknown environment '${1}' — add it to the URL registry in promote-release.yaml" >&2
                        return 1
                        ;;
                    esac
                  }

                  FAILED=0
                  for env in $(echo "$TARGET_ENVS" | tr ',' ' '); do
                    DOMAIN=$(get_domain "$env") || { FAILED=1; continue; }
                    HEALTH_URL="https://${DOMAIN}/api/health"

                    echo ""
                    echo "=== Waiting for ${env} (${HEALTH_URL}) ==="
                    ELAPSED=0
                    HEALTHY=0

                    while [ "$ELAPSED" -lt "$MAX_WAIT" ]; do
                      HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 "$HEALTH_URL" 2>/dev/null || echo "000")
                      if [ "$HTTP_CODE" = "200" ]; then
                        echo "  ${env}: healthy (HTTP ${HTTP_CODE}) after ${ELAPSED}s"
                        HEALTHY=1
                        break
                      fi
                      echo "  ${env}: not ready (HTTP ${HTTP_CODE}), waiting ${POLL_INTERVAL}s... (${ELAPSED}/${MAX_WAIT}s)"
                      sleep "$POLL_INTERVAL"
                      ELAPSED=$((ELAPSED + POLL_INTERVAL))
                    done

                    if [ "$HEALTHY" -eq 0 ]; then
                      echo "  ERROR: ${env} did not become healthy within ${MAX_WAIT}s"
                      FAILED=1
                    fi
                  done

                  if [ "$FAILED" -eq 1 ]; then
                    echo ""
                    echo "ERROR: One or more environments failed health check"
                    exit 1
                  fi

                  echo ""
                  echo "All target environments are healthy"
                resources:
                  limits:
                    memory: 256Mi
                    cpu: '0.5'
    failureStrategies:
      - onFailure:
          errors:
            - AllErrors
          action:
            type: MarkAsFailure
```

**Note:** Failure strategy is `MarkAsFailure` (not `Abort`) so the pipeline continues to show the rollback stage as available even if health checks fail.

- [ ] **Step 2: Verify YAML is valid**

Run: `python3 -c "import yaml; yaml.safe_load(open('.harness/pipelines/promote-release.yaml'))" && echo "Valid YAML"`
Expected: `Valid YAML`

- [ ] **Step 3: Commit**

```bash
git add .harness/pipelines/promote-release.yaml
git commit -m "[ABLP-XXX] feat(ci): add wait-for-sync stage to promotion pipeline"
```

---

### Task 6: Stage 5 — Post-Deploy Validation

**Files:**

- Modify: `.harness/pipelines/promote-release.yaml`

Triggers the existing `post_deploy_validation` pipeline with the target env's URLs. Uses Harness pipeline chaining.

- [ ] **Step 1: Add the Post-Deploy Validation stage**

Append after the `wait_for_sync` stage:

```yaml
# ── Stage 5: Post-Deploy Validation ────────────────────────────────
- stage:
    name: Post-Deploy Validation
    identifier: post_deploy_validation_trigger
    type: Pipeline
    when:
      pipelineStatus: Success
      condition: <+pipeline.variables.skip_validation> != "true"
    spec:
      org: default
      pipeline: post_deploy_validation
      project: ABLPlatform
      inputs:
        identifier: post_deploy_validation
        variables:
          - name: environment_name
            type: String
            value: <+pipeline.variables.target_envs>
          - name: studio_url
            type: String
            value: <+pipeline.stages.wait_for_sync.spec.execution.steps.poll_health_endpoints.output.outputVariables.VALIDATION_BASE_URL>
          - name: runtime_api_url
            type: String
            value: <+pipeline.stages.wait_for_sync.spec.execution.steps.poll_health_endpoints.output.outputVariables.VALIDATION_BASE_URL>
          - name: search_ai_url
            type: String
            value: <+pipeline.stages.wait_for_sync.spec.execution.steps.poll_health_endpoints.output.outputVariables.VALIDATION_SEARCH_AI_URL>
          - name: search_ai_runtime_url
            type: String
            value: <+pipeline.stages.wait_for_sync.spec.execution.steps.poll_health_endpoints.output.outputVariables.VALIDATION_SEARCH_AI_RUNTIME_URL>
          - name: admin_url
            type: String
            value: <+pipeline.stages.wait_for_sync.spec.execution.steps.poll_health_endpoints.output.outputVariables.VALIDATION_BASE_URL>
          - name: login_email
            type: String
            value: developer@kore.ai
          - name: run_deep_integration
            type: String
            value: 'true'
          - name: run_studio_live_e2e
            type: String
            value: 'true'
          - name: run_admin_playwright
            type: String
            value: 'false'
        properties:
          ci:
            codebase:
              build:
                type: branch
                spec:
                  branch: main
    failureStrategies:
      - onFailure:
          errors:
            - AllErrors
          action:
            type: MarkAsFailure
```

- [ ] **Step 2: Update stage 4 to export URL output variables**

The validation stage needs URLs derived from the env registry. Add output variable exports at the end of stage 4's shell script (before the "All target environments are healthy" message). These capture the _first_ target env's URLs for the validation pipeline:

Add these lines to the `poll_health_endpoints` step's command, just before the final success message:

```sh
                      # ── Export URLs for validation stage ──
                      # Use the first target env for validation
                      FIRST_ENV=$(echo "$TARGET_ENVS" | tr ',' ' ' | awk '{print $1}')
                      FIRST_DOMAIN=$(get_domain "$FIRST_ENV")
                      BASE_URL="https://${FIRST_DOMAIN}"

                      # Harness output variables
                      export VALIDATION_BASE_URL="$BASE_URL"
                      export VALIDATION_SEARCH_AI_URL="${BASE_URL}/api/search-ai"
                      export VALIDATION_SEARCH_AI_RUNTIME_URL="${BASE_URL}/api/search-ai-runtime"
```

And add `outputVariables` to the step spec:

```yaml
outputVariables:
  - name: VALIDATION_BASE_URL
    type: String
    value: VALIDATION_BASE_URL
  - name: VALIDATION_SEARCH_AI_URL
    type: String
    value: VALIDATION_SEARCH_AI_URL
  - name: VALIDATION_SEARCH_AI_RUNTIME_URL
    type: String
    value: VALIDATION_SEARCH_AI_RUNTIME_URL
```

- [ ] **Step 3: Verify YAML is valid**

Run: `python3 -c "import yaml; yaml.safe_load(open('.harness/pipelines/promote-release.yaml'))" && echo "Valid YAML"`
Expected: `Valid YAML`

- [ ] **Step 4: Commit**

```bash
git add .harness/pipelines/promote-release.yaml
git commit -m "[ABLP-XXX] feat(ci): add post-deploy validation stage to promotion pipeline"
```

---

### Task 7: Stage 6 — Rollback (Manual Trigger)

**Files:**

- Modify: `.harness/pipelines/promote-release.yaml`

The rollback stage never auto-executes. Operator triggers it manually from the Harness execution UI. It reads the previous release from stage 1's output, re-promotes it, and waits for sync.

- [ ] **Step 1: Add the Rollback stage**

Append after the `post_deploy_validation_trigger` stage:

```yaml
# ── Stage 6: Rollback (manual trigger only) ───────────────────────
- stage:
    name: Rollback
    identifier: rollback
    type: CI
    when:
      pipelineStatus: All
      condition: 'false'
    spec:
      cloneCodebase: false
      infrastructure:
        type: KubernetesDirect
        spec:
          connectorRef: ABL_AKS_Dev
          namespace: default
          automountServiceAccountToken: true
          nodeSelector:
            workload: ci
          tolerations:
            - key: workload
              operator: Equal
              value: ci
              effect: NoSchedule
          os: Linux
      execution:
        steps:
          - step:
              type: GitClone
              name: Clone Deploy Repo
              identifier: clone_deploy_repo_rollback
              timeout: 5m
              spec:
                connectorRef: ablplatformconnector
                repoName: abl-platform-deploy
                build:
                  type: branch
                  spec:
                    branch: main
                cloneDirectory: /harness/deploy
          - step:
              type: Run
              name: Rollback to Previous Release
              identifier: rollback_to_previous
              timeout: 15m
              spec:
                connectorRef: Docker
                image: alpine/git:2.45.2
                shell: Sh
                command: |
                  set -eu
                  (set -o pipefail) 2>/dev/null && set -o pipefail

                  # ── Install dependencies ──
                  apk add --no-cache python3 py3-pip py3-ruamel.yaml py3-jsonschema yq openssh-client curl
                  curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | sh

                  RELEASE_NAME="<+pipeline.stages.prepare_release.spec.execution.steps.prepare_release_artifact.output.outputVariables.RELEASE_NAME>"
                  PREV_RELEASES="<+pipeline.stages.prepare_release.spec.execution.steps.prepare_release_artifact.output.outputVariables.PREV_RELEASES>"
                  TARGET_ENVS="<+pipeline.variables.target_envs>"

                  cd /harness/deploy

                  # ── Parse previous releases ──
                  # Format: "staging=release-2026-04-30,sit=release-2026-04-29"
                  echo "=== Rollback context ==="
                  echo "Current release: ${RELEASE_NAME}"
                  echo "Previous releases: ${PREV_RELEASES}"
                  echo "Target envs: ${TARGET_ENVS}"

                  # Use the first target env's previous release for rollback
                  # (all target envs were promoted from the same release in this run)
                  FIRST_ENV=$(echo "$TARGET_ENVS" | tr ',' ' ' | awk '{print $1}')
                  PREV_RELEASE=""
                  for entry in $(echo "$PREV_RELEASES" | tr ',' ' '); do
                    ENTRY_ENV=$(echo "$entry" | cut -d= -f1)
                    ENTRY_REL=$(echo "$entry" | cut -d= -f2)
                    if [ "$ENTRY_ENV" = "$FIRST_ENV" ]; then
                      PREV_RELEASE="$ENTRY_REL"
                      break
                    fi
                  done

                  if [ -z "$PREV_RELEASE" ] || [ "$PREV_RELEASE" = "none" ]; then
                    echo "ERROR: No previous release found for ${FIRST_ENV}"
                    echo "Cannot rollback — this was the first promotion to this environment."
                    exit 1
                  fi

                  # Verify the previous release file exists
                  if [ ! -f "releases/${PREV_RELEASE}.yaml" ]; then
                    echo "ERROR: Previous release file not found: releases/${PREV_RELEASE}.yaml"
                    exit 1
                  fi

                  # ── Run promote-release.sh with the previous release ──
                  echo ""
                  echo "=== Rolling back to ${PREV_RELEASE} ==="
                  TARGET_ARGS=$(echo "$TARGET_ENVS" | tr ',' ' ')
                  scripts/promote-release.sh "$PREV_RELEASE" $TARGET_ARGS

                  # ── Commit and push ──
                  git config user.name "Harness CI"
                  git config user.email "ci@kore.ai"

                  mkdir -p ~/.ssh && chmod 700 ~/.ssh
                  trap 'rm -f ~/.ssh/id_rsa' EXIT
                  echo '<+secrets.getValue("abl-platform-ssh-file-key")>' > ~/.ssh/id_rsa
                  chmod 600 ~/.ssh/id_rsa
                  ssh-keyscan -H bitbucket.org >> ~/.ssh/known_hosts 2>/dev/null

                  for env in $TARGET_ARGS; do
                    git add "environments/${env}/"
                  done

                  CHANGED=$(git diff --cached --name-only)
                  if [ -z "$CHANGED" ]; then
                    echo "No changes — already at previous release (no-op)"
                    exit 0
                  fi

                  git commit -m "rollback(${TARGET_ENVS}): revert to ${PREV_RELEASE} from ${RELEASE_NAME}

                  Pipeline: <+pipeline.executionUrl>
                  [skip ci]"

                  MAX_RETRIES=3
                  for attempt in $(seq 1 $MAX_RETRIES); do
                    if git push origin main; then
                      echo "Rollback pushed"
                      break
                    fi
                    if [ "$attempt" -eq "$MAX_RETRIES" ]; then
                      echo "ERROR: Push failed after $MAX_RETRIES attempts"
                      exit 1
                    fi
                    echo "Push failed — pulling and retrying ($attempt/$MAX_RETRIES)..."
                    git pull --rebase origin main
                  done

                  # ── Wait for sync ──
                  echo ""
                  echo "=== Waiting for ArgoCD sync after rollback ==="
                  get_domain() {
                    case "$1" in
                      dev)     echo "agents-dev.kore.ai" ;;
                      staging) echo "agents-staging.kore.ai" ;;
                      *)       echo ""; return 1 ;;
                    esac
                  }

                  MAX_WAIT=600
                  POLL_INTERVAL=30
                  for env in $TARGET_ARGS; do
                    DOMAIN=$(get_domain "$env") || { echo "WARN: Unknown env ${env}, skipping health check"; continue; }
                    HEALTH_URL="https://${DOMAIN}/api/health"
                    echo "Polling ${HEALTH_URL}..."
                    ELAPSED=0
                    while [ "$ELAPSED" -lt "$MAX_WAIT" ]; do
                      HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 "$HEALTH_URL" 2>/dev/null || echo "000")
                      if [ "$HTTP_CODE" = "200" ]; then
                        echo "  ${env}: healthy after ${ELAPSED}s"
                        break
                      fi
                      echo "  ${env}: not ready (HTTP ${HTTP_CODE}), waiting... (${ELAPSED}/${MAX_WAIT}s)"
                      sleep "$POLL_INTERVAL"
                      ELAPSED=$((ELAPSED + POLL_INTERVAL))
                    done
                    if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
                      echo "  WARN: ${env} did not become healthy within ${MAX_WAIT}s"
                    fi
                  done

                  echo ""
                  echo "Rollback complete"
                envVariables:
                  HOME: /root
                resources:
                  limits:
                    memory: 2Gi
                    cpu: '1'
    failureStrategies:
      - onFailure:
          errors:
            - AllErrors
          action:
            type: MarkAsFailure
```

- [ ] **Step 2: Verify YAML is valid**

Run: `python3 -c "import yaml; yaml.safe_load(open('.harness/pipelines/promote-release.yaml'))" && echo "Valid YAML"`
Expected: `Valid YAML`

- [ ] **Step 3: Commit**

```bash
git add .harness/pipelines/promote-release.yaml
git commit -m "[ABLP-XXX] feat(ci): add rollback stage to promotion pipeline"
```

---

### Task 8: Final Assembly & Validation

**Files:**

- Modify: `.harness/pipelines/promote-release.yaml`

Verify the complete pipeline YAML is valid and all stage references resolve correctly.

- [ ] **Step 1: Validate complete YAML structure**

Run: `python3 -c "import yaml; yaml.safe_load(open('.harness/pipelines/promote-release.yaml'))" && echo "Valid YAML"`
Expected: `Valid YAML`

- [ ] **Step 2: Verify stage count and order**

Run:

```bash
python3 -c "
import yaml
with open('.harness/pipelines/promote-release.yaml') as f:
    p = yaml.safe_load(f)
stages = p['pipeline']['stages']
for i, s in enumerate(stages):
    key = 'stage' if 'stage' in s else list(s.keys())[0]
    name = s[key].get('name', 'unknown')
    ident = s[key].get('identifier', 'unknown')
    print(f'Stage {i+1}: {name} ({ident})')
print(f'Total: {len(stages)} stages')
"
```

Expected output:

```
Stage 1: Prepare Release (prepare_release)
Stage 2: Approval Gate (approval_gate)
Stage 3: Promote and Push (promote_and_push)
Stage 4: Wait for ArgoCD Sync (wait_for_sync)
Stage 5: Post-Deploy Validation (post_deploy_validation_trigger)
Stage 6: Rollback (rollback)
Total: 6 stages
```

- [ ] **Step 3: Verify cross-stage references**

Check that output variable references in stages 2, 3, 5, and 6 point to valid stage/step identifiers:

```bash
grep -n 'pipeline.stages\.' .harness/pipelines/promote-release.yaml | head -20
```

Every reference should follow the pattern:
`<+pipeline.stages.prepare_release.spec.execution.steps.prepare_release_artifact.output.outputVariables.VARIABLE_NAME>`

Verify:

- Stage 2 (approval) references `prepare_release` stage → `prepare_release_artifact` step → `RELEASE_NAME`, `PREV_RELEASES`
- Stage 3 (promote) references `prepare_release` stage → `prepare_release_artifact` step → `RELEASE_NAME`
- Stage 5 (validation) references `wait_for_sync` stage → `poll_health_endpoints` step → `VALIDATION_BASE_URL`, `VALIDATION_SEARCH_AI_URL`, `VALIDATION_SEARCH_AI_RUNTIME_URL`
- Stage 6 (rollback) references `prepare_release` stage → `prepare_release_artifact` step → `RELEASE_NAME`, `PREV_RELEASES`

- [ ] **Step 4: Verify `allowStageExecutions: true`**

This must be `true` for the rollback stage's manual trigger to work (Harness "Run Selected Stage" feature).

Run: `grep 'allowStageExecutions' .harness/pipelines/promote-release.yaml`
Expected: `  allowStageExecutions: true`

- [ ] **Step 5: Final commit**

```bash
git add .harness/pipelines/promote-release.yaml
git commit -m "[ABLP-XXX] feat(ci): finalize promote-release pipeline"
```

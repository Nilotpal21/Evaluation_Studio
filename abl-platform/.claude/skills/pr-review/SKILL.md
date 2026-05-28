---
name: pr-review
description: Review a pull request given a PR number or URL. Create an isolated pr-number worktree, pull the PR into it, copy each per-app env file from the project's main checkout, audit the change layer by layer across code quality, security, encryption, tenant and project isolation, stale or duplicate code, tests, and UX/UI, then build, launch, run tests, and report findings plus build or test failures. Optionally enter a fix loop that triages findings, applies fixes one commit per finding, rebases onto the PR base, re-verifies build and tests, and pushes with --force-with-lease. Always stops launched services at the end. Accept additional review gates from user input. Project-specific values (repo host, base branch, monorepo apps, package globs, ticket key, etc.) are resolved per-project — do not hardcode them.
---

# PR Review

Use this skill when the user asks to review a PR and provides a PR number, PR URL, or both.

The skill has two phases:

- **Phase A — Review (steps 1-10):** read-only audit. Always runs.
- **Phase B — Fix Loop (steps 11-16):** opt-in. Triages findings, applies fixes, rebases, re-verifies, and pushes. Only runs when the user explicitly authorizes it after seeing the Phase A report.
- **Step 17 — Cleanup:** always runs at the end of either phase.

## Inputs

- PR number or PR URL
- Optional extra review gates from the user

If only one of PR number or URL is given, infer the other when possible. If neither is clear, ask one short question before continuing.

## Project Configuration

Before running the workflow, resolve these project-scoped variables. Discover them on first run and cache them for the duration of the review. **Do not hardcode any of them** — use the discovery command, fall back to the listed default only when discovery fails, and surface unresolved variables in the report.

| Variable                 | What it is                                                                    | Discovery                                                                                                                                     | Fallback                      |
| ------------------------ | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `{{REPO_HOST}}`          | Hosting provider (`github`/`bitbucket`/`gitlab`)                              | `git remote get-url origin` (parse host)                                                                                                      | ask user                      |
| `{{REPO_SLUG}}`          | `<org>/<repo>` for the API path                                               | parse from `origin` URL                                                                                                                       | ask user                      |
| `{{PR_API}}`             | API path for PR data                                                          | host-specific: GitHub `repos/{slug}/pulls/<n>`; Bitbucket `repositories/{slug}/pullrequests/<n>`; GitLab `projects/{slug}/merge_requests/<n>` | —                             |
| `{{BASE_BRANCH}}`        | Default comparison base                                                       | from PR data; else `git symbolic-ref refs/remotes/origin/HEAD`                                                                                | `main`                        |
| `{{PKG_MGR}}`            | `pnpm`/`npm`/`yarn`/`bun`/none                                                | lockfile presence (`pnpm-lock.yaml` etc.)                                                                                                     | none                          |
| `{{NODE_VERSION}}`       | Node toolchain                                                                | `.nvmrc`, `package.json#engines.node`, `volta`                                                                                                | system `node -v`              |
| `{{MONOREPO_APPS}}`      | App workspaces with their own envs                                            | `pnpm m ls --depth=-1 --json` filtered to `apps/*`; or `package.json#workspaces`                                                              | empty list                    |
| `{{ENV_FILES}}`          | Per-app dotenv files copied from main checkout                                | for each app, list `.env*` files actually tracked or referenced in the app's start scripts                                                    | none                          |
| `{{PLATFORM_PKG_GLOBS}}` | Internal package globs (used in mock/import lints, e.g. `@org/*`, `@scope/*`) | scan top-level `package.json#name` prefixes inside `packages/`                                                                                | none                          |
| `{{TEST_CMD}}`           | Repo test command                                                             | `package.json#scripts.test`                                                                                                                   | `pnpm test`                   |
| `{{BUILD_CMD}}`          | Repo build command                                                            | `package.json#scripts.build`                                                                                                                  | `pnpm build`                  |
| `{{INSTALL_CMD}}`        | Lockfile-frozen install                                                       | `pnpm install --frozen-lockfile` / `npm ci` / `yarn install --frozen-lockfile` / `bun install --frozen-lockfile`                              | —                             |
| `{{TICKET_KEY_REGEX}}`   | Issue-tracker key pattern in commit/PR titles                                 | from `CLAUDE.md` JIRA section, repo `.gitlint`, or commit history                                                                             | `[A-Z]+-\d+`                  |
| `{{TICKET_PROJECT}}`     | Default project key when one must be created                                  | `CLAUDE.md` / repo config                                                                                                                     | ask user                      |
| `{{RUBRIC_PATH}}`        | Path to the project's review rubric (rubric concern numbers)                  | search for `change-review-rubric.md` under `docs/`                                                                                            | omit `(rubric N)` annotations |
| `{{MODULE_POLICY_PATH}}` | Per-path module policy (criticality, required suites/commands)                | search for `helix.verification.yaml` or equivalent at repo root                                                                               | skip step 6g; use defaults    |
| `{{DOMAIN_GATES_PATH}}`  | Project-specific domain gates that extend the universal core                  | `references/default-gates.md` "Project-Specific Gates" section                                                                                | none                          |

Record resolved values once, near the start of the review. Treat any unresolved variable as a verification gap — do not silently substitute the example values from this document.

## Default Gates

Always review against the default gates in [references/default-gates.md](references/default-gates.md), then append any additional gates the user explicitly asks for. The "Project-Specific Gates" section of that file is where each project plugs in its own domain gates — keep the universal core gates intact and override only the project-specific section per repo.

The default set has **eight always-applicable** mandatory gates plus a configurable number of **trigger-conditional** gates (six in this repo's defaults). Every report MUST give an explicit `PASS` / `FAIL` / `UNVERIFIED (<reason>)` verdict for each mandatory gate, even when nothing was found; trigger-conditional gates additionally accept `N/A (<reason>)` when their trigger does not apply. When the project provides a review rubric at `{{RUBRIC_PATH}}` (e.g. `docs/sdlc/change-review-rubric.md`), each gate annotates its `rubric_concern: N` for cross-tool reconciliation; when no rubric is configured, drop the `(rubric N)` annotations.

**Always-applicable (8):**

1. `functional-regression` (rubric 6) — callers, shared contracts, runtime behavior, route ordering, migrations, build graph, regression tests, blast-radius statement
2. `security` (rubric 8) — auth, permission checks, input validation, secret handling, encryption, injection vectors, rate limiting, **PII pass-through surfaces** (`pii-passthrough` sub-check)
3. `isolation` (rubric 1) — tenant, project, user, and session-source scoping; non-leaky `404`; cache/queue isolation; fail-closed defaults
4. `stale-or-duplicate-code` (rubric 6) — dead code, duplicates, partially migrated flows, unwired code, additive-only feature commits
5. `cross-pod` (rubric 11) — pod-local state vs shared state, distributed locks, cache scoping, stateful handler recovery
6. `audit-log` (rubric 10) — `TraceEvent` / audit-log emission on sensitive ops with structured payload and failure-path coverage
7. `boundary-metadata` (rubric 2) — reserved transport keys, per-message metadata validation at entry, sliding-window invariants, versioned protocol shims
8. `wiring-reachability` (rubric 12) — production-entry-point trace for new surfaces; "implemented" must equal "reachable"

**Trigger-conditional (10, emit `N/A` when trigger does not apply):**

9. `coverage-matrix` (rubric 16) — code↔test-spec mapping; `N/A` only for pure infra/refactor PRs
10. `durable-execution` (rubric 4) — replay-safety rules for whatever durable-execution framework the project uses (Restate, Temporal, Inngest, etc.); `N/A` when PR does not touch any durable-execution code (resolve trigger paths from `{{DOMAIN_GATES_PATH}}`)
11. `agent-transfer` (rubric 4) — adapter session-end / disposition; `N/A` unless project-specific transfer/handoff paths touched (resolve from `{{DOMAIN_GATES_PATH}}`)
12. `customer-contact` (rubric 3) — identity precedence, cross-channel reuse, channel-artifact normalization; `N/A` unless contact/identity/channel paths touched
13. `design-system` (rubric 13) — semantic tokens, no hardcoded palette, no native form controls where wrapped components exist, token-pairing rules; `N/A` for PRs that don't touch design-system-governed UI
14. `import-export-roundtrip` (rubric 7) — lossless export→import→export, manifest stability, redaction round-trip; `N/A` unless project IO/manifest/schema paths touched
15. `reliability` (rubric 9) — timeout enforcement on outbound calls, retry/backoff correctness, circuit-breaking for optional dependencies, graceful degradation per dependency, idempotency of retried operations; `N/A` for PRs touching no outbound calls, queue producers/consumers, or cross-service integrations
16. `scalability` (rubric 11) — N+1 query detection, unbounded result sets without pagination, index coverage for new query filters, hot-path synchronous I/O, in-memory structure growth without eviction; `N/A` for PRs touching no DB queries, list endpoints, or hot-path handlers
17. `observability` (rubric 10) — metrics emission on new high-frequency paths, health-check registration for new workers/services, trace context propagation on outbound calls, structured log level correctness, error rate trackability; `N/A` for PRs introducing no new services, workers, or high-frequency endpoints
18. `data-lifecycle` (rubric 1) — tenant-delete cascade for new collections, PII erasure compliance for new personal data fields, retention TTL for ephemeral data, index lifecycle correctness; `N/A` for PRs touching no DB models, no new fields, and no deletion handlers

See [references/default-gates.md](references/default-gates.md) for the full check list under each gate plus the **advisory triage** concerns (`clean-contracts`, `reasoning-flow-parity`, `studio-wiring`, `studio-api-wiring`, `omnichannel`, `scale`, `localization`, `onboarding-ux`, `form-submission-resilience`, `ux-design`, `docs-examples-consistency`) which produce `option_A/B/C` triage cards rather than blocking verdicts.

## Workflow

### 1. Normalize PR context

The goal of this step is to obtain four facts about the PR: **base branch**, **source/head branch name**, **source repository** (so fork PRs can be fetched correctly), and **PR author email** (Phase B needs this). The PR number alone is not enough on hosts where PR refs are not exposed via `git ls-remote` (Bitbucket Cloud being the most common case in this stack — `refs/pull-requests/<n>/head` is **opt-in** per repo and not configured by default).

1. Extract the PR number.
2. Resolve `{{REPO_HOST}}`, `{{REPO_SLUG}}`, `{{PR_API}}` per **Project Configuration**.
3. **Try, in order, until one returns the four facts. Stop at the first success.**

   **A. Host-specific MCP, when configured.** Check the project's `.mcp.json` / Claude Code settings for an MCP server matching the host:
   - GitHub: `mcp__github-api__*` or `gh` CLI.
   - Bitbucket: `mcp__bitbucket-api__bb_get` against `repositories/{slug}/pullrequests/<n>` (and `…/diffstat` for changed files).
   - GitLab: a GitLab MCP, or `glab` CLI.
   - Read: title, base branch (`destination.branch.name` on Bitbucket; `baseRefName` on GitHub), head branch (`source.branch.name` / `headRefName`), source repository (`source.repository.full_name` / `headRepository.nameWithOwner` — used to detect fork PRs), changed-files summary.

   **B. Direct REST API with credentials, when no MCP is configured.** Try in this order — first that authenticates wins:
   - GitHub: `gh api repos/{slug}/pulls/<n>` (uses `gh auth` token); or `curl -H "Authorization: token $GITHUB_TOKEN"`.
   - Bitbucket Cloud: `curl -u "$BITBUCKET_USERNAME:$BITBUCKET_APP_PASSWORD" https://api.bitbucket.org/2.0/repositories/{slug}/pullrequests/<n>`; or workspace access token (`Authorization: Bearer $BITBUCKET_WORKSPACE_TOKEN`). **Do not** try `$JIRA_API_TOKEN` / `$ATLASSIAN_API_KEY` against `api.bitbucket.org` — Atlassian Jira/Confluence tokens do not authenticate Bitbucket Cloud (different identity provider). It will return 401 and waste a round-trip.
   - GitLab: `curl -H "PRIVATE-TOKEN: $GITLAB_TOKEN" https://gitlab.example.com/api/v4/projects/{slug-encoded}/merge_requests/<n>`.

   **C. PR URL parsing as last fallback.** If the user supplied a PR URL (not just a number), the head branch is sometimes derivable from the URL or a referenced commit. This is fragile — verify before using.

   **D. Ask the user once.** If A, B, and C all fail, **stop and ask the user to paste the source branch name** (and, when relevant, "is this PR from a fork?"). Do not flail through speculative `git fetch origin refs/pull-requests/<n>/{head,from,merge}` attempts — those refs are not exposed by default on Bitbucket Cloud and produce noisy `fatal: couldn't find remote ref` errors.

4. **Cross-host gotchas — do not do these:**
   - Do not use `gh pr view` on Bitbucket or GitLab; it is GitHub-only and will fail.
   - Do not assume `refs/pull-requests/<n>/{head,from,merge}` exists on Bitbucket; the PR-ref hook is admin-opt-in and is not enabled on this repo (`{{REPO_SLUG}}`).
   - Do not try a Jira API token against `api.bitbucket.org`; it returns 401.
5. Default the comparison base to the PR's base branch. If that cannot be determined, fall back to `{{BASE_BRANCH}}`.
6. Record `<base>`, `<head-ref>`, `<source-repo>` (= `{{REPO_SLUG}}` for same-repo PRs, otherwise the fork's `<owner>/<repo>`), and the PR author email — Phase B (fix loop) needs all four.

**Setup hint to surface to the user when path B fails on Bitbucket:** the cleanest long-term fix is to either (a) install a Bitbucket Cloud MCP server, or (b) add `BITBUCKET_USERNAME` and `BITBUCKET_APP_PASSWORD` to `.env` (Bitbucket → Personal settings → App passwords → grant `Pull requests: read` and `Repositories: read`). With either in place, this skill resolves PR context automatically on every future review.

### 2. Create or reuse an isolated worktree

1. Work from the main checkout root.
2. Use worktree path `.worktrees/pr-<number>`.
3. Prefer a detached worktree by default. Create a local branch only when the repository rules allow branch creation and the user has explicitly approved it.
4. If the worktree already exists, reuse it unless the user asks for a fresh one.
5. Avoid changing the user's current checkout.
6. Immediately switch the shell into the PR worktree before continuing:

```bash
cd .worktrees/pr-<number>
```

7. After entering the worktree, run all subsequent review commands from that worktree by default.
   - If the tool supports `workdir`, set it to `.worktrees/pr-<number>`.
   - If the tool does not support a persistent working directory, prefix the command with `cd .worktrees/pr-<number> && ...`.
   - Only run later commands from the repo root when the task specifically requires it.

Fetch the PR head into a review-owned local ref `refs/pr-review/pr-<number>`. **Prerequisite:** step 1 must have resolved `<head-ref>` and `<source-repo>` already. If either is missing, return to step 1 and complete it (including its "ask the user" fallback) — **do not** speculatively try Bitbucket-style PR refs here, they are not default-exposed and the noise hides the real failure.

The fetch refspec is **host-specific** — pick the line that matches `{{REPO_HOST}}` from step 1. Also use the `source.repository` field from the PR API response (step 1) to detect fork PRs; on hosts where forks land in a separate repository, you must fetch from the fork remote, not `origin`.

```bash
# GitHub (origin = upstream repo):
git fetch origin pull/<number>/head:refs/pr-review/pr-<number>

# GitLab:
git fetch origin merge-requests/<number>/head:refs/pr-review/pr-<number>

# Bitbucket Cloud — PR opened from a branch in the same repo (most common):
#   <head-ref> = source.branch.name from step 1
git fetch origin <head-ref>:refs/pr-review/pr-<number>

# Bitbucket Cloud — PR opened from a fork (source.repository.full_name != destination's):
#   Add the fork as a temporary remote, fetch from it, then prune the remote.
git remote add pr-fork-<number> git@bitbucket.org:<source.repository.full_name>.git
git fetch pr-fork-<number> <head-ref>:refs/pr-review/pr-<number>
git remote remove pr-fork-<number>

# Then create the detached worktree from the review-owned ref (host-independent):
git worktree add --detach .worktrees/pr-<number> refs/pr-review/pr-<number>
```

Notes:

- Bitbucket exposes `refs/pull-requests/<number>/from` only if the repo admin enabled the PR-ref hook; do **not** rely on it as the default path.
- If the PR review ref already exists locally (e.g. you reviewed a previous version), fast-forward it non-interactively to the latest head SHA before review (`git fetch ... -f` is acceptable here only because `refs/pr-review/pr-<number>` is owned by this skill, not by the user).
- If the head SHA returned by the API doesn't match what `git rev-parse refs/pr-review/pr-<number>` shows after the fetch, stop and surface the mismatch — never review a stale ref.

### 2.5 Reconstruct a clean verification checkout when the local PR ref is noisy

Use this step when code review findings are clear from source inspection, but build or test attribution is noisy because the local PR ref appears to include unrelated merges, unexpected extra commits, or broader workspace breakage.

Signals that reconstruction is needed:

- the local `refs/pr-review/pr-<number>` ref contains merge commits or file changes that do not match the intended PR scope
- the worktree already points at a broad feature branch rather than the exact PR head
- build or test failures look plausibly caused by unrelated branch state instead of the PR diff

When that happens:

1. Resolve the exact PR base branch plus the exact base commit and head commit when possible.
2. Create a second detached worktree rooted at the PR base commit.
3. Apply the exact PR head on top of that base in the detached worktree before install, build, or test verification.
4. Use that reconstructed worktree for verification status so build and test results are attributable to the PR itself rather than to branch noise.
5. Keep the original diff-based review context, but report that verification came from a reconstructed checkout when you used one.

Preferred approach:

- use the exact PR base commit, not just the latest moving `{{BASE_BRANCH}}` tip, when the hosting provider exposes it
- prefer a detached worktree over creating a throwaway branch when repo policy is strict
- if reconstruction is not possible, say that build or test attribution remains uncertain instead of overstating confidence

### 2.6 Check base staleness (non-mutating)

Phase A stays read-only. Do **not** rebase — but report whether the PR ref is behind its base so reviewers can judge merge risk.

From inside the PR worktree:

```bash
git fetch origin <base>
# How far behind?
git rev-list --count HEAD..origin/<base>
# Direct ancestor of base? (exit 0 = up to date)
git merge-base --is-ancestor origin/<base> HEAD; echo $?
# Files that changed on base since the merge-base — potential conflict / drift surface
git diff --name-only $(git merge-base HEAD origin/<base>) origin/<base>
```

Rules:

- Never run `git rebase`, `git merge`, or `git pull` here. Mutation belongs in Phase B step 14.
- Record the count (e.g. "12 commits behind `{{BASE_BRANCH}}`") in the final report under "Residual risks".
- If any file in the diff against base also appears in the PR diff, flag a **likely rebase conflict** in the report — do not try to resolve it.
- If the PR is severely stale (e.g. >50 commits behind, or shared contracts touched on both sides), recommend the author rebase before merge.

### 3. Copy app env files from the main checkout

Copy each file in `{{ENV_FILES}}` from the main `{{BASE_BRANCH}}` checkout into the PR worktree when it exists. (`{{ENV_FILES}}` resolves per app in `{{MONOREPO_APPS}}`; for example a Node monorepo with `apps/studio`, `apps/runtime`, `apps/workflow-engine` resolves to `apps/<app>/.env` for each.)

Rules:

- Never print secret values.
- Never `source` the env files.
- If a destination file already exists, keep it unless the user asked to overwrite it.
- If a source env file is missing, note it in the review report.

**Verify after copy** — list the destination paths and confirm each one exists. For every entry in `{{ENV_FILES}}`:

```bash
ls .worktrees/pr-<number>/<env-file-path>
```

Any file missing here means the corresponding app **cannot launch** in step 8 and its E2E suite **cannot run** in step 9. Record each missing file as a launch-blocker (not just a passing note) so the preflight gate (step 7.5) catches it.

If `{{MONOREPO_APPS}}` is empty (single-app or non-monorepo repo), skip this step and note it in the report.

### 4. Hydrate the isolated worktree before builds or tests

Before treating missing-package or missing-generated-output errors as PR bugs, hydrate the PR worktree with a real install from the isolated checkout.

Use these commands from the worktree, pinning the toolchain to `{{NODE_VERSION}}` if the project specifies one. Detect the active toolchain manager and activate accordingly — do not assume `nvm`. The snippet below tries `volta` → `fnm` → `mise` → `asdf` → `nvm` in order and uses whichever is on `PATH`; if none is available it falls back to the shell's current `node`:

```bash
cd .worktrees/pr-<number>

# Resolve {{NODE_VERSION}} (read .nvmrc / package.json#engines.node / volta config)
NODE_VER="$(cat .nvmrc 2>/dev/null \
  || node -p "require('./package.json').engines?.node || require('./package.json').volta?.node || ''" 2>/dev/null \
  || true)"
# If it's a semver range (contains comparators), extract the lowest major
case "$NODE_VER" in *[\<\>=^~\ ]*) NODE_VER="$(printf '%s' "$NODE_VER" | grep -oE '[0-9]+' | head -1)" ;; esac

# Activate via whichever toolchain manager is installed
if   command -v volta >/dev/null 2>&1 && [ -n "$NODE_VER" ]; then volta install "node@$NODE_VER" >/dev/null && volta pin "node@$NODE_VER" >/dev/null
elif command -v fnm   >/dev/null 2>&1 && [ -n "$NODE_VER" ]; then eval "$(fnm env --use-on-cd)"; fnm use "$NODE_VER"
elif command -v mise  >/dev/null 2>&1 && [ -n "$NODE_VER" ]; then mise use "node@$NODE_VER"
elif command -v asdf  >/dev/null 2>&1 && [ -n "$NODE_VER" ]; then asdf install nodejs "$NODE_VER" 2>/dev/null; asdf shell nodejs "$NODE_VER"
elif [ -s "$HOME/.nvm/nvm.sh" ];                            then . "$HOME/.nvm/nvm.sh"; nvm use "${NODE_VER:-default}" >/dev/null
fi
node -v   # confirm the active version before continuing

{{INSTALL_CMD}}
```

If `node -v` doesn't match `{{NODE_VERSION}}` after activation, stop and surface the mismatch in the report — do not proceed with a wrong-toolchain install.

For full root verification after install, use:

```bash
cd .worktrees/pr-<number>
{{BUILD_CMD}}
{{TEST_CMD}}
```

Rules:

- Do not rely on a symlinked `node_modules` (or equivalent) from the main checkout as a substitute for a real worktree install.
- If filtered builds fail with missing workspace packages, missing `packages/*/dist` outputs, or broad `Cannot find module '<internal-pkg>'` errors (where `<internal-pkg>` matches `{{PLATFORM_PKG_GLOBS}}`), treat the worktree as unhydrated first and run the install step above before calling it a PR bug.
- If a framework-specific build fails before its compile step due to a sandboxing issue (e.g. `tsx` cannot open IPC pipes in a constrained shell), rerun the build in a normal/escalated environment before attributing the failure to the PR.
- If install succeeds but verification still looks polluted by broader branch state, fall back to the reconstructed base-plus-head checkout from step 2.5 before deciding whether the failures belong to the PR.

**Verify hydration succeeded** — before continuing past this step, confirm the install produced a usable dependency tree. Discover the test/build binaries actually used by the repo (don't hardcode):

```bash
# Each binary the repo's test/E2E pipeline depends on (derive from
# package.json#scripts; common candidates: vitest, jest, playwright,
# cypress, turbo, nx, mocha). Verify all of them resolve.
which -a <test-runner-binary>
ls .worktrees/pr-<number>/node_modules/.bin/<binary>
```

If a required binary is missing, hydration **failed** — do not proceed to build/launch/test. Surface the install error explicitly in the report ("worktree unhydrated, E2E suites cannot run") rather than silently degrading to a code-only review. A code-only review is acceptable when hydration genuinely cannot be done in this environment, but it MUST be flagged at the top of the report so the user knows verification is incomplete.

### 5. Read the PR scope before judging it

1. Get the file list from the PR diff.
2. Read the changed files plus the adjacent caller and callee files needed to understand wiring.
3. Read actual signatures before making claims about API misuse.
4. Review the change layer by layer, not just file by file.

Minimum review layers:

- API routes and request validation
- auth and permission middleware
- tenant, project, and user isolation filters
- services and business logic
- shared contracts, schemas, and field propagation
- runtime or workflow execution paths
- database models and persistence concerns
- Studio or UI surfaces, UX states, and accessibility
- tests and build wiring

### 6. Perform the code review

Findings come first. Focus on:

- correctness bugs
- security risks
- encryption at rest and in transport gaps
- tenant or project isolation leaks
- stale, dead, or duplicate code
- missing tests or misleading tests
- broken wiring or build assumptions
- UX or UI regressions

When reviewing:

- Prefer concrete findings over broad summaries.
- Verify whether changed routes include explicit `tenantId` and `projectId` filters where required.
- Check fail-closed behavior and non-leaky `404` behavior for isolation boundaries.
- Check transport and storage handling for secrets, certificates, tokens, and keys.
- Check whether E2E tests avoid mocking codebase components.
- Call out missing rollout, migration, or compatibility handling when relevant.

Use the default gates checklist in [references/default-gates.md](references/default-gates.md).

#### 6a. Mandatory gates — must be explicitly evaluated

The default gate set contains eight always-applicable gates and six trigger-conditional gates for this repo. Every always-applicable gate MUST receive an explicit verdict (`PASS`, `FAIL`, or `UNVERIFIED` with reason) in the final report. Every trigger-conditional gate MUST also be emitted explicitly and may use `N/A (<reason>)` when its trigger does not apply. Silence is not allowed. Do not skip a gate because the diff "looks small" — if an always-applicable gate has no finding, mark it `PASS` with a one-line justification.

1. **`functional-regression` — does this break other features?**
   - Identify every caller / consumer of changed functions, routes, schemas, events, and shared types. Use the repo's reference-finder of choice (LSP, `grep`/`rg`, or an MCP-provided lookup) to enumerate callers.
   - For each changed shared contract (any package matching `{{PLATFORM_PKG_GLOBS}}`, DTOs, Zod/typed schemas, queue payloads, DB models), confirm all consumers were updated or are still compatible.
   - For framework-specific runtime changes (e.g. prompt builders, model resolution, IR hashing, cache keys, session lifecycle — adapt to the project's runtime concepts), confirm existing executions still resolve correctly.
   - For new or reordered HTTP routes, confirm static routes are registered before parameterized routes (Express-style frameworks match top-down); new middleware does not break existing auth or tenant injection.
   - For migrations or schema changes, confirm a backwards-compatible read path and a rollback story.
   - For new workspace packages, confirm every container/build manifest that performs a frozen-lockfile install copies the new package's manifest. Discover the relevant container files via `git ls-files | grep -iE 'Dockerfile|Containerfile'` and any equivalent build manifests.
   - **Ranked-query ordering** (sub-label `ranked-query-ordering`): when a PR introduces a query method whose name implies ranking or ordering (`getTop*`, `getMost*`, `getSummary*`, `getBest*`, `getRecent*`, or any method returning a sorted/limited set), read the underlying query and verify results are explicitly ordered before the limit step. For SQL: `ORDER BY` must precede `LIMIT`. For Cypher (Neo4j): `collect()[..N]` has non-deterministic order — results need `ORDER BY` before `collect()` to guarantee ranking. A function called `getAttributeSummaries` or `getTopValues` that slices an unordered collection silently returns arbitrary items; tests pass because tests don't assert on ordering. Absence of `ORDER BY` before any `LIMIT` / slice in a ranking function = `FAIL`.
   - **Data-mapping completeness** (sub-label `data-mapping-completeness`): when a PR introduces or substantially modifies a builder or mapper function that constructs a typed output from a source schema (e.g. Nango provider config → `IntegrationProvider`, connector catalog entry → runtime auth shape, external provider metadata → OAuth2 params), verify that every semantically meaningful field in the source has an explicit corresponding assignment in the output. To check: (1) read the source type/interface; (2) list its fields with behavioral significance (scope separators, authorization/token params, audience, grant type variants, encoding flags, per-provider overrides); (3) grep the builder for each field name — if a field is absent from all assignments in the output object, or is covered only by a hardcoded fallback (`?? ' '`, `?? false`, `?? ''`) when the source config actually carries that field, that's a `FAIL`. A hardcoded fallback on a field the source controls silently diverges from the provider's intent for every new provider added after the initial implementation — it passes all existing tests because tests were written against the hardcoded value.
   - **Multi-step write atomicity** (sub-label `multi-step-atomicity`): for every handler that performs two or more sequential writes before returning (e.g. create AuthProfile → upsert ConnectorConnection bridge → call external token endpoint), trace the failure path at each intermediate step. If step N fails after writes at steps 1..N-1 have committed, verify the handler cleans up all previously-written records — scoped narrowly by `tenantId` and the operation-specific key — before surfacing the error to the caller. Ghost records (persisted for an operation that ultimately returned failure) create phantom entries visible to callers that were never formally created and cannot be managed through normal APIs. If cleanup itself can fail, the handler must surface that failure loudly rather than swallowing it. Any multi-step write path without cleanup-on-failure = `FAIL`.
   - **Shutdown sequence ordering** (sub-label `shutdown-sequence-ordering`): when a PR touches async teardown or `close()` / `shutdown()` methods in queue consumers, event consumers, or streaming service handlers, verify the ordering of close/flush/disconnect steps. The invariant: any writer or downstream processor that handles events delivered _during_ a queue/consumer `close()` call must remain open until after the final flush completes. The wrong order — writers.close() first, then queues.close(), then flush() — silently drops all events delivered to the queue during its own close sequence, because the writers that would process them are already gone. The correct order is: producers/consumers.close() → flush() → writers.close(). Read the teardown method and confirm this sequence. Any reversed ordering where writers are torn down before the final flush of events they would process = `FAIL`.
   - **DB query filter field path accuracy** (sub-label `db-filter-field-path`): when the diff adds or modifies Mongoose/ORM query filter objects (`.find()`, `.findOne()`, `.deleteMany()`, `.updateMany()`), verify every filter field key resolves to the actual schema location. The same invisible-bug pattern as `credential-field-path` applies to query filters: a filter `{ executionId: id }` when the field is stored at `source.executionId` is syntactically valid, passes TypeScript compilation, produces no runtime error, and silently matches zero documents — permanently leaving records that should have been cascaded. In Mongoose, dotted-string paths (`'source.executionId'`) and top-level keys (`executionId`) are semantically different: a top-level key matches only a top-level field. Read the model's schema definition for each model involved, locate the actual field path, and confirm the filter key matches. Any filter key that does not match the field's actual schema path = `FAIL`.
   - **Cascade deletion completeness** (sub-label `cascade-deletion-completeness`): when a PR adds or modifies a deletion handler for a parent entity (e.g. a cascade-delete hook, `pre('deleteOne')`, cleanup service, or event-driven cascade), enumerate all dependent collections that hold foreign-key references to that parent. For each collection, verify the handler includes a `deleteMany` (or equivalent) scoped by `tenantId` AND the parent's ID. Common omissions: outbox/event-log records keyed by `entityId`/`entityKind`, join table entries, child entity records, and per-entity cache entries. A parent delete that leaves orphaned children violates referential integrity: orphaned outbox records can trigger phantom event replays on restart; orphaned children create data bloat and incorrect aggregations. To check: grep the codebase for each model that holds a field named after the parent entity type (`executionId`, `projectId`, `agentId`, etc.) and confirm the cascade handler deletes from every matched model. Any dependent collection without a corresponding scoped delete = `FAIL`.
   - Produce an explicit **blast-radius statement**: list which existing features this PR could affect and how the reviewer verified each one. This is required output, not optional.

2. **`security` — is this safe?**
   - Every new route uses the project's centralized auth middleware (e.g. `createUnifiedAuthMiddleware` / `requireAuth`); no custom JWT verification outside the project's auth package.
   - Every protected handler enforces permissions via the project's permission helper (e.g. `requirePermission()` / `requireProjectPermission()`). Machine principals (API keys, platform keys) are authorized by explicit scope, never owner fallback.
   - Body schemas use `.strict()` (or framework-equivalent strict-mode). ID fields use plain string validation, not branded ID validators that assume a specific format.
   - No secrets, tokens, model IDs, or tenant IDs in user-visible error messages. Sanitizer helpers used.
   - No raw `console.*` in server code; use the project's structured logger.
   - Outbound fetches allowlist URLs; queries are parameterized; user HTML is escaped.
   - Tokens, keys, certificates, PEMs, OAuth refresh tokens, and API keys are encrypted at rest with the project's standard helpers.
   - New public endpoints have rate limits and authentication before any expensive work.
   - **PII in pass-through surfaces** (sub-label `pii-passthrough`): logs are not the only leak path. For every new field the PR introduces or starts forwarding, confirm classification + handling at each surface it crosses. Common pass-through surfaces (project-specific names will vary):
     - structured trace/event payloads in the project's trace store — redacted or class-tagged before storing
     - background-queue job payloads (BullMQ, Kafka, SQS, etc.) and cache values — encrypted at rest where required, scoped by tenant
     - outbound third-party API request bodies (e.g. LLM providers — system/user/tool messages, metadata, tool args) — no raw PII unless contract permits; honor any retention-boundary constraints
     - webhook bodies sent to tenant-configured URLs — explicit allowlist of fields, signature included
     - inter-service handoff metadata — reserved transport keys (e.g. `history`, `_meta`) must not leak into generic forwarded metadata
     - error responses returned to caller — sanitized; raw context only in logs
     - third-party telemetry / APM / debug-export channels
       When the diff introduces a new field crossing two or more of these surfaces, cross-reference a data-flow-audit (skill or equivalent) and call it out as a finding if no audit log exists. Verdict: any unredacted/unencrypted PII flowing through a pass-through surface = `FAIL`.
   - **auth/credential field path accuracy** (sub-label `credential-field-path`): when the diff contains conditional checks that gate re-authorization, credential invalidation, or force-reauth on a specific OAuth/auth field (e.g. "if client ID changed → force reauth"), cross-reference every field access path against the runtime schema definition. Verify the path resolves to where the field actually lives (e.g. `updates.secrets.clientId`, not `updates.config.clientId`). A check on the wrong path is syntactically valid, passes TypeScript compilation, produces no runtime error — it simply never fires when the real field changes, silently preserving a stale auth grant. Check the diff for `updates.config.*`, `updates.settings.*`, or any nested access on an auth-profile update object and confirm each one matches the actual schema layout. Any mismatch = `FAIL`. When the diff contains no auth/credential conditional checks, emit `credential-field-path: N/A`.
   - **auth-profile field propagation** (sub-label `auth-profile-propagation`): when the PR touches OAuth/auth-profile fields and the project provides a `data-propagation-audit` skill (or equivalent OAuth/auth-profile field-tracing tool), it MUST run before this gate can PASS. Steps: (1) invoke the audit against the PR diff; (2) include its findings in this report; (3) mark `security: FAIL — propagation audit not yet run` until the audit completes; (4) after audit, mark `security: PASS` or `security: FAIL — <HIGH/CRITICAL finding>` as appropriate. When the PR does not touch OAuth/auth-profile fields, mark this sub-check `N/A (no OAuth/auth-profile fields touched)`. When the project does not provide such a skill, mark this sub-check `N/A (no propagation audit configured)` and note it as a project setup gap, not a PR finding. Rationale: OAuth field propagation gaps (separator chars, auth/token params silently dropped at a serialization boundary, deprecated alias removal breaking shared-package consumers) are invisible to a surface-level code read and only surface when fields are traced end-to-end through schema → catalog → UI → OAuth round-trip layers.

3. **`isolation` — is scoping enforced?**
   - Every database query in changed code includes the tenant scope (e.g. `tenantId`). No "find by id" without tenant. Routes that lack ALS-style tenant injection (e.g. Next.js route handlers in some setups) scope explicitly.
   - Project-scoped routes filter by the project identifier and verify resource ownership before mutation.
   - User-owned resources filter by user identifier (e.g. `userId`/`createdBy`).
   - Session-derived resources dispatch on the session source — public/channel sessions use end-user identity; debug/UI sessions use project RBAC.
   - Cross-scope access returns `404`, never `403`.
   - Missing tenant/project context fails closed.
   - Redis keys, queue topics, and in-memory caches are scoped where appropriate.

4. **`stale-or-duplicate-code` — is the PR clean?**
   - Search the PR for unused exports, unreachable branches, orphaned files, commented-out blocks, leftover scaffolding, and unfilled TODO stubs.
   - Look for copy-pasted helpers, parallel implementations of the same flow, and duplicate DTOs / typed schemas / interfaces.
   - Flag old code paths still wired alongside new ones without a feature flag or removal plan; flag legacy compatibility shims that belong in a narrow rollout branch.
   - Confirm new functions / routes / components have a real caller, new workspace packages are added to every relevant container/build manifest, and new test files are picked up by the runner.
   - Flag any deleted exported symbol that still has consumers — feature commits must be additive.

If any mandatory gate is `FAIL`, the PR is **not ready to merge**, regardless of build and test status. Escalate it in the report. (`UNVERIFIED` and `N/A` do not block merge by themselves but must still appear with a reason.)

#### 6a-bis. Newly added gates — explicit checks

For each of the gates beyond the original six, run these checks and emit a verdict line.

**`cross-pod` (rubric 11) — always applicable**

- Search changed files for module-level mutable collections (`new Map(`, `new Set(`, language-specific equivalents). Any such collection used as state-of-record (not a bounded cache) is a `FAIL`.
- Distributed locking sites: search for the project's lock primitives (e.g. `SET NX`, `acquireLock`, `withLock`). Each must have a stable key, bounded TTL, and a release-on-exit path on every branch (including throw).
- Cache key construction: keys for tenant-scoped data must include the tenant identifier. Search the project's cache client calls (`redis.(set|get|hset)`, etc.) and confirm the key embeds the scope.
- New stateful handlers (queue worker, websocket handler) must have a recovery story documented in the diff or in the touched package's per-package learnings file (e.g. `agents.md` if the project uses one).
- **Singleton service connection guard** (sub-label `singleton-service-guard`): when a PR introduces or modifies a module-level singleton that wraps a stateful external connection (Neo4j, Redis, Mongo, external API client), check three things: (1) `isConnected()` / health check is more than `driver !== null` — it must detect stale connections after the service has been up and then lost; (2) every route/handler that uses the service guards with an availability check before calling into it, returning a graceful 503 rather than crashing with a raw TypeError; (3) if startup initialization is wrapped in try/warn/continue (optional service), the unconnected state reachable after a failed connect must not leave `_instance` set to an unconnected singleton — either reset `_instance = null` in the catch, or check `isConnected()` in the getter. Pattern "server continues past init failure + no guard at use sites" = `FAIL`.
- **Health flag pessimistic initialization** (sub-label `health-flag-initial-state`): when a PR introduces or modifies a service class with internal health or availability flags (`healthy`, `producerHealthy`, `consumerHealthy`, `connected`, `isReady`, etc.), verify the initial value is `false` (unhealthy until proven), never `true` (optimistic). A health flag initialized to `true` before the first successful operation causes the service to appear healthy to callers the moment the class is instantiated — before any connection, handshake, or subscription has been confirmed. If startup fails or is slow, traffic is routed to a service that has never proven connectivity, silently failing at the operational level with no error signal to the caller. Check: any `boolean` class field or constructor assignment whose name implies health/availability/connection state must initialize to `false`. An assignment of `= true` or `this.X = true` in a property initializer or constructor body, before the first confirmed connection event, = `FAIL`.

**`audit-log` (rubric 10) — always applicable**

- Enumerate sensitive ops touched: secret read/write, permission grant/revoke, role change, project/agent create/delete, export, import, deletion, OAuth grant, JIT auth, billing event.
- For each, locate the audit emission via the project's audit/trace API. Search for the project-specific symbols (e.g. `traceStore.`, `emitAudit`, `auditLog.`, `TraceEvent`) near the changed handler.
- Failure-path emission: deny / forbidden / 404 paths emit an audit entry with `outcome: 'denied'` (or equivalent). Silent denials = `FAIL`.
- Payload structure: scope identifiers (e.g. `tenantId`, `projectId`), actor identifier, `action`, `target`, `outcome`, stable `eventType`. Free-form audit messages = `FAIL`.

**`boundary-metadata` (rubric 2) — always applicable**

- Reserved-key search: in changed entry points (HTTP, WS, A2A, channel adapters), look for reserved transport keys leaking into generic metadata forwarding (`metadata.history`, `metadata._meta`, `metadata.__internal`, or any project-defined reserved key). Hits = `FAIL`.
- Per-message validation: every entry point validates the message-metadata shape via the project's schema validator (Zod, Pydantic, JSON Schema, etc.) before forwarding. Downstream consumers must not re-validate.
- Sliding-window invariants: search for unbounded growth patterns near conversation/event builders (e.g. `messages.push(`). Confirm bounded by sliding-window logic. Unbounded push = `FAIL`.
- Versioned protocol shims: SDK ↔ runtime compat code lives in a clearly labeled shim, not the steady-state typed contract.

**`wiring-reachability` (rubric 12) — always applicable**

- For every new public surface in the diff (routes, executors, handlers, UI pages, package exports), trace the import chain to a production entry point. Cite the `file:line` where it is mounted/imported/registered.
- New backend routes: confirm the mount in the project's primary entry file (e.g. `server.ts`, `app.ts`, `main.go`, `wsgi.py`) or its child router; confirm middleware order keeps static routes before parameterized ones (where the framework matches top-down).
- New file-system-routed surfaces (Next.js, Remix, SvelteKit, etc.): confirm the file path matches the URL the test exercises; confirm the route is reachable through the project's route-handler wrapper (e.g. `withRouteHandler` or equivalent).
- New UI components: confirm they're mounted in the app shell / settings nav / picker registries — not just exported from a barrel.
- Build-graph wiring: new workspace packages added to every container/build manifest that performs a frozen-lockfile install. New lint rules registered in the project's lint config (`eslint.config.*`, `.eslintrc.*`, `pyproject.toml`, etc.). New i18n keys present in every locale file the build verifies.
- "Implemented" without an integration/E2E test that hits the route through the production entry point is `FAIL`.

> The four gates below (`agent-transfer`, `customer-contact`, `design-system`, `import-export-roundtrip`) are **project-specific domain gates**. The triggers, paths, package names, and check details are illustrative — load the project's actual definitions from `{{DOMAIN_GATES_PATH}}` (default `references/default-gates.md` "Project-Specific Gates" section). When the project defines no equivalents, emit `N/A (no project-specific <gate> gate defined)` for each.

**`agent-transfer` (rubric 4) — trigger-conditional, project-specific**

- Trigger: PR diff touches the project's transfer/handoff packages or channel adapters (resolve from `{{DOMAIN_GATES_PATH}}`). If empty → `N/A`.
- Adapter `session_end` / `disposition` / `wrap-up` propagation: confirm the runtime, channel, and downstream analytics receive each event. Missing propagation = `FAIL`.
- Inline connection-config edits: confirm round-trip preserves redacted secret placeholders.
- Transfer correlation: outgoing requests carry stable correlation IDs; receiver maps back to the originating session.

**`customer-contact` (rubric 3) — trigger-conditional, project-specific**

- Trigger: PR diff touches the project's contact-identity, channel-connection, or omnichannel resolver paths (resolve from `{{DOMAIN_GATES_PATH}}`). If empty → `N/A`.
- Identity precedence: project's documented precedence order (commonly `contactId > customerId > anonymousId > channel artifact`) preserved.
- Cross-tenant safety: identity merge across channels never crosses tenants.
- Channel artifact normalization at ingress (e.g. Slack `team_id:app_id`, Email address-cased, WhatsApp E.164) — downstream code must not re-normalize.

**`design-system` (rubric 13) — trigger-conditional, project-specific**

- Trigger: PR diff touches UI files in the project's design-system-governed apps (resolve from `{{DOMAIN_GATES_PATH}}`; e.g. an app path glob like `apps/<ui-app>/**/*.{tsx,css}`). If empty → `N/A`.
- Hardcoded palette colors: search for raw Tailwind palette utilities (`bg-(blue|red|green|yellow|purple|pink|orange|gray|slate|zinc|neutral|stone)-[0-9]`, etc.) in changed files → `FAIL`.
- Native form controls where the project mandates components (e.g. `<select>` when the project provides a `<Select>` wrapper): hits in changed files → `FAIL`.
- Project-specific token mispairings (e.g. `bg-accent text-foreground` when the project requires `text-accent-foreground`): hits → `FAIL`.
- Verify project lint hooks (token-lint, foreground-lint, native-select-lint, etc.) ran on the PR's commits — if hooks were skipped via `--no-verify`, treat as `FAIL`.

**`import-export-roundtrip` (rubric 7) — trigger-conditional, project-specific**

- Trigger: PR diff touches the project's IO/manifest/schema packages (resolve from `{{DOMAIN_GATES_PATH}}`). If empty → `N/A`.
- Run the project's round-trip integration test (path/command in `{{DOMAIN_GATES_PATH}}`) and confirm the touched assets round-trip clean.
- Manifest version: any new field is additive and bumps the manifest version explicitly.
- Redaction round-trip: secrets exported as redacted placeholders re-import as redacted placeholders, never as plaintext.

**`reliability` (rubric 9) — trigger-conditional**

- Trigger: PR diff touches outbound HTTP/gRPC/WS calls, Kafka producers/consumers, BullMQ job producers, Redis client usage, or any cross-service integration. If none → `N/A`.
- **Timeout enforcement** (sub-label `reliability-timeout`): every outbound call (HTTP fetch, gRPC stub, Kafka producer send, Redis blocking command) carries an explicit timeout. No call that can block indefinitely without a deadline. Any `fetch(url)` / `client.send()` without a timeout option = `FAIL`.
- **Retry and backoff** (sub-label `reliability-retry`): transient failure handling uses exponential backoff with jitter; retries are bounded (max attempts + total timeout cap). Tight retry loops (`while(true) { try { } catch { continue; } }`) with no backoff or bound = `FAIL`.
- **Circuit breaking** (sub-label `reliability-circuit`): calls to downstream services that are optional or known to be unstable must use a circuit breaker or the platform's equivalent. Unguarded synchronous fan-out to an optional dependency that can cascade failures to callers = `FAIL`.
- **Graceful degradation** (sub-label `reliability-degradation`): for every external dependency the PR introduces or touches, verify what the system does when that dependency is unavailable. Acceptable: returns cached data, returns partial result, returns 503. Not acceptable: unhandled exception propagates to end-user, session crashes, or request hangs. Document the degradation strategy — "throws to caller" is not a strategy.
- **Idempotency of retried operations** (sub-label `reliability-idempotency`): operations that may be retried (queue message processing, webhook delivery, background job steps) must be idempotent or keyed by a stable idempotency key so duplicate delivery does not produce duplicate side effects (double-charge, double-send, double-write).

**`scalability` (rubric 11) — trigger-conditional**

- Trigger: PR diff touches DB query methods (`.find()`, `.findOne()`, `.aggregate()`, Cypher queries), list/search API endpoints, hot-path request handlers (called per session/message/request), or in-memory data structures that grow with load. If none → `N/A`.
- **N+1 query detection** (sub-label `scalability-n-plus-one`): search for loops that issue one DB query per iteration. Pattern: `for (const id of ids) { await Model.findById(id); }` when `Model.find({ _id: { $in: ids } })` is available. Check every `forEach`/`map`/`for...of` block in changed handlers for embedded query calls. Hits = `FAIL`.
- **Unbounded result sets** (sub-label `scalability-unbounded-results`): every new or modified `.find()` / list query must have an explicit `.limit()` or cursor-based pagination. A query returning O(n) documents proportional to tenant data size without a bound is a scalability cliff — passes in dev, fails in a mature tenant. `FAIL` unless the collection is provably small-and-fixed (e.g. a singleton config document).
- **Index coverage** (sub-label `scalability-index-coverage`): new query filter fields (added to `.find({ newField: value })`, Cypher `WHERE` clauses, or Mongoose `lean()` projections) must have a corresponding index in the schema definition or migration file. Read the model schema and confirm the field is indexed. An unindexed filter degrades from O(log n) to O(n) at scale = `FAIL`.
- **Hot-path synchronous I/O** (sub-label `scalability-hot-path`): CPU-intensive work (large JSON serialization, complex regex over unbounded strings, synchronous crypto) or blocking I/O in real-time session handlers (voice stream, message dispatch) must be offloaded to workers or bounded in wall-clock time. Flag any `await longRunningOp()` on the hot path without documented latency justification.
- **In-memory structure growth** (sub-label `scalability-memory-growth`): new `Map`, `Set`, or arrays that grow proportional to request volume or entity count without an explicit eviction strategy, TTL, or max-size cap = unbounded memory growth at scale = `FAIL`.
- **Connection pool exhaustion** (sub-label `scalability-connection-pool`): new code that opens a DB, Redis, Kafka, or external API connection inside a request handler (per-request connection creation) instead of drawing from a shared pool is a scalability cliff — every concurrent request holds a connection until the response finishes, exhausting the pool under load. Check: any `new MongoClient(uri)`, `new Redis(opts)`, `new Kafka()`, or HTTP agent construction inside a route handler or service method called per-request = `FAIL`. Connections must be established at startup, stored in a module-level singleton, and reused across requests. Also verify that explicit pool size limits are configured (not left at the driver's default, which is often 1 or 5) and documented in the service startup config.

**`observability` (rubric 10) — trigger-conditional**

- Trigger: PR introduces a new BullMQ/Kafka worker, new long-running service, new high-frequency endpoint (called per session or per message), or new background job. `N/A` for PRs touching only configuration, docs, tests, or low-frequency admin endpoints.
- **Metrics emission** (sub-label `observability-metrics`): new high-frequency paths (called >1/sec at production scale) must emit at least one structured metric (counter, histogram, or gauge) via the project's metrics client. Metric names must follow the project's naming convention and carry tenant/project labels. A path that only logs on error cannot support SLOs or alerts = `FAIL`.
- **Health check registration** (sub-label `observability-health`): new services and workers must register in the project's health check endpoint so the platform watchdog can observe them. An unregistered worker is invisible to monitoring — outages are detected by users, not by alerts = `FAIL`.
- **Trace context propagation** (sub-label `observability-trace`): outbound calls from new handlers must carry the incoming trace/correlation ID in the downstream request (HTTP header, Kafka message header, BullMQ job data). Dropped trace context breaks end-to-end tracing for every operation that crosses that boundary = `FAIL` for services in the critical session path.
- **Structured log levels** (sub-label `observability-log-levels`): new code must use the project's structured logger (`createLogger`, not `console.*`) at appropriate levels — `info` for expected ops, `warn` for recoverable anomalies, `error` only for unexpected failures. `error`-level logging on expected 4xx client errors floods alerting channels and desensitizes on-call engineers.
- **Error rate observability** (sub-label `observability-error-rate`): new error paths must increment a counter metric or emit a structured event that can feed an error-rate alert. Pure catch-and-log handling — with no counter — makes it impossible to detect systematic failures before they become production incidents. `FAIL` for services in the critical path.

**`data-lifecycle` (rubric 1) — trigger-conditional**

- Trigger: PR introduces new MongoDB models, adds new fields to existing models (especially fields holding user data), or modifies deletion/cleanup handlers. `N/A` for PRs touching no data model.
- **Tenant-delete cascade** (sub-label `data-lifecycle-tenant-delete`): new collections must be included in the project's tenant deletion handler. Grep for the tenant-delete service / cascade hook and confirm the new model has a corresponding `deleteMany({ tenantId })` call. A new collection not in the tenant-delete cascade accumulates orphaned data after tenant offboarding and violates GDPR/CCPA retention requirements = `FAIL`.
- **PII erasure compliance** (sub-label `data-lifecycle-pii-erasure`): new fields holding personal data (names, emails, phone numbers, addresses, free-text user content, contact identifiers, session transcripts) must be included in the project's data-erasure request processing (right-to-erasure). New PII fields without a documented erasure path in the erasure handler = `FAIL`.
- **Retention TTL for ephemeral data** (sub-label `data-lifecycle-ttl`): event-log records, outbox records, queue job results, audit events, and cache entries that are not the system of record must have a documented TTL or archival strategy. A collection that only grows (no TTL, no archive, no cleanup job) is both a scalability liability and a compliance risk at enterprise data volumes.
- **Index lifecycle** (sub-label `data-lifecycle-index`): new compound indexes must be ordered high-cardinality-first, low-cardinality-second. Indexes on high-write fields must justify their write-amplification cost. New partial indexes must be structured so they are actually selected by the queries they serve (compound field order matches query predicate order).

#### 6d. Reject-evidence rules — disqualify "passing" tests that prove nothing

A green test result is **not** evidence of correctness if any of these hold. When you find one, downgrade the related gate from `PASS` to `UNVERIFIED` (or `FAIL` if the violation is structural) and record the rejected evidence in the report.

| Anti-pattern                                                    | How to detect                                                                                                                                                                                                                                      | Reject because                                                                              |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Mocked codebase components in E2E tests                         | Search E2E test files for module-mock calls (`vi.mock`/`jest.mock`/equivalent) that target any glob in `{{PLATFORM_PKG_GLOBS}}` or any relative-path import.                                                                                       | E2E that mocks the platform tests the mocks, not the system.                                |
| Direct DB access in E2E assertions                              | Search E2E test files for direct database/ORM imports from `{{PLATFORM_PKG_GLOBS}}` data-layer packages followed by query calls (`.find(`, `.findOne(`, etc.).                                                                                     | Bypasses the public boundary the test claims to exercise.                                   |
| Green tests that never executed the touched module              | Run with `--coverage` and confirm coverage on the changed file > 0; absence = test does not exercise the change.                                                                                                                                   | A test passing without running the changed code is a coincidence, not coverage.             |
| Mock-only auth / isolation tests                                | Test asserts `expect(handler).toReturn(404)` against a stubbed middleware instead of a real `requireAuth` chain.                                                                                                                                   | Auth/isolation must be tested against the real middleware chain — mocking it tests nothing. |
| Tests added in the same commit as the fix without first failing | When a Phase B fix lands a test alongside, confirm the test was authored to the **failing** state first (red → green), not retrofitted to the green output. Look for a `before:` snapshot in the commit message or a separate failing-test commit. | Tests retrofitted to green can encode the bug as expected behavior.                         |

#### 6e. Characterize-first conditions — when to require a failing test before any fix

If any of these conditions hold for the touched code path, the report must require a **failing characterization test** to land before (or alongside) the fix. If the PR ships a fix without one of these characterizations, that's a `tests` finding even when the fix itself looks correct.

- No targeted regression suite maps to the touched files (use the `helix.verification.yaml` `suites` table — if no suite has the touched path in its `scope`, characterize first).
- Only mocked tests cover the touched behavior.
- The change crosses package boundaries without a known verification map.
- A critical module (per `helix.verification.yaml` `modulePolicies` `criticality: critical`) lacks real end-to-end coverage on the touched path.
- The bug being fixed has no reproduction script, only a description.

When characterize-first is required, the report cites this rule and the verdict is `tests: FAIL — characterize-first required, no failing test landed before the fix`.

#### 6f. Severity escalation triggers — auto-bump severity when the change touches sensitive surfaces

When the diff touches any of these surfaces, escalate the severity of related findings up by one level (LOW → MEDIUM → HIGH → CRITICAL) regardless of the line count or local impact assessment. These are surfaces where small mistakes have wide blast radius.

- Auth or isolation logic (`packages/shared-auth/**`, `requireAuth`, `requirePermission`, `withRouteHandler`, tenant/project filter helpers).
- Public contract or shared type changes (`packages/shared/src/{validation,errors,services}/**`, public SDK barrels, exported Zod schemas).
- Migrations or seed data (`packages/database/src/migrations/**`, seed scripts).
- Runtime startup or environment requirements (`apps/*/src/server.ts`, `apps/*/src/index.ts`, env validation, Docker entrypoint changes).
- Encryption or KMS plumbing.
- Restate handler version / step-name / payload-shape changes (already a `FAIL` under `durable-execution`, but the escalation makes the surrounding `code-quality` and `tests` findings HIGH minimum).
- Auth/credential conditional checks (`clientId`, `clientSecret`, `tokenUrl`, `authorizationUrl`, OAuth grant decisions, force-reauth flags) — escalates `credential-field-path` findings, because a wrong field path silently disables the entire security gate.
- Multi-step create/update handlers that touch connector bridges, auth profiles, or external token endpoints in sequence — escalates `multi-step-atomicity` findings, because ghost records in auth state cannot be self-healed by callers.
- Builder/mapper functions that construct OAuth2 params, provider metadata, or connector auth shapes from upstream source configs (Nango, catalog entries, external provider registries) — escalates `data-mapping-completeness` findings, because a missing field propagation silently breaks every newly-added provider that uses that field, while all existing tests pass against the hardcoded fallback.
- Async teardown / shutdown methods in event consumer services, queue consumer workers, or streaming handlers — escalates `shutdown-sequence-ordering` findings, because reversed teardown ordering (writers closed before final flush) silently drops in-flight events with no error signal, no retry, and no observable failure.
- Deletion handlers for parent entities (cascade-delete hooks, `pre('deleteOne')`, cleanup services, event-driven cascade triggers) — escalates `cascade-deletion-completeness` findings, because orphaned outbox or child records left by an incomplete cascade cause phantom event replays and corrupt aggregates, both of which are extremely hard to diagnose post-hoc.
- Health flag property initializers in service classes that wrap stateful external connections (Kafka producers/consumers, database clients, broker clients) — escalates `health-flag-initial-state` findings, because an optimistic `= true` initial state routes live traffic to an unproven-healthy service from the moment of instantiation, with no warning until the first actual failure propagates to callers.
- Outbound calls to external services on the critical session path (voice stream, real-time message dispatch, LLM provider calls) — escalates `reliability-timeout`, `reliability-circuit`, and `reliability-degradation` findings, because a blocking or crashing dependency on the hot path takes down the entire session for all concurrent users.
- List/search endpoints queryable by tenants with large data sets (workflow executions, events, contacts, sessions) — escalates `scalability-unbounded-results` and `scalability-index-coverage` findings, because a missing limit or index causes full-collection scans that degrade the entire DB under a mature tenant's load.
- New high-frequency paths on the real-time session or voice stream handling chain — escalates `observability-metrics` and `observability-error-rate` findings, because silent failure at session-message granularity translates directly to dropped or corrupted sessions with no alertable signal.
- New MongoDB models or new user-data fields in any collection — escalates `data-lifecycle-tenant-delete` and `data-lifecycle-pii-erasure` findings, because missed erasure or cascade entries are a regulatory compliance failure that cannot be retroactively fixed for already-deleted tenants.

Escalations are recorded in the report under each affected finding as `severity-escalated: <reason>`.

#### 6g. Module-policy lookup — use the project's verification policy file to gate Phase A and Phase B

`{{MODULE_POLICY_PATH}}` (when present) defines per-path module policies: criticality, autonomy levels, required commands, required regression + e2e suites, required signals, and characterize-first conditions. (In some repos this lives at `helix.verification.yaml`; in others it may be `verification.yaml`, `.review-policy.yaml`, or absent.)

For each touched path, find the matching policy entry (`modulePolicies[*].paths`) and:

1. Run every command listed under `requiredCommands` for that policy. Missing any one = `Verification incomplete: <command> not run`.
2. Run every suite listed under `requiredSuites.regression` and `requiredSuites.e2e` for that policy. Suite IDs map to commands in the top-level `suites:` list.
3. For each `requiredSignals` line, locate the test or assertion that demonstrates the signal. Missing signal coverage = `tests: FAIL`.
4. If the policy specifies `maxAutonomyLevel: L1`, the PR cannot be auto-merged or auto-pushed even in Phase B without explicit user confirmation per change. Treat L1 modules as always requiring step-by-step user opt-in.
5. If `characterizeFirstWhen` lists a condition that holds for this PR, apply the rule from step 6e.

When no policy file exists or no policy matches the touched paths, fall back to `defaults`: run `{{BUILD_CMD}}` + the project's autoformatter, the project's fast regression suite, and treat `missingE2EAction: characterize-first` as the default for any critical module without coverage.

#### 6h. Advisory triage cards — non-blocking decisions for the user

When the PR triggers any of the advisory concerns listed in `references/default-gates.md` (`clean-contracts`, `reasoning-flow-parity`, `studio-wiring`, `studio-api-wiring`, `omnichannel`, `scale`, `localization`, `onboarding-ux`, `form-submission-resilience`, `ux-design`, `docs-examples-consistency`), generate a triage card and include it in the report. Advisory concerns never block merge — they collect non-trivial decisions for the user to choose explicitly.

Each card has the format:

```
advisory:<concern> (rubric N) — TRIAGE
  option_A: <one line>
  option_B: <one line>
  option_C: <one line>
  recommendation: <A|B|C> — <one-line justification>
```

Do not auto-resolve. Oracle / model-generated prose for an advisory concern is not promoted to a canonical finding without explicit user confirmation.

#### 6b. Code-vs-test-spec coverage matrix (mandatory gate `coverage-matrix`)

Trigger: a feature spec exists at `docs/features/<slug>.md` AND a paired testing spec exists at `docs/testing/<slug>.md`. Match the slug from the PR title, branch name, or modified docs paths.

When triggered, build a two-way matrix and report it in the findings section. Don't paste the full matrix into the report — just report deltas.

1. **Locate the artifacts**:

   ```bash
   ls docs/features/<slug>.md docs/testing/<slug>.md
   ```

   If `docs/features/<slug>.md` exists but `docs/testing/<slug>.md` does NOT, that itself is a `tests` finding — non-trivial features must have a paired testing spec. Cite the missing path and stop the matrix pass.

2. **Spec → code direction**: read the testing spec's scenario rows. For each row, search the PR diff (and pre-existing tests not modified by the PR) for a corresponding test:

   ```bash
   git diff --name-only <base>...HEAD -- '*.test.ts' '*.spec.ts' '*.e2e.ts'
   # Then grep each scenario row's identifier (test name, route, function) across test files
   ```

   - Spec rows with **no test** → `coverage-matrix` finding: `<scenario row> not covered`.
   - Spec rows that map to a test that mocks the thing it claims to verify → `coverage-matrix` finding: `<scenario row> covered only by mocked test`.

3. **Code → spec direction**: enumerate new public surfaces in the PR (new exported functions, new routes, new event payloads, new UI flows, new schema fields). For each, search the testing spec:
   - New surface absent from the testing spec → `coverage-matrix` finding (spec drift): `<surface> at <file>:<line> missing from docs/testing/<slug>.md`.
   - The finding must cite which section of the testing spec the new surface should land in.

4. **Wired/reachable verification**: scan the feature spec for any "implemented", "wired", or "reachable" claim. For each:
   - Confirm the test backing it is integration or E2E (hits the real route, not a unit test of an internal helper).
   - A claim with no integration/E2E backing → `coverage-matrix` finding: `<claim> in feature spec is not backed by integration/E2E test`.

5. **Verdict line in the report**: `coverage-matrix: PASS | FAIL | N/A (no testing spec exists)`. List the specific delta rows when `FAIL`.

#### 6c. Durable-execution / replay-safety (mandatory gate `durable-execution`)

This gate covers any durable-execution / workflow-orchestration framework the project uses (Restate, Temporal, Inngest, AWS Step Functions DSL, custom workflow engines, etc.). The replay-safety rules below apply to all of them; the trigger and exact API names are project-specific (resolve from `{{DOMAIN_GATES_PATH}}`).

Trigger detection — emit `N/A (PR does not touch any durable-execution code)` if none match. Otherwise run the full check list. Example detection (adapt to the project's framework):

```bash
# Path-based: project's workflow apps/packages
git diff --name-only <base>...HEAD | grep -E '<project-workflow-path-pattern>'
# Import-based: project's workflow SDK and replay primitives
git diff <base>...HEAD -- '<project-workflow-glob>' | grep -E "from '<workflow-sdk>|ctx\\.run\\(|ctx\\.sleep\\(|ctx\\.awakeable\\("
```

When triggered, run these checks against every changed handler:

1. **Replay determinism** — every nondeterministic call must be wrapped in `ctx.run(name, fn)`:
   - `Date.now()`, `new Date()` (no-arg), `Math.random()`, `crypto.randomUUID()`, `uuid()`, any clock or randomness call
   - Network: `fetch`, `axios`, any HTTP client, any DB driver call, any queue publish
   - Filesystem reads, env reads that can change at runtime
   - Capturing the result of one of these OUTSIDE `ctx.run` and using it after an `await` = `FAIL`.

2. **Idempotent side-effects**: every `ctx.run` body that has an external side-effect (DB write, queue publish, webhook call, payment, email, third-party API mutation) must be idempotent or keyed by a stable identifier (handler invocation ID, business key). A retried replay must not double-charge, double-send, or double-write.

3. **Stable handler & step IDs**: the string passed as the `ctx.run` step name must be stable across deploys for the same logical step. Look for renamed step strings — a rename without a versioned handler breaks in-flight executions = `FAIL`.

4. **No closure mutation across awaits**: handler-local mutable state (let bindings, array `.push`, object mutation) modified across `await ctx.run(...)` / `await ctx.sleep(...)` is a replay hazard. Reads after a suspension must come from `ctx.run` results, durable state, or values recomputed deterministically from the original input.

5. **Versioned handler on payload-shape change**: when a handler's input or persisted state shape changes, the change must land behind a new handler version OR include an explicit migration for in-flight executions. A breaking change on an already-deployed handler = `FAIL`.

6. **Awaits inside loops**: `Promise.all(items.map(i => ctx.run(name, ...)))` with the SAME `name` across iterations is a `FAIL` — step names must be unique per call site (e.g. include the item key: `ctx.run(\`process-${i.id}\`, ...)`).

7. **No raw `setTimeout` / `setInterval`**: time-based waiting must use `ctx.sleep`. External signal waiting must use `ctx.awakeable`. Raw `setTimeout` does not survive replay.

8. **Side-effect ordering**: when emitting events that other handlers consume, ensure the publish step runs after the durable state write (or is itself part of a transactional `ctx.run`). Replay must not produce ghost events for state that never committed.

Verdict line in the report: `durable-execution: PASS | FAIL | N/A (PR does not touch any durable-execution code)`.

### 7. Build before tests

Follow repo policy: run builds before tests.

Build every app in `{{MONOREPO_APPS}}` that this PR touches (and any shared package whose downstream build would otherwise read stale outputs). Use the package-manager filter idiom for the project (`pnpm --filter`, `turbo run build --filter`, `nx run-many`, `lerna run`, `npm run build -w`, etc.). If shared dependencies are stale, build them first rather than misreporting downstream failures as PR bugs.

**Verify build outputs exist** — for each app you built, confirm its build artifact directory landed (Next.js `.next/`, Vite `dist/`, tsc `dist/`, framework-specific output as declared in the app's `package.json` `build` script or framework config):

```bash
# For each app in {{MONOREPO_APPS}} whose build you ran:
ls .worktrees/pr-<number>/<app-path>/<build-output-dir> 2>/dev/null | head -1
```

If a build "succeeded" but the output directory is empty or missing, the build was a no-op (cache miss with broken script, or filter that resolved to nothing) — treat it as a build failure and stop.

### 7.5 Preflight gate — must pass before launch and tests

Before step 8 (launch) and step 9 (tests) you MUST verify the worktree is hydrated. Run this checklist explicitly:

| Check         | Command                                                                     | Required state                                         |
| ------------- | --------------------------------------------------------------------------- | ------------------------------------------------------ |
| Env files     | For each entry in `{{ENV_FILES}}`: `ls <path>`                              | All present (or surfaced as launch blocker per step 3) |
| Install       | For each test/E2E binary the repo declares: `ls node_modules/.bin/<binary>` | All required binaries present                          |
| Build outputs | For each app you intend to test: `ls <app-path>/<build-output-dir>`         | All present                                            |

If any row fails, do **not** proceed to launch or tests. Either:

1. Re-run the corresponding step (3, 4, or 7) and re-check, or
2. Stop and write a Phase A report that **explicitly says "verification incomplete: \<reason\>"** at the top, with the specific failing precondition. Do not silently produce a code-only review labeled as a full review.

Rule: a missing precondition is never grounds to skip steps 8–9 quietly. Either fix it or flag it.

### 8. Launch the affected apps

Read each app's `package.json` before launching. Do not invent script names.

Launch every app from `{{MONOREPO_APPS}}` whose surfaces this PR touches (use the path-touch heuristic from step 9 to decide). Prefer the normal local dev or start scripts already used by the repo (`dev`, `start`, `start:local`, etc., as declared). Use the copied env files plus any required local service endpoints.

If a port is occupied or an app fails to boot, treat that as environment or launch failure and report it separately from code-review findings.

### 9. Run tests

Goal: cover the **affected workspace**, not just the touched files, without duplicating CI's full-suite run.

Use the project's affected-workspace filter against the PR base to pick up cross-package impact. The exact syntax depends on the toolchain; pick the one that matches the repo:

```bash
# pnpm + turbo
pnpm test -- --filter="...[origin/<base>]"
pnpm build -- --filter="...[origin/<base>]"

# nx
npx nx affected -t test --base=origin/<base>

# turbo (raw)
npx turbo run test --filter="...[origin/<base>]"

# Lerna
npx lerna run test --since origin/<base>
```

If none of these are available, fall back to the touched-package list from `git diff --name-only origin/<base>...HEAD` and run that package's test script.

Order of execution:

1. Targeted unit/package suites for directly changed packages (fast feedback). Use whatever runner the package declares (`vitest`, `jest`, `mocha`, `pytest`, `go test`, etc.).
2. Affected-workspace run (catches cross-package regressions).
3. **E2E suites — scope-gated by which app surfaces the PR touches.** For each app in `{{MONOREPO_APPS}}` that exposes an E2E script, run the suite when the PR diff touches that app's source paths or any shared package that app consumes. Discovery: read each app's `package.json#scripts` for `test:e2e` / `e2e` / `playwright` / `cypress` and compute the touch rule from the dependency graph (`pnpm why`, workspace `dependencies`, or static import scan). Examples (the exact path globs are project-specific — derive them from each app's source root):
   - For an app at `<app-path>` with E2E script `test:e2e`, trigger when `git diff --name-only origin/<base>...HEAD` matches `<app-path>/**` or any package in its dependency closure.
   - Do not hardcode app names — drive everything from `{{MONOREPO_APPS}}` and the dependency graph.

Rules:

- Do not blanket-run every unit + E2E suite in the monorepo. CI does that on push; duplicating it here adds 20–40 min of mostly environmental noise and dilutes the targeted signal.
- If `--filter="...[origin/<base>]"` resolves to an empty set, fall back to the touched-package list and note it in the report.
- If a test cannot run because of environment, build, or dependency issues, report that precisely — do not claim "tests passed" for suites that never executed.
- E2E flakes are not findings. Re-run once; if still red, attribute precisely (PR vs. flake vs. environment).
- **Skipping E2E because the worktree is unhydrated is not allowed.** The preflight gate (step 7.5) catches this. If you reach step 9 and an E2E suite still cannot run because of hydration, that is a step-7.5 failure being smuggled past the gate — go back and fix it or stop and flag it.
- For each E2E suite triggered by the path-touch rules above, the report must say **explicitly** whether it ran, was skipped (with reason), or failed. Silence is not acceptable.
- **Heavily-modified test files have a hard run requirement.** Run `git diff --stat origin/<base>...HEAD -- '*.test.ts' '*.spec.ts' '*.e2e.test.ts' '*.test.tsx' '*.spec.tsx'` and identify any test file with **>100 added lines** in this PR. Each such file MUST execute in this audit. If it cannot run in this environment, the report's verification banner (step 10 item 1) is `Verification incomplete: <test path> ({{N}}+ lines added by this PR) cannot run because <reason>`. Never silently classify a heavily-modified test file as `NOT-VERIFIED` or `SKIPPED (env)` — a +300-line E2E edit in a PR is a maximum-priority signal that the test must be exercised.
- **Capture truncated output to a file.** When a test command produces output that exceeds tool-result limits, capture to a file (`<test command> 2>&1 > /tmp/<suite>.log; echo EXIT=$?`) and grep the file for the explicit summary line emitted by the runner (`Test Files`, `Tests`, `× `, `FAIL `, `PASS `, `passed`, `failed`, `ok`, etc. — varies by runner). Treat absence of an explicit pass-summary as a fail signal, not as ambiguity. Never report "ran" based on tail output that may have been clipped before the summary line.

### 10. Report

Structure the final review like this:

1. **Verification status banner** (always first if anything is incomplete) — one line stating whether the worktree was hydrated, built, and launched. If any precondition from step 7.5 failed, the banner must say: `Verification incomplete: <reason>`. This goes ABOVE the gate verdicts so the user immediately knows the report's confidence level.
2. **Mandatory gate verdicts** (one line each — silence is not acceptable for any of the fourteen). Each line ends with the rubric concern in parens (`(rubric N)`) for cross-tool reconciliation.

   **Always-applicable (8):**
   - `functional-regression` (rubric 6): PASS | FAIL | UNVERIFIED — short reason and blast-radius statement
   - `security` (rubric 8): PASS | FAIL | UNVERIFIED — short reason (include `pii-passthrough` sub-verdict when new fields cross pass-through surfaces)
   - `isolation` (rubric 1): PASS | FAIL | UNVERIFIED — short reason
   - `stale-or-duplicate-code` (rubric 6): PASS | FAIL | UNVERIFIED — short reason
   - `cross-pod` (rubric 11): PASS | FAIL | UNVERIFIED — short reason (pod-local truth, distributed locks, cache scoping)
   - `audit-log` (rubric 10): PASS | FAIL | UNVERIFIED — short reason (sensitive ops, structured payload, failure-path coverage)
   - `boundary-metadata` (rubric 2): PASS | FAIL | UNVERIFIED — short reason (reserved keys, sliding-window, versioned shims)
   - `wiring-reachability` (rubric 12): PASS | FAIL | UNVERIFIED — short reason (production-entry-point trace, mounted-means-tested)

   **Trigger-conditional (10 — `N/A (<reason>)` allowed):**
   - `coverage-matrix` (rubric 16): PASS | FAIL | UNVERIFIED | N/A (no feature slug — pure infra/refactor PR) — list spec→code and code→spec deltas when FAIL; missing `docs/testing/<slug>.md` for a non-trivial feature is FAIL, not N/A
   - `durable-execution` (rubric 4): PASS | FAIL | UNVERIFIED | N/A (PR does not touch any durable-execution code) — list replay hazards when FAIL
   - `agent-transfer` (rubric 4): PASS | FAIL | UNVERIFIED | N/A (no agent-transfer paths touched)
   - `customer-contact` (rubric 3): PASS | FAIL | UNVERIFIED | N/A (no contact/identity/channel paths touched)
   - `design-system` (rubric 13): PASS | FAIL | UNVERIFIED | N/A (no design-system-governed UI changes)
   - `import-export-roundtrip` (rubric 7): PASS | FAIL | UNVERIFIED | N/A (no IO / manifest / schema changes)
   - `reliability` (rubric 9): PASS | FAIL | UNVERIFIED | N/A (no outbound calls / queue producers / cross-service integrations) — cite which sub-checks (timeout / retry / circuit / degradation / idempotency) triggered when FAIL
   - `scalability` (rubric 11): PASS | FAIL | UNVERIFIED | N/A (no DB queries / list endpoints / hot-path handlers) — cite which sub-checks (n+1 / unbounded-results / index / hot-path / memory-growth) triggered when FAIL
   - `observability` (rubric 10): PASS | FAIL | UNVERIFIED | N/A (no new services / workers / high-frequency endpoints) — cite which sub-checks (metrics / health / trace / log-levels / error-rate) triggered when FAIL
   - `data-lifecycle` (rubric 1): PASS | FAIL | UNVERIFIED | N/A (no new models / fields / deletion handlers) — cite which sub-checks (tenant-delete / pii-erasure / ttl / index) triggered when FAIL

3. **E2E suite status** (one line per applicable suite — silence is not acceptable). The verdict string MUST be exactly one of: `RAN/PASSED`, `RAN/FAILED`, `SKIPPED (<reason>)`, `NOT-APPLICABLE (<reason>)`. Any other string (e.g. `NOT FULLY VERIFIED`, `PARTIAL`, `RAN/MOSTLY-PASSED`, `AMBIGUOUS`) is a skill violation — restart the report and either run the suite cleanly or open with `Verification incomplete: <reason>`. List one line for **each** E2E suite discovered for the apps in `{{MONOREPO_APPS}}` (or in the touched-package set), naming the app and the suite (e.g. `<app>:<runner>` like `studio:playwright`, `runtime:vitest-e2e`).
4. **Advisory triage cards** (one block per triggered advisory concern; see step 6h). Skip the section entirely when no advisory concern triggered. Each card uses the format:

   ```
   advisory:<concern> (rubric N) — TRIAGE
     option_A: <one line>
     option_B: <one line>
     option_C: <one line>
     recommendation: <A|B|C> — <one-line justification>
   ```

5. **Module-policy verification** (one line per touched policy from `helix.verification.yaml`)
   - Policy ID, criticality (`critical` | `high` | `medium` | `low`), `maxAutonomyLevel` (`L1` | `L2`).
   - For each `requiredCommand`: RAN/PASSED | RAN/FAILED | NOT RUN (reason).
   - For each `requiredSuites.regression` ID: RAN/PASSED | RAN/FAILED | SKIPPED (reason).
   - For each `requiredSuites.e2e` ID: RAN/PASSED | RAN/FAILED | SKIPPED (reason).
   - For each `requiredSignal`: VERIFIED (test cite) | UNVERIFIED (reason).
   - When no policy matches the touched paths, print `module-policy: defaults applied` and list the default commands/suites that ran.
6. Findings (each line includes `(rubric N)` and any `severity-escalated: <reason>` per step 6f)
7. Build failures
8. Launch failures
9. Test failures
10. Residual risks or unverified areas
11. Commands actually run

Every mandatory gate verdict must appear at the top of every report, even when there are no findings. `N/A` is allowed only for the trigger-conditional gates (the six in this repo's defaults: `coverage-matrix`, `durable-execution`, `agent-transfer`, `customer-contact`, `design-system`, `import-export-roundtrip` — adjust per project), and only with a stated reason. If any gate is `FAIL`, mark the PR as **not ready to merge** in the summary line, regardless of build or test status. When `{{RUBRIC_PATH}}` is configured, each finding cites the rubric concern (`(rubric N)`) so findings reconcile with the project's rubric and any concern files (e.g. `.helix/concerns/`).

Report findings ordered by severity, with tight file references.

For each finding include:

- severity
- gate label (must be one of: `functional-regression`, `multi-step-atomicity`, `data-mapping-completeness`, `ranked-query-ordering`, `shutdown-sequence-ordering`, `db-filter-field-path`, `cascade-deletion-completeness`, `security`, `pii-passthrough`, `credential-field-path`, `cross-pod`, `singleton-service-guard`, `health-flag-initial-state`, `isolation`, `stale-or-duplicate-code`, `code-quality`, `encryption`, `tests`, `coverage-matrix`, `durable-execution`, `reliability`, `reliability-timeout`, `reliability-retry`, `reliability-circuit`, `reliability-degradation`, `reliability-idempotency`, `scalability`, `scalability-n-plus-one`, `scalability-unbounded-results`, `scalability-index-coverage`, `scalability-hot-path`, `scalability-memory-growth`, `scalability-connection-pool`, `observability`, `observability-metrics`, `observability-health`, `observability-trace`, `observability-log-levels`, `observability-error-rate`, `data-lifecycle`, `data-lifecycle-tenant-delete`, `data-lifecycle-pii-erasure`, `data-lifecycle-ttl`, `data-lifecycle-index`, `ux-ui`, or a user-supplied gate)
- why it matters
- exact file and line
- which existing feature it could break (when the gate is `functional-regression`)

Keep build or environment problems separate from code findings so the user can tell product bugs from local setup failures.

After the report is delivered, **Phase A (Review) ends**. Do not modify any code yet. Proceed to Phase B only if the user opts in at step 11; otherwise jump straight to the final cleanup step.

## Output Standard

If there are findings, lead with them and keep summaries brief.

If there are no findings, say that explicitly and then list:

- what was built
- what was launched
- what tests passed
- what could not be verified

## Phase B — Fix Loop (Optional)

Phase B is opt-in. Run it only when the user explicitly asks to fix findings after seeing the Phase A report. All steps below run inside the same `.worktrees/pr-<number>` worktree from Phase A — never against the main checkout.

### 11. Triage findings for fix (gate)

1. After the Phase A report, number the findings sequentially (1, 2, 3, ...).
2. Ask the user which to address. Offer four choices:
   - **All** findings
   - **Critical + High** severity only
   - **Pick numbers** (e.g. `1, 3, 5`)
   - **Skip** — go straight to cleanup (step 17)
3. If the user picks **Skip**, do not modify any code. Jump to step 17.
4. If the PR author email (from step 1) does not match `git config user.email`, require an extra explicit confirmation before continuing:
   > "This PR was authored by `<author>`. Push fixes to their branch `<head-ref>`?"
   > If the user declines, jump to step 17. Do not touch the working tree.
5. Findings that cannot be fixed mechanically (subjective UX calls, missing test infrastructure, architectural rewrites) MUST be carried forward to the final report as deferred — never silently dropped.

### 12. Parse the issue-tracker key from the PR

Required so commits land with the correct ticket. Try in order:

1. PR title regex: `{{TICKET_KEY_REGEX}}` (default `[A-Z]+-\d+`).
2. First commit subject on the PR branch: `git log <base>..HEAD --format=%s | tail -1`.
3. If neither matches, stop and ask the user for the key. **Do NOT invent or auto-create a duplicate ticket** — defer to the project's ticket policy in `CLAUDE.md` / repo conventions.

Record `<TICKET-KEY>` for use in every fix commit.

### 13. Apply fixes one at a time

For each selected finding:

1. Make the **minimal** edit needed. Prefer `Edit` over `Write` to keep diffs small. Do not refactor adjacent code.
   - **Sibling-grep on stale assertion fix.** When fixing a stale literal/string/number assertion (an old URL, hostname, error code, count, message string, etc.): BEFORE staging, run `rg <old-literal>` across the repo. A stale assertion almost always has at least one sibling — fix all instances in the same commit. Skipping this step is how the same bug ships twice. Example: an outdated Shopify token URL was fixed in one unit-test file in this PR but the matching E2E assertion was missed; one `rg "your-store\.myshopify"` would have caught both at once.
2. Immediately run the project's autoformatter on the changed files after each edit (typically `npx prettier --write <files>`, `eslint --fix`, `ruff format`, `gofmt -w`, etc. — discover from `package.json#scripts`, `lefthook.yml`, `.pre-commit-config.yaml`, or the repo's `CLAUDE.md` / `AGENTS.md`).
   - Recurring hazard: `lint-staged` style stash/restore cycles will silently revert uncommitted edits if a `--check` step fails. Pre-commit hooks that auto-format are a backstop, not a substitute — format explicitly before staging.
3. Run a typecheck or filtered build on the affected package to catch type errors per finding. Use the project's command (e.g. `pnpm build --filter=<pkg>`, `tsc --noEmit -p <pkg>`, `mypy <pkg>`, `cargo check -p <pkg>`).
4. Stage only the files touched by this finding, then commit using the project's commit-message convention. If `CLAUDE.md`/`AGENTS.md` mandates a HEREDOC pattern (to avoid shell-escaping issues), use it:

   ```bash
   git commit -m "$(cat <<'EOF'
   [<TICKET-KEY>] fix(<scope>): <one-line description tied to the finding>
   EOF
   )"
   ```

   - Honor every project-level constraint declared in `CLAUDE.md`/`AGENTS.md` (e.g. "no `Co-Authored-By` lines", commit-type vocabulary, scope guards). Do not invent your own.
   - **Never** use `--no-verify`. Let pre-commit hooks run.

5. If a hook blocks the commit:
   - The commit did NOT happen.
   - Fix the underlying issue, re-stage, and create a **NEW** commit. Never `--amend` (the previous commit may be unrelated work).
6. After all selected findings are committed, run `git log <base>..HEAD --oneline` to confirm one commit per finding (or as bundled if the user chose differently at step 11).

### 14. Rebase onto PR base

1. `git fetch origin <base>` — base captured in step 1.
2. `git rebase origin/<base>`.
3. On conflict: stop. Surface the conflicting files and the conflict markers. Ask the user how to resolve. **Do NOT** run `git rebase --abort` automatically — the user may want to resolve in place.
4. Once the rebase completes cleanly, continue.

### 15. Re-verify after rebase

Phase B is push-gating: before `git push` in step 16, run the **full** unit and E2E suites — not the affected-only scoping used in Phase A step 9. Phase A optimizes for fast review signal; Phase B has to match what CI will run on push.

Run these inside the worktree, in order:

1. `{{INSTALL_CMD}}` — only if the lockfile (e.g. `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lockb`) changed during rebase.
2. `{{BUILD_CMD}}` — full root build.
3. `{{TEST_CMD}}` — full unit + integration suite.
4. E2E suites — run **every** E2E suite the repo declares, regardless of which surfaces the PR touched. Discover the full set from each app's `package.json#scripts` (`test:e2e`, `e2e`, `playwright`, `cypress`, etc.) and run them all.

Rules:

- All four steps must complete green before step 16. **No skipping E2E based on diff scope** — that shortcut belongs to Phase A, not Phase B.
- If a failure appears that was NOT in the pre-fix Phase A run, treat it as a regression caused by the fixes or the rebase. **Stop before push.** Report which step failed and which commit likely introduced it.
- Do not push when re-verification fails — even if the original Phase A run was green, a regression now is worse than the original findings.
- E2E flakes: re-run the failing suite **once**. If still red, stop and report — do not push past a red E2E on a "probably flaky" hunch.
- If an E2E suite cannot run because the corresponding app from `{{MONOREPO_APPS}}` failed to launch in step 8 (or was never launched because Phase A didn't need it), launch it now before running its E2E. Do not mark E2E as "passed" for a suite that never executed.

### 16. Push with `--force-with-lease`

1. Push to the PR's actual head ref (recorded in step 1):

   ```bash
   git push --force-with-lease origin HEAD:<head-ref>
   ```

2. **Host-specific teardown glitches**: some hosts (notably Bitbucket over SSH) emit `Connection reset by peer` or `Broken pipe` at the end of a push even when the ref has already landed. Treat this as cosmetic. Do NOT retry. Do NOT kill ssh. Verify the ref actually landed via:

   ```bash
   git ls-remote origin <head-ref>
   ```

   Compare the returned SHA to your local `git rev-parse HEAD`. If they match, the push succeeded. Apply the same "verify, don't retry" rule for any other host where pushes appear to fail at teardown but the ref is present remotely.

3. Never use `--force` (without `-with-lease`). Never push to a protected branch (e.g. `main`, `master`, `{{BASE_BRANCH}}`, or any branch the project marks protected in `CLAUDE.md` / repo settings).
4. Print the final report:
   - Pushed SHA
   - One line per fix commit (subject only)
   - Any findings deferred from step 11 (with a note on why)

After step 16 completes, continue to step 17 cleanup.

### 17. Stop launched services

The final step is cleanup.

Stop any Studio, Runtime, and Workflow Engine processes that this review flow started.

Rules:

- Stop only the processes started for this PR review flow.
- Do not stop unrelated user processes unless the user explicitly asks.
- If a service failed before launch, note that cleanup was not needed.
- If cleanup fails, report that separately in the final output.

## Guardrails

### Phase A guardrails

- Do not review from diff alone; read surrounding code.
- Do not print env secrets.
- Do not treat unrelated workspace breakage as a PR bug without saying so.
- Do not hide missing verification. If build, launch, or test steps were blocked, say exactly what blocked them.
- If the user supplied extra gates, include them in both the review pass and the final report.
- **Never silently skip steps 3, 4, 7, 8, or 9.** If hydration or build genuinely cannot complete in this environment, the report's first line must be `Verification incomplete: <reason>` so the user knows it's a code-only review. Reusing the main checkout's `node_modules` or producing a "passed" summary without running the corresponding suites is forbidden.
- **Path-touch rules in step 9 are upper bounds, not opt-outs.** A PR that touches any app in `{{MONOREPO_APPS}}` MUST report that app's E2E status (ran / failed / skipped-with-reason) for every E2E suite the app declares. The report's E2E section never shows silence.

### Phase B guardrails

- **Never** modify code in Phase A. Phase B is a hard gate — no fixes happen until the user opts in at step 11.
- **Never** invent an issue-tracker key or auto-create a duplicate ticket. If parsing fails at step 12, ask the user.
- **Never** use `git commit --amend` during Phase B. If a pre-commit hook blocks a commit, fix the issue and create a NEW commit (the failed commit did not happen, so amending would modify the PREVIOUS commit and risk losing work).
- **Never** use `--no-verify` on commits. Let every project-configured pre-commit hook run.
- **Always** run the project's autoformatter on the changed files after each edit, before staging. Pre-commit auto-format hooks are a backstop, not a substitute.
- **Never** push with `--force` — only `--force-with-lease`. Never push to a protected branch (`main`, `master`, `{{BASE_BRANCH}}`, or any other branch the project protects).
- **Never** retry a push on a host-specific teardown glitch (`Connection reset by peer` / `Broken pipe`). Verify with `git ls-remote origin <head-ref>` instead.
- **Honor every commit-message constraint declared in `CLAUDE.md` / `AGENTS.md`** (e.g. "no `Co-Authored-By` lines", required ticket prefix, scope vocabulary). Do not invent your own.
- **Never** silently drop a finding. Findings not fixed mechanically must appear in the final report as deferred with a one-line reason.
- **Never** skip step 15 (re-verify after rebase). A regression introduced during fix-or-rebase is worse than the original findings.
- **Never** push fixes to a branch authored by someone else without the explicit cross-author confirmation at step 11.

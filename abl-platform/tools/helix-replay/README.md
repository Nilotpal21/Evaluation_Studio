# HELIX Replay Harness

This harness replays real recent commits against the current HELIX build so we can:

- start from the exact pre-change code state
- ask HELIX to implement the same feature or bug fix
- compare the resulting worktree diff to the original commit patch
- repeat the same scenario after HELIX changes without touching `develop`

## How it works

1. Pick a replay scenario in `tools/helix-replay/scenarios/`.
2. Prepare a detached replay worktree at the scenario's `baseCommit`.
3. Build the current HELIX CLI from the source repo.
4. Run HELIX against that detached worktree with the scenario summary/description/scope.
5. Record the latest session summary plus a diff comparison against the original commit.

By default the runner keeps and reuses a stable replay worktree per scenario so repeated runs
avoid paying the full `git worktree add` cost every iteration. HELIX is launched with:

- `--auto-approve`
- `--auto-commit`
- a large budget

The commits happen only inside the detached replay worktree. Jira credentials are overridden with
disabled placeholders during the replay so HELIX does not post commit comments back to Jira.

## Run a scenario

```bash
pnpm exec tsx tools/helix-replay/run.ts \
  --scenario tools/helix-replay/scenarios/ablp-244-workspace-switch-refresh.json
```

## Artifacts

Replay artifacts are written under:

```text
.helix/replays/runs/<scenario-id>/<timestamp>/
```

Each run records:

- the scenario manifest
- HELIX stdout/stderr
- the latest session summary
- diff comparison metrics
- a short text summary

## Initial scenario set

- `ABLP-244` workspace switching persists after refresh
- `ABLP-339` create workspace entry point in the user menu
- `ABLP-335` legacy workspace login compatibility
- `ABLP-340` optional runtime URL in Studio

## Current limitation

The comparison is patch-based and file-based. It does **not** yet score semantic equivalence when
HELIX reaches the same behavior through a different patch shape. That is a good next refinement
once the replay loop is stable.

# @abl/conversation-testing

Drive LLM-simulated conversations against a deployed agent so the insights pipelines (sentiment, intent, quality, friction, hallucination) have realistic data to process.

## TL;DR

1. Create `scripts/conversation-testing/.env.local` (see [Setup](#setup) below).
2. Run `pnpm insights` for default mode, or `pnpm insights --all` for per-agent coverage.

Inline env vars win over the file, e.g. `RUNS=20 PRESET=stress-negative pnpm insights`.

## Setup

Copy-paste one of these two starter configs into `scripts/conversation-testing/.env.local` and fill in the blanks. The file is gitignored.

### Against the dev environment (recommended)

Dev already has pipeline-engine, Restate, Kafka, and LLM credentials wired up — you just run the script locally.

```
ANTHROPIC_API_KEY=sk-ant-...
STUDIO_URL=https://agents-dev.kore.ai
RUNTIME_WS_URL=wss://agents-dev.kore.ai/ws/sdk

# Dev auto-login fetches a share token for you per run (requires ENABLE_DEV_LOGIN=true on dev Studio)
STUDIO_EMAIL=you@kore.ai
PROJECT_ID=proj-apple-care

# OR — if dev-login is disabled, paste a share token from the dev Studio share dialog:
# SHARE_TOKEN=eyJ...

RUNS=10
PRESET=auto
```

> **Getting a share token:** open the dev Studio Share dialog for your bot; the URL becomes `https://agents-dev.kore.ai/preview#share_token=eyJ...` — copy everything after `share_token=`. Tokens expire in 7 days.

### Against local dev

Requires three services running. The root `pnpm dev` starts only the first two; start pipeline-engine in a separate terminal:

```bash
pnpm --filter @agent-platform/pipeline-engine dev   # port 9082
```

Then:

```
ANTHROPIC_API_KEY=sk-ant-...
STUDIO_EMAIL=dev@kore.ai
PROJECT_ID=proj-e2e-apple-care
RUNS=10
PRESET=auto
```

(`STUDIO_URL` defaults to `http://localhost:5173`, `RUNTIME_WS_URL` to `ws://localhost:3112/ws/sdk`.)

## Running

```bash
pnpm insights                        # default mode — N conversations over mixed intents
pnpm insights --all                  # per-agent mode — discovers bot topology, scenarios per agent
RUNS=20 pnpm insights                # override any env var inline
RUNS=20 PRESET=stress-negative pnpm insights
```

`--all` requires dev auto-login (`STUDIO_EMAIL` + `PROJECT_ID`). Topology API needs tenant auth, share tokens don't satisfy it.

## `--all` mode specifics

- Reads `/api/projects/:id/topology` and generates scenarios that target each agent.
- Forces `CONCURRENCY=5` and `MAX_TURNS=10`.
- Total sessions: `RUNS` when set explicitly (round-robin across agents), else `RUNS_PER_AGENT × agents` (default `RUNS_PER_AGENT=3`).
- Each scenario is tagged with `targetAgent` in logs and transcripts.

## Configuration

### Required

- `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`, or `CUSTOM_LLM_*`)
- Auth — pick one: `SHARE_TOKEN`, **or** `STUDIO_EMAIL` + `PROJECT_ID`

### Optional

| Variable           | Default                      | Notes                                                           |
| ------------------ | ---------------------------- | --------------------------------------------------------------- |
| `RUNS`             | `10`                         | In `--all`, caps the total when set explicitly.                 |
| `RUNS_PER_AGENT`   | `3`                          | `--all` only, used when `RUNS` isn't set.                       |
| `CONCURRENCY`      | `5`                          | Forced to `5` in `--all`.                                       |
| `PRESET`           | `auto`                       | `auto` randomly assigns one of the 5 profiles per scenario.     |
| `INSTRUCTIONS`     | _(empty)_                    | Free-text appended to the scenario-generation prompt.           |
| `DOMAIN_HINT`      | _(empty)_                    | Overrides the bot's welcome message as the domain source.       |
| `PROVIDER`         | `anthropic`                  | `anthropic` / `openai` / `custom`.                              |
| `MODEL`            | provider default             | Override the default model for the chosen provider.             |
| `STUDIO_URL`       | `http://localhost:5173`      | Override for non-local Studio.                                  |
| `RUNTIME_WS_URL`   | `ws://localhost:3112/ws/sdk` | Override for non-local Runtime.                                 |
| `MAX_TURNS`        | `15`                         | Per conversation; forced to `10` in `--all`.                    |
| `TIMEOUT_MS`       | `120000`                     | Per-conversation timeout.                                       |
| `SAVE_TRANSCRIPTS` | `0`                          | Set to `1` to write JSON transcripts to `outputs/<timestamp>/`. |
| `DEBUG_PROMPTS`    | `0`                          | Set to `1` to log full LLM prompts.                             |

### Presets

| Preset            | Description                                                         |
| ----------------- | ------------------------------------------------------------------- |
| `auto` (default)  | Randomly picks one of the 5 below per scenario — broadest coverage. |
| `balanced`        | Mixed moods/lengths/outcomes — realistic variety.                   |
| `stress-negative` | ~80% frustrated/angry personas, partial resolution or abandonment.  |
| `short-simple`    | 2-3 turns, single-intent, task-oriented.                            |
| `long-complex`    | 6-10 turns, multi-step, gradual context reveal.                     |
| `abandonment`     | ~70% end early without resolving.                                   |

## Troubleshooting

**No insights rows appear after a run.** Conversations completed but ClickHouse is empty. Check, in order:

1. Pipeline-engine is running (`pnpm --filter @agent-platform/pipeline-engine dev`).
2. `docker/restate.toml`'s `kafka-clusters.brokers` matches `EVENT_KAFKA_BROKERS` in `apps/runtime/.env`.
3. The tenant's LLM credentials can be decrypted by the runtime/pipeline. If not, re-create via Studio's credential UI.

**"No credential found for provider X"** in runtime logs — the bot's model credential can't be decrypted (KEK/DEK mismatch). Re-create it in Studio.

**`ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL: Command "insights" not found`** — the `insights` script was removed from the root `package.json`. Restore: `"insights": "bash scripts/conversation-testing/run.sh"`.

**Share-token exchange returns 401 "Invalid or expired token"** — paste a fresh token from the Share dialog, or switch to dev auto-login (`STUDIO_EMAIL` + `PROJECT_ID`).

**Share-token exchange returns 403 "Missing origin header"** — already handled by the script. If you see this from a custom fork, make sure your fetch sends `Origin: ${STUDIO_URL}`.

**LLM rate-limited** — lower `CONCURRENCY` or `RUNS`. Studio's share-token-exchange is also rate-limited at 30/min/IP.

**Bland scenarios** — the bot's welcome message is too generic. Set `DOMAIN_HINT="..."` to guide scenario generation.

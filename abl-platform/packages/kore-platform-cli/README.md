# @agent-platform/cli

CLI for the Kore.ai Agent Platform — auth, projects, agents, debug, sizing, **and Arch AI** (headless).

The `arch` subcommand tree drives the Arch AI engine via Studio's HTTP+SSE routes — same code path the browser uses, no Studio frontend needed.

## Install

```bash
pnpm install
pnpm build --filter=@agent-platform/cli
# Optional: pnpm link
node packages/kore-platform-cli/dist/index.js --help
```

## First-time setup

```bash
kore-platform-cli config set apiUrl http://localhost:5173    # Studio dev
# or:
kore-platform-cli config set apiUrl https://agents.kore.ai   # prod
kore-platform-cli login                                       # device-auth flow
kore-platform-cli whoami
```

## Arch AI commands

Drive arch-ai end-to-end without a browser. Project creation, in-project modification, regression testing — all scriptable.

### Sessions

```bash
kore-platform-cli arch session new [-p <projectId>]    # ONBOARDING if no project, IN_PROJECT otherwise
kore-platform-cli arch session list
kore-platform-cli arch session use <sessionId>          # set active
kore-platform-cli arch session resume [id]              # show resume snapshot
kore-platform-cli arch session archive [id]
kore-platform-cli arch session checkpoints [id]
kore-platform-cli arch session rollback <checkpointId>
```

If you've already run `kore-platform-cli projects use <slug>`, `arch session new` automatically binds the new session to that project (IN_PROJECT mode).

### Messaging

```bash
kore-platform-cli arch chat                                       # interactive REPL
kore-platform-cli arch send "Build a returns assistant"           # one-shot
kore-platform-cli arch reply <toolCallId> --answer '"yes"'        # respond to ask_user widget
kore-platform-cli arch reply <toolCallId> --answer '{"name":"x"}' # multi-field answer
```

`--answer` accepts JSON literals (`'"yes"'`, `'{...}'`, `'[...]'`, `'true'`, `'42'`) or a plain string fallback.

### Files

```bash
kore-platform-cli arch files upload <path>     # base64-encodes, returns blobId
```

Supported ext → MIME mapping mirrors Studio: `.pdf .md .json .yaml .txt .docx .png .jpg`. Other types upload as `application/octet-stream`.

### Inspection (read-only)

```bash
kore-platform-cli arch summary                          # active project's spec doc
kore-platform-cli arch summary -p <projectId>
kore-platform-cli arch health                           # active project health
kore-platform-cli arch audit tail [--limit 50] [--severity error]    # admin only
kore-platform-cli arch workspace list                    # tenants you belong to
```

## SSE event rendering

`arch send` and `arch chat` stream `ArchSSEEvent`s. The renderer covers:

| Event                                   | Output                                  |
| --------------------------------------- | --------------------------------------- |
| `text_delta`                            | tokens stream raw to stdout             |
| `tool_call` (server-side)               | dim `→ tool: <name>`                    |
| `tool_call` (`ask_user`/`collect_file`) | yellow widget block + `arch reply` hint |
| `tool_result`                           | `← tool: <name> [ok\|err]`              |
| `specialist`                            | cyan `[<specialist-name>]`              |
| `phase_transition`                      | bold `=== PHASE: <from> → <to> ===`     |
| `compile_result`                        | `✓` / `✗` per agent + errors            |
| `file_changed`                          | `📄 <action>: <path>`                   |
| `gate_request`                          | yellow gate block                       |
| `progress`                              | `[step/total] label`                    |
| `error`                                 | red message                             |
| `journal_entry`                         | hidden unless `ARCH_VERBOSE=1`          |

Set `ARCH_VERBOSE=1` to dump unknown event types and tool-call inputs.

## Common workflows

### Repair a local `abl.lock`

When you edit an exported project folder by hand, recompute its v2 lockfile before importing it again:

```bash
kore-platform-cli lockfile recompute ./exports/voltmart-support
kore-platform-cli lockfile recompute ./exports/voltmart-support --check
```

The command updates per-file `source_hash` values, layer hashes, and root `integrity` in `abl.lock`. It is local-only and does not call Studio.
Use it instead of hand-editing hashes: it can repair stale or `null` v2 `source_hash` / `integrity` fields from the files on disk.

### Create a project from scratch (ONBOARDING)

```bash
kore-platform-cli arch session new
kore-platform-cli arch send "I want to build a customer support assistant"
# LLM asks clarifying questions via ask_user — answer them:
kore-platform-cli arch reply ask_<id> --answer '{"channels":["web","slack"]}'
# Continue chatting through INTERVIEW → BLUEPRINT → BUILD → COMPLETE
kore-platform-cli arch chat
```

### Modify an existing project (IN_PROJECT)

```bash
kore-platform-cli projects use <slug>
kore-platform-cli arch session new
kore-platform-cli arch send "Add a refund_lookup tool to the orders agent"
# LLM proposes the change via ask_user / proposal_response
kore-platform-cli arch reply approve_<id> --answer '"approved"'
kore-platform-cli arch summary
```

### Battle-test a prompt change

```bash
# 20 fresh sessions against the same prompt — capture and grep
for i in $(seq 1 20); do
  SID=$(kore-platform-cli arch session new | grep "session created" | awk '{print $4}')
  kore-platform-cli arch send -s "$SID" "Build a 3-agent compliance triage system" \
    > "results/$SID.log" 2>&1
done
grep -c "compile_result.*fail" results/*.log
```

### Checkpoint-driven exploration

```bash
kore-platform-cli arch session new
kore-platform-cli arch send "Build a returns assistant"
kore-platform-cli arch session checkpoints     # find a stable point
kore-platform-cli arch send "Add escalation"
kore-platform-cli arch summary > with-escalation.json

kore-platform-cli arch session rollback <checkpointId>
kore-platform-cli arch send "Add SLA tracking instead"
kore-platform-cli arch summary > with-sla.json

diff with-escalation.json with-sla.json
```

## Architecture (one-paragraph)

`arch` commands are a pure HTTP/SSE client over Studio routes (`/api/arch-ai/*`). No engine code runs in the CLI process — Studio's `process-message.ts` orchestrator runs server-side as it does for the browser. The CLI uses `eventsource-parser` to parse the SSE stream and types events via `ArchSSEEvent` from `@agent-platform/arch-ai`. New tools, specialists, phases, prompts, and models surface in the CLI for free as long as the SSE event union and `MessageRequestSchema` contracts hold.

## What the CLI does not cover

- Visual widget rendering — you see the schema in JSON and respond with `--answer`
- Drag-drop file UX — use `arch files upload <path>` instead
- React-side bugs in `useArchChat`, layout, animations — those are browser-only

For engine bugs, prompt regressions, tool-call ordering, phase-transition correctness, multi-turn behavior, project creation, and IN_PROJECT mutations, the CLI is the faster and more rigorous path than the browser.

## State files

| Path                                       | Contents                                     |
| ------------------------------------------ | -------------------------------------------- |
| `~/.config/kore-platform/credentials.json` | auth tokens (encrypted via `Conf`)           |
| `~/.config/kore-platform/config.json`      | apiUrl, runtimeApiUrl, currentProjectId/Slug |
| `~/.config/kore-platform/arch-cli.json`    | currentSessionId for arch commands           |

Find them on your machine:

```bash
kore-platform-cli config show
```

## Related tools

- `@koredotcom/agents-mcp-tools` (`packages/mcp-debug/`) — same platform, MCP server interface for Claude Code
- `@agent-platform/observatory-cli` (`apps/observatory-cli/`) — Agent DSL Observatory remote debug REPL
- `apps/studio/src/lib/arch-ai/__tests__/build-*-harness.ts` — single-phase deterministic test drivers (different scope)

# Autonomous Development Flow

An AI-driven development workflow for the ABL Platform that replaces heavy upfront planning with fast feedback loops and parallel execution.

## Problems We're Solving

### 1. Slow Planning Cycles (BMAD Problem)

Traditional AI-assisted development follows a waterfall of documents: PRD, user stories, architecture doc, implementation plan — all before any code is written. This takes hours and the documents go stale the moment coding starts.

**Our approach:** A single HLD gets user approval, then an AI-reviewed LLD drives implementation directly. No persona switching, no document chains. Requirements, design, and verification live in three files (`*.hld.md`, `*.lld.md`, `*.changes.md`).

### 2. Sequential Bottleneck

Most AI coding tools work on one task at a time. A feature touching backend, frontend, and shared packages runs sequentially even when the tasks are independent.

**Our approach:** The architect agent decomposes work into independent tasks with zero file overlap, then spawns parallel implementer agents. Each implementer runs its subtasks sequentially (correct order), but multiple implementers run simultaneously (fast throughput).

### 3. Context Loss on Large Changes

When implementing a large feature, the AI's context window fills up. By the time it's fixing tests at the end, it has forgotten what it did at the beginning. Tests get skipped or fixed incorrectly.

**Our approach:** Every implementer writes a **change manifest** — a structured log of what was changed, why, what functions were created, and what tests expect. When tests fail later, the fixing agent reads this file instead of relying on faded context. The manifest is a file on disk, not in the context window, so it never gets lost.

### 4. No Quality Gates

AI coding tools often produce code that looks right but doesn't follow project conventions. Issues like missing tenant isolation, wrong error handling patterns, or forgotten Dockerfile updates slip through.

**Our approach:** Two layers of automated review before any human sees the code:

- **LLD Reviewer** — validates design against 8 preloaded domain skills before implementation starts
- **PR Reviewer** — checks code quality, HLD compliance, runs tests, and gets a second opinion from OpenAI

### 5. Single-LLM Blind Spots

Every LLM has systematic blind spots. Using the same model for writing and reviewing means the same mistakes pass through both stages.

**Our approach:** The PR reviewer gets a second opinion from OpenAI (o3-mini by default) via an MCP server. Different model, different training, different blind spots. The reviewer compares both assessments and flags anything one caught that the other missed.

### 6. No Learning Between Sessions

Each AI session starts from scratch. The same mistakes get made repeatedly: forgetting build order, using wrong logger signatures, missing ModelRegistry registration.

**Our approach:** Each agent has **persistent local memory** that accumulates learnings across sessions. A structured retrospective after each flow identifies what went wrong and writes it to the relevant agent's memory. Next session, the agent reads its memory first.

## How It Works

```
User: "Add retry-failed button for pipeline documents"
  |
  v
Phase 0: EXPLORE — 3 parallel agents scan the codebase
  |
  v
Phase 1: HLD — architect writes High-Level Design
  |
  v
[USER APPROVES HLD]  <-- Human touchpoint #1
  |
  v
Phase 2: LLD + AI REVIEW — detailed design, validated by AI reviewer
  |
  v
Phase 3: IMPLEMENT — parallel agents, each writes to change manifest
  |
  v
Phase 4: REVIEW — Opus reviews code + OpenAI gives second opinion
  |
  v
Phase 5: SUMMARY — sequence flow + results presented to user
  |
  v
[USER REVIEWS PR]  <-- Human touchpoint #2
  |
  v
Phase 6: MANUAL TESTING — guided service startup and test scenarios
  |
  v
Phase 7: DOC UPDATE — architecture docs updated automatically
  |
  v
Phase 8: RETROSPECTIVE — agents learn from this execution
```

Only two human touchpoints: approve the design, review the result. Everything between is autonomous.

## Installation

### Prerequisites

- Claude Code CLI installed (`claude --version` should work)
- Claude Max or Team subscription (Opus model access required)
- Node.js 18+
- pnpm

### Step 1: Pull the Latest Code

The agent definitions, hooks, and settings are committed to the repo under `.claude/`.

### Step 2: Set Up OpenAI Integration (Optional)

The PR reviewer can get a second opinion from OpenAI. This is optional — the flow works without it, the reviewer just skips the OpenAI step.

To enable it:

1. Get an OpenAI API key from https://platform.openai.com/api-keys

2. Add it to your **user-level** Claude settings (never committed to git):

```bash
# Edit your user-level settings
# On macOS: ~/.claude/settings.json
# Add or merge:
{
  "env": {
    "OPENAI_API_KEY": "sk-your-key-here",
    "OPENAI_MODEL": "o3-mini"
  }
}
```

3. Build the MCP server:

```bash
cd packages/mcp-openai-reviewer
pnpm install
pnpm build
```

### Step 3: Run the Flow

```bash
# Launch the architect agent
claude --agent architect

# Give it any development task
> Add retry-failed button for pipeline documents
```

The architect takes over from there. It will ask you to approve the HLD, then work autonomously until it presents the completed implementation for review.

## File Structure

```
.claude/
  agents/
    architect.md          # Lead orchestrator (8 phases)
    explorer.md           # Codebase exploration (read-only)
    lld-reviewer.md       # Design validation (8 domain skills)
    implementer.md        # Task implementation + change manifest
    pr-reviewer.md        # Final review + OpenAI second opinion
  hooks/
    verify-implementer.sh # Quality gate: blocks if failures unresolved
  settings.json           # Model=opus, permissions, hooks config
  agent-memory-local/     # Per-user persistent memory (gitignored)
    architect/MEMORY.md
    lld-reviewer/MEMORY.md
    implementer/MEMORY.md
    pr-reviewer/MEMORY.md

packages/
  mcp-openai-reviewer/    # MCP server wrapping OpenAI API
    src/index.ts           # review_code tool
    package.json
    tsconfig.json

docs/specs/               # Output directory for HLD, LLD, change manifests
  {feature}.hld.md        # High-Level Design (user-approved)
  {feature}.lld.md        # Low-Level Design (AI-reviewed)
  {feature}.changes.md    # Change manifest (implementation journal)
```

## Three Layers of Memory

| Layer               | File                                      | What It Tracks                                         | Survives                     |
| ------------------- | ----------------------------------------- | ------------------------------------------------------ | ---------------------------- |
| **Change manifest** | `docs/specs/{feature}.changes.md`         | What was done in this feature, why, what tests expect  | Committed with the feature   |
| **Agent memory**    | `.claude/agent-memory-local/`             | Patterns, gotchas, blind spots learned across features | Across sessions (local only) |
| **Design docs**     | `docs/specs/{feature}.hld.md` + `.lld.md` | What should be built and how                           | Committed with the feature   |

## Configuration

### Model

All agents use Opus by default (set in `.claude/settings.json`). This is the strongest reasoning model and gives the best results for architecture review and implementation.

### Permissions

Pre-allowed commands are configured in `.claude/settings.json` so you're not interrupted during autonomous execution. Review the allow list and adjust if needed.

### OpenAI Model

The default is `o3-mini` (strong reasoning, low cost). Change via the `OPENAI_MODEL` environment variable in your user-level `~/.claude/settings.json`.

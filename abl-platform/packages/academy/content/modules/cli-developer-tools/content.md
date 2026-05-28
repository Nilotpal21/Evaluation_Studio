# CLI & Developer Tools

> **Estimated time**: 38 minutes | **Prerequisites**: Terminal/command-line familiarity, basic understanding of Agent Platform concepts

## Learning Objectives

After completing this module, you will be able to:

- Install and configure the Agent Platform CLI
- Manage projects, agents, and deployments from the command line
- Use local development workflows for editing, validating, and testing agents
- Deploy agents to environments and manage rollbacks via CLI
- Integrate CLI commands into CI/CD pipelines for automated workflows

## Overview

The Agent Platform CLI (`abl`) is a command-line interface for managing the full agent lifecycle without opening Studio. It is designed for developers who prefer terminal-based workflows, teams that manage agent definitions as code, and CI/CD pipelines that need automated deployment.

### When to Use the CLI vs. Studio

| Task                                 | Best Tool |
| ------------------------------------ | --------- |
| Visual agent design and flow editing | Studio    |
| Quick agent testing with debug panel | Studio    |
| Bulk operations across projects      | CLI       |
| CI/CD deployment automation          | CLI       |
| Pre-commit validation hooks          | CLI       |
| Scripted evaluation runs             | CLI       |
| Agent definition version control     | CLI + Git |

The CLI and Studio work on the same data -- changes made in one are immediately visible in the other.

## Installation & Configuration

### Installing the CLI

```bash
# Install via npm (recommended)
npm install -g @agent-platform/cli

# Verify installation
abl --version
```

### Authentication

Connect the CLI to your Agent Platform instance:

```bash
# Interactive login
abl login

# Enter your platform URL and API key when prompted:
# Platform URL: https://your-platform-instance.com
# API Key: ********

# Verify connection
abl whoami
# Output: Authenticated as user@example.com (Workspace: My Workspace)
```

> **Key Concept**: The `abl login` command stores credentials in `~/.abl/config`. You can configure multiple profiles for different environments (development, staging, production) using `abl login --profile staging`. Switch between profiles with `abl use-profile staging`.

### Configuration File

The CLI reads configuration from `~/.abl/config`:

```yaml
profiles:
  default:
    url: https://platform.example.com
    api_key: '***'
  staging:
    url: https://staging.platform.example.com
    api_key: '***'
current_profile: default
```

## Project & Agent Management

### Working with Projects

```bash
# List all projects in the workspace
abl projects list

# Set the active project (used by subsequent commands)
abl projects use my-banking-project

# Show project details
abl projects info
# Output: Project: my-banking-project
#         Agents: 8
#         Active deployment: dep-abc123 (production)
#         Last modified: 2026-03-30
```

### Managing Agents

```bash
# List agents in the active project
abl agents list
# Output:
# NAME                 VERSION   STATUS
# Supervisor           2.1.0     active
# Flight_Search        1.3.0     active
# Hotel_Search         1.0.0     active
# Payment_Handler      1.1.0     testing

# Show agent details
abl agents info Supervisor
# Output: Model chain, tools, handoff targets, version history

# Download agent definition to a local file
abl agents pull Supervisor --output ./agents/supervisor.abl

# Upload a local agent definition
abl agents push ./agents/supervisor.abl
```

### Validation

```bash
# Validate a single agent file
abl validate ./agents/supervisor.abl
# Output: ✓ supervisor.abl - valid (0 errors, 0 warnings)

# Validate all agent files in a directory
abl validate ./agents/
# Output:
# ✓ supervisor.abl - valid
# ✓ flight_search.abl - valid
# ✗ hotel_search.abl - 2 errors:
#   Line 15: Undefined step reference 'confirm_booking'
#   Line 23: GATHER field 'checkin_date' missing TYPE declaration

# Validate with strict mode (warnings become errors)
abl validate --strict ./agents/
```

> **Key Concept**: The `abl validate` command runs the ABL compiler's parse and validation stages **without deploying**. It catches syntax errors, undefined references, invalid step transitions, and type mismatches. This is ideal for **pre-commit hooks** -- validate agent files before they enter version control, catching errors at the earliest possible point in the development workflow.

## Local Development Workflows

### Edit-Validate-Push Cycle

The standard development workflow with the CLI:

```bash
# 1. Pull the latest agent definitions
abl agents pull --all --output ./agents/

# 2. Edit agent files in your preferred editor
code ./agents/supervisor.abl

# 3. Validate changes
abl validate ./agents/

# 4. Push changes back to the platform
abl agents push ./agents/supervisor.abl

# 5. Test in Studio or via CLI chat
abl chat --agent Supervisor
```

### Interactive Chat

Test agents directly from the terminal:

```bash
# Start an interactive chat session
abl chat --agent Supervisor --environment staging

# Output:
# Connected to Supervisor (staging)
# Type your messages below. Ctrl+C to exit.
#
# You: I need to book a flight from SFO to JFK
# Agent: I'd be happy to help you book a flight from San Francisco to New York.
#        What date would you like to travel?
# You: Next Friday
# Agent: I found 3 flights for next Friday...
```

Options for the chat command:

```bash
# Chat with verbose mode (shows trace events)
abl chat --agent Supervisor --verbose

# Chat with a specific session ID (resume a conversation)
abl chat --agent Supervisor --session sess-abc123

# Chat with metadata
abl chat --agent Supervisor --metadata '{"user_id": "test-user"}'
```

### Watching for Changes

During active development, use watch mode to automatically validate on file changes:

```bash
# Watch agent files and validate on change
abl validate --watch ./agents/
# Output:
# Watching ./agents/ for changes...
# [12:01:03] supervisor.abl changed - validating... ✓ valid
# [12:01:15] flight_search.abl changed - validating... ✗ 1 error
#   Line 8: Unknown tool reference 'search_flights_v2'
```

## Deployment & Operations

### Creating Deployments

```bash
# Deploy to an environment
abl deploy \
  --project my-banking-project \
  --environment production \
  --entry-agent Supervisor \
  --label "v2.1 - Hotel search feature"

# Deploy with specific agent versions
abl deploy \
  --environment staging \
  --entry-agent Supervisor \
  --versions "Supervisor=2.1.0,Flight_Search=1.3.0"

# Deploy with auto-versioning (creates versions from current working copies)
abl deploy \
  --environment staging \
  --entry-agent Supervisor \
  --auto-version
```

### Listing and Managing Deployments

```bash
# List deployments
abl deployments list --environment production
# Output:
# ID           STATUS     CREATED              LABEL
# dep-xyz789   active     2026-03-30 14:20     v2.1 - Hotel search
# dep-xyz788   draining   2026-03-28 10:15     v2.0 - Initial release
# dep-xyz787   retired    2026-03-25 09:00     v1.9 - Bug fixes

# Rollback a deployment
abl deployments rollback dep-xyz789
# Output: Rolled back. dep-xyz788 is now active.

# Promote staging to production
abl deployments promote dep-staging-123 --target production
```

> **Key Concept**: The `abl deploy` command validates all agent definitions before deploying. If any agent has compilation errors, the deployment is rejected. This is the same safety gate that protects GitOps auto-deploy -- broken agent code never reaches a live environment.

### Environment Variables

```bash
# List environment variables
abl env list --environment production

# Set a variable
abl env set API_BASE_URL "https://api.example.com" --environment production

# Set a secret variable
abl env set PAYMENT_API_KEY "sk-xxx" --secret --environment production

# Delete a variable
abl env delete FEATURE_OLD_FLOW --environment production
```

## Export & Import

```bash
# Export the entire project
abl export --output ./project-backup/

# Export specific agents
abl export --agents Supervisor,Flight_Search --output ./agents-backup/

# Import agents into a project
abl import ./agents-backup/ --preview
# Output:
# Preview: 2 agents will be imported
#   Supervisor - new version will be created
#   Flight_Search - no changes detected (skipped)
# Proceed? [y/N]

abl import ./agents-backup/ --confirm
```

## Scripting & CI/CD Automation

### Pre-Commit Hook

Add ABL validation as a Git pre-commit hook:

```bash
#!/bin/bash
# .git/hooks/pre-commit

# Find all modified .abl files
ABL_FILES=$(git diff --cached --name-only --diff-filter=ACM | grep '\.abl$')

if [ -n "$ABL_FILES" ]; then
  echo "Validating ABL files..."
  abl validate $ABL_FILES
  if [ $? -ne 0 ]; then
    echo "ABL validation failed. Fix errors before committing."
    exit 1
  fi
fi
```

### CI/CD Pipeline Example

```yaml
# .github/workflows/deploy-agents.yml
name: Deploy Agents

on:
  push:
    branches: [main]
    paths: ['agents/**']

jobs:
  validate-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install CLI
        run: npm install -g @agent-platform/cli

      - name: Authenticate
        run: abl login --non-interactive --url ${{ secrets.PLATFORM_URL }} --api-key ${{ secrets.API_KEY }}

      - name: Validate agents
        run: abl validate --strict ./agents/

      - name: Deploy to staging
        run: |
          abl deploy \
            --project ${{ vars.PROJECT_ID }} \
            --environment staging \
            --entry-agent Supervisor \
            --auto-version \
            --label "CI build #${{ github.run_number }}"

      - name: Run evaluation suite
        run: |
          abl evals run regression-suite --wait
          SCORE=$(abl evals results --format json | jq '.average_score')
          if (( $(echo "$SCORE < 4.0" | bc -l) )); then
            echo "Quality gate failed: score=$SCORE"
            exit 1
          fi

      - name: Promote to production
        if: success()
        run: |
          STAGING_ID=$(abl deployments list --environment staging --format json | jq -r '.[0].id')
          abl deployments promote $STAGING_ID --target production
```

### Non-Interactive Mode

For CI/CD environments, the CLI supports non-interactive authentication and JSON output:

```bash
# Authenticate without prompts
abl login --non-interactive --url https://platform.example.com --api-key $API_KEY

# JSON output for scripting
abl agents list --format json | jq '.[] | select(.status == "active")'
abl deployments list --format json | jq '.[0].id'

# Exit codes for automation
abl validate ./agents/ && echo "Valid" || echo "Invalid"
```

## Command Reference

### Core Commands

| Command                    | Description                        |
| -------------------------- | ---------------------------------- |
| `abl login`                | Authenticate with the platform     |
| `abl whoami`               | Show current authentication status |
| `abl projects list`        | List workspace projects            |
| `abl projects use <name>`  | Set active project                 |
| `abl agents list`          | List agents in active project      |
| `abl agents pull`          | Download agent definitions         |
| `abl agents push`          | Upload agent definitions           |
| `abl validate`             | Validate ABL files offline         |
| `abl chat`                 | Interactive agent testing          |
| `abl deploy`               | Create a deployment                |
| `abl deployments list`     | List deployments                   |
| `abl deployments rollback` | Rollback a deployment              |
| `abl export`               | Export project data                |
| `abl import`               | Import agents into a project       |
| `abl env list/set/delete`  | Manage environment variables       |
| `abl evals run`            | Run an evaluation suite            |

### Global Flags

| Flag               | Description                           |
| ------------------ | ------------------------------------- |
| `--profile <name>` | Use a specific authentication profile |
| `--project <id>`   | Override active project               |
| `--format json`    | Output in JSON format                 |
| `--verbose`        | Show detailed output                  |
| `--quiet`          | Suppress non-essential output         |

## Key Takeaways

- The CLI enables terminal-based agent management, code-as-configuration workflows, and CI/CD automation
- `abl validate` catches errors offline -- use it in pre-commit hooks and CI pipelines to prevent broken agent definitions from reaching the platform
- `abl chat` provides interactive agent testing from the terminal with optional verbose mode for trace inspection
- `abl deploy` validates before deploying -- broken agent code never reaches a live environment
- Non-interactive mode with JSON output makes the CLI scriptable for automation pipelines

## What's Next

Explore the **Python SDK** module for programmatic integration in custom applications, or the **Production Deployment** module for deployment lifecycle management, environment variables, and channel configuration.

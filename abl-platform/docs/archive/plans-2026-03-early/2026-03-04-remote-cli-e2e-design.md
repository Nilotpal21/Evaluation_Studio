# Remote CLI E2E Test Design

**Date**: 2026-03-04
**Goal**: E2E test that authenticates to `abl-dev.kore.com` via CLI device auth, creates a project, authors an agent, tests it, and cleans up.

## Architecture

**Test type**: Vitest integration test in `packages/kore-platform-cli/src/__tests__/e2e/`
**Auth method**: Reuses credentials from `kore-platform-cli login` (stored in `~/.config/kore-platform/credentials.json`)
**Target**: `KORE_API_URL=https://abl-dev.kore.com` (configurable via env)

## Test Flow

```
Prerequisites: Run `KORE_API_URL=https://abl-dev.kore.com kore-platform-cli login` once manually

Phase 1: Auth Verification
  - Read stored credentials
  - Verify token is valid (auto-refresh if expired)
  - Call whoami equivalent (list projects as health check)

Phase 2: Project Lifecycle
  - Create project "cli-e2e-test-{timestamp}"
  - List projects, verify it appears
  - Select project

Phase 3: Agent Authoring
  - Create a reasoning agent with simple DSL
  - List agents, verify it appears
  - Get agent DSL, verify content
  - Update agent DSL with modified version
  - Compile agent, verify success

Phase 4: Agent Testing
  - Test conversation (send 2 messages, verify responses)
  - Run test scenario with expectations
  - Get test results/traces

Phase 5: Cleanup
  - Delete project (with --force equivalent)
  - Verify deletion
```

## Key Decisions

1. **Vitest over shell script**: Structured assertions, timeout handling, proper cleanup via `afterAll`
2. **Library imports**: Uses `api-client.ts` directly rather than spawning CLI subprocesses
3. **Guard clause**: Test skips with clear message if not authenticated (no credentials found)
4. **Unique naming**: Timestamp-based project names prevent collisions
5. **Cleanup in afterAll**: Always attempts cleanup even if tests fail
6. **Configurable timeout**: Remote tests need longer timeouts (60s per test, 5min suite)

## Files

| File                                                                       | Purpose        |
| -------------------------------------------------------------------------- | -------------- |
| `packages/kore-platform-cli/src/__tests__/e2e/remote-platform.e2e.test.ts` | Main test file |

## Sample Agent DSL

```abl
AGENT remote_e2e_agent
MODE reasoning
MODEL default

GOAL:
  Help users with general questions. Be concise and helpful.

CONSTRAINTS:
  - Always be polite
  - Keep responses under 100 words
```

# ABL Platform - Development Guide

> **Last Updated**: 2026-03-16

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Quick Start](#2-quick-start)
3. [Project Structure](#3-project-structure)
4. [APX CLI & Development Workflow](#4-apx-cli--development-workflow)
5. [Testing](#5-testing)
6. [Contributing](#6-contributing)
7. [Code Style & Architecture Best Practices](#7-code-style--architecture-best-practices)
8. [Debugging & Observability](#8-debugging--observability)
9. [Release Management](#9-release-management)
10. [Production Deployment](#10-production-deployment)
11. [Troubleshooting](#11-troubleshooting)
12. [Claude Code Integration](#12-claude-code-integration)

---

## 1. Prerequisites

### Required Tools

| Tool               | Minimum Version | Check Command      | Install                 |
| ------------------ | --------------- | ------------------ | ----------------------- |
| **Node.js**        | 18.0.0+         | `node --version`   | https://nodejs.org      |
| **pnpm**           | 8.0.0+          | `pnpm --version`   | `npm install -g pnpm`   |
| **Git**            | 2.0+            | `git --version`    | https://git-scm.com     |
| **Docker Desktop** | 4.0+            | `docker --version` | https://docker.com      |
| **gitleaks**       | latest          | `gitleaks version` | `brew install gitleaks` |

### Optional Tools

| Tool              | Purpose                                                   |
| ----------------- | --------------------------------------------------------- |
| **VS Code**       | Recommended IDE with ABL extension                        |
| **ABL Extension** | `packages/abl-vscode` -- syntax highlighting, diagnostics |
| **mongosh**       | MongoDB shell for direct database access                  |
| **PM2**           | Process manager (`npx pm2`)                               |

### Environment Variables

Copy the example env file and configure required values:

```bash
cp .env.example .env
```

#### Required Variables

```bash
# MongoDB connection
MONGODB_URL=mongodb://abl_admin:abl_dev_password@localhost:27018/abl_platform?authSource=admin&directConnection=true

# JWT secret (generate: openssl rand -base64 64)
JWT_SECRET="your-generated-jwt-secret"

# Encryption key -- REQUIRED, runtime will not start without it
# Generate: openssl rand -hex 32
ENCRYPTION_MASTER_KEY="64-char-hex-string"

# Redis
REDIS_PASSWORD=abl_dev_password
```

#### Optional Variables

```bash
# LLM features (required for agent execution)
ANTHROPIC_API_KEY="sk-ant-..."
```

---

## 2. Quick Start

```bash
# Clone and install
git clone git@bitbucket.org:koreteam1/abl-platform.git && cd abl-platform
pnpm install

# Configure environment
cp .env.example .env
# Edit .env -- at minimum set ENCRYPTION_MASTER_KEY (openssl rand -hex 32)

# Start Docker infrastructure (MongoDB, Redis, ClickHouse, Kafka, etc.)
./apx up infra

# Build all packages (required before first run)
pnpm build

# For systems with 8GB RAM or less, use low-memory build mode
pnpm build:low-mem

# Start development servers with hot reload
pnpm dev
```

### Access Points

| Service     | URL                   | Description                  |
| ----------- | --------------------- | ---------------------------- |
| **Studio**  | http://localhost:5173 | Visual IDE and management UI |
| **Runtime** | http://localhost:3112 | Agent execution API          |
| **Admin**   | http://localhost:3003 | Administration panel         |

---

## 3. Project Structure

### Applications (`apps/`)

| App                    | Port | Description                         |
| ---------------------- | ---- | ----------------------------------- |
| **runtime**            | 3112 | Agent execution engine              |
| **studio**             | 5173 | Next.js visual IDE                  |
| **admin**              | 3003 | Next.js administration panel        |
| **search-ai**          | 3113 | Search & ingestion pipeline         |
| **search-ai-runtime**  | 3114 | Search query execution              |
| **workflow-engine**    | --   | BullMQ-based workflow orchestration |
| **observatory-cli**    | --   | CLI for runtime debugging           |
| **nlu-sidecar**        | --   | NLU intent/entity extraction        |
| **multimodal-service** | --   | Multimodal processing               |
| **telco-noc**          | --   | Telecom NOC dashboard               |

### Key Packages (`packages/`, ~38 total)

| Package                  | Scope                         | Description                             |
| ------------------------ | ----------------------------- | --------------------------------------- |
| **core**                 | `@abl/core`                   | Parser, lexer, AST types                |
| **compiler**             | `@abl/compiler`               | DSL to IR compilation, platform utils   |
| **database**             | `@abl/database`               | MongoDB models, connection management   |
| **config**               | `@abl/config`                 | Shared configuration and port constants |
| **shared-kernel**        | `@abl/shared-kernel`          | Domain primitives, value objects        |
| **shared-auth**          | `@abl/shared-auth`            | Auth middleware, JWT, permissions       |
| **shared-observability** | `@abl/shared-observability`   | Logging, metrics, tracing               |
| **redis**                | `@abl/redis`                  | Redis client, distributed locks         |
| **llm**                  | `@abl/llm`                    | LLM provider abstraction                |
| **execution**            | `@abl/execution`              | Agent execution engine                  |
| **eventstore**           | `@abl/eventstore`             | Event sourcing, trace storage           |
| **pipeline-engine**      | `@abl/pipeline-engine`        | Data pipeline orchestration             |
| **project-io**           | `@abl/project-io`             | Project import/export                   |
| **connectors**           | `@abl/connectors`             | External system connectors              |
| **agent-transfer**       | `@abl/agent-transfer`         | Agent handoff protocol                  |
| **circuit-breaker**      | `@abl/circuit-breaker`        | Resilience patterns                     |
| **observatory**          | `@agent-platform/observatory` | React debug components                  |
| **mcp-debug**            | `@agent-platform/mcp-debug`   | MCP server debug tools                  |
| **i18n**                 | `@abl/i18n`                   | Internationalization                    |
| **a2a**                  | `@abl/a2a`                    | Agent-to-agent protocol                 |
| **abl-lsp-server**       | --                            | Language server protocol                |
| **abl-vscode**           | --                            | VS Code extension                       |
| **sizing-calculator**    | --                            | Infrastructure sizing                   |
| **admin-ui**             | --                            | Shared admin UI components              |
| **openapi**              | --                            | OpenAPI spec generation                 |
| **search-ai-sdk**        | --                            | SearchAI client SDK                     |
| **web-sdk**              | --                            | Browser client SDK                      |

### Python Services (`services/`)

| Service                   | Port | Description                         |
| ------------------------- | ---- | ----------------------------------- |
| **docling-service**       | 8080 | PDF/document extraction (FastAPI)   |
| **bge-m3-service**        | 8000 | BGE-M3 embedding (Flask/Gunicorn)   |
| **preprocessing-service** | 8003 | Text preprocessing (Flask/Gunicorn) |
| **codetool-sandbox**      | --   | Sandboxed code execution            |

### Root Files

```
abl-platform/
├── apx                      # CLI tool for Docker, builds, releases
├── docker-compose.yml       # Infrastructure services
├── package.json             # Root workspace config
├── pnpm-workspace.yaml      # pnpm workspace definition
├── turbo.json               # Turborepo build pipeline
├── tsconfig.json            # Base TypeScript config
├── .env.example             # Environment variable template
├── CLAUDE.md                # Claude Code instructions
└── DEVELOPMENT.md           # This file
```

---

## 4. APX CLI & Development Workflow

### APX Commands

The `./apx` script manages Docker infrastructure, builds, and releases.

#### Infrastructure Groups

```bash
./apx up [groups]       # Start service groups
./apx down [groups]     # Stop service groups
./apx restart <service> # Restart a specific service
./apx logs [service]    # View logs (all or specific service)
./apx status            # Show running services
./apx build             # Build all packages
./apx rebuild [service] # Rebuild Docker image(s)
```

#### Available Groups

| Group             | Services                                  |
| ----------------- | ----------------------------------------- |
| **core**          | mongo, redis, clickhouse                  |
| **streaming**     | kafka                                     |
| **orchestration** | restate, workflow-engine, pipeline-engine |
| **nlu**           | nlu-sidecar                               |
| **search**        | opensearch, bge-m3, preprocessing         |
| **docs**          | docling                                   |
| **sandbox**       | codetool-sandbox                          |
| **graph**         | neo4j, qdrant                             |
| **infra**         | core + streaming + orchestration + nlu    |
| **apps**          | runtime, studio, admin (via PM2)          |
| **all**           | Everything                                |

Common usage:

```bash
# Minimal development setup
./apx up infra

# Full stack including search
./apx up infra search docs

# Check what is running
./apx status
```

### pnpm Commands

```bash
pnpm dev                    # Start runtime + studio in dev mode with hot reload
pnpm build                  # Build all packages (Turborepo cached)
pnpm test                   # Run all tests
pnpm typecheck              # TypeScript type checking across all packages
pnpm build --filter=<pkg>   # Build a specific package
pnpm test --filter=<pkg>    # Test a specific package
```

**IMPORTANT**: Always run `pnpm build` before `pnpm test`. Turbo enforces build order and tests will fail on stale compiled output.

### Hot Reload

| Service     | Mechanism             |
| ----------- | --------------------- |
| **Runtime** | tsx watch             |
| **Studio**  | Next.js Turbopack HMR |
| **Admin**   | Next.js webpack HMR   |

---

## 5. Testing

### Framework

Tests use **Vitest** across all packages.

```bash
# Run all tests
pnpm test

# Fast parallel tests (~30s)
pnpm test:fast

# Specific package
pnpm test --filter=@abl/compiler

# Watch mode for TDD
pnpm test --filter=@abl/core -- --watch
```

### Build Before Test

Turbo requires packages to be built before testing. If tests fail with import errors, run `pnpm build` first.

### Low-Memory Mode

For systems with **8GB RAM or less** (e.g., Docker containers with memory limits), use low-memory build and test modes:

```bash
# Low-memory build (7GB Node heap, concurrency=1, ~5-8 min)
pnpm build:low-mem

# Low-memory tests (6GB Node heap, concurrency=1)
pnpm test:low-mem
```

**What LOW_MEM does:**

- Reduces parallelism (`concurrency=1` instead of 3-4)
- Increases Node.js heap size (7GB for builds, 6GB for tests)
- Enables garbage collection (`--expose-gc`)
- Studio build is isolated to prevent OOM

**Pre-push hook support:**

```bash
# Use low-memory mode in pre-push hook (15-minute timeouts)
LOW_MEM=1 git push origin develop
```

### Pre-push Hook

The pre-push hook runs diff-aware build, typecheck, and test steps, always runs the architecture fitness gate (`@agent-platform/shared-kernel` `test:fast` plus `pnpm boundary-check`), and conditionally runs Semgrep when a push touches security-sensitive files such as auth, crypto, routes, middleware, or validation code.

---

## 6. Contributing

### Branch Strategy

Branch from **`develop`** -- not `master` or `main`. The `main` branch is reserved for releases only.

```
feature/ABLP-123-add-memory-store   # New features
fix/ABLP-456-session-timeout        # Bug fixes
refactor/simplify-parser            # Code improvements
```

### Commit Message Format

```
[ABLP-N] type(scope): description

# Examples:
[ABLP-42] feat(compiler): add guardrails compilation
[ABLP-88] fix(runtime): handle session timeout correctly
[ABLP-12] test(e2e): add conversation flow tests
[ABLP-55] refactor(parser): simplify token handling
```

**Types**: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `style`, `perf`

### Pre-commit Hooks

Two hooks run on every commit:

1. **gitleaks** -- scans for secrets (API keys, passwords, tokens)
2. **lint-staged** -- runs `prettier --check` on staged files

If `prettier --check` fails, lint-staged will silently revert your changes. Always run `npx prettier --write <files>` before committing.

### Pre-push Hooks

1. **Dockerfile validation** -- checks Dockerfile consistency
2. **Build** -- diff-aware build (only affected packages)
3. **test:fast** -- parallel test suite

**Skip options:**

```bash
SKIP_BUILD=1 git push       # Skip build step
SKIP_TESTS=1 git push       # Skip all tests
SKIP_LINT=1 git push        # Skip lint + validation
LOW_MEM=1 git push          # Use low-memory mode (8GB RAM)
```

### Pull Request Process

```
feature branch --> develop --> release/YYYY.MM.patch --> main
```

1. Create a feature branch from `develop`
2. Write tests for new functionality
3. Run `pnpm build && pnpm test`
4. Run `pnpm typecheck`
5. Open PR targeting `develop`
6. Address review feedback

---

## 7. Code Style & Architecture Best Practices

### Coding Rules

These rules are enforced by code review and CI:

- **No `console.log` in server code** -- use `createLogger('module')` from `@abl/compiler/platform`
- **No `.catch(() => {})`** -- log or propagate every error
- **Safe error access**: `err instanceof Error ? err.message : String(err)` -- never `(err as Error).message`
- **Async file I/O**: `fs.promises` for all file I/O -- no sync I/O in async paths
- **No `any`** where structured types exist -- use discriminated unions
- **No magic numbers** -- named constants or config values
- **Provider-neutral LLM types**: `LLMToolDefinition`, `LLMToolCall`, `LLMToolResult`
- **No domain-specific field names in engine code** -- use IR metadata
- **In-memory Maps**: every `Map` needs max size, TTL, and eviction
- **Failure responses**: return `{ success, data?, error?: { code, message } }` -- not `{}`
- **Express route ordering**: static routes (`/tab-stats`, `/review`) MUST be registered BEFORE parameterized routes (`/:mappingId`). Express matches top-down.
- **Dockerfile sync**: when adding a new `packages/<name>/`, add its `COPY packages/<name>/package.json` line to every Dockerfile under `apps/`.

### Six Core Invariants

Every feature must respect these invariants:

#### 1. Resource Isolation

Scope every query to the appropriate ownership level:

- **Tenant**: every query includes `tenantId`. Use `findOne({_id, tenantId})`, never `findById`.
- **Project**: use `requireProjectPermission(req, res, 'obj:op')`, verify `resource.projectId === req.params.projectId`.
- **User**: filter by `createdBy`/`ownerId`.
- Cross-scope access returns **404** (not 403) to avoid leaking existence.

#### 2. Centralized Auth

Use `createUnifiedAuthMiddleware` / `requireAuth`. Never write custom token verification. Permissions via `requirePermission()`.

#### 3. Stateless Distributed

No pod-local state as source of truth. Redis/MongoDB for all shared state. Distributed locks via Redis `SET NX PX`.

#### 4. Traceability

Every execution path emits `TraceEvent`s via the shared `TraceStore`. No ad-hoc logging as a substitute for structured traces.

#### 5. Compliance

Encryption at rest and in transit. Data minimization with TTLs. Right-to-erasure cascades. Audit logging for sensitive operations.

#### 6. Performance

Compress before storing (async gzip). Validate payload size at boundaries. Batch operations. Conversation sliding windows.

### Import Organization

```typescript
// 1. Node.js built-ins
import crypto from 'crypto';
import { EventEmitter } from 'events';

// 2. External packages
import express from 'express';
import { z } from 'zod';

// 3. Internal packages (@abl/*, @agent-platform/*)
import { parseDSL } from '@abl/core';
import { compileDSLtoIR } from '@abl/compiler';

// 4. Relative imports
import { MyService } from './services/my-service.js';
import type { MyType } from './types/index.js';
```

---

## 8. Debugging & Observability

### MCP Debug Tools

Connect to the runtime at `localhost:3112` for live debugging:

| Tool                    | Description                                               |
| ----------------------- | --------------------------------------------------------- |
| `debug_connect`         | Connect to running runtime server                         |
| `debug_diagnose`        | Full diagnosis (config + execution + traces)              |
| `debug_inspect`         | Agent config inspection (model chain, credentials, tools) |
| `debug_get_errors`      | All errors and warnings from traces                       |
| `debug_analyze_session` | Automated session diagnostics                             |

### Symptom-Based Debugging

| Symptom          | First Tool              | What to Look For                                      |
| ---------------- | ----------------------- | ----------------------------------------------------- |
| Empty response   | `debug_diagnose`        | Model not configured, credential missing              |
| Agent init error | `debug_inspect`         | Model chain resolution, credentials                   |
| Wrong agent      | `debug_analyze_session` | Handoff routing, decision logs                        |
| Session hangs    | `debug_analyze_session` | Gather stalls, loop detection, tool timeouts          |
| Tool call fails  | `debug_get_errors`      | Tool binding errors, HTTP failures, schema mismatches |

### Observatory

The Observatory is a Studio UI panel providing:

- Real-time trace visualization
- Agent state inspection
- Hierarchical span trees
- Error highlighting and drill-down

Access it from the Studio sidebar when a runtime is connected.

---

## 9. Release Management

### Versioning

The project uses **CalVer**: `YYYY.MM.patch` (e.g., `2026.03.0`).

### Three Repositories

| Repository              | Purpose                       |
| ----------------------- | ----------------------------- |
| **abl-platform**        | Source code (this repo)       |
| **abl-platform-deploy** | Helm charts, ArgoCD manifests |
| **abl-platform-infra**  | Terraform infrastructure      |

### Release Flow

```
develop --> release/YYYY.MM.patch --> main
```

### APX Release Commands

```bash
./apx release cut          # Create release branch from develop
./apx release finalize     # Merge release to main, tag, back-merge to develop
./apx release status       # Show current release state
./apx release changelog    # Generate changelog from commits
```

### Hotfix Flow

```bash
./apx hotfix create        # Branch from main for urgent fix
./apx hotfix finalize      # Merge to main and back-merge to develop
```

---

## 10. Production Deployment

### Infrastructure Requirements

| Component      | Version/Requirement |
| -------------- | ------------------- |
| **MongoDB**    | 7+ (replica set)    |
| **Redis**      | 7+ (with auth)      |
| **ClickHouse** | 24+                 |
| **Kafka**      | 4.2+                |
| **Restate**    | 1.6+                |
| **Node.js**    | 20+ LTS             |
| **OpenSearch** | 2.11+               |

### Docker Images

Each app under `apps/` has a multi-stage Dockerfile producing distroless Node 22 images. Build with:

```bash
docker build -f apps/runtime/Dockerfile -t abl-runtime .
docker build -f apps/studio/Dockerfile -t abl-studio .
docker build -f apps/admin/Dockerfile -t abl-admin .
```

### Helm & ArgoCD

Helm charts live in the `abl-platform-deploy` repository. ArgoCD watches the deploy repo for GitOps-driven rollouts.

### Production Checklist

- [ ] MongoDB replica set with TLS enabled
- [ ] Redis with authentication configured
- [ ] ClickHouse deployed for analytics
- [ ] `ENCRYPTION_MASTER_KEY` identical across runtime, workflow-engine, and pipeline-engine
- [ ] Helm values configured for target environment
- [ ] TLS termination at load balancer or ingress
- [ ] Secrets stored in vault (not environment files)
- [ ] Health check endpoints verified
- [ ] Monitoring and alerting configured

---

## 11. Troubleshooting

### Common Issues

#### Docker won't start

```bash
# Check for port conflicts
docker compose ps
# Nuclear reset (destroys volumes)
docker compose down -v
```

#### Build fails

```bash
pnpm install          # Reinstall dependencies
pnpm build --force    # Force rebuild without cache
```

#### Tests fail

Always build before testing:

```bash
pnpm build
pnpm test
```

#### Module not found

```bash
pnpm install          # Refresh workspace resolution
```

#### Port already in use

```bash
lsof -i :3112        # Find process using port
kill <PID>            # Kill it
```

#### EMFILE: too many open files

Kill zombie tsx watch processes:

```bash
pkill -f "tsx.*watch"
```

#### Pre-commit hook fails (prettier)

```bash
npx prettier --write <files>
```

#### gitleaks not found

```bash
brew install gitleaks
```

---

## 12. Claude Code Integration

The project includes `CLAUDE.md` at the root with coding rules, core invariants, and a skills reference table. Claude Code reads this automatically.

**MCP debug tools** connect to the runtime for live agent debugging (see [Section 8](#8-debugging--observability)).

**Skills system** provides on-demand domain knowledge. Key skills include `studio-design-system`, `search-ai-development`, `infrastructure-guide`, `i18n-guide`, `bullmq-flows-guide`, `analytics-pipeline-development`, and others listed in `CLAUDE.md`.

---

_Maintained by the ABL Platform Team_

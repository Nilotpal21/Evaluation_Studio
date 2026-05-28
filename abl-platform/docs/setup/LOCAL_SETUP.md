# Agent Platform v2 — Local Setup Guide

Step-by-step guide to run the Agent Platform locally.

---

## Prerequisites

| Tool    | Version   | Install                             |
| ------- | --------- | ----------------------------------- |
| Node.js | >= 18.0.0 | https://nodejs.org                  |
| pnpm    | >= 8.0.0  | `npm install -g pnpm@8`             |
| Docker  | latest    | https://docs.docker.com/get-docker/ |

PM2 is included as a devDependency — no global install required.

Docker is used for all infrastructure services (MongoDB, Redis, ClickHouse, Kafka, etc.).

---

## 1. Clone and Install

```bash
git clone git@bitbucket.org:koreteam1/abl-platform.git
cd abl-platform
pnpm install
```

`pnpm install` also runs `postinstall` hooks that generate the Prisma client automatically.

---

## 2. Environment Configuration

Copy the example env files and edit them with your keys:

```bash
# Runtime API
cp apps/runtime/.env.example apps/runtime/.env

# Studio frontend
cp apps/studio/.env.example apps/studio/.env.local

# Admin dashboard
cp apps/admin/.env.example apps/admin/.env.local
```

### Required values to set

**`apps/runtime/.env`** — minimum to get running:

```
ANTHROPIC_API_KEY=sk-ant-...       # Required — at least one LLM key
JWT_SECRET=<any-string>            # Must match Studio and Admin
```

**`apps/studio/.env.local`** — minimum:

```
ANTHROPIC_API_KEY=sk-ant-...       # Same key as runtime
JWT_SECRET=<same-as-runtime>       # Must match Runtime
```

**`apps/admin/.env.local`** — minimum:

```
JWT_SECRET=<same-as-runtime>       # Must match Runtime and Studio
```

All other values have sensible defaults for local development. See the `.env.example` files for full documentation of every variable.

### Key shared values

These **must be identical** across Runtime, Studio, and Admin:

| Variable                | Purpose                              |
| ----------------------- | ------------------------------------ |
| `JWT_SECRET`            | Auth token signing                   |
| `ENCRYPTION_MASTER_KEY` | Secrets encryption (optional in dev) |

---

## 3. Database Setup

The platform uses SQLite by default for local development (zero config).

```bash
# Generate Prisma client (usually done by postinstall, but run if needed)
cd packages/database && pnpm db:generate

# Push schema to SQLite database (creates the .db file)
cd packages/database && pnpm db:push

# Seed example data (admin users, example agents, resource types)
cd packages/database && pnpm db:seed

# Return to root
cd ../..
```

### Optional: Seed admin users and secrets

```bash
pnpm seed:admin        # Creates dev@kore.ai admin user
pnpm seed:secrets      # Initializes secret management
```

---

## 4. Build

Build all packages and apps (Turbo handles the dependency graph):

```bash
pnpm build
```

This compiles:

- All `packages/*` TypeScript libraries to `dist/`
- `apps/runtime` TypeScript to `apps/runtime/dist/`
- `apps/studio` Next.js build to `apps/studio/.next/`
- `apps/admin` Next.js build to `apps/admin/.next/`

---

## 5. Start the Platform

The `apx` CLI manages both Docker infrastructure and application services in one place.

### Start everything (daily driver)

```bash
./apx up
```

This starts:

- **Docker infra**: mongo, redis, clickhouse, kafka, restate, workflow-engine, pipeline-engine, nlu-sidecar
- **App services** (via PM2): runtime, studio, admin

### Start specific groups

```bash
./apx up infra           # Just Docker infrastructure
./apx up apps            # Just app services (runtime, studio, admin)
./apx up core apps       # Only DBs + app services
./apx up search          # OpenSearch + BGE-M3 + preprocessing
./apx up graph           # Neo4j + Qdrant
```

### Verify services are running

```bash
./apx status             # Show all running services
./apx health             # Check all service endpoints
```

### pnpm wrappers

All `apx` commands are also available via pnpm:

```bash
pnpm up                  # ./apx up
pnpm down                # ./apx down
pnpm status              # ./apx status
pnpm health              # ./apx health
pnpm logs                # ./apx logs
```

### Service groups reference

| Group           | Services                                  |
| --------------- | ----------------------------------------- |
| `core`          | mongo, redis, clickhouse                  |
| `streaming`     | kafka                                     |
| `orchestration` | restate, workflow-engine, pipeline-engine |
| `nlu`           | nlu-sidecar                               |
| `search`        | opensearch, bge-m3, preprocessing         |
| `docs`          | docling-service                           |
| `sandbox`       | codetool-sandbox                          |
| `graph`         | neo4j, qdrant                             |
| `infra`         | core + streaming + orchestration + nlu    |
| `apps`          | runtime, studio, admin                    |
| `apps:all`      | all app services                          |

---

## 6. Service URLs

| Service        | URL                          | Description                  |
| -------------- | ---------------------------- | ---------------------------- |
| Runtime API    | http://localhost:3112        | Express + WebSocket server   |
| Runtime Health | http://localhost:3112/health | Health check endpoint (JSON) |
| Studio         | http://localhost:5173        | Visual IDE / Agent editor    |
| Admin          | http://localhost:3003        | Admin dashboard              |
| Telco NOC      | http://localhost:4100        | Telecom demo dashboard       |

### Health check

```bash
curl http://localhost:3112/health
```

---

## 7. Log Files

All logs are written to the `logs/` directory at the project root:

| File                     | Service | Content                                |
| ------------------------ | ------- | -------------------------------------- |
| `logs/runtime-out.log`   | Runtime | Pino structured JSON (stdout)          |
| `logs/runtime-error.log` | Runtime | Uncaught errors, stack traces (stderr) |
| `logs/studio-out.log`    | Studio  | Next.js output                         |
| `logs/studio-error.log`  | Studio  | Next.js errors                         |
| `logs/admin-out.log`     | Admin   | Next.js output                         |
| `logs/admin-error.log`   | Admin   | Next.js errors                         |

### Viewing logs

```bash
# Tail all logs
./apx logs

# Tail a specific app service
./apx logs runtime

# Tail a Docker service
./apx logs kafka

# Tail a whole group
./apx logs core

# Pretty-print Runtime Pino JSON logs
tail -f logs/runtime-out.log | npx pino-pretty
```

---

## 8. Common Commands

### Process management

```bash
./apx status              # Show all running services
./apx health              # Health check all endpoints
./apx restart runtime     # Restart one app service
./apx restart core        # Restart a Docker group
./apx down                # Stop everything
./apx down apps           # Stop only app services
./apx down infra          # Stop only Docker services
```

### Update after code changes

```bash
./apx rebuild runtime     # Build + restart a service
./apx build               # Rebuild all packages
```

---

## 9. Ecosystem Configuration

The PM2 configuration lives at `ecosystem.config.js` in the project root. Key settings:

| Service     | Port | Memory Limit | Kill Timeout            |
| ----------- | ---- | ------------ | ----------------------- |
| abl-runtime | 3112 | 1 GB         | 15s (graceful shutdown) |
| abl-studio  | 5173 | 512 MB       | 5s                      |
| abl-admin   | 3003 | 512 MB       | 5s                      |

Runtime uses `fork` mode (not `cluster`) because it maintains in-process WebSocket connections, BullMQ workers, and session state.

---

## 10. Troubleshooting

### Service shows "errored" in pm2 status

```bash
pm2 logs <service-name> --err --lines 50
```

Common causes:

- Missing `.env` file — copy from `.env.example`
- Missing build — run `pnpm build`
- Port already in use — check with `lsof -i :<port>`
- Missing `ANTHROPIC_API_KEY` in runtime `.env`

### Runtime won't start

```bash
# Check if the build output exists
ls apps/runtime/dist/index.js

# If missing, rebuild
pnpm build
```

### Studio/Admin won't start

```bash
# Check if Next.js build exists
ls apps/studio/.next/
ls apps/admin/.next/

# If missing, rebuild
pnpm build
```

### "next: not found" error

The PM2 config references `node_modules/next/dist/bin/next` relative to each app's `cwd`. Ensure `pnpm install` completed successfully:

```bash
ls apps/studio/node_modules/next/dist/bin/next
ls apps/admin/node_modules/next/dist/bin/next
```

### Database errors

```bash
# Regenerate Prisma client
cd packages/database && pnpm db:generate

# Re-push schema
cd packages/database && pnpm db:push
```

### Reset everything

```bash
./apx down                # Stop all services
pnpm clean                # Remove node_modules and build artifacts
pnpm install              # Fresh install
./apx up                  # Rebuild and start
```

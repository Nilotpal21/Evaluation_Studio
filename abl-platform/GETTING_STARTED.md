# Getting Started with ABL Platform

> Get up and running in 5 minutes

---

## Prerequisites

| Tool               | Required | Install                          |
| ------------------ | -------- | -------------------------------- |
| **Node.js**        | >= 18    | [nodejs.org](https://nodejs.org) |
| **pnpm**           | >= 8     | `npm install -g pnpm`            |
| **Docker Desktop** | >= 4.0   | [docker.com](https://docker.com) |
| **gitleaks**       | latest   | `brew install gitleaks` (macOS)  |

---

## Quick Start

```bash
# 1. Clone the repository
git clone git@bitbucket.org:koreteam1/abl-platform.git
cd abl-platform

# 2. Install dependencies
pnpm install

# 3. Set up environment
cp .env.example .env
# IMPORTANT: generate and set ENCRYPTION_MASTER_KEY
#   openssl rand -hex 32
# Paste the output as ENCRYPTION_MASTER_KEY= in .env

# 4. Start Docker infrastructure
./apx up infra
# Starts: MongoDB, Redis, ClickHouse, Kafka, Restate, NLU sidecar

# 5. Seed the local database with the example workspace and projects
pnpm db:init

# 6. Build all packages (required before running tests)
pnpm build

# 7. Start development servers
pnpm dev
# Starts runtime (3112) + studio (5173) with hot reload
```

---

## Access the Application

| Service             | URL                          | Description                       |
| ------------------- | ---------------------------- | --------------------------------- |
| **Studio UI**       | http://localhost:5173        | Visual agent editor and debugger  |
| **Runtime API**     | http://localhost:3112        | Backend API + WebSocket           |
| **Admin Dashboard** | http://localhost:3003        | Config, secrets, audit management |
| **Runtime Health**  | http://localhost:3112/health | Health check endpoint             |

### Login (Development Mode)

1. Open http://localhost:5173
2. Click **Dev Login** on the login page
3. Studio signs you into the default local dev account

---

## What Can You Do?

### 1. Explore Example Agents

Check out `examples/` for pre-built agent definitions:

- `examples/travel/` — Multi-agent travel booking system
- `examples/banknexus/` — Banking agents
- `examples/saludsa-sop/` — Healthcare agents with SOPs
- `examples/airlines/` — Airline customer service

### 2. Create an Agent

1. Open Studio at http://localhost:5173
2. Create a new project
3. Add an agent using ABL syntax
4. Test in the chat interface

### 3. Debug Agent Execution

1. Start a chat session in Studio
2. Open the **Observatory** panel
3. View real-time execution traces
4. Inspect state, spans, and tool calls at each step

---

## Project Structure

```
abl-platform/
├── apps/
│   ├── runtime/              # Express API + WebSocket engine (port 3112)
│   ├── studio/               # Next.js agent design IDE (port 5173)
│   ├── admin/                # Admin dashboard (port 3003)
│   ├── search-ai/            # Document ingestion pipeline (port 3113)
│   └── search-ai-runtime/    # Query-time retrieval (port 3114)
├── packages/                  # ~38 shared workspace packages
├── services/                  # Python microservices (Docker)
├── examples/                  # ABL example files
└── docs/                      # Documentation
```

---

## APX CLI (Service Manager)

The `apx` CLI manages Docker infrastructure and Node.js services:

```bash
./apx up              # Start everything (infra + apps)
./apx up infra        # Docker infrastructure only
./apx up apps         # Node.js apps via PM2
./apx down            # Stop everything
./apx status          # Health dashboard
./apx logs runtime    # Tail runtime logs
./apx restart studio  # Restart a specific service
```

---

## Common Commands

```bash
pnpm build            # Build all packages (Turbo-cached)
pnpm test             # Run all tests (build first!)
pnpm dev              # Hot-reload dev mode
pnpm typecheck        # Type check all packages
```

---

## Next Steps

- **Full Development Guide**: [DEVELOPMENT.md](./DEVELOPMENT.md)
- **ABL Language Reference**: [docs/reference/ABL_SPEC.md](./docs/reference/ABL_SPEC.md)
- **Architecture Docs**: [docs/architecture/](./docs/architecture/)
- **Documentation Index**: [docs/README.md](./docs/README.md)
- **Coding Rules & Invariants**: [CLAUDE.md](./CLAUDE.md)

---

## Troubleshooting

**Docker infrastructure won't start?**

```bash
docker compose ps              # Check service status
docker compose down -v         # Reset and retry
./apx up infra
```

**Port already in use?**

```bash
lsof -i :3112                 # Find process
kill -9 <PID>                  # Kill it
```

**Tests fail?**

```bash
pnpm build                    # Tests require built packages
pnpm test
```

**ENCRYPTION_MASTER_KEY not set?**

```bash
openssl rand -hex 32          # Generate a key
# Add to .env as ENCRYPTION_MASTER_KEY=<output>
```

**gitleaks not installed?** (pre-commit hook fails)

```bash
brew install gitleaks          # macOS
```

**Need more help?** See [DEVELOPMENT.md](./DEVELOPMENT.md#11-troubleshooting)

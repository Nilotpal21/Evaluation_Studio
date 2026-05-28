# MongoDB + ClickHouse Setup Guide

Set up the ABL Platform's production database stack: **MongoDB** (metadata & control plane) + **ClickHouse** (high-volume operational data).

---

## Prerequisites

| Tool           | Version   | Install                                                              |
| -------------- | --------- | -------------------------------------------------------------------- |
| Docker         | >= 24.0   | https://docs.docker.com/get-docker/                                  |
| Docker Compose | >= 2.0    | Included with Docker Desktop; or `apt install docker-compose-plugin` |
| Node.js        | >= 18.0.0 | https://nodejs.org                                                   |
| pnpm           | >= 8.0.0  | `npm install -g pnpm@8`                                              |

Ensure your user can run Docker without sudo:

```bash
sudo usermod -aG docker $(whoami)
newgrp docker   # or log out and back in
```

---

## Architecture Overview

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   Runtime    │────▶│    MongoDB 7     │     │  ClickHouse 24.3 │
│  (port 3112) │     │  (port 27018)    │     │  (port 8124)     │
│              │────▶│  Metadata Store   │     │  Analytics Store  │
│              │────▶│                  │     │                  │
│              │     └──────────────────┘     └──────────────────┘
│              │                                       ▲
│              │───────────────────────────────────────┘
│              │     ┌──────────────────┐
│              │────▶│   Redis 7        │
│              │     │  (port 6380)     │
│              │     │  Cache/Queues    │
└──────────────┘     └──────────────────┘
```

**MongoDB** stores: Conversations, Sessions, Users, Projects, Agents, Contacts, Facts, Workflows, Configs

**ClickHouse** stores: Messages, Traces, Metrics, Audit Logs, Facts (analytics), LLM Usage

**Redis** (optional): Session cache, BullMQ job queues (falls back to in-memory)

---

## Step 1: Start Docker Containers

From the project root:

```bash
docker compose up -d
```

This starts three services defined in `docker-compose.yml`:

| Service         | Image                               | Host Port                       | Container Port | Credentials                      |
| --------------- | ----------------------------------- | ------------------------------- | -------------- | -------------------------------- |
| MongoDB 7       | `mongo:7`                           | **27018**                       | 27017          | `abl_admin` / `abl_dev_password` |
| ClickHouse 24.3 | `clickhouse/clickhouse-server:24.3` | **8124** (HTTP), **9001** (TCP) | 8123, 9000     | `abl_admin` / `abl_dev_password` |
| Redis 7         | `redis:7-alpine`                    | **6380**                        | 6379           | none                             |

### Verify containers are healthy

```bash
docker compose ps
```

All three containers should show `healthy` status. MongoDB takes ~30s to initialize its replica set.

### Check individual services

```bash
# MongoDB
mongosh "mongodb://abl_admin:abl_dev_password@localhost:27018/abl_platform?authSource=admin&replicaSet=rs0" --eval "rs.status().ok"

# ClickHouse
curl "http://localhost:8124/?query=SELECT%201"

# Redis
redis-cli -p 6380 ping
```

---

## Step 2: Configure Environment Variables

### Runtime (`apps/runtime/.env`)

Set these variables:

```env
# Switch backend from prisma to mongo
DB_BACKEND=mongo

# Comment out the Prisma/SQLite database URL
# DATABASE_URL="file:..."

# MongoDB connection (matches docker-compose.yml credentials)
# NOTE: Use directConnection=true for Docker single-node replica set
MONGODB_URL="mongodb://abl_admin:abl_dev_password@localhost:27018/abl_platform?authSource=admin&directConnection=true"
MONGODB_DATABASE="abl_platform"
MONGODB_DIRECT_CONNECTION=true

# ClickHouse connection
CLICKHOUSE_URL="http://localhost:8124"
CLICKHOUSE_HOST="http://localhost:8124"
CLICKHOUSE_USER="abl_admin"
CLICKHOUSE_PASSWORD="abl_dev_password"
CLICKHOUSE_DATABASE="abl_platform"

# Redis (optional)
REDIS_URL="redis://localhost:6380/0"

# Feature flag to use MongoDB/ClickHouse stores
USE_MONGO_CLICKHOUSE=true
```

### Studio (`apps/studio/.env`)

```env
DB_BACKEND=mongo
MONGODB_URL="mongodb://abl_admin:abl_dev_password@localhost:27018/abl_platform?authSource=admin&directConnection=true"
MONGODB_DATABASE="abl_platform"
```

### Database package (`packages/database/.env`)

```env
MONGODB_URL="mongodb://abl_admin:abl_dev_password@localhost:27018/abl_platform?authSource=admin&directConnection=true"
MONGODB_DATABASE="abl_platform"
CLICKHOUSE_URL="http://localhost:8124"
CLICKHOUSE_HOST="http://localhost:8124"
CLICKHOUSE_USER="abl_admin"
CLICKHOUSE_PASSWORD="abl_dev_password"
CLICKHOUSE_DATABASE="abl_platform"
```

---

## Step 3: Seed MongoDB

Populate MongoDB with platform defaults plus the local dev fixtures:

```bash
MONGODB_URL="mongodb://abl_admin:abl_dev_password@localhost:27018/abl_platform?authSource=admin&directConnection=true" \
  pnpm seed:dev
```

This creates:

- **Dev user**: `dev@kore.ai` (Developer)
- **Tenant**: `Dev Workspace` (`tenant-dev-001`)
- **Roles**: OWNER, ADMIN, OPERATOR, MEMBER, VIEWER
- **Resource types**: tenant, project, agent, tool, environment, etc.
- **Example projects**: the curated dev-only example set (travel, guardrails, saludsa, retail, apple-care, and others)
- **Model configs**: Claude Sonnet 4.5, GPT-4o variants (if API keys set)

If you only want platform/core defaults without dev fixtures, run `pnpm seed:core` instead.

---

## Step 4: Build and Start Services

```bash
# Build all packages
pnpm build

# Start with PM2
pm2 start ecosystem.config.js --env development

# Or restart if already running
pm2 restart all
```

### Verify

```bash
# Health check — should show mongo backend and clickhouse connected
curl http://localhost:3112/health | jq

# Expected response:
# {
#   "status": "healthy",
#   "database": "connected (mongo)",
#   "backend": "mongo",
#   "clickhouse": "connected"
# }
```

---

## How the Backend Switching Works

The platform uses a `DB_BACKEND` environment variable to select the database backend at startup:

### Store Factory (`apps/runtime/src/services/stores/store-factory.ts`)

```
DB_BACKEND=mongo   →  MongoDB + ClickHouse stores (production default)
DB_BACKEND=prisma  →  Prisma/SQLite stores (legacy local dev fallback)
```

### Runtime Startup Flow

1. `server.ts` reads `DB_BACKEND` from env
2. Calls `initStores(backend)` — registers the store backend
3. If `mongo`: connects to MongoDB via `MongoConnectionManager`
4. If `CLICKHOUSE_URL` is set: initializes ClickHouse client + DDL schema
5. All repos check `getBackend()` and route to the appropriate store

### Repository Pattern

Every repository file has dual paths:

```typescript
// Example: apps/runtime/src/repos/session-repo.ts
export async function findSession(id: string) {
  if (getBackend() === 'mongo') {
    return Session.findById(id).lean();
  }
  return requirePrisma().session.findUnique({ where: { id } });
}
```

### ClickHouse Schema Auto-Init

ClickHouse tables are automatically created at startup by `initClickHouseSchema()` in `packages/database/src/clickhouse-schemas/init.ts`. No manual DDL required.

---

## Legacy Fallback: Prisma/SQLite (Local Dev Only)

> **Note:** The Prisma/SQLite path is a legacy fallback for local development without Docker. It is not suitable for production and will be removed in a future release. All new development should target `DB_BACKEND=mongo`.

To use the legacy Prisma backend:

```env
# In apps/runtime/.env
DB_BACKEND=prisma
DATABASE_URL="file:/path/to/packages/database/prisma/dev.db"
# Comment out or remove: USE_MONGO_CLICKHOUSE=true
```

Then rebuild and restart:

```bash
pnpm build && pm2 restart all
```

---

## Docker Compose Reference

### Commands

```bash
# Start all services
docker compose up -d

# Stop all services (data preserved in volumes)
docker compose down

# Stop and DELETE all data
docker compose down -v

# View logs
docker compose logs -f mongo
docker compose logs -f clickhouse
docker compose logs -f redis

# Restart a single service
docker compose restart mongo
```

### Volumes

| Volume            | Service    | Purpose                     |
| ----------------- | ---------- | --------------------------- |
| `mongo_data`      | MongoDB    | Database files              |
| `mongo_config`    | MongoDB    | Config/replica set metadata |
| `clickhouse_data` | ClickHouse | Table data                  |
| `clickhouse_logs` | ClickHouse | Server logs                 |
| `redis_data`      | Redis      | Persistence (AOF/RDB)       |

### MongoDB Replica Set

The Docker Compose config automatically initializes a single-node replica set (`rs0`). This is required for:

- Change streams (used by some real-time features)
- Transactions (multi-document atomicity)

The health check in `docker-compose.yml` runs `rs.initiate()` automatically on first boot.

### Port Mapping Summary

| Service         | Default Port | Docker Host Port | Why Different                        |
| --------------- | ------------ | ---------------- | ------------------------------------ |
| MongoDB         | 27017        | **27018**        | Avoid conflict with local MongoDB    |
| ClickHouse HTTP | 8123         | **8124**         | Avoid conflict with local ClickHouse |
| ClickHouse TCP  | 9000         | **9001**         | Avoid conflict with local ClickHouse |
| Redis           | 6379         | **6380**         | Avoid conflict with local Redis      |

---

## Troubleshooting

### MongoDB connection refused

```
Error: connect ECONNREFUSED 127.0.0.1:27018
```

1. Check container is running: `docker compose ps`
2. Check container logs: `docker compose logs mongo`
3. Wait for replica set init (~30s after first start)
4. Verify health: `docker compose ps` should show `(healthy)`

### MongoDB replica set not initialized

```
MongoServerError: not primary
```

The health check auto-initializes the replica set. If it fails:

```bash
mongosh "mongodb://abl_admin:abl_dev_password@localhost:27018/?authSource=admin" --eval "
  rs.initiate({_id: 'rs0', members: [{_id: 0, host: 'localhost:27017'}]})
"
```

### ClickHouse connection failed

```
Error: connect ECONNREFUSED 127.0.0.1:8124
```

1. Check container: `docker compose ps`
2. Test HTTP interface: `curl http://localhost:8124/`
3. Check logs: `docker compose logs clickhouse`

### Docker permission denied

```
permission denied while trying to connect to the Docker daemon socket
```

Add your user to the `docker` group:

```bash
sudo usermod -aG docker $(whoami)
# Then either:
newgrp docker
# Or log out and back in
```

### Runtime starts but database shows "not configured"

1. Verify `DB_BACKEND=mongo` is set in `apps/runtime/.env`
2. Verify `MONGODB_URL` matches docker-compose credentials and port (27018)
3. Check runtime logs: `pm2 logs abl-runtime --lines 30`

### Seed script fails

```bash
# Ensure MongoDB is healthy first
docker compose ps

# Run with explicit URL (directConnection=true bypasses replica set discovery)
MONGODB_URL="mongodb://abl_admin:abl_dev_password@localhost:27018/abl_platform?authSource=admin&directConnection=true" \
  pnpm seed:dev
```

### "Server selection timed out" or "ReplicaSetNoPrimary"

The Docker single-node replica set advertises `localhost:27017` internally but you connect via `localhost:27018`. Use `directConnection=true` in the MongoDB URL and set `MONGODB_DIRECT_CONNECTION=true` in the runtime env to bypass replica set topology discovery.

---

## Production Considerations

For production deployments, ensure:

1. **MongoDB**: Use a proper replica set (3+ nodes), enable TLS, use strong passwords
2. **ClickHouse**: Configure proper retention policies, use ZooKeeper/Keeper for HA
3. **Redis**: Enable AOF persistence, use Redis Sentinel or Cluster for HA
4. **Environment variables**: Use secrets management (Vault, AWS Secrets Manager)
5. **TLS**: Set `MONGODB_TLS=true` and provide CA certificates
6. **Network**: Use private networking between services; don't expose DB ports publicly

```env
# Production MongoDB example
MONGODB_URL="mongodb+srv://user:pass@cluster.mongodb.net/abl_platform?tls=true&retryWrites=true&w=majority"
MONGODB_TLS=true

# Production ClickHouse example
CLICKHOUSE_URL="https://clickhouse.internal:8443"
CLICKHOUSE_USER="abl_prod"
CLICKHOUSE_PASSWORD="<strong-password>"
```

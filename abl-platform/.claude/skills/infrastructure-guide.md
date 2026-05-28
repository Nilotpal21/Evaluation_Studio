---
name: infrastructure-guide
description: Use when debugging service connections, setting up dev environment, checking Docker ports, modifying database URLs, or working across the three platform repos (source, deploy, infra).
---

# Infrastructure Guide

## Docker Infrastructure

`docker-compose.yml` is the **single source of truth** for dev infrastructure. All services connect to Docker containers. Never use a local system-level MongoDB/Redis install.

### Databases & Infrastructure

| Service         | Container      | Host Port                    | Health Check            | Used By                                         |
| --------------- | -------------- | ---------------------------- | ----------------------- | ----------------------------------------------- |
| MongoDB 7       | abl-mongo      | **27018**                    | Replica set ping        | Runtime, Studio, SearchAI, Admin                |
| Redis 7         | abl-redis      | **6380**                     | `redis-cli ping`        | SearchAI (BullMQ), Runtime (sessions, optional) |
| ClickHouse 24   | abl-clickhouse | **8124**                     | `SELECT 1`              | Runtime (traces, audit), SearchAI (metrics)     |
| OpenSearch 2.11 | abl-opensearch | **9200**                     | `/_cluster/health`      | SearchAI (vector store, primary)                |
| Neo4j 5         | abl-neo4j      | **7687** (Bolt), 7474 (HTTP) | `cypher-shell RETURN 1` | SearchAI (knowledge graph)                      |
| Qdrant          | abl-qdrant     | **6333** (HTTP), 6334 (gRPC) | `curl localhost:6333/`  | SearchAI (vector store, alternative)            |

### Python Microservices

| Service       | Container               | Host Port | Health Check  | Used By                                       | Purpose                                                                |
| ------------- | ----------------------- | --------- | ------------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| Docling       | abl-docling-service     | **8080**  | `GET /health` | SearchAI (extraction workers)                 | Document extraction — PDF, DOCX, PPTX, HTML, images via IBM Docling    |
| BGE-M3        | abl-bge-m3              | **8000**  | `GET /health` | SearchAI (embedding worker), SearchAI-Runtime | Multilingual embeddings (1024d, 100+ languages, OpenAI-compatible API) |
| Preprocessing | (not in docker-compose) | **8003**  | `GET /health` | SearchAI-Runtime                              | Query preprocessing — spell correction, synonyms, entity extraction    |

### Port Constants

Defined in `packages/config/src/constants.ts` (`DEFAULT_MONGODB_PORT`, `DEFAULT_REDIS_PORT`, `DEFAULT_CLICKHOUSE_PORT`). MongoDB schema default in `packages/config/src/schemas/mongodb.schema.ts` imports `DEFAULT_MONGODB_PORT`.

### MongoDB URL Rules

**Before changing any `MONGODB_URL`, `REDIS_URL`, or service connection:**

1. Check `docker-compose.yml` — this defines the correct ports
2. Check `packages/config/src/constants.ts` — these are the intended defaults
3. Compare `.env` files across ALL apps (`runtime`, `search-ai`, `studio`, `search-ai-runtime`)
4. If a `.env` disagrees with `docker-compose.yml`, the `.env` is wrong — not the other way around
5. Never point a service to a database that lacks replica set support (required for transactions) or authentication
6. Dev `.env` files need `directConnection=true` in the MongoDB URL (Docker port-maps 27018→27017, replica set discovery finds the internal port). The shared config schema does NOT include `directConnection` — it's dev-specific.

## App Services

### Core Services

| Service           | Port | Package                              | Command                                                | Purpose                                                                             |
| ----------------- | ---- | ------------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Runtime           | 3112 | `@agent-platform/runtime`            | `pnpm --filter @agent-platform/runtime dev`            | Agent execution, sessions, WebSocket, chat API, LLM provider integration            |
| Search-AI         | 3005 | `@agent-platform/search-ai`          | `pnpm --filter @agent-platform/search-ai dev`          | Document ingestion pipeline (17 BullMQ workers), extraction, enrichment, embedding  |
| Search-AI Runtime | 3004 | `@agent-platform/search-ai-runtime`  | `pnpm --filter @agent-platform/search-ai-runtime dev`  | Query-time retrieval — vector search, reranking, vocabulary resolution              |
| Studio            | 5173 | `@agent-platform/studio`             | `pnpm --filter @agent-platform/studio dev`             | Next.js web IDE, agent design, project management, proxies to Runtime and Search-AI |
| Multimodal        | 3115 | `@agent-platform/multimodal-service` | `pnpm --filter @agent-platform/multimodal-service dev` | File upload, malware scanning (ClamAV), image/video processing, S3 storage          |
| Admin             | 3003 | `@agent-platform/admin`              | `pnpm --filter @agent-platform/admin dev`              | Platform admin dashboard — model provisioning, secrets, rate limits, audit          |

### Demo & Dev Tools (not required for core functionality)

| Service         | Port | Purpose                                                            |
| --------------- | ---- | ------------------------------------------------------------------ |
| Telco NOC       | 4100 | Telecom NOC demo app (PoC for telecom vertical)                    |
| Spec Mock       | 3099 | Mock specification server for testing                              |
| Observatory CLI | —    | CLI tool (not a service) for remote agent debugging via trace APIs |

## Repository Layout (Three Repos)

| Repo                         | What lives there                                                                     | Bitbucket                       |
| ---------------------------- | ------------------------------------------------------------------------------------ | ------------------------------- |
| **abl-platform** (this repo) | App source code, Dockerfiles, CI pipelines (`.harness/`)                             | `koreteam1/abl-platform`        |
| **abl-platform-deploy**      | Helm charts (`helm/`), ArgoCD config (`argocd/`), env values files, release workflow | `koreteam1/abl-platform-deploy` |
| **abl-platform-infra**       | Terraform/OpenTofu modules, platform composition, env tfvars, infra pipeline         | `koreteam1/abl-platform-infra`  |

- Helm charts moved from `deploy/` to `abl-platform-deploy` in Feb 2025. Old references to `deploy/helm/` or `deploy/argocd/` map to `helm/` and `argocd/` in the deploy repo.
- Terraform modules moved from `deploy/terraform/` to `abl-platform-infra`.
- ArgoCD Image Updater removed. CI pushes image tags to `values-dev.yaml` on `main` in `abl-platform-deploy`.

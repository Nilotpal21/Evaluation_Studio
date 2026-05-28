# Pipeline Engine

Restate-backed analytics pipeline engine with 10 built-in pipelines. Processes conversation events from Kafka and runs configurable analysis workflows (sentiment, intent, quality, hallucination detection, etc.).

## Quick Start

### Option A: Full Docker Stack (recommended)

From the **repo root**:

```bash
docker compose up -d
```

This starts everything — MongoDB, ClickHouse, Redis, Kafka, Restate, and the pipeline engine. On startup the pipeline engine automatically:

1. Seeds all 10 pipeline definitions into MongoDB
2. Registers itself with Restate
3. Creates Kafka subscriptions for all 8 event topics

Verify it's running:

```bash
# Check Restate registered the pipeline-engine deployment
curl -s http://localhost:9070/deployments | jq '.deployments[].uri'

# Check Kafka subscriptions
curl -s http://localhost:9070/subscriptions | jq '.[].source'

# Check pipeline definitions in MongoDB
mongosh "mongodb://abl_admin:abl_dev_password@localhost:27018/abl_platform?authSource=admin&directConnection=true" \
  --quiet --eval "db.pipeline_definitions.countDocuments()"
# → 10
```

### Option B: Local Development (hot-reload)

Use the pipeline-engine's own docker-compose for Kafka + Restate, while running the engine locally with hot-reload:

```bash
# 1. Start the root stack for MongoDB, ClickHouse, Redis
docker compose up -d mongo clickhouse redis

# 2. Start Kafka + Restate from the pipeline-engine stack
cd packages/pipeline-engine
docker compose up -d

# 3. Run the pipeline engine locally (hot-reload via tsx watch)
pnpm dev
```

The `pnpm dev` command reads from `.env` and starts the Restate server on port 9082 with file watching.

After the engine is listening, it auto-registers with Restate. If you need to manually re-register:

```bash
./docker/register-services.sh
```

## Ports

| Service         | Port  | Description                           |
| --------------- | ----- | ------------------------------------- |
| Pipeline Engine | 9082  | Restate endpoint                      |
| Restate Admin   | 9070  | Deployments & subscriptions           |
| Restate Ingress | 8090  | Client invocations (mapped from 8080) |
| Kafka           | 19092 | Broker (host access)                  |
| MongoDB         | 27018 | Shared from root stack                |
| ClickHouse      | 8124  | HTTP interface                        |

## Environment Variables

| Variable                | Default                            | Description                            |
| ----------------------- | ---------------------------------- | -------------------------------------- |
| `RESTATE_SERVICE_PORT`  | `9082`                             | Port the Restate endpoint listens on   |
| `RESTATE_ADMIN_URL`     | `http://localhost:9070`            | Restate admin API for registration     |
| `RESTATE_ENDPOINT_URL`  | `http://localhost:9082`            | URL Restate uses to reach this service |
| `MONGODB_URL`           | `mongodb://...localhost:27018/...` | MongoDB connection string              |
| `CLICKHOUSE_URL`        | `http://localhost:8124`            | ClickHouse HTTP interface              |
| `ENCRYPTION_MASTER_KEY` | (dev key in bootstrap.ts)          | 64-char hex key for field encryption   |

## Built-in Pipelines

| Pipeline                | Type                      | Trigger                          |
| ----------------------- | ------------------------- | -------------------------------- |
| Sentiment Analysis      | `sentiment_analysis`      | `session.ended`, `message.user`  |
| Intent Classification   | `intent_classification`   | `session.ended`, `message.user`  |
| Quality Evaluation      | `quality_evaluation`      | `session.ended`                  |
| Hallucination Detection | `hallucination_detection` | `session.ended`, `message.agent` |
| Knowledge Gap Analysis  | `knowledge_gap`           | `session.ended`                  |
| Guardrail Analysis      | `guardrail_analysis`      | `session.ended`                  |
| Friction Detection      | `friction_detection`      | `session.ended`, `message.user`  |
| Anomaly Detection       | `anomaly_detection`       | Scheduled                        |
| Drift Detection         | `drift_detection`         | Scheduled                        |
| Eval (Simulation)       | `simulation`              | Manual (via Studio API)          |

All pipelines are seeded as **disabled** by default. Enable them per-tenant through the pipeline config API or Studio UI.

## Kafka Topics

The engine subscribes to 8 event topics via Restate Kafka ingress:

```
abl.session.created    abl.message.user
abl.session.ended      abl.message.agent
abl.session.handoff    abl.tool.called
abl.session.escalation abl.tool.completed
```

Each topic has 3 partitions, LZ4 compression, and 7-day retention. Topics are created automatically by the `init-kafka-topics` service.

## Architecture

```
Kafka topics → Restate (Kafka ingress) → PipelineTrigger.handleEvent()
                                              ↓
                                    PipelineRun workflow
                                    (step-by-step execution)
                                              ↓
                                    Activity services
                                    (LLM calls, computation, storage)
                                              ↓
                                    ClickHouse (analytics tables)
                                    MongoDB (insights, results)
```

The engine uses Restate for durable execution — if a pipeline step fails mid-way, Restate automatically retries from the last checkpoint.

## Seeding Pipelines Manually

The definitions are auto-seeded on server startup. For manual seeding (e.g., in CI or a fresh database):

```bash
pnpm tsx packages/database/seed-mongo.ts
```

That seeds platform pipeline definitions. To also ensure tenant-level pipeline configs
(disabled, ready to enable), target a tenant explicitly:

```bash
pnpm tsx packages/database/seed-mongo.ts --tenant tenant-123
```

For local development, `pnpm seed:dev` seeds the dev workspace plus examples.

## Adding a New Pipeline

1. Create `src/pipeline/definitions/my-pipeline.ts` exporting `MY_PIPELINE_ID` and `myPipelineDefinition`
2. Add the export to `src/pipeline/definitions/index.ts` and append to `BUILTIN_DEFINITIONS`
3. Add any new activity services and bind them in `server.ts`
4. Run `pnpm build` and restart

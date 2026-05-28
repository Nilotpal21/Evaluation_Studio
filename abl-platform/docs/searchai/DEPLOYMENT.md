# Search-AI DevOps Deployment Guide

**Date:** 2026-03-02
**Application:** `apps/search-ai`
**Version:** 1.0.0
**Target Environments:** Development, Staging, Production

---

## 1. Services Overview

### Main Application Service

**Service:** `search-ai`

- **Type:** Node.js Express REST API + BullMQ Workers
- **Port:** `3005` (configurable via `PORT` env var)
- **Docker Image:** `agent-platform-search-ai`
- **Health Check:** `GET /health`
- **Replicas:** 3+ (recommended for production)

---

## 2. Required Infrastructure Services

### 2.1 Databases & Storage

| Service                | Purpose                                       | Required    | Port                       | Deployment Notes                              |
| ---------------------- | --------------------------------------------- | ----------- | -------------------------- | --------------------------------------------- |
| **MongoDB (Platform)** | Application config, indexes, credentials      | ✅ Yes      | 27017                      | Database: `abl_platform`                      |
| **MongoDB (Content)**  | Documents, chunks, questions, KG data         | ✅ Yes      | 27017                      | Database: `abl_content` (can be same cluster) |
| **Redis**              | BullMQ job queues, caching, distributed locks | ✅ Yes      | 6379                       | Cluster mode for production                   |
| **ClickHouse**         | Structured data, analytics, audit logs        | ✅ Yes      | 8123 (HTTP), 9000 (Native) | Single node or cluster                        |
| **Vector Store**       | Embeddings for semantic search                | ✅ Yes      | Varies                     | Choose: OpenSearch, Qdrant, or Pinecone       |
| **Neo4j**              | Knowledge graph storage                       | ⚠️ Optional | 7687 (Bolt), 7474 (HTTP)   | Required if KG features enabled               |

### 2.2 Vector Store Options (Choose One)

| Option         | Port | Use Case                  | Notes                                                             |
| -------------- | ---- | ------------------------- | ----------------------------------------------------------------- |
| **OpenSearch** | 9200 | Recommended (k-NN plugin) | Fast, open-source, scalable, handles both text search and vectors |
| **Qdrant**     | 6333 | Dedicated vector store    | Fast, specialized for vector similarity                           |
| **Pinecone**   | N/A  | Cloud-hosted              | Fully managed, serverless                                         |
| **Weaviate**   | 8080 | Advanced ML features      | Additional capabilities                                           |

### 2.3 External Services

| Service                   | Purpose                     | Required            | Configuration                                |
| ------------------------- | --------------------------- | ------------------- | -------------------------------------------- |
| **LLM Providers**         | Text generation, embeddings | ✅ Yes (at least 1) | API keys via MongoDB (`LLMCredential` model) |
| **S3-Compatible Storage** | Document storage            | ✅ Yes              | AWS S3, MinIO, or compatible                 |
| **Docling Service**       | Advanced PDF extraction     | ⚠️ Optional         | HTTP endpoint for PDF parsing                |

---

## 3. Environment Variables

### 3.1 Core Configuration

```bash
# ============================================================
# APPLICATION
# ============================================================
NODE_ENV=production                    # production | staging | development
PORT=3005                              # HTTP server port
LOG_LEVEL=info                         # error | warn | info | debug
ENABLE_GRACEFUL_SHUTDOWN=true          # Graceful shutdown on SIGTERM/SIGINT

# ============================================================
# MONGODB (DUAL DATABASE)
# ============================================================
# Platform Database (application config)
MONGODB_URI=mongodb://user:pass@mongo-platform:27017/abl_platform?authSource=admin
MONGODB_MAX_POOL_SIZE=50
MONGODB_MIN_POOL_SIZE=10
MONGODB_SERVER_SELECTION_TIMEOUT_MS=30000

# Content Database (documents, chunks, KG)
SEARCHAI_CONTENT_DB_URI=mongodb://user:pass@mongo-content:27017/abl_content?authSource=admin
SEARCHAI_CONTENT_DB_NAME=abl_content
SEARCHAI_CONTENT_DB_MAX_POOL_SIZE=50
SEARCHAI_CONTENT_DB_MIN_POOL_SIZE=10

# ============================================================
# REDIS (JOB QUEUES)
# ============================================================
REDIS_URL=redis://redis:6379           # Single instance
# OR for cluster:
# REDIS_CLUSTER_NODES=redis-1:6379,redis-2:6379,redis-3:6379

# ============================================================
# CLICKHOUSE (ANALYTICS)
# ============================================================
CLICKHOUSE_HOST=clickhouse
CLICKHOUSE_PORT=8123                   # HTTP port
CLICKHOUSE_DATABASE=search_ai
CLICKHOUSE_USER=default
CLICKHOUSE_PASSWORD=<secure-password>
CLICKHOUSE_MAX_RETRIES=3
CLICKHOUSE_REQUEST_TIMEOUT=30000

# ============================================================
# VECTOR STORE
# ============================================================
VECTOR_STORE_PROVIDER=opensearch       # opensearch | qdrant | pinecone | pgvector
VECTOR_STORE_URL=http://opensearch:9200
VECTOR_STORE_API_KEY=<optional>        # For Pinecone or secured providers
VECTOR_STORE_TIMEOUT_MS=30000

# ============================================================
# EMBEDDING PROVIDER
# ============================================================
EMBEDDING_PROVIDER=bge-m3              # bge-m3 | openai | cohere
EMBEDDING_MODEL=bge-m3
EMBEDDING_DIMENSIONS=1024              # bge-m3: 1024, text-embedding-3-small: 1536
EMBEDDING_BASE_URL=http://bge-m3-service:8080  # For custom BGE-M3 service
EMBEDDING_MAX_BATCH_SIZE=32
EMBEDDING_TIMEOUT_MS=60000

# ============================================================
# KNOWLEDGE GRAPH (OPTIONAL)
# ============================================================
KNOWLEDGE_GRAPH_ENABLED=false          # Set to true to enable
NEO4J_URI=neo4j://neo4j:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=<secure-password>
NEO4J_DATABASE=neo4j
NEO4J_MAX_POOL_SIZE=100                # 100 recommended for 11-worker production load
KG_ENTITY_EXTRACTION_METHOD=hybrid    # regex | compromise | hybrid
KG_ENABLE_CO_OCCURRENCE=true
KG_CO_OCCURRENCE_WINDOW=5
KG_MIN_IDF_THRESHOLD=1.5

# ============================================================
# S3 STORAGE
# ============================================================
AWS_REGION=us-east-1
AWS_S3_BUCKET=search-ai-documents
AWS_ACCESS_KEY_ID=<access-key>
AWS_SECRET_ACCESS_KEY=<secret-key>
# OR for MinIO:
# S3_ENDPOINT=http://minio:9000
# S3_FORCE_PATH_STYLE=true

# ============================================================
# WORKER CONFIGURATION
# ============================================================
WORKER_CONCURRENCY=5                   # Base concurrency for workers
INGESTION_BATCH_SIZE=100              # Documents per ingestion batch
INGESTION_MAX_CONCURRENT_JOBS=5       # Max concurrent ingestion jobs
EXTRACTION_TIMEOUT_MS=30000           # Timeout for content extraction
EMBEDDING_BATCH_SIZE=50               # Embeddings per batch

# ============================================================
# NOISE DETECTION (OPTIONAL)
# ============================================================
NOISE_DETECTION_ENABLED=false         # Enable TF-IDF noise detection
NOISE_DETECTION_GLOBAL_THRESHOLD=0.3
NOISE_DETECTION_LOCAL_THRESHOLD=0.5
NOISE_DETECTION_FILTER_THRESHOLD=0.5
NOISE_DETECTION_ENABLE_FILTERING=false

# ============================================================
# MULTIMODAL (OPTIONAL)
# ============================================================
MULTIMODAL_ENABLED=false              # Enable image/table/chart processing
MULTIMODAL_VISION_PROVIDER=openai    # openai | anthropic
MULTIMODAL_VISION_API_KEY=<api-key>  # Optional - stored in DB
MULTIMODAL_VISION_MODEL=gpt-4-vision-preview
MULTIMODAL_TABLE_SUMMARIZER_PROVIDER=anthropic
MULTIMODAL_TABLE_SUMMARIZER_MODEL=claude-3-5-haiku-20241022
MULTIMODAL_ENABLE_IMAGE_DESCRIPTION=true
MULTIMODAL_ENABLE_TABLE_SUMMARIZATION=true
MULTIMODAL_MAX_IMAGE_SIZE_BYTES=20971520
MULTIMODAL_RATE_LIMIT_PER_MINUTE=60

# ============================================================
# TREE BUILDER (OPTIONAL)
# ============================================================
TREE_BUILDER_ENABLED=false            # Enable hierarchical chunk trees
TREE_BUILDER_SUMMARY_PROVIDER=openai
TREE_BUILDER_SUMMARY_MODEL=gpt-4o-mini
TREE_BUILDER_TARGET_CHUNK_SIZE=512
TREE_BUILDER_MAX_DEPTH=4

# ============================================================
# SECURITY
# ============================================================
JWT_SECRET=<32-char-random-secret>
JWT_EXPIRES_IN=24h
RATE_LIMIT_WINDOW_MS=60000            # 1 minute
RATE_LIMIT_MAX_REQUESTS=100           # Per tenant per window
ALLOWED_ORIGINS=https://studio.yourdomain.com,https://app.yourdomain.com
CORS_CREDENTIALS=true

# ============================================================
# MONITORING & OBSERVABILITY
# ============================================================
ENABLE_METRICS=true
METRICS_PORT=9090
ENABLE_TRACING=false                  # OpenTelemetry tracing
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318

# ============================================================
# FEATURE FLAGS
# ============================================================
ENABLE_DOCLING_EXTRACTION=true        # Advanced PDF parsing
ENABLE_QUESTION_SYNTHESIS=true        # Phase 2 LLM: Generate questions
ENABLE_PROGRESSIVE_SUMMARIZATION=true # Phase 2 LLM: Progressive summaries
ENABLE_SCOPE_CLASSIFICATION=true      # Scope/domain classification
ENABLE_VISUAL_ENRICHMENT=true         # Image/diagram processing
```

---

## 4. Kubernetes Deployment

### 4.1 Main Application Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: search-ai
  namespace: agent-platform
  labels:
    app: search-ai
    tier: backend
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  selector:
    matchLabels:
      app: search-ai
  template:
    metadata:
      labels:
        app: search-ai
      annotations:
        prometheus.io/scrape: 'true'
        prometheus.io/port: '9090'
    spec:
      serviceAccountName: search-ai
      containers:
        - name: search-ai
          image: gcr.io/your-project/agent-platform-search-ai:latest
          imagePullPolicy: Always
          ports:
            - name: http
              containerPort: 3005
              protocol: TCP
            - name: metrics
              containerPort: 9090
              protocol: TCP
          envFrom:
            - configMapRef:
                name: search-ai-config
            - secretRef:
                name: search-ai-secrets
          resources:
            requests:
              memory: '2Gi'
              cpu: '1000m'
            limits:
              memory: '4Gi'
              cpu: '2000m'
          livenessProbe:
            httpGet:
              path: /health
              port: 3005
            initialDelaySeconds: 30
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /health
              port: 3005
            initialDelaySeconds: 10
            periodSeconds: 5
            timeoutSeconds: 3
            failureThreshold: 2
          lifecycle:
            preStop:
              exec:
                command: ['/bin/sh', '-c', 'sleep 15']
---
apiVersion: v1
kind: Service
metadata:
  name: search-ai
  namespace: agent-platform
spec:
  type: ClusterIP
  selector:
    app: search-ai
  ports:
    - name: http
      port: 80
      targetPort: 3005
    - name: metrics
      port: 9090
      targetPort: 9090
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: search-ai-hpa
  namespace: agent-platform
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: search-ai
  minReplicas: 3
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
```

### 4.2 ConfigMap

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: search-ai-config
  namespace: agent-platform
data:
  NODE_ENV: 'production'
  PORT: '3005'
  LOG_LEVEL: 'info'

  # Database
  MONGODB_MAX_POOL_SIZE: '50'
  SEARCHAI_CONTENT_DB_MAX_POOL_SIZE: '50'

  # Redis
  REDIS_URL: 'redis://redis-master:6379'

  # ClickHouse
  CLICKHOUSE_HOST: 'clickhouse'
  CLICKHOUSE_PORT: '8123'
  CLICKHOUSE_DATABASE: 'search_ai'

  # Vector Store
  VECTOR_STORE_PROVIDER: 'opensearch'
  VECTOR_STORE_URL: 'http://opensearch:9200'

  # Embedding
  EMBEDDING_PROVIDER: 'bge-m3'
  EMBEDDING_MODEL: 'bge-m3'
  EMBEDDING_DIMENSIONS: '1024'
  EMBEDDING_BASE_URL: 'http://bge-m3-service:8080'

  # Workers
  WORKER_CONCURRENCY: '5'
  INGESTION_BATCH_SIZE: '100'

  # Features
  ENABLE_DOCLING_EXTRACTION: 'true'
  ENABLE_QUESTION_SYNTHESIS: 'true'
  ENABLE_PROGRESSIVE_SUMMARIZATION: 'true'
  KNOWLEDGE_GRAPH_ENABLED: 'false'
  MULTIMODAL_ENABLED: 'false'
```

### 4.3 Secrets

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: search-ai-secrets
  namespace: agent-platform
type: Opaque
stringData:
  # MongoDB
  MONGODB_URI: 'mongodb://username:password@mongo-platform:27017/abl_platform?authSource=admin'
  SEARCHAI_CONTENT_DB_URI: 'mongodb://username:password@mongo-content:27017/abl_content?authSource=admin'

  # ClickHouse
  CLICKHOUSE_PASSWORD: '<secure-password>'

  # S3
  AWS_ACCESS_KEY_ID: '<access-key>'
  AWS_SECRET_ACCESS_KEY: '<secret-key>'

  # Security
  JWT_SECRET: '<32-char-random-secret>'

  # Neo4j (if enabled)
  NEO4J_PASSWORD: '<secure-password>'
```

---

## 5. Supporting Services Deployment

### 5.1 Redis (BullMQ Queues)

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis
  namespace: agent-platform
spec:
  serviceName: redis
  replicas: 1
  selector:
    matchLabels:
      app: redis
  template:
    metadata:
      labels:
        app: redis
    spec:
      containers:
        - name: redis
          image: redis:7-alpine
          ports:
            - containerPort: 6379
          resources:
            requests:
              memory: '512Mi'
              cpu: '250m'
            limits:
              memory: '1Gi'
              cpu: '500m'
          volumeMounts:
            - name: redis-data
              mountPath: /data
  volumeClaimTemplates:
    - metadata:
        name: redis-data
      spec:
        accessModes: ['ReadWriteOnce']
        resources:
          requests:
            storage: 10Gi
```

### 5.2 OpenSearch (Vector Store - Primary)

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: opensearch
  namespace: agent-platform
spec:
  serviceName: opensearch
  replicas: 1
  selector:
    matchLabels:
      app: opensearch
  template:
    metadata:
      labels:
        app: opensearch
    spec:
      containers:
        - name: opensearch
          image: opensearchproject/opensearch:2.11.0
          ports:
            - containerPort: 9200
            - containerPort: 9600
          env:
            - name: discovery.type
              value: single-node
            - name: DISABLE_SECURITY_PLUGIN
              value: 'true'
            - name: OPENSEARCH_JAVA_OPTS
              value: '-Xms2g -Xmx2g'
          resources:
            requests:
              memory: '3Gi'
              cpu: '1000m'
            limits:
              memory: '4Gi'
              cpu: '2000m'
          volumeMounts:
            - name: opensearch-data
              mountPath: /usr/share/opensearch/data
  volumeClaimTemplates:
    - metadata:
        name: opensearch-data
      spec:
        accessModes: ['ReadWriteOnce']
        resources:
          requests:
            storage: 100Gi
```

### 5.3 Python ML Services (Deployed via Helm Chart)

The following Python services are deployed as part of the `abl-platform` Helm chart (not standalone manifests). See `abl-platform-deploy` repo for the Helm templates.

| Service                   | Port | Image                       | Purpose                                                 | Helm Key          |
| ------------------------- | ---- | --------------------------- | ------------------------------------------------------- | ----------------- |
| **docling-service**       | 8080 | `abl-docling-service`       | Advanced PDF/document extraction (OCR, tables, layout)  | `docling.*`       |
| **bge-m3-service**        | 8000 | `abl-bge-m3-service`        | BGE-M3 embedding generation (OpenAI-compatible API)     | `bgeM3.*`         |
| **preprocessing-service** | 8003 | `abl-preprocessing-service` | Text preprocessing (stemming, stopwords, normalization) | `preprocessing.*` |

Enable in `values-dev.yaml`:

```yaml
docling:
  enabled: true
bgeM3:
  enabled: true
preprocessing:
  enabled: true
```

---

## 6. Health Checks & Monitoring

### 6.1 Health Check Endpoints

| Endpoint              | Purpose                | Expected Response                                            |
| --------------------- | ---------------------- | ------------------------------------------------------------ |
| `GET /health`         | Overall service health | `{ "status": "ok", "database": "connected", "workers": 16 }` |
| `GET /health/db`      | Database connectivity  | `{ "platform": "connected", "content": "connected" }`        |
| `GET /health/redis`   | Redis connectivity     | `{ "status": "connected" }`                                  |
| `GET /health/workers` | Worker status          | Array of worker statuses                                     |

### 6.2 Prometheus Metrics

Exposed on port `9090`:

```
# Worker metrics
search_ai_worker_jobs_completed_total{worker="ingestion"}
search_ai_worker_jobs_failed_total{worker="extraction"}
search_ai_worker_processing_duration_seconds{worker="embedding"}

# Queue metrics
search_ai_queue_depth{queue="ingestion"}
search_ai_queue_waiting{queue="extraction"}
search_ai_queue_active{queue="embedding"}

# HTTP metrics
http_request_duration_seconds{method="GET",path="/api/indexes"}
http_requests_total{method="POST",path="/api/indexes",status="200"}
```

### 6.3 Logging

Structured JSON logs to stdout:

```json
{
  "level": "info",
  "timestamp": "2026-03-02T10:15:30.123Z",
  "service": "search-ai",
  "requestId": "req_abc123",
  "worker": "page-processing",
  "message": "Generated summary for page 1",
  "metadata": {
    "tokens": 213,
    "cost": "0.000225"
  }
}
```

---

## 7. Scaling Guidelines

### 7.1 Application Scaling

| Load Level                      | Replicas | CPU per Pod | Memory per Pod | Workers per Pod |
| ------------------------------- | -------- | ----------- | -------------- | --------------- |
| **Low** (< 1000 docs/day)       | 2        | 500m        | 1Gi            | 3               |
| **Medium** (1k-10k docs/day)    | 3-5      | 1000m       | 2Gi            | 5               |
| **High** (10k-100k docs/day)    | 5-10     | 2000m       | 4Gi            | 7               |
| **Very High** (> 100k docs/day) | 10-20    | 2000m       | 4Gi            | 10              |

### 7.2 Worker-Specific Scaling

For high-load scenarios, consider separating workers into dedicated pods:

```yaml
# Ingestion-focused pod
WORKER_CONCURRENCY=10
INGESTION_BATCH_SIZE=200

# Embedding-focused pod
WORKER_CONCURRENCY=8
EMBEDDING_BATCH_SIZE=100
```

### 7.3 Database Scaling

| Component      | Scaling Strategy                            |
| -------------- | ------------------------------------------- |
| **MongoDB**    | Replica set (3-5 nodes), sharding for > 1TB |
| **Redis**      | Cluster mode (3+ nodes) for > 10k jobs/sec  |
| **ClickHouse** | Cluster with replication for analytics      |
| **OpenSearch** | Cluster with sharding and replication       |
| **Neo4j**      | Cluster mode (Enterprise) for KG features   |

---

## 8. Backup & Disaster Recovery

### 8.1 Data Backup

| Data Store           | Backup Frequency | Retention | Method                |
| -------------------- | ---------------- | --------- | --------------------- |
| **MongoDB Platform** | Daily            | 30 days   | mongodump + S3        |
| **MongoDB Content**  | Daily            | 7 days    | mongodump + S3        |
| **Redis**            | Hourly snapshots | 24 hours  | RDB snapshots         |
| **ClickHouse**       | Daily            | 30 days   | Backup to S3          |
| **OpenSearch**       | Daily            | 7 days    | Index snapshots to S3 |
| **Neo4j**            | Daily            | 30 days   | Neo4j backup + S3     |

### 8.2 Recovery Procedures

1. **Application Failure**: Rolling update reverts automatically
2. **Database Failure**: Restore from latest backup (< 1 hour RTO)
3. **Complete Outage**: Multi-region failover (if configured)

---

## 9. Security Considerations

### 9.1 Network Security

- All inter-service communication over TLS
- Redis password-protected
- MongoDB authentication required
- API endpoints behind authentication middleware
- Rate limiting per tenant

### 9.2 Secrets Management

- Use Kubernetes Secrets or external vault (HashiCorp Vault, AWS Secrets Manager)
- Rotate credentials quarterly
- LLM API keys stored encrypted in MongoDB (`LLMCredential` model)
- JWT secret must be 32+ characters random string

### 9.3 Access Control

- Service account with minimal permissions
- Network policies to restrict pod-to-pod communication
- No root containers (uses `nonroot` user)

---

## 10. Cost Optimization

### 10.1 LLM API Costs

Configure per-index LLM budgets in `SearchIndex.llmConfig`:

```javascript
{
  "llmConfig": {
    "monthlyTokenBudget": 10000000,  // 10M tokens/month
    "dailyTokenBudget": 500000,      // 500k tokens/day
    "maxRequestsPerMinute": 60
  }
}
```

### 10.2 Infrastructure Costs

| Optimization              | Savings     | Trade-off                    |
| ------------------------- | ----------- | ---------------------------- |
| Use BGE-M3 (self-hosted)  | ~$500/month | Requires GPU                 |
| Disable multimodal        | ~$200/month | No image analysis            |
| Reduce worker concurrency | ~30% CPU    | Slower processing            |
| Use dedicated Qdrant      | ~$300/month | vs shared OpenSearch cluster |

---

## 11. Deployment Checklist

### Pre-Deployment

- [ ] All infrastructure services running (MongoDB, Redis, ClickHouse, OpenSearch)
- [ ] Secrets configured in Kubernetes
- [ ] ConfigMap created with environment config
- [ ] Database migrations completed
- [ ] S3 bucket created and accessible
- [ ] LLM credentials added to MongoDB

### Deployment

- [ ] Build and push Docker image
- [ ] Apply Kubernetes manifests
- [ ] Verify health checks passing
- [ ] Check worker status via `/health/workers`
- [ ] Test ingestion pipeline with sample document
- [ ] Verify search functionality

### Post-Deployment

- [ ] Monitor logs for errors
- [ ] Check Prometheus metrics
- [ ] Verify job queues processing
- [ ] Test Phase 2 LLM features (summarization, questions)
- [ ] Configure alerts for failures
- [ ] Document any environment-specific changes

---

## 12. Troubleshooting

### Common Issues

| Issue                     | Symptom                   | Solution                                                                       |
| ------------------------- | ------------------------- | ------------------------------------------------------------------------------ |
| Workers not processing    | Queue depth increasing    | Check Redis connectivity, restart pods                                         |
| MongoDB connection errors | `ECONNREFUSED`            | Verify MongoDB URI, credentials                                                |
| LLM API failures          | 401/403 errors            | Check API keys in `LLMCredential` collection                                   |
| Out of memory             | Pod restarts              | Increase memory limits, reduce concurrency                                     |
| Slow embedding            | High queue depth          | Scale embedding workers, check BGE-M3 service                                  |
| Vector search errors      | Search returns no results | Verify OpenSearch connectivity, check index exists, verify k-NN plugin enabled |

### Debug Commands

```bash
# Check pod logs
kubectl logs -n agent-platform deployment/search-ai --tail=100 -f

# Check worker status
kubectl exec -n agent-platform deployment/search-ai -- curl localhost:3005/health/workers

# Check Redis queue depth
kubectl exec -n agent-platform statefulset/redis -- redis-cli LLEN ingestion

# Check MongoDB connection
kubectl exec -n agent-platform deployment/search-ai -- curl localhost:3005/health/db

# Force restart workers
kubectl rollout restart deployment/search-ai -n agent-platform
```

---

## 13. Contact & Support

**Team:** Search-AI Platform Team
**On-call:** PagerDuty rotation
**Documentation:** https://docs.yourcompany.com/search-ai
**Runbooks:** https://runbooks.yourcompany.com/search-ai

---

**End of Deployment Guide**

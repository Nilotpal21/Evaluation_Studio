# ABL Platform Technical Architecture

## System Overview

The ABL Platform is a cloud-native, multi-tenant AI infrastructure designed to power intelligent search, conversational agents, and knowledge management at enterprise scale. It is built as a distributed microservices system that separates concerns across ingestion, retrieval, reasoning, and presentation layers. Each layer is independently scalable, observable, and upgradeable without impacting adjacent services.

The platform is structured as a monorepo managed with pnpm and Turbo, enabling shared packages and consistent dependency management across all services. Services communicate over HTTP/REST internally and expose standardized APIs externally. All infrastructure is containerized via Docker and orchestrated through Kubernetes in production environments, with Helm charts and ArgoCD managing deployment lifecycle across environments.

At its core, the platform enables organizations to connect structured and unstructured data sources, process and index that content through configurable AI pipelines, and expose the resulting knowledge through search and conversational interfaces. The design prioritizes tenant isolation, data security, and operational transparency at every layer.

## Core Services

### Runtime Service (Port 3112)

The Runtime service is the central orchestration engine for all AI agent execution. It manages the lifecycle of agent sessions, coordinates tool calls, handles multi-agent handoffs, and maintains conversation state across interactions. Agents are defined declaratively using a DSL that specifies model configuration, tool bindings, prompt templates, and routing logic.

The Runtime service supports multiple LLM providers through a provider-neutral abstraction layer, allowing agents to be configured with OpenAI, Anthropic, Azure OpenAI, or custom-hosted models without changing agent logic. Credential resolution follows a hierarchical lookup: agent-level credentials take precedence, followed by project-level, tenant-level, and finally system defaults.

Session state is maintained in Redis with configurable TTLs, while durable execution records and trace events are persisted to MongoDB. The service implements distributed locking to prevent concurrent mutations to shared session state across pod replicas.

### Search AI Service (Port 3113)

The Search AI service is responsible for all knowledge ingestion and retrieval operations. It manages knowledge bases, search indexes, document sources, and ingestion pipelines. When documents are added to a knowledge base, the Search AI service orchestrates a multi-stage pipeline that includes document parsing, chunking, embedding generation, metadata extraction, and index population.

The ingestion pipeline is implemented using BullMQ Flows, enabling fine-grained control over parallelism, retry behavior, and progress tracking at each pipeline stage. Documents pass through a Preprocessing service for format normalization, a Docling service for advanced PDF parsing, and a BGE-M3 service for dense vector embedding generation. Results are stored across multiple data stores depending on the retrieval strategy configured for each index.

The Search AI Runtime (port 3114) is a companion service that handles real-time query execution against populated indexes, supporting keyword, vector, and hybrid retrieval modes with configurable relevance tuning.

### Studio (Port 5173)

Studio is the primary user interface for the ABL Platform. It is built with React and Vite and provides workspace management, agent configuration, knowledge base management, search testing, and analytics dashboards. The Studio frontend communicates exclusively through the platform's public API layer and does not have direct access to any backend data stores.

The Studio design system is built on a custom component library with consistent typography, color semantics, and animation primitives. It supports real-time updates for long-running operations such as document ingestion and agent session streaming through server-sent events.

### Admin Service (Port 3003)

The Admin service provides tenant management, user provisioning, billing integration, and system configuration capabilities. It is accessible only to users with administrative roles and exposes a separate API surface from the main platform API. All admin operations are audit-logged and subject to additional rate limiting.

## Data Architecture

### MongoDB

MongoDB serves as the primary operational database for the platform. All domain entities—tenants, projects, agents, knowledge bases, sources, documents, conversations, and sessions—are stored in MongoDB collections. Each collection enforces tenant isolation through mandatory `tenantId` fields on every document. Queries are always scoped by `tenantId` at the application layer, and indexes are designed to support these scoped lookups efficiently.

The platform uses MongoDB transactions for operations that span multiple collections, such as creating a knowledge base and its associated search index atomically. Document schemas are managed through code-level validation and are versioned to support online migrations without downtime.

### Redis

Redis is used for three primary purposes: session state caching, distributed locking, and job queue management. Session data for active agent conversations is stored in Redis with sliding expiration windows, enabling fast read/write operations without database load. Distributed locks implemented using the `SET NX PX` pattern prevent race conditions across horizontally scaled service pods.

BullMQ, the job queue library, uses Redis as its backing store for all ingestion and background processing pipelines. Queue configuration includes per-tenant rate limiting, dead-letter queues for failed jobs, and metrics collection for queue depth and throughput monitoring.

### ClickHouse

ClickHouse is the analytical database used for high-volume event storage and query analytics. It stores conversation events, search query logs, agent performance metrics, and usage telemetry. Its columnar storage engine enables fast aggregation queries over large event sets that would be impractical in MongoDB.

Analytics pipelines write events to ClickHouse in micro-batches to balance write throughput with query freshness. The platform's analytics dashboards read directly from ClickHouse for real-time reporting on search quality, agent effectiveness, and user engagement trends.

### OpenSearch

OpenSearch provides full-text and BM25 keyword search capabilities across document collections. When a search index is configured for keyword or hybrid retrieval, document chunks are indexed into OpenSearch with rich metadata fields to support faceted filtering and relevance boosting. OpenSearch is also used for log aggregation and infrastructure-level observability data.

Index lifecycle policies automatically manage shard allocation and segment merging as indexes grow, and per-tenant index namespacing ensures complete data isolation in multi-tenant deployments.

### Qdrant

Qdrant is the vector database used for dense similarity search. During document ingestion, chunk embeddings produced by the BGE-M3 embedding model are stored in Qdrant collections alongside metadata payloads. At query time, the Search AI Runtime generates embeddings for incoming queries and performs approximate nearest-neighbor search in Qdrant to retrieve semantically relevant chunks.

Qdrant collections are configured with HNSW index parameters tuned for the platform's accuracy and latency requirements. Payload filtering allows retrieval to be scoped by project, source, or custom metadata tags without full collection scans.

### Neo4j

Neo4j is used for knowledge graph construction and graph-based reasoning capabilities. When enabled for a knowledge base, the ingestion pipeline extracts entity-relationship triples from documents and stores them as graph nodes and edges in Neo4j. This enables graph traversal queries that complement vector and keyword retrieval, particularly for use cases involving complex relational knowledge such as organizational hierarchies, product dependencies, or regulatory frameworks.

## Security Model

The platform implements a layered security model with authentication, authorization, and data isolation enforced at every boundary. All external API requests are authenticated using JWT tokens or API keys, validated by the unified auth middleware before reaching any business logic. Token validation is centralized and never duplicated in individual route handlers.

Authorization follows a role-based access control model with fine-grained permissions scoped to tenants, projects, and resource types. The `requirePermission()` utility enforces permission checks declaratively at the route level. Cross-scope access—for example, a user in one project accessing resources in another—returns a 404 response rather than 403 to avoid leaking information about resource existence.

All data at rest is encrypted using AES-256, and all data in transit uses TLS 1.2 or higher. Sensitive fields such as API credentials, OAuth tokens, and personal identifiers are encrypted at the application layer before storage in MongoDB. Encryption keys are managed externally through a key management service and rotated on a scheduled basis.

## Deployment Architecture

In production, all platform services run as Kubernetes deployments with horizontal pod autoscaling configured based on CPU utilization and custom queue-depth metrics. Service discovery uses Kubernetes DNS, and ingress traffic is routed through an NGINX ingress controller with rate limiting and DDoS protection at the edge.

The deployment configuration is maintained in a separate `abl-platform-deploy` repository using Helm charts and ArgoCD for GitOps-based continuous delivery. Environment-specific configuration is managed through Kubernetes secrets and ConfigMaps, with sensitive values stored in an external secrets manager and synchronized into the cluster at deploy time.

Health checks, readiness probes, and liveness probes are configured for all services to enable zero-downtime rolling deployments. Distributed tracing is implemented across all services using OpenTelemetry, with traces collected and visualized through Coroot for production observability.

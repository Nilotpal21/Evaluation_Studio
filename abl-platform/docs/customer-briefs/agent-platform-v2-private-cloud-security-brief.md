# Agent Platform V2 — Private Cloud Security & Architecture Brief

**Audience:** Customer Information Security teams evaluating Agent Platform V2 for private-cloud deployment.
**Deployment model:** Single-tenant, customer-owned Azure subscription (customer VNet injection).
**Industry profile:** Regulated financial services.
**Document owner:** Kore.ai Platform Engineering.
**Version:** 2.0 — derived from the `develop` branch of `abl-platform`, `develop` branch of `abl-platform-infra`, and `main` branch of `abl-platform-deploy` as of April 2026.

This document is source-verified. Every control described below is implemented and traceable to code in one of the three repositories above. Where a control is partial, roadmapped, or customer-configurable, that is stated explicitly.

---

## 1. Executive Summary

Agent Platform V2 is a multi-service agent platform that lets business and technical users build, deploy, and operate AI agents, search experiences, and durable workflows against their own enterprise data and tooling. The reference production deployment is Azure-native (AKS on Azure CNI Overlay with Cilium, Azure Key Vault for secrets, Azure Application Gateway WAF for north-south traffic), delivered via a Helm umbrella chart managed by ArgoCD, with infrastructure provisioned through OpenTofu/Terraform.

For the customer's private-cloud engagement, the same Helm chart and Terraform modules deploy into a **customer-owned Azure subscription, inside customer-provided VNets**. All data processing — metadata, session transcripts, vector embeddings, event streams — remains inside the customer's network boundary. External egress is limited to (a) LLM provider APIs the customer explicitly configures and (b) optional managed SaaS integrations the customer enables.

Key security properties:

- **AES-256-GCM envelope encryption** with per-tenant Data Encryption Keys (DEKs), wrapped by a Tenant KEK, rooted in customer-controlled KMS (Azure Key Vault / Azure Managed HSM / AWS KMS / GCP Cloud KMS).
- **AsyncLocalStorage-based tenant isolation** enforced by a Mongoose plugin — cross-tenant queries are structurally impossible and cross-tenant access returns HTTP 404 (not 403) to prevent tenant enumeration.
- **Unified auth middleware** supporting enterprise SSO (Azure AD, Okta, Google, generic OIDC), SAML 2.0, Kerberos, WS-Security, and platform-issued API keys with project/environment scope.
- **Azure Application Gateway WAF** (OWASP 3.2 + Bot Manager, Prevention mode in production) at ingress, Cilium NetworkPolicies for east-west restriction, private endpoints for ACR/Storage.
- **Azure Workload Identity** (OIDC federation) — no static service credentials in pods.
- **Immutable audit trail** for authentication events, sensitive model writes, and PII access, with TTL-based retention in MongoDB and ClickHouse.
- **All open-source components with pinned versions** — see Section 3 for the complete inventory.

Known gaps disclosed in Section 17.

---

## 2. Deployment Model for This Engagement

| Property           | Value                                                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hosting            | Customer-owned Azure subscription                                                                                                                          |
| Compute            | Azure Kubernetes Service (AKS) — customer's VNet, customer's subnets                                                                                       |
| Container registry | Customer ACR (Premium) with private endpoint, or external registry via image mirror                                                                        |
| Secrets store      | Customer Azure Key Vault with RBAC authorization                                                                                                           |
| Data stores        | Self-hosted inside AKS (MongoDB 7, ClickHouse 24.3, Redis 7, Qdrant, OpenSearch 3.1, Neo4j 5) — no external PaaS data dependency                           |
| Ingress            | Azure Application Gateway WAF_v2 → NGINX Ingress Controller (internal LB) → pods                                                                           |
| Tenancy            | Dedicated stack per customer group (namespace-per-environment). Cluster sharing is configurable but is **not** the recommended model for regulated finance |
| Internet egress    | Restricted to LLM endpoints and optional integrations explicitly enabled by the customer                                                                   |
| Observability      | Coroot (CE) + OpenTelemetry collector deployed inside the cluster; no data leaves the customer boundary unless customer forwards to their own SIEM         |
| IaC                | OpenTofu (Terraform-compatible), Harness IaCM for pipeline orchestration, or customer-run Terraform                                                        |
| Change management  | ArgoCD GitOps with mandatory PR approval gates (2 approvers for production)                                                                                |

**Six customer groups, same scope:** Each group receives an isolated stack (separate namespace set, separate DB instances, separate Key Vault, separate ArgoCD Application). Group-to-group isolation is physical at the data layer; within a group, Agent Platform V2's application-level multi-tenancy applies to sub-organizations if the group uses the platform to serve internal tenants.

---

## 3. Open-Source Component Inventory

All versions below are source-verified from `package.json`, `pyproject.toml`, `requirements.txt`, `go.mod`, `docker-compose.yml`, and Dockerfile files in the `abl-platform` repository as of the `develop` branch, April 2026.

### 3.1 Runtime Languages and Package Managers

| Component  | Version                                     | Notes                                                              |
| ---------- | ------------------------------------------- | ------------------------------------------------------------------ |
| Node.js    | 24.x (engine constraint `>=24.0.0 <25.0.0`) | All Node.js application services                                   |
| Python     | 3.11.x                                      | ML/document services (docling, bge-m3, preprocessing, nlu-sidecar) |
| Go         | 1.24                                        | Crawler go-worker service                                          |
| pnpm       | 9.15.0 (pinned in Dockerfiles)              | Node.js monorepo package manager                                   |
| TypeScript | 5.3–5.7 (varies by package)                 | Compile-time type safety                                           |

### 3.2 Infrastructure — Data Stores

| Component    | Version                                        | Role                                                                                      |
| ------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------- |
| MongoDB      | 7 (Community)                                  | Primary control plane — tenant metadata, agents, credentials (encrypted), projects, users |
| ClickHouse   | 24.3                                           | High-volume operational data — messages, traces, LLM metrics, audit events, logs          |
| Redis        | 7-alpine                                       | Cache, distributed locks, BullMQ queues, rate-limit counters, JWKS cache                  |
| OpenSearch   | 3.1.0 (docker-compose) / 3.3 (Helm/production) | Vector + lexical search (hybrid retrieval)                                                |
| Qdrant       | latest (dev) / pinned per-deployment (prod)    | Alternative vector store                                                                  |
| Neo4j        | 5                                              | Knowledge graph                                                                           |
| Apache Kafka | 4.2.0                                          | Event streaming for runtime events, 7-day retention                                       |
| Restate      | 1.6.2                                          | Durable workflow journal                                                                  |

### 3.3 Infrastructure — Kubernetes Operators (Production)

| Component                           | Version                          | Role                                        |
| ----------------------------------- | -------------------------------- | ------------------------------------------- |
| Percona Server for MongoDB Operator | 1.22.0                           | MongoDB cluster lifecycle management in AKS |
| Percona Backup for MongoDB (PBM)    | 2.7                              | MongoDB backup and restore                  |
| Altinity ClickHouse Operator        | 0.26.0                           | ClickHouse cluster lifecycle management     |
| External Secrets Operator           | managed in `abl-platform-infra`  | Azure Key Vault → Kubernetes Secret sync    |
| Cilium                              | managed in `abl-platform-infra`  | CNI, NetworkPolicies, egress enforcement    |
| ArgoCD                              | managed in `abl-platform-deploy` | GitOps continuous delivery                  |

### 3.4 Web Frameworks

| Component | Version                                             | Services                                                           |
| --------- | --------------------------------------------------- | ------------------------------------------------------------------ |
| Express   | 4.18–4.21 (stable APIs); 5.2.1 (crawler-mcp-server) | runtime, search-ai, search-ai-runtime, academy, multimodal-service |
| Next.js   | 16.2.3                                              | studio, admin                                                      |
| React     | 19.2.4                                              | studio, admin                                                      |
| Vite      | 7.3.0                                               | web-sdk                                                            |
| Flask     | 3.0.0                                               | bge-m3-service, preprocessing-service, nlu-sidecar                 |
| FastAPI   | 0.109+ / 0.120.1                                    | docling-service, codetool-sandbox                                  |
| uvicorn   | 0.26–0.27                                           | ASGI server for Python services                                    |
| Gunicorn  | 22.0.0                                              | WSGI server for preprocessing, nlu-sidecar                         |

### 3.5 AI / LLM SDKs

| Component                                   | Version                    | Notes                                 |
| ------------------------------------------- | -------------------------- | ------------------------------------- |
| Vercel AI SDK (`ai`)                        | 6.0.99                     | Unified LLM adapter                   |
| @ai-sdk/openai                              | 3.0.33                     | OpenAI provider                       |
| @ai-sdk/anthropic                           | 3.0.47                     | Anthropic provider                    |
| @ai-sdk/google                              | 3.0.31                     | Google Gemini provider                |
| @ai-sdk/google-vertex                       | 4.0.63                     | Google Vertex AI provider             |
| @ai-sdk/azure                               | 3.0.34                     | Azure OpenAI provider                 |
| @ai-sdk/cohere                              | 3.0.21                     | Cohere provider                       |
| @anthropic-ai/sdk                           | 0.78.0                     | Direct Anthropic SDK (search-ai)      |
| openai (npm)                                | 4.77.0                     | Direct OpenAI SDK                     |
| @modelcontextprotocol/sdk                   | 1.0.4                      | MCP browser automation                |
| @a2a-js/sdk                                 | 0.3.13                     | Agent-to-agent communication          |
| sentence-transformers                       | 3.0.0+                     | Local BGE-M3 embedding model (Python) |
| PyTorch                                     | 2.6–2.8 (service-specific) | Local ML inference                    |
| onnxruntime-gpu                             | 1.23.2                     | ONNX inference acceleration           |
| tiktoken                                    | 0.5.0+                     | Token counting                        |
| HuggingFace Text Embeddings Inference (TEI) | 1.2                        | Optional TEI deployment for BGE-M3    |

### 3.6 Database Clients

| Component                      | Version                 | Notes                                  |
| ------------------------------ | ----------------------- | -------------------------------------- |
| Mongoose                       | 8.23.0                  | MongoDB ODM (primary)                  |
| mongodb (driver)               | 7.1.0                   | Lower-level driver                     |
| @clickhouse/client             | 1.8.0–1.17.0            | ClickHouse HTTP/TCP client             |
| ioredis                        | 5.9.3 (pinned override) | Redis client                           |
| neo4j-driver                   | 5.28.3                  | Knowledge graph client                 |
| @opensearch-project/opensearch | 3.1.0                   | OpenSearch client                      |
| @qdrant/js-client-rest         | 1.12.0                  | Qdrant REST client                     |
| redis (Python)                 | 5.0.1                   | Redis client for preprocessing-service |

### 3.7 Messaging and Queuing

| Component                       | Version      | Notes                                                    |
| ------------------------------- | ------------ | -------------------------------------------------------- |
| BullMQ                          | 5.0.0–5.70.1 | Job queues — LLM requests, message persistence, crawling |
| KafkaJS                         | 2.2.4        | Kafka client for event streaming                         |
| @restatedev/restate-sdk         | 1.10.4       | Durable workflow SDK                                     |
| @restatedev/restate-sdk-clients | 1.4          | Restate workflow clients                                 |

### 3.8 Authentication and Security

| Component            | Version | Notes                                                            |
| -------------------- | ------- | ---------------------------------------------------------------- |
| jsonwebtoken         | 9.0.2   | JWT sign/verify (restricted to shared-auth package by lint hook) |
| jose                 | 5.10.0  | JOSE standard implementation                                     |
| jwks-rsa             | 3.1.0   | JWKS key fetching (Redis-cached)                                 |
| bcryptjs             | 3.0.3   | Password hashing                                                 |
| @node-saml/node-saml | 5.1.0   | SAML 2.0 SP/IdP flows                                            |
| arctic               | 3.7.0   | OAuth 2.0 flows                                                  |
| otplib               | 13.3.0  | TOTP generation                                                  |
| otpauth              | 9.5.0   | TOTP for studio                                                  |
| google-auth-library  | 9.14.2  | Google Workspace identity                                        |
| @azure/identity      | 4.13.0  | Azure AD / Workload Identity                                     |
| helmet               | 8.1.0   | HTTP security headers                                            |
| cors                 | 2.8.5   | Cross-origin resource sharing                                    |
| clamscan             | 2.4.0   | File upload antivirus scanning                                   |

### 3.9 Observability

| Component                                 | Version                          | Notes                             |
| ----------------------------------------- | -------------------------------- | --------------------------------- |
| pino                                      | 9.6.0                            | Structured JSON logging           |
| @opentelemetry/api                        | 1.9.0                            | OTel instrumentation API          |
| @opentelemetry/sdk-node                   | 0.57.0                           | OTel Node.js SDK                  |
| @opentelemetry/sdk-metrics                | 1.29.0                           | Metrics SDK                       |
| @opentelemetry/sdk-logs                   | 0.57.0                           | Logs SDK                          |
| @opentelemetry/auto-instrumentations-node | 0.70.0                           | Auto-instrumentation              |
| @opentelemetry/exporter-trace-otlp-grpc   | 0.57.0                           | OTLP trace export                 |
| @opentelemetry/exporter-metrics-otlp-grpc | 0.57.0                           | OTLP metrics export               |
| @opentelemetry/exporter-logs-otlp-grpc    | 0.57.0                           | OTLP log export                   |
| @opentelemetry/semantic-conventions       | 1.28.0                           | OTel semantic conventions         |
| prometheus-client (Python)                | 0.19.0                           | Metrics for preprocessing-service |
| Coroot Community Edition                  | managed in `abl-platform-deploy` | In-cluster observability platform |

### 3.10 Validation and Schema

| Component                      | Version                                            | Notes                                     |
| ------------------------------ | -------------------------------------------------- | ----------------------------------------- |
| Zod                            | 3.22–3.25 (most packages), 4.3.6 (workflow-engine) | Runtime schema validation — platform-wide |
| ajv                            | 8.18.0                                             | JSON Schema validation                    |
| pydantic                       | 2.5–2.10 (service-specific)                        | Python data validation                    |
| @asteasolutions/zod-to-openapi | 7.3.0                                              | OpenAPI spec generation                   |
| react-hook-form                | 7.71.2                                             | Form validation (studio)                  |

### 3.11 HTTP and Networking

| Component             | Version                     | Notes                            |
| --------------------- | --------------------------- | -------------------------------- |
| ws                    | 8.16.0                      | WebSocket server/client          |
| axios                 | 1.15.0+ (security override) | HTTP client (search-ai, crawler) |
| undici                | 7.24.7 (pinned override)    | HTTP/1.1 client                  |
| compression           | 1.8.1                       | HTTP response compression        |
| multer                | 2.0.2+ (security override)  | Multipart file uploads           |
| rate-limiter-flexible | 5.0.0                       | Rate limiting                    |

### 3.12 Voice and Real-Time

| Component                         | Version | Notes                                |
| --------------------------------- | ------- | ------------------------------------ |
| @livekit/agents                   | 1.0.44  | LiveKit media agent SDK              |
| @livekit/agents-plugin-deepgram   | 1.0.44  | Deepgram STT plugin                  |
| @livekit/agents-plugin-elevenlabs | 1.0.44  | ElevenLabs TTS plugin                |
| @livekit/agents-plugin-silero     | 1.0.44  | Silero VAD (local, no external call) |
| @livekit/rtc-node                 | 0.13.24 | LiveKit RTC Node.js SDK              |
| livekit-server-sdk                | 2.15.0  | LiveKit server SDK                   |
| livekit-client                    | 2.17.1  | LiveKit browser client               |
| twilio                            | 5.3.0   | Twilio voice/telephony SDK           |
| @twilio/voice-sdk                 | 2.10.0  | Twilio browser voice SDK             |

### 3.13 Document Processing and NLP

| Component                | Version | Notes                                               |
| ------------------------ | ------- | --------------------------------------------------- |
| docling                  | 1.5.0+  | Document conversion (PDF, DOCX, PPTX, OCR) — Python |
| llama-index              | 0.9.0+  | Document indexing                                   |
| PyPDF2                   | 3.0.0+  | PDF processing                                      |
| python-docx              | 1.0.0+  | DOCX processing                                     |
| python-pptx              | 0.6.23+ | PPTX processing                                     |
| Pillow                   | 10.2.0+ | Image processing                                    |
| pdf2image                | 1.17.0+ | PDF rasterization                                   |
| lingua-language-detector | 2.0.0+  | Language detection                                  |
| nltk                     | 3.9.3+  | NLP toolkit                                         |
| langdetect               | 1.0.9   | Language detection (preprocessing)                  |
| cheerio                  | 1.0.0   | HTML parsing                                        |
| @mozilla/readability     | 0.5.0   | Web content extraction                              |
| exceljs                  | 4.4.0   | Excel file processing                               |
| papaparse                | 5.4.1   | CSV processing                                      |
| tiktoken                 | 0.5.0+  | Token counting                                      |

### 3.14 Code Execution Sandbox (Codetool)

| Component                | Version                 | Notes                                  |
| ------------------------ | ----------------------- | -------------------------------------- |
| Ubuntu                   | 22.04 LTS               | Sandbox base OS                        |
| gVisor (runsc)           | 20250811 (release date) | User-space kernel for isolation        |
| Node.js (inside sandbox) | 22.22.0                 | User code runtime                      |
| Python (inside sandbox)  | 3.12                    | User code runtime                      |
| NVM                      | 0.40.2                  | Node.js version manager inside sandbox |
| httpx                    | 0.26.0                  | HTTP client for sandbox (Python)       |
| FastAPI                  | 0.120.1                 | Sandbox API server                     |

### 3.15 Container Base Images (Production)

| Image                                 | Pinned SHA        | Services                                                                                           |
| ------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------- |
| `gcr.io/distroless/nodejs22-debian12` | Yes (SHA digest)  | runtime, studio, admin, search-ai, search-ai-runtime, workflow-engine, multimodal, pipeline-engine |
| `gcr.io/distroless/static-debian12`   | No                | crawler-go-worker                                                                                  |
| `python:3.11-slim`                    | No                | docling-service, bge-m3-service, preprocessing-service, nlu-sidecar                                |
| `golang:1.25.9-alpine`                | No (builder only) | crawler-go-worker                                                                                  |

### 3.16 Connector Library (ActivePieces — Customer-Selectable)

All 26+ connector packages are opt-in. None is active until the customer configures credentials.

| Connector                           | Version | Connector                           | Version |
| ----------------------------------- | ------- | ----------------------------------- | ------- |
| @activepieces/piece-salesforce      | 0.6.1   | @activepieces/piece-slack           | 0.12.5  |
| @activepieces/piece-zendesk         | 0.2.7   | @activepieces/piece-servicenow      | 0.1.3   |
| @activepieces/piece-jira-cloud      | 0.2.6   | @activepieces/piece-github          | 0.6.6   |
| @activepieces/piece-gmail           | 0.11.4  | @activepieces/piece-google-drive    | 0.6.5   |
| @activepieces/piece-google-sheets   | 0.14.6  | @activepieces/piece-google-calendar | 0.8.4   |
| @activepieces/piece-microsoft-teams | 0.3.12  | @activepieces/piece-notion          | 0.5.4   |
| @activepieces/piece-hubspot         | 0.8.4   | @activepieces/piece-pipedrive       | 0.8.4   |
| @activepieces/piece-asana           | 0.4.4   | @activepieces/piece-linear          | 0.2.3   |
| @activepieces/piece-discord         | 0.4.4   | @activepieces/piece-clickup         | 0.7.4   |
| @activepieces/piece-airtable        | 0.6.5   | @activepieces/piece-amazon-s3       | 0.5.4   |
| @activepieces/piece-postgres        | 0.2.3   | @activepieces/piece-stripe          | 0.6.5   |
| @activepieces/piece-twilio          | 0.4.5   | @activepieces/piece-sendgrid        | 0.4.4   |
| @activepieces/piece-openai          | 0.7.5   | @activepieces/piece-shopify         | 0.2.4   |

### 3.17 Go Service Dependencies (Crawler)

| Component           | Version | Notes                     |
| ------------------- | ------- | ------------------------- |
| gocolly/colly       | 2.1.0   | Web crawling framework    |
| google/uuid         | 1.6.0   | UUID generation           |
| redis/go-redis      | 9.5.1   | Redis client              |
| PuerkitoBio/goquery | 1.8.1   | HTML/CSS document parsing |

### 3.18 Security Override Pins (pnpm resolutions)

The following packages are globally overridden across the monorepo for security:

| Package            | Minimum Version | Reason            |
| ------------------ | --------------- | ----------------- |
| axios              | ≥1.15.0         | CVE remediation   |
| tar                | ≥7.5.11         | CVE remediation   |
| fast-xml-parser    | ≥5.5.6          | CVE remediation   |
| minimatch          | ≥10.2.1         | CVE remediation   |
| multer             | ≥2.0.2          | CVE remediation   |
| nodemailer         | ≥7.0.11         | CVE remediation   |
| katex              | ≥0.16.10        | CVE remediation   |
| socket.io-parser   | ≥4.2.6          | CVE remediation   |
| lodash / lodash-es | ≥4.18.1         | CVE remediation   |
| undici             | 7.24.7          | Compatibility pin |
| ioredis            | 5.9.3           | Compatibility pin |

---

## 4. High-Level Architecture

### 4.1 Azure Private Cloud — Full Network Diagram

```
╔══════════════════════════════════════════════════════════════════════════════════════╗
║  CUSTOMER AZURE SUBSCRIPTION  (per customer group)                           ║
║                                                                                      ║
║  ┌────────────────────────────────────────────────────────────────────────────────┐  ║
║  │  Azure Virtual Network (Customer VNet — e.g. 10.0.0.0/16)                    │  ║
║  │                                                                                │  ║
║  │  ┌─────────────────────────────────────────────────────────────────────────┐  │  ║
║  │  │  AppGW Subnet (e.g. 10.0.0.0/24)                                       │  │  ║
║  │  │                                                                          │  │  ║
║  │  │  ┌──────────────────────────────────────────────────────────────────┐   │  │  ║
║  │  │  │  Azure Application Gateway WAF_v2                                │   │  │  ║
║  │  │  │  ├── OWASP 3.2 Managed Ruleset (Prevention mode)                │   │  │  ║
║  │  │  │  ├── Microsoft BotManagerRuleSet 1.0                             │   │  │  ║
║  │  │  │  ├── TLS 1.2+ (AppGwSslPolicy20220101S)                          │   │  │  ║
║  │  │  │  ├── TLS cert from Azure Key Vault (Managed Identity)            │   │  │  ║
║  │  │  │  ├── Custom rule: /admin only from RFC 1918                       │   │  │  ║
║  │  │  │  └── Autoscaled: 2–10 instances across 3 AZs                     │   │  │  ║
║  │  │  └────────────────────────┬─────────────────────────────────────────┘   │  │  ║
║  │  └───────────────────────────┼─────────────────────────────────────────────┘  │  ║
║  │                              │ (VNet-internal LB)                             │  ║
║  │  ┌───────────────────────────▼─────────────────────────────────────────────┐  │  ║
║  │  │  AKS Subnet (e.g. 10.0.1.0/22)   — Azure CNI Overlay + Cilium         │  │  ║
║  │  │                                                                          │  │  ║
║  │  │  ┌──────────────────────────────────────────────────────────────────┐   │  │  ║
║  │  │  │  System Node Pool (Standard_D4s_v5 × 2, fixed, AZ-spread)        │   │  │  ║
║  │  │  │  ├── ArgoCD (GitOps controller)                                   │   │  │  ║
║  │  │  │  ├── External Secrets Operator (Azure Workload Identity)          │   │  │  ║
║  │  │  │  ├── Coroot eBPF DaemonSet + in-cluster ClickHouse (observ.)     │   │  │  ║
║  │  │  │  └── OpenTelemetry Collector DaemonSet                            │   │  │  ║
║  │  │  └──────────────────────────────────────────────────────────────────┘   │  │  ║
║  │  │                                                                          │  │  ║
║  │  │  ┌──────────────────────────────────────────────────────────────────┐   │  │  ║
║  │  │  │  NGINX Ingress Controller (internal LB annotation)               │   │  │  ║
║  │  │  └─────────┬──────────────┬──────────────┬────────────────┬─────────┘   │  │  ║
║  │  │            │              │              │                │             │  │  ║
║  │  │  ┌─────────▼──┐ ┌────────▼──┐ ┌─────────▼───┐ ┌─────────▼────────┐   │  │  ║
║  │  │  │ Studio     │ │ Runtime   │ │ SearchAI /  │ │ Admin            │   │  │  ║
║  │  │  │ (Next.js   │ │ (Express  │ │ SearchAI-Rt │ │ (Next.js         │   │  │  ║
║  │  │  │ :5173)     │ │ :3112)    │ │ :3005/:3004 │ │ :3003)           │   │  │  ║
║  │  │  └─────────┬──┘ └────────┬──┘ └─────────┬───┘ └─────────┬────────┘   │  │  ║
║  │  │  User Node Pool (Standard_D4s_v5, autoscale 3–10, AZ-spread)          │  │  ║
║  │  │  ──────────────────────────────────────────────────────────────────── │  │  ║
║  │  │            │              │              │                │             │  │  ║
║  │  │  ┌─────────▼──────────────▼──────────────▼────────────────▼─────────┐ │  │  ║
║  │  │  │  Cilium NetworkPolicies — east-west traffic restricted to         │ │  │  ║
║  │  │  │  explicit peer pairs; egress to RFC 1918 blocked                  │ │  │  ║
║  │  │  └──────────────────────────────────────────────────────────────────-┘ │  │  ║
║  │  │            │              │              │                │             │  │  ║
║  │  │  ┌─────────▼──┐ ┌────────▼──┐ ┌─────────▼───┐ ┌─────────▼────────┐   │  │  ║
║  │  │  │ Workflow   │ │ Python    │ │ Codetool    │ │ Academy /        │   │  │  ║
║  │  │  │ Engine     │ │ Services  │ │ Sandbox     │ │ Multimodal       │   │  │  ║
║  │  │  │ (Restate   │ │ (Docling  │ │ (gVisor     │ │ Service          │   │  │  ║
║  │  │  │ :9080)     │ │ BGE-M3    │ │ runsc)      │ │ :3116 / internal)│   │  │  ║
║  │  │  │            │ │ Preproc   │ │ UID 1024    │ │                  │   │  │  ║
║  │  │  │            │ │ NLU)      │ │ inside      │ │                  │   │  │  ║
║  │  │  └─────────┬──┘ └────────┬──┘ └─────────────┘ └──────────────────┘   │  │  ║
║  │  │            │              │                                             │  │  ║
║  │  │  ┌──────────────────────────────────────────────────────────────────┐  │  │  ║
║  │  │  │  Database Node Pool (Standard_E4s_v5, autoscale 3–6, AZ-spread) │  │  │  ║
║  │  │  │  taint: workload=database:NoSchedule                             │  │  │  ║
║  │  │  │  ┌──────────┐ ┌────────────┐ ┌──────────┐ ┌──────────────────┐ │  │  │  ║
║  │  │  │  │ MongoDB  │ │ ClickHouse │ │  Redis   │ │ OpenSearch       │ │  │  │  ║
║  │  │  │  │ v7       │ │ v24.3      │ │  v7      │ │  v3.3            │ │  │  │  ║
║  │  │  │  │ 3-replica│ │ 2shard×3  │ │  primary │ │  + Qdrant        │ │  │  │  ║
║  │  │  │  │ set      │ │ +3 Keeper │ │  +replica│ │    latest        │ │  │  │  ║
║  │  │  │  └──────────┘ └────────────┘ └──────────┘ └──────────────────┘ │  │  │  ║
║  │  │  │  ┌──────────┐ ┌────────────┐ ┌──────────┐                       │  │  │  ║
║  │  │  │  │  Neo4j   │ │   Kafka    │ │ Restate  │                       │  │  │  ║
║  │  │  │  │  v5      │ │   v4.2.0   │ │  v1.6.2  │                       │  │  │  ║
║  │  │  │  └──────────┘ └────────────┘ └──────────┘                       │  │  │  ║
║  │  │  └──────────────────────────────────────────────────────────────────┘  │  │  ║
║  │  │                                                                          │  │  ║
║  │  │  (Optional GPU Node Pool: Standard_NC4as_T4_v3, autoscale 0–2)          │  │  ║
║  │  │  └── Docling OCR + BGE-M3 embedding acceleration                        │  │  ║
║  │  └──────────────────────────────────────────────────────────────────────────┘  │  ║
║  │                                                                                │  ║
║  │  ┌─────────────────────────────────────────────────────────────────────────┐  │  ║
║  │  │  Private Endpoints Subnet (e.g. 10.0.5.0/27)                           │  │  ║
║  │  │  ┌────────────────────┐  ┌────────────────────┐  ┌───────────────────┐ │  │  ║
║  │  │  │ ACR Private EP     │  │ Azure Files PE     │  │ Key Vault PE      │ │  │  ║
║  │  │  │ privatelink.       │  │ privatelink.file   │  │ privatelink.vault │ │  │  ║
║  │  │  │ azurecr.io         │  │ .core.windows.net  │  │ core.azure.net    │ │  │  ║
║  │  │  └────────────────────┘  └────────────────────┘  └───────────────────┘ │  │  ║
║  │  └─────────────────────────────────────────────────────────────────────────┘  │  ║
║  └────────────────────────────────────────────────────────────────────────────────┘  ║
║                                                                                      ║
║  ┌────────────────────────────────────────────────────────────────────────────────┐  ║
║  │  Azure Platform Services (customer-owned, VNet-integrated via private DNS)    │  ║
║  │  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────────────┐ │  ║
║  │  │ Azure Key Vault  │  │ Azure Container  │  │ Azure Blob Storage (GRS)     │ │  ║
║  │  │ (or Managed HSM  │  │ Registry Premium │  │ Backups: MongoDB 30d,        │ │  ║
║  │  │ FIPS 140-3 L3)   │  │ + geo-replication│  │ ClickHouse 14d, Qdrant 14d  │ │  ║
║  │  │ Workload Identity│  │ AcrPull MI only  │  │ lifecycle.prevent_destroy=T │ │  ║
║  │  │ RBAC auth (ro)   │  │ admin_enabled=F  │  │                              │ │  ║
║  │  └──────────────────┘  └──────────────────┘  └──────────────────────────────┘ │  ║
║  └────────────────────────────────────────────────────────────────────────────────┘  ║
╚══════════════════════════════════════════════════════════════════════════════════════╝

EXTERNAL (customer-configured; Cilium egress policy required per endpoint)
  ┌────────────────┐  ┌──────────────────┐  ┌─────────────────────────────────────┐
  │  LLM Providers │  │ Voice Providers  │  │  Customer SIEM / Observability      │
  │  (if enabled): │  │  (if enabled):   │  │  (if OTEL forward configured):      │
  │  Azure OpenAI  │  │  LiveKit Cloud   │  │  Splunk, Elastic, Sentinel,         │
  │  OpenAI API    │  │  Deepgram        │  │  Datadog, etc.                      │
  │  Anthropic     │  │  ElevenLabs      │  │  (OTLP endpoint, customer-operated) │
  │  Google Vertex │  │  Twilio          │  └─────────────────────────────────────┘
  └────────────────┘  └──────────────────┘
  Recommended for finance: Azure OpenAI inside customer subscription (no data boundary crossing)
```

### 4.2 Six-Group Isolation Diagram

```
Customer Azure Subscription
│
├── AKS Cluster (shared or dedicated per group — dedicated recommended)
│   │
│   ├── Namespace: group-1-dev / group-1-staging / group-1-prod
│   │   ├── Agent Platform V2 services (full stack)
│   │   ├── MongoDB instance (group-1)
│   │   ├── ClickHouse instance (group-1)
│   │   ├── Redis instance (group-1)
│   │   ├── OpenSearch instance (group-1)
│   │   └── ArgoCD Application (group-1)
│   │
│   ├── Namespace: group-2-dev / group-2-staging / group-2-prod
│   │   └── (same stack, fully isolated data layer)
│   │
│   ├── ... (groups 3–5)
│   │
│   └── Namespace: group-6-dev / group-6-staging / group-6-prod
│       └── (same stack, fully isolated data layer)
│
├── Azure Key Vault — group-1   (own DEK hierarchy, own Workload Identity binding)
├── Azure Key Vault — group-2
│   ...
└── Azure Key Vault — group-6

Cross-group data access: NOT POSSIBLE — separate DB instances, separate keys
Cross-group network access: BLOCKED — Cilium NetworkPolicies prevent cross-namespace traffic
```

### 4.3 Secrets Flow Diagram

```
Azure Key Vault (per group, RBAC: Key Vault Secrets User — read-only)
  │
  │  External Secrets Operator (pod identity via Azure Workload Identity — OIDC federation)
  │  No static credentials. Sync interval: 1 hour.
  ▼
ClusterSecretStore (ESO CRD)
  │
  ▼
ExternalSecret (6 per group: platform, runtime, studio, search-ai, infra, TLS)
  │
  ▼
Kubernetes Secret (envFrom in pod spec)
  │
  │  Stakater Reloader watches Secret changes → rolling pod restart
  ▼
Pod environment variables (never written to disk, in-memory only)
  │
  ▼
EncryptionService (in-process) — derives DEK from master key via HKDF-SHA256
  │
  ▼
AES-256-GCM encryption of sensitive fields (MongoDB, ClickHouse, Redis payloads)
```

### 4.4 Image Promotion Pipeline

```
Developer PR (Bitbucket)
  │  Prettier + TypeScript + Semgrep + lint hooks (blocking)
  │  PR review required
  ▼
CI Build → Docker image (multi-stage, distroless, SHA-pinned)
  │  Image pushed to Customer ACR (Premium, private endpoint)
  │  Image tag: git SHA
  ▼
dev environment (auto-sync from ArgoCD, values-dev.yaml)
  │  Integration tests pass
  │  PR: touch only values-dev.yaml (CI bot cannot touch prod)
  ▼
staging environment (manual PR, 1 approver, values-staging.yaml)
  │  QA sign-off
  │  PR: touch only values-staging.yaml
  ▼
production (manual PR, 2 approvers, values-prod-*.yaml per region/group)
  │  Executor cannot self-approve
  │  ArgoCD sync is the ONLY path to production
  ▼
ArgoCD self-heal + prune (Server-Side Apply)
```

### 4.5 Application Service Inventory

| Service                 | Language / Runtime                       | Port     | Purpose                                                    |
| ----------------------- | ---------------------------------------- | -------- | ---------------------------------------------------------- |
| `runtime`               | Node.js 24 / Express 4.x                 | 3112     | Agent execution, streaming chat, voice, tool orchestration |
| `studio`                | Next.js 16 / React 19                    | 5173     | Visual agent IDE                                           |
| `admin`                 | Next.js 16 / React 19                    | 3003     | Tenant/project admin, secrets, audit                       |
| `search-ai`             | Node.js 24 / Express 4.x                 | 3005     | Ingestion, extraction, enrichment, canonical mapping       |
| `search-ai-runtime`     | Node.js 24 / Express 4.x                 | 3004     | Query-time retrieval and vocabulary resolution             |
| `workflow-engine`       | Node.js 22 / Restate 1.6.2               | 9080     | Durable workflow execution with exactly-once semantics     |
| `academy`               | Node.js 22 / Express                     | 3116     | Learning academy (progress, gamification)                  |
| `multimodal-service`    | Node.js 24 / Express                     | internal | File upload, storage, ClamAV scanning, processing          |
| `docling-service`       | Python 3.11 / FastAPI 0.109+             | 8080     | Document conversion / OCR / extraction (Docling 1.5+)      |
| `bge-m3-service`        | Python 3.11 / Flask 3.0                  | 8000     | BGE-M3 embedding model (local, no external API)            |
| `preprocessing-service` | Python 3.11 / Flask 3.0 / Gunicorn 22    | 8003     | Query preprocessing                                        |
| `nlu-sidecar`           | Python 3.11 / Flask 3.0 / Gunicorn 22    | 8090     | Entity extraction, correction detection                    |
| `codetool-sandbox`      | Ubuntu 22.04 + gVisor 20250811           | 8001     | Sandboxed code execution (user-authored tools)             |
| `crawler-mcp-server`    | Node.js 24 / Express 5 / Playwright 1.48 | internal | MCP browser automation primitives                          |
| `crawler-go-worker`     | Go 1.24 / Colly 2.1.0                    | internal | BullMQ-backed crawl worker                                 |
| `pipeline-engine`       | Node.js 24 / Restate 1.4                 | internal | Pluggable AI pipeline execution                            |

---

## 5. Tenancy and Isolation

Tenancy is enforced at four layers; a failure in any one layer is caught by at least one other.

### 5.1 Application layer — AsyncLocalStorage tenant context

Every authenticated request enters a Node.js `AsyncLocalStorage` scope that carries `tenantId`, `userId`, `projectId`, and role/scope metadata. This propagates automatically through every `await` and every downstream call in the request's async tree.

### 5.2 Data layer — Mongoose plugin auto-scoping

A repo-wide Mongoose plugin (`tenantIsolationPlugin`) reads the ALS context and injects `tenantId` into every query, update, and aggregation pipeline. The plugin supports:

- **External provider registration** — the shared-auth package registers the ALS store; workers that are not request-scoped register their own store.
- **SuperAdmin bypass** — only explicit platform-admin routes, protected by IP allowlist and RBAC, can read across tenants.
- **Local ALS fallback** for background workers and Restate handlers.

Queries that attempt to read a document belonging to another tenant return `null` at the ODM layer. HTTP routes translate that into **HTTP 404, not 403**, to prevent tenant enumeration.

### 5.3 Route layer — project and environment guards

- `requireProjectPermission(req, res, 'object:operation')` verifies that the authenticated principal has the stated permission **within the project parameter** in the URL.
- `requireProjectScope(paramName)` enforces API-key-attached project restrictions.
- `requireEnvironmentScope(paramName)` does the same for environment (dev/staging/prod).

### 5.4 Infrastructure layer — per-group isolation

For this engagement each of the six customer groups is deployed as a separate stack with:

- Its own Kubernetes namespace (or namespace set if multiple environments).
- Its own MongoDB 7, ClickHouse 24.3, Redis 7, OpenSearch 3.3, Qdrant, Neo4j 5 instances.
- Its own Azure Key Vault and its own DEK hierarchy.
- Its own ArgoCD Application.
- Its own Cilium NetworkPolicies preventing cross-namespace traffic.

Cross-group reads are not possible by design because the data is in different stores under different keys.

---

## 6. Authentication and Authorization

### 6.1 Unified authentication middleware

All traffic to the runtime, search-ai, and admin APIs flows through a single middleware that dispatches to one of three verified identity flows:

| Flow        | Header / transport                                                     | Principal type            | Token format                                                                                             |
| ----------- | ---------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------- |
| User JWT    | `Authorization: Bearer <jwt>`                                          | Human user                | HS/RS256 JWT (jsonwebtoken 9.0.2) with `sub`, `email`, `tenantId`, `role`, short TTL, refresh-token pair |
| SDK session | `X-SDK-Token: <token>` (or `Sec-WebSocket-Protocol: sdk-auth,<token>`) | End-user via embedded SDK | Signed session token with identity tiers (anonymous, lightly-identified, fully-identified)               |
| API key     | `Authorization: Bearer abl_<...>`                                      | Machine principal         | SHA-256-hashed key with explicit scopes, project binding, environment binding                            |

Custom token verification outside the shared-auth package is prohibited by a pre-commit lint hook (`custom-auth-lint`). API keys are authorized by explicit scopes only — never by creator membership.

### 6.2 Enterprise identity integration

The `auth-enterprise` package implements:

- **SAML 2.0** (`@node-saml/node-saml` 5.1.0) — SP-initiated and IdP-initiated flows, signed/encrypted assertions.
- **Kerberos / SPNEGO** — for Windows integrated auth scenarios.
- **WS-Security** — for legacy SOAP integrations.
- **Hawk** and **Digest** — for legacy tooling that does not speak OIDC.

The `idp-token-validator` module validates tokens issued directly by an external IdP. Built-in provider patterns:

- **Azure AD** (pattern-matched issuer + JWKS endpoint, group-claim extraction).
- **Okta** (issuer/audience-validated).
- **Google Workspace**.
- **Any OIDC-compliant provider** via generic configuration (issuer, audience, JWKS URI, allowed domains).

JWKS keys are cached in Redis 7 with a 1-hour TTL (jwks-rsa 3.1.0). Signature verification uses RS256 or ES256 (jose 5.10.0).

### 6.3 Authorization model

RBAC is evaluated against a central permission registry. Permissions are `object:operation` strings (e.g., `agent:write`, `credential:read`). Roles are hierarchical:

- **Tenant roles:** OWNER, ADMIN, MEMBER, VIEWER.
- **Project roles:** Owner, Developer, Viewer.
- **Custom roles:** Tenant admins can compose custom roles from the registry; an allowlist (`VALID_CUSTOM_ROLE_PERMISSIONS`) prevents privilege escalation.

Per-route guards: `requirePermission`, `requireAllPermissions`, `requireAnyPermission`, `requireAuthType(...)`, `requirePlatformAdmin`, `requirePlatformAdminIp`.

### 6.4 MFA posture

The JWT payload carries an `mfa_pending` flag and the middleware understands MFA-gated sessions. TOTP secrets are encrypted at the user level (not tenant level) using otplib 13.3.0. **Production SMS/TOTP delivery is partially wired — see Section 17.**

---

## 7. Encryption

### 7.1 Algorithmic baseline

| Parameter                                                           | Value                                         |
| ------------------------------------------------------------------- | --------------------------------------------- |
| Symmetric cipher                                                    | AES-256-GCM                                   |
| Key length                                                          | 256 bits                                      |
| IV length                                                           | 96 bits (NIST SP 800-38D)                     |
| Auth tag length                                                     | 128 bits                                      |
| Key derivation (modern)                                             | HKDF-SHA256                                   |
| Key derivation (legacy — still readable for backward compatibility) | PBKDF2-SHA256, 100,000 iterations             |
| Compression (payloads ≥ 64 B)                                       | Zstandard level 3                             |
| Hashing                                                             | SHA-256 (API keys), HMAC-SHA256 (blind index) |

### 7.2 Key hierarchy (NIST SP 800-57 aligned)

```
  Platform Root Key (PRK)   — held in Azure Key Vault / Managed HSM; never exported
          │
          ▼
  Tenant KEK (TKEK)         — wraps DEKs; rotated on schedule
          │
          ▼
  Data Encryption Key (DEK) — encrypts actual data; scoped per tenant + project + environment
```

- Key states: `pre-active`, `active`, `decrypt-only`, `deactivated`, `compromised`, `destroyed`.
- Protection levels: `hsm` (FIPS 140-3 Level 3), `software-protected`, `platform-shared`, `local`, `ephemeral`.
- DEK rotation: when rotated, the old DEK is marked `decrypt_only` for existing ciphertexts; all new writes use the new DEK. DEK IDs are embedded in ciphertext headers.
- **AAD binding:** the tenant ID is bound into the GCM auth tag as Additional Authenticated Data. Swapping ciphertext between tenants causes authentication failure.

### 7.3 KMS providers (customer choice)

| Provider          | Backing                               | Notes                                         |
| ----------------- | ------------------------------------- | --------------------------------------------- |
| Azure Key Vault   | Software-protected keys               | Default for Azure-native deployments          |
| Azure Managed HSM | FIPS 140-3 Level 3                    | **Recommended for regulated finance posture** |
| AWS KMS           | Software-protected or CloudHSM-backed | Supported via SDK                             |
| GCP Cloud KMS     | Software-protected or HSM-backed      | Supported via SDK                             |
| External KMS      | Generic HTTP-based KMS                | For customers with on-prem HSM-backed KMS     |
| Local KMS         | Dev/test only                         | Not used in customer deployments              |

### 7.4 Encrypted data inventory

Every field encrypted at the application layer is declared in a central registry:

**MongoDB (via Mongoose encryption plugin):**

- LLM provider credentials (`encryptedApiKey`, `encryptedEndpoint`)
- Tool secret values
- Auth profile secrets (connector credentials, OAuth client secrets)

**MongoDB (direct encryption):**

- OAuth access tokens and refresh tokens
- Channel connection credentials (Twilio, WhatsApp, SMTP, etc.)
- SSO configuration payloads
- Git credential secrets
- Agent-transfer session metadata
- Webhook subscription secrets
- Workflow engine secrets
- PIIVault serialization
- MFA TOTP secrets (user-scoped, otplib 13.3.0)

**ClickHouse (field-level interceptor in `@clickhouse/client` 1.17.0):**

- `messages.content` (conversation content)
- `traces.data` (span payloads)
- `platform_events.data`
- `audit_events.metadata`, `audit_events.old_value`, `audit_events.new_value`
- `insight_results.dimensions`

**Redis (secure-queue wrapper, ioredis 5.9.3):**

- BullMQ `llm-requests.message` payloads
- BullMQ `message-persistence.content` payloads

**Contact PII (GDPR crypto-shredding — per-contact HKDF-derived keys):**

- Email, phone, name, custom identifiers

A `isAlreadyEncrypted()` check prevents double-encryption accidents, and `EncryptionService.shutdown()` zero-fills master key material on graceful pod termination.

### 7.5 Transport security

- **North-south:** Azure Application Gateway terminates TLS. `AppGwSslPolicy20220101S` (TLS 1.2+ with TLS 1.3 support). Certificates from Azure Key Vault via Managed Identity — rotation is a Key Vault operation, not a pod restart.
- **East-west:** Kubernetes Service mesh is **not** deployed. Inter-service traffic is plain HTTP inside the cluster, gated by Cilium NetworkPolicies. This is the single most notable "below best practice" gap for finance — see Section 17.
- **Data stores:** MongoDB 7, Redis 7, and ClickHouse 24.3 all accept TLS but TLS is not enabled by default in the base Helm values. For the customer's deployment, `mongodb.tls.enabled: true`, `redis.tls.enabled: true`, and ClickHouse HTTPS must be explicitly turned on in the per-customer values overlay — deployment runbook covers this.
- **Egress:** Cilium egress policies allow external HTTPS only, and exclude RFC 1918 destinations.
- **SSRF protection:** The shared IP-validator module blocks requests to private IP ranges, cloud metadata endpoints (169.254.169.254, metadata.google.internal), and unsafe protocols. IPv6-aware. 27 regression tests.

### 7.6 Secrets in Kubernetes

```
Azure Key Vault (per group, RBAC: Key Vault Secrets User — read-only)
  │
  │  External Secrets Operator via Azure Workload Identity (OIDC federation, no static creds)
  ▼
ClusterSecretStore
  │
  ▼
ExternalSecret (sync interval: 1 hour, configurable)
  │
  ▼
Kubernetes Secret (envFrom in pod spec; Stakater Reloader restarts pods on change)
```

Six `ExternalSecret` resources cover: shared platform secrets (JWT, encryption master key, NextAuth, SMTP, Google OAuth), runtime keys (LiveKit, Jambonz, Twilio), Studio keys, Search-AI keys, infrastructure config, TLS cert/key.

---

## 8. Network Security

### 8.1 North-south flow

```
Internet
  │
  ▼
Azure Application Gateway WAF_v2
  ├─ OWASP 3.2 managed ruleset (Prevention mode in production)
  ├─ Microsoft BotManagerRuleSet 1.0
  ├─ TLS 1.2+ (AppGwSslPolicy20220101S, TLS 1.3 supported)
  ├─ Custom rule: only RFC 1918 source IPs can reach /admin path prefix
  ├─ TLS certificates from Azure Key Vault via Managed Identity
  └─ Autoscaled: 2–10 instances across 3 availability zones in prod
  │
  ▼  (WAF → internal LB inside VNet)
NGINX Ingress Controller (in-cluster, annotated internal LB)
  │
  ▼
Application pods (runtime, studio, admin, search-ai, search-ai-runtime)
```

### 8.2 East-west isolation (Cilium NetworkPolicies)

| Service                                                     | Ingress allowed from                                         | Egress allowed to                                                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| runtime                                                     | studio, admin, NGINX ingress, codetool-sandbox (return path) | MongoDB :27017, ClickHouse :8123/:9000, Redis :6379, OTEL :4317/:4318, LLM APIs (443 to public internet, RFC 1918 blocked) |
| studio                                                      | NGINX ingress                                                | runtime, admin, MongoDB, ClickHouse, Redis, OTEL                                                                           |
| admin                                                       | NGINX ingress                                                | runtime, MongoDB, ClickHouse, Redis, OTEL                                                                                  |
| search-ai / search-ai-runtime                               | NGINX ingress, runtime                                       | MongoDB, ClickHouse, OpenSearch, Qdrant, embedding services, LLM APIs                                                      |
| docling, bge-m3, preprocessing                              | search-ai, search-ai-runtime                                 | DNS and their own storage only                                                                                             |
| codetool-sandbox                                            | runtime, studio                                              | DNS + runtime memory-API sidecar :3113 **only** (external egress off by default)                                           |
| ClickHouse, MongoDB, OpenSearch, Redis (database namespace) | abl-platform namespace only                                  | Nothing outbound                                                                                                           |

Services not yet covered by a dedicated NetworkPolicy template: workflow-engine, multimodal, nlu-sidecar, crawler-go-worker, crawler-mcp-server, Neo4j, LiveKit. Adding policies for these is tracked in Section 17.

### 8.3 Private endpoints

| Service                                                 | Private DNS zone                                                                  |
| ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Azure Container Registry (Premium)                      | `privatelink.azurecr.io`                                                          |
| Azure Files (SMB/NFS, used by search-ai and multimodal) | `privatelink.file.core.windows.net`                                               |
| Azure Key Vault                                         | `privatelink.vaultcore.azure.net` (pending in-cluster Harness delegate migration) |

### 8.4 Egress posture

External egress is limited to:

1. **LLM provider APIs** the customer enables (OpenAI, Anthropic, Google Vertex/Gemini, Azure OpenAI, Cohere, and OpenAI-compatible endpoints).
2. **Voice/telephony providers** only if voice is enabled (LiveKit Cloud, Deepgram, ElevenLabs, Twilio).
3. **Connector targets** configured by the customer (e.g., Salesforce, Zendesk, Jira).
4. **Container image pulls** from customer-operated ACR (no public registry access required in production).

All four are customer-configurable and individually policed by Cilium egress rules.

---

## 9. Code Execution Sandbox

The `codetool-sandbox` service runs user-authored code snippets (Python 3.12 / JavaScript/Node.js 22) in a strongly isolated environment.

| Control                | Configuration                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Isolation technology   | gVisor (`runsc`) release 20250811 — user-space kernel, syscall interception                                                                                                                                   |
| Base image             | `ubuntu:22.04` LTS                                                                                                                                                                                            |
| Seccomp profile        | Custom 145-rule seccomp profile restricting syscalls                                                                                                                                                          |
| Container capabilities | `SYS_ADMIN`, `SYS_PTRACE` (required for gVisor) — all other Linux capabilities dropped                                                                                                                        |
| Pod security context   | `privileged: true`, `runAsUser: 0` at container boot **only to initialize gVisor**; user code runs as UID 1024 inside the gVisor sandbox                                                                      |
| NetworkPolicy          | Ingress: only runtime and studio. Egress: DNS + runtime memory sidecar on :3113. External HTTPS egress is default-denied; customer can enable via `codetoolSandbox.allowExternalEgress: true` per environment |
| Filesystem             | emptyDir scratch space per pod, read-only root filesystem outside `/tmp`                                                                                                                                      |
| CPU/memory             | Enforced pod-level resource limits                                                                                                                                                                            |
| Execution timeout      | Per-invocation timeout enforced by the runtime                                                                                                                                                                |
| User code languages    | Python 3.12, Node.js 22.22.0                                                                                                                                                                                  |

The "privileged" flag on this pod is the cost of using gVisor. Compensating controls: extremely restrictive NetworkPolicy; container internally drops to unprivileged UID 1024; feature is disablable cluster-wide via Helm value. **Recommended: evaluate whether this feature is needed and disable it if not.**

---

## 10. Data Handling and PII

### 10.1 Data classification

| Class                | Examples                                           | Storage                                       | Protection                                          |
| -------------------- | -------------------------------------------------- | --------------------------------------------- | --------------------------------------------------- |
| Customer content     | Conversation messages, document text, agent traces | MongoDB 7, ClickHouse 24.3                    | App-layer AES-256-GCM + disk SSE                    |
| Customer credentials | LLM API keys, OAuth tokens, connector secrets      | MongoDB 7                                     | App-layer AES-256-GCM, envelope with per-tenant DEK |
| User identity        | Email, phone (contact entities)                    | MongoDB 7                                     | Per-contact HKDF-derived key (crypto-shreddable)    |
| Platform telemetry   | Latency, error codes, request counts               | ClickHouse 24.3, Coroot                       | No PII — aggregated metrics only                    |
| Audit events         | Who did what, when, from where                     | MongoDB 7 (general) + dedicated PII audit log | App-layer AES-256-GCM on metadata fields            |

### 10.2 PII detection and redaction

- **Detection:** Regex-based detection with per-tenant custom pattern support. Built-in patterns: email, phone, SSN, credit card, passport, and regional identifiers.
- **Redaction strategies:** `predefined` (fixed mask), `masked` (configurable show-first/show-last/mask-char), `random` (deterministic token).
- **Per-consumer access rules:** LLM consumer sees tokenized form; user consumer sees masked form; logs consumer sees hash; privileged tool consumer sees plaintext.
- **PII vault:** encrypted at field level; tokens map to encrypted PII in the vault. Detokenization is gated by consumer rules.
- **PII audit log:** every tokenize, detokenize, render, and clear is logged. Retention default: 90 days (MongoDB TTL index, configurable).

### 10.3 Right to erasure (GDPR Article 17)

- **Crypto-shredding of contact PII:** each contact has a derived key; deleting the key renders all that contact's data cryptographically irrecoverable across all stores.
- **Cascading deletion:** deletion requests cascade to MongoDB 7, ClickHouse 24.3, Redis 7, and Qdrant.
- **ClickHouse TTL:** per-table TTL with declarative tiered storage (NVMe hot → object storage cold → deletion).

### 10.4 Retention

| Data                    | Default retention                       | Enforcement                            |
| ----------------------- | --------------------------------------- | -------------------------------------- |
| PII audit log           | 90 days                                 | MongoDB TTL index                      |
| General audit log       | Configurable, default 1 year            | MongoDB TTL index                      |
| ClickHouse event tables | Per-table TTL policy                    | ClickHouse partition drops             |
| Kafka topics            | 7 days                                  | `retention.ms=604800000` (Kafka 4.2.0) |
| Redis session cache     | Per-key TTL, max 24 hours               | Redis expiry                           |
| BullMQ completed jobs   | 1,000 jobs or 24 hours, whichever first | BullMQ settings                        |
| Session transcripts     | Configurable by tenant                  | Application-level retention job        |

All retention windows are tenant-configurable in the admin UI.

---

## 11. Logging, Audit, and Traceability

### 11.1 Structured logging

All server-side code uses the platform logger (pino 9.6.0). Direct `console.log`/`console.error` is prohibited by a pre-commit lint hook.

- **JSON output** in production, human-readable in dev.
- **Field-name and pattern-based redaction** of sensitive values at the logger level.
- **Correlation ID propagation** via AsyncLocalStorage; every log line carries the request's correlation ID.
- **Log sink:** stdout → OpenTelemetry collector DaemonSet (filelog receiver) → OTLP exporter → Coroot (in-cluster) or any customer-configured OTLP backend (e.g., Splunk / Datadog / Elastic).

### 11.2 Audit trail

| Model         | Purpose                                                    | Retention                     | Fields                                                       |
| ------------- | ---------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------ |
| `AuditLog`    | General administrative + write-path audit                  | Configurable (default 1 year) | userId, tenantId, action, ip, userAgent, metadata, timestamp |
| `PiiAuditLog` | PII access events (tokenize / detokenize / render / clear) | 90 days                       | session, consumer, action, render mode, timestamp            |

An **audit-trail Mongoose plugin** automatically records create/update/delete/softDelete/restore operations on sensitive collections. Actor context (userId, email, IP, User-Agent) is picked up from AsyncLocalStorage.

### 11.3 Distributed tracing

- **W3C Trace Context** (`traceparent`/`tracestate`) end-to-end.
- **33+ typed event categories** (agent, session, channel, tool, engine, flow, delegation, A2A, voice, extraction, guardrail, memory, suspension, fan-out, error-handler, DSL, span, and more).
- **OpenTelemetry** instrumentation (OTel SDK 0.57.0, OTel API 1.9.0). Kafka producers/consumers (KafkaJS 2.2.4) are OTel-instrumented.
- **Export:** OTLP → collector → Coroot or customer backend.

### 11.4 Observability stack

Coroot Community Edition (eBPF node-agent DaemonSet, Linux kernel ≥ 5.8, native on Azure CNI Overlay):

- Service maps, latency histograms, SLO/SLI dashboards, anomaly detection.
- Bundled ClickHouse (isolated from the application ClickHouse) for trace/metric/log/profiling storage.
- Customers can point the OTEL collector at their own SIEM endpoint instead of (or in addition to) Coroot.

---

## 12. Third-Party Sub-Processors

**A customer deployment only talks to the subset the customer enables.**

### 12.1 LLM providers (Vercel AI SDK 6.0.99 unified adapter)

| Provider                                                              | API endpoint                                                     | Data that leaves the boundary                     |
| --------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------- |
| **Azure OpenAI**                                                      | Customer's Azure OpenAI deployment (stays inside customer Azure) | Prompt + context to customer's own Azure resource |
| Anthropic                                                             | `api.anthropic.com`                                              | Prompt + context sent to Anthropic                |
| OpenAI                                                                | `api.openai.com`                                                 | Prompt + context sent to OpenAI                   |
| Google Gemini / Vertex AI                                             | Google endpoints / customer Vertex project                       | Prompt + context                                  |
| Cohere, Groq, Mistral, Fireworks, Together, Perplexity, DeepSeek, xAI | Public endpoints                                                 | Prompt + context                                  |
| Self-hosted / LiteLLM proxy                                           | Customer-controlled URL                                          | Stays internal                                    |
| Custom (OpenAI-compatible)                                            | Customer-defined base URL                                        | Stays wherever the URL points                     |

**Recommended:** Use **Azure OpenAI deployments inside the customer's own subscription** or a **self-hosted LiteLLM proxy** so that prompt content never leaves the customer boundary.

### 12.2 Voice / telephony (optional — only if voice feature is enabled)

- **LiveKit** (SDK 1.0.44) — media plane; can be self-hosted on customer's AKS cluster.
- **Deepgram** — speech-to-text (cloud). Plugin version 1.0.44.
- **ElevenLabs** — text-to-speech (cloud). Plugin version 1.0.44.
- **Silero VAD** (plugin 1.0.44) — runs locally, no external call.
- **Twilio** (5.3.0) — SIP / telephony (cloud).

All voice providers are opt-in.

### 12.3 Connectors (customer-selected — see Section 3.16)

60+ connector types. None is active until the customer configures credentials. OAuth flows store tokens encrypted at rest with AES-256-GCM.

### 12.4 Explicitly NOT integrated

Confirmed by codebase grep: **no direct integration** with Sentry, Datadog SaaS, New Relic, Segment, PostHog, or Stripe. Customer deployments do not call any of these unless the customer explicitly configures their own collector to forward telemetry.

---

## 13. Infrastructure and Deployment

### 13.1 Compute (AKS)

| Property                   | Value                                                     |
| -------------------------- | --------------------------------------------------------- |
| SKU tier                   | Standard (production)                                     |
| Kubernetes version         | 1.31 / 1.32 (current AKS supported versions)              |
| CNI                        | Azure CNI Overlay                                         |
| Data plane                 | Cilium                                                    |
| Network policy engine      | Cilium                                                    |
| OIDC issuer                | Enabled (required for Workload Identity)                  |
| Workload Identity          | Enabled (OIDC federation — no static credentials in pods) |
| Key Vault Secrets Provider | Enabled with 2-minute rotation poll                       |
| Upgrade strategy           | Max surge 10% across all node pools                       |

Node pools:

| Pool           | Purpose                     | Prod VM size                       | Scaling        | Taint                          |
| -------------- | --------------------------- | ---------------------------------- | -------------- | ------------------------------ |
| system         | AKS system, ArgoCD, ESO     | Standard_D4s_v5                    | Fixed 2        | `CriticalAddonsOnly`           |
| user           | App workloads               | Standard_D4s_v5                    | Autoscale 3–10 | —                              |
| database       | MongoDB, ClickHouse, Keeper | Standard_E4s_v5 (memory-optimized) | Autoscale 3–6  | `workload=database:NoSchedule` |
| gpu (optional) | Docling OCR, BGE-M3         | Standard_NC4as_T4_v3 (NVIDIA T4)   | Autoscale 0–2  | `workload=gpu:NoSchedule`      |

All production node pools span three availability zones.

### 13.2 Pod hardening (Helm defaults)

| Service                                                                                                         | `runAsNonRoot`                      | `runAsUser` | `readOnlyRootFilesystem`                     | `allowPrivilegeEscalation` | Capabilities dropped                 |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ----------- | -------------------------------------------- | -------------------------- | ------------------------------------ |
| runtime, studio, admin, search-ai, search-ai-runtime, docling, bge-m3, workflow-engine, multimodal, nlu-sidecar | true                                | 1001        | true                                         | false                      | ALL                                  |
| preprocessing                                                                                                   | true                                | 1000        | true                                         | false                      | ALL                                  |
| crawler-go-worker                                                                                               | true                                | 65534       | true                                         | false                      | ALL                                  |
| crawler-mcp-server                                                                                              | true                                | 1001        | false (Playwright/browser needs writable fs) | false                      | ALL                                  |
| codetool-sandbox                                                                                                | false (boot) → UID 1024 (user code) | 0 at boot   | N/A                                          | —                          | All except `SYS_ADMIN`, `SYS_PTRACE` |

Every service defines `resources.requests` and `resources.limits` for CPU and memory.

### 13.3 Container images

- **Application images:** multi-stage builds; production base `gcr.io/distroless/nodejs22-debian12` pinned by SHA digest; non-root user; libssl3 CVE patch overlay where applicable. Healthchecks via HTTP `/health`.
- **Registry:** Customer ACR (Premium) with geo-replication and private endpoint. `admin_enabled: false` on ACR. AKS pulls via `AcrPull` managed identity (no registry password stored anywhere).
- **Image tags:** git SHA as canonical tag. `latest` and `main-YYYYMMDD` as rolling references.

### 13.4 ArgoCD GitOps

| Control                     | Setting                                                                                                                     |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Sync policy                 | Automated, prune, self-heal                                                                                                 |
| Sync options                | `ServerSideApply`, `ServerSideDiff`, `CreateNamespace`, `PrunePropagationPolicy=foreground`                                 |
| Retry                       | Limit 3, exponential backoff 10 s → 3 m                                                                                     |
| RBAC                        | `platform-team` group → admin; `developers` group → read-only                                                               |
| Cluster resources whitelist | PV, Namespace, ClusterRole, ClusterRoleBinding, ClusterSecretStore, CRDs, ValidatingWebhookConfiguration, IngressClass only |

Every change to production values requires a merged pull request; ArgoCD sync is the only way config reaches the cluster.

### 13.5 Infrastructure-as-Code

- **Tool:** OpenTofu ≥ 1.5.0 (Terraform-compatible).
- **Providers:** `hashicorp/azurerm ~> 4.0`, `hashicorp/azuread ~> 2.47`.
- **Approval gates:** Dev auto-apply. QA/Staging: 1 approver. Production: 2 approvers with `disallowPipelineExecutor: true`.
- **Modules:** AppGW, AKS, ACR, Key Vault + generated secrets, IAM (Workload Identity), DNS, KV bridge (TLS cert handoff), Storage, ArgoCD, GitOps agent, Harness delegate, backup/state.

---

## 14. Resilience, Backup, and Disaster Recovery

### 14.1 Backup targets

| Component            | RPO (prod) | RTO    | Method                                  | Retention     | Storage        |
| -------------------- | ---------- | ------ | --------------------------------------- | ------------- | -------------- |
| MongoDB 7            | 1 h        | 1 h    | `mongodump` CronJob (PBM 2.7)           | 30 d          | GRS Azure Blob |
| ClickHouse 24.3      | 24 h       | 4 h    | `clickhouse-backup` CronJob             | 14 d          | GRS Azure Blob |
| Qdrant               | 24 h       | —      | Snapshot API                            | 14 d          | GRS Azure Blob |
| Redis 7              | ~1 h       | 30 min | RDB snapshots + reprovision             | Azure-managed | Azure-managed  |
| Infrastructure state | 0 (IaC)    | 2–4 h  | `tofu state pull` → GRS Blob + re-apply | 90 d          | GRS Azure Blob |
| Container images     | 0          | 30 min | ACR geo-replication                     | —             | ACR            |

Backup storage accounts carry `lifecycle { prevent_destroy = true }` — an accidental `tofu destroy` cannot remove them.

### 14.2 Availability

- Three availability zones per production node pool.
- MongoDB 7: 3-replica set (Percona MongoDB Operator 1.22.0).
- ClickHouse 24.3: 2 shards × 3 replicas + 3-node ClickHouse Keeper (Altinity Operator 0.26.0).
- Redis 7: primary + replica.
- Stateless services: HPA-driven autoscaling, PodDisruptionBudgets, anti-affinity across AZs.

### 14.3 Regional DR

Full-region loss is addressed by a documented runbook (estimated total: 2–4 h for infra + 1–2 h for data restoration). Quarterly restore drill checklists are documented. **DR automation is partial today — see Section 17.**

---

## 15. Change Management and SDLC Controls

### 15.1 Source control

- All three repositories are Bitbucket-hosted and require pull requests with review before merge.
- Every commit carries a Jira ticket reference.

### 15.2 Automated gates on every commit

Pre-commit hooks enforce (blocking):

| Check                                           | Purpose                                                    |
| ----------------------------------------------- | ---------------------------------------------------------- |
| `prettier`                                      | Consistent formatting                                      |
| `tsc --noEmit`                                  | Incremental type-check (TypeScript 5.3–5.7)                |
| `console-log-lint`                              | Block raw `console.log/error/warn/info` in server code     |
| `swallowed-catch-lint`                          | Block empty `.catch(() => {})`                             |
| `sync-io-lint`                                  | Block sync filesystem calls in async paths                 |
| `zod-id-lint`                                   | Block CUID-based ID validators                             |
| `custom-auth-lint`                              | Block direct `jsonwebtoken` use outside shared-auth        |
| `platform-mock-lint`                            | Block mocking of internal packages in tests                |
| `e2e-test-quality-lint`                         | Block direct DB access and mocks in E2E tests              |
| `empty-response-lint`                           | Block `res.json({})` — forces structured error responses   |
| `project-isolation-lint`, `user-isolation-lint` | Warn on queries missing tenant/project/user filter         |
| `exported-symbol-guard`                         | Block removal of exported symbols still imported elsewhere |
| `package-deletion-guard`                        | Block `rm -rf packages/<name>`                             |
| `commit-scope-guard`, `deletion-ratio-guard`    | Enforce commit size discipline                             |

### 15.3 Security review

- Semgrep ruleset runs on PRs touching auth, crypto, HTTP handlers, and user input paths.
- Dependency audit on `pnpm install` (advisories surfaced as build warnings).
- Threat model reviewed by five reviewers (internal architecture, platform, security, product, infra) on 2026-03-20; open findings listed in Section 17.

### 15.4 Deployment change control

- ArgoCD Application changes require a merged PR.
- Terraform/OpenTofu apply runs through Harness IaCM with per-environment approval gates.
- Production changes require two approvers, executor cannot self-approve.
- Container image promotion to production is a separate PR per region/group.

---

## 16. Compliance Posture

### 16.1 Current certification status

- **No current SOC 2, ISO 27001, HIPAA, or FedRAMP certification.** The platform's architecture is designed to support these frameworks, but external certification has not been completed for this product line as of this document's version.
- **GDPR:** implementation-level controls (crypto-shredding, PII vault, cascading erasure, per-access PII audit log, tenant-configurable retention) are in place.
- **Data residency:** in a customer private-cloud deployment, all data stays within the customer's chosen Azure region(s). Cross-region replication is opt-in (currently only for backup storage via GRS, which respects Azure paired-region boundaries).

### 16.2 Finance-industry controls map

| Control family                                      | Document section |
| --------------------------------------------------- | ---------------- |
| Access control (authentication, authorization, MFA) | §6               |
| Cryptographic controls                              | §7               |
| Key management                                      | §7.2, §7.3       |
| Secrets management                                  | §7.6             |
| Network security                                    | §8               |
| Audit logging                                       | §11.2, §11.3     |
| Vulnerability management                            | §15.2, §15.3     |
| Change management                                   | §15.4            |
| Incident response hooks                             | §11.4            |
| Backup and recovery                                 | §14              |
| Data classification and handling                    | §10              |
| Secure SDLC                                         | §15              |
| Sub-processor governance                            | §12              |
| Open-source component inventory                     | §3               |

### 16.3 Customer assurance artifacts available on request

- Threat model summary document (redacted).
- Security hardening checklist per Helm values file.
- Reference SIEM integration runbook.
- Platform SBOM (pnpm-lockfile + image SBOMs generated by CI).
- Joint pen test coordination process (customer schedules; Kore.ai provides support window).

---

## 17. Known Gaps and Roadmap

We prefer to disclose known gaps directly rather than have them surface in the customer's own review.

| #   | Gap                                                                                                                                                                                                             | Status                                                                                       | Mitigation available today                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **East-west mTLS (service mesh).** Inter-service traffic inside the cluster is plain HTTP.                                                                                                                      | Roadmap — evaluating Cilium Service Mesh mTLS as it reaches GA on the customer's AKS version | Cilium NetworkPolicies restrict east-west traffic to known peer pairs; MongoDB/Redis TLS enabled per-deployment                |
| 2   | **PodSecurityStandards (PSS) namespace enforcement.** Pod hardening is per-deployment; no namespace-level `pod-security.kubernetes.io/enforce` labels.                                                          | Roadmap — PSS "restricted" profile targeted for user and database namespaces                 | SecurityContext on every pod already meets "restricted" profile except codetool-sandbox                                        |
| 3   | **Codetool-sandbox runs with `privileged: true`.** Required by gVisor (`runsc` 20250811).                                                                                                                       | Not changeable without dropping gVisor                                                       | Extremely restrictive NetworkPolicy; container internally drops to UID 1024; feature is disablable cluster-wide via Helm value |
| 4   | **Key Vault private endpoint pending.** Currently public-accessible (RBAC-protected).                                                                                                                           | Active — blocked on moving Harness runners into a VNet-delegated runner                      | Key Vault uses RBAC (not access policies); managed-identity auth; diagnostic logs on all access                                |
| 5   | **MongoDB / Redis TLS defaults off in base Helm values.**                                                                                                                                                       | Configuration hardening — enabled per-deployment for this customer                           | Explicit `mongodb.tls.enabled: true` and `redis.tls.enabled: true` in customer values overlay                                  |
| 6   | **OpenSearch security plugin disabled in base values** (`opensearch.disableSecurity: "true"`).                                                                                                                  | Configuration hardening — enabled per-deployment for this customer                           | Explicit `opensearch.disableSecurity: "false"` + security config in customer values overlay                                    |
| 7   | **NetworkPolicy coverage gaps.** Workflow-engine, multimodal, nlu-sidecar, crawler-go-worker, crawler-mcp-server, Neo4j, LiveKit currently lack dedicated policies.                                             | Active — policies in progress                                                                | Namespace isolation still in place; these services are not reachable from outside the cluster                                  |
| 8   | **MFA delivery partially wired.** JWT/middleware handles MFA-pending state; production SMS/TOTP delivery integration is partial.                                                                                | Active — target GA Q3 of deployment year                                                     | Customer can enforce MFA at the IdP (Azure AD / Okta) instead of at the platform; works today                                  |
| 9   | **Disaster recovery self-scored 3/10** on internal enterprise-readiness matrix; full-region failover is operator-driven, not automated.                                                                         | Roadmap — Terraform module automation and ArgoCD ApplicationSet in progress                  | Documented runbook with 2–4 h infra RTO; quarterly drill checklist                                                             |
| 10  | **Backup & archival self-scored 5/10.** Backup CronJobs execute and write to GRS, but automated restore-verification is manual quarterly.                                                                       | Roadmap — automated restore-verify job                                                       | Manual drill checklist in DR runbook                                                                                           |
| 11  | **Two open threat-model findings (2026-03-20):** (C1) WebSocket client registry has no max-size bound — OOM risk under pathological load; (C2) ClickHouse raw SQL endpoint can surface raw error messages.      | Active — fixes in the current sprint                                                         | WebSocket endpoint is rate-limited; ClickHouse query endpoint is platform-admin-only                                           |
| 12  | **Air-gap install workflow documented but not exercised end-to-end.** `images.yaml` and `mirror-images.sh` exist; private-cloud deployment uses private ACR with public-image import, which has been exercised. | Roadmap — full disconnected-install certification                                            | Private ACR with `az acr import` of all third-party images works today                                                         |
| 13  | **No current third-party pen test** for the regulated-finance private-cloud configuration specifically.                                                                                                         | Roadmap — joint pen test with customer, or engage third party pre-go-live                    | Internal threat model + Semgrep CI + five-reviewer architecture review                                                         |
| 14  | **Academy Dockerfile uses unpinned distroless image** (no SHA digest).                                                                                                                                          | Minor — being addressed in next image hardening cycle                                        | All other production services pin by SHA digest                                                                                |

---

## 18. Annex A — Data Flow (Agent Chat — Representative)

1. End user in a web/mobile client → Studio or customer-hosted SDK.
2. SDK bootstraps via `POST /api/v1/sdk/init` with `X-Public-Key` → receives session token.
3. SDK opens WebSocket (`ws` 8.16.0) with `Sec-WebSocket-Protocol: sdk-auth,<token>` to the runtime.
4. Runtime authenticates via unified auth middleware → AsyncLocalStorage tenant context established.
5. Runtime loads agent IR from MongoDB 7 (tenant-scoped query, Mongoose 8.23.0) → decrypts LLM credential (per-tenant DEK, AES-256-GCM).
6. Runtime invokes LLM via configured provider (Vercel AI SDK 6.0.99, customer-configured endpoint).
7. Conversation content persisted to ClickHouse 24.3 via BullMQ 5.x secure queue (application-layer encrypted message body, ioredis 5.9.3).
8. Trace events emitted to OTel collector (OTel SDK 0.57.0) → Coroot.
9. Audit event written to MongoDB 7 (audit-trail Mongoose plugin, pino 9.6.0 structured log).
10. Response streamed back over WebSocket.

Every step is within the customer's Azure VNet except step 6 when the customer chooses a public LLM endpoint. **Recommended: use Azure OpenAI inside the customer subscription to keep step 6 within the VNet.**

---

## 19. Annex B — Port Map (Default)

| Port        | Service                                 | Direction  | Exposed at ingress?       |
| ----------- | --------------------------------------- | ---------- | ------------------------- |
| 3112        | Runtime (Node.js 24 / Express)          | in         | Yes (via AppGW + NGINX)   |
| 5173        | Studio (Next.js 16)                     | in         | Yes                       |
| 3003        | Admin (Next.js 16)                      | in         | Yes (admin-path WAF rule) |
| 3005        | SearchAI (Node.js 24 / Express)         | in         | Yes                       |
| 3004        | SearchAI Runtime                        | in         | Yes                       |
| 9080        | Workflow Engine (Restate 1.6.2)         | in-cluster | No                        |
| 8080        | Docling (Python 3.11 / FastAPI)         | in-cluster | No                        |
| 8000        | BGE-M3 (Python 3.11 / Flask 3.0)        | in-cluster | No                        |
| 8003        | Preprocessing (Python 3.11 / Flask 3.0) | in-cluster | No                        |
| 8001        | Codetool Sandbox (gVisor 20250811)      | in-cluster | No                        |
| 8090        | NLU Sidecar (Python 3.11 / Flask 3.0)   | in-cluster | No                        |
| 3116        | Academy                                 | in-cluster | Optional                  |
| 27017       | MongoDB 7                               | in-cluster | No                        |
| 8123 / 9000 | ClickHouse 24.3 (HTTP / TCP)            | in-cluster | No                        |
| 6379        | Redis 7                                 | in-cluster | No                        |
| 9200 / 9600 | OpenSearch 3.3                          | in-cluster | No                        |
| 6333 / 6334 | Qdrant                                  | in-cluster | No                        |
| 7474 / 7687 | Neo4j 5                                 | in-cluster | No                        |
| 9092        | Kafka 4.2.0                             | in-cluster | No                        |
| 4317 / 4318 | OTEL Collector                          | in-cluster | No                        |
| 443         | Azure App Gateway WAF_v2                | in         | Yes                       |

---

## 20. Annex C — Common InfoSec Questions

**Q1. Where does data reside?**
Entirely within the customer's chosen Azure region(s). No data egresses the customer's tenant unless the customer explicitly configures an external LLM provider, external connector, or external telemetry forward.

**Q2. Who has access to customer data?**
Only principals the customer authenticates. Kore.ai support engineers do not have standing access to customer clusters. For break-glass support the customer provides time-boxed access; all such access is logged via ArgoCD RBAC and Azure AD audit logs on the customer side.

**Q3. How are encryption keys managed?**
The customer's own Azure Key Vault (or Managed HSM for FIPS 140-3 Level 3) holds the Platform Root Key. The platform derives Tenant KEKs and Data Encryption Keys locally via HKDF-SHA256; DEKs are wrapped by the Tenant KEK before being cached. Key rotation is performed by the customer on a schedule they define.

**Q4. What cryptographic primitives are used?**
AES-256-GCM for symmetric encryption, HKDF-SHA256 for modern key derivation, PBKDF2-SHA256 (100 k iterations) for legacy readback, HMAC-SHA256 for blind indexing, SHA-256 for API-key hashing. All IVs and auth tags meet NIST SP 800-38D sizing.

**Q5. How is multi-tenancy enforced?**
At four layers: AsyncLocalStorage context, Mongoose 8.23.0 plugin auto-scoping, per-route permission guards, and per-group deployment isolation (§5). Cross-tenant reads return HTTP 404 to prevent enumeration.

**Q6. Is MFA enforced?**
MFA is supported at the IdP integration layer (Azure AD, Okta, generic OIDC) today; customers enforcing MFA at Azure AD have full coverage. Platform-native TOTP/SMS delivery is partial (§17 item 8).

**Q7. How is privileged access controlled?**
Platform-admin routes require `requirePlatformAdmin()` + `requirePlatformAdminIp()` (IP allowlist). ArgoCD has a separate `platform-team` RBAC group. Harness IaCM requires two approvers for production applies, with self-approval disabled.

**Q8. What SIEM integrations are supported?**
OpenTelemetry OTLP export is the primary channel. The customer points the in-cluster OTEL collector (OTel SDK 0.57.0) at their SIEM (Splunk, Elastic, Sentinel, Datadog, etc.). Native webhook export for audit events is also available.

**Q9. How are vulnerabilities managed?**

- Dependency-level: pnpm audit on every install, Semgrep on PRs touching sensitive paths, automated PRs for upstream CVEs, forced version overrides for known CVEs (see §3.18).
- Image-level: distroless base images (pinned SHA digest), CVE patch overlays for critical findings.
- Platform-level: internal architecture reviews, threat model with tracked findings.

**Q10. Can the customer perform a pen test?**
Yes, on the customer's own deployment. Kore.ai provides a test-window coordination process and optional support during testing.

**Q11. What if the customer needs to export / delete all their data?**
Right-to-erasure is crypto-shredding + cascading deletion (§10.3). Full export is available via admin API and, for offline handoff, via direct backup restore handoff.

**Q12. What open-source licenses are used?**
The majority of dependencies are MIT, Apache 2.0, or BSD licensed. A full SBOM (pnpm-lockfile + image SBOMs generated by CI) is available on request. No GPL-licensed dependencies are bundled into the distributed platform images.

---

## 21. Document Control

| Field                    | Value                                                                            |
| ------------------------ | -------------------------------------------------------------------------------- |
| Classification           | For customer evaluation — not public                                             |
| Distribution             | Customer InfoSec, Procurement, Legal                                             |
| Review cycle             | Quarterly, or on material platform change                                        |
| Platform source-of-truth | `abl-platform/develop`, `abl-platform-infra/develop`, `abl-platform-deploy/main` |
| Platform SBOM            | Available on request (pnpm-lockfile + image SBOMs generated by CI)               |
| Engagement               | Six customer groups, private-cloud Azure deployment                              |

**Contact:** [populate with the customer-facing security contact before sending]

---
name: platform-toolkit
description: Use when the user asks "how do I do X", "what library for Y", "what framework for", "do we already have Z", "what package handles", "add dependency", "npm install", "pnpm add", or mentions needing functionality like email, auth, OAuth, storage, queues, workflows, state machine, LLM, database, caching, encryption, file upload, WebSocket, logging, tracing, testing, embeddings, vector search, or document processing. Provides inventory of 200+ existing libraries, integrations, and internal packages to prevent duplication.
---

# Platform Toolkit

Before adding any new dependency, check this inventory. The platform already provides solutions for most common needs.

## Rule: Don't Add What Already Exists

When a developer needs functionality, check this skill FIRST. If an existing library or internal package covers the need, use it. Only add new dependencies when no existing solution works.

---

## HTTP & Networking

| Need             | Use                       | Package                 | Location              |
| ---------------- | ------------------------- | ----------------------- | --------------------- |
| HTTP server      | **Express** 4.18          | `express`               | All backend apps      |
| HTTP client      | **axios** 1.6             | `axios`                 | Search-AI, Crawler    |
| WebSocket server | **ws** 8.16               | `ws`                    | Runtime, Observatory  |
| WebSocket client | **Socket.IO** 4.7         | `socket.io`             | Crawler               |
| CORS             | **cors** 2.8              | `cors`                  | All Express apps      |
| Compression      | **compression** 1.8       | `compression`           | All Express apps      |
| Security headers | **helmet** 8.1            | `helmet`                | All Express apps      |
| File upload      | **multer** 2.0            | `multer`                | Search-AI, Multimodal |
| Rate limiting    | **rate-limiter-flexible** | `rate-limiter-flexible` | Multimodal-Service    |

---

## Databases

| Need               | Use                                    | Package              | Port  | Location                      |
| ------------------ | -------------------------------------- | -------------------- | ----- | ----------------------------- |
| Document store     | **Mongoose** 8.23 (MongoDB 7)          | `mongoose`           | 27018 | `packages/database`           |
| Graph database     | **neo4j-driver** 5.28                  | `neo4j-driver`       | 7687  | Search-AI                     |
| Analytics/OLAP     | **@clickhouse/client** 1.17            | `@clickhouse/client` | 8124  | `packages/database`           |
| Cache/queues       | **ioredis** 5.9                        | `ioredis`            | 6380  | All services                  |
| Vector search      | **@opensearch-project/opensearch** 2.5 | opensearch client    | 9200  | `packages/search-ai-internal` |
| Vector store (alt) | **@qdrant/js-client-rest** 1.12        | qdrant client        | 6333  | `packages/search-ai-internal` |

**Internal abstractions (use these, not raw drivers):**

- MongoDB models → `@agent-platform/database` (Mongoose models, plugins, migrations)
- Search-AI dual-DB → `getLazyModel()` from `apps/search-ai/src/db/index.ts`
- Vector store → `packages/search-ai-internal/src/vector-store/` (OpenSearch + Qdrant adapters)
- ClickHouse → `packages/database/src/clickhouse.ts` (typed client)
- Redis → `@agent-platform/shared` (connection helpers, Lua scripts)

---

## Job Queues & Workflows

| Need              | Use                  | Package                   | Location                                |
| ----------------- | -------------------- | ------------------------- | --------------------------------------- |
| Background jobs   | **BullMQ** 5.69      | `bullmq`                  | Search-AI (17 workers), Runtime, Studio |
| Durable workflows | **Restate SDK** 1.10 | `@restatedev/restate-sdk` | `apps/workflow-engine`                  |
| Event streaming   | **KafkaJS** 2.2      | `kafkajs`                 | EventStore                              |

**Don't add:** RabbitMQ, Temporal, Celery. Use BullMQ for jobs, Restate for durable workflows.

---

## LLM & AI

| Need               | Use                       | Package            | Location                                     |
| ------------------ | ------------------------- | ------------------ | -------------------------------------------- |
| Multi-provider LLM | **Vercel AI SDK** 6.0     | `ai` + `@ai-sdk/*` | `packages/llm`                               |
| Claude API         | **@ai-sdk/anthropic**     | via Vercel AI SDK  | `packages/llm`                               |
| OpenAI API         | **@ai-sdk/openai**        | via Vercel AI SDK  | `packages/llm`                               |
| Gemini API         | **@ai-sdk/google**        | via Vercel AI SDK  | `packages/llm`                               |
| Azure OpenAI       | **@ai-sdk/azure**         | via Vercel AI SDK  | `packages/llm`                               |
| Cohere API         | **@ai-sdk/cohere**        | via Vercel AI SDK  | `packages/llm`                               |
| Vertex AI          | **@ai-sdk/google-vertex** | via Vercel AI SDK  | `packages/llm`                               |
| Embeddings         | **BGE-M3** (self-hosted)  | HTTP on port 8000  | `packages/search-ai-internal/src/embedding/` |
| NLP/NER            | **compromise** 14.14      | `compromise`       | Search-AI                                    |

**Internal abstraction:** `@agent-platform/llm` wraps Vercel AI SDK with tenant-scoped credential resolution. Never call provider SDKs directly — use `LLMProvider` interface.

---

## Document Processing

| Need                     | Use                               | Package/Service   | Location                                                  |
| ------------------------ | --------------------------------- | ----------------- | --------------------------------------------------------- |
| PDF/DOCX/PPTX extraction | **Docling** (Docker service)      | HTTP on port 8080 | `apps/search-ai/src/workers/docling-extraction-worker.ts` |
| HTML readability         | **@mozilla/readability**          | npm               | Search-AI                                                 |
| HTML parsing             | **cheerio** 1.0                   | npm               | Search-AI                                                 |
| CSV parsing              | **papaparse** 5.4                 | npm               | Search-AI                                                 |
| Excel parsing            | **exceljs** 4.4                   | npm               | Search-AI                                                 |
| Image processing         | **sharp** 0.34                    | npm               | Multimodal-Service                                        |
| Video processing         | **fluent-ffmpeg** 2.1             | npm               | Multimodal-Service                                        |
| MIME type detection      | **file-type** 21.3                | npm               | Search-AI, Multimodal                                     |
| Markdown parsing         | **remark-parse** + **remark-gfm** | unified ecosystem | `packages/search-ai-internal`                             |
| Malware scanning         | **clamscan** 2.4 (ClamAV)         | npm               | Multimodal-Service                                        |

---

## Authentication & Security

| Need             | Use                               | Package | Location                 |
| ---------------- | --------------------------------- | ------- | ------------------------ |
| JWT sign/verify  | **jsonwebtoken** 9.0              | npm     | `@agent-platform/shared` |
| JWE/JWS (JOSE)   | **jose** 5.10                     | npm     | Runtime, Admin           |
| SAML SSO         | **@node-saml/node-saml** 5.1      | npm     | Studio                   |
| OTP/TOTP         | **otplib** 13.3 / **otpauth** 9.5 | npm     | Runtime / Studio         |
| Password hashing | **bcryptjs** 3.0                  | npm     | Studio                   |
| OAuth flows      | **google-auth-library**           | npm     | Studio                   |
| QR codes         | **qrcode** 1.5                    | npm     | Studio                   |

**Internal abstractions (use these):**

- Auth middleware → `createUnifiedAuthMiddleware` / `requireAuth` from `@agent-platform/shared`
- Permission checks → `requirePermission()` / `requireProjectPermission()` from `@agent-platform/shared`
- Encryption at rest → `packages/database/src/mongo/plugins/encryption.plugin.ts`
- Circuit breaker → `@agent-platform/circuit-breaker` (Redis-backed)

**Don't add:** Passport.js, custom auth middleware, custom encryption. Use the shared auth system.

---

## Cloud & Storage

| Need                | Use                               | Package | Location                             |
| ------------------- | --------------------------------- | ------- | ------------------------------------ |
| S3 file storage     | **@aws-sdk/client-s3** 3.985      | aws-sdk | `@agent-platform/shared`, Multimodal |
| S3 multipart upload | **@aws-sdk/lib-storage**          | aws-sdk | `@agent-platform/shared`, Multimodal |
| Pre-signed URLs     | **@aws-sdk/s3-request-presigner** | aws-sdk | `@agent-platform/shared`, Multimodal |
| Lambda invocation   | **@aws-sdk/client-lambda**        | aws-sdk | Runtime, Compiler                    |
| ZIP files           | **jszip** 3.10                    | npm     | Studio, Shared                       |

---

## Communication

| Need           | Use                                   | Package    | Location        |
| -------------- | ------------------------------------- | ---------- | --------------- |
| Email sending  | **nodemailer** 8.0                    | npm        | Runtime         |
| Email parsing  | **mailparser** 3.9                    | npm        | Runtime         |
| SMTP server    | **smtp-server** 3.18                  | npm        | Runtime         |
| SMS/Voice      | **twilio** 5.3                        | npm        | Runtime         |
| WebRTC voice   | **LiveKit** agents + client           | livekit-\* | Runtime, Studio |
| Deepgram STT   | **@livekit/agents-plugin-deepgram**   | npm        | Runtime         |
| ElevenLabs TTS | **@livekit/agents-plugin-elevenlabs** | npm        | Runtime         |

---

## Validation & Schema

| Need               | Use                                | Package | Location           |
| ------------------ | ---------------------------------- | ------- | ------------------ |
| Runtime validation | **Zod** 3.25                       | npm     | All packages       |
| JSON Schema        | **ajv** 8.18                       | npm     | Core               |
| OpenAPI generation | **@asteasolutions/zod-to-openapi** | npm     | `packages/openapi` |

**Don't add:** Joi, Yup, class-validator. Use Zod everywhere.

---

## Observability

| Need               | Use                             | Package                       | Location                 |
| ------------------ | ------------------------------- | ----------------------------- | ------------------------ |
| Structured logging | **pino** 9.6 / `createLogger()` | `@abl/compiler/platform`      | All server code          |
| Tracing            | **OpenTelemetry** 0.57          | `@opentelemetry/*`            | Runtime, Workflow-Engine |
| Agent debugging    | **Observatory**                 | `@agent-platform/observatory` | Runtime                  |
| Trace events       | `TraceEvent` / `TraceStore`     | `@agent-platform/observatory` | Runtime                  |

**Don't add:** Winston, Bunyan, morgan. Use `createLogger()` from `@abl/compiler/platform`.

---

## Frontend (Studio)

| Need                | Use                            | Package                | Location         |
| ------------------- | ------------------------------ | ---------------------- | ---------------- |
| UI components       | **Radix UI**                   | `@radix-ui/*`          | Studio, Admin-UI |
| Icons               | **lucide-react**               | npm                    | Studio, Admin    |
| Animation           | **Framer Motion** 12.31        | `motion`               | Studio           |
| State management    | **zustand** 4.4                | npm                    | Studio, Editor   |
| Data fetching       | **SWR** 2.4                    | npm                    | Studio           |
| Charts              | **recharts** 3.7               | npm                    | Studio, Admin-UI |
| Code editor         | **Monaco Editor** 0.45         | `@monaco-editor/react` | Studio, Editor   |
| Flow graphs         | **XYFlow** 12.0                | `@xyflow/react`        | Editor           |
| Graph visualization | **Sigma** 3.0 + **graphology** | npm                    | Studio           |
| Class composition   | **clsx** 2.1                   | npm                    | All React apps   |
| Toasts              | **sonner** 2.0                 | npm                    | Studio           |
| Command palette     | **cmdk** 1.1                   | npm                    | Studio           |
| CSS                 | **Tailwind CSS** 3.4           | npm                    | All React apps   |
| i18n                | **next-intl** 4.8              | npm                    | Studio           |

**Don't add:** Material UI, Ant Design, Chakra. Use Radix + Tailwind + custom design system.

---

## ABL Platform Internals

| Need                  | Use                             | Location                                            |
| --------------------- | ------------------------------- | --------------------------------------------------- |
| Parse ABL source      | `@abl/core` (Chevrotain parser) | `packages/core`                                     |
| Compile ABL → IR      | `@abl/compiler`                 | `packages/compiler`                                 |
| Static analysis       | `@abl/analyzer`                 | `packages/analyzer`                                 |
| IDE features          | `@abl/language-service`         | `packages/language-service`                         |
| NL → ABL              | `@abl/nl-parser`                | `packages/nl-parser`                                |
| Web crawling          | `@abl/crawler`                  | `packages/crawler`                                  |
| Event sourcing        | `@abl/eventstore`               | `packages/eventstore`                               |
| Project import/export | `@agent-platform/project-io`    | `packages/project-io`                               |
| Connector SDK         | `@agent-platform/connectors`    | `packages/connectors`                               |
| A2A coordination      | `@agent-platform/a2a`           | `packages/a2a`                                      |
| MCP protocol          | `@modelcontextprotocol/sdk`     | `packages/mcp-debug`, `packages/crawler-mcp-server` |

---

## Testing

| Need              | Use                             | Package | Location           |
| ----------------- | ------------------------------- | ------- | ------------------ |
| Test runner       | **Vitest** 4.0                  | npm     | All packages       |
| HTTP testing      | **supertest** 7.2               | npm     | Runtime, Search-AI |
| In-memory MongoDB | **mongodb-memory-server** 11.0  | npm     | Runtime, Search-AI |
| In-memory Redis   | **ioredis-mock** 8.9            | npm     | Circuit-Breaker    |
| HTTP mocking      | **nock** 14.0                   | npm     | Search-AI          |
| React testing     | **@testing-library/react** 16.3 | npm     | Studio             |
| E2E testing       | **@playwright/test** 1.58       | npm     | Studio             |
| Coverage          | **@vitest/coverage-v8** 4.0     | npm     | All packages       |

**Don't add:** Jest, Mocha, Chai. Use Vitest everywhere.

---

## Key Decision: When to Add vs Reuse

**Add a new dependency when:**

- No existing library covers the need
- The existing library is fundamentally wrong (different paradigm)
- The use case is isolated to one package (won't spread)

**Reuse existing when:**

- A library already does 80%+ of what you need
- An internal abstraction wraps the library (use the abstraction)
- Multiple packages already use it (consistency matters)

**Always check `pnpm why <package>` before adding** — it may already be a transitive dependency.

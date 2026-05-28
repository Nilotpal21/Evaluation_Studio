# Search AI Platform - Documentation Index

**Version:** 1.0
**Last Updated:** 2026-02-24
**Platform:** ATLAS Search AI

---

## 📚 About This Documentation

This is the master index for the Search AI platform documentation. Documentation is organized by user journey, from getting started to advanced topics.

> **👥 New to Search AI?** See [/docs/searchai/00-START-HERE.md](/docs/searchai/00-START-HERE.md) for role-based documentation paths (Product Managers, Architects, Engineers, etc.)

**Status Legend:**

- ✅ **Complete** — Documentation is production-ready
- 🚧 **In Progress** — Documentation being written
- 📋 **Planned** — Documentation not yet started
- ⚠️ **Needs Update** — Documentation may be outdated

---

## 🚀 Quick Start

| Document                                                        | Status      | Description                                            |
| --------------------------------------------------------------- | ----------- | ------------------------------------------------------ |
| [Getting Started Guide](./01-GETTING-STARTED.md)                | 📋 Planned  | 15-minute tutorial: Create index → Upload file → Query |
| [Architecture Overview](./chunking/10-architecture-overview.md) | ✅ Complete | System architecture, components, data flow             |

**Start here:** New to the platform? Read Architecture Overview first to understand the big picture.

---

## 🏗️ Architecture Decisions

**Why we made key technical decisions (ADRs)**

| Document                                                                      | Decision    | Status                                                                      |
| ----------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------- |
| [ADR-001: Docling Adoption](./architecture/60-ADR-001-DOCLING-ADOPTION.md)    | ✅ Complete | Why IBM Docling for document extraction (vs PyPDF2, Unstructured, Textract) |
| [ADR-002: Shared Entity Indices](./architecture/61-ADR-002-SHARED-INDICES.md) | ✅ Complete | Why shared indices with tenant filtering (vs separate indices per tenant)   |
| [ADR-003: ClickHouse](./architecture/62-ADR-003-CLICKHOUSE.md)                | ✅ Complete | Why ClickHouse for structured data (vs PostgreSQL, MongoDB, DuckDB)         |
| [ADR-004: BGE-M3 Embeddings](./architecture/63-ADR-004-BGE-M3.md)             | ✅ Complete | Why BGE-M3 multilingual embeddings (vs OpenAI, Cohere)                      |
| [ADR-005: Two-Phase Ingestion](./architecture/64-ADR-005-TWO-PHASE-INGEST.md) | ✅ Complete | Why analyze → finalize flow for structured data                             |

**Purpose:** ADRs are historical records explaining architectural choices, alternatives considered, and trade-offs.

---

## 📄 Document Processing & Chunking

**How documents are extracted, chunked, and prepared for search**

### Supported Formats (14 Total)

| Document                                                           | Formats     | Status                     | Key Features                                                             |
| ------------------------------------------------------------------ | ----------- | -------------------------- | ------------------------------------------------------------------------ |
| [Documents (PDF, DOCX, PPTX)](./chunking/01-documents-pdf-docx.md) | ✅ Complete | PDF, DOCX, DOC, PPTX, PPT  | Docling extraction, sentence-aligned chunking, progressive summarization |
| [Plain Text Files](./chunking/06-plain-text.md)                    | 📋 Planned  | TXT                        | LlamaIndex legacy extraction, 512-token chunks                           |
| [HTML & Markdown](./chunking/07-html-markdown.md)                  | 📋 Planned  | HTML, MD                   | Structure-aware chunking, heading hierarchy preservation                 |
| [Images & OCR](./chunking/08-images-ocr.md)                        | 📋 Planned  | PNG, JPEG, TIFF, BMP, WEBP | OCR via Docling, screenshot generation                                   |

### Structured Data

| Document                                                                              | Formats     | Status                | Key Features                                                           |
| ------------------------------------------------------------------------------------- | ----------- | --------------------- | ---------------------------------------------------------------------- |
| [CSV Files](./chunking/02-structured-csv.md)                                          | ✅ Complete | CSV                   | Metadata-only chunking, ClickHouse storage, 99.9% chunk reduction      |
| [JSON Nested](./chunking/03-structured-json-nested.md)                                | ✅ Complete | JSON (nested objects) | Hierarchical path extraction, MongoDB + ClickHouse hybrid              |
| [JSON Tabular](./chunking/04-structured-json-tabular.md)                              | ✅ Complete | JSON (flat arrays)    | Single metadata chunk, full data in ClickHouse                         |
| [Excel Spreadsheets](./chunking/05-structured-excel.md)                               | ✅ Complete | XLS, XLSX             | Multi-sheet support, per-sheet metadata chunks                         |
| [JSON Storage Architecture](./chunking/06-json-storage-architecture.md)               | ✅ Complete | JSON                  | Where JSON data is stored (MongoDB vs ClickHouse)                      |
| [Auto-Mapping & Schema Detection](./chunking/07-auto-mapping-and-schema-detection.md) | ✅ Complete | CSV, JSON, Excel      | Automatic type inference, two-phase ingestion, canonical field mapping |

### Core Chunking Concepts

| Document                                                              | Status      | Topics Covered                                                           |
| --------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------ |
| [Chunking Index](./chunking/00-index.md)                              | ✅ Complete | Navigation hub for all chunking strategies                               |
| [Worker Pipeline Detailed](./chunking/14-worker-pipeline-detailed.md) | ✅ Complete | Stage-by-stage pipeline (extraction → chunking → enrichment → embedding) |
| [Retrieval Checklist](./chunking/20-retrieval-checklist.md)           | ✅ Complete | Best practices for optimal retrieval quality                             |

---

## 🔐 Security & Quality

| Document                                                                    | Status      | Topics Covered                                                                |
| --------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------- |
| [Security & Tenant Isolation](./chunking/11-security-tenant-isolation.md)   | ✅ Complete | Tenant isolation patterns, DB-level filtering, security checklist             |
| [Language Support Matrix](./chunking/12-language-support-matrix.md)         | ✅ Complete | 100+ languages, per-language chunking strategies, multilingual best practices |
| [Benchmarking & Quality Metrics](./chunking/13-benchmarking-and-quality.md) | ✅ Complete | BEIR benchmark results, NDCG@10 scores, cost analysis, performance data       |

---

## 🔌 Connectors

**How external data sources (SharePoint, Jira, Confluence) are connected, synced, and permission-filtered**

| Document                                                                                                    | Status      | Topics Covered                                                                                            |
| ----------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------- |
| [Connectors Framework](./connectors/search-ai-connectors-framework.md)                                      | ✅ Complete | IConnector interface, base infrastructure, sync coordinator template method, filter engine, plugin system |
| [SharePoint Connector — A Complete Story](/docs/searchai/design/SHAREPOINT-CONNECTOR-COMPLETE-REFERENCE.md) | ✅ Complete | Narrative walkthrough: OAuth, discovery, full sync, delta sync, permissions, pause/resume, architecture   |
| [SharePoint Connector — Class & Sequence Diagrams](/docs/searchai/design/SHAREPOINT-CONNECTOR-DIAGRAMS.md)  | ✅ Complete | 17 ASCII diagrams: class hierarchies, sequence flows, data model relationships                            |

---

## 🔍 Query & Retrieval

**How to query the platform and retrieve results**

| Document                                                                | Status      | Topics Covered                                                                             |
| ----------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------ |
| [Query Pipeline Guide](../../search-ai-runtime/QUERY-PIPELINE-GUIDE.md) | ✅ Complete | Comprehensive 1740-line guide: semantic search, SQL queries, hybrid retrieval, text-to-SQL |
| [Query Guide](./guides/21-QUERY-GUIDE.md)                               | 📋 Planned  | Vector search, SQL patterns, filter syntax, pagination, ranking                            |

---

## 🧠 Advanced Features

### Knowledge Graph

| Document                                                                  | Status      | Topics Covered                                                                                     |
| ------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------- |
| [Knowledge Graph Extraction](./chunking/15-knowledge-graph-extraction.md) | ✅ Complete | Entity extraction (NER), reference detection, co-occurrence analysis, Neo4j storage, IDF weighting |

### Content Enrichment

| Document                                                                | Status     | Topics Covered                                                       |
| ----------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------- |
| [Progressive Summarization](./advanced/50-PROGRESSIVE-SUMMARIZATION.md) | 📋 Planned | Context window enrichment, per-page summarization, tuning parameters |
| [Question Synthesis](./advanced/51-QUESTION-SYNTHESIS.md)               | 📋 Planned | FAQ generation per chunk, use in search ranking                      |
| [Reranking Strategies](./advanced/52-RERANKING-STRATEGIES.md)           | 📋 Planned | Provider comparison (Cohere, Jina), cost vs quality tradeoffs        |
| [Visual Enrichment (Multimodal)](./advanced/53-VISUAL-ENRICHMENT.md)    | 📋 Planned | Image extraction, screenshot analysis, OCR for scanned docs          |

---

## 👥 For Contributors & Developers

**How to contribute to the platform**

| Document                                                      | Status     | Topics Covered                                                         |
| ------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------- |
| [Contributing Guide](./contributors/72-CONTRIBUTING.md)       | 📋 Planned | Code style, PR process, commit conventions, documentation requirements |
| [Testing Guide](./contributors/70-TESTING-GUIDE.md)           | 📋 Planned | Unit tests (Vitest), integration tests, E2E patterns, test fixtures    |
| [Worker Development](./contributors/71-WORKER-DEVELOPMENT.md) | 📋 Planned | Creating BullMQ workers, queue config, error handling, tracing         |

**See also:** [CLAUDE.md](../../../CLAUDE.md) (root repo) — Platform-wide coding standards and principles

---

## 🔧 Operations (Planned)

**Deployment, monitoring, and troubleshooting**

| Document                                                                  | Status      | Topics Covered                                                        |
| ------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------- |
| [Deployment Guide](./operations/40-DEPLOYMENT-GUIDE.md)                   | 📋 Deferred | Docker Compose, Kubernetes, Helm charts, environment variables        |
| [Monitoring & Observability](./operations/41-MONITORING-OBSERVABILITY.md) | 📋 Deferred | Prometheus metrics, Grafana dashboards, trace analysis                |
| [Troubleshooting Runbook](./operations/42-TROUBLESHOOTING-RUNBOOK.md)     | 📋 Deferred | Common issues, diagnostic commands, escalation procedures             |
| [Backup & Disaster Recovery](./operations/43-BACKUP-DISASTER-RECOVERY.md) | 📋 Deferred | MongoDB, OpenSearch, Neo4j, ClickHouse backup procedures              |
| [Security Hardening](./operations/44-SECURITY-HARDENING.md)               | 📋 Deferred | JWT config, encryption, SSRF protection, tenant isolation enforcement |
| [Scaling & Performance](./operations/45-SCALING-PERFORMANCE.md)           | 📋 Deferred | Horizontal/vertical scaling, worker tuning, resource limits           |

**Note:** Operations docs deferred until infrastructure stabilizes.

---

## 📡 API Reference (Planned)

**REST API endpoints and integration**

| Document                                             | Status      | Topics Covered                                       |
| ---------------------------------------------------- | ----------- | ---------------------------------------------------- |
| [REST API Reference](./api/10-REST-API-REFERENCE.md) | 📋 Deferred | 40+ endpoints, request/response schemas, error codes |
| [Authentication](./api/11-AUTHENTICATION.md)         | 📋 Deferred | JWT, API keys, session tokens                        |
| [Error Handling](./api/12-ERROR-HANDLING.md)         | 📋 Deferred | Error codes, retry strategies                        |
| [Webhooks](./api/13-WEBHOOKS.md)                     | 📋 Deferred | Ingestion callbacks, signature verification          |
| [Rate Limits](./api/14-RATE-LIMITS.md)               | 📋 Deferred | Quotas, throttling                                   |

**Note:** API docs deferred until APIs stabilize.

---

## 📦 SDK & Integration (Planned)

**Code examples for integrating with the platform**

| Document                                     | Status      | Topics Covered                                  |
| -------------------------------------------- | ----------- | ----------------------------------------------- |
| [TypeScript SDK](./sdk/30-TYPESCRIPT-SDK.md) | 📋 Deferred | Node.js examples, auth, error handling, retries |
| [Python SDK](./sdk/31-PYTHON-SDK.md)         | 📋 Deferred | Python examples, type hints, async patterns     |
| [cURL Examples](./sdk/32-CURL-EXAMPLES.md)   | 📋 Deferred | Complete cURL cookbook for all operations       |

**Note:** SDK docs deferred until SDKs are built.

---

## 📖 Additional Resources

### Legacy/Reference Documentation

| Document                                                                                  | Status      | Notes                             |
| ----------------------------------------------------------------------------------------- | ----------- | --------------------------------- |
| [Hierarchical Tree Extraction](./hierarchical-tree-extraction.md)                         | ⚠️ Review   | May be outdated or superseded     |
| [Structured Data Hierarchical Tree Design](./structured-data-hierarchical-tree-design.md) | ⚠️ Review   | Design doc, may be reference only |
| [Tenant Isolation Audit](./tenant-isolation-audit-final.md)                               | ✅ Complete | Security audit results            |

### Runtime (search-ai-runtime) Documentation

| Document                                                                        | Status      | Topics Covered                                                                 |
| ------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------ |
| [Query Pipeline Guide](../../search-ai-runtime/QUERY-PIPELINE-GUIDE.md)         | ✅ Complete | 1740 lines: query processing, semantic search, SQL execution, hybrid retrieval |
| [Architecture Review](../../search-ai-runtime/ARCHITECTURE_REVIEW.md)           | ⚠️ Review   | May overlap with Architecture Overview                                         |
| [Query Pipeline Deep Dive](../../search-ai-runtime/QUERY_PIPELINE_DEEP_DIVE.md) | ⚠️ Review   | May overlap with Query Pipeline Guide                                          |

---

## 🗺️ Documentation Roadmap

### Phase 1: Foundation (Completed ✅)

- ✅ Architecture Decision Records (5 ADRs)
- ✅ Chunking documentation (15 files)
- ✅ Master index (this file)

### Phase 2: Contributor Docs (In Progress 🚧)

- 📋 Contributing guide
- 📋 Testing guide
- 📋 Worker development guide

### Phase 3: Complete Chunking (In Progress 🚧)

- 📋 Plain text format
- 📋 HTML/Markdown format
- 📋 Images/OCR format

### Phase 4: Advanced Features

- 📋 Progressive summarization
- 📋 Question synthesis
- 📋 Reranking strategies
- 📋 Visual enrichment

### Phase 5: User Guides (Deferred)

- 📋 Getting started
- 📋 File upload guide
- 📋 Query patterns guide

### Phase 6: Operations (Deferred)

- 📋 Deployment, monitoring, troubleshooting
- 📋 Backup & DR
- 📋 Security hardening

### Phase 7: API & SDK (Deferred)

- 📋 REST API reference
- 📋 SDK documentation
- 📋 Integration examples

---

## 🔍 Quick Reference

### By Use Case

**I want to...**

- **Understand the system architecture** → [Architecture Overview](./chunking/10-architecture-overview.md)
- **Understand connectors (SharePoint, etc.)** → [SharePoint Connector Story](/docs/searchai/design/SHAREPOINT-CONNECTOR-COMPLETE-REFERENCE.md)
- **Upload PDF/Word documents** → [Documents Guide](./chunking/01-documents-pdf-docx.md)
- **Upload CSV/Excel data** → [Structured Data Guides](./chunking/02-structured-csv.md)
- **Query the data** → [Query Pipeline Guide](../../search-ai-runtime/QUERY-PIPELINE-GUIDE.md)
- **Understand architectural decisions** → [ADRs](./architecture/)
- **Build knowledge graphs** → [Knowledge Graph Extraction](./chunking/15-knowledge-graph-extraction.md)
- **Ensure tenant isolation** → [Security Guide](./chunking/11-security-tenant-isolation.md)
- **Check supported languages** → [Language Support Matrix](./chunking/12-language-support-matrix.md)
- **See performance benchmarks** → [Benchmarking & Quality](./chunking/13-benchmarking-and-quality.md)
- **Contribute code** → [Contributing Guide](./contributors/72-CONTRIBUTING.md) (planned)

### By File Format

- **PDF, DOCX, PPTX** → [Documents Guide](./chunking/01-documents-pdf-docx.md)
- **CSV** → [CSV Guide](./chunking/02-structured-csv.md)
- **JSON (nested)** → [Nested JSON Guide](./chunking/03-structured-json-nested.md)
- **JSON (tabular)** → [Tabular JSON Guide](./chunking/04-structured-json-tabular.md)
- **Excel (XLS, XLSX)** → [Excel Guide](./chunking/05-structured-excel.md)
- **TXT** → [Plain Text Guide](./chunking/06-plain-text.md) (planned)
- **HTML, Markdown** → [HTML/MD Guide](./chunking/07-html-markdown.md) (planned)
- **Images (PNG, JPEG, etc.)** → [Images/OCR Guide](./chunking/08-images-ocr.md) (planned)

### By Persona

**Data Engineer / ML Engineer:**

- Start: [Architecture Overview](./chunking/10-architecture-overview.md)
- Deep dive: [Worker Pipeline](./chunking/14-worker-pipeline-detailed.md)
- Quality: [Benchmarking & Quality](./chunking/13-benchmarking-and-quality.md)

**Backend Developer:**

- Start: [Contributing Guide](./contributors/72-CONTRIBUTING.md) (planned)
- Reference: [CLAUDE.md](../../../CLAUDE.md) coding standards
- Testing: [Testing Guide](./contributors/70-TESTING-GUIDE.md) (planned)

**Platform Architect:**

- Start: [ADRs](./architecture/) — all 5 architecture decision records
- Reference: [Architecture Overview](./chunking/10-architecture-overview.md)

**Security Engineer:**

- Start: [Security & Tenant Isolation](./chunking/11-security-tenant-isolation.md)
- Audit: [Tenant Isolation Audit](./tenant-isolation-audit-final.md)

**DevOps / SRE:**

- Start: [Deployment Guide](./operations/40-DEPLOYMENT-GUIDE.md) (planned)
- Monitoring: [Monitoring & Observability](./operations/41-MONITORING-OBSERVABILITY.md) (planned)
- Troubleshooting: [Troubleshooting Runbook](./operations/42-TROUBLESHOOTING-RUNBOOK.md) (planned)

---

## 📝 Documentation Standards

All documentation follows these standards (from [CLAUDE.md](../../../CLAUDE.md)):

### File Naming

- Use `UPPER-KEBAB-CASE.md` for top-level docs
- Use numeric prefixes within directories: `00-09` (core), `10-19` (API), `20-29` (guides), etc.

### Status Indicators

- ✅ Complete/Enforced
- 🚧 In Progress
- 📋 Planned
- ⚠️ Partial/Incomplete
- ❌ Not Implemented

### Version/Date Format

- Version: Numeric (1.0, 2.0)
- Dates: ISO format (2026-02-24)

### Consistency Rules

- Ports: `3005` (search-ai), `3004` (search-ai-runtime)
- Models: Official IDs (`claude-3.5-sonnet`, `gpt-4o`, `text-embedding-3-small`)
- Endpoints: Full path with method (`POST /api/indexes`)

---

## 🤝 Contributing to Documentation

**Found an error?** Open an issue in the repository.

**Want to add documentation?**

1. Check the roadmap above to avoid duplicates
2. Follow the documentation standards
3. Use the appropriate template (ADR, Guide, API Reference)
4. Submit a PR with your changes

**Questions?** Contact the platform team.

---

**Last Updated:** 2026-02-24
**Next Review:** 2026-Q2

---

## 📚 External Resources

- **Platform Code Standards:** [CLAUDE.md](../../../CLAUDE.md) (root repository)
- **IBM Docling:** https://github.com/DS4SD/docling
- **BGE-M3 Paper:** https://arxiv.org/abs/2402.03216
- **BEIR Benchmark:** https://github.com/beir-cellar/beir
- **Neo4j Cypher:** https://neo4j.com/docs/cypher-manual/current/
- **ClickHouse:** https://clickhouse.com/docs/

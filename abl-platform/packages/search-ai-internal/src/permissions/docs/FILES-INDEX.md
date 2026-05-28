# SearchAI Permission Architecture - Documentation Index

**Last Updated:** February 24, 2026

---

## 📄 Core Documents

### RFC-003: Permission Architecture (54KB)

**Location:** [`../rfcs/RFC-003-SearchAI-Permission-Architecture.md`](../rfcs/RFC-003-SearchAI-Permission-Architecture.md)

**Type:** Technical Specification (RFC)

**Contents:**

- Executive Summary (18-21 week timeline)
- Problem Statement (current gaps)
- Goals & Non-Goals
- Architecture Overview (component diagrams, data flows)
- Detailed Design (identity federation, Neo4j, vector metadata, webhooks)
- Data Models (MongoDB, Neo4j, OpenSearch schemas)
- API Design (all endpoints with examples)
- Security & Privacy (GDPR, SOC 2 compliance)
- Performance & Scale (100K users, 10M docs, 100M chunks)
- Implementation Plan (5 phases, 19 weeks, week-by-week)

**Audience:** Architects, Tech Leads, Product Managers

**Read this if:**

- You need complete technical specification
- You're implementing permission features
- You need architectural decisions and rationale

---

### Implementation Plan (10KB)

**Location:** [`PERMISSION-IMPLEMENTATION-PLAN.md`](./PERMISSION-IMPLEMENTATION-PLAN.md)

**Type:** Quick Reference Guide

**Contents:**

- Key decisions confirmed (IDP security, publicInDomain, batching, etc.)
- Task breakdown (5 phases + 15 subtasks)
- Next steps (Neo4j setup, test tenant, approval)
- Progress tracking plan

**Audience:** Engineers, Project Managers

**Read this if:**

- You need a quick summary
- You're tracking implementation progress
- You need confirmed architectural decisions

---

### Codebase Analysis (38KB)

**Location:** [`PERMISSION-CODEBASE-ANALYSIS.md`](./PERMISSION-CODEBASE-ANALYSIS.md)

**Type:** Technical Analysis Document

**Contents:**

- Current state analysis (12 areas)
  1. Vector Database (OpenSearch + BGE-M3)
  2. Neo4j Infrastructure (existing client)
  3. Document Chunking (embedding worker)
  4. Authentication (JWT + IDP)
  5. Identity & User Management (User model)
  6. Permission Models (DocumentPermission)
  7. Database Infrastructure (MongoDB, Neo4j, Redis)
  8. Search Implementation (vector search)
  9. Connector Infrastructure (SharePoint)
  10. Background Jobs (BullMQ)
  11. Multi-Tenancy (tenant isolation)
  12. Monitoring & Observability
- Critical gaps identified
- Scale analysis (100K users, 10M docs)
- Performance targets

**Audience:** Engineers, Architects

**Read this if:**

- You need to understand current codebase state
- You're looking for gaps and opportunities
- You need scale/performance analysis

---

## 🗂️ Related Documents

### Connector Documentation

- [`CONNECTOR-USER-GUIDE.md`](./CONNECTOR-USER-GUIDE.md) - SharePoint connector setup & usage
- [`CONNECTOR-DEMO-SCRIPT.md`](./CONNECTOR-DEMO-SCRIPT.md) - Demo walkthrough
- [`CONNECTOR-PRODUCTION-DEPLOYMENT.md`](./CONNECTOR-PRODUCTION-DEPLOYMENT.md) - Production deployment

### Architecture Documentation

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) - Comprehensive SearchAI design
- [`ENTERPRISE_CONNECTOR_ARCHITECTURE.md`](./ENTERPRISE_CONNECTOR_ARCHITECTURE.md) - Connector patterns

---

## 🎯 Quick Navigation

### By Role

**Architects & Tech Leads:**

1. Start: [RFC-003](../rfcs/RFC-003-SearchAI-Permission-Architecture.md) (full spec)
2. Review: [Codebase Analysis](./PERMISSION-CODEBASE-ANALYSIS.md) (current state)
3. Track: [Implementation Plan](./PERMISSION-IMPLEMENTATION-PLAN.md) (progress)

**Product Managers:**

1. Start: [Implementation Plan](./PERMISSION-IMPLEMENTATION-PLAN.md) (summary + timeline)
2. Deep Dive: [RFC-003 Section 1-3](../rfcs/RFC-003-SearchAI-Permission-Architecture.md) (executive summary, problems, goals)

**Engineers:**

1. Start: [Implementation Plan](./PERMISSION-IMPLEMENTATION-PLAN.md) (task breakdown)
2. Reference: [RFC-003 Section 5-6](../rfcs/RFC-003-SearchAI-Permission-Architecture.md) (detailed design, data models)
3. Codebase: [Codebase Analysis](./PERMISSION-CODEBASE-ANALYSIS.md) (current implementation)

---

### By Topic

**Identity Federation:**

- RFC-003 Section 5.1 (IDP Integration)
- Implementation Plan: Question 1 (trust model)

**Neo4j Permission Graph:**

- RFC-003 Section 5.2 (schema, queries)
- Codebase Analysis Section 2 (existing Neo4j client)

**Vector DB Metadata:**

- RFC-003 Section 5.3 (denormalization)
- Codebase Analysis Section 1 (OpenSearch)

**Real-Time Updates:**

- RFC-003 Section 5.4 (webhooks, delta queries)
- Codebase Analysis Section 10 (BullMQ)

**Performance & Scale:**

- RFC-003 Section 9 (targets, optimization)
- Codebase Analysis: Scale Analysis section

---

## 📋 Task Tracking

### Task Hierarchy

**Master Task:** #22 (Enterprise SearchAI Permission & Authorization System)

**Phase Tasks:**

- #24: Phase 1 - Neo4j Permission Graph (4 weeks)
- #25: Phase 2 - Identity Federation (4 weeks)
- #26: Phase 3 - Vector DB Denormalization (3 weeks)
- #27: Phase 4 - Real-Time Updates (3-4 weeks)
- #28: Phase 5 - Multi-IDP Support (4 weeks)

**Phase 1 Subtasks:**

- Week 1: Schema design, client implementation, constraints (#29-31)
- Week 2: Recursive queries, flattening (#32-34)
- Week 3: Migration, dual-write (#35-36)
- Week 4: Crawler integration, API (#37-38)

**View all tasks:** Use `/tasks` command in Claude Code

---

## 🔗 External References

### Standards & Protocols

- OAuth 2.0 (RFC 6749)
- OpenID Connect Core 1.0
- SCIM 2.0 (RFC 7643/7644)
- Microsoft Graph API (delta queries)

### Technologies

- Neo4j Cypher (graph query language)
- OpenSearch k-NN (vector similarity search)
- BullMQ (job queue)
- MongoDB (document store)

---

## 📝 Document History

| Date       | Document            | Action                      | Location         |
| ---------- | ------------------- | --------------------------- | ---------------- |
| 2026-02-24 | RFC-003             | Created & moved from `/tmp` | `docs/rfcs/`     |
| 2026-02-24 | Codebase Analysis   | Created & moved from `/tmp` | `docs/searchai/` |
| 2026-02-24 | Implementation Plan | Created & moved from `/tmp` | `docs/searchai/` |
| 2026-02-24 | Files Index         | Created                     | `docs/searchai/` |

---

## ✅ Confirmation Checklist

Before starting implementation:

- [ ] Read RFC-003 (complete technical spec)
- [ ] Review Implementation Plan (task breakdown)
- [ ] Understand Codebase Analysis (current state)
- [ ] Neo4j connection details provided
- [ ] Test tenant identified
- [ ] All architectural questions answered
- [ ] Timeline approved (18-21 weeks)

---

**Questions?** See [00-START-HERE.md](./00-START-HERE.md) for documentation navigation.

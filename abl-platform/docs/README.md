# ABL Platform Documentation

> Consolidated 2026-03-13. See each directory's contents for detailed docs.

## Getting Started

| Document                                    | Description                                   |
| ------------------------------------------- | --------------------------------------------- |
| [GETTING_STARTED.md](../GETTING_STARTED.md) | Quick start guide (5 minutes)                 |
| [DEVELOPMENT.md](../DEVELOPMENT.md)         | Full development guide, testing, contributing |

## Directory Index

| Directory                          | Contents                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| [`architecture/`](./architecture/) | System design docs — runtime, channels, sandboxing, guardrails, observability, data architecture |
| [`design/`](./design/)             | Feature design specs (Arch AI assistant, studio UX, etc.)                                        |
| [`rfcs/`](./rfcs/)                 | All RFCs: platform (RFC-001 through RFC-024), extensions, and SearchAI-specific                  |
| [`searchai/`](./searchai/)         | SearchAI platform docs — ingestion, crawling, pipelines, query design                            |
| [`enterprise/`](./enterprise/)     | Enterprise roadmap, multi-tenant patterns, observability plans                                   |
| [`security/`](./security/)         | Auth, SSRF protection, security policies                                                         |
| [`setup/`](./setup/)               | Local dev setup, Docker, Jambonz, KoreVG, MongoDB/ClickHouse                                     |
| [`observatory/`](./observatory/)   | Observatory UI and tracing system specs                                                          |
| [`db/`](./db/)                     | Database schemas, migrations, data models                                                        |
| [`patents/`](./patents/)           | Patent filings and IP documentation                                                              |
| [`reference/`](./reference/)       | Feature matrix, coverage matrix, scripts, status snapshot                                        |
| [`plans/`](./plans/)               | Active implementation plans (current sprint)                                                     |
| [`audit/`](./audit/)               | Code audits, coverage audits, gap analyses                                                       |
| [`runbook/`](./runbook/)           | Operational runbooks                                                                             |
| [`archive/`](./archive/)           | Completed plans, stale proposals, historical docs, generated files                               |

## Key Documents

**Architecture**: [RUNTIME_ARCHITECTURE](./architecture/RUNTIME_ARCHITECTURE.md) | [DATA_ARCHITECTURE](./architecture/DATA_ARCHITECTURE.md) | [GUARDRAILS_SPEC](./architecture/GUARDRAILS_SPEC.md) | [OBSERVABILITY_AND_TRACING](./architecture/OBSERVABILITY_AND_TRACING.md)

**SearchAI**: [00-START-HERE](./searchai/00-START-HERE.md) | [INGESTION-PIPELINE](./searchai/INGESTION-PIPELINE-ARCHITECTURE.md) | [SERVICES-INVENTORY](./searchai/SERVICES-INVENTORY.md)

**RFCs**: [RFC-001 to RFC-024](./rfcs/) (platform) | [SearchAI RFCs](./rfcs/searchai/) | [Extensions](./rfcs/extensions/)

**Setup**: [DEV_ENVIRONMENT_SETUP](./setup/DEV_ENVIRONMENT_SETUP.md) | [LOCAL_SETUP](./setup/LOCAL_SETUP.md)

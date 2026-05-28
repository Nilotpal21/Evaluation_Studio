# Crawler Documentation Index

Quick lookup: which document to reference for each implementation task.

## Primary Design Documents

| Document                                                       | Purpose                                | When to Reference                    |
| -------------------------------------------------------------- | -------------------------------------- | ------------------------------------ |
| `docs/specs/crawler-intelligence-loop.hld.md`                  | **Source of truth** for Crawl Together | Any TIER 0/1/2 task — start here     |
| `docs/specs/crawl-scaling.hld.md`                              | Part 2: scaling (deferred)             | Only after TIER 1 complete           |
| `docs/rfcs/RFC-024-crawler-intelligence-browser-automation.md` | Original RFC for browser automation    | Historical context, design rationale |

## Task → Document Map

### TIER 0: Validate (POC)

| Task  | Primary Doc                                    | Sections to Read                                    |
| ----- | ---------------------------------------------- | --------------------------------------------------- |
| R-6   | `crawler-intelligence-loop.hld.md` §4.2        | WorkerLLMClient tool-use, MCP tool definitions      |
| R-3   | `crawler-intelligence-loop.hld.md` §4.3        | IPageHandler schema, IPlaywrightStep, prompt design |
| POC-1 | Agent memory: `poc_crawl_intelligence_loop.md` | Full POC definition, acceptance criteria            |

### TIER 1: E2E Demo (Crawl Together)

| Task | Primary Doc                                                | Also Read                                         |
| ---- | ---------------------------------------------------------- | ------------------------------------------------- |
| T-13 | `crawler-intelligence-loop.hld.md` §4.3                    | IPageHandler, PatternStore interfaces             |
| T-14 | `crawler-intelligence-loop.hld.md` §3 (Blocking Problem 5) | MCP server source, docker-compose                 |
| T-15 | `crawler-intelligence-loop.hld.md` §4.1                    | 5-phase execution model, CrawlIntelligenceService |
| T-16 | `crawler-intelligence-loop.hld.md` §4.4                    | Worker executor, handler replay                   |
| T-17 | `crawler-intelligence-loop.hld.md` §4.5                    | API routes, WS protocol, REST endpoints           |
| T-19 | `crawler-intelligence-loop.hld.md` §4.6                    | CrawlJobForm, mode selection UI                   |
| T-20 | `crawler-intelligence-loop.hld.md` §4.7                    | CrawlTogetherPanel, phase visualization           |
| —    | `docs/specs/crawl-together-interaction-tests.md`           | Test scenarios for all TIER 1 tasks               |
| —    | `docs/specs/crawl-together-autonomy-analysis.md`           | Autonomy levels, human-in-the-loop decisions      |

### TIER 2: Production Wiring

| Task | Primary Doc                                       | Also Read                                  |
| ---- | ------------------------------------------------- | ------------------------------------------ |
| T-9a | `crawler-intelligence-loop.hld.md` §3 (Problem 4) | Dual completion race condition             |
| T-9b | `crawler-intelligence-loop.hld.md` §3 (Problem 1) | DecisionEngine memory, MongoPatternLearner |
| T-9c | `crawler-intelligence-loop.hld.md` §3 (Problem 3) | MongoEventStore, outcome recording         |
| T-10 | `crawler-intelligence-loop.hld.md` §4.1           | DecisionEngine wiring, store integration   |
| T-11 | `crawler-intelligence-loop.hld.md` §4.1           | recordOutcome, transparency logging        |
| T-18 | `crawler-intelligence-loop.hld.md` §2 (Mode 3)    | Implicit mode, rule replay                 |

## Architecture & Reference

| Document                                                   | Content                             |
| ---------------------------------------------------------- | ----------------------------------- |
| `docs/searchai/crawling/SEARCHAI_CRAWLER_ARCHITECTURE.md`  | Current crawler architecture        |
| `docs/searchai/crawling/ARCHITECTURE_OVERVIEW_2026-03.md`  | March 2026 architecture snapshot    |
| `docs/searchai/crawling/CLASS_AND_SEQUENCE_DIAGRAMS.md`    | Class diagrams, sequence flows      |
| `docs/searchai/crawling/VISUAL_DIAGRAMS.md`                | Visual architecture diagrams        |
| `docs/searchai/crawling/AUTONOMOUS_INTELLIGENCE_DESIGN.md` | Autonomous intelligence subsystem   |
| `docs/searchai/crawling/CONTENT_EXTRACTION_ANALYSIS.md`    | Content extraction pipeline details |
| `docs/searchai/crawling/SEARCHAI_CRAWLER_PROBLEMS.md`      | Known problems and gaps             |
| `docs/searchai/crawling/CRAWLER-GAPS-ANALYSIS.md`          | Gap analysis                        |
| `docs/searchai/crawling/IMPLEMENTATION_STATUS.md`          | Current implementation status       |

## Research & Review History

| Document                                                           | Content                                 |
| ------------------------------------------------------------------ | --------------------------------------- |
| `docs/specs/crawl-research-findings.md`                            | Research findings for intelligence loop |
| Agent memory: `crawl_together_v2_review.md` through `v5_review.md` | 5 rounds of design review iterations    |

## Quick Start

| Document                                    | Content                      |
| ------------------------------------------- | ---------------------------- |
| `docs/searchai/crawling/QUICKSTART.md`      | Getting started with crawler |
| `docs/searchai/crawling/QUICK_REFERENCE.md` | Quick reference card         |

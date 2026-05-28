# Post-Implementation Sync: Knowledge Graph

> **Date**: 2026-04-14
> **Trigger**: ABLP-303 RACL Migration (Neo4j -> MongoDB)
> **Commits Analyzed**: 30 knowledge-graph-related commits since main

---

## Documents Updated

- [x] Feature spec: `docs/features/knowledge-graph.md` -- Added RACL migration context, new MongoDB collections (acl_document_permissions, acl_group_hierarchy, contacts extension), updated service layer with MongoPermissionStore and PermissionFilterService, updated security/config/dependencies/known issues/implementation status sections, corrected implementation file paths for deleted components
- [x] Test spec: `docs/testing/knowledge-graph.md` -- Added INT-8/INT-9/INT-10 scenarios for RACL, updated existing unit test inventory with 11 actual test files, corrected coverage targets, updated status from DRAFT to IN PROGRESS
- [x] Testing index: `docs/testing/README.md` -- Updated coverage status to "PARTIAL 04-14" with "0 E2E, 11 tests"
- [x] HLD: `docs/specs/knowledge-graph.hld.md` -- Updated component inventory (added RACL components, removed deleted components), added decisions D-11 through D-14, added post-implementation notes section documenting deviations, updated open items with resolution status
- [x] LLD: `docs/plans/knowledge-graph.lld.md` -- Updated status to DONE, updated known gaps (resolved tenant isolation gap), added ABLP-303 implementation section with files added/modified

## Coverage Delta

| Type              | Before   | After              |
| ----------------- | -------- | ------------------ |
| Unit tests        | ~2 files | 8 files            |
| Integration tests | 1 file   | 3 files            |
| E2E tests         | 0        | 0                  |
| RACL tests        | 0        | 4 files (ABLP-303) |

## Remaining Gaps

- **No E2E tests** exercising KG taxonomy/enrichment HTTP APIs end-to-end
- **No unit tests for MongoPermissionStore** CRUD operations
- **No unit tests for BFS effective groups** computation (cycle detection, max depth, diamond hierarchy)
- **No unit tests for TaxonomyGraphService** Neo4j operations
- **No unit tests for DocumentClassifierService** classification logic
- **Permission system integration test** requires Neo4j and is conditionally skipped

## Deviations from Plan

1. **RACL moved from Neo4j to MongoDB** (ABLP-303) -- not in original HLD/LLD. This was a post-design architectural decision that significantly changed the storage layer for permissions.
2. **Several original KG service files deleted** -- `KnowledgeGraphService`, `Neo4jClient`, `EntityExtractor`, `ReferenceExtractor`, `CoOccurrenceAnalyzer` no longer exist at their HLD-documented paths.
3. **Document permission resolver changed from fail-open to fail-closed** -- security improvement not in original design.
4. **3-tier permission resolution** (JWT -> Redis -> MongoDB) is a new architectural pattern not in the original HLD.
5. **Worker shared utilities module** added (`shared.ts`) -- not in original design.
6. **Pre-RACL backward compatibility clause** added to permission filter -- temporary measure for migration.

## Feature Status

**ALPHA** (unchanged). Core ingestion pipeline and RACL permission system are functional. Graph-augmented retrieval (Phase 4) is NOT STARTED. Status criteria for BETA not met (no E2E tests passing).

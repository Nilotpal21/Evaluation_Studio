# Test Spec Log: audit-logging

**Phase**: Test Spec (Phase 2)
**Date**: 2026-03-22
**Status**: COMPLETED

## Changes from Previous Version

- Expanded Quick Health Dashboard from 11 to 16 items (added Studio audit service, Studio API, tool audit logger, contact audit emitter)
- Added compliance requirement coverage matrix
- Added 7 E2E test scenarios (up from 0 defined scenarios)
- Added 7 integration test scenarios (up from 0 defined scenarios)
- Expanded coverage gap analysis from 9 to 13 items with risk assessments
- Added subsystem coverage matrix
- Added environment requirements section

## Key Decisions

| #   | Decision                                                         | Classification | Rationale                                                                                                          |
| --- | ---------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | E2E tests should use InMemory or MongoDB stores (not ClickHouse) | DECIDED        | ClickHouse is complex to set up in CI; InMemory store validates the audit flow without infrastructure dependencies |
| 2   | PII TTL test needs real MongoDB (not mocked)                     | DECIDED        | TTL indexes are MongoDB engine-level; mocking would not validate the actual TTL behavior                           |
| 3   | Alert tests should use mock HTTP server (not real webhook)       | DECIDED        | External webhook/Slack endpoints are third-party services; mock via DI per E2E test standards                      |
| 4   | Minimum 7 E2E + 7 integration scenarios                          | DECIDED        | Exceeds the minimum 5+5 requirement to account for the breadth of audit subsystems                                 |

## Test Architecture

- **Unit tests**: Mock AuditStore, ClickHouse client, MongoDB model for isolated testing
- **Integration tests**: Real MongoDB (via MongoMemoryServer), mocked ClickHouse, real audit store singleton
- **E2E tests**: Real Express servers, real middleware chain, InMemory or MongoDB audit stores
- **No mocking of codebase components in E2E**: Per CLAUDE.md E2E test standards

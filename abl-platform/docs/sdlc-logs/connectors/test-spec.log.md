# SDLC Log: Connectors Test Spec

**Feature:** connectors
**Phase:** Test Spec (Phase 2)
**Date:** 2026-03-22

## Summary

Generated connectors test spec with 7 E2E scenarios and 7 integration scenarios, all code-grounded against the actual codebase. Includes test coverage map, priority order, and full inventory of existing 34 test files.

## Key Findings

1. **34 existing test files** -- primarily unit tests for SDK components and SharePoint connector
2. **Zero E2E tests** -- no tests start real servers and exercise the HTTP API
3. **Integration tests exist** for SharePoint (oauth-flow, sync-flow) but use mocks for Graph API
4. **Critical gaps**: connection CRUD lifecycle, OAuth2 complete flow, webhook security, connector tool execution, tenant isolation
5. **token-manager.test.ts.skip** -- skipped test file indicates unresolved issues in token management

## Scenarios Defined

### E2E (7 scenarios)

1. Connection CRUD Lifecycle via API
2. OAuth2 Flow End-to-End
3. Connector Action Execution via Agent Tool Call
4. Webhook Trigger End-to-End
5. SearchAI Connector Full Sync Flow
6. Connection Test Lifecycle
7. Polling Trigger Lifecycle

### Integration (7 scenarios)

1. ConnectionResolver OAuth2 Refresh with Distributed Lock
2. ConnectorToolExecutor Connection Resolution Priority
3. TriggerEngine Strategy Routing
4. ConnectionService Credential Encryption Round-Trip
5. Activepieces Adapter Piece Wrapping
6. Base Filter Engine Evaluation
7. Connector Catalog Generation Integrity

## Output

- `docs/testing/connectors.md` -- full test spec with coverage map and priority order

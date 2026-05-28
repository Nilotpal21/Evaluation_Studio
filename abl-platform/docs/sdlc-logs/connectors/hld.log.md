# SDLC Log: Connectors HLD

**Feature:** connectors
**Phase:** HLD (Phase 3)
**Date:** 2026-03-22

## Summary

Generated High-Level Design document for the Connectors Platform covering all 12 architectural concerns, component decomposition, data flow diagrams, alternatives considered, and open questions.

## Key Findings

1. **Two-track architecture**: SDK connectors (lightweight actions/triggers) and Enterprise connectors (IConnector with full sync/permissions lifecycle) share ConnectionResolver but diverge in lifecycle management
2. **Strong tenant isolation**: All DB queries scoped by tenantId; connection resolution requires (tenantId, projectId, id) triple
3. **Distributed locking**: OAuth2 token refresh uses Redis SET NX PX to prevent thundering herd across pods
4. **Security layers**: SSRF protection, HMAC-SHA256 webhook verification (timing-safe), replay protection, idempotency dedup
5. **Static catalog**: Build-time generation of connector-catalog.json avoids Turbopack bundler failures
6. **Template method pattern**: BaseSyncCoordinator enables 90% code reuse across enterprise connectors

## Gaps Identified

- **OQ-1**: No OpenTelemetry spans in connector execution (violates platform traceability invariant)
- **OQ-3/OQ-4**: Delta sync scheduler uses `console.log` and `findById`-like patterns (violates CLAUDE.md rules)
- **OQ-6**: ConnectorRegistry has no max size/TTL/eviction (violates in-memory Map rule)
- **OQ-7**: Encryption key rotation not implemented despite `encryptionKeyVersion` tracking
- **OQ-10**: Runtime channel OAuth and SDK connector OAuth are parallel implementations (consolidation opportunity)

## Output

- `docs/specs/connectors.hld.md` -- HLD with 12 concerns, component decomposition, data flows, alternatives, open questions

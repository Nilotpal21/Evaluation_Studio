# EventStore HLD - SDLC Log

> **Phase**: HLD (Phase 3)
> **Date**: 2026-03-22
> **Feature**: eventstore

## Summary

Generated High-Level Design covering:

- System context with all 7 consumer touchpoints
- 9 component subsystems with design decisions
- Complete ClickHouse data model (table, indexes, materialized views)
- Write path (embedded + resilient modes) and read path data flows
- All 12 architectural concerns addressed
- 4 alternatives considered with rationale
- Full HTTP API design (9 endpoints)

## Key Architectural Decisions

1. **ClickHouse over MongoDB** for event storage -- columnar, compression, time-series optimized
2. **Pluggable queue interface** with 4 implementations -- deployment-appropriate durability
3. **Three deployment modes** (embedded/remote/service) -- start simple, extract when needed
4. **Custom JSONL WAL** over RocksDB/SQLite -- minimal complexity for rare fallback path
5. **Zod validation with .passthrough()** -- forward compatibility at cost of strictness

## Risk Assessment

| Risk                          | Severity | Mitigation                                     |
| ----------------------------- | -------- | ---------------------------------------------- |
| Cross-tenant wildcard polling | HIGH     | Replace with event bus or per-tenant iteration |
| console.log violations        | MEDIUM   | Batch replace with createLogger                |
| Unbounded passthrough schemas | LOW      | Add size limits at emit layer                  |
| No OTEL metrics               | LOW      | Wire up observable gauges per INTEGRATION.md   |
